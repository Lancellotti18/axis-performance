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
SIDE_TOL_M = 0.30           # facet outlines are simplified to within this


def extract_roof(dsm: np.ndarray, mask: np.ndarray, px_m: float,
                 seed_rc: Optional[tuple[int, int]] = None,
                 *, min_building_m2: float = 30.0) -> RoofModel:
    """Measure the roof of the building at `seed_rc` (the tapped house, as
    row/col in these arrays), or of the largest building if none is given."""
    dsm = np.asarray(dsm, dtype=np.float64)
    bldg = _select_building(np.asarray(mask, dtype=bool), px_m, seed_rc, min_building_m2)
    if isinstance(bldg, str):
        return RoofModel(False, bldg, px_m=px_m)

    normals, curvature = _surface_normals(dsm, bldg, px_m)
    labels = _grow_planes(normals, curvature, bldg, px_m)
    planes = _fit_planes(dsm, labels, px_m)
    if not planes:
        return RoofModel(False, "no roof plane large enough to measure was found", px_m=px_m)
    labels = _assign_remaining(dsm, labels, bldg, planes, px_m)
    labels = _sharpen_creases(dsm, labels, bldg, planes, px_m)
    planes = _fit_planes(dsm, labels, px_m)          # refit on the final regions

    facets = _facets(dsm, labels, planes, px_m)
    kept = {f.id for f in facets}
    edges = []
    for f in facets:
        # Outline sides: only the ones on the building's outside edge. Lines
        # between two facets come from _crease_edges, which does not trust the
        # noisy pixel boundary for where they are.
        edges.extend(e for e in _facet_edges(f, labels, planes, px_m) if e.neighbour is None)
    edges.extend(_crease_edges(labels, {k: v for k, v in planes.items() if k in kept}, px_m))
    lengths = _dedup_lengths(edges)

    plan = float(bldg.sum()) * px_m ** 2
    true = sum(f.true_m2 for f in facets)
    assigned = float((labels >= 0).sum()) / max(1.0, float(bldg.sum()))
    worst_rms = max((f.rms_m for f in facets), default=0.0)
    return RoofModel(
        True, None, px_m, facets, edges, round(plan, 2), round(true, 2), lengths,
        quality={"assigned_fraction": round(assigned, 4),
                 "worst_facet_rms_m": round(worst_rms, 3),
                 "facet_count": len(facets)},
        labels=labels,
    )


# ── Steps ────────────────────────────────────────────────────────────────

def _select_building(mask, px_m, seed_rc, min_m2):
    n, comp = cv2.connectedComponents(mask.astype(np.uint8), connectivity=8)
    if n <= 1:
        return "no roof pixels in the mask"
    sizes = np.bincount(comp.ravel())
    candidates = [i for i in range(1, n) if sizes[i] * px_m ** 2 >= min_m2]
    if not candidates:
        return "only small structures were found (sheds or fragments), not a house"
    if seed_rc is not None:
        r, c = seed_rc
        if 0 <= r < comp.shape[0] and 0 <= c < comp.shape[1] and comp[r, c] in candidates:
            pick = comp[r, c]
        else:
            # The tap landed just off the roof (a driveway, a shadow): take the
            # nearest building, but not one across the street.
            best, pick = None, None
            for i in candidates:
                rr, cc = np.nonzero(comp == i)
                d = float(np.min((rr - r) ** 2 + (cc - c) ** 2)) ** 0.5 * px_m
                if best is None or d < best:
                    best, pick = d, i
            if best is None or best > 8.0:
                return "no building within 8 m of the tapped point"
    else:
        pick = max(candidates, key=lambda i: sizes[i])
    return comp == pick


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


def _grow_planes(normals, curvature, bldg, px_m):
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
    nid = 0
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


def _fit_planes(dsm, labels, px_m):
    """Least-squares plane per region, refit once without outliers (a vent or
    a chimney poking up through the facet)."""
    planes = {}
    H, W = labels.shape
    cols, rows = np.meshgrid(np.arange(W), np.arange(H))
    for fid in np.unique(labels):
        if fid < 0:
            continue
        sel = labels == fid
        if sel.sum() < 3:
            continue
        x = cols[sel] * px_m
        y = rows[sel] * px_m
        z = dsm[sel]
        A = np.column_stack([x, y, np.ones_like(x)])
        coef, *_ = np.linalg.lstsq(A, z, rcond=None)
        res = z - A @ coef
        keep = np.abs(res) < max(0.10, 3 * res.std())
        if keep.sum() >= 3 and keep.sum() < len(z):
            coef, *_ = np.linalg.lstsq(A[keep], z[keep], rcond=None)
            res = z - A @ coef
        planes[int(fid)] = (float(coef[0]), float(coef[1]), float(coef[2]),
                            float(np.sqrt(np.mean(res[np.abs(res) < 0.5] ** 2)) if (np.abs(res) < 0.5).any() else 0.0))
    return planes


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
            poly = _outward_offset([(float(p[0][0]), float(p[0][1])) for p in approx], 0.5)
        out.append(Facet(fid, round(plan, 3), round(plan * math.sqrt(1 + grad * grad), 3),
                         round(math.degrees(slope), 2), round(12 * grad, 2), round(az, 1),
                         (a, b, c), round(rms, 4), poly))
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


def _classify(f: Facet, nb: int, q0, q1, normal, planes, px_m) -> Edge:
    """What kind of line is this, from what the heights do either side of it."""
    a, b = f.plane[0], f.plane[1]
    z0 = _plane_z(f.plane, q0[1], q0[0], px_m)
    z1 = _plane_z(f.plane, q1[1], q1[0], px_m)
    plan_m = float(np.hypot(*(q1 - q0))) * px_m
    length_m = math.hypot(plan_m, z1 - z0)
    level = plan_m > 0 and abs(z1 - z0) / plan_m < LEVEL_RISE_PER_RUN
    if nb == OUTSIDE:
        kind, neighbour = ("eave" if level else "rake"), None
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


def _crease_edges(labels, planes, px_m) -> list[Edge]:
    """Ridges, hips and valleys as the exact intersection of two fitted planes.

    Where two facets meet, the pixel boundary between them zig-zags with every
    centimetre of noise in the height map, and measuring along it made a 16 m
    hip roof's ridge read 61% long. The planes themselves are fitted to
    thousands of pixels each and barely move with noise, and two planes meet in
    one exact line. So the line's position and direction come from the planes;
    only where it starts and stops comes from the pixels."""
    H, W = labels.shape
    pts: dict[tuple[int, int], list[tuple[float, float]]] = {}
    # Every 4-adjacent pixel pair with two different facets marks the boundary.
    for (dr, dc) in ((0, 1), (1, 0)):
        A = labels[: H - dr, : W - dc]
        B = labels[dr:, dc:]
        sel = (A >= 0) & (B >= 0) & (A != B)
        rr, cc = np.nonzero(sel)
        for r, c, a_, b_ in zip(rr, cc, A[sel], B[sel]):
            if a_ in planes and b_ in planes:
                key = (int(min(a_, b_)), int(max(a_, b_)))
                pts.setdefault(key, []).append((c + dc / 2.0, r + dr / 2.0))

    edges: list[Edge] = []
    for (ia, ib), P in pts.items():
        pa, pb = planes[ia], planes[ib]
        na = np.array([-pa[0], -pa[1], 1.0]); nb_ = np.array([-pb[0], -pb[1], 1.0])
        cosang = abs(float(na @ nb_)) / (np.linalg.norm(na) * np.linalg.norm(nb_))
        if cosang > math.cos(math.radians(PARALLEL_DEG)):
            continue                              # same slope: no crease here
        P = np.array(P) * px_m                    # boundary points, metres (x east, y south)
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
        zA = pa[0] * P[:, 0] + pa[1] * P[:, 1] + pa[2]
        zB = pb[0] * P[:, 0] + pb[1] * P[:, 1] + pb[2]
        if np.median(np.abs(zA - zB)) > STEP_M:
            edges.extend(_step_edges(P, ia, ib, px_m))
            continue
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
            a_side = _side_of(labels, ia, n2, off, px_m)
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


def _side_of(labels, fid, n2, off, px_m) -> int:
    """+1 if facet `fid` lies on the +n2 side of the plan line, else -1."""
    rr, cc = np.nonzero(labels == fid)
    if len(rr) == 0:
        return 1
    d = (cc * px_m) * n2[0] + (rr * px_m) * n2[1] + off
    return 1 if float(np.median(d)) >= 0 else -1


def _step_edges(P, ia, ib, px_m) -> list[Edge]:
    """A roof meeting a wall: its length is the extent of the boundary itself."""
    c = P.mean(axis=0)
    _, _, vt = np.linalg.svd(P - c)
    u = vt[0]
    t = (P - c) @ u
    plan_m = float(t.max() - t.min())
    if plan_m < CREASE_MIN_M:
        return []
    q0 = (c + u * t.min()) / px_m; q1 = (c + u * t.max()) / px_m
    return [Edge("wall_intersection", f_, o_, tuple(q0), tuple(q1), round(plan_m, 3), round(plan_m, 3))
            for f_, o_ in ((ia, ib), (ib, ia))]


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
