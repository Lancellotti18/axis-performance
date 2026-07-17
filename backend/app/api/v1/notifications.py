"""In-app notifications: the top-bar bell feed.

Other modules call `create_notification(...)` (best-effort, never raises) when
something the contractor should know about happens — a booking, an accepted
proposal, a customer message. This router lets the frontend read the feed and
mark things read.

Defensive by design: if the notifications table doesn't exist yet (migration
not applied), every read returns an empty/zero result and writes silently no-op,
so the app never breaks on account of notifications.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.auth import require_user
from app.core.supabase import get_supabase

logger = logging.getLogger(__name__)
router = APIRouter()

_TYPES = {"appointment", "proposal_accepted", "message", "system"}


def create_notification(
    db,
    user_id: str,
    *,
    type: str,
    title: str,
    body: Optional[str] = None,
    link: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> None:
    """Insert one notification for a contractor. Best-effort — never raises,
    never blocks the action that triggered it."""
    if not user_id or not title:
        return
    try:
        db.table("notifications").insert({
            "user_id": user_id,
            "type": type if type in _TYPES else "system",
            "title": title[:200],
            "body": (body or None) and body[:500],
            "link": link,
            "metadata": metadata,
        }).execute()
    except Exception as e:
        logger.info("notification insert skipped (%s): %s", type, e)


@router.get("")
async def list_notifications(user: dict = Depends(require_user)) -> dict:
    """Recent feed (newest first) + current unread count."""
    db = get_supabase()
    try:
        rows = (
            db.table("notifications").select("*")
            .eq("user_id", user["id"]).order("created_at", desc=True).limit(50).execute().data
        ) or []
    except Exception:
        return {"notifications": [], "unread": 0}
    unread = sum(1 for r in rows if not r.get("read"))
    return {"notifications": rows, "unread": unread}


@router.get("/unread-count")
async def unread_count(user: dict = Depends(require_user)) -> dict:
    """Lightweight poll target for the bell badge."""
    db = get_supabase()
    try:
        res = (
            db.table("notifications").select("id", count="exact")
            .eq("user_id", user["id"]).eq("read", False).execute()
        )
        return {"unread": res.count or 0}
    except Exception:
        return {"unread": 0}


@router.post("/{notification_id}/read")
async def mark_read(notification_id: str, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    try:
        db.table("notifications").update({"read": True}).eq(
            "id", notification_id
        ).eq("user_id", user["id"]).execute()
    except Exception:
        pass
    return {"ok": True}


@router.post("/read-all")
async def mark_all_read(user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    try:
        db.table("notifications").update({"read": True}).eq(
            "user_id", user["id"]
        ).eq("read", False).execute()
    except Exception:
        pass
    return {"ok": True}
