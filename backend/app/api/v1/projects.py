import logging

from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from typing import Optional
from app.core.auth import require_user
from app.core.ownership import require_owned_project
from app.core.supabase import get_supabase

logger = logging.getLogger(__name__)

router = APIRouter()


class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None
    region: Optional[str] = "US-TX"
    blueprint_type: Optional[str] = "residential"
    city: Optional[str] = None
    zip_code: Optional[str] = None


@router.get("/")
async def list_projects(
    user_id: Optional[str] = Query(None),   # legacy param — ignored, token wins
    include_archived: bool = Query(default=False),
    user: dict = Depends(require_user),
):
    db = get_supabase()
    try:
        query = db.table("projects").select("*").eq("user_id", user["id"])
        if not include_archived:
            query = query.eq("archived", False)
        result = query.order("created_at", desc=True).execute()
        rows = result.data or []
    except Exception:
        logger.debug("projects archived filter failed, falling back to unfiltered", exc_info=True)
        # archived column may not exist yet — fall back to unfiltered query
        result = db.table("projects").select("*").eq("user_id", user["id"]).order("created_at", desc=True).execute()
        rows = result.data or []
    # If include_archived=False but column doesn't exist, filter client-side (archived defaults to False)
    if not include_archived:
        rows = [r for r in rows if not r.get("archived", False)]

    # Attach a thumbnail_url per project — the latest roof run's satellite tile, so
    # the dashboard cards show the actual house. Best-effort + batched (one query);
    # projects without a roof run simply get no thumbnail (frontend shows a fallback).
    try:
        ids = [r["id"] for r in rows if r.get("id")]
        if ids:
            runs = (
                db.table("roof_measurement_runs")
                .select("project_id, satellite_image_url, created_at")
                .in_("project_id", ids)
                .order("created_at", desc=True)
                .execute()
            )
            thumb: dict[str, str] = {}
            for run in (runs.data or []):
                pid, url = run.get("project_id"), run.get("satellite_image_url")
                if pid and url and pid not in thumb:   # first seen = latest (desc order)
                    thumb[pid] = url
            for r in rows:
                r["thumbnail_url"] = thumb.get(r.get("id"))
    except Exception:
        logger.debug("project thumbnail enrichment failed (non-fatal)", exc_info=True)

    return rows


@router.post("/")
async def create_project(
    payload: ProjectCreate,
    user_id: Optional[str] = Query(None),   # legacy param — ignored, token wins
    user: dict = Depends(require_user),
):
    db = get_supabase()
    # Ensure profile exists (auto-create if missing)
    db.table("profiles").upsert({"id": user["id"]}, on_conflict="id").execute()
    result = db.table("projects").insert({
        "user_id": user["id"],
        "name": payload.name,
        "description": payload.description,
        "region": payload.region,
        "blueprint_type": payload.blueprint_type,
        "city": payload.city,
        "zip_code": payload.zip_code,
        "status": "pending",
    }).execute()
    return result.data[0]


@router.get("/{project_id}")
async def get_project(project_id: str, user: dict = Depends(require_user)):
    db = get_supabase()
    require_owned_project(db, project_id, user)
    result = (
        db.table("projects")
        .select("*, blueprints(*)")
        .eq("id", project_id)
        .single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Project not found")
    return result.data


@router.patch("/{project_id}")
async def update_project(project_id: str, payload: dict, user: dict = Depends(require_user)):
    db = get_supabase()
    require_owned_project(db, project_id, user)
    allowed = {k: v for k, v in payload.items() if k in ("name", "description", "region", "city", "zip_code", "archived")}
    if not allowed:
        raise HTTPException(status_code=400, detail="No valid fields to update")
    result = db.table("projects").update(allowed).eq("id", project_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Project not found")
    return result.data[0]


@router.delete("/{project_id}")
async def delete_project(project_id: str, user: dict = Depends(require_user)):
    db = get_supabase()
    require_owned_project(db, project_id, user)
    db.table("projects").delete().eq("id", project_id).execute()
    return {"success": True}


@router.get("/{project_id}/risk-score")
async def get_project_risk_score(project_id: str, user: dict = Depends(require_user)):
    """
    Generate a storm/hail/wind risk assessment for the project's location.
    Uses Tavily weather data + Claude analysis.
    """
    from app.services.risk_score_service import get_risk_score
    db = get_supabase()

    proj = require_owned_project(db, project_id, user)

    city = proj.get("city", "")
    region = proj.get("region", "US-TX")
    zip_code = proj.get("zip_code", "")
    state = region.replace("US-", "") if region else "TX"

    if not city:
        raise HTTPException(status_code=422, detail="Project has no city set. Edit the project to add a city.")

    try:
        score = await get_risk_score(city=city, state=state, zip_code=zip_code)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Risk score failed: {e}")

    return score
