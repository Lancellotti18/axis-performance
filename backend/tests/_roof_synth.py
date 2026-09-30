"""Synthetic roofs with exactly known answers, for testing roof_from_dsm.

Each builder returns (dsm, mask, px_m) shaped like Google Solar's Data Layers:
a digital surface model in metres (ground = 0), a boolean roof mask, and the
ground size of one pixel. Roof surfaces are built as the MAX of simple section
height functions, which is how real intersecting roof sections behave: where
two sections meet, the higher surface wins and a valley or hip line appears
exactly where it would on a real house.

Coordinates: x = column (east), y = row (south), both in metres from the
top-left corner.
"""
from __future__ import annotations

import math

import numpy as np

PX = 0.1          # 10 cm per pixel, Google's best Data Layers resolution
EAVE_H = 3.0      # wall-plate height, metres


def _grid(width_m: float, height_m: float, margin_m: float = 3.0):
    w = int(round((width_m + 2 * margin_m) / PX))
    h = int(round((height_m + 2 * margin_m) / PX))
    xs = (np.arange(w) + 0.5) * PX - margin_m
    ys = (np.arange(h) + 0.5) * PX - margin_m
    return np.meshgrid(xs, ys)          # X, Y in metres, origin at the building


def gable_section(X, Y, x0, y0, x1, y1, slope, ridge_axis):
    """Height of a gable roof over the rectangle [x0,x1]x[y0,y1] (NaN outside).
    ridge_axis 'x' means the ridge runs east-west along the rectangle's middle."""
    inside = (X >= x0) & (X < x1) & (Y >= y0) & (Y < y1)
    if ridge_axis == "x":
        half = (y1 - y0) / 2
        d = np.abs(Y - (y0 + y1) / 2)
    else:
        half = (x1 - x0) / 2
        d = np.abs(X - (x0 + x1) / 2)
    z = EAVE_H + slope * (half - d)
    return np.where(inside, z, np.nan)


def hip_section(X, Y, x0, y0, x1, y1, slope):
    """A hip roof over the rectangle: height rises with distance to the NEAREST
    wall, which yields four planes, hip lines at the corners and a ridge."""
    inside = (X >= x0) & (X < x1) & (Y >= y0) & (Y < y1)
    d = np.minimum.reduce([X - x0, x1 - X, Y - y0, y1 - Y])
    return np.where(inside, EAVE_H + slope * d, np.nan)


def _finish(sections):
    z = np.fmax.reduce(sections)        # higher surface wins where sections overlap
    mask = ~np.isnan(z)
    dsm = np.where(mask, z, 0.0).astype(np.float32)
    return dsm, mask


# ── The three test houses ────────────────────────────────────────────────

def gable(W=10.0, L=14.0, slope=0.5):
    """Simple gable, ridge east-west. slope 0.5 = 6/12."""
    X, Y = _grid(L, W)
    return (*_finish([gable_section(X, Y, 0, 0, L, W, slope, "x")]), PX)


def gable_expected(W=10.0, L=14.0, slope=0.5):
    k = math.sqrt(1 + slope ** 2)
    return {"plan_m2": W * L, "true_m2": W * L * k, "planes": 2,
            "eave_m": 2 * L, "rake_m": 2 * W * k, "ridge_m": L,
            "hip_m": 0.0, "valley_m": 0.0, "pitch_12": 12 * slope}


def hip(W=10.0, L=16.0, slope=0.5):
    X, Y = _grid(L, W)
    return (*_finish([hip_section(X, Y, 0, 0, L, W, slope)]), PX)


def hip_expected(W=10.0, L=16.0, slope=0.5):
    k = math.sqrt(1 + slope ** 2)
    return {"plan_m2": W * L, "true_m2": W * L * k, "planes": 4,
            "eave_m": 2 * (W + L), "rake_m": 0.0, "ridge_m": L - W,
            "hip_m": 4 * (W / 2) * math.sqrt(2 + slope ** 2), "valley_m": 0.0,
            "pitch_12": 12 * slope}


def cross_gable(W=8.0, L=16.0, wing=8.0, slope=0.5):
    """An L/T house: main gable (ridge east-west) plus a wing of the same width
    and pitch running south from the middle. Where the two meet: two valleys.
    This is the shape 339 Buch Ave had — and the part the trace left out."""
    X, Y = _grid(L, W + wing)
    main = gable_section(X, Y, 0, 0, L, W, slope, "x")
    cx0 = (L - W) / 2
    wing_sec = gable_section(X, Y, cx0, W / 2, cx0 + W, W + wing, slope, "y")
    return (*_finish([main, wing_sec]), PX)


def cross_gable_expected(W=8.0, L=16.0, wing=8.0, slope=0.5):
    k = math.sqrt(1 + slope ** 2)
    # Footprint: main rectangle plus the wing's part south of the main roof.
    plan = W * L + W * wing
    return {"plan_m2": plan, "true_m2": plan * k, "planes": 5,   # the wing splits the south slope in two
            # Each valley runs from where the eaves meet to the ridge junction.
            "valley_m": 2 * (W / 2) * math.sqrt(2 + slope ** 2),
            # Main ridge, plus the wing ridge running all the way to it.
            "ridge_m": L + wing + W / 2,
            # North eave, south eave either side of the wing, both wing sides.
            "eave_m": L + (L - W) + 2 * wing,
            # Two main gable ends and the wing's gable end, two rakes each.
            "rake_m": 3 * W * k,
            "hip_m": 0.0,
            "pitch_12": 12 * slope}


# ── Real-world roughness ─────────────────────────────────────────────────

def rotate(dsm, mask, degrees):
    """Turn the whole scene. Real houses are not square to north, and a
    diagonal edge on a pixel grid is where naive length measurement breaks."""
    import cv2
    h, w = dsm.shape
    diag = int(math.ceil(math.hypot(h, w))) + 4
    pad_y, pad_x = (diag - h) // 2, (diag - w) // 2
    d = np.zeros((diag, diag), np.float32); d[pad_y:pad_y + h, pad_x:pad_x + w] = dsm
    m = np.zeros((diag, diag), np.uint8); m[pad_y:pad_y + h, pad_x:pad_x + w] = mask
    M = cv2.getRotationMatrix2D((diag / 2, diag / 2), degrees, 1.0)
    # Heights: bilinear is right on the planes; the mask is resampled nearest
    # so the roof edge stays crisp, as Google's mask is.
    d2 = cv2.warpAffine(d, M, (diag, diag), flags=cv2.INTER_LINEAR)
    m2 = cv2.warpAffine(m, M, (diag, diag), flags=cv2.INTER_NEAREST).astype(bool)
    return np.where(m2, d2, 0.0).astype(np.float32), m2


def add_noise(dsm, mask, sigma_m=0.05, seed=7):
    """Survey-grade DSMs carry a few centimetres of noise per pixel."""
    rng = np.random.default_rng(seed)
    return np.where(mask, dsm + rng.normal(0, sigma_m, dsm.shape), 0.0).astype(np.float32)


def add_chimney(dsm, mask, x_m, y_m, size_m=1.0, height_m=1.2, margin_m=3.0):
    """A box poking up through a facet. It must not become a facet, and it must
    not tilt the plane it sits in."""
    r0 = int((y_m + margin_m) / PX); c0 = int((x_m + margin_m) / PX); n = int(size_m / PX)
    out = dsm.copy()
    out[r0:r0 + n, c0:c0 + n] += height_m
    return out
