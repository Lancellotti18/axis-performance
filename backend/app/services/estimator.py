"""
Material estimation engine — comprehensive takeoff based on blueprint analysis.
Covers: lumber, sheathing, drywall, insulation, roofing, concrete/foundation,
        flooring, windows/doors, electrical, plumbing, finishing materials.
"""
import logging
import math
from typing import List

logger = logging.getLogger(__name__)


# ── Constants ────────────────────────────────────────────────────────────────

CEILING_HEIGHT   = 9.0    # ft
STUD_SPACING     = 16     # inches on center
WASTE_FACTOR     = 1.10   # 10% waste on most materials
ROOF_PITCH       = 6      # /12 pitch (moderate slope)


# ── Base unit prices (national average, will be updated by real-time search) ─

BASE_PRICES = {
    # Lumber
    "2x4x8 Stud":              8.97,
    "2x4x92-5/8 Precut Stud":  9.47,
    "2x6x8 Stud":             13.48,
    "2x4 Top/Bottom Plate LF": 0.72,
    "2x6 Top/Bottom Plate LF": 1.08,
    "2x10 Joist LF":           2.85,
    "2x12 Joist LF":           3.75,
    "LVL Beam (per LF)":      18.50,
    "Roof Rafter 2x8 LF":      2.25,
    # Sheathing
    "OSB Sheathing 7/16 4x8":  18.97,
    "Plywood Subfloor 3/4 4x8": 55.00,
    # Drywall
    "Drywall 4x8 1/2in":       14.98,
    "Drywall 4x12 1/2in":      21.50,
    "Joint Compound 5gal":     19.97,
    "Drywall Tape 500ft":       7.48,
    "Drywall Corner Bead 8ft":  1.29,
    "Drywall Screws 1lb":       5.98,
    # Insulation
    "Batt Insulation R-15 3.5in (sqft)": 0.68,
    "Batt Insulation R-21 5.5in (sqft)": 0.92,
    "Blown-In Insulation Attic (sqft)":  0.85,
    "Vapor Barrier 6mil (sqft)":         0.12,
    # Roofing
    "Architectural Shingles (sq)":  120.00,
    "Roofing Felt 15lb (sq)":        15.00,
    "Ice & Water Shield (sqft)":      1.25,
    "Ridge Cap Shingles (LF)":        4.50,
    "Drip Edge Aluminum 10ft":         4.98,
    "Roofing Nails 1lb":               3.49,
    # Concrete / Foundation
    "Ready-Mix Concrete (CY)":       165.00,
    "Rebar #4 20ft":                  12.50,
    "Concrete Block 8x8x16":           2.19,
    "Anchor Bolts 1/2in":              1.89,
    # Flooring
    "LVP Flooring (sqft)":             3.49,
    "Hardwood Flooring (sqft)":        6.99,
    "Tile Flooring (sqft)":            2.99,
    "Carpet (sqft)":                   1.99,
    "Flooring Underlayment (sqft)":    0.38,
    "Transition Strip":               14.98,
    # Windows & Doors
    "Exterior Door 32x80":           298.00,
    "Exterior Door 36x80":           349.00,
    "Interior Door 32x80":            89.00,
    "Interior Door 36x80":            99.00,
    "Window Double Hung 3x4":        329.00,
    "Window Double Hung 4x4":        389.00,
    "Sliding Glass Door 6ft":        849.00,
    # Electrical
    "14-2 Wire Romex (ft)":            0.55,
    "12-2 Wire Romex (ft)":            0.78,
    "200A Main Panel":               389.00,
    "20A Circuit Breaker":            12.97,
    "Duplex Outlet":                   2.49,
    "GFCI Outlet":                    14.97,
    "Single-Pole Switch":              2.29,
    "3-Way Switch":                    5.97,
    "Light Fixture Box":               4.98,
    "Electrical Box":                  1.97,
    # Plumbing
    "3/4in Copper Pipe (ft)":          4.25,
    "1/2in Copper Pipe (ft)":          2.85,
    "3in PVC DWV Pipe (ft)":           3.49,
    "4in PVC DWV Pipe (ft)":           4.99,
    "Copper Fittings Set":             85.00,
    "PVC Fittings Set":               45.00,
    "Toilet":                         299.00,
    "Bathroom Sink + Faucet":         189.00,
    "Kitchen Sink + Faucet":          299.00,
    "Bathtub":                        449.00,
    "Shower Kit":                     549.00,
    "Water Heater 50gal":             699.00,
    # Finishing
    "Interior Paint (gallon)":         38.00,
    "Exterior Paint (gallon)":         48.00,
    "Primer (gallon)":                 24.00,
    "Baseboard Molding 8ft":            3.49,
    "Door Casing 7ft":                  2.49,
    "Crown Molding 8ft":                4.98,
}


class MaterialEstimator:

    def estimate_all(self, analysis: dict) -> List[dict]:
        rooms    = analysis.get("rooms",    [])
        walls    = analysis.get("walls",    [])
        openings = analysis.get("openings", [])
        elec     = analysis.get("electrical", [])
        plumb    = analysis.get("plumbing",   [])
        total_sqft = float(analysis.get("total_sqft", 0) or 0)

        # Fall back to rough estimate from room list if total_sqft is 0
        if total_sqft < 10 and rooms:
            total_sqft = sum(r.get("sqft", 0) for r in rooms)

        # Derive perimeter / wall length
        wall_lf = self._total_wall_lf(walls, total_sqft)

        doors    = [o for o in openings if o.get("type") == "door"]
        windows  = [o for o in openings if o.get("type") == "window"]

        # Default counts when detections are sparse
        if not doors:   doors   = [{}] * max(1, int(rooms.__len__() * 1.5))
        if not windows: windows = [{}] * max(2, int(rooms.__len__() * 2))

        materials: List[dict] = []
        materials += self._lumber(wall_lf, total_sqft, rooms)
        materials += self._sheathing(wall_lf, total_sqft)
        materials += self._drywall(wall_lf, doors, windows)
        materials += self._insulation(wall_lf, total_sqft)
        materials += self._roofing(total_sqft)
        materials += self._concrete(total_sqft)
        materials += self._flooring(rooms, total_sqft)
        materials += self._doors(doors, rooms)
        materials += self._windows(windows, rooms)
        materials += self._electrical(elec, total_sqft, rooms)
        materials += self._plumbing(plumb, rooms)
        materials += self._finishing(wall_lf, total_sqft, rooms)

        return materials

    # ── Helpers ─────────────────────────────────────────────────────────────

    def _total_wall_lf(self, walls: list, total_sqft: float) -> float:
        if walls:
            return sum(w.get("length", 0) for w in walls)
        # Estimate from sqft: perimeter + interior walls
        side = math.sqrt(max(total_sqft, 100))
        perimeter = side * 4
        interior  = perimeter * 1.8   # interior walls ~1.8x perimeter
        return perimeter + interior

    def _item(self, category: str, name: str, qty: float, unit: str,
              base_price_key: str = None, override_price: float = None) -> dict:
        price_unverified = False
        if override_price is not None:
            price = override_price
        else:
            key = base_price_key or name
            if key in BASE_PRICES:
                price = BASE_PRICES[key]
            else:
                # No base price on file — flag so the UI can surface "price unverified"
                # and so the refresh-prices flow prioritizes a live lookup for this row.
                price = 10.0
                price_unverified = True
                logger.warning(
                    "estimator: no base price for key=%r (item=%r, category=%r); "
                    "using placeholder $10.00 and flagging price_unverified",
                    key, name, category,
                )
        qty = max(1, round(qty))
        return {
            "category":  category,
            "item_name": name,
            "quantity":  qty,
            "unit":      unit,
            "unit_cost": price,
            "total_cost": round(qty * price, 2),
            "price_unverified": price_unverified,
        }

    # ── Lumber ──────────────────────────────────────────────────────────────

    def _lumber(self, wall_lf: float, sqft: float, rooms: list) -> List[dict]:
        items = []

        # Wall studs (16" OC → 0.75 studs per LF + 3 extra per corner/opening)
        studs = math.ceil(wall_lf * 0.75 * WASTE_FACTOR)
        items.append(self._item("lumber", "2x4x92-5/8 Precut Stud", studs, "count", "2x4x92-5/8 Precut Stud"))

        # Top and bottom plates (3 plates per wall run)
        plate_lf = wall_lf * 3
        items.append(self._item("lumber", "2x4 Top/Bottom Plate", math.ceil(plate_lf), "linear_ft", "2x4 Top/Bottom Plate LF"))

        # Headers (2 per door/window opening avg 4ft)
        header_lf = max(8, int(wall_lf / 20)) * 4
        items.append(self._item("lumber", "2x10 Header Material", math.ceil(header_lf), "linear_ft", "2x10 Joist LF"))

        # Floor joists (2x10 @ 16" OC)
        joist_lf = math.ceil((sqft / 12) * 1.15)
        items.append(self._item("lumber", "2x10 Floor Joist", joist_lf, "linear_ft", "2x10 Joist LF"))

        # Rim joist / band board
        rim_lf = math.ceil(math.sqrt(sqft) * 4 * 1.05)
        items.append(self._item("lumber", "2x10 Rim Joist", rim_lf, "linear_ft", "2x10 Joist LF"))

        # Roof rafters (2x8 @ 24" OC)
        pitch_factor = math.sqrt(1 + (ROOF_PITCH / 12) ** 2)
        rafter_lf = math.ceil((sqft * pitch_factor / 2) * 1.15)
        items.append(self._item("lumber", "2x8 Roof Rafter", rafter_lf, "linear_ft", "Roof Rafter 2x8 LF"))

        # Ridge board (1x10)
        ridge_lf = math.ceil(math.sqrt(sqft) * 0.55)
        items.append(self._item("lumber", "1x10 Ridge Board", ridge_lf, "linear_ft", "Roof Rafter 2x8 LF", override_price=3.25))

        # LVL beam (main carrying beam)
        lvl_lf = math.ceil(math.sqrt(sqft) * 0.6)
        items.append(self._item("lumber", "LVL Beam 3.5x11.25", lvl_lf, "linear_ft", "LVL Beam (per LF)"))

        return items

    # ── Sheathing ────────────────────────────────────────────────────────────

    def _sheathing(self, wall_lf: float, sqft: float) -> List[dict]:
        items = []

        # Wall sheathing (OSB 7/16)
        wall_area  = wall_lf * CEILING_HEIGHT
        osb_sheets = math.ceil((wall_area * WASTE_FACTOR) / 32)
        items.append(self._item("sheathing", "OSB Wall Sheathing 7/16 4x8", osb_sheets, "sheets", "OSB Sheathing 7/16 4x8"))

        # Roof sheathing
        pitch_factor = math.sqrt(1 + (ROOF_PITCH / 12) ** 2)
        roof_area    = sqft * pitch_factor
        roof_sheets  = math.ceil((roof_area * WASTE_FACTOR) / 32)
        items.append(self._item("sheathing", "OSB Roof Sheathing 7/16 4x8", roof_sheets, "sheets", "OSB Sheathing 7/16 4x8"))

        # Subfloor (3/4 plywood)
        sub_sheets = math.ceil((sqft * WASTE_FACTOR) / 32)
        items.append(self._item("sheathing", "3/4 Plywood Subfloor 4x8", sub_sheets, "sheets", "Plywood Subfloor 3/4 4x8"))

        return items

    # ── Drywall ──────────────────────────────────────────────────────────────

    def _drywall(self, wall_lf: float, doors: list, windows: list) -> List[dict]:
        items = []

        wall_area    = wall_lf * CEILING_HEIGHT
        opening_area = (len(doors) * 21) + (len(windows) * 15)  # avg sqft per opening
        net_area     = max(0, wall_area - opening_area)
        dw_sheets    = math.ceil((net_area * WASTE_FACTOR) / 32)
        items.append(self._item("drywall", "Drywall 4x8 1/2in", dw_sheets, "sheets", "Drywall 4x8 1/2in"))

        # Joint compound
        jc_buckets = math.ceil(dw_sheets / 20)
        items.append(self._item("drywall", "Joint Compound 5-Gallon", jc_buckets, "buckets", "Joint Compound 5gal"))

        # Tape
        tape_rolls = math.ceil(dw_sheets / 30)
        items.append(self._item("drywall", "Drywall Tape 500ft", tape_rolls, "rolls", "Drywall Tape 500ft"))

        # Corner bead
        corner_bead = math.ceil(wall_lf / 10)
        items.append(self._item("drywall", "Metal Corner Bead 8ft", corner_bead, "pieces", "Drywall Corner Bead 8ft"))

        # Screws (1 lb per 30 sheets)
        screws = math.ceil(dw_sheets / 30)
        items.append(self._item("drywall", "Drywall Screws 1-5/8in 1lb", screws, "boxes", "Drywall Screws 1lb"))

        return items

    # ── Insulation ───────────────────────────────────────────────────────────

    def _insulation(self, wall_lf: float, sqft: float) -> List[dict]:
        items = []

        # Wall insulation (R-15 for 2x4 walls)
        wall_area = wall_lf * CEILING_HEIGHT
        items.append(self._item("insulation", "Batt Insulation R-15 (Wall)", math.ceil(wall_area * WASTE_FACTOR), "sqft", "Batt Insulation R-15 3.5in (sqft)"))

        # Attic insulation (blown-in R-38)
        items.append(self._item("insulation", "Blown-In Attic Insulation R-38", math.ceil(sqft * 1.05), "sqft", "Blown-In Insulation Attic (sqft)"))

        # Vapor barrier
        items.append(self._item("insulation", "Vapor Barrier 6mil", math.ceil(sqft * 1.1), "sqft", "Vapor Barrier 6mil (sqft)"))

        return items

    # ── Roofing ──────────────────────────────────────────────────────────────

    def _roofing(self, sqft: float) -> List[dict]:
        items = []

        pitch_factor = math.sqrt(1 + (ROOF_PITCH / 12) ** 2)
        roof_sqft    = sqft * pitch_factor
        squares      = math.ceil((roof_sqft * WASTE_FACTOR) / 100)

        items.append(self._item("roofing", "Architectural Shingles", squares, "squares", "Architectural Shingles (sq)"))

        # Felt underlayment
        items.append(self._item("roofing", "Roofing Felt 15lb", squares, "squares", "Roofing Felt 15lb (sq)"))

        # Ice & water shield (first 3ft from eave)
        perimeter = math.sqrt(sqft) * 4
        iws_sqft  = math.ceil(perimeter * 3)
        items.append(self._item("roofing", "Ice & Water Shield", iws_sqft, "sqft", "Ice & Water Shield (sqft)"))

        # Ridge cap
        ridge_lf = math.ceil(math.sqrt(sqft) * 0.55)
        items.append(self._item("roofing", "Ridge Cap Shingles", ridge_lf, "linear_ft", "Ridge Cap Shingles (LF)"))

        # Drip edge
        drip_pieces = math.ceil(perimeter / 10)
        items.append(self._item("roofing", "Aluminum Drip Edge 10ft", drip_pieces, "pieces", "Drip Edge Aluminum 10ft"))

        return items

    # ── Concrete / Foundation ────────────────────────────────────────────────

    def _concrete(self, sqft: float) -> List[dict]:
        items = []

        perimeter = math.sqrt(sqft) * 4

        # Footing concrete (1.5ft wide x 1ft deep)
        footing_cy = (perimeter * 1.5 * 1.0) / 27
        # Slab (4in thick)
        slab_cy    = (sqft * (4 / 12)) / 27
        total_cy   = math.ceil((footing_cy + slab_cy) * WASTE_FACTOR)
        items.append(self._item("concrete", "Ready-Mix Concrete", total_cy, "cubic_yd", "Ready-Mix Concrete (CY)"))

        # Rebar (#4 @ 18" grid)
        rebar_lf   = math.ceil(sqft / 1.5 * 2)  # two-direction grid
        rebar_bars = math.ceil(rebar_lf / 20)
        items.append(self._item("concrete", "Rebar #4 20ft", rebar_bars, "bars", "Rebar #4 20ft"))

        # Anchor bolts (every 6ft of sill plate)
        bolts = math.ceil(perimeter / 6)
        items.append(self._item("concrete", "Anchor Bolts 1/2in x 10in", bolts, "count", "Anchor Bolts 1/2in"))

        return items

    # ── Flooring ─────────────────────────────────────────────────────────────

    def _flooring(self, rooms: list, total_sqft: float) -> List[dict]:
        items = []

        floor_sqft = sum(r.get("sqft", 0) for r in rooms) or total_sqft
        floor_sqft = math.ceil(floor_sqft * WASTE_FACTOR)

        items.append(self._item("flooring", "LVP Flooring", floor_sqft, "sqft", "LVP Flooring (sqft)"))
        items.append(self._item("flooring", "Flooring Underlayment", floor_sqft, "sqft", "Flooring Underlayment (sqft)"))

        # Transition strips (estimate 1 per room boundary)
        transitions = max(2, len(rooms))
        items.append(self._item("flooring", "Flooring Transition Strip", transitions, "count", "Transition Strip"))

        return items

    # ── Doors ────────────────────────────────────────────────────────────────

    def _doors(self, doors: list, rooms: list) -> List[dict]:
        items = []

        # Classify ext vs int (rough heuristic: 1 ext door per 4 rooms, rest interior)
        room_count = max(1, len(rooms))
        ext_count  = max(1, round(room_count / 4))
        int_count  = max(1, len(doors) - ext_count)

        items.append(self._item("doors_windows", "Exterior Door 32x80", ext_count, "count", "Exterior Door 32x80"))
        items.append(self._item("doors_windows", "Interior Door 32x80",  int_count, "count", "Interior Door 32x80"))

        # Door hardware
        hardware_sets = ext_count + int_count
        items.append(self._item("doors_windows", "Door Knob / Lockset", hardware_sets, "count", "Interior Door 32x80", override_price=29.97))

        return items

    # ── Windows ──────────────────────────────────────────────────────────────

    def _windows(self, windows: list, rooms: list) -> List[dict]:
        items = []
        win_count = max(2, len(windows))
        items.append(self._item("doors_windows", "Double-Hung Window 36x48", win_count, "count", "Window Double Hung 3x4"))

        # Window trim per window
        trim_pieces = win_count * 4
        items.append(self._item("doors_windows", "Window Casing Trim 7ft", trim_pieces, "pieces", "Door Casing 7ft"))

        return items

    # ── Electrical ───────────────────────────────────────────────────────────

    def _electrical(self, elec: list, sqft: float, rooms: list) -> List[dict]:
        items = []

        room_count   = max(1, len(rooms))
        outlet_count = sum(e.get("count", 0) for e in elec if "outlet" in e.get("type", "").lower())
        switch_count = sum(e.get("count", 0) for e in elec if "switch" in e.get("type", "").lower())

        # Default: ~2.5 outlets and 1.5 switches per room
        if outlet_count < 2: outlet_count = math.ceil(room_count * 2.5)
        if switch_count < 1: switch_count = math.ceil(room_count * 1.5)

        circuit_count = math.ceil(sqft / 400)   # 1 circuit per 400 sqft
        wire_lf       = math.ceil(sqft * 1.8)   # rough wire run estimate

        items.append(self._item("electrical", "14-2 Romex Wire", wire_lf, "linear_ft", "14-2 Wire Romex (ft)"))
        items.append(self._item("electrical", "12-2 Romex Wire (kitchen/bath)", math.ceil(wire_lf * 0.2), "linear_ft", "12-2 Wire Romex (ft)"))
        items.append(self._item("electrical", "200A Main Electrical Panel", 1, "count", "200A Main Panel"))
        items.append(self._item("electrical", "20A Circuit Breaker", circuit_count, "count", "20A Circuit Breaker"))
        items.append(self._item("electrical", "Duplex Outlet", outlet_count, "count", "Duplex Outlet"))
        items.append(self._item("electrical", "GFCI Outlet (bath/kitchen)", math.ceil(room_count * 0.4), "count", "GFCI Outlet"))
        items.append(self._item("electrical", "Single-Pole Light Switch", switch_count, "count", "Single-Pole Switch"))
        items.append(self._item("electrical", "Electrical Box", outlet_count + switch_count, "count", "Electrical Box"))

        return items

    # ── Plumbing ─────────────────────────────────────────────────────────────

    def _plumbing(self, plumb: list, rooms: list) -> List[dict]:
        items = []

        # Count wet rooms (bathrooms + kitchen)
        room_names  = [r.get("name", "").lower() for r in rooms]
        bath_count  = sum(1 for n in room_names if any(w in n for w in ["bath", "lavatory", "toilet", "wc"]))
        has_kitchen = any("kitchen" in n for n in room_names)
        if bath_count == 0: bath_count = max(1, len(rooms) // 4)
        if not has_kitchen: has_kitchen = True

        # Supply pipe
        supply_lf = math.ceil(math.sqrt(sum(r.get("sqft", 0) for r in rooms) or 1000) * 4)
        items.append(self._item("plumbing", "3/4in Copper Supply Pipe", math.ceil(supply_lf * 0.6), "linear_ft", "3/4in Copper Pipe (ft)"))
        items.append(self._item("plumbing", "1/2in Copper Branch Pipe", math.ceil(supply_lf * 0.8), "linear_ft", "1/2in Copper Pipe (ft)"))

        # DWV drain pipe
        items.append(self._item("plumbing", "3in PVC DWV Drain Pipe", math.ceil(supply_lf * 0.5), "linear_ft", "3in PVC DWV Pipe (ft)"))
        items.append(self._item("plumbing", "4in PVC Main Drain Stack", math.ceil(supply_lf * 0.15), "linear_ft", "4in PVC DWV Pipe (ft)"))

        # Fittings
        items.append(self._item("plumbing", "Copper Fittings Assortment", bath_count + 1, "sets", "Copper Fittings Set"))
        items.append(self._item("plumbing", "PVC DWV Fittings Assortment", bath_count + 1, "sets", "PVC Fittings Set"))

        # Fixtures
        items.append(self._item("plumbing", "Toilet (standard)",          bath_count, "count", "Toilet"))
        items.append(self._item("plumbing", "Bathroom Sink + Faucet",     bath_count, "count", "Bathroom Sink + Faucet"))
        if has_kitchen:
            items.append(self._item("plumbing", "Kitchen Sink + Faucet", 1, "count", "Kitchen Sink + Faucet"))

        # Tub/shower (1 per bath, at least 1 with tub)
        items.append(self._item("plumbing", "Bathtub",   max(1, bath_count - 1), "count", "Bathtub"))
        items.append(self._item("plumbing", "Shower Kit", 1, "count", "Shower Kit"))

        # Water heater
        items.append(self._item("plumbing", "Water Heater 50-Gallon", 1, "count", "Water Heater 50gal"))

        return items

    # ── Finishing Materials ──────────────────────────────────────────────────

    def _finishing(self, wall_lf: float, sqft: float, rooms: list) -> List[dict]:
        items = []

        # Paint (1 gallon covers 350 sqft, 2 coats)
        wall_area    = wall_lf * CEILING_HEIGHT
        paint_gal    = math.ceil((wall_area / 350) * 2)
        ext_paint_gal = math.ceil((math.sqrt(sqft) * 4 * CEILING_HEIGHT / 350) * 2)
        primer_gal   = math.ceil(paint_gal * 0.5)

        items.append(self._item("finishing", "Interior Paint (gallon)",  paint_gal,     "gallons", "Interior Paint (gallon)"))
        items.append(self._item("finishing", "Exterior Paint (gallon)",  ext_paint_gal, "gallons", "Exterior Paint (gallon)"))
        items.append(self._item("finishing", "Primer (gallon)",          primer_gal,    "gallons", "Primer (gallon)"))

        # Baseboard (LF of walls)
        baseboard_lf   = math.ceil(wall_lf * WASTE_FACTOR)
        baseboard_pcs  = math.ceil(baseboard_lf / 8)
        items.append(self._item("finishing", "Baseboard Molding 8ft", baseboard_pcs, "pieces", "Baseboard Molding 8ft"))

        # Door casing (2 sides x door count)
        room_count    = max(1, len(rooms))
        door_casings  = math.ceil(room_count * 1.5 * 2 * 2)  # 2 pieces per side, 2 sides
        items.append(self._item("finishing", "Door Casing 7ft", door_casings, "pieces", "Door Casing 7ft"))

        # Crown molding (main living areas only, ~40% of total perimeter)
        crown_lf  = math.ceil(wall_lf * 0.4 * WASTE_FACTOR)
        crown_pcs = math.ceil(crown_lf / 8)
        items.append(self._item("finishing", "Crown Molding 8ft", crown_pcs, "pieces", "Crown Molding 8ft"))

        return items
