"""
Diagram 4e — Soffit Plan.

Top-down view of the building footprint with colored bands extending outward
from each wall — band width proportional to soffit depth (amplified 3× per
APIR's spec, since real soffit depths are small relative to wall lengths).

Color ramp (teal):
  1"–3":  light  (#B8E0DA)
  3"–6":  medium (#5BAFA3)
  6"–12": dark   (#1B6B5F)
  12"+:   deep   (#0E3D38)

For each footprint segment we look up the matching soffit segment by closest
length match. If a footprint wall doesn't have a clean match, we fall back to
the median soffit depth across all segments.
"""
from __future__ import annotations

import math
import statistics
from typing import Optional

from app.schemas.apir import Footprint, Soffit, SoffitSegment
from app.services.report.diagrams.svg_primitives import (
    DIAGRAM_INNER_WIDTH, DIAGRAM_MARGIN_LEFT, DIAGRAM_MARGIN_TOP, FONT_FAMILY,
    FONT_SIZE_DIM, compass_rose, fit_polygons_to_diagram, format_area,
    format_linear, legend, LegendEntry, svg_document, text,
)


BOTTOM_GUTTER_HEIGHT = 130
SOFFIT_DEPTH_AMPLIFY = 3.0  # APIR spec — bands are 3× visual scale


def render_soffit_plan(footprint: Footprint, soffit: Soffit) -> str:
    if not footprint.pixel_polygon or len(footprint.pixel_polygon) < 3:
        return svg_document(
            text(340, 60, "No footprint available for soffit plan",
                 font_size=12, fill="#888888"),
            120,
        )

    poly = footprint.pixel_polygon

    # Reserve extra outer gutter for the bands + labels
    outer_inset = 90
    transform, diagram_h = fit_polygons_to_diagram(
        [[(p.x, p.y) for p in poly]],
        target_top=DIAGRAM_MARGIN_TOP + outer_inset,
        target_left=DIAGRAM_MARGIN_LEFT + outer_inset,
        inner_width=DIAGRAM_INNER_WIDTH - outer_inset * 2,
        max_inner_height=400,
    )
    total_height = DIAGRAM_MARGIN_TOP + diagram_h + outer_inset * 2 + BOTTOM_GUTTER_HEIGHT

    parts: list[str] = []
    parts.append(
        f'<rect x="0" y="0" width="680" height="{total_height:.0f}" fill="#FFFFFF"/>'
    )

    # Compute centroid in diagram space (for outward direction)
    diag_pts = [transform.apply(p.x, p.y) for p in poly]
    cx_d = sum(p[0] for p in diag_pts) / len(diag_pts)
    cy_d = sum(p[1] for p in diag_pts) / len(diag_pts)

    # Match soffit segments to footprint walls by length (±15% tolerance)
    median_depth = (
        statistics.median(s.depth_in for s in soffit.breakdown)
        if soffit.breakdown else 6.0
    )

    # 1. Bands first (so the footprint sits on top of them)
    n = len(footprint.segments)
    for i, seg in enumerate(footprint.segments):
        ax, ay = transform.apply(seg.pixel_start.x, seg.pixel_start.y)
        bx, by = transform.apply(seg.pixel_end.x, seg.pixel_end.y)
        ox, oy = _outward_unit(ax, ay, bx, by, cx_d, cy_d)
        matched = _match_soffit(seg.length_ft, soffit.breakdown)
        depth_in = matched.depth_in if matched else median_depth
        # APIR amplification: bands depth_in/12 × scaleX × 3, capped so the
        # widest band stays inside the gutter we reserved.
        band_width = min(depth_in / 12.0 * transform.scale * SOFFIT_DEPTH_AMPLIFY * 5, outer_inset - 8)
        band_width = max(band_width, 6)  # always visible
        # Band is the quad: [a, b, b+offset, a+offset]
        p1 = (ax, ay)
        p2 = (bx, by)
        p3 = (bx + ox * band_width, by + oy * band_width)
        p4 = (ax + ox * band_width, ay + oy * band_width)
        fill = _depth_color(depth_in)
        pts = " ".join(f"{p[0]:.1f},{p[1]:.1f}" for p in [p1, p2, p3, p4])
        parts.append(
            f'<polygon points="{pts}" fill="{fill}" stroke="#FFFFFF" '
            f'stroke-width="0.8" opacity="0.85"/>'
        )
        # Label outside the band: depth + length + area
        if matched is not None:
            label_lines = [
                f"#{matched.id} · {int(round(matched.depth_in))}\"",
                f"{format_linear(matched.length_ft)} · {format_area(matched.area_sqft)}",
            ]
        else:
            label_lines = [
                f"{int(round(depth_in))}\"  (est.)",
                f"{format_linear(seg.length_ft)}",
            ]
        lbl_anchor_x = (ax + bx) / 2 + ox * (band_width + 14)
        lbl_anchor_y = (ay + by) / 2 + oy * (band_width + 14) + 3
        parts.append(text(lbl_anchor_x, lbl_anchor_y - 6, label_lines[0],
                          font_size=10, fill="#1B3A6B", weight="600"))
        parts.append(text(lbl_anchor_x, lbl_anchor_y + 7, label_lines[1],
                          font_size=9, fill="#666666"))

    # 2. Footprint polygon on top
    pts = " ".join(f"{p[0]:.1f},{p[1]:.1f}" for p in diag_pts)
    parts.append(
        f'<polygon points="{pts}" fill="#F0F3F8" stroke="#1B3A6B" stroke-width="2"/>'
    )
    # Stats inside the footprint
    parts.append(text(cx_d, cy_d - 6, "SOFFIT PLAN",
                      font_size=11, weight="600", fill="#1B3A6B"))
    parts.append(text(
        cx_d, cy_d + 9,
        f"Total: {format_linear(soffit.total_length_ft)} · {format_area(soffit.total_area_sqft)}",
        font_size=10, fill="#666666",
    ))

    # 3. Color legend (bottom-left)
    legend_y = total_height - BOTTOM_GUTTER_HEIGHT + 16
    depth_legend = [
        LegendEntry(color="#B8E0DA", label='1"–3" soffit depth', stroke_width=6),
        LegendEntry(color="#5BAFA3", label='3"–6" soffit depth', stroke_width=6),
        LegendEntry(color="#1B6B5F", label='6"–12" soffit depth', stroke_width=6),
        LegendEntry(color="#0E3D38", label='12"+ soffit depth', stroke_width=6),
    ]
    parts.append(legend(depth_legend, x=20, y=legend_y))

    # 4. Compass rose (bottom-right)
    parts.append(compass_rose(cx=640, cy=total_height - 45))

    return svg_document("".join(parts), total_height)


# ─────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────

def _match_soffit(
    wall_length_ft: float, breakdown: list[SoffitSegment],
) -> Optional[SoffitSegment]:
    """Find the soffit segment whose length is closest to the wall (±15%)."""
    if not breakdown:
        return None
    tol = max(wall_length_ft * 0.15, 1.5)
    best: Optional[SoffitSegment] = None
    best_err = float("inf")
    for s in breakdown:
        err = abs(s.length_ft - wall_length_ft)
        if err < best_err and err <= tol:
            best = s
            best_err = err
    return best


def _depth_color(depth_in: float) -> str:
    if depth_in < 3:
        return "#B8E0DA"
    if depth_in < 6:
        return "#5BAFA3"
    if depth_in < 12:
        return "#1B6B5F"
    return "#0E3D38"


def _outward_unit(
    ax: float, ay: float, bx: float, by: float,
    cx: float, cy: float,
) -> tuple[float, float]:
    dx, dy = bx - ax, by - ay
    px, py = -dy, dx
    mid_x = (ax + bx) / 2
    mid_y = (ay + by) / 2
    if px * (mid_x - cx) + py * (mid_y - cy) < 0:
        px, py = -px, -py
    length = math.hypot(px, py)
    if length <= 0:
        return (0.0, -1.0)
    return (px / length, py / length)
