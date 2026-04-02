"""
Roofing analysis endpoints.
POST /roofing/{blueprint_id}/measure   — AI vision measurement analysis
POST /roofing/{blueprint_id}/confirm   — User confirms/adjusts measurements
GET  /roofing/{blueprint_id}/measurements — Get stored measurements
GET  /roofing/{project_id}/shingle-estimate — Calculate shingle material list
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.core.supabase import get_supabase
from app.services.roofing_service import analyze_roof_image, calculate_shingle_materials

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
    if not payload.address.strip():
        raise HTTPException(status_code=422, detail="Address is required.")
    try:
        result = await get_aerial_roof_report(
            address=payload.address.strip(),
            city="",
            state="",
            zip_code="",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Aerial report failed: {e}")
    return result


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
