"""
renders.py — AI Photorealistic Render Generation
=================================================
Uses Google Imagen 3 (via existing GEMINI_API_KEY) to generate
photorealistic exterior and interior renders from blueprint analysis data.
"""

from __future__ import annotations

import base64
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core.config import settings
from app.core.supabase import get_supabase

router = APIRouter()
log = logging.getLogger(__name__)


class RenderRequest(BaseModel):
    style: str = "modern"          # modern | traditional | farmhouse | contemporary | craftsman
    time_of_day: str = "golden_hour"  # day | golden_hour | dusk


def _build_exterior_prompt(project: dict, analysis: dict, style: str, time_of_day: str) -> str:
    sqft = analysis.get("total_sqft", 0)
    room_count = analysis.get("room_count") or len(analysis.get("rooms", []))
    blueprint_type = (project.get("blueprint_type") or "residential").replace("_", " ")
    city = project.get("city", "")
    region = (project.get("region") or "").replace("US-", "")
    location = f"{city}, {region}".strip(", ") if city or region else "suburban"

    stories = "two-story" if sqft and sqft > 2500 else "single-story"
    time_desc = {
        "day": "bright midday sunlight, clear blue sky",
        "golden_hour": "warm golden hour sunset light, long shadows",
        "dusk": "dusk twilight, warm interior lights glowing through windows",
    }.get(time_of_day, "golden hour sunlight")

    style_desc = {
        "modern": "modern architecture, clean lines, large windows, flat or low-pitch roof, minimalist",
        "traditional": "traditional architecture, symmetrical facade, shutters, pitched gable roof",
        "farmhouse": "modern farmhouse style, board and batten siding, metal roof, front porch",
        "contemporary": "contemporary architecture, mixed materials, asymmetric roofline, floor-to-ceiling windows",
        "craftsman": "craftsman bungalow, tapered columns, covered front porch, exposed rafter tails",
    }.get(style, "modern architecture, clean lines")

    return (
        f"Photorealistic architectural exterior render of a {stories} {blueprint_type} home, "
        f"{style_desc}, approximately {int(sqft):,} square feet, {room_count} rooms, "
        f"located in {location}. "
        f"Beautifully landscaped front yard with green lawn, mature trees, concrete driveway. "
        f"Photographed from a slight angle showing front and side elevation. "
        f"{time_desc.capitalize()}. "
        f"Ultra-high quality architectural photography, 8K, photorealistic, "
        f"professional real estate photography, no people, sharp focus."
    )


def _build_interior_prompt(project: dict, analysis: dict, style: str) -> str:
    sqft = analysis.get("total_sqft", 0)
    rooms = analysis.get("rooms", [])
    blueprint_type = (project.get("blueprint_type") or "residential").replace("_", " ")

    # Find the main living area
    living_room = None
    for r in rooms:
        name = (r.get("name") or "").lower()
        if any(k in name for k in ["living", "great room", "family", "lounge"]):
            living_room = r
            break
    room_sqft = int(living_room.get("sqft", 0)) if living_room else (int(sqft * 0.18) if sqft else 300)

    style_desc = {
        "modern": "modern interior design, minimalist, neutral palette, clean lines, recessed lighting",
        "traditional": "traditional interior, crown molding, warm wood tones, classic furniture",
        "farmhouse": "modern farmhouse interior, shiplap walls, open shelving, warm neutral tones",
        "contemporary": "contemporary interior, open plan, statement lighting, mixed textures",
        "craftsman": "craftsman interior, built-in bookshelves, warm wood trim, mission-style furniture",
    }.get(style, "modern interior design, minimalist, neutral palette")

    return (
        f"Photorealistic interior render of a {blueprint_type} living room, "
        f"{style_desc}, approximately {room_sqft} square feet, "
        f"large windows with natural light flooding in, hardwood floors, "
        f"high ceilings, tasteful furniture and decor, "
        f"ultra-high quality architectural interior photography, 8K, photorealistic, "
        f"designed by top interior designer, no people, sharp focus, wide angle lens."
    )


@router.post("/{project_id}/generate")
async def generate_renders(project_id: str, request: RenderRequest):
    if not settings.GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY not configured.")

    db = get_supabase()

    # Fetch project
    proj_row = db.table("projects").select("*").eq("id", project_id).limit(1).execute()
    if not proj_row.data:
        raise HTTPException(status_code=404, detail="Project not found.")
    project = proj_row.data[0]

    # Fetch analysis
    bp_row = db.table("blueprints").select("id").eq("project_id", project_id)\
               .order("created_at", desc=True).limit(1).execute()
    analysis = {}
    if bp_row.data:
        blueprint_id = bp_row.data[0]["id"]
        an_row = db.table("analyses").select("*").eq("blueprint_id", blueprint_id).limit(1).execute()
        if an_row.data:
            analysis = an_row.data[0]

    exterior_prompt = _build_exterior_prompt(project, analysis, request.style, request.time_of_day)
    interior_prompt = _build_interior_prompt(project, analysis, request.style)

    try:
        from google import genai
        from google.genai import types as gtypes

        client = genai.Client(api_key=settings.GEMINI_API_KEY)

        renders = {}
        for label, prompt in [("exterior", exterior_prompt), ("interior", interior_prompt)]:
            try:
                response = client.models.generate_images(
                    model="imagen-3.0-generate-002",
                    prompt=prompt,
                    config=gtypes.GenerateImagesConfig(
                        number_of_images=1,
                        aspect_ratio="16:9",
                        safety_filter_level="block_only_high",
                        person_generation="dont_allow",
                    ),
                )
                if response.generated_images:
                    img_bytes = response.generated_images[0].image.image_bytes
                    renders[label] = "data:image/png;base64," + base64.b64encode(img_bytes).decode()
            except Exception as e:
                log.warning(f"[Renders] {label} generation failed: {e}")
                renders[label] = None

        if not any(renders.values()):
            raise HTTPException(status_code=500, detail="Image generation failed. Check GEMINI_API_KEY has Imagen access.")

        return {
            "exterior": renders.get("exterior"),
            "interior": renders.get("interior"),
            "prompts": {
                "exterior": exterior_prompt,
                "interior": interior_prompt,
            },
            "style": request.style,
            "time_of_day": request.time_of_day,
        }

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"[Renders] Fatal error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
