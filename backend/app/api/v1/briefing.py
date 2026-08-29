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
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.auth import require_user
from app.core.supabase import get_supabase
from app.services.briefing import (
    accepted_items, assemble, new_client_items, cold_lead_items, days_since, stuck_items,
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


def _new_clients(db, user_id: str, today: date) -> list[dict]:
    """CRM leads still at stage `new` — added but never contacted."""
    rows = (db.table("crm_leads").select("id,name,source,created_at,stage")
            .eq("user_id", user_id).eq("stage", "new")
            .order("created_at").limit(20).execute().data or [])
    return new_client_items(rows, today)


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


# How far ahead the briefing looks for weather. A week covers the run-up a
# dispatcher actually schedules into, and stays inside Open-Meteo's horizon.
WEATHER_HORIZON_DAYS = 7


async def _weather(db, tomorrow: date, days: int = WEATHER_HORIZON_DAYS) -> list[dict]:
    """The forecast at every job site each crew is actually due at, days ahead.

    Earlier this took only a crew's FIRST stop, which is wrong the moment a crew
    works two towns in a day — a dry morning in Leland told you nothing about a
    soaked afternoon in Hampstead. We now forecast every located stop for the
    crew and report the WORST conditions across them, so the line reflects the
    day the crew will actually have.

    Forecasts are keyed on a ~1 km grid (weather_service.bucket), so this is
    genuinely job-site weather rather than a city-wide average, and nearby stops
    share one upstream call.
    """
    from app.api.v1.scheduling import ORG, _dt, _f, _rows
    from app.services.scheduling import weather_service as wx

    # Today onward, not tomorrow alone. Scoping this to a single day is what
    # made the feature invisible: a job booked for today, or for Thursday, was
    # never mentioned at all.
    start = tomorrow - timedelta(days=1)          # `tomorrow` is passed as today+1
    end = start + timedelta(days=max(1, days))
    tstr = tomorrow.isoformat()
    horizon = {(start + timedelta(days=i)).isoformat() for i in range(max(1, days) + 1)}
    appts = _rows(db.table("sched_appointment").select("*").eq("org_id", ORG)
                  .gte("scheduled_start", start.isoformat())
                  .lt("scheduled_start", end.isoformat()).execute())
    if not appts:
        return []
    # A crew that's been stood down for the day doesn't need a weather call.
    active = {a["id"] for a in appts if (a.get("status") or "").upper() not in ("CANCELED", "DONE")}
    if not active:
        return []

    appt_crew = {a["appointment_id"]: a["crew_id"]
                 for a in _rows(db.table("sched_assignment").select("*").eq("org_id", ORG).execute())
                 if a.get("is_primary", True)}
    crews = {c["id"]: c for c in _rows(db.table("sched_crew").select("id,name")
                                       .eq("org_id", ORG).eq("is_active", True).execute())}
    jobs = {j["id"]: j for j in _rows(db.table("sched_job").select("id,property_id").eq("org_id", ORG).execute())}
    props = {p["id"]: p for p in _rows(db.table("sched_property").select("id,city,lat,lng").eq("org_id", ORG).execute())}

    # Every located stop, per crew AND per day — a crew's Tuesday says nothing
    # about its Thursday, so they cannot share one bucket.
    sites: dict = {}          # (crew_id, date) -> [(lat, lng, city), ...]
    jobs_per: dict = {}       # (crew_id, date) -> count
    for a in appts:
        if a["id"] not in active:
            continue
        crew_id = appt_crew.get(a["id"])
        sdt = _dt(a.get("scheduled_start"))
        if not crew_id or crew_id not in crews or not sdt:
            continue
        ds = sdt.date().isoformat()
        if ds not in horizon:
            continue
        key = (crew_id, ds)
        jobs_per[key] = jobs_per.get(key, 0) + 1
        job = jobs.get(a["job_id"])
        prop = props.get(job["property_id"]) if job else None
        if not prop:
            continue
        lat, lng = _f(prop.get("lat")), _f(prop.get("lng"))
        if lat is None or lng is None:
            continue
        sites.setdefault(key, []).append((lat, lng, prop.get("city")))

    if not sites:
        return []
    points = list({(lat, lng) for pts in sites.values() for (lat, lng, _c) in pts})
    fc = await wx.forecasts_for(points)

    rows = []
    for (crew_id, ds), pts in sites.items():
        worst_pp, worst_wind, worst_city = None, None, None
        distinct = {(round(lat, 2), round(lng, 2)) for (lat, lng, _c) in pts}
        for (lat, lng, city) in pts:
            w = (fc.get(wx.bucket(lat, lng)) or {}).get(ds) or {}
            pp, wind = w.get("precip_probability"), w.get("wind_mph")
            # Track the single worst site, and remember where it was.
            if pp is not None and (worst_pp is None or pp > worst_pp):
                worst_pp, worst_city = pp, city
            if wind is not None and (worst_wind is None or wind > worst_wind):
                worst_wind = wind
                if worst_pp is None:
                    worst_city = city
        rows.append({
            "crew_id": crew_id, "crew_name": crews[crew_id].get("name"), "date": ds,
            "precip_probability": worst_pp, "wind_mph": worst_wind,
            "job_count": jobs_per.get((crew_id, ds), 0),
            "location": worst_city, "site_count": len(distinct),
        })
    # Soonest first, so today's problem is never below next Thursday's.
    rows.sort(key=lambda r: r["date"])
    return weather_items(rows, horizon)


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


def _active_snoozes(db, user_id: str) -> set:
    """Item keys this contractor has put away that haven't come back yet.

    Tolerates the table not existing so the briefing still renders on an
    environment where the migration hasn't been run — it just won't hide
    anything, which is the safe direction to fail.
    """
    try:
        rows = (db.table("briefing_snoozes").select("item_key,snoozed_until")
                .eq("user_id", user_id)
                .gt("snoozed_until", datetime.now(timezone.utc).isoformat())
                .execute().data or [])
        return {r["item_key"] for r in rows}
    except Exception:
        logger.info("briefing: snooze table unavailable", exc_info=True)
        return set()


class SnoozeIn(BaseModel):
    key: str = Field(..., min_length=1, max_length=200)
    days: int = Field(7, ge=1, le=90)


@router.post("/snooze")
async def snooze_item(payload: SnoozeIn, user: dict = Depends(require_user)) -> dict:
    """Put one briefing line away for a while. Idempotent per (user, key)."""
    db = get_supabase()
    until = datetime.now(timezone.utc) + timedelta(days=payload.days)
    try:
        db.table("briefing_snoozes").upsert({
            "user_id": user["id"], "item_key": payload.key,
            "snoozed_until": until.isoformat(),
        }).execute()
    except Exception:
        logger.warning("briefing: could not snooze %s", payload.key, exc_info=True)
        raise HTTPException(status_code=503, detail="Could not snooze that just now — try again.")
    return {"ok": True, "key": payload.key, "snoozed_until": until.isoformat()}


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
        ("accepted",   lambda: _accepted(db, uid)),
        ("new_client", lambda: _new_clients(db, uid, today)),
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

    # Snoozed keys are excluded before the cap, so putting a line away promotes
    # the next real one instead of leaving a gap.
    return {"date": today.isoformat(),
            "items": assemble(groups, exclude=_active_snoozes(db, uid))}
