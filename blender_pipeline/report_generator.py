from __future__ import annotations
"""
report_generator.py — AXIS PERFORMANCE Module 10
=================================================
Generates a 12-page professional PDF report using ReportLab.

Pages:
  1  Cover — hero render + project title overlay
  2  Executive Summary — metric cards + AI project summary
  3  Render Gallery — 4 renders in 2×2 grid
  4  Aerial + Street Level renders full-width
  5  Cost Breakdown — phase donut + scenario table
  6  Bill of Quantities — Phase 1 & 2
  7  Bill of Quantities — Phase 3 & 4
  8  Bill of Quantities — Phase 5, 6, 7 + grand total
  9  Construction Schedule — Gantt + milestones
  10 Material Specifications — roofing, walls, openings
  11 AI Insights — cost + schedule + quality checklist
  12 Terms & Notes — assumptions, exclusions, validity, signature

Runs outside Blender as a standard Python module.
"""

import json
import math
import os
from datetime import date

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    Image,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.flowables import KeepTogether


# ── Brand colors ──────────────────────────────────────────────────────────────
NAVY       = colors.HexColor("#0F1B2D")
BLUE       = colors.HexColor("#2D7DD2")
LIGHT_GRAY = colors.HexColor("#F5F5F5")
MID_GRAY   = colors.HexColor("#CCCCCC")
DARK_GRAY  = colors.HexColor("#4A4A4A")
WHITE      = colors.white

PAGE_W, PAGE_H = letter
MARGIN = 0.75 * inch


# ── Helper: money formatter ───────────────────────────────────────────────────
def _money(v: float) -> str:
    return f"${v:,.0f}"


def _pct(v: float) -> str:
    return f"{v:.1f}%"


# ── Page header / footer ──────────────────────────────────────────────────────
def _page_decor(canvas, doc):
    canvas.saveState()
    w, h = letter

    # Header bar
    canvas.setFillColor(NAVY)
    canvas.rect(0, h - 0.45 * inch, w, 0.45 * inch, fill=1, stroke=0)
    canvas.setFillColor(WHITE)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(MARGIN, h - 0.3 * inch, "AXIS PERFORMANCE")
    canvas.setFont("Helvetica", 8)
    canvas.drawRightString(w - MARGIN, h - 0.3 * inch,
                           f"Page {doc.page} of {doc._pageCount if hasattr(doc, '_pageCount') else '—'}")

    # Footer line
    canvas.setStrokeColor(BLUE)
    canvas.setLineWidth(1.5)
    canvas.line(MARGIN, 0.45 * inch, w - MARGIN, 0.45 * inch)
    canvas.setFillColor(DARK_GRAY)
    canvas.setFont("Helvetica", 7)
    canvas.drawCentredString(w / 2, 0.28 * inch, "AXIS PERFORMANCE  |  Confidential")

    canvas.restoreState()


# ── Style helpers ─────────────────────────────────────────────────────────────
def _styles():
    base = getSampleStyleSheet()
    styles = {}

    styles["h1"] = ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=22,
                                   textColor=NAVY, spaceAfter=6)
    styles["h2"] = ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=14,
                                   textColor=NAVY, spaceAfter=4)
    styles["h3"] = ParagraphStyle("h3", fontName="Helvetica-Bold", fontSize=11,
                                   textColor=BLUE, spaceAfter=3)
    styles["body"] = ParagraphStyle("body", fontName="Helvetica", fontSize=9,
                                     textColor=DARK_GRAY, leading=13, spaceAfter=4)
    styles["small"] = ParagraphStyle("small", fontName="Helvetica", fontSize=7.5,
                                      textColor=DARK_GRAY, leading=11)
    styles["label"] = ParagraphStyle("label", fontName="Helvetica-Bold", fontSize=8,
                                      textColor=NAVY)
    styles["metric_val"] = ParagraphStyle("metric_val", fontName="Helvetica-Bold",
                                           fontSize=18, textColor=BLUE)
    styles["metric_lbl"] = ParagraphStyle("metric_lbl", fontName="Helvetica", fontSize=8,
                                           textColor=DARK_GRAY)

    return styles


def _table_style(header_bg=NAVY, stripe=LIGHT_GRAY):
    return TableStyle([
        ("BACKGROUND",  (0, 0), (-1, 0),  header_bg),
        ("TEXTCOLOR",   (0, 0), (-1, 0),  WHITE),
        ("FONTNAME",    (0, 0), (-1, 0),  "Helvetica-Bold"),
        ("FONTSIZE",    (0, 0), (-1, 0),  8),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
        ("TOPPADDING",  (0, 0), (-1, 0),  5),
        ("FONTNAME",    (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE",    (0, 1), (-1, -1), 8),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, stripe]),
        ("GRID",        (0, 0), (-1, -1), 0.4, MID_GRAY),
        ("VALIGN",      (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING",  (0, 1), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 3),
    ])


# ── Section helpers ───────────────────────────────────────────────────────────
def _section(title: str, st: dict) -> list:
    return [
        Spacer(1, 0.15 * inch),
        Paragraph(title, st["h2"]),
        HRFlowable(width="100%", thickness=1.5, color=BLUE, spaceAfter=6),
    ]


def _metric_card(label: str, value: str, sub: str, st: dict) -> Table:
    data = [
        [Paragraph(value, st["metric_val"])],
        [Paragraph(label, st["label"])],
        [Paragraph(sub, st["small"])],
    ]
    t = Table(data, colWidths=[1.4 * inch])
    t.setStyle(TableStyle([
        ("BOX",        (0, 0), (-1, -1), 0.5, BLUE),
        ("BACKGROUND", (0, 0), (-1, -1), LIGHT_GRAY),
        ("ALIGN",      (0, 0), (-1, -1), "CENTER"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return t


def _render_img(path: str, max_w: float, max_h: float) -> Image | None:
    if path and os.path.exists(path):
        try:
            img = Image(path)
            w, h = img.drawWidth, img.drawHeight
            scale = min(max_w / w, max_h / h, 1.0)
            img.drawWidth  = w * scale
            img.drawHeight = h * scale
            return img
        except Exception:
            pass
    return None


# ── Phase items formatter ─────────────────────────────────────────────────────
def _phase_table(phase_data: dict, st: dict, title: str) -> list:
    items  = phase_data.get("items", [])
    ph_mat = phase_data.get("material", 0)
    ph_lab = phase_data.get("labor", 0)
    ph_tot = phase_data.get("total", 0)

    rows = [["Item", "Qty", "Unit", "Unit Mat.", "Unit Lab.", "Material", "Labor", "Total"]]
    for item in items:
        rows.append([
            item.get("key", "").replace("_", " ").title(),
            f"{item.get('qty', 0):,.1f}",
            item.get("unit", ""),
            f"${item.get('unit_mat', 0):.2f}",
            f"${item.get('unit_lab', 0):.2f}",
            _money(item.get("material", 0)),
            _money(item.get("labor", 0)),
            _money(item.get("total", 0)),
        ])
    rows.append(["", "", "", "", "Phase Total →",
                 _money(ph_mat), _money(ph_lab), _money(ph_tot)])

    col_w = [1.7*inch, 0.55*inch, 0.45*inch, 0.65*inch,
             0.65*inch, 0.75*inch, 0.75*inch, 0.75*inch]
    tbl = Table(rows, colWidths=col_w)
    style = _table_style()
    style.add("FONTNAME", (0, len(rows)-1), (-1, len(rows)-1), "Helvetica-Bold")
    style.add("BACKGROUND", (0, len(rows)-1), (-1, len(rows)-1), colors.HexColor("#E8EFF7"))
    tbl.setStyle(style)

    return [Paragraph(title, st["h3"]), tbl, Spacer(1, 0.1*inch)]


# ── Main builder ──────────────────────────────────────────────────────────────
def generate_report(
    quantities:   dict,
    cost_report:  dict,
    schedule:     dict,
    insights:     dict,
    output_dir:   str,
    project_name: str = "Project",
    render_dir:   str | None = None,
) -> str:
    """
    Build the PDF and return the output file path.
    """
    st = _styles()

    if render_dir is None:
        render_dir = os.path.join(output_dir, "renders")

    reports_dir = os.path.join(output_dir, "reports")
    os.makedirs(reports_dir, exist_ok=True)
    today_str  = date.today().strftime("%Y%m%d")
    pdf_path   = os.path.join(reports_dir, f"{project_name.replace(' ','_')}_Report_{today_str}.pdf")

    render_paths = {
        "hero":      os.path.join(render_dir, "exterior_hero.png"),
        "aerial":    os.path.join(render_dir, "aerial_45.png"),
        "street":    os.path.join(render_dir, "street_level.png"),
        "interior":  os.path.join(render_dir, "interior_walkthrough.png"),
    }

    meta     = quantities.get("meta", {})
    cost_sum = cost_report.get("summary", {})
    cr_std   = cost_report.get("standard", {})
    cr_eco   = cost_report.get("economy",  {})
    cr_prm   = cost_report.get("premium",  {})

    area_sqft  = meta.get("area_sqft", 0)
    cal_days   = schedule.get("total_calendar_days", 0)

    # ── Doc setup ─────────────────────────────────────────────────────────────
    content_w = PAGE_W - 2 * MARGIN
    content_h = PAGE_H - 2 * MARGIN - 0.5 * inch   # header + footer

    doc = BaseDocTemplate(
        pdf_path,
        pagesize=letter,
        topMargin=0.55 * inch,
        bottomMargin=0.55 * inch,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
    )

    frame = Frame(MARGIN, 0.55 * inch, content_w, PAGE_H - 1.1 * inch, id="main")
    doc.addPageTemplates([PageTemplate(id="main", frames=frame, onPage=_page_decor)])

    story = []

    # ═══════════════════════════════════════════════════════════════════════════
    # PAGE 1 — COVER
    # ═══════════════════════════════════════════════════════════════════════════
    hero = _render_img(render_paths["hero"], content_w, 4.5 * inch)
    if hero:
        story.append(hero)
    else:
        story.append(Spacer(1, 4.5 * inch))

    story.append(Spacer(1, 0.2 * inch))
    story.append(Paragraph("AXIS PERFORMANCE", ParagraphStyle(
        "cover_title", fontName="Helvetica-Bold", fontSize=28, textColor=NAVY)))
    story.append(Paragraph("Project Intelligence Report", ParagraphStyle(
        "cover_sub", fontName="Helvetica", fontSize=14, textColor=BLUE, spaceAfter=4)))
    story.append(Paragraph(project_name, ParagraphStyle(
        "cover_proj", fontName="Helvetica-Bold", fontSize=18, textColor=DARK_GRAY)))
    story.append(Paragraph(f"Generated: {date.today().strftime('%B %d, %Y')}", st["small"]))
    story.append(Paragraph(f"Floor Area: {area_sqft:,.0f} sqft  |  "
                             f"Standard Estimate: {_money(cost_sum.get('standard_total', 0))}  |  "
                             f"Timeline: {cal_days} days", st["small"]))

    from reportlab.platypus import PageBreak
    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════════════════════════
    # PAGE 2 — EXECUTIVE SUMMARY
    # ═══════════════════════════════════════════════════════════════════════════
    story += _section("Executive Summary", st)

    cards_data = [
        (_money(cost_sum.get("standard_total", 0)), "Standard Total Cost", "Architectural shingles + fiber cement"),
        (f"{area_sqft:,.0f} sqft", "Total Floor Area", f"Perimeter: {meta.get('perimeter_lf', 0):,.0f} lf"),
        (f"${cost_sum.get('standard_per_sqft', 0):.0f}/sqft", "Cost per Sqft", "Standard scenario"),
        (f"{cal_days} days", "Project Duration", f"{schedule.get('total_working_days', 0)} working days"),
    ]
    cards = [_metric_card(lbl, val, sub, st) for val, lbl, sub in cards_data]
    card_row = Table([cards], colWidths=[1.55 * inch] * 4, hAlign="LEFT")
    card_row.setStyle(TableStyle([("ALIGN", (0, 0), (-1, -1), "CENTER"),
                                   ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                   ("LEFTPADDING",  (0, 0), (-1, -1), 4),
                                   ("RIGHTPADDING", (0, 0), (-1, -1), 4)]))
    story.append(card_row)
    story.append(Spacer(1, 0.15 * inch))

    summary_text = insights.get("project_summary", "Project summary not available.")
    for para in summary_text.split("\n\n"):
        if para.strip():
            story.append(Paragraph(para.strip(), st["body"]))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════════════════════════
    # PAGE 3 — RENDER GALLERY (2×2)
    # ═══════════════════════════════════════════════════════════════════════════
    story += _section("Render Gallery", st)
    img_w = (content_w - 0.15 * inch) / 2
    img_h = 2.8 * inch

    img_hero  = _render_img(render_paths["hero"],     img_w, img_h)
    img_aer   = _render_img(render_paths["aerial"],   img_w, img_h)
    img_str   = _render_img(render_paths["street"],   img_w, img_h)
    img_int   = _render_img(render_paths["interior"], img_w, img_h)

    def _placeholder(label, w, h):
        p = Table([[Paragraph(label, st["small"])]],
                  colWidths=[w], rowHeights=[h])
        p.setStyle(TableStyle([("BACKGROUND", (0,0),(-1,-1), LIGHT_GRAY),
                                ("ALIGN",(0,0),(-1,-1),"CENTER"),
                                ("VALIGN",(0,0),(-1,-1),"MIDDLE"),
                                ("BOX",(0,0),(-1,-1),0.5,MID_GRAY)]))
        return p

    r1 = [img_hero or _placeholder("Exterior Hero", img_w, img_h),
          img_aer  or _placeholder("Aerial 45°",    img_w, img_h)]
    r2 = [img_str  or _placeholder("Street Level",  img_w, img_h),
          img_int  or _placeholder("Interior",       img_w, img_h)]

    gallery = Table([r1, r2],
                    colWidths=[img_w, img_w],
                    rowHeights=[img_h, img_h])
    gallery.setStyle(TableStyle([
        ("ALIGN",  (0,0),(-1,-1), "CENTER"),
        ("VALIGN", (0,0),(-1,-1), "TOP"),
        ("LEFTPADDING",  (0,0),(-1,-1), 2),
        ("RIGHTPADDING", (0,0),(-1,-1), 2),
        ("TOPPADDING",   (0,0),(-1,-1), 2),
        ("BOTTOMPADDING",(0,0),(-1,-1), 2),
    ]))
    story.append(gallery)

    labels = [
        ["CAM 01 — Exterior Hero (35mm, DOF f/8)", "CAM 02 — Aerial 45° (24mm)"],
        ["CAM 03 — Street Level (50mm, DOF f/5.6)", "CAM 04 — Interior Walkthrough (18mm)"],
    ]
    lbl_tbl = Table(labels, colWidths=[img_w, img_w])
    lbl_tbl.setStyle(TableStyle([("FONTNAME",(0,0),(-1,-1),"Helvetica"),
                                  ("FONTSIZE",(0,0),(-1,-1),7),
                                  ("TEXTCOLOR",(0,0),(-1,-1),DARK_GRAY),
                                  ("ALIGN",(0,0),(-1,-1),"CENTER")]))
    story.append(lbl_tbl)
    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════════════════════════
    # PAGE 4 — AERIAL + STREET LEVEL FULL-WIDTH
    # ═══════════════════════════════════════════════════════════════════════════
    story += _section("Exterior Perspectives", st)
    for key, lbl in [("aerial", "Aerial 45° View"), ("street", "Street Level View")]:
        img = _render_img(render_paths[key], content_w, 3.1 * inch)
        story.append(Paragraph(lbl, st["h3"]))
        story.append(img or _placeholder(lbl, content_w, 3.1 * inch))
        story.append(Spacer(1, 0.1 * inch))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════════════════════════
    # PAGE 5 — COST BREAKDOWN
    # ═══════════════════════════════════════════════════════════════════════════
    story += _section("Cost Breakdown — Standard Scenario", st)

    phases_std = cr_std.get("phases", {})
    phase_labels = {
        "phase1_foundation":   "Foundation",
        "phase2_framing":      "Framing",
        "phase3_roofing":      "Roofing",
        "phase4_ext_finishes": "Ext. Finishes",
        "phase5_int_rough":    "Int. Rough-In",
        "phase6_int_finishes": "Int. Finishes",
        "phase7_overhead":     "O&P + Contingency",
    }

    phase_rows = [["Phase", "Materials", "Labor", "Total", "% of Total"]]
    grand = cr_std.get("grand_total", 1) or 1
    for pid, plbl in phase_labels.items():
        ph = phases_std.get(pid, {})
        tot = ph.get("total", 0)
        phase_rows.append([
            plbl,
            _money(ph.get("material", 0)),
            _money(ph.get("labor", 0)),
            _money(tot),
            _pct(tot / grand * 100),
        ])
    phase_rows.append(["Grand Total", "", "",
                        _money(cr_std.get("grand_total", 0)), "100.0%"])

    ph_tbl = Table(phase_rows, colWidths=[2.0*inch, 1.1*inch, 1.1*inch, 1.1*inch, 0.9*inch])
    style = _table_style()
    style.add("FONTNAME", (0, len(phase_rows)-1), (-1, len(phase_rows)-1), "Helvetica-Bold")
    style.add("BACKGROUND", (0, len(phase_rows)-1), (-1, len(phase_rows)-1),
              colors.HexColor("#E8EFF7"))
    ph_tbl.setStyle(style)
    story.append(ph_tbl)
    story.append(Spacer(1, 0.15 * inch))

    # Scenario comparison
    story.append(Paragraph("Scenario Comparison", st["h3"]))
    sc_rows = [
        ["Scenario", "Roofing", "Siding", "Grand Total", "$/SqFt", "vs. Economy"],
        ["Economy",   "3-Tab Shingle", "Vinyl",           _money(cr_eco.get("grand_total",0)), f"${cr_eco.get('cost_per_sqft',0):.0f}", "—"],
        ["Standard",  "Arch. Shingle", "Fiber Cement",    _money(cr_std.get("grand_total",0)), f"${cr_std.get('cost_per_sqft',0):.0f}",
         f"+{_money(cr_std.get('delta',{}).get('vs_economy_dollars',0))}"],
        ["Premium",   "Metal (SS)",    "Brick",           _money(cr_prm.get("grand_total",0)), f"${cr_prm.get('cost_per_sqft',0):.0f}",
         f"+{_money(cr_prm.get('delta',{}).get('vs_economy_dollars',0))}"],
    ]
    sc_tbl = Table(sc_rows, colWidths=[1.0*inch, 1.2*inch, 1.2*inch, 1.1*inch, 0.7*inch, 1.0*inch])
    sc_tbl.setStyle(_table_style())
    story.append(sc_tbl)
    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════════════════════════
    # PAGES 6–8 — BILL OF QUANTITIES
    # ═══════════════════════════════════════════════════════════════════════════
    boq_pages = [
        [("phase1_foundation", "Phase 1 — Site Prep & Foundation"),
         ("phase2_framing",    "Phase 2 — Framing & Structure")],
        [("phase3_roofing",      "Phase 3 — Roofing"),
         ("phase4_ext_finishes", "Phase 4 — Exterior Finishes")],
        [("phase5_int_rough",    "Phase 5 — Interior Rough-In"),
         ("phase6_int_finishes", "Phase 6 — Interior Finishes"),
         ("phase7_overhead",     "Phase 7 — Overhead, Profit & Contingency")],
    ]

    for page_phases in boq_pages:
        story += _section("Bill of Quantities", st)
        for pid, plbl in page_phases:
            ph_data = phases_std.get(pid, {})
            story += _phase_table(ph_data, st, plbl)

        if page_phases == boq_pages[-1]:
            # Grand total row
            story.append(Spacer(1, 0.1 * inch))
            gt_rows = [
                ["", "Subtotal (Materials)", _money(cr_std.get("subtotal_materials", 0))],
                ["", "Subtotal (Labor)",     _money(cr_std.get("subtotal_labor", 0))],
                ["", "Overhead & Profit (15%)", _money(cr_std.get("overhead", 0))],
                ["", "Contingency (10%)",    _money(cr_std.get("contingency", 0))],
                ["★", "GRAND TOTAL",         _money(cr_std.get("grand_total", 0))],
            ]
            gt_tbl = Table(gt_rows, colWidths=[0.4*inch, 4.0*inch, 1.8*inch])
            gt_tbl.setStyle(TableStyle([
                ("FONTNAME",  (0,0),(-1,-1), "Helvetica"),
                ("FONTNAME",  (0,4),(-1,4),  "Helvetica-Bold"),
                ("FONTSIZE",  (0,0),(-1,-1), 9),
                ("ALIGN",     (2,0),(-1,-1), "RIGHT"),
                ("BACKGROUND",(0,4),(-1,4),  NAVY),
                ("TEXTCOLOR", (0,4),(-1,4),  WHITE),
                ("TOPPADDING",(0,0),(-1,-1), 3),
                ("BOTTOMPADDING",(0,0),(-1,-1),3),
            ]))
            story.append(gt_tbl)

        story.append(PageBreak())

    # ═══════════════════════════════════════════════════════════════════════════
    # PAGE 9 — CONSTRUCTION SCHEDULE
    # ═══════════════════════════════════════════════════════════════════════════
    story += _section("Construction Schedule", st)

    tasks = schedule.get("tasks", [])
    sched_rows = [["Phase", "Start", "End", "Days", "Crew", "Labor Hrs"]]
    for t in tasks:
        sched_rows.append([
            t["label"],
            t["start_date"],
            t["end_date"],
            str(t["duration_days"]),
            str(t["crew_size"]),
            f"{t['labor_hours']:,.0f}",
        ])

    sched_tbl = Table(sched_rows, colWidths=[1.9*inch, 0.9*inch, 0.9*inch,
                                               0.55*inch, 0.55*inch, 0.8*inch])
    sched_tbl.setStyle(_table_style())
    story.append(sched_tbl)
    story.append(Spacer(1, 0.15 * inch))

    # Milestones
    story.append(Paragraph("Key Milestones", st["h3"]))
    ms_rows = [["Milestone", "Date"]]
    for ms in schedule.get("milestones", []):
        ms_rows.append([ms["label"], ms["date"]])
    ms_tbl = Table(ms_rows, colWidths=[4.0 * inch, 1.2 * inch])
    ms_tbl.setStyle(_table_style())
    story.append(ms_tbl)

    story.append(Paragraph(
        f"Total: {schedule.get('total_calendar_days', 0)} calendar days · "
        f"{schedule.get('total_working_days', 0)} working days · "
        f"{schedule.get('total_labor_hours', 0):,.0f} labor hours",
        st["body"]))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════════════════════════
    # PAGE 10 — MATERIAL SPECIFICATIONS
    # ═══════════════════════════════════════════════════════════════════════════
    story += _section("Material Specifications", st)

    q_roof = quantities["roofing"]
    q_wall = quantities["walls"]
    q_opn  = quantities["openings"]

    specs = [
        ("Roofing System", [
            ["Item", "Quantity", "Unit", "Notes"],
            ["Asphalt Shingles (Arch.)", f"{q_roof['shingle_squares']:.1f}", "Squares", "130 mph wind-rated, Class A fire"],
            ["Underlayment (30 lb felt)", f"{q_roof['underlayment_sqft']:,.0f}", "SqFt", "Synthetic preferred"],
            ["Ice & Water Shield", f"{q_roof['ice_water_shield_sqft']:,.0f}", "SqFt", "Eaves + valleys"],
            ["Drip Edge", f"{q_roof['drip_edge_lf']:,.0f}", "LF", "Galvanized steel"],
            ["Ridge Cap", f"{q_roof['ridge_cap_lf']:,.0f}", "LF", "Match shingle color"],
            ["Flashing", f"{q_roof['flashing_lf']:,.0f}", "LF", "26-gauge galvanized"],
        ]),
        ("Exterior Wall System", [
            ["Item", "Quantity", "Unit", "Notes"],
            ["Siding (Fiber Cement)", f"{q_wall['siding_sqft']:,.0f}", "SqFt", "Prefinished preferred"],
            ["Wall Sheathing (OSB)", f"{q_wall['sheathing_sqft']:,.0f}", "SqFt", "7/16\" ZIP System"],
            ["House Wrap", f"{q_wall['house_wrap_sqft']:,.0f}", "SqFt", "Tyvek HomeWrap or equal"],
            ["Exterior Paint", f"{q_wall['paint_gallons']:.0f}", "Gallons", "2-coat system"],
            ["Trim Boards", f"{q_wall['trim_lf']:,.0f}", "LF", "PVC or primed pine"],
        ]),
        ("Openings", [
            ["Item", "Count", "Unit", "Specs"],
            ["Standard Windows", str(q_opn["window_count"]), "Each", "Double-pane, Low-E, U-0.30"],
            ["Exterior Doors", str(q_opn["door_count"]), "Each", "Fiberglass, energy-rated"],
            ["Window Glazing Area", f"{q_opn['glass_sqft']:.0f}", "SqFt", "Total glass area"],
        ]),
    ]

    for spec_title, spec_rows in specs:
        story.append(Paragraph(spec_title, st["h3"]))
        col_w = [(content_w - 1.8 * inch) / (len(spec_rows[0]) - 2)] * (len(spec_rows[0]) - 2)
        col_w = [1.8 * inch] + col_w + [0.8 * inch]
        spec_tbl = Table(spec_rows, colWidths=col_w[:len(spec_rows[0])])
        spec_tbl.setStyle(_table_style())
        story.append(spec_tbl)
        story.append(Spacer(1, 0.1 * inch))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════════════════════════
    # PAGE 11 — AI INSIGHTS
    # ═══════════════════════════════════════════════════════════════════════════
    story += _section("AI Insights & Recommendations", st)

    insight_sections = [
        ("Cost Analysis", insights.get("cost_analysis", "")),
        ("Schedule Risk Assessment", insights.get("schedule_risks", "")),
        ("Material Recommendations", insights.get("material_recommendations", "")),
    ]
    for ins_title, ins_text in insight_sections:
        story.append(Paragraph(ins_title, st["h3"]))
        for line in ins_text.split("\n"):
            if line.strip():
                story.append(Paragraph(line.strip(), st["body"]))
        story.append(Spacer(1, 0.1 * inch))

    story.append(Paragraph("Pre-Construction Quality Checklist", st["h3"]))
    checklist = insights.get("quality_checklist", "")
    for line in checklist.split("\n"):
        if line.strip():
            story.append(Paragraph(line.strip(), st["body"]))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════════════════════════
    # PAGE 12 — TERMS & NOTES
    # ═══════════════════════════════════════════════════════════════════════════
    story += _section("Terms, Assumptions & Exclusions", st)

    terms = [
        ("Estimate Validity", "This estimate is valid for 30 days from the date of issue. "
         "Material prices are subject to change based on market conditions."),
        ("Assumptions", "Quantities are derived from AI-parsed blueprint data. "
         f"Scale confidence: {meta.get('scale_confidence', 'estimated')}. "
         "Site conditions, soil bearing capacity, and utility connections are excluded."),
        ("Exclusions", "This estimate excludes: MEP engineering, permits and fees, "
         "hazardous material remediation, landscaping, appliances, and owner-furnished items."),
        ("Accuracy", "Construction cost estimates carry an inherent uncertainty of ±15–20%. "
         "A detailed quantity survey by a licensed estimator is recommended before contract award."),
        ("Regional Pricing", "Unit costs reflect US national averages (2025). "
         "Regional adjustments may apply. Contact your local supplier for current pricing."),
    ]

    for term_title, term_body in terms:
        story.append(Paragraph(f"<b>{term_title}:</b> {term_body}", st["body"]))

    story.append(Spacer(1, 0.4 * inch))
    story.append(Paragraph("Signatures", st["h3"]))

    sig_rows = [
        ["Prepared by:", "_" * 40, "Date:", "_" * 20],
        ["", "", "", ""],
        ["Reviewed by:", "_" * 40, "Date:", "_" * 20],
    ]
    sig_tbl = Table(sig_rows, colWidths=[1.1*inch, 2.6*inch, 0.6*inch, 1.9*inch])
    sig_tbl.setStyle(TableStyle([
        ("FONTNAME", (0,0),(-1,-1), "Helvetica"),
        ("FONTSIZE", (0,0),(-1,-1), 9),
        ("VALIGN",   (0,0),(-1,-1), "BOTTOM"),
        ("TOPPADDING",(0,0),(-1,-1), 8),
    ]))
    story.append(sig_tbl)

    # ── Build PDF ──────────────────────────────────────────────────────────────
    doc.build(story)
    print(f"[AXIS 5D] PDF report → {pdf_path}")
    return pdf_path


def run_report_generator(
    output_dir:   str,
    project_name: str = "Project",
) -> str:
    """Load all JSON outputs and generate the PDF."""
    def _load(name):
        with open(os.path.join(output_dir, "data", name)) as f:
            return json.load(f)

    return generate_report(
        quantities   = _load("quantities.json"),
        cost_report  = _load("cost_report.json"),
        schedule     = _load("schedule.json"),
        insights     = _load("insights.json"),
        output_dir   = output_dir,
        project_name = project_name,
    )


if __name__ == "__main__":
    import sys
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "output"
    proj    = sys.argv[2] if len(sys.argv) > 2 else "Project"
    path    = run_report_generator(out_dir, proj)
    print(f"Report: {path}")
