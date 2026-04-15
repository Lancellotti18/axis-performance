"""
Jurisdiction detection service.
Given a city + state, finds the correct government building permit portal.

Improvements over previous version:
- Uses LLM to intelligently identify the correct portal URL from search results
  instead of brittle "Source:" line parsing
- Validates URLs with GET (not HEAD — many .gov sites block HEAD requests)
- Falls back gracefully with a pre-built Google search URL so the user always
  has a working link
"""
import logging
import re
import asyncio
import requests as _requests
from app.core.config import settings

logger = logging.getLogger(__name__)


def _verify_url(url: str) -> bool:
    """
    Verify a URL actually loads. Uses GET with a small byte range since many
    .gov sites block HEAD requests entirely.
    """
    try:
        resp = _requests.get(
            url, timeout=10, allow_redirects=True,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                "Range": "bytes=0-1023",  # Only fetch first 1KB to keep it fast
            },
            stream=True,
        )
        resp.close()
        return resp.status_code in (200, 206, 301, 302, 303, 307, 308)
    except Exception:
        return False


def _extract_urls_from_text(text: str) -> list[str]:
    """Pull all URLs out of raw search result text."""
    # Match URLs from "Source:" lines first (most reliable)
    source_urls = re.findall(r'Source:\s*(https?://[^\s\n]+)', text)
    # Also match any bare https:// URLs
    all_urls = re.findall(r'https?://[^\s\n\]]+', text)
    # Deduplicate preserving order, source URLs first
    seen = set()
    result = []
    for u in source_urls + all_urls:
        u = u.rstrip('.,;)')
        if u not in seen:
            seen.add(u)
            result.append(u)
    return result


def _llm_pick_portal_url(search_text: str, city: str, state: str) -> str | None:
    """
    Ask the LLM to identify the official permit portal URL from raw search results.
    Returns the URL string or None.
    """
    try:
        from app.services.llm import llm_text_sync

        urls = _extract_urls_from_text(search_text)
        if not urls:
            return None

        url_list = "\n".join(f"- {u}" for u in urls[:20])
        prompt = (
            f"I need to find the official government building permit portal for {city}, {state}.\n\n"
            f"Here are URLs found in a web search:\n{url_list}\n\n"
            f"Pick the single best URL that is:\n"
            f"1. The official city/county government permit portal (prefer .gov domains)\n"
            f"2. Actually a permit or building department page (not a news article or third-party site)\n"
            f"3. Directly usable by a contractor to apply for a building permit\n\n"
            f"Return ONLY the URL, nothing else. If none are suitable, return the word NONE."
        )
        result = llm_text_sync(prompt, max_tokens=200).strip()
        if result and result != "NONE" and result.startswith("http"):
            # Clean up any markdown the LLM might have added
            result = re.sub(r'[`\[\]()]', '', result).strip()
            return result
    except Exception as e:
        logger.warning(f"[Jurisdiction] LLM URL pick failed: {e}")
    return None


def detect_jurisdiction(city: str, state: str, address: str = "", project_type: str = "residential") -> dict:
    """
    Find the official building permit portal for a city/state.

    Returns:
      {
        "found": bool,
        "authority_name": str,
        "authority_type": "city" | "county" | "state",
        "gov_url": str | None,           # verified portal homepage
        "permit_form_url": str | None,   # direct link to permit PDF/form
        "submission_method": str,
        "submission_email": str | None,
        "error": str | None,
        "fallback_search_url": str,      # always populated — Google search as last resort
      }
    """
    # Always build a working Google fallback so the user has something to click
    google_fallback = (
        f"https://www.google.com/search?q="
        f"{city.replace(' ', '+')}+{state}+building+permit+application+official"
    )

    try:
        from app.services.search import web_search

        def _search(query: str) -> str:
            return asyncio.run(web_search(query, max_results=8))

        # ── Search 1: Find the official portal ──────────────────────────────
        raw1 = _search(f"{city} {state} building permit portal official government")
        if not raw1:
            raw1 = _search(f"{city} {state} building permit department")

        # Use LLM to pick the best URL from results
        gov_url = _llm_pick_portal_url(raw1, city, state)

        # If LLM found something, verify it actually loads
        if gov_url and not _verify_url(gov_url):
            logger.warning(f"[Jurisdiction] LLM-picked URL unreachable: {gov_url}")
            # Fall back to first accessible URL from search results
            gov_url = None
            for url in _extract_urls_from_text(raw1):
                if _verify_url(url):
                    gov_url = url
                    break

        if not gov_url:
            return {
                "found": False,
                "authority_name": f"{city} Building Department",
                "authority_type": "city",
                "gov_url": None,
                "permit_form_url": None,
                "submission_method": "unknown",
                "submission_email": None,
                "error": f"Could not find a verified permit portal for {city}, {state}.",
                "fallback_search_url": google_fallback,
            }

        # Extract authority name from search snippet
        authority_name = f"{city} Building Department"
        for line in raw1.split("\n"):
            if line.startswith("**") and "**" in line[2:]:
                candidate = line.strip("*").split(" - ")[0].split("|")[0].strip()
                if candidate and len(candidate) < 80:
                    authority_name = candidate
                    break

        # Determine authority type
        authority_type = "city"
        if "county" in authority_name.lower() or "county" in gov_url.lower():
            authority_type = "county"

        # ── Search 2: Find a direct permit application form/PDF ─────────────
        raw2 = _search(f"{city} {state} {project_type} building permit application form PDF fillable")
        permit_form_url = None

        # LLM pick for form URL
        form_candidate = _llm_pick_portal_url(raw2, city, state)
        if form_candidate:
            url_lower = form_candidate.lower()
            if ".pdf" in url_lower or "form" in url_lower or "application" in url_lower or "permit" in url_lower:
                if _verify_url(form_candidate):
                    permit_form_url = form_candidate

        # Fallback: scan for .pdf URLs directly
        if not permit_form_url:
            for url in _extract_urls_from_text(raw2):
                if ".pdf" in url.lower() and _verify_url(url):
                    permit_form_url = url
                    break

        # ── Search 3: Detect submission method ──────────────────────────────
        raw3 = _search(f"{city} {state} how to submit building permit application online")
        submission_method, submission_email = _parse_submission_method(raw3)

        return {
            "found": True,
            "authority_name": authority_name,
            "authority_type": authority_type,
            "gov_url": gov_url,
            "permit_form_url": permit_form_url,
            "submission_method": submission_method,
            "submission_email": submission_email,
            "error": None,
            "fallback_search_url": google_fallback,
        }

    except Exception as e:
        logger.error(f"[Jurisdiction] Detection failed: {e}")
        return {
            "found": False,
            "authority_name": None,
            "authority_type": None,
            "gov_url": None,
            "permit_form_url": None,
            "submission_method": "unknown",
            "submission_email": None,
            "error": str(e),
            "fallback_search_url": google_fallback,
        }


def _parse_submission_method(raw_text: str):
    text = raw_text.lower()
    email = None
    m = re.search(r'[\w.+-]+@[\w-]+\.[a-z]{2,}', text)
    if m:
        email = m.group(0)

    if any(k in text for k in ["online portal", "submit online", "apply online", "etrakit", "accela", "citizenserve", "energov", "mygovernmentonline", "permitsmith"]):
        return "web_form", email
    if any(k in text for k in ["email the", "email your", "email completed", "send to"]):
        return "email", email
    if any(k in text for k in ["download", "pdf", "print and", "mail to", "in person", "in-person", "drop off"]):
        return "pdf_upload", email
    return "unknown", email
