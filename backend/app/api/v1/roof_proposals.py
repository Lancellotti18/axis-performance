"""
Roof Proposals — good/better/best homeowner-facing proposals from a
measurement run. The last mile from "measurement" to "signed job".

Contractor (JWT):
    POST  /api/v1/roof-proposals/from-run/{run_id}   — create (auto-priced tiers)
    POST  /api/v1/roof-proposals/from-lead/{lead_id} — one click: RoofIQ lead → live proposal
    GET   /api/v1/roof-proposals?project_id=          — list mine
    PATCH /api/v1/roof-proposals/{proposal_id}        — edit tiers / status
Public (homeowner, by share token):
    GET   /api/v1/roof-proposals/public/{token}
    POST  /api/v1/roof-proposals/public/{token}/accept
"""
from __future__ import annotations

import logging
import secrets
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.auth import require_user
from app.core.ownership import require_owned_widget_lead
from app.core.supabase import get_supabase

logger = logging.getLogger(__name__)
router = APIRouter()

# Default turnkey $/square by tier — the contractor edits these per proposal.
DEFAULT_TIERS = [
    {
        "name": "Good", "rate": 475,
        "headline": "Architectural shingles",
        "description": "Quality architectural shingles, full tear-off, synthetic felt underlayment, new drip edge and pipe flashings.",
        "features": ["30-yr architectural shingles", "Full tear-off & haul away", "Synthetic underlayment", "New drip edge + pipe boots", "5-yr workmanship warranty"],
    },
    {
        "name": "Better", "rate": 565,
        "headline": "Premium system + upgraded protection",
        "description": "Upgraded shingle line with ice & water shield at eaves and valleys, ridge vent, and an extended workmanship warranty.",
        "features": ["Premium architectural shingles", "Ice & water shield (eaves + valleys)", "Ridge vent ventilation", "Starter + hip & ridge caps", "10-yr workmanship warranty"],
    },
    {
        "name": "Best", "rate": 675,
        "headline": "Designer system, maximum warranty",
        "description": "Designer-class shingles, full manufacturer system for the maximum registered warranty, premium ventilation and flashing package.",
        "features": ["Designer-class shingles", "Full manufacturer system warranty", "Complete flashing replacement", "Premium ventilation package", "15-yr workmanship warranty"],
    },
]


def _snapshot_contractor(db, user_id: str) -> dict:
    try:
        prof = db.table("contractor_profiles").select("*").eq("user_id", user_id).limit(1).execute()
        if prof.data:
            p = prof.data[0]
            return {
                "company_name": p.get("company_name"),
                "license_number": p.get("license_number"),
                "phone": p.get("phone"),
                "email": p.get("email"),
                "logo_url": p.get("logo_url"),
            }
    except Exception:
        pass
    return {}


class CreateProposalIn(BaseModel):
    valid_days: int = Field(30, ge=1, le=365)


@router.post("/from-run/{run_id}")
async def create_from_run(
    run_id: str, payload: CreateProposalIn, user: dict = Depends(require_user),
) -> dict:
    """Create a proposal from a measured run: snapshots the measurement +
    contractor branding, auto-prices three tiers from the roof's squares."""
    db = get_supabase()
    run = db.table("roof_measurement_runs").select("*").eq("id", run_id).single().execute()
    if not run.data:
        raise HTTPException(status_code=404, detail="Run not found.")
    squares = float(run.data.get("squares") or 0)
    if squares <= 0:
        # Facets may be drawn but aggregates never recomputed (e.g. the
        # contractor jumped straight to the report step). Recompute once
        # before giving up — "didn't work at all" is not an acceptable UX.
        try:
            from app.api.v1.roofing_v2 import _aggregate_run
            agg = _aggregate_run(run_id)
            squares = float(agg.get("squares") or 0)
            run.data["squares"] = squares
            run.data["total_roof_sqft"] = agg.get("total_roof_sqft")
            run.data["predominant_pitch"] = agg.get("predominant_pitch")
        except Exception as e:
            logger.info("proposal aggregate recompute failed: %s", e)
    if squares <= 0:
        raise HTTPException(
            status_code=422,
            detail="This roof has no measured area yet — draw (or auto-analyze) the facets in the editor, then come back.",
        )

    # Ownership: the run's project must belong to the caller. Orphan runs
    # (no project) are rejected outright — otherwise anyone could snapshot
    # and price a run they don't own by guessing its id.
    address = None
    if not run.data.get("project_id"):
        raise HTTPException(status_code=404, detail="Run not found.")
    proj = db.table("projects").select("user_id, address, city, state, zip, name").eq("id", run.data["project_id"]).single().execute()
    if not proj.data or proj.data.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Run not found.")
    parts = [proj.data.get("address"), proj.data.get("city"), proj.data.get("state")]
    address = ", ".join(p for p in parts if p) or proj.data.get("name")

    order_sq = squares * 1.10   # waste
    tiers = []
    for t in DEFAULT_TIERS:
        tiers.append({
            "name": t["name"],
            "headline": t["headline"],
            "description": t["description"],
            "features": t["features"],
            "price": round(order_sq * t["rate"] / 50.0) * 50,
        })

    from datetime import date, timedelta
    row = {
        "user_id": user["id"],
        "project_id": run.data.get("project_id"),
        "run_id": run_id,
        "token": secrets.token_urlsafe(16),
        **_snapshot_contractor(db, user["id"]),
        "address": address,
        "squares": round(squares, 1),
        "total_roof_sqft": run.data.get("total_roof_sqft"),
        "predominant_pitch": run.data.get("predominant_pitch"),
        "tiers": tiers,
        "status": "draft",
        "valid_until": (date.today() + timedelta(days=payload.valid_days)).isoformat(),
    }
    ins = db.table("roof_proposals").insert({k: v for k, v in row.items() if v is not None}).execute()
    if not ins.data:
        raise HTTPException(status_code=500, detail="Could not create proposal.")
    return ins.data[0]


@router.post("/from-lead/{lead_id}")
async def create_from_lead(
    lead_id: str, payload: CreateProposalIn, user: dict = Depends(require_user),
) -> dict:
    """One click: a RoofIQ widget lead becomes a live good/better/best proposal
    using the squares already measured at quote time. Kills the 24–48h quote
    wait — the homeowner gets a real proposal minutes after asking.

    Good/Best are priced at the contractor's own widget $/sq rates (the same
    numbers the homeowner already saw), Better at the midpoint.

    Accepts either the widget-lead UUID or its report token — the CRM only
    carries the report token (packed into the lead's notes), so the pipeline
    drawer can one-click a proposal without a schema change."""
    db = get_supabase()
    lead = None
    try:
        lead = require_owned_widget_lead(db, lead_id, user)
    except Exception:
        res = (
            db.table("widget_leads").select("*")
            .eq("report_token", lead_id).eq("user_id", user["id"]).limit(1).execute()
        )
        if not res.data:
            raise HTTPException(status_code=404, detail="Lead not found.")
        lead = res.data[0]

    q = lead.get("quote") or {}
    squares = float(q.get("squares") or lead.get("squares_estimate") or 0)
    if squares <= 0:
        raise HTTPException(
            status_code=422,
            detail="This lead has no measured roof size — open the address in the roof editor to measure it first.",
        )

    rate_low, rate_high = None, None
    try:
        w = db.table("quote_widgets").select("price_low, price_high").eq("user_id", user["id"]).limit(1).execute()
        if w.data:
            rate_low = float(w.data[0].get("price_low") or 0) or None
            rate_high = float(w.data[0].get("price_high") or 0) or None
    except Exception:
        pass

    order_sq = squares * 1.10
    rates = [
        rate_low or DEFAULT_TIERS[0]["rate"],
        ((rate_low or DEFAULT_TIERS[0]["rate"]) + (rate_high or DEFAULT_TIERS[2]["rate"])) / 2,
        rate_high or DEFAULT_TIERS[2]["rate"],
    ]
    # RoofVision: the homeowner already saw their own roof in these colors on
    # the report. Carry the renders onto the matching-tier proposal cards, and
    # spotlight the color they chose — so the proposal opens on the exact look
    # they fell for, not a generic price sheet.
    details = lead.get("details") or {}
    renders = details.get("renders") or []
    chosen_key = details.get("chosen_render")
    chosen = next((r for r in renders if r.get("key") == chosen_key), None)
    by_tier: dict[str, dict] = {}
    for r in renders:
        # Prefer the chosen color for its tier; otherwise first render of that tier.
        t = r.get("tier")
        if t and (t not in by_tier or r.get("key") == chosen_key):
            by_tier[t] = r

    tiers = []
    for t, rate in zip(DEFAULT_TIERS, rates):
        tier = {
            "name": t["name"],
            "headline": t["headline"],
            "description": t["description"],
            "features": t["features"],
            "price": round(order_sq * rate / 50.0) * 50,
        }
        rv = by_tier.get(t["name"])
        if rv:
            tier["render_url"] = rv.get("image_url")
            tier["color_name"] = rv.get("name")
            if chosen and rv.get("key") == chosen.get("key"):
                tier["homeowner_pick"] = True
        tiers.append(tier)

    from datetime import date, timedelta
    row = {
        "user_id": user["id"],
        "token": secrets.token_urlsafe(16),
        **_snapshot_contractor(db, user["id"]),
        "address": lead.get("address"),
        "squares": round(squares, 1),
        "total_roof_sqft": q.get("roof_sqft"),
        "tiers": tiers,
        "status": "draft",
        "valid_until": (date.today() + timedelta(days=payload.valid_days)).isoformat(),
    }
    ins = db.table("roof_proposals").insert({k: v for k, v in row.items() if v is not None}).execute()
    if not ins.data:
        raise HTTPException(status_code=500, detail="Could not create proposal.")
    return ins.data[0]


@router.get("")
async def list_proposals(
    project_id: Optional[str] = None, user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    q = db.table("roof_proposals").select("*").eq("user_id", user["id"]).order("created_at", desc=True).limit(100)
    if project_id:
        q = q.eq("project_id", project_id)
    return {"proposals": q.execute().data or []}


class ProposalPatch(BaseModel):
    tiers: Optional[list[dict]] = None
    status: Optional[str] = Field(None, pattern="^(draft|sent|declined|expired)$")  # accepted only via public accept
    company_name: Optional[str] = Field(None, max_length=120)
    phone: Optional[str] = Field(None, max_length=32)


@router.patch("/{proposal_id}")
async def update_proposal(
    proposal_id: str, payload: ProposalPatch, user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    patch: dict = {}
    if payload.tiers is not None:
        # Sanitize tiers: cap counts + coerce prices.
        clean = []
        for t in payload.tiers[:4]:
            try:
                clean.append({
                    "name": str(t.get("name") or "Option")[:40],
                    "headline": str(t.get("headline") or "")[:120],
                    "description": str(t.get("description") or "")[:600],
                    "features": [str(f)[:120] for f in (t.get("features") or [])[:10]],
                    "price": max(0, float(t.get("price") or 0)),
                })
            except (TypeError, ValueError):
                continue
        patch["tiers"] = clean
    if payload.status is not None:
        patch["status"] = payload.status
    if payload.company_name is not None:
        patch["company_name"] = payload.company_name
    if payload.phone is not None:
        patch["phone"] = payload.phone
    if not patch:
        raise HTTPException(status_code=422, detail="Nothing to update.")
    patch["updated_at"] = "now()"
    res = db.table("roof_proposals").update(patch).eq("id", proposal_id).eq("user_id", user["id"]).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Proposal not found.")
    return res.data[0]


# ---------------------------------------------------------------------------
# Public (homeowner)
# ---------------------------------------------------------------------------

def _public_view(p: dict) -> dict:
    """Only homeowner-safe fields."""
    return {
        "company_name": p.get("company_name") or "Your roofing contractor",
        "license_number": p.get("license_number"),
        "phone": p.get("phone"),
        "email": p.get("email"),
        "logo_url": p.get("logo_url"),
        "address": p.get("address"),
        "squares": p.get("squares"),
        "total_roof_sqft": p.get("total_roof_sqft"),
        "predominant_pitch": p.get("predominant_pitch"),
        "tiers": p.get("tiers") or [],
        "status": p.get("status"),
        "accepted_tier": p.get("accepted_tier"),
        "valid_until": p.get("valid_until"),
        "created_at": p.get("created_at"),
    }


@router.get("/public/{token}")
async def public_proposal(token: str) -> dict:
    if not token or len(token) > 64:
        raise HTTPException(status_code=404, detail="Proposal not found.")
    db = get_supabase()
    res = db.table("roof_proposals").select("*").eq("token", token).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Proposal not found.")
    p = res.data[0]
    # First homeowner open flips draft → sent (a real "viewed" signal).
    if p.get("status") == "draft":
        try:
            db.table("roof_proposals").update({"status": "sent"}).eq("id", p["id"]).execute()
            p["status"] = "sent"
        except Exception:
            pass
    return _public_view(p)


class AcceptIn(BaseModel):
    tier_name: str = Field(..., min_length=1, max_length=40)
    name: str = Field(..., min_length=2, max_length=120)
    email: Optional[str] = Field(None, max_length=160)
    note: Optional[str] = Field(None, max_length=500)


@router.post("/public/{token}/accept")
async def accept_proposal(token: str, payload: AcceptIn) -> dict:
    db = get_supabase()
    res = db.table("roof_proposals").select("*").eq("token", token).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Proposal not found.")
    p = res.data[0]
    if p.get("status") == "accepted":
        return {"ok": True, "message": "This proposal was already accepted — the contractor will be in touch."}
    tier_names = [t.get("name") for t in (p.get("tiers") or [])]
    if payload.tier_name not in tier_names:
        raise HTTPException(status_code=422, detail="Pick one of the offered options.")
    db.table("roof_proposals").update({
        "status": "accepted",
        "accepted_tier": payload.tier_name,
        "accepted_by_name": payload.name.strip(),
        "accepted_by_email": (payload.email or "").strip() or None,
        "homeowner_note": (payload.note or "").strip() or None,
        "accepted_at": "now()",
        "updated_at": "now()",
    }).eq("id", p["id"]).execute()
    return {
        "ok": True,
        "message": f"You're set, {payload.name.split(' ')[0]}! {p.get('company_name') or 'The contractor'} will contact you to schedule.",
    }
