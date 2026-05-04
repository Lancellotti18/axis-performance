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

# Max materials per LLM call. Each checklist row is ~200 output tokens, so
# 15 items × ~200 = ~3k tokens — safely under the 8192 output budget even
# with a long summary and a few missing_required_items. Batching avoids the
# silent-truncation bug where large material lists would drop off the end.
CHUNK_SIZE = 15


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


# ─── Full-page fetch + extraction ──────────────────────────────────────────
# Tavily returns ~700-char snippets that are usually the top of the page.
# Local code amendments live deep inside long municipal documents, so we
# fetch the actual page (HTML or PDF), extract the section that matches the
# material category, and feed that to the LLM instead of the snippet.
# This is the single biggest accuracy unlock — the LLM was previously
# inferring rules from page intros.

PAGE_CACHE_TTL = 24 * 60 * 60   # code pages don't change daily
_page_cache: dict[str, tuple[float, str]] = {}
_fetch_sema: Optional[asyncio.Semaphore] = None
# Cap how many pages we fetch per check to keep latency under ~10s.
# Tavily ranks results by relevance, so fetching the top 2 per category
# covers the high-signal documents without paying for every URL.
TOP_RESULTS_TO_FETCH = 2
PER_FETCH_TIMEOUT = 10.0
MAX_FETCH_CONCURRENCY = 8
MAX_PAGE_CHARS = 30000          # cap raw extraction before section selection
MAX_SECTION_CHARS = 3000        # cap relevant-section per result going to LLM

# Per-category keywords used to find the relevant slice of a long document.
# We pick paragraphs that hit these keywords and concatenate them up to
# MAX_SECTION_CHARS so the LLM gets the actual code chapter, not the page
# header / table of contents.
CATEGORY_KEYWORDS: dict[str, list[str]] = {
    "roofing":      ["roof", "shingle", "underlayment", "ice", "shield", "covering", "asphalt"],
    "fenestration": ["window", "door", "fenestration", "u-factor", "shgc", "glazing", "skylight"],
    "insulation":   ["insulation", "r-value", "thermal", "cavity", "attic", "wall"],
    "framing":      ["framing", "stud", "header", "joist", "rafter", "wall", "lumber"],
    "electrical":   ["electrical", "afci", "gfci", "receptacle", "branch", "circuit", "panel"],
    "plumbing":     ["plumbing", "pipe", "trap", "venting", "ipc", "upc", "drain", "supply"],
    "mechanical":   ["mechanical", "hvac", "ventilation", "duct", "imc", "exhaust"],
    "fire":         ["smoke", "alarm", "carbon", "monoxide", "fire", "detector", "hardwired"],
    "egress":       ["egress", "emergency", "escape", "bedroom", "opening", "sill"],
    "wind_flood":   ["wind", "hurricane", "asce", "impact", "debris", "anchor", "uplift"],
}


def _get_fetch_sema() -> asyncio.Semaphore:
    global _fetch_sema
    if _fetch_sema is None:
        _fetch_sema = asyncio.Semaphore(MAX_FETCH_CONCURRENCY)
    return _fetch_sema


def _extract_pdf_text(data: bytes) -> str:
    """Extract first ~MAX_PAGE_CHARS of text from a PDF using pymupdf."""
    try:
        import fitz  # pymupdf
        doc = fitz.open(stream=data, filetype="pdf")
        parts: list[str] = []
        total = 0
        for page in doc:
            if total > MAX_PAGE_CHARS:
                break
            t = page.get_text() or ""
            parts.append(t)
            total += len(t)
        doc.close()
        return "\n".join(parts)
    except Exception as e:
        logger.warning("pdf extract failed: %s", str(e)[:200])
        return ""


def _extract_html_text(html: str) -> str:
    """Strip HTML to plain text, dropping nav/script/style/footer chrome."""
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")
        for el in soup(["script", "style", "nav", "header", "footer", "aside", "form", "noscript"]):
            el.decompose()
        text = soup.get_text(separator="\n", strip=True)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text[:MAX_PAGE_CHARS]
    except Exception as e:
        logger.warning("html extract failed: %s", str(e)[:200])
        return ""


async def _fetch_page_text(url: str) -> str:
    """Fetch URL, return cleaned plain-text body. Cached for 24h.

    Returns empty string on any failure (timeout, 4xx/5xx, parse error)
    so callers can fall back to the Tavily snippet without crashing.
    """
    if not url:
        return ""

    now = time.time()
    cached = _page_cache.get(url)
    if cached and (now - cached[0]) < PAGE_CACHE_TTL:
        return cached[1]

    sema = _get_fetch_sema()
    async with sema:
        try:
            import httpx
            async with httpx.AsyncClient(
                timeout=PER_FETCH_TIMEOUT,
                follow_redirects=True,
                headers={
                    "User-Agent": "Mozilla/5.0 (compatible; BuildAI-ComplianceBot/1.0; +https://buildai.app)",
                    "Accept": "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            ) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                ctype = (resp.headers.get("content-type") or "").lower()

                if "pdf" in ctype or url.lower().endswith(".pdf"):
                    text = _extract_pdf_text(resp.content)
                else:
                    text = _extract_html_text(resp.text)
        except Exception as e:
            logger.info("page fetch skipped %s: %s", url[:80], str(e)[:120])
            text = ""

    _page_cache[url] = (now, text)
    return text


def _select_relevant_section(full_text: str, category: str) -> str:
    """Find the chunks of the document that hit category keywords, return
    them in document order up to MAX_SECTION_CHARS. Falls back to the head
    of the document when no keyword hits."""
    if not full_text:
        return ""

    keywords = CATEGORY_KEYWORDS.get(category, [])
    if not keywords:
        return full_text[:MAX_SECTION_CHARS]

    paragraphs = re.split(r"\n\n+", full_text)
    scored: list[tuple[int, int, str]] = []
    for i, p in enumerate(paragraphs):
        if len(p) < 40:
            continue
        p_lower = p.lower()
        score = sum(1 for k in keywords if k in p_lower)
        if score > 0:
            scored.append((score, i, p))

    if not scored:
        return full_text[:MAX_SECTION_CHARS]

    scored.sort(key=lambda x: -x[0])
    chosen: list[tuple[int, str]] = []
    total = 0
    for _score, idx, p in scored:
        if total + len(p) > MAX_SECTION_CHARS:
            continue
        chosen.append((idx, p))
        total += len(p) + 2

    if not chosen:
        # Single paragraph too big — truncate the highest-scoring one.
        return scored[0][2][:MAX_SECTION_CHARS]

    chosen.sort(key=lambda x: x[0])
    return "\n\n".join(p for _, p in chosen)


# ─── Section-number verification ───────────────────────────────────────────
# After we verify the URL is real, also verify that the cited section
# (e.g. "R905.1.1") actually appears in that page's text. Closes the
# fabrication loophole where the LLM cites a real URL but invents a
# plausible-but-wrong subsection number.

# Code-cycle prefixes we strip before extracting the section identifier.
_CYCLE_PREFIX_RE = re.compile(
    r"^(?:IRC|IBC|IECC|IMC|IPC|NEC|NFPA|FBC|UPC|ASCE|ICC)\s*\d{0,4}",
    re.IGNORECASE,
)
# Section identifier inside a code reference: R905.1.1 / 210.8(A) / R402.1.2
_SECTION_TOKEN_RE = re.compile(
    r"([A-Z]?\d{2,4}(?:\.\d{1,3})*(?:\([A-Za-z0-9]+\))?)",
)


def _extract_section_token(reference: str) -> Optional[str]:
    """Pull the canonical section identifier out of a code reference string.
       'IRC 2021 §R905.1.1'        -> 'R905.1.1'
       'IECC 2021 Table R402.1.2'  -> 'R402.1.2'
       'NEC §210.8(A)'             -> '210.8(A)'
       'IRC 2021'                  -> None  (no section level cited)
    """
    if not reference:
        return None
    cleaned = _CYCLE_PREFIX_RE.sub("", reference.strip()).strip()
    cleaned = re.sub(r"^(?:Table|Section|§|Chapter)\s+", "", cleaned, flags=re.IGNORECASE).strip()
    m = _SECTION_TOKEN_RE.search(cleaned)
    if not m:
        return None
    token = m.group(1)
    # Reject pure year-like 4-digit matches with no dot or letter prefix
    # ('IRC 2021' would otherwise match '2021' as a section token).
    if not re.search(r"[A-Z]|\.|\(", token):
        return None
    return token


def _section_in_text(section_token: str, body: str) -> bool:
    """Substring match that tolerates PDF artifacts (line-break-induced
    whitespace) and case differences. Avoids regex-escape hazards by
    collapsing all whitespace before comparison."""
    if not section_token or not body:
        return False
    if section_token.lower() in body.lower():
        return True
    body_collapsed = re.sub(r"\s+", "", body.lower())
    needle_collapsed = re.sub(r"\s+", "", section_token.lower())
    return needle_collapsed in body_collapsed


def _verify_section(section_token: str, body: str) -> Optional[str]:
    """Return the most-specific verified ancestor of section_token that
    appears in the page body, or None if even the top-level section is
    absent. Walks parent sections by stripping trailing '.X' segments.

       'R905.1.1' present     -> 'R905.1.1'
       only 'R905.1' present  -> 'R905.1'
       only 'R905' present    -> 'R905'
       none present           -> None
    """
    if not section_token or not body:
        return None
    # Strip parenthetical first (e.g. '(A)') before walking dot-segments.
    bare = re.sub(r"\([^)]*\)$", "", section_token)
    if _section_in_text(section_token, body):
        return section_token
    parts = bare.split(".")
    while len(parts) > 1:
        parts.pop()
        candidate = ".".join(parts)
        if _section_in_text(candidate, body):
            return candidate
    return None


def _strip_section_from_reference(ref: str) -> str:
    """'IRC 2021 §R905.1.1' -> 'IRC 2021'. Used as the safe fallback when
    no section level can be verified against the cited page."""
    m = _CYCLE_PREFIX_RE.match(ref.strip())
    return m.group(0) if m else ref.strip()


def _replace_section_in_reference(ref: str, old_token: str, new_token: str) -> str:
    """Swap the section identifier in a reference string. Preserves the
    code-cycle prefix and any '§'/'Section'/'Table' qualifier."""
    if not ref or not old_token or not new_token:
        return ref
    # Plain substring swap is enough — section tokens are distinctive.
    if old_token in ref:
        return ref.replace(old_token, new_token)
    return ref


def _build_url_to_text(results: list[dict]) -> dict:
    """Combine the Tavily snippet with the cached full-page extract for
    each URL. Used by section verification to substring-search both
    sources — section numbers often appear in the snippet even when the
    full page wasn't fetched."""
    out: dict = {}
    for c in results:
        for r in c.get("results") or []:
            url = (r.get("url") or "").strip()
            if not url:
                continue
            parts: list[str] = []
            snippet = (r.get("content") or "").strip()
            if snippet:
                parts.append(snippet)
            enriched = (r.get("enriched_content") or "").strip()
            if enriched and enriched != snippet:
                parts.append(enriched)
            cached = _page_cache.get(url)
            if cached and cached[1]:
                parts.append(cached[1])
            if parts:
                # Dedupe while preserving order so we don't blow up the
                # body with the same text repeated.
                seen: set[str] = set()
                uniq: list[str] = []
                for p in parts:
                    key = p[:200]
                    if key in seen:
                        continue
                    seen.add(key)
                    uniq.append(p)
                out[url] = "\n\n".join(uniq)
    return out


async def _enrich_with_full_content(results: list[dict]) -> None:
    """Mutates Tavily results in-place: for the top N results in each
    category, fetch the page and attach `enriched_content` containing the
    section relevant to the category. Keeps the original snippet on failure."""
    fetch_targets: list[tuple[dict, str]] = []  # (result_row, category)
    seen_urls: set[str] = set()

    for c in results:
        cat = c.get("category", "")
        rows = c.get("results") or []
        for r in rows[:TOP_RESULTS_TO_FETCH]:
            url = (r.get("url") or "").strip()
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            fetch_targets.append((r, cat))

    if not fetch_targets:
        return

    async def _do(r: dict, cat: str) -> None:
        url = r.get("url") or ""
        full = await _fetch_page_text(url)
        if not full:
            return
        section = _select_relevant_section(full, cat)
        if section and len(section) > len(r.get("content") or ""):
            r["enriched_content"] = section

    await asyncio.gather(*[_do(r, cat) for r, cat in fetch_targets])


def _format_research(results: list[dict]) -> tuple[str, set[str]]:
    """Build the research blob shown to the LLM. For each result we prefer
    the `enriched_content` (full-page extract scoped to the category) over
    the Tavily snippet, since the snippet is usually just a page intro."""
    parts: list[str] = []
    urls: set[str] = set()
    for c in results:
        if not c.get("results"):
            continue
        parts.append(f"### Category: {c['category']}")
        for r in c["results"]:
            if r.get("url"):
                urls.add(r["url"])
            body = (r.get("enriched_content") or r.get("content") or "").strip()
            parts.append(f"- **{r.get('title','')}**\n  URL: {r.get('url','')}\n  {body}")
        parts.append("")
    return "\n".join(parts), urls


def _jurisdiction_label_for_url(url: str, loc: str, j: dict) -> str:
    """Best-effort jurisdiction label for a Tavily-fetched citation URL.
    Used in the per-item citation chip and the bibliography panel so the
    contractor can tell at a glance whether they're looking at a state .gov
    page, a municipal code library, or a model code from ICC."""
    u = (url or "").lower()
    state_name = j.get("state_name") or j.get("state") or ""
    if "iccsafe.org" in u or "codes.iccsafe.org" in u:
        return "International Code Council (model code)"
    if "ashrae.org" in u:
        return "ASHRAE (model standard)"
    if "nfpa.org" in u:
        return "NFPA (model standard)"
    if "municode.com" in u or "ecode360.com" in u:
        return loc or state_name or "Local municipal code"
    if ".gov" in u:
        return state_name or loc or "Government source"
    return loc or state_name or "Code reference"


def _build_sources(
    results: list[dict],
    loc: str,
    j: dict,
) -> tuple[list[dict], dict]:
    """Bibliography of every research result, deduped by URL, with a
    per-URL lookup map so checklist items can be enriched with the title
    and snippet of whatever they cite."""
    sources: list[dict] = []
    url_to_meta: dict[str, dict] = {}
    seen: set[str] = set()
    for c in results:
        cat = c.get("category", "")
        for r in c.get("results") or []:
            url = (r.get("url") or "").strip()
            if not url or url in seen:
                continue
            seen.add(url)
            title = (r.get("title") or "Untitled source").strip()
            snippet = (r.get("content") or "").strip().replace("\n", " ")
            if len(snippet) > 280:
                snippet = snippet[:277].rstrip() + "..."
            entry = {
                "title": title,
                "url": url,
                "snippet": snippet,
                "category": cat,
                "jurisdiction": _jurisdiction_label_for_url(url, loc, j),
            }
            sources.append(entry)
            url_to_meta[url] = entry
    return sources, url_to_meta


def _build_base_code_fallback(loc: str, j: dict) -> dict:
    """Professional fallback shown when a checklist item has no
    jurisdiction-specific URL — typically niche materials Tavily couldn't
    pin to a local code page."""
    state_name = j.get("state_name") or j.get("state") or ""
    location_phrase = loc or state_name or "this jurisdiction"
    return {
        "title": "International Residential Code 2021 — base code",
        "url": "https://codes.iccsafe.org/content/IRC2021P2",
        "note": (
            f"No jurisdiction-specific code reference was retrieved for this material in "
            f"{location_phrase}. It has been assessed against the International Residential "
            f"Code 2021 base standard. Confirm with your local Authority Having Jurisdiction "
            f"(AHJ) before construction."
        ),
    }


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


def _verify(
    items: list[dict],
    allowed_urls: set[str],
    url_to_meta: Optional[dict] = None,
    base_code_fallback: Optional[dict] = None,
    url_to_text: Optional[dict] = None,
) -> list[dict]:
    """
    For each checklist item, verify its `code_reference_url` (if present) was
    in the research. Items whose URL was fabricated keep their content but
    get verified=false and the URL cleared so the UI doesn't link to a
    non-existent statute page.

    Verified items are enriched with `code_reference_title`, `code_reference_snippet`,
    and `code_reference_jurisdiction` from the matching Tavily result so the UI
    can render a real source preview inline. Unverified items get a base-code
    fallback so the contractor still has something authoritative to read.

    Section-number verification: when `url_to_text` is supplied, also confirm
    that the section identifier inside `code_reference` (e.g. 'R905.1.1')
    actually appears in the page text. If only a parent section verifies
    we downgrade the reference to that parent; if nothing verifies we
    drop the section and keep the cycle prefix only.
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
            if base_code_fallback:
                it["code_reference_fallback"] = base_code_fallback
        else:
            it["verified"] = True
            if url_to_meta and url in url_to_meta:
                meta = url_to_meta[url]
                it["code_reference_title"] = meta.get("title")
                it["code_reference_snippet"] = meta.get("snippet")
                it["code_reference_jurisdiction"] = meta.get("jurisdiction")
            _apply_section_verification(it, url, url_to_text)
        out.append(it)
    return out


def _apply_section_verification(
    item: dict,
    url: str,
    url_to_text: Optional[dict],
) -> None:
    """Mutates the checklist item in-place to either confirm, downgrade,
    or strip the cited section number based on whether it appears in the
    page text. No-op if we don't have page text for the URL — we don't
    falsify what we can't check."""
    ref = (item.get("code_reference") or "").strip()
    section_token = _extract_section_token(ref)
    if not section_token:
        # Nothing section-level to verify — cycle/chapter only references
        # are fine as-is.
        item["code_reference_section_verified"] = None
        return
    if not url_to_text or url not in url_to_text:
        # We can't check, so we don't claim the section is verified.
        # Leave the reference intact — silently dropping section numbers
        # we couldn't verify would over-degrade the UI.
        item["code_reference_section_verified"] = None
        return

    body = url_to_text[url]
    verified_section = _verify_section(section_token, body)

    if verified_section == section_token:
        item["code_reference_section_verified"] = True
        return

    # Section number doesn't match — preserve the original for transparency
    # and downgrade the public-facing reference to whatever level we can prove.
    item["code_reference_original"] = ref
    if verified_section:
        item["code_reference_section_verified"] = "partial"
        item["code_reference"] = _replace_section_in_reference(ref, section_token, verified_section)
    else:
        item["code_reference_section_verified"] = False
        item["code_reference"] = _strip_section_from_reference(ref)


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


async def _evaluate_chunk(
    materials_chunk: list[dict],
    chunk_idx: int,
    total_chunks: int,
    include_missing_items: bool,
    jurisdiction_json: str,
    code_cycles_block: str,
    research_block: str,
) -> dict:
    """
    Run one compliance LLM call on a subset of materials. Returns the parsed
    JSON dict, or `{"_parse_failed": True}` if both the primary and retry
    attempts failed to produce valid JSON.
    """
    materials_text = "\n".join([
        f"  {i+1}. {m.get('item_name','Unknown')} "
        f"[{m.get('category','general')}] "
        f"qty: {m.get('quantity',0)} {m.get('unit','each')}"
        for i, m in enumerate(materials_chunk)
    ]) or "  (no materials provided)"

    base_prompt = PROMPT.format(
        jurisdiction_json=jurisdiction_json,
        code_cycles=code_cycles_block,
        materials_text=materials_text,
        research=research_block,
    )

    if total_chunks > 1:
        batch_note = (
            f"\n\nBATCH {chunk_idx + 1} OF {total_chunks}: evaluate ONLY the "
            f"{len(materials_chunk)} materials in the list above. "
            + (
                "Populate `missing_required_items` normally — this batch owns that list."
                if include_missing_items
                else "Return `missing_required_items` as an empty list [] — another batch handles it."
            )
        )
        prompt = base_prompt + batch_note
    else:
        prompt = base_prompt

    try:
        raw = await llm_text(prompt, max_tokens=8192)
    except Exception as e:
        logger.warning(
            "materials compliance chunk %d/%d: LLM providers all failed. err=%s",
            chunk_idx + 1, total_chunks, str(e)[:300],
        )
        return {"_parse_failed": True, "_error": "llm_unavailable"}

    try:
        return _parse_json(raw)
    except Exception:
        logger.warning(
            "materials compliance chunk %d/%d: JSON parse failed — retrying with JSON-only reminder. raw[:300]=%r",
            chunk_idx + 1, total_chunks, raw[:300] if raw else None,
        )
        retry_prompt = (
            "The previous response was not valid JSON. Re-emit ONLY the JSON object "
            "described below — no markdown fences, no prose, no apology, nothing before "
            "the opening '{' or after the closing '}'.\n\n" + prompt
        )
        try:
            raw2 = await llm_text(retry_prompt, max_tokens=8192)
            return _parse_json(raw2)
        except Exception:
            logger.warning(
                "materials compliance chunk %d/%d: JSON parse failed on retry — chunk dropped",
                chunk_idx + 1, total_chunks,
                exc_info=True,
            )
            return {"_parse_failed": True, "_error": "parse_failed"}


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
    # Fetch top-N pages per category and replace the 700-char Tavily snippet
    # with a real section of the document (HTML or PDF). Failures fall back
    # to the original snippet, so this can only improve recall.
    await _enrich_with_full_content(results)
    research, allowed_urls = _format_research(results)
    sources, url_to_meta = _build_sources(results, loc, j)
    url_to_text = _build_url_to_text(results)
    base_code_fallback = _build_base_code_fallback(loc, j)
    # 20k char cap was sized for snippet-only research. With page extracts
    # we routinely cross that — bump to 40k so the LLM actually sees the
    # local-amendment chapters we just fetched.
    research_block = (
        research[:40000] if research
        else "(No research retrieved — evaluate using IRC/IBC/IECC base code for the state and FLAG verified=false on every item.)"
    )
    jurisdiction_json = json.dumps(
        {k: j[k] for k in ("state","state_name","city","county","zip","climate_zone","high_wind","hurricane_prone")},
        indent=2,
    )
    code_cycles_block = "\n".join(f"  - {k}: {v}" for k, v in j["code_cycles"].items())

    material_list = list(materials or [])
    if not material_list:
        chunks = [[]]
    elif len(material_list) <= CHUNK_SIZE:
        chunks = [material_list]
    else:
        chunks = [material_list[i:i + CHUNK_SIZE] for i in range(0, len(material_list), CHUNK_SIZE)]

    chunk_results = await asyncio.gather(*[
        _evaluate_chunk(
            chunk, idx, len(chunks), idx == 0,
            jurisdiction_json, code_cycles_block, research_block,
        )
        for idx, chunk in enumerate(chunks)
    ])

    parse_failed = False
    merged_checklist: list = []
    merged_missing: list = []
    chunk_summaries: list[str] = []
    status_rank = {"pass": 0, "warning": 1, "fail": 2}
    worst_status = "pass"
    evaluated_names: set[str] = set()
    any_chunk_failed = False

    for chunk, cr in zip(chunks, chunk_results):
        if cr.get("_parse_failed"):
            any_chunk_failed = True
            continue
        for item in (cr.get("checklist") or []):
            if isinstance(item, dict):
                merged_checklist.append(item)
                name_key = (item.get("item_name") or "").strip().lower()
                if name_key:
                    evaluated_names.add(name_key)
        for miss in (cr.get("missing_required_items") or []):
            if isinstance(miss, dict):
                merged_missing.append(miss)
        if cr.get("summary"):
            chunk_summaries.append(str(cr["summary"]).strip())
        cs = (cr.get("overall_status") or "warning").lower()
        if status_rank.get(cs, 1) > status_rank.get(worst_status, 0):
            worst_status = cs

    # Fill in any materials that never got evaluated (dropped chunks or LLM
    # elided them) with base-code placeholders so the UI still shows the
    # full material list.
    unevaluated = [
        m for m in material_list
        if (m.get("item_name") or "").strip().lower() not in evaluated_names
    ]
    if unevaluated:
        stub = _base_code_materials_fallback(unevaluated, j, project_type, loc)
        merged_checklist.extend(stub.get("checklist") or [])
        if not merged_missing:
            merged_missing = stub.get("missing_required_items") or []
        if worst_status == "pass":
            worst_status = "warning"

    # Dedupe missing items by name, cap at 8 (matches PROMPT contract).
    seen_missing: set[str] = set()
    dedup_missing: list = []
    for m in merged_missing:
        key = (m.get("item_name") or "").strip().lower()
        if not key or key in seen_missing:
            continue
        seen_missing.add(key)
        dedup_missing.append(m)
    dedup_missing = dedup_missing[:8]

    if any_chunk_failed and not merged_checklist:
        # Every chunk failed — fall back to the base-code brick wall.
        parse_failed = True
        result = _base_code_materials_fallback(material_list, j, project_type, loc)
        if not chunks or all(c == [] for c in chunks):
            result["llm_unavailable"] = True
    else:
        summary = " ".join(chunk_summaries[:3]) if chunk_summaries else (
            f"Reviewed {len(merged_checklist)} materials against {loc} adopted codes."
        )
        result = {
            "overall_status": worst_status,
            "summary": summary,
            "checklist": merged_checklist,
            "missing_required_items": dedup_missing,
        }

    result["checklist"] = _verify(
        result.get("checklist") or [],
        allowed_urls,
        url_to_meta,
        base_code_fallback,
        url_to_text,
    )
    # Missing-items list gets the same URL verification treatment, plus the
    # same enrichment so the UI can show a "checked against" preview for the
    # missing items section too.
    verified_missing = []
    for m in result.get("missing_required_items") or []:
        if not isinstance(m, dict):
            continue
        url = (m.get("code_reference_url") or "").strip()
        if url and url not in allowed_urls:
            m["code_reference_url"] = None
            m["verified"] = False
            m["code_reference_fallback"] = base_code_fallback
        elif url:
            m["verified"] = True
            if url in url_to_meta:
                meta = url_to_meta[url]
                m["code_reference_title"] = meta.get("title")
                m["code_reference_snippet"] = meta.get("snippet")
                m["code_reference_jurisdiction"] = meta.get("jurisdiction")
            _apply_section_verification(m, url, url_to_text)
        else:
            m["verified"] = False
            m["code_reference_fallback"] = base_code_fallback
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
    result["sources"] = sources
    result["base_code_reference"] = base_code_fallback

    # Only cache successful parses. Caching the "could not be parsed" placeholder
    # would pin that failure for 6h and make the Re-run button useless.
    if not parse_failed:
        _cache[cache_key] = (now, result)
    return result


def _base_code_materials_fallback(
    materials: list[dict],
    j: dict,
    project_type: str,
    loc: str,
) -> dict:
    """
    Build a usable per-material checklist when the LLM call or parse failed.
    Every item is status="warning" + verified=False so the UI shows the
    amber "confirm with AHJ" treatment, and each item cites the jurisdiction's
    adopted code cycle (not a fabricated section). Contractors get something
    real to review instead of the "could not be parsed" brick wall.
    """
    cc = j.get("code_cycles") or {}
    state = j.get("state_name") or j.get("state") or ""
    climate = j.get("climate_zone")
    wind = bool(j.get("high_wind") or j.get("hurricane_prone"))

    def _category_of(m: dict) -> str:
        cat = (m.get("category") or "").lower()
        name = (m.get("item_name") or "").lower()
        if cat:
            return cat
        if any(k in name for k in ["shingle", "roof", "underlayment", "felt"]):
            return "roofing"
        if any(k in name for k in ["insulation", "batts", "blown"]):
            return "insulation"
        if any(k in name for k in ["window", "door", "glazing"]):
            return "fenestration"
        if any(k in name for k in ["wire", "breaker", "receptacle", "panel"]):
            return "electrical"
        if any(k in name for k in ["pipe", "pvc", "copper", "pex"]):
            return "plumbing"
        return "general"

    def _code_for(cat: str) -> tuple[str, str]:
        if cat == "roofing":      return (cc.get("residential", "IRC 2021"), "Roof assemblies must meet the adopted residential code chapter on roofing.")
        if cat == "insulation":   return (cc.get("energy", "IECC 2021"), f"R-values must meet IECC Table R402.1.2 for climate zone {climate or 'applicable to this jurisdiction'}.")
        if cat == "fenestration": return (cc.get("energy", "IECC 2021"), f"U-factor / SHGC must meet IECC Table R402.1.2 for climate zone {climate or 'applicable to this jurisdiction'}.")
        if cat == "electrical":   return (cc.get("electrical", "NEC"), "Electrical components must meet the adopted NEC edition and local amendments.")
        if cat == "plumbing":     return (cc.get("plumbing", "IPC / UPC as adopted"), "Materials must meet the adopted plumbing code and local amendments.")
        if cat == "framing":      return (cc.get("residential", "IRC 2021"), "Framing members must meet the adopted residential code span / spacing tables.")
        return (cc.get("building", "building code"), "Verify this material against the locally adopted building code and any local amendments.")

    checklist = []
    for m in materials:
        name = m.get("item_name") or "Material"
        cat = _category_of(m)
        ref, note = _code_for(cat)
        checklist.append({
            "item_name": name,
            "category": cat,
            "status": "warning",
            "note": note,
            "code_reference": ref,
            "code_reference_url": None,
            "rule_quote": None,
            "fix_suggestion": "Confirm with the local AHJ — research retrieval hit a parse error; re-run for a fully-cited check.",
            "verified": False,
        })

    missing = []
    if wind:
        missing.append({
            "item_name": "Impact-rated fenestration or approved shutter system",
            "category": "fenestration",
            "code_reference": "IBC §1609.2 / ASCE 7",
            "code_reference_url": None,
            "reason_required": f"{loc} is designated wind-borne-debris / hurricane-prone.",
            "verified": False,
        })
    if climate:
        missing.append({
            "item_name": f"Insulation meeting IECC Climate Zone {climate}",
            "category": "insulation",
            "code_reference": cc.get("energy", "IECC 2021") + " Table R402.1.2",
            "code_reference_url": None,
            "reason_required": f"Climate zone {climate} sets minimum R-values for this jurisdiction.",
            "verified": False,
        })

    return {
        "overall_status": "warning",
        "summary": (
            f"We retrieved live code data for {loc} but the response wasn't cleanly structured. "
            f"Showing the adopted code cycles for {state} so you have something real to work from — "
            f"re-run to try for the full per-material citations."
        ),
        "checklist": checklist,
        "missing_required_items": missing,
    }


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
