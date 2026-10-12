"""Vents and chimneys from Google's 3D data, checked against the photo.

A vision model shown these spots called roof edges "plumbing vents" and found
four skylights on a roof with none. The rule here is checkable: a raised bump
on a roof plane AND a small, compact, bright cap in the photo at that spot."""
import numpy as np

from tests import _roof_synth as S
from app.services.roof_from_dsm import extract_roof
from app.services.roof_objects import find_raised_objects, classify_by_photo


class _Layers:
    def __init__(self, dsm, rgb, px):
        self.dsm, self.rgb, self.px_m = dsm, rgb, px


def _roof_with(pipe=True, cap=True, line=False):
    dsm, mask, px = S.gable()
    rgb = np.full(dsm.shape + (3,), 110, np.uint8)
    r, c = 60, 80                        # on the north slope, away from edges and the ridge
    if pipe:
        dsm = dsm.copy()
        dsm[r:r + 2, c:c + 2] += 0.3     # a 20 cm pipe standing 30 cm proud
    if cap:
        rgb[r - 1:r + 2, c - 1:c + 2] = 235
    if line:
        rgb[r, c - 12:c + 12] = 235      # a bright edge-like line, not a cap
    return dsm, mask, px, rgb


def _found(**kw):
    dsm, mask, px, rgb = _roof_with(**kw)
    m = extract_roof(dsm, mask, px)
    return classify_by_photo(find_raised_objects(m, _Layers(dsm, rgb, px)), rgb, px)


def test_a_pipe_vent_with_its_cap_is_found():
    hits = _found()
    assert [(h["type"], h["count"]) for h in hits] == [("plumbing_vent", 1)]


def test_a_bump_with_nothing_in_the_photo_is_not_a_vent():
    assert _found(cap=False) == []


def test_a_bright_line_is_not_a_vent_cap():
    assert _found(cap=False, line=True) == []


def test_a_plain_roof_has_nothing():
    assert _found(pipe=False, cap=False) == []


def _roof_with_vents(spots):
    """Several pipe vents, each a bump in the height map with a cap in the photo."""
    dsm, mask, px = S.gable()
    dsm = dsm.copy()
    rgb = np.full(dsm.shape + (3,), 110, np.uint8)
    for r, c in spots:
        dsm[r:r + 2, c:c + 2] += 0.3
        rgb[r - 1:r + 2, c - 1:c + 2] = 235
    return dsm, mask, px, rgb


def test_each_vent_is_marked_where_it_is_not_all_on_one():
    """Three vents near each other were counted right (count=3) but all pinned
    to one vent's position. Each is now its own suggestion at its own spot."""
    spots = [(60, 80), (60, 84), (64, 82)]     # within one bump's search radius
    dsm, mask, px, rgb = _roof_with_vents(spots)
    m = extract_roof(dsm, mask, px)
    hits = classify_by_photo(find_raised_objects(m, _Layers(dsm, rgb, px)), rgb, px)
    vents = [h for h in hits if h["type"] == "plumbing_vent"]
    assert sum(h["count"] for h in vents) == 3
    assert all(h["count"] == 1 for h in vents)
    found = sorted((round(h["row"]), round(h["col"])) for h in vents)
    want = sorted(spots)
    # Each suggestion sits on a different vent (cap centroids are the 3x3
    # block centres, so allow a pixel either way).
    assert len(set(found)) == 3
    for (fr, fc), (wr, wc) in zip(found, want):
        assert abs(fr - wr) <= 1 and abs(fc - wc) <= 1


def test_vents_far_apart_are_each_found_once():
    spots = [(60, 60), (60, 100)]
    dsm, mask, px, rgb = _roof_with_vents(spots)
    m = extract_roof(dsm, mask, px)
    hits = classify_by_photo(find_raised_objects(m, _Layers(dsm, rgb, px)), rgb, px)
    vents = [h for h in hits if h["type"] == "plumbing_vent"]
    assert len(vents) == 2
