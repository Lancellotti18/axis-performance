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

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

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
    }


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


@router.post("/change-plan")
async def change_plan(body: ChangePlanRequest, user: dict = Depends(require_user)) -> dict:
    """Upgrade now, downgrade at period end. The rules live in plans.py so the
    warning shown here and the limit enforced later cannot disagree."""
    from app.core.plans import can_change_plan
    from app.services import stripe_service

    if body.plan_key not in PLANS:
        raise HTTPException(status_code=400, detail=f"Unknown plan {body.plan_key!r}.")

    db = get_supabase()
    rows = (db.table("subscriptions").select("*").eq("user_id", user["id"])
            .limit(1).execute().data) or []
    sub = rows[0] if rows else None
    if not sub or not sub.get("stripe_subscription_id"):
        raise HTTPException(status_code=409, detail="You do not have a plan to change.")

    crews_used = _crew_count(db, user["id"])
    decision = can_change_plan(sub.get("plan_key"), body.plan_key, crews_used=crews_used)
    if not decision.allowed:
        raise HTTPException(status_code=409, detail=decision.reason)

    interval = sub.get("billing_interval") or "month"
    try:
        stripe = stripe_service.client()
        price = stripe_service.price_id(body.plan_key, interval)
        remote = stripe.Subscription.retrieve(sub["stripe_subscription_id"])
        item_id = remote["items"]["data"][0]["id"]

        if decision.effective == "now":
            # Upgrade: swap immediately and let Stripe prorate the difference.
            stripe.Subscription.modify(
                sub["stripe_subscription_id"],
                items=[{"id": item_id, "price": price}],
                proration_behavior="create_prorations",
                metadata={"axis_plan_key": body.plan_key},
            )
            db.table("subscriptions").update(
                {"plan_key": body.plan_key, "scheduled_plan_key": None,
                 "scheduled_change_at": None, "updated_at": "now()"}
            ).eq("user_id", user["id"]).execute()
        else:
            # Downgrade: recorded as a promise, applied by the renewal webhook.
            # Nothing shrinks inside a period they already paid for.
            db.table("subscriptions").update(
                {"scheduled_plan_key": body.plan_key,
                 "scheduled_change_at": sub.get("current_period_end"),
                 "updated_at": "now()"}
            ).eq("user_id", user["id"]).execute()
    except HTTPException:
        raise
    except Exception as e:
        logger.error("plan change failed for %s: %s", user["id"], e)
        raise HTTPException(status_code=502, detail="Could not change your plan.")

    return {"ok": True, "effective": decision.effective, "reason": decision.reason,
            "warning": decision.warning, "action_needed": decision.action_needed,
            "effective_at": sub.get("current_period_end") if decision.effective == "period_end" else None}


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
        stripe_service.client().Subscription.modify(
            sub["stripe_subscription_id"], cancel_at_period_end=True)
    except Exception as e:
        logger.error("cancel failed for %s: %s", user["id"], e)
        raise HTTPException(status_code=502, detail="Could not cancel your plan.")
    db.table("subscriptions").update(
        {"cancel_at_period_end": True, "updated_at": "now()"}
    ).eq("user_id", user["id"]).execute()
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
    """How many dispatch crews exist. Best-effort: a downgrade warning that
    cannot count is better than a downgrade that fails."""
    for table, col in (("sched_crews", "user_id"), ("crews", "user_id")):
        try:
            rows = db.table(table).select("id").eq(col, user_id).execute().data
            return len(rows or [])
        except Exception:
            continue
    return 0


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
        rows = (db.table("subscriptions").select("user_id, scheduled_plan_key")
                .eq("stripe_customer_id", customer_id).limit(1).execute().data) or []
        if not rows:
            logger.warning("subscription event for unknown customer %s", customer_id)
            return
        row = rows[0]
        update = stripe_service.subscription_to_row(obj)

        if etype.endswith(".deleted"):
            update["status"] = "canceled"

        # A scheduled downgrade lands when the period rolls over. Applying it
        # here — off Stripe's own renewal — is what makes the new report and
        # crew limits take effect at exactly the moment billing changes.
        if etype.endswith(".updated") and row.get("scheduled_plan_key"):
            update["plan_key"] = row["scheduled_plan_key"]
            update["scheduled_plan_key"] = None
            update["scheduled_change_at"] = None
            logger.info("applied scheduled plan change for %s -> %s",
                        row["user_id"], update["plan_key"])

        db.table("subscriptions").update(update).eq("user_id", row["user_id"]).execute()
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
