"""
reports.py — Project Report endpoints
======================================
GET  /reports/{project_id}/full   — pull all project data for the report page
PATCH /reports/{project_id}/overrides — save user edits (stored in project_reports table)
POST /reports/{project_id}/pdf    — generate and return a PDF of the report
"""
from __future__ import annotations

import io
import logging
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from app.core.supabase import get_supabase

router = APIRouter()
log = logging.getLogger(__name__)


# ── Data aggregator ───────────────────────────────────────────────────────────

@router.get("/{project_id}/full")
async def get_full_report_data(project_id: str):
    """
    Aggregate all available project data for the report page.
    Returns whatever is available — sections with no data return empty/null.
    """
    db = get_supabase()

    # Project
    proj_res = db.table("projects").select("*").eq("id", project_id).single().execute()
    if not proj_res.data:
        raise HTTPException(status_code=404, detail="Project not found")
    project = proj_res.data

    # Blueprint + analysis
    blueprint = None
    analysis = None
    bp_res = db.table("blueprints").select("*").eq("project_id", project_id).order("created_at", desc=True).limit(1).execute()
    if bp_res.data:
        blueprint = bp_res.data[0]
        an_res = db.table("analyses").select("*").eq("blueprint_id", blueprint["id"]).limit(1).execute()
        if an_res.data:
            analysis = an_res.data[0]

    # Materials — from material_estimates (blueprint analysis) + project_materials (manual)
    materials = []
    if analysis:
        mat_res = db.table("material_estimates").select("*").eq("analysis_id", analysis["id"]).execute()
        materials = mat_res.data or []
    if not materials:
        # fallback to manually added project materials
        man_res = db.table("project_materials").select("*").eq("project_id", project_id).execute()
        materials = man_res.data or []

    # Cost estimate
    cost = None
    try:
        cost_res = db.table("cost_estimates").select("*").eq("project_id", project_id).single().execute()
        if cost_res.data:
            cost = cost_res.data
            # attach material_estimates if not already in materials
            if not materials and cost.get("material_estimates"):
                materials = cost["material_estimates"]
    except Exception:
        log.debug("cost_estimates fetch failed", exc_info=True)
        pass

    # Compliance check
    compliance = None
    compliance_items = []
    try:
        cc_res = (
            db.table("compliance_checks")
            .select("*")
            .eq("project_id", project_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        if cc_res.data:
            compliance = cc_res.data[0]
            ci_res = (
                db.table("compliance_items")
                .select("*")
                .eq("check_id", compliance["id"])
                .order("severity")
                .execute()
            )
            compliance_items = ci_res.data or []
    except Exception:
        log.debug("compliance_checks fetch failed", exc_info=True)
        pass

    # Permit portal info (from permit_form_cache if available)
    permit_info = None
    try:
        city = project.get("city", "")
        region = project.get("region", "US-TX")
        state = region.replace("US-", "") if region else ""
        project_type = project.get("blueprint_type", "residential")
        if city and state:
            cache_res = (
                db.table("permit_form_cache")
                .select("*")
                .eq("city", city)
                .eq("state", state)
                .limit(1)
                .execute()
            )
            if cache_res.data:
                permit_info = cache_res.data[0]
    except Exception:
        log.debug("permit_form_cache fetch failed", exc_info=True)
        pass

    # Saved report overrides (user edits)
    overrides = {}
    try:
        ov_res = db.table("project_reports").select("overrides").eq("project_id", project_id).single().execute()
        if ov_res.data:
            overrides = ov_res.data.get("overrides") or {}
    except Exception:
        log.debug("project_reports overrides fetch failed", exc_info=True)
        pass

    return {
        "project":          project,
        "blueprint":        blueprint,
        "analysis":         analysis,
        "materials":        materials,
        "cost":             cost,
        "compliance":       compliance,
        "compliance_items": compliance_items,
        "permit_info":      permit_info,
        "overrides":        overrides,
    }


# ── Save overrides ─────────────────────────────────────────────────────────────

class OverridesPayload(BaseModel):
    overrides: dict


@router.patch("/{project_id}/overrides")
async def save_report_overrides(project_id: str, payload: OverridesPayload):
    """Upsert user-edited fields for the report."""
    db = get_supabase()
    try:
        db.table("project_reports").upsert({
            "project_id": project_id,
            "overrides":  payload.overrides,
            "updated_at": "now()",
        }, on_conflict="project_id").execute()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save overrides: {e}")
    return {"saved": True}


# ── PDF export ────────────────────────────────────────────────────────────────

@router.post("/{project_id}/pdf")
async def export_report_pdf(project_id: str):
    """Generate a clean PDF of the full project report and stream it back."""
    from fastapi import Request

    # Fetch the full data
    data = await get_full_report_data(project_id)
    project         = data["project"]
    analysis        = data["analysis"] or {}
    materials       = data["materials"] or []
    cost            = data["cost"] or {}
    compliance_items = data["compliance_items"] or []
    permit_info     = data["permit_info"] or {}
    overrides       = data["overrides"] or {}

    def ov(key: str, default):
        return overrides.get(key, default)

    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import letter
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import inch
        from reportlab.platypus import (
            SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
            HRFlowable, KeepTogether,
        )
        from reportlab.lib.enums import TA_LEFT, TA_CENTER

        buf = io.BytesIO()
        doc = SimpleDocTemplate(
            buf, pagesize=letter,
            leftMargin=0.75*inch, rightMargin=0.75*inch,
            topMargin=0.75*inch, bottomMargin=0.75*inch,
        )
        styles = getSampleStyleSheet()
        NAVY   = colors.HexColor("#1e3a5f")
        BLUE   = colors.HexColor("#2563eb")
        LGRAY  = colors.HexColor("#f1f5f9")
        DGRAY  = colors.HexColor("#64748b")
        GREEN  = colors.HexColor("#059669")
        RED    = colors.HexColor("#dc2626")
        AMBER  = colors.HexColor("#d97706")

        h1 = ParagraphStyle("H1", parent=styles["Normal"], fontSize=20, textColor=NAVY,   fontName="Helvetica-Bold",  spaceAfter=4)
        h2 = ParagraphStyle("H2", parent=styles["Normal"], fontSize=13, textColor=NAVY,   fontName="Helvetica-Bold",  spaceBefore=14, spaceAfter=6)
        h3 = ParagraphStyle("H3", parent=styles["Normal"], fontSize=10, textColor=BLUE,   fontName="Helvetica-Bold",  spaceBefore=8,  spaceAfter=4)
        body = ParagraphStyle("Body", parent=styles["Normal"], fontSize=9,  textColor=colors.HexColor("#374151"), leading=14)
        small = ParagraphStyle("Small", parent=styles["Normal"], fontSize=8, textColor=DGRAY, leading=12)
        caption = ParagraphStyle("Cap", parent=styles["Normal"], fontSize=7, textColor=DGRAY, fontName="Helvetica-Oblique")

        elems = []

        # ── Cover ──────────────────────────────────────────────────────────────
        elems.append(Paragraph(ov("project_name", project.get("name", "Untitled Project")), h1))
        elems.append(Paragraph("Project Report", ParagraphStyle("Sub", parent=styles["Normal"], fontSize=11, textColor=DGRAY)))
        elems.append(Spacer(1, 4))

        region = project.get("region", "")
        city   = project.get("city", "")
        loc    = ", ".join(filter(None, [city, region.replace("US-", "") if region else ""]))
        date   = project.get("created_at", "")[:10]
        meta_rows = []
        if loc:   meta_rows.append(["Location", loc])
        if date:  meta_rows.append(["Created",  date])
        pt = project.get("blueprint_type", "")
        if pt:    meta_rows.append(["Type", pt.replace("_", " ").title()])
        if meta_rows:
            t = Table(meta_rows, colWidths=[1.2*inch, 5*inch])
            t.setStyle(TableStyle([
                ("TEXTCOLOR",  (0,0), (0,-1), DGRAY),
                ("TEXTCOLOR",  (1,0), (1,-1), colors.HexColor("#111827")),
                ("FONTSIZE",   (0,0), (-1,-1), 9),
                ("FONTNAME",   (0,0), (0,-1), "Helvetica-Bold"),
                ("BOTTOMPADDING", (0,0), (-1,-1), 3),
            ]))
            elems.append(t)
        elems.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#e2e8f0"), spaceAfter=10))

        # ── Project Summary ────────────────────────────────────────────────────
        summary_text = ov("summary", project.get("description") or analysis.get("summary") or "")
        if summary_text:
            elems.append(Paragraph("Project Summary", h2))
            elems.append(Paragraph(str(summary_text), body))

        # Blueprint metrics
        if analysis:
            elems.append(Paragraph("Blueprint Analysis", h2))
            sqft  = analysis.get("total_sqft") or analysis.get("floor_area_sqft", 0)
            rooms = analysis.get("room_count") or len(analysis.get("rooms", []))
            conf  = analysis.get("confidence", 0)
            rows  = [["Metric", "Value"]]
            if sqft:  rows.append(["Total Square Footage", f"{float(sqft):,.0f} sqft"])
            if rooms: rows.append(["Room Count", str(rooms)])
            if conf:  rows.append(["Analysis Confidence", f"{float(conf)*100:.0f}%"])
            if len(rows) > 1:
                t = Table(rows, colWidths=[2.5*inch, 4*inch])
                t.setStyle(TableStyle([
                    ("BACKGROUND",    (0,0), (-1,0), NAVY),
                    ("TEXTCOLOR",     (0,0), (-1,0), colors.white),
                    ("FONTNAME",      (0,0), (-1,0), "Helvetica-Bold"),
                    ("FONTSIZE",      (0,0), (-1,-1), 9),
                    ("BACKGROUND",    (0,1), (-1,-1), LGRAY),
                    ("ROWBACKGROUNDS",(0,1), (-1,-1), [colors.white, LGRAY]),
                    ("GRID",          (0,0), (-1,-1), 0.5, colors.HexColor("#e2e8f0")),
                    ("BOTTOMPADDING", (0,0), (-1,-1), 5),
                    ("TOPPADDING",    (0,0), (-1,-1), 5),
                ]))
                elems.append(t)

        # ── Materials List ─────────────────────────────────────────────────────
        if materials:
            elems.append(Paragraph("Materials List", h2))
            rows = [["Item", "Category", "Qty", "Unit", "Unit Cost", "Total"]]
            total_cost = 0.0
            for m in materials:
                uc = float(m.get("unit_cost", 0) or 0)
                tc = float(m.get("total_cost", 0) or m.get("total", 0) or 0)
                total_cost += tc
                rows.append([
                    str(m.get("item_name") or m.get("name") or ""),
                    str(m.get("category", "")).title(),
                    str(m.get("quantity", "")),
                    str(m.get("unit", "")),
                    f"${uc:,.2f}" if uc else "—",
                    f"${tc:,.2f}" if tc else "—",
                ])
            # totals row
            rows.append(["", "", "", "", "TOTAL", f"${total_cost:,.2f}"])
            col_w = [2.2*inch, 1*inch, 0.6*inch, 0.6*inch, 0.9*inch, 0.9*inch]
            t = Table(rows, colWidths=col_w, repeatRows=1)
            t.setStyle(TableStyle([
                ("BACKGROUND",    (0,0), (-1,0), NAVY),
                ("TEXTCOLOR",     (0,0), (-1,0), colors.white),
                ("FONTNAME",      (0,0), (-1,0), "Helvetica-Bold"),
                ("FONTSIZE",      (0,0), (-1,-1), 8),
                ("ROWBACKGROUNDS",(0,1), (-1,-2), [colors.white, LGRAY]),
                ("BACKGROUND",    (0,-1), (-1,-1), colors.HexColor("#f0fdf4")),
                ("FONTNAME",      (0,-1), (-1,-1), "Helvetica-Bold"),
                ("TEXTCOLOR",     (-1,-1), (-1,-1), GREEN),
                ("GRID",          (0,0), (-1,-1), 0.4, colors.HexColor("#e2e8f0")),
                ("BOTTOMPADDING", (0,0), (-1,-1), 4),
                ("TOPPADDING",    (0,0), (-1,-1), 4),
                ("ALIGN",         (2,0), (-1,-1), "RIGHT"),
            ]))
            elems.append(t)

        # ── Cost Breakdown ─────────────────────────────────────────────────────
        if cost:
            elems.append(Paragraph("Cost Breakdown", h2))
            cats = cost.get("categories") or cost.get("cost_breakdown") or {}
            total = cost.get("total_cost") or cost.get("total") or 0
            labor = cost.get("labor_cost") or 0
            mat_c = cost.get("materials_cost") or 0

            summary_rows = [["Category", "Amount"]]
            if mat_c: summary_rows.append(["Materials",    f"${float(mat_c):,.2f}"])
            if labor: summary_rows.append(["Labor",        f"${float(labor):,.2f}"])
            if isinstance(cats, dict):
                for k, v in cats.items():
                    if k not in ("materials", "labor") and v:
                        summary_rows.append([k.replace("_", " ").title(), f"${float(v):,.2f}"])
            if total: summary_rows.append(["TOTAL ESTIMATE", f"${float(total):,.2f}"])

            if len(summary_rows) > 1:
                t = Table(summary_rows, colWidths=[3.5*inch, 2.5*inch])
                t.setStyle(TableStyle([
                    ("BACKGROUND",    (0,0), (-1,0), NAVY),
                    ("TEXTCOLOR",     (0,0), (-1,0), colors.white),
                    ("FONTNAME",      (0,0), (-1,0), "Helvetica-Bold"),
                    ("FONTSIZE",      (0,0), (-1,-1), 9),
                    ("ROWBACKGROUNDS",(0,1), (-1,-2), [colors.white, LGRAY]),
                    ("BACKGROUND",    (0,-1), (-1,-1), colors.HexColor("#f0fdf4")),
                    ("FONTNAME",      (0,-1), (-1,-1), "Helvetica-Bold"),
                    ("TEXTCOLOR",     (-1,-1), (-1,-1), GREEN),
                    ("GRID",          (0,0), (-1,-1), 0.4, colors.HexColor("#e2e8f0")),
                    ("ALIGN",         (1,0), (1,-1), "RIGHT"),
                    ("BOTTOMPADDING", (0,0), (-1,-1), 5),
                    ("TOPPADDING",    (0,0), (-1,-1), 5),
                ]))
                elems.append(t)

        # ── Compliance Check ───────────────────────────────────────────────────
        if compliance_items:
            elems.append(Paragraph("Code Compliance Check", h2))
            if data.get("compliance"):
                risk = data["compliance"].get("risk_level", "")
                summary = data["compliance"].get("summary", "")
                if summary:
                    elems.append(Paragraph(f"<b>Risk Level:</b> {risk.title() if risk else '—'}  |  {summary}", body))
                    elems.append(Spacer(1, 6))

            rows = [["Item", "Category", "Severity", "Action Required"]]
            sev_colors = {"required": RED, "recommended": AMBER, "info": BLUE}
            for item in compliance_items:
                rows.append([
                    str(item.get("title", "")),
                    str(item.get("category", "")).title(),
                    str(item.get("severity", "")).title(),
                    str(item.get("action") or item.get("description", ""))[:120],
                ])
            t = Table(rows, colWidths=[2*inch, 1*inch, 0.85*inch, 2.85*inch], repeatRows=1)
            style_cmds = [
                ("BACKGROUND",    (0,0), (-1,0), NAVY),
                ("TEXTCOLOR",     (0,0), (-1,0), colors.white),
                ("FONTNAME",      (0,0), (-1,0), "Helvetica-Bold"),
                ("FONTSIZE",      (0,0), (-1,-1), 8),
                ("ROWBACKGROUNDS",(0,1), (-1,-1), [colors.white, LGRAY]),
                ("GRID",          (0,0), (-1,-1), 0.4, colors.HexColor("#e2e8f0")),
                ("BOTTOMPADDING", (0,0), (-1,-1), 4),
                ("TOPPADDING",    (0,0), (-1,-1), 4),
                ("VALIGN",        (0,0), (-1,-1), "TOP"),
            ]
            for i, item in enumerate(compliance_items, start=1):
                sev = item.get("severity", "info")
                c = sev_colors.get(sev, BLUE)
                style_cmds.append(("TEXTCOLOR", (2, i), (2, i), c))
                style_cmds.append(("FONTNAME",  (2, i), (2, i), "Helvetica-Bold"))
            t.setStyle(TableStyle(style_cmds))
            elems.append(t)

        # ── Permits ────────────────────────────────────────────────────────────
        elems.append(Paragraph("Permits Required", h2))
        city_str  = project.get("city", "")
        state_str = (project.get("region") or "").replace("US-", "")
        ptype_str = project.get("blueprint_type", "residential")
        elems.append(Paragraph(
            f"The following permit information applies to <b>{city_str}, {state_str}</b> for a "
            f"<b>{ptype_str.replace('_',' ').title()}</b> project. "
            "Verify all requirements with your local building department before construction.",
            body
        ))
        elems.append(Spacer(1, 6))

        custom_permit = ov("permit_notes", "")
        if custom_permit:
            elems.append(Paragraph(str(custom_permit), body))
        elif permit_info:
            prows = [["Field", "Details"]]
            if permit_info.get("portal_url"):
                prows.append(["Permit Portal", permit_info["portal_url"]])
            if permit_info.get("instructions"):
                prows.append(["Instructions", str(permit_info["instructions"])[:200]])
            if permit_info.get("form_url"):
                prows.append(["Application Form", permit_info["form_url"]])
            if len(prows) > 1:
                t = Table(prows, colWidths=[1.5*inch, 5*inch])
                t.setStyle(TableStyle([
                    ("BACKGROUND",    (0,0), (-1,0), NAVY),
                    ("TEXTCOLOR",     (0,0), (-1,0), colors.white),
                    ("FONTNAME",      (0,0), (-1,0), "Helvetica-Bold"),
                    ("FONTSIZE",      (0,0), (-1,-1), 8),
                    ("ROWBACKGROUNDS",(0,1), (-1,-1), [colors.white, LGRAY]),
                    ("GRID",          (0,0), (-1,-1), 0.4, colors.HexColor("#e2e8f0")),
                    ("VALIGN",        (0,0), (-1,-1), "TOP"),
                    ("BOTTOMPADDING", (0,0), (-1,-1), 5),
                ]))
                elems.append(t)
        else:
            elems.append(Paragraph(
                f"No cached permit data found for {city_str}, {state_str}. "
                "Visit your local building department website or use the Permits tab to look up requirements.",
                small
            ))

        # ── Notes ──────────────────────────────────────────────────────────────
        custom_notes = ov("report_notes", "")
        if custom_notes:
            elems.append(Paragraph("Additional Notes", h2))
            elems.append(Paragraph(str(custom_notes), body))

        # ── Footer ─────────────────────────────────────────────────────────────
        elems.append(Spacer(1, 20))
        elems.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#e2e8f0")))
        elems.append(Paragraph(
            "Generated by BuildAI · All cost estimates and compliance items should be verified with licensed professionals before construction.",
            caption
        ))

        doc.build(elems)
        buf.seek(0)

        proj_name = project.get("name", "report").replace(" ", "_")
        filename  = f"{proj_name}_report.pdf"
        return StreamingResponse(
            buf,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    except Exception as e:
        log.error(f"[reports] PDF generation error: {e}")
        raise HTTPException(status_code=500, detail=f"PDF generation failed: {e}")
