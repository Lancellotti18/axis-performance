"""
Tests for the Togal-style blueprint takeoff service.

Covers the math on a known synthetic scene so we'd notice if waste factors,
stud spacing, sheet-size, or opening-deduction logic drift.
"""
from __future__ import annotations

import math

import pytest

from app.services.blueprint_takeoff_service import (
    DEFAULT_WALL_HEIGHT_FT,
    STUD_SPACING_FT,
    WASTE_DRYWALL,
    WASTE_FLOORING,
    compute_takeoff,
    takeoff_to_material_rows,
)


def _square_scene() -> dict:
    """20×20 single-room house, 1 door, 1 window, 9-ft walls."""
    return {
        "rooms": [
            {"name": "Main", "width": 20.0, "depth": 20.0, "sqft": 400.0, "floor_type": "hardwood"},
        ],
        "walls": [
            {"x1": 0, "z1": 0, "x2": 20, "z2": 0, "type": "exterior"},
            {"x1": 20, "z1": 0, "x2": 20, "z2": 20, "type": "exterior"},
            {"x1": 20, "z1": 20, "x2": 0, "z2": 20, "type": "exterior"},
            {"x1": 0, "z1": 20, "x2": 0, "z2": 0, "type": "exterior"},
        ],
        "doors": [{"width": 3.0, "height": 7.0}],
        "windows": [{"width": 4.0, "height": 3.0}],
        "wall_height_ft": 9.0,
        "total_sqft": 400,
        "confidence": 0.8,
    }


def test_empty_scene_raises():
    with pytest.raises(ValueError):
        compute_takeoff(None)  # type: ignore[arg-type]


def test_default_wall_height_used_when_missing():
    scene = _square_scene()
    scene.pop("wall_height_ft")
    t = compute_takeoff(scene)
    assert t["totals"]["wall_height_ft"] == DEFAULT_WALL_HEIGHT_FT


def test_square_room_geometry():
    t = compute_takeoff(_square_scene())
    assert t["totals"]["room_count"] == 1
    assert t["totals"]["total_sqft"] == 400.0
    # 4 walls × 20 ft = 80 lf exterior, 0 interior
    assert t["walls"]["exterior_lf"] == 80.0
    assert t["walls"]["interior_lf"] == 0.0
    assert t["walls"]["total_lf"] == 80.0
    # exterior perimeter
    assert t["totals"]["exterior_perimeter_ft"] == 80.0


def test_opening_counts_and_area():
    t = compute_takeoff(_square_scene())
    assert t["openings"]["doors"] == 1
    assert t["openings"]["windows"] == 1
    # 3×7 door + 4×3 window = 21 + 12 = 33 sqft
    assert t["openings"]["opening_sqft_total"] == 33.0


def test_drywall_math_applies_waste_and_deducts_openings():
    t = compute_takeoff(_square_scene())
    # Exterior only → 80 lf × 9 ft - 33 sqft openings = 720 - 33 = 687
    expected_raw = 80 * 9 - 33
    assert t["drywall"]["raw_sqft"] == expected_raw
    expected_ordered = round(expected_raw * WASTE_DRYWALL, 1)
    assert t["drywall"]["ordered_sqft"] == expected_ordered
    # 687 × 1.10 / 32 ≈ 23.62 → 24 sheets
    assert t["drywall"]["sheets_4x8"] == math.ceil(expected_ordered / 32)
    assert t["drywall"]["waste_factor"] == WASTE_DRYWALL


def test_framing_math():
    t = compute_takeoff(_square_scene())
    # studs: int(80 / 1.333) + 4 walls × 3 = 60 + 12 = 72
    expected_studs = int(80 / STUD_SPACING_FT) + 4 * 3
    assert t["framing"]["studs_count"] == expected_studs
    # plates: 80 × 3 × 1.05 = 252.0
    assert t["framing"]["plates_lf"] == round(80 * 3 * 1.05, 1)
    # OSB wall panels: ceil((80 × 9 × 1.08) / 32) = ceil(24.3) = 25
    assert t["framing"]["osb_panels_wall"] == math.ceil((80 * 9 * 1.08) / 32)


def test_flooring_grouped_and_waste_applied():
    t = compute_takeoff(_square_scene())
    assert len(t["flooring"]) == 1
    row = t["flooring"][0]
    assert row["type"] == "hardwood"
    assert row["raw_sqft"] == 400.0
    assert row["ordered_sqft"] == round(400 * WASTE_FLOORING, 1)


def test_scale_warning_surfaces_when_unverified():
    scene = _square_scene()
    scene["scale_unverified"] = True
    t = compute_takeoff(scene)
    assert t["scale"]["unverified"] is True
    assert "warning" in t["scale"]
    assert "confirm" in t["scale"]["warning"].lower()


def test_low_confidence_flags_as_unverified():
    scene = _square_scene()
    scene["confidence"] = 0.2  # below 0.4 threshold
    scene.pop("scale_unverified", None)
    t = compute_takeoff(scene)
    assert t["scale"]["unverified"] is True


def test_material_rows_have_correct_units():
    t = compute_takeoff(_square_scene())
    rows = takeoff_to_material_rows(t)
    # Should emit: drywall (sheet), flooring (sqft), studs (each), plates (lf),
    # osb (sheet), insulation (batt), interior door (each — 0 in this scene),
    # windows (each)
    by_item = {r["item_name"]: r for r in rows}

    assert any("Drywall" in k for k in by_item)
    drywall = next(r for r in rows if "Drywall" in r["item_name"])
    assert drywall["unit"] == "sheet"

    assert "Hardwood" in by_item
    assert by_item["Hardwood"]["unit"] == "sqft"

    assert "2×4 Studs (8ft)" in by_item
    assert by_item["2×4 Studs (8ft)"]["unit"] == "each"

    assert "2×4 Plates" in by_item
    assert by_item["2×4 Plates"]["unit"] == "lf"

    assert any("Insulation" in k for k in by_item)
    insulation = next(r for r in rows if "Insulation" in r["item_name"])
    assert insulation["unit"] == "batt"  # pieces, not bags — labeled correctly

    assert "Window (standard residential)" in by_item
    assert by_item["Window (standard residential)"]["quantity"] == 1


def test_no_doors_no_door_row():
    scene = _square_scene()
    scene["doors"] = []
    t = compute_takeoff(scene)
    rows = takeoff_to_material_rows(t)
    assert not any("Interior Door" in r["item_name"] for r in rows)


def test_interior_walls_get_double_sided_drywall():
    scene = _square_scene()
    # Add a 10-ft interior wall bisecting the house
    scene["walls"].append({"x1": 0, "z1": 10, "x2": 20, "z2": 10, "type": "interior"})
    scene["doors"] = []
    scene["windows"] = []
    t = compute_takeoff(scene)
    # raw drywall = 80 ext × 9 × 1 + 20 int × 9 × 2 - 0 openings = 720 + 360 = 1080
    assert t["drywall"]["raw_sqft"] == pytest.approx(1080.0)


def test_rooms_without_dimensions_still_processed():
    scene = {
        "rooms": [{"name": "Unknown", "sqft": 150.0, "floor_type": "tile"}],
        "walls": [],
        "doors": [],
        "windows": [],
        "wall_height_ft": 8.0,
    }
    t = compute_takeoff(scene)
    assert t["rooms"][0]["perimeter_ft"] is None
    assert t["rooms"][0]["drywall_sqft"] is None
    assert t["flooring"][0]["raw_sqft"] == 150.0
