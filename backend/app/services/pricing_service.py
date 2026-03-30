"""
Real-time material pricing service.
Uses Tavily to search Home Depot, Lowe's, Menards, and local suppliers
for current prices and returns multiple vendor options per material.

Trade distributors (ABC Supply, Beacon, SRS) are B2B-only — they require
contractor logins to view pricing, so they are always injected as "Get Quote"
entries with direct search links rather than scraped prices.
"""
import re
import logging
from urllib.parse import quote_plus
from typing import List, Dict, Optional
from tavily import TavilyClient
from app.core.config import settings

logger = logging.getLogger(__name__)

# Retail sites — public prices, Tavily can scrape these
RETAIL_DOMAINS = [
    "homedepot.com",
    "lowes.com",
    "menards.com",
    "84lumber.com",
    "fastenal.com",
    "amazon.com",
    "build.com",
]

# Trade distributors — B2B contractor-login-only sites.
# Their internal search pages require authentication. We use Google search
# targeted at their domain so contractors can find the right product.
TRADE_DISTRIBUTORS = [
    {
        "vendor": "ABC Supply",
        "url_template": "https://www.google.com/search?q={query}+ABC+Supply+price",
        "note": "Contractor pricing — login required for checkout",
    },
    {
        "vendor": "QXO (Beacon)",
        "url_template": "https://www.google.com/search?q={query}+QXO+Beacon+roofing+supply+price",
        "note": "Contractor pricing — login required for checkout",
    },
    {
        "vendor": "SRS Distribution",
        "url_template": "https://www.google.com/search?q={query}+SRS+Distribution+price",
        "note": "Contractor pricing — login required for checkout",
    },
]

# Search queries for each material category
SEARCH_TEMPLATES = {
    "lumber":        'buy {item} price per board foot home depot lowes 2024',
    "sheathing":     'buy {item} sheet price home depot lowes 2024',
    "drywall":       'buy {item} drywall sheet price home depot lowes 2024',
    "insulation":    'buy {item} insulation price per roll batt home depot lowes 2024',
    "roofing":       'buy {item} roofing price per square home depot lowes 2024',
    "concrete":      'buy {item} bag price home depot lowes 2024',
    "flooring":      'buy {item} flooring price per sq ft home depot lowes 2024',
    "doors_windows": 'buy {item} price home depot lowes 2024',
    "electrical":    'buy {item} electrical price home depot lowes 2024',
    "plumbing":      'buy {item} plumbing price home depot lowes 2024',
    "finishing":     'buy {item} price home depot lowes 2024',
}

# Price pattern matchers
PRICE_PATTERNS = [
    r'\$\s*(\d{1,5}(?:\.\d{2})?)',
    r'(\d{1,5}\.\d{2})\s*(?:each|per|/)',
    r'price[:\s]+\$?(\d{1,5}(?:\.\d{2})?)',
]

VENDOR_NAMES = {
    "homedepot.com": "Home Depot",
    "lowes.com":     "Lowe's",
    "menards.com":   "Menards",
    "84lumber.com":  "84 Lumber",
    "fastenal.com":  "Fastenal",
    "amazon.com":    "Amazon",
    "build.com":     "Build.com",
}


def _extract_price(text: str) -> Optional[float]:
    """Extract first price found in text."""
    for pattern in PRICE_PATTERNS:
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            try:
                price = float(m.group(1))
                if 0.01 < price < 50000:
                    return price
            except ValueError:
                continue
    return None


def _vendor_from_url(url: str) -> str:
    """Extract vendor name from URL."""
    for domain, name in VENDOR_NAMES.items():
        if domain in url:
            return name
    # Fallback: use domain
    m = re.search(r'https?://(?:www\.)?([^/]+)', url)
    return m.group(1).replace(".com", "").title() if m else "Online Retailer"


PRODUCT_PAGE_SIGNALS = ['/p/', '/product/', '/item/', 'itemId=', 'productId=', '/N-', '/skus/']

def _trade_distributor_entries(item_name: str) -> List[dict]:
    """Always-present trade distributor entries with search links (no scraped price)."""
    query = item_name.replace(" ", "+")
    return [
        {
            "vendor": d["vendor"],
            "price": None,
            "url": d["url_template"].format(query=query),
            "is_local": False,
            "note": d["note"],
            "quote_only": True,
        }
        for d in TRADE_DISTRIBUTORS
    ]


def _search_material_prices(client: TavilyClient, item_name: str,
                             category: str, region: str, base_price: float, city: str = "") -> List[dict]:
    """Search Tavily for real retail prices, then append trade distributor quote links."""
    state = region.replace("US-", "") if region else ""
    city_hint = f" {city}" if city else (f" {state}" if state else "")

    retail_options = []
    seen_vendors = set()

    # Pass 1: domain-filtered search across retail sites only
    try:
        results = client.search(
            query=f'"{item_name}" buy price{city_hint}',
            search_depth="advanced",
            max_results=8,
            include_domains=RETAIL_DOMAINS,
        )
        for r in results.get("results", []):
            url        = r.get("url", "")
            content    = r.get("content", "") + " " + r.get("title", "")
            price      = _extract_price(content)
            vendor     = _vendor_from_url(url)
            is_product = any(sig in url for sig in PRODUCT_PAGE_SIGNALS)

            if vendor in seen_vendors or not price:
                continue
            if is_product:
                retail_options.append({"vendor": vendor, "price": price, "url": url, "is_local": False, "note": "", "_is_product": True})
                seen_vendors.add(vendor)
    except Exception as e:
        logger.warning(f"Tavily domain-filtered search failed: {e}")

    # Pass 2: broader search if we still need more retail options
    if len(retail_options) < 2:
        template = SEARCH_TEMPLATES.get(category, '{item} price buy')
        query = template.format(item=item_name) + (city_hint or "")
        try:
            results2 = client.search(query=query, search_depth="basic", max_results=6)
            for r in results2.get("results", []):
                url        = r.get("url", "")
                content    = r.get("content", "") + " " + r.get("title", "")
                price      = _extract_price(content)
                vendor     = _vendor_from_url(url)
                is_product = any(sig in url for sig in PRODUCT_PAGE_SIGNALS)

                if vendor in seen_vendors or not price:
                    continue
                retail_options.append({"vendor": vendor, "price": price, "url": url, "is_local": False,
                                       "note": "" if is_product else "Search result — may not be exact item",
                                       "_is_product": is_product})
                seen_vendors.add(vendor)
        except Exception as e:
            logger.warning(f"Tavily broader search failed: {e}")

    # Use fallback retail prices if Tavily found nothing
    if not retail_options:
        retail_options = _fallback_retail(item_name, base_price)
    else:
        # Product pages sort first, then by price
        retail_options.sort(key=lambda x: (not x.get("_is_product", False), x["price"]))
        for o in retail_options:
            o.pop("_is_product", None)
        if retail_options:
            retail_options[0]["tag"] = "lowest_price"
        if len(retail_options) >= 2:
            retail_options[1]["tag"] = "best_value"

    # Always append trade distributor quote links after retail prices
    trade = _trade_distributor_entries(item_name)
    return retail_options[:4] + trade


def _retail_search_urls(item_name: str) -> dict:
    """Generate item-specific search URLs for each retail vendor."""
    q = quote_plus(item_name)
    return {
        "Home Depot": f"https://www.homedepot.com/s/{q}",
        "Lowe's":     f"https://www.lowes.com/search?searchTerm={q}",
        "Menards":    f"https://www.menards.com/main/search.html?search={q}",
        "84 Lumber":  f"https://www.84lumber.com/search/?q={q}",
        "Fastenal":   f"https://www.fastenal.com/products?term={q}",
        "Amazon":     f"https://www.amazon.com/s?k={q}+building+materials",
        "Build.com":  f"https://www.build.com/search?q={q}",
    }


def _fallback_retail(item_name: str, base_price: float) -> List[dict]:
    """Estimated retail prices when Tavily search fails."""
    urls = _retail_search_urls(item_name)
    return [
        {"vendor": "Home Depot", "price": round(base_price * 0.98, 2), "url": urls["Home Depot"], "is_local": False, "tag": "lowest_price", "note": "Estimated — click to verify current price"},
        {"vendor": "Lowe's",     "price": round(base_price * 1.02, 2), "url": urls["Lowe's"],     "is_local": False, "tag": "best_value",   "note": "Estimated — click to verify current price"},
        {"vendor": "Menards",    "price": round(base_price * 0.95, 2), "url": urls["Menards"],    "is_local": False, "tag": "",             "note": "Estimated — click to verify current price"},
    ]


def enrich_materials_with_pricing(materials: List[dict], region: str, city: str = "") -> List[dict]:
    """
    Add real-time vendor pricing options to each material item.
    Each item gets its own Tavily search so product page URLs are specific
    to that item. Prices from the same category are cached to limit API calls
    but URLs are always item-specific.
    Falls back to estimated prices if Tavily search fails.
    """
    if not settings.TAVILY_API_KEY:
        return _add_fallback_pricing(materials)

    try:
        tavily = TavilyClient(api_key=settings.TAVILY_API_KEY)
    except Exception as e:
        logger.warning(f"Tavily client init failed: {e}")
        return _add_fallback_pricing(materials)

    # Cache prices by category to limit Tavily calls, but search URLs are per-item
    category_price_cache: Dict[str, List[dict]] = {}
    enriched = []

    for material in materials:
        item_name  = material["item_name"]
        category   = material.get("category", "finishing")
        base_price = material.get("unit_cost", 10.0)

        # Always run a per-item search so product URLs are specific to this item
        try:
            options = _search_material_prices(tavily, item_name, category, region, base_price, city=city)
            category_price_cache[category] = options
        except Exception:
            # Fall back to cached category prices with item-specific URLs
            cached = category_price_cache.get(category)
            if cached:
                item_urls = _retail_search_urls(item_name)
                options = []
                for opt in cached:
                    if not opt.get("quote_only"):
                        options.append({**opt, "url": item_urls.get(opt["vendor"], opt["url"])})
                options += _trade_distributor_entries(item_name)
            else:
                options = _fallback_retail(item_name, base_price) + _trade_distributor_entries(item_name)

        if options:
            retail = [o for o in options if not o.get("quote_only")]
            cheapest = retail[0]["price"] if retail else base_price
            material = {
                **material,
                "unit_cost":      cheapest,
                "total_cost":     round(material.get("quantity", 1) * cheapest, 2),
                "vendor_options": options,
            }
        else:
            material = {**material, "vendor_options": _fallback_retail(item_name, base_price) + _trade_distributor_entries(item_name)}

        enriched.append(material)

    return enriched


def _add_fallback_pricing(materials: List[dict]) -> List[dict]:
    """Add fallback vendor options without API calls."""
    enriched = []
    for m in materials:
        enriched.append({
            **m,
            "vendor_options": _fallback_retail(m["item_name"], m["unit_cost"]) + _trade_distributor_entries(m["item_name"]),
        })
    return enriched
