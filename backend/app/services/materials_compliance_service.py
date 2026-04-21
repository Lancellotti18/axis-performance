"""
Materials compliance cross-check.

Given a project's material list, check every item against the locally adopted
building / electrical / energy / mechanical / fire codes for the project's
jurisdiction, and flag:
  - items that violate an applicable code section
  - materials or details that are REQUIRED but missing from the list
  - items that need jurisdiction-specific attention (climate zone, wind zone)

Differences from the old service:
  - Parallel category-specific searches (roofing, insulation, electrical,
    plumbing, fenestration, structural, fire, egress), each domain-restricted
    to authoritative sources.
  - Jurisdiction profile feeds the LLM climate zone, wind posture, and the
    exact code cycles adopted (via app.services.jurisdiction).
  - Citation verification: every emitted rule_text / code_reference URL must
    appear in the research snippets. Unverifiable items keep their guidance
    but are flagged so the UI can show a "confirm with AHJ" chip.
  - 6-hour in-memory cache keyed by (jurisdiction, project_type, materials
    signature) so repeated clicks are free.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from typing import Optional

from app.services.jurisdiction import AUTHORITATIVE_DOMAINS, resolve_jurisdiction
from app.services.llm import llm_text

logger = logging.getLogger(__name__)


CACHE_TTL_SECONDS = 6 * 60 * 60
_cache: dict[str, tuple[float, dict]] = {}


# Category → query template. The jurisdiction profile is interpolated at
# call time so results are tight to the user's city/state, not generic.
CATEGORY_QUERIES: list[tuple[str, str]] = [
    ("roofing",      "{loc} {cc_building} {project_type} roofing asphalt shingle underlayment ice water shield section"),
    ("fenestration", "{loc} {cc_energy} windows doors U-factor SHGC climate zone {climate_zone} section"),
    ("insulation",   "{loc} {cc_energy} insulation R-value attic wall climate zone {climate_zone} requirement"),
    ("framing",      "{loc} {cc_residential} wood framing stud spacing header sizing Table R602"),
    ("electrical",   "{loc} {cc_electrical} NEC AFCI GFCI receptacle bathroom kitchen section"),
    ("plumbing",     "{loc} plumbing code IPC UPC pipe type venting trap arm section"),
    ("mechanical",   "{loc} mechanical code IMC HVAC ventilation rate whole house section"),
    ("fire",         "{loc} fire code smoke alarm carbon monoxide detector hardwired interconnected section"),
    ("egress",       "{loc} {cc_residential} emergency egress window bedroom opening size section R310"),
    ("wind_flood",   "{loc} wind-borne debris hurricane impact glazing nailing schedule {cc_building} section"),
]


async def _tavily_category(cat: str, query: str) -> dict:
    try:
        from app.core.config import settings
        if not settings.TAVILY_API_KEY:
            return {"category": cat, "results": [], "errored": True, "error": "no_tavily_key"}
        from tavily import TavilyClient
        client = TavilyClient(api_key=settings.TAVILY_API_KEY)

        def _run():
            return client.search(
                query=query,
                search_depth="advanced",
                max_results=4,
                include_domains=AUTHORITATIVE_DOMAINS,
                include_answer=False,
            )
        resp = await asyncio.to_thread(_run)
        rows = [
            {
                "title":   r.get("title") or "",
                "url":     r.get("url") or "",
                "content": (r.get("content") or "")[:700],
            }
            for r in (resp.get("results") or [])[:4]
        ]
        return {"category": cat, "results": rows, "errored": False}
    except Exception as e:
        logger.warning("tavily category '%s' failed: %s", cat, e)
        return {"category": cat, "results": [], "errored": True, "error": str(e)}


def _format_research(results: list[dict]) -> tuple[str, set[str]]:
    parts: list[str] = []
    urls: set[str] = set()
    for c in results:
        if not c.get("results"):
            continue
        parts.append(f"### Category: {c['category']}")
        for r in c["results"]:
            if r.get("url"):
                urls.add(r["url"])
            parts.append(f"- **{r.get('title','')}**\n  URL: {r.get('url','')}\n  {r.get('content','')}")
        parts.append("")
    return "\n".join(parts), urls


def _materials_signature(materials: list[dict]) -> str:
    key = "|".join(
        f"{(m.get('item_name') or '').lower()}:{m.get('quantity',0)}:{(m.get('unit') or '').lower()}"
        for m in sorted(materials, key=lambda m: (m.get("item_name") or "").lower())
    )
    return hashlib.sha1(key.encode()).hexdigest()[:16]


def _strip_json(text: str) -> str:
    text = text.strip()
    text = re.sub(r'^```(?:json)?\s*', '', text, count=1)
    text = re.sub(r'\s*```\s*$', '', text)
    start = text.find("{")
    if start == -1:
        raise ValueError(f"No JSON object found. First 200 chars: {text[:200]}")
    return text[start:]


def _parse_json(text: str) -> dict:
    """
    Robust parser that tolerates markdown fences, prose preambles/epilogues,
    trailing commas, Python-isms, and truncated responses.
    """
    if not text:
        raise ValueError("empty LLM response")

    cleaned = text.strip()
    cleaned = re.sub(r'^```(?:json)?\s*', '', cleaned, count=1)
    cleaned = re.sub(r'\s*```\s*$', '', cleaned)

    start = cleaned.find("{")
    if start < 0:
        raise ValueError(f"No JSON object found. First 200 chars: {cleaned[:200]}")

    # Find the largest balanced {...} block
    depth, end, in_str, escape = 0, -1, False, False
    for i in range(start, len(cleaned)):
        ch = cleaned[i]
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

    candidate = cleaned[start:end + 1] if end > 0 else cleaned[start:]

    candidate = re.sub(r",\s*([}\]])", r"\1", candidate)
    candidate = re.sub(r"\bNone\b", "null", candidate)
    candidate = re.sub(r"\bTrue\b", "true", candidate)
    candidate = re.sub(r"\bFalse\b", "false", candidate)
    candidate = re.sub(r":\s*unknown\b", ": null", candidate, flags=re.IGNORECASE)
    candidate = re.sub(r":\s*N/?A\b", ": null", candidate, flags=re.IGNORECASE)

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
        raise


def _verify(items: list[dict], allowed_urls: set[str]) -> list[dict]:
    """
    For each checklist item, verify its `code_reference_url` (if present) was
    in the research. Items whose URL was fabricated keep their content but
    get verified=false and the URL cleared so the UI doesn't link to a
    non-existent statute page.
    """
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        url = (it.get("code_reference_url") or "").strip()
        verified = bool(url and url in allowed_urls)
        if not verified:
            if url:
                it["code_reference_url"] = None
            it["verified"] = False
        else:
            it["verified"] = True
        out.append(it)
    return out


PROMPT = """You are a certified building-code compliance expert for the United States.

JURISDICTION PROFILE:
{jurisdiction_json}

CODE CYCLES:
{code_cycles}

MATERIALS LIST:
{materials_text}

RESEARCH (domain-restricted to .gov / municode.com / ecode360.com / iccsafe.org etc. — the ONLY citation source you may use):
{research}

TASK
Evaluate EVERY material against the adopted code for this jurisdiction, using the climate zone and wind posture above.
Also identify materials or details that are REQUIRED for this project type/jurisdiction but MISSING from the list.

GROUNDING RULES (strict):
 - Every `code_reference` MUST be a real, specific section (e.g. "IRC 2021 §R806.4", "IECC 2021 Table R402.1.2").
 - Every `code_reference_url` MUST be a URL that appears verbatim in the RESEARCH above. Never invent.
 - Include a short `rule_quote` (<25 words) of the actual statute text when the research contains it.
 - If climate zone affects this item (insulation R-value, window U-factor, ice shield), the note MUST mention the zone.
 - If the jurisdiction is wind-borne debris / hurricane-prone, fenestration and roof attachment items MUST reflect ASCE 7 / IBC 1609 requirements.
 - If no research supports a strict rule for a material, mark status="warning" with a note explaining why and set verified=false.
 - Do NOT fabricate code section numbers. When uncertain, prefer status="warning" + verified=false over a confident-sounding wrong citation.

Return ONLY this JSON (no markdown fences, no prose):

{{
  "overall_status": "pass | warning | fail",
  "summary": "2–4 sentences naming the most critical issues for this jurisdiction. Cite climate zone if relevant.",
  "checklist": [
    {{
      "item_name": "exact name from the materials list",
      "category": "category",
      "status": "pass | fail | warning",
      "note": "1 short sentence",
      "code_reference": "IRC 2021 §R905.1.1 or similar",
      "code_reference_url": "https://... from research, or null",
      "rule_quote": "short exact excerpt, or null",
      "fix_suggestion": "for fail/warning — specific fix, ≤20 words"
    }}
  ],
  "missing_required_items": [
    {{
      "item_name": "required item not in list",
      "category": "category",
      "code_reference": "real section",
      "code_reference_url": "URL from research or null",
      "reason_required": "1 sentence tying it to jurisdiction or climate zone"
    }}
  ]
}}

RULES:
 - overall_status: "pass" = no failures, "warning" = minor or unverifiable issues, "fail" = one or more clear code violations.
 - Every material in the list MUST appear in the checklist (no skipping).
 - Limit `missing_required_items` to at most 8.
 - Keep `note` under 18 words, `rule_quote` under 25 words, `fix_suggestion` under 20 words.
"""


async def check_materials_compliance(
    materials: list,
    city: str,
    state: str,
    project_type: str,
    county: str = "",
    zip_code: str = "",
) -> dict:
    """
    Public entry. Returns the per-material checklist with verified citations.
    """
    j = resolve_jurisdiction(city=city, state=state, county=county, zip_code=zip_code)
    cache_key = f"{j['fingerprint']}|{project_type}|{_materials_signature(materials or [])}"
    now = time.time()
    hit = _cache.get(cache_key)
    if hit and (now - hit[0]) < CACHE_TTL_SECONDS:
        cached = hit[1]
        # Defensive: if a prior deploy cached a parse-failure placeholder, evict
        # it so the retry actually hits the LLM again instead of parroting the
        # "could not be parsed" message for 6h.
        if cached.get("checklist") or cached.get("missing_required_items"):
            return cached
        _cache.pop(cache_key, None)

    loc = ", ".join(p for p in [j["city"], j["county"], j["state_name"]] if p).strip() or j["state_name"]
    fmt = {
        "loc": loc,
        "project_type": project_type,
        "climate_zone": j.get("climate_zone") or "",
        "cc_building":   j["code_cycles"].get("building", "building code"),
        "cc_residential": j["code_cycles"].get("residential", "residential code"),
        "cc_energy":     j["code_cycles"].get("energy", "energy code"),
        "cc_electrical": j["code_cycles"].get("electrical", "NEC"),
    }
    queries = [(cat, tmpl.format(**fmt)) for cat, tmpl in CATEGORY_QUERIES]

    # Skip the wind/flood category for non-wind-prone jurisdictions — it's noise.
    if not (j["high_wind"] or j["hurricane_prone"]):
        queries = [(c, q) for c, q in queries if c != "wind_flood"]

    results = await asyncio.gather(*[_tavily_category(c, q) for c, q in queries])
    research, allowed_urls = _format_research(results)

    materials_text = "\n".join([
        f"  {i+1}. {m.get('item_name','Unknown')} "
        f"[{m.get('category','general')}] "
        f"qty: {m.get('quantity',0)} {m.get('unit','each')}"
        for i, m in enumerate(materials or [])
    ]) or "  (no materials provided)"

    prompt = PROMPT.format(
        jurisdiction_json=json.dumps({k: j[k] for k in ("state","state_name","city","county","zip","climate_zone","high_wind","hurricane_prone")}, indent=2),
        code_cycles="\n".join(f"  - {k}: {v}" for k, v in j["code_cycles"].items()),
        materials_text=materials_text,
        research=(research[:20000] if research else "(No research retrieved — evaluate using IRC/IBC/IECC base code for the state and FLAG verified=false on every item.)"),
    )

    raw = await llm_text(prompt, max_tokens=8192)
    parse_failed = False
    try:
        result = _parse_json(raw)
    except Exception:
        logger.warning("materials compliance JSON parse failed — raw[:500]=%r", raw[:500] if raw else None, exc_info=True)
        parse_failed = True
        result = {
            "overall_status": "warning",
            "summary": f"Compliance data for {loc} retrieved but could not be parsed. Re-run to try again.",
            "checklist": [],
            "missing_required_items": [],
        }

    result["checklist"] = _verify(result.get("checklist") or [], allowed_urls)
    # Missing-items list gets the same URL verification treatment.
    verified_missing = []
    for m in result.get("missing_required_items") or []:
        if not isinstance(m, dict):
            continue
        url = (m.get("code_reference_url") or "").strip()
        if url and url not in allowed_urls:
            m["code_reference_url"] = None
            m["verified"] = False
        else:
            m["verified"] = bool(url)
        verified_missing.append(m)
    result["missing_required_items"] = verified_missing

    result.setdefault("overall_status", "warning")
    result.setdefault("summary", "")
    result["location"] = {"city": city, "state": state, "county": county, "zip": zip_code}
    result["project_type"] = project_type
    result["jurisdiction"] = {
        "climate_zone": j.get("climate_zone"),
        "high_wind": j.get("high_wind"),
        "hurricane_prone": j.get("hurricane_prone"),
        "code_cycles": j.get("code_cycles"),
        "code_cycles_pinned": j.get("code_cycles_pinned"),
    }
    result["verified_count"] = sum(1 for i in result["checklist"] if i.get("verified"))
    result["total_count"] = len(result["checklist"])

    # Only cache successful parses. Caching the "could not be parsed" placeholder
    # would pin that failure for 6h and make the Re-run button useless.
    if not parse_failed:
        _cache[cache_key] = (now, result)
    return result


# ── Back-compat shim: keep old signature so materials_compliance.fetch_local_codes
#    callers in tests/migrations still work.
async def fetch_local_codes(city: str, state: str, project_type: str, county: str = "") -> str:
    """Legacy helper — returns a flat research string. New callers use
    check_materials_compliance which handles research internally."""
    j = resolve_jurisdiction(city=city, state=state, county=county)
    loc = ", ".join(p for p in [city, county, j["state_name"]] if p)
    fmt = {
        "loc": loc, "project_type": project_type,
        "climate_zone": j.get("climate_zone") or "",
        "cc_building":   j["code_cycles"].get("building", "building code"),
        "cc_residential": j["code_cycles"].get("residential", "residential code"),
        "cc_energy":     j["code_cycles"].get("energy", "energy code"),
        "cc_electrical": j["code_cycles"].get("electrical", "NEC"),
    }
    queries = [(c, t.format(**fmt)) for c, t in CATEGORY_QUERIES[:4]]
    results = await asyncio.gather(*[_tavily_category(c, q) for c, q in queries])
    research, _ = _format_research(results)
    return research[:4000]
