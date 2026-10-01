-- Make apron flashing and kick-outs orderable (2026-10-01).
--
-- 20260619_flashing_material_skus.sql wrote these items but was never run, so
-- the flashing engine's apron flashing (level roof-to-wall) and kick-outs never
-- reached a material order: Brookside Oaks needed 33 ft of apron and 9
-- kick-outs and the order had neither. This is that migration, with one change:
-- COUNTER flashing is added switched OFF. It is only needed against brick,
-- stone or stucco; against siding the siding laps the step flashing, and
-- ordering it on every roof added ~$200 a job for nothing.
--
-- Safe to run more than once.

-- 1. Allow the flashing categories.
ALTER TABLE materials_catalog DROP CONSTRAINT IF EXISTS materials_catalog_category_check;
ALTER TABLE materials_catalog ADD CONSTRAINT materials_catalog_category_check CHECK (
  category IN (
    'shingles','underlayment','ice_water_shield','starter_strip','ridge_cap','hip_cap',
    'drip_edge','valley_metal','step_flashing','wall_flashing','counter_flashing',
    'apron_flashing','kickout_flashing','chimney_flashing_kit','skylight_flashing_kit',
    'cricket','nails','sealant','vent_boot','misc'
  )
);

-- 2. The items. Prices are US-average placeholders; a contractor's own price
--    book overrides them. coverage_value on linear items = feet per piece.
INSERT INTO materials_catalog (sku, item_name, category, unit, coverage_basis, coverage_value, unit_cost, region, notes, active)
SELECT v.sku, v.item_name, v.category, v.unit, v.coverage_basis, v.coverage_value, v.unit_cost, 'default', v.notes, v.active
FROM (VALUES
  ('FL-APRON-10',    'Apron / headwall flashing (10'' piece)', 'apron_flashing',        'piece', 'per_unit', 10, 16.00, 'Level roof-to-wall line', true),
  ('FL-KICKOUT',     'Kickout (diverter) flashing',           'kickout_flashing',      'each',  'per_unit', 1,   8.50, 'Base of each roof-to-wall run; keeps water off the siding', true),
  ('FL-CHIM-KIT',    'Chimney flashing kit',                  'chimney_flashing_kit',  'kit',   'per_unit', 1,  62.00, 'Only when a chimney is confirmed', true),
  ('FL-SKY-KIT',     'Skylight flashing kit',                 'skylight_flashing_kit', 'kit',   'per_unit', 1,  48.00, 'Only when a skylight is confirmed', true),
  ('FL-CRICKET',     'Chimney cricket / saddle',              'cricket',               'each',  'per_unit', 1,  85.00, 'Behind chimneys wider than 30 in', true),
  ('FL-COUNTER-10',  'Counter flashing (10'' piece)',         'counter_flashing',      'piece', 'per_unit', 10, 19.00, 'Masonry/stucco walls only - off by default', false)
) AS v(sku, item_name, category, unit, coverage_basis, coverage_value, unit_cost, notes, active)
WHERE NOT EXISTS (SELECT 1 FROM materials_catalog mc WHERE mc.sku = v.sku);

-- 3. One row per item from now on. The starter catalog had been loaded twice
--    (every item listed twice; cleaned up 2026-10-01).
CREATE UNIQUE INDEX IF NOT EXISTS materials_catalog_sku_region_uniq
  ON materials_catalog (sku, COALESCE(region, ''));
