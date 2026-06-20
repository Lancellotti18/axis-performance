"""
APIR report data fetcher — DB rows → ExtractionInput.

Pulls every row the extraction orchestrator needs:
  * roof_measurement_runs (the run row + scale provenance + waste %)
  * roof_facets (contractor-drawn polygons)
  * roof_edges (per-facet edge types + lengths)
  * roof_penetrations (chimneys / vents / skylights → Features)
  * exterior_photos (front/right/left/back elevation URLs, eaves)
  * exterior_measurements (windows/doors/walls)
  * contractor_profiles (cover-page branding — pre-existing table)
  * projects (property_address + city/state/zip)

Returns an ExtractionInput ready for build_property_measurements().

DB calls assume the existing app.core.supabase.get_supabase() service-role
client. RLS is bypassed under service role; the API layer is responsible
for verifying the caller owns the project before calling this.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

import httpx

from app.schemas.apir import PointPx
from app.services.report.extraction import ExtractionInput

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────
# Public entry point
# ─────────────────────────────────────────────────────────────────────────

async def fetch_extraction_input(
    *,
    db: Any,
    project_id: str,
    run_id: Optional[str] = None,
    report_type: str = "full_exterior",
    download_photo_bytes: bool = True,
) -> ExtractionInput:
    """
    Pulls every DB row needed to build a PropertyMeasurements + downloads
    photo bytes for any vision calls. Returns an ExtractionInput.

    Raises RuntimeError with APIR error codes on missing required data
    (MISSING_REQUIRED_DATA, NO_ROOF_OUTLINES). The caller maps these to
    HTTPException at the router layer.
    """
    # 1. Resolve the run row -------------------------------------------------
    run_row = _fetch_run_row(db, project_id, run_id)
    if not run_row:
        raise RuntimeError(
            "MISSING_REQUIRED_DATA: no roof_measurement_runs found for this "
            "project. Complete the roof measurement workflow first."
        )
    resolved_run_id = run_row["id"]

    # 2. Facets + edges + penetrations -----------------------------------
    facets_rows = _fetch_facets(db, resolved_run_id)
    if not facets_rows:
        raise RuntimeError(
            "NO_ROOF_OUTLINES: no RF-X polygons drawn on this run. Draw "
            "at least one roof facet before generating a report."
        )
    edges_rows = _fetch_edges(db, [f["id"] for f in facets_rows])
    penetrations_rows = _fetch_penetrations(db, resolved_run_id)

    # 3. Project metadata (address) --------------------------------------
    project_row = _fetch_project(db, project_id)
    job_row = _merge_job_metadata(run_row, project_row)

    # 4. Contractor profile (existing contractor_profiles table) ---------
    contractor_row = _fetch_contractor_profile(db, project_row.get("user_id"))

    # 5. Photos: download bytes for vision calls -------------------------
    exterior_photo_rows = _fetch_exterior_photos(db, project_id)
    elevation_bytes: dict[str, tuple[bytes, str]] = {}
    eave_bytes: list[tuple[bytes, str]] = []
    overhead_bytes: Optional[tuple[bytes, str]] = None

    if download_photo_bytes and exterior_photo_rows:
        downloaded = await _download_photos(exterior_photo_rows)
        for photo, payload in downloaded:
            if payload is None:
                continue
            elev = photo.get("classified_elevation", "unknown")
            if elev in ("front", "right", "left", "back") and elev not in elevation_bytes:
                # APIR convention uses "back" not "rear"; coerce if needed.
                elevation_bytes[elev] = payload
            elif elev == "rear" and "back" not in elevation_bytes:
                elevation_bytes["back"] = payload
            elif elev == "aerial" and overhead_bytes is None:
                overhead_bytes = payload
            elif elev == "detail":
                eave_bytes.append(payload)

    # 6. Facet polygons + footprint as PointPx ---------------------------
    facet_polygons = _facet_rows_to_polygons(facets_rows)
    footprint_polygon = _extract_footprint(run_row, facets_rows)

    # 7. Penetration counts (Features) -----------------------------------
    penetration_counts: dict[str, int] = {}
    for row in penetrations_rows:
        t = row.get("type", "other")
        n = int(row.get("count", 1) or 1)
        penetration_counts[t] = penetration_counts.get(t, 0) + n

    # 8. Flashing intelligence — derive from the same confirmed rows so the
    #    APIR report's flashing matches the editor + roof-v2 PDF.
    flashing: Optional[dict] = None
    try:
        from app.services.flashing_engine import build_input_from_rows, compute_flashing
        flashing = compute_flashing(
            build_input_from_rows(facets_rows, edges_rows, penetrations_rows)
        ).to_dict()
    except Exception as e:
        logger.warning("flashing computation for APIR failed: %s", e)

    # 9. Build ExtractionInput -------------------------------------------
    roof_waste_pct = int(
        run_row.get("waste_pct_default") or 12
    )
    siding_waste_pct = int(run_row.get("siding_waste_pct") or 10)

    return ExtractionInput(
        job_row=job_row,
        contractor_row=contractor_row,
        facet_polygons=facet_polygons,
        footprint_polygon=footprint_polygon,
        feature_polygons={},  # APIR's BR-X/UN-X not yet drawn in UI
        penetration_counts=penetration_counts,
        elevation_photo_bytes=elevation_bytes,
        eave_photo_bytes=eave_bytes,
        overhead_photo_bytes=overhead_bytes,
        roof_waste_pct=roof_waste_pct,
        siding_waste_pct=siding_waste_pct,
        report_type=report_type,  # type: ignore[arg-type]
        flashing=flashing,
    )


# ─────────────────────────────────────────────────────────────────────────
# DB row helpers
# ─────────────────────────────────────────────────────────────────────────

def _fetch_run_row(db: Any, project_id: str, run_id: Optional[str]) -> Optional[dict]:
    table = db.table("roof_measurement_runs")
    if run_id:
        res = table.select("*").eq("id", run_id).limit(1).execute()
    else:
        res = (
            table.select("*")
            .eq("project_id", project_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
    rows = getattr(res, "data", None) or []
    return rows[0] if rows else None


def _fetch_facets(db: Any, run_id: str) -> list[dict]:
    res = db.table("roof_facets").select("*").eq("run_id", run_id).execute()
    return getattr(res, "data", None) or []


def _fetch_edges(db: Any, facet_ids: list[str]) -> list[dict]:
    if not facet_ids:
        return []
    res = db.table("roof_edges").select("*").in_("facet_id", facet_ids).execute()
    return getattr(res, "data", None) or []


def _fetch_penetrations(db: Any, run_id: str) -> list[dict]:
    res = db.table("roof_penetrations").select("*").eq("run_id", run_id).execute()
    return getattr(res, "data", None) or []


def _fetch_project(db: Any, project_id: str) -> dict:
    res = db.table("projects").select("*").eq("id", project_id).limit(1).execute()
    rows = getattr(res, "data", None) or []
    return rows[0] if rows else {}


def _fetch_contractor_profile(db: Any, user_id: Optional[str]) -> Optional[dict]:
    """Map contractor_profiles (existing table) → ContractorInfo shape."""
    if not user_id:
        return None
    res = (
        db.table("contractor_profiles")
        .select("*")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    rows = getattr(res, "data", None) or []
    if not rows:
        return None
    cp = rows[0]
    # Coalesce city/state/zip into the city_state_zip field that
    # ContractorInfo expects on the cover page.
    city = cp.get("city") or ""
    state = cp.get("state") or ""
    zip_code = cp.get("zip_code") or ""
    csz_parts = [p for p in [city, state, zip_code] if p]
    csz = ", ".join([p for p in [", ".join([city, state]).strip(", "), zip_code] if p])
    return {
        "company_name": cp.get("company_name") or "",
        "contact_name": "",       # not in legacy table
        "address": cp.get("address") or "",
        "city_state_zip": csz,
        "phone": cp.get("phone") or "",
        "email": cp.get("email") or "",
        "logo_url": "",            # not in legacy table
        "license_number": cp.get("license_number") or None,
        "website": None,            # not in legacy table
    }


def _fetch_exterior_photos(db: Any, project_id: str) -> list[dict]:
    """Pull all exterior_photos rows for the project's exterior_jobs."""
    jobs_res = (
        db.table("exterior_jobs").select("id").eq("project_id", project_id).execute()
    )
    job_ids = [r["id"] for r in (getattr(jobs_res, "data", None) or [])]
    if not job_ids:
        return []
    res = (
        db.table("exterior_photos").select("*").in_("job_id", job_ids).execute()
    )
    return getattr(res, "data", None) or []


# ─────────────────────────────────────────────────────────────────────────
# Polygon helpers
# ─────────────────────────────────────────────────────────────────────────

def _facet_rows_to_polygons(rows: list[dict]) -> dict[str, list[PointPx]]:
    """
    roof_facets.polygon is JSONB stored as [[x,y], [x,y], ...]. Convert to
    {facet_label: [PointPx(...)]}.
    """
    out: dict[str, list[PointPx]] = {}
    for i, row in enumerate(rows, start=1):
        label = row.get("facet_label") or f"RF-{i}"
        poly = row.get("polygon") or []
        if not isinstance(poly, list):
            continue
        pts = []
        for p in poly:
            try:
                if isinstance(p, dict):
                    pts.append(PointPx(x=float(p["x"]), y=float(p["y"])))
                else:
                    pts.append(PointPx(x=float(p[0]), y=float(p[1])))
            except (KeyError, ValueError, TypeError, IndexError):
                continue
        if len(pts) >= 3:
            out[label] = pts
    return out


def _extract_footprint(
    run_row: dict, facet_rows: list[dict],
) -> Optional[list[PointPx]]:
    """
    If the run has a stored footprint polygon, use it. Otherwise derive
    a bounding hull from all facet polygons (the convex outline).
    """
    # APIR doesn't yet store a separate footprint polygon — derive it
    # from the union extent of all facet polygons. For Phase 1 we use
    # the axis-aligned bounding box; the contractor UI will eventually
    # let the user draw a real footprint outline.
    all_pts: list[PointPx] = []
    for row in facet_rows:
        poly = row.get("polygon") or []
        for p in poly:
            try:
                if isinstance(p, dict):
                    all_pts.append(PointPx(x=float(p["x"]), y=float(p["y"])))
                else:
                    all_pts.append(PointPx(x=float(p[0]), y=float(p[1])))
            except Exception:
                continue
    if len(all_pts) < 3:
        return None
    xs = [p.x for p in all_pts]
    ys = [p.y for p in all_pts]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    return [
        PointPx(x=min_x, y=min_y),
        PointPx(x=max_x, y=min_y),
        PointPx(x=max_x, y=max_y),
        PointPx(x=min_x, y=max_y),
    ]


def _merge_job_metadata(run_row: dict, project_row: dict) -> dict:
    """Build the dict shape JobMetadata expects, pulling address from projects."""
    return {
        "id": run_row.get("id"),
        "property_address": project_row.get("address") or project_row.get("property_address") or "",
        "property_city": project_row.get("city") or "",
        "property_state": project_row.get("state") or "",
        "property_zip": project_row.get("zip_code") or "",
        "satellite_image_url": run_row.get("satellite_image_url"),
        "satellite_zoom": run_row.get("satellite_zoom"),
        "satellite_lat": run_row.get("satellite_lat"),
        "satellite_lng": run_row.get("satellite_lng"),
        "stories": run_row.get("stories") or 1,
        "report_version": run_row.get("report_version", 1),
    }


# ─────────────────────────────────────────────────────────────────────────
# Photo downloader
# ─────────────────────────────────────────────────────────────────────────

async def _download_photos(
    photos: list[dict],
) -> list[tuple[dict, Optional[tuple[bytes, str]]]]:
    """
    Download photo bytes in parallel. Photos that fail return None for
    their payload — vision calls then fall back to their per-call default.
    Cap to one photo per elevation type to keep total bytes bounded.
    """
    seen_elevations: set[str] = set()
    targets: list[dict] = []
    for photo in photos:
        elev = photo.get("classified_elevation", "unknown")
        if elev in seen_elevations:
            continue
        seen_elevations.add(elev)
        if photo.get("photo_url"):
            targets.append(photo)

    async def _one(photo: dict) -> tuple[dict, Optional[tuple[bytes, str]]]:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                r = await client.get(photo["photo_url"], follow_redirects=True)
                r.raise_for_status()
                content_type = (
                    r.headers.get("content-type", "image/jpeg").split(";")[0].strip()
                )
                if not content_type.startswith("image/"):
                    content_type = "image/jpeg"
                return photo, (r.content, content_type)
        except Exception as e:
            logger.warning("photo download failed (%s): %s", photo.get("id"), e)
            return photo, None

    return list(await asyncio.gather(*[_one(p) for p in targets]))
