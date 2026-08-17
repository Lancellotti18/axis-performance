"""Production-capacity engine — the heart of the dispatch board.

Pure functions, no I/O. This is where "schedule production, not appointments"
lives: a job's duration comes from its measured squares + pitch + tear-off, and
a crew's real throughput — not a number someone typed into a calendar.

Every number the board shows traces back to one of these functions.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Callable, List, Optional, Tuple

from app.services.scheduling.timeutil import naive_dt, overlap_hours, shift_hours

# ── Lookups (tables, not formulas — steep slope is not linear) ───────────────
# Pitch (rise/12) -> production multiplier. Keyed by rounded integer pitch.
PITCH_MULTIPLIERS = {6: 1.00, 7: 1.15, 8: 1.30, 9: 1.50, 10: 1.75}
STEEP_MULTIPLIER = 2.10  # 11/12 and steeper — also flags requiresSteepSlopeCrew
STEEP_PITCH_THRESHOLD = 11

# Fallback crew-days when a job has no measurements yet (marked isEstimated).
JOB_TYPE_DEFAULT_DAYS = {
    "REROOF": 2.0,
    "NEW_ROOF_INSTALL": 2.5,
    "ROOF_REPAIR": 0.5,
    "GUTTER_REPAIR": 0.5,
    "GUTTER_INSTALL": 1.0,
    "SIDING_REPAIR": 0.5,
    "NEW_SIDING_INSTALL": 3.0,
    "INSPECTION": 0.5,
}
_DEFAULT_FALLBACK_DAYS = 1.0


def _round_up_half(x: float) -> float:
    """Round UP to the nearest half day, minimum 0.5."""
    return max(0.5, math.ceil(x * 2 - 1e-9) / 2.0)


def pitch_multiplier(pitch: float) -> Tuple[float, bool]:
    """Return (multiplier, is_steep). Buckets by nearest integer pitch."""
    p = int(round(pitch))
    if p <= 6:
        return 1.00, False
    if p in PITCH_MULTIPLIERS:
        return PITCH_MULTIPLIERS[p], False
    return STEEP_MULTIPLIER, True  # p >= 11


def story_multiplier(stories: int) -> float:
    if stories <= 1:
        return 1.00
    if stories == 2:
        return 1.10
    return 1.25


# ── 3.1 Job duration from measurements ───────────────────────────────────────

@dataclass
class JobProductionInput:
    squares: Optional[float]
    predominant_pitch: Optional[float]        # rise/12
    stories: Optional[int]
    tear_off_layers: int = 0
    waste_factor_pct: Optional[float] = None
    job_type: Optional[str] = None            # for the missing-measurement fallback


@dataclass
class CrewCapacityInput:
    squares_per_day: float
    tear_off_squares_per_day: float
    max_pitch: float = 12.0
    max_stories: int = 2


@dataclass
class CrewDayBreakdown:
    tear_off_days: float
    install_days: float
    pitch_multiplier: float
    story_multiplier: float


@dataclass
class CrewDayEstimate:
    crew_days: float
    breakdown: CrewDayBreakdown
    warnings: List[str] = field(default_factory=list)
    is_estimated: bool = False
    requires_steep_slope_crew: bool = False
    effective_squares: Optional[float] = None


def effective_squares(job: JobProductionInput) -> Optional[float]:
    if job.squares is None:
        return None
    return job.squares * (1 + (job.waste_factor_pct or 0.0) / 100.0)


def compute_crew_days(job: JobProductionInput, crew: CrewCapacityInput) -> CrewDayEstimate:
    # Missing measurements → fall back to a job-type default, flagged so the UI
    # can render it differently. Absence of a measurement is itself actionable.
    if job.squares is None or job.predominant_pitch is None:
        default = JOB_TYPE_DEFAULT_DAYS.get((job.job_type or "").upper(), _DEFAULT_FALLBACK_DAYS)
        return CrewDayEstimate(
            crew_days=_round_up_half(default),
            breakdown=CrewDayBreakdown(0.0, default, 1.0, 1.0),
            warnings=["MISSING_MEASUREMENTS"],
            is_estimated=True,
        )

    eff = effective_squares(job) or 0.0
    p_mult, is_steep = pitch_multiplier(job.predominant_pitch)
    s_mult = story_multiplier(job.stories or 1)

    install_days = eff / crew.squares_per_day if crew.squares_per_day > 0 else 0.0
    tear_off_days = 0.0
    if job.tear_off_layers > 0 and crew.tear_off_squares_per_day > 0:
        tear_off_days = (eff * job.tear_off_layers) / crew.tear_off_squares_per_day

    total = (install_days + tear_off_days) * p_mult * s_mult
    crew_days = _round_up_half(total)

    warnings: List[str] = []
    if job.predominant_pitch > crew.max_pitch:
        warnings.append("PITCH_EXCEEDS_CREW_MAX")
    if (job.stories or 1) > crew.max_stories:
        warnings.append("STORIES_EXCEED_CREW_MAX")

    return CrewDayEstimate(
        crew_days=crew_days,
        breakdown=CrewDayBreakdown(
            tear_off_days=round(tear_off_days * p_mult * s_mult, 3),
            install_days=round(install_days * p_mult * s_mult, 3),
            pitch_multiplier=p_mult,
            story_multiplier=s_mult,
        ),
        warnings=warnings,
        requires_steep_slope_crew=is_steep,
        effective_squares=round(eff, 2),
    )


# ── 3.2 Daily crew load ──────────────────────────────────────────────────────

@dataclass
class ShiftInput:
    date: date
    start_time: str  # "07:00"
    end_time: str    # "17:00"


@dataclass
class AppointmentLoadInput:
    scheduled_start: datetime
    scheduled_end: datetime
    planned_squares: float = 0.0


@dataclass
class NonJobEventInput:
    start_at: datetime
    end_at: datetime
    blocks_capacity: bool = True


@dataclass
class DayLoad:
    appointment_count: int
    scheduled_hours: float
    available_hours: float
    planned_squares: float
    capacity_squares: float
    utilization_pct: float
    state: str  # IDLE | LIGHT | BALANCED | TIGHT | OVERBOOKED


def _load_state(util_pct: float) -> str:
    if util_pct < 15:
        return "IDLE"
    if util_pct < 60:
        return "LIGHT"
    if util_pct <= 95:
        return "BALANCED"
    if util_pct <= 110:
        return "TIGHT"
    return "OVERBOOKED"


def compute_day_load(
    shift: Optional[ShiftInput],
    appointments: List[AppointmentLoadInput],
    non_job_events: List[NonJobEventInput],
    crew_squares_per_day: float,
) -> DayLoad:
    if shift is None:
        total_shift = 0.0
        available = 0.0
    else:
        total_shift = shift_hours(shift.start_time, shift.end_time)
        s_start = naive_dt(shift.date, shift.start_time)
        s_end = naive_dt(shift.date, shift.end_time)
        blocked = sum(
            overlap_hours(s_start, s_end, e.start_at, e.end_at)
            for e in non_job_events if e.blocks_capacity
        )
        available = max(0.0, total_shift - blocked)

    scheduled = sum(
        (a.scheduled_end - a.scheduled_start).total_seconds() / 3600.0 for a in appointments
    )
    planned = sum(a.planned_squares for a in appointments)
    capacity = crew_squares_per_day * (available / total_shift) if total_shift > 0 else 0.0

    if capacity <= 0:
        util = 0.0 if planned <= 0 else 999.0
    else:
        # Round once so the number shown and the state always agree (a cell must
        # never read "110%" while flagged OVERBOOKED because of float dust).
        util = round(planned / capacity * 100.0, 1)

    return DayLoad(
        appointment_count=len(appointments),
        scheduled_hours=round(scheduled, 2),
        available_hours=round(available, 2),
        planned_squares=round(planned, 2),
        capacity_squares=round(capacity, 2),
        utilization_pct=util,
        state=_load_state(util),
    )


# ── 3.3 Multi-day placement ──────────────────────────────────────────────────

@dataclass
class PlannedAppointment:
    sequence: int
    total_in_series: int
    date: date
    planned_squares: Optional[float]


def _day_fractions(crew_days: float) -> List[float]:
    fracs: List[float] = []
    remaining = crew_days
    while remaining > 1e-9:
        take = 1.0 if remaining >= 1.0 else remaining
        fracs.append(round(take, 4))
        remaining -= take
    return fracs or [0.5]


def plan_multi_day(
    job: JobProductionInput,
    crew: CrewCapacityInput,
    start_date: date,
    day_available: Callable[[date], bool],
    deadline: Optional[date] = None,
    max_search_days: int = 120,
) -> Tuple[List[PlannedAppointment], List[str]]:
    """Distribute a job's crew-days across the crew's available calendar days,
    skipping days with no shift / blocking events. Never throws; returns
    (appointments, warnings). Refuses (empty plan) if a hard deadline can't be met
    or there aren't enough available days in the search window."""
    est = compute_crew_days(job, crew)
    warnings = list(est.warnings)
    fractions = _day_fractions(est.crew_days)
    total_days = sum(fractions) or 1.0
    eff = effective_squares(job)

    picked: List[date] = []
    d = start_date
    searched = 0
    while len(picked) < len(fractions) and searched < max_search_days:
        if day_available(d):
            picked.append(d)
        d = d + timedelta(days=1)
        searched += 1

    if len(picked) < len(fractions):
        warnings.append("INSUFFICIENT_AVAILABLE_DAYS")
        return [], warnings
    if deadline is not None and picked[-1] > deadline:
        warnings.append("CANNOT_MEET_DEADLINE")
        return [], warnings

    appts: List[PlannedAppointment] = []
    for i, (frac, dt) in enumerate(zip(fractions, picked)):
        ps = round(eff * (frac / total_days), 2) if eff is not None else None
        appts.append(PlannedAppointment(
            sequence=i + 1, total_in_series=len(fractions), date=dt, planned_squares=ps,
        ))
    return appts, warnings


# ── 3.4 Conflict detection ───────────────────────────────────────────────────

@dataclass
class ProposedAssignment:
    crew_id: str
    date: date
    start: datetime
    end: datetime
    required_skills: List[str] = field(default_factory=list)
    job_pitch: Optional[float] = None
    is_exterior: bool = True
    series_total: int = 1
    series_sequence: int = 1


@dataclass
class ConflictContext:
    has_shift: bool
    shift_start: Optional[datetime] = None
    shift_end: Optional[datetime] = None
    crew_skills: List[str] = field(default_factory=list)
    crew_max_pitch: float = 12.0
    overlapping_appointments: List[Tuple[datetime, datetime]] = field(default_factory=list)
    blocking_events: List[Tuple[datetime, datetime]] = field(default_factory=list)
    resulting_utilization_pct: float = 0.0
    precip_probability: Optional[int] = None
    series_contiguous: bool = True


@dataclass
class Conflict:
    code: str
    severity: str  # BLOCK | WARN
    message: str


def detect_conflicts(p: ProposedAssignment, ctx: ConflictContext) -> List[Conflict]:
    out: List[Conflict] = []

    if not ctx.has_shift:
        out.append(Conflict("NO_SHIFT", "BLOCK", "No shift scheduled for this crew on this day."))

    for (s, e) in ctx.overlapping_appointments:
        if overlap_hours(p.start, p.end, s, e) > 0:
            out.append(Conflict("DOUBLE_BOOKED", "BLOCK", "Crew already has an overlapping appointment."))
            break

    for (s, e) in ctx.blocking_events:
        if overlap_hours(p.start, p.end, s, e) > 0:
            out.append(Conflict("BLOCKED_BY_EVENT", "BLOCK", "Overlaps a blocking event (PTO, training, truck in shop)."))
            break

    missing = [s for s in p.required_skills if s not in ctx.crew_skills]
    if missing:
        out.append(Conflict("SKILL_MISMATCH", "BLOCK", "Crew lacks required skill(s): " + ", ".join(missing) + "."))

    if ctx.has_shift and ctx.shift_start is not None and ctx.shift_end is not None:
        if p.start < ctx.shift_start or p.end > ctx.shift_end:
            out.append(Conflict("OUTSIDE_SHIFT", "WARN", "Appointment falls outside the crew's shift window."))

    if p.job_pitch is not None and p.job_pitch > ctx.crew_max_pitch:
        out.append(Conflict("PITCH_EXCEEDED", "WARN",
                            "Job pitch %g/12 exceeds crew max %g/12." % (p.job_pitch, ctx.crew_max_pitch)))

    if ctx.resulting_utilization_pct > 110:
        out.append(Conflict("OVERBOOKED", "WARN",
                            "Resulting utilization %.0f%% is over capacity." % ctx.resulting_utilization_pct))

    if p.series_total > 1 and not ctx.series_contiguous:
        out.append(Conflict("SERIES_BROKEN", "WARN", "Moving this day breaks the multi-day series continuity."))

    if p.is_exterior and ctx.precip_probability is not None and ctx.precip_probability >= 60:
        out.append(Conflict("WEATHER_RISK", "WARN", "%d%% precip probability on an exterior job." % ctx.precip_probability))

    return out


def has_block(conflicts: List[Conflict]) -> bool:
    return any(c.severity == "BLOCK" for c in conflicts)


# ── Crew lifecycle ────────────────────────────────────────────────────────────

# Work that no longer needs the crew: finished, called off, or back in the tray.
# None of it is a reason to refuse to retire a crew.
RELEASED_STATUSES = {"DONE", "CANCELED", "UNASSIGNED"}


def split_crew_work(appointments: List[dict], today: str) -> Tuple[List[dict], int]:
    """Split a crew's appointments into (still needs this crew, already behind it).

    An appointment only holds a crew if it is both in the future and in a live
    status. Anything finished, called off, back in the tray, or simply in the
    past is history and must not stop the crew being retired — the board shows
    one week at a time, so a job in any other week is invisible to the
    dispatcher and makes a refusal look like a phantom.

    An appointment with no date is treated as live: we can't prove it's behind
    us, and wrongly retiring a crew that's still on the hook is the worse error.
    Returned upcoming list is sorted soonest-first, so callers can name the date
    the dispatcher needs to go find.
    """
    upcoming: List[dict] = []
    finished = 0
    for r in appointments:
        starts = (r.get("scheduled_start") or "")[:10]
        if (r.get("status") or "").upper() in RELEASED_STATUSES or (starts and starts < today):
            finished += 1
        else:
            upcoming.append(r)
    upcoming.sort(key=lambda r: r.get("scheduled_start") or "")
    return upcoming, finished
