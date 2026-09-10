"""What a contractor has used, and what it cost us.

Two audiences, deliberately split. `/usage/me` is what a contractor may see —
their own report count against their allowance. `/usage/costs` is the operator
view: spend by model and provider, which is how the Gemini-vs-Anthropic
question gets settled with numbers instead of estimates.

The allowance is reported but NOT enforced here. Enforcement belongs with
billing, once plans exist in Stripe; a metering endpoint that started rejecting
requests would be a surprising place to discover you had been cut off.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import require_user
from app.core.supabase import get_supabase

logger = logging.getLogger(__name__)
router = APIRouter()


def _period_start() -> str:
    """Start of the current calendar month, UTC.

    A calendar month is not the same as a Stripe billing anchor. When plans go
    live this must switch to the subscription's period start, or a contractor
    who signed up on the 20th gets a short first month.
    """
    now = datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()


@router.get("/me")
async def my_usage(user: dict = Depends(require_user)) -> dict:
    """This contractor's billable reports so far this period."""
    db = get_supabase()
    since = _period_start()
    try:
        rows = (
            db.table("report_events").select("id, run_id, created_at, bytes")
            .eq("user_id", user["id"]).eq("kind", "generate")
            .gte("created_at", since).execute().data
        ) or []
    except Exception as e:
        logger.info("usage lookup failed for %s: %s", user["id"], e)
        raise HTTPException(status_code=503, detail="Usage is unavailable right now.")

    return {
        "period_start": since,
        "reports_generated": len(rows),
        # Filled in from the contractor's plan once billing exists. Null means
        # "not yet metered against anything", which is honest; zero would read
        # as "you have no allowance".
        "reports_included": None,
        "storage_bytes": sum(r.get("bytes") or 0 for r in rows),
    }


@router.get("/costs")
async def cost_breakdown(user: dict = Depends(require_user)) -> dict:
    """AI spend this period, grouped by model — the operator view.

    Currently readable by any signed-in user. Gate it behind an admin check
    before there is a second contractor on the platform.
    """
    db = get_supabase()
    since = _period_start()
    try:
        rows = (
            db.table("llm_usage")
            .select("provider, model, kind, input_tokens, output_tokens, cost_usd")
            .gte("created_at", since).limit(10000).execute().data
        ) or []
    except Exception as e:
        logger.info("cost lookup failed: %s", e)
        raise HTTPException(status_code=503, detail="Cost data is unavailable right now.")

    by_model: dict[str, dict] = {}
    for r in rows:
        key = f"{r['provider']}/{r['model']}"
        agg = by_model.setdefault(key, {
            "provider": r["provider"], "model": r["model"],
            "calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0,
        })
        agg["calls"] += 1
        agg["input_tokens"] += r.get("input_tokens") or 0
        agg["output_tokens"] += r.get("output_tokens") or 0
        agg["cost_usd"] += float(r.get("cost_usd") or 0)

    for agg in by_model.values():
        agg["cost_usd"] = round(agg["cost_usd"], 4)

    total = round(sum(a["cost_usd"] for a in by_model.values()), 4)

    # Billable reports this period, so cost-per-report is a measured number
    # rather than the estimate it has been until now.
    try:
        reports = len((
            db.table("report_events").select("id")
            .eq("kind", "generate").gte("created_at", since).execute().data
        ) or [])
    except Exception:
        reports = 0

    return {
        "period_start": since,
        "total_cost_usd": total,
        "total_calls": len(rows),
        "reports_generated": reports,
        "cost_per_report_usd": round(total / reports, 4) if reports else None,
        "by_model": sorted(by_model.values(), key=lambda a: -a["cost_usd"]),
    }
