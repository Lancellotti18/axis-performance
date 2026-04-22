from fastapi import APIRouter, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List
from app.core.config import settings
from app.core.supabase import get_supabase
import logging, json, io, re, httpx, requests as _requests

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

class FetchFormRequest(BaseModel):
    requirements_context: str = ""  # extracted text from uploaded requirements docs


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

        # Re-verify the portal URL at response time. We only reject URLs that
        # are definitively dead (404/410) or totally unreachable. Gov sites
        # routinely return 401/403/406/429/5xx/Cloudflare challenges to bot
        # requests while serving fine to a real browser — don't flag those.
        DEAD_STATUSES = {404, 410}
        url_verified = False
        if portal_url and portal_url != jurisdiction.get("fallback_search_url"):
            try:
                async with httpx.AsyncClient(
                    timeout=10.0,
                    follow_redirects=True,
                    headers={
                        # Some gov CDNs block non-browser UAs entirely
                        "User-Agent": (
                            "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) "
                            "AppleWebKit/605.1.15 (KHTML, like Gecko) "
                            "Version/17.0 Safari/605.1.15"
                        ),
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    },
                ) as client:
                    # HEAD first (cheap); if the server rejects HEAD (405) or
                    # claims 404/410 on HEAD, do a GET before giving up.
                    try:
                        resp = await client.head(portal_url)
                        if resp.status_code in DEAD_STATUSES or resp.status_code == 405:
                            resp = await client.get(portal_url)
                    except httpx.HTTPError:
                        resp = await client.get(portal_url)
                    # Reachable unless explicitly 404/410.
                    url_verified = resp.status_code not in DEAD_STATUSES
            except Exception as verify_err:
                logger.warning(f"Portal URL verification failed for {portal_url}: {verify_err}")
                url_verified = False

        if not url_verified:
            # Drop the broken URL — frontend will show "unverified — search manually"
            portal_url = None

        return {
            "portal_url":   portal_url,
            "portal_name":  portal_name,
            "url_verified": url_verified,
            "instructions": (
                f"Visit the official {portal_name} website to submit your permit application."
                if jurisdiction.get("found") and url_verified
                else f"No verified portal found — search manually for the {city}, {state} building department."
            ),
            "source":            "jurisdiction_service",
            "submission_method": jurisdiction.get("submission_method"),
            "submission_email":  jurisdiction.get("submission_email"),
            "found":             jurisdiction.get("found", False) and url_verified,
            "fallback_search_url": jurisdiction.get("fallback_search_url") or google_fallback,
        }
    except Exception as e:
        logger.warning(f"Permit portal search failed: {e}")
        return {
            "portal_url":  None,
            "portal_name": f"{city}, {state} Building Department",
            "url_verified": False,
            "instructions": f"Search Google for the {city}, {state} building department.",
            "source": "fallback",
            "found": False,
            "fallback_search_url": google_fallback,
        }


# ── Analyze Requirements Uploads ───────────────────────────────────────────

@router.post("/analyze-requirements")
async def analyze_requirements(
    project_id: str = Form(...),
    notes: str = Form(default=""),
    files: List[UploadFile] = File(default=[]),
):
    """
    Process uploaded requirement documents (PDFs, images, screenshots) + text notes.
    Runs vision AI on each file to extract text, then uses LLM to map everything
    to standard permit field values. Returns extracted field values ready to
    pre-fill the permit form.
    """
    from app.services.llm import llm_vision, llm_text
    import asyncio

    extracted_texts: list[str] = []

    # Add user's typed notes first
    if notes.strip():
        extracted_texts.append(f"User notes:\n{notes.strip()}")

    # Process each uploaded file
    for upload in files:
        try:
            content = await upload.read()
            filename = (upload.filename or "").lower()
            content_type = (upload.content_type or "").lower()

            # PDF — render first 2 pages as images and run vision on each
            if "pdf" in content_type or filename.endswith(".pdf"):
                try:
                    import fitz  # PyMuPDF
                    doc = fitz.open(stream=content, filetype="pdf")
                    page_texts = []
                    for page_num in range(min(2, len(doc))):
                        page = doc[page_num]
                        # Try extracting text directly first (fastest)
                        text = page.get_text().strip()
                        if len(text) > 50:
                            page_texts.append(text)
                        else:
                            # Render to image and run vision AI
                            pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0))
                            img_bytes = pix.tobytes("jpeg")
                            vision_text = await llm_vision(
                                image_bytes=img_bytes,
                                media_type="image/jpeg",
                                prompt=(
                                    "Extract all text and data from this document page. "
                                    "Focus on: names, addresses, phone numbers, emails, "
                                    "parcel/APN numbers, square footage, project descriptions, "
                                    "costs, dates, license numbers. Return as plain text."
                                ),
                                max_tokens=1024,
                            )
                            page_texts.append(vision_text)
                    if page_texts:
                        extracted_texts.append(f"From {upload.filename}:\n" + "\n".join(page_texts))
                except Exception as e:
                    logger.warning(f"PDF processing failed for {upload.filename}: {e}")

            # Image (PNG, JPG, WEBP, screenshot)
            elif any(t in content_type for t in ("image/", "jpeg", "jpg", "png", "webp")):
                # Validate magic bytes
                is_jpeg = content[:2] == b'\xff\xd8'
                is_png  = content[:4] == b'\x89PNG'
                is_webp = content[8:12] == b'WEBP' if len(content) >= 12 else False
                if not (is_jpeg or is_png or is_webp):
                    continue

                mime = "image/jpeg" if is_jpeg else ("image/webp" if is_webp else "image/png")
                vision_text = await llm_vision(
                    image_bytes=content,
                    media_type=mime,
                    prompt=(
                        "Extract all text and data visible in this image. "
                        "This may be a screenshot, photo of a document, or form. "
                        "Focus on: names, addresses, phone numbers, emails, "
                        "parcel/APN numbers, square footage, costs, license numbers, "
                        "project descriptions, dates. Return as plain text."
                    ),
                    max_tokens=1024,
                )
                extracted_texts.append(f"From {upload.filename}:\n{vision_text}")

        except Exception as e:
            logger.warning(f"File processing failed for {upload.filename}: {e}")
            continue

    if not extracted_texts:
        return {"fields": {}, "summary": "No readable content found in uploaded files."}

    combined_text = "\n\n---\n\n".join(extracted_texts)

    # Use LLM to map extracted text to permit field values
    mapping_prompt = f"""You are extracting permit application data from uploaded documents.

EXTRACTED CONTENT FROM DOCUMENTS:
{combined_text[:6000]}

Map the above content to these standard permit form fields. Return ONLY a JSON object
with the field keys below and the extracted values (leave as empty string "" if not found):

{{
  "owner_name": "",
  "owner_phone": "",
  "owner_email": "",
  "owner_address": "",
  "property_address": "",
  "apn_number": "",
  "legal_description": "",
  "zoning_district": "",
  "city": "",
  "state": "",
  "zip_code": "",
  "contractor_name": "",
  "license_number": "",
  "contractor_phone": "",
  "contractor_email": "",
  "contractor_address": "",
  "project_name": "",
  "project_description": "",
  "total_sqft": "",
  "estimated_cost": "",
  "num_bedrooms": "",
  "num_bathrooms": "",
  "start_date": "",
  "completion_date": ""
}}

Rules:
- Extract EXACT values from the documents — do not guess or fabricate
- For costs, include the $ sign and commas (e.g. "$125,000")
- For addresses, include full address string
- Return only the JSON object, no markdown"""

    try:
        result_text = await llm_text(mapping_prompt, max_tokens=1024)
        result_text = result_text.strip()
        result_text = result_text[result_text.find("{"):result_text.rfind("}") + 1]
        fields = json.loads(result_text)
        # Strip empty values
        fields = {k: v for k, v in fields.items() if v and str(v).strip()}
    except Exception as e:
        logger.warning(f"Field mapping LLM failed: {e}")
        fields = {}

    return {
        "fields": fields,
        "raw_text": combined_text[:2000],  # For debugging
        "files_processed": len([f for f in files if f.filename]),
        "summary": f"Extracted {len(fields)} field values from {len(extracted_texts)} source(s).",
    }


# ── Fetch & Analyze Form ────────────────────────────────────────────────────

@router.post("/fetch-form/{project_id}")
async def fetch_permit_form(project_id: str, body: FetchFormRequest = FetchFormRequest()):
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
        logger.debug("contractor profile lookup failed", exc_info=True)
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

    # Base prefill from project + contractor data
    project_name = proj.get("name") or ""
    base_data = {
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
    }

    # If requirements context was provided (parsed from uploaded docs), use it to
    # parse additional fields. Requirements data overrides generic project defaults.
    if body.requirements_context:
        try:
            req_fields = json.loads(body.requirements_context)
            if isinstance(req_fields, dict):
                # Requirements fields take priority — they come from actual uploaded documents
                base_data = {**base_data, **{k: v for k, v in req_fields.items() if v}}
        except Exception:
            logger.debug("requirements_context parse failed, using base project data", exc_info=True)
            pass

    filled = _prefill_fields(raw_fields, base_data)

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
                        logger.debug("permit form candidate fetch failed, trying next URL", exc_info=True)
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


# ── Requirement Attachments ────────────────────────────────────────────────
#
# Supabase Storage bucket `permit-attachments` must exist (create it in the
# Supabase dashboard if not yet provisioned). RLS on the bucket:
#   (bucket_id = 'permit-attachments' AND
#    (storage.foldername(name))[1]::uuid IN
#       (SELECT id::text::uuid FROM projects WHERE user_id = auth.uid()))
# Storage layout: permit-attachments/{project_id}/{index}-{filename}

ATTACHMENT_BUCKET = "permit-attachments"
ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024  # 20 MB
ALLOWED_ATTACHMENT_TYPES = {
    "application/pdf",
    "image/jpeg",
    "image/png",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


class RequirementTextBody(BaseModel):
    index: int
    text: str


def _sniff_attachment_kind(content: bytes, declared_ct: str) -> Optional[str]:
    """Return a canonical content-type iff the magic bytes match an allowed
    format. None means the file is rejected. Never trust the client header —
    CLAUDE.md: validate file type by magic bytes."""
    if len(content) < 4:
        return None
    # PDF
    if content[:4] == b"%PDF":
        return "application/pdf"
    # JPEG
    if content[:2] == b"\xff\xd8":
        return "image/jpeg"
    # PNG
    if content[:4] == b"\x89PNG":
        return "image/png"
    # DOCX / DOC — both are allowed. DOCX is a ZIP (PK\x03\x04); legacy DOC
    # uses the OLE2 compound-document header D0 CF 11 E0.
    if content[:4] == b"PK\x03\x04" and \
       declared_ct == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    if content[:4] == b"\xd0\xcf\x11\xe0" and declared_ct == "application/msword":
        return "application/msword"
    return None


def _safe_attachment_filename(name: str) -> str:
    # Strip path separators and anything weird so the storage key stays clean.
    name = (name or "file").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return re.sub(r"[^\w.\-]", "_", name)[:180] or "file"


def _delete_storage_blob_safe(db, storage_path: str) -> None:
    try:
        db.storage.from_(ATTACHMENT_BUCKET).remove([storage_path])
    except Exception:
        logger.debug("permit-attachments: storage remove failed for %s", storage_path, exc_info=True)


@router.post("/{project_id}/requirements/upload")
async def upload_requirement_attachment(
    project_id: str,
    index: int = Form(...),
    file: UploadFile = File(...),
):
    """Upload a document for a specific permit-requirement slot. Replaces any
    prior file or text attachment at the same (project_id, index)."""
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(content) > ATTACHMENT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 20 MB limit")

    declared_ct = (file.content_type or "").lower()
    if declared_ct not in ALLOWED_ATTACHMENT_TYPES:
        raise HTTPException(status_code=415, detail=f"Unsupported content type: {declared_ct}")

    sniffed = _sniff_attachment_kind(content, declared_ct)
    if not sniffed:
        raise HTTPException(status_code=415, detail="File contents do not match an allowed format")

    safe_name = _safe_attachment_filename(file.filename or "attachment")
    storage_path = f"{project_id}/{index}-{safe_name}"

    db = get_supabase()

    # Wipe any existing attachment at this slot so the unique constraint
    # and Storage don't end up with stale rows/blobs.
    try:
        existing = (
            db.table("permit_attachments")
            .select("id, kind, storage_path")
            .eq("project_id", project_id)
            .eq("requirement_index", index)
            .limit(1)
            .execute()
        )
        if existing.data:
            prior = existing.data[0]
            if prior.get("kind") == "file" and prior.get("storage_path"):
                _delete_storage_blob_safe(db, prior["storage_path"])
            db.table("permit_attachments").delete().eq("id", prior["id"]).execute()
    except Exception:
        logger.debug("permit-attachments: prior-row cleanup failed", exc_info=True)

    # Upload to Supabase Storage
    try:
        db.storage.from_(ATTACHMENT_BUCKET).upload(
            storage_path,
            content,
            {"content-type": sniffed, "upsert": "true"},
        )
    except Exception as e:
        logger.warning("permit-attachments: storage upload failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Storage upload failed: {e}")

    row = {
        "project_id":        project_id,
        "requirement_index": index,
        "kind":              "file",
        "filename":          safe_name,
        "content_type":      sniffed,
        "size_bytes":        len(content),
        "storage_path":      storage_path,
        "text_value":        None,
    }
    try:
        result = db.table("permit_attachments").insert(row).execute()
        return result.data[0] if result.data else row
    except Exception as e:
        # Roll back the storage write so we don't orphan the blob.
        _delete_storage_blob_safe(db, storage_path)
        logger.warning("permit-attachments: DB insert failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Failed to record attachment: {e}")


@router.post("/{project_id}/requirements/text")
async def save_requirement_text(project_id: str, body: RequirementTextBody):
    """Save typed-in documentation for a requirement slot (e.g. contractor
    fills in a narrative rather than uploading a doc)."""
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is empty")
    if len(text) > 20000:
        raise HTTPException(status_code=413, detail="Text exceeds 20,000 character limit")

    db = get_supabase()

    # If a file exists at this slot, drop the blob before upsert replaces the row.
    try:
        existing = (
            db.table("permit_attachments")
            .select("id, kind, storage_path")
            .eq("project_id", project_id)
            .eq("requirement_index", body.index)
            .limit(1)
            .execute()
        )
        if existing.data and existing.data[0].get("kind") == "file":
            sp = existing.data[0].get("storage_path")
            if sp:
                _delete_storage_blob_safe(db, sp)
    except Exception:
        logger.debug("permit-attachments: text upsert cleanup failed", exc_info=True)

    row = {
        "project_id":        project_id,
        "requirement_index": body.index,
        "kind":              "text",
        "filename":          None,
        "content_type":      None,
        "size_bytes":        None,
        "storage_path":      None,
        "text_value":        text,
    }
    try:
        result = db.table("permit_attachments").upsert(
            row, on_conflict="project_id,requirement_index",
        ).execute()
        return result.data[0] if result.data else row
    except Exception as e:
        logger.warning("permit-attachments: text upsert failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Failed to save text: {e}")


@router.get("/{project_id}/attachments")
async def list_requirement_attachments(project_id: str):
    """Return every attachment row for a project, ordered by requirement_index."""
    db = get_supabase()
    try:
        result = (
            db.table("permit_attachments")
            .select("*")
            .eq("project_id", project_id)
            .order("requirement_index")
            .execute()
        )
        return result.data or []
    except Exception as e:
        logger.warning("permit-attachments: list failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Failed to list attachments: {e}")


@router.delete("/{project_id}/requirements/{index}/attachment")
async def delete_requirement_attachment(project_id: str, index: int):
    """Delete the attachment (file or text) for a requirement slot."""
    db = get_supabase()
    try:
        existing = (
            db.table("permit_attachments")
            .select("id, kind, storage_path")
            .eq("project_id", project_id)
            .eq("requirement_index", index)
            .limit(1)
            .execute()
        )
        if not existing.data:
            return {"ok": True, "deleted": 0}
        row = existing.data[0]
        if row.get("kind") == "file" and row.get("storage_path"):
            _delete_storage_blob_safe(db, row["storage_path"])
        db.table("permit_attachments").delete().eq("id", row["id"]).execute()
        return {"ok": True, "deleted": 1}
    except Exception as e:
        logger.warning("permit-attachments: delete failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Failed to delete attachment: {e}")


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

    # Load requirement attachments so we can render a reference section in the
    # generated PDF. Overlay path doesn't get the attachments list — the real
    # form has its own layout and we shouldn't paint over it.
    attachments: list = []
    try:
        db = get_supabase()
        att_r = (
            db.table("permit_attachments")
            .select("*")
            .eq("project_id", project_id)
            .order("requirement_index")
            .execute()
        )
        attachments = att_r.data or []
    except Exception as e:
        logger.debug("permit-attachments: load for PDF failed: %s", e, exc_info=True)

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
    pdf_bytes = _generate_clean_pdf(fields, project_id, attachments=attachments)
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


def _generate_clean_pdf(fields: list, project_id: str, attachments: Optional[list] = None) -> bytes:
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

    # ── Attached Documentation section ──────────────────────────────────────
    # Listed as references only — we don't merge PDFs/images into this doc.
    # Reviewers pull the actual files via /permits/{project_id}/attachments.
    if attachments:
        story.append(Spacer(1, 20))
        story.append(Paragraph("Attached Documentation", section_style))
        story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#dbeafe"), spaceAfter=8))

        att_rows = []
        for att in attachments:
            idx = att.get("requirement_index")
            req_label = f"Requirement #{idx}" if idx is not None else "Requirement"
            if att.get("kind") == "file":
                fname = att.get("filename") or "attachment"
                size_kb = int((att.get("size_bytes") or 0) / 1024)
                detail = f"{fname} ({size_kb} KB)" if size_kb else fname
            else:
                text_preview = (att.get("text_value") or "").strip().replace("\n", " ")
                if len(text_preview) > 200:
                    text_preview = text_preview[:200] + "…"
                detail = f"(typed) {text_preview}" if text_preview else "(typed)"
            att_rows.append([
                Paragraph(req_label, label_style),
                Paragraph(detail, value_style),
            ])

        if att_rows:
            att_tbl = Table(att_rows, colWidths=[1.5*inch, 5.5*inch])
            att_tbl.setStyle(TableStyle([
                ("VALIGN", (0,0), (-1,-1), "TOP"),
                ("LEFTPADDING", (0,0), (-1,-1), 0),
                ("RIGHTPADDING", (0,0), (-1,-1), 6),
                ("BOTTOMPADDING", (0,0), (-1,-1), 4),
            ]))
            story.append(att_tbl)

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
        logger.debug("contractor profile lookup failed", exc_info=True)
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
            logger.debug("scene_data.json load failed", exc_info=True)
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
