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

RESEARCH (use to ground recent events — do not fabricate; absence of an article does NOT mean the hazard score should be 0):
{research if research else f"No live news retrieved. Score every hazard from your own verified knowledge of {location} geography, FEMA/NOAA/USGS records, and published building-code history. Empty research is normal for many cities — it does NOT mean the hazards do not exist."}

RULES
  1. Recent events and code-update citations must be grounded in the research above OR in verifiable published data for this exact location. Never invent a specific event, date, or code update.
  2. "recent_events" should be events from approximately the past 24 months that the research supports. Leave the array empty if nothing verifiable was retrieved — this is fine.
  3. **MANDATORY: every hazard MUST receive a 0–10 score based on the location's well-established climate and geological profile**, regardless of what the research returned. Empty research does NOT mean score 0. Use the geography baselines below as your starting point and adjust up/down based on any recent events the research surfaced:
       - Pennsylvania / Ohio / Northeast → winter storms 6-8, hail 4-5, wind 4-6, tornado 2-4
       - Texas / Oklahoma / Kansas / Nebraska → tornado 7-9, hail 6-8, wind 6-8, hurricane 0-7 (coast vs inland)
       - Florida / Gulf Coast / Carolina coast → hurricane 7-10, flood 6-9, wind 7-9, hail 4-6
       - California / Pacific Northwest → earthquake 5-9, wildfire 5-9, winter 2-5
       - Arizona / New Mexico / Nevada → wildfire 4-7, earthquake 1-3, flood 2-4 (flash flood risk)
       - Mountain West / Rockies → winter 7-9, wildfire 5-7, hail 4-6
       - Midwest (IL, IN, MI, WI) → tornado 5-7, winter 6-8, wind 5-7, hail 5-7
     Use 0 ONLY when a hazard is genuinely not applicable (e.g., hurricane in landlocked Kansas = 0; tornado in coastal Maine should still be 1-2, not 0).
     **A response with all 8 hazards at score 0 will be treated as broken and rejected.**
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

    # Retry once with a JSON-only reminder if parse failed entirely
    if not result:
        logger.info(
            "risk_score: first parse failed — retrying with JSON-only reminder. raw[:300]=%r",
            (text or "")[:300],
        )
        retry_prompt = (
            "Your previous response was not valid JSON. Re-emit ONLY the JSON object "
            "described below — no markdown fences, no prose, no apology, nothing before "
            "the opening '{' or after the closing '}'.\n\n" + prompt
        )
        try:
            text = await llm_text(retry_prompt, max_tokens=2000)
            result = _parse_risk_json(text)
        except Exception:
            logger.warning("risk_score: JSON-only retry failed", exc_info=True)

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

    def _coerce_score(v) -> int:
        """Accept ints, floats, stringified numbers ('7', '7.5', '7/10'), and
        common qualitative terms ('high', 'medium', 'low'). Clamps to 0..10.
        Returns 0 only for genuinely empty / unparseable input."""
        if isinstance(v, bool):  # bool is a subclass of int — exclude it
            return 0
        if isinstance(v, (int, float)):
            return max(0, min(10, int(round(v))))
        if isinstance(v, str):
            s = v.strip().lower()
            if not s:
                return 0
            # Strip "/10" or "/ 10" suffix
            s = re.sub(r"\s*/\s*10\s*$", "", s)
            try:
                return max(0, min(10, int(round(float(s)))))
            except ValueError:
                pass
            # Qualitative terms — map to typical numeric values
            qual_map = {
                "extreme": 10, "very high": 9, "severe": 9,
                "high": 8, "elevated": 7,
                "moderate": 5, "medium": 5, "average": 5,
                "low": 2, "minimal": 1, "very low": 1,
                "none": 0, "n/a": 0, "not applicable": 0,
                "unknown": 0,
            }
            return qual_map.get(s, 0)
        return 0

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
            "score":     _coerce_score(existing.get("score")),
            "rationale": existing.get("rationale") or "",
        })
    result["hazards"] = full_hazards

    # If every hazard came back at 0, the model bailed out (sparse research, hedging,
    # or it ignored rule 3). Re-prompt asking for geography-only scoring as a safety
    # net so the graph never silently renders all zeros.
    if all(h["score"] == 0 for h in full_hazards):
        logger.info("risk_score: all-zero hazards — issuing geography-only fallback prompt")
        # IMPORTANT: example scores below are PLACEHOLDER illustrative numbers,
        # not zeros — the previous version had every example scored 0 and the
        # LLM literally copied the example shape, producing another all-zero
        # response. Mixed example values force the model to actually think
        # about each hazard.
        fallback_prompt = f"""You returned all zeros for every natural-disaster hazard in {location}. That is WRONG — every US location has SOME measurable exposure to most hazards. Do NOT copy the example numbers below; replace each with your real assessment for {location}.

Score these 8 hazards 0-10 based ONLY on your verified knowledge of {location}'s geography, climate, and geology. Empty news research is fine — score from base rates.

Format example (DO NOT copy these numbers — produce your own):
{{
  "hazards": [
    {{"key": "hail",       "label": "Hail",                          "score": 5, "rationale": "1 sentence on local hail exposure"}},
    {{"key": "wind",       "label": "Wind / Severe Thunderstorm",    "score": 6, "rationale": "1 sentence"}},
    {{"key": "tornado",    "label": "Tornado",                       "score": 4, "rationale": "1 sentence"}},
    {{"key": "hurricane",  "label": "Hurricane / Tropical Storm",    "score": 3, "rationale": "1 sentence"}},
    {{"key": "flood",      "label": "Flood / Storm Surge",           "score": 5, "rationale": "1 sentence"}},
    {{"key": "wildfire",   "label": "Wildfire",                      "score": 2, "rationale": "1 sentence"}},
    {{"key": "earthquake", "label": "Earthquake",                    "score": 1, "rationale": "1 sentence"}},
    {{"key": "winter",     "label": "Winter Storm / Ice",            "score": 7, "rationale": "1 sentence"}}
  ]
}}

Use 0 ONLY for genuinely-not-applicable hazards (hurricane in landlocked Kansas = 0; tornado in coastal Maine should be 1-2 not 0). All other hazards must be at least 1."""
        try:
            fb_text = await llm_text(fallback_prompt, max_tokens=900)
            fb_result = _parse_risk_json(fb_text)
            fb_hazards_by_key = {
                h.get("key"): h
                for h in (fb_result.get("hazards") or [])
                if isinstance(h, dict) and h.get("key")
            }
            rebuilt = []
            for key, label in CANONICAL_HAZARDS:
                fb = fb_hazards_by_key.get(key) or {}
                rebuilt.append({
                    "key":       key,
                    "label":     fb.get("label") or label,
                    "score":     _coerce_score(fb.get("score")),
                    "rationale": fb.get("rationale") or "",
                })
            # Only adopt the rebuilt scores if the fallback produced at least one non-zero
            if any(h["score"] > 0 for h in rebuilt):
                full_hazards = rebuilt
                result["hazards"] = full_hazards
        except Exception:
            logger.warning("risk_score: geography fallback prompt failed", exc_info=True)

    # ABSOLUTE LAST RESORT: if both LLM passes still produce all zeros (model
    # is rate-limited, hedging, or completely refusing), use a static
    # state-level baseline so the graph never silently renders zeros.
    # Better to show approximate-but-reasonable than a flat-zero chart.
    if all(h["score"] == 0 for h in full_hazards):
        logger.warning(
            "risk_score: LLM still produced all zeros after fallback — using static state baseline for %s",
            state,
        )
        baseline = _state_baseline_hazards(state)
        full_hazards = []
        for key, label in CANONICAL_HAZARDS:
            full_hazards.append({
                "key":       key,
                "label":     label,
                "score":     baseline.get(key, 3),
                "rationale": f"State-level baseline estimate for {state} — verify against local conditions.",
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
# State-level hazard baseline (last-resort defense vs all-zero LLM output)
# ---------------------------------------------------------------------------
#
# Approximate per-state hazard scores, calibrated against FEMA NRI and
# NOAA storm-events climatology. Used ONLY when both LLM attempts
# (primary + geography fallback) refuse to produce scores. Better to show
# a reasonable approximation than a flat-zero chart that misleads contractors.
#
# Score keys: hail / wind / tornado / hurricane / flood / wildfire / earthquake / winter

_STATE_HAZARD_BASELINE: dict[str, dict[str, int]] = {
    # Gulf / South Atlantic — high hurricane + flood
    "FL": {"hail": 4, "wind": 7, "tornado": 5, "hurricane": 9, "flood": 8, "wildfire": 4, "earthquake": 1, "winter": 1},
    "TX": {"hail": 7, "wind": 7, "tornado": 8, "hurricane": 6, "flood": 6, "wildfire": 5, "earthquake": 2, "winter": 3},
    "LA": {"hail": 5, "wind": 7, "tornado": 6, "hurricane": 9, "flood": 9, "wildfire": 2, "earthquake": 1, "winter": 2},
    "MS": {"hail": 6, "wind": 7, "tornado": 8, "hurricane": 7, "flood": 7, "wildfire": 3, "earthquake": 2, "winter": 3},
    "AL": {"hail": 6, "wind": 7, "tornado": 8, "hurricane": 6, "flood": 6, "wildfire": 3, "earthquake": 2, "winter": 3},
    "GA": {"hail": 5, "wind": 6, "tornado": 6, "hurricane": 6, "flood": 6, "wildfire": 4, "earthquake": 2, "winter": 3},
    "SC": {"hail": 5, "wind": 6, "tornado": 5, "hurricane": 7, "flood": 7, "wildfire": 4, "earthquake": 3, "winter": 3},
    "NC": {"hail": 5, "wind": 6, "tornado": 5, "hurricane": 7, "flood": 7, "wildfire": 3, "earthquake": 2, "winter": 4},
    "VA": {"hail": 5, "wind": 5, "tornado": 4, "hurricane": 6, "flood": 6, "wildfire": 3, "earthquake": 3, "winter": 5},
    # Tornado Alley — heavy hail/wind/tornado, no hurricane
    "OK": {"hail": 8, "wind": 8, "tornado": 9, "hurricane": 0, "flood": 5, "wildfire": 5, "earthquake": 4, "winter": 5},
    "KS": {"hail": 8, "wind": 7, "tornado": 9, "hurricane": 0, "flood": 4, "wildfire": 4, "earthquake": 2, "winter": 6},
    "NE": {"hail": 8, "wind": 7, "tornado": 7, "hurricane": 0, "flood": 4, "wildfire": 3, "earthquake": 1, "winter": 7},
    "AR": {"hail": 6, "wind": 7, "tornado": 8, "hurricane": 1, "flood": 6, "wildfire": 3, "earthquake": 4, "winter": 4},
    "MO": {"hail": 7, "wind": 6, "tornado": 7, "hurricane": 0, "flood": 5, "wildfire": 3, "earthquake": 5, "winter": 5},
    # Midwest
    "IL": {"hail": 6, "wind": 6, "tornado": 7, "hurricane": 0, "flood": 5, "wildfire": 1, "earthquake": 3, "winter": 7},
    "IN": {"hail": 6, "wind": 6, "tornado": 6, "hurricane": 0, "flood": 5, "wildfire": 1, "earthquake": 2, "winter": 7},
    "OH": {"hail": 5, "wind": 5, "tornado": 5, "hurricane": 0, "flood": 5, "wildfire": 1, "earthquake": 2, "winter": 7},
    "MI": {"hail": 4, "wind": 5, "tornado": 4, "hurricane": 0, "flood": 4, "wildfire": 2, "earthquake": 1, "winter": 8},
    "WI": {"hail": 5, "wind": 5, "tornado": 5, "hurricane": 0, "flood": 4, "wildfire": 2, "earthquake": 1, "winter": 8},
    "MN": {"hail": 6, "wind": 5, "tornado": 6, "hurricane": 0, "flood": 4, "wildfire": 3, "earthquake": 1, "winter": 9},
    "IA": {"hail": 7, "wind": 6, "tornado": 7, "hurricane": 0, "flood": 5, "wildfire": 1, "earthquake": 1, "winter": 7},
    "ND": {"hail": 6, "wind": 6, "tornado": 5, "hurricane": 0, "flood": 4, "wildfire": 2, "earthquake": 1, "winter": 9},
    "SD": {"hail": 7, "wind": 6, "tornado": 6, "hurricane": 0, "flood": 4, "wildfire": 3, "earthquake": 1, "winter": 9},
    # Northeast — winter dominant
    "PA": {"hail": 4, "wind": 5, "tornado": 3, "hurricane": 3, "flood": 5, "wildfire": 1, "earthquake": 2, "winter": 7},
    "NY": {"hail": 4, "wind": 5, "tornado": 3, "hurricane": 4, "flood": 5, "wildfire": 1, "earthquake": 2, "winter": 8},
    "NJ": {"hail": 4, "wind": 5, "tornado": 3, "hurricane": 6, "flood": 6, "wildfire": 2, "earthquake": 2, "winter": 6},
    "MA": {"hail": 3, "wind": 5, "tornado": 2, "hurricane": 5, "flood": 5, "wildfire": 1, "earthquake": 2, "winter": 8},
    "CT": {"hail": 3, "wind": 5, "tornado": 2, "hurricane": 5, "flood": 5, "wildfire": 1, "earthquake": 2, "winter": 7},
    "RI": {"hail": 3, "wind": 5, "tornado": 2, "hurricane": 6, "flood": 5, "wildfire": 1, "earthquake": 2, "winter": 7},
    "VT": {"hail": 3, "wind": 4, "tornado": 2, "hurricane": 3, "flood": 5, "wildfire": 1, "earthquake": 2, "winter": 9},
    "NH": {"hail": 3, "wind": 4, "tornado": 2, "hurricane": 3, "flood": 5, "wildfire": 1, "earthquake": 2, "winter": 9},
    "ME": {"hail": 3, "wind": 4, "tornado": 1, "hurricane": 3, "flood": 4, "wildfire": 2, "earthquake": 2, "winter": 9},
    "MD": {"hail": 4, "wind": 5, "tornado": 3, "hurricane": 5, "flood": 6, "wildfire": 1, "earthquake": 2, "winter": 5},
    "DE": {"hail": 4, "wind": 5, "tornado": 2, "hurricane": 6, "flood": 6, "wildfire": 1, "earthquake": 2, "winter": 4},
    "DC": {"hail": 3, "wind": 5, "tornado": 2, "hurricane": 4, "flood": 5, "wildfire": 1, "earthquake": 2, "winter": 4},
    "WV": {"hail": 4, "wind": 4, "tornado": 3, "hurricane": 2, "flood": 6, "wildfire": 2, "earthquake": 2, "winter": 7},
    "KY": {"hail": 6, "wind": 6, "tornado": 6, "hurricane": 0, "flood": 6, "wildfire": 2, "earthquake": 4, "winter": 5},
    "TN": {"hail": 6, "wind": 6, "tornado": 7, "hurricane": 0, "flood": 6, "wildfire": 3, "earthquake": 4, "winter": 4},
    # West — earthquake / wildfire dominant
    "CA": {"hail": 1, "wind": 4, "tornado": 1, "hurricane": 0, "flood": 4, "wildfire": 9, "earthquake": 9, "winter": 3},
    "OR": {"hail": 2, "wind": 4, "tornado": 1, "hurricane": 0, "flood": 4, "wildfire": 7, "earthquake": 6, "winter": 5},
    "WA": {"hail": 2, "wind": 5, "tornado": 1, "hurricane": 0, "flood": 5, "wildfire": 6, "earthquake": 8, "winter": 6},
    "NV": {"hail": 2, "wind": 4, "tornado": 1, "hurricane": 0, "flood": 3, "wildfire": 7, "earthquake": 6, "winter": 4},
    "AZ": {"hail": 3, "wind": 5, "tornado": 2, "hurricane": 0, "flood": 4, "wildfire": 6, "earthquake": 2, "winter": 2},
    "NM": {"hail": 5, "wind": 6, "tornado": 3, "hurricane": 0, "flood": 4, "wildfire": 6, "earthquake": 3, "winter": 4},
    "UT": {"hail": 3, "wind": 5, "tornado": 2, "hurricane": 0, "flood": 3, "wildfire": 6, "earthquake": 5, "winter": 7},
    "CO": {"hail": 8, "wind": 6, "tornado": 5, "hurricane": 0, "flood": 4, "wildfire": 6, "earthquake": 3, "winter": 8},
    "WY": {"hail": 6, "wind": 7, "tornado": 4, "hurricane": 0, "flood": 3, "wildfire": 6, "earthquake": 3, "winter": 9},
    "MT": {"hail": 5, "wind": 6, "tornado": 3, "hurricane": 0, "flood": 4, "wildfire": 7, "earthquake": 4, "winter": 9},
    "ID": {"hail": 4, "wind": 5, "tornado": 2, "hurricane": 0, "flood": 4, "wildfire": 7, "earthquake": 5, "winter": 8},
    "AK": {"hail": 1, "wind": 6, "tornado": 0, "hurricane": 0, "flood": 5, "wildfire": 5, "earthquake": 9, "winter": 9},
    "HI": {"hail": 0, "wind": 6, "tornado": 1, "hurricane": 7, "flood": 6, "wildfire": 4, "earthquake": 6, "winter": 0},
}

# Default for any state not in the table — neutral mid-range so the graph
# isn't blank but also doesn't overstate exposure.
_DEFAULT_BASELINE = {"hail": 4, "wind": 4, "tornado": 3, "hurricane": 2, "flood": 4, "wildfire": 3, "earthquake": 2, "winter": 4}


def _state_baseline_hazards(state: str) -> dict[str, int]:
    """Return an approximate hazard score map for the given two-letter state."""
    code = (state or "").strip().upper()
    return _STATE_HAZARD_BASELINE.get(code, _DEFAULT_BASELINE)


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
