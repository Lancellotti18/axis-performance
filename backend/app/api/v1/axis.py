"""
axis.py — AXIS PERFORMANCE API Routes
======================================
Endpoints:
  POST /{project_id}/run      — trigger full AXIS pipeline (3D + 5D)
  GET  /{project_id}/status   — poll job status
  GET  /{project_id}/results  — get all outputs (summary, renders, costs, schedule, insights)
  GET  /{project_id}/render/{filename} — serve a rendered image
  GET  /{project_id}/report   — download the PDF report
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from app.core.supabase import get_supabase

router = APIRouter()
log = __import__("logging").getLogger(__name__)

# In-memory job registry (upgrade to Redis for multi-worker deployments)
_jobs: dict[str, dict] = {}

# Root output directory for AXIS pipeline outputs
AXIS_OUTPUT_ROOT = os.environ.get("AXIS_OUTPUT_DIR", "/tmp/axis_outputs")
BLENDER_PATH     = os.environ.get("BLENDER_PATH", "blender")
def _find_pipeline_dir() -> str:
    # Check env override first
    env = os.environ.get("PIPELINE_DIR")
    if env and os.path.isdir(env):
        return env
    # Relative to this file: works locally (monorepo) and on Render if full repo deployed
    candidates = [
        os.path.join(os.path.dirname(__file__), "../../../../blender_pipeline"),
        os.path.join(os.path.dirname(__file__), "../../../blender_pipeline"),
        os.path.join(os.path.dirname(__file__), "../../blender_pipeline"),
        "/app/blender_pipeline",
        "/app/backend/blender_pipeline",
    ]
    for c in candidates:
        if os.path.isdir(os.path.abspath(c)):
            return os.path.abspath(c)
    # Last resort: return the relative path and let the import fail with a clear message
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../../blender_pipeline"))

PIPELINE_DIR = _find_pipeline_dir()


class RunRequest(BaseModel):
    quality:       str = "production"   # preview | production | ultra
    roof_type:     str = "gable"        # gable | hip | flat | shed
    time_of_day:   str = "golden_hour"  # morning | midday | golden_hour | dusk
    wall_material: str = "stucco"       # stucco | brick | concrete | fiber_cement
    roof_material: str = "asphalt"      # asphalt | metal | clay
    start_date:    str = ""             # ISO date or empty for today
    run_5d:        bool = True
    generate_pdf:  bool = True
    project_name:  str = "Project"
    trade_type:    str = "General Construction"   # Roofing | New Construction | Renovation | General Construction
    use_cloud_gpu: bool = False          # True = submit to RunPod instead of local Blender


def _output_dir(project_id: str) -> str:
    d = os.path.join(AXIS_OUTPUT_ROOT, project_id)
    os.makedirs(d, exist_ok=True)
    return d


async def _parse_blueprint_with_claude(blueprint_id: str, out_dir: str) -> dict | None:
    """
    Parse blueprint with Claude Vision (highest accuracy).
    Saves result as scene_data.json. Returns the parsed dict or None on failure.
    """
    try:
        import asyncio
        from app.services.blueprint_vision_service import parse_blueprint_3d as _vision_parse
        scene_data = await _vision_parse(blueprint_id)
        os.makedirs(os.path.join(out_dir, "data"), exist_ok=True)
        path = os.path.join(out_dir, "data", "scene_data.json")
        with open(path, "w") as f:
            json.dump(scene_data, f)
        log.info(f"[AXIS] Claude Vision parse complete — confidence={scene_data.get('confidence', 0):.2f}")
        return scene_data
    except Exception as e:
        log.warning(f"[AXIS] Claude Vision parse failed: {e}")
        return None


def _run_5d_only(job_id: str, project_id: str, request: RunRequest) -> None:
    """
    Run only the 5D pipeline.

    Source priority for measurements (most accurate first):
      1. Claude Vision re-parse of the actual blueprint image (always attempted)
      2. Existing scene_data.json from prior Claude Vision parse (DB cache)
      3. scene_data.json from a prior Blender parse (CV2)

    Using Claude Vision ensures measurements come from the actual blueprint,
    not random defaults or imprecise line detection.
    """
    job = _jobs.get(job_id)
    if not job:
        return

    out_dir = _output_dir(project_id)
    os.makedirs(os.path.join(out_dir, "data"), exist_ok=True)
    scene_data_path = os.path.join(out_dir, "data", "scene_data.json")

    try:
        job["status"]     = "running_5d"
        job["started_at"] = time.time()

        db = get_supabase()
        bp = db.table("blueprints").select("id, file_url, file_type")\
               .eq("project_id", project_id)\
               .order("created_at", desc=True).limit(1).execute()
        blueprint_id = bp.data[0]["id"] if bp.data else None

        # 1. Always try Claude Vision first for highest accuracy
        if blueprint_id:
            import asyncio
            loop = asyncio.new_event_loop()
            try:
                vision_data = loop.run_until_complete(
                    _parse_blueprint_with_claude(blueprint_id, out_dir)
                )
            finally:
                loop.close()
            if vision_data:
                scene_data = vision_data
            else:
                scene_data = None
        else:
            scene_data = None

        # 2. Fall back to DB-cached scene_3d from prior analysis
        if scene_data is None and blueprint_id:
            analysis = db.table("analyses").select("scene_3d")\
                         .eq("blueprint_id", blueprint_id).limit(1).execute()
            if analysis.data and analysis.data[0].get("scene_3d"):
                sd = analysis.data[0]["scene_3d"]
                scene_data = json.loads(sd) if isinstance(sd, str) else sd
                os.makedirs(os.path.join(out_dir, "data"), exist_ok=True)
                with open(scene_data_path, "w") as f:
                    json.dump(scene_data, f)
                log.info("[AXIS] Using cached scene_3d from database")

        # 3. Fall back to existing scene_data.json on disk
        if scene_data is None and os.path.exists(scene_data_path):
            with open(scene_data_path) as f:
                scene_data = json.load(f)
            log.info("[AXIS] Using existing scene_data.json from disk")

        if scene_data is None:
            raise FileNotFoundError(
                "No blueprint data found. Upload a blueprint and generate the 3D model first."
            )

        # Write winning scene_data to disk so Blender pipeline can read it.
        # Only write if it wasn't already saved by _parse_blueprint_with_claude().
        if not os.path.exists(scene_data_path):
            os.makedirs(os.path.dirname(scene_data_path), exist_ok=True)
            with open(scene_data_path, "w") as f:
                json.dump(scene_data, f, indent=2)

        from app.services.quantity_takeoff import run_quantity_takeoff
        from app.services.pipeline_cost_engine import run_cost_engine
        from app.services.construction_scheduler import run_scheduler
        from app.services.ai_insights import run_ai_insights

        quantities  = run_quantity_takeoff(scene_data, out_dir)

        # Fetch live regional pricing before running cost engine
        project_zip  = ""
        project_city = ""
        project_state = ""
        try:
            proj = db.table("projects").select("zip_code, city, region")\
                     .eq("id", project_id).limit(1).execute()
            if proj.data:
                project_zip   = proj.data[0].get("zip_code", "") or ""
                project_city  = proj.data[0].get("city", "") or ""
                project_state = (proj.data[0].get("region", "") or "").replace("US-", "")
        except Exception:
            log.debug("project location lookup failed, using empty defaults", exc_info=True)
            pass

        live_pricing_summary = None
        try:
            from app.services.live_pricing_service import get_project_pricing
            # Build a simple flat material list for pricing lookup
            flat_mats = []
            for item in quantities.get("_raw_items", []):
                flat_mats.append({
                    "item_name":  item.get("item_name", ""),
                    "unit_cost":  item.get("unit_cost", 0),
                    "quantity":   item.get("quantity", 0),
                    "unit":       item.get("unit", ""),
                    "category":   item.get("category", ""),
                })
            if flat_mats:
                live_pricing_summary = get_project_pricing(
                    flat_mats, project_zip, project_city, project_state
                )
                # Save for report
                lp_path = os.path.join(out_dir, "data", "live_pricing.json")
                with open(lp_path, "w") as f:
                    json.dump(live_pricing_summary, f, indent=2)
        except Exception as e:
            log.warning(f"[AXIS] Live pricing fetch failed (non-fatal): {e}")

        cost_report = run_cost_engine(quantities, out_dir)
        schedule    = run_scheduler(quantities, out_dir,
                                    start_date=request.start_date or None)
        insights    = run_ai_insights(quantities, cost_report, schedule, out_dir,
                                       project_name=request.project_name)

        if request.generate_pdf:
            from app.services.report_generator import generate_report
            generate_report(
                quantities=quantities,
                cost_report=cost_report,
                schedule=schedule,
                insights=insights,
                output_dir=out_dir,
                project_name=request.project_name,
            )

        # Write summary
        meta = quantities.get("meta", {})
        cost_sum = cost_report.get("summary", {})
        summary = {
            "project_name":   request.project_name,
            "area_sqft":      meta.get("area_sqft", 0),
            "standard_total": cost_sum.get("standard_total", 0),
            "economy_total":  cost_sum.get("economy_total", 0),
            "premium_total":  cost_sum.get("premium_total", 0),
            "standard_psf":   cost_sum.get("standard_per_sqft", 0),
            "calendar_days":  schedule.get("total_calendar_days", 0),
            "working_days":   schedule.get("total_working_days", 0),
            "labor_hours":    schedule.get("total_labor_hours", 0),
            "renders": {
                "exterior_hero":        "renders/exterior_hero.png",
                "aerial_45":            "renders/aerial_45.png",
                "street_level":         "renders/street_level.png",
                "interior_walkthrough": "renders/interior_walkthrough.png",
            },
        }
        with open(os.path.join(out_dir, "data", "axis_summary.json"), "w") as f:
            json.dump(summary, f, indent=2)

        job["status"]       = "complete"
        job["completed_at"] = time.time()
        job["output_dir"]   = out_dir
        job["summary"]      = summary

    except Exception as e:
        job["status"] = "error"
        job["error"]  = str(e)


def _run_blender_pipeline(job_id: str, project_id: str,
                           blueprint_path: str, request: RunRequest) -> None:
    """Run the full Blender + 5D pipeline as a subprocess."""
    job = _jobs.get(job_id)
    if not job:
        return

    out_dir = _output_dir(project_id)

    try:
        job["status"]     = "running_3d"
        job["started_at"] = time.time()

        pipeline_main = os.path.join(os.path.abspath(PIPELINE_DIR), "main.py")

        cmd = [
            BLENDER_PATH, "--background", "--python", pipeline_main, "--",
            blueprint_path,
            out_dir,
            request.quality,
            request.roof_type,
            request.time_of_day,
            request.wall_material,
            request.roof_material,
            "true" if request.run_5d else "false",
            request.project_name,
            request.start_date or "",
        ]

        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=3600,  # 60-minute max for ultra quality
        )

        if proc.returncode != 0:
            raise RuntimeError(
                f"Blender exited with code {proc.returncode}.\n"
                f"STDERR: {proc.stderr[-2000:]}"
            )

        # Read summary written by pipeline
        summary_path = os.path.join(out_dir, "data", "axis_summary.json")
        summary = {}
        if os.path.exists(summary_path):
            with open(summary_path) as f:
                summary = json.load(f)

        job["status"]       = "complete"
        job["completed_at"] = time.time()
        job["output_dir"]   = out_dir
        job["summary"]      = summary

    except subprocess.TimeoutExpired:
        job["status"] = "error"
        job["error"]  = "Pipeline timed out after 60 minutes."
    except Exception as e:
        job["status"] = "error"
        job["error"]  = str(e)


# ─────────────────────────────────────────────────────────────────────────────
# ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{project_id}/run")
async def run_axis_pipeline(
    project_id:       str,
    request:          RunRequest,
    background_tasks: BackgroundTasks,
):
    """
    Trigger the AXIS performance pipeline for a project.
    If Blender is not available, runs only the 5D pipeline using existing scene_data.
    Returns a job_id to poll for status.
    """
    db = get_supabase()

    # Get blueprint file path
    bp = db.table("blueprints").select("id, file_url, file_type")\
           .eq("project_id", project_id)\
           .order("created_at", desc=True).limit(1).execute()

    if not bp.data:
        raise HTTPException(status_code=404, detail="No blueprint found for this project")

    blueprint = bp.data[0]
    file_url   = blueprint.get("file_url", "")

    job_id = str(uuid.uuid4())[:8]
    _jobs[job_id] = {
        "job_id":     job_id,
        "project_id": project_id,
        "status":     "queued",
        "created_at": time.time(),
        "request":    request.model_dump(),
    }

    # Check if Blender is available
    blender_available = False
    try:
        result = subprocess.run([BLENDER_PATH, "--version"],
                                capture_output=True, timeout=10)
        blender_available = result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # Cloud GPU path: submit to RunPod instead of running locally
    if request.use_cloud_gpu:
        try:
            from app.services.render_queue_service import submit_render_job, check_endpoint_health
            health = check_endpoint_health()
            if not health["configured"]:
                raise HTTPException(
                    status_code=503,
                    detail="RunPod not configured. Set RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID.",
                )

            scene_data_path = os.path.join(_output_dir(project_id), "scene_data.json")
            scene_data = {}
            if os.path.exists(scene_data_path):
                with open(scene_data_path) as f:
                    scene_data = json.load(f)

            runpod_result = submit_render_job(
                project_id=project_id,
                scene_data=scene_data,
                quality=request.quality,
                roof_type=request.roof_type,
                time_of_day=request.time_of_day,
                wall_material=request.wall_material,
                roof_material=request.roof_material,
            )
            _jobs[job_id]["runpod_job_id"] = runpod_result.get("runpod_job_id", "")
            _jobs[job_id]["status"] = "queued_cloud"

            # Also start 5D pipeline locally while GPU renders
            if request.run_5d:
                background_tasks.add_task(_run_5d_only, job_id, project_id, request)

            return {
                "job_id":          job_id,
                "project_id":      project_id,
                "status":          "queued_cloud",
                "runpod_job_id":   runpod_result.get("runpod_job_id"),
                "endpoint_id":     runpod_result.get("endpoint_id"),
                "estimated_min":   runpod_result.get("estimated_duration_min"),
                "message":         "Render submitted to RunPod cloud GPU. 5D analysis running locally.",
            }
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"RunPod submission failed: {e}")

    if blender_available and file_url:
        # Download blueprint to temp file and run full pipeline
        import tempfile
        import httpx

        async def _download_and_run():
            tmp_path = None
            try:
                suffix = ".pdf" if "pdf" in blueprint.get("file_type", "").lower() else ".png"
                with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                    tmp_path = tmp.name

                async with httpx.AsyncClient(timeout=60) as client:
                    resp = await client.get(file_url)
                    resp.raise_for_status()
                    with open(tmp_path, "wb") as f:
                        f.write(resp.content)

                loop = asyncio.get_running_loop()
                await loop.run_in_executor(
                    None, _run_blender_pipeline, job_id, project_id, tmp_path, request
                )
            except Exception as e:
                job = _jobs.get(job_id, {})
                job["status"] = "error"
                job["error"]  = f"Download/run error: {e}"
            finally:
                if tmp_path and os.path.exists(tmp_path):
                    os.unlink(tmp_path)

        background_tasks.add_task(_download_and_run)
    else:
        # No Blender — run 5D pipeline only (background_tasks runs sync functions in threadpool)
        background_tasks.add_task(_run_5d_only, job_id, project_id, request)

    return {
        "job_id":     job_id,
        "project_id": project_id,
        "status":     "queued",
        "blender_available": blender_available,
        "message": "AXIS pipeline started" if blender_available else
                   "5D pipeline started (Blender not available — using existing scene data)",
    }


@router.get("/{project_id}/status")
async def get_axis_status(project_id: str, job_id: Optional[str] = None):
    """Poll pipeline status."""
    if job_id:
        job = _jobs.get(job_id)
        if not job or job["project_id"] != project_id:
            raise HTTPException(status_code=404, detail="Job not found")
        return {
            "job_id":     job_id,
            "status":     job["status"],
            "error":      job.get("error"),
            "elapsed_s":  round(time.time() - job.get("started_at", time.time()), 1)
                          if job.get("started_at") else 0,
        }

    # Return most recent job for this project
    project_jobs = [j for j in _jobs.values() if j["project_id"] == project_id]
    if not project_jobs:
        # Check if we have pre-existing outputs
        out_dir = _output_dir(project_id)
        summary_path = os.path.join(out_dir, "data", "axis_summary.json")
        if os.path.exists(summary_path):
            return {"status": "complete", "job_id": None, "elapsed_s": 0}
        return {"status": "idle", "job_id": None}

    latest = sorted(project_jobs, key=lambda j: j.get("created_at", 0))[-1]
    return {
        "job_id":   latest["job_id"],
        "status":   latest["status"],
        "error":    latest.get("error"),
        "elapsed_s": round(time.time() - latest.get("started_at", time.time()), 1)
                     if latest.get("started_at") else 0,
    }


@router.get("/{project_id}/cloud-status")
async def get_cloud_render_status(project_id: str, job_id: Optional[str] = None):
    """Poll RunPod cloud render status for a job."""
    # Find the job
    if job_id:
        job = _jobs.get(job_id)
    else:
        project_jobs = [j for j in _jobs.values() if j["project_id"] == project_id]
        job = sorted(project_jobs, key=lambda j: j.get("created_at", 0))[-1] if project_jobs else None

    if not job or not job.get("runpod_job_id"):
        raise HTTPException(status_code=404, detail="No cloud render job found for this project")

    from app.services.render_queue_service import get_job_status
    status = get_job_status(job["runpod_job_id"])
    return status


@router.post("/{project_id}/cloud-cancel")
async def cancel_cloud_render(project_id: str, job_id: Optional[str] = None):
    """Cancel a queued or in-progress RunPod render job."""
    if job_id:
        job = _jobs.get(job_id)
    else:
        project_jobs = [j for j in _jobs.values() if j["project_id"] == project_id]
        job = sorted(project_jobs, key=lambda j: j.get("created_at", 0))[-1] if project_jobs else None

    if not job or not job.get("runpod_job_id"):
        raise HTTPException(status_code=404, detail="No cloud render job found")

    from app.services.render_queue_service import cancel_job
    return cancel_job(job["runpod_job_id"])


@router.get("/cloud-health")
async def check_cloud_render_health():
    """Check if RunPod is configured and the endpoint is reachable."""
    from app.services.render_queue_service import check_endpoint_health
    return check_endpoint_health()


@router.get("/{project_id}/results")
async def get_axis_results(project_id: str):
    """Get all AXIS pipeline outputs for a project."""
    out_dir = _output_dir(project_id)

    def _load(name):
        path = os.path.join(out_dir, "data", name)
        if os.path.exists(path):
            with open(path) as f:
                return json.load(f)
        return None

    summary      = _load("axis_summary.json")
    quantities   = _load("quantities.json")
    cost_report  = _load("cost_report.json")
    schedule     = _load("schedule.json")
    insights     = _load("insights.json")
    live_pricing = _load("live_pricing.json")

    if not summary and not quantities:
        raise HTTPException(status_code=404,
                            detail="No AXIS results found. Run the pipeline first.")

    # Check which renders exist
    renders_dir = os.path.join(out_dir, "renders")
    render_urls = {}
    for name in ["exterior_hero", "aerial_45", "street_level", "interior_walkthrough"]:
        path = os.path.join(renders_dir, f"{name}.png")
        if os.path.exists(path):
            render_urls[name] = f"/api/v1/axis/{project_id}/render/{name}.png"

    # Find PDF
    pdf_url = None
    reports_dir = os.path.join(out_dir, "reports")
    if os.path.exists(reports_dir):
        pdfs = list(Path(reports_dir).glob("*.pdf"))
        if pdfs:
            pdf_url = f"/api/v1/axis/{project_id}/report"

    return {
        "summary":      summary,
        "quantities":   quantities,
        "cost_report":  cost_report,
        "schedule":     schedule,
        "insights":     insights,
        "live_pricing": live_pricing,
        "render_urls":  render_urls,
        "pdf_url":      pdf_url,
    }


@router.get("/{project_id}/render/{filename}")
async def serve_render(project_id: str, filename: str):
    """Serve a rendered image file."""
    # Sanitize filename
    filename = os.path.basename(filename)
    if not filename.endswith(".png"):
        raise HTTPException(status_code=400, detail="Only PNG files supported")

    out_dir = _output_dir(project_id)
    path    = os.path.join(out_dir, "renders", filename)

    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"Render not found: {filename}")

    return FileResponse(path, media_type="image/png")


@router.get("/{project_id}/report")
async def serve_report(project_id: str):
    """Download the generated PDF report."""
    out_dir     = _output_dir(project_id)
    reports_dir = os.path.join(out_dir, "reports")

    if not os.path.exists(reports_dir):
        raise HTTPException(status_code=404, detail="No report generated yet.")

    pdfs = list(Path(reports_dir).glob("*.pdf"))
    if not pdfs:
        raise HTTPException(status_code=404, detail="No PDF found. Generate the report first.")

    # Return the most recently modified PDF
    latest_pdf = sorted(pdfs, key=lambda p: p.stat().st_mtime)[-1]
    return FileResponse(
        str(latest_pdf),
        media_type="application/pdf",
        filename=latest_pdf.name,
    )
