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

# Financing teaser: typical unsecured home-improvement terms. Presentation
# only — clearly labeled an estimate, never a lending offer.
FINANCING_APR = 0.0999
FINANCING_MONTHS = 120


def _monthly_payment(principal: float) -> int:
    r = FINANCING_APR / 12.0
    n = FINANCING_MONTHS
    return max(1, round(principal * r / (1.0 - (1.0 + r) ** -n)))


def _calibration_for_user(db, user_id: str) -> Optional[dict]:
    """Per-contractor field-verified bias (from roof_actuals). Only trusted
    with 3+ verified jobs; correction capped at ±10%. Returns None when we
    don't have enough data to responsibly adjust anything."""
    try:
        from app.api.v1.roofing_v2 import _calibration_stats
        stats = _calibration_stats(db, user_id)
    except Exception:
        return None
    if not stats or (stats.get("jobs") or 0) < 3:
        return None
    bias = max(-10.0, min(10.0, float(stats.get("bias_pct") or 0.0)))
    if abs(bias) < 0.5:
        return None
    return {"jobs": stats["jobs"], "bias_pct": bias}


def _quote_presentation(
    squares: float,
    price_low: float,
    price_high: float,
    source: str,
    calibration: Optional[dict] = None,
) -> dict:
    """Good/better/best tiers + financing teaser + show-the-math breakdown +
    the honest band. Pure presentation over already-measured numbers — the
    only value adjustment is the (capped, disclosed) field calibration."""
    good = round(price_low / 50.0) * 50
    best = round(price_high / 50.0) * 50
    better = round((price_low + price_high) / 2.0 / 50.0) * 50
    tiers = [
        {"name": "Good", "headline": "Quality architectural shingles",
         "detail": "Solid, code-compliant replacement with a standard workmanship warranty.",
         "price": good},
        {"name": "Better", "headline": "Upgraded shingles + extended warranty",
         "detail": "Thicker architectural shingles, upgraded underlayment, longer coverage.",
         "price": better},
        {"name": "Best", "headline": "Premium / designer system",
         "detail": "Top-line shingles, full system warranty, premium ventilation package.",
         "price": best},
    ]

    order_squares = squares * WASTE_FACTOR
    if source == "solar":
        band = {
            "level": "tight",
            "how": "Measured in true 3D from Google's aerial solar data — real roof area and pitch, the same data solar installers use.",
        }
    elif source == "footprint":
        band = {
            "level": "wider",
            "how": "Measured from the building footprint with a typical roof pitch assumed. Accurate for most homes, but a steep or complex roof can move the final number — that's why the range is wider.",
        }
    else:
        band = {"level": "unknown", "how": "This roof couldn't be measured automatically — the range is a placeholder until a free detailed measurement."}

    math_steps = {
        "roof_sqft": round(squares * 100),
        "squares": round(squares, 1),
        "waste_pct": round((WASTE_FACTOR - 1) * 100),
        "order_squares": round(order_squares, 1),
        "rate_low_per_sq": round(price_low / order_squares) if order_squares else None,
        "rate_high_per_sq": round(price_high / order_squares) if order_squares else None,
        "method": source,
        "slope_factor": FOOTPRINT_SLOPE_FACTOR if source == "footprint" else None,
    }
    if calibration:
        math_steps["calibration"] = {
            "jobs": calibration["jobs"],
            "adjust_pct": -calibration["bias_pct"],
            "note": f"Adjusted {-calibration['bias_pct']:+.1f}% based on {calibration['jobs']} field-verified jobs by this contractor.",
        }

    return {
        "tiers": tiers,
        "financing": {
            "from_per_month": _monthly_payment(good),
            "disclaimer": f"Estimated payment at {FINANCING_APR*100:.2f}% APR over {FINANCING_MONTHS//12} years. Subject to credit approval — not a lending offer.",
        },
        "band": band,
        "math": math_steps,
    }

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

def _branding_for(db, w: dict) -> dict:
    """Company branding, LIVE from the contractor profile when set (single
    source of truth — onboarding/profile edits personalize everything at
    once), falling back to widget-level values."""
    company, phone = w.get("company_name"), w.get("phone")
    try:
        prof = db.table("contractor_profiles").select("company_name, phone").eq("user_id", w["user_id"]).limit(1).execute()
        if prof.data:
            company = prof.data[0].get("company_name") or company
            phone = prof.data[0].get("phone") or phone
    except Exception:
        pass
    return {"company_name": company or "Your local roofing pro", "phone": phone or ""}


@router.get("/w/{widget_key}")
async def widget_config(widget_key: str) -> dict:
    """Branding for the public quote page — never leaks pricing internals."""
    db = get_supabase()
    w = _widget_by_key(db, widget_key)
    return _branding_for(db, w)


class LocateRequest(BaseModel):
    address: Optional[str] = Field(None, min_length=6, max_length=200)
    lat: Optional[float] = Field(None, ge=-90, le=90)     # "use my location" path
    lng: Optional[float] = Field(None, ge=-180, le=180)


@router.post("/w/{widget_key}/locate")
async def locate(widget_key: str, payload: LocateRequest, request: Request) -> dict:
    """Step 1-2 of RoofIQ: resolve the address (or device coords) and return a
    satellite tile the homeowner can confirm their roof on. The tile URL is
    routed through the same-origin proxy so no provider key is exposed."""
    ip = (request.client.host if request.client else "?") or "?"
    if not _rate_ok(ip):
        raise HTTPException(status_code=429, detail="Too many requests — please try again later.")
    db = get_supabase()
    _widget_by_key(db, widget_key)

    lat, lng, address = payload.lat, payload.lng, None
    if lat is None or lng is None:
        if not payload.address:
            raise HTTPException(status_code=422, detail="Enter your address (or allow location access).")
        from app.services import location_service
        result = await location_service.search_address(payload.address, with_geographies=False)
        if not result.matches:
            return {"found": False, "message": "We couldn't find that address — check the spelling and include the city."}
        m = result.matches[0]
        lat, lng, address = m.lat, m.lng, m.matched_address

    try:
        from app.services import imagery_service
        from urllib.parse import quote as _q
        tile = await imagery_service.fetch_satellite_image(lat, lng, zoom=20, width_px=1280, height_px=960)
        return {
            "found": True,
            "lat": lat, "lng": lng,
            "address": address or "Your location",
            "imagery": {
                "url": f"/api/v1/roofing/v2/imagery/proxy?url={_q(tile.url, safe='')}",
                "width_px": tile.width_px,
                "height_px": tile.height_px,
                "feet_per_pixel": tile.feet_per_pixel,
            },
        }
    except Exception as e:
        logger.info("widget locate imagery failed: %s", e)
        # No tile ≠ no lead: quote can still run from the geocoded point.
        return {"found": True, "lat": lat, "lng": lng, "address": address or "Your location", "imagery": None}


class QuoteRequest(BaseModel):
    address: str = Field(..., min_length=2, max_length=200)
    # Confirmed-pin path (RoofIQ): measure exactly where the homeowner tapped —
    # the same anchoring trick that fixed wrong-building lookups for contractors.
    lat: Optional[float] = Field(None, ge=-90, le=90)
    lng: Optional[float] = Field(None, ge=-180, le=180)


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

    if payload.lat is not None and payload.lng is not None:
        class _M:                                   # confirmed pin — no re-geocode
            lat = payload.lat
            lng = payload.lng
            matched_address = payload.address
        m = _M()
    else:
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

    # Calibrated Squares: if this contractor has 3+ field-verified jobs on
    # record, correct the measurement by their earned bias (capped ±10%) —
    # accuracy that compounds with use, disclosed in the math breakdown.
    calibration = _calibration_for_user(db, w["user_id"])
    if calibration:
        squares = squares / (1.0 + calibration["bias_pct"] / 100.0)

    order_squares = squares * WASTE_FACTOR
    # Default $/square when the contractor hasn't set their own rate. Kept
    # deliberately moderate ($425–$550 installed) so out-of-box quotes don't
    # read as steep; contractors tune this in RoofIQ settings.
    lo = round(order_squares * float(w.get("price_low") or 425) / 50.0) * 50
    hi = round(order_squares * float(w.get("price_high") or 550) / 50.0) * 50

    # Honest band: a footprint-based measure presents a wider range than a
    # true-3D solar measure, and says why in plain English.
    if source == "footprint":
        lo = round(lo * 0.93 / 50.0) * 50
        hi = round(hi * 1.07 / 50.0) * 50

    presentation = _quote_presentation(squares, lo, hi, source, calibration)
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
        **presentation,
        "message": "Estimated from aerial + solar measurement data. Final quote follows an on-site or detailed remote measurement.",
    }


class LeadRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    phone: Optional[str] = Field(None, max_length=32)
    email: Optional[str] = Field(None, max_length=160)
    address: str = Field(..., min_length=2, max_length=200)
    lat: Optional[float] = None
    lng: Optional[float] = None
    squares_estimate: Optional[float] = Field(None, ge=0, lt=1000)
    price_low: Optional[float] = Field(None, ge=0)
    price_high: Optional[float] = Field(None, ge=0)
    quote_source: Optional[str] = Field(None, max_length=20)
    # Qualification context from the quote page (material interest, timeline,
    # insurance) — folded into notes so the contractor sees it at a glance.
    notes: Optional[str] = Field(None, max_length=600)
    # RoofIQ qualification + report snapshot
    roof_age: Optional[str] = Field(None, max_length=20)         # '0-5'|'5-15'|'15-25'|'25+'|'unsure'
    stories: Optional[int] = Field(None, ge=1, le=4)
    issues: Optional[list[str]] = None                            # leak/storm_damage/missing_shingles/sagging/planning
    roof_confirmed: bool = False                                  # homeowner tapped the pin
    roof_sqft: Optional[float] = Field(None, ge=0)
    imagery_url: Optional[str] = Field(None, max_length=800)      # proxied tile shown at confirm
    # TCPA: the homeowner's explicit consent to be texted. Defaults False so a
    # legacy/omitting client never triggers an outbound SMS without a record.
    sms_consent: bool = False
    # Qualification v3 — the questions a real estimator asks.
    work_type: Optional[str] = Field(None, pattern="^(replace|repair|unsure)$")
    condition: Optional[str] = Field(None, pattern="^(no_damage|visible_damage|unsure)$")
    rooftop_items: Optional[list[str]] = None      # satellite_dish/solar_panels/hvac/antenna/nothing/unsure
    chimney_skylights: Optional[bool] = None
    attic: Optional[bool] = None
    drainage: Optional[str] = Field(None, pattern="^(external_gutters|internal_gutters|none|unsure)$")
    # Honeypot: a CSS-hidden field humans never fill. Bots do. If it has a
    # value we return a fake success and store NOTHING.
    website: Optional[str] = Field(None, max_length=200)


_VALID_ROOFTOP = {"satellite_dish", "solar_panels", "hvac", "antenna", "nothing", "unsure"}


_VALID_ISSUES = {"leak", "storm_damage", "missing_shingles", "sagging", "planning"}


def _score_lead(p: "LeadRequest") -> tuple[int, list[str]]:
    """Deterministic, explainable lead score (0-100). No ML pretense — every
    point has a reason the contractor can read."""
    score, reasons = 0, []
    if p.phone:
        score += 20; reasons.append("Left a phone number (+20)")
    if p.email:
        score += 10; reasons.append("Left an email (+10)")
    if p.roof_confirmed:
        score += 15; reasons.append("Confirmed their roof on the map (+15)")
    if p.roof_age == "25+":
        score += 20; reasons.append("Roof 25+ years old (+20)")
    elif p.roof_age == "15-25":
        score += 15; reasons.append("Roof 15-25 years old (+15)")
    elif p.roof_age == "5-15":
        score += 5; reasons.append("Roof 5-15 years old (+5)")
    issues = set(p.issues or []) & _VALID_ISSUES
    if "leak" in issues:
        score += 25; reasons.append("Active leak (+25)")
    elif "storm_damage" in issues:
        score += 22; reasons.append("Storm damage (+22)")
    elif issues - {"planning"}:
        score += 15; reasons.append("Visible roof issue (+15)")
    n = (p.notes or "").lower()
    if "as soon as possible" in n:
        score += 15; reasons.append("Timeline: ASAP (+15)")
    elif "1\u20133 months" in n or "1-3 months" in n:
        score += 8; reasons.append("Timeline: 1-3 months (+8)")
    if "insurance" in n:
        score += 10; reasons.append("Possible insurance claim (+10)")
    if p.quote_source in ("solar", "footprint"):
        score += 5; reasons.append("Roof auto-measured (+5)")
    if p.work_type == "replace":
        score += 15; reasons.append("Wants full replacement (+15)")
    elif p.work_type == "repair":
        score += 5; reasons.append("Wants a repair (+5)")
    if p.condition == "visible_damage":
        score += 12; reasons.append("Reports visible damage (+12)")
    if p.chimney_skylights:
        score += 4; reasons.append("Chimney/skylights — flashing scope (+4)")
    if "solar_panels" in set(p.rooftop_items or []):
        score += 4; reasons.append("Solar panels — detach/reset scope (+4)")
    return min(100, score), reasons


@router.post("/w/{widget_key}/lead")
async def capture_lead(widget_key: str, payload: LeadRequest, request: Request) -> dict:
    ip = (request.client.host if request.client else "?") or "?"
    if not _rate_ok(ip):
        raise HTTPException(status_code=429, detail="Please try again later.")
    if payload.website:
        # Honeypot tripped — swallow silently so the bot thinks it worked.
        return {"ok": True, "report_url": None, "message": "Thanks! The team will reach out shortly."}
    if not payload.phone and not payload.email:
        raise HTTPException(status_code=422, detail="A phone number or email is required so the contractor can reach you.")

    from datetime import datetime, timezone
    db = get_supabase()
    w = _widget_by_key(db, widget_key)
    score, reasons = _score_lead(payload)
    report_token = secrets.token_urlsafe(12)
    has_sms_consent = bool(payload.sms_consent and payload.phone)
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
        "roof_age": payload.roof_age,
        "stories": payload.stories,
        "issues": sorted(set(payload.issues or []) & _VALID_ISSUES) or None,
        "details": {
            "work_type": payload.work_type,
            "condition": payload.condition,
            "rooftop_items": sorted(set(payload.rooftop_items or []) & _VALID_ROOFTOP) or None,
            "chimney_skylights": payload.chimney_skylights,
            "attic": payload.attic,
            "drainage": payload.drainage,
            # Consent proof for TCPA: whether the homeowner agreed to be texted,
            # captured at submission time (with the phone they consented for).
            "sms_consent": has_sms_consent,
            "sms_consent_at": datetime.now(timezone.utc).isoformat() if has_sms_consent else None,
        },
        "lead_score": score,
        "score_reasons": reasons,
        "report_token": report_token,
        "quote": {
            "roof_sqft": payload.roof_sqft,
            "squares": payload.squares_estimate,
            "price_low": payload.price_low,
            "price_high": payload.price_high,
            "source": payload.quote_source,
            "roof_confirmed": payload.roof_confirmed,
            "imagery_url": payload.imagery_url,
        },
    }
    try:
        ins = db.table("widget_leads").insert({k: v for k, v in row.items() if v is not None}).execute()
    except Exception as e:
        # Only degrade to the base row when the failure is clearly a missing
        # RoofIQ column (pre-migration schema). A transient DB error must NOT
        # silently strip the score/report/details — retry the full row once,
        # then surface the failure honestly.
        msg = str(e).lower()
        schema_gap = ("column" in msg and ("does not exist" in msg or "could not find" in msg)) or "pgrst204" in msg
        if schema_gap:
            logger.error("widget_leads is missing RoofIQ columns — run supabase/migrations/20260710_roofiq_details.sql. Degrading lead %s", payload.name)
            base = {k: row[k] for k in ("user_id", "widget_key", "name", "phone", "email", "address",
                                        "lat", "lng", "squares_estimate", "price_low", "price_high",
                                        "quote_source", "notes") if row.get(k) is not None}
            ins = db.table("widget_leads").insert(base).execute()
            report_token = None
        else:
            logger.warning("widget_leads insert failed (transient?), retrying once: %s", e)
            try:
                ins = db.table("widget_leads").insert({k: v for k, v in row.items() if v is not None}).execute()
            except Exception:
                logger.exception("widget_leads insert failed twice — lead NOT captured")
                raise HTTPException(status_code=500, detail="Could not save your request — please call instead.")
    if not ins.data:
        raise HTTPException(status_code=500, detail="Could not save your request — please call instead.")
    widget_lead_id = ins.data[0].get("id")

    # One pipeline, not two. crm_leads is the pipeline system-of-record;
    # widget_leads is the immutable capture log. We LINK them (widget_lead_id +
    # first-class lead_score/report_token on the CRM row) so the kanban reads
    # the RoofIQ intelligence directly instead of re-parsing a notes string,
    # and the two records can never silently drift.
    # Best-effort — CRM hiccups must never lose the lead itself.
    try:
        est = None
        if payload.price_low and payload.price_high:
            est = round((float(payload.price_low) + float(payload.price_high)) / 2)
        crm_notes = " · ".join(x for x in [
            f"🎯 RoofIQ lead — score {score}/100" if score else "🎯 RoofIQ lead",
            {"replace": "wants REPLACEMENT", "repair": "wants repair"}.get(payload.work_type or ""),
            "visible damage" if payload.condition == "visible_damage" else None,
            "chimney/skylights" if payload.chimney_skylights else None,
            ("on roof: " + ", ".join(sorted((set(payload.rooftop_items or []) & _VALID_ROOFTOP) - {"nothing", "unsure"})))
                if set(payload.rooftop_items or []) & _VALID_ROOFTOP - {"nothing", "unsure"} else None,
            {"internal_gutters": "internal gutters", "none": "no gutters"}.get(payload.drainage or ""),
            f"roof age {payload.roof_age}" if payload.roof_age else None,
            f"{payload.stories} stories" if payload.stories else None,
            ("issues: " + ", ".join(sorted(set(payload.issues or []) & _VALID_ISSUES))) if payload.issues else None,
            f"saw ${payload.price_low:,.0f}–${payload.price_high:,.0f}" if payload.price_low and payload.price_high else None,
            f"report: /r/{report_token}" if report_token else None,
        ] if x)
        crm_row = {
            "user_id": w["user_id"],
            "name": payload.name.strip(),
            "phone": (payload.phone or "").strip(),
            "email": (payload.email or "").strip(),
            "address": payload.address.strip(),
            "stage": "new",
            "notes": crm_notes,
            "estimated_value": est or 0,
            # Linkage + first-class intelligence (needs 20260712_crm_lead_link).
            "source": "roofiq",
            "widget_lead_id": widget_lead_id,
            "lead_score": score,
            "report_token": report_token,
        }
        try:
            db.table("crm_leads").insert(crm_row).execute()
        except Exception as e:
            msg = str(e).lower()
            if ("column" in msg and ("does not exist" in msg or "could not find" in msg)) or "pgrst204" in msg:
                # Pre-migration crm_leads — the report_token is still embedded in
                # notes, so the CRM keeps working (score/report parsed from text).
                logger.warning("crm_leads missing link columns — run 20260712_crm_lead_link.sql; inserting base row")
                for k in ("source", "widget_lead_id", "lead_score", "report_token"):
                    crm_row.pop(k, None)
                db.table("crm_leads").insert(crm_row).execute()
            else:
                raise
    except Exception as e:
        logger.info("crm auto-import failed (lead still captured): %s", e)

    # Speed-to-lead SMS: fire-and-forget — never delays or breaks capture.
    # No-ops entirely unless Twilio env vars are configured.
    try:
        from app.services.sms_service import notify_new_lead, sms_configured
        if sms_configured():
            import asyncio
            branding = _branding_for(db, w)
            asyncio.create_task(notify_new_lead(
                contractor_phone=branding.get("phone"),
                # Homeowner is texted ONLY with logged TCPA consent. The
                # contractor alert (a business notifying itself about its own
                # lead) always fires — that's not consumer solicitation.
                homeowner_phone=payload.phone if has_sms_consent else None,
                company_name=branding.get("company_name") or "Your roofing contractor",
                lead_name=payload.name.strip(),
                address=payload.address.strip(),
                score=score,
                price_low=payload.price_low,
                price_high=payload.price_high,
                report_token=report_token,
            ))
    except Exception as e:
        logger.info("speed-to-lead sms skipped: %s", e)

    # RoofVision: render the homeowner's own roof in the shingle colors the
    # contractor sells. Fire-and-forget (each render spends image-gen budget and
    # takes 15–90s) — it must never slow capture. Off unless ROOFVISION_ENABLED
    # and an image provider is set; results land on the lead's details.renders
    # for both the report and the contractor to reuse.
    try:
        from app.services.roofvision_service import roofvision_enabled
        if roofvision_enabled() and widget_lead_id and payload.lat is not None and payload.lng is not None:
            import asyncio
            asyncio.create_task(_render_roofvision(widget_lead_id, payload.lat, payload.lng, w.get("roofvision_palette")))
    except Exception as e:
        logger.info("roofvision skipped: %s", e)

    return {
        "ok": True,
        "report_url": f"/r/{report_token}" if report_token else None,
        "message": f"Thanks {payload.name.split(' ')[0]}! {w.get('company_name') or 'The team'} will reach out shortly.",
    }


async def _render_roofvision(widget_lead_id: str, lat: float, lng: float, palette=None) -> None:
    """Background: render the roof in the contractor's shingle colors and merge
    them into the lead's details.renders. Best-effort — swallows everything."""
    try:
        from app.services.roofvision_service import render_roof_options
        renders = await render_roof_options(lat, lng, palette if isinstance(palette, list) else None)
        if not renders:
            return
        db = get_supabase()
        cur = db.table("widget_leads").select("details").eq("id", widget_lead_id).limit(1).execute()
        details = (cur.data[0].get("details") if cur.data else None) or {}
        details["renders"] = renders
        db.table("widget_leads").update({"details": details}).eq("id", widget_lead_id).execute()
    except Exception as e:
        logger.info("roofvision background render failed: %s", e)


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


@router.get("/roofvision/catalog")
async def roofvision_catalog(user: dict = Depends(require_user)) -> dict:
    """The pickable shingle catalog for the palette-curation setting."""
    from app.services.roofvision_service import catalog
    return {"catalog": catalog()}


class WidgetSettings(BaseModel):
    enabled: Optional[bool] = None
    company_name: Optional[str] = Field(None, max_length=120)
    phone: Optional[str] = Field(None, max_length=32)
    price_low: Optional[float] = Field(None, ge=50, le=5000)
    price_high: Optional[float] = Field(None, ge=50, le=5000)
    # RoofVision palette — ordered catalog keys the contractor wants rendered.
    roofvision_palette: Optional[list[str]] = Field(None, max_length=8)


@router.patch("/my-widget")
async def update_widget(payload: WidgetSettings, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    patch = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(status_code=422, detail="Nothing to update.")
    # Validate the palette against the real catalog (drop unknowns, keep order).
    if "roofvision_palette" in patch:
        from app.services.roofvision_service import resolve_palette
        patch["roofvision_palette"] = [o["key"] for o in resolve_palette(patch["roofvision_palette"])]
    patch["updated_at"] = "now()"
    try:
        res = db.table("quote_widgets").update(patch).eq("user_id", user["id"]).execute()
    except Exception as e:
        # Pre-migration schema (no roofvision_palette column) — retry without it
        # so price/branding edits still save; palette lights up post-migration.
        msg = str(e).lower()
        if "roofvision_palette" in patch and (("column" in msg and "does not exist" in msg) or "pgrst204" in msg):
            logger.warning("quote_widgets missing roofvision_palette — run 20260713_roofvision_palette.sql")
            patch.pop("roofvision_palette", None)
            res = db.table("quote_widgets").update(patch).eq("user_id", user["id"]).execute()
        else:
            raise
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


# ---------------------------------------------------------------------------
# RoofIQ: web report, funnel events, contractor analytics
# ---------------------------------------------------------------------------

@router.get("/report/{token}")
async def homeowner_report(token: str, request: Request, count: bool = True) -> dict:
    """The homeowner's shareable Roof Intelligence Report (web, not PDF —
    live CTAs, mobile-first, and every open is a speed-to-lead signal).
    `count=false` is used by the OG-image/metadata generators so link
    previews don't inflate the re-open signal."""
    if not token or len(token) > 64:
        raise HTTPException(status_code=404, detail="Report not found.")
    ip = (request.client.host if request.client else "?") or "?"
    if not _rate_ok(f"rp-{ip}"):
        raise HTTPException(status_code=429, detail="Too many requests — try again shortly.")
    db = get_supabase()
    res = db.table("widget_leads").select("*").eq("report_token", token).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Report not found.")
    lead = res.data[0]
    w = db.table("quote_widgets").select("company_name, phone").eq("widget_key", lead["widget_key"]).limit(1).execute()
    company = (w.data[0] if w.data else {})

    # Trust & Verify: the contractor profile is the single source of truth for
    # verifiable credentials (license #, service area). Falls back to the
    # widget-level company name/phone when the profile is sparse.
    prof: dict = {}
    try:
        pr = db.table("contractor_profiles").select(
            "company_name, phone, license_number, city, state"
        ).eq("user_id", lead["user_id"]).limit(1).execute()
        if pr.data:
            prof = pr.data[0]
    except Exception:
        pass
    service_area = ", ".join(x for x in [prof.get("city"), prof.get("state")] if x) or None

    # Every open counts — the contractor inbox surfaces "re-opened their report".
    if count:
        try:
            db.table("widget_leads").update({"report_opens": int(lead.get("report_opens") or 0) + 1}).eq("id", lead["id"]).execute()
            db.table("widget_events").insert({
                "widget_key": lead["widget_key"], "session_id": f"report-{token[:8]}",
                "event": "report_opened",
            }).execute()
        except Exception:
            pass

    q = lead.get("quote") or {}

    # Same tiers / financing / honest-band / math the quote page showed —
    # recomputed from the stored snapshot so the report never drifts from
    # what the homeowner was quoted.
    presentation = None
    try:
        sq = float(q.get("squares") or 0)
        p_lo, p_hi = float(q.get("price_low") or 0), float(q.get("price_high") or 0)
        if sq > 0 and p_lo > 0 and p_hi > 0:
            presentation = _quote_presentation(sq, p_lo, p_hi, q.get("source") or "none")
    except Exception:
        presentation = None

    return {
        "first_name": (lead.get("name") or "").split(" ")[0],
        "address": lead.get("address"),
        "created_at": lead.get("created_at"),
        "company_name": prof.get("company_name") or company.get("company_name") or "Your roofing contractor",
        "company_phone": prof.get("phone") or company.get("phone") or "",
        "company_license": prof.get("license_number") or None,
        "service_area": service_area,
        "roof_sqft": q.get("roof_sqft"),
        "squares": q.get("squares"),
        "price_low": q.get("price_low"),
        "price_high": q.get("price_high"),
        "source": q.get("source"),
        "roof_confirmed": bool(q.get("roof_confirmed")),
        "imagery_url": q.get("imagery_url"),
        "roof_age": lead.get("roof_age"),
        "stories": lead.get("stories"),
        "issues": lead.get("issues") or [],
        "details": lead.get("details") or {},
        **(presentation or {}),
    }


# Inspection booking + the contractor calendar live in their own router
# (app/api/v1/appointments.py) — homeowner books from /r/{token}, it lands on
# the contractor's calendar and advances the linked CRM lead to site_visit.


class ColorChoice(BaseModel):
    key: str = Field(..., min_length=1, max_length=40)


@router.post("/report/{token}/select-color")
async def select_color(token: str, payload: ColorChoice, request: Request) -> dict:
    """Record the RoofVision color the homeowner picked on their report, so the
    contractor knows what to lead with and the instant proposal features it.
    Only accepts a key that was actually rendered for this lead."""
    ip = (request.client.host if request.client else "?") or "?"
    if not _rate_ok(f"sc-{ip}"):
        return {"ok": False}
    if not token or len(token) > 64:
        raise HTTPException(status_code=404, detail="Report not found.")
    db = get_supabase()
    res = db.table("widget_leads").select("id, details").eq("report_token", token).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Report not found.")
    details = res.data[0].get("details") or {}
    valid_keys = {r.get("key") for r in (details.get("renders") or [])}
    if payload.key not in valid_keys:
        raise HTTPException(status_code=422, detail="That color isn't available for this report.")
    details["chosen_render"] = payload.key
    try:
        db.table("widget_leads").update({"details": details}).eq("id", res.data[0]["id"]).execute()
    except Exception:
        return {"ok": False}
    return {"ok": True, "chosen": payload.key}


class EventIn(BaseModel):
    session_id: str = Field(..., min_length=4, max_length=64)
    event: str = Field(..., pattern="^(view|address_entered|roof_confirmed|qualified|lead_captured)$")


@router.post("/w/{widget_key}/event")
async def track_event(widget_key: str, payload: EventIn, request: Request) -> dict:
    """Funnel analytics beacon — fire-and-forget from the quote page."""
    ip = (request.client.host if request.client else "?") or "?"
    if not _rate_ok(f"ev-{ip}"):
        return {"ok": False}
    db = get_supabase()
    try:
        w = _widget_by_key(db, widget_key)
        db.table("widget_events").insert({
            "widget_key": w["widget_key"], "session_id": payload.session_id, "event": payload.event,
        }).execute()
    except Exception:
        return {"ok": False}   # analytics must never break the flow
    return {"ok": True}


@router.get("/analytics")
async def widget_analytics(user: dict = Depends(require_user)) -> dict:
    """30-day funnel for the contractor's widget: views → addresses → roofs
    confirmed → qualified → leads, plus lead-quality aggregates."""
    from datetime import datetime, timedelta, timezone
    db = get_supabase()
    w = db.table("quote_widgets").select("widget_key").eq("user_id", user["id"]).limit(1).execute()
    if not w.data:
        return {"funnel": {}, "leads_30d": 0, "avg_score": None}
    key = w.data[0]["widget_key"]
    since = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()

    funnel: dict[str, int] = {}
    try:
        rows = db.table("widget_events").select("event, session_id").eq("widget_key", key).gte("created_at", since).execute().data or []
        seen: dict[str, set] = {}
        for r in rows:
            seen.setdefault(r["event"], set()).add(r["session_id"])
        funnel = {e: len(v) for e, v in seen.items()}
    except Exception:
        pass

    leads = db.table("widget_leads").select("lead_score, created_at").eq("widget_key", key).gte("created_at", since).execute().data or []
    scores = [l["lead_score"] for l in leads if l.get("lead_score") is not None]
    return {
        "funnel": funnel,
        "leads_30d": len(leads),
        "avg_score": round(sum(scores) / len(scores)) if scores else None,
    }
