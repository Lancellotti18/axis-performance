"""
APIR vision prompts — Gemini Vision calls for the things satellite + math
can't tell us: pitch, wall height, openings, materials, soffit depth.

Each function:
  * Sends a single ground photo to llm_vision (Gemini → Groq → Claude
    fallback chain already wired in app.services.llm).
  * Parses a tolerant JSON response (handles ```json fences and preambles).
  * Returns a typed result with a fallback when AI fails — APIR's rule
    is "never abort the whole extraction; flag the single field as
    estimated and continue."

Prompts are kept ~verbatim from APIR Part 1 so behavior matches the spec's
stated accuracy targets. Tweaks are noted inline.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal, Optional

from app.schemas.apir import ScaleConfidence
from app.services.report.scale_calibration import _parse_json_tolerant

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────
# Pitch detection (APIR 1.4)
# ─────────────────────────────────────────────────────────────────────────

PITCH_PROMPT = """\
You are analyzing a ground-level photo of a residential property for roof pitch.

Look at the visible roof slope in this image. Estimate the pitch as rise/12 \
(how many inches the roof rises for every 12 inches of horizontal run).

Common residential pitches: 3/12, 4/12, 5/12, 6/12, 7/12, 8/12, 10/12, 12/12

Method 1 (gable end): If you can see a triangular gable end of the roof, \
measure the visual ratio of the triangle's height to its half-width.

Method 2 (slope angle): Estimate the visual angle of the roof surface.
  - 3/12 = approximately 14° from horizontal (very low)
  - 5/12 = approximately 23° from horizontal (moderate)
  - 8/12 = approximately 34° from horizontal (steep)
  - 12/12 = approximately 45° from horizontal (very steep)

Return ONLY a JSON object:
{
  "pitch": "5/12",
  "confidence": "high",
  "method": "gable_end",
  "notes": "brief description of what you measured"
}

Confidence must be one of: "high", "medium", "low".
Method must be one of: "gable_end", "slope_angle", "estimated".
Respond with the JSON object only, no surrounding text.\
"""


@dataclass
class PitchReadingResult:
    pitch: str
    confidence: ScaleConfidence
    method: Literal["gable_end", "slope_angle", "estimated"]
    notes: str = ""


async def detect_pitch(
    image_bytes: bytes, media_type: str = "image/jpeg"
) -> PitchReadingResult:
    """
    Returns a pitch reading. On failure: pitch='4/12', confidence='estimated'.
    APIR's default fallback per Part 1.9.
    """
    from app.services.llm import llm_vision

    try:
        raw = await llm_vision(
            image_bytes=image_bytes,
            media_type=media_type,
            prompt=PITCH_PROMPT,
            max_tokens=400,
        )
    except Exception as e:
        logger.warning("pitch vision call failed: %s", e)
        return _pitch_fallback()

    parsed = _parse_json_tolerant(raw)
    if not parsed or "pitch" not in parsed:
        return _pitch_fallback()

    pitch = str(parsed.get("pitch", "4/12")).strip()
    if "/" not in pitch:
        return _pitch_fallback()

    confidence_raw = str(parsed.get("confidence", "low")).lower()
    confidence: ScaleConfidence = (
        "high" if confidence_raw == "high"
        else "medium" if confidence_raw == "medium"
        else "estimated"
    )
    method = parsed.get("method", "estimated")
    if method not in ("gable_end", "slope_angle", "estimated"):
        method = "estimated"

    return PitchReadingResult(
        pitch=pitch,
        confidence=confidence,
        method=method,  # type: ignore[arg-type]
        notes=str(parsed.get("notes", ""))[:200],
    )


def _pitch_fallback() -> PitchReadingResult:
    return PitchReadingResult(
        pitch="4/12", confidence="estimated", method="estimated",
        notes="vision call failed or returned unparseable data",
    )


# ─────────────────────────────────────────────────────────────────────────
# Wall height + openings (APIR 1.5)
# ─────────────────────────────────────────────────────────────────────────

WALL_HEIGHT_PROMPT_TEMPLATE = """\
Analyze this photo of the {elevation} elevation of a residential property. \
Estimate the wall height from foundation to roofline in feet.

Look for these reference points:
- Standard door height = 6.67 feet (80 inches)
- Standard window height = typically 4–5 feet tall
- Standard story height = 8–9 feet for the main living area

Also identify and measure:
- Each window: estimate width × height in inches
- Each door: estimate width × height in inches
- Count shutters (and estimate their dimensions)
- Count vents/gable vents

Return ONLY a JSON object with this exact shape:
{{
  "wall_height_ft": 8.5,
  "wall_height_confidence": "high",
  "openings": [
    {{
      "type": "window",
      "width_in": 37,
      "height_in": 57,
      "position_from_left_pct": 0.25,
      "position_from_bottom_pct": 0.45,
      "shutters": true
    }},
    {{
      "type": "door",
      "width_in": 36,
      "height_in": 80,
      "position_from_left_pct": 0.55,
      "position_from_bottom_pct": 0.0
    }}
  ],
  "accessories": {{
    "shutters": 4,
    "vents": 1,
    "gable_vents": 0
  }}
}}

Confidence must be one of: "high", "medium", "low".
position_from_left_pct and position_from_bottom_pct are 0.0 to 1.0 fractions \
of the wall width and height respectively.
Respond with the JSON object only, no surrounding text.\
"""


# Standard sizes for snap-to-standard. APIR 1.5 lists these.
STANDARD_WINDOW_SIZES_IN = [
    (24, 36), (30, 48), (36, 48), (36, 60),
    (37, 57), (39, 41),
]
STANDARD_DOOR_SIZES_IN = [
    (32, 80), (36, 80), (72, 80),  # 72×80 = double
]
SNAP_TOLERANCE_PCT = 0.10  # APIR says snap if within 10%


@dataclass
class OpeningResult:
    type: Literal["window", "door"]
    width_in: int
    height_in: int
    position_from_left_pct: float
    position_from_bottom_pct: float
    has_shutters: bool = False
    snapped_to_standard: bool = False


@dataclass
class WallAnalysisResult:
    wall_height_ft: float
    wall_height_confidence: ScaleConfidence
    openings: list[OpeningResult]
    shutter_count: int
    vent_count: int
    gable_vent_count: int


def snap_to_standard(
    width_in: int, height_in: int, candidates: list[tuple[int, int]],
    tol_pct: float = SNAP_TOLERANCE_PCT,
) -> tuple[int, int, bool]:
    """
    If (width, height) is within tol_pct of any candidate, return that
    candidate + True. Otherwise return the input + False.
    """
    best: Optional[tuple[int, int]] = None
    best_err = float("inf")
    for cw, ch in candidates:
        w_err = abs(width_in - cw) / cw
        h_err = abs(height_in - ch) / ch
        if w_err <= tol_pct and h_err <= tol_pct:
            err = w_err + h_err
            if err < best_err:
                best = (cw, ch)
                best_err = err
    if best is not None:
        return best[0], best[1], True
    return width_in, height_in, False


async def analyze_wall_openings(
    image_bytes: bytes,
    elevation: str,
    media_type: str = "image/jpeg",
) -> WallAnalysisResult:
    """
    Returns wall height + opening list for one elevation photo. On failure
    returns wall_height_ft=8.5, confidence='estimated', empty openings.
    """
    from app.services.llm import llm_vision

    prompt = WALL_HEIGHT_PROMPT_TEMPLATE.format(elevation=elevation)
    try:
        raw = await llm_vision(
            image_bytes=image_bytes,
            media_type=media_type,
            prompt=prompt,
            max_tokens=1500,
        )
    except Exception as e:
        logger.warning("wall analysis call failed (%s): %s", elevation, e)
        return _wall_fallback()

    parsed = _parse_json_tolerant(raw)
    if not parsed:
        return _wall_fallback()

    try:
        wall_height_ft = float(parsed.get("wall_height_ft", 8.5))
    except (TypeError, ValueError):
        wall_height_ft = 8.5

    conf_raw = str(parsed.get("wall_height_confidence", "low")).lower()
    confidence: ScaleConfidence = (
        "high" if conf_raw == "high"
        else "medium" if conf_raw == "medium"
        else "estimated"
    )

    openings: list[OpeningResult] = []
    for op in parsed.get("openings", []) or []:
        try:
            otype = op.get("type")
            if otype not in ("window", "door"):
                continue
            w = int(op.get("width_in", 0))
            h = int(op.get("height_in", 0))
            if w <= 0 or h <= 0:
                continue
            candidates = (
                STANDARD_WINDOW_SIZES_IN if otype == "window"
                else STANDARD_DOOR_SIZES_IN
            )
            sw, sh, snapped = snap_to_standard(w, h, candidates)
            openings.append(OpeningResult(
                type=otype,
                width_in=sw,
                height_in=sh,
                position_from_left_pct=_clamp01(op.get("position_from_left_pct", 0.5)),
                position_from_bottom_pct=_clamp01(op.get("position_from_bottom_pct", 0.0)),
                has_shutters=bool(op.get("shutters", False)),
                snapped_to_standard=snapped,
            ))
        except (TypeError, ValueError):
            continue

    accessories = parsed.get("accessories") or {}
    shutter_count = _safe_int(accessories.get("shutters", 0))
    vent_count = _safe_int(accessories.get("vents", 0))
    gable_vent_count = _safe_int(accessories.get("gable_vents", 0))

    return WallAnalysisResult(
        wall_height_ft=wall_height_ft,
        wall_height_confidence=confidence,
        openings=openings,
        shutter_count=shutter_count,
        vent_count=vent_count,
        gable_vent_count=gable_vent_count,
    )


def _wall_fallback() -> WallAnalysisResult:
    return WallAnalysisResult(
        wall_height_ft=8.5,
        wall_height_confidence="estimated",
        openings=[],
        shutter_count=0,
        vent_count=0,
        gable_vent_count=0,
    )


def _clamp01(v) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.5
    return max(0.0, min(1.0, f))


def _safe_int(v) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


# ─────────────────────────────────────────────────────────────────────────
# Material + color detection (APIR 1.6)
# ─────────────────────────────────────────────────────────────────────────

MATERIALS_PROMPT = """\
Identify the exterior materials visible in this photo. For each material, provide:
- The material type
- The color description (be specific: "weathered charcoal gray", not just "gray")
- Your confidence level

Return ONLY a JSON object:
{
  "roof_material": "asphalt_shingles",
  "roof_color": "weathered charcoal gray",
  "roof_confidence": "high",
  "siding_material": "vinyl",
  "siding_color": "white painted vinyl horizontal lap",
  "siding_confidence": "high",
  "trim_material": "pvc",
  "trim_color": "white",
  "brick_present": false,
  "brick_color": null,
  "brick_location": null
}

roof_material must be one of: metal, asphalt_shingles, tile, flat_membrane, \
wood_shake, slate, unknown.
siding_material must be one of: vinyl, hardie, wood, brick, stucco, aluminum, \
stone, unknown.
trim_material must be one of: wood, pvc, aluminum, unknown.
Confidence must be one of: high, medium, low.
Respond with the JSON object only, no surrounding text.\
"""


@dataclass
class MaterialResult:
    roof_material: str
    roof_color: str
    roof_confidence: str
    siding_material: str
    siding_color: str
    siding_confidence: str
    trim_material: str
    trim_color: str
    brick_present: bool
    brick_color: Optional[str] = None
    brick_location: Optional[str] = None


async def detect_materials(
    image_bytes: bytes, media_type: str = "image/jpeg"
) -> MaterialResult:
    from app.services.llm import llm_vision

    try:
        raw = await llm_vision(
            image_bytes=image_bytes,
            media_type=media_type,
            prompt=MATERIALS_PROMPT,
            max_tokens=600,
        )
    except Exception as e:
        logger.warning("materials vision call failed: %s", e)
        return _materials_fallback()

    parsed = _parse_json_tolerant(raw)
    if not parsed:
        return _materials_fallback()

    return MaterialResult(
        roof_material=str(parsed.get("roof_material", "unknown")),
        roof_color=str(parsed.get("roof_color", "")),
        roof_confidence=str(parsed.get("roof_confidence", "low")),
        siding_material=str(parsed.get("siding_material", "unknown")),
        siding_color=str(parsed.get("siding_color", "")),
        siding_confidence=str(parsed.get("siding_confidence", "low")),
        trim_material=str(parsed.get("trim_material", "unknown")),
        trim_color=str(parsed.get("trim_color", "")),
        brick_present=bool(parsed.get("brick_present", False)),
        brick_color=parsed.get("brick_color"),
        brick_location=parsed.get("brick_location"),
    )


def _materials_fallback() -> MaterialResult:
    return MaterialResult(
        roof_material="unknown", roof_color="", roof_confidence="low",
        siding_material="unknown", siding_color="", siding_confidence="low",
        trim_material="unknown", trim_color="",
        brick_present=False, brick_color=None, brick_location=None,
    )


# ─────────────────────────────────────────────────────────────────────────
# Soffit depth (APIR 1.7)
# ─────────────────────────────────────────────────────────────────────────

SOFFIT_PROMPT = """\
Look at the eave/overhang visible in this photo. Estimate the soffit depth — \
the horizontal distance from the exterior wall face to the outer edge of the \
fascia board. This is typically 4 to 16 inches for residential.

Use any visible reference (window trim = ~3.5" thick, fascia board = ~5.5" wide) \
to help calibrate.

Return ONLY a JSON object:
{
  "soffit_depth_in": 8,
  "confidence": "medium"
}

Confidence must be one of: high, medium, low.
Respond with the JSON object only, no surrounding text.\
"""


@dataclass
class SoffitDepthResult:
    depth_in: float
    confidence: ScaleConfidence


async def detect_soffit_depth(
    image_bytes: bytes, media_type: str = "image/jpeg"
) -> SoffitDepthResult:
    from app.services.llm import llm_vision

    try:
        raw = await llm_vision(
            image_bytes=image_bytes,
            media_type=media_type,
            prompt=SOFFIT_PROMPT,
            max_tokens=200,
        )
    except Exception as e:
        logger.warning("soffit vision call failed: %s", e)
        return SoffitDepthResult(depth_in=6.0, confidence="estimated")

    parsed = _parse_json_tolerant(raw)
    if not parsed:
        return SoffitDepthResult(depth_in=6.0, confidence="estimated")

    try:
        depth = float(parsed.get("soffit_depth_in", 6.0))
        # Clamp to APIR's stated range
        depth = max(2.0, min(24.0, depth))
    except (TypeError, ValueError):
        depth = 6.0

    conf_raw = str(parsed.get("confidence", "low")).lower()
    confidence: ScaleConfidence = (
        "high" if conf_raw == "high"
        else "medium" if conf_raw == "medium"
        else "estimated"
    )
    return SoffitDepthResult(depth_in=depth, confidence=confidence)
