"""Phase 0 / DEFECT-02 & 03 regression: shared roof edges must be de-duplicated by
geometry, not label — so ridge ≤ perimeter holds and totals can't triple. Fixtures
mirror the Richlands phantom pattern (unconfirmed 'ridge' over a confirmed 'hip'/
'valley' of the same length on the same facet pair).
"""
from app.services.geometry_service import edge_totals_by_type


def _edge(ft, etype, facet, shared=None, confirmed=True):
    return {"edge_type": etype, "slope_adjusted_ft": ft, "facet_id": facet,
            "shared_with_facet": shared, "user_confirmed": confirmed}


def test_phantom_ridge_over_confirmed_hip_counts_once_as_hip():
    # Confirmed hip 19.6 between A and B, plus a phantom unconfirmed ridge 19.6
    # on the same boundary (stored from the other facet). Must count ONCE, as hip.
    edges = [
        _edge(19.6, "hip", "A", shared="B", confirmed=True),
        _edge(19.6, "ridge", "B", shared="A", confirmed=False),
    ]
    t = edge_totals_by_type(edges)
    assert round(t["hip"], 1) == 19.6
    assert t["ridge"] == 0.0


def test_per_facet_duplicate_shared_edge_counts_once():
    # Same ridge stored from both facets (both confirmed) → counted once.
    edges = [
        _edge(59.5, "ridge", "A", shared="B", confirmed=True),
        _edge(59.5, "ridge", "B", shared="A", confirmed=True),
    ]
    assert round(edge_totals_by_type(edges)["ridge"], 1) == 59.5


def test_two_distinct_shared_edges_same_pair_both_survive():
    # A and B genuinely share two edges of different lengths — keep both.
    edges = [
        _edge(10.0, "valley", "A", shared="B"),
        _edge(25.0, "valley", "A", shared="B"),
    ]
    assert round(edge_totals_by_type(edges)["valley"], 1) == 35.0


def test_ridge_cannot_exceed_perimeter_after_dedup():
    # The Richlands shape in miniature: real ridge + hips + eaves/rakes, plus
    # phantom ridges duplicating the hips. Deduped ridge must stay ≤ perimeter.
    edges = [
        _edge(59.5, "ridge", "A", shared="B", confirmed=True),
        _edge(19.6, "hip", "A", shared="C", confirmed=True),
        _edge(14.3, "hip", "B", shared="C", confirmed=True),
        _edge(19.6, "ridge", "C", shared="A", confirmed=False),   # phantom of the hip
        _edge(14.3, "ridge", "C", shared="B", confirmed=False),   # phantom of the hip
        _edge(150.0, "eave", "A"),
        _edge(154.7, "rake", "A"),
    ]
    t = edge_totals_by_type(edges)
    perimeter = t["eave"] + t["rake"]
    assert t["ridge"] + t["hip"] <= perimeter
    assert round(t["ridge"], 1) == 59.5   # phantoms dropped


# ── Geometry-keyed dedup: two touching polygons, no `shared_with_facet` ───────
# The reported defect. Two facets traced against each other share a line, but
# nothing ever populated the back-reference, so the pair+length key never fired
# and the boundary was summed from both sides — inflating ridge cap and valley
# metal on the material order.

def _geo_edge(etype, facet, i, j, ft, shared=None, confirmed=True):
    return {"edge_type": etype, "slope_adjusted_ft": ft, "facet_id": facet,
            "vertex_index_start": i, "vertex_index_end": j,
            "shared_with_facet": shared, "user_confirmed": confirmed}


# Two squares meeting along x=0.5. A's right edge (v1→v2) is B's left edge
# (v0→v3) — the same physical roof line, traced from both sides.
_FACET_A = {"id": "A", "polygon": [[0.1, 0.1], [0.5, 0.1], [0.5, 0.6], [0.1, 0.6]]}
_FACET_B = {"id": "B", "polygon": [[0.5, 0.1], [0.9, 0.1], [0.9, 0.6], [0.5, 0.6]]}
_FACETS = [_FACET_A, _FACET_B]


def test_shared_edge_without_backreference_counts_once():
    edges = [
        _geo_edge("ridge", "A", 1, 2, 40.0),
        _geo_edge("ridge", "B", 3, 0, 40.0),   # same line, no shared_with_facet
    ]
    assert round(edge_totals_by_type(edges, _FACETS)["ridge"], 1) == 40.0
    # Without the polygons there is nothing to key on — documents the fallback.
    assert round(edge_totals_by_type(edges)["ridge"], 1) == 80.0


def test_shared_edge_with_backreference_on_one_side_only_counts_once():
    # The half-populated case: the old key put one side in the dedup group and
    # let the other fall through to the plain sum.
    edges = [
        _geo_edge("valley", "A", 1, 2, 40.0, shared="B"),
        _geo_edge("valley", "B", 3, 0, 40.0, shared=None),
    ]
    assert round(edge_totals_by_type(edges, _FACETS)["valley"], 1) == 40.0


def test_confirmed_label_wins_over_phantom_on_same_geometry():
    edges = [
        _geo_edge("hip", "A", 1, 2, 40.0, confirmed=True),
        _geo_edge("ridge", "B", 3, 0, 40.0, confirmed=False),
    ]
    t = edge_totals_by_type(edges, _FACETS)
    assert round(t["hip"], 1) == 40.0
    assert t["ridge"] == 0.0


def test_coincident_line_labeled_eave_resolves_to_interior_type():
    # Two facets can't share an eave — if both traced the same line, it's interior.
    edges = [
        _geo_edge("eave", "A", 1, 2, 40.0, confirmed=False),
        _geo_edge("hip", "B", 3, 0, 40.0, confirmed=False),
    ]
    t = edge_totals_by_type(edges, _FACETS)
    assert round(t["hip"], 1) == 40.0
    assert t["eave"] == 0.0


def test_hand_traced_jitter_still_collapses():
    # Nobody clicks the same pixel twice; a few px of drift is the normal case.
    jittered = {"id": "B", "polygon": [[0.502, 0.101], [0.9, 0.1], [0.9, 0.6], [0.498, 0.603]]}
    edges = [
        _geo_edge("ridge", "A", 1, 2, 40.0),
        _geo_edge("ridge", "B", 3, 0, 40.2),
    ]
    assert round(edge_totals_by_type(edges, [_FACET_A, jittered])["ridge"], 1) == 40.0


def test_distinct_outline_edges_are_not_fused():
    # A's own four sides are separate lines and must all survive.
    edges = [
        _geo_edge("eave", "A", 0, 1, 30.0),
        _geo_edge("rake", "A", 1, 2, 40.0),
        _geo_edge("eave", "A", 2, 3, 30.0),
        _geo_edge("rake", "A", 3, 0, 40.0),
    ]
    t = edge_totals_by_type(edges, _FACETS)
    assert round(t["eave"], 1) == 60.0
    assert round(t["rake"], 1) == 80.0


def test_short_nearby_edges_are_not_fused():
    # Two small dormer edges sitting close together are distinct roof lines even
    # though they fall inside the absolute tolerance.
    dormer = {"id": "D", "polygon": [[0.20, 0.20], [0.203, 0.20], [0.203, 0.205], [0.20, 0.205]]}
    edges = [
        _geo_edge("ridge", "D", 0, 1, 2.0),
        _geo_edge("ridge", "D", 2, 3, 2.0),
    ]
    assert round(edge_totals_by_type(edges, [dormer])["ridge"], 1) == 4.0


def test_unresolvable_geometry_falls_back_per_edge():
    # A malformed polygon must degrade one edge, not the whole roof.
    broken = {"id": "C", "polygon": []}
    edges = [
        _geo_edge("ridge", "A", 1, 2, 40.0),
        _geo_edge("ridge", "B", 3, 0, 40.0),
        _geo_edge("hip", "C", 0, 1, 12.0),
    ]
    t = edge_totals_by_type(edges, [_FACET_A, _FACET_B, broken])
    assert round(t["ridge"], 1) == 40.0
    assert round(t["hip"], 1) == 12.0
