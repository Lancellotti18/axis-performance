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
    """Add a new material item to a project's estimate."""
    analysis_id = _get_analysis_id(project_id)
    if not analysis_id:
        raise HTTPException(status_code=404, detail="No analysis found for project")
    db = get_supabase()
    result = db.table("material_estimates").insert({
        "analysis_id": analysis_id,
        "item_name": item.item_name,
        "category": item.category,
        "quantity": item.quantity,
        "unit": item.unit,
        "unit_cost": item.unit_cost,
        "total_cost": item.total_cost,
        "vendor_options": json.dumps([]),
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
        from app.services.pricing_service import _fallback_options
        return {"options": _fallback_options(req.item_name, req.unit_cost)}

    try:
        from tavily import TavilyClient
        client = TavilyClient(api_key=settings.TAVILY_API_KEY)
        options = _search_material_prices(client, req.item_name, req.category, req.region, req.unit_cost, city=req.city or "")
        return {"options": options}
    except Exception as e:
        logger.warning(f"Price search failed: {e}")
        from app.services.pricing_service import _fallback_options
        return {"options": _fallback_options(req.item_name, req.unit_cost)}


@router.post("/validate-link")
async def validate_material_link(payload: dict):
    """Validate a vendor product URL."""
    from app.services.link_validator import validate_product_url
    url = payload.get("url", "")
    product_name = payload.get("product_name", "")
    expected_price = float(payload.get("expected_price", 0))
    result = validate_product_url(url, product_name, expected_price)
    return result
