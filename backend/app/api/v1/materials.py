from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.core.supabase import get_supabase
import logging, json
from concurrent.futures import ThreadPoolExecutor, as_completed

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


def _get_tavily_client():
    from app.core.config import settings
    if not settings.TAVILY_API_KEY:
        return None
    try:
        from tavily import TavilyClient
        return TavilyClient(api_key=settings.TAVILY_API_KEY)
    except Exception:
        logger.warning("Tavily client init failed", exc_info=True)
        return None


@router.post("/{project_id}/add")
async def add_material(project_id: str, item: MaterialItem):
    """Add a new material item to a project's estimate.

    Runs a vendor search immediately so the new row already has
    product-page retail links (when found) plus trade-distributor quote
    links. Retail rows without a real product page are never invented.
    """
    analysis_id = _get_analysis_id(project_id)
    if not analysis_id:
        raise HTTPException(status_code=404, detail="No analysis found for project")

    db = get_supabase()

    proj = db.table("projects").select("region, city").eq("id", project_id).single().execute()
    city = (proj.data or {}).get("city", "") or ""

    from app.services.pricing_service import search_vendor_options
    tavily = _get_tavily_client()
    options = search_vendor_options(tavily, item.item_name, city=city)

    result = db.table("material_estimates").insert({
        "analysis_id": analysis_id,
        "item_name":   item.item_name,
        "category":    item.category,
        "quantity":    item.quantity,
        "unit":        item.unit,
        "unit_cost":   item.unit_cost,
        "total_cost":  item.total_cost,
        "vendor_options": json.dumps(options),
    }).execute()
    return result.data[0]


@router.patch("/{project_id}/items/{item_id}")
async def update_material(project_id: str, item_id: str, item: MaterialItem):
    """Update a material item."""
    db = get_supabase()
    result = db.table("material_estimates").update({
        "item_name":  item.item_name,
        "category":   item.category,
        "quantity":   item.quantity,
        "unit":       item.unit,
        "unit_cost":  item.unit_cost,
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
    """Search for real-time product-page prices for a specific material."""
    from app.services.pricing_service import search_vendor_options
    tavily = _get_tavily_client()
    options = search_vendor_options(tavily, req.item_name, city=req.city or "")
    return {"options": options}


@router.post("/{project_id}/refresh-all-prices")
async def refresh_all_prices(project_id: str):
    """
    Refresh vendor pricing for every material in a project.
    Runs per-item product-page searches in parallel and saves updated
    vendor_options + unit_cost to DB.
    """
    from app.services.pricing_service import search_vendor_options

    db = get_supabase()

    proj = db.table("projects").select("region, city").eq("id", project_id).single().execute()
    city = (proj.data or {}).get("city", "") if proj.data else ""

    analysis_id = _get_analysis_id(project_id)
    if not analysis_id:
        raise HTTPException(status_code=404, detail="No analysis found for project")

    rows = db.table("material_estimates").select("*").eq("analysis_id", analysis_id).execute()
    materials = rows.data or []
    if not materials:
        return {"updated": 0}

    tavily = _get_tavily_client()

    def _search(mat):
        name = mat.get("item_name", "")
        try:
            return mat, search_vendor_options(tavily, name, city=city)
        except Exception:
            logger.debug("per-item price refresh failed", exc_info=True)
            from app.services.pricing_service import _trade_distributor_entries
            return mat, _trade_distributor_entries(name)

    updates: list[tuple[dict, list]] = []
    with ThreadPoolExecutor(max_workers=min(8, len(materials))) as pool:
        futures = [pool.submit(_search, m) for m in materials]
        for fut in as_completed(futures):
            try:
                updates.append(fut.result())
            except Exception:
                logger.warning("price refresh task crashed", exc_info=True)

    updated = 0
    for mat, options in updates:
        retail = [o for o in options if not o.get("quote_only")]
        base_price = float(mat.get("unit_cost") or 0.0)
        new_unit_cost = retail[0]["price"] if retail else base_price
        db.table("material_estimates").update({
            "vendor_options": json.dumps(options),
            "unit_cost":      new_unit_cost,
            "total_cost":     round(float(mat.get("quantity", 1)) * new_unit_cost, 2),
        }).eq("id", mat["id"]).execute()
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
