"""
Axis Performance — Flashing Intelligence Engine.

Derives every flashing requirement for a roof DETERMINISTICALLY from the
geometry the contractor has already confirmed (facets, classified edges,
penetrations). No AI, no hallucinated quantities — every number traces back
to a specific edge or penetration, so each finding is explainable and
reviewable.

Flashing rules (industry-standard defaults; thresholds are configurable):

  Roof-to-wall transitions (roof_edges.edge_type == "wall_intersection"):
    * SLOPED run (edge runs up the slope, ~perpendicular to the eave)
        → step flashing      (length = slope-adjusted run length)
        → counter flashing   (same run — caps the step flashing)
        → kickout flashing   (+1 piece at the downhill end of each run)
    * HORIZONTAL run (edge runs across the slope, ~parallel to the eave)
        → apron / headwall flashing (length = run length)
        → counter flashing          (same run)

  Valleys (edge_type == "valley"):
        → valley flashing metal (length = slope-adjusted valley length)

  Chimneys (penetration type == "chimney"):
        → chimney flashing kit: front apron + 2 step sides + back
        → cricket / saddle if width > CRICKET_WIDTH_IN
        → counter flashing around the full perimeter

  Skylights (penetration type == "skylight"):
        → skylight flashing kit (head + sill + 2 step sides)

Output is a list of FlashingRequirement plus a rolled-up FlashingSummary that
feeds the materials engine + APIR report.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal, Optional


# ─────────────────────────────────────────────────────────────────────────
# Tunable thresholds (could later come from a per-contractor settings table)
# ─────────────────────────────────────────────────────────────────────────

# Angle tolerance (degrees) for deciding a wall-intersection runs WITH the
# slope (step) vs ACROSS it (apron). If the run is within this of the facet's
# eave direction, it's horizontal (apron/headwall); otherwise sloped (step).
APRON_PARALLEL_TOL_DEG = 28.0

# Step-flashing pieces per linear foot of run. Standard 5" exposure with
# overlapping pieces ≈ one piece every ~5 inches → ~2.4/ft. Round per run.
STEP_PIECES_PER_FT = 2.4

# A chimney wider than this (measured along the slope, up-roof face) needs a
# cricket/saddle to divert water.
CRICKET_WIDTH_IN = 30.0


FlashingType = Literal[
    "step", "counter", "apron", "headwall", "kickout",
    "valley", "chimney", "skylight", "cricket",
]
Confidence = Literal["high", "medium", "estimated"]


# ─────────────────────────────────────────────────────────────────────────
# Inputs — plain structs the API layer assembles from DB rows
# ─────────────────────────────────────────────────────────────────────────

@dataclass
class WallEdge:
    """A roof_edges row already resolved to endpoints + length."""
    facet_label: str
    edge_index: int
    edge_type: str                 # "wall_intersection" | "valley" | …
    p0: tuple[float, float]        # endpoint A in image fractions
    p1: tuple[float, float]        # endpoint B in image fractions
    plan_length_ft: float
    slope_adjusted_ft: float
    # The facet's eave direction (unit vector in image-fraction space), used to
    # decide sloped vs horizontal. None if the facet has no eave classified.
    eave_dir: Optional[tuple[float, float]] = None


@dataclass
class PenetrationItem:
    pen_id: str
    type: str                      # "chimney" | "skylight" | …
    width_in: float
    height_in: float
    count: int = 1
    pitch: str = "6/12"


@dataclass
class FlashingInput:
    wall_edges: list[WallEdge] = field(default_factory=list)
    valley_edges: list[WallEdge] = field(default_factory=list)
    penetrations: list[PenetrationItem] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────
# Output
# ─────────────────────────────────────────────────────────────────────────

@dataclass
class FlashingRequirement:
    id: str
    type: FlashingType
    measure: Literal["linear", "count"]
    length_ft: float = 0.0
    quantity: int = 0
    pieces: Optional[int] = None       # step-flashing piece count
    source: str = ""                   # human-readable explanation
    confidence: Confidence = "high"
    needs_review: bool = False
    # Where to draw the highlight in the editor: an edge or a penetration.
    location: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "measure": self.measure,
            "length_ft": round(self.length_ft, 2),
            "quantity": self.quantity,
            "pieces": self.pieces,
            "source": self.source,
            "confidence": self.confidence,
            "needs_review": self.needs_review,
            "location": self.location,
        }


@dataclass
class FlashingSummary:
    requirements: list[FlashingRequirement]

    def totals(self) -> dict:
        out = {
            "step_flashing_ft": 0.0,
            "counter_flashing_ft": 0.0,
            "apron_flashing_ft": 0.0,
            "headwall_flashing_ft": 0.0,
            "valley_flashing_ft": 0.0,
            "wall_flashing_ft": 0.0,       # step + apron + headwall (roof-to-wall total)
            "kickout_qty": 0,
            "step_pieces": 0,
            "chimney_qty": 0,
            "skylight_qty": 0,
            "cricket_qty": 0,
        }
        for r in self.requirements:
            if r.type == "step":
                out["step_flashing_ft"] += r.length_ft
                out["wall_flashing_ft"] += r.length_ft
                out["step_pieces"] += r.pieces or 0
            elif r.type == "counter":
                out["counter_flashing_ft"] += r.length_ft
            elif r.type == "apron":
                out["apron_flashing_ft"] += r.length_ft
                out["wall_flashing_ft"] += r.length_ft
            elif r.type == "headwall":
                out["headwall_flashing_ft"] += r.length_ft
                out["wall_flashing_ft"] += r.length_ft
            elif r.type == "valley":
                out["valley_flashing_ft"] += r.length_ft
            elif r.type == "kickout":
                out["kickout_qty"] += r.quantity
            elif r.type == "chimney":
                out["chimney_qty"] += r.quantity
            elif r.type == "skylight":
                out["skylight_qty"] += r.quantity
            elif r.type == "cricket":
                out["cricket_qty"] += r.quantity
        # round linear values
        for k, v in out.items():
            if k.endswith("_ft"):
                out[k] = round(v, 2)
        return out

    def to_dict(self) -> dict:
        return {
            "requirements": [r.to_dict() for r in self.requirements],
            "totals": self.totals(),
            "count": len(self.requirements),
        }


# ─────────────────────────────────────────────────────────────────────────
# Engine
# ─────────────────────────────────────────────────────────────────────────

def build_input_from_rows(
    facets: list[dict], edges: list[dict], penetrations: list[dict],
) -> FlashingInput:
    """
    Map raw Supabase rows (roof_facets / roof_edges / roof_penetrations) into a
    FlashingInput: resolves each edge's endpoints from its facet polygon and
    derives each facet's eave direction. Shared by the /flashing endpoint and
    the report generator so they always agree.
    """
    def _vtx(poly, idx):
        try:
            p = poly[int(idx)]
        except (TypeError, ValueError, IndexError):
            return None
        try:
            if isinstance(p, dict):
                return (float(p["x"]), float(p["y"]))
            return (float(p[0]), float(p[1]))
        except (KeyError, TypeError, ValueError, IndexError):
            return None

    fmap: dict = {}
    for f in facets:
        fmap[f.get("id")] = {"label": f.get("facet_label") or "RF", "polygon": f.get("polygon") or []}

    eave_dir: dict = {}
    for e in edges:
        if e.get("edge_type") != "eave":
            continue
        fid = e.get("facet_id")
        poly = fmap.get(fid, {}).get("polygon") or []
        a = _vtx(poly, e.get("vertex_index_start"))
        b = _vtx(poly, e.get("vertex_index_end"))
        if a and b and fid not in eave_dir:
            dx, dy = b[0] - a[0], b[1] - a[1]
            n = math.hypot(dx, dy)
            if n > 0:
                eave_dir[fid] = (dx / n, dy / n)

    wall_edges: list[WallEdge] = []
    valley_edges: list[WallEdge] = []
    for e in edges:
        et = e.get("edge_type")
        if et not in ("wall_intersection", "valley"):
            continue
        fid = e.get("facet_id")
        fm = fmap.get(fid)
        if not fm:
            continue
        a = _vtx(fm["polygon"], e.get("vertex_index_start"))
        b = _vtx(fm["polygon"], e.get("vertex_index_end"))
        if not a or not b:
            continue
        we = WallEdge(
            facet_label=fm["label"],
            edge_index=int(e.get("vertex_index_start") or 0),
            edge_type=et, p0=a, p1=b,
            plan_length_ft=float(e.get("plan_length_ft") or 0.0),
            slope_adjusted_ft=float(e.get("slope_adjusted_ft") or 0.0),
            eave_dir=eave_dir.get(fid),
        )
        (valley_edges if et == "valley" else wall_edges).append(we)

    pen_items: list[PenetrationItem] = []
    for p in penetrations:
        if p.get("type") in ("chimney", "skylight"):
            pen_items.append(PenetrationItem(
                pen_id=str(p.get("id")),
                type=p["type"],
                width_in=float(p.get("width_in") or 0.0),
                height_in=float(p.get("height_in") or 0.0),
                count=int(p.get("count") or 1),
            ))

    return FlashingInput(wall_edges=wall_edges, valley_edges=valley_edges, penetrations=pen_items)


def compute_flashing(inp: FlashingInput) -> FlashingSummary:
    reqs: list[FlashingRequirement] = []
    counter = _Counter()

    for edge in inp.wall_edges:
        reqs.extend(_wall_intersection_flashing(edge, counter))

    for edge in inp.valley_edges:
        reqs.append(_valley_flashing(edge, counter))

    for pen in inp.penetrations:
        if pen.type == "chimney":
            reqs.extend(_chimney_flashing(pen, counter))
        elif pen.type == "skylight":
            reqs.extend(_skylight_flashing(pen, counter))

    return FlashingSummary(requirements=reqs)


# ─────────────────────────────────────────────────────────────────────────
# Rule: roof-to-wall transitions
# ─────────────────────────────────────────────────────────────────────────

def _wall_intersection_flashing(edge: WallEdge, counter: "_Counter") -> list[FlashingRequirement]:
    sloped = _is_sloped_run(edge)
    length = edge.slope_adjusted_ft if (sloped and edge.slope_adjusted_ft > 0) else edge.plan_length_ft
    length = max(length, 0.0)
    loc = {"kind": "edge", "facet_label": edge.facet_label, "edge_index": edge.edge_index,
           "p0": list(edge.p0), "p1": list(edge.p1)}
    needs_review = edge.eave_dir is None   # couldn't determine orientation → flag

    out: list[FlashingRequirement] = []
    if sloped:
        # Step flashing along the run
        pieces = max(1, math.ceil(length * STEP_PIECES_PER_FT))
        out.append(FlashingRequirement(
            id=counter.next("FL"), type="step", measure="linear",
            length_ft=length, pieces=pieces,
            source=f"{edge.facet_label}: sloped roof-to-wall run, {_ft(length)} → {pieces} step pieces",
            confidence="high" if not needs_review else "medium",
            needs_review=needs_review, location=loc,
        ))
        # Counter flashing caps the step flashing over the same run
        out.append(FlashingRequirement(
            id=counter.next("FL"), type="counter", measure="linear",
            length_ft=length,
            source=f"{edge.facet_label}: counter flashing over step run, {_ft(length)}",
            confidence="high" if not needs_review else "medium",
            needs_review=needs_review, location=loc,
        ))
        # One kickout at the downhill end of each sloped run
        out.append(FlashingRequirement(
            id=counter.next("FL"), type="kickout", measure="count", quantity=1,
            source=f"{edge.facet_label}: kickout at base of roof-to-wall run (diverts water from siding)",
            confidence="high" if not needs_review else "medium",
            needs_review=needs_review, location=loc,
        ))
    else:
        # Horizontal run → apron (low side) / headwall (high side). Without
        # 3D we can't always tell apron vs headwall, so label "apron" and let
        # the contractor flip it; both use the same continuous flashing length.
        out.append(FlashingRequirement(
            id=counter.next("FL"), type="apron", measure="linear",
            length_ft=length,
            source=f"{edge.facet_label}: horizontal roof-to-wall run, {_ft(length)} (apron/headwall)",
            confidence="medium", needs_review=True, location=loc,
        ))
        out.append(FlashingRequirement(
            id=counter.next("FL"), type="counter", measure="linear",
            length_ft=length,
            source=f"{edge.facet_label}: counter flashing over apron, {_ft(length)}",
            confidence="medium", needs_review=True, location=loc,
        ))
    return out


def _valley_flashing(edge: WallEdge, counter: "_Counter") -> FlashingRequirement:
    length = edge.slope_adjusted_ft if edge.slope_adjusted_ft > 0 else edge.plan_length_ft
    return FlashingRequirement(
        id=counter.next("FL"), type="valley", measure="linear",
        length_ft=max(length, 0.0),
        source=f"{edge.facet_label}: valley flashing metal, {_ft(length)}",
        confidence="high",
        location={"kind": "edge", "facet_label": edge.facet_label, "edge_index": edge.edge_index,
                  "p0": list(edge.p0), "p1": list(edge.p1)},
    )


# ─────────────────────────────────────────────────────────────────────────
# Rule: penetrations
# ─────────────────────────────────────────────────────────────────────────

def _chimney_flashing(pen: PenetrationItem, counter: "_Counter") -> list[FlashingRequirement]:
    w_ft = max(pen.width_in, 12.0) / 12.0
    h_ft = max(pen.height_in, 12.0) / 12.0
    perimeter = 2 * (w_ft + h_ft)
    loc = {"kind": "penetration", "pen_id": pen.pen_id}
    out = [
        FlashingRequirement(
            id=counter.next("FL"), type="chimney", measure="count", quantity=pen.count,
            length_ft=perimeter,
            source=f"Chimney flashing kit (apron + step sides + back), ~{_ft(perimeter)} perimeter",
            confidence="medium", needs_review=True, location=loc,
        ),
        FlashingRequirement(
            id=counter.next("FL"), type="counter", measure="linear",
            length_ft=perimeter,
            source=f"Counter flashing around chimney perimeter, ~{_ft(perimeter)}",
            confidence="medium", needs_review=True, location=loc,
        ),
    ]
    if pen.width_in > CRICKET_WIDTH_IN:
        out.append(FlashingRequirement(
            id=counter.next("FL"), type="cricket", measure="count", quantity=pen.count,
            source=f"Cricket/saddle behind {int(pen.width_in)}\"-wide chimney (code-required > {int(CRICKET_WIDTH_IN)}\")",
            confidence="medium", needs_review=True, location=loc,
        ))
    return out


def _skylight_flashing(pen: PenetrationItem, counter: "_Counter") -> list[FlashingRequirement]:
    w_ft = max(pen.width_in, 12.0) / 12.0
    h_ft = max(pen.height_in, 12.0) / 12.0
    perimeter = 2 * (w_ft + h_ft)
    return [FlashingRequirement(
        id=counter.next("FL"), type="skylight", measure="count", quantity=pen.count,
        length_ft=perimeter,
        source=f"Skylight flashing kit (head + sill + step sides), ~{_ft(perimeter)} perimeter",
        confidence="medium", needs_review=True,
        location={"kind": "penetration", "pen_id": pen.pen_id},
    )]


# ─────────────────────────────────────────────────────────────────────────
# Geometry helpers
# ─────────────────────────────────────────────────────────────────────────

def _is_sloped_run(edge: WallEdge) -> bool:
    """
    True if the wall-intersection runs up the slope (→ step flashing). We
    compare the edge direction to the facet's eave direction: a run nearly
    PARALLEL to the eave is horizontal (apron); otherwise it's sloped (step).

    If we don't know the eave direction, default to sloped — step flashing is
    by far the most common roof-to-wall condition, and the requirement is
    flagged needs_review so the contractor can flip it.
    """
    if edge.eave_dir is None:
        return True
    ex = edge.p1[0] - edge.p0[0]
    ey = edge.p1[1] - edge.p0[1]
    elen = math.hypot(ex, ey)
    if elen == 0:
        return True
    ex, ey = ex / elen, ey / elen
    dot = abs(ex * edge.eave_dir[0] + ey * edge.eave_dir[1])
    dot = max(-1.0, min(1.0, dot))
    angle = math.degrees(math.acos(dot))   # 0 = parallel to eave, 90 = perpendicular
    return angle > APRON_PARALLEL_TOL_DEG


class _Counter:
    def __init__(self) -> None:
        self._n = 0

    def next(self, prefix: str) -> str:
        self._n += 1
        return f"{prefix}-{self._n}"


def _ft(decimal_feet: float) -> str:
    feet = int(decimal_feet)
    inches = round((decimal_feet - feet) * 12)
    if inches == 12:
        return f"{feet + 1}' 0\""
    return f"{feet}' {inches}\""
