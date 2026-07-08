-- ============================================================================
-- Axis Performance — materials catalog accuracy pass
-- ============================================================================
-- Audited against real-world contractor quantities. Three under-ordering bugs
-- and one missing item:
--
-- 1. STEP FLASHING: a box of 100 pcs was counted as 100 lf of coverage, but
--    each 4x5 piece covers ~5" of run → 100 pcs ≈ 41 lf. Was under-ordering
--    by ~2.4×.
-- 2. NAILS: "1 lb per square" — real usage is ~2.3 lb/sq (≈320 coil nails at
--    ~140/lb). Was under-ordering by ~2×. Re-spec'd as the 30-lb box
--    contractors actually buy (1 box ≈ 13 squares).
-- 3. ICE & WATER: "65 sf roll" doesn't exist at supply houses — standard
--    rolls are 1.5–2.25 sq. Re-spec'd as the common 2-sq (200 sf) roll.
-- 4. RIDGE CAP: 33 lf/bundle is the most generous brand (OC ProEdge);
--    GAF Seal-A-Ridge covers 25 lf. Default to 25 so nobody comes up short.
-- 5. NEW: RIDGE VENT (4 ft sections) — ridges ONLY, never hips. Uses the new
--    'per_lf_ridge_only' coverage basis.
-- ============================================================================

UPDATE materials_catalog SET
  coverage_value = 41,
  notes = 'Wall intersections; 100 pcs × ~5in exposure ≈ 41 lf per box'
WHERE sku = 'STEP-FL-100';

UPDATE materials_catalog SET
  item_name = 'Roofing Nails 1-3/4" coil (30 lb box)',
  unit = 'box',
  coverage_value = 13,
  unit_cost = 62.00,
  notes = '≈2.3 lb per square → one 30-lb box per ~13 squares'
WHERE sku = 'NAIL-COIL-1';

UPDATE materials_catalog SET
  item_name = 'Ice & Water Shield (2-sq / 200 sf roll)',
  coverage_value = 200,
  unit_cost = 110.00,
  notes = '3 ft past eave wall + 3 ft each side of valleys; 200 sf per roll'
WHERE sku = 'IW-SHIELD-65';

UPDATE materials_catalog SET
  item_name = 'Ridge Cap Shingles (25 lf bundle)',
  coverage_value = 25,
  unit_cost = 70.00,
  notes = 'Ridges + hips; GAF Seal-A-Ridge class covers 25 lf/bundle (OC ProEdge covers 33 — adjust if that''s your line)'
WHERE sku = 'RIDGE-CAP-33';

UPDATE materials_catalog SET
  item_name = 'Architectural Shingles (30-yr, 3 bundles/sq)',
  unit_cost = 125.00,
  notes = '3 bundles per square; covers 100 sq ft. Order line is in squares — multiply by 3 for bundle count.'
WHERE sku = 'ARCH-SHG-30';

UPDATE materials_catalog SET
  item_name = 'Starter Strip Shingles (110 lf bundle)',
  unit = 'bundle',
  coverage_value = 110,
  unit_cost = 68.00,
  notes = 'Eaves + rakes; ~110 lf per bundle (GAF Pro-Start 120, OC Starter 105)'
WHERE sku = 'STARTER-100';

-- Ridge vent: 4-ft sections along RIDGES only (hips are capped, not vented).
INSERT INTO materials_catalog (sku, category, item_name, unit, coverage_basis, coverage_value, unit_cost, notes)
SELECT 'RIDGE-VENT-4', 'misc', 'Ridge Vent (4 ft section)', 'piece', 'per_lf_ridge_only', 4, 11.50,
       'Ridges only — never hips. Cut cap shingles nail over it.'
WHERE NOT EXISTS (SELECT 1 FROM materials_catalog WHERE sku = 'RIDGE-VENT-4');
