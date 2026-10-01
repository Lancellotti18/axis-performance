"""Clicking a house in the street photo must pick THAT house on the satellite.
The click becomes a bearing from the camera, and the answer is the first
building outline the bearing runs into."""
import math

import pytest

from app.api.v1 import roofing_v2 as rv
from app.services import footprint_service as fs

CAM = (34.20000, -77.90000)


def _box(east_m, north_m, w=12.0, d=10.0):
    """A w x d metre house centred east_m/north_m from the camera."""
    lat0, lng0 = CAM
    k = 111320.0 * math.cos(math.radians(lat0))
    pts = [(east_m - w / 2, north_m - d / 2), (east_m + w / 2, north_m - d / 2),
           (east_m + w / 2, north_m + d / 2), (east_m - w / 2, north_m + d / 2)]
    return [{"lat": lat0 + n / 111320.0, "lng": lng0 + e / k} for e, n in pts]


NEAR = _box(0, 25)        # due north, 20 m to its front wall
BEHIND = _box(0, 60)      # same bearing, hidden behind NEAR
EAST = _box(30, 0)        # due east


def test_picks_the_first_building_not_the_one_behind_it():
    ring, dist = fs.first_building_on_bearing(*CAM, 0.0, [BEHIND, NEAR, EAST])
    assert ring is NEAR
    assert dist == pytest.approx(20.0, abs=0.5)


def test_a_different_bearing_picks_a_different_house():
    ring, dist = fs.first_building_on_bearing(*CAM, 90.0, [BEHIND, NEAR, EAST])
    assert ring is EAST
    assert dist == pytest.approx(24.0, abs=0.5)


def test_a_bearing_between_houses_finds_nothing():
    assert fs.first_building_on_bearing(*CAM, 225.0, [NEAR, BEHIND, EAST]) is None


def test_the_building_the_camera_stands_in_is_ignored():
    carport = _box(0, 0, w=6, d=6)       # panorama shot from under a carport
    ring, _ = fs.first_building_on_bearing(*CAM, 0.0, [carport, NEAR])
    assert ring is NEAR


def test_out_of_range_buildings_are_not_picked():
    far = _box(0, 400)
    assert fs.first_building_on_bearing(*CAM, 0.0, [far]) is None


@pytest.mark.asyncio
async def test_locate_endpoint_returns_the_ring_and_its_centroid(monkeypatch):
    async def fake_near(lat, lng, radius_m=150.0):
        return [BEHIND, NEAR, EAST]
    monkeypatch.setattr(fs, "buildings_near", fake_near)
    out = await rv.street_view_locate(
        rv.StreetViewLocate(camera_lat=CAM[0], camera_lng=CAM[1], bearing=360.0),
        user={"id": "u"})
    assert out["found"] and out["ring"] is NEAR and out["distance_m"] == 20
    assert out["centroid"]["lat"] == pytest.approx(CAM[0] + 25 / 111320.0, abs=1e-7)


@pytest.mark.asyncio
async def test_locate_reports_a_failed_lookup_distinctly(monkeypatch):
    from app.services import solar_service

    async def down(lat, lng, radius_m=150.0):
        return None
    monkeypatch.setattr(fs, "buildings_near", down)

    # Stubbed, never live: the container can see a real key in backend/.env.
    async def solar_down(lat, lng):
        return {"available": False, "reason": "Solar API unreachable: timeout"}
    monkeypatch.setattr(solar_service, "get_building_insights", solar_down)
    out = await rv.street_view_locate(
        rv.StreetViewLocate(camera_lat=CAM[0], camera_lng=CAM[1], bearing=0),
        user={"id": "u"})
    assert out == {"found": False, "reason": "lookup_failed"}


@pytest.mark.asyncio
async def test_solar_fallback_stops_at_the_first_building_and_spends_few_calls(monkeypatch):
    """OSM has nothing; Solar knows NEAR and BEHIND. The walk must return NEAR
    and stop instead of spending the whole budget (Google's per-minute quota on
    findClosest is shared with auto-measure)."""
    from app.services import solar_service

    async def no_osm(lat, lng, radius_m=150.0):
        return []
    monkeypatch.setattr(fs, "buildings_near", no_osm)

    def bbox(r):
        return {"sw": {"lat": min(p["lat"] for p in r), "lng": min(p["lng"] for p in r)},
                "ne": {"lat": max(p["lat"] for p in r), "lng": max(p["lng"] for p in r)}}
    calls = []

    async def insights(lat, lng):
        calls.append((lat, lng))
        north_m = (lat - CAM[0]) * 111320.0
        ring, name = (NEAR, "near") if north_m < 40 else (BEHIND, "behind")
        return {"available": True, "building_name": name, "building_bbox": bbox(ring)}
    monkeypatch.setattr(solar_service, "get_building_insights", insights)

    out = await rv.street_view_locate(
        rv.StreetViewLocate(camera_lat=CAM[0], camera_lng=CAM[1], bearing=0), user={"id": "u"})
    assert out["found"] and out["source"] == "google_solar" and out["distance_m"] == 20
    assert len(calls) <= 4, len(calls)


@pytest.mark.asyncio
async def test_a_solar_quota_error_reads_as_try_again_not_no_building(monkeypatch):
    from app.services import solar_service

    async def no_osm(lat, lng, radius_m=150.0):
        return []
    monkeypatch.setattr(fs, "buildings_near", no_osm)

    async def quota(lat, lng):
        return {"available": False, "reason": "Solar API error 429. Quota exceeded"}
    monkeypatch.setattr(solar_service, "get_building_insights", quota)

    out = await rv.street_view_locate(
        rv.StreetViewLocate(camera_lat=CAM[0], camera_lng=CAM[1], bearing=0), user={"id": "u"})
    assert out == {"found": False, "reason": "lookup_failed"}
