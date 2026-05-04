"""
Main AI analysis pipeline.
LLM Vision (Gemini Flash / Groq / Claude fallback) is the primary engine.
OCR/scale/object-detection results are passed as hints if available.
"""
import cv2
import logging
import numpy as np
import os
import re
from app.core.config import settings
from app.core.supabase import get_supabase
from app.services.llm import llm_vision_sync
import json
import uuid

logger = logging.getLogger(__name__)


def run_analysis_pipeline(blueprint_id: str) -> dict:
    logger.info(f"START blueprint_id={blueprint_id}")
    db = get_supabase()

    # 1. Fetch blueprint metadata
    logger.info("fetching metadata")
    blueprint = db.table("blueprints").select("*").eq("id", blueprint_id).single().execute().data
    project_id = blueprint["project_id"]
    file_key = blueprint["file_url"]
    logger.info(f"file_key={file_key[:80]}")

    # 2. Download original file bytes
    logger.info("downloading file")
    image_bytes = download_file(file_key)
    filename = file_key.split("/")[-1].split("?")[0]
    logger.debug(f"downloaded {len(image_bytes)} bytes, filename={filename}")

    # 3. Convert to JPEG
    logger.info("converting to jpeg")
    jpeg_bytes = to_jpeg(image_bytes, filename)
    logger.debug(f"jpeg ready {len(jpeg_bytes)} bytes")

    # 4. Optional preprocessing hints — non-fatal if any step fails
    ocr_results = {}
    detections = {}
    rooms_hint = []
    scale_source = "none"           # 'ocr' (measured), 'fallback' (guessed), or 'none' (CV failed)
    measured_sqft = 0.0             # only trustworthy when scale_source == 'ocr'
    try:
        from app.services.ocr import extract_text_and_dimensions
        gray = preprocess_to_gray(jpeg_bytes)
        ocr_results = extract_text_and_dimensions(gray)
    except Exception:
        logger.debug("OCR hint extraction failed (non-fatal)", exc_info=True)
        pass
    try:
        from app.services.scale_detector import detect_scale_with_source
        from app.services.object_detector import detect_objects
        from app.services.room_reconstructor import reconstruct_rooms
        gray = preprocess_to_gray(jpeg_bytes)
        scale, scale_source = detect_scale_with_source(ocr_results, gray)
        detections = detect_objects(gray)
        rooms_hint = reconstruct_rooms(gray, scale, detections)
        if scale_source == "ocr" and rooms_hint:
            measured_sqft = sum(float(r.get("sqft") or 0) for r in rooms_hint)
            logger.info(
                "scale detected from OCR (%.2f px/ft); measured_sqft=%.0f from %d rooms",
                scale, measured_sqft, len(rooms_hint),
            )
    except Exception:
        logger.debug("scale/object/room hint detection failed (non-fatal)", exc_info=True)
        pass

    # 5. LLM Vision — primary analysis + full materials list. When the CV
    # pipeline produced a real measurement, hand it to the LLM as an
    # authoritative number (not just a hint) and override afterwards if the
    # LLM still drifts.
    logger.info("calling llm_vision_sync")
    structured_data = claude_analyze(
        jpeg_bytes, rooms_hint, detections, ocr_results,
        measured_sqft=measured_sqft,
    )
    logger.info(f"llm done, confidence={structured_data.get('confidence')}")

    # If we have a CV-measured sqft, trust it over the LLM's eyeball estimate.
    # The LLM is told to use it, but often anchors back to the prompt example.
    # Only override when the LLM's number is wildly off (>30% delta) — small
    # disagreements may reflect rooms outside the bounding contour.
    if measured_sqft > 0:
        llm_sqft = float(structured_data.get("total_sqft") or 0)
        if llm_sqft <= 0 or abs(llm_sqft - measured_sqft) / measured_sqft > 0.30:
            logger.info(
                "overriding LLM total_sqft=%s with CV-measured=%.0f (delta too large)",
                llm_sqft, measured_sqft,
            )
            structured_data["total_sqft"] = round(measured_sqft, 1)
            structured_data["sqft_source"] = "measured"
        else:
            structured_data["sqft_source"] = "llm_validated"
    else:
        structured_data["sqft_source"] = "llm_estimate"

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
            logger.debug("MaterialEstimator fallback failed, using empty list", exc_info=True)
            materials = []

    # 9. Enrich with real-time pricing — non-fatal
    try:
        from app.services.pricing_service import enrich_materials_with_pricing
        materials = enrich_materials_with_pricing(materials, region)
    except Exception:
        logger.debug("pricing enrichment failed (non-fatal)", exc_info=True)
        pass

    # 9.5 Reconcile total_cost = unit_cost × quantity. The LLM emits unit_cost,
    # quantity, and total_cost as independent fields and frequently fails the
    # arithmetic; pricing enrichment only recomputes for items it priced
    # successfully (the trade-distributor fallback leaves the row untouched).
    # Everything downstream — saved line items, cost engine, compliance check —
    # depends on these matching, so force the relationship here.
    for m in materials:
        try:
            unit = float(m.get("unit_cost") or 0)
            qty = float(m.get("quantity") or 0)
        except (TypeError, ValueError):
            continue
        if unit > 0 and qty > 0:
            m["total_cost"] = round(unit * qty, 2)

    # 10. Cost estimation
    try:
        from app.services.cost_engine import CostEngine
        cost_engine = CostEngine()
        total_sqft = float(structured_data.get("total_sqft") or 0)
        building_type = structured_data.get("building_type") or "residential"
        costs = cost_engine.calculate(
            materials, region, total_sqft=total_sqft, building_type=building_type,
        )
    except Exception:
        logger.warning("CostEngine failed, using simple total-based fallback", exc_info=True)
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

def _resize_if_needed(jpeg_bytes: bytes, max_bytes: int = 3_500_000) -> bytes:
    """Resize JPEG down if it exceeds Gemini's ~4MB inline image limit."""
    if len(jpeg_bytes) <= max_bytes:
        return jpeg_bytes
    nparr = np.frombuffer(jpeg_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return jpeg_bytes
    h, w = img.shape[:2]
    scale = 0.75
    while True:
        new_w, new_h = int(w * scale), int(h * scale)
        resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
        _, buf = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 85])
        data = buf.tobytes()
        if len(data) <= max_bytes or scale < 0.2:
            logger.debug(f"resized image {w}x{h} → {new_w}x{new_h} ({len(data)} bytes)")
            return data
        scale *= 0.75


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

def claude_analyze(
    jpeg_bytes: bytes,
    rooms_hint: list,
    detections: dict,
    ocr: dict,
    measured_sqft: float = 0.0,
) -> dict:
    """
    Claude Vision is the primary analysis engine.
    It receives the original image and produces:
    - Structural analysis (rooms, walls, openings, electrical, plumbing)
    - Complete materials list with quantities and unit costs

    When measured_sqft > 0, the CV pipeline parsed a real scale string off
    the drawing (e.g., '1/4" = 1\\'-0"') and computed an authoritative
    square footage from the wall contours. We pass that to the LLM as a
    hard constraint, not a hint — guessing the size is the single biggest
    source of error in the estimate.
    """
    hint_block = ""
    if rooms_hint or detections or ocr:
        hint_block = f"""
Pre-detection hints (use as reference only — override with what you see in the image):
- Detected rooms: {json.dumps(rooms_hint)}
- Detected objects: {json.dumps(detections)}
- OCR text: {json.dumps(ocr)}
"""

    measured_block = ""
    if measured_sqft and measured_sqft > 0:
        measured_block = f"""
AUTHORITATIVE MEASUREMENT — DO NOT OVERRIDE:
The drawing's scale was parsed from an OCR-detected scale string and the
total floor area was computed from the wall contours: total_sqft = {measured_sqft:.0f}.
Use exactly this value for the `total_sqft` field. Size your materials
list to this footprint. Do not substitute the example value or your own
visual estimate — the measurement is more accurate than a vision-only guess.
"""

    prompt = f"""You are an expert construction estimator analyzing a blueprint or construction image.
{hint_block}{measured_block}
FIRST decide what kind of structure this is. The estimate must match the building type — a 10,000 sqft warehouse is NOT priced like a 10,000 sqft house.

building_type values (pick the closest):
- "residential"   — single-family home, townhouse, duplex
- "multifamily"   — apartment / condo building
- "warehouse"     — steel-frame industrial shell, slab-on-grade, metal panels, overhead doors
- "industrial"    — manufacturing, processing, heavier MEP than warehouse
- "office"        — commercial office, finished interiors
- "retail"        — storefront, restaurant, light commercial
- "mixed_use"     — ground-floor commercial + residential above
- "other"         — explain in notes

Total-cost benchmarks (US national avg, all-in including labor + markup). Your materials list × 1.5 (rough labor+markup) should land in this band:
- residential:   $150 – $300 / sqft
- multifamily:   $180 – $320 / sqft
- warehouse:     $40  – $90  / sqft  (shell only $25–60, +office finish brings it up)
- industrial:    $90  – $200 / sqft
- office:        $180 – $400 / sqft
- retail:        $150 – $350 / sqft
- mixed_use:     $200 – $400 / sqft

If the image shows a large open floor plan with no interior rooms, big rectangular footprint, dock doors, or steel column grid → it's a warehouse / industrial — DO NOT estimate residential framing, drywall, copper plumbing, or asphalt shingles for it. Use steel framing, metal roof + wall panels, slab-on-grade concrete (4–6 in thick), overhead doors, fire sprinklers, industrial electrical (3-phase service typical), and minimal interior partitions.

Return a single JSON object with ALL of the following fields:

{{
  "building_type": "warehouse",
  "rooms": [
    {{"name": "Main Warehouse Floor", "sqft": 9000.0, "dimensions": {{"width": 100.0, "height": 90.0}}}},
    {{"name": "Office", "sqft": 1000.0, "dimensions": {{"width": 25.0, "height": 40.0}}}}
  ],
  "walls": [
    {{"length": 100.0, "thickness": 0.5, "type": "exterior_metal_panel"}}
  ],
  "openings": [
    {{"type": "door", "width": 12.0, "height": 14.0}},
    {{"type": "window", "width": 4.0, "height": 4.0}}
  ],
  "electrical": [
    {{"type": "high_bay_light", "count": 24}},
    {{"type": "outlet", "count": 20}}
  ],
  "plumbing": [
    {{"type": "sink", "count": 1}},
    {{"type": "toilet", "count": 2}}
  ],
  "total_sqft": 10000.0,
  "confidence": 0.85,
  "notes": "Pre-engineered metal building with attached office",
  "materials": [
    {{
      "category": "structural_steel",
      "item_name": "Pre-engineered steel frame (rigid frames, purlins, girts)",
      "quantity": 10000,
      "unit": "sqft_building",
      "unit_cost": 9.00,
      "total_cost": 90000.00
    }},
    {{
      "category": "concrete",
      "item_name": "Slab-on-grade 5in with rebar",
      "quantity": 10000,
      "unit": "sqft",
      "unit_cost": 6.50,
      "total_cost": 65000.00
    }}
  ]
}}

Residential example shape (do NOT use for warehouses):
- rooms: Kitchen / Bedroom / Bath, ~200 sqft each
- materials: 2x4 studs, OSB sheathing, drywall, batt insulation, asphalt shingles, copper supply, double-hung windows

Material categories — use ALL that apply for the detected building type:
- residential / multifamily: lumber, sheathing, drywall, insulation, roofing (asphalt), concrete (footings + slab), flooring, doors_windows, electrical, plumbing, finishing
- warehouse / industrial: structural_steel, metal_panels (wall + roof), concrete (slab + footings), overhead_doors, fire_protection (sprinklers), electrical (3-phase, high-bay), plumbing (minimal), insulation (rigid + roof blanket), finishing (office only)
- office / retail: structural_steel OR wood, metal_deck or sheathing, drywall, ceiling (acoustic tile), flooring (carpet/LVT/tile), HVAC, electrical, plumbing, glazing, finishing

For the materials list:
- Size quantities to the DETECTED total_sqft and the building_type benchmark above
- Use current US market unit costs
- If the math (sum of total_cost × ~1.5) doesn't land near the benchmark range for the type, your list is wrong — add or scale items
- Do not put residential items in a warehouse list, or vice versa

Return ONLY the JSON object, no markdown, no explanation."""

    # Resize image if too large — Gemini has a 4MB inline limit
    jpeg_bytes = _resize_if_needed(jpeg_bytes)
    logger.debug(f"sending {len(jpeg_bytes)} bytes to llm_vision_sync")
    try:
        text = llm_vision_sync(jpeg_bytes, "image/jpeg", prompt, max_tokens=16384)
    except Exception:
        logger.exception("llm_vision_sync FAILED")
        raise

    parsed = _parse_blueprint_json(text)
    if parsed is not None and isinstance(parsed, dict):
        return parsed

    # Salvage path — if the structured parse failed (usually because the
    # response was truncated mid-array), pull the critical fields out by
    # regex and let MaterialEstimator + CostEngine build the rest from
    # total_sqft. Better to ship a coarse estimate than fail the whole scan.
    salvaged = _extract_partial_blueprint(text)
    if salvaged.get("total_sqft", 0) > 0:
        logger.warning(
            "claude_analyze: structured parse failed, using regex-salvaged fields. "
            "total_sqft=%s building_type=%s",
            salvaged.get("total_sqft"), salvaged.get("building_type"),
        )
        return salvaged

    logger.warning(
        "claude_analyze: full parse failure. raw_len=%d raw[:600]=%r",
        len(text or ""), (text or "")[:600],
    )
    raise ValueError(
        "AI returned an unparseable response. Please try the scan again — if it "
        "keeps happening, the blueprint may be too low-resolution or unclear."
    )


def _extract_partial_blueprint(text: str) -> dict:
    """Last-resort regex extraction. Pulls top-level scalar fields out of the
    raw LLM text so we can still produce an estimate when the structured JSON
    is truncated mid-array. Returns a minimal dict shaped like the analysis
    schema; MaterialEstimator handles the empty rooms/walls case."""
    out = {
        "rooms": [], "walls": [], "openings": [],
        "electrical": [], "plumbing": [],
        "total_sqft": 0, "confidence": 0.5,
        "building_type": "residential",
        "notes": "Partial extraction — original AI response was truncated.",
        "materials": [],
        "parse_status": "partial",
    }
    if not text:
        return out
    m = re.search(r'"total_sqft"\s*:\s*([0-9.]+)', text)
    if m:
        try: out["total_sqft"] = float(m.group(1))
        except ValueError: pass
    m = re.search(r'"building_type"\s*:\s*"([a-z_]+)"', text)
    if m: out["building_type"] = m.group(1)
    m = re.search(r'"confidence"\s*:\s*([0-9.]+)', text)
    if m:
        try: out["confidence"] = float(m.group(1))
        except ValueError: pass
    m = re.search(r'"notes"\s*:\s*"([^"]{0,400})"', text)
    if m: out["notes"] = m.group(1)
    return out


def _parse_blueprint_json(text: str):
    """
    Tolerant JSON parser for the blueprint LLM response. Strips fences, finds
    the largest balanced {...} block, fixes trailing commas / Python-isms, and
    walks back through `}` boundaries on truncated output. Returns None if
    nothing usable could be salvaged.
    """
    raw = (text or "").strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw, count=1)
    raw = re.sub(r"\s*```\s*$", "", raw)
    start = raw.find("{")
    if start < 0:
        return None

    depth, end, in_str, escape = 0, -1, False, False
    for i in range(start, len(raw)):
        ch = raw[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i
                break

    candidate = raw[start:end + 1] if end > 0 else raw[start:]
    candidate = re.sub(r",\s*([}\]])", r"\1", candidate)
    candidate = re.sub(r"\bNone\b", "null", candidate)
    candidate = re.sub(r"\bTrue\b", "true", candidate)
    candidate = re.sub(r"\bFalse\b", "false", candidate)

    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        for i in range(len(candidate) - 1, -1, -1):
            if candidate[i] != "}":
                continue
            try:
                return json.loads(candidate[:i + 1])
            except Exception:
                continue
        return _salvage_truncated_json(candidate)


def _salvage_truncated_json(candidate: str):
    """Salvage a truncated JSON object. Walks the string tracking string state
    and bracket depth, finds the last position where truncating would leave a
    closeable structure, then closes the stack in nesting order. Handles the
    common LLM failure mode: response cut off mid-string deep inside a nested
    array."""
    in_str, esc = False, False
    stack = []          # closers expected, in nesting order
    last_safe_end = -1  # last index (exclusive) we can truncate to
    last_safe_stack = []

    # Safe boundaries are positions where the preceding text is a complete
    # value: just after a `,` (drop the comma), after `}`, or after `]`.
    # Closing-string is NOT safe because a string might be a key, not a value.
    for i, ch in enumerate(candidate):
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            stack.append("}")
        elif ch == "[":
            stack.append("]")
        elif ch == "}" or ch == "]":
            if stack and stack[-1] == ch:
                stack.pop()
            last_safe_end = i + 1
            last_safe_stack = list(stack)
        elif ch == ",":
            last_safe_end = i  # truncate BEFORE the comma
            last_safe_stack = list(stack)

    # If we ended inside a string OR with unclosed structures past the last
    # safe boundary, revert to the safe boundary.
    truncated = candidate if (not in_str and not stack) else candidate[:max(last_safe_end, 0)]
    rebuilt_stack = last_safe_stack if (in_str or stack) else []

    # Strip trailing commas / whitespace, then close remaining structures.
    truncated = re.sub(r",\s*$", "", truncated.rstrip())
    truncated = re.sub(r":\s*$", ": null", truncated)  # dangling key:
    truncated += "".join(reversed(rebuilt_stack))
    truncated = re.sub(r",\s*([}\]])", r"\1", truncated)

    try:
        return json.loads(truncated)
    except Exception:
        return None


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
        # Columns material_estimates has. Any other keys set by the estimator
        # (e.g. in-memory flags like `price_unverified`) are dropped so inserts
        # don't fail against the current schema.
        _COLS = {"category", "item_name", "quantity", "unit", "unit_cost", "total_cost", "region"}
        rows = []
        for item in materials:
            row = {k: v for k, v in item.items() if k in _COLS}
            row["analysis_id"] = analysis_id
            row["vendor_options"] = _json.dumps(item.get("vendor_options", []))
            rows.append(row)
        db.table("material_estimates").insert(rows).execute()

    # Save cost estimate — delete existing first to avoid unique constraint issues
    try:
        db.table("cost_estimates").delete().eq("project_id", project_id).execute()
    except Exception:
        logger.debug("cost_estimates delete-before-insert failed (row may not exist)", exc_info=True)
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
