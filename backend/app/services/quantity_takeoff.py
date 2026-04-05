"""
quantity_takeoff.py — AXIS PERFORMANCE Module 6
================================================
Auto-calculates all material quantities from scene_data.
Runs outside Blender as a standard Python module.

Inputs:  scene_data dict (from blueprint_parser / saved JSON)
Outputs: quantities dict + /output/data/quantities.json
"""

import json
import math
import os


def calculate_quantities(scene_data: dict, pitch_angle: float = 35.0) -> dict:
    """
    Full material quantity takeoff from scene_data.
    Returns a quantities dict with 6 categories.
    """
    walls     = scene_data.get("walls", [])
    rooms     = scene_data.get("rooms", [])
    openings  = scene_data.get("openings", [])
    footprint = scene_data.get("footprint", {})
    warnings  = []

    # ── helpers ──────────────────────────────────────────────────────────────
    def wall_length_ft(w: dict) -> float:
        s, e = w.get("start", [0, 0]), w.get("end", [0, 0])
        return math.sqrt((e[0] - s[0]) ** 2 + (e[1] - s[1]) ** 2) * 3.281  # m→ft

    def wall_length_m(w: dict) -> float:
        s, e = w.get("start", [0, 0]), w.get("end", [0, 0])
        return math.sqrt((e[0] - s[0]) ** 2 + (e[1] - s[1]) ** 2)

    exterior_walls = [w for w in walls if w.get("is_exterior", True)]
    all_walls      = walls

    perimeter_lf  = footprint.get("perimeter_lf", sum(wall_length_ft(w) for w in exterior_walls) or 120.0)
    area_sqft     = footprint.get("area_sqft", 1200.0)
    width_m       = footprint.get("width_meters", 10.0)

    # ── ROOFING ───────────────────────────────────────────────────────────────
    horizontal_area       = area_sqft
    roof_area_sqft        = horizontal_area / math.cos(math.radians(pitch_angle))
    roof_area_w_overhang  = roof_area_sqft * 1.08          # 2-ft overhang each side
    shingle_squares       = round((roof_area_w_overhang * 1.10) / 100, 2)  # 10% waste
    underlayment_sqft     = round(roof_area_w_overhang * 1.15, 1)
    ice_water_sqft        = round(perimeter_lf * 6, 1)      # 6-ft wide eave strips
    drip_edge_lf          = round(perimeter_lf * 1.05, 1)
    ridge_lf              = round(width_m * 3.281 * 1.10, 1)  # ridge cap w/ 10% waste

    flashing_lf = round(
        sum(w.get("height", 2.7) for w in exterior_walls) * 0.5, 1
    ) if exterior_walls else round(perimeter_lf * 0.15, 1)

    nails_count = int(shingle_squares * 320)

    roofing = {
        "roof_area_sqft":         round(roof_area_sqft, 1),
        "roof_area_w_overhang":   round(roof_area_w_overhang, 1),
        "shingle_squares":        shingle_squares,
        "underlayment_sqft":      underlayment_sqft,
        "ice_water_shield_sqft":  ice_water_sqft,
        "drip_edge_lf":           drip_edge_lf,
        "ridge_cap_lf":           ridge_lf,
        "flashing_lf":            flashing_lf,
        "nails_count":            nails_count,
        "pitch_angle_deg":        pitch_angle,
    }

    # ── WALLS (exterior finishes) ─────────────────────────────────────────────
    total_wall_sf = sum(
        wall_length_ft(w) * w.get("height", 2.7) * 3.281
        for w in exterior_walls
    ) if exterior_walls else perimeter_lf * (2.7 * 3.281)

    opening_deductions = sum(
        o.get("width", 1.0) * o.get("height", 1.2) * 10.764
        for o in openings
    )

    net_wall_sqft   = max(total_wall_sf - opening_deductions, 0)
    siding_sqft     = round(net_wall_sqft * 1.10, 1)
    sheathing_sqft  = round(net_wall_sqft * 1.08, 1)
    house_wrap_sqft = round(net_wall_sqft * 1.05, 1)
    paint_gallons   = round((net_wall_sqft * 2) / 350, 1)   # 2 coats, 350 sqft/gal

    trim_lf = round(
        sum(2 * (o.get("width", 1.0) + o.get("height", 1.2)) * 3.281 for o in openings)
        + (perimeter_lf * 0.5),
        1,
    )

    wall_finishes = {
        "total_wall_sqft":  round(total_wall_sf, 1),
        "net_wall_sqft":    round(net_wall_sqft, 1),
        "opening_sqft":     round(opening_deductions, 1),
        "siding_sqft":      siding_sqft,
        "sheathing_sqft":   sheathing_sqft,
        "house_wrap_sqft":  house_wrap_sqft,
        "paint_gallons":    paint_gallons,
        "trim_lf":          trim_lf,
    }

    # ── STRUCTURE (framing) ───────────────────────────────────────────────────
    total_wall_lf = sum(wall_length_ft(w) for w in all_walls) if all_walls else perimeter_lf * 1.5

    studs_count    = int(total_wall_lf / 1.333) + (len(all_walls) * 3)
    plates_lf      = round(total_wall_lf * 3, 1)   # double top, single bottom
    headers_lf     = round(sum(o.get("width", 1.0) * 3.281 + 0.5 for o in openings), 1)
    osb_panels     = math.ceil(net_wall_sqft * 1.08 / 32)
    insulation_batts = math.ceil(net_wall_sqft / 16)

    structure = {
        "total_wall_lf":     round(total_wall_lf, 1),
        "studs_count":       studs_count,
        "plates_lf":         plates_lf,
        "headers_lf":        headers_lf,
        "osb_panels":        osb_panels,
        "insulation_batts":  insulation_batts,
    }

    # ── FLOORS ────────────────────────────────────────────────────────────────
    subfloor_panels      = math.ceil(area_sqft * 1.05 / 32)
    finish_flooring_sqft = round(area_sqft * 1.08, 1)

    floors = {
        "floor_area_sqft":      round(area_sqft, 1),
        "subfloor_panels":      subfloor_panels,
        "finish_flooring_sqft": finish_flooring_sqft,
    }

    # ── FOUNDATION ────────────────────────────────────────────────────────────
    concrete_cy = round((perimeter_lf * 1.5 * 1.0) / 27, 2)  # 1.5ft wide, 1ft deep
    rebar_lf    = round(perimeter_lf * 4, 1)                   # 4 bars per cross-section

    foundation = {
        "perimeter_lf":     round(perimeter_lf, 1),
        "concrete_cubic_yards": concrete_cy,
        "rebar_lf":         rebar_lf,
    }

    # ── OPENINGS ─────────────────────────────────────────────────────────────
    window_count = len([o for o in openings if o.get("type") == "window"])
    door_count   = len([o for o in openings if o.get("type") == "door"])

    glass_sqft = round(
        sum(o.get("width", 1.0) * o.get("height", 1.2) * 10.764
            for o in openings if o.get("type") == "window"),
        1,
    )
    frame_lf = round(
        sum(2 * (o.get("width", 1.0) + o.get("height", 1.2)) * 3.281 for o in openings),
        1,
    )

    # Fallback: default counts if none detected
    if window_count == 0 and door_count == 0 and len(openings) == 0:
        window_count = 8
        door_count   = 2
        warnings.append("No openings detected — using defaults (8 windows, 2 doors)")

    opening_quantities = {
        "window_count": window_count,
        "door_count":   door_count,
        "glass_sqft":   glass_sqft,
        "frame_lf":     frame_lf,
    }

    # ── SUMMARY ───────────────────────────────────────────────────────────────
    quantities = {
        "roofing":    roofing,
        "walls":      wall_finishes,
        "structure":  structure,
        "floors":     floors,
        "foundation": foundation,
        "openings":   opening_quantities,
        "meta": {
            "pitch_angle_deg":   pitch_angle,
            "area_sqft":         round(area_sqft, 1),
            "perimeter_lf":      round(perimeter_lf, 1),
            "wall_count":        len(walls),
            "room_count":        len(rooms),
            "opening_count":     len(openings),
            "warnings":          warnings,
            "scale_confidence":  scene_data.get("scale", {}).get("confidence", "estimated"),
        },
    }

    return quantities


def run_quantity_takeoff(scene_data: dict, output_dir: str, pitch_angle: float = 35.0) -> dict:
    """Calculate quantities and save to /output/data/quantities.json."""
    quantities = calculate_quantities(scene_data, pitch_angle=pitch_angle)

    data_dir = os.path.join(output_dir, "data")
    os.makedirs(data_dir, exist_ok=True)
    out_path = os.path.join(data_dir, "quantities.json")
    with open(out_path, "w") as f:
        json.dump(quantities, f, indent=2)

    print(f"[AXIS 5D] Quantities saved → {out_path}")
    return quantities


if __name__ == "__main__":
    import sys
    scene_json = sys.argv[1] if len(sys.argv) > 1 else "output/data/scene_data.json"
    out_dir    = sys.argv[2] if len(sys.argv) > 2 else "output"
    with open(scene_json) as f:
        sd = json.load(f)
    q = run_quantity_takeoff(sd, out_dir)
    print(json.dumps(q, indent=2))
