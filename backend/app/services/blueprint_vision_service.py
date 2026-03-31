"""
Blueprint 3D Vision Service.
Uses Claude Vision to parse blueprint images and extract walls, doors, windows,
electrical fixtures, and plumbing fixtures with real-world coordinates in feet.
"""
import base64
import json
import re
import asyncio
import anthropic
from app.core.config import settings
from app.core.supabase import get_supabase

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
- If no scale found, estimate from typical room sizes, set confidence 0.4
- Extract from the FLOOR PLAN view (not elevation drawings)"""


def _download_blueprint(blueprint_id: str) -> tuple:
    """Sync: download blueprint image from Supabase Storage."""
    db = get_supabase()
    bp = db.table("blueprints").select("file_url, file_type").eq("id", blueprint_id).single().execute()
    if not bp.data:
        raise ValueError("Blueprint not found")

    file_url = bp.data.get("file_url", "")
    file_type = (bp.data.get("file_type") or "").lower()

    if file_type == "pdf":
        raise ValueError("PDF blueprints are not supported for 3D parsing. Please upload a PNG or JPG image.")

    m = re.search(r'/blueprints/(.+?)(?:\?.*)?$', file_url)
    if not m:
        raise RuntimeError(f"Cannot parse storage path from URL: {file_url[:80]}")
    storage_path = m.group(1)

    image_data = db.storage.from_("blueprints").download(storage_path)

    media_type_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
    media_type = media_type_map.get(file_type, "image/png")

    return image_data, media_type


def _call_claude_vision(image_data: bytes, media_type: str) -> dict:
    """Sync: send image to Claude Vision and parse response."""
    image_b64 = base64.standard_b64encode(image_data).decode("utf-8")

    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
    message = client.messages.create(
        model="claude-opus-4-6",
        max_tokens=4096,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": image_b64,
                    },
                },
                {"type": "text", "text": VISION_PROMPT}
            ],
        }]
    )

    text = message.content[0].text.strip()
    text = re.sub(r'^```(?:json)?\s*', '', text, count=1)
    text = re.sub(r'\s*```\s*$', '', text)
    start = text.find("{")
    if start > 0:
        text = text[start:]
    end = text.rfind("}") + 1
    if end > 0:
        text = text[:end]

    data = json.loads(text)

    # Ensure all required arrays exist
    for key in ["rooms", "walls", "doors", "windows", "electrical", "plumbing", "stairs"]:
        if key not in data:
            data[key] = []

    return data


async def parse_blueprint_3d(blueprint_id: str) -> dict:
    """
    Parse a blueprint image with Claude Vision.
    Downloads from Supabase Storage, sends to Claude, returns structured scene data.
    All blocking calls run in thread pool to avoid blocking the event loop.
    """
    # Download image (blocking Supabase call)
    image_data, media_type = await asyncio.to_thread(_download_blueprint, blueprint_id)

    # Parse with Claude Vision (blocking API call)
    scene_data = await asyncio.to_thread(_call_claude_vision, image_data, media_type)

    return scene_data
