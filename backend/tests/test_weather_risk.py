"""Weather risk is per job site, and it describes rather than decides.

The old rule was `precip_probability >= 60` read from a regional table that
nothing had written since a demo seed — so a 70% chance of drizzle flagged a
day, a 50% chance of two inches did not, and in practice nothing flagged at all
because the table was empty.

Now: any real chance of rain or wind at 20 mph raises it, the verdict says how
hard, and the decision belongs to the dispatcher.
"""
from __future__ import annotations

from app.api.v1.scheduling import (
    _weather_verdict, _day_is_clear, _wx_at,
    RAIN_ANY_IN, RAIN_ANY_PROB, WIND_ALERT_MPH,
)


def wx(prob=None, inches=None, wind=None):
    return {"precip_probability": prob, "precip_in": inches, "wind_mph": wind}


# ── when we speak up ─────────────────────────────────────────────────────────

def test_a_clear_calm_day_says_nothing():
    assert _weather_verdict(wx(prob=5, inches=0.0, wind=6)) is None


def test_no_forecast_is_not_a_warning():
    assert _weather_verdict(None) is None
    assert _weather_verdict({}) is None


def test_any_measurable_rain_is_raised():
    v = _weather_verdict(wx(prob=25, inches=RAIN_ANY_IN))
    assert v is not None and v["wet"] is True


def test_a_real_chance_of_rain_is_raised_even_with_no_accumulation():
    v = _weather_verdict(wx(prob=RAIN_ANY_PROB, inches=0.0))
    assert v is not None and v["wet"] is True


def test_wind_alone_is_raised_at_twenty():
    v = _weather_verdict(wx(prob=0, inches=0.0, wind=WIND_ALERT_MPH))
    assert v is not None
    assert v["windy"] is True and v["wet"] is False
    assert v["band"] == "wind", "a dry, windy day is a wind call, not a rain call"


def test_nineteen_mph_and_dry_stays_quiet():
    assert _weather_verdict(wx(prob=0, inches=0.0, wind=19)) is None


# ── how hard: drizzle and downpour must not read the same ────────────────────

def test_severity_bands():
    assert _weather_verdict(wx(prob=40, inches=0.02))["band"] == "light"
    assert _weather_verdict(wx(prob=60, inches=0.15))["band"] == "steady"
    assert _weather_verdict(wx(prob=90, inches=0.80))["band"] == "heavy"


def test_a_heavy_downpour_at_low_probability_is_still_heavy():
    # The old rule missed this entirely: 50% < 60, so it never flagged.
    v = _weather_verdict(wx(prob=50, inches=2.0))
    assert v is not None and v["band"] == "heavy"


def test_summary_is_readable_and_carries_the_numbers():
    v = _weather_verdict(wx(prob=80, inches=0.55, wind=24))
    assert "heavy rain expected" in v["summary"]
    assert "80% chance" in v["summary"] and "0.55 in" in v["summary"]
    assert "wind 24 mph" in v["summary"]


# ── location: the whole point ────────────────────────────────────────────────

FC = {
    "34.23,-77.94": {"2026-09-01": wx(prob=90, inches=0.9, wind=10)},   # soaked
    "35.22,-80.84": {"2026-09-01": wx(prob=5, inches=0.0, wind=7)},     # clear
}


def test_two_sites_on_one_date_get_different_answers():
    soaked = _wx_at(FC, 34.23, -77.94, "2026-09-01")
    clear = _wx_at(FC, 35.22, -80.84, "2026-09-01")
    assert _weather_verdict(soaked) is not None
    assert _weather_verdict(clear) is None


def test_day_is_clear_reflects_the_job_site():
    assert _day_is_clear(FC, 35.22, -80.84, "2026-09-01") is True
    assert _day_is_clear(FC, 34.23, -77.94, "2026-09-01") is False


def test_unknown_site_or_date_counts_as_clear():
    # Beyond the forecast horizon we genuinely don't know. Refusing to plan is
    # worse than proposing a day the dispatcher can still reject.
    assert _day_is_clear(FC, 34.23, -77.94, "2027-01-01") is True
    assert _day_is_clear(FC, None, None, "2026-09-01") is True
