"""
Axis Roofing Performance — Roof Report v2 PDF.

8-section contractor report:

    1. Executive Summary
    2. Roof Summary (area, squares, pitch breakdown, waste calc)
    3. Roof Line Measurements (ridges, hips, valleys, eaves, rakes, drip edge, starter, perimeter)
    4. Flashing Report (computed: valley metal, step flashing; manual: counter/apron)
    5. Roof Penetrations (USER-CONFIRMED only)
    6. Material Ordering Summary (catalog-driven, with waste table)
    7. Exterior Measurements (manual siding placeholders)
    8. Methodology + Confidence (transparency section)

Every number on the report is traceable to its source:
    - Areas/lengths: which polygon / edges they came from
    - Materials: catalog SKU + computation_trace
    - Confidence: per-source breakdown
"""
from __future__ import annotations

import io
import logging
import re
from datetime import datetime, timezone
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    Image,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

# Reuse the brand palette and styles from the legacy PDF so reports look
# consistent during the transition.
from app.services.roof_report_pdf import (
    BRAND, BRAND_DARK, ACCENT, MUTED, SURFACE, BORDER, OK, WARN, BAD,
    _styles, _confidence_bucket, _fetch_satellite_image,
)
from app.services.materials_engine import STANDARD_WASTE_PCTS, grand_total, MaterialLine

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def _ft(value: float | int | None) -> str:
    if value is None:
        return "—"
    return f"{float(value):,.1f} lf"


def _sqft(value: float | int | None) -> str:
    if value is None:
        return "—"
    return f"{float(value):,.0f} sq ft"


def _sq(value: float | int | None) -> str:
    if value is None:
        return "—"
    return f"{float(value):,.2f} sq"


def _qty(value: float | int | None) -> str:
    if value is None:
        return "—"
    return f"{value}"


def _currency(value: float | int | None) -> str:
    if value is None:
        return "—"
    return f"${float(value):,.2f}"


def _load_font(bold: bool = False, size: int = 30):
    from PIL import ImageFont
    for p in (
        f"/usr/share/fonts/truetype/dejavu/DejaVuSans{'-Bold' if bold else ''}.ttf",
        f"/usr/share/fonts/dejavu/DejaVuSans{'-Bold' if bold else ''}.ttf",
    ):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    try:
        return ImageFont.load_default()
    except Exception:
        return None


def _centered_lines(draw, cx, cy, lines, font, fontb) -> None:
    sized = []
    for i, txt in enumerate(lines):
        fnt = fontb if i == 0 else font
        try:
            b = draw.textbbox((0, 0), txt, font=fnt)
            w, h = b[2] - b[0], b[3] - b[1]
        except Exception:
            w, h = len(txt) * 10, 18
        sized.append((txt, fnt, w, h))
    total = sum(h for *_, h in sized) + 5 * (len(sized) - 1)
    y = cy - total / 2
    for txt, fnt, w, h in sized:
        # white halo for legibility over fills
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            draw.text((cx - w / 2 + dx, y + dy), txt, fill=(255, 255, 255), font=fnt)
        draw.text((cx - w / 2, y), txt, fill=(17, 24, 39), font=fnt)
        y += h + 5


def _format_phone(raw) -> str | None:
    """DEFECT-09: format a phone as (XXX) XXX-XXXX. Falls back to the raw string
    if it isn't a recognizable 10-digit US number."""
    if not raw:
        return None
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) == 11 and digits[0] == "1":
        digits = digits[1:]
    if len(digits) == 10:
        return f"({digits[0:3]}) {digits[3:6]}-{digits[6:]}"
    return str(raw).strip()


def _normalize_address(address, city, state, zipc) -> str:
    """DEFECT-09: build a clean single-line address without duplicating the city
    or ZIP already embedded in the street line (e.g. the '…RICHLANDS 28574,
    RICHLANDS, NC' bug)."""
    address = (address or "").strip().rstrip(",").strip()
    city = (city or "").strip()
    state = (state or "").strip()
    zipc = (zipc or "").strip()
    al = address.lower()
    parts: list[str] = []
    if address:
        parts.append(address)
    if city and city.lower() not in al:
        parts.append(city)
    tokens = set(re.findall(r"[a-z0-9]+", al))
    have_state = bool(state) and state.lower() in tokens
    have_zip = bool(zipc) and zipc in address
    tail = " ".join(x for x, have in ((state, have_state), (zipc, have_zip)) if x and not have)
    if tail:
        parts.append(tail)
    return ", ".join(p for p in parts if p)


def _crop_image_to_facets(img_bytes: bytes, facets: list[dict], margin: float = 0.35, subject_point: dict | None = None) -> bytes | None:
    """Crop the aerial to the subject roof so the report shows ONLY this house,
    not the neighbors. Robust to a stray vertex: centers on the MEDIAN of the
    facet vertices and drops outliers far from that center before taking the box,
    so one bad point can't blow the crop out to a yard. Returns PNG or None."""
    try:
        from PIL import Image as _PImage

        pts = [(float(p[0]), float(p[1]))
               for f in facets if len(f.get("polygon") or []) >= 3
               for p in (f.get("polygon") or [])
               if isinstance(p, (list, tuple)) and len(p) >= 2]
        if len(pts) < 3:
            # No usable facets — fall back to a window around the contractor's
            # confirmed "this is my house" tap, so the report can NEVER show
            # the full tile with neighbors/wrong buildings.
            sp = subject_point or {}
            if sp.get("x") is not None and sp.get("y") is not None:
                pts = [(float(sp["x"]), float(sp["y"]))] * 3
            else:
                return None
        # Median center + near-max half-extent. We use the 95th percentile (not
        # the 75th) so the WHOLE roof stays in frame — the 75th was clipping the
        # outer edges of larger houses. The 95th still rejects a single wild
        # outlier vertex while keeping every real roof edge, and the generous
        # margin then adds the surrounding house/eaves context.
        cx = sorted(p[0] for p in pts)[len(pts) // 2]
        cy = sorted(p[1] for p in pts)[len(pts) // 2]
        dxs = sorted(abs(x - cx) for x, _ in pts)
        dys = sorted(abs(y - cy) for _, y in pts)
        hx = dxs[min(len(dxs) - 1, int(len(dxs) * 0.95))]
        hy = dys[min(len(dys) - 1, int(len(dys) * 0.95))]
        half = min(0.48, max(hx, hy, 0.05) * (1.0 + margin))
        cx0, cy0 = max(0.0, cx - half), max(0.0, cy - half)
        cx1, cy1 = min(1.0, cx + half), min(1.0, cy + half)
        im = _PImage.open(io.BytesIO(img_bytes)).convert("RGB")
        W, H = im.size
        box = (int(cx0 * W), int(cy0 * H), int(cx1 * W), int(cy1 * H))
        if box[2] - box[0] < 16 or box[3] - box[1] < 16:
            return None
        out = io.BytesIO()
        im.crop(box).save(out, format="PNG")
        return out.getvalue()
    except Exception as e:
        logger.info("report aerial crop failed: %s", e)
        return None


def _render_facet_diagram(facets: list[dict]) -> bytes | None:
    """Draw the traced facets to scale on a clean canvas, labeled with each
    facet's area + pitch — the EagleView/Hover-style roof diagram, built ONLY
    from real traced polygons. Returns PNG bytes or None."""
    try:
        from PIL import Image, ImageDraw

        polys = [(i, f) for i, f in enumerate(facets)
                 if f.get("polygon") and len(f.get("polygon") or []) >= 3]
        if not polys:
            return None
        W, H = 1700, 1150
        img = Image.new("RGB", (W, H), (255, 255, 255))
        d = ImageDraw.Draw(img, "RGBA")

        xs = [p[0] for _, f in polys for p in f["polygon"]]
        ys = [p[1] for _, f in polys for p in f["polygon"]]
        minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
        spanx, spany = (maxx - minx) or 1e-6, (maxy - miny) or 1e-6
        pad = 0.08
        minx -= spanx * pad; maxx += spanx * pad
        miny -= spany * pad; maxy += spany * pad
        spanx, spany = maxx - minx, maxy - miny
        margin = 70
        scale = min((W - 2 * margin) / spanx, (H - 2 * margin) / spany)
        offx = (W - spanx * scale) / 2 - minx * scale
        offy = (H - spany * scale) / 2 - miny * scale

        def topx(p):
            return (offx + p[0] * scale, offy + p[1] * scale)

        palette = [(59, 130, 246), (168, 85, 247), (34, 197, 94), (245, 158, 11),
                   (236, 72, 153), (6, 182, 212), (132, 204, 22)]
        font, fontb = _load_font(False, 30), _load_font(True, 34)

        for idx, (i, f) in enumerate(polys):
            pts = [topx(p) for p in f["polygon"]]
            c = palette[idx % len(palette)]
            d.polygon(pts, fill=(c[0], c[1], c[2], 55))
            d.line(pts + [pts[0]], fill=(c[0], c[1], c[2], 255), width=4)
            cx = sum(x for x, _ in pts) / len(pts)
            cy = sum(y for _, y in pts) / len(pts)
            label = f.get("facet_label") or f"RF-{i + 1}"
            area = f.get("true_area_sqft") or f.get("plan_area_sqft") or 0
            pitch = f.get("pitch") or ""
            _centered_lines(d, cx, cy, [str(label), f"{round(float(area))} ft²", str(pitch)], font, fontb)

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:
        logger.warning("facet diagram render failed: %s", e)
        return None


# Edge colours match the roof-line table so the diagram and the numbers are
# obviously the same data seen two ways.
_EDGE_COLORS = {
    "eave":              (37, 99, 235),
    "rake":              (168, 85, 247),
    "ridge":             (220, 38, 38),
    "hip":               (234, 88, 12),
    "valley":            (5, 150, 105),
    "wall_intersection": (100, 116, 139),
    "unlabeled":         (156, 163, 175),
}


def _facet_frame(facets: list[dict], long_edge: int = 2100, margin: int = 110):
    """Projection + a canvas shaped like the roof itself.

    A fixed canvas wastes most of the page on a long diagonal building: the fit
    is driven by one dimension and the other fills with white, so the diagram
    lands small in the middle of an empty sheet. Sizing the canvas to the
    footprint's own aspect means the drawing fills the page whatever shape the
    roof is.

    Returns (polys, project, W, H). Both diagrams call this, so the building
    sits identically on every page — flipping between them must not move it.
    """
    polys = [f for f in facets if f.get("polygon") and len(f.get("polygon") or []) >= 3]
    if not polys:
        return None
    xs = [p[0] for f in polys for p in f["polygon"]]
    ys = [p[1] for f in polys for p in f["polygon"]]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    spanx, spany = (maxx - minx) or 1e-6, (maxy - miny) or 1e-6
    pad = 0.06
    minx -= spanx * pad; maxx += spanx * pad
    miny -= spany * pad; maxy += spany * pad
    spanx, spany = maxx - minx, maxy - miny

    # Canvas takes the footprint's aspect, clamped so an extreme ratio stays
    # readable on a portrait page.
    aspect = max(0.55, min(1.7, spanx / spany))
    if aspect >= 1.0:
        W, H = long_edge, int(long_edge / aspect)
    else:
        H, W = long_edge, int(long_edge * aspect)

    scale = min((W - 2 * margin) / spanx, (H - 2 * margin) / spany)
    offx = (W - spanx * scale) / 2 - minx * scale
    offy = (H - spany * scale) / 2 - miny * scale
    return polys, (lambda p: (offx + p[0] * scale, offy + p[1] * scale)), W, H


def _render_length_diagram(facets: list[dict], edges: list[dict]) -> bytes | None:
    """The length diagram: every traced edge, drawn and labelled with its own
    measured length.

    Lengths come from roof_edges.slope_adjusted_ft (falling back to
    plan_length_ft) — the same stored numbers the roof-line table totals. None
    are recomputed here, so the diagram cannot disagree with the table.

    A shared edge is stored once per adjoining facet. Both rows describe the
    same physical line, so the label is drawn once, keyed on the midpoint —
    otherwise a ridge reads twice and looks like double the roof.
    """
    try:
        from PIL import Image, ImageDraw
        frame = _facet_frame(facets)
        if not frame:
            return None
        polys, topx, W, H = frame
        by_id = {f.get("id"): f for f in polys}

        img = Image.new("RGB", (W, H), (255, 255, 255))
        d = ImageDraw.Draw(img, "RGBA")
        font, fontb = _load_font(False, 30), _load_font(True, 32)

        for f in polys:
            pts = [topx(p) for p in f["polygon"]]
            d.polygon(pts, fill=(241, 245, 249, 255))

        # One label per physical line, matched the SAME way the roof-line table
        # de-duplicates (geometry_service._same_segment). Keyed on the exact
        # midpoint, two facets' copies that end a few inches apart were both
        # labelled — "28.2' / 29.8'" on one ridge — though counted once.
        from app.services import geometry_service as _geo
        facet_polys = {f.get("id"): (f.get("polygon") or []) for f in polys}
        labelled: list = []
        seen: set = set()
        drawn = 0
        for e in edges:
            f = by_id.get(e.get("facet_id"))
            if not f:
                continue
            poly = f.get("polygon") or []
            i, j = e.get("vertex_index_start"), e.get("vertex_index_end")
            if i is None or j is None or i >= len(poly) or j >= len(poly):
                continue
            a, b = topx(poly[i]), topx(poly[j])
            mid = (round((a[0] + b[0]) / 2, 1), round((a[1] + b[1]) / 2, 1))
            etype = (e.get("edge_type") or "unlabeled")
            colour = _EDGE_COLORS.get(etype, _EDGE_COLORS["unlabeled"])
            d.line([a, b], fill=colour, width=7)
            if mid in seen:          # shared edge — already labelled from the other facet
                continue
            seg = _geo._edge_segment(e, facet_polys)
            if seg is not None and any(_geo._same_segment(seg, s_) for s_ in labelled):
                continue
            seen.add(mid)
            if seg is not None:
                labelled.append(seg)
            length = e.get("slope_adjusted_ft") or e.get("plan_length_ft")
            if length is None:
                continue
            _centered_lines(d, mid[0], mid[1], [f"{float(length):.1f}'"], font, fontb)
            drawn += 1

        if drawn == 0:
            return None

        # Legend — only the edge types actually present on this roof.
        present = []
        for e in edges:
            t = e.get("edge_type") or "unlabeled"
            if t not in present and by_id.get(e.get("facet_id")):
                present.append(t)
        x, y = 60, 40
        for t in present:
            c = _EDGE_COLORS.get(t, _EDGE_COLORS["unlabeled"])
            d.rectangle([x, y, x + 46, y + 14], fill=c)
            d.text((x + 58, y - 6), t.replace("_", " ").title(), fill=(30, 41, 59), font=fontb)
            y += 44

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:
        logger.warning("length diagram render failed: %s", e)
        return None


def _render_pitch_diagram(facets: list[dict]) -> bytes | None:
    """The pitch diagram: each facet shaded by steepness and labelled with its
    own pitch, area, and where that pitch came from.

    Shading is ordered by pitch so the steep planes are visually obvious. A
    facet whose pitch was never confirmed is drawn hatched and labelled
    "unverified" rather than shaded like measured data — a default guess must
    never look like a measurement.
    """
    try:
        from PIL import Image, ImageDraw
        frame = _facet_frame(facets)
        if not frame:
            return None
        polys, topx, W, H = frame

        img = Image.new("RGB", (W, H), (255, 255, 255))
        d = ImageDraw.Draw(img, "RGBA")
        font, fontb = _load_font(False, 30), _load_font(True, 38)

        degs = [f.get("pitch_degrees") for f in polys if f.get("pitch_degrees") is not None]
        lo, hi = (min(degs), max(degs)) if degs else (0.0, 1.0)
        span = (hi - lo) or 1.0

        for i, f in enumerate(polys):
            pts = [topx(p) for p in f["polygon"]]
            deg = f.get("pitch_degrees")
            src = (f.get("pitch_source") or "").lower()
            # Provenance has three honest states, not two.
            #
            # `pitch_source` is inferred rather than recorded — a pitch is
            # stored as "default" whenever it equals 6/12, so a contractor who
            # deliberately CHOSE 6/12 is indistinguishable from one who never
            # touched it. Calling that "unverified" would brand a real decision
            # as a guess. user_confirmed is the signal that separates them.
            measured = src in ("solar_measured", "solar_3d", "solar_3d_edited", "lidar_measured", "ground_photo")
            contractor_set = src == "manual" or (bool(f.get("user_confirmed")) and bool(f.get("pitch")))
            unverified = not measured and not contractor_set
            if unverified:
                fill = (203, 213, 225, 90)
            else:
                # cool (shallow) -> warm (steep)
                t = ((deg - lo) / span) if deg is not None else 0.0
                fill = (int(59 + t * 190), int(130 - t * 60), int(246 - t * 200), 110)
            d.polygon(pts, fill=fill)
            d.line(pts + [pts[0]], fill=(30, 41, 59, 255), width=5)

            cx = sum(x for x, _ in pts) / len(pts)
            cy = sum(y for _, y in pts) / len(pts)
            label = f.get("facet_label") or f"RF-{i + 1}"
            pitch = f.get("pitch") or "unverified"
            area = f.get("true_area_sqft") or f.get("plan_area_sqft") or 0

            # A four-line caption on a narrow dormer spills over its neighbours
            # and makes the whole plan harder to read than no label at all.
            # Drop detail as the plane gets smaller; the facet table carries the
            # full numbers for every plane regardless.
            px = [x for x, _ in pts]; py = [y for _, y in pts]
            box = (max(px) - min(px)) * (max(py) - min(py))
            room = box / float(W * H)
            if room >= 0.045:
                lines = [str(label), str(pitch), f"{round(float(area))} ft²"]
                lines.append("measured" if measured else
                             ("set by contractor" if contractor_set else "pitch unverified"))
                _centered_lines(d, cx, cy, lines, font, fontb)
            elif room >= 0.012:
                _centered_lines(d, cx, cy, [str(label), str(pitch)], font, fontb)
            else:
                _centered_lines(d, cx, cy, [str(label)], font, fontb)

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:
        logger.warning("pitch diagram render failed: %s", e)
        return None


def _section_header(text: str, n: int, styles: dict) -> Paragraph:
    """Numbered in the order sections actually print. The fixed numbers each
    section used to carry skipped every hidden one (2, 3, 5, 7, 9, 10), which
    reads as missing pages. `n` is kept for callers; the count lives in styles,
    which every section already receives."""
    counter = styles.setdefault("_section_no", [0])
    counter[0] += 1
    return Paragraph(f"<font color='#1e40af'><b>Section {counter[0]}.</b></font> &nbsp; {text}", styles["h2"])


def _table_style(header_color=BRAND, alt_row=True) -> TableStyle:
    cmds: list[tuple] = [
        ("BACKGROUND", (0, 0), (-1, 0), header_color),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
        ("TOPPADDING", (0, 0), (-1, 0), 6),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 1), (-1, -1), 9),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, 0), 1.0, BRAND_DARK),
        ("GRID", (0, 1), (-1, -1), 0.25, BORDER),
    ]
    if alt_row:
        cmds.append(("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, SURFACE]))
    return TableStyle(cmds)


# ----------------------------------------------------------------------------
# Section builders
# ----------------------------------------------------------------------------

# Phase 1: human-readable pitch provenance for the report. A MEASURED pitch reads
# as measured; a default guess reads as one — never presented interchangeably.
_PITCH_SOURCE_LABELS = {
    "solar_measured": "Measured (Google Solar)",
    # A plane fitted to Google's 3D height map for THIS facet — the strongest
    # pitch source Axis has, so it must never render as a guess.
    "solar_3d": "Measured (Google 3D)",
    # The contractor reshaped the outline; the plane's pitch is still measured.
    "solar_3d_edited": "Measured (3D), edited",
    "solar_direction": "Measured (Solar, direction)",
    "lidar_measured": "Measured (USGS LiDAR)",
    "ground_photo": "Ground photo",
    "ai_satellite": "AI estimate",
    "manual": "Contractor entered",
    "default": "Default — unverified",
}


def _pitch_source_label(source) -> str:
    s = str(source or "").strip()
    if not s:
        return "Unverified"
    return _PITCH_SOURCE_LABELS.get(s, s)


def _section_2_roof_summary(aggregates: dict, facets: list[dict], styles: dict,
                            run: dict | None = None) -> list:
    flow = [_section_header("Roof Summary", 1, styles)]

    # The outline is NOT redrawn here. It has a full page of its own earlier —
    # the Length Diagram and the Pitch Diagram — each larger and carrying more
    # than this thumbnail ever did. A third copy read as padding.
    measured = bool(facets) and all(_is_3d(f) for f in facets)
    waste = int(aggregates.get("waste_pct_default") or 12)
    rows = [
        ["Metric", "Value", "Method"],
        ["Total roof area (true)", _sqft(aggregates.get("total_roof_sqft")),
         "Σ plan area × slope multiplier per facet"],
        ["Total plan area (footprint)", _sqft(aggregates.get("total_plan_sqft")), "Σ facet outline areas"],
        ["Roofing squares", _sq(aggregates.get("squares")), "true area ÷ 100"],
        ["Facet count", str(aggregates.get("facet_count") or 0),
         "roof planes found in Google 3D heights" if measured else "contractor-traced outlines"],
        ["Predominant pitch", str(aggregates.get("predominant_pitch") or "—"),
         "pitch of the largest roof area"],
        ["Pitch (degrees)",
         f"{aggregates.get('predominant_pitch_degrees') or 0:.1f}°", "atan(rise/12)"],
        ["Complexity score", f"{aggregates.get('complexity_score', 0):.2f}",
         "from facet count, valleys, hips and pitch variety"],
        # Asked on the first side-by-side: why order more than EagleView? The
        # waste comes from complexity on a fixed 10/12/15/18% scale, never
        # below 10%; saying so here lets a contractor see and override it.
        ["Recommended waste", f"{waste}%", "10/12/15/18% by complexity (never below 10%)"],
    ]
    t = Table(rows, colWidths=[2.0 * inch, 1.5 * inch, 3.4 * inch])
    t.setStyle(_table_style())
    flow.append(t)

    # Per-facet table
    if facets:
        flow.append(Spacer(1, 10))
        flow.append(Paragraph("Per-facet breakdown", styles["body"]))
        fac_rows = [["Facet", "Pitch", "Pitch source", "Faces", "Plan ft²", "True ft²", "Conf."]]
        any_unmeasured_facing = False
        for f in sorted(facets, key=lambda f_: (len(f_.get("facet_label") or ""), f_.get("facet_label") or "")):
            label = f.get("facet_label") or "—"
            pitch = f.get("pitch") or "—"
            # Which way the slope FACES is only known where the plane was
            # measured. A traced outline's stored direction is its longest
            # edge's bearing — a line, which cannot tell a north slope from a
            # south one — so it is not printed as if it were a facing.
            if str(f.get("pitch_source") or "").startswith("solar_3d") and f.get("slope_direction"):
                direction = f.get("slope_direction")
            else:
                direction = "—"
                any_unmeasured_facing = True
            plan = f.get("plan_area_sqft") or 0
            true = f.get("true_area_sqft") or 0
            conf = (f.get("confidence") or 0) * 100
            fac_rows.append([
                label, pitch, _pitch_source_label(f.get("pitch_source")), direction,
                f"{plan:,.1f}", f"{true:,.1f}", f"{conf:.0f}%",
            ])
        ft = Table(fac_rows, colWidths=[0.6 * inch, 0.8 * inch, 1.7 * inch, 0.7 * inch,
                                         1.0 * inch, 1.0 * inch, 0.7 * inch])
        ft.setStyle(_table_style(header_color=ACCENT))
        flow.append(ft)
        if any_unmeasured_facing:
            flow.append(Spacer(1, 3))
            flow.append(Paragraph(
                "<i>Faces is the compass direction a slope drains toward. It is shown only "
                "where the plane was measured; a hand-traced outline does not establish it.</i>",
                styles["muted"]))
    return flow


def _section_3_roof_lines(aggregates: dict, edges: list[dict], styles: dict) -> list:
    flow = [_section_header("Roof Line Measurements", 2, styles)]

    rows = [
        ["Type", "Total Linear Feet", "Material Implication"],
        ["Ridges", _ft(aggregates.get("ridges_ft")), "Drives ridge cap quantity"],
        ["Hips", _ft(aggregates.get("hips_ft")), "Adds to ridge cap; sloped lengths"],
        ["Valleys", _ft(aggregates.get("valleys_ft")), "Drives valley metal + ice/water shield"],
        ["Eaves", _ft(aggregates.get("eaves_ft")), "Starter strip, drip edge, ice/water shield"],
        ["Rakes", _ft(aggregates.get("rakes_ft")), "Starter strip + drip edge"],
        ["Wall / step flashing", _ft(aggregates.get("wall_intersection_ft")),
         "Step flashing where a roof meets a wall"],
        ["Perimeter (eaves + rakes)", _ft(aggregates.get("perimeter_ft")), "Drip edge total"],
        ["Ridge total (ridges + hips)", _ft(aggregates.get("ridge_total_ft")), "Cap shingle total"],
    ]
    t = Table(rows, colWidths=[2.0 * inch, 1.5 * inch, 3.4 * inch])
    t.setStyle(_table_style())
    flow.append(t)

    flow.append(Spacer(1, 8))
    flow.append(Paragraph(
        "<i>All linear lengths are slope-adjusted for rakes, hips, and valleys — "
        "the figure shown is the true length along the roof surface, which is "
        "what contractors order material against. Eaves and ridges are "
        "horizontal so plan and true lengths are equal. Every line is drawn and "
        "labelled with its length on the Length Diagram.</i>",
        styles["muted"],
    ))

    # What the totals above do NOT contain, said plainly. The old per-edge
    # table listed every stored row — each shared line twice, once per facet —
    # under totals that count it once, which read as a contradiction.
    typed = [e for e in edges if (e.get("edge_type") or "unlabeled") != "unlabeled"]
    unconfirmed = [e for e in typed if not e.get("user_confirmed")]
    # A shared line is stored once per facet; halve those so this is in feet of roof.
    untyped_ft = sum(float(e.get("slope_adjusted_ft") or 0) * (0.5 if e.get("shared_with_facet") else 1.0)
                     for e in edges if (e.get("edge_type") or "unlabeled") == "unlabeled")
    notes = []
    if untyped_ft >= 1.0:
        notes.append(f"About {untyped_ft:,.0f} ft of roof line has no type and is <b>not counted</b> above. "
                     "Set its type in the editor to include it.")
    if typed and unconfirmed:
        share = len(unconfirmed) / len(typed)
        notes.append(f"{share:.0%} of the line types were set automatically and have not been "
                     "confirmed by the contractor.")
    for n_ in notes:
        flow.append(Spacer(1, 4))
        flow.append(Paragraph(f"• {n_}", styles["muted"]))
    return flow


def _section_4_flashing(
    aggregates: dict, material_lines: list[MaterialLine], styles: dict,
    flashing: dict | None = None,
) -> list:
    flow = [_section_header("Flashing Report", 4, styles)]

    # Preferred: the Flashing Intelligence engine output (step / counter /
    # apron / kickout / valley / chimney / skylight / cricket, all derived
    # deterministically from labeled edges + penetrations).
    totals = (flashing or {}).get("totals") or {}
    if totals:
        rows = [["Flashing type", "Quantity", "Basis"]]
        rows.append(["Step flashing", f"{_ft(totals.get('step_flashing_ft', 0))} "
                     f"({int(totals.get('step_pieces', 0))} pcs)", "Sloped roof-to-wall runs"])
        rows.append(["Counter flashing", _ft(totals.get("counter_flashing_ft", 0)),
                     "Caps step/apron at the wall"])
        apron_hw = (totals.get("apron_flashing_ft", 0) or 0) + (totals.get("headwall_flashing_ft", 0) or 0)
        rows.append(["Apron / headwall", _ft(apron_hw), "Horizontal roof-to-wall runs"])
        rows.append(["Valley metal", _ft(totals.get("valley_flashing_ft", 0)), "Labeled valley edges"])
        rows.append(["Kickout flashing", f"{int(totals.get('kickout_qty', 0))} ea",
                     "One per roof-to-wall run base"])
        rows.append(["Chimney kits", f"{int(totals.get('chimney_qty', 0))} ea", "Chimney penetrations"])
        rows.append(["Skylight kits", f"{int(totals.get('skylight_qty', 0))} ea", "Skylight penetrations"])
        if totals.get("cricket_qty"):
            rows.append(["Cricket / saddle", f"{int(totals.get('cricket_qty', 0))} ea",
                         "Chimneys wider than 30\""])
        rows.append(["Drip edge", _ft(aggregates.get("perimeter_ft")), "Eaves + rakes"])

        t = Table(rows, colWidths=[1.7 * inch, 1.7 * inch, 3.1 * inch])
        t.setStyle(_table_style())
        flow.append(t)

        reqs = (flashing or {}).get("requirements") or []
        review = [r for r in reqs if r.get("needs_review")]
        if review:
            flow.append(Spacer(1, 6))
            flow.append(Paragraph(
                f"{len(review)} flashing item(s) flagged for on-site verification "
                "(orientation or penetration size estimated from imagery).",
                styles["small"] if "small" in styles else styles["body"],
            ))

        # Field verification — cross-check against the contractor's own ground
        # photos. A gap here means the photos saw a condition (chimney,
        # skylight, dormer, wall abutment) this order doesn't cover yet.
        gaps = (flashing or {}).get("gaps") or []
        has_findings = bool((flashing or {}).get("ground_verified"))
        flow.append(Spacer(1, 8))
        flow.append(Paragraph("<b>Field verification (from ground photos)</b>", styles["body"]))
        if gaps:
            for g in gaps:
                flow.append(Paragraph(
                    f"⚠ <b>{str(g.get('type', '')).replace('_', ' ').title()}:</b> {g.get('message', '')}",
                    styles["muted"],
                ))
        elif has_findings:
            flow.append(Paragraph(
                "✓ Every condition observed in the ground photos (chimneys, skylights, "
                "dormers, wall abutments) is accounted for in this flashing order.",
                styles["muted"],
            ))
        else:
            flow.append(Paragraph(
                "No ground photos analyzed for this run — upload 3–4 photos (gable end, "
                "each corner, any chimney) in the editor to verify these flashing "
                "conditions against the field before ordering.",
                styles["muted"],
            ))
        return _flashing_materials_tail(flow, material_lines, styles)

    # Fallback (legacy): no engine output supplied.
    valley_lf = aggregates.get("valleys_ft") or 0
    wall_lf = aggregates.get("wall_intersection_ft") or 0
    rows = [["Type", "Linear Feet", "Computed?", "Notes"]]
    rows.append(["Valley metal", _ft(valley_lf), "Yes (auto)", "Computed from labeled valley edges"])
    rows.append(["Step flashing", _ft(wall_lf), "Yes if walls labeled",
                 "Counted from edges labeled 'wall_intersection' or stories > 1"])
    rows.append(["Counter flashing", "Manual entry required", "No",
                 "Requires inspector measurement against masonry above"])
    rows.append(["Apron flashing", "Manual entry required", "No",
                 "Requires inspector measurement at wall-to-roof joins"])
    rows.append(["Drip edge", _ft(aggregates.get("perimeter_ft")), "Yes (auto)",
                 "Eaves + rakes"])

    t = Table(rows, colWidths=[1.6 * inch, 1.4 * inch, 1.2 * inch, 2.3 * inch])
    t.setStyle(_table_style())
    flow.append(t)
    return _flashing_materials_tail(flow, material_lines, styles)


def _flashing_materials_tail(flow: list, material_lines: list[MaterialLine], styles: dict) -> list:
    flashing_lines = [
        l for l in material_lines
        if l.category in (
            "valley_metal", "step_flashing", "drip_edge",
            "counter_flashing", "apron_flashing", "kickout_flashing",
            "chimney_flashing_kit", "skylight_flashing_kit", "cricket",
        )
    ]

    if flashing_lines:
        flow.append(Spacer(1, 8))
        flow.append(Paragraph("Flashing materials (from catalog)", styles["body"]))
        mr = [["SKU", "Item", "Qty (12% waste)", "Unit cost", "Subtotal"]]
        for l in flashing_lines:
            mr.append([
                l.sku, l.item_name,
                f"{l.waste_quantities.get(12, 0)} {l.unit}",
                _currency(l.unit_cost),
                _currency(l.waste_quantities.get(12, 0) * l.unit_cost),
            ])
        mt = Table(mr, colWidths=[1.0 * inch, 2.6 * inch, 1.4 * inch, 0.9 * inch, 0.9 * inch])
        mt.setStyle(_table_style(header_color=ACCENT))
        flow.append(mt)

    flow.append(Spacer(1, 6))
    flow.append(Paragraph(
        "Step / counter / apron flashing at masonry-to-roof joins are not "
        "fully measurable from satellite imagery alone. Axis computes what "
        "geometry allows and flags the rest as manual-entry items.",
        styles["muted"],
    ))
    return flow


def _section_5_penetrations(penetrations: list[dict], styles: dict) -> list:
    flow = [_section_header("Roof Penetrations", 5, styles)]
    if not penetrations:
        flow.append(Paragraph(
            "No penetrations were confirmed for this roof. AI vision may have "
            "suggested some during measurement; only items the contractor "
            "explicitly confirmed appear in this report.",
            styles["body"],
        ))
        return flow

    by_type: dict[str, int] = {}
    for p in penetrations:
        t = p.get("type", "other")
        by_type[t] = by_type.get(t, 0) + int(p.get("count") or 1)

    rows = [["Type", "Count", "Source"]]
    for t, n in sorted(by_type.items()):
        rows.append([t.replace("_", " ").title(), str(n), "Contractor confirmed"])
    table = Table(rows, colWidths=[2.4 * inch, 1.4 * inch, 2.7 * inch])
    table.setStyle(_table_style())
    flow.append(table)

    flow.append(Spacer(1, 6))
    flow.append(Paragraph(
        "Plumbing vent counts drive automatic pipe-boot ordering. Other "
        "penetration types are reported for reference and inspection planning.",
        styles["muted"],
    ))
    return flow


def _section_field_observations(run: dict, styles: dict) -> list:
    """Field Observations — what the contractor's ground photos verified.
    This is data a satellite cannot see (true pitch from a gable end, chimney
    material, story count, roof material/color) and it's what separates a
    verified report from a desktop-only estimate."""
    flow = [_section_header("Field Observations (Ground Photos)", 6, styles)]
    gf = run.get("ground_findings") or {}
    if not gf:
        flow.append(Paragraph(
            "No ground photos were analyzed for this run. Photos of the gable end, "
            "each corner, and any chimney/skylight let Axis verify pitch, penetrations, "
            "and materials against the field — strengthening this report.",
            styles["muted"],
        ))
        return flow

    rows = [["Observation", "Value", "How it was read"]]
    if gf.get("roof_pitch"):
        method = {"gable_end": "measured off the gable-end triangle",
                  "slope_angle": "estimated from the visible slope",
                  "not_visible": "not visible"}.get(str(gf.get("pitch_method")), "from photo")
        rows.append(["Roof pitch", f"{gf['roof_pitch']} ({gf.get('pitch_confidence', '—')} confidence)", method])
    ch = gf.get("chimney") or {}
    if ch.get("present"):
        rows.append(["Chimney", f"{int(ch.get('count') or 1)} × {ch.get('height', 'medium')} ({ch.get('material', 'unknown')})",
                     "visible in ground photos"])
    if gf.get("skylights"):
        rows.append(["Skylights", str(int(gf["skylights"])), "visible in ground photos"])
    if gf.get("dormers"):
        rows.append(["Dormers", str(int(gf["dormers"])), "visible in ground photos"])
    if gf.get("stories"):
        rows.append(["Stories", str(int(gf["stories"])), "counted from elevation view"])
    if gf.get("roof_material") and gf.get("roof_material") != "unknown":
        mat = str(gf["roof_material"]).replace("_", " ")
        if gf.get("roof_color"):
            mat += f" — {gf['roof_color']}"
        rows.append(["Roof material", mat, "identified in photos"])
    if gf.get("siding_material") and gf.get("siding_material") != "unknown":
        rows.append(["Siding material", str(gf["siding_material"]).replace("_", " "), "identified in photos"])

    if len(rows) == 1:
        flow.append(Paragraph("Ground photos were analyzed but no roof-relevant details could be read.", styles["muted"]))
        return flow

    t = Table(rows, colWidths=[1.5 * inch, 2.4 * inch, 2.6 * inch])
    t.setStyle(_table_style())
    flow.append(t)
    if gf.get("notes"):
        flow.append(Spacer(1, 4))
        flow.append(Paragraph(f"Analyst note: {str(gf['notes'])[:300]}", styles["muted"]))
    flow.append(Spacer(1, 4))
    flow.append(Paragraph(
        "These observations come from the contractor's own ground-level photos and are "
        "cross-checked against the flashing order in Section 4.",
        styles["muted"],
    ))
    return flow


def _section_6_materials(
    material_lines: list[MaterialLine], default_waste: int, styles: dict,
) -> list:
    flow = [_section_header("Material Ordering Summary", 7, styles)]
    if not material_lines:
        flow.append(Paragraph(
            "No materials were computed — confirm measurements and recompute aggregates first.",
            styles["body"],
        ))
        return flow

    # Per-waste totals
    flow.append(Paragraph("Total cost at each industry-standard waste %:", styles["body"]))
    per_waste = [
        ["Waste %"] + [f"{p}%" for p in STANDARD_WASTE_PCTS],
        ["Grand total"] + [_currency(grand_total(material_lines, p)) for p in STANDARD_WASTE_PCTS],
    ]
    w_table = Table(per_waste, colWidths=[1.1 * inch] + [0.75 * inch] * len(STANDARD_WASTE_PCTS))
    w_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BRAND),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (0, 1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.25, BORDER),
        ("BACKGROUND", (0, 1), (-1, 1), SURFACE),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    flow.append(w_table)
    flow.append(Spacer(1, 8))

    flow.append(Paragraph(
        f"Line items (at {default_waste}% waste):",
        styles["body"],
    ))

    # Cells hold raw strings, so a long SKU or item name cannot wrap — it runs
    # straight over the next column and the rows read as overlapping mush.
    # Wrapping each cell in a Paragraph lets reportlab break the line inside its
    # own column, which is the whole fix.
    from reportlab.lib.styles import ParagraphStyle
    cell = ParagraphStyle("Cell", parent=styles["body"], fontSize=7.5, leading=9.5)
    cell_r = ParagraphStyle("CellR", parent=cell, alignment=2)      # numbers right-align
    head = ParagraphStyle("CellH", parent=cell, textColor=colors.white,
                          fontName="Helvetica-Bold")

    def c(v, right=False):
        return Paragraph(str(v), cell_r if right else cell)

    rows = [[Paragraph(h, head) for h in
             ["SKU", "Item", "Base qty", f"Qty @ {default_waste}%", "Unit", "Unit $", "Subtotal"]]]
    unpriced = 0
    for l in material_lines:
        # A missing catalog price arrives here as 0.0. Printing that as "$0.00"
        # states a price we do not have, and it silently drops out of the grand
        # total — so the total would look complete while being short. Show the
        # gap instead, and say how many lines it covers underneath.
        has_price = (l.unit_cost or 0) > 0
        if not has_price:
            unpriced += 1
        rows.append([
            c(l.sku),
            c(l.item_name),
            c(f"{l.base_quantity:.2f}", right=True),
            c(l.waste_quantities.get(default_waste, 0), right=True),
            c(l.unit),
            c(_currency(l.unit_cost) if has_price else "—", right=True),
            c(_currency(l.waste_quantities.get(default_waste, 0) * l.unit_cost)
              if has_price else "—", right=True),
        ])
    rows.append([c(""), c("Grand total"), c(""), c(""), c(""), c(""),
                 c(_currency(grand_total(material_lines, default_waste)), right=True)])
    t = Table(
        rows,
        colWidths=[0.8 * inch, 2.5 * inch, 0.62 * inch, 0.78 * inch, 0.5 * inch, 0.68 * inch, 0.82 * inch],
        repeatRows=1,          # the header follows the table onto a second page
    )
    style = _table_style(header_color=ACCENT)
    style.add("VALIGN", (0, 0), (-1, -1), "MIDDLE")
    style.add("TOPPADDING", (0, 0), (-1, -1), 4)
    style.add("BOTTOMPADDING", (0, 0), (-1, -1), 4)
    style.add("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold")
    style.add("BACKGROUND", (0, -1), (-1, -1), SURFACE)
    style.add("LINEABOVE", (0, -1), (-1, -1), 1.0, BRAND_DARK)
    t.setStyle(style)
    flow.append(t)
    if unpriced:
        flow.append(Paragraph(
            f"{unpriced} of {len(material_lines)} line{'' if unpriced == 1 else 's'} "
            f"{'has' if unpriced == 1 else 'have'} no catalog price yet and {'is' if unpriced == 1 else 'are'} "
            "shown as \u2014. The grand total covers only the priced lines.",
            styles["muted"]))

    flow.append(Spacer(1, 6))
    flow.append(Paragraph(
        "<i>Computation traces for each line item are available in the "
        "Axis dashboard. Quantities are rounded UP to whole units — you "
        "cannot order 0.4 of a bundle.</i>",
        styles["muted"],
    ))
    return flow


def _section_7_exterior(siding: list[dict], styles: dict) -> list:
    flow = [_section_header("Exterior Measurements", 8, styles)]
    if not siding:
        flow.append(Paragraph(
            "No siding measurements have been recorded for this property. "
            "Siding cannot be measured from top-down satellite imagery — "
            "contractors must trace siding regions on ground-level elevation "
            "photos using a known scale reference (standard door, garage "
            "door, window). This section will populate once the manual "
            "siding workflow is completed in the Axis dashboard.",
            styles["body"],
        ))
        return flow

    rows = [["Elevation", "Material", "Area (sq ft)", "Scale ref"]]
    total = 0.0
    for s in siding:
        rows.append([
            (s.get("elevation") or "—").title(),
            s.get("material_type") or "—",
            f"{(s.get('area_sqft') or 0):,.1f}",
            (s.get("reference_object") or "—").replace("_", " "),
        ])
        total += s.get("area_sqft") or 0
    rows.append(["", "Total siding", f"{total:,.1f}", ""])
    t = Table(rows, colWidths=[1.5 * inch, 1.8 * inch, 1.4 * inch, 1.8 * inch])
    style = _table_style()
    style.add("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold")
    style.add("BACKGROUND", (0, -1), (-1, -1), SURFACE)
    style.add("LINEABOVE", (0, -1), (-1, -1), 1.0, BRAND_DARK)
    t.setStyle(style)
    flow.append(t)
    flow.append(Spacer(1, 4))
    flow.append(Paragraph(
        "Siding figures are contractor-entered measurements from ground-level "
        "photos, not automated computer-vision measurements.",
        styles["muted"],
    ))
    return flow


def _section_8_methodology(run: dict, aggregates: dict, styles: dict, calibration: dict | None = None,
                           facets: list[dict] | None = None) -> list:
    flow = [_section_header("Methodology & Confidence", 9, styles)]

    source = run.get("source") or "unknown"
    # An auto-measured roof is still stored under the run's tracing source;
    # describing it as "contractor traced each facet" was simply untrue.
    if facets and all(_is_3d(f) for f in facets):
        source = "solar_3d"
    method_descriptions = {
        "aerial_outline": (
            "Contractor traced each roof facet as a polygon over a Web "
            "Mercator satellite tile. Every length in this report — eaves, "
            "rakes, ridges, hips and valleys — and every facet area derive "
            "deterministically from those traced vertices and the latitude-"
            "corrected metres-per-pixel of the imagery. Pitch is the one input "
            "that does not come from the trace, and its source is stated per "
            "facet: a measured pitch (Google Solar or LiDAR) where one is "
            "available for that plane, otherwise the value the contractor set, "
            "otherwise an unverified default."
        ),
        "blueprint": (
            "Roof measurements were extracted from an uploaded blueprint "
            "via vision LLM analysis. Linear feet figures are read from "
            "the dimension scale on the drawing."
        ),
        "aerial_solar": (
            "Roof planes and pitches came from Google Solar API's "
            "buildingInsights endpoint, which analyses high-resolution oblique "
            "imagery. Google returns each plane's pitch, orientation, area and "
            "a bounding box — it does NOT return roof edges, so any ridge, hip, "
            "valley, eave or rake length in this report was measured from the "
            "traced outline, not supplied by Google."
        ),
        "manual": (
            "All measurements were entered by the contractor without AI "
            "assistance."
        ),
        "solar_3d": (
            "Measured automatically from Google's 3D height data for this building "
            "(Solar API Data Layers: a surface model at about 10 cm per pixel, from "
            "the imagery date shown on page one). Each roof plane was fitted to the "
            "heights, so pitch and facing are measured for every facet, not assumed. "
            "Ridges, hips and valleys are the exact lines where two fitted planes "
            "meet; eaves and rakes are the outer edges of each plane; a drop between "
            "two roof levels is recorded as the upper roof's edge plus step flashing "
            "on the lower one. The outline was then aligned to the satellite photo "
            "the contractor confirmed the house on. A line the height data could not "
            "type is left untyped rather than guessed, and is not counted in the "
            "totals until the contractor sets it."
            + (" Where the contractor adjusted a facet's outline afterwards, the "
               "areas and lengths follow the adjusted outline; its pitch is still "
               "the measured one." if any(f.get("pitch_source") == "solar_3d_edited"
                                          for f in (facets or [])) else "")
        ),
    }
    desc = method_descriptions.get(source, "Mixed-source measurement run.")

    flow.append(Paragraph(f"<b>Measured by:</b> {_measured_by(run, facets or [])}", styles["body"]))
    flow.append(Paragraph(desc, styles["body"]))
    flow.append(Spacer(1, 8))

    # Confidence breakdown
    conf_label, conf_color = _confidence_bucket(run.get("confidence") or 0)
    flow.append(Paragraph(
        f"<b>Overall confidence:</b> <font color='{conf_color.hexval()}'>{conf_label}</font>",
        styles["body"],
    ))
    flow.append(Paragraph(
        "Confidence reflects how complete and well-grounded the measurement "
        "inputs are — weighted across: edges labeled (ridge/hip/valley/eave/"
        "rake/wall), roof pitch confirmed, scale source (reference object &gt; "
        "satellite tile &gt; estimated), and facet geometry. It is a measure of "
        "input completeness, not a guarantee of absolute accuracy — verify "
        "on-site before ordering.",
        styles["muted"],
    ))
    # WHY confidence is what it is, when something outside the inputs lowered
    # it: a trace that covers less of the building than Google sees, or a
    # coarse tile. A lowered score with no reason reads as the app being
    # arbitrary; the reason is the part the contractor can act on.
    reasons = [s for s in (aggregates.get("partial_signals") or []) if s]
    if reasons:
        flow.append(Spacer(1, 4))
        flow.append(Paragraph("<b>Check before ordering:</b>", styles["body"]))
        for s in reasons:
            flow.append(Paragraph(f"• {s}", styles["muted"]))
    tc = aggregates.get("trace_coverage") or {}
    if tc and not tc.get("capped"):
        # Worth saying when it passes too — it is the one independent check.
        flow.append(Paragraph(
            f"<b>Coverage check:</b> the trace covers {float(tc.get('ratio') or 0):.0%} of the "
            f"{float(tc.get('reference_sqft') or 0):,.0f} sq ft {tc.get('basis') or 'footprint'} "
            "Google Solar measures for this building.",
            styles["muted"],
        ))
    flow.append(Spacer(1, 6))

    # Imagery health — usability of the tile, and separately how fine it is.
    # "100/100" on a zoom-19 tile the contractor could not see facets on was
    # true about the first and silent about the second.
    if run.get("imagery_health") is not None:
        ftpp = aggregates.get("imagery_ft_per_px")
        res = f" · {float(ftpp):.2f} ft per pixel" if ftpp else ""
        flow.append(Paragraph(
            f"<b>Imagery health:</b> {(run.get('imagery_health') or 0) * 100:.0f} / 100{res}",
            styles["body"],
        ))
    if run.get("warnings"):
        flow.append(Paragraph("<b>Warnings recorded during measurement:</b>", styles["body"]))
        for w in run.get("warnings") or []:
            flow.append(Paragraph(f"• {w}", styles["muted"]))

    # DEFECT-08: the old "verified accuracy: within X% across N jobs" line is
    # removed. At n=3 it was statistically meaningless and, at 41.7%, actively
    # advertised a huge possible error. Per Phase 4 / rule #5, Axis makes NO
    # published accuracy claim until the validation set exists (50+ field-verified
    # jobs, reporting mean absolute % error AND 90th-percentile error stratified by
    # complexity band). That section will be reintroduced here in Phase 4.

    flow.append(Spacer(1, 8))
    flow.append(Paragraph(
        "Measured with Axis Roofing Performance — generated %s" % datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        styles["muted"],
    ))
    return flow


# ----------------------------------------------------------------------------
# Public entry
# ----------------------------------------------------------------------------

def _section_photos(run: dict, styles: dict) -> list:
    """Photos page — the aerial tile + the contractor's uploaded ground photos.
    Real images only; downloads each and embeds two per row."""
    import urllib.request

    flow = [_section_header("Property Photos", 10, styles)]
    items: list[tuple[str, str]] = []
    # The aerial is page 2, full size. Repeating it here as a thumbnail added
    # nothing except a second look at the same picture.
    for i, u in enumerate(run.get("ground_photo_urls") or []):
        # Entries are {url, slot} now; legacy rows may be plain URL strings.
        url = u.get("url") if isinstance(u, dict) else u
        label = (u.get("slot") if isinstance(u, dict) else None) or f"Ground photo {i + 1}"
        if url:
            items.append((str(label).replace("_", " ").title(), url))

    if not items:
        flow.append(Paragraph(
            "No photos captured. Upload ground photos in the editor to include them here.",
            styles["muted"]))
        return flow

    cap_style = styles.get("small") or styles["muted"]
    rows: list[list] = []
    row: list = []
    for caption, url in items[:12]:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AxisReport/1.0"})
            with urllib.request.urlopen(req, timeout=15) as r:
                data = r.read()
            cell = [Image(io.BytesIO(data), width=3.1 * inch, height=2.3 * inch, kind="proportional"),
                    Paragraph(caption, cap_style)]
        except Exception:
            logger.info("report: could not fetch photo %s", url)
            continue
        row.append(cell)
        if len(row) == 2:
            rows.append(row)
            row = []
    if row:
        while len(row) < 2:
            row.append("")
        rows.append(row)

    if rows:
        t = Table(rows, colWidths=[3.45 * inch, 3.45 * inch])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
        ]))
        flow.append(t)
    else:
        flow.append(Paragraph("Photos could not be loaded.", styles["muted"]))
    return flow


_PROJECT_PHASE_LABELS = [
    ("before", "Before"),
    ("render", "Proposed \u2014 AI Render"),
    ("damage", "Damage"),
    ("progress", "In-progress"),
    ("completed", "Completed / After"),
]


def _section_project_photos(project_photos: list[dict], styles: dict) -> list:
    """Job photos the contractor organized by phase (Before / Damage / After),
    with captions. Clean client/insurance-facing shots — crew markup is omitted."""
    import urllib.request

    if not project_photos:
        return []
    flow: list = [_section_header("Job Photos", 11, styles)]
    cap_style = styles.get("small") or styles["muted"]
    any_rendered = False

    for phase_key, phase_label in _PROJECT_PHASE_LABELS:
        in_phase = [p for p in project_photos if (p.get("phase") or "before") == phase_key and p.get("url")]
        if not in_phase:
            continue
        rows: list[list] = []
        row: list = []
        for p in in_phase[:8]:
            try:
                req = urllib.request.Request(p["url"], headers={"User-Agent": "AxisReport/1.0"})
                with urllib.request.urlopen(req, timeout=15) as r:
                    data = r.read()
                cell = [Image(io.BytesIO(data), width=3.1 * inch, height=2.3 * inch, kind="proportional")]
                if p.get("caption"):
                    cell.append(Paragraph(str(p["caption"]), cap_style))
            except Exception:
                logger.info("report: could not fetch project photo")
                continue
            row.append(cell)
            if len(row) == 2:
                rows.append(row); row = []
        if row:
            while len(row) < 2:
                row.append("")
            rows.append(row)
        if not rows:
            continue
        any_rendered = True
        flow.append(Paragraph(phase_label, styles["h2"]))
        t = Table(rows, colWidths=[3.45 * inch, 3.45 * inch])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
        ]))
        flow.append(t)
        flow.append(Spacer(1, 6))

    return flow if any_rendered else []


def _page_furniture(address: str, project_name: str):
    """Header drawn on every page after the cover.

    Axis mark top-left with the property address beneath it, and
    "Report: <project>" on the right — so a page separated from the rest still
    says what it is and which property it belongs to.
    """
    def draw(canvas, doc):
        canvas.saveState()
        w, h = letter
        y = h - 0.42 * inch
        canvas.setFillColor(BRAND)
        canvas.setFont("Helvetica-Bold", 11)
        canvas.drawString(0.6 * inch, y, "Axis")
        wid = canvas.stringWidth("Axis", "Helvetica-Bold", 11)
        canvas.setFillColor(MUTED)
        canvas.setFont("Helvetica", 11)
        canvas.drawString(0.6 * inch + wid + 3, y, "Performance")
        if address:
            canvas.setFont("Helvetica", 7.5)
            canvas.drawString(0.6 * inch, y - 11, address[:78])
        if project_name:
            canvas.setFont("Helvetica-Bold", 8)
            canvas.drawRightString(w - 0.6 * inch, y, f"Report: {project_name[:44]}")
        canvas.setStrokeColor(BORDER)
        canvas.setLineWidth(0.5)
        canvas.line(0.6 * inch, y - 18, w - 0.6 * inch, y - 18)
        canvas.setFillColor(MUTED)
        canvas.setFont("Helvetica", 7.5)
        canvas.drawCentredString(w / 2, 0.38 * inch, f"Page {canvas.getPageNumber()}")
        canvas.restoreState()
    return draw


def _full_page_figure(title: str, caption: str, png: bytes | None, styles: dict,
                      note: str | None = None) -> list:
    """One diagram, centred, filling the page — the way a roofer reads a plan.

    Returns [] when the image could not be built, so the report never prints a
    heading over an empty frame.
    """
    if not png:
        return []
    flow: list = [Spacer(1, 26), Paragraph(title, styles["subtitle"])]
    if caption:
        flow.append(Paragraph(caption, styles["muted"]))
    flow.append(Spacer(1, 12))
    img = Image(io.BytesIO(png))
    avail_w, avail_h = 7.0 * inch, 7.6 * inch
    ratio = img.imageWidth / max(1, img.imageHeight)
    w = min(avail_w, avail_h * ratio)
    img.drawWidth, img.drawHeight = w, w / ratio
    img.hAlign = "CENTER"
    flow.append(img)
    if note:
        flow.append(Spacer(1, 10))
        flow.append(Paragraph(note, styles["muted"]))
    return flow


def _is_3d(f: dict) -> bool:
    """Measured from Google's 3D data, including a facet whose outline the
    contractor then nudged: its plane, pitch and lines still came from 3D."""
    return str(f.get("pitch_source") or "").startswith("solar_3d")


def _measured_by(run: dict, facets: list[dict]) -> str:
    """Who or what produced the geometry, in words a homeowner or adjuster reads.
    The raw source code ("aerial_outline") was printed as-is before."""
    if facets and all(_is_3d(f) for f in facets):
        edited = sum(1 for f in facets if f.get("pitch_source") == "solar_3d_edited")
        if edited:
            return f"Google 3D height data (auto-measured; {edited} outline{'s' if edited != 1 else ''} adjusted by contractor)"
        return "Google 3D height data (auto-measured)"
    return {
        "aerial_outline": "Contractor trace over satellite imagery",
        "aerial_solar": "Google Solar planes + contractor trace",
        "blueprint": "Blueprint",
        "manual": "Entered by contractor",
    }.get(str(run.get("source") or ""), str(run.get("source") or "—"))


def _pitch_range(facets: list[dict]) -> str:
    vals = []
    for f in facets:
        try:
            vals.append(float(str(f.get("pitch") or "").split("/")[0]))
        except ValueError:
            pass
    if not vals:
        return "—"
    lo, hi = min(vals), max(vals)
    fmt = lambda v: f"{v:g}/12"
    return fmt(lo) if abs(hi - lo) < 0.05 else f"{fmt(lo)} – {fmt(hi)}"


def _cover_page(project: dict, run: dict, aggregates: dict, contractor: dict | None,
                toc_entries: list[tuple[str, str]], styles: dict,
                facets: list[dict] | None = None, aerial_png: bytes | None = None) -> list:
    """Page one: who produced it, which property, the headline numbers, the roof
    itself, and what is inside.

    This used to be two pages — a cover, then an "executive summary" three
    pages later repeating the logo, the company name, the address and the
    satellite photo — with the photo printed a third time on its own page.
    One page now carries all of it once."""
    from reportlab.lib.styles import ParagraphStyle
    facets = facets or []
    c = contractor or {}
    company = c.get("company_name") or "Axis Roofing Performance"
    address = _normalize_address(project.get("address"), project.get("city"),
                                 project.get("state"), project.get("zip")) or (project.get("name") or "Property")
    brand_hex = f"#{BRAND.hexval()[2:]}"
    muted_hex = f"#{MUTED.hexval()[2:]}"
    W = 7.3 * inch
    left = ParagraphStyle("CoverLeft", parent=styles["muted"], alignment=0)
    name_style = ParagraphStyle("CoverName", parent=styles["title"], alignment=0,
                                fontSize=19, leading=22, spaceAfter=2)
    flow: list = []

    # ── Brand row: the contractor's report, produced on Axis ─────────────
    left_stack: list = []
    if c.get("logo_bytes"):
        try:
            img = Image(io.BytesIO(c["logo_bytes"]))
            ratio = img.imageWidth / max(1, img.imageHeight)
            img.drawHeight = 0.85 * inch
            img.drawWidth = min(3.2 * inch, 0.85 * inch * ratio)
            img.hAlign = "LEFT"
            left_stack += [img, Spacer(1, 4)]
        except Exception:
            pass
    left_stack.append(Paragraph(company, name_style))
    contact = [b_ for b_ in [
        f"License {c['license_number']}" if c.get("license_number") else None,
        _format_phone(c.get("phone")), c.get("email"),
    ] if b_]
    if contact:
        left_stack.append(Paragraph(" · ".join(contact), left))
    axis_mark = Paragraph(
        f"<para align='right'><font size=7 color='{muted_hex}'>POWERED BY</font><br/>"
        f"<font size=15 color='{brand_hex}'><b>Axis</b></font>"
        f"<font size=15 color='{muted_hex}'> Performance</font><br/>"
        f"<font size=7 color='{muted_hex}'>SATELLITE ROOF INTELLIGENCE</font></para>", left)
    head = Table([[left_stack, axis_mark]], colWidths=[W - 2.4 * inch, 2.4 * inch])
    head.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("LINEBELOW", (0, 0), (-1, 0), 0.75, BORDER),
    ]))
    flow += [head, Spacer(1, 12)]

    # ── Which property, when ─────────────────────────────────────────────
    prepared = datetime.now().strftime("%B %-d, %Y")
    flow.append(Paragraph(
        f"<font size=9 color='{muted_hex}'>ROOF MEASUREMENT REPORT · {prepared.upper()}</font>", left))
    flow.append(Spacer(1, 3))
    flow.append(Paragraph(f"<font size=15 color='#0f172a'><b>{address}</b></font>",
                          ParagraphStyle("CoverAddr", parent=left, leading=19)))

    # A partial measurement has to announce itself on the FIRST thing anyone
    # reads. Buried later it becomes a technicality someone quotes back after
    # ordering material for a roof this report never covered.
    if (run.get("measurement_scope") or "full") == "partial":
        note = (run.get("scope_note") or "").strip()
        banner = Table([[Paragraph(
            "<b>PARTIAL MEASUREMENT</b> — this report covers only the traced section of "
            "the roof, not the whole building. Areas, lengths and any quantities below "
            "describe that section alone."
            + (f"<br/><i>{note}</i>" if note else ""),
            styles["body"])]], colWidths=[W])
        banner.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FEF3C7")),
            ("BOX", (0, 0), (-1, -1), 1.0, colors.HexColor("#D97706")),
            ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ]))
        flow += [Spacer(1, 8), banner]
    flow.append(Spacer(1, 10))

    # ── The four numbers people come for ─────────────────────────────────
    conf_label, conf_color = _confidence_bucket(run.get("confidence") or 0)
    # "Moderate (70%)" at headline size wrapped onto two lines; the word leads.
    conf_word, _, conf_pct = conf_label.partition(" ")
    hero = Table([[
        Paragraph(_sqft(aggregates.get("total_roof_sqft")), styles["hero_num"]),
        Paragraph(_sq(aggregates.get("squares")), styles["hero_num"]),
        Paragraph(str(aggregates.get("predominant_pitch") or "—"), styles["hero_num"]),
        Paragraph(f"<font color='{conf_color.hexval()}'>{conf_word}</font>"
                  f"<font size=11 color='{conf_color.hexval()}'> {conf_pct}</font>", styles["hero_num"]),
    ], [
        Paragraph("TRUE ROOF AREA", styles["hero_label"]),
        Paragraph("ROOFING SQUARES", styles["hero_label"]),
        Paragraph("PREDOMINANT PITCH", styles["hero_label"]),
        Paragraph("MEASUREMENT CONFIDENCE", styles["hero_label"]),
    ]], colWidths=[W / 4] * 4)
    hero.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SURFACE),
        ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
        ("LINEAFTER", (0, 0), (2, -1), 0.5, BORDER),
        ("TOPPADDING", (0, 0), (-1, 0), 10), ("BOTTOMPADDING", (0, 0), (-1, 0), 2),
        ("TOPPADDING", (0, 1), (-1, 1), 2), ("BOTTOMPADDING", (0, 1), (-1, 1), 9),
    ]))
    flow.append(hero)
    # Confidence is input completeness, not an accuracy guarantee — said
    # beside the number, not only in the methodology at the back.
    conf_note = ("Confidence measures how complete and well-grounded the measurement is. "
                 "It is not a guarantee of accuracy — verify on site before ordering material.")
    tc = aggregates.get("trace_coverage") or {}
    if tc.get("capped") and float(tc.get("ratio") or 1) < 1:
        conf_note = (f"<b>Confidence was lowered: the measured outline covers about "
                     f"{float(tc['ratio']):.0%} of the building Google sees.</b> Part of the roof may "
                     "be missing — see Methodology before ordering. " + conf_note)
    flow += [Spacer(1, 4), Paragraph(conf_note, styles["muted"]), Spacer(1, 10)]

    # ── The roof itself: the report's only satellite image ───────────────
    if aerial_png:
        try:
            img = Image(io.BytesIO(aerial_png))
            ratio = img.imageWidth / max(1, img.imageHeight)
            h = min(3.15 * inch, W / ratio)
            img.drawHeight, img.drawWidth = h, h * ratio
            img.hAlign = "CENTER"
            provider = (run.get("satellite_provider") or "satellite").strip()
            zoom = run.get("satellite_zoom")
            if provider.lower() == "google 3d":
                # Google's own aerial photo, ~10 cm per pixel; the tile's zoom
                # number describes the frame, not this photo's sharpness.
                cap = "Subject roof — Google's aerial photo (about 10 cm per pixel)."
            else:
                cap = f"Subject roof — {provider} imagery" + (f", zoom {zoom}" if zoom else "") + "."
            cap += " Photo only; nothing on it is drawn by Axis."
            flow += [img, Spacer(1, 3), Paragraph(cap, ParagraphStyle(
                "CoverCap", parent=styles["muted"], alignment=1, fontSize=7.5)), Spacer(1, 10)]
        except Exception:
            logger.debug("cover image failed", exc_info=True)

    # ── Quick facts, two columns ─────────────────────────────────────────
    waste = int(aggregates.get("waste_pct_default") or 12)
    facts = [
        ("Facets", str(aggregates.get("facet_count") or len(facets) or 0)),
        ("Plan area (footprint)", _sqft(aggregates.get("total_plan_sqft"))),
        ("Measured by", _measured_by(run, facets)),
        ("Complexity", f"{float(aggregates.get('complexity_score') or 0):.2f} of 1.00"),
        ("Pitch range", _pitch_range(facets)),
        ("Recommended waste", f"{waste}%"),
    ]
    cells = [[Paragraph(f"<font color='{muted_hex}'>{k}</font>", styles["muted"]),
              Paragraph(f"<b>{v}</b>", ParagraphStyle("Fact", parent=styles["body"], fontSize=9, leading=11))]
             for k, v in facts]
    half = (len(cells) + 1) // 2
    grid = [cells[i] + (cells[i + half] if i + half < len(cells) else ["", ""]) for i in range(half)]
    g = Table(grid, colWidths=[1.25 * inch, W / 2 - 1.25 * inch] * 2)
    g.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, BORDER),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
    ]))
    flow += [g, Spacer(1, 12)]

    # ── Contents, two columns ────────────────────────────────────────────
    flow.append(Paragraph(f"<font size=9 color='{muted_hex}'><b>CONTENTS</b></font>", left))
    flow.append(Spacer(1, 3))
    items = [Paragraph(f"<font color='{brand_hex}'><b>{n}</b></font>&nbsp;&nbsp;{t_}",
                       ParagraphStyle("Toc", parent=styles["body"], fontSize=8.5, leading=11))
             for n, t_ in toc_entries]
    half = (len(items) + 1) // 2
    rows = [[items[i], items[i + half] if i + half < len(items) else ""] for i in range(half)]
    toc = Table(rows, colWidths=[W / 2] * 2)
    toc.setStyle(TableStyle([
        ("TOPPADDING", (0, 0), (-1, -1), 1.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    flow.append(toc)
    flow.append(PageBreak())
    return flow


def _section_legal_notice(styles: dict) -> list:
    """Closing notice — what this report is, and what it deliberately is not.

    NC G.S. 89C defines the practice of land surveying broadly enough to cover
    measurements of "improvements on the earth" gathered "by aerial photography"
    using "photogrammetry" and presented in a report — which describes the
    mechanics of this document. What the statute actually polices is boundary
    and property-line work, and Axis does none of it: no property lines, no
    easements, no lot dimensions, nothing offered as a survey.

    Saying so on the document itself matters more than saying it in a contract
    nobody reads, because the report is the artefact that travels — it gets
    forwarded to homeowners, adjusters and lenders, none of whom saw the terms.
    """
    flow = [Spacer(1, 16)]
    flow.append(Paragraph(
        "<b>About this report</b>", styles["body"]))
    flow.append(Spacer(1, 4))
    flow.append(Paragraph(
        "This is a roof measurement report prepared for construction estimating and "
        "material ordering. Measurements are derived from aerial imagery and the roof "
        "outline traced by the contractor, together with pitch data where a measured "
        "source is available.",
        styles["muted"]))
    flow.append(Spacer(1, 5))
    flow.append(Paragraph(
        "<b>It is not a land survey.</b> It is not a boundary determination and must not "
        "be relied on as one. It does not locate, establish or retrace any property line, "
        "easement, lot dimension or right of way, and it is not prepared by, or under the "
        "responsible charge of, a licensed professional land surveyor or engineer. It is "
        "not suitable for conveyance, permitting, legal description of land, or any "
        "purpose requiring a survey performed under N.C. Gen. Stat. Chapter 89C or the "
        "equivalent law of another state.",
        styles["muted"]))
    flow.append(Spacer(1, 5))
    flow.append(Paragraph(
        "Quantities are estimates. Verify conditions on site before ordering material or "
        "committing to a price. Where a pitch is shown as unverified or defaulted, it has "
        "not been independently measured and every quantity that depends on it should be "
        "confirmed.",
        styles["muted"]))
    return flow


def generate_v2_report(
    project: dict,
    run: dict,
    aggregates: dict,
    facets: list[dict],
    edges: list[dict],
    penetrations: list[dict],
    material_lines: list[MaterialLine],
    siding_measurements: list[dict],
    flashing: dict | None = None,
    contractor: dict | None = None,     # white-label: company_name, license_number, phone, email, logo_bytes
    calibration: dict | None = None,    # accuracy flywheel: {jobs, mean_abs_pct_error}
    project_photos: list[dict] | None = None,  # crew gallery: [{phase, caption, url}]
    report_warnings: list[dict] | None = None,  # §4.4 non-blocking notices: [{code, message}]
    # Flashing and siding are parked in the product while they are reworked.
    # Passing False omits the SECTION entirely — starving it of data instead
    # would still print its heading (and, for siding, a placeholder explaining
    # the workflow), which is a worse artifact than the numbers were.
    include_flashing: bool = True,
    include_siding: bool = True,
) -> bytes:
    """Render the full report PDF and return bytes."""
    buf = io.BytesIO()
    company = (contractor or {}).get("company_name") or "Axis Roofing Performance"
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        topMargin=0.6 * inch, bottomMargin=0.6 * inch,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        title=f"{company} — Roof Report",
        author=company,
    )
    styles = _styles()
    default_waste = int(run.get("waste_pct_default") or aggregates.get("waste_pct_default") or 12)

    address = _normalize_address(project.get("address"), project.get("city"),
                                 project.get("state"), project.get("zip")) or (project.get("name") or "")
    project_name = (project.get("name") or address or "Roof Report").strip().rstrip(",").strip()

    # Build the three plan pages first: a page that could not be rendered must
    # not appear in the contents, so the table never promises a missing page.
    sat_png = None
    if run.get("satellite_image_url"):
        try:
            raw = _fetch_satellite_image(run["satellite_image_url"])
            sat_png = _crop_image_to_facets(raw, facets, subject_point=run.get("subject_point")) or raw
        except Exception as e:
            logger.info("cover satellite fetch failed: %s", e)
    length_png = _render_length_diagram(facets, edges)
    pitch_png = _render_pitch_diagram(facets)

    # The satellite photo appears ONCE, on page one. It used to have a page of
    # its own and then be printed again on the summary page.
    plan_pages = [
        ("Length Diagram", length_png,
         "Every roof line, labelled with its measured length.",
         "Lengths are the stored per-edge measurements that the Roof Line table totals — "
         "a shared line is labelled once, from one side only."),
        ("Pitch Diagram", pitch_png,
         "Each roof plane, shaded by steepness and labelled with its pitch.",
         "Shading runs shallow to steep across this roof only. A plane whose pitch was never "
         "confirmed is drawn grey and marked unverified."),
    ]
    available = [(t, png, cap, note) for (t, png, cap, note) in plan_pages if png]

    project_photo_flow_probe = bool(project_photos)
    sections = ["Roof Summary", "Roof Line Measurements"] + \
               (["Flashing Report"] if include_flashing else []) + \
               ["Roof Penetrations", "Material Ordering Summary"] + \
               (["Exterior Measurements"] if include_siding else []) + \
               ["Methodology & Confidence", "Property Photos"] + \
               (["Job Photos"] if project_photo_flow_probe else [])
    toc: list[tuple[str, str]] = []
    for i, (t, _png, _cap, _note) in enumerate(available):
        toc.append((f"p.{i + 2}", t))
    for i, label in enumerate(sections):
        toc.append((f"§{i + 1}", label))

    styles["_section_no"] = [0]
    story: list = []
    story.extend(_cover_page(project, run, aggregates, contractor, toc, styles,
                             facets=facets, aerial_png=sat_png))

    for (t, png, cap, note) in available:
        story.extend(_full_page_figure(t, cap, png, styles, note))
        story.append(PageBreak())

    story.extend(_section_2_roof_summary(aggregates, facets, styles, run=run))
    # §4.4: surface non-blocking notices so an assumed value (e.g. zero penetrations)
    # is never presented as a reviewed fact.
    if report_warnings:
        story.append(Spacer(1, 8))
    for w in (report_warnings or []):
        story.append(Paragraph(f"⚠ {w.get('message', '')}", styles["muted"]))
    story.append(Spacer(1, 16))
    story.extend(_section_3_roof_lines(aggregates, edges, styles))
    story.append(Spacer(1, 10))
    if include_flashing:
        story.extend(_section_4_flashing(aggregates, material_lines, styles, flashing))
    story.append(PageBreak())
    story.extend(_section_5_penetrations(penetrations, styles))
    # Field Observations is omitted while nothing populates it: ground photos are
    # analysed in memory and never persisted, so the section could only ever
    # print its own heading over an empty space. Restore it when ground photos
    # are stored.
    story.append(Spacer(1, 14))
    # A material order from a partial trace is the one output that can cost
    # real money: it looks like a complete bill of materials for a roof it
    # never measured. Replace it with what it actually is.
    if (run.get("measurement_scope") or "full") == "partial":
        story.append(_section_header("Material Ordering Summary", 7, styles))
        story.append(Paragraph(
            "<b>No material order is produced for a partial measurement.</b> These "
            "quantities would describe only the traced section, and a partial order "
            "read as a whole-roof order is how a job comes up short on site. Complete "
            "the outline to generate an order, or price the traced section by hand "
            "from the roof-line measurements above.",
            styles["body"]))
    else:
        story.extend(_section_6_materials(material_lines, default_waste, styles))
    story.append(PageBreak())
    if include_siding:
        story.extend(_section_7_exterior(siding_measurements, styles))
        story.append(Spacer(1, 10))
    story.extend(_section_8_methodology(run, aggregates, styles, calibration, facets=facets))
    story.append(Spacer(1, 16))
    story.extend(_section_photos(run, styles))

    project_photo_flow = _section_project_photos(project_photos or [], styles)
    if project_photo_flow:
        story.append(PageBreak())
        story.extend(project_photo_flow)

    # Last thing in the document, on whatever page the report ends.
    story.extend(_section_legal_notice(styles))

    furniture = _page_furniture(address, project_name)
    # The cover carries its own branding, so the running header starts on page 2.
    doc.build(story, onFirstPage=lambda c, d: None, onLaterPages=furniture)
    return buf.getvalue()
