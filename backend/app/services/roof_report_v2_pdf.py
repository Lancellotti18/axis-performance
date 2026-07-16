"""
Axis Performance — Roof Report v2 PDF.

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


def _section_header(text: str, n: int, styles: dict) -> Paragraph:
    return Paragraph(f"<font color='#1e40af'><b>Section {n}.</b></font> &nbsp; {text}", styles["h2"])


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

def _section_1_executive(
    project: dict, run: dict, aggregates: dict, facet_count: int,
    styles: dict, facets: list[dict] | None = None,
    contractor: dict | None = None,
) -> list:
    """Executive Summary — top of the report."""
    flow: list = []
    addr_parts = [project.get("address"), project.get("city"),
                  f"{(project.get('state') or '').strip()} {(project.get('zip') or '').strip()}".strip()]
    full_address = ", ".join(p for p in addr_parts if p)
    if not full_address:
        full_address = project.get("name") or "Property"

    # Branded header: the contractor's brand on the LEFT (logo bigger + name),
    # "Powered by Axis" credited on the RIGHT — both marks visible, not a tiny
    # corner logo with Axis buried in a footnote.
    c = contractor or {}
    company = c.get("company_name") or "Axis Performance"
    logo_bytes = c.get("logo_bytes")
    brand_hex = f"#{BRAND.hexval()[2:]}"
    muted_hex = f"#{MUTED.hexval()[2:]}"

    # Left-aligned clone of the title so the company name lines up under the
    # logo (the base "title" style inherits center alignment).
    from reportlab.lib.styles import ParagraphStyle
    title_left = ParagraphStyle("TitleLeft", parent=styles["title"], alignment=0)
    muted_left = ParagraphStyle("MutedLeft", parent=styles["muted"], alignment=0)

    left_stack: list = []
    if logo_bytes:
        try:
            img = Image(io.BytesIO(logo_bytes))
            ratio = img.imageWidth / max(1, img.imageHeight)
            img.drawHeight = 1.1 * inch
            img.drawWidth = min(3.6 * inch, 1.1 * inch * ratio)
            img.hAlign = "LEFT"
            left_stack.append(img)
            left_stack.append(Spacer(1, 6))
        except Exception:
            pass
    left_stack.append(Paragraph(company, title_left))
    prepared_bits = [b for b in [
        f"License {c['license_number']}" if c.get("license_number") else None,
        c.get("phone"), c.get("email"),
    ] if b]
    if prepared_bits:
        left_stack.append(Paragraph(" · ".join(prepared_bits), muted_left))

    axis_mark = Paragraph(
        f"<para align='right'><font size=7 color='{muted_hex}'>POWERED BY</font><br/>"
        f"<font size=16 color='{brand_hex}'><b>Axis</b></font>"
        f"<font size=16 color='{muted_hex}'> Performance</font><br/>"
        f"<font size=7 color='{muted_hex}'>Satellite roof intelligence</font></para>",
        styles["muted"],
    )
    header = Table([[left_stack, axis_mark]], colWidths=[4.4 * inch, 2.5 * inch])
    header.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    flow.append(header)
    flow.append(Spacer(1, 8))
    flow.append(Paragraph("Roof Measurement Report", styles["subtitle"]))
    flow.append(Paragraph(full_address, styles["muted"]))

    # Hero cards
    conf_label, conf_color = _confidence_bucket(run.get("confidence") or 0)
    hero = [[
        Paragraph(_sqft(aggregates.get("total_roof_sqft")), styles["hero_num"]),
        Paragraph(_sq(aggregates.get("squares")), styles["hero_num"]),
        Paragraph(str(aggregates.get("predominant_pitch") or "—"), styles["hero_num"]),
        Paragraph(f"<font color='{conf_color.hexval()}'>{conf_label}</font>", styles["hero_num"]),
    ], [
        Paragraph("True Roof Area", styles["hero_label"]),
        Paragraph("Roofing Squares", styles["hero_label"]),
        Paragraph("Predominant Pitch", styles["hero_label"]),
        Paragraph("Measurement Confidence", styles["hero_label"]),
    ]]
    t = Table(hero, colWidths=[1.7 * inch] * 4)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SURFACE),
        ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, BORDER),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    flow.append(t)
    flow.append(Spacer(1, 12))

    # Quick facts
    facts = [
        ["Facets", str(facet_count)],
        ["Complexity", f"{aggregates.get('complexity_score', 0):.2f} / 1.00"],
        ["Recommended waste", f"{int(aggregates.get('waste_pct_default') or 12)}%"],
        ["Source", str(run.get("source") or "—")],
        ["Report generated", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")],
    ]
    ft = Table(facts, colWidths=[2.0 * inch, 4.5 * inch])
    ft.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("TEXTCOLOR", (0, 0), (0, -1), MUTED),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, BORDER),
    ]))
    flow.append(ft)
    flow.append(Spacer(1, 12))

    # Satellite image (if available)
    img_url = run.get("satellite_image_url")
    if img_url:
        data = _fetch_satellite_image(img_url)
        if data:
            try:
                # Crop to the subject roof so the report shows only THIS house,
                # not the neighbors (the contractor already confirmed the house).
                cropped = _crop_image_to_facets(data, facets or [], subject_point=run.get("subject_point"))
                shown = cropped or data
                flow.append(Image(io.BytesIO(shown), width=6.5 * inch, height=4.0 * inch, kind="proportional"))
                provider = (run.get("satellite_provider") or "satellite").lower()
                note = "Subject roof" if cropped else "Aerial"
                flow.append(Paragraph(
                    f"{note} — {provider} imagery (Web Mercator, zoom {run.get('satellite_zoom') or '—'})",
                    styles["muted"],
                ))
            except Exception:
                logger.debug("v2 report: image render failed", exc_info=True)
    return flow


def _section_2_roof_summary(aggregates: dict, facets: list[dict], styles: dict) -> list:
    flow = [_section_header("Roof Summary", 2, styles)]

    # Roof diagram — facets drawn to scale + labeled (area / pitch).
    diagram = _render_facet_diagram(facets)
    if diagram:
        flow.append(Image(io.BytesIO(diagram), width=7.0 * inch, height=4.73 * inch))
        flow.append(Paragraph(
            "Roof facets drawn to scale, labeled with area and pitch. Built from your traced polygons.",
            styles.get("small") or styles["muted"]))
        flow.append(Spacer(1, 10))

    rows = [
        ["Metric", "Value", "Method"],
        ["Total roof area (true)", _sqft(aggregates.get("total_roof_sqft")),
         "Σ plan area × slope multiplier per facet"],
        ["Total plan area (footprint)", _sqft(aggregates.get("total_plan_sqft")), "Σ shoelace polygon area"],
        ["Roofing squares", _sq(aggregates.get("squares")), "true area ÷ 100"],
        ["Facet count", str(aggregates.get("facet_count") or 0), "user-traced polygons"],
        ["Predominant pitch", str(aggregates.get("predominant_pitch") or "—"),
         "largest-area facet's pitch"],
        ["Pitch (degrees)",
         f"{aggregates.get('predominant_pitch_degrees') or 0:.1f}°", "atan(rise/12)"],
        ["Complexity score", f"{aggregates.get('complexity_score', 0):.2f}",
         "deterministic from facet/valley/pitch variance"],
    ]
    t = Table(rows, colWidths=[2.0 * inch, 1.7 * inch, 2.8 * inch])
    t.setStyle(_table_style())
    flow.append(t)

    # Per-facet table
    if facets:
        flow.append(Spacer(1, 8))
        flow.append(Paragraph("Per-facet breakdown", styles["body"]))
        fac_rows = [["Facet", "Pitch", "Direction", "Plan ft²", "True ft²", "Confidence"]]
        for f in facets:
            label = f.get("facet_label") or "—"
            pitch = f.get("pitch") or "—"
            direction = f.get("slope_direction") or "—"
            plan = f.get("plan_area_sqft") or 0
            true = f.get("true_area_sqft") or 0
            conf = (f.get("confidence") or 0) * 100
            fac_rows.append([
                label, pitch, direction,
                f"{plan:,.1f}", f"{true:,.1f}", f"{conf:.0f}%",
            ])
        ft = Table(fac_rows, colWidths=[0.8 * inch, 1.0 * inch, 1.1 * inch, 1.2 * inch, 1.2 * inch, 1.0 * inch])
        ft.setStyle(_table_style(header_color=ACCENT))
        flow.append(ft)
    return flow


def _section_3_roof_lines(aggregates: dict, edges: list[dict], styles: dict) -> list:
    flow = [_section_header("Roof Line Measurements", 3, styles)]

    rows = [
        ["Type", "Total Linear Feet", "Material Implication"],
        ["Ridges", _ft(aggregates.get("ridges_ft")), "Drives ridge cap quantity"],
        ["Hips", _ft(aggregates.get("hips_ft")), "Adds to ridge cap; sloped lengths"],
        ["Valleys", _ft(aggregates.get("valleys_ft")), "Drives valley metal + ice/water shield"],
        ["Eaves", _ft(aggregates.get("eaves_ft")), "Starter strip, drip edge, ice/water shield"],
        ["Rakes", _ft(aggregates.get("rakes_ft")), "Starter strip + drip edge"],
        ["Perimeter (eaves + rakes)", _ft(aggregates.get("perimeter_ft")), "Drip edge total"],
        ["Ridge total (ridges + hips)", _ft(aggregates.get("ridge_total_ft")), "Cap shingle total"],
    ]
    t = Table(rows, colWidths=[2.0 * inch, 1.5 * inch, 3.0 * inch])
    t.setStyle(_table_style())
    flow.append(t)

    flow.append(Spacer(1, 8))
    flow.append(Paragraph(
        "<i>All linear lengths are slope-adjusted for rakes, hips, and valleys — "
        "the figure shown is the true length along the roof surface, which is "
        "what contractors order material against. Eaves and ridges are "
        "horizontal so plan and true lengths are equal.</i>",
        styles["muted"],
    ))

    # Per-edge breakdown
    if edges:
        flow.append(Spacer(1, 10))
        flow.append(Paragraph("Per-edge breakdown", styles["body"]))
        edge_rows = [["Type", "Plan ft", "Slope-adjusted ft", "Confirmed"]]
        for e in edges:
            t_ = e.get("edge_type") or "—"
            if t_ == "unlabeled":
                continue
            edge_rows.append([
                t_,
                f"{(e.get('plan_length_ft') or 0):,.1f}",
                f"{(e.get('slope_adjusted_ft') or 0):,.1f}",
                "Yes" if e.get("user_confirmed") else "No",
            ])
        if len(edge_rows) > 1:
            et = Table(edge_rows, colWidths=[1.8 * inch, 1.5 * inch, 1.8 * inch, 1.4 * inch])
            et.setStyle(_table_style(header_color=ACCENT))
            flow.append(et)
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

    rows = [["SKU", "Item", "Base qty", f"Qty @ {default_waste}%", "Unit", "Unit $", "Subtotal"]]
    for l in material_lines:
        rows.append([
            l.sku,
            l.item_name,
            f"{l.base_quantity:.2f}",
            str(l.waste_quantities.get(default_waste, 0)),
            l.unit,
            _currency(l.unit_cost),
            _currency(l.waste_quantities.get(default_waste, 0) * l.unit_cost),
        ])
    rows.append(["", "Grand total", "", "", "", "",
                 _currency(grand_total(material_lines, default_waste))])
    t = Table(rows, colWidths=[0.85 * inch, 2.3 * inch, 0.7 * inch, 0.85 * inch, 0.7 * inch, 0.7 * inch, 0.9 * inch])
    style = _table_style(header_color=ACCENT)
    style.add("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold")
    style.add("BACKGROUND", (0, -1), (-1, -1), SURFACE)
    style.add("LINEABOVE", (0, -1), (-1, -1), 1.0, BRAND_DARK)
    t.setStyle(style)
    flow.append(t)

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


def _section_8_methodology(run: dict, aggregates: dict, styles: dict, calibration: dict | None = None) -> list:
    flow = [_section_header("Methodology & Confidence", 9, styles)]

    source = run.get("source") or "unknown"
    method_descriptions = {
        "aerial_outline": (
            "Contractor traced each roof facet as a polygon over a Web "
            "Mercator satellite tile. Areas and edge lengths derive "
            "deterministically from the polygon vertices, the latitude-"
            "corrected metres-per-pixel of the imagery, and the per-facet "
            "pitch the contractor supplied."
        ),
        "blueprint": (
            "Roof measurements were extracted from an uploaded blueprint "
            "via vision LLM analysis. Linear feet figures are read from "
            "the dimension scale on the drawing."
        ),
        "aerial_solar": (
            "Roof segments and pitches came from Google Solar API's "
            "buildingInsights endpoint, which uses high-resolution oblique "
            "imagery analyzed by Google's models."
        ),
        "manual": (
            "All measurements were entered by the contractor without AI "
            "assistance."
        ),
    }
    desc = method_descriptions.get(source, "Mixed-source measurement run.")

    flow.append(Paragraph(f"<b>Measurement source:</b> {source}", styles["body"]))
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
    flow.append(Spacer(1, 6))

    # Imagery health
    if run.get("imagery_health") is not None:
        flow.append(Paragraph(
            f"<b>Imagery health:</b> {(run.get('imagery_health') or 0) * 100:.0f} / 100",
            styles["body"],
        ))
    if run.get("warnings"):
        flow.append(Paragraph("<b>Warnings recorded during measurement:</b>", styles["body"]))
        for w in run.get("warnings") or []:
            flow.append(Paragraph(f"• {w}", styles["muted"]))

    # Accuracy flywheel: real calibration from field-verified jobs. Only shown
    # once there's enough data to be meaningful — never a made-up number.
    if calibration and int(calibration.get("jobs") or 0) >= 3:
        err = float(calibration.get("mean_abs_pct_error") or 0)
        flow.append(Spacer(1, 6))
        flow.append(Paragraph(
            f"<b>Verified accuracy:</b> across {int(calibration['jobs'])} field-verified "
            f"jobs, Axis roof-area measurements averaged within {err:.1f}% of the "
            "crew's actual measurements.",
            styles["body"],
        ))

    flow.append(Spacer(1, 8))
    flow.append(Paragraph(
        "Measured with Axis Performance — generated %s" % datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
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
    if run.get("satellite_image_url"):
        items.append(("Aerial (satellite)", run["satellite_image_url"]))
    for i, u in enumerate(run.get("ground_photo_urls") or []):
        items.append((f"Ground photo {i + 1}", u))

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
) -> bytes:
    """Render the full report PDF and return bytes."""
    buf = io.BytesIO()
    company = (contractor or {}).get("company_name") or "Axis Performance"
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        topMargin=0.6 * inch, bottomMargin=0.6 * inch,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        title=f"{company} — Roof Report",
        author=company,
    )
    styles = _styles()
    default_waste = int(run.get("waste_pct_default") or aggregates.get("waste_pct_default") or 12)

    story: list = []
    story.extend(_section_1_executive(project, run, aggregates, len(facets), styles, facets, contractor))
    story.append(Spacer(1, 12))
    story.extend(_section_2_roof_summary(aggregates, facets, styles))
    story.append(PageBreak())
    story.extend(_section_3_roof_lines(aggregates, edges, styles))
    story.append(Spacer(1, 10))
    story.extend(_section_4_flashing(aggregates, material_lines, styles, flashing))
    story.append(PageBreak())
    story.extend(_section_5_penetrations(penetrations, styles))
    story.append(Spacer(1, 10))
    story.extend(_section_field_observations(run, styles))
    story.append(Spacer(1, 10))
    story.extend(_section_6_materials(material_lines, default_waste, styles))
    story.append(PageBreak())
    story.extend(_section_7_exterior(siding_measurements, styles))
    story.append(Spacer(1, 10))
    story.extend(_section_8_methodology(run, aggregates, styles, calibration))
    story.append(PageBreak())
    story.extend(_section_photos(run, styles))

    doc.build(story)
    return buf.getvalue()
