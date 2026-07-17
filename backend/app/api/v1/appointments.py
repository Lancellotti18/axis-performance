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

    # A booking REQUEST keeps the card a lead — it only becomes a 'site_visit'
    # once the contractor confirms the appointment (see update_appointment). A
    # requested-but-unconfirmed inspection is not yet a site visit.

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
    future, non-cancelled appointments. Each appointment is enriched with the
    homeowner's roof intelligence (age, issues, work type, quote) so the
    contractor sees the whole picture on the day panel without a second click."""
    db = get_supabase()
    q = db.table("inspection_appointments").select("*").eq("user_id", user["id"])
    if upcoming:
        q = q.gte("preferred_date", date.today().isoformat()).neq("status", "cancelled")
    rows = q.order("preferred_date", desc=False).limit(500).execute().data or []

    # Batch-attach the source RoofIQ lead's details (single query).
    lead_ids = [r["widget_lead_id"] for r in rows if r.get("widget_lead_id")]
    leads_by_id: dict = {}
    if lead_ids:
        try:
            lr = db.table("widget_leads").select(
                "id, roof_age, stories, issues, details, quote, lead_score, report_token, notes"
            ).in_("id", list(set(lead_ids))).execute()
            for lead in (lr.data or []):
                d = lead.get("details") or {}
                q_ = lead.get("quote") or {}
                leads_by_id[lead["id"]] = {
                    "roof_age": lead.get("roof_age"),
                    "stories": lead.get("stories"),
                    "issues": lead.get("issues") or [],
                    "work_type": d.get("work_type"),
                    "condition": d.get("condition"),
                    "rooftop_items": d.get("rooftop_items") or [],
                    "chimney_skylights": d.get("chimney_skylights"),
                    "drainage": d.get("drainage"),
                    "squares": q_.get("squares"),
                    "roof_sqft": q_.get("roof_sqft"),
                    "price_low": q_.get("price_low"),
                    "price_high": q_.get("price_high"),
                    "lead_score": lead.get("lead_score"),
                    "report_token": lead.get("report_token"),
                }
        except Exception:
            pass
    for r in rows:
        r["lead"] = leads_by_id.get(r.get("widget_lead_id"))
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
    # Confirming an inspection is what turns a lead into a real 'site_visit';
    # completing it moves to 'estimate_sent'; a cancel/no-show returns it to
    # 'contacted' (it's still a live lead, just not a scheduled visit).
    _STAGE_ON_STATUS = {"confirmed": "site_visit", "completed": "estimate_sent",
                        "cancelled": "contacted", "no_show": "contacted"}
    if crm_lead_id and payload.status in _STAGE_ON_STATUS:
        try:
            db.table("crm_leads").update({"stage": _STAGE_ON_STATUS[payload.status]}).eq("id", crm_lead_id).eq("user_id", user["id"]).execute()
        except Exception:
            pass

    # Auto-text the homeowner on both confirm and decline (env-gated,
    # best-effort — never blocks). Confirm → "you're confirmed"; cancel →
    # "we can't make it, let's find another time".
    if payload.status == "confirmed":
        _notify_homeowner(db, user["id"], appt, kind="confirmed")
    elif payload.status == "cancelled":
        _notify_homeowner(db, user["id"], appt, kind="declined")

    return appt


def _notify_homeowner(db, user_id: str, appt: dict, *, kind: str, proposed: list | None = None) -> None:
    """Fire an SMS to the homeowner about their inspection. Best-effort +
    env-gated (no-op unless Twilio is configured). Never raises."""
    try:
        from app.services.sms_service import sms_configured, send_sms
        if not sms_configured():
            return
        phone = appt.get("homeowner_phone")
        if not phone:
            return
        prof = db.table("contractor_profiles").select("company_name, phone").eq("user_id", user_id).limit(1).execute()
        company = (prof.data[0].get("company_name") if prof.data else None) or "your roofing contractor"
        cphone = (prof.data[0].get("phone") if prof.data else None) or ""
        first = (appt.get("homeowner_name") or "there").split(" ")[0]
        import asyncio

        if kind == "confirmed":
            d = date.fromisoformat(appt["preferred_date"]).strftime("%A, %B %-d")
            win = "" if appt.get("time_window") in (None, "anytime") else f" ({appt['time_window']})"
            body = (f"Hi {first}, your free roof inspection with {company} is CONFIRMED for {d}{win}. "
                    f"We'll see you then!" + (f" Questions? Call {cphone}." if cphone else ""))
        elif kind == "declined":
            body = (f"Hi {first}, unfortunately {company} can't make your requested roof inspection time. "
                    + (f"Please call {cphone} to find a time that works — we'd still love to help."
                       if cphone else "We'll reach out with other times that work."))
        elif kind == "propose" and proposed:
            days = ", ".join(date.fromisoformat(p).strftime("%a %b %-d") for p in proposed[:4])
            body = (f"Hi {first}, {company} would like to schedule your free roof inspection. "
                    f"Which of these works: {days}? Reply with your pick"
                    + (f" or call {cphone}." if cphone else "."))
        else:
            return
        asyncio.create_task(send_sms(phone, body))
    except Exception:
        pass


class ProposeDatesRequest(BaseModel):
    dates: list[str] = Field(..., min_length=1, max_length=4)   # ISO YYYY-MM-DD
    note: Optional[str] = Field(None, max_length=300)


@router.post("/{appointment_id}/propose")
async def propose_alternative_dates(
    appointment_id: str, payload: ProposeDatesRequest, user: dict = Depends(require_user),
) -> dict:
    """The contractor can't make the requested day — propose a few that work
    and text them to the homeowner to choose from. Records the proposal on the
    appointment note; the homeowner replies/calls to lock one in."""
    db = get_supabase()
    existing = (
        db.table("inspection_appointments").select("*")
        .eq("id", appointment_id).eq("user_id", user["id"]).limit(1).execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Appointment not found.")

    valid: list[str] = []
    for d in payload.dates:
        try:
            iso = date.fromisoformat(d)
        except ValueError:
            continue
        if iso >= date.today():
            valid.append(iso.isoformat())
    if not valid:
        raise HTTPException(status_code=422, detail="Pick at least one valid future date.")

    days_label = ", ".join(date.fromisoformat(d).strftime("%a %b %-d") for d in valid)
    note = f"Proposed alternative days to homeowner: {days_label}"
    if payload.note:
        note += f" — {payload.note.strip()}"
    res = (
        db.table("inspection_appointments").update({
            "contractor_note": note,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", appointment_id).eq("user_id", user["id"]).execute()
    )
    appt = res.data[0] if res.data else existing.data[0]
    _notify_homeowner(db, user["id"], appt, kind="propose", proposed=valid)
    return {"ok": True, "proposed": valid, "texted": bool(appt.get("homeowner_phone"))}


@router.delete("/{appointment_id}")
async def delete_appointment(appointment_id: str, user: dict = Depends(require_user)) -> dict:
    """Remove a single appointment from the calendar (owner only)."""
    db = get_supabase()
    db.table("inspection_appointments").delete().eq("id", appointment_id).eq("user_id", user["id"]).execute()
    return {"ok": True}


@router.post("/clear-done")
async def clear_finished_appointments(user: dict = Depends(require_user)) -> dict:
    """Declutter: delete this contractor's finished appointments (completed,
    cancelled, no-show) plus any past-dated ones still lingering."""
    db = get_supabase()
    removed = 0
    try:
        r1 = (
            db.table("inspection_appointments").delete()
            .eq("user_id", user["id"])
            .in_("status", ["completed", "cancelled", "no_show"]).execute()
        )
        removed += len(r1.data or [])
        # Past-dated appointments that were never actioned.
        r2 = (
            db.table("inspection_appointments").delete()
            .eq("user_id", user["id"])
            .lt("preferred_date", date.today().isoformat()).execute()
        )
        removed += len(r2.data or [])
    except Exception as e:
        logger.warning("clear-done failed: %s", e)
        raise HTTPException(status_code=500, detail="Could not clear appointments.")
    return {"ok": True, "removed": removed}
