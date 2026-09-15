"""What each plan includes, and whether a contractor may do a thing.

Limits live here rather than in the database because they are business logic:
they change with a deploy, they are reviewed in a diff, and the check that
enforces them sits next to them. Prices live in Stripe, which is the only
system that can charge a card. `plan_key` is the join between the two.

ENFORCEMENT IS OFF BY DEFAULT. `BILLING_ENFORCE` must be explicitly set to
true. Until then every check returns allowed=True and records what it WOULD
have blocked, so "would this lock out someone who should have access?" is
answered from real traffic before anyone is denied. This is the pattern the
auth rollout used, and the reason it did not take the app down twice.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal, Optional

logger = logging.getLogger(__name__)

Action = Literal["access_app", "generate_report", "add_crew", "buy_lead"]

# Sentinel for Fleet. Fair use is stated in the Terms — "unlimited for your own
# business's jobs" — and is a contractual limit, not one enforced by a number.
UNLIMITED = -1


@dataclass(frozen=True)
class Plan:
    key: str
    name: str
    monthly_usd: int
    annual_usd: int          # two months free
    reports: int
    crews: int


PLANS: dict[str, Plan] = {
    "solo":  Plan("solo",  "Solo",  299, 2990, reports=15,        crews=3),
    "crew":  Plan("crew",  "Crew",  449, 4490, reports=30,        crews=6),
    "fleet": Plan("fleet", "Fleet", 599, 5990, reports=UNLIMITED, crews=UNLIMITED),
}

OVERAGE_REPORT_USD = 35
LEAD_USD = 50

# Stripe statuses that keep the lights on. 'past_due' is deliberately included:
# a card that failed this morning is a dunning problem, and locking someone out
# of software they are still paying for is how a recoverable billing hiccup
# becomes a cancellation. Stripe retries for days; let it.
ACTIVE_STATUSES = {"active", "trialing", "past_due"}


def enforcing() -> bool:
    """Read at call time, not import time — Render's environment is not
    reliably visible to pydantic-settings at startup (see visualizer_service
    and the health-secret incident)."""
    return (os.environ.get("BILLING_ENFORCE") or "").strip().lower() in {"1", "true", "yes"}


@dataclass
class Decision:
    allowed: bool
    reason: str
    # What the answer WOULD be under enforcement. Differs from `allowed`
    # only while shadow mode is on — that gap is the whole point.
    would_allow: bool
    plan_key: Optional[str] = None
    status: Optional[str] = None


def _period_active(sub: dict) -> bool:
    end = sub.get("current_period_end")
    if not end:
        return False
    try:
        dt = datetime.fromisoformat(str(end).replace("Z", "+00:00"))
    except ValueError:
        return False
    return dt > datetime.now(timezone.utc)


def evaluate(sub: Optional[dict], action: Action, *, reports_used: int = 0,
             crews_used: int = 0) -> Decision:
    """Decide whether `action` is permitted. Pure — no I/O, so it is testable.

    A missing subscription row is not an error: it is every contractor who has
    signed up and not yet paid, which is the population the promo flow exists
    to serve.
    """
    sub = sub or {}
    status = sub.get("status") or "none"
    plan_key = sub.get("plan_key")
    plan = PLANS.get(plan_key or "")

    def decide(ok: bool, reason: str) -> Decision:
        # In shadow mode allowed is always True; would_allow carries the verdict.
        return Decision(allowed=ok if enforcing() else True, reason=reason,
                        would_allow=ok, plan_key=plan_key, status=status)

    subscribed = status in ACTIVE_STATUSES and plan is not None and _period_active(sub)

    if action == "access_app":
        if subscribed:
            return decide(True, "active subscription")
        if not sub.get("trial_report_used"):
            return decide(True, "promo: one free report not yet used")
        return decide(False, "no active subscription — account is view-only")

    if action == "generate_report":
        if not subscribed:
            if not sub.get("trial_report_used"):
                return decide(True, "promo: free report")
            return decide(False, "free report already used — a plan is required")
        if plan.reports == UNLIMITED:
            return decide(True, f"{plan.name}: unlimited")
        if reports_used < plan.reports:
            return decide(True, f"{plan.name}: {reports_used + 1} of {plan.reports}")
        # Over the included allowance is NOT a denial — it is billable overage
        # at $35. Blocking here would stop a contractor mid-bid over money they
        # are willing to spend.
        return decide(True, f"{plan.name}: allowance used, billing as overage "
                            f"(${OVERAGE_REPORT_USD})")

    if action == "add_crew":
        if not subscribed:
            return decide(False, "dispatch crews require a plan")
        if plan.crews == UNLIMITED or crews_used < plan.crews:
            return decide(True, f"{plan.name}: {crews_used + 1} of "
                                f"{'unlimited' if plan.crews == UNLIMITED else plan.crews}")
        return decide(False, f"{plan.name} includes {plan.crews} crews — upgrade to add more")

    if action == "buy_lead":
        # Subscriber-only, by decision: leads supplement a slow stretch for
        # someone already paying, which is what keeps this from being lead broking.
        if subscribed:
            return decide(True, f"{plan.name}: leads at ${LEAD_USD}")
        return decide(False, "leads are available to subscribers only")

    return decide(True, f"unknown action {action!r} — allowed by default")
