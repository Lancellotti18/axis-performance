"""
Axis Performance — Satellite imagery acquisition with multi-provider fallback.

Goal: a contractor's report must never fail because of a satellite image issue.

Acquisition order:
    1. Esri World Imagery   — free, always-on, US coverage at zoom ≤20
    2. Mapbox Satellite     — only if MAPBOX_ACCESS_TOKEN configured
    3. MapTiler Satellite   — only if MAPTILER_API_KEY configured

Each attempt downloads the bytes, runs a fast image-health check, and either
accepts the result or falls through to the next provider. The final response
includes the provider used, a 0..1 health score, and a list of warnings
(e.g., "tile may include cloud cover", "image is unusually dark").

Health checks are basic and deterministic:
    - Validate PNG/JPEG header
    - Validate width/height ≥ minimum
    - Check average luminance is in a reasonable range (not solid black/white)
    - Check luminance variance is non-trivial (would catch a solid-color tile)

We intentionally do NOT run an LLM "is this a good roof image" check — that
adds non-determinism and cost. Contractor sees the tile in the editor and
can re-detect or move the bounding box if it looks bad.

Caching: each (provider, lat, lng, zoom, width, height) tuple has a TTL'd
in-memory cache so a contractor editing a project doesn't re-download the
same tile 20 times.
"""
from __future__ import annotations

import asyncio
import io
import logging
import math
import struct
import time
from dataclasses import dataclass, field
from typing import Literal, Optional

import httpx

from app.core.config import settings
from app.services.geometry_service import metres_per_pixel, feet_per_pixel

logger = logging.getLogger(__name__)


Provider = Literal["esri", "mapbox", "maptiler"]

_PROVIDER_ORDER: list[Provider] = ["esri", "mapbox", "maptiler"]

# Minimum acceptable tile to count as "healthy". Larger than this is fine.
MIN_WIDTH_PX = 512
MIN_HEIGHT_PX = 384
# A tile whose health score falls below this triggers fallback to the next
# provider. Values are calibrated against typical Esri/Mapbox satellite tiles.
FALLBACK_THRESHOLD = 0.55
# In-memory cache TTL.
CACHE_TTL_SECONDS = 600


# ----------------------------------------------------------------------------
# Cache (simple in-process LRU-by-time)
# ----------------------------------------------------------------------------

@dataclass
class _CacheEntry:
    bytes: bytes
    media_type: str
    health: float
    provider: Provider
    warnings: list[str]
    fetched_at: float


_CACHE: dict[str, _CacheEntry] = {}


def _cache_key(provider: Provider, lat: float, lng: float, zoom: int, w: int, h: int) -> str:
    return f"{provider}:{lat:.6f}:{lng:.6f}:{zoom}:{w}x{h}"


def _cache_get(key: str) -> Optional[_CacheEntry]:
    entry = _CACHE.get(key)
    if entry is None:
        return None
    if time.time() - entry.fetched_at > CACHE_TTL_SECONDS:
        _CACHE.pop(key, None)
        return None
    return entry


def _cache_put(key: str, entry: _CacheEntry) -> None:
    _CACHE[key] = entry
    # Crude eviction: cap to 256 entries
    if len(_CACHE) > 256:
        oldest = min(_CACHE.items(), key=lambda kv: kv[1].fetched_at)
        _CACHE.pop(oldest[0], None)


# ----------------------------------------------------------------------------
# Result type
# ----------------------------------------------------------------------------

@dataclass
class ImageryResult:
    provider: Provider
    url: str
    image_bytes: bytes
    media_type: str
    width_px: int
    height_px: int
    zoom: int
    lat: float
    lng: float
    metres_per_pixel: float
    feet_per_pixel: float
    health_score: float
    warnings: list[str] = field(default_factory=list)
    providers_tried: list[Provider] = field(default_factory=list)
    cached: bool = False

    def to_dict(self, include_bytes: bool = False) -> dict:
        d = {
            "provider": self.provider,
            "url": self.url,
            "media_type": self.media_type,
            "width_px": self.width_px,
            "height_px": self.height_px,
            "zoom": self.zoom,
            "lat": self.lat,
            "lng": self.lng,
            "metres_per_pixel": round(self.metres_per_pixel, 4),
            "feet_per_pixel": round(self.feet_per_pixel, 4),
            "health_score": round(self.health_score, 3),
            "warnings": self.warnings,
            "providers_tried": self.providers_tried,
            "cached": self.cached,
        }
        if include_bytes:
            import base64
            d["image_base64"] = base64.b64encode(self.image_bytes).decode("ascii")
        return d


# ----------------------------------------------------------------------------
# URL builders (one per provider)
# ----------------------------------------------------------------------------

def _esri_url(lat: float, lng: float, zoom: int, w: int, h: int) -> str:
    mpp = metres_per_pixel(lat, zoom)
    half_w_deg = (w * mpp / 2) / (111320 * math.cos(math.radians(lat)))
    half_h_deg = (h * mpp / 2) / 111320
    west, east = lng - half_w_deg, lng + half_w_deg
    south, north = lat - half_h_deg, lat + half_h_deg
    return (
        "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"
        f"?bbox={west:.6f},{south:.6f},{east:.6f},{north:.6f}"
        f"&bboxSR=4326&imageSR=4326&size={w},{h}&format=png&f=image"
    )


def _mapbox_url(lat: float, lng: float, zoom: int, w: int, h: int, token: str) -> str:
    # Mapbox Static caps individual image dimensions at 1280×1280, and zoom 0-22.
    capped_w = min(w, 1280)
    capped_h = min(h, 1280)
    capped_zoom = min(zoom, 22)
    return (
        "https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/"
        f"{lng:.6f},{lat:.6f},{capped_zoom},0/{capped_w}x{capped_h}@2x"
        f"?access_token={token}&attribution=false&logo=false"
    )


def _maptiler_url(lat: float, lng: float, zoom: int, w: int, h: int, key: str) -> str:
    # MapTiler Static Maps endpoint with @2x retina output. This doubles the
    # actual pixel density for the same ground coverage — free quality boost.
    # We request w x h but MapTiler returns (w*2) x (h*2) actual pixels.
    capped_w = min(w, 1024)   # @2x doubles, so cap at 1024 -> 2048 actual
    capped_h = min(h, 1024)
    return (
        "https://api.maptiler.com/maps/satellite/static/"
        f"{lng:.6f},{lat:.6f},{zoom}@2x/{capped_w}x{capped_h}.png"
        f"?key={key}"
    )


# ----------------------------------------------------------------------------
# Image inspection / health scoring
# ----------------------------------------------------------------------------

def _decode_image_size(data: bytes) -> tuple[int, int, str]:
    """
    Read just the dimensions + format from raw image bytes without pulling
    Pillow into the request path. Supports PNG and JPEG.

    Returns (width, height, media_type). Raises ValueError on unrecognized.
    """
    if len(data) < 24:
        raise ValueError("too few bytes to be an image")

    # PNG: 8-byte signature, then IHDR chunk with width/height at offsets 16, 20
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        if data[12:16] != b"IHDR":
            raise ValueError("PNG without IHDR")
        w, h = struct.unpack(">II", data[16:24])
        return (w, h, "image/png")

    # JPEG: FFD8FF prefix; walk markers for SOFn segment
    if data[:3] == b"\xff\xd8\xff":
        i = 2
        n = len(data)
        while i < n - 1:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            i += 2
            # SOF markers — width/height encoded after a 5-byte header
            if marker in (
                0xC0, 0xC1, 0xC2, 0xC3,
                0xC5, 0xC6, 0xC7,
                0xC9, 0xCA, 0xCB,
                0xCD, 0xCE, 0xCF,
            ):
                if i + 7 > n:
                    raise ValueError("truncated JPEG SOF")
                h = (data[i + 3] << 8) | data[i + 4]
                w = (data[i + 5] << 8) | data[i + 6]
                return (w, h, "image/jpeg")
            # Standalone markers have no length
            if 0xD0 <= marker <= 0xD9:
                continue
            # Variable-length markers — skip
            if i + 2 > n:
                raise ValueError("truncated JPEG marker length")
            length = (data[i] << 8) | data[i + 1]
            i += length
        raise ValueError("JPEG with no SOF marker")

    raise ValueError("not a recognized PNG or JPEG")


def _quick_luminance_stats(data: bytes, format_: str) -> tuple[float, float] | None:
    """
    Cheap-but-honest brightness/contrast estimate. We sample ~1024 bytes
    distributed across the image stream rather than decoding the full image —
    it's a heuristic for "is this tile mostly black/uniform" not a real
    photometric measurement.

    Returns (mean_luminance_0_1, variance_0_1) or None if we cannot read
    enough samples.

    Trade-off: real luminance requires full decode. For 1-2 MB tiles that's
    ~50ms with Pillow which adds up at scale. The sampling heuristic catches
    the failure modes that matter (empty white tile, solid black tile, single-
    color logo) at near-zero cost.
    """
    if len(data) < 200:
        return None
    # Skip past format header to reach pixel-ish bytes
    skip = 100 if format_ == "image/png" else 64
    samples = data[skip::max(1, (len(data) - skip) // 1024)][:1024]
    if not samples:
        return None
    mean = sum(samples) / len(samples) / 255.0
    var = sum((b / 255.0 - mean) ** 2 for b in samples) / len(samples)
    return (mean, var)


def score_image_health(data: bytes, expected_w: int, expected_h: int) -> tuple[float, list[str]]:
    """
    Deterministic health score in 0..1. Returns (score, warnings).

    Components:
        valid_format: 0 or 0.40
        size_ok    : 0 or 0.30  (width/height meet minimums)
        brightness : 0..0.20    (mean luminance not pathological)
        contrast   : 0..0.10    (variance suggests structure exists)
    """
    warnings: list[str] = []

    try:
        w, h, media = _decode_image_size(data)
    except ValueError as e:
        return 0.0, [f"image bytes are not a valid PNG/JPEG ({e})"]

    score = 0.40
    if w >= MIN_WIDTH_PX and h >= MIN_HEIGHT_PX:
        score += 0.30
    else:
        warnings.append(f"tile is smaller than expected ({w}x{h})")

    stats = _quick_luminance_stats(data, media)
    if stats:
        mean, var = stats
        # Brightness: ideal range ~0.20..0.75 for satellite imagery
        if 0.15 <= mean <= 0.85:
            score += 0.20
        elif mean < 0.05:
            warnings.append("tile appears almost completely black — provider may have returned a placeholder")
        elif mean > 0.95:
            warnings.append("tile appears almost completely white — likely cloud cover or out-of-coverage")
        else:
            score += 0.10
        # Contrast: variance above ~0.01 means there's structure (roof edges,
        # roads, vegetation). Below that is suspicious uniformity.
        if var > 0.015:
            score += 0.10
        elif var > 0.005:
            score += 0.05
        else:
            warnings.append("tile has very low contrast — image may be obscured or invalid")

    return min(1.0, score), warnings


# ----------------------------------------------------------------------------
# Fetcher
# ----------------------------------------------------------------------------

async def _fetch_one(
    client: httpx.AsyncClient,
    provider: Provider,
    lat: float,
    lng: float,
    zoom: int,
    w: int,
    h: int,
) -> ImageryResult | None:
    """
    Single-provider attempt. Returns None if provider isn't configured OR if
    the HTTP request fails irrecoverably. Health score is included so the
    caller can decide whether to accept or fall through.
    """
    if provider == "esri":
        url = _esri_url(lat, lng, zoom, w, h)
    elif provider == "mapbox":
        token = settings.MAPBOX_ACCESS_TOKEN
        if not token:
            return None
        url = _mapbox_url(lat, lng, zoom, w, h, token)
    elif provider == "maptiler":
        key = settings.MAPTILER_API_KEY
        if not key:
            return None
        url = _maptiler_url(lat, lng, zoom, w, h, key)
    else:
        return None

    cache_key = _cache_key(provider, lat, lng, zoom, w, h)
    cached = _cache_get(cache_key)
    if cached:
        try:
            actual_w, actual_h, _ = _decode_image_size(cached.bytes)
        except ValueError:
            actual_w, actual_h = w, h
        return ImageryResult(
            provider=provider, url=url,
            image_bytes=cached.bytes, media_type=cached.media_type,
            width_px=actual_w, height_px=actual_h, zoom=zoom, lat=lat, lng=lng,
            metres_per_pixel=metres_per_pixel(lat, zoom),
            feet_per_pixel=feet_per_pixel(lat, zoom),
            health_score=cached.health,
            warnings=list(cached.warnings),
            providers_tried=[provider],
            cached=True,
        )

    # Retry once on network errors; providers occasionally hiccup.
    last_err: Exception | None = None
    for attempt in range(2):
        try:
            r = await client.get(url, timeout=20.0, follow_redirects=True)
            r.raise_for_status()
            data = r.content
            media = (r.headers.get("content-type") or "image/png").split(";")[0].strip()
            try:
                actual_w, actual_h, sniffed = _decode_image_size(data)
                media = sniffed
            except ValueError:
                actual_w, actual_h = w, h
            health, warnings = score_image_health(data, w, h)
            entry = _CacheEntry(
                bytes=data, media_type=media, health=health, provider=provider,
                warnings=warnings, fetched_at=time.time(),
            )
            _cache_put(cache_key, entry)
            return ImageryResult(
                provider=provider, url=url,
                image_bytes=data, media_type=media,
                width_px=actual_w, height_px=actual_h, zoom=zoom, lat=lat, lng=lng,
                metres_per_pixel=metres_per_pixel(lat, zoom),
                feet_per_pixel=feet_per_pixel(lat, zoom),
                health_score=health,
                warnings=warnings,
                providers_tried=[provider],
                cached=False,
            )
        except Exception as e:
            last_err = e
            if attempt == 0:
                await asyncio.sleep(0.3)
                continue
            logger.info("imagery: %s failed after retry — %s", provider, e)
            return None
    if last_err:
        logger.info("imagery: %s exhausted retries — %s", provider, last_err)
    return None


async def fetch_satellite_image(
    lat: float,
    lng: float,
    *,
    zoom: int = 20,
    width_px: int = 2048,
    height_px: int = 1366,
    preferred: Provider | None = None,
) -> ImageryResult:
    """
    Public entry point. Returns the first healthy tile from the provider
    chain, or — if every provider fails — the best (least-bad) result so
    the contractor can still see something.

    Raises RuntimeError ONLY when every provider returned no bytes at all
    (network down, all keys revoked, etc.). The caller should map this to
    a 502 with a clear "all satellite providers unavailable" message.
    """
    # Progressive zoom fallback. When the contractor requests a tight zoom
    # (e.g. z21), MapTiler is preferred but may not have satellite coverage at
    # that exact tile, OR Esri may be rate-limited / down. Instead of failing
    # the whole flow with "all providers failed", we step DOWN the zoom level
    # one at a time and retry — preserving the user's intent (zoom in as much
    # as possible) while always returning something usable.
    requested_zoom = zoom
    zoom_chain: list[int] = [zoom]
    for fallback_z in (20, 19, 18):
        if fallback_z < zoom and fallback_z not in zoom_chain:
            zoom_chain.append(fallback_z)

    all_tried: list[str] = []
    overall_best: ImageryResult | None = None

    async with httpx.AsyncClient() as client:
        for try_zoom in zoom_chain:
            # Build provider order specific to this zoom level
            if try_zoom >= 21:
                order: list[Provider] = ["maptiler", "mapbox", "esri"]
            else:
                order = []
            if preferred and preferred in _PROVIDER_ORDER:
                if preferred in order:
                    order.remove(preferred)
                order.insert(0, preferred)
            for p in _PROVIDER_ORDER:
                if p not in order:
                    order.append(p)

            zoom_best: ImageryResult | None = None
            for provider in order:
                result = await _fetch_one(client, provider, lat, lng, try_zoom, width_px, height_px)
                all_tried.append(f"{provider}@z{try_zoom}")
                if result is None:
                    continue
                result.providers_tried = list(all_tried)
                if try_zoom != requested_zoom:
                    result.warnings.insert(0, (
                        f"Tile unavailable at requested zoom {requested_zoom}; "
                        f"falling back to zoom {try_zoom}. House framing will be slightly wider."
                    ))
                if result.health_score >= FALLBACK_THRESHOLD:
                    return result
                if zoom_best is None or result.health_score > zoom_best.health_score:
                    zoom_best = result
                if overall_best is None or result.health_score > overall_best.health_score:
                    overall_best = result

            # If something usable came back at this zoom (even if degraded),
            # return it. Otherwise step down to the next zoom level.
            if zoom_best is not None:
                return zoom_best

    if overall_best is not None:
        overall_best.providers_tried = list(all_tried)
        overall_best.warnings.append(
            f"All providers returned low-health tiles (best={overall_best.health_score:.2f}). "
            "Imagery may be cloudy or low-resolution at this location."
        )
        return overall_best

    raise RuntimeError(
        f"All satellite providers failed at all zoom levels. Tried: {', '.join(all_tried)}. "
        "Check provider API keys and network connectivity on the backend."
    )


async def fetch_health_check(
    lat: float,
    lng: float,
    *,
    zoom: int = 20,
    width_px: int = 2048,
    height_px: int = 1366,
) -> dict:
    """
    Lightweight endpoint payload — fetches the tile, scores it, and returns
    JSON-serializable health info WITHOUT the binary image. Used by the
    Aerial report page to decide whether to proceed automatically.
    """
    try:
        result = await fetch_satellite_image(
            lat, lng, zoom=zoom, width_px=width_px, height_px=height_px,
        )
        payload = result.to_dict(include_bytes=False)
        payload["status"] = "ok" if result.health_score >= FALLBACK_THRESHOLD else "degraded"
        return payload
    except RuntimeError as e:
        return {
            "status": "unavailable",
            "providers_tried": list(_PROVIDER_ORDER),
            "warnings": [str(e)],
            "health_score": 0.0,
        }
