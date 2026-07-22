"""Find Roofs — prospecting from public parcel data (free tier).

Pulls REAL residential parcels (address, location, owner) from a county's public
ArcGIS REST service and builds a canvassing list a contractor can work.

Free tier gives what public data actually exposes: address, location, and
OWNER-OCCUPANCY (derived by comparing the owner's mailing address to the property
address). Roof AGE and CONDITION are NOT in free feeds — so the score is honest
about that and leaves condition to the contractor's eye (satellite thumbnail in
the UI). The scoring function accepts optional `year_built` and `condition`
inputs so a paid provider (e.g. BatchData ~$99/mo) can be flipped on later,
nationwide, and the exact same UI gets sharper with zero rebuild.
"""
from __future__ import annotations

import logging
import re
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import require_user

logger = logging.getLogger(__name__)
router = APIRouter()

# ---------------------------------------------------------------------------
# County data sources. Each entry is a public ArcGIS REST parcel layer + the
# field names to read. Add a county by verifying its endpoint + fields once.
# (Verified live: Brunswick TaxParcels exposes address, owner, use code, geometry
#  — but ActualYearBuilt is empty, which is why age is a paid-tier signal.)
# ---------------------------------------------------------------------------
PARCEL_SOURCES: dict[str, dict] = {
    "brunswick": {
        "name": "Brunswick County, NC",
        "url": "https://bcgis.brunswickcountync.gov/arcgis/rest/services/Layers/TaxParcels/MapServer/0/query",
        "residential_where": "UseCode='0100'",
        "city_field": "City",
        "f": {
            "house": "HouseNumber", "street": "StreetName", "suffix": "StreetType",
            "city": "City", "zip": "ZipCode", "owner": "Name1",
            "owner_mail": "Address1", "pin": "PIN",
        },
    },
}


def _norm(s: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().upper())


def _centroid(geometry: Optional[dict]) -> tuple[Optional[float], Optional[float]]:
    """Rough centroid (average of the first ring's vertices) — plenty for a map
    pin + a satellite thumbnail."""
    try:
        ring = (geometry or {}).get("rings", [])[0]
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return round(sum(ys) / len(ys), 6), round(sum(xs) / len(xs), 6)  # lat, lng
    except Exception:
        return None, None


def _owner_occupied(house: str, street: str, owner_mail: str) -> Optional[bool]:
    """True if the owner's mailing address looks like the property itself
    (owner-occupied), False if it clearly differs (absentee/rental), None if we
    can't tell."""
    mail = _norm(owner_mail)
    h = _norm(house).lstrip("0")
    st = _norm(street)
    if not mail or not h or not st:
        return None
    return (h in mail) and (st in mail)


def _score(*, owner_occupied: Optional[bool], year_built: Optional[int] = None,
           condition: Optional[int] = None, now_year: int = 2026) -> dict:
    """Transparent opportunity score. Free tier only has owner-occupancy, so the
    score is modest + honest; year_built / condition (paid or vision, later) make
    it real. Every point is explained."""
    reasons: list[str] = []
    score = 40  # baseline: a residential home is a candidate

    if owner_occupied is True:
        score += 20; reasons.append("Owner-occupied (classic retail buyer)")
    elif owner_occupied is False:
        score += 5; reasons.append("Absentee/rental owner (investor pitch)")

    # These only fire once a paid/vision source is connected.
    if year_built:
        age = max(0, now_year - int(year_built))
        if 18 <= age <= 35:
            score += 25; reasons.append(f"Roof-age window (built {year_built}, ~{age} yrs)")
        elif age > 35:
            score += 20; reasons.append(f"Likely past due (built {year_built})")
        elif age < 8:
            score -= 20; reasons.append(f"Newer home (built {year_built}) — likely fine")
    if condition is not None:
        score += int(condition * 0.3)
        if condition >= 60:
            reasons.append("Roof looks worn in imagery")

    score = max(0, min(100, score))
    tier = "Hot" if score >= 70 else "Warm" if score >= 50 else "Cool"
    # Confidence reflects how much REAL signal we had.
    confidence = "high" if (year_built and condition is not None) else \
                 "medium" if (year_built or condition is not None) else "low"
    return {"score": score, "tier": tier, "reasons": reasons, "confidence": confidence}


@router.get("/sources")
async def list_sources(user: dict = Depends(require_user)) -> dict:
    """Counties currently wired for the free tier."""
    return {"sources": [{"key": k, "name": v["name"]} for k, v in PARCEL_SOURCES.items()]}


@router.get("/find-roofs")
async def find_roofs(
    county: str = Query(...),
    city: Optional[str] = Query(None, description="Filter to a city/town within the county"),
    owner_occupied_only: bool = Query(False),
    limit: int = Query(60, ge=1, le=200),
    user: dict = Depends(require_user),
) -> dict:
    """Return a ranked canvassing list of real residential homes for an area."""
    src = PARCEL_SOURCES.get(county)
    if not src:
        raise HTTPException(status_code=404, detail=f"No free data source wired for '{county}' yet.")
    f = src["f"]
    where = src["residential_where"]
    if city:
        where += f" AND UPPER({src['city_field']}) LIKE '%{_norm(city)}%'"

    params = {
        "where": where,
        "outFields": ",".join([f["house"], f["street"], f["suffix"], f["city"], f["zip"], f["owner"], f["owner_mail"], f["pin"]]),
        "returnGeometry": "true",
        "outSR": "4326",
        "resultRecordCount": str(min(limit * 3, 300)),  # over-fetch; we filter/rank then trim
        "f": "json",
    }
    try:
        async with httpx.AsyncClient(timeout=25) as client:
            resp = await client.get(src["url"], params=params)
            data = resp.json()
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
        occ = _owner_occupied(a.get(f["house"], ""), a.get(f["street"], ""), a.get(f["owner_mail"], ""))
        if owner_occupied_only and occ is not True:
            continue
        street = " ".join(str(a.get(k, "") or "").strip() for k in (f["house"], f["street"], f["suffix"])).strip()
        # tidy the zero-padded house number
        street = re.sub(r"^0+", "", street)
        addr = f"{street}, {a.get(f['city'], '')} {str(a.get(f['zip'], '') or '')[:5]}".strip()
        sc = _score(owner_occupied=occ)
        out.append({
            "pin": a.get(f["pin"]),
            "address": addr,
            "city": a.get(f["city"]),
            "owner": a.get(f["owner"]),
            "owner_occupied": occ,
            "lat": lat, "lng": lng,
            **sc,
        })

    out.sort(key=lambda r: r["score"], reverse=True)
    return {
        "county": src["name"],
        "count": len(out[:limit]),
        "prospects": out[:limit],
        "note": "Free tier: real homes + owner-occupancy from public records. Roof age/condition aren't in free data — check each roof thumbnail to triage. A ~$99/mo data upgrade adds nationwide age + verified owner data.",
    }
