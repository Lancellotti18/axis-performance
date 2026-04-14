"""
renders.py — AI Photorealistic Render Generation
=================================================
Generates:
  • 4 exterior angle views (front, left-side, right-side, rear)
  • Up to 6 per-room interior renders (from blueprint analysis)

Provider priority (first available wins):
  1. Google Gemini image generation — free with GEMINI_API_KEY, returns base64
  2. HuggingFace FLUX               — free with HUGGINGFACE_API_KEY, returns base64
  3. Replicate SDXL                 — paid fallback with REPLICATE_API_KEY
  4. Pollinations.ai URL            — free, no key; browser loads the URL directly

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

# Limit concurrent Gemini image-gen calls to avoid hitting free-tier rate limits.
# Gemini allows ~10 RPM on the free tier; with 10 images firing simultaneously
# requests 2-10 get rate-limited and fall back to Pollinations (which doesn't load).
_gemini_sem = asyncio.Semaphore(4)

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
        f"{stories} {bp_type} home, {style_desc}, {sqft_str}in {location}. "
        f"{angle_desc.capitalize()}. {time_desc.capitalize()}. "
        f"Landscaped yard, concrete driveway. "
        f"Architectural photography, no people, sharp focus."
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
        f"{bp_type} {room_name}, {style_desc}, {sqft_str}"
        f"natural light, hardwood floors, high ceilings, tasteful furniture. "
        f"Interior photography, no people, wide angle."
    )


# ── Image generation ──────────────────────────────────────────────────────────

def _pollinations_url(prompt: str, seed: int) -> str:
    """Pollinations URL — last resort, loaded by the browser directly."""
    encoded = urllib.parse.quote(prompt, safe='')
    return (
        f"{POLLINATIONS_API}/{encoded}"
        f"?width=1280&height=720&model=flux&seed={seed}&nologo=true"
    )


def _gemini_call(prompt: str) -> str:
    """Synchronous Gemini image generation — runs in a thread via asyncio.to_thread."""
    from google import genai
    from google.genai import types

    MODELS = [
        "gemini-2.0-flash-preview-image-generation",
        "gemini-2.0-flash-exp-image-generation",
        "gemini-2.0-flash-exp",
    ]
    client = genai.Client(api_key=settings.GEMINI_API_KEY)
    last_err: Exception = ValueError("No models tried")
    for model in MODELS:
        try:
            response = client.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"]),
            )
            for part in response.candidates[0].content.parts:
                if part.inline_data is not None:
                    mime = part.inline_data.mime_type or "image/jpeg"
                    encoded = base64.b64encode(part.inline_data.data).decode("ascii")
                    return f"data:{mime};base64,{encoded}"
            last_err = ValueError(f"{model}: no image parts in response")
        except Exception as e:
            last_err = e
            log.warning(f"[Renders] Gemini {model!r}: {e}")
    raise last_err


async def _generate_via_gemini(prompt: str) -> str:
    """
    Rate-limited Gemini image generation.
    Uses a semaphore (max 2 concurrent) to avoid hitting free-tier quota.
    Retries up to 3× on rate-limit errors with backoff.
    """
    async with _gemini_sem:
        for attempt in range(3):
            try:
                return await asyncio.wait_for(
                    asyncio.to_thread(_gemini_call, prompt), timeout=90
                )
            except Exception as e:
                err = str(e)
                if any(x in err for x in ("429", "RESOURCE_EXHAUSTED", "quota", "rate")):
                    wait = 12 * (attempt + 1)   # 12s, 24s, 36s
                    log.warning(f"[Renders] Gemini rate-limited, retrying in {wait}s (attempt {attempt + 1})")
                    await asyncio.sleep(wait)
                else:
                    raise
        raise RuntimeError("Gemini rate limit persisted after 3 retries")


async def _generate_via_pollinations(prompt: str, seed: int) -> str:
    return _pollinations_url(prompt, seed)


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


async def _generate_image(prompt: str, seed: int) -> str:
    """
    Try providers in order. Always returns a string (base64 data URI or Pollinations URL).
    Priority: Gemini → HuggingFace → Replicate → Pollinations URL
    """
    if settings.GEMINI_API_KEY:
        try:
            return await _generate_via_gemini(prompt)
        except Exception as e:
            log.warning(f"[Renders] Gemini image gen failed: {e}")

    if settings.HUGGINGFACE_API_KEY:
        try:
            return await _generate_via_hf(prompt)
        except Exception as e:
            log.warning(f"[Renders] HuggingFace failed: {e}")

    if settings.REPLICATE_API_KEY:
        try:
            return await _generate_via_replicate(prompt)
        except Exception as e:
            log.warning(f"[Renders] Replicate failed: {e}")

    # Last resort: return a Pollinations URL for the browser to load directly
    log.warning("[Renders] All server-side providers failed — returning Pollinations URL")
    return _pollinations_url(prompt, seed)


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

    # ── Up to 3 room interior views (fastest rooms first) ──
    rooms = analysis.get("rooms", [])[:3]
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

    return {
        "exterior_views": exterior_views,
        "room_renders":   room_renders,
        "style":          request.style,
        "time_of_day":    request.time_of_day,
        "provider":       "pollinations",
    }
