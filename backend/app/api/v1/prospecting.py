"""Find Roofs — prospecting from public parcel data (free tier).

Pulls REAL residential parcels (address, location, owner, and — where the county
publishes it — year built) from public ArcGIS REST services and builds a
canvassing list a contractor can work.

Data reality (verified live):
  - Brunswick County: address + owner + geometry, but year-built is empty.
  - Onslow County: address + owner + geometry AND a populated YEARBUILT — so we
    get REAL roof age for free there (real "why" + real confidence).

Owner-occupancy is derived (owner mailing vs property address). The score is
transparent and honest: it only claims what the data supports, and it accepts an
optional `condition` input so satellite roof-condition AI (or a paid data
provider) can raise confidence later with zero UI rebuild.
"""
from __future__ import annotations

import logging
import re
from datetime import date
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import require_user

logger = logging.getLogger(__name__)
router = APIRouter()

_THIS_YEAR = date.today().year
_YEAR_FLOOR = 1902  # counties use ~1901 as an "unknown/very old" sentinel

# ---------------------------------------------------------------------------
# County sources. `f` maps our keys -> the layer's field names. A source may use
# either a single `full_address` field or `house`/`street`/`suffix` components,
# and may or may not expose `year_built`. Add a county by verifying its endpoint.
# ---------------------------------------------------------------------------
PARCEL_SOURCES: dict[str, dict] = {
    "onslow": {
        "name": "Onslow County, NC (Jacksonville)",
        "url": "https://maps.onslowcountync.gov/arcgis/rest/services/WEB_PUBLICATIONS/Tax_Data/MapServer/0/query",
        "residential_where": "YEARBUILT>1901 AND FINALFULLBUILDINGVALUE>0",
        "city_field": "PHYSICALCITY",
        "f": {"full_address": "PHYSICALADDRESS", "city": "PHYSICALCITY", "zip": "PHYSICALZIP",
              "owner": "OWNER1", "owner_mail": "ADDRLINE1", "pin": "OBJECTID", "year_built": "YEARBUILT"},
    },
    "brunswick": {
        "name": "Brunswick County, NC (Leland, Southport)",
        "url": "https://bcgis.brunswickcountync.gov/arcgis/rest/services/Layers/TaxParcels/MapServer/0/query",
        "residential_where": "UseCode='0100'",
        "city_field": "City",
        "f": {"house": "HouseNumber", "street": "StreetName", "suffix": "StreetType",
              "city": "City", "zip": "ZipCode", "owner": "Name1", "owner_mail": "Address1", "pin": "PIN"},
    },
}


def _norm(s: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().upper())


def _centroid(geometry: Optional[dict]) -> tuple[Optional[float], Optional[float]]:
    try:
        ring = (geometry or {}).get("rings", [])[0]
        xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
        return round(sum(ys) / len(ys), 6), round(sum(xs) / len(xs), 6)  # lat, lng
    except Exception:
        return None, None


def _owner_occupied(prop_addr: str, owner_mail: str) -> Optional[bool]:
    """True if the owner's mailing address looks like the property (owner-occupied),
    False if it clearly differs (absentee), None if we can't tell."""
    mail = _norm(owner_mail)
    if not mail:
        return None
    m = re.match(r"^0*(\d+)\s+([A-Z0-9]+)", _norm(prop_addr))  # house number + first street word
    if not m:
        return None
    house, word = m.group(1), m.group(2)
    return (house in mail) and (word in mail)


def _clean_year(v) -> Optional[int]:
    try:
        y = int(float(v))
        return y if _YEAR_FLOOR <= y <= _THIS_YEAR else None
    except Exception:
        return None


def _score(*, owner_occupied: Optional[bool], year_built: Optional[int] = None,
           condition: Optional[int] = None) -> dict:
    """Transparent opportunity score + a plain-English 'why'. Only claims what the
    data supports; confidence reflects how much REAL signal we had."""
    reasons: list[str] = []
    score = 40
    age = (_THIS_YEAR - year_built) if year_built else None

    if year_built and age is not None:
        if age >= 30:
            score += 30; reasons.append(f"built {year_built} (~{age} yrs) — at or past typical roof life")
        elif age >= 18:
            score += 22; reasons.append(f"built {year_built} (~{age} yrs) — entering the replacement window")
        elif age >= 12:
            score += 8; reasons.append(f"built {year_built} (~{age} yrs) — watch, not yet due")
        else:
            score -= 15; reasons.append(f"built {year_built} — likely a newer roof")

    if owner_occupied is True:
        score += 15; reasons.append("owner-occupied (classic retail buyer)")
    elif owner_occupied is False:
        score += 3; reasons.append("absentee/rental owner (investor pitch)")

    if condition is not None:
        score += int(condition * 0.3)
        if condition >= 60:
            reasons.append("roof looks worn in imagery")

    score = max(0, min(100, score))
    tier = "Hot" if score >= 68 else "Warm" if score >= 50 else "Cool"
    confidence = "high" if (year_built and condition is not None) else \
                 "medium" if (year_built or condition is not None) else "low"

    # Human "why" line.
    if age is not None and age >= 18:
        why = (f"Built in {year_built} — a ~{age}-year-old asphalt roof is typically near or past "
               f"replacement age" + (", and it's owner-occupied, so a strong retail prospect." if owner_occupied else ". Confirm wear on the roof view."))
    elif age is not None:
        why = f"Built in {year_built} — likely a newer roof, so lower priority unless the roof view shows damage."
    elif owner_occupied is True:
        why = "Owner-occupied home. Roof age isn't in this county's public data — check the satellite view for streaking, patches, or tarps."
    else:
        why = "Residential home. Roof age/condition aren't in public data here — judge it from the roof view."

    return {"score": score, "tier": tier, "reasons": reasons, "confidence": confidence, "why": why}


@router.get("/sources")
async def list_sources(user: dict = Depends(require_user)) -> dict:
    return {"sources": [{"key": k, "name": v["name"], "has_age": "year_built" in v["f"]}
                        for k, v in PARCEL_SOURCES.items()]}


@router.get("/find-roofs")
async def find_roofs(
    county: str = Query(...),
    city: Optional[str] = Query(None),
    owner_occupied_only: bool = Query(False),
    limit: int = Query(60, ge=1, le=200),
    user: dict = Depends(require_user),
) -> dict:
    src = PARCEL_SOURCES.get(county)
    if not src:
        raise HTTPException(status_code=404, detail=f"No free data source wired for '{county}' yet.")
    f = src["f"]
    where = src["residential_where"]
    if city:
        where += f" AND UPPER({src['city_field']}) LIKE '%{_norm(city)}%'"

    out_fields = ",".join(sorted(set(f.values())))
    # Oldest homes first — those are the roofs most likely due for replacement.
    order = f"{f['year_built']} ASC" if "year_built" in f else ""
    params = {
        "where": where, "outFields": out_fields, "returnGeometry": "true", "outSR": "4326",
        "resultRecordCount": str(min(limit * 2, 200)), "f": "json",
    }
    if order:
        params["orderByFields"] = order
    try:
        async with httpx.AsyncClient(timeout=25) as client:
            data = (await client.get(src["url"], params=params)).json()
    except Exception as e:
        logger.warning("prospecting query failed for %s: %s", county, e)
        raise HTTPException(status_code=502, detail="Couldn't reach the county data service — try again.")
    if "error" in data:
        raise HTTPException(status_code=502, detail="The county data service rejected the query.")

    out: list[dict] = []
    for feat in data.get("features", []):
        a = feat.get("attributes", {})
        lat, lng = _centroid(feat.get("geometry"))
        if lat is None:
            continue
        if "full_address" in f:
            prop_addr = re.sub(r"\s+", " ", str(a.get(f["full_address"], "") or "")).strip()
        else:
            prop_addr = re.sub(r"^0+", "", " ".join(str(a.get(f[k], "") or "").strip()
                               for k in ("house", "street", "suffix") if k in f)).strip()
        occ = _owner_occupied(prop_addr, a.get(f["owner_mail"], ""))
        if owner_occupied_only and occ is not True:
            continue
        year = _clean_year(a.get(f["year_built"])) if "year_built" in f else None
        addr = f"{prop_addr}, {a.get(f['city'], '')} {str(a.get(f['zip'], '') or '')[:5]}".strip().strip(",")
        sc = _score(owner_occupied=occ, year_built=year)
        out.append({
            "pin": str(a.get(f["pin"])), "address": addr, "city": a.get(f["city"]),
            "owner": a.get(f["owner"]), "owner_occupied": occ, "year_built": year,
            "lat": lat, "lng": lng, **sc,
        })

    out.sort(key=lambda r: r["score"], reverse=True)
    has_age = "year_built" in f
    return {
        "county": src["name"], "count": len(out[:limit]), "prospects": out[:limit],
        "note": ("Real homes with roof age from public records — scores use age + owner-occupancy. "
                 "Check each roof thumbnail to confirm condition.") if has_age else
                ("Free tier: real homes + owner-occupancy, but this county doesn't publish roof age — "
                 "lean on the roof thumbnails. Counties like Onslow do publish age, so those score higher-confidence."),
    }
