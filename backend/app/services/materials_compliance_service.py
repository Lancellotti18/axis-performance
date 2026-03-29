"""
Materials compliance cross-check service.
Fetches local building codes (state + city + county) via Tavily, then uses Claude
to evaluate EVERY material against those rules and return a per-item checklist
with pass/fail, exact rule quote, and fix suggestion for each failure.
"""
import json
import re
import anthropic
from app.core.config import settings

_client = None

def get_claude():
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
    return _client


async def fetch_local_codes(city: str, state: str, project_type: str, county: str = "") -> str:
    """Search Tavily for building code requirements at state, county, and city level."""
    if not settings.TAVILY_API_KEY:
        return ""
    try:
        from tavily import TavilyClient
        client = TavilyClient(api_key=settings.TAVILY_API_KEY)

        location_parts = [p for p in [city, county, state] if p]
        location_str = ", ".join(location_parts)

        queries = [
            f"{location_str} residential building code material requirements {project_type} 2024",
            f"{state} state building code {project_type} approved materials IRC amendments",
        ]
        if county:
            queries.append(f"{county} county {state} building ordinance {project_type} materials")

        all_results = []
        for q in queries[:2]:
            try:
                results = client.search(
                    query=q,
                    search_depth="basic",
                    max_results=3,
                    include_answer=True,
                )
                if results.get("answer"):
                    all_results.append(f"SUMMARY: {results['answer']}\n")
                for r in results.get("results", []):
                    all_results.append(
                        f"SOURCE: {r.get('url', '')}\n"
                        f"TITLE: {r.get('title', '')}\n"
                        f"CONTENT: {r.get('content', '')[:500]}\n"
                    )
            except Exception:
                continue

        return "\n---\n".join(all_results)
    except Exception as e:
        return f"(Code search unavailable: {e})"


def _parse_json_from_claude(text: str) -> dict:
    """Robustly extract JSON from Claude's response regardless of formatting."""
    text = text.strip()

    # Remove opening markdown fence if present
    if text.startswith("```"):
        # Strip the opening fence line
        text = re.sub(r'^```(?:json)?\s*', '', text, count=1)
        # Strip closing fence if present
        text = re.sub(r'\s*```\s*$', '', text)
        text = text.strip()

    # Try direct parse first
    start = text.find("{")
    if start != -1:
        candidate = text[start:]
        # Try full string
        try:
            return json.loads(candidate)
        except Exception:
            pass
        # Response was truncated — find the last complete top-level key
        # by scanning backwards for the deepest valid closing brace
        end = len(candidate)
        while end > 0:
            end = candidate.rfind("}", 0, end)
            if end == -1:
                break
            try:
                return json.loads(candidate[:end + 1])
            except Exception:
                end -= 1

    raise ValueError(f"Could not parse JSON from Claude response. First 200 chars: {text[:200]}")


async def check_materials_compliance(
    materials: list,
    city: str,
    state: str,
    project_type: str,
    county: str = "",
) -> dict:
    """
    Cross-reference every material against local building codes.

    Returns a per-item checklist:
    {
      overall_status: 'pass' | 'fail' | 'warning',
      summary: str,
      location: { city, state, county },
      project_type: str,
      checklist: [
        {
          item_name, category, status: 'pass'|'fail'|'warning',
          note, code_reference,               # on pass
          rule_text, violation_reason, fix_suggestion  # on fail/warning
        }
      ],
      missing_required_items: [
        { item_name, rule_text, reason_required }
      ]
    }
    """
    code_context = await fetch_local_codes(city, state, project_type, county)

    location_parts = [p for p in [city, county, state] if p]
    location_str = ", ".join(location_parts)

    materials_text = "\n".join([
        f"  {i+1}. {m.get('item_name', 'Unknown')} "
        f"[{m.get('category', 'general')}] "
        f"qty: {m.get('quantity', 0)} {m.get('unit', 'each')}"
        for i, m in enumerate(materials)
    ]) if materials else "  (no materials provided)"

    prompt = f"""You are a certified building code compliance expert reviewing a {project_type} project in {location_str}.

MATERIALS LIST:
{materials_text}

LOCAL BUILDING CODE RESEARCH:
{code_context if code_context else f"No specific local code data found. Apply IRC 2021 / IBC standards and known {state} state amendments."}

YOUR TASK:
Review EVERY material in the list against:
- IRC 2021 / IBC (base code)
- {state} state building code amendments
- {f"{county} county ordinances" if county else ""}
- {city} local ordinances

For EACH material, determine if it passes or fails code requirements.
Also identify any required materials that are MISSING from the list entirely.

Return ONLY this JSON (no markdown, no text outside the JSON):

{{
  "overall_status": "pass",
  "summary": "2-4 sentence overview of compliance status for {location_str}. Highlight the most critical issues.",
  "checklist": [
    {{
      "item_name": "exact name from the list",
      "category": "category",
      "status": "pass",
      "note": "why this meets code",
      "code_reference": "IRC Section R802.4.1"
    }},
    {{
      "item_name": "exact name from the list",
      "category": "category",
      "status": "fail",
      "rule_text": "EXACT quote from the applicable code section — must be verbatim or as close as possible, e.g. 'IRC Section R905.2.4.1: Asphalt shingles shall comply with ASTM D3161...'",
      "violation_reason": "Specific reason why this material fails or is flagged",
      "fix_suggestion": "Exact actionable fix the contractor must implement"
    }}
  ],
  "missing_required_items": [
    {{
      "item_name": "required item not in the list",
      "rule_text": "exact code section requiring it",
      "reason_required": "why it is required for {project_type} in {location_str}"
    }}
  ]
}}

RULES:
- overall_status: "pass" = no failures, "warning" = minor issues only, "fail" = one or more serious violations
- Every material in the list MUST appear in the checklist — no skipping
- status must be exactly "pass", "fail", or "warning"
- For pass items: provide a short note and the relevant code section
- For fail/warning items: provide the EXACT rule text quoted, the reason, and a specific fix
- For missing items: only flag things genuinely required by code for this project type and location
- Be strict but fair — apply the code as a building inspector would
- Consider {state} climate zone for insulation R-values, ice/water shield, wind ratings"""

    client = get_claude()
    message = client.messages.create(
        model="claude-opus-4-6",
        max_tokens=8192,
        messages=[{"role": "user", "content": prompt}],
    )

    text = message.content[0].text.strip()
    result = _parse_json_from_claude(text)

    result["location"] = {"city": city, "state": state, "county": county}
    result["project_type"] = project_type
    return result
