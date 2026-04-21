"""
renders.py — AI Photorealistic Render Generation
=================================================
Generates:
  • 4 exterior angle views (front, left-side, right-side, rear)
  • 1 interior render per room on the blueprint (up to 3)

Provider priority:
  1. fal.ai FLUX.1.1-pro  — $0.03/image, no rate limits, all images concurrent (~15s total)
  2. Gemini image gen      — free, serialized with 10s gaps to avoid 429s
  3. HuggingFace FLUX      — free with HUGGINGFACE_API_KEY
  4. Replicate SDXL        — paid fallback
  5. Pollinations URL      — last resort, browser loads directly

Blueprint vision:
  Downloads the blueprint image and runs AI vision on it to extract style cues,
  materials, and features — injected into every prompt for accurate renders.

User context:
  Free-text from the UI appended to every prompt ("red brick, coastal setting", etc.)
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import random
import re
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

EXTERIOR_ANGLES = [
    ("front",      "straight-on front elevation view centered on the main entrance"),
    ("left-side",  "three-quarter left-side view showing the front and left facade"),
    ("right-side", "three-quarter right-side view showing the front and right facade"),
    ("rear",       "rear elevation view showing the backyard and rear facade"),
]

MAX_ROOM_RENDERS = 3  # 4 + 3 = 7 images; at $0.03 each = $0.21/request with fal.ai

# Gemini rate-limit semaphore — only used when fal.ai is not configured
_gemini_sem: asyncio.Semaphore | None = None

def _get_gemini_sem() -> asyncio.Semaphore:
    global _gemini_sem
    if _gemini_sem is None:
        _gemini_sem = asyncio.Semaphore(1)
    return _gemini_sem


class RenderRequest(BaseModel):
    style:        str = "modern"
    time_of_day:  str = "golden_hour"
    user_context: str = ""


# ── Blueprint vision analysis ─────────────────────────────────────────────────

async def _analyze_blueprint(blueprint_id: str) -> dict:
    """
    Download blueprint image and run vision AI on it to extract architectural
    context. Returns {} if anything fails — renders proceed without vision context.
    """
    try:
        db = get_supabase()
        row = (
            db.table("blueprints")
            .select("file_url, file_type")
            .eq("id", blueprint_id)
            .single()
            .execute()
        )
        if not row.data:
            return {}

        file_url: str = row.data.get("file_url", "") or ""
        file_type: str = (row.data.get("file_type") or "image/png").lower()
        if not file_url or "pdf" in file_type:
            return {}

        m = re.search(r'/blueprints/(.+?)(?:\?.*)?$', file_url)
        if not m:
            return {}

        image_bytes: bytes = await asyncio.to_thread(
            db.storage.from_("blueprints").download, m.group(1)
        )
        if not image_bytes:
            return {}

        mime = "image/jpeg" if ("jpeg" in file_type or "jpg" in file_type) else "image/png"

        from app.services.llm import llm_vision
        import json as _json

        text = await asyncio.wait_for(
            llm_vision(
                image_bytes=image_bytes,
                media_type=mime,
                prompt=(
                    "Analyze this architectural blueprint. Return ONLY a JSON object "
                    "(no markdown) with any of these keys you can clearly determine:\n"
                    '{"stories":1,"style_cues":"gable roof, open plan",'
                    '"exterior_materials":"brick, wood siding",'
                    '"key_features":"front porch, attached garage"}\n'
                    "Omit keys you cannot determine. Be brief."
                ),
                max_tokens=200,
            ),
            timeout=20,
        )

        text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text.strip())
        start = text.find("{")
        if start != -1:
            return _json.loads(text[start:])

    except Exception as e:
        log.warning(f"[Renders] Blueprint vision skipped: {e}")

    return {}


# ── Prompt builders ───────────────────────────────────────────────────────────

def _build_exterior_prompt(
    project: dict, analysis: dict, bp_vision: dict,
    style: str, time_of_day: str, angle_desc: str, user_context: str,
) -> str:
    sqft     = analysis.get("total_sqft", 0)
    bp_type  = (project.get("blueprint_type") or "residential").replace("_", " ")
    city     = project.get("city", "")
    region   = (project.get("region") or "").replace("US-", "")
    location = f"{city}, {region}".strip(", ") or "suburban USA"

    stories_n = bp_vision.get("stories")
    stories   = f"{stories_n}-story" if stories_n == 1 else ("two-story" if (stories_n == 2 or (sqft and sqft > 2500)) else "single-story")

    time_desc = {
        "day":         "bright midday sunlight, clear blue sky",
        "golden_hour": "warm golden hour sunset light, long shadows",
        "dusk":        "dusk twilight, warm interior lights glowing through windows",
    }.get(time_of_day, "golden hour sunlight")

    style_desc = {
        "modern":       "modern architecture, clean lines, large windows, flat or low-pitch roof",
        "traditional":  "traditional architecture, symmetrical facade, shutters, pitched gable roof",
        "farmhouse":    "modern farmhouse, board and batten siding, metal roof, front porch",
        "contemporary": "contemporary architecture, mixed materials, asymmetric roofline, floor-to-ceiling windows",
        "craftsman":    "craftsman bungalow, tapered columns, covered front porch, exposed rafter tails",
    }.get(style, "modern architecture, clean lines")

    vision_parts = [v for k in ("style_cues", "exterior_materials", "key_features") if (v := bp_vision.get(k))]
    vision_str   = ", ".join(vision_parts)
    sqft_str     = f"{int(sqft):,} sq ft, " if sqft else ""

    # user_context is the most specific, user-authored guidance — lead with it.
    lead = f"{user_context.strip().rstrip('.')}. " if user_context else ""

    prompt = (
        f"Ultra-photorealistic architectural exterior render, 8K quality. "
        f"{lead}"
        f"{stories} {bp_type}, {style_desc}"
        f"{', ' + vision_str if vision_str else ''}, "
        f"{sqft_str}located in {location}. "
        f"{angle_desc.capitalize()}. {time_desc.capitalize()}. "
        f"Professional landscaping, concrete driveway. "
        f"Shot on Phase One XF IQ4, architectural photography, no people, tack sharp, correct architectural proportions."
    )
    return prompt


def _build_room_prompt(
    project: dict, analysis: dict, bp_vision: dict,
    style: str, room_name: str, room_sqft: int, user_context: str,
) -> str:
    bp_type = (project.get("blueprint_type") or "residential").replace("_", " ")

    style_desc = {
        "modern":       "modern minimalist interior, neutral palette, recessed lighting, clean lines",
        "traditional":  "traditional interior, crown molding, warm wood tones, classic furniture",
        "farmhouse":    "modern farmhouse interior, shiplap accent wall, open shelving, warm neutrals",
        "contemporary": "contemporary interior, statement lighting, mixed textures, open plan",
        "craftsman":    "craftsman interior, built-in bookshelves, warm wood trim, mission-style furniture",
    }.get(style, "modern minimalist interior, neutral palette")

    vision_str = bp_vision.get("style_cues", "")
    sqft_str   = f"approximately {room_sqft} sq ft, " if room_sqft else ""

    # user_context is the most specific, user-authored guidance — lead with it.
    lead = f"{user_context.strip().rstrip('.')}. " if user_context else ""

    prompt = (
        f"Ultra-photorealistic interior render, 8K quality. "
        f"{lead}"
        f"{bp_type} {room_name}, {style_desc}"
        f"{', ' + vision_str if vision_str else ''}, "
        f"{sqft_str}natural light from large windows, hardwood floors, high ceilings, tasteful furniture. "
        f"Shot on Hasselblad H6D, wide-angle interior photography, no people, tack sharp, correct proportions."
    )
    return prompt


# ── Image generation providers ────────────────────────────────────────────────

def _fal_key() -> str:
    """Accept either FAL_KEY or FAL_API_KEY — matches visualizer_service behavior."""
    return (
        os.environ.get("FAL_KEY")
        or os.environ.get("FAL_API_KEY")
        or getattr(settings, "FAL_API_KEY", "")
        or ""
    )


async def _generate_via_fal(prompt: str) -> str:
    """
    fal.ai FLUX.1.1-pro — best quality, no rate limits, all images run concurrently.
    ~$0.03/image. Returns base64 data URI.
    """
    import fal_client

    # fal_client reads FAL_KEY env var
    os.environ.setdefault("FAL_KEY", _fal_key())

    def _run():
        result = fal_client.run(
            "fal-ai/flux-pro/v1.1",
            arguments={
                "prompt":               prompt,
                "image_size":           "landscape_4_3",
                "num_inference_steps":  28,
                "guidance_scale":       3.5,
                "num_images":           1,
                "safety_tolerance":     "2",
                "output_format":        "jpeg",
            },
        )
        return result["images"][0]["url"]

    image_url = await asyncio.wait_for(asyncio.to_thread(_run), timeout=90)

    # Download and return as base64 so the browser doesn't need to hit fal.ai CDN
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(image_url)
        r.raise_for_status()
        return "data:image/jpeg;base64," + base64.b64encode(r.content).decode()


def _gemini_call(prompt: str) -> str:
    from google import genai
    from google.genai import types

    MODELS = [
        "gemini-2.0-flash-preview-image-generation",
        "gemini-2.0-flash-exp-image-generation",
        "gemini-2.0-flash-exp",
    ]
    client   = genai.Client(api_key=settings.GEMINI_API_KEY)
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
                    mime    = part.inline_data.mime_type or "image/jpeg"
                    encoded = base64.b64encode(part.inline_data.data).decode("ascii")
                    return f"data:{mime};base64,{encoded}"
            last_err = ValueError(f"{model}: no image parts in response")
        except Exception as e:
            last_err = e
            log.warning(f"[Renders] Gemini {model!r}: {e}")
    raise last_err


async def _generate_via_gemini(prompt: str) -> str:
    """Serialized with 10s spacing to stay under Gemini free-tier rate limits."""
    async with _get_gemini_sem():
        try:
            return await asyncio.wait_for(asyncio.to_thread(_gemini_call, prompt), timeout=25)
        finally:
            await asyncio.sleep(10)


async def _generate_via_hf(prompt: str) -> str:
    headers = {
        "Authorization": f"Bearer {settings.HUGGINGFACE_API_KEY}",
        "Content-Type":  "application/json",
    }
    async with httpx.AsyncClient(timeout=120) as client:
        for _ in range(3):
            r = await client.post(
                f"{HF_API}/{HF_T2I_MODEL}",
                headers=headers,
                json={"inputs": prompt, "parameters": {"num_inference_steps": 4, "guidance_scale": 0.0}},
            )
            if r.status_code == 503:
                wait = 20
                try:
                    wait = r.json().get("estimated_time", 20)
                except Exception:
                    logger.debug("HF 503 estimated_time parse failed", exc_info=True)
                    pass
                await asyncio.sleep(min(wait, 30))
                continue
            r.raise_for_status()
            return "data:image/png;base64," + base64.b64encode(r.content).decode()
    raise TimeoutError("HuggingFace model did not load after 3 attempts.")


async def _generate_via_replicate(prompt: str) -> str:
    auth = {"Authorization": f"Token {settings.REPLICATE_API_KEY}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{REPLICATE_API}/models/{SDXL_MODEL}", headers=auth)
        r.raise_for_status()
        version = r.json()["latest_version"]["id"]

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{REPLICATE_API}/predictions",
            headers=auth,
            json={"version": version, "input": {
                "prompt": prompt, "negative_prompt": NEGATIVE_PROMPT,
                "num_inference_steps": 40, "guidance_scale": 7.5,
                "width": 1024, "height": 768,
                "refine": "expert_ensemble_refiner", "high_noise_frac": 0.8,
            }},
        )
        r.raise_for_status()
        prediction_id = r.json()["id"]

    async with httpx.AsyncClient(timeout=15) as client:
        loop  = asyncio.get_running_loop()
        start = loop.time()
        while loop.time() - start < 240:
            r    = await client.get(f"{REPLICATE_API}/predictions/{prediction_id}", headers=auth)
            data = r.json()
            if data.get("status") == "succeeded":
                out = data.get("output", [])
                return out[-1] if isinstance(out, list) else out
            if data.get("status") in ("failed", "canceled"):
                raise ValueError(f"Replicate {data['status']}: {data.get('error')}")
            await asyncio.sleep(4)
    raise TimeoutError("Replicate generation timed out.")


def _pollinations_url(prompt: str, seed: int) -> str:
    encoded = urllib.parse.quote(prompt[:500], safe='')
    return f"{POLLINATIONS_API}/{encoded}?width=1280&height=960&model=flux&seed={seed}&nologo=true"


async def _generate_image(prompt: str, seed: int = 0) -> str:
    """
    Try providers in priority order. Always returns a string — never raises.
    fal.ai → Gemini → HuggingFace → Replicate → Pollinations URL
    """
    if _fal_key():
        try:
            return await _generate_via_fal(prompt)
        except Exception as e:
            log.warning(f"[Renders] fal.ai failed: {e}")

    if settings.GEMINI_API_KEY:
        try:
            return await _generate_via_gemini(prompt)
        except Exception as e:
            log.warning(f"[Renders] Gemini failed: {e}")

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
        .select("id, file_url, file_type")
        .eq("project_id", project_id)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    analysis: dict = {}
    blueprint_id: str | None = None
    if bp_row.data:
        blueprint_id = bp_row.data[0]["id"]
        an_row = (
            db.table("analyses")
            .select("*")
            .eq("blueprint_id", blueprint_id)
            .limit(1)
            .execute()
        )
        if an_row.data:
            analysis = an_row.data[0]

    # Analyze blueprint image for visual context (best-effort, 20s max)
    bp_vision: dict = {}
    if blueprint_id:
        bp_vision = await _analyze_blueprint(blueprint_id)
        if bp_vision:
            log.info(f"[Renders] Blueprint vision context: {bp_vision}")

    user_context = (request.user_context or "").strip()
    rooms        = analysis.get("rooms", [])[:MAX_ROOM_RENDERS]
    base_seed    = random.randint(100, 9999)

    exterior_pairs = [
        (
            _build_exterior_prompt(project, analysis, bp_vision, request.style, request.time_of_day, angle_desc, user_context),
            base_seed + i,
        )
        for i, (_, angle_desc) in enumerate(EXTERIOR_ANGLES)
    ]
    room_pairs = [
        (
            _build_room_prompt(project, analysis, bp_vision, request.style,
                               room.get("name", f"Room {j+1}"), int(room.get("sqft", 0)), user_context),
            base_seed + 4 + j,
        )
        for j, room in enumerate(rooms)
    ]

    all_pairs   = exterior_pairs + room_pairs
    all_results = await asyncio.gather(
        *[_generate_image(prompt, seed) for prompt, seed in all_pairs],
        return_exceptions=True,
    )

    def _url(r) -> str | None:
        if isinstance(r, str) and r:
            return r
        if isinstance(r, Exception):
            log.error(f"[Renders] Image task exception: {r}")
        return None

    ext_results  = all_results[:4]
    room_results = all_results[4:]

    exterior_views = [
        {"angle": EXTERIOR_ANGLES[i][0], "label": EXTERIOR_ANGLES[i][0].replace("-", " ").title(), "url": _url(r)}
        for i, r in enumerate(ext_results)
    ]
    room_renders = [
        {"name": rooms[j].get("name", f"Room {j+1}") if j < len(rooms) else f"Room {j+1}", "url": _url(r)}
        for j, r in enumerate(room_results)
    ]

    return {
        "exterior_views":    exterior_views,
        "room_renders":      room_renders,
        "style":             request.style,
        "time_of_day":       request.time_of_day,
        "blueprint_context": bp_vision,
    }
