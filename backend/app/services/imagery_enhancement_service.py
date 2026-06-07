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
# Clarity-Upscaler — Stable Diffusion-based upscaler with internal tiling.
# Tuned for satellite imagery: low creativity + high resemblance so it
# sharpens existing detail instead of hallucinating buildings or trees.
# Cost: ~$0.02-0.05 per image.
UPSCALER_MODEL = "philz1337x/clarity-upscaler"
# Real-ESRGAN fallback — used when clarity-upscaler fails (model unavailable,
# Replicate-side error, etc.). Smaller-input + scale=2 to survive their
# shared-GPU OOM behavior. ~$0.005/image.
FALLBACK_MODEL = "nightmareai/real-esrgan"
FALLBACK_MAX_INPUT_PIXELS = 1_000_000
FALLBACK_SCALE = 2

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
    input_payload = {
        "image": data_uri,
        "scale_factor": scale,
        "dynamic": 6,
        "resemblance": 1.0,
        "sharpen": 3,
        "num_inference_steps": 18,
        "prompt": "high-resolution aerial satellite photograph, residential property, crisp roof shingles, sharp clear details, professional quality",
        "negative_prompt": "blurry, low quality, watermark, distorted, hallucinated buildings, fake structures, painted texture, cartoon",
        "output_format": "png",
    }
    headers = {
        "Authorization": f"Bearer {settings.REPLICATE_API_KEY}",
        "Content-Type": "application/json",
        # Wait for completion synchronously (Replicate's Prefer header)
        "Prefer": "wait=60",
    }

    # Primary: clarity-upscaler. Falls back to Real-ESRGAN if version lookup
    # fails or the prediction errors out — that way the contractor always gets
    # *some* sharpening rather than the original tile.
    data, primary_error = await _try_predict(
        UPSCALER_MODEL, input_payload, headers, "clarity-upscaler",
    )
    if data is None:
        # Fall back to Real-ESRGAN with smaller-input config so it always fits
        # Replicate's shared GPU memory.
        logger.info("clarity-upscaler failed (%s) — falling back to Real-ESRGAN", primary_error)
        # Resize input further for Real-ESRGAN's tighter memory budget
        re_image_bytes, re_media_type = image_bytes, media_type
        try:
            from PIL import Image as PILImage
            import io as _io, math
            im = PILImage.open(_io.BytesIO(image_bytes))
            w, h = im.size
            if w * h > FALLBACK_MAX_INPUT_PIXELS:
                s = math.sqrt(FALLBACK_MAX_INPUT_PIXELS / float(w * h))
                im = im.resize((int(w * s), int(h * s)), PILImage.Resampling.LANCZOS)
                out = _io.BytesIO()
                im.save(out, format=("PNG" if media_type == "image/png" else "JPEG"), quality=92)
                re_image_bytes = out.getvalue()
        except Exception as e:
            logger.warning("Fallback resize failed: %s", e)
        re_b64 = base64.b64encode(re_image_bytes).decode("ascii")
        re_data_uri = f"data:{re_media_type};base64,{re_b64}"
        re_input = {
            "image": re_data_uri,
            "scale": FALLBACK_SCALE,
            "face_enhance": False,
        }
        data, fallback_error = await _try_predict(
            FALLBACK_MODEL, re_input, headers, "real-esrgan",
        )
        if data is None:
            return EnhancementResult(
                status=EnhancementStatus.FAILED,
                error=f"Primary (clarity-upscaler) failed: {primary_error}. "
                      f"Fallback (real-esrgan) also failed: {fallback_error}.",
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


_VERSION_CACHE: dict[str, str] = {}


async def _try_predict(
    model: str,
    input_payload: dict,
    headers: dict,
    log_name: str,
) -> tuple[dict | None, str | None]:
    """
    Submit a prediction to Replicate using the generic /v1/predictions endpoint
    with a dynamically resolved version id. Returns (response_data, error_message).
    """
    version_id = await _fetch_latest_version(model)
    if not version_id:
        return None, f"Could not resolve latest version of {model}"
    payload = {"version": version_id, "input": input_payload}
    url = f"{REPLICATE_BASE}/predictions"
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(url, headers=headers, json=payload)
            r.raise_for_status()
            return r.json(), None
    except httpx.HTTPStatusError as http_err:
        body = ""
        try:
            body = http_err.response.text[:300]
        except Exception:
            pass
        logger.warning("%s HTTP error: %s | body=%s", log_name, http_err, body)
        return None, f"Replicate {http_err.response.status_code}: {body or 'no body'}"
    except Exception as e:
        logger.warning("%s call failed: %s", log_name, e)
        return None, str(e)[:200]


async def _fetch_latest_version(model: str) -> str | None:
    """
    Resolve a Replicate model's latest version id.

    For models that aren't opted into the /v1/models/{owner}/{name}/predictions
    shortcut (clarity-upscaler is one), we have to look up the current version
    before submitting a prediction. Cached in-process so we only fetch once per
    backend boot (Replicate versions don't change mid-day).
    """
    if model in _VERSION_CACHE:
        return _VERSION_CACHE[model]
    url = f"{REPLICATE_BASE}/models/{model}"
    headers = {"Authorization": f"Bearer {settings.REPLICATE_API_KEY}"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        logger.warning("Replicate model lookup failed for %s: %s", model, e)
        return None
    version_id = (data.get("latest_version") or {}).get("id")
    if version_id:
        _VERSION_CACHE[model] = version_id
    return version_id


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
