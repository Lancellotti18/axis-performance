"""Is the house the contractor tapped the house on the job?

Before a roof is measured automatically, the tapped point is reverse-geocoded
and its address compared with the project's. A mismatch — "you tapped 1418 Oak
St, this job is 1422 Oak St" — is shown BEFORE anything is measured, because a
report about the neighbour's roof is the worst thing Axis can produce and Axis
has already had three wrong-building bugs.

It warns rather than blocks. Geocoders are wrong about individual houses often
enough (new builds, corner lots addressed on the other street) that the
contractor standing in the driveway must be able to say "yes, this one".

Three outcomes, deliberately:
  match     — same house number, same street
  mismatch  — a different house number, or the same number on another street
  unknown   — no house number came back; say nothing rather than guess

The comparison is the part that can fail silently, so it is pure and tested
hard: "1422 N. Oak Street" and "1422 OAK ST" are the same address; "1422 Oak
St" and "1418 Oak St" are not.

Note: in Axis a project's street address lives in projects.name —
projects.address is usually null.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_SUFFIX = {
    "street": "st", "st": "st", "avenue": "ave", "ave": "ave", "av": "ave",
    "road": "rd", "rd": "rd", "drive": "dr", "dr": "dr", "lane": "ln", "ln": "ln",
    "court": "ct", "ct": "ct", "circle": "cir", "cir": "cir", "boulevard": "blvd",
    "blvd": "blvd", "place": "pl", "pl": "pl", "terrace": "ter", "ter": "ter",
    "parkway": "pkwy", "pkwy": "pkwy", "highway": "hwy", "hwy": "hwy",
    "trail": "trl", "trl": "trl", "way": "way", "square": "sq", "sq": "sq",
    "point": "pt", "pt": "pt", "loop": "loop", "run": "run", "pike": "pike",
    "crossing": "xing", "xing": "xing", "cove": "cv", "cv": "cv",
}
_DIRECTION = {
    "north": "n", "n": "n", "south": "s", "s": "s", "east": "e", "e": "e",
    "west": "w", "w": "w", "northeast": "ne", "ne": "ne", "northwest": "nw",
    "nw": "nw", "southeast": "se", "se": "se", "southwest": "sw", "sw": "sw",
}
_UNIT = re.compile(r"\b(apt|apartment|unit|suite|ste|lot|#)\b.*$", re.I)
_NUMBER = re.compile(r"^\s*(\d+[a-z]?(?:-\d+)?)\s+(.+)$", re.I)


@dataclass(frozen=True)
class Parsed:
    number: Optional[str]
    street: tuple[str, ...]      # name words only: no suffix, no direction


@dataclass(frozen=True)
class AddressCheck:
    status: str                  # match | mismatch | unknown
    project: str
    found: Optional[str]
    message: Optional[str]       # the sentence shown to the contractor, if any
    source: Optional[str] = None


def parse(address: str) -> Parsed:
    """House number and the street's NAME words from the first line of an
    address. Suffixes and directions are dropped from the comparison because
    geocoders disagree about them ("Oak St" vs "N Oak Street") far more often
    than they get the street wrong."""
    first = (address or "").split(",")[0].strip()
    first = _UNIT.sub("", first).strip()
    m = _NUMBER.match(first)
    if not m:
        return Parsed(None, tuple(_words(first)))
    return Parsed(m.group(1).lower(), tuple(_words(m.group(2))))


def _words(s: str) -> list[str]:
    toks = re.sub(r"[^a-z0-9 ]+", " ", s.lower()).split()
    return [t for t in toks if t not in _SUFFIX and t not in _DIRECTION]


def compare(project_address: str, found_address: Optional[str], *,
            source: Optional[str] = None) -> AddressCheck:
    if not found_address:
        return AddressCheck("unknown", project_address, None, None, source)
    p, f = parse(project_address), parse(found_address)
    if not p.number or not f.number:
        return AddressCheck("unknown", project_address, found_address, None, source)
    # Exact name-word equality. Letting one name be a subset of the other made
    # "Oak St" match "Oak Hill Rd" — a different street entirely.
    same_street = bool(p.street) and p.street == f.street
    if p.number == f.number and same_street:
        return AddressCheck("match", project_address, found_address, None, source)
    first_line = found_address.split(",")[0].strip()
    if p.number != f.number and same_street:
        msg = (f"The house you tapped looks like {first_line}, but this job is "
               f"{project_address.split(',')[0].strip()} — a neighbouring house on the "
               "same street. Check you have the right roof before measuring.")
    else:
        msg = (f"The house you tapped looks like {first_line}, not "
               f"{project_address.split(',')[0].strip()}. Check you have the right roof "
               "before measuring. (Corner houses are sometimes listed on the other street.)")
    return AddressCheck("mismatch", project_address, found_address, msg, source)


# ── Where the tapped point's address comes from ───────────────────────────

GOOGLE_REVERSE = "https://maps.googleapis.com/maps/api/geocode/json"
MAPTILER_REVERSE = "https://api.maptiler.com/geocoding/{lng},{lat}.json"


def parse_google(payload: dict) -> Optional[str]:
    """First rooftop-grade result with a street number, as 'number route, city'."""
    if (payload or {}).get("status") != "OK":
        return None
    for res in payload.get("results") or []:
        comps = {t: c.get("long_name") for c in res.get("address_components") or []
                 for t in c.get("types") or []}
        if comps.get("street_number") and comps.get("route"):
            city = comps.get("locality") or comps.get("sublocality") or ""
            return f"{comps['street_number']} {comps['route']}" + (f", {city}" if city else "")
    return None


def parse_maptiler(payload: dict) -> Optional[str]:
    """MapTiler returns GeoJSON features; an address feature carries the house
    number in `address` and the street in `text`."""
    for feat in (payload or {}).get("features") or []:
        number = feat.get("address") or (feat.get("properties") or {}).get("housenumber")
        street = feat.get("text")
        if number and street:
            return f"{number} {street}"
    return None


async def reverse_lookup(lat: float, lng: float, *, google_key: str = "",
                         maptiler_key: str = "") -> tuple[Optional[str], Optional[str]]:
    """(address, source). Google first: it resolves to the rooftop, which is
    what distinguishes two houses 15 m apart. MapTiler as a fallback."""
    async with httpx.AsyncClient(timeout=8) as client:
        if google_key:
            try:
                r = await client.get(GOOGLE_REVERSE, params={
                    "latlng": f"{lat:.7f},{lng:.7f}",
                    "result_type": "street_address|premise",
                    "key": google_key})
                addr = parse_google(r.json())
                if addr:
                    return addr, "google"
                logger.info("google reverse geocode gave no house number: %s",
                            (r.json() or {}).get("status"))
            except Exception as e:
                logger.info("google reverse geocode failed: %s", e)
        if maptiler_key:
            try:
                r = await client.get(MAPTILER_REVERSE.format(lat=lat, lng=lng),
                                     params={"key": maptiler_key, "types": "address", "limit": 1})
                addr = parse_maptiler(r.json())
                if addr:
                    return addr, "maptiler"
            except Exception as e:
                logger.info("maptiler reverse geocode failed: %s", e)
    return None, None
