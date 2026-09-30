"""How far is Google's 3D data shifted from the satellite photo the contractor sees?

The run's satellite tile (Esri, MapTiler...) and Google's Data Layers are
georeferenced independently and routinely disagree by a few metres. Anchored on
the tap's latitude/longitude alone, the measured roof was drawn ~8 m north of
the house on Ryan's first live test (Wilmington, 2026-09-30) — over the yard —
and the tap landed near the wrong end of the roof in Google's data.

What worked, tried on that house against the alternatives: take the ROOF LINES
from Google's height map (height-gradient strength around the measured
building: eaves, ridges, hips all show as sharp gradients) and find them among
the edges of the contractor's photo, within +/-15 m. Roof lines are the same
in any photo of the roof. Whole-scene phase correlation and plain brightness
matching were both fooled by the differences that matter here — leaf-on vs
leaf-off trees, lawn colour, shadows — and pointed at the wrong building.

Result: a translation in metres. A feature at ground position P in Google's
data appears in the tile at P + (east_m, north_m). Rotation and scale between
providers are negligible at house scale.
"""
from __future__ import annotations

from typing import Callable, Optional

import cv2
import numpy as np

SEARCH_M = 15.0          # misregistration beyond this is not what we are correcting
STEP_M = 0.2             # matching grid resolution
MARGIN_M = 3.0           # context kept around the building in the template
MIN_SCORE = 0.25         # normalised correlation of the best match
MIN_LEAD = 0.04          # ...and how far it must beat any match > 2 m away


def _edges(gray: np.ndarray) -> np.ndarray:
    g = cv2.GaussianBlur(gray.astype(np.float32), (0, 0), 1.2)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.hypot(gx, gy)
    mag -= mag.mean()
    s = mag.std()
    return mag / s if s > 1e-6 else mag


def _gray(img: np.ndarray) -> np.ndarray:
    if img.ndim == 3:
        return cv2.cvtColor(img[..., :3].astype(np.uint8), cv2.COLOR_RGB2GRAY)
    return img.astype(np.uint8)


def _grid(e_lo: float, e_hi: float, n_lo: float, n_hi: float):
    nx = max(4, int((e_hi - e_lo) / STEP_M))
    ny = max(4, int((n_hi - n_lo) / STEP_M))
    j, i = np.meshgrid(np.arange(nx), np.arange(ny))
    return e_lo + (j + 0.5) * STEP_M, n_hi - (i + 0.5) * STEP_M


def roof_line_image(dsm: np.ndarray) -> np.ndarray:
    """Height-gradient strength as an 8-bit image: bright on eaves, ridges,
    hips and valleys; dark on flat slopes and lawn."""
    gy, gx = np.gradient(dsm.astype(np.float64), 0.1)
    return np.clip(np.hypot(gx, gy) * 60.0, 0, 255).astype(np.uint8)


def align_offset(tile_rgb: np.ndarray,
                 tile_px_of: Callable[[np.ndarray, np.ndarray], tuple],
                 roof_lines: np.ndarray,
                 google_px_of: Callable[[np.ndarray, np.ndarray], tuple],
                 building_en: tuple[float, float, float, float]) -> Optional[dict]:
    """Shift (east_m, north_m) of the tile relative to Google, or None when the
    match is not clearly the right one.

    tile_px_of(east, north)   -> (x, y) tile pixel for a ground offset from the
                                 tap, as lat/lng anchoring places it
    google_px_of(east, north) -> (col, row) pixel in Google's rasters
    roof_lines                -> roof_line_image(dsm)
    building_en               -> (e_min, e_max, n_min, n_max) of the measured
                                 building, metres from the tap
    """
    e0, e1, n0, n1 = building_en
    TE, TN = _grid(e0 - MARGIN_M, e1 + MARGIN_M, n0 - MARGIN_M, n1 + MARGIN_M)
    SE, SN = _grid(e0 - MARGIN_M - SEARCH_M, e1 + MARGIN_M + SEARCH_M,
                   n0 - MARGIN_M - SEARCH_M, n1 + MARGIN_M + SEARCH_M)
    gc, gr = google_px_of(TE, TN)
    tpl = cv2.remap(roof_lines, gc.astype(np.float32), gr.astype(np.float32), cv2.INTER_LINEAR,
                    borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    tx, ty = tile_px_of(SE, SN)
    srch = cv2.remap(_gray(tile_rgb), tx.astype(np.float32), ty.astype(np.float32),
                     cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    t, s = _edges(tpl), _edges(srch)
    if t.shape[0] >= s.shape[0] or t.shape[1] >= s.shape[1]:
        return None
    res = cv2.matchTemplate(s, t, cv2.TM_CCOEFF_NORMED)
    _, best, _, loc = cv2.minMaxLoc(res)
    others = res.copy()
    cv2.circle(others, loc, int(round(2.0 / STEP_M)), -1.0, -1)
    lead = best - float(others.max())
    east_m = (loc[0] - SEARCH_M / STEP_M) * STEP_M
    north_m = -(loc[1] - SEARCH_M / STEP_M) * STEP_M
    if best < MIN_SCORE or lead < MIN_LEAD:
        return None
    return {"east_m": float(east_m), "north_m": float(north_m),
            "score": float(best), "lead": float(lead)}
