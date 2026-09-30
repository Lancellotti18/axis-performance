"""Put an automatic 3D measurement onto a run, exactly as if it had been traced.

roof_from_dsm measures the roof in Google's UTM grid. The rest of Axis — the
editor, the report, the material list — works in FRACTIONS of the run's own
satellite image. This module moves the outlines from one to the other.

The anchor is the contractor's tap (subject_point), which records both where in
the image the house was tapped and where on the ground that is. The satellite
tile is often NOT centred on the house, so the image centre is never used. UTM
is a metric grid, so each vertex is simply "so many metres east and north of
the tap", and the fraction follows from the tile's metres-per-pixel — the same
basis geometry_service uses for every area and length.
"""
from __future__ import annotations

from typing import Optional

from app.services import geometry_service as geo
from app.services.roof_from_dsm import AxisFacet, RoofModel, axis_facets
from app.services.solar_layers_service import LayerSet, latlng_to_utm


def to_fraction(col: float, row: float, layers: LayerSet, tap_en: tuple[float, float],
                tap_xy: tuple[float, float], mpp: float, w: int, h: int) -> list[float]:
    # Outline vertices are in pixel-CENTRE coordinates: pixel (c, r)'s centre
    # sits half a pixel in from its top-left corner.
    e = layers.origin_e + (col + 0.5) * layers.px_m
    n = layers.origin_n - (row + 0.5) * layers.px_m
    fx = tap_xy[0] + (e - tap_en[0]) / (w * mpp)
    fy = tap_xy[1] - (n - tap_en[1]) / (h * mpp)
    return [round(fx, 6), round(fy, 6)]


def build_payload(model: RoofModel, layers: LayerSet, subject_point: dict, *,
                  width_px: int, height_px: int, zoom: int, lat: float
                  ) -> tuple[list[dict], list[dict]]:
    """(facets, edges) shaped like the FacetIn / EdgeIn bodies of PUT
    /runs/{id}/facets and /edges, so they are stored by the same code a hand
    trace is and every downstream number is computed the same way."""
    tap_e, tap_n, _ = latlng_to_utm(float(subject_point["lat"]), float(subject_point["lng"]),
                                     (layers.epsg - 32600) if layers.epsg else None)
    tap_xy = (float(subject_point["x"]), float(subject_point["y"]))
    mpp = geo.metres_per_pixel(lat, zoom)
    afs: list[AxisFacet] = axis_facets(model)
    label_of = {a.fid: a.label for a in afs}
    facets, edges = [], []
    for a in afs:
        poly = [to_fraction(c, r, layers, (tap_e, tap_n), tap_xy, mpp, width_px, height_px)
                for c, r in a.vertices_px]
        facets.append({
            "facet_label": a.label,
            "polygon": poly,
            # One decimal: a 10.6/12 roof stored as 11/12 is ~2% of its area.
            "pitch": f"{a.pitch_12:.1f}/12",
            "pitch_source": "solar_3d",
            "confidence": 0.9,
            "user_confirmed": False,
            "ai_suggested": True,
        })
        n = len(poly)
        for i, (kind, nb) in enumerate(a.sides):
            edges.append({
                "facet_label": a.label,
                "vertex_index_start": i,
                "vertex_index_end": (i + 1) % n,
                "edge_type": kind,
                "shared_with_facet_label": label_of.get(nb) if nb is not None else None,
                "user_confirmed": False,
            })
    return facets, edges
