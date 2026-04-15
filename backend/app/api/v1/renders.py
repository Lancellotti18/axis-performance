"""
renders.py — AI Photorealistic Render Generation
=================================================
Generates:
  • 4 exterior angle views (front, left-side, right-side, rear)
  • 1 interior render per room on the blueprint (up to 5)

Provider priority (first available wins):
  1. Google Gemini image generation — free with GEMINI_API_KEY, returns base64
  2. HuggingFace FLUX               — free with HUGGINGFACE_API_KEY, returns base64
  3. Replicate SDXL                 — paid fallback with REPLICATE_API_KEY

Blueprint vision analysis:
  The blueprint image is downloaded and analyzed with llm_vision before any
  render is generated. The extracted context (style cues, materials, features,
  stories) is injected into every prompt so renders match the actual drawing.

User context:
  An optional free-text field from the UI is appended to every prompt so the
  user can guide the AI ("red brick exterior", "coastal vibe", etc.).
"""

from __future__ import annotations

import asyncio
import base64
import logging
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

# Lazily initialized — asyncio.Semaphore must be created inside a running event loop.
_gemini_sem: asyncio.Semaphore | None = None

def _get_gemini_sem() -> asyncio.Semaphore:
    global _gemini_sem
    if _gemini_sem is None:
        # Serialize Gemini image-gen calls to stay ≤5 RPM on the free-tier quota.
        # Concurrent calls cause 429s that fall back to providers that don't work from Render.
        _gemini_sem = asyncio.Semaphore(1)
    return _gemini_sem

HF_API       = "https://router.huggingface.co/hf-inference/models"
HF_T2I_MODEL = "black-forest-labs/FLUX.1-schnell"
REPLICATE_API = "https://api.replicate.com/v1"
SDXL_MODEL    = "stability-ai/sdxl"

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

MAX_ROOM_RENDERS = 5  # 4 exterior + 5 rooms = 9 × 22s = ~198s; fits in 300s budget


class RenderRequest(BaseModel):
    style:        str = "modern"       # modern | traditional | farmhouse | contemporary | craftsman
    time_of_day:  str = "golden_hour"  # day | golden_hour | dusk
    user_context: str = ""             # free-text from user ("red brick, wraparound porch, etc.")


# ── Blueprint vision analysis ─────────────────────────────────────────────────

async def _analyze_blueprint(blueprint_id: str) -> dict:
    """
    Download the blueprint image from Supabase and run vision AI on it.
    Returns a dict with style cues extracted from the actual drawing.
    Falls back to empty dict if anything fails (renders still proceed with project metadata).
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
        if not file_url:
            return {}

        # Extract Supabase storage path and download the image
        m = re.search(r'/blueprints/(.+?)(?:\?.*)?$', file_url)
        if not m:
            return {}
        storage_path = m.group(1)

        image_bytes: bytes = await asyncio.to_thread(
            db.storage.from_("blueprints").download, storage_path
        )
        if not image_bytes:
            return {}

        # Determine MIME type for llm_vision
        mime = "image/png"
        if "jpeg" in file_type or "jpg" in file_type:
            mime = "image/jpeg"
        elif "pdf" in file_type:
            # PDF blueprints: skip vision analysis (can't easily render page 1 here)
            return {}

        from app.services.llm import llm_vision
        analysis_text = await llm_vision(
            image_bytes=image_bytes,
            media_type=mime,
            prompt=(
                "Analyze this architectural blueprint. Extract ONLY what is clearly visible. "
                "Return a JSON object with these keys (omit any key you cannot determine):\n"
                '{"stories": 1 or 2, "style_cues": "brief phrase e.g. gable roof, open floor plan", '
                '"exterior_materials": "e.g. brick, wood siding, stucco", '
                '"key_features": "e.g. front porch, attached garage, large windows", '
                '"rooms": ["list", "of", "room", "names", "visible"]}\n'
                "Be concise. Do not guess. Return only the JSON."
            ),
            max_tokens=512,
        )

        # Parse response
        try:
            import json as _json
            text = analysis_text.strip()
            text = re.sub(r'^```(?:json)?\s*', '', text)
            text = re.sub(r'\s*```\s*$', '', text)
            start = text.find("{")
            if start != -1:
                return _json.loads(text[start:])
        except Exception:
            pass

    except Exception as e:
        log.warning(f"[Renders] Blueprint vision analysis failed: {e}")

    return {}


# ── Prompt builders ───────────────────────────────────────────────────────────

def _build_exterior_prompt(
    project: dict,
    analysis: dict,
    bp_vision: dict,
    style: str,
    time_of_day: str,
    angle_desc: str,
    user_context: str,
) -> str:
    sqft       = analysis.get("total_sqft", 0)
    bp_type    = (project.get("blueprint_type") or "residential").replace("_", " ")
    city       = project.get("city", "")
    region     = (project.get("region") or "").replace("US-", "")
    location   = f"{city}, {region}".strip(", ") if city or region else "suburban"

    # Prefer blueprint vision for stories; fall back to sqft heuristic
    stories_n  = bp_vision.get("stories")
    if stories_n:
        stories = f"{stories_n}-story" if stories_n == 1 else "two-story"
    else:
        stories = "two-story" if sqft and sqft > 2500 else "single-story"

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

    # Incorporate blueprint vision context
    vision_parts = []
    if bp_vision.get("style_cues"):
        vision_parts.append(bp_vision["style_cues"])
    if bp_vision.get("exterior_materials"):
        vision_parts.append(bp_vision["exterior_materials"])
    if bp_vision.get("key_features"):
        vision_parts.append(bp_vision["key_features"])
    vision_str = ", ".join(vision_parts)

    prompt = (
        f"Photorealistic architectural render. "
        f"{stories} {bp_type} home, {style_desc}"
        f"{', ' + vision_str if vision_str else ''}, "
        f"{sqft_str}located in {location}. "
        f"{angle_desc.capitalize()}. {time_desc.capitalize()}. "
        f"Landscaped yard, concrete driveway. Sharp focus, no people."
    )
    if user_context:
        prompt += f" Additional details: {user_context}."
    return prompt


def _build_room_prompt(
    project: dict,
    analysis: dict,
    bp_vision: dict,
    style: str,
    room_name: str,
    room_sqft: int,
    user_context: str,
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

    # Vision context for interiors
    vision_parts = []
    if bp_vision.get("style_cues"):
        vision_parts.append(bp_vision["style_cues"])
    vision_str = ", ".join(vision_parts)

    prompt = (
        f"Photorealistic interior render. "
        f"{bp_type} {room_name}, {style_desc}"
        f"{', ' + vision_str if vision_str else ''}, "
        f"{sqft_str}natural light, hardwood floors, high ceilings, tasteful furniture. "
        f"Wide angle, no people."
    )
    if user_context:
        prompt += f" Additional details: {user_context}."
    return prompt


# ── Image generation ──────────────────────────────────────────────────────────

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
    Gemini image generation, serialized by semaphore.
    10s sleep after every call keeps us at ≤3 RPM — well under the free-tier limit.
    Without this spacing, calls 2-N get 429 and there is no working fallback
    from Render's cloud IPs.
    """
    async with _get_gemini_sem():
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(_gemini_call, prompt), timeout=25
            )
        finally:
            # Always sleep — even on failure — before releasing the semaphore.
            await asyncio.sleep(10)


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
        loop = asyncio.get_running_loop()
        start = loop.time()
        while loop.time() - start < 240:
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


async def _generate_image(prompt: str) -> str:
    """
    Try providers in order. Always returns a base64 data URI string.
    Priority: Gemini → HuggingFace → Replicate
    Raises if all providers fail (caller uses return_exceptions=True).
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

    raise RuntimeError("All image generation providers failed.")


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/{project_id}/generate")
async def generate_renders(project_id: str, request: RenderRequest):

    db = get_supabase()

    proj_row = db.table("projects").select("*").eq("id", project_id).limit(1).execute()
    if not proj_row.data:
        raise HTTPException(status_code=404, detail="Project not found.")
    project = proj_row.data[0]

    # Fetch latest blueprint and its analysis
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

    # ── Analyze blueprint image for visual context ──
    # This runs once (using the text LLM quota, not image-gen quota).
    bp_vision: dict = {}
    if blueprint_id:
        bp_vision = await _analyze_blueprint(blueprint_id)
        if bp_vision:
            log.info(f"[Renders] Blueprint vision: {bp_vision}")

    user_context = (request.user_context or "").strip()

    # Use all rooms from blueprint analysis, capped to MAX_ROOM_RENDERS
    rooms = analysis.get("rooms", [])[:MAX_ROOM_RENDERS]

    # Build prompts
    exterior_prompts = [
        _build_exterior_prompt(project, analysis, bp_vision, request.style, request.time_of_day, angle_desc, user_context)
        for _, angle_desc in EXTERIOR_ANGLES
    ]
    room_prompts = [
        _build_room_prompt(
            project, analysis, bp_vision, request.style,
            room.get("name", f"Room {j + 1}"),
            int(room.get("sqft", 0)),
            user_context,
        )
        for j, room in enumerate(rooms)
    ]

    all_prompts = exterior_prompts + room_prompts
    all_results = await asyncio.gather(
        *[_generate_image(p) for p in all_prompts],
        return_exceptions=True,
    )

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
        "blueprint_context": bp_vision,
    }
