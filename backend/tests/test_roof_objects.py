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
