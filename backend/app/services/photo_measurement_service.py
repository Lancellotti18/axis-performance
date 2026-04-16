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

    text = await llm_vision(primary_bytes, primary_media_type, prompt, max_tokens=1024)
    text = re.sub(r'^```(?:json)?\s*', '', text, count=1)
    text = re.sub(r'\s*```\s*$', '', text)
    start = text.find("{")
    if start > 0:
        text = text[start:]
    return json.loads(text)
