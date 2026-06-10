"""
APIR end-to-end orchestrator.

Given a fully-assembled PropertyMeasurements (from extraction.py) and a
Supabase service-role client, this module:

  1. Renders all 7 SVG diagrams (4a facet plan, 4d footprint, 4e soffit,
     4c×4 siding elevations, 4f measurement key, pitch_view full/compact).
  2. Renders the 12-page HTML template via Jinja2.
  3. Renders HTML→PDF via WeasyPrint.
  4. Uploads the PDF to S3 (or local /tmp in dev).
  5. Inserts a row into apir_reports with a frozen measurements_snapshot,
     scale provenance, and the pdf_url.
  6. Returns a GenerateReportResponse the router can hand back to the UI.

The router (Phase 4) is responsible for fetching the PropertyMeasurements +
CompanyProfile from the DB and passing them in. This orchestrator stays
DB-agnostic except for the final apir_reports INSERT, which takes a
service-role Supabase client supplied by the caller.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from app.schemas.apir import (
    GenerateReportResponse, PropertyMeasurements, ReportStatus,
)
from app.services.report.diagrams.diagram_4a_facet_plan import render_facet_plan
from app.services.report.diagrams.diagram_4c_elevation import render_elevation
from app.services.report.diagrams.diagram_4d_footprint import render_footprint
from app.services.report.diagrams.diagram_4e_soffit import render_soffit_plan
from app.services.report.diagrams.diagram_4f_measurement_key import (
    render_measurement_key,
)
from app.services.report.diagrams.diagram_pitch_view import render_pitch_view
from app.services.report.pdf_renderer import render_pdf, render_html
from app.services.report.s3_upload import build_pdf_filename, upload_pdf

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────
# Diagram rendering — runs in-process, no I/O
# ─────────────────────────────────────────────────────────────────────────

def render_all_diagrams(measurements: PropertyMeasurements) -> dict[str, str]:
    """
    Render every diagram the APIR template needs. Returns dict of SVG
    strings keyed by template name. Diagram functions tolerate missing
    inputs (empty facet list, no footprint) and return placeholder SVGs,
    so this never raises.
    """
    facets = measurements.roof.facets
    diagrams: dict[str, str] = {
        "facet_plan": render_facet_plan(facets),
        "pitch_view_full": render_pitch_view(facets),
        "pitch_view_compact": render_pitch_view(facets, width=320, max_height=240),
        "footprint": render_footprint(measurements.footprint),
        "soffit": render_soffit_plan(measurements.footprint, measurements.soffit),
        "measurement_key": render_measurement_key(),
    }
    # Elevations — one per (front/right/left/back). When an elevation
    # is missing from siding.elevations we leave the key absent so the
    # PDF renderer subs in a placeholder.
    for elev in measurements.siding.elevations:
        windows = [
            w for w in measurements.siding.openings.windows
            if w.elevation_id == elev.id
        ]
        doors = [
            d for d in measurements.siding.openings.doors
            if d.elevation_id == elev.id
        ]
        diagrams[f"elev_{elev.elevation}"] = render_elevation(elev, windows, doors)
    return diagrams


# ─────────────────────────────────────────────────────────────────────────
# Full end-to-end report generation
# ─────────────────────────────────────────────────────────────────────────

def generate_report(
    measurements: PropertyMeasurements,
    *,
    project_id: str,
    run_id: Optional[str] = None,
    supabase_client: Optional[Any] = None,
    generated_by_user_id: Optional[str] = None,
    skip_db_insert: bool = False,
) -> GenerateReportResponse:
    """
    The full APIR pipeline.

    Args:
        measurements: completed PropertyMeasurements (from extraction.py)
        project_id: Axis Performance project the report belongs to
        run_id: roof_measurement_runs.id this report wraps (optional)
        supabase_client: service-role Supabase client (optional in dev)
        generated_by_user_id: auth.users id of the contractor
        skip_db_insert: dev flag — render + upload but don't write to DB

    Returns:
        GenerateReportResponse with report_id, version, download_url.

    Errors are surfaced as RuntimeError with a clear message — the router
    catches them and maps to the APIR error codes (NO_ROOF_OUTLINES, etc.)
    """
    if not measurements.roof.facets:
        raise RuntimeError(
            "NO_ROOF_OUTLINES: PropertyMeasurements has no roof facets. "
            "Draw at least one RF-X polygon before generating a report."
        )

    # 1. Render diagrams ---------------------------------------------------
    diagrams = render_all_diagrams(measurements)

    # 2. Render PDF --------------------------------------------------------
    try:
        pdf_bytes = render_pdf(measurements, diagrams)
    except Exception as e:
        logger.exception("PDF render failed")
        raise RuntimeError(
            f"EXTRACTION_FAILED: PDF rendering failed: {e}"
        ) from e

    # 3. Upload ------------------------------------------------------------
    next_version = _next_version(supabase_client, project_id, skip_db_insert)
    filename = build_pdf_filename(
        address=measurements.job.property_address,
        job_id=measurements.job.job_id,
        report_date=measurements.job.report_date,
    )
    download_url = upload_pdf(
        pdf_bytes,
        project_id=project_id,
        version=next_version,
        filename=filename,
    )

    # 4. Insert into apir_reports -----------------------------------------
    generated_at = datetime.now(timezone.utc)
    report_id = None
    final_version = next_version

    if not skip_db_insert and supabase_client is not None:
        snapshot = measurements.model_dump(mode="json")
        row = {
            "project_id": project_id,
            "run_id": run_id,
            "version": 0,   # trigger auto-bumps to MAX+1
            "status": "draft",
            "pdf_url": download_url,
            "pdf_size_kb": round(len(pdf_bytes) / 1024),
            "measurements_snapshot": snapshot,
            "scale_confidence": measurements.job.scale_confidence,
            "scale_method": measurements.job.scale_method,
            "report_type": measurements.job.report_type,
            "ai_model_used": measurements.extraction_metadata.ai_model_used,
            "page_count": 12,
            "generated_by": generated_by_user_id,
        }
        try:
            resp = supabase_client.table("apir_reports").insert(row).execute()
            inserted = resp.data[0] if getattr(resp, "data", None) else None
            if inserted:
                report_id = inserted.get("id")
                final_version = int(inserted.get("version", next_version))
        except Exception as e:
            # Don't lose the rendered PDF over a DB write failure — log
            # loudly so the user notices, but return the URL anyway.
            logger.exception("apir_reports insert failed: %s", e)

    status: ReportStatus = "draft"
    return GenerateReportResponse(
        report_id=report_id or f"local-{generated_at.isoformat()}",
        status=status,
        version=final_version,
        download_url=download_url,
        generated_at=generated_at,
        page_count=12,
        scale_confidence=measurements.job.scale_confidence,
    )


# ─────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────

def _next_version(
    supabase_client: Optional[Any], project_id: str, skip_db_insert: bool,
) -> int:
    """
    Compute the next version number for the upload key. The DB trigger
    will reassign authoritatively on INSERT — this is just for the file
    path so we don't overwrite the previous PDF if two generations race.
    """
    if skip_db_insert or supabase_client is None:
        return 1
    try:
        resp = (
            supabase_client.table("apir_reports")
            .select("version")
            .eq("project_id", project_id)
            .order("version", desc=True)
            .limit(1)
            .execute()
        )
        rows = getattr(resp, "data", None) or []
        if rows:
            return int(rows[0]["version"]) + 1
    except Exception as e:
        logger.warning("version lookup failed (%s) — defaulting to 1", e)
    return 1


# ─────────────────────────────────────────────────────────────────────────
# HTML-only helper (for browser preview during dev)
# ─────────────────────────────────────────────────────────────────────────

def generate_html_preview(measurements: PropertyMeasurements) -> str:
    """
    Render the APIR template to an HTML string without PDF conversion.
    Useful for the /api/v2/reports/preview endpoint that returns the
    contractor a browser-renderable preview before they commit to a
    finalized PDF.
    """
    diagrams = render_all_diagrams(measurements)
    return render_html(measurements, diagrams)
