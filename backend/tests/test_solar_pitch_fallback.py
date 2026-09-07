"""A facet that matches no Solar plane used to fall back to a blind 6/12, even
when Google had just measured the same building. These pin the better fallback —
and, more importantly, that it is never labelled as a direct measurement."""
import pytest

from app.api.v1 import roofing_v2 as rv
from app.services import solar_service


def test_dominant_pitch_is_area_weighted():
    """A small dormer must not outvote the main roof."""
    segs = [
        {"pitch": "9/12", "area_sqft": 40},     # dormer
        {"pitch": "5/12", "area_sqft": 900},    # main roof
        {"pitch": "9/12", "area_sqft": 60},
    ]
    assert rv._dominant_solar_pitch(segs) == "5/12"


def test_dominant_pitch_none_when_no_segment_carries_one():
    assert rv._dominant_solar_pitch([{"area_sqft": 100}]) is None
    assert rv._dominant_solar_pitch([]) is None


@pytest.mark.asyncio
async def test_unmatched_facet_inherits_the_building_pitch_not_a_global_default(monkeypatch):
    """Two facets, one Solar plane that only overlaps the first. The second must
    come back with the building's measured pitch, tagged as an inference."""
    plane = {"pitch": "9/12", "area_sqft": 800,
             "rect": [(0.0, 0.0), (0.2, 0.0), (0.2, 0.2), (0.0, 0.2)]}

    async def fake_insights(lat, lng):
        return {"available": True, "segments": [plane]}

    monkeypatch.setattr(solar_service, "get_building_insights", fake_insights)
    # Patch the projection seam: turning Solar's geographic boxes into image
    # fractions is covered by the projection tests, not this one.
    monkeypatch.setattr(rv, "_solar_segments_as_fractions",
                        lambda *a, **k: [plane])
    monkeypatch.setattr(rv, "_oriented_positive", lambda r: r["rect"] if isinstance(r, dict) else r)
    # facet 0 overlaps the plane fully; facet 1 not at all.
    monkeypatch.setattr(rv, "_coverage", lambda poly, rect: 1.0 if poly == "A" else 0.0)

    run = {"id": "r1", "satellite_lat": 40.0, "satellite_lng": -76.0,
           "satellite_zoom": 20,
           "subject_point": {"x": 0.5, "y": 0.5, "lat": 40.0, "lng": -76.0}}

    out = await rv._solar_pitch_for_polygons(run, ["A", "B"], 20)

    assert out[0] == ("9/12", "solar_measured"), out
    assert out[1] == ("9/12", "solar_building"), out
    # The inference must NEVER be reported as a direct measurement of that facet.
    assert out[1][1] != "solar_measured"


@pytest.mark.asyncio
async def test_no_solar_pitch_means_no_fabricated_pitch(monkeypatch):
    """If Google has no pitch for this building at all, invent nothing."""
    plane = {"area_sqft": 500, "rect": [(0.0, 0.0), (0.1, 0.0), (0.1, 0.1)]}   # no pitch

    async def fake_insights(lat, lng):
        return {"available": True, "segments": [plane]}

    monkeypatch.setattr(solar_service, "get_building_insights", fake_insights)
    monkeypatch.setattr(rv, "_solar_segments_as_fractions", lambda *a, **k: [plane])
    monkeypatch.setattr(rv, "_oriented_positive", lambda r: r["rect"] if isinstance(r, dict) else r)
    monkeypatch.setattr(rv, "_coverage", lambda poly, rect: 0.0)

    run = {"id": "r2", "satellite_lat": 40.0, "satellite_lng": -76.0,
           "satellite_zoom": 20,
           "subject_point": {"x": 0.5, "y": 0.5, "lat": 40.0, "lng": -76.0}}

    out = await rv._solar_pitch_for_polygons(run, ["A", "B"], 20)
    assert out == [None, None], out
