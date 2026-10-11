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
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.core.auth import require_user
from app.core.plans import (
    promo_state,
    enforcing,
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


@router.get("/config")
async def billing_config() -> dict:
    """What the browser needs to render a payment form.

    Public, because the checkout page loads before anyone is charged and the
    publishable key is designed to be public — it can only tokenize a card, not
    charge, refund, or read a customer.

    Served here rather than baked in as a NEXT_PUBLIC_ build variable so that
    rotating the key is an environment change and a restart, not a rebuild and
    redeploy of the frontend.

    `test_mode` is surfaced so the UI can say so plainly. A checkout that looks
    identical in test and live is how a sandbox run quietly becomes a real
    charge.
    """
    from app.services import stripe_service
    pk = stripe_service.publishable_key()
    return {
        "publishable_key": pk or None,
        "configured": bool(pk and stripe_service.configured()),
        "test_mode": stripe_service.is_test_mode(),
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
        # The company-code trial: days and reports left, or ended. The app
        # shows the banner, and the "thank you, choose a plan" screen, from this.
        "promo": promo_state(sub),
        "founding_member": bool((sub or {}).get("founding_member")),
        "enforcing": enforcing(),
        "is_admin": _is_admin(user["id"]),
    }


def _is_admin(uid: str) -> bool:
    from app.services.entitlement import is_admin
    return is_admin(uid)


# ── Subscribing ───────────────────────────────────────────────────────────

class SubscribeRequest(BaseModel):
    """Which plan. Note what is NOT here: no customer id, no price id, no
    amount. The caller names a plan and nothing else — everything that decides
    what gets charged is resolved server-side from the plan table, so a
    tampered request cannot buy Fleet at Solo's price."""
    plan_key: str
    interval: str = "month"


@router.post("/subscribe")
async def subscribe(body: SubscribeRequest, user: dict = Depends(require_user)) -> dict:
    """Start a subscription and hand back a client secret for the card form.

    payment_behavior='default_incomplete' is what keeps the contractor inside
    Axis: Stripe creates the subscription unpaid, returns a PaymentIntent, and
    the Payment Element confirms it in the page. No redirect, and no plan is
    active until the card actually clears.
    """
    from app.services import stripe_service

    if body.plan_key not in PLANS:
        raise HTTPException(status_code=400, detail=f"Unknown plan {body.plan_key!r}.")
    if body.interval not in ("month", "year"):
        raise HTTPException(status_code=400, detail="Interval must be month or year.")

    db = get_supabase()
    rows = (db.table("subscriptions").select("*").eq("user_id", user["id"])
            .limit(1).execute().data) or []
    current = rows[0] if rows else None

    # Changing an existing plan is a different operation with different rules —
    # upgrades apply now, downgrades are scheduled, and a downgrade that strands
    # crews has to warn. Routing it through here would silently create a second
    # subscription and bill twice.
    if current and current.get("stripe_subscription_id") and \
            current.get("status") in ("active", "trialing", "past_due"):
        raise HTTPException(
            status_code=409,
            detail="You already have an active plan. Use Change plan in Settings.",
        )

    try:
        stripe = stripe_service.client()
        customer_id = stripe_service.ensure_customer(
            db, user["id"], user.get("email") or "", (user.get("user_metadata") or {}).get("full_name"))
        price = stripe_service.price_id(body.plan_key, body.interval)

        # An unpaid subscription from a previous attempt — a refreshed checkout
        # page, a closed tab, a second click. Creating another one leaves the
        # first orphaned in Stripe with a live PaymentIntent, and a contractor
        # with two tabs open could pay both and be charged twice.
        pending = _existing_incomplete(stripe, db, user["id"], customer_id)
        if pending is not None:
            same = (
                (pending.get("metadata") or {}).get("axis_plan_key") == body.plan_key
                and _interval_of(pending) == body.interval
            )
            if same:
                # Hand back the SAME PaymentIntent. Refreshing checkout must not
                # cost a new subscription object.
                secret = _client_secret_of(pending)
                if secret:
                    logger.info("reusing incomplete subscription %s for %s",
                                pending.get("id"), user["id"])
                    return {"requires_payment": True, "client_secret": secret,
                            "subscription_id": pending.get("id"),
                            "plan_key": body.plan_key, "interval": body.interval,
                            "reused": True}
            # Different plan: the old attempt is abandoned, so cancel it rather
            # than leaving a payable intent for a plan they no longer want.
            try:
                stripe.Subscription.delete(pending["id"])
                logger.info("cancelled abandoned incomplete subscription %s", pending["id"])
            except Exception as e:
                logger.warning("could not cancel %s: %s", pending.get("id"), e)

        sub = stripe.Subscription.create(
            customer=customer_id,
            items=[{"price": price}],
            payment_behavior="default_incomplete",
            payment_settings={"save_default_payment_method": "on_subscription"},
            expand=["latest_invoice.payment_intent"],
            metadata={"axis_user_id": user["id"], "axis_plan_key": body.plan_key},
        )
    except stripe_service.StripeNotConfigured as e:
        logger.error("subscribe blocked: %s", e)
        raise HTTPException(status_code=503, detail="Payments are not set up yet.")
    except Exception as e:
        logger.error("subscribe failed for %s: %s", user["id"], e)
        raise HTTPException(status_code=502, detail="Could not start the subscription.")

    # Record it immediately as incomplete. The webhook is the source of truth and
    # will overwrite this, but writing now means a contractor who closes the tab
    # mid-payment is not invisible to us.
    try:
        row = stripe_service.subscription_to_row(
            sub, plan_key=body.plan_key, interval=body.interval)
        row["user_id"] = user["id"]
        row["stripe_customer_id"] = customer_id
        db.table("subscriptions").upsert(row, on_conflict="user_id").execute()
    except Exception as e:
        logger.info("could not pre-record subscription for %s: %s", user["id"], e)

    invoice = sub.get("latest_invoice") or {}
    intent = invoice.get("payment_intent") or {}
    secret = intent.get("client_secret")
    if not secret:
        # An annual plan on a 100% coupon, or a $0 invoice, completes with no
        # payment step. Saying so beats handing the UI a null it will not expect.
        return {"requires_payment": False, "subscription_id": sub.get("id"),
                "status": sub.get("status")}

    return {
        "requires_payment": True,
        "client_secret": secret,
        "subscription_id": sub.get("id"),
        "plan_key": body.plan_key,
        "interval": body.interval,
    }


def _interval_of(sub) -> str | None:
    item = ((sub.get("items") or {}).get("data") or [{}])[0]
    return ((item.get("price") or {}).get("recurring") or {}).get("interval")


def _client_secret_of(sub) -> str | None:
    invoice = sub.get("latest_invoice") or {}
    return ((invoice.get("payment_intent") or {}) or {}).get("client_secret")


def _existing_incomplete(stripe, db, user_id: str, customer_id: str):
    """The contractor's unpaid subscription, if they have one.

    Asks Stripe rather than our own table on purpose: the table records the
    most recent attempt, so a second click has already overwritten any memory
    of the first. Stripe is the only place that knows about all of them.
    """
    try:
        subs = stripe.Subscription.list(
            customer=customer_id, status="incomplete", limit=5,
            expand=["data.latest_invoice.payment_intent"],
        ).data
    except Exception as e:
        logger.info("could not list incomplete subscriptions for %s: %s", user_id, e)
        return None
    return subs[0] if subs else None


# ── Saved cards ───────────────────────────────────────────────────────────

@router.get("/payment-methods")
async def list_payment_methods(user: dict = Depends(require_user)) -> dict:
    """Cards on file. Brand, last four and expiry only — a card number never
    reaches Axis, which is what keeps the platform out of PCI scope."""
    db = get_supabase()
    try:
        rows = (db.table("payment_methods").select(
            "id, stripe_payment_method_id, brand, last4, exp_month, exp_year, is_default")
            .eq("user_id", user["id"]).order("created_at", desc=True).execute().data) or []
    except Exception as e:
        logger.info("payment method lookup failed for %s: %s", user["id"], e)
        rows = []
    return {"payment_methods": rows}


@router.post("/payment-methods/setup-intent")
async def create_setup_intent(user: dict = Depends(require_user)) -> dict:
    """Client secret for adding a card without charging it.

    A SetupIntent rather than a PaymentIntent, because saving a card and taking
    money are different acts and conflating them is how people get charged for
    'just updating my card on file'.
    """
    from app.services import stripe_service
    db = get_supabase()
    try:
        stripe = stripe_service.client()
        customer_id = stripe_service.ensure_customer(
            db, user["id"], user.get("email") or "",
            (user.get("user_metadata") or {}).get("full_name"))
        intent = stripe.SetupIntent.create(
            customer=customer_id, usage="off_session",
            metadata={"axis_user_id": user["id"]})
    except stripe_service.StripeNotConfigured:
        raise HTTPException(status_code=503, detail="Payments are not set up yet.")
    except Exception as e:
        logger.error("setup intent failed for %s: %s", user["id"], e)
        raise HTTPException(status_code=502, detail="Could not start card setup.")
    return {"client_secret": intent.client_secret}


class PaymentMethodRef(BaseModel):
    """Our OWN row id, not Stripe's. Ownership is checked against it before
    anything is touched, so a caller cannot name a stranger's Stripe payment
    method and have Axis act on it."""
    id: str


@router.post("/payment-methods/default")
async def set_default_card(body: PaymentMethodRef, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    pm = _owned_payment_method(db, user["id"], body.id)
    from app.services import stripe_service
    try:
        stripe = stripe_service.client()
        sub_rows = (db.table("subscriptions").select("stripe_customer_id, stripe_subscription_id")
                    .eq("user_id", user["id"]).limit(1).execute().data) or []
        sub = sub_rows[0] if sub_rows else {}
        if sub.get("stripe_customer_id"):
            stripe.Customer.modify(
                sub["stripe_customer_id"],
                invoice_settings={"default_payment_method": pm["stripe_payment_method_id"]})
        # Renewals bill the SUBSCRIPTION's default, which is separate from the
        # customer's. Setting only one leaves the next invoice on the old card.
        if sub.get("stripe_subscription_id"):
            stripe.Subscription.modify(
                sub["stripe_subscription_id"],
                default_payment_method=pm["stripe_payment_method_id"])
    except Exception as e:
        logger.error("could not set default card for %s: %s", user["id"], e)
        raise HTTPException(status_code=502, detail="Could not update your default card.")

    db.table("payment_methods").update({"is_default": False}).eq("user_id", user["id"]).execute()
    db.table("payment_methods").update({"is_default": True}).eq("id", body.id).execute()
    return {"ok": True}


@router.post("/payment-methods/remove")
async def remove_card(body: PaymentMethodRef, user: dict = Depends(require_user)) -> dict:
    """Detach a card. Refused if it is the only card behind an active
    subscription — removing it would guarantee the next renewal fails, and
    silently doing that to someone is worse than telling them no."""
    db = get_supabase()
    pm = _owned_payment_method(db, user["id"], body.id)

    rows = (db.table("payment_methods").select("id").eq("user_id", user["id"])
            .execute().data) or []
    subs = (db.table("subscriptions").select("status").eq("user_id", user["id"])
            .limit(1).execute().data) or []
    active = (subs[0].get("status") if subs else "") in ("active", "trialing", "past_due")
    if active and len(rows) <= 1:
        raise HTTPException(
            status_code=409,
            detail="This is the only card on your account. Add another before "
                   "removing it, or cancel your plan first.")

    from app.services import stripe_service
    try:
        stripe_service.client().PaymentMethod.detach(pm["stripe_payment_method_id"])
    except Exception as e:
        logger.info("detach failed (continuing to remove locally): %s", e)
    db.table("payment_methods").delete().eq("id", body.id).execute()
    return {"ok": True}


def _owned_payment_method(db, user_id: str, row_id: str) -> dict:
    rows = (db.table("payment_methods").select("*")
            .eq("id", row_id).eq("user_id", user_id).limit(1).execute().data) or []
    if not rows:
        # 404 rather than 403: confirming a row exists but belongs to someone
        # else tells a prober something they should not learn.
        raise HTTPException(status_code=404, detail="Card not found.")
    return rows[0]


# ── Changing and cancelling a plan ────────────────────────────────────────

class ChangePlanRequest(BaseModel):
    plan_key: str
    # Optional: "month" or "year". Omitted keeps the current billing period.
    interval: str | None = None


# ── Stripe-side plumbing for plan changes ─────────────────────────────────
# A change that waits for the renewal (a downgrade, or annual -> monthly) has to
# be told to STRIPE, not just recorded in Axis. It used to be recorded only
# here: the renewal webhook flipped plan_key to the smaller plan while Stripe
# went on charging the old, bigger price, so a Fleet customer who downgraded
# to Solo got Solo's limits at Fleet's $599. A subscription schedule is how
# Stripe defers a price change to a period boundary, including a change of
# billing interval, which a plain Subscription.modify cannot defer.

def _price_id_of(item_price) -> str | None:
    if isinstance(item_price, str):
        return item_price
    return (item_price or {}).get("id")


def _release_schedule(stripe, remote) -> None:
    """Drop any pending deferred change so the subscription can be modified
    directly again (Stripe refuses cancel_at_period_end and most edits on a
    subscription a schedule controls)."""
    sched = remote.get("schedule") if hasattr(remote, "get") else None
    sched_id = sched.get("id") if isinstance(sched, dict) else sched
    if sched_id:
        try:
            stripe.SubscriptionSchedule.release(sched_id)
        except Exception as e:
            # Already released or completed: nothing left to undo.
            logger.info("schedule %s release skipped: %s", sched_id, e)


def _schedule_at_period_end(stripe, remote, *, current_plan: str, new_plan: str,
                            new_price: str) -> None:
    """At the next renewal, switch the subscription to new_price and stay there.

    Phase 1 is the period already paid for, unchanged. Phase 2 starts at its
    end on the new price; end_behavior=release hands the subscription back to
    ordinary renewals afterwards. The phase metadata is copied onto the
    subscription when the phase starts, which is how the webhook learns the
    new plan_key from Stripe itself."""
    sched = remote.get("schedule")
    sched_id = sched.get("id") if isinstance(sched, dict) else sched
    if sched_id:
        schedule = stripe.SubscriptionSchedule.retrieve(sched_id)
    else:
        schedule = stripe.SubscriptionSchedule.create(from_subscription=remote["id"])
    now_phase = schedule["phases"][0]
    stripe.SubscriptionSchedule.modify(
        schedule["id"],
        end_behavior="release",
        phases=[
            {"items": [{"price": _price_id_of(now_phase["items"][0]["price"]), "quantity": 1}],
             "start_date": now_phase["start_date"], "end_date": now_phase["end_date"],
             "metadata": {"axis_plan_key": current_plan}},
            {"items": [{"price": new_price, "quantity": 1}], "iterations": 1,
             "proration_behavior": "none",
             "metadata": {"axis_plan_key": new_plan}},
        ],
    )


def _write_schedule(db, user_id: str, fields: dict) -> None:
    """scheduled_interval arrived in a later migration. Until it has been run,
    drop it and write the rest, so a missing column degrades the Settings
    banner instead of failing a change Stripe has already accepted."""
    try:
        db.table("subscriptions").update(fields).eq("user_id", user_id).execute()
    except Exception as e:
        if "scheduled_interval" in str(e) and "scheduled_interval" in fields:
            logger.warning("subscriptions.scheduled_interval missing — run "
                           "20261009_scheduled_interval.sql")
            rest = {k: v for k, v in fields.items() if k != "scheduled_interval"}
            db.table("subscriptions").update(rest).eq("user_id", user_id).execute()
        else:
            raise


@router.post("/change-plan")
async def change_plan(body: ChangePlanRequest, user: dict = Depends(require_user)) -> dict:
    """Change plan and/or billing period.

    Upgrades and monthly -> annual apply now (Stripe prorates and charges the
    difference straight away). Downgrades and annual -> monthly wait for the
    end of the period already paid for, and are handed to Stripe as a
    schedule so the price really changes at renewal. The plan rules live in
    plans.py so the warning shown here and the limit enforced later agree."""
    from app.core.plans import can_change_plan
    from app.services import stripe_service

    if body.plan_key not in PLANS:
        raise HTTPException(status_code=400, detail=f"Unknown plan {body.plan_key!r}.")
    if body.interval not in (None, "month", "year"):
        raise HTTPException(status_code=400, detail="Interval must be month or year.")

    db = get_supabase()
    rows = (db.table("subscriptions").select("*").eq("user_id", user["id"])
            .limit(1).execute().data) or []
    sub = rows[0] if rows else None
    if not sub or not sub.get("stripe_subscription_id"):
        raise HTTPException(status_code=409, detail="You do not have a plan to change.")

    cur_plan = sub.get("plan_key")
    cur_interval = sub.get("billing_interval") or "month"
    new_interval = body.interval or cur_interval
    if body.plan_key == cur_plan and new_interval == cur_interval:
        raise HTTPException(status_code=400, detail="That is already your plan.")

    crews_used = _crew_count(db, user["id"])
    if body.plan_key == cur_plan:
        decision = None                     # interval-only change
    else:
        decision = can_change_plan(cur_plan, body.plan_key, crews_used=crews_used)
        if not decision.allowed:
            raise HTTPException(status_code=409, detail=decision.reason)

    # When does it take effect? Annual -> monthly always waits: the year is
    # paid for. Monthly -> annual always applies now. Otherwise the plan rule.
    if cur_interval == "year" and new_interval == "month":
        effective = "period_end"
    elif cur_interval == "month" and new_interval == "year":
        effective = "now"
    else:
        effective = decision.effective if decision else "now"

    name = PLANS[body.plan_key].name
    period_word = "annual" if new_interval == "year" else "monthly"
    try:
        stripe = stripe_service.client()
        price = stripe_service.price_id(body.plan_key, new_interval)
        remote = stripe.Subscription.retrieve(sub["stripe_subscription_id"])
        item_id = remote["items"]["data"][0]["id"]

        if effective == "now":
            # Whatever was waiting for the renewal is superseded by this.
            _release_schedule(stripe, remote)
            kwargs = dict(items=[{"id": item_id, "price": price}],
                          proration_behavior="create_prorations")
            if new_interval != cur_interval:
                # Monthly -> annual bills the year now (less the unused month).
                # If the card is declined, Stripe leaves the subscription as it
                # was instead of half-switching it.
                kwargs.update(proration_behavior="always_invoice",
                              payment_behavior="pending_if_incomplete")
            updated = stripe.Subscription.modify(sub["stripe_subscription_id"], **kwargs)
            if updated.get("pending_update"):
                raise HTTPException(
                    status_code=402,
                    detail="Your card was declined, so nothing changed. Update your card "
                           "under Payment methods and try again.")
            # pending_if_incomplete does not accept metadata in the same call.
            stripe.Subscription.modify(sub["stripe_subscription_id"],
                                       metadata={"axis_plan_key": body.plan_key})
            _write_schedule(db, user["id"], {
                "plan_key": body.plan_key, "billing_interval": new_interval,
                "scheduled_plan_key": None, "scheduled_change_at": None,
                "scheduled_interval": None, "updated_at": "now()"})
            reason = (decision.reason if decision and new_interval == cur_interval
                      else f"You're now on {name}, billed {period_word}.")
        else:
            _schedule_at_period_end(stripe, remote, current_plan=cur_plan,
                                    new_plan=body.plan_key, new_price=price)
            _write_schedule(db, user["id"], {
                "scheduled_plan_key": body.plan_key,
                "scheduled_change_at": sub.get("current_period_end"),
                "scheduled_interval": new_interval, "updated_at": "now()"})
            reason = (decision.reason if decision and new_interval == cur_interval
                      else f"Switching to {name}, billed {period_word}, when your current "
                           f"period ends.")
    except HTTPException:
        raise
    except Exception as e:
        logger.error("plan change failed for %s: %s", user["id"], e)
        raise HTTPException(status_code=502, detail="Could not change your plan.")

    return {"ok": True, "effective": effective, "reason": reason,
            "interval": new_interval,
            "warning": decision.warning if decision else None,
            "action_needed": decision.action_needed if decision else None,
            "effective_at": sub.get("current_period_end") if effective == "period_end" else None}


@router.post("/cancel")
async def cancel_plan(user: dict = Depends(require_user)) -> dict:
    """Cancel at period end, never immediately — they paid for this period."""
    from app.services import stripe_service
    db = get_supabase()
    rows = (db.table("subscriptions").select("*").eq("user_id", user["id"])
            .limit(1).execute().data) or []
    sub = rows[0] if rows else None
    if not sub or not sub.get("stripe_subscription_id"):
        raise HTTPException(status_code=409, detail="You do not have a plan to cancel.")
    try:
        stripe = stripe_service.client()
        # A pending downgrade is a schedule, and Stripe will not set
        # cancel_at_period_end on a subscription a schedule controls. Cancelling
        # supersedes the pending change anyway.
        _release_schedule(stripe, stripe.Subscription.retrieve(sub["stripe_subscription_id"]))
        stripe.Subscription.modify(
            sub["stripe_subscription_id"], cancel_at_period_end=True)
    except Exception as e:
        logger.error("cancel failed for %s: %s", user["id"], e)
        raise HTTPException(status_code=502, detail="Could not cancel your plan.")
    _write_schedule(db, user["id"], {
        "cancel_at_period_end": True, "scheduled_plan_key": None,
        "scheduled_change_at": None, "scheduled_interval": None, "updated_at": "now()"})
    return {"ok": True, "access_until": sub.get("current_period_end")}


@router.post("/resume")
async def resume_plan(user: dict = Depends(require_user)) -> dict:
    """Undo a pending cancellation, while the period is still running."""
    from app.services import stripe_service
    db = get_supabase()
    rows = (db.table("subscriptions").select("*").eq("user_id", user["id"])
            .limit(1).execute().data) or []
    sub = rows[0] if rows else None
    if not sub or not sub.get("stripe_subscription_id"):
        raise HTTPException(status_code=409, detail="Nothing to resume.")
    try:
        stripe_service.client().Subscription.modify(
            sub["stripe_subscription_id"], cancel_at_period_end=False)
    except Exception as e:
        logger.error("resume failed for %s: %s", user["id"], e)
        raise HTTPException(status_code=502, detail="Could not resume your plan.")
    db.table("subscriptions").update(
        {"cancel_at_period_end": False, "updated_at": "now()"}
    ).eq("user_id", user["id"]).execute()
    return {"ok": True}


def _crew_count(db, user_id: str) -> int:
    """Delegates, so the downgrade warning and the add_crew gate count the same
    rows. Two copies of this drifted apart once already."""
    from app.services import entitlement
    return entitlement.crews_used(db, user_id)


# ── Usage, and buying one more report ─────────────────────────────────────

@router.get("/usage")
async def my_usage(user: dict = Depends(require_user)) -> dict:
    """What this contractor has used against the current period.

    Settings renders this and so does the report prompt, from the same call, so
    "12 of 15 used" on one screen cannot disagree with the gate on the other.
    """
    from app.services import entitlement
    db = get_supabase()
    return entitlement.usage_summary(db, user["id"])


@router.get("/entitlement")
async def my_entitlement(action: str = "generate_report",
                         user: dict = Depends(require_user)) -> dict:
    """May this contractor do `action` right now, and if not, what would it cost?

    This is the call the UI makes BEFORE offering anything, which is what keeps
    the $35 charge consensual: the answer carries requires_purchase and the
    price, and the frontend must prompt and get a click before calling
    /purchase-report. Nothing here charges anything.
    """
    from app.core.plans import Action as _Action
    from app.services import entitlement

    allowed_actions = ("access_app", "generate_report", "add_crew", "buy_lead")
    if action not in allowed_actions:
        raise HTTPException(status_code=400, detail=f"Unknown action {action!r}.")

    db = get_supabase()
    sub = entitlement.load_subscription(db, user["id"])
    d = entitlement.check(db, user["id"], action, sub=sub)  # type: ignore[arg-type]
    out = {
        "action": action,
        "allowed": d.allowed,
        "would_allow": d.would_allow,
        "enforcing": enforcing(),
        "reason": d.reason,
        "plan_key": d.plan_key,
        "status": d.status,
        "requires_purchase": d.requires_purchase,
        "purchase_price_usd": d.purchase_price_usd,
        "grace_days_left": d.grace_days_left,
    }
    if action == "generate_report":
        out["usage"] = entitlement.usage_summary(db, user["id"], sub)
    return out


class PurchaseLeadRequest(BaseModel):
    """No price and no address. The county and the opaque token are enough to
    re-find the parcel server-side; a body that could name its own price, or
    its own address, would be a body worth forging.

    `city` and `zip_code` are the area the buyer was browsing. They only narrow
    the county query that re-finds the parcel — the token still has to match,
    and it is bound to county|pin, so widening or changing them cannot buy a
    different lead. Without them a lead found by ZIP would often fall outside
    the county-wide 200-row cap and the purchase would 404.
    """
    county: str
    token: str
    city: Optional[str] = None
    zip_code: Optional[str] = None


# A reservation that never got paid for must not hold a lead forever. Fifteen
# minutes is long enough for a 3DS challenge and short enough that a lead is
# not parked for an afternoon by a closed tab.
RESERVATION_TTL_MIN = 15


def _release_stale_reservations(db, county: str, pin: str) -> None:
    """Expire pending rows for this parcel that are older than the TTL.

    Done on demand rather than by a sweep: the only moment a stale reservation
    actually matters is when somebody is trying to buy that exact parcel.

    A reservation is NEVER released while its payment might still land. The
    reason the TTL exists at all is the bank challenge — someone sitting in
    their banking app with a requires_action intent — and simply flipping that
    row to expired would resell the lead while their payment was still in
    flight. They would then be charged for a lead somebody else owns, and the
    webhook's attempt to settle their row would collide with the new owner's on
    the unique index and be swallowed. So:

      * a succeeded intent means the lead was paid for: settle it and keep it
        theirs, whatever the clock says;
      * an intent still in flight is cancelled first, and only then is the row
        released;
      * anything we cannot prove is safe — Stripe unreachable, a cancel that
        failed, a 'processing' intent that cannot be cancelled — is left
        pending, and this caller is told the lead is taken.
    """
    from datetime import datetime, timedelta, timezone

    from app.services import stripe_service

    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=RESERVATION_TTL_MIN)).isoformat()
    try:
        stale = (db.table("purchased_leads").select("id,stripe_payment_intent_id")
                 .eq("source_county", county).eq("prospect_pin", pin)
                 .eq("status", "pending").lt("created_at", cutoff).execute().data) or []
    except Exception as e:
        logger.info("could not list stale reservations for %s/%s: %s", county, pin, e)
        return

    for row in stale:
        intent_id = row.get("stripe_payment_intent_id")
        if intent_id:
            try:
                stripe = stripe_service.client()
                intent = stripe.PaymentIntent.retrieve(intent_id)
                status = (intent or {}).get("status")
                if status == "succeeded":
                    # Paid. The clock is irrelevant; this lead is theirs.
                    db.table("purchased_leads").update(
                        {"status": "succeeded", "updated_at": "now()"}
                    ).eq("id", row["id"]).eq("status", "pending").execute()
                    continue
                if status not in ("canceled", "requires_payment_method"):
                    stripe.PaymentIntent.cancel(intent_id)
            except Exception as e:
                # Cannot prove the money is dead, so the lead stays reserved.
                logger.info("leaving reservation %s pending: %s", row.get("id"), e)
                continue
        try:
            db.table("purchased_leads").update(
                {"status": "expired", "updated_at": "now()"}
            ).eq("id", row["id"]).eq("status", "pending").execute()
        except Exception as e:
            logger.info("could not expire reservation %s: %s", row.get("id"), e)


@router.post("/purchase-lead")
async def purchase_lead(body: PurchaseLeadRequest,
                        user: dict = Depends(require_user)) -> dict:
    """Buy one exclusive lead for $50.

    The order of operations is the whole design:

      1. Re-query the county, so what is sold is what the record says now — not
         what the browser was holding. A house that sold last week fails the
         dud filter here even if it was listed as available a minute ago.
      2. Reserve by INSERT. The partial unique index on (county, pin) decides
         who got it; the loser is told someone else bought it and is never
         charged a cent.
      3. Only then charge, with the reservation's id as the idempotency key, so
         a retried request cannot bill twice.

    A failed charge flips the row to failed, which drops it out of the unique
    index and returns the lead to the pool.
    """
    from app.core.plans import DECLINE_MESSAGE, LEAD_USD
    from app.services import entitlement, leads as leads_svc, stripe_service
    from app.api.v1.prospecting import fetch_prospects

    uid = str(user["id"])
    admin = entitlement.is_admin(uid)

    if not leads_svc.valid_token(body.token):
        raise HTTPException(status_code=400, detail="That lead reference isn't valid. Refresh and try again.")

    # Real owner data behind a test card is the one mistake here that cannot be
    # undone, so purchases stay shut until Stripe is live. Admins can exercise
    # the flow in test mode.
    if stripe_service.is_test_mode() and not admin:
        raise HTTPException(
            status_code=503,
            detail="Lead purchases aren't open yet. They go live with billing — check back shortly.")

    db = get_supabase()
    sub = entitlement.load_subscription(db, uid)
    d = entitlement.check(db, uid, "buy_lead", sub=sub)  # type: ignore[arg-type]
    if not d.allowed:
        raise HTTPException(
            status_code=402 if d.requires_purchase else 409,
            detail=d.reason or "Exclusive leads are for contractors on a plan. Choose a plan first.")
    if not sub or not sub.get("stripe_customer_id"):
        raise HTTPException(status_code=409,
                            detail="Exclusive leads are for contractors on a plan. Choose a plan first.")

    # 1. Fresh data for the parcel this token refers to.
    try:
        src, rows = await fetch_prospects(body.county, city=body.city,
                                          zip_code=body.zip_code, limit=200)
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("lead re-query failed for %s: %s", body.county, e)
        raise HTTPException(status_code=502, detail="Couldn't reach the county data service — try again.")
    row = leads_svc.match_token(body.county, body.token, rows)
    if not row:
        raise HTTPException(
            status_code=404,
            detail="That lead is no longer in the county's current results. Search again for a fresh list.")
    ok, why = leads_svc.sellable(row)
    if not ok:
        raise HTTPException(status_code=409, detail=f"That property is no longer a usable lead ({why}).")

    pin = str(row["pin"])
    _release_stale_reservations(db, body.county, pin)

    # 2. Reserve. The unique index is the referee.
    try:
        res = (db.table("purchased_leads").insert({
            "user_id": uid,
            "source_county": body.county,
            "prospect_pin": pin,
            "snapshot": leads_svc.snapshot_of(row),
            "price_usd": LEAD_USD,
            "status": "pending",
        }).execute().data or [{}])[0]
    except Exception as e:
        if _is_unique_violation(e):
            raise HTTPException(status_code=409,
                                detail="Someone just bought this lead. You haven't been charged.")
        logger.warning("could not reserve lead %s/%s: %s", body.county, pin, e)
        raise HTTPException(status_code=500, detail="Couldn't reserve that lead. Try again.")
    row_id = res.get("id")

    # A replacement credit from an approved dud claim pays for this one, so the
    # contractor ends up with the lead they were trying to buy rather than cash
    # back. Spent with a compare-and-swap on the balance we just read: if
    # another request spends it first the update matches nothing, and we fall
    # through to the card instead of handing out two leads for one credit.
    credits = int(sub.get("lead_credits") or 0)
    if credits > 0:
        spent = (db.table("subscriptions")
                 .update({"lead_credits": credits - 1, "updated_at": "now()"})
                 .eq("user_id", uid).eq("lead_credits", credits).execute().data) or []
        if spent:
            try:
                db.table("purchased_leads").update(
                    {"status": "succeeded", "price_usd": 0, "updated_at": "now()"}
                ).eq("id", row_id).execute()
            except Exception as e:
                logger.info("could not settle credited lead row %s: %s", row_id, e)
            crm_id = _lead_to_crm(db, uid, row, src.get("name") or body.county)
            return {"ok": True, "charged_usd": 0, "used_credit": True,
                    "credits_left": credits - 1,
                    "lead": {**leads_svc.owned_row(body.county, row),
                             "purchase_id": row_id, "crm_lead_id": crm_id},
                    "message": "Replacement lead claimed. Your card wasn't charged."}

    cards = (db.table("payment_methods").select("*")
             .eq("user_id", uid).eq("is_default", True).limit(1).execute().data) or []
    if not cards:
        cards = (db.table("payment_methods").select("*")
                 .eq("user_id", uid).limit(1).execute().data) or []
    if not cards:
        _fail_lead(db, row_id)
        raise HTTPException(status_code=409, detail="No card on file. Add one in Settings first.")

    # 3. Charge.
    try:
        stripe = stripe_service.client()
        intent = stripe.PaymentIntent.create(
            amount=LEAD_USD * 100,
            currency="usd",
            customer=sub["stripe_customer_id"],
            payment_method=cards[0]["stripe_payment_method_id"],
            off_session=True,
            confirm=True,
            description="Axis — 1 exclusive lead",
            metadata={"axis_user_id": uid, "axis_kind": "exclusive_lead",
                      "axis_lead_row": str(row_id or ""),
                      "axis_county": body.county},
            idempotency_key=f"axis-lead-{row_id}",
        )
    except Exception as e:
        _fail_lead(db, row_id)
        logger.warning("lead purchase failed for %s: %s", uid, e)
        raise HTTPException(status_code=402, detail=DECLINE_MESSAGE)

    try:
        db.table("purchased_leads").update(
            {"stripe_payment_intent_id": intent.get("id"), "updated_at": "now()"}
        ).eq("id", row_id).execute()
    except Exception as e:
        logger.info("could not link intent to lead row %s: %s", row_id, e)

    status = intent.get("status")
    if status == "requires_action":
        # Still reserved, still unpaid. The reservation TTL is what eventually
        # frees it if they walk away from the bank's prompt.
        return {"ok": False, "requires_action": True,
                "client_secret": intent.get("client_secret"),
                "message": "Your bank needs to confirm this payment."}
    if status != "succeeded":
        _fail_lead(db, row_id)
        raise HTTPException(status_code=402, detail=DECLINE_MESSAGE)

    try:
        db.table("purchased_leads").update(
            {"status": "succeeded", "updated_at": "now()"}
        ).eq("id", row_id).execute()
    except Exception as e:
        logger.info("could not settle lead row %s locally: %s", row_id, e)

    crm_id = _lead_to_crm(db, uid, row, src.get("name") or body.county)

    return {"ok": True, "charged_usd": LEAD_USD, "payment_intent_id": intent.get("id"),
            "lead": {**leads_svc.owned_row(body.county, row), "purchase_id": row_id,
                     "crm_lead_id": crm_id},
            "message": f"Charged ${LEAD_USD}. This lead is yours exclusively and is now in your CRM."}


def _is_unique_violation(e: Exception) -> bool:
    """Did the reservation lose the race for this parcel?

    Postgres 23505 arrives through the Supabase client as text, so the code is
    matched rather than an exception type.
    """
    blob = f"{getattr(e, 'code', '')} {getattr(e, 'message', '')} {e}".lower()
    return "23505" in blob or "duplicate key" in blob or "unique constraint" in blob


def _fail_lead(db, row_id) -> None:
    """Mark a reservation failed, which drops it out of the unique index and
    puts the lead back on the market."""
    if not row_id:
        return
    try:
        db.table("purchased_leads").update(
            {"status": "failed", "updated_at": "now()"}
        ).eq("id", row_id).execute()
    except Exception as e:
        logger.info("could not release lead row %s: %s", row_id, e)


def _lead_to_crm(db, uid: str, row: dict, county_name: str):
    """Put a bought lead straight into the CRM.

    A lead that has to be retyped to be worked is a lead that gets lost. Never
    fatal: the purchase has already succeeded by the time this runs, so a CRM
    failure must not turn into an error on a charge that went through.
    """
    try:
        res = db.table("crm_leads").insert({
            "user_id": uid,
            "name": row.get("owner") or row.get("address") or "Exclusive lead",
            "address": row.get("address"),
            "city": row.get("city"),
            "job_type": "roof_replacement",
            "stage": "new",
            "notes": f"Axis exclusive lead — {county_name}."
                     + (f" Built {row['year_built']}." if row.get("year_built") else "")
                     + (f" Owner mailing address: {row['owner_mail']}." if row.get("owner_mail") else "")
                     + f" Score {row.get('score')}. Public county record; check DNC before calling.",
        }).execute()
        return (res.data or [{}])[0].get("id")
    except Exception as e:
        logger.warning("bought lead not added to CRM for %s: %s", uid, e)
        return None


@router.get("/my-leads")
async def my_leads(user: dict = Depends(require_user)) -> dict:
    """Leads this account has paid for, served from the snapshot taken at sale.

    Read from the row rather than re-queried: a contractor who paid for a lead
    must still see exactly what they bought after the county rewrites its data.
    """
    from app.core.plans import LEAD_USD
    db = get_supabase()
    rows = (db.table("purchased_leads")
            .select("id,source_county,prospect_pin,snapshot,price_usd,status,created_at")
            .eq("user_id", str(user["id"])).eq("status", "succeeded")
            .order("created_at", desc=True).limit(500).execute().data) or []
    out = []
    for r in rows:
        snap = r.get("snapshot") or {}
        out.append({"purchase_id": r["id"], "county": r["source_county"],
                    "bought_at": r.get("created_at"), "price_usd": r.get("price_usd") or LEAD_USD,
                    **snap})
    return {"count": len(out), "leads": out}


class LeadProblemRequest(BaseModel):
    """A claim about a lead, limited to what can be checked.

    `reason` is a fixed set rather than free text because the policy is that a
    claim is either corroborated by the county record or reviewed by a person —
    and neither is possible with "it was bad".
    """
    reason: str
    detail: Optional[str] = None


def _months_since(iso: Optional[str]) -> float:
    from datetime import datetime, timezone
    if not iso:
        return 0.0
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - t).total_seconds() / 2_629_746.0)
    except Exception:
        return 0.0


def _grant_lead_credit(db, uid: str) -> int:
    """Add one replacement lead to the account. Returns the new balance.

    Read-then-write: two approvals landing in the same instant could lose one
    credit. Claims are capped at three a month and reviewed one at a time, so
    the race is not worth a stored procedure — but it is why this is in one
    place rather than inline.
    """
    rows = (db.table("subscriptions").select("lead_credits")
            .eq("user_id", uid).limit(1).execute().data) or []
    have = int((rows[0] if rows else {}).get("lead_credits") or 0)
    db.table("subscriptions").update(
        {"lead_credits": have + 1, "updated_at": "now()"}
    ).eq("user_id", uid).execute()
    return have + 1


@router.post("/leads/{purchase_id}/report-problem")
async def report_lead_problem(purchase_id: str, body: LeadProblemRequest,
                              user: dict = Depends(require_user)) -> dict:
    """Report a lead as a dud.

    Checked against the county's record as it reads right now. If that record
    contradicts what was sold — the parcel is no longer residential, the owner
    or address has changed, the house had already sold before the purchase —
    the claim is approved immediately and a replacement lead is credited.
    Anything the server cannot settle goes to review rather than being refused,
    because a wrong automatic refusal is worse than a slower answer.
    """
    from app.services import leads as leads_svc
    from app.api.v1.prospecting import fetch_prospects

    uid = str(user["id"])
    if body.reason not in leads_svc.CLAIM_REASONS:
        raise HTTPException(
            status_code=400,
            detail="Pick one of: not a home, sold before purchase, or the record is wrong. "
                   "No answer or not interested isn't something I can credit.")

    db = get_supabase()
    rows = (db.table("purchased_leads").select("*")
            .eq("id", purchase_id).eq("user_id", uid).limit(1).execute().data) or []
    if not rows:
        raise HTTPException(status_code=404, detail="That lead isn't one of yours.")
    purchase = rows[0]
    if purchase.get("status") != "succeeded":
        raise HTTPException(status_code=409, detail="That lead was never completed.")

    age_days = _months_since(purchase.get("created_at")) * 30.44
    if age_days > leads_svc.CLAIM_WINDOW_DAYS:
        raise HTTPException(
            status_code=409,
            detail=f"Problems can be reported within {leads_svc.CLAIM_WINDOW_DAYS} days of buying a lead. "
                   f"This one is {int(age_days)} days old.")

    # Three a month, so the policy cannot be used as a way to work leads free.
    recent = (db.table("lead_problem_reports").select("id,created_at")
              .eq("user_id", uid).execute().data) or []
    if sum(1 for r in recent if _months_since(r.get("created_at")) < 1.0) >= leads_svc.CLAIMS_PER_MONTH:
        raise HTTPException(
            status_code=429,
            detail=f"That's {leads_svc.CLAIMS_PER_MONTH} reports this month, which is the limit. "
                   f"Reply to your receipt email and I'll look at it myself.")

    snapshot = purchase.get("snapshot") or {}
    county = purchase.get("source_county") or ""
    pin = str(purchase.get("prospect_pin") or "")
    current = None
    checked = False
    try:
        # Ask about this ONE parcel. Every other county query here is capped at
        # 200 rows, so a parcel missing from a county-wide result set proves
        # nothing — and "not a home" is approved on absence.
        _src, fresh = await fetch_prospects(county, pin=pin, limit=5)
        checked = True
        current = next((r for r in fresh if str(r.get("pin")) == pin), None)
    except Exception as e:
        # The county service being down is not the contractor's problem: file
        # the claim for review rather than failing their request. `checked`
        # stays False so the outage is never mistaken for evidence.
        logger.info("claim check could not reach %s: %s", county, e)

    verified, evidence = leads_svc.verify_claim(
        body.reason, snapshot, current, _months_since(purchase.get("created_at")),
        checked=checked)

    try:
        rec = (db.table("lead_problem_reports").insert({
            "user_id": uid,
            "purchase_id": purchase_id,
            "reason": body.reason,
            "detail": (body.detail or "")[:2000] or None,
            "status": "approved" if verified else "open",
            "resolution": "replacement" if verified else None,
            "auto_verified": verified,
            "evidence": evidence,
            "reviewed_at": "now()" if verified else None,
        }).execute().data or [{}])[0]
    except Exception as e:
        if _is_unique_violation(e):
            raise HTTPException(status_code=409,
                                detail="You've already reported a problem with this lead.")
        logger.warning("could not file lead problem for %s: %s", uid, e)
        raise HTTPException(status_code=500, detail="Couldn't file that report. Try again.")

    if verified:
        credits = _grant_lead_credit(db, uid)
        return {"ok": True, "status": "approved", "auto_verified": True,
                "credits": credits, "report_id": rec.get("id"),
                "message": "Confirmed against the county record — you've got a replacement lead. "
                           "It's applied automatically next time you buy one."}

    return {"ok": True, "status": "open", "auto_verified": False,
            "report_id": rec.get("id"),
            "message": "Reported. The county record doesn't settle this one either way, "
                       "so I'll look at it myself and come back to you."}


@router.get("/leads/problems")
async def my_lead_problems(user: dict = Depends(require_user)) -> dict:
    """This account's claims, and the replacement credits it has to spend."""
    db = get_supabase()
    uid = str(user["id"])
    rows = (db.table("lead_problem_reports")
            .select("id,purchase_id,reason,status,resolution,auto_verified,created_at,review_note")
            .eq("user_id", uid).order("created_at", desc=True).limit(200).execute().data) or []
    subs = (db.table("subscriptions").select("lead_credits")
            .eq("user_id", uid).limit(1).execute().data) or []
    used = sum(1 for r in rows if _months_since(r.get("created_at")) < 1.0)
    from app.services import leads as leads_svc
    return {"reports": rows,
            "credits": int((subs[0] if subs else {}).get("lead_credits") or 0),
            "claims_used_this_month": used,
            "claims_per_month": leads_svc.CLAIMS_PER_MONTH}


@router.get("/leads/admin/problems")
async def admin_lead_problems(user: dict = Depends(require_user)) -> dict:
    """The review queue: claims the county record could not settle."""
    from app.services import entitlement
    if not entitlement.is_admin(str(user["id"])):
        raise HTTPException(status_code=403, detail="Not available on this account.")
    db = get_supabase()
    rows = (db.table("lead_problem_reports").select("*")
            .order("created_at", desc=True).limit(300).execute().data) or []
    out = []
    for r in rows:
        bought = (db.table("purchased_leads").select("source_county,snapshot,price_usd,created_at")
                  .eq("id", r.get("purchase_id")).limit(1).execute().data) or []
        snap = (bought[0] if bought else {}).get("snapshot") or {}
        out.append({**r, "county": (bought[0] if bought else {}).get("source_county"),
                    "address": snap.get("address"), "owner": snap.get("owner"),
                    "price_usd": (bought[0] if bought else {}).get("price_usd")})
    return {"count": len(out), "open": sum(1 for r in out if r.get("status") == "open"),
            "reports": out}


class ResolveProblemRequest(BaseModel):
    approve: bool
    resolution: Optional[str] = None      # replacement | refund | none
    note: Optional[str] = None


@router.post("/leads/admin/problems/{report_id}/resolve")
async def resolve_lead_problem(report_id: str, body: ResolveProblemRequest,
                               user: dict = Depends(require_user)) -> dict:
    """Decide a claim. Approving with 'replacement' credits a lead.

    A refund is recorded, not executed: issuing money back belongs in Stripe,
    where it can be seen and reversed, not behind an endpoint that could be
    called twice.
    """
    from app.services import entitlement
    if not entitlement.is_admin(str(user["id"])):
        raise HTTPException(status_code=403, detail="Not available on this account.")
    resolution = body.resolution or ("replacement" if body.approve else "none")
    if resolution not in ("replacement", "refund", "none"):
        raise HTTPException(status_code=400, detail="Unknown resolution.")

    db = get_supabase()
    rows = (db.table("lead_problem_reports").select("*")
            .eq("id", report_id).limit(1).execute().data) or []
    if not rows:
        raise HTTPException(status_code=404, detail="No such report.")
    rec = rows[0]
    if rec.get("status") != "open":
        raise HTTPException(status_code=409,
                            detail=f"That report was already {rec.get('status')}.")

    db.table("lead_problem_reports").update({
        "status": "approved" if body.approve else "rejected",
        "resolution": resolution,
        "review_note": (body.note or "")[:1000] or None,
        "reviewed_at": "now()",
        "reviewed_by": str(user["id"]),
        "updated_at": "now()",
    }).eq("id", report_id).eq("status", "open").execute()

    credits = None
    if body.approve and resolution == "replacement":
        credits = _grant_lead_credit(db, str(rec["user_id"]))
    return {"ok": True, "status": "approved" if body.approve else "rejected",
            "resolution": resolution, "credits": credits,
            "refund_is_manual": resolution == "refund"}


class PurchaseReportRequest(BaseModel):
    """Deliberately has no amount. The price comes from the plan table, so a
    tampered body cannot buy a report for a dollar."""
    quantity: int = 1


@router.post("/purchase-report")
async def purchase_extra_report(body: PurchaseReportRequest,
                                user: dict = Depends(require_user)) -> dict:
    """Charge the card on file for one more report, after they said yes.

    Never called speculatively. The contractor has seen "you have used all 30
    reports — buy another for $35?" and clicked buy; the UI learns that from
    /entitlement, which charges nothing. An earlier design billed the moment
    someone crossed the line, which is how a contractor discovers a bill he
    never agreed to.

    off_session, because the card is already saved and there is nobody to
    complete a 3DS challenge inside a POST. If the bank demands one the intent
    comes back requires_action and the UI has to walk them through it rather
    than silently failing.
    """
    from app.core.plans import DECLINE_MESSAGE, OVERAGE_REPORT_USD
    from app.services import entitlement, stripe_service

    qty = int(body.quantity or 1)
    if qty < 1 or qty > 10:
        raise HTTPException(status_code=400, detail="Buy between 1 and 10 reports.")

    db = get_supabase()
    sub = entitlement.load_subscription(db, user["id"])
    if not sub or not sub.get("stripe_customer_id"):
        raise HTTPException(
            status_code=409,
            detail="Extra reports are for contractors on a plan. Choose a plan first.")

    # The period the top-up belongs to, captured now so a renewal mid-purchase
    # cannot silently move it.
    start, end = None, None
    from app.core.plans import period_bounds
    start, end = period_bounds(sub)
    if end is None:
        raise HTTPException(
            status_code=409,
            detail="Your billing period isn't set up yet. Try again in a minute.")

    cards = (db.table("payment_methods").select("*")
             .eq("user_id", user["id"]).eq("is_default", True)
             .limit(1).execute().data) or []
    if not cards:
        cards = (db.table("payment_methods").select("*")
                 .eq("user_id", user["id"]).limit(1).execute().data) or []
    if not cards:
        raise HTTPException(status_code=409,
                            detail="No card on file. Add one in Settings first.")

    amount_usd = OVERAGE_REPORT_USD * qty
    row_id = None
    try:
        stripe = stripe_service.client()
        # Recorded as pending BEFORE the charge. If the process dies between
        # here and the webhook, there is a row to reconcile against instead of
        # a charge nobody can explain.
        row = (db.table("overage_purchases").insert({
            "user_id": user["id"],
            "quantity": qty,
            "unit_price_usd": OVERAGE_REPORT_USD,
            "status": "pending",
            "period_start": start.isoformat() if start else None,
            "period_end": end.isoformat(),
        }).execute().data or [{}])[0]
        row_id = row.get("id")

        intent = stripe.PaymentIntent.create(
            amount=amount_usd * 100,
            currency="usd",
            customer=sub["stripe_customer_id"],
            payment_method=cards[0]["stripe_payment_method_id"],
            off_session=True,
            confirm=True,
            description=f"Axis — {qty} additional roof report{'s' if qty > 1 else ''}",
            metadata={"axis_user_id": user["id"], "axis_kind": "overage_report",
                      "axis_quantity": str(qty),
                      "axis_overage_row": str(row_id or "")},
        )
    except Exception as e:
        # A decline arrives here as a CardError. Whatever the cause, the row
        # must not stay pending — a pending row blocks nothing but muddies
        # reconciliation, and the contractor needs to be able to retry.
        if row_id:
            try:
                db.table("overage_purchases").update(
                    {"status": "failed", "updated_at": "now()"}
                ).eq("id", row_id).execute()
            except Exception:
                pass
        logger.warning("overage purchase failed for %s: %s", user["id"], e)
        raise HTTPException(status_code=402, detail=DECLINE_MESSAGE)

    if row_id:
        try:
            db.table("overage_purchases").update(
                {"stripe_payment_intent_id": intent.get("id"), "updated_at": "now()"}
            ).eq("id", row_id).execute()
        except Exception as e:
            logger.info("could not link intent to overage row %s: %s", row_id, e)

    status = intent.get("status")
    if status == "requires_action":
        # The bank wants the cardholder present. Not a failure yet.
        return {"ok": False, "requires_action": True,
                "client_secret": intent.get("client_secret"),
                "message": "Your bank needs to confirm this payment."}
    if status != "succeeded":
        raise HTTPException(status_code=402, detail=DECLINE_MESSAGE)

    # The webhook is the source of truth and will also settle this row; writing
    # it here too means the contractor is not waiting on Stripe to generate the
    # report they just paid for. _settle_purchase is idempotent.
    try:
        db.table("overage_purchases").update(
            {"status": "succeeded", "updated_at": "now()"}
        ).eq("id", row_id).execute()
    except Exception as e:
        logger.info("could not settle overage row %s locally: %s", row_id, e)

    usage = entitlement.usage_summary(db, user["id"])
    return {"ok": True, "quantity": qty, "charged_usd": amount_usd,
            "payment_intent_id": intent.get("id"), "usage": usage,
            "message": f"Charged ${amount_usd}. "
                       f"{qty} more report{'s' if qty > 1 else ''} added to this period."}


# ── Webhooks ──────────────────────────────────────────────────────────────

@router.post("/webhook")
async def stripe_webhook(request: Request) -> dict:
    """Stripe telling us what happened. The only endpoint here without a bearer
    token, because Stripe has no account — it authenticates by signing the
    payload, which is verified below before a single byte is trusted.

    Two properties this must have, and both are easy to get wrong:

    SIGNATURE FIRST. Without verification anyone who learns the URL can POST a
    subscription.deleted for any account, or an invoice.paid to grant
    themselves a plan. The raw body is required — parsing it first breaks the
    signature.

    EXACTLY ONCE. Stripe retries and does not promise single delivery. The
    event id is claimed in stripe_events before any work happens, so a replayed
    subscription.deleted cannot cancel an account that has since resubscribed.
    """
    from app.services import stripe_service

    payload = await request.body()
    signature = request.headers.get("stripe-signature") or ""
    secret = stripe_service.webhook_secret()
    if not secret:
        logger.error("STRIPE_WEBHOOK_SECRET is not set — refusing unverifiable events")
        raise HTTPException(status_code=503, detail="Webhooks are not configured.")

    try:
        import stripe
        event = stripe.Webhook.construct_event(payload, signature, secret)
    except Exception as e:
        # Never echo the reason: a caller probing signatures should learn
        # nothing beyond "rejected".
        logger.warning("rejected a webhook with a bad signature: %s", e)
        raise HTTPException(status_code=400, detail="Invalid signature.")

    db = get_supabase()
    event_id = event.get("id")
    try:
        # Claim it first. If this insert conflicts we have handled it already,
        # and doing the work again would double-apply it.
        db.table("stripe_events").insert({
            "id": event_id, "type": event.get("type"),
        }).execute()
    except Exception:
        logger.info("webhook %s already processed — skipping", event_id)
        return {"received": True, "duplicate": True}

    try:
        await _apply_event(db, event)
    except Exception as e:
        # Release the claim so Stripe's retry can have another go; leaving it
        # would mean a transient database blip silently drops the event.
        logger.error("webhook %s (%s) failed: %s", event_id, event.get("type"), e)
        try:
            db.table("stripe_events").delete().eq("id", event_id).execute()
        except Exception:
            pass
        raise HTTPException(status_code=500, detail="Could not process event.")

    return {"received": True}


# Slack for clock skew between Stripe's timestamps and our stored copy. Minutes,
# because the error being guarded against is applying a change WEEKS early.
_RENEWAL_SLACK = timedelta(minutes=5)


def _period_ts(value):
    """Parse either a Stripe-derived ISO string or a Supabase timestamptz."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _retire_crews_for_plan(db, user_id: str, plan_key: str) -> None:
    """A downgrade has just taken effect — bring the dispatch board within the
    new plan's crew allowance.

    Only crews with no upcoming work are switched off; see
    scheduling.retire_crews_over_plan for why a booked crew is left running.

    Never raises. Dispatch is a different concern from billing, and a problem
    counting crews must not fail the webhook — Stripe would retry it, and the
    plan change itself has already been applied.
    """
    try:
        from app.core.plans import PLANS, UNLIMITED
        plan = PLANS.get((plan_key or "").strip().lower())
        if plan is None or plan.crews == UNLIMITED:
            return
        from app.api.v1.scheduling import org_for, retire_crews_over_plan
        retired = retire_crews_over_plan(db, org_for({"id": user_id}), plan.crews)
        if retired:
            logger.info("downgrade to %s retired %d crew(s) for %s",
                        plan_key, len(retired), user_id)
    except Exception as e:
        logger.warning("could not reconcile crews after a plan change for %s: %s",
                       user_id, e)


def _scheduled_change_is_due(row: dict, update: dict) -> bool:
    """Has the billing period a scheduled change was promised for actually begun?

    True only on a genuine renewal. The test is against the date the change was
    promised for, not against "did anything change", because the incoming event
    may be an unrelated update in the middle of a period the contractor paid for
    at the higher tier.
    """
    new_start = _period_ts(update.get("current_period_start"))
    if new_start is None:
        # No period on the payload — nothing to prove a renewal happened.
        return False

    due_at = _period_ts(row.get("scheduled_change_at"))
    if due_at is not None:
        return new_start + _RENEWAL_SLACK >= due_at

    # No due date recorded. Fall back to "the period advanced", which is what a
    # renewal looks like, rather than applying on any event at all.
    old_start = _period_ts(row.get("current_period_start"))
    return old_start is not None and new_start > old_start + _RENEWAL_SLACK


async def _apply_event(db, event) -> None:
    """Fold one Stripe event into our copy of the world.

    Stripe is the source of truth for money; these tables are a cache of it.
    Every branch writes what Stripe says rather than what Axis believed.
    """
    from app.services import stripe_service

    etype = event.get("type") or ""
    obj = (event.get("data") or {}).get("object") or {}

    if etype.startswith("customer.subscription."):
        customer_id = obj.get("customer")
        rows = (db.table("subscriptions")
                .select("user_id, scheduled_plan_key, scheduled_change_at, "
                        "current_period_start")
                .eq("stripe_customer_id", customer_id).limit(1).execute().data) or []
        if not rows:
            logger.warning("subscription event for unknown customer %s", customer_id)
            return
        row = rows[0]
        update = stripe_service.subscription_to_row(obj)

        if etype.endswith(".deleted"):
            update["status"] = "canceled"

        # A scheduled downgrade lands when the period rolls over. Applying it
        # off Stripe's own renewal is what makes the new report and crew limits
        # take effect at exactly the moment billing changes.
        #
        # But ONLY on a real renewal. customer.subscription.updated is not a
        # renewal signal — it fires for card changes, cancel/resume toggles,
        # prorations and metadata edits too. Applying the change on any of them
        # dropped the contractor to the smaller plan mid-period, costing them
        # allowance they had already paid for: the precise harm scheduling
        # exists to prevent.
        if etype.endswith(".updated") and row.get("scheduled_plan_key"):
            if _scheduled_change_is_due(row, update):
                update["plan_key"] = row["scheduled_plan_key"]
                update["scheduled_plan_key"] = None
                update["scheduled_change_at"] = None
                update["scheduled_interval"] = None
                logger.info("applied scheduled plan change for %s -> %s",
                            row["user_id"], update["plan_key"])
                _retire_crews_for_plan(db, row["user_id"], update["plan_key"])
            else:
                # Leave the promise standing, and do not let this event's row
                # data quietly clear it either.
                update.pop("plan_key", None)
                logger.info(
                    "holding scheduled change for %s -> %s; period has not "
                    "rolled over yet (due %s)",
                    row["user_id"], row["scheduled_plan_key"],
                    row.get("scheduled_change_at"))

        # Through _write_schedule so a not-yet-migrated scheduled_interval
        # column can never make a billing webhook fail.
        _write_schedule(db, row["user_id"], update)
        return

    if etype in ("setup_intent.succeeded", "payment_method.attached"):
        # A card was saved. Recorded here rather than when the browser confirms,
        # because the browser can close mid-flow and Stripe's event is the only
        # account of what actually attached.
        pm_id = obj.get("payment_method") if etype == "setup_intent.succeeded" else obj.get("id")
        customer_id = obj.get("customer")
        if pm_id and customer_id:
            _record_payment_method(db, customer_id, pm_id)
        return

    if etype == "payment_method.detached":
        pm_id = obj.get("id")
        if pm_id:
            try:
                db.table("payment_methods").delete().eq(
                    "stripe_payment_method_id", pm_id).execute()
            except Exception as e:
                logger.info("could not remove detached card %s: %s", pm_id, e)
        return

    if etype == "payment_intent.succeeded":
        _settle_purchase(db, obj.get("id"), "succeeded")
        return

    if etype in ("payment_intent.payment_failed", "payment_intent.canceled"):
        # Releases a held lead back to the pool: the exclusivity index only
        # counts pending and succeeded rows.
        _settle_purchase(db, obj.get("id"), "failed")
        return


def _record_payment_method(db, customer_id: str, pm_id: str) -> None:
    """Store brand/last4/expiry so Settings can render a card row.

    The PAN is never fetched or stored — only what is needed to say "Visa
    ending 4242". Storing more would drag Axis into PCI scope for no benefit.
    """
    from app.services import stripe_service
    try:
        rows = (db.table("subscriptions").select("user_id")
                .eq("stripe_customer_id", customer_id).limit(1).execute().data) or []
        if not rows:
            logger.warning("card attached for unknown customer %s", customer_id)
            return
        user_id = rows[0]["user_id"]
        pm = stripe_service.client().PaymentMethod.retrieve(pm_id)
        card = pm.get("card") or {}
        existing = (db.table("payment_methods").select("id")
                    .eq("user_id", user_id).execute().data) or []
        db.table("payment_methods").upsert({
            "user_id": user_id,
            "stripe_payment_method_id": pm_id,
            "brand": card.get("brand"),
            "last4": card.get("last4"),
            "exp_month": card.get("exp_month"),
            "exp_year": card.get("exp_year"),
            # First card added becomes the default, so someone who adds one
            # card never ends up with none marked.
            "is_default": not existing,
        }, on_conflict="stripe_payment_method_id").execute()
    except Exception as e:
        logger.info("could not record payment method %s: %s", pm_id, e)


def _settle_purchase(db, payment_intent_id: str, status: str) -> None:
    """Mark whatever this payment was for. A purchase grants nothing until it
    reaches 'succeeded' — that is the rule that stops a declined card from
    handing over a report or a lead."""
    if not payment_intent_id:
        return
    for table in ("overage_purchases", "purchased_leads"):
        try:
            db.table(table).update({"status": status, "updated_at": "now()"}) \
                .eq("stripe_payment_intent_id", payment_intent_id).execute()
        except Exception as e:
            logger.info("could not settle %s in %s: %s", payment_intent_id, table, e)
