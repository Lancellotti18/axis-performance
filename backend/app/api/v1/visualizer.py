"""
visualizer.py — AI Home Visualizer endpoint
============================================
POST /visualizer/generate  — multipart: image file + description + city + state
"""
from __future__ import annotations

import logging
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

router = APIRouter()
log = logging.getLogger(__name__)

ALLOWED_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}


@router.post("/generate")
async def generate_home_visualization(
    file:        UploadFile = File(...),
    description: str        = Form(...),
    city:        str        = Form(""),
    state:       str        = Form(""),
):
    """
    Upload a property photo and describe the changes you want to see.
    Returns an AI-generated image of the changes plus a sourced cost estimate.

    - file: JPG / PNG / WebP photo of the property (max 10 MB)
    - description: plain-English description of desired changes
      e.g. "replace brick with stone veneer, add black shutters and a covered porch"
    - city / state: for localised cost pricing
    """
    if not description.strip():
        raise HTTPException(status_code=422, detail="Description is required.")

    content_type = (file.content_type or "").lower()
    if content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=422,
            detail="File must be a JPG, PNG, or WebP image."
        )

    image_bytes = await file.read()
    if len(image_bytes) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large. Max 10 MB.")
    if len(image_bytes) < 1024:
        raise HTTPException(status_code=422, detail="Image file appears to be empty or corrupt.")

    from app.services.visualizer_service import generate_visualization
    import os
    log.info(f"[visualizer] HF key present: {bool(os.environ.get('HUGGINGFACE_API_KEY'))}, starts: {os.environ.get('HUGGINGFACE_API_KEY','')[:6]}")
    try:
        result = await generate_visualization(
            image_bytes=image_bytes,
            content_type=content_type,
            description=description.strip(),
            city=city.strip(),
            state=state.strip().upper(),
        )
    except ValueError as e:
        log.error(f"[visualizer] ValueError: {e}")
        raise HTTPException(status_code=422, detail=str(e))
    except TimeoutError:
        raise HTTPException(
            status_code=504,
            detail="Image generation timed out. Please try again — GPU cold starts can take up to 60 seconds."
        )
    except Exception as e:
        log.error(f"[visualizer] Unexpected error: {e}")
        raise HTTPException(status_code=500, detail=f"Visualization failed: {e}")

    return result
