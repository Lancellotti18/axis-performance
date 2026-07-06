"""
Edge-classifier accuracy suite — canonical residential roofs with EVERY edge
asserted. These encode contractor ground truth: if any assertion here fails,
material orders (ridge cap, hip cap, valley metal, drip edge) come out wrong.

Regression anchor: the pre-rewrite classifier labeled the ridge and all four
hips of a textbook hip roof as VALLEYS (angle-sum was tested at interior
junctions where 3 facets meet ≈ 360°), which then cascaded into eave→rake
mistakes. Never again.
"""
from __future__ import annotations

import math

import pytest

from app.services.geometry_service import auto_suggest_edge_types


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def classify(facets):
    """Run the classifier and index results as {(label, vi): suggestion}."""
    out = auto_suggest_edge_types(facets)
    return {(s["facet_label"], s["vertex_index_start"]): s for s in out}


def assert_edge(result, label, vi, expected_type, min_conf=0.0):
    s = result[(label, vi)]
    assert s["edge_type"] == expected_type, (
        f"facet {label} edge {vi}: expected {expected_type!r}, got {s['edge_type']!r} "
        f"(conf {s['confidence']}, reason: {s['reason']})"
    )
    assert s["confidence"] >= min_conf, (
        f"facet {label} edge {vi}: {expected_type} confidence {s['confidence']} < {min_conf}"
    )


def rotate_facets(facets, deg, cx=0.5, cy=0.5):
    """Rotate all polygons about (cx, cy) — classification must not change."""
    rad = math.radians(deg)
    c, s = math.cos(rad), math.sin(rad)
    out = []
    for f in facets:
        poly = [
            [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]
            for x, y in f["polygon"]
        ]
        out.append({**f, "polygon": poly})
    return out


def jitter_facets(facets, dx=0.004):
    """Deterministic per-vertex jitter under the sharing tolerance — simulates
    hand tracing where 'shared' vertices don't coincide exactly."""
    out = []
    for fi, f in enumerate(facets):
        poly = [
            [x + dx * (((fi + k) % 3) - 1), y - dx * (((fi + 2 * k) % 3) - 1)]
            for k, (x, y) in enumerate(f["polygon"])
        ]
        out.append({**f, "polygon": poly})
    return out


# ---------------------------------------------------------------------------
# Fixtures — canonical roofs (image fractions, y grows downward/south)
# ---------------------------------------------------------------------------

def gable_roof():
    """Simple gable: 2 rectangles meeting at a ridge. 1 ridge, 2 eaves, 4 rakes."""
    return [
        {"label": "N", "pitch_degrees": 26.6,
         "polygon": [[0.20, 0.30], [0.80, 0.30], [0.80, 0.50], [0.20, 0.50]]},   # eave at y=0.30
        {"label": "S", "pitch_degrees": 26.6,
         "polygon": [[0.20, 0.50], [0.80, 0.50], [0.80, 0.70], [0.20, 0.70]]},   # eave at y=0.70
    ]


def hip_roof():
    """Textbook hip roof: 2 trapezoids + 2 triangles. 1 ridge, 4 hips, 4 eaves.
    THE regression case — previously read as 5 valleys + 2 rakes."""
    return [
        {"label": "A", "pitch_degrees": 26.6,   # south trapezoid
         "polygon": [[0.30, 0.70], [0.70, 0.70], [0.60, 0.50], [0.40, 0.50]]},
        {"label": "B", "pitch_degrees": 26.6,   # north trapezoid
         "polygon": [[0.70, 0.30], [0.30, 0.30], [0.40, 0.50], [0.60, 0.50]]},
        {"label": "C", "pitch_degrees": 26.6,   # west triangle
         "polygon": [[0.30, 0.70], [0.40, 0.50], [0.30, 0.30]]},
        {"label": "D", "pitch_degrees": 26.6,   # east triangle
         "polygon": [[0.70, 0.70], [0.70, 0.30], [0.60, 0.50]]},
    ]


def l_roof_with_valleys():
    """L-shaped roof: main gable E-W + south wing gable. 2 ridges, 2 VALLEYS."""
    return [
        {"label": "A", "pitch_degrees": 26.6,   # main north facet
         "polygon": [[0.20, 0.25], [0.80, 0.25], [0.80, 0.40], [0.20, 0.40]]},
        {"label": "B", "pitch_degrees": 26.6,   # main south facet, notched by the wing
         "polygon": [[0.20, 0.40], [0.80, 0.40], [0.80, 0.55], [0.70, 0.55],
                     [0.60, 0.45], [0.50, 0.55], [0.20, 0.55]]},
        {"label": "C", "pitch_degrees": 26.6,   # wing west facet
         "polygon": [[0.60, 0.45], [0.60, 0.85], [0.50, 0.85], [0.50, 0.55]]},
        {"label": "D", "pitch_degrees": 26.6,   # wing east facet
         "polygon": [[0.60, 0.45], [0.70, 0.55], [0.70, 0.85], [0.60, 0.85]]},
    ]


def deep_narrow_gable():
    """Gable on a deep, narrow building: rakes 3× longer than ridge/eaves.
    Breaks any 'longest edge = eave' assumption — ridge must still be ridge."""
    return [
        {"label": "W", "pitch_degrees": 26.6,
         "polygon": [[0.40, 0.10], [0.50, 0.10], [0.50, 0.90], [0.40, 0.90]]},   # eave at x=0.40
        {"label": "E", "pitch_degrees": 26.6,
         "polygon": [[0.50, 0.10], [0.60, 0.10], [0.60, 0.90], [0.50, 0.90]]},   # eave at x=0.60
    ]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestGable:
    def test_all_edges(self):
        r = classify(gable_roof())
        # N: e0 = top eave, e1 = east rake, e2 = shared ridge, e3 = west rake
        assert_edge(r, "N", 0, "eave", 0.7)
        assert_edge(r, "N", 1, "rake", 0.7)
        assert_edge(r, "N", 2, "ridge", 0.8)
        assert_edge(r, "N", 3, "rake", 0.7)
        # S: e0 = shared ridge, e1 = east rake, e2 = bottom eave, e3 = west rake
        assert_edge(r, "S", 0, "ridge", 0.8)
        assert_edge(r, "S", 1, "rake", 0.7)
        assert_edge(r, "S", 2, "eave", 0.7)
        assert_edge(r, "S", 3, "rake", 0.7)


class TestHipRoof:
    """The regression case: ridge + 4 hips + 4 eaves, ZERO valleys/rakes."""

    def expected(self):
        return {
            ("A", 0): "eave", ("A", 1): "hip", ("A", 2): "ridge", ("A", 3): "hip",
            ("B", 0): "eave", ("B", 1): "hip", ("B", 2): "ridge", ("B", 3): "hip",
            ("C", 0): "hip", ("C", 1): "hip", ("C", 2): "eave",
            ("D", 0): "rake_or_eave", ("D", 1): "hip", ("D", 2): "hip",
        }

    def _check(self, facets):
        r = classify(facets)
        types = {k: v["edge_type"] for k, v in r.items()}
        # Not a single valley or rake anywhere on a pure hip roof.
        assert "valley" not in types.values(), f"phantom valley: {types}"
        assert "rake" not in types.values(), f"phantom rake: {types}"
        # The ridge (A e2 / B e2) must be a ridge.
        assert types[("A", 2)] == "ridge", f"A ridge misread as {types[('A', 2)]}"
        assert types[("B", 2)] == "ridge", f"B ridge misread as {types[('B', 2)]}"
        # All four hips.
        for key in [("A", 1), ("A", 3), ("B", 1), ("B", 3),
                    ("C", 0), ("C", 1), ("D", 1), ("D", 2)]:
            assert types[key] == "hip", f"{key} expected hip, got {types[key]}"
        # All four eaves (the triangles' single outline edge is their eave).
        for key in [("A", 0), ("B", 0), ("C", 2), ("D", 0)]:
            assert types[key] == "eave", f"{key} expected eave, got {types[key]}"

    def test_axis_aligned(self):
        self._check(hip_roof())

    def test_rotated_33_degrees(self):
        self._check(rotate_facets(hip_roof(), 33))

    def test_rotated_90_degrees(self):
        self._check(rotate_facets(hip_roof(), 90))

    def test_jittered_tracing(self):
        self._check(jitter_facets(hip_roof(), dx=0.004))


class TestValleys:
    def test_l_roof_valleys_detected(self):
        r = classify(l_roof_with_valleys())
        types = {k: v["edge_type"] for k, v in r.items()}
        # Main ridge + wing ridge.
        assert types[("A", 3)] == "ridge" or types[("A", 0)] == "ridge" or \
            "ridge" in (types[("A", 3)], types[("B", 0)]), f"main ridge missing: {types}"
        assert types[("B", 0)] == "ridge", f"B main ridge: {types[('B', 0)]}"
        assert types[("C", 0)] == "ridge", f"wing ridge: {types[('C', 0)]}"
        # The two valleys: B e4 (0.60,0.45)→(0.50,0.55) shared with C e3,
        # and B e3 (0.70,0.55)→(0.60,0.45) shared with D e0.
        assert types[("B", 4)] == "valley", f"B/C valley: {types[('B', 4)]}"
        assert types[("C", 3)] == "valley", f"C/B valley: {types[('C', 3)]}"
        assert types[("B", 3)] == "valley", f"B/D valley: {types[('B', 3)]}"
        assert types[("D", 0)] == "valley", f"D/B valley: {types[('D', 0)]}"
        # No phantom hips on a pure gable-L.
        assert "hip" not in types.values(), f"phantom hip: {types}"

    def test_l_roof_rotated(self):
        r = classify(rotate_facets(l_roof_with_valleys(), 47))
        types = {k: v["edge_type"] for k, v in r.items()}
        assert types[("B", 4)] == "valley" and types[("B", 3)] == "valley"
        assert types[("B", 0)] == "ridge" and types[("C", 0)] == "ridge"


class TestDeepNarrowGable:
    def test_ridge_not_hip(self):
        """Rakes are 3× longer than the ridge — the old 'parallel to longest
        edge' test called this ridge a hip."""
        r = classify(deep_narrow_gable())
        assert_edge(r, "W", 1, "ridge", 0.8)   # shared edge x=0.50
        assert_edge(r, "E", 3, "ridge", 0.8)
        assert_edge(r, "W", 3, "eave", 0.7)    # x=0.40 side
        assert_edge(r, "E", 1, "eave", 0.7)    # x=0.60 side
        assert_edge(r, "W", 0, "rake", 0.7)
        assert_edge(r, "W", 2, "rake", 0.7)


class TestPartialOverlap:
    def test_offset_ridge_still_shared(self):
        """Facet S's ridge traced slightly SHORT (endpoints inset along the
        line): endpoint matching fails, collinear overlap must still catch it."""
        facets = gable_roof()
        facets[1]["polygon"][0] = [0.24, 0.50]   # inset 0.04 along the ridge
        facets[1]["polygon"][1] = [0.76, 0.50]
        r = classify(facets)
        assert r[("N", 2)]["edge_type"] == "ridge"
        assert r[("N", 2)]["shared_with_facet_label"] == "S"
        assert r[("S", 0)]["edge_type"] == "ridge"

    def test_disjoint_facets_not_shared(self):
        """Two separate buildings — nothing should read as shared/interior."""
        facets = [
            {"label": "A", "pitch_degrees": 26.6,
             "polygon": [[0.10, 0.10], [0.30, 0.10], [0.30, 0.30], [0.10, 0.30]]},
            {"label": "B", "pitch_degrees": 26.6,
             "polygon": [[0.60, 0.60], [0.90, 0.60], [0.90, 0.80], [0.60, 0.80]]},
        ]
        r = classify(facets)
        assert all(s["shared_with_facet_label"] is None for s in r.values())


class TestHonesty:
    def test_lone_facet_confidence_capped(self):
        """A single traced rectangle: eave/rake calls rest on an assumption, so
        confidence must stay modest — the contractor confirms."""
        r = classify([{
            "label": "A", "pitch_degrees": 26.6,
            "polygon": [[0.30, 0.40], [0.70, 0.40], [0.70, 0.60], [0.30, 0.60]],
        }])
        assert all(s["confidence"] <= 0.6 for s in r.values()), \
            f"lone-facet overconfidence: {[(k, v['confidence']) for k, v in r.items()]}"

    def test_every_suggestion_has_reason(self):
        r = classify(hip_roof())
        assert all(s.get("reason") for s in r.values())
