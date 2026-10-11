"""Does this contractor get to do this, and what has he used so far?

The decision itself lives in app/core/plans.evaluate() — pure, no I/O, and
tested in isolation. This module is the part that has to touch the database:
it loads the subscription, counts what has been used against the CURRENT
billing period, asks plans.evaluate(), and records what enforcement would have
blocked while the flag is still off.

Counting lives here rather than in plans.py on purpose. plans.py stays pure so
the rules can be tested without a database, and this stays thin so the queries
can be read in one sitting.

WHILE BILLING_ENFORCE IS OFF nothing here denies anything. `allowed` comes back
True and the verdict is carried on `would_allow`, with the gap written to
entitlement_denials — which is the data that answers "would turning this on
have locked out somebody who should have access?" before anyone is locked out.
"""
from __future__ import annotations

import logging
import time
from typing import Optional

from app.core.plans import Action, Decision, evaluate, enforcing, period_bounds, promo_state

logger = logging.getLogger(__name__)


def is_admin(user_id: str) -> bool:
    from app.core.config import settings
    ids = {x.strip() for x in (settings.ADMIN_USER_IDS or "").split(",") if x.strip()}
    return str(user_id or "") in ids


def load_subscription(db, user_id: str) -> Optional[dict]:
    try:
        rows = (db.table("subscriptions").select("*")
                .eq("user_id", user_id).limit(1).execute().data) or []
        return rows[0] if rows else None
    except Exception as e:
        # A contractor with no row is the normal pre-payment case and is not an
        # error. A LOOKUP FAILURE is different, but it must not take the app
        # down: it degrades to "no subscription", which in shadow mode still
        # allows everything and in enforced mode fails closed by design.
        logger.info("subscription lookup failed for %s: %s", user_id, e)
        return None


def reports_used(db, user_id: str, sub: Optional[dict]) -> int:
    """Billable reports this contractor has generated in the current period.

    Counts report_events, which is the meter that already exists — this adds no
    second count that could drift from it. Only 'generate' rows count; a
    'rebuild' is re-downloading a report they already paid for.

    The window is the STRIPE period, never a calendar month, so a contractor
    who subscribes on the 20th gets the 20th to the 20th and there is no
    client-supplied date anywhere in the query to tamper with.
    """
    start, end = period_bounds(sub or {})
    if start is None:
        # No period: either unsubscribed, or a row whose period never got
        # written. Neither can be counted against an allowance, and the promo
        # branch in evaluate() is what handles the unsubscribed case.
        return 0
    try:
        q = (db.table("report_events").select("id")
             .eq("user_id", user_id).eq("kind", "generate")
             .gte("created_at", start.isoformat()))
        if end is not None:
            q = q.lt("created_at", end.isoformat())
        return len(q.execute().data or [])
    except Exception as e:
        # Fail to ZERO, which over-grants rather than wrongly blocking. A
        # contractor denied a report he paid for is a lost customer; one who
        # gets an extra during a database blip costs $35 of margin.
        logger.info("report count failed for %s: %s", user_id, e)
        return 0


def overage_purchased(db, user_id: str, sub: Optional[dict]) -> int:
    """Extra reports bought AND paid for in the current period.

    Only 'succeeded' rows count, so a pending intent or a declined card grants
    nothing. Matched on period_end, which was copied from the subscription when
    the purchase was made, so a renewal cannot retroactively extend a top-up.
    """
    _, end = period_bounds(sub or {})
    if end is None:
        return 0
    try:
        rows = (db.table("overage_purchases").select("quantity")
                .eq("user_id", user_id).eq("status", "succeeded")
                .eq("period_end", end.isoformat()).execute().data) or []
        return sum(int(r.get("quantity") or 0) for r in rows)
    except Exception as e:
        logger.info("overage count failed for %s: %s", user_id, e)
        return 0


def crews_used(db, user_id: str) -> int:
    """How many dispatch crews this account has on its board.

    This asked for a table "sched_crews" and a column "user_id"; neither has
    ever existed (they are sched_crew and org_id), so every call raised, hit
    the except, and returned 0 — the crew allowance counted nothing and the
    downgrade warning never fired.

    Scoped by ORG, not by user id: dispatch rows are keyed by org_id, which is
    the caller's user id for everyone except the legacy board's owners.

    ACTIVE crews only. Retiring a crew sets is_active False rather than
    deleting it, because sched_assignment cascades and hard deletion would
    strip the crew off historical jobs. A retired crew must not keep eating
    the plan's allowance.

    Best-effort: a count that fails is better than a check that raises, and it
    fails to ZERO, which over-grants rather than wrongly blocking.
    """
    try:
        from app.api.v1.scheduling import org_for
        org = org_for({"id": user_id})
        rows = (db.table("sched_crew").select("id")
                .eq("org_id", org).eq("is_active", True)
                .execute().data) or []
        return len(rows)
    except Exception as e:
        logger.info("crew count failed for %s: %s", user_id, e)
        return 0


def check(db, user_id: str, action: Action, *,
          sub: Optional[dict] = None) -> Decision:
    """The one entry point. Loads usage, decides, and logs a shadow denial."""
    if is_admin(user_id):
        # Ryan's own accounts run the business; the lock must never shut him out.
        return Decision(allowed=True, reason="admin account", would_allow=True, plan_key="admin")
    if sub is None:
        sub = load_subscription(db, user_id)

    used = purchased = crews = 0
    if action == "generate_report":
        used = reports_used(db, user_id, sub)
        purchased = overage_purchased(db, user_id, sub)
    elif action == "add_crew":
        crews = crews_used(db, user_id)

    decision = evaluate(sub, action, reports_used=used,
                        overage_purchased=purchased, crews_used=crews)

    # The gap between allowed and would_allow only exists in shadow mode, and
    # it is the whole reason this is safe to ship turned off.
    if not decision.would_allow:
        _record_denial(db, user_id, action, decision)
    return decision


def usage_summary(db, user_id: str, sub: Optional[dict] = None) -> dict:
    """What Settings and the report prompt both render. One source, so the
    number in the banner and the number the gate enforces cannot disagree."""
    from app.core.plans import PLANS, UNLIMITED

    if sub is None:
        sub = load_subscription(db, user_id)
    used = reports_used(db, user_id, sub)
    purchased = overage_purchased(db, user_id, sub)
    start, end = period_bounds(sub or {})
    plan = PLANS.get((sub or {}).get("plan_key") or "")

    included = plan.reports if plan else 0
    unlimited = bool(plan and plan.reports == UNLIMITED)
    entitled = None if unlimited else (max(0, included) + purchased)

    return {
        "reports_used": used,
        "reports_included": None if unlimited else included,
        "reports_unlimited": unlimited,
        "overage_purchased": purchased,
        "reports_entitled": entitled,
        "reports_remaining": None if unlimited else max(0, (entitled or 0) - used),
        "period_start": start.isoformat() if start else None,
        "period_end": end.isoformat() if end else None,
        "plan_key": (sub or {}).get("plan_key"),
        "status": (sub or {}).get("status") or "none",
        "trial_report_used": bool((sub or {}).get("trial_report_used")),
        "promo": promo_state(sub),
    }


def consume_promo_report(db, user_id: str) -> None:
    """Use one of a promo account's free reports. Called when an unsubscribed
    contractor's run becomes billable.

    Compare-and-set on the current count, so two reports finishing at once
    cannot both spend the same free report (and the count never goes below 0).
    """
    for _ in range(3):
        try:
            rows = (db.table("subscriptions").select("promo_reports_left")
                    .eq("user_id", user_id).limit(1).execute().data) or []
            if not rows:
                return
            left = int(rows[0].get("promo_reports_left") or 0)
            if left <= 0:
                return
            res = (db.table("subscriptions").update(
                {"promo_reports_left": left - 1, "updated_at": "now()"})
                .eq("user_id", user_id).eq("promo_reports_left", left).execute())
            if res.data:
                return
        except Exception as e:
            logger.info("could not use a promo report for %s: %s", user_id, e)
            return


def consume_trial_report(db, user_id: str) -> None:
    """Burn the one free report. Called when an unsubscribed contractor's run
    becomes billable, so the promo cannot be used twice.

    Upserts, because the contractor may have no subscriptions row at all yet —
    signing up does not create one.
    """
    try:
        db.table("subscriptions").upsert(
            {"user_id": user_id, "trial_report_used": True, "updated_at": "now()"},
            on_conflict="user_id",
        ).execute()
    except Exception as e:
        logger.info("could not mark the trial report used for %s: %s", user_id, e)


_denial_logged: dict[tuple[str, str], float] = {}
DENIAL_LOG_EVERY_S = 3600.0


def _record_denial(db, user_id: str, action: str, decision: Decision) -> None:
    """Write what enforcement would have done. Best-effort by design: losing a
    shadow log must never change what the contractor experiences.

    At most once an hour per account and action: the app-wide access check can
    fire on every request, and a log row per request from every non-subscriber
    would swamp the table with repeats of one fact."""
    key = (str(user_id), action)
    now = time.monotonic()
    last = _denial_logged.get(key)
    if last is not None and now - last < DENIAL_LOG_EVERY_S:
        return
    if len(_denial_logged) > 20000:
        _denial_logged.clear()
    _denial_logged[key] = now
    try:
        db.table("entitlement_denials").insert({
            "user_id": user_id,
            "action": action,
            "reason": decision.reason,
            "plan_key": decision.plan_key,
            "status": decision.status,
            "enforced": enforcing(),
        }).execute()
    except Exception as e:
        logger.info("entitlement denial not recorded for %s: %s", user_id, e)
