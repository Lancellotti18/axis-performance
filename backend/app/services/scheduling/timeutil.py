"""Time helpers for scheduling. Local-wall-clock aware so a job keeps its local
start time across DST transitions (never raw Date arithmetic across a boundary)."""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Optional, Tuple

try:  # py3.9+
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore

DEFAULT_TZ = "America/New_York"


def parse_hhmm(s: str) -> Tuple[int, int]:
    h, m = s.split(":")
    return int(h), int(m)


def shift_hours(start_hhmm: str, end_hhmm: str) -> float:
    sh, sm = parse_hhmm(start_hhmm)
    eh, em = parse_hhmm(end_hhmm)
    return max(0.0, (eh * 60 + em - (sh * 60 + sm)) / 60.0)


def naive_dt(d: date, hhmm: str) -> datetime:
    """Naive datetime for a day+time — used inside single-day load math where all
    inputs share one timezone."""
    h, m = parse_hhmm(hhmm)
    return datetime(d.year, d.month, d.day, h, m)


def local_datetime(d: date, hhmm: str, tz_name: str = DEFAULT_TZ) -> datetime:
    """Timezone-aware datetime that preserves the wall-clock time regardless of
    whether the date is inside DST or not — 07:00 local is 07:00 local in both
    March and November."""
    h, m = parse_hhmm(hhmm)
    if ZoneInfo is None:  # pragma: no cover
        return datetime(d.year, d.month, d.day, h, m)
    return datetime(d.year, d.month, d.day, h, m, tzinfo=ZoneInfo(tz_name))


def overlap_hours(a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime) -> float:
    start = max(a_start, b_start)
    end = min(a_end, b_end)
    return max(0.0, (end - start).total_seconds() / 3600.0)


def add_days(d: date, n: int) -> date:
    return d + timedelta(days=n)


def local_start_time_str(dt: datetime) -> str:
    return f"{dt.hour:02d}:{dt.minute:02d}"
