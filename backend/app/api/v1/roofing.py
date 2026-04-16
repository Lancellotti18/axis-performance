"""
Roofing analysis endpoints.
POST /roofing/{blueprint_id}/measure   — AI vision measurement analysis
POST /roofing/{blueprint_id}/confirm   — User confirms/adjusts measurements
GET  /roofing/{blueprint_id}/measurements — Get stored measurements
GET  /roofing/{project_id}/shingle-estimate — Calculate shingle material list
"""
import asyncio
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.core.supabase import get_supabase
from app.services.roofing_service import analyze_roof_image, calculate_shingle_materials

logger = logging.getLogger(__name__)
router = APIRouter()


class ConfirmMeasurements(BaseModel):
    total_sqft: float
    pitch: str
    facets: int
    ridges_ft: float
    valleys_ft: float
    eaves_ft: float
    rakes_ft: float
    waste_pct: float
    roof_type: Optional[str] = "unknown"
    stories: Optional[int] = 1


@router.post("/{blueprint_id}/measure")
async def measure_roof(blueprint_id: str):
    """
    Run AI vision analysis on the blueprint image to extract roof measurements.
    Saves raw (unconfirmed) measurements to the database.
    """
    db = get_supabase()

    # Get blueprint record to find the image URL
    bp = db.table("blueprints").select("*").eq("id", blueprint_id).single().execute()
    if not bp.data:
        raise HTTPException(status_code=404, detail="Blueprint not found")

    image_url = bp.data.get("file_url", "")
    if not image_url:
        raise HTTPException(status_code=422, detail="Blueprint has no associated image URL")

    # Run Claude vision analysis
    try:
        measurements = await analyze_roof_image(image_url)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Roof analysis failed: {str(e)}")

    project_id = bp.data.get("project_id", "")

    # Upsert measurements record
    record = {
        "blueprint_id": blueprint_id,
        "project_id": project_id,
        "total_sqft": measurements.get("total_sqft", 0),
        "pitch": measurements.get("pitch", "Unknown"),
        "facets": measurements.get("facets", 0),
        "ridges_ft": measurements.get("ridges_ft", 0),
        "valleys_ft": measurements.get("valleys_ft", 0),
        "eaves_ft": measurements.get("eaves_ft", 0),
        "rakes_ft": measurements.get("rakes_ft", 0),
        "waste_pct": measurements.get("waste_pct", 10),
        "roof_type": measurements.get("roof_type", "unknown"),
        "stories": measurements.get("stories", 1),
        "confidence": measurements.get("confidence", 0),
        "notes": measurements.get("notes", ""),
        "confirmed": False,
    }

    try:
        # Check if record already exists
        existing = db.table("roof_measurements").select("id").eq("blueprint_id", blueprint_id).execute()
        if existing.data:
            db.table("roof_measurements").update(record).eq("blueprint_id", blueprint_id).execute()
            record["id"] = existing.data[0]["id"]
        else:
            result = db.table("roof_measurements").insert(record).execute()
            record["id"] = result.data[0]["id"] if result.data else None
    except Exception as e:
        # Table may not exist yet — return measurements without saving
        record["db_error"] = str(e)
        record["id"] = None

    return record


@router.post("/{blueprint_id}/confirm")
async def confirm_measurements(blueprint_id: str, payload: ConfirmMeasurements):
    """
    User reviews AI measurements and confirms (or adjusts) them.
    Marks the record as confirmed so the shingle estimator can use it.
    """
    db = get_supabase()

    record = {
        "blueprint_id": blueprint_id,
        "total_sqft": payload.total_sqft,
        "pitch": payload.pitch,
        "facets": payload.facets,
        "ridges_ft": payload.ridges_ft,
        "valleys_ft": payload.valleys_ft,
        "eaves_ft": payload.eaves_ft,
        "rakes_ft": payload.rakes_ft,
        "waste_pct": payload.waste_pct,
        "roof_type": payload.roof_type,
        "stories": payload.stories,
        "confirmed": True,
    }

    try:
        existing = db.table("roof_measurements").select("id").eq("blueprint_id", blueprint_id).execute()
        if existing.data:
            db.table("roof_measurements").update(record).eq("blueprint_id", blueprint_id).execute()
        else:
            # Get project_id from blueprint
            bp = db.table("blueprints").select("project_id").eq("id", blueprint_id).single().execute()
            record["project_id"] = bp.data.get("project_id", "") if bp.data else ""
            db.table("roof_measurements").insert(record).execute()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save measurements: {str(e)}")

    return {"status": "confirmed", **record}


@router.get("/{blueprint_id}/measurements")
async def get_measurements(blueprint_id: str):
    """Get stored roof measurements for a blueprint."""
    db = get_supabase()
    try:
        result = db.table("roof_measurements").select("*").eq("blueprint_id", blueprint_id).single().execute()
        return result.data or {}
    except Exception:
        logger.debug("roof_measurements lookup failed for blueprint %s", blueprint_id, exc_info=True)
        return {}


@router.get("/project/{project_id}/shingle-estimate")
async def get_shingle_estimate(project_id: str):
    """
    Return the full roofing material list based on confirmed measurements.
    If measurements not confirmed yet, returns empty with a flag.
    """
    db = get_supabase()

    try:
        result = db.table("roof_measurements").select("*").eq("project_id", project_id).execute()
        measurements = result.data[0] if result.data else None
    except Exception:
        logger.debug("roof_measurements lookup failed for project %s", project_id, exc_info=True)
        measurements = None

    if not measurements:
        return {"ready": False, "message": "No roof measurements found. Run analysis first.", "materials": []}

    if not measurements.get("confirmed"):
        return {
            "ready": False,
            "message": "Measurements not yet confirmed. Please review and confirm the AI measurements.",
            "measurements": measurements,
            "materials": [],
        }

    materials = calculate_shingle_materials(
        total_sqft=measurements["total_sqft"],
        waste_pct=measurements["waste_pct"],
        pitch=measurements.get("pitch", "6/12"),
        ridges_ft=measurements.get("ridges_ft", 0),
        valleys_ft=measurements.get("valleys_ft", 0),
        eaves_ft=measurements.get("eaves_ft", 0),
        rakes_ft=measurements.get("rakes_ft", 0),
        stories=measurements.get("stories", 1),
    )

    total_materials_cost = sum(m["total_cost"] for m in materials)

    return {
        "ready": True,
        "measurements": measurements,
        "materials": materials,
        "total_materials_cost": round(total_materials_cost, 2),
        "squares": round(measurements["total_sqft"] / 100, 1),
    }


class AerialReportRequest(BaseModel):
    project_id: str
    address: str


class StandaloneAerialRequest(BaseModel):
    address: str  # full address including city, state, zip


class StormRiskRequest(BaseModel):
    city: str
    state: str
    zip_code: Optional[str] = ""


@router.post("/aerial-report")
async def aerial_roof_report(payload: AerialReportRequest):
    """
    Get aerial roof measurements for a property address (project-linked).
    Uses Google Solar API if configured, otherwise Tavily + Claude estimate.
    """
    from app.services.aerial_roof_service import get_aerial_roof_report
    db = get_supabase()

    proj = db.table("projects").select("city, region, zip_code").eq("id", payload.project_id).single().execute()
    if not proj.data and payload.project_id != "standalone":
        raise HTTPException(status_code=404, detail="Project not found")

    if payload.project_id == "standalone" or not proj.data:
        # Parse city/state from the address string itself
        city = ""
        state = ""
        zip_code = ""
    else:
        city = proj.data.get("city", "")
        region = proj.data.get("region", "US-TX")
        zip_code = proj.data.get("zip_code", "")
        state = region.replace("US-", "") if region else "TX"

    try:
        result = await get_aerial_roof_report(
            address=payload.address,
            city=city,
            state=state,
            zip_code=zip_code,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Aerial report failed: {e}")

    return result


@router.post("/aerial-report/standalone")
async def aerial_roof_report_standalone(payload: StandaloneAerialRequest):
    """
    Standalone aerial roof report — no project required.
    Pass the full address (street, city, state, zip) and get roof measurements.
    """
    from app.services.aerial_roof_service import get_aerial_roof_report
    addr = payload.address.strip()
    if not addr:
        raise HTTPException(status_code=422, detail="Address is required.")

    # Parse city, state, zip from the address string so the service gets
    # the same context as the project-linked endpoint.
    # Expected format: "123 Main St, Austin, TX 78701"
    import re as _re
    city = ""
    state = ""
    zip_code = ""
    # Zip: last 5-digit group
    zip_match = _re.search(r'\b(\d{5})\b', addr)
    if zip_match:
        zip_code = zip_match.group(1)
    # State: 2-letter abbreviation before or after zip
    state_match = _re.search(r',\s*([A-Z]{2})\b', addr)
    if state_match:
        state = state_match.group(1)
    # City: part before the state abbreviation
    if state_match:
        before_state = addr[:state_match.start()]
        parts = [p.strip() for p in before_state.split(',') if p.strip()]
        if len(parts) >= 2:
            city = parts[-1]

    try:
        result = await get_aerial_roof_report(
            address=addr,
            city=city,
            state=state,
            zip_code=zip_code,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Aerial report failed: {e}")
    return result


class AerialDamageRequest(BaseModel):
    satellite_image_url: str
    address: str
    lat: Optional[float] = None
    lng: Optional[float] = None


@router.post("/aerial-damage")
async def aerial_damage_analysis(payload: AerialDamageRequest):
    """
    Two-part analysis run automatically after every aerial report:
      1. AI vision: download satellite image → Claude/Gemini vision → real damage zones
      2. Weather research: web search NOAA/news for hail/wind history at this address
    Returns only what is actually found — no fabricated damage or events.
    """
    from app.services.llm import llm_vision, llm_text
    from app.services.search import web_search_multi
    import httpx, json, re as _re

    # ── 1. Download satellite image ───────────────────────────────────────────
    image_bytes = None
    media_type = "image/png"
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            r = await client.get(payload.satellite_image_url)
            r.raise_for_status()
            image_bytes = r.content
            ct = r.headers.get("content-type", "image/png")
            media_type = "image/jpeg" if ("jpeg" in ct or "jpg" in ct) else "image/png"
    except Exception as e:
        image_bytes = None

    # ── 2. Vision analysis ────────────────────────────────────────────────────
    async def run_vision() -> dict:
        if not image_bytes:
            return {"can_analyze": False, "zones": [], "overall_condition": "cannot_determine",
                    "condition_score": None, "analyst_notes": "Satellite image could not be downloaded."}
        vision_prompt = f"""You are a licensed roofing inspector analyzing a satellite aerial image.

Address: {payload.address}
Imagery: Esri World Imagery, zoom 18 (≈0.6 m/pixel resolution)

TASK: Identify any roof damage or condition issues visible in this image.

STRICT HONESTY REQUIREMENTS:
- At 0.6 m/pixel you CAN detect: large missing sections (>0.5 m), significant staining/discoloration,
  debris accumulation, sagging, large flashing gaps, severe moss/algae coverage
- You CANNOT reliably detect: individual shingle cracks, small hail marks, granule loss, minor gaps
- Report ONLY what you actually see — do NOT invent zones to appear thorough
- If the roof looks clean and undamaged, say so clearly with an empty zones array

Return ONLY valid JSON (no text outside the JSON block):
{{
  "can_analyze": true,
  "image_quality": "clear|partial|obscured",
  "overall_condition": "good|fair|poor|cannot_determine",
  "condition_score": 85,
  "zones": [
    {{
      "type": "missing_shingles|staining|debris|structural_damage|discoloration|moss_algae",
      "severity": "low|medium|high",
      "location_description": "northwest corner of main slope",
      "x_pct": 0.2, "y_pct": 0.3, "w_pct": 0.12, "h_pct": 0.10,
      "description": "Precise description of what is visible in the image",
      "confidence": 0.70
    }}
  ],
  "analyst_notes": "Honest summary of what can and cannot be determined at this resolution"
}}

If no damage is visible, return zones as []. condition_score: 0 = destroyed, 100 = perfect."""
        try:
            text = await llm_vision(image_bytes, media_type, vision_prompt, max_tokens=1500)
            text = text.strip()
            text = _re.sub(r'^```(?:json)?\s*', '', text, flags=_re.MULTILINE)
            text = _re.sub(r'\s*```\s*$', '', text)
            idx = text.find('{')
            if idx > 0:
                text = text[idx:]
            return json.loads(text)
        except Exception as e:
            return {"can_analyze": False, "zones": [], "overall_condition": "cannot_determine",
                    "condition_score": None, "analyst_notes": f"Vision analysis error: {str(e)[:120]}"}

    # ── 3. Weather / hail history ─────────────────────────────────────────────
    async def run_weather() -> dict:
        queries = [
            f'"{payload.address}" hail storm damage history site:weather.gov OR site:noaa.gov',
            f"{payload.address} hail storm wind damage report 2020 2021 2022 2023 2024",
            f"{payload.address} severe weather roof damage insurance claims history",
        ]
        try:
            research = await web_search_multi(queries, max_results=4)
        except Exception:
            logger.warning("weather history web search failed for %s", payload.address, exc_info=True)
            research = ""

        if not research or len(research.strip()) < 50:
            return {"events_found": False, "hail_risk": "unknown", "wind_risk": "unknown",
                    "events": [], "note": "No weather history found via web search. Consult NOAA Storm Events Database at www.ncdc.noaa.gov/stormevents/ for official records."}

        parse_prompt = f"""Extract structured weather risk data for this property from the web research below.
Address: {payload.address}

RESEARCH:
{research[:3500]}

STRICT RULES:
- Include ONLY events explicitly mentioned in the research above — never fabricate dates or events
- If no specific events are mentioned, set events_found to false and events to []
- hail_risk / wind_risk based ONLY on actual found events, not assumed geography

Return ONLY valid JSON:
{{
  "events_found": true,
  "hail_risk": "low|medium|high|unknown",
  "wind_risk": "low|medium|high|unknown",
  "events": [
    {{
      "date": "2023-04-15",
      "type": "hail|wind|tornado|severe_thunderstorm",
      "severity": "low|medium|high",
      "description": "Factual description from the source",
      "source": "Source name / URL"
    }}
  ],
  "note": "Brief summary of what research found"
}}"""
        try:
            text = await llm_text(parse_prompt, max_tokens=900)
            text = text.strip()
            text = _re.sub(r'^```(?:json)?\s*', '', text, flags=_re.MULTILINE)
            text = _re.sub(r'\s*```\s*$', '', text)
            idx = text.find('{')
            if idx > 0:
                text = text[idx:]
            return json.loads(text)
        except Exception as e:
            return {"events_found": False, "hail_risk": "unknown", "wind_risk": "unknown",
                    "events": [], "note": f"Weather research retrieved but could not be parsed: {str(e)[:100]}"}

    vision_result, weather_result = await asyncio.gather(
        run_vision(), run_weather(), return_exceptions=False
    )

    return {
        "address": payload.address,
        "vision_analysis": vision_result,
        "weather_risk": weather_result,
    }


from fastapi import File, Form, UploadFile
from typing import List as TypingList


@router.post("/analyze-photos")
async def analyze_uploaded_photos(
    photos: TypingList[UploadFile] = File(...),
    address: str = Form(""),
):
    """
    AI vision analysis of user-uploaded property photos (up to 20).
    Each photo is analyzed by Claude/Gemini Vision for:
      - Roof pitch estimation
      - Visible features (ridges, valleys, vents, etc.)
      - Damage flags (with honest confidence scores)
    Results are aggregated across photos. No data is fabricated.
    """
    from app.services.llm import llm_vision
    import json, re as _re

    if not photos:
        raise HTTPException(status_code=422, detail="No photos uploaded.")

    photos = photos[:20]  # hard cap

    prompt_tpl = """You are a licensed roofing inspector analyzing a property photo.
Address: {address}   Photo {idx} of {total}

TASK: Extract measurable roofing data from this photo.

STRICT RULES:
- Only report measurements you can ACTUALLY DETERMINE — return null for anything uncertain
- Never estimate sqft without a clear scale reference in the image
- Confidence must be honest (0.0–1.0) — do not inflate

Return ONLY valid JSON:
{{
  "usable": true,
  "quality_score": 85,
  "view_type": "front|side_left|side_right|rear|aerial|close_up|unknown",
  "pitch_estimate": "6/12",
  "pitch_confidence": 0.75,
  "stories_visible": 1,
  "features_visible": ["ridge","valley","eave","rake","vent","chimney","skylight","gutter","flashing"],
  "damage_flags": [
    {{
      "type": "missing_shingles|cracking|granule_loss|impact_damage|moss_algae|flashing_issue|sagging|debris",
      "severity": "low|medium|high",
      "location": "where in the image",
      "confidence": 0.80,
      "description": "Exact description of what you see"
    }}
  ],
  "notes": "What was and wasn't determinable from this specific photo"
}}
If the image is unusable (blurry, wrong subject, etc.), set usable to false and all other fields to null."""

    async def analyze_one(photo: UploadFile, idx: int) -> dict:
        try:
            content = await photo.read()
            if not content:
                return {"usable": False, "filename": photo.filename, "error": "Empty file"}
            mt = (photo.content_type or "image/jpeg").split(";")[0].strip()
            if mt not in ("image/jpeg", "image/png", "image/webp"):
                mt = "image/jpeg"
            prompt = prompt_tpl.format(address=address or "unknown", idx=idx + 1, total=len(photos))
            text = await llm_vision(content, mt, prompt, max_tokens=800)
            text = text.strip()
            text = _re.sub(r'^```(?:json)?\s*', '', text, flags=_re.MULTILINE)
            text = _re.sub(r'\s*```\s*$', '', text)
            i = text.find('{')
            if i > 0:
                text = text[i:]
            result = json.loads(text)
            result["filename"] = photo.filename
            return result
        except Exception as e:
            return {"usable": False, "filename": getattr(photo, "filename", "unknown"), "error": str(e)[:200]}

    per_photo = await asyncio.gather(*[analyze_one(p, i) for i, p in enumerate(photos)])
    usable = [r for r in per_photo if r.get("usable")]

    if not usable:
        return {"success": False,
                "message": "No usable photos — upload clear, well-lit images of the roof from multiple angles.",
                "per_photo": per_photo}

    # Aggregate pitch (highest-confidence wins)
    pitches = [(r["pitch_estimate"], r.get("pitch_confidence", 0.5))
               for r in usable if r.get("pitch_estimate")]
    best_pitch = max(pitches, key=lambda x: x[1])[0] if pitches else None
    avg_pitch_conf = sum(p[1] for p in pitches) / len(pitches) if pitches else 0.0

    features: set = set()
    all_damage: list = []
    for r in usable:
        features.update(r.get("features_visible") or [])
        all_damage.extend(r.get("damage_flags") or [])

    return {
        "success": True,
        "photos_analyzed": len(usable),
        "photos_failed": len(per_photo) - len(usable),
        "pitch_estimate": best_pitch,
        "pitch_confidence": round(avg_pitch_conf, 2),
        "features_detected": sorted(features),
        "damage_flags": all_damage,
        "confidence_boost": 0.12,   # photos add 12 pp to measurement confidence
        "per_photo": per_photo,
    }


@router.post("/storm-risk")
async def storm_risk_standalone(payload: StormRiskRequest):
    """
    Standalone storm / hail / wind risk report for any city + state.
    No project required.
    """
    from app.services.risk_score_service import get_risk_score
    if not payload.city.strip() or not payload.state.strip():
        raise HTTPException(status_code=422, detail="City and state are required.")
    try:
        result = await get_risk_score(
            city=payload.city.strip(),
            state=payload.state.strip().upper(),
            zip_code=payload.zip_code.strip() if payload.zip_code else "",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Storm risk report failed: {e}")
    return result
