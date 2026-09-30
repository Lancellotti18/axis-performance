"""Roof geometry from a height map, checked against roofs with known answers.

Tolerances are deliberately tighter than the launch gate (squares ±7%, linear
±15%): if the geometry cannot beat those on clean synthetic roofs, it has no
chance on Google's real, noisier data. Every case is also run rotated and with
survey-grade noise, because those are what break naive pixel measurement — the
first version of this read a hip roof's ridge 61% long once noise was added.
"""
import numpy as np
import pytest

from tests import _roof_synth as S
from app.services.roof_from_dsm import extract_roof

AREA_TOL = 0.01      # 1%
LINE_TOL = 0.05      # 5% (worst seen on synthetic: 2.5%)
LINE_ABS_M = 0.5     # a line that should not exist may read up to this long

CASES = ["gable", "hip", "cross_gable"]
VARIANTS = [(0, False), (17, False), (38, False), (0, True), (17, True), (38, True)]


def _run(name, angle, noisy):
    dsm, mask, px = getattr(S, name)()
    if angle:
        dsm, mask = S.rotate(dsm, mask, angle)
    if noisy:
        dsm = S.add_noise(dsm, mask)
    return extract_roof(dsm, mask, px), getattr(S, name + "_expected")()


@pytest.mark.parametrize("name", CASES)
@pytest.mark.parametrize("angle,noisy", VARIANTS)
def test_area_pitch_and_facets_are_exact(name, angle, noisy):
    m, exp = _run(name, angle, noisy)
    assert m.available, m.reason
    assert m.true_m2 == pytest.approx(exp["true_m2"], rel=AREA_TOL)
    assert len(m.facets) == exp["planes"]
    for f in m.facets:
        assert f.pitch_12 == pytest.approx(exp["pitch_12"], abs=0.2)


@pytest.mark.parametrize("name", CASES)
@pytest.mark.parametrize("angle,noisy", VARIANTS)
def test_every_line_type_is_measured_and_typed(name, angle, noisy):
    m, exp = _run(name, angle, noisy)
    for kind in ("eave", "rake", "ridge", "hip", "valley"):
        want = exp.get(kind + "_m", 0.0)
        got = m.lengths_m.get(kind, 0.0)
        if want:
            assert got == pytest.approx(want, rel=LINE_TOL), f"{kind}: {got:.2f} vs {want:.2f}"
        else:
            assert got <= LINE_ABS_M, f"{kind} should not exist, read {got:.2f} m"
    # Nothing on these roofs is ambiguous, so nothing should be left for the
    # contractor to label.
    assert m.lengths_m.get("unlabeled", 0.0) <= LINE_ABS_M


def test_the_buch_ave_shape_finds_its_valleys():
    """The section the hand trace left out is the one with the valleys. Finding
    them is the point of measuring from heights."""
    m, exp = _run("cross_gable", 0, True)
    assert m.lengths_m["valley"] == pytest.approx(exp["valley_m"], rel=LINE_TOL)
    assert m.lengths_m.get("hip", 0.0) <= LINE_ABS_M        # Buch Ave "found" 26 ft of hips


def test_a_chimney_is_not_a_facet_and_does_not_tilt_the_roof():
    dsm, mask, px = S.gable()
    m = extract_roof(S.add_chimney(dsm, mask, 4.0, 2.0), mask, px)
    assert len(m.facets) == 2
    assert all(f.pitch_12 == pytest.approx(6.0, abs=0.2) for f in m.facets)


def test_totals_use_the_keys_axis_stores():
    m, _ = _run("hip", 0, False)
    t = m.totals()
    for key in ("total_plan_sqft", "total_roof_sqft", "squares", "eaves_ft", "rakes_ft",
                "ridges_ft", "hips_ft", "valleys_ft", "facet_count", "predominant_pitch"):
        assert key in t
    assert t["predominant_pitch"] == "6/12"
    assert t["squares"] == pytest.approx(178.89 * 10.7639 / 100, rel=AREA_TOL)


# ── Picking the right building ────────────────────────────────────────────

def _two_houses():
    """A gable and, 6 m east, a bigger hip roof: the neighbour."""
    g, gm, px = S.gable()
    h, hm, _ = S.hip()
    H = max(g.shape[0], h.shape[0])
    dsm = np.zeros((H, g.shape[1] + h.shape[1]), np.float32)
    mask = np.zeros(dsm.shape, bool)
    dsm[:g.shape[0], :g.shape[1]] = g; mask[:g.shape[0], :g.shape[1]] = gm
    dsm[:h.shape[0], g.shape[1]:] = h; mask[:h.shape[0], g.shape[1]:] = hm
    return dsm, mask, px, g.shape


def test_the_tapped_house_is_measured_not_the_biggest_one():
    dsm, mask, px, gshape = _two_houses()
    tapped = (gshape[0] // 2, gshape[1] // 2)       # centre of the gable
    m = extract_roof(dsm, mask, px, seed_rc=tapped)
    assert len(m.facets) == 2                      # the gable, not the 4-plane hip


def test_without_a_tap_the_largest_building_is_measured():
    dsm, mask, px, _ = _two_houses()
    assert len(extract_roof(dsm, mask, px).facets) == 4


def test_a_tap_on_the_driveway_snaps_to_the_nearby_house():
    dsm, mask, px, gshape = _two_houses()
    near = (gshape[0] - 5, gshape[1] // 2)          # just below the gable's roof
    m = extract_roof(dsm, mask, px, seed_rc=near)
    assert m.available and len(m.facets) == 2


def test_a_tap_far_from_any_roof_falls_back_to_manual_tracing():
    dsm, mask, px, _ = _two_houses()
    big = np.zeros((dsm.shape[0] + 400, dsm.shape[1]), np.float32); big[:dsm.shape[0]] = dsm
    bigm = np.zeros(big.shape, bool); bigm[:mask.shape[0]] = mask
    m = extract_roof(big, bigm, px, seed_rc=(big.shape[0] - 5, 10))
    assert not m.available and "8 m" in m.reason


def test_a_shed_alone_is_not_measured_as_a_house():
    dsm, mask, px = S.gable(W=3.0, L=4.0)          # 12 m² — a shed
    m = extract_roof(dsm, mask, px)
    assert not m.available and "small" in m.reason


def test_an_empty_mask_is_reported_not_crashed_on():
    m = extract_roof(np.zeros((50, 50), np.float32), np.zeros((50, 50), bool), 0.1)
    assert not m.available
