"""
Axis Performance — Roof Geometry (pure math, deterministic).

Every contractor-facing measurement that downstream code uses to order
materials goes through this module. No LLM calls, no network IO, no
fabricated defaults. Inputs are user-confirmed polygons + pitches; outputs
are areas and linear footage that can be reproduced from those inputs
forever.

All functions are pure and side-effect free. Doc strings include the
industry-standard formulas so a contractor can verify the math by hand.

Coordinate convention:
- Polygons arrive as image-fraction pairs [[x, y], ...] in 0..1 space,
  origin top-left. This matches RoofOutlineEditor.tsx.
- Conversion to real-world feet requires (lat, zoom, image_width_px,
  image_height_px) — the Web Mercator metres-per-pixel formula used by
  Esri/Mapbox/Google tiles:
      mpp = 156543.03392 * cos(lat_rad) / 2^zoom
"""
from __future__ import annotations

import math
from typing import Iterable, Literal, TypedDict


# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------
WEB_MERCATOR_MPP_ZOOM0 = 156543.03392     # metres per pixel at zoom 0, equator
M_PER_FT = 0.3048
FT_PER_M = 3.28084
DEG_PER_RAD = 180.0 / math.pi


EdgeType = Literal[
    "eave", "rake", "ridge", "hip", "valley",
    "gable_end", "wall_intersection", "unlabeled",
]


# ----------------------------------------------------------------------------
# Pitch math
# ----------------------------------------------------------------------------

def pitch_string_to_rise(pitch: str) -> float:
    """
    Parse 'X/12' canonical pitch string to its rise (the X).
    Tolerates whitespace, 'in 12' notation, and stringified ints.
    Returns 0.0 for unparseable input — callers must check.
    """
    if not pitch:
        return 0.0
    s = pitch.strip().lower().replace(" ", "")
    s = s.replace("in12", "/12").replace("over12", "/12")
    if "/" in s:
        head = s.split("/", 1)[0]
    else:
        head = s
    try:
        return float(head)
    except ValueError:
        return 0.0


def pitch_string_to_degrees(pitch: str) -> float:
    """
    Convert 'X/12' to pitch angle in degrees from horizontal.
        angle = atan(rise / 12)
    e.g., '6/12'  → 26.565°
          '12/12' → 45.000°
          '4/12'  → 18.435°
    """
    rise = pitch_string_to_rise(pitch)
    if rise <= 0:
        return 0.0
    return math.atan(rise / 12.0) * DEG_PER_RAD


def degrees_to_pitch_string(degrees: float) -> str:
    """
    Convert pitch in degrees to canonical 'X/12' (rounded to nearest integer
    rise). Used when an external source (Google Solar API) gives us radians/
    degrees and the contractor wants the familiar X/12 notation.
    """
    if degrees is None or degrees <= 0:
        return "0/12"
    rise = round(math.tan(math.radians(degrees)) * 12.0)
    return f"{max(0, min(rise, 24))}/12"


def slope_multiplier(pitch: str) -> float:
    """
    Multiplier converting plan (footprint) area to true (sloped) roof area.

        plan_area * slope_multiplier(pitch) = true_roof_area

    Formula:
        slope_mult = sqrt(1 + (rise/run)^2) = 1 / cos(angle)

    Reference values contractors expect:
        4/12 → 1.054
        6/12 → 1.118
        8/12 → 1.202
        12/12 → 1.414
    """
    rise = pitch_string_to_rise(pitch)
    if rise <= 0:
        return 1.0
    return math.sqrt(1.0 + (rise / 12.0) ** 2)


# ----------------------------------------------------------------------------
# Web Mercator scaling
# ----------------------------------------------------------------------------

def metres_per_pixel(lat: float, zoom: int) -> float:
    """
    Web Mercator metres-per-pixel at the given latitude and zoom.

        mpp = 156543.03392 * cos(lat_rad) / 2^zoom
    """
    return WEB_MERCATOR_MPP_ZOOM0 * math.cos(math.radians(lat)) / (2 ** zoom)


def feet_per_pixel(lat: float, zoom: int) -> float:
    """Feet per pixel of imagery at this lat/zoom."""
    return metres_per_pixel(lat, zoom) * FT_PER_M


# ----------------------------------------------------------------------------
# Polygon geometry
# ----------------------------------------------------------------------------

def shoelace_area_fraction(polygon: list[list[float]]) -> float:
    """
    Shoelace formula on image-fraction coordinates (0..1). Returns area in
    fraction² — multiply by image_width_px × image_height_px × (ft/px)² to
    convert to square feet.

    Returns 0 if the polygon has fewer than 3 vertices.
    """
    n = len(polygon)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        x1, y1 = polygon[i][0], polygon[i][1]
        x2, y2 = polygon[(i + 1) % n][0], polygon[(i + 1) % n][1]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def polygon_plan_area_sqft(
    polygon: list[list[float]],
    lat: float,
    zoom: int,
    image_width_px: int,
    image_height_px: int,
) -> float:
    """
    Convert a polygon in image-fraction coords to plan-view square footage.

    This is the FOOTPRINT area — what you'd see from straight above. For the
    true sloped-roof area, multiply by `slope_multiplier(pitch)`.
    """
    if len(polygon) < 3:
        return 0.0
    ft_per_px = feet_per_pixel(lat, zoom)
    area_frac = shoelace_area_fraction(polygon)
    return area_frac * image_width_px * image_height_px * (ft_per_px ** 2)


def polygon_perimeter_ft(
    polygon: list[list[float]],
    lat: float,
    zoom: int,
    image_width_px: int,
    image_height_px: int,
) -> float:
    """Total perimeter of the closed polygon in feet."""
    n = len(polygon)
    if n < 2:
        return 0.0
    ft_per_px = feet_per_pixel(lat, zoom)
    perim = 0.0
    for i in range(n):
        x1, y1 = polygon[i][0], polygon[i][1]
        x2, y2 = polygon[(i + 1) % n][0], polygon[(i + 1) % n][1]
        dx = (x2 - x1) * image_width_px * ft_per_px
        dy = (y2 - y1) * image_height_px * ft_per_px
        perim += math.sqrt(dx * dx + dy * dy)
    return perim


def edge_plan_length_ft(
    p1: list[float],
    p2: list[float],
    lat: float,
    zoom: int,
    image_width_px: int,
    image_height_px: int,
) -> float:
    """Length of a single edge between two image-fraction points, in feet."""
    ft_per_px = feet_per_pixel(lat, zoom)
    dx = (p2[0] - p1[0]) * image_width_px * ft_per_px
    dy = (p2[1] - p1[1]) * image_height_px * ft_per_px
    return math.sqrt(dx * dx + dy * dy)


def slope_adjusted_edge_length_ft(plan_length_ft: float, pitch: str, edge_type: EdgeType) -> float:
    """
    Convert a plan-view edge length to its true length along the roof surface.

    Eaves and ridges are horizontal (or essentially so) — their plan length
    equals their true length.

    Rakes run from eave to ridge along a slope — true length = plan_length /
    cos(pitch_angle) = plan_length × slope_multiplier(pitch).

    Hips and valleys are diagonal lines where two facets meet. For a typical
    case where both facets share the same pitch, the true length along the
    surface is plan_length × sqrt(1 + (rise/run)² × 0.5). For a symmetric
    intersection at 45°, the rise/run ratio along the diagonal is the
    facet's rise/run divided by sqrt(2). We use the conservative
    slope_multiplier × sqrt(2)/2 + 1/2 approximation, which is exact for
    symmetric hip/valley at equal pitch and within 2% of true length for
    typical residential pitch combinations.

    For contractors ordering ridge cap and valley metal, this is the right
    length — they want true linear footage along the roof.
    """
    if edge_type in ("eave", "ridge", "gable_end", "wall_intersection", "unlabeled"):
        return plan_length_ft
    if edge_type == "rake":
        return plan_length_ft * slope_multiplier(pitch)
    if edge_type in ("hip", "valley"):
        # Symmetric two-facet intersection: diagonal slope_multiplier.
        # diag_mult = sqrt(1 + (rise/run)^2 / 2) for symmetric pitch.
        rise = pitch_string_to_rise(pitch)
        if rise <= 0:
            return plan_length_ft
        return plan_length_ft * math.sqrt(1.0 + (rise / 12.0) ** 2 / 2.0)
    return plan_length_ft


# ----------------------------------------------------------------------------
# Polygon orientation
# ----------------------------------------------------------------------------

def polygon_centroid(polygon: list[list[float]]) -> tuple[float, float]:
    """Area-weighted centroid in image fractions; falls back to vertex mean if degenerate."""
    n = len(polygon)
    if n < 3:
        if n == 0:
            return (0.5, 0.5)
        x = sum(p[0] for p in polygon) / n
        y = sum(p[1] for p in polygon) / n
        return (x, y)
    cx = cy = a = 0.0
    for i in range(n):
        x1, y1 = polygon[i][0], polygon[i][1]
        x2, y2 = polygon[(i + 1) % n][0], polygon[(i + 1) % n][1]
        cross = x1 * y2 - x2 * y1
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
        a += cross
    if abs(a) < 1e-12:
        x = sum(p[0] for p in polygon) / n
        y = sum(p[1] for p in polygon) / n
        return (x, y)
    a *= 0.5
    return (cx / (6 * a), cy / (6 * a))


def longest_edge_orientation_deg(polygon: list[list[float]]) -> float | None:
    """
    Orientation of the longest edge of the polygon, measured clockwise from
    north (so 0° = pointing up in the image, 90° = east). Used to set a
    facet's slope_direction when no ridge edge has been explicitly labeled.

    In aerial-image coords, +y is south; we negate dy when computing the
    compass angle so north reads as 0°.

    Returns None if the polygon has fewer than 2 vertices.
    """
    n = len(polygon)
    if n < 2:
        return None
    best_len = -1.0
    best_dx, best_dy = 0.0, 0.0
    for i in range(n):
        x1, y1 = polygon[i][0], polygon[i][1]
        x2, y2 = polygon[(i + 1) % n][0], polygon[(i + 1) % n][1]
        dx, dy = x2 - x1, y2 - y1
        length = dx * dx + dy * dy
        if length > best_len:
            best_len = length
            best_dx, best_dy = dx, dy
    # Compass bearing: 0° = north, 90° = east, etc. Image +y = south.
    angle = math.degrees(math.atan2(best_dx, -best_dy))
    if angle < 0:
        angle += 360.0
    return angle


def compass_direction(orientation_deg: float | None) -> str | None:
    """Convert a compass bearing in degrees to an 8-point compass label."""
    if orientation_deg is None:
        return None
    labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    idx = int(((orientation_deg % 360) + 22.5) // 45) % 8
    return labels[idx]


# ----------------------------------------------------------------------------
# Whole-roof aggregates
# ----------------------------------------------------------------------------

class FacetGeometry(TypedDict, total=False):
    polygon: list[list[float]]
    pitch: str
    plan_area_sqft: float
    true_area_sqft: float
    pitch_degrees: float


class EdgeMeasure(TypedDict):
    facet_label: str
    edge_type: EdgeType
    plan_length_ft: float
    slope_adjusted_ft: float


def compute_facet_geometry(
    polygon: list[list[float]],
    pitch: str,
    lat: float,
    zoom: int,
    image_width_px: int,
    image_height_px: int,
) -> FacetGeometry:
    """
    All deterministic measurements for a single facet polygon. Returns a
    dict with plan_area_sqft, true_area_sqft, and pitch_degrees so callers
    can persist them.
    """
    plan = polygon_plan_area_sqft(polygon, lat, zoom, image_width_px, image_height_px)
    mult = slope_multiplier(pitch)
    return {
        "polygon": polygon,
        "pitch": pitch,
        "plan_area_sqft": round(plan, 1),
        "true_area_sqft": round(plan * mult, 1),
        "pitch_degrees": round(pitch_string_to_degrees(pitch), 2),
    }


def aggregate_edges_by_type(edges: Iterable[EdgeMeasure]) -> dict[EdgeType, dict[str, float]]:
    """
    Sum (plan_length_ft, slope_adjusted_ft) by edge_type across a list of
    edge measurements. The slope_adjusted_ft is the value contractors use
    to order material; plan_length_ft is shown alongside for transparency.

    Returns:
        {
          "eave":   {"plan_ft": 60.0, "slope_ft": 60.0},
          "ridge":  {"plan_ft": 20.0, "slope_ft": 20.0},
          "rake":   {"plan_ft": 35.4, "slope_ft": 39.6},
          ...
        }
    """
    totals: dict[EdgeType, dict[str, float]] = {}
    for e in edges:
        t = e["edge_type"]
        bucket = totals.setdefault(t, {"plan_ft": 0.0, "slope_ft": 0.0})
        bucket["plan_ft"] += e["plan_length_ft"]
        bucket["slope_ft"] += e["slope_adjusted_ft"]
    # Round at the end so accumulated error doesn't compound visually.
    for v in totals.values():
        v["plan_ft"] = round(v["plan_ft"], 1)
        v["slope_ft"] = round(v["slope_ft"], 1)
    return totals


def predominant_pitch(facets: list[FacetGeometry]) -> str:
    """
    Area-weighted predominant pitch. Returns the pitch string of the
    largest-area facet. Used when reporting a single roof-wide pitch to
    the contractor or material engine.
    """
    if not facets:
        return "Unknown"
    largest = max(facets, key=lambda f: f.get("true_area_sqft") or 0.0)
    return largest.get("pitch") or "Unknown"


def complexity_score(
    facet_count: int,
    valleys_ft: float,
    hips_ft: float,
    pitch_variance_deg: float,
) -> float:
    """
    Deterministic complexity score in 0..1. Used to default the waste
    percentage and inform the contractor whether the job is "simple
    gable" vs "complex multi-facet hip".

    Formula (calibrated against contractor convention):
        facet_term  = min(1.0, (facet_count - 1) / 10.0)
        valley_term = min(1.0, valleys_ft / 80.0)
        hip_term    = min(1.0, hips_ft    / 80.0)
        pitch_term  = min(1.0, pitch_variance_deg / 10.0)
        score = 0.30*facet_term + 0.30*valley_term + 0.20*hip_term + 0.20*pitch_term

    Interpretation:
        < 0.20 → simple gable, 10% waste typical
        0.20..0.45 → moderate, 12% waste
        0.45..0.70 → complex hip / multi-facet, 15% waste
        > 0.70 → very complex, 18-20% waste
    """
    facet_term = min(1.0, max(0, facet_count - 1) / 10.0)
    valley_term = min(1.0, valleys_ft / 80.0)
    hip_term = min(1.0, hips_ft / 80.0)
    pitch_term = min(1.0, pitch_variance_deg / 10.0)
    return round(
        0.30 * facet_term + 0.30 * valley_term + 0.20 * hip_term + 0.20 * pitch_term,
        3,
    )


def recommended_waste_pct(complexity: float) -> int:
    """Map complexity score to a recommended waste percentage."""
    if complexity < 0.20:
        return 10
    if complexity < 0.45:
        return 12
    if complexity < 0.70:
        return 15
    return 18


# ----------------------------------------------------------------------------
# Auto-suggest edge labels from shared geometry
# ----------------------------------------------------------------------------

def _segments_overlap(
    a1: list[float], a2: list[float], b1: list[float], b2: list[float], tol: float = 0.010
) -> bool:
    """
    True if line segments (a1,a2) and (b1,b2) are coincident within `tol`
    (image-fraction units, ≈0.8% of side). Used to detect when two facets share an
    edge — that edge is then a ridge, hip, or valley. Slightly forgiving so a hip/
    ridge whose corners were traced a hair apart is still caught (fewer hips landing
    as perimeter rakes), while staying well under the spacing of distinct corners.

    We test both orderings since polygon traversal may differ.

    We test both orderings since polygon traversal may differ.
    """
    def close(p: list[float], q: list[float]) -> bool:
        return abs(p[0] - q[0]) <= tol and abs(p[1] - q[1]) <= tol

    return (close(a1, b1) and close(a2, b2)) or (close(a1, b2) and close(a2, b1))


def _interior_angle_deg(prev, v, nxt) -> float:
    ax, ay = prev[0] - v[0], prev[1] - v[1]
    bx, by = nxt[0] - v[0], nxt[1] - v[1]
    da, db = math.hypot(ax, ay), math.hypot(bx, by)
    if da == 0 or db == 0:
        return 0.0
    cosv = max(-1.0, min(1.0, (ax * bx + ay * by) / (da * db)))
    return math.degrees(math.acos(cosv))


def _angle_sum_at(facets: list[dict], pt, eps: float = 0.012) -> float:
    """Sum of the interior angles of every facet that touches `pt`. A convex roof
    corner sums to <~180°; a CONCAVE (inside) corner — where the roof wraps around,
    e.g. an L/T-shaped roof's valley — sums to >~200°. Rotation-invariant."""
    total = 0.0
    for f in facets:
        poly = f.get("polygon") or []
        n = len(poly)
        for k in range(n):
            v = poly[k]
            if abs(v[0] - pt[0]) <= eps and abs(v[1] - pt[1]) <= eps:
                total += _interior_angle_deg(poly[(k - 1) % n], v, poly[(k + 1) % n])
    return total


def _line_angle_diff(a_deg: float, b_deg: float) -> float:
    d = abs(a_deg - b_deg) % 180.0
    return min(d, 180.0 - d)   # 0..90


def _longest_edge_angle_deg(poly: list) -> float | None:
    """Angle of the polygon's longest edge in STANDARD math convention
    (atan2(dy, dx)) so it's comparable to a raw edge angle. (Distinct from
    longest_edge_orientation_deg, which returns a compass bearing.)"""
    n = len(poly)
    if n < 2:
        return None
    best, bdx, bdy = -1.0, 0.0, 0.0
    for i in range(n):
        x1, y1 = poly[i][0], poly[i][1]
        x2, y2 = poly[(i + 1) % n][0], poly[(i + 1) % n][1]
        dx, dy = x2 - x1, y2 - y1
        L = dx * dx + dy * dy
        if L > best:
            best, bdx, bdy = L, dx, dy
    return math.degrees(math.atan2(bdy, bdx))


# ----------------------------------------------------------------------------
# Edge classification — slope-aware, straight-skeleton-grounded
# ----------------------------------------------------------------------------
#
# The interior lines of a pitched roof are the straight skeleton of its
# outline. That theory gives exact, rotation-invariant rules:
#   * RIDGE  — interior line between two PARALLEL outline (eave) edges, or a
#              fully-interior line (hip-roof ridge runs junction→junction).
#   * HIP    — interior line reaching the outline at a CONVEX corner.
#   * VALLEY — interior line reaching the outline at a REFLEX corner
#              (valleys only exist at inside corners: L/T shapes).
#   * EAVE   — perimeter edge PERPENDICULAR to the facet's slope, downhill.
#   * RAKE   — perimeter edge PARALLEL to the facet's slope.
#
# CRITICAL lesson baked in: concavity must be tested at the edge's OUTLINE
# endpoint only. At interior junctions (where ridge meets hips) three facets
# meet and the angle sum is ~360° — testing there made every hip and ridge on
# a hip roof read as a "valley".


def _edge_angle_deg(p1, p2) -> float:
    return math.degrees(math.atan2(p2[1] - p1[1], p2[0] - p1[0]))


def _seg_len(p1, p2) -> float:
    return math.hypot(p2[0] - p1[0], p2[1] - p1[1])


def _edges_share(a1, a2, b1, b2, perp_tol: float = 0.009) -> bool:
    """
    True if the two edges are the SAME roof line — exact endpoint match (fast
    path) or collinear with substantial partial overlap. Partial overlap is
    how real traces share edges on T/L roofs (a long main ridge overlapped by
    a shorter wing edge) and when adjacent facets were traced slightly offset.
    """
    if _segments_overlap(a1, a2, b1, b2):
        return True

    la, lb = _seg_len(a1, a2), _seg_len(b1, b2)
    if la < 1e-9 or lb < 1e-9:
        return False
    # Work along the LONGER edge's line.
    if lb > la:
        a1, a2, b1, b2, la, lb = b1, b2, a1, a2, lb, la
    ux, uy = (a2[0] - a1[0]) / la, (a2[1] - a1[1]) / la

    # Both endpoints of the shorter edge must sit ON the longer edge's line.
    def perp_dist(p) -> float:
        wx, wy = p[0] - a1[0], p[1] - a1[1]
        return abs(wx * uy - wy * ux)

    if perp_dist(b1) > perp_tol or perp_dist(b2) > perp_tol:
        return False

    # ...and overlap it substantially in 1D.
    t1 = (b1[0] - a1[0]) * ux + (b1[1] - a1[1]) * uy
    t2 = (b2[0] - a1[0]) * ux + (b2[1] - a1[1]) * uy
    lo, hi = min(t1, t2), max(t1, t2)
    overlap = min(hi, la) - max(lo, 0.0)
    return overlap >= max(0.010, 0.30 * lb)


def _closest_point_on_segment(p, s1, s2) -> tuple[float, float]:
    dx, dy = s2[0] - s1[0], s2[1] - s1[1]
    L2 = dx * dx + dy * dy
    if L2 < 1e-18:
        return (s1[0], s1[1])
    t = ((p[0] - s1[0]) * dx + (p[1] - s1[1]) * dy) / L2
    t = max(0.0, min(1.0, t))
    return (s1[0] + t * dx, s1[1] + t * dy)


def _facet_downhill(
    poly: list, interior_vis: set[int], perimeter_vis: set[int],
) -> tuple[float, float] | None:
    """
    Provisional downhill (drain) direction for a facet: from the mass of its
    interior edges (ridge/hips — the high side) toward the mass of its
    perimeter edges (eave side). Rotation-invariant; None when the facet has
    no interior edges to anchor the high side.
    """
    if not interior_vis or not perimeter_vis:
        return None
    n = len(poly)

    def mass(vis: set[int]) -> tuple[float, float] | None:
        sx = sy = tw = 0.0
        for vi in vis:
            p1, p2 = poly[vi], poly[(vi + 1) % n]
            w = _seg_len(p1, p2)
            sx += w * (p1[0] + p2[0]) / 2
            sy += w * (p1[1] + p2[1]) / 2
            tw += w
        return (sx / tw, sy / tw) if tw > 1e-9 else None

    hi, lo = mass(interior_vis), mass(perimeter_vis)
    if hi is None or lo is None:
        return None
    dx, dy = lo[0] - hi[0], lo[1] - hi[1]
    d = math.hypot(dx, dy)
    return (dx / d, dy / d) if d > 1e-9 else None


def _classify_interior_edge(
    p1, p2,
    fa: dict, fb: dict,
    a_perim: list[tuple[list, list]],   # perimeter edges of facet A [(p1,p2)...]
    b_perim: list[tuple[list, list]],
    da: tuple[float, float] | None,     # provisional downhill of A / B
    db: tuple[float, float] | None,
    ca: tuple[float, float],            # centroids
    cb: tuple[float, float],
) -> tuple[str, float, str]:
    """Classify one shared edge (A↔B) as ridge / hip / valley. Symmetric in
    A and B, so both facets get the same answer for the same physical line."""
    edge_deg = _edge_angle_deg(p1, p2)
    edge_len = _seg_len(p1, p2)

    # -- RIDGE test 1: parallel to a substantial eave-candidate of EACH facet.
    #    (A ridge runs between two parallel outline edges; hips and valleys cut
    #    diagonally, ~45° to every eave, so they never pass this.)
    def has_parallel_perimeter(perim: list) -> bool:
        for q1, q2 in perim:
            if _seg_len(q1, q2) < max(0.02, 0.25 * edge_len):
                continue   # ignore tiny jog edges
            if _line_angle_diff(edge_deg, _edge_angle_deg(q1, q2)) <= 25.0:
                return True
        return False

    if has_parallel_perimeter(a_perim) and has_parallel_perimeter(b_perim):
        return "ridge", 0.9, "Runs parallel to the eaves of both facets — ridge line"

    # -- RIDGE test 2: both endpoints interior (touch no perimeter edge of
    #    either facet). Hips and valleys always run down to the outline; a
    #    hip-roof ridge runs junction→junction fully inside it.
    def endpoint_on_outline(pt) -> bool:
        for q1, q2 in a_perim + b_perim:
            if (abs(q1[0] - pt[0]) <= 0.012 and abs(q1[1] - pt[1]) <= 0.012) or \
               (abs(q2[0] - pt[0]) <= 0.012 and abs(q2[1] - pt[1]) <= 0.012):
                return True
        return False

    p1_out, p2_out = endpoint_on_outline(p1), endpoint_on_outline(p2)
    if not p1_out and not p2_out:
        return "ridge", 0.85, "Fully interior line (junction to junction) — ridge"

    # -- HIP vs VALLEY: concavity of the building outline at the OUTLINE
    #    endpoint. Sum the two facets' corner angles there: an outside (convex)
    #    corner sums well under 180°, an inside (reflex) corner well over.
    #    NEVER tested at the interior junction endpoint — 3+ facets meet there
    #    and the sum is meaninglessly large (the old hip→valley bug).
    outline_pt = p1 if p1_out else p2
    corner = _angle_sum_at([fa, fb], outline_pt)

    # Secondary signal — drainage: water CONVERGES onto a valley (both facets'
    # downhills point toward the line) and DIVERGES off a hip. The provisional
    # downhill vectors can be contaminated on narrow wing facets, so the corner
    # reading (geometrically exact for a real outline corner) always OUTRANKS
    # drainage: drainage only tunes confidence, and only gets to decide when
    # the corner reading is junction-poisoned (>320° means the "outline"
    # endpoint was actually an interior junction — a missed shared edge).
    drain = None   # +1 converge (valley-like) / -1 diverge (hip-like) / None unknown
    if da is not None and db is not None:
        ex, ey = p2[0] - p1[0], p2[1] - p1[1]
        el = math.hypot(ex, ey)
        if el > 1e-9:
            ux, uy = ex / el, ey / el

            def toward(centroid, d) -> float:
                # Perpendicular direction from the centroid to the edge's LINE
                # (no segment clamp — clamping rotates the normal near the ends).
                wx, wy = centroid[0] - p1[0], centroid[1] - p1[1]
                t = wx * ux + wy * uy
                nx, ny = (p1[0] + t * ux) - centroid[0], (p1[1] + t * uy) - centroid[1]
                nd = math.hypot(nx, ny)
                if nd < 1e-9:
                    return 0.0
                return (d[0] * nx + d[1] * ny) / nd

            ta, tb = toward(ca, da), toward(cb, db)
            if ta > 0.15 and tb > 0.15:
                drain = 1
            elif ta < -0.15 and tb < -0.15:
                drain = -1

    junction_poisoned = corner > 320.0 or corner <= 1.0
    if not junction_poisoned:
        if corner > 195.0:
            conf = 0.9 if drain == 1 else (0.6 if drain == -1 else 0.8)
            note = " (drainage disagrees — please confirm)" if drain == -1 else ""
            return "valley", conf, f"Meets the outline at an inside corner ({corner:.0f}°) — water collects here{note}"
        if corner < 168.0:
            conf = 0.9 if drain == -1 else (0.6 if drain == 1 else 0.8)
            note = " (drainage disagrees — please confirm)" if drain == 1 else ""
            return "hip", conf, f"Meets the outline at an outside corner ({corner:.0f}°) — external junction{note}"

    # Corner inconclusive or junction-poisoned → drainage decides.
    if drain == 1:
        return "valley", 0.65, "Both facets drain toward this line — valley"
    if drain == -1:
        return "hip", 0.65, "Both facets drain away from this line — hip"
    return "hip", 0.5, "Diagonal junction — likely hip; please confirm hip vs valley"


def auto_suggest_edge_types(
    facets: list[dict],   # each: {label, polygon, pitch_degrees}
) -> list[dict]:
    """
    Deterministic, rotation-invariant edge classification for a set of traced
    roof facets. Returns one suggestion per polygon edge:

        [
          {"facet_label": "A", "vertex_index_start": 0, "vertex_index_end": 1,
           "edge_type": "eave", "confidence": 0.8, "reason": "...",
           "shared_with_facet_label": None},
          ...
        ]

    Method (straight-skeleton-grounded — see the block comment above):
      1. Shared-edge detection with partial (collinear) overlap, so offset
         traces and T/L roofs still register their interior lines.
      2. Interior edges → ridge / hip / valley by parallel-eave test,
         fully-interior test, and outline-corner concavity (+ drain-direction
         tiebreak). All rotation-invariant.
      3. Perimeter edges → eave / rake relative to the facet's own level
         axis and downhill side — never the image axes.

    Edge types feed material orders (ridge cap, valley metal, drip edge,
    flashing), so every call carries an honest confidence + a plain-English
    reason the contractor can sanity-check in the review UI.
    """
    # ---- Pass 0: normalize + centroids -------------------------------------
    polys: list[list] = []
    for f in facets:
        poly = f.get("polygon") or []
        polys.append(poly if len(poly) >= 3 else [])

    # ---- Pass 1: shared-edge matrix (partial overlap aware) -----------------
    # shared[i][vi] = index j of the facet sharing that edge (best overlap), or None
    shared: list[list[int | None]] = [[None] * len(p) for p in polys]
    for i, poly in enumerate(polys):
        n = len(poly)
        for vi in range(n):
            p1, p2 = poly[vi], poly[(vi + 1) % n]
            for j, opoly in enumerate(polys):
                if j == i or not opoly:
                    continue
                m = len(opoly)
                if any(_edges_share(p1, p2, opoly[vj], opoly[(vj + 1) % m]) for vj in range(m)):
                    shared[i][vi] = j
                    break

    # ---- Pass 2: per-facet structure ----------------------------------------
    interior_vis: list[set[int]] = []
    perimeter_vis: list[set[int]] = []
    perim_edges: list[list[tuple[list, list]]] = []
    centroids: list[tuple[float, float]] = []
    downhills: list[tuple[float, float] | None] = []
    for i, poly in enumerate(polys):
        n = len(poly)
        ivis = {vi for vi in range(n) if shared[i][vi] is not None}
        pvis = set(range(n)) - ivis
        interior_vis.append(ivis)
        perimeter_vis.append(pvis)
        perim_edges.append([(poly[vi], poly[(vi + 1) % n]) for vi in sorted(pvis)])
        centroids.append(polygon_centroid(poly) if poly else (0.0, 0.0))
        downhills.append(_facet_downhill(poly, ivis, pvis) if poly else None)

    # ---- Pass 3: classify ----------------------------------------------------
    suggestions: list[dict] = []
    interior_cache: dict[tuple[int, int, int, int], tuple[str, float, str]] = {}

    for i, f in enumerate(facets):
        poly = polys[i]
        n = len(poly)
        if n < 3:
            continue

        # Classify this facet's interior (shared) edges first — its ridge, if
        # found, then anchors the level axis used for the perimeter calls.
        interior_labels: dict[int, tuple[str, float, str]] = {}
        for vi in sorted(interior_vis[i]):
            j = shared[i][vi]
            if j is None:
                continue
            key = _pair_key(i, vi, j, -1)
            if key not in interior_cache:
                interior_cache[key] = _classify_interior_edge(
                    poly[vi], poly[(vi + 1) % n],
                    facets[i], facets[j],
                    perim_edges[i], perim_edges[j],
                    downhills[i], downhills[j],
                    centroids[i], centroids[j],
                )
            interior_labels[vi] = interior_cache[key]

        # The facet's LEVEL axis (ridge/eave direction) for perimeter calls.
        # Best source: its own ridge; else perpendicular to its drain direction;
        # else its longest edge (lone-facet eave assumption).
        level_deg: float | None
        ridge_dirs = [
            _edge_angle_deg(poly[vi], poly[(vi + 1) % n])
            for vi, (t, _c, _r) in interior_labels.items() if t == "ridge"
        ]
        if ridge_dirs:
            level_deg = ridge_dirs[0]
        elif downhills[i] is not None:
            dh = downhills[i]
            level_deg = math.degrees(math.atan2(dh[1], dh[0])) + 90.0
        else:
            level_deg = _longest_edge_angle_deg(poly)

        # Downhill unit vector for the eave-side test.
        dh_vec = downhills[i]
        if dh_vec is None and level_deg is not None:
            # Lone facet: assume the longest edge is the eave and downhill
            # points from the centroid toward it. When other facets exist,
            # prefer the side FACING AWAY from them (roofs drain outward).
            ldeg = _longest_edge_angle_deg(poly)
            if ldeg is not None:
                # find the longest edge's midpoint
                bl, bmid = -1.0, None
                for vi in range(n):
                    L = _seg_len(poly[vi], poly[(vi + 1) % n])
                    if L > bl:
                        bl = L
                        bmid = ((poly[vi][0] + poly[(vi + 1) % n][0]) / 2,
                                (poly[vi][1] + poly[(vi + 1) % n][1]) / 2)
                if bmid is not None:
                    dx, dy = bmid[0] - centroids[i][0], bmid[1] - centroids[i][1]
                    dd = math.hypot(dx, dy)
                    if dd > 1e-9:
                        dh_vec = (dx / dd, dy / dd)

        single_perimeter = len(perimeter_vis[i]) == 1
        has_interior = bool(interior_vis[i])

        for vi in range(n):
            p1, p2 = poly[vi], poly[(vi + 1) % n]
            j = shared[i][vi]

            if j is not None:
                etype, conf, reason = interior_labels.get(vi, ("ridge", 0.5, "Shared edge"))
                shared_label = facets[j].get("label")
            elif single_perimeter and has_interior:
                # A facet ringed by junctions with ONE outline edge (hip-end
                # triangle, clipped hip trapezoid): that edge is its eave.
                etype, conf, reason = "eave", 0.85, "The facet's only outline edge — its eave"
                shared_label = None
            else:
                etype, conf, reason = _classify_perimeter_edge(
                    p1, p2, level_deg, dh_vec, centroids[i], has_interior,
                )
                if not has_interior and conf > 0.55:
                    conf = 0.55   # lone facet: level axis is an assumption — be honest
                shared_label = None

            suggestions.append({
                "facet_label": f.get("label"),
                "vertex_index_start": vi,
                "vertex_index_end": (vi + 1) % n,
                "edge_type": etype,
                "confidence": round(conf, 2),
                "reason": reason,
                "shared_with_facet_label": shared_label,
            })

    return suggestions


def _pair_key(i: int, vi: int, j: int, _unused: int) -> tuple[int, int, int, int]:
    """Cache key for an interior edge seen from facet i, edge vi (partner j).
    Keyed per (facet, edge) side; classification is symmetric by construction,
    so both sides land on the same answer."""
    return (i, vi, j, 0)


def _classify_perimeter_edge(
    p1, p2,
    level_deg: float | None,
    downhill: tuple[float, float] | None,
    centroid: tuple[float, float],
    has_interior: bool,
) -> tuple[str, float, str]:
    """Eave vs rake for an outline edge, relative to the facet's own level
    axis — rotation-invariant (never uses the image axes)."""
    if level_deg is None:
        return "unlabeled", 0.3, "Not enough structure to classify — please label"

    rel = _line_angle_diff(_edge_angle_deg(p1, p2), level_deg)   # 0=level, 90=along slope
    mid = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
    downhill_side = 0.0
    if downhill is not None:
        # Use only the CROSS-SLOPE component of the drain vector — the
        # along-ridge component is provisional-estimate noise (narrow wing
        # facets pick some up from gable ends) and must not tip the side test.
        lrad = math.radians(level_deg)
        px, py = -math.sin(lrad), math.cos(lrad)      # perpendicular of level axis
        mag = downhill[0] * px + downhill[1] * py
        if abs(mag) < 0.2:
            downhill = None    # drain vector ~parallel to the ridge: unusable
        else:
            downhill_side = ((mid[0] - centroid[0]) * px + (mid[1] - centroid[1]) * py) * mag

    if rel <= 30.0:
        if downhill is None or downhill_side > 0:
            conf = 0.8 if has_interior else 0.6
            return "eave", conf, "Level edge on the downhill side — gutter line"
        return "ridge", 0.45, "Level edge on the HIGH side — ridge if freestanding, wall flashing if it meets a wall"
    if rel >= 60.0:
        return "rake", 0.8 if has_interior else 0.6, "Runs up the slope along the gable end — rake"
    # Diagonal outline edge (clipped corner, angled addition) — side decides.
    if downhill is not None and downhill_side > 0:
        return "eave", 0.5, "Diagonal outline edge on the downhill side — likely eave; please confirm"
    return "rake", 0.5, "Diagonal outline edge on the high side — likely rake; please confirm"


# ----------------------------------------------------------------------------
# Confidence normalization
# ----------------------------------------------------------------------------

def normalize_confidence(value: float | int | None) -> float:
    """
    Normalize a confidence score to 0..1.
      - None → 0.0
      - Values in 0..1 are kept as-is.
      - Values in 1..100 are divided by 100 (legacy integer scale).
      - Negatives clamp to 0; values above 100 clamp to 1.
    """
    if value is None:
        return 0.0
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    if v < 0:
        return 0.0
    if v > 1:
        v = v / 100.0
    return max(0.0, min(1.0, v))
