"""Flat roof is not shingle roof.

106 Savannah Ave, Morehead City (2026-10-21): 22 of 46 squares were flat
membrane (0-1/12), and the material list priced all 46 as shingles,
underlayment and nails. Shingles need at least 2/12; flatter planes take a
membrane system. Shingle-system items are now sized on the steep part only,
and the flat part is listed on its own line.
"""
from app.services.materials_engine import compute_material_lines, RoofTotals


def _row(sku, category, cov=1.0, cost=100.0):
    return {"sku": sku, "item_name": sku, "category": category, "coverage_basis": "per_square",
            "coverage_value": cov, "unit_cost": cost, "unit": "square", "active": True}


CATALOG = [_row("ARCH-SHG-30", "shingles", 1, 125.0), _row("SYN-UND-10", "underlayment", 10, 55.0),
           _row("NAIL-COIL-1", "nails", 13, 62.0)]


def _totals(flat_sqft):
    return RoofTotals(total_roof_sqft=4627.0, squares=46.27, eaves_ft=255, rakes_ft=137.6,
                      ridges_ft=85.7, hips_ft=0, valleys_ft=71.1, low_slope_sqft=flat_sqft)


def test_shingles_cover_only_the_steep_part():
    lines = {l.sku: l for l in compute_material_lines(CATALOG, _totals(2163.0))}
    assert abs(lines["ARCH-SHG-30"].base_quantity - (46.27 - 21.63)) < 0.01
    assert abs(lines["SYN-UND-10"].base_quantity - (46.27 - 21.63) / 10) < 0.01


def test_the_flat_part_gets_its_own_line_marked_unpriced():
    lines = {l.sku: l for l in compute_material_lines(CATALOG, _totals(2163.0))}
    flat = lines["LOW-SLOPE"]
    assert flat.category == "membrane" and abs(flat.base_quantity - 21.63) < 0.01
    assert flat.unit_cost == 0 and "price separately" in flat.item_name


def test_a_membrane_product_in_the_catalog_is_sized_on_the_flat_part():
    cat = CATALOG + [_row("TPO-60", "membrane", 1, 400.0)]
    lines = {l.sku: l for l in compute_material_lines(cat, _totals(2163.0))}
    assert abs(lines["TPO-60"].base_quantity - 21.63) < 0.01
    assert "LOW-SLOPE" not in lines


def test_an_all_steep_roof_is_unchanged():
    lines = {l.sku: l for l in compute_material_lines(CATALOG, _totals(0.0))}
    assert abs(lines["ARCH-SHG-30"].base_quantity - 46.27) < 0.01
    assert "LOW-SLOPE" not in lines
