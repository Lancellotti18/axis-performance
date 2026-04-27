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


async def web_search_structured(query: str, max_results: int = 5) -> list[dict]:
    """
    Same backends as web_search but returns a structured list of dicts:
      [{ "title": str, "url": str, "snippet": str, "published": Optional[str] }, ...]
    so callers can render real article cards instead of free-form text.
    """
    if settings.TAVILY_API_KEY:
        return await _tavily_search_structured(query, max_results)
    return await _duckduckgo_search_structured(query, max_results)


async def web_search_multi_structured(
    queries: list[str], max_results: int = 4
) -> list[dict]:
    """Run multiple searches in parallel, dedupe by URL, tag with the query
    that produced each article, and cap total results at 24 to keep payloads
    manageable. Each item: { title, url, snippet, query, published? }."""
    tasks = [web_search_structured(q, max_results) for q in queries]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    seen: set[str] = set()
    articles: list[dict] = []
    for q, r in zip(queries, results):
        if isinstance(r, Exception) or not r:
            continue
        for item in r:
            url = (item.get("url") or "").strip()
            if not url or url in seen:
                continue
            seen.add(url)
            articles.append({
                "title": (item.get("title") or "").strip(),
                "url": url,
                "snippet": (item.get("snippet") or "").strip(),
                "published": item.get("published") or None,
                "query": q,
            })
    return articles[:24]


def _format_articles_for_prompt(articles: list[dict]) -> str:
    """Render structured articles back into the same prompt-friendly format
    the LLM is used to (so changing collection to structured doesn't degrade
    the analysis quality)."""
    grouped: dict[str, list[dict]] = {}
    for a in articles:
        grouped.setdefault(a.get("query", "Search"), []).append(a)
    parts = []
    for q, items in grouped.items():
        block = [f"### Search: {q}"]
        for a in items:
            block.append(
                f"**{a.get('title', '')}**\n{a.get('snippet', '')}\nSource: {a.get('url', '')}"
            )
        parts.append("\n\n".join(block))
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


async def _duckduckgo_search_structured(query: str, max_results: int) -> list[dict]:
    def _run():
        from duckduckgo_search import DDGS
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
        return [
            {
                "title": r.get("title", ""),
                "url": r.get("href", ""),
                "snippet": r.get("body", ""),
            }
            for r in (results or [])
            if r.get("href")
        ]

    try:
        return await asyncio.to_thread(_run)
    except Exception:
        return []


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


async def _tavily_search_structured(query: str, max_results: int) -> list[dict]:
    def _run():
        from tavily import TavilyClient
        client = TavilyClient(api_key=settings.TAVILY_API_KEY)
        result = client.search(
            query=query,
            search_depth="advanced",
            max_results=max_results,
            include_answer=False,
        )
        return [
            {
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "snippet": r.get("content", ""),
                "published": r.get("published_date") or None,
            }
            for r in (result.get("results") or [])
            if r.get("url")
        ]

    try:
        return await asyncio.to_thread(_run)
    except Exception:
        return await _duckduckgo_search_structured(query, max_results)
