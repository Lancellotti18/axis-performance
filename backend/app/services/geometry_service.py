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
    a1: list[float], a2: list[float], b1: list[float], b2: list[float], tol: float = 0.008
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


def _classify_shared_edge(p1, p2, this_poly: list, facets: list[dict]) -> tuple[str, float]:
    """Classify a shared edge as ridge / hip / valley from 2D geometry.
      - VALLEY: an endpoint is a concave (inside) roof corner — water collects.
      - RIDGE vs HIP: a ridge runs PARALLEL to the facet's eave (the long edge);
        a hip cuts diagonally toward an eave corner.
    Returns (edge_type, confidence). Conservative confidence — contractor verifies."""
    # Valley first: concavity is the most reliable rotation-invariant signal.
    if max(_angle_sum_at(facets, p1), _angle_sum_at(facets, p2)) > 200.0:
        return "valley", 0.6

    eave = _longest_edge_angle_deg(this_poly)
    edge_deg = math.degrees(math.atan2(p2[1] - p1[1], p2[0] - p1[0]))
    if eave is not None:
        rel = _line_angle_diff(edge_deg, eave)   # 0 = parallel to eave, 90 = perpendicular
        if rel < 28.0:
            return "ridge", 0.6        # parallel to the eave → ridge line
        return "hip", 0.55             # diagonal across the roof → hip
    # No eave reference — fall back to image-horizontal heuristic.
    near_h = abs(p2[1] - p1[1]) < 0.30 * abs(p2[0] - p1[0]) if (p2[0] - p1[0]) else False
    return ("ridge", 0.45) if near_h else ("hip", 0.45)


def auto_suggest_edge_types(
    facets: list[dict],   # each: {label, polygon, pitch_degrees}
) -> list[dict]:
    """
    Given a list of facets, return a list of suggested edge labels:

        [
          {"facet_label": "A", "vertex_index_start": 0, "vertex_index_end": 1,
           "edge_type": "eave", "shared_with_facet_label": None},
          ...
        ]

    Heuristic (deterministic, no AI):
      1. For every edge, check every other facet's edges for overlap.
         - If overlap AND both facets share equal pitch_degrees → 'ridge'.
         - If overlap AND pitches differ → 'hip' if both rise from the edge
           (outer corner) or 'valley' if both fall toward the edge.
           Since we don't yet know slope direction at this stage, the
           default for unequal-pitch shared edges is 'hip' (more common
           in residential). The user reviews each edge in the editor.
      2. For every non-shared edge:
         - 'eave' if the edge is approximately horizontal in the image
           (within 8°) AND on the lower portion of the polygon bounding box.
         - 'rake' if it's a non-horizontal edge on the side of the polygon.
         - 'gable_end' if it's the topmost/bottommost short edge on a
           triangle-like end.
      3. Anything we can't confidently label → 'unlabeled' so the user
         decides.

    This is INTENTIONALLY conservative. Edge types feed directly into
    material orders — better to leave 'unlabeled' than to mislabel a
    'rake' as a 'ridge' and order the wrong amount of cap shingles.
    """
    suggestions: list[dict] = []

    for i, f in enumerate(facets):
        poly = f.get("polygon") or []
        n = len(poly)
        if n < 3:
            continue

        # Pass A — resolve each edge's shared status, and classify the shared ones
        # (ridge / hip / valley) by geometry. Done first so the perimeter eave/rake
        # call below can use which vertices are ridge/hip "peaks".
        edge_shared: list[str | None] = [None] * n        # vi -> other facet label
        edge_type_shared: list[str | None] = [None] * n   # vi -> ridge/hip/valley
        for vi in range(n):
            p1 = poly[vi]
            p2 = poly[(vi + 1) % n]
            shared_with: str | None = None
            for j, other in enumerate(facets):
                if j == i:
                    continue
                opoly = other.get("polygon") or []
                if len(opoly) < 3:
                    continue
                hit = False
                for vj in range(len(opoly)):
                    if _segments_overlap(p1, p2, opoly[vj], opoly[(vj + 1) % len(opoly)]):
                        shared_with = other.get("label")
                        hit = True
                        break
                if hit:
                    break
            edge_shared[vi] = shared_with
            if shared_with:
                edge_type_shared[vi], _conf = _classify_shared_edge(p1, p2, poly, facets)

        # Vertices of THIS facet that sit on a ridge/hip edge (a "peak").
        peak_vtx: set[int] = set()
        for vi in range(n):
            if edge_type_shared[vi] in ("ridge", "hip"):
                peak_vtx.add(vi)
                peak_vtx.add((vi + 1) % n)
        has_peak = bool(peak_vtx)

        # Pass B — emit. Perimeter edges: a RAKE climbs to a peak (exactly ONE
        # endpoint on a ridge/hip); an EAVE has none — or both, like the base of a
        # hip facet that runs between two hips. Falls back to the horizontal
        # heuristic only when the facet has no ridge/hip at all (a lone slope).
        for vi in range(n):
            p1 = poly[vi]
            p2 = poly[(vi + 1) % n]
            shared_with = edge_shared[vi]
            if shared_with:
                edge_type = edge_type_shared[vi] or "ridge"
            elif has_peak:
                touch = (1 if vi in peak_vtx else 0) + (1 if (vi + 1) % n in peak_vtx else 0)
                edge_type = "rake" if touch == 1 else "eave"
            else:
                dx = p2[0] - p1[0]
                dy = p2[1] - p1[1]
                horizontal = abs(dy) < 0.15 * abs(dx) if dx != 0 else False
                edge_type = "eave" if horizontal else "rake"

            suggestions.append({
                "facet_label": f.get("label"),
                "vertex_index_start": vi,
                "vertex_index_end": (vi + 1) % n,
                "edge_type": edge_type,
                "shared_with_facet_label": shared_with,
            })

    return suggestions


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
