from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List
from app.core.config import settings
from app.core.supabase import get_supabase
import logging, json, io, requests as _requests

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Models ─────────────────────────────────────────────────────────────────

class PermitField(BaseModel):
    key: str
    label: str
    value: str = ""
    field_type: str = "text"   # text | date | checkbox | signature
    required: bool = True
    section: str = "General"
    x: Optional[float] = None  # PDF coordinate (points from bottom-left)
    y: Optional[float] = None
    page: int = 0

class GeneratePDFRequest(BaseModel):
    fields: List[PermitField]
    form_url: Optional[str] = None
    use_web_form: bool = False   # True = generate clean web-style PDF, False = overlay on original


# ── Portal Search (existing) ────────────────────────────────────────────────

@router.get("/portal-search")
async def search_permit_portal(
    city: str = Query(...),
    state: str = Query(...),
    project_type: str = Query(default="residential"),
):
    """Search for the official building permit portal for a city using LLM-assisted URL selection."""
    from app.services.jurisdiction_service import detect_jurisdiction
    import asyncio

    google_fallback = (
        f"https://www.google.com/search?q="
        f"{city.replace(' ', '+')}+{state}+building+permit+application+official"
    )

    try:
        # Run jurisdiction detection in a thread (it uses sync requests internally)
        jurisdiction = await asyncio.to_thread(
            detect_jurisdiction, city, state, project_type=project_type
        )

        portal_url  = jurisdiction.get("gov_url") or jurisdiction.get("fallback_search_url")
        portal_name = jurisdiction.get("authority_name") or f"{city}, {state} Building Department"

        return {
            "portal_url":   portal_url,
            "portal_name":  portal_name,
            "instructions": (
                f"Visit the official {portal_name} website to submit your permit application."
                if jurisdiction.get("found")
                else f"No verified portal found — use the search link to locate the {city}, {state} building department."
            ),
            "source":            "jurisdiction_service",
            "submission_method": jurisdiction.get("submission_method"),
            "submission_email":  jurisdiction.get("submission_email"),
            "found":             jurisdiction.get("found", False),
        }
    except Exception as e:
        logger.warning(f"Permit portal search failed: {e}")
        return {
            "portal_url":  google_fallback,
            "portal_name": f"{city}, {state} Building Department",
            "instructions": f"Search Google for the {city}, {state} building department.",
            "source": "fallback",
            "found": False,
        }


# ── Fetch & Analyze Form ────────────────────────────────────────────────────

@router.post("/fetch-form/{project_id}")
async def fetch_permit_form(project_id: str):
    """
    1. Load project data (city, state, sqft, type, estimate).
    2. Check permit_form_cache for this city/state/type.
    3. If not cached: Tavily → find PDF form URL → download → Claude Vision extracts fields.
    4. Return fields pre-filled with known project data.
    """
    db = get_supabase()

    # Load project
    proj = db.table("projects").select("*").eq("id", project_id).single().execute().data
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")

    city = proj.get("city") or ""
    state = (proj.get("region") or "US-TX").replace("US-", "")
    project_type = proj.get("blueprint_type") or "residential"
    region = proj.get("region") or "US-TX"

    if not city:
        raise HTTPException(status_code=400, detail="Project has no city set. Please update your project with the full city name.")

    # Load estimate for cost
    est_row = db.table("cost_estimates").select("grand_total, labor_hours").eq("project_id", project_id).limit(1).execute()
    est = est_row.data[0] if est_row.data else {}

    # Load analysis for sqft
    bp = db.table("blueprints").select("id").eq("project_id", project_id).limit(1).execute()
    total_sqft = 0
    if bp.data:
        an = db.table("analyses").select("total_sqft").eq("blueprint_id", bp.data[0]["id"]).limit(1).execute()
        if an.data:
            total_sqft = an.data[0].get("total_sqft") or 0

    # Load contractor profile for auto-fill
    contractor = {}
    try:
        user_id = proj.get("user_id")
        if user_id:
            cp = db.table("contractor_profiles").select("*").eq("user_id", user_id).limit(1).execute()
            if cp.data:
                contractor = cp.data[0]
    except Exception:
        pass

    # Jurisdiction detection — only proceed with verified .gov source
    from app.services.jurisdiction_service import detect_jurisdiction
    jurisdiction = detect_jurisdiction(city, state, project_type=project_type)

    # Check cache
    cache = db.table("permit_form_cache") \
        .select("*") \
        .eq("city", city) \
        .eq("state", state) \
        .eq("project_type", project_type) \
        .limit(1).execute()

    form_url = None
    raw_fields = None

    if cache.data and cache.data[0].get("form_fields"):
        form_url = cache.data[0].get("form_url") or jurisdiction.get("permit_form_url")
        raw_fields = cache.data[0]["form_fields"]
    else:
        # Use jurisdiction-validated form URL if available
        gov_form_url = jurisdiction.get("permit_form_url")
        form_url, raw_fields = _find_and_analyze_form(
            city, state, project_type, gov_form_url=gov_form_url
        )
        # Cache it
        try:
            db.table("permit_form_cache").upsert({
                "city": city, "state": state, "project_type": project_type,
                "form_url": form_url, "form_fields": raw_fields,
            }, on_conflict="city,state,project_type").execute()
        except Exception as e:
            logger.warning(f"Cache upsert failed: {e}")

    # Pre-fill known values
    project_name = proj.get("name") or ""
    filled = _prefill_fields(raw_fields, {
        "project_name":     project_name,
        "city":             city,
        "state":            state,
        "zip_code":         proj.get("zip_code") or "",
        "region":           region,
        "project_type":     project_type,
        "total_sqft":       str(int(total_sqft)) if total_sqft else "",
        "estimated_cost":   f"${int(est.get('grand_total', 0)):,}" if est.get("grand_total") else "",
        "labor_hours":      str(int(est.get("labor_hours", 0))) if est.get("labor_hours") else "",
        "contractor_name":  contractor.get("company_name") or "",
        "license_number":   contractor.get("license_number") or "",
        "contractor_phone": contractor.get("phone") or "",
        "contractor_email": contractor.get("email") or "",
        "contractor_address": contractor.get("address") or "",
        "contractor_city":  contractor.get("city") or "",
        "contractor_state": contractor.get("state") or "",
        "contractor_zip":   contractor.get("zip_code") or "",
    })

    return {
        "form_url": form_url,
        "city": city,
        "state": state,
        "project_type": project_type,
        "fields": filled,
        "jurisdiction": {
            "found": jurisdiction.get("found", False),
            "authority_name": jurisdiction.get("authority_name"),
            "authority_type": jurisdiction.get("authority_type"),
            "gov_url": jurisdiction.get("gov_url"),
            "submission_method": jurisdiction.get("submission_method", "unknown"),
            "submission_email": jurisdiction.get("submission_email"),
            "error": jurisdiction.get("error"),
            "fallback_search_url": jurisdiction.get("fallback_search_url"),
        },
    }


def _find_and_analyze_form(city: str, state: str, project_type: str, gov_form_url: str = None):
    """Use Tavily to find the PDF form, then LLM Vision to extract all fields."""
    form_url = None
    pdf_bytes = None

    # Prefer jurisdiction-validated gov URL
    if gov_form_url:
        try:
            resp = _requests.get(gov_form_url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
            if resp.status_code == 200 and (b"%PDF" in resp.content[:8] or "pdf" in resp.headers.get("content-type", "")):
                form_url = gov_form_url
                pdf_bytes = resp.content
        except Exception as e:
            logger.warning(f"Gov form URL fetch failed: {e}")

    if settings.TAVILY_API_KEY:
        try:
            from tavily import TavilyClient
            client = TavilyClient(api_key=settings.TAVILY_API_KEY)
            query = f"{city} {state} {project_type} building permit application form PDF fillable download"
            results = client.search(query=query, search_depth="advanced", max_results=8)
            for r in results.get("results", []):
                url = r.get("url", "")
                if url.lower().endswith(".pdf") or "permit" in url.lower() and (".pdf" in url.lower() or "form" in url.lower() or "application" in url.lower()):
                    try:
                        resp = _requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
                        if resp.status_code == 200 and (resp.headers.get("content-type", "").startswith("application/pdf") or resp.content[:4] == b"%PDF"):
                            form_url = url
                            pdf_bytes = resp.content
                            break
                    except Exception:
                        continue
        except Exception as e:
            logger.warning(f"Tavily form search failed: {e}")

    # If we have a PDF, use Claude Vision to extract fields
    if pdf_bytes and settings.ANTHROPIC_API_KEY:
        try:
            fields = _extract_fields_claude(pdf_bytes, city, state, project_type)
            if fields:
                return form_url, fields
        except Exception as e:
            logger.warning(f"Claude field extraction failed: {e}")

    # Fallback: return standard fields for this location + project type
    return form_url, _standard_fields(city, state, project_type)


def _extract_fields_claude(pdf_bytes: bytes, city: str, state: str, project_type: str) -> list:
    """Use LLM Vision to extract all form fields from the permit PDF."""
    import fitz  # PyMuPDF
    from app.services.llm import llm_vision_sync

    # Render first page as image — one image keeps token usage reasonable
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    page = doc[0]
    mat = fitz.Matrix(2.0, 2.0)
    pix = page.get_pixmap(matrix=mat)
    img_bytes = pix.tobytes("jpeg")

    prompt = f"""This is a {project_type} building permit application form for {city}, {state}.

Extract EVERY form field visible in this document. For each field return:
- key: snake_case identifier (e.g. property_address, apn_number, owner_name)
- label: exact label text from the form
- field_type: "text", "date", "checkbox", or "signature"
- required: true if marked required or is a standard required field
- section: the section/group heading this field falls under (e.g. "Property Information", "Owner Information", "Contractor Information", "Project Details", "Signatures")

Return ONLY a JSON array. Example:
[
  {{"key": "property_address", "label": "Property Address", "field_type": "text", "required": true, "section": "Property Information"}},
  {{"key": "apn_number", "label": "APN / Parcel Number", "field_type": "text", "required": true, "section": "Property Information"}}
]

Be thorough — capture every blank line, checkbox, signature line, and date field."""

    text = llm_vision_sync(img_bytes, "image/jpeg", prompt, max_tokens=4096)
    text = text.strip()
    if "```" in text:
        start = text.find("[")
        end = text.rfind("]") + 1
        text = text[start:end]
    return json.loads(text)


def _standard_fields(city: str, state: str, project_type: str) -> list:
    """Standard permit fields when we can't find the real form."""
    base = [
        # Property Information
        {"key": "property_address",   "label": "Property Address",              "field_type": "text",      "required": True,  "section": "Property Information"},
        {"key": "apn_number",         "label": "APN / Parcel Number",           "field_type": "text",      "required": True,  "section": "Property Information"},
        {"key": "legal_description",  "label": "Legal Description",             "field_type": "text",      "required": False, "section": "Property Information"},
        {"key": "zoning_district",    "label": "Zoning District",               "field_type": "text",      "required": False, "section": "Property Information"},
        {"key": "city",               "label": "City",                          "field_type": "text",      "required": True,  "section": "Property Information"},
        {"key": "state",              "label": "State",                         "field_type": "text",      "required": True,  "section": "Property Information"},
        {"key": "zip_code",           "label": "ZIP Code",                      "field_type": "text",      "required": True,  "section": "Property Information"},
        # Owner Information
        {"key": "owner_name",         "label": "Property Owner Name",           "field_type": "text",      "required": True,  "section": "Owner Information"},
        {"key": "owner_phone",        "label": "Owner Phone",                   "field_type": "text",      "required": True,  "section": "Owner Information"},
        {"key": "owner_email",        "label": "Owner Email",                   "field_type": "text",      "required": False, "section": "Owner Information"},
        {"key": "owner_address",      "label": "Owner Mailing Address",         "field_type": "text",      "required": False, "section": "Owner Information"},
        # Contractor Information
        {"key": "contractor_name",    "label": "Contractor / Company Name",     "field_type": "text",      "required": True,  "section": "Contractor Information"},
        {"key": "license_number",     "label": "Contractor License Number",     "field_type": "text",      "required": True,  "section": "Contractor Information"},
        {"key": "contractor_phone",   "label": "Contractor Phone",              "field_type": "text",      "required": True,  "section": "Contractor Information"},
        {"key": "contractor_email",   "label": "Contractor Email",              "field_type": "text",      "required": False, "section": "Contractor Information"},
        {"key": "contractor_address", "label": "Contractor Address",            "field_type": "text",      "required": False, "section": "Contractor Information"},
        # Project Details
        {"key": "project_name",       "label": "Project / Job Name",            "field_type": "text",      "required": True,  "section": "Project Details"},
        {"key": "project_type",       "label": "Project Type",                  "field_type": "text",      "required": True,  "section": "Project Details"},
        {"key": "project_description","label": "Description of Work",           "field_type": "text",      "required": True,  "section": "Project Details"},
        {"key": "total_sqft",         "label": "Total Square Footage",          "field_type": "text",      "required": True,  "section": "Project Details"},
        {"key": "estimated_cost",     "label": "Estimated Cost of Construction","field_type": "text",      "required": True,  "section": "Project Details"},
        {"key": "start_date",         "label": "Proposed Start Date",           "field_type": "date",      "required": False, "section": "Project Details"},
        {"key": "completion_date",    "label": "Estimated Completion Date",     "field_type": "date",      "required": False, "section": "Project Details"},
        # Signatures
        {"key": "owner_signature",    "label": "Owner Signature",               "field_type": "signature", "required": True,  "section": "Signatures"},
        {"key": "sign_date",          "label": "Date",                          "field_type": "date",      "required": True,  "section": "Signatures"},
    ]
    # Add new-construction specific fields
    if project_type == "residential":
        base.insert(-2, {"key": "num_bedrooms", "label": "Number of Bedrooms", "field_type": "text", "required": False, "section": "Project Details"})
        base.insert(-2, {"key": "num_bathrooms","label": "Number of Bathrooms","field_type": "text", "required": False, "section": "Project Details"})
    return base


def _prefill_fields(raw_fields: list, data: dict) -> list:
    """Map known project data onto form fields. Each field gets a 'status' key."""
    KEY_MAP = {
        "city":               data.get("city", ""),
        "state":              data.get("state", ""),
        "zip_code":           data.get("zip_code", ""),
        "project_name":       data.get("project_name", ""),
        "project_type":       data.get("project_type", "").capitalize(),
        "project_description": f"{data.get('project_type','').capitalize()} construction — {data.get('total_sqft','')} sq ft" if data.get('total_sqft') else data.get('project_type','').capitalize() + " construction",
        "total_sqft":         data.get("total_sqft", ""),
        "estimated_cost":     data.get("estimated_cost", ""),
        "region":             data.get("region", ""),
        "contractor_name":    data.get("contractor_name", ""),
        "license_number":     data.get("license_number", ""),
        "contractor_phone":   data.get("contractor_phone", ""),
        "contractor_email":   data.get("contractor_email", ""),
        "contractor_address": data.get("contractor_address", ""),
        "contractor_city":    data.get("contractor_city", ""),
        "contractor_state":   data.get("contractor_state", ""),
        "contractor_zip":     data.get("contractor_zip", ""),
    }
    result = []
    for f in raw_fields:
        field = dict(f)
        auto_value = KEY_MAP.get(field.get("key", ""), "")
        field["value"] = auto_value
        # Status: auto_filled | needs_input
        if auto_value:
            field["status"] = "auto_filled"
        elif field.get("required"):
            field["status"] = "needs_input"
        else:
            field["status"] = "optional"
        result.append(field)
    return result


# ── Generate PDF ────────────────────────────────────────────────────────────

@router.post("/generate-pdf/{project_id}")
async def generate_permit_pdf(project_id: str, payload: GeneratePDFRequest):
    """
    Fill the permit form fields and return a PDF.
    - If form_url provided and use_web_form=False: download original PDF, overlay values
    - Otherwise: generate a clean professional PDF with reportlab
    """
    fields = payload.fields
    form_url = payload.form_url
    use_web_form = payload.use_web_form

    # Try to overlay on the real form first
    if form_url and not use_web_form:
        try:
            pdf_bytes = _overlay_on_original(form_url, fields)
            return StreamingResponse(
                io.BytesIO(pdf_bytes),
                media_type="application/pdf",
                headers={"Content-Disposition": "attachment; filename=permit_application.pdf"},
            )
        except Exception as e:
            logger.warning(f"PDF overlay failed, falling back to generated form: {e}")

    # Generate clean PDF with reportlab
    pdf_bytes = _generate_clean_pdf(fields, project_id)
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=permit_application.pdf"},
    )


def _overlay_on_original(form_url: str, fields: list) -> bytes:
    """Download original PDF and overlay filled values using PyMuPDF."""
    import fitz

    resp = _requests.get(form_url, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    pdf_bytes = resp.content

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")

    # Try AcroForm filling first
    filled_any = False
    for page in doc:
        for widget in page.widgets() or []:
            for field in fields:
                if field.key.lower() in (widget.field_name or "").lower() or \
                   field.label.lower() in (widget.field_name or "").lower():
                    if field.value and widget.field_type_string in ("Text", "TextMultiLine"):
                        widget.field_value = field.value
                        widget.update()
                        filled_any = True

    if not filled_any:
        # Flat PDF — use text search to find field positions and overlay
        # Group fields by section for layout
        field_map = {f.key: f.value for f in fields if f.value}
        page = doc[0]
        for field in fields:
            if not field.value:
                continue
            # Search for the label text in the PDF and write value near it
            areas = page.search_for(field.label)
            if areas:
                rect = areas[0]
                # Write value to the right of the label
                insert_pt = fitz.Point(rect.x1 + 5, rect.y1 + 10)
                page.insert_text(insert_pt, field.value, fontsize=9, color=(0, 0, 0.6))

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _generate_clean_pdf(fields: list, project_id: str) -> bytes:
    """Generate a professional permit application PDF using reportlab."""
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
    from reportlab.lib.enums import TA_CENTER, TA_LEFT

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter,
                            leftMargin=0.75*inch, rightMargin=0.75*inch,
                            topMargin=0.75*inch, bottomMargin=0.75*inch)

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("Title", parent=styles["Heading1"], fontSize=16, spaceAfter=4, alignment=TA_CENTER, textColor=colors.HexColor("#1e3a5f"))
    subtitle_style = ParagraphStyle("Sub", parent=styles["Normal"], fontSize=10, spaceAfter=12, alignment=TA_CENTER, textColor=colors.HexColor("#64748b"))
    section_style = ParagraphStyle("Section", parent=styles["Heading2"], fontSize=11, spaceBefore=14, spaceAfter=6, textColor=colors.HexColor("#2563eb"), borderPad=4)
    label_style = ParagraphStyle("Label", parent=styles["Normal"], fontSize=8, textColor=colors.HexColor("#64748b"), spaceAfter=1)
    value_style = ParagraphStyle("Value", parent=styles["Normal"], fontSize=10, textColor=colors.HexColor("#1e293b"), spaceAfter=8)
    empty_style = ParagraphStyle("Empty", parent=styles["Normal"], fontSize=10, textColor=colors.HexColor("#94a3b8"), spaceAfter=8)

    story = []

    # Header
    story.append(Paragraph("Building Permit Application", title_style))
    # Get city/state from fields
    city_field = next((f for f in fields if f.key == "city"), None)
    state_field = next((f for f in fields if f.key == "state"), None)
    city_str = city_field.value if city_field and city_field.value else ""
    state_str = state_field.value if state_field and state_field.value else ""
    if city_str or state_str:
        story.append(Paragraph(f"{city_str}{', ' if city_str and state_str else ''}{state_str} Building Department", subtitle_style))
    story.append(HRFlowable(width="100%", thickness=2, color=colors.HexColor("#2563eb"), spaceAfter=16))

    # Group by section
    sections: dict = {}
    for f in fields:
        sec = f.section or "General"
        if sec not in sections:
            sections[sec] = []
        sections[sec].append(f)

    for section_name, section_fields in sections.items():
        story.append(Paragraph(section_name, section_style))
        story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#dbeafe"), spaceAfter=8))

        # Two-column layout for short fields
        rows = []
        col_fields = [f for f in section_fields if f.field_type not in ("signature",)]
        sig_fields = [f for f in section_fields if f.field_type == "signature"]

        i = 0
        while i < len(col_fields):
            left = col_fields[i]
            right = col_fields[i+1] if i+1 < len(col_fields) else None

            def make_cell(f):
                items = [Paragraph(f.label + (" *" if f.required else ""), label_style)]
                if f.value:
                    items.append(Paragraph(f.value, value_style))
                else:
                    items.append(Paragraph("_" * 35, empty_style))
                return items

            left_cell = make_cell(left)
            right_cell = make_cell(right) if right else [""]

            rows.append([left_cell, right_cell])
            i += 2

        if rows:
            tbl = Table(rows, colWidths=[3.5*inch, 3.5*inch])
            tbl.setStyle(TableStyle([
                ("VALIGN", (0,0), (-1,-1), "TOP"),
                ("LEFTPADDING", (0,0), (-1,-1), 0),
                ("RIGHTPADDING", (0,0), (-1,-1), 12),
                ("BOTTOMPADDING", (0,0), (-1,-1), 6),
            ]))
            story.append(tbl)

        # Signatures full-width
        for f in sig_fields:
            story.append(Spacer(1, 16))
            story.append(Paragraph(f.label + (" *" if f.required else ""), label_style))
            story.append(HRFlowable(width="60%", thickness=1, color=colors.HexColor("#1e293b"), spaceAfter=4))
            story.append(Paragraph("Signature", empty_style))

    doc.build(story)
    return buf.getvalue()


@router.post("/package/{project_id}")
async def generate_permit_package(project_id: str):
    """
    Generate a complete permit package ZIP containing:
      01_permit_application.pdf   — pre-filled with real project + contractor data
      02_site_plan_summary.pdf    — dimensions from Claude Vision blueprint parse
      03_material_specifications.pdf — material list with live prices
      04_contractor_certification.pdf — contractor license & insurance page
      jurisdiction_info.json      — real requirements from building dept website

    All data sourced from:
    - Project record (Supabase)
    - Contractor profile (Supabase)
    - AXIS pipeline outputs (Claude Vision parse + live pricing)
    - Tavily search of official .gov building department websites
    """
    import json as _json
    db = get_supabase()

    # Load project
    proj_r = db.table("projects").select("*").eq("id", project_id).limit(1).execute()
    if not proj_r.data:
        raise HTTPException(status_code=404, detail="Project not found")
    project = proj_r.data[0]

    state_label = (project.get("region") or "").replace("US-", "")
    project_dict = {
        **project,
        "state": state_label,
        "address": project.get("address", f"{project.get('city', '')} {state_label}".strip()),
    }

    # Load contractor profile
    contractor = {}
    try:
        user_id = project.get("user_id", "")
        if user_id:
            cp = db.table("contractor_profiles").select("*").eq("user_id", user_id).limit(1).execute()
            if cp.data:
                contractor = cp.data[0]
    except Exception:
        pass

    # Load materials + pricing (AXIS first, estimator fallback)
    from app.api.v1.proposals import _load_materials_and_pricing
    materials, pricing_data = _load_materials_and_pricing(project_id, db)

    # Load scene_data (Claude Vision parse)
    scene_data = None
    axis_dir = os.path.join(os.environ.get("AXIS_OUTPUT_DIR", "/tmp/axis_outputs"), project_id)
    scene_path = os.path.join(axis_dir, "scene_data.json")
    if os.path.exists(scene_path):
        try:
            with open(scene_path) as f:
                scene_data = _json.load(f)
        except Exception:
            pass

    project_type = (project.get("blueprint_type") or "residential").lower()

    from app.services.permit_package_service import generate_permit_package as _gen_pkg
    zip_bytes = _gen_pkg(
        project=project_dict,
        contractor=contractor,
        materials=materials,
        pricing_data=pricing_data,
        scene_data=scene_data,
        project_type=project_type,
    )

    name_slug = project_dict.get("name", "project").lower().replace(" ", "_")
    filename = f"permit_package_{name_slug}.zip"

    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/validate-link")
async def validate_product_link(payload: dict):
    """Validate a product URL: verify it's a real product page with matching price."""
    from app.services.link_validator import validate_product_url
    url = payload.get("url", "")
    product_name = payload.get("product_name", "")
    expected_price = float(payload.get("expected_price", 0))
    result = validate_product_url(url, product_name, expected_price)
    return result
