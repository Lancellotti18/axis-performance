"""Dispatch tenancy: every account gets its OWN board.

Before this, every sched_* query used one hard-coded org, so any signed-in
contractor saw and edited the same crews, jobs and customers. Now org = the
caller's id; only the legacy owners keep the original board."""
import asyncio

import pytest
from fastapi import HTTPException

from app.api.v1 import scheduling as sc

RYAN = next(iter(sc.LEGACY_ORG_USERS))
OTHER = "11111111-2222-3333-4444-555555555555"


def test_legacy_owner_keeps_the_original_board():
    assert sc.org_for({"id": RYAN}) == sc.ORG


def test_everyone_else_gets_their_own_org_not_the_shared_one():
    assert sc.org_for({"id": OTHER}) == OTHER != sc.ORG
    assert sc.org_for({"id": "someone-else"}) != sc.org_for({"id": OTHER})


def test_no_user_id_is_rejected_not_defaulted():
    for bad in ({}, {"id": ""}, None):
        with pytest.raises(HTTPException) as e:
            sc.org_for(bad)
        assert e.value.status_code == 401


def test_a_query_outside_a_scoped_request_fails_closed():
    token = sc._ORG_CTX.set(None)
    try:
        with pytest.raises(RuntimeError):
            sc._org()
    finally:
        sc._ORG_CTX.reset(token)


def test_the_org_reaches_the_endpoint_through_a_real_request():
    """The thing that actually matters: an org set by the dependency must be
    visible inside the endpoint (same request context), for async and sync
    handlers alike, and must follow the caller."""
    import httpx
    from fastapi import FastAPI, Depends
    from app.core.auth import require_user

    app = FastAPI()
    who = {"id": RYAN}
    app.dependency_overrides[require_user] = lambda: who

    @app.get("/probe")
    async def probe(user: dict = Depends(sc.require_sched_user)):
        await asyncio.sleep(0)            # yield, as a real handler awaiting I/O would
        return {"org": sc._org()}

    @app.get("/probe-sync")
    def probe_sync(user: dict = Depends(sc.require_sched_user)):
        return {"org": sc._org()}

    async def hit(path):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return (await c.get(path)).json()

    assert asyncio.run(hit("/probe")) == {"org": sc.ORG}
    who["id"] = OTHER
    assert asyncio.run(hit("/probe")) == {"org": OTHER}
    assert asyncio.run(hit("/probe-sync")) == {"org": OTHER}


def test_concurrent_requests_never_share_an_org():
    import asyncio as aio
    seen = {}

    async def request(uid):
        await sc.require_sched_user({"id": uid})
        await aio.sleep(0.01 * (hash(uid) % 3))   # interleave
        seen[uid] = sc._org()

    async def main():
        await aio.gather(*[aio.create_task(request(f"user-{i}")) for i in range(20)])
    aio.run(main())
    assert all(seen[f"user-{i}"] == f"user-{i}" for i in range(20))


class _Q:
    def __init__(self, db, t): self.db, self.t, self.f = db, t, []
    def select(self, *a, **k): return self
    def limit(self, *a, **k): return self
    def eq(self, c, v): self.f.append((c, v)); return self
    def execute(self):
        return type("R", (), {"data": [r for r in self.db.rows.get(self.t, []) if all(r.get(c) == v for c, v in self.f)]})()


class _DB:
    def __init__(self, rows): self.rows = rows
    def table(self, t): return _Q(self, t)


def test_another_account_cannot_read_a_job_by_its_id():
    """The by-id lookup every endpoint uses: a job id from Ryan's board is
    simply not found from another account's org."""
    db = _DB({"sched_job": [{"id": "j1", "org_id": sc.ORG}]})
    sc._ORG_CTX.set(sc.ORG)
    assert sc._one(db, "sched_job", "j1") is not None
    sc._ORG_CTX.set(OTHER)
    assert sc._one(db, "sched_job", "j1") is None


def test_every_scheduling_endpoint_pins_the_org():
    """No route may use plain require_user — that would run its queries
    outside an org scope (and now error). Guards against a future endpoint
    quietly skipping the pin."""
    import inspect
    src = inspect.getsource(sc)
    body = src.split("async def require_sched_user", 1)[1].split("\n\n\n", 1)[1]   # after the dependency itself
    assert "Depends(require_user)" not in body
    assert '"org_id", ORG' not in body and '"org_id": ORG' not in body   # no raw shared-org queries


# ── Default business units for a new account ─────────────────────────────────
# A new org's board was empty AND unusable: creating a crew or a job returned
# 409 "No business unit is configured for scheduling yet," with no way in the
# product to configure one. Every org now gets its units on first use.

class _BuQ:
    """Minimal table stub that also records writes (the _Q above is read-only)."""
    def __init__(self, db, t): self.db, self.t, self.f = db, t, []
    def select(self, *a, **k): return self
    def limit(self, *a, **k): return self
    def order(self, *a, **k): return self
    def eq(self, c, v): self.f.append((c, v)); return self
    def insert(self, rows, **k): return self._write(rows)
    def upsert(self, rows, **k):
        self.db.upserts += 1
        return self._write(rows, ignore_existing=True)
    def _write(self, rows, ignore_existing=False):
        rows = rows if isinstance(rows, list) else [rows]
        have = {r["id"] for r in self.db.rows.setdefault(self.t, [])}
        for r in rows:
            if r["id"] in have:
                if not ignore_existing:
                    raise RuntimeError(f"duplicate key {r['id']}")
                continue
            self.db.rows[self.t].append(dict(r))
        self.written = rows
        return self
    def execute(self):
        data = getattr(self, "written", None)
        if data is None:
            data = [r for r in self.db.rows.get(self.t, []) if all(r.get(c) == v for c, v in self.f)]
        return type("R", (), {"data": data})()


class _BuDB:
    def __init__(self, rows=None): self.rows, self.upserts = dict(rows or {}), 0
    def table(self, t): return _BuQ(self, t)


def test_a_new_org_gets_its_default_business_units():
    db = _BuDB()
    sc._ORG_CTX.set(OTHER)
    units = sc._ensure_business_units(db)
    assert [u["name"] for u in sorted(units, key=lambda u: u["sort_order"])] == [
        n for n, _, _ in sc.DEFAULT_BUSINESS_UNITS]
    assert {u["org_id"] for u in units} == {OTHER}
    # Not Gutters or Siding: a new roofing company should not open onto trades
    # it may not run.
    assert not any(u["color_token"] in ("bu-gutter", "bu-siding") for u in units)


def test_bootstrapping_twice_does_not_duplicate_the_columns():
    db = _BuDB()
    sc._ORG_CTX.set(OTHER)
    first = sc._ensure_business_units(db)
    second = sc._ensure_business_units(db)
    assert len(first) == len(second) == len(sc.DEFAULT_BUSINESS_UNITS)
    assert db.upserts == 1          # the second call saw the rows and wrote nothing


def test_two_concurrent_bootstraps_collide_instead_of_doubling():
    """Two tabs opening a new board at once. The ids are a pure function of
    (org, unit), so the loser's rows are ignored rather than appended."""
    db = _BuDB()
    sc._ORG_CTX.set(OTHER)
    rows = [{"id": str(sc.uuid.uuid5(sc._BU_NS, f"bu:{OTHER}:{tok}")), "org_id": OTHER,
             "name": name, "color_token": tok, "sort_order": order}
            for name, tok, order in sc.DEFAULT_BUSINESS_UNITS]
    db.rows["sched_business_unit"] = [dict(r) for r in rows]   # the winner already wrote
    db.table("sched_business_unit").upsert(rows, ignore_duplicates=True).execute()
    assert len(db.rows["sched_business_unit"]) == len(sc.DEFAULT_BUSINESS_UNITS)


def test_an_org_that_already_has_units_is_left_alone():
    """The original board, and anyone who renamed or retired a unit: no
    defaults are re-added on top."""
    existing = [{"id": "bu-x", "org_id": sc.ORG, "name": "Metal Roofing",
                 "color_token": "bu-service", "sort_order": 0, "is_active": False}]
    db = _BuDB({"sched_business_unit": [dict(existing[0])]})
    sc._ORG_CTX.set(sc.ORG)
    assert sc._ensure_business_units(db) == existing
    assert db.upserts == 0


def test_each_org_gets_its_own_unit_ids():
    a, b = _BuDB(), _BuDB()
    sc._ORG_CTX.set(OTHER)
    ids_a = {u["id"] for u in sc._ensure_business_units(a)}
    sc._ORG_CTX.set("99999999-8888-7777-6666-555555555555")
    ids_b = {u["id"] for u in sc._ensure_business_units(b)}
    assert ids_a.isdisjoint(ids_b)


def test_bootstrap_needs_a_scoped_request_like_every_other_query():
    db = _BuDB()
    token = sc._ORG_CTX.set(None)
    try:
        with pytest.raises(RuntimeError):
            sc._ensure_business_units(db)
    finally:
        sc._ORG_CTX.reset(token)


def test_a_crew_cannot_be_attached_to_another_orgs_business_unit():
    """business_unit_id arrives from the client and the foreign key only
    proves the unit exists — it must be one of the caller's own."""
    import inspect
    src = inspect.getsource(sc.create_crew)
    assert '_one(db, "sched_business_unit", body.business_unit_id)' in src
    assert inspect.getsource(sc.update_crew).count('"sched_business_unit"') == 1


# ── A brand-new account's board, end to end ──────────────────────────────────

class _AnyQ:
    """Tolerant stand-in for a Supabase table query: accepts any chain of
    filters and returns whatever the store holds for that table."""
    def __init__(self, db, t): self.db, self.t, self.f = db, t, []
    def select(self, *a, **k): return self
    def order(self, *a, **k): return self
    def limit(self, *a, **k): return self
    def eq(self, c, v): self.f.append((c, v)); return self
    def gte(self, *a, **k): return self
    def lte(self, *a, **k): return self
    def lt(self, *a, **k): return self
    def gt(self, *a, **k): return self
    def in_(self, *a, **k): return self
    def upsert(self, rows, **k):
        rows = rows if isinstance(rows, list) else [rows]
        have = {r["id"] for r in self.db.store.setdefault(self.t, [])}
        self.db.store[self.t].extend(dict(r) for r in rows if r["id"] not in have)
        self.written = rows
        return self
    def insert(self, rows, **k): return self.upsert(rows)
    def execute(self):
        data = getattr(self, "written", None)
        if data is None:
            data = [r for r in self.db.store.get(self.t, [])
                    if all(r.get(c) == v for c, v in self.f)]
        return type("R", (), {"data": data})()


class _AnyDB:
    def __init__(self): self.store = {}
    def table(self, t): return _AnyQ(self, t)


def test_a_brand_new_account_can_load_its_board(monkeypatch):
    """The actual bug Ryan hit: a new account's board was empty and the first
    crew could not be created. Drive the real endpoint through a real request
    as a non-legacy user and check the board comes back with units to pick."""
    import httpx
    from fastapi import FastAPI
    from app.core.auth import require_user

    db = _AnyDB()
    monkeypatch.setattr(sc, "get_supabase", lambda: db)

    app = FastAPI()
    app.include_router(sc.router, prefix="/scheduling")
    app.dependency_overrides[require_user] = lambda: {"id": OTHER}

    async def hit():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://t") as c:
            return await c.get("/scheduling/board", params={"start": "2026-10-12", "end": "2026-10-18"})

    r = asyncio.run(hit())
    assert r.status_code == 200, r.text
    body = r.json()
    names = [b["name"] for b in body["business_units"]]
    assert names == [n for n, _, _ in sc.DEFAULT_BUSINESS_UNITS]
    # The rest of a new board really is empty — and that is fine.
    assert body["crews"] == [] and body["appointments"] == []
    # The units were persisted under the CALLER's org, not the shared board.
    assert {u["org_id"] for u in db.store["sched_business_unit"]} == {OTHER}
    assert sc.ORG not in {u["org_id"] for u in db.store["sched_business_unit"]}


def test_a_second_board_load_reuses_the_same_units(monkeypatch):
    """Two loads must not leave the account with four columns."""
    import httpx
    from fastapi import FastAPI
    from app.core.auth import require_user

    db = _AnyDB()
    monkeypatch.setattr(sc, "get_supabase", lambda: db)
    app = FastAPI()
    app.include_router(sc.router, prefix="/scheduling")
    app.dependency_overrides[require_user] = lambda: {"id": OTHER}

    async def hit():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://t") as c:
            return [(await c.get("/scheduling/board",
                                 params={"start": "2026-10-12", "end": "2026-10-18"})).json()
                    for _ in range(3)]

    boards = asyncio.run(hit())
    assert all(len(b["business_units"]) == len(sc.DEFAULT_BUSINESS_UNITS) for b in boards)
    assert len(db.store["sched_business_unit"]) == len(sc.DEFAULT_BUSINESS_UNITS)
