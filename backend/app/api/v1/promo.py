"""Company promo codes, founding members, and the Founders & Trials view.

A code (FORTITUDE, ROOFPRO, ...) is made for one company and works once: the
first account that redeems it gets the code's free reports and days of full
access, counted from that moment, and becomes a founding member for good.

Admin endpoints are limited to settings.ADMIN_USER_IDS (Ryan's accounts).
"""
from __future__ import annotations

import logging
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field

from app.core.auth import get_current_user, require_user, security
from app.core.plans import enforcing, promo_state
from app.core.supabase import get_supabase

logger = logging.getLogger(__name__)

router = APIRouter()
# Scheduled jobs: authenticated by the shared health secret, not a user JWT.
ops_router = APIRouter()

CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9-]{2,31}$")
DEFAULT_UNREDEEMED_DAYS = 60

# Guessing defence. Company names are public, so a bare code like FORTITUDE is
# guessable by anyone who knows who was emailed. Codes get a random suffix
# (FORTITUDE-K7Q2M) and failed attempts are limited per account.
SUFFIX_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"      # no 0/O/1/I/L
MAX_FAILED_REDEEMS = 8
FAILED_WINDOW_S = 3600.0
_failed_redeems: dict[str, list[float]] = {}

# The lock runs on every feature request. Its answer is kept for a few seconds
# per account instead of costing a database read (and, in shadow mode, a log
# write) on each call. Redeeming clears the account's entry immediately.
ACCESS_TTL_S = 20.0
_access_cache: dict[str, tuple[float, bool, Optional[dict]]] = {}


def invalidate_access(uid) -> None:
    _access_cache.pop(str(uid), None)


def _failures(uid) -> list[float]:
    now = time.monotonic()
    recent = [t for t in _failed_redeems.get(str(uid), []) if now - t < FAILED_WINDOW_S]
    _failed_redeems[str(uid)] = recent
    return recent


def _fail(uid, status: int, detail: str):
    """Count a failed redeem against the account, then refuse."""
    _failures(uid).append(time.monotonic())
    if len(_failed_redeems) > 20000:
        _failed_redeems.clear()
    raise HTTPException(status_code=status, detail=detail)


def normalize_code(raw: str) -> str:
    return re.sub(r"\s+", "", (raw or "")).upper()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse(v) -> Optional[datetime]:
    if not v:
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# ── The lock ──────────────────────────────────────────────────────────────

async def require_app_access(
    credentials: Optional[HTTPAuthorizationCredentials] = Security(security),
) -> None:
    """Router-level guard: a signed-in contractor with neither an active
    subscription nor a running promo cannot use the app's features.

    Requests WITHOUT a token pass through untouched, so the homeowner-facing
    public endpoints that live on the same routers (instant quotes, proposal
    links, booking) keep working; any endpoint that needs a user still
    enforces its own auth. While BILLING_ENFORCE is off this only records what
    it would have blocked, exactly like the report gate.
    """
    if credentials is None:
        return
    try:
        user = await get_current_user(credentials)
    except HTTPException:
        return                       # the endpoint's own auth answers this one
    from app.services import entitlement
    uid = str(user["id"])
    hit = _access_cache.get(uid)
    if hit and time.monotonic() - hit[0] < ACCESS_TTL_S:
        if hit[1]:
            return
        raise HTTPException(status_code=402, detail=hit[2])
    db = get_supabase()
    try:
        decision = entitlement.check(db, uid, "access_app")
    except Exception as e:
        # The lock must never be what takes the app down.
        logger.warning("access check failed for %s, allowing: %s", uid, e)
        return
    detail = None
    if not decision.allowed:
        sub = entitlement.load_subscription(db, uid)
        detail = {"error": "access_required", "reason": decision.reason, "promo": promo_state(sub)}
    if len(_access_cache) > 5000:
        _access_cache.clear()
    _access_cache[uid] = (time.monotonic(), decision.allowed, detail)
    if detail is not None:
        raise HTTPException(status_code=402, detail=detail)


# ── Redeeming ─────────────────────────────────────────────────────────────

class RedeemRequest(BaseModel):
    code: str = Field(..., min_length=3, max_length=40)


@router.post("/redeem")
async def redeem(body: RedeemRequest, user: dict = Depends(require_user)) -> dict:
    """Redeem a company code on the signed-in account.

    Claimed with a conditional update (only while redeemed_by is still empty),
    so if two people race for one code exactly one of them gets it.
    """
    uid = user["id"]
    if len(_failures(uid)) >= MAX_FAILED_REDEEMS:
        raise HTTPException(status_code=429, detail="Too many attempts. Please try again in an hour.")
    code = normalize_code(body.code)
    if not CODE_RE.match(code):
        _fail(uid, 400, "That doesn't look like a valid code.")
    db = get_supabase()

    rows = db.table("promo_codes").select("*").eq("code", code).limit(1).execute().data or []
    if not rows:
        _fail(uid, 404, "That code wasn't found. Check the spelling and try again.")
    pc = rows[0]
    if pc.get("redeemed_by"):
        if str(pc["redeemed_by"]) == str(uid):
            raise HTTPException(status_code=409, detail="You've already redeemed this code.")
        _fail(uid, 409, "This code has already been used.")
    exp = _parse(pc.get("expires_at"))
    if exp is not None and exp <= _now():
        _fail(uid, 410, "This code has expired.")

    sub_rows = (db.table("subscriptions").select("*").eq("user_id", uid).limit(1)
                .execute().data) or []
    sub = sub_rows[0] if sub_rows else {}
    if sub.get("promo_access_until"):
        raise HTTPException(status_code=409, detail="This account has already used a promo code.")

    now = _now()
    claimed = (db.table("promo_codes").update({"redeemed_by": uid, "redeemed_at": now.isoformat()})
               .eq("id", pc["id"]).is_("redeemed_by", "null").execute().data)
    if not claimed:
        _fail(uid, 409, "This code has already been used.")

    reports = int(pc.get("free_reports") or 0)
    days = int(pc.get("access_days") or 0)
    until = now + timedelta(days=days)
    fields = {
        "promo_code": code,
        "promo_reports_left": reports,
        "promo_reports_total": reports,
        "promo_access_until": until.isoformat(),
        "founding_member": True,
        "founder_since": now.isoformat(),
        "updated_at": "now()",
    }
    # Applied only if the account has no promo yet, in one conditional write, so
    # two codes entered at once on one account cannot both land. If anything
    # fails after the code was claimed, the claim is released: a code must never
    # be burned without giving the account what it promised.
    try:
        if sub_rows:
            applied = (db.table("subscriptions").update(fields).eq("user_id", uid)
                       .is_("promo_access_until", "null").execute().data)
        else:
            applied = db.table("subscriptions").insert({"user_id": uid, **fields}).execute().data
    except Exception as e:
        logger.warning("promo apply failed for %s: %s", uid, e)
        applied = None
    if not applied:
        try:
            db.table("promo_codes").update({"redeemed_by": None, "redeemed_at": None}) \
                .eq("id", pc["id"]).eq("redeemed_by", uid).execute()
        except Exception as e:
            logger.error("promo code %s claimed by %s but not released: %s", code, uid, e)
        raise HTTPException(status_code=409,
                            detail="We couldn't apply this code to your account. Please try again.")
    invalidate_access(uid)

    _send_welcome(db, uid, user.get("email") or "", pc.get("company"), reports, days, until)
    return {"redeemed": True, "code": code, "free_reports": reports, "access_days": days,
            "access_until": until.isoformat(), "founding_member": True}


def _send_welcome(db, uid: str, email: str, company, reports: int, days: int, until: datetime) -> None:
    from app.services import email_service
    try:
        subject, text = email_service.promo_welcome(company, reports, days, until.strftime("%B %-d"))
        if email_service.send(email, subject, text):
            db.table("subscriptions").update({"promo_welcome_sent_at": _now().isoformat()}) \
                .eq("user_id", uid).execute()
    except Exception as e:
        logger.info("promo welcome email not sent for %s: %s", uid, e)


# ── Trial-ended emails ────────────────────────────────────────────────────

def send_ended_emails(db, now: Optional[datetime] = None) -> int:
    """Email every account whose promo ended without a subscription, once.
    Called by the daily sweep. Returns how many were sent."""
    from app.services import email_service
    now = now or _now()
    rows = (db.table("subscriptions").select("*")
            .lt("promo_access_until", now.isoformat())
            .is_("promo_ended_sent_at", "null").execute().data) or []
    sent = 0
    for sub in rows:
        if sub.get("plan_key") and (sub.get("status") or "") in ("active", "trialing"):
            continue                     # subscribed in time: no "trial ended" email
        email = _email_for(db, sub["user_id"])
        used = int(sub.get("promo_reports_total") or 0) - int(sub.get("promo_reports_left") or 0)
        subject, text = email_service.promo_ended(max(0, used))
        if email_service.send(email, subject, text):
            db.table("subscriptions").update({"promo_ended_sent_at": now.isoformat()}) \
                .eq("user_id", sub["user_id"]).execute()
            sent += 1
    return sent


def _email_for(db, uid: str) -> str:
    try:
        u = db.auth.admin.get_user_by_id(uid)
        return getattr(getattr(u, "user", None), "email", "") or ""
    except Exception as e:
        logger.info("no email for %s: %s", uid, e)
        return ""


@ops_router.post("/promo-sweep")
async def sweep(x_health_secret: Optional[str] = Header(None)) -> dict:
    """Daily job (called by the health-check workflow): send trial-ended emails.
    Protected by the same shared secret as the deep health check."""
    import os
    import secrets as _secrets
    from app.core.config import settings
    secret = (os.environ.get("HEALTH_CHECK_SECRET") or settings.HEALTH_CHECK_SECRET or "").strip()
    if not secret or not _secrets.compare_digest((x_health_secret or "").strip(), secret):
        raise HTTPException(status_code=401, detail="Not authorized.")
    return {"ended_emails_sent": send_ended_emails(get_supabase())}


# ── Admin: codes and the Founders & Trials view ───────────────────────────

def require_admin(user: dict = Depends(require_user)) -> dict:
    from app.services.entitlement import is_admin
    if not is_admin(user.get("id")):
        raise HTTPException(status_code=403, detail="Not available.")
    return user


class CreateCode(BaseModel):
    code: str = Field(..., min_length=3, max_length=32)
    company: str = Field(..., min_length=1, max_length=120)
    free_reports: int = Field(3, ge=0, le=50)
    access_days: int = Field(7, ge=0, le=90)
    expires_in_days: int = Field(DEFAULT_UNREDEEMED_DAYS, ge=1, le=365)
    notes: Optional[str] = Field(None, max_length=500)


@router.post("/admin/codes")
async def create_code(body: CreateCode, admin: dict = Depends(require_admin)) -> dict:
    base = re.sub(r"[^A-Z0-9]", "", normalize_code(body.code))[:20]
    if len(base) < 3:
        raise HTTPException(status_code=400, detail="Use at least 3 letters or numbers for the name.")
    db = get_supabase()
    code = ""
    for _ in range(8):
        cand = f"{base}-" + "".join(secrets.choice(SUFFIX_ALPHABET) for _ in range(5))
        if not db.table("promo_codes").select("id").eq("code", cand).limit(1).execute().data:
            code = cand
            break
    if not code:
        raise HTTPException(status_code=500, detail="Could not generate a unique code. Try again.")
    row = {"code": code, "company": body.company.strip(), "free_reports": body.free_reports,
           "access_days": body.access_days, "notes": body.notes,
           "expires_at": (_now() + timedelta(days=body.expires_in_days)).isoformat()}
    created = db.table("promo_codes").insert(row).execute().data or [row]
    return created[0]


@router.get("/admin/founders")
async def founders(admin: dict = Depends(require_admin)) -> dict:
    """Every code, who redeemed it, where their trial stands, whether they
    subscribed, and every report they have made."""
    db = get_supabase()
    codes = db.table("promo_codes").select("*").order("created_at", desc=True).execute().data or []
    now = _now()
    out = []
    for pc in codes:
        uid = pc.get("redeemed_by")
        entry = {
            "code": pc["code"], "company": pc["company"],
            "free_reports": pc.get("free_reports"), "access_days": pc.get("access_days"),
            "created_at": pc.get("created_at"), "expires_at": pc.get("expires_at"),
            "redeemed_at": pc.get("redeemed_at"),
            "state": "unused",
            "account_email": None, "promo": None, "subscribed": False, "plan_key": None,
            "reports": [],
        }
        exp = _parse(pc.get("expires_at"))
        if not uid:
            entry["state"] = "expired" if (exp is not None and exp <= now) else "unused"
            out.append(entry)
            continue
        subs = db.table("subscriptions").select("*").eq("user_id", uid).limit(1).execute().data or []
        sub = subs[0] if subs else {}
        promo = promo_state(sub, now)
        subscribed = bool(sub.get("plan_key")) and (sub.get("status") or "") in ("active", "trialing", "past_due")
        entry.update({
            "account_email": _email_for(db, uid),
            "promo": promo,
            "subscribed": subscribed,
            "plan_key": sub.get("plan_key"),
            "state": "subscribed" if subscribed else ("trial" if promo["active"] else "trial ended"),
            "reports": _reports_for(db, uid),
        })
        out.append(entry)
    return {"codes": out, "enforcing": enforcing()}


def _reports_for(db, uid: str) -> list[dict]:
    """Every report this account generated: address and date, newest first."""
    try:
        ev = (db.table("report_events").select("run_id, kind, created_at")
              .eq("user_id", uid).eq("kind", "generate").order("created_at", desc=True)
              .limit(100).execute().data) or []
    except Exception as e:
        logger.info("report list failed for %s: %s", uid, e)
        return []
    run_ids = list({e["run_id"] for e in ev if e.get("run_id")})
    names: dict = {}
    if run_ids:
        try:
            runs = db.table("roof_measurement_runs").select("id, project_id").in_("id", run_ids).execute().data or []
            pids = list({r["project_id"] for r in runs if r.get("project_id")})
            projs = (db.table("projects").select("id, name").in_("id", pids).execute().data or []) if pids else []
            pname = {p["id"]: p.get("name") for p in projs}
            names = {r["id"]: pname.get(r.get("project_id")) for r in runs}
        except Exception as e:
            logger.info("report addresses failed for %s: %s", uid, e)
    return [{"run_id": e.get("run_id"), "address": names.get(e.get("run_id")) or "—",
             "created_at": e.get("created_at")} for e in ev]
