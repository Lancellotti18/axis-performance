"""
Blueprint 3D Vision Service.
Uses Claude Vision to parse blueprint images and extract walls, doors, windows,
electrical fixtures, and plumbing fixtures with real-world coordinates in feet.
"""
import base64
import json
import logging
import re
import asyncio
from app.core.config import settings
from app.core.supabase import get_supabase
from app.services.llm import llm_vision

logger = logging.getLogger(__name__)

VISION_PROMPT = """You are a professional architectural blueprint interpreter. Analyze this floor plan image with extreme precision.

STEP 1 — Find the scale (look for scale notation, scale bar, or dimension lines).
STEP 2 — Set origin at bottom-left exterior corner of the building at (0,0).
STEP 3 — Extract ALL elements. Return ONLY valid JSON, no other text:

{
  "scale_detected": "1/4 inch = 1 foot",
  "confidence": 0.85,
  "building_width_ft": 45.0,
  "building_depth_ft": 38.0,
  "total_sqft": 1710,
  "stories": 1,
  "wall_height_ft": 9.0,
  "rooms": [
    {"name": "Living Room", "x": 0.0, "z": 0.0, "width": 18.0, "depth": 15.0, "floor_type": "hardwood", "sqft": 270}
  ],
  "walls": [
    {"x1": 0.0, "z1": 0.0, "x2": 45.0, "z2": 0.0, "thickness": 0.5, "type": "exterior"}
  ],
  "doors": [
    {"x": 5.0, "z": 0.0, "width": 3.0, "height": 7.0, "wall_angle": 0}
  ],
  "windows": [
    {"x": 12.0, "z": 0.0, "width": 4.0, "height": 3.5, "sill_height": 2.5, "wall_angle": 0}
  ],
  "electrical": [
    {"type": "outlet", "x": 2.0, "z": 0.5},
    {"type": "switch", "x": 4.5, "z": 0.3},
    {"type": "ceiling_light", "x": 9.0, "z": 7.5},
    {"type": "ceiling_fan", "x": 20.0, "z": 12.0},
    {"type": "panel", "x": 8.0, "z": 20.0}
  ],
  "plumbing": [
    {"type": "toilet", "x": 32.0, "z": 28.0, "rotation": 0},
    {"type": "sink", "x": 34.5, "z": 25.0, "rotation": 0},
    {"type": "bathtub", "x": 36.0, "z": 30.0, "rotation": 90},
    {"type": "kitchen_sink", "x": 18.0, "z": 0.5, "rotation": 0},
    {"type": "water_heater", "x": 30.0, "z": 20.0, "rotation": 0}
  ],
  "stairs": [
    {"x": 20.0, "z": 15.0, "width": 4.0, "depth": 10.0, "steps": 14, "direction": "up"}
  ]
}

CRITICAL RULES:
- ALL coordinates in FEET from bottom-left origin
- walls[] must include ALL wall lines (exterior AND interior partitions)
- wall thickness: exterior=0.5ft, interior=0.33ft typical
- Include ALL visible electrical symbols: outlets (circle with lines), switches (S), ceiling fixtures (X in circle), panels
- Include ALL visible plumbing: toilets, sinks, tubs, showers, water heaters, kitchen sinks
- rooms: use interior clear dimensions (inside wall faces)
- Extract from the FLOOR PLAN view (not elevation drawings)

SCALE RULES (accuracy-critical — read carefully):
- If a scale notation, scale bar, or labeled dimension is visible on the drawing,
  use it and report "scale_detected" as the literal notation (e.g. "1/4 inch = 1 foot").
- If NO scale is present anywhere on the image, set scale_detected=null,
  scale_unverified=true, and confidence=0.30. All dimensions you return in that
  case must be flagged as approximate — the downstream estimator will prompt the
  user to enter real dimensions rather than order materials from a guess.
- Do NOT invent room sizes from "typical residential layouts" to paper over a
  missing scale. A blueprint with no scale is a signal to ask, not to guess."""


def _download_blueprint(blueprint_id: str) -> tuple:
    """Sync: download blueprint image from Supabase Storage."""
    db = get_supabase()
    bp = db.table("blueprints").select("file_url, file_type").eq("id", blueprint_id).single().execute()
    if not bp.data:
        raise ValueError("Blueprint not found")

    file_url = bp.data.get("file_url", "")
    file_type = (bp.data.get("file_type") or "").lower()

    m = re.search(r'/blueprints/(.+?)(?:\?.*)?$', file_url)
    if not m:
        raise RuntimeError(f"Cannot parse storage path from URL: {file_url[:80]}")
    storage_path = m.group(1)

    file_data = db.storage.from_("blueprints").download(storage_path)

    media_type_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "pdf": "application/pdf"}
    media_type = media_type_map.get(file_type, "image/png")

    return file_data, media_type


async def parse_blueprint_3d(blueprint_id: str) -> dict:
    """
    Parse a blueprint image with LLM Vision (Gemini/Groq/Claude).
    Downloads from Supabase Storage, sends to LLM, returns structured scene data.
    """
    image_data, media_type = await asyncio.to_thread(_download_blueprint, blueprint_id)

    # PDFs: convert first page to JPEG since Gemini/Groq don't support PDF natively
    if media_type == "application/pdf":
        try:
            import fitz  # pymupdf
            doc = fitz.open(stream=image_data, filetype="pdf")
            page = doc.load_page(0)
            pix = page.get_pixmap(dpi=150)
            image_data = pix.tobytes("jpeg")
            media_type = "image/jpeg"
        except Exception:
            logger.debug("PDF to JPEG conversion failed, passing PDF through to LLM", exc_info=True)
            pass  # fall through and let the LLM handle it

    text = await llm_vision(image_data, media_type, VISION_PROMPT, max_tokens=4096)
    text = text.strip()
    text = re.sub(r'^```(?:json)?\s*', '', text, count=1)
    text = re.sub(r'\s*```\s*$', '', text)
    start = text.find("{")
    if start > 0:
        text = text[start:]
    end = text.rfind("}") + 1
    if end > 0:
        text = text[:end]

    data = json.loads(text)

    for key in ["rooms", "walls", "doors", "windows", "electrical", "plumbing", "stairs"]:
        if key not in data:
            data[key] = []

    return data
