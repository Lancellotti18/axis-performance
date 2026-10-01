"""The auto-measure endpoint: who gets it, when it refuses, and what it stores.

Google and the database are faked; the geometry is real (a synthetic gable)."""
import asyncio
import math

import numpy as np
import pytest

from app.api.v1 import roofing_v2 as rv
from app.core.config import settings
from app.services import solar_layers_service as SL, solar_service, address_match
from tests import _roof_synth as S

RYAN = {"id": "f9dafe47-810a-4c72-81c6-dbe2d9baf64b", "email": ""}
OTHER = {"id": "00000000-0000-0000-0000-000000000000", "email": ""}
LAT, LNG = 34.2257, -77.9447
REQ = rv.AutoMeasureRequest(image_width_px=2048, image_height_px=1366, zoom=20, lat=LAT, lng=LNG)


def test_only_listed_accounts_get_it(monkeypatch):
    assert rv._auto_measure_allowed(RYAN)
    assert not rv._auto_measure_allowed(OTHER)
    monkeypatch.setattr(settings, "AUTO_MEASURE_USER_IDS", "*")
    assert rv._auto_measure_allowed(OTHER)                 # "*" switches it on for everyone


class _Q:
    def __init__(self, data): self.data = data
    def __getattr__(self, _): return lambda *a, **k: self
    def execute(self): return self


class _DB:
    def __init__(self, stored): self.stored = stored
    def table(self, name):
        if name == "projects":
            return _Q({"name": "1422 Oak St", "city": "Wilmington", "state": "NC"})
        return _Q(self.stored.get(name, []))


def _layers_for(dsm, mask, px):
    """A LayerSet for synthetic arrays, placed so the tap is the roof's centre."""
    e, n, _ = SL.latlng_to_utm(LAT, LNG)
    h, w = dsm.shape
    return SL.LayerSet(True, None, dsm=dsm, mask=mask, rgb=None, px_m=px,
                       seed_rc=(h // 2, w // 2), imagery_date="2024-05-02", imagery_quality="HIGH",
                       epsg=32600 + SL.utm_zone(LNG),
                       origin_e=e - (w // 2 + 0.5) * px, origin_n=n + (h // 2 + 0.5) * px)


@pytest.fixture
def wired(monkeypatch):
    stored = {}
    run = {"id": "r1", "project_id": "p1", "subject_point": {"x": 0.5, "y": 0.5, "lat": LAT, "lng": LNG}}
    monkeypatch.setattr(rv, "get_supabase", lambda: _DB(stored))
    monkeypatch.setattr(rv, "require_owned_run", lambda db, rid, user: run)
    async def no_addr(*a, **k): return (None, None)
    monkeypatch.setattr(address_match, "reverse_lookup", no_addr)
    async def bi(lat, lng): return {"available": True, "center": {"lat": LAT, "lng": LNG}}
    monkeypatch.setattr(solar_service, "get_building_insights", bi)
    saved = {}
    async def put_f(run_id, req, user): saved["facets"] = req; return {}
    async def put_e(run_id, req, user): saved["edges"] = req; return {}
    monkeypatch.setattr(rv, "put_facets", put_f)
    monkeypatch.setattr(rv, "put_edges", put_e)
    monkeypatch.setattr(rv, "_aggregate_run", lambda rid: {"squares": 1.0})
    monkeypatch.setattr(settings, "GOOGLE_SOLAR_API_KEY", "test-key")
    return {"run": run, "saved": saved}


def _call(user=RYAN):
    return asyncio.run(rv.auto_measure("r1", REQ, user))


def test_an_account_not_on_the_list_is_refused(wired):
    with pytest.raises(rv.HTTPException) as e:
        _call(OTHER)
    assert e.value.status_code == 403


def test_no_tap_means_trace_by_hand(wired):
    wired["run"]["subject_point"] = {"x": 0.5, "y": 0.5}      # no lat/lng recorded
    out = _call()
    assert out["available"] is False and "Tap the house" in out["reason"]


def test_no_google_coverage_means_trace_by_hand(wired, monkeypatch):
    async def none(*a, **k): return SL.LayerSet(False, "no Google 3D coverage at this address")
    monkeypatch.setattr(SL, "fetch_layers", none)
    out = _call()
    assert out["available"] is False and "coverage" in out["reason"]
    assert "facets" not in wired["saved"]                      # nothing stored


def test_googles_two_views_disagreeing_about_the_building_is_refused(wired, monkeypatch):
    dsm, mask, px = S.gable()
    async def layers(*a, **k): return _layers_for(dsm, mask, px)
    monkeypatch.setattr(SL, "fetch_layers", layers)
    async def far(lat, lng):                                  # ~60 m away
        return {"available": True, "center": {"lat": LAT + 60 / 111320.0, "lng": LNG}}
    monkeypatch.setattr(solar_service, "get_building_insights", far)
    out = _call()
    assert out["available"] is False and "disagree" in out["reason"]
    assert "facets" not in wired["saved"]


def test_a_gable_is_measured_and_stored_like_a_trace(wired, monkeypatch):
    dsm, mask, px = S.gable()
    async def layers(*a, **k): return _layers_for(dsm, mask, px)
    monkeypatch.setattr(SL, "fetch_layers", layers)
    out = _call()
    assert out["available"] is True and out["imagery_date"] == "2024-05-02"
    fr = wired["saved"]["facets"]
    assert len(fr.facets) == 2
    assert all(f.pitch == "6.0/12" and f.pitch_source == "solar_3d" for f in fr.facets)
    kinds = {e.edge_type for e in wired["saved"]["edges"].edges}
    assert {"eave", "rake", "ridge"} <= kinds and "hip" not in kinds and "valley" not in kinds
    # The outline sits around the tap (the image centre here), in image fractions.
    xs = [p[0] for f in fr.facets for p in f.polygon]
    assert min(xs) < 0.5 < max(xs)
    # An east-west ridge: one slope faces north, the other south. The longest
    # edge (what Direction used to show) runs east-west for BOTH of them.
    assert sorted(round(f.azimuth_deg) % 360 for f in fr.facets) == [0, 180]


# ── The AI labeller on a measured roof ────────────────────────────────────

def _suggest(monkeypatch, facet_rows, unlabeled):
    monkeypatch.setattr(rv, "get_supabase", lambda: _DB({"roof_facets": facet_rows, "roof_measurement_runs": {}}))
    monkeypatch.setattr(rv, "require_owned_run", lambda db, rid, user: {"id": rid})
    sq = [[0.4, 0.4], [0.5, 0.4], [0.5, 0.5], [0.4, 0.5]]
    req = rv.EdgeLabelSuggestRequest(
        facets=[{"label": "A", "polygon": sq}, {"label": "B", "polygon": [[x + 0.1, y] for x, y in sq]}],
        unlabeled_edges=unlabeled)
    return asyncio.run(rv.suggest_edge_labels("r1", req, RYAN))


def test_lines_left_unlabeled_on_a_measured_roof_are_not_guessed(monkeypatch):
    """Brookside Oaks: the labeller turned 55 ft of untyped lines into hips on
    a roof with none. A measured roof's untyped line had no crease in the
    heights; guessing from the outline contradicts the measurement."""
    rows = [{"facet_label": "A", "pitch_source": "solar_3d"}, {"facet_label": "B", "pitch_source": "solar_3d"}]
    res = _suggest(monkeypatch, rows, [{"facet_label": "A", "vertex_index_start": 1, "vertex_index_end": 2},
                                       {"facet_label": "B", "vertex_index_start": 3, "vertex_index_end": 0}])
    assert res["suggestions"] == [] and res["skipped_measured"] == 2
    assert "not guessed" in res["message"]


def test_a_hand_traced_roof_still_gets_suggestions(monkeypatch):
    rows = [{"facet_label": "A", "pitch_source": "manual"}, {"facet_label": "B", "pitch_source": "manual"}]
    res = _suggest(monkeypatch, rows, [{"facet_label": "A", "vertex_index_start": 1, "vertex_index_end": 2}])
    assert res["skipped_measured"] == 0
    assert len(res["suggestions"]) == 1


def test_lining_up_onto_a_different_building_falls_back_to_tracing(wired, monkeypatch):
    """If matching the photo moves the tap onto another building, two sources
    disagree about which house it is. On a street of look-alike houses that is
    how the neighbour's roof gets measured, so the answer is to trace by hand."""
    import cv2, httpx
    from app.services import imagery_align
    dsm, mask, px = S.gable()
    async def layers(*a, **k): return _layers_for(dsm, mask, px)
    monkeypatch.setattr(SL, "fetch_layers", layers)
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://proj.supabase.co")
    wired["run"]["satellite_image_url"] = "https://proj.supabase.co/storage/tile.png"
    png = cv2.imencode(".png", np.zeros((64, 64, 3), np.uint8))[1].tobytes()

    class _Resp:
        status_code, content = 200, png
    class _Client:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, *a, **k): return _Resp()
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    # A confident match 30 m away: the corrected tap leaves this roof entirely.
    monkeypatch.setattr(imagery_align, "align_offset",
                        lambda *a, **k: {"east_m": 30.0, "north_m": 0.0, "score": 0.6, "lead": 0.2})
    out = _call()
    assert out["available"] is False and "disagree about which house" in out["reason"]
    assert "facets" not in wired["saved"]


def test_a_reshaped_auto_facet_gets_ai_help_again(monkeypatch):
    """Ryan's fallback: if auto-measure is off, the contractor fixes the outline
    by hand and the AI labeller helps with those lines (still confirmed by them)."""
    rows = [{"facet_label": "A", "pitch_source": "solar_3d_edited"}, {"facet_label": "B", "pitch_source": "solar_3d"}]
    res = _suggest(monkeypatch, rows, [{"facet_label": "A", "vertex_index_start": 1, "vertex_index_end": 2},
                                       {"facet_label": "B", "vertex_index_start": 3, "vertex_index_end": 0}])
    assert res["skipped_measured"] == 1
    assert [s["facet_label"] for s in res["suggestions"]] == ["A"]
