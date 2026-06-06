"""
Axis Performance — Exterior Measurement Report PDF.

Hover-style multi-section PDF generated entirely from CONTRACTOR-TRACED
measurements. Section 8 (Methodology) explicitly tells the contractor (and
any insurance adjuster reading the report) what was measured by hand vs.
what would require Phase-2 photogrammetry to automate.

Sections rendered (in order):
    1. Cover                      — address, cover photo, link out to portal
    2. Summary                    — totals: walls, openings, trim, corners
    3. Walls per Elevation        — front/right/rear/left subtotals
    4. Facades Detail             — one row per traced wall measurement
    5. Openings — Windows         — table with group/individual sizes
    6. Openings — Doors           — table with snap-to-standard sizes
    7. Trim & Corners             — linear runs and corner counts
    8. Methodology & Confidence   — honest disclosure of what's measured
                                    vs. what's classified vs. what's TODO
    9. Photos                     — grid of all uploaded photos

What this report does NOT include (intentionally — would be fabrication):
    - Hover-style elevation orthographic sketches with dimension lines
      (require 3D mesh; included once photogrammetry ships)
    - Auto-extracted facade IDs (SI-1..SI-N grouped by AI segmentation)
    - Material brand SKU mapping (Phase 5 of build plan)
"""
from __future__ import annotations

import io
import logging
from datetime import datetime, timezone
from typing import Any, Iterable

import httpx
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

# Reuse brand palette + base styles from the roof report so visual style is
# consistent across all Axis reports.
from app.services.roof_report_pdf import (
    BRAND, BRAND_DARK, ACCENT, MUTED, SURFACE, BORDER, OK, WARN, BAD,
    _styles, _confidence_bucket,
)

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def _fetch_image(url: str | None) -> bytes | None:
    if not url:
        return None
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as c:
            r = c.get(url)
            r.raise_for_status()
            return r.content
    except Exception:
        logger.debug("exterior_report: image fetch failed", exc_info=True)
        return None


def _fmt_sqft(v: float | int | None) -> str:
    return "—" if v is None else f"{float(v):,.1f} ft²"


def _fmt_lf(v: float | int | None) -> str:
    return "—" if v is None else f"{float(v):,.1f} lf"


def _fmt_in(v: float | int | None) -> str:
    return "—" if v is None else f"{float(v):,.1f}\""


def _addr(project: dict) -> str:
    parts = [
        project.get("address"),
        project.get("city"),
        f"{(project.get('state') or '').strip()} {(project.get('zip') or '').strip()}".strip(),
    ]
    text = ", ".join(p for p in parts if p)
    return text or (project.get("name") or "Property")


def _section_header(text: str, n: int, styles: dict) -> Paragraph:
    return Paragraph(
        f"<font color='#1e40af'><b>Section {n}.</b></font> &nbsp; {text}",
        styles["h2"],
    )


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

def _section_1_cover(project: dict, job: dict, photos: list[dict], styles: dict) -> list:
    flow: list = []
    flow.append(Paragraph("Axis Performance — Exterior Measurements", styles["title"]))
    flow.append(Paragraph(_addr(project), styles["subtitle"]))

    # Pick cover: explicit cover_photo_id, then first photo classified as "front", then first photo
    cover_id = job.get("cover_photo_id")
    cover_photo = next((p for p in photos if p.get("id") == cover_id), None) if cover_id else None
    if cover_photo is None:
        cover_photo = next((p for p in photos if p.get("classified_elevation") == "front"), None)
    if cover_photo is None and photos:
        cover_photo = photos[0]

    if cover_photo:
        data = _fetch_image(cover_photo.get("photo_url"))
        if data:
            try:
                flow.append(Image(io.BytesIO(data), width=6.5 * inch, height=4.2 * inch, kind="proportional"))
            except Exception:
                logger.debug("exterior_report: cover image render failed", exc_info=True)

    flow.append(Spacer(1, 14))

    # Quick facts
    facts = [
        ["Job ID", str(job.get("id") or "—")],
        ["Report type", "Complete Measurements" if (job.get("report_type") or "complete") == "complete" else "Roof-Only"],
        ["Status", str(job.get("status") or "—")],
        ["Photos", str(job.get("photo_count") or len(photos))],
        ["Measurements", str(job.get("measurement_count") or 0)],
        ["Generated", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")],
    ]
    t = Table(facts, colWidths=[1.6 * inch, 4.9 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("TEXTCOLOR", (0, 0), (0, -1), MUTED),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, BORDER),
    ]))
    flow.append(t)

    flow.append(Spacer(1, 10))
    flow.append(Paragraph(
        "<i>Every dimension in this report was contractor-traced on a property photo with a "
        "known scale reference. No measurements were estimated by AI or extracted from a 3D "
        "model. See Section 8 for full methodology.</i>",
        styles["muted"],
    ))
    return flow


def _section_2_summary(summary: dict, styles: dict) -> list:
    flow = [_section_header("Summary", 2, styles)]
    walls = summary.get("walls") or {}
    openings = summary.get("openings") or {}
    corners = summary.get("corners") or {}

    rows = [
        ["Category", "Quantity", "Notes"],
        ["Walls — total area", _fmt_sqft(walls.get("total_sqft")),
         f"{walls.get('count', 0)} traced facade region(s)"],
        ["Windows — count", str(openings.get("windows_count", 0)),
         f"total {_fmt_sqft(openings.get('windows_total_sqft'))}"],
        ["Doors — count", str(openings.get("doors_count", 0)),
         f"total {_fmt_sqft(openings.get('doors_total_sqft'))}"],
        ["Openings — united inches (sum)", _fmt_in(openings.get("total_united_inches")),
         "for size grouping reference"],
        ["Trim — linear feet", _fmt_lf(summary.get("trim_lf")),
         "level starter, sloped, vertical"],
        ["Corners — inside", str(corners.get("inside", 0)), ""],
        ["Corners — outside", str(corners.get("outside", 0)), ""],
    ]
    t = Table(rows, colWidths=[2.4 * inch, 1.7 * inch, 2.4 * inch])
    t.setStyle(_table_style())
    flow.append(t)
    return flow


def _section_3_walls_per_elevation(summary: dict, styles: dict) -> list:
    flow = [_section_header("Walls Per Elevation", 3, styles)]
    walls = summary.get("walls") or {}
    by_elev = walls.get("by_elevation") or {}
    by_mat = walls.get("by_material") or {}

    if not by_elev and not by_mat:
        flow.append(Paragraph(
            "No wall measurements yet. Trace at least one wall region on a photo to populate this section.",
            styles["body"],
        ))
        return flow

    if by_elev:
        rows = [["Elevation", "Area (ft²)"]]
        total = 0.0
        for elev in ("front", "right", "rear", "left", "other"):
            v = float(by_elev.get(elev, 0) or 0)
            if v <= 0:
                continue
            rows.append([elev.title(), f"{v:,.1f}"])
            total += v
        rows.append(["Total", f"{total:,.1f}"])
        t = Table(rows, colWidths=[3.0 * inch, 3.5 * inch])
        style = _table_style()
        style.add("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold")
        style.add("BACKGROUND", (0, -1), (-1, -1), SURFACE)
        style.add("LINEABOVE", (0, -1), (-1, -1), 1.0, BRAND_DARK)
        t.setStyle(style)
        flow.append(t)
        flow.append(Spacer(1, 10))

    if by_mat:
        flow.append(Paragraph("Walls by material", styles["body"]))
        rows = [["Material", "Area (ft²)"]]
        total = 0.0
        for mat, v in sorted(by_mat.items(), key=lambda kv: -kv[1]):
            rows.append([mat.replace("_", " ").title(), f"{float(v):,.1f}"])
            total += float(v)
        rows.append(["Total", f"{total:,.1f}"])
        t = Table(rows, colWidths=[3.0 * inch, 3.5 * inch])
        style = _table_style(header_color=ACCENT)
        style.add("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold")
        style.add("BACKGROUND", (0, -1), (-1, -1), SURFACE)
        style.add("LINEABOVE", (0, -1), (-1, -1), 1.0, BRAND_DARK)
        t.setStyle(style)
        flow.append(t)
    return flow


def _section_4_facades_detail(measurements: list[dict], styles: dict) -> list:
    flow = [_section_header("Facades Detail", 4, styles)]
    walls = [m for m in measurements if m.get("measurement_type") == "wall"]
    if not walls:
        flow.append(Paragraph(
            "No wall facades traced. Walls appear here once they're added in the Exterior module.",
            styles["body"],
        ))
        return flow

    rows = [["Facade ID", "Elevation", "Material", "Area (ft²)", "Scale ref"]]
    total = 0.0
    for w in walls:
        area = float(w.get("area_sqft") or 0)
        total += area
        rows.append([
            (w.get("facade_id") or f"SI-{walls.index(w) + 1}"),
            (w.get("elevation") or "—").title(),
            (w.get("material_type") or "—").replace("_", " ").title(),
            f"{area:,.1f}",
            (w.get("reference_object") or "—").replace("_", " "),
        ])
    rows.append(["", "", "Total", f"{total:,.1f}", ""])
    t = Table(rows, colWidths=[1.2 * inch, 1.0 * inch, 1.4 * inch, 1.3 * inch, 1.6 * inch])
    style = _table_style()
    style.add("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold")
    style.add("BACKGROUND", (0, -1), (-1, -1), SURFACE)
    style.add("LINEABOVE", (0, -1), (-1, -1), 1.0, BRAND_DARK)
    t.setStyle(style)
    flow.append(t)

    flow.append(Spacer(1, 6))
    flow.append(Paragraph(
        "Each facade was traced as a polygon on a property photo with a scale reference; "
        "area = pixel area × (inches/pixel)² ÷ 144.",
        styles["muted"],
    ))
    return flow


def _openings_grouped_table(items: list[dict], type_: str, styles: dict) -> Table:
    """Build a Hover-style grouped table. type_ is 'window' or 'door'."""
    rows = [["ID", "Width × Height (in)", "United Inches", "Area (ft²)"]]
    total_ui = 0.0
    total_area = 0.0
    # Group by (width, height) snapped to nearest integer for stable IDs
    groups: dict[tuple[int, int], list[dict]] = {}
    for it in items:
        w = int(round(float(it.get("width_in") or 0)))
        h = int(round(float(it.get("height_in") or 0)))
        groups.setdefault((w, h), []).append(it)

    group_idx = 0
    for (w, h), members in sorted(groups.items(), key=lambda kv: (-kv[0][0] * kv[0][1])):
        group_idx += 1
        ui = (w + h) * len(members)
        area = sum(float(m.get("area_sqft") or 0) for m in members)
        prefix = "WG" if type_ == "window" else "DG"
        rows.append([
            f"{prefix}-{group_idx} ({len(members)})",
            f"{w} × {h}",
            f"{w + h} ea.",
            f"{area:,.2f}",
        ])
        for j, m in enumerate(members, 1):
            wid = int(round(float(m.get("width_in") or 0)))
            hid = int(round(float(m.get("height_in") or 0)))
            mw = m.get("facade_id") or f"{prefix[0]}-{group_idx:02d}{j:02d}"
            rows.append([
                f"  {mw}",
                f"{wid} × {hid}",
                f"{wid + hid}",
                f"{float(m.get('area_sqft') or 0):,.2f}",
            ])
        total_ui += ui
        total_area += area

    rows.append(["Total", "", f"{total_ui:,.1f}", f"{total_area:,.2f}"])
    t = Table(rows, colWidths=[1.6 * inch, 1.7 * inch, 1.4 * inch, 1.4 * inch])
    style = _table_style(header_color=ACCENT)
    style.add("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold")
    style.add("BACKGROUND", (0, -1), (-1, -1), SURFACE)
    style.add("LINEABOVE", (0, -1), (-1, -1), 1.0, BRAND_DARK)
    t.setStyle(style)
    return t


def _section_5_openings_windows(measurements: list[dict], styles: dict) -> list:
    flow = [_section_header("Openings — Windows", 5, styles)]
    windows = [m for m in measurements if m.get("measurement_type") == "window"]
    if not windows:
        flow.append(Paragraph(
            "No windows traced. Trace a window opening (top-left → bottom-right corners) on any photo "
            "to populate this table.", styles["body"],
        ))
        return flow
    flow.append(_openings_grouped_table(windows, "window", styles))
    flow.append(Spacer(1, 6))
    flow.append(Paragraph(
        "Windows are grouped by snapped size; individual openings are listed under their group. "
        "Dimensions are contractor-traced and have NOT been snapped to standard window sizes.",
        styles["muted"],
    ))
    return flow


def _section_6_openings_doors(measurements: list[dict], styles: dict) -> list:
    flow = [_section_header("Openings — Doors", 6, styles)]
    doors = [m for m in measurements if m.get("measurement_type") == "door"]
    if not doors:
        flow.append(Paragraph(
            "No doors traced.", styles["body"],
        ))
        return flow

    rows = [["ID", "Width × Height (in)", "Area (ft²)", "Snapped?"]]
    total_area = 0.0
    for i, d in enumerate(doors, 1):
        w = int(round(float(d.get("width_in") or 0)))
        h = int(round(float(d.get("height_in") or 0)))
        area = float(d.get("area_sqft") or 0)
        total_area += area
        rows.append([
            d.get("facade_id") or f"D-{i}",
            f"{w} × {h}",
            f"{area:,.2f}",
            "Yes" if d.get("snapped_to_standard") else "No",
        ])
    rows.append(["", "Total", f"{total_area:,.2f}", ""])
    t = Table(rows, colWidths=[1.4 * inch, 2.0 * inch, 1.4 * inch, 1.6 * inch])
    style = _table_style(header_color=ACCENT)
    style.add("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold")
    style.add("BACKGROUND", (0, -1), (-1, -1), SURFACE)
    style.add("LINEABOVE", (0, -1), (-1, -1), 1.0, BRAND_DARK)
    t.setStyle(style)
    flow.append(t)
    return flow


def _section_7_trim_corners(measurements: list[dict], summary: dict, styles: dict) -> list:
    flow = [_section_header("Trim & Corners", 7, styles)]
    trim = [m for m in measurements if m.get("measurement_type") == "trim"]
    corners = summary.get("corners") or {}

    if trim:
        flow.append(Paragraph("Trim runs", styles["body"]))
        rows = [["ID", "Elevation", "Length (lf)", "Material"]]
        total = 0.0
        for i, m in enumerate(trim, 1):
            lf = float(m.get("length_ft") or 0)
            total += lf
            rows.append([
                m.get("facade_id") or f"T-{i}",
                (m.get("elevation") or "—").title(),
                f"{lf:,.1f}",
                (m.get("material_type") or "—").replace("_", " ").title(),
            ])
        rows.append(["", "Total", f"{total:,.1f}", ""])
        t = Table(rows, colWidths=[1.2 * inch, 1.5 * inch, 1.5 * inch, 2.0 * inch])
        style = _table_style(header_color=ACCENT)
        style.add("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold")
        style.add("BACKGROUND", (0, -1), (-1, -1), SURFACE)
        style.add("LINEABOVE", (0, -1), (-1, -1), 1.0, BRAND_DARK)
        t.setStyle(style)
        flow.append(t)
        flow.append(Spacer(1, 8))
    else:
        flow.append(Paragraph("No trim runs traced.", styles["body"]))
        flow.append(Spacer(1, 4))

    rows = [["Corner type", "Count"]]
    rows.append(["Inside corners", str(corners.get("inside", 0))])
    rows.append(["Outside corners", str(corners.get("outside", 0))])
    t = Table(rows, colWidths=[3.5 * inch, 2.5 * inch])
    t.setStyle(_table_style())
    flow.append(t)
    return flow


def _section_8_methodology(job: dict, photos: list[dict], styles: dict) -> list:
    flow = [_section_header("Methodology & Confidence", 8, styles)]

    # Photo coverage table
    coverage_counts = {"front": 0, "right": 0, "rear": 0, "left": 0, "other": 0}
    quality_counts = {"clear": 0, "acceptable": 0, "poor": 0}
    for p in photos:
        elev = (p.get("classified_elevation") or "unknown").lower()
        if elev in coverage_counts:
            coverage_counts[elev] += 1
        else:
            coverage_counts["other"] += 1
        obs = p.get("vision_observations") or {}
        q = (obs.get("photo_quality") or "acceptable").lower()
        if q in quality_counts:
            quality_counts[q] += 1

    rows = [["Coverage", "Photos"]]
    for face in ("front", "right", "rear", "left", "other"):
        rows.append([face.title(), str(coverage_counts[face])])
    t = Table(rows, colWidths=[3.0 * inch, 2.0 * inch])
    t.setStyle(_table_style())
    flow.append(t)
    flow.append(Spacer(1, 8))

    rows = [["Photo quality (Gemini-classified)", "Photos"]]
    for q in ("clear", "acceptable", "poor"):
        rows.append([q.title(), str(quality_counts[q])])
    t = Table(rows, colWidths=[3.0 * inch, 2.0 * inch])
    t.setStyle(_table_style(header_color=ACCENT))
    flow.append(t)
    flow.append(Spacer(1, 10))

    flow.append(Paragraph("<b>What this report measures and how</b>", styles["body"]))
    flow.append(Paragraph(
        "Every dimension shown was traced by the contractor on a property photo using a known "
        "scale reference (standard 80\" door, 84\" garage door, 36\" window, or custom). Areas "
        "are computed as pixel-area × (inches/pixel)² ÷ 144. Linear lengths are computed as "
        "pixel-length × inches/pixel ÷ 12. Width × height for openings is computed from the "
        "bounding box of the contractor's traced rectangle.",
        styles["body"],
    ))
    flow.append(Spacer(1, 6))
    flow.append(Paragraph("<b>What this report does NOT measure (intentionally)</b>", styles["body"]))
    flow.append(Paragraph(
        "• Photogrammetry-derived dimensions (would require the SfM/MVS pipeline; status: "
        "<i>" + (str(job.get("status") or "manual-only")) + "</i>)<br/>"
        "• Auto-segmented facade IDs (SI-1..SI-N grouped by AI). Contractor-assigned facade "
        "IDs appear in Sections 4–7.<br/>"
        "• Hover-style orthographic elevation sketches with full dimension lines (require "
        "the 3D mesh, not yet available).<br/>"
        "• Material brand SKU mapping (manufacturer catalog integration is Phase 5).",
        styles["body"],
    ))
    flow.append(Spacer(1, 6))
    flow.append(Paragraph(
        "Photos are classified by Gemini Vision for organization (elevation tag, qualitative "
        "observations of siding material, openings visible, photo quality). Classification "
        "labels can be overridden by the contractor; observations are never used to derive "
        "dimensions.",
        styles["muted"],
    ))
    return flow


def _section_9_photos(photos: list[dict], styles: dict) -> list:
    flow = [_section_header("Photos", 9, styles)]
    if not photos:
        flow.append(Paragraph("No photos uploaded.", styles["body"]))
        return flow

    # Grid of 2 photos per row, ~3 in wide each
    rows: list[list[Any]] = []
    pair: list[Any] = []
    for p in photos:
        data = _fetch_image(p.get("photo_url"))
        if not data:
            pair.append(Paragraph(
                f"(image unavailable: {p.get('original_filename') or p.get('id')})", styles["muted"],
            ))
        else:
            try:
                pair.append(Image(io.BytesIO(data), width=3.1 * inch, height=2.3 * inch, kind="proportional"))
            except Exception:
                pair.append(Paragraph(f"(image render failed)", styles["muted"]))
        if len(pair) == 2:
            rows.append(pair)
            pair = []
    if pair:
        pair.append("")    # pad
        rows.append(pair)

    if not rows:
        flow.append(Paragraph("Photos could not be embedded.", styles["body"]))
        return flow

    t = Table(rows, colWidths=[3.25 * inch, 3.25 * inch])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    flow.append(t)
    return flow


# ----------------------------------------------------------------------------
# Public entry
# ----------------------------------------------------------------------------

def generate_exterior_report(
    project: dict,
    job: dict,
    photos: list[dict],
    measurements: list[dict],
    summary: dict,
) -> bytes:
    """Render the 9-section exterior PDF and return bytes."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        topMargin=0.6 * inch, bottomMargin=0.6 * inch,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        title="Axis Performance — Exterior Measurements",
        author="Axis Performance",
    )
    styles = _styles()

    story: list = []
    story.extend(_section_1_cover(project, job, photos, styles))
    story.append(PageBreak())
    story.extend(_section_2_summary(summary, styles))
    story.append(Spacer(1, 10))
    story.extend(_section_3_walls_per_elevation(summary, styles))
    story.append(PageBreak())
    story.extend(_section_4_facades_detail(measurements, styles))
    story.append(PageBreak())
    story.extend(_section_5_openings_windows(measurements, styles))
    story.append(Spacer(1, 10))
    story.extend(_section_6_openings_doors(measurements, styles))
    story.append(PageBreak())
    story.extend(_section_7_trim_corners(measurements, summary, styles))
    story.append(PageBreak())
    story.extend(_section_8_methodology(job, photos, styles))
    story.append(PageBreak())
    story.extend(_section_9_photos(photos, styles))

    doc.build(story)
    return buf.getvalue()
