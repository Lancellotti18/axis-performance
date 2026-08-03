"""Crew Scheduling & Dispatch — self-contained section.

Pure, dependency-free production-capacity math lives here (no Prisma, no Supabase,
no FastAPI imports). It is the single source of truth the board narrates. Every
number the UI shows must trace back to one of these tested functions.
"""
from app.services.scheduling.capacity import (  # noqa: F401
    JobProductionInput,
    CrewCapacityInput,
    CrewDayEstimate,
    CrewDayBreakdown,
    compute_crew_days,
    ShiftInput,
    AppointmentLoadInput,
    NonJobEventInput,
    DayLoad,
    compute_day_load,
    PlannedAppointment,
    plan_multi_day,
    ProposedAssignment,
    ConflictContext,
    Conflict,
    detect_conflicts,
    PITCH_MULTIPLIERS,
    JOB_TYPE_DEFAULT_DAYS,
)
