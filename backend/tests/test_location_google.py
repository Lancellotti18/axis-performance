"""Addresses resolve to Google's ROOFTOP position, not the Census estimate.

The Census geocoder put 1114 Willow Pond Ln, Leland (the first founding
contractor's job) on 1146 Willow Pond Ln, 353 m away, so the house picker
showed him — and Ryan — the wrong house."""
import asyncio

from app.services import location_service as L

GEOCODE = {"status": "OK", "results": [
    {"formatted_address": "1114 Willow Pond Ln, Leland, NC 28451, USA",
     "geometry": {"location": {"lat": 34.2282632, "lng": -78.0487777}, "location_type": "ROOFTOP"},
     "address_components": [
         {"long_name": "1114", "short_name": "1114", "types": ["street_number"]},
         {"long_name": "Willow Pond Lane", "short_name": "Willow Pond Ln", "types": ["route"]},
         {"long_name": "Leland", "short_name": "Leland", "types": ["locality", "political"]},
         {"long_name": "Brunswick County", "short_name": "Brunswick County", "types": ["administrative_area_level_2", "political"]},
         {"long_name": "North Carolina", "short_name": "NC", "types": ["administrative_area_level_1", "political"]},
         {"long_name": "28451", "short_name": "28451", "types": ["postal_code"]}]},
]}

AUTOCOMPLETE = {"suggestions": [
    {"placePrediction": {"placeId": "ChIJ_52t", "text": {"text": "1114 Willow Pond Ln, Leland, NC, USA"},
                         "structuredFormat": {"mainText": {"text": "1114 Willow Pond Ln"},
                                              "secondaryText": {"text": "Leland, NC, USA"}}}}]}


def test_a_google_result_is_the_rooftop_with_the_county():
    m = L._parse_google_geocode(GEOCODE)[0]
    assert (m.lat, m.lng) == (34.2282632, -78.0487777)
    assert m.source == "google:rooftop"
    assert m.street == "1114 Willow Pond Lane" and m.city == "Leland" and m.state == "NC" and m.zip == "28451"
    assert m.county == "Brunswick"
    assert m.matched_address == "1114 Willow Pond Ln, Leland, NC 28451"


def test_rooftop_results_come_before_estimates():
    approx = {**GEOCODE["results"][0], "geometry": {"location": {"lat": 1, "lng": 2}, "location_type": "APPROXIMATE"}}
    payload = {"status": "OK", "results": [approx, GEOCODE["results"][0]]}
    assert L._parse_google_geocode(payload)[0].source == "google:rooftop"


def test_a_refused_request_is_no_result_not_an_error():
    assert L._parse_google_geocode({"status": "REQUEST_DENIED"}) == []


def test_suggestions_parse_and_carry_no_position():
    m = L._parse_google_autocomplete(AUTOCOMPLETE)[0]
    assert m.matched_address == "1114 Willow Pond Ln, Leland, NC"
    assert m.street == "1114 Willow Pond Ln" and m.city == "Leland" and m.state == "NC"
    assert (m.lat, m.lng) == (0.0, 0.0)


def _wire(monkeypatch, google, census):
    calls = []
    async def g(client, q): calls.append("google"); return L._parse_google_geocode(GEOCODE) if google else []
    async def c(client, q): calls.append("census"); return census
    async def m(client, q, **k): calls.append("maptiler"); return []
    async def fcc(client, lat, lng): return {"county": "Brunswick", "county_fips": "37019", "state_fips": "37"}
    monkeypatch.setattr(L, "_google_geocode", g)
    monkeypatch.setattr(L, "_census_geographies", c)
    monkeypatch.setattr(L, "_maptiler_autocomplete", m)
    monkeypatch.setattr(L, "_fcc_county_from_latlng", fcc)
    return calls


def test_validation_asks_google_first_and_fills_fips(monkeypatch):
    calls = _wire(monkeypatch, google=True, census=[])
    m = asyncio.run(L.validate_address("1114 Willow Pond Ln, Leland, NC"))
    assert calls == ["google"]
    assert m.source == "google:rooftop" and m.county_fips == "37019" and m.state_fips == "37"


def test_census_is_the_fallback_when_google_has_nothing(monkeypatch):
    census = [L.LocationMatch("x", "x", "Leland", "NC", "28451", 34.23, -78.05, "Brunswick", "37019", "37", "census")]
    calls = _wire(monkeypatch, google=False, census=census)
    m = asyncio.run(L.validate_address("1114 Willow Pond Ln, Leland, NC"))
    assert calls == ["google", "census"] and m.source == "census"
