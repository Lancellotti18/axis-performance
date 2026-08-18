"""GET /api/v1/briefing/today — the owner-operator's morning read.

Assembles the dashboard briefing from every corner of Axis in ONE request, so
the dashboard doesn't fan out to six endpoints on a cold free-tier backend.

Every source is wrapped individually: a briefing is a glance, and one slow or
broken table must never take the whole card down. A section that fails
contributes nothing rather than erroring — the contractor sees the lines we
could build, not a stack trace.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

from fastapi import APIRouter, Depends

from app.core.auth import require_user
from app.core.supabase import get_supabase
from app.services.briefing import (
    accepted_items, assemble, cold_lead_items, days_since, stuck_items,
    waiting_items, weather_items,
)
from app.services.crm_pulse import summarize_leads

logger = logging.getLogger(__name__)
router = APIRouter()


def _accepted(db, user_id: str) -> list[dict]:
    rows = (db.table("notifications").select("id,type,title,link,read")
            .eq("user_id", user_id).eq("type", "proposal_accepted").eq("read", False)
            .order("created_at", desc=True).limit(10).execute().data or [])
    return accepted_items(rows)


def _waiting(db, user_id: str, today: date) -> list[dict]:
    """Threads whose LAST message came from the homeowner, plus unconfirmed visits."""
    threads: list[dict] = []
    portals = (db.table("client_portals").select("id,project_id")
               .eq("user_id", user_id).limit(200).execute().data or [])
    if portals:
        by_id = {p["id"]: p for p in portals}
        msgs = (db.table("portal_messages").select("portal_id,sender,sender_name,created_at")
                .in_("portal_id", list(by_id)).order("created_at", desc=True)
                .limit(1000).execute().data or [])
        # Rows are newest-first, so the first one seen per portal IS the latest.
        latest: dict = {}
        for m in msgs:
            latest.setdefault(m["portal_id"], m)
        for pid, m in latest.items():
            if (m.get("sender") or "") != "homeowner":
                continue          # we replied last — the ball is with them
            threads.append({
                "project_id": by_id[pid].get("project_id"),
                "customer_name": m.get("sender_name"),
                "days_waiting": days_since(m.get("created_at"), today),
            })

    appts = (db.table("inspection_appointments").select("id,homeowner_name,preferred_date,status")
             .eq("user_id", user_id).eq("status", "requested")
             .gte("preferred_date", today.isoformat())
             .order("preferred_date").limit(10).execute().data or [])
    return waiting_items(threads, appts)


async def _weather(db, tomorrow: date) -> list[dict]:
    """Tomorrow's job-site forecast per crew, for crews that actually have work.

    Mirrors the board's own live-weather logic: each crew's earliest located
    stop that day is the point we forecast from, so it's the weather at the roof
    rather than at the office.
    """
    from app.api.v1.scheduling import ORG, _dt, _f, _rows
    from app.services.scheduling import weather_service as wx

    tstr = tomorrow.isoformat()
    appts = _rows(db.table("sched_appointment").select("*").eq("org_id", ORG)
                  .gte("scheduled_start", tstr)
                  .lt("scheduled_start", (tomorrow + timedelta(days=1)).isoformat()).execute())
    if not appts:
        return []

    appt_crew = {a["appointment_id"]: a["crew_id"]
                 for a in _rows(db.table("sched_assignment").select("*").eq("org_id", ORG).execute())
                 if a.get("is_primary", True)}
    crews = {c["id"]: c for c in _rows(db.table("sched_crew").select("id,name")
                                       .eq("org_id", ORG).eq("is_active", True).execute())}
    jobs = {j["id"]: j for j in _rows(db.table("sched_job").select("id,property_id").eq("org_id", ORG).execute())}
    props = {p["id"]: p for p in _rows(db.table("sched_property").select("id,lat,lng").eq("org_id", ORG).execute())}

    crew_loc: dict = {}
    jobs_per_crew: dict = {}
    for a in sorted(appts, key=lambda x: x.get("scheduled_start") or ""):
        crew_id = appt_crew.get(a["id"])
        if not crew_id or crew_id not in crews or not _dt(a.get("scheduled_start")):
            continue
        jobs_per_crew[crew_id] = jobs_per_crew.get(crew_id, 0) + 1
        job = jobs.get(a["job_id"])
        prop = props.get(job["property_id"]) if job else None
        lat, lng = (_f(prop.get("lat")), _f(prop.get("lng"))) if prop else (None, None)
        if lat and lng and crew_id not in crew_loc:
            crew_loc[crew_id] = (lat, lng)

    if not crew_loc:
        return []
    fc = await wx.forecasts_for(list(set(crew_loc.values())))

    rows = []
    for crew_id, (lat, lng) in crew_loc.items():
        w = (fc.get(wx.bucket(lat, lng)) or {}).get(tstr) or {}
        rows.append({"crew_id": crew_id, "crew_name": crews[crew_id].get("name"), "date": tstr,
                     "precip_probability": w.get("precip_probability"),
                     "job_count": jobs_per_crew.get(crew_id, 0)})
    return weather_items(rows, tstr)


def _cold(db, user_id: str, today: date) -> list[dict]:
    rows = db.table("crm_leads").select("*").eq("user_id", user_id).execute().data or []
    return cold_lead_items(summarize_leads(rows, today))


def _stuck(db, user_id: str) -> list[dict]:
    """Roofs traced but never confirmed, and reports finished but never shared."""
    projects = (db.table("projects").select("id").eq("user_id", user_id)
                .neq("archived", True).limit(500).execute().data or [])
    if not projects:
        return stuck_items(0, 0)
    pids = [p["id"] for p in projects]

    runs = (db.table("roof_measurement_runs").select("id,confirmed")
            .in_("project_id", pids).limit(500).execute().data or [])
    run_ids = [r["id"] for r in runs]
    traced: set = set()
    if run_ids:
        for f in (db.table("roof_facets").select("run_id").in_("run_id", run_ids).execute().data or []):
            traced.add(f["run_id"])
    unfinalized = sum(1 for r in runs if r["id"] in traced and not r.get("confirmed"))

    # "Finished but never sent" = a confirmed roof whose project has no enabled
    # share link, i.e. the customer was never given a way to see it.
    shared: set = set()
    for s in (db.table("project_photo_shares").select("project_id,enabled")
              .in_("project_id", pids).execute().data or []):
        if s.get("enabled"):
            shared.add(s["project_id"])
    finalized_runs = [r for r in runs if r.get("confirmed")]
    unsent = 0
    if finalized_runs:
        by_run = (db.table("roof_measurement_runs").select("id,project_id")
                  .in_("id", [r["id"] for r in finalized_runs]).execute().data or [])
        unsent = sum(1 for r in by_run if r.get("project_id") not in shared)
    return stuck_items(unfinalized, unsent)


@router.get("/today")
async def briefing_today(user: dict = Depends(require_user)) -> dict:
    """One ordered, capped list of things that need a decision this morning."""
    db = get_supabase()
    uid = user["id"]
    today = date.today()
    tomorrow = today + timedelta(days=1)

    groups: list[list[dict]] = []
    try:
        groups.append(await _weather(db, tomorrow))
    except Exception:
        logger.info("briefing: weather section unavailable", exc_info=True)
        groups.append([])

    for name, fn in (
        ("accepted", lambda: _accepted(db, uid)),
        ("waiting",  lambda: _waiting(db, uid, today)),
        ("cold",     lambda: _cold(db, uid, today)),
        ("stuck",    lambda: _stuck(db, uid)),
    ):
        try:
            groups.append(fn())
        except Exception:
            # One bad source must not cost the contractor the whole briefing.
            logger.info("briefing: %s section unavailable", name, exc_info=True)
            groups.append([])

    return {"date": today.isoformat(), "items": assemble(groups)}
