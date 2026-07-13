"""
Inspection appointments — homeowner booking + contractor calendar.

The homeowner books a free inspection from their RoofIQ report (public, keyed
by the report token); it lands on the contractor's calendar and advances the
linked CRM lead to 'site_visit'. Contractors confirm / complete / cancel.

Public (homeowner, by report token):
    POST /api/v1/appointments/book/{report_token}

Contractor (JWT):
    GET   /api/v1/appointments                 — my appointments (optional ?upcoming=1)
    PATCH /api/v1/appointments/{appointment_id} — status / time / note (owner only)
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.core.auth import require_user
from app.core.ratelimit import rate_ok
from app.core.supabase import get_supabase

logger = logging.getLogger(__name__)
router = APIRouter()

_WINDOWS = {"morning", "afternoon", "evening", "anytime"}
_STATUSES = {"requested", "confirmed", "completed", "cancelled", "no_show"}


class BookRequest(BaseModel):
    preferred_date: str = Field(..., min_length=8, max_length=10)   # YYYY-MM-DD
    time_window: str = Field("anytime")
    note: Optional[str] = Field(None, max_length=500)
    # Honeypot — humans never fill this.
    website: Optional[str] = Field(None, max_length=200)


@router.post("/book/{report_token}")
async def book_inspection(report_token: str, payload: BookRequest, request: Request) -> dict:
    """Homeowner books a free inspection from their report. Public but bound to
    a real report token, rate-limited, and honeypot-guarded."""
    ip = (request.client.host if request.client else "?") or "?"
    if not rate_ok(f"book-{ip}", max_per_hour=10):
        raise HTTPException(status_code=429, detail="Too many requests — please try again shortly.")
    if payload.website:
        return {"ok": True, "status": "requested"}   # swallow bots

    if not report_token or len(report_token) > 64:
        raise HTTPException(status_code=404, detail="Report not found.")
    window = payload.time_window if payload.time_window in _WINDOWS else "anytime"
    try:
        d = date.fromisoformat(payload.preferred_date)
    except ValueError:
        raise HTTPException(status_code=422, detail="Pick a valid date.")
    if d < date.today():
        raise HTTPException(status_code=422, detail="Pick a date in the future.")

    db = get_supabase()
    lead_res = db.table("widget_leads").select("*").eq("report_token", report_token).limit(1).execute()
    if not lead_res.data:
        raise HTTPException(status_code=404, detail="Report not found.")
    lead = lead_res.data[0]

    # Look up the linked CRM lead (system of record) to advance its stage.
    crm_lead_id = None
    try:
        crm = db.table("crm_leads").select("id").eq("widget_lead_id", lead["id"]).limit(1).execute()
        if crm.data:
            crm_lead_id = crm.data[0]["id"]
    except Exception:
        pass   # link column may predate the migration; booking still works

    row = {
        "user_id": lead["user_id"],
        "widget_lead_id": lead["id"],
        "crm_lead_id": crm_lead_id,
        "report_token": report_token,
        "homeowner_name": lead.get("name"),
        "homeowner_phone": lead.get("phone"),
        "homeowner_email": lead.get("email"),
        "address": lead.get("address"),
        "preferred_date": d.isoformat(),
        "time_window": window,
        "homeowner_note": (payload.note or "").strip() or None,
        "status": "requested",
    }
    ins = db.table("inspection_appointments").insert({k: v for k, v in row.items() if v is not None}).execute()
    if not ins.data:
        raise HTTPException(status_code=500, detail="Could not book — please call the contractor instead.")

    # Advance the pipeline card to 'site_visit' (best-effort — never fail the booking).
    if crm_lead_id:
        try:
            db.table("crm_leads").update({"stage": "site_visit"}).eq("id", crm_lead_id).execute()
        except Exception:
            logger.info("could not advance crm lead %s to site_visit", crm_lead_id)

    # Speed-to-lead: alert the contractor a booking came in (env-gated, best-effort).
    try:
        from app.services.sms_service import sms_configured, send_sms
        if sms_configured():
            import asyncio
            prof = db.table("contractor_profiles").select("phone").eq("user_id", lead["user_id"]).limit(1).execute()
            cphone = (prof.data[0].get("phone") if prof.data else None)
            when = d.strftime("%a %b %-d") + ("" if window == "anytime" else f" ({window})")
            asyncio.create_task(send_sms(
                cphone,
                f"📅 New inspection booked: {lead.get('name')} — {lead.get('address')} — {when}. Confirm in Axis.",
            ))
    except Exception:
        pass

    return {"ok": True, "status": "requested", "preferred_date": d.isoformat(), "time_window": window}


@router.get("")
async def list_appointments(
    upcoming: bool = Query(False),
    user: dict = Depends(require_user),
) -> dict:
    """The contractor's inspection calendar. `upcoming=1` returns only
    future, non-cancelled appointments (the default calendar view)."""
    db = get_supabase()
    q = db.table("inspection_appointments").select("*").eq("user_id", user["id"])
    if upcoming:
        q = q.gte("preferred_date", date.today().isoformat()).neq("status", "cancelled")
    rows = q.order("preferred_date", desc=False).limit(500).execute().data or []
    return {"appointments": rows}


class AppointmentPatch(BaseModel):
    status: Optional[str] = None
    preferred_date: Optional[str] = None
    time_window: Optional[str] = None
    contractor_note: Optional[str] = Field(None, max_length=500)


@router.patch("/{appointment_id}")
async def update_appointment(
    appointment_id: str, payload: AppointmentPatch, user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    existing = (
        db.table("inspection_appointments").select("*")
        .eq("id", appointment_id).eq("user_id", user["id"]).limit(1).execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Appointment not found.")

    patch: dict = {}
    if payload.status is not None:
        if payload.status not in _STATUSES:
            raise HTTPException(status_code=422, detail=f"status must be one of {', '.join(sorted(_STATUSES))}")
        patch["status"] = payload.status
    if payload.preferred_date is not None:
        try:
            patch["preferred_date"] = date.fromisoformat(payload.preferred_date).isoformat()
        except ValueError:
            raise HTTPException(status_code=422, detail="Pick a valid date.")
    if payload.time_window is not None:
        if payload.time_window not in _WINDOWS:
            raise HTTPException(status_code=422, detail=f"time_window must be one of {', '.join(sorted(_WINDOWS))}")
        patch["time_window"] = payload.time_window
    if payload.contractor_note is not None:
        patch["contractor_note"] = payload.contractor_note.strip() or None
    if not patch:
        raise HTTPException(status_code=422, detail="Nothing to update.")
    patch["updated_at"] = datetime.now(timezone.utc).isoformat()

    res = (
        db.table("inspection_appointments").update(patch)
        .eq("id", appointment_id).eq("user_id", user["id"]).execute()
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="Appointment not found.")

    # Keep the pipeline honest: a completed inspection nudges the linked lead to
    # 'estimate_sent'; a cancellation/no-show sends it back to 'contacted'.
    appt = res.data[0]
    crm_lead_id = appt.get("crm_lead_id")
    if crm_lead_id and payload.status in ("completed", "cancelled", "no_show"):
        new_stage = "estimate_sent" if payload.status == "completed" else "contacted"
        try:
            db.table("crm_leads").update({"stage": new_stage}).eq("id", crm_lead_id).eq("user_id", user["id"]).execute()
        except Exception:
            pass
    return appt
