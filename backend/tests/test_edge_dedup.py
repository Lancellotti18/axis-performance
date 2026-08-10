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
