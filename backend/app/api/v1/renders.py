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

MAX_ROOM_RENDERS = 20  # Generate one render per room on the blueprint up to this safety cap

# ── Setting-aware room type mapping ───────────────────────────────────────────
# Each generated interior render must be a plausible room for the project type.
# Keys are normalized `blueprint_type` values; values are ordered lists where
# earlier entries are the "primary" rooms to prefer when nothing else hints at
# a specific type.
ROOM_TYPES_BY_BUILDING_TYPE: dict[str, list[str]] = {
    "residential":  ["living room", "kitchen", "bedroom", "bathroom", "dining room", "home office", "laundry room"],
    "commercial":   ["lobby", "office", "conference room", "break room", "reception area", "storage room"],
    "retail":       ["sales floor", "fitting room", "stockroom", "checkout counter area", "back office"],
    "office":       ["open office", "private office", "conference room", "break room", "reception area", "copy room"],
    "warehouse":    ["warehouse floor", "loading dock", "storage aisle", "office", "break room"],
}

# Keyword hints we look for inside room names produced by the blueprint analyzer.
# If the analyzer labels a room "Room 2" (the default) we have no signal, but if
# a real name like "kitchen_02" or "Master Bedroom" comes through we honor it as
# long as it's plausible for the building type.
_ROOM_NAME_HINTS: list[tuple[str, str]] = [
    ("bedroom",    "bedroom"),
    ("bed",        "bedroom"),
    ("master",     "bedroom"),
    ("kitchen",    "kitchen"),
    ("bath",       "bathroom"),
    ("restroom",   "bathroom"),
    ("living",     "living room"),
    ("family",     "living room"),
    ("dining",     "dining room"),
    ("office",     "office"),
    ("conference", "conference room"),
    ("break",      "break room"),
    ("reception",  "reception area"),
    ("lobby",      "lobby"),
    ("laundry",    "laundry room"),
    ("storage",    "storage room"),
    ("stock",      "stockroom"),
    ("fitting",    "fitting room"),
    ("sales",      "sales floor"),
    ("checkout",   "checkout counter area"),
    ("warehouse",  "warehouse floor"),
    ("loading",    "loading dock"),
    ("copy",       "copy room"),
]

# Subtle per-call variety nudges for providers that can't accept a seed (Gemini).
# These vary the *scene* while keeping the *style* consistent so regenerates look
# materially different without drifting into a totally different aesthetic.
_VARIETY_LIGHTING = [
    "soft morning daylight",
    "bright midday light",
    "warm late-afternoon light",
    "golden hour glow",
    "overcast diffuse daylight",
    "cool blue-hour twilight with interior lights on",
]
_VARIETY_CAMERA = [
    "wide-angle view from the doorway",
    "corner-angle composition",
    "eye-level centered composition",
    "slightly low-angle wide view",
    "three-quarter angle composition",
]
_VARIETY_EXTERIOR_CAMERA = [
    "shot from across the street",
    "shot from the edge of the driveway",
    "shot from a slightly elevated angle",
    "shot at eye level from the sidewalk",
    "wide lens composition with foreground landscaping",
]


def _normalize_building_type(bp_type: str | None) -> str:
    """Map the raw `blueprint_type` field to a key in ROOM_TYPES_BY_BUILDING_TYPE."""
    if not bp_type:
        return "residential"
    t = bp_type.lower().strip().replace("_", " ").replace("-", " ")
    if "retail" in t or "store" in t or "shop" in t:
        return "retail"
    if "warehouse" in t or "industrial" in t:
        return "warehouse"
    if "office" in t:
        return "office"
    if "commercial" in t or "mixed" in t:
        return "commercial"
    return "residential"


def _infer_room_type(room_name: str, building_type_key: str, index: int, sqft: int) -> str:
    """
    Pick an appropriate room type for this slot.

    Priority:
      1. Explicit keyword match in the room name (if it's allowed for this building type).
      2. Fall back to the allowed list for the building type, cycling by index.
      3. For residential, bias larger rooms to living/kitchen and smaller to bath/bedroom.
    """
    allowed = ROOM_TYPES_BY_BUILDING_TYPE.get(
        building_type_key,
        ROOM_TYPES_BY_BUILDING_TYPE["residential"],
    )
    name_lc = (room_name or "").lower()

    # 1. Explicit hint in the room name — honor it only if it fits the building type.
    for needle, mapped in _ROOM_NAME_HINTS:
        if needle in name_lc and mapped in allowed:
            return mapped

    # 3. Residential size heuristic (only kicks in if no name hint matched).
    if building_type_key == "residential" and sqft:
        if sqft >= 250:
            return "living room"
        if sqft >= 150:
            return "kitchen"
        if sqft <= 60:
            return "bathroom"
        # fall through to index-based pick

    # 2. Cycle through the allowed list by index so we get variety across rooms.
    return allowed[index % len(allowed)]

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
    variety_seed: int | None = None,
) -> str:
    sqft     = analysis.get("total_sqft", 0)
    bp_type  = (project.get("blueprint_type") or "residential").replace("_", " ")
    city     = project.get("city", "")
    region   = (project.get("region") or "").replace("US-", "")
    location = f"{city}, {region}".strip(", ") or "suburban USA"

    stories_n = bp_vision.get("stories")
    stories   = f"{stories_n}-story" if stories_n == 1 else ("two-story" if (stories_n == 2 or (sqft and sqft > 2500)) else "single-story")
    stories_word = "story" if (stories_n == 1 or (not stories_n and (not sqft or sqft <= 2500))) else "stories"

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

    # Rough spatial-awareness nudge. Text-to-image models won't render exact
    # square footage but this stops the "my 1,500 sqft ranch looks like a resort"
    # failure mode.
    if sqft:
        stories_label = f"{stories_n} {stories_word}" if stories_n else (stories.replace("-", " "))
        size_nudge = (
            f"The entire structure is approximately {int(sqft):,} sq ft on {stories_label} — "
            f"make the building size proportional. A 1,500 sqft ranch should look modest; "
            f"a 5,000 sqft home should look large. Do not exaggerate scale. "
        )
    else:
        size_nudge = "Make the building size proportional and realistic, not exaggerated. "

    # Variety nudge so repeated regenerates don't produce identical images.
    variety = ""
    if variety_seed is not None:
        rng     = random.Random(variety_seed)
        cam     = rng.choice(_VARIETY_EXTERIOR_CAMERA)
        variety = f"{cam.capitalize()}. "

    # Stable building description first, angle text last. The leading block is
    # identical across all four exterior calls so seed-aware models treat them
    # as the same building from different angles.
    building_block = (
        f"{stories} {bp_type}, {style_desc}"
        f"{', ' + vision_str if vision_str else ''}, "
        f"{sqft_str}located in {location}"
    )

    prompt = (
        f"Ultra-photorealistic architectural exterior render, 8K quality. "
        f"{lead}"
        f"SAME building, multi-angle architectural photography series — keep the "
        f"roof pitch, window placement, siding material, color palette, and "
        f"proportions identical across views. "
        f"BUILDING: {building_block}. "
        f"{size_nudge}"
        f"VIEW: {angle_desc}. {time_desc.capitalize()}. "
        f"{variety}"
        f"Professional landscaping, concrete driveway. "
        f"Shot on Phase One XF IQ4, architectural photography, no people, tack sharp, correct architectural proportions."
    )
    return prompt


def _build_room_prompt(
    project: dict, analysis: dict, bp_vision: dict,
    style: str, room_name: str, room_sqft: int, user_context: str,
    room_type: str | None = None, variety_seed: int | None = None,
) -> str:
    bp_type_raw       = project.get("blueprint_type") or "residential"
    building_type_key = _normalize_building_type(bp_type_raw)
    bp_type_label     = bp_type_raw.replace("_", " ")

    style_desc = {
        "modern":       "modern minimalist interior, neutral palette, recessed lighting, clean lines",
        "traditional":  "traditional interior, crown molding, warm wood tones, classic furniture",
        "farmhouse":    "modern farmhouse interior, shiplap accent wall, open shelving, warm neutrals",
        "contemporary": "contemporary interior, statement lighting, mixed textures, open plan",
        "craftsman":    "craftsman interior, built-in bookshelves, warm wood trim, mission-style furniture",
    }.get(style, "modern minimalist interior, neutral palette")

    vision_str = bp_vision.get("style_cues", "")
    sqft_str   = f"approximately {room_sqft} sq ft, " if room_sqft else ""

    # If the caller didn't pre-resolve a room type, do it here as a safety net.
    if not room_type:
        room_type = _infer_room_type(room_name, building_type_key, 0, room_sqft)

    # Rough spatial-awareness nudge. Prevents the "bedroom bigger than a gym" bug.
    if room_sqft:
        size_nudge = (
            f"Room size approximately {room_sqft} sq ft — use human-scale furniture "
            f"proportional to this size. Do not exaggerate scale. "
        )
    else:
        size_nudge = "Use human-scale furniture with realistic proportions. Do not exaggerate scale. "

    # Context-appropriate furnishings cue. Retail/warehouse don't get "tasteful
    # furniture, hardwood floors" — they get racks, fixtures, etc.
    furnishings = {
        "retail":    "retail fixtures and display shelving, commercial-grade flooring, recessed lighting",
        "warehouse": "industrial shelving, concrete floors, exposed steel structure, high-bay lighting",
        "office":    "office furniture, commercial carpet or polished concrete, acoustic ceiling, task lighting",
        "commercial":"commercial-grade finishes, appropriate fixtures, professional lighting",
        "residential":"natural light from large windows, hardwood floors, high ceilings, tasteful furniture",
    }.get(building_type_key, "natural light from large windows, hardwood floors, tasteful furniture")

    # Variety nudge: subtle per-call scene variation so Gemini regenerates differ.
    variety = ""
    if variety_seed is not None:
        rng     = random.Random(variety_seed)
        light   = rng.choice(_VARIETY_LIGHTING)
        cam     = rng.choice(_VARIETY_CAMERA)
        variety = f"{light.capitalize()}, {cam}. "

    # user_context is the most specific, user-authored guidance — lead with it.
    lead = f"{user_context.strip().rstrip('.')}. " if user_context else ""

    prompt = (
        f"Ultra-photorealistic interior render, 8K quality. "
        f"{lead}"
        f"{bp_type_label} {room_type}, {style_desc}"
        f"{', ' + vision_str if vision_str else ''}, "
        f"{sqft_str}{furnishings}. "
        f"{size_nudge}"
        f"{variety}"
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


async def _generate_via_fal(prompt: str, seed: int = 0) -> str:
    """
    fal.ai FLUX.1.1-pro — best quality, no rate limits, all images run concurrently.
    ~$0.03/image. Returns base64 data URI.

    A non-zero `seed` is forwarded so the caller can vary output per regenerate.
    """
    import fal_client

    # fal_client reads FAL_KEY env var
    os.environ.setdefault("FAL_KEY", _fal_key())

    def _run():
        args = {
            "prompt":               prompt,
            "image_size":           "landscape_4_3",
            "num_inference_steps":  28,
            "guidance_scale":       3.5,
            "num_images":           1,
            "safety_tolerance":     "2",
            "output_format":        "jpeg",
        }
        if seed:
            args["seed"] = int(seed)
        result = fal_client.run("fal-ai/flux-pro/v1.1", arguments=args)
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

    # Gemini image-gen models, current as of 2026-04. "Nano Banana" (2.5-flash-image)
    # is the stable production endpoint; the preview alias is the fallback when
    # the stable one is rate-limited.
    MODELS = [
        "gemini-2.5-flash-image",
        "gemini-2.5-flash-image-preview",
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


async def _generate_via_replicate(prompt: str, seed: int = 0) -> str:
    auth = {"Authorization": f"Token {settings.REPLICATE_API_KEY}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{REPLICATE_API}/models/{SDXL_MODEL}", headers=auth)
        r.raise_for_status()
        version = r.json()["latest_version"]["id"]

    input_payload: dict = {
        "prompt": prompt, "negative_prompt": NEGATIVE_PROMPT,
        "num_inference_steps": 40, "guidance_scale": 7.5,
        "width": 1024, "height": 768,
        "refine": "expert_ensemble_refiner", "high_noise_frac": 0.8,
    }
    if seed:
        input_payload["seed"] = int(seed)

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{REPLICATE_API}/predictions",
            headers=auth,
            json={"version": version, "input": input_payload},
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


async def _generate_via_fal_i2i(
    prompt: str, reference_url: str, strength: float = 0.65, seed: int = 0,
) -> str:
    """
    fal.ai FLUX image-to-image. `reference_url` may be an http(s) URL or a
    base64 `data:` URL — fal_client accepts both.

    `strength` is how much the model is allowed to deviate from the reference:
    0.0 = identical to reference, 1.0 = pure text-to-image. 0.6–0.7 keeps the
    building geometry while letting the angle change.
    """
    import fal_client

    os.environ.setdefault("FAL_KEY", _fal_key())

    def _run():
        args = {
            "prompt":              prompt,
            "image_url":           reference_url,
            "strength":            strength,
            "num_inference_steps": 28,
            "guidance_scale":      3.5,
            "num_images":          1,
            "safety_tolerance":    "2",
            "output_format":       "jpeg",
        }
        if seed:
            args["seed"] = int(seed)
        result = fal_client.run("fal-ai/flux/dev/image-to-image", arguments=args)
        return result["images"][0]["url"]

    image_url = await asyncio.wait_for(asyncio.to_thread(_run), timeout=90)

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(image_url)
        r.raise_for_status()
        return "data:image/jpeg;base64," + base64.b64encode(r.content).decode()


async def _decode_reference_to_bytes(reference: str) -> tuple[bytes, str]:
    """Pull (raw_bytes, mime) from a `data:` URL or http(s) URL."""
    if reference.startswith("data:"):
        header, _, b64 = reference.partition(",")
        mime = header.split(";")[0][5:] or "image/jpeg"
        return base64.b64decode(b64), mime
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(reference)
        r.raise_for_status()
        mime = r.headers.get("content-type", "image/jpeg").split(";")[0]
        return r.content, mime


def _gemini_i2i_call(prompt: str, ref_bytes: bytes, ref_mime: str = "image/jpeg") -> str:
    """Sync Gemini call with a reference image. Same model list as text-only."""
    from google import genai
    from google.genai import types

    MODELS = [
        "gemini-2.5-flash-image",
        "gemini-2.5-flash-image-preview",
    ]
    client = genai.Client(api_key=settings.GEMINI_API_KEY)
    contents = [
        types.Part.from_bytes(data=ref_bytes, mime_type=ref_mime),
        prompt,
    ]
    last_err: Exception = ValueError("No models tried")
    for model in MODELS:
        try:
            response = client.models.generate_content(
                model=model,
                contents=contents,
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
            log.warning(f"[Renders] Gemini i2i {model!r}: {e}")
    raise last_err


async def _generate_via_gemini_i2i(prompt: str, ref_bytes: bytes, ref_mime: str) -> str:
    async with _get_gemini_sem():
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(_gemini_i2i_call, prompt, ref_bytes, ref_mime),
                timeout=30,
            )
        finally:
            await asyncio.sleep(10)


async def _generate_image_i2i(prompt: str, reference: str, seed: int = 0) -> str:
    """
    Image-to-image generation seeded with a reference. Used for keeping the
    side/rear exterior renders on-model with the front render.

    Falls back to text-to-image if no i2i-capable provider succeeds, so the
    caller still gets *some* image rather than an exception.
    """
    if _fal_key():
        try:
            return await _generate_via_fal_i2i(prompt, reference, strength=0.65, seed=seed)
        except Exception as e:
            log.warning(f"[Renders] fal.ai i2i failed: {e}")

    if settings.GEMINI_API_KEY:
        try:
            ref_bytes, ref_mime = await _decode_reference_to_bytes(reference)
            return await _generate_via_gemini_i2i(prompt, ref_bytes, ref_mime)
        except Exception as e:
            log.warning(f"[Renders] Gemini i2i failed: {e}")

    log.warning("[Renders] No i2i provider succeeded — falling back to text-only")
    return await _generate_image(prompt, seed)


async def _generate_image(prompt: str, seed: int = 0) -> str:
    """
    Try providers in priority order. Always returns a string — never raises.
    fal.ai → Gemini → HuggingFace → Replicate → Pollinations URL

    `seed` is forwarded to every provider that accepts one (fal.ai, Replicate,
    Pollinations) so regenerates produce different images. Gemini/HF don't
    accept a seed — variety for those providers is baked into the prompt itself
    via `_build_*_prompt(variety_seed=...)` at the call site.
    """
    if _fal_key():
        try:
            return await _generate_via_fal(prompt, seed=seed)
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
            return await _generate_via_replicate(prompt, seed=seed)
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
    # Fresh seed on every call — this is the primary mechanism that keeps
    # regenerates from looking identical on seed-capable providers (fal.ai,
    # Replicate, Pollinations). For providers that don't accept a seed
    # (Gemini, HF), we also pass the per-image seed to the prompt builder so
    # it can inject a subtle scene-variety nudge derived from that seed.
    base_seed    = random.randint(100, 9999)

    # Resolve each room's type once up front so the prompt and the output label
    # agree, and so we never generate a bedroom for a retail/warehouse project.
    building_type_key = _normalize_building_type(project.get("blueprint_type"))
    resolved_rooms: list[dict] = []
    for j, room in enumerate(rooms):
        raw_name = room.get("name", f"Room {j+1}")
        sqft_i   = int(room.get("sqft", 0) or 0)
        rtype    = _infer_room_type(raw_name, building_type_key, j, sqft_i)
        resolved_rooms.append({
            "raw_name":  raw_name,
            "sqft":      sqft_i,
            "room_type": rtype,
            # Display label: prefer the resolved room type (title-cased) so
            # clients see "Kitchen" instead of "Room 2". Keep "#N" when there
            # are multiple rooms of the same type.
            "label":     rtype.title(),
        })

    # Disambiguate duplicate labels ("Bedroom" → "Bedroom 1", "Bedroom 2", …).
    from collections import Counter
    counts = Counter(r["label"] for r in resolved_rooms)
    seen:   dict[str, int] = {}
    for r in resolved_rooms:
        if counts[r["label"]] > 1:
            seen[r["label"]] = seen.get(r["label"], 0) + 1
            r["label"] = f"{r['label']} {seen[r['label']]}"

    # Exterior views: lock the seed AND the variety nudge across all 4 angles
    # so we get "same building from 4 sides", not 4 different buildings. Single-
    # shot t2i can't guarantee geometric identity across angles, but a shared
    # seed + identical building description block gets us the closest possible
    # result on seed-aware providers (fal.ai, Replicate) without an i2i pass.
    exterior_seed = base_seed
    exterior_pairs = [
        (
            _build_exterior_prompt(
                project, analysis, bp_vision, request.style, request.time_of_day,
                angle_desc, user_context, variety_seed=None,
            ),
            exterior_seed,
        )
        for _, angle_desc in EXTERIOR_ANGLES
    ]
    room_pairs = [
        (
            _build_room_prompt(
                project, analysis, bp_vision, request.style,
                r["raw_name"], r["sqft"], user_context,
                room_type=r["room_type"], variety_seed=base_seed + 4 + j,
            ),
            base_seed + 4 + j,
        )
        for j, r in enumerate(resolved_rooms)
    ]

    # Strategy:
    # - Generate the FRONT exterior with text-to-image first.
    # - Use that front render as a reference image for the other 3 exterior
    #   angles (image-to-image) so they show the same building, not 4
    #   different houses.
    # - Rooms run in parallel with the front render — they don't need a
    #   reference and we don't want to block them on the i2i ladder.
    # - If the front render itself fails, fall back to plain t2i for all
    #   four angles so the user still gets something.
    front_prompt, front_seed = exterior_pairs[0]
    front_task = asyncio.create_task(_generate_image(front_prompt, front_seed))
    room_tasks = [
        asyncio.create_task(_generate_image(prompt, seed))
        for prompt, seed in room_pairs
    ]

    front_result: object
    front_img: str | None = None
    try:
        front_img = await front_task
        front_result = front_img
    except Exception as e:
        log.warning(f"[Renders] Front exterior render failed — falling back to t2i for all angles: {e}")
        front_result = e

    if front_img:
        side_results = await asyncio.gather(
            *[
                _generate_image_i2i(prompt, front_img, seed)
                for prompt, seed in exterior_pairs[1:]
            ],
            return_exceptions=True,
        )
    else:
        side_results = await asyncio.gather(
            *[_generate_image(prompt, seed) for prompt, seed in exterior_pairs[1:]],
            return_exceptions=True,
        )

    room_results = await asyncio.gather(*room_tasks, return_exceptions=True)
    all_results = [front_result, *side_results, *room_results]

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
        {
            "name":      resolved_rooms[j]["label"] if j < len(resolved_rooms) else f"Room {j+1}",
            "room_type": resolved_rooms[j]["room_type"] if j < len(resolved_rooms) else None,
            "url":       _url(r),
        }
        for j, r in enumerate(room_results)
    ]

    return {
        "exterior_views":    exterior_views,
        "room_renders":      room_renders,
        "style":             request.style,
        "time_of_day":       request.time_of_day,
        "blueprint_context": bp_vision,
        "building_type":     building_type_key,
    }
