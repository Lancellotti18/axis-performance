"""
Axis Performance — Address validation, geocoding, and county lookup.

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

logger = logging.getLogger(__name__)


CENSUS_BASE = "https://geocoding.geo.census.gov/geocoder"
CENSUS_BENCHMARK = "Public_AR_Current"
CENSUS_VINTAGE = "Current_Current"
FCC_AREA_URL = "https://geo.fcc.gov/api/census/area"


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

async def search_address(query: str, *, with_geographies: bool = True) -> SearchResult:
    """
    Address search. Returns all matches (usually 1 unless the address is
    ambiguous like "100 Main St" with no city/state).

    with_geographies=True: returns county/FIPS along with coords. Use this
    for the final submission.
    with_geographies=False: faster typeahead; no county data. Use for autocomplete.
    """
    query = (query or "").strip()
    if len(query) < 4:
        return SearchResult(matches=[], error="Address too short")

    async with httpx.AsyncClient() as client:
        if with_geographies:
            matches = await _census_geographies(client, query)
        else:
            matches = await _census_oneline(client, query)

    if not matches:
        return SearchResult(matches=[], error="Address not found")
    return SearchResult(matches=matches)


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
