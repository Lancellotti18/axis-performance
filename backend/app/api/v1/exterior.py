"""
Axis Performance — Exterior Measurement Module API.

Endpoints support the Section 2 + Section 5 build plan:
    Photo upload, vision-based elevation classification + observations,
    coverage map, contractor measurement traces (walls, openings, corners,
    trim), photogrammetry scaffold (submit/poll), Hover-style report.

Every dimension stored or returned by this module comes from a contractor
trace with a known scale anchor. Vision-classification fields are clearly
labeled and never enter the materials/quantities pipeline.
"""
from __future__ import annotations

import asyncio
import logging
import math
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from app.core.auth import require_user
from app.core.supabase import get_supabase
from app.services import exterior_photo_service as photo_svc
from app.services import photogrammetry_service as photogram_svc

logger = logging.getLogger(__name__)
router = APIRouter()


# ----------------------------------------------------------------------------
# Jobs
# ----------------------------------------------------------------------------

class CreateExteriorJobRequest(BaseModel):
    project_id: str
    report_type: Literal["complete", "roof_only"] = "complete"
    notes: Optional[str] = None


@router.post("/jobs")
async def create_job(req: CreateExteriorJobRequest, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    payload = req.model_dump(exclude_none=True)
    payload["status"] = "collecting"
    res = db.table("exterior_jobs").insert(payload).execute()
    if not res.data:
        raise HTTPException(status_code=500, detail="Could not create exterior job.")
    return res.data[0]


@router.get("/jobs")
async def list_jobs(
    project_id: str = Query(...),
    user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    res = (
        db.table("exterior_jobs")
        .select("*")
        .eq("project_id", project_id)
        .order("created_at", desc=True)
        .execute()
    )
    return {"jobs": res.data or []}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    job_res = db.table("exterior_jobs").select("*").eq("id", job_id).single().execute()
    if not job_res.data:
        raise HTTPException(status_code=404, detail="Job not found.")
    photos_res = (
        db.table("exterior_photos")
        .select("*").eq("job_id", job_id).order("sort_index").execute()
    )
    meas_res = (
        db.table("exterior_measurements")
        .select("*").eq("job_id", job_id).order("created_at").execute()
    )
    photos = photos_res.data or []
    return {
        "job": job_res.data,
        "photos": photos,
        "measurements": meas_res.data or [],
        "coverage": photo_svc.coverage_map(photos),
        "photogrammetry_available": photogram_svc.is_enabled(),
    }


class UpdateJobRequest(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None
    cover_photo_id: Optional[str] = None
    scale_calibration_source: Optional[str] = None


@router.patch("/jobs/{job_id}")
async def update_job(
    job_id: str, req: UpdateJobRequest, user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    updates = req.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=422, detail="No updates supplied.")
    res = db.table("exterior_jobs").update(updates).eq("id", job_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Job not found.")
    return res.data[0]


# ----------------------------------------------------------------------------
# Photos
# ----------------------------------------------------------------------------

class RegisterPhotoRequest(BaseModel):
    job_id: str
    photo_url: str
    storage_path: Optional[str] = None
    original_filename: Optional[str] = None
    file_size_kb: Optional[int] = None
    width_px: Optional[int] = None
    height_px: Optional[int] = None
    exif_data: Optional[dict] = None
    gps_lat: Optional[float] = None
    gps_lng: Optional[float] = None


@router.post("/photos")
async def register_photo(
    req: RegisterPhotoRequest, user: dict = Depends(require_user),
) -> dict:
    """
    Called by the frontend AFTER it has uploaded the photo to Supabase Storage.
    Inserts a placeholder row, then kicks off Gemini classification + observations
    inline (~3 seconds). Returns the populated row.

    Phase 2 will move classification to a background queue so the upload UI
    isn't blocked on each photo.
    """
    db = get_supabase()
    # Determine next sort_index
    existing = (
        db.table("exterior_photos").select("sort_index").eq("job_id", req.job_id).execute()
    )
    next_idx = (max((p.get("sort_index") or 0) for p in (existing.data or [])) + 1) if existing.data else 0

    base_row = {
        "job_id": req.job_id,
        "photo_url": req.photo_url,
        "storage_path": req.storage_path,
        "original_filename": req.original_filename,
        "file_size_kb": req.file_size_kb,
        "width_px": req.width_px,
        "height_px": req.height_px,
        "exif_data": req.exif_data or {},
        "gps_lat": req.gps_lat,
        "gps_lng": req.gps_lng,
        "sort_index": next_idx,
    }

    # Run Gemini classification inline; safe even if it fails (returns 'unknown')
    classification = await photo_svc.classify_photo(req.photo_url)
    row = {**base_row, **classification}

    ins = db.table("exterior_photos").insert(row).execute()
    if not ins.data:
        raise HTTPException(status_code=500, detail="Failed to register photo.")

    # Bump job photo_count
    db.table("exterior_jobs").update(
        {"photo_count": (existing.data and len(existing.data) or 0) + 1}
    ).eq("id", req.job_id).execute()

    return ins.data[0]


class UpdatePhotoRequest(BaseModel):
    classified_elevation: Optional[Literal[
        "front", "right", "rear", "left",
        "front_right", "right_rear", "rear_left", "left_front",
        "aerial", "detail", "unknown",
    ]] = None
    classification_user_confirmed: Optional[bool] = None
    is_cover: Optional[bool] = None
    sort_index: Optional[int] = None


@router.patch("/photos/{photo_id}")
async def update_photo(
    photo_id: str, req: UpdatePhotoRequest, user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    updates = req.model_dump(exclude_none=True)
    if "classified_elevation" in updates:
        updates["classification_user_confirmed"] = True
    if updates.get("is_cover"):
        photo = db.table("exterior_photos").select("job_id").eq("id", photo_id).single().execute()
        if photo.data:
            db.table("exterior_photos").update({"is_cover": False}).eq("job_id", photo.data["job_id"]).execute()
            db.table("exterior_jobs").update({"cover_photo_id": photo_id}).eq("id", photo.data["job_id"]).execute()
    res = db.table("exterior_photos").update(updates).eq("id", photo_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Photo not found.")
    return res.data[0]


@router.delete("/photos/{photo_id}")
async def delete_photo(photo_id: str, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    db.table("exterior_photos").delete().eq("id", photo_id).execute()
    return {"status": "deleted"}


# ----------------------------------------------------------------------------
# Measurements
# ----------------------------------------------------------------------------

MEASUREMENT_TYPES = Literal[
    "wall", "window", "door", "trim",
    "corner_inside", "corner_outside", "roof_visible",
]


class CreateMeasurementRequest(BaseModel):
    job_id: str
    photo_id: Optional[str] = None
    measurement_type: MEASUREMENT_TYPES
    facade_id: Optional[str] = None
    elevation: Optional[Literal["front", "right", "rear", "left", "other"]] = None
    material_type: Optional[str] = None
    reference_object: Optional[Literal[
        "standard_door_80", "garage_door_84", "window_36", "custom", "photogrammetry",
    ]] = None
    reference_height_in: Optional[float] = None
    reference_pixel_h: Optional[float] = None
    region_polygon: Optional[list[list[float]]] = None
    width_in: Optional[float] = None
    height_in: Optional[float] = None
    snapped_to_standard: bool = False
    notes: Optional[str] = None

    @field_validator("region_polygon")
    @classmethod
    def _validate_polygon(cls, v):
        if v is None:
            return v
        if len(v) < 2:
            raise ValueError("region_polygon must have at least 2 points")
        return v


def _polygon_pixel_area(polygon: list[list[float]]) -> float:
    if not polygon or len(polygon) < 3:
        return 0.0
    s = 0.0
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i][0], polygon[i][1]
        x2, y2 = polygon[(i + 1) % n][0], polygon[(i + 1) % n][1]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def _polyline_pixel_length(polygon: list[list[float]]) -> float:
    if not polygon or len(polygon) < 2:
        return 0.0
    total = 0.0
    for i in range(len(polygon) - 1):
        dx = polygon[i + 1][0] - polygon[i][0]
        dy = polygon[i + 1][1] - polygon[i][1]
        total += math.sqrt(dx * dx + dy * dy)
    return total


def _derive_scale(req: CreateMeasurementRequest) -> float:
    """Return inches per pixel from the reference object + reference_pixel_h.
    Returns 0 if no scale anchor is provided."""
    ref_in = req.reference_height_in
    if req.reference_object == "standard_door_80":
        ref_in = 80.0
    elif req.reference_object == "garage_door_84":
        ref_in = 84.0
    elif req.reference_object == "window_36":
        ref_in = 36.0
    if not ref_in or not req.reference_pixel_h or req.reference_pixel_h <= 0:
        return 0.0
    return ref_in / req.reference_pixel_h


@router.post("/measurements")
async def create_measurement(
    req: CreateMeasurementRequest, user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    scale_in_per_px = _derive_scale(req)

    area_sqft = 0.0
    length_ft = 0.0
    united_inches = None

    if req.measurement_type in ("wall", "roof_visible") and req.region_polygon:
        pixel_area = _polygon_pixel_area(req.region_polygon)
        if scale_in_per_px > 0:
            area_sqft = round(pixel_area * (scale_in_per_px ** 2) / 144.0, 1)
    elif req.measurement_type in ("window", "door"):
        if req.width_in and req.height_in:
            area_sqft = round((req.width_in * req.height_in) / 144.0, 2)
            united_inches = round(req.width_in + req.height_in, 1)
        elif req.region_polygon and scale_in_per_px > 0:
            # Compute width/height from polygon bounding box if not supplied
            xs = [p[0] for p in req.region_polygon]
            ys = [p[1] for p in req.region_polygon]
            w_px = max(xs) - min(xs)
            h_px = max(ys) - min(ys)
            w_in = w_px * scale_in_per_px
            h_in = h_px * scale_in_per_px
            area_sqft = round((w_in * h_in) / 144.0, 2)
            united_inches = round(w_in + h_in, 1)
            req = req.model_copy(update={"width_in": round(w_in, 1), "height_in": round(h_in, 1)})
    elif req.measurement_type == "trim" and req.region_polygon:
        if scale_in_per_px > 0:
            length_ft = round(
                _polyline_pixel_length(req.region_polygon) * scale_in_per_px / 12.0, 2,
            )

    row = {
        "job_id": req.job_id,
        "photo_id": req.photo_id,
        "measurement_type": req.measurement_type,
        "facade_id": req.facade_id,
        "elevation": req.elevation,
        "material_type": req.material_type,
        "reference_object": req.reference_object,
        "reference_height_in": req.reference_height_in if req.reference_object == "custom" else (
            80.0 if req.reference_object == "standard_door_80" else
            84.0 if req.reference_object == "garage_door_84" else
            36.0 if req.reference_object == "window_36" else None
        ),
        "reference_pixel_h": req.reference_pixel_h,
        "scale_in_per_px": scale_in_per_px or None,
        "region_polygon": req.region_polygon,
        "area_sqft": area_sqft,
        "length_ft": length_ft,
        "width_in": req.width_in,
        "height_in": req.height_in,
        "united_inches": united_inches,
        "snapped_to_standard": req.snapped_to_standard,
        "notes": req.notes,
        "contractor_entered": True,
    }
    res = db.table("exterior_measurements").insert(row).execute()
    if not res.data:
        raise HTTPException(status_code=500, detail="Failed to create measurement.")

    # Bump job measurement count
    db.rpc("noop_no_op", {}).execute() if False else None
    cur = (
        db.table("exterior_measurements").select("id", count="exact").eq("job_id", req.job_id).execute()
    )
    db.table("exterior_jobs").update({"measurement_count": cur.count or 0}).eq("id", req.job_id).execute()
    return res.data[0]


@router.delete("/measurements/{measurement_id}")
async def delete_measurement(
    measurement_id: str, user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    db.table("exterior_measurements").delete().eq("id", measurement_id).execute()
    return {"status": "deleted"}


# ----------------------------------------------------------------------------
# Photogrammetry (Phase-2 scaffold)
# ----------------------------------------------------------------------------

@router.post("/jobs/{job_id}/photogrammetry/submit")
async def submit_photogrammetry(
    job_id: str, user: dict = Depends(require_user),
) -> dict:
    """
    Push the job's photos to the RunPod COLMAP/OpenSfM endpoint. Returns
    'disabled' if the RunPod endpoint isn't configured yet.
    """
    db = get_supabase()
    photos_res = (
        db.table("exterior_photos").select("photo_url").eq("job_id", job_id).execute()
    )
    urls = [p.get("photo_url") for p in (photos_res.data or []) if p.get("photo_url")]
    if len(urls) < 6:
        raise HTTPException(
            status_code=422,
            detail=f"Photogrammetry needs at least 6 photos; this job has {len(urls)}.",
        )
    result = await photogram_svc.submit_job(urls, job_metadata={"axis_job_id": job_id})
    if result.status == photogram_svc.PhotogrammetryStatus.DISABLED:
        return result.to_dict()

    db.table("exterior_jobs").update({
        "photogrammetry_job_id": result.job_id,
        "photogrammetry_provider": "runpod_colmap",
        "photogrammetry_started_at": "now()",
        "status": "photogrammetry" if result.status != photogram_svc.PhotogrammetryStatus.FAILED else "failed",
    }).eq("id", job_id).execute()
    return result.to_dict()


@router.get("/jobs/{job_id}/photogrammetry/status")
async def check_photogrammetry_status(
    job_id: str, user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    job = db.table("exterior_jobs").select("*").eq("id", job_id).single().execute()
    if not job.data:
        raise HTTPException(status_code=404, detail="Job not found.")
    pg_id = job.data.get("photogrammetry_job_id")
    if not pg_id:
        return {"status": "not_submitted"}
    result = await photogram_svc.check_status(pg_id)

    if result.status == photogram_svc.PhotogrammetryStatus.COMPLETED:
        db.table("exterior_jobs").update({
            "mesh_url": result.mesh_url,
            "point_cloud_url": result.point_cloud_url,
            "photogrammetry_ready_at": "now()",
            "status": "ready",
        }).eq("id", job_id).execute()
    elif result.status == photogram_svc.PhotogrammetryStatus.FAILED:
        db.table("exterior_jobs").update({
            "status": "failed",
            "warnings": [result.error or "photogrammetry failed"],
        }).eq("id", job_id).execute()
    return result.to_dict()


# ----------------------------------------------------------------------------
# Aggregates / report data
# ----------------------------------------------------------------------------

@router.get("/jobs/{job_id}/summary")
async def get_job_summary(
    job_id: str, user: dict = Depends(require_user),
) -> dict:
    """Aggregate data for the report viewer / PDF section."""
    db = get_supabase()
    job = db.table("exterior_jobs").select("*").eq("id", job_id).single().execute()
    if not job.data:
        raise HTTPException(status_code=404, detail="Job not found.")

    meas_res = (
        db.table("exterior_measurements").select("*").eq("job_id", job_id).execute()
    )
    rows = meas_res.data or []

    def _sum(type_: str, field: str) -> float:
        return round(sum(float(r.get(field) or 0) for r in rows if r.get("measurement_type") == type_), 1)

    walls_by_material: dict[str, float] = {}
    for r in rows:
        if r.get("measurement_type") != "wall":
            continue
        mat = (r.get("material_type") or "unknown").lower()
        walls_by_material[mat] = round(walls_by_material.get(mat, 0) + float(r.get("area_sqft") or 0), 1)

    walls_by_elevation: dict[str, float] = {}
    for r in rows:
        if r.get("measurement_type") != "wall":
            continue
        elev = (r.get("elevation") or "other").lower()
        walls_by_elevation[elev] = round(walls_by_elevation.get(elev, 0) + float(r.get("area_sqft") or 0), 1)

    openings = [r for r in rows if r.get("measurement_type") in ("window", "door")]
    windows = [r for r in openings if r.get("measurement_type") == "window"]
    doors = [r for r in openings if r.get("measurement_type") == "door"]

    return {
        "job": job.data,
        "walls": {
            "total_sqft": _sum("wall", "area_sqft"),
            "by_material": walls_by_material,
            "by_elevation": walls_by_elevation,
            "count": sum(1 for r in rows if r.get("measurement_type") == "wall"),
        },
        "openings": {
            "windows_count": len(windows),
            "doors_count": len(doors),
            "windows_total_sqft": round(sum(float(w.get("area_sqft") or 0) for w in windows), 1),
            "doors_total_sqft": round(sum(float(d.get("area_sqft") or 0) for d in doors), 1),
            "total_united_inches": round(sum(float(o.get("united_inches") or 0) for o in openings), 1),
        },
        "trim_lf": _sum("trim", "length_ft"),
        "corners": {
            "inside": sum(1 for r in rows if r.get("measurement_type") == "corner_inside"),
            "outside": sum(1 for r in rows if r.get("measurement_type") == "corner_outside"),
        },
    }


# ----------------------------------------------------------------------------
# Catalog helpers
# ----------------------------------------------------------------------------

STANDARD_WINDOW_SIZES_IN = [
    (24, 36), (24, 48), (24, 60),
    (30, 36), (30, 48), (30, 60),
    (36, 48), (36, 60), (36, 72),
    (48, 48), (48, 60), (48, 72),
    (60, 60), (60, 72),
    (72, 72),
]

STANDARD_DOOR_SIZES_IN = [
    (30, 80), (32, 80), (36, 80),
    (60, 80),       # double / french 60x80
    (72, 80),       # double 72x80
]


@router.get("/standards/windows")
async def get_window_standards(user: dict = Depends(require_user)) -> dict:
    return {"sizes": [{"width_in": w, "height_in": h} for w, h in STANDARD_WINDOW_SIZES_IN]}


@router.get("/standards/doors")
async def get_door_standards(user: dict = Depends(require_user)) -> dict:
    return {"sizes": [{"width_in": w, "height_in": h} for w, h in STANDARD_DOOR_SIZES_IN]}
