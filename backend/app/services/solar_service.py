"""
Google Solar API — building insights for roofing.

Google has already run photogrammetry on most US metro/suburban addresses and
exposes the result via the Solar API: per-roof-plane PITCH, AZIMUTH (compass
direction), AREA, and a lat/lng bounding box, derived from a digital surface
model. For Axis this means:
  * facet auto-detection that actually works (the roof is pre-segmented)
  * per-facet pitch that is MEASURED (±2-4°) instead of guessed
  * a real sense of plane count + orientation

This module is INERT until GOOGLE_SOLAR_API_KEY is set — is_enabled() is False,
get_building_insights() returns {available: False}. Nothing here costs anything
until the contractor adds billing + the key. Coverage is partial (Google
returns 404 for rural / unprocessed addresses); callers fall back to the
existing satellite-tracing flow.

Cost when enabled: buildingInsights ~ $0.01 / call (pay-as-you-go on GCP).
"""
from __future__ import annotations

import logging
import math
import time
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

SOLAR_BASE = "https://solar.googleapis.com/v1"

# Cost guard: cache each building's insights so we never bill Google twice for
# the same address. Keyed on rounded lat/lng (~1m precision). 24h TTL —
# Google's imagery for a building changes on the order of months, so a long
# cache is safe and keeps spend to ~one call per unique roof per day.
_CACHE_TTL_SECONDS = 24 * 3600
_cache: dict[str, tuple[float, dict]] = {}


def _cache_key(lat: float, lng: float) -> str:
    return f"{lat:.5f},{lng:.5f}"


def is_enabled() -> bool:
    return bool(settings.GOOGLE_SOLAR_API_KEY)


def _pitch_degrees_to_ratio(pitch_deg: float) -> str:
    """12.3° → '3/12' (rise per 12 of run). Clamped to common residential range."""
    rise = round(math.tan(math.radians(max(0.0, pitch_deg))) * 12)
    rise = max(0, min(24, rise))
    return f"{rise}/12"


def _azimuth_to_compass(az_deg: float) -> str:
    """0°=N, 90°=E, 180°=S, 270°=W → 8-point compass slope direction."""
    dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    idx = int((az_deg % 360) / 45.0 + 0.5) % 8
    return dirs[idx]


async def get_building_insights(lat: float, lng: float) -> dict:
    """
    Fetch the closest building's solar insights and normalize the roof segments.

    Returns:
      {
        "available": bool,
        "reason": str (when unavailable),
        "imagery_quality": "HIGH"|"MEDIUM"|"LOW"|None,
        "imagery_date": "YYYY-MM-DD"|None,
        "center": {"lat":..,"lng":..},
        "whole_roof_area_m2": float,
        "whole_roof_area_sqft": float,
        "segments": [
          {
            "pitch_degrees": float, "pitch": "6/12",
            "azimuth_degrees": float, "slope_direction": "S",
            "area_m2": float, "area_sqft": float,
            "center": {"lat":..,"lng":..},
            "bbox": {"sw":{"lat":..,"lng":..}, "ne":{"lat":..,"lng":..}},
            "height_m": float|None,
          }, ...
        ],
      }
    """
    if not is_enabled():
        return {"available": False, "reason": "Google Solar API key not configured."}

    # Cost guard — serve a cached result for this address if we have one.
    key = _cache_key(lat, lng)
    hit = _cache.get(key)
    if hit and (time.time() - hit[0]) < _CACHE_TTL_SECONDS:
        return {**hit[1], "cached": True}

    url = f"{SOLAR_BASE}/buildingInsights:findClosest"
    params = {
        "location.latitude": f"{lat:.7f}",
        "location.longitude": f"{lng:.7f}",
        "key": settings.GOOGLE_SOLAR_API_KEY,
    }
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(url, params=params)
        if r.status_code == 404:
            # Definitive "no coverage" — cache so we don't re-bill for it.
            result = {"available": False, "reason": "No Google Solar coverage at this address (rural or not yet processed)."}
            _cache[key] = (time.time(), result)
            return result
        r.raise_for_status()
        data = r.json()
    except httpx.HTTPStatusError as e:
        msg = ""
        try:
            msg = e.response.text[:200]
        except Exception:
            pass
        logger.info("solar API http error: %s | %s", e, msg)
        return {"available": False, "reason": f"Solar API error {e.response.status_code}."}
    except Exception as e:
        logger.info("solar API call failed: %s", e)
        return {"available": False, "reason": f"Solar API unreachable: {str(e)[:120]}"}

    sp = data.get("solarPotential") or {}
    seg_rows = sp.get("roofSegmentStats") or []
    segments: list[dict] = []
    for s in seg_rows:
        try:
            pitch_deg = float(s.get("pitchDegrees") or 0.0)
            az_deg = float(s.get("azimuthDegrees") or 0.0)
            area_m2 = float((s.get("stats") or {}).get("areaMeters2") or 0.0)
            center = s.get("center") or {}
            bbox = s.get("boundingBox") or {}
            sw = bbox.get("sw") or {}
            ne = bbox.get("ne") or {}
            if not (sw and ne):
                continue
            segments.append({
                "pitch_degrees": round(pitch_deg, 1),
                "pitch": _pitch_degrees_to_ratio(pitch_deg),
                "azimuth_degrees": round(az_deg, 1),
                "slope_direction": _azimuth_to_compass(az_deg),
                "area_m2": round(area_m2, 1),
                "area_sqft": round(area_m2 * 10.7639, 1),
                "center": {"lat": center.get("latitude"), "lng": center.get("longitude")},
                "bbox": {
                    "sw": {"lat": sw.get("latitude"), "lng": sw.get("longitude")},
                    "ne": {"lat": ne.get("latitude"), "lng": ne.get("longitude")},
                },
                "height_m": s.get("planeHeightAtCenterMeters"),
            })
        except (TypeError, ValueError):
            continue

    whole = sp.get("wholeRoofStats") or {}
    whole_m2 = float(whole.get("areaMeters2") or 0.0)
    center = data.get("center") or {}
    imagery_date = None
    d = data.get("imageryDate") or {}
    if d.get("year"):
        imagery_date = f"{int(d['year']):04d}-{int(d.get('month', 1)):02d}-{int(d.get('day', 1)):02d}"

    result = {
        "available": True,
        "imagery_quality": data.get("imageryQuality"),
        "imagery_date": imagery_date,
        "center": {"lat": center.get("latitude"), "lng": center.get("longitude")},
        "whole_roof_area_m2": round(whole_m2, 1),
        "whole_roof_area_sqft": round(whole_m2 * 10.7639, 1),
        "segments": segments,
        "segment_count": len(segments),
    }
    _cache[key] = (time.time(), result)
    return result
