"""
Axis Performance — Satellite imagery enhancement (Real-ESRGAN super-resolution).

Adds visual sharpness to satellite tiles via AI upscaling. Honest about what
it is: the upscaled image has plausible-looking detail, NOT additional real
detail. Use for visualization (sharper edges when tracing facets, cleaner
PDF cover photos). DON'T use for measurement — the math is still done from
the original tile's metres-per-pixel.

Provider: Replicate (nightmareai/real-esrgan). Free tier available; paid
usage is ~$0.0005/image. Requires REPLICATE_API_KEY in settings.

If REPLICATE_API_KEY is unset, the function returns the original image bytes
unchanged with a 'disabled' status so the UI can show "Sharpen disabled —
configure REPLICATE_API_KEY" without breaking.
"""
from __future__ import annotations

import base64
import logging
from dataclasses import dataclass
from enum import Enum
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


REPLICATE_BASE = "https://api.replicate.com/v1"
# Real-ESRGAN x4plus — proven model, fast, good for satellite imagery.
# Using the official models endpoint (no version pin) so we always get the
# current production version. Replicate has deprecated/rotated specific
# version ids before, leading to status=failed on otherwise-fine requests.
REAL_ESRGAN_MODEL = "nightmareai/real-esrgan"


class EnhancementStatus(str, Enum):
    DISABLED = "disabled"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class EnhancementResult:
    status: EnhancementStatus
    upscaled_url: Optional[str] = None
    upscaled_bytes: Optional[bytes] = None
    upscaled_media_type: Optional[str] = None
    error: Optional[str] = None
    scale_factor: int = 4
    original_size_kb: Optional[int] = None
    upscaled_size_kb: Optional[int] = None

    def to_dict(self, include_bytes: bool = False) -> dict:
        d = {
            "status": self.status.value,
            "upscaled_url": self.upscaled_url,
            "scale_factor": self.scale_factor,
            "original_size_kb": self.original_size_kb,
            "upscaled_size_kb": self.upscaled_size_kb,
            "error": self.error,
            "honesty_note": (
                "AI super-resolution adds plausible-looking detail. The upscaled image "
                "is for visualization only — measurements use the original tile's known "
                "metres-per-pixel scale."
            ),
        }
        if include_bytes and self.upscaled_bytes:
            d["upscaled_base64"] = base64.b64encode(self.upscaled_bytes).decode("ascii")
            d["upscaled_media_type"] = self.upscaled_media_type or "image/png"
        return d


def is_enabled() -> bool:
    return bool(settings.REPLICATE_API_KEY)


async def upscale_image(
    image_bytes: bytes,
    media_type: str = "image/png",
    *,
    scale: int = 4,
    face_enhance: bool = False,
) -> EnhancementResult:
    """
    Send a satellite tile to Replicate's Real-ESRGAN and return the 4×
    upscaled version. Total round-trip ~3-8 seconds.

    Args:
        image_bytes: raw image bytes from the imagery service
        media_type: 'image/png' or 'image/jpeg'
        scale: 2 or 4 (4 is much sharper, 2 is faster)
        face_enhance: usually False for satellite imagery

    Returns EnhancementResult with the upscaled image bytes (or 'disabled'
    status if REPLICATE_API_KEY isn't set).
    """
    if not is_enabled():
        return EnhancementResult(
            status=EnhancementStatus.DISABLED,
            error=(
                "Real-ESRGAN upscaler not configured. Set REPLICATE_API_KEY on "
                "the backend to enable the Sharpen feature. Free tier available "
                "at replicate.com."
            ),
        )

    if not image_bytes:
        return EnhancementResult(
            status=EnhancementStatus.FAILED,
            error="No image bytes supplied to upscaler.",
        )

    original_size_kb = round(len(image_bytes) / 1024)

    # Replicate accepts the image as a data URI
    b64 = base64.b64encode(image_bytes).decode("ascii")
    data_uri = f"data:{media_type};base64,{b64}"

    payload = {
        "input": {
            "image": data_uri,
            "scale": scale,
            "face_enhance": face_enhance,
        },
    }
    headers = {
        "Authorization": f"Bearer {settings.REPLICATE_API_KEY}",
        "Content-Type": "application/json",
        # Wait for completion synchronously (Replicate's Prefer header)
        "Prefer": "wait=60",
    }

    # Use the model-name endpoint so Replicate auto-picks the current version.
    # Falls back to versioned /predictions if the model endpoint 404s.
    model_url = f"{REPLICATE_BASE}/models/{REAL_ESRGAN_MODEL}/predictions"
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(model_url, headers=headers, json=payload)
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPStatusError as http_err:
        # Surface Replicate's error body when available so the contractor sees
        # something actionable instead of a bare status code.
        body = ""
        try:
            body = http_err.response.text[:500]
        except Exception:
            pass
        logger.warning("Real-ESRGAN HTTP error: %s | body=%s", http_err, body)
        return EnhancementResult(
            status=EnhancementStatus.FAILED,
            error=f"Replicate {http_err.response.status_code}: {body or str(http_err)[:200]}",
        )
    except Exception as e:
        logger.warning("Real-ESRGAN call failed: %s", e)
        return EnhancementResult(
            status=EnhancementStatus.FAILED, error=str(e)[:300],
        )

    # Replicate returns prediction status + output
    status = (data.get("status") or "").lower()
    if status != "succeeded":
        # If still processing, poll briefly
        pred_id = data.get("id")
        if pred_id and status in ("starting", "processing"):
            polled = await _poll_until_done(pred_id, max_wait_sec=60)
            data = polled or data
            status = (data.get("status") or "").lower()

    if status != "succeeded":
        # Replicate's response body has the actual error reason when status=failed
        reason = data.get("error") or data.get("logs") or ""
        if isinstance(reason, str) and len(reason) > 300:
            reason = reason[-300:]   # tail is usually the useful traceback line
        return EnhancementResult(
            status=EnhancementStatus.FAILED,
            error=f"Replicate {status}: {reason or 'no error detail returned'}",
        )

    output_url = data.get("output")
    if isinstance(output_url, list):
        output_url = output_url[0] if output_url else None
    if not output_url:
        return EnhancementResult(
            status=EnhancementStatus.FAILED,
            error="Replicate did not return an output URL.",
        )

    # Download the upscaled image
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(output_url, follow_redirects=True)
            r.raise_for_status()
            upscaled_bytes = r.content
            upscaled_mt = (r.headers.get("content-type") or "image/png").split(";")[0].strip()
    except Exception as e:
        logger.info("Could not download upscaled image: %s", e)
        # Still return URL even if we can't fetch
        return EnhancementResult(
            status=EnhancementStatus.COMPLETED,
            upscaled_url=output_url,
            scale_factor=scale,
            original_size_kb=original_size_kb,
        )

    return EnhancementResult(
        status=EnhancementStatus.COMPLETED,
        upscaled_url=output_url,
        upscaled_bytes=upscaled_bytes,
        upscaled_media_type=upscaled_mt,
        scale_factor=scale,
        original_size_kb=original_size_kb,
        upscaled_size_kb=round(len(upscaled_bytes) / 1024),
    )


async def _poll_until_done(prediction_id: str, *, max_wait_sec: int = 60) -> Optional[dict]:
    """Poll a Replicate prediction until it finishes or we hit the timeout."""
    import asyncio
    headers = {"Authorization": f"Bearer {settings.REPLICATE_API_KEY}"}
    deadline = max_wait_sec
    interval = 1.0
    elapsed = 0.0
    async with httpx.AsyncClient(timeout=30) as client:
        while elapsed < deadline:
            try:
                r = await client.get(
                    f"{REPLICATE_BASE}/predictions/{prediction_id}", headers=headers,
                )
                r.raise_for_status()
                data = r.json()
                status = (data.get("status") or "").lower()
                if status in ("succeeded", "failed", "canceled"):
                    return data
            except Exception:
                return None
            await asyncio.sleep(interval)
            elapsed += interval
            interval = min(2.0, interval * 1.5)
    return None
