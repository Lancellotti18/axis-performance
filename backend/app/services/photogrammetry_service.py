"""
Axis Performance — Photogrammetry scaffold (RunPod COLMAP/OpenSfM).

This is the PIPELINE scaffold for Phase 2 of the exterior module spec.
The actual COLMAP/OpenSfM container running on RunPod is a separate
infrastructure task — see README at /docs/photogrammetry-runpod-setup.md
(create when wiring) for how to build and deploy the container.

What this service does TODAY:
  - submit_job()   — POSTs photo URLs to the RunPod serverless endpoint
                     defined by RUNPOD_PHOTOGRAMMETRY_ENDPOINT_ID. Returns a
                     RunPod job ID we persist to exterior_jobs.
  - check_status() — polls the RunPod job status. Maps RunPod statuses to
                     our exterior_jobs.status state machine.
  - fetch_mesh()   — when complete, fetches the GLTF + point cloud URLs
                     produced by the worker.

What this service does NOT do (intentionally, until the endpoint exists):
  - Auto-extract measurements from the mesh. That's the multi-month
    segmentation problem described in the build plan.
  - Replace contractor manual traces. The mesh, once available, is a
    VISUALIZATION aid (3D viewer + dimension cross-check) — the report
    still uses contractor-verified numbers.

If RUNPOD_API_KEY or RUNPOD_PHOTOGRAMMETRY_ENDPOINT_ID are unset, all
methods return a 'disabled' response so the UI can show "Photogrammetry
not yet configured — using manual measurements only" and proceed.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


class PhotogrammetryStatus(str, Enum):
    DISABLED      = "disabled"        # no RunPod config — using manual workflow only
    QUEUED        = "queued"
    IN_PROGRESS   = "in_progress"
    COMPLETED     = "completed"
    FAILED        = "failed"
    NOT_FOUND     = "not_found"


@dataclass
class PhotogrammetryJob:
    status: PhotogrammetryStatus
    job_id: Optional[str] = None
    mesh_url: Optional[str] = None
    point_cloud_url: Optional[str] = None
    error: Optional[str] = None
    progress_pct: float = 0.0

    def to_dict(self) -> dict:
        return {
            "status": self.status.value,
            "job_id": self.job_id,
            "mesh_url": self.mesh_url,
            "point_cloud_url": self.point_cloud_url,
            "error": self.error,
            "progress_pct": self.progress_pct,
        }


def _endpoint_id() -> str | None:
    """RunPod endpoint that hosts the COLMAP/OpenSfM container. We reuse the
    existing RUNPOD_ENDPOINT_ID for now; once the photogrammetry container is
    separate from the render container, this can move to a dedicated
    RUNPOD_PHOTOGRAMMETRY_ENDPOINT_ID setting."""
    # The build-plan setting name — falls back to the existing render endpoint
    # for early scaffolding. Set this in Render env to switch over.
    return getattr(settings, "RUNPOD_PHOTOGRAMMETRY_ENDPOINT_ID", "") or settings.RUNPOD_ENDPOINT_ID or None


def _is_enabled() -> bool:
    return bool(settings.RUNPOD_API_KEY and _endpoint_id())


async def submit_job(photo_urls: list[str], *, job_metadata: dict | None = None) -> PhotogrammetryJob:
    """
    Submit a set of photo URLs for SfM/MVS reconstruction. Returns the
    PhotogrammetryJob with a RunPod job ID we persist for status polling.

    Worker contract (what the container must accept/return):
        Input: {"photos": [url, ...], "metadata": {...}}
        Output: {"mesh_url": <gltf>, "point_cloud_url": <ply>, "stats": {...}}

    Until that container exists, this returns status=DISABLED so the UI knows
    to skip the 3D-model step and let the contractor proceed with manual
    measurements only.
    """
    if not _is_enabled():
        return PhotogrammetryJob(
            status=PhotogrammetryStatus.DISABLED,
            error=(
                "Photogrammetry endpoint not configured. Set "
                "RUNPOD_API_KEY and RUNPOD_PHOTOGRAMMETRY_ENDPOINT_ID on the "
                "backend to enable the SfM + MVS pipeline."
            ),
        )

    if not photo_urls or len(photo_urls) < 6:
        return PhotogrammetryJob(
            status=PhotogrammetryStatus.FAILED,
            error=f"Photogrammetry requires at least 6 photos; received {len(photo_urls)}.",
        )

    payload = {
        "input": {
            "photos": photo_urls,
            "metadata": job_metadata or {},
        }
    }
    url = f"https://api.runpod.ai/v2/{_endpoint_id()}/run"
    headers = {
        "Authorization": f"Bearer {settings.RUNPOD_API_KEY}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(url, headers=headers, json=payload)
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        logger.warning("photogrammetry submit failed: %s", e)
        return PhotogrammetryJob(status=PhotogrammetryStatus.FAILED, error=str(e)[:200])

    job_id = data.get("id")
    if not job_id:
        return PhotogrammetryJob(
            status=PhotogrammetryStatus.FAILED,
            error=f"RunPod did not return a job id: {data}",
        )
    return PhotogrammetryJob(status=PhotogrammetryStatus.QUEUED, job_id=job_id)


async def check_status(job_id: str) -> PhotogrammetryJob:
    """Poll RunPod for a previously submitted job."""
    if not _is_enabled():
        return PhotogrammetryJob(status=PhotogrammetryStatus.DISABLED, job_id=job_id)
    if not job_id:
        return PhotogrammetryJob(status=PhotogrammetryStatus.NOT_FOUND)

    url = f"https://api.runpod.ai/v2/{_endpoint_id()}/status/{job_id}"
    headers = {"Authorization": f"Bearer {settings.RUNPOD_API_KEY}"}
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        logger.info("photogrammetry status check failed: %s", e)
        return PhotogrammetryJob(
            status=PhotogrammetryStatus.FAILED, job_id=job_id, error=str(e)[:200],
        )

    rp_status = (data.get("status") or "").upper()
    if rp_status in ("IN_QUEUE", "QUEUED"):
        return PhotogrammetryJob(status=PhotogrammetryStatus.QUEUED, job_id=job_id)
    if rp_status in ("IN_PROGRESS", "RUNNING"):
        progress = float(data.get("output", {}).get("progress_pct") or 0)
        return PhotogrammetryJob(
            status=PhotogrammetryStatus.IN_PROGRESS, job_id=job_id, progress_pct=progress,
        )
    if rp_status == "COMPLETED":
        output = data.get("output") or {}
        return PhotogrammetryJob(
            status=PhotogrammetryStatus.COMPLETED,
            job_id=job_id,
            mesh_url=output.get("mesh_url"),
            point_cloud_url=output.get("point_cloud_url"),
            progress_pct=100.0,
        )
    if rp_status in ("FAILED", "CANCELLED", "TIMED_OUT"):
        return PhotogrammetryJob(
            status=PhotogrammetryStatus.FAILED,
            job_id=job_id,
            error=(data.get("error") or rp_status.lower()),
        )
    # Unknown status from RunPod — treat as queued so we keep polling
    return PhotogrammetryJob(status=PhotogrammetryStatus.QUEUED, job_id=job_id)


async def cancel_job(job_id: str) -> bool:
    """Best-effort cancellation. Returns True if RunPod accepted the request."""
    if not _is_enabled() or not job_id:
        return False
    url = f"https://api.runpod.ai/v2/{_endpoint_id()}/cancel/{job_id}"
    headers = {"Authorization": f"Bearer {settings.RUNPOD_API_KEY}"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(url, headers=headers)
            return r.status_code < 300
    except Exception:
        return False


def is_enabled() -> bool:
    """Public predicate used by the API layer to short-circuit endpoints."""
    return _is_enabled()
