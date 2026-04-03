"""
CRM endpoints for lead management + activity notes.
GET    /crm/leads?user_id=...        — list all leads
POST   /crm/leads                    — create a lead
PATCH  /crm/leads/{lead_id}          — update a lead
DELETE /crm/leads/{lead_id}          — delete a lead
GET    /crm/leads/{lead_id}/notes    — get activity notes for a lead
POST   /crm/leads/{lead_id}/notes    — add a note to a lead
DELETE /crm/leads/{lead_id}/notes/{note_id} — delete a note
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


class NoteCreate(BaseModel):
    text: str
    user_id: str


# ── Leads ─────────────────────────────────────────────────────────────────────

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


# ── Activity Notes ────────────────────────────────────────────────────────────

@router.get("/leads/{lead_id}/notes")
async def get_lead_notes(lead_id: str):
    db = get_supabase()
    try:
        result = (
            db.table("crm_lead_notes")
            .select("*")
            .eq("lead_id", lead_id)
            .order("created_at", desc=False)
            .execute()
        )
        return result.data or []
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch notes: {str(e)}")


@router.post("/leads/{lead_id}/notes")
async def add_lead_note(lead_id: str, payload: NoteCreate):
    if not payload.text.strip():
        raise HTTPException(status_code=422, detail="Note text cannot be empty.")
    db = get_supabase()
    try:
        result = db.table("crm_lead_notes").insert({
            "lead_id": lead_id,
            "user_id": payload.user_id,
            "text": payload.text.strip(),
        }).execute()
        return result.data[0]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to add note: {str(e)}")


@router.delete("/leads/{lead_id}/notes/{note_id}")
async def delete_lead_note(lead_id: str, note_id: str):
    db = get_supabase()
    try:
        db.table("crm_lead_notes").delete().eq("id", note_id).eq("lead_id", lead_id).execute()
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete note: {str(e)}")
