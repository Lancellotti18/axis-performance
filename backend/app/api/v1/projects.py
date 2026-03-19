from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from typing import Optional
from app.core.supabase import get_supabase

router = APIRouter()


class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None
    region: Optional[str] = "US-TX"
    blueprint_type: Optional[str] = "residential"


@router.get("/")
async def list_projects(user_id: str = Query(...)):
    db = get_supabase()
    result = (
        db.table("projects")
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return result.data or []


@router.post("/")
async def create_project(payload: ProjectCreate, user_id: str = Query(...)):
    db = get_supabase()
    # Ensure profile exists (auto-create if missing)
    db.table("profiles").upsert({"id": user_id}, on_conflict="id").execute()
    result = db.table("projects").insert({
        "user_id": user_id,
        "name": payload.name,
        "description": payload.description,
        "region": payload.region,
        "blueprint_type": payload.blueprint_type,
        "status": "pending",
    }).execute()
    return result.data[0]


@router.get("/{project_id}")
async def get_project(project_id: str):
    db = get_supabase()
    result = (
        db.table("projects")
        .select("*, blueprints(*)")
        .eq("id", project_id)
        .single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Project not found")
    return result.data


@router.patch("/{project_id}")
async def update_project(project_id: str, payload: dict):
    db = get_supabase()
    allowed = {k: v for k, v in payload.items() if k in ("name", "description", "region")}
    if not allowed:
        raise HTTPException(status_code=400, detail="No valid fields to update")
    result = db.table("projects").update(allowed).eq("id", project_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Project not found")
    return result.data[0]


@router.delete("/{project_id}")
async def delete_project(project_id: str):
    db = get_supabase()
    db.table("projects").delete().eq("id", project_id).execute()
    return {"success": True}
