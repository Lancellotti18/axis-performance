"""The overage flow: counting what was used, and never charging without a click.

plans.evaluate() is tested pure in test_plans_entitlement.py. These cover the
part that touches the database — the period window the count runs over, what
counts as a purchased report, and the shadow-mode contract that makes it safe
to ship enforcement turned off.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.services import entitlement


# ── A fake Supabase client covering only the chains this service builds ────

class _Q:
    def __init__(self, table):
        self.t = table
        self.filters = []
        self._payload = None
        self._op = "select"

    def select(self, *_a, **_k):
        return self

    def insert(self, values):
        self._op, self._payload = "insert", values
        return self

    def update(self, values):
        self._op, self._payload = "update", values
        return self

    def upsert(self, values, **_k):
        self._op, self._payload = "upsert", values
        return self

    def eq(self, col, val):
        self.filters.append(("eq", col, val))
        return self

    def gte(self, col, val):
        self.filters.append(("gte", col, val))
        return self

    def lt(self, col, val):
        self.filters.append(("lt", col, val))
        return self

    def limit(self, *_a):
        return self

    def execute(self):
        if self._op in ("insert", "upsert", "update"):
            self.t.writes.append((self._op, self._payload))
            return type("R", (), {"data": [dict(self._payload or {}, id="row1")]})()
        rows = []
        for r in self.t.rows:
            keep = True
            for kind, col, val in self.filters:
                got = r.get(col)
                if kind == "eq" and got != val:
                    keep = False
                elif kind == "gte" and not (got is not None and str(got) >= str(val)):
                    keep = False
                elif kind == "lt" and not (got is not None and str(got) < str(val)):
                    keep = False
            if keep:
                rows.append(r)
        return type("R", (), {"data": rows})()


class _T:
    def __init__(self, rows=None):
        self.rows = rows or []
        self.writes = []


class _DB:
    def __init__(self, **tables):
        self.tables = {k: _T(v) for k, v in tables.items()}

    def table(self, name):
        self.tables.setdefault(name, _T([]))
        return _Q(self.tables[name])


NOW = datetime.now(timezone.utc)
START = (NOW - timedelta(days=10)).isoformat()
END = (NOW + timedelta(days=20)).isoformat()


def _sub(plan="crew", **over):
    row = {"user_id": "u1", "plan_key": plan, "status": "active",
           "current_period_start": START, "current_period_end": END}
    row.update(over)
    return row


def _report(when, kind="generate", user="u1"):
    return {"id": "r", "user_id": user, "kind": kind, "created_at": when}


def _in_period(n):
    """n billable reports, all inside the current period.

    Spread by HOURS deliberately: the period opened 10 days ago, so spacing
    these a day apart would push most of them outside the very window under
    test and quietly under-count.
    """
    return [_report((NOW - timedelta(hours=i + 1)).isoformat()) for i in range(n)]


# ── Counting reports against the billing period ───────────────────────────

def test_only_generate_events_in_this_period_count():
    before = (NOW - timedelta(days=40)).isoformat()   # a previous period
    db = _DB(report_events=[
        _report((NOW - timedelta(days=5)).isoformat()),
        _report((NOW - timedelta(days=2)).isoformat()),
        _report((NOW - timedelta(days=1)).isoformat(), kind="rebuild"),  # not billable
        _report(before),                                                  # last period
        _report((NOW - timedelta(days=3)).isoformat(), user="someone-else"),
    ])
    assert entitlement.reports_used(db, "u1", _sub()) == 2


def test_no_period_means_nothing_is_counted():
    """An unsubscribed contractor has no window; the promo branch handles them."""
    db = _DB(report_events=[_report(NOW.isoformat())])
    assert entitlement.reports_used(db, "u1", None) == 0


def test_a_count_failure_does_not_block_the_contractor():
    """Over-granting costs $35 of margin. Wrongly denying costs the customer."""
    class Broken:
        def table(self, _n):
            raise RuntimeError("supabase down")
    assert entitlement.reports_used(Broken(), "u1", _sub()) == 0


# ── What counts as a purchased extra report ───────────────────────────────

def test_only_paid_overage_in_the_current_period_grants_anything():
    db = _DB(overage_purchases=[
        {"user_id": "u1", "quantity": 1, "status": "succeeded", "period_end": END},
        {"user_id": "u1", "quantity": 2, "status": "succeeded", "period_end": END},
        {"user_id": "u1", "quantity": 5, "status": "pending",   "period_end": END},
        {"user_id": "u1", "quantity": 9, "status": "failed",    "period_end": END},
        {"user_id": "u1", "quantity": 4, "status": "succeeded",
         "period_end": (NOW - timedelta(days=40)).isoformat()},   # expired top-up
    ])
    assert entitlement.overage_purchased(db, "u1", _sub()) == 3


# ── The shadow-mode contract ──────────────────────────────────────────────

def test_shadow_mode_allows_but_records_what_it_would_have_blocked(monkeypatch):
    monkeypatch.delenv("BILLING_ENFORCE", raising=False)
    used = _in_period(30)
    db = _DB(subscriptions=[_sub()], report_events=used)

    d = entitlement.check(db, "u1", "generate_report")
    assert d.would_allow is False, "30 of 30 used — the verdict must be no"
    assert d.allowed is True, "but shadow mode must not actually block"
    assert d.requires_purchase is True
    assert d.purchase_price_usd == 35

    writes = db.tables["entitlement_denials"].writes
    assert len(writes) == 1, "the would-be denial must be logged"
    assert writes[0][1]["enforced"] is False
    assert writes[0][1]["action"] == "generate_report"


def test_enforcement_actually_denies(monkeypatch):
    monkeypatch.setenv("BILLING_ENFORCE", "true")
    used = _in_period(30)
    db = _DB(subscriptions=[_sub()], report_events=used)
    d = entitlement.check(db, "u1", "generate_report")
    assert d.allowed is False and d.would_allow is False
    assert db.tables["entitlement_denials"].writes[0][1]["enforced"] is True


def test_a_purchased_report_clears_the_block(monkeypatch):
    """The whole point of the flow: after paying, the next report goes through."""
    monkeypatch.setenv("BILLING_ENFORCE", "true")
    used = _in_period(30)
    db = _DB(subscriptions=[_sub()], report_events=used,
             overage_purchases=[{"user_id": "u1", "quantity": 1,
                                 "status": "succeeded", "period_end": END}])
    d = entitlement.check(db, "u1", "generate_report")
    assert d.allowed is True, "31 of 30+1 — the purchased report must count"


def test_nothing_is_logged_when_nothing_is_denied(monkeypatch):
    monkeypatch.delenv("BILLING_ENFORCE", raising=False)
    db = _DB(subscriptions=[_sub()], report_events=[])
    entitlement.check(db, "u1", "generate_report")
    assert "entitlement_denials" not in db.tables, \
        "an allowed action must not touch the denial log at all"


# ── What Settings and the prompt both render ───────────────────────────────

def test_usage_summary_math():
    used = _in_period(16)
    db = _DB(subscriptions=[_sub()], report_events=used,
             overage_purchases=[{"user_id": "u1", "quantity": 2,
                                 "status": "succeeded", "period_end": END}])
    u = entitlement.usage_summary(db, "u1")
    assert u["reports_used"] == 16
    assert u["reports_included"] == 30
    assert u["overage_purchased"] == 2
    assert u["reports_entitled"] == 32
    assert u["reports_remaining"] == 16
    assert u["reports_unlimited"] is False


def test_fleet_reads_as_unlimited_not_as_minus_one():
    """UNLIMITED is -1 internally; surfacing that to a UI would render '-1'."""
    db = _DB(subscriptions=[_sub(plan="fleet")], report_events=[])
    u = entitlement.usage_summary(db, "u1")
    assert u["reports_unlimited"] is True
    assert u["reports_included"] is None
    assert u["reports_entitled"] is None
    assert u["reports_remaining"] is None


def test_remaining_never_goes_negative():
    used = _in_period(40)
    db = _DB(subscriptions=[_sub()], report_events=used)
    assert entitlement.usage_summary(db, "u1")["reports_remaining"] == 0


# ── The free report is spent once ─────────────────────────────────────────

def test_consuming_the_trial_upserts_so_a_contractor_with_no_row_still_works():
    db = _DB()
    entitlement.consume_trial_report(db, "u1")
    op, payload = db.tables["subscriptions"].writes[0]
    assert op == "upsert", "signup does not create a subscriptions row"
    assert payload["trial_report_used"] is True


# ── The gate only fires on the call that would actually bill ──────────────

def test_the_gate_ignores_traces_that_are_not_billable():
    from app.api.v1 import roofing_v2 as r

    class _NotBilled:
        def table(self, _n):
            return _Q(_T([]))

    db = _NotBilled()
    assert r._would_newly_bill(db, "run1", {"blocking_issues": ["bad"],
                                            "total_roof_sqft": 2000}) is False
    assert r._would_newly_bill(db, "run1", {"total_roof_sqft": 0}) is False
    assert r._would_newly_bill(db, "run1", {}) is False
    # A finished, unbilled trace IS billable.
    assert r._would_newly_bill(db, "run1", {"total_roof_sqft": 2400}) is True


def test_a_run_already_billed_is_never_gated_or_charged_again():
    """recompute fires on every edit, and reopening a paid roof must be free."""
    from app.api.v1 import roofing_v2 as r
    db = _DB(report_events=[{"id": "x", "run_id": "run1", "kind": "generate"}])
    assert r._would_newly_bill(db, "run1", {"total_roof_sqft": 2400}) is False


# ── The price is never client-supplied ────────────────────────────────────

def test_the_purchase_request_cannot_name_a_price():
    from app.api.v1.billing import PurchaseReportRequest
    assert set(PurchaseReportRequest.model_fields) == {"quantity"}, \
        "an amount in the body would let someone buy a report for a dollar"
