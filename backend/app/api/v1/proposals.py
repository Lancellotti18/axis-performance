"""
proposals.py — Proposal API Routes
====================================
Endpoints:
  POST /{project_id}/generate   — generate contractor proposal PDF
  GET  /{project_id}/download   — download the most recent proposal PDF

All data fed into the proposal comes from real sources:
  - Project record (Supabase)
  - Contractor profile (Supabase)
  - AXIS pipeline outputs: materials list, live pricing, scheduler (disk cache)
  - Estimator output as fallback for materials
  - live_pricing_service for real-time regional pricing
"""

from __future__ import annotations

import json
import logging
import os
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from app.core.supabase import get_supabase

router = APIRouter()
log = logging.getLogger(__name__)

AXIS_OUTPUT_ROOT = os.environ.get("AXIS_OUTPUT_DIR", "/tmp/axis_outputs")
PROPOSAL_CACHE_DIR = os.environ.get("PROPOSAL_CACHE_DIR", "/tmp/proposals")


def _axis_dir(project_id: str) -> str:
    return os.path.join(AXIS_OUTPUT_ROOT, project_id)


def _load_axis_json(project_id: str, filename: str) -> dict | None:
    path = os.path.join(_axis_dir(project_id), filename)
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            log.debug("axis json parse failed: %s", path, exc_info=True)
            pass
    return None


# ── Request Models ────────────────────────────────────────────────────────────

class ProposalRequest(BaseModel):
    trade_type:     str = "General Construction"  # Roofing | New Construction | Renovation | General Construction
    tier:           str = "standard"              # economy | standard | premium
    client_name:    str = ""
    client_email:   str = ""
    client_phone:   str = ""
    client_address: str = ""
    notes:          str = ""
    valid_days:     int = 30
    # Optional overrides — if provided, these replace AXIS pricing data
    material_overrides: list[dict] = []   # [{item_name, unit_cost, quantity, unit, category, total_cost}]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_contractor_profile(db, user_id: str) -> dict:
    try:
        r = db.table("contractor_profiles").select("*").eq("user_id", user_id).limit(1).execute()
        if r.data:
            return r.data[0]
    except Exception as e:
        log.warning(f"Could not load contractor profile: {e}")
    return {}


def _load_materials_and_pricing(project_id: str, db) -> tuple[list[dict], dict]:
    """
    Load the material list and live pricing summary from AXIS outputs.
    Falls back to the estimator's materials if AXIS hasn't run yet.

    Returns (materials, pricing_data)
    """
    # 1. Try AXIS 5D pipeline results
    axis_results = _load_axis_json(project_id, "axis_results.json")
    if axis_results:
        pricing_data = axis_results.get("live_pricing", {})
        materials = pricing_data.get("materials") or axis_results.get("materials", [])
        if materials:
            log.info(f"[proposals] Loaded {len(materials)} materials from AXIS results")
            return materials, pricing_data

    # 2. Fall back to estimator results from Supabase
    try:
        r = db.table("estimates").select("*").eq("project_id", project_id).order("created_at", desc=True).limit(1).execute()
        if r.data:
            est = r.data[0]
            raw_mats = est.get("materials") or []
            if isinstance(raw_mats, str):
                raw_mats = json.loads(raw_mats)

            # Enrich with live pricing
            if raw_mats:
                from app.services.live_pricing_service import get_project_pricing
                project_r = db.table("projects").select("city,region,zip_code").eq("id", project_id).limit(1).execute()
                proj = project_r.data[0] if project_r.data else {}
                state = (proj.get("region") or "").replace("US-", "")
                pricing_data = get_project_pricing(
                    raw_mats,
                    zip_code=proj.get("zip_code", ""),
                    city=proj.get("city", ""),
                    state=state,
                )
                log.info(f"[proposals] Live pricing fetched for {len(raw_mats)} materials from estimator fallback")
                return pricing_data["materials"], pricing_data
    except Exception as e:
        log.warning(f"[proposals] Estimator fallback failed: {e}")

    return [], {}


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/{project_id}/generate")
async def generate_proposal(project_id: str, body: ProposalRequest):
    """
    Generate a contractor proposal PDF from real project data.

    Data sources (all real, none invented):
    - Project details from Supabase
    - Contractor profile from Supabase
    - Materials & prices from AXIS pipeline (Tavily live prices + RSMeans regional)
    - Schedule from AXIS 5D pipeline
    - Scope of work text from Claude (labeled as AI-generated in the PDF)
    """
    db = get_supabase()

    # ── Fetch project ──────────────────────────────────────────────────────────
    proj_r = db.table("projects").select("*").eq("id", project_id).limit(1).execute()
    if not proj_r.data:
        raise HTTPException(status_code=404, detail="Project not found")
    project = proj_r.data[0]

    # ── Fetch contractor profile ───────────────────────────────────────────────
    user_id = project.get("user_id", "")
    contractor = _load_contractor_profile(db, user_id)
    if not contractor:
        # Minimal contractor dict so PDF still generates
        contractor = {"company_name": "Your Company", "license_number": "", "phone": "", "email": ""}

    # ── Load materials + pricing ───────────────────────────────────────────────
    if body.material_overrides:
        # User manually edited line items — enrich with live pricing
        from app.services.live_pricing_service import get_project_pricing
        state = (project.get("region") or "").replace("US-", "")
        pricing_data = get_project_pricing(
            body.material_overrides,
            zip_code=project.get("zip_code", ""),
            city=project.get("city", ""),
            state=state,
        )
        materials = pricing_data["materials"]
    else:
        materials, pricing_data = _load_materials_and_pricing(project_id, db)

    if not materials:
        raise HTTPException(
            status_code=422,
            detail=(
                "No material data found. Run the AXIS pipeline first, or provide "
                "material_overrides in the request body."
            ),
        )

    # ── Load schedule ──────────────────────────────────────────────────────────
    schedule_data: dict | None = None
    axis_results = _load_axis_json(project_id, "axis_results.json")
    if axis_results:
        schedule_data = axis_results.get("schedule")
    if not schedule_data:
        schedule_data = _load_axis_json(project_id, "schedule.json")

    # ── Build project dict for PDF ─────────────────────────────────────────────
    state_label = (project.get("region") or "").replace("US-", "")
    location_parts = [project.get("city"), state_label]
    project_dict = {
        "name":        project.get("name", "Project"),
        "address":     project.get("address", f"{project.get('city', '')} {state_label}".strip()),
        "city":        project.get("city", ""),
        "state":       state_label,
        "zip_code":    project.get("zip_code", ""),
        "total_sqft":  project.get("total_sqft") or (axis_results or {}).get("total_sqft") or 0,
    }

    # ── Generate PDF ───────────────────────────────────────────────────────────
    from app.services.proposal_service import generate_proposal as _gen
    pdf_bytes = _gen(
        project=project_dict,
        contractor=contractor,
        materials=materials,
        pricing_data=pricing_data,
        schedule_data=schedule_data,
        trade_type=body.trade_type,
        tier=body.tier,
        client_name=body.client_name,
        client_email=body.client_email,
        client_phone=body.client_phone,
        client_address=body.client_address,
        notes=body.notes,
        valid_days=body.valid_days,
    )

    # ── Cache to disk for re-download ──────────────────────────────────────────
    os.makedirs(PROPOSAL_CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(PROPOSAL_CACHE_DIR, f"{project_id}_latest.pdf")
    with open(cache_path, "wb") as f:
        f.write(pdf_bytes)

    project_name_slug = project_dict["name"].lower().replace(" ", "_")
    filename = f"proposal_{project_name_slug}.pdf"

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{project_id}/download")
async def download_latest_proposal(project_id: str):
    """Download the most recently generated proposal PDF."""
    cache_path = os.path.join(PROPOSAL_CACHE_DIR, f"{project_id}_latest.pdf")
    if not os.path.exists(cache_path):
        raise HTTPException(
            status_code=404,
            detail="No proposal generated yet. POST to /{project_id}/generate first.",
        )

    db = get_supabase()
    proj_r = db.table("projects").select("name").eq("id", project_id).limit(1).execute()
    name = proj_r.data[0]["name"] if proj_r.data else "proposal"
    filename = f"proposal_{name.lower().replace(' ', '_')}.pdf"

    def _iter():
        with open(cache_path, "rb") as f:
            while chunk := f.read(65536):
                yield chunk

    return StreamingResponse(
        _iter(),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
