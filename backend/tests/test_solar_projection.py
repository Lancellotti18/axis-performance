"""Solar planes must land where the traced roof actually is.

Every roof in production carried an assumed 6/12 pitch because this silently
failed. Google returned 13 real roof planes for the address; the traced facets
sat at fraction (0.44, 0.29) while every Solar rectangle was projected around
(0.50, 0.50) — about 36 m apart — so overlap computed as exactly 0% and each
facet kept its default. Nothing errored. Nothing was logged.

The projection assumed the satellite tile is centred on the building. It is not,
which is the whole reason HousePicker and subject_point exist.
"""
from __future__ import annotations

import math

from app.api.v1.roofing_v2 import (
    _geo_to_frac, _solar_segments_as_fractions, _coverage, _oriented_positive,
)
from app.services import geometry_service as geo

LAT, LNG, ZOOM = 34.258072, -77.876620, 20
MPP = geo.metres_per_pixel(LAT, ZOOM)


def _offset(lat, lng, north_m, east_m):
    return (lat + north_m / 111320.0,
            lng + east_m / (111320.0 * math.cos(math.radians(lat))))


def _solar_with_building_at(blat, blng, size_m=12.0):
    """One Solar plane, centred on a building at (blat, blng)."""
    sw = _offset(blat, blng, -size_m / 2, -size_m / 2)
    ne = _offset(blat, blng, +size_m / 2, +size_m / 2)
    return {"segments": [{
        "pitch": "7/12", "pitch_degrees": 30.0,
        "bbox": {"sw": {"lat": sw[0], "lng": sw[1]}, "ne": {"lat": ne[0], "lng": ne[1]}},
        "center": {"lat": blat, "lng": blng},
    }], "center": {"lat": blat, "lng": blng}}


# ── the projection itself ────────────────────────────────────────────────────

def test_anchor_moves_the_projection():
    """The same coordinate lands wherever the anchor says the building is."""
    centre = _geo_to_frac(LAT, LNG, LAT, LNG, MPP)
    assert centre == [0.5, 0.5]
    off = _geo_to_frac(LAT, LNG, LAT, LNG, MPP, anchor=(0.44, 0.29))
    assert off == [0.44, 0.29]


def test_projection_is_not_clamped():
    """A plane off the frame must keep its true geometry, not be squashed to an
    edge — a clamped rectangle corrupts the overlap test it feeds."""
    far_lat, far_lng = _offset(LAT, LNG, 400.0, 400.0)
    f = _geo_to_frac(far_lat, far_lng, LAT, LNG, MPP)
    assert f[0] > 1.0 or f[1] < 0.0, "should fall outside [0,1], not clamp into it"


# ── the bug, reproduced and fixed ────────────────────────────────────────────

# A roof traced up and to the left of frame centre — the real geometry from
# run ab61b56a.
ROOF = [[0.424, 0.257], [0.459, 0.257], [0.459, 0.316], [0.424, 0.316]]
ROOF_CENTRE = (0.4415, 0.2865)

# The building is where the roof is, ~36 m from the tile centre.
NORTH_M = (0.5 - ROOF_CENTRE[1]) * 1366 * MPP
EAST_M = (ROOF_CENTRE[0] - 0.5) * 2048 * MPP
BLAT, BLNG = _offset(LAT, LNG, NORTH_M, EAST_M)


def _best_overlap(anchor, anchor_at):
    segs = _solar_segments_as_fractions(
        _solar_with_building_at(BLAT, BLNG), LAT, LNG, ZOOM,
        anchor=anchor, anchor_at=anchor_at)
    assert segs, "a segment should always be produced"
    return max(_coverage(ROOF, _oriented_positive(s["rect"])) for s in segs)


def test_frame_centre_projection_misses_an_off_centre_roof():
    """The failure mode: the ROOF is off-centre in the image while Google's
    building centre sits near the tile centre. Projecting around the frame
    centre then puts every plane tens of metres from the traced roof.

    (The earlier version of this test placed the building at coordinates derived
    from the roof's own offset, which made frame-centre projection succeed —
    it tested nothing. The building has to sit near the TILE centre for the
    mismatch to appear, which is the real situation.)
    """
    segs = _solar_segments_as_fractions(
        _solar_with_building_at(LAT, LNG), LAT, LNG, ZOOM,
        anchor=None, anchor_at=None)
    assert max(_coverage(ROOF, _oriented_positive(s["rect"])) for s in segs) == 0.0


def test_anchoring_puts_the_building_where_the_roof_is():
    """Anchored on the roof's centroid, a plane at the building's centre lands
    on the roof rather than at the frame centre."""
    segs = _solar_segments_as_fractions(
        _solar_with_building_at(LAT, LNG), LAT, LNG, ZOOM,
        anchor=ROOF_CENTRE, anchor_at=(LAT, LNG))
    cov = max(_coverage(ROOF, _oriented_positive(s["rect"])) for s in segs)
    assert cov >= 0.5, f"expected a match, got {cov:.0%}"


def test_a_genuinely_different_building_still_does_not_match():
    """Anchoring must not make everything match — a plane 80 m from the
    building centre is a different house and must still score no overlap."""
    other_lat, other_lng = _offset(LAT, LNG, 80.0, 80.0)
    segs = _solar_segments_as_fractions(
        _solar_with_building_at(other_lat, other_lng), LAT, LNG, ZOOM,
        anchor=ROOF_CENTRE, anchor_at=(LAT, LNG))
    assert max(_coverage(ROOF, _oriented_positive(s["rect"])) for s in segs) < 0.5
