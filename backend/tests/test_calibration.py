"""Accuracy flywheel: one roof must count as one job.

Actuals used to be appended, so re-recording a job to fix a typo left two rows
and the same roof counted twice toward the 3-job trust gate. That is how three
rows covering two roofs once qualified, producing a +10.4% "bias" that matched
none of them and quietly took 10% off every instant quote.

These tests pin both halves of the fix: dedup on read, upsert on write.
"""
from __future__ import annotations

from app.api.v1.roofing_v2 import _calibration_stats
from app.api.v1.instant_quote import _calibration_for_user


class _FakeQuery:
    """Chainable stand-in for the supabase table builder used by the callers."""

    def __init__(self, rows):
        self._rows = rows

    def select(self, *_a, **_k):
        return self

    def eq(self, field, value):
        self._rows = [r for r in self._rows if r.get(field) == value]
        return self

    def order(self, field, **_k):
        self._rows = sorted(self._rows, key=lambda r: r.get(field) or "")
        return self

    def limit(self, n):
        self._rows = self._rows[:n]
        return self

    def execute(self):
        return type("Res", (), {"data": list(self._rows)})()


class _FakeDB:
    def __init__(self, rows):
        self._rows = rows

    def table(self, _name):
        return _FakeQuery(list(self._rows))


USER = "u1"


def _row(rid, run, pred, actual, created, user=USER):
    return {"id": rid, "run_id": run, "user_id": user, "predicted_squares": pred,
            "actual_squares": actual, "created_at": created}


# ── dedup on read ────────────────────────────────────────────────────────────

def test_two_recordings_of_one_run_count_as_one_job():
    db = _FakeDB([
        _row("a", "run-1", 44.1, 83.0, "2026-08-05T20:45:00Z"),
        _row("b", "run-1", 44.1, 44.1, "2026-08-05T20:54:00Z"),
    ])
    stats = _calibration_stats(db, USER)
    assert stats["jobs"] == 1, "one roof recorded twice is still one roof"


def test_newest_recording_for_a_run_wins():
    # The later row is the correction: 44.1 predicted vs 44.1 actual = 0% error.
    db = _FakeDB([
        _row("a", "run-1", 44.1, 83.0, "2026-08-05T20:45:00Z"),
        _row("b", "run-1", 44.1, 44.1, "2026-08-05T20:54:00Z"),
    ])
    assert _calibration_stats(db, USER)["mean_abs_pct_error"] == 0.0


def test_distinct_runs_still_count_separately():
    db = _FakeDB([
        _row("a", "run-1", 12.47, 7.0, "2026-07-16T19:13:00Z"),
        _row("b", "run-2", 44.1, 83.0, "2026-08-05T20:45:00Z"),
    ])
    assert _calibration_stats(db, USER)["jobs"] == 2


def test_legacy_rows_without_a_run_id_are_not_collapsed():
    db = _FakeDB([
        _row("a", None, 10.0, 9.0, "2026-01-01T00:00:00Z"),
        _row("b", None, 20.0, 18.0, "2026-01-02T00:00:00Z"),
    ])
    assert _calibration_stats(db, USER)["jobs"] == 2


def test_other_contractors_rows_are_excluded():
    db = _FakeDB([
        _row("a", "run-1", 10.0, 9.0, "2026-01-01T00:00:00Z"),
        _row("b", "run-2", 20.0, 18.0, "2026-01-02T00:00:00Z", user="someone-else"),
    ])
    assert _calibration_stats(db, USER)["jobs"] == 1


def test_no_rows_returns_none():
    assert _calibration_stats(_FakeDB([]), USER) is None


# ── the trust gate ───────────────────────────────────────────────────────────

def test_the_exact_production_data_no_longer_qualifies():
    """The real table as of 2026-08-29, before cleanup: 3 rows, 2 roofs.

    Dedup drops it to 2 jobs — under the 3-job gate — so no adjustment is made.
    Previously this scattered set produced a capped +10% bias that silently
    discounted every quote and was disclosed as "3 field-verified jobs".
    """
    db = _FakeDB([
        _row("a", "run-a", 12.47, 7.0, "2026-07-16T19:13:21Z"),
        _row("b", "run-b", 44.1, 83.0, "2026-08-05T20:45:41Z"),
        _row("c", "run-b", 44.1, 44.1, "2026-08-05T20:54:00Z"),
    ])
    assert _calibration_stats(db, USER)["jobs"] == 2
    assert _calibration_for_user(db, USER) is None


def test_scattered_jobs_are_declined_even_at_three_runs():
    # Three genuinely distinct roofs that disagree wildly: variance, not bias.
    db = _FakeDB([
        _row("a", "run-a", 12.47, 7.0, "2026-01-01T00:00:00Z"),   # +78.1%
        _row("b", "run-b", 44.1, 83.0, "2026-01-02T00:00:00Z"),   # -46.9%
        _row("c", "run-c", 30.0, 30.0, "2026-01-03T00:00:00Z"),   #   0.0%
    ])
    assert _calibration_stats(db, USER)["jobs"] == 3
    assert _calibration_for_user(db, USER) is None, "wide scatter is not a correctable bias"


def test_tight_agreement_across_three_runs_does_calibrate():
    # Consistently ~8% large: a real, correctable bias.
    db = _FakeDB([
        _row("a", "run-a", 10.8, 10.0, "2026-01-01T00:00:00Z"),
        _row("b", "run-b", 21.6, 20.0, "2026-01-02T00:00:00Z"),
        _row("c", "run-c", 32.4, 30.0, "2026-01-03T00:00:00Z"),
    ])
    cal = _calibration_for_user(db, USER)
    assert cal is not None and cal["jobs"] == 3
    assert 7.0 < cal["bias_pct"] < 9.0


def test_bias_stays_capped_at_ten_percent():
    db = _FakeDB([
        _row("a", "run-a", 11.4, 10.0, "2026-01-01T00:00:00Z"),
        _row("b", "run-b", 22.8, 20.0, "2026-01-02T00:00:00Z"),
        _row("c", "run-c", 34.2, 30.0, "2026-01-03T00:00:00Z"),
    ])
    cal = _calibration_for_user(db, USER)
    assert cal is not None and cal["bias_pct"] <= 10.0
