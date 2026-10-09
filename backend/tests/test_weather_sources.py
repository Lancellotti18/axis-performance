"""Dispatch weather sources: Google first, then NWS, then Open-Meteo.

Render reaches the two free providers only intermittently (2026-10-08/09), so
Google's Weather API, on the same key as Solar, leads. These pin how a Google
day is read, the fallback order, and that the API key never reaches the
error text the board shows."""
import asyncio

import httpx
import pytest

from app.services.scheduling import weather_service as wx

GOOGLE_DAY = {
    "displayDate": {"year": 2026, "month": 10, "day": 10},
    "daytimeForecast": {
        "precipitation": {"probability": {"percent": 70, "type": "RAIN"}, "qpf": {"quantity": 0.4, "unit": "INCHES"}},
        "wind": {"speed": {"value": 12, "unit": "MILES_PER_HOUR"}},
    },
    "nighttimeForecast": {
        "precipitation": {"probability": {"percent": 91, "type": "RAIN"}, "qpf": {"quantity": 0.6, "unit": "INCHES"}},
        "wind": {"speed": {"value": 18, "unit": "MILES_PER_HOUR"}},
    },
    "maxTemperature": {"degrees": 74, "unit": "FAHRENHEIT"},
    "minTemperature": {"degrees": 61, "unit": "FAHRENHEIT"},
}


def test_a_google_day_folds_day_and_night_together():
    ds, d = wx._google_day(GOOGLE_DAY)
    assert ds == "2026-10-10"
    assert d == {"precip_probability": 91, "precip_in": 1.0, "temp_high_f": 74, "temp_low_f": 61, "wind_mph": 18}


def test_metric_units_are_converted():
    day = {"displayDate": {"year": 2026, "month": 10, "day": 11},
           "daytimeForecast": {"precipitation": {"qpf": {"quantity": 25.4, "unit": "MILLIMETERS"}},
                               "wind": {"speed": {"value": 16.0934, "unit": "KILOMETERS_PER_HOUR"}}},
           "maxTemperature": {"degrees": 20, "unit": "CELSIUS"}}
    _, d = wx._google_day(day)
    assert d["precip_in"] == 1.0 and d["wind_mph"] == 10.0 and d["temp_high_f"] == 68


def test_a_day_without_a_date_is_skipped():
    assert wx._google_day({"maxTemperature": {"degrees": 70}}) is None


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    wx._CACHE.clear(); wx._FAILED.clear()
    monkeypatch.setattr(wx, "_google_key", lambda: "SECRET-KEY-123")


def _calls(monkeypatch, google, nws, om):
    seen = []
    async def g(*a): seen.append("google"); return google
    async def n(*a): seen.append("nws"); return nws
    async def o(*a): seen.append("open-meteo"); return om
    monkeypatch.setattr(wx, "_google", g); monkeypatch.setattr(wx, "_nws", n); monkeypatch.setattr(wx, "_open_meteo", o)
    return seen


def test_google_answers_so_nothing_else_is_asked(monkeypatch):
    seen = _calls(monkeypatch, {"2026-10-10": {"precip_probability": 91}}, {"x": 1}, {"y": 1})
    out = asyncio.run(wx.forecast_by_date(34.2, -77.9))
    assert seen == ["google"] and "2026-10-10" in out


def test_google_down_falls_back_to_nws_then_open_meteo(monkeypatch):
    seen = _calls(monkeypatch, None, None, {"2026-10-10": {"precip_probability": 5}})
    out = asyncio.run(wx.forecast_by_date(34.2, -77.9))
    assert seen == ["google", "nws", "open-meteo"] and out


def test_the_api_key_never_reaches_the_error_text(monkeypatch):
    class _Client:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, params=None):
            req = httpx.Request("GET", url, params=params)
            raise httpx.HTTPStatusError("forbidden", request=req, response=httpx.Response(403, request=req))
    monkeypatch.setattr(wx.httpx, "AsyncClient", _Client)
    assert asyncio.run(wx._google(34.2, -77.9, 10)) is None
    assert wx.last_error() == "Google Weather returned HTTP 403"
    assert "SECRET" not in (wx.last_error() or "")


def test_no_key_means_google_is_skipped(monkeypatch):
    monkeypatch.setattr(wx, "_google_key", lambda: "")
    assert asyncio.run(wx._google(34.2, -77.9, 10)) is None
