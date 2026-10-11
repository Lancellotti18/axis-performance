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
            # lead_problem_one_per_purchase: re-reporting a lead is not a
            # second claim, and a rejected one must not be refilable.
            if self.name == "lead_problem_reports":
                if [r for r in rows
                        if str(r.get("purchase_id")) == str(self.payload.get("purchase_id"))]:
                    raise _Unique()
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


# ── the roof view ──────────────────────────────────────────────────────────

class _FakeImgResponse:
    status_code = 200
    content = b"\xff\xd8\xff\xe0jpegbytes"


class _FakeClient:
    def __init__(self, *a, **k): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False
    async def get(self, url, params=None): return _FakeImgResponse()


@pytest.fixture
def imagery(monkeypatch):
    monkeypatch.setattr(prospecting.httpx, "AsyncClient", _FakeClient)


def _thumb(user, token, county=COUNTY):
    return asyncio.run(prospecting.lead_thumb(county=county, token=token, user=user))


def test_the_roof_view_is_served_without_handing_over_coordinates(env, imagery):
    out = _thumb(U1, leads_svc.token_for(COUNTY, "P1"))
    assert out["image"].startswith("data:image/jpeg;base64,")
    # The point it was taken from is exactly what must not come back.
    for leaked in ("lat", "lng", "bbox", "address"):
        assert leaked not in out


def test_the_roof_view_stops_once_someone_else_owns_the_lead(env, imagery):
    token = leads_svc.token_for(COUNTY, "P1")
    _buy(U2, token)
    with pytest.raises(HTTPException) as e:
        _thumb(U1, token)
    assert e.value.status_code == 404
    assert _thumb(U2, token)["image"], "the buyer keeps their roof view"


def test_the_roof_view_refuses_a_forged_token(env, imagery):
    with pytest.raises(HTTPException) as e:
        _thumb(U1, "lp_" + "A" * 22)
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        _thumb(U1, "nope")
    assert e.value.status_code == 400


# ── reporting a dud ────────────────────────────────────────────────────────

def _report(user, purchase_id, reason, detail=None):
    return asyncio.run(billing.report_lead_problem(
        purchase_id, billing.LeadProblemRequest(reason=reason, detail=detail), user))


def _bought(env, user=U1, pin="P1"):
    out = _buy(user, leads_svc.token_for(COUNTY, pin))
    return out["lead"]["purchase_id"]


def test_a_claim_the_county_record_confirms_is_approved_at_once(env):
    pid = _bought(env)
    env.rows = []                                    # parcel gone from residential results
    out = _report(U1, pid, "not_a_home")
    assert out["status"] == "approved" and out["auto_verified"] and out["credits"] == 1
    rec = env.tables["lead_problem_reports"][0]
    assert rec["resolution"] == "replacement" and rec["evidence"]["found_in_county"] is False


def test_a_changed_owner_proves_the_record_was_wrong(env):
    pid = _bought(env)
    env.rows = [_row("P1", owner="DIFFERENT OWNER LLC")]
    out = _report(U1, pid, "record_wrong")
    assert out["status"] == "approved"
    assert env.tables["lead_problem_reports"][0]["evidence"]["field"] == "owner"


def test_a_matching_record_goes_to_review_rather_than_being_refused(env):
    pid = _bought(env)
    out = _report(U1, pid, "record_wrong")           # nothing changed
    assert out["status"] == "open" and out["auto_verified"] is False
    assert env.tables["subscriptions"][0].get("lead_credits") in (None, 0)


def test_a_sale_that_predates_the_purchase_is_confirmed(env):
    pid = _bought(env)
    # Bought moments ago; the county now shows the house sold 5 months back.
    env.rows = [_row("P1", sold_months=5)]
    assert _report(U1, pid, "sold_before_purchase")["status"] == "approved"


def test_an_ancient_sale_is_not_a_dud(env):
    pid = _bought(env)
    env.rows = [_row("P1", sold_months=200)]
    out = _report(U1, pid, "sold_before_purchase")
    assert out["status"] == "open"
    assert "too old" in env.tables["lead_problem_reports"][0]["evidence"]["note"]


def test_not_interested_is_not_a_reason(env):
    pid = _bought(env)
    for bad in ("not_interested", "no_answer", "", "whatever"):
        with pytest.raises(HTTPException) as e:
            _report(U1, pid, bad)
        assert e.value.status_code == 400


def test_a_lead_can_only_be_reported_once(env):
    pid = _bought(env)
    _report(U1, pid, "record_wrong")
    with pytest.raises(HTTPException) as e:
        _report(U1, pid, "not_a_home")
    assert e.value.status_code == 409 and "already reported" in e.value.detail


def test_claims_close_after_seven_days(env):
    pid = _bought(env)
    old = datetime.now(timezone.utc) - timedelta(days=leads_svc.CLAIM_WINDOW_DAYS + 1)
    env.tables["purchased_leads"][0]["created_at"] = old.isoformat()
    with pytest.raises(HTTPException) as e:
        _report(U1, pid, "not_a_home")
    assert e.value.status_code == 409 and "within 7 days" in e.value.detail


def test_three_claims_a_month_is_the_limit(env):
    for pin in ("P1", "P2", "P3"):
        _report(U1, _bought(env, U1, pin), "record_wrong")
    env.rows = [_row("P4")]
    pid = _bought(env, U1, "P4")
    with pytest.raises(HTTPException) as e:
        _report(U1, pid, "record_wrong")
    assert e.value.status_code == 429


def test_someone_elses_lead_cannot_be_reported(env):
    pid = _bought(env, U1, "P1")
    with pytest.raises(HTTPException) as e:
        _report(U2, pid, "not_a_home")
    assert e.value.status_code == 404


# ── the replacement credit ─────────────────────────────────────────────────

def test_a_credit_buys_the_next_lead_without_touching_the_card(env):
    pid = _bought(env, U1, "P1")
    env.rows = []
    _report(U1, pid, "not_a_home")                   # approved -> 1 credit
    env.rows = [_row("P2")]
    charges = len(env.stripe.calls)
    out = _buy(U1, leads_svc.token_for(COUNTY, "P2"))
    assert out["ok"] and out["charged_usd"] == 0 and out["used_credit"]
    assert out["credits_left"] == 0
    assert len(env.stripe.calls) == charges, "the card was charged despite a credit"
    assert env.tables["purchased_leads"][-1]["price_usd"] == 0


def test_a_credit_is_spent_once(env):
    pid = _bought(env, U1, "P1")
    env.rows = []
    _report(U1, pid, "not_a_home")
    env.rows = [_row("P2"), _row("P3")]
    _buy(U1, leads_svc.token_for(COUNTY, "P2"))       # uses the credit
    out = _buy(U1, leads_svc.token_for(COUNTY, "P3"))  # must fall back to the card
    assert out["charged_usd"] == 50 and not out.get("used_credit")


# ── review queue ───────────────────────────────────────────────────────────

def test_the_review_queue_is_admin_only(env):
    with pytest.raises(HTTPException) as e:
        asyncio.run(billing.admin_lead_problems(U1))
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        asyncio.run(billing.resolve_lead_problem(
            "x", billing.ResolveProblemRequest(approve=True), U1))
    assert e.value.status_code == 403


def _resolve(report_id, **kw):
    return asyncio.run(billing.resolve_lead_problem(
        report_id, billing.ResolveProblemRequest(**kw), U1))


def test_approving_a_reviewed_claim_credits_a_lead(env, monkeypatch):
    pid = _bought(env, U1, "P1")
    rid = _report(U1, pid, "record_wrong")["report_id"]      # open
    monkeypatch.setattr(entitlement, "is_admin", lambda uid: True)
    out = _resolve(rid, approve=True, note="checked the deed")
    assert out["status"] == "approved" and out["credits"] == 1


def test_rejecting_a_claim_credits_nothing_and_cannot_be_redecided(env, monkeypatch):
    pid = _bought(env, U1, "P1")
    rid = _report(U1, pid, "record_wrong")["report_id"]
    monkeypatch.setattr(entitlement, "is_admin", lambda uid: True)
    assert _resolve(rid, approve=False)["status"] == "rejected"
    assert env.tables["subscriptions"][0].get("lead_credits") in (None, 0)
    with pytest.raises(HTTPException) as e:
        _resolve(rid, approve=True)
    assert e.value.status_code == 409


def test_a_refund_is_recorded_not_executed(env, monkeypatch):
    pid = _bought(env, U1, "P1")
    rid = _report(U1, pid, "record_wrong")["report_id"]
    monkeypatch.setattr(entitlement, "is_admin", lambda uid: True)
    out = _resolve(rid, approve=True, resolution="refund")
    assert out["refund_is_manual"] and out["credits"] is None
    assert env.tables["subscriptions"][0].get("lead_credits") in (None, 0)


def test_my_claims_shows_the_balance_and_what_is_left_this_month(env):
    pid = _bought(env, U1, "P1")
    env.rows = []
    _report(U1, pid, "not_a_home")
    out = asyncio.run(billing.my_lead_problems(U1))
    assert out["credits"] == 1 and out["claims_used_this_month"] == 1
    assert out["claims_per_month"] == 3
