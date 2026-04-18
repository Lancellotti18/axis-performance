"""
Real-time material pricing service.

Rules (per product owner 2026-04-18):
  1. Every retail vendor row returned MUST have a direct product-page URL.
     Search-results pages and articles are never returned.
  2. No fabricated prices. If we don't have a real, scraped price for a
     vendor on a specific item, that vendor row is dropped entirely.
  3. Trade distributors (ABC Supply, QXO/Beacon, SRS) are always appended
     as quote-only rows with SKU-prefilled search deep-links. A contractor
     logged into those sites in the same browser lands directly on the
     search results inside their account and sees their own pricing.
  4. Tavily lookups for a material list run in parallel so a 30-item
     project completes in ~3s instead of serialized seconds.
"""
from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Optional
from urllib.parse import quote_plus

from tavily import TavilyClient

from app.core.config import settings

logger = logging.getLogger(__name__)


# Public retail sites — real prices, real product pages, Tavily can scrape.
RETAIL_DOMAINS = [
    "homedepot.com",
    "lowes.com",
    "menards.com",
    "84lumber.com",
    "fastenal.com",
    "amazon.com",
    "build.com",
    "ferguson.com",       # plumbing fixtures & supply
    "supplyhouse.com",    # HVAC / plumbing
    "grainger.com",       # MRO / fasteners / electrical
    "wayfair.com",        # lighting / fixtures / finishes
]

VENDOR_NAMES = {
    "homedepot.com":   "Home Depot",
    "lowes.com":       "Lowe's",
    "menards.com":     "Menards",
    "84lumber.com":    "84 Lumber",
    "fastenal.com":    "Fastenal",
    "amazon.com":      "Amazon",
    "build.com":       "Build.com",
    "ferguson.com":    "Ferguson",
    "supplyhouse.com": "SupplyHouse",
    "grainger.com":    "Grainger",
    "wayfair.com":     "Wayfair",
}

# URL substrings that identify a real product/SKU page across the supported
# retailers. Any URL that does not contain one of these is rejected — it's
# a search, category, article, or review page and we will not link to it.
PRODUCT_PAGE_SIGNALS = (
    "/p/",
    "/pd/",            # lowes.com, wayfair.com product page
    "/product/",
    "/products/",      # supplyhouse, wayfair
    "/item/",
    "/dp/",            # amazon product
    "/gp/product/",    # amazon alt product
    "itemId=",
    "productId=",
    "/skus/",
    "/N-",             # menards product
    "/-/",             # wayfair SKU path variant
)

TRADE_DISTRIBUTORS = [
    {
        "vendor": "ABC Supply",
        "url_template": "https://www.abcsupply.com/?s={query}",
        "note": "Contractor pricing — if you're signed in, this link shows your account pricing",
    },
    {
        "vendor": "QXO (Beacon)",
        "url_template": "https://www.qxo.com/search/{query}",
        "note": "Contractor pricing — if you're signed in, this link shows your account pricing",
    },
    {
        "vendor": "SRS Distribution",
        "url_template": "https://www.srsdistribution.com/en/search/?query={query}",
        "note": "Contractor pricing — if you're signed in, this link shows your account pricing",
    },
]

# Price extraction — the first well-formed dollar figure in the result
# content/title that isn't obviously bogus (handles "$12.99", "$4" but
# rejects "$0.01" or "$999999").
_PRICE_PATTERNS = [
    re.compile(r'\$\s*(\d{1,5}(?:\.\d{2})?)'),
    re.compile(r'(\d{1,5}\.\d{2})\s*(?:each|per|/)', re.IGNORECASE),
    re.compile(r'price[:\s]+\$?(\d{1,5}(?:\.\d{2})?)', re.IGNORECASE),
]


def _extract_price(text: str) -> Optional[float]:
    for pattern in _PRICE_PATTERNS:
        m = pattern.search(text or "")
        if not m:
            continue
        try:
            price = float(m.group(1))
        except ValueError:
            continue
        if 0.10 < price < 50000:
            return price
    return None


def _vendor_from_url(url: str) -> Optional[str]:
    if not url:
        return None
    for domain, name in VENDOR_NAMES.items():
        if domain in url:
            return name
    return None


def _is_product_page(url: str) -> bool:
    return bool(url) and any(sig in url for sig in PRODUCT_PAGE_SIGNALS)


def _trade_distributor_entries(item_name: str) -> List[dict]:
    """
    Always-present trade distributor rows. Contractor accounts that stay
    logged into these sites in the same browser land inside their account
    search results and see real trade pricing.
    """
    query = quote_plus(item_name)
    return [
        {
            "vendor":     d["vendor"],
            "price":      None,
            "url":        d["url_template"].format(query=query),
            "is_local":   False,
            "note":       d["note"],
            "quote_only": True,
        }
        for d in TRADE_DISTRIBUTORS
    ]


def _search_retail_products(
    client: TavilyClient,
    item_name: str,
    city: str = "",
) -> List[dict]:
    """
    Return at most one retail row per vendor, each guaranteed to be a real
    product page with a scraped price. Empty list if nothing clean found —
    we'd rather show fewer accurate rows than misleading ones.
    """
    location_hint = f" {city}" if city else ""
    results: List[dict] = []
    seen_vendors: set[str] = set()

    try:
        resp = client.search(
            query=f'"{item_name}" buy price{location_hint}',
            search_depth="advanced",
            max_results=12,
            include_domains=RETAIL_DOMAINS,
        )
    except Exception as e:
        logger.warning(f"Tavily retail search failed for '{item_name}': {e}")
        return []

    for r in resp.get("results", []) or []:
        url = r.get("url", "") or ""
        if not _is_product_page(url):
            continue
        vendor = _vendor_from_url(url)
        if not vendor or vendor in seen_vendors:
            continue
        content = (r.get("content", "") or "") + " " + (r.get("title", "") or "")
        price = _extract_price(content)
        if price is None:
            continue
        results.append({
            "vendor":   vendor,
            "price":    price,
            "url":      url,
            "is_local": False,
            "note":     "",
        })
        seen_vendors.add(vendor)

    results.sort(key=lambda x: x["price"])
    if results:
        results[0]["tag"] = "lowest_price"
    if len(results) >= 2:
        results[1]["tag"] = "best_value"
    return results


def search_vendor_options(
    client: Optional[TavilyClient],
    item_name: str,
    city: str = "",
) -> List[dict]:
    """
    Top-level: direct-product retail rows first, then the three trade
    distributor quote-only rows. Never returns rows with fake prices or
    non-product URLs.
    """
    retail: List[dict] = []
    if client is not None:
        try:
            retail = _search_retail_products(client, item_name, city=city)
        except Exception:
            logger.warning("retail product search failed", exc_info=True)
            retail = []
    return retail + _trade_distributor_entries(item_name)


# ── Legacy shim kept for materials.py + ai_pipeline.py ────────────────────────

def _search_material_prices(
    client: TavilyClient,
    item_name: str,
    category: str,
    region: str,      # retained for call-site compatibility; not used here
    base_price: float,  # retained for call-site compatibility; not used here
    city: str = "",
) -> List[dict]:
    del category, region, base_price   # silence linters — API stays backwards-compat
    return search_vendor_options(client, item_name, city=city)


def _trade_only_options(item_name: str) -> List[dict]:
    """No retail found and/or Tavily unavailable — still show trade rows."""
    return _trade_distributor_entries(item_name)


def enrich_materials_with_pricing(
    materials: List[dict],
    region: str,          # retained for API compat — regional adjustment lives in live_pricing_service
    city: str = "",
) -> List[dict]:
    """
    Attach vendor_options to each material. Tavily lookups run in parallel
    so a 30-item list completes in ~3s instead of serialized seconds.

    Each material keeps its original unit_cost unless a real retail
    product-page price was found, in which case unit_cost updates to that
    (truly cheapest) retail number.
    """
    del region  # not used — kept for callsite compatibility

    tavily: Optional[TavilyClient] = None
    if settings.TAVILY_API_KEY:
        try:
            tavily = TavilyClient(api_key=settings.TAVILY_API_KEY)
        except Exception:
            logger.warning("Tavily client init failed; returning trade-only vendor options", exc_info=True)
            tavily = None

    if not materials:
        return []

    # Fan out Tavily searches across all materials. Tavily supports plenty
    # of concurrency; a small thread pool is sufficient.
    indexed_materials = list(enumerate(materials))
    enriched: List[Optional[dict]] = [None] * len(materials)

    def _work(idx_mat):
        idx, mat = idx_mat
        name = mat.get("item_name", "")
        options = search_vendor_options(tavily, name, city=city)
        return idx, mat, options

    with ThreadPoolExecutor(max_workers=min(8, len(materials))) as pool:
        futures = [pool.submit(_work, im) for im in indexed_materials]
        for fut in as_completed(futures):
            try:
                idx, mat, options = fut.result()
            except Exception:
                logger.warning("per-item pricing task crashed", exc_info=True)
                continue
            retail = [o for o in options if not o.get("quote_only")]
            base_price = float(mat.get("unit_cost") or 0.0)
            new_unit_cost = retail[0]["price"] if retail else base_price
            qty = float(mat.get("quantity") or 0.0)
            enriched[idx] = {
                **mat,
                "unit_cost":      new_unit_cost,
                "total_cost":     round(qty * new_unit_cost, 2),
                "vendor_options": options,
            }

    # Fallback for any index the pool failed to fill — preserve the item untouched
    # with trade-only vendor rows.
    for i, slot in enumerate(enriched):
        if slot is None:
            mat = materials[i]
            enriched[i] = {**mat, "vendor_options": _trade_distributor_entries(mat.get("item_name", ""))}

    return [e for e in enriched if e is not None]
