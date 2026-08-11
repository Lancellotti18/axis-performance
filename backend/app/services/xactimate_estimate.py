"""Adjuster Mode — map the confirmed roof geometry to an Xactimate-style quantity
survey (line code + description + unit + quantity), plus an RCV/ACV claim summary.

Why geometry, not the material takeoff: an adjuster works in SQUARES and LINEAR
FEET, and Xactimate applies its own waste and regional unit pricing. So every line
here is derived DIRECTLY from RoofTotals (the same confirmed numbers the report
uses) — never from bundle/roll counts. That keeps the non-negotiable contract:
every quantity traces to the geometry, and no two places compute it differently.

Pricing honesty: unit PRICES belong to the adjuster's Xactimate price list (which
includes labor and varies by region and release). This module produces the
quantities for free; if the caller supplies a price map it will compute RCV, and
if the caller supplies a depreciation % and deductible it will compute ACV and the
net claim. Nothing is fabricated — no price, depreciation, or deductible is ever
invented, and a missing input yields a null field, not a guess.

Line CODES follow the common RFG (roofing) category. Codes and descriptions vary
between Xactimate releases, so the adjuster verifies against their active price
list — we surface the code + a plain description so the mapping is auditable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from app.services.materials_engine import RoofTotals, PenetrationSummary


@dataclass
class AdjusterLine:
    code: str            # Xactimate-style line code, e.g. "RFG 240"
    description: str     # plain-language description
    unit: str            # "SQ" | "LF" | "SF" | "EA"
    quantity: float      # in the line's unit, from geometry
    category: str        # internal grouping
    trace: str           # how the quantity was derived
    unit_price: Optional[float] = None   # from caller's price map, else None
    rcv: Optional[float] = None          # quantity × unit_price, else None

    def to_dict(self) -> dict:
        return {
            "code": self.code, "description": self.description, "unit": self.unit,
            "quantity": round(self.quantity, 2), "category": self.category,
            "trace": self.trace,
            "unit_price": None if self.unit_price is None else round(self.unit_price, 2),
            "rcv": None if self.rcv is None else round(self.rcv, 2),
        }


# Waste is expressed on the shingle field line the way adjusters read it: the SQ
# quantity carries the waste %, everything else is measured net.
def _waste_mult(waste_pct: float) -> float:
    return 1.0 + max(0.0, float(waste_pct)) / 100.0


def build_adjuster_lines(
    totals: RoofTotals,
    penetrations: Optional[PenetrationSummary] = None,
    *,
    waste_pct: float = 15.0,
    include_tearoff: bool = True,
    underlayment: str = "synthetic",   # "synthetic" | "felt15" | "felt30"
) -> list[AdjusterLine]:
    """Build the Xactimate quantity survey from confirmed geometry. Quantities only
    (no pricing) — call apply_pricing() to attach unit prices."""
    pens = penetrations or PenetrationSummary()
    lines: list[AdjusterLine] = []
    sq = totals.squares
    perim = totals.perimeter_ft
    ridge_hip = totals.ridge_total_ft

    if sq <= 0:
        return lines

    # Tear-off (remove existing roofing). Adjusters price removal separately.
    if include_tearoff:
        lines.append(AdjusterLine(
            "RFG 240<", "Remove Laminated - comp. shingle roofing", "SQ",
            sq, "tearoff", f"{sq:.2f} squares (net, no waste on removal)"))

    # Field shingles — the one line that carries waste.
    field_sq = sq * _waste_mult(waste_pct)
    lines.append(AdjusterLine(
        "RFG 240", "Laminated - comp. shingle roofing - incl. felt", "SQ",
        field_sq, "field",
        f"{sq:.2f} sq × {_waste_mult(waste_pct):.2f} ({waste_pct:g}% waste) = {field_sq:.2f}"))

    # Underlayment (when priced separately from the field line).
    under_code, under_desc = {
        "synthetic": ("RFG SYNTH", "Synthetic underlayment"),
        "felt15": ("RFG FELT15", "Roofing felt - 15 lb."),
        "felt30": ("RFG FELT30", "Roofing felt - 30 lb."),
    }.get(underlayment, ("RFG SYNTH", "Synthetic underlayment"))
    lines.append(AdjusterLine(under_code, under_desc, "SQ", sq, "underlayment",
                              f"{sq:.2f} squares (net)"))

    # Starter course — runs the eaves (adjusters commonly include rakes too; we use
    # the full perimeter to match the drip-edge run and note it).
    lines.append(AdjusterLine(
        "RFG STARTER", "Asphalt starter - universal starter course", "LF",
        perim, "starter",
        f"perimeter {perim:.1f} lf (eaves {totals.eaves_ft:.1f} + rakes {totals.rakes_ft:.1f})"))

    # Ridge cap — ridges + hips (both are capped).
    if ridge_hip > 0:
        lines.append(AdjusterLine(
            "RFG RIDGC", "Ridge cap - composition shingles", "LF",
            ridge_hip, "ridge_cap",
            f"ridges {totals.ridges_ft:.1f} + hips {totals.hips_ft:.1f} = {ridge_hip:.1f} lf"))

    # Ridge vent — ridges only (hips are never vented).
    if totals.ridges_ft > 0:
        lines.append(AdjusterLine(
            "RFG RVENT", "Ridge vent - shingle-over style", "LF",
            totals.ridges_ft, "ridge_vent", f"{totals.ridges_ft:.1f} ridge lf (hips excluded)"))

    # Drip edge — full perimeter.
    lines.append(AdjusterLine(
        "RFG DRIP", "Drip edge", "LF", perim, "drip_edge",
        f"perimeter {perim:.1f} lf (eaves + rakes)"))

    # Valley metal — valleys.
    if totals.valleys_ft > 0:
        lines.append(AdjusterLine(
            "RFG VALLYM", "Valley metal", "LF", totals.valleys_ft, "valley_metal",
            f"{totals.valleys_ft:.1f} valley lf"))

    # Step flashing — wall intersections.
    if totals.wall_intersection_ft > 0:
        lines.append(AdjusterLine(
            "RFG STEP", "Step flashing", "LF", totals.wall_intersection_ft, "step_flashing",
            f"{totals.wall_intersection_ft:.1f} wall-intersection lf"))

    # Pipe-jack flashing — one per plumbing vent.
    if pens.vent_boots_required > 0:
        lines.append(AdjusterLine(
            "RFG FLPIPE", "Flashing - pipe jack", "EA",
            float(pens.vent_boots_required), "pipe_flashing",
            f"{pens.vent_boots_required} plumbing vent(s)"))

    return lines


def apply_pricing(lines: list[AdjusterLine], price_map: dict[str, float]) -> list[AdjusterLine]:
    """Attach unit_price + rcv from a caller-supplied {code: unit_price} map. Codes
    absent from the map keep unit_price/rcv = None (adjuster fills their own)."""
    for ln in lines:
        price = price_map.get(ln.code)
        if price is None:
            continue
        ln.unit_price = float(price)
        ln.rcv = round(ln.quantity * float(price), 2)
    return lines


@dataclass
class ClaimSummary:
    rcv: Optional[float]                       # Σ line RCV, or None if unpriced
    depreciation_pct: Optional[float]
    depreciation_amount: Optional[float]
    acv: Optional[float]                       # RCV − depreciation
    deductible: Optional[float]
    net_claim: Optional[float]                 # RCV − deductible (recoverable dep. paid on completion)
    recoverable_depreciation: Optional[float]  # = depreciation_amount, when recoverable
    priced_line_count: int = 0
    unpriced_line_count: int = 0
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        def r(x): return None if x is None else round(x, 2)
        return {
            "rcv": r(self.rcv), "depreciation_pct": self.depreciation_pct,
            "depreciation_amount": r(self.depreciation_amount), "acv": r(self.acv),
            "deductible": r(self.deductible), "net_claim": r(self.net_claim),
            "recoverable_depreciation": r(self.recoverable_depreciation),
            "priced_line_count": self.priced_line_count,
            "unpriced_line_count": self.unpriced_line_count,
            "notes": list(self.notes),
        }


def summarize_claim(
    lines: list[AdjusterLine],
    *,
    depreciation_pct: Optional[float] = None,
    deductible: Optional[float] = None,
    recoverable: bool = True,
) -> ClaimSummary:
    """Roll priced lines into an RCV/ACV claim. Every money figure is derived only
    from supplied inputs; missing inputs stay null rather than defaulting."""
    priced = [ln for ln in lines if ln.rcv is not None]
    unpriced = [ln for ln in lines if ln.rcv is None]
    notes: list[str] = []

    rcv = round(sum(ln.rcv for ln in priced), 2) if priced else None
    if unpriced:
        notes.append(
            f"{len(unpriced)} line(s) have no unit price — RCV covers only priced lines. "
            "Apply your Xactimate price list for a complete estimate.")

    dep_amt = acv = None
    if rcv is not None and depreciation_pct is not None:
        dep_amt = round(rcv * max(0.0, min(100.0, float(depreciation_pct))) / 100.0, 2)
        acv = round(rcv - dep_amt, 2)

    net_claim = rec_dep = None
    if rcv is not None and deductible is not None:
        # Insurer pays RCV minus the deductible (recoverable depreciation is released
        # on completion of the work). If depreciation is non-recoverable, the initial
        # and net payment is ACV − deductible instead.
        if recoverable:
            net_claim = round(rcv - float(deductible), 2)
            rec_dep = dep_amt
        elif acv is not None:
            net_claim = round(acv - float(deductible), 2)
            rec_dep = 0.0
        if net_claim is not None and net_claim < 0:
            net_claim = 0.0
            notes.append("Deductible exceeds the claim — net payable is $0.")

    return ClaimSummary(
        rcv=rcv, depreciation_pct=depreciation_pct, depreciation_amount=dep_amt,
        acv=acv, deductible=deductible, net_claim=net_claim,
        recoverable_depreciation=rec_dep,
        priced_line_count=len(priced), unpriced_line_count=len(unpriced), notes=notes,
    )
