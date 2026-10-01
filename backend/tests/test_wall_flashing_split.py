"""Step flashing vs apron flashing on the wall lines.

Brookside Oaks has 104 ft of roof-to-wall line: 71 ft sloped (step flashing)
and 33 ft level (apron flashing). With no apron item in the catalog the whole
104 ft was ordered as step flashing; once apron is orderable, counting it as
step flashing too would order the level run twice."""
from app.services.materials_engine import RoofTotals, compute_material_lines, split_wall_flashing

STEP = {"sku": "STEP-FL-100", "category": "step_flashing", "item_name": "Step", "unit": "box",
        "coverage_basis": "per_lf", "coverage_value": 41, "unit_cost": 42.0, "active": True}
APRON = {"sku": "FL-APRON-10", "category": "apron_flashing", "item_name": "Apron", "unit": "piece",
         "coverage_basis": "per_unit", "coverage_value": 10, "unit_cost": 16.0, "active": True}
FLASHING = {"totals": {"step_flashing_ft": 71.42, "apron_flashing_ft": 32.69, "wall_flashing_ft": 104.11}}


def _totals():
    return RoofTotals(total_roof_sqft=2906, squares=29.06, eaves_ft=170.7, rakes_ft=185.4,
                      ridges_ft=83.2, hips_ft=0, valleys_ft=18.6, wall_intersection_ft=104.1)


def _step_base(catalog):
    t = _totals()
    split_wall_flashing(t, catalog, FLASHING)
    line = next(l for l in compute_material_lines(catalog, t) if l.sku == "STEP-FL-100")
    return line.base_quantity


def test_with_apron_orderable_step_flashing_covers_only_sloped_walls():
    assert round(_step_base([STEP, APRON]), 2) == round(71.42 / 41, 2)


def test_without_an_apron_item_the_whole_wall_stays_step_flashing():
    assert round(_step_base([STEP]), 2) == round(104.1 / 41, 2)
