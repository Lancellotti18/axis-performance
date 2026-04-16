"""Cost estimation engine with regional pricing.

Uses RS Means / ENR National Average labor rates as the baseline. Regional
multipliers come from the RS Means City Cost Index (national avg = 1.0).
Labor hours per sqft uses the NAHB standard for new residential construction
(ranges 0.7–1.1 hrs/sqft; using 0.9 as mid-range).
"""
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# General labor, electrical, and plumbing hourly rates by state
# Source: BLS Occupational Employment Statistics (2024), loaded wage
REGIONAL_RATES = {
    "US-CA": {"general": 85, "electrical": 110, "plumbing": 105},
    "US-TX": {"general": 65, "electrical": 85, "plumbing": 80},
    "US-NY": {"general": 95, "electrical": 120, "plumbing": 115},
    "US-FL": {"general": 60, "electrical": 80, "plumbing": 75},
    "US-WA": {"general": 80, "electrical": 105, "plumbing": 100},
    "US-CO": {"general": 72, "electrical": 95, "plumbing": 90},
    "US-AZ": {"general": 62, "electrical": 82, "plumbing": 78},
    "US-GA": {"general": 58, "electrical": 78, "plumbing": 73},
    "US-NC": {"general": 57, "electrical": 76, "plumbing": 72},
    "US-IL": {"general": 78, "electrical": 102, "plumbing": 98},
    "US-MA": {"general": 88, "electrical": 115, "plumbing": 110},
    "US-OR": {"general": 76, "electrical": 98, "plumbing": 94},
    "US-OH": {"general": 62, "electrical": 82, "plumbing": 78},
    "US-PA": {"general": 70, "electrical": 92, "plumbing": 88},
    "DEFAULT": {"general": 68, "electrical": 90, "plumbing": 85},
}

# RS Means City Cost Index for materials by state (national avg = 1.0)
MATERIAL_INDEX = {
    "US-CA": 1.25, "US-NY": 1.30, "US-TX": 1.00, "US-FL": 1.05,
    "US-WA": 1.15, "US-CO": 1.08, "US-AZ": 1.02, "US-GA": 0.96,
    "US-NC": 0.95, "US-IL": 1.10, "US-MA": 1.22, "US-OR": 1.12,
    "US-OH": 0.97, "US-PA": 1.05, "US-AL": 0.92, "US-TN": 0.94,
    "US-IN": 0.98, "US-MN": 1.07, "US-VA": 1.01, "US-MI": 1.03,
    "DEFAULT": 1.00,
}

LABOR_HOURS_PER_SQFT = 0.9  # NAHB avg for residential new construction


class CostEngine:

    def calculate(
        self,
        materials: list,
        region: str,
        markup_pct: float = 15.0,
        total_sqft: Optional[float] = None,
    ) -> dict:
        """Build a cost estimate. Pass total_sqft from the blueprint analysis
        so labor is not derived from flooring material quantity (which fails
        when the project has no finished flooring line items).
        """
        rates = REGIONAL_RATES.get(region, REGIONAL_RATES["DEFAULT"])
        mat_index = MATERIAL_INDEX.get(region, 1.0)

        materials_total = sum(m.get("total_cost", 0) for m in materials) * mat_index

        if total_sqft is None or total_sqft <= 0:
            # Fall back to deriving from flooring material — still better than
            # a hardcoded constant, but log it so we know when this path fires.
            total_sqft = next(
                (m.get("quantity", 0) for m in materials if m.get("category") == "flooring"),
                0,
            )
            if total_sqft <= 0:
                logger.warning(
                    "cost_engine.calculate called without total_sqft and no flooring quantity; "
                    "labor cost cannot be computed accurately"
                )
                total_sqft = 0

        labor_hours = total_sqft * LABOR_HOURS_PER_SQFT
        labor_total = labor_hours * rates["general"]

        subtotal = materials_total + labor_total
        overhead = subtotal * 0.10
        markup = (subtotal + overhead) * (markup_pct / 100)
        grand_total = subtotal + overhead + markup

        return {
            "materials_total": round(materials_total, 2),
            "labor_total": round(labor_total, 2),
            "markup_pct": markup_pct,
            "overhead_pct": 10.0,
            "grand_total": round(grand_total, 2),
            "region": region,
            "labor_hours": round(labor_hours, 1),
            "total_sqft": round(total_sqft, 1),
        }
