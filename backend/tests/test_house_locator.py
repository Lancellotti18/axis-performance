"""Finding the house from Google's own building data (house_locator).

Fortitude quit on the old picker: a 2008 street photo first, and no outline
because the free OpenStreetMap servers were down. These pin the replacement."""
import asyncio
import math

import numpy as np

from app.services import house_locator as HL
from app.services import solar_service, solar_layers_service as SL

LAT, LNG = 34.2309761, -78.0504679
PX = 0.1


def _mask_with_two_houses():
    m = np.zeros((400, 400), np.uint8)
    m[150:250, 140:260] = 1          # the house: 12 m x 10 m around the centre
    m[160:220, 330:380] = 1          # a neighbour to the east
    return m


def test_the_outline_is_the_roof_under_the_centre_not_the_neighbour():
    ce, cn, _ = SL.latlng_to_utm(LAT, LNG)
    oe, on = ce - 200 * PX, cn + 200 * PX
    out = HL.outline_from_mask(_mask_with_two_houses(), PX, oe, on, (ce, cn), (LAT, LNG))
    assert out and len(out) >= 4
    # Every corner within ~8 m of the centre: it is this house, not the
    # neighbour 14 m east.
    for p in out:
        d = math.hypot((p["lat"] - LAT) * 111320, (p["lng"] - LNG) * 111320 * math.cos(math.radians(LAT)))
        assert d < 8.5


def test_a_centre_just_off_the_roof_still_finds_it():
    ce, cn, _ = SL.latlng_to_utm(LAT, LNG)
    oe, on = ce - 200 * PX, cn + 200 * PX
    m = np.zeros((400, 400), np.uint8)
    m[150:250, 210:260] = 1          # roof starts 1 m east of the centre
    assert HL.outline_from_mask(m, PX, oe, on, (ce, cn), (LAT, LNG))


def test_no_roof_near_the_centre_is_none():
    ce, cn, _ = SL.latlng_to_utm(LAT, LNG)
    m = np.zeros((400, 400), np.uint8)
    m[10:30, 10:30] = 1              # 17 m away
    assert HL.outline_from_mask(m, PX, ce - 200 * PX, cn + 200 * PX, (ce, cn), (LAT, LNG)) is None


def test_findclosest_asks_for_medium_quality_like_auto_measure(monkeypatch):
    """Much of the coast is MEDIUM-quality imagery; the default (HIGH) said
    'no coverage' for Fortitude's house, which auto-measure measures fine."""
    seen = {}
    async def insights(lat, lng, required_quality=None):
        seen["q"] = required_quality
        return {"available": False, "reason": "none"}
    monkeypatch.setattr(solar_service, "get_building_insights", insights)
    out = asyncio.run(HL.building_at(LAT, LNG, "k"))
    assert seen["q"] == "MEDIUM" and out["available"] is False


def test_falls_back_to_googles_box_when_the_mask_is_unavailable(monkeypatch):
    async def insights(lat, lng, required_quality=None):
        return {"available": True, "center": {"lat": LAT, "lng": LNG}, "imagery_date": "2021-09-03",
                "building_bbox": {"sw": {"lat": LAT - 1e-4, "lng": LNG - 1e-4},
                                  "ne": {"lat": LAT + 1e-4, "lng": LNG + 1e-4}}}
    async def no_meta(*a, **k): return None, "rate-limited"
    monkeypatch.setattr(solar_service, "get_building_insights", insights)
    monkeypatch.setattr(SL, "fetch_metadata", no_meta)
    out = asyncio.run(HL.building_at(LAT, LNG, "k"))
    assert out["available"] and out["outline_source"] == "box" and len(out["outline"]) == 4
    assert out["center"] == {"lat": LAT, "lng": LNG}
