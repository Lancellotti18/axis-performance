import json
import logging
from app.core.config import settings
from app.services.llm import llm_text
from app.services.search import web_search

logger = logging.getLogger(__name__)

COMPLIANCE_PROMPT = """You are a construction law and contractor compliance expert for the United States.

A contractor is working on a {project_type} construction project in {location}.

{search_context}

Generate a comprehensive compliance checklist covering ALL of the following categories:
1. **Licensing** - What contractor licenses are required in this state/jurisdiction
2. **Permits** - What building permits are needed for this type of project
3. **Contract Requirements** - Legally required clauses, disclosures, or terms in contractor agreements
4. **Lien Laws** - Mechanics lien rules, notice deadlines, filing requirements
5. **Insurance & Bonding** - Minimum coverage requirements to operate legally
6. **Building Codes** - Relevant code standards (IBC, IRC, state amendments)
7. **Labor Laws** - Prevailing wage, worker classification, subcontractor rules

CRITICAL ACCURACY RULES — follow these without exception:
- Every item you return MUST be directly supported by the research results above.
- Quote the governing statute, code section, agency, or ordinance EXACTLY as it appears
  in the research (e.g. "Tex. Occ. Code §53.105" — NOT "Texas Contractor Law").
- If the research does not support a specific category or jurisdictional detail, OMIT
  that item rather than inventing one. A shorter accurate list beats a long fabricated one.
- If a number, deadline, or dollar threshold is not present in the research, leave the
  corresponding field as null. Do not guess.
- Set "verified": true only when the item is directly grounded in a specific snippet of
  the research; otherwise "verified": false.

Return ONLY a valid JSON object in this exact format:
{{
  "state": "{state_code}",
  "location": "{location}",
  "project_type": "{project_type}",
  "summary": "2-3 sentence overview of the most critical compliance requirements for this jurisdiction",
  "risk_level": "low",
  "items": [
    {{
      "id": "unique-slug",
      "category": "Licensing",
      "title": "Short title of requirement",
      "description": "Clear explanation of the requirement and why it matters",
      "severity": "required",
      "action": "Specific action the contractor must take to comply",
      "deadline": "Timing requirement if applicable, or null",
      "penalty": "Consequence of non-compliance if known, or null",
      "source": "Law name, code section, or agency — verbatim from the research",
      "verified": true
    }}
  ]
}}

The "risk_level" must be one of: "low", "medium", "high".
The "severity" for each item must be one of: "required", "recommended", "info".
Return as many items as are supported by the research (typically 10-25). Be specific to {location}."""


async def run_compliance_check(
    location: str,
    state_code: str,
    project_type: str,
    city: str | None = None,
) -> dict:
    """
    Use web search + LLM to generate a grounded compliance checklist
    for a given jurisdiction and project type.
    """
    location_str = f"{city}, {location}" if city else location

    import asyncio
    queries = [
        f"{location_str} contractor licensing requirements {project_type} construction 2025",
        f"{location_str} mechanics lien law contractor notice requirements",
        f"{location_str} contractor contract requirements {project_type} law",
        f"{state_code} contractor insurance bonding requirements building permits",
    ]

    search_results = await asyncio.gather(*[web_search(q, max_results=4) for q in queries])
    combined = "\n---\n".join(r for r in search_results if r)

    # Without live research the model tends to hallucinate plausible-sounding
    # IRC/IBC/state-code citations. Refuse to produce a fabricated checklist and
    # return an explicit unavailable state the UI can render as "research
    # required — please retry later or contact a licensed attorney".
    if not combined or len(combined.strip()) < 200:
        logger.warning(
            "compliance: insufficient research for %s / %s — returning unavailable",
            location_str, project_type,
        )
        return {
            "state": state_code,
            "location": location_str,
            "project_type": project_type,
            "summary": (
                "We could not verify live compliance data for this jurisdiction right now. "
                "Rather than guess, BuildAI is returning no items. Please retry shortly, "
                "or consult your state contractor board for authoritative requirements."
            ),
            "risk_level": "low",
            "research_unavailable": True,
            "items": [],
        }

    search_context = "## Live Research Results\n\n" + combined

    prompt = COMPLIANCE_PROMPT.format(
        location=location_str,
        state_code=state_code,
        project_type=project_type,
        search_context=search_context,
    )

    raw = await llm_text(prompt, max_tokens=4096)
    raw = raw.strip()

    # Strip markdown code fences if present
    if raw.startswith("```"):
        parts = raw.split("```")
        raw = parts[1] if len(parts) > 1 else raw
        if raw.startswith("json"):
            raw = raw[4:]
    raw = raw.strip()

    data = json.loads(raw)
    data.setdefault("research_unavailable", False)
    return data


def get_state_from_region_code(region_code: str) -> dict:
    """Map region codes like 'US-TX' to full state info."""
    mapping = {
        "US-AL": {"name": "Alabama", "code": "AL"},
        "US-AK": {"name": "Alaska", "code": "AK"},
        "US-AZ": {"name": "Arizona", "code": "AZ"},
        "US-AR": {"name": "Arkansas", "code": "AR"},
        "US-CA": {"name": "California", "code": "CA"},
        "US-CO": {"name": "Colorado", "code": "CO"},
        "US-CT": {"name": "Connecticut", "code": "CT"},
        "US-DE": {"name": "Delaware", "code": "DE"},
        "US-FL": {"name": "Florida", "code": "FL"},
        "US-GA": {"name": "Georgia", "code": "GA"},
        "US-HI": {"name": "Hawaii", "code": "HI"},
        "US-ID": {"name": "Idaho", "code": "ID"},
        "US-IL": {"name": "Illinois", "code": "IL"},
        "US-IN": {"name": "Indiana", "code": "IN"},
        "US-IA": {"name": "Iowa", "code": "IA"},
        "US-KS": {"name": "Kansas", "code": "KS"},
        "US-KY": {"name": "Kentucky", "code": "KY"},
        "US-LA": {"name": "Louisiana", "code": "LA"},
        "US-ME": {"name": "Maine", "code": "ME"},
        "US-MD": {"name": "Maryland", "code": "MD"},
        "US-MA": {"name": "Massachusetts", "code": "MA"},
        "US-MI": {"name": "Michigan", "code": "MI"},
        "US-MN": {"name": "Minnesota", "code": "MN"},
        "US-MS": {"name": "Mississippi", "code": "MS"},
        "US-MO": {"name": "Missouri", "code": "MO"},
        "US-MT": {"name": "Montana", "code": "MT"},
        "US-NE": {"name": "Nebraska", "code": "NE"},
        "US-NV": {"name": "Nevada", "code": "NV"},
        "US-NH": {"name": "New Hampshire", "code": "NH"},
        "US-NJ": {"name": "New Jersey", "code": "NJ"},
        "US-NM": {"name": "New Mexico", "code": "NM"},
        "US-NY": {"name": "New York", "code": "NY"},
        "US-NC": {"name": "North Carolina", "code": "NC"},
        "US-ND": {"name": "North Dakota", "code": "ND"},
        "US-OH": {"name": "Ohio", "code": "OH"},
        "US-OK": {"name": "Oklahoma", "code": "OK"},
        "US-OR": {"name": "Oregon", "code": "OR"},
        "US-PA": {"name": "Pennsylvania", "code": "PA"},
        "US-RI": {"name": "Rhode Island", "code": "RI"},
        "US-SC": {"name": "South Carolina", "code": "SC"},
        "US-SD": {"name": "South Dakota", "code": "SD"},
        "US-TN": {"name": "Tennessee", "code": "TN"},
        "US-TX": {"name": "Texas", "code": "TX"},
        "US-UT": {"name": "Utah", "code": "UT"},
        "US-VT": {"name": "Vermont", "code": "VT"},
        "US-VA": {"name": "Virginia", "code": "VA"},
        "US-WA": {"name": "Washington", "code": "WA"},
        "US-WV": {"name": "West Virginia", "code": "WV"},
        "US-WI": {"name": "Wisconsin", "code": "WI"},
        "US-WY": {"name": "Wyoming", "code": "WY"},
    }
    return mapping.get(region_code, {"name": region_code, "code": region_code})
