from fastapi import APIRouter, HTTPException, Query, Request, BackgroundTasks
from app.core.supabase import get_supabase
from app.core.config import settings
import uuid
import os

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


@router.post("/{blueprint_id}/analyze")
async def trigger_analysis(blueprint_id: str, background_tasks: BackgroundTasks):
    """Kick off blueprint AI analysis in the background and return immediately."""
    db = get_supabase()
    db.table("blueprints").update({"status": "processing"}).eq("id", blueprint_id).execute()
    background_tasks.add_task(_run_analysis_bg, blueprint_id)
    return {"status": "processing", "job_id": blueprint_id}


def _run_analysis_bg(blueprint_id: str):
    import traceback
    from app.services.ai_pipeline import run_analysis_pipeline
    db = get_supabase()
    try:
        run_analysis_pipeline(blueprint_id)
        db.table("blueprints").update({"status": "complete"}).eq("id", blueprint_id).execute()
    except Exception as e:
        err_msg = traceback.format_exc()
        print(f"[analysis] blueprint {blueprint_id} FAILED:\n{err_msg}")
        try:
            db.table("blueprints").update({"status": "failed"}).eq("id", blueprint_id).execute()
        except Exception as e2:
            print(f"[analysis] could not set failed status: {e2}")


@router.get("/{blueprint_id}/view")
async def view_blueprint(blueprint_id: str):
    """
    Proxy the blueprint file directly from Supabase storage.
    Uses the service role key so it works regardless of bucket visibility.
    Streams the raw bytes back to the browser with correct Content-Type.
    """
    import httpx
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

    file_url: str = result.data.get("file_url", "")
    file_type: str = (result.data.get("file_type") or "").lower()

    if not file_url:
        raise HTTPException(status_code=404, detail="No file URL stored for this blueprint")

    # Build the authenticated download URL using the service role key
    from app.core.config import settings
    from fastapi.responses import Response

    # Try to download via Supabase REST API with service role key
    headers = {
        "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
        "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
    }

    # Convert the stored URL to an authenticated download URL if needed
    # Stored pattern: https://<proj>.supabase.co/storage/v1/object/public/blueprints/<path>
    # Authenticated pattern: https://<proj>.supabase.co/storage/v1/object/authenticated/blueprints/<path>
    # Direct download with service key works on both patterns
    fetch_url = file_url.replace("/object/public/", "/object/authenticated/")

    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        resp = await client.get(fetch_url, headers=headers)
        if resp.status_code != 200:
            # Try the original URL as fallback
            resp = await client.get(file_url, headers=headers)
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Could not fetch blueprint from storage: HTTP {resp.status_code}")

        content_type_map = {
            "pdf":  "application/pdf",
            "png":  "image/png",
            "jpg":  "image/jpeg",
            "jpeg": "image/jpeg",
            "webp": "image/webp",
            "gif":  "image/gif",
        }
        content_type = content_type_map.get(file_type) or resp.headers.get("content-type", "application/octet-stream")

        return Response(
            content=resp.content,
            media_type=content_type,
            headers={"Cache-Control": "private, max-age=3600"},
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


@router.post("/{blueprint_id}/retry")
async def retry_analysis(blueprint_id: str, background_tasks: BackgroundTasks):
    """Re-trigger analysis for a failed blueprint."""
    db = get_supabase()
    db.table("blueprints").update({"status": "processing"}).eq("id", blueprint_id).execute()
    background_tasks.add_task(_run_analysis_bg, blueprint_id)
    return {"status": "processing", "blueprint_id": blueprint_id}
