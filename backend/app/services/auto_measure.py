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
                tap_xy: tuple[float, float], mpp: float, w: int, h: int,
                shift_en: tuple[float, float] = (0.0, 0.0)) -> list[float]:
    # Outline vertices are in pixel-CENTRE coordinates: pixel (c, r)'s centre
    # sits half a pixel in from its top-left corner. shift_en is how far the
    # contractor's photo sits from Google's data (imagery_align).
    e = layers.origin_e + (col + 0.5) * layers.px_m
    n = layers.origin_n - (row + 0.5) * layers.px_m
    fx = tap_xy[0] + (e - tap_en[0] + shift_en[0]) / (w * mpp)
    fy = tap_xy[1] - (n - tap_en[1] + shift_en[1]) / (h * mpp)
    return [round(fx, 6), round(fy, 6)]


def tap_utm(layers: LayerSet, subject_point: dict) -> tuple[float, float]:
    e, n, _ = latlng_to_utm(float(subject_point["lat"]), float(subject_point["lng"]),
                            (layers.epsg - 32600) if layers.epsg else None)
    return e, n


def pixel_mappers(layers: LayerSet, subject_point: dict, *, tile_w: int, tile_h: int,
                  width_px: int, height_px: int, zoom: int, lat: float):
    """(tile_px_of, google_px_of) for imagery_align, both taking metres from the tap."""
    te, tn = tap_utm(layers, subject_point)
    tx, ty = float(subject_point["x"]), float(subject_point["y"])
    mpp = geo.metres_per_pixel(lat, zoom)

    def tile_px_of(east, north):
        return ((tx + east / (width_px * mpp)) * tile_w - 0.5,
                (ty - north / (height_px * mpp)) * tile_h - 0.5)

    def google_px_of(east, north):
        return ((te + east - layers.origin_e) / layers.px_m - 0.5,
                (layers.origin_n - (tn + north)) / layers.px_m - 0.5)
    return tile_px_of, google_px_of


def building_bounds(model: RoofModel, layers: LayerSet, subject_point: dict):
    """(e_min, e_max, n_min, n_max) of the measured building, metres from the tap."""
    import numpy as np
    te, tn = tap_utm(layers, subject_point)
    rr, cc = np.nonzero(model.labels >= 0)
    e = layers.origin_e + (cc + 0.5) * layers.px_m - te
    n = layers.origin_n - (rr + 0.5) * layers.px_m - tn
    return float(e.min()), float(e.max()), float(n.min()), float(n.max())


def seed_for(layers: LayerSet, subject_point: dict, shift_en: tuple[float, float]):
    """The tapped point's pixel in Google's data, corrected for the photo shift:
    the contractor tapped the roof AS DRAWN in their photo, which is Google's
    roof moved by shift_en."""
    te, tn = tap_utm(layers, subject_point)
    col = (te - shift_en[0] - layers.origin_e) / layers.px_m
    row = (layers.origin_n - (tn - shift_en[1])) / layers.px_m
    return int(row), int(col)


def build_payload(model: RoofModel, layers: LayerSet, subject_point: dict, *,
                  width_px: int, height_px: int, zoom: int, lat: float,
                  shift_en: tuple[float, float] = (0.0, 0.0)
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
    facing = {f.id: f.azimuth_deg for f in model.facets}
    facets, edges = [], []
    for a in afs:
        poly = [to_fraction(c, r, layers, (tap_e, tap_n), tap_xy, mpp, width_px, height_px, shift_en)
                for c, r in a.vertices_px]
        facets.append({
            "facet_label": a.label,
            "polygon": poly,
            # One decimal: a 10.6/12 roof stored as 11/12 is ~2% of its area.
            "pitch": f"{a.pitch_12:.1f}/12",
            "pitch_source": "solar_3d",
            # The way the plane faces, from its fit — what "Direction" means.
            "azimuth_deg": round(float(facing[a.fid]) % 360.0, 1) if a.fid in facing else None,
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


def google_backdrop(layers: LayerSet, subject_point: dict, tile_rgb, *,
                    width_px: int, height_px: int, zoom: int, lat: float,
                    max_w: int = 4096):
    """Google's own aerial photo, drawn into the contractor's tile frame.

    The outline comes from Google's height data, and Google's photo sits on the
    very same grid (same origin, same 10 cm pixels). Drawn over THAT photo the
    outline is on the roof by construction — no matching against another
    provider's photo, which failed on Brookside Oaks' blurry zoom-19 winter
    tile and is what left outlines a few metres off. It is also ~2x sharper
    than a zoom-19 tile.

    Same frame as the tile (same centre, span and aspect), so every stored
    fraction, the tap and the area maths are unchanged. Outside the ~70 m
    square Google returns, the contractor's tile shows through, dimmed, for
    context. Returns an RGB uint8 array, or None when there is no photo.
    """
    import cv2
    import numpy as np
    if layers.rgb is None:
        return None
    te, tn = tap_utm(layers, subject_point)
    tx, ty = float(subject_point["x"]), float(subject_point["y"])
    mpp = geo.metres_per_pixel(lat, zoom)
    frame_w_m = width_px * mpp
    out_w = int(min(max_w, max(width_px, round(frame_w_m / layers.px_m))))
    out_h = int(round(out_w * height_px / width_px))
    rgb = np.ascontiguousarray(layers.rgb[..., :3]).astype(np.uint8)
    # Where Google's photo is, at its own resolution (small: ~700x700), with
    # the seam feathered over ~2 m so its square has no hard edge.
    k = max(3, int(round(2.0 / layers.px_m)) | 1)
    cover = cv2.GaussianBlur(cv2.erode(np.ones(rgb.shape[:2], np.float32), np.ones((k, k), np.uint8),
                                       borderType=cv2.BORDER_CONSTANT, borderValue=0), (k, k), 0)
    base = None
    if tile_rgb is not None:
        base = cv2.resize(np.asarray(tile_rgb)[..., :3].astype(np.uint8), (out_w, out_h),
                          interpolation=cv2.INTER_AREA)
    out = np.empty((out_h, out_w, 3), np.uint8)
    # Built in strips of rows. All at once, the float working arrays for a
    # 4096x2732 frame peaked at ~860 MB and Render's 512 MB instance killed
    # the measurement (2026-10-01). A strip of 128 rows needs a few MB.
    # Offsets from the raster's corner are taken in float64 FIRST: UTM northings
    # are ~4.4 million, where float32 steps in 0.25 m (2.5 photo pixels), which
    # made the photo blocky. The small differences are then safe in float32.
    e0 = float(te) - float(layers.origin_e)
    n0 = float(layers.origin_n) - float(tn)
    east = ((np.arange(out_w, dtype=np.float64) + 0.5) / out_w - tx) * width_px * mpp
    gcol = ((e0 + east) / layers.px_m - 0.5).astype(np.float32)
    STRIP = 128
    for y0 in range(0, out_h, STRIP):
        y1 = min(out_h, y0 + STRIP)
        north = (ty - (np.arange(y0, y1, dtype=np.float64) + 0.5) / out_h) * height_px * mpp
        grow = ((n0 - north) / layers.px_m - 0.5).astype(np.float32)
        gc = np.broadcast_to(gcol[None, :], (y1 - y0, out_w)).copy()
        gr = np.broadcast_to(grow[:, None], (y1 - y0, out_w)).copy()
        google = cv2.remap(rgb, gc, gr, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        inside = cv2.remap(cover, gc, gr, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)[..., None]
        if base is not None:
            ctx = base[y0:y1].astype(np.float32) * 0.55 + 40.0         # dimmed: context, not the subject
        else:
            ctx = np.full((y1 - y0, out_w, 3), 200.0, np.float32)
        out[y0:y1] = np.clip(inside * google + (1.0 - inside) * ctx, 0, 255).astype(np.uint8)
    return out
