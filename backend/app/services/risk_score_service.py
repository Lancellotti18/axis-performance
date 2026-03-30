"""
Storm risk score service.
Uses Tavily to pull hail, wind, and weather event data for a location,
then uses Claude to generate a structured risk assessment.
"""
import re
import json
import anthropic
from app.core.config import settings


async def get_risk_score(city: str, state: str, zip_code: str = "") -> dict:
    """
    Generate a storm/hail/wind risk score for a given location.
    Returns scores 1-10 with event history and contractor recommendations.
    """
    location = f"{city}, {state}" + (f" {zip_code}" if zip_code else "")
    research = ""

    if settings.TAVILY_API_KEY:
        from tavily import TavilyClient
        tavily = TavilyClient(api_key=settings.TAVILY_API_KEY)
        queries = [
            f"{location} hail storm damage history frequency annual",
            f"{state} {city} tornado wind damage risk severe weather",
            f"{zip_code or city} {state} insurance hail claims roof damage",
        ]
        snippets = []
        for q in queries:
            try:
                r = tavily.search(query=q, search_depth="basic", max_results=3, include_answer=True)
                if r.get("answer"):
                    snippets.append(r["answer"])
                for item in r.get("results", []):
                    c = item.get("content", "")[:400]
                    if c:
                        snippets.append(c)
            except Exception:
                continue
        research = "\n\n".join(snippets[:8])

    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

    prompt = f"""You are a certified property risk analyst with expertise in storm damage assessment.
Analyze the storm and weather risk for contractors working in: {location}

RESEARCH DATA:
{research if research else f"No live data retrieved. Use your expert knowledge of {state} storm patterns, NOAA historical data, and insurance industry data for {location}."}

Return ONLY valid JSON — no text before or after:
{{
  "overall_risk": 6,
  "hail_risk": 7,
  "wind_risk": 5,
  "flood_risk": 3,
  "risk_label": "Elevated",
  "risk_color": "amber",
  "summary": "Two to three sentence expert summary of storm risk profile for this location, mentioning specific climate patterns.",
  "recent_events": [
    {{"year": 2023, "type": "Hail", "severity": "Large hail 1.75 inch diameter", "impact": "Significant roof damage across metro area"}},
    {{"year": 2022, "type": "Wind", "severity": "Straight-line winds 68 mph", "impact": "Tree damage, shingle loss reported"}}
  ],
  "recommendation": "One specific, actionable sentence for roofing contractors in this market.",
  "insurance_note": "One sentence about insurance claim volume or rates in this area.",
  "data_source": "Tavily research + NOAA historical data"
}}

Scoring guide (1-10):
- 1-3: Low — minimal storm activity, standard construction practices sufficient
- 4-5: Moderate — occasional events, recommend impact-resistant upgrades
- 6-7: Elevated — frequent hail/wind, impact-resistant materials strongly advised
- 8-9: High — severe weather corridor, premium storm products required
- 10: Extreme — tornado alley epicenter or coastal hurricane zone

risk_color: "emerald" for 1-3, "amber" for 4-7, "red" for 8-10
recent_events: up to 4 real notable events from the past 5 years (empty array if none documented)
Base ALL scores on actual {state}/{city} geography, NOAA storm data, and insurance industry knowledge."""

    message = client.messages.create(
        model="claude-opus-4-6",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}]
    )

    text = message.content[0].text.strip()
    text = re.sub(r'^```(?:json)?\s*', '', text, count=1)
    text = re.sub(r'\s*```\s*$', '', text)
    start = text.find("{")
    if start > 0:
        text = text[start:]
    return json.loads(text)
