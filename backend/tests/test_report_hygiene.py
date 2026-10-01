"""Phase 0 / DEFECT-09 report hygiene: address must not duplicate the city/ZIP
already in the street line, and phones format to (XXX) XXX-XXXX."""
from app.services.roof_report_v2_pdf import _format_phone, _normalize_address


def test_address_does_not_duplicate_city():
    # The Richlands bug: city 'RICHLANDS' already in the street line.
    out = _normalize_address("107 E HARGETT ST, RICHLANDS 28574", "RICHLANDS", "NC", "28574")
    assert out.lower().count("richlands") == 1
    assert out == "107 E HARGETT ST, RICHLANDS 28574, NC"


def test_address_builds_normally_when_no_overlap():
    assert _normalize_address("12 Oak St", "Wilmington", "NC", "28401") == "12 Oak St, Wilmington, NC 28401"


def test_phone_formats_valid_us_number():
    assert _format_phone("9105551212") == "(910) 555-1212"
    assert _format_phone("1-910-555-1212") == "(910) 555-1212"


def test_phone_leaves_unrecognizable_untouched():
    assert _format_phone("") is None
    assert _format_phone("7171 353 6876") == "7171 353 6876"   # malformed 11-digit, best-effort raw


def test_address_does_not_repeat_the_state():
    """Brookside Oaks printed '…OWINGS MILLS, MD, 21117, MD'."""
    out = _normalize_address("4302 BROOKSIDE OAKS, OWINGS MILLS, MD, 21117", "OWINGS MILLS", "MD", "21117")
    assert out == "4302 BROOKSIDE OAKS, OWINGS MILLS, MD, 21117"


# ── Layout ────────────────────────────────────────────────────────────────

from app.services import roof_report_v2_pdf as R  # noqa: E402

_MEASURED = [
    {"facet_label": "A", "pitch": "8.1/12", "pitch_source": "solar_3d", "slope_direction": "E",
     "plan_area_sqft": 900.0, "true_area_sqft": 1090.0, "confidence": 0.9,
     "polygon": [[0.4, 0.4], [0.5, 0.4], [0.5, 0.5], [0.4, 0.5]]},
    {"facet_label": "B", "pitch": "10.9/12", "pitch_source": "solar_3d", "slope_direction": "W",
     "plan_area_sqft": 300.0, "true_area_sqft": 405.0, "confidence": 0.9,
     "polygon": [[0.5, 0.4], [0.6, 0.4], [0.6, 0.5], [0.5, 0.5]]},
]


def test_sections_are_numbered_in_the_order_they_print():
    """Fixed numbers skipped every hidden section: 2, 3, 5, 7, 9, 10."""
    styles = R._styles()
    heads = [R._section_header(t, n, styles).text for t, n in (("A", 2), ("B", 5), ("C", 9))]
    assert [h.split("Section ")[1].split(".")[0] for h in heads] == ["1", "2", "3"]


def test_an_auto_measured_roof_is_not_described_as_traced():
    assert "auto-measured" in R._measured_by({"source": "aerial_outline"}, _MEASURED)
    assert "trace" in R._measured_by({"source": "aerial_outline"}, [{**_MEASURED[0], "pitch_source": "manual"}]).lower()
    styles = R._styles()
    text = " ".join(getattr(f, "text", "") for f in
                    R._section_8_methodology({"source": "aerial_outline", "confidence": 0.9}, {}, styles,
                                             facets=_MEASURED))
    assert "height data" in text and "Contractor traced" not in text


def test_pitch_range():
    assert R._pitch_range(_MEASURED) == "8.1/12 – 10.9/12"
    assert R._pitch_range([]) == "—"


def test_a_full_report_renders_without_a_photo():
    pdf = R.generate_v2_report(
        {"name": "4302 Brookside Oaks,", "address": "4302 Brookside Oaks", "city": "Owings Mills",
         "state": "MD", "zip": "21117"},
        {"confidence": 0.97, "source": "aerial_outline", "measurement_scope": "full"},
        {"total_roof_sqft": 1495.0, "total_plan_sqft": 1200.0, "squares": 14.95, "facet_count": 2,
         "predominant_pitch": "8.1/12", "complexity_score": 0.3, "waste_pct_default": 10},
        _MEASURED, [], [], [], [], include_flashing=False, include_siding=False)
    assert pdf[:4] == b"%PDF" and len(pdf) > 5000


def test_a_roof_with_a_few_nudged_outlines_is_still_auto_measured():
    """Ryan adjusted 5 of 9 auto-measured outlines; the report then said
    'Contractor trace' and capped confidence for a coarse photo it wasn't using."""
    facets = [{**_MEASURED[0], "pitch_source": "solar_3d_edited"}, _MEASURED[1]]
    by = R._measured_by({"source": "aerial_outline"}, facets)
    assert "auto-measured" in by and "1 outline adjusted" in by
    assert R._pitch_source_label("solar_3d_edited") == "Measured (3D), edited"
