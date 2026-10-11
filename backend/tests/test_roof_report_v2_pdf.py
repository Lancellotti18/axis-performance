"""The report's account of where its own numbers came from.

The PDF is the product: a number a contractor cannot explain to an adjuster is
worse than no number. These cover the provenance line and the methodology
paragraph, which are what the report says about how it measured the roof.
"""
import pytest

from app.services import roof_report_v2_pdf as R

# ── where the numbers came from, on a roof measured both ways ──────────────
# A roof can be part auto-measured and part hand-traced. This used to be
# all-or-nothing: one hand-drawn facet and the whole report claimed
# "Contractor trace over satellite imagery" while the per-facet table went on
# crediting Google 3D for the rest — the report contradicting itself about its
# own provenance.

def _f(src):
    return {"pitch_source": src}


def test_an_auto_measured_roof_says_so():
    out = R._measured_by({"source": "aerial_outline"}, [_f("solar_3d")] * 3)
    assert out == "Google 3D height data (auto-measured)"


def test_adjusted_outlines_are_counted():
    out = R._measured_by({"source": "aerial_outline"},
                         [_f("solar_3d_edited"), _f("solar_3d_edited"), _f("solar_3d")])
    assert "2 outlines adjusted by contractor" in out


def test_a_roof_measured_both_ways_reports_both():
    facets = [_f("solar_3d")] * 8 + [_f("contractor")]
    out = R._measured_by({"source": "aerial_outline"}, facets)
    assert "8 of 9 facets" in out
    assert "1 traced by contractor" in out
    # The old behaviour, which must not come back.
    assert out != "Contractor trace over satellite imagery"


def test_a_hand_traced_roof_is_still_described_as_one():
    assert R._measured_by({"source": "aerial_outline"}, [_f("contractor")]) \
        == "Contractor trace over satellite imagery"
    assert R._measured_by({"source": "blueprint"}, []) == "Blueprint"


def test_the_methodology_text_names_the_hand_traced_facets():
    styles = R._styles()
    facets = [_f("solar_3d")] * 8 + [_f("contractor")]
    flow = R._section_8_methodology({"source": "aerial_outline"}, {}, styles, facets=facets)
    text = " ".join(getattr(p, "text", "") for p in flow)
    assert "Google's 3D height data" in text, "the 3D method must still be described"
    assert "1 facet" in text and "traced by the contractor" in text
