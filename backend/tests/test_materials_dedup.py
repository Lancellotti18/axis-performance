"""Phase 0 / DEFECT-01 regression: duplicate catalog SKU rows must not double the
takeoff. Fixtures mirror the Richlands report bug (each SKU emitted twice → total
~2x). The contract: one line per SKU, and a duplicated catalog row never changes
the total.
"""
from app.services.materials_engine import compute_material_lines, RoofTotals


def _totals() -> RoofTotals:
    return RoofTotals(
        total_roof_sqft=4410.0, squares=44.1,
        eaves_ft=150.0, rakes_ft=154.7, ridges_ft=146.6, hips_ft=36.0, valleys_ft=92.7,
    )


def _row(sku: str, category: str = "shingles", cov: float = 1.0, cost: float = 100.0) -> dict:
    return {
        "sku": sku, "item_name": sku.replace("-", " ").title(), "category": category,
        "coverage_basis": "per_square", "coverage_value": cov, "unit_cost": cost,
        "unit": "square", "active": True,
    }


def test_duplicate_sku_row_does_not_double_the_total():
    single = compute_material_lines([_row("SHINGLE-ARCH")], _totals())
    doubled = compute_material_lines([_row("SHINGLE-ARCH"), _row("SHINGLE-ARCH")], _totals())
    assert len(doubled) == len(single)
    assert (sum(l.total_cost_at_default_waste for l in doubled)
            == sum(l.total_cost_at_default_waste for l in single))


def test_takeoff_skus_are_unique():
    catalog = [
        _row("SHINGLE-ARCH"), _row("SHINGLE-ARCH"),                    # dup
        _row("UNDER-SYN", "underlayment", cov=10.0, cost=50.0),
        _row("UNDER-SYN", "underlayment", cov=10.0, cost=50.0),        # dup
        _row("STARTER-100", "starter", cov=100.0, cost=60.0),
    ]
    lines = compute_material_lines(catalog, _totals())
    skus = [l.sku for l in lines]
    assert len(skus) == len(set(skus)), f"duplicate SKUs in takeoff: {skus}"
