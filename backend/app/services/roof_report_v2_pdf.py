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
    styles: dict,
) -> list:
    """Executive Summary — top of the report."""
    flow: list = []
    addr_parts = [project.get("address"), project.get("city"),
                  f"{(project.get('state') or '').strip()} {(project.get('zip') or '').strip()}".strip()]
    full_address = ", ".join(p for p in addr_parts if p)
    if not full_address:
        full_address = project.get("name") or "Property"

    flow.append(Paragraph("Axis Performance — Roof Report", styles["title"]))
    flow.append(Paragraph(full_address, styles["subtitle"]))

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
                flow.append(Image(io.BytesIO(data), width=6.5 * inch, height=4.0 * inch))
                provider = (run.get("satellite_provider") or "satellite").lower()
                flow.append(Paragraph(
                    f"Source: {provider} imagery (Web Mercator, zoom {run.get('satellite_zoom') or '—'})",
                    styles["muted"],
                ))
            except Exception:
                logger.debug("v2 report: image render failed", exc_info=True)
    return flow


def _section_2_roof_summary(aggregates: dict, facets: list[dict], styles: dict) -> list:
    flow = [_section_header("Roof Summary", 2, styles)]
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


def _section_6_materials(
    material_lines: list[MaterialLine], default_waste: int, styles: dict,
) -> list:
    flow = [_section_header("Material Ordering Summary", 6, styles)]
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
    flow = [_section_header("Exterior Measurements", 7, styles)]
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


def _section_8_methodology(run: dict, aggregates: dict, styles: dict) -> list:
    flow = [_section_header("Methodology & Confidence", 8, styles)]

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

    flow.append(Spacer(1, 8))
    flow.append(Paragraph(
        "Axis Performance — generated %s" % datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        styles["muted"],
    ))
    return flow


# ----------------------------------------------------------------------------
# Public entry
# ----------------------------------------------------------------------------

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
) -> bytes:
    """Render the full 8-section PDF and return bytes."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        topMargin=0.6 * inch, bottomMargin=0.6 * inch,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        title="Axis Performance Roof Report",
        author="Axis Performance",
    )
    styles = _styles()
    default_waste = int(run.get("waste_pct_default") or aggregates.get("waste_pct_default") or 12)

    story: list = []
    story.extend(_section_1_executive(project, run, aggregates, len(facets), styles))
    story.append(Spacer(1, 12))
    story.extend(_section_2_roof_summary(aggregates, facets, styles))
    story.append(PageBreak())
    story.extend(_section_3_roof_lines(aggregates, edges, styles))
    story.append(Spacer(1, 10))
    story.extend(_section_4_flashing(aggregates, material_lines, styles, flashing))
    story.append(PageBreak())
    story.extend(_section_5_penetrations(penetrations, styles))
    story.append(Spacer(1, 10))
    story.extend(_section_6_materials(material_lines, default_waste, styles))
    story.append(PageBreak())
    story.extend(_section_7_exterior(siding_measurements, styles))
    story.append(Spacer(1, 10))
    story.extend(_section_8_methodology(run, aggregates, styles))

    doc.build(story)
    return buf.getvalue()
