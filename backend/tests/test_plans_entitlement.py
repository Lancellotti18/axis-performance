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
def test_past_due_has_a_bounded_grace_window(enforcing):
    """A failed card is a dunning problem worth riding out — but not forever.
    Indefinite past_due access is a free plan with extra steps."""
    # Period ended yesterday, so we are inside the grace window.
    ended = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    d = evaluate(_sub(status="past_due", current_period_end=ended), "access_app")
    assert d.would_allow is True
    assert d.grace_days_left is not None and d.grace_days_left <= plans.PAST_DUE_GRACE_DAYS


def test_past_due_locks_once_the_grace_window_closes(enforcing):
    long_gone = (datetime.now(timezone.utc)
                 - timedelta(days=plans.PAST_DUE_GRACE_DAYS + 2)).isoformat()
    d = evaluate(_sub(status="past_due", current_period_end=long_gone), "access_app")
    assert d.would_allow is False, "cannot keep working indefinitely without paying"


def test_over_allowance_stops_and_asks_before_charging(enforcing):
    """Never bill for something nobody clicked. The 16th report is refused with
    a prompt, not generated with a surprise $35 on the invoice."""
    d = evaluate(_sub(), "generate_report", reports_used=15)
    assert d.would_allow is False, "must not proceed silently"
    assert d.requires_purchase is True
    assert d.purchase_price_usd == 35
    assert "$35" in d.reason


def test_a_purchased_extra_report_is_then_allowed(enforcing):
    d = evaluate(_sub(), "generate_report", reports_used=15, overage_purchased=1)
    assert d.would_allow is True
    assert d.requires_purchase is False


def test_purchased_extras_do_not_grant_unlimited(enforcing):
    """Buying one extra grants exactly one."""
    d = evaluate(_sub(), "generate_report", reports_used=16, overage_purchased=1)
    assert d.would_allow is False
    assert d.requires_purchase is True


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


# ── The clock is the server's, never the caller's ─────────────────────────
def test_period_end_comes_from_the_subscription_not_the_caller(enforcing):
    """A contractor changing the date on their laptop must not reset their
    allowance. The boundary is Stripe's current_period_end, stored server-side."""
    ended = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    d = evaluate(_sub(current_period_end=ended), "access_app")
    assert d.would_allow is False

    future = (datetime.now(timezone.utc) + timedelta(days=5)).isoformat()
    assert evaluate(_sub(current_period_end=future), "access_app").would_allow is True


def test_billing_period_is_not_the_calendar_month(enforcing):
    """Someone who subscribes on the 20th gets the 20th to the 20th, matching
    what Stripe charges — not a 1st-of-the-month reset."""
    start = datetime(2026, 9, 20, tzinfo=timezone.utc)
    end = datetime(2026, 10, 20, tzinfo=timezone.utc)
    s0, e0 = plans.period_bounds({"current_period_start": start.isoformat(),
                                  "current_period_end": end.isoformat()})
    assert (s0, e0) == (start, end)


def test_crews_are_hard_capped(enforcing):
    """Three-crew plan means the 4th insert is refused, not billed."""
    d = evaluate(_sub(), "add_crew", crews_used=3)
    assert d.would_allow is False
    assert d.requires_purchase is False, "crews upgrade, they do not meter"
    assert "Upgrade" in d.reason


# ── Changing plans ────────────────────────────────────────────────────────
def test_upgrade_is_always_allowed():
    assert plans.can_change_plan("solo", "crew", crews_used=3).allowed is True
    assert plans.can_change_plan(None, "solo").allowed is True


def test_downgrade_blocked_when_crews_exceed_the_target():
    """Six crews cannot fit in Solo's three, and software must not pick which
    three survive on a contractor's behalf."""
    c = plans.can_change_plan("crew", "solo", crews_used=6)
    assert c.allowed is False
    assert "Remove 3 crews" in (c.remedy or "")


def test_downgrade_allowed_once_they_are_under_the_limit():
    c = plans.can_change_plan("crew", "solo", crews_used=3)
    assert c.allowed is True
    assert "end of the current period" in c.reason


def test_fleet_to_paid_tier_is_still_a_downgrade():
    """Unlimited crews to a capped plan must be checked even though Fleet's
    crew count is a sentinel rather than a number."""
    assert plans.can_change_plan("fleet", "solo", crews_used=9).allowed is False


def test_reports_already_used_do_not_block_a_plan_change():
    """Usage is history — changing plan does not un-generate reports."""
    assert plans.can_change_plan("crew", "solo", crews_used=0, reports_used=29).allowed is True


def test_decline_message_is_not_accusatory():
    m = plans.DECLINE_MESSAGE.lower()
    assert "invalid" not in m and "error" not in m
    assert "try again" in m
