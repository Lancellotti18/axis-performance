"""Plan changes must reach Stripe, not only Axis.

A scheduled downgrade used to be recorded in Axis alone: at renewal the webhook
gave the contractor the smaller plan while Stripe went on charging the bigger
price. These pin what each kind of change sends to Stripe, using a fake Stripe
and a fake subscriptions table, so no network or real account is involved."""
import asyncio

import pytest
from fastapi import HTTPException

from app.api.v1 import billing
from app.services import stripe_service

USER = {"id": "u1", "email": "c@example.com"}


class FakeStripe:
    def __init__(self, interval="month", schedule=None, pending=False):
        self.calls = []
        self.interval = interval
        self.schedule = schedule
        self.pending = pending
        fs = self

        class Subscription:
            @staticmethod
            def retrieve(sid):
                return {"id": sid, "schedule": fs.schedule,
                        "items": {"data": [{"id": "si_1", "price": {"id": "price_old"}}]}}

            @staticmethod
            def modify(sid, **kw):
                fs.calls.append(("sub.modify", kw))
                return {"pending_update": {"x": 1}} if (fs.pending and "items" in kw) else {}

        class SubscriptionSchedule:
            @staticmethod
            def create(**kw):
                fs.calls.append(("sched.create", kw))
                return {"id": "sub_sched_1", "phases": [
                    {"start_date": 100, "end_date": 200,
                     "items": [{"price": "price_old"}]}]}

            @staticmethod
            def retrieve(sid):
                fs.calls.append(("sched.retrieve", sid))
                return {"id": sid, "phases": [
                    {"start_date": 100, "end_date": 200, "items": [{"price": "price_old"}]}]}

            @staticmethod
            def modify(sid, **kw):
                fs.calls.append(("sched.modify", kw))
                return {}

            @staticmethod
            def release(sid):
                fs.calls.append(("sched.release", sid))
                return {}

        self.Subscription = Subscription
        self.SubscriptionSchedule = SubscriptionSchedule

    def names(self):
        return [c[0] for c in self.calls]


class FakeDB:
    def __init__(self, row):
        self.row = row
        self.writes = []

    def table(self, name):
        db = self

        class Q:
            def __init__(self):
                self._update = None

            def select(self, *_):
                return self

            def eq(self, *_):
                return self

            def limit(self, *_):
                return self

            def update(self, fields):
                self._update = fields
                return self

            def execute(self):
                class R:
                    pass
                r = R()
                if self._update is not None:
                    db.writes.append(self._update)
                    r.data = [self._update]
                else:
                    r.data = [db.row]
                return r
        return Q()


def _setup(monkeypatch, *, plan="crew", interval="month", **stripe_kw):
    fake = FakeStripe(interval=interval, **stripe_kw)
    db = FakeDB({"user_id": "u1", "plan_key": plan, "billing_interval": interval,
                 "stripe_subscription_id": "sub_1", "current_period_end": "2026-11-09T00:00:00+00:00"})
    monkeypatch.setattr(stripe_service, "client", lambda: fake)
    monkeypatch.setattr(stripe_service, "price_id", lambda p, i: f"price_{p}_{i}")
    monkeypatch.setattr(billing, "get_supabase", lambda: db)
    monkeypatch.setattr(billing, "_crew_count", lambda db, uid: 0)
    return fake, db


def _change(plan, interval=None):
    return asyncio.run(billing.change_plan(
        billing.ChangePlanRequest(plan_key=plan, interval=interval), user=USER))


def test_a_downgrade_is_handed_to_stripe_as_a_schedule(monkeypatch):
    fake, db = _setup(monkeypatch, plan="fleet")
    out = _change("solo")
    assert out["effective"] == "period_end"
    mod = [c[1] for c in fake.calls if c[0] == "sched.modify"][0]
    now_phase, next_phase = mod["phases"]
    assert now_phase["items"][0]["price"] == "price_old"           # paid period untouched
    assert (now_phase["start_date"], now_phase["end_date"]) == (100, 200)
    assert next_phase["items"][0]["price"] == "price_solo_month"   # Stripe charges Solo next
    assert next_phase["metadata"]["axis_plan_key"] == "solo"
    assert mod["end_behavior"] == "release"
    # Nothing changes inside the paid period.
    assert "sub.modify" not in fake.names()
    assert db.writes[-1]["scheduled_plan_key"] == "solo"
    assert "plan_key" not in db.writes[-1]


def test_monthly_to_annual_bills_now_and_cannot_half_switch(monkeypatch):
    fake, db = _setup(monkeypatch, plan="crew", interval="month")
    out = _change("crew", "year")
    assert out["effective"] == "now" and out["interval"] == "year"
    first = [c[1] for c in fake.calls if c[0] == "sub.modify"][0]
    assert first["items"][0]["price"] == "price_crew_year"
    assert first["proration_behavior"] == "always_invoice"
    assert first["payment_behavior"] == "pending_if_incomplete"
    assert db.writes[-1]["billing_interval"] == "year"


def test_a_declined_card_on_the_switch_to_annual_changes_nothing(monkeypatch):
    fake, db = _setup(monkeypatch, plan="crew", interval="month", pending=True)
    with pytest.raises(HTTPException) as e:
        _change("crew", "year")
    assert e.value.status_code == 402
    assert db.writes == []


def test_annual_to_monthly_waits_for_the_renewal(monkeypatch):
    fake, db = _setup(monkeypatch, plan="crew", interval="year")
    out = _change("crew", "month")
    assert out["effective"] == "period_end"
    mod = [c[1] for c in fake.calls if c[0] == "sched.modify"][0]
    assert mod["phases"][1]["items"][0]["price"] == "price_crew_month"
    assert db.writes[-1]["scheduled_interval"] == "month"


def test_an_upgrade_releases_a_pending_downgrade_first(monkeypatch):
    fake, db = _setup(monkeypatch, plan="crew", schedule="sub_sched_9")
    out = _change("fleet")
    assert out["effective"] == "now"
    assert fake.names().index("sched.release") < fake.names().index("sub.modify")
    assert db.writes[-1]["scheduled_plan_key"] is None


def test_cancel_releases_the_schedule_and_drops_the_pending_change(monkeypatch):
    fake, db = _setup(monkeypatch, plan="fleet", schedule="sub_sched_9")
    asyncio.run(billing.cancel_plan(user=USER))
    assert fake.names().index("sched.release") < fake.names().index("sub.modify")
    assert db.writes[-1]["scheduled_plan_key"] is None and db.writes[-1]["cancel_at_period_end"]


def test_no_change_is_refused(monkeypatch):
    _setup(monkeypatch, plan="crew", interval="month")
    with pytest.raises(HTTPException) as e:
        _change("crew", "month")
    assert e.value.status_code == 400


def test_a_missing_scheduled_interval_column_degrades_instead_of_failing(monkeypatch):
    """Before the migration runs, the write must drop the new column and go on."""
    class Picky(FakeDB):
        def table(self, name):
            q = super().table(name)
            orig = q.update

            def update(fields):
                if "scheduled_interval" in fields:
                    raise Exception('column "scheduled_interval" does not exist')
                return orig(fields)
            q.update = update
            return q
    db = Picky({})
    billing._write_schedule(db, "u1", {"scheduled_plan_key": "solo", "scheduled_interval": "month"})
    assert db.writes == [{"scheduled_plan_key": "solo"}]
