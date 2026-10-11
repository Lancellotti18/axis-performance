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
