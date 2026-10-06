"""DELETE /scheduling/jobs/{id}: a job made by mistake can be removed, but never
work that has started, and never a customer or property another job still uses
(deleting a shared customer would cascade into that customer's other jobs)."""
import asyncio

import pytest

from app.api.v1 import scheduling as sc

USER = {"id": "u1", "email": ""}


class _Q:
    def __init__(self, db, table):
        self.db, self.table, self.filters, self.op, self.payload = db, table, [], "select", None
    def select(self, *a, **k): return self
    def limit(self, *a, **k): return self
    def order(self, *a, **k): return self
    def eq(self, col, val): self.filters.append((col, val)); return self
    def delete(self): self.op = "delete"; return self
    def insert(self, row): self.op, self.payload = "insert", row; return self
    def _match(self):
        return [r for r in self.db.rows.get(self.table, []) if all(r.get(c) == v for c, v in self.filters)]
    def execute(self):
        if self.op == "delete":
            gone = self._match()
            self.db.rows[self.table] = [r for r in self.db.rows.get(self.table, []) if r not in gone]
            self.db.deleted.append((self.table, [r["id"] for r in gone]))
            if self.table == "sched_job":          # ON DELETE CASCADE to appointments
                ids = {r["id"] for r in gone}
                self.db.rows["sched_appointment"] = [a for a in self.db.rows.get("sched_appointment", []) if a["job_id"] not in ids]
            return type("R", (), {"data": gone})()
        if self.op == "insert":
            self.db.rows.setdefault(self.table, []).append(self.payload)
            return type("R", (), {"data": [self.payload]})()
        return type("R", (), {"data": self._match()})()


class _DB:
    def __init__(self, rows): self.rows, self.deleted = rows, []
    def table(self, name): return _Q(self, name)


def _db(appt_status="SCHEDULED", second_job_same_customer=False):
    O = sc.ORG
    jobs = [{"id": "j1", "org_id": O, "customer_id": "c1", "property_id": "p1", "status": "SCHEDULED"}]
    if second_job_same_customer:
        jobs.append({"id": "j2", "org_id": O, "customer_id": "c1", "property_id": "p2", "status": "SOLD"})
    return _DB({
        "sched_job": jobs,
        "sched_appointment": [{"id": "a1", "org_id": O, "job_id": "j1", "status": appt_status}],
        "sched_customer": [{"id": "c1", "org_id": O}],
        "sched_property": [{"id": "p1", "org_id": O}, {"id": "p2", "org_id": O}],
    })


@pytest.fixture
def use(monkeypatch):
    def _use(db):
        monkeypatch.setattr(sc, "get_supabase", lambda: db)
        return db
    return _use


def _call(job="j1"):
    return asyncio.run(sc.delete_job(job, USER))


def test_deletes_the_job_its_visits_and_its_own_customer_and_property(use):
    db = use(_db())
    out = _call()
    assert out["ok"] and out["appointments_removed"] == 1
    assert out["removed_customer"] and out["removed_property"]
    assert db.rows["sched_job"] == [] and db.rows["sched_appointment"] == []
    assert db.rows["sched_customer"] == []
    assert [p["id"] for p in db.rows["sched_property"]] == ["p2"]
    assert any(r.get("action") == "DELETE_JOB" for r in db.rows["sched_audit_event"])


def test_keeps_a_customer_another_job_still_uses(use):
    db = use(_db(second_job_same_customer=True))
    out = _call()
    assert out["removed_customer"] is False and out["removed_property"] is True
    assert [c["id"] for c in db.rows["sched_customer"]] == ["c1"]
    assert [j["id"] for j in db.rows["sched_job"]] == ["j2"]


@pytest.mark.parametrize("status", ["WORKING", "PAUSED", "DONE"])
def test_refuses_once_work_has_started(use, status):
    db = use(_db(appt_status=status))
    with pytest.raises(sc.HTTPException) as e:
        _call()
    assert e.value.status_code == 409
    assert db.deleted == []


def test_unknown_job_is_404(use):
    use(_db())
    with pytest.raises(sc.HTTPException) as e:
        _call("nope")
    assert e.value.status_code == 404
