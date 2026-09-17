"""Stripe access, in one place.

Everything that talks to Stripe goes through here so there is a single spot
that knows how the key is read, how errors are shaped, and what Axis stores
about a Stripe object. Endpoints deal in contractors and plans; this deals in
customers and price ids.

Two rules the rest of the codebase depends on:

  * A contractor's Stripe ids are NEVER accepted from a request. They are
    looked up from the authenticated user. The router this replaced took a
    customer_id as a query parameter with no auth at all, which let anyone mint
    a billing-portal URL for anyone, and there is now a test asserting no
    billing route can take one again.
  * Stripe is the source of truth for money; Postgres is a cache of it. When
    the two disagree, a webhook overwrites our copy — never the reverse.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)


class StripeNotConfigured(RuntimeError):
    """No secret key. Raised rather than returning a fake result, so a
    misconfigured deploy fails loudly instead of silently not charging."""


def secret_key() -> str:
    # os.environ first, mirroring the rest of this codebase — pydantic-settings
    # has not reliably reflected Render's environment (see the health-secret
    # incident and visualizer_service).
    from app.core.config import settings
    return (os.environ.get("STRIPE_SECRET_KEY")
            or getattr(settings, "STRIPE_SECRET_KEY", "") or "").strip()


def webhook_secret() -> str:
    from app.core.config import settings
    return (os.environ.get("STRIPE_WEBHOOK_SECRET")
            or getattr(settings, "STRIPE_WEBHOOK_SECRET", "") or "").strip()


def publishable_key() -> str:
    """The pk_ key, served to the browser at runtime.

    Deliberately NOT a NEXT_PUBLIC_ build variable. Two reasons, and the second
    is the one that matters: Vercel would not accept that name here, and baking
    the key into the bundle means rotating it requires a rebuild and redeploy.
    Served from the backend, a rotation is an env change and a restart.

    It is safe to hand out — a publishable key can only tokenize a card. It
    cannot charge, refund, or read a customer.
    """
    from app.core.config import settings
    return (os.environ.get("STRIPE_PUBLISHABLE_KEY")
            or os.environ.get("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY")
            or getattr(settings, "STRIPE_PUBLISHABLE_KEY", "") or "").strip()


def configured() -> bool:
    return bool(secret_key())


def is_test_mode() -> bool:
    """Test keys are prefixed sk_test_. Surfaced so the UI and the health check
    can say which ledger they are looking at — a live key on a staging deploy
    is the kind of thing nobody notices until a real card is charged."""
    return secret_key().startswith("sk_test_")


class LiveKeyRefused(RuntimeError):
    """A live key is present somewhere that has no business charging cards."""


def assert_key_is_safe() -> None:
    """Refuse a live key while billing enforcement is off.

    The two keys are identical to look at apart from four characters, and the
    failure mode is not a broken build — it is a real card charged during a
    sandbox run, discovered by the person whose card it was. Enforcement being
    off means we are still testing, and testing does not need live keys.

    Deliberately raises rather than warns: a warning in a log nobody is reading
    is the same as no check at all.
    """
    key = secret_key()
    if not key or key.startswith("sk_test_"):
        return
    from app.core.plans import enforcing
    if not enforcing():
        raise LiveKeyRefused(
            "A LIVE Stripe key is configured while BILLING_ENFORCE is off. "
            "Refusing to run: this combination charges real cards during "
            "testing. Use sk_test_ until enforcement is deliberately enabled."
        )


def client():
    if not configured():
        raise StripeNotConfigured("STRIPE_SECRET_KEY is not set")
    assert_key_is_safe()
    import stripe
    stripe.api_key = secret_key()
    return stripe


# ── Customers ─────────────────────────────────────────────────────────────

def ensure_customer(db, user_id: str, email: str, name: Optional[str] = None) -> str:
    """The contractor's Stripe customer id, creating it on first use.

    Idempotent by storage: the id is written to subscriptions and reused, so a
    contractor never ends up with two customer records and a payment method
    saved against the one they are not being billed on.
    """
    rows = (db.table("subscriptions").select("stripe_customer_id")
            .eq("user_id", user_id).limit(1).execute().data) or []
    existing = (rows[0].get("stripe_customer_id") if rows else None)
    if existing:
        return existing

    stripe = client()
    customer = stripe.Customer.create(
        email=email,
        name=name or None,
        # Lets a Stripe-side human trace a charge back to an Axis account
        # without a lookup table.
        metadata={"axis_user_id": user_id},
    )
    db.table("subscriptions").upsert(
        {"user_id": user_id, "stripe_customer_id": customer.id},
        on_conflict="user_id",
    ).execute()
    return customer.id


# ── Price lookup ──────────────────────────────────────────────────────────
# Price ids live in the environment rather than the database or the code: they
# differ between test and live mode, and hardcoding them would mean a test-mode
# id shipping to production. Named STRIPE_PRICE_<PLAN>_<INTERVAL>.

def price_id(plan_key: str, interval: str) -> str:
    var = f"STRIPE_PRICE_{plan_key.upper()}_{interval.upper()}"
    value = (os.environ.get(var) or "").strip()
    if not value:
        raise StripeNotConfigured(
            f"{var} is not set — run scripts/create_stripe_prices.py and add the "
            f"printed ids to the environment."
        )
    return value


def subscription_to_row(sub, *, plan_key: Optional[str] = None,
                        interval: Optional[str] = None) -> dict:
    """Flatten a Stripe subscription into the columns Axis stores.

    Written once, used by both the checkout path and every webhook, so the two
    cannot disagree about what a subscription means — the classic version of
    this bug is checkout writing 'active' while the webhook writes 'trialing'
    for the same object.
    """
    from datetime import datetime, timezone

    def ts(value):
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat() if value else None

    item = (sub.get("items", {}).get("data") or [{}])[0]
    price = item.get("price") or {}

    # The billing period moved from the subscription to the subscription ITEM
    # in Stripe's 2025+ API versions. This matters because the two sources
    # disagree in the same codebase: the SDK pins 2023-10-16, so a retrieved
    # subscription still has these at the top level, while webhook events are
    # serialised with the ACCOUNT's default version (2026-08-26 here) and only
    # carry them on the item.
    #
    # Reading top-level alone silently produced NULL periods from every webhook,
    # which made evaluate() treat a paying contractor as having no active period
    # — they would have paid and still been locked out, with an 'active' row to
    # say everything was fine. Item first, top level as the fallback, so this
    # holds whichever version a given payload was built with.
    period_start = item.get("current_period_start") or sub.get("current_period_start")
    period_end = item.get("current_period_end") or sub.get("current_period_end")

    return {
        "stripe_subscription_id": sub.get("id"),
        "status": sub.get("status") or "none",
        "current_period_start": ts(period_start),
        "current_period_end": ts(period_end),
        "cancel_at_period_end": bool(sub.get("cancel_at_period_end")),
        "plan_key": plan_key or (sub.get("metadata") or {}).get("axis_plan_key"),
        "billing_interval": interval or (price.get("recurring") or {}).get("interval"),
        "updated_at": "now()",
    }
