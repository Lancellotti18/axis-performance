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
