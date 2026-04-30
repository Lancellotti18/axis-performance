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
#
# Sources cross-checked: ICC State Adoption Database, IAEI NEC Adoption Map,
# NFPA NEC Enforcement Map, NAHB IECC Adoption Status, state DCED / building
# code commission sites. Where a state has NO statewide adoption (HOME-RULE
# states), we pin the most common municipal cycle and label it; the live
# research layer surfaces local amendments either way.
STATE_CODE_CYCLES: dict[str, dict[str, str]] = {
    # ── Northeast ──────────────────────────────────────────────────────────
    "ME": {"building": "2015 IBC w/ 2021 ME amendments (MUBEC)",
           "residential": "2015 IRC w/ 2021 ME amendments",
           "energy": "2021 IECC", "electrical": "2020 NEC"},
    "NH": {"building": "2018 IBC", "residential": "2018 IRC",
           "energy": "2018 IECC", "electrical": "2020 NEC"},
    "VT": {"building": "2015 IBC w/ VT amendments",
           "residential": "2015 IRC w/ VT amendments",
           "energy": "2020 VT Residential Building Energy Standards (RBES)",
           "electrical": "2020 NEC"},
    "MA": {"building": "10th Ed Massachusetts Building Code (based on 2021 IBC)",
           "residential": "10th Ed MA Residential Code (based on 2021 IRC)",
           "energy": "10th Ed MA Stretch Energy Code (based on 2021 IECC w/ MA amendments)",
           "electrical": "2023 NEC w/ MA amendments (527 CMR 12.00)"},
    "RI": {"building": "2018 IBC (RISBC)", "residential": "2018 IRC",
           "energy": "2018 IECC", "electrical": "2020 NEC"},
    "CT": {"building": "2022 CT State Building Code (based on 2021 IBC); 2026 CT code (2024 IBC) effective mid-2026",
           "residential": "2022 CT Residential Code (based on 2021 IRC)",
           "energy": "2022 CT Energy Code (based on 2021 IECC)",
           "electrical": "2020 NEC"},
    "NJ": {"building": "2021 IBC adopted via NJ UCC (effective 2025-09)",
           "residential": "2021 IRC adopted via NJ UCC",
           "energy": "2021 IECC adopted via NJ UCC",
           "electrical": "2023 NEC w/ NJ amendments (effective 2024)"},
    "NY": {"building": "2020 NY State Building Code (based on 2018 IBC); 2024 IBC under review",
           "residential": "2020 NYS Residential Code",
           "energy": "2020 NYS Energy Conservation Construction Code",
           "electrical": "2023 NEC w/ NY amendments (effective 2025-12)"},
    "PA": {"building": "2021 IBC adopted via PA UCC (34 Pa. Code Ch. 403, effective 2026-01-01)",
           "residential": "2021 IRC adopted via PA UCC (34 Pa. Code Ch. 403, effective 2026-01-01)",
           "energy": "2021 IECC adopted via PA UCC (34 Pa. Code Ch. 403, effective 2026-01-01)",
           "electrical": "2020 NEC adopted via PA UCC (effective 2025-07-13)",
           "plumbing": "2021 IPC adopted via PA UCC (effective 2026-01-01)",
           "mechanical": "2021 IMC adopted via PA UCC (effective 2026-01-01)",
           "fire": "2021 IFC adopted via PA UCC (effective 2026-01-01)",
           "fuel_gas": "2021 IFGC adopted via PA UCC (effective 2026-01-01)"},
    "DE": {"building": "No statewide adoption — most counties on 2018/2021 IBC",
           "residential": "No statewide adoption — most counties on 2018/2021 IRC",
           "energy": "2018 IECC (statewide minimum)", "electrical": "2020 NEC"},
    "MD": {"building": "2018 IBC adopted via MBPS (Maryland Building Performance Standards)",
           "residential": "2018 IRC", "energy": "2018 IECC w/ MD amendments",
           "electrical": "2020 NEC"},
    "DC": {"building": "2017 DC Construction Codes (based on 2015 IBC + DC supplement)",
           "residential": "2017 DCRC", "energy": "2017 DCECC",
           "electrical": "2017 DC Electrical Code (based on 2017 NEC)"},

    # ── Southeast ──────────────────────────────────────────────────────────
    "VA": {"building": "2021 Virginia USBC (based on 2021 IBC)",
           "residential": "2021 VRC", "energy": "2021 VECC", "electrical": "2020 NEC"},
    "WV": {"building": "2018 IBC (statewide)", "residential": "2018 IRC",
           "energy": "2015 IECC", "electrical": "2020 NEC"},
    "NC": {"building": "2018 NC Building Code (based on 2015 IBC + NC amendments)",
           "residential": "2018 NC Residential Code",
           "energy": "2018 NC Energy Conservation Code",
           "electrical": "2020 NEC"},
    "SC": {"building": "2021 IBC (effective 2023)", "residential": "2021 IRC",
           "energy": "2009 IECC", "electrical": "2020 NEC"},
    "GA": {"building": "2018 IBC w/ 2020 GA amendments",
           "residential": "2018 IRC w/ GA amendments",
           "energy": "2015 IECC w/ GA amendments", "electrical": "2020 NEC"},
    "FL": {"building": "8th Ed Florida Building Code (based on 2021 IBC/IRC, effective 2024-01-01)",
           "residential": "8th Ed FBC Residential",
           "energy": "8th Ed FBC Energy Conservation",
           "electrical": "2023 NEC adopted via FBC"},
    "AL": {"building": "2021 IBC (statewide minimum)", "residential": "2021 IRC",
           "energy": "2015 IECC w/ AL amendments", "electrical": "2020 NEC"},
    "MS": {"building": "2018 IBC (statewide minimum)", "residential": "2018 IRC",
           "energy": "2018 IECC", "electrical": "2020 NEC"},
    "TN": {"building": "2018 IBC (state-adopted; commercial)",
           "residential": "2018 IRC (residential, 2009 IECC fallback)",
           "energy": "2018 IECC w/ TN amendments", "electrical": "2020 NEC"},
    "KY": {"building": "2018 IBC (Kentucky Building Code)",
           "residential": "2018 IRC (Kentucky Residential Code)",
           "energy": "2018 IECC w/ KY amendments", "electrical": "2020 NEC"},
    "AR": {"building": "2021 IBC (Arkansas Fire Prevention Code Vol. III)",
           "residential": "2021 IRC", "energy": "2018 IECC w/ AR amendments",
           "electrical": "2020 NEC"},
    "LA": {"building": "2021 IBC adopted via LA State Uniform Construction Code (LSUCC)",
           "residential": "2021 IRC adopted via LSUCC",
           "energy": "2018 IECC adopted via LSUCC",
           "electrical": "2020 NEC adopted via LSUCC"},

    # ── Midwest ────────────────────────────────────────────────────────────
    "OH": {"building": "2024 Ohio Building Code (based on 2024 IBC, effective 2024)",
           "residential": "2024 Ohio Residential Code (based on 2024 IRC)",
           "energy": "2018 IECC w/ OH amendments",
           "electrical": "2017 NEC adopted via OBC"},
    "MI": {"building": "2015 Michigan Building Code (based on 2015 IBC w/ MI amendments); 2021 update under review",
           "residential": "2015 Michigan Residential Code",
           "energy": "2015 Michigan Energy Code (based on 2015 IECC)",
           "electrical": "2017 NEC w/ MI amendments"},
    "IN": {"building": "2014 Indiana Building Code (based on 2012 IBC w/ amendments)",
           "residential": "2020 Indiana Residential Code (based on 2018 IRC)",
           "energy": "2010 ASHRAE 90.1 (commercial), 2009 IECC (residential, IN amended)",
           "electrical": "2008 NEC w/ Indiana amendments"},
    "IL": {"building": "No statewide adoption — most home-rule cities use 2018/2021 IBC; state-owned buildings on 2018 IBC",
           "residential": "Illinois Residential Building Code (effective 2024-01-01, based on 2021 IRC, applies to non-home-rule)",
           "energy": "2021 IECC (Illinois Energy Conservation Code, effective 2022)",
           "electrical": "2020 NEC (state-owned buildings); home-rule varies"},
    "WI": {"building": "Wisconsin Commercial Building Code (SPS 361-365, based on 2015 IBC)",
           "residential": "Wisconsin Uniform Dwelling Code (SPS 320-325)",
           "energy": "WI UDC energy chapter (based on 2015 IECC)",
           "electrical": "2017 NEC adopted via SPS 316"},
    "MN": {"building": "2020 Minnesota State Building Code (based on 2018 IBC w/ MN amendments)",
           "residential": "2020 MN Residential Code (based on 2018 IRC)",
           "energy": "2020 MN Residential Energy Code / 2020 MN Commercial Energy Code",
           "electrical": "2023 NEC w/ MN amendments (effective 2024-04)"},
    "IA": {"building": "2021 IBC (state-owned buildings); local jurisdictions vary",
           "residential": "2021 IRC (state minimum for non-state buildings via Iowa Code Ch. 103A)",
           "energy": "2012 IECC w/ IA amendments", "electrical": "2020 NEC"},
    "MO": {"building": "No statewide adoption — most cities use 2018/2021 IBC (St. Louis 2018, KCMO 2018)",
           "residential": "No statewide adoption — most cities use 2018/2021 IRC",
           "energy": "Varies by jurisdiction — most use 2018 IECC",
           "electrical": "2017 NEC most common; varies"},
    "ND": {"building": "2018 IBC (statewide via ND State Building Code)",
           "residential": "2018 IRC", "energy": "2018 IECC",
           "electrical": "2020 NEC"},
    "SD": {"building": "2018 IBC (state buildings); local jurisdictions adopt independently",
           "residential": "2018 IRC most common",
           "energy": "2009 IECC (state minimum)", "electrical": "2020 NEC"},
    "NE": {"building": "2018 IBC (Nebraska Energy Office adopts statewide for energy)",
           "residential": "2018 IRC most common",
           "energy": "2018 IECC (Nebraska Energy Code)", "electrical": "2020 NEC"},
    "KS": {"building": "No statewide adoption — most cities use 2018/2021 IBC (Wichita-Sedgwick on 2024 IBC)",
           "residential": "Varies — most use 2018 IRC",
           "energy": "Varies — most use 2018 IECC", "electrical": "2017 NEC most common"},

    # ── Mountain / West ────────────────────────────────────────────────────
    "MT": {"building": "2021 IBC (Montana State Building Code)",
           "residential": "2018 IRC w/ MT amendments",
           "energy": "2021 IECC w/ MT amendments", "electrical": "2020 NEC"},
    "WY": {"building": "2021 IBC (statewide minimum)", "residential": "2021 IRC",
           "energy": "2018 IECC", "electrical": "2017 NEC"},
    "CO": {"building": "No statewide adoption — most cities use 2021 IBC (Denver on 2024 IBC)",
           "residential": "Varies — most use 2018/2021 IRC",
           "energy": "2021 IECC (state minimum per HB21-1286, effective 2023-07-01 to 2026-06-30)",
           "electrical": "2023 NEC (state-licensed work, per Colorado State Electrical Board)"},
    "UT": {"building": "2021 IBC (Utah State Construction Code)",
           "residential": "2021 IRC (Utah amended)",
           "energy": "2021 IECC w/ UT amendments", "electrical": "2020 NEC"},
    "NV": {"building": "2018 IBC most common; Las Vegas / Clark County on 2024 IBC",
           "residential": "2018 IRC most common", "energy": "2021 IECC",
           "electrical": "2020 NEC"},
    "AZ": {"building": "No statewide adoption — Phoenix on 2018 IBC w/ amendments; most cities 2018/2021 IBC",
           "residential": "Varies — most use 2018 IRC",
           "energy": "Varies — most use 2018 IECC", "electrical": "2017 NEC most common"},
    "NM": {"building": "2018 IBC (NM Construction Industries Division)",
           "residential": "2018 IRC (NM Residential Building Code)",
           "energy": "2021 IECC (effective 2024)",
           "electrical": "2020 NEC w/ NM amendments"},
    "ID": {"building": "2018 IBC (Idaho Building Code)",
           "residential": "2018 IRC w/ ID amendments",
           "energy": "2018 IECC w/ ID amendments", "electrical": "2020 NEC"},

    # ── Pacific ────────────────────────────────────────────────────────────
    "WA": {"building": "2021 IBC adopted via WA State Building Code (effective 2024-03-15)",
           "residential": "2021 IRC adopted via WA State Building Code",
           "energy": "2021 Washington State Energy Code (based on 2021 IECC w/ WA amendments)",
           "electrical": "2020 NEC w/ WA amendments"},
    "OR": {"building": "2022 Oregon Structural Specialty Code (based on 2021 IBC)",
           "residential": "2023 Oregon Residential Specialty Code (based on 2021 IRC)",
           "energy": "2023 Oregon Energy Efficiency Specialty Code (based on 2021 IECC)",
           "electrical": "2023 Oregon Electrical Specialty Code (based on 2023 NEC)"},
    "CA": {"building": "2022 California Building Code (Title 24, Part 2; 2025 CBC effective 2026-01-01 in some jurisdictions)",
           "residential": "2022 CRC (Title 24, Part 2.5)",
           "energy": "2022 Title 24 Part 6 (California Energy Code)",
           "electrical": "2022 California Electrical Code (Title 24, Part 3, based on 2020 NEC)"},
    "AK": {"building": "2018 IBC (state-owned buildings); local jurisdictions vary",
           "residential": "No statewide IRC — Anchorage and Fairbanks on 2018 IRC",
           "energy": "2018 IECC w/ AK amendments (state buildings)",
           "electrical": "2017 NEC w/ AK amendments"},
    "HI": {"building": "2018 IBC adopted via HI State Building Code (HRS 107)",
           "residential": "2018 IRC adopted via HI State Building Code",
           "energy": "2018 IECC w/ HI amendments",
           "electrical": "2014 NEC w/ HI amendments (state still on older edition)"},

    # ── South Central (Texas + Oklahoma) ───────────────────────────────────
    "TX": {"building": "No statewide adoption — most jurisdictions on 2021 IBC (Austin/Houston/Dallas/SA on 2024 IBC)",
           "residential": "2021 IRC (state minimum for residential per Tex. Loc. Gov. Code §214.212)",
           "energy": "2015 IECC (state minimum for single-family; 2021 IECC for commercial)",
           "electrical": "2023 NEC adopted via Texas Electrical Safety and Licensing Act"},
    "OK": {"building": "2015 IBC most common (Oklahoma Uniform Building Code Commission)",
           "residential": "2018 IRC most common", "energy": "2018 IECC w/ OK amendments",
           "electrical": "2017 NEC most common"},
    # Default fallback for states not pinned — handled by short-token defaults
    # in resolve_jurisdiction(). The LLM still verifies via live research.
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
    # State code resources that aren't on .gov but are authoritative.
    "iapmo.org",
    "phrc.psu.edu",          # PA Housing Research Center — PA UCC quick-guide hub
    "pacodeandbulletin.gov",  # 34 Pa. Code Ch. 401–405 (UCC) + PA Bulletin
    "njcrr.com",             # NJ code reference — neighbor-state lookups
    "dos.ny.gov",            # NY Dept of State (building code division)
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
        # Short tokens — these get interpolated INTO Tavily queries, so prose
        # like "Use whichever IRC edition the research indicates is adopted"
        # poisons every search. The LLM still infers the actual cycle from
        # research and returns the verified edition.
        code_cycles = {
            "building": "IBC",
            "residential": "IRC",
            "energy": "IECC",
            "electrical": "NEC",
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
