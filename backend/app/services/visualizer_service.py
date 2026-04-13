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

REPLICATE_API = "https://api.replicate.com/v1"
SDXL_MODEL = "stability-ai/sdxl"


# ── Image generation ──────────────────────────────────────────────────────────

async def _generate_image(image_bytes: bytes, content_type: str, description: str) -> str:
    """
    Generate a visualization image.
    Uses instruct-pix2pix (img2img) so the original house shape is preserved.
    Falls back to Replicate SDXL img2img if HF fails.
    """
    hf_key  = _hf_key()
    rep_key = _rep_key()
    log.info(f"[visualizer] HF key present: {bool(hf_key)}, Replicate key: {bool(rep_key)}")

    if hf_key:
        try:
            return await _hf_img2img(image_bytes, description, hf_key)
        except Exception as e:
            log.warning(f"[visualizer] HuggingFace failed: {e}. Trying Replicate...")

    if rep_key:
        return await _replicate_img2img(image_bytes, content_type, description)

    raise ValueError(
        "No image generation key configured. "
        "Set HUGGINGFACE_API_KEY (free at huggingface.co) in your environment."
    )


async def _hf_img2img(image_bytes: bytes, description: str, hf_key: str = "") -> str:
    """
    Use instruct-pix2pix to apply changes to the uploaded photo while preserving
    the original house shape, roofline, and structure.
    Returns a data URI (base64 PNG).
    """
    prompt = (
        f"exterior photo of the same house with {description}, "
        f"same roofline, same windows, same structure, same angle, "
        f"photorealistic, professional real estate photography, sharp focus"
    )

    payload = {
        "inputs": base64.b64encode(image_bytes).decode(),
        "parameters": {
            "prompt": prompt,
            "strength": 0.55,           # 0=identical to original, 1=ignore original; 0.55 changes materials but keeps structure
            "guidance_scale":       8.0,
            "num_inference_steps":  30,
            "negative_prompt": (
                "different house shape, different roofline, blurry, low quality, "
                "distorted, cartoon, painting, watermark, people, text"
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
                except: pass
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
        f"photorealistic exterior home renovation, professional architectural photography, "
        f"high resolution 8k, sharp focus, natural daylight, {description}, "
        f"real estate photography style, beautiful curb appeal"
    )
    negative = (
        "blurry, low quality, distorted, warped, cartoon, anime, painting, "
        "sketch, watermark, text overlay, people, vehicles, interior, abstract"
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

    # Run image generation + cost estimate concurrently
    image_task = asyncio.create_task(_generate_image(image_bytes, content_type, description))
    cost_task  = asyncio.create_task(_cost_estimate(description, city, state))

    generated_url, cost_estimate = await asyncio.gather(image_task, cost_task)
    log.info(f"[visualizer] Done — image ready, cost estimate complete")

    location_str = ", ".join(filter(None, [city, state]))

    return {
        "generated_image_url": generated_url,
        "cost_estimate":       cost_estimate,
        "description":         description,
        "location":            location_str,
    }
