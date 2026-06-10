"""
APIR test fixtures — internally-consistent test data for the diagram renderer.

APIR's spec ships a TEST_MEASUREMENTS object in Diagram 4g but its
pixels_per_foot=2.5 field doesn't match the polygon dimensions (the polygons
imply ~10.5 px/ft). Tests written against it would assert wrong numbers.

This module provides APIR_TEST_PROPERTY: same 5-facet topology as the spec
(RF-1 large front slope, RF-2/RF-3 right wing, RF-4 large back slope, RF-5
porch), but every length / area is recomputed from a single canonical scale.

Scale: 10.515 px/ft (= 320px width / 30.42ft from APIR's RF-1 ridge claim).
At this scale RF-1's polygon (320 × 179 px) produces:
    projected_area = (320 × 179) / 10.515² = 517.6 sqft
    actual_area at 5/12 = 517.6 × 1.0833 = 560.7 sqft
which is what shoelace_area_sqft + actual_roof_area_sqft return. Every other
number in this fixture is computed the same way.
"""
from __future__ import annotations

from app.schemas.apir import PointPx


# Canonical scale for the fixture. Don't change without regenerating expected
# areas / lengths below.
APIR_TEST_PIXELS_PER_FOOT = 10.5155161  # = 320 / 30.42

# Polygon coordinates match APIR's Diagram 4g spec exactly. Topology:
#
#     y=130  ┌────────┬────┐
#            │  RF-4  │RF-3│
#            │ back   │NE  │
#     y=310  ├────────┼────┤
#  y=210 ┌───┤  RF-1  │RF-2│
#        │RF5│ front  │SE  │
#  y=310 └───┤        │    │
#            │        │    │
#     y=489  └────────┴────┘
#         x=16 100      420 552
APIR_TEST_FACET_POLYGONS: dict[str, list[PointPx]] = {
    "RF-1": [PointPx(x=100, y=310), PointPx(x=420, y=310),
             PointPx(x=420, y=489), PointPx(x=100, y=489)],
    "RF-2": [PointPx(x=420, y=310), PointPx(x=552, y=310),
             PointPx(x=552, y=489), PointPx(x=420, y=489)],
    "RF-3": [PointPx(x=420, y=130), PointPx(x=552, y=130),
             PointPx(x=552, y=310), PointPx(x=420, y=310)],
    "RF-4": [PointPx(x=100, y=130), PointPx(x=420, y=130),
             PointPx(x=420, y=310), PointPx(x=100, y=310)],
    "RF-5": [PointPx(x=16, y=210), PointPx(x=100, y=210),
             PointPx(x=100, y=310), PointPx(x=16, y=310)],
}

APIR_TEST_FOOTPRINT_POLYGON: list[PointPx] = [
    PointPx(x=100, y=130), PointPx(x=552, y=130),
    PointPx(x=552, y=489), PointPx(x=100, y=489),
]

# Job row equivalent — wired so the extraction orchestrator picks Web Mercator
# at z22 lat 35.5° (~9.78m/px → ~9.96 ft/px → 19.93 px/ft @ retina 2x).
# We override pixels_per_foot via the assembled PropertyMeasurements rather
# than the job_row, so the scale stays the canonical 10.5155.
APIR_TEST_JOB_ROW: dict = {
    "id": "apir-test-job",
    "property_address": "11318 Sword Road",
    "property_city": "Williamsport",
    "property_state": "MD",
    "property_zip": "21795",
    "satellite_image_url": "https://example.com/test_satellite.png",
    "satellite_zoom": None,        # NULL so extraction falls back to footprint
    "satellite_lat": None,
    "stories": 1,
}

APIR_TEST_CONTRACTOR_ROW: dict = {
    "company_name": "Axis Test Roofing Co",
    "contact_name": "Test Contractor",
    "address": "123 Main St",
    "city_state_zip": "Anywhere, USA 12345",
    "phone": "555-0100",
    "email": "test@axisperformance.io",
    "logo_url": "",
    "license_number": "TEST-001",
    "website": "https://axisperformance.io",
}


def build_apir_test_property():
    """
    Build a fully-assembled PropertyMeasurements from the canonical fixture.
    Uses the extraction orchestrator with no photos (deterministic — no AI),
    then overwrites pixels_per_foot + scale_method to canonical so every
    test asserts against the same scale.
    """
    import asyncio
    from app.services.report.extraction import (
        build_property_measurements, ExtractionInput,
    )

    inp = ExtractionInput(
        job_row=APIR_TEST_JOB_ROW,
        contractor_row=APIR_TEST_CONTRACTOR_ROW,
        facet_polygons=APIR_TEST_FACET_POLYGONS,
        footprint_polygon=APIR_TEST_FOOTPRINT_POLYGON,
        elevation_photo_bytes={},
        eave_photo_bytes=[],
        overhead_photo_bytes=None,
        roof_waste_pct=12,
        siding_waste_pct=10,
    )
    pm = asyncio.run(build_property_measurements(inp))

    # Override the footprint-estimate scale with the canonical one so all
    # tests assert against the same fixed numbers. The downstream diagram
    # renderer doesn't care about scale (it scales-to-fit) — this only
    # matters for tests asserting specific sqft / lnft values.
    pm.job.pixels_per_foot = APIR_TEST_PIXELS_PER_FOOT
    pm.job.scale_method = "estimated"
    pm.job.scale_confidence = "estimated"
    return pm
