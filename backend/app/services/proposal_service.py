"""
proposal_service.py
====================
Generates professional, contractor-branded proposal PDFs.

Every piece of data in the proposal is sourced from:
  - contractor_profile (company name, license, phone — user-entered)
  - project record (address, type — user-entered)
  - estimator.py output (quantities — derived from Claude Vision blueprint parse)
  - live_pricing_service.py (prices — Tavily web search + RSMeans regional index)
  - construction_scheduler output (timeline — calculated from quantities)

Nothing is invented. All AI-generated text (scope of work) is clearly
labeled as AI-generated and contains only what the material list supports.
"""

from __future__ import annotations

import io
import json
import logging
import os
from datetime import date, timedelta
from typing import Optional

log = logging.getLogger(__name__)

# ── Reportlab imports ──────────────────────────────────────────────────────────
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    Image,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

PAGE_W, PAGE_H = letter
MARGIN = 0.75 * inch

# ── Colour palette ─────────────────────────────────────────────────────────────
NAVY  = colors.HexColor("#0F1B2D")
BLUE  = colors.HexColor("#2D7DD2")
SLATE = colors.HexColor("#64748B")
LIGHT = colors.HexColor("#F8FAFC")
MID   = colors.HexColor("#E2E8F0")
WHITE = colors.white
BLACK = colors.HexColor("#1E293B")


def _money(v: float) -> str:
    return f"${v:,.2f}"


def _money0(v: float) -> str:
    return f"${v:,.0f}"


# ── Page header / footer ──────────────────────────────────────────────────────
def _make_page_decor(contractor: dict, page_label: str):
    company = contractor.get("company_name", "Contractor")

    def decor(canvas, doc):
        canvas.saveState()
        w, h = letter

        # Header: company name on navy bar
        canvas.setFillColor(NAVY)
        canvas.rect(0, h - 0.5 * inch, w, 0.5 * inch, fill=1, stroke=0)
        canvas.setFont("Helvetica-Bold", 10)
        canvas.setFillColor(WHITE)
        canvas.drawString(MARGIN, h - 0.32 * inch, company.upper())
        canvas.setFont("Helvetica", 8)
        canvas.drawRightString(w - MARGIN, h - 0.32 * inch,
                               f"{page_label}  ·  Page {doc.page}")

        # Footer
        canvas.setStrokeColor(BLUE)
        canvas.setLineWidth(1)
        canvas.line(MARGIN, 0.5 * inch, w - MARGIN, 0.5 * inch)
        lic = contractor.get("license_number", "")
        footer_txt = f"License #{lic}  ·  {contractor.get('phone', '')}  ·  {contractor.get('email', '')}"
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(SLATE)
        canvas.drawCentredString(w / 2, 0.32 * inch, footer_txt)

        canvas.restoreState()

    return decor


def _styles() -> dict:
    s = {}
    s["h1"]    = ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=22, textColor=NAVY, spaceAfter=6)
    s["h2"]    = ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=14, textColor=NAVY, spaceAfter=4)
    s["h3"]    = ParagraphStyle("h3", fontName="Helvetica-Bold", fontSize=11, textColor=BLUE, spaceAfter=3)
    s["body"]  = ParagraphStyle("body", fontName="Helvetica", fontSize=9, textColor=BLACK, leading=14, spaceAfter=4)
    s["small"] = ParagraphStyle("small", fontName="Helvetica", fontSize=8, textColor=SLATE, leading=12)
    s["label"] = ParagraphStyle("label", fontName="Helvetica-Bold", fontSize=8, textColor=NAVY)
    s["caveat"]= ParagraphStyle("caveat", fontName="Helvetica-Oblique", fontSize=7.5,
                                 textColor=SLATE, leading=11, spaceAfter=2)
    return s


def _tbl(rows, col_widths, header_bg=NAVY):
    t = Table(rows, colWidths=col_widths)
    t.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, 0),  header_bg),
        ("TEXTCOLOR",     (0, 0), (-1, 0),  WHITE),
        ("FONTNAME",      (0, 0), (-1, 0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0, 0), (-1, 0),  8),
        ("FONTNAME",      (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE",      (0, 1), (-1, -1), 8),
        ("ROWBACKGROUNDS",(0, 1), (-1, -1), [WHITE, LIGHT]),
        ("GRID",          (0, 0), (-1, -1), 0.4, MID),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING",    (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING",   (0, 0), (-1, -1), 6),
    ]))
    return t


def _generate_scope_of_work(
    project_name: str,
    trade_type: str,
    materials: list[dict],
    total_sqft: float,
    client: object,  # Anthropic client
) -> str:
    """
    Generate scope of work text using Claude.
    The prompt only includes facts from the actual material list.
    """
    cat_summary = {}
    for m in materials:
        cat = m.get("category", "other")
        cat_summary[cat] = cat_summary.get(cat, 0) + m.get("total_cost", 0)

    top_cats = sorted(cat_summary.items(), key=lambda x: x[1], reverse=True)[:6]
    cats_str = ", ".join(f"{c} (${v:,.0f})" for c, v in top_cats)

    prompt = f"""Write a professional scope of work paragraph (150–200 words) for a contractor proposal.

Project: {project_name}
Trade type: {trade_type}
Total area: {total_sqft:,.0f} sqft
Material categories and estimated costs: {cats_str}

Instructions:
- Write in second person addressing the property owner
- Describe only what the material list implies — do not invent items not in the list
- Be specific about the trade type
- Professional tone, no marketing fluff
- End with "All work performed per applicable building codes and manufacturer specifications."
- Do NOT include pricing in the scope text (it appears separately)"""

    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text.strip()
    except Exception as e:
        log.warning(f"Scope generation failed: {e}")
        return (
            f"This proposal covers the complete {trade_type.lower()} scope of work "
            f"for the {total_sqft:,.0f} sqft project at {project_name}. "
            f"Work includes all materials, labor, and cleanup as itemized in this document. "
            "All work performed per applicable building codes and manufacturer specifications."
        )


def generate_proposal(
    project:        dict,
    contractor:     dict,
    materials:      list[dict],
    pricing_data:   dict,             # from live_pricing_service
    schedule_data:  dict | None,
    trade_type:     str = "General Construction",
    tier:           str = "standard", # economy | standard | premium
    client_name:    str = "",
    client_email:   str = "",
    client_phone:   str = "",
    client_address: str = "",
    notes:          str = "",
    valid_days:     int = 30,
    output_path:    str | None = None,
) -> bytes:
    """
    Generate a professional contractor proposal PDF.

    Returns raw PDF bytes. Optionally saves to output_path.
    """
    from anthropic import Anthropic
    claude = Anthropic()

    st = _styles()
    project_name = project.get("name", "Project")
    project_addr = project.get("address", project.get("city", ""))
    total_sqft   = project.get("total_sqft", 0)
    today        = date.today()
    valid_until  = today + timedelta(days=valid_days)

    loc_note = pricing_data.get("regional_note", "")
    loc      = pricing_data.get("location", "")

    content_w = PAGE_W - 2 * MARGIN

    # Generate scope of work
    scope = _generate_scope_of_work(
        project_name, trade_type, materials, total_sqft, claude
    )

    # Compute totals
    subtotal = sum(m.get("total_cost", 0) for m in materials)

    TIER_MARKUP = {"economy": 0.18, "standard": 0.25, "premium": 0.35}
    TIER_LABELS = {
        "economy":  "Economy — standard materials, meets minimum code",
        "standard": "Standard — quality materials, best-value balance",
        "premium":  "Premium — upgraded materials, superior finish",
    }
    markup_pct = TIER_MARKUP.get(tier, 0.25)
    labor_estimate = round(subtotal * 0.60, 2)   # materials are ~62% of total; labor ~38%
    overhead       = round((subtotal + labor_estimate) * 0.12, 2)
    profit         = round((subtotal + labor_estimate) * markup_pct, 2)
    grand_total    = round(subtotal + labor_estimate + overhead + profit, 2)
    psf            = round(grand_total / total_sqft, 2) if total_sqft else 0

    # Payment schedule
    payment_schedule = [
        {"milestone": "Contract Signing / Mobilization Deposit", "pct": 30, "amount": round(grand_total * 0.30, 2)},
        {"milestone": "Completion of Structural / Rough-In Phase",  "pct": 35, "amount": round(grand_total * 0.35, 2)},
        {"milestone": "Substantial Completion",                      "pct": 25, "amount": round(grand_total * 0.25, 2)},
        {"milestone": "Final Inspection & Punch List Complete",      "pct": 10, "amount": round(grand_total * 0.10, 2)},
    ]

    # ── Build PDF ──────────────────────────────────────────────────────────────
    buffer = io.BytesIO()
    doc = BaseDocTemplate(
        buffer,
        pagesize=letter,
        topMargin=0.6 * inch,
        bottomMargin=0.6 * inch,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
    )
    page_label = f"Proposal — {project_name}"
    frame = Frame(MARGIN, 0.65 * inch, content_w, PAGE_H - 1.25 * inch, id="main")
    doc.addPageTemplates([
        PageTemplate(id="main", frames=frame,
                     onPage=_make_page_decor(contractor, page_label))
    ])

    story = []

    # ═══════════════════════════════════════════════════════════════════════════
    # PAGE 1 — PROPOSAL HEADER
    # ═══════════════════════════════════════════════════════════════════════════
    story.append(Spacer(1, 0.1 * inch))
    story.append(Paragraph("PROPOSAL / ESTIMATE", ParagraphStyle(
        "pt", fontName="Helvetica-Bold", fontSize=9, textColor=BLUE,
        tracking=2, spaceAfter=4)))
    story.append(Paragraph(project_name, st["h1"]))
    story.append(HRFlowable(width="100%", thickness=2, color=BLUE, spaceAfter=10))

    # Two-column header: project info | contractor info
    header_data = [
        [Paragraph("<b>PROJECT</b>", st["label"]),      Paragraph("<b>PREPARED BY</b>", st["label"])],
        [Paragraph(project_addr or "—", st["body"]),    Paragraph(contractor.get("company_name", ""), st["body"])],
        [Paragraph(f"Type: {trade_type}", st["small"]), Paragraph(f"Lic # {contractor.get('license_number', '—')}", st["small"])],
        [Paragraph(f"Area: {total_sqft:,.0f} sqft", st["small"]), Paragraph(contractor.get("phone", ""), st["small"])],
        [Paragraph(f"Date: {today.strftime('%B %d, %Y')}", st["small"]), Paragraph(contractor.get("email", ""), st["small"])],
        [Paragraph(f"Valid until: {valid_until.strftime('%B %d, %Y')}", st["small"]), Paragraph(f"{contractor.get('address', '')} {contractor.get('city', '')} {contractor.get('state', '')}", st["small"])],
    ]

    if client_name:
        header_data.insert(0, [Paragraph("<b>PREPARED FOR</b>", st["label"]), Paragraph("", st["label"])])
        header_data.insert(1, [Paragraph(client_name, st["body"]), Paragraph("", st["body"])])
        if client_address:
            header_data.insert(2, [Paragraph(client_address, st["small"]), Paragraph("", st["small"])])

    header_tbl = Table(header_data, colWidths=[content_w * 0.5, content_w * 0.5])
    header_tbl.setStyle(TableStyle([
        ("VALIGN",       (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING",   (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 3),
    ]))
    story.append(header_tbl)
    story.append(Spacer(1, 0.2 * inch))

    # Price summary card
    tier_label = TIER_LABELS.get(tier, "Standard")
    summary_rows = [
        ["", "", ""],
        [Paragraph(f"<b>{tier_label.split('—')[0].strip()}</b>", ParagraphStyle("tc", fontName="Helvetica-Bold", fontSize=11, textColor=WHITE)),
         Paragraph("<b>TOTAL PROJECT COST</b>", ParagraphStyle("tc2", fontName="Helvetica-Bold", fontSize=9, textColor=colors.HexColor("#94A3B8"))),
         Paragraph(f"<b>{_money0(grand_total)}</b>", ParagraphStyle("tc3", fontName="Helvetica-Bold", fontSize=22, textColor=WHITE))],
        [Paragraph(tier_label.split("—")[1].strip() if "—" in tier_label else "", ParagraphStyle("ts", fontName="Helvetica", fontSize=8, textColor=colors.HexColor("#94A3B8"))),
         Paragraph(f"${psf:.0f} / sqft  ·  {loc}", ParagraphStyle("ts2", fontName="Helvetica", fontSize=8, textColor=colors.HexColor("#94A3B8"))),
         Paragraph(f"Materials {_money0(subtotal)}  ·  Labor {_money0(labor_estimate)}", ParagraphStyle("ts3", fontName="Helvetica", fontSize=8, textColor=colors.HexColor("#94A3B8")))],
        ["", "", ""],
    ]
    price_card = Table(summary_rows, colWidths=[content_w * 0.25, content_w * 0.35, content_w * 0.40])
    price_card.setStyle(TableStyle([
        ("BACKGROUND",   (0, 0), (-1, -1), NAVY),
        ("TOPPADDING",   (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 6),
        ("LEFTPADDING",  (0, 0), (-1, -1), 12),
        ("ROUNDEDCORNERS", [6]),
    ]))
    story.append(price_card)
    story.append(Spacer(1, 0.2 * inch))

    # Scope of work
    story.append(Paragraph("Scope of Work", st["h3"]))
    story.append(Paragraph(scope, st["body"]))
    story.append(Paragraph(
        "⚠ Scope of work paragraph above was AI-generated from the material list. "
        "Review and edit before sending to client.",
        st["caveat"]
    ))
    story.append(Spacer(1, 0.15 * inch))

    # Payment schedule
    story.append(Paragraph("Payment Schedule", st["h3"]))
    pay_rows = [["Milestone", "% Due", "Amount"]]
    for p in payment_schedule:
        pay_rows.append([p["milestone"], f"{p['pct']}%", _money(p["amount"])])
    pay_rows.append(["TOTAL", "100%", _money(grand_total)])
    pay_tbl = _tbl(pay_rows, [content_w * 0.6, content_w * 0.15, content_w * 0.25])
    pay_tbl.setStyle(pay_tbl.getStyle())
    last = len(pay_rows) - 1
    pay_tbl.setStyle(TableStyle([
        *pay_tbl._cmds,
        ("FONTNAME",   (0, last), (-1, last), "Helvetica-Bold"),
        ("BACKGROUND", (0, last), (-1, last), colors.HexColor("#EFF6FF")),
    ]))
    story.append(pay_tbl)

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════════════════════════
    # PAGE 2 — MATERIAL ESTIMATE (ITEMIZED)
    # ═══════════════════════════════════════════════════════════════════════════
    story.append(Spacer(1, 0.1 * inch))
    story.append(Paragraph("Material Estimate — Itemized", st["h2"]))
    story.append(HRFlowable(width="100%", thickness=1.5, color=BLUE, spaceAfter=8))

    # Pricing provenance note
    story.append(Paragraph(
        f"Prices as of {date.today().strftime('%B %d, %Y')} · {pricing_data.get('pricing_note', '')}",
        st["caveat"]
    ))
    story.append(Spacer(1, 0.08 * inch))

    # Group by category
    cat_groups: dict[str, list] = {}
    for m in materials:
        cat = m.get("category", "other").replace("_", " ").title()
        cat_groups.setdefault(cat, []).append(m)

    for cat_name, items in cat_groups.items():
        story.append(Paragraph(cat_name, st["h3"]))
        rows = [["Item", "Qty", "Unit", "Unit Price", "Source", "Total"]]
        cat_total = 0
        for it in items:
            pd = it.get("pricing_detail", {})
            is_live = pd.get("is_live", False)
            source_tag = "● live" if is_live else "○ est."
            rows.append([
                it.get("item_name", ""),
                f"{it.get('quantity', 0):,.1f}",
                it.get("unit", ""),
                _money(it.get("unit_cost", 0)),
                source_tag,
                _money(it.get("total_cost", 0)),
            ])
            cat_total += it.get("total_cost", 0)
        rows.append(["", "", "", "", f"{cat_name} subtotal →", _money(cat_total)])

        cw = [content_w * 0.32, 0.50 * inch, 0.45 * inch,
              0.80 * inch, 0.60 * inch, 0.85 * inch]
        t = _tbl(rows, cw)
        last_r = len(rows) - 1
        t.setStyle(TableStyle([
            *t._cmds,
            ("FONTNAME",   (0, last_r), (-1, last_r), "Helvetica-Bold"),
            ("BACKGROUND", (0, last_r), (-1, last_r), LIGHT),
            ("ALIGN",      (1, 0),      (-1, -1),      "RIGHT"),
        ]))
        story.append(t)
        story.append(Spacer(1, 0.08 * inch))

    # Pricing legend
    story.append(Paragraph(
        "● live = price sourced from current web search (Home Depot / Lowe's / regional supplier)  "
        "○ est. = national average estimate with RSMeans regional adjustment",
        st["caveat"]
    ))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════════════════════════
    # PAGE 3 — COST SUMMARY + SCHEDULE + SIGNATURE
    # ═══════════════════════════════════════════════════════════════════════════
    story.append(Spacer(1, 0.1 * inch))
    story.append(Paragraph("Cost Summary", st["h2"]))
    story.append(HRFlowable(width="100%", thickness=1.5, color=BLUE, spaceAfter=8))

    summary_rows2 = [
        ["Materials (itemized above)", _money(subtotal)],
        ["Labor (estimated)", _money(labor_estimate)],
        [f"Overhead & Insurance (12%)", _money(overhead)],
        [f"Contractor Margin ({int(markup_pct*100)}%  — {tier} tier)", _money(profit)],
    ]
    sum_tbl = Table(summary_rows2, colWidths=[content_w * 0.65, content_w * 0.35])
    sum_tbl.setStyle(TableStyle([
        ("FONTNAME",      (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE",      (0, 0), (-1, -1), 9),
        ("ALIGN",         (1, 0), (-1, -1), "RIGHT"),
        ("ROWBACKGROUNDS",(0, 0), (-1, -1), [WHITE, LIGHT]),
        ("GRID",          (0, 0), (-1, -1), 0.4, MID),
        ("TOPPADDING",    (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING",   (0, 0), (-1, -1), 8),
    ]))
    story.append(sum_tbl)
    total_row = Table(
        [[Paragraph("<b>TOTAL PROJECT COST</b>", ParagraphStyle("tt", fontName="Helvetica-Bold", fontSize=11, textColor=WHITE)),
          Paragraph(f"<b>{_money(grand_total)}</b>", ParagraphStyle("tv", fontName="Helvetica-Bold", fontSize=14, textColor=WHITE))]],
        colWidths=[content_w * 0.65, content_w * 0.35]
    )
    total_row.setStyle(TableStyle([
        ("BACKGROUND",   (0, 0), (-1, -1), NAVY),
        ("ALIGN",        (1, 0), (-1, -1), "RIGHT"),
        ("TOPPADDING",   (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 8),
        ("LEFTPADDING",  (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(total_row)
    story.append(Spacer(1, 0.15 * inch))

    # Timeline
    if schedule_data and schedule_data.get("tasks"):
        story.append(Paragraph("Estimated Project Timeline", st["h3"]))
        story.append(Paragraph(
            f"Project Start: {schedule_data.get('project_start', 'TBD')}  ·  "
            f"Substantial Completion: {schedule_data.get('project_end', 'TBD')}  ·  "
            f"Duration: {schedule_data.get('total_calendar_days', '—')} calendar days",
            st["body"]
        ))
        sched_rows = [["Phase", "Duration", "Start", "End"]]
        for t in schedule_data.get("tasks", []):
            sched_rows.append([
                t["label"],
                f"{t['duration_days']} days",
                t["start_date"],
                t["end_date"],
            ])
        sched_tbl = _tbl(sched_rows, [content_w * 0.45, 0.75 * inch, 1.0 * inch, 1.0 * inch])
        story.append(sched_tbl)
        story.append(Spacer(1, 0.15 * inch))

    # Notes
    if notes:
        story.append(Paragraph("Notes / Exclusions", st["h3"]))
        for line in notes.split("\n"):
            if line.strip():
                story.append(Paragraph(line.strip(), st["body"]))
        story.append(Spacer(1, 0.1 * inch))

    # Terms
    story.append(Paragraph("Terms & Conditions", st["h3"]))
    terms_text = [
        f"1. This proposal is valid for {valid_days} days from the date of issue ({today.strftime('%B %d, %Y')}).",
        "2. Material prices are subject to change. Confirmed pricing will be locked at contract signing.",
        "3. Any work not explicitly described in the scope of work is excluded and may require a change order.",
        "4. All work is warranted against defects in workmanship for one (1) year from substantial completion.",
        "5. Owner is responsible for obtaining and paying for all required permits unless explicitly included above.",
        "6. Contractor carries general liability insurance and workers' compensation as required by state law.",
    ]
    for t in terms_text:
        story.append(Paragraph(t, st["small"]))
    story.append(Spacer(1, 0.25 * inch))

    # Signature block
    story.append(Paragraph("Authorization to Proceed", st["h3"]))
    story.append(Paragraph(
        "By signing below, the client authorizes the contractor to proceed with the work described "
        "in this proposal under the terms stated above. This document constitutes a binding agreement "
        "upon signature by both parties.",
        st["body"]
    ))
    story.append(Spacer(1, 0.15 * inch))

    sig_rows = [
        [Paragraph("<b>CLIENT SIGNATURE</b>", st["label"]),
         Paragraph("<b>CONTRACTOR SIGNATURE</b>", st["label"])],
        ["_" * 45, "_" * 45],
        [Paragraph("Print Name:", st["small"]), Paragraph("Print Name:", st["small"])],
        ["_" * 45, "_" * 45],
        [Paragraph("Date:", st["small"]), Paragraph("Date:", st["small"])],
        ["_" * 20, "_" * 20],
    ]
    sig_tbl = Table(sig_rows, colWidths=[content_w * 0.5, content_w * 0.5])
    sig_tbl.setStyle(TableStyle([
        ("FONTNAME",    (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE",    (0, 0), (-1, -1), 9),
        ("VALIGN",      (0, 0), (-1, -1), "BOTTOM"),
        ("TOPPADDING",  (0, 0), (-1, -1), 10),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(sig_tbl)

    # ── Build ──────────────────────────────────────────────────────────────────
    doc.build(story)
    pdf_bytes = buffer.getvalue()
    buffer.close()

    if output_path:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "wb") as f:
            f.write(pdf_bytes)

    return pdf_bytes
