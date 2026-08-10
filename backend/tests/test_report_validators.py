"""Phase 0 / §4.4 + DEFECT-06: physical-plausibility validators must BLOCK report
generation on impossible geometry and surface (not silence) an assumed zero.
"""
from app.services.report_validators import validate_report_inputs, blocking


def _good() -> dict:
    return {
        "total_roof_sqft": 4410.0, "squares": 44.1,
        "eaves_ft": 150.0, "rakes_ft": 154.7, "ridges_ft": 146.6,
        "hips_ft": 36.0, "valleys_ft": 92.7, "predominant_pitch": "6/12",
    }


def test_valid_geometry_has_no_blockers():
    issues = validate_report_inputs(_good(), confirmed_penetration_count=3)
    assert blocking(issues) == []


def test_ridge_plus_hip_over_perimeter_blocks():
    a = _good()
    a["ridges_ft"] = 400.0   # ridge alone > perimeter (304.7)
    issues = validate_report_inputs(a, confirmed_penetration_count=3)
    codes = {i.code for i in blocking(issues)}
    assert "ridge_exceeds_perimeter" in codes


def test_empty_geometry_blocks():
    issues = validate_report_inputs({"total_roof_sqft": 0}, confirmed_penetration_count=0)
    assert any(i.code == "empty_geometry" for i in blocking(issues))


def test_squares_area_mismatch_blocks():
    a = _good()
    a["squares"] = 30.0      # 30*100=3000 vs 4410 -> >2% off
    assert any(i.code == "squares_area_mismatch" for i in blocking(validate_report_inputs(a, confirmed_penetration_count=1)))


def test_missing_pitch_blocks():
    a = _good()
    a["predominant_pitch"] = ""
    assert any(i.code == "missing_pitch" for i in blocking(validate_report_inputs(a, confirmed_penetration_count=1)))


def test_zero_penetrations_warns_not_blocks():
    issues = validate_report_inputs(_good(), confirmed_penetration_count=0)
    assert blocking(issues) == []
    assert any(i.code == "penetrations_unreviewed" and i.severity == "warn" for i in issues)
