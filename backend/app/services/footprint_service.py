"""
Building footprint lookup — free, nationwide, no API key.

Where Google Solar has no coverage (rural / unprocessed), this provides the
next-best auto-draw head start: the building's OUTLINE. It queries OpenStreetMap
via the Overpass API, which serves real-time building polygons — and which has
absorbed Microsoft's ML-derived building footprints across much of the US, so
rural coverage is far better than OSM's hand-mapped data alone.

A footprint is just the plan-view perimeter of the building (the eaves outline),
NOT roof planes or pitch. So the contractor gets the whole-roof outline dropped
on the satellite tile as one starter facet, then splits it into planes and sets
pitch (a single ground photo gives pitch on any address). It's the rural
equivalent of Solar's head start, at zero cost.

Free + keyless. Cached 24h per address to respect Overpass's fair-use limits.
"""
from __future__ import annotations

import logging
import math
import time

import httpx

logger = logging.getLogger(__name__)

# Public Overpass endpoints, tried in order. The primary (overpass-api.de)
# aggressively throttles CLOUD egress IPs — from Render it frequently rejects
# every request even though the same query works from a laptop, which made
# footprints silently unavailable in production. The mirrors accept cloud
# traffic far more reliably; we cache 24h per address to stay well inside
# everyone's fair-use.
# Individual mirrors flake (kumi + private.coffee both timed out on a random
# Tuesday while overpass-api.de throttled our cloud IP) — so we RACE them all
# concurrently and take the first good answer instead of a slow serial ladder.
# 24h per-address caching keeps our total load tiny and fair.
OVERPASS_MIRRORS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]
_SEARCH_RADIUS_M = 60
_CACHE_TTL_SECONDS = 24 * 3600
_cache: dict[str, tuple[float, dict]] = {}


def _cache_key(lat: float, lng: float) -> str:
    return f"{lat:.5f},{lng:.5f}"


def _point_in_ring(lat: float, lng: float, ring: list[dict]) -> bool:
    """Ray-casting point-in-polygon. ring = [{'lat':..,'lng':..}, ...]."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        yi, xi = ring[i]["lat"], ring[i]["lng"]
        yj, xj = ring[j]["lat"], ring[j]["lng"]
        if ((yi > lat) != (yj > lat)) and (
            lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi
        ):
            inside = not inside
        j = i
    return inside


def _centroid(ring: list[dict]) -> tuple[float, float]:
    return (
        sum(p["lat"] for p in ring) / len(ring),
        sum(p["lng"] for p in ring) / len(ring),
    )


def _ring_from_way(el: dict) -> list[dict]:
    geom = el.get("geometry") or []
    ring = [{"lat": float(g["lat"]), "lng": float(g["lon"])} for g in geom if "lat" in g and "lon" in g]
    # Drop the duplicated closing node so we store an open ring.
    if len(ring) >= 2 and ring[0] == ring[-1]:
        ring = ring[:-1]
    return ring


async def _race_mirrors(query: str, budget_s: float = 14.0) -> dict | None:
    """Fire the query at every mirror concurrently; first valid JSON wins.
    A serial ladder took ~40s when two mirrors hung — the race answers in the
    time of the FASTEST healthy mirror."""
    import asyncio

    async def one(client: httpx.AsyncClient, mirror: str):
        r = await client.post(mirror, data={"data": query})
        r.raise_for_status()
        return r.json()

    async with httpx.AsyncClient(timeout=budget_s, headers={"User-Agent": "axis-performance/1.0"}) as client:
        tasks = [asyncio.create_task(one(client, m)) for m in OVERPASS_MIRRORS]
        try:
            for fut in asyncio.as_completed(tasks, timeout=budget_s):
                try:
                    data = await fut
                    if isinstance(data, dict) and "elements" in data:
                        return data
                except Exception as e:
                    logger.info("overpass mirror failed in race: %s", str(e)[:80])
        except asyncio.TimeoutError:
            logger.info("overpass race hit the %.0fs budget", budget_s)
        finally:
            for t in tasks:
                t.cancel()
    return None


async def get_building_footprint(lat: float, lng: float) -> dict:
    """
    Return the subject building's footprint polygon near (lat, lng).

    Returns:
      {"available": True, "source": "openstreetmap",
       "ring": [{"lat":..,"lng":..}, ...]}        # the building outline
      or {"available": False, "reason": "..."}
    """
    key = _cache_key(lat, lng)
    hit = _cache.get(key)
    if hit and (time.time() - hit[0]) < _CACHE_TTL_SECONDS:
        return {**hit[1], "cached": True}

    query = (
        f"[out:json][timeout:15];"
        f'(way["building"](around:{_SEARCH_RADIUS_M},{lat:.7f},{lng:.7f}););'
        f"out geom;"
    )
    data = await _race_mirrors(query)
    if data is None:
        # Don't cache transient failures.
        return {"available": False, "reason": "Footprint service unreachable (all mirrors failed)"}

    elements = [e for e in (data.get("elements") or []) if e.get("type") == "way"]
    candidates: list[list[dict]] = []
    for el in elements:
        ring = _ring_from_way(el)
        if len(ring) >= 3:
            candidates.append(ring)

    if not candidates:
        result = {"available": False, "reason": "No mapped building outline at this address."}
        _cache[key] = (time.time(), result)
        return result

    # Prefer the building whose polygon CONTAINS the point; among those, the
    # smallest (the subject house, not a sprawling enclosing polygon). If none
    # contain it, take the nearest by centroid.
    containing = [r for r in candidates if _point_in_ring(lat, lng, r)]
    if containing:
        chosen = min(containing, key=lambda r: _ring_area_deg2(r))
        match = "contained"
    else:
        def _dist(r: list[dict]) -> float:
            cy, cx = _centroid(r)
            return math.hypot(cy - lat, cx - lng)
        chosen = min(candidates, key=_dist)
        match = "nearest"

    # How the building was chosen matters to the caller. "contained" means the
    # query point is inside this outline — as certain as this gets. "nearest" is
    # a guess: an address geocode routinely lands on the street or the parcel
    # rather than the roof, and then the closest centroid among several
    # neighbours is close to a coin flip. Callers that pre-select a building for
    # the user must not present a guess as a finding.
    result = {"available": True, "source": "openstreetmap", "ring": chosen,
              "match": match, "confident": match == "contained",
              "candidates": len(candidates)}
    _cache[key] = (time.time(), result)
    return result


def _ring_area_deg2(ring: list[dict]) -> float:
    """Shoelace area in (degrees²) — only used to compare candidate sizes."""
    a = 0.0
    n = len(ring)
    for i in range(n):
        j = (i + 1) % n
        a += ring[i]["lng"] * ring[j]["lat"]
        a -= ring[j]["lng"] * ring[i]["lat"]
    return abs(a) / 2.0


# ---------------------------------------------------------------------------
# "That one" from the street
# ---------------------------------------------------------------------------
# A contractor recognises a house from the road far more easily than from
# above. When they click it in a Street View photo, the click gives a compass
# bearing from the camera, and the house they meant is the FIRST building that
# bearing runs into. Everything behind it is hidden from the camera anyway.

_RAY_MAX_M = 150.0
_rays_cache: dict[str, tuple[float, list[list[dict]] | None]] = {}


async def buildings_near(lat: float, lng: float, radius_m: float = _RAY_MAX_M) -> list[list[dict]] | None:
    """Every mapped building outline within radius_m. None means the lookup
    itself failed (not cached, so a flaky mirror can't poison an address);
    [] means it worked and there is nothing mapped there."""
    key = f"{_cache_key(lat, lng)}@{radius_m:.0f}"
    hit = _rays_cache.get(key)
    if hit and (time.time() - hit[0]) < _CACHE_TTL_SECONDS:
        return hit[1]
    query = (
        f"[out:json][timeout:15];"
        f'(way["building"](around:{radius_m:.0f},{lat:.7f},{lng:.7f}););'
        f"out geom;"
    )
    data = await _race_mirrors(query)
    if data is None:
        return None
    rings = [r for r in (_ring_from_way(e) for e in (data.get("elements") or [])
                         if e.get("type") == "way") if len(r) >= 3]
    # Bounded like the per-address cache's neighbours: a dense block can hold a
    # few hundred outlines, so keep only a modest number of camera positions.
    if len(_rays_cache) >= 40:
        for k in sorted(_rays_cache, key=lambda k: _rays_cache[k][0])[:10]:
            _rays_cache.pop(k, None)
    _rays_cache[key] = (time.time(), rings)
    return rings


def _to_local_m(lat: float, lng: float, o_lat: float, o_lng: float) -> tuple[float, float]:
    """(east, north) metres from the origin. Flat-earth is exact enough at 150 m."""
    return ((lng - o_lng) * 111320.0 * math.cos(math.radians(o_lat)),
            (lat - o_lat) * 111320.0)


def first_building_on_bearing(cam_lat: float, cam_lng: float, bearing_deg: float,
                              rings: list[list[dict]],
                              max_m: float = _RAY_MAX_M) -> tuple[list[dict], float] | None:
    """The building a ray from the camera hits first, and how far away it is.

    bearing_deg is a compass bearing (0 = north, 90 = east). A building the
    camera is standing inside is skipped: that happens when a panorama was shot
    from a driveway under a carport, and it is never the house being pointed at.
    """
    b = math.radians(bearing_deg)
    dx, dy = math.sin(b), math.cos(b)            # unit ray, east/north
    best: tuple[list[dict], float] | None = None
    for ring in rings:
        if _point_in_ring(cam_lat, cam_lng, ring):
            continue
        pts = [_to_local_m(p["lat"], p["lng"], cam_lat, cam_lng) for p in ring]
        n = len(pts)
        for i in range(n):
            (ax, ay), (bx, by) = pts[i], pts[(i + 1) % n]
            ex, ey = bx - ax, by - ay
            den = dx * ey - dy * ex
            if abs(den) < 1e-12:
                continue                          # edge parallel to the ray
            # Solve camera + t*ray == a + u*edge.
            t = (ax * ey - ay * ex) / den
            u = (ax * dy - ay * dx) / den
            if 0.0 <= u <= 1.0 and 0.0 < t <= max_m and (best is None or t < best[1]):
                best = (ring, t)
    return best
