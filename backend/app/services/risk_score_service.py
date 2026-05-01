"""
Natural-disaster risk score service.

Pulls recent, location-specific weather/seismic/fire event data via web search,
then asks the LLM for a structured risk assessment + reinforcement recommendations
that are grounded in what was actually retrieved.

Hazards covered:
  - Hail
  - Wind / severe thunderstorm / derecho
  - Tornado
  - Hurricane / tropical storm
  - Flood / flash flood / storm surge
  - Wildfire
  - Earthquake
  - Winter storm / ice / snow load

Each hazard gets a 0-10 score (0 = not applicable here) and zero or more
reinforcement recommendations tied to the specific recent events or code
updates surfaced in the research.
"""
from __future__ import annotations

import logging
import re
import json
from datetime import datetime
from app.services.llm import llm_text
from app.services.search import (
    web_search_multi_structured,
    _format_articles_for_prompt,
)

logger = logging.getLogger(__name__)


def _parse_risk_json(text: str) -> dict:
    """
    Tolerant JSON parser for the storm-risk LLM response. Strips fences, finds
    the largest balanced {...} block, fixes trailing commas / Python-isms, and
    walks back through `}` boundaries if the first parse fails (covers
    truncated responses with unterminated strings at the tail).
    """
    raw = (text or "").strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw, count=1)
    raw = re.sub(r"\s*```\s*$", "", raw)
    start = raw.find("{")
    if start < 0:
        return {}

    depth, end, in_str, escape = 0, -1, False, False
    for i in range(start, len(raw)):
        ch = raw[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i
                break

    candidate = raw[start:end + 1] if end > 0 else raw[start:]
    candidate = re.sub(r",\s*([}\]])", r"\1", candidate)
    candidate = re.sub(r"\bNone\b", "null", candidate)
    candidate = re.sub(r"\bTrue\b", "true", candidate)
    candidate = re.sub(r"\bFalse\b", "false", candidate)

    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        # Walk back through `}` boundaries to salvage truncated output.
        for i in range(len(candidate) - 1, -1, -1):
            if candidate[i] != "}":
                continue
            try:
                return json.loads(candidate[:i + 1])
            except Exception:
                continue
        # Last resort: try closing any open string + any open arrays/objects so
        # we can salvage the structured fields that did parse cleanly.
        repaired = candidate
        if repaired.count('"') % 2 == 1:
            repaired += '"'
        open_arr = repaired.count("[") - repaired.count("]")
        open_obj = repaired.count("{") - repaired.count("}")
        repaired += "]" * max(open_arr, 0) + "}" * max(open_obj, 0)
        repaired = re.sub(r",\s*([}\]])", r"\1", repaired)
        try:
            return json.loads(repaired)
        except Exception:
            logger.warning(
                "risk_score: JSON parse failed, returning empty dict. raw[:200]=%r",
                (text or "")[:200],
            )
            return {}


def _empty_risk_payload(location: str, reason: str) -> dict:
    """Graceful fallback when the LLM response can't be parsed."""
    return {
        "overall_risk": 0,
        "risk_label": "Unknown",
        "risk_color": "amber",
        "summary": f"Could not generate a structured risk report for {location}. {reason}",
        "scoring_rationale": "",
        "significance": "",
        "hazards": [
            {"key": "hail",      "label": "Hail",                          "score": 0, "rationale": ""},
            {"key": "wind",      "label": "Wind / Severe Thunderstorm",    "score": 0, "rationale": ""},
            {"key": "tornado",   "label": "Tornado",                       "score": 0, "rationale": ""},
            {"key": "hurricane", "label": "Hurricane / Tropical Storm",    "score": 0, "rationale": ""},
            {"key": "flood",     "label": "Flood / Storm Surge",           "score": 0, "rationale": ""},
            {"key": "wildfire",  "label": "Wildfire",                      "score": 0, "rationale": ""},
            {"key": "earthquake","label": "Earthquake",                    "score": 0, "rationale": ""},
            {"key": "winter",    "label": "Winter Storm / Ice",            "score": 0, "rationale": ""},
        ],
        "recent_events": [],
        "reinforcement_recommendations": [],
        "insurance_note": "",
        "data_source": "",
        "hail_risk": 0,
        "wind_risk": 0,
        "flood_risk": 0,
    }


async def get_risk_score(city: str, state: str, zip_code: str = "") -> dict:
    """
    Generate an all-hazard natural-disaster risk report for a given US location.
    Returns per-hazard scores (0-10), recent events, and reinforcement recs
    grounded in real news and code-update research.
    """
    location  = f"{city}, {state}" + (f" {zip_code}" if zip_code else "")
    today     = datetime.utcnow()
    this_year = today.year
    last_year = this_year - 1

    # Pull recent, location-specific evidence from multiple hazard angles.
    # Dates are included in the queries so the web_search backend prioritises fresh results.
    articles = await web_search_multi_structured(
        [
            f"{city} {state} severe weather damage {last_year} {this_year} news",
            f"{city} {state} hurricane tropical storm flooding {last_year} {this_year}",
            f"{city} {state} tornado hail wind damage reports {last_year} {this_year}",
            f"{city} {state} wildfire evacuation {last_year} {this_year}",
            f"{state} earthquake seismic activity {last_year} {this_year} USGS",
            f"{city} {state} winter storm blizzard ice snow damage {last_year} {this_year}",
            f"{city} {state} building code update resilience hurricane wind {last_year} {this_year}",
            f"{zip_code or city} {state} FEMA disaster declaration {last_year} {this_year}",
        ],
        max_results=4,
    )

    research = _format_articles_for_prompt(articles) if articles else ""

    # Cap research to ~12k chars (~3k tokens). Keeps the full prompt inside
    # Groq's free-tier TPM cap so it can serve as a real fallback when Gemini
    # is rate-limited, and avoids burning Gemini quota on duplicate snippets.
    MAX_RESEARCH_CHARS = 12000
    if research and len(research) > MAX_RESEARCH_CHARS:
        research = research[:MAX_RESEARCH_CHARS] + "\n\n…[truncated — remaining results omitted for length]"

    prompt = f"""You are a certified property risk analyst specialising in natural-disaster
exposure and building resilience. Today's date is {today.strftime('%Y-%m-%d')}.

Target location: {location}

RESEARCH (use this to ground your analysis — do not fabricate events that aren't supported):
{research if research else f"No live data retrieved. Use only your own verified knowledge of {location} geography, FEMA/NOAA/USGS records, and published building-code history. If you do not have confident information, leave scores at 0 and arrays empty rather than guessing."}

RULES
  1. Every score, event, and recommendation must be grounded in the research above OR in verifiable published climate / seismic / building-code data for this exact location. Never invent a specific event, date, or code update.
  2. "recent_events" should be events from approximately the past 24 months that the research supports. Leave the array empty if nothing verifiable was retrieved.
  3. SCORE EVERY HAZARD based on the location's well-established climate and geological profile, not just on whatever the research happened to surface. Examples:
       - Pennsylvania / Ohio / Northeast → winter storms typically score 6-8 (lake-effect snow, ice storms, nor'easters)
       - Texas / Oklahoma / Kansas / Nebraska → tornado typically 7-9, hail typically 6-8
       - Florida / Gulf Coast / Carolina coast → hurricane typically 7-10
       - California / Pacific Northwest → earthquake typically 5-9, wildfire 5-9
       - Arizona / New Mexico / Nevada → wildfire 4-7, earthquake 1-3
     Use 0 ONLY when a hazard is genuinely not applicable (e.g., hurricane in landlocked Kansas; tornado in coastal Maine = 1-2 not 0).
  4. "reinforcement_recommendations" must cite WHY — tie each recommendation to a recent event, a FEMA/state code update, or documented regional best practice. Do not produce generic advice.

Return ONLY valid JSON — no prose before or after — with this exact shape:
{{
  "overall_risk": 6,
  "risk_label": "Elevated",
  "risk_color": "amber",
  "summary": "Two to three sentences framing the overall risk profile, citing specific hazards and any recent major event.",
  "scoring_rationale": "Two to three sentences explaining how this overall score was derived from the per-hazard mix and recent events.",
  "significance": "One to two sentences on what this means for a contractor/owner — material choices, insurance posture, business opportunity.",
  "hazards": [
    {{
      "key": "hail",
      "label": "Hail",
      "score": 7,
      "rationale": "Specific recent data or climate pattern that justifies the score."
    }},
    {{"key": "wind",      "label": "Wind / Severe Thunderstorm", "score": 0, "rationale": ""}},
    {{"key": "tornado",   "label": "Tornado",                    "score": 0, "rationale": ""}},
    {{"key": "hurricane", "label": "Hurricane / Tropical Storm", "score": 0, "rationale": ""}},
    {{"key": "flood",     "label": "Flood / Storm Surge",        "score": 0, "rationale": ""}},
    {{"key": "wildfire",  "label": "Wildfire",                   "score": 0, "rationale": ""}},
    {{"key": "earthquake","label": "Earthquake",                 "score": 0, "rationale": ""}},
    {{"key": "winter",    "label": "Winter Storm / Ice",         "score": 0, "rationale": ""}}
  ],
  "recent_events": [
    {{"year": 2025, "type": "Hurricane", "severity": "Cat 2 landfall with 105 mph sustained winds", "impact": "Widespread roof and siding damage; 30k insurance claims filed.", "source": "NWS / FEMA disaster declaration DR-4XXX"}}
  ],
  "reinforcement_recommendations": [
    {{
      "hazard": "hurricane",
      "action": "Upgrade to Miami-Dade-approved impact-rated windows and doors",
      "why": "Specific reason grounded in research — e.g. 'the September 2025 hurricane caused 60% of claims in this ZIP to involve opening failures' or 'Florida 2025 code revision now requires impact glazing in wind-borne debris regions'.",
      "priority": "high"
    }}
  ],
  "insurance_note": "One sentence on insurance-claim volume, premium trends, or coverage quirks in this area grounded in the research.",
  "data_source": "Short summary of sources used — e.g. 'Tavily web search + NOAA/USGS/FEMA references'"
}}

BACK-COMPAT (also include these top-level fields so existing clients keep working):
  "hail_risk"      — the score from hazards[key=hail] or 0
  "wind_risk"      — the score from hazards[key=wind]  or 0
  "flood_risk"     — the score from hazards[key=flood] or 0

SCORING GUIDE (0-10)
  0    Not applicable at this location
  1-3  Low — minimal historical activity
  4-5  Moderate — occasional events, some reinforcement advisable
  6-7  Elevated — frequent events, reinforcement strongly advised
  8-9  High — major recent event OR severe ongoing exposure
  10   Extreme — epicentre of hazard (tornado alley, coastal Cat-4+, San Andreas fault proximity, etc.)

RISK COLOR
  "emerald" for overall 0-3, "amber" for 4-7, "red" for 8-10

PRIORITY
  "high" = address before next season / within 12 months
  "medium" = address within 2-3 years or at next major reroof/remodel
  "low"  = nice-to-have / new-build best practice

Keep reinforcement_recommendations to at most 6 items, ordered by priority (high → low).
Keep recent_events to at most 5 items, newest first."""

    text = await llm_text(prompt, max_tokens=2000)
    result = _parse_risk_json(text)
    if not result:
        fallback = _empty_risk_payload(
            location,
            "The AI response could not be parsed as JSON — try refreshing in a moment.",
        )
        fallback["articles"] = _filter_disaster_articles(articles)
        return fallback

    # Always guarantee all 8 canonical hazards are present so the graph never
    # renders empty. Missing entries default to score=0; the model is allowed
    # to fill in any subset.
    CANONICAL_HAZARDS = [
        ("hail",       "Hail"),
        ("wind",       "Wind / Severe Thunderstorm"),
        ("tornado",    "Tornado"),
        ("hurricane",  "Hurricane / Tropical Storm"),
        ("flood",      "Flood / Storm Surge"),
        ("wildfire",   "Wildfire"),
        ("earthquake", "Earthquake"),
        ("winter",     "Winter Storm / Ice"),
    ]
    hazards_by_key = {
        h.get("key"): h
        for h in (result.get("hazards") or [])
        if isinstance(h, dict) and h.get("key")
    }
    full_hazards = []
    for key, label in CANONICAL_HAZARDS:
        existing = hazards_by_key.get(key) or {}
        full_hazards.append({
            "key":       key,
            "label":     existing.get("label") or label,
            "score":     existing.get("score") if isinstance(existing.get("score"), (int, float)) else 0,
            "rationale": existing.get("rationale") or "",
        })
    result["hazards"] = full_hazards

    # Defensive back-compat: derive legacy scores from hazards[] if the model
    # skipped filling them in at the top level.
    score_by_key = {h["key"]: h["score"] for h in full_hazards}
    for legacy_field, hazard_key in (("hail_risk", "hail"), ("wind_risk", "wind"), ("flood_risk", "flood")):
        if legacy_field not in result:
            result[legacy_field] = score_by_key.get(hazard_key, 0)

    # Surface only the disaster-relevant research articles so the UI cards
    # are real recent-event evidence, not generic tourism / homepage results.
    result["articles"] = _filter_disaster_articles(articles)

    return result


# ---------------------------------------------------------------------------
# Article quality filter
# ---------------------------------------------------------------------------

# Words that strongly suggest the article is actually about a weather /
# seismic / fire / disaster event — used to filter out tourism, government
# homepage, and general-info results that aren't usable evidence.
_DISASTER_KEYWORDS = (
    "hurricane", "tropical storm", "tropical depression", "cyclone",
    "tornado", "storm", "thunderstorm", "severe weather", "derecho",
    "hail", "wind damage", "high wind", "microburst",
    "flood", "flash flood", "storm surge", "rainfall",
    "wildfire", "fire", "evacuation", "burn",
    "earthquake", "seismic", "tremor", "magnitude", "fault",
    "winter storm", "ice storm", "blizzard", "snowstorm",
    "fema", "disaster declaration", "noaa", "usgs", "national weather service",
    "damage", "destroyed", "claims", "insurance",
    "building code", "code update", "resilience",
)

# Domains that are almost always noise for disaster research, regardless of
# the query. These are tourism boards, generic city homepages, marketing
# blogs, and shopping/realty hubs that fill DDG results when a city name
# matches a tourism keyword.
_BAD_DOMAIN_FRAGMENTS = (
    "visit",          # visitwilmingtonnc.com, visitfla.com
    "tourism",
    "tripadvisor",
    "yelp.com",
    "booking.com",
    "expedia",
    "hotels.com",
    "zillow",
    "realtor",
    "redfin",
    "trulia",
)


def _filter_disaster_articles(articles: list[dict]) -> list[dict]:
    """
    Keep only articles that look like real disaster / weather / code-update
    coverage. Removes tourism boards, city homepages, and other DDG noise.
    """
    if not articles:
        return []
    kept: list[dict] = []
    for a in articles:
        url     = (a.get("url") or "").lower()
        title   = (a.get("title") or "").lower()
        snippet = (a.get("snippet") or "").lower()
        if not url:
            continue
        if any(frag in url for frag in _BAD_DOMAIN_FRAGMENTS):
            continue
        haystack = f"{title} {snippet}"
        if not any(kw in haystack for kw in _DISASTER_KEYWORDS):
            continue
        kept.append(a)
    return kept[:12]
