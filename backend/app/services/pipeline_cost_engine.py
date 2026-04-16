from __future__ import annotations
"""
cost_engine.py — AXIS PERFORMANCE Module 7
==========================================
Applies unit costs to quantities → itemized cost estimate with 3 scenarios.
Runs outside Blender as a standard Python module.

Inputs:  quantities dict (from quantity_takeoff.py)
         cost_database.json (shipped with system)
Outputs: cost_report dict + /output/data/cost_report.json
"""

import json
import logging
import math
import os

logger = logging.getLogger(__name__)


def _load_db(db_path: str | None = None) -> dict:
    if db_path is None:
        db_path = os.path.join(os.path.dirname(__file__), "cost_database.json")
    with open(db_path) as f:
        return json.load(f)


def _cost(db: dict, key: str, qty: float) -> dict:
    """Return {material, labor, total} for a given line item."""
    entry = db["materials"].get(key, {"material": 0, "labor": 0})
    mat   = round(entry["material"] * qty, 2)
    lab   = round(entry["labor"]   * qty, 2)
    return {"key": key, "qty": round(qty, 2), "unit": entry.get("unit", "—"),
            "unit_mat": entry["material"], "unit_lab": entry["labor"],
            "material": mat, "labor": lab, "total": round(mat + lab, 2)}


def calculate_costs(quantities: dict, db_path: str | None = None) -> dict:
    """
    Build full cost estimate for economy / standard / premium scenarios.
    Returns cost_report dict.
    """
    db       = _load_db(db_path)
    mats     = db["materials"]
    oh_pct   = db["overhead_profit_pct"]
    cont_pct = db["contingency_pct"]
    scenarios_cfg = db["scenarios"]

    q_roof = quantities["roofing"]
    q_wall = quantities["walls"]
    q_strc = quantities["structure"]
    q_flr  = quantities["floors"]
    q_fnd  = quantities["foundation"]
    q_opn  = quantities["openings"]

    def build_scenario(scenario_key: str) -> dict:
        cfg = scenarios_cfg[scenario_key]

        # ── Phase 1: Site Prep & Foundation ──────────────────────────────────
        phase1 = [
            _cost(db, "concrete", q_fnd["concrete_cubic_yards"]),
            _cost(db, "rebar",    q_fnd["rebar_lf"]),
        ]

        # ── Phase 2: Framing & Structure ──────────────────────────────────────
        phase2 = [
            _cost(db, "framing_stud",  q_strc["studs_count"]),
            _cost(db, "plates_lumber", q_strc["plates_lf"]),
            _cost(db, "header_lumber", q_strc["headers_lf"]),
            _cost(db, "osb_panel",     q_strc["osb_panels"]),
            _cost(db, "house_wrap",    q_wall["house_wrap_sqft"]),
        ]

        # ── Phase 3: Roofing ──────────────────────────────────────────────────
        roofing_key = cfg["roofing"]
        if roofing_key in ("shingle_3tab", "shingle_architectural", "shingle_premium"):
            roof_item = _cost(db, roofing_key, q_roof["shingle_squares"])
        else:
            # metal or clay — sold per sqft
            roof_item = _cost(db, roofing_key, q_roof["roof_area_w_overhang"])

        phase3 = [
            roof_item,
            _cost(db, "underlayment",    q_roof["underlayment_sqft"]),
            _cost(db, "ice_water_shield", q_roof["ice_water_shield_sqft"]),
            _cost(db, "drip_edge",       q_roof["drip_edge_lf"]),
            _cost(db, "ridge_cap",       q_roof["ridge_cap_lf"]),
            _cost(db, "flashing",        q_roof["flashing_lf"]),
        ]

        # ── Phase 4: Exterior Finishes ────────────────────────────────────────
        siding_key = cfg["siding"]
        phase4 = [
            _cost(db, siding_key,     q_wall["siding_sqft"]),
            _cost(db, "exterior_paint", q_wall["paint_gallons"]),
            _cost(db, "trim_boards",  q_wall["trim_lf"]),
            _cost(db, cfg["window"],  float(q_opn["window_count"])),
            _cost(db, cfg["door"],    float(q_opn["door_count"])),
        ]

        # ── Phase 5: Interior Rough-In ────────────────────────────────────────
        phase5 = [
            _cost(db, "insulation_batt", q_strc["insulation_batts"]),
            _cost(db, "subfloor_panel",  q_flr["subfloor_panels"]),
        ]

        # ── Phase 6: Interior Finishes ────────────────────────────────────────
        phase6 = [
            _cost(db, "finish_flooring", q_flr["finish_flooring_sqft"]),
        ]

        # ── Phase subtotals ───────────────────────────────────────────────────
        def phase_total(items: list) -> dict:
            mat = sum(i["material"] for i in items)
            lab = sum(i["labor"]    for i in items)
            return {"material": round(mat, 2), "labor": round(lab, 2),
                    "total": round(mat + lab, 2)}

        phases = {
            "phase1_foundation":   {"items": phase1, **phase_total(phase1)},
            "phase2_framing":      {"items": phase2, **phase_total(phase2)},
            "phase3_roofing":      {"items": phase3, **phase_total(phase3)},
            "phase4_ext_finishes": {"items": phase4, **phase_total(phase4)},
            "phase5_int_rough":    {"items": phase5, **phase_total(phase5)},
            "phase6_int_finishes": {"items": phase6, **phase_total(phase6)},
        }

        subtotal_mat = sum(v["material"] for v in phases.values())
        subtotal_lab = sum(v["labor"]    for v in phases.values())
        subtotal     = subtotal_mat + subtotal_lab

        overhead   = round(subtotal * oh_pct,   2)
        contingency = round(subtotal * cont_pct, 2)
        grand_total = round(subtotal + overhead + contingency, 2)

        area_sqft = quantities["meta"]["area_sqft"]
        cost_per_sqft = round(grand_total / area_sqft, 2) if area_sqft else 0

        # Phase 7 as a line item for display
        phases["phase7_overhead"] = {
            "items": [
                {"key": "overhead_profit", "qty": 1, "unit": "ls",
                 "material": 0, "labor": overhead, "total": overhead},
                {"key": "contingency", "qty": 1, "unit": "ls",
                 "material": 0, "labor": contingency, "total": contingency},
            ],
            "material": 0,
            "labor": round(overhead + contingency, 2),
            "total": round(overhead + contingency, 2),
        }

        return {
            "scenario":      scenario_key,
            "label":         cfg["label"],
            "phases":        phases,
            "subtotal_materials": round(subtotal_mat, 2),
            "subtotal_labor":     round(subtotal_lab, 2),
            "subtotal":           round(subtotal, 2),
            "overhead":           overhead,
            "contingency":        contingency,
            "grand_total":        grand_total,
            "cost_per_sqft":      cost_per_sqft,
        }

    economy  = build_scenario("economy")
    standard = build_scenario("standard")
    premium  = build_scenario("premium")

    def delta(scenario: dict) -> dict:
        base = economy["grand_total"]
        diff = scenario["grand_total"] - base
        return {
            "vs_economy_dollars": round(diff, 2),
            "vs_economy_pct":     round((diff / base * 100) if base else 0, 1),
        }

    standard["delta"] = delta(standard)
    premium["delta"]  = delta(premium)
    economy["delta"]  = {"vs_economy_dollars": 0, "vs_economy_pct": 0.0}

    cost_report = {
        "economy":  economy,
        "standard": standard,
        "premium":  premium,
        "summary": {
            "area_sqft":            quantities["meta"]["area_sqft"],
            "economy_total":        economy["grand_total"],
            "standard_total":       standard["grand_total"],
            "premium_total":        premium["grand_total"],
            "economy_per_sqft":     economy["cost_per_sqft"],
            "standard_per_sqft":    standard["cost_per_sqft"],
            "premium_per_sqft":     premium["cost_per_sqft"],
        },
    }

    return cost_report


def run_cost_engine(quantities: dict, output_dir: str, db_path: str | None = None) -> dict:
    """Calculate costs and save to /output/data/cost_report.json."""
    cost_report = calculate_costs(quantities, db_path=db_path)

    data_dir = os.path.join(output_dir, "data")
    os.makedirs(data_dir, exist_ok=True)
    out_path = os.path.join(data_dir, "cost_report.json")
    with open(out_path, "w") as f:
        json.dump(cost_report, f, indent=2)

    logger.info(f"Cost report saved → {out_path}")
    s = cost_report["summary"]
    logger.info(f"  Economy:  ${s['economy_total']:,.0f}  (${s['economy_per_sqft']:.0f}/sqft)")
    logger.info(f"  Standard: ${s['standard_total']:,.0f}  (${s['standard_per_sqft']:.0f}/sqft)")
    logger.info(f"  Premium:  ${s['premium_total']:,.0f}  (${s['premium_per_sqft']:.0f}/sqft)")
    return cost_report


if __name__ == "__main__":
    import sys
    qty_json = sys.argv[1] if len(sys.argv) > 1 else "output/data/quantities.json"
    out_dir  = sys.argv[2] if len(sys.argv) > 2 else "output"
    with open(qty_json) as f:
        qty = json.load(f)
    cr = run_cost_engine(qty, out_dir)
    print(json.dumps(cr["summary"], indent=2))
