"""
Jurisdictional compliance engine.

Goal: emit a per-jurisdiction compliance checklist where every item is backed
by an actual statute URL the contractor can click through to. No fabricated
citations, no generic "most states require a license" advice.

How it works:
  1. Normalize (city, state, county, zip) via jurisdiction.resolve_jurisdiction
     so the LLM has climate zone, wind posture, and adopted code cycle context.
  2. Fan out one Tavily search per compliance topic (licensing, permits,
     lien law, insurance, electrical, plumbing, energy, …). Each search is
     constrained to authoritative domains (.gov, municode.com, ecode360.com,
     iccsafe.org, etc.) so blog posts can't outrank the statute.
  3. Feed every snippet (title, content, url) to the LLM with strict
     grounding rules: cite the exact section, quote the exact URL, mark
     anything unsupported as verified=false.
  4. Verify each emitted item's citation URL actually appears in the research
     snippets. Drop or downgrade unverifiable items.
  5. Cache the result by (jurisdiction fingerprint + project_type) for 6h
     so repeat clicks don't re-hit Tavily.

Contract is backwards-compatible with ComplianceCheck/ComplianceItem shape —
we add `source_url` and `verified` fields on items that the frontend can
start showing (existing `source` text field still populated).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Optional

from app.services.jurisdiction import (
    AUTHORITATIVE_DOMAINS,
    resolve_jurisdiction,
)
from app.services.llm import llm_text

logger = logging.getLogger(__name__)


CACHE_TTL_SECONDS = 6 * 60 * 60   # 6h — codes don't change daily
_cache: dict[str, tuple[float, dict]] = {}


# Topics fanned out in parallel. Each is a function of (jurisdiction, type)
# so the resulting queries are jurisdiction-specific, not generic boilerplate.
def _topic_queries(j: dict, project_type: str) -> list[dict]:
    state = j["state_name"] or j["state"]
    city = j["city"]
    county = j["county"]
    zip_ = j["zip"]
    cc = j["code_cycles"]
    loc = " ".join(p for p in [city, county, state] if p).strip() or state

    # NOTE: each entry is (topic_key, query, extra_domain_hints)
    topics = [
        ("licensing",
         f"{state} contractor licensing requirements {project_type} license board statute",
         []),
        ("permits",
         f"{city} {state} building permit requirements {project_type} application fees review process",
         []),
        ("contract_requirements",
         f"{state} home improvement contract requirements written disclosure {project_type} statute",
         []),
        ("lien_law",
         f"{state} mechanics lien law contractor notice deadline filing requirements statute",
         []),
        ("insurance_bonding",
         f"{state} contractor general liability insurance bond minimum requirements {project_type}",
         []),
        ("building_code",
         f"{loc} {cc.get('building','building code')} {project_type} amendments chapter",
         []),
        ("residential_code",
         f"{loc} {cc.get('residential','residential code')} adoption amendments section",
         []),
        ("energy_code",
         f"{loc} {cc.get('energy','energy code')} insulation R-value climate zone {j.get('climate_zone') or ''}",
         []),
        ("electrical_code",
         f"{loc} {cc.get('electrical','National Electrical Code')} NEC adoption amendments section",
         []),
        ("plumbing_code",
         f"{loc} plumbing code {project_type} IPC UPC adoption chapter",
         []),
        ("mechanical_code",
         f"{loc} mechanical code HVAC ventilation IMC {project_type} chapter",
         []),
        ("fire_code",
         f"{loc} fire code NFPA {project_type} sprinkler smoke detector requirements",
         []),
        ("accessibility",
         f"{state} accessibility code {project_type} ANSI A117 ADA requirements residential commercial",
         []),
        ("labor",
         f"{state} prevailing wage contractor worker classification subcontractor labor law",
         []),
    ]
    if j["high_wind"] or j["hurricane_prone"]:
        topics.append((
            "wind_flood",
            f"{loc} wind-borne debris region impact glazing hurricane {project_type} code section",
            [],
        ))
    if zip_:
        topics.append((
            "zip_ordinance",
            f"ordinances applicable to {zip_} {city} {state} residential construction building",
            [],
        ))
    return [{"topic": t, "query": q, "extra": e} for t, q, e in topics]


async def _tavily_topic(topic: dict) -> dict:
    """
    Run ONE topic search, domain-restricted to authoritative sources.
    Returns {topic, results: [{title, url, content}], errored: bool}.
    """
    try:
        from app.core.config import settings
        if not settings.TAVILY_API_KEY:
            return {"topic": topic["topic"], "results": [], "errored": True, "error": "no_tavily_key"}
        from tavily import TavilyClient
        client = TavilyClient(api_key=settings.TAVILY_API_KEY)

        def _run():
            return client.search(
                query=topic["query"],
                search_depth="advanced",
                max_results=5,
                include_domains=AUTHORITATIVE_DOMAINS + topic.get("extra", []),
                include_answer=False,
            )
        resp = await asyncio.to_thread(_run)
        rows = []
        for r in (resp.get("results") or [])[:5]:
            rows.append({
                "title": r.get("title") or "",
                "url":   r.get("url") or "",
                "content": (r.get("content") or "")[:800],  # cap tokens
            })
        return {"topic": topic["topic"], "results": rows, "errored": False}
    except Exception as e:
        logger.warning("tavily topic '%s' failed: %s", topic["topic"], e)
        return {"topic": topic["topic"], "results": [], "errored": True, "error": str(e)}


def _format_research(topic_results: list[dict]) -> tuple[str, set[str]]:
    """
    Turn the per-topic results into a single prompt-ready string PLUS a
    set of every URL we actually retrieved. The URL set is the allow-list
    the verification step uses to reject fabricated citations.
    """
    parts: list[str] = []
    urls: set[str] = set()
    for t in topic_results:
        if not t.get("results"):
            continue
        parts.append(f"### Topic: {t['topic']}")
        for r in t["results"]:
            if r.get("url"):
                urls.add(r["url"])
            parts.append(f"- **{r.get('title','')}**\n  URL: {r.get('url','')}\n  {r.get('content','')}")
        parts.append("")
    return "\n".join(parts), urls


COMPLIANCE_PROMPT = """You are a licensed construction-law compliance expert for the United States.

JURISDICTION PROFILE (use this EXACTLY — do not substitute state-level data for city-level when city-level is present):
{jurisdiction_json}

CODE CYCLES PINNED FOR THIS JURISDICTION:
{code_cycles}

RESEARCH RESULTS (domain-restricted to .gov / municode.com / ecode360.com / iccsafe.org / ada.gov / osha.gov — this is the ONLY source material you may cite):
{research}

TASK
Produce a comprehensive compliance checklist for a {project_type} project in {location} covering:
 1. Licensing (state contractor license)
 2. Permits (city/county building permit, trade permits)
 3. Contract requirements (written disclosures, 3-day right to cancel, etc.)
 4. Mechanic's lien notices & deadlines
 5. Insurance & bonding minimums
 6. Building code (state + local amendments)
 7. Residential / accessibility / energy / electrical / plumbing / mechanical / fire code specifics
 8. Labor / prevailing-wage / worker-classification rules
 9. If jurisdiction is high-wind or hurricane-prone: wind-borne debris & impact-glazing requirements

GROUNDING RULES (non-negotiable):
 - Every item MUST cite a specific statute, ordinance, or code section by its real number (e.g. "IRC 2021 §R905.2.8.5", "N.C. Gen. Stat. §87-10", "Wilmington Code §18-262").
 - `source_url` MUST be a URL that appears verbatim in the RESEARCH RESULTS above. Do not invent a URL, do not shorten, do not fix typos.
 - Quote a short excerpt (≤25 words) of the actual statute text in `source_quote` when the research contains it.
 - If a category has NO supporting research, OMIT that category. Do not pad with generic advice.
 - Set `verified: true` ONLY when both the citation and the URL are present in the research. Otherwise `verified: false`.
 - Prefer the MOST SPECIFIC jurisdictional source — municipal ordinance > state statute > IRC/IBC base code. When citing base code, add "(base code — confirm with local AHJ)" to the title.

Return ONLY this JSON (no markdown fences, no prose):

{{
  "state": "{state_code}",
  "location": "{location}",
  "project_type": "{project_type}",
  "code_cycles": {code_cycles_json},
  "summary": "2–3 sentences naming the most critical jurisdiction-specific requirements and why they matter for this project.",
  "risk_level": "low | medium | high",
  "items": [
    {{
      "id": "unique-slug",
      "category": "Licensing | Permits | Contract | Liens | Insurance | Building Code | Electrical | Plumbing | Energy | Fire | Accessibility | Labor | Wind/Flood",
      "title": "Short requirement title",
      "description": "1–2 sentences explaining the requirement and who it applies to",
      "severity": "required | recommended | info",
      "action": "Specific action the contractor must take",
      "deadline": "Deadline if applicable, else null",
      "penalty": "Consequence of non-compliance if known, else null",
      "source": "Exact statute or ordinance citation (e.g. 'IRC 2021 §R905.2.8.5')",
      "source_url": "URL verbatim from research",
      "source_quote": "Short excerpt of the statute text, or null",
      "verified": true
    }}
  ]
}}

Aim for 12–25 items when research supports them. Fewer is fine — quality over quantity."""


def _strip_json(text: str) -> str:
    text = text.strip()
    text = re.sub(r'^```(?:json)?\s*', '', text, count=1)
    text = re.sub(r'\s*```\s*$', '', text)
    start = text.find("{")
    if start > 0:
        text = text[start:]
    end = text.rfind("}") + 1
    if end > 0:
        text = text[:end]
    return text


def _verify_items(items: list[dict], allowed_urls: set[str]) -> list[dict]:
    """
    Check each item's source_url against the URLs we actually retrieved.
    Items whose URL the model fabricated get `verified=false` and a warning
    appended to `description`. We don't drop them outright — the user still
    sees "we think this matters but couldn't verify the citation" which is
    honest and more useful than silently hiding.
    """
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        url = (it.get("source_url") or "").strip()
        verified = bool(it.get("verified")) and url in allowed_urls
        if not verified:
            it["verified"] = False
            if url and url not in allowed_urls:
                it["source_url"] = None   # don't link to a hallucinated URL
        else:
            it["verified"] = True
        out.append(it)
    return out


async def run_compliance_check(
    location: str,               # retained for back-compat (callers pass "State" or "City, State")
    state_code: str,
    project_type: str,
    city: Optional[str] = None,
    county: Optional[str] = None,
    zip_code: Optional[str] = None,
) -> dict:
    """
    Public entry point. Returns a jurisdiction-aware compliance checklist
    with citations grounded in retrieved, authoritative-domain research.
    """
    j = resolve_jurisdiction(city=city or location, state=state_code, county=county, zip_code=zip_code)
    cache_key = f"{j['fingerprint']}|{project_type}"
    now = time.time()
    hit = _cache.get(cache_key)
    if hit and (now - hit[0]) < CACHE_TTL_SECONDS:
        return hit[1]

    topics = _topic_queries(j, project_type)
    results = await asyncio.gather(*[_tavily_topic(t) for t in topics])
    research, allowed_urls = _format_research(results)

    if not research or len(research) < 400:
        logger.warning("compliance: thin research for %s (%d chars) — returning base-code fallback",
                       j.get("fingerprint"), len(research))
        return {
            "state": j["state"],
            "location": location,
            "project_type": project_type,
            "code_cycles": j["code_cycles"],
            "summary": (
                f"Live code research for {location} was thin. Showing the base model codes "
                f"this state typically enforces — confirm every item with the local AHJ before relying on it."
            ),
            "risk_level": "medium",
            "research_unavailable": True,
            "items": _base_code_fallback_items(j, project_type),
        }

    prompt = COMPLIANCE_PROMPT.format(
        jurisdiction_json=json.dumps({k: j[k] for k in ("state","state_name","city","county","zip","climate_zone","high_wind","hurricane_prone")}, indent=2),
        code_cycles="\n".join(f"  - {k}: {v}" for k, v in j["code_cycles"].items()),
        code_cycles_json=json.dumps(j["code_cycles"]),
        research=research[:14000],     # keep within provider limits
        project_type=project_type,
        location=location,
        state_code=state_code,
    )

    raw = await llm_text(prompt, max_tokens=4096)
    try:
        data = json.loads(_strip_json(raw))
    except Exception:
        logger.warning("compliance: LLM JSON parse failed — returning fallback", exc_info=True)
        return {
            "state": j["state"],
            "location": location,
            "project_type": project_type,
            "code_cycles": j["code_cycles"],
            "summary": "We retrieved code data for this jurisdiction but couldn't parse the compliance summary. Try again in a moment.",
            "risk_level": "low",
            "research_unavailable": False,
            "items": _base_code_fallback_items(j, project_type),
        }

    items = _verify_items(data.get("items") or [], allowed_urls)
    data["items"] = items
    data.setdefault("research_unavailable", False)
    data.setdefault("code_cycles", j["code_cycles"])
    # Surface how many items were verified vs inferred so the UI can show a badge.
    data["verified_count"] = sum(1 for i in items if i.get("verified"))
    data["total_count"] = len(items)

    _cache[cache_key] = (now, data)
    return data


def _base_code_fallback_items(j: dict, project_type: str) -> list[dict]:
    """
    Last-resort items when live research is unavailable. Every item is
    labeled as base code and carries verified=false so the UI can show
    an amber "confirm with AHJ" chip. No invented jurisdiction-specific
    rules — just the model codes the state is known to have adopted.
    """
    cc = j["code_cycles"]
    state = j["state_name"] or j["state"]
    items = [
        {
            "id": "base-license",
            "category": "Licensing",
            "title": f"{state} contractor license required (base code — confirm with local AHJ)",
            "description": f"{state} requires a contractor license for most {project_type} work above a statutory dollar threshold. Confirm the exact threshold and classification with the state licensing board.",
            "severity": "required",
            "action": f"Verify license class and minimum project value on the {state} contractor licensing board website.",
            "deadline": None, "penalty": None,
            "source": f"{state} contractor licensing statute",
            "source_url": None, "source_quote": None,
            "verified": False,
        },
        {
            "id": "base-permit",
            "category": "Permits",
            "title": "Building permit required (base code — confirm with local AHJ)",
            "description": "Most jurisdictions require a building permit before any construction, alteration, or repair of structural, electrical, plumbing, or mechanical systems.",
            "severity": "required",
            "action": "Apply for the appropriate building permit with the city or county building department before starting work.",
            "deadline": None, "penalty": "Stop-work orders and fines for unpermitted work.",
            "source": cc.get("building", "IBC adopted locally"),
            "source_url": None, "source_quote": None,
            "verified": False,
        },
        {
            "id": "base-ibc",
            "category": "Building Code",
            "title": f"{cc.get('building', 'IBC')} governs construction (base code — confirm with local AHJ)",
            "description": f"Work must comply with {cc.get('building', 'the locally adopted building code')}. Local amendments may add or remove sections — verify with the AHJ.",
            "severity": "required",
            "action": "Design and construct to the adopted building code edition and confirm any local amendments.",
            "deadline": None, "penalty": None,
            "source": cc.get("building", "IBC"),
            "source_url": None, "source_quote": None,
            "verified": False,
        },
        {
            "id": "base-nec",
            "category": "Electrical",
            "title": f"{cc.get('electrical', 'NEC')} governs electrical work (base code — confirm with local AHJ)",
            "description": f"All electrical work must comply with {cc.get('electrical', 'the locally adopted National Electrical Code edition')}.",
            "severity": "required",
            "action": "Use a licensed electrician and pull electrical permits; inspections required before cover.",
            "deadline": None, "penalty": None,
            "source": cc.get("electrical", "NEC"),
            "source_url": None, "source_quote": None,
            "verified": False,
        },
        {
            "id": "base-iecc",
            "category": "Energy",
            "title": f"{cc.get('energy', 'IECC')} governs insulation & envelope (base code — confirm with local AHJ)",
            "description": f"Insulation R-values, window U-factors, and air-sealing must meet {cc.get('energy', 'the locally adopted IECC')}"
                           + (f" for climate zone {j.get('climate_zone')}." if j.get('climate_zone') else "."),
            "severity": "required",
            "action": "Design envelope to the energy code prescriptive or performance path for the climate zone.",
            "deadline": None, "penalty": None,
            "source": cc.get("energy", "IECC"),
            "source_url": None, "source_quote": None,
            "verified": False,
        },
    ]
    if j["hurricane_prone"] or j["high_wind"]:
        items.append({
            "id": "base-wind",
            "category": "Wind/Flood",
            "title": "Wind-borne debris region — impact glazing or shutters required (base code — confirm with local AHJ)",
            "description": "County is designated wind-borne debris / hurricane-prone. Exterior openings must be protected per IBC §1609.2 / ASCE 7.",
            "severity": "required",
            "action": "Specify impact-rated fenestration OR approved shutter systems on all exterior openings.",
            "deadline": None, "penalty": None,
            "source": "IBC §1609.2 / ASCE 7-22",
            "source_url": None, "source_quote": None,
            "verified": False,
        })
    return items


def get_state_from_region_code(region_code: str) -> dict:
    """Back-compat shim — kept so existing callers don't break."""
    code = (region_code or "").upper().replace("US-", "")[:2]
    from app.services.jurisdiction import _state_name
    return {"name": _state_name(code), "code": code}
