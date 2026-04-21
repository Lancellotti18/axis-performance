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


# Per-vendor, per-category landing pages used as a fallback when the
# search-URL doesn't resolve to a real page (404, redirect to "no results",
# or unreachable). These are curated product category hubs that are stable
# across redesigns and always return something usable.
TRADE_DISTRIBUTOR_CATEGORY_PAGES: dict[str, dict[str, str]] = {
    "ABC Supply": {
        "roofing":       "https://www.abcsupply.com/products/residential-roofing",
        "siding":        "https://www.abcsupply.com/products/siding",
        "windows":       "https://www.abcsupply.com/products/windows",
        "gutters":       "https://www.abcsupply.com/products/gutters",
        "tools":         "https://www.abcsupply.com/products/tools-and-equipment",
        "default":       "https://www.abcsupply.com/products",
    },
    "QXO (Beacon)": {
        "roofing":       "https://www.qxo.com/products/roofing",
        "siding":        "https://www.qxo.com/products/siding",
        "windows":       "https://www.qxo.com/products/windows-doors",
        "waterproofing": "https://www.qxo.com/products/waterproofing",
        "default":       "https://www.qxo.com/products",
    },
    "SRS Distribution": {
        "roofing":       "https://www.srsdistribution.com/en/products/roofing/",
        "siding":        "https://www.srsdistribution.com/en/products/siding/",
        "windows":       "https://www.srsdistribution.com/en/products/windows-doors/",
        "landscape":     "https://www.srsdistribution.com/en/products/landscape/",
        "default":       "https://www.srsdistribution.com/en/products/",
    },
}


# Keywords → category bucket used for selecting a category-page fallback.
# Roofing-heavy because the three distributors are roofing-first; the
# remaining buckets degrade gracefully to "default".
_CATEGORY_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("roofing",       ("shingle", "roof", "underlayment", "ice", "drip edge",
                       "starter strip", "ridge cap", "felt", "flashing")),
    ("siding",        ("siding", "j-channel", "corner post", "housewrap", "tyvek")),
    ("windows",       ("window", "door", "glazing", "skylight")),
    ("gutters",       ("gutter", "downspout", "leader")),
    ("waterproofing", ("waterproof", "membrane", "vapor barrier")),
    ("landscape",     ("gravel", "stone", "aggregate", "drainage", "landscape")),
    ("tools",         ("nailer", "saw", "drill", "ladder")),
]


def _category_bucket_for(item_name: str) -> str:
    name = (item_name or "").lower()
    for bucket, kws in _CATEGORY_KEYWORDS:
        if any(k in name for k in kws):
            return bucket
    return "default"


def _verify_url_resolves(url: str, timeout_s: float = 5.0) -> tuple[bool, str | None]:
    """
    Lightweight HEAD/GET check for trade-distributor search URLs. Returns
    (ok, final_url).

    - ok=False when the URL hard-fails (404 / 410) OR redirects to an obvious
      "no results" search landing page. The caller should swap in a category
      page in that case.
    - ok=True otherwise — including opaque 403 / 429 / timeout, since those
      don't prove the link is broken (many supplier sites bot-block HEAD
      requests from cloud IPs but still work in a real browser).

    Uses httpx with a strict 5s timeout and follow_redirects=True. Never
    raises — any exception is logged and treated as "inconclusive → keep
    original URL".
    """
    try:
        import httpx
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
        with httpx.Client(
            follow_redirects=True,
            timeout=timeout_s,
            headers=headers,
        ) as client:
            # HEAD first — cheaper. Some sites reject HEAD → fall through to GET.
            try:
                resp = client.head(url)
                if resp.status_code in (405, 501):
                    resp = client.get(url)
            except httpx.HTTPError:
                resp = client.get(url)

            status = resp.status_code
            final_url = str(resp.url)

            if status in (404, 410):
                return False, final_url

            # "No results" heuristic — look at the body on a 200.
            # Cheap substring scan against the first 20kB.
            if 200 <= status < 300:
                try:
                    body = resp.text[:20000].lower() if resp.text else ""
                except Exception:
                    body = ""
                no_results_signals = (
                    "no results found",
                    "no matching results",
                    "0 results",
                    "did not match any products",
                    "sorry, we could not find",
                    "your search returned no results",
                )
                if body and any(sig in body for sig in no_results_signals):
                    return False, final_url

            # 3xx that landed somewhere reasonable, or 2xx with content → keep.
            # 403/429/5xx → inconclusive, don't over-penalize.
            return True, final_url
    except Exception as e:
        logger.debug("supplier URL verify failed (non-fatal) for %s: %s", url, e)
        return True, None  # inconclusive — don't fall back on network flake

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

    Each search URL is verified to actually resolve to a product/search page.
    If it 404s or lands on a "no results" page, we swap in the supplier's
    category page for the item's bucket (roofing/siding/windows/…) so the
    contractor at least sees relevant products instead of a dead link.
    Verification is best-effort — a network error keeps the original URL
    rather than failing the whole request.
    """
    query = quote_plus(item_name)
    bucket = _category_bucket_for(item_name)

    # Verify all three distributor search URLs in parallel so worst-case
    # latency is ~5s (one timeout) instead of 15s (three sequential timeouts).
    search_urls = [d["url_template"].format(query=query) for d in TRADE_DISTRIBUTORS]
    verify_results: dict[str, bool] = {}
    try:
        with ThreadPoolExecutor(max_workers=len(TRADE_DISTRIBUTORS)) as pool:
            futures = {pool.submit(_verify_url_resolves, u): u for u in search_urls}
            for fut in as_completed(futures):
                u = futures[fut]
                try:
                    ok, _ = fut.result(timeout=6)
                except Exception:
                    ok = True  # inconclusive → keep original
                verify_results[u] = ok
    except Exception:
        logger.debug("supplier URL verify pool crashed — keeping all original URLs", exc_info=True)
        verify_results = {u: True for u in search_urls}

    rows: List[dict] = []
    for d, search_url in zip(TRADE_DISTRIBUTORS, search_urls):
        final_url = search_url
        fallback_applied = False

        if not verify_results.get(search_url, True):
            category_map = TRADE_DISTRIBUTOR_CATEGORY_PAGES.get(d["vendor"], {})
            fallback = category_map.get(bucket) or category_map.get("default")
            if fallback:
                logger.info(
                    "supplier link fallback: %s search URL unusable for %r → category page (%s)",
                    d["vendor"], item_name, bucket,
                )
                final_url = fallback
                fallback_applied = True

        row = {
            "vendor":     d["vendor"],
            "price":      None,
            "url":        final_url,
            "is_local":   False,
            "note":       d["note"],
            "quote_only": True,
        }
        if fallback_applied:
            row["fallback"] = True
            row["fallback_reason"] = "search_no_results_or_broken"
        rows.append(row)

    return rows


# Vendors where we hard-verify the product page by actually fetching it.
# These two are where users click most often, and broken links erode trust fastest.
STRICT_VERIFY_VENDORS = {"Home Depot", "Lowe's"}


def _validation_rejects(validation: dict) -> bool:
    """
    True when validation actively disproves the link (drop the row).

    Retailer bot-blocking (403/429) and transient timeouts are inconclusive,
    not failures — if the URL structure is a known product page, we trust it.
    Hard rejections: 404/410, confirmed wrong product, or extreme price mismatch.
    """
    err = (validation.get("error") or "").lower()
    if "404" in err or "410" in err:
        return True
    if err:
        return False
    if validation.get("price_mismatch"):
        return True
    if validation.get("actual_price") is not None and not validation.get("product_found"):
        return True
    return False


def _search_retail_products(
    client: TavilyClient,
    item_name: str,
    city: str = "",
) -> List[dict]:
    """
    Return at most one retail row per vendor, each guaranteed to be a real
    product page with a scraped price. Home Depot and Lowe's rows are
    hard-verified (real HTTP fetch + product-name + price match) so the
    "Buy" button never lands on a 404 or wrong product. Empty list if
    nothing clean survives — we'd rather show fewer accurate rows.
    """
    from app.services.link_validator import validate_product_url

    location_hint = f" {city}" if city else ""
    candidates: List[dict] = []
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
        candidates.append({
            "vendor":   vendor,
            "price":    price,
            "url":      url,
            "is_local": False,
            "note":     "",
        })
        seen_vendors.add(vendor)

    if not candidates:
        return []

    # Hard-verify Home Depot + Lowe's in parallel. Cache in link_validator
    # keeps repeat hits instant across items and sessions.
    to_verify = [c for c in candidates if c["vendor"] in STRICT_VERIFY_VENDORS]
    verified_map: Dict[str, dict] = {}
    if to_verify:
        def _verify(row):
            return row["url"], validate_product_url(row["url"], item_name, row["price"])

        with ThreadPoolExecutor(max_workers=min(4, len(to_verify))) as pool:
            futs = [pool.submit(_verify, c) for c in to_verify]
            for fut in as_completed(futs):
                try:
                    u, v = fut.result(timeout=12)
                    verified_map[u] = v
                except Exception:
                    logger.debug("link validator crashed for a candidate", exc_info=True)

    results: List[dict] = []
    for row in candidates:
        if row["vendor"] in STRICT_VERIFY_VENDORS:
            v = verified_map.get(row["url"])
            if v is None:
                # Validator never reported back — unsafe to claim this link works
                continue
            if _validation_rejects(v):
                continue
            # When the live page had a confidently extracted price close to the
            # snippet price, prefer it — it's what the user will actually see.
            actual = v.get("actual_price")
            if actual and 0.7 * row["price"] <= actual <= 1.3 * row["price"]:
                row["price"] = round(actual, 2)
        results.append(row)

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
