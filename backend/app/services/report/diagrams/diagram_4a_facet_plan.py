"""
Diagram 4a — Flat Roof Facet Plan.

Top-down view of every roof facet unfolded into a single plane. Contractors
read individual facet areas + edge lengths off this. Each facet is filled by
its pitch group; edges are colored by type (ridge red, hip orange, valley
blue, eave black, rake green dashed); dimension labels sit perpendicular to
each edge, offset outward.

Input: list of RoofFacet (from PropertyMeasurements.roof.facets).
Output: standalone SVG string ready for HTML embedding.

Implementation notes:
  * Scale-to-fit via fit_polygons_to_diagram (preserves aspect, centers).
  * Shared edges (ridges/hips) drawn ONCE — we deduplicate by sorted endpoints.
  * Dimension labels placed at midpoint + 12px outward normal.
  * Outward direction is computed from the polygon centroid.
"""
from __future__ import annotations

import math
from typing import Iterable

from app.schemas.apir import RoofFacet
from app.services.report.diagrams.svg_primitives import (
    DIAGRAM_INNER_WIDTH, DIAGRAM_MARGIN_LEFT, DIAGRAM_MARGIN_TOP, EDGE_Z_ORDER,
    FONT_SIZE_DIM, FONT_FAMILY, compass_rose, edge_style_attrs, facet_label,
    fit_polygons_to_diagram, format_linear, pitch_group_fill,
    standard_roof_legend, svg_document, text, text_bbox, nudge_clear, TextBox,
)


# Vertical space the legend + compass occupy at the bottom of the diagram.
LEGEND_GUTTER_HEIGHT = 110


def render_facet_plan(facets: list[RoofFacet]) -> str:
    """
    Build the full SVG for the flat facet plan.
    Empty facet list → returns a minimal placeholder SVG.
    """
    if not facets:
        body = text(340, 60, "No roof facets to display", font_size=12, fill="#888888")
        return svg_document(body, 120)

    # 1. Fit every facet polygon into the inner diagram area
    poly_tuples = [
        [(p.x, p.y) for p in f.pixel_polygon] for f in facets
    ]
    transform, diagram_h = fit_polygons_to_diagram(
        poly_tuples,
        target_top=DIAGRAM_MARGIN_TOP,
        target_left=DIAGRAM_MARGIN_LEFT,
        inner_width=DIAGRAM_INNER_WIDTH,
        max_inner_height=550,
    )

    total_height = DIAGRAM_MARGIN_TOP + diagram_h + LEGEND_GUTTER_HEIGHT

    parts: list[str] = []

    # 2. Background tint
    parts.append(
        f'<rect x="0" y="0" width="680" height="{total_height:.0f}" fill="#FFFFFF"/>'
    )

    # 3. Facet fills (drawn first — bottom of z-order)
    for facet in facets:
        fill, stroke = pitch_group_fill(facet.pitch)
        pts = " ".join(
            f"{transform.apply(p.x, p.y)[0]:.1f},{transform.apply(p.x, p.y)[1]:.1f}"
            for p in facet.pixel_polygon
        )
        parts.append(
            f'<polygon points="{pts}" fill="{fill}" stroke="{stroke}" stroke-width="0.5" />'
        )

    # 4. Edges — collect ALL edges across facets, dedup shared ones, draw in z-order
    edges = _collect_unique_edges(facets)
    edges.sort(key=lambda e: EDGE_Z_ORDER.get(e["type"], 0))
    for e in edges:
        sx, sy = transform.apply(e["start_x"], e["start_y"])
        ex, ey = transform.apply(e["end_x"], e["end_y"])
        parts.append(
            f'<line x1="{sx:.1f}" y1="{sy:.1f}" x2="{ex:.1f}" y2="{ey:.1f}" '
            f'{edge_style_attrs(e["type"])}/>'
        )

    # 5. Facet labels at each centroid
    placed_boxes: list[TextBox] = []
    for facet in facets:
        cx, cy = transform.apply(facet.centroid_px.x, facet.centroid_px.y)
        # Reserve a 3-line bbox so dimension labels can avoid it
        bbox = TextBox(x=cx - 30, y=cy - 12, w=60, h=32)
        placed_boxes.append(bbox)
        parts.append(facet_label(
            cx=cx, cy=cy, facet_id=facet.id,
            area_sqft=facet.actual_area_sqft,
            pitch=facet.pitch,
            slope_direction=facet.slope_direction,
        ))

    # 6. Edge dimension labels (perpendicular-outward + collision-aware nudge)
    for facet in facets:
        cx_px = facet.centroid_px.x
        cy_px = facet.centroid_px.y
        for edge in facet.edges:
            ax_px, ay_px = edge.pixel_start.x, edge.pixel_start.y
            bx_px, by_px = edge.pixel_end.x, edge.pixel_end.y
            # Midpoint + outward perpendicular in pixel space
            mid_px = ((ax_px + bx_px) / 2, (ay_px + by_px) / 2)
            ndir = _outward_perpendicular(
                ax_px, ay_px, bx_px, by_px, cx_px, cy_px,
            )
            # Move 12 diagram-pixels outward (convert via transform.scale)
            offset_px = 12 / max(transform.scale, 0.01)
            lbl_px = (mid_px[0] + ndir[0] * offset_px,
                      mid_px[1] + ndir[1] * offset_px)
            lx, ly = transform.apply(lbl_px[0], lbl_px[1])
            label_text = format_linear(edge.length_ft)
            proposed = text_bbox(label_text, lx, ly, font_size=FONT_SIZE_DIM)
            final_box = nudge_clear(proposed, placed_boxes)
            placed_boxes.append(final_box)
            final_cx = final_box.x + final_box.w / 2
            final_cy = final_box.y + final_box.h / 2 + 3   # +3 to baseline
            parts.append(text(
                final_cx, final_cy, label_text,
                font_size=FONT_SIZE_DIM, fill="#444444",
            ))

    # 7. Legend (bottom-left), compass rose (bottom-right)
    legend_y = DIAGRAM_MARGIN_TOP + diagram_h + 16
    parts.append(standard_roof_legend(x=20, y=legend_y))
    parts.append(compass_rose(cx=640, cy=total_height - 45))

    return svg_document("".join(parts), total_height)


# ─────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────

def _collect_unique_edges(facets: Iterable[RoofFacet]) -> list[dict]:
    """
    Walk every facet's edges. For shared edges (ridges/hips), include only
    one copy — keyed by sorted endpoint pairs rounded to 0.1px.
    """
    seen: set[tuple] = set()
    out: list[dict] = []
    for facet in facets:
        for e in facet.edges:
            pa = (round(e.pixel_start.x, 1), round(e.pixel_start.y, 1))
            pb = (round(e.pixel_end.x, 1), round(e.pixel_end.y, 1))
            sig = tuple(sorted([pa, pb]))
            if sig in seen:
                continue
            seen.add(sig)
            out.append({
                "type": e.type,
                "start_x": e.pixel_start.x, "start_y": e.pixel_start.y,
                "end_x": e.pixel_end.x, "end_y": e.pixel_end.y,
            })
    return out


def _outward_perpendicular(
    ax: float, ay: float, bx: float, by: float,
    cx: float, cy: float,
) -> tuple[float, float]:
    """
    Unit perpendicular to AB pointing AWAY from the centroid C.
    Used to place dimension labels outside the polygon.
    """
    dx = bx - ax
    dy = by - ay
    # 90° CCW perpendicular in screen coords
    px = -dy
    py = dx
    # Pick the sign that points away from the centroid
    mid_x = (ax + bx) / 2
    mid_y = (ay + by) / 2
    if (px * (mid_x - cx) + py * (mid_y - cy)) < 0:
        px, py = -px, -py
    length = math.hypot(px, py)
    if length <= 0:
        return (0.0, -1.0)
    return (px / length, py / length)
