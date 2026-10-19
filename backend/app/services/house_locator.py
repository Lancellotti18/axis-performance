"""Which building is the house — found from the same Google data Axis measures.

The house picker used to start from a Google Street View photo ("click the
house in the street photo") and outline the building from OpenStreetMap. The
first founding contractor (Fortitude, 2026-10-13) quit on that screen: his
street photo was from February 2008 with the house behind pine trees, and the
OpenStreetMap servers were down ("all mirrors failed"), so there was no outline
either. Nothing on the screen said "here is your house — is this right?".

This module answers that question from Google's Solar data instead:
  1. buildingInsights:findClosest gives the building nearest a point (the
     address, or wherever the contractor clicked) and its centre;
  2. the Data Layers roof mask gives that roof's real outline;
  3. if the mask is unavailable, Google's bounding box stands in.
Because auto-measure reads the same data at the same centre, the roof the
contractor confirms here is exactly the roof that gets measured.
"""
from __future__ import annotations

import logging
import math
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

OUTLINE_TOL_M = 0.3          # simplification: keeps corners, drops pixel stair-steps
SEARCH_M = 5.0               # how far from the centre a roof pixel may be found


def _offset_latlng(lat0: float, lng0: float, east_m: float, north_m: float) -> dict:
    return {"lat": lat0 + north_m / 111320.0,
            "lng": lng0 + east_m / (111320.0 * math.cos(math.radians(lat0)))}


def outline_from_mask(mask: np.ndarray, px_m: float, origin_e: float, origin_n: float,
                      center_en: tuple[float, float], center_ll: tuple[float, float]) -> Optional[list[dict]]:
    """The outline of the roof under (or nearest to) the building centre, as
    lat/lng points, or None when there is no roof there."""
    import cv2
    binary = (np.asarray(mask) > 0).astype(np.uint8)
    if not binary.any():
        return None
    H, W = binary.shape
    col = int(math.floor((center_en[0] - origin_e) / px_m))
    row = int(math.floor((origin_n - center_en[1]) / px_m))
    n, comp = cv2.connectedComponents(binary, connectivity=8)
    label = int(comp[row, col]) if 0 <= row < H and 0 <= col < W else 0
    if label == 0:
        # The centre can fall in a courtyard or just off a narrow roof: take the
        # nearest roof pixel within SEARCH_M.
        ys, xs = np.nonzero(binary)
        d = (ys - row) ** 2 + (xs - col) ** 2
        i = int(np.argmin(d))
        if math.sqrt(float(d[i])) * px_m > SEARCH_M:
            return None
        label = int(comp[ys[i], xs[i]])
    piece = (comp == label).astype(np.uint8)
    contours, _ = cv2.findContours(piece, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    c = max(contours, key=cv2.contourArea)
    approx = cv2.approxPolyDP(c, OUTLINE_TOL_M / px_m, True).reshape(-1, 2)
    if len(approx) < 3:
        return None
    lat0, lng0 = center_ll
    out = []
    for x, y in approx:
        e = origin_e + (float(x) + 0.5) * px_m
        nrt = origin_n - (float(y) + 0.5) * px_m
        out.append(_offset_latlng(lat0, lng0, e - center_en[0], nrt - center_en[1]))
    return out


def _box_outline(bbox: Optional[dict]) -> Optional[list[dict]]:
    if not bbox:
        return None
    sw, ne = bbox.get("sw") or {}, bbox.get("ne") or {}
    if None in (sw.get("lat"), sw.get("lng"), ne.get("lat"), ne.get("lng")):
        return None
    return [{"lat": sw["lat"], "lng": sw["lng"]}, {"lat": sw["lat"], "lng": ne["lng"]},
            {"lat": ne["lat"], "lng": ne["lng"]}, {"lat": ne["lat"], "lng": sw["lng"]}]


async def building_at(lat: float, lng: float, api_key: str) -> dict:
    """{available, center, outline, outline_source, imagery_date} for the
    building nearest (lat, lng); {available: False, reason} when Google has no
    building there, so the screen can ask the contractor to click the roof."""
    from app.services import solar_service, solar_layers_service as SL

    insights = await solar_service.get_building_insights(lat, lng, required_quality="MEDIUM")
    if not insights.get("available"):
        return {"available": False, "reason": insights.get("reason") or "No building found here."}
    center = insights.get("center") or {}
    clat, clng = center.get("lat"), center.get("lng")
    if clat is None or clng is None:
        return {"available": False, "reason": "No building found here."}
    clat, clng = float(clat), float(clng)

    outline, source = None, None
    imagery_date = insights.get("imagery_date")
    try:
        meta, _why = await SL.fetch_metadata(clat, clng, api_key)
        if meta and meta.get("maskUrl"):
            import httpx
            async with httpx.AsyncClient(timeout=30) as client:
                g = await client.get(httpx.URL(meta["maskUrl"]).copy_merge_params({"key": api_key}))
            if g.status_code == 200:
                r = SL.read_geotiff(g.content)
                zone = (r.epsg - 32600) if r.epsg and 32601 <= r.epsg <= 32660 else None
                ce, cn, _ = SL.latlng_to_utm(clat, clng, zone)
                outline = outline_from_mask(r.data, r.scale_x, r.origin_e, r.origin_n, (ce, cn), (clat, clng))
                if outline:
                    source = "roof"
            imagery_date = meta.get("imagery_date") or imagery_date
    except Exception as e:                       # the box below still marks the house
        logger.info("roof outline unavailable at %.6f,%.6f: %s", clat, clng, e)
    if not outline:
        outline = _box_outline(insights.get("building_bbox"))
        source = "box" if outline else None
    return {"available": True, "center": {"lat": clat, "lng": clng}, "outline": outline or [],
            "outline_source": source, "imagery_date": imagery_date}
