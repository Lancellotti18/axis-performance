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


def _search_material_prices(client: TavilyClient, item_name: str,
                             category: str, region: str, base_price: float, city: str = "") -> List[dict]:
    """Search Tavily for real prices for a given material."""
    template = SEARCH_TEMPLATES.get(category, '{item} price buy 2024')
    query    = template.format(item=item_name)

    # Add region context for local suppliers
    if city:
        query += f" near {city}"
    state = region.replace("US-", "") if region else ""
    if state:
        query += f" {state}"

    try:
        results = client.search(
            query=query,
            search_depth="basic",
            max_results=5,
            include_answer=False,
        )
    except Exception as e:
        logger.warning(f"Tavily search failed for '{item_name}': {e}")
        return _fallback_options(item_name, base_price)

    options = []
    seen_vendors = set()

    for r in results.get("results", []):
        url     = r.get("url", "")
        content = r.get("content", "") + " " + r.get("title", "")
        price   = _extract_price(content)
        vendor  = _vendor_from_url(url)

        if vendor in seen_vendors:
            continue

        if price:
            # Score URL quality: product pages score higher than search/category pages
            is_product_page = any(p in url for p in ['/p/', '/product/', '/item/', 'itemId=', 'productId=', '/N-'])
            options.append({
                "vendor":        vendor,
                "price":         price,
                "url":           url,
                "is_local":      False,
                "note":          "",
                "_is_product":   is_product_page,
            })
            seen_vendors.add(vendor)

    # Sort product pages to the top within each price tier
    options.sort(key=lambda x: (not x.get("_is_product", False), x["price"]))
    # Remove internal scoring field
    for o in options:
        o.pop("_is_product", None)

    # If we didn't find enough options, fill with fallback
    if len(options) < 2:
        options = _fallback_options(item_name, base_price)

    # Sort by price ascending
    options.sort(key=lambda x: x["price"])

    # Tag cheapest and best value
    if options:
        options[0]["tag"] = "lowest_price"
    if len(options) >= 2:
        options[1]["tag"] = "best_value"

    return options[:5]


def _fallback_options(item_name: str, base_price: float) -> List[dict]:
    """Generate plausible price options when search fails."""
    encoded = item_name.replace(' ', '+')
    return [
        {
            "vendor":   "Home Depot",
            "price":    round(base_price * 0.98, 2),
            "url":      f"https://www.homedepot.com/s/{encoded}",
            "is_local": False,
            "tag":      "lowest_price",
            "note":     "Estimated — click to see current prices",
        },
        {
            "vendor":   "Lowe's",
            "price":    round(base_price * 1.02, 2),
            "url":      f"https://www.lowes.com/search?searchTerm={encoded}",
            "is_local": False,
            "tag":      "best_value",
            "note":     "Estimated — click to see current prices",
        },
        {
            "vendor":   "Menards",
            "price":    round(base_price * 0.95, 2),
            "url":      f"https://www.menards.com/main/search.html?search={encoded}",
            "is_local": False,
            "tag":      "",
            "note":     "Estimated — click to see current prices",
        },
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
