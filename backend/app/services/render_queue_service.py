"""
render_queue_service.py — Item 10
====================================
Cloud GPU rendering via RunPod API.

Submits Blender render jobs to a RunPod serverless endpoint and polls
for results. All communication uses the real RunPod API:
  https://api.runpod.io/v2/{endpoint_id}/run
  https://api.runpod.io/v2/{endpoint_id}/status/{job_id}

Environment variables required:
  RUNPOD_API_KEY       — RunPod API key (https://www.runpod.io/console/user/settings)
  RUNPOD_ENDPOINT_ID   — RunPod serverless endpoint ID for Blender worker
                         (create at https://www.runpod.io/console/serverless)

The RunPod worker must have:
  - Blender 4.x installed (e.g., use the official blender:4.2-cuda Docker image)
  - The blender_pipeline/ directory available (mounted or baked in)
  - A handler that accepts the job payload and runs main.py

Render quality presets map to Blender Cycles sample counts:
  preview     → 64 samples   (~2-5 min on A4000)
  production  → 256 samples  (~10-20 min on A4000)
  ultra       → 1024 samples (~45-90 min on A4000)
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Optional

import httpx

log = logging.getLogger(__name__)

RUNPOD_API_BASE  = "https://api.runpod.io/v2"
POLL_INTERVAL_S  = 10   # seconds between status polls
MAX_POLL_WAIT_S  = 7200  # 2 hours max wait

QUALITY_SAMPLES = {
    "preview":    64,
    "production": 256,
    "ultra":      1024,
}


def _api_key() -> str:
    key = os.environ.get("RUNPOD_API_KEY", "")
    if not key:
        raise RuntimeError(
            "RUNPOD_API_KEY environment variable not set. "
            "Get your API key from https://www.runpod.io/console/user/settings"
        )
    return key


def _endpoint_id() -> str:
    eid = os.environ.get("RUNPOD_ENDPOINT_ID", "")
    if not eid:
        raise RuntimeError(
            "RUNPOD_ENDPOINT_ID environment variable not set. "
            "Create a serverless endpoint at https://www.runpod.io/console/serverless"
        )
    return eid


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {_api_key()}",
        "Content-Type":  "application/json",
    }


# ── Job submission ─────────────────────────────────────────────────────────────

def submit_render_job(
    project_id:    str,
    scene_data:    dict,
    quality:       str = "production",
    roof_type:     str = "gable",
    time_of_day:   str = "golden_hour",
    wall_material: str = "stucco",
    roof_material: str = "asphalt",
    output_bucket: str = "",
) -> dict:
    """
    Submit a Blender render job to RunPod.

    Returns:
    {
        "runpod_job_id": str,
        "status":        "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED",
        "endpoint_id":   str,
        "submitted_at":  str,   # ISO timestamp
        "estimated_duration_min": int,
        "error":         str | None,
    }
    """
    endpoint_id = _endpoint_id()
    samples = QUALITY_SAMPLES.get(quality, 256)

    payload = {
        "input": {
            "project_id":    project_id,
            "scene_data":    scene_data,
            "quality":       quality,
            "samples":       samples,
            "roof_type":     roof_type,
            "time_of_day":   time_of_day,
            "wall_material": wall_material,
            "roof_material": roof_material,
            "output_bucket": output_bucket,
        }
    }

    url = f"{RUNPOD_API_BASE}/{endpoint_id}/run"

    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(url, headers=_headers(), json=payload)
            resp.raise_for_status()
            data = resp.json()

        job_id = data.get("id") or data.get("job_id", "")
        status = data.get("status", "IN_QUEUE")

        # Estimate duration based on quality
        est_min = {64: 5, 256: 15, 1024: 60}.get(samples, 20)

        log.info(f"[runpod] Job submitted: {job_id} (endpoint={endpoint_id}, quality={quality})")

        return {
            "runpod_job_id":          job_id,
            "status":                 status,
            "endpoint_id":            endpoint_id,
            "submitted_at":           _now(),
            "estimated_duration_min": est_min,
            "error":                  None,
        }

    except httpx.HTTPStatusError as e:
        log.error(f"[runpod] Job submission failed: {e.response.status_code} — {e.response.text}")
        return {
            "runpod_job_id":          "",
            "status":                 "FAILED",
            "endpoint_id":            endpoint_id,
            "submitted_at":           _now(),
            "estimated_duration_min": 0,
            "error":                  f"HTTP {e.response.status_code}: {e.response.text[:200]}",
        }
    except Exception as e:
        log.error(f"[runpod] Submit error: {e}")
        return {
            "runpod_job_id":          "",
            "status":                 "FAILED",
            "endpoint_id":            endpoint_id,
            "submitted_at":           _now(),
            "estimated_duration_min": 0,
            "error":                  str(e),
        }


# ── Status polling ─────────────────────────────────────────────────────────────

def get_job_status(runpod_job_id: str) -> dict:
    """
    Poll RunPod for job status.

    Returns:
    {
        "runpod_job_id":  str,
        "status":         "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED",
        "output":         dict | None,   # render results when COMPLETED
        "delay_time_ms":  int | None,
        "execution_time_ms": int | None,
        "error":          str | None,
    }
    """
    endpoint_id = _endpoint_id()
    url = f"{RUNPOD_API_BASE}/{endpoint_id}/status/{runpod_job_id}"

    try:
        with httpx.Client(timeout=15) as client:
            resp = client.get(url, headers=_headers())
            resp.raise_for_status()
            data = resp.json()

        return {
            "runpod_job_id":     runpod_job_id,
            "status":            data.get("status", "UNKNOWN"),
            "output":            data.get("output"),
            "delay_time_ms":     data.get("delayTime"),
            "execution_time_ms": data.get("executionTime"),
            "error":             data.get("error"),
        }

    except httpx.HTTPStatusError as e:
        return {
            "runpod_job_id": runpod_job_id,
            "status":        "FAILED",
            "output":        None,
            "delay_time_ms": None,
            "execution_time_ms": None,
            "error":         f"HTTP {e.response.status_code}: {e.response.text[:200]}",
        }
    except Exception as e:
        return {
            "runpod_job_id": runpod_job_id,
            "status":        "FAILED",
            "output":        None,
            "delay_time_ms": None,
            "execution_time_ms": None,
            "error":         str(e),
        }


def cancel_job(runpod_job_id: str) -> dict:
    """Cancel a queued or in-progress RunPod job."""
    endpoint_id = _endpoint_id()
    url = f"{RUNPOD_API_BASE}/{endpoint_id}/cancel/{runpod_job_id}"

    try:
        with httpx.Client(timeout=15) as client:
            resp = client.post(url, headers=_headers())
            resp.raise_for_status()
            return {"cancelled": True, "runpod_job_id": runpod_job_id}
    except Exception as e:
        return {"cancelled": False, "runpod_job_id": runpod_job_id, "error": str(e)}


# ── Synchronous wait (for background tasks) ────────────────────────────────────

def wait_for_completion(
    runpod_job_id: str,
    timeout_s: int = MAX_POLL_WAIT_S,
    on_progress=None,   # optional callback(status_dict)
) -> dict:
    """
    Block until the RunPod job completes or times out.

    Args:
        runpod_job_id: Job ID returned by submit_render_job()
        timeout_s:     Maximum seconds to wait
        on_progress:   Optional callback called after each status poll

    Returns final status dict from get_job_status().
    """
    deadline = time.time() + timeout_s
    terminal = {"COMPLETED", "FAILED", "CANCELLED"}

    while time.time() < deadline:
        status = get_job_status(runpod_job_id)
        log.info(f"[runpod] Job {runpod_job_id} → {status['status']}")

        if on_progress:
            try:
                on_progress(status)
            except Exception:
                pass

        if status["status"] in terminal:
            return status

        time.sleep(POLL_INTERVAL_S)

    return {
        "runpod_job_id": runpod_job_id,
        "status":        "FAILED",
        "output":        None,
        "error":         f"Timed out after {timeout_s}s waiting for render job",
    }


# ── Endpoint health check ──────────────────────────────────────────────────────

def check_endpoint_health() -> dict:
    """
    Verify the RunPod endpoint is configured and available.

    Returns:
    {
        "configured":    bool,   # env vars set
        "reachable":     bool,   # API responded
        "endpoint_id":   str,
        "worker_count":  int | None,
        "queue_depth":   int | None,
        "error":         str | None,
    }
    """
    try:
        eid = _endpoint_id()
        _api_key()  # will raise if not set
    except RuntimeError as e:
        return {"configured": False, "reachable": False, "endpoint_id": "", "error": str(e)}

    try:
        url = f"{RUNPOD_API_BASE}/{eid}/health"
        with httpx.Client(timeout=10) as client:
            resp = client.get(url, headers=_headers())
            resp.raise_for_status()
            data = resp.json()

        return {
            "configured":   True,
            "reachable":    True,
            "endpoint_id":  eid,
            "worker_count": data.get("workers", {}).get("running"),
            "queue_depth":  data.get("jobs", {}).get("inQueue"),
            "error":        None,
        }
    except httpx.HTTPStatusError as e:
        return {
            "configured":  True,
            "reachable":   False,
            "endpoint_id": eid,
            "error":       f"HTTP {e.response.status_code}: {e.response.text[:200]}",
        }
    except Exception as e:
        return {
            "configured":  True,
            "reachable":   False,
            "endpoint_id": eid,
            "error":       str(e),
        }


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
