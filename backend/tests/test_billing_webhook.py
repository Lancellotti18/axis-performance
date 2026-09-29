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


# ── A scheduled downgrade must wait for the renewal ───────────────────────
# customer.subscription.updated is not a renewal signal: Stripe emits it for
# card changes, cancel/resume toggles, prorations and metadata edits. The
# handler used to apply a scheduled downgrade on any of them, dropping the
# contractor to the smaller plan in the middle of a period they had paid for at
# the higher tier. These call _apply_event directly, because "when does the
# change land" is behaviour and cannot be read off the source.

class _FakeQuery:
    def __init__(self, table):
        self._t = table
        self._update = None

    def select(self, *_a, **_k):
        return self

    def update(self, values):
        self._update = values
        return self

    def delete(self):
        self._t.deleted = True
        return self

    def eq(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        if self._update is not None:
            self._t.updates.append(self._update)
            return type("R", (), {"data": []})()
        return type("R", (), {"data": list(self._t.rows)})()


class _FakeTable:
    def __init__(self, rows):
        self.rows = rows
        self.updates = []
        self.deleted = False


class _FakeDB:
    def __init__(self, rows):
        self.subscriptions = _FakeTable(rows)

    def table(self, name):
        assert name == "subscriptions", f"unexpected table {name}"
        return _FakeQuery(self.subscriptions)


def _event(etype, *, period_start, period_end, plan_key="fleet"):
    """A subscription event shaped like the account's API version, which carries
    the period on the ITEM rather than the top level."""
    import calendar
    def epoch(iso):
        from datetime import datetime
        return calendar.timegm(datetime.fromisoformat(iso).utctimetuple())
    return {
        "id": "evt_test",
        "type": etype,
        "data": {"object": {
            "id": "sub_test",
            "customer": "cus_test",
            "status": "active",
            "cancel_at_period_end": False,
            "metadata": {"axis_plan_key": plan_key},
            "items": {"data": [{
                "current_period_start": epoch(period_start),
                "current_period_end": epoch(period_end),
                "price": {"recurring": {"interval": "month"}},
            }]},
        }},
    }


def _apply(rows, event):
    import asyncio
    from app.api.v1.billing import _apply_event
    db = _FakeDB(rows)
    asyncio.run(_apply_event(db, event))
    return db.subscriptions.updates[-1] if db.subscriptions.updates else {}


# Fleet contractor, paid through 1 Nov, with a downgrade to Solo promised for
# that date.
_SCHEDULED_ROW = [{
    "user_id": "u1",
    "plan_key": "fleet",
    "scheduled_plan_key": "solo",
    "scheduled_change_at": "2026-11-01T00:00:00+00:00",
    "current_period_start": "2026-10-01T00:00:00+00:00",
}]


def test_a_mid_period_update_does_not_apply_a_scheduled_downgrade():
    """The bug: adding a card on 12 Oct dropped them to Solo on the spot."""
    update = _apply(_SCHEDULED_ROW,
                    _event("customer.subscription.updated",
                           period_start="2026-10-01T00:00:00",
                           period_end="2026-11-01T00:00:00"))
    assert update.get("scheduled_plan_key", "solo") == "solo", \
        "the scheduled change must still be pending"
    assert update.get("plan_key") != "solo", \
        "a mid-period update must not move them onto the smaller plan"


def test_the_renewal_applies_the_scheduled_downgrade():
    """And the change must still actually land — the fix must not strand it
    pending forever, which would leave them on Fleet and billed for Fleet."""
    update = _apply(_SCHEDULED_ROW,
                    _event("customer.subscription.updated",
                           period_start="2026-11-01T00:00:00",
                           period_end="2026-12-01T00:00:00"))
    assert update.get("plan_key") == "solo", "the renewal must apply the downgrade"
    assert update.get("scheduled_plan_key") is None, "and clear the promise"
    assert update.get("scheduled_change_at") is None


def test_a_cancellation_never_applies_a_scheduled_change():
    update = _apply(_SCHEDULED_ROW,
                    _event("customer.subscription.deleted",
                           period_start="2026-10-01T00:00:00",
                           period_end="2026-11-01T00:00:00"))
    assert update.get("status") == "canceled"
    assert update.get("plan_key") != "solo"


def test_a_subscription_with_nothing_scheduled_still_records_its_plan():
    """The guard must not break the ordinary path."""
    rows = [{"user_id": "u1", "plan_key": "crew", "scheduled_plan_key": None,
             "scheduled_change_at": None,
             "current_period_start": "2026-10-01T00:00:00+00:00"}]
    update = _apply(rows, _event("customer.subscription.updated",
                                 period_start="2026-11-01T00:00:00",
                                 period_end="2026-12-01T00:00:00",
                                 plan_key="crew"))
    assert update.get("plan_key") == "crew"
    assert update.get("current_period_start"), "periods must still be written"


def test_a_payload_with_no_period_is_not_treated_as_a_renewal():
    """A malformed or partial payload must not be able to trigger the change."""
    from app.api.v1.billing import _scheduled_change_is_due
    assert _scheduled_change_is_due(_SCHEDULED_ROW[0], {}) is False
    assert _scheduled_change_is_due(
        _SCHEDULED_ROW[0], {"current_period_start": None}) is False
