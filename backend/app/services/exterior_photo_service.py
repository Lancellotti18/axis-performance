"""
Axis Performance — Exterior photo classification + observation service.

Uses Gemini Vision (via llm_vision) to:
  1. Classify each uploaded photo by elevation (front/right/rear/left/corner/etc.)
  2. Produce QUALITATIVE observations the contractor can use to pick the right
     photo when tracing — material guess, openings visible, prominent features.

CRITICAL: nothing in this service produces a dimension. It only tells the
contractor "this looks like a front elevation shot of a vinyl-sided wall with
2 windows" so they can quickly find the right photo to trace. Every dimension
in the report comes from a contractor trace with a known scale anchor.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

import httpx

from app.services.llm import llm_vision

logger = logging.getLogger(__name__)


ELEVATION_LABELS = {
    "front", "right", "rear", "left",
    "front_right", "right_rear", "rear_left", "left_front",
    "aerial", "detail", "unknown",
}

MATERIAL_LABELS = {
    "vinyl", "fiber_cement", "wood", "brick", "stone", "stucco", "metal", "other", "unknown",
}


_CLASSIFY_PROMPT = """You are an exterior measurement assistant analyzing one photo of a residential property.

TASK: Classify this photo and describe what you see. Be honest — if the image is
blurry, dark, or you cannot tell what elevation it is, say so.

You are NOT being asked to measure anything. Do not estimate any dimensions in
feet or inches. Your output is used by a contractor to find the right photo
when they trace measurements manually.

Return ONLY valid JSON (no prose before or after):
{
  "elevation": "front|right|rear|left|front_right|right_rear|rear_left|left_front|aerial|detail|unknown",
  "elevation_confidence": 0.85,
  "siding_material_guess": "vinyl|fiber_cement|wood|brick|stone|stucco|metal|other|unknown",
  "material_confidence": 0.7,
  "openings_visible": 3,
  "features": ["chimney", "gable_end", "dormer", "porch", "garage_door", "shutters", "gutter"],
  "photo_quality": "clear|acceptable|poor",
  "notes": "Brief honest summary of what is visible and any caveats."
}

Guidance:
- "elevation": the predominant face of the home visible in this photo. Corner photos
  (showing two adjacent walls) use the corner labels (front_right, etc.).
- "elevation_confidence": 0.0..1.0. Use < 0.5 if you genuinely can't tell.
- "siding_material_guess" is for the LARGEST visible exterior wall material.
  Use "unknown" if the material is occluded or ambiguous.
- "openings_visible" is the COUNT of distinct windows + doors clearly visible.
  Not a measurement, not a list.
- "features" lists notable items the contractor should know about; choose only
  from the listed values. Empty array if none.
- "photo_quality" reflects whether this photo is usable for tracing: clear =
  sharp + well-lit; acceptable = usable but suboptimal; poor = retake recommended.
"""


async def classify_photo(image_url: str) -> dict[str, Any]:
    """
    Fetch the photo, send to Gemini Vision, return a normalized classification
    dict. Failure cases return a safe default ('unknown' elevation, 0 confidence,
    'poor' quality) so a single bad photo doesn't crash a job.
    """
    image_bytes, media_type = await _download(image_url)
    if not image_bytes:
        return _unknown_result("could not download photo")

    try:
        text = await llm_vision(image_bytes, media_type, _CLASSIFY_PROMPT, max_tokens=600)
    except Exception as e:
        logger.warning("exterior_photo: vision call failed for %s: %s", image_url, e)
        return _unknown_result(f"vision call failed: {str(e)[:120]}")

    parsed = _parse_json(text)
    if not parsed:
        logger.info("exterior_photo: vision returned unparseable JSON: %r", (text or "")[:300])
        return _unknown_result("vision returned non-JSON")

    return _normalize(parsed)


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

async def _download(url: str) -> tuple[bytes | None, str]:
    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as http:
            r = await http.get(url)
            r.raise_for_status()
            mt = (r.headers.get("content-type") or "image/jpeg").split(";")[0].strip()
            if mt not in ("image/jpeg", "image/png", "image/webp"):
                # Gemini handles JPEG/PNG/WebP best — fall back if HEIC
                mt = "image/jpeg"
            return r.content, mt
    except Exception as e:
        logger.info("exterior_photo: download failed %s: %s", url, e)
        return None, "image/jpeg"


def _parse_json(text: str) -> dict | None:
    if not text:
        return None
    s = text.strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"\s*```\s*$", "", s)
    a, b = s.find("{"), s.rfind("}")
    if a < 0 or b < 0:
        return None
    try:
        v = json.loads(s[a:b + 1])
        return v if isinstance(v, dict) else None
    except Exception:
        return None


def _normalize(raw: dict) -> dict[str, Any]:
    """Coerce vision output into the strict schema we store."""
    elevation = str(raw.get("elevation") or "unknown").lower().replace("-", "_")
    if elevation not in ELEVATION_LABELS:
        elevation = "unknown"

    material = str(raw.get("siding_material_guess") or "unknown").lower().replace(" ", "_")
    if material not in MATERIAL_LABELS:
        material = "unknown"

    quality = str(raw.get("photo_quality") or "acceptable").lower()
    if quality not in ("clear", "acceptable", "poor"):
        quality = "acceptable"

    features = raw.get("features") or []
    if not isinstance(features, list):
        features = []
    features = [str(f).lower() for f in features if isinstance(f, (str, int))][:12]

    return {
        "classified_elevation": elevation,
        "classification_confidence": _f01(raw.get("elevation_confidence")),
        "vision_observations": {
            "siding_material_guess": material,
            "material_confidence": _f01(raw.get("material_confidence")),
            "openings_visible": int(raw.get("openings_visible") or 0),
            "features": features,
            "photo_quality": quality,
            "notes": (str(raw.get("notes") or "")[:400]),
        },
    }


def _unknown_result(reason: str) -> dict[str, Any]:
    return {
        "classified_elevation": "unknown",
        "classification_confidence": 0.0,
        "vision_observations": {
            "siding_material_guess": "unknown",
            "material_confidence": 0.0,
            "openings_visible": 0,
            "features": [],
            "photo_quality": "poor",
            "notes": reason,
        },
    }


def _f01(v: Any) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    if f < 0:
        return 0.0
    if f > 1:
        f = f / 100.0 if f <= 100 else 1.0
    return max(0.0, min(1.0, f))


# ----------------------------------------------------------------------------
# Coverage map computation
# ----------------------------------------------------------------------------

# Minimum photos per elevation to consider that elevation "covered" enough for
# manual tracing. Below this we flag the elevation in the UI as needing more
# photos. Numbers come from common contractor capture protocols (one straight-on
# + one angled view per face).
MIN_PHOTOS_PER_ELEVATION = 1
RECOMMENDED_PHOTOS_PER_ELEVATION = 2


def coverage_map(photos: list[dict]) -> dict[str, dict]:
    """
    Given a list of photo rows (from exterior_photos), return a per-elevation
    coverage status used by the frontend coverage map UI.

    Output:
      {
        "front":   {"count": 3, "status": "good"},
        "right":   {"count": 1, "status": "minimal"},
        "rear":    {"count": 0, "status": "missing"},
        "left":    {"count": 2, "status": "good"},
        ...
      }
    """
    counts: dict[str, int] = {k: 0 for k in (
        "front", "right", "rear", "left",
        "front_right", "right_rear", "rear_left", "left_front",
        "aerial", "detail", "unknown",
    )}
    for p in photos:
        elev = (p.get("classified_elevation") or "unknown").lower()
        if elev in counts:
            counts[elev] += 1

    # Corner photos contribute half-credit to their two adjacent face counts —
    # a front_right photo shows half of front + half of right.
    cardinal = {"front": 0.0, "right": 0.0, "rear": 0.0, "left": 0.0}
    for face in cardinal:
        cardinal[face] += counts[face]
    cardinal["front"] += 0.5 * counts["front_right"] + 0.5 * counts["left_front"]
    cardinal["right"] += 0.5 * counts["front_right"] + 0.5 * counts["right_rear"]
    cardinal["rear"]  += 0.5 * counts["right_rear"]  + 0.5 * counts["rear_left"]
    cardinal["left"]  += 0.5 * counts["rear_left"]   + 0.5 * counts["left_front"]

    def _status(effective: float) -> str:
        if effective >= RECOMMENDED_PHOTOS_PER_ELEVATION:
            return "good"
        if effective >= MIN_PHOTOS_PER_ELEVATION:
            return "minimal"
        return "missing"

    return {
        face: {
            "count": counts[face],
            "effective_count": round(cardinal[face], 1),
            "status": _status(cardinal[face]),
        }
        for face in ("front", "right", "rear", "left")
    } | {
        face: {"count": counts[face], "status": "good" if counts[face] > 0 else "missing"}
        for face in ("front_right", "right_rear", "rear_left", "left_front", "aerial", "detail")
    }
