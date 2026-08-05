"""Live daily forecast per lat/lng via Open-Meteo (free, no API key).

Feeds the dispatch board's per-crew-day weather — each crew sees the sky at its
own job site, not one regional number. Cached in-memory with a short TTL so the
board re-pulls through the day as forecasts change, without hammering the API.
Best-effort throughout: any failure yields no weather, never an error.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_ENDPOINT = "https://api.open-meteo.com/v1/forecast"
_TTL_SECONDS = 3 * 3600            # refresh weather every ~3h through the day
_MAX_FORECAST_DAYS = 16            # Open-Meteo's forward horizon
_CACHE: dict[str, tuple[float, dict]] = {}


def bucket(lat: float, lng: float) -> str:
    """~1 km grid key so crews near each other share one forecast + cache slot."""
    return f"{lat:.2f},{lng:.2f}"


async def forecast_by_date(lat: float, lng: float, days: int = _MAX_FORECAST_DAYS) -> dict:
    """{date_iso: {precip_probability, precip_in, temp_high_f, temp_low_f, wind_mph}}."""
    key = bucket(lat, lng)
    hit = _CACHE.get(key)
    if hit and (time.time() - hit[0]) < _TTL_SECONDS:
        return hit[1]

    params = {
        "latitude": round(lat, 4), "longitude": round(lng, 4),
        "daily": "precipitation_probability_max,precipitation_sum,temperature_2m_max,temperature_2m_min,wind_speed_10m_max",
        "timezone": "auto", "forecast_days": min(max(days, 1), _MAX_FORECAST_DAYS),
        "precipitation_unit": "inch", "temperature_unit": "fahrenheit", "wind_speed_unit": "mph",
    }
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(_ENDPOINT, params=params)
            r.raise_for_status()
            daily = r.json().get("daily") or {}
    except Exception as e:
        logger.info("open-meteo fetch failed (%s): %s", key, e)
        return {}

    dates = daily.get("time") or []

    def col(name: str, i: int):
        arr = daily.get(name) or []
        return arr[i] if i < len(arr) else None

    out: dict = {}
    for i, ds in enumerate(dates):
        out[ds] = {
            "precip_probability": col("precipitation_probability_max", i),
            "precip_in": col("precipitation_sum", i),
            "temp_high_f": col("temperature_2m_max", i),
            "temp_low_f": col("temperature_2m_min", i),
            "wind_mph": col("wind_speed_10m_max", i),
        }
    _CACHE[key] = (time.time(), out)
    return out


async def forecasts_for(points: list[tuple[float, float]], days: int = _MAX_FORECAST_DAYS) -> dict:
    """Fetch (deduped) forecasts for many points concurrently → {bucket_key: bydate}."""
    uniq: dict[str, tuple[float, float]] = {}
    for lat, lng in points:
        if lat is not None and lng is not None:
            uniq[bucket(lat, lng)] = (lat, lng)
    if not uniq:
        return {}

    async def _one(k: str, ll: tuple[float, float]):
        return k, await forecast_by_date(ll[0], ll[1], days)

    results = await asyncio.gather(*[_one(k, ll) for k, ll in uniq.items()], return_exceptions=True)
    out: dict = {}
    for res in results:
        if isinstance(res, tuple):
            out[res[0]] = res[1]
    return out
