"""Company promo codes: one use, own clock, founder mark, the lock, emails.

The database is an in-memory stand-in that applies the same filters the real
code sends (eq / is_ null / lt), so the conditional claim that stops two
people redeeming one code is actually exercised."""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.api.v1 import promo
from app.core import plans
from app.services import email_service, entitlement

U1 = {"id": "11111111-1111-1111-1111-111111111111", "email": "owner@fortitude.example"}
U2 = {"id": "22222222-2222-2222-2222-222222222222", "email": "jill@roofpro.example"}


class _Res:
    def __init__(self, data): self.data = data


class _Q:
    def __init__(self, db, name):
        self.db, self.name, self.filters, self.op, self.payload = db, name, [], "select", None
        self.conflict = None

    def select(self, *a, **k): self.op = "select"; return self
    def eq(self, c, v): self.filters.append(lambda r: str(r.get(c)) == str(v)); return self
    def is_(self, c, v): self.filters.append(lambda r: r.get(c) is None); return self
    def lt(self, c, v): self.filters.append(lambda r: r.get(c) is not None and str(r.get(c)) < str(v)); return self
    def in_(self, c, vs): self.filters.append(lambda r: r.get(c) in vs); return self
    def order(self, *a, **k): return self
    def limit(self, *a): return self
    def insert(self, row): self.op, self.payload = "insert", row; return self
    def update(self, row): self.op, self.payload = "update", row; return self
    def upsert(self, row, on_conflict=None): self.op, self.payload, self.conflict = "upsert", row, on_conflict; return self

    def execute(self):
        rows = self.db.tables.setdefault(self.name, [])
        match = [r for r in rows if all(f(r) for f in self.filters)]
        if self.op == "select":
            return _Res([dict(r) for r in match])
        if self.op == "insert":
            row = {"id": f"id{len(rows) + 1}", "created_at": datetime.now(timezone.utc).isoformat(), **self.payload}
            rows.append(row)
            return _Res([dict(row)])
        if self.op == "update":
            for r in match:
                r.update(self.payload)
            return _Res([dict(r) for r in match])
        if self.op == "upsert":
            key = self.conflict
            hit = [r for r in rows if r.get(key) == self.payload.get(key)]
            if hit:
                hit[0].update(self.payload)
                return _Res([dict(hit[0])])
            rows.append(dict(self.payload))
            return _Res([dict(self.payload)])


class _FakeDB:
    def __init__(self):
        self.tables = {}

    def table(self, name): return _Q(self, name)


@pytest.fixture
def db(monkeypatch):
    d = _FakeDB()
    monkeypatch.setattr(promo, "get_supabase", lambda: d)
    sent = []
    monkeypatch.setattr(email_service, "send", lambda to, subj, text: sent.append((to, subj)) or True)
    monkeypatch.setattr(promo, "_email_for", lambda db_, uid: {U1["id"]: U1["email"], U2["id"]: U2["email"]}.get(uid, ""))
    d.sent = sent
    return d


def _code(db, code="FORTITUDE", company="Fortitude Roofing", expires_days=60):
    db.tables.setdefault("promo_codes", []).append({
        "id": code.lower(), "code": code, "company": company, "free_reports": 3, "access_days": 7,
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=expires_days)).isoformat(),
        "redeemed_by": None, "redeemed_at": None})


def _redeem(code, user):
    return asyncio.run(promo.redeem(promo.RedeemRequest(code=code), user))


def test_redeeming_gives_three_reports_seven_days_and_founder(db):
    _code(db)
    out = _redeem(" fortitude ", U1)                     # case and spaces forgiven
    assert out["free_reports"] == 3 and out["access_days"] == 7 and out["founding_member"]
    sub = db.tables["subscriptions"][0]
    assert sub["promo_reports_left"] == 3 and sub["founding_member"] is True
    until = datetime.fromisoformat(sub["promo_access_until"])
    assert timedelta(days=6, hours=23) < until - datetime.now(timezone.utc) <= timedelta(days=7)
    assert db.sent and db.sent[0][0] == U1["email"]      # thank-you email went out


def test_a_code_works_once(db):
    _code(db)
    _redeem("FORTITUDE", U1)
    with pytest.raises(HTTPException) as e:
        _redeem("FORTITUDE", U2)
    assert e.value.status_code == 409 and "already been used" in e.value.detail


def test_an_unredeemed_code_expires(db):
    _code(db, expires_days=-1)
    with pytest.raises(HTTPException) as e:
        _redeem("FORTITUDE", U1)
    assert e.value.status_code == 410


def test_one_promo_per_account(db):
    _code(db, "FORTITUDE"); _code(db, "ROOFPRO", "Roof Pro NC")
    _redeem("FORTITUDE", U1)
    with pytest.raises(HTTPException) as e:
        _redeem("ROOFPRO", U1)
    assert e.value.status_code == 409
    assert db.tables["promo_codes"][1]["redeemed_by"] is None    # ROOFPRO still free for Jill


def test_unknown_code(db):
    with pytest.raises(HTTPException) as e:
        _redeem("NOPE123", U1)
    assert e.value.status_code == 404


def test_reports_count_down_and_stop_at_zero(db):
    _code(db)
    _redeem("FORTITUDE", U1)
    for _ in range(5):
        entitlement.consume_promo_report(db, U1["id"])
    assert db.tables["subscriptions"][0]["promo_reports_left"] == 0


def test_the_lock_blocks_an_account_with_no_plan_and_no_promo(db, monkeypatch):
    monkeypatch.setenv("BILLING_ENFORCE", "true")
    monkeypatch.setattr(entitlement, "_record_denial", lambda *a, **k: None)
    monkeypatch.setattr(promo, "get_current_user", _fake_user(U2))
    with pytest.raises(HTTPException) as e:
        asyncio.run(promo.require_app_access(_Creds()))
    assert e.value.status_code == 402 and e.value.detail["error"] == "access_required"


def test_the_lock_lets_a_running_promo_through(db, monkeypatch):
    monkeypatch.setenv("BILLING_ENFORCE", "true")
    _code(db)
    _redeem("FORTITUDE", U1)
    monkeypatch.setattr(promo, "get_current_user", _fake_user(U1))
    asyncio.run(promo.require_app_access(_Creds()))     # no exception


def test_requests_without_a_token_are_left_to_the_endpoint(db, monkeypatch):
    """Homeowner-facing public endpoints share routers with the app."""
    monkeypatch.setenv("BILLING_ENFORCE", "true")
    asyncio.run(promo.require_app_access(None))


def test_admins_are_never_locked_out(db, monkeypatch):
    monkeypatch.setenv("BILLING_ENFORCE", "true")
    admin = {"id": "f9dafe47-810a-4c72-81c6-dbe2d9baf64b", "email": ""}
    monkeypatch.setattr(promo, "get_current_user", _fake_user(admin))
    asyncio.run(promo.require_app_access(_Creds()))


def test_trial_ended_email_goes_out_once(db):
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    db.tables["subscriptions"] = [{"user_id": U1["id"], "promo_access_until": past,
                                   "promo_reports_left": 1, "promo_reports_total": 3,
                                   "promo_ended_sent_at": None, "status": "none"}]
    assert promo.send_ended_emails(db) == 1
    assert promo.send_ended_emails(db) == 0
    assert db.sent[-1][1] == "Thank you for trying Axis"


def test_no_trial_ended_email_for_someone_who_subscribed(db):
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    db.tables["subscriptions"] = [{"user_id": U1["id"], "promo_access_until": past,
                                   "plan_key": "solo", "status": "active", "promo_ended_sent_at": None}]
    assert promo.send_ended_emails(db) == 0


def test_founders_view_lists_codes_and_reports(db):
    _code(db, "FORTITUDE"); _code(db, "ROOFPRO", "Roof Pro NC")
    _redeem("FORTITUDE", U1)
    db.tables["report_events"] = [{"user_id": U1["id"], "run_id": "r1", "kind": "generate",
                                   "created_at": "2026-10-10T15:00:00+00:00"}]
    db.tables["roof_measurement_runs"] = [{"id": "r1", "project_id": "p1"}]
    db.tables["projects"] = [{"id": "p1", "name": "12 Oak St, Leland, NC"}]
    out = asyncio.run(promo.founders({"id": "admin"}))
    by = {c["code"]: c for c in out["codes"]}
    assert by["FORTITUDE"]["state"] == "trial" and by["FORTITUDE"]["account_email"] == U1["email"]
    assert by["FORTITUDE"]["reports"][0]["address"] == "12 Oak St, Leland, NC"
    assert by["ROOFPRO"]["state"] == "unused"


class _Creds:
    credentials = "token"


def _fake_user(u):
    async def f(creds):
        return u
    return f
