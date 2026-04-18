"""
Jurisdiction resolver — converts (city, state, county, zip) into the
climate/wind/code context needed for accurate compliance grounding.

The climate zone, wind region, and adopted code cycle drive which IRC/IBC/IECC
chapters actually apply. Shipping generic "IRC 2021" citations is useless if
the state adopted 2018 IRC with 2024 state amendments — this helper lets the
compliance engine pin the right cycle and feed the LLM a jurisdiction profile
instead of a bare city string.

Data sources used (all public):
  - IECC 2021 Table C301.1 climate zones (state + county granularity)
  - ASCE 7-22 basic wind speed map (state + coastal county)
  - Adopted model codes per state (ICC tracked adoption list, as of 2026-04)

For counties/states we don't have pinned data for, we return `None` and the
compliance engine degrades to state-level queries plus a "base code — confirm
with local AHJ" label on emitted items.
"""
from __future__ import annotations

import hashlib
import re
from typing import Optional

# IECC climate zones by state. Most states have 1–3 zones; high-accuracy
# per-county splits are in CLIMATE_ZONE_COUNTY_OVERRIDES below.
#
# When a state spans multiple zones, value is the PREDOMINANT zone. The
# override table handles the exceptions.
CLIMATE_ZONE_BY_STATE: dict[str, str] = {
    "AL": "2A", "AK": "7",  "AZ": "2B", "AR": "3A", "CA": "3B", "CO": "5B",
    "CT": "5A", "DE": "4A", "FL": "2A", "GA": "3A", "HI": "1A", "ID": "5B",
    "IL": "5A", "IN": "5A", "IA": "5A", "KS": "4A", "KY": "4A", "LA": "2A",
    "ME": "6A", "MD": "4A", "MA": "5A", "MI": "6A", "MN": "6A", "MS": "3A",
    "MO": "4A", "MT": "6B", "NE": "5A", "NV": "3B", "NH": "6A", "NJ": "4A",
    "NM": "4B", "NY": "5A", "NC": "3A", "ND": "7",  "OH": "5A", "OK": "3A",
    "OR": "4C", "PA": "5A", "RI": "5A", "SC": "3A", "SD": "6A", "TN": "4A",
    "TX": "2A", "UT": "5B", "VT": "6A", "VA": "4A", "WA": "4C", "WV": "5A",
    "WI": "6A", "WY": "6B", "DC": "4A",
}

# Counties that fall outside their state's predominant zone.
# key = (state, county lowercased). Pointer source: IECC 2021 Table C301.1.
CLIMATE_ZONE_COUNTY_OVERRIDES: dict[tuple[str, str], str] = {
    ("FL", "monroe"): "1A",
    ("TX", "brewster"): "3B", ("TX", "culberson"): "3B", ("TX", "el paso"): "3B",
    ("TX", "hudspeth"): "3B", ("TX", "jeff davis"): "3B", ("TX", "presidio"): "3B",
    ("CA", "mono"): "6B", ("CA", "alpine"): "7",
    ("NC", "avery"): "5A", ("NC", "mitchell"): "5A", ("NC", "watauga"): "5A",
    ("NC", "ashe"): "5A", ("NC", "alleghany"): "5A", ("NC", "yancey"): "5A",
    ("NC", "madison"): "5A",
}

# Coastal / high-wind counties (ASCE 7-22 wind speed ≥130 mph or hurricane
# prone region per ASCE). These drive impact glazing, enhanced fastening,
# and wind-borne debris requirements.
HIGH_WIND_COUNTIES: set[tuple[str, str]] = {
    # Florida (entire coast is high-wind, most of state is hurricane-prone)
    ("FL", "miami-dade"), ("FL", "broward"), ("FL", "palm beach"),
    ("FL", "monroe"), ("FL", "collier"), ("FL", "lee"), ("FL", "charlotte"),
    ("FL", "sarasota"), ("FL", "manatee"), ("FL", "pinellas"),
    ("FL", "hillsborough"), ("FL", "pasco"), ("FL", "hernando"),
    ("FL", "citrus"), ("FL", "levy"), ("FL", "franklin"), ("FL", "gulf"),
    ("FL", "bay"), ("FL", "walton"), ("FL", "okaloosa"), ("FL", "santa rosa"),
    ("FL", "escambia"), ("FL", "indian river"), ("FL", "st. lucie"),
    ("FL", "martin"), ("FL", "brevard"), ("FL", "volusia"), ("FL", "flagler"),
    ("FL", "st. johns"), ("FL", "duval"), ("FL", "nassau"),
    # NC / SC / GA / Gulf coast
    ("NC", "currituck"), ("NC", "dare"), ("NC", "hyde"), ("NC", "carteret"),
    ("NC", "onslow"), ("NC", "pender"), ("NC", "new hanover"),
    ("NC", "brunswick"),
    ("SC", "horry"), ("SC", "georgetown"), ("SC", "charleston"),
    ("SC", "colleton"), ("SC", "beaufort"), ("SC", "jasper"),
    ("GA", "chatham"), ("GA", "bryan"), ("GA", "liberty"), ("GA", "mcintosh"),
    ("GA", "glynn"), ("GA", "camden"),
    ("AL", "mobile"), ("AL", "baldwin"),
    ("MS", "hancock"), ("MS", "harrison"), ("MS", "jackson"),
    ("LA", "cameron"), ("LA", "vermilion"), ("LA", "iberia"),
    ("LA", "st. mary"), ("LA", "terrebonne"), ("LA", "lafourche"),
    ("LA", "jefferson"), ("LA", "orleans"), ("LA", "st. bernard"),
    ("LA", "plaquemines"),
    ("TX", "cameron"), ("TX", "willacy"), ("TX", "kenedy"), ("TX", "kleberg"),
    ("TX", "nueces"), ("TX", "san patricio"), ("TX", "aransas"),
    ("TX", "calhoun"), ("TX", "matagorda"), ("TX", "brazoria"),
    ("TX", "galveston"), ("TX", "harris"), ("TX", "chambers"),
    ("TX", "jefferson"),
    # NY / NJ / RI / MA coastal high-wind
    ("NY", "suffolk"), ("NY", "nassau"), ("NY", "queens"), ("NY", "kings"),
    ("NY", "bronx"), ("NY", "richmond"),
    ("NJ", "atlantic"), ("NJ", "cape may"), ("NJ", "ocean"),
    ("NJ", "monmouth"),
    ("MA", "barnstable"), ("MA", "dukes"), ("MA", "nantucket"),
    ("MA", "bristol"), ("MA", "plymouth"),
    ("RI", "newport"), ("RI", "washington"),
    # Hawaii
    ("HI", "honolulu"), ("HI", "hawaii"), ("HI", "maui"), ("HI", "kauai"),
}

# Adopted model codes per state, pinned as of 2026-04.
# Compliance citations MUST use these cycles. If a state adopts a newer edition
# mid-project, the search layer will surface the newer amendment docs and the
# LLM is instructed to use the newer text when it appears.
STATE_CODE_CYCLES: dict[str, dict[str, str]] = {
    # Southeast
    "FL": {"building": "2023 Florida Building Code (based on 2021 IBC/IRC)",
           "residential": "2023 FBC Residential", "energy": "2020 FBC Energy", "electrical": "2023 NEC"},
    "GA": {"building": "2018 IBC with 2020 GA amendments",
           "residential": "2018 IRC", "energy": "2015 IECC w/ GA amendments", "electrical": "2020 NEC"},
    "NC": {"building": "2018 NC Building Code (based on 2015 IBC + NC amendments)",
           "residential": "2018 NC Residential Code", "energy": "2018 NC Energy Conservation Code",
           "electrical": "2020 NEC"},
    "SC": {"building": "2021 IBC (effective 2023)", "residential": "2021 IRC",
           "energy": "2009 IECC", "electrical": "2020 NEC"},
    "VA": {"building": "2021 Virginia USBC (based on 2021 IBC)",
           "residential": "2021 VRC", "energy": "2021 VECC", "electrical": "2020 NEC"},
    # Texas
    "TX": {"building": "2021 IBC / 2021 IRC (most jurisdictions); no statewide adoption — check local AHJ",
           "residential": "2021 IRC", "energy": "2021 IECC", "electrical": "2023 NEC"},
    # California
    "CA": {"building": "2022 California Building Code (Title 24, Part 2)",
           "residential": "2022 CRC", "energy": "2022 Title 24 Part 6", "electrical": "2022 CEC"},
    # New York
    "NY": {"building": "2020 NY State Building Code (based on 2018 IBC)",
           "residential": "2020 NYS Residential Code",
           "energy": "2020 NYS Energy Conservation Construction Code",
           "electrical": "2020 NEC"},
    # Default fallback for states not pinned — the LLM is told to use the
    # latest adopted IBC/IRC/IECC/NEC the research supports, and to flag
    # the code cycle it used.
}

# Authoritative domains — Tavily `include_domains` uses these so retail blog
# posts and wiki-style summaries can never outweigh the statute itself.
AUTHORITATIVE_DOMAINS: list[str] = [
    # Municipal code repositories
    "municode.com",
    "ecode360.com",
    "codepublishing.com",
    "amlegal.com",           # American Legal Publishing
    "sterlingcodifiers.com",
    # Code/standard publishers
    "iccsafe.org",
    "nfpa.org",
    "ashrae.org",
    "up.codes",              # publicly readable code hosting
    # Federal authorities
    "osha.gov",
    "epa.gov",
    "energy.gov",
    "fema.gov",
    "ada.gov",
    # State contractor boards / building code commissions — top-level .gov
    # domain inclusion catches state-specific sub-sites automatically.
    ".gov",
    # The state-by-state building code boards that don't live on .gov (rare)
    "iapmo.org",
]


ZIP_STATE_RE = re.compile(r"^\d{5}(?:-\d{4})?$")


def _norm(s: Optional[str]) -> str:
    return (s or "").strip().lower()


def _clean_county(county: Optional[str]) -> str:
    c = _norm(county)
    # Drop "county" / "parish" suffixes so lookups match table keys.
    c = re.sub(r"\s+(county|parish|borough)$", "", c)
    return c


def resolve_jurisdiction(
    city: Optional[str],
    state: Optional[str],
    county: Optional[str] = None,
    zip_code: Optional[str] = None,
) -> dict:
    """
    Build a structured jurisdiction profile for the compliance engine.

    Returns:
        {
          state: "NC",
          state_name: "North Carolina",
          city: "Wilmington",
          county: "new hanover",
          zip: "28401",
          climate_zone: "3A",
          high_wind: True,
          hurricane_prone: True,
          code_cycles: {building, residential, energy, electrical},
          code_cycles_pinned: True,     # False if we defaulted to the generic profile
          fingerprint: stable hash for caching,
        }

    Any field we couldn't confidently infer is explicitly None so the
    compliance engine can label items as "base code — confirm with local AHJ".
    """
    state_code = (state or "").upper().replace("US-", "")[:2]
    city_clean = _norm(city)
    county_clean = _clean_county(county)
    zip_clean = (zip_code or "").strip()
    if zip_clean and not ZIP_STATE_RE.match(zip_clean):
        zip_clean = ""

    # Climate zone — try county override first, then state predominant zone.
    climate = CLIMATE_ZONE_COUNTY_OVERRIDES.get((state_code, county_clean)) \
        or CLIMATE_ZONE_BY_STATE.get(state_code)

    # Wind posture
    high_wind = (state_code, county_clean) in HIGH_WIND_COUNTIES
    hurricane_prone = high_wind and state_code in {
        "FL", "GA", "NC", "SC", "AL", "MS", "LA", "TX", "VA", "HI"
    }

    code_cycles = STATE_CODE_CYCLES.get(state_code, {})
    code_pinned = bool(code_cycles)
    if not code_cycles:
        code_cycles = {
            "building": "Use whichever IBC/IRC edition the research indicates is adopted in this jurisdiction",
            "residential": "Use whichever IRC edition the research indicates is adopted",
            "energy": "Use whichever IECC edition the research indicates is adopted",
            "electrical": "Use whichever NEC edition the research indicates is adopted",
        }

    fp_source = "|".join([
        state_code, city_clean, county_clean, zip_clean,
    ])
    fingerprint = hashlib.sha1(fp_source.encode()).hexdigest()[:16]

    return {
        "state": state_code,
        "state_name": _state_name(state_code),
        "city": city or "",
        "county": county_clean,
        "zip": zip_clean,
        "climate_zone": climate,
        "high_wind": high_wind,
        "hurricane_prone": hurricane_prone,
        "code_cycles": code_cycles,
        "code_cycles_pinned": code_pinned,
        "fingerprint": fingerprint,
    }


_STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
    "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming", "DC": "District of Columbia",
}


def _state_name(code: str) -> str:
    return _STATE_NAMES.get(code, code)
