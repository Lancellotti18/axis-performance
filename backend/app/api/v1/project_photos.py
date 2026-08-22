"""Project photos — a crew-facing gallery per project.

Photos are organized by job phase (before / progress / damage / completed), each
with a caption and non-destructive markup (arrows/circles/text pins stored as
fractional coords). A single tokenized link per project lets the crew view the
album + markup on their phone with no login (the unguessable token is the auth,
same pattern as client_portals). App-layer ownership via the service-role key.

Storage: bytes live in the existing 'blueprints' bucket under
project-photos/{project_id}/{photo_id}.jpg — no new bucket to provision.
"""
from __future__ import annotations

import logging
import secrets
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.core.auth import require_user
from app.core.supabase import get_supabase

logger = logging.getLogger(__name__)
router = APIRouter()

BUCKET = "blueprints"
PHASES = ("before", "progress", "damage", "completed")
_URL_TTL = 60 * 60 * 24 * 30  # 30 days — a job spans weeks; crew reloads refresh it


def _own_project(db, project_id: str, user_id: str) -> dict:
    res = db.table("projects").select("id, name, user_id").eq("id", project_id).limit(1).execute()
    row = (res.data or [None])[0]
    if not row:
        raise HTTPException(status_code=404, detail="Project not found.")
    if row.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Not your project.")
    return row


def _signed(db, path: str) -> Optional[str]:
    try:
        s = db.storage.from_(BUCKET).create_signed_url(path, _URL_TTL)
        return (s.get("signedURL") or s.get("signedUrl") or s.get("signed_url") or s.get("url")) if isinstance(s, dict) else None
    except Exception:
        logger.debug("signed url failed for %s", path, exc_info=True)
        return None


def _signed_many(db, paths: list[str]) -> dict[str, str]:
    """Sign many storage paths in ONE round trip.

    Signing per photo meant a gallery of 30 shots made 30 sequential calls to
    storage. On a cold free-tier backend that reads as "my photos aren't there" —
    the request is still in flight, or has already timed out. Falls back to
    signing individually if the batch call isn't available.
    """
    if not paths:
        return {}
    try:
        rows = db.storage.from_(BUCKET).create_signed_urls(paths, _URL_TTL)
        out: dict[str, str] = {}
        for row in (rows or []):
            if not isinstance(row, dict) or row.get("error"):
                continue
            url = row.get("signedURL") or row.get("signedUrl") or row.get("signed_url")
            path = (row.get("path") or "").lstrip("/")
            if not url or not path:
                continue
            for p in paths:
                if path == p or path.endswith(p):
                    out[p] = url
                    break
        if out:
            return out
    except Exception:
        logger.debug("batch signing unavailable — falling back", exc_info=True)
    return {p: u for p in paths if (u := _signed(db, p))}


def _photo_out(db, row: dict, urls: Optional[dict] = None) -> dict:
    path = row["storage_path"]
    return {
        "id": row["id"],
        "phase": row.get("phase") or "before",
        "caption": row.get("caption"),
        "annotations": row.get("annotations") or [],
        "sort_order": row.get("sort_order") or 0,
        "created_at": row.get("created_at"),
        "url": urls.get(path) if urls is not None else _signed(db, path),
    }


# ── Owner endpoints ──────────────────────────────────────────────────────────

@router.post("/projects/{project_id}")
async def upload_photo(
    project_id: str,
    file: UploadFile = File(...),
    phase: str = Form("before"),
    caption: str = Form(""),
    user: dict = Depends(require_user),
) -> dict:
    db = get_supabase()
    _own_project(db, project_id, user["id"])
    if phase not in PHASES:
        phase = "before"
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Photo is over 25 MB — please compress it.")

    photo_id = str(uuid.uuid4())
    ext = "png" if (file.content_type or "").endswith("png") else "jpg"
    path = f"project-photos/{project_id}/{photo_id}.{ext}"
    try:
        db.storage.from_(BUCKET).upload(
            path, raw, {"content-type": file.content_type or "image/jpeg", "upsert": "true"})
    except Exception as e:
        logger.warning("photo upload to storage failed: %s", e)
        raise HTTPException(status_code=502, detail="Could not store the photo — try again.")

    try:
        ins = db.table("project_photos").insert({
            "project_id": project_id, "user_id": user["id"], "phase": phase,
            "storage_path": path, "caption": (caption or None),
        }).execute()
    except Exception as e:
        # This used to escape as a bare 500. It was a schema mismatch — the
        # table pre-existed under an older shape, so `create table if not
        # exists` skipped the real definition and every column written here was
        # missing. Name the cause; "Internal server error" is undiagnosable.
        msg = str(e)
        logger.exception("photo insert failed for project %s", project_id)
        if "does not exist" in msg or "42703" in msg:
            raise HTTPException(status_code=500, detail=(
                "The photo table is missing columns this app writes — run the "
                "migration 20260822_project_photos_repair.sql, then try again."))
        raise HTTPException(status_code=500, detail=f"Could not save the photo record: {msg[:140]}")

    row = (ins.data or [None])[0]
    if not row:
        raise HTTPException(status_code=500, detail="Could not save the photo record.")
    return _photo_out(db, row)


@router.get("/projects/{project_id}")
async def list_photos(project_id: str, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    _own_project(db, project_id, user["id"])
    res = (db.table("project_photos").select("*").eq("project_id", project_id)
           .order("phase").order("sort_order").order("created_at").execute())
    rows = res.data or []
    urls = _signed_many(db, [r["storage_path"] for r in rows])
    photos = [_photo_out(db, r, urls) for r in rows]
    return {"photos": photos, "phases": list(PHASES)}


@router.get("/counts")
async def photo_counts(user: dict = Depends(require_user)) -> dict:
    """How many photos each of the caller's projects has, plus one cover shot.

    Photos existed only inside a project's own page, so there was no way to tell
    from anywhere else in the app that a job had any — which is what "uploaded
    photos don't appear anywhere" actually described. This lets the project lists
    show a count and a thumbnail without N requests.

    One query and one signing call regardless of how many projects there are.
    """
    db = get_supabase()
    rows = (db.table("project_photos")
            .select("project_id, storage_path, created_at")
            .eq("user_id", user["id"])
            .order("created_at", desc=True).execute().data or [])

    counts: dict[str, int] = {}
    cover_path: dict[str, str] = {}
    for r in rows:
        pid = r.get("project_id")
        if not pid:
            continue
        counts[pid] = counts.get(pid, 0) + 1
        # Rows arrive newest-first, so the last one seen per project is its oldest
        # — but the newest photo is the better cover, so keep the first.
        cover_path.setdefault(pid, r["storage_path"])

    urls = _signed_many(db, list(cover_path.values()))
    return {
        "counts": counts,
        "covers": {pid: urls.get(path) for pid, path in cover_path.items() if urls.get(path)},
    }


class PhotoPatch(BaseModel):
    caption: Optional[str] = None
    phase: Optional[str] = None
    annotations: Optional[list] = None
    sort_order: Optional[int] = None


@router.patch("/{photo_id}")
async def update_photo(photo_id: str, patch: PhotoPatch, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    res = db.table("project_photos").select("*").eq("id", photo_id).limit(1).execute()
    row = (res.data or [None])[0]
    if not row:
        raise HTTPException(status_code=404, detail="Photo not found.")
    if row.get("user_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Not your photo.")
    updates: dict = {}
    if patch.caption is not None:
        updates["caption"] = patch.caption or None
    if patch.phase is not None and patch.phase in PHASES:
        updates["phase"] = patch.phase
    if patch.annotations is not None:
        updates["annotations"] = patch.annotations
    if patch.sort_order is not None:
        updates["sort_order"] = patch.sort_order
    if updates:
        db.table("project_photos").update(updates).eq("id", photo_id).execute()
    merged = {**row, **updates}
    return _photo_out(db, merged)


@router.delete("/{photo_id}")
async def delete_photo(photo_id: str, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    res = db.table("project_photos").select("id, user_id, storage_path").eq("id", photo_id).limit(1).execute()
    row = (res.data or [None])[0]
    if not row:
        raise HTTPException(status_code=404, detail="Photo not found.")
    if row.get("user_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Not your photo.")
    try:
        db.storage.from_(BUCKET).remove([row["storage_path"]])
    except Exception:
        logger.debug("storage remove failed (row still deleted)", exc_info=True)
    db.table("project_photos").delete().eq("id", photo_id).execute()
    return {"deleted": True}


# ── Crew share link ──────────────────────────────────────────────────────────

class ShareToggle(BaseModel):
    enabled: bool = True


@router.get("/projects/{project_id}/share")
async def get_share(project_id: str, user: dict = Depends(require_user)) -> dict:
    """Get (creating if needed) the project's crew share token."""
    db = get_supabase()
    _own_project(db, project_id, user["id"])
    res = db.table("project_photo_shares").select("*").eq("project_id", project_id).limit(1).execute()
    row = (res.data or [None])[0]
    if not row:
        token = secrets.token_urlsafe(16)
        ins = db.table("project_photo_shares").insert({
            "project_id": project_id, "user_id": user["id"], "token": token, "enabled": True,
        }).execute()
        row = (ins.data or [{"token": token, "enabled": True}])[0]
    return {"token": row["token"], "enabled": row.get("enabled", True)}


@router.post("/projects/{project_id}/share")
async def toggle_share(project_id: str, body: ShareToggle, user: dict = Depends(require_user)) -> dict:
    db = get_supabase()
    _own_project(db, project_id, user["id"])
    existing = db.table("project_photo_shares").select("token").eq("project_id", project_id).limit(1).execute()
    if existing.data:
        db.table("project_photo_shares").update({"enabled": body.enabled}).eq("project_id", project_id).execute()
        token = existing.data[0]["token"]
    else:
        token = secrets.token_urlsafe(16)
        db.table("project_photo_shares").insert({
            "project_id": project_id, "user_id": user["id"], "token": token, "enabled": body.enabled,
        }).execute()
    return {"token": token, "enabled": body.enabled}


@router.get("/public/{token}")
async def public_gallery(token: str) -> dict:
    """Read-only crew view — no login. The token is the auth."""
    if not token or len(token) > 64:
        raise HTTPException(status_code=404, detail="Not found.")
    db = get_supabase()
    share = db.table("project_photo_shares").select("project_id, enabled").eq("token", token).limit(1).execute()
    srow = (share.data or [None])[0]
    if not srow or not srow.get("enabled"):
        raise HTTPException(status_code=404, detail="This link is off or doesn't exist.")
    project_id = srow["project_id"]
    proj = db.table("projects").select("name, address, city").eq("id", project_id).limit(1).execute()
    prow = (proj.data or [{}])[0]
    res = (db.table("project_photos").select("*").eq("project_id", project_id)
           .order("phase").order("sort_order").order("created_at").execute())
    rows = res.data or []
    # The public crew/customer gallery is the most latency-sensitive of the lot —
    # it's opened on a phone, on site. One signing call, not one per photo.
    urls = _signed_many(db, [r["storage_path"] for r in rows])
    photos = [_photo_out(db, r, urls) for r in rows]
    return {
        "project": {"name": prow.get("name"), "address": prow.get("address"), "city": prow.get("city")},
        "photos": photos, "phases": list(PHASES),
    }
