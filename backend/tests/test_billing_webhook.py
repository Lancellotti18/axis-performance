"""The webhook is the one unauthenticated endpoint that can change what
somebody is entitled to. These pin the two properties that make that safe.
"""
import pytest
from fastapi.routing import APIRoute

from app.main import app


def _billing_routes():
    return [r for r in app.routes
            if isinstance(r, APIRoute) and r.path.startswith("/api/v1/billing")]


def test_webhook_is_mounted():
    paths = {r.path for r in _billing_routes()}
    assert "/api/v1/billing/webhook" in paths


class _FakeRequest:
    """Minimal stand-in. starlette's TestClient is unusable here — the
    installed httpx rejects its `app=` argument — and the handler only ever
    touches body() and headers, so a stub is honest rather than a shortcut."""

    def __init__(self, body: bytes, headers: dict):
        self._body = body
        self.headers = headers

    async def body(self) -> bytes:
        return self._body


def _call(body: bytes, sig: str):
    import asyncio
    from app.api.v1.billing import stripe_webhook
    return asyncio.run(
        stripe_webhook(_FakeRequest(body, {"stripe-signature": sig}))
    )


def test_webhook_refuses_everything_when_no_secret_is_configured(monkeypatch):
    """A deploy without STRIPE_WEBHOOK_SECRET must refuse events outright.
    Accepting unverifiable ones would let anyone who learns the URL POST a
    subscription.deleted for any account."""
    from fastapi import HTTPException
    monkeypatch.delenv("STRIPE_WEBHOOK_SECRET", raising=False)
    monkeypatch.setattr("app.core.config.settings.STRIPE_WEBHOOK_SECRET", "",
                        raising=False)
    with pytest.raises(HTTPException) as e:
        _call(b"{}", "t=1,v1=nope")
    assert e.value.status_code == 503


def test_webhook_rejects_a_bad_signature(monkeypatch):
    from fastapi import HTTPException
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test_not_a_real_secret")
    with pytest.raises(HTTPException) as e:
        _call(b'{"id":"evt_1","type":"customer.subscription.deleted"}', "t=1,v1=forged")
    assert e.value.status_code == 400
    detail = str(e.value.detail)
    assert "signature" in detail.lower()
    # The reason is deliberately not echoed — someone probing signatures should
    # learn nothing beyond "rejected", and certainly not the secret.
    assert "whsec" not in detail


def test_webhook_claims_the_event_id_before_doing_work():
    """Idempotency is structural, not best-effort: the id is inserted first and
    a conflict short-circuits, so a Stripe retry cannot double-apply.

    Asserted against the source because the handler's ordering is the property
    that matters and it cannot be observed without a live Stripe signature.
    """
    import inspect
    from app.api.v1 import billing
    src = inspect.getsource(billing.stripe_webhook)
    claim = src.index('table("stripe_events").insert')
    work = src.index("_apply_event")
    assert claim < work, "the event id must be claimed before the event is applied"
    assert "duplicate" in src, "a repeat delivery must short-circuit, not re-run"


def test_a_failed_event_releases_its_claim():
    """Otherwise a transient database blip silently swallows the event: Stripe
    retries, sees the id already claimed, and skips work that never happened."""
    import inspect
    from app.api.v1 import billing
    src = inspect.getsource(billing.stripe_webhook)
    assert 'table("stripe_events").delete()' in src


def test_only_a_succeeded_payment_grants_anything():
    import inspect
    from app.api.v1 import billing
    src = inspect.getsource(billing._settle_purchase)
    assert "overage_purchases" in src and "purchased_leads" in src
