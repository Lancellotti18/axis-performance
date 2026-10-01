"""Coverage: does the trace cover the building Google sees?

The run this exists for: e420330e, 339 Buch Ave. A clean outline of 1,473 sq ft
of a roof whose footprint is ~2,062 sq ft (per the Aspen report), 33% short on
squares, reported High (97%). Every internal plausibility check passed, because
nothing in a self-consistent partial trace contradicts itself.
"""
from app.services import report_validators as rv
from app.services.report_validators import trace_coverage

ASPEN_TRACED_PLAN = 1473.1
ASPEN_FOOTPRINT = 2062.0


def _agg(plan=ASPEN_TRACED_PLAN, roof=1705.9):
    return {"total_plan_sqft": plan, "total_roof_sqft": roof}


def _ref(ground=ASPEN_FOOTPRINT, roof=2400.0, dist=6.0):
    return {"ground_sqft": ground, "roof_sqft": roof, "distance_m": dist}


def test_the_run_that_shipped_is_capped_to_low():
    cov = trace_coverage(_agg(), _ref())
    assert cov is not None
    assert 0.70 < cov.ratio < 0.72
    assert cov.basis == "footprint"
    assert cov.cap == rv.CAP_LOW
    assert cov.cap < 0.55                 # below the report's Moderate band
    assert "71%" in cov.signal and "2,062" in cov.signal


def test_a_complete_trace_is_left_alone():
    cov = trace_coverage(_agg(plan=2010.0), _ref())
    assert cov is not None and cov.cap is None and cov.signal is None


def test_a_missed_section_is_moderate_not_low():
    cov = trace_coverage(_agg(plan=0.86 * ASPEN_FOOTPRINT), _ref())
    assert cov.cap == rv.CAP_MODERATE


def test_tracing_far_beyond_the_building_is_flagged():
    cov = trace_coverage(_agg(plan=1.6 * ASPEN_FOOTPRINT), _ref())
    assert cov.cap == rv.CAP_MODERATE
    assert "neighbouring structure" in cov.signal


def test_a_declared_partial_trace_is_never_second_guessed():
    assert trace_coverage(_agg(), _ref(), partial=True) is None


def test_no_opinion_when_google_may_describe_another_building():
    assert trace_coverage(_agg(), _ref(dist=55.0)) is None


def test_no_opinion_without_a_tapped_house():
    """distance_m is None when Solar was queried at the tile centre — there is
    no way to know it found the right building."""
    assert trace_coverage(_agg(), _ref(dist=None)) is None


def test_no_opinion_without_a_reference():
    assert trace_coverage(_agg(), None) is None
    assert trace_coverage(_agg(), {}) is None


def test_a_shed_sized_reference_is_ignored():
    assert trace_coverage(_agg(), _ref(ground=120.0, roof=150.0)) is None


def test_falls_back_to_roof_area_when_google_omits_the_footprint():
    cov = trace_coverage(_agg(roof=1705.9), _ref(ground=0.0, roof=2600.0))
    assert cov.basis == "roof area"
    assert cov.cap == rv.CAP_LOW          # 1706 / 2600 = 66%


def test_an_empty_trace_is_not_judged():
    assert trace_coverage(_agg(plan=0.0, roof=0.0), _ref()) is None


# ── Imagery resolution ────────────────────────────────────────────────────

from app.services.report_validators import imagery_resolution, COARSE_FT_PER_PX


def test_zoom_19_at_buch_ave_is_coarse():
    r = imagery_resolution(40.0947, 19)          # 339 Buch Ave, Lancaster PA
    assert r.coarse and 0.70 < r.ft_per_px < 0.80
    assert "zoom 19" in r.signal


def test_zoom_20_in_wilmington_is_fine():
    r = imagery_resolution(34.2257, 20)
    assert not r.coarse and r.ft_per_px < COARSE_FT_PER_PX and r.signal is None


def test_no_tile_no_opinion():
    assert imagery_resolution(None, 20) is None
    assert imagery_resolution(40.0, None) is None


# ── The PDF says it ───────────────────────────────────────────────────────

def _texts(flowables):
    out = []
    for f in flowables:
        if hasattr(f, "text"):
            out.append(f.text)
        for row in getattr(f, "_cellvalues", []) or []:
            for cell in row:
                out.append(cell if isinstance(cell, str) else getattr(cell, "text", ""))
    return "\n".join(out)


def _aspen_aggregates():
    cov = trace_coverage(_agg(), _ref())
    return {
        "confidence": cov.cap,
        "partial_signals": [cov.signal, imagery_resolution(40.0947, 19).signal],
        "trace_coverage": {"ratio": cov.ratio, "traced_sqft": cov.traced_sqft,
                           "reference_sqft": cov.reference_sqft, "basis": cov.basis,
                           "capped": True},
        "imagery_ft_per_px": 0.75,
    }


def test_methodology_page_gives_the_reasons_and_the_resolution():
    from app.services.roof_report_pdf import _styles
    from app.services.roof_report_v2_pdf import _section_8_methodology
    agg = _aspen_aggregates()
    run = {"confidence": agg["confidence"], "imagery_health": 1.0}
    text = _texts(_section_8_methodology(run, agg, _styles()))
    assert "Low (45%)" in text
    assert "Check before ordering" in text and "71%" in text
    assert "0.75 ft per pixel" in text


def test_a_passing_coverage_check_is_stated_too():
    from app.services.roof_report_pdf import _styles
    from app.services.roof_report_v2_pdf import _section_8_methodology
    agg = {"confidence": 0.9, "partial_signals": [],
           "trace_coverage": {"ratio": 0.98, "reference_sqft": 2062, "basis": "footprint",
                              "capped": False}}
    text = _texts(_section_8_methodology({"confidence": 0.9}, agg, _styles()))
    assert "Coverage check" in text and "98%" in text
    assert "Check before ordering" not in text
