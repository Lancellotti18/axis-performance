"""Partial roof measurements are a first-class state, not a fault.

Not every roof gets fully outlined — a contractor may trace only the section
being replaced. Before this the system had two bad options: report the part as
though it were the whole roof, or hard-block with a message about double-counted
edges that had nothing to do with the cause.

Declared partial => the contradiction becomes a visible warning.
Not declared    => it still blocks, because an undeclared partial trace is
                   indistinguishable from a mislabelled one, and both would
                   understate a real material order.
"""
from __future__ import annotations

from app.services.report_validators import (
    validate_report_inputs, blocking, partial_outline_signals,
)

# The real shape of an interior-only trace: ridge runs longer than the
# perimeter that was actually drawn.
PARTIAL = {
    "total_roof_sqft": 4410.5, "squares": 44.1,
    "eaves_ft": 197.1, "rakes_ft": 107.6, "perimeter_ft": 304.7,
    "ridges_ft": 449.5, "hips_ft": 36.0, "valleys_ft": 92.7,
    "predominant_pitch": "6/12",
}
COMPLETE = {
    "total_roof_sqft": 2000.0, "squares": 20.0,
    "eaves_ft": 120.0, "rakes_ft": 80.0, "perimeter_ft": 200.0,
    "ridges_ft": 60.0, "hips_ft": 20.0, "valleys_ft": 15.0,
    "predominant_pitch": "8/12",
}


def _codes(aggs, partial):
    return {i.code for i in validate_report_inputs(
        aggs, confirmed_penetration_count=1, partial=partial)}


# ── declared partial ─────────────────────────────────────────────────────────

def test_declared_partial_is_not_blocked():
    issues = validate_report_inputs(PARTIAL, confirmed_penetration_count=1, partial=True)
    assert blocking(issues) == [], "a contractor who says it is partial must not be stopped"


def test_declared_partial_still_warns_visibly():
    codes = _codes(PARTIAL, partial=True)
    assert "partial_outline_ridge" in codes
    assert "ridge_exceeds_perimeter" not in codes, "must not also assert the fault version"


def test_partial_with_no_eaves_warns_about_what_is_missing():
    aggs = dict(PARTIAL, eaves_ft=0.0, perimeter_ft=107.6)
    issues = validate_report_inputs(aggs, confirmed_penetration_count=1, partial=True)
    codes = {i.code for i in issues}
    assert "partial_no_eaves" in codes
    assert blocking(issues) == []
    msg = next(i.message for i in issues if i.code == "partial_no_eaves")
    assert "drip edge" in msg and "gutter" in msg


# ── NOT declared ─────────────────────────────────────────────────────────────

def test_undeclared_partial_still_blocks():
    codes = _codes(PARTIAL, partial=False)
    assert "ridge_exceeds_perimeter" in codes
    assert blocking(validate_report_inputs(
        PARTIAL, confirmed_penetration_count=1, partial=False)), "must still stop"


def test_undeclared_missing_eaves_still_blocks():
    aggs = dict(COMPLETE, eaves_ft=0.0)
    assert "no_eaves" in _codes(aggs, partial=False)


def test_a_complete_roof_is_unaffected_either_way():
    assert blocking(validate_report_inputs(
        COMPLETE, confirmed_penetration_count=1, partial=False)) == []
    assert blocking(validate_report_inputs(
        COMPLETE, confirmed_penetration_count=1, partial=True)) == []


# ── detection (B) ────────────────────────────────────────────────────────────

def test_detection_flags_ridge_beyond_perimeter():
    sig = partial_outline_signals(PARTIAL)
    assert sig and any("outer edge" in s for s in sig)


def test_detection_flags_missing_eaves():
    assert any("not been closed" in s for s in partial_outline_signals(
        dict(PARTIAL, eaves_ft=0.0)))


def test_detection_flags_a_perimeter_too_short_for_the_area():
    # 4000 sq ft cannot be enclosed by 120 ft — the square, the most efficient
    # possible shape, would need ~253 ft.
    sig = partial_outline_signals({
        "total_roof_sqft": 4000.0, "eaves_ft": 70.0, "rakes_ft": 50.0,
        "perimeter_ft": 120.0, "ridges_ft": 10.0, "hips_ft": 0.0,
    })
    assert any("short for" in s for s in sig)


def test_detection_stays_quiet_on_a_complete_roof():
    assert partial_outline_signals(COMPLETE) == []


def test_detection_is_quiet_with_no_data():
    assert partial_outline_signals({}) == []
