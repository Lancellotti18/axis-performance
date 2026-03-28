"""
Product link validation service.
Fetches product pages and verifies:
- The URL resolves to an actual product page (not search/category)
- The page contains the product name
- The displayed price matches the scraped price (within tolerance)
Results are cached in-memory for 1 hour to avoid re-fetching.
"""
import re
import time
import logging
import requests as _requests
from typing import Optional

logger = logging.getLogger(__name__)

# In-memory cache: url -> {result, expires_at}
_cache: dict = {}
CACHE_TTL = 3600  # 1 hour

PRICE_PATTERNS = [
    r'\$\s*(\d{1,5}(?:\.\d{2})?)',
    r'"price":\s*"?(\d{1,5}(?:\.\d{2})?)"?',
    r'data-price="(\d{1,5}(?:\.\d{2})?)"',
    r'priceValue.*?(\d{1,5}\.\d{2})',
]

PRODUCT_PAGE_SIGNALS = ['/p/', '/product/', '/item/', 'itemId=', 'productId=', '/N-', '/skus/']
NON_PRODUCT_SIGNALS = ['/s/', '/search', '/category', '/c/', '/department', '/collection']


def validate_product_url(url: str, product_name: str, expected_price: float) -> dict:
    """
    Returns:
    {
        "valid": bool,
        "is_product_page": bool,
        "product_found": bool,
        "actual_price": float | None,
        "price_match": bool,        # within 20% tolerance
        "price_mismatch": bool,
        "error": str | None,
        "cached": bool,
    }
    """
    now = time.time()
    cache_key = f"{url}:{product_name[:30]}"

    if cache_key in _cache and _cache[cache_key]["expires_at"] > now:
        result = dict(_cache[cache_key]["result"])
        result["cached"] = True
        return result

    result = _do_validate(url, product_name, expected_price)
    _cache[cache_key] = {"result": result, "expires_at": now + CACHE_TTL}
    return result


def _do_validate(url: str, product_name: str, expected_price: float) -> dict:
    base = {
        "valid": False, "is_product_page": False, "product_found": False,
        "actual_price": None, "price_match": False, "price_mismatch": False,
        "error": None, "cached": False,
    }

    if not url or not url.startswith("http"):
        base["error"] = "Invalid URL"
        return base

    # Quick structural check — if URL looks like a search page, skip fetching
    url_lower = url.lower()
    is_search = any(s in url_lower for s in NON_PRODUCT_SIGNALS)
    is_product = any(s in url_lower for s in PRODUCT_PAGE_SIGNALS)
    base["is_product_page"] = is_product and not is_search

    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
        }
        resp = _requests.get(url, timeout=10, headers=headers, allow_redirects=True)

        if resp.status_code >= 400:
            base["error"] = f"HTTP {resp.status_code}"
            return base

        html = resp.text[:50000]  # Only scan first 50kb
        html_lower = html.lower()

        # Check if product name keywords appear on page
        keywords = [w.lower() for w in product_name.split() if len(w) > 3]
        matched = sum(1 for kw in keywords if kw in html_lower)
        base["product_found"] = matched >= max(1, len(keywords) // 2)

        # Extract price from page
        actual_price = None
        for pattern in PRICE_PATTERNS:
            matches = re.findall(pattern, html, re.IGNORECASE)
            for m in matches:
                try:
                    p = float(m)
                    if 0.50 < p < 100000:
                        actual_price = p
                        break
                except ValueError:
                    continue
            if actual_price:
                break

        base["actual_price"] = actual_price

        if actual_price and expected_price > 0:
            ratio = actual_price / expected_price
            base["price_match"] = 0.70 <= ratio <= 1.30   # within 30% tolerance
            base["price_mismatch"] = ratio < 0.50 or ratio > 2.0  # extreme mismatch

        base["valid"] = base["product_found"] and not base["price_mismatch"]

        # Re-check product page signal from final URL (after redirects)
        final_url = resp.url.lower()
        if any(s in final_url for s in PRODUCT_PAGE_SIGNALS):
            base["is_product_page"] = True

        return base

    except _requests.Timeout:
        base["error"] = "Request timed out"
        return base
    except Exception as e:
        base["error"] = str(e)[:100]
        return base
