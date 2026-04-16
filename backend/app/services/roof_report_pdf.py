"""
Professional one-tap roof report PDF — axis-performance answer to EagleView.
Pulls confirmed roof measurements + shingle material list and lays them out
as a clean, insurance-submittable document.

Deliberately named "roof report" (not "estimate") so the output looks like
the measurement artifact adjusters already know how to read.
"""
from __future__ import annotations

import io
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
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

logger = logging.getLogger(__name__)

BRAND = colors.HexColor("#1e40af")
BRAND_DARK = colors.HexColor("#0f2a6b")
ACCENT = colors.HexColor("#3b82f6")
MUTED = colors.HexColor("#64748b")
SURFACE = colors.HexColor("#f1f5f9")
BORDER = colors.HexColor("#e2e8f0")
OK = colors.HexColor("#22c55e")
WARN = colors.HexColor("#f59e0b")
BAD = colors.HexColor("#ef4444")


def _confidence_bucket(c: float) -> tuple[str, colors.Color]:
    """Map 0-1 or 0-100 confidence to (label, color)."""
    v = c * 100 if c <= 1 else c
    if v >= 80:
        return f"High ({v:.0f}%)", OK
    if v >= 55:
        return f"Moderate ({v:.0f}%)", WARN
    return f"Low ({v:.0f}%)", BAD


def _fetch_satellite_image(url: str) -> Optional[bytes]:
    if not url:
        return None
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            r = client.get(url)
            r.raise_for_status()
            return r.content
    except Exception:
        logger.debug("roof_report: satellite image fetch failed", exc_info=True)
        return None


def _styles() -> dict:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "Title", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=24, leading=28, textColor=BRAND_DARK, spaceAfter=4,
        ),
        "subtitle": ParagraphStyle(
            "Subtitle", parent=base["Normal"], fontName="Helvetica",
            fontSize=11, leading=14, textColor=MUTED, spaceAfter=16,
        ),
        "h2": ParagraphStyle(
            "H2", parent=base["Heading2"], fontName="Helvetica-Bold",
            fontSize=14, leading=18, textColor=BRAND_DARK,
            spaceBefore=12, spaceAfter=6,
        ),
        "body": ParagraphStyle(
            "Body", parent=base["Normal"], fontName="Helvetica",
            fontSize=10, leading=14, textColor=colors.HexColor("#0f172a"),
        ),
        "muted": ParagraphStyle(
            "Muted", parent=base["Normal"], fontName="Helvetica",
            fontSize=8.5, leading=11, textColor=MUTED,
        ),
        "hero_num": ParagraphStyle(
            "HeroNum", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=22, leading=24, textColor=BRAND_DARK, alignment=1,
        ),
        "hero_label": ParagraphStyle(
            "HeroLabel", parent=base["Normal"], fontName="Helvetica",
            fontSize=8, leading=10, textColor=MUTED, alignment=1,
        ),
    }


def _hero_card(value: str, label: str, s: dict) -> Table:
    tbl = Table([[Paragraph(value, s["hero_num"])], [Paragraph(label.upper(), s["hero_label"])]],
                colWidths=[1.6 * inch], rowHeights=[0.55 * inch, 0.25 * inch])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SURFACE),
        ("BOX", (0, 0), (-1, -1), 0.75, BORDER),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    return tbl


def generate_roof_report_pdf(
    project: dict,
    measurements: dict,
    aerial: Optional[dict],
    materials: list[dict],
    total_materials_cost: float,
) -> bytes:
    """Build the roof report PDF and return bytes. Safe to call with partial data."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        topMargin=0.55 * inch, bottomMargin=0.6 * inch,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        title=f"Roof Report — {project.get('name', 'Property')}",
        author="BuildAI / axis-performance",
    )
    s = _styles()
    els: list = []

    project_name = project.get("name") or "Untitled Project"
    address_parts = [project.get("address"), project.get("city"),
                     project.get("region", "").replace("US-", ""), project.get("zip_code")]
    address = ", ".join([p for p in address_parts if p])
    now = datetime.now(timezone.utc).strftime("%B %d, %Y")
    report_id = f"RR-{project.get('id', '')[:8].upper() or 'DRAFT'}"

    # ── Header ──────────────────────────────────────────────────────────────
    header_left = Paragraph(
        '<font color="#1e40af"><b>axis performance</b></font> · '
        '<font color="#64748b">ROOF MEASUREMENT REPORT</font>',
        s["body"],
    )
    header_right = Paragraph(
        f'<font color="#64748b">Report {report_id}</font><br/>'
        f'<font color="#64748b">{now}</font>',
        ParagraphStyle("hr", parent=s["body"], alignment=2, fontSize=9, leading=12),
    )
    hdr = Table([[header_left, header_right]], colWidths=[4.6 * inch, 2.6 * inch])
    hdr.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, 0), 1.5, BRAND),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 8),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    els.append(hdr)
    els.append(Spacer(1, 12))

    # ── Title block ─────────────────────────────────────────────────────────
    els.append(Paragraph(project_name, s["title"]))
    if address:
        els.append(Paragraph(address, s["subtitle"]))
    else:
        els.append(Spacer(1, 8))

    # ── Hero measurement tiles ──────────────────────────────────────────────
    total_sqft = float(measurements.get("total_sqft") or 0)
    squares = total_sqft / 100 if total_sqft else 0
    pitch = measurements.get("pitch") or "—"
    waste_pct = measurements.get("waste_pct") or 0
    gross_sqft = total_sqft * (1 + (waste_pct / 100)) if total_sqft else 0

    hero_cards = Table(
        [[
            _hero_card(f"{total_sqft:,.0f}" if total_sqft else "—", "Roof Sqft", s),
            _hero_card(f"{squares:.1f}" if squares else "—", "Squares", s),
            _hero_card(pitch, "Pitch", s),
            _hero_card(f"{waste_pct:.0f}%" if waste_pct else "—", "Waste Factor", s),
        ]],
        colWidths=[1.75 * inch] * 4,
    )
    hero_cards.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    els.append(hero_cards)
    els.append(Spacer(1, 14))

    # ── Confidence banner ───────────────────────────────────────────────────
    conf = measurements.get("confidence")
    if conf is not None:
        label, col = _confidence_bucket(float(conf))
        confirmed = bool(measurements.get("confirmed"))
        badge_text = (
            f'<b>Measurement Confidence:</b> {label}'
            f'{"  ·  <b>Confirmed by contractor</b>" if confirmed else "  ·  <i>AI-generated, awaiting review</i>"}'
        )
        badge = Table([[Paragraph(badge_text, s["body"])]], colWidths=[7.3 * inch])
        badge.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#eff6ff")),
            ("BOX", (0, 0), (-1, -1), 0.75, col),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]))
        els.append(badge)
        els.append(Spacer(1, 14))

    # ── Satellite imagery ───────────────────────────────────────────────────
    sat_url = (aerial or {}).get("satellite_image_url")
    if sat_url:
        img_bytes = _fetch_satellite_image(sat_url)
        if img_bytes:
            try:
                img_io = io.BytesIO(img_bytes)
                img = Image(img_io, width=7.3 * inch, height=3.6 * inch)
                img.hAlign = "CENTER"
                els.append(Paragraph("Aerial Imagery", s["h2"]))
                els.append(img)
                els.append(Paragraph(
                    f"Esri World Imagery · zoom 18 · ~0.6 m/pixel resolution. "
                    f"Source: {(aerial or {}).get('source', 'Aerial imagery provider')}.",
                    s["muted"],
                ))
                els.append(Spacer(1, 10))
            except Exception:
                logger.debug("roof_report: image embed failed", exc_info=True)

    # ── Measurements table ──────────────────────────────────────────────────
    els.append(Paragraph("Roof Geometry", s["h2"]))
    measure_rows = [
        ["Metric", "Value", "Unit"],
        ["Roof area (net)", f"{total_sqft:,.0f}" if total_sqft else "—", "sq ft"],
        ["Roof area (with waste)", f"{gross_sqft:,.0f}" if gross_sqft else "—", "sq ft"],
        ["Roofing squares", f"{squares:.1f}" if squares else "—", "squares (100 sf)"],
        ["Pitch", pitch, ""],
        ["Roof type", str(measurements.get("roof_type") or "—").title(), ""],
        ["Facets", str(measurements.get("facets") or "—"), "planes"],
        ["Stories", str(measurements.get("stories") or "—"), ""],
    ]
    mt = Table(measure_rows, colWidths=[3.0 * inch, 2.4 * inch, 1.9 * inch])
    mt.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BRAND),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 10),
        ("FONTSIZE", (0, 1), (-1, -1), 10),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, SURFACE]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    els.append(mt)
    els.append(Spacer(1, 12))

    # ── Linear measurements ─────────────────────────────────────────────────
    lin_rows = [
        ["Edge", "Linear Feet"],
        ["Ridge lines",  f"{float(measurements.get('ridges_ft')  or 0):,.1f} LF"],
        ["Valley lines", f"{float(measurements.get('valleys_ft') or 0):,.1f} LF"],
        ["Eave edges",   f"{float(measurements.get('eaves_ft')   or 0):,.1f} LF"],
        ["Rake edges",   f"{float(measurements.get('rakes_ft')   or 0):,.1f} LF"],
    ]
    lt = Table(lin_rows, colWidths=[3.65 * inch, 3.65 * inch])
    lt.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BRAND),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, SURFACE]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    els.append(lt)
    els.append(Spacer(1, 12))

    notes = (measurements.get("notes") or "").strip()
    if notes:
        els.append(Paragraph("<b>Inspector notes:</b> " + notes, s["muted"]))
        els.append(Spacer(1, 6))

    # ── Materials list ──────────────────────────────────────────────────────
    if materials:
        els.append(PageBreak())
        els.append(Paragraph("Materials List", s["h2"]))
        els.append(Paragraph(
            "Quantities derived from confirmed measurements above. Prices shown are "
            "regional estimates — use axis-performance live pricing for current retail quotes.",
            s["muted"],
        ))
        els.append(Spacer(1, 8))

        mat_rows = [["Item", "Qty", "Unit", "Unit Cost", "Total"]]
        for m in materials:
            mat_rows.append([
                m.get("item_name", "—"),
                f"{m.get('quantity', 0):,.1f}",
                m.get("unit", ""),
                f"${float(m.get('unit_cost') or 0):,.2f}",
                f"${float(m.get('total_cost') or 0):,.2f}",
            ])
        mat_rows.append(["", "", "", "Materials subtotal",
                         f"${float(total_materials_cost or 0):,.2f}"])
        mat = Table(mat_rows, colWidths=[3.0 * inch, 0.7 * inch, 0.8 * inch, 1.3 * inch, 1.5 * inch])
        mat.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), BRAND),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9.5),
            ("ROWBACKGROUNDS", (0, 1), (-1, -2), [colors.white, SURFACE]),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#dbeafe")),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("LINEABOVE", (0, -1), (-1, -1), 1, BRAND),
            ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        els.append(mat)
        els.append(Spacer(1, 16))

    # ── Methodology & footer ────────────────────────────────────────────────
    els.append(Paragraph("Methodology", s["h2"]))
    els.append(Paragraph(
        "Roof measurements are derived from one or more of: (a) Google Solar API "
        "aerial analysis; (b) property-records research combined with AI vision "
        "review; (c) contractor-confirmed blueprint measurements. Confidence "
        "scoring is honest — low-confidence values are flagged as "
        "&ldquo;unverified&rdquo; and require contractor review before materials "
        "are ordered. BuildAI / axis-performance does not guarantee measurement "
        "accuracy suitable for litigation — for insurance disputes, pair this "
        "report with a physical inspection.",
        s["muted"],
    ))
    els.append(Spacer(1, 8))
    els.append(Paragraph(
        f"Prepared by axis-performance · Generated {now} · Report {report_id}",
        s["muted"],
    ))

    doc.build(els)
    return buf.getvalue()
