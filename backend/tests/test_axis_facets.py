"""Engine roof -> Axis facet outlines -> the totals the report prints.

roof_from_dsm can measure a line exactly and still lose it on the way into
Axis: every Axis edge is a SIDE of a facet outline, typed by what lies across
it, and the report de-duplicates a shared line only when both facets' copies
coincide. On real roofs that path left Brookside Oaks' garage ridge
"unlabeled" and counted Wilmington's hips twice (103 ft against the engine's
84). These tests run synthetic roofs through the same functions the endpoint
and the report use, and compare with the known answers.
"""
import math

import pytest

from tests import _roof_synth as S
from app.services import geometry_service as geo
from app.services.auto_measure import build_payload
from app.services.roof_from_dsm import extract_roof
from app.services.solar_layers_service import LayerSet, latlng_to_utm

M_TO_FT = 3.28084
LAT, LNG = 40.0949358, -76.3227374
W, H, Z = 2048, 1366, 20
LINE_TOL = 0.08          # converter + tile pixels on top of the engine's 5%
STRAY_FT = 2.0           # a line that should not exist may read up to this


def _axis_totals(dsm, mask, px):
    e, n, zone = latlng_to_utm(LAT, LNG)
    rows, cols = dsm.shape
    ls = LayerSet(True, dsm=dsm, mask=mask, px_m=px, epsg=32600 + zone,
                  origin_e=e - cols * px / 2, origin_n=n + rows * px / 2)
    m = extract_roof(dsm, mask, px)
    assert m.available, m.reason
    facets, edges = build_payload(m, ls, {"x": 0.5, "y": 0.5, "lat": LAT, "lng": LNG},
                                  width_px=W, height_px=H, zoom=Z, lat=LAT)
    frows, fid = [], {}
    for i, f in enumerate(facets):
        frows.append({"id": f"f{i}", "polygon": f["polygon"], "pitch": f["pitch"]})
        fid[f["facet_label"]] = frows[-1]
    erows = []
    for e_ in edges:
        fac = fid[e_["facet_label"]]
        poly = fac["polygon"]
        pl = geo.edge_plan_length_ft(poly[e_["vertex_index_start"]], poly[e_["vertex_index_end"]],
                                     LAT, Z, W, H)
        erows.append({"facet_id": fac["id"], "vertex_index_start": e_["vertex_index_start"],
                      "vertex_index_end": e_["vertex_index_end"], "edge_type": e_["edge_type"],
                      "plan_length_ft": pl,
                      "slope_adjusted_ft": geo.slope_adjusted_edge_length_ft(pl, fac["pitch"], e_["edge_type"]),
                      "shared_with_facet": fid[e_["shared_with_facet_label"]]["id"]
                      if e_["shared_with_facet_label"] else None,
                      "user_confirmed": False})
    unlabeled = sum(r["slope_adjusted_ft"] for r in erows if r["edge_type"] == "unlabeled")
    return geo.edge_totals_by_type(erows, frows), unlabeled


@pytest.mark.parametrize("name", ["gable", "hip", "cross_gable"])
@pytest.mark.parametrize("angle,noisy", [(0, False), (17, True), (38, True)])
def test_every_line_reaches_the_report_once(name, angle, noisy):
    dsm, mask, px = getattr(S, name)()
    if angle:
        dsm, mask = S.rotate(dsm, mask, angle)
    if noisy:
        dsm = S.add_noise(dsm, mask)
    exp = getattr(S, name + "_expected")()
    totals, unlabeled = _axis_totals(dsm, mask, px)
    for kind in ("eave", "rake", "ridge", "hip", "valley"):
        want = exp.get(kind + "_m", 0.0) * M_TO_FT
        got = float(totals.get(kind, 0.0))
        if want:
            # Counted twice would be +100%; lost to "unlabeled" would be short.
            assert got == pytest.approx(want, rel=LINE_TOL), f"{kind}: {got:.1f} ft vs {want:.1f}"
        else:
            assert got <= STRAY_FT, f"{kind} should not exist, read {got:.1f} ft"
    assert unlabeled <= STRAY_FT, f"{unlabeled:.1f} ft left unlabeled"


def test_a_porch_step_reaches_the_report_as_wall_and_eave():
    dsm, mask, px = S.gable_with_porch()
    totals, unlabeled = _axis_totals(dsm, mask, px)
    assert totals["wall_intersection"] == pytest.approx(8.0 * M_TO_FT, rel=0.1)
    assert totals["hip"] <= STRAY_FT
    assert unlabeled <= STRAY_FT
