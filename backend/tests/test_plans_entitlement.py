"""Entitlement decisions. Pure logic, so every branch is cheap to pin down.

The expensive failure here is not a bug — it is locking a paying contractor out
of software they are still paying for. These tests exist mostly to prove that
does not happen.
"""
import os
from datetime import datetime, timedelta, timezone

import pytest

from app.core import plans
from app.core.plans import PLANS, UNLIMITED, evaluate


def _sub(**kw):
    future = (datetime.now(timezone.utc) + timedelta(days=10)).isoformat()
    base = {"status": "active", "plan_key": "solo", "current_period_end": future,
            "trial_report_used": True}
    base.update(kw)
    return base


@pytest.fixture
def enforcing(monkeypatch):
    monkeypatch.setenv("BILLING_ENFORCE", "true")


@pytest.fixture
def shadow(monkeypatch):
    monkeypatch.delenv("BILLING_ENFORCE", raising=False)


# ── Shadow mode is the safety net; prove it actually nets ─────────────────
def test_shadow_mode_never_blocks_anyone(shadow):
    # Must be an account enforcement WOULD deny: no subscription and the free
    # report already spent. Passing None here instead asserted the opposite of
    # the truth — an empty record is a brand-new signup who still has their
    # free report, and allowing them is correct.
    spent = {"status": "none", "trial_report_used": True}
    d = evaluate(spent, "generate_report")
    assert d.allowed is True, "shadow mode must not block"
    assert d.would_allow is False, "but it must record that it would have"


def test_a_brand_new_account_is_not_treated_as_lapsed(shadow):
    """No subscription row means 'signed up, not yet paid' — the population the
    promo exists for — not 'their plan ran out'."""
    d = evaluate(None, "generate_report")
    assert d.would_allow is True


def test_enforcement_off_by_default(shadow):
    assert plans.enforcing() is False


def test_enforcement_requires_an_explicit_true(monkeypatch):
    for value in ("", "0", "false", "no", "off"):
        monkeypatch.setenv("BILLING_ENFORCE", value)
        assert plans.enforcing() is False, f"{value!r} must not enable enforcement"
    monkeypatch.setenv("BILLING_ENFORCE", "true")
    assert plans.enforcing() is True


# ── Paying contractors keep working ───────────────────────────────────────
def test_past_due_still_has_access(enforcing):
    """A failed card is a dunning problem. Stripe retries for days; locking
    someone out on day one turns a recoverable hiccup into a cancellation."""
    d = evaluate(_sub(status="past_due"), "access_app")
    assert d.would_allow is True


def test_over_allowance_bills_as_overage_rather_than_blocking(enforcing):
    d = evaluate(_sub(), "generate_report", reports_used=99)
    assert d.would_allow is True
    assert "overage" in d.reason


def test_fleet_reports_are_unlimited(enforcing):
    d = evaluate(_sub(plan_key="fleet"), "generate_report", reports_used=10_000)
    assert d.would_allow is True
    assert PLANS["fleet"].reports == UNLIMITED


# ── The promo flow ────────────────────────────────────────────────────────
def test_new_signup_gets_one_free_report(enforcing):
    d = evaluate({"status": "none", "trial_report_used": False}, "generate_report")
    assert d.would_allow is True


def test_second_report_needs_a_plan(enforcing):
    d = evaluate({"status": "none", "trial_report_used": True}, "generate_report")
    assert d.would_allow is False


def test_used_promo_becomes_view_only_not_locked_out(enforcing):
    d = evaluate({"status": "none", "trial_report_used": True}, "access_app")
    assert d.would_allow is False
    assert "view-only" in d.reason


# ── Expiry and limits ─────────────────────────────────────────────────────
def test_expired_period_is_not_active(enforcing):
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    assert evaluate(_sub(current_period_end=past), "access_app").would_allow is False


def test_canceled_loses_access(enforcing):
    assert evaluate(_sub(status="canceled"), "access_app").would_allow is False


def test_crew_limit_blocks_at_the_cap(enforcing):
    assert evaluate(_sub(), "add_crew", crews_used=2).would_allow is True   # 3rd
    assert evaluate(_sub(), "add_crew", crews_used=3).would_allow is False  # 4th


def test_leads_are_subscriber_only(enforcing):
    assert evaluate(_sub(), "buy_lead").would_allow is True
    assert evaluate({"status": "none"}, "buy_lead").would_allow is False


# ── Pricing constants match what was agreed ───────────────────────────────
def test_agreed_pricing():
    assert (PLANS["solo"].monthly_usd, PLANS["solo"].reports, PLANS["solo"].crews) == (299, 15, 3)
    assert (PLANS["crew"].monthly_usd, PLANS["crew"].reports, PLANS["crew"].crews) == (449, 30, 6)
    assert PLANS["fleet"].monthly_usd == 599
    assert plans.OVERAGE_REPORT_USD == 35
    assert plans.LEAD_USD == 50


def test_annual_is_two_months_free():
    for p in PLANS.values():
        assert p.annual_usd == p.monthly_usd * 10, f"{p.key} annual should be 10x monthly"
