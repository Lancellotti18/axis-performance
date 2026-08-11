"""Adjuster Mode: the Xactimate quantity survey is derived from geometry (never
bundle counts), and the RCV/ACV math only uses supplied inputs — a missing price
or depreciation stays null, never a fabricated default.
"""
from app.services.materials_engine import RoofTotals, PenetrationSummary
from app.services.xactimate_estimate import (
    build_adjuster_lines, apply_pricing, summarize_claim,
)


def _totals() -> RoofTotals:
    return RoofTotals(
        total_roof_sqft=4410.0, squares=44.1,
        eaves_ft=150.0, rakes_ft=154.7, ridges_ft=110.6, hips_ft=36.0,
        valleys_ft=92.7, wall_intersection_ft=24.0,
    )


def _lines():
    pens = PenetrationSummary(plumbing_vent=3)
    return build_adjuster_lines(_totals(), pens, waste_pct=15.0)


def test_field_shingle_line_carries_waste():
    field = next(l for l in _lines() if l.category == "field")
    assert field.code == "RFG 240" and field.unit == "SQ"
    assert round(field.quantity, 2) == round(44.1 * 1.15, 2)


def test_ridge_cap_is_ridges_plus_hips_but_vent_is_ridges_only():
    lines = _lines()
    cap = next(l for l in lines if l.category == "ridge_cap")
    vent = next(l for l in lines if l.category == "ridge_vent")
    assert round(cap.quantity, 1) == 146.6      # 110.6 + 36.0
    assert round(vent.quantity, 1) == 110.6     # hips excluded


def test_drip_edge_and_starter_use_full_perimeter():
    lines = _lines()
    for cat in ("drip_edge", "starter"):
        ln = next(l for l in lines if l.category == cat)
        assert round(ln.quantity, 1) == 304.7   # 150 + 154.7


def test_pipe_flashing_counts_plumbing_vents():
    ln = next(l for l in _lines() if l.category == "pipe_flashing")
    assert ln.unit == "EA" and ln.quantity == 3.0


def test_unpriced_lines_leave_rcv_null_and_are_flagged():
    lines = apply_pricing(_lines(), {"RFG 240": 350.0})   # only one code priced
    summary = summarize_claim(lines)
    assert summary.rcv is not None
    assert summary.priced_line_count == 1
    assert summary.unpriced_line_count > 0
    assert any("no unit price" in n for n in summary.notes)


def test_rcv_acv_and_net_claim_math():
    # Price every line at $100/unit for a clean, checkable total.
    lines = _lines()
    apply_pricing(lines, {l.code: 100.0 for l in lines})
    expected_rcv = round(sum(l.quantity * 100.0 for l in lines), 2)
    s = summarize_claim(lines, depreciation_pct=20.0, deductible=1000.0)
    assert s.rcv == expected_rcv
    assert s.depreciation_amount == round(expected_rcv * 0.20, 2)
    assert s.acv == round(expected_rcv - s.depreciation_amount, 2)
    assert s.net_claim == round(expected_rcv - 1000.0, 2)   # recoverable: RCV − deductible
    assert s.recoverable_depreciation == s.depreciation_amount


def test_no_inputs_no_money_fabricated():
    s = summarize_claim(_lines())   # nothing priced, no depreciation/deductible
    assert s.rcv is None and s.acv is None and s.net_claim is None
    assert s.depreciation_amount is None


def test_empty_roof_yields_no_lines():
    empty = RoofTotals(total_roof_sqft=0, squares=0, eaves_ft=0, rakes_ft=0,
                       ridges_ft=0, hips_ft=0, valleys_ft=0)
    assert build_adjuster_lines(empty) == []
