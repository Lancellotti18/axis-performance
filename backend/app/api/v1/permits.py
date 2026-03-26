from fastapi import APIRouter, Query
from app.core.config import settings
import logging

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/portal-search")
async def search_permit_portal(
    city: str = Query(...),
    state: str = Query(...),
    project_type: str = Query(default="residential"),
):
    """Use Tavily to find the official building permit portal for a city."""
    if not settings.TAVILY_API_KEY:
        return {"portal_url": None, "portal_name": None, "instructions": None, "source": "fallback"}

    try:
        from tavily import TavilyClient
        client = TavilyClient(api_key=settings.TAVILY_API_KEY)
        query = f"{city} {state} building permit application online portal official government site"
        results = client.search(
            query=query,
            search_depth="basic",
            max_results=5,
            include_answer=True,
        )

        # Look for .gov or city official sites first
        portal_url = None
        portal_name = None
        for r in results.get("results", []):
            url = r.get("url", "")
            if ".gov" in url or "permit" in url.lower() or "building" in url.lower():
                portal_url = url
                portal_name = r.get("title", "Official Permit Portal")
                break

        # Fall back to first result
        if not portal_url and results.get("results"):
            first = results["results"][0]
            portal_url = first.get("url")
            portal_name = first.get("title", "Permit Portal")

        answer = results.get("answer", "")
        return {
            "portal_url": portal_url,
            "portal_name": portal_name,
            "instructions": answer or f"Visit the official {city}, {state} building department to submit your permit application.",
            "source": "tavily",
        }
    except Exception as e:
        logger.warning(f"Permit portal search failed: {e}")
        return {
            "portal_url": None,
            "portal_name": None,
            "instructions": f"Contact the {city}, {state} building department directly.",
            "source": "error",
        }
