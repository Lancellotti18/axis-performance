"""Terms of Service / Privacy Policy acceptance.

A contractor must accept both documents before they can use Axis. This router
is the authority on WHICH versions are current — the client never sends a
version number, because a client that chose its own version could "accept"
an obsolete document and satisfy the gate forever.

Bump CURRENT_TOS_VERSION / CURRENT_PRIVACY_VERSION when a document changes in
a way that requires fresh consent (pricing terms, data licensing, liability).
Every contractor is then re-prompted on their next page load. Cosmetic edits
— typos, formatting — should NOT bump the version.

Defensive by design, with one deliberate exception: if the table is missing,
reads report `storage_ready: false` and do NOT gate, so a un-run migration
cannot lock every contractor out of the product. That also means the gate is
INERT until the migration runs — check `storage_ready` before trusting it.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.core.auth import require_user
from app.core.supabase import get_supabase

logger = logging.getLogger(__name__)
router = APIRouter()

# Both documents were published together on 2026-09-07.
CURRENT_TOS_VERSION = "2026-09-07"
CURRENT_PRIVACY_VERSION = "2026-09-07"


# The exact wording shown beside the marketing checkbox. Stored with each
# consent row, because under the TCPA the defence is being able to show what
# someone agreed to. Change this and the constant changes with it, so old rows
# keep the sentence that was actually on screen when they ticked the box.
MARKETING_CONSENT_TEXT = (
    "Send me occasional texts and emails about Axis features, pricing and "
    "promotions. Optional — you can use Axis either way, and unsubscribe anytime."
)


class AcceptRequest(BaseModel):
    """The client asserts consent to both documents. It does not get to say
    which version — the server stamps the versions it currently requires.

    `accept_marketing` is deliberately separate and defaults to False. It is
    permission to solicit, not a contract term: the TCPA forbids conditioning
    a product on it, so it never gates acceptance and its absence is normal."""
    accept_tos: bool
    accept_privacy: bool
    accept_marketing: bool = False


def _missing_table(err: Exception) -> bool:
    """True when the failure is 'legal_acknowledgments does not exist' rather
    than a real query error. PostgREST reports it as PGRST205 / 42P01."""
    s = str(err).lower()
    return "legal_acknowledgments" in s and (
        "does not exist" in s or "could not find" in s or "42p01" in s or "pgrst205" in s
    )


@router.get("/acknowledgment")
async def get_acknowledgment(user: dict = Depends(require_user)) -> dict:
    """Has this contractor accepted the versions that are current right now?

    `required: true` means the frontend must show the blocking gate.
    """
    db = get_supabase()
    try:
        rows = (
            db.table("legal_acknowledgments")
            .select("tos_version, privacy_version, accepted_at")
            .eq("user_id", user["id"])
            .eq("tos_version", CURRENT_TOS_VERSION)
            .eq("privacy_version", CURRENT_PRIVACY_VERSION)
            .limit(1)
            .execute()
            .data
        ) or []
    except Exception as e:
        if _missing_table(e):
            logger.warning(
                "legal_acknowledgments table missing — the ToS/Privacy gate is "
                "INERT. Run supabase/migrations/20260907_legal_acknowledgments.sql"
            )
            return {
                "required": False,
                "storage_ready": False,
                "tos_version": CURRENT_TOS_VERSION,
                "privacy_version": CURRENT_PRIVACY_VERSION,
                "accepted_at": None,
            }
        # A real query error must not silently waive consent, but it also must
        # not brick the app on a transient blip. Surface it as a 503 so the
        # frontend can retry rather than guess.
        logger.error("legal acknowledgment lookup failed: %s", e)
        raise HTTPException(status_code=503, detail="Could not check agreement status. Retry shortly.")

    accepted = rows[0] if rows else None
    return {
        "required": accepted is None,
        "storage_ready": True,
        "tos_version": CURRENT_TOS_VERSION,
        "privacy_version": CURRENT_PRIVACY_VERSION,
        "accepted_at": accepted.get("accepted_at") if accepted else None,
    }


@router.post("/acknowledgment")
async def accept_acknowledgment(
    body: AcceptRequest,
    request: Request,
    user: dict = Depends(require_user),
) -> dict:
    """Record acceptance of both current documents.

    Both flags must be true. Accepting only one is rejected — the frontend
    disables its button in that state, and the server does not trust that.
    """
    if not (body.accept_tos and body.accept_privacy):
        raise HTTPException(
            status_code=400,
            detail="Both the Terms of Service and the Privacy Policy must be accepted.",
        )

    db = get_supabase()
    record = {
        "user_id": user["id"],
        "tos_version": CURRENT_TOS_VERSION,
        "privacy_version": CURRENT_PRIVACY_VERSION,
        "ip_address": _client_ip(request),
        "user_agent": (request.headers.get("user-agent") or "")[:500] or None,
    }
    try:
        # Idempotent: re-accepting the same versions (double-click, second tab)
        # updates the existing row instead of failing on the unique index.
        db.table("legal_acknowledgments").upsert(
            record, on_conflict="user_id,tos_version,privacy_version"
        ).execute()
    except Exception as e:
        if _missing_table(e):
            logger.error(
                "legal_acknowledgments table missing — acceptance NOT recorded. "
                "Run supabase/migrations/20260907_legal_acknowledgments.sql"
            )
            raise HTTPException(
                status_code=503,
                detail="Agreement storage is not set up yet. Contact support.",
            )
        logger.error("legal acknowledgment write failed: %s", e)
        raise HTTPException(status_code=503, detail="Could not save your acceptance. Try again.")

    _record_marketing_consent(db, user["id"], body.accept_marketing, record)

    return {
        "ok": True,
        "tos_version": CURRENT_TOS_VERSION,
        "privacy_version": CURRENT_PRIVACY_VERSION,
        "marketing_consent": body.accept_marketing,
    }


def _record_marketing_consent(db, user_id: str, granted: bool, meta: dict) -> None:
    """Log marketing permission for both channels.

    A declined box is written as granted=False rather than skipped: "they said
    no" and "we never asked" are different facts, and only the first is a
    defence. Best-effort — a contractor must never be blocked from using Axis
    because a marketing row would not insert.
    """
    rows = [{
        "user_id": user_id,
        "channel": ch,
        "granted": bool(granted),
        "source": "signup_gate",
        "consent_text": MARKETING_CONSENT_TEXT,
        "ip_address": meta.get("ip_address"),
        "user_agent": meta.get("user_agent"),
    } for ch in ("sms", "email")]
    try:
        db.table("marketing_consent").insert(rows).execute()
    except Exception as e:
        logger.info("marketing consent not recorded for %s: %s", user_id, e)


def _client_ip(request: Request) -> Optional[str]:
    """Originating IP behind Render's proxy. X-Forwarded-For is a client-
    controlled header, so this is corroborating detail, not proof."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()[:64] or None
    return request.client.host[:64] if request.client else None
