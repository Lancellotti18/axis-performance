"""
renders.py — AI Photorealistic Render Generation
=================================================
Provider priority (first available wins):
  1. Pollinations.ai  — free, no API key required
  2. HuggingFace SDXL — free with HUGGINGFACE_API_KEY
  3. Replicate SDXL   — paid fallback with REPLICATE_API_KEY
"""

from __future__ import annotations

import asyncio
import base64
import logging
import urllib.parse

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core.config import settings
from app.core.supabase import get_supabase

router = APIRouter()
log = logging.getLogger(__name__)

POLLINATIONS_API = "https://image.pollinations.ai/prompt"
HF_API           = "https://api-inference.huggingface.co/models"
HF_T2I_MODEL     = "stabilityai/stable-diffusion-xl-base-1.0"
REPLICATE_API    = "https://api.replicate.com/v1"
SDXL_MODEL       = "stability-ai/sdxl"


class RenderRequest(BaseModel):
    style:       str = "modern"       # modern | traditional | farmhouse | contemporary | craftsman
    time_of_day: str = "golden_hour"  # day | golden_hour | dusk


# ── Prompt builders ───────────────────────────────────────────────────────────

def _build_exterior_prompt(project: dict, analysis: dict, style: str, time_of_day: str) -> str:
    sqft        = analysis.get("total_sqft", 0)
    room_count  = analysis.get("room_count") or len(analysis.get("rooms", []))
    bp_type     = (project.get("blueprint_type") or "residential").replace("_", " ")
    city        = project.get("city", "")
    region      = (project.get("region") or "").replace("US-", "")
    location    = f"{city}, {region}".strip(", ") if city or region else "suburban"
    stories     = "two-story" if sqft and sqft > 2500 else "single-story"

    time_desc = {
        "day":         "bright midday sunlight, clear blue sky",
        "golden_hour": "warm golden hour sunset light, long shadows",
        "dusk":        "dusk twilight, warm interior lights glowing through windows",
    }.get(time_of_day, "golden hour sunlight")

    style_desc = {
        "modern":        "modern architecture, clean lines, large windows, flat or low-pitch roof, minimalist",
        "traditional":   "traditional architecture, symmetrical facade, shutters, pitched gable roof",
        "farmhouse":     "modern farmhouse style, board and batten siding, metal roof, front porch",
        "contemporary":  "contemporary architecture, mixed materials, asymmetric roofline, floor-to-ceiling windows",
        "craftsman":     "craftsman bungalow, tapered columns, covered front porch, exposed rafter tails",
    }.get(style, "modern architecture, clean lines")

    sqft_str = f"{int(sqft):,} square feet, " if sqft else ""
    room_str = f"{room_count} rooms, " if room_count else ""

    return (
        f"Photorealistic architectural exterior render of a {stories} {bp_type} home, "
        f"{style_desc}, {sqft_str}{room_str}located in {location}. "
        f"Beautifully landscaped front yard with green lawn, mature trees, concrete driveway. "
        f"Photographed from a slight angle showing front and side elevation. "
        f"{time_desc.capitalize()}. "
        f"Ultra-high quality architectural photography, 8K resolution, photorealistic, "
        f"professional real estate photography, no people, sharp focus, wide angle lens."
    )


def _build_interior_prompt(project: dict, analysis: dict, style: str) -> str:
    sqft    = analysis.get("total_sqft", 0)
    rooms   = analysis.get("rooms", [])
    bp_type = (project.get("blueprint_type") or "residential").replace("_", " ")

    living_room = next(
        (r for r in rooms if any(k in (r.get("name") or "").lower()
         for k in ["living", "great room", "family", "lounge"])),
        None,
    )
    room_sqft = int(living_room.get("sqft", 0)) if living_room else (int(sqft * 0.18) if sqft else 300)

    style_desc = {
        "modern":       "modern interior design, minimalist, neutral palette, clean lines, recessed lighting",
        "traditional":  "traditional interior, crown molding, warm wood tones, classic furniture",
        "farmhouse":    "modern farmhouse interior, shiplap walls, open shelving, warm neutral tones",
        "contemporary": "contemporary interior, open plan, statement lighting, mixed textures",
        "craftsman":    "craftsman interior, built-in bookshelves, warm wood trim, mission-style furniture",
    }.get(style, "modern interior design, minimalist, neutral palette")

    return (
        f"Photorealistic interior render of a {bp_type} living room, "
        f"{style_desc}, approximately {room_sqft} square feet, "
        f"large windows with natural light flooding in, hardwood floors, "
        f"high ceilings, tasteful furniture and decor. "
        f"Ultra-high quality architectural interior photography, 8K resolution, photorealistic, "
        f"designed by top interior designer, no people, sharp focus, wide angle lens."
    )


# ── Image generation ──────────────────────────────────────────────────────────

NEGATIVE_PROMPT = (
    "blurry, low quality, distorted, warped, cartoon, anime, painting, sketch, "
    "watermark, text overlay, people, vehicles, abstract, render artifacts"
)


async def _generate_via_pollinations(prompt: str) -> str:
    """
    Pollinations.ai — free, no API key required.
    Returns a data URI (downloads the image bytes so it works cross-origin).
    """
    params = {
        "width": 1280,
        "height": 720,
        "model": "flux",
        "seed": 42,
        "nologo": "true",
    }
    query = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{POLLINATIONS_API}/{urllib.parse.quote(prompt)}?{query}"

    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        r = await client.get(url)
        r.raise_for_status()
        if not r.content or len(r.content) < 1000:
            raise ValueError("Pollinations returned empty or too-small image")
        return "data:image/jpeg;base64," + base64.b64encode(r.content).decode()


async def _generate_via_hf(prompt: str) -> str:
    """HuggingFace SDXL text-to-image. Returns base64 data URI."""
    headers = {
        "Authorization": f"Bearer {settings.HUGGINGFACE_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "inputs": prompt,
        "parameters": {
            "negative_prompt":    NEGATIVE_PROMPT,
            "num_inference_steps": 30,
            "guidance_scale":     7.5,
            "width":              1024,
            "height":             576,
        },
    }
    async with httpx.AsyncClient(timeout=120) as client:
        for attempt in range(3):
            r = await client.post(f"{HF_API}/{HF_T2I_MODEL}", headers=headers, json=payload)
            if r.status_code == 503:
                wait = 20
                try:
                    wait = r.json().get("estimated_time", 20)
                except Exception:
                    pass
                log.info(f"[Renders] HF model loading, waiting {wait}s...")
                await asyncio.sleep(min(wait, 30))
                continue
            r.raise_for_status()
            return "data:image/png;base64," + base64.b64encode(r.content).decode()
    raise TimeoutError("HuggingFace model did not load after 3 attempts.")


async def _generate_via_replicate(prompt: str) -> str:
    """Replicate SDXL text-to-image. Returns image URL."""
    auth = {"Authorization": f"Token {settings.REPLICATE_API_KEY}", "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{REPLICATE_API}/models/{SDXL_MODEL}", headers=auth)
        r.raise_for_status()
        version = r.json()["latest_version"]["id"]

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{REPLICATE_API}/predictions",
            headers=auth,
            json={
                "version": version,
                "input": {
                    "prompt":              prompt,
                    "negative_prompt":     NEGATIVE_PROMPT,
                    "num_inference_steps": 40,
                    "guidance_scale":      7.5,
                    "width":               1024,
                    "height":              576,
                    "refine":              "expert_ensemble_refiner",
                    "high_noise_frac":     0.8,
                },
            },
        )
        r.raise_for_status()
        prediction_id = r.json()["id"]

    async with httpx.AsyncClient(timeout=15) as client:
        start = asyncio.get_event_loop().time()
        while asyncio.get_event_loop().time() - start < 240:
            r = await client.get(f"{REPLICATE_API}/predictions/{prediction_id}", headers=auth)
            data = r.json()
            status = data.get("status")
            if status == "succeeded":
                output = data.get("output", [])
                return output[-1] if isinstance(output, list) else output
            if status in ("failed", "canceled"):
                raise ValueError(f"Replicate {status}: {data.get('error')}")
            await asyncio.sleep(4)
    raise TimeoutError("Replicate generation timed out.")


async def _generate_image(prompt: str) -> str | None:
    """Try Pollinations (free/no key) → HF → Replicate. Returns data URI / URL, or None."""
    try:
        return await _generate_via_pollinations(prompt)
    except Exception as e:
        log.warning(f"[Renders] Pollinations failed: {e} — trying HuggingFace...")

    if settings.HUGGINGFACE_API_KEY:
        try:
            return await _generate_via_hf(prompt)
        except Exception as e:
            log.warning(f"[Renders] HuggingFace failed: {e} — trying Replicate...")

    if settings.REPLICATE_API_KEY:
        try:
            return await _generate_via_replicate(prompt)
        except Exception as e:
            log.warning(f"[Renders] Replicate failed: {e}")

    return None


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/{project_id}/generate")
async def generate_renders(project_id: str, request: RenderRequest):

    db = get_supabase()

    proj_row = db.table("projects").select("*").eq("id", project_id).limit(1).execute()
    if not proj_row.data:
        raise HTTPException(status_code=404, detail="Project not found.")
    project = proj_row.data[0]

    bp_row = db.table("blueprints").select("id").eq("project_id", project_id)\
               .order("created_at", desc=True).limit(1).execute()
    analysis = {}
    if bp_row.data:
        an_row = db.table("analyses").select("*")\
                   .eq("blueprint_id", bp_row.data[0]["id"]).limit(1).execute()
        if an_row.data:
            analysis = an_row.data[0]

    exterior_prompt = _build_exterior_prompt(project, analysis, request.style, request.time_of_day)
    interior_prompt = _build_interior_prompt(project, analysis, request.style)

    # Generate both renders concurrently
    exterior_img, interior_img = await asyncio.gather(
        _generate_image(exterior_prompt),
        _generate_image(interior_prompt),
    )

    if not exterior_img and not interior_img:
        raise HTTPException(
            status_code=500,
            detail=(
                "Image generation failed. "
                "Check that HUGGINGFACE_API_KEY or REPLICATE_API_KEY is set correctly in Railway."
            ),
        )

    return {
        "exterior":    exterior_img,
        "interior":    interior_img,
        "prompts":     {"exterior": exterior_prompt, "interior": interior_prompt},
        "style":       request.style,
        "time_of_day": request.time_of_day,
        "provider":    "pollinations" if not settings.HUGGINGFACE_API_KEY else "huggingface",
    }
