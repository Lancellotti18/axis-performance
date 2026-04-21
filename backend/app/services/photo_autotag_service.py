"""
Single-photo auto-tagging via Gemini vision.

CompanyCam-style metadata: one photo → structured tags the UI can render as
chips without the user having to hand-type them. Returns a normalized dict:

    {
        "phase": "before"|"during"|"after"|None,
        "area": "roof"|"kitchen"|"bathroom"|"exterior"|... ,
        "materials": ["asphalt shingles", ...],
        "damage": ["missing shingles", ...],
        "safety": ["scaffolding present", ...],
        "summary": "short human caption",
        "confidence": 0.0-1.0,
    }

Reliability strategy (matches photo_measurement_service):
  - Gemini JSON schema mode — model cannot emit prose that fails parsing.
  - Key × model rotation on transient errors.
  - Schema-rejection fallback to plain JSON mime mode.

Damage taxonomy is deliberately exhaustive — contractors building a damage
report need every visible defect flagged. False negatives cost claims; false
positives cost 30 seconds of the inspector's time to dismiss.
"""
import asyncio
import json
import logging
import re
from typing import Any, Optional

import httpx

from app.services.llm import (
    GEMINI_FALLBACKS,
    GEMINI_MODEL,
    _gemini_keys,
    _is_gemini_retryable,
    llm_vision_sync,
)

logger = logging.getLogger(__name__)


_PROMPT = """You are a senior roofing + exterior inspector analyzing a job-site photo. Your job is to flag EVERY visible defect — a contractor will use this to build a damage report for an insurance adjuster. Missing damage costs claim money; flagging something minor is fine.

Return a JSON object with this exact shape:
{
  "phase": "before" | "during" | "after" | null,
  "area": "roof" | "kitchen" | "bathroom" | "exterior" | "interior" | "foundation" | "framing" | "landscaping" | "gutters" | "chimney" | "windows" | "doors" | "siding" | "other" | null,
  "materials": [string, ...],       // visible materials, lowercase, max 8
  "damage": [string, ...],           // EVERY visible defect, lowercase, max 12
  "safety": [string, ...],           // safety concerns or PPE visible, max 4
  "summary": string,                 // 1 short sentence, <=200 chars
  "confidence": number               // 0.0-1.0 overall confidence
}

Damage taxonomy — flag any of these when you see them. Use specific terms:

ROOF (shingles / tiles / metal):
- missing shingles, lifted shingles, curled shingles, cupped shingles
- cracked shingles, split shingles, bald shingles, granule loss
- hail impact marks, hail bruising, wind damage, creased shingles
- exposed nails, popped nails, exposed underlayment, sagging deck
- moss growth, algae streaking, lichen, ponding water
- damaged ridge cap, damaged hip cap, blown-off caps
- worn/missing flashing, rusted flashing, separated flashing
- damaged pipe boot, dry-rotted pipe boot, damaged vent cap
- sagging roofline, uneven plane, visible rafters

SIDING / EXTERIOR WALLS:
- cracked siding, missing siding panels, warped siding, dented siding
- impact holes, hail marks on siding, woodpecker damage
- paint peeling, paint blistering, chalking, fading
- rotted wood, soft wood, water staining, efflorescence
- caulking failure, gap at trim, separated j-channel

GUTTERS + DOWNSPOUTS:
- detached gutters, sagging gutters, pulled-away gutters
- rust, holes, punctures, separation at seams
- missing gutter sections, missing downspouts, crushed downspouts
- clogged gutters, vegetation growing in gutters, overflowing stains

FASCIA / SOFFIT / EAVES:
- rotted fascia, damaged fascia, missing fascia
- damaged soffit, water-stained soffit, missing soffit vents, animal entry
- wasp nest, bird nest, squirrel damage

WINDOWS / DOORS:
- cracked glass, broken glass, shattered window
- fogged/failed seal, condensation between panes
- rotted sill, rotted frame, missing screen, broken screen
- damaged weatherstripping, sticking door, gap at threshold
- storm door damage

CHIMNEY:
- cracked mortar, missing mortar, spalling brick
- missing chimney cap, damaged crown, creosote staining
- leaning chimney, chimney flashing failure

FOUNDATION / DRAINAGE:
- vertical cracks, horizontal cracks, stair-step cracks
- settling, heaving, displacement
- efflorescence, moisture stain, pooling water, negative grading
- exposed rebar, spalled concrete

GENERAL:
- mold/mildew, water intrusion, active leak
- pest damage, termite trails, rodent damage
- storm debris, fallen tree limb, impact damage
- overgrown vegetation touching structure

Rules:
- If you cannot tell a field, use null (for scalars) or [] (for arrays). Do NOT fabricate.
- `damage` must be only visible defects. General wear is fine to omit.
- `summary` describes what's in the photo.
- When in doubt about damage, INCLUDE it — the contractor will filter. Missing damage is worse than extra.
"""


_AUTOTAG_SCHEMA = {
    "type": "object",
    "properties": {
        "phase": {"type": "string", "nullable": True},
        "area": {"type": "string", "nullable": True},
        "materials": {"type": "array", "items": {"type": "string"}},
        "damage": {"type": "array", "items": {"type": "string"}},
        "safety": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string", "nullable": True},
        "confidence": {"type": "number"},
    },
    "required": ["confidence", "damage", "materials", "safety"],
}


def _extract_json(text: str) -> Optional[dict]:
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def _normalize(raw: dict) -> dict:
    allowed_phases = {"before", "during", "after"}
    allowed_areas = {"roof", "kitchen", "bathroom", "exterior", "interior",
                     "foundation", "framing", "landscaping", "gutters",
                     "chimney", "windows", "doors", "siding", "other"}

    phase = raw.get("phase")
    if isinstance(phase, str):
        phase = phase.strip().lower()
        if phase not in allowed_phases:
            phase = None
    else:
        phase = None

    area = raw.get("area")
    if isinstance(area, str):
        area = area.strip().lower()
        if area not in allowed_areas:
            area = None
    else:
        area = None

    def _str_list(v: Any, cap: int) -> list[str]:
        if not isinstance(v, list):
            return []
        out: list[str] = []
        for item in v:
            if isinstance(item, str):
                s = item.strip().lower()
                if s and s not in out:
                    out.append(s)
            if len(out) >= cap:
                break
        return out

    summary = raw.get("summary")
    if isinstance(summary, str):
        summary = summary.strip()[:240]
    else:
        summary = None

    conf = raw.get("confidence")
    try:
        conf_f = float(conf) if conf is not None else 0.0
    except (TypeError, ValueError):
        conf_f = 0.0
    conf_f = max(0.0, min(1.0, conf_f))

    return {
        "phase": phase,
        "area": area,
        "materials": _str_list(raw.get("materials"), 8),
        "damage": _str_list(raw.get("damage"), 12),
        "safety": _str_list(raw.get("safety"), 4),
        "summary": summary,
        "confidence": conf_f,
    }


def _fetch_image(url: str, timeout: float = 15.0) -> Optional[tuple[bytes, str]]:
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
    except Exception as e:
        logger.warning("autotag: failed to fetch %s: %s", url, e)
        return None

    media = resp.headers.get("content-type", "image/jpeg").split(";")[0].strip()
    if not media.startswith("image/"):
        logger.warning("autotag: non-image content-type for %s: %s", url, media)
        return None
    return resp.content, media


def _gemini_autotag_sync(image_bytes: bytes, media_type: str) -> Optional[str]:
    """Gemini vision in JSON schema mode. Returns raw JSON text or None if
    Gemini isn't configured. Cycles keys × models on transient errors."""
    from google import genai
    from google.genai import types

    keys = _gemini_keys()
    if not keys:
        return None

    parts = [
        types.Part.from_bytes(data=image_bytes, mime_type=media_type),
        _PROMPT,
    ]
    models = [GEMINI_MODEL, *GEMINI_FALLBACKS]
    import time as _time

    last_err: Exception = RuntimeError("no Gemini attempt made")
    for pass_idx in range(2):
        for key in keys:
            client = genai.Client(api_key=key)
            for model in models:
                try:
                    response = client.models.generate_content(
                        model=model,
                        contents=parts,
                        config=types.GenerateContentConfig(
                            max_output_tokens=1024,
                            response_mime_type="application/json",
                            response_schema=_AUTOTAG_SCHEMA,
                            temperature=0.15,
                        ),
                    )
                    return response.text or ""
                except Exception as e:
                    last_err = e
                    msg = str(e).lower()
                    if "schema" in msg or "response_schema" in msg:
                        try:
                            response = client.models.generate_content(
                                model=model,
                                contents=parts,
                                config=types.GenerateContentConfig(
                                    max_output_tokens=1024,
                                    response_mime_type="application/json",
                                    temperature=0.15,
                                ),
                            )
                            return response.text or ""
                        except Exception as e2:
                            last_err = e2
                    if _is_gemini_retryable(str(e)):
                        _time.sleep(0.6 if pass_idx == 0 else 2.0)
                        continue
                    raise
        if pass_idx == 0:
            _time.sleep(1.5)
    raise last_err


def autotag_photo(url: str) -> dict:
    """Analyze a single photo URL and return CompanyCam-style tag metadata."""
    empty = {
        "phase": None, "area": None, "materials": [], "damage": [],
        "safety": [], "summary": None, "confidence": 0.0,
        "autotag_unverified": True,
    }

    fetched = _fetch_image(url)
    if fetched is None:
        return {**empty, "error": "fetch_failed"}
    image_bytes, media_type = fetched

    raw_text: Optional[str] = None
    try:
        raw_text = _gemini_autotag_sync(image_bytes, media_type)
    except Exception as e:
        logger.warning("autotag: gemini schema call failed: %s", e)

    # Fallback to the generic vision chain (Groq / Anthropic) if Gemini isn't
    # available or blew up. Without schema mode parsing may fail — that's fine,
    # we report unverified.
    if raw_text is None:
        try:
            raw_text = llm_vision_sync(
                image_bytes=image_bytes,
                media_type=media_type,
                prompt=_PROMPT,
                max_tokens=1024,
            )
        except Exception as e:
            logger.warning("autotag: vision chain failed: %s", e)
            return {**empty, "error": "vision_failed"}

    parsed = _extract_json(raw_text or "")
    if parsed is None:
        logger.warning("autotag: could not parse JSON from model output: %r", (raw_text or "")[:200])
        return {**empty, "error": "parse_failed"}

    normalized = _normalize(parsed)
    if (normalized["confidence"] < 0.2
            and not normalized["materials"]
            and not normalized["damage"]
            and normalized["phase"] is None
            and normalized["area"] is None):
        normalized["autotag_unverified"] = True
    return normalized


async def autotag_many(urls: list[str], concurrency: int = 3) -> list[dict]:
    """Tag N photo URLs concurrently with a semaphore to stay under Gemini
    per-minute limits. Returns results in the same order as urls."""
    sem = asyncio.Semaphore(concurrency)

    async def _one(u: str) -> dict:
        async with sem:
            return await asyncio.to_thread(autotag_photo, u)

    return await asyncio.gather(*[_one(u) for u in urls])
