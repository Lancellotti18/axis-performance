"""
Photo-to-Measurements service.
Downloads project site photos and sends them to Gemini vision
to estimate wall area, roof area, sqft, and structural dimensions.

Reliability strategy:
  1. Send up to 6 photos in a SINGLE multimodal request so the model
     reasons across elevations instead of guessing from one angle.
  2. Force application/json response so Gemini cannot emit prose that
     blows up json.loads(). This is the root-cause fix for the
     "Couldn't parse measurement response — retry" message.
  3. Cycle Gemini keys × models on transient errors (503/quota).
  4. On hard parse fail, retry once with an even stricter prompt
     before giving up with the low-confidence default.
"""
import asyncio
import json
import logging
import re

import httpx

from app.services.llm import (
    GEMINI_FALLBACKS,
    GEMINI_MODEL,
    _gemini_keys,
    _is_gemini_retryable,
)

logger = logging.getLogger(__name__)


MEASUREMENT_PROMPT = """You are a senior construction estimator analyzing job-site photos to extract structural measurements.

Examine every photo carefully. Use these visual calibration references:
- Standard exterior door: 36" wide × 80" tall (6'8")
- Standard window: typically 36" wide × 48" tall
- Standard brick course: 2.67" tall (8 courses = ~22")
- Vinyl siding lap: 4–5" exposure per course
- Standard ceiling height: 8–9 ft (9 ft for newer construction)
- Garage door: 8–9 ft wide × 7–8 ft tall (single), 16 ft wide (double)

Return a JSON object with this exact shape (no prose, no markdown):
{
  "total_sqft": 1800,
  "wall_area_sqft": 2640,
  "roof_area_sqft": 2050,
  "perimeter_ft": 176,
  "stories": 1,
  "wall_height_ft": 9,
  "structure_type": "Single-family residential",
  "dimensions": {
    "estimated_width_ft": 44,
    "estimated_depth_ft": 40
  },
  "confidence": 0.74,
  "notes": "Measurements calibrated against visible entry door (36x80) and window heights. Ranch-style slab construction. South and west elevations visible.",
  "warnings": ["East elevation not photographed — perimeter is estimated"]
}

Important rules:
- total_sqft = ground floor footprint (living area)
- wall_area_sqft = perimeter × wall height (all exterior wall faces, both floors if 2-story)
- roof_area_sqft = footprint × pitch multiplier + overhangs (typically 115–140% of footprint)
- confidence: 0.8–0.95 if multiple angles + clear reference objects; 0.5–0.7 if single angle or no references
- warnings: list any limitations (missing angles, obstructions, no scale reference, etc.)
- Be conservative — underestimating is safer than overestimating for bids
- Do NOT make up measurements — if you cannot determine a value from the photos, say so in warnings"""


# JSON schema Gemini will conform to when response_mime_type="application/json".
# Using a schema (vs. just json mime type) eliminates the remaining failure
# mode where the model emits a JSON string that doesn't match our shape.
MEASUREMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "total_sqft": {"type": "number", "nullable": True},
        "wall_area_sqft": {"type": "number", "nullable": True},
        "roof_area_sqft": {"type": "number", "nullable": True},
        "perimeter_ft": {"type": "number", "nullable": True},
        "stories": {"type": "number", "nullable": True},
        "wall_height_ft": {"type": "number", "nullable": True},
        "structure_type": {"type": "string", "nullable": True},
        "dimensions": {
            "type": "object",
            "properties": {
                "estimated_width_ft": {"type": "number", "nullable": True},
                "estimated_depth_ft": {"type": "number", "nullable": True},
            },
        },
        "confidence": {"type": "number"},
        "notes": {"type": "string"},
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["confidence"],
}


async def measure_from_photos(photo_urls: list) -> dict:
    """
    Send up to 6 project photos to Gemini vision and extract measurements.
    Uses standard visual references (doors, windows, brick courses) to calibrate.
    """
    if not photo_urls:
        raise ValueError("No photos provided")

    images: list[tuple[bytes, str]] = []
    async with httpx.AsyncClient(timeout=30.0) as http:
        for url in photo_urls[:6]:
            try:
                resp = await http.get(url, follow_redirects=True)
                if resp.status_code == 200:
                    media_type = resp.headers.get("content-type", "image/jpeg").split(";")[0].strip()
                    if media_type not in ("image/jpeg", "image/png", "image/gif", "image/webp"):
                        media_type = "image/jpeg"
                    images.append((resp.content, media_type))
            except Exception:
                logger.debug("photo download failed, skipping", exc_info=True)
                continue

    if not images:
        raise ValueError("Could not download any of the provided photos")

    # First attempt — strict JSON mode + schema.
    raw = await _gemini_measure(images, MEASUREMENT_PROMPT)
    parsed = _parse_measurement_json(raw)
    if not parsed.get("measurements_unverified"):
        return parsed

    # One retry with a firmer instruction — schema mode sometimes returns
    # `{"confidence": 0}` with nothing else if the first try short-circuited.
    retry_prompt = (
        "Your previous response was missing fields. Return the full measurement object "
        "for every field you can reasonably estimate from these photos. "
        "It is acceptable to mark low confidence — it is NOT acceptable to return "
        "only the confidence field.\n\n" + MEASUREMENT_PROMPT
    )
    raw2 = await _gemini_measure(images, retry_prompt)
    parsed2 = _parse_measurement_json(raw2)
    return parsed2


async def _gemini_measure(images: list[tuple[bytes, str]], prompt: str) -> str:
    """
    Send all provided images in one Gemini call with JSON response mode.
    Cycles keys and models on transient errors. Returns raw text
    (which will be a JSON string thanks to response_mime_type).
    """
    from google import genai
    from google.genai import types

    keys = _gemini_keys()
    if not keys:
        raise RuntimeError(
            "GEMINI_API_KEY not configured. Add it to the Render environment to enable photo measurements."
        )

    parts: list = []
    for img_bytes, mime in images:
        parts.append(types.Part.from_bytes(data=img_bytes, mime_type=mime))
    parts.append(f"You are analyzing {len(images)} job-site photos. {prompt}")

    def _run(api_key: str, model: str) -> str:
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model=model,
            contents=parts,
            config=types.GenerateContentConfig(
                max_output_tokens=2048,
                response_mime_type="application/json",
                response_schema=MEASUREMENT_SCHEMA,
                temperature=0.2,  # measurements should be stable, not creative
            ),
        )
        return response.text or ""

    models = [GEMINI_MODEL, *GEMINI_FALLBACKS]
    last_err: Exception = RuntimeError("no Gemini attempt made")
    for pass_idx in range(2):
        for key in keys:
            for model in models:
                try:
                    return await asyncio.wait_for(asyncio.to_thread(_run, key, model), timeout=120)
                except Exception as e:
                    last_err = e
                    if _is_gemini_retryable(str(e)):
                        await asyncio.sleep(0.6 if pass_idx == 0 else 2.0)
                        continue
                    # Non-retryable error on schema mode — try once without
                    # schema since some fallback models don't support it.
                    msg = str(e).lower()
                    if "schema" in msg or "response_schema" in msg or "mime" in msg:
                        try:
                            return await asyncio.wait_for(
                                asyncio.to_thread(_run_no_schema, key, model, parts),
                                timeout=120,
                            )
                        except Exception as e2:
                            last_err = e2
                            continue
                    raise
        if pass_idx == 0 and keys:
            await asyncio.sleep(1.5)
    raise last_err


def _run_no_schema(api_key: str, model: str, parts: list) -> str:
    """Fallback for models that reject response_schema — JSON mime only."""
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=model,
        contents=parts,
        config=types.GenerateContentConfig(
            max_output_tokens=2048,
            response_mime_type="application/json",
            temperature=0.2,
        ),
    )
    return response.text or ""


def _parse_measurement_json(text: str) -> dict:
    """
    Robust JSON extractor. With response_mime_type="application/json" this
    usually gets clean JSON, but keep the tolerant parser as a safety net
    for fallback models that don't honor the mime type.
    """
    if not text:
        return _unverified_measurements("Empty response from vision model.")

    cleaned = text.strip()
    cleaned = re.sub(r'^```(?:json)?\s*', '', cleaned, count=1)
    cleaned = re.sub(r'\s*```\s*$', '', cleaned)

    start = cleaned.find("{")
    if start < 0:
        return _unverified_measurements("Vision model returned no JSON object.")

    depth, end, in_str, escape = 0, -1, False, False
    for i in range(start, len(cleaned)):
        ch = cleaned[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i
                break

    candidate = cleaned[start:end + 1] if end > 0 else cleaned[start:]
    candidate = re.sub(r",\s*([}\]])", r"\1", candidate)
    candidate = re.sub(r"\bNone\b", "null", candidate)
    candidate = re.sub(r"\bTrue\b", "true", candidate)
    candidate = re.sub(r"\bFalse\b", "false", candidate)

    try:
        obj = json.loads(candidate)
    except json.JSONDecodeError:
        for i in range(len(candidate) - 1, -1, -1):
            if candidate[i] != "}":
                continue
            try:
                obj = json.loads(candidate[:i + 1])
                break
            except Exception:
                continue
        else:
            logger.warning("photo_measurement: JSON parse failed. raw[:500]=%r", text[:500])
            return _unverified_measurements("Couldn't parse measurement response — retry.")

    # Sanity check: if the model returned an almost-empty object (schema mode
    # sometimes emits just `{"confidence": 0}`), treat as unverified so the
    # retry path triggers.
    has_any_measurement = any(
        obj.get(k) for k in ("total_sqft", "wall_area_sqft", "roof_area_sqft", "perimeter_ft")
    )
    if not has_any_measurement:
        return _unverified_measurements("Model returned no measurements — retry.")
    return obj


def _unverified_measurements(reason: str) -> dict:
    return {
        "total_sqft": None,
        "wall_area_sqft": None,
        "roof_area_sqft": None,
        "perimeter_ft": None,
        "stories": None,
        "wall_height_ft": None,
        "structure_type": None,
        "dimensions": {"estimated_width_ft": None, "estimated_depth_ft": None},
        "confidence": 0.0,
        "measurements_unverified": True,
        "notes": reason,
        "warnings": [reason],
    }
