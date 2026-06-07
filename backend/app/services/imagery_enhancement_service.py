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
# Clarity-Upscaler — Stable Diffusion-based upscaler with internal tiling that
# handles 4x cleanly without the CUDA OOM that Real-ESRGAN hit. Tuned for
# satellite imagery: low creativity + high resemblance so it sharpens existing
# detail instead of hallucinating buildings or trees that aren't there.
#
# Cost: ~$0.02-0.05 per image (vs Real-ESRGAN's ~$0.005). Worth it given how
# unreliable Real-ESRGAN was on Replicate's shared GPUs.
UPSCALER_MODEL = "philz1337x/clarity-upscaler"

# Clarity-Upscaler handles tiling internally so we can send larger inputs.
# The practical limit is bandwidth + Replicate processing time, not GPU
# memory. 2M pixels is the Esri tile native size — no resize needed.
MAX_INPUT_PIXELS = 4_000_000
DEFAULT_SCALE = 4


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
    scale: int = DEFAULT_SCALE,
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

    # Resize if the source tile exceeds Replicate's GPU memory cap. Esri's
    # default 2048x1366 tile triggers this every time.
    image_bytes, media_type = _resize_to_fit(image_bytes, media_type)

    # Replicate accepts the image as a data URI
    b64 = base64.b64encode(image_bytes).decode("ascii")
    data_uri = f"data:{media_type};base64,{b64}"

    # Clarity-Upscaler parameters tuned for satellite imagery — bumped to
    # produce a VISIBLE enhancement while still preventing fake-building
    # hallucination:
    #   - dynamic: 6 (moderate creativity — visible HDR-like enhancement
    #     without inventing structures)
    #   - resemblance: 1.0 (balanced — close to original but not so
    #     constrained the model can't sharpen edges)
    #   - sharpen: 3 (clear post-process edge sharpening)
    #   - prompt: anchors the model to satellite content
    payload = {
        "input": {
            "image": data_uri,
            "scale_factor": scale,
            "dynamic": 6,
            "resemblance": 1.0,
            "sharpen": 3,
            "num_inference_steps": 18,
            "prompt": "high-resolution aerial satellite photograph, residential property, crisp roof shingles, sharp clear details, professional quality",
            "negative_prompt": "blurry, low quality, watermark, distorted, hallucinated buildings, fake structures, painted texture, cartoon",
            "output_format": "png",
        },
    }
    headers = {
        "Authorization": f"Bearer {settings.REPLICATE_API_KEY}",
        "Content-Type": "application/json",
        # Wait for completion synchronously (Replicate's Prefer header)
        "Prefer": "wait=60",
    }

    # Use the model-name endpoint so Replicate auto-picks the current version.
    model_url = f"{REPLICATE_BASE}/models/{UPSCALER_MODEL}/predictions"
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


def _resize_to_fit(image_bytes: bytes, media_type: str) -> tuple[bytes, str]:
    """
    Downscale the image if it exceeds Replicate's GPU input cap. Preserves
    aspect ratio. If anything goes wrong, return the original bytes — the
    upstream call will still attempt and surface a real error.
    """
    try:
        from PIL import Image as PILImage
        import io as _io
        import math

        img = PILImage.open(_io.BytesIO(image_bytes))
        w, h = img.size
        if w * h <= MAX_INPUT_PIXELS:
            return image_bytes, media_type

        scale = math.sqrt(MAX_INPUT_PIXELS / float(w * h))
        new_w = max(1, int(w * scale))
        new_h = max(1, int(h * scale))

        # Convert palette / RGBA-with-fully-transparent edges to RGB for JPEG;
        # for PNG keep RGBA so transparency survives.
        if media_type == "image/jpeg" and img.mode != "RGB":
            img = img.convert("RGB")
        elif media_type == "image/png" and img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA")

        resized = img.resize((new_w, new_h), PILImage.Resampling.LANCZOS)
        out = _io.BytesIO()
        if media_type == "image/jpeg":
            resized.save(out, format="JPEG", quality=92, optimize=True)
        else:
            resized.save(out, format="PNG", optimize=True)
        new_bytes = out.getvalue()
        logger.info(
            "enhancement: resized %sx%s (%s px) -> %sx%s (%s px) for Replicate input cap",
            w, h, w * h, new_w, new_h, new_w * new_h,
        )
        return new_bytes, media_type
    except Exception as e:
        logger.warning("enhancement: resize failed (%s) — sending original bytes", e)
        return image_bytes, media_type


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
