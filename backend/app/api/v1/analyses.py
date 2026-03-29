from fastapi import APIRouter, HTTPException
from app.core.supabase import get_supabase

router = APIRouter()


@router.get("/{analysis_id}")
async def get_analysis(analysis_id: str):
    db = get_supabase()
    result = db.table("analyses").select("*").eq("id", analysis_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Analysis not found")
    return result.data


@router.get("/by-blueprint/{blueprint_id}")
async def get_analysis_by_blueprint(blueprint_id: str):
    db = get_supabase()
    result = db.table("analyses").select("*").eq("blueprint_id", blueprint_id).limit(1).execute()
    return result.data[0] if result.data else None
