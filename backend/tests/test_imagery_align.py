"""Lining Google's 3D data up with the contractor's photo.

The real case this exists for (Wilmington, 2026-09-30): the satellite tile sat
~6 m from Google's data, so the auto-measured outline was drawn over the yard.
Here a known shift is baked into a fake "tile" and must be recovered."""
import numpy as np
import pytest
import cv2

from app.services import imagery_align as IA
from tests import _roof_synth as S


def _scene(shift_e, shift_n):
    """Google data: an L-shaped house. The 'tile' is Google's roof-line picture
    moved by (shift_e, shift_n) metres, with some texture and brightness change
    so it is not a byte-for-byte copy."""
    dsm, mask, px = S.cross_gable()
    lines = IA.roof_line_image(dsm)
    h, w = dsm.shape
    M = np.float32([[1, 0, shift_e / px], [0, 1, -shift_n / px]])
    tile = cv2.warpAffine(lines, M, (w, h), borderMode=cv2.BORDER_REPLICATE)
    rng = np.random.default_rng(3)
    tile = np.clip(0.7 * tile + 40 + rng.normal(0, 12, tile.shape), 0, 255).astype(np.uint8)
    tile = np.dstack([tile] * 3)
    # Both rasters share a grid here, with the "tap" at the image centre.
    c0, r0 = w / 2, h / 2
    def px_of(e, n): return c0 + e / px - 0.5, r0 - n / px - 0.5
    rr, cc = np.nonzero(mask)
    e = (cc + 0.5 - c0) * px; n = (r0 - rr - 0.5) * px
    return tile, px_of, lines, (e.min(), e.max(), n.min(), n.max())


@pytest.mark.parametrize("se,sn", [(1.0, -5.8), (-4.0, 3.0), (0.0, 0.0), (7.5, 6.0)])
def test_a_known_shift_is_recovered(se, sn):
    tile, px_of, lines, bb = _scene(se, sn)
    al = IA.align_offset(tile, px_of, lines, px_of, bb)
    assert al is not None
    assert al["east_m"] == pytest.approx(se, abs=0.3)
    assert al["north_m"] == pytest.approx(sn, abs=0.3)


def test_no_confident_match_returns_none():
    """A tile that has nothing to do with the house must not produce a shift —
    a wrong correction would move the outline onto the neighbour's roof."""
    tile, px_of, lines, bb = _scene(0, 0)
    noise = np.random.default_rng(9).integers(0, 255, tile.shape, dtype=np.uint8)
    assert IA.align_offset(noise, px_of, lines, px_of, bb) is None
