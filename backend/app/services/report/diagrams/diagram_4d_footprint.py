"""
Diagram 4d — Building Footprint.

Top-down outline of the building with labeled wall segment lengths. The
shape comes from the contractor-drawn footprint polygon — an L-shaped
house produces an L-shaped diagram. No template shapes.

Layout (APIR 4d spec):
  * Filled footprint polygon (light navy)
  * Dimension line 18px outside each wall, with arrowheads, length label
    at the midpoint
  * Inside the polygon: orientation labels (BACK/FRONT/LEFT/RIGHT) plus
    a centered stats block (stories, perimeter, area)
  * Compass rose bottom-right
"""
from __future__ import annotations

import math

from app.schemas.apir import Footprint
from app.services.report.diagrams.svg_primitives import (
    DIAGRAM_INNER_WIDTH, DIAGRAM_MARGIN_LEFT, DIAGRAM_MARGIN_TOP, FONT_FAMILY,
    FONT_SIZE_DIM, compass_rose, dimension_line, edge_style_attrs,
    fit_polygons_to_diagram, format_area, format_linear, svg_document, text,
)


DIMENSION_OFFSET_PX = 18      # APIR spec: 18px outside the wall
BOTTOM_GUTTER_HEIGHT = 80     # compass rose lives here


def render_footprint(footprint: Footprint) -> str:
    """Build the footprint diagram SVG. Empty polygon → placeholder."""
    if not footprint.pixel_polygon or len(footprint.pixel_polygon) < 3:
        return svg_document(
            text(340, 60, "No footprint polygon available",
                 font_size=12, fill="#888888"),
            120,
        )

    poly = footprint.pixel_polygon

    # Reserve gutter for outside dimensions (a few pixels per side)
    inset = 30
    transform, diagram_h = fit_polygons_to_diagram(
        [[(p.x, p.y) for p in poly]],
        target_top=DIAGRAM_MARGIN_TOP + inset,
        target_left=DIAGRAM_MARGIN_LEFT + inset,
        inner_width=DIAGRAM_INNER_WIDTH - inset * 2,
        max_inner_height=480,
    )
    total_height = DIAGRAM_MARGIN_TOP + diagram_h + inset * 2 + BOTTOM_GUTTER_HEIGHT

    parts: list[str] = []
    parts.append(
        f'<rect x="0" y="0" width="680" height="{total_height:.0f}" fill="#FFFFFF"/>'
    )

    # 1. Filled footprint polygon
    pts = " ".join(
        f"{transform.apply(p.x, p.y)[0]:.1f},{transform.apply(p.x, p.y)[1]:.1f}"
        for p in poly
    )
    parts.append(
        f'<polygon points="{pts}" fill="#E8EEF5" stroke="#1B3A6B" stroke-width="2"/>'
    )

    # 2. Dimension lines + labels for each segment
    # Compute the centroid (in diagram space) so we can offset dims OUTWARD
    diag_pts = [transform.apply(p.x, p.y) for p in poly]
    cx_d = sum(p[0] for p in diag_pts) / len(diag_pts)
    cy_d = sum(p[1] for p in diag_pts) / len(diag_pts)

    for seg in footprint.segments:
        ax, ay = transform.apply(seg.pixel_start.x, seg.pixel_start.y)
        bx, by = transform.apply(seg.pixel_end.x, seg.pixel_end.y)
        ox, oy = _outward_unit(ax, ay, bx, by, cx_d, cy_d)
        # Shifted dimension line
        d_ax = ax + ox * DIMENSION_OFFSET_PX
        d_ay = ay + oy * DIMENSION_OFFSET_PX
        d_bx = bx + ox * DIMENSION_OFFSET_PX
        d_by = by + oy * DIMENSION_OFFSET_PX
        label = format_linear(seg.length_ft)
        # Place text on the outward side of the dim line, perpendicular offset
        lbl_x = (d_ax + d_bx) / 2 + ox * 8
        lbl_y = (d_ay + d_by) / 2 + oy * 8 + 3
        parts.append(dimension_line(
            d_ax, d_ay, d_bx, d_by,
            label="",  # label drawn separately at the rotation-friendly position
        ))
        parts.append(text(lbl_x, lbl_y, label,
                          font_size=FONT_SIZE_DIM, fill="#444444"))

    # 3. Orientation labels inside the polygon
    # APIR convention: front=south, back=north, right=east, left=west.
    # We pick anchor points just inside each wall midpoint.
    labels_xy: list[tuple[str, float, float]] = []
    for seg in footprint.segments:
        ax, ay = transform.apply(seg.pixel_start.x, seg.pixel_start.y)
        bx, by = transform.apply(seg.pixel_end.x, seg.pixel_end.y)
        ix, iy = _inward_unit(ax, ay, bx, by, cx_d, cy_d)
        mid_x = (ax + bx) / 2 + ix * 22
        mid_y = (ay + by) / 2 + iy * 22 + 3
        labels_xy.append((seg.direction.upper(), mid_x, mid_y))
    for direction, x, y in labels_xy:
        parts.append(text(x, y, direction, font_size=10, fill="#888888"))

    # 4. Stats block centered inside the polygon
    parts.append(text(
        cx_d, cy_d - 12, f"Number of stories: {footprint.number_of_stories}",
        font_size=11, fill="#1B3A6B",
    ))
    parts.append(text(
        cx_d, cy_d + 3,
        f"Perimeter: {format_linear(footprint.perimeter_ft)}",
        font_size=11, fill="#1B3A6B",
    ))
    parts.append(text(
        cx_d, cy_d + 18,
        f"Area: {format_area(footprint.area_sqft)}",
        font_size=11, weight="600", fill="#1B3A6B",
    ))

    # 5. Compass rose bottom-right
    parts.append(compass_rose(cx=640, cy=total_height - 35))

    return svg_document("".join(parts), total_height)


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


def _inward_unit(
    ax: float, ay: float, bx: float, by: float,
    cx: float, cy: float,
) -> tuple[float, float]:
    ox, oy = _outward_unit(ax, ay, bx, by, cx, cy)
    return (-ox, -oy)
