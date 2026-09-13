"""Every county in PARCEL_SOURCES must carry the fields find-roofs reads
without a guard.

A 500 on Find Roofs traced to `f["city"]` being read directly while the line
above it read the same key defensively. Two counties — pender and york_pa —
have no "city" in their field map, so searching either one 500'd the entire
search rather than just omitting a column.

Adding a county is the moment this breaks, and it breaks in production for
that county only. This test makes a missing key fail at build time instead.
"""
from app.api.v1.prospecting import PARCEL_SOURCES

# Read unguarded in the find_roofs row loop, so every county must have them.
REQUIRED_FIELD_KEYS = {"pin"}
# Read off the source dict itself (not the "f" map) whenever a city filter is
# supplied, so a county without it 500s as soon as someone types a city.
REQUIRED_SOURCE_KEYS = {"url", "residential_where", "city_field", "f"}


def test_every_county_has_the_unguarded_field_keys():
    missing = {
        county: sorted(REQUIRED_FIELD_KEYS - set(cfg.get("f", {})))
        for county, cfg in PARCEL_SOURCES.items()
        if REQUIRED_FIELD_KEYS - set(cfg.get("f", {}))
    }
    assert not missing, f"counties missing unguarded field-map keys: {missing}"


def test_every_county_has_the_keys_a_city_filter_needs():
    missing = {
        county: sorted(REQUIRED_SOURCE_KEYS - set(cfg))
        for county, cfg in PARCEL_SOURCES.items()
        if REQUIRED_SOURCE_KEYS - set(cfg)
    }
    assert not missing, f"counties missing source keys: {missing}"


def test_a_county_may_omit_city_without_breaking_the_row_builder():
    """pender and york_pa legitimately have no city column. That must stay
    survivable — the row omits city rather than the request failing."""
    no_city = [c for c, cfg in PARCEL_SOURCES.items() if "city" not in cfg.get("f", {})]
    assert no_city, (
        "This test guards the no-city path. If every county now has a city "
        "field, keep the guarded read anyway — the next county added may not."
    )
    src = (pathlib := __import__("pathlib")).Path(
        __import__("app.api.v1.prospecting", fromlist=["__file__"]).__file__
    ).read_text()
    assert 'a.get(f["city"])' not in src, (
        'find_roofs reads f["city"] without a guard again — it must use the '
        "city_val computed above, or counties without a city column will 500."
    )
