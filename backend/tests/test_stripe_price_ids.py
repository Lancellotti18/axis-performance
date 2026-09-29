"""A price id that is present is not the same as one Stripe can charge.

On 2026-09-28 STRIPE_PRICE_FLEET_MONTH on Render was 'rice_1UGNN…' — a paste
that clipped the leading p. Every upgrade to Fleet returned a bare 502, and the
daily health check stayed green because it only asked whether the variable was
set. These pin down each way a price id can be wrong while looking fine.
"""
import pytest

from app.services import stripe_service
from app.services.stripe_service import StripeNotConfigured

VAR = "STRIPE_PRICE_FLEET_MONTH"
GOOD = "price_1UGNNm1XqVTAAbxnokja9itk"


class _FakePrice:
    """Just enough of stripe.Price.retrieve to drive verify_price."""

    def __init__(self, found):
        self._found = found

    def retrieve(self, pid):
        if pid not in self._found:
            raise Exception(f"No such price: '{pid}'")
        return self._found[pid]


class _FakeStripe:
    def __init__(self, found):
        self.Price = _FakePrice(found)


def _stripe_knows(monkeypatch, found):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_pretend")
    monkeypatch.setattr(stripe_service, "client", lambda: _FakeStripe(found))


def _price(amount=59900, interval="month", active=True):
    return {"active": active, "unit_amount": amount, "recurring": {"interval": interval}}


# ── price_id: the shape ───────────────────────────────────────────────────

def test_the_clipped_paste_that_actually_happened_is_refused(monkeypatch):
    monkeypatch.setenv(VAR, "rice_1UGNNm1XqVTAAbxnokja9itk")
    with pytest.raises(StripeNotConfigured) as e:
        stripe_service.price_id("fleet", "month")
    # The variable's name must be in the message — that is the whole point.
    assert VAR in str(e.value)
    assert "price_" in str(e.value)


def test_a_product_id_pasted_by_mistake_is_refused(monkeypatch):
    monkeypatch.setenv(VAR, "prod_UGNNm1XqVTAA")
    with pytest.raises(StripeNotConfigured):
        stripe_service.price_id("fleet", "month")


def test_a_well_formed_id_passes_through_untouched(monkeypatch):
    monkeypatch.setenv(VAR, f"  {GOOD}  ")
    assert stripe_service.price_id("fleet", "month") == GOOD


def test_an_unset_id_still_says_it_is_unset(monkeypatch):
    monkeypatch.delenv(VAR, raising=False)
    with pytest.raises(StripeNotConfigured) as e:
        stripe_service.price_id("fleet", "month")
    assert "not set" in str(e.value)


# ── verify_price: what Stripe says about it ───────────────────────────────

def test_a_correct_price_verifies_clean(monkeypatch):
    monkeypatch.setenv(VAR, GOOD)
    _stripe_knows(monkeypatch, {GOOD: _price()})
    assert stripe_service.verify_price("fleet", "month", 599) is None


def test_the_clipped_paste_is_reported_without_calling_stripe(monkeypatch):
    monkeypatch.setenv(VAR, "rice_1UGNNm1XqVTAAbxnokja9itk")

    def _must_not_be_called():
        raise AssertionError("a malformed id should be caught before any Stripe call")

    monkeypatch.setattr(stripe_service, "client", _must_not_be_called)
    problem = stripe_service.verify_price("fleet", "month", 599)
    assert problem and VAR in problem


def test_a_well_formed_id_stripe_does_not_know_is_reported(monkeypatch):
    """The going-live trap: a test-mode id next to a live key is perfectly
    shaped and still 'No such price'."""
    monkeypatch.setenv(VAR, GOOD)
    _stripe_knows(monkeypatch, {})
    problem = stripe_service.verify_price("fleet", "month", 599)
    assert problem is not None
    assert VAR in problem and GOOD in problem
    assert "test mode" in problem          # says WHICH mode could not find it


def test_an_archived_price_is_reported(monkeypatch):
    monkeypatch.setenv(VAR, GOOD)
    _stripe_knows(monkeypatch, {GOOD: _price(active=False)})
    assert "archived" in stripe_service.verify_price("fleet", "month", 599)


def test_a_yearly_price_in_the_monthly_slot_is_reported(monkeypatch):
    monkeypatch.setenv(VAR, GOOD)
    _stripe_knows(monkeypatch, {GOOD: _price(amount=599000, interval="year")})
    assert "'year'" in stripe_service.verify_price("fleet", "month", 599)


def test_a_price_that_charges_the_wrong_amount_is_reported(monkeypatch):
    """E.g. the Crew price pasted into the Fleet slot: real, active, monthly,
    and $150 short on every Fleet customer."""
    monkeypatch.setenv(VAR, GOOD)
    _stripe_knows(monkeypatch, {GOOD: _price(amount=44900)})
    problem = stripe_service.verify_price("fleet", "month", 599)
    assert "$449.00" in problem and "$599" in problem
