from fastapi import APIRouter, HTTPException, Query, Request, BackgroundTasks
from app.core.supabase import get_supabase
from app.core.config import settings
import logging
import uuid
import os

logger = logging.getLogger(__name__)

router = APIRouter()

# Local upload dir — shared between backend and worker via docker volume mount
UPLOAD_DIR = "/app/uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)


def get_s3_client():
    import boto3
    return boto3.client(
        "s3",
        region_name=settings.S3_REGION,
        aws_access_key_id=settings.AWS_ACCESS_KEY_ID or None,
        aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY or None,
        endpoint_url=settings.S3_ENDPOINT_URL or None,
    )


@router.get("/upload-url")
async def get_upload_url(
    request: Request,
    project_id: str = Query(...),
    filename: str = Query(...),
    content_type: str = Query(...),
):
    """Return a presigned URL for direct browser upload to S3/R2 or Supabase Storage."""
    # Sanitize filename — Supabase rejects keys with spaces or special chars
    import re
    safe_filename = re.sub(r'[^\w.\-]', '_', filename)
    key = f"blueprints/{project_id}/{uuid.uuid4()}/{safe_filename}"

    # Supabase Storage path (without the bucket name prefix)
    storage_path = f"{project_id}/{uuid.uuid4()}/{safe_filename}"

    if not settings.AWS_ACCESS_KEY_ID:
        # Use Supabase Storage
        db = get_supabase()
        try:
            result = db.storage.from_("blueprints").create_signed_upload_url(storage_path)
            signed_url = result.get("signedUrl") or result.get("signed_url") or result.get("signedURL")
            if not signed_url:
                raise RuntimeError(f"No signed URL in response: {result}")
            public_url = f"{settings.SUPABASE_URL}/storage/v1/object/public/blueprints/{storage_path}"
            return {
                "upload_url": signed_url,
                "key": public_url,
                "storage": "supabase",
            }
        except Exception as e:
            # Fallback to local dev upload
            base_url = str(request.base_url).rstrip("/")
            return {
                "upload_url": f"{base_url}/api/v1/blueprints/dev-upload/{key}",
                "key": key,
                "dev_mode": True,
            }

    s3 = get_s3_client()
    url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.S3_BUCKET_NAME,
            "Key": key,
            "ContentType": content_type,
        },
        ExpiresIn=3600,
    )
    return {"upload_url": url, "key": key}


@router.put("/dev-upload/{key:path}")
async def dev_upload(key: str, request: Request):
    """Dev-mode file receiver — stores uploaded file to local disk shared with worker."""
    file_path = os.path.join(UPLOAD_DIR, key)
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    body = await request.body()
    with open(file_path, "wb") as f:
        f.write(body)
    return {"status": "ok", "key": key, "size": len(body)}


@router.post("/")
async def create_blueprint(
    project_id: str = Query(...),
    file_key: str = Query(...),
    file_type: str = Query(...),
    file_size_kb: int = Query(...),
):
    """Register a blueprint after upload completes."""
    db = get_supabase()
    result = db.table("blueprints").insert({
        "project_id": project_id,
        "file_url": file_key,
        "file_type": file_type,
        "file_size_kb": file_size_kb,
        "status": "pending",
    }).execute()
    return result.data[0]


@router.get("/debug/test-ai")
async def test_ai():
    """Verify the AI provider is working. Must be defined BEFORE /{blueprint_id} routes."""
    from app.services.llm import llm_text
    try:
        result = await llm_text("Reply with exactly: OK", max_tokens=10)
        return {"status": "ok", "response": result.strip()}
    except Exception as e:
        return {"status": "error", "error": str(e)}


@router.post("/{blueprint_id}/analyze")
async def trigger_analysis(blueprint_id: str, background_tasks: BackgroundTasks):
    """Kick off blueprint AI analysis in the background and return immediately."""
    db = get_supabase()
    db.table("blueprints").update({"status": "processing"}).eq("id", blueprint_id).execute()
    background_tasks.add_task(_run_analysis_bg, blueprint_id)
    return {"status": "processing", "job_id": blueprint_id}


def _set_status(db, blueprint_id: str, status: str, error: str = None):
    """
    Update blueprint status. Always updates status in its own call first —
    never bundles status + error_message together, because error_message column
    may not exist yet in older deployments, which would cause the whole update to fail.
    """
    try:
        db.table("blueprints").update({"status": status}).eq("id", blueprint_id).execute()
    except Exception:
        logger.exception(f"CRITICAL: could not set status={status} for {blueprint_id}")

    # Attempt to store error text separately — non-fatal if column doesn't exist
    if error:
        try:
            db.table("blueprints").update({"error_message": error[-2000:]}).eq("id", blueprint_id).execute()
        except Exception:
            logger.debug("error_message column update failed (column may not exist)", exc_info=True)
            pass  # column doesn't exist — status was already set above, that's enough


def _run_analysis_bg(blueprint_id: str):
    import traceback
    import threading
    from app.services.ai_pipeline import run_analysis_pipeline
    db = get_supabase()

    result = {"error": None, "done": False}

    def _target():
        try:
            run_analysis_pipeline(blueprint_id)
            result["done"] = True
        except Exception:
            logger.debug("analysis thread target failed", exc_info=True)
            result["error"] = traceback.format_exc()

    thread = threading.Thread(target=_target, daemon=True)
    thread.start()
    thread.join(timeout=300)  # 5-minute hard cap

    if thread.is_alive():
        logger.error(f"blueprint {blueprint_id} TIMED OUT after 5 minutes")
        _set_status(db, blueprint_id, "failed", "Analysis timed out after 5 minutes. Please retry.")
        return

    if result["error"]:
        logger.error(f"blueprint {blueprint_id} FAILED:\n{result['error']}")
        _set_status(db, blueprint_id, "failed", result["error"])
        return

    _set_status(db, blueprint_id, "complete")


@router.post("/{blueprint_id}/retry")
async def retry_analysis(blueprint_id: str, background_tasks: BackgroundTasks):
    """Retry a failed blueprint analysis without re-uploading."""
    db = get_supabase()
    db.table("blueprints").update({"status": "processing"}).eq("id", blueprint_id).execute()
    background_tasks.add_task(_run_analysis_bg, blueprint_id)
    return {"status": "processing", "job_id": blueprint_id}




@router.get("/{blueprint_id}/view")
async def view_blueprint(blueprint_id: str):
    """
    Proxy the blueprint file from Supabase storage using the service role key.
    Works regardless of whether the bucket is public or private.
    """
    import re
    import asyncio
    from fastapi.responses import Response

    db = get_supabase()
    result = (
        db.table("blueprints")
        .select("file_url, file_type")
        .eq("id", blueprint_id)
        .single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Blueprint not found")

    file_url: str = result.data.get("file_url", "") or ""
    file_type: str = (result.data.get("file_type") or "").lower()

    if not file_url:
        raise HTTPException(status_code=404, detail="No file stored for this blueprint")

    # Extract the storage path — strip bucket name from URL
    # URL pattern: https://<proj>.supabase.co/storage/v1/object/public/blueprints/<path>
    m = re.search(r'/blueprints/(.+?)(?:\?.*)?$', file_url)
    if not m:
        raise HTTPException(status_code=400, detail=f"Unrecognised file_url format: {file_url[:80]}")
    storage_path = m.group(1)

    try:
        # storage.download() uses the service role key internally — always works
        file_bytes = await asyncio.to_thread(
            db.storage.from_("blueprints").download, storage_path
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Storage download failed: {e}")

    content_type_map = {
        "pdf":  "application/pdf",
        "png":  "image/png",
        "jpg":  "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "gif":  "image/gif",
    }
    content_type = content_type_map.get(file_type, "application/octet-stream")

    return Response(
        content=file_bytes,
        media_type=content_type,
        headers={
            "Cache-Control": "private, max-age=3600",
            "Access-Control-Allow-Origin": "*",
        },
    )




@router.get("/{blueprint_id}/status")
async def get_status(blueprint_id: str):
    db = get_supabase()
    result = (
        db.table("blueprints")
        .select("*")
        .eq("id", blueprint_id)
        .single()
        .execute()
    )
    return result.data or {"status": "unknown"}


@router.get("/{blueprint_id}/takeoff")
async def blueprint_takeoff(blueprint_id: str):
    """
    Togal-style takeoff: read the cached scene_3d and return contractor-ready
    quantities (per-room flooring, wall LF by type, drywall sheets, framing,
    door/window counts) plus a list of material rows that can be added
    straight into the Materials tab with one click.

    If scene_3d is missing, we kick off the vision pass inline so the
    contractor doesn't have to bounce back to another tab first.
    """
    import json as _json
    from app.services.blueprint_takeoff_service import compute_takeoff, takeoff_to_material_rows

    db = get_supabase()
    bp = db.table("blueprints").select("id, project_id").eq("id", blueprint_id).single().execute()
    if not bp.data:
        raise HTTPException(status_code=404, detail="Blueprint not found")

    analysis = db.table("analyses").select("id, scene_3d").eq("blueprint_id", blueprint_id).limit(1).execute()
    scene: dict | None = None
    analysis_id = None
    if analysis.data:
        analysis_id = analysis.data[0]["id"]
        scene_raw = analysis.data[0].get("scene_3d")
        if isinstance(scene_raw, str) and scene_raw:
            try:
                scene = _json.loads(scene_raw)
            except Exception:
                logger.debug("scene_3d JSON decode failed", exc_info=True)
                scene = None
        elif isinstance(scene_raw, dict):
            scene = scene_raw

    if not scene:
        # Vision pass wasn't run yet — do it now.
        from app.services.blueprint_vision_service import parse_blueprint_3d as _parse
        try:
            scene = await _parse(blueprint_id)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Blueprint vision pass failed: {e}")
        # Cache back for next time (best-effort)
        try:
            if analysis_id:
                db.table("analyses").update({"scene_3d": _json.dumps(scene)}).eq("id", analysis_id).execute()
        except Exception:
            logger.debug("scene_3d cache write failed", exc_info=True)

    try:
        takeoff = compute_takeoff(scene)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.exception("takeoff computation failed")
        raise HTTPException(status_code=500, detail=f"Takeoff failed: {e}")

    material_rows = takeoff_to_material_rows(takeoff)
    return {
        "blueprint_id": blueprint_id,
        "project_id": bp.data.get("project_id"),
        "takeoff": takeoff,
        "material_rows": material_rows,
    }


@router.post("/{blueprint_id}/takeoff/apply")
async def apply_takeoff_to_materials(blueprint_id: str):
    """
    One-click: run the takeoff, then upsert each derived row into
    project_materials so the Materials tab picks them up. Existing manually-
    added rows are preserved; we only add rows tagged `source='blueprint_takeoff'`
    that aren't already present.
    """
    db = get_supabase()
    bp = db.table("blueprints").select("project_id").eq("id", blueprint_id).single().execute()
    if not bp.data:
        raise HTTPException(status_code=404, detail="Blueprint not found")
    project_id = bp.data.get("project_id")
    if not project_id:
        raise HTTPException(status_code=422, detail="Blueprint has no project")

    # Reuse the GET endpoint logic by calling the helper directly
    result = await blueprint_takeoff(blueprint_id)
    rows: list[dict] = result.get("material_rows") or []

    # Find existing takeoff rows so we don't duplicate on repeat clicks
    try:
        existing = (
            db.table("project_materials")
            .select("id, item_name, source")
            .eq("project_id", project_id)
            .execute()
        )
        existing_names = {
            (r.get("item_name") or "").lower()
            for r in (existing.data or [])
            if (r.get("source") == "blueprint_takeoff")
        }
    except Exception:
        existing_names = set()

    inserted = 0
    for row in rows:
        if (row["item_name"] or "").lower() in existing_names:
            continue
        payload = {
            "project_id": project_id,
            "item_name": row["item_name"],
            "category": row["category"],
            "quantity": row["quantity"],
            "unit": row["unit"],
            "unit_cost": row.get("unit_cost") or 0,
            "total_cost": row.get("total_cost") or 0,
            "source": "blueprint_takeoff",
        }
        try:
            db.table("project_materials").insert(payload).execute()
            inserted += 1
        except Exception as e:
            msg = str(e).lower()
            if "source" in msg or "column" in msg:
                payload.pop("source", None)
                try:
                    db.table("project_materials").insert(payload).execute()
                    inserted += 1
                except Exception:
                    logger.debug("takeoff apply insert failed (no-source retry)", exc_info=True)
            else:
                logger.debug("takeoff apply insert failed", exc_info=True)

    return {
        "project_id": project_id,
        "rows_added": inserted,
        "rows_total": len(rows),
        "takeoff": result.get("takeoff"),
    }


