"""Crew allowance: counting crews, and what a downgrade is allowed to switch off.

crews_used() asked for a table "sched_crews" and a column "user_id"; neither
exists, so it always returned 0 and the plan's crew cap counted nothing while
the downgrade warning never fired. The warning it never fired also promised
something no code did: that crews would be "switched off" on the change date.
"""
from datetime import date, datetime, timedelta, timezone

from app.api.v1 import scheduling as sc
from app.core import plans
from app.services import entitlement

ORG_USER = "22222222-3333-4444-5555-666666666666"


class _Q:
    def __init__(self, db, t): self.db, self.t, self.f, self.ge = db, t, [], None
    def select(self, *a, **k): return self
    def limit(self, *a, **k): return self
    def order(self, *a, **k): return self
    def eq(self, c, v): self.f.append((c, v)); return self
    def gte(self, c, v): self.ge = (c, v); return self
    def update(self, patch): self.patch = patch; return self
    def execute(self):
        rows = [r for r in self.db.rows.get(self.t, [])
                if all(r.get(c) == v for c, v in self.f)]
        if self.ge:
            c, v = self.ge
            rows = [r for r in rows if str(r.get(c) or "") >= v]
        if hasattr(self, "patch"):
            for r in rows:
                r.update(self.patch)
            self.db.writes += 1
        return type("R", (), {"data": rows})()


class _DB:
    def __init__(self, rows): self.rows, self.writes = rows, 0
    def table(self, t): return _Q(self, t)


def _crew(cid, name, sq=25.0, active=True):
    return {"id": cid, "org_id": ORG_USER, "name": name,
            "squares_per_day": sq, "is_active": active}


# ── counting ────────────────────────────────────────────────────────────────

def test_the_crew_count_is_real_now():
    db = _DB({"sched_crew": [_crew("c1", "A"), _crew("c2", "B"), _crew("c3", "C")]})
    assert entitlement.crews_used(db, ORG_USER) == 3


def test_retired_crews_do_not_eat_the_allowance():
    """Deleting a crew only flags it inactive, so a naive count would let
    archived crews fill the plan."""
    db = _DB({"sched_crew": [_crew("c1", "A"), _crew("c2", "B", active=False)]})
    assert entitlement.crews_used(db, ORG_USER) == 1


def test_the_count_is_scoped_to_the_org_not_the_whole_table():
    db = _DB({"sched_crew": [_crew("c1", "Mine"),
                             {"id": "c9", "org_id": "someone-else", "name": "Theirs",
                              "squares_per_day": 25.0, "is_active": True}]})
    assert entitlement.crews_used(db, ORG_USER) == 1


def test_a_counting_failure_over_grants_rather_than_blocking():
    class _Boom:
        def table(self, t): raise RuntimeError("database down")
    assert entitlement.crews_used(_Boom(), ORG_USER) == 0


def test_the_cap_now_actually_counts():
    """With a real count, Solo's 4th crew is refused where it used to pass.

    Asserts would_allow, not allowed: BILLING_ENFORCE is off, so `allowed` is
    forced True and the real verdict rides on would_allow. That is also why
    fixing the count changes nothing visible today — it only starts recording
    who WOULD be blocked.
    """
    now = datetime(2026, 10, 11, tzinfo=timezone.utc)
    sub = {"plan_key": "solo", "status": "active",
           "current_period_start": (now - timedelta(days=5)).isoformat(),
           "current_period_end": (now + timedelta(days=25)).isoformat()}
    ok = plans.evaluate(sub, "add_crew", crews_used=2, now=now)
    full = plans.evaluate(sub, "add_crew", crews_used=plans.PLANS["solo"].crews, now=now)
    assert ok.would_allow, ok.reason
    assert not full.would_allow, full.reason
    assert "3" in full.reason


# ── what a downgrade may switch off ─────────────────────────────────────────

def test_a_downgrade_retires_only_crews_with_no_upcoming_work():
    """The one that matters: the board hides an inactive crew AND its
    appointments, so retiring a booked crew would make real scheduled work
    vanish the morning after a billing date."""
    soon = (date.today() + timedelta(days=3)).isoformat() + "T08:00:00"
    db = _DB({
        "sched_crew": [_crew("busy", "Busy", sq=10.0), _crew("idle", "Idle", sq=30.0)],
        "sched_assignment": [{"org_id": ORG_USER, "crew_id": "busy", "appointment_id": "a1"}],
        "sched_appointment": [{"id": "a1", "org_id": ORG_USER,
                               "scheduled_start": soon, "status": "SCHEDULED"}],
    })
    retired = sc.retire_crews_over_plan(db, ORG_USER, keep=1)
    assert [c["id"] for c in retired] == ["idle"]
    by_id = {c["id"]: c for c in db.rows["sched_crew"]}
    assert by_id["busy"]["is_active"] is True
    assert by_id["idle"]["is_active"] is False


def test_a_booked_crew_survives_even_if_that_leaves_the_account_over_plan():
    soon = (date.today() + timedelta(days=2)).isoformat() + "T08:00:00"
    db = _DB({
        "sched_crew": [_crew("c1", "One"), _crew("c2", "Two")],
        "sched_assignment": [{"org_id": ORG_USER, "crew_id": c, "appointment_id": f"a{c}"}
                             for c in ("c1", "c2")],
        "sched_appointment": [{"id": f"ac{i}", "org_id": ORG_USER,
                               "scheduled_start": soon, "status": "SCHEDULED"}
                              for i in (1, 2)],
    })
    db.rows["sched_appointment"] = [{"id": "ac1", "org_id": ORG_USER, "scheduled_start": soon,
                                     "status": "SCHEDULED"},
                                    {"id": "ac2", "org_id": ORG_USER, "scheduled_start": soon,
                                     "status": "SCHEDULED"}]
    retired = sc.retire_crews_over_plan(db, ORG_USER, keep=0)
    assert retired == []
    assert all(c["is_active"] for c in db.rows["sched_crew"])


def test_finished_and_cancelled_work_does_not_protect_a_crew():
    soon = (date.today() + timedelta(days=1)).isoformat() + "T08:00:00"
    db = _DB({
        "sched_crew": [_crew("c1", "Done work")],
        "sched_assignment": [{"org_id": ORG_USER, "crew_id": "c1", "appointment_id": "a1"}],
        "sched_appointment": [{"id": "a1", "org_id": ORG_USER,
                               "scheduled_start": soon, "status": "CANCELED"}],
    })
    assert [c["id"] for c in sc.retire_crews_over_plan(db, ORG_USER, keep=0)] == ["c1"]


def test_past_work_does_not_protect_a_crew():
    old = (date.today() - timedelta(days=30)).isoformat() + "T08:00:00"
    db = _DB({
        "sched_crew": [_crew("c1", "Old work")],
        "sched_assignment": [{"org_id": ORG_USER, "crew_id": "c1", "appointment_id": "a1"}],
        "sched_appointment": [{"id": "a1", "org_id": ORG_USER,
                               "scheduled_start": old, "status": "DONE"}],
    })
    assert [c["id"] for c in sc.retire_crews_over_plan(db, ORG_USER, keep=0)] == ["c1"]


def test_the_least_productive_free_crew_goes_first():
    db = _DB({"sched_crew": [_crew("big", "Big", sq=40.0), _crew("small", "Small", sq=5.0)]})
    assert [c["id"] for c in sc.retire_crews_over_plan(db, ORG_USER, keep=1)] == ["small"]


def test_an_account_within_its_plan_is_left_alone():
    db = _DB({"sched_crew": [_crew("c1", "A")]})
    assert sc.retire_crews_over_plan(db, ORG_USER, keep=3) == []
    assert db.writes == 0


def test_retiring_is_idempotent():
    db = _DB({"sched_crew": [_crew("c1", "A"), _crew("c2", "B")]})
    first = sc.retire_crews_over_plan(db, ORG_USER, keep=1)
    second = sc.retire_crews_over_plan(db, ORG_USER, keep=1)
    assert len(first) == 1 and second == []


def test_it_never_touches_another_orgs_crews():
    db = _DB({"sched_crew": [_crew("mine", "Mine"),
                             {"id": "theirs", "org_id": "other-org", "name": "Theirs",
                              "squares_per_day": 1.0, "is_active": True}]})
    sc.retire_crews_over_plan(db, ORG_USER, keep=0)
    assert {c["id"] for c in db.rows["sched_crew"] if c["is_active"]} == {"theirs"}


# ── the message must describe what the code does ────────────────────────────

def test_the_downgrade_warning_no_longer_promises_what_nothing_did():
    ch = plans.can_change_plan("fleet", "solo", crews_used=5)
    assert ch.warning and "no upcoming work" in ch.warning
    assert "left running" in ch.warning
    # The old copy flatly promised crews "will be switched off".
    assert "will be" not in ch.warning


def test_an_unlimited_plan_retires_nothing():
    assert plans.PLANS["fleet"].crews == plans.UNLIMITED
