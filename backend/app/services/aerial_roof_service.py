"""
Aerial Roof Report service.
Attempts Google Solar API first (if key configured), then falls back to
Tavily property records + Claude estimation.

Note: Google Solar API is optimized for residential buildings. For large
commercial properties it may return incomplete or wrong-building data.
A plausibility check rejects implausible results and triggers the fallback.

Satellite imagery uses Esri World Imagery (free, no API key required).
Geocoding tries Google first (if key set), then Nominatim/OSM as fallback.
"""
import re
import json
import math
import asyncio
import httpx
from app.core.config import settings
from app.services.llm import llm_text
from app.services.search import web_search


async def get_aerial_roof_report(address: str, city: str, state: str, zip_code: str = "") -> dict:
    """
    Get roof measurements for a property address.
    Source priority: Google Solar API (with plausibility check) → Tavily + Claude estimate.
    """
    full_address = ", ".join(filter(None, [address, city, f"{state} {zip_code}".strip()])).strip(", ")

    # Always run Tavily research in parallel so we have a size reference for validation
    research = await _tavily_research(full_address, city, state, zip_code)

    if settings.GOOGLE_SOLAR_API_KEY:
        try:
            result = await _google_solar_report(full_address, research)
            if result:
                return result
        except Exception:
            pass

    return await _claude_estimate(full_address, city, state, zip_code, research)


async def _geocode_address(full_address: str) -> tuple[float, float] | None:
    """
    Geocode an address to (lat, lng).
    Tries Google Geocoding API first (if key configured), then Nominatim (free, no key).
    """
    key = settings.GOOGLE_SOLAR_API_KEY
    if key:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                geo = await client.get(
                    "https://maps.googleapis.com/maps/api/geocode/json",
                    params={"address": full_address, "key": key},
                )
                data = geo.json()
                if data.get("status") == "OK" and data.get("results"):
                    loc = data["results"][0]["geometry"]["location"]
                    return loc["lat"], loc["lng"]
        except Exception:
            pass

    # Fallback: Nominatim (OpenStreetMap) — free, no API key required
    try:
        async with httpx.AsyncClient(
            timeout=10.0,
            headers={"User-Agent": "BuildAI-RoofEstimator/1.0 (contact@buildai.app)"},
        ) as client:
            resp = await client.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": full_address, "format": "json", "limit": 1},
            )
            results = resp.json()
            if results:
                return float(results[0]["lat"]), float(results[0]["lon"])
    except Exception:
        pass

    return None


def _satellite_image_url(lat: float, lng: float) -> str:
    """
    Build an Esri World Imagery satellite URL for the property.
    Free, no API key required. Returns a PNG image at 640x420.
    """
    zoom = 18
    # Metres per pixel at this zoom level (Web Mercator / Google Mercator)
    mpp = 156543.03392 * math.cos(math.radians(lat)) / (2 ** zoom)
    half_w_deg = (640 * mpp / 2) / (111320 * math.cos(math.radians(lat)))
    half_h_deg = (420 * mpp / 2) / 111320
    west  = lng - half_w_deg
    east  = lng + half_w_deg
    south = lat - half_h_deg
    north = lat + half_h_deg
    return (
        "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"
        f"?bbox={west:.6f},{south:.6f},{east:.6f},{north:.6f}"
        "&bboxSR=4326&imageSR=4326&size=1280,840&format=png32&f=image"
    )


async def _tavily_research(full_address: str, city: str, state: str, zip_code: str) -> str:
    """Search for property records and building footprint data."""
    queries = [
        f'"{full_address}" building square footage property records',
        f"{city} {state} {zip_code} county assessor building area sqft",
    ]
    results = await asyncio.gather(*[web_search(q, max_results=4) for q in queries])
    return "\n\n".join(r for r in results if r)


async def _google_solar_report(full_address: str, research: str) -> dict | None:
    """
    Geocode the address then call Google Solar API for roof segment data.
    Runs a plausibility check against Tavily research — rejects results that
    are implausibly small (Solar API often finds the wrong building for large
    commercial properties).
    """
    key = settings.GOOGLE_SOLAR_API_KEY
    async with httpx.AsyncClient(timeout=15.0) as client:
        geo = await client.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            params={"address": full_address, "key": key}
        )
        geo_data = geo.json()
        if geo_data.get("status") != "OK" or not geo_data.get("results"):
            return None

        loc = geo_data["results"][0]["geometry"]["location"]
        lat, lng = loc["lat"], loc["lng"]

        solar = await client.get(
            "https://solar.googleapis.com/v1/buildingInsights:findClosest",
            params={
                "location.latitude": lat,
                "location.longitude": lng,
                "key": key,
                "requiredQuality": "LOW",
            }
        )
        data = solar.json()
        if "error" in data:
            return None

        sp = data.get("solarPotential", {})
        segments = sp.get("roofSegmentStats", [])

        total_m2 = sum(s.get("stats", {}).get("areaMeters2", 0) for s in segments)
        total_sqft = round(total_m2 * 10.764)

        # Plausibility check: if the result is very small and research suggests
        # a much larger building, reject and fall back to Claude estimate.
        if total_sqft < 10_000 and research:
            large_sqft_match = re.search(r'(\d{2,3}[,\d]*)\s*(?:sq(?:uare)?\s*f(?:oo)?t|sqft|sf)', research, re.IGNORECASE)
            if large_sqft_match:
                ref_sqft = int(large_sqft_match.group(1).replace(",", ""))
                if ref_sqft > total_sqft * 3:
                    return None

        pitches = [s.get("pitchDegrees", 0) for s in segments if s.get("pitchDegrees", 0) > 2]
        avg_deg = (sum(pitches) / len(pitches)) if pitches else 18.4
        pitch_12 = round(avg_deg * 0.2667)
        pitch_str = f"{pitch_12}/12"

        return {
            "source": "Google Solar API",
            "source_icon": "satellite",
            "address": full_address,
            "total_sqft": int(total_sqft),
            "squares": round(total_sqft / 100, 1),
            "pitch": pitch_str,
            "pitch_degrees": round(avg_deg, 1),
            "roof_segments": len(segments),
            "max_sunshine_hours_yr": sp.get("maxSunshineHoursPerYear"),
            "confidence": 0.93,
            "note": "High-accuracy measurements from Google Solar aerial imagery analysis.",
            "lat": lat,
            "lng": lng,
            "satellite_image_url": _satellite_image_url(lat, lng),
        }


async def _claude_estimate(full_address: str, city: str, state: str, zip_code: str, research: str) -> dict:
    """
    Use property record research + Claude to estimate roof area.
    Handles both residential and large commercial buildings correctly.
    """
    prompt = f"""You are a professional roofing estimator and property analyst. Estimate the roof area for this address using the property research below.

Address: {full_address}

PROPERTY RESEARCH:
{research if research else f"No records found. Use your best knowledge of typical building sizes for this address type in {state}."}

Return ONLY valid JSON — no text before or after:
{{
  "source": "Property records estimate",
  "source_icon": "database",
  "address": "{full_address}",
  "total_sqft": 2100,
  "squares": 21.0,
  "pitch": "6/12",
  "pitch_degrees": 26.6,
  "roof_segments": 2,
  "stories": 1,
  "house_sqft": 1800,
  "building_type": "residential",
  "confidence": 0.58,
  "note": "Estimated from property records. Physical inspection recommended before ordering materials.",
  "max_sunshine_hours_yr": null
}}

Critical rules:
- Read the research carefully. If it mentions a specific square footage for the building, USE THAT NUMBER as your starting point — do not ignore it.
- For single-story commercial buildings (big box retail, warehouses, grocery stores): roof area ≈ building footprint (floor sqft). These have flat or very low-slope roofs.
- For residential buildings: roof area = floor sqft × 1.15 to 1.40 depending on pitch and overhang.
- For multi-story buildings: roof area ≈ footprint of ONE floor (the building footprint), not total floor area.
- pitch: "1/12" to "3/12" for flat commercial roofs, "4/12" to "12/12" for residential.
- building_type: "residential", "commercial", or "industrial"
- confidence: 0.70–0.85 if research contains explicit sqft figures; 0.40–0.60 if estimating from general knowledge.
- squares = total_sqft / 100 (always)
- Be accurate — contractors will use this to order materials."""

    text = await llm_text(prompt, max_tokens=600)
    text = re.sub(r'^```(?:json)?\s*', '', text, count=1)
    text = re.sub(r'\s*```\s*$', '', text)
    start = text.find("{")
    if start > 0:
        text = text[start:]
    result = json.loads(text)

    # Geocode (Google → Nominatim fallback) and attach Esri satellite image
    coords = await _geocode_address(full_address)
    if coords:
        result["lat"] = coords[0]
        result["lng"] = coords[1]
        result["satellite_image_url"] = _satellite_image_url(*coords)

    return result
