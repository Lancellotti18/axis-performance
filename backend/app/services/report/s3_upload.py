"""
APIR S3 upload — saves the generated PDF and returns a URL.

Production: upload to settings.S3_BUCKET_NAME (default 'buildai-blueprints'),
return a public URL (or signed URL for private buckets).

Dev (when AWS_ACCESS_KEY_ID is empty): write to /tmp/apir_uploads/ and return
the local file:// URL — keeps the rest of the pipeline working without S3.

Matches the lazy-boto3 pattern used by ai_pipeline.py.
"""
from __future__ import annotations

import logging
import os
import pathlib
import re

from app.core.config import settings

logger = logging.getLogger(__name__)


DEV_UPLOAD_DIR = "/tmp/apir_uploads"


def _safe_address_slug(address: str) -> str:
    """Turn '11318 Sword Road' → '11318_Sword_Road' for filenames."""
    s = re.sub(r"[^a-zA-Z0-9]+", "_", address or "property")
    return s.strip("_") or "property"


def build_pdf_filename(
    *, address: str, job_id: str, report_date: str,
) -> str:
    """
    APIR Part 7 spec:
      APIR_<address>_<job_id>_<YYYY-MM-DD>.pdf

    Example: APIR_11318_Sword_Road_test-job_2026-06-10.pdf
    """
    addr_slug = _safe_address_slug(address)
    job_slug = re.sub(r"[^a-zA-Z0-9-]+", "_", job_id or "job")
    date_slug = re.sub(r"[^0-9-]+", "", report_date or "")
    return f"APIR_{addr_slug}_{job_slug}_{date_slug}.pdf"


def upload_pdf(
    pdf_bytes: bytes,
    *,
    project_id: str,
    version: int,
    filename: str,
) -> str:
    """
    Upload PDF bytes and return a URL the contractor can open.

    Storage layout: apir-reports/<project_id>/v<version>/<filename>.pdf
    """
    key = f"apir-reports/{project_id}/v{version}/{filename}"

    # Dev fallback — write locally so the rest of the pipeline works
    if not settings.AWS_ACCESS_KEY_ID:
        path = pathlib.Path(DEV_UPLOAD_DIR) / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(pdf_bytes)
        url = f"file://{path}"
        logger.info("dev mode — wrote PDF locally: %s (%s bytes)", url, len(pdf_bytes))
        return url

    # Prod path — boto3 to S3 / R2 / S3-compatible
    import boto3
    s3 = boto3.client(
        "s3",
        endpoint_url=settings.S3_ENDPOINT_URL or None,
        aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
        aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
        region_name=settings.S3_REGION or None,
    )

    s3.put_object(
        Bucket=settings.S3_BUCKET_NAME,
        Key=key,
        Body=pdf_bytes,
        ContentType="application/pdf",
        ContentDisposition=f'attachment; filename="{filename}"',
    )

    url = _build_public_url(settings.S3_BUCKET_NAME, key)
    logger.info("uploaded APIR PDF to %s (%s bytes)", url, len(pdf_bytes))
    return url


def _build_public_url(bucket: str, key: str) -> str:
    """Construct the bucket URL. Honors S3_ENDPOINT_URL for R2 / custom."""
    endpoint = (settings.S3_ENDPOINT_URL or "").rstrip("/")
    if endpoint:
        return f"{endpoint}/{bucket}/{key}"
    region = settings.S3_REGION or "us-east-1"
    if region in ("us-east-1", "auto"):
        return f"https://{bucket}.s3.amazonaws.com/{key}"
    return f"https://{bucket}.s3.{region}.amazonaws.com/{key}"
