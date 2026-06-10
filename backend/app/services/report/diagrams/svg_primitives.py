"""
APIR diagram primitives — shared SVG building blocks.

Every diagram (4a, 4c×4, 4d, 4e, 4f, the 2.5D pitch view) uses these
helpers so colors, fonts, dimension arrows, compass roses, and legends
stay perfectly consistent.

Style rules are pinned to APIR Part 4's "Global SVG Rules":
  - viewBox always "0 0 680 H" where width is fixed at 680 and H is computed
  - font-family Inter, system-ui, sans-serif on every <text>
  - Font sizes: 13px facet IDs, 11px dimensions/sublabels, 9px legend
  - Edge stroke colors per type (ridge red, hip orange, valley dashed blue,
    eave black, rake dashed green, flashing/step amber dashed)
  - Pitch-group fill colors (flat amber, 3-6/12 green, 7-9/12 blue, 10+ purple)

Number formatters:
  - format_linear: 84.92 → "84' 11""
  - format_area: 1325.4 → "1,325 ft²"
  - format_squares: rounds UP to nearest 0.25 → "13½", "14¼", "15"
  - format_pct: 12.0 → "12.0%"
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional


# ─────────────────────────────────────────────────────────────────────────
# Layout constants (APIR Part 4 globals)
# ─────────────────────────────────────────────────────────────────────────

SVG_WIDTH = 680
DIAGRAM_MARGIN_LEFT = 60
DIAGRAM_MARGIN_RIGHT = 60
DIAGRAM_MARGIN_TOP = 50
DIAGRAM_INNER_WIDTH = SVG_WIDTH - DIAGRAM_MARGIN_LEFT - DIAGRAM_MARGIN_RIGHT  # 560

FONT_FAMILY = "Inter, system-ui, sans-serif"
FONT_SIZE_FACET_ID = 13
FONT_SIZE_DIM = 11
FONT_SIZE_LEGEND = 9

# Approximate px width of a single Inter character at the given size.
# Used by collision detection — close enough for stay-out-of-each-other math.
PX_PER_CHAR_11 = 6.5
PX_PER_CHAR_9 = 5.4


# ─────────────────────────────────────────────────────────────────────────
# Edge stroke colors (APIR Part 4 globals)
# ─────────────────────────────────────────────────────────────────────────

EDGE_STYLES: dict[str, dict[str, str]] = {
    "ridge":         {"stroke": "#CC2200", "stroke-width": "2.5"},
    "hip":           {"stroke": "#CC5500", "stroke-width": "2"},
    "valley":        {"stroke": "#1A5FA8", "stroke-width": "1.5", "stroke-dasharray": "6,3"},
    "eave":          {"stroke": "#1A1A1A", "stroke-width": "2"},
    "rake":          {"stroke": "#1A7A3C", "stroke-width": "1.5", "stroke-dasharray": "6,3"},
    "step_flashing": {"stroke": "#CC7700", "stroke-width": "2",   "stroke-dasharray": "3,3"},
    "flashing":      {"stroke": "#CC7700", "stroke-width": "1.5", "stroke-dasharray": "3,3"},
    "dimension":     {"stroke": "#888888", "stroke-width": "0.5"},
}

# Z-order key — higher values render later (more visible). Used by callers
# to sort edges before emitting <line> elements.
EDGE_Z_ORDER: dict[str, int] = {
    "valley": 1, "eave": 2, "rake": 3, "hip": 4, "ridge": 5,
    "step_flashing": 6, "flashing": 6, "dimension": 7,
}


def edge_style_attrs(edge_type: str) -> str:
    """Return SVG attribute string for an edge of the given type."""
    style = EDGE_STYLES.get(edge_type, EDGE_STYLES["dimension"])
    return " ".join(f'{k}="{v}"' for k, v in style.items())


# ─────────────────────────────────────────────────────────────────────────
# Pitch-group fill colors
# ─────────────────────────────────────────────────────────────────────────

def pitch_group_fill(pitch: str) -> tuple[str, str]:
    """
    Return (fill_hex, stroke_hex) for a pitch like '5/12'.
      Flat / ≤ 2/12: amber
      3/12 – 6/12: green
      7/12 – 9/12: blue
      ≥ 10/12: purple
    """
    try:
        rise = int(pitch.split("/")[0])
    except (ValueError, AttributeError):
        rise = 5
    if rise <= 2:
        return "#FAEEDA", "#854F0B"     # amber
    if rise <= 6:
        return "#EAF3DE", "#3B6D11"     # green
    if rise <= 9:
        return "#E6F1FB", "#185FA5"     # blue
    return "#F0E8F8", "#534AB7"         # purple


# ─────────────────────────────────────────────────────────────────────────
# SVG <defs> — dimension arrow marker (APIR Part 4 spec)
# ─────────────────────────────────────────────────────────────────────────

DIMENSION_DEFS = """<defs>
  <marker id="dimArr" viewBox="0 0 8 8" refX="7" refY="4"
          markerWidth="4" markerHeight="4" orient="auto-start-reverse">
    <path d="M1 1L7 4L1 7" fill="none" stroke="#888888"
          stroke-width="1.5" stroke-linecap="round"/>
  </marker>
</defs>"""


# ─────────────────────────────────────────────────────────────────────────
# Compass rose (APIR Part 4 spec)
# ─────────────────────────────────────────────────────────────────────────

def compass_rose(cx: float = 640, cy: float = 0.0, svg_height: Optional[float] = None) -> str:
    """
    Build a compass rose. If svg_height is supplied, cy defaults to (svg_height-45).
    Caller can override cx/cy explicitly when placing in non-default location.
    """
    if svg_height is not None and cy == 0.0:
        cy = svg_height - 45
    return f"""<g class="compass">
  <circle cx="{cx}" cy="{cy}" r="18" fill="#F0F3F8" stroke="#CCCCCC" stroke-width="0.5"/>
  <text x="{cx}" y="{cy-4}" text-anchor="middle"
        font-family="{FONT_FAMILY}" font-size="10" font-weight="600" fill="#1B3A6B">N</text>
  <line x1="{cx}" y1="{cy-2}" x2="{cx}" y2="{cy-13}" stroke="#1B3A6B" stroke-width="1.5"/>
  <polygon points="{cx},{cy-16} {cx-3},{cy-9} {cx+3},{cy-9}" fill="#1B3A6B"/>
  <text x="{cx}" y="{cy+14}" text-anchor="middle" font-family="{FONT_FAMILY}" font-size="9" fill="#888888">S</text>
  <text x="{cx-13}" y="{cy+4}" text-anchor="middle" font-family="{FONT_FAMILY}" font-size="9" fill="#888888">W</text>
  <text x="{cx+13}" y="{cy+4}" text-anchor="middle" font-family="{FONT_FAMILY}" font-size="9" fill="#888888">E</text>
</g>"""


# ─────────────────────────────────────────────────────────────────────────
# Legend (APIR Part 4 spec)
# ─────────────────────────────────────────────────────────────────────────

@dataclass
class LegendEntry:
    color: str
    label: str
    dasharray: str = ""
    stroke_width: float = 1.5


def legend(entries: list[LegendEntry], x: float, y: float) -> str:
    """
    Build a vertical legend with 14px row spacing, wrapped in a rounded
    light-gray box. Each row: 20px colored line sample + label text.
    """
    if not entries:
        return ""
    row_h = 14
    pad_x = 8
    pad_y = 6
    text_w = max(len(e.label) for e in entries) * PX_PER_CHAR_9 + 4
    box_w = 20 + 6 + text_w + pad_x * 2
    box_h = row_h * len(entries) + pad_y * 2
    rows: list[str] = []
    rows.append(
        f'<rect x="{x}" y="{y}" width="{box_w:.0f}" height="{box_h:.0f}" '
        f'rx="4" ry="4" fill="#F8F9FB" stroke="#CCCCCC" stroke-width="0.5"/>'
    )
    for i, e in enumerate(entries):
        cy = y + pad_y + i * row_h + row_h / 2
        line_x1 = x + pad_x
        line_x2 = line_x1 + 20
        dash = f' stroke-dasharray="{e.dasharray}"' if e.dasharray else ""
        rows.append(
            f'<line x1="{line_x1}" y1="{cy:.1f}" x2="{line_x2}" y2="{cy:.1f}" '
            f'stroke="{e.color}" stroke-width="{e.stroke_width}"{dash}/>'
        )
        rows.append(
            f'<text x="{line_x2 + 6}" y="{cy + 3:.1f}" font-family="{FONT_FAMILY}" '
            f'font-size="{FONT_SIZE_LEGEND}" fill="#444444">{escape_xml(e.label)}</text>'
        )
    return '<g class="legend">' + "".join(rows) + "</g>"


def standard_roof_legend(x: float, y: float) -> str:
    """The canonical legend used on the facet plan and footprint diagrams."""
    return legend([
        LegendEntry(color="#CC2200", label="Ridge", stroke_width=2.5),
        LegendEntry(color="#CC5500", label="Hip", stroke_width=2),
        LegendEntry(color="#1A5FA8", label="Valley", dasharray="6,3", stroke_width=1.5),
        LegendEntry(color="#1A1A1A", label="Eave", stroke_width=2),
        LegendEntry(color="#1A7A3C", label="Rake", dasharray="6,3", stroke_width=1.5),
        LegendEntry(color="#CC7700", label="Step flashing", dasharray="3,3", stroke_width=2),
    ], x, y)


# ─────────────────────────────────────────────────────────────────────────
# Number formatters (APIR Part 8 spec)
# ─────────────────────────────────────────────────────────────────────────

def format_linear(decimal_feet: float) -> str:
    """84.92 → "84' 11""  ·  30.0 → "30' 0""  ·  0.75 → "0' 9""."""
    if decimal_feet < 0:
        return "0' 0\""
    feet = int(decimal_feet)
    inches = round((decimal_feet - feet) * 12)
    if inches == 12:
        return f"{feet + 1}' 0\""
    return f"{feet}' {inches}\""


def format_area(sqft: float) -> str:
    """1325.4 → "1,325 ft²"."""
    return f"{round(sqft):,} ft²"


_FRACTION_GLYPH = {0.25: "¼", 0.5: "½", 0.75: "¾"}


def format_squares(sqft: float) -> str:
    """
    APIR Part 8: round UP to nearest 0.25 squares. 1485.5sqft → 14.855sq →
    ceil(14.855 / 0.25) × 0.25 = 14.875 → not a clean quarter, round to next
    0.25 → 15. Use the same ceiling-to-quarter approach.

    Display:
      whole numbers as "15"
      0.25/0.5/0.75 with the glyph: "14¼", "14½", "14¾"
    """
    raw = sqft / 100.0
    rounded = math.ceil(raw * 4) / 4.0
    whole = int(rounded)
    frac = round(rounded - whole, 2)
    glyph = _FRACTION_GLYPH.get(frac, "")
    if not glyph:
        return f"{whole}"
    return f"{whole}{glyph}"


def format_pct(pct: float) -> str:
    return f"{pct:.1f}%"


def format_united_inches(width_in: float, height_in: float) -> str:
    return f'{int(round(width_in + height_in))}"'


# ─────────────────────────────────────────────────────────────────────────
# XML escaping (cheap, sufficient for diagram text)
# ─────────────────────────────────────────────────────────────────────────

def escape_xml(text: str) -> str:
    if text is None:
        return ""
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


# ─────────────────────────────────────────────────────────────────────────
# Pixel-to-diagram coordinate transform
# ─────────────────────────────────────────────────────────────────────────

@dataclass
class DiagramTransform:
    """
    Affine transform from satellite-pixel space → diagram SVG space.
    Built by `fit_polygons_to_diagram` so a multi-polygon group fits the
    inner width / inner height with preserved aspect ratio and centered.
    """
    scale: float
    offset_x: float
    offset_y: float

    def apply(self, x: float, y: float) -> tuple[float, float]:
        return (x * self.scale + self.offset_x,
                y * self.scale + self.offset_y)


def fit_polygons_to_diagram(
    polygons: list[list[tuple[float, float]]],
    *,
    target_top: float = DIAGRAM_MARGIN_TOP,
    target_left: float = DIAGRAM_MARGIN_LEFT,
    inner_width: float = DIAGRAM_INNER_WIDTH,
    max_inner_height: float = 600.0,
) -> tuple[DiagramTransform, float]:
    """
    Find a DiagramTransform that scales every polygon to fit within
    (inner_width × max_inner_height). Returns (transform, actual_height).
    """
    all_x = [p[0] for poly in polygons for p in poly]
    all_y = [p[1] for poly in polygons for p in poly]
    if not all_x or not all_y:
        return DiagramTransform(scale=1.0, offset_x=target_left, offset_y=target_top), 0.0
    min_x, max_x = min(all_x), max(all_x)
    min_y, max_y = min(all_y), max(all_y)
    px_w = max(max_x - min_x, 1.0)
    px_h = max(max_y - min_y, 1.0)
    scale_w = inner_width / px_w
    scale_h = max_inner_height / px_h
    scale = min(scale_w, scale_h)
    diagram_w = px_w * scale
    diagram_h = px_h * scale
    # Center horizontally if the natural width is narrower than inner_width
    x_offset = target_left - min_x * scale + (inner_width - diagram_w) / 2
    y_offset = target_top - min_y * scale
    return DiagramTransform(scale=scale, offset_x=x_offset, offset_y=y_offset), diagram_h


# ─────────────────────────────────────────────────────────────────────────
# Collision-aware text placement
# ─────────────────────────────────────────────────────────────────────────

@dataclass
class TextBox:
    x: float
    y: float
    w: float
    h: float


def text_bbox(text: str, x: float, y: float, font_size: int = FONT_SIZE_DIM) -> TextBox:
    """
    Approximate bounding box for centered text. Used by `nudge_clear` to
    detect overlaps between placed labels.
    """
    px = PX_PER_CHAR_11 if font_size >= 11 else PX_PER_CHAR_9
    w = len(text) * px + 4
    h = font_size + 4
    return TextBox(x=x - w / 2, y=y - h / 2, w=w, h=h)


def boxes_overlap(a: TextBox, b: TextBox, tol: float = 2.0) -> bool:
    """True if two boxes overlap by more than `tol` pixels in both axes."""
    h_overlap = min(a.x + a.w, b.x + b.w) - max(a.x, b.x)
    v_overlap = min(a.y + a.h, b.y + b.h) - max(a.y, b.y)
    return h_overlap > tol and v_overlap > tol


def nudge_clear(
    proposed: TextBox, placed: list[TextBox],
    nudge_step_px: float = 12, max_tries: int = 4,
) -> TextBox:
    """
    APIR's no-overlap rule. Try moving the proposed label up, then down,
    then further up, then further down by nudge_step_px. After max_tries
    we give up and accept the overlap — the diagram still renders.
    """
    if not any(boxes_overlap(proposed, p) for p in placed):
        return proposed
    deltas = [
        (0, -nudge_step_px),
        (0, +nudge_step_px),
        (0, -nudge_step_px * 2),
        (0, +nudge_step_px * 2),
    ]
    for dx, dy in deltas[:max_tries]:
        candidate = TextBox(x=proposed.x + dx, y=proposed.y + dy,
                            w=proposed.w, h=proposed.h)
        if not any(boxes_overlap(candidate, p) for p in placed):
            return candidate
    return proposed


# ─────────────────────────────────────────────────────────────────────────
# Common <text> element builders
# ─────────────────────────────────────────────────────────────────────────

def text(
    x: float, y: float, content: str,
    *, font_size: int = FONT_SIZE_DIM, fill: str = "#1A1A1A",
    weight: str = "normal", anchor: str = "middle",
) -> str:
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" font-family="{FONT_FAMILY}" '
        f'font-size="{font_size}" font-weight="{weight}" '
        f'text-anchor="{anchor}" fill="{fill}">{escape_xml(content)}</text>'
    )


def facet_label(
    cx: float, cy: float, facet_id: str, area_sqft: float,
    pitch: str, slope_direction: str,
) -> str:
    return (
        text(cx, cy - 8, facet_id,
             font_size=FONT_SIZE_FACET_ID, weight="600", fill="#1B3A6B")
        + text(cx, cy + 6, format_area(area_sqft),
               font_size=FONT_SIZE_DIM, fill="#444444")
        + text(cx, cy + 19, f"{pitch} · {slope_direction}",
               font_size=10, fill="#666666")
    )


# ─────────────────────────────────────────────────────────────────────────
# SVG document wrapper
# ─────────────────────────────────────────────────────────────────────────

def svg_document(body: str, height: float) -> str:
    """Wrap the diagram body in <svg> with the APIR viewBox spec."""
    h = max(int(math.ceil(height)), 100)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {SVG_WIDTH} {h}" width="{SVG_WIDTH}" height="{h}">'
        f'{DIMENSION_DEFS}'
        f'{body}'
        f'</svg>'
    )


# ─────────────────────────────────────────────────────────────────────────
# Dimension line + label
# ─────────────────────────────────────────────────────────────────────────

def dimension_line(
    x1: float, y1: float, x2: float, y2: float,
    *, label: str = "",
    label_offset_x: float = 0.0, label_offset_y: float = -4.0,
) -> str:
    """
    A dim line with arrows at both ends and an optional centered label.
    Line stops 4px short of each endpoint (caller pre-shrinks if needed).
    """
    parts = [
        f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
        f'{edge_style_attrs("dimension")} '
        f'marker-start="url(#dimArr)" marker-end="url(#dimArr)"/>'
    ]
    if label:
        mx = (x1 + x2) / 2 + label_offset_x
        my = (y1 + y2) / 2 + label_offset_y
        parts.append(text(mx, my, label, font_size=FONT_SIZE_DIM, fill="#444444"))
    return "".join(parts)
