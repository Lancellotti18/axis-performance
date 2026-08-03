"""Unit suite for the crew-scheduling capacity engine (Milestone 1).

Proves the math before any UI exists. Covers the full pitch table, tear-off
layers, missing measurements, the utilization thresholds, multi-day placement
across gaps/PTO/no-shift, every conflict code, and the DST boundary.
"""
from __future__ import annotations

from datetime import date, datetime

from app.services.scheduling.capacity import (
    JobProductionInput, CrewCapacityInput, compute_crew_days,
    ShiftInput, AppointmentLoadInput, NonJobEventInput, compute_day_load,
    plan_multi_day, ProposedAssignment, ConflictContext, detect_conflicts, has_block,
)
from app.services.scheduling.timeutil import local_datetime, local_start_time_str

CREW = CrewCapacityInput(squares_per_day=28.0, tear_off_squares_per_day=14.0, max_pitch=9.0, max_stories=2)


# ── computeCrewDays: full pitch table ────────────────────────────────────────

def test_pitch_table_multipliers():
    # 28 sq at rate 28 = exactly 1.0 install-day before multipliers, so crew_days
    # reflects the pitch multiplier rounded up to the half-day.
    expect = {6: 1.0, 7: 1.5, 8: 1.5, 9: 1.5, 10: 2.0, 11: 2.5, 12: 2.5}
    for pitch, days in expect.items():
        job = JobProductionInput(squares=28, predominant_pitch=float(pitch), stories=1, tear_off_layers=0, waste_factor_pct=0)
        est = compute_crew_days(job, CrewCapacityInput(28, 14, max_pitch=12))
        assert est.crew_days == days, f"pitch {pitch}: got {est.crew_days}, want {days}"


def test_steep_slope_flag():
    job = JobProductionInput(squares=28, predominant_pitch=11.0, stories=1)
    est = compute_crew_days(job, CrewCapacityInput(28, 14, max_pitch=12))
    assert est.requires_steep_slope_crew is True
    est6 = compute_crew_days(JobProductionInput(squares=28, predominant_pitch=6.0, stories=1), CrewCapacityInput(28, 14))
    assert est6.requires_steep_slope_crew is False


def test_tear_off_layers():
    base = dict(squares=28, predominant_pitch=6.0, stories=1, waste_factor_pct=0)
    crew = CrewCapacityInput(28, 14)
    assert compute_crew_days(JobProductionInput(tear_off_layers=0, **base), crew).crew_days == 1.0
    assert compute_crew_days(JobProductionInput(tear_off_layers=1, **base), crew).crew_days == 3.0  # 2 tear + 1 install
    assert compute_crew_days(JobProductionInput(tear_off_layers=2, **base), crew).crew_days == 5.0  # 4 tear + 1 install


def test_missing_measurements_falls_back_and_flags():
    est = compute_crew_days(JobProductionInput(squares=None, predominant_pitch=None, stories=None, job_type="REROOF"), CREW)
    assert est.is_estimated is True
    assert "MISSING_MEASUREMENTS" in est.warnings
    assert est.crew_days == 2.0  # REROOF default
    # unknown job type -> generic 1.0 default
    est2 = compute_crew_days(JobProductionInput(squares=None, predominant_pitch=None, stories=None, job_type="WHATEVER"), CREW)
    assert est2.crew_days == 1.0


def test_waste_factor_and_min_half_day():
    est = compute_crew_days(JobProductionInput(squares=100, predominant_pitch=6.0, stories=1, waste_factor_pct=10), CrewCapacityInput(110, 55))
    assert est.effective_squares == 110.0
    assert est.crew_days == 1.0
    tiny = compute_crew_days(JobProductionInput(squares=1, predominant_pitch=6.0, stories=1), CrewCapacityInput(100, 50))
    assert tiny.crew_days == 0.5  # rounds up to the minimum


def test_pitch_and_story_exceed_warnings():
    est = compute_crew_days(JobProductionInput(squares=28, predominant_pitch=12.0, stories=3), CrewCapacityInput(28, 14, max_pitch=9, max_stories=2))
    assert "PITCH_EXCEEDS_CREW_MAX" in est.warnings
    assert "STORIES_EXCEED_CREW_MAX" in est.warnings


# ── computeDayLoad: threshold boundaries ─────────────────────────────────────

def _load_for(planned: float, crew_cap: float = 100.0, shift=ShiftInput(date(2026, 8, 3), "07:00", "17:00"), events=None):
    appts = [AppointmentLoadInput(datetime(2026, 8, 3, 8, 0), datetime(2026, 8, 3, 9, 0), planned)] if planned else []
    return compute_day_load(shift, appts, events or [], crew_cap)


def test_utilization_thresholds():
    assert _load_for(0).state == "IDLE"
    assert _load_for(14.9).state == "IDLE"
    assert _load_for(15).state == "LIGHT"
    assert _load_for(59.9).state == "LIGHT"
    assert _load_for(60).state == "BALANCED"
    assert _load_for(95).state == "BALANCED"
    assert _load_for(95.1).state == "TIGHT"
    assert _load_for(110).state == "TIGHT"
    assert _load_for(110.1).state == "OVERBOOKED"


def test_day_load_no_shift():
    assert compute_day_load(None, [], [], 28).state == "IDLE"
    busy = compute_day_load(None, [AppointmentLoadInput(datetime(2026, 8, 3, 8), datetime(2026, 8, 3, 12), 20)], [], 28)
    assert busy.state == "OVERBOOKED"  # work with zero capacity


def test_day_load_partial_availability_from_blocking_event():
    # 10h shift, a 5h blocking event -> half capacity. planned == half-capacity -> ~TIGHT/BALANCED boundary.
    shift = ShiftInput(date(2026, 8, 3), "07:00", "17:00")
    event = NonJobEventInput(datetime(2026, 8, 3, 7, 0), datetime(2026, 8, 3, 12, 0), blocks_capacity=True)
    load = compute_day_load(shift, [AppointmentLoadInput(datetime(2026, 8, 3, 12), datetime(2026, 8, 3, 16), 50)], [event], 100)
    assert load.available_hours == 5.0
    assert load.capacity_squares == 50.0
    assert load.utilization_pct == 100.0
    assert load.state == "TIGHT"


# ── planMultiDay ─────────────────────────────────────────────────────────────

def _two_and_half_day_job():
    # 70 sq @ 28/day, pitch 6, no tear-off -> exactly 2.5 crew-days
    return JobProductionInput(squares=70, predominant_pitch=6.0, stories=1, tear_off_layers=0, waste_factor_pct=0)


def test_plan_multi_day_basic_series():
    appts, warns = plan_multi_day(_two_and_half_day_job(), CREW, date(2026, 8, 3), lambda d: True)
    assert [a.sequence for a in appts] == [1, 2, 3]
    assert all(a.total_in_series == 3 for a in appts)
    assert abs(sum(a.planned_squares for a in appts) - 70.0) < 0.05  # squares distributed, sum preserved


def test_plan_multi_day_skips_weekend_gap():
    # Fri Aug 7 2026 is a Friday; Sat/Sun unavailable
    def avail(d):
        return d.weekday() < 5
    appts, _ = plan_multi_day(_two_and_half_day_job(), CREW, date(2026, 8, 7), avail)
    days = [a.date for a in appts]
    assert days == [date(2026, 8, 7), date(2026, 8, 10), date(2026, 8, 11)]  # skips Sat 8 + Sun 9


def test_plan_multi_day_skips_pto_or_no_shift_day2():
    blocked = {date(2026, 8, 4)}  # PTO / no shift on day 2
    appts, _ = plan_multi_day(_two_and_half_day_job(), CREW, date(2026, 8, 3), lambda d: d not in blocked)
    assert [a.date for a in appts] == [date(2026, 8, 3), date(2026, 8, 5), date(2026, 8, 6)]


def test_plan_multi_day_insufficient_days():
    appts, warns = plan_multi_day(_two_and_half_day_job(), CREW, date(2026, 8, 3), lambda d: False)
    assert appts == []
    assert "INSUFFICIENT_AVAILABLE_DAYS" in warns


def test_plan_multi_day_refuses_past_deadline():
    appts, warns = plan_multi_day(_two_and_half_day_job(), CREW, date(2026, 8, 3), lambda d: True, deadline=date(2026, 8, 4))
    assert appts == []
    assert "CANNOT_MEET_DEADLINE" in warns


# ── detectConflicts: one per code + combined ─────────────────────────────────

def _prop(**kw):
    base = dict(crew_id="c1", date=date(2026, 8, 3),
                start=datetime(2026, 8, 3, 9), end=datetime(2026, 8, 3, 15))
    base.update(kw)
    return ProposedAssignment(**base)


def test_conflict_no_shift():
    cs = detect_conflicts(_prop(), ConflictContext(has_shift=False))
    assert any(c.code == "NO_SHIFT" and c.severity == "BLOCK" for c in cs)


def test_conflict_double_booked():
    ctx = ConflictContext(has_shift=True, overlapping_appointments=[(datetime(2026, 8, 3, 10), datetime(2026, 8, 3, 12))])
    cs = detect_conflicts(_prop(), ctx)
    assert any(c.code == "DOUBLE_BOOKED" and c.severity == "BLOCK" for c in cs)


def test_conflict_blocked_by_event():
    ctx = ConflictContext(has_shift=True, blocking_events=[(datetime(2026, 8, 3, 8), datetime(2026, 8, 3, 17))])
    cs = detect_conflicts(_prop(), ctx)
    assert any(c.code == "BLOCKED_BY_EVENT" and c.severity == "BLOCK" for c in cs)


def test_conflict_skill_mismatch():
    ctx = ConflictContext(has_shift=True, crew_skills=["ASPHALT_SHINGLE"])
    cs = detect_conflicts(_prop(required_skills=["METAL"]), ctx)
    assert any(c.code == "SKILL_MISMATCH" and c.severity == "BLOCK" for c in cs)


def test_conflict_outside_shift():
    ctx = ConflictContext(has_shift=True, shift_start=datetime(2026, 8, 3, 10), shift_end=datetime(2026, 8, 3, 14))
    cs = detect_conflicts(_prop(), ctx)  # 9-15 spills outside 10-14
    assert any(c.code == "OUTSIDE_SHIFT" and c.severity == "WARN" for c in cs)


def test_conflict_pitch_exceeded():
    ctx = ConflictContext(has_shift=True, crew_max_pitch=9.0)
    cs = detect_conflicts(_prop(job_pitch=10.0), ctx)
    assert any(c.code == "PITCH_EXCEEDED" and c.severity == "WARN" for c in cs)


def test_conflict_overbooked():
    ctx = ConflictContext(has_shift=True, resulting_utilization_pct=120.0)
    cs = detect_conflicts(_prop(), ctx)
    assert any(c.code == "OVERBOOKED" and c.severity == "WARN" for c in cs)


def test_conflict_series_broken():
    ctx = ConflictContext(has_shift=True, series_contiguous=False)
    cs = detect_conflicts(_prop(series_total=3, series_sequence=2), ctx)
    assert any(c.code == "SERIES_BROKEN" and c.severity == "WARN" for c in cs)


def test_conflict_weather_risk():
    ctx = ConflictContext(has_shift=True, precip_probability=70)
    cs = detect_conflicts(_prop(is_exterior=True), ctx)
    assert any(c.code == "WEATHER_RISK" and c.severity == "WARN" for c in cs)
    # not exterior -> no weather risk
    assert not any(c.code == "WEATHER_RISK" for c in detect_conflicts(_prop(is_exterior=False), ctx))


def test_conflict_several_at_once():
    ctx = ConflictContext(has_shift=False, crew_skills=["ASPHALT_SHINGLE"], precip_probability=80)
    cs = detect_conflicts(_prop(required_skills=["METAL"], is_exterior=True), ctx)
    codes = {c.code for c in cs}
    assert {"NO_SHIFT", "SKILL_MISMATCH", "WEATHER_RISK"}.issubset(codes)
    assert has_block(cs) is True


# ── DST boundary ─────────────────────────────────────────────────────────────

def test_local_start_time_preserved_across_dst():
    # US DST 2026: spring-forward Mar 8, fall-back Nov 1. 07:00 local stays 07:00.
    spring = local_datetime(date(2026, 3, 8), "07:00")
    fall = local_datetime(date(2026, 11, 1), "07:00")
    assert local_start_time_str(spring) == "07:00"
    assert local_start_time_str(fall) == "07:00"
    # the offsets differ (EST vs EDT) but the wall-clock time does not
    assert spring.utcoffset() != fall.utcoffset()
