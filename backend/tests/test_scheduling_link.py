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
