"""
RoofVision — render the homeowner's OWN measured roof in the shingle colors the
contractor actually installs, at quote time.

Not the generic Home Visualizer (free-text remodel of any photo). This is a
roofing sales instrument:
  * a curated palette of REAL architectural-shingle colors (orderable products,
    not "the AI imagined a roof we don't sell"),
  * a roof-ONLY edit instruction (walls / windows / landscaping stay identical),
  * each option tagged to its good/better/best price tier,
  * rendered from the confirmed satellite tile of THIS building.

Reuses the existing img2img pipeline (fal.ai FLUX Kontext → Gemini → HF →
Replicate) via visualizer_service._generate_image — no new model surface.

Entirely gated: no-op unless settings.ROOFVISION_ENABLED and an image provider
is configured. Every call spends real image-gen budget, so callers fire it
best-effort (never in the capture hot path) and tolerate failure.
"""
from __future__ import annotations

import asyncio
import logging
import os

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# Curated architectural-asphalt palette — the 90% product. `tier` maps each
# color to the good/better/best band so the homeowner sees look + price together.
# A contractor palette override (their stocked lines) is a later addition; these
# are safe, universally-sold defaults.
SHINGLE_OPTIONS = [
    {"key": "charcoal",       "name": "Charcoal Black",  "tier": "Better",
     "desc": "dark charcoal-black architectural asphalt shingles"},
    {"key": "weathered_wood", "name": "Weathered Wood",  "tier": "Good",
     "desc": "warm brown weathered-wood blend architectural asphalt shingles"},
    {"key": "slate",          "name": "Slate Gray",      "tier": "Better",
     "desc": "cool slate-gray architectural asphalt shingles"},
    {"key": "driftwood",      "name": "Driftwood",       "tier": "Good",
     "desc": "tan and gray driftwood-blend architectural asphalt shingles"},
    {"key": "hunter_green",   "name": "Hunter Green",    "tier": "Best",
     "desc": "deep hunter-green designer architectural shingles"},
]

# Keep cost bounded: render this many colors per lead by default.
DEFAULT_RENDER_COUNT = 3
# Hard ceiling regardless of a contractor's palette size (cost guard).
MAX_RENDER_COUNT = 5

_BY_KEY = {o["key"]: o for o in SHINGLE_OPTIONS}


def catalog() -> list[dict]:
    """The full pickable shingle catalog (key/name/tier) for the settings UI."""
    return [{"key": o["key"], "name": o["name"], "tier": o["tier"]} for o in SHINGLE_OPTIONS]


def resolve_palette(palette: list[str] | None) -> list[dict]:
    """Turn a contractor's chosen color keys into catalog entries (order
    preserved, unknown keys dropped, capped). Falls back to the default first
    few when no valid palette is configured."""
    if palette:
        chosen = [_BY_KEY[k] for k in palette if k in _BY_KEY][:MAX_RENDER_COUNT]
        if chosen:
            return chosen
    return SHINGLE_OPTIONS[:DEFAULT_RENDER_COUNT]


def roofvision_enabled() -> bool:
    """On only when explicitly enabled AND some image provider is configured."""
    if not settings.ROOFVISION_ENABLED:
        return False
    return bool(
        os.environ.get("FAL_API_KEY") or os.environ.get("FAL_KEY") or settings.FAL_API_KEY
        or settings.GEMINI_API_KEY or settings.HUGGINGFACE_API_KEY or settings.REPLICATE_API_KEY
    )


def _instruction(desc: str) -> str:
    """Roof-ONLY edit — the whole point vs the generic remodel visualizer."""
    return (
        f"Replace ONLY the roof shingles on this house with {desc}. "
        "Keep the walls, siding, windows, doors, gutters, landscaping, driveway, "
        "sky, and camera angle EXACTLY the same — change nothing but the roof "
        "covering. Photorealistic real-estate photograph, natural daylight."
    )


async def _fetch_tile(lat: float, lng: float) -> tuple[bytes, str] | None:
    """The confirmed satellite tile of this building — the img2img anchor."""
    try:
        from app.services import imagery_service
        tile = await imagery_service.fetch_satellite_image(lat, lng, zoom=20, width_px=1024, height_px=768)
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(tile.url, follow_redirects=True)
            r.raise_for_status()
            mt = (r.headers.get("content-type") or "image/png").split(";")[0].strip()
            if mt not in ("image/png", "image/jpeg", "image/webp"):
                mt = "image/png"
            return r.content, mt
    except Exception as e:
        logger.info("roofvision tile fetch failed: %s", e)
        return None


async def render_roof_options(
    lat: float, lng: float, palette: list[str] | None = None,
) -> list[dict]:
    """Render the roof in the contractor's chosen shingle colors (or the default
    palette). Returns [{key, name, tier, image_url}] — only the options that
    succeeded. Never raises; returns [] when disabled, no imagery, or every
    provider fails."""
    if not roofvision_enabled():
        return []
    anchor = await _fetch_tile(lat, lng)
    if not anchor:
        return []
    img_bytes, mime = anchor
    options = resolve_palette(palette)

    from app.services.visualizer_service import _generate_image

    async def _one(opt: dict) -> dict | None:
        try:
            url = await _generate_image(img_bytes, mime, _instruction(opt["desc"]))
            return {"key": opt["key"], "name": opt["name"], "tier": opt["tier"], "image_url": url}
        except Exception as e:
            logger.info("roofvision render failed for %s: %s", opt["key"], e)
            return None

    results = await asyncio.gather(*[_one(o) for o in options])
    return [r for r in results if r]
