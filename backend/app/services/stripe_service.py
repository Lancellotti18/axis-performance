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


def configured() -> bool:
    return bool(secret_key())


def is_test_mode() -> bool:
    """Test keys are prefixed sk_test_. Surfaced so the UI and the health check
    can say which ledger they are looking at — a live key on a staging deploy
    is the kind of thing nobody notices until a real card is charged."""
    return secret_key().startswith("sk_test_")


def client():
    if not configured():
        raise StripeNotConfigured("STRIPE_SECRET_KEY is not set")
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
    return {
        "stripe_subscription_id": sub.get("id"),
        "status": sub.get("status") or "none",
        "current_period_start": ts(sub.get("current_period_start")),
        "current_period_end": ts(sub.get("current_period_end")),
        "cancel_at_period_end": bool(sub.get("cancel_at_period_end")),
        "plan_key": plan_key or (sub.get("metadata") or {}).get("axis_plan_key"),
        "billing_interval": interval or (price.get("recurring") or {}).get("interval"),
        "updated_at": "now()",
    }
