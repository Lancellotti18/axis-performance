"""
EagleView-style roof outline detection.

Given a satellite image URL of a property, call LLM Vision to trace the
primary building's roof outline as a closed polygon in image-normalized
coordinates. The frontend then lets the user drag vertices to correct
the AI's guess and recalculates area/perimeter in feet using the
known metres-per-pixel of the Esri World Imagery tile.

Returning image-fraction coordinates (0..1) keeps the polygon resolution-
independent — the same output renders correctly whether the tile is 640×420
or the 1280×840 retina version. Feet conversions happen on the client using
lat-based mpp so we don't have to keep the lat/zoom in sync server-side.
"""
from __future__ import annotations

import json
import logging
import math
import re
from typing import Optional

import httpx

from app.services.llm import llm_vision

logger = logging.getLogger(__name__)


OUTLINE_PROMPT = """You are a senior roofing estimator tracing a roof outline on a satellite image.

Your job: identify the PRIMARY building (the largest structure near the image center) and trace its roof edge as a closed polygon.

Return ONLY valid JSON — no prose before or after:
{
  "polygon": [[0.32, 0.28], [0.68, 0.28], [0.68, 0.72], [0.32, 0.72]],
  "confidence": 0.74,
  "structure": "rectangular",
  "notes": "Rectangular single-story with an attached garage extension to the east. Garage not included in outline.",
  "warnings": ["Tree canopy obscures the NW corner — vertex placement is approximate"]
}

Rules:
- Coordinates are [x, y] pairs, each a fraction 0..1 of image width/height (origin top-left).
- Polygon is CLOSED (do NOT repeat the first point at the end — the client closes it).
- Use 4–12 vertices. L-shapes, T-shapes, and complex residential roofs are fine; aim for the minimum vertex count that captures the true shape.
- Include ONLY the main building footprint. Do NOT trace driveways, pools, fences, sheds, or neighboring houses.
- If an attached garage shares a roof line with the house, include it. If it's a separate detached structure, exclude it.
- confidence: 0.80–0.95 for a clear rectangular roof with visible edges; 0.50–0.70 if the roof is partially obscured by trees, shadows, or low-res imagery; below 0.40 if you genuinely cannot see the building.
- warnings: list any corners where tree canopy, shadow, or resolution made vertex placement uncertain.
- If you cannot confidently locate the primary building, return polygon: [] and confidence: 0.0.
"""


async def _download(url: str) -> tuple[bytes, str]:
    async with httpx.AsyncClient(timeout=20.0) as http:
        resp = await http.get(url, follow_redirects=True)
        resp.raise_for_status()
        media = (resp.headers.get("content-type") or "image/png").split(";")[0].strip()
        if media not in ("image/jpeg", "image/png", "image/gif", "image/webp"):
            media = "image/png"
        return resp.content, media


def _sanitize(raw: str) -> str:
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw, count=1)
    raw = re.sub(r"\s*```\s*$", "", raw)
    start = raw.find("{")
    if start > 0:
        raw = raw[start:]
    end = raw.rfind("}") + 1
    if end > 0:
        raw = raw[:end]
    return raw


def _parse_outline_json(text: str) -> dict:
    """
    Tolerant JSON parser for the outline LLM response. Strips fences, finds
    the largest balanced {...} block, fixes trailing commas / Python-isms,
    and walks back through `}` boundaries if the first parse fails (covers
    truncated responses).
    """
    cleaned = _sanitize(text or "")
    if not cleaned:
        return {}

    start = cleaned.find("{")
    if start < 0:
        return {}

    # Find the largest balanced {...} block by tracking string state.
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
        logger.warning(
            "roof outline: JSON parse failed, returning empty polygon. raw[:200]=%r",
            (text or "")[:200],
        )
        return {}


def _polygon_area_fraction(polygon: list[list[float]]) -> float:
    """Shoelace area in image-fraction squared (0..1 range)."""
    n = len(polygon)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


async def detect_roof_outline(
    satellite_image_url: str,
    *,
    lat: Optional[float] = None,
    image_width_px: int = 1280,
    image_height_px: int = 840,
    zoom: int = 18,
) -> dict:
    """
    Trace the primary building's roof outline on the given satellite image.

    Returns:
      {
        polygon: [[x_frac, y_frac], ...],   # closed, in 0..1 image fractions
        confidence: float,
        structure: str,
        notes: str,
        warnings: [str],
        estimated_sqft: float | None,        # convenience (client also recomputes)
        estimated_perimeter_ft: float | None,
        image_width_px, image_height_px, zoom: echo of inputs
      }
    """
    if not satellite_image_url:
        raise ValueError("satellite_image_url is required")

    image_bytes, media_type = await _download(satellite_image_url)

    text = await llm_vision(image_bytes, media_type, OUTLINE_PROMPT, max_tokens=900)
    payload = _parse_outline_json(text)
    if not payload:
        # LLM returned something we couldn't parse — degrade gracefully so the
        # UI shows an empty editable canvas instead of a 422. The frontend
        # already supports drawing the outline by hand.
        payload = {
            "polygon": [],
            "confidence": 0.0,
            "structure": "",
            "notes": "Could not auto-detect the roof outline — drag a polygon over the building to get started.",
            "warnings": ["AI vision response was not valid JSON."],
        }

    polygon = payload.get("polygon") or []
    # Defensive: clamp to [0,1] and drop malformed points
    cleaned: list[list[float]] = []
    for pt in polygon:
        if not isinstance(pt, (list, tuple)) or len(pt) < 2:
            continue
        try:
            x = max(0.0, min(1.0, float(pt[0])))
            y = max(0.0, min(1.0, float(pt[1])))
        except (TypeError, ValueError):
            continue
        cleaned.append([x, y])

    out: dict = {
        "polygon": cleaned,
        "confidence": float(payload.get("confidence") or 0.0),
        "structure": payload.get("structure") or "",
        "notes": payload.get("notes") or "",
        "warnings": payload.get("warnings") or [],
        "image_width_px": image_width_px,
        "image_height_px": image_height_px,
        "zoom": zoom,
        "estimated_sqft": None,
        "estimated_perimeter_ft": None,
    }

    if lat is not None and len(cleaned) >= 3:
        # Metres per native pixel at this tile
        mpp = (156543.03392 * math.cos(math.radians(lat))) / (2 ** zoom)
        ft_per_px = mpp * 3.28084

        # Area in fraction² → ft² via image pixel dimensions × ft/px
        area_frac = _polygon_area_fraction(cleaned)
        area_sqft = area_frac * image_width_px * image_height_px * (ft_per_px ** 2)

        # Perimeter in feet
        perim = 0.0
        n = len(cleaned)
        for i in range(n):
            x1, y1 = cleaned[i]
            x2, y2 = cleaned[(i + 1) % n]
            dx = (x2 - x1) * image_width_px * ft_per_px
            dy = (y2 - y1) * image_height_px * ft_per_px
            perim += math.sqrt(dx * dx + dy * dy)

        out["estimated_sqft"] = round(area_sqft, 1)
        out["estimated_perimeter_ft"] = round(perim, 1)

    return out
