"""
Per-photo damage report — EagleView-style one page per tagged photo.

Iterates project photos that have `auto_tags` with a non-empty damage or
safety list (or any photo if the caller opts in) and lays out each on its
own page: hero image, metadata (timestamp, GPS, phase), the AI-written
summary, damage callouts, safety notes, user notes, and manual tags.

This is insurance-submittable documentation contractors can hand to an
adjuster without re-photographing or re-typing.
"""
from __future__ import annotations

import io
import logging
from datetime import datetime
from typing import Any, Optional

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

BRAND_DARK = colors.HexColor("#0f2a6b")
BRAND = colors.HexColor("#1e40af")
MUTED = colors.HexColor("#64748b")
SURFACE = colors.HexColor("#f1f5f9")
BORDER = colors.HexColor("#e2e8f0")
WARN = colors.HexColor("#f59e0b")
BAD = colors.HexColor("#ef4444")
SAFE = colors.HexColor("#22c55e")


def _fetch(url: str) -> Optional[bytes]:
    if not url:
        return None
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            r = client.get(url)
            r.raise_for_status()
            return r.content
    except Exception:
        logger.debug("damage_report: image fetch failed for %s", url, exc_info=True)
        return None


def _fmt_timestamp(iso: Optional[str]) -> str:
    if not iso:
        return "—"
    try:
        s = iso.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt.strftime("%b %d %Y  %I:%M %p")
    except Exception:
        return iso


def _styles() -> dict:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "Title", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=22, leading=26, textColor=BRAND_DARK, spaceAfter=4,
        ),
        "subtitle": ParagraphStyle(
            "Subtitle", parent=base["Normal"], fontName="Helvetica",
            fontSize=11, leading=14, textColor=MUTED, spaceAfter=12,
        ),
        "h2": ParagraphStyle(
            "H2", parent=base["Heading2"], fontName="Helvetica-Bold",
            fontSize=13, leading=17, textColor=BRAND_DARK,
            spaceBefore=6, spaceAfter=6,
        ),
        "label": ParagraphStyle(
            "Label", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=8, leading=10, textColor=MUTED,
        ),
        "body": ParagraphStyle(
            "Body", parent=base["Normal"], fontName="Helvetica",
            fontSize=10, leading=13, textColor=colors.HexColor("#0f172a"),
        ),
        "summary": ParagraphStyle(
            "Summary", parent=base["Normal"], fontName="Helvetica-Oblique",
            fontSize=11, leading=15, textColor=BRAND_DARK, spaceAfter=8,
        ),
        "damage": ParagraphStyle(
            "Damage", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=10, leading=13, textColor=BAD,
        ),
        "caption": ParagraphStyle(
            "Caption", parent=base["Normal"], fontName="Helvetica",
            fontSize=9, leading=11, textColor=MUTED,
        ),
    }


def _hero_image(image_bytes: bytes, max_width: float, max_height: float) -> Image:
    img = Image(io.BytesIO(image_bytes))
    iw, ih = img.imageWidth, img.imageHeight
    scale = min(max_width / iw, max_height / ih, 1.0)
    img.drawWidth = iw * scale
    img.drawHeight = ih * scale
    return img


def _meta_table(photo: dict, styles: dict) -> Table:
    lat, lng = photo.get("latitude"), photo.get("longitude")
    geo = f"{lat:.5f}, {lng:.5f}" if isinstance(lat, (int, float)) and isinstance(lng, (int, float)) else "—"
    captured = _fmt_timestamp(photo.get("captured_at") or photo.get("created_at"))
    phase = (photo.get("phase") or "").title() or "—"
    filename = photo.get("filename") or "—"

    rows = [
        [Paragraph("CAPTURED", styles["label"]), Paragraph(captured, styles["body"])],
        [Paragraph("PHASE", styles["label"]),    Paragraph(phase, styles["body"])],
        [Paragraph("LOCATION", styles["label"]), Paragraph(geo, styles["body"])],
        [Paragraph("FILE", styles["label"]),     Paragraph(filename, styles["caption"])],
    ]
    t = Table(rows, colWidths=[1.0 * inch, 5.2 * inch])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("LINEBELOW", (0, 0), (-1, -2), 0.25, BORDER),
    ]))
    return t


def _tag_paragraphs(auto_tags: dict, styles: dict) -> list:
    """Render the auto_tag dict into a stack of Paragraphs for the flow."""
    out: list = []
    summary = (auto_tags or {}).get("summary")
    if summary:
        out.append(Paragraph(f"&ldquo;{summary}&rdquo;", styles["summary"]))

    area = (auto_tags or {}).get("area")
    phase_guess = (auto_tags or {}).get("phase")
    meta_bits = []
    if area:
        meta_bits.append(f"<b>Area:</b> {area}")
    if phase_guess:
        meta_bits.append(f"<b>Phase:</b> {phase_guess}")
    materials = (auto_tags or {}).get("materials") or []
    if materials:
        meta_bits.append("<b>Materials:</b> " + ", ".join(materials))
    if meta_bits:
        out.append(Paragraph(" &nbsp;·&nbsp; ".join(meta_bits), styles["body"]))
        out.append(Spacer(1, 6))

    damage = (auto_tags or {}).get("damage") or []
    if damage:
        out.append(Paragraph("Damage observed", styles["h2"]))
        for d in damage:
            out.append(Paragraph(f"&#9888; {d}", styles["damage"]))
        out.append(Spacer(1, 4))

    safety = (auto_tags or {}).get("safety") or []
    if safety:
        out.append(Paragraph("Safety / site notes", styles["h2"]))
        for s in safety:
            out.append(Paragraph(f"&#128737; {s}", styles["body"]))

    conf = (auto_tags or {}).get("confidence")
    if isinstance(conf, (int, float)) and conf > 0:
        out.append(Spacer(1, 4))
        out.append(Paragraph(f"AI confidence: {int(conf * 100)}%", styles["caption"]))
    return out


def _cover_page(project: dict, photo_count: int, damage_count: int, styles: dict) -> list:
    project_name = project.get("name") or "Project"
    addr_bits = [project.get("address"), project.get("city"), project.get("state")]
    addr = ", ".join([b for b in addr_bits if b]) or "—"
    now = datetime.now().strftime("%B %d, %Y")

    elems: list = [
        Paragraph("DAMAGE DOCUMENTATION REPORT", styles["label"]),
        Paragraph(project_name, styles["title"]),
        Paragraph(f"{addr} &nbsp;·&nbsp; generated {now}", styles["subtitle"]),
        Spacer(1, 12),
    ]

    summary_rows = [
        [Paragraph("PHOTOS IN REPORT", styles["label"]), Paragraph(str(photo_count), styles["body"])],
        [Paragraph("DAMAGE CALLOUTS", styles["label"]), Paragraph(str(damage_count), styles["body"])],
    ]
    t = Table(summary_rows, colWidths=[1.8 * inch, 4.4 * inch])
    t.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, BORDER),
        ("BACKGROUND", (0, 0), (0, -1), SURFACE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    elems.append(t)

    elems.append(Spacer(1, 16))
    elems.append(Paragraph(
        "<i>This document compiles field photos with AI-generated damage observations. "
        "All AI tags should be verified by a qualified inspector before any insurance claim is submitted. "
        "Measurements and damage assessments are advisory only.</i>",
        styles["caption"],
    ))
    return elems


def generate_damage_report_pdf(project: dict, photos: list[dict], *, include_all: bool = False) -> bytes:
    """Build a multi-page PDF. Each page is one photo with its damage callouts.

    Args:
        project: dict with at least name/address/city/state.
        photos:  list of project_photos rows (with auto_tags, url, captured_at…).
        include_all: if True, include every photo; otherwise only those with at
            least one damage entry in auto_tags.
    """
    styles = _styles()

    # Filter to photos that should be in the report.
    selected: list[dict] = []
    for p in photos:
        auto = p.get("auto_tags") or {}
        damage = auto.get("damage") or []
        if include_all or damage:
            selected.append(p)

    damage_count = sum(len((p.get("auto_tags") or {}).get("damage") or []) for p in selected)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        topMargin=0.6 * inch, bottomMargin=0.6 * inch,
        title=f"{project.get('name', 'Project')} — Damage Report",
        author="axis-performance",
    )

    flow: list = []
    flow.extend(_cover_page(project, len(selected), damage_count, styles))

    if not selected:
        flow.append(Spacer(1, 24))
        flow.append(Paragraph(
            "No damage has been AI-tagged yet. Open each photo in the app and run "
            "&ldquo;Auto-tag with AI&rdquo;, or enable <b>Include all photos</b> when generating this report.",
            styles["body"],
        ))
        doc.build(flow)
        return buf.getvalue()

    for i, p in enumerate(selected):
        flow.append(PageBreak())
        flow.append(Paragraph(f"PHOTO {i + 1} OF {len(selected)}", styles["label"]))
        flow.append(Spacer(1, 4))
        flow.append(_meta_table(p, styles))
        flow.append(Spacer(1, 10))

        url = p.get("url")
        image_bytes = _fetch(url) if url else None
        if image_bytes:
            try:
                flow.append(_hero_image(image_bytes, 6.8 * inch, 4.2 * inch))
            except Exception:
                logger.debug("damage_report: failed to render image for %s", url, exc_info=True)
                flow.append(Paragraph("<i>[image unavailable]</i>", styles["caption"]))
        else:
            flow.append(Paragraph("<i>[image unavailable]</i>", styles["caption"]))

        flow.append(Spacer(1, 10))

        auto_tags = p.get("auto_tags") or {}
        if auto_tags:
            flow.extend(_tag_paragraphs(auto_tags, styles))
        else:
            flow.append(Paragraph(
                "<i>No AI auto-tags for this photo. Run &ldquo;Auto-tag with AI&rdquo; in the app to populate damage notes.</i>",
                styles["caption"],
            ))

        notes = p.get("notes")
        if notes:
            flow.append(Spacer(1, 8))
            flow.append(Paragraph("Contractor notes", styles["h2"]))
            flow.append(Paragraph(notes.replace("\n", "<br/>"), styles["body"]))

        manual_tags = p.get("tags") or []
        if manual_tags:
            flow.append(Spacer(1, 6))
            flow.append(Paragraph(
                "<b>Tags:</b> " + ", ".join(manual_tags),
                styles["caption"],
            ))

    doc.build(flow)
    return buf.getvalue()
