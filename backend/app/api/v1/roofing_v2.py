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

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
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


# Hosts the proxy is allowed to fetch from — satellite tile providers only.
# An SSRF guard: the endpoint is public (image loads can't carry a JWT) so it
# must never be usable to reach internal services or arbitrary URLs.
_PROXY_ALLOWED_HOSTS = (
    "services.arcgisonline.com",
    "server.arcgisonline.com",
    "api.maptiler.com",
    "api.mapbox.com",
    "dev.virtualearth.net",
    "t.ssl.ak.tiles.virtualearth.net",
)


@router.get("/imagery/proxy")
async def imagery_proxy(url: str = Query(..., min_length=10)):
    """
    Same-origin tile proxy. Some providers don't send CORS headers, which makes
    their tiles unreadable from a <canvas> (tainted-canvas SecurityError) — that
    silently breaks clarity enhancement, snap-to-edge, and edge refinement.
    Routing the tile through this endpoint (which returns Access-Control-Allow-
    Origin: *) makes it canvas-readable.

    Public by design — an <img crossorigin> request can't carry the JWT — but
    locked to satellite-tile provider hosts only (SSRF guard). Returns the raw
    image bytes; the browser + our 1h cache keep repeat loads cheap.
    """
    from urllib.parse import urlparse

    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not any(
        host == h or host.endswith("." + h) for h in _PROXY_ALLOWED_HOSTS
    ):
        raise HTTPException(status_code=400, detail="URL host not allowed by the tile proxy.")

    try:
        async with httpx.AsyncClient(timeout=25) as client:
            r = await client.get(url, follow_redirects=True)
            r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Tile proxy fetch failed: {e}")

    media = (r.headers.get("content-type") or "image/png").split(";")[0].strip()
    if not media.startswith("image/"):
        media = "image/png"
    return Response(
        content=r.content,
        media_type=media,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",
        },
    )


def _enhance_for_vision(img_bytes: bytes, media_type: str) -> tuple[bytes, str]:
    """
    Contrast-stretch + sharpen a satellite tile before sending it to the vision
    model, so roof-plane boundaries are easier to resolve on hazy imagery. Pure
    Pillow; returns (original_bytes, media_type) unchanged on any failure.
    """
    try:
        import io as _io
        from PIL import Image, ImageEnhance, ImageOps

        im = Image.open(_io.BytesIO(img_bytes))
        im = im.convert("RGB")
        if max(im.size) > 2048:        # @2x tiles can be 4096px — lighten the payload
            im.thumbnail((2048, 2048))
        im = ImageOps.autocontrast(im, cutoff=1)        # percentile contrast stretch
        im = ImageEnhance.Contrast(im).enhance(1.25)
        im = ImageEnhance.Sharpness(im).enhance(1.8)     # crisper edges
        out = _io.BytesIO()
        im.save(out, format="JPEG", quality=90)
        return out.getvalue(), "image/jpeg"
    except Exception as e:
        logger.info("vision pre-enhance failed (%s) — using original", e)
        return img_bytes, media_type


USE_FACET_REFERENCES = True   # send roof-type reference diagrams as few-shot
_REFERENCE_CACHE: Optional[list] = None


def _roof_reference_examples() -> list:
    """Static, generated schematic diagrams of common roof TYPES from above, used
    as few-shot references so the model labels facet_type more consistently
    (gable vs hip vs valley). Cached after first build. Each item is
    (png_bytes, 'image/png', caption)."""
    global _REFERENCE_CACHE
    if _REFERENCE_CACHE is not None:
        return _REFERENCE_CACHE
    try:
        import io as _io
        from PIL import Image, ImageDraw

        def _canvas():
            im = Image.new("RGB", (640, 480), (245, 245, 247))
            return im, ImageDraw.Draw(im, "RGBA")

        out: list = []

        # GABLE — 2 facets, one straight ridge
        im, d = _canvas()
        d.polygon([(120, 120), (520, 120), (520, 240), (120, 240)], fill=(59, 130, 246, 90))
        d.polygon([(120, 240), (520, 240), (520, 360), (120, 360)], fill=(34, 197, 94, 90))
        d.rectangle([120, 120, 520, 360], outline=(30, 30, 30), width=3)
        d.line([(120, 240), (520, 240)], fill=(220, 38, 38), width=6)
        d.text((130, 90), "GABLE: 2 facets, one horizontal RIDGE (red)", fill=(20, 20, 20))
        b = _io.BytesIO(); im.save(b, "PNG")
        out.append((b.getvalue(), "image/png",
                    "a GABLE roof from above: exactly 2 slopes meeting at ONE straight ridge; the end walls are triangular gables."))

        # HIP — 4 facets, diagonal hips to a central ridge
        im, d = _canvas()
        cx0, cy0, cx1, cy1, rx0, rx1, ry = 120, 120, 520, 360, 240, 400, 240
        d.polygon([(cx0, cy0), (cx1, cy0), (rx1, ry), (rx0, ry)], fill=(59, 130, 246, 90))
        d.polygon([(cx0, cy1), (cx1, cy1), (rx1, ry), (rx0, ry)], fill=(34, 197, 94, 90))
        d.polygon([(cx0, cy0), (rx0, ry), (cx0, cy1)], fill=(245, 158, 11, 90))
        d.polygon([(cx1, cy0), (rx1, ry), (cx1, cy1)], fill=(236, 72, 153, 90))
        for a, bb in [((cx0, cy0), (rx0, ry)), ((cx1, cy0), (rx1, ry)),
                      ((cx0, cy1), (rx0, ry)), ((cx1, cy1), (rx1, ry))]:
            d.line([a, bb], fill=(16, 185, 129), width=4)
        d.line([(rx0, ry), (rx1, ry)], fill=(220, 38, 38), width=6)
        d.text((130, 90), "HIP: 4 facets, diagonal HIPS (green) to RIDGE (red)", fill=(20, 20, 20))
        b = _io.BytesIO(); im.save(b, "PNG")
        out.append((b.getvalue(), "image/png",
                    "a HIP roof from above: 4 slopes with diagonal hip lines from each corner to a central ridge; NO triangular gable end walls."))

        # COMPLEX / VALLEY — L-shape with an inside corner
        im, d = _canvas()
        d.polygon([(120, 140), (360, 140), (360, 260), (520, 260), (520, 380), (120, 380)],
                  fill=(59, 130, 246, 60), outline=(30, 30, 30))
        d.line([(360, 260), (445, 330)], fill=(37, 99, 235), width=6)
        d.text((130, 100), "COMPLEX (L): wings meet at a VALLEY (blue)", fill=(20, 20, 20))
        b = _io.BytesIO(); im.save(b, "PNG")
        out.append((b.getvalue(), "image/png",
                    "a COMPLEX / L-shaped roof from above: two wings meeting at an inside corner, forming a valley where water collects."))

        _REFERENCE_CACHE = out
        return out
    except Exception as e:
        logger.info("roof reference examples build failed: %s", e)
        _REFERENCE_CACHE = []
        return []


def _loads_tolerant(text: Optional[str]) -> Optional[dict]:
    """Best-effort extraction of a JSON object from an LLM response. Vision
    models occasionally emit slightly-broken JSON — trailing commas, a stray
    control char inside a string, or truncated output. Strict json.loads then
    surfaces 'Expecting , delimiter'. This tries a series of cheap repairs and
    returns the parsed dict, or None if nothing salvages it."""
    import json as _json
    import re as _re

    if not text:
        return None
    s = text.strip()
    s = _re.sub(r"^```(?:json)?\s*", "", s, flags=_re.MULTILINE)
    s = _re.sub(r"\s*```\s*$", "", s)
    a, b = s.find("{"), s.rfind("}")
    if a < 0:
        return None
    body = s[a:b + 1] if b > a else s[a:]

    def _balance(t: str) -> str:
        t = t.rstrip().rstrip(",")
        nb = t.count("[") - t.count("]")
        nc = t.count("{") - t.count("}")
        return t + ("]" * max(0, nb)) + ("}" * max(0, nc))

    no_ctrl = _re.sub(r"[\x00-\x1f]", " ", body)              # strip raw control chars
    no_trailing = _re.sub(r",\s*([}\]])", r"\1", no_ctrl)     # kill trailing commas
    # Insert missing commas between adjacent objects/arrays — the classic
    # "Expecting ',' delimiter" cause when a model forgets a separator.
    commas = _re.sub(r"(\})\s*(\{)", r"\1,\2", no_trailing)
    commas = _re.sub(r"(\])\s*(\[)", r"\1,\2", commas)
    candidates = [body, no_ctrl, no_trailing, commas, _balance(no_trailing),
                  _re.sub(r",\s*([}\]])", r"\1", _balance(commas))]
    for c in candidates:
        try:
            obj = _json.loads(c)
            if isinstance(obj, dict):
                return obj
        except Exception:
            continue
    return None


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


@router.get("/streetview")
async def street_view(
    lat: float = Query(...),
    lng: float = Query(...),
    user: dict = Depends(require_user),
) -> dict:
    """Best-effort Google Street View thumbnail of an address, so a contractor who
    can't recognize the house from the top-down satellite can match the familiar
    STREET-LEVEL view and tap the right roof. The camera is aimed from the nearest
    panorama toward the address so the house is centered. Returns
    {available, image?} where image is a base64 data URL — the key never leaves the
    server. Degrades silently (available=false) when there's no coverage or the key
    isn't enabled for Street View."""
    from app.core.config import settings as _settings
    import base64
    import httpx as _httpx
    key = _settings.GOOGLE_SOLAR_API_KEY
    if not key:
        return {"available": False}
    try:
        async with _httpx.AsyncClient(timeout=10) as client:
            meta = await client.get(
                "https://maps.googleapis.com/maps/api/streetview/metadata",
                params={"location": f"{lat},{lng}", "key": key},
            )
            md = meta.json() or {}
            if md.get("status") != "OK":
                return {"available": False}
            # Aim the camera from the panorama toward the actual address.
            heading: Optional[float] = None
            ploc = md.get("location") or {}
            plat, plng = ploc.get("lat"), ploc.get("lng")
            if plat is not None and plng is not None:
                dlng = math.radians(lng - float(plng))
                y = math.sin(dlng) * math.cos(math.radians(lat))
                x = (math.cos(math.radians(float(plat))) * math.sin(math.radians(lat))
                     - math.sin(math.radians(float(plat))) * math.cos(math.radians(lat)) * math.cos(dlng))
                heading = (math.degrees(math.atan2(y, x)) + 360) % 360
            params = {"size": "640x400", "location": f"{lat},{lng}", "fov": "75",
                      "source": "outdoor", "key": key}
            if heading is not None:
                params["heading"] = f"{heading:.0f}"
            img = await client.get(
                "https://maps.googleapis.com/maps/api/streetview", params=params)
            img.raise_for_status()
            ct = img.headers.get("content-type", "image/jpeg").split(";")[0]
            b64 = base64.b64encode(img.content).decode()
            return {"available": True, "image": f"data:{ct};base64,{b64}"}
    except Exception as e:
        logger.info("street view lookup failed: %s", e)
        return {"available": False}


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


@router.get("/projects/{project_id}/latest-run")
async def latest_run_for_project(project_id: str, user: dict = Depends(require_user)) -> dict:
    """The most recent measurement run for a project, so reopening a project can
    RESUME the contractor's saved roof (facets/edges) instead of starting over."""
    db = get_supabase()
    res = (
        db.table("roof_measurement_runs")
        .select("id, created_at")
        .eq("project_id", project_id)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = res.data or []
    return {"run_id": rows[0]["id"] if rows else None}


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
    # Reference-object scale check results (recorded, surfaced in the APIR
    # report's scale confidence; does not yet auto-rescale stored measurements).
    pixels_per_foot: Optional[float] = None
    scale_method: Optional[str] = None
    scale_confidence: Optional[str] = None
    scale_reference_description: Optional[str] = None


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
    ai_suggested: bool = False   # true when this facet originated from AI (training provenance)

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
            "ai_suggested": f.ai_suggested,
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

def _measurement_confidence(run_id: str, facets: list[dict], edges: list[dict]) -> float:
    """
    Real composite confidence in 0..1 — reflects how COMPLETE and well-grounded
    the measurement inputs are (the actual drivers of accuracy), not an averaged
    placeholder. Every component is something the contractor can raise.
    """
    if not facets:
        return 0.0

    # 1. Edges labeled (45%). Unlabeled edges are dropped from ridge cap, drip
    #    edge, and flashing — the biggest source of missing/!inaccurate footage.
    total_edges = len(edges)
    labeled = sum(1 for e in edges if (e.get("edge_type") or "unlabeled") != "unlabeled")
    edge_score = (labeled / total_edges) if total_edges else 0.0

    # 2. Pitch set (25%). A roof can legitimately be 6/12, but ALL facets at the
    #    exact default strongly implies pitch was never confirmed.
    all_default = all((f.get("pitch") or "6/12") == "6/12" for f in facets)
    pitch_score = 0.5 if all_default else 1.0

    # 3. Scale grounded (20%). Reference-object > web_mercator > estimated.
    scale_score = 0.85   # default: web-mercator tile scale (good)
    try:
        db = get_supabase()
        run = db.table("roof_measurement_runs").select(
            "scale_method, scale_confidence"
        ).eq("id", run_id).single().execute()
        method = (run.data or {}).get("scale_method")
        sconf = (run.data or {}).get("scale_confidence")
        if method == "reference_object" or sconf == "high":
            scale_score = 1.0
        elif method == "estimated" or sconf == "estimated":
            scale_score = 0.6
    except Exception:
        pass

    # 4. Facets present + well-formed (10%).
    facet_score = 1.0 if all(len(f.get("polygon") or []) >= 3 for f in facets) else 0.7

    composite = (
        0.45 * edge_score
        + 0.25 * pitch_score
        + 0.20 * scale_score
        + 0.10 * facet_score
    )
    return max(0.0, min(1.0, composite))


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

    # Measurement confidence — a REAL composite of the things that actually
    # drive accuracy, not an averaged placeholder. Each component is something
    # the contractor can improve (and the pre-report checklist nudges them to):
    #   • edges labeled   (45%) — unlabeled edges are excluded from ridge/drip/
    #                              flashing, the biggest source of missing footage
    #   • pitch set       (25%) — drives area + flashing; all-default ⇒ unconfirmed
    #   • scale grounded  (20%) — reference-object/web-mercator vs estimated
    #   • facets present  (10%)
    conf = _measurement_confidence(run_id, facets, edges)

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


_GROUND_PHOTO_MAX_PAGES = 12  # cap PDF pages analyzed to bound cost/time


def _normalize_image_for_vision(raw: bytes) -> tuple[Optional[bytes], str]:
    """
    Accept any common image a contractor's phone produces and return
    (jpeg_bytes, media_type) ready for the vision model, downscaling huge photos.
    Returns (None, '') only when the bytes aren't a readable image.
    """
    try:
        import io as _io
        from PIL import Image

        # Register HEIC/HEIF support so iPhone photos (the default phone format)
        # decode. Best-effort — JPEG/PNG/WEBP still work if this isn't installed.
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
        except Exception:
            pass

        im = Image.open(_io.BytesIO(raw))
        im = im.convert("RGB")
        if max(im.size) > 2048:               # phone photos are huge; shrink for speed
            im.thumbnail((2048, 2048))
        out = _io.BytesIO()
        im.save(out, format="JPEG", quality=88)
        return out.getvalue(), "image/jpeg"
    except Exception:
        # PIL couldn't decode (e.g. HEIC without the plugin). Pass through if
        # the magic bytes are already a model-supported format.
        if raw[:3] == b"\xff\xd8\xff":
            return raw, "image/jpeg"
        if raw[:8] == b"\x89PNG\r\n\x1a\n":
            return raw, "image/png"
        if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
            return raw, "image/webp"
        return None, ""


def _normalize_to_images(raw: bytes) -> tuple[list[tuple[bytes, str]], bool]:
    """
    Expand an upload into a list of analyzable images.

    • PDF  → one image PER PAGE (rasterized via PyMuPDF at ~200 DPI), capped at
             _GROUND_PHOTO_MAX_PAGES.
    • image → a single-element list.

    Returns (images, truncated) where `truncated` is True if a PDF had more
    pages than the cap. Empty list = nothing readable.
    """
    if raw[:5] == b"%PDF-":
        try:
            import fitz  # PyMuPDF (already a dependency)
            doc = fitz.open(stream=raw, filetype="pdf")
            total = doc.page_count
            images: list[tuple[bytes, str]] = []
            for i in range(min(total, _GROUND_PHOTO_MAX_PAGES)):
                pix = doc.load_page(i).get_pixmap(matrix=fitz.Matrix(200 / 72, 200 / 72))
                norm, mt = _normalize_image_for_vision(pix.tobytes("png"))
                if norm is not None:
                    images.append((norm, mt))
            doc.close()
            return images, total > _GROUND_PHOTO_MAX_PAGES
        except Exception:
            return [], False

    norm, mt = _normalize_image_for_vision(raw)
    return ([(norm, mt)] if norm is not None else []), False


_GROUND_PHOTO_PROMPT = """You are a roofing estimator analyzing a GROUND-LEVEL photo of a house. Report only what improves a ROOF estimate. Return ONLY JSON:
{
  "roof_pitch": "6/12",                  // rise/12 read from a visible gable end or roof slope; "" if not visible
  "pitch_confidence": "high|medium|low",
  "pitch_method": "gable_end|slope_angle|not_visible",
  "roof_shape": "gable|hip|complex|flat|shed|unknown",  // overall roof form visible in this photo: gable=2 main slopes meeting at a ridge with triangular end walls; hip=4 slopes, no gable end walls; complex=multiple wings/intersecting roofs; flat=low-slope; shed=single slope. "unknown" if you can't tell.
  "chimney": {"present": true, "count": 1, "height": "short|medium|tall", "material": "brick|metal|stucco|unknown"},
  "skylights": 0,
  "dormers": 0,
  "wall_abutment": {"present": false, "note": ""},   // TRUE if a roof slope dies into a TALLER wall of the same house (e.g. a porch/garage/single-story roof meeting a two-story wall). This needs step/apron flashing. Note where you see it.
  "gable_walls_visible": 1,
  "roof_material": "asphalt_shingles|metal|tile|flat_membrane|wood_shake|slate|unknown",
  "roof_color": "weathered charcoal gray",
  "siding_material": "vinyl|hardie|wood|brick|stucco|aluminum|stone|unknown",
  "stories": 1,
  "notes": "one short sentence of anything else relevant to flashing or pitch"
}
Pitch guide: 3/12≈14°, 5/12≈23°, 8/12≈34°, 12/12≈45°.
ALWAYS give your BEST ESTIMATE of roof_pitch from ANY visible cue — a gable end, a roof slope, an eave-to-ridge line, even the angle of a shadow or the rake board. Use pitch_confidence "low" when you are unsure rather than refusing. Most residential roofs are between 4/12 and 9/12, so default toward that range when only weak cues are visible. Only set roof_pitch to "" if there is genuinely NO roof visible in the image at all (e.g. a close-up of a wall or a document). Do not invent a chimney that isn't there."""


def _parse_ground_findings(text: str) -> tuple[Optional[dict], str]:
    """Parse + normalize one vision response into (findings|None, message)."""
    import json as _json
    import re as _re

    s = (text or "").strip()
    s = _re.sub(r"^```(?:json)?\s*", "", s, flags=_re.MULTILINE)
    s = _re.sub(r"\s*```\s*$", "", s)
    a, b = s.find("{"), s.rfind("}")
    if a < 0 or b < 0:
        return None, "AI could not read this image. Try a clearer shot of the roofline."
    try:
        parsed = _json.loads(s[a:b + 1])
    except Exception as e:
        return None, f"Could not parse analysis: {str(e)[:120]}"

    ch = parsed.get("chimney") or {}
    wa = parsed.get("wall_abutment") or {}
    findings = {
        "roof_pitch": str(parsed.get("roof_pitch") or "").strip(),
        "pitch_confidence": parsed.get("pitch_confidence") if parsed.get("pitch_confidence") in ("high", "medium", "low") else "low",
        "pitch_method": parsed.get("pitch_method") if parsed.get("pitch_method") in ("gable_end", "slope_angle", "not_visible") else "not_visible",
        "roof_shape": parsed.get("roof_shape") if parsed.get("roof_shape") in ("gable", "hip", "complex", "flat", "shed", "unknown") else "unknown",
        "chimney": {
            "present": bool(ch.get("present")),
            "count": int(ch.get("count") or 0),
            "height": ch.get("height") if ch.get("height") in ("short", "medium", "tall") else "medium",
            "material": str(ch.get("material") or "unknown"),
        },
        "skylights": int(parsed.get("skylights") or 0),
        "dormers": int(parsed.get("dormers") or 0),
        "wall_abutment": {
            "present": bool(wa.get("present")),
            "note": str(wa.get("note") or "")[:160],
        },
        "gable_walls_visible": int(parsed.get("gable_walls_visible") or 0),
        "roof_material": str(parsed.get("roof_material") or "unknown"),
        "roof_color": str(parsed.get("roof_color") or "")[:80],
        "siding_material": str(parsed.get("siding_material") or "unknown"),
        "stories": int(parsed.get("stories") or 1),
        "notes": str(parsed.get("notes") or "")[:240],
    }
    return findings, "Analyzed. Review and apply the findings that look right."


_PITCH_CONF_RANK = {"high": 3, "medium": 2, "low": 1}


def _consolidate_ground_findings(results: list[dict]) -> Optional[dict]:
    """Merge the findings across all analyzed photos/pages into ONE artifact to
    persist on the run. Takes the best-confidence PITCH read, but UNION-merges the
    flashing-relevant signals (chimney, skylights, dormers, wall_abutment) and the
    roof shape across every page — so a photo that shows a chimney or a roof-to-
    wall abutment but no clear pitch still contributes. (The old version dropped
    any page without a pitch, which silently lost those flashing conditions.)"""
    fs = [r.get("findings") for r in results if r.get("findings")]
    if not fs:
        return None

    pitched = [f for f in fs if str(f.get("roof_pitch") or "").strip()]
    base = dict(max(pitched, key=lambda f: _PITCH_CONF_RANK.get(f.get("pitch_confidence"), 0))
                if pitched else fs[0])

    base["dormers"] = max((int(f.get("dormers") or 0) for f in fs), default=0)
    base["skylights"] = max((int(f.get("skylights") or 0) for f in fs), default=0)

    if any((f.get("chimney") or {}).get("present") for f in fs):
        ch_count = max((int((f.get("chimney") or {}).get("count") or 0) for f in fs), default=1)
        base["chimney"] = {**(base.get("chimney") or {}), "present": True, "count": max(ch_count, 1)}

    if any((f.get("wall_abutment") or {}).get("present") for f in fs):
        note = next(((f.get("wall_abutment") or {}).get("note")
                     for f in fs if (f.get("wall_abutment") or {}).get("present")), "")
        base["wall_abutment"] = {"present": True, "note": note or ""}

    shape = next((f.get("roof_shape") for f in fs
                  if f.get("roof_shape") and f.get("roof_shape") != "unknown"), None)
    if shape:
        base["roof_shape"] = shape

    return base


async def _analyze_ground_image(img_bytes: bytes, mt: str) -> tuple[Optional[dict], str]:
    """Run one image through the vision model + parser."""
    from app.services.llm import llm_vision
    try:
        text = await llm_vision(img_bytes, mt, _GROUND_PHOTO_PROMPT, max_tokens=700)
    except Exception as e:
        return None, f"Photo analysis error: {str(e)[:160]}"
    return _parse_ground_findings(text)


@router.post("/runs/{run_id}/ground-photos/analyze")
async def analyze_ground_photo(
    run_id: str,
    file: UploadFile = File(...),
    user: dict = Depends(require_user),
) -> dict:
    """
    Ground-photo exterior intelligence (Phase 3). A contractor uploads a
    ground-level photo (or a PDF) of the property; Gemini reads the things a
    top-down satellite tile CANNOT show — true roof pitch from a gable end,
    chimney presence + relative height, dormers, gable walls, and materials.

    The file is uploaded DIRECTLY (multipart) and analyzed in-memory — no
    storage round-trip — so it works regardless of bucket config and accepts any
    common phone image format (JPEG/PNG/WEBP/HEIC) plus PDFs. A PDF is analyzed
    PAGE BY PAGE (each page = its own finding), capped at _GROUND_PHOTO_MAX_PAGES.

    Returns {results: [{page, findings, message}], ...}. Writes nothing —
    applying a finding (set pitch / add chimney) is a separate action.
    """
    import asyncio

    raw = await file.read()
    if not raw or len(raw) < 64:
        raise HTTPException(status_code=400, detail="The file was empty — try uploading again.")
    images, truncated = _normalize_to_images(raw)
    if not images:
        # Targeted HEIC message (ISO-BMFF 'ftyp' box with a heic/heif brand) so a
        # decode failure is never a mystery.
        is_heic = len(raw) > 12 and raw[4:8] == b"ftyp" and any(
            b in raw[8:32] for b in (b"heic", b"heix", b"heif", b"mif1", b"msf1", b"hevc")
        )
        detail = (
            "This HEIC photo couldn't be processed on the server — please export it as JPG and try again."
            if is_heic else
            "That file couldn't be read. Please use a photo (JPG, PNG, HEIC, WEBP) or a PDF."
        )
        raise HTTPException(status_code=400, detail=detail)

    # Analyze every page concurrently, bounded so we don't hammer the LLM.
    sem = asyncio.Semaphore(4)

    async def run_one(idx: int, img: tuple[bytes, str]) -> dict:
        async with sem:
            findings, message = await _analyze_ground_image(img[0], img[1])
            return {"page": idx + 1, "findings": findings, "message": message}

    results = await asyncio.gather(*(run_one(i, im) for i, im in enumerate(images)))

    n = len(results)
    usable = sum(1 for r in results if r["findings"])
    if n == 1:
        message = results[0]["message"]
    else:
        message = f"Analyzed {n} pages — {usable} with usable findings."
        if truncated:
            message += f" (first {_GROUND_PHOTO_MAX_PAGES} pages only)"

    # `findings` kept as a convenience alias for the first usable page.
    first = next((r["findings"] for r in results if r["findings"]), None)

    # Persist the best pitch read on the run so facet detection (and flashing /
    # materials later) can seed from it instead of defaulting to 6/12. Best-effort
    # — a storage hiccup must never fail the analysis the contractor just ran.
    consolidated = _consolidate_ground_findings(results)
    if consolidated is not None:
        try:
            get_supabase().table("roof_measurement_runs").update(
                {"ground_findings": consolidated}
            ).eq("id", run_id).execute()
        except Exception as e:
            logger.warning("could not persist ground_findings on run %s: %s", run_id, e)

    # Persist the photos themselves so they can appear in the report. Best-effort.
    try:
        new_urls = _store_ground_photos(run_id, images)
        if new_urls:
            db = get_supabase()
            cur = db.table("roof_measurement_runs").select(
                "ground_photo_urls").eq("id", run_id).single().execute()
            existing = (cur.data or {}).get("ground_photo_urls") or []
            db.table("roof_measurement_runs").update(
                {"ground_photo_urls": (existing + new_urls)[:24]}
            ).eq("id", run_id).execute()
    except Exception as e:
        logger.info("could not persist ground photo urls for run %s: %s", run_id, e)

    return {"results": results, "findings": first, "message": message}


def _store_ground_photos(run_id: str, images: list[tuple[bytes, str]]) -> list[str]:
    """Upload ground photos to Supabase Storage (the existing 'blueprints' bucket,
    under ground-photos/<run>/) and return long-lived signed URLs for the report.
    Best-effort — returns whatever uploaded."""
    import uuid as _uuid
    from app.core.config import settings as _settings

    bucket = get_supabase().storage.from_("blueprints")
    urls: list[str] = []
    for img_bytes, mt in (images or [])[:12]:
        ext = "png" if "png" in (mt or "") else "jpg"
        key = f"ground-photos/{run_id}/{_uuid.uuid4().hex}.{ext}"
        try:
            bucket.upload(key, img_bytes, {"content-type": mt or "image/jpeg", "upsert": "true"})
            signed = bucket.create_signed_url(key, 31_536_000)
            url = None
            if isinstance(signed, dict):
                url = (signed.get("signedURL") or signed.get("signedUrl")
                       or signed.get("signed_url") or signed.get("url"))
            if url:
                if url.startswith("/"):
                    url = _settings.SUPABASE_URL.rstrip("/") + url
                urls.append(url)
        except Exception as e:
            logger.info("ground photo upload failed: %s", e)
    return urls


@router.get("/runs/{run_id}/solar")
async def get_run_solar(run_id: str, user: dict = Depends(require_user)) -> dict:
    """
    Google Solar building insights for this run's location — pre-segmented roof
    planes with MEASURED pitch + azimuth + area (from Google's digital surface
    model). Inert until GOOGLE_SOLAR_API_KEY is set; returns available=false
    (with a reason) when the key is missing or Google has no coverage here, so
    the frontend silently falls back to the satellite-tracing flow.
    """
    from app.services import solar_service

    db = get_supabase()
    run = db.table("roof_measurement_runs").select(
        "satellite_lat, satellite_lng"
    ).eq("id", run_id).single().execute()
    if not run.data:
        raise HTTPException(status_code=404, detail="Run not found.")
    lat = run.data.get("satellite_lat")
    lng = run.data.get("satellite_lng")
    if lat is None or lng is None:
        return {"available": False, "reason": "This run has no coordinates to look up."}

    return await solar_service.get_building_insights(float(lat), float(lng))


@router.get("/runs/{run_id}/ground-findings")
async def get_run_ground_findings(run_id: str, user: dict = Depends(require_user)) -> dict:
    """Return the consolidated ground-photo findings persisted on the run (pitch,
    chimney, dormers, wall_abutment, roof_shape, …) so other panels — e.g. the
    flashing-edge suggester — can corroborate against what the photos saw."""
    db = get_supabase()
    run = db.table("roof_measurement_runs").select(
        "ground_findings"
    ).eq("id", run_id).single().execute()
    if not run.data:
        raise HTTPException(status_code=404, detail="Run not found.")
    return {"findings": run.data.get("ground_findings")}


class SubjectPointRequest(BaseModel):
    x: float = Field(..., ge=0.0, le=1.0)
    y: float = Field(..., ge=0.0, le=1.0)


@router.post("/runs/{run_id}/subject-point")
async def set_subject_point(
    run_id: str, req: SubjectPointRequest, user: dict = Depends(require_user),
) -> dict:
    """Record the contractor's 'tap your house' point (image fractions 0..1) on
    the run. Facet auto-detect anchors its mask/crop on this so it locks onto the
    right building regardless of geocode offset."""
    db = get_supabase()
    run = db.table("roof_measurement_runs").select("id").eq("id", run_id).single().execute()
    if not run.data:
        raise HTTPException(status_code=404, detail="Run not found.")
    point = {"x": round(req.x, 4), "y": round(req.y, 4)}
    try:
        db.table("roof_measurement_runs").update({"subject_point": point}).eq("id", run_id).execute()
    except Exception as e:
        msg = str(e)
        if "subject_point" in msg or "column" in msg.lower() or "schema cache" in msg.lower():
            raise HTTPException(
                status_code=400,
                detail="Run the migration 20260625_run_subject_point.sql (adds the subject_point column) before saving your house location.",
            )
        logger.warning("set_subject_point failed: %s", e)
        raise HTTPException(status_code=500, detail="Could not save the house location.")
    return {"ok": True, "subject_point": point}


@router.get("/runs/{run_id}/footprint")
async def get_run_footprint(run_id: str, user: dict = Depends(require_user)) -> dict:
    """
    Building footprint (OpenStreetMap) for this run's location — the rural /
    no-Solar-coverage fallback. Free, no key. Returns the subject building's
    outline ring so the frontend can drop it on the tile as a starter facet.
    available=false (with a reason) when nothing is mapped here.
    """
    from app.services import footprint_service

    db = get_supabase()
    run = db.table("roof_measurement_runs").select(
        "satellite_lat, satellite_lng"
    ).eq("id", run_id).single().execute()
    if not run.data:
        raise HTTPException(status_code=404, detail="Run not found.")
    lat = run.data.get("satellite_lat")
    lng = run.data.get("satellite_lng")
    if lat is None or lng is None:
        return {"available": False, "reason": "This run has no coordinates to look up."}

    return await footprint_service.get_building_footprint(float(lat), float(lng))


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

async def _locate_building_bbox(img_bytes: bytes, media_type: str) -> Optional[dict]:
    """Ask vision for the subject building's bounding box as image fractions
    {x0,y0,x1,y1}, or None if it can't confidently find one.

    Run BEFORE facet detection so we can crop the tile tight on the subject
    house: on a wide or off-center tile the facet model otherwise traces the
    driveway or a neighbor's roof, because a prompt that merely says "ignore
    neighbors" can't compete with what's physically in frame. Same prompt the
    auto-center helper (/imagery/detect-building) already uses."""
    from app.services.llm import llm_vision
    import json as _json, re as _re

    prompt = """You are analyzing a top-down satellite image to locate ONE specific building: the SUBJECT property.

CRITICAL — the image is geocoded so the subject building is the one the IMAGE CENTER (0.5, 0.5) falls on, or the building CLOSEST to the center if the center lands on a yard/driveway. Larger or brighter buildings off to the sides are NEIGHBORS — do NOT pick them just because they are bigger. Anchor on the center.

Return ONLY a JSON object with the bounding box of the SUBJECT building as fractions of the image (0.0=left/top, 1.0=right/bottom):
{ "found": true, "x0": 0.30, "y0": 0.25, "x1": 0.70, "y1": 0.65, "confidence": 0.8 }

x0,y0 is the top-left corner of the building's bounding box; x1,y1 the bottom-right. Include the WHOLE roof of the subject (all wings + any attached garage) but EXCLUDE detached sheds, driveways, roads, lawns, pools, and neighboring houses. If you cannot confidently find a building near the center, return {"found": false}. Respond with the JSON object only."""

    try:
        text = await llm_vision(img_bytes, media_type, prompt, max_tokens=300)
        text = (text or "").strip()
        text = _re.sub(r"^```(?:json)?\s*", "", text, flags=_re.MULTILINE)
        text = _re.sub(r"\s*```\s*$", "", text)
        a, b = text.find("{"), text.rfind("}")
        if a < 0 or b < 0:
            return None
        parsed = _json.loads(text[a:b + 1])
    except Exception as e:
        logger.warning("facet pre-localize (bbox) failed: %s", e)
        return None

    if not parsed.get("found"):
        return None
    try:
        x0 = max(0.0, min(1.0, float(parsed["x0"])))
        y0 = max(0.0, min(1.0, float(parsed["y0"])))
        x1 = max(0.0, min(1.0, float(parsed["x1"])))
        y1 = max(0.0, min(1.0, float(parsed["y1"])))
    except (KeyError, TypeError, ValueError):
        return None
    if x1 <= x0 or y1 <= y0:
        return None
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


def _crop_to_bbox(
    img_bytes: bytes, bbox: dict, margin: float = 0.18,
) -> tuple[bytes, tuple[float, float, float, float]]:
    """Crop the tile to `bbox` expanded by `margin` of the bbox size on each
    side (so eaves/overhangs aren't clipped), and return the cropped PNG bytes
    plus the crop window in ORIGINAL-tile fractions (cx0,cy0,cx1,cy1).

    Callers map facet polygons — detected in crop space — back to full-tile
    fractions with that window, since the editor overlays on the full tile.
    On any failure (or a degenerate sliver crop) returns the original bytes and
    the identity window (0,0,1,1) so detection still runs on the whole tile."""
    try:
        import io as _io
        from PIL import Image

        im = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
        W, H = im.size
        bw = bbox["x1"] - bbox["x0"]
        bh = bbox["y1"] - bbox["y0"]
        cx0 = max(0.0, bbox["x0"] - margin * bw)
        cy0 = max(0.0, bbox["y0"] - margin * bh)
        cx1 = min(1.0, bbox["x1"] + margin * bw)
        cy1 = min(1.0, bbox["y1"] + margin * bh)
        left, top, right, bottom = int(cx0 * W), int(cy0 * H), int(cx1 * W), int(cy1 * H)
        if right - left < 32 or bottom - top < 32:
            return img_bytes, (0.0, 0.0, 1.0, 1.0)
        crop = im.crop((left, top, right, bottom))
        buf = _io.BytesIO()
        crop.save(buf, format="PNG")
        return buf.getvalue(), (cx0, cy0, cx1, cy1)
    except Exception as e:
        logger.info("facet crop-to-bbox failed (%s) — using full tile", e)
        return img_bytes, (0.0, 0.0, 1.0, 1.0)


def _point_in_poly(pt: tuple, poly: list) -> bool:
    """Ray-casting point-in-polygon (image-fraction coords)."""
    x, y = pt
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i][0], poly[i][1]
        xj, yj = poly[j][0], poly[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _expand_polygon(poly: list, factor: float) -> list:
    """Scale a polygon outward from its centroid (eave/overhang margin)."""
    cx = sum(p[0] for p in poly) / len(poly)
    cy = sum(p[1] for p in poly) / len(poly)
    return [[cx + (p[0] - cx) * factor, cy + (p[1] - cy) * factor] for p in poly]


def _mask_and_crop(
    img_bytes: bytes, polygons: list, margin: float = 0.15,
) -> tuple[bytes, tuple[float, float, float, float]]:
    """Black out every pixel OUTSIDE the subject building polygon(s), then crop to
    their bounding box. This is the hard stop on the wrong-house problem: the
    vision model literally cannot trace a neighbor, driveway, or yard because
    they're painted black. `polygons` are in image fractions (Solar planes or the
    OSM footprint). Returns (png_bytes, crop_window_fractions); degrades to the
    full tile on any failure."""
    try:
        import io as _io
        from PIL import Image, ImageDraw

        im = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
        W, H = im.size
        expanded = [_expand_polygon(p, 1.0 + margin) for p in polygons if len(p) >= 3]
        if not expanded:
            return img_bytes, (0.0, 0.0, 1.0, 1.0)

        mask = Image.new("L", (W, H), 0)
        draw = ImageDraw.Draw(mask)
        for poly in expanded:
            pts = [(max(0.0, min(1.0, x)) * W, max(0.0, min(1.0, y)) * H) for x, y in poly]
            draw.polygon(pts, fill=255)
        masked = Image.composite(im, Image.new("RGB", (W, H), (0, 0, 0)), mask)

        xs = [x for poly in expanded for x, _ in poly]
        ys = [y for poly in expanded for _, y in poly]
        cx0, cy0 = max(0.0, min(xs)), max(0.0, min(ys))
        cx1, cy1 = min(1.0, max(xs)), min(1.0, max(ys))
        if cx1 - cx0 < 0.02 or cy1 - cy0 < 0.02:
            return img_bytes, (0.0, 0.0, 1.0, 1.0)
        crop = masked.crop((int(cx0 * W), int(cy0 * H), int(cx1 * W), int(cy1 * H)))
        buf = _io.BytesIO()
        crop.save(buf, format="PNG")
        return buf.getvalue(), (cx0, cy0, cx1, cy1)
    except Exception as e:
        logger.info("facet mask-and-crop failed (%s) — using full tile", e)
        return img_bytes, (0.0, 0.0, 1.0, 1.0)


def _crop_around_point(
    img_bytes: bytes, anchor: tuple, frac: float = 0.5,
) -> tuple[bytes, tuple[float, float, float, float]]:
    """Crop a window of size `frac` of the tile centered on `anchor` (the
    contractor's tap on their house, in image fractions). The window is shifted
    to stay in-bounds while keeping its size. Returns (png_bytes, crop_window)."""
    try:
        import io as _io
        from PIL import Image

        im = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
        W, H = im.size
        ax, ay = anchor
        half = frac / 2.0
        cx0, cy0, cx1, cy1 = ax - half, ay - half, ax + half, ay + half
        if cx0 < 0: cx1 -= cx0; cx0 = 0.0
        if cy0 < 0: cy1 -= cy0; cy0 = 0.0
        if cx1 > 1: cx0 -= (cx1 - 1); cx1 = 1.0
        if cy1 > 1: cy0 -= (cy1 - 1); cy1 = 1.0
        cx0, cy0 = max(0.0, cx0), max(0.0, cy0)
        crop = im.crop((int(cx0 * W), int(cy0 * H), int(cx1 * W), int(cy1 * H)))
        buf = _io.BytesIO()
        crop.save(buf, format="PNG")
        return buf.getvalue(), (cx0, cy0, cx1, cy1)
    except Exception as e:
        logger.info("crop-around-point failed (%s) — using full tile", e)
        return img_bytes, (0.0, 0.0, 1.0, 1.0)


def _center_crop(
    img_bytes: bytes, frac: float = 0.6,
) -> tuple[bytes, tuple[float, float, float, float]]:
    """Crop the central `frac` of the tile. The run's tile is geocoded on the
    subject address, so the subject building is at the image center — when
    building localization is unavailable OR untrustworthy (it boxed a neighbor),
    a centered crop still drops the roads and neighboring houses at the tile
    edges and keeps the model on the subject. Returns (png_bytes, crop_window)."""
    try:
        import io as _io
        from PIL import Image

        im = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
        W, H = im.size
        m = (1.0 - frac) / 2.0
        cx0, cy0, cx1, cy1 = m, m, 1.0 - m, 1.0 - m
        crop = im.crop((int(cx0 * W), int(cy0 * H), int(cx1 * W), int(cy1 * H)))
        buf = _io.BytesIO()
        crop.save(buf, format="PNG")
        return buf.getvalue(), (cx0, cy0, cx1, cy1)
    except Exception as e:
        logger.info("facet center-crop failed (%s) — using full tile", e)
        return img_bytes, (0.0, 0.0, 1.0, 1.0)


def _dominant_solar_pitch(segments: list[dict]) -> Optional[str]:
    """Area-weighted majority pitch across Google Solar roof segments. Most homes
    are a single pitch; weighting by area keeps a small dormer plane from
    outvoting the main roof. Returns None if no segment carries a pitch."""
    by_pitch: dict[str, float] = {}
    for s in segments:
        p = str(s.get("pitch") or "").strip()
        if not p:
            continue
        by_pitch[p] = by_pitch.get(p, 0.0) + float(s.get("area_sqft") or 0.0)
    if not by_pitch:
        return None
    return max(by_pitch.items(), key=lambda kv: kv[1])[0]


def _expected_facets_from_shape(shape: Optional[str]) -> Optional[int]:
    """Rough expected plane count from a ground-photo roof shape, for the sanity
    check. 'complex'/'unknown' return None — too variable to assert a count."""
    return {"gable": 2, "hip": 4, "shed": 1, "flat": 1}.get((shape or "").strip().lower())


def _resolve_pitch(solar_pitch: Optional[str], ground: Optional[dict], ai_pitch) -> tuple[str, str]:
    """Pick the best pitch + its provenance, killing the silent 6/12 default.

    Precedence: Google Solar's MEASURED pitch (Google's own photogrammetry) >
    a confident GROUND-PHOTO read (off a gable end) > the satellite AI's
    foreshortened guess > the bare default. The AI's own '6/12' is treated as
    'default' because the detection prompt returns 6/12 precisely when it is
    UNSURE — so it must be flagged for the contractor, not trusted. Returns
    (pitch_string, source) with source one of
    'solar_measured' | 'ground_photo' | 'ai_satellite' | 'default'."""
    sp = str(solar_pitch or "").strip()
    if sp:
        return sp, "solar_measured"
    if ground:
        gp = str(ground.get("roof_pitch") or "").strip()
        if gp and ground.get("pitch_confidence") in ("high", "medium"):
            return gp, "ground_photo"
    ai = str(ai_pitch or "").strip()
    if ai and ai != "6/12":
        return ai, "ai_satellite"
    return "6/12", "default"


def _geo_to_frac(lat: float, lng: float, c_lat: float, c_lng: float, mpp: float,
                 w_px: int = 2048, h_px: int = 1366) -> list[float]:
    """Geographic point → image fraction, in the SAME basis the measurement
    pipeline uses (tile center + metres_per_pixel × logical dims). Mirrors the
    frontend SolarAssistPanel.geoToFrac so Solar rectangles land where the panel
    draws them."""
    ground_w = (w_px * mpp) or 1.0
    ground_h = (h_px * mpp) or 1.0
    east_m = (lng - c_lng) * 111320.0 * math.cos(math.radians(c_lat))
    north_m = (lat - c_lat) * 111320.0
    fx = 0.5 + east_m / ground_w
    fy = 0.5 - north_m / ground_h           # north (higher lat) = up
    return [max(0.0, min(1.0, fx)), max(0.0, min(1.0, fy))]


def _solar_segments_as_fractions(
    solar: dict, c_lat: float, c_lng: float, zoom: int,
) -> list[dict]:
    """Convert Google Solar segments into image-fraction rectangles + centers so
    they can be matched against AI-traced polygons. Returns [] on any problem."""
    segs = solar.get("segments") or []
    if not segs:
        return []
    mpp = geo.metres_per_pixel(c_lat, zoom)
    out: list[dict] = []
    for s in segs:
        bbox = s.get("bbox") or {}
        sw, ne = bbox.get("sw"), bbox.get("ne")
        ctr = s.get("center") or {}
        if not sw or not ne:
            continue
        try:
            nw_f = _geo_to_frac(ne["lat"], sw["lng"], c_lat, c_lng, mpp)
            ne_f = _geo_to_frac(ne["lat"], ne["lng"], c_lat, c_lng, mpp)
            se_f = _geo_to_frac(sw["lat"], ne["lng"], c_lat, c_lng, mpp)
            sw_f = _geo_to_frac(sw["lat"], sw["lng"], c_lat, c_lng, mpp)
            cx = (ctr.get("lng"), ctr.get("lat"))
            center_f = (_geo_to_frac(cx[1], cx[0], c_lat, c_lng, mpp)
                        if cx[0] is not None and cx[1] is not None
                        else [(nw_f[0] + se_f[0]) / 2, (nw_f[1] + se_f[1]) / 2])
        except (KeyError, TypeError, ValueError):
            continue
        xs = [nw_f[0], ne_f[0], se_f[0], sw_f[0]]
        ys = [nw_f[1], ne_f[1], se_f[1], sw_f[1]]
        out.append({
            "rect": [nw_f, ne_f, se_f, sw_f],
            "bbox": (min(xs), min(ys), max(xs), max(ys)),
            "center": center_f,
            "pitch": str(s.get("pitch") or "").strip(),
            "area_sqft": float(s.get("area_sqft") or 0.0),
            "slope_direction": str(s.get("slope_direction") or ""),
            "azimuth_degrees": (float(s["azimuth_degrees"]) if s.get("azimuth_degrees") is not None else None),
        })
    return out


def _vegetation_fraction(im, polygon: list) -> float:
    """Fraction of a polygon's bounding-box pixels that read as GREEN vegetation
    (bushes / trees / lawn). Roofs are gray/brown; vegetation has green clearly
    dominant. Uses Excess-Green (2G−R−B) on a small sampling grid — cheap and
    robust. `im` is a PIL RGB image of the full tile; polygon is in fractions."""
    try:
        W, H = im.size
        xs = [p[0] for p in polygon]
        ys = [p[1] for p in polygon]
        x0, x1 = int(min(xs) * W), int(max(xs) * W)
        y0, y1 = int(min(ys) * H), int(max(ys) * H)
        if x1 - x0 < 2 or y1 - y0 < 2:
            return 0.0
        px = im.load()
        nx = min(24, x1 - x0)
        ny = min(24, y1 - y0)
        veg = total = 0
        for i in range(nx):
            for j in range(ny):
                x = x0 + (i * (x1 - x0)) // nx
                y = y0 + (j * (y1 - y0)) // ny
                r, g, b = px[x, y][:3]
                total += 1
                if (2 * g - r - b) > 30 and g > r and g > b:
                    veg += 1
        return veg / total if total else 0.0
    except Exception:
        return 0.0


def _signed_area(poly: list) -> float:
    """Shoelace signed area of a polygon (image-fraction coords)."""
    a = 0.0
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i][0], poly[i][1]
        x2, y2 = poly[(i + 1) % n][0], poly[(i + 1) % n][1]
        a += x1 * y2 - x2 * y1
    return a * 0.5


def _oriented_positive(poly: list) -> list:
    """Return the polygon wound so its signed area is positive — the convention
    the clipper's inside-test assumes for a convex clip region."""
    return poly if _signed_area(poly) >= 0 else list(reversed(poly))


def _clip_polygon(subject: list, clip: list) -> list:
    """Sutherland–Hodgman: clip `subject` by the CONVEX `clip` polygon (wound
    positive). Returns the intersection polygon (possibly empty)."""
    def inside(p, a, b):
        return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0

    def isect(s, e, a, b):
        x1, y1 = s; x2, y2 = e; x3, y3 = a; x4, y4 = b
        den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
        if abs(den) < 1e-12:
            return e
        t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
        return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)]

    output = list(subject)
    n = len(clip)
    for i in range(n):
        a, b = clip[i], clip[(i + 1) % n]
        inp, output = output, []
        if not inp:
            break
        s = inp[-1]
        for e in inp:
            if inside(e, a, b):
                if not inside(s, a, b):
                    output.append(isect(s, e, a, b))
                output.append(e)
            elif inside(s, a, b):
                output.append(isect(s, e, a, b))
            s = e
    return output


def _coverage(ai_poly: list, seg_rect_ccw: list) -> float:
    """Fraction of the AI polygon's area that lies inside a Solar segment rect —
    i.e. 'how much of this traced plane belongs to that Solar plane'. Robust to a
    small traced polygon sitting inside a larger Solar bbox (which a raw IoU would
    score low)."""
    area_a = abs(_signed_area(ai_poly))
    if area_a < 1e-9:
        return 0.0
    clipped = _clip_polygon(ai_poly, seg_rect_ccw)
    if len(clipped) < 3:
        return 0.0
    return abs(_signed_area(clipped)) / area_a


def _layer_with_solar(ai_facets: list[dict], segs: list[dict]) -> list[dict]:
    """Reconcile AI-traced polygons with Google Solar's measured planes — the
    most beneficial combination of the two sources:

      * Solar plane WITH a matching AI polygon → keep the AI SHAPE, stamp it with
        Solar's MEASURED pitch, mark solar_confirmed (best of both).
      * Solar plane the AI MISSED → keep Solar's rectangle so the plane (and its
        area) is never lost; the contractor drags it to shape.
      * AI polygon matching NO Solar plane → likely a false positive (driveway /
        neighbor / shadow). Keep it but FLAG it and cap its confidence so it
        sorts last — Solar acts as the validator that kills hallucinations.
    """
    MATCH_THRESHOLD = 0.5      # ≥50% of the AI polygon must lie in the Solar plane
    seg_rects_ccw = [_oriented_positive(s["rect"]) for s in segs]
    seg_got = [False] * len(segs)
    result: list[dict] = []

    # Compass-direction → measured pitch, for facets that DON'T cleanly overlap a
    # Solar plane: if Solar has a plane facing the same way, borrow its measured
    # pitch (area-weighted winner per direction). This is the direction-matched
    # pitch fallback — better than a guess when overlap matching comes up empty.
    dir_pitch: dict[str, tuple[str, float]] = {}
    for s in segs:
        d, p = (s.get("slope_direction") or "").strip(), (s.get("pitch") or "").strip()
        if d and p and (d not in dir_pitch or s.get("area_sqft", 0.0) > dir_pitch[d][1]):
            dir_pitch[d] = (p, float(s.get("area_sqft") or 0.0))

    # Assign each AI polygon to the Solar plane that covers the MOST of it
    # (overlap, not just centroid). A plane can legitimately receive more than one
    # traced sub-plane; planes that receive none are emitted as rectangles below.
    for fct in ai_facets:
        best_j, best_cov = None, 0.0
        for j, rect in enumerate(seg_rects_ccw):
            cov = _coverage(fct["polygon"], rect)
            if cov > best_cov:
                best_cov, best_j = cov, j

        if best_j is not None and best_cov >= MATCH_THRESHOLD:
            seg = segs[best_j]
            seg_got[best_j] = True
            f = dict(fct)
            if seg["pitch"]:               # per-facet pitch: THIS plane's measured pitch
                f["predicted_pitch"] = seg["pitch"]
                f["pitch_source"] = "solar_measured"
            f["solar_confirmed"] = True
            f["confidence"] = max(f.get("confidence", 0.7), 0.85)
            f["note"] = ("Shape AI-traced; plane + pitch confirmed by Google Solar. "
                         + f.get("note", "")).strip()
            result.append(f)
        else:
            # No Solar plane covers this polygon — probable false positive.
            f = dict(fct)
            f["solar_confirmed"] = False
            # Direction-matched pitch fallback: if Solar has a plane facing the
            # same compass direction, use its MEASURED pitch instead of a guess.
            fdir = geo.compass_direction(geo.longest_edge_orientation_deg(fct["polygon"]))
            if fdir and fdir in dir_pitch:
                f["predicted_pitch"] = dir_pitch[fdir][0]
                f["pitch_source"] = "solar_direction"
            elif f.get("pitch_source") == "solar_measured":
                # Don't claim a Solar-measured pitch on a plane Solar didn't confirm.
                f["pitch_source"] = "ai_satellite"
            f["confidence"] = min(f.get("confidence", 0.5), 0.45)
            f["note"] = ("⚠ Not in Google Solar data — verify this is a real roof plane "
                         "(could be a neighbor, shadow, or ground). " + f.get("note", "")).strip()
            result.append(f)

    # Solar planes no AI polygon covered → keep as rectangles so we never lose a
    # real plane (or its measured pitch + area).
    for j, seg in enumerate(segs):
        if seg_got[j]:
            continue
        result.append({
            "polygon": seg["rect"],
            "confidence": 0.8,
            "predicted_pitch": seg["pitch"] or "6/12",
            "pitch_source": "solar_measured" if seg["pitch"] else "default",
            "facet_type": "other",
            "note": (f"Google Solar plane ({seg['slope_direction']}, "
                     f"~{round(seg['area_sqft'])} ft²) — drag the corners to the real roof edges."),
            "ai_suggested": True,
            "user_confirmed": False,
            "solar_confirmed": True,
        })

    # When Solar confirms real planes, DROP the unconfirmed AI guesses entirely —
    # those are the driveway / bushes / neighbor that the contractor keeps having
    # to reject. Show ONLY the actual roof. Keep the flagged guesses only if Solar
    # confirmed nothing, so a no-coverage roof still returns something to refine.
    confirmed = [f for f in result if f.get("solar_confirmed")]
    return confirmed if confirmed else result


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
        "satellite_image_url, satellite_zoom, satellite_lat, satellite_lng, ground_findings, subject_point"
    ).eq("id", run_id).single().execute()
    if not run.data:
        raise HTTPException(status_code=404, detail="Run not found.")
    img_url = run.data.get("satellite_image_url")
    if not img_url:
        return {"facets": [], "message": "No satellite image attached to this run."}
    ground_findings = run.data.get("ground_findings") or None

    # Google Solar gives MEASURED pitch (Google's photogrammetry) — the best
    # pitch source we have. Pull the area-weighted dominant pitch to seed facets.
    # Cached + best-effort: a miss or no coverage just falls through to the
    # ground-photo / AI / default ladder.
    solar_pitch: Optional[str] = None
    solar_segs: list[dict] = []
    s_lat, s_lng = run.data.get("satellite_lat"), run.data.get("satellite_lng")
    s_zoom = run.data.get("satellite_zoom") or 20
    if s_lat is not None and s_lng is not None:
        try:
            from app.services import solar_service
            solar = await solar_service.get_building_insights(float(s_lat), float(s_lng))
            if solar.get("available"):
                solar_pitch = _dominant_solar_pitch(solar.get("segments") or [])
                solar_segs = _solar_segments_as_fractions(
                    solar, float(s_lat), float(s_lng), int(s_zoom))
        except Exception as e:
            logger.info("solar lookup failed for run %s: %s", run_id, e)

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

IMPORTANT: Everything OUTSIDE the subject building may be masked to solid BLACK.
Trace roof planes ONLY on the visible (non-black) building. Never trace into black
areas, and treat any black region as 'not roof'.

You may FIRST be shown labeled REFERENCE EXAMPLE diagrams of roof types (gable,
hip, complex/valley) from above. Use them only to choose each facet's "facet_type"
correctly — do NOT copy their shapes; trace the actual building in the photo.

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
- ALWAYS return your BEST ATTEMPT at the main building's roof, even when the
  imagery is hazy or the boundaries aren't crisp. A rough polygon with a LOW
  confidence (0.3-0.5) is far more useful than nothing — the contractor will
  refine it. Use confidence to express uncertainty; do NOT use [] to express it.
- If the whole roof reads as one plane, return that ONE facet. If you can make
  out a likely ridge, split into 2. Don't hold back waiting for certainty.
- Return facets: [] ONLY if there is genuinely no building in the frame at all.

Return ONLY valid JSON (no prose, no markdown). ALWAYS include a top-level
"reason" string explaining what you saw — especially when facets is empty,
explain WHY (e.g. "heavy tree canopy obscures the roof", "imagery too low-
resolution to resolve plane boundaries", "building is at the image edge — not
centered", "only flat gravel/commercial roof visible, no distinct planes"):
{
  "reason": "Clear hip roof centered in frame; traced 4 planes.",
  "facets": [
    {
      "polygon": [[0.30, 0.28], [0.70, 0.28], [0.70, 0.50], [0.30, 0.50]],
      "confidence": 0.78,
      "predicted_pitch": "6/12",
      "facet_type": "hip-front",
      "note": "Front-facing main facet, eave visible along bottom"
    }
  ]
}

"facet_type" MUST be one of these exact strings — it tells the contractor what
kind of plane you traced and is shown next to each suggestion:
  - "gable-front" / "gable-rear": a slope of a simple two-sided (gable) roof
  - "hip-front" / "hip-rear" / "hip-left" / "hip-right": a slope of a four-sided hip roof
  - "garage": a slope belonging to an attached garage wing
  - "dormer": a small projecting dormer roof
  - "flat": a low-slope / flat commercial-style plane
  - "shed": a single-slope (lean-to) plane
  - "other": a roof plane that fits none of the above
"note" MUST briefly justify WHY this is a roof plane and not ground (e.g. "shingle
texture + eave shadow along the south edge; meets ridge at top"). Keep it concise.

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

    # FIRST localize the subject building and crop the tile tight on it. On a
    # wide / off-center tile this is what stops the model from tracing the
    # driveway or a neighbor's roof: those features are literally cropped out of
    # frame. crop_win is the crop rectangle in full-tile fractions; we map the
    # returned polygons back through it below. If localization fails we crop
    # nothing (identity window) and detect on the whole tile as before.
    # P0-1 — HARD-MASK to the subject building so the model can't trace a
    # neighbor / driveway / yard. Build the building polygon(s) from the most
    # authoritative source available:
    #   1. Google Solar roof planes (already computed above), else
    #   2. the OSM building footprint (free, nationwide, no key).
    # Everything outside is painted black, then we crop to it.
    # ANCHOR = where the contractor TAPPED their house (image fractions). The
    # geocode can be offset to the street, so the tap is the reliable "this is my
    # house" signal. Defaults to tile center if they didn't tap.
    _tap = run.data.get("subject_point") or {}
    try:
        anchor = (float(_tap.get("x", 0.5)), float(_tap.get("y", 0.5)))
    except (TypeError, ValueError):
        anchor = (0.5, 0.5)
    tapped = bool(_tap.get("x") is not None)

    building_polys: list = []
    mask_source = "none"
    bbox = None   # set only in the no-geometry fallback; the centroid guard keys off it
    if solar_segs:
        building_polys = [s["rect"] for s in solar_segs if s.get("rect")]
        mask_source = "solar"
    elif s_lat is not None and s_lng is not None:
        try:
            from app.services import footprint_service
            fp = await footprint_service.get_building_footprint(float(s_lat), float(s_lng))
            ring = fp.get("ring") if fp.get("available") else None
            if ring and len(ring) >= 3:
                mpp = geo.metres_per_pixel(float(s_lat), int(s_zoom))
                building_polys = [[
                    _geo_to_frac(p["lat"], p["lng"], float(s_lat), float(s_lng), mpp)
                    for p in ring
                ]]
                mask_source = "footprint"
        except Exception as e:
            logger.info("footprint mask fetch failed: %s", e)

    # SAFETY: only mask to a building outline if it actually covers the ANCHOR
    # (the tapped house, or center). If it doesn't, the outline is mis-registered
    # or it's a neighbor — masking would black out the real house, so we crop
    # around the anchor instead.
    if building_polys:
        anchor_covered = any(
            _point_in_poly(anchor, _expand_polygon(p, 1.30))
            for p in building_polys if len(p) >= 3
        )
        if not anchor_covered:
            logger.info("facet mask: %s outline does NOT cover anchor %s — cropping around anchor", mask_source, anchor)
            building_polys = []
            mask_source = f"{mask_source}_off_anchor→crop"

    if building_polys:
        detect_bytes, crop_win = _mask_and_crop(img_bytes, building_polys, margin=0.15)
    else:
        # Crop a tight window around the tapped house (or center). Reliable and
        # cheap — no fragile georegistration or extra vision call.
        detect_bytes, crop_win = _crop_around_point(img_bytes, anchor, frac=0.5)
        if mask_source == "none":
            mask_source = "tap_crop" if tapped else "center_crop"
    logger.info("facet detect mask_source=%s tapped=%s anchor=%s crop_win=%s", mask_source, tapped, anchor, crop_win)
    cwx0, cwy0, cwx1, cwy1 = crop_win
    cw_w, cw_h = (cwx1 - cwx0), (cwy1 - cwy0)

    # Give the vision model a contrast-boosted, sharpened copy — the same idea
    # as the client clarity tool — so plane boundaries are easier for it to
    # resolve on hazy tiles. Falls back to the original on any error.
    vision_bytes, vision_mt = _enhance_for_vision(detect_bytes, mt)

    # AI tracing failures set facets=[] and a reason but DON'T return — if Google
    # Solar has planes for this address we still want to hand those back below.
    facets: list = []
    reason = ""
    refs = _roof_reference_examples() if USE_FACET_REFERENCES else None
    try:
        text = await llm_vision(vision_bytes, vision_mt, prompt, max_tokens=2048, reference_images=refs)
        parsed = _loads_tolerant(text)
        if parsed is None:
            reason = "The vision model did not return structured data for this tile."
        else:
            facets = parsed.get("facets") or []
            reason = str(parsed.get("reason") or "")[:400]
    except Exception as e:
        reason = f"Vision analysis error: {str(e)[:160]}"

    # Geometric guards. When we localized the subject building, reject any
    # suggested plane whose centroid lands well outside it — that's a road, a
    # neighbor, or the driveway that slipped into the crop margin. Always reject
    # long, thin road-like strips by aspect ratio. The halo (30% of bbox size)
    # tolerates eaves/overhangs and an attached garage wing the localizer may
    # have under-boxed.
    if bbox:
        bw, bh = (bbox["x1"] - bbox["x0"]), (bbox["y1"] - bbox["y0"])
        gx0, gy0 = bbox["x0"] - 0.12 * bw, bbox["y0"] - 0.12 * bh
        gx1, gy1 = bbox["x1"] + 0.12 * bw, bbox["y1"] + 0.12 * bh

    # Load the ORIGINAL tile once for the vegetation guard (best-effort).
    veg_im = None
    try:
        import io as _io
        from PIL import Image as _Image
        veg_im = _Image.open(_io.BytesIO(img_bytes)).convert("RGB")
    except Exception:
        veg_im = None

    # Sanitize: each facet must have a polygon of >=3 [x,y] pairs in [0,1]
    cleaned: list[dict] = []
    dropped_off_building = 0
    dropped_strips = 0
    dropped_vegetation = 0
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
            # Model coords are fractions of the CROPPED image — map them back
            # onto the full tile so the editor overlay lines up. Identity
            # mapping when no crop was applied (crop_win == 0,0,1,1).
            fx = max(0.0, min(1.0, cwx0 + x * cw_w))
            fy = max(0.0, min(1.0, cwy0 + y * cw_h))
            valid.append([fx, fy])
        if not ok or len(valid) < 3:
            continue

        # Reject planes whose centroid is off the subject building.
        cx = sum(p[0] for p in valid) / len(valid)
        cy = sum(p[1] for p in valid) / len(valid)
        if bbox and not (gx0 <= cx <= gx1 and gy0 <= cy <= gy1):
            dropped_off_building += 1
            continue

        # Reject long, thin strips — driveways/roads, not roof planes.
        pxs, pys = [p[0] for p in valid], [p[1] for p in valid]
        long_side = max(max(pxs) - min(pxs), max(pys) - min(pys))
        short_side = min(max(pxs) - min(pxs), max(pys) - min(pys))
        if short_side > 0 and long_side / short_side > 7.0:
            dropped_strips += 1
            continue

        # Reject vegetation — a roof is gray/brown, a bush/tree/lawn is green.
        if veg_im is not None and _vegetation_fraction(veg_im, valid) > 0.45:
            dropped_vegetation += 1
            continue

        # Seed pitch from the best available source instead of blindly defaulting.
        pitch, pitch_source = _resolve_pitch(solar_pitch, ground_findings, f.get("predicted_pitch"))
        cleaned.append({
            "polygon": valid,
            "confidence": geo.normalize_confidence(f.get("confidence")),
            "predicted_pitch": pitch,
            "pitch_source": pitch_source,
            "facet_type": str(f.get("facet_type") or "other").strip().lower()[:20],
            "note": str(f.get("note") or "")[:250],
            "ai_suggested": True,
            "user_confirmed": False,
            "solar_confirmed": False,
        })

    # Surface what the guards removed so the contractor understands the result.
    drop_notes = []
    if dropped_off_building:
        drop_notes.append(f"{dropped_off_building} off-building (road/neighbor)")
    if dropped_strips:
        drop_notes.append(f"{dropped_strips} road-like strip(s)")
    if dropped_vegetation:
        drop_notes.append(f"{dropped_vegetation} on vegetation (bushes/trees)")
    drop_suffix = f" Filtered out {', '.join(drop_notes)}." if drop_notes else ""

    # LAYER with Google Solar: keep AI shapes where Solar confirms a plane (with
    # measured pitch), add Solar planes the AI missed, and flag AI polygons Solar
    # never confirmed. Runs even when the AI found nothing, so a Solar-covered
    # address still gets real planes back.
    solar_used = bool(solar_segs)
    if solar_segs:
        cleaned = _layer_with_solar(cleaned, solar_segs)

    # Cross-check the plane count against the ground photo's read of the roof
    # shape (gable≈2, hip≈4, …). A big mismatch usually means over/under-
    # segmentation or planes landing on the wrong building — surface it, never
    # auto-act on it.
    count_check = None
    gshape = (ground_findings or {}).get("roof_shape") if ground_findings else None
    expected = _expected_facets_from_shape(gshape)
    if expected is not None and cleaned:
        detected = len(cleaned)
        if detected > expected + 1 or detected < max(1, expected - 1):
            count_check = {
                "shape": gshape,
                "expected": expected,
                "detected": detected,
                "note": (f"Your ground photo looks like a {gshape} roof (~{expected} planes), "
                         f"but {detected} were detected. Double-check for extra/missing planes."),
            }

    if not cleaned:
        return {
            "facets": [],
            "solar_used": solar_used,
            "mask_source": mask_source,
            "reason": reason or "The model reported no clearly-distinguishable roof planes.",
            "message": (
                "AI found no facets on the subject building it was confident about."
                + drop_suffix
                + " This usually means the roof is obscured (trees/shadow) or the house "
                "isn't centered, or trace facets manually — the snap-to-edge assist makes it fast."
                + f" [detect: {mask_source}]"
            ),
        }

    if solar_used:
        lead = (f"{len(cleaned)} roof plane(s) from Google Solar with MEASURED pitch. "
                "Off-roof AI guesses (driveway / bushes / neighbor) were filtered out — "
                "drag any rectangle's corners to the exact roof edges.")
    else:
        lead = (f"{len(cleaned)} facet(s) suggested by AI vision.{drop_suffix} "
                "No Google Solar coverage here — verify each one carefully.")
    return {
        "facets": cleaned,
        "solar_used": solar_used,
        "count_check": count_check,
        "mask_source": mask_source,
        "reason": reason,
        "message": lead + f" Accept each individually and verify pitch + edge labels before measurements are valid. [detect: {mask_source}]",
    }


class RejectedFacet(BaseModel):
    polygon: list[list[float]] = Field(..., min_length=3)
    facet_type: Optional[str] = None
    ai_confidence: Optional[float] = None


class FacetRejectionsRequest(BaseModel):
    rejections: list[RejectedFacet]


@router.post("/runs/{run_id}/facets/rejections")
async def record_facet_rejections(
    run_id: str, req: FacetRejectionsRequest, user: dict = Depends(require_user),
) -> dict:
    """Capture AI facet suggestions the contractor REJECTED as negative training
    examples — the high-value signal the confirm-only triggers miss.

    A confirmed facet already becomes a positive example via the roof_facets
    trigger. But a rejection ("the AI drew a polygon on the driveway / the
    neighbor's roof and a human said NO") is never persisted today, so the model
    can't learn from its false positives — exactly the failure the contractor
    keeps seeing. We store each rejected polygon in training_examples with
    capture_source='ai_rejected' so the future segmentation model learns what is
    NOT a roof plane. Accepts (and accept-then-edit) are captured on save, not
    here, to avoid duplicate rows."""
    db = get_supabase()
    run = db.table("roof_measurement_runs").select(
        "satellite_image_url, satellite_lat, satellite_lng, satellite_zoom, satellite_provider"
    ).eq("id", run_id).single().execute()
    if not run.data:
        raise HTTPException(status_code=404, detail="Run not found.")
    img_url = run.data.get("satellite_image_url")
    if not img_url:
        return {"recorded": 0, "message": "No satellite image on this run — nothing to record."}

    rows: list[dict] = []
    for r in req.rejections:
        # Clamp coords defensively; skip anything not a real polygon.
        poly = [[max(0.0, min(1.0, float(p[0]))), max(0.0, min(1.0, float(p[1])))]
                for p in r.polygon if isinstance(p, (list, tuple)) and len(p) >= 2]
        if len(poly) < 3:
            continue
        rows.append({
            "user_id": user["id"],
            "source_table": "roof_facets",
            "source_id": None,        # never saved — NULLs are distinct in the unique index
            "task_type": "roof_facet_polygon",
            "image_url": img_url,
            "image_width_px": 2048,
            "image_height_px": 1366,
            "geo_lat": run.data.get("satellite_lat"),
            "geo_lng": run.data.get("satellite_lng"),
            "satellite_zoom": run.data.get("satellite_zoom"),
            "satellite_provider": run.data.get("satellite_provider"),
            "annotation": {
                "polygon": poly,
                "facet_type": (r.facet_type or "other"),
                "ai_confidence": r.ai_confidence,
                "label": "negative",
                "verdict": "rejected",
            },
            "capture_source": "ai_rejected",
            "quality_tier": "unverified",
            "contractor_confidence": r.ai_confidence,
        })

    recorded = 0
    if rows:
        try:
            ins = db.table("training_examples").insert(rows).execute()
            recorded = len(ins.data or [])
        except Exception as e:
            # Never let training capture break the contractor's flow.
            logger.warning("facet rejection capture failed: %s", e)
            return {"recorded": 0, "message": "Could not record rejection (logged)."}

    return {"recorded": recorded}


def _geom_edge_confidence(poly: list, vi: int, edge_type: str) -> tuple[float, str]:
    """How sure is the GEOMETRY about an unshared eave/rake guess? Replaces the
    old flat 0.45 'I dunno' with a graded score: a clearly horizontal LOWEST edge
    is a confident eave; a clearly sloped side edge is a confident rake; only true
    diagonals stay low. This is why most edges used to read 45% — they were all
    hitting the same hardcoded fallback regardless of how obvious they were."""
    import math
    try:
        n = len(poly)
        p1, p2 = poly[vi], poly[(vi + 1) % n]
        dx, dy = p2[0] - p1[0], p2[1] - p1[1]
        ang = abs(math.degrees(math.atan2(abs(dy), abs(dx))))  # 0=horizontal, 90=vertical
        mids = [((poly[k][1] + poly[(k + 1) % n][1]) / 2) for k in range(n)]
        is_lowest = ((p1[1] + p2[1]) / 2) >= (max(mids) - 1e-6)
        if edge_type == "eave":
            if ang <= 8 and is_lowest:
                return 0.74, "Clearly horizontal lowest edge → eave"
            if ang <= 8:
                return 0.60, "Horizontal edge → likely eave"
            if ang <= 18:
                return 0.50, "Near-horizontal → possibly eave"
            return 0.45, "Orientation ambiguous — please confirm"
        if edge_type == "rake":
            if ang >= 28:
                return 0.68, "Clearly sloped side edge → rake"
            if ang >= 15:
                return 0.55, "Sloped edge → likely rake"
            return 0.45, "Orientation ambiguous — please confirm"
    except Exception:
        pass
    return 0.45, "Geometric heuristic — please confirm"


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
    db = get_supabase()
    run = db.table("roof_measurement_runs").select(
        "satellite_image_url, satellite_lat, satellite_lng, satellite_zoom"
    ).eq("id", run_id).single().execute()
    run_data = run.data or {}
    img_url = run_data.get("satellite_image_url")

    # Deterministic geometry suggestion (shared edges → ridge/hip/valley via overlap
    # + concavity; perimeter → eave/rake), refined by the vision passes below. NOTE:
    # the Google-Solar "slope direction" path was removed — its facet↔segment matching
    # was unreliable (coarse overlapping bboxes) and mislabeled edges. Pure geometry +
    # vision is the proven, reliable labeler, so we feed the raw facets straight in.
    geom_suggestions = geo.auto_suggest_edge_types(req.facets)
    geom_index: dict[tuple[str, int], dict] = {}
    for s in geom_suggestions:
        geom_index[(s.get("facet_label"), s.get("vertex_index_start"))] = s

    def _edge_manifest(edge_list: list) -> list[str]:
        lines: list[str] = []
        for e in edge_list:
            fl = e.get("facet_label")
            i = e.get("vertex_index_start")
            facet = next((f for f in req.facets if f.get("label") == fl), None)
            if not facet:
                continue
            poly = facet.get("polygon") or []
            if i >= len(poly):
                continue
            p1, p2 = poly[i], poly[(i + 1) % len(poly)]
            lines.append(f"  - facet {fl} edge {i}: from ({p1[0]:.3f},{p1[1]:.3f}) to ({p2[0]:.3f},{p2[1]:.3f})")
        return lines

    vision_suggestions_by_edge: dict[tuple[str, int], dict] = {}
    rv_vision_by_edge: dict[tuple[str, int], dict] = {}   # shared-edge ridge↔valley disambiguation
    img_bytes = None
    mt = "image/png"
    if img_url and req.unlabeled_edges:
        import httpx
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                r = await client.get(img_url, follow_redirects=True)
                r.raise_for_status()
                img_bytes = r.content
                mt = (r.headers.get("content-type") or "image/png").split(";")[0].strip()
                if mt not in ("image/png", "image/jpeg", "image/webp"):
                    mt = "image/png"
        except Exception as e:
            logger.info("edge-label tile fetch failed: %s", e)
            img_bytes = None

    if img_bytes is not None:
        from app.services.llm import llm_vision

        # NOTE: perimeter edges (eave/rake/wall) are NOT sent to vision anymore.
        # The satellite-vision pass was unreliable there — it labeled interior edges
        # as "wall_intersection" (the center-of-roof-as-wall bug) and flipped
        # eave↔rake. The snapping/topology geometry is reliable for eave vs rake, and
        # genuine roof-to-wall edges are labeled via the ground-photo Roof-to-wall
        # panel. Vision is kept ONLY for the shared ridge/hip/valley tiebreak below.

        # ---- Pass 2: shared RIDGE vs VALLEY (the confusable pair) ----
        # Geometry can't see height, so a ridge and a valley look identical from a
        # 2D trace. The satellite CAN tell them apart, so let vision break the tie.
        rv_edges = []
        for e in req.unlabeled_edges:
            gi = geom_index.get((e.get("facet_label"), e.get("vertex_index_start")), {}) or {}
            # Only disambiguate shared edges geometry was UNSURE about — when slope
            # classified them from measured azimuth, that wins.
            if gi.get("edge_type") in ("ridge", "hip", "valley") and gi.get("method") != "slope":
                rv_edges.append(e)
        if rv_edges:
            try:
                prompt = (
                    "Top-down satellite roof image. For each traced edge below — each is a line where two "
                    "roof planes meet — tell me if it is a RIDGE, a HIP, or a VALLEY:\n"
                    "  - RIDGE: the horizontal PEAK at the top where two slopes rise to meet and shed water "
                    "AWAY on both sides. Bright/high line running along the top of the roof; planes get LOWER "
                    "leaving the edge.\n"
                    "  - HIP: a DIAGONAL peak running DOWN from the ridge to an outside corner of the roof. "
                    "Like a ridge (sheds water away, raised line) but slanted, going corner-to-peak — an "
                    "OUTWARD/convex fold.\n"
                    "  - VALLEY: the TROUGH where two slopes fall to meet and channel water INTO the line. "
                    "Darker, recessed line that often shows staining/debris; an INWARD/concave fold; planes "
                    "get HIGHER leaving the edge.\n\n"
                    "Edges (coordinates are image fractions, 0..1):\n"
                    + "\n".join(_edge_manifest(rv_edges))
                    + "\n\nReturn ONLY valid JSON:\n"
                    "{\n  \"labels\": [\n    {\"facet_label\": \"A\", \"vertex_index_start\": 0, \"edge_type\": \"valley\", \"confidence\": 0.7, \"reason\": \"dark recessed line, water channels in\"}\n  ]\n}\n"
                    "confidence < 0.5 if you truly cannot tell from the image."
                )
                parsed = _loads_tolerant(await llm_vision(img_bytes, mt, prompt, max_tokens=1000))
                if parsed is not None:
                    for v in parsed.get("labels") or []:
                        et = v.get("edge_type")
                        if et not in ("ridge", "hip", "valley"):
                            continue
                        key = (v.get("facet_label"), int(v.get("vertex_index_start") or -1))
                        rv_vision_by_edge[key] = {
                            "edge_type": et,
                            "confidence": geo.normalize_confidence(v.get("confidence")),
                            "reason": str(v.get("reason") or "")[:200],
                        }
            except Exception as e:
                logger.info("ridge/valley vision pass failed: %s", e)

    # Merge: shared edges from geometry, unshared from vision (else geometry fallback)
    out: list[dict] = []
    for e in req.unlabeled_edges:
        key = (e.get("facet_label"), int(e.get("vertex_index_start") or 0))
        geo_sug = geom_index.get(key, {})
        shared = geo_sug.get("shared_with_facet_label")
        if shared:
            etype = geo_sug.get("edge_type") or "ridge"
            if geo_sug.get("method") == "slope":
                # Classified from Google Solar's measured slope direction — trusted.
                conf = geo_sug.get("confidence") or 0.82
                reason = f"Shared with {shared}; {etype} from measured slope direction"
            else:
                conf = 0.85
                reason = f"Shared edge with facet {shared} (geometric)"
                # Vision arbitrates the ridge↔hip↔valley call, but CONSERVATIVELY:
                # geometry's VALLEY (a reentrant/concave fold) is a strong, reliable
                # signal, so vision must be near-certain to overturn it; ridge vs hip
                # is the genuinely ambiguous pair, so a lower bar applies there.
                rv = rv_vision_by_edge.get(key)
                rv_conf = (rv or {}).get("confidence") or 0
                threshold = 0.85 if etype == "valley" else 0.72
                if rv and rv.get("edge_type") in ("ridge", "hip", "valley") and rv_conf >= threshold:
                    etype = rv["edge_type"]
                    conf = max(0.7, rv_conf)
                    reason = f"Shared with {shared}; {etype} confirmed from satellite — {rv.get('reason', '')}".strip()
            out.append({
                "facet_label": key[0],
                "vertex_index_start": key[1],
                "suggested_edge_type": etype,
                "confidence": conf,
                "reason": reason,
                "shared_with_facet_label": shared,
                "ai_suggested": True,
            })
        else:
            # Perimeter edge → trust the snapping/topology geometry. It reliably
            # gives eave vs rake, so no satellite-vision override here (that was the
            # source of false "wall" labels on interior edges and eave↔rake flips).
            # Genuine roof-to-wall edges are labeled via the ground-photo panel.
            etype = geo_sug.get("edge_type") or "unlabeled"
            facet = next((f for f in req.facets if f.get("label") == key[0]), None)
            gc, greason = (
                _geom_edge_confidence(facet.get("polygon") or [], key[1], etype)
                if facet else (0.5, "Geometric heuristic — please confirm")
            )
            out.append({
                "facet_label": key[0],
                "vertex_index_start": key[1],
                "suggested_edge_type": etype,
                "confidence": gc,
                "reason": greason,
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


async def _fetch_run_tile(img_url: Optional[str], run_data: dict) -> tuple[Optional[bytes], str]:
    """Get the run's satellite tile bytes robustly: try the stored URL first (it
    can be a stale or expiring upscale/sharpen URL — the cause of the dreaded
    'could not be downloaded'), then REGENERATE fresh imagery from the run's
    lat/lng/zoom. Returns (bytes, media_type) or (None, '')."""
    import httpx as _httpx
    if img_url:
        try:
            async with _httpx.AsyncClient(timeout=20) as client:
                r = await client.get(img_url, follow_redirects=True)
                r.raise_for_status()
                mt = (r.headers.get("content-type") or "image/png").split(";")[0].strip()
                if mt not in ("image/png", "image/jpeg", "image/webp"):
                    mt = "image/png"
                return r.content, mt
        except Exception as e:
            logger.info("run tile URL download failed (%s) — regenerating from lat/lng", e)
    lat, lng = run_data.get("satellite_lat"), run_data.get("satellite_lng")
    zoom = run_data.get("satellite_zoom") or 20
    if lat is None or lng is None:
        return None, ""
    try:
        result = await imagery_service.fetch_satellite_image(float(lat), float(lng), zoom=int(zoom))
        return result.image_bytes, result.media_type
    except Exception as e:
        logger.warning("run tile regeneration failed: %s", e)
        return None, ""


@router.get("/runs/{run_id}/detect-wall-transitions")
async def detect_wall_transitions(run_id: str, user: dict = Depends(require_user)) -> dict:
    """
    AI roof-to-wall transition detection (Phase 2 of flashing intelligence).

    Gemini analyzes the top-down satellite tile and returns the line segments
    where the roof meets a vertical wall — the conditions that REQUIRE flashing:
      * Roof-to-wall runs (a slope dies into a taller wall — step/apron flashing)
      * Dormer sides (a dormer's cheek walls rise out of the main roof)

    Returns segments in image fractions with confidence + reasoning. The
    frontend matches each accepted segment to the nearest traced facet edge and
    re-labels it 'wall_intersection', which the flashing engine then consumes.
    Nothing here writes to the DB — every finding is a reviewable suggestion.
    """
    import json as _json
    import re as _re
    from app.services.llm import llm_vision

    db = get_supabase()
    run = db.table("roof_measurement_runs").select(
        "satellite_image_url, satellite_lat, satellite_lng, satellite_zoom"
    ).eq("id", run_id).single().execute()
    if not run.data:
        raise HTTPException(status_code=404, detail="Run not found.")

    img_bytes, mt = await _fetch_run_tile(run.data.get("satellite_image_url"), run.data)
    if img_bytes is None:
        return {
            "transitions": [],
            "reason": "Could not load the satellite tile (stored URL failed and no coordinates to regenerate from).",
            "message": "Image fetch failed — re-open the run's imagery, then try again.",
        }

    prompt = """You are a roofing estimator finding ROOF-TO-WALL TRANSITIONS in a top-down satellite image — the places that require flashing.

Look for these conditions and return the line where the roof meets the wall:
  1. ROOF-TO-WALL: a roof slope runs into a TALLER wall of the same building (e.g. a single-story section meeting a two-story wall, a porch roof meeting the main house). The transition is the line along the base of the taller wall.
  2. DORMER: a small roofed projection sticking out of the main roof. Its two side ("cheek") walls each create a roof-to-wall transition — return one segment per visible cheek wall.

DO NOT return: ridges, hips, valleys, eaves (gutter edges), rakes (gable edges), or the building's outer perimeter. Those are NOT roof-to-wall transitions.

For each transition return the segment endpoints as [x,y] fractions of the image (0..1, top-left origin), the kind, a confidence 0..1, and a short reason.

Return ONLY JSON. Include a top-level "reason" describing what you saw (especially if you found nothing):
{
  "reason": "Found a dormer on the south slope with two cheek walls.",
  "transitions": [
    {"p0": [0.42, 0.30], "p1": [0.42, 0.40], "kind": "dormer", "confidence": 0.7, "reason": "Left cheek wall of dormer"}
  ]
}
If there are none, return {"reason": "...", "transitions": []}. Do NOT invent transitions."""

    try:
        text = await llm_vision(img_bytes, mt, prompt, max_tokens=1500)
        parsed = _loads_tolerant(text)
        if parsed is None:
            return {"transitions": [], "reason": "Vision returned no usable JSON.", "message": "AI could not analyze the tile — re-detect, or label wall edges manually."}
    except Exception as e:
        return {"transitions": [], "reason": f"Vision error: {str(e)[:160]}", "message": "AI detection errored."}

    cleaned: list[dict] = []
    for t in parsed.get("transitions") or []:
        p0 = t.get("p0") or []
        p1 = t.get("p1") or []
        if not (isinstance(p0, (list, tuple)) and isinstance(p1, (list, tuple)) and len(p0) >= 2 and len(p1) >= 2):
            continue
        try:
            x0 = max(0.0, min(1.0, float(p0[0]))); y0 = max(0.0, min(1.0, float(p0[1])))
            x1 = max(0.0, min(1.0, float(p1[0]))); y1 = max(0.0, min(1.0, float(p1[1])))
        except (TypeError, ValueError):
            continue
        if abs(x0 - x1) < 1e-4 and abs(y0 - y1) < 1e-4:
            continue
        kind = t.get("kind") if t.get("kind") in ("wall", "dormer") else "wall"
        cleaned.append({
            "p0": [x0, y0], "p1": [x1, y1],
            "kind": kind,
            "confidence": geo.normalize_confidence(t.get("confidence")),
            "reason": str(t.get("reason") or "")[:200],
        })

    reason = str(parsed.get("reason") or "")[:400]
    if not cleaned:
        return {
            "transitions": [],
            "reason": reason or "No roof-to-wall transitions clearly visible.",
            "message": "No roof-to-wall transitions found. If the roof has dormers or abuts a taller wall, label those edges manually as 'wall_intersection'.",
        }
    return {
        "transitions": cleaned,
        "reason": reason,
        "message": (
            f"{len(cleaned)} roof-to-wall transition(s) detected. Accept them to label the "
            "matching roof edges as wall_intersection — flashing is recomputed automatically."
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


@router.get("/runs/{run_id}/flashing")
async def get_run_flashing(run_id: str, user: dict = Depends(require_user)) -> dict:
    """
    Flashing Intelligence — derives every flashing requirement deterministically
    from the run's confirmed facets, classified edges (wall_intersection,
    valley), and penetrations (chimney, skylight). No AI: each requirement
    traces back to a specific edge/penetration so the contractor can see exactly
    why it was added, then accept or adjust it.
    """
    from app.services.flashing_engine import build_input_from_rows, compute_flashing

    db = get_supabase()
    run = db.table("roof_measurement_runs").select("id, ground_findings").eq("id", run_id).single().execute()
    if not run.data:
        raise HTTPException(status_code=404, detail="Run not found.")

    facets = db.table("roof_facets").select("*").eq("run_id", run_id).execute().data or []
    facet_ids = [f["id"] for f in facets]
    edges: list[dict] = []
    if facet_ids:
        edges = db.table("roof_edges").select("*").in_("facet_id", facet_ids).execute().data or []
    pens = db.table("roof_penetrations").select("*").eq("run_id", run_id).execute().data or []

    inp = build_input_from_rows(facets, edges, pens)
    summary = compute_flashing(inp)
    payload = summary.to_dict()

    # Completeness cross-check against the GROUND PHOTOS: surface anything the
    # photos detected that hasn't been added/labeled yet, so flashing is never
    # silently short a chimney/skylight/wall/dormer the contractor photographed.
    gf = run.data.get("ground_findings") or {}
    gaps: list[dict] = []
    det_ch = int((gf.get("chimney") or {}).get("count") or 0) if (gf.get("chimney") or {}).get("present") else 0
    have_ch = sum(1 for p in pens if p.get("type") == "chimney")
    if det_ch > have_ch:
        gaps.append({"type": "chimney", "detected": det_ch, "present": have_ch,
                     "message": f"Ground photos show {det_ch} chimney(s); {have_ch} added. Add the rest so chimney flashing is counted."})
    det_sky = int(gf.get("skylights") or 0)
    have_sky = sum(1 for p in pens if p.get("type") == "skylight")
    if det_sky > have_sky:
        gaps.append({"type": "skylight", "detected": det_sky, "present": have_sky,
                     "message": f"Ground photos show {det_sky} skylight(s); {have_sky} added. Add the rest so skylight flashing is counted."})
    if (gf.get("wall_abutment") or {}).get("present") and len(inp.wall_edges) == 0:
        gaps.append({"type": "wall_intersection", "detected": 1, "present": 0,
                     "message": "Ground photos show a roof-to-wall abutment, but no edge is labeled 'wall intersection' yet — label it (roof-to-wall panel) so step/counter flashing is added."})
    det_dorm = int(gf.get("dormers") or 0)
    if det_dorm > 0 and len(inp.wall_edges) < det_dorm:
        gaps.append({"type": "dormer", "detected": det_dorm, "present": len(inp.wall_edges),
                     "message": f"Ground photos show {det_dorm} dormer(s) — each dormer's roof-to-wall (cheek) edges need labeling so its step flashing is counted."})
    payload["gaps"] = gaps

    n_conditions = len(inp.wall_edges) + len(inp.valley_edges) + len(inp.penetrations)
    if n_conditions == 0:
        payload["message"] = (
            "No flashing yet — flashing is built from what you mark on the roof, so add the "
            "conditions first: (1) upload a ground photo of any chimney/skylight and tap "
            "'Add' — that flows in automatically; (2) for a roof meeting a taller wall or a "
            "dormer, use the roof-to-wall panel above to label that edge as 'wall intersection'. "
            "Then this updates instantly."
        )
    else:
        payload["message"] = (
            f"{payload['count']} flashing requirement(s) derived from "
            f"{len(inp.wall_edges)} roof-to-wall run(s), {len(inp.valley_edges)} valley(s), "
            f"and {len(inp.penetrations)} penetration(s)."
        )
    if gaps:
        payload["message"] += (
            f" ⚠ {len(gaps)} condition(s) seen in your ground photos aren't reflected yet — "
            "see below so the flashing order isn't short."
        )
    return payload


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
    # Append priced flashing line items (quantities from the flashing engine).
    try:
        from app.services.flashing_engine import build_input_from_rows, compute_flashing
        from app.services.materials_engine import compute_flashing_material_lines
        facets_m = db.table("roof_facets").select("*").eq("run_id", run_id).execute().data or []
        edge_ids = [f["id"] for f in facets_m]
        edges_m = (db.table("roof_edges").select("*").in_("facet_id", edge_ids).execute().data or []) if edge_ids else []
        flashing_m = compute_flashing(build_input_from_rows(facets_m, edges_m, pen_rows)).to_dict()
        lines = lines + compute_flashing_material_lines(catalog, flashing_m, default_waste_pct=waste_pct)
    except Exception as e:
        logger.warning("flashing material lines failed for /materials: %s", e)

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

    # Flashing intelligence — derive step/counter/apron/kickout/valley/chimney/
    # skylight/cricket from the same facets/edges/penetrations and render it in
    # the report's Flashing section.
    try:
        from app.services.flashing_engine import build_input_from_rows, compute_flashing
        from app.services.materials_engine import compute_flashing_material_lines
        flashing_summary = compute_flashing(
            build_input_from_rows(facets_res.data or [], edges, pens_res.data or [])
        ).to_dict()
        # Append priced, orderable flashing line items to the material order.
        material_lines = material_lines + compute_flashing_material_lines(
            catalog, flashing_summary, default_waste_pct=default_waste,
        )
    except Exception as e:
        logger.warning("flashing computation for report failed: %s", e)
        flashing_summary = None

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
        flashing_summary,
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
        "standard_door_80", "garage_door_84", "garage_door_w_16", "window_36", "custom",
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
    elif payload.reference_object == "garage_door_w_16":
        ref_in = 192.0
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
