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

    if etype == "payment_intent.succeeded":
        _settle_purchase(db, obj.get("id"), "succeeded")
        return

    if etype in ("payment_intent.payment_failed", "payment_intent.canceled"):
        # Releases a held lead back to the pool: the exclusivity index only
        # counts pending and succeeded rows.
        _settle_purchase(db, obj.get("id"), "failed")
        return


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
