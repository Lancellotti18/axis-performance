"""Reading Google's 3D files and finding the tapped house in them.

Placing the tap on the wrong pixel would measure the wrong roof, so the
position maths is checked against values that do not depend on this code.
"""
import io
import math

import numpy as np
import pytest

from app.services import solar_layers_service as L


# ── UTM, against independently known values ───────────────────────────────

def test_a_point_on_the_central_meridian_has_easting_500000():
    e, n, z = L.latlng_to_utm(35.0, -75.0)        # zone 18's central meridian
    assert z == 18 and e == pytest.approx(500000.0, abs=0.01)


def test_the_equator_has_northing_zero():
    e, n, _ = L.latlng_to_utm(0.0, -75.0)
    assert n == pytest.approx(0.0, abs=0.01)


def test_northing_at_45_degrees_matches_the_meridian_arc():
    """WGS84 meridian arc to 45 N is 4,984,944.4 m; times UTM's 0.9996."""
    _, n, _ = L.latlng_to_utm(45.0, -75.0)
    assert n == pytest.approx(4984944.4 * 0.9996, abs=0.5)


def test_one_metre_of_ground_is_about_one_metre_of_grid():
    """Moving 1 m east of a Wilmington house moves ~1 m in easting — the scale
    factor near a zone's middle is within 0.1% of 1."""
    lat, lng = 34.2257, -77.9447
    e0, n0, _ = L.latlng_to_utm(lat, lng)
    dlng = 1.0 / (111320.0 * math.cos(math.radians(lat)))
    e1, n1, _ = L.latlng_to_utm(lat, lng + dlng)
    assert math.hypot(e1 - e0, n1 - n0) == pytest.approx(1.0, rel=0.002)


def test_buch_ave_is_in_zone_18():
    assert L.utm_zone(-76.3227374) == 18


# ── GeoTIFF reading ───────────────────────────────────────────────────────

def _geotiff(arr, origin_e, origin_n, px, epsg=32618, mode="F"):
    """A minimal GeoTIFF: pixels plus the three tags Google's files carry."""
    from PIL import Image, TiffImagePlugin
    im = Image.fromarray(arr.astype(np.float32) if mode == "F" else arr.astype(np.uint8), mode)
    info = TiffImagePlugin.ImageFileDirectory_v2()
    info[33550] = (px, px, 0.0)
    info.tagtype[33550] = 12                      # DOUBLE
    info[33922] = (0.0, 0.0, 0.0, origin_e, origin_n, 0.0)
    info.tagtype[33922] = 12
    info[34735] = (1, 1, 0, 1, 3072, 0, 1, epsg)
    info.tagtype[34735] = 3                       # SHORT
    buf = io.BytesIO()
    im.save(buf, format="TIFF", tiffinfo=info)
    return buf.getvalue()


def test_a_geotiff_round_trips_pixels_and_position():
    arr = np.arange(12, dtype=np.float32).reshape(3, 4)
    r = L.read_geotiff(_geotiff(arr, 400000.0, 4430000.0, 0.1))
    assert np.array_equal(r.data, arr)
    assert r.scale_x == pytest.approx(0.1) and r.epsg == 32618
    assert r.pixel_of(400000.05, 4429999.95) == (0, 0)
    assert r.pixel_of(400000.35, 4429999.75) == (2, 3)


# ── Finding the tapped house ──────────────────────────────────────────────

def _scene(lat, lng, offset_px=(0, 0)):
    """A 70 m x 70 m tile at 0.1 m whose house sits at the tap (plus an offset)."""
    e, n, _ = L.latlng_to_utm(lat, lng)
    size = 700
    origin_e = e - 35.0 + offset_px[1] * 0.1
    origin_n = n + 35.0 - offset_px[0] * 0.1
    dsm = np.zeros((size, size), np.float32)
    mask = np.zeros((size, size), np.uint8)
    dsm[300:400, 300:400] = 5.0
    mask[300:400, 300:400] = 1
    return (L.Raster(dsm, 0.1, 0.1, origin_e, origin_n, 32618),
            L.Raster(mask, 0.1, 0.1, origin_e, origin_n, 32618))


def test_the_tap_lands_on_the_right_pixel():
    lat, lng = 40.0949358, -76.3227374               # 339 Buch Ave, tapped point
    dsm, mask = _scene(lat, lng)
    s = L.assemble(dsm, mask, None, lat, lng, {"imagery_date": "2023-05-01"})
    assert s.available
    assert s.seed_rc == (350, 350)                   # the house centre, not a corner
    assert s.mask[s.seed_rc] and s.px_m == pytest.approx(0.1)


def test_the_tap_follows_the_files_georeference_not_the_image_centre():
    """If Google's tile is not centred on the tap, the seed must move with it —
    assuming the centre is how a neighbour's roof gets measured."""
    lat, lng = 40.0949358, -76.3227374
    # Shifting the TILE's origin by (+40 rows, -60 cols) moves the tapped point
    # the opposite way within it: from (350, 350) to (310, 410).
    dsm, mask = _scene(lat, lng, offset_px=(40, -60))
    s = L.assemble(dsm, mask, None, lat, lng, {})
    assert s.seed_rc == (310, 410)


def test_a_tap_outside_the_returned_area_is_refused():
    lat, lng = 40.0949358, -76.3227374
    dsm, mask = _scene(lat, lng, offset_px=(0, 400))
    s = L.assemble(dsm, mask, None, lat, lng, {})
    assert not s.available and "outside" in s.reason


def test_an_unexpected_projection_is_refused_not_guessed():
    lat, lng = 40.0949358, -76.3227374
    dsm, mask = _scene(lat, lng)
    dsm.epsg = 3857                                   # web mercator: not what Google sends
    s = L.assemble(dsm, mask, None, lat, lng, {})
    assert not s.available and "EPSG:3857" in s.reason


def test_missing_key_is_reported():
    import asyncio
    s = asyncio.run(L.fetch_layers(40.0, -76.0, ""))
    assert not s.available and "not configured" in s.reason
