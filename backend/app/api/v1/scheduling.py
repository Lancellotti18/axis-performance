"""Crew Scheduling & Dispatch — API (self-contained section).

M2 exposes ONE read: GET /board returns the whole visible slice in a single
request (no N+1), including per-crew-day loads computed by the pure capacity
engine. Single seeded org for now; every query is keyed by org_id so tenancy
drops in later without a rewrite. Reads sched_* tables only; touches nothing else.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import require_user
from app.core.supabase import get_supabase
from app.services.scheduling.capacity import (
    AppointmentLoadInput, NonJobEventInput, ShiftInput, compute_day_load,
)

logger = logging.getLogger(__name__)
router = APIRouter()

# Single-org stub (auth is a stub per the brief). Everything keys off this so
# multi-tenancy can be added later without a rewrite.
ORG = "00000000-0000-0000-0000-000000000001"


def _parse_date(s: str, field: str) -> date:
    try:
        return date.fromisoformat(s)
    except Exception:
        raise HTTPException(status_code=400, detail=f"Invalid {field} date (expected YYYY-MM-DD).")


def _dt(s: Optional[str]) -> Optional[datetime]:
    """Parse a Supabase timestamptz into a naive wall-clock datetime (all data
    shares one timezone, and the capacity engine's day math is naive)."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).replace(tzinfo=None)
    except Exception:
        return None


def _rows(res) -> list:
    return res.data or []


@router.get("/board")
async def get_board(
    start: str = Query(..., description="YYYY-MM-DD (inclusive)"),
    end: str = Query(..., description="YYYY-MM-DD (inclusive)"),
    businessUnitIds: Optional[str] = Query(None),
    crewIds: Optional[str] = Query(None),
    user: dict = Depends(require_user),
) -> dict:
    d0 = _parse_date(start, "start")
    d1 = _parse_date(end, "end")
    if d1 < d0:
        raise HTTPException(status_code=400, detail="end is before start.")
    if (d1 - d0).days > 60:
        raise HTTPException(status_code=400, detail="Range too wide (max 60 days).")
    days = [d0 + timedelta(days=i) for i in range((d1 - d0).days + 1)]
    day_strs = {dd.isoformat() for dd in days}
    end_excl = (d1 + timedelta(days=1)).isoformat()

    bu_filter = [x for x in (businessUnitIds or "").split(",") if x]
    crew_filter = [x for x in (crewIds or "").split(",") if x]

    db = get_supabase()

    def tbl(name: str):
        return db.table(name).select("*").eq("org_id", ORG)

    business_units = sorted(_rows(tbl("sched_business_unit").eq("is_active", True).execute()),
                            key=lambda b: b.get("sort_order", 0))
    if bu_filter:
        business_units = [b for b in business_units if b["id"] in bu_filter]
    bu_ids = {b["id"] for b in business_units}

    crews = [c for c in _rows(tbl("sched_crew").eq("is_active", True).execute()) if c["business_unit_id"] in bu_ids]
    if crew_filter:
        crews = [c for c in crews if c["id"] in crew_filter]
    crews.sort(key=lambda c: c.get("name", ""))
    crew_ids = {c["id"] for c in crews}

    persons = _rows(tbl("sched_person").execute())
    skills = [s for s in _rows(tbl("sched_crew_skill").execute()) if s["crew_id"] in crew_ids]
    memberships = [m for m in _rows(tbl("sched_crew_membership").execute()) if m["crew_id"] in crew_ids]

    shifts = [s for s in _rows(tbl("sched_shift").gte("date", start).lte("date", end).execute())
              if s["crew_id"] in crew_ids]
    non_job_events = [e for e in _rows(tbl("sched_non_job_event").lt("start_at", end_excl).execute())
                      if e["crew_id"] in crew_ids and (_dt(e.get("end_at")) or datetime.min) >= datetime.combine(d0, datetime.min.time())]

    appts_all = _rows(tbl("sched_appointment").gte("scheduled_start", start).lt("scheduled_start", end_excl).execute())
    assignments = _rows(tbl("sched_assignment").execute())
    appt_crew: dict = {}
    for a in assignments:
        if a.get("is_primary", True):
            appt_crew[a["appointment_id"]] = a["crew_id"]
    # Keep appointments whose (primary) crew is in view.
    appointments = [ap for ap in appts_all if appt_crew.get(ap["id"]) in crew_ids]
    assignments = [a for a in assignments if a["appointment_id"] in {ap["id"] for ap in appointments}]

    job_ids = {ap["job_id"] for ap in appointments}
    jobs = [j for j in _rows(tbl("sched_job").execute()) if j["id"] in job_ids]
    cust_ids = {j["customer_id"] for j in jobs}
    prop_ids = {j["property_id"] for j in jobs}
    customers = [c for c in _rows(tbl("sched_customer").execute()) if c["id"] in cust_ids]
    properties = [p for p in _rows(tbl("sched_property").execute()) if p["id"] in prop_ids]
    tags = _rows(tbl("sched_job_tag").execute())
    tag_links = [l for l in _rows(tbl("sched_job_tag_link").execute()) if l["job_id"] in job_ids]

    weather = [w for w in _rows(db.table("sched_weather_day").select("*").gte("date", start).lte("date", end).execute())]

    # ── Per-crew-day loads via the pure capacity engine ──────────────────────
    shift_by = {(s["crew_id"], s["date"]): s for s in shifts}
    appts_by_crew_day: dict = defaultdict(list)
    for ap in appointments:
        cid = appt_crew.get(ap["id"])
        sdt = _dt(ap.get("scheduled_start"))
        if cid and sdt:
            appts_by_crew_day[(cid, sdt.date().isoformat())].append(ap)
    events_by_crew: dict = defaultdict(list)
    for e in non_job_events:
        events_by_crew[e["crew_id"]].append(e)

    day_loads: dict = {}
    for c in crews:
        cid = c["id"]
        spd = float(c.get("squares_per_day") or 0)
        for dd in days:
            ds = dd.isoformat()
            srow = shift_by.get((cid, ds))
            shift_in = ShiftInput(dd, srow["start_time"], srow["end_time"]) if srow else None
            appt_ins = [
                AppointmentLoadInput(
                    scheduled_start=_dt(ap.get("scheduled_start")) or datetime.combine(dd, datetime.min.time()),
                    scheduled_end=_dt(ap.get("scheduled_end")) or datetime.combine(dd, datetime.min.time()),
                    planned_squares=float(ap.get("planned_squares") or 0),
                ) for ap in appts_by_crew_day.get((cid, ds), [])
            ]
            event_ins = []
            for e in events_by_crew.get(cid, []):
                es, ee = _dt(e.get("start_at")), _dt(e.get("end_at"))
                if es and ee and es.date() <= dd <= ee.date():
                    event_ins.append(NonJobEventInput(es, ee, bool(e.get("blocks_capacity", True))))
            load = compute_day_load(shift_in, appt_ins, event_ins, spd)
            day_loads[f"{cid}:{ds}"] = {
                "crew_id": cid, "date": ds,
                "appointment_count": load.appointment_count,
                "scheduled_hours": load.scheduled_hours,
                "available_hours": load.available_hours,
                "planned_squares": load.planned_squares,
                "capacity_squares": load.capacity_squares,
                "utilization_pct": load.utilization_pct,
                "state": load.state,
            }

    return {
        "range": {"start": start, "end": end, "days": [dd.isoformat() for dd in days]},
        "business_units": business_units,
        "crews": crews,
        "persons": persons,
        "crew_skills": skills,
        "crew_memberships": memberships,
        "shifts": shifts,
        "non_job_events": non_job_events,
        "appointments": appointments,
        "assignments": assignments,
        "appointment_crew": appt_crew,      # appointment_id -> primary crew_id
        "jobs": jobs,
        "customers": customers,
        "properties": properties,
        "tags": tags,
        "job_tag_links": tag_links,
        "weather": weather,
        "day_loads": day_loads,
    }
