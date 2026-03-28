"""
Jurisdiction detection service.
Given a city + state (and optional full address), determines the correct
governing building authority and finds only official .gov permit portals.
Never guesses — returns structured failure with fallback if not found.
"""
import logging
import re
import requests as _requests
from typing import Optional
from app.core.config import settings

logger = logging.getLogger(__name__)

GOV_PATTERNS = [
    r'\.gov/',
    r'\.gov$',
    r'cityof[a-z]+\.org',
    r'countyof[a-z]+\.org',
]


def _is_official(url: str) -> bool:
    url_lower = url.lower()
    return any(re.search(p, url_lower) for p in GOV_PATTERNS)


def _url_accessible(url: str) -> bool:
    """HEAD request to verify URL is still live."""
    try:
        resp = _requests.head(url, timeout=8, allow_redirects=True,
                              headers={"User-Agent": "Mozilla/5.0"})
        return resp.status_code < 400
    except Exception:
        return False


def detect_jurisdiction(city: str, state: str, address: str = "", project_type: str = "residential") -> dict:
    """
    Returns:
      {
        "found": bool,
        "authority_name": str,
        "authority_type": "city" | "county" | "state",
        "gov_url": str | None,          # verified .gov portal homepage
        "permit_form_url": str | None,  # direct link to permit form/PDF
        "submission_method": "web_form" | "pdf_upload" | "email" | "in_person" | "unknown",
        "submission_email": str | None,
        "error": str | None,
        "fallback_search_url": str,
      }
    """
    fallback = f"https://www.google.com/search?q={city}+{state}+building+permit+application+site:.gov"

    if not settings.TAVILY_API_KEY:
        return {
            "found": False, "authority_name": None, "authority_type": None,
            "gov_url": None, "permit_form_url": None,
            "submission_method": "unknown", "submission_email": None,
            "error": "Search service not configured.",
            "fallback_search_url": fallback,
        }

    try:
        from tavily import TavilyClient
        client = TavilyClient(api_key=settings.TAVILY_API_KEY)

        # Step 1: Find the official building/permit department
        portal_results = client.search(
            query=f"{city} {state} official building permit department site:.gov",
            search_depth="basic",
            max_results=8,
            include_answer=False,
        )

        gov_url = None
        authority_name = None
        for r in portal_results.get("results", []):
            url = r.get("url", "")
            if _is_official(url) and _url_accessible(url):
                gov_url = url
                authority_name = r.get("title", "").split(" - ")[0].split("|")[0].strip()
                break

        if not gov_url:
            # Widen search — some cities use .org
            wider = client.search(
                query=f"official building permit {city} {state} government",
                search_depth="basic",
                max_results=8,
            )
            for r in wider.get("results", []):
                url = r.get("url", "")
                title = r.get("title", "").lower()
                if ("permit" in title or "building" in title) and _url_accessible(url):
                    gov_url = url
                    authority_name = r.get("title", "").split(" - ")[0].strip()
                    break

        if not gov_url:
            return {
                "found": False, "authority_name": None, "authority_type": None,
                "gov_url": None, "permit_form_url": None,
                "submission_method": "unknown", "submission_email": None,
                "error": f"Permit portal not found for {city}, {state}. No verified .gov source located.",
                "fallback_search_url": fallback,
            }

        # Step 2: Find the actual application form
        form_results = client.search(
            query=f"{city} {state} {project_type} building permit application form PDF download site:.gov",
            search_depth="advanced",
            max_results=8,
        )

        permit_form_url = None
        for r in form_results.get("results", []):
            url = r.get("url", "")
            url_lower = url.lower()
            if ".pdf" in url_lower or ("form" in url_lower and "permit" in url_lower):
                try:
                    resp = _requests.head(url, timeout=8, allow_redirects=True,
                                         headers={"User-Agent": "Mozilla/5.0"})
                    ct = resp.headers.get("content-type", "")
                    if resp.status_code < 400 and ("pdf" in ct or ".pdf" in url_lower):
                        permit_form_url = url
                        break
                except Exception:
                    continue

        # Step 3: Detect submission method from portal content
        submission_method, submission_email = _detect_submission_method(
            client, city, state, gov_url, project_type
        )

        # Determine authority type (city vs county)
        authority_type = "city"
        if "county" in (authority_name or "").lower() or "county" in gov_url.lower():
            authority_type = "county"
        elif "state" in (authority_name or "").lower():
            authority_type = "state"

        return {
            "found": True,
            "authority_name": authority_name or f"{city} Building Department",
            "authority_type": authority_type,
            "gov_url": gov_url,
            "permit_form_url": permit_form_url,
            "submission_method": submission_method,
            "submission_email": submission_email,
            "error": None,
            "fallback_search_url": fallback,
        }

    except Exception as e:
        logger.error(f"Jurisdiction detection failed: {e}")
        return {
            "found": False, "authority_name": None, "authority_type": None,
            "gov_url": None, "permit_form_url": None,
            "submission_method": "unknown", "submission_email": None,
            "error": f"Search failed: {str(e)}",
            "fallback_search_url": fallback,
        }


def _detect_submission_method(client, city: str, state: str, portal_url: str, project_type: str):
    """Analyse the portal to determine how permits are submitted."""
    try:
        results = client.search(
            query=f"{city} {state} how to submit building permit application online portal",
            search_depth="basic",
            max_results=5,
            include_answer=True,
        )
        answer = (results.get("answer") or "").lower()
        all_text = answer + " ".join(
            r.get("content", "") for r in results.get("results", [])
        ).lower()

        email = None
        email_match = re.search(r'[\w.+-]+@[\w-]+\.[a-z]{2,}', all_text)
        if email_match:
            email = email_match.group(0)

        if any(k in all_text for k in ["online portal", "submit online", "apply online", "etrakit", "accela", "citizenserve", "energov"]):
            return "web_form", email
        if any(k in all_text for k in ["upload pdf", "email the", "email your", "email completed"]):
            return "email", email
        if any(k in all_text for k in ["download", "pdf", "print and", "mail to", "in person", "in-person"]):
            return "pdf_upload", email
        return "unknown", email
    except Exception:
        return "unknown", None
