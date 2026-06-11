"""
APIR — Axis Property Intelligence Report REST API.

Endpoints (mounted under /api/v1/apir):
  POST /generate     — run extraction + render PDF + upload + insert
  GET  /list/{project_id}        — every version of a project's reports
  GET  /download/{report_id}     — download the PDF (302 to signed URL)
  POST /finalize/{report_id}     — flip status draft → final (one-way lock)
  GET  /preview/{project_id}     — HTML preview (no PDF round-trip)
  GET  /accuracy/{report_id}     — accuracy diagnostics (scale, confidence)

Auth: every endpoint requires a Supabase JWT via the existing require_user
dependency. The Supabase service-role client used internally bypasses RLS,
so the router itself must verify the caller's project ownership before
fetching data.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse

from app.core.auth import require_user
from app.core.supabase import get_supabase
from app.schemas.apir import (
    AccuracyReport, GenerateReportRequest, GenerateReportResponse,
    PropertyMeasurements, ReportErrorResponse,
)
from app.services.report.accuracy_report import compute_accuracy_report
from app.services.report.extraction import build_property_measurements
from app.services.report.generate_report import (
    generate_html_preview, generate_report,
)
from app.services.report.report_data_fetcher import fetch_extraction_input

logger = logging.getLogger(__name__)
router = APIRouter()


# ─────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────

def _verify_project_owner(db, project_id: str, user_id: str) -> dict:
    """Throws 403 if the user doesn't own the project. Returns the row."""
    res = (
        db.table("projects")
        .select("id,user_id,address")
        .eq("id", project_id)
        .limit(1)
        .execute()
    )
    rows = getattr(res, "data", None) or []
    if not rows:
        raise HTTPException(status_code=404, detail="Project not found")
    if rows[0]["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Not your project")
    return rows[0]


def _runtime_error_to_http(e: RuntimeError) -> HTTPException:
    """Map APIR error codes (RuntimeError messages starting with CODE:) → HTTP."""
    msg = str(e)
    code = msg.split(":", 1)[0].strip() if ":" in msg else "EXTRACTION_FAILED"
    status_map = {
        "MISSING_REQUIRED_DATA": 400,
        "NO_ROOF_OUTLINES": 400,
        "SATELLITE_RESOLUTION_TOO_LOW": 400,
        "EXTRACTION_FAILED": 500,
        "FINALIZED_REPORT_LOCKED": 409,
    }
    status_code = status_map.get(code, 500)
    return HTTPException(
        status_code=status_code,
        detail={"error": code, "message": msg.split(":", 1)[-1].strip() or msg},
    )


# ─────────────────────────────────────────────────────────────────────────
# POST /generate
# ─────────────────────────────────────────────────────────────────────────

@router.post(
    "/generate",
    response_model=GenerateReportResponse,
    responses={
        400: {"model": ReportErrorResponse},
        403: {"model": ReportErrorResponse},
        404: {"model": ReportErrorResponse},
        409: {"model": ReportErrorResponse},
        500: {"model": ReportErrorResponse},
    },
)
async def generate(
    req: GenerateReportRequest,
    user: dict = Depends(require_user),
) -> GenerateReportResponse:
    """
    The single endpoint that runs the full APIR pipeline:
      fetch DB rows → vision extraction → diagrams → PDF → S3 → apir_reports row
    Returns a download_url the contractor can hit immediately.
    """
    db = get_supabase()
    _verify_project_owner(db, req.project_id, user["id"])

    try:
        # 1. Pull all data + photos in parallel
        extraction_input = await fetch_extraction_input(
            db=db,
            project_id=req.project_id,
            run_id=req.run_id,
            report_type=req.report_type,
            download_photo_bytes=True,
        )
        # 2. Build the PropertyMeasurements (vision calls + math)
        measurements = await build_property_measurements(extraction_input)
        # 3. Render PDF + upload + insert into apir_reports
        return generate_report(
            measurements,
            project_id=req.project_id,
            run_id=req.run_id,
            supabase_client=db,
            generated_by_user_id=user["id"],
        )
    except RuntimeError as e:
        raise _runtime_error_to_http(e)
    except Exception as e:
        logger.exception("APIR generate failed")
        raise HTTPException(
            status_code=500,
            detail={
                "error": "EXTRACTION_FAILED",
                "message": f"Internal error: {e}",
            },
        )


# ─────────────────────────────────────────────────────────────────────────
# GET /list/{project_id}
# ─────────────────────────────────────────────────────────────────────────

@router.get("/list/{project_id}")
async def list_reports(
    project_id: str,
    user: dict = Depends(require_user),
) -> dict:
    """Every version of every APIR report for this project, newest first."""
    db = get_supabase()
    _verify_project_owner(db, project_id, user["id"])
    res = (
        db.table("apir_reports")
        .select(
            "id,version,status,pdf_url,pdf_size_kb,scale_confidence,"
            "scale_method,report_type,ai_model_used,page_count,"
            "generated_at,generated_by,finalized_at"
        )
        .eq("project_id", project_id)
        .order("version", desc=True)
        .execute()
    )
    return {"reports": getattr(res, "data", None) or []}


# ─────────────────────────────────────────────────────────────────────────
# GET /download/{report_id}
# ─────────────────────────────────────────────────────────────────────────

@router.get("/download/{report_id}")
async def download_report(
    report_id: str,
    user: dict = Depends(require_user),
):
    """
    Redirect to the PDF URL stored on the report row. Caller's browser
    follows the redirect to S3 (or file:// in dev) and downloads the PDF.

    Ownership: confirm the report's project belongs to the caller before
    handing over the URL — apir_reports has RLS but service role bypasses it.
    """
    db = get_supabase()
    res = (
        db.table("apir_reports")
        .select("project_id,pdf_url,status,version")
        .eq("id", report_id)
        .limit(1)
        .execute()
    )
    rows = getattr(res, "data", None) or []
    if not rows:
        raise HTTPException(status_code=404, detail="Report not found")
    report = rows[0]
    _verify_project_owner(db, report["project_id"], user["id"])
    if not report["pdf_url"]:
        raise HTTPException(
            status_code=410,
            detail="Report exists but the PDF was not stored (regenerate).",
        )
    return RedirectResponse(url=report["pdf_url"], status_code=302)


# ─────────────────────────────────────────────────────────────────────────
# POST /finalize/{report_id}
# ─────────────────────────────────────────────────────────────────────────

@router.post("/finalize/{report_id}")
async def finalize_report(
    report_id: str,
    user: dict = Depends(require_user),
) -> dict:
    """
    Flip status draft → final. One-way lock — once finalized the row
    cannot be edited (Postgres trigger raises EXCEPTION).
    """
    db = get_supabase()
    res = (
        db.table("apir_reports")
        .select("id,project_id,status")
        .eq("id", report_id)
        .limit(1)
        .execute()
    )
    rows = getattr(res, "data", None) or []
    if not rows:
        raise HTTPException(status_code=404, detail="Report not found")
    report = rows[0]
    _verify_project_owner(db, report["project_id"], user["id"])
    if report["status"] == "final":
        raise HTTPException(
            status_code=409,
            detail={
                "error": "FINALIZED_REPORT_LOCKED",
                "message": "Report is already finalized.",
            },
        )
    try:
        upd = (
            db.table("apir_reports")
            .update({"status": "final", "finalized_by": user["id"]})
            .eq("id", report_id)
            .execute()
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Finalize failed: {e}")
    return {"ok": True, "report_id": report_id, "status": "final"}


# ─────────────────────────────────────────────────────────────────────────
# GET /accuracy/{report_id}
# ─────────────────────────────────────────────────────────────────────────

@router.get("/accuracy/{report_id}", response_model=AccuracyReport)
async def report_accuracy(
    report_id: str,
    user: dict = Depends(require_user),
) -> AccuracyReport:
    """
    Computes the accuracy diagnostic for a stored report's
    measurements_snapshot. Returns per-category confidence breakdown,
    flagged items, an overall grade (A-D), and an on-site verification
    checklist. Pure derivation — no AI calls, no state mutation.
    """
    db = get_supabase()
    res = (
        db.table("apir_reports")
        .select(
            "id,project_id,version,status,measurements_snapshot"
        )
        .eq("id", report_id)
        .limit(1)
        .execute()
    )
    rows = getattr(res, "data", None) or []
    if not rows:
        raise HTTPException(status_code=404, detail="Report not found")
    row = rows[0]
    _verify_project_owner(db, row["project_id"], user["id"])
    snapshot = row.get("measurements_snapshot")
    if not snapshot:
        raise HTTPException(
            status_code=410,
            detail="Report exists but no measurements_snapshot was stored.",
        )
    try:
        measurements = PropertyMeasurements.model_validate(snapshot)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Stored snapshot failed to parse: {e}",
        )
    return compute_accuracy_report(measurements, report_id=report_id)


# ─────────────────────────────────────────────────────────────────────────
# GET /preview/{project_id}
# ─────────────────────────────────────────────────────────────────────────

@router.get("/preview/{project_id}")
async def html_preview(
    project_id: str,
    run_id: Optional[str] = None,
    user: dict = Depends(require_user),
):
    """
    Render the APIR template to an HTML string and return it for browser
    rendering. Used by the /roof-v2 review step so the contractor can
    eyeball the 12-page layout BEFORE committing to the PDF roundtrip.

    Returns: HTML content-type, the same template the PDF uses.
    """
    from fastapi.responses import HTMLResponse

    db = get_supabase()
    _verify_project_owner(db, project_id, user["id"])
    try:
        extraction_input = await fetch_extraction_input(
            db=db,
            project_id=project_id,
            run_id=run_id,
            report_type="full_exterior",
            download_photo_bytes=False,  # preview skips vision calls for speed
        )
        measurements = await build_property_measurements(extraction_input)
    except RuntimeError as e:
        raise _runtime_error_to_http(e)
    html = generate_html_preview(measurements)
    return HTMLResponse(content=html)
