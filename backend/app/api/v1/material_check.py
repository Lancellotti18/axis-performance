"""
material_check.py — Standalone Material Compliance Check
=========================================================
Accepts an uploaded material list (CSV, Excel, or plain text) OR a
pasted JSON/text list, plus a city/state/project-type, and runs the
exact same compliance engine used in the project compliance tab.

Nothing is invented. Every compliance result is sourced from:
  - Tavily web search of state/county/city building codes (.gov sites)
  - Claude claude-opus-4-6 analysis constrained to only cite fetched code text
  - IRC 2021 / IBC as the base code standard

Endpoints:
  POST /material-check/upload   — multipart upload (file + form fields)
  POST /material-check/text     — JSON body with material list + location
"""

from __future__ import annotations

import csv
import io
import json
import logging
import re
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

router = APIRouter()
log = logging.getLogger(__name__)


# ── Parsers ───────────────────────────────────────────────────────────────────

def _parse_csv(content: bytes) -> list[dict]:
    """Parse CSV bytes into a list of material dicts."""
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    materials = []
    for row in reader:
        # Normalise common column names
        item_name = (
            row.get("item_name") or row.get("Item Name") or row.get("Material") or
            row.get("material") or row.get("Description") or row.get("description") or
            row.get("Name") or row.get("name") or ""
        ).strip()
        if not item_name:
            continue
        category = (
            row.get("category") or row.get("Category") or row.get("Type") or
            row.get("type") or "general"
        ).strip().lower()
        qty_raw = (
            row.get("quantity") or row.get("Quantity") or row.get("qty") or
            row.get("Qty") or "0"
        ).strip()
        try:
            qty = float(re.sub(r"[^\d.]", "", qty_raw)) if qty_raw else 0.0
        except ValueError:
            qty = 0.0
        unit = (
            row.get("unit") or row.get("Unit") or row.get("UOM") or "each"
        ).strip()
        materials.append({
            "item_name": item_name,
            "category":  category,
            "quantity":  qty,
            "unit":      unit,
        })
    return materials


def _parse_text(content: bytes) -> list[dict]:
    """
    Parse plain-text material list — one item per line.
    Handles formats like:
      - "2x4 lumber"
      - "2x4 lumber, 100, pieces"
      - "roofing: 3-tab shingles 25 sq"
    """
    text = content.decode("utf-8-sig", errors="replace")
    materials = []
    for line in text.splitlines():
        line = line.strip().lstrip("-•*·").strip()
        if not line or line.startswith("#"):
            continue
        # Try to split out quantity and unit if present
        # Pattern: "Item name, qty, unit" or "Item name qty unit"
        parts = [p.strip() for p in re.split(r"[,\t|]", line)]
        item_name = parts[0] if parts else line
        qty = 0.0
        unit = "each"
        if len(parts) >= 2:
            try:
                qty = float(re.sub(r"[^\d.]", "", parts[1]))
            except ValueError:
                pass
        if len(parts) >= 3:
            unit = parts[2]

        # Detect category from keywords
        name_lower = item_name.lower()
        if any(k in name_lower for k in ["shingle", "roofing", "flashing", "ice barrier", "underlayment"]):
            cat = "roofing"
        elif any(k in name_lower for k in ["stud", "lumber", "joist", "beam", "rafter", "framing", "2x"]):
            cat = "framing"
        elif any(k in name_lower for k in ["concrete", "cement", "rebar", "footing", "foundation"]):
            cat = "concrete"
        elif any(k in name_lower for k in ["insulation", "batt", "r-value", "rigid foam"]):
            cat = "insulation"
        elif any(k in name_lower for k in ["drywall", "gypsum", "plaster"]):
            cat = "drywall"
        elif any(k in name_lower for k in ["window", "door", "skylight"]):
            cat = "doors_windows"
        elif any(k in name_lower for k in ["pipe", "pvc", "copper", "plumbing", "drain"]):
            cat = "plumbing"
        elif any(k in name_lower for k in ["wire", "breaker", "conduit", "electrical", "romex"]):
            cat = "electrical"
        else:
            cat = "general"

        materials.append({
            "item_name": item_name,
            "category":  cat,
            "quantity":  qty,
            "unit":      unit,
        })
    return materials


def _parse_excel(content: bytes) -> list[dict]:
    """Parse Excel (.xlsx) bytes using openpyxl (optional dependency)."""
    try:
        import openpyxl
    except ImportError:
        raise HTTPException(
            status_code=422,
            detail="Excel files require openpyxl. Install with: pip install openpyxl. "
                   "Alternatively, export your spreadsheet as CSV."
        )
    wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return []

    # First row = header
    headers = [str(c).strip().lower() if c else "" for c in rows[0]]
    def _col(aliases: list[str]) -> int | None:
        for alias in aliases:
            for i, h in enumerate(headers):
                if alias in h:
                    return i
        return None

    name_col = _col(["item_name", "material", "description", "name", "item"])
    cat_col  = _col(["category", "type"])
    qty_col  = _col(["quantity", "qty"])
    unit_col = _col(["unit", "uom"])

    materials = []
    for row in rows[1:]:
        if name_col is None or name_col >= len(row):
            continue
        item_name = str(row[name_col]).strip() if row[name_col] else ""
        if not item_name or item_name.lower() in ("none", "nan", ""):
            continue
        cat  = str(row[cat_col]).strip().lower()  if cat_col  is not None and cat_col  < len(row) and row[cat_col]  else "general"
        qty  = float(row[qty_col])                if qty_col  is not None and qty_col  < len(row) and row[qty_col]  else 0.0
        unit = str(row[unit_col]).strip()         if unit_col is not None and unit_col < len(row) and row[unit_col] else "each"
        materials.append({"item_name": item_name, "category": cat, "quantity": qty, "unit": unit})

    return materials


def _dispatch_parser(filename: str, content: bytes) -> list[dict]:
    name_lower = filename.lower()
    if name_lower.endswith(".csv"):
        return _parse_csv(content)
    if name_lower.endswith((".xlsx", ".xls")):
        return _parse_excel(content)
    # .txt, .tsv, or anything else — try CSV first, fall back to plain text
    try:
        mats = _parse_csv(content)
        if mats:
            return mats
    except Exception:
        pass
    return _parse_text(content)


# ── Request model for text endpoint ──────────────────────────────────────────

class TextCheckRequest(BaseModel):
    """
    For pasting/typing a material list directly.
    materials: list of {item_name, category?, quantity?, unit?}
    OR
    raw_text: newline-delimited list (will be parsed automatically)
    """
    materials:    list[dict] = []
    raw_text:     str        = ""
    city:         str
    state:        str        # 2-letter abbreviation, e.g. "TX"
    county:       str        = ""
    project_type: str        = "residential"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/upload")
async def check_uploaded_material_list(
    file:         UploadFile     = File(...),
    city:         str            = Form(...),
    state:        str            = Form(...),
    county:       str            = Form(""),
    project_type: str            = Form("residential"),
):
    """
    Upload a material list file (CSV, Excel, or plain text) and check it
    against building codes for the specified city/state.

    Accepted file formats:
      - .csv  — columns: item_name (required), category, quantity, unit
      - .xlsx / .xls — same columns
      - .txt  — one item per line, optional "item, qty, unit" format

    Compliance check uses:
      1. Tavily search of official building code sources for the jurisdiction
      2. Claude claude-opus-4-6 to evaluate every material against fetched codes
      3. IRC 2021 / IBC as the authoritative base standard

    Returns the same schema as /compliance/materials-check.
    """
    if not city.strip():
        raise HTTPException(status_code=422, detail="City is required.")
    if not state.strip():
        raise HTTPException(status_code=422, detail="State is required.")

    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large. Max 10 MB.")

    try:
        materials = _dispatch_parser(file.filename or "upload.csv", content)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Could not parse file: {e}")

    if not materials:
        raise HTTPException(
            status_code=422,
            detail="No materials found in the file. "
                   "Ensure the file has an 'item_name' column (CSV/Excel) or "
                   "one item per line (text)."
        )

    log.info(f"[material-check] Parsed {len(materials)} materials from '{file.filename}' for {city}, {state}")

    from app.services.materials_compliance_service import check_materials_compliance
    try:
        result = await check_materials_compliance(
            materials=materials,
            city=city.strip(),
            state=state.strip().upper(),
            project_type=project_type.strip() or "residential",
            county=county.strip(),
        )
    except Exception as e:
        log.error(f"[material-check] Compliance engine error: {e}")
        raise HTTPException(status_code=500, detail=f"Compliance check failed: {e}")

    # Attach the parsed list so the frontend can display it alongside results
    result["parsed_materials"] = materials
    result["file_name"] = file.filename
    return result


@router.post("/text")
async def check_text_material_list(body: TextCheckRequest):
    """
    Run a compliance check on a material list provided as JSON or raw text.

    Supply EITHER:
      - `materials`: list of {item_name, category?, quantity?, unit?}
      - `raw_text`: newline-delimited plain text list

    Compliance check uses the same engine as the file upload endpoint:
    Tavily code research + Claude claude-opus-4-6 evaluation against IRC/IBC.
    """
    if not body.city.strip():
        raise HTTPException(status_code=422, detail="City is required.")
    if not body.state.strip():
        raise HTTPException(status_code=422, detail="State is required.")

    if body.raw_text.strip() and not body.materials:
        materials = _parse_text(body.raw_text.encode())
    else:
        materials = [
            {
                "item_name": m.get("item_name", m.get("name", "")).strip(),
                "category":  m.get("category", "general"),
                "quantity":  float(m.get("quantity", 0) or 0),
                "unit":      m.get("unit", "each"),
            }
            for m in body.materials
            if m.get("item_name") or m.get("name")
        ]

    if not materials:
        raise HTTPException(
            status_code=422,
            detail="No materials provided. Supply 'materials' list or 'raw_text'."
        )

    log.info(f"[material-check] Text check: {len(materials)} materials for {body.city}, {body.state}")

    from app.services.materials_compliance_service import check_materials_compliance
    try:
        result = await check_materials_compliance(
            materials=materials,
            city=body.city.strip(),
            state=body.state.strip().upper(),
            project_type=body.project_type.strip() or "residential",
            county=body.county.strip(),
        )
    except Exception as e:
        log.error(f"[material-check] Compliance engine error: {e}")
        raise HTTPException(status_code=500, detail=f"Compliance check failed: {e}")

    result["parsed_materials"] = materials
    return result
