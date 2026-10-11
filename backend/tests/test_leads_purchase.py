"""Exclusive leads: what browsing reveals, and who gets charged for what.

The fake database enforces the real partial unique index on
(source_county, prospect_pin) WHERE status IN ('pending','succeeded'), because
that index is the entire exclusivity guarantee. A test that let two
reservations through would be testing nothing.
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.api.v1 import billing, prospecting
from app.services import entitlement, leads as leads_svc, stripe_service

U1 = {"id": "11111111-1111-1111-1111-111111111111", "email": "owner@fortitude.example"}
U2 = {"id": "22222222-2222-2222-2222-222222222222", "email": "jill@roofpro.example"}
COUNTY = "new_hanover"

LIVE_STATUSES = ("pending", "succeeded")


def _row(pin="P1", **over):
    r = {"pin": pin, "address": f"{pin} Buch Ave", "city": "WILMINGTON", "zip": "28403",
         "owner": "SMITH JOHN", "owner_mail": "PO BOX 5, WILMINGTON NC", "owner_occupied": True,
         "year_built": 1958, "sold_year": 2009, "sold_months": 200, "tax_value": 240000,
         "lat": 34.22, "lng": -77.87, "score": 88, "tier": "Hot", "confidence": "high",
         "why": "Built in 1958 — near replacement age"}
    r.update(over)
    return r


class _Res:
    def __init__(self, data): self.data = data


class _Unique(Exception):
    """What Postgres sends back as 23505."""
    def __init__(self): super().__init__('duplicate key value violates unique constraint')


class _Q:
    def __init__(self, db, name):
        self.db, self.name, self.filters, self.op, self.payload = db, name, [], "select", None

    def select(self, *a, **k): self.op = "select"; return self
    def eq(self, c, v): self.filters.append(lambda r: str(r.get(c)) == str(v)); return self
    def lt(self, c, v): self.filters.append(lambda r: r.get(c) is not None and str(r.get(c)) < str(v)); return self
    def in_(self, c, vs): self.filters.append(lambda r: r.get(c) in vs); return self
    def order(self, *a, **k): return self
    def limit(self, *a): return self
    def insert(self, row): self.op, self.payload = "insert", row; return self
    def update(self, row): self.op, self.payload = "update", row; return self

    def execute(self):
        rows = self.db.tables.setdefault(self.name, [])
        match = [r for r in rows if all(f(r) for f in self.filters)]
        if self.op == "select":
            return _Res([dict(r) for r in match])
        if self.op == "insert":
            if self.name == "purchased_leads" and self.payload.get("status") in LIVE_STATUSES:
                clash = [r for r in rows
                         if r.get("source_county") == self.payload.get("source_county")
                         and str(r.get("prospect_pin")) == str(self.payload.get("prospect_pin"))
                         and r.get("status") in LIVE_STATUSES]
                if clash:
                    raise _Unique()
            row = {"id": f"id{len(rows) + 1}",
                   "created_at": datetime.now(timezone.utc).isoformat(), **self.payload}
            rows.append(row)
            return _Res([dict(row)])
        if self.op == "update":
            for r in match:
                r.update(self.payload)
            return _Res([dict(r) for r in match])


class _FakeDB:
    def __init__(self): self.tables = {}
    def table(self, name): return _Q(self, name)


class _FakeStripe:
    """Records what it was asked to charge, so a test can assert on nobody
    being charged as easily as on the amount."""
    def __init__(self, status="succeeded", boom=False):
        self.calls, self.status, self.boom = [], status, boom
        self.PaymentIntent = self

    def create(self, **kw):
        self.calls.append(kw)
        if self.boom:
            raise RuntimeError("card_declined")
        return {"id": f"pi_{len(self.calls)}", "status": self.status,
                "client_secret": "cs_test"}


@pytest.fixture
def env(monkeypatch):
    db = _FakeDB()
    db.tables["subscriptions"] = [
        {"user_id": U1["id"], "stripe_customer_id": "cus_1", "plan_key": "crew", "status": "active"},
        {"user_id": U2["id"], "stripe_customer_id": "cus_2", "plan_key": "crew", "status": "active"},
    ]
    db.tables["payment_methods"] = [
        {"user_id": U1["id"], "stripe_payment_method_id": "pm_1", "is_default": True},
        {"user_id": U2["id"], "stripe_payment_method_id": "pm_2", "is_default": True},
    ]
    monkeypatch.setattr(billing, "get_supabase", lambda: db)
    monkeypatch.setattr(prospecting, "get_supabase", lambda: db)
    # Live mode: the test-mode guard has its own test.
    monkeypatch.setattr(stripe_service, "is_test_mode", lambda: False)
    monkeypatch.setattr(entitlement, "load_subscription",
                        lambda d, uid: next((s for s in db.tables["subscriptions"]
                                             if s["user_id"] == str(uid)), None))
    monkeypatch.setattr(entitlement, "check", lambda d, uid, action, sub=None: type(
        "D", (), {"allowed": True, "reason": "ok", "requires_purchase": False})())
    monkeypatch.setattr(entitlement, "is_admin", lambda uid: False)
    stripe = _FakeStripe()
    monkeypatch.setattr(stripe_service, "client", lambda: stripe)
    db.stripe = stripe
    db.rows = [_row("P1"), _row("P2"), _row("P3")]

    async def _fetch(county, city=None, zip_code=None, owner_occupied_only=False, limit=60):
        return {"name": "New Hanover County, NC", "f": {"year_built": "YR", "owner": "OWN"}}, db.rows[:limit]
    monkeypatch.setattr(prospecting, "fetch_prospects", _fetch)
    monkeypatch.setattr("app.api.v1.prospecting.fetch_prospects", _fetch)
    prospecting._searches.clear()
    return db


def _buy(user, token, county=COUNTY):
    return asyncio.run(billing.purchase_lead(
        billing.PurchaseLeadRequest(county=county, token=token), user))


def _search(user, **kw):
    # Called as a plain function, so every defaulted parameter has to be passed:
    # FastAPI's Query() defaults are objects, not values, outside a request.
    kw.setdefault("city", None)
    kw.setdefault("zip_code", None)
    kw.setdefault("owner_occupied_only", False)
    kw.setdefault("limit", 60)
    return asyncio.run(prospecting.find_roofs(county=COUNTY, user=user, **kw))


# ── what browsing may see ──────────────────────────────────────────────────

def test_browsing_never_returns_address_owner_or_coordinates(env):
    out = _search(U1)
    assert out["for_sale"] == 3
    for p in out["prospects"]:
        for leaked in ("address", "owner", "owner_mail", "lat", "lng", "pin"):
            assert leaked not in p, f"{leaked} leaked to a browsing contractor"
        assert p["score"] and p["year_built"] == 1958      # the scoring IS the product
        assert p["token"].startswith("lp_")


def test_a_token_does_not_carry_the_countys_parcel_id(env):
    # The pin must not be recoverable from the token — handing it over would be
    # handing over the key to the full public record for free.
    import base64
    t = leads_svc.token_for(COUNTY, "P1")
    raw = t[len("lp_"):]
    decoded = base64.urlsafe_b64decode(raw + "==").hex()
    assert "P1" not in t and "P1".encode().hex() not in decoded


def test_tokens_are_stable_per_parcel_and_differ_between_parcels(env):
    assert leads_svc.token_for(COUNTY, "P1") == leads_svc.token_for(COUNTY, "P1")
    assert leads_svc.token_for(COUNTY, "P1") != leads_svc.token_for(COUNTY, "P2")
    assert leads_svc.token_for("brunswick", "P1") != leads_svc.token_for(COUNTY, "P1")


def test_a_sold_lead_disappears_for_everyone_else(env):
    token = leads_svc.token_for(COUNTY, "P1")
    _buy(U1, token)
    mine = _search(U1)
    theirs = _search(U2)
    assert [p for p in mine["prospects"] if p.get("owned")], "buyer should still see their lead"
    assert all(not p.get("owned") for p in theirs["prospects"])
    assert token not in [p["token"] for p in theirs["prospects"]]
    assert theirs["for_sale"] == 2


def test_the_buyer_sees_the_full_record_for_what_they_paid_for(env):
    _buy(U1, leads_svc.token_for(COUNTY, "P1"))
    owned = [p for p in _search(U1)["prospects"] if p.get("owned")]
    assert owned and owned[0]["address"] == "P1 Buch Ave" and owned[0]["owner"] == "SMITH JOHN"


def test_a_recently_sold_house_is_never_offered(env):
    env.rows = [_row("P1", sold_months=1), _row("P2")]
    out = _search(U1)
    assert out["for_sale"] == 1
    assert leads_svc.sellable(_row("P9", sold_months=0))[0] is False
    assert leads_svc.sellable(_row("P9", address=""))[0] is False


# ── buying ─────────────────────────────────────────────────────────────────

def test_buying_charges_fifty_dollars_once_and_files_it_in_the_crm(env):
    out = _buy(U1, leads_svc.token_for(COUNTY, "P1"))
    assert out["ok"] and out["charged_usd"] == 50
    assert env.stripe.calls[0]["amount"] == 5000
    assert env.stripe.calls[0]["idempotency_key"].startswith("axis-lead-")
    assert env.tables["purchased_leads"][0]["status"] == "succeeded"
    crm = env.tables["crm_leads"][0]
    assert crm["address"] == "P1 Buch Ave" and "exclusive lead" in crm["notes"]
    assert "DNC" in crm["notes"]                     # the caller is told whose job compliance is


def test_the_loser_of_a_race_is_told_and_is_never_charged(env):
    token = leads_svc.token_for(COUNTY, "P1")
    _buy(U1, token)
    charges_before = len(env.stripe.calls)
    with pytest.raises(HTTPException) as e:
        _buy(U2, token)
    assert e.value.status_code == 409 and "haven't been charged" in e.value.detail
    assert len(env.stripe.calls) == charges_before, "the loser was charged"


def test_a_declined_card_returns_the_lead_to_the_pool(env, monkeypatch):
    boom = _FakeStripe(boom=True)
    monkeypatch.setattr(stripe_service, "client", lambda: boom)
    token = leads_svc.token_for(COUNTY, "P1")
    with pytest.raises(HTTPException) as e:
        _buy(U1, token)
    assert e.value.status_code == 402
    assert env.tables["purchased_leads"][0]["status"] == "failed"
    # Released: somebody else can now buy it.
    monkeypatch.setattr(stripe_service, "client", lambda: env.stripe)
    assert _buy(U2, token)["ok"]


def test_a_bank_challenge_leaves_it_reserved_and_unpaid(env, monkeypatch):
    monkeypatch.setattr(stripe_service, "client", lambda: _FakeStripe(status="requires_action"))
    out = _buy(U1, leads_svc.token_for(COUNTY, "P1"))
    assert out["ok"] is False and out["requires_action"] and out["client_secret"]
    assert env.tables["purchased_leads"][0]["status"] == "pending"


def test_purchases_are_shut_while_stripe_is_in_test_mode(env, monkeypatch):
    monkeypatch.setattr(stripe_service, "is_test_mode", lambda: True)
    with pytest.raises(HTTPException) as e:
        _buy(U1, leads_svc.token_for(COUNTY, "P1"))
    assert e.value.status_code == 503
    assert not env.stripe.calls


def test_an_admin_can_exercise_the_flow_in_test_mode(env, monkeypatch):
    monkeypatch.setattr(stripe_service, "is_test_mode", lambda: True)
    monkeypatch.setattr(entitlement, "is_admin", lambda uid: True)
    assert _buy(U1, leads_svc.token_for(COUNTY, "P1"))["ok"]


def test_a_forged_or_stale_token_buys_nothing(env):
    for bad in ("", "lp_short", "P1", "lp_" + "A" * 22):
        with pytest.raises(HTTPException) as e:
            _buy(U1, bad)
        assert e.value.status_code in (400, 404)
    assert not env.stripe.calls


def test_a_lead_that_fails_the_dud_filter_cannot_be_bought_even_with_its_token(env):
    token = leads_svc.token_for(COUNTY, "P1")
    env.rows = [_row("P1", sold_months=1)]          # sold since the tab was opened
    with pytest.raises(HTTPException) as e:
        _buy(U1, token)
    assert e.value.status_code == 409 and "no longer a usable lead" in e.value.detail
    assert not env.stripe.calls


def test_subscribers_only(env, monkeypatch):
    monkeypatch.setattr(entitlement, "check", lambda d, uid, action, sub=None: type(
        "D", (), {"allowed": False, "reason": "Exclusive leads are for contractors on a plan.",
                  "requires_purchase": False})())
    with pytest.raises(HTTPException) as e:
        _buy(U1, leads_svc.token_for(COUNTY, "P1"))
    assert e.value.status_code == 409
    assert not env.stripe.calls


def test_an_abandoned_reservation_expires_and_frees_the_lead(env, monkeypatch):
    monkeypatch.setattr(stripe_service, "client", lambda: _FakeStripe(status="requires_action"))
    token = leads_svc.token_for(COUNTY, "P1")
    _buy(U1, token)                                  # walks away from the bank prompt
    stale = datetime.now(timezone.utc) - timedelta(minutes=billing.RESERVATION_TTL_MIN + 1)
    env.tables["purchased_leads"][0]["created_at"] = stale.isoformat()
    monkeypatch.setattr(stripe_service, "client", lambda: env.stripe)
    assert _buy(U2, token)["ok"], "a lead cannot stay locked behind an abandoned checkout"
    assert env.tables["purchased_leads"][0]["status"] == "expired"


# ── my leads ───────────────────────────────────────────────────────────────

def test_my_leads_serves_the_snapshot_not_a_fresh_query(env):
    _buy(U1, leads_svc.token_for(COUNTY, "P1"))
    env.rows = []                                    # the county rewrote its data
    out = asyncio.run(billing.my_leads(U1))
    assert out["count"] == 1
    assert out["leads"][0]["address"] == "P1 Buch Ave" and out["leads"][0]["price_usd"] == 50


def test_my_leads_shows_only_my_own(env):
    _buy(U1, leads_svc.token_for(COUNTY, "P1"))
    _buy(U2, leads_svc.token_for(COUNTY, "P2"))
    assert asyncio.run(billing.my_leads(U2))["count"] == 1


# ── scraping ───────────────────────────────────────────────────────────────

def test_area_searches_are_capped_per_day(env):
    for _ in range(prospecting.MAX_SEARCHES_PER_DAY):
        _search(U1)
    with pytest.raises(HTTPException) as e:
        _search(U1)
    assert e.value.status_code == 429
    assert _search(U2)["for_sale"] == 3, "the cap is per account, not global"


def test_a_city_filter_cannot_rewrite_the_county_query(env):
    """ArcGIS takes no bind parameters, so the clause is built as a string.

    What has to be impossible is ENDING the quoted literal; a stray dash inside
    one is inert, and the hyphen has to survive for Winston-Salem.
    """
    for hostile in ("Wilmington' OR 1=1 --", "o'brien", 'x" OR "', "a%_b", "a;DROP"):
        out = prospecting._safe_val(hostile)
        assert not set(out) & set("'\"%_;()"), f"{hostile!r} -> {out!r}"
    assert prospecting._safe_val("Winston-Salem") == "WINSTON-SALEM"
    assert prospecting._safe_val("x" * 90) == "X" * 40          # and it cannot be huge
