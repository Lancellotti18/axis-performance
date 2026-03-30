"""
Project photo documentation endpoints.
Provides presigned upload URLs for Supabase storage + photo metadata CRUD.
"""
import re
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from app.core.auth import get_current_user
from app.core.supabase import get_supabase

router = APIRouter()

BUCKET = "project-photos"


class PhotoRegister(BaseModel):
    storage_key: str
    filename: str
    phase: str  # 'before' | 'during' | 'after'


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
        upload_url = resp.get("signedUrl") or resp.get("signed_url", "")
        # Also get the public URL for later display
        pub = db.storage.from_(BUCKET).get_public_url(storage_key)
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
        pub = db.storage.from_(BUCKET).get_public_url(body.storage_key)
    except Exception:
        pub = ""
    result = db.table("project_photos").insert({
        "project_id": project_id,
        "storage_key": body.storage_key,
        "filename": body.filename,
        "phase": body.phase,
        "url": pub,
    }).execute()
    return result.data[0] if result.data else {}


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
            pass
    db.table("project_photos").delete().eq("id", photo_id).execute()
    return {"ok": True}
