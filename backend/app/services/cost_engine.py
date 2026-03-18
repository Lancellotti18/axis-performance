"""Cost estimation engine with regional pricing."""

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
    "DEFAULT": {"general": 68, "electrical": 90, "plumbing": 85},
}

MATERIAL_INDEX = {
    "US-CA": 1.25, "US-NY": 1.30, "US-TX": 1.0, "US-FL": 1.05,
    "US-WA": 1.15, "DEFAULT": 1.0,
}

LABOR_HOURS_PER_SQFT = 1.8  # average hours per sqft for residential


class CostEngine:

    def calculate(self, materials: list, region: str, markup_pct: float = 15.0) -> dict:
        rates = REGIONAL_RATES.get(region, REGIONAL_RATES["DEFAULT"])
        mat_index = MATERIAL_INDEX.get(region, 1.0)

        # Adjust material costs for region
        materials_total = sum(m["total_cost"] for m in materials) * mat_index

        # Estimate total sqft from flooring material
        total_sqft = next(
            (m["quantity"] for m in materials if m["category"] == "flooring"), 1000
        )
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
        }
