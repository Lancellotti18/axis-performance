from fastapi import APIRouter, HTTPException
from app.core.supabase import get_supabase
import json

router = APIRouter()


@router.post("/{project_id}/parse3d")
async def parse_blueprint_3d(project_id: str):
    """Parse the project blueprint with Claude Vision. Returns detailed 3D scene data."""
    from app.services.blueprint_vision_service import parse_blueprint_3d as _parse

    db = get_supabase()

    # Get latest blueprint for this project
    bp = db.table("blueprints").select("id, file_type, status").eq("project_id", project_id).order("created_at", desc=True).limit(1).execute()
    if not bp.data:
        raise HTTPException(status_code=404, detail="No blueprint found for this project")

    blueprint = bp.data[0]
    file_type = (blueprint.get("file_type") or "").lower()

    if file_type == "pdf":
        raise HTTPException(
            status_code=422,
            detail="PDF blueprints are not supported for 3D parsing. Please upload a PNG or JPG image of your floor plan."
        )

    try:
        scene_data = await _parse(blueprint["id"])
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"3D parse failed: {str(e)}")

    # Cache result in analyses table
    try:
        analysis = db.table("analyses").select("id").eq("blueprint_id", blueprint["id"]).limit(1).execute()
        if analysis.data:
            db.table("analyses").update({"scene_3d": json.dumps(scene_data)}).eq("id", analysis.data[0]["id"]).execute()
    except Exception:
        pass  # Caching failure is non-critical

    return scene_data


@router.get("/{project_id}/model3d")
async def get_model3d(project_id: str):
    """Get cached 3D scene data for a project."""
    db = get_supabase()

    bp = db.table("blueprints").select("id").eq("project_id", project_id).order("created_at", desc=True).limit(1).execute()
    if not bp.data:
        return {"scene_data": None}

    analysis = db.table("analyses").select("scene_3d").eq("blueprint_id", bp.data[0]["id"]).limit(1).execute()
    if not analysis.data:
        return {"scene_data": None}

    scene_3d = analysis.data[0].get("scene_3d")
    if not scene_3d:
        return {"scene_data": None}

    if isinstance(scene_3d, str):
        scene_3d = json.loads(scene_3d)

    return {"scene_data": scene_3d}
