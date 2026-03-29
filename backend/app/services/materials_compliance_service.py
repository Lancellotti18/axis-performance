"""
Materials compliance cross-check service.
Fetches local building codes via Tavily, then uses Claude to evaluate
each material category against applicable rules. Returns exact rule
quotes, violation reasons, and fix suggestions.
"""
import json
import anthropic
from app.core.config import settings

_client = None

def get_claude():
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
    return _client


async def fetch_local_codes(city: str, state: str, project_type: str) -> str:
    """Search Tavily for local building code requirements."""
    if not settings.TAVILY_API_KEY:
        return ""
    try:
        from tavily import TavilyClient
        client = TavilyClient(api_key=settings.TAVILY_API_KEY)

        queries = [
            f"{city} {state} building code {project_type} material requirements",
            f"{state} IRC amendments {project_type} approved materials 2021",
            f"{city} {state} local building ordinance {project_type} construction standards",
        ]

        all_results = []
        for q in queries[:2]:  # Limit to 2 searches to avoid rate limits
            results = client.search(
                query=q,
                search_depth="advanced",
                max_results=4,
                include_answer=True,
            )
            if results.get("answer"):
                all_results.append(f"SUMMARY: {results['answer']}\n")
            for r in results.get("results", []):
                all_results.append(
                    f"SOURCE: {r.get('url', '')}\n"
                    f"TITLE: {r.get('title', '')}\n"
                    f"CONTENT: {r.get('content', '')[:600]}\n"
                )

        return "\n---\n".join(all_results)
    except Exception as e:
        return f"(Code search unavailable: {e})"


async def check_materials_compliance(
    materials: list[dict],
    city: str,
    state: str,
    project_type: str,
) -> dict:
    """
    Cross-reference a materials list against local building codes.

    Returns:
      {
        overall_status: 'pass' | 'fail' | 'warning',
        summary: str,
        compliant_items: [...],
        violations: [{ item_name, category, violation_type, rule_text, violation_reason, fix_suggestion }],
        missing_required_items: [{ item_name, rule_text, reason_required }],
        location: { city, state },
        project_type: str,
      }
    """
    code_context = await fetch_local_codes(city, state, project_type)

    materials_text = "\n".join([
        f"  • {m.get('item_name', 'Unknown')} "
        f"[category: {m.get('category', 'general')}] "
        f"qty: {m.get('quantity', 0)} {m.get('unit', 'each')} "
        f"@ ${m.get('unit_cost', 0):.2f}/unit"
        for m in materials
    ]) if materials else "  (no materials in list)"

    prompt = f"""You are a certified building code compliance expert reviewing a contractor's materials list for a {project_type} project in {city}, {state}.

MATERIALS LIST UNDER REVIEW:
{materials_text}

LOCAL BUILDING CODE RESEARCH:
{code_context if code_context else "No specific local amendments found — apply standard IRC 2021 / IBC requirements and any well-known {state} state amendments."}

YOUR TASK:
1. Review EACH material category (lumber, drywall, roofing, insulation, electrical, plumbing, concrete, etc.)
2. Cross-reference against IRC 2021, IBC, {state} state amendments, and {city} local ordinances
3. Flag anything that does NOT meet code, is missing entirely, or has a specification issue
4. For roofing: check fire rating, wind rating (especially for coastal/high-wind areas), ice & water shield requirements
5. For lumber: check grade requirements, treatment (especially for ground contact), span tables
6. For insulation: check R-value minimums by climate zone
7. For electrical/plumbing: check material type approvals

Return ONLY valid JSON (no markdown, no explanation outside the JSON):

{{
  "overall_status": "pass",
  "summary": "<2–4 sentence summary of compliance status, highlighting biggest risks>",
  "compliant_items": [
    {{
      "item_name": "<material name>",
      "category": "<category>",
      "note": "<why this is compliant>",
      "code_reference": "<e.g. IRC Section R802.4>"
    }}
  ],
  "violations": [
    {{
      "item_name": "<material name or category>",
      "category": "<category>",
      "violation_type": "<missing | spec_mismatch | not_approved | quantity_issue | rating_issue>",
      "rule_text": "<EXACT quote of the applicable code section — must be specific, not paraphrased>",
      "violation_reason": "<clear explanation of why this fails or is flagged>",
      "fix_suggestion": "<specific, actionable fix the contractor should implement>"
    }}
  ],
  "missing_required_items": [
    {{
      "item_name": "<required item not in the list>",
      "rule_text": "<exact code requiring this item>",
      "reason_required": "<why it is required for this project type and location>"
    }}
  ]
}}

RULES FOR YOUR RESPONSE:
- overall_status: "pass" if no violations, "warning" if minor issues, "fail" if serious code violations exist
- ALWAYS provide exact code section citations (e.g. "IRC Section R905.2.4.1", "IBC Section 1507.2.9")
- If a specific local code is unknown, cite the applicable IRC/IBC section and note "{state} may have amendments"
- Do NOT fabricate specific local ordinance numbers you cannot confirm — cite IRC/IBC instead
- Be strict: a contractor submitting a permit with these materials would face these issues
- Consider the climate zone for {city}, {state} when evaluating insulation R-values and ice/water shield requirements"""

    client = get_claude()
    message = client.messages.create(
        model="claude-opus-4-6",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )

    text = message.content[0].text.strip()
    # Strip markdown fences if present
    if "```" in text:
        parts = text.split("```")
        for part in parts:
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            try:
                result = json.loads(part)
                result["location"] = {"city": city, "state": state}
                result["project_type"] = project_type
                return result
            except Exception:
                continue

    result = json.loads(text)
    result["location"] = {"city": city, "state": state}
    result["project_type"] = project_type
    return result
