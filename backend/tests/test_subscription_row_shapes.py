"""subscription_to_row must survive both Stripe API shapes.

Stripe moved current_period_start/end from the subscription onto the
subscription item in its 2025+ versions. Both shapes reach this code in the
same deployment: the SDK is pinned to 2023-10-16 so a RETRIEVED subscription
has them at the top level, while WEBHOOK events are serialised with the
account's own default version and carry them only on the item.

Reading top-level alone wrote NULL periods from every webhook. evaluate()
then saw no active period and treated a paying contractor as unsubscribed —
they pay, the row says 'active', and they are still locked out.
"""
from datetime import datetime, timezone

from app.services.stripe_service import subscription_to_row

START, END = 1789655737, 1792247737


def _expect(row):
    assert row["current_period_start"] is not None, "period start was dropped"
    assert row["current_period_end"] is not None, "period end was dropped"
    assert datetime.fromisoformat(row["current_period_start"]) == \
        datetime.fromtimestamp(START, tz=timezone.utc)
    assert datetime.fromisoformat(row["current_period_end"]) == \
        datetime.fromtimestamp(END, tz=timezone.utc)


def _item(with_period: bool):
    item = {"price": {"recurring": {"interval": "month"}}}
    if with_period:
        item["current_period_start"] = START
        item["current_period_end"] = END
    return {"data": [item]}


def test_new_shape_periods_on_the_item():
    """What webhooks actually send on 2026-08-26 and later."""
    _expect(subscription_to_row({
        "id": "sub_x", "status": "active", "items": _item(True),
        "metadata": {"axis_plan_key": "solo"},
    }))


def test_old_shape_periods_at_the_top_level():
    """What the pinned SDK returns from a retrieve."""
    _expect(subscription_to_row({
        "id": "sub_x", "status": "active", "items": _item(False),
        "current_period_start": START, "current_period_end": END,
        "metadata": {"axis_plan_key": "solo"},
    }))


def test_both_present_agree():
    _expect(subscription_to_row({
        "id": "sub_x", "status": "active", "items": _item(True),
        "current_period_start": START, "current_period_end": END,
    }))


def test_an_active_row_always_carries_a_period():
    """The specific disaster: status active with null periods. evaluate()
    reads that as no active period and locks a paying contractor out."""
    row = subscription_to_row({
        "id": "sub_x", "status": "active", "items": _item(True),
        "metadata": {"axis_plan_key": "crew"},
    })
    assert row["status"] == "active"
    assert row["current_period_end"] is not None

    from app.core.plans import evaluate
    row["trial_report_used"] = True
    d = evaluate(row, "access_app")
    assert d.would_allow is True, "a paid, active subscription must grant access"


def test_missing_periods_entirely_are_not_invented():
    row = subscription_to_row({"id": "sub_x", "status": "incomplete",
                               "items": _item(False)})
    assert row["current_period_start"] is None
    assert row["current_period_end"] is None
