"""
visualizer.py — AI Home Visualizer endpoint
============================================
POST /visualizer/generate  — multipart: image file + description + city + state
"""
from __future__ import annotations

import logging
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from app.core.auth import require_user

router = APIRouter()
log = logging.getLogger(__name__)

# Raised from 10 MB: a scanned PDF or a full-resolution HEIC routinely exceeds
# it, and the file is downscaled to 2048px before anything expensive happens.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


@router.post("/generate")
async def generate_home_visualization(
    file:        UploadFile = File(...),
    description: str        = Form(...),
    city:        str        = Form(""),
    state:       str        = Form(""),
    user:        dict       = Depends(require_user),
):
    """
    Upload a property photo and describe the changes you want to see.
    Returns an AI-generated image of the changes plus a sourced cost estimate.

    - file: a photo of the property — JPG, PNG, WebP, HEIC (iPhone), GIF, BMP,
      TIFF — or a PDF, in which case the first page is used (max 25 MB)
    - description: plain-English description of desired changes
      e.g. "replace brick with stone veneer, add black shutters and a covered porch"
    - city / state: for localised cost pricing
    """
    if not description.strip():
        raise HTTPException(status_code=422, detail="Description is required.")

    raw = await file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large. Max 25 MB.")
    if len(raw) < 1024:
        raise HTTPException(status_code=422, detail="That file appears to be empty or corrupt.")

    # Decided from the bytes, not the browser's Content-Type. This used to be an
    # allow-list of three MIME types, so an iPhone photo — which the page's own
    # file picker offered — was rejected with "must be a JPG, PNG, or WebP".
    from app.services.upload_images import is_pdf, normalize_to_images
    images, _ = normalize_to_images(raw, max_pages=1)
    if not images:
        raise HTTPException(
            status_code=422,
            detail="Couldn't read that file. Upload a photo of the house "
                   "(JPG, PNG, HEIC, WebP and most other image types) or a PDF.",
        )
    image_bytes, content_type = images[0]
    from_pdf = is_pdf(raw)

    from app.services.visualizer_service import generate_visualization
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

    # The converted photo goes back too. The page previews and attaches the
    # "before" photo to reports from it, because a browser cannot display a PDF
    # page — or, outside Safari, a HEIC — from the raw upload.
    import base64
    result["source_image_url"] = (
        f"data:{content_type};base64,{base64.b64encode(image_bytes).decode()}")
    result["source_from_pdf"] = from_pdf
    return result
