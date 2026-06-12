"""
APIR geometry helpers — pure math, no I/O.

The contractor-drawn polygons on the satellite image ARE the geometry.
These functions measure those polygons at the calibrated scale and
classify their edges into ridge / hip / valley / eave / rake.

All inputs are in satellite-image pixel space (PointPx). All length and
area outputs are in real-world feet, given a pixels_per_foot scale.
"""
from __future__ import annotations

import math
from typing import Iterable

from app.schemas.apir import EdgeType, PointPx, RoofEdge, RoofFacet, SlopeDirection


# ─────────────────────────────────────────────────────────────────────────
# Polygon math (shoelace, perimeter, centroid)
# ─────────────────────────────────────────────────────────────────────────

def shoelace_area_px(polygon: list[PointPx]) -> float:
    """Signed-area-magnitude in pixel² for any simple polygon."""
    n = len(polygon)
    if n < 3:
        return 0.0
    s = 0.0
    for i in range(n):
        j = (i + 1) % n
        s += polygon[i].x * polygon[j].y
        s -= polygon[j].x * polygon[i].y
    return abs(s) / 2.0


def shoelace_area_sqft(polygon: list[PointPx], pixels_per_foot: float) -> float:
    if pixels_per_foot <= 0:
        return 0.0
    return shoelace_area_px(polygon) / (pixels_per_foot ** 2)


def perimeter_px(polygon: list[PointPx]) -> float:
    n = len(polygon)
    if n < 2:
        return 0.0
    total = 0.0
    for i in range(n):
        j = (i + 1) % n
        total += _pixel_distance(polygon[i], polygon[j])
    return total


def perimeter_ft(polygon: list[PointPx], pixels_per_foot: float) -> float:
    if pixels_per_foot <= 0:
        return 0.0
    return perimeter_px(polygon) / pixels_per_foot


def polygon_centroid(polygon: list[PointPx]) -> PointPx:
    """
    Vertex-mean centroid — not the true area centroid, but good enough for
    placing a label inside the polygon and cheap to compute. Used only for
    diagram label anchoring; never for measurement.
    """
    n = len(polygon)
    if n == 0:
        return PointPx(x=0.0, y=0.0)
    cx = sum(p.x for p in polygon) / n
    cy = sum(p.y for p in polygon) / n
    return PointPx(x=cx, y=cy)


# ─────────────────────────────────────────────────────────────────────────
# Edge geometry
# ─────────────────────────────────────────────────────────────────────────

def _pixel_distance(a: PointPx, b: PointPx) -> float:
    return math.hypot(b.x - a.x, b.y - a.y)


def edge_length_ft(a: PointPx, b: PointPx, pixels_per_foot: float) -> float:
    if pixels_per_foot <= 0:
        return 0.0
    return _pixel_distance(a, b) / pixels_per_foot


def edge_angle_deg(a: PointPx, b: PointPx) -> float:
    """
    Angle in degrees in [-180, 180]. 0° is +x (east in screen coords).
    Used to distinguish horizontal-ish edges (ridge/eave) from sloped
    edges (hip/rake) in classify_roof_edge.
    """
    return math.degrees(math.atan2(b.y - a.y, b.x - a.x))


def is_horizontal_edge(a: PointPx, b: PointPx, tol_deg: float = 20.0) -> bool:
    """
    True if the edge is within ±tol_deg of horizontal (either direction).
    APIR uses 20° as the threshold between ridge/eave (horizontal-ish) and
    hip/rake (diagonal).
    """
    angle = abs(edge_angle_deg(a, b))
    return angle < tol_deg or angle > (180.0 - tol_deg)


# ─────────────────────────────────────────────────────────────────────────
# Edge classification — ridge / hip / valley / eave / rake
# ─────────────────────────────────────────────────────────────────────────

def points_close(a: PointPx, b: PointPx, tol_px: float = 3.0) -> bool:
    return _pixel_distance(a, b) <= tol_px


def _edge_matches(
    a1: PointPx, a2: PointPx, b1: PointPx, b2: PointPx, tol_px: float = 3.0
) -> bool:
    """Edges match if their endpoints coincide (in either orientation)."""
    same = points_close(a1, b1, tol_px) and points_close(a2, b2, tol_px)
    flipped = points_close(a1, b2, tol_px) and points_close(a2, b1, tol_px)
    return same or flipped


def find_shared_facet(
    edge_start: PointPx,
    edge_end: PointPx,
    own_facet_id: str,
    all_facets: Iterable[RoofFacet],
    tol_px: float = 3.0,
) -> str | None:
    """
    Return the id of another facet that shares this edge, or None.
    "Shares" = both endpoints coincide (within tol_px) with two adjacent
    vertices in the other facet's polygon.
    """
    for other in all_facets:
        if other.id == own_facet_id:
            continue
        poly = other.pixel_polygon
        n = len(poly)
        for i in range(n):
            j = (i + 1) % n
            if _edge_matches(edge_start, edge_end, poly[i], poly[j], tol_px):
                return other.id
    return None


def classify_edge(
    edge_start: PointPx,
    edge_end: PointPx,
    own_facet_id: str,
    all_facets: Iterable[RoofFacet],
    tol_px: float = 3.0,
) -> tuple[EdgeType, str | None]:
    """
    Return (edge_type, shared_with_facet_id_or_None).

    Classification rules (from APIR Part 1.3):
      - Shared edge + horizontal → ridge
      - Shared edge + diagonal   → hip
      - Non-shared + horizontal  → eave
      - Non-shared + diagonal    → rake

    Valley detection is deferred — valleys are shared edges where both
    facets slope downward toward the line, distinguishable only from 3D
    pitch context. For Phase 1 we mark them as hips and let manual
    correction promote to "valley" in the review UI.
    """
    shared_with = find_shared_facet(
        edge_start, edge_end, own_facet_id, all_facets, tol_px
    )
    horizontal = is_horizontal_edge(edge_start, edge_end)
    if shared_with is not None:
        return ("ridge" if horizontal else "hip", shared_with)
    return ("eave" if horizontal else "rake", None)


# ─────────────────────────────────────────────────────────────────────────
# Pitch math — projected area → sloped surface area
# ─────────────────────────────────────────────────────────────────────────

def parse_pitch(pitch: str) -> tuple[int, int]:
    """'5/12' → (5, 12). Defaults to (5, 12) on parse failure."""
    try:
        rise_s, run_s = pitch.split("/")
        return (int(rise_s.strip()), int(run_s.strip()))
    except (ValueError, AttributeError):
        return (5, 12)


def pitch_to_degrees(pitch: str) -> float:
    rise, run = parse_pitch(pitch)
    if run == 0:
        return 0.0
    return math.degrees(math.atan2(rise, run))


def pitch_multiplier(pitch: str) -> float:
    """
    Slope multiplier: sloped surface area = projected area × multiplier.
    For 5/12 pitch → 1.083. For flat → 1.000.
    """
    rise, run = parse_pitch(pitch)
    if run == 0:
        return 1.0
    angle = math.atan2(rise, run)
    cos_a = math.cos(angle)
    if cos_a <= 0:
        return 1.0
    return 1.0 / cos_a


def actual_roof_area_sqft(projected_sqft: float, pitch: str) -> float:
    return projected_sqft * pitch_multiplier(pitch)


# ─────────────────────────────────────────────────────────────────────────
# Slope direction from facet geometry
# ─────────────────────────────────────────────────────────────────────────

def slope_direction_from_eave(eave_start: PointPx, eave_end: PointPx) -> SlopeDirection:
    """
    The slope direction is perpendicular to the eave, pointing away from
    the ridge (i.e. downhill). Without 3D context we assume "downhill" is
    the direction away from the polygon's centroid — but the simpler and
    more robust heuristic is: slope-direction's compass quadrant is
    perpendicular to the eave's compass orientation.

    Screen-coord convention: +x = east, +y = south (image-pixel space).
    A horizontal eave (running east-west) → slope is N or S.
    A vertical eave (running north-south) → slope is E or W.

    We can't tell N vs S (or E vs W) without knowing where the ridge is,
    so we default to S/E (most common for residential — south- and
    east-facing slopes get the sun). Manual review can flip them.
    """
    dx = eave_end.x - eave_start.x
    dy = eave_end.y - eave_start.y
    if abs(dx) >= abs(dy):
        # eave is more horizontal than vertical → slope is N/S
        return "S"
    return "E"


def slope_direction_perpendicular_to_centroid(
    eave_start: PointPx, eave_end: PointPx, centroid: PointPx
) -> SlopeDirection:
    """
    Better heuristic: pick the perpendicular direction that points FROM
    the eave AWAY from the centroid — that's downhill (ridge is on the
    centroid side). Falls back to S if eave is degenerate.
    """
    dx = eave_end.x - eave_start.x
    dy = eave_end.y - eave_start.y
    if dx == 0 and dy == 0:
        return "S"
    # Perpendicular vector (rotated 90° clockwise in screen coords):
    perp_x, perp_y = -dy, dx
    # Midpoint of the eave
    mid_x = (eave_start.x + eave_end.x) / 2
    mid_y = (eave_start.y + eave_end.y) / 2
    # Vector from centroid to eave midpoint (downhill direction)
    down_x = mid_x - centroid.x
    down_y = mid_y - centroid.y
    # Project downhill onto perpendicular sign
    sign = 1 if (perp_x * down_x + perp_y * down_y) >= 0 else -1
    fx, fy = perp_x * sign, perp_y * sign
    # Pick the dominant axis
    if abs(fx) >= abs(fy):
        return "E" if fx > 0 else "W"
    return "S" if fy > 0 else "N"


# ─────────────────────────────────────────────────────────────────────────
# Facet measurement (one-call convenience for the extraction orchestrator)
# ─────────────────────────────────────────────────────────────────────────

def measure_facet_edges(
    facet: RoofFacet,
    all_facets: Iterable[RoofFacet],
    pixels_per_foot: float,
) -> list[RoofEdge]:
    """
    Walk a facet's polygon, classify every edge, return RoofEdge[] with
    real-world length_ft. Caller is responsible for sloped-length
    adjustment (rakes × sqrt(1+(rise/12)²)) — see APIR memo on
    slope-adjusted edge length.
    """
    poly = facet.pixel_polygon
    n = len(poly)
    edges: list[RoofEdge] = []
    for i in range(n):
        j = (i + 1) % n
        a, b = poly[i], poly[j]
        etype, shared_with = classify_edge(a, b, facet.id, all_facets)
        edges.append(
            RoofEdge(
                type=etype,
                length_ft=edge_length_ft(a, b, pixels_per_foot),
                pixel_start=a,
                pixel_end=b,
                shared_with=shared_with,
            )
        )

    # Hip-facet pattern fix: if a facet has exactly ONE non-shared edge, that
    # edge is the eave regardless of its on-screen angle. Hip facets are
    # triangles with two shared diagonal hips and one wall-bearing eave; that
    # eave is vertical in screen-coords when the wall runs N-S, which would
    # otherwise get misclassified as a "rake" by the angle heuristic.
    non_shared = [i for i, e in enumerate(edges) if e.shared_with is None]
    if len(non_shared) == 1:
        idx = non_shared[0]
        original = edges[idx]
        if original.type != "eave":
            edges[idx] = RoofEdge(
                type="eave",
                length_ft=original.length_ft,
                pixel_start=original.pixel_start,
                pixel_end=original.pixel_end,
                shared_with=None,
            )
    return edges


def sum_edge_lengths_by_type(facets: Iterable[RoofFacet]) -> dict[str, float]:
    """
    Aggregate ridge/hip/valley/eave/rake lengths across all facets.
    Shared edges (ridges, hips) are counted ONCE — even though each facet
    holds its own copy of the edge, we deduplicate by (sorted endpoints).
    """
    seen_shared: set[tuple] = set()
    totals: dict[str, float] = {
        "ridges_ft": 0.0, "hips_ft": 0.0, "valleys_ft": 0.0,
        "eaves_ft": 0.0, "rakes_ft": 0.0, "flashing_ft": 0.0,
        "step_flashing_ft": 0.0,
    }
    type_to_key = {
        "ridge": "ridges_ft", "hip": "hips_ft", "valley": "valleys_ft",
        "eave": "eaves_ft", "rake": "rakes_ft", "flashing": "flashing_ft",
        "step_flashing": "step_flashing_ft",
    }
    for facet in facets:
        for e in facet.edges:
            key = type_to_key.get(e.type)
            if key is None:
                continue
            if e.shared_with is not None:
                # Deduplicate by sorted endpoints (tolerant to flip)
                pa = (round(e.pixel_start.x, 1), round(e.pixel_start.y, 1))
                pb = (round(e.pixel_end.x, 1), round(e.pixel_end.y, 1))
                signature = tuple(sorted([pa, pb]))
                if signature in seen_shared:
                    continue
                seen_shared.add(signature)
            totals[key] += e.length_ft
    totals["drip_edge_ft"] = totals["eaves_ft"] + totals["rakes_ft"]
    return totals
