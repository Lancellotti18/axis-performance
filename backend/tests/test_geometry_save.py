"""Saving a roof must never leave it without its line labels.

Saving facets deletes the run's edges with them (cascade). The editor used to
save facets and edges as two requests, and the facet save called Google Solar
AFTER its delete — so a closed tab or a slow Solar call left a measured roof
with every edge gone (seen 2026-10-03: 5 facets, 0 edges). These tests pin the
order: slow work first, then delete → insert facets → insert edges, in one
request."""
import asyncio

import pytest

from app.api.v1 import roofing_v2 as rv

USER = {"id": "u1", "email": ""}
SQUARE = [[0.40, 0.40], [0.60, 0.40], [0.60, 0.60], [0.40, 0.60]]


class _Q:
    def __init__(self, db, table): self.db, self.table, self.op, self.payload = db, table, "select", None
    def select(self, *a, **k): return self
    def eq(self, *a, **k): return self
    def in_(self, *a, **k): return self
    def single(self): return self
    def delete(self): self.op = "delete"; return self
    def insert(self, rows): self.op, self.payload = "insert", rows; return self
    def update(self, row): self.op, self.payload = "update", row; return self
    def execute(self):
        self.db.log.append((self.op, self.table))
        if self.op == "insert":
            data = [{**r, "id": f"{self.table}-{i}"} for i, r in enumerate(self.payload)]
            self.db.rows[self.table] = data
            return type("R", (), {"data": data})()
        if self.op == "select" and self.table == "roof_measurement_runs":
            return type("R", (), {"data": {"id": "r1", "satellite_lat": 34.2, "satellite_lng": -77.9,
                                           "satellite_zoom": 20, "subject_point": None}})()
        return type("R", (), {"data": self.db.rows.get(self.table, [])})()


class _DB:
    def __init__(self): self.log, self.rows = [], {}
    def table(self, name): return _Q(self, name)


@pytest.fixture
def db(monkeypatch):
    d = _DB()
    monkeypatch.setattr(rv, "get_supabase", lambda: d)
    monkeypatch.setattr(rv, "require_owned_run", lambda db, rid, user: {"id": rid})

    async def solar(run, polys, zoom):
        d.log.append(("solar", "google"))
        return [None] * len(polys)
    async def tile(db_, run_id, url):
        d.log.append(("tile", "storage"))
        return url
    monkeypatch.setattr(rv, "_solar_pitch_for_polygons", solar)
    monkeypatch.setattr(rv, "_cache_tile", tile)
    return d


def _req(**extra):
    return dict(image_width_px=2048, image_height_px=1366, zoom=20, lat=34.2, lng=-77.9,
                satellite_image_url="https://tile/x.jpg",
                facets=[rv.FacetIn(facet_label="A", polygon=SQUARE, pitch="6/12")], **extra)


def _edges():
    return [rv.EdgeIn(facet_label="A", vertex_index_start=i, vertex_index_end=(i + 1) % 4,
                      edge_type="eave" if i % 2 == 0 else "rake") for i in range(4)]


def test_facet_save_calls_google_before_deleting_anything(db):
    asyncio.run(rv.put_facets("r1", rv.PutFacetsRequest(**_req()), USER))
    ops = [op for op, _ in db.log]
    first_delete = ops.index("delete")
    assert ops.index("solar") < first_delete
    assert ops.index("tile") < first_delete
    # nothing but the database between the delete and the insert
    assert ops[first_delete + 1] == "insert"


def test_geometry_saves_facets_and_edges_in_one_request(db):
    out = asyncio.run(rv.put_geometry("r1", rv.PutGeometryRequest(**_req(edges=_edges())), USER))
    assert out["count"] == 1 and out["edge_count"] == 4
    assert [e["edge_type"] for e in db.rows["roof_edges"]] == ["eave", "rake", "eave", "rake"]
    assert all(e["facet_id"] == "roof_facets-0" for e in db.rows["roof_edges"])
    writes = [(op, t) for op, t in db.log if op in ("delete", "insert", "solar", "tile")]
    assert writes == [("solar", "google"), ("tile", "storage"),
                      ("delete", "roof_facets"), ("insert", "roof_facets"), ("insert", "roof_edges")]


def test_geometry_drops_edges_for_unknown_facets_and_bad_vertices(db):
    edges = _edges() + [
        rv.EdgeIn(facet_label="Z", vertex_index_start=0, vertex_index_end=1, edge_type="ridge"),
        rv.EdgeIn(facet_label="A", vertex_index_start=0, vertex_index_end=9, edge_type="ridge"),
    ]
    out = asyncio.run(rv.put_geometry("r1", rv.PutGeometryRequest(**_req(edges=edges)), USER))
    assert out["edge_count"] == 4


def test_geometry_with_no_edges_still_saves_facets(db):
    out = asyncio.run(rv.put_geometry("r1", rv.PutGeometryRequest(**_req()), USER))
    assert out["count"] == 1 and out["edge_count"] == 0
    assert ("insert", "roof_edges") not in db.log
