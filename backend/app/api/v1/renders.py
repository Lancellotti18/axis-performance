"""
renders.py — AI Photorealistic Render Generation
=================================================
Generates:
  • 4 exterior angle views (front, left-side, right-side, rear)
  • Up to 6 per-room interior renders (from blueprint analysis)

Provider priority (first available wins):
  1. Pollinations.ai  — free, no API key required
  2. HuggingFace FLUX — free with HUGGINGFACE_API_KEY
  3. Replicate SDXL   — paid fallback with REPLICATE_API_KEY

Each image uses a unique seed so renders vary on every generation.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import random
import urllib.parse

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core.config import settings
from app.core.supabase import get_supabase

router = APIRouter()
log = logging.getLogger(__name__)

POLLINATIONS_API = "https://image.pollinations.ai/prompt"
HF_API           = "https://router.huggingface.co/hf-inference/models"
HF_T2I_MODEL     = "black-forest-labs/FLUX.1-schnell"
REPLICATE_API    = "https://api.replicate.com/v1"
SDXL_MODEL       = "stability-ai/sdxl"

NEGATIVE_PROMPT = (
    "blurry, low quality, distorted, warped, cartoon, anime, painting, sketch, "
    "watermark, text overlay, people, vehicles, abstract, render artifacts"
)

# 4 exterior camera angles
EXTERIOR_ANGLES = [
    ("front",      "straight-on front elevation view centered on the main entrance"),
    ("left-side",  "three-quarter left-side view showing the front and left facade"),
    ("right-side", "three-quarter right-side view showing the front and right facade"),
    ("rear",       "rear elevation view showing the backyard and rear facade"),
]


class RenderRequest(BaseModel):
    style:       str = "modern"       # modern | traditional | farmhouse | contemporary | craftsman
    time_of_day: str = "golden_hour"  # day | golden_hour | dusk


# ── Prompt builders ───────────────────────────────────────────────────────────

def _build_exterior_prompt(
    project: dict, analysis: dict, style: str, time_of_day: str, angle_desc: str
) -> str:
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

    sqft_str  = f"{int(sqft):,} square feet, " if sqft else ""
    room_str  = f"{room_count} rooms, " if room_count else ""

    return (
        f"Photorealistic architectural exterior render of a {stories} {bp_type} home, "
        f"{style_desc}, {sqft_str}{room_str}located in {location}. "
        f"Beautifully landscaped yard with green lawn, mature trees, concrete driveway. "
        f"{angle_desc.capitalize()}. "
        f"{time_desc.capitalize()}. "
        f"Ultra-high quality architectural photography, 8K resolution, photorealistic, "
        f"professional real estate photography, no people, sharp focus, wide angle lens."
    )


def _build_room_prompt(
    project: dict, analysis: dict, style: str, room_name: str, room_sqft: int
) -> str:
    bp_type = (project.get("blueprint_type") or "residential").replace("_", " ")

    style_desc = {
        "modern":       "modern interior design, minimalist, neutral palette, clean lines, recessed lighting",
        "traditional":  "traditional interior, crown molding, warm wood tones, classic furniture",
        "farmhouse":    "modern farmhouse interior, shiplap walls, open shelving, warm neutral tones",
        "contemporary": "contemporary interior, open plan, statement lighting, mixed textures",
        "craftsman":    "craftsman interior, built-in bookshelves, warm wood trim, mission-style furniture",
    }.get(style, "modern interior design, minimalist, neutral palette")

    sqft_str = f"approximately {room_sqft} square feet, " if room_sqft else ""

    return (
        f"Photorealistic interior render of a {bp_type} {room_name}, "
        f"{style_desc}, {sqft_str}"
        f"large windows with natural light flooding in, hardwood floors, "
        f"high ceilings, tasteful furniture and decor. "
        f"Ultra-high quality architectural interior photography, 8K resolution, photorealistic, "
        f"designed by top interior designer, no people, sharp focus, wide angle lens."
    )


# ── Image generation ──────────────────────────────────────────────────────────

async def _generate_via_pollinations(prompt: str, seed: int) -> str:
    """
    Pollinations.ai — free, no API key required.
    Downloads the generated image and returns a base64 data URI so the
    browser can display it without any cross-origin or URL-loading issues.
    """
    params = {
        "width":  1280,
        "height": 720,
        "model":  "flux",
        "seed":   seed,
        "nologo": "true",
    }
    query = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{POLLINATIONS_API}/{urllib.parse.quote(prompt, safe='')}?{query}"

    async with httpx.AsyncClient(timeout=90, follow_redirects=True) as client:
        r = await client.get(url)
        if r.status_code >= 400:
            raise ValueError(f"Pollinations returned HTTP {r.status_code}")
        ct = r.headers.get("content-type", "")
        body = r.content
        # Validate image magic bytes: JPEG=FF D8, PNG=89 50, WEBP=52 49 46 46
        is_image = (
            body[:2] == b'\xff\xd8'               # JPEG
            or body[:4] == b'\x89PNG'             # PNG
            or body[8:12] == b'WEBP'              # WebP
        )
        if not is_image:
            snippet = body[:120].decode("utf-8", errors="replace")
            raise ValueError(f"Pollinations returned non-image bytes (ct={ct!r}): {snippet!r}")
        # Use detected mime type from magic bytes rather than trusting the header
        if body[:2] == b'\xff\xd8':
            mime = "image/jpeg"
        elif body[:4] == b'\x89PNG':
            mime = "image/png"
        else:
            mime = "image/webp"
        return f"data:{mime};base64," + base64.b64encode(body).decode()


async def _generate_via_hf(prompt: str) -> str:
    """HuggingFace FLUX text-to-image. Returns base64 data URI."""
    headers = {
        "Authorization": f"Bearer {settings.HUGGINGFACE_API_KEY}",
        "Content-Type":  "application/json",
    }
    payload = {
        "inputs": prompt,
        "parameters": {"num_inference_steps": 4, "guidance_scale": 0.0},
    }
    async with httpx.AsyncClient(timeout=120) as client:
        for _ in range(3):
            r = await client.post(f"{HF_API}/{HF_T2I_MODEL}", headers=headers, json=payload)
            if r.status_code == 503:
                wait = 20
                try:
                    wait = r.json().get("estimated_time", 20)
                except Exception:
                    pass
                log.info(f"[Renders] HF model loading, waiting {wait}s…")
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


async def _generate_image(prompt: str, seed: int) -> str | None:
    """Try Pollinations (with retry) → HF → Replicate. Returns URL or None on total failure."""
    # Pollinations: up to 3 attempts with different seeds on transient failures
    for attempt in range(3):
        try:
            return await _generate_via_pollinations(prompt, seed + attempt * 100)
        except Exception as e:
            log.warning(f"[Renders] Pollinations attempt {attempt + 1} failed (seed={seed + attempt * 100}): {e}")
            if attempt < 2:
                await asyncio.sleep(2)  # brief pause before retry

    if settings.HUGGINGFACE_API_KEY:
        try:
            return await _generate_via_hf(prompt)
        except Exception as e:
            log.warning(f"[Renders] HuggingFace failed: {e} — trying Replicate…")

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

    bp_row = (
        db.table("blueprints")
        .select("id")
        .eq("project_id", project_id)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    analysis: dict = {}
    if bp_row.data:
        an_row = (
            db.table("analyses")
            .select("*")
            .eq("blueprint_id", bp_row.data[0]["id"])
            .limit(1)
            .execute()
        )
        if an_row.data:
            analysis = an_row.data[0]

    # Each image gets a unique seed so renders vary on every click of Generate.
    # base_seed is random per request; each image is offset by its index (0-9).
    base_seed = random.randint(100, 9999)

    # ── 4 exterior angle views ──
    exterior_tasks = [
        _generate_image(
            _build_exterior_prompt(project, analysis, request.style, request.time_of_day, angle_desc),
            base_seed + i,
        )
        for i, (_, angle_desc) in enumerate(EXTERIOR_ANGLES)
    ]

    # ── Up to 6 room interior views ──
    rooms = analysis.get("rooms", [])[:6]
    room_tasks = [
        _generate_image(
            _build_room_prompt(
                project, analysis, request.style,
                room.get("name", f"Room {j + 1}"),
                int(room.get("sqft", 0)),
            ),
            base_seed + 4 + j,
        )
        for j, room in enumerate(rooms)
    ]

    all_results = await asyncio.gather(*exterior_tasks, *room_tasks, return_exceptions=True)
    ext_results  = all_results[:4]
    room_results = all_results[4:]

    exterior_views = [
        {
            "angle": EXTERIOR_ANGLES[i][0],
            "label": EXTERIOR_ANGLES[i][0].replace("-", " ").title(),
            "url":   r if isinstance(r, str) else None,
        }
        for i, r in enumerate(ext_results)
    ]

    room_renders = [
        {
            "name": rooms[j].get("name", f"Room {j + 1}") if j < len(rooms) else f"Room {j + 1}",
            "url":  r if isinstance(r, str) else None,
        }
        for j, r in enumerate(room_results)
    ]

    any_success = any(v["url"] for v in exterior_views) or any(v["url"] for v in room_renders)
    if not any_success:
        raise HTTPException(
            status_code=500,
            detail=(
                "Image generation failed across all providers. "
                "Pollinations.ai may be temporarily overloaded — please try again in a moment."
            ),
        )

    return {
        "exterior_views": exterior_views,
        "room_renders":   room_renders,
        "style":          request.style,
        "time_of_day":    request.time_of_day,
        "provider":       "pollinations",
    }
