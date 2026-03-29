"""
Main AI analysis pipeline.
Claude Vision is the primary engine — it receives the original image and produces
a complete structural analysis + full materials list directly.
OCR/scale/object-detection results are passed as hints if available, but Claude
never depends on them — it will always return a usable result from the image alone.
"""
import cv2
import numpy as np
import os
import anthropic
from app.core.config import settings
from app.core.supabase import get_supabase
import json
import uuid

client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)


def run_analysis_pipeline(blueprint_id: str) -> dict:
    db = get_supabase()

    # 1. Fetch blueprint metadata
    blueprint = db.table("blueprints").select("*").eq("id", blueprint_id).single().execute().data
    project_id = blueprint["project_id"]

    # 2. Download original file bytes
    file_key = blueprint["file_url"]
    image_bytes = download_file(file_key)
    filename = file_key.split("/")[-1].split("?")[0]

    # 3. Convert to JPEG for Claude (handle PDF + images)
    jpeg_bytes = to_jpeg(image_bytes, filename)

    # 4. Optional preprocessing hints — non-fatal if any step fails
    ocr_results = {}
    detections = {}
    rooms_hint = []
    try:
        from app.services.ocr import extract_text_and_dimensions
        gray = preprocess_to_gray(jpeg_bytes)
        ocr_results = extract_text_and_dimensions(gray)
    except Exception:
        pass
    try:
        from app.services.scale_detector import detect_scale
        from app.services.object_detector import detect_objects
        from app.services.room_reconstructor import reconstruct_rooms
        gray = preprocess_to_gray(jpeg_bytes)
        scale = detect_scale(ocr_results, gray)
        detections = detect_objects(gray)
        rooms_hint = reconstruct_rooms(gray, scale, detections)
    except Exception:
        pass

    # 5. Claude Vision — primary analysis + full materials list
    structured_data = claude_analyze(jpeg_bytes, rooms_hint, detections, ocr_results)

    # 6. Save analysis
    analysis_id = save_analysis(db, blueprint_id, structured_data)

    # 7. Get project region
    project = db.table("projects").select("region,city").eq("id", project_id).limit(1).execute()
    project_data = project.data[0] if project.data else {}
    region = project_data.get("region", "US-TX")

    # 8. Use Claude's materials list if provided, else run estimator
    materials = structured_data.get("materials", [])
    if not materials:
        try:
            from app.services.estimator import MaterialEstimator
            estimator = MaterialEstimator()
            materials = estimator.estimate_all(structured_data)
        except Exception:
            materials = []

    # 9. Enrich with real-time pricing — non-fatal
    try:
        from app.services.pricing_service import enrich_materials_with_pricing
        materials = enrich_materials_with_pricing(materials, region)
    except Exception:
        pass

    # 10. Cost estimation
    try:
        from app.services.cost_engine import CostEngine
        cost_engine = CostEngine()
        costs = cost_engine.calculate(materials, region)
    except Exception:
        total = sum(m.get("total_cost", 0) for m in materials)
        costs = {
            "materials_total": total,
            "labor_total": round(total * 0.35, 2),
            "markup_pct": 15,
            "overhead_pct": 10,
            "grand_total": round(total * 1.25 * 1.1, 2),
            "region": region,
            "labor_hours": 0,
        }

    # 11. Save materials + costs
    save_estimates(db, analysis_id, project_id, materials, costs)

    return {"analysis_id": analysis_id}


# ── Image utilities ────────────────────────────────────────────────────────────

def to_jpeg(image_bytes: bytes, filename: str = "") -> bytes:
    """Convert any supported image/PDF to JPEG bytes."""
    name = filename.lower()
    if name.endswith(".pdf") or image_bytes[:4] == b"%PDF":
        try:
            import fitz
            doc = fitz.open(stream=image_bytes, filetype="pdf")
            page = doc[0]
            pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0))
            return pix.tobytes("jpeg")
        except Exception as e:
            raise RuntimeError(f"PDF conversion failed: {e}")

    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("Could not decode image — unsupported format")
    _, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return buf.tobytes()


def preprocess_to_gray(jpeg_bytes: bytes) -> np.ndarray:
    nparr = np.frombuffer(jpeg_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    return clahe.apply(gray)


def download_file(key: str) -> bytes:
    """Download file from Supabase Storage, local disk, or S3."""
    import requests as _requests

    if key.startswith("http://") or key.startswith("https://"):
        if "supabase.co/storage" in key:
            db = get_supabase()
            import re as _re
            m = _re.search(r'/(?:object/)?(?:public|sign)/blueprints/(.+?)(?:\?|$)', key)
            if m:
                storage_path = m.group(1)
                data = db.storage.from_("blueprints").download(storage_path)
                return data
        resp = _requests.get(key, timeout=60)
        resp.raise_for_status()
        return resp.content

    if not settings.AWS_ACCESS_KEY_ID:
        local_path = f"/app/uploads/{key}"
        if not os.path.exists(local_path):
            raise RuntimeError(f"Dev file not found: {local_path}")
        with open(local_path, "rb") as f:
            return f.read()

    import boto3
    s3_client = boto3.client(
        "s3",
        endpoint_url=settings.S3_ENDPOINT_URL or None,
        aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
        aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
    )
    obj = s3_client.get_object(Bucket=settings.S3_BUCKET_NAME, Key=key)
    return obj["Body"].read()


# ── Claude analysis ────────────────────────────────────────────────────────────

def claude_analyze(jpeg_bytes: bytes, rooms_hint: list, detections: dict, ocr: dict) -> dict:
    """
    Claude Vision is the primary analysis engine.
    It receives the original image and produces:
    - Structural analysis (rooms, walls, openings, electrical, plumbing)
    - Complete materials list with quantities and unit costs
    Hint data from OCR/YOLO is provided as context but Claude decides the final output.
    """
    import base64
    image_b64 = base64.standard_b64encode(jpeg_bytes).decode("utf-8")

    hint_block = ""
    if rooms_hint or detections or ocr:
        hint_block = f"""
Pre-detection hints (use as reference only — override with what you see in the image):
- Detected rooms: {json.dumps(rooms_hint)}
- Detected objects: {json.dumps(detections)}
- OCR text: {json.dumps(ocr)}
"""

    prompt = f"""You are an expert construction estimator analyzing a blueprint or construction image.
{hint_block}
Analyze the image carefully and return a single JSON object with ALL of the following fields.
Even if the image is a photo rather than a formal blueprint, make your best professional estimate.

{{
  "rooms": [
    {{"name": "Kitchen", "sqft": 200.0, "dimensions": {{"width": 16.0, "height": 12.5}}}}
  ],
  "walls": [
    {{"length": 16.0, "thickness": 0.5, "type": "interior"}}
  ],
  "openings": [
    {{"type": "door", "width": 3.0, "height": 6.8}},
    {{"type": "window", "width": 3.0, "height": 4.0}}
  ],
  "electrical": [
    {{"type": "outlet", "count": 12}},
    {{"type": "switch", "count": 8}},
    {{"type": "light_fixture", "count": 10}}
  ],
  "plumbing": [
    {{"type": "sink", "count": 2}},
    {{"type": "toilet", "count": 2}},
    {{"type": "shower", "count": 1}}
  ],
  "total_sqft": 1850.0,
  "confidence": 0.85,
  "notes": "Brief description of the structure",
  "materials": [
    {{
      "category": "lumber",
      "item_name": "2x4x8 Stud",
      "quantity": 120,
      "unit": "each",
      "unit_cost": 8.50,
      "total_cost": 1020.00
    }}
  ]
}}

Material categories to include (cover all that apply):
lumber, sheathing, drywall, insulation, roofing, concrete, flooring,
doors_windows, electrical, plumbing, finishing

For the materials list:
- Be thorough and realistic — include every major material category needed
- Base quantities on the detected square footage and room count
- Use current US market unit costs
- Include framing lumber, sheathing, drywall, insulation, roofing, flooring,
  doors, windows, electrical rough-in, plumbing rough-in, and finishing materials
- If you cannot determine exact quantities from the image, use reasonable estimates
  for a structure of the detected size

Return ONLY the JSON object, no markdown, no explanation."""

    response = client.messages.create(
        model="claude-opus-4-6",
        max_tokens=8192,
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
    # Strip markdown fences if present
    if "```" in text:
        start = text.find("{", text.find("```"))
        end = text.rfind("}") + 1
        text = text[start:end]
    else:
        start = text.find("{")
        end = text.rfind("}") + 1
        if start != -1:
            text = text[start:end]

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Last resort — return minimal valid structure
        return {
            "rooms": [], "walls": [], "openings": [],
            "electrical": [], "plumbing": [],
            "total_sqft": 0, "confidence": 0.1,
            "notes": "Could not parse Claude response",
            "materials": [],
        }


# ── DB persistence ─────────────────────────────────────────────────────────────

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

    if materials:
        rows = []
        for item in materials:
            row = {k: v for k, v in item.items() if k != "vendor_options"}
            row["analysis_id"] = analysis_id
            row["vendor_options"] = _json.dumps(item.get("vendor_options", []))
            rows.append(row)
        db.table("material_estimates").insert(rows).execute()

    # Save cost estimate — delete existing first to avoid unique constraint issues
    try:
        db.table("cost_estimates").delete().eq("project_id", project_id).execute()
    except Exception:
        pass
    db.table("cost_estimates").insert({
        "project_id": project_id,
        "materials_total": costs.get("materials_total", 0),
        "labor_total": costs.get("labor_total", 0),
        "markup_pct": costs.get("markup_pct", 15),
        "overhead_pct": costs.get("overhead_pct", 10),
        "grand_total": costs.get("grand_total", 0),
        "region": costs.get("region", "US-TX"),
        "labor_hours": costs.get("labor_hours", 0),
    }).execute()
