"""
Tests for the EagleView-style roof outline service.

Math-only coverage — the LLM vision call is stubbed so these run offline.
Verifies coordinate sanitization, shoelace area, and lat/zoom → ft-per-pixel
so we'd catch drift in the Esri Web Mercator conversion if someone changed
the constant.
"""
from __future__ import annotations

import math

import pytest

from app.services import roof_outline_service as ros


def test_sanitize_strips_code_fences():
    raw = '```json\n{"polygon": []}\n```'
    assert ros._sanitize(raw) == '{"polygon": []}'


def test_sanitize_keeps_plain_json():
    raw = '{"polygon": [[0.1, 0.1]]}'
    assert ros._sanitize(raw) == raw


def test_sanitize_trims_prose_around_object():
    raw = 'Here is the polygon:\n{"polygon": [[0, 0]]}\nHope this helps.'
    cleaned = ros._sanitize(raw)
    assert cleaned.startswith("{") and cleaned.endswith("}")


def test_polygon_area_fraction_unit_square():
    poly = [[0, 0], [1, 0], [1, 1], [0, 1]]
    assert ros._polygon_area_fraction(poly) == pytest.approx(1.0)


def test_polygon_area_fraction_triangle():
    poly = [[0, 0], [1, 0], [0, 1]]
    assert ros._polygon_area_fraction(poly) == pytest.approx(0.5)


def test_polygon_area_fraction_degenerate_returns_zero():
    assert ros._polygon_area_fraction([]) == 0.0
    assert ros._polygon_area_fraction([[0, 0], [1, 1]]) == 0.0


@pytest.mark.asyncio
async def test_detect_roof_outline_computes_feet_from_fractions(monkeypatch):
    """
    Stub _download + llm_vision so the service only exercises math. A 1.0×1.0
    fraction polygon over a 1280×840 tile at zoom=18, lat=35° should yield a
    predictable sqft figure we can check to tight tolerance.
    """
    async def fake_download(url):  # noqa: ARG001
        return b"", "image/png"

    async def fake_vision(*args, **kwargs):  # noqa: ARG001
        import json
        return json.dumps({
            "polygon": [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
            "confidence": 0.9,
            "structure": "rectangular",
            "notes": "full-frame test",
            "warnings": [],
        })

    monkeypatch.setattr(ros, "_download", fake_download)
    monkeypatch.setattr(ros, "llm_vision", fake_vision)

    result = await ros.detect_roof_outline(
        "https://example.com/tile.png",
        lat=35.0,
        image_width_px=1280,
        image_height_px=840,
        zoom=18,
    )

    # Expected ft/px at lat=35°, zoom=18
    mpp = (156543.03392 * math.cos(math.radians(35.0))) / (2 ** 18)
    ft_per_px = mpp * 3.28084
    expected_sqft = 1280 * 840 * (ft_per_px ** 2)
    expected_perim = 2 * (1280 * ft_per_px + 840 * ft_per_px)

    assert result["estimated_sqft"] == pytest.approx(round(expected_sqft, 1))
    assert result["estimated_perimeter_ft"] == pytest.approx(round(expected_perim, 1))
    assert result["confidence"] == 0.9
    assert len(result["polygon"]) == 4


@pytest.mark.asyncio
async def test_detect_roof_outline_clamps_out_of_range_coords(monkeypatch):
    async def fake_download(url):  # noqa: ARG001
        return b"", "image/png"

    async def fake_vision(*args, **kwargs):  # noqa: ARG001
        import json
        return json.dumps({
            "polygon": [[-0.5, 2.0], [1.5, 0.0], [0.5, 0.5]],
            "confidence": 0.5,
        })

    monkeypatch.setattr(ros, "_download", fake_download)
    monkeypatch.setattr(ros, "llm_vision", fake_vision)

    result = await ros.detect_roof_outline("https://x", lat=None)
    # All x,y should be in [0,1]
    for x, y in result["polygon"]:
        assert 0.0 <= x <= 1.0
        assert 0.0 <= y <= 1.0
    # Without lat, no area computed
    assert result["estimated_sqft"] is None


@pytest.mark.asyncio
async def test_detect_roof_outline_rejects_empty_url():
    with pytest.raises(ValueError):
        await ros.detect_roof_outline("")
