"""Phase 1: pitch provenance. LiDAR is a coverage fallback that stays OFF (and
returns None, never a guessed metric) until validated; the report labels a
measured pitch as measured and a default as unverified.
"""
import os

from app.services.lidar_pitch import facet_pitch_from_3dep, is_enabled
from app.services.roof_report_v2_pdf import _pitch_source_label


_SQUARE = [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]


def test_lidar_disabled_by_default_returns_none():
    assert is_enabled() is False
    got = facet_pitch_from_3dep(_SQUARE, lat=34.9, lng=-77.5, zoom=20,
                                image_width_px=2048, image_height_px=1366)
    assert got is None


def test_lidar_enabled_still_returns_none_until_pointcloud_implemented(monkeypatch):
    # Enabling the flag must not fabricate a pitch — the point-cloud path is a stub,
    # so it returns None and the pipeline falls through to the next source.
    monkeypatch.setenv("AXIS_LIDAR_PITCH", "1")
    assert is_enabled() is True
    got = facet_pitch_from_3dep(_SQUARE, lat=34.9, lng=-77.5, zoom=20,
                                image_width_px=2048, image_height_px=1366)
    assert got is None


def test_report_labels_measured_vs_default():
    assert _pitch_source_label("solar_measured") == "Measured (Google Solar)"
    assert _pitch_source_label("lidar_measured") == "Measured (USGS LiDAR)"
    assert "unverified" in _pitch_source_label("default").lower()
    assert _pitch_source_label(None) == "Unverified"
    assert _pitch_source_label("manual") == "Contractor entered"
