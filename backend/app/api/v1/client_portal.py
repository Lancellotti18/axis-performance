"""
Client Portal — the homeowner's window into their job.

One tokenized link per project (/c/{token}): status timeline, proposal,
report download, photos, contractor contact. Link-based access (no homeowner
accounts) — the unguessable token is the auth, same pattern as proposals.

Contractor (JWT):
    GET   /api/v1/client-portal/my/{project_id}   — get-or-create the portal
    PATCH /api/v1/client-portal/my/{project_id}   — stage / enabled
Public (homeowner):
    GET   /api/v1/client-portal/public/{token}    — assembled portal payload
"""
from __future__ import annotations

import logging
import secrets
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.auth import require_user
from app.core.supabase import get_supabase

logger = logging.getLogger(__name__)
router = APIRouter()

STAGES = ["measured", "proposal", "accepted", "scheduled", "in_progress", "complete"]


def _own_project(db, project_id: str, user_id: str) -> dict:
    proj = db.table("projects").select("*").eq("id", project_id).single().execute()
    if not proj.data:
        raise HTTPException(status_code=404, detail="Project not found.")
    if proj.data.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="This project belongs to another account.")
    return proj.data


@router.get("/my/{project_id}")
async def my_portal(project_id: str, user: dict = Depends(require_user)) -> dict:
    """Get (or lazily create) the portal for a project."""
    db = get_supabase()
    _own_project(db, project_id, user["id"])
    res = db.table("client_portals").select("*").eq("project_id", project_id).limit(1).execute()
    if res.data:
        return res.data[0]
    ins = db.table("client_portals").insert({
        "project_id": project_id,
        "user_id": user["id"],
        "token": secrets.token_urlsafe(16),
    }).execute()
    if not ins.data:
        raise HTTPException(status_code=500, detail="Could not create the portal.")
    return ins.data[0]


class PortalPatch(BaseModel):
    stage: Optional[str] = Field(None, pattern="^(measured|proposal|accepted|scheduled|in_progress|complete)$")
    enabled: Optional[bool] = None


@router.patch("/my/{project_id}")
async def update_portal(
    project_id: str, payload: PortalPatch, user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    _own_project(db, project_id, user["id"])
    patch = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(status_code=422, detail="Nothing to update.")
    patch["updated_at"] = "now()"
    res = db.table("client_portals").update(patch).eq("project_id", project_id).eq("user_id", user["id"]).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="No portal for this project yet.")
    return res.data[0]


@router.get("/public/{token}")
async def public_portal(token: str) -> dict:
    """Everything the homeowner sees, assembled from data Axis already has.
    Homeowner-safe fields only."""
    if not token or len(token) > 64:
        raise HTTPException(status_code=404, detail="Portal not found.")
    db = get_supabase()
    res = db.table("client_portals").select("*").eq("token", token).limit(1).execute()
    if not res.data or not res.data[0].get("enabled"):
        raise HTTPException(status_code=404, detail="Portal not found.")
    portal = res.data[0]

    proj = db.table("projects").select("*").eq("id", portal["project_id"]).single().execute()
    project = proj.data or {}
    addr_parts = [project.get("address"), project.get("city"), project.get("state")]
    address = ", ".join(p for p in addr_parts if p) or project.get("name") or "Your property"

    # Contractor branding
    contractor: dict = {}
    try:
        prof = db.table("contractor_profiles").select("*").eq("user_id", portal["user_id"]).limit(1).execute()
        if prof.data:
            p = prof.data[0]
            contractor = {
                "company_name": p.get("company_name"),
                "license_number": p.get("license_number"),
                "phone": p.get("phone"),
                "email": p.get("email"),
                "logo_url": p.get("logo_url"),
            }
    except Exception:
        pass

    # Latest measurement run → roof stats, photos, report availability
    roof: dict = {}
    photos: list[str] = []
    report_url: Optional[str] = None
    try:
        runs = db.table("roof_measurement_runs").select(
            "id, squares, total_roof_sqft, predominant_pitch, ground_photo_urls, created_at"
        ).eq("project_id", portal["project_id"]).order("created_at", desc=True).limit(1).execute()
        if runs.data:
            r = runs.data[0]
            roof = {
                "squares": r.get("squares"),
                "total_roof_sqft": r.get("total_roof_sqft"),
                "predominant_pitch": r.get("predominant_pitch"),
            }
            photos = (r.get("ground_photo_urls") or [])[:12]
            try:
                from app.api.v1.roofing_v2 import _signed_report_url
                report_url = _signed_report_url(r["id"])
            except Exception:
                report_url = None
    except Exception as e:
        logger.info("portal run lookup failed: %s", e)

    # Latest proposal for the project
    proposal: Optional[dict] = None
    try:
        props = db.table("roof_proposals").select(
            "token, status, accepted_tier, tiers, valid_until, created_at"
        ).eq("project_id", portal["project_id"]).order("created_at", desc=True).limit(1).execute()
        if props.data:
            pr = props.data[0]
            prices = [t.get("price") for t in (pr.get("tiers") or []) if t.get("price")]
            proposal = {
                "token": pr["token"],
                "status": pr.get("status"),
                "accepted_tier": pr.get("accepted_tier"),
                "price_low": min(prices) if prices else None,
                "price_high": max(prices) if prices else None,
                "valid_until": pr.get("valid_until"),
            }
    except Exception:
        pass

    return {
        "address": address,
        "stage": portal.get("stage") or "measured",
        "stages": STAGES,
        "contractor": contractor,
        "roof": roof,
        "photos": photos,
        "report_url": report_url,
        "proposal": proposal,
        "updated_at": portal.get("updated_at"),
    }


# ---------------------------------------------------------------------------
# Two-way messaging — contractor ⇄ homeowner, scoped by the portal
# ---------------------------------------------------------------------------

import time as _time

# Light per-IP limiter for the PUBLIC reply endpoint.
_MSG_RATE: dict[str, list[float]] = {}


def _msg_rate_ok(ip: str, max_per_hour: int = 30) -> bool:
    now = _time.time()
    hits = [t for t in _MSG_RATE.get(ip, []) if now - t < 3600]
    if len(hits) >= max_per_hour:
        _MSG_RATE[ip] = hits
        return False
    hits.append(now)
    _MSG_RATE[ip] = hits
    return True


def _message_rows(db, portal_id: str) -> list[dict]:
    rows = db.table("portal_messages").select(
        "id, sender, sender_name, body, created_at"
    ).eq("portal_id", portal_id).order("created_at", desc=False).limit(200).execute().data or []
    return rows


class MessageIn(BaseModel):
    body: str = Field(..., min_length=1, max_length=2000)
    name: Optional[str] = Field(None, max_length=120)


@router.get("/my/{project_id}/messages")
async def my_messages(project_id: str, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    _own_project(db, project_id, user["id"])
    portal = db.table("client_portals").select("id").eq("project_id", project_id).limit(1).execute()
    if not portal.data:
        return {"messages": []}
    return {"messages": _message_rows(db, portal.data[0]["id"])}


@router.post("/my/{project_id}/messages")
async def post_my_message(
    project_id: str, payload: MessageIn, user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    _own_project(db, project_id, user["id"])
    portal = db.table("client_portals").select("id").eq("project_id", project_id).limit(1).execute()
    if not portal.data:
        raise HTTPException(status_code=404, detail="No portal for this project yet — open the Client Portal panel first.")
    ins = db.table("portal_messages").insert({
        "portal_id": portal.data[0]["id"],
        "sender": "contractor",
        "sender_name": payload.name,
        "body": payload.body.strip(),
    }).execute()
    if not ins.data:
        raise HTTPException(status_code=500, detail="Could not send the message.")
    return {"ok": True, "message": ins.data[0]}


@router.get("/public/{token}/messages")
async def public_messages(token: str) -> dict:
    db = get_supabase()
    res = db.table("client_portals").select("id, enabled").eq("token", token).limit(1).execute()
    if not res.data or not res.data[0].get("enabled"):
        raise HTTPException(status_code=404, detail="Portal not found.")
    return {"messages": _message_rows(db, res.data[0]["id"])}


@router.post("/public/{token}/messages")
async def post_public_message(token: str, payload: MessageIn, request: Request) -> dict:
    ip = (request.client.host if request.client else "?") or "?"
    if not _msg_rate_ok(ip):
        raise HTTPException(status_code=429, detail="Too many messages — please try again in a bit.")
    db = get_supabase()
    res = db.table("client_portals").select("id, enabled, user_id, project_id").eq("token", token).limit(1).execute()
    if not res.data or not res.data[0].get("enabled"):
        raise HTTPException(status_code=404, detail="Portal not found.")
    portal = res.data[0]
    ins = db.table("portal_messages").insert({
        "portal_id": portal["id"],
        "sender": "homeowner",
        "sender_name": (payload.name or "").strip() or None,
        "body": payload.body.strip(),
    }).execute()
    if not ins.data:
        raise HTTPException(status_code=500, detail="Could not send — please call the contractor instead.")

    # Ping the contractor's bell — a customer replying is worth surfacing.
    try:
        from app.api.v1.notifications import create_notification
        who = (payload.name or "").strip() or "A customer"
        create_notification(
            db, portal.get("user_id"), type="message",
            title=f"💬 New message from {who}",
            body=payload.body.strip(),
            link=f"/projects/{portal.get('project_id')}" if portal.get("project_id") else "/crm",
        )
    except Exception:
        pass

    return {"ok": True, "message": ins.data[0]}
