"""Phase 0 / DEFECT-07: ice & water shield is regional, not universal. A coastal NC
job (Richlands, warm IECC zone 3) must NOT order a full eave course, while a
Minnesota job (cold zone 6) must order the eave-to-24"-past-wall barrier. County
overrides cover the cold mountain pockets of otherwise-warm states.
"""
from app.services.ice_water_rules import policy_for, ice_water_area_sqft
from app.services.materials_engine import compute_material_lines, RoofTotals


def _totals() -> RoofTotals:
    return RoofTotals(
        total_roof_sqft=4410.0, squares=44.1,
        eaves_ft=150.0, rakes_ft=154.7, ridges_ft=146.6, hips_ft=36.0, valleys_ft=92.7,
    )


def _iw_row():
    return {"sku": "IW-2SQ", "item_name": "Ice & water shield", "category": "ice_water",
            "coverage_basis": "per_eave_iwshield", "coverage_value": 200.0,
            "unit_cost": 95.0, "unit": "roll", "active": True}


def test_warm_coast_covers_valleys_only():
    p = policy_for("NC", "Onslow")   # Richlands = Onslow County, coastal
    assert p.eave_courses == 0
    sf, trace = ice_water_area_sqft(150.0, 92.7, p)
    assert round(sf, 1) == round(92.7 * 6.0, 1)   # valleys only, no eave course
    assert "valley" in trace


def test_cold_climate_gets_full_eave_barrier():
    p = policy_for("MN")             # zone 6
    assert p.eave_courses == 2
    sf, _ = ice_water_area_sqft(150.0, 92.7, p)
    assert round(sf, 1) == round(150.0 * 6.0 + 92.7 * 6.0, 1)


def test_county_override_beats_state_zone():
    warm = policy_for("NC")                 # state default zone 3
    cold = policy_for("NC", "Watauga")      # High Country override -> zone 5
    assert warm.eave_courses == 0
    assert cold.eave_courses == 2


def test_unknown_region_falls_back_to_mixed():
    p = policy_for(None)
    assert p.eave_courses == 1               # conservative mixed-climate default


def test_takeoff_orders_less_iw_in_warm_than_cold():
    catalog = [_iw_row()]
    warm = compute_material_lines(catalog, _totals(), state="NC", county="Onslow")
    cold = compute_material_lines(catalog, _totals(), state="MN")
    warm_iw = next(l for l in warm if l.category == "ice_water")
    cold_iw = next(l for l in cold if l.category == "ice_water")
    assert cold_iw.total_cost_at_default_waste > warm_iw.total_cost_at_default_waste
