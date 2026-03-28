from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.core.supabase import get_supabase

router = APIRouter()


class ContractorProfile(BaseModel):
    company_name: Optional[str] = ""
    license_number: Optional[str] = ""
    phone: Optional[str] = ""
    email: Optional[str] = ""
    address: Optional[str] = ""
    city: Optional[str] = ""
    state: Optional[str] = ""
    zip_code: Optional[str] = ""


@router.get("/{user_id}")
async def get_contractor_profile(user_id: str):
    db = get_supabase()
    result = db.table("contractor_profiles").select("*").eq("user_id", user_id).limit(1).execute()
    if not result.data:
        return {}
    return result.data[0]


@router.post("/{user_id}")
async def save_contractor_profile(user_id: str, payload: ContractorProfile):
    db = get_supabase()
    data = {
        "user_id": user_id,
        **{k: v for k, v in payload.dict().items() if v is not None},
        "updated_at": "now()",
    }
    result = db.table("contractor_profiles").upsert(data, on_conflict="user_id").execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to save profile")
    return result.data[0]
