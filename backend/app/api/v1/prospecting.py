"""Find Roofs — prospecting from public property + census data (free tier).

Two complementary free layers:

1. Parcel/address layer (per-home) — public county ArcGIS services. Depth varies:
     - Onslow: address + owner + YEARBUILT + SALEDATE/SALEPRICE  (richest)
     - Brunswick: address + owner, no age
     - New Hanover (Wilmington): address points only — no free owner/age (parcel
       service is token-locked), so it's a canvassing list.
2. Neighborhood heat layer (Census ACS DP04) — works NATIONWIDE at census-tract
   level (median age mix, % owner-occupied, median value). Fixes coverage where
   per-home parcel data is thin (e.g. New Hanover). Needs a free CENSUS_API_KEY.

The score is transparent and honest: it only claims what the data supports, and
accepts optional inputs (condition, sale recency) so paid data or satellite
roof-condition AI can raise confidence later with zero UI rebuild.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from datetime import date, datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import require_user

logger = logging.getLogger(__name__)
router = APIRouter()

_THIS_YEAR = date.today().year
_YEAR_FLOOR = 1902  # counties use ~1901 as an "unknown/very old" sentinel

# ---------------------------------------------------------------------------
# Per-home parcel sources. `f` maps our keys -> the layer's field names. A source
# may use a `full_address` field OR `house`/`street`/`suffix` components; may set
# `geom` = "point" (address points) or default polygon; and may expose optional
# `year_built` / `sale_date` / `sale_price`. Add a county by verifying its endpoint.
# ---------------------------------------------------------------------------
PARCEL_SOURCES: dict[str, dict] = {
    "onslow": {
        "name": "Onslow County, NC (Jacksonville)",
        "url": "https://maps.onslowcountync.gov/arcgis/rest/services/WEB_PUBLICATIONS/Tax_Data/MapServer/0/query",
        "residential_where": "YEARBUILT>1901 AND FINALFULLBUILDINGVALUE>0",
        "city_field": "PHYSICALCITY",
        "f": {"full_address": "PHYSICALADDRESS", "city": "PHYSICALCITY", "zip": "PHYSICALZIP",
              "owner": "OWNER1", "owner_mail": "ADDRLINE1", "pin": "OBJECTID",
              "year_built": "YEARBUILT", "sale_date": "SALEDATE", "sale_price": "SALEPRICE",
              "tax_value": "TAXMARKETVALUE"},
    },
    "brunswick": {
        "name": "Brunswick County, NC (Leland, Southport)",
        "url": "https://bcgis.brunswickcountync.gov/arcgis/rest/services/Layers/TaxParcels/MapServer/0/query",
        "residential_where": "UseCode='0100'",
        "city_field": "City",
        "f": {"house": "HouseNumber", "street": "StreetName", "suffix": "StreetType",
              "city": "City", "zip": "ZipCode", "owner": "Name1", "owner_mail": "Address1", "pin": "PIN"},
    },
    "new_hanover": {
        "name": "New Hanover County, NC (Wilmington) — address list",
        "url": "https://services1.arcgis.com/KHqZAAIdlp1670Ft/arcgis/rest/services/Address_with_ISO_Rating/FeatureServer/0/query",
        "residential_where": "1=1",
        "city_field": "POSTALCITY",
        "geom": "point",
        "f": {"house": "NUMBER", "street": "STREET", "city": "POSTALCITY",
              "zip": "ZIPCODE", "pin": "OBJECTID"},
    },
    "pender": {
        "name": "Pender County, NC (Hampstead, Topsail)",
        "url": "https://services3.arcgis.com/eWu49l4aPlhvQwvs/arcgis/rest/services/Parcels/FeatureServer/0/query",
        "residential_where": "HEAT_SQ_FT>0 AND ADDR NOT LIKE 'P O BOX%'",
        "city_field": "ADDR",
        "f": {"full_address": "ADDR", "owner": "NAME", "pin": "OBJECTID", "sale_price": "SALE_PRICE"},
    },
}

# NC region county FIPS for the Census heat layer (state 37 = North Carolina).
COUNTY_FIPS: dict[str, tuple[str, str, str]] = {
    "new_hanover": ("37", "129", "New Hanover County, NC (Wilmington)"),
    "brunswick": ("37", "019", "Brunswick County, NC"),
    "pender": ("37", "141", "Pender County, NC (Hampstead, Topsail)"),
    "onslow": ("37", "133", "Onslow County, NC (Jacksonville)"),
    "columbus": ("37", "047", "Columbus County, NC"),
    "bladen": ("37", "017", "Bladen County, NC"),
    "duplin": ("37", "061", "Duplin County, NC"),
    "carteret": ("37", "031", "Carteret County, NC"),
}


def _norm(s: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().upper())


def _num(v) -> Optional[float]:
    try:
        n = float(v)
        return n if n > 0 else None
    except Exception:
        return None


def _latlng(geometry: Optional[dict], kind: str) -> tuple[Optional[float], Optional[float]]:
    """Point sources give x/y directly; polygon sources get a ring centroid."""
    try:
        if kind == "point":
            return round(geometry["y"], 6), round(geometry["x"], 6)
        ring = (geometry or {}).get("rings", [])[0]
        xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
        return round(sum(ys) / len(ys), 6), round(sum(xs) / len(xs), 6)
    except Exception:
        return None, None


def _owner_occupied(prop_addr: str, owner_mail: str) -> Optional[bool]:
    mail = _norm(owner_mail)
    if not mail:
        return None
    m = re.match(r"^0*(\d+)\s+([A-Z0-9]+)", _norm(prop_addr))
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


_MONTHS = {m: i + 1 for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"])}


def _sale_recency(v) -> Optional[tuple[int, int]]:
    """Sale date -> (months_since_sale, sale_year). Handles 'DD-MON-YY' strings
    (Onslow) and epoch-ms ArcGIS dates. None if unknown/implausible."""
    try:
        if v in (None, 0, ""):
            return None
        s = str(v).strip().upper()
        m = re.match(r"^(\d{1,2})-([A-Z]{3})-(\d{2,4})$", s)
        if m:
            mon = _MONTHS.get(m.group(2))
            yy = int(m.group(3))
            if not mon:
                return None
            year = yy if yy > 100 else (2000 + yy if yy <= 40 else 1900 + yy)
        else:
            dt = datetime.fromtimestamp(int(v) / 1000.0, tz=timezone.utc)
            year, mon = dt.year, dt.month
        if year < 1950 or year > _THIS_YEAR:
            return None
        months = (_THIS_YEAR - year) * 12 + (date.today().month - mon)
        return max(0, months), year
    except Exception:
        return None


def _score(*, owner_occupied: Optional[bool], year_built: Optional[int] = None,
           condition: Optional[int] = None, sold_months: Optional[int] = None,
           sold_year: Optional[int] = None, sold_price: Optional[float] = None,
           tax_value: Optional[float] = None) -> dict:
    """Transparent opportunity score + plain-English 'why'. Only claims what the
    data supports; confidence reflects how much REAL signal we had."""
    reasons: list[str] = []
    score = 40
    age = (_THIS_YEAR - year_built) if year_built else None

    if year_built and age is not None:
        if age >= 30:
            score += 30; reasons.append(f"Built {year_built} (~{age} yrs old) — at or past typical asphalt-roof life")
        elif age >= 18:
            score += 22; reasons.append(f"Built {year_built} (~{age} yrs old) — entering the roof-replacement window")
        elif age >= 12:
            score += 8; reasons.append(f"Built {year_built} (~{age} yrs old) — worth watching, not yet due")
        else:
            score -= 15; reasons.append(f"Built {year_built} — likely a newer roof")
    elif year_built is None:
        reasons.append("Roof age not in this county's public records — judge from the roof view")

    if owner_occupied is True:
        score += 15; reasons.append("Owner-occupied — the classic retail (homeowner) buyer")
    elif owner_occupied is False:
        score += 3; reasons.append("Absentee / rental owner — better as an investor pitch")

    if sold_months is not None and sold_months <= 24:
        price = f" for ${int(sold_price):,}" if sold_price else ""
        score += 10; reasons.append(f"Sold {sold_year}{price} — new owner, prime re-roof timing")
    elif sold_year:
        reasons.append(f"Last sold {sold_year}")

    if tax_value:
        reasons.append(f"Tax market value ${int(tax_value):,}")

    if condition is not None:
        score += int(condition * 0.3)
        if condition >= 60:
            reasons.append("roof looks worn in imagery")

    score = max(0, min(100, score))
    tier = "Hot" if score >= 68 else "Warm" if score >= 50 else "Cool"
    confidence = "high" if (year_built and condition is not None) else \
                 "medium" if (year_built or condition is not None) else "low"

    if age is not None and age >= 18:
        why = (f"Built in {year_built} — a ~{age}-year-old asphalt roof is typically near or past "
               f"replacement age" + (", and it's owner-occupied, so a strong retail prospect." if owner_occupied else ". Confirm wear on the roof view."))
        if sold_months is not None and sold_months <= 24:
            why += f" Recently sold ({sold_year}) — new owners often re-roof."
    elif age is not None:
        why = f"Built in {year_built} — likely a newer roof, so lower priority unless the roof view shows damage."
    elif owner_occupied is True:
        why = "Owner-occupied home. Roof age isn't in this county's public data — check the satellite view for streaking, patches, or tarps."
    else:
        why = "Residential address. Roof age/owner aren't in this county's free data — judge condition from the roof view."

    return {"score": score, "tier": tier, "reasons": reasons, "confidence": confidence, "why": why}


@router.get("/sources")
async def list_sources(user: dict = Depends(require_user)) -> dict:
    return {"sources": [{"key": k, "name": v["name"], "has_age": "year_built" in v["f"],
                         "has_owner": "owner" in v["f"]}
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
    kind = src.get("geom", "polygon")
    where = src["residential_where"]
    if city:
        where += f" AND UPPER({src['city_field']}) LIKE '%{_norm(city)}%'"

    out_fields = ",".join(sorted(set(f.values())))
    params = {
        "where": where, "outFields": out_fields, "returnGeometry": "true", "outSR": "4326",
        "resultRecordCount": str(min(limit * 3, 200)), "f": "json",
    }
    if "year_built" in f:  # oldest first — roofs most likely due surface at the top
        params["orderByFields"] = f"{f['year_built']} ASC"
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
        lat, lng = _latlng(feat.get("geometry"), kind)
        if lat is None:
            continue
        if "full_address" in f:
            prop_addr = re.sub(r"\s+", " ", str(a.get(f["full_address"], "") or "")).strip()
        else:
            prop_addr = re.sub(r"^0+", "", " ".join(str(a.get(f[k], "") or "").strip()
                               for k in ("house", "street", "suffix") if k in f)).strip()
        if not prop_addr:
            continue
        owner = a.get(f["owner"]) if "owner" in f else None
        occ = _owner_occupied(prop_addr, a.get(f["owner_mail"], "")) if "owner_mail" in f else None
        if owner_occupied_only and occ is not True:
            continue
        year = _clean_year(a.get(f["year_built"])) if "year_built" in f else None
        sale = _sale_recency(a.get(f["sale_date"])) if "sale_date" in f else None
        sale_price = _num(a.get(f["sale_price"])) if "sale_price" in f else None
        tax_value = _num(a.get(f["tax_value"])) if "tax_value" in f else None
        owner_mail = a.get(f["owner_mail"]) if "owner_mail" in f else None
        city_val = str(a.get(f["city"], "") or "").strip() if "city" in f else ""
        zip_val = str(a.get(f["zip"], "") or "")[:5] if "zip" in f else ""
        addr = re.sub(r"\s+", " ", f"{prop_addr}, {city_val} {zip_val}").strip().strip(",").strip()
        sc = _score(owner_occupied=occ, year_built=year,
                    sold_months=sale[0] if sale else None, sold_year=sale[1] if sale else None,
                    sold_price=sale_price, tax_value=tax_value)
        out.append({
            "pin": str(a.get(f["pin"])), "address": addr, "city": a.get(f["city"]),
            "owner": owner, "owner_mail": (owner_mail or None), "owner_occupied": occ,
            "year_built": year, "sold_year": sale[1] if sale else None,
            "tax_value": int(tax_value) if tax_value else None,
            "lat": lat, "lng": lng, **sc,
        })

    out.sort(key=lambda r: r["score"], reverse=True)
    has_age = "year_built" in f
    has_owner = "owner" in f
    if has_age:
        note = ("Real homes with roof age from public records — scored by age, owner-occupancy, and "
                "recent sales. Check each roof thumbnail to confirm condition.")
    elif has_owner:
        note = ("Free tier: real homes + owner-occupancy, but this county doesn't publish roof age — "
                "lean on the roof thumbnails and the neighborhood heat layer for age targeting.")
    else:
        note = ("Address list only — this county locks owner/age behind a paid service. Use it as a "
                "canvassing list, and use the neighborhood heat (Census) layer to target older areas.")
    return {"county": src["name"], "count": len(out[:limit]), "prospects": out[:limit], "note": note}


@router.get("/census-heat")
async def census_heat(
    county: str = Query(..., description="County key from COUNTY_FIPS, or 'STATE:COUNTY' FIPS pair"),
    limit: int = Query(40, ge=1, le=100),
    user: dict = Depends(require_user),
) -> dict:
    """Rank a county's census tracts by roof-opportunity (older homes + owner-occupied).
    Works nationwide; needs a free CENSUS_API_KEY. This is neighborhood-level targeting,
    not per-home leads — pair it with the parcel layer for addresses."""
    key = os.getenv("CENSUS_API_KEY")
    if not key:
        return {"available": False, "county": county, "tracts": [],
                "note": ("Neighborhood heat needs a free Census API key (instant, no cost) at "
                         "api.census.gov/data/key_signup.html — set it as CENSUS_API_KEY on the backend.")}

    if county in COUNTY_FIPS:
        state_fips, county_fips, cname = COUNTY_FIPS[county]
    elif ":" in county:
        state_fips, county_fips = county.split(":", 1)
        cname = f"FIPS {state_fips}:{county_fips}"
    else:
        raise HTTPException(status_code=404, detail=f"Unknown county '{county}' for census heat.")

    # DP04: year-built buckets, occupied tenure, median value.
    vars_ = ["NAME", "DP04_0001E", "DP04_0016E", "DP04_0022E", "DP04_0023E", "DP04_0024E",
             "DP04_0025E", "DP04_0026E", "DP04_0045E", "DP04_0046E", "DP04_0089E"]
    params = {"get": ",".join(vars_), "for": "tract:*",
              "in": f"state:{state_fips} county:{county_fips}", "key": key}
    try:
        async with httpx.AsyncClient(timeout=25) as client:
            r = await client.get("https://api.census.gov/data/2022/acs/acs5/profile", params=params)
            rows = r.json()
    except Exception as e:
        logger.warning("census query failed for %s: %s", county, e)
        raise HTTPException(status_code=502, detail="Couldn't reach the Census API — try again.")
    if not isinstance(rows, list) or len(rows) < 2:
        raise HTTPException(status_code=502, detail="Census API returned no tract data for this county.")

    # Tract centroids from TIGERweb so each neighborhood gets a real map location
    # (a bare "Tract 106" is meaningless to a contractor). Best-effort — if it
    # fails, tracts still return, just without a map pin.
    centroids: dict[str, tuple[float, float]] = {}
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            tr = await client.get(
                "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0/query",
                params={"where": f"STATE='{state_fips}' AND COUNTY='{county_fips}'",
                        "outFields": "GEOID,CENTLAT,CENTLON", "returnGeometry": "false", "f": "json"})
            for ft in tr.json().get("features", []):
                at = ft.get("attributes", {})
                try:
                    centroids[at["GEOID"]] = (float(at["CENTLAT"]), float(at["CENTLON"]))
                except Exception:
                    continue
    except Exception:
        logger.debug("TIGERweb tract centroids unavailable", exc_info=True)

    hdr = {name: i for i, name in enumerate(rows[0])}

    def num(row, code):
        try:
            v = float(row[hdr[code]])
            return v if v > -1e6 else None  # Census uses large negatives as null flags
        except Exception:
            return None

    tracts = []
    for row in rows[1:]:
        yb_total = num(row, "DP04_0016E") or 0
        pre80 = sum(num(row, c) or 0 for c in ("DP04_0022E", "DP04_0023E", "DP04_0024E", "DP04_0025E", "DP04_0026E"))
        occ = num(row, "DP04_0045E") or 0
        owner = num(row, "DP04_0046E") or 0
        units = num(row, "DP04_0001E") or 0
        value = num(row, "DP04_0089E")
        if yb_total < 50 or units < 50:  # skip tiny/non-residential tracts
            continue
        pct_pre80 = round(100 * pre80 / yb_total) if yb_total else 0
        pct_owner = round(100 * owner / occ) if occ else 0
        # Opportunity: older stock + owner-occupied ownership both raise it.
        score = min(100, round(pct_pre80 * 0.7 + pct_owner * 0.4))
        tier = "Hot" if score >= 65 else "Warm" if score >= 45 else "Cool"
        name = (row[hdr["NAME"]] or "").split(",")[0].replace("Census Tract", "Neighborhood").strip()
        geoid = f"{row[hdr['state']]}{row[hdr['county']]}{row[hdr['tract']]}"
        cen = centroids.get(geoid)
        why = f"{pct_pre80}% of homes built before 1980, {pct_owner}% owner-occupied"
        if value:
            why += f", median value ${int(value):,}"
        tracts.append({"tract": name, "place": None, "pct_pre_1980": pct_pre80,
                       "pct_owner_occupied": pct_owner,
                       "median_value": int(value) if value else None, "units": int(units),
                       "lat": cen[0] if cen else None, "lng": cen[1] if cen else None,
                       "score": score, "tier": tier, "why": why + "."})

    tracts.sort(key=lambda t: t["score"], reverse=True)
    top = tracts[:limit]

    # Reverse-geocode each neighborhood's centroid to a recognizable community
    # name (a CDP like 'Ogden' / 'Myrtle Grove', else the city or township) so a
    # contractor knows the AREA, not just a tract number. Best-effort + concurrent.
    def _clean_place(name: str) -> str:
        return re.sub(r"\s+(city|town|township|village|CDP)$", "", name or "", flags=re.I).strip()

    sem = asyncio.Semaphore(10)
    async with httpx.AsyncClient(timeout=6) as c:
        async def _name(t):
            if t.get("lat") is None:
                return
            async with sem:
                try:
                    r = await c.get(
                        "https://geocoding.geo.census.gov/geocoder/geographies/coordinates",
                        params={"x": t["lng"], "y": t["lat"], "benchmark": "Public_AR_Current",
                                "vintage": "Current_Current", "format": "json"})
                    g = r.json().get("result", {}).get("geographies", {})
                except Exception:
                    return
            for layer in ("Census Designated Places", "Incorporated Places", "County Subdivisions"):
                arr = g.get(layer) or []
                if arr and arr[0].get("NAME"):
                    t["place"] = _clean_place(arr[0]["NAME"])
                    return
        try:
            await asyncio.gather(*[_name(t) for t in top])
        except Exception:
            logger.debug("tract place-naming failed", exc_info=True)

    return {"available": True, "county": cname, "count": len(top), "tracts": top,
            "note": ("Neighborhoods ranked by roof opportunity (older homes + owner-occupied), from free "
                     "Census data. This is where to farm — the community name + map link show exactly where.")}
