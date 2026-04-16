"""
Roofing measurement analysis service.
Uses Claude vision to extract roof measurements from uploaded blueprint/aerial images.
"""
import json
import base64
import logging
import httpx
from app.core.config import settings
from app.services.llm import llm_vision_sync

logger = logging.getLogger(__name__)


async def download_image(url: str) -> tuple[bytes, str]:
    """Download an image from a URL and return bytes + detected media type."""
    async with httpx.AsyncClient(timeout=30) as http:
        resp = await http.get(url)
        resp.raise_for_status()
        content_type = resp.headers.get("content-type", "image/jpeg").split(";")[0].strip()
        # Normalize content type to something Claude accepts
        if content_type not in ("image/jpeg", "image/png", "image/gif", "image/webp"):
            content_type = "image/jpeg"
        return resp.content, content_type


async def analyze_roof_image(image_url: str) -> dict:
    """
    Use Claude vision to extract roof measurements from a blueprint, aerial photo,
    or roof diagram. Returns structured measurement data with confidence score.
    """
    image_bytes, media_type = await download_image(image_url)
    image_b64 = base64.standard_b64encode(image_bytes).decode("utf-8")

    prompt = """You are a professional roofing estimator analyzing a blueprint, aerial image, or roof diagram.

Extract all measurable roof data. Return ONLY valid JSON with this exact structure — no prose, no markdown fences:

{
  "total_sqft": <number or null — total roof surface area in square feet>,
  "pitch": "<string or null — e.g. '6/12', '4/12', '8/12'. null if not determinable>",
  "facets": <integer or null — number of distinct roof planes/sections>,
  "ridges_ft": <number or null — total linear feet of ridge lines>,
  "valleys_ft": <number or null — total linear feet of valleys>,
  "eaves_ft": <number or null — total linear feet of eave edges>,
  "rakes_ft": <number or null — total linear feet of rake edges>,
  "waste_pct": <number or null — recommended waste % between 10 and 25>,
  "roof_type": "<one of: gable | hip | complex | flat | gambrel | mansard | shed | unknown>",
  "stories": <integer or null — number of stories visible>,
  "confidence": <integer 0–100 — how confident you are in these measurements>,
  "measurement_unverified": <boolean — true if any core field was guessed rather than read from the image>,
  "notes": "<string — key observations, assumptions made, or areas of uncertainty>"
}

Measurement guidelines:
- total_sqft: The ACTUAL sloped roof surface area (not footprint). For a 2000 sq ft footprint with 6/12 pitch, multiply by ~1.12.
- waste_pct: 10% for simple gable, 12–15% for hip, 15–20% for complex multi-facet roofs.
- If this appears to be a floor plan (not a roof plan) and the footprint is clearly
  visible with a dimension scale, compute roof area as footprint × pitch multiplier.
- ACCURACY RULE: If you cannot determine a value from the image (dimensions absent,
  view obstructed, scale missing, etc.), return null for that field and set
  measurement_unverified=true. Do NOT substitute a "typical residential" guess —
  the downstream estimate treats null as "needs manual entry", and a guessed number
  would push the contractor to order the wrong quantity of materials.
- confidence: 80–95 when dimensions are clearly labeled, 50–75 when partially visible,
  below 50 when the image is unclear. Low confidence should accompany null fields."""

    image_bytes = base64.b64decode(image_b64)
    text = llm_vision_sync(image_bytes, media_type, prompt, max_tokens=1024)
    text = text.strip()
    # Strip any accidental markdown fences
    if "```" in text:
        parts = text.split("```")
        for part in parts:
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            try:
                return json.loads(part)
            except Exception:
                logger.debug("json parse of fenced block failed, trying next", exc_info=True)
                continue

    return json.loads(text)


def calculate_shingle_materials(
    total_sqft: float,
    waste_pct: float,
    pitch: str,
    ridges_ft: float,
    valleys_ft: float,
    eaves_ft: float,
    rakes_ft: float,
    stories: int = 1,
) -> list[dict]:
    """
    Calculate the full material list for a roofing job based on confirmed measurements.
    Returns a list of material items with quantities and estimated unit costs.
    """
    # Apply waste factor
    waste_factor = 1 + (waste_pct / 100)
    gross_sqft = total_sqft * waste_factor
    squares = gross_sqft / 100  # roofing square = 100 sq ft

    # Pitch difficulty multiplier for labor
    try:
        rise = float(pitch.split("/")[0]) if "/" in pitch else 4
    except Exception:
        logger.debug("failed to parse roof pitch rise from text", exc_info=True)
        rise = 4
    # Steeper pitch = higher cost
    pitch_mult = 1.0 + max(0, (rise - 4) * 0.05)

    materials = [
        # Shingles (3-tab or architectural)
        {
            "item_name": "Architectural Shingles (30-yr)",
            "category": "roofing",
            "quantity": round(squares, 1),
            "unit": "square",
            "unit_cost": round(110 * pitch_mult, 2),
            "total_cost": round(squares * 110 * pitch_mult, 2),
            "notes": f"Includes {waste_pct:.0f}% waste factor",
        },
        # Starter strip
        {
            "item_name": "Starter Strip Shingles",
            "category": "roofing",
            "quantity": round((eaves_ft + rakes_ft) / 100, 1),
            "unit": "square",
            "unit_cost": 75.00,
            "total_cost": round(((eaves_ft + rakes_ft) / 100) * 75, 2),
            "notes": "Eaves + rakes linear footage ÷ 100",
        },
        # Ridge cap
        {
            "item_name": "Ridge Cap Shingles",
            "category": "roofing",
            "quantity": round(ridges_ft / 33, 1),
            "unit": "bundle",
            "unit_cost": 65.00,
            "total_cost": round((ridges_ft / 33) * 65, 2),
            "notes": "33 linear ft per bundle",
        },
        # Synthetic underlayment
        {
            "item_name": "Synthetic Underlayment (10 sq roll)",
            "category": "roofing",
            "quantity": round(squares / 10, 1),
            "unit": "roll",
            "unit_cost": 55.00,
            "total_cost": round((squares / 10) * 55, 2),
            "notes": "1 roll per 10 squares",
        },
        # Ice & water shield (first 3 ft of eaves + all valleys)
        {
            "item_name": "Ice & Water Shield",
            "category": "roofing",
            "quantity": round(((eaves_ft * 3) + (valleys_ft * 3)) / 65, 1),
            "unit": "roll",
            "unit_cost": 95.00,
            "total_cost": round((((eaves_ft * 3) + (valleys_ft * 3)) / 65) * 95, 2),
            "notes": "3 ft wide at eaves + 3 ft each side of valleys; 65 sq ft/roll",
        },
        # Valley flashing
        {
            "item_name": "Valley Flashing (coil)",
            "category": "roofing",
            "quantity": round(valleys_ft / 50, 1),
            "unit": "roll",
            "unit_cost": 85.00,
            "total_cost": round((valleys_ft / 50) * 85, 2),
            "notes": "50 linear ft per roll",
        },
        # Drip edge
        {
            "item_name": "Drip Edge Flashing",
            "category": "roofing",
            "quantity": round((eaves_ft + rakes_ft) / 10, 0),
            "unit": "piece",
            "unit_cost": 8.50,
            "total_cost": round(((eaves_ft + rakes_ft) / 10) * 8.5, 2),
            "notes": "10 ft pieces; eaves installed first, rakes over underlayment",
        },
        # Roofing nails
        {
            "item_name": "Roofing Nails (1-3/4\" coil)",
            "category": "roofing",
            "quantity": round(squares, 0),
            "unit": "lb",
            "unit_cost": 3.50,
            "total_cost": round(squares * 3.5, 2),
            "notes": "~1 lb per square",
        },
        # Roofing felt/tar paper (secondary layer over ice shield areas)
        {
            "item_name": "Roofing Felt 15# (4 sq roll)",
            "category": "roofing",
            "quantity": round(squares / 4, 1),
            "unit": "roll",
            "unit_cost": 22.00,
            "total_cost": round((squares / 4) * 22, 2),
            "notes": "Used in non-ice-shield areas as secondary moisture barrier",
        },
    ]

    # Add step flashing if stories > 1 (wall intersections more likely)
    if stories > 1 or rise >= 6:
        materials.append({
            "item_name": "Step Flashing (aluminum)",
            "category": "roofing",
            "quantity": round((eaves_ft * 0.1 + rakes_ft * 0.15), 0),
            "unit": "piece",
            "unit_cost": 1.75,
            "total_cost": round((eaves_ft * 0.1 + rakes_ft * 0.15) * 1.75, 2),
            "notes": "Wall-to-roof transitions; estimated from perimeter",
        })

    return materials
