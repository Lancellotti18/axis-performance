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
    result = db.table("cost_estimates").select("*, material_estimates(*)").eq("project_id", project_id).single().execute()
    return result.data


@router.patch("/{project_id}")
async def update_estimate(project_id: str, payload: EstimateAdjust):
    db = get_supabase()
    update_data = {k: v for k, v in payload.dict().items() if v is not None}
    result = db.table("cost_estimates").update(update_data).eq("project_id", project_id).execute()
    return result.data[0]
