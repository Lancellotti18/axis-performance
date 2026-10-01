"""Measure a roof from a height map instead of from a hand trace.

Google Solar's Data Layers endpoint returns, for a property, a digital surface
model (DSM: the height of every ~10 cm square, in metres) and a roof mask. A
roof's geometry is entirely a statement about heights, so everything a
contractor traces by hand can be derived from them instead:

  * the outline      — the building's region of the roof mask
  * the facets       — connected regions where the surface faces one way
  * each facet's pitch — from the plane fitted to its heights, measured, never
                         assumed
  * each edge's type — from what the heights do on either side of it: falling
                       away on both sides is a ridge (level) or hip (sloped),
                       rising on both is a valley, and a drop to the ground is
                       an eave (level) or rake (sloped)

This module is pure: numpy + OpenCV over arrays, no network, no database. That
is what lets it be tested on synthetic roofs whose true measurements are known
exactly, before it ever sees a real address. Fetching the arrays is
solar_layers_service's job; deciding whether the result is good enough to use,
or whether the contractor traces by hand as before, is the caller's — using the
quality figures reported here.

Coordinates: x = column (east), y = row (south). Heights in metres.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np

M2_TO_SQFT = 10.7639
M_TO_FT = 3.28084

OUTSIDE = -2          # label for pixels that are not this building's roof
UNASSIGNED = -1
PARKED = -1000        # tried as a seed, too small or thin to be a facet


@dataclass
class Facet:
    id: int
    plan_m2: float
    true_m2: float
    pitch_deg: float
    pitch_12: float                    # rise per 12 of run
    azimuth_deg: float                 # compass direction the facet faces (downslope)
    plane: tuple[float, float, float]  # z = a*x + b*y + c, x/y in metres
    rms_m: float                       # how well a plane explains its heights
    polygon_px: list[tuple[float, float]] = field(default_factory=list)


@dataclass
class Edge:
    kind: str                  # eave | rake | ridge | hip | valley | wall_intersection | unlabeled
    facet: int
    neighbour: Optional[int]   # None = the building's outside edge
    p0: tuple[float, float]    # (col, row)
    p1: tuple[float, float]
    plan_m: float
    length_m: float            # true 3D length along the roof


@dataclass
class RoofModel:
    available: bool
    reason: Optional[str] = None
    px_m: float = 0.0
    facets: list[Facet] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)
    plan_m2: float = 0.0
    true_m2: float = 0.0
    lengths_m: dict = field(default_factory=dict)   # kind -> deduplicated total
    quality: dict = field(default_factory=dict)
    labels: Optional[np.ndarray] = None             # per-pixel facet id, for overlays

    def totals(self) -> dict:
        """The same keys Axis stores for a traced run, in feet / square feet."""
        L = self.lengths_m
        biggest = max(self.facets, key=lambda f: f.true_m2) if self.facets else None
        return {
            "total_plan_sqft": round(self.plan_m2 * M2_TO_SQFT, 1),
            "total_roof_sqft": round(self.true_m2 * M2_TO_SQFT, 1),
            "squares": round(self.true_m2 * M2_TO_SQFT / 100, 2),
            "facet_count": len(self.facets),
            "eaves_ft": round(L.get("eave", 0) * M_TO_FT, 1),
            "rakes_ft": round(L.get("rake", 0) * M_TO_FT, 1),
            "ridges_ft": round(L.get("ridge", 0) * M_TO_FT, 1),
            "hips_ft": round(L.get("hip", 0) * M_TO_FT, 1),
            "valleys_ft": round(L.get("valley", 0) * M_TO_FT, 1),
            "wall_intersection_ft": round(L.get("wall_intersection", 0) * M_TO_FT, 1),
            "predominant_pitch": f"{round(biggest.pitch_12)}/12" if biggest else None,
        }


# ── Tunables ─────────────────────────────────────────────────────────────
# Starting values, set on synthetic roofs. Real Google DSMs are noisier and
# these will be re-tuned on real addresses before anything ships.
SMOOTH_SIGMA_PX = 1.0       # height smoothing before normals are taken
GROW_ANGLE_DEG = 10.0       # max tilt between a pixel and the plane it joins
MIN_FACET_M2 = 1.5          # smaller regions are noise or chimneys, not facets
THIN_ERODE_PX = 2           # a "facet" that vanishes under this erosion is a crease strip
LEVEL_RISE_PER_RUN = 0.15   # an edge climbing less than this is level (eave/ridge)
STEP_M = 0.4                # a height gap this big between facets is a wall, not a crease
SIDE_TOL_M = 0.30           # outline topology tolerance; sides are then re-fitted (see _regularize)


def extract_roof(dsm: np.ndarray, mask: np.ndarray, px_m: float,
                 seed_rc: Optional[tuple[int, int]] = None,
                 *, min_building_m2: float = 30.0) -> RoofModel:
    """Measure the roof of the building at `seed_rc` (the tapped house, as
    row/col in these arrays), or of the largest building if none is given."""
    dsm = np.asarray(dsm, dtype=np.float64)
    picked = _select_building(np.asarray(mask, dtype=bool), px_m, seed_rc, min_building_m2)
    if isinstance(picked, str):
        return RoofModel(False, picked, px_m=px_m)
    bldg, selection = picked

    normals, curvature = _surface_normals(dsm, bldg, px_m)
    labels = _grow_planes(normals, curvature, bldg, px_m)
    planes = _fit_planes(dsm, labels, px_m)
    if not planes:
        return RoofModel(False, "no roof plane large enough to measure was found", px_m=px_m)
    labels = _assign_remaining(dsm, labels, bldg, planes, px_m)
    labels = _sharpen_creases(dsm, labels, bldg, planes, px_m)
    planes = _fit_planes(dsm, labels, px_m)          # refit on the final regions
    for _ in range(3):
        labels, split = _split_lower_roofs(dsm, normals, curvature, labels, planes, px_m, bldg)
        if not split:
            break
        planes = _fit_planes(dsm, labels, px_m)
        labels = _assign_remaining(dsm, labels, bldg, planes, px_m)
        labels = _sharpen_creases(dsm, labels, bldg, planes, px_m)
        planes = _fit_planes(dsm, labels, px_m)
    labels, thin = _dissolve_thin(labels, planes, px_m)
    if thin:
        planes = {k: v for k, v in planes.items() if k not in thin}
        labels = _assign_remaining(dsm, labels, bldg, planes, px_m)
        labels = _sharpen_creases(dsm, labels, bldg, planes, px_m)
        planes = _fit_planes(dsm, labels, px_m)
    labels, planes = _merge_coplanar(dsm, labels, planes, px_m)
    labels = _sharpen_creases(dsm, labels, bldg, planes, px_m)
    planes = _fit_planes(dsm, labels, px_m)

    facets = _facets(dsm, labels, planes, px_m)
    kept = {f.id for f in facets}
    edges = []
    for f in facets:
        # Outline sides: only the ones on the building's outside edge. Lines
        # between two facets come from _crease_edges, which does not trust the
        # noisy pixel boundary for where they are.
        fe = _facet_edges(f, labels, planes, px_m)
        ks = _absorb_corner_stubs([e.kind for e in fe], [e.plan_m for e in fe],
                                  [e.neighbour is None for e in fe])
        for e, k in zip(fe, ks):
            e.kind = k
        edges.extend(e for e in fe if e.neighbour is None)
    edges.extend(_crease_edges(labels, {k: v for k, v in planes.items() if k in kept}, px_m, dsm))
    lengths = _dedup_lengths(edges)

    plan = float(bldg.sum()) * px_m ** 2
    true = sum(f.true_m2 for f in facets)
    assigned = float((labels >= 0).sum()) / max(1.0, float(bldg.sum()))
    worst_rms = max((f.rms_m for f in facets), default=0.0)
    return RoofModel(
        True, None, px_m, facets, edges, round(plan, 2), round(true, 2), lengths,
        quality={"assigned_fraction": round(assigned, 4),
                 "worst_facet_rms_m": round(worst_rms, 3),
                 "facet_count": len(facets),
                 "selection": selection,
                 "attached_suspected": _attached_suspected(bldg, px_m)},
        labels=labels,
    )


# ── Steps ────────────────────────────────────────────────────────────────

# Right-house rules. A report on the wrong roof is worse than no report, and
# Axis has already shipped three wrong-building bugs, so the engine refuses to
# guess: anything uncertain returns a reason and the contractor traces by hand.
SNAP_M = 3.0          # a tap this close to a roof (a driveway, an eave's shadow) snaps to it
AMBIGUOUS_M = 2.0     # if a second roof is within this much of the nearest, ask again
# Attached homes share one continuous roof, and the whole row would be measured.
# A footprint this large, or this elongated, is flagged for the contractor to trim.
ATTACHED_M2 = 460.0   # ~5,000 sq ft of footprint
ATTACHED_ASPECT = 3.5


def _select_building(mask, px_m, seed_rc, min_m2):
    """The building to measure, or a sentence saying why none can be chosen.
    Returns (building_mask, selection_info) on success."""
    n, comp = cv2.connectedComponents(mask.astype(np.uint8), connectivity=8)
    if n <= 1:
        return "no roof pixels in the mask"
    sizes = np.bincount(comp.ravel())
    candidates = [i for i in range(1, n) if sizes[i] * px_m ** 2 >= min_m2]
    if not candidates:
        return "only small structures were found (sheds or fragments), not a house"
    if seed_rc is None:
        pick = max(candidates, key=lambda i: sizes[i])
        return comp == pick, {"how": "largest building (no tap)", "tap_distance_m": None}

    r, c = seed_rc
    if 0 <= r < comp.shape[0] and 0 <= c < comp.shape[1] and comp[r, c] in candidates:
        return comp == comp[r, c], {"how": "tap on the roof", "tap_distance_m": 0.0}

    # The tap missed every roof. Snap only when one roof is clearly the one
    # meant: close, and not in a near-tie with another.
    dists = []
    for i in candidates:
        rr, cc = np.nonzero(comp == i)
        d = float(np.min((rr - r) ** 2 + (cc - c) ** 2)) ** 0.5 * px_m
        dists.append((d, i))
    dists.sort()
    d1, pick = dists[0]
    if d1 > SNAP_M:
        return (f"the tap is {d1:.0f} m from the nearest roof — tap directly on the "
                "house to measure it")
    if len(dists) > 1 and dists[1][0] - d1 < AMBIGUOUS_M:
        return ("two roofs are about equally close to the tap — tap directly on the "
                "house you mean")
    return comp == pick, {"how": "snapped to the nearest roof", "tap_distance_m": round(d1, 2)}


def _attached_suspected(bldg, px_m) -> bool:
    """Row houses and duplexes: one roof, several homes."""
    area = float(bldg.sum()) * px_m ** 2
    cnts, _ = cv2.findContours(bldg.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return False
    (_, _), (w, h), _ = cv2.minAreaRect(max(cnts, key=cv2.contourArea))
    aspect = max(w, h) / max(1.0, min(w, h))
    return area > ATTACHED_M2 or (aspect > ATTACHED_ASPECT and area > 150.0)


LOWER_ROOF_M = 0.30         # a patch this far BELOW its facet's plane is a separate, lower roof
POOR_FIT_RMS_M = 0.10       # a "facet" its own plane explains this badly is several roofs
SPLIT_INLIER_M = 0.12       # RANSAC: a pixel this close to a plane lies on it
SPLIT_MIN_M2 = 2.0          # smallest roof the splitter will create
SPLIT_MAX_PITCH = 2.5       # rise/run; steeper "planes" are walls and tree edges (30/12)
SPLIT_MIN_WIDTH_M = 1.0     # a grown region narrower than this is a wall smeared by the DSM


def _dissolve_thin(labels, planes, px_m):
    """Hand strips narrower than SPLIT_MIN_WIDTH_M back to their neighbours.

    Where a lower roof meets a higher one the DSM blurs the wall between them
    into a ramp ~1 m wide, and region growing makes that ramp a "facet" of its
    own (13/12 on a 6/12 roof, in the porch test). It used to vanish only
    because the whole porch was merged into the main slope. Returns the new
    labels and the ids removed."""
    labels = labels.copy()
    half = max(1, int(round(SPLIT_MIN_WIDTH_M / 2 / px_m)))
    kernel = np.ones((3, 3), np.uint8)
    gone = set()
    for fid in planes:
        sel = labels == fid
        if sel.any() and not cv2.erode(sel.astype(np.uint8), kernel, iterations=half).any():
            labels[sel] = UNASSIGNED
            gone.add(fid)
    return labels, gone


def _ransac_planes(dsm, region, px_m, start_id):
    """Carve `region` into planar roofs by their HEIGHTS: repeatedly take the
    plane that the largest connected patch lies on, then remove it.

    Region growing works from surface normals, and on roofs of a few square
    metres those are too noisy to group (Brookside Oaks' south porch roofs
    grew into nothing at any angle tolerance). Heights themselves are good to
    ~5 cm, so planes fitted to them directly are reliable at that scale.
    Deterministic: a fixed seed, so the same data always measures the same."""
    rng = np.random.default_rng(0)
    out = np.full(region.shape, UNASSIGNED, np.int32)
    left = region.copy()
    min_px = int(SPLIT_MIN_M2 / px_m ** 2)
    nid = start_id
    near = max(3, int(1.5 / px_m))
    for _ in range(8):
        rr, cc = np.nonzero(left)
        if len(rr) < min_px:
            break
        x, y, z = cc * px_m, rr * px_m, dsm[rr, cc]
        # Triples drawn close together, so each hypothesis is one LOCAL plane.
        i0 = rng.integers(0, len(rr), 600)
        pick = []
        for i in i0:
            d = np.abs(rr - rr[i]) + np.abs(cc - cc[i])
            cand = np.nonzero((d > 2) & (d < near))[0]
            if len(cand) >= 2:
                j, k = rng.choice(cand, 2, replace=False)
                pick.append((i, j, k))
        if not pick:
            break
        P = np.array(pick)
        A = np.stack([x[P], y[P], np.ones(P.shape)], axis=2)
        ok = np.abs(np.linalg.det(A)) > 1e-9
        A, Z = A[ok], z[P][ok]
        coef = np.linalg.solve(A, Z[..., None])[..., 0]
        coef = coef[np.hypot(coef[:, 0], coef[:, 1]) < SPLIT_MAX_PITCH]
        if not len(coef):
            break
        score = (np.abs(z[None, :] - (coef[:, :1] * x + coef[:, 1:2] * y + coef[:, 2:])) < SPLIT_INLIER_M).sum(1)
        best = None
        for ci in np.argsort(-score)[:12]:            # a few best by count, judged by connectivity
            a, b, c = coef[ci]
            inl = np.zeros_like(left)
            inl[rr, cc] = np.abs(z - (a * x + b * y + c)) < SPLIT_INLIER_M
            n, comp, stats, _ = cv2.connectedComponentsWithStats(inl.astype(np.uint8), connectivity=4)
            if n < 2:
                continue
            k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
            if best is None or stats[k, cv2.CC_STAT_AREA] > best[0]:
                best = (int(stats[k, cv2.CC_STAT_AREA]), comp == k)
        if best is None or best[0] < min_px:
            break
        patch = best[1]
        # Close pinholes and drop hairline attachments before claiming it.
        patch = cv2.morphologyEx(patch.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
        patch &= left
        if patch.sum() < min_px:
            break
        out[patch] = nid
        left &= ~patch
        nid += 1
    return out


def _split_lower_roofs(dsm, normals, curvature, labels, planes, px_m, bldg):
    """Peel lower attached roofs out of the facets that swallowed them.

    Region growing groups pixels by the direction they face. A porch roof or a
    bump-out that slopes the same way as the main roof, but sits a metre or two
    lower, therefore joins the main facet. Brookside Oaks lost four of its nine
    roofs this way: 19% of one main facet sat more than 30 cm BELOW its own
    plane, the main slopes came out 13-35% too large, and every eave, rake,
    ridge and step-flashing line of the swallowed roofs vanished (perimeter
    27% short against EagleView).

    A real plane explains its pixels to ~5 cm. So:
      * a well-fitting facet gives up the sizeable patches lying well BELOW its
        plane (patches above are chimneys, dormers, branches — the robust fit
        already ignores those);
      * a facet that fits badly overall is several roofs, and is re-carved.
    Each piece is then split into planes by _ransac_planes."""
    H, W = labels.shape
    cols, rows = np.meshgrid(np.arange(W), np.arange(H))
    min_px = int(SPLIT_MIN_M2 / px_m ** 2)
    kernel = np.ones((3, 3), np.uint8)
    labels = labels.copy()
    nid = (max(planes) + 1) if planes else 0
    split = False
    for fid, pl in sorted(planes.items()):
        sel = labels == fid
        if not sel.any():
            continue
        if pl[3] > POOR_FIT_RMS_M:
            pieces = [sel]
        else:
            zp = pl[0] * cols * px_m + pl[1] * rows * px_m + pl[2]
            below = sel & ((dsm - zp) < -LOWER_ROOF_M)
            # Opening removes speckle and thin seams along creases.
            below = cv2.morphologyEx(below.astype(np.uint8), cv2.MORPH_OPEN, kernel, iterations=2) > 0
            n, comp = cv2.connectedComponents(below.astype(np.uint8), connectivity=4)
            pieces = [comp == i for i in range(1, n) if (comp == i).sum() >= min_px]
        for piece in pieces:
            carved = _ransac_planes(dsm, piece, px_m, nid)
            got = carved >= nid
            if not got.any():
                continue
            if piece is sel and len(np.unique(carved[got])) < 2:
                continue                      # one plane after all: leave it be
            labels[piece] = UNASSIGNED
            labels[got] = carved[got]
            nid = int(carved.max()) + 1
            split = True
    return labels, split


def _surface_normals(dsm, bldg, px_m):
    """Unit normals from heights smoothed ONLY within the building, so the
    ground beyond the eaves never bleeds into the roof's slope."""
    w = bldg.astype(np.float64)
    z = np.where(bldg, dsm, 0.0)
    num = cv2.GaussianBlur(z, (0, 0), SMOOTH_SIGMA_PX)
    den = cv2.GaussianBlur(w, (0, 0), SMOOTH_SIGMA_PX)
    zs = np.where(den > 1e-6, num / np.maximum(den, 1e-6), 0.0)
    gy, gx = np.gradient(zs, px_m)
    n = np.dstack([-gx, -gy, np.ones_like(gx)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    curvature = np.abs(cv2.Laplacian(zs, cv2.CV_64F))
    return n, curvature


def _grow_planes(normals, curvature, bldg, px_m, start_id: int = 0):
    """Region growing: start from the flattest pixels, absorb neighbours that
    face the same way as the region so far. Crease pixels, whose normals are a
    blend of two planes, are left for later."""
    H, W = bldg.shape
    labels = np.full((H, W), OUTSIDE, dtype=np.int32)
    labels[bldg] = UNASSIGNED
    cos_tol = math.cos(math.radians(GROW_ANGLE_DEG))
    min_px = max(1, int(MIN_FACET_M2 / px_m ** 2))
    kernel = np.ones((3, 3), np.uint8)

    rr, cc = np.nonzero(bldg)
    order = np.argsort(curvature[rr, cc], kind="stable")
    nid = start_id
    nx, ny, nz = normals[..., 0], normals[..., 1], normals[..., 2]
    for k in order:
        r0, c0 = int(rr[k]), int(cc[k])
        if labels[r0, c0] != UNASSIGNED:
            continue
        sx, sy, sz = nx[r0, c0], ny[r0, c0], nz[r0, c0]
        labels[r0, c0] = nid
        members = [(r0, c0)]
        q = deque([(r0, c0)])
        while q:
            r, c = q.popleft()
            norm = math.sqrt(sx * sx + sy * sy + sz * sz)
            mx, my, mz = sx / norm, sy / norm, sz / norm
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                a, b = r + dr, c + dc
                if 0 <= a < H and 0 <= b < W and labels[a, b] == UNASSIGNED:
                    if nx[a, b] * mx + ny[a, b] * my + nz[a, b] * mz >= cos_tol:
                        labels[a, b] = nid
                        sx += nx[a, b]; sy += ny[a, b]; sz += nz[a, b]
                        members.append((a, b))
                        q.append((a, b))
        region = labels == nid
        thin = not cv2.erode(region.astype(np.uint8), kernel, iterations=THIN_ERODE_PX).any()
        if len(members) < min_px or thin:
            labels[region] = PARKED                # not a facet, and not a seed again
        else:
            nid += 1
    # Only the parked pixels go back to the pool. OUTSIDE is also negative, and
    # sweeping it up with them handed the lawn to the roof planes.
    labels[labels == PARKED] = UNASSIGNED
    return labels


INLIER_M = 0.15              # a pixel this far off its plane is an object ON the roof


def _robust_plane(x, y, z):
    """Plane through the roof SURFACE, ignoring what sits on it.

    A dormer, a vent stack or an overhanging branch is a block of pixels well
    off the slope. Fitted naively they tilt the plane — Buch Ave's east wing
    came out facing 213 deg instead of south, which turned its eave into a
    "rake" and its ridge into a "hip". So: fit, keep pixels within 15 cm (the
    DSM itself is good to ~5 cm), refit, a few times. Returns
    (a, b, c, rms_of_inliers, inlier_fraction)."""
    A = np.column_stack([x, y, np.ones_like(x)])
    keep = np.ones(len(z), bool)
    coef, *_ = np.linalg.lstsq(A, z, rcond=None)
    for _ in range(5):
        res = z - A @ coef
        new_keep = np.abs(res) < max(INLIER_M, 0.5 * float(np.median(np.abs(res))) * 3)
        if new_keep.sum() < max(3, 0.5 * len(z)) or np.array_equal(new_keep, keep):
            break
        keep = new_keep
        coef, *_ = np.linalg.lstsq(A[keep], z[keep], rcond=None)
    res = (z - A @ coef)[keep]
    rms = float(np.sqrt(np.mean(res ** 2))) if len(res) else 0.0
    return float(coef[0]), float(coef[1]), float(coef[2]), rms, float(keep.mean())


def _fit_planes(dsm, labels, px_m):
    """A robust plane per region: see _robust_plane."""
    planes = {}
    H, W = labels.shape
    cols, rows = np.meshgrid(np.arange(W), np.arange(H))
    for fid in np.unique(labels):
        if fid < 0:
            continue
        sel = labels == fid
        if sel.sum() < 3:
            continue
        a, b, c, rms, _ = _robust_plane(cols[sel] * px_m, rows[sel] * px_m, dsm[sel])
        planes[int(fid)] = (a, b, c, rms)
    return planes

MERGE_RMS_M = 0.12          # one plane explaining both halves this well means one facet
MERGE_MAX_ANGLE_DEG = 40.0  # never merge across a real ridge or valley
STEP_GAP_M = 0.15           # planes this far apart where they meet are two levels, not one slope


def _merge_coplanar(dsm, labels, planes, px_m):
    """Join neighbouring facets that one plane explains as well as two.

    A dormer or a skylight in the middle of a slope bends the fitted surface
    either side of it, and region growing then splits one real facet into two
    tilted halves. Their shared "crease" is typed a hip, and the tilt makes the
    eave below them read as a sloped rake. Buch Ave's east wing did exactly
    this. The test is a plain one: fit a single plane to both, robustly, and
    merge if it fits about as well as each half did."""
    labels = labels.copy()
    H, W = labels.shape
    cols, rows = np.meshgrid(np.arange(W), np.arange(H))
    changed = True
    while changed:
        changed = False
        shared: dict[tuple[int, int], int] = {}
        jump: dict[tuple[int, int], list[float]] = {}
        where: dict[tuple[int, int], list[tuple[int, int]]] = {}
        for (dr, dc) in ((0, 1), (1, 0)):
            A = labels[: H - dr, : W - dc]; B = labels[dr:, dc:]
            sel = (A >= 0) & (B >= 0) & (A != B)
            zA = dsm[: H - dr, : W - dc][sel]; zB = dsm[dr:, dc:][sel]
            rs, cs = np.nonzero(sel)
            for a_, b_, za, zb, r_, c_ in zip(A[sel].tolist(), B[sel].tolist(), zA.tolist(), zB.tolist(),
                                              rs.tolist(), cs.tolist()):
                k = (min(a_, b_), max(a_, b_))
                shared[k] = shared.get(k, 0) + 1
                jump.setdefault(k, []).append(abs(za - zb))
                where.setdefault(k, []).append((r_, c_))
        # Only facets sharing a real edge. Two pieces of one slope either side
        # of a wing touch at a single pixel where they narrow to nothing; merged,
        # they became one facet made of two separate shapes.
        pairs = [k for k, n in shared.items() if n * px_m >= 1.0]
        best = None
        for ia, ib in pairs:
            if ia not in planes or ib not in planes:
                continue
            na = np.array([-planes[ia][0], -planes[ia][1], 1.0])
            nb = np.array([-planes[ib][0], -planes[ib][1], 1.0])
            ang = math.degrees(math.acos(min(1.0, float(na @ nb) / (np.linalg.norm(na) * np.linalg.norm(nb)))))
            if ang > MERGE_MAX_ANGLE_DEG:
                continue
            # Two pieces of one slope meet at the same height; a lower roof
            # tucked under an eave does not, however well one tilted plane
            # might split the difference between them.
            wr, wc = np.array(where[(ia, ib)]).T
            gap = float(np.median(np.abs(_plane_z(planes[ia], wr, wc, px_m) - _plane_z(planes[ib], wr, wc, px_m))))
            if gap > STEP_GAP_M:
                continue
            sel = (labels == ia) | (labels == ib)
            a_, b_, c_, rms, frac = _robust_plane(cols[sel] * px_m, rows[sel] * px_m, dsm[sel])
            # Each half must lie on the joint plane, not just the pair overall: a
            # porch roof a metre below a big main slope is only ~15% of their
            # pixels, so "75% of the pair fits" merged it straight back in.
            # Judged on the half's own SURFACE (pixels on its own plane), so a
            # dormer standing on one half — Buch Ave's east wing — does not
            # count against rejoining the two halves of one slope.
            small = ia if (labels == ia).sum() <= (labels == ib).sum() else ib
            ss = labels == small
            ps = planes[small]
            xs, ys, zs = cols[ss] * px_m, rows[ss] * px_m, dsm[ss]
            own = np.abs(zs - (ps[0] * xs + ps[1] * ys + ps[2])) < INLIER_M
            if own.sum() >= 3:
                joint = np.abs(zs - (a_ * xs + b_ * ys + c_)) < max(INLIER_M, 2 * rms)
                if float(joint[own].mean()) < 0.75:
                    continue
            worse = max(planes[ia][3], planes[ib][3])
            # One plane must explain both halves about as well as each alone did,
            # using most of their pixels (not just a sliver that happens to fit).
            # EXCEPT two sections that are plainly one slope: facing the same way
            # (within 6 deg) with no height step between them. A roof with a slight
            # sag or a later addition built to the same line split into two facets
            # on Ryan's Wilmington test — 9 cm apart, one plane fitting both to
            # 7 cm — and left a zig-zag "unlabeled" line between them.
            same_slope = ang < 6.0 and float(np.median(jump.get((ia, ib), [1.0]))) < 0.15
            fits = rms <= max(MERGE_RMS_M, 1.15 * worse)
            if fits and (frac >= 0.75 or same_slope) and (best is None or rms < best[0]):
                best = (rms, ia, ib)
        if best:
            _, ia, ib = best
            labels[labels == ib] = ia
            planes = _fit_planes(dsm, labels, px_m)
            changed = True
    return labels, planes


def _plane_z(plane, rows, cols, px_m):
    a, b, c = plane[:3]
    return a * cols * px_m + b * rows * px_m + c


def _neighbour_views(arr, fill):
    """The four 4-connected neighbours of every pixel, as shifted arrays."""
    up = np.full_like(arr, fill); up[1:] = arr[:-1]
    dn = np.full_like(arr, fill); dn[:-1] = arr[1:]
    lf = np.full_like(arr, fill); lf[:, 1:] = arr[:, :-1]
    rt = np.full_like(arr, fill); rt[:, :-1] = arr[:, 1:]
    return up, dn, lf, rt


def _residual_to(dsm, lab, planes, px_m):
    """|height - plane height| for each pixel against the plane labelled in
    `lab` (inf where lab is not a facet)."""
    H, W = lab.shape
    rows, cols = np.mgrid[0:H, 0:W]
    out = np.full((H, W), np.inf)
    for fid, pl in planes.items():
        sel = lab == fid
        if sel.any():
            out[sel] = np.abs(dsm[sel] - _plane_z(pl, rows[sel], cols[sel], px_m))
    return out


def _assign_remaining(dsm, labels, bldg, planes, px_m, max_iter=400):
    """Hand each leftover building pixel to the adjacent plane that best
    explains its height, growing inward from the facets' edges."""
    labels = labels.copy()
    labels[(labels >= 0) & ~np.isin(labels, list(planes))] = UNASSIGNED
    for _ in range(max_iter):
        todo = labels == UNASSIGNED
        if not todo.any():
            break
        best_res = np.full(labels.shape, np.inf)
        best_lab = np.full(labels.shape, UNASSIGNED, dtype=np.int32)
        for nb in _neighbour_views(labels, OUTSIDE):
            cand = np.where((nb >= 0) & todo, nb, UNASSIGNED)
            res = _residual_to(dsm, cand, planes, px_m)
            better = res < best_res
            best_res[better] = res[better]
            best_lab[better] = cand[better]
        grab = todo & (best_lab >= 0)
        if not grab.any():
            break
        labels[grab] = best_lab[grab]
    return labels


def _sharpen_creases(dsm, labels, bldg, planes, px_m, passes=4):
    """Move each boundary pixel to whichever neighbouring plane fits its height
    best. Smoothing and blended normals leave a crease a pixel or two out of
    place; this walks it onto the true intersection line, which is where the
    ridge, hip and valley lengths are measured."""
    labels = labels.copy()
    for _ in range(passes):
        best_res = _residual_to(dsm, labels, planes, px_m)
        best_lab = labels.copy()
        for nb in _neighbour_views(labels, OUTSIDE):
            cand = np.where((nb >= 0) & bldg & (nb != labels), nb, UNASSIGNED)
            res = _residual_to(dsm, cand, planes, px_m)
            better = res < best_res - 1e-9
            best_res[better] = res[better]
            best_lab[better] = cand[better]
        changed = (best_lab != labels) & bldg
        if not changed.any():
            break
        labels[changed] = best_lab[changed]
    return labels


def _facets(dsm, labels, planes, px_m):
    out = []
    for fid, (a, b, c, rms) in sorted(planes.items()):
        sel = labels == fid
        n = int(sel.sum())
        if n * px_m ** 2 < MIN_FACET_M2:
            continue
        grad = math.hypot(a, b)
        slope = math.atan(grad)
        plan = n * px_m ** 2
        # Downslope in (east, south) is (-a, -b); north component is +b.
        az = (math.degrees(math.atan2(-a, b)) + 360.0) % 360.0 if grad > 1e-3 else 0.0
        cnts, _ = cv2.findContours(sel.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        poly = []
        if cnts:
            cnt = max(cnts, key=cv2.contourArea)
            approx = cv2.approxPolyDP(cnt, SIDE_TOL_M / px_m, True)
            poly = _outward_offset(_regularize(cnt, approx), 0.5)
        out.append(Facet(fid, round(plan, 3), round(plan * math.sqrt(1 + grad * grad), 3),
                         round(math.degrees(slope), 2), round(12 * grad, 2), round(az, 1),
                         (a, b, c), round(rms, 4), poly))
    return out


def _regularize(cnt, approx) -> list[tuple[float, float]]:
    """Straight sides through the boundary, not chords between its corners.

    A simplified outline joins corner points of the pixel boundary. With a
    coarse tolerance it cuts corners (Buch Ave lost ~1% of its area); with a
    fine one it follows the pixel staircase along any edge not square to the
    grid (a house at 38 deg read its eaves 6% long). Instead: keep the coarse
    outline for WHERE the sides are, fit a least-squares line through every
    boundary pixel belonging to each side, and put each corner where two
    neighbouring fitted lines meet."""
    C = cnt.reshape(-1, 2).astype(np.float64)
    A = approx.reshape(-1, 2).astype(np.float64)
    n = len(A)
    if n < 3:
        return [(float(x), float(y)) for x, y in A]
    # Where each simplified corner sits in the full boundary.
    idx = [int(np.argmin(np.sum((C - a) ** 2, axis=1))) for a in A]
    N = len(C)
    fits = []
    for i in range(n):
        i0, i1 = idx[i], idx[(i + 1) % n]
        seg = C[i0:i1 + 1] if i1 >= i0 else np.vstack([C[i0:], C[:i1 + 1]])
        m = len(seg)
        core = seg[int(m * 0.1): max(int(m * 0.9), int(m * 0.1) + 2)] if m >= 8 else seg
        c = core.mean(axis=0)
        if len(core) >= 2:
            _, _, vt = np.linalg.svd(core - c)
            d = vt[0]
        else:
            d = (A[(i + 1) % n] - A[i]); d = d / (np.linalg.norm(d) or 1.0)
        fits.append((c, d))
    out = []
    for i in range(n):
        (c1, d1), (c2, d2) = fits[i - 1], fits[i]
        den = d1[0] * d2[1] - d1[1] * d2[0]
        if abs(den) < 0.17:                        # sides within ~10 deg of parallel
            out.append((float(A[i][0]), float(A[i][1])))
            continue
        t = ((c2[0] - c1[0]) * d2[1] - (c2[1] - c1[1]) * d2[0]) / den
        x = c1 + d1 * t
        # A runaway intersection (very acute corner) keeps the original point.
        if float(np.hypot(*(x - A[i]))) > 15:
            out.append((float(A[i][0]), float(A[i][1])))
        else:
            out.append((float(x[0]), float(x[1])))
    return out


def _outward_offset(poly: list[tuple[float, float]], d: float) -> list[tuple[float, float]]:
    """Push every side of a polygon out by `d` pixels.

    OpenCV traces a region through the CENTRES of its boundary pixels, half a
    pixel inside the region's real edge. Left alone, every side comes out a
    pixel short and two facets sharing a crease each stop half a pixel short of
    it. Offsetting by half a pixel puts outside edges on the real boundary and
    both sides of a crease on the same line."""
    n = len(poly)
    if n < 3:
        return poly
    P = np.array(poly, dtype=np.float64)
    area2 = float(np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1]))
    sign = 1.0 if area2 > 0 else -1.0
    normals = []
    for i in range(n):
        s = P[(i + 1) % n] - P[i]
        ln = float(np.hypot(*s)) or 1.0
        normals.append(sign * np.array([s[1], -s[0]]) / ln)
    out = []
    for i in range(n):
        n_prev, n_next = normals[i - 1], normals[i]
        m = n_prev + n_next
        c = float(np.dot(m, n_next))
        # Corner moves along the bisector far enough to shift both sides by d;
        # near-straight corners reduce to a plain shift along the normal.
        out.append(tuple(P[i] + (m * d / c if abs(c) > 1e-3 else n_next * d)))
    return out


def _facet_edges(f: Facet, labels, planes, px_m) -> list[Edge]:
    """Walk the facet's outline and, point by point along each side, ask what is
    across it. A side is split wherever the answer changes: one straight ridge
    can have two different facets on its far side (a wing's roof interrupting
    the slope), and treating the whole side as bordering only one of them
    double-counts that ridge."""
    H, W = labels.shape
    poly = f.polygon_px
    if len(poly) < 3:
        return []
    cnt = np.array(poly, dtype=np.float32).reshape(-1, 1, 2)
    a, b = f.plane[0], f.plane[1]
    edges = []
    for i in range(len(poly)):
        p0, p1 = np.array(poly[i]), np.array(poly[(i + 1) % len(poly)])
        seg = p1 - p0
        plan_px = float(np.hypot(*seg))
        if plan_px < 2:
            continue
        u = seg / plan_px
        normal = np.array([-u[1], u[0]])
        mid = (p0 + p1) / 2
        if cv2.pointPolygonTest(cnt, (float(mid[0] + normal[0] * 2), float(mid[1] + normal[1] * 2)), False) > 0:
            normal = -normal                       # make it point OUT of the facet

        # One sample per pixel along the side: who is across the line here?
        steps = max(4, int(plan_px))
        ts = (np.arange(steps) + 0.5) / steps
        across = []
        for t in ts:
            p = p0 + seg * t + normal * 2.0
            c_, r_ = int(round(p[0])), int(round(p[1]))
            lab = int(labels[r_, c_]) if (0 <= r_ < H and 0 <= c_ < W) else OUTSIDE
            across.append(lab if lab >= 0 else OUTSIDE)
        # Samples that land back on this facet (a corner) or on a sliver shorter
        # than half a metre take the neighbour of the run beside them.
        runs = _runs(across, f.id, min_len=max(3, int(0.5 / px_m)))
        for nb, j0, j1 in runs:
            q0 = p0 + seg * (j0 / steps)
            q1 = p0 + seg * (j1 / steps)
            edges.append(_classify(f, nb, q0, q1, normal, planes, px_m))
    return edges


def _runs(across: list[int], self_id: int, min_len: int) -> list[tuple[int, int, int]]:
    """Collapse per-sample neighbours into (neighbour, start, end) runs."""
    vals = [v for v in across]
    # Fill samples that point back into the facet from the nearest real value.
    last = None
    for i, v in enumerate(vals):
        if v == self_id:
            vals[i] = last
        else:
            last = v
    nxt = None
    for i in range(len(vals) - 1, -1, -1):
        if vals[i] is None:
            vals[i] = nxt
        else:
            nxt = vals[i]
    if all(v is None for v in vals):
        return []
    runs: list[list] = []
    for i, v in enumerate(vals):
        if runs and runs[-1][0] == v:
            runs[-1][2] = i + 1
        else:
            runs.append([v, i, i + 1])
    # Absorb slivers into the longer neighbouring run.
    changed = True
    while changed and len(runs) > 1:
        changed = False
        for k, (v, s, e) in enumerate(runs):
            if e - s < min_len:
                left = runs[k - 1] if k > 0 else None
                right = runs[k + 1] if k + 1 < len(runs) else None
                tgt = max((r for r in (left, right) if r), key=lambda r: r[2] - r[1])
                tgt[1], tgt[2] = min(tgt[1], s), max(tgt[2], e)
                runs.pop(k)
                changed = True
                break
        merged = []
        for r in runs:
            if merged and merged[-1][0] == r[0]:
                merged[-1][2] = r[2]
            else:
                merged.append(r)
        runs = merged
    return [(int(v), s, e) for v, s, e in runs]


def _outer_kind(plane, direction) -> str:
    """Eave or rake for a line on a roof's outer edge, by DIRECTION.

    An eave runs across the slope; a rake runs down it. Deciding by whether the
    line is level failed on real roofs: on a 10/12 wing, an eave traced along
    a slightly wobbly edge (trees over the north side) climbs enough to read
    as sloped, and 22 ft of Buch Ave's eave was called rake."""
    a, b = plane[0], plane[1]
    g = math.hypot(a, b)
    if g < 0.05:
        return "eave"                         # near-flat: every edge is an eave
    down = np.array([-a, -b]) / g             # downslope, plan view (east, south)
    d = np.asarray(direction, dtype=np.float64)
    d = d / (np.linalg.norm(d) or 1.0)
    return "rake" if abs(float(down @ d)) > math.cos(math.radians(45)) else "eave"


CORNER_STUB_M = 1.0         # an outside piece shorter than this is a corner, not a line of its own


def _absorb_corner_stubs(kinds: list[str], lengths: list[float], outside: list[bool]) -> list[str]:
    """A finely traced outline cuts each corner with a short diagonal. Typed
    on its own, the one at a hip roof's corner reads as ~1 m of "rake" on a
    roof that has none. A corner piece takes the type of the longer outside
    line beside it."""
    n = len(kinds)
    out = list(kinds)
    for i in range(n):
        if not outside[i] or lengths[i] >= CORNER_STUB_M:
            continue
        nbrs = [j for j in ((i - 1) % n, (i + 1) % n) if outside[j] and lengths[j] >= CORNER_STUB_M]
        if nbrs:
            out[i] = kinds[max(nbrs, key=lambda j: lengths[j])]
    return out


def _classify(f: Facet, nb: int, q0, q1, normal, planes, px_m) -> Edge:
    """What kind of line is this, from what the heights do either side of it."""
    a, b = f.plane[0], f.plane[1]
    z0 = _plane_z(f.plane, q0[1], q0[0], px_m)
    z1 = _plane_z(f.plane, q1[1], q1[0], px_m)
    plan_m = float(np.hypot(*(q1 - q0))) * px_m
    length_m = math.hypot(plan_m, z1 - z0)
    level = plan_m > 0 and abs(z1 - z0) / plan_m < LEVEL_RISE_PER_RUN
    if nb == OUTSIDE:
        kind, neighbour = _outer_kind(f.plane, q1 - q0), None
    else:
        neighbour = nb
        other = planes[nb]
        mid = (q0 + q1) / 2
        zm_self = _plane_z(f.plane, mid[1], mid[0], px_m)
        zm_other = _plane_z(other, mid[1], mid[0], px_m)
        if abs(zm_self - zm_other) > STEP_M:
            kind = "wall_intersection"
        else:
            # Height change per metre going INTO each facet from the line.
            into_self = -(a * normal[0] + b * normal[1])
            into_other = other[0] * normal[0] + other[1] * normal[1]
            if into_self < 0 and into_other < 0:
                kind = "ridge" if level else "hip"
            elif into_self > 0 and into_other > 0:
                kind = "valley"
            else:
                kind = "unlabeled"           # a pitch change; let the contractor say
    return Edge(kind, f.id, neighbour, (float(q0[0]), float(q0[1])),
                (float(q1[0]), float(q1[1])), round(plan_m, 3), round(length_m, 3))


CREASE_MAX_OFFSET_M = 0.6   # boundary pixels further than this from the exact line are noise
CREASE_GAP_M = 1.0          # a gap this long splits one plane pair into two separate lines
CREASE_MIN_M = 0.4          # shorter crease segments are corners, not lines
PARALLEL_DEG = 4.0          # planes this close to parallel do not form a crease


def _crease_edges(labels, planes, px_m, dsm=None) -> list[Edge]:
    """Ridges, hips and valleys as the exact intersection of two fitted planes.

    Where two facets meet, the pixel boundary between them zig-zags with every
    centimetre of noise in the height map, and measuring along it made a 16 m
    hip roof's ridge read 61% long. The planes themselves are fitted to
    thousands of pixels each and barely move with noise, and two planes meet in
    one exact line. So the line's position and direction come from the planes;
    only where it starts and stops comes from the pixels."""
    H, W = labels.shape
    pts: dict[tuple[int, int], list[tuple[float, float]]] = {}
    jumps: dict[tuple[int, int], list[float]] = {}
    # Every 4-adjacent pixel pair with two different facets marks the boundary.
    for (dr, dc) in ((0, 1), (1, 0)):
        A = labels[: H - dr, : W - dc]
        B = labels[dr:, dc:]
        sel = (A >= 0) & (B >= 0) & (A != B)
        rr, cc = np.nonzero(sel)
        zA = dsm[: H - dr, : W - dc][sel] if dsm is not None else np.zeros(len(rr))
        zB = dsm[dr:, dc:][sel] if dsm is not None else np.zeros(len(rr))
        for r, c, a_, b_, za, zb in zip(rr, cc, A[sel], B[sel], zA, zB):
            if a_ in planes and b_ in planes:
                key = (int(min(a_, b_)), int(max(a_, b_)))
                pts.setdefault(key, []).append((c + dc / 2.0, r + dr / 2.0))
                jumps.setdefault(key, []).append(abs(float(za) - float(zb)))

    edges: list[Edge] = []
    for (ia, ib), P in pts.items():
        pa, pb = planes[ia], planes[ib]
        na = np.array([-pa[0], -pa[1], 1.0]); nb_ = np.array([-pb[0], -pb[1], 1.0])
        cosang = abs(float(na @ nb_)) / (np.linalg.norm(na) * np.linalg.norm(nb_))
        P = np.array(P) * px_m                    # boundary points, metres (x east, y south)
        # A wall is a JUMP in height between neighbouring pixels; a crease is
        # continuous. Checked FIRST: a lower wing and the main slope above it
        # often face the same way, and skipping near-parallel pairs before this
        # check dropped Buch Ave's whole north tie-in line (~15 ft).
        if dsm is not None:
            is_step = float(np.median(jumps[(ia, ib)])) > STEP_M
        else:
            zA = pa[0] * P[:, 0] + pa[1] * P[:, 1] + pa[2]
            zB = pb[0] * P[:, 0] + pb[1] * P[:, 1] + pb[2]
            is_step = float(np.median(np.abs(zA - zB))) > STEP_M
        if not is_step and cosang > math.cos(math.radians(PARALLEL_DEG)):
            # Parallel planes cannot cross, so if they sit apart where they
            # meet, it is a step however gently the DSM has blurred it: a porch
            # roof 30 cm under the main eave reads as a 3 cm-per-pixel ramp.
            zA = pa[0] * P[:, 0] + pa[1] * P[:, 1] + pa[2]
            zB = pb[0] * P[:, 0] + pb[1] * P[:, 1] + pb[2]
            is_step = float(np.median(np.abs(zA - zB))) > STEP_GAP_M
        if is_step:
            edges.extend(_step_edges(P, ia, ib, pa, pb, px_m))
            continue
        if cosang > math.cos(math.radians(PARALLEL_DEG)):
            continue                              # same slope, same height: no crease
        # Plan-view line where the two planes are the same height:
        # (a_a - a_b) x + (b_a - b_b) y + (c_a - c_b) = 0
        da, db, dc_ = pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]
        nrm = math.hypot(da, db)
        if nrm < 1e-9:
            continue
        n2 = np.array([da, db]) / nrm             # unit normal of the plan line
        off = dc_ / nrm
        dist = P @ n2 + off                       # signed distance of each point from the line
        # A height step (a lower roof against a wall) is not an intersection at
        # all: the planes' shared line runs somewhere else entirely.
        near = np.abs(dist) < CREASE_MAX_OFFSET_M
        if near.sum() < 3:
            continue
        foot = P[near] - np.outer(dist[near], n2)  # project onto the exact line
        u = np.array([-n2[1], n2[0]])
        t = foot @ u
        order = np.sort(t)
        # Split into separate runs where the boundary has a real gap.
        cuts = np.nonzero(np.diff(order) > CREASE_GAP_M)[0]
        starts = np.concatenate([[0], cuts + 1]); ends = np.concatenate([cuts, [len(order) - 1]])
        base = -off * n2                          # a point on the line
        for s, e in zip(starts, ends):
            t0, t1 = float(order[s]), float(order[e])
            if t1 - t0 < CREASE_MIN_M:
                continue
            # Boundary pairs sit between pixel centres, so the run stops about a
            # pixel short of where the line really ends at each end.
            t0 -= px_m; t1 += px_m
            q0 = base + u * t0; q1 = base + u * t1
            z0 = pa[0] * q0[0] + pa[1] * q0[1] + pa[2]
            z1 = pa[0] * q1[0] + pa[1] * q1[1] + pa[2]
            plan_m = t1 - t0
            length_m = math.hypot(plan_m, z1 - z0)
            level = abs(z1 - z0) / plan_m < LEVEL_RISE_PER_RUN
            # Ridge/hip if the roof falls away on both sides of the line;
            # valley if it rises on both. Test a point half a metre to either
            # side, on each side's own plane.
            mid = (q0 + q1) / 2
            zm = pa[0] * mid[0] + pa[1] * mid[1] + pa[2]
            # Which side of the line is facet A on? Use A's own pixels.
            a_side = _side_of(labels, ia, n2, off, px_m, near_m=(float(mid[0]), float(mid[1])))
            pA = mid + n2 * 0.5 * a_side
            pB = mid - n2 * 0.5 * a_side
            zA_ = pa[0] * pA[0] + pa[1] * pA[1] + pa[2] - zm
            zB_ = pb[0] * pB[0] + pb[1] * pB[1] + pb[2] - zm
            if zA_ < 0 and zB_ < 0:
                kind = "ridge" if level else "hip"
            elif zA_ > 0 and zB_ > 0:
                kind = "valley"
            else:
                kind = "unlabeled"
            q0p, q1p = tuple(q0 / px_m), tuple(q1 / px_m)
            for f_, o_ in ((ia, ib), (ib, ia)):
                edges.append(Edge(kind, f_, o_, q0p, q1p, round(plan_m, 3), round(length_m, 3)))
    return edges


def _side_of(labels, fid, n2, off, px_m, near_m=None) -> int:
    """+1 if facet `fid` lies on the +n2 side of the plan line, else -1.

    Judged from the facet's pixels NEAR the line segment when a point is given.
    A large facet can wrap around a smaller one (a main slope running either
    side of a front gable), and the median of ALL its pixels then sits on the
    wrong side for one of the two valleys — which typed a valley as a hip."""
    rr, cc = np.nonzero(labels == fid)
    if len(rr) == 0:
        return 1
    if near_m is not None:
        mx, my = near_m
        close = (cc * px_m - mx) ** 2 + (rr * px_m - my) ** 2 < 1.5 ** 2
        if close.sum() >= 5:
            rr, cc = rr[close], cc[close]
    d = (cc * px_m) * n2[0] + (rr * px_m) * n2[1] + off
    return 1 if float(np.median(d)) >= 0 else -1


def _step_edges(P, ia, ib, pa, pb, px_m) -> list[Edge]:
    """Where a lower roof meets the wall of a higher one.

    That single line in plan is TWO lines on the house, needing two different
    materials: the upper roof's own edge (drip edge on a rake or an eave), and
    the lower roof running into the wall (step flashing). Aspen's Buch Ave
    report counts both, and counting only the wall under-read the rakes."""
    c = P.mean(axis=0)
    _, _, vt = np.linalg.svd(P - c)
    u = vt[0]
    t = (P - c) @ u
    plan_m = float(t.max() - t.min())
    if plan_m < CREASE_MIN_M:
        return []
    q0m = c + u * t.min(); q1m = c + u * t.max()
    q0 = q0m / px_m; q1 = q1m / px_m
    zA = pa[0] * c[0] + pa[1] * c[1] + pa[2]
    zB = pb[0] * c[0] + pb[1] * c[1] + pb[2]
    upper, uplane, lower = (ia, pa, ib) if zA >= zB else (ib, pb, ia)
    z0 = uplane[0] * q0m[0] + uplane[1] * q0m[1] + uplane[2]
    z1 = uplane[0] * q1m[0] + uplane[1] * q1m[1] + uplane[2]
    up_len = math.hypot(plan_m, z1 - z0)
    return [
        # The upper roof's edge: owned by that facet alone, like an outside edge.
        Edge(_outer_kind(uplane, q1m - q0m), upper, None, tuple(q0), tuple(q1),
             round(plan_m, 3), round(up_len, 3)),
        # The lower roof against the wall.
        Edge("wall_intersection", lower, upper, tuple(q0), tuple(q1),
             round(plan_m, 3), round(plan_m, 3)),
    ]


def _dedup_lengths(edges: list[Edge]) -> dict:
    """Each shared line is walked from both facets; count it once. Outside
    edges belong to one facet only and are summed as they are."""
    totals: dict[str, float] = {}
    shared: dict[tuple, dict[int, float]] = {}
    for e in edges:
        if e.neighbour is None:
            totals[e.kind] = totals.get(e.kind, 0.0) + e.length_m
        else:
            key = (min(e.facet, e.neighbour), max(e.facet, e.neighbour), e.kind)
            shared.setdefault(key, {})
            shared[key][e.facet] = shared[key].get(e.facet, 0.0) + e.length_m
    for (_, _, kind), sides in shared.items():
        totals[kind] = totals.get(kind, 0.0) + sum(sides.values()) / len(sides)
    return {k: round(v, 3) for k, v in totals.items()}


# ── Handing the result to the rest of Axis ───────────────────────────────
#
# Axis stores a roof the way a contractor traces it: each facet is an outline,
# and each EDGE IS ONE SIDE of that outline, tagged eave/rake/ridge/hip/valley.
# Every length on the report is then derived from those sides and the facet's
# pitch. So the engine's result is re-expressed as outlines whose sides ARE the
# lines: a vertex wherever the neighbour across the side changes, and vertices
# on shared creases snapped onto the exact plane-intersection line, so two
# facets sharing a ridge agree on precisely where it runs.

@dataclass
class AxisFacet:
    label: str
    fid: int
    vertices_px: list[tuple[float, float]]             # (col, row), pixel-centre coords
    sides: list[tuple[str, Optional[int]]]             # side i = vertex i -> i+1: (kind, neighbour fid)
    pitch_12: float


def _labels_seq(n: int) -> list[str]:
    out = []
    for i in range(n):
        s, k = "", i
        while True:
            s = chr(ord("A") + k % 26) + s
            k = k // 26 - 1
            if k < 0:
                break
        out.append(s)
    return out


def _project(p, a, b):
    """Closest point to p on the infinite line through a, b."""
    p, a, b = (np.asarray(v, dtype=np.float64) for v in (p, a, b))
    d = b - a
    dd = float(d @ d) or 1e-12
    return a + d * float((p - a) @ d) / dd


def _intersect(a1, a2, b1, b2):
    a1, a2, b1, b2 = (np.asarray(v, dtype=np.float64) for v in (a1, a2, b1, b2))
    da, db = a2 - a1, b2 - b1
    den = da[0] * db[1] - da[1] * db[0]
    if abs(den) < 1e-9:
        return None
    t = ((b1[0] - a1[0]) * db[1] - (b1[1] - a1[1]) * db[0]) / den
    return a1 + da * t


def axis_facets(model: RoofModel) -> list[AxisFacet]:
    """The engine's roof as Axis-style outlines, with every side typed."""
    if not model.available or model.labels is None:
        return []
    px_m = model.px_m
    labels = model.labels
    planes = {f.id: (*f.plane, f.rms_m) for f in model.facets}
    H, W = labels.shape

    # The exact line for every shared boundary, and what kind of line it is.
    lines: dict[tuple[int, int], tuple] = {}
    kinds: dict[tuple[int, int], dict[str, float]] = {}
    steps: dict[tuple[int, int], int] = {}              # pair -> the UPPER facet
    all_lines: dict[tuple[int, int], list] = {}
    for e in model.edges:
        if e.neighbour is None:
            continue
        k = (min(e.facet, e.neighbour), max(e.facet, e.neighbour))
        if e.kind == "wall_intersection":
            steps[k] = e.neighbour                      # emitted from the lower facet
        else:
            kinds.setdefault(k, {})
            kinds[k][e.kind] = kinds[k].get(e.kind, 0.0) + e.length_m
        # Keep the longest segment's line for snapping (and every segment, for
        # sides that sit nearer a shorter one).
        if k not in lines or e.plan_m > lines[k][2]:
            lines[k] = (np.array(e.p0), np.array(e.p1), e.plan_m)
        all_lines.setdefault(k, []).append((np.array(e.p0), np.array(e.p1)))
    pair_kind = {k: max(v, key=v.get) for k, v in kinds.items()}

    min_run = max(3, int(0.5 / px_m))
    out: list[AxisFacet] = []
    names = _labels_seq(len(model.facets))
    for name, f in zip(names, model.facets):
        poly = f.polygon_px
        if len(poly) < 3:
            continue
        cnt = np.array(poly, dtype=np.float32).reshape(-1, 1, 2)
        verts: list[np.ndarray] = []
        nbrs: list[Optional[int]] = []
        for i in range(len(poly)):
            p0, p1 = np.array(poly[i]), np.array(poly[(i + 1) % len(poly)])
            seg = p1 - p0
            L = float(np.hypot(*seg))
            if L < 1e-6:
                continue
            u = seg / L
            normal = np.array([-u[1], u[0]])
            mid = (p0 + p1) / 2
            if cv2.pointPolygonTest(cnt, (float(mid[0] + normal[0] * 2), float(mid[1] + normal[1] * 2)), False) > 0:
                normal = -normal
            steps_n = max(4, int(L))
            across = []
            for t in (np.arange(steps_n) + 0.5) / steps_n:
                q = p0 + seg * t + normal * 2.0
                c_, r_ = int(round(q[0])), int(round(q[1]))
                lab = int(labels[r_, c_]) if (0 <= r_ < H and 0 <= c_ < W) else OUTSIDE
                across.append(lab if (lab >= 0 and lab in planes) else OUTSIDE)
            runs = _runs(across, f.id, min_run) or [(OUTSIDE, 0, steps_n)]
            for nb, j0, _ in runs:
                verts.append(p0 + seg * (j0 / steps_n))
                nbrs.append(None if nb == OUTSIDE else nb)
        # Drop vertices closer than 15 cm to the previous one (and their side).
        keep_v, keep_n = [], []
        for v, n in zip(verts, nbrs):
            if keep_v and float(np.hypot(*(v - keep_v[-1]))) * px_m < 0.15:
                keep_n[-1] = keep_n[-1] if keep_n[-1] is not None else n
                continue
            keep_v.append(v); keep_n.append(n)
        # Merge consecutive sides with the same neighbour that are nearly collinear.
        if len(keep_v) < 3:
            continue

        # Snap vertices onto exact shared lines.
        n = len(keep_v)
        snapped = []
        for i in range(n):
            v = keep_v[i]
            prev_nb, next_nb = keep_n[i - 1], keep_n[i]
            cands = []
            for nb in {prev_nb, next_nb}:
                if nb is None:
                    continue
                k = (min(f.id, nb), max(f.id, nb))
                if k in lines:
                    cands.append(lines[k])
            new = v
            if len(cands) == 2:
                x = _intersect(cands[0][0], cands[0][1], cands[1][0], cands[1][1])
                if x is not None and float(np.hypot(*(x - v))) * px_m < 1.0:
                    new = x
                else:
                    new = _project(v, cands[0][0], cands[0][1])
            elif len(cands) == 1:
                # A crease is straight; a pixel boundary beside it wanders (a
                # merged, compromise plane put Wilmington's ridge up to 0.5 m
                # off in places, leaving a zig-zag "unlabeled" run). Pull any
                # vertex within a metre onto the nearest segment's line.
                nb_ = prev_nb if prev_nb is not None else next_nb
                k_ = (min(f.id, nb_), max(f.id, nb_))
                segs_ = all_lines.get(k_) or [(cands[0][0], cands[0][1])]
                projs = [_project(v, a_, b_) for a_, b_ in segs_]
                proj = min(projs, key=lambda q_: float(np.hypot(*(q_ - v))))
                if float(np.hypot(*(proj - v))) * px_m < 1.0:
                    new = proj
            snapped.append(new)

        # Snap onto crease ENDS too. Where a valley meets the eave, the traced
        # outline turns the corner in a few short stubs that border the next
        # facet without lying on the valley; typed by their neighbour they read
        # as extra valley, and because the two facets' stubs never coincide the
        # report could not de-duplicate them (Buch Ave: valleys +14%). Pulling
        # every nearby vertex onto the crease's exact end collapses the stubs.
        # Only a vertex that BORDERS a crease (a side on either side of it has
        # that crease's facet as its neighbour) may snap to the crease's ends;
        # otherwise outer corners near a ridge end got pulled inward, costing
        # eave and rake length and area.
        for i in range(n):
            ends = []
            for nb in {keep_n[i - 1], keep_n[i]}:
                if nb is None:
                    continue
                k = (min(f.id, nb), max(f.id, nb))
                if k in lines:
                    ends.extend([lines[k][0], lines[k][1]])
            best = None
            for q in ends:
                d = float(np.hypot(*(snapped[i] - q))) * px_m
                if d < 0.9 and (best is None or d < best[0]):
                    best = (d, q)
            if best:
                snapped[i] = np.array(best[1], dtype=np.float64)
        # Remove sides that collapsed (both ends on the same point).
        pts, nbs = [], []
        for i in range(n):
            if pts and float(np.hypot(*(snapped[i] - pts[-1]))) * px_m < 0.15:
                continue
            pts.append(snapped[i]); nbs.append(keep_n[i])
        if len(pts) >= 2 and float(np.hypot(*(pts[0] - pts[-1]))) * px_m < 0.15:
            pts.pop(); nbs.pop()
        # Merge consecutive sides with the same neighbour that run straight on.
        changed = True
        while changed and len(pts) > 3:
            changed = False
            for i in range(len(pts)):
                a_, b_, c_ = pts[i - 1], pts[i], pts[(i + 1) % len(pts)]
                if nbs[i - 1] != nbs[i]:
                    continue
                u1, u2 = b_ - a_, c_ - b_
                n1, n2 = np.hypot(*u1), np.hypot(*u2)
                if n1 < 1e-9 or n2 < 1e-9 or float(u1 @ u2) / (n1 * n2) > math.cos(math.radians(5)):
                    pts.pop(i); nbs.pop(i)
                    changed = True
                    break
        snapped, keep_n, n = pts, nbs, len(pts)
        if n < 3:
            continue

        # Type every side.
        sides: list[tuple[str, Optional[int]]] = []
        for i in range(n):
            a, b = snapped[i], snapped[(i + 1) % n]
            nb = keep_n[i]
            if nb is None:
                sides.append((_outer_kind(f.plane, b - a), None))
                continue
            k = (min(f.id, nb), max(f.id, nb))
            if k in steps:
                upper = steps[k]
                sides.append((_outer_kind(f.plane, b - a) if upper == f.id else "wall_intersection", nb))
            elif k in pair_kind:
                segs_ = all_lines.get(k) or [lines[k][:2]]
                on_line = any(all(float(np.hypot(*(np.asarray(v) - _project(v, q0, q1)))) * px_m < 0.35
                                  for v in (a, b)) for q0, q1 in segs_)
                sides.append((pair_kind[k], nb) if on_line else ("unlabeled", nb))
            else:
                sides.append(("unlabeled", nb))
        lens = [float(np.hypot(*(np.asarray(snapped[(i + 1) % n]) - np.asarray(snapped[i])))) * px_m
                for i in range(n)]
        ks = _absorb_corner_stubs([k for k, _ in sides], lens, [nb is None for _, nb in sides])
        sides = [(k, nb) for k, (_, nb) in zip(ks, sides)]
        out.append(AxisFacet(name, f.id, [(float(p[0]), float(p[1])) for p in snapped],
                             sides, f.pitch_12))
    return out
