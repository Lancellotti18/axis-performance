"""
Unified web search service.

Priority:
  1. DuckDuckGo (free, no API key needed)
  2. Tavily (paid, better results — used as upgrade if TAVILY_API_KEY is set)

Usage:
    from app.services.search import web_search

    results = await web_search("North Carolina contractor license requirements 2025")
    # Returns formatted string of search results
"""
import asyncio
from typing import Optional
from app.core.config import settings


async def web_search(query: str, max_results: int = 5) -> str:
    """
    Run a web search and return a formatted string of results.
    Uses Tavily if configured (better quality), otherwise DuckDuckGo (free).
    """
    if settings.TAVILY_API_KEY:
        return await _tavily_search(query, max_results)
    return await _duckduckgo_search(query, max_results)


async def web_search_multi(queries: list[str], max_results: int = 4) -> str:
    """Run multiple searches and combine results."""
    tasks = [web_search(q, max_results) for q in queries]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    parts = []
    for q, r in zip(queries, results):
        if isinstance(r, Exception):
            continue
        parts.append(f"### Search: {q}\n{r}")
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# DuckDuckGo (free, no API key)
# ---------------------------------------------------------------------------

async def _duckduckgo_search(query: str, max_results: int) -> str:
    def _run():
        from duckduckgo_search import DDGS
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
        if not results:
            return ""
        lines = []
        for r in results:
            title = r.get("title", "")
            body = r.get("body", "")
            href = r.get("href", "")
            lines.append(f"**{title}**\n{body}\nSource: {href}")
        return "\n\n".join(lines)

    try:
        return await asyncio.to_thread(_run)
    except Exception as e:
        return f"Search unavailable: {e}"


# ---------------------------------------------------------------------------
# Tavily (paid, optional premium)
# ---------------------------------------------------------------------------

async def _tavily_search(query: str, max_results: int) -> str:
    def _run():
        from tavily import TavilyClient
        client = TavilyClient(api_key=settings.TAVILY_API_KEY)
        result = client.search(
            query=query,
            search_depth="advanced",
            max_results=max_results,
            include_answer=True,
        )
        parts = []
        if result.get("answer"):
            parts.append(f"Summary: {result['answer']}")
        for r in result.get("results", []):
            parts.append(f"**{r.get('title', '')}**\n{r.get('content', '')}\nSource: {r.get('url', '')}")
        return "\n\n".join(parts)

    try:
        return await asyncio.to_thread(_run)
    except Exception as e:
        # Fall back to DuckDuckGo if Tavily fails
        return await _duckduckgo_search(query, max_results)
