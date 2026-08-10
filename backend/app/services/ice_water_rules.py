"""DEFECT-07: Ice & water shield requirements are regional, not universal.

The IRC (R905.1.2) only requires an *ice barrier* "in areas where there has been a
history of ice forming along the eaves" — practically, the colder IECC climate
zones. Applying a full eave course everywhere over-orders material (and misstates
the code basis) in warm/coastal regions, and a single course under-documents it in
the cold North where the barrier must run from the eave to 24" inside the exterior
wall line.

This module is DETERMINISTIC: region -> climate zone -> policy -> linear/ square
feet. No vision or language model contributes to these numbers; every quantity
traces back through the policy to the confirmed roof geometry.

Coverage model (each "eave course" is a 36" membrane run up-slope from the eave):
  - 0 courses -> valleys & penetrations only (warm climates)
  - 1 course  -> one 3 ft course at eaves + valleys (mixed climates)
  - 2 courses -> ~eave-to-24"-past-wall barrier + valleys (cold climates)

Valleys, when covered, get 3 ft each side (6 ft total width) per code.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class IceWaterPolicy:
    eave_courses: int          # number of 36" membrane courses at the eave
    cover_valleys: bool        # 3 ft each side of valleys
    label: str                 # human-readable, shown in the report trace
    code_basis: str            # the "why" for the adjuster

    @property
    def eave_width_ft(self) -> float:
        return self.eave_courses * 3.0


# IECC climate zone -> policy. Zones 1-3 warm, 4 mixed, 5-8 cold.
_ZONE_POLICY: dict[int, IceWaterPolicy] = {
    1: IceWaterPolicy(0, True, "Warm climate (IECC 1): valleys & penetrations only",
                      "IRC R905.1.2 — no eave ice-barrier history; valley/penetration protection only"),
    2: IceWaterPolicy(0, True, "Warm climate (IECC 2): valleys & penetrations only",
                      "IRC R905.1.2 — no eave ice-barrier history; valley/penetration protection only"),
    3: IceWaterPolicy(0, True, "Warm climate (IECC 3): valleys & penetrations only",
                      "IRC R905.1.2 — no eave ice-barrier history; valley/penetration protection only"),
    4: IceWaterPolicy(1, True, "Mixed climate (IECC 4): one eave course + valleys",
                      "IRC R905.1.2 — mixed zone; single eave course plus valley protection"),
    5: IceWaterPolicy(2, True, "Cold climate (IECC 5): eave barrier to 24\" past wall + valleys",
                      "IRC R905.1.2 — ice-barrier from eave to 24\" inside the exterior wall line"),
    6: IceWaterPolicy(2, True, "Cold climate (IECC 6): eave barrier to 24\" past wall + valleys",
                      "IRC R905.1.2 — ice-barrier from eave to 24\" inside the exterior wall line"),
    7: IceWaterPolicy(2, True, "Cold climate (IECC 7): eave barrier to 24\" past wall + valleys",
                      "IRC R905.1.2 — ice-barrier from eave to 24\" inside the exterior wall line"),
    8: IceWaterPolicy(2, True, "Cold climate (IECC 8): eave barrier to 24\" past wall + valleys",
                      "IRC R905.1.2 — ice-barrier from eave to 24\" inside the exterior wall line"),
}

# When region is unknown, be conservative toward code: assume mixed (one course).
_DEFAULT_ZONE = 4

# State -> dominant IECC climate zone (2-letter, upper). Coarse but defensible;
# split states get county-level overrides below.
_STATE_ZONE: dict[str, int] = {
    "FL": 2, "HI": 1, "TX": 2, "LA": 2, "MS": 3, "AL": 3, "GA": 3, "SC": 3,
    "NC": 3, "AZ": 2, "NM": 4, "OK": 3, "AR": 3, "TN": 4, "VA": 4, "CA": 3,
    "NV": 4, "UT": 5, "CO": 5, "KS": 4, "MO": 4, "KY": 4, "WV": 5, "MD": 4,
    "DE": 4, "NJ": 4, "PA": 5, "OH": 5, "IN": 5, "IL": 5, "DC": 4,
    "OR": 4, "WA": 4, "ID": 5, "WY": 6, "MT": 6, "ND": 7, "SD": 6, "NE": 5,
    "IA": 5, "MN": 6, "WI": 6, "MI": 6, "NY": 5, "CT": 5, "RI": 5, "MA": 5,
    "VT": 6, "NH": 6, "ME": 6, "AK": 7,
}

# County-level overrides for split states — cold pockets in otherwise-warm states
# (mountains) and vice-versa. Keyed by (STATE, county-name-lower without "county").
_COUNTY_ZONE_OVERRIDE: dict[tuple[str, str], int] = {
    ("NC", "watauga"): 5, ("NC", "avery"): 5, ("NC", "ashe"): 5,   # NC High Country
    ("NC", "mitchell"): 5, ("NC", "yancey"): 5, ("NC", "madison"): 4,
    ("CA", "alpine"): 6, ("CA", "mono"): 6, ("CA", "nevada"): 5,   # Sierra
    ("CA", "el dorado"): 5, ("CA", "placer"): 5,
    ("TN", "johnson"): 5, ("TN", "carter"): 5,                     # E TN mtns
    ("AZ", "coconino"): 5, ("AZ", "apache"): 5, ("AZ", "navajo"): 4,  # AZ high country
}


def _clean_county(county: str | None) -> str:
    if not county:
        return ""
    c = county.strip().lower()
    for suffix in (" county", " parish", " borough"):
        if c.endswith(suffix):
            c = c[: -len(suffix)]
    return c.strip()


def policy_for(state: str | None, county: str | None = None) -> IceWaterPolicy:
    """Resolve the ice & water policy for a job location.

    Precedence: county override -> state zone -> conservative default (mixed).
    """
    st = (state or "").strip().upper()
    zone = _COUNTY_ZONE_OVERRIDE.get((st, _clean_county(county)))
    if zone is None:
        zone = _STATE_ZONE.get(st, _DEFAULT_ZONE)
    return _ZONE_POLICY.get(zone, _ZONE_POLICY[_DEFAULT_ZONE])


def ice_water_area_sqft(
    eaves_ft: float,
    valleys_ft: float,
    policy: IceWaterPolicy,
) -> tuple[float, str]:
    """Ice & water membrane area for a policy. Returns (sqft, trace_string)."""
    eave_sf = eaves_ft * policy.eave_width_ft
    valley_sf = valleys_ft * 6.0 if policy.cover_valleys else 0.0
    sf = eave_sf + valley_sf
    parts = []
    if policy.eave_courses > 0:
        parts.append(f"{eaves_ft:.1f}×{policy.eave_width_ft:g} eave")
    if policy.cover_valleys and valleys_ft > 0:
        parts.append(f"{valleys_ft:.1f}×6 valley")
    detail = " + ".join(parts) if parts else "valleys/penetrations only"
    return sf, f"[{policy.label}] {detail} = {sf:.1f} sf"
