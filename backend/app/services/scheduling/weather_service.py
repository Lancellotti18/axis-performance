"""Live daily forecast per lat/lng via Open-Meteo (free, no API key).

Feeds the dispatch board's per-crew-day weather — each crew sees the sky at its
own job site, not one regional number. Cached in-memory with a short TTL so the
board re-pulls through the day as forecasts change, without hammering the API.
Best-effort throughout: any failure yields no weather, never an error.

Three sources, in order. Google's Weather API first: it runs on the same Google
Cloud project and key as Solar, which Render reaches reliably. Then the US
National Weather Service, then Open-Meteo. The free two are reached only
intermittently from Render (Open-Meteo rate-limits per IP, and Render's free
tier shares its outbound IPs with everyone else on it; measured 2026-10-08/09:
Open-Meteo failed every time, NWS timed out about half the time). Both failing is remembered for a few minutes so the
board stops waiting out two timeouts on every load. `last_error()` says what
went wrong so the board can show it instead of an empty sky.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_ENDPOINT = "https://api.open-meteo.com/v1/forecast"
_TTL_SECONDS = 3 * 3600            # refresh weather every ~3h through the day
_MAX_FORECAST_DAYS = 16            # Open-Meteo's forward horizon
_CACHE: dict[str, tuple[float, dict]] = {}
_FAIL_TTL_SECONDS = 10 * 60        # after both sources fail, don't retry for this long
_FAILED: dict[str, float] = {}
_NWS_POINTS = "https://api.weather.gov/points/{lat:.4f},{lng:.4f}"
_NWS_GRID: dict[str, str] = {}     # bucket -> forecast URL; a point's grid never changes
_NWS_HEADERS = {"User-Agent": "AxisRoofingPerformance/1.0 (support@axisroofingperformance.com)",
                "Accept": "application/geo+json"}
_LAST_ERROR: Optional[str] = None


def last_error() -> Optional[str]:
    """The most recent reason no forecast could be had, or None after a success."""
    return _LAST_ERROR


def bucket(lat: float, lng: float) -> str:
    """~1 km grid key so crews near each other share one forecast + cache slot."""
    return f"{lat:.2f},{lng:.2f}"


async def forecast_by_date(lat: float, lng: float, days: int = _MAX_FORECAST_DAYS) -> dict:
    """{date_iso: {precip_probability, precip_in, temp_high_f, temp_low_f, wind_mph}}."""
    key = bucket(lat, lng)
    hit = _CACHE.get(key)
    if hit and (time.time() - hit[0]) < _TTL_SECONDS:
        return hit[1]
    failed_at = _FAILED.get(key)
    if failed_at and (time.time() - failed_at) < _FAIL_TTL_SECONDS:
        return {}

    global _LAST_ERROR
    out = await _google(lat, lng, days)
    if out is None:
        out = await _nws(lat, lng)
    if out is None:
        out = await _open_meteo(lat, lng, days)
    if not out:
        _FAILED[key] = time.time()
        return {}
    _FAILED.pop(key, None)
    _LAST_ERROR = None
    _CACHE[key] = (time.time(), out)
    return out


def _note_failure(source: str, e: Exception) -> None:
    global _LAST_ERROR
    if isinstance(e, httpx.HTTPStatusError):
        why = f"{source} returned HTTP {e.response.status_code}"
    elif isinstance(e, httpx.TimeoutException):
        why = f"{source} timed out"
    else:
        why = f"{source} failed: {type(e).__name__}"
    _LAST_ERROR = why
    logger.warning("weather: %s", why)


_GOOGLE_ENDPOINT = "https://weather.googleapis.com/v1/forecast/days:lookup"
_GOOGLE_MAX_DAYS = 10              # Google's daily forecast horizon


def _google_key() -> str:
    from app.core.config import settings
    return (getattr(settings, "GOOGLE_WEATHER_API_KEY", "") or settings.GOOGLE_SOLAR_API_KEY or "").strip()


def _num(v) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) else None


def _google_day(d: dict) -> Optional[tuple[str, dict]]:
    """One Google forecastDay -> (date_iso, our per-day shape). Day and night are
    folded together the way NWS's two periods are: the wetter and windier half wins,
    rainfall adds up."""
    dd = d.get("displayDate") or {}
    try:
        ds = f"{int(dd['year']):04d}-{int(dd['month']):02d}-{int(dd['day']):02d}"
    except (KeyError, TypeError, ValueError):
        return None
    halves = [d.get("daytimeForecast") or {}, d.get("nighttimeForecast") or {}]

    probs, rain, winds = [], [], []
    for h in halves:
        pr = h.get("precipitation") or {}
        p = _num((pr.get("probability") or {}).get("percent"))
        if p is not None:
            probs.append(p)
        q = pr.get("qpf") or {}
        qv = _num(q.get("quantity"))
        if qv is not None:
            rain.append(qv / 25.4 if (q.get("unit") or "").upper().startswith("MILLI") else qv)
        sp = (h.get("wind") or {}).get("speed") or {}
        wv = _num(sp.get("value"))
        if wv is not None:
            winds.append(wv * 0.621371 if (sp.get("unit") or "").upper().startswith("KILO") else wv)

    def temp(t: Optional[dict]) -> Optional[float]:
        if not t:
            return None
        v = _num(t.get("degrees"))
        if v is None:
            return None
        return v * 9 / 5 + 32 if (t.get("unit") or "").upper() == "CELSIUS" else v

    return ds, {
        "precip_probability": max(probs) if probs else None,
        "precip_in": round(sum(rain), 2) if rain else None,
        "temp_high_f": temp(d.get("maxTemperature")),
        "temp_low_f": temp(d.get("minTemperature")),
        "wind_mph": round(max(winds), 1) if winds else None,
    }


async def _google(lat: float, lng: float, days: int) -> Optional[dict]:
    """Google Weather API daily forecast (up to 10 days). None when there is no
    key, the API is not enabled for it (403), or the call fails."""
    key = _google_key()
    if not key:
        return None
    params = {
        "key": key, "location.latitude": round(lat, 4), "location.longitude": round(lng, 4),
        "days": min(max(days, 1), _GOOGLE_MAX_DAYS), "pageSize": _GOOGLE_MAX_DAYS,
        "unitsSystem": "IMPERIAL",
    }
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            r = await client.get(_GOOGLE_ENDPOINT, params=params)
            r.raise_for_status()
            days_in = r.json().get("forecastDays") or []
    except Exception as e:
        _note_failure("Google Weather", e)
        return None
    out: dict = {}
    for d in days_in:
        parsed = _google_day(d)
        if parsed:
            out[parsed[0]] = parsed[1]
    if not out:
        _note_failure("Google Weather", ValueError("no forecast days"))
        return None
    return out


async def _open_meteo(lat: float, lng: float, days: int) -> Optional[dict]:

    params = {
        "latitude": round(lat, 4), "longitude": round(lng, 4),
        "daily": "precipitation_probability_max,precipitation_sum,temperature_2m_max,temperature_2m_min,wind_speed_10m_max",
        "timezone": "auto", "forecast_days": min(max(days, 1), _MAX_FORECAST_DAYS),
        "precipitation_unit": "inch", "temperature_unit": "fahrenheit", "wind_speed_unit": "mph",
    }
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            r = await client.get(_ENDPOINT, params=params)
            r.raise_for_status()
            daily = r.json().get("daily") or {}
    except Exception as e:
        _note_failure("Open-Meteo", e)
        return None

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
    return out


async def _nws(lat: float, lng: float) -> Optional[dict]:
    """National Weather Service 7-day forecast, folded into the same per-day shape.

    US only. It gives 12-hour periods, so a day's rain chance is the wetter of
    its two halves, the high comes from the daytime period and the low from the
    night. NWS has no rainfall total in this feed, so `precip_in` stays None and
    the board judges rain by probability alone.
    """
    key = bucket(lat, lng)
    try:
        async with httpx.AsyncClient(timeout=6.0, headers=_NWS_HEADERS) as client:
            url = _NWS_GRID.get(key)
            if not url:
                r = await client.get(_NWS_POINTS.format(lat=lat, lng=lng))
                r.raise_for_status()
                url = r.json()["properties"]["forecast"]
                _NWS_GRID[key] = url
            r = await client.get(url)
            r.raise_for_status()
            periods = r.json()["properties"]["periods"]
    except Exception as e:
        _note_failure("National Weather Service", e)
        return None

    out: dict = {}
    for p in periods:
        ds = (p.get("startTime") or "")[:10]
        if not ds:
            continue
        day = out.setdefault(ds, {"precip_probability": None, "precip_in": None,
                                  "temp_high_f": None, "temp_low_f": None, "wind_mph": None})
        # NWS reports "no chance" as null rather than 0.
        pop = (p.get("probabilityOfPrecipitation") or {}).get("value") or 0
        day["precip_probability"] = max(pop, day["precip_probability"] or 0)
        t = p.get("temperature")
        if isinstance(t, (int, float)):
            if p.get("temperatureUnit") == "C":
                t = t * 9 / 5 + 32
            if p.get("isDaytime"):
                day["temp_high_f"] = t
            else:
                day["temp_low_f"] = t
        winds = [float(w) for w in re.findall(r"\d+(?:\.\d+)?", p.get("windSpeed") or "")]
        if winds:
            day["wind_mph"] = max(max(winds), day["wind_mph"] or 0)
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
