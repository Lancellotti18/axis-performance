from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
from app.core.supabase import get_supabase
import logging, json, re

router = APIRouter()
logger = logging.getLogger(__name__)


class MaterialItem(BaseModel):
    item_name: str
    category: str
    quantity: float
    unit: str
    unit_cost: float
    total_cost: float


class PriceSearchRequest(BaseModel):
    item_name: str
    category: str
    unit_cost: float
    region: str
    city: Optional[str] = ""


def _get_analysis_id(project_id: str):
    db = get_supabase()
    bp = db.table("blueprints").select("id").eq("project_id", project_id).limit(1).execute()
    if not bp.data:
        return None
    analysis = db.table("analyses").select("id").eq("blueprint_id", bp.data[0]["id"]).limit(1).execute()
    if not analysis.data:
        return None
    return analysis.data[0]["id"]


@router.post("/{project_id}/add")
async def add_material(project_id: str, item: MaterialItem):
    """Add a new material item to a project's estimate.

    Runs a vendor price search immediately so the new item lands in the DB
    with working distributor URLs — never an empty vendor_options. Falls back
    to retail search links if Tavily is unavailable, so every item has at
    least one clickable link out to a real store.
    """
    analysis_id = _get_analysis_id(project_id)
    if not analysis_id:
        raise HTTPException(status_code=404, detail="No analysis found for project")

    db = get_supabase()

    # Resolve region/city for the search so we bias toward local distributors.
    proj = db.table("projects").select("region, city").eq("id", project_id).single().execute()
    region = (proj.data or {}).get("region", "US-TX")
    city = (proj.data or {}).get("city", "") or ""

    # Search for vendor options so the added item is never unpriced.
    from app.services.pricing_service import (
        _search_material_prices,
        _fallback_retail,
        _trade_distributor_entries,
    )
    from app.core.config import settings

    options: list = []
    if settings.TAVILY_API_KEY:
        try:
            from tavily import TavilyClient
            client = TavilyClient(api_key=settings.TAVILY_API_KEY)
            options = _search_material_prices(
                client, item.item_name, item.category, region, item.unit_cost, city=city
            )
        except Exception:
            logger.warning("Tavily search failed on material add, using retail fallback", exc_info=True)

    if not options:
        options = _fallback_retail(item.item_name, item.unit_cost) + _trade_distributor_entries(item.item_name)

    result = db.table("material_estimates").insert({
        "analysis_id": analysis_id,
        "item_name": item.item_name,
        "category": item.category,
        "quantity": item.quantity,
        "unit": item.unit,
        "unit_cost": item.unit_cost,
        "total_cost": item.total_cost,
        "vendor_options": json.dumps(options),
    }).execute()
    return result.data[0]


@router.patch("/{project_id}/items/{item_id}")
async def update_material(project_id: str, item_id: str, item: MaterialItem):
    """Update a material item."""
    db = get_supabase()
    result = db.table("material_estimates").update({
        "item_name": item.item_name,
        "category": item.category,
        "quantity": item.quantity,
        "unit": item.unit,
        "unit_cost": item.unit_cost,
        "total_cost": round(item.quantity * item.unit_cost, 2),
    }).eq("id", item_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Item not found")
    return result.data[0]


@router.delete("/{project_id}/items/{item_id}")
async def delete_material(project_id: str, item_id: str):
    """Delete a material item."""
    db = get_supabase()
    db.table("material_estimates").delete().eq("id", item_id).execute()
    return {"success": True}


@router.post("/search-prices")
async def search_prices(req: PriceSearchRequest):
    """Search Tavily for real-time prices for a specific material item."""
    from app.services.pricing_service import _search_material_prices
    from app.core.config import settings

    if not settings.TAVILY_API_KEY:
        from app.services.pricing_service import _fallback_retail, _trade_distributor_entries
        return {"options": _fallback_retail(req.item_name, req.unit_cost) + _trade_distributor_entries(req.item_name)}

    try:
        from tavily import TavilyClient
        client = TavilyClient(api_key=settings.TAVILY_API_KEY)
        options = _search_material_prices(client, req.item_name, req.category, req.region, req.unit_cost, city=req.city or "")
        return {"options": options}
    except Exception as e:
        logger.warning(f"Price search failed: {e}")
        from app.services.pricing_service import _fallback_retail, _trade_distributor_entries
        return {"options": _fallback_retail(req.item_name, req.unit_cost) + _trade_distributor_entries(req.item_name)}


@router.post("/{project_id}/refresh-all-prices")
async def refresh_all_prices(project_id: str):
    """
    Refresh vendor pricing for every material in a project.
    Runs a per-item Tavily search and saves updated vendor_options + unit_cost to DB.
    """
    from app.services.pricing_service import _search_material_prices, _fallback_retail, _trade_distributor_entries
    from app.core.config import settings

    db = get_supabase()

    # Get project location
    proj = db.table("projects").select("region, city").eq("id", project_id).single().execute()
    region = proj.data.get("region", "US-TX") if proj.data else "US-TX"
    city = proj.data.get("city", "") if proj.data else ""

    # Get all materials for this project
    analysis_id = _get_analysis_id(project_id)
    if not analysis_id:
        raise HTTPException(status_code=404, detail="No analysis found for project")

    rows = db.table("material_estimates").select("*").eq("analysis_id", analysis_id).execute()
    materials = rows.data or []
    if not materials:
        return {"updated": 0}

    tavily = None
    if settings.TAVILY_API_KEY:
        try:
            from tavily import TavilyClient
            tavily = TavilyClient(api_key=settings.TAVILY_API_KEY)
        except Exception:
            logger.debug("Tavily client init failed, using fallback prices", exc_info=True)
            pass

    updated = 0
    for m in materials:
        item_name = m.get("item_name", "")
        category  = m.get("category", "finishing")
        base_price = float(m.get("unit_cost") or 10.0)

        try:
            if tavily:
                options = _search_material_prices(tavily, item_name, category, region, base_price, city=city)
            else:
                options = _fallback_retail(item_name, base_price) + _trade_distributor_entries(item_name)
        except Exception:
            logger.debug("per-item price refresh failed, using fallback retail prices", exc_info=True)
            options = _fallback_retail(item_name, base_price) + _trade_distributor_entries(item_name)

        retail = [o for o in options if not o.get("quote_only")]
        new_unit_cost = retail[0]["price"] if retail else base_price

        db.table("material_estimates").update({
            "vendor_options": json.dumps(options),
            "unit_cost": new_unit_cost,
            "total_cost": round(float(m.get("quantity", 1)) * new_unit_cost, 2),
        }).eq("id", m["id"]).execute()
        updated += 1

    return {"updated": updated}


@router.post("/validate-link")
async def validate_material_link(payload: dict):
    """Validate a vendor product URL."""
    from app.services.link_validator import validate_product_url
    url = payload.get("url", "")
    product_name = payload.get("product_name", "")
    expected_price = float(payload.get("expected_price", 0))
    result = validate_product_url(url, product_name, expected_price)
    return result
