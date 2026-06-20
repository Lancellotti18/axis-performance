-- Flashing material SKUs — makes the deterministic flashing engine's output
-- (counter / apron / kickout / chimney kit / skylight kit / cricket) orderable
-- with catalog pricing. Quantities come from flashing_engine; the catalog only
-- supplies SKU + unit + price (see materials_engine.compute_flashing_material_lines).
--
-- Apply in the Supabase SQL editor. Safe to re-run (guards + WHERE NOT EXISTS).

-- 1. Allow the new flashing categories on materials_catalog.category.
--    (counter_flashing + apron_flashing were already permitted.)
ALTER TABLE materials_catalog DROP CONSTRAINT IF EXISTS materials_catalog_category_check;
ALTER TABLE materials_catalog ADD CONSTRAINT materials_catalog_category_check CHECK (
  category IN (
    'shingles','underlayment','ice_water_shield','starter_strip','ridge_cap','hip_cap',
    'drip_edge','valley_metal','step_flashing','wall_flashing','counter_flashing',
    'apron_flashing','kickout_flashing','chimney_flashing_kit','skylight_flashing_kit',
    'cricket','nails','sealant','vent_boot','misc'
  )
);

-- 2. Seed the flashing SKUs (idempotent — only inserts rows whose SKU is absent).
--    coverage_value on linear items = linear feet per piece; count items use 1.
--    unit_cost values are reasonable national-average placeholders the
--    contractor can edit per region.
INSERT INTO materials_catalog (sku, item_name, category, unit, coverage_basis, coverage_value, unit_cost, region, notes, active)
SELECT v.sku, v.item_name, v.category, v.unit, v.coverage_basis, v.coverage_value, v.unit_cost, 'default', v.notes, true
FROM (VALUES
  ('FL-COUNTER-10',  'Counter flashing (10'' piece)',        'counter_flashing',      'piece', 'per_unit', 10, 19.00, 'Caps step/apron; set into masonry or reglet'),
  ('FL-APRON-10',    'Apron / headwall flashing (10'' piece)','apron_flashing',        'piece', 'per_unit', 10, 16.00, 'Continuous flashing at horizontal roof-to-wall'),
  ('FL-KICKOUT',     'Kickout (diverter) flashing',          'kickout_flashing',      'each',  'per_unit', 1,   8.50, 'Diverts water off wall at base of roof-to-wall run'),
  ('FL-CHIM-KIT',    'Chimney flashing kit',                 'chimney_flashing_kit',  'kit',   'per_unit', 1,  62.00, 'Apron + step sides + back/cricket base'),
  ('FL-SKY-KIT',     'Skylight flashing kit',                'skylight_flashing_kit', 'kit',   'per_unit', 1,  48.00, 'Head + sill + step side flashing'),
  ('FL-CRICKET',     'Chimney cricket / saddle',             'cricket',               'each',  'per_unit', 1,  85.00, 'Code-required behind chimneys wider than 30"')
) AS v(sku, item_name, category, unit, coverage_basis, coverage_value, unit_cost, notes)
WHERE NOT EXISTS (SELECT 1 FROM materials_catalog mc WHERE mc.sku = v.sku);
