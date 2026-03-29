"""
Real-time material pricing service.
Uses Tavily to search Home Depot, Lowe's, Menards, and local suppliers
for current prices and returns multiple vendor options per material.
"""
import json
import re
import logging
from typing import List, Dict, Optional
from tavily import TavilyClient
from app.core.config import settings

logger = logging.getLogger(__name__)

# Retailers to prioritize in search results
PRIORITY_RETAILERS = [
    "homedepot.com",
    "lowes.com",
    "menards.com",
    "84lumber.com",
    "fastenal.com",
    "amazon.com",
    "build.com",
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

def _search_material_prices(client: TavilyClient, item_name: str,
                             category: str, region: str, base_price: float, city: str = "") -> List[dict]:
    """Search Tavily for real prices — returns direct product page URLs only."""
    state = region.replace("US-", "") if region else ""
    city_hint = f" {city}" if city else (f" {state}" if state else "")

    options = []
    seen_vendors = set()

    # Pass 1: domain-filtered search — forces results from retailer sites only
    try:
        results = client.search(
            query=f'"{item_name}" buy price{city_hint}',
            search_depth="advanced",
            max_results=8,
            include_domains=["homedepot.com", "lowes.com", "menards.com", "fastenal.com", "84lumber.com"],
        )
        for r in results.get("results", []):
            url     = r.get("url", "")
            content = r.get("content", "") + " " + r.get("title", "")
            price   = _extract_price(content)
            vendor  = _vendor_from_url(url)
            is_product = any(sig in url for sig in PRODUCT_PAGE_SIGNALS)

            if vendor in seen_vendors or not price:
                continue
            if is_product:
                options.append({"vendor": vendor, "price": price, "url": url, "is_local": False, "note": "", "_is_product": True})
                seen_vendors.add(vendor)
    except Exception as e:
        logger.warning(f"Tavily domain-filtered search failed: {e}")

    # Pass 2: broader search if we need more options
    if len(options) < 2:
        template = SEARCH_TEMPLATES.get(category, '{item} price buy')
        query = template.format(item=item_name) + (city_hint or "")
        try:
            results2 = client.search(query=query, search_depth="basic", max_results=6)
            for r in results2.get("results", []):
                url     = r.get("url", "")
                content = r.get("content", "") + " " + r.get("title", "")
                price   = _extract_price(content)
                vendor  = _vendor_from_url(url)
                is_product = any(sig in url for sig in PRODUCT_PAGE_SIGNALS)

                if vendor in seen_vendors or not price:
                    continue
                options.append({"vendor": vendor, "price": price, "url": url, "is_local": False, "note": "" if is_product else "Search result — may not be exact item", "_is_product": is_product})
                seen_vendors.add(vendor)
        except Exception as e:
            logger.warning(f"Tavily broader search failed: {e}")

    if not options:
        return _fallback_options(item_name, base_price)

    # Product pages sort first, then by price
    options.sort(key=lambda x: (not x.get("_is_product", False), x["price"]))
    for o in options:
        o.pop("_is_product", None)

    if options:
        options[0]["tag"] = "lowest_price"
    if len(options) >= 2:
        options[1]["tag"] = "best_value"

    return options[:5]


def _fallback_options(item_name: str, base_price: float) -> List[dict]:
    """Generate plausible price options when search fails."""
    search = item_name.replace(' ', '+')
    return [
        {"vendor": "Home Depot",  "price": round(base_price * 0.98, 2), "url": f"https://www.homedepot.com/s/{search}",                                "is_local": False, "tag": "lowest_price", "note": "Estimated — click to search current prices"},
        {"vendor": "Lowe's",      "price": round(base_price * 1.02, 2), "url": f"https://www.lowes.com/search?searchTerm={search}",                     "is_local": False, "tag": "best_value",   "note": "Estimated — click to search current prices"},
        {"vendor": "Menards",     "price": round(base_price * 0.95, 2), "url": f"https://www.menards.com/main/search.html?search={search}",              "is_local": False, "tag": "",             "note": "Estimated — click to search current prices"},
    ]


def enrich_materials_with_pricing(materials: List[dict], region: str, city: str = "") -> List[dict]:
    """
    Add real-time vendor pricing options to each material item.
    Falls back to estimated prices if Tavily search fails.
    """
    if not settings.TAVILY_API_KEY:
        logger.warning("No Tavily API key — using fallback prices")
        return _add_fallback_pricing(materials)

    try:
        client = TavilyClient(api_key=settings.TAVILY_API_KEY)
    except Exception as e:
        logger.warning(f"Tavily client init failed: {e}")
        return _add_fallback_pricing(materials)

    # Only search for categories worth the API calls (deduplicate by item name)
    seen_items: Dict[str, List[dict]] = {}
    enriched = []

    for material in materials:
        item_name  = material["item_name"]
        category   = material["category"]
        base_price = material["unit_cost"]

        if item_name not in seen_items:
            options = _search_material_prices(client, item_name, category, region, base_price, city=city)
            seen_items[item_name] = options
        else:
            options = seen_items[item_name]

        # Update unit cost to cheapest found price
        if options:
            cheapest = options[0]["price"]
            material = {
                **material,
                "unit_cost":       cheapest,
                "total_cost":      round(material["quantity"] * cheapest, 2),
                "vendor_options":  options,
            }
        else:
            material = {**material, "vendor_options": _fallback_options(item_name, base_price)}

        enriched.append(material)

    return enriched


def _add_fallback_pricing(materials: List[dict]) -> List[dict]:
    """Add fallback vendor options without API calls."""
    enriched = []
    for m in materials:
        enriched.append({
            **m,
            "vendor_options": _fallback_options(m["item_name"], m["unit_cost"]),
        })
    return enriched
