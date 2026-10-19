"""
Axis Roofing Performance — Address validation, geocoding, and county lookup.

Replaces the static jurisdictions.ts dropdown with authoritative server-side
lookups. Address in → (canonical address, lat, lng, state, county, FIPS) out.

Primary source:
    US Census Geocoder /geographies endpoint
    Returns: coordinates + Counties[0].{NAME, GEOID, COUNTY}
    Free, no API key, authoritative (this is the data the federal
    government uses for redistricting).

Reverse lookup fallback (when we have lat/lng but no validated address):
    FCC Area API
    Returns: county_fips, county_name, state_code from a lat/lng point.

Address autocomplete suggestions:
    US Census Geocoder /onelineaddress endpoint with return_geographies=false
    (faster than /geographies for type-ahead since it skips the county join).

All endpoints are free, well-documented, and have no per-org rate limits we
need to worry about at our scale. We add courtesy retries and a 6-second
timeout so a slow Census response doesn't block the UI.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, asdict, field
from typing import Optional

import httpx

from app.core.config import settings
from app.services.jurisdiction import _STATE_NAMES

_STATE_ABBR = {name.lower(): code for code, name in _STATE_NAMES.items()}

logger = logging.getLogger(__name__)


CENSUS_BASE = "https://geocoding.geo.census.gov/geocoder"
CENSUS_BENCHMARK = "Public_AR_Current"
CENSUS_VINTAGE = "Current_Current"
FCC_AREA_URL = "https://geo.fcc.gov/api/census/area"
MAPTILER_GEOCODE_URL = "https://api.maptiler.com/geocoding"
GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
GOOGLE_AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete"


# ----------------------------------------------------------------------------
# Google (primary since 2026-10-18)
#
# The Census geocoder ESTIMATES a house's position along the street segment.
# In newer subdivisions that can be a block off: it put 1114 Willow Pond Ln,
# Leland — the first founding contractor's job — on 1146, 353 m away, so the
# house picker showed him (and Ryan) the wrong house. Google resolves the
# address to its ROOFTOP (within 0.5 m of Google's own building centre there),
# which is also the building auto-measure reads. Census, MapTiler and the FCC
# county lookup stay as fallbacks and for county FIPS.
# ----------------------------------------------------------------------------

def _google_key() -> str:
    return (getattr(settings, "GOOGLE_SOLAR_API_KEY", "") or "").strip()


def _parse_google_geocode(payload: dict) -> list["LocationMatch"]:
    """Matches from a Geocoding API response, rooftop-grade results first."""
    if (payload or {}).get("status") != "OK":
        return []
    out: list[LocationMatch] = []
    for res in payload.get("results") or []:
        comps: dict[str, dict] = {}
        for c in res.get("address_components") or []:
            for t in c.get("types") or []:
                comps.setdefault(t, c)
        loc = (res.get("geometry") or {}).get("location") or {}
        if loc.get("lat") is None or loc.get("lng") is None:
            continue
        num = (comps.get("street_number") or {}).get("long_name", "")
        route = (comps.get("route") or {}).get("long_name", "")
        county = (comps.get("administrative_area_level_2") or {}).get("long_name", "")
        if county.lower().endswith(" county"):
            county = county[: -len(" county")]
        out.append(LocationMatch(
            matched_address=(res.get("formatted_address") or "").removesuffix(", USA"),
            street=" ".join(x for x in (num, route) if x),
            city=((comps.get("locality") or comps.get("sublocality") or comps.get("postal_town")
                   or comps.get("administrative_area_level_3") or {}).get("long_name", "")),
            state=(comps.get("administrative_area_level_1") or {}).get("short_name", ""),
            zip=(comps.get("postal_code") or {}).get("long_name", ""),
            lat=float(loc["lat"]), lng=float(loc["lng"]),
            county=county, county_fips="", state_fips="",
            source="google:" + ((res.get("geometry") or {}).get("location_type") or "").lower(),
        ))
    out.sort(key=lambda m: 0 if m.source == "google:rooftop" else 1)
    return out


async def _google_geocode(client: httpx.AsyncClient, address: str) -> list["LocationMatch"]:
    key = _google_key()
    if not key:
        return []
    try:
        r = await client.get(GOOGLE_GEOCODE_URL, params={"address": address, "region": "us", "key": key},
                             timeout=8.0)
        data = r.json()
    except Exception as e:
        logger.info("google geocode failed: %s", e)
        return []
    if data.get("status") not in ("OK", "ZERO_RESULTS"):
        logger.warning("google geocode %s: %s", data.get("status"), (data.get("error_message") or "")[:160])
    return _parse_google_geocode(data)


def _parse_google_autocomplete(payload: dict) -> list["LocationMatch"]:
    """Suggestions from Places API (New). They carry no coordinates: picking one
    resolves it through _google_geocode (the screens already do that step)."""
    out: list[LocationMatch] = []
    for s in (payload or {}).get("suggestions") or []:
        p = s.get("placePrediction") or {}
        text = ((p.get("text") or {}).get("text") or "").removesuffix(", USA")
        if not text:
            continue
        fmt = p.get("structuredFormat") or {}
        street = (fmt.get("mainText") or {}).get("text", "")
        rest = [x.strip() for x in ((fmt.get("secondaryText") or {}).get("text", "")).split(",")]
        out.append(LocationMatch(
            matched_address=text, street=street,
            city=rest[0] if rest else "", state=rest[1] if len(rest) > 1 else "", zip="",
            lat=0.0, lng=0.0, county="", county_fips="", state_fips="", source="google:suggestion",
        ))
    return out


async def _google_autocomplete(client: httpx.AsyncClient, query: str, *,
                               proximity: tuple[float, float] | None = None) -> list["LocationMatch"]:
    key = _google_key()
    if not key:
        return []
    body: dict = {"input": query, "includedRegionCodes": ["us"]}
    if proximity:
        body["locationBias"] = {"circle": {"center": {"latitude": proximity[0], "longitude": proximity[1]},
                                           "radius": 50000.0}}
    try:
        r = await client.post(GOOGLE_AUTOCOMPLETE_URL, json=body, timeout=6.0,
                              headers={"X-Goog-Api-Key": key})
        data = r.json()
    except Exception as e:
        logger.info("google autocomplete failed: %s", e)
        return []
    if data.get("error"):
        logger.warning("google autocomplete: %s", str(data["error"].get("message", ""))[:160])
        return []
    return _parse_google_autocomplete(data)


# ----------------------------------------------------------------------------
# Result types
# ----------------------------------------------------------------------------

@dataclass
class LocationMatch:
    matched_address: str
    street: str
    city: str
    state: str           # 2-letter abbreviation
    zip: str
    lat: float
    lng: float
    county: str
    county_fips: str     # 5-digit: state(2) + county(3)
    state_fips: str
    source: str          # 'census', 'fcc'

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class SearchResult:
    matches: list[LocationMatch] = field(default_factory=list)
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "matches": [m.to_dict() for m in self.matches],
            "error": self.error,
        }


# ----------------------------------------------------------------------------
# MapTiler Geocoder (autocomplete-friendly — works with partial addresses)
# ----------------------------------------------------------------------------

async def _maptiler_autocomplete(
    client: httpx.AsyncClient, query: str, *, limit: int = 5,
    proximity: tuple[float, float] | None = None,
) -> list[LocationMatch]:
    """
    MapTiler geocoding suggests addresses as the user types. Unlike the
    Census Geocoder (which needs a near-complete address), MapTiler returns
    matches for partial input like "701 rip" within a few hundred ms.

    Returns LocationMatch with lat/lng + parsed components. County/FIPS are
    NOT populated here (MapTiler doesn't return FIPS); the caller can enrich
    with `enrich_with_county` once the user picks a suggestion.

    Falls through (empty list) if MAPTILER_API_KEY isn't set so the Census
    fallback still works.
    """
    key = settings.MAPTILER_API_KEY
    if not key:
        return []

    url = f"{MAPTILER_GEOCODE_URL}/{query}.json"
    params = {
        "key": key,
        "limit": limit,
        "country": "us",
        "autocomplete": "true",
        "language": "en",
    }
    if proximity:
        # Rank results near (lat, lng) first — "200 Market St" with no city
        # should mean the one in the contractor's town, not Massachusetts.
        params["proximity"] = f"{proximity[1]},{proximity[0]}"
    try:
        r = await client.get(url, params=params, timeout=5.0)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        logger.info("maptiler geocode failed for %r: %s", query, e)
        return []

    features = data.get("features") or []
    out: list[LocationMatch] = []
    for f in features:
        props = f.get("properties") or {}
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if len(coords) < 2:
            continue
        lng, lat = float(coords[0]), float(coords[1])

        # MapTiler context lists state, postal_code, etc. Walk it to extract.
        context = f.get("context") or []
        city = state = zip_code = ""
        # The town: prefer "municipality", then "locality", then "place" —
        # "place" can be a landmark ("The Cotton Exchange") sitting in front
        # of the actual town in the context list.
        towns = {}
        for c in context:
            kind = (c.get("id") or "").lower().split(".")[0]
            if kind in ("municipality", "locality", "place") and kind not in towns:
                towns[kind] = c.get("text") or ""
        city = towns.get("municipality") or towns.get("locality") or towns.get("place") or ""
        for c in context:
            cid = (c.get("id") or "").lower()
            ctext = c.get("text") or ""
            if cid.startswith("region"):
                # MapTiler region carries the full state name in 'text' but the
                # 2-letter abbreviation in 'short_code' (us-tx → tx). Without a
                # short_code, the name's first two letters made North Carolina
                # "NO" — look the name up instead.
                short = (c.get("short_code") or "").upper().split("-")[-1]
                state = short[:2] if short else _STATE_ABBR.get(ctext.strip().lower(), "")
            elif cid.startswith("postal"):
                zip_code = ctext

        # MapTiler returns the formatted label in `place_name` or `properties.label`
        matched_address = (
            f.get("place_name")
            or props.get("label")
            or props.get("name")
            or ""
        )
        street = props.get("name") or props.get("housenumber_street") or ""
        if not street and f.get("place_type") and "address" in f.get("place_type") and f.get("text"):
            # Address features keep the street in top-level `text` and the
            # house number in `address`; without this the whole place_name
            # ("…, Wilmington, North Carolina 28401, United States, …") became
            # the street line.
            street = f["text"]
        # If "name" is just a city/place and we have an address number, prefix it
        housenumber = props.get("housenumber") or f.get("address") or ""
        if housenumber and street and not street.startswith(housenumber):
            street = f"{housenumber} {street}".strip()

        out.append(LocationMatch(
            matched_address=matched_address,
            street=street,
            city=city,
            state=state,
            zip=zip_code,
            lat=lat,
            lng=lng,
            county="",       # filled in by FCC enrichment when user picks one
            county_fips="",
            state_fips="",
            source="maptiler",
        ))
    return out


# ----------------------------------------------------------------------------
# Census Geocoder
# ----------------------------------------------------------------------------

async def _census_geographies(
    client: httpx.AsyncClient, address: str
) -> list[LocationMatch]:
    """
    Geocode + county lookup in a single call. Returns 0..n LocationMatch
    objects (multiple matches mean the address is ambiguous).
    """
    params = {
        "address": address,
        "benchmark": CENSUS_BENCHMARK,
        "vintage": CENSUS_VINTAGE,
        "format": "json",
    }
    try:
        r = await client.get(f"{CENSUS_BASE}/geographies/onelineaddress", params=params, timeout=6.0)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        logger.info("census geographies failed for %r: %s", address, e)
        return []

    result = data.get("result") or {}
    matches = result.get("addressMatches") or []
    out: list[LocationMatch] = []
    for m in matches:
        coords = m.get("coordinates") or {}
        comp = m.get("addressComponents") or {}
        geos = m.get("geographies") or {}
        # Counties block contains the authoritative FIPS data
        counties = geos.get("Counties") or []
        county_info = counties[0] if counties else {}
        out.append(LocationMatch(
            matched_address=m.get("matchedAddress") or "",
            street=" ".join(filter(None, [
                comp.get("fromAddress") or "",
                (comp.get("preDirection") or "").strip(),
                (comp.get("preType") or "").strip(),
                comp.get("streetName") or "",
                (comp.get("suffixType") or "").strip(),
                (comp.get("suffixDirection") or "").strip(),
            ])).strip(),
            city=comp.get("city") or "",
            state=comp.get("state") or "",
            zip=comp.get("zip") or "",
            lat=float(coords.get("y") or 0.0),
            lng=float(coords.get("x") or 0.0),
            county=county_info.get("NAME") or "",
            county_fips=(county_info.get("GEOID") or "")[:5],
            state_fips=(county_info.get("GEOID") or "")[:2],
            source="census",
        ))
    return out


async def _census_oneline(
    client: httpx.AsyncClient, address: str
) -> list[LocationMatch]:
    """
    Address-only match (no county/FIPS). Faster than geographies; we use it
    for the typeahead so the user sees results within ~200ms.
    """
    params = {
        "address": address,
        "benchmark": CENSUS_BENCHMARK,
        "format": "json",
    }
    try:
        r = await client.get(f"{CENSUS_BASE}/locations/onelineaddress", params=params, timeout=4.0)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        logger.info("census oneline failed for %r: %s", address, e)
        return []

    result = data.get("result") or {}
    matches = result.get("addressMatches") or []
    out: list[LocationMatch] = []
    for m in matches:
        coords = m.get("coordinates") or {}
        comp = m.get("addressComponents") or {}
        out.append(LocationMatch(
            matched_address=m.get("matchedAddress") or "",
            street=" ".join(filter(None, [
                comp.get("fromAddress") or "",
                (comp.get("preDirection") or "").strip(),
                (comp.get("preType") or "").strip(),
                comp.get("streetName") or "",
                (comp.get("suffixType") or "").strip(),
                (comp.get("suffixDirection") or "").strip(),
            ])).strip(),
            city=comp.get("city") or "",
            state=comp.get("state") or "",
            zip=comp.get("zip") or "",
            lat=float(coords.get("y") or 0.0),
            lng=float(coords.get("x") or 0.0),
            county="",        # not in this endpoint
            county_fips="",
            state_fips="",
            source="census",
        ))
    return out


# ----------------------------------------------------------------------------
# FCC Area API
# ----------------------------------------------------------------------------

async def _fcc_county_from_latlng(
    client: httpx.AsyncClient, lat: float, lng: float
) -> Optional[dict]:
    """
    Given a lat/lng, return {county, county_fips, state, state_fips, block_fips}
    from the FCC Area API. Used to enrich Census /locations matches when the
    user picked a typeahead result and we now need the county before persisting.
    """
    params = {"lat": lat, "lon": lng, "format": "json"}
    try:
        r = await client.get(FCC_AREA_URL, params=params, timeout=5.0)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        logger.info("fcc area failed for (%s,%s): %s", lat, lng, e)
        return None

    results = data.get("results") or []
    if not results:
        return None
    first = results[0]
    return {
        "county": first.get("county_name") or "",
        "county_fips": first.get("county_fips") or "",
        "state": first.get("state_code") or "",
        "state_fips": first.get("state_fips") or "",
        "block_fips": first.get("block_fips") or "",
    }


# ----------------------------------------------------------------------------
# Public API
# ----------------------------------------------------------------------------

async def search_address(
    query: str, *, with_geographies: bool = True, proximity: tuple[float, float] | None = None,
) -> SearchResult:
    """
    Address search.

    Provider chain:
      - with_geographies=False (autocomplete): MapTiler if configured (fast,
        handles partial addresses), else Census /onelineaddress (validation
        only — needs near-complete address).
      - with_geographies=True (final validation): Census /geographies (returns
        county + FIPS authoritatively). If Census misses, falls back to
        MapTiler results (county can be enriched later via FCC reverse lookup).
    """
    query = (query or "").strip()
    if len(query) < 3:
        return SearchResult(matches=[], error="Type at least 3 characters")

    async with httpx.AsyncClient() as client:
        if with_geographies:
            # Google's rooftop position first (see the note on _google_geocode);
            # its county name is kept and the FIPS codes come from the FCC.
            matches = await _google_geocode(client, query)
            if matches:
                matches[0] = await _enrich_with(client, matches[0])
            if not matches:
                matches = await _census_geographies(client, query)
            # If Census didn't match (common for partial / rural addresses),
            # fall back to MapTiler so we still return something useful.
            if not matches:
                matches = await _maptiler_autocomplete(client, query)
        else:
            # Autocomplete: Google Places suggestions (they handle partial
            # typing and know new streets), then MapTiler, then Census.
            matches = await _google_autocomplete(client, query, proximity=proximity)
            if not matches:
                matches = await _maptiler_autocomplete(client, query, proximity=proximity)
            if not matches:
                matches = await _census_oneline(client, query)

    if not matches:
        return SearchResult(matches=[], error="No matches found — try adding city or state")
    return SearchResult(matches=matches)


async def _enrich_with(client: httpx.AsyncClient, match: LocationMatch) -> LocationMatch:
    """County FIPS for a Google match, from the FCC (Google gives the name only)."""
    if match.county_fips:
        return match
    try:
        info = await _fcc_county_from_latlng(client, match.lat, match.lng)
    except Exception as e:
        logger.info("fcc county lookup failed: %s", e)
        info = None
    if info:
        match.county = match.county or info.get("county") or ""
        match.county_fips = info.get("county_fips") or ""
        match.state_fips = info.get("state_fips") or ""
    return match


async def enrich_with_county(match: LocationMatch) -> LocationMatch:
    """
    If the match came from /locations and has no county, fill it in via FCC.
    Idempotent — returns the match unchanged if county is already set.
    """
    if match.county and match.county_fips:
        return match
    async with httpx.AsyncClient() as client:
        info = await _fcc_county_from_latlng(client, match.lat, match.lng)
    if not info:
        return match
    match.county = info["county"] or match.county
    match.county_fips = info["county_fips"] or match.county_fips
    match.state_fips = info["state_fips"] or match.state_fips
    match.source = "census+fcc" if match.source == "census" else "fcc"
    return match


async def validate_address(address: str) -> LocationMatch | None:
    """
    Single best match for an address, including county. Returns None on
    no-match or service failure. The caller should treat None as
    "address could not be validated — ask the user to refine".
    """
    result = await search_address(address, with_geographies=True)
    if not result.matches:
        return None
    return result.matches[0]


async def reverse_county(lat: float, lng: float) -> dict | None:
    """
    Reverse lookup: given a lat/lng, return county/state info via FCC.
    Useful when the contractor has dropped a pin instead of typing.
    """
    async with httpx.AsyncClient() as client:
        return await _fcc_county_from_latlng(client, lat, lng)
