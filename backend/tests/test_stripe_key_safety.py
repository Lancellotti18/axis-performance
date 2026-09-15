"""A live key must never be reachable while we are still testing.

sk_test_ and sk_live_ differ by four characters. The failure this prevents is
not a broken build — it is a real contractor's card charged during a sandbox
run, found out by them.
"""
import pytest

from app.services import stripe_service
from app.services.stripe_service import LiveKeyRefused, StripeNotConfigured


def test_a_live_key_is_refused_while_enforcement_is_off(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_pretend")
    monkeypatch.delenv("BILLING_ENFORCE", raising=False)
    with pytest.raises(LiveKeyRefused):
        stripe_service.assert_key_is_safe()


def test_a_live_key_is_allowed_once_enforcement_is_deliberately_on(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_pretend")
    monkeypatch.setenv("BILLING_ENFORCE", "true")
    stripe_service.assert_key_is_safe()   # must not raise


def test_a_test_key_is_always_fine(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_pretend")
    monkeypatch.delenv("BILLING_ENFORCE", raising=False)
    stripe_service.assert_key_is_safe()


def test_client_refuses_before_ever_calling_stripe(monkeypatch):
    """The guard runs inside client(), so every call site is covered rather
    than the ones someone remembered to protect."""
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_pretend")
    monkeypatch.delenv("BILLING_ENFORCE", raising=False)
    with pytest.raises(LiveKeyRefused):
        stripe_service.client()


def test_missing_key_fails_loudly_rather_than_silently_not_charging(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "")
    monkeypatch.setattr("app.core.config.settings.STRIPE_SECRET_KEY", "", raising=False)
    with pytest.raises(StripeNotConfigured):
        stripe_service.client()


def test_mode_is_reported(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_x")
    assert stripe_service.is_test_mode() is True
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_x")
    assert stripe_service.is_test_mode() is False
