"""Linking a dispatch job to a project fills blanks — it never overwrites.

Before this, linking copied the latest roof run's squares/pitch/stories/waste
straight over whatever a dispatcher had typed. Five of the six live sched_job
rows carry hand-typed measurements and no project, so the first link would have
silently replaced real dispatcher input with a re-derivable number.
"""
from __future__ import annotations

from app.api.v1.scheduling import _fill_blanks, _measurements_from_run

# What _measurements_from_run can produce, keyed as sched_job stores them.
MEASURED = {"squares": 44.1, "predominant_pitch": 7.0, "stories": 2, "waste_factor_pct": 13.0}


def _job(**over):
    base = {"squares": None, "predominant_pitch": None, "stories": None, "waste_factor_pct": None}
    base.update(over)
    return base


def test_blank_job_inherits_everything():
    fill, kept = _fill_blanks(_job(), MEASURED)
    assert fill == MEASURED
    assert kept == {}


def test_typed_values_are_never_overwritten():
    job = _job(squares=30.0, predominant_pitch=10.0)
    fill, kept = _fill_blanks(job, MEASURED)
    assert "squares" not in fill and "predominant_pitch" not in fill
    assert kept == {"squares": 30.0, "predominant_pitch": 10.0}
    # The blanks still get filled.
    assert fill == {"stories": 2, "waste_factor_pct": 13.0}


def test_fully_typed_job_inherits_nothing():
    job = _job(squares=30.0, predominant_pitch=10.0, stories=1, waste_factor_pct=15.0)
    fill, kept = _fill_blanks(job, MEASURED)
    assert fill == {}
    assert kept == job


def test_a_deliberate_zero_is_a_real_value():
    # 0% waste is a choice, not a blank — `is None` is the test, not falsiness.
    job = _job(waste_factor_pct=0.0)
    fill, kept = _fill_blanks(job, MEASURED)
    assert "waste_factor_pct" not in fill
    assert kept == {"waste_factor_pct": 0.0}


def test_a_run_missing_a_field_cannot_blank_a_typed_one():
    # _measurements_from_run omits keys the run has no value for, so a project
    # with no pitch on file must leave a hand-typed pitch untouched.
    measured = _measurements_from_run({"squares": 44.1, "predominant_pitch": None,
                                       "stories": None, "waste_pct_default": None})
    assert "predominant_pitch" not in measured
    fill, kept = _fill_blanks(_job(predominant_pitch=10.0), measured)
    assert fill == {"squares": 44.1}
    assert kept == {}, "a key the run never supplied is not 'kept' — it was never offered"


def test_measurements_from_run_ignores_an_empty_run():
    assert _measurements_from_run({}) == {}
    fill, kept = _fill_blanks(_job(squares=30.0), {})
    assert fill == {} and kept == {}


# ── linking moves the job to the project's house, by its real address ──
import asyncio as _asyncio
from app.api.v1 import scheduling as _sc


class _LQ:
    def __init__(self, db, table): self.db, self.table, self.cols, self.f, self.op, self.payload = db, table, None, [], "select", None
    def select(self, cols="*", **k): self.cols = None if cols == "*" else [c.strip() for c in cols.split(",")]; return self
    def eq(self, c, v): self.f.append((c, v)); return self
    def order(self, *a, **k): return self
    def limit(self, *a, **k): return self
    def update(self, row): self.op, self.payload = "update", row; return self
    def insert(self, row): self.op, self.payload = "insert", row; return self
    def execute(self):
        rows = [r for r in self.db.rows.get(self.table, []) if all(r.get(c) == v for c, v in self.f)]
        if self.op == "update":
            for r in rows: r.update(self.payload)
            return type("R", (), {"data": rows})()
        if self.op == "insert":
            return type("R", (), {"data": [self.payload]})()
        if self.cols: rows = [{c: r.get(c) for c in self.cols} for r in rows]
        return type("R", (), {"data": rows})()


class _LDB:
    def __init__(self, rows): self.rows = rows
    def table(self, n): return _LQ(self, n)


def test_link_moves_the_job_to_the_projects_real_address(monkeypatch):
    O = _sc.ORG
    db = _LDB({
        "sched_job": [{"id": "j1", "org_id": O, "property_id": "p1", "squares": 20}],
        "sched_property": [{"id": "p1", "org_id": O, "line1": "old", "lat": 1.0, "lng": 1.0}],
        "projects": [{"id": "pr1", "user_id": "u1", "name": "Smith reroof", "address": "14 Oak St",
                      "city": "Wilmington", "state": "NC", "zip_code": "28401", "lat": 34.2, "lng": -77.9}],
    })
    monkeypatch.setattr(_sc, "get_supabase", lambda: db)
    monkeypatch.setattr(_sc, "_latest_run", lambda *a, **k: {})
    out = _asyncio.run(_sc.link_job_to_project("j1", _sc.JobLink(project_id="pr1"), {"id": "u1"}))
    prop = db.rows["sched_property"][0]
    assert prop["line1"] == "14 Oak St" and prop["city"] == "Wilmington" and prop["lat"] == 34.2
    assert out["relocated"]["to"] == "14 Oak St"
