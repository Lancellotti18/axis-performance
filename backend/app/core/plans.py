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
from datetime import datetime, timedelta, timezone
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

# Statuses that keep the lights on outright.
ACTIVE_STATUSES = {"active", "trialing"}

# past_due is NOT open-ended access. A failed card is usually a dunning problem
# worth riding out — Stripe retries for days and most recover — but "keeps
# working indefinitely while not paying" is a free plan with extra steps, and
# nothing would stop someone generating reports forever on a dead card.
# So: a bounded grace window measured from the end of the period they actually
# paid for, then the account locks like any other unpaid one.
PAST_DUE_GRACE_DAYS = 5

# How many days before a grace window closes we start warning in the UI.
GRACE_WARNING_DAYS = 5


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
    # True when the only thing standing between the contractor and the action
    # is money they have not agreed to spend yet. The UI must PROMPT — "you are
    # out of included reports, buy one more for $35?" — and only proceed once
    # they accept. Never charge a card for something someone did not click.
    requires_purchase: bool = False
    purchase_price_usd: Optional[int] = None
    # Days left before a past_due grace window closes, for the UI banner.
    grace_days_left: Optional[int] = None


def _parse(ts) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None


def access_deadline(sub: dict) -> Optional[datetime]:
    """The moment access ends, in SERVER time.

    Read from current_period_end, which Stripe sets and we store. It is never
    derived from the caller's clock: a period boundary computed on the client
    could be moved by changing the date on a laptop, which would reset the
    report allowance on demand. It is also not the calendar month — a
    contractor who subscribes on the 20th gets the 20th to the 20th, matching
    what Stripe actually charges them for.
    """
    end = _parse(sub.get("current_period_end"))
    if end is None:
        return None
    if (sub.get("status") or "") == "past_due":
        # Grace runs from the end of the period they last paid for.
        return end + timedelta(days=PAST_DUE_GRACE_DAYS)
    return end


def period_bounds(sub: dict) -> tuple[Optional[datetime], Optional[datetime]]:
    """The billing period report usage is counted against. Server-side only."""
    return _parse(sub.get("current_period_start")), _parse(sub.get("current_period_end"))


def evaluate(sub: Optional[dict], action: Action, *, reports_used: int = 0,
             overage_purchased: int = 0, crews_used: int = 0,
             now: Optional[datetime] = None) -> Decision:
    """Decide whether `action` is permitted. Pure — no I/O, so it is testable.

    `now` is injectable for tests only; it defaults to server time and is never
    taken from a request.

    A missing subscription row is not an error: it is every contractor who has
    signed up and not yet paid, which is the population the promo flow serves.
    """
    sub = sub or {}
    now = now or datetime.now(timezone.utc)
    status = sub.get("status") or "none"
    plan_key = sub.get("plan_key")
    plan = PLANS.get(plan_key or "")

    deadline = access_deadline(sub)
    within_period = deadline is not None and deadline > now
    in_grace = status == "past_due" and within_period
    grace_left = (
        max(0, (deadline - now).days) if (in_grace and deadline) else None
    )

    def decide(ok: bool, reason: str, *, purchase: bool = False,
               price: Optional[int] = None) -> Decision:
        # In shadow mode allowed is always True; would_allow carries the verdict.
        return Decision(
            allowed=ok if enforcing() else True,
            reason=reason,
            would_allow=ok,
            plan_key=plan_key,
            status=status,
            requires_purchase=purchase,
            purchase_price_usd=price,
            grace_days_left=grace_left,
        )

    subscribed = (
        plan is not None
        and within_period
        and (status in ACTIVE_STATUSES or in_grace)
    )

    if action == "access_app":
        if subscribed:
            if in_grace:
                return decide(True, f"payment failed — {grace_left} days to update your card")
            return decide(True, "active subscription")
        if not sub.get("trial_report_used"):
            return decide(True, "promo: one free report not yet used")
        return decide(False, "no active subscription — account is view-only")

    if action == "generate_report":
        if not subscribed:
            if not sub.get("trial_report_used"):
                return decide(True, "promo: free report")
            return decide(False, "free report already used — a plan is required")

        # Everything the contractor is entitled to this period: what the plan
        # includes, plus any extra reports they have already bought and paid for.
        if plan.reports == UNLIMITED:
            return decide(True, f"{plan.name}: unlimited")
        entitled = plan.reports + max(0, overage_purchased)
        if reports_used < entitled:
            extra = f" (+{overage_purchased} purchased)" if overage_purchased else ""
            return decide(True, f"{plan.name}: {reports_used + 1} of {entitled}{extra}")

        # HARD STOP until they agree to the charge. The previous version billed
        # $35 silently the moment someone crossed the line, which is how a
        # contractor discovers a bill he never agreed to. The UI prompts; the
        # report is generated only after he accepts and the card is charged.
        return decide(
            False,
            f"{plan.name} includes {plan.reports} reports and you have used them all. "
            f"Buy another for ${OVERAGE_REPORT_USD}?",
            purchase=True, price=OVERAGE_REPORT_USD,
        )

    if action == "add_crew":
        if not subscribed:
            return decide(False, "dispatch crews require a plan")
        if plan.crews == UNLIMITED:
            return decide(True, f"{plan.name}: unlimited crews")
        if crews_used < plan.crews:
            return decide(True, f"{plan.name}: crew {crews_used + 1} of {plan.crews}")
        return decide(
            False,
            f"{plan.name} includes {plan.crews} crews. Upgrade to add a "
            f"{crews_used + 1}th.",
        )

    if action == "buy_lead":
        # Subscriber-only by decision: leads supplement a slow stretch for
        # someone already paying, which is what keeps this from being lead broking.
        if subscribed:
            return decide(True, f"{plan.name}: leads at ${LEAD_USD}",
                          purchase=True, price=LEAD_USD)
        return decide(False, "leads are available to subscribers only")

    return decide(True, f"unknown action {action!r} — allowed by default")

# ── Changing plans ────────────────────────────────────────────────────────

@dataclass
class PlanChange:
    allowed: bool
    reason: str
    # What the contractor has to do first, when a downgrade is blocked.
    remedy: Optional[str] = None


def can_change_plan(current_key: Optional[str], target_key: str, *,
                    crews_used: int = 0, reports_used: int = 0) -> PlanChange:
    """May this contractor move to `target_key` right now?

    Downgrades are BLOCKED rather than silently shrinking what someone has.
    Dropping Crew (6 crews) to Solo (3) with six crews on the dispatch board
    means three of them have to stop existing — and picking which ones is not a
    decision software should make quietly on a contractor's behalf, least of
    all in the middle of a work week. They delete down to the new limit first,
    so the choice is theirs and nothing disappears unannounced.

    Reports are not checked the same way: usage already spent this period is
    history, and a plan change does not un-generate reports.
    """
    target = PLANS.get(target_key)
    if target is None:
        return PlanChange(False, f"unknown plan {target_key!r}")
    if current_key == target_key:
        return PlanChange(False, f"already on {target.name}")

    current = PLANS.get(current_key or "")
    # No current plan, or moving up — always fine. Stripe prorates the
    # difference and the new allowance applies immediately.
    if current is None:
        return PlanChange(True, f"subscribing to {target.name}")

    moving_down = (
        target.monthly_usd < current.monthly_usd
        or (current.crews == UNLIMITED and target.crews != UNLIMITED)
    )
    if not moving_down:
        return PlanChange(True, f"upgrading to {target.name}")

    if target.crews != UNLIMITED and crews_used > target.crews:
        excess = crews_used - target.crews
        return PlanChange(
            False,
            f"{target.name} includes {target.crews} crews and you have {crews_used}.",
            remedy=(
                f"Remove {excess} crew{'s' if excess > 1 else ''} from Dispatch, "
                f"then switch to {target.name}."
            ),
        )

    # Downgrades take effect at the end of the period they already paid for,
    # never mid-cycle — they bought this month at this tier.
    return PlanChange(True, f"downgrading to {target.name} at the end of the current period")


# ── What the contractor is told when a card is declined ───────────────────
# One place, so the wording cannot drift between the report prompt, the lead
# purchase and Settings. Never blame them, never say "invalid"; a decline is
# usually the bank being cautious, and the useful next step is simply to retry
# or use a different card.
DECLINE_MESSAGE = (
    "That payment didn't go through. Your bank declined it — this is usually "
    "temporary and nothing to do with your account. You can try again, or use "
    "a different card."
)
SUPPORT_EMAIL = "lance@rwinfrastructure.com"
