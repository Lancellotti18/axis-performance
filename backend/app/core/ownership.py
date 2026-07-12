"""Shared ownership guards — the single place tenant isolation is enforced.

Every router that looks up a record by client-supplied id MUST resolve it
through one of these helpers instead of querying the table directly. The
backend talks to Supabase with the service-role key (RLS is bypassed), so
these checks are the only tenant boundary for API traffic.

All failures return 404, never 403 — a guessed UUID must not confirm that
the record exists.
"""
from fastapi import HTTPException

_NOT_FOUND = HTTPException(status_code=404, detail="Not found.")


def require_owned_project(db, project_id: str, user: dict) -> dict:
    """Return the project row iff it belongs to the authenticated user."""
    if not project_id:
        raise _NOT_FOUND
    res = db.table("projects").select("*").eq("id", project_id).limit(1).execute()
    if not res.data or res.data[0].get("user_id") != user["id"]:
        raise _NOT_FOUND
    return res.data[0]


def require_owned_run(db, run_id: str, user: dict) -> dict:
    """Return the measurement-run row iff its project belongs to the user.

    Runs carry no user_id of their own — ownership derives from the project.
    Runs without a project are unreachable by design (live data has none).
    """
    if not run_id:
        raise _NOT_FOUND
    res = db.table("roof_measurement_runs").select("*").eq("id", run_id).limit(1).execute()
    if not res.data:
        raise _NOT_FOUND
    run = res.data[0]
    require_owned_project(db, run.get("project_id"), user)
    return run


def require_owned_blueprint(db, blueprint_id: str, user: dict) -> dict:
    """Return the blueprint row iff its project belongs to the user."""
    if not blueprint_id:
        raise _NOT_FOUND
    res = db.table("blueprints").select("*").eq("id", blueprint_id).limit(1).execute()
    if not res.data:
        raise _NOT_FOUND
    require_owned_project(db, res.data[0].get("project_id"), user)
    return res.data[0]


def require_owned_crm_lead(db, lead_id: str, user: dict) -> dict:
    """Return the CRM lead row iff it belongs to the user."""
    if not lead_id:
        raise _NOT_FOUND
    res = (
        db.table("crm_leads").select("*")
        .eq("id", lead_id).eq("user_id", user["id"]).limit(1).execute()
    )
    if not res.data:
        raise _NOT_FOUND
    return res.data[0]


def require_owned_widget_lead(db, lead_id: str, user: dict) -> dict:
    """Return the RoofIQ widget lead row iff it belongs to the user."""
    if not lead_id:
        raise _NOT_FOUND
    res = (
        db.table("widget_leads").select("*")
        .eq("id", lead_id).eq("user_id", user["id"]).limit(1).execute()
    )
    if not res.data:
        raise _NOT_FOUND
    return res.data[0]
