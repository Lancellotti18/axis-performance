"""The last pass over auto-measured outlines: no spikes, no outline crossing
itself, no slivers, no two facets claiming the same roof.

6219 Strawfield Dr (2026-10-20) came out of auto-measure with a facet whose
outline ran out and back on itself, a facet squeezed to a zero-area line, and
one facet's outline lying over a fifth of its neighbour. These build those
shapes directly and check the pass repairs them without moving anything else.
"""
import numpy as np

from app.services.roof_from_dsm import (AxisFacet, _area_px, _cut_loops, _drop_spikes,
                                        _tidy_outlines)

PX = 0.1                                   # metres per pixel, as Google's layers


def _labels(shape=(120, 120)):
    return np.full(shape, -2, dtype=np.int32)


def _valid(pts):
    n = len(pts)
    from app.services.roof_from_dsm import _seg_cross
    return not any(_seg_cross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]) is not None
                   for i in range(n) for j in range(i + 2, n) if not (i == 0 and j == n - 1))


def test_a_spike_is_removed_and_the_square_kept():
    sq = [(10, 10), (60, 10), (60, 60), (35, 60), (35, 90), (35.2, 60), (10, 60)]
    sides = [("eave", None)] * 3 + [("rake", None), ("unlabeled", None), ("rake", None), ("eave", None)]
    pts, s = _drop_spikes(sq, sides, PX)
    assert len(pts) == len(s)
    assert abs(_area_px(pts) - 2500) < 15
    assert all(p[1] <= 60.01 for p in pts)


def test_an_outline_that_crosses_itself_keeps_its_big_loop():
    # A 50x50 square whose last corner was dragged across the opposite side,
    # tying off a small loop beyond it.
    bowtie = [(10, 10), (60, 10), (60, 60), (10, 60), (70, 40), (10, 40)]
    sides = [(k, None) for k in ("eave", "rake", "eave", "valley", "valley", "rake")]
    assert not _valid([np.array(p, float) for p in bowtie])
    pts, s = _cut_loops([np.array(p, float) for p in bowtie], sides)
    assert _valid(pts)
    assert len(pts) == len(s)
    # The bigger loop is the 50 x 30 body; the tied-off tail is gone.
    assert abs(_area_px(pts) - 1500) < 1
    assert max(x for x, _ in pts) <= 60.01


def test_a_zero_area_facet_is_dropped_and_its_neighbour_forgets_it():
    lab = _labels()
    lab[10:60, 10:60] = 1
    big = AxisFacet("A", 1, [(10, 10), (60, 10), (60, 60), (10, 60)],
                    [("eave", None), ("rake", None), ("valley", 2), ("rake", None)], 6.0)
    line = AxisFacet("B", 2, [(10, 60), (35, 60), (60, 60)],
                     [("valley", 1), ("valley", 1), ("eave", None)], 6.0)
    out = _tidy_outlines([big, line], lab, PX)
    assert [a.label for a in out] == ["A"]
    assert out[0].sides[2] == ("valley", None)


def test_overlapping_facets_give_the_patch_to_the_one_the_heights_belong_to():
    lab = _labels()
    lab[10:60, 10:60] = 1                  # facet 1 owns this square
    lab[10:60, 60:100] = 2                 # facet 2 is next to it
    owner = AxisFacet("A", 1, [(10, 10), (60, 10), (60, 60), (10, 60)],
                      [("eave", None), ("valley", 2), ("eave", None), ("rake", None)], 6.0)
    # Facet 2's outline wrongly reaches 15 px into facet 1.
    intruder = AxisFacet("B", 2, [(45, 10), (100, 10), (100, 60), (45, 60)],
                         [("eave", None), ("rake", None), ("eave", None), ("valley", 1)], 6.0)
    out = {a.fid: a for a in _tidy_outlines([owner, intruder], lab, PX)}
    assert abs(_area_px(out[1].vertices_px) - 2500) < 1          # the owner is untouched
    assert abs(_area_px(out[2].vertices_px) - 2000) < 60          # the intruder is trimmed back
    assert min(x for x, _ in out[2].vertices_px) >= 59.5


def test_a_thin_wedge_is_not_a_facet_but_a_small_real_one_is():
    lab = _labels()
    small = AxisFacet("A", 1, [(10, 10), (30, 10), (30, 40), (10, 40)],       # 2 x 3 m
                      [("eave", None), ("rake", None), ("eave", None), ("rake", None)], 6.0)
    wedge = AxisFacet("B", 2, [(50, 10), (110, 14), (50, 16)],              # 6 m long, <0.6 m wide
                      [("rake", None), ("eave", None), ("rake", None)], 6.0)
    out = _tidy_outlines([small, wedge], lab, PX)
    assert [a.fid for a in out] == [1]


def test_a_short_unlabeled_corner_stub_takes_the_line_beside_it():
    lab = _labels()
    f = AxisFacet("A", 1, [(10, 10), (60, 10), (60, 60), (64, 64), (10, 60)],
                  [("eave", None), ("rake", None), ("unlabeled", None), ("eave", None), ("rake", None)],
                  6.0)
    out = _tidy_outlines([f], lab, PX)
    assert all(k != "unlabeled" for k, _ in out[0].sides)


def test_a_long_unlabeled_side_is_left_for_the_contractor():
    lab = _labels()
    f = AxisFacet("A", 1, [(10, 10), (60, 10), (60, 60), (10, 60)],
                  [("eave", None), ("unlabeled", None), ("eave", None), ("rake", None)], 6.0)
    out = _tidy_outlines([f], lab, PX)
    assert out[0].sides[1][0] == "unlabeled"


def test_two_facets_share_one_trace_of_their_border():
    """6219 Strawfield: the back slope and a small raised roof each traced the
    border between them with their own zig-zag, so two sets of lines crossed
    on screen and the report counted the border twice."""
    lab = _labels()
    big = AxisFacet("A", 1, [(10, 10), (60, 10), (60, 35), (60, 60), (10, 60)],
                    [("eave", None), ("valley", 2), ("valley", 2), ("eave", None), ("rake", None)], 6.0)
    # Facet 2's copy of the same border wanders 1.5 px off it.
    small = AxisFacet("B", 2, [(60, 10), (90, 10), (90, 60), (60, 60), (61.5, 35)],
                      [("eave", None), ("rake", None), ("eave", None), ("valley", 1), ("valley", 1)], 6.0)
    out = {a.fid: a for a in _tidy_outlines([big, small], lab, PX)}
    border = {p for p in map(tuple, out[2].vertices_px) if p[0] < 62}
    assert border <= {(60.0, 10.0), (60.0, 35.0), (60.0, 60.0)}
    assert [k for k, nb in out[2].sides if nb == 1] == ["valley", "valley"]


def test_a_corner_cut_off_the_roof_gets_its_corner_back():
    """6219 Strawfield: a straight outer side cut a 1.2 m² wedge off the roof,
    which the report drew as a bite out of the house."""
    lab = _labels()
    lab[10:60, 10:60] = 1
    cut = AxisFacet("A", 1, [(30, 10), (59, 10), (59, 59), (10, 59), (10, 30)],
                    [("eave", None), ("rake", None), ("eave", None), ("rake", None), ("rake", None)], 6.0)
    out = _tidy_outlines([cut], lab, PX)
    assert _area_px(out[0].vertices_px) > _area_px(cut.vertices_px) + 150
    assert len(out[0].sides) == len(out[0].vertices_px)


def test_a_repair_may_not_open_a_hole_in_the_roof():
    """Trimming an overlap must not hand back roof nobody else covers."""
    lab = _labels()
    lab[10:60, 10:60] = 1
    lab[10:60, 60:100] = 2
    owner = AxisFacet("A", 1, [(10, 10), (60, 10), (60, 60), (10, 60)],
                      [("eave", None), ("valley", 2), ("eave", None), ("rake", None)], 6.0)
    intruder = AxisFacet("B", 2, [(45, 10), (100, 10), (100, 60), (45, 60)],
                         [("eave", None), ("rake", None), ("eave", None), ("valley", 1)], 6.0)
    out = _tidy_outlines([owner, intruder], lab, PX)
    import cv2
    cov = np.zeros(lab.shape, np.uint8)
    for a in out:
        cv2.fillPoly(cov, [np.round(np.asarray(a.vertices_px)).astype(np.int32)], 1)
    hole = ((lab >= 0) & (cov == 0)).sum() * PX ** 2
    assert hole < 0.5
