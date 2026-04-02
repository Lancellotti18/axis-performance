"""
visualizer_service.py — AI Home Visualizer
===========================================
1. Accepts a property photo + text description of desired changes
2. Generates an AI image via Replicate SDXL img2img (structure-preserving)
3. Produces a line-item cost estimate via Tavily research + Claude analysis
4. Returns generated image URL + cost breakdown with real sourced pricing
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
import logging

import httpx
from anthropic import Anthropic
from app.core.config import settings

log = logging.getLogger(__name__)

REPLICATE_API = "https://api.replicate.com/v1"
# SDXL — best quality img2img on Replicate
SDXL_MODEL = "stability-ai/sdxl"


# ── Replicate helpers ─────────────────────────────────────────────────────────

async def _get_sdxl_version() -> str:
    """Fetch latest SDXL version hash from Replicate."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{REPLICATE_API}/models/{SDXL_MODEL}",
            headers={"Authorization": f"Token {settings.REPLICATE_API_KEY}"},
        )
        r.raise_for_status()
        return r.json()["latest_version"]["id"]


async def _upload_image_to_replicate(image_bytes: bytes, content_type: str) -> str:
    """
    Upload image to Replicate's file hosting so it gets a stable CDN URL.
    More reliable than data URIs for large images.
    """
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            f"{REPLICATE_API}/files",
            headers={
                "Authorization": f"Token {settings.REPLICATE_API_KEY}",
            },
            files={"content": ("image", image_bytes, content_type)},
        )
        r.raise_for_status()
        return r.json()["urls"]["get"]


async def _create_prediction(version: str, input_data: dict) -> str:
    """Submit prediction. Returns prediction ID."""
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{REPLICATE_API}/predictions",
            headers={
                "Authorization": f"Token {settings.REPLICATE_API_KEY}",
                "Content-Type": "application/json",
            },
            json={"version": version, "input": input_data},
        )
        r.raise_for_status()
        return r.json()["id"]


async def _poll_prediction(prediction_id: str, timeout_s: int = 240) -> str:
    """Poll until prediction completes. Returns output image URL."""
    start = asyncio.get_event_loop().time()
    async with httpx.AsyncClient(timeout=15) as client:
        while asyncio.get_event_loop().time() - start < timeout_s:
            r = await client.get(
                f"{REPLICATE_API}/predictions/{prediction_id}",
                headers={"Authorization": f"Token {settings.REPLICATE_API_KEY}"},
            )
            data = r.json()
            status = data.get("status")
            if status == "succeeded":
                output = data.get("output", [])
                if isinstance(output, list) and output:
                    return output[-1]  # last output = highest quality
                if isinstance(output, str):
                    return output
                raise ValueError("Prediction succeeded but no output image returned.")
            if status == "failed":
                raise ValueError(f"Image generation failed: {data.get('error', 'Unknown error')}")
            if status == "canceled":
                raise ValueError("Image generation was canceled.")
            await asyncio.sleep(4)
    raise TimeoutError("Image generation timed out after 4 minutes.")


# ── Prompt builder ────────────────────────────────────────────────────────────

def _build_prompts(description: str) -> tuple[str, str]:
    """
    Build SDXL positive + negative prompts for exterior home renovation.
    Wraps the user's description in professional photography framing.
    """
    positive = (
        f"photorealistic exterior home renovation, professional architectural photography, "
        f"high resolution 8k, sharp focus, natural daylight, {description}, "
        f"real estate photography style, beautiful curb appeal"
    )
    negative = (
        "blurry, low quality, distorted, warped, unrealistic proportions, cartoon, "
        "anime, painting, sketch, watermark, text overlay, people, vehicles, "
        "interior shot, abstract, oversaturated, ugly"
    )
    return positive, negative


# ── Cost estimate ─────────────────────────────────────────────────────────────

async def _cost_estimate(description: str, city: str, state: str) -> dict:
    """
    Use Tavily to research real pricing + Claude to produce a structured
    line-item cost estimate for the described changes.
    """
    location = ", ".join(filter(None, [city, state])) or "national average"

    research = ""
    if settings.TAVILY_API_KEY:
        from tavily import TavilyClient
        tavily = TavilyClient(api_key=settings.TAVILY_API_KEY)
        queries = [
            f"home exterior {description} cost estimate {location} 2025",
            f"{description} materials labor cost per sqft contractor price",
            f"home renovation {description} {state} average contractor rate 2025",
        ]
        snippets = []
        for q in queries:
            try:
                r = await asyncio.to_thread(
                    tavily.search, query=q, search_depth="basic",
                    max_results=4, include_answer=True
                )
                if r.get("answer"):
                    snippets.append(r["answer"])
                for item in r.get("results", []):
                    content = item.get("content", "")[:400]
                    url = item.get("url", "")
                    if content:
                        snippets.append(f"[Source: {url}] {content}")
            except Exception:
                continue
        research = "\n\n".join(snippets[:9])

    client = Anthropic(api_key=settings.ANTHROPIC_API_KEY)
    prompt = f"""You are a licensed construction cost estimator.

A homeowner wants to make the following exterior changes:
"{description}"

Location: {location}

PRICING RESEARCH:
{research if research else f"No live data available. Use your knowledge of typical {location} contractor rates and 2025 material costs."}

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
    }},
    {{
      "item": "Stone veneer — installation labor",
      "quantity": "200",
      "unit": "sqft",
      "unit_cost_low": 10,
      "unit_cost_mid": 16,
      "unit_cost_high": 24,
      "total_low": 2000,
      "total_mid": 3200,
      "total_high": 4800,
      "source": "RSMeans 2025 Masonry labor"
    }}
  ],
  "total_low": 3600,
  "total_mid": 6000,
  "total_high": 9200,
  "notes": [
    "Permit required for structural changes in most jurisdictions — typically $150–400",
    "Stone veneer best installed above 40°F; avoid rainy season"
  ],
  "location": "{location}",
  "disclaimer": "Estimates based on regional market data. Obtain at least 3 contractor quotes before proceeding."
}}

Rules:
- Split every work item into separate materials and labor line items
- Use realistic quantities for a typical single-family home (assume ~1,800 sqft, standard lot)
- All prices must be grounded in the research data or your verified knowledge of {location} 2025 market rates
- Source field must cite where the price came from (RSMeans 2025, HomeDepot, Lowe's, local contractor avg, etc.)
- Include 2–4 practical notes specific to the work described (permits, seasonal timing, HOA considerations, etc.)
- Totals must equal the sum of line items"""

    response = await asyncio.to_thread(
        lambda: client.messages.create(
            model="claude-opus-4-6",
            max_tokens=2000,
            messages=[{"role": "user", "content": prompt}],
        )
    )
    text = response.content[0].text.strip()
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
    if not settings.REPLICATE_API_KEY:
        raise ValueError(
            "REPLICATE_API_KEY is not configured. "
            "Add it to your environment variables on Render."
        )

    log.info(f"[visualizer] Starting generation for: '{description[:60]}' — {city}, {state}")

    # Run version fetch + image upload + cost estimate concurrently
    version_task  = asyncio.create_task(_get_sdxl_version())
    upload_task   = asyncio.create_task(_upload_image_to_replicate(image_bytes, content_type))
    cost_task     = asyncio.create_task(_cost_estimate(description, city, state))

    version, image_url = await asyncio.gather(version_task, upload_task)
    log.info(f"[visualizer] SDXL version={version[:12]}… image uploaded → {image_url[:60]}…")

    positive_prompt, negative_prompt = _build_prompts(description)

    prediction_id = await _create_prediction(version, {
        "image":              image_url,
        "prompt":             positive_prompt,
        "negative_prompt":    negative_prompt,
        "prompt_strength":    0.65,   # keeps house structure, applies changes
        "num_inference_steps": 40,
        "guidance_scale":     7.5,
        "width":              1024,
        "height":             1024,
        "refine":             "expert_ensemble_refiner",  # SDXL refinement pass
        "high_noise_frac":    0.8,
    })

    log.info(f"[visualizer] Prediction submitted → {prediction_id}")
    generated_url = await _poll_prediction(prediction_id)
    log.info(f"[visualizer] Image ready → {generated_url[:60]}…")

    cost_estimate = await cost_task
    location_str = ", ".join(filter(None, [city, state]))

    return {
        "generated_image_url": generated_url,
        "cost_estimate":       cost_estimate,
        "description":         description,
        "location":            location_str,
    }
