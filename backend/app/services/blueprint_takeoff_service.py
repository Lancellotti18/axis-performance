"""
Togal-style blueprint takeoff.

Reads the scene_3d structure we already persist in analyses.scene_3d (produced
by blueprint_vision_service.parse_blueprint_3d) and returns contractor-ready
quantity breakdowns: flooring by room, drywall by wall run, framing linear
feet, plus opening counts. These feed directly into the materials estimator.

The goal is not to replace the existing `quantity_takeoff.calculate_quantities`
— that one expects a different (legacy) scene_data shape. This service speaks
the current vision schema and emits quantities in the SAME units the materials
UI already uses (sqft, linear feet, count) so nothing downstream has to
translate.

Numbers here are DERIVED, not guessed. When the vision pass flagged the scale
as unverified, we surface that on every field so the contractor can see "these
dimensions are the AI's best read, confirm before ordering."
"""
from __future__ import annotations

import logging
import math
from typing import Any

logger = logging.getLogger(__name__)

# Standard waste factors applied to raw takeoff to get order-ready quantities.
WASTE_DRYWALL = 1.10     # 10%
WASTE_FLOORING = 1.08    # 8%
WASTE_FRAMING = 1.05     # 5%

STUD_SPACING_FT = 1.333  # 16" on center
DEFAULT_WALL_HEIGHT_FT = 9.0


def _wall_length_ft(w: dict) -> float:
    x1 = float(w.get("x1") or 0)
    z1 = float(w.get("z1") or 0)
    x2 = float(w.get("x2") or 0)
    z2 = float(w.get("z2") or 0)
    return math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2)


def _opening_area_sqft(op: dict) -> float:
    w = float(op.get("width") or 0)
    h = float(op.get("height") or 0)
    return max(0.0, w * h)


def compute_takeoff(scene: dict) -> dict:
    """
    Produce a contractor-ready takeoff from a vision scene_3d blob.

    Returns (see README below for shape):
      {
        rooms: [{name, sqft, perimeter_ft, flooring_type, drywall_sqft}],
        walls: {exterior_lf, interior_lf, total_lf, by_type: {...}},
        openings: {doors, windows, opening_sqft_total},
        framing: {studs_count, plates_lf, osb_panels, insulation_batts},
        drywall: {raw_sqft, ordered_sqft, sheets_4x8},
        flooring: [{room, type, raw_sqft, ordered_sqft}],
        totals: {total_sqft, perimeter_ft, wall_height_ft, wall_area_sqft_net},
        scale: {detected, unverified, confidence, warning?},
      }
    """
    if not isinstance(scene, dict):
        raise ValueError("scene_3d is empty — parse the blueprint first")

    rooms_raw = scene.get("rooms") or []
    walls_raw = scene.get("walls") or []
    doors_raw = scene.get("doors") or []
    windows_raw = scene.get("windows") or []
    wall_height = float(scene.get("wall_height_ft") or DEFAULT_WALL_HEIGHT_FT)

    # ── Rooms: compute perimeter from width/depth when sqft is missing ───────
    rooms: list[dict] = []
    total_floor_sqft = 0.0
    flooring: list[dict] = []
    for r in rooms_raw:
        name = str(r.get("name") or "Unnamed")
        width = float(r.get("width") or 0)
        depth = float(r.get("depth") or 0)
        sqft = float(r.get("sqft") or 0)
        if not sqft and width and depth:
            sqft = round(width * depth, 1)
        perim = round(2 * (width + depth), 1) if (width and depth) else None
        drywall = round(perim * wall_height, 1) if perim else None
        floor_type = str(r.get("floor_type") or "unspecified")
        rooms.append({
            "name": name,
            "sqft": round(sqft, 1),
            "width_ft": round(width, 1) if width else None,
            "depth_ft": round(depth, 1) if depth else None,
            "perimeter_ft": perim,
            "drywall_sqft": drywall,
            "flooring_type": floor_type,
        })
        total_floor_sqft += sqft
        if sqft:
            flooring.append({
                "room": name,
                "type": floor_type,
                "raw_sqft": round(sqft, 1),
                "ordered_sqft": round(sqft * WASTE_FLOORING, 1),
            })

    # ── Walls: split exterior vs interior by `type` field ───────────────────
    ext_lf = 0.0
    int_lf = 0.0
    by_type: dict[str, float] = {}
    for w in walls_raw:
        length = _wall_length_ft(w)
        if length <= 0:
            continue
        wtype = str(w.get("type") or "unknown").lower()
        by_type[wtype] = by_type.get(wtype, 0.0) + length
        if "ext" in wtype:
            ext_lf += length
        else:
            int_lf += length
    total_wall_lf = ext_lf + int_lf

    # ── Openings ─────────────────────────────────────────────────────────────
    door_count = len(doors_raw)
    window_count = len(windows_raw)
    opening_sqft = sum(_opening_area_sqft(d) for d in doors_raw) + sum(
        _opening_area_sqft(w) for w in windows_raw
    )

    # ── Framing — derived from total wall LF + wall count ────────────────────
    # Studs: (total_lf / spacing) + 3 extra per wall for corners, plates, headers
    studs_count = int(total_wall_lf / STUD_SPACING_FT) + len(walls_raw) * 3 if total_wall_lf else 0
    plates_lf = round(total_wall_lf * 3 * WASTE_FRAMING, 1)  # double top + single bottom + waste
    osb_panels = (
        math.ceil((total_wall_lf * wall_height * 1.08) / 32) if total_wall_lf else 0
    )
    insulation_batts = math.ceil((ext_lf * wall_height) / 16) if ext_lf else 0

    # ── Drywall — both sides of interior walls, one side on exterior walls ──
    # Net of door/window openings
    raw_drywall_sqft = (int_lf * wall_height * 2) + (ext_lf * wall_height * 1)
    raw_drywall_sqft = max(0.0, raw_drywall_sqft - opening_sqft)
    ordered_drywall_sqft = round(raw_drywall_sqft * WASTE_DRYWALL, 1)
    sheets_4x8 = math.ceil(ordered_drywall_sqft / 32) if ordered_drywall_sqft else 0

    # ── Totals ───────────────────────────────────────────────────────────────
    perim_ext = round(ext_lf, 1)
    wall_area_net = max(
        0.0,
        ext_lf * wall_height - sum(_opening_area_sqft(d) for d in doors_raw if (d.get("wall_angle") in (0, 90, 180, 270)))
        - sum(_opening_area_sqft(w) for w in windows_raw if (w.get("wall_angle") in (0, 90, 180, 270))),
    )

    total_sqft = float(scene.get("total_sqft") or total_floor_sqft or 0.0)

    # ── Scale signal — propagate the vision pass's verdict ──────────────────
    scale = {
        "detected": scene.get("scale_detected"),
        "unverified": bool(scene.get("scale_unverified") or (scene.get("confidence") or 0) < 0.4),
        "confidence": float(scene.get("confidence") or 0),
    }
    if scale["unverified"]:
        scale["warning"] = (
            "Blueprint scale was not verified — quantities are the AI's best read. "
            "Confirm one dimension against a known measurement before ordering."
        )

    return {
        "rooms": rooms,
        "walls": {
            "exterior_lf": round(ext_lf, 1),
            "interior_lf": round(int_lf, 1),
            "total_lf": round(total_wall_lf, 1),
            "by_type": {k: round(v, 1) for k, v in by_type.items()},
        },
        "openings": {
            "doors": door_count,
            "windows": window_count,
            "opening_sqft_total": round(opening_sqft, 1),
        },
        "framing": {
            "studs_count": studs_count,
            "plates_lf": plates_lf,
            "osb_panels_wall": osb_panels,
            "insulation_batts": insulation_batts,
        },
        "drywall": {
            "raw_sqft": round(raw_drywall_sqft, 1),
            "ordered_sqft": ordered_drywall_sqft,
            "sheets_4x8": sheets_4x8,
            "waste_factor": WASTE_DRYWALL,
        },
        "flooring": flooring,
        "totals": {
            "total_sqft": round(total_sqft, 1),
            "exterior_perimeter_ft": perim_ext,
            "wall_height_ft": wall_height,
            "wall_area_net_sqft": round(wall_area_net, 1),
            "room_count": len(rooms),
        },
        "scale": scale,
    }


def takeoff_to_material_rows(takeoff: dict) -> list[dict]:
    """
    Flatten a takeoff into material_estimate-shaped rows so the UI can
    push them into the materials list with one click. Unit costs are left
    at 0 — the existing live-pricing / cost-engine layers fill those in.
    """
    rows: list[dict] = []

    drywall_sqft = takeoff.get("drywall", {}).get("ordered_sqft") or 0
    if drywall_sqft:
        rows.append({
            "item_name": "Drywall (½\" sheet, 4×8)",
            "category": "drywall",
            "quantity": takeoff["drywall"]["sheets_4x8"],
            "unit": "sheet",
            "unit_cost": 0,
            "total_cost": 0,
            "source": "blueprint_takeoff",
        })

    flooring_rows = takeoff.get("flooring") or []
    grouped_by_type: dict[str, float] = {}
    for f in flooring_rows:
        grouped_by_type[f["type"]] = grouped_by_type.get(f["type"], 0) + f["ordered_sqft"]
    for ftype, sqft in grouped_by_type.items():
        label = ftype.replace("_", " ").title() if ftype != "unspecified" else "Finish Flooring"
        rows.append({
            "item_name": f"{label}",
            "category": "flooring",
            "quantity": round(sqft, 1),
            "unit": "sqft",
            "unit_cost": 0,
            "total_cost": 0,
            "source": "blueprint_takeoff",
        })

    framing = takeoff.get("framing") or {}
    if framing.get("studs_count"):
        rows.append({
            "item_name": "2×4 Studs (8ft)",
            "category": "lumber",
            "quantity": framing["studs_count"],
            "unit": "each",
            "unit_cost": 0,
            "total_cost": 0,
            "source": "blueprint_takeoff",
        })
    if framing.get("plates_lf"):
        rows.append({
            "item_name": "2×4 Plates",
            "category": "lumber",
            "quantity": framing["plates_lf"],
            "unit": "lf",
            "unit_cost": 0,
            "total_cost": 0,
            "source": "blueprint_takeoff",
        })
    if framing.get("osb_panels_wall"):
        rows.append({
            "item_name": "OSB Wall Sheathing (4×8)",
            "category": "sheathing",
            "quantity": framing["osb_panels_wall"],
            "unit": "sheet",
            "unit_cost": 0,
            "total_cost": 0,
            "source": "blueprint_takeoff",
        })
    if framing.get("insulation_batts"):
        rows.append({
            "item_name": "R-13 Batt Insulation",
            "category": "insulation",
            "quantity": framing["insulation_batts"],
            "unit": "bag",
            "unit_cost": 0,
            "total_cost": 0,
            "source": "blueprint_takeoff",
        })

    openings = takeoff.get("openings") or {}
    if openings.get("doors"):
        rows.append({
            "item_name": "Interior Door (36\" prehung)",
            "category": "doors_windows",
            "quantity": openings["doors"],
            "unit": "each",
            "unit_cost": 0,
            "total_cost": 0,
            "source": "blueprint_takeoff",
        })
    if openings.get("windows"):
        rows.append({
            "item_name": "Window (standard residential)",
            "category": "doors_windows",
            "quantity": openings["windows"],
            "unit": "each",
            "unit_cost": 0,
            "total_cost": 0,
            "source": "blueprint_takeoff",
        })

    return rows
