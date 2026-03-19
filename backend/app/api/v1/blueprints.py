from fastapi import APIRouter, HTTPException, Query, Request
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
    """Return a presigned URL for direct browser upload to S3/R2."""
    if not settings.AWS_ACCESS_KEY_ID:
        key = f"blueprints/{project_id}/{uuid.uuid4()}/{filename}"
        base_url = str(request.base_url).rstrip("/")
        return {
            "upload_url": f"{base_url}/api/v1/blueprints/dev-upload/{key}",
            "key": key,
            "dev_mode": True,
        }

    s3 = get_s3_client()
    key = f"blueprints/{project_id}/{uuid.uuid4()}/{filename}"
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
async def trigger_analysis(blueprint_id: str):
    """Queue a blueprint for AI analysis."""
    try:
        from app.workers.tasks import analyze_blueprint
        task = analyze_blueprint.delay(blueprint_id)
        return {"job_id": task.id, "status": "queued"}
    except Exception as e:
        db = get_supabase()
        db.table("blueprints").update({"status": "processing"}).eq("id", blueprint_id).execute()
        return {"job_id": "local", "status": "queued", "note": str(e)}


@router.get("/{blueprint_id}/status")
async def get_status(blueprint_id: str):
    db = get_supabase()
    result = (
        db.table("blueprints")
        .select("status")
        .eq("id", blueprint_id)
        .single()
        .execute()
    )
    return result.data or {"status": "unknown"}
