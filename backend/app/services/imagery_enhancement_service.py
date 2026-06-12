"""
Axis Performance — Satellite imagery enhancement (SUPIR super-resolution).

Adds visual sharpness to satellite tiles via AI upscaling. Honest about what
it is: the upscaled image has plausible-looking detail, NOT additional real
detail. Use for visualization (sharper edges when tracing facets, cleaner
PDF cover photos). DON'T use for measurement — the math is still done from
the original tile's metres-per-pixel.

Provider: Replicate (lucataco/supir, primary; nightmareai/real-esrgan
fallback). SUPIR is ~$0.05-0.15/image and recovers real detail; Real-ESRGAN
is ~$0.0005/image and only handles cases where SUPIR fails. Requires
REPLICATE_API_KEY in settings.

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
# SUPIR (Scaling Up to Excellence in Practical Image Restoration) — true
# detail-recovery super-resolution. Unlike clarity-upscaler which does
# color/HDR enhancement, SUPIR actually recovers real edge and texture
# detail without hallucinating fake buildings. Based on SDXL + restoration
# adapters. Slower (~60-90 sec) but much more visible result.
#
# Cost: ~$0.05-0.15 per image on Replicate (vs clarity's ~$0.02-0.05).
# Worth it for the actual detail improvement.
UPSCALER_MODEL = "lucataco/supir"
# Real-ESRGAN fallback — used when SUPIR fails (model unavailable,
# Replicate-side error, etc.). Smaller-input + scale=2 to survive their
# shared-GPU OOM behavior. ~$0.005/image.
FALLBACK_MODEL = "nightmareai/real-esrgan"
FALLBACK_MAX_INPUT_PIXELS = 1_000_000
FALLBACK_SCALE = 2

# SUPIR handles tiling internally — can take larger inputs than Real-ESRGAN.
# We keep the 4M pixel cap to bound network roundtrip + Replicate compute time.
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
    Send a satellite tile to Replicate's SUPIR and return the 4× upscaled
    version. SUPIR round-trip is ~60-120 seconds (SDXL inference); falls back
    to Real-ESRGAN (~3-8 s) on SUPIR failure.

    Args:
        image_bytes: raw image bytes from the imagery service
        media_type: 'image/png' or 'image/jpeg'
        scale: 2 or 4 (4 is much sharper, 2 is faster)
        face_enhance: legacy Real-ESRGAN flag — ignored by SUPIR

    Returns EnhancementResult with the upscaled image bytes (or 'disabled'
    status if REPLICATE_API_KEY isn't set).
    """
    if not is_enabled():
        return EnhancementResult(
            status=EnhancementStatus.DISABLED,
            error=(
                "AI upscaler not configured. Set REPLICATE_API_KEY on the "
                "backend to enable the Sharpen feature."
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

    # SUPIR parameters tuned for satellite imagery. Different schema than
    # clarity-upscaler. Key params:
    #   - upscale: scale factor (2 or 4 — 4 for visible detail)
    #   - s_cfg: classifier-free guidance scale (3-5 for satellite — lower =
    #     stays closer to original, higher = more creative)
    #   - s_stage2: restoration strength (1.0 = full restoration)
    #   - s_stage1: pre-restoration scaling (-1 = automatic)
    #   - color_fix_type: "Wavelet" preserves real colors better than "AdaIn"
    #   - model_select: "v0Q" for quality (vs "v0F" for fast — we want quality)
    #   - num_inference_steps: 30-50 (more = better but slower)
    input_payload = {
        "image": data_uri,
        "upscale": scale,
        "s_cfg": 3.5,
        "s_stage1": -1,
        "s_stage2": 1.0,
        "s_churn": 5,
        "s_noise": 1.003,
        "color_fix_type": "Wavelet",
        "model_select": "v0Q",
        "num_inference_steps": 40,
        "linear_CFG": True,
        "linear_s_stage2": False,
        "spt_linear_CFG": 1.0,
        "spt_linear_s_stage2": 0.0,
        "prompt": "high-resolution aerial satellite photograph of residential property, crisp roof shingles, sharp tree foliage, clear concrete details, professional quality, photorealistic",
        "a_prompt": "Cinematic, High Contrast, highly detailed, taken using a Canon EOS R camera, hyper detailed photo - realistic maximum detail, 32k, Color Grading, ultra HD, extreme meticulous detailing, skin pore detailing, hyper sharpness, perfect without deformations",
        "n_prompt": "painting, oil painting, illustration, drawing, art, sketch, anime, cartoon, CG Style, 3D render, unreal engine, blurring, dirty, messy, worst quality, low quality, frames, watermark, signature, jpeg artifacts, deformed, lowres, over-smooth, hallucinated buildings, fake structures",
    }
    headers = {
        "Authorization": f"Bearer {settings.REPLICATE_API_KEY}",
        "Content-Type": "application/json",
        # Replicate caps Prefer: wait at 60 seconds — anything higher gets
        # a 422 with "Prefer: wait=x must be between 1 and 60". For longer
        # waits we rely on _poll_until_done() (max_wait_sec=180 below).
        "Prefer": "wait=60",
    }

    # Primary: SUPIR. Falls back to Real-ESRGAN if version lookup fails or the
    # prediction errors out — that way the contractor always gets *some*
    # sharpening rather than the original tile.
    data, primary_error = await _try_predict(
        UPSCALER_MODEL, input_payload, headers, "supir",
    )
    if data is None:
        # Fall back to Real-ESRGAN with smaller-input config so it always fits
        # Replicate's shared GPU memory.
        logger.info("supir failed (%s) — falling back to Real-ESRGAN", primary_error)
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
                error=f"Primary (SUPIR) failed: {primary_error}. "
                      f"Fallback (real-esrgan) also failed: {fallback_error}.",
            )

    # Replicate returns prediction status + output
    status = (data.get("status") or "").lower()
    if status != "succeeded":
        # If still processing, poll briefly
        pred_id = data.get("id")
        if pred_id and status in ("starting", "processing"):
            polled = await _poll_until_done(pred_id, max_wait_sec=180)
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
        async with httpx.AsyncClient(timeout=240) as client:
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
    shortcut (SUPIR is one), we have to look up the current version before
    submitting a prediction. Cached in-process so we only fetch once per
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
