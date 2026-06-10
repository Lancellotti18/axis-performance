"""
Diagram: 2.5D Pitch View — replaces APIR's skipped Diagram 4b (3D isometric).

Same polygon coordinates as Diagram 4a, but rendered with:
  * Directional shading per facet (south-facing slopes brighter, north
    darker — simulates sunlight from the top of the page)
  * Slope-direction arrows in the center of each facet
  * No dimension labels (Page 2's facet table carries those)

The visual cue mimics 3D depth without the cabinet-projection math. Looks
dimensional in the report's "Roof Summary" column without the ~1 week of
work the true isometric would have required.

Used by:
  * Page 2 right column ("3D-ish" facet view next to the roof stat tables)
  * Page 6 right half ("Pitch diagram — facets shaded by pitch, arrows
    show slope direction")
"""
from __future__ import annotations

import math

from app.schemas.apir import RoofFacet, SlopeDirection
from app.services.report.diagrams.svg_primitives import (
    DIAGRAM_INNER_WIDTH, DIAGRAM_MARGIN_LEFT, DIAGRAM_MARGIN_TOP, FONT_FAMILY,
    EDGE_Z_ORDER, compass_rose, edge_style_attrs, fit_polygons_to_diagram,
    pitch_group_fill, svg_document, text,
)


SLOPE_DIRECTION_VECTORS: dict[str, tuple[float, float]] = {
    # Screen coords: +x = east, +y = south. Vector points DOWN-SLOPE.
    "N": (0.0, -1.0),
    "S": (0.0, 1.0),
    "E": (1.0, 0.0),
    "W": (-1.0, 0.0),
    "NE": (0.707, -0.707),
    "NW": (-0.707, -0.707),
    "SE": (0.707, 0.707),
    "SW": (-0.707, 0.707),
}

# Sun comes from above (north on the diagram). Facets facing south get the
# brightest shading; north-facing get the darkest. Multiplier applied to the
# base pitch-group fill.
SLOPE_BRIGHTNESS: dict[str, float] = {
    "S": 1.10, "SE": 1.06, "SW": 1.06,
    "E": 1.00, "W": 1.00,
    "NE": 0.93, "NW": 0.93,
    "N": 0.88,
}


def render_pitch_view(
    facets: list[RoofFacet],
    *,
    width: int = 680,
    max_height: int = 420,
    show_arrows: bool = True,
    show_labels: bool = True,
) -> str:
    """
    Render the 2.5D pitch view. The width default is 680 (full page); pass
    width=320 for a compact half-column rendering.
    """
    if not facets:
        return svg_document(
            text(width / 2, 60, "No roof facets to display",
                 font_size=12, fill="#888888"),
            120,
        )

    # When rendering at a non-default width, scale the inner area proportionally
    inner_left = DIAGRAM_MARGIN_LEFT if width >= 680 else 20
    inner_right = 60 if width >= 680 else 20
    inner_width = width - inner_left - inner_right

    poly_tuples = [
        [(p.x, p.y) for p in f.pixel_polygon] for f in facets
    ]
    transform, diagram_h = fit_polygons_to_diagram(
        poly_tuples,
        target_top=DIAGRAM_MARGIN_TOP,
        target_left=inner_left,
        inner_width=inner_width,
        max_inner_height=max_height,
    )
    total_height = DIAGRAM_MARGIN_TOP + diagram_h + 70

    parts: list[str] = []
    parts.append(
        f'<rect x="0" y="0" width="{width}" height="{total_height:.0f}" fill="#FFFFFF"/>'
    )

    # 1. Shaded facet fills
    for facet in facets:
        base_fill, base_stroke = pitch_group_fill(facet.pitch)
        bright = SLOPE_BRIGHTNESS.get(facet.slope_direction, 1.0)
        shaded_fill = _adjust_brightness(base_fill, bright)
        pts = " ".join(
            f"{transform.apply(p.x, p.y)[0]:.1f},{transform.apply(p.x, p.y)[1]:.1f}"
            for p in facet.pixel_polygon
        )
        parts.append(
            f'<polygon points="{pts}" fill="{shaded_fill}" '
            f'stroke="{base_stroke}" stroke-width="0.8"/>'
        )

    # 2. Edges — only show ridges + hips (the structural lines that
    #    sell the 3D feel). Eaves/rakes would clutter the compact view.
    seen: set[tuple] = set()
    for facet in facets:
        for e in sorted(facet.edges, key=lambda x: EDGE_Z_ORDER.get(x.type, 0)):
            if e.type not in ("ridge", "hip"):
                continue
            pa = (round(e.pixel_start.x, 1), round(e.pixel_start.y, 1))
            pb = (round(e.pixel_end.x, 1), round(e.pixel_end.y, 1))
            sig = tuple(sorted([pa, pb]))
            if sig in seen:
                continue
            seen.add(sig)
            sx, sy = transform.apply(e.pixel_start.x, e.pixel_start.y)
            ex, ey = transform.apply(e.pixel_end.x, e.pixel_end.y)
            parts.append(
                f'<line x1="{sx:.1f}" y1="{sy:.1f}" '
                f'x2="{ex:.1f}" y2="{ey:.1f}" '
                f'{edge_style_attrs(e.type)}/>'
            )

    # 3. Slope arrows + facet labels
    if show_arrows or show_labels:
        for facet in facets:
            cx, cy = transform.apply(facet.centroid_px.x, facet.centroid_px.y)
            if show_arrows:
                vec = SLOPE_DIRECTION_VECTORS.get(facet.slope_direction, (0.0, 1.0))
                arrow_len = 18
                ax = cx - vec[0] * arrow_len / 2
                ay = cy - vec[1] * arrow_len / 2
                bx = cx + vec[0] * arrow_len / 2
                by = cy + vec[1] * arrow_len / 2
                parts.append(
                    f'<line x1="{ax:.1f}" y1="{ay:.1f}" '
                    f'x2="{bx:.1f}" y2="{by:.1f}" '
                    f'stroke="#1B3A6B" stroke-width="1.5" '
                    f'marker-end="url(#dimArr)"/>'
                )
            if show_labels:
                parts.append(text(
                    cx, cy - 16, facet.id,
                    font_size=10, weight="600", fill="#1B3A6B",
                ))

    # 4. Compass rose (bottom-right of whatever width we're at)
    parts.append(compass_rose(cx=width - 30, cy=total_height - 35))

    return _custom_svg_document("".join(parts), width=width, height=total_height)


# ─────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────

def _adjust_brightness(hex_color: str, factor: float) -> str:
    """Multiply each RGB channel by factor, clamped to [0, 255]."""
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return hex_color
    try:
        r = int(h[0:2], 16)
        g = int(h[2:4], 16)
        b = int(h[4:6], 16)
    except ValueError:
        return hex_color
    r = max(0, min(255, int(r * factor)))
    g = max(0, min(255, int(g * factor)))
    b = max(0, min(255, int(b * factor)))
    return f"#{r:02X}{g:02X}{b:02X}"


def _custom_svg_document(body: str, *, width: int, height: float) -> str:
    """svg_document is hard-coded to width=680; provide an override."""
    from app.services.report.diagrams.svg_primitives import DIMENSION_DEFS
    h = max(int(math.ceil(height)), 100)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {width} {h}" width="{width}" height="{h}">'
        f'{DIMENSION_DEFS}'
        f'{body}'
        f'</svg>'
    )
