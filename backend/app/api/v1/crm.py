"""
Basic CRM endpoints for lead management.
GET    /crm/leads?user_id=...   — list all leads for a user
POST   /crm/leads               — create a lead
PATCH  /crm/leads/{lead_id}     — update a lead (stage, notes, etc.)
DELETE /crm/leads/{lead_id}     — delete a lead
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from app.core.supabase import get_supabase

router = APIRouter()

VALID_STAGES = {"new", "contacted", "site_visit", "estimate_sent", "won", "lost"}


class LeadCreate(BaseModel):
    name: str
    phone: Optional[str] = ""
    email: Optional[str] = ""
    address: Optional[str] = ""
    city: Optional[str] = ""
    state: Optional[str] = ""
    job_type: Optional[str] = "residential"
    stage: Optional[str] = "new"
    notes: Optional[str] = ""
    estimated_value: Optional[float] = 0.0


class LeadUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    job_type: Optional[str] = None
    stage: Optional[str] = None
    notes: Optional[str] = None
    estimated_value: Optional[float] = None


@router.get("/leads")
async def list_leads(user_id: str = Query(...)):
    db = get_supabase()
    try:
        result = db.table("crm_leads").select("*").eq("user_id", user_id).order("created_at", desc=True).execute()
        return result.data or []
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch leads: {str(e)}")


@router.post("/leads")
async def create_lead(payload: LeadCreate, user_id: str = Query(...)):
    db = get_supabase()
    if payload.stage not in VALID_STAGES:
        payload.stage = "new"
    try:
        result = db.table("crm_leads").insert({
            "user_id": user_id,
            "name": payload.name,
            "phone": payload.phone,
            "email": payload.email,
            "address": payload.address,
            "city": payload.city,
            "state": payload.state,
            "job_type": payload.job_type,
            "stage": payload.stage,
            "notes": payload.notes,
            "estimated_value": payload.estimated_value,
        }).execute()
        return result.data[0]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create lead: {str(e)}")


@router.patch("/leads/{lead_id}")
async def update_lead(lead_id: str, payload: LeadUpdate):
    db = get_supabase()
    update = {k: v for k, v in payload.dict().items() if v is not None}
    if not update:
        raise HTTPException(status_code=400, detail="No fields to update")
    if "stage" in update and update["stage"] not in VALID_STAGES:
        raise HTTPException(status_code=400, detail=f"Invalid stage. Must be one of: {', '.join(VALID_STAGES)}")
    try:
        result = db.table("crm_leads").update(update).eq("id", lead_id).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Lead not found")
        return result.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update lead: {str(e)}")


@router.delete("/leads/{lead_id}")
async def delete_lead(lead_id: str):
    db = get_supabase()
    try:
        db.table("crm_leads").delete().eq("id", lead_id).execute()
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete lead: {str(e)}")
