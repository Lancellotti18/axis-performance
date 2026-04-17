"""
visualizer_service.py — AI Home Visualizer
===========================================
1. Accepts a property photo + text description of desired changes
2. Generates an AI image via HuggingFace Inference API (free) or Replicate (paid fallback)
3. Produces a line-item cost estimate via web search + LLM analysis
4. Returns generated image URL + cost breakdown with real sourced pricing
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
import logging

import os

import httpx
from app.core.config import settings
from app.services.llm import llm_text
from app.services.search import web_search_multi

log = logging.getLogger(__name__)

# Read keys at call time via os.environ to avoid pydantic-settings startup order issues
def _hf_key() -> str:
    return os.environ.get("HUGGINGFACE_API_KEY") or settings.HUGGINGFACE_API_KEY or ""

def _rep_key() -> str:
    return os.environ.get("REPLICATE_API_KEY") or settings.REPLICATE_API_KEY or ""

HF_API            = "https://router.huggingface.co/hf-inference/models"
# SD v1.5 img2img — preserves house structure while applying requested changes
HF_IMG2IMG_MODEL  = "runwayml/stable-diffusion-v1-5"

REPLICATE_API     = "https://api.replicate.com/v1"
SDXL_MODEL        = "stability-ai/sdxl"


def _gemini_key() -> str:
    return os.environ.get("GEMINI_API_KEY") or getattr(settings, "GEMINI_API_KEY", "") or ""


# ── Image generation ──────────────────────────────────────────────────────────

async def _generate_image(image_bytes: bytes, content_type: str, description: str) -> str:
    """
    Generate a visualization image by EDITING the uploaded photo.
    Provider chain (all img2img — the uploaded photo is always the anchor):
      1. Gemini 2.5 Flash Image — multimodal photo editing, preserves composition
      2. HuggingFace SD v1.5 img2img — preserves house structure
      3. Replicate SDXL img2img — paid fallback

    No text-to-image fallback: if every img2img provider fails we raise,
    because a text-only render would produce an unrelated house.
    """
    gem_key = _gemini_key()
    hf_key  = _hf_key()
    rep_key = _rep_key()
    log.info(f"[visualizer] providers — gemini:{bool(gem_key)} hf:{bool(hf_key)} replicate:{bool(rep_key)}")

    if gem_key:
        try:
            return await _gemini_img2img(image_bytes, content_type, description)
        except Exception as e:
            log.warning(f"[visualizer] Gemini img2img failed: {e}. Trying next provider...")

    if hf_key:
        try:
            return await _hf_img2img(image_bytes, description, hf_key)
        except Exception as e:
            log.warning(f"[visualizer] HuggingFace img2img failed: {e}. Trying next provider...")

    if rep_key:
        try:
            return await _replicate_img2img(image_bytes, content_type, description)
        except Exception as e:
            log.warning(f"[visualizer] Replicate failed: {e}.")

    raise ValueError(
        "Image editing is temporarily unavailable. Please try again in a moment. "
        "We won't fall back to text-only generation because it would produce a different-looking house."
    )


# ── Gemini 2.5 Flash Image (multimodal photo editing) ─────────────────────────

def _gemini_img2img_sync(image_bytes: bytes, mime: str, description: str) -> str:
    """
    Use Gemini 2.5 Flash Image for true photo editing.
    The uploaded image is passed as a multimodal input — the model preserves
    the original composition and applies ONLY the requested changes.
    """
    from google import genai
    from google.genai import types

    prompt = (
        "You are editing this real exterior photo of a house. "
        "Keep the house EXACTLY the same: same roofline, same window layout, same door placement, "
        "same foundation, same yard, same trees, same camera angle, same time of day, same lighting. "
        f"Apply ONLY this change: {description}. "
        "Output a photorealistic real-estate photograph of the SAME house with just that change applied. "
        "Do not invent a new house. Do not move the camera. Do not change the composition."
    )

    MODELS = [
        "gemini-2.5-flash-image",
        "gemini-2.0-flash-preview-image-generation",
        "gemini-2.0-flash-exp-image-generation",
    ]

    client     = genai.Client(api_key=_gemini_key())
    image_part = types.Part.from_bytes(data=image_bytes, mime_type=mime or "image/jpeg")

    last_err: Exception = ValueError("No models tried")
    for model in MODELS:
        try:
            response = client.models.generate_content(
                model=model,
                contents=[prompt, image_part],
                config=types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"]),
            )
            for part in response.candidates[0].content.parts:
                if part.inline_data is not None:
                    out_mime = part.inline_data.mime_type or "image/jpeg"
                    encoded  = base64.b64encode(part.inline_data.data).decode("ascii")
                    return f"data:{out_mime};base64,{encoded}"
            last_err = ValueError(f"{model}: no image parts in response")
        except Exception as e:
            last_err = e
            log.warning(f"[visualizer] Gemini {model!r}: {e}")
    raise last_err


async def _gemini_img2img(image_bytes: bytes, content_type: str, description: str) -> str:
    return await asyncio.wait_for(
        asyncio.to_thread(_gemini_img2img_sync, image_bytes, content_type, description),
        timeout=60,
    )


async def _hf_img2img(image_bytes: bytes, description: str, hf_key: str = "") -> str:
    """
    Use instruct-pix2pix to apply changes to the uploaded photo while preserving
    the original house shape, roofline, and structure.
    Returns a data URI (base64 PNG).
    """
    prompt = (
        f"the exact same house photographed from the exact same angle, "
        f"only modification: {description}. "
        f"Identical roofline, identical window placement, identical door placement, "
        f"identical foundation, identical trees and yard. "
        f"Photorealistic, professional real estate photography, sharp focus, natural daylight."
    )

    payload = {
        "inputs": base64.b64encode(image_bytes).decode(),
        "parameters": {
            "prompt": prompt,
            "strength": 0.42,           # 0=identical to original, 1=ignore original; low enough to keep structure
            "guidance_scale":       8.0,
            "num_inference_steps":  30,
            "negative_prompt": (
                "different house, different house shape, different roofline, "
                "different windows, different door, rearranged facade, new building, "
                "blurry, low quality, distorted, cartoon, painting, watermark, people, text"
            ),
        },
    }

    headers = {
        "Authorization": f"Bearer {hf_key or _hf_key()}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=120) as client:
        for attempt in range(3):
            r = await client.post(f"{HF_API}/{HF_IMG2IMG_MODEL}", headers=headers, json=payload)
            if r.status_code == 503:
                wait_time = 20
                try: wait_time = r.json().get("estimated_time", 20)
                except Exception:
                    log.debug("failed to parse HF estimated_time from 503 response", exc_info=True)
                    pass
                log.info(f"[visualizer] HF model loading, waiting {wait_time}s...")
                await asyncio.sleep(min(wait_time, 30))
                continue
            if r.status_code == 410:
                raise ValueError(f"HF model deprecated — contact support: {r.text[:200]}")
            if not r.is_success:
                raise ValueError(f"HF returned {r.status_code}: {r.text[:200]}")
            r.raise_for_status()
            img_b64 = base64.b64encode(r.content).decode()
            return f"data:image/png;base64,{img_b64}"

    raise TimeoutError("HuggingFace model did not load in time.")


# ── Replicate fallback ────────────────────────────────────────────────────────

async def _replicate_img2img(image_bytes: bytes, content_type: str, description: str) -> str:
    """Replicate SDXL img2img — paid fallback."""
    # Get version
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{REPLICATE_API}/models/{SDXL_MODEL}",
            headers={"Authorization": f"Token {settings.REPLICATE_API_KEY}"},
        )
        r.raise_for_status()
        version = r.json()["latest_version"]["id"]

    # Upload image
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            f"{REPLICATE_API}/files",
            headers={"Authorization": f"Token {settings.REPLICATE_API_KEY}"},
            files={"content": ("image", image_bytes, content_type)},
        )
        r.raise_for_status()
        image_url = r.json()["urls"]["get"]

    positive = (
        f"the exact same house photographed from the same angle, "
        f"only modification: {description}. "
        f"Identical roofline, identical window layout, identical door, identical foundation, identical yard. "
        f"Photorealistic, professional architectural photography, high resolution 8k, sharp focus, natural daylight."
    )
    negative = (
        "different house, different house shape, different roofline, different windows, "
        "rearranged facade, new building, blurry, low quality, distorted, warped, "
        "cartoon, anime, painting, sketch, watermark, text overlay, people, vehicles, interior, abstract"
    )

    # Submit prediction
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{REPLICATE_API}/predictions",
            headers={
                "Authorization": f"Token {settings.REPLICATE_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "version": version,
                "input": {
                    "image": image_url,
                    "prompt": positive,
                    "negative_prompt": negative,
                    "prompt_strength": 0.65,
                    "num_inference_steps": 40,
                    "guidance_scale": 7.5,
                    "width": 1024,
                    "height": 1024,
                    "refine": "expert_ensemble_refiner",
                    "high_noise_frac": 0.8,
                },
            },
        )
        r.raise_for_status()
        prediction_id = r.json()["id"]

    # Poll
    start = asyncio.get_event_loop().time()
    async with httpx.AsyncClient(timeout=15) as client:
        while asyncio.get_event_loop().time() - start < 240:
            r = await client.get(
                f"{REPLICATE_API}/predictions/{prediction_id}",
                headers={"Authorization": f"Token {settings.REPLICATE_API_KEY}"},
            )
            data = r.json()
            status = data.get("status")
            if status == "succeeded":
                output = data.get("output", [])
                return output[-1] if isinstance(output, list) else output
            if status in ("failed", "canceled"):
                raise ValueError(f"Replicate generation {status}: {data.get('error')}")
            await asyncio.sleep(4)
    raise TimeoutError("Replicate generation timed out.")


# ── Cost estimate ─────────────────────────────────────────────────────────────

async def _cost_estimate(description: str, city: str, state: str) -> dict:
    location = ", ".join(filter(None, [city, state])) or "national average"

    research = await web_search_multi([
        f"home exterior {description} cost estimate {location} 2025",
        f"{description} materials labor cost per sqft contractor price",
        f"home renovation {description} {state} average contractor rate 2025",
    ], max_results=4)

    prompt = f"""You are a licensed construction cost estimator.

A homeowner wants to make the following exterior changes:
"{description}"

Location: {location}

PRICING RESEARCH:
{research if research else f"Use your knowledge of typical {location} contractor rates and 2025 material costs."}

Return ONLY valid JSON with this exact structure:
{{
  "line_items": [
    {{
      "item": "Stone veneer — materials",
      "quantity": "200",
      "unit": "sqft",
      "unit_cost_low": 8,
      "unit_cost_mid": 14,
      "unit_cost_high": 22,
      "total_low": 1600,
      "total_mid": 2800,
      "total_high": 4400,
      "source": "HomeDepot / RSMeans 2025"
    }}
  ],
  "total_low": 1600,
  "total_mid": 2800,
  "total_high": 4400,
  "notes": ["Permit required for structural changes — typically $150–400"],
  "location": "{location}",
  "disclaimer": "Estimates based on regional market data. Obtain at least 3 contractor quotes."
}}

Rules:
- Split every item into separate materials and labor line items
- Use realistic quantities for a typical single-family home (~1,800 sqft)
- Source field must cite where the price came from
- Include 2–4 practical notes (permits, seasonal timing, HOA, etc.)
- Totals must equal the sum of line items"""

    text = await llm_text(prompt, max_tokens=2000)
    text = text.strip()
    text = re.sub(r'^```(?:json)?\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'\s*```\s*$', '', text)
    start = text.find("{")
    if start > 0:
        text = text[start:]
    return json.loads(text)


# ── Main entry ────────────────────────────────────────────────────────────────

async def generate_visualization(
    image_bytes: bytes,
    content_type: str,
    description: str,
    city: str = "",
    state: str = "",
) -> dict:
    """
    Generate an AI visualization of the requested home changes and a cost estimate.

    Returns:
    {
        generated_image_url: str,
        cost_estimate: { line_items, total_low, total_mid, total_high, notes, ... },
        description: str,
        location: str,
    }
    """
    log.info(f"[visualizer] Starting generation for: '{description[:60]}' — {city}, {state}")

    # Run image generation + cost estimate concurrently.
    # Use return_exceptions=True so a cost estimate failure doesn't kill the image result.
    image_task = asyncio.create_task(_generate_image(image_bytes, content_type, description))
    cost_task  = asyncio.create_task(_cost_estimate(description, city, state))

    results = await asyncio.gather(image_task, cost_task, return_exceptions=True)
    img_result, cost_result = results

    if isinstance(img_result, Exception):
        raise img_result  # image failure is fatal

    generated_url = img_result
    if isinstance(cost_result, Exception):
        log.warning(f"[visualizer] Cost estimate failed (image OK): {cost_result}")
        cost_estimate = None
    else:
        cost_estimate = cost_result

    log.info(f"[visualizer] Done — image ready, cost estimate: {'ok' if cost_estimate else 'unavailable'}")

    location_str = ", ".join(filter(None, [city, state]))

    return {
        "generated_image_url": generated_url,
        "cost_estimate":       cost_estimate,
        "description":         description,
        "location":            location_str,
    }
