"""The tapped house must be the job's house. The comparison is where a silent
bug would hide, so it is pinned here case by case."""
import pytest

from app.services.address_match import compare, parse, parse_google, parse_maptiler

JOB = "1422 Oak Street, Wilmington, NC 28403"


@pytest.mark.parametrize("found", [
    "1422 Oak St, Wilmington, NC",
    "1422 OAK ST",
    "1422 N Oak Street, Wilmington",          # a direction the job didn't write
    "1422 Oak St Apt 2",                      # a unit
    "1422 Oak Street",
])
def test_the_same_house_written_differently_matches(found):
    assert compare(JOB, found).status == "match"


def test_the_neighbour_on_the_same_street_is_a_mismatch_and_says_so():
    c = compare(JOB, "1418 Oak St, Wilmington, NC")
    assert c.status == "mismatch"
    assert "1418 Oak St" in c.message and "1422 Oak Street" in c.message
    assert "neighbouring house" in c.message


def test_the_same_number_on_another_street_is_a_mismatch():
    c = compare(JOB, "1422 Elm St, Wilmington, NC")
    assert c.status == "mismatch" and "Corner houses" in c.message


def test_the_buch_ave_address_parses():
    p = parse("339 Buch Ave, Lancaster, PA 17601")
    assert p.number == "339" and p.street == ("buch",)


@pytest.mark.parametrize("found", [None, "", "Oak Street, Wilmington"])
def test_no_house_number_means_unknown_not_a_false_alarm(found):
    assert compare(JOB, found).status == "unknown"


def test_a_job_with_no_house_number_is_unknown():
    assert compare("Oak Street, Wilmington", "1422 Oak St").status == "unknown"


@pytest.mark.parametrize("a,b", [
    ("12A Main St", "12a Main Street"),
    ("100-102 Pine Rd", "100-102 Pine Road"),
    ("7 Martin Luther King Jr Blvd", "7 Martin Luther King Jr Boulevard"),
])
def test_house_number_and_street_variants(a, b):
    assert compare(a, b).status == "match"


def test_digit_prefixes_are_not_confused():
    """1422 vs 142: a naive startswith would call these the same house."""
    assert compare(JOB, "142 Oak St").status == "mismatch"


# ── Provider parsing ──────────────────────────────────────────────────────

def test_google_response_parses_to_number_and_route():
    payload = {"status": "OK", "results": [{"address_components": [
        {"long_name": "1418", "types": ["street_number"]},
        {"long_name": "Oak Street", "types": ["route"]},
        {"long_name": "Wilmington", "types": ["locality", "political"]},
    ]}]}
    assert parse_google(payload) == "1418 Oak Street, Wilmington"


@pytest.mark.parametrize("payload", [
    {"status": "REQUEST_DENIED", "error_message": "API not enabled"},
    {"status": "ZERO_RESULTS", "results": []},
    {"status": "OK", "results": [{"address_components": [
        {"long_name": "Oak Street", "types": ["route"]}]}]},
])
def test_google_without_a_house_number_gives_nothing(payload):
    assert parse_google(payload) is None


def test_maptiler_response_parses():
    payload = {"features": [{"address": "1418", "text": "Oak Street",
                             "place_name": "1418 Oak Street, Wilmington"}]}
    assert parse_maptiler(payload) == "1418 Oak Street"
    assert parse_maptiler({"features": [{"text": "Oak Street"}]}) is None


def test_a_street_that_merely_contains_the_name_is_a_different_street():
    assert compare(JOB, "1422 Oak Hill Rd").status == "mismatch"
    assert compare("5 Pine Ct", "5 Pine Valley Ct").status == "mismatch"
