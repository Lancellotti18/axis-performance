"""
Axis Performance — Materials engine.

Computes the contractor's material ordering list from confirmed measurements,
using the `materials_catalog` table as the source of truth for unit costs,
coverage, and SKUs. No prices or coverage values are hard-coded.

The engine takes a `RoofTotals` struct (whole-roof aggregates) plus an
optional list of confirmed penetrations, and returns line items with:
    - quantity required (rounded UP to whole units; you can't buy 0.4 of a bundle)
    - waste-adjusted quantity at every standard waste %
    - unit_cost (from catalog, region-aware)
    - total_cost
    - source line for transparency: "12 squares × 1.10 waste = 13.2 → 14 bundles"

Waste percentage table: 5, 10, 12, 15, 18, 20, 25.
For each item we expose both the "tight" quantity (no waste) and the per-waste
quantities so the contractor can see what they'd order for a specific job.

Materials covered (catalog-driven, see migration seed data):
    - Architectural shingles            (per_square)
    - Synthetic underlayment            (per_square)
    - Roofing felt (optional)           (per_square)
    - Ice & water shield                (per_eave_iwshield)
    - Starter strip                     (per_lf_perimeter)
    - Ridge cap shingles                (per_lf_ridges)
    - Drip edge                         (per_lf_perimeter)
    - Valley metal                      (per_lf_valleys)
    - Step flashing                     (per_lf - wall_intersection)
    - Roofing nails                     (per_square)
    - Sealant                           (per_square)
    - Vent boots                        (per_unit - penetration count)

Anything not in the catalog isn't ordered. We never invent quantities.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------------
# Waste table
# ----------------------------------------------------------------------------

STANDARD_WASTE_PCTS: list[int] = [5, 10, 12, 15, 18, 20, 25]


def waste_factor(pct: float) -> float:
    return 1.0 + (max(0.0, float(pct)) / 100.0)


# ----------------------------------------------------------------------------
# Input struct
# ----------------------------------------------------------------------------

@dataclass
class RoofTotals:
    """All measurements the engine needs. Every field is in feet/sqft."""
    total_roof_sqft: float
    squares: float                       # total_roof_sqft / 100
    eaves_ft: float
    rakes_ft: float
    ridges_ft: float
    hips_ft: float
    valleys_ft: float
    wall_intersection_ft: float = 0.0     # walls dormers etc; drives step flashing
    stories: int = 1
    pitch: str = "6/12"

    @property
    def perimeter_ft(self) -> float:
        return self.eaves_ft + self.rakes_ft

    @property
    def ridge_total_ft(self) -> float:
        return self.ridges_ft + self.hips_ft


@dataclass
class PenetrationSummary:
    """Per-type penetration counts (from confirmed roof_penetrations rows)."""
    plumbing_vent: int = 0
    exhaust_vent: int = 0
    ridge_vent: int = 0
    box_vent: int = 0
    turbine_vent: int = 0
    chimney: int = 0
    skylight: int = 0
    other: int = 0

    @classmethod
    def from_rows(cls, rows: list[dict]) -> "PenetrationSummary":
        summary = cls()
        for r in rows:
            if not r.get("user_confirmed"):
                continue
            t = r.get("type")
            n = int(r.get("count") or 1)
            if hasattr(summary, t):
                setattr(summary, t, getattr(summary, t) + n)
        return summary

    @property
    def vent_boots_required(self) -> int:
        # Plumbing vents always need boots; exhaust vents typically have integrated flashing.
        return self.plumbing_vent


# ----------------------------------------------------------------------------
# Material line item output
# ----------------------------------------------------------------------------

@dataclass
class MaterialLine:
    sku: str
    item_name: str
    category: str
    unit: str
    coverage_basis: str
    base_quantity: float          # before waste, exact decimal
    waste_quantities: dict[int, int] = field(default_factory=dict)  # pct → whole units (rounded up)
    unit_cost: float = 0.0
    total_cost_at_default_waste: float = 0.0
    default_waste_pct: int = 12
    notes: str = ""
    computation_trace: str = ""   # human-readable formula for transparency

    def to_dict(self) -> dict:
        return {
            "sku": self.sku,
            "item_name": self.item_name,
            "category": self.category,
            "unit": self.unit,
            "coverage_basis": self.coverage_basis,
            "base_quantity": round(self.base_quantity, 2),
            "waste_quantities": dict(self.waste_quantities),
            "unit_cost": round(self.unit_cost, 2),
            "total_cost_at_default_waste": round(self.total_cost_at_default_waste, 2),
            "default_waste_pct": self.default_waste_pct,
            "notes": self.notes,
            "computation_trace": self.computation_trace,
        }


# ----------------------------------------------------------------------------
# Coverage formula by basis
# ----------------------------------------------------------------------------

def _base_quantity_for(
    coverage_basis: str,
    coverage_value: float,
    totals: RoofTotals,
    penetrations: PenetrationSummary,
    item_category: str,
) -> tuple[float, str]:
    """
    Return (base_quantity, trace_string) for a single catalog item BEFORE
    waste. coverage_value is units-per-thing (e.g. 100 = 100 sq ft per
    starter strip box, 33 = 33 lf per ridge cap bundle).

    Each branch documents exactly how the number is derived so the trace
    can be displayed to the contractor.
    """
    cov = max(coverage_value, 0.001)   # avoid div by zero on bad catalog data

    if coverage_basis == "per_square":
        # quantity such that quantity × coverage_value squares are covered
        if item_category == "shingles":
            qty = totals.squares
            return qty, f"{qty:.2f} squares (1 sq per 100 sf roof)"
        # Underlayment, nails, sealant: 1 unit per coverage_value squares
        qty = totals.squares / cov
        return qty, f"{totals.squares:.2f} sq ÷ {cov:g} sq per {item_category} = {qty:.2f}"

    if coverage_basis == "per_lf":
        # Step flashing follows wall intersections; if there's none we won't include the row
        lf = totals.wall_intersection_ft
        qty = lf / cov
        return qty, f"{lf:.1f} lf wall ÷ {cov:g} lf/box = {qty:.2f}"

    if coverage_basis == "per_lf_perimeter":
        lf = totals.perimeter_ft
        qty = lf / cov
        return qty, f"({totals.eaves_ft:.1f} eave + {totals.rakes_ft:.1f} rake) = {lf:.1f} lf ÷ {cov:g} = {qty:.2f}"

    if coverage_basis == "per_lf_ridges":
        lf = totals.ridge_total_ft
        qty = lf / cov
        return qty, f"({totals.ridges_ft:.1f} ridge + {totals.hips_ft:.1f} hip) = {lf:.1f} lf ÷ {cov:g} = {qty:.2f}"

    if coverage_basis == "per_lf_valleys":
        lf = totals.valleys_ft
        qty = lf / cov
        return qty, f"{lf:.1f} valley lf ÷ {cov:g} lf/roll = {qty:.2f}"

    if coverage_basis == "per_eave_iwshield":
        # Code-standard ice & water: 3 ft past wall at eaves + 3 ft each side of valleys
        sf = (totals.eaves_ft * 3.0) + (totals.valleys_ft * 6.0)
        qty = sf / cov
        return qty, f"({totals.eaves_ft:.1f}×3 eave + {totals.valleys_ft:.1f}×6 valley) = {sf:.1f} sf ÷ {cov:g} = {qty:.2f}"

    if coverage_basis == "per_unit":
        # Used for items that match a count: vent boots = plumbing_vent count
        if item_category == "vent_boot":
            qty = float(penetrations.vent_boots_required)
            return qty, f"{int(qty)} plumbing vent(s) need pipe boots"
        return 0.0, "per_unit basis with no matching count"

    return 0.0, f"unknown coverage_basis '{coverage_basis}'"


def _should_include(item: dict, totals: RoofTotals, penetrations: PenetrationSummary) -> bool:
    """
    Drop catalog rows that don't apply to this job:
      - step flashing only if wall_intersection_ft > 0 OR stories > 1
      - vent boots only if at least one plumbing vent is confirmed
      - valley metal only if valleys_ft > 0
      - ice & water shield always (code in most regions)
    """
    cat = item.get("category")
    if cat == "step_flashing":
        return (totals.wall_intersection_ft > 0) or (totals.stories > 1)
    if cat == "vent_boot":
        return penetrations.vent_boots_required > 0
    if cat == "valley_metal":
        return totals.valleys_ft > 0
    if cat == "ridge_cap":
        return totals.ridge_total_ft > 0
    return True


# ----------------------------------------------------------------------------
# Public computation
# ----------------------------------------------------------------------------

# Flashing categories whose QUANTITIES come from the deterministic flashing
# engine (not the catalog coverage formula). compute_material_lines skips
# these; compute_flashing_material_lines handles them with catalog pricing.
FLASHING_DERIVED_CATEGORIES = {
    "counter_flashing", "apron_flashing", "kickout_flashing",
    "chimney_flashing_kit", "skylight_flashing_kit", "cricket",
}

# category → (measure, flashing-totals key)
_FLASHING_QTY_SOURCE = {
    "counter_flashing":     ("linear", "counter_flashing_ft"),
    "apron_flashing":       ("linear", "apron_flashing_ft"),   # + headwall_flashing_ft
    "kickout_flashing":     ("count", "kickout_qty"),
    "chimney_flashing_kit": ("count", "chimney_qty"),
    "skylight_flashing_kit": ("count", "skylight_qty"),
    "cricket":              ("count", "cricket_qty"),
}


def compute_flashing_material_lines(
    catalog: list[dict],
    flashing: dict | None,
    *,
    default_waste_pct: int = 12,
) -> list[MaterialLine]:
    """
    Turn the flashing engine's quantities into priced, orderable line items by
    matching catalog SKUs by category. Linear items (counter / apron) divide
    by the catalog coverage_value (lf per piece) and take waste; count items
    (kickout / chimney kit / skylight kit / cricket) are unit-for-unit, no waste.

    Quantities are AUTHORITATIVE from the flashing engine — the catalog only
    supplies SKU + unit + price. Returns [] when there's no flashing.
    """
    if not flashing:
        return []
    if default_waste_pct not in STANDARD_WASTE_PCTS:
        default_waste_pct = 12
    totals = flashing.get("totals") or {}
    lines: list[MaterialLine] = []
    for item in catalog:
        if not item.get("active", True):
            continue
        cat = item.get("category")
        spec = _FLASHING_QTY_SOURCE.get(cat)
        if not spec:
            continue
        measure, key = spec
        qty_source = float(totals.get(key) or 0.0)
        if cat == "apron_flashing":
            qty_source += float(totals.get("headwall_flashing_ft") or 0.0)
        if qty_source <= 0:
            continue
        cov = float(item.get("coverage_value") or 1.0) or 1.0
        base_qty = (qty_source / cov) if measure == "linear" else qty_source

        waste_q: dict[int, int] = {}
        for pct in STANDARD_WASTE_PCTS:
            if measure == "count":
                waste_q[pct] = max(1, math.ceil(round(base_qty, 6)))
            else:
                waste_q[pct] = max(1, math.ceil(round(base_qty * waste_factor(pct), 6)))

        unit_cost = float(item.get("unit_cost") or 0.0)
        unit = item.get("unit") or "unit"
        trace = (
            f"{qty_source:.1f} lf ÷ {cov:g} lf/{unit} = {base_qty:.2f}"
            if measure == "linear"
            else f"{int(qty_source)} {unit}(s) from flashing analysis"
        )
        lines.append(MaterialLine(
            sku=item.get("sku") or "",
            item_name=item.get("item_name") or "",
            category=cat,
            unit=unit,
            coverage_basis=item.get("coverage_basis") or "per_unit",
            base_quantity=base_qty,
            waste_quantities=waste_q,
            unit_cost=unit_cost,
            default_waste_pct=default_waste_pct,
            total_cost_at_default_waste=waste_q[default_waste_pct] * unit_cost,
            notes=item.get("notes") or "",
            computation_trace=trace,
        ))
    return lines


def compute_material_lines(
    catalog: list[dict],
    totals: RoofTotals,
    penetrations: PenetrationSummary | None = None,
    *,
    default_waste_pct: int = 12,
) -> list[MaterialLine]:
    """
    Generate the full material ordering list.

    catalog: rows from the materials_catalog table (already region-filtered).
    totals: confirmed roof aggregates.
    penetrations: optional confirmed penetration counts.
    default_waste_pct: which waste % to set as the "displayed total" — the
        contractor sees the whole table in the UI, but the headline grand total
        uses this one.

    Returns a list of MaterialLine. Empty rows (qty 0) are omitted so the
    contractor doesn't see "0 bundles of ridge cap" on a flat roof.
    """
    penetrations = penetrations or PenetrationSummary()
    if default_waste_pct not in STANDARD_WASTE_PCTS:
        default_waste_pct = 12

    # Optional rows we filter out: roofing felt is an alternative to synthetic
    # underlayment. If we shipped both at full quantity the contractor would
    # double-order. Keep synthetic by default; let the catalog mark felt with
    # active=false for jobs that don't need it.
    items = [it for it in catalog if it.get("active", True)]

    lines: list[MaterialLine] = []
    for item in items:
        category = item.get("category", "misc")
        # Flashing-derived categories are priced separately from the flashing
        # engine's authoritative quantities — skip them here.
        if category in FLASHING_DERIVED_CATEGORIES:
            continue
        if not _should_include(item, totals, penetrations):
            continue

        coverage_basis = item.get("coverage_basis", "per_square")
        coverage_value = float(item.get("coverage_value") or 1.0)
        unit_cost = float(item.get("unit_cost") or 0.0)

        base_qty, trace = _base_quantity_for(
            coverage_basis, coverage_value, totals, penetrations, category,
        )
        if base_qty <= 0:
            continue

        # Compute the rounded-up quantity at every standard waste %.
        # Round the product to 6 decimals BEFORE ceil to kill IEEE-754 noise —
        # 25 × 1.12 in Python is 28.000000000000004, which without this rounding
        # would push the contractor to order 29 squares instead of 28.
        waste_q: dict[int, int] = {}
        for pct in STANDARD_WASTE_PCTS:
            # Special case: penetration items don't get a waste factor — you
            # don't buy "1.1 vent boots". Their quantity is the same at every
            # waste %.
            if coverage_basis == "per_unit":
                waste_q[pct] = max(1, math.ceil(round(base_qty, 6)))
            else:
                waste_q[pct] = max(1, math.ceil(round(base_qty * waste_factor(pct), 6)))

        line = MaterialLine(
            sku=item.get("sku") or "",
            item_name=item.get("item_name") or "",
            category=category,
            unit=item.get("unit") or "unit",
            coverage_basis=coverage_basis,
            base_quantity=base_qty,
            waste_quantities=waste_q,
            unit_cost=unit_cost,
            default_waste_pct=default_waste_pct,
            total_cost_at_default_waste=waste_q[default_waste_pct] * unit_cost,
            notes=item.get("notes") or "",
            computation_trace=trace,
        )
        lines.append(line)

    return lines


def grand_total(lines: list[MaterialLine], waste_pct: int) -> float:
    """Sum of (waste-adjusted quantity × unit_cost) across all lines."""
    if waste_pct not in STANDARD_WASTE_PCTS:
        waste_pct = 12
    return round(
        sum(l.waste_quantities.get(waste_pct, 0) * l.unit_cost for l in lines),
        2,
    )


def materials_summary(lines: list[MaterialLine]) -> dict[str, Any]:
    """
    Headline summary: per-waste-% grand totals, plus a per-category breakdown
    so the report can group "Shingles & accessories" / "Flashing" / etc.
    """
    per_waste = {pct: grand_total(lines, pct) for pct in STANDARD_WASTE_PCTS}
    per_category: dict[str, dict[str, float]] = {}
    for l in lines:
        bucket = per_category.setdefault(l.category, {"items": 0, "subtotal": 0.0})
        bucket["items"] += 1
        bucket["subtotal"] += l.total_cost_at_default_waste
    return {
        "per_waste_totals": per_waste,
        "per_category": per_category,
        "default_waste_pct": lines[0].default_waste_pct if lines else 12,
        "line_count": len(lines),
    }
