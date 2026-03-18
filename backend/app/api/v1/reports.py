from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from app.core.supabase import get_supabase
from app.services.report_generator import generate_pdf_report
import io

router = APIRouter()


@router.post("/{project_id}/generate")
async def generate_report(project_id: str):
    db = get_supabase()
    project = db.table("projects").select("*").eq("id", project_id).single().execute()
    if not project.data:
        raise HTTPException(status_code=404, detail="Project not found")
    # Queue report generation
    return {"status": "generating", "project_id": project_id}


@router.get("/{project_id}/download")
async def download_report(project_id: str, format: str = "pdf"):
    db = get_supabase()
    report = db.table("reports").select("*").eq("project_id", project_id).single().execute()
    if not report.data:
        raise HTTPException(status_code=404, detail="Report not found — generate it first")
    # Return the file URL for download
    key = report.data.get(f"{format}_url")
    return {"download_url": key}
