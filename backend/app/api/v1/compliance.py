from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Query
from app.core.auth import get_current_user
from app.core.supabase import get_supabase
from app.services.compliance_engine import run_compliance_check, get_state_from_region_code
from app.services.materials_compliance_service import check_materials_compliance
import asyncio

router = APIRouter()


@router.get("/region/{region_code}")
async def get_compliance_for_region(
    region_code: str,
    project_type: str = "residential",
    city: str | None = None,
    user: dict = Depends(get_current_user),
):
    """
    Run a compliance check for a given region code (e.g. US-TX) and project type.
    Results are generated fresh via Claude — cache on the frontend or in DB as needed.
    """
    state_info = get_state_from_region_code(region_code)
    try:
        data = await run_compliance_check(
            location=state_info["name"],
            state_code=state_info["code"],
            project_type=project_type,
            city=city,
        )
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Compliance check failed: {str(e)}")


@router.post("/project/{project_id}")
async def trigger_project_compliance(
    project_id: str,
    background_tasks: BackgroundTasks,
    city: str | None = None,
    user: dict = Depends(get_current_user),
):
    """
    Trigger a compliance check for a specific project and store results in DB.
    """
    supabase = get_supabase()

    # Fetch project
    result = supabase.table("projects").select("*").eq("id", project_id).single().execute()
    project = result.data
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    region = project.get("region", "US-TX")
    blueprint_type = project.get("blueprint_type", "residential")

    # Upsert a pending compliance_checks record
    check = supabase.table("compliance_checks").upsert({
        "project_id": project_id,
        "status": "processing",
        "region": region,
        "city": city,
        "project_type": blueprint_type,
    }).execute()

    check_id = check.data[0]["id"] if check.data else None

    # Run compliance check in background
    background_tasks.add_task(
        _run_and_save_compliance, check_id, project_id, region, blueprint_type, city
    )

    return {"status": "processing", "check_id": check_id}


async def _run_and_save_compliance(
    check_id: str,
    project_id: str,
    region: str,
    project_type: str,
    city: str | None,
):
    supabase = get_supabase()
    state_info = get_state_from_region_code(region)
    try:
        data = await run_compliance_check(
            location=state_info["name"],
            state_code=state_info["code"],
            project_type=project_type,
            city=city,
        )

        # Save items
        items = data.get("items", [])
        if items and check_id:
            rows = [
                {
                    "check_id": check_id,
                    "category": item.get("category"),
                    "title": item.get("title"),
                    "description": item.get("description"),
                    "severity": item.get("severity"),
                    "action": item.get("action"),
                    "deadline": item.get("deadline"),
                    "penalty": item.get("penalty"),
                    "source": item.get("source"),
                }
                for item in items
            ]
            supabase.table("compliance_items").insert(rows).execute()

        # Update check record
        supabase.table("compliance_checks").update({
            "status": "complete",
            "summary": data.get("summary"),
            "risk_level": data.get("risk_level"),
            "raw_data": data,
        }).eq("id", check_id).execute()

    except Exception as e:
        if check_id:
            supabase.table("compliance_checks").update({
                "status": "failed",
                "summary": str(e),
            }).eq("id", check_id).execute()


@router.get("/project/{project_id}")
async def get_project_compliance(
    project_id: str,
    user: dict = Depends(get_current_user),
):
    """
    Get the stored compliance check results for a project.
    """
    supabase = get_supabase()

    check_result = (
        supabase.table("compliance_checks")
        .select("*")
        .eq("project_id", project_id)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )

    if not check_result.data:
        return {"status": "not_run", "items": []}

    check = check_result.data[0]
    check_id = check["id"]

    items_result = (
        supabase.table("compliance_items")
        .select("*")
        .eq("check_id", check_id)
        .order("severity")
        .execute()
    )

    return {
        "status": check["status"],
        "summary": check.get("summary"),
        "risk_level": check.get("risk_level"),
        "region": check.get("region"),
        "city": check.get("city"),
        "project_type": check.get("project_type"),
        "created_at": check.get("created_at"),
        "items": items_result.data or [],
    }


@router.post("/materials-check")
async def check_project_materials(project_id: str = Query(...)):
    """
    Cross-reference the project's generated materials list against local building codes.
    Returns exact rule citations, violations, and fix suggestions.
    """
    supabase = get_supabase()

    # Get project info for location
    proj = supabase.table("projects").select("*").eq("id", project_id).single().execute()
    if not proj.data:
        raise HTTPException(status_code=404, detail="Project not found")
    project = proj.data

    city = project.get("city", "")
    county = project.get("county", "")
    region = project.get("region", "US-TX")
    state = region.replace("US-", "") if region else "TX"
    project_type = project.get("blueprint_type", "residential")

    if not city:
        raise HTTPException(status_code=422, detail="Project has no city set. Edit the project to add a city before running compliance check.")

    # Fetch materials from material_estimates via blueprint -> analysis chain
    bp = supabase.table("blueprints").select("id").eq("project_id", project_id).limit(1).execute()
    materials = []
    if bp.data:
        analysis = supabase.table("analyses").select("id").eq("blueprint_id", bp.data[0]["id"]).limit(1).execute()
        if analysis.data:
            mat_result = supabase.table("material_estimates").select("*").eq("analysis_id", analysis.data[0]["id"]).execute()
            materials = mat_result.data or []

    # Also check for manually added/edited materials in materials table
    try:
        manual = supabase.table("project_materials").select("*").eq("project_id", project_id).execute()
        if manual.data:
            materials.extend(manual.data)
    except Exception:
        pass

    if not materials:
        # Still run the check with empty list — Claude will flag missing required items
        materials = []

    try:
        result = await check_materials_compliance(
            materials=materials,
            city=city,
            state=state,
            project_type=project_type,
            county=county,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Compliance check failed: {str(e)}")

    return result
