"""
Diagram 4c — Siding Elevation (one per: front, right, left, back).

Flat orthographic diagram of a single wall face. Shows:
  * Wall rectangle (scaled to fit, aspect-preserved)
  * Windows: blue-bordered white rectangles at detected positions
  * Doors: red-bordered white rectangles at bottom
  * Shutters: thin dark rectangles flanking windows that have shutters
  * Vents: small gray circles
  * Dimension annotations: wall width below, wall height rotated left,
    each window/door size labeled inside
  * Direction badge at top
"""
from __future__ import annotations

from typing import Optional

from app.schemas.apir import Door, SidingElevation, Window
from app.services.report.diagrams.svg_primitives import (
    DIAGRAM_INNER_WIDTH, DIAGRAM_MARGIN_LEFT, FONT_FAMILY, FONT_SIZE_DIM,
    compass_rose, dimension_line, format_linear, format_united_inches,
    svg_document, text,
)


WALL_TOP_Y = 70
LEFT_DIM_GUTTER = 50
RIGHT_PAD = 30
BOTTOM_DIM_GUTTER = 70
BOTTOM_LABEL_GUTTER = 60


def render_elevation(
    elev: SidingElevation,
    windows: list[Window],
    doors: list[Door],
) -> str:
    """
    Render one elevation. windows/doors should be the subset belonging to
    this elevation (caller filters by elevation_id).
    """
    if elev.wall_width_ft <= 0 or elev.wall_height_ft <= 0:
        return svg_document(
            text(340, 60, f"No wall data for {elev.elevation} elevation",
                 font_size=12, fill="#888888"),
            120,
        )

    # Compute scale that fits wall in the inner area, preserving aspect
    inner_w = DIAGRAM_INNER_WIDTH - LEFT_DIM_GUTTER - RIGHT_PAD
    # Pick scale so wall fits horizontally; clamp wall height too
    scale_x = inner_w / elev.wall_width_ft
    # Keep the wall height reasonable for the page slot (max 220px)
    max_wall_h_px = 220
    scale_y = max_wall_h_px / elev.wall_height_ft if elev.wall_height_ft > 0 else scale_x
    scale = min(scale_x, scale_y)
    wall_w_px = elev.wall_width_ft * scale
    wall_h_px = elev.wall_height_ft * scale

    wall_x = DIAGRAM_MARGIN_LEFT + LEFT_DIM_GUTTER
    wall_y = WALL_TOP_Y

    total_height = wall_y + wall_h_px + BOTTOM_DIM_GUTTER + BOTTOM_LABEL_GUTTER

    parts: list[str] = []
    parts.append(
        f'<rect x="0" y="0" width="680" height="{total_height:.0f}" fill="#FFFFFF"/>'
    )

    # 1. Elevation title (top)
    parts.append(text(
        DIAGRAM_MARGIN_LEFT + (DIAGRAM_INNER_WIDTH / 2), 40,
        f"{elev.elevation.upper()} ELEVATION",
        font_size=12, weight="600", fill="#1B3A6B",
    ))

    # 2. Wall rectangle (light siding tint)
    parts.append(
        f'<rect x="{wall_x:.1f}" y="{wall_y:.1f}" '
        f'width="{wall_w_px:.1f}" height="{wall_h_px:.1f}" '
        f'fill="#F5F5F0" stroke="#1A1A1A" stroke-width="1.5"/>'
    )

    # 3. Doors first (so windows can sit over them visually if overlapping
    #    inputs send oddities — doors are bottom-anchored, windows aren't)
    for door in doors:
        dx = wall_x + door.position_from_left_pct * wall_w_px \
             - (door.width_in / 12.0) * scale / 2
        dh = (door.height_in / 12.0) * scale
        dy = wall_y + wall_h_px - dh
        dw = (door.width_in / 12.0) * scale
        parts.append(
            f'<rect x="{dx:.1f}" y="{dy:.1f}" width="{dw:.1f}" height="{dh:.1f}" '
            f'fill="#FFFFFF" stroke="#CC2200" stroke-width="1.5"/>'
        )
        parts.append(text(
            dx + dw / 2, dy + dh / 2 + 4,
            f'{door.width_in}"×{door.height_in}"',
            font_size=9, fill="#1A1A1A",
        ))

    # 4. Windows + their shutters
    for win in windows:
        ww = (win.width_in / 12.0) * scale
        wh = (win.height_in / 12.0) * scale
        wx = wall_x + win.position_from_left_pct * wall_w_px - ww / 2
        wy = (wall_y + wall_h_px) - win.position_from_bottom_pct * wall_h_px - wh
        # Shutters flank the window (2px outside each edge, full window height)
        if win.has_shutters:
            for shutter_x in (wx - 6, wx + ww + 2):
                parts.append(
                    f'<rect x="{shutter_x:.1f}" y="{wy:.1f}" '
                    f'width="4" height="{wh:.1f}" '
                    f'fill="#2A4A6E"/>'
                )
        # Window itself
        parts.append(
            f'<rect x="{wx:.1f}" y="{wy:.1f}" width="{ww:.1f}" height="{wh:.1f}" '
            f'fill="#FFFFFF" stroke="#1A5FA8" stroke-width="1.2"/>'
        )
        # Crossbars (visual cue for windows)
        parts.append(
            f'<line x1="{wx + ww / 2:.1f}" y1="{wy:.1f}" '
            f'x2="{wx + ww / 2:.1f}" y2="{wy + wh:.1f}" '
            f'stroke="#1A5FA8" stroke-width="0.5"/>'
        )
        parts.append(
            f'<line x1="{wx:.1f}" y1="{wy + wh / 2:.1f}" '
            f'x2="{wx + ww:.1f}" y2="{wy + wh / 2:.1f}" '
            f'stroke="#1A5FA8" stroke-width="0.5"/>'
        )
        # Label centered (size in inches)
        parts.append(text(
            wx + ww / 2, wy + wh + 12,
            f'{win.width_in}"×{win.height_in}"',
            font_size=9, fill="#1A5FA8",
        ))

    # 5. Vents (gray circles, evenly distributed if count > 0)
    if elev.vent_count > 0:
        spacing = wall_w_px / (elev.vent_count + 1)
        vent_y = wall_y + 12
        for i in range(elev.vent_count):
            vent_x = wall_x + spacing * (i + 1)
            parts.append(
                f'<circle cx="{vent_x:.1f}" cy="{vent_y:.1f}" r="5" '
                f'fill="#AAAAAA" stroke="#666666" stroke-width="0.5"/>'
            )

    # 6. Dimension annotations
    # Wall width below
    dim_y = wall_y + wall_h_px + 30
    parts.append(dimension_line(
        wall_x, dim_y, wall_x + wall_w_px, dim_y, label="",
    ))
    parts.append(text(
        wall_x + wall_w_px / 2, dim_y + 14,
        format_linear(elev.wall_width_ft),
        font_size=FONT_SIZE_DIM, fill="#444444",
    ))
    # Wall height rotated on the left
    dim_x = wall_x - 20
    parts.append(dimension_line(
        dim_x, wall_y, dim_x, wall_y + wall_h_px, label="",
    ))
    parts.append(
        f'<text x="{dim_x - 8:.1f}" y="{wall_y + wall_h_px / 2:.1f}" '
        f'font-family="{FONT_FAMILY}" font-size="{FONT_SIZE_DIM}" '
        f'fill="#444444" text-anchor="middle" '
        f'transform="rotate(-90, {dim_x - 8:.1f}, {wall_y + wall_h_px / 2:.1f})">'
        f'{format_linear(elev.wall_height_ft)}</text>'
    )

    # 7. Stats badge bottom-right
    badge_x = wall_x + wall_w_px
    badge_y = total_height - 36
    badge_w = 160
    parts.append(
        f'<rect x="{badge_x - badge_w:.1f}" y="{badge_y - 18:.1f}" '
        f'width="{badge_w}" height="34" rx="4" ry="4" '
        f'fill="#F8F9FB" stroke="#CCCCCC" stroke-width="0.5"/>'
    )
    parts.append(text(
        badge_x - badge_w / 2, badge_y - 5,
        f"{elev.id} · {elev.material.title()}",
        font_size=10, weight="600", fill="#1B3A6B",
    ))
    parts.append(text(
        badge_x - badge_w / 2, badge_y + 9,
        f"Net: {int(round(elev.net_area_sqft))} ft²  ·  "
        f"Gross: {int(round(elev.gross_area_sqft))} ft²",
        font_size=9, fill="#666666",
    ))

    return svg_document("".join(parts), total_height)
