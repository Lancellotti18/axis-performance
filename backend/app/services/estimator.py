"""Material estimation engine based on blueprint analysis data."""
import math
from typing import List


class MaterialEstimator:

    CEILING_HEIGHT = 9.0  # default 9 ft ceilings

    def estimate_all(self, analysis: dict) -> List[dict]:
        rooms = analysis.get("rooms", [])
        walls = analysis.get("walls", [])
        openings = analysis.get("openings", [])
        total_sqft = analysis.get("total_sqft", 0)

        materials = []
        materials.extend(self.estimate_drywall(walls, openings))
        materials.extend(self.estimate_lumber(walls, total_sqft))
        materials.extend(self.estimate_flooring(rooms))
        materials.extend(self.estimate_roofing(total_sqft))
        materials.extend(self.estimate_concrete(total_sqft))
        materials.extend(self.estimate_electrical(analysis.get("electrical", [])))
        materials.extend(self.estimate_plumbing(analysis.get("plumbing", [])))
        return materials

    def estimate_drywall(self, walls: list, openings: list) -> List[dict]:
        total_wall_length = sum(w.get("length", 0) for w in walls) if walls else 0
        wall_area = total_wall_length * self.CEILING_HEIGHT
        opening_area = sum(o.get("width", 0) * o.get("height", 7) for o in openings)
        net_area = max(0, wall_area - opening_area)
        sheets = math.ceil((net_area * 1.10) / 32)
        return [{
            "category": "drywall",
            "item_name": "Drywall Sheet 4x8",
            "quantity": sheets,
            "unit": "sheets",
            "unit_cost": 18.50,
            "total_cost": sheets * 18.50,
        }]

    def estimate_lumber(self, walls: list, total_sqft: float) -> List[dict]:
        linear_ft = sum(w.get("length", 0) for w in walls) if walls else math.sqrt(total_sqft) * 4
        studs = math.ceil(linear_ft * 0.75)
        plates_lf = linear_ft * 3
        return [
            {
                "category": "lumber",
                "item_name": "2x4 Stud 8ft",
                "quantity": studs,
                "unit": "count",
                "unit_cost": 8.50,
                "total_cost": studs * 8.50,
            },
            {
                "category": "lumber",
                "item_name": "2x4 Plate (linear ft)",
                "quantity": round(plates_lf),
                "unit": "linear_ft",
                "unit_cost": 0.70,
                "total_cost": round(plates_lf) * 0.70,
            },
        ]

    def estimate_flooring(self, rooms: list) -> List[dict]:
        total_sqft = sum(r.get("sqft", 0) for r in rooms)
        flooring_sqft = math.ceil(total_sqft * 1.12)
        return [{
            "category": "flooring",
            "item_name": "LVP Flooring",
            "quantity": flooring_sqft,
            "unit": "sqft",
            "unit_cost": 3.50,
            "total_cost": flooring_sqft * 3.50,
        }]

    def estimate_roofing(self, total_sqft: float) -> List[dict]:
        pitch_factor = math.sqrt(1 + (6/12)**2)  # assume 6:12 pitch
        roof_sqft = total_sqft * pitch_factor
        squares = math.ceil((roof_sqft * 1.15) / 100)
        return [{
            "category": "roofing",
            "item_name": "Architectural Shingles (squares)",
            "quantity": squares,
            "unit": "squares",
            "unit_cost": 120.0,
            "total_cost": squares * 120.0,
        }]

    def estimate_concrete(self, total_sqft: float) -> List[dict]:
        perimeter = math.sqrt(total_sqft) * 4
        footing_cy = (perimeter * 1.5 * 1.0) / 27
        slab_cy = (total_sqft * 0.33) / 27
        total_cy = math.ceil(footing_cy + slab_cy)
        return [{
            "category": "concrete",
            "item_name": "Ready-Mix Concrete",
            "quantity": total_cy,
            "unit": "cubic_yd",
            "unit_cost": 165.0,
            "total_cost": total_cy * 165.0,
        }]

    def estimate_electrical(self, electrical: list) -> List[dict]:
        outlet_count = sum(e.get("count", 1) for e in electrical if e.get("type") == "outlet")
        if outlet_count == 0:
            outlet_count = 20  # default for unknown
        return [{
            "category": "electrical",
            "item_name": "Electrical Outlet + Box",
            "quantity": outlet_count,
            "unit": "count",
            "unit_cost": 35.0,
            "total_cost": outlet_count * 35.0,
        }]

    def estimate_plumbing(self, plumbing: list) -> List[dict]:
        fixture_count = len(plumbing) if plumbing else 5
        return [{
            "category": "plumbing",
            "item_name": "Plumbing Fixture Rough-In",
            "quantity": fixture_count,
            "unit": "count",
            "unit_cost": 450.0,
            "total_cost": fixture_count * 450.0,
        }]
