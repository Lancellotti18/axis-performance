"""Fetch Google Solar Data Layers and turn them into arrays roof_from_dsm reads.

    dataLayers:get  ->  URLs for a DSM, a roof mask and an aerial RGB image,
                        centred on the tapped house (valid for one hour)
    geoTiff:get     ->  each GeoTIFF, fetched with the API key
    this module     ->  numpy arrays, the ground size of a pixel, the imagery
                        date, and WHERE THE TAPPED HOUSE IS in those arrays

That last one is the right-house rule: the engine measures the roof under the
tap, so the tap's pixel must be computed from the file's own georeference —
never assumed to be the image centre, even though the request is centred on it.

Google's GeoTIFFs are in UTM (metres on a flat grid). The lat/lng -> UTM
conversion is done here with the standard Transverse Mercator series rather
than pulling in pyproj and its ~20 MB of projection data for one formula.

Cost: Data Layers is Google's Enterprise SKU — free for the first 1,000 calls a
month, then $0.075 each (price list, 2026-09-29). One call per measured roof.
"""
from __future__ import annotations

import io
import logging
import math
from dataclasses import dataclass, field
from typing import Optional

import httpx
import numpy as np

logger = logging.getLogger(__name__)

DATA_LAYERS_URL = "https://solar.googleapis.com/v1/dataLayers:get"


# ── lat/lng -> UTM (WGS84) ───────────────────────────────────────────────

_A = 6378137.0                    # WGS84 semi-major axis
_F = 1 / 298.257223563
_E2 = _F * (2 - _F)
_EP2 = _E2 / (1 - _E2)
_K0 = 0.9996


def utm_zone(lng: float) -> int:
    return int((lng + 180) // 6) + 1


def latlng_to_utm(lat: float, lng: float, zone: Optional[int] = None) -> tuple[float, float, int]:
    """(easting, northing, zone). Northing is for the northern hemisphere, which
    is all Axis serves; southern zones would add 10,000,000 m."""
    zone = zone or utm_zone(lng)
    lam0 = math.radians((zone - 1) * 6 - 180 + 3)
    phi, lam = math.radians(lat), math.radians(lng)
    n = _A / math.sqrt(1 - _E2 * math.sin(phi) ** 2)
    t = math.tan(phi) ** 2
    c = _EP2 * math.cos(phi) ** 2
    a = math.cos(phi) * (lam - lam0)
    e4, e6 = _E2 ** 2, _E2 ** 3
    m = _A * ((1 - _E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
              - (3 * _E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * math.sin(2 * phi)
              + (15 * e4 / 256 + 45 * e6 / 1024) * math.sin(4 * phi)
              - (35 * e6 / 3072) * math.sin(6 * phi))
    easting = _K0 * n * (a + (1 - t + c) * a ** 3 / 6
                         + (5 - 18 * t + t * t + 72 * c - 58 * _EP2) * a ** 5 / 120) + 500000.0
    northing = _K0 * (m + n * math.tan(phi) * (a * a / 2
                      + (5 - t + 9 * c + 4 * c * c) * a ** 4 / 24
                      + (61 - 58 * t + t * t + 600 * c - 330 * _EP2) * a ** 6 / 720))
    return easting, northing, zone


# ── GeoTIFF ──────────────────────────────────────────────────────────────

_TAG_PIXEL_SCALE = 33550
_TAG_TIEPOINT = 33922
_TAG_TRANSFORM = 34264          # 4x4 ModelTransformation — what Google's files actually use
_TAG_GEOKEYS = 34735
_GEOKEY_PROJECTED_CRS = 3072


@dataclass
class Raster:
    data: np.ndarray
    scale_x: float                 # metres per pixel, east
    scale_y: float                 # metres per pixel, south
    origin_e: float                # easting of the top-left corner of pixel (0,0)
    origin_n: float                # northing of the same corner
    epsg: Optional[int]

    def pixel_of(self, easting: float, northing: float) -> tuple[int, int]:
        """(row, col) of the pixel containing a UTM point."""
        col = (easting - self.origin_e) / self.scale_x
        row = (self.origin_n - northing) / self.scale_y
        return int(math.floor(row)), int(math.floor(col))


def read_geotiff(blob: bytes) -> Raster:
    """Pixels plus the three GeoTIFF tags that place them on the ground."""
    from PIL import Image
    im = Image.open(io.BytesIO(blob))
    tags = im.tag_v2
    scale = tags.get(_TAG_PIXEL_SCALE)
    tie = tags.get(_TAG_TIEPOINT)
    xform = tags.get(_TAG_TRANSFORM)
    if not xform and (not scale or not tie):
        raise ValueError("not a GeoTIFF: no transformation, pixel scale or tiepoint tag")
    epsg = None
    keys = tags.get(_TAG_GEOKEYS)
    if keys:
        k = list(keys)
        for i in range(4, len(k), 4):                 # header is 4 shorts, then 4 per key
            if k[i] == _GEOKEY_PROJECTED_CRS:
                epsg = int(k[i + 3])
    # Pixels come from OpenCV's libtiff, NOT Pillow. On Google's real files
    # (tiled, Adobe-deflate, 32-bit float) Pillow returned plausible-looking
    # arrays of garbage — heights of +/-1e38 m — without raising. OpenCV decodes
    # them correctly. Pillow is kept only for the tags above.
    import cv2
    data = cv2.imdecode(np.frombuffer(blob, np.uint8), cv2.IMREAD_UNCHANGED | cv2.IMREAD_ANYDEPTH)
    if data is None:
        data = np.array(im)
    elif data.ndim == 3 and data.shape[2] == 3:
        data = data[..., ::-1]                   # OpenCV is BGR; keep RGB as RGB
    if data.dtype.kind == "f":
        finite = data[np.isfinite(data)]
        if finite.size == 0 or float(np.abs(finite).max()) > 20000.0:
            raise ValueError("height values are not plausible elevations — decode failed")
    if xform:
        # Row-major 4x4: E = m0*col + m1*row + m3 ;  N = m4*col + m5*row + m7.
        # Google's is axis-aligned (m1 = m4 = 0) with m5 negative (rows run south).
        m = [float(v) for v in list(xform)[:16]]
        if abs(m[1]) > 1e-9 or abs(m[4]) > 1e-9:
            raise ValueError("rotated GeoTIFF grids are not supported")
        return Raster(data, m[0], -m[5], m[3], m[7], epsg)
    # Tiepoint: (i, j, k, X, Y, Z) — raster point (i, j) sits at map point (X, Y).
    i, j, _, X, Y, _ = [float(v) for v in list(tie)[:6]]
    sx, sy = float(scale[0]), float(scale[1])
    return Raster(data, sx, sy, X - i * sx, Y + j * sy, epsg)


# ── The fetch ────────────────────────────────────────────────────────────

@dataclass
class LayerSet:
    available: bool
    reason: Optional[str] = None
    dsm: Optional[np.ndarray] = None
    mask: Optional[np.ndarray] = None
    rgb: Optional[np.ndarray] = None
    px_m: float = 0.0
    seed_rc: Optional[tuple[int, int]] = None
    imagery_date: Optional[str] = None
    imagery_quality: Optional[str] = None
    epsg: Optional[int] = None
    notes: list[str] = field(default_factory=list)
    origin_e: float = 0.0          # UTM of the top-left corner of pixel (0, 0)
    origin_n: float = 0.0


def assemble(dsm: Raster, mask: Raster, rgb: Optional[Raster], lat: float, lng: float,
             meta: dict) -> LayerSet:
    """Everything after the downloads, kept separate so it can be tested with
    synthetic rasters."""
    notes = []
    epsg = dsm.epsg
    zone = None
    if epsg and (32601 <= epsg <= 32660):
        zone = epsg - 32600
    elif epsg:
        return LayerSet(False, f"unexpected map projection EPSG:{epsg}; not measuring")
    e, n, z = latlng_to_utm(lat, lng, zone)
    if zone is None:
        notes.append(f"no projection tag; assumed UTM zone {z}")
    seed = dsm.pixel_of(e, n)
    h, w = dsm.data.shape[:2]
    if not (0 <= seed[0] < h and 0 <= seed[1] < w):
        return LayerSet(False, "the tapped house is outside the area Google returned")

    m = mask.data
    if m.ndim == 3:
        m = m[..., 0]
    if m.shape != dsm.data.shape[:2]:
        import cv2
        m = cv2.resize(m.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)
        notes.append("mask resampled to the height map's grid")
    if abs(dsm.scale_x - dsm.scale_y) > 1e-6:
        notes.append(f"non-square pixels {dsm.scale_x}x{dsm.scale_y} m")
    return LayerSet(
        True, None,
        dsm=np.asarray(dsm.data, dtype=np.float32),
        mask=np.asarray(m) > 0,
        rgb=rgb.data if rgb is not None else None,
        px_m=float(dsm.scale_x),
        seed_rc=seed,
        imagery_date=meta.get("imagery_date"),
        imagery_quality=meta.get("imageryQuality"),
        epsg=epsg,
        notes=notes,
        origin_e=dsm.origin_e,
        origin_n=dsm.origin_n,
    )


async def fetch_layers(lat: float, lng: float, api_key: str, *, radius_m: float = 35.0,
                       pixel_m: float = 0.1) -> LayerSet:
    """Height map, roof mask and aerial image around the tapped house."""
    if not api_key:
        return LayerSet(False, "Google Solar API key not configured")
    params = {
        "location.latitude": f"{lat:.7f}", "location.longitude": f"{lng:.7f}",
        "radiusMeters": str(radius_m), "view": "IMAGERY_LAYERS",
        "requiredQuality": "MEDIUM", "pixelSizeMeters": str(pixel_m), "key": api_key,
    }
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.get(DATA_LAYERS_URL, params=params)
            if r.status_code == 404:
                return LayerSet(False, "no Google 3D coverage at this address")
            if r.status_code != 200:
                msg = ""
                try:
                    msg = (r.json().get("error") or {}).get("message") or ""
                except Exception:
                    pass
                return LayerSet(False, f"Google Data Layers error {r.status_code}: {msg[:200]}")
            meta = r.json()
            d = meta.get("imageryDate") or {}
            if d.get("year"):
                meta["imagery_date"] = f"{int(d['year']):04d}-{int(d.get('month', 1)):02d}-{int(d.get('day', 1)):02d}"
            urls = {k: meta.get(k) for k in ("dsmUrl", "maskUrl", "rgbUrl")}
            if not urls["dsmUrl"] or not urls["maskUrl"]:
                return LayerSet(False, "Google returned no height map or roof mask here")
            blobs = {}
            for k, u in urls.items():
                if not u:
                    continue
                # The URL already carries ?id=...; passing params= would REPLACE
                # that query (httpx does not merge), dropping the id -> HTTP 400.
                g = await client.get(httpx.URL(u).copy_merge_params({"key": api_key}))
                if g.status_code != 200:
                    return LayerSet(False, f"could not download {k} ({g.status_code})")
                blobs[k] = g.content
    except Exception as e:
        return LayerSet(False, f"Google Data Layers unreachable: {str(e)[:150]}")

    try:
        dsm = read_geotiff(blobs["dsmUrl"])
        mask = read_geotiff(blobs["maskUrl"])
        rgb = read_geotiff(blobs["rgbUrl"]) if "rgbUrl" in blobs else None
    except Exception as e:
        return LayerSet(False, f"could not read Google's map files: {str(e)[:150]}")
    return assemble(dsm, mask, rgb, lat, lng, meta)
