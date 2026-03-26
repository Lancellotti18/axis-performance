"""
Main AI analysis pipeline.
Orchestrates: preprocessing -> OCR -> scale detection -> object detection -> Claude validation -> estimation
"""
import cv2
import numpy as np
import os
from PIL import Image
import anthropic
from app.core.config import settings
from app.core.supabase import get_supabase
from app.services.ocr import extract_text_and_dimensions
from app.services.scale_detector import detect_scale
from app.services.object_detector import detect_objects
from app.services.room_reconstructor import reconstruct_rooms
from app.services.estimator import MaterialEstimator
from app.services.cost_engine import CostEngine
import boto3
import io
import json
import uuid

s3 = boto3.client("s3")
client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)


def run_analysis_pipeline(blueprint_id: str) -> dict:
    db = get_supabase()

    # 1. Fetch blueprint metadata
    blueprint = db.table("blueprints").select("*").eq("id", blueprint_id).single().execute().data
    project_id = blueprint["project_id"]

    # 2. Download file (local dev storage or S3)
    file_key = blueprint["file_url"]
    image_bytes = download_file(file_key)
    filename = file_key.split("/")[-1]
    image = preprocess_image(image_bytes, filename)

    # 3. OCR — extract text, labels, dimensions
    ocr_results = extract_text_and_dimensions(image)

    # 4. Scale detection
    scale = detect_scale(ocr_results, image)  # pixels per foot

    # 5. Object detection (YOLOv8)
    detections = detect_objects(image)

    # 6. Room reconstruction from wall lines
    rooms = reconstruct_rooms(image, scale, detections)

    # 7. Claude API validation + enrichment
    # Convert processed numpy image back to JPEG bytes for Claude
    import cv2 as _cv2
    _, jpeg_buf = _cv2.imencode(".jpg", image)
    jpeg_bytes = jpeg_buf.tobytes()
    structured_data = claude_validate(jpeg_bytes, rooms, detections, ocr_results)

    # 8. Save analysis
    analysis_id = save_analysis(db, blueprint_id, structured_data)

    # 9. Material estimation
    estimator = MaterialEstimator()
    materials = estimator.estimate_all(structured_data)

    # 10. Get region for pricing
    project = db.table("projects").select("*").eq("id", project_id).single().execute().data
    region = project.get("region", "US-TX")

    # 11. Enrich with real-time pricing from Tavily
    from app.services.pricing_service import enrich_materials_with_pricing
    materials = enrich_materials_with_pricing(materials, region)

    # 12. Cost estimation
    cost_engine = CostEngine()
    costs = cost_engine.calculate(materials, region)

    # 13. Save materials + costs
    save_estimates(db, analysis_id, project_id, materials, costs)

    return {"analysis_id": analysis_id}


def preprocess_image(image_bytes: bytes, filename: str = "") -> np.ndarray:
    # PDF → convert first page to image
    if filename.lower().endswith(".pdf") or image_bytes[:4] == b"%PDF":
        try:
            import fitz  # PyMuPDF
            doc = fitz.open(stream=image_bytes, filetype="pdf")
            page = doc[0]
            mat = fitz.Matrix(2.0, 2.0)  # 2x zoom for better resolution
            pix = page.get_pixmap(matrix=mat)
            image_bytes = pix.tobytes("jpeg")
        except Exception as e:
            raise RuntimeError(f"PDF conversion failed: {e}")

    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("Could not decode image — unsupported format")
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    return enhanced


def download_file(key: str) -> bytes:
    """Download file from Supabase Storage (URL), local disk, or S3."""
    import requests as _requests

    # Supabase Storage or any HTTP URL
    if key.startswith("http://") or key.startswith("https://"):
        resp = _requests.get(key, timeout=60)
        resp.raise_for_status()
        return resp.content

    # Dev mode: read from local disk
    if not settings.AWS_ACCESS_KEY_ID:
        local_path = f"/app/uploads/{key}"
        if not os.path.exists(local_path):
            raise RuntimeError(f"Dev file not found: {local_path}")
        with open(local_path, "rb") as f:
            return f.read()

    # Production: download from S3/R2
    s3_client = boto3.client(
        "s3",
        endpoint_url=settings.S3_ENDPOINT_URL or None,
        aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
        aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
    )
    obj = s3_client.get_object(Bucket=settings.S3_BUCKET_NAME, Key=key)
    return obj["Body"].read()


def claude_validate(image_bytes: bytes, rooms: list, detections: dict, ocr: dict) -> dict:
    """Use Claude Vision to validate and enrich AI detections."""
    import base64
    image_b64 = base64.standard_b64encode(image_bytes).decode("utf-8")

    prompt = f"""You are analyzing a construction blueprint.

The automated system has detected:
- Rooms: {json.dumps(rooms, indent=2)}
- Objects: {json.dumps(detections, indent=2)}
- OCR text: {json.dumps(ocr, indent=2)}

Please validate these detections and return a corrected JSON with:
{{
  "rooms": [{{ "name": str, "sqft": float, "dimensions": {{ "width": float, "height": float }} }}],
  "walls": [{{ "length": float, "thickness": float, "type": str }}],
  "openings": [{{ "type": "door"|"window", "width": float, "height": float }}],
  "electrical": [{{ "type": str, "count": int }}],
  "plumbing": [{{ "type": str, "count": int }}],
  "total_sqft": float,
  "confidence": float,
  "notes": str
}}

Return ONLY valid JSON."""

    response = client.messages.create(
        model="claude-opus-4-6",
        max_tokens=4096,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": image_b64,
                        },
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
    )

    text = response.content[0].text.strip()
    # Extract JSON if Claude wrapped it in markdown code blocks
    if "```" in text:
        start = text.find("{", text.find("```"))
        end = text.rfind("}") + 1
        text = text[start:end]
    elif text.startswith("{"):
        pass
    else:
        start = text.find("{")
        end = text.rfind("}") + 1
        if start != -1:
            text = text[start:end]
    return json.loads(text)


def save_analysis(db, blueprint_id: str, data: dict) -> str:
    result = db.table("analyses").insert({
        "blueprint_id": blueprint_id,
        "rooms": data.get("rooms", []),
        "walls": data.get("walls", []),
        "openings": data.get("openings", []),
        "electrical": data.get("electrical", []),
        "plumbing": data.get("plumbing", []),
        "total_sqft": data.get("total_sqft", 0),
        "confidence": data.get("confidence", 0),
        "raw_detections": data,
    }).execute()
    return result.data[0]["id"]


def save_estimates(db, analysis_id: str, project_id: str, materials: list, costs: dict):
    import json as _json
    rows = []
    for item in materials:
        row = {k: v for k, v in item.items() if k != "vendor_options"}
        row["analysis_id"] = analysis_id
        row["vendor_options"] = _json.dumps(item.get("vendor_options", []))
        rows.append(row)
    db.table("material_estimates").insert(rows).execute()
    db.table("cost_estimates").insert({
        "project_id": project_id,
        "materials_total": costs["materials_total"],
        "labor_total": costs["labor_total"],
        "markup_pct": costs["markup_pct"],
        "overhead_pct": costs["overhead_pct"],
        "grand_total": costs["grand_total"],
        "region": costs["region"],
        "labor_hours": costs["labor_hours"],
    }).execute()
