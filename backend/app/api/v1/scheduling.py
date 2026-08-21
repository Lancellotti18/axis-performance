"""Crew Scheduling & Dispatch — API (self-contained section).

M2 exposes ONE read: GET /board returns the whole visible slice in a single
request (no N+1), including per-crew-day loads computed by the pure capacity
engine. Single seeded org for now; every query is keyed by org_id so tenancy
drops in later without a rewrite. Reads sched_* tables only; touches nothing else.
"""
from __future__ import annotations

import json
import logging
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.auth import require_user
from app.core.supabase import get_supabase
from app.services.scheduling.capacity import (
    AppointmentLoadInput, ConflictContext, CrewCapacityInput, JobProductionInput,
    NonJobEventInput, ProposedAssignment, ShiftInput, compute_crew_days,
    compute_day_load, detect_conflicts, has_block, split_crew_work,
    RELEASED_STATUSES,
)
from app.services.scheduling.timeutil import naive_dt
from app.services.scheduling.copilot import (
    ThroughputSample, analyze_crew_throughput, assemble_brief, BriefInputs, templated_prose, parse_plan_json,
)
from app.services.llm import llm_text

logger = logging.getLogger(__name__)
router = APIRouter()

# Single-org stub (auth is a stub per the brief). Everything keys off this so
# multi-tenancy can be added later without a rewrite.
ORG = "00000000-0000-0000-0000-000000000001"

# Job type -> the crew skill it requires (steep slope added separately by pitch).
JOB_SKILL = {
    "REROOF": "ASPHALT_SHINGLE", "NEW_ROOF_INSTALL": "ASPHALT_SHINGLE", "ROOF_REPAIR": "ASPHALT_SHINGLE",
    "GUTTER_REPAIR": "GUTTER", "GUTTER_INSTALL": "GUTTER",
    "SIDING_REPAIR": "SIDING", "NEW_SIDING_INSTALL": "SIDING", "INSPECTION": None,
}


def _f(v) -> Optional[float]:
    try:
        return float(v) if v is not None else None
    except Exception:
        return None


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


# ── M3: single-item interaction — preview + move ─────────────────────────────

def _job_input(job: dict) -> JobProductionInput:
    return JobProductionInput(
        squares=_f(job.get("squares")), predominant_pitch=_f(job.get("predominant_pitch")),
        stories=job.get("stories"), tear_off_layers=int(job.get("tear_off_layers") or 0),
        waste_factor_pct=_f(job.get("waste_factor_pct")), job_type=job.get("job_type"),
    )


def _crew_input(crew: dict) -> CrewCapacityInput:
    return CrewCapacityInput(
        squares_per_day=_f(crew.get("squares_per_day")) or 0.0,
        tear_off_squares_per_day=_f(crew.get("tear_off_squares_per_day")) or 0.0,
        max_pitch=_f(crew.get("max_pitch")) or 12.0, max_stories=int(crew.get("max_stories") or 2),
    )


def _required_skills(job: dict) -> list:
    base = JOB_SKILL.get(job.get("job_type"))
    out = [base] if base else []
    p = _f(job.get("predominant_pitch"))
    if p and p >= 11:
        out.append("STEEP_SLOPE")
    return out


def _label(job_type: Optional[str]) -> str:
    return (job_type or "").replace("_", " ").title()


def _one(db, table, id_):
    r = db.table(table).select("*").eq("org_id", ORG).eq("id", id_).limit(1).execute()
    return (r.data or [None])[0]


def _crew_appts_on(db, crew_id, date_str, exclude_id=None):
    asg = db.table("sched_assignment").select("appointment_id").eq("org_id", ORG).eq("crew_id", crew_id).execute().data or []
    ids = [a["appointment_id"] for a in asg]
    if not ids:
        return []
    aps = db.table("sched_appointment").select("*").eq("org_id", ORG).in_("id", ids).execute().data or []
    out = []
    for ap in aps:
        if exclude_id and ap["id"] == exclude_id:
            continue
        sdt = _dt(ap.get("scheduled_start"))
        if sdt and sdt.date().isoformat() == date_str:
            out.append(ap)
    return out


def _day_load_dict(db, crew: dict, date_str: str) -> dict:
    d = date.fromisoformat(date_str)
    srow = db.table("sched_shift").select("*").eq("org_id", ORG).eq("crew_id", crew["id"]).eq("date", date_str).limit(1).execute().data
    shift_in = ShiftInput(d, srow[0]["start_time"], srow[0]["end_time"]) if srow else None
    appts = _crew_appts_on(db, crew["id"], date_str)
    appt_ins = [AppointmentLoadInput(_dt(a.get("scheduled_start")) or datetime.combine(d, datetime.min.time()),
                                     _dt(a.get("scheduled_end")) or datetime.combine(d, datetime.min.time()),
                                     _f(a.get("planned_squares")) or 0.0) for a in appts]
    events = db.table("sched_non_job_event").select("*").eq("org_id", ORG).eq("crew_id", crew["id"]).execute().data or []
    ev_ins = []
    for e in events:
        es, ee = _dt(e.get("start_at")), _dt(e.get("end_at"))
        if es and ee and es.date() <= d <= ee.date():
            ev_ins.append(NonJobEventInput(es, ee, bool(e.get("blocks_capacity", True))))
    load = compute_day_load(shift_in, appt_ins, ev_ins, _f(crew.get("squares_per_day")) or 0.0)
    return {"crew_id": crew["id"], "date": date_str, "appointment_count": load.appointment_count,
            "scheduled_hours": load.scheduled_hours, "available_hours": load.available_hours,
            "planned_squares": load.planned_squares, "capacity_squares": load.capacity_squares,
            "utilization_pct": load.utilization_pct, "state": load.state}


def _evaluate_move(db, appt: dict, job: dict, crew: dict, date_str: str) -> dict:
    d = date.fromisoformat(date_str)
    s0, e0 = _dt(appt.get("scheduled_start")), _dt(appt.get("scheduled_end"))
    st = naive_dt(d, s0.strftime("%H:%M")) if s0 else datetime.combine(d, datetime.min.time())
    en = naive_dt(d, e0.strftime("%H:%M")) if e0 else datetime.combine(d, datetime.min.time())

    srow = db.table("sched_shift").select("*").eq("org_id", ORG).eq("crew_id", crew["id"]).eq("date", date_str).limit(1).execute().data
    has_shift = bool(srow)
    shift_start = naive_dt(d, srow[0]["start_time"]) if has_shift else None
    shift_end = naive_dt(d, srow[0]["end_time"]) if has_shift else None

    skills = [s["skill"] for s in (db.table("sched_crew_skill").select("skill").eq("org_id", ORG).eq("crew_id", crew["id"]).execute().data or [])]
    others = _crew_appts_on(db, crew["id"], date_str, exclude_id=appt["id"])
    overlaps = [(_dt(a["scheduled_start"]), _dt(a["scheduled_end"])) for a in others if _dt(a.get("scheduled_start")) and _dt(a.get("scheduled_end"))]

    events = db.table("sched_non_job_event").select("*").eq("org_id", ORG).eq("crew_id", crew["id"]).execute().data or []
    blocking = []
    for e in events:
        es, ee = _dt(e.get("start_at")), _dt(e.get("end_at"))
        if es and ee and e.get("blocks_capacity", True) and es.date() <= d <= ee.date():
            blocking.append((es, ee))

    wx = db.table("sched_weather_day").select("*").eq("date", date_str).execute().data or []
    wx = sorted(wx, key=lambda w: 0 if w.get("postal_prefix") == "284" else 1)
    precip = wx[0]["precip_probability"] if wx else None

    appt_ins = [AppointmentLoadInput(_dt(a["scheduled_start"]), _dt(a["scheduled_end"]), _f(a.get("planned_squares")) or 0.0) for a in others]
    appt_ins.append(AppointmentLoadInput(st, en, _f(appt.get("planned_squares")) or 0.0))
    ev_ins = [NonJobEventInput(s, e, True) for (s, e) in blocking]
    shift_in = ShiftInput(d, srow[0]["start_time"], srow[0]["end_time"]) if has_shift else None
    load = compute_day_load(shift_in, appt_ins, ev_ins, _f(crew.get("squares_per_day")) or 0.0)

    contiguous = True
    if int(appt.get("total_in_series") or 1) > 1:
        sibs = db.table("sched_appointment").select("scheduled_start,id").eq("org_id", ORG).eq("job_id", appt["job_id"]).neq("id", appt["id"]).execute().data or []
        sib_dates = [_dt(s["scheduled_start"]).date() for s in sibs if _dt(s.get("scheduled_start"))]
        contiguous = any(abs((d - sd).days) <= 1 for sd in sib_dates) if sib_dates else True

    prop = ProposedAssignment(
        crew_id=crew["id"], date=d, start=st, end=en, required_skills=_required_skills(job),
        job_pitch=_f(job.get("predominant_pitch")), is_exterior=(job.get("job_type") != "INSPECTION"),
        series_total=int(appt.get("total_in_series") or 1), series_sequence=int(appt.get("sequence") or 1),
    )
    ctx = ConflictContext(
        has_shift=has_shift, shift_start=shift_start, shift_end=shift_end, crew_skills=skills,
        crew_max_pitch=_f(crew.get("max_pitch")) or 12.0, overlapping_appointments=overlaps,
        blocking_events=blocking, resulting_utilization_pct=load.utilization_pct,
        precip_probability=precip, series_contiguous=contiguous,
    )
    conflicts = detect_conflicts(prop, ctx)
    est = compute_crew_days(_job_input(job), _crew_input(crew))
    return {
        "conflicts": [{"code": c.code, "severity": c.severity, "message": c.message} for c in conflicts],
        "blocked": has_block(conflicts),
        "resulting_utilization_pct": load.utilization_pct,
        "resulting_state": load.state,
        "resulting_planned_squares": load.planned_squares,
        "capacity_squares": load.capacity_squares,
        "crew_days": {"crew_days": est.crew_days, "is_estimated": est.is_estimated,
                      "tear_off_days": est.breakdown.tear_off_days, "install_days": est.breakdown.install_days,
                      "pitch_multiplier": est.breakdown.pitch_multiplier, "story_multiplier": est.breakdown.story_multiplier,
                      "warnings": est.warnings},
    }


@router.get("/preview")
async def preview_move(appointment_id: str, crew_id: str, date: str, user: dict = Depends(require_user)) -> dict:
    """Dry-run a drop: conflicts + resulting utilization for moving an appointment
    onto (crew_id, date). Read-only; drives the drag-hover paint."""
    db = get_supabase()
    _parse_date(date, "date")
    appt = _one(db, "sched_appointment", appointment_id)
    if not appt:
        raise HTTPException(status_code=404, detail="Appointment not found.")
    job = _one(db, "sched_job", appt["job_id"])
    crew = _one(db, "sched_crew", crew_id)
    if not job or not crew:
        raise HTTPException(status_code=404, detail="Job or crew not found.")
    return _evaluate_move(db, appt, job, crew, date)


class AppointmentPatch(BaseModel):
    crew_id: Optional[str] = None
    date: Optional[str] = None
    status: Optional[str] = None
    request_id: Optional[str] = None


VALID_STATUS = {"UNASSIGNED", "SCHEDULED", "DISPATCHED", "WORKING", "PAUSED", "DONE", "CANCELED", "HOLD"}


def _affected_slice(db, after: dict, old_cd, new_cd) -> dict:
    siblings = db.table("sched_appointment").select("*").eq("org_id", ORG).eq("job_id", after["job_id"]).execute().data or []
    touched = set()
    for cd in (old_cd, new_cd):
        if cd and cd[0] and cd[1]:
            touched.add((cd[0], cd[1]))
    day_loads = {}
    for (cid, ds) in touched:
        crew = _one(db, "sched_crew", cid)
        if crew:
            day_loads[f"{cid}:{ds}"] = _day_load_dict(db, crew, ds)
    return {"appointment": after, "series": siblings, "day_loads": day_loads}


@router.patch("/appointments/{appointment_id}")
async def patch_appointment(appointment_id: str, patch: AppointmentPatch, user: dict = Depends(require_user)) -> dict:
    """Move / reassign / restatus one appointment. Returns the full affected slice
    (the appointment, its series siblings, and recomputed dayLoads for every
    touched crew-day) so the client patches cache without refetching."""
    db = get_supabase()
    appt = _one(db, "sched_appointment", appointment_id)
    if not appt:
        raise HTTPException(status_code=404, detail="Appointment not found.")

    if patch.request_id:
        prior = (db.table("sched_audit_event").select("id").eq("org_id", ORG)
                 .eq("entity_id", appointment_id).eq("request_id", patch.request_id).limit(1).execute().data)
        if prior:
            return _affected_slice(db, appt, None, None)

    old_dt = _dt(appt.get("scheduled_start"))
    old_date = old_dt.date().isoformat() if old_dt else None
    prim = (db.table("sched_assignment").select("*").eq("org_id", ORG)
            .eq("appointment_id", appointment_id).eq("is_primary", True).limit(1).execute().data or [None])[0]
    old_crew_id = prim["crew_id"] if prim else None

    updates: dict = {}
    if patch.date:
        nd = _parse_date(patch.date, "date")
        s0, e0 = _dt(appt.get("scheduled_start")), _dt(appt.get("scheduled_end"))
        st = naive_dt(nd, s0.strftime("%H:%M")) if s0 else datetime.combine(nd, datetime.min.time())
        en = naive_dt(nd, e0.strftime("%H:%M")) if e0 else datetime.combine(nd, datetime.min.time())
        updates["scheduled_start"] = st.isoformat()
        updates["scheduled_end"] = en.isoformat()
    if patch.status:
        if patch.status not in VALID_STATUS:
            raise HTTPException(status_code=400, detail=f"Invalid status '{patch.status}'.")
        updates["status"] = patch.status
    if updates:
        db.table("sched_appointment").update(updates).eq("id", appointment_id).execute()

    new_crew_id = old_crew_id
    if patch.crew_id and patch.crew_id != old_crew_id:
        new_crew_id = patch.crew_id
        if prim:
            db.table("sched_assignment").update({"crew_id": new_crew_id}).eq("id", prim["id"]).execute()
        else:
            db.table("sched_assignment").insert({"org_id": ORG, "appointment_id": appointment_id,
                                                 "crew_id": new_crew_id, "is_primary": True}).execute()

    after = _one(db, "sched_appointment", appointment_id)
    new_date = (_dt(after.get("scheduled_start")).date().isoformat() if _dt(after.get("scheduled_start")) else old_date)

    db.table("sched_audit_event").insert({
        "org_id": ORG, "actor_id": str(user.get("id") or ""), "entity_type": "appointment",
        "entity_id": appointment_id, "action": "MOVE" if (patch.date or patch.crew_id) else "STATUS",
        "before_json": {"crew_id": old_crew_id, "date": old_date, "status": appt.get("status")},
        "after_json": {"crew_id": new_crew_id, "date": new_date, "status": after.get("status")},
        "request_id": patch.request_id,
    }).execute()

    return _affected_slice(db, after, (old_crew_id, old_date), (new_crew_id, new_date))


# ── M4: tray + bulk operations ───────────────────────────────────────────────

NOMINAL_CREW = CrewCapacityInput(28.0, 16.0, 9.0, 2)  # for tray crew-day estimates
BULK_OPS = {"REASSIGN", "MOVE_TO_DATE", "SHIFT_DAYS", "MOVE", "SET_STATUS", "ADD_TAG", "WAIVE_TRIP", "UNASSIGN"}


def _primary_crew(db, appointment_id):
    r = (db.table("sched_assignment").select("*").eq("org_id", ORG)
         .eq("appointment_id", appointment_id).eq("is_primary", True).limit(1).execute().data or [None])[0]
    return r


def _tray_row(job, appt, customers, properties, tags_by_job, tag_map, today):
    cust = customers.get(job["customer_id"])
    prop = properties.get(job["property_id"])
    est = compute_crew_days(_job_input(job), NOMINAL_CREW)
    age = None
    cdt = _dt(job.get("created_at"))
    if cdt:
        age = (today - cdt.date()).days
    return {
        "job_id": job["id"], "appointment_id": appt["id"] if appt else None,
        "job_number": job.get("job_number"), "job_type": job["job_type"], "status": job["status"],
        "priority": job["priority"], "customer": f"{cust['first_name']} {cust['last_name']}" if cust else "",
        "city": prop["city"] if prop else "", "squares": _f(job.get("squares")),
        "est_crew_days": est.crew_days, "is_estimated": est.is_estimated,
        "sold_amount": _f(job.get("sold_amount")), "age_days": age, "deadline": job.get("deadline"),
        "tags": [tag_map[t]["label"] for t in tags_by_job.get(job["id"], []) if t in tag_map],
    }


@router.get("/tray")
async def get_tray(user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    today = date.today()
    jobs = _rows(db.table("sched_job").select("*").eq("org_id", ORG).execute())
    appts = _rows(db.table("sched_appointment").select("*").eq("org_id", ORG).execute())
    appts_by_job = defaultdict(list)
    for a in appts:
        appts_by_job[a["job_id"]].append(a)
    customers = {c["id"]: c for c in _rows(db.table("sched_customer").select("*").eq("org_id", ORG).execute())}
    properties = {p["id"]: p for p in _rows(db.table("sched_property").select("*").eq("org_id", ORG).execute())}
    tag_map = {t["id"]: t for t in _rows(db.table("sched_job_tag").select("*").eq("org_id", ORG).execute())}
    tags_by_job = defaultdict(list)
    for l in _rows(db.table("sched_job_tag_link").select("*").eq("org_id", ORG).execute()):
        tags_by_job[l["job_id"]].append(l["tag_id"])

    def row(job, appt=None):
        return _tray_row(job, appt, customers, properties, tags_by_job, tag_map, today)

    unassigned, needs, on_hold, canceled = [], [], [], []
    for j in jobs:
        has_appt = len(appts_by_job.get(j["id"], [])) > 0
        if j["status"] == "ON_HOLD":
            on_hold.append(row(j))
        elif j["status"] == "CANCELED":
            canceled.append(row(j))
        else:
            if j.get("squares") is None and j["status"] != "COMPLETE":
                needs.append(row(j))
            if not has_appt and j["status"] in ("SOLD", "SCHEDULED"):
                unassigned.append(row(j))

    conflicts = []
    crews = {c["id"]: c for c in _rows(db.table("sched_crew").select("*").eq("org_id", ORG).execute())}
    appt_crew = {a["appointment_id"]: a["crew_id"] for a in _rows(db.table("sched_assignment").select("*").eq("org_id", ORG).execute()) if a.get("is_primary", True)}
    jobs_by_id = {j["id"]: j for j in jobs}
    for a in appts:
        if a["status"] in ("DONE", "CANCELED"):
            continue
        crew = crews.get(appt_crew.get(a["id"])); job = jobs_by_id.get(a["job_id"])
        sdt = _dt(a.get("scheduled_start"))
        if not crew or not job or not sdt:
            continue
        ev = _evaluate_move(db, a, job, crew, sdt.date().isoformat())
        if ev["conflicts"]:
            r = row(job, a); r["conflicts"] = ev["conflicts"]; conflicts.append(r)

    return {"unassigned": unassigned, "needs_measurements": needs, "on_hold": on_hold, "conflicts": conflicts, "canceled": canceled}


def _target_for(op, payload, cur_crew, cur_date):
    if op == "REASSIGN":
        return payload.get("crew_id") or cur_crew, cur_date, True
    if op == "MOVE_TO_DATE":
        return cur_crew, payload.get("date") or cur_date, True
    if op == "SHIFT_DAYS":
        if not cur_date:
            return cur_crew, cur_date, True
        nd = (date.fromisoformat(cur_date) + timedelta(days=int(payload.get("days") or 0))).isoformat()
        return cur_crew, nd, True
    if op == "MOVE":  # explicit crew AND date, used by the weather-reschedule planner
        return payload.get("crew_id") or cur_crew, payload.get("date") or cur_date, True
    return cur_crew, cur_date, False


class BulkOp(BaseModel):
    ids: list
    op: str
    payload: dict = {}
    dry_run: bool = False


def _apply_op_single(db, aid, op, payload, actor, batch_id):
    appt = _one(db, "sched_appointment", aid)
    if not appt:
        return set()
    prim = _primary_crew(db, aid)
    cur_crew = prim["crew_id"] if prim else None
    sdt = _dt(appt.get("scheduled_start"))
    cur_date = sdt.date().isoformat() if sdt else None
    before = {"crew_id": cur_crew, "date": cur_date, "status": appt.get("status")}
    after = dict(before)
    touched = set()

    if op in ("REASSIGN", "MOVE_TO_DATE", "SHIFT_DAYS", "MOVE"):
        tgt_crew, tgt_date, _m = _target_for(op, payload, cur_crew, cur_date)
        if tgt_date != cur_date and sdt:
            edt = _dt(appt.get("scheduled_end")); nd = date.fromisoformat(tgt_date)
            st = naive_dt(nd, sdt.strftime("%H:%M")); en = naive_dt(nd, edt.strftime("%H:%M")) if edt else st
            db.table("sched_appointment").update({"scheduled_start": st.isoformat(), "scheduled_end": en.isoformat()}).eq("id", aid).execute()
        if tgt_crew and tgt_crew != cur_crew:
            if prim:
                db.table("sched_assignment").update({"crew_id": tgt_crew}).eq("id", prim["id"]).execute()
            else:
                db.table("sched_assignment").insert({"org_id": ORG, "appointment_id": aid, "crew_id": tgt_crew, "is_primary": True}).execute()
        after = {"crew_id": tgt_crew, "date": tgt_date, "status": appt.get("status")}
        for cd in ((cur_crew, cur_date), (tgt_crew, tgt_date)):
            if cd[0] and cd[1]:
                touched.add(cd)
    elif op == "SET_STATUS":
        stt = payload.get("status")
        if stt in VALID_STATUS:
            db.table("sched_appointment").update({"status": stt}).eq("id", aid).execute()
            after["status"] = stt
        if cur_crew and cur_date:
            touched.add((cur_crew, cur_date))
    elif op == "UNASSIGN":
        if prim:
            db.table("sched_assignment").delete().eq("id", prim["id"]).execute()
        db.table("sched_appointment").update({"status": "UNASSIGNED"}).eq("id", aid).execute()
        after = {"crew_id": None, "date": cur_date, "status": "UNASSIGNED"}
        if cur_crew and cur_date:
            touched.add((cur_crew, cur_date))
    elif op == "WAIVE_TRIP":
        db.table("sched_appointment").update({"waive_trip_fee": True}).eq("id", aid).execute()
    elif op == "ADD_TAG":
        tag_id = payload.get("tag_id")
        if tag_id:
            try:
                db.table("sched_job_tag_link").upsert({"org_id": ORG, "job_id": appt["job_id"], "tag_id": tag_id}).execute()
            except Exception:
                pass

    db.table("sched_audit_event").insert({
        "org_id": ORG, "actor_id": str(actor or ""), "entity_type": "appointment", "entity_id": aid,
        "action": "BULK_" + op, "before_json": before, "after_json": after, "request_id": batch_id,
    }).execute()
    return touched


def _affected_multi(db, touched, appt_ids):
    day_loads = {}
    for (cid, ds) in touched:
        crew = _one(db, "sched_crew", cid)
        if crew:
            day_loads[f"{cid}:{ds}"] = _day_load_dict(db, crew, ds)
    appts = _rows(db.table("sched_appointment").select("*").eq("org_id", ORG).in_("id", list(appt_ids)).execute()) if appt_ids else []
    ac = {}
    if appt_ids:
        for a in _rows(db.table("sched_assignment").select("*").eq("org_id", ORG).in_("appointment_id", list(appt_ids)).execute()):
            if a.get("is_primary", True):
                ac[a["appointment_id"]] = a["crew_id"]
    return {"appointments": appts, "day_loads": day_loads, "appointment_crew": ac}


@router.post("/bulk")
async def bulk(body: BulkOp, user: dict = Depends(require_user)) -> dict:
    if body.op not in BULK_OPS:
        raise HTTPException(status_code=400, detail=f"Unknown op '{body.op}'.")
    db = get_supabase()
    conflicts: dict = {}
    changes = []
    for aid in body.ids:
        appt = _one(db, "sched_appointment", aid)
        if not appt:
            continue
        job = _one(db, "sched_job", appt["job_id"])
        prim = _primary_crew(db, aid)
        cur_crew = prim["crew_id"] if prim else None
        sdt = _dt(appt.get("scheduled_start"))
        cur_date = sdt.date().isoformat() if sdt else None
        tgt_crew, tgt_date, is_move = _target_for(body.op, body.payload, cur_crew, cur_date)
        entry = {"id": aid, "job_number": job.get("job_number") if job else None,
                 "from": {"crew_id": cur_crew, "date": cur_date}, "to": {"crew_id": tgt_crew, "date": tgt_date}}
        if is_move and job and tgt_crew:
            crew = _one(db, "sched_crew", tgt_crew)
            if crew:
                ev = _evaluate_move(db, appt, job, crew, tgt_date)
                entry["conflicts"] = ev["conflicts"]
                blocks = [c for c in ev["conflicts"] if c["severity"] == "BLOCK"]
                if blocks:
                    conflicts[aid] = blocks
        changes.append(entry)

    if body.dry_run:
        return {"applied": False, "dry_run": True, "op": body.op, "changes": changes, "conflicts": conflicts}
    if conflicts:  # transactional: all-or-nothing on any BLOCK
        return {"applied": False, "op": body.op, "changes": changes, "conflicts": conflicts}

    batch_id = str(uuid.uuid4())
    touched = set(); ids = set()
    for aid in body.ids:
        touched |= _apply_op_single(db, aid, body.op, body.payload, user.get("id"), batch_id)
        ids.add(aid)
    return {"applied": True, "batch_id": batch_id, "affected": _affected_multi(db, touched, ids)}


class BulkUndo(BaseModel):
    batch_id: str


@router.post("/bulk/undo")
async def bulk_undo(body: BulkUndo, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    events = _rows(db.table("sched_audit_event").select("*").eq("org_id", ORG).eq("request_id", body.batch_id).execute())
    if not events:
        raise HTTPException(status_code=404, detail="Nothing to undo.")
    undo_batch = str(uuid.uuid4())
    touched = set(); ids = set()
    for e in events:
        aid = e["entity_id"]; before = e.get("before_json") or {}; after = e.get("after_json") or {}
        appt = _one(db, "sched_appointment", aid)
        if not appt:
            continue
        sdt = _dt(appt.get("scheduled_start"))
        if before.get("date") and sdt and before["date"] != sdt.date().isoformat():
            edt = _dt(appt.get("scheduled_end")); nd = date.fromisoformat(before["date"])
            st = naive_dt(nd, sdt.strftime("%H:%M")); en = naive_dt(nd, edt.strftime("%H:%M")) if edt else st
            db.table("sched_appointment").update({"scheduled_start": st.isoformat(), "scheduled_end": en.isoformat()}).eq("id", aid).execute()
        if before.get("status"):
            db.table("sched_appointment").update({"status": before["status"]}).eq("id", aid).execute()
        bc = before.get("crew_id")
        prim = _primary_crew(db, aid)
        if bc:
            if prim and prim["crew_id"] != bc:
                db.table("sched_assignment").update({"crew_id": bc}).eq("id", prim["id"]).execute()
            elif not prim:
                db.table("sched_assignment").insert({"org_id": ORG, "appointment_id": aid, "crew_id": bc, "is_primary": True}).execute()
            if before.get("date"):
                touched.add((bc, before["date"]))
        if after.get("crew_id") and after.get("date"):
            touched.add((after["crew_id"], after["date"]))
        ids.add(aid)
        db.table("sched_audit_event").insert({"org_id": ORG, "actor_id": str(user.get("id") or ""), "entity_type": "appointment",
                                              "entity_id": aid, "action": "UNDO", "before_json": after, "after_json": before, "request_id": undo_batch}).execute()
    return {"applied": True, "affected": _affected_multi(db, {t for t in touched if t[0] and t[1]}, ids)}


class CreateAppt(BaseModel):
    job_id: str
    crew_id: str
    date: str
    planned_squares: Optional[float] = None
    request_id: Optional[str] = None


@router.post("/appointments")
async def create_appointment(body: CreateAppt, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    job = _one(db, "sched_job", body.job_id)
    crew = _one(db, "sched_crew", body.crew_id)
    if not job or not crew:
        raise HTTPException(status_code=404, detail="Job or crew not found.")
    nd = _parse_date(body.date, "date")
    start = naive_dt(nd, "07:00"); end = naive_dt(nd, "15:00")
    ps = body.planned_squares if body.planned_squares is not None else _f(job.get("squares"))
    ins = db.table("sched_appointment").insert({
        "org_id": ORG, "job_id": body.job_id, "sequence": 1, "total_in_series": 1,
        "scheduled_start": start.isoformat(), "scheduled_end": end.isoformat(),
        "status": "SCHEDULED", "planned_squares": ps, "waive_trip_fee": False,
    }).execute()
    appt = (ins.data or [None])[0]
    if not appt:
        raise HTTPException(status_code=500, detail="Could not create the appointment.")
    db.table("sched_assignment").insert({"org_id": ORG, "appointment_id": appt["id"], "crew_id": body.crew_id, "is_primary": True}).execute()
    if job.get("status") == "SOLD":
        db.table("sched_job").update({"status": "SCHEDULED"}).eq("id", body.job_id).execute()
    db.table("sched_audit_event").insert({"org_id": ORG, "actor_id": str(user.get("id") or ""), "entity_type": "appointment",
                                          "entity_id": appt["id"], "action": "CREATE", "before_json": None,
                                          "after_json": {"crew_id": body.crew_id, "date": body.date}, "request_id": body.request_id}).execute()
    return _affected_slice(db, appt, None, (body.crew_id, body.date))


# ── M5: weather impact + one-click reschedule ────────────────────────────────

RISK_THRESHOLD = 60        # precip % that makes a day a weather risk
RESCHEDULE_HORIZON = 21    # days forward the planner will search for a dry slot
IDEAL_UTIL = 95.0          # prefer landing at or under this
MAX_UTIL = 110.0           # never suggest a slot that overbooks past this


def _date_precip(db, date_str: str) -> Optional[float]:
    wx = db.table("sched_weather_day").select("*").eq("date", date_str).execute().data or []
    if not wx:
        return None
    wx = sorted(wx, key=lambda w: 0 if w.get("postal_prefix") == "284" else 1)
    return _f(wx[0].get("precip_probability"))


def _date_is_risky(db, date_str: str) -> bool:
    p = _date_precip(db, date_str)
    return p is not None and p >= RISK_THRESHOLD


def _suggest_moves(db, appt_ids: list, horizon: int = RESCHEDULE_HORIZON) -> list:
    """For each rained-out appointment, find the earliest dry crew-day that fits.
    Keeps a running projection of squares it has already re-parked so it spreads
    the day's work across the week instead of stacking it all onto one Tuesday.
    Same crew only (skill/rig continuity); alternate-crew search is future work."""
    projected: dict = defaultdict(float)
    out = []
    for aid in appt_ids:
        appt = _one(db, "sched_appointment", aid)
        if not appt:
            continue
        job = _one(db, "sched_job", appt["job_id"])
        prim = _primary_crew(db, aid)
        crew = _one(db, "sched_crew", prim["crew_id"]) if prim else None
        sdt = _dt(appt.get("scheduled_start"))
        cur_date = sdt.date().isoformat() if sdt else None
        entry = {"appointment_id": aid, "job_number": job.get("job_number") if job else None,
                 "job_type": job.get("job_type") if job else None,
                 "from": {"crew_id": prim["crew_id"] if prim else None, "date": cur_date},
                 "to": None, "resulting_state": None, "resulting_pct": None, "ok": False, "reason": ""}
        if not (job and crew and cur_date):
            entry["reason"] = "No crew or date to plan from."
            out.append(entry)
            continue
        sq = _f(job.get("squares")) or 0.0
        d0 = date.fromisoformat(cur_date)
        ideal = None; fit = None
        for k in range(1, horizon + 1):
            cds = (d0 + timedelta(days=k)).isoformat()
            if _date_is_risky(db, cds):
                continue
            ev = _evaluate_move(db, appt, job, crew, cds)
            if any(c["severity"] == "BLOCK" for c in ev["conflicts"]):
                continue
            cap = _f(ev.get("capacity_squares")) or 0.0
            if cap <= 0:
                continue
            planned = _f(ev.get("resulting_planned_squares")) or 0.0
            util = (planned + projected[(crew["id"], cds)]) / cap * 100.0
            cand = {"crew_id": crew["id"], "date": cds, "util": round(util, 1),
                    "state": ev.get("resulting_state"), "warns": [c["message"] for c in ev["conflicts"] if c["severity"] == "WARN"]}
            if util <= MAX_UTIL and fit is None:
                fit = cand
            if util <= IDEAL_UTIL:
                ideal = cand
                break
        chosen = ideal or fit
        if chosen:
            projected[(chosen["crew_id"], chosen["date"])] += sq
            entry["to"] = {"crew_id": chosen["crew_id"], "date": chosen["date"]}
            entry["resulting_state"] = chosen["state"]
            entry["resulting_pct"] = chosen["util"]
            entry["ok"] = True
            entry["reason"] = "Next dry day with room." if chosen is ideal else "Next dry day (runs tight)."
            if chosen.get("warns"):
                entry["reason"] += " " + " · ".join(chosen["warns"][:2])
        else:
            entry["reason"] = f"No dry, unblocked slot within {horizon} days — needs a manual call."
        out.append(entry)
    return out


def _compute_weather_impact(db, s: date, e: date) -> dict:
    """Weather-exposed jobs on high-risk days in [s, e], each with a proposed dry
    slot. Shared by GET /weather/impact and the Copilot's Morning Brief."""
    appts = _rows(db.table("sched_appointment").select("*").eq("org_id", ORG)
                  .gte("scheduled_start", s.isoformat()).lte("scheduled_start", (e + timedelta(days=1)).isoformat()).execute())
    appt_crew = {a["appointment_id"]: a["crew_id"] for a in _rows(db.table("sched_assignment").select("*").eq("org_id", ORG).execute()) if a.get("is_primary", True)}
    jobs = {j["id"]: j for j in _rows(db.table("sched_job").select("*").eq("org_id", ORG).execute())}

    risk_dates: dict = {}
    at_risk_ids = []
    for a in appts:
        if a.get("status") in ("DONE", "CANCELED"):
            continue
        sdt = _dt(a.get("scheduled_start"))
        if not sdt:
            continue
        ds = sdt.date().isoformat()
        job = jobs.get(a["job_id"])
        if not job or job.get("job_type") == "INSPECTION":  # interior/inspection isn't rained out
            continue
        if not _date_is_risky(db, ds):
            continue
        at_risk_ids.append(a["id"])
        bucket = risk_dates.setdefault(ds, {"date": ds, "precip_probability": _date_precip(db, ds), "appointments": []})
        bucket["appointments"].append({
            "appointment_id": a["id"], "crew_id": appt_crew.get(a["id"]),
            "job_number": job.get("job_number"), "job_type": job.get("job_type"),
            "squares": _f(job.get("squares")),
        })

    suggestions = _suggest_moves(db, at_risk_ids)
    return {
        "risk_days": [risk_dates[d] for d in sorted(risk_dates)],
        "at_risk_count": len(at_risk_ids),
        "suggestions": suggestions,
        "resolvable": sum(1 for s in suggestions if s["ok"]),
    }


@router.get("/weather/impact")
async def weather_impact(start: str, end: str, user: dict = Depends(require_user)) -> dict:
    """Which scheduled, weather-exposed jobs sit on a high-risk rain day in the
    range — and a proposed dry-day home for each. The apply path is POST /reschedule."""
    db = get_supabase()
    return _compute_weather_impact(db, _parse_date(start, "start"), _parse_date(end, "end"))


class Move(BaseModel):
    appointment_id: str
    crew_id: str
    date: str


class Reschedule(BaseModel):
    moves: list
    dry_run: bool = False


@router.post("/reschedule")
async def reschedule(body: Reschedule, user: dict = Depends(require_user)) -> dict:
    """Apply a set of explicit per-job moves (the weather plan, or an edited one)
    as one transaction: validate every move, and if any BLOCKs, apply none and
    return the conflicts keyed by appointment id. Undo via POST /bulk/undo."""
    db = get_supabase()
    moves = [Move(**m) if not isinstance(m, Move) else m for m in body.moves]
    conflicts: dict = {}
    changes = []
    for m in moves:
        appt = _one(db, "sched_appointment", m.appointment_id)
        if not appt:
            continue
        job = _one(db, "sched_job", appt["job_id"])
        crew = _one(db, "sched_crew", m.crew_id)
        prim = _primary_crew(db, m.appointment_id)
        cur_crew = prim["crew_id"] if prim else None
        sdt = _dt(appt.get("scheduled_start"))
        cur_date = sdt.date().isoformat() if sdt else None
        entry = {"id": m.appointment_id, "job_number": job.get("job_number") if job else None,
                 "from": {"crew_id": cur_crew, "date": cur_date}, "to": {"crew_id": m.crew_id, "date": m.date}}
        if job and crew:
            ev = _evaluate_move(db, appt, job, crew, m.date)
            entry["conflicts"] = ev["conflicts"]
            blocks = [c for c in ev["conflicts"] if c["severity"] == "BLOCK"]
            if blocks:
                conflicts[m.appointment_id] = blocks
        changes.append(entry)

    if body.dry_run:
        return {"applied": False, "dry_run": True, "changes": changes, "conflicts": conflicts}
    if conflicts:
        return {"applied": False, "changes": changes, "conflicts": conflicts}

    batch_id = str(uuid.uuid4())
    touched = set(); ids = set()
    for m in moves:
        touched |= _apply_op_single(db, m.appointment_id, "MOVE", {"crew_id": m.crew_id, "date": m.date}, user.get("id"), batch_id)
        ids.add(m.appointment_id)
    return {"applied": True, "batch_id": batch_id, "affected": _affected_multi(db, touched, ids)}


# ── M6: audit trail ──────────────────────────────────────────────────────────

def _audit_summary(e: dict, job_number, crew_name: dict) -> str:
    before, after = e.get("before_json") or {}, e.get("after_json") or {}
    action = e.get("action") or ""
    jn = f"#{job_number}" if job_number else "a job"

    def where(d: dict) -> str:
        c = crew_name.get(d.get("crew_id"), "unassigned") if d.get("crew_id") else "unassigned"
        return f"{c} {d['date'][5:]}" if d.get("date") else c

    if e.get("entity_type") == "crew" or action == "CAPACITY_UPDATE":
        return f"{crew_name.get(e.get('entity_id'), 'A crew')} capacity {before.get('squares_per_day')} → {after.get('squares_per_day')} sq/day"
    if action == "CREATE":
        return f"Scheduled {jn} on {where(after)}"
    if action == "UNDO":
        return f"Reverted {jn} to {where(after)}"
    if action.startswith("BULK_SET_STATUS") or action == "SET_STATUS" or (before.get("status") and after.get("status") and before["status"] != after["status"]):
        return f"{jn} status → {(after.get('status') or '').lower()}"
    if action.endswith("UNASSIGN"):
        return f"{jn} sent to the tray"
    if before.get("crew_id") != after.get("crew_id") or before.get("date") != after.get("date"):
        return f"Moved {jn}: {where(before)} → {where(after)}"
    return f"{action.replace('_', ' ').title()} · {jn}"


@router.get("/audit")
async def audit(limit: int = 50, appointment_id: Optional[str] = None, user: dict = Depends(require_user)) -> dict:
    """Recent scheduling changes — who moved what, when. Every board mutation
    already writes a sched_audit_event; this surfaces them with plain summaries."""
    db = get_supabase()
    q = db.table("sched_audit_event").select("*").eq("org_id", ORG).order("created_at", desc=True).limit(min(max(limit, 1), 200))
    if appointment_id:
        q = q.eq("entity_id", appointment_id)
    events = _rows(q.execute())

    appt_ids = list({e["entity_id"] for e in events if e.get("entity_type") == "appointment" and e.get("entity_id")})
    job_by_appt = {}
    if appt_ids:
        appts = _rows(db.table("sched_appointment").select("id,job_id").eq("org_id", ORG).in_("id", appt_ids).execute())
        jmap = {a["id"]: a["job_id"] for a in appts}
        jids = list({v for v in jmap.values() if v})
        jobs = {j["id"]: j for j in _rows(db.table("sched_job").select("id,job_number").eq("org_id", ORG).in_("id", jids).execute())} if jids else {}
        job_by_appt = {aid: jobs.get(jid, {}).get("job_number") for aid, jid in jmap.items()}
    crew_name = {c["id"]: c["name"] for c in _rows(db.table("sched_crew").select("id,name").eq("org_id", ORG).execute())}

    out = [{
        "id": e["id"], "created_at": e.get("created_at"), "action": e.get("action"),
        "entity_type": e.get("entity_type"), "entity_id": e.get("entity_id"),
        "actor_id": e.get("actor_id"), "job_number": job_by_appt.get(e.get("entity_id")),
        "summary": _audit_summary(e, job_by_appt.get(e.get("entity_id")), crew_name),
    } for e in events]
    return {"events": out}


# ── M5.5: Axis Copilot ───────────────────────────────────────────────────────
# Guardrail (docs/crew-scheduling-ai-layer.md A0): every NUMBER comes from the
# tested engine; the model only narrates, ranks, and compiles intent into the
# EXACT dry-run object a human action produces. There is no AI write path — apply
# always flows back through /bulk or /reschedule. Any AI surface degrades to a
# clean "unavailable" and the board stays fully operable.


# --- E. Throughput flywheel ---------------------------------------------------

def _completed_samples(db, crew_id: str) -> list:
    asg = _rows(db.table("sched_assignment").select("appointment_id").eq("org_id", ORG)
                .eq("crew_id", crew_id).eq("is_primary", True).execute())
    ids = [a["appointment_id"] for a in asg]
    if not ids:
        return []
    appts = _rows(db.table("sched_appointment").select("*").eq("org_id", ORG).in_("id", ids).eq("status", "DONE").execute())
    samples = []
    for a in appts:
        actual = _f(a.get("actual_squares"))
        if not actual or actual <= 0:
            continue
        st, en = _dt(a.get("started_at")), _dt(a.get("completed_at"))
        crew_days = max(1.0, float((en.date() - st.date()).days + 1)) if (st and en) else 1.0
        samples.append(ThroughputSample(a["id"], actual, crew_days))
    return samples


@router.get("/ai/throughput-review")
async def throughput_review(user: dict = Depends(require_user)) -> dict:
    """The flywheel: from completed jobs' actuals, which crews' configured capacity
    the evidence says should change. Fully deterministic; needs no model."""
    db = get_supabase()
    crews = _rows(db.table("sched_crew").select("*").eq("org_id", ORG).execute())
    suggestions, watching = [], []
    for c in crews:
        v = analyze_crew_throughput(c["id"], c["name"], _f(c.get("squares_per_day")) or 0.0, _completed_samples(db, c["id"]))
        row = {"crew_id": v.crew_id, "crew_name": v.crew_name, "configured_sqpd": v.configured_sqpd,
               "observed_sqpd": v.observed_sqpd, "sample_size": v.sample_size, "delta_pct": v.delta_pct,
               "stable": v.stable, "suggested_sqpd": v.suggested_sqpd, "rationale": v.rationale}
        if v.recommend:
            suggestions.append(row)
        elif v.sample_size > 0:
            watching.append(row)
    return {"suggestions": suggestions, "watching": watching}


class ThroughputApply(BaseModel):
    crew_id: str
    squares_per_day: float


@router.post("/ai/throughput-apply")
async def throughput_apply(body: ThroughputApply, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    crew = _one(db, "sched_crew", body.crew_id)
    if not crew:
        raise HTTPException(status_code=404, detail="Crew not found.")
    before = _f(crew.get("squares_per_day"))
    db.table("sched_crew").update({"squares_per_day": body.squares_per_day}).eq("id", body.crew_id).execute()
    db.table("sched_audit_event").insert({"org_id": ORG, "actor_id": str(user.get("id") or ""), "entity_type": "crew",
        "entity_id": body.crew_id, "action": "CAPACITY_UPDATE", "before_json": {"squares_per_day": before},
        "after_json": {"squares_per_day": body.squares_per_day}, "request_id": str(uuid.uuid4())}).execute()
    return {"applied": True, "crew_id": body.crew_id, "squares_per_day": body.squares_per_day}


# --- A/D. Morning Brief -------------------------------------------------------

async def _narrate_brief(brief: dict) -> str:
    facts = json.dumps({"load": [i["text"] for i in brief["load"]],
                        "gaps": [i["text"] for i in brief["gaps"]],
                        "risk": [i["text"] for i in brief["risk"]]})
    system = ("You are the dispatch assistant for a roofing company. Write a tight 2-3 sentence morning brief "
              "using ONLY the facts provided. Never invent numbers, crew names, or jobs. Lead with the most urgent "
              "item. Plain, confident, no greetings, no fluff.")
    out = (await llm_text(f"Facts (JSON):\n{facts}\n\nWrite the brief:", system=system, max_tokens=300)).strip()
    if not out or len(out) > 900:
        raise ValueError("unusable narration")
    return out


@router.get("/ai/brief")
async def ai_brief(start: str, end: str, narrate: bool = True, user: dict = Depends(require_user)) -> dict:
    """The 6:30am read: who's over/idle, what still needs placing, what breaks.
    Every fact is engine-computed; the model only turns them into a paragraph and
    degrades to a deterministic one if it's unavailable."""
    db = get_supabase()
    s = _parse_date(start, "start"); e = _parse_date(end, "end")
    days = []
    d = s
    while d <= e:
        days.append(d.isoformat()); d += timedelta(days=1)
    crews = _rows(db.table("sched_crew").select("*").eq("org_id", ORG).execute())

    overbooked, idle = [], []
    for c in crews:
        for ds in days:
            load = _day_load_dict(db, c, ds)
            if load["available_hours"] <= 0:
                continue
            if load["state"] == "OVERBOOKED":
                overbooked.append({"crew_id": c["id"], "crew_name": c["name"], "date": ds, "utilization_pct": load["utilization_pct"]})
            elif load["state"] == "IDLE":
                idle.append({"crew_id": c["id"], "crew_name": c["name"], "date": ds})

    all_appts = _rows(db.table("sched_appointment").select("*").eq("org_id", ORG).execute())
    scheduled_ids = {a["job_id"] for a in all_appts}
    by_job = defaultdict(list)
    for a in all_appts:
        by_job[a["job_id"]].append(a)
    jobs = _rows(db.table("sched_job").select("*").eq("org_id", ORG).execute())

    gaps = [{"job_id": j["id"], "job_number": j.get("job_number"), "label": _label(j.get("job_type")), "best": None}
            for j in jobs if j["id"] not in scheduled_ids and j.get("status") in ("SOLD", "SCHEDULED")]

    impact = _compute_weather_impact(db, s, e)
    weather_risks = [{"date": r["date"], "precip": _f(r["precip_probability"]) or 0.0, "count": len(r["appointments"]),
                      "resolvable": sum(1 for sg in impact["suggestions"] if sg["ok"] and sg["from"]["date"] == r["date"])}
                     for r in impact["risk_days"]]

    series_risks = []
    for jid, arr in by_job.items():
        if len(arr) < 2:
            continue
        ds_list = sorted([_dt(a["scheduled_start"]).date() for a in arr if _dt(a.get("scheduled_start"))])
        if not ds_list or ds_list[-1] < s or ds_list[0] > e:
            continue
        if any((ds_list[i + 1] - ds_list[i]).days > 3 for i in range(len(ds_list) - 1)):
            job = _one(db, "sched_job", jid)
            series_risks.append({"appointment_id": arr[0]["id"], "job_number": job.get("job_number") if job else None,
                                 "text": f"#{job.get('job_number') if job else '?'} is a split series with a broken gap between days."})

    deadline_risks = []
    for j in jobs:
        dl = j.get("deadline")
        if not dl:
            continue
        try:
            dld = date.fromisoformat(str(dl)[:10])
        except ValueError:
            continue
        arr = by_job.get(j["id"], [])
        if arr:
            last = max([_dt(a["scheduled_start"]).date() for a in arr if _dt(a.get("scheduled_start"))], default=None)
            if last and last > dld:
                deadline_risks.append({"job_id": j["id"], "job_number": j.get("job_number"),
                                       "text": f"#{j.get('job_number')} is scheduled past its {dld.isoformat()[5:]} deadline."})
        elif j.get("status") in ("SOLD", "SCHEDULED") and s <= dld <= e:
            deadline_risks.append({"job_id": j["id"], "job_number": j.get("job_number"),
                                   "text": f"#{j.get('job_number')} is unscheduled with a {dld.isoformat()[5:]} deadline."})

    inp = BriefInputs(date=s.isoformat(), overbooked=overbooked, idle=idle[:6], gaps=gaps[:12],
                      weather_risks=weather_risks, series_risks=series_risks[:5], deadline_risks=deadline_risks[:6])
    brief = assemble_brief(inp)

    narrated = False
    prose = templated_prose(brief)
    if narrate:
        try:
            prose = await _narrate_brief(brief); narrated = True
        except Exception:
            prose = templated_prose(brief)
    brief["prose"] = prose
    brief["narrated"] = narrated
    return brief


# --- C. Natural-language dispatch (⌘K) ----------------------------------------

PLAN_OPS = {"REASSIGN", "MOVE_TO_DATE", "MOVE", "SET_STATUS", "UNASSIGN", "RESCHEDULE_WEATHER"}


def _plan_snapshot(db, s: date, e: date) -> dict:
    crews = _rows(db.table("sched_crew").select("*").eq("org_id", ORG).execute())
    appts = _rows(db.table("sched_appointment").select("*").eq("org_id", ORG)
                  .gte("scheduled_start", s.isoformat()).lte("scheduled_start", (e + timedelta(days=1)).isoformat()).execute())
    appt_crew = {a["appointment_id"]: a["crew_id"] for a in _rows(db.table("sched_assignment").select("*").eq("org_id", ORG).execute()) if a.get("is_primary", True)}
    jobs = {j["id"]: j for j in _rows(db.table("sched_job").select("*").eq("org_id", ORG).execute())}
    crew_name = {c["id"]: c["name"] for c in crews}
    rows = []
    for a in appts:
        if a.get("status") == "CANCELED":
            continue
        job = jobs.get(a["job_id"]); sdt = _dt(a.get("scheduled_start"))
        rows.append({"appointment_id": a["id"], "job_number": job.get("job_number") if job else None,
                     "job_type": job.get("job_type") if job else None, "crew_id": appt_crew.get(a["id"]),
                     "crew_name": crew_name.get(appt_crew.get(a["id"]), ""),
                     "date": sdt.date().isoformat() if sdt else None, "status": a.get("status"),
                     "squares": _f(job.get("squares")) if job else None})
    impact = _compute_weather_impact(db, s, e)
    return {
        "date_range": {"start": s.isoformat(), "end": e.isoformat()},
        "crews": [{"crew_id": c["id"], "name": c["name"]} for c in crews],
        "appointments": rows,
        "rain_days": [r["date"] for r in impact["risk_days"]],
        "allowed_ops": sorted(PLAN_OPS),
    }


async def _compile_intent(intent: str, snapshot: dict) -> dict:
    system = (
        "You compile a roofing dispatcher's plain-English request into ONE safe scheduling action. "
        "Output ONLY JSON, no prose. Schema: {\"op\": <allowed_op>, \"ids\": [appointment_id...], "
        "\"payload\": {...}, \"summary\": \"<one short sentence>\"}. Rules: "
        "ids MUST be appointment_id strings copied verbatim from the snapshot — NEVER invent ids. "
        "REASSIGN payload {\"crew_id\": <crew_id from snapshot>}. "
        "MOVE_TO_DATE payload {\"date\": \"YYYY-MM-DD\"}. "
        "MOVE payload {\"crew_id\": <crew_id>, \"date\": \"YYYY-MM-DD\"}. "
        "SET_STATUS payload {\"status\": one of SCHEDULED|DISPATCHED|HOLD|CANCELED}. "
        "UNASSIGN payload {}. "
        "RESCHEDULE_WEATHER (move rained-out jobs to dry slots) uses ids [] and payload {}. "
        "If you cannot map the request safely and unambiguously, output {\"op\": \"NONE\"}."
    )
    raw = await llm_text(f"BOARD SNAPSHOT (JSON):\n{json.dumps(snapshot)}\n\nDISPATCHER INTENT:\n{intent}\n\nPlan JSON:",
                         system=system, max_tokens=1200, json_mode=True)
    return parse_plan_json(raw)


def _dry_run_moves(db, moves: list) -> tuple:
    """Validate explicit per-appointment moves through the same engine the human
    path uses. Returns (changes, conflicts-keyed-by-id)."""
    conflicts, changes = {}, []
    for m in moves:
        aid = m.get("appointment_id")
        appt = _one(db, "sched_appointment", aid) if aid else None
        if not appt:
            continue
        job = _one(db, "sched_job", appt["job_id"])
        prim = _primary_crew(db, aid); cur_crew = prim["crew_id"] if prim else None
        sdt = _dt(appt.get("scheduled_start")); cur_date = sdt.date().isoformat() if sdt else None
        tgt_crew = m.get("crew_id") or cur_crew; tgt_date = m.get("date") or cur_date
        entry = {"id": aid, "job_number": job.get("job_number") if job else None,
                 "from": {"crew_id": cur_crew, "date": cur_date}, "to": {"crew_id": tgt_crew, "date": tgt_date}}
        crew = _one(db, "sched_crew", tgt_crew) if tgt_crew else None
        if job and crew and tgt_date:
            ev = _evaluate_move(db, appt, job, crew, tgt_date)
            entry["conflicts"] = ev["conflicts"]
            blocks = [c for c in ev["conflicts"] if c["severity"] == "BLOCK"]
            if blocks:
                conflicts[aid] = blocks
        changes.append(entry)
    return changes, conflicts


class PlanReq(BaseModel):
    intent: str
    start: str
    end: str


@router.post("/ai/plan")
async def ai_plan(body: PlanReq, user: dict = Depends(require_user)) -> dict:
    """Compile intent into a dry-run the human approves. NEVER writes — the client
    applies the returned plan through the existing /bulk or /reschedule endpoints."""
    db = get_supabase()
    s = _parse_date(body.start, "start"); e = _parse_date(body.end, "end")
    snapshot = _plan_snapshot(db, s, e)
    try:
        plan = await _compile_intent(body.intent, snapshot)
    except Exception as ex:  # model down / all providers failed
        return {"ok": False, "reason": "The Copilot is unavailable right now — you can still schedule by hand.",
                "detail": str(ex)[:200]}

    op = (plan or {}).get("op")
    if not op or op not in PLAN_OPS:
        return {"ok": False, "reason": "Couldn't turn that into a safe action. Try naming the jobs, a crew, or a day."}

    # Weather special-case → the deterministic reschedule plan.
    if op == "RESCHEDULE_WEATHER":
        impact = _compute_weather_impact(db, s, e)
        moves = [{"appointment_id": sg["appointment_id"], "crew_id": sg["to"]["crew_id"], "date": sg["to"]["date"]}
                 for sg in impact["suggestions"] if sg["ok"] and sg.get("to")]
        if not moves:
            return {"ok": False, "reason": "No rained-out jobs have a dry slot to move to."}
        changes, conflicts = _dry_run_moves(db, moves)
        return {"ok": True, "kind": "reschedule", "intent": body.intent,
                "summary": plan.get("summary") or f"Move {len(moves)} rained-out job(s) to a dry slot.",
                "moves": moves, "changes": changes, "conflicts": conflicts}

    # Standard bulk op. Validate ids/crew against the snapshot — drop anything invented.
    snap_ids = {r["appointment_id"] for r in snapshot["appointments"]}
    snap_crews = {c["crew_id"] for c in snapshot["crews"]}
    ids = [i for i in (plan.get("ids") or []) if isinstance(i, str) and i in snap_ids]
    if not ids:
        return {"ok": False, "reason": "Couldn't identify which jobs you meant. Name the job numbers, crew, or day."}
    payload = plan.get("payload") or {}
    if op in ("REASSIGN", "MOVE") and payload.get("crew_id") not in snap_crews:
        return {"ok": False, "reason": "That crew isn't on this board."}
    if op == "SET_STATUS" and payload.get("status") not in VALID_STATUS:
        return {"ok": False, "reason": "That isn't a status I can set."}

    # Dry-run: move-type ops go through the engine; status/unassign have no conflicts.
    if op in ("REASSIGN", "MOVE", "MOVE_TO_DATE"):
        moves = [{"appointment_id": i, "crew_id": payload.get("crew_id"), "date": payload.get("date")} for i in ids]
        changes, conflicts = _dry_run_moves(db, moves)
    else:
        conflicts = {}
        changes = [{"id": i, "job_number": next((r["job_number"] for r in snapshot["appointments"] if r["appointment_id"] == i), None),
                    "from": {}, "to": {"status": payload.get("status")} if op == "SET_STATUS" else {"unassigned": True}} for i in ids]

    return {"ok": True, "kind": "bulk", "intent": body.intent, "op": op, "payload": payload, "ids": ids,
            "summary": plan.get("summary") or f"{op.replace('_', ' ').title()} · {len(ids)} job(s).",
            "changes": changes, "conflicts": conflicts}


# ── M7: dispatch ↔ project (see the real roof / report / photos from a job) ───
# Read-first integration: a sched_job.project_id points at the real roofing
# project. The board can open its satellite/outline, report, and crew photos.

_PHOTO_BUCKET = "blueprints"


def _project_addr(p: dict) -> Optional[str]:
    return ", ".join(x for x in [p.get("address"), p.get("city"), p.get("state")] if x) or None


# Everything the board can say about a roof without the dispatcher retyping it:
# the totals, the pitch/stories that drive crew-days, and the linear footage the
# materials list is built from.
_RUN_COLS = (
    "satellite_image_url,squares,facet_count,total_roof_sqft,total_plan_sqft,"
    "predominant_pitch,predominant_pitch_degrees,stories,roof_type,waste_pct_default,"
    "ridges_ft,hips_ft,valleys_ft,eaves_ft,rakes_ft,perimeter_ft,ridge_total_ft,"
    "confidence,confirmed,measurement_unverified,created_at"
)


def _latest_run(db, project_id: str, cols: str = _RUN_COLS) -> dict:
    r = _rows(db.table("roof_measurement_runs").select(cols)
              .eq("project_id", project_id).order("created_at", desc=True).limit(1).execute())
    return r[0] if r else {}


def _pitch_rise(v) -> Optional[float]:
    """Rise-over-12 as a number, from either "6/12" or a bare 6.

    `roof_measurement_runs.predominant_pitch` is free text; `sched_job` wants a
    numeric(3,1). A pitch on a different run (e.g. "9/16") is normalized to its
    equivalent rise over 12 so the crew-days multiplier stays comparable.
    """
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(" ", "")
    if not s:
        return None
    if "/" in s:
        rise, _, run = s.partition("/")
        r, u = _f(rise), _f(run)
        if r is None or not u:
            return None
        return round(r * 12.0 / u, 1)
    return _f(s)


def _signed_photo(db, path: str) -> Optional[str]:
    try:
        s = db.storage.from_(_PHOTO_BUCKET).create_signed_url(path, 3600)
        if isinstance(s, dict):
            return s.get("signedURL") or s.get("signedUrl") or s.get("signed_url") or s.get("url")
    except Exception:
        return None
    return None


@router.get("/projects/search")
async def dispatch_project_search(q: str = "", user: dict = Depends(require_user)) -> dict:
    """The logged-in contractor's projects, for linking a dispatch job to one."""
    db = get_supabase()
    rows = _rows(db.table("projects").select("id,name,address,city,state,status,created_at")
                 .eq("user_id", user["id"]).order("created_at", desc=True).limit(60).execute())
    ql = (q or "").strip().lower()
    if ql:
        rows = [r for r in rows if ql in (r.get("name") or "").lower()
                or ql in (r.get("address") or "").lower() or ql in (r.get("city") or "").lower()]
    out = []
    for r in rows[:15]:
        t = _latest_run(db, r["id"], "satellite_image_url,created_at")  # thumbnails only
        out.append({"id": r["id"], "name": r.get("name") or "Untitled project",
                    "address": _project_addr(r), "status": r.get("status"),
                    "thumbnail_url": t.get("satellite_image_url")})
    return {"projects": out}


class JobLink(BaseModel):
    project_id: Optional[str] = None


def _measurements_from_run(run: dict) -> dict:
    """The subset of a roof run that `sched_job` itself stores.

    Only keys the run actually has a value for — a project with no pitch on file
    must not blank out a pitch the dispatcher typed in by hand.
    """
    patch: dict = {}
    squares = _f(run.get("squares"))
    if squares is not None:
        patch["squares"] = round(squares, 2)
    pitch = _pitch_rise(run.get("predominant_pitch"))
    if pitch is not None:
        patch["predominant_pitch"] = pitch
    if run.get("stories") is not None:
        patch["stories"] = run["stories"]
    waste = _f(run.get("waste_pct_default"))
    if waste is not None:
        patch["waste_factor_pct"] = round(waste, 2)
    return patch


@router.patch("/jobs/{job_id}/link")
async def link_job_to_project(job_id: str, body: JobLink, user: dict = Depends(require_user)) -> dict:
    """Attach a job to a roofing project — and inherit its measurements.

    Linking is the moment the board learns the roof. We copy the latest run's
    squares/pitch/stories/waste onto the job so capacity math, the crew-days
    breakdown and the card all reflect the real roof immediately, instead of
    showing "no measurements" next to a project that has them. The audit event
    records the before/after, so an unwanted overwrite is visible and reversible.
    """
    db = get_supabase()
    job = _one(db, "sched_job", job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    update: dict = {"project_id": body.project_id}
    inherited: dict = {}
    if body.project_id:  # verify the project is the caller's before linking
        pr = _rows(db.table("projects").select("id,user_id").eq("id", body.project_id).limit(1).execute())
        if not pr or pr[0].get("user_id") != user.get("id"):
            raise HTTPException(status_code=404, detail="Project not found.")
        inherited = _measurements_from_run(_latest_run(db, body.project_id))
        update.update(inherited)

    db.table("sched_job").update(update).eq("id", job_id).execute()
    db.table("sched_audit_event").insert({"org_id": ORG, "actor_id": str(user.get("id") or ""), "entity_type": "job",
        "entity_id": job_id, "action": "LINK_PROJECT",
        "before_json": {"project_id": job.get("project_id"),
                        **{k: job.get(k) for k in inherited}},
        "after_json": {"project_id": body.project_id, **inherited},
        "request_id": str(uuid.uuid4())}).execute()
    return {"ok": True, "project_id": body.project_id, "inherited": inherited}


@router.get("/jobs/{job_id}/project")
async def get_job_project(job_id: str, user: dict = Depends(require_user)) -> dict:
    """The linked project's bundle for the job detail panel: roof tile + stats,
    recent crew photos (signed), and whether a report exists. `linked:false` when
    the job has no project attached yet."""
    db = get_supabase()
    job = _one(db, "sched_job", job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    pid = job.get("project_id")
    if not pid:
        return {"linked": False}
    pr = _rows(db.table("projects").select("id,name,address,city,state,status").eq("id", pid).limit(1).execute())
    if not pr:
        return {"linked": False}
    p = pr[0]
    run = _latest_run(db, pid)

    photos = []
    try:
        for x in _rows(db.table("project_photos").select("storage_path,caption,phase,created_at")
                       .eq("project_id", pid).order("created_at", desc=True).limit(6).execute()):
            url = _signed_photo(db, x["storage_path"])
            if url:
                photos.append({"url": url, "caption": x.get("caption"), "phase": x.get("phase")})
    except Exception:
        pass

    has_report = False
    try:
        has_report = bool(_rows(db.table("apir_reports").select("id").eq("project_id", pid).limit(1).execute()))
    except Exception:
        has_report = False

    share_token = None
    try:
        sh = _rows(db.table("project_photo_shares").select("token,enabled").eq("project_id", pid).limit(1).execute())
        if sh and sh[0].get("enabled"):
            share_token = sh[0].get("token")
    except Exception:
        share_token = None

    return {
        "linked": True,
        "project": {"id": p["id"], "name": p.get("name") or "Untitled project",
                    "status": p.get("status"), "address": _project_addr(p)},
        "thumbnail_url": run.get("satellite_image_url"),
        "squares": _f(run.get("squares")),
        "facet_count": run.get("facet_count"),
        "roof_sqft": _f(run.get("total_roof_sqft")),
        "plan_sqft": _f(run.get("total_plan_sqft")),
        # What the roof *is* — the dispatcher shouldn't have to open the project
        # to find out it's a 6/12 two-story.
        "pitch": run.get("predominant_pitch"),
        "pitch_rise": _pitch_rise(run.get("predominant_pitch")),
        "stories": run.get("stories"),
        "roof_type": run.get("roof_type"),
        "waste_pct": _f(run.get("waste_pct_default")),
        # Linear footage — the basis for ridge cap, drip edge, valley metal.
        "linear": {
            "ridges_ft": _f(run.get("ridges_ft")),
            "hips_ft": _f(run.get("hips_ft")),
            "valleys_ft": _f(run.get("valleys_ft")),
            "eaves_ft": _f(run.get("eaves_ft")),
            "rakes_ft": _f(run.get("rakes_ft")),
            "perimeter_ft": _f(run.get("perimeter_ft")),
            "ridge_total_ft": _f(run.get("ridge_total_ft")),
        },
        # How much to trust the numbers above.
        "confidence": _f(run.get("confidence")),
        "confirmed": bool(run.get("confirmed")),
        "measured_at": run.get("created_at"),
        "photos": photos,
        "has_report": has_report,
        "share_token": share_token,
    }


# ── M7: live per-crew weather (each crew sees the sky at its own job site) ─────

@router.get("/weather/live")
async def live_weather(start: str, end: str, user: dict = Depends(require_user)) -> dict:
    """Per-crew-day forecast from each crew's job location (Open-Meteo, free).
    Non-blocking companion to the board: the grid renders, this fills in the
    per-cell weather. Also returns a regional headline (centroid of the day's
    work). Best-effort — returns {} weather rather than erroring."""
    from app.services.scheduling import weather_service as wx

    db = get_supabase()
    s = _parse_date(start, "start"); e = _parse_date(end, "end")
    appts = _rows(db.table("sched_appointment").select("*").eq("org_id", ORG)
                  .gte("scheduled_start", s.isoformat()).lte("scheduled_start", (e + timedelta(days=1)).isoformat()).execute())
    appt_crew = {a["appointment_id"]: a["crew_id"] for a in _rows(db.table("sched_assignment").select("*").eq("org_id", ORG).execute()) if a.get("is_primary", True)}
    jobs = {j["id"]: j for j in _rows(db.table("sched_job").select("id,property_id").eq("org_id", ORG).execute())}
    props = {p["id"]: p for p in _rows(db.table("sched_property").select("id,lat,lng").eq("org_id", ORG).execute())}

    # Each crew's PRIMARY (earliest) located stop per date.
    crew_loc: dict[tuple, tuple] = {}
    for a in sorted(appts, key=lambda x: x.get("scheduled_start") or ""):
        crew_id = appt_crew.get(a["id"])
        sdt = _dt(a.get("scheduled_start"))
        if not crew_id or not sdt:
            continue
        job = jobs.get(a["job_id"]); prop = props.get(job["property_id"]) if job else None
        lat, lng = (_f(prop.get("lat")), _f(prop.get("lng"))) if prop else (None, None)
        key = (crew_id, sdt.date().isoformat())
        if lat and lng and key not in crew_loc:
            crew_loc[key] = (lat, lng)

    points = list(set(crew_loc.values()))
    if points:
        clat = sum(p[0] for p in points) / len(points)
        clng = sum(p[1] for p in points) / len(points)
    else:
        clat, clng = 34.2257, -77.9447   # Wilmington fallback for the headline
    points.append((clat, clng))

    fc = await wx.forecasts_for(points)

    def at(lat, lng, ds):
        return (fc.get(wx.bucket(lat, lng)) or {}).get(ds)

    crew_weather = {}
    for (crew_id, ds), (lat, lng) in crew_loc.items():
        w = at(lat, lng, ds)
        if w and w.get("precip_probability") is not None:
            crew_weather[f"{crew_id}:{ds}"] = w

    regional = {}
    d = s
    while d <= e:
        ds = d.isoformat()
        w = at(clat, clng, ds)
        if w and w.get("precip_probability") is not None:
            regional[ds] = w
        d += timedelta(days=1)

    return {"crew_weather": crew_weather, "regional": regional}


# ── M7: crew & time-off administration (add / edit / remove crews + PTO) ──────

def _generate_shifts(db, crew_id: str, weekdays: list, start_t: str, end_t: str, weeks: int) -> None:
    """Seed regular shifts so a new crew is immediately schedulable. Weekdays are
    0=Mon..6=Sun. Idempotent-ish: clears this crew's shifts in the horizon first."""
    today = date.today()
    horizon = today + timedelta(days=max(1, weeks) * 7)
    db.table("sched_shift").delete().eq("org_id", ORG).eq("crew_id", crew_id).gte("date", today.isoformat()).execute()
    rows = []
    d = today
    while d < horizon:
        if d.weekday() in weekdays:
            rows.append({"org_id": ORG, "crew_id": crew_id, "date": d.isoformat(),
                         "start_time": start_t, "end_time": end_t, "type": "REGULAR"})
        d += timedelta(days=1)
    for i in range(0, len(rows), 200):
        db.table("sched_shift").insert(rows[i:i + 200]).execute()


# ── Per-day shifts: a crew works a day, or it doesn't ────────────────────────
# Until now the only way to change a working day was to re-pick the crew's
# weekday pattern, which wiped and regenerated every future shift. Toggling one
# day meant rebuilding the whole horizon, so dispatchers left it alone.

DEFAULT_SHIFT = ("07:00", "15:30")


def _crew_shift_times(db, crew_id: str) -> tuple[str, str]:
    """Reuse this crew's usual hours so an added day matches the rest."""
    try:
        r = _rows(db.table("sched_shift").select("start_time,end_time")
                  .eq("org_id", ORG).eq("crew_id", crew_id)
                  .order("date", desc=True).limit(1).execute())
        if r:
            return (r[0].get("start_time") or DEFAULT_SHIFT[0],
                    r[0].get("end_time") or DEFAULT_SHIFT[1])
    except Exception:
        logger.debug("shift time lookup failed for %s", crew_id, exc_info=True)
    return DEFAULT_SHIFT


@router.put("/crews/{crew_id}/shifts/{day}")
async def add_shift(crew_id: str, day: str, user: dict = Depends(require_user)) -> dict:
    """Give this crew a working day. Idempotent — pressing + twice is harmless."""
    db = get_supabase()
    if not _one(db, "sched_crew", crew_id):
        raise HTTPException(status_code=404, detail="Crew not found.")
    try:
        date.fromisoformat(day)
    except ValueError:
        raise HTTPException(status_code=400, detail="Date must be YYYY-MM-DD.")
    existing = _rows(db.table("sched_shift").select("id")
                     .eq("org_id", ORG).eq("crew_id", crew_id).eq("date", day).execute())
    if existing:
        return {"ok": True, "created": False, "date": day}
    start_t, end_t = _crew_shift_times(db, crew_id)
    db.table("sched_shift").insert({
        "org_id": ORG, "crew_id": crew_id, "date": day,
        "start_time": start_t, "end_time": end_t, "type": "REGULAR"}).execute()
    return {"ok": True, "created": True, "date": day, "start_time": start_t, "end_time": end_t}


@router.delete("/crews/{crew_id}/shifts/{day}")
async def remove_shift(crew_id: str, day: str, user: dict = Depends(require_user)) -> dict:
    """Take a working day away — refused while work is still booked on it, since
    removing the shift would leave the job assigned to a crew that isn't working."""
    db = get_supabase()
    if not _one(db, "sched_crew", crew_id):
        raise HTTPException(status_code=404, detail="Crew not found.")
    appt_ids = [a["appointment_id"] for a in
                _rows(db.table("sched_assignment").select("appointment_id")
                      .eq("org_id", ORG).eq("crew_id", crew_id).execute())
                if a.get("appointment_id")]
    if appt_ids:
        booked = [r for r in _rows(db.table("sched_appointment")
                                   .select("id,scheduled_start,status").in_("id", appt_ids).execute())
                  if (r.get("scheduled_start") or "")[:10] == day
                  and (r.get("status") or "").strip().upper() not in RELEASED_STATUSES]
        if booked:
            n = len(booked)
            raise HTTPException(status_code=409, detail=(
                f"{n} job{'' if n == 1 else 's'} still booked on {day}. "
                f"Move {'it' if n == 1 else 'them'} to another day or crew first."))
    db.table("sched_shift").delete().eq("org_id", ORG).eq("crew_id", crew_id).eq("date", day).execute()
    return {"ok": True, "date": day}


class CrewInput(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    business_unit_id: str
    squares_per_day: float = Field(25.0, gt=0, le=200)
    tear_off_squares_per_day: float = Field(15.0, gt=0, le=200)
    max_pitch: float = Field(9.0, ge=1, le=20)
    max_stories: int = Field(2, ge=1, le=6)
    lead_id: Optional[str] = None
    shift_weekdays: Optional[list] = None      # 0=Mon..6=Sun; default Mon–Fri
    shift_start: str = "07:00"
    shift_end: str = "15:30"
    shift_weeks: int = Field(8, ge=1, le=26)


@router.post("/crews")
async def create_crew(body: CrewInput, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    ins = db.table("sched_crew").insert({
        "org_id": ORG, "name": body.name, "business_unit_id": body.business_unit_id,
        "squares_per_day": body.squares_per_day, "tear_off_squares_per_day": body.tear_off_squares_per_day,
        "max_pitch": body.max_pitch, "max_stories": body.max_stories, "lead_id": body.lead_id or None,
    }).execute()
    crew = (ins.data or [None])[0]
    if not crew:
        raise HTTPException(status_code=500, detail="Could not create the crew.")
    _generate_shifts(db, crew["id"], body.shift_weekdays if body.shift_weekdays is not None else [0, 1, 2, 3, 4],
                     body.shift_start, body.shift_end, body.shift_weeks)
    return crew


class CrewPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    business_unit_id: Optional[str] = None
    squares_per_day: Optional[float] = Field(None, gt=0, le=200)
    tear_off_squares_per_day: Optional[float] = Field(None, gt=0, le=200)
    max_pitch: Optional[float] = Field(None, ge=1, le=20)
    max_stories: Optional[int] = Field(None, ge=1, le=6)
    lead_id: Optional[str] = None


@router.patch("/crews/{crew_id}")
async def update_crew(crew_id: str, body: CrewPatch, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    if not _one(db, "sched_crew", crew_id):
        raise HTTPException(status_code=404, detail="Crew not found.")
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(status_code=422, detail="Nothing to update.")
    db.table("sched_crew").update(patch).eq("org_id", ORG).eq("id", crew_id).execute()
    return _one(db, "sched_crew", crew_id)


@router.delete("/crews/{crew_id}")
async def delete_crew(crew_id: str, user: dict = Depends(require_user)) -> dict:
    """Retire a crew.

    The old guard refused whenever ANY sched_assignment row existed for the
    crew — all time, any status. The board only ever loads the visible week, so
    a job finished last month (or booked three weeks out) produced "this crew
    still has scheduled jobs" while the dispatcher stared at an empty row and
    concluded the app was broken. Only work that still needs this crew blocks,
    and the message says which job and when so it can actually be acted on.

    A crew with finished work is archived rather than deleted: sched_assignment
    cascades on crew delete, so hard-deleting would strip the crew off historical
    appointments and quietly rewrite who did the work. Archiving takes it off the
    board and leaves the record intact.
    """
    db = get_supabase()
    crew = _one(db, "sched_crew", crew_id)
    if not crew:
        raise HTTPException(status_code=404, detail="Crew not found.")

    appt_ids = [a["appointment_id"] for a in
                _rows(db.table("sched_assignment").select("appointment_id")
                      .eq("org_id", ORG).eq("crew_id", crew_id).execute())
                if a.get("appointment_id")]

    upcoming: list[dict] = []
    finished = 0
    if appt_ids:
        upcoming, finished = split_crew_work(
            _rows(db.table("sched_appointment")
                  .select("id,scheduled_start,status,job_id").in_("id", appt_ids).execute()),
            date.today().isoformat(),
        )

    if upcoming:
        name = crew.get("name") or "This crew"
        dated = [r for r in upcoming if (r.get("scheduled_start") or "")[:10]]
        undated = [r for r in upcoming if not (r.get("scheduled_start") or "")[:10]]
        if dated:
            nxt = (dated[0].get("scheduled_start") or "")[:10]
            n = len(dated)
            extra = (f" There {'is' if len(undated) == 1 else 'are'} also {len(undated)} job"
                     f"{'' if len(undated) == 1 else 's'} with no date set.") if undated else ""
            raise HTTPException(status_code=409, detail=(
                f"{name} still has {n} upcoming job{'' if n == 1 else 's'}, "
                f"the next on {nxt}. Move or cancel {'it' if n == 1 else 'them'} first — the board shows "
                f"one week at a time, so jump to that date to find {'it' if n == 1 else 'them'}.{extra}"
            ))
        # Undated work only. The old message printed "the next on " with an empty
        # date, which sent the dispatcher hunting a day that does not exist.
        n = len(undated)
        raise HTTPException(status_code=409, detail=(
            f"{name} is still on {n} job{'' if n == 1 else 's'} that {'has' if n == 1 else 'have'} "
            f"no date set, so {'it' if n == 1 else 'they'} never appear on the board. "
            f"Open the job{'' if n == 1 else 's'} from the project list and either schedule "
            f"{'it' if n == 1 else 'them'} or unassign this crew."
        ))

    # Scheduling scaffolding is the crew's own and goes either way.
    for t in ("sched_shift", "sched_non_job_event", "sched_crew_skill", "sched_crew_membership"):
        db.table(t).delete().eq("org_id", ORG).eq("crew_id", crew_id).execute()

    archived = finished > 0
    if archived:
        db.table("sched_crew").update({"is_active": False}).eq("org_id", ORG).eq("id", crew_id).execute()
    else:
        db.table("sched_crew").delete().eq("org_id", ORG).eq("id", crew_id).execute()

    db.table("sched_audit_event").insert({
        "org_id": ORG, "actor_id": str(user.get("id") or ""), "entity_type": "crew",
        "entity_id": crew_id, "action": "ARCHIVE_CREW" if archived else "DELETE_CREW",
        "before_json": {"name": crew.get("name"), "is_active": crew.get("is_active")},
        "after_json": {"archived": archived, "completed_jobs": finished},
        "request_id": str(uuid.uuid4())}).execute()

    return {"ok": True, "archived": archived, "completed_jobs": finished}


class TimeOffInput(BaseModel):
    crew_id: str
    title: str = Field("Time off", max_length=80)
    start_date: str
    end_date: str
    blocks_capacity: bool = True


@router.get("/timeoff")
async def list_timeoff(crew_id: Optional[str] = None, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    q = db.table("sched_non_job_event").select("*").eq("org_id", ORG)
    if crew_id:
        q = q.eq("crew_id", crew_id)
    return {"events": _rows(q.order("start_at", desc=True).limit(200).execute())}


@router.post("/timeoff")
async def add_timeoff(body: TimeOffInput, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    if not _one(db, "sched_crew", body.crew_id):
        raise HTTPException(status_code=404, detail="Crew not found.")
    sd = _parse_date(body.start_date, "start_date"); ed = _parse_date(body.end_date, "end_date")
    if ed < sd:
        raise HTTPException(status_code=422, detail="End date is before start date.")
    ins = db.table("sched_non_job_event").insert({
        "org_id": ORG, "crew_id": body.crew_id, "title": body.title,
        "start_at": naive_dt(sd, "00:00").isoformat(), "end_at": naive_dt(ed, "23:59").isoformat(),
        "blocks_capacity": body.blocks_capacity,
    }).execute()
    return (ins.data or [None])[0] or {"ok": True}


@router.delete("/timeoff/{event_id}")
async def delete_timeoff(event_id: str, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    db.table("sched_non_job_event").delete().eq("org_id", ORG).eq("id", event_id).execute()
    return {"ok": True}


# ── M7: create a dispatch job FROM a project (the write side of the link) ─────

VALID_JOB_TYPES = {"REROOF", "NEW_ROOF_INSTALL", "ROOF_REPAIR", "GUTTER_REPAIR",
                   "GUTTER_INSTALL", "SIDING_REPAIR", "NEW_SIDING_INSTALL", "INSPECTION"}


class ProjectToDispatch(BaseModel):
    project_id: str
    job_type: str = "REROOF"
    priority: str = "ROUTINE"


@router.post("/from-project")
async def create_job_from_project(body: ProjectToDispatch, user: dict = Depends(require_user)) -> dict:
    """Stage a project onto the dispatch board: creates a linked sched_job (+ its
    customer/property) so it lands in the tray, ready to assign to a crew. Idempotent
    per project. Reuses the project's address/customer/squares so nothing is retyped."""
    db = get_supabase()
    pr = _rows(db.table("projects").select("*").eq("id", body.project_id).limit(1).execute())
    if not pr or pr[0].get("user_id") != user.get("id"):
        raise HTTPException(status_code=404, detail="Project not found.")
    p = pr[0]

    existing = _rows(db.table("sched_job").select("id").eq("org_id", ORG).eq("project_id", body.project_id).limit(1).execute())
    if existing:
        return {"created": False, "job_id": existing[0]["id"], "message": "This project is already on the dispatch board."}

    lat, lng = _f(p.get("lat")), _f(p.get("lng"))
    if lat is None or lng is None:  # older projects — geocode from the address
        addr = ", ".join(x for x in [p.get("address"), p.get("city"), p.get("state"), p.get("zip_code")] if x)
        if addr:
            try:
                from app.services import location_service
                res = await location_service.search_address(addr, with_geographies=False)
                if res.matches:
                    lat, lng = res.matches[0].lat, res.matches[0].lng
            except Exception as e:
                logger.info("from-project geocode failed: %s", e)
    if lat is None or lng is None:
        raise HTTPException(status_code=422, detail="This project has no location yet — add an address before scheduling it.")

    bu = _rows(db.table("sched_business_unit").select("id").eq("org_id", ORG).order("sort_order").limit(1).execute())
    if not bu:
        raise HTTPException(status_code=409, detail="No business unit is configured for scheduling yet.")

    full = (p.get("customer_name") or "").strip()
    first, _, last = full.partition(" ") if full else ((p.get("name") or "Customer"), "", "")
    cust = (db.table("sched_customer").insert({
        "org_id": ORG, "first_name": first or "Customer", "last_name": last or "",
        "phone": p.get("customer_phone"), "email": p.get("customer_email"),
    }).execute().data or [None])[0]
    prop = (db.table("sched_property").insert({
        "org_id": ORG, "line1": p.get("address") or p.get("name") or "Address TBD",
        "city": p.get("city") or "", "state": p.get("state") or "", "postal_code": p.get("zip_code") or "",
        "lat": lat, "lng": lng,
    }).execute().data or [None])[0]
    if not cust or not prop:
        raise HTTPException(status_code=500, detail="Could not stage the job.")

    run = _latest_run(db, body.project_id)
    job = (db.table("sched_job").insert({
        "org_id": ORG, "business_unit_id": bu[0]["id"], "customer_id": cust["id"], "property_id": prop["id"],
        "project_id": body.project_id,
        "job_type": body.job_type if body.job_type in VALID_JOB_TYPES else "REROOF",
        "status": "SOLD", "priority": body.priority if body.priority in ("ROUTINE", "HIGH", "URGENT") else "ROUTINE",
        "squares": _f(run.get("squares")),
    }).execute().data or [None])[0]
    if not job:
        raise HTTPException(status_code=500, detail="Could not create the job.")

    db.table("sched_audit_event").insert({"org_id": ORG, "actor_id": str(user.get("id") or ""), "entity_type": "job",
        "entity_id": job["id"], "action": "CREATE_FROM_PROJECT", "before_json": None,
        "after_json": {"project_id": body.project_id}, "request_id": str(uuid.uuid4())}).execute()
    return {"created": True, "job_id": job["id"], "message": "Added to the dispatch board — open the tray to schedule it."}
