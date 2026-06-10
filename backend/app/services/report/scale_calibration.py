"""
APIR scale calibration — pixels-per-foot from satellite imagery.

Priority order (use the first method that succeeds):

  A. WEB_MERCATOR  — exact from tile zoom + latitude. Used when the
     satellite image came from a tile provider (Esri/MapTiler/Mapbox).
     Mathematically exact; no AI needed.
  B. REFERENCE_OBJECT — AI vision finds a known-size object (car,
     garage door, HVAC) and reports its pixel dimensions. Used for
     uploaded photos that aren't tile-based.
  C. GSD — if image metadata includes ground-sample-distance in cm/px.
  D. ESTIMATED — last resort. Use the contractor's footprint polygon
     and assume the longest wall is 40 ft. Flagged "estimated" so the
     UI shows an amber warning banner.

The original APIR spec ordered these GSD → REFERENCE_OBJECT → ESTIMATED.
We added WEB_MERCATOR as priority 0 because Axis serves tiles whose
zoom + lat are known exactly — that's more accurate than detecting a car.
"""
from __future__ import annotations

import json
import logging
import math
from typing import Optional

from app.schemas.apir import PointPx, ScalingFactor
from app.services.report.geometry import _pixel_distance

logger = logging.getLogger(__name__)


# Earth circumference at equator (meters)
WEB_MERCATOR_BASE_RES_M = 156543.03392
METERS_PER_FOOT = 0.3048


# ─────────────────────────────────────────────────────────────────────────
# Method A — Web Mercator (preferred for tile-based imagery)
# ─────────────────────────────────────────────────────────────────────────

def web_mercator_meters_per_pixel(zoom: int, latitude_deg: float) -> float:
    """
    Standard Web Mercator scale formula:
        m/px = 156543.03392 × cos(lat) / 2^zoom

    At zoom 22, latitude 35°N → 156543.03392 × cos(35°) / 4194304 ≈ 0.0306 m/px
    That's 0.1004 ft/px ≈ 9.96 px/ft. Exact, no AI.
    """
    lat_rad = math.radians(latitude_deg)
    return WEB_MERCATOR_BASE_RES_M * math.cos(lat_rad) / (2 ** zoom)


def web_mercator_pixels_per_foot(
    zoom: int,
    latitude_deg: float,
    retina_factor: int = 2,
) -> float:
    """
    px/ft for the actual rendered image size. retina_factor=2 because Axis
    fetches @2x tiles at z22 — pixel count is doubled, so px/ft is doubled.
    """
    m_per_px = web_mercator_meters_per_pixel(zoom, latitude_deg)
    ft_per_px = m_per_px / METERS_PER_FOOT
    if ft_per_px <= 0:
        return 0.0
    return retina_factor / ft_per_px


def calibrate_web_mercator(
    zoom: int, latitude_deg: float, retina_factor: int = 2
) -> ScalingFactor:
    """Build a ScalingFactor from known tile metadata."""
    ppf = web_mercator_pixels_per_foot(zoom, latitude_deg, retina_factor)
    return ScalingFactor(
        pixels_per_foot=ppf,
        method="web_mercator",
        confidence="high",
        reference_description=(
            f"Web Mercator tile at z{zoom}, lat {latitude_deg:.4f}°, "
            f"@{retina_factor}x retina ({ppf:.3f} px/ft)"
        ),
    )


# ─────────────────────────────────────────────────────────────────────────
# Method B — AI-detected reference object (uploaded photos)
# ─────────────────────────────────────────────────────────────────────────

# APIR's spec prompt — keep verbatim so accuracy targets match the spec.
REFERENCE_OBJECT_PROMPT = """\
Look at this satellite/aerial image. Find ONE of the following reference \
objects and report its pixel dimensions as precisely as possible:

1. A standard passenger car or SUV (length = 14-16 feet, width = 5.5-6.5 feet)
2. A standard residential driveway width (9-10 feet per lane)
3. A standard residential garage door (8 feet wide for single, 16 feet for double)
4. A standard HVAC condenser unit (approximately 2.5 feet × 2.5 feet square)
5. A standard residential window (approximately 3 feet wide × 4 feet tall)

Report the object you found, its type, and its pixel coordinates as:
{
  "found": true,
  "reference_type": "car",
  "real_world_dimension": "length",
  "real_world_ft": 15,
  "pixel_length": 48,
  "pixel_start": {"x": 210, "y": 445},
  "pixel_end": {"x": 258, "y": 445},
  "confidence": "high"
}

If you cannot find any of these objects with confidence, return {"found": false}.
Respond with the JSON object only, no surrounding text.\
"""


async def calibrate_from_reference_object(
    image_bytes: bytes, media_type: str = "image/png"
) -> Optional[ScalingFactor]:
    """
    Send the satellite image to Gemini Vision, parse the reference-object
    response, and convert pixel-length → pixels-per-foot.
    Returns None if no reference object was found (caller should fall back).
    """
    from app.services.llm import llm_vision  # local import — avoids cold-path cost

    try:
        raw = await llm_vision(
            image_bytes=image_bytes,
            media_type=media_type,
            prompt=REFERENCE_OBJECT_PROMPT,
            max_tokens=400,
        )
    except Exception as e:
        logger.warning("reference-object vision call failed: %s", e)
        return None

    parsed = _parse_json_tolerant(raw)
    if not parsed or not parsed.get("found"):
        return None

    try:
        pixel_length = float(parsed["pixel_length"])
        real_world_ft = float(parsed["real_world_ft"])
        if real_world_ft <= 0 or pixel_length <= 0:
            return None
        ppf = pixel_length / real_world_ft
    except (KeyError, TypeError, ValueError):
        return None

    confidence = parsed.get("confidence", "medium")
    if confidence not in ("high", "medium"):
        confidence = "medium"

    ref_type = parsed.get("reference_type", "unknown")
    return ScalingFactor(
        pixels_per_foot=ppf,
        method="reference_object",
        confidence=confidence,
        reference_description=(
            f"AI-detected {ref_type} ({pixel_length:.0f}px = {real_world_ft:.1f}ft)"
        ),
    )


# ─────────────────────────────────────────────────────────────────────────
# Method C — GSD from image metadata
# ─────────────────────────────────────────────────────────────────────────

def calibrate_from_gsd(gsd_cm_per_px: float) -> ScalingFactor:
    """gsd_cm_per_px = ground sample distance from image EXIF / metadata."""
    if gsd_cm_per_px <= 0:
        # Shouldn't happen — caller validates — but defend anyway.
        return _estimated_fallback_marker(0.0)
    ppf = (1.0 / gsd_cm_per_px) * 30.48  # 1 ft = 30.48 cm
    return ScalingFactor(
        pixels_per_foot=ppf,
        method="gsd",
        confidence="high",
        reference_description=f"GSD metadata ({gsd_cm_per_px:.2f} cm/px)",
    )


# ─────────────────────────────────────────────────────────────────────────
# Method D — estimated fallback from footprint polygon
# ─────────────────────────────────────────────────────────────────────────

def calibrate_from_footprint_estimate(
    footprint_polygon: list[PointPx],
    assumed_longest_wall_ft: float = 40.0,
) -> ScalingFactor:
    """
    Fallback when no other method works. Assume the longest wall of the
    contractor-drawn footprint outline is `assumed_longest_wall_ft` (40ft
    is APIR's default for "standard residential"). Flagged "estimated"
    so the UI shows an amber warning banner.
    """
    if not footprint_polygon or len(footprint_polygon) < 3:
        # Truly degenerate — emit a marker so the caller can decide what to do
        return _estimated_fallback_marker(0.0)

    longest_px = 0.0
    n = len(footprint_polygon)
    for i in range(n):
        j = (i + 1) % n
        d = _pixel_distance(footprint_polygon[i], footprint_polygon[j])
        if d > longest_px:
            longest_px = d
    if longest_px <= 0 or assumed_longest_wall_ft <= 0:
        return _estimated_fallback_marker(0.0)
    ppf = longest_px / assumed_longest_wall_ft
    return ScalingFactor(
        pixels_per_foot=ppf,
        method="estimated",
        confidence="estimated",
        reference_description=(
            f"Estimated — longest footprint wall ({longest_px:.0f}px) "
            f"assumed = {assumed_longest_wall_ft:.0f}ft"
        ),
    )


def _estimated_fallback_marker(ppf: float) -> ScalingFactor:
    """Truly-degenerate fallback so the caller can still build a ScalingFactor."""
    return ScalingFactor(
        pixels_per_foot=max(ppf, 1.0),
        method="estimated",
        confidence="estimated",
        reference_description="Estimated — no usable calibration source",
    )


# ─────────────────────────────────────────────────────────────────────────
# Orchestrator — try methods in priority order
# ─────────────────────────────────────────────────────────────────────────

async def calibrate_scale(
    *,
    image_bytes: Optional[bytes] = None,
    media_type: str = "image/png",
    zoom: Optional[int] = None,
    latitude_deg: Optional[float] = None,
    retina_factor: int = 2,
    gsd_cm_per_px: Optional[float] = None,
    footprint_polygon: Optional[list[PointPx]] = None,
) -> ScalingFactor:
    """
    Try calibration methods in priority order — return the first that succeeds.

    Priority: web_mercator → gsd → reference_object → estimated

    Note: web_mercator is checked FIRST because Axis serves tiles whose
    zoom + lat are known exactly. APIR's spec ordered gsd → reference_object
    → estimated; we inserted web_mercator at position 0.
    """
    # A. Web Mercator (preferred when we have tile metadata)
    if zoom is not None and latitude_deg is not None:
        return calibrate_web_mercator(zoom, latitude_deg, retina_factor)

    # C. GSD from metadata (rare for tile imagery; common for drone)
    if gsd_cm_per_px is not None and gsd_cm_per_px > 0:
        return calibrate_from_gsd(gsd_cm_per_px)

    # B. AI reference object (slowest — burns a Gemini call)
    if image_bytes:
        ref_result = await calibrate_from_reference_object(image_bytes, media_type)
        if ref_result is not None:
            return ref_result

    # D. Footprint estimate
    if footprint_polygon and len(footprint_polygon) >= 3:
        return calibrate_from_footprint_estimate(footprint_polygon)

    # Nothing worked
    return _estimated_fallback_marker(0.0)


# ─────────────────────────────────────────────────────────────────────────
# JSON parsing helper (tolerant of code fences / preambles from the LLM)
# ─────────────────────────────────────────────────────────────────────────

def _parse_json_tolerant(text: str) -> Optional[dict]:
    """
    Strip ```json / ``` fences and any preamble before the first '{', then
    parse. Returns None on any failure (caller treats as "not found").
    """
    if not text:
        return None
    s = text.strip()
    # Strip Markdown fences
    if s.startswith("```"):
        s = s.split("```", 2)
        s = s[1] if len(s) >= 2 else ""
        if s.startswith("json"):
            s = s[4:]
        s = s.strip()
    # Locate the JSON object body
    start = s.find("{")
    end = s.rfind("}")
    if start < 0 or end < 0 or end < start:
        return None
    try:
        return json.loads(s[start:end + 1])
    except json.JSONDecodeError:
        return None
