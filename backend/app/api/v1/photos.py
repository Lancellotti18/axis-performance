"""
Project photo documentation endpoints.
Provides presigned upload URLs for Supabase storage + photo metadata CRUD.
"""
import logging
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.auth import get_current_user
from app.core.supabase import get_supabase

logger = logging.getLogger(__name__)

router = APIRouter()

BUCKET = "project-photos"

# Columns that the post-migration project_photos table may have. We insert
# opportunistically — if the DB hasn't been migrated yet, we retry with just
# the baseline set so registration never breaks.
_BASE_COLS = {"project_id", "storage_key", "filename", "phase", "url"}
_METADATA_COLS = {"captured_at", "latitude", "longitude", "notes", "tags",
                  "auto_tags", "ai_tagged_at"}


class PhotoRegister(BaseModel):
    storage_key: str
    filename: str
    phase: str  # 'before' | 'during' | 'after'
    captured_at: Optional[str] = None     # ISO-8601 from client
    latitude: Optional[float] = Field(default=None, ge=-90, le=90)
    longitude: Optional[float] = Field(default=None, ge=-180, le=180)
    notes: Optional[str] = None
    tags: Optional[list[str]] = None


class PhotoPatch(BaseModel):
    notes: Optional[str] = None
    tags: Optional[list[str]] = None
    phase: Optional[str] = None


def _insert_with_fallback(db, payload: dict) -> dict:
    """Try the full insert; if the DB is missing one of the metadata columns,
    retry with only the baseline columns so the pre-migration deploy still works."""
    try:
        result = db.table("project_photos").insert(payload).execute()
        return result.data[0] if result.data else {}
    except Exception as e:
        msg = str(e).lower()
        if any(col in msg for col in _METADATA_COLS) or "column" in msg:
            logger.warning(
                "photos.register: DB rejected metadata columns — falling back to base insert. "
                "Run migration supabase/migrations/20260417_photo_metadata.sql. Error: %s", e,
            )
            trimmed = {k: v for k, v in payload.items() if k in _BASE_COLS}
            result = db.table("project_photos").insert(trimmed).execute()
            return result.data[0] if result.data else {}
        raise


@router.get("/upload-url/{project_id}")
async def get_photo_upload_url(
    project_id: str,
    filename: str,
    content_type: str = "image/jpeg",
    user: dict = Depends(get_current_user),
):
    db = get_supabase()
    safe = re.sub(r'[^\w.\-]', '_', filename)
    storage_key = f"projects/{project_id}/photos/{safe}"

    try:
        resp = db.storage.from_(BUCKET).create_signed_upload_url(storage_key)
        upload_url = resp.get("signedUrl") or resp.get("signed_url") or resp.get("signedURL", "")
        if not upload_url:
            raise RuntimeError(f"No signed URL in response: {resp}")
        raw_pub = db.storage.from_(BUCKET).get_public_url(storage_key)
        pub = raw_pub if isinstance(raw_pub, str) else (raw_pub.get("publicUrl") or raw_pub.get("data", {}).get("publicUrl", ""))
        return {"upload_url": upload_url, "key": storage_key, "public_url": pub}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create upload URL: {e}")


@router.post("/register/{project_id}")
async def register_photo(
    project_id: str,
    body: PhotoRegister,
    user: dict = Depends(get_current_user),
):
    db = get_supabase()
    try:
        raw_pub = db.storage.from_(BUCKET).get_public_url(body.storage_key)
        pub = raw_pub if isinstance(raw_pub, str) else (raw_pub.get("publicUrl") or raw_pub.get("data", {}).get("publicUrl", ""))
    except Exception:
        logger.debug("get_public_url failed", exc_info=True)
        pub = ""

    payload: dict = {
        "project_id": project_id,
        "storage_key": body.storage_key,
        "filename": body.filename,
        "phase": body.phase,
        "url": pub,
    }
    if body.captured_at:
        payload["captured_at"] = body.captured_at
    if body.latitude is not None:
        payload["latitude"] = body.latitude
    if body.longitude is not None:
        payload["longitude"] = body.longitude
    if body.notes:
        payload["notes"] = body.notes.strip()
    if body.tags:
        payload["tags"] = [t.strip() for t in body.tags if t and t.strip()]

    return _insert_with_fallback(db, payload)


@router.get("/{project_id}")
async def list_photos(
    project_id: str,
    user: dict = Depends(get_current_user),
):
    db = get_supabase()
    result = (
        db.table("project_photos")
        .select("*")
        .eq("project_id", project_id)
        .order("created_at")
        .execute()
    )
    return result.data or []


@router.patch("/{project_id}/{photo_id}")
async def update_photo_metadata(
    project_id: str,
    photo_id: str,
    body: PhotoPatch,
    user: dict = Depends(get_current_user),
):
    """Update notes, tags, or phase on an existing photo."""
    db = get_supabase()
    patch: dict = {}
    if body.notes is not None:
        patch["notes"] = body.notes.strip()
    if body.tags is not None:
        patch["tags"] = [t.strip() for t in body.tags if t and t.strip()]
    if body.phase is not None:
        if body.phase not in {"before", "during", "after"}:
            raise HTTPException(status_code=400, detail="Invalid phase")
        patch["phase"] = body.phase
    if not patch:
        raise HTTPException(status_code=400, detail="No fields to update")

    try:
        result = (
            db.table("project_photos")
            .update(patch)
            .eq("id", photo_id)
            .eq("project_id", project_id)
            .execute()
        )
    except Exception as e:
        msg = str(e).lower()
        if "notes" in msg or "tags" in msg or "column" in msg:
            raise HTTPException(
                status_code=503,
                detail="Photo metadata columns not migrated yet. Run supabase/migrations/20260417_photo_metadata.sql.",
            )
        raise HTTPException(status_code=500, detail=f"Update failed: {e}")

    if not result.data:
        raise HTTPException(status_code=404, detail="Photo not found")
    return result.data[0]


@router.post("/autotag/{project_id}/{photo_id}")
async def autotag_photo_endpoint(
    project_id: str,
    photo_id: str,
    user: dict = Depends(get_current_user),
):
    """Run vision auto-tagging on a single photo and persist the result."""
    from app.services.photo_autotag_service import autotag_photo as _autotag
    db = get_supabase()

    row = (
        db.table("project_photos")
        .select("id, url, project_id")
        .eq("id", photo_id)
        .eq("project_id", project_id)
        .limit(1)
        .execute()
    )
    if not row.data:
        raise HTTPException(status_code=404, detail="Photo not found")
    url = row.data[0].get("url")
    if not url:
        raise HTTPException(status_code=422, detail="Photo has no accessible URL")

    tags = _autotag(url)
    try:
        db.table("project_photos").update({
            "auto_tags": tags,
            "ai_tagged_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", photo_id).execute()
    except Exception as e:
        msg = str(e).lower()
        if "auto_tags" in msg or "ai_tagged_at" in msg or "column" in msg:
            logger.warning(
                "autotag: DB missing columns — returning tags without persisting. "
                "Run migration 20260417_photo_metadata.sql. %s", e,
            )
        else:
            raise HTTPException(status_code=500, detail=f"Persist failed: {e}")

    return {"photo_id": photo_id, "auto_tags": tags}


@router.post("/measure/{project_id}")
async def measure_from_photos_endpoint(
    project_id: str,
    user: dict = Depends(get_current_user),
):
    """
    Send all project photos to Claude Vision to extract structural measurements.
    Returns wall area, roof area, sqft, and dimensional estimates.
    """
    from app.services.photo_measurement_service import measure_from_photos as _measure
    db = get_supabase()

    result = (
        db.table("project_photos")
        .select("url, phase, filename")
        .eq("project_id", project_id)
        .order("created_at")
        .execute()
    )
    photos = result.data or []
    if not photos:
        raise HTTPException(status_code=422, detail="No photos uploaded for this project yet. Upload at least 3 photos to measure.")

    urls = [p["url"] for p in photos if p.get("url")]
    if len(urls) < 1:
        raise HTTPException(status_code=422, detail="Photos have no accessible URLs. Please re-upload.")

    try:
        measurements = await _measure(urls)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Measurement analysis failed: {e}")

    measurements["photo_count"] = len(urls)
    measurements["project_id"] = project_id
    return measurements


@router.delete("/{project_id}/{photo_id}")
async def delete_photo(
    project_id: str,
    photo_id: str,
    user: dict = Depends(get_current_user),
):
    db = get_supabase()
    row = db.table("project_photos").select("storage_key").eq("id", photo_id).limit(1).execute()
    if row.data:
        try:
            db.storage.from_(BUCKET).remove([row.data[0]["storage_key"]])
        except Exception:
            logger.debug("storage remove failed", exc_info=True)
            pass
    db.table("project_photos").delete().eq("id", photo_id).execute()
    return {"ok": True}
