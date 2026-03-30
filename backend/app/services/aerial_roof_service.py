"""
Aerial Roof Report service.
Attempts Google Solar API first (if key configured), then falls back to
Tavily property records + Claude estimation.
"""
import re
import json
import httpx
import anthropic
from app.core.config import settings


async def get_aerial_roof_report(address: str, city: str, state: str, zip_code: str = "") -> dict:
    """
    Get roof measurements for a property address.
    Source priority: Google Solar API → Tavily + Claude estimate.
    """
    full_address = ", ".join(filter(None, [address, city, f"{state} {zip_code}".strip()])).strip(", ")

    if settings.GOOGLE_SOLAR_API_KEY:
        try:
            result = await _google_solar_report(full_address)
            if result:
                return result
        except Exception:
            pass

    return await _tavily_claude_estimate(full_address, city, state, zip_code)


async def _google_solar_report(full_address: str) -> dict | None:
    """Geocode the address then call Google Solar API for roof segment data."""
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

        pitches = [s.get("pitchDegrees", 0) for s in segments if s.get("pitchDegrees", 0) > 2]
        avg_deg = (sum(pitches) / len(pitches)) if pitches else 18.4  # ~6/12 default
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
        }


async def _tavily_claude_estimate(full_address: str, city: str, state: str, zip_code: str) -> dict:
    """Use Tavily property records + Claude to estimate roof area."""
    research = ""
    if settings.TAVILY_API_KEY:
        from tavily import TavilyClient
        tavily = TavilyClient(api_key=settings.TAVILY_API_KEY)
        queries = [
            f"{full_address} square footage lot size property records",
            f"{full_address} zillow redfin property details beds baths sqft",
        ]
        snippets = []
        for q in queries:
            try:
                r = tavily.search(query=q, search_depth="basic", max_results=4)
                for item in r.get("results", []):
                    c = item.get("content", "")[:500]
                    if c:
                        snippets.append(c)
            except Exception:
                continue
        research = "\n\n".join(snippets[:6])

    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

    prompt = f"""You are a roofing contractor estimator. Estimate the roof measurements for this address using available property records.

Address: {full_address}

PROPERTY RECORDS FOUND:
{research if research else "No records found. Use typical residential values for " + state + "."}

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
  "confidence": 0.58,
  "note": "Estimated from property records. Physical inspection recommended before ordering materials.",
  "max_sunshine_hours_yr": null
}}

Rules:
- total_sqft = roof deck area (house sqft × 1.15–1.40 depending on pitch and overhang)
- squares = total_sqft / 100
- pitch: use typical {state} residential pitch (common: "4/12", "6/12", "8/12")
- confidence: 0.5–0.65 from records, 0.35–0.5 if no records found
- house_sqft: living area from records if found, else estimate"""

    message = client.messages.create(
        model="claude-opus-4-6",
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}]
    )

    text = message.content[0].text.strip()
    text = re.sub(r'^```(?:json)?\s*', '', text, count=1)
    text = re.sub(r'\s*```\s*$', '', text)
    start = text.find("{")
    if start > 0:
        text = text[start:]
    return json.loads(text)
