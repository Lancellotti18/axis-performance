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
from pydantic import BaseModel

from app.core.auth import require_user
from app.core.supabase import get_supabase
from app.services.scheduling.capacity import (
    AppointmentLoadInput, ConflictContext, CrewCapacityInput, JobProductionInput,
    NonJobEventInput, ProposedAssignment, ShiftInput, compute_crew_days,
    compute_day_load, detect_conflicts, has_block,
)
from app.services.scheduling.timeutil import naive_dt

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
BULK_OPS = {"REASSIGN", "MOVE_TO_DATE", "SHIFT_DAYS", "SET_STATUS", "ADD_TAG", "WAIVE_TRIP", "UNASSIGN"}


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

    if op in ("REASSIGN", "MOVE_TO_DATE", "SHIFT_DAYS"):
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
