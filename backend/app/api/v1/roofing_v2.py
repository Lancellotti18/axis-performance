"""
Axis Performance — Roofing v2 API.

New endpoints for the per-facet measurement workflow that produces accurate,
deterministic roof-line measurements and material orders. Coexists with the
legacy /roofing endpoints (which keep working through the
roof_measurements view + INSTEAD OF triggers in the v2 migration).

Endpoints
---------
GET   /v2/imagery/health           — multi-provider satellite health check
POST  /v2/imagery/fetch            — fetch + return tile bytes (base64)

GET   /v2/location/search          — Census Geocoder address search
GET   /v2/location/validate        — single-best match w/ county + FIPS
GET   /v2/location/reverse         — lat/lng → county (FCC)

POST  /v2/runs                     — create a measurement run
GET   /v2/runs/{id}                — load run + facets + edges + penetrations
PATCH /v2/runs/{id}                — update run-level fields (confirmed, etc.)

PUT   /v2/runs/{id}/facets         — bulk-replace facets for a run
PUT   /v2/runs/{id}/edges          — bulk-replace edges (labeled)
GET   /v2/runs/{id}/recompute      — recompute aggregates from facets+edges

POST  /v2/runs/{id}/penetrations         — add a confirmed penetration
DELETE /v2/runs/{id}/penetrations/{pid}  — remove a penetration
GET   /v2/runs/{id}/penetrations/suggest — AI-suggested (user must confirm)

GET   /v2/runs/{id}/materials      — full material list at every waste %
GET   /v2/runs/{id}/report         — redesigned 8-section PDF

GET   /v2/catalog                  — read materials catalog
POST  /v2/siding/measurements      — record a manual siding measurement
GET   /v2/siding/measurements      — list manual siding for a project

All endpoints require an authenticated user (Supabase RLS does the heavy
lifting once data is queried).
"""
from __future__ import annotations

import asyncio
import logging
import math
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from app.core.auth import require_user
from app.core.supabase import get_supabase
from app.services import geometry_service as geo
from app.services import imagery_service
from app.services import location_service
from app.services.materials_engine import (
    RoofTotals, PenetrationSummary, compute_material_lines,
    grand_total, materials_summary, STANDARD_WASTE_PCTS,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# ----------------------------------------------------------------------------
# Imagery
# ----------------------------------------------------------------------------

class ImageryHealthRequest(BaseModel):
    lat: float
    lng: float
    zoom: int = 20
    width_px: int = 2048
    height_px: int = 1366


@router.get("/imagery/health")
async def imagery_health(
    lat: float = Query(...),
    lng: float = Query(...),
    zoom: int = Query(20, ge=10, le=22),
    width_px: int = Query(2048, ge=512, le=4096),
    height_px: int = Query(1366, ge=384, le=4096),
    user: dict = Depends(require_user),
) -> dict:
    """
    Test all configured satellite providers and report which would serve a
    healthy tile for this lat/lng. Used by the aerial-report page so the
    contractor knows imagery is available before they invest in editing.
    """
    return await imagery_service.fetch_health_check(
        lat, lng, zoom=zoom, width_px=width_px, height_px=height_px,
    )


class UpscaleRequest(BaseModel):
    image_url: str
    scale: Literal[2, 4] = 4


@router.post("/imagery/upscale")
async def upscale_imagery(
    payload: UpscaleRequest,
    user: dict = Depends(require_user),
) -> dict:
    """
    AI super-resolution via Replicate's Real-ESRGAN. Returns the upscaled
    image URL (Replicate-hosted, valid ~1 hour). The frontend swaps the
    image src to this URL so the satellite tile becomes visually sharper
    for tracing.

    The math (areas, lengths) is still computed from the ORIGINAL tile's
    metres-per-pixel — the upscaled image is for visualization only.
    """
    from app.services import imagery_enhancement_service as enhance
    import httpx as _httpx

    if not enhance.is_enabled():
        return {
            "status": "disabled",
            "error": (
                "Image enhancement requires REPLICATE_API_KEY on the backend. "
                "Free tier available at replicate.com — set the key in Render env vars."
            ),
        }

    try:
        async with _httpx.AsyncClient(timeout=30) as client:
            r = await client.get(payload.image_url, follow_redirects=True)
            r.raise_for_status()
            img_bytes = r.content
            mt = (r.headers.get("content-type") or "image/png").split(";")[0].strip()
            if mt not in ("image/png", "image/jpeg"):
                mt = "image/png"
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not fetch source image: {e}")

    result = await enhance.upscale_image(img_bytes, mt, scale=payload.scale)
    return result.to_dict(include_bytes=False)


@router.post("/imagery/fetch")
async def imagery_fetch(
    payload: ImageryHealthRequest,
    include_bytes: bool = Query(False),
    user: dict = Depends(require_user),
) -> dict:
    """
    Run the full provider chain and return the winning tile. Set
    include_bytes=true to receive the image as base64 in the response;
    omit for a URL-only payload the frontend fetches directly.
    """
    try:
        result = await imagery_service.fetch_satellite_image(
            payload.lat, payload.lng,
            zoom=payload.zoom,
            width_px=payload.width_px,
            height_px=payload.height_px,
        )
    except RuntimeError as e:
        # All providers failed. This is the case the legacy code surfaced as
        # the dreaded "satellite image could not be downloaded" — now with a
        # detailed payload that lists what was tried.
        raise HTTPException(
            status_code=502,
            detail={
                "message": "All satellite providers failed for this location.",
                "providers_tried": list(imagery_service._PROVIDER_ORDER),
                "underlying_error": str(e),
                "actionable": (
                    "Verify the lat/lng is in the United States and not over open water. "
                    "If the address looks correct, configure MAPBOX_ACCESS_TOKEN or "
                    "MAPTILER_API_KEY on the backend to enable fallback providers."
                ),
            },
        )
    return result.to_dict(include_bytes=include_bytes)


@router.post("/imagery/detect-building")
async def detect_building(
    payload: ImageryHealthRequest,
    user: dict = Depends(require_user),
) -> dict:
    """
    Auto-center helper. Fetches the tile at the requested lat/lng/zoom, asks
    Gemini Vision for the bounding box of the largest building (the subject
    property), and returns:
      * the building bbox + center as image fractions (0..1)
      * a recommended new lat/lng that puts the building in the frame center
      * a suggested zoom so the roof fills ~55% of the frame (better tracing)

    The frontend calls this once after the first imagery load and silently
    re-centers, eliminating the "house is in the corner / I have to nudge 8
    times" problem. If no building is found we return found=false and the
    frontend just keeps the geocoded center.
    """
    import json as _json
    import re as _re
    from app.services.llm import llm_vision

    try:
        result = await imagery_service.fetch_satellite_image(
            payload.lat, payload.lng,
            zoom=payload.zoom, width_px=payload.width_px, height_px=payload.height_px,
        )
    except RuntimeError:
        return {"found": False, "message": "No imagery available to analyze."}

    prompt = """You are analyzing a top-down satellite image to locate the main residential building (the subject property, usually the largest building nearest the image center).

Return ONLY a JSON object with the bounding box of that building as fractions of the image (0.0=left/top, 1.0=right/bottom):
{
  "found": true,
  "x0": 0.30, "y0": 0.25, "x1": 0.70, "y1": 0.65,
  "confidence": 0.8
}

x0,y0 is the top-left corner of the building's bounding box; x1,y1 the bottom-right. Include the whole roof (all wings/garage attached to the main house) but exclude detached sheds, driveways, and neighboring houses. If you cannot confidently find a building, return {"found": false}. Respond with the JSON object only."""

    try:
        text = await llm_vision(
            result.image_bytes, result.media_type, prompt, max_tokens=300,
        )
        text = text.strip()
        text = _re.sub(r"^```(?:json)?\s*", "", text, flags=_re.MULTILINE)
        text = _re.sub(r"\s*```\s*$", "", text)
        a, b = text.find("{"), text.rfind("}")
        if a < 0 or b < 0:
            return {"found": False, "message": "Vision returned no JSON."}
        parsed = _json.loads(text[a:b + 1])
    except Exception as e:
        return {"found": False, "message": f"Vision analysis error: {e}"}

    if not parsed.get("found"):
        return {"found": False, "message": "No building confidently located."}

    try:
        x0 = max(0.0, min(1.0, float(parsed["x0"])))
        y0 = max(0.0, min(1.0, float(parsed["y0"])))
        x1 = max(0.0, min(1.0, float(parsed["x1"])))
        y1 = max(0.0, min(1.0, float(parsed["y1"])))
    except (KeyError, TypeError, ValueError):
        return {"found": False, "message": "Vision bbox was malformed."}

    if x1 <= x0 or y1 <= y0:
        return {"found": False, "message": "Vision bbox had zero area."}

    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2

    # Offset of bbox center from image center, in metres.
    mpp = result.metres_per_pixel
    east_m = (cx - 0.5) * payload.width_px * mpp
    north_m = -(cy - 0.5) * payload.height_px * mpp   # image y grows downward

    new_lat = payload.lat + (north_m / 111320.0)
    new_lng = payload.lng + (
        east_m / (111320.0 * math.cos(math.radians(payload.lat)))
    )

    # Suggest a zoom so the building fills ~55% of the frame. Each +1 zoom
    # level quadruples the coverage fraction (linear dimensions double).
    coverage = (x1 - x0) * (y1 - y0)
    target = 0.55
    suggested_zoom = payload.zoom
    if coverage > 0:
        zoom_delta = round(0.5 * math.log2(target / coverage))
        suggested_zoom = max(19, min(22, payload.zoom + zoom_delta))

    return {
        "found": True,
        "bbox_frac": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
        "center_frac": {"x": cx, "y": cy},
        "recenter": {"lat": new_lat, "lng": new_lng},
        "coverage_frac": round(coverage, 3),
        "suggested_zoom": suggested_zoom,
        "confidence": parsed.get("confidence", 0.7),
    }


# ----------------------------------------------------------------------------
# Location
# ----------------------------------------------------------------------------

@router.get("/location/search")
async def location_search(
    q: str = Query(..., min_length=4),
    with_geographies: bool = Query(False, description="Include county/FIPS (slower)"),
    user: dict = Depends(require_user),
) -> dict:
    """
    Address autocomplete. with_geographies=False returns matches in ~200ms
    (no county). Use with_geographies=true on the final selection.
    """
    result = await location_service.search_address(q, with_geographies=with_geographies)
    return result.to_dict()


@router.get("/location/validate")
async def location_validate(
    address: str = Query(..., min_length=4),
    user: dict = Depends(require_user),
) -> dict:
    """Single best match including county + FIPS."""
    match = await location_service.validate_address(address)
    if match is None:
        raise HTTPException(
            status_code=404,
            detail=(
                "Could not validate that address with the US Census Geocoder. "
                "Try including the city, state, and ZIP, or use the reverse-lookup "
                "endpoint with coordinates."
            ),
        )
    return match.to_dict()


@router.get("/location/reverse")
async def location_reverse(
    lat: float = Query(...),
    lng: float = Query(...),
    user: dict = Depends(require_user),
) -> dict:
    """lat/lng → county info via the FCC Area API."""
    info = await location_service.reverse_county(lat, lng)
    if info is None:
        raise HTTPException(status_code=404, detail="No county data for that point.")
    return info


# ----------------------------------------------------------------------------
# Runs (measurement runs)
# ----------------------------------------------------------------------------

RUN_SOURCE = Literal["manual", "blueprint", "aerial_solar", "aerial_outline", "photo", "hybrid"]


class CreateRunRequest(BaseModel):
    project_id: str
    blueprint_id: Optional[str] = None
    source: RUN_SOURCE = "aerial_outline"
    satellite_image_url: Optional[str] = None
    satellite_provider: Optional[str] = None
    satellite_zoom: Optional[int] = None
    satellite_lat: Optional[float] = None
    satellite_lng: Optional[float] = None
    imagery_health: Optional[float] = None


@router.post("/runs")
async def create_run(req: CreateRunRequest, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    record = req.model_dump(exclude_none=True)
    record["measurement_unverified"] = True
    record["confirmed"] = False
    res = db.table("roof_measurement_runs").insert(record).execute()
    if not res.data:
        raise HTTPException(status_code=500, detail="Failed to create measurement run.")
    return res.data[0]


@router.get("/runs/{run_id}")
async def get_run(run_id: str, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    run = db.table("roof_measurement_runs").select("*").eq("id", run_id).single().execute()
    if not run.data:
        raise HTTPException(status_code=404, detail="Run not found.")
    facets_res = db.table("roof_facets").select("*").eq("run_id", run_id).execute()
    facets = facets_res.data or []
    facet_ids = [f["id"] for f in facets]
    edges: list[dict] = []
    if facet_ids:
        edges_res = db.table("roof_edges").select("*").in_("facet_id", facet_ids).execute()
        edges = edges_res.data or []
    pens_res = db.table("roof_penetrations").select("*").eq("run_id", run_id).execute()
    return {
        "run": run.data,
        "facets": facets,
        "edges": edges,
        "penetrations": pens_res.data or [],
    }


class UpdateRunRequest(BaseModel):
    confirmed: Optional[bool] = None
    notes: Optional[str] = None
    waste_pct_default: Optional[float] = None
    stories: Optional[int] = None
    roof_type: Optional[str] = None
    measurement_unverified: Optional[bool] = None


@router.patch("/runs/{run_id}")
async def update_run(run_id: str, req: UpdateRunRequest, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    updates = {k: v for k, v in req.model_dump(exclude_none=True).items()}
    if "confirmed" in updates and updates["confirmed"]:
        from datetime import datetime, timezone
        updates["confirmed_at"] = datetime.now(timezone.utc).isoformat()
        updates["measurement_unverified"] = False
    res = db.table("roof_measurement_runs").update(updates).eq("id", run_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Run not found.")
    return res.data[0]


# ----------------------------------------------------------------------------
# Facets
# ----------------------------------------------------------------------------

class FacetIn(BaseModel):
    facet_label: str = Field(..., max_length=8)
    polygon: list[list[float]]
    pitch: str = "6/12"
    confidence: float = 0.7
    user_confirmed: bool = False

    @field_validator("polygon")
    @classmethod
    def _check_polygon(cls, v: list[list[float]]) -> list[list[float]]:
        if len(v) < 3:
            raise ValueError("polygon must have at least 3 vertices")
        for p in v:
            if not isinstance(p, list) or len(p) < 2:
                raise ValueError("each vertex must be a [x, y] pair")
        return v


class PutFacetsRequest(BaseModel):
    image_width_px: int = Field(..., ge=64)
    image_height_px: int = Field(..., ge=64)
    zoom: int = Field(..., ge=10, le=22)
    lat: float
    lng: float
    facets: list[FacetIn]


@router.put("/runs/{run_id}/facets")
async def put_facets(
    run_id: str, req: PutFacetsRequest, user: dict = Depends(require_user)
) -> dict:
    """
    Replace all facets for a run. Each facet's plan_area_sqft, true_area_sqft,
    and pitch_degrees are computed server-side so the contractor can't
    accidentally store a wrong number.
    """
    db = get_supabase()

    # Make sure the run exists (RLS will reject otherwise)
    run = db.table("roof_measurement_runs").select("id").eq("id", run_id).single().execute()
    if not run.data:
        raise HTTPException(status_code=404, detail="Run not found.")

    db.table("roof_facets").delete().eq("run_id", run_id).execute()

    rows: list[dict] = []
    for f in req.facets:
        plan = geo.polygon_plan_area_sqft(
            f.polygon, req.lat, req.zoom, req.image_width_px, req.image_height_px,
        )
        mult = geo.slope_multiplier(f.pitch)
        deg = geo.pitch_string_to_degrees(f.pitch)
        orient = geo.longest_edge_orientation_deg(f.polygon)
        rows.append({
            "run_id": run_id,
            "facet_label": f.facet_label,
            "polygon": f.polygon,
            "pitch": f.pitch,
            "pitch_degrees": round(deg, 2),
            "orientation_deg": round(orient, 1) if orient is not None else None,
            "slope_direction": geo.compass_direction(orient),
            "plan_area_sqft": round(plan, 1),
            "true_area_sqft": round(plan * mult, 1),
            "confidence": geo.normalize_confidence(f.confidence),
            "user_confirmed": f.user_confirmed,
        })

    if rows:
        ins = db.table("roof_facets").insert(rows).execute()
        new_facets = ins.data or []
    else:
        new_facets = []

    # Cache image params on the run so we can recompute later without the client.
    db.table("roof_measurement_runs").update({
        "facet_count": len(new_facets),
        "satellite_zoom": req.zoom,
        "satellite_lat": req.lat,
        "satellite_lng": req.lng,
    }).eq("id", run_id).execute()

    return {"facets": new_facets, "count": len(new_facets)}


# ----------------------------------------------------------------------------
# Edges (labeled)
# ----------------------------------------------------------------------------

class EdgeIn(BaseModel):
    facet_label: str
    vertex_index_start: int = Field(..., ge=0)
    vertex_index_end: int = Field(..., ge=0)
    edge_type: Literal[
        "eave", "rake", "ridge", "hip", "valley",
        "gable_end", "wall_intersection", "unlabeled",
    ]
    shared_with_facet_label: Optional[str] = None
    user_confirmed: bool = False


class PutEdgesRequest(BaseModel):
    image_width_px: int
    image_height_px: int
    zoom: int
    lat: float
    edges: list[EdgeIn]


@router.put("/runs/{run_id}/edges")
async def put_edges(
    run_id: str, req: PutEdgesRequest, user: dict = Depends(require_user)
) -> dict:
    """
    Replace all edges for a run. Each edge's plan_length_ft and
    slope_adjusted_ft are computed from the parent facet's polygon and pitch
    (deterministic — no LLM, no guesses).
    """
    db = get_supabase()

    facets_res = db.table("roof_facets").select("id, facet_label, polygon, pitch").eq(
        "run_id", run_id
    ).execute()
    facets = {f["facet_label"]: f for f in (facets_res.data or [])}
    if not facets:
        raise HTTPException(
            status_code=422,
            detail="Cannot put edges before any facets exist for this run.",
        )

    facet_ids = [f["id"] for f in facets.values()]
    db.table("roof_edges").delete().in_("facet_id", facet_ids).execute()

    rows: list[dict] = []
    for e in req.edges:
        facet = facets.get(e.facet_label)
        if not facet:
            continue
        poly = facet["polygon"] or []
        n = len(poly)
        if e.vertex_index_start >= n or e.vertex_index_end >= n:
            continue
        p1 = poly[e.vertex_index_start]
        p2 = poly[e.vertex_index_end]
        plan_len = geo.edge_plan_length_ft(
            p1, p2, req.lat, req.zoom, req.image_width_px, req.image_height_px,
        )
        slope_len = geo.slope_adjusted_edge_length_ft(plan_len, facet["pitch"], e.edge_type)
        shared_id = None
        if e.shared_with_facet_label:
            other = facets.get(e.shared_with_facet_label)
            if other:
                shared_id = other["id"]
        rows.append({
            "facet_id": facet["id"],
            "vertex_index_start": e.vertex_index_start,
            "vertex_index_end": e.vertex_index_end,
            "edge_type": e.edge_type,
            "plan_length_ft": round(plan_len, 2),
            "slope_adjusted_ft": round(slope_len, 2),
            "shared_with_facet": shared_id,
            "user_confirmed": e.user_confirmed,
        })

    if rows:
        ins = db.table("roof_edges").insert(rows).execute()
        new_edges = ins.data or []
    else:
        new_edges = []

    return {"edges": new_edges, "count": len(new_edges)}


# ----------------------------------------------------------------------------
# Recompute aggregates
# ----------------------------------------------------------------------------

def _aggregate_run(run_id: str) -> dict:
    """
    Pull the run's facets + edges and recompute all whole-roof totals. Writes
    the totals back to roof_measurement_runs and returns the recomputed dict.

    Edge totals account for the fact that ridges/hips/valleys are SHARED
    between two facets. The labeled edges table stores each side of the
    shared edge separately, so we de-duplicate by tracking edge_type-specific
    membership at the shared_with_facet pair level.
    """
    db = get_supabase()
    facets_res = db.table("roof_facets").select("*").eq("run_id", run_id).execute()
    facets = facets_res.data or []
    facet_ids = [f["id"] for f in facets]
    edges: list[dict] = []
    if facet_ids:
        edges_res = db.table("roof_edges").select("*").in_("facet_id", facet_ids).execute()
        edges = edges_res.data or []

    # Whole-roof area = sum of true_area_sqft over facets
    total_plan = round(sum((f.get("plan_area_sqft") or 0) for f in facets), 1)
    total_true = round(sum((f.get("true_area_sqft") or 0) for f in facets), 1)
    squares = round(total_true / 100.0, 2) if total_true > 0 else 0

    # Edge totals — de-duplicate shared edges.
    # Strategy: for shared edges (ridge, hip, valley), each shared pair appears
    # twice (once per facet). We hash by an unordered (facet_id, shared_with) pair
    # AND edge_type to count each shared edge exactly once.
    seen_shared: set[tuple[str, str, str]] = set()
    totals_by_type: dict[str, float] = {
        "eave": 0.0, "rake": 0.0, "ridge": 0.0, "hip": 0.0, "valley": 0.0,
        "gable_end": 0.0, "wall_intersection": 0.0,
    }
    for e in edges:
        t = e.get("edge_type") or "unlabeled"
        if t == "unlabeled":
            continue
        slope = float(e.get("slope_adjusted_ft") or 0)
        if e.get("shared_with_facet") and t in ("ridge", "hip", "valley"):
            a, b = e["facet_id"], e["shared_with_facet"]
            key = (min(a, b), max(a, b), t)
            if key in seen_shared:
                continue
            seen_shared.add(key)
        if t in totals_by_type:
            totals_by_type[t] += slope

    eaves_ft = round(totals_by_type["eave"], 1)
    rakes_ft = round(totals_by_type["rake"], 1)
    ridges_ft = round(totals_by_type["ridge"], 1)
    hips_ft = round(totals_by_type["hip"], 1)
    valleys_ft = round(totals_by_type["valley"], 1)
    perimeter_ft = round(eaves_ft + rakes_ft, 1)
    ridge_total_ft = round(ridges_ft + hips_ft, 1)
    wall_int_ft = round(totals_by_type["wall_intersection"], 1)

    # Predominant pitch: largest-area facet's pitch
    pred_pitch = "Unknown"
    pred_deg = None
    if facets:
        largest = max(facets, key=lambda f: f.get("true_area_sqft") or 0)
        pred_pitch = largest.get("pitch") or "Unknown"
        pred_deg = largest.get("pitch_degrees")

    # Complexity + waste recommendation
    pitch_vals = [f.get("pitch_degrees") for f in facets if f.get("pitch_degrees") is not None]
    if pitch_vals:
        avg = sum(pitch_vals) / len(pitch_vals)
        variance = (sum((p - avg) ** 2 for p in pitch_vals) / len(pitch_vals)) ** 0.5
    else:
        variance = 0.0
    complexity = geo.complexity_score(len(facets), valleys_ft, hips_ft, variance)
    waste_rec = geo.recommended_waste_pct(complexity)

    # Confidence: average of facet confidences, weighted by area
    if facets:
        total_a = sum((f.get("true_area_sqft") or 0) for f in facets)
        if total_a > 0:
            conf = sum(
                (f.get("confidence") or 0) * (f.get("true_area_sqft") or 0) for f in facets
            ) / total_a
        else:
            conf = sum((f.get("confidence") or 0) for f in facets) / len(facets)
    else:
        conf = 0.0

    aggregates = {
        "total_plan_sqft": total_plan,
        "total_roof_sqft": total_true,
        "squares": squares,
        "predominant_pitch": pred_pitch,
        "predominant_pitch_degrees": pred_deg,
        "facet_count": len(facets),
        "ridges_ft": ridges_ft,
        "hips_ft": hips_ft,
        "valleys_ft": valleys_ft,
        "eaves_ft": eaves_ft,
        "rakes_ft": rakes_ft,
        "perimeter_ft": perimeter_ft,
        "ridge_total_ft": ridge_total_ft,
        "complexity_score": complexity,
        "waste_pct_default": waste_rec,
        "confidence": round(geo.normalize_confidence(conf), 3),
    }

    db.table("roof_measurement_runs").update(aggregates).eq("id", run_id).execute()
    return {
        **aggregates,
        "wall_intersection_ft": wall_int_ft,
    }


@router.get("/runs/{run_id}/recompute")
async def recompute_run(run_id: str, user: dict = Depends(require_user)) -> dict:
    """Recompute aggregates from current facets+edges. Idempotent."""
    return _aggregate_run(run_id)


# ----------------------------------------------------------------------------
# Penetrations (user-confirmed only)
# ----------------------------------------------------------------------------

class PenetrationIn(BaseModel):
    type: Literal[
        "plumbing_vent", "exhaust_vent", "ridge_vent", "box_vent", "turbine_vent",
        "chimney", "skylight", "satellite_dish", "solar_panel", "hvac_unit", "other",
    ]
    count: int = 1
    facet_id: Optional[str] = None
    pos_x_frac: Optional[float] = None
    pos_y_frac: Optional[float] = None
    width_in: Optional[float] = None
    height_in: Optional[float] = None
    ai_suggested: bool = False
    user_confirmed: bool = True   # default: user is adding it via the editor
    notes: Optional[str] = None


@router.post("/runs/{run_id}/penetrations")
async def add_penetration(
    run_id: str, p: PenetrationIn, user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    row = {"run_id": run_id, **p.model_dump(exclude_none=True)}
    res = db.table("roof_penetrations").insert(row).execute()
    if not res.data:
        raise HTTPException(status_code=500, detail="Failed to add penetration.")
    return res.data[0]


@router.delete("/runs/{run_id}/penetrations/{pid}")
async def delete_penetration(
    run_id: str, pid: str, user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    db.table("roof_penetrations").delete().eq("id", pid).eq("run_id", run_id).execute()
    return {"status": "deleted", "id": pid}


@router.get("/runs/{run_id}/penetrations/suggest")
async def suggest_penetrations(
    run_id: str, user: dict = Depends(require_user),
) -> dict:
    """
    Vision-based suggestion of likely penetrations on the run's satellite
    image. EVERY suggestion is marked ai_suggested=true and
    user_confirmed=false — the contractor must explicitly add each one to
    make it count toward materials. We never claim these are measurements.
    """
    db = get_supabase()
    run = db.table("roof_measurement_runs").select(
        "satellite_image_url, satellite_lat, satellite_lng, satellite_zoom"
    ).eq("id", run_id).single().execute()
    if not run.data:
        raise HTTPException(status_code=404, detail="Run not found.")
    img_url = run.data.get("satellite_image_url")
    if not img_url:
        return {
            "suggestions": [],
            "message": "No satellite image associated with this run — cannot suggest penetrations.",
        }

    from app.services.llm import llm_vision
    import httpx, json, re as _re

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(img_url, follow_redirects=True)
            r.raise_for_status()
            img_bytes = r.content
            mt = (r.headers.get("content-type") or "image/png").split(";")[0].strip()
            if mt not in ("image/png", "image/jpeg", "image/webp"):
                mt = "image/png"
    except Exception as e:
        return {
            "suggestions": [],
            "message": f"Could not download satellite image for vision analysis: {e}",
        }

    prompt = """You are an aerial inspection assistant. Identify roof penetrations VISIBLE in this
top-down satellite image. Be HONEST: at this resolution you can see chimneys,
skylights, plumbing vents (small dark dots), ridge vents (lines along ridges),
solar panels, and HVAC units. You CANNOT reliably tell a plumbing vent from
an exhaust vent.

Return ONLY a JSON array of suggestions:
[
  {
    "type": "plumbing_vent|exhaust_vent|ridge_vent|box_vent|turbine_vent|chimney|skylight|solar_panel|hvac_unit|other",
    "pos_x_frac": 0.42,
    "pos_y_frac": 0.31,
    "confidence": 0.65,
    "note": "Small dark dot on south slope — likely plumbing vent, contractor should verify."
  }
]

If nothing is clearly visible, return []. Do NOT invent penetrations to seem thorough.
Every item in this array is treated as a SUGGESTION the contractor must confirm
before it enters the material order. Coordinates are image fractions 0..1 (top-left origin).
"""
    try:
        text = await llm_vision(img_bytes, mt, prompt, max_tokens=800)
        text = text.strip()
        text = _re.sub(r"^```(?:json)?\s*", "", text, flags=_re.MULTILINE)
        text = _re.sub(r"\s*```\s*$", "", text)
        a, b = text.find("["), text.rfind("]")
        if a < 0 or b < 0:
            return {"suggestions": [], "message": "Vision returned no JSON array."}
        suggestions = json.loads(text[a:b + 1])
    except Exception as e:
        return {"suggestions": [], "message": f"Vision analysis error: {e}"}

    # Tag each suggestion so the frontend can render an "AI-suggested, please verify" badge.
    for s in suggestions:
        s["ai_suggested"] = True
        s["user_confirmed"] = False
    return {
        "suggestions": suggestions,
        "message": (
            f"{len(suggestions)} penetration(s) suggested by AI vision. Contractor must "
            "confirm each one before it enters the material order."
        ),
    }


# ----------------------------------------------------------------------------
# Phase 2.5 — AI-assisted suggestions on top of the manual editors
# ----------------------------------------------------------------------------

@router.get("/runs/{run_id}/facets/suggest")
async def suggest_facets(
    run_id: str, user: dict = Depends(require_user),
) -> dict:
    """
    Vision-suggest distinct roof planes (facets) for the run's satellite tile.
    Returns N polygon proposals; the contractor accepts each one in the editor.

    NEVER auto-applies. Every accepted facet is added to the manual facet list
    and the user can then drag vertices, set pitch, and label edges as usual.
    """
    db = get_supabase()
    run = db.table("roof_measurement_runs").select(
        "satellite_image_url, satellite_zoom"
    ).eq("id", run_id).single().execute()
    if not run.data:
        raise HTTPException(status_code=404, detail="Run not found.")
    img_url = run.data.get("satellite_image_url")
    if not img_url:
        return {"facets": [], "message": "No satellite image attached to this run."}

    from app.services.llm import llm_vision
    import httpx, json, re as _re

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(img_url, follow_redirects=True)
            r.raise_for_status()
            img_bytes = r.content
            mt = (r.headers.get("content-type") or "image/png").split(";")[0].strip()
            if mt not in ("image/png", "image/jpeg", "image/webp"):
                mt = "image/png"
    except Exception as e:
        return {"facets": [], "message": f"Could not download satellite tile: {e}"}

    prompt = """You are a roof inspector analyzing a top-down satellite image of a residential property.

STEP 1 — LOCATE THE PRIMARY BUILDING.
The image is centered on a residential address. The primary building is usually:
  - In the central 60% of the image
  - The largest STRUCTURE with a roof (NOT the largest dark area — that's often pavement)
  - Has a clear roof texture: shingles, tiles, or metal panels — NOT smooth asphalt
  - Cast a shadow consistent with a building (not flat ground)
  - Often has a driveway connecting it to the road

IGNORE the following — they are NOT roof facets and should NEVER be traced:
  - Roads, streets, highways (long straight asphalt strips with lane markings)
  - Driveways (narrow asphalt or concrete strips leading to the house)
  - Sidewalks, parking lots, parking pads
  - Lawn, grass, gardens, dirt, mulch
  - Pool decks, patios, decks (these may LOOK like roof but are at ground level)
  - Neighboring houses' roofs (unless they share a wall with the primary building)
  - Sheds, detached garages (only include if part of the same roof line as the primary building)
  - Trees, hedges, shadows

STEP 2 — IDENTIFY DISTINCT ROOF PLANES (FACETS).
A facet is ONE flat sloping surface of the roof. Typical residential roofs:
  - Gable roof: 2 facets (front + back slopes meeting at a ridge)
  - Hip roof: 4 facets (front + back + 2 sides meeting at hips)
  - L-shape / complex: 4-8 facets
  - Each facet has a HORIZONTAL bottom edge (eave) where the gutter sits

How to distinguish a roof facet from the ground:
  - Roofs are ELEVATED — you can often see shadow under their eaves
  - Roofs have a defined geometric outline ending at gutters
  - Roofs have shingle texture visible at zoom 20
  - The ground/driveway has CONTINUOUS texture flowing past the building outline

STEP 3 — RETURN POLYGONS.
- Trace each facet as a closed polygon (4-8 vertices, do NOT repeat first vertex at end)
- Coordinates are [x, y] fractions of image width/height (0..1), top-left origin
- Adjacent facets should SHARE edges (vertex coordinates within ~0.005 of each other)
- Only trace facets you can CLEARLY see — skip facets blocked by trees, shadow, or unclear edges
- If you genuinely cannot identify the building (heavy tree cover, very low res), return facets: []

Return ONLY valid JSON (no prose, no markdown):
{
  "facets": [
    {
      "polygon": [[0.30, 0.28], [0.70, 0.28], [0.70, 0.50], [0.30, 0.50]],
      "confidence": 0.78,
      "predicted_pitch": "6/12",
      "note": "Front-facing main facet, eave visible along bottom"
    }
  ]
}

Guidance for predicted_pitch: estimate from shadow direction and visible roof slope.
- Flat or barely sloped (commercial): "2/12" to "3/12"
- Low residential: "4/12"
- Standard residential: "6/12" (most common)
- Steeper / older homes: "8/12" to "10/12"
If unsure, return "6/12" and let the contractor override.

CRITICAL: If your suggestion is the driveway, road, or non-roof feature, set confidence below 0.3
and note that you're uncertain — better to be uncertain than wrong. The contractor will reject low-confidence
suggestions and trust your high-confidence ones.
"""

    try:
        text = await llm_vision(img_bytes, mt, prompt, max_tokens=1500)
        s = (text or "").strip()
        s = _re.sub(r"^```(?:json)?\s*", "", s, flags=_re.MULTILINE)
        s = _re.sub(r"\s*```\s*$", "", s)
        a, b = s.find("{"), s.rfind("}")
        if a < 0 or b < 0:
            return {"facets": [], "message": "Vision returned no JSON object."}
        parsed = json.loads(s[a:b + 1])
        facets = parsed.get("facets") or []
    except Exception as e:
        return {"facets": [], "message": f"Vision analysis error: {str(e)[:200]}"}

    # Sanitize: each facet must have a polygon of >=3 [x,y] pairs in [0,1]
    cleaned: list[dict] = []
    for f in facets:
        poly = f.get("polygon") or []
        if not isinstance(poly, list) or len(poly) < 3:
            continue
        valid: list[list[float]] = []
        ok = True
        for pt in poly:
            if not isinstance(pt, (list, tuple)) or len(pt) < 2:
                ok = False
                break
            try:
                x = max(0.0, min(1.0, float(pt[0])))
                y = max(0.0, min(1.0, float(pt[1])))
            except (TypeError, ValueError):
                ok = False
                break
            valid.append([x, y])
        if not ok or len(valid) < 3:
            continue
        cleaned.append({
            "polygon": valid,
            "confidence": geo.normalize_confidence(f.get("confidence")),
            "predicted_pitch": str(f.get("predicted_pitch") or "6/12"),
            "note": str(f.get("note") or "")[:250],
            "ai_suggested": True,
            "user_confirmed": False,
        })

    return {
        "facets": cleaned,
        "message": (
            f"{len(cleaned)} facet(s) suggested by AI vision. Each one must be accepted "
            "individually — and verified for pitch + edge labels — before measurements are valid."
        ),
    }


class EdgeLabelSuggestRequest(BaseModel):
    facets: list[dict]            # [{label, polygon, pitch_degrees}]
    unlabeled_edges: list[dict]   # [{facet_label, vertex_index_start, vertex_index_end}]


@router.post("/runs/{run_id}/edges/suggest-labels")
async def suggest_edge_labels(
    run_id: str,
    req: EdgeLabelSuggestRequest,
    user: dict = Depends(require_user),
) -> dict:
    """
    For each unlabeled edge, suggest a type (eave/rake/ridge/hip/valley) using:
      1. Deterministic geometry first (shared edges → ridge/hip/valley)
      2. Vision analysis of the satellite tile for unshared edges (what's
         below the edge — gutter visible = eave, gable end = rake)

    Returns suggestions with confidence + reasoning. Frontend renders these as
    pre-selected dropdowns the contractor can accept or override per edge.
    """
    # Always available: deterministic geometry suggestion (shared edges, angles)
    geom_suggestions = geo.auto_suggest_edge_types(req.facets)
    geom_index: dict[tuple[str, int], dict] = {}
    for s in geom_suggestions:
        geom_index[(s.get("facet_label"), s.get("vertex_index_start"))] = s

    # Get the satellite image for vision check on unshared edges
    db = get_supabase()
    run = db.table("roof_measurement_runs").select(
        "satellite_image_url"
    ).eq("id", run_id).single().execute()
    img_url = (run.data or {}).get("satellite_image_url")

    vision_suggestions_by_edge: dict[tuple[str, int], dict] = {}
    if img_url and req.unlabeled_edges:
        # We only need vision for unshared edges (the geometry suggester
        # already handles shared ones via overlap detection).
        edges_for_vision = [
            e for e in req.unlabeled_edges
            if not geom_index.get((e.get("facet_label"), e.get("vertex_index_start")), {}).get("shared_with_facet_label")
        ]
        if edges_for_vision:
            from app.services.llm import llm_vision
            import httpx, json as _json, re as _re
            try:
                async with httpx.AsyncClient(timeout=20) as client:
                    r = await client.get(img_url, follow_redirects=True)
                    r.raise_for_status()
                    img_bytes = r.content
                    mt = (r.headers.get("content-type") or "image/png").split(";")[0].strip()
                    if mt not in ("image/png", "image/jpeg", "image/webp"):
                        mt = "image/png"

                # Build a compact edges manifest for the prompt
                edge_lines: list[str] = []
                for e in edges_for_vision:
                    fl = e.get("facet_label")
                    i = e.get("vertex_index_start")
                    facet = next((f for f in req.facets if f.get("label") == fl), None)
                    if not facet:
                        continue
                    poly = facet.get("polygon") or []
                    if i >= len(poly):
                        continue
                    p1 = poly[i]
                    p2 = poly[(i + 1) % len(poly)]
                    edge_lines.append(
                        f"  - facet {fl} edge {i}: from ({p1[0]:.3f},{p1[1]:.3f}) to ({p2[0]:.3f},{p2[1]:.3f})"
                    )

                prompt = (
                    "You are a roof inspector looking at a top-down satellite image with a set of "
                    "edges I traced on the roof. For each edge below, tell me what TYPE it is by looking "
                    "at what's visible just outside that edge in the image.\n\n"
                    "Edge types and their visual cues:\n"
                    "  - EAVE: bottom edge of a slope; gutter usually visible below it; horizontal\n"
                    "  - RAKE: sloped edge along a gable end; usually no gutter; meets the wall at an angle\n"
                    "  - GABLE_END: the short horizontal edge at the very top of a gable end (rare)\n"
                    "  - WALL_INTERSECTION: edge where roof meets a vertical wall (dormer/second story)\n"
                    "  Only use these four types — shared edges (ridge/hip/valley) were already labeled.\n\n"
                    "Edges to classify (coordinates are image fractions, 0..1):\n"
                    + "\n".join(edge_lines)
                    + "\n\nReturn ONLY valid JSON:\n"
                    "{\n  \"labels\": [\n    {\"facet_label\": \"A\", \"vertex_index_start\": 0, \"edge_type\": \"eave\", \"confidence\": 0.8, \"reason\": \"gutter visible below\"},\n    ...\n  ]\n}\n"
                    "Be honest — confidence < 0.5 if you genuinely cannot tell."
                )
                text = await llm_vision(img_bytes, mt, prompt, max_tokens=1200)
                t = (text or "").strip()
                t = _re.sub(r"^```(?:json)?\s*", "", t, flags=_re.MULTILINE)
                t = _re.sub(r"\s*```\s*$", "", t)
                a, b = t.find("{"), t.rfind("}")
                if a >= 0 and b >= 0:
                    parsed = _json.loads(t[a:b + 1])
                    for v in parsed.get("labels") or []:
                        key = (v.get("facet_label"), int(v.get("vertex_index_start") or -1))
                        vision_suggestions_by_edge[key] = {
                            "edge_type": v.get("edge_type"),
                            "confidence": geo.normalize_confidence(v.get("confidence")),
                            "reason": str(v.get("reason") or "")[:200],
                        }
            except Exception as e:
                logger.info("edge-label vision pass failed: %s", e)

    # Merge: shared edges from geometry, unshared from vision (else geometry fallback)
    out: list[dict] = []
    for e in req.unlabeled_edges:
        key = (e.get("facet_label"), int(e.get("vertex_index_start") or 0))
        geo_sug = geom_index.get(key, {})
        shared = geo_sug.get("shared_with_facet_label")
        if shared:
            out.append({
                "facet_label": key[0],
                "vertex_index_start": key[1],
                "suggested_edge_type": geo_sug.get("edge_type") or "ridge",
                "confidence": 0.85,
                "reason": f"Shared edge with facet {shared} (geometric)",
                "shared_with_facet_label": shared,
                "ai_suggested": True,
            })
        else:
            v = vision_suggestions_by_edge.get(key)
            if v and v.get("edge_type") in ("eave", "rake", "gable_end", "wall_intersection"):
                out.append({
                    "facet_label": key[0],
                    "vertex_index_start": key[1],
                    "suggested_edge_type": v["edge_type"],
                    "confidence": v["confidence"],
                    "reason": v["reason"],
                    "shared_with_facet_label": None,
                    "ai_suggested": True,
                })
            else:
                # Geometric fallback (horizontal=eave, sloped=rake)
                out.append({
                    "facet_label": key[0],
                    "vertex_index_start": key[1],
                    "suggested_edge_type": geo_sug.get("edge_type") or "unlabeled",
                    "confidence": 0.45,
                    "reason": "Geometric heuristic (no vision confidence)",
                    "shared_with_facet_label": None,
                    "ai_suggested": True,
                })

    return {
        "suggestions": out,
        "message": (
            f"{len(out)} edge label(s) suggested. Vision suggestions have a confidence — "
            "you should still review unfamiliar edges before continuing."
        ),
    }


# ----------------------------------------------------------------------------
# Materials
# ----------------------------------------------------------------------------

@router.get("/catalog")
async def get_catalog(
    region: Optional[str] = Query(None),
    user: dict = Depends(require_user),
) -> dict:
    """Read the materials catalog. region filter: 'US-TX', etc. Falls back to US default."""
    db = get_supabase()
    q = db.table("materials_catalog").select("*").eq("active", True)
    res = q.execute()
    rows = res.data or []
    # Region preference: if a region is requested, prefer matching rows and
    # fall back to NULL region for unmatched SKUs.
    if region:
        by_sku: dict[str, dict] = {}
        for r in rows:
            sku = r.get("sku") or ""
            r_region = r.get("region")
            existing = by_sku.get(sku)
            if existing is None:
                by_sku[sku] = r
            elif r_region == region:
                by_sku[sku] = r        # override default
            elif existing.get("region") == region:
                pass                    # already region-matched
            elif r_region is None and existing.get("region") is None:
                pass
        rows = list(by_sku.values())
    rows.sort(key=lambda r: r.get("category", ""))
    return {"items": rows, "count": len(rows)}


@router.get("/runs/{run_id}/materials")
async def get_run_materials(
    run_id: str,
    waste_pct: int = Query(12),
    user: dict = Depends(require_user),
) -> dict:
    """
    Full material list for a run at the selected waste %, plus the per-waste
    table so the contractor can see every option at once.
    """
    db = get_supabase()
    run = db.table("roof_measurement_runs").select("*").eq("id", run_id).single().execute()
    if not run.data:
        raise HTTPException(status_code=404, detail="Run not found.")
    if not run.data.get("total_roof_sqft"):
        raise HTTPException(
            status_code=422,
            detail="Run has no computed totals yet — call /recompute after adding facets+edges.",
        )

    # Project region for pricing
    proj = db.table("projects").select("region").eq("id", run.data["project_id"]).single().execute()
    region = (proj.data or {}).get("region")

    catalog_q = db.table("materials_catalog").select("*").eq("active", True).execute()
    catalog = catalog_q.data or []
    if region:
        by_sku: dict[str, dict] = {}
        for r in catalog:
            sku = r.get("sku") or ""
            existing = by_sku.get(sku)
            if existing is None or r.get("region") == region:
                by_sku[sku] = r
        catalog = list(by_sku.values())

    # Confirmed penetrations only
    pens_res = db.table("roof_penetrations").select("*").eq("run_id", run_id).eq("user_confirmed", True).execute()
    pen_rows = pens_res.data or []

    # wall_intersection_ft from edge totals (not stored on run; recompute returns it)
    aggregates = _aggregate_run(run_id)

    totals = RoofTotals(
        total_roof_sqft=float(aggregates["total_roof_sqft"] or 0),
        squares=float(aggregates["squares"] or 0),
        eaves_ft=float(aggregates["eaves_ft"] or 0),
        rakes_ft=float(aggregates["rakes_ft"] or 0),
        ridges_ft=float(aggregates["ridges_ft"] or 0),
        hips_ft=float(aggregates["hips_ft"] or 0),
        valleys_ft=float(aggregates["valleys_ft"] or 0),
        wall_intersection_ft=float(aggregates.get("wall_intersection_ft") or 0),
        stories=int(run.data.get("stories") or 1),
        pitch=str(aggregates["predominant_pitch"] or "6/12"),
    )
    penetrations = PenetrationSummary.from_rows(pen_rows)

    lines = compute_material_lines(catalog, totals, penetrations, default_waste_pct=waste_pct)
    return {
        "run_id": run_id,
        "waste_pct": waste_pct,
        "waste_table": STANDARD_WASTE_PCTS,
        "lines": [l.to_dict() for l in lines],
        "summary": materials_summary(lines),
        "grand_total_at_selected_waste": grand_total(lines, waste_pct),
        "totals_input": {
            "total_roof_sqft": totals.total_roof_sqft,
            "squares": totals.squares,
            "eaves_ft": totals.eaves_ft,
            "rakes_ft": totals.rakes_ft,
            "ridges_ft": totals.ridges_ft,
            "hips_ft": totals.hips_ft,
            "valleys_ft": totals.valleys_ft,
            "perimeter_ft": totals.perimeter_ft,
            "ridge_total_ft": totals.ridge_total_ft,
            "wall_intersection_ft": totals.wall_intersection_ft,
            "pitch": totals.pitch,
            "stories": totals.stories,
        },
        "penetrations_confirmed": pen_rows,
    }


# ----------------------------------------------------------------------------
# Report
# ----------------------------------------------------------------------------

@router.get("/runs/{run_id}/report")
async def get_run_report(run_id: str, user: dict = Depends(require_user)):
    """
    Redesigned 8-section roof report. Pulls everything we need server-side
    and renders a PDF.
    """
    from app.services.roof_report_v2_pdf import generate_v2_report
    db = get_supabase()
    run_res = db.table("roof_measurement_runs").select("*").eq("id", run_id).single().execute()
    if not run_res.data:
        raise HTTPException(status_code=404, detail="Run not found.")
    run = run_res.data
    proj = db.table("projects").select("*").eq("id", run["project_id"]).single().execute()
    if not proj.data:
        raise HTTPException(status_code=404, detail="Project not found for run.")

    facets_res = db.table("roof_facets").select("*").eq("run_id", run_id).execute()
    facet_ids = [f["id"] for f in (facets_res.data or [])]
    edges = []
    if facet_ids:
        edges_res = db.table("roof_edges").select("*").in_("facet_id", facet_ids).execute()
        edges = edges_res.data or []
    pens_res = db.table("roof_penetrations").select("*").eq("run_id", run_id).eq("user_confirmed", True).execute()

    # Recompute to ensure totals are current
    aggregates = _aggregate_run(run_id)

    # Materials
    catalog = db.table("materials_catalog").select("*").eq("active", True).execute().data or []
    totals = RoofTotals(
        total_roof_sqft=float(aggregates["total_roof_sqft"] or 0),
        squares=float(aggregates["squares"] or 0),
        eaves_ft=float(aggregates["eaves_ft"] or 0),
        rakes_ft=float(aggregates["rakes_ft"] or 0),
        ridges_ft=float(aggregates["ridges_ft"] or 0),
        hips_ft=float(aggregates["hips_ft"] or 0),
        valleys_ft=float(aggregates["valleys_ft"] or 0),
        wall_intersection_ft=float(aggregates.get("wall_intersection_ft") or 0),
        stories=int(run.get("stories") or 1),
        pitch=str(aggregates["predominant_pitch"] or "6/12"),
    )
    pens = PenetrationSummary.from_rows(pens_res.data or [])
    default_waste = int(run.get("waste_pct_default") or aggregates["waste_pct_default"])
    material_lines = compute_material_lines(catalog, totals, pens, default_waste_pct=default_waste)

    # Manual siding (Phase-1 placeholder section)
    siding_res = db.table("manual_siding_measurements").select("*").eq("project_id", run["project_id"]).execute()

    pdf_bytes = await asyncio.to_thread(
        generate_v2_report,
        proj.data,
        run,
        aggregates,
        facets_res.data or [],
        edges,
        pens_res.data or [],
        material_lines,
        siding_res.data or [],
    )

    slug = (proj.data.get("name") or "project").strip().lower()
    slug = "".join(c if c.isalnum() else "-" for c in slug).strip("-") or "project"
    filename = f"axis-roof-report-{slug}-{run_id[:8]}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ----------------------------------------------------------------------------
# Manual siding (Category-C placeholder workflow)
# ----------------------------------------------------------------------------

class SidingMeasurementIn(BaseModel):
    project_id: str
    elevation: Literal["front", "rear", "left", "right", "other"]
    photo_url: Optional[str] = None
    reference_object: Optional[Literal[
        "standard_door_80", "garage_door_84", "window_36", "custom",
    ]] = None
    reference_height_in: Optional[float] = None
    reference_pixel_h: Optional[float] = None
    region_polygon: list[list[float]]
    material_type: Optional[str] = None
    notes: Optional[str] = None


def _polygon_area_image_units(polygon: list[list[float]]) -> float:
    """Shoelace area in raw image-pixel units (we expect polygon in pixels)."""
    n = len(polygon)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        x1, y1 = polygon[i][0], polygon[i][1]
        x2, y2 = polygon[(i + 1) % n][0], polygon[(i + 1) % n][1]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


@router.post("/siding/measurements")
async def add_siding_measurement(
    payload: SidingMeasurementIn, user: dict = Depends(require_user),
) -> dict:
    """
    Record a manual siding measurement. The contractor traces the siding
    region on a ground-level photo and provides a scale reference (door
    height). Area is computed from pixel area × scale².
    """
    if len(payload.region_polygon) < 3:
        raise HTTPException(status_code=422, detail="region_polygon must have at least 3 vertices")

    # Scale derivation
    ref_in = payload.reference_height_in
    if payload.reference_object == "standard_door_80":
        ref_in = 80.0
    elif payload.reference_object == "garage_door_84":
        ref_in = 84.0
    elif payload.reference_object == "window_36":
        ref_in = 36.0

    scale_in_per_px = 0.0
    if ref_in and payload.reference_pixel_h and payload.reference_pixel_h > 0:
        scale_in_per_px = ref_in / payload.reference_pixel_h

    pixel_area = _polygon_area_image_units(payload.region_polygon)
    area_sqin = pixel_area * (scale_in_per_px ** 2) if scale_in_per_px > 0 else 0.0
    area_sqft = round(area_sqin / 144.0, 1)

    db = get_supabase()
    row = {
        "project_id": payload.project_id,
        "elevation": payload.elevation,
        "photo_url": payload.photo_url,
        "reference_object": payload.reference_object,
        "reference_height_in": ref_in,
        "reference_pixel_h": payload.reference_pixel_h,
        "scale_in_per_px": scale_in_per_px,
        "region_polygon": payload.region_polygon,
        "area_sqft": area_sqft,
        "material_type": payload.material_type,
        "notes": payload.notes,
        "contractor_entered": True,
    }
    res = db.table("manual_siding_measurements").insert(row).execute()
    if not res.data:
        raise HTTPException(status_code=500, detail="Failed to save siding measurement.")
    return res.data[0]


@router.get("/siding/measurements")
async def list_siding_measurements(
    project_id: str = Query(...), user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    res = db.table("manual_siding_measurements").select("*").eq("project_id", project_id).execute()
    rows = res.data or []
    total = round(sum((r.get("area_sqft") or 0) for r in rows), 1)
    return {"measurements": rows, "total_sqft": total, "count": len(rows)}
