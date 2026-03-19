from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.core.supabase import get_supabase

router = APIRouter()


class EstimateAdjust(BaseModel):
    markup_pct: Optional[float] = None
    labor_rate: Optional[float] = None
    region: Optional[str] = None


@router.get("/{project_id}")
async def get_estimate(project_id: str):
    db = get_supabase()
    result = db.table("cost_estimates").select("*").eq("project_id", project_id).single().execute()
    if not result.data:
        return None
    estimate = result.data

    # Fetch material estimates via blueprint -> analysis chain
    bp = db.table("blueprints").select("id").eq("project_id", project_id).limit(1).execute()
    if bp.data:
        analysis = db.table("analyses").select("id").eq("blueprint_id", bp.data[0]["id"]).limit(1).execute()
        if analysis.data:
            materials = db.table("material_estimates").select("*").eq("analysis_id", analysis.data[0]["id"]).execute()
            estimate["material_estimates"] = materials.data or []
    else:
        estimate["material_estimates"] = []

    return estimate


@router.patch("/{project_id}")
async def update_estimate(project_id: str, payload: EstimateAdjust):
    db = get_supabase()
    update_data = {k: v for k, v in payload.dict().items() if v is not None}
    result = db.table("cost_estimates").update(update_data).eq("project_id", project_id).execute()
    return result.data[0]
