"""PDF report generation using ReportLab."""
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet
import io


def generate_pdf_report(project: dict, analysis: dict, materials: list, costs: dict) -> bytes:
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=letter)
    styles = getSampleStyleSheet()
    elements = []

    # Title
    elements.append(Paragraph(f"BuildAI Construction Report", styles["Title"]))
    elements.append(Paragraph(f"Project: {project['name']}", styles["Heading2"]))
    elements.append(Spacer(1, 12))

    # Project summary
    elements.append(Paragraph("Project Summary", styles["Heading2"]))
    summary_data = [
        ["Total Square Footage", f"{analysis.get('total_sqft', 0):,.0f} sqft"],
        ["Number of Rooms", str(len(analysis.get("rooms", [])))],
        ["Confidence Score", f"{analysis.get('confidence', 0) * 100:.0f}%"],
        ["Region", costs.get("region", "—")],
    ]
    summary_table = Table(summary_data, colWidths=[250, 200])
    summary_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.grey),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.whitesmoke),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
    ]))
    elements.append(summary_table)
    elements.append(Spacer(1, 20))

    # Material list
    elements.append(Paragraph("Material Estimate", styles["Heading2"]))
    mat_data = [["Category", "Item", "Qty", "Unit", "Unit Cost", "Total"]]
    for m in materials:
        mat_data.append([
            m["category"].title(),
            m["item_name"],
            str(m["quantity"]),
            m["unit"],
            f"${m['unit_cost']:,.2f}",
            f"${m['total_cost']:,.2f}",
        ])
    mat_table = Table(mat_data, colWidths=[80, 160, 50, 70, 70, 80])
    mat_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e40af")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f0f4ff")]),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.grey),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
    ]))
    elements.append(mat_table)
    elements.append(Spacer(1, 20))

    # Cost breakdown
    elements.append(Paragraph("Cost Breakdown", styles["Heading2"]))
    cost_data = [
        ["Materials", f"${costs['materials_total']:,.2f}"],
        ["Labor", f"${costs['labor_total']:,.2f}"],
        ["Overhead (10%)", f"${costs['materials_total'] * 0.1:,.2f}"],
        [f"Markup ({costs['markup_pct']}%)", ""],
        ["TOTAL", f"${costs['grand_total']:,.2f}"],
    ]
    cost_table = Table(cost_data, colWidths=[300, 150])
    cost_table.setStyle(TableStyle([
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#1e40af")),
        ("TEXTCOLOR", (0, -1), (-1, -1), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.grey),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
    ]))
    elements.append(cost_table)

    doc.build(elements)
    return buffer.getvalue()


def generate_report(
    quantities: dict,
    cost_report: dict,
    schedule: dict,
    insights: dict,
    output_dir: str,
    project_name: str = "Project",
) -> str:
    """Generate a PDF report from AXIS pipeline outputs and save to output_dir/report.pdf."""
    import os

    os.makedirs(output_dir, exist_ok=True)
    out_path = os.path.join(output_dir, "report.pdf")

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=letter)
    styles = getSampleStyleSheet()
    elements = []

    meta     = quantities.get("meta", {})
    cost_sum = cost_report.get("summary", {})
    sched    = schedule or {}

    elements.append(Paragraph(f"AXIS Performance Report", styles["Title"]))
    elements.append(Paragraph(f"Project: {project_name}", styles["Heading2"]))
    elements.append(Spacer(1, 12))

    # Project metrics
    elements.append(Paragraph("Project Overview", styles["Heading2"]))
    overview_data = [
        ["Floor Area",      f"{meta.get('area_sqft', 0):,.0f} sqft"],
        ["Perimeter",       f"{meta.get('perimeter_lf', 0):,.0f} lf"],
        ["Rooms",           str(meta.get("room_count", 0))],
        ["Roof Pitch",      f"{meta.get('pitch_angle_deg', 0)}°"],
        ["Calendar Days",   str(sched.get("total_calendar_days", 0))],
        ["Working Days",    str(sched.get("total_working_days", 0))],
        ["Labor Hours",     f"{sched.get('total_labor_hours', 0):,.0f}"],
    ]
    t = Table(overview_data, colWidths=[200, 250])
    t.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.3, colors.grey),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, colors.HexColor("#f0f4ff")]),
    ]))
    elements.append(t)
    elements.append(Spacer(1, 20))

    # Cost summary
    elements.append(Paragraph("Cost Summary", styles["Heading2"]))
    cost_data = [
        ["Tier",      "Total",                                           "Per sqft"],
        ["Economy",   f"${cost_sum.get('economy_total', 0):,.0f}",       "—"],
        ["Standard",  f"${cost_sum.get('standard_total', 0):,.0f}",      f"${cost_sum.get('standard_per_sqft', 0):.0f}"],
        ["Premium",   f"${cost_sum.get('premium_total', 0):,.0f}",       "—"],
    ]
    ct = Table(cost_data, colWidths=[150, 200, 100])
    ct.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e40af")),
        ("TEXTCOLOR",  (0, 0), (-1, 0), colors.white),
        ("GRID",       (0, 0), (-1, -1), 0.3, colors.grey),
        ("FONTSIZE",   (0, 0), (-1, -1), 10),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f0f4ff")]),
    ]))
    elements.append(ct)
    elements.append(Spacer(1, 20))

    # AI insights
    if insights:
        elements.append(Paragraph("AI Insights Summary", styles["Heading2"]))
        summary_text = insights.get("project_summary", "")
        if summary_text:
            for para in summary_text.split("\n\n"):
                if para.strip():
                    elements.append(Paragraph(para.strip(), styles["Normal"]))
                    elements.append(Spacer(1, 6))

    doc.build(elements)
    pdf_bytes = buffer.getvalue()
    with open(out_path, "wb") as f:
        f.write(pdf_bytes)
    return out_path
