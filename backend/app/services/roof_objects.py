"""Things standing up out of the roof - pipe vents, chimneys - from Google's
3D data, confirmed against Google's own 10 cm photo.

Why: an auto-measured roof ordered ZERO pipe boots unless the contractor
remembered to mark every vent by hand, and almost every house has two to
four. The old suggester sent the whole satellite tile to a vision model and
asked it to find 2-pixel dots in a neighbourhood; shown zoomed crops instead,
a vision model still called roof edges "plumbing vents" and found four
skylights on a roof with none (Brookside Oaks, 2026-10-01). Here the height
map says WHERE something sticks up out of a roof plane, and the photo is
checked for the signature of a pipe cap at that exact spot: a small, compact,
bright spot.

Limits: a vent with a dark cap on a dark roof, or one too short to show in
the height map, is not found - the contractor still adds those by hand.

Everything found is a SUGGESTION (ai_suggested, unconfirmed). Nothing reaches
the material order until the contractor confirms it.
"""
from __future__ import annotations

import logging

import cv2
import numpy as np

logger = logging.getLogger(__name__)

MIN_HEIGHT_M = 0.12     # a bump this far above its own roof plane is an object
MIN_AREA_M2 = 0.02      # smaller is noise (a pipe vent is ~0.03-0.1 m2 in the DSM)
MAX_AREA_M2 = 4.0       # bigger is a dormer or a roof section, not a penetration
EDGE_M = 0.2            # nearer a roof edge or crease than this is edge noise (vents sit near ridges)
MERGE_M = 0.8           # bumps closer than this are one object
MAX_OBJECTS = 16        # one crop sheet; more than this is noise, not vents


def find_raised_objects(model, layers) -> list[dict]:
    """Raised objects on the measured roof: [{row, col, area_m2, height_m,
    facet}] in the height map's pixel grid, biggest first."""
    labels, dsm, px = model.labels, np.asarray(layers.dsm, np.float64), layers.px_m
    if labels is None or not model.facets:
        return []
    H, W = labels.shape
    cols, rows = np.meshgrid(np.arange(W), np.arange(H))
    res = np.full((H, W), np.nan)
    for f in model.facets:
        sel = labels == f.id
        a, b, c = f.plane
        res[sel] = dsm[sel] - (a * cols[sel] * px + b * rows[sel] * px + c)
    # Keep away from every boundary — outer edges AND the lines between facets
    # (steps and creases bend the fitted planes there and read as bumps).
    lab = labels.astype(np.float32)
    k = max(3, int(round(2 * EDGE_M / px)) | 1)
    same = cv2.dilate(lab, np.ones((k, k), np.uint8)) == cv2.erode(lab, np.ones((k, k), np.uint8))
    inner = same & (labels >= 0)
    up = inner & (np.nan_to_num(res, nan=-1.0) > MIN_HEIGHT_M)
    n, comp, stats, cent = cv2.connectedComponentsWithStats(up.astype(np.uint8), connectivity=8)
    out = []
    for i in range(1, n):
        area = float(stats[i, cv2.CC_STAT_AREA]) * px * px
        if not (MIN_AREA_M2 <= area <= MAX_AREA_M2):
            continue
        blob = comp == i
        r, c = cent[i][1], cent[i][0]
        out.append({"row": float(r), "col": float(c), "area_m2": round(area, 3),
                    "height_m": round(float(np.nanmax(res[blob])), 2),
                    "facet": int(labels[int(round(r)), int(round(c))])})
    out.sort(key=lambda o: -o["area_m2"])
    # One object read as two bumps (a vent and its cap, a pipe pair) shows up
    # twice in neighbouring crops; keep the bigger one.
    merged: list[dict] = []
    for o in out:
        if all(((o["row"] - m["row"]) ** 2 + (o["col"] - m["col"]) ** 2) ** 0.5 * px > MERGE_M for m in merged):
            merged.append(o)
    return merged[:MAX_OBJECTS]


SPOT_R_M = 0.7           # look for the cap within this of the height bump (the bump includes its shadow)
SPOT_CONTRAST = 40       # grey levels brighter/darker than the shingles around it
SPOT_MAX_M2 = 0.25       # a pipe vent cap is a few hundred cm2; bigger is something else
SPOT_MAX_ELONG = 3.0     # long and thin is a roof edge or a ridge highlight, not a vent
SPOT_MIN_M2 = 0.025      # smaller is a glint on the shingles


def _spots(gray, row, col, px_m):
    """High-contrast spots near (row, col): [(area_m2, elongation, bright)]."""
    r = int(round(SPOT_R_M / px_m))
    H, W = gray.shape
    r0, r1 = max(0, int(row) - 3 * r), min(H, int(row) + 3 * r + 1)
    c0, c1 = max(0, int(col) - 3 * r), min(W, int(col) + 3 * r + 1)
    win = gray[r0:r1, c0:c1].astype(np.float32)
    if win.size == 0:
        return []
    bg = cv2.medianBlur(np.clip(win, 0, 255).astype(np.uint8), 2 * (r // 2) * 2 + 1 if r > 2 else 5).astype(np.float32)
    out = []
    for bright, mask in ((True, win - bg > SPOT_CONTRAST), (False, bg - win > SPOT_CONTRAST)):
        n, comp, stats, cent = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
        for i in range(1, n):
            cy, cx = cent[i][1] + r0, cent[i][0] + c0
            if ((cy - row) ** 2 + (cx - col) ** 2) ** 0.5 > r:
                continue                                 # outside the circle
            area = float(stats[i, cv2.CC_STAT_AREA]) * px_m * px_m
            ys, xs = np.nonzero(comp == i)
            if len(xs) >= 3:
                ev = np.linalg.eigvalsh(np.cov(np.vstack([xs, ys]).astype(np.float64)) + 1e-6 * np.eye(2))
                elong = float((ev[1] / max(ev[0], 1e-6)) ** 0.5)
            else:
                elong = 1.0
            out.append((area, elong, bright))
    return out


def classify_by_photo(objects: list[dict], rgb, px_m: float) -> list[dict]:
    """Type each raised object from what Google's photo shows at that spot.

    A vision model shown these crops called roof edges "plumbing vents" and
    found four skylights on a roof with none (Brookside Oaks, 2026-10-01). The
    signature is simple and checkable instead: a vent is a small, compact,
    high-contrast spot (the cap and its shadow) on the bump; an edge is a long
    thin line; a step or a shadow has no compact spot at all.
    Returns only objects with evidence; each carries a count and a reason."""
    if rgb is None:
        return []
    gray = cv2.cvtColor(np.ascontiguousarray(np.asarray(rgb)[..., :3]).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    out = []
    for o in objects:
        # Sunlit pipe caps are BRIGHT; dark spots are their shadows (or the
        # shadow of something else), so only bright ones are counted - one per cap.
        caps = [s for s in _spots(gray, o["row"], o["col"], px_m)
                if s[2] and SPOT_MIN_M2 <= s[0] <= SPOT_MAX_M2 and s[1] <= SPOT_MAX_ELONG]
        if o["area_m2"] >= 0.6 and o["height_m"] >= 0.5:
            out.append({**o, "type": "chimney", "count": 1, "confidence": 0.5,
                        "reason": f"{o['height_m']:.1f} m tall block on the roof — a chimney or a rooftop "
                                  "unit; check which before confirming"})
        elif caps:
            n = min(4, len(caps))
            out.append({**o, "type": "plumbing_vent", "count": n, "confidence": 0.7,
                        "reason": f"{o['height_m'] * 39.37:.0f} in tall bump with a pipe-cap spot in the photo"})
    return out
