"""
Building footprint lookup — free, nationwide, no API key.

Where Google Solar has no coverage (rural / unprocessed), this provides the
next-best auto-draw head start: the building's OUTLINE. It queries OpenStreetMap
via the Overpass API, which serves real-time building polygons — and which has
absorbed Microsoft's ML-derived building footprints across much of the US, so
rural coverage is far better than OSM's hand-mapped data alone.

A footprint is just the plan-view perimeter of the building (the eaves outline),
NOT roof planes or pitch. So the contractor gets the whole-roof outline dropped
on the satellite tile as one starter facet, then splits it into planes and sets
pitch (a single ground photo gives pitch on any address). It's the rural
equivalent of Solar's head start, at zero cost.

Free + keyless. Cached 24h per address to respect Overpass's fair-use limits.
"""
from __future__ import annotations

import logging
import math
import time

import httpx

logger = logging.getLogger(__name__)

# Public Overpass endpoints, tried in order. The primary (overpass-api.de)
# aggressively throttles CLOUD egress IPs — from Render it frequently rejects
# every request even though the same query works from a laptop, which made
# footprints silently unavailable in production. The mirrors accept cloud
# traffic far more reliably; we cache 24h per address to stay well inside
# everyone's fair-use.
OVERPASS_MIRRORS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
_SEARCH_RADIUS_M = 60
_CACHE_TTL_SECONDS = 24 * 3600
_cache: dict[str, tuple[float, dict]] = {}


def _cache_key(lat: float, lng: float) -> str:
    return f"{lat:.5f},{lng:.5f}"


def _point_in_ring(lat: float, lng: float, ring: list[dict]) -> bool:
    """Ray-casting point-in-polygon. ring = [{'lat':..,'lng':..}, ...]."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        yi, xi = ring[i]["lat"], ring[i]["lng"]
        yj, xj = ring[j]["lat"], ring[j]["lng"]
        if ((yi > lat) != (yj > lat)) and (
            lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi
        ):
            inside = not inside
        j = i
    return inside


def _centroid(ring: list[dict]) -> tuple[float, float]:
    return (
        sum(p["lat"] for p in ring) / len(ring),
        sum(p["lng"] for p in ring) / len(ring),
    )


def _ring_from_way(el: dict) -> list[dict]:
    geom = el.get("geometry") or []
    ring = [{"lat": float(g["lat"]), "lng": float(g["lon"])} for g in geom if "lat" in g and "lon" in g]
    # Drop the duplicated closing node so we store an open ring.
    if len(ring) >= 2 and ring[0] == ring[-1]:
        ring = ring[:-1]
    return ring


async def get_building_footprint(lat: float, lng: float) -> dict:
    """
    Return the subject building's footprint polygon near (lat, lng).

    Returns:
      {"available": True, "source": "openstreetmap",
       "ring": [{"lat":..,"lng":..}, ...]}        # the building outline
      or {"available": False, "reason": "..."}
    """
    key = _cache_key(lat, lng)
    hit = _cache.get(key)
    if hit and (time.time() - hit[0]) < _CACHE_TTL_SECONDS:
        return {**hit[1], "cached": True}

    query = (
        f"[out:json][timeout:15];"
        f'(way["building"](around:{_SEARCH_RADIUS_M},{lat:.7f},{lng:.7f}););'
        f"out geom;"
    )
    data = None
    last_err = "no mirror reachable"
    async with httpx.AsyncClient(timeout=18, headers={"User-Agent": "axis-performance/1.0"}) as client:
        for mirror in OVERPASS_MIRRORS:
            try:
                r = await client.post(mirror, data={"data": query})
                r.raise_for_status()
                data = r.json()
                break
            except Exception as e:
                last_err = f"{mirror.split('/')[2]}: {str(e)[:80]}"
                logger.info("overpass mirror failed (%s) — trying next", last_err)
    if data is None:
        # Don't cache transient failures.
        return {"available": False, "reason": f"Footprint service unreachable ({last_err})"}

    elements = [e for e in (data.get("elements") or []) if e.get("type") == "way"]
    candidates: list[list[dict]] = []
    for el in elements:
        ring = _ring_from_way(el)
        if len(ring) >= 3:
            candidates.append(ring)

    if not candidates:
        result = {"available": False, "reason": "No mapped building outline at this address."}
        _cache[key] = (time.time(), result)
        return result

    # Prefer the building whose polygon CONTAINS the point; among those, the
    # smallest (the subject house, not a sprawling enclosing polygon). If none
    # contain it, take the nearest by centroid.
    containing = [r for r in candidates if _point_in_ring(lat, lng, r)]
    if containing:
        chosen = min(containing, key=lambda r: _ring_area_deg2(r))
    else:
        def _dist(r: list[dict]) -> float:
            cy, cx = _centroid(r)
            return math.hypot(cy - lat, cx - lng)
        chosen = min(candidates, key=_dist)

    result = {"available": True, "source": "openstreetmap", "ring": chosen}
    _cache[key] = (time.time(), result)
    return result


def _ring_area_deg2(ring: list[dict]) -> float:
    """Shoelace area in (degrees²) — only used to compare candidate sizes."""
    a = 0.0
    n = len(ring)
    for i in range(n):
        j = (i + 1) % n
        a += ring[i]["lng"] * ring[j]["lat"]
        a -= ring[j]["lng"] * ring[i]["lat"]
    return abs(a) / 2.0
