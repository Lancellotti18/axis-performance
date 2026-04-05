"""
Storm risk score service.
Uses web search to pull real hail/wind/weather event data for a location,
then uses LLM to generate a structured risk assessment grounded in that data.
"""
import re
import json
import asyncio
from app.services.llm import llm_text
from app.services.search import web_search_multi


async def get_risk_score(city: str, state: str, zip_code: str = "") -> dict:
    """
    Generate a storm/hail/wind risk score for a given location.
    Returns scores 1-10 with event history and contractor recommendations.
    """
    location = f"{city}, {state}" + (f" {zip_code}" if zip_code else "")

    # Search for real weather event data — multiple angles for accuracy
    research = await web_search_multi([
        f"{city} {state} hail storm damage history frequency annual NOAA",
        f"{state} {city} tornado wind damage risk severe weather history",
        f"{zip_code or city} {state} insurance hail claims roof damage reports",
    ], max_results=4)

    prompt = f"""You are a certified property risk analyst with expertise in storm damage assessment.
Analyze the storm and weather risk for contractors working in: {location}

RESEARCH DATA (use this to ground your analysis — do not fabricate events that aren't supported):
{research if research else f"No live data retrieved. Use NOAA historical data, FEMA risk maps, and insurance industry knowledge for {location}. Only cite events you have genuine knowledge of."}

IMPORTANT: Base ALL risk scores on verified facts. If research shows specific hail events or wind damage, cite them directly.
For "recent_events", only include events that are genuinely documented for this area — leave the array empty rather than inventing events.

Return ONLY valid JSON — no text before or after:
{{
  "overall_risk": 6,
  "hail_risk": 7,
  "wind_risk": 5,
  "flood_risk": 3,
  "risk_label": "Elevated",
  "risk_color": "amber",
  "summary": "Two to three sentence expert summary of storm risk profile for this location, mentioning specific climate patterns and geography.",
  "scoring_rationale": "Two to three sentences explaining exactly WHY this score was assigned — cite specific data points, geography, historical frequency, or climate patterns.",
  "significance": "One to two sentences explaining what this risk level means practically for a roofing contractor — material choices, pricing, business opportunity.",
  "recent_events": [
    {{"year": 2023, "type": "Hail", "severity": "Large hail 1.75 inch diameter", "impact": "Significant roof damage across metro area"}},
    {{"year": 2022, "type": "Wind", "severity": "Straight-line winds 68 mph", "impact": "Tree damage, shingle loss reported"}}
  ],
  "recommendation": "One specific, actionable sentence for roofing contractors in this market.",
  "insurance_note": "One sentence about insurance claim volume or rates in this area based on available data.",
  "data_source": "NOAA / NWS historical records + web research"
}}

Scoring guide (1-10):
- 1-3: Low — minimal storm activity, standard construction practices sufficient
- 4-5: Moderate — occasional events, recommend impact-resistant upgrades
- 6-7: Elevated — frequent hail/wind, impact-resistant materials strongly advised
- 8-9: High — severe weather corridor, premium storm products required
- 10: Extreme — tornado alley epicenter or coastal hurricane zone

risk_color: "emerald" for 1-3, "amber" for 4-7, "red" for 8-10
recent_events: up to 4 real notable events from the past 5 years ONLY if documented — empty array if not found
Base ALL scores on actual {state}/{city} geography and verified NOAA/NWS storm patterns."""

    text = await llm_text(prompt, max_tokens=1200)
    text = re.sub(r'^```(?:json)?\s*', '', text, count=1)
    text = re.sub(r'\s*```\s*$', '', text)
    start = text.find("{")
    if start > 0:
        text = text[start:]
    return json.loads(text)
