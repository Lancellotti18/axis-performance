"""
Instant Quote Widget — the growth engine.

A contractor gets an embeddable / hosted instant-quote tool. A homeowner types
their address on the contractor's website → Axis measures the roof
automatically (Google Solar → OSM footprint) → shows an instant price range
from the contractor's $/square settings → captures contact info → the lead
lands in the contractor's Axis lead inbox.

Public endpoints (keyed by widget_key, no auth — homeowner-facing):
    GET  /api/v1/instant-quote/w/{widget_key}          — widget branding/config
    POST /api/v1/instant-quote/w/{widget_key}/quote    — address → size + price range
    POST /api/v1/instant-quote/w/{widget_key}/lead     — capture the lead

Contractor endpoints (JWT):
    GET   /api/v1/instant-quote/my-widget              — get-or-create widget
    PATCH /api/v1/instant-quote/my-widget              — settings ($/sq, name, phone)
    GET   /api/v1/instant-quote/leads                  — lead inbox
    PATCH /api/v1/instant-quote/leads/{lead_id}        — status / notes
"""
from __future__ import annotations

import logging
import math
import secrets
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.auth import require_user
from app.core.supabase import get_supabase

logger = logging.getLogger(__name__)
router = APIRouter()

# Assumed average slope multiplier when we only have a plan-view footprint
# (≈6/12 pitch). Solar quotes use the TRUE 3D area, no assumption needed.
FOOTPRINT_SLOPE_FACTOR = 1.12
WASTE_FACTOR = 1.10

# Light in-memory abuse guard for the public quote endpoint (best-effort on a
# single instance): per-IP sliding hourly cap.
_RATE: dict[str, list[float]] = {}
_RATE_MAX_PER_HOUR = 30


def _rate_ok(ip: str) -> bool:
    now = time.time()
    hits = [t for t in _RATE.get(ip, []) if now - t < 3600]
    if len(hits) >= _RATE_MAX_PER_HOUR:
        _RATE[ip] = hits
        return False
    hits.append(now)
    _RATE[ip] = hits
    return True


def _ring_area_sqft(ring: list[dict]) -> float:
    """Shoelace area of a lat/lng ring via local equirectangular projection."""
    if len(ring) < 3:
        return 0.0
    lat0 = sum(p["lat"] for p in ring) / len(ring)
    coslat = math.cos(math.radians(lat0))
    pts = [((p["lng"]) * 111320.0 * coslat, (p["lat"]) * 111320.0) for p in ring]
    area = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2.0 * 10.7639   # m² → ft²


def _widget_by_key(db, widget_key: str) -> dict:
    if not widget_key or len(widget_key) > 64:
        raise HTTPException(status_code=404, detail="Unknown widget.")
    res = db.table("quote_widgets").select("*").eq("widget_key", widget_key).limit(1).execute()
    if not res.data or not res.data[0].get("enabled"):
        raise HTTPException(status_code=404, detail="This quote tool is not available.")
    return res.data[0]


# ---------------------------------------------------------------------------
# Public (homeowner-facing)
# ---------------------------------------------------------------------------

@router.get("/w/{widget_key}")
async def widget_config(widget_key: str) -> dict:
    """Branding for the public quote page — never leaks pricing internals."""
    w = _widget_by_key(get_supabase(), widget_key)
    return {
        "company_name": w.get("company_name") or "Your local roofing pro",
        "phone": w.get("phone") or "",
    }


class QuoteRequest(BaseModel):
    address: str = Field(..., min_length=6, max_length=200)


@router.post("/w/{widget_key}/quote")
async def instant_quote(widget_key: str, payload: QuoteRequest, request: Request) -> dict:
    """
    Address → roof size + price range, in seconds. Uses the same measurement
    stack as the full editor: Google Solar (true 3D roof area, measured pitch)
    with OSM footprint fallback (plan area × average slope factor).
    """
    ip = (request.client.host if request.client else "?") or "?"
    if not _rate_ok(ip):
        raise HTTPException(status_code=429, detail="Too many quotes — please try again later.")

    db = get_supabase()
    w = _widget_by_key(db, widget_key)

    from app.services import location_service
    result = await location_service.search_address(payload.address, with_geographies=False)
    if not result.matches:
        return {"found": False, "message": "We couldn't find that address — check the spelling and include the city."}
    m = result.matches[0]

    squares: Optional[float] = None
    source = "none"
    try:
        from app.services import solar_service
        solar = await solar_service.get_building_insights(m.lat, m.lng)
        if solar.get("available") and (solar.get("whole_roof_area_sqft") or 0) > 100:
            squares = float(solar["whole_roof_area_sqft"]) / 100.0
            source = "solar"
    except Exception as e:
        logger.info("widget solar lookup failed: %s", e)

    if squares is None:
        try:
            from app.services import footprint_service
            fp = await footprint_service.get_building_footprint(m.lat, m.lng)
            if fp.get("available") and fp.get("ring"):
                plan_sqft = _ring_area_sqft(fp["ring"])
                if plan_sqft > 200:
                    squares = plan_sqft * FOOTPRINT_SLOPE_FACTOR / 100.0
                    source = "footprint"
        except Exception as e:
            logger.info("widget footprint lookup failed: %s", e)

    if squares is None:
        return {
            "found": True,
            "measured": False,
            "address": m.matched_address,
            "lat": m.lat, "lng": m.lng,
            "message": "We located the home but couldn't measure the roof automatically — leave your info and we'll measure it for you (free).",
        }

    order_squares = squares * WASTE_FACTOR
    lo = round(order_squares * float(w.get("price_low") or 450) / 50.0) * 50
    hi = round(order_squares * float(w.get("price_high") or 650) / 50.0) * 50
    return {
        "found": True,
        "measured": True,
        "address": m.matched_address,
        "lat": m.lat, "lng": m.lng,
        "squares": round(squares, 1),
        "roof_sqft": round(squares * 100),
        "price_low": lo,
        "price_high": hi,
        "source": source,
        "message": "Estimated from aerial + solar measurement data. Final quote follows an on-site or detailed remote measurement.",
    }


class LeadRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    phone: Optional[str] = Field(None, max_length=32)
    email: Optional[str] = Field(None, max_length=160)
    address: str = Field(..., min_length=6, max_length=200)
    lat: Optional[float] = None
    lng: Optional[float] = None
    squares_estimate: Optional[float] = Field(None, ge=0, lt=1000)
    price_low: Optional[float] = Field(None, ge=0)
    price_high: Optional[float] = Field(None, ge=0)
    quote_source: Optional[str] = Field(None, max_length=20)
    # Qualification context from the quote page (material interest, timeline,
    # insurance) — folded into notes so the contractor sees it at a glance.
    notes: Optional[str] = Field(None, max_length=600)


@router.post("/w/{widget_key}/lead")
async def capture_lead(widget_key: str, payload: LeadRequest, request: Request) -> dict:
    ip = (request.client.host if request.client else "?") or "?"
    if not _rate_ok(ip):
        raise HTTPException(status_code=429, detail="Please try again later.")
    if not payload.phone and not payload.email:
        raise HTTPException(status_code=422, detail="A phone number or email is required so the contractor can reach you.")

    db = get_supabase()
    w = _widget_by_key(db, widget_key)
    row = {
        "user_id": w["user_id"],
        "widget_key": widget_key,
        "name": payload.name.strip(),
        "phone": (payload.phone or "").strip() or None,
        "email": (payload.email or "").strip() or None,
        "address": payload.address.strip(),
        "lat": payload.lat, "lng": payload.lng,
        "squares_estimate": payload.squares_estimate,
        "price_low": payload.price_low, "price_high": payload.price_high,
        "quote_source": payload.quote_source or "none",
        "notes": (payload.notes or "").strip() or None,
    }
    ins = db.table("widget_leads").insert({k: v for k, v in row.items() if v is not None}).execute()
    if not ins.data:
        raise HTTPException(status_code=500, detail="Could not save your request — please call instead.")
    return {"ok": True, "message": f"Thanks {payload.name.split(' ')[0]}! {w.get('company_name') or 'The team'} will reach out shortly."}


# ---------------------------------------------------------------------------
# Contractor (JWT)
# ---------------------------------------------------------------------------

@router.get("/my-widget")
async def my_widget(user: dict = Depends(require_user)) -> dict:
    """Get (or lazily create) this contractor's widget."""
    db = get_supabase()
    res = db.table("quote_widgets").select("*").eq("user_id", user["id"]).limit(1).execute()
    if res.data:
        return res.data[0]
    # Seed from the contractor profile so the widget is branded from day one.
    company, phone = None, None
    try:
        prof = db.table("contractor_profiles").select("company_name, phone").eq("user_id", user["id"]).limit(1).execute()
        if prof.data:
            company = prof.data[0].get("company_name")
            phone = prof.data[0].get("phone")
    except Exception:
        pass
    row = {
        "user_id": user["id"],
        "widget_key": secrets.token_urlsafe(12),
        "company_name": company,
        "phone": phone,
    }
    ins = db.table("quote_widgets").insert(row).execute()
    if not ins.data:
        raise HTTPException(status_code=500, detail="Could not create widget.")
    return ins.data[0]


class WidgetSettings(BaseModel):
    enabled: Optional[bool] = None
    company_name: Optional[str] = Field(None, max_length=120)
    phone: Optional[str] = Field(None, max_length=32)
    price_low: Optional[float] = Field(None, ge=50, le=5000)
    price_high: Optional[float] = Field(None, ge=50, le=5000)


@router.patch("/my-widget")
async def update_widget(payload: WidgetSettings, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    patch = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(status_code=422, detail="Nothing to update.")
    patch["updated_at"] = "now()"
    res = db.table("quote_widgets").update(patch).eq("user_id", user["id"]).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="No widget yet — load it first.")
    return res.data[0]


@router.get("/leads")
async def list_leads(status: Optional[str] = None, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    q = db.table("widget_leads").select("*").eq("user_id", user["id"]).order("created_at", desc=True).limit(200)
    if status:
        q = q.eq("status", status)
    rows = q.execute().data or []
    counts: dict[str, int] = {}
    for r in db.table("widget_leads").select("status").eq("user_id", user["id"]).execute().data or []:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return {"leads": rows, "counts": counts}


class LeadPatch(BaseModel):
    status: Optional[str] = Field(None, pattern="^(new|contacted|quoted|won|lost)$")
    notes: Optional[str] = Field(None, max_length=1000)


@router.patch("/leads/{lead_id}")
async def update_lead(lead_id: str, payload: LeadPatch, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    patch = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(status_code=422, detail="Nothing to update.")
    patch["updated_at"] = "now()"
    res = db.table("widget_leads").update(patch).eq("id", lead_id).eq("user_id", user["id"]).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Lead not found.")
    return res.data[0]
