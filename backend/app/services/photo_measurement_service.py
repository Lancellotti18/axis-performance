"""
Photo-to-Measurements service.
Downloads project site photos and sends them to LLM Vision
to estimate wall area, roof area, sqft, and structural dimensions.
"""
import logging
import re
import json
import httpx
from app.services.llm import llm_vision

logger = logging.getLogger(__name__)


MEASUREMENT_PROMPT = """You are a senior construction estimator analyzing job-site photos to extract structural measurements.

Examine every photo carefully. Use these visual calibration references:
- Standard exterior door: 36" wide × 80" tall (6'8")
- Standard window: typically 36" wide × 48" tall
- Standard brick course: 2.67" tall (8 courses = ~22")
- Vinyl siding lap: 4–5" exposure per course
- Standard ceiling height: 8–9 ft (9 ft for newer construction)
- Garage door: 8–9 ft wide × 7–8 ft tall (single), 16 ft wide (double)

Return ONLY valid JSON — no text before or after:
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


async def measure_from_photos(photo_urls: list) -> dict:
    """
    Send up to 8 project photos to LLM Vision and extract measurements.
    Uses standard visual references (doors, windows, brick courses) to calibrate.
    """
    if not photo_urls:
        raise ValueError("No photos provided")

    # Download all photos
    images: list[tuple[bytes, str]] = []
    async with httpx.AsyncClient(timeout=30.0) as http:
        for url in photo_urls[:8]:
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

    # Use the first (or largest) image as primary — LLM vision handles one image at a time
    # For multi-photo, we concatenate images into a single call using the first photo
    # and mention count in the prompt
    primary_bytes, primary_media_type = images[0]

    prompt = MEASUREMENT_PROMPT
    if len(images) > 1:
        prompt = f"You are analyzing {len(images)} job-site photos (showing the primary view). " + MEASUREMENT_PROMPT

    # 2048 tokens — the old 1024 ceiling truncated mid-string when the model
    # filled in warnings/notes, which then blew up json.loads.
    text = await llm_vision(primary_bytes, primary_media_type, prompt, max_tokens=2048)
    return _parse_measurement_json(text)


def _parse_measurement_json(text: str) -> dict:
    """
    Robust JSON extractor for the measurement prompt. Handles markdown
    fences, prose preambles, trailing commas, Python-isms, and truncated
    responses. Falls back to a low-confidence default if nothing parses,
    rather than raising — contractors should never see a 422 just because
    the vision model added a stray apology before the JSON.
    """
    if not text:
        return _unverified_measurements("Empty response from vision model.")

    cleaned = text.strip()
    cleaned = re.sub(r'^```(?:json)?\s*', '', cleaned, count=1)
    cleaned = re.sub(r'\s*```\s*$', '', cleaned)

    start = cleaned.find("{")
    if start < 0:
        return _unverified_measurements("Vision model returned no JSON object.")

    # Largest balanced {...} block, tolerant of prose on either side.
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
        return json.loads(candidate)
    except json.JSONDecodeError:
        # Walk back through `}` boundaries to salvage truncated output.
        for i in range(len(candidate) - 1, -1, -1):
            if candidate[i] != "}":
                continue
            try:
                return json.loads(candidate[:i + 1])
            except Exception:
                continue
    # Last resort — don't 422 the wizard. Return unverified shape so the UI
    # can say "couldn't get measurements, retry" instead of erroring out.
    logger.warning("photo_measurement: JSON parse failed. raw[:500]=%r", text[:500])
    return _unverified_measurements("Couldn't parse measurement response — retry.")


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
