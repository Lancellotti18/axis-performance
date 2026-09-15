"""Plans, subscriptions, and payments.

Replaces the earlier 52-line scaffold, which was never mounted and had a
/portal endpoint that minted a billing-session URL for any customer id with no
auth at all.

The plan table in app/core/plans.py is the single source of truth for what a
tier costs and includes. The pricing page reads it from here rather than
hardcoding numbers — the live page had drifted to a $49 Solo and a free tier
that no longer existed anywhere else, because a second copy of the prices had
nothing tying it to the first.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends

from app.core.auth import require_user
from app.core.plans import (
    LEAD_EXCLUSIVITY_BODY,
    LEAD_EXCLUSIVITY_HEADLINE,
    LEAD_USD,
    OVERAGE_REPORT_USD,
    PLANS,
    UNLIMITED,
)
from app.core.supabase import get_supabase

logger = logging.getLogger(__name__)
router = APIRouter()

# What each tier gets, for the pricing page. Everything unmetered is listed on
# every plan on purpose: reports and crews are the only two meters, and the
# CRM, quote widget, compliance and visualizer cost essentially nothing to
# serve. Rationing them would throttle adoption of the features that make Axis
# hard to leave.
INCLUDED_EVERYWHERE = [
    "Instant quote widget for your website",
    "Full CRM — unlimited customers and jobs",
    "Dispatch board and scheduling",
    "Material compliance checks",
    "Storm risk reports",
    "Roof visualizer",
    "Homeowner proposals and share links",
]

TAGLINES = {
    "solo": "For an owner-operator running their own jobs.",
    "crew":  "For a growing shop with several crews in the field.",
    "fleet": "For established contractors who measure every roof they bid.",
}


def _plan_json(key: str) -> dict:
    p = PLANS[key]
    return {
        "key": p.key,
        "name": p.name,
        "tagline": TAGLINES.get(p.key, ""),
        "monthly_usd": p.monthly_usd,
        "annual_usd": p.annual_usd,
        # Stated explicitly so the page never has to compute a discount and
        # get it subtly wrong.
        "annual_monthly_equivalent": round(p.annual_usd / 12),
        "annual_months_free": 12 - (p.annual_usd // p.monthly_usd),
        "reports": None if p.reports == UNLIMITED else p.reports,
        "reports_unlimited": p.reports == UNLIMITED,
        "crews": None if p.crews == UNLIMITED else p.crews,
        "crews_unlimited": p.crews == UNLIMITED,
        "included": INCLUDED_EVERYWHERE,
    }


@router.get("/plans")
async def list_plans() -> dict:
    """Public. The pricing page renders entirely from this.

    Unauthenticated because the pricing page is public — someone deciding
    whether to sign up has no account yet.
    """
    return {
        "plans": [_plan_json(k) for k in ("solo", "crew", "fleet")],
        "overage_report_usd": OVERAGE_REPORT_USD,
        "lead_usd": LEAD_USD,
        # There is no free tier. Stated as data rather than left implied, so a
        # page cannot quietly reintroduce one.
        "free_tier": False,
        "promo": {
            "reports": 1,
            "note": "New accounts get one free roof report. A plan is required after that.",
        },
        "leads": {
            "headline": LEAD_EXCLUSIVITY_HEADLINE,
            "body": LEAD_EXCLUSIVITY_BODY,
            "price_usd": LEAD_USD,
            "subscribers_only": True,
        },
    }


@router.get("/me")
async def my_billing(user: dict = Depends(require_user)) -> dict:
    """This contractor's current plan and entitlement state."""
    db = get_supabase()
    try:
        rows = (
            db.table("subscriptions").select("*").eq("user_id", user["id"]).limit(1)
            .execute().data
        ) or []
    except Exception as e:
        logger.info("subscription lookup failed for %s: %s", user["id"], e)
        rows = []
    sub = rows[0] if rows else None
    plan_key = (sub or {}).get("plan_key")
    return {
        "subscription": sub,
        "plan": _plan_json(plan_key) if plan_key in PLANS else None,
        "has_plan": bool(plan_key),
        "trial_report_used": bool((sub or {}).get("trial_report_used")),
    }
