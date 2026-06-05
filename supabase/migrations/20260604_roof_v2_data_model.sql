-- ============================================================================
-- Axis Performance — Roof Measurement v2 Data Model
-- ============================================================================
-- Replaces the ad-hoc `roof_measurements` table (created on-the-fly by inserts)
-- with a formal multi-table model that supports per-facet polygons, labeled
-- edges, user-confirmed penetrations, a real materials catalog, and a manual
-- siding-measurement workflow.
--
-- Backwards compatibility: the old `roof_measurements` table is preserved as
-- `roof_measurements_legacy` (rename, no drop) so existing rows are not lost.
-- A view `roof_measurements` is provided over the new `roof_measurement_runs`
-- table with the same columns the legacy code reads, so the existing
-- `/roofing/{blueprint_id}/measure` flow keeps working while clients migrate.
--
-- All tables have RLS scoped through projects → profiles. No table is
-- world-readable.
-- ============================================================================

-- Convenience: lookup helper used by every RLS policy below.
CREATE OR REPLACE FUNCTION axis_project_owner(p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM projects WHERE id = p_project_id AND user_id = auth.uid()
  );
$$;


-- ----------------------------------------------------------------------------
-- 1. Materials catalog
-- ----------------------------------------------------------------------------
-- Replaces hard-coded prices in roofing_service.calculate_shingle_materials.
-- Region-scoped pricing supported via the `region` column (NULL = US-wide
-- default). The estimator picks the row whose region matches the project's
-- region, falling back to NULL.
--
-- `coverage_basis` is how the engine derives quantity:
--   per_square        — one unit per N roofing squares (e.g., underlayment roll)
--   per_lf            — one unit per N linear feet (e.g., starter strip box)
--   per_lf_perimeter  — one unit per N feet of (eaves + rakes)
--   per_lf_ridges     — one unit per N feet of (ridges + hips)
--   per_lf_valleys    — one unit per N feet of valley
--   per_eave_iwshield — special: (eaves_ft * 3) + (valleys_ft * 6) / coverage
--   per_unit          — quantity is supplied directly (e.g., penetrations)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS materials_catalog (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku             TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN (
                    'shingles', 'underlayment', 'ice_water_shield',
                    'starter_strip', 'ridge_cap', 'hip_cap',
                    'drip_edge', 'valley_metal',
                    'step_flashing', 'wall_flashing', 'counter_flashing', 'apron_flashing',
                    'nails', 'sealant', 'vent_boot', 'misc'
                  )),
  item_name       TEXT NOT NULL,
  manufacturer    TEXT,
  unit            TEXT NOT NULL,       -- 'square', 'bundle', 'roll', 'piece', 'box', 'lb'
  coverage_basis  TEXT NOT NULL CHECK (coverage_basis IN (
                    'per_square', 'per_lf', 'per_lf_perimeter',
                    'per_lf_ridges', 'per_lf_valleys', 'per_eave_iwshield',
                    'per_unit'
                  )),
  coverage_value  NUMERIC NOT NULL,    -- e.g., 100 sq ft per square, 33 lf per ridge cap bundle
  unit_cost       NUMERIC NOT NULL,    -- USD per unit; updateable by contractor
  region          TEXT,                -- NULL = US default; e.g., 'US-TX'
  notes           TEXT,
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (sku, region)
);

CREATE INDEX IF NOT EXISTS materials_catalog_category_idx ON materials_catalog (category, active);
CREATE INDEX IF NOT EXISTS materials_catalog_region_idx ON materials_catalog (region, active);

-- Catalog is read-only for authenticated users; admin maintains via service role.
ALTER TABLE materials_catalog ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read materials catalog"
  ON materials_catalog FOR SELECT TO authenticated USING (active = TRUE);

-- Seed with industry-standard items. Unit costs are US-average snapshots and
-- are contractor-overridable. Coverage values are from manufacturer specs
-- (CertainTeed, GAF, Owens Corning architectural shingle standards).
INSERT INTO materials_catalog (sku, category, item_name, unit, coverage_basis, coverage_value, unit_cost, notes) VALUES
  ('ARCH-SHG-30',  'shingles',          'Architectural Shingles (30-yr)',     'square', 'per_square',         1,   110.00, '3 bundles per square; covers 100 sq ft'),
  ('SYN-UND-10',   'underlayment',      'Synthetic Underlayment (10-sq roll)', 'roll',   'per_square',         10,   55.00, '1 roll per 10 roofing squares'),
  ('FELT15-4SQ',   'underlayment',      'Roofing Felt 15# (4-sq roll)',        'roll',   'per_square',         4,    22.00, 'Optional secondary; 4 sq per roll'),
  ('IW-SHIELD-65', 'ice_water_shield',  'Ice & Water Shield (65 sf roll)',     'roll',   'per_eave_iwshield',  65,   95.00, '3 ft past eave wall; 3 ft each side of valleys'),
  ('STARTER-100',  'starter_strip',     'Starter Strip Shingles (100 lf box)', 'box',    'per_lf_perimeter',   100,  75.00, 'Eaves + rakes; 100 lf per box'),
  ('RIDGE-CAP-33', 'ridge_cap',         'Ridge Cap Shingles (33 lf bundle)',   'bundle', 'per_lf_ridges',      33,   65.00, 'Ridges + hips; 33 lf per bundle'),
  ('DRIP-EDGE-10', 'drip_edge',         'Drip Edge (10 ft stick)',             'piece',  'per_lf_perimeter',   10,    8.50, 'Eaves first, rakes over underlayment'),
  ('VALLEY-50',    'valley_metal',      'Valley Metal Coil (50 lf roll)',      'roll',   'per_lf_valleys',     50,   85.00, '50 lf per roll'),
  ('STEP-FL-100',  'step_flashing',     'Step Flashing (100/box, 4x5)',        'box',    'per_lf',             100,  42.00, 'Wall intersections; 1 piece per 5 in of run'),
  ('NAIL-COIL-1',  'nails',             'Roofing Nails 1-3/4" coil (lb)',      'lb',     'per_square',         1,     3.50, '~1 lb per square'),
  ('SEAL-TUBE',    'sealant',           'Roof Sealant (10 oz tube)',           'tube',   'per_square',         5,     7.50, '1 tube per 5 squares for penetrations / valleys'),
  ('VENT-BOOT-3',  'vent_boot',         'Pipe Vent Flashing Boot (3"/4")',     'piece',  'per_unit',           1,    18.00, 'One per plumbing vent penetration')
ON CONFLICT (sku, region) DO NOTHING;


-- ----------------------------------------------------------------------------
-- 2. Roof measurement runs (replaces ad-hoc roof_measurements)
-- ----------------------------------------------------------------------------
-- One row per measurement attempt for a project. Confirmed runs feed the
-- materials engine and PDF report.
--
-- Sources:
--   manual         — contractor entered everything by hand
--   blueprint      — extracted from uploaded blueprint via vision
--   aerial_solar   — Google Solar API
--   aerial_outline — user-traced facet polygons on satellite image (the new path)
--   photo          — ground-level photos contributed via /analyze-photos
--   hybrid         — multiple sources merged with user confirmation
--
-- `confidence` is normalized 0..1 across ALL sources.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS roof_measurement_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  blueprint_id        UUID REFERENCES blueprints(id) ON DELETE SET NULL,
  source              TEXT NOT NULL CHECK (source IN (
                        'manual', 'blueprint', 'aerial_solar', 'aerial_outline',
                        'photo', 'hybrid'
                      )),
  -- Whole-roof totals. NULL means "not yet computed / unverified".
  total_plan_sqft     NUMERIC,         -- footprint area as seen from above
  total_roof_sqft     NUMERIC,         -- slope-adjusted (true) area for ordering
  squares             NUMERIC,         -- total_roof_sqft / 100
  predominant_pitch   TEXT,            -- e.g., "6/12"
  predominant_pitch_degrees NUMERIC,
  facet_count         INTEGER DEFAULT 0,
  -- Linear footage totals (whole roof, all summed from edges table)
  ridges_ft           NUMERIC DEFAULT 0,
  hips_ft             NUMERIC DEFAULT 0,
  valleys_ft          NUMERIC DEFAULT 0,
  eaves_ft            NUMERIC DEFAULT 0,
  rakes_ft            NUMERIC DEFAULT 0,
  -- Computed convenience (for materials engine)
  perimeter_ft        NUMERIC,         -- eaves + rakes
  ridge_total_ft      NUMERIC,         -- ridges + hips (where ridge cap goes)
  complexity_score    NUMERIC,         -- 0..1, deterministic from facet/valley count + pitch variance
  -- Source metadata
  waste_pct_default   NUMERIC DEFAULT 12,
  stories             INTEGER DEFAULT 1,
  roof_type           TEXT DEFAULT 'unknown',
  -- Imagery
  satellite_image_url TEXT,
  satellite_provider  TEXT,
  satellite_zoom      INTEGER,
  satellite_lat       NUMERIC,
  satellite_lng       NUMERIC,
  imagery_health      NUMERIC,         -- 0..1, from imagery_service.score
  -- Quality
  confidence          NUMERIC DEFAULT 0,   -- 0..1, normalized
  measurement_unverified BOOLEAN DEFAULT TRUE,
  confirmed           BOOLEAN DEFAULT FALSE,
  confirmed_at        TIMESTAMPTZ,
  notes               TEXT,
  warnings            JSONB DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rmr_project_idx ON roof_measurement_runs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rmr_blueprint_idx ON roof_measurement_runs (blueprint_id);
CREATE INDEX IF NOT EXISTS rmr_confirmed_idx ON roof_measurement_runs (project_id, confirmed);

ALTER TABLE roof_measurement_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can CRUD their roof measurement runs"
  ON roof_measurement_runs FOR ALL
  USING (axis_project_owner(project_id))
  WITH CHECK (axis_project_owner(project_id));


-- ----------------------------------------------------------------------------
-- 3. Roof facets (per-plane polygons)
-- ----------------------------------------------------------------------------
-- Each facet is one roof plane. Polygon stored in image-fraction coordinates
-- (resolution-independent, matches current RoofOutlineEditor convention).
-- plan_area_sqft = shoelace area of polygon × pixel² × ft/px² (deterministic).
-- true_area_sqft = plan_area_sqft / cos(pitch_angle_radians).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS roof_facets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              UUID NOT NULL REFERENCES roof_measurement_runs(id) ON DELETE CASCADE,
  facet_label         TEXT NOT NULL,                -- 'A', 'B', 'C' or 'Front', 'Rear', etc.
  polygon             JSONB NOT NULL,                -- [[x,y],...] in image fractions (NOT lat/lng)
  pitch               TEXT NOT NULL DEFAULT '6/12',  -- 'X/12' canonical
  pitch_degrees       NUMERIC NOT NULL DEFAULT 26.57,
  orientation_deg     NUMERIC,                       -- 0..360 (north = 0); from polygon's longest ridge edge
  slope_direction     TEXT,                          -- 'N', 'NE', 'E', ... (derived from orientation_deg)
  plan_area_sqft      NUMERIC NOT NULL DEFAULT 0,
  true_area_sqft      NUMERIC NOT NULL DEFAULT 0,
  confidence          NUMERIC DEFAULT 0.7,
  user_confirmed      BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (run_id, facet_label)
);

CREATE INDEX IF NOT EXISTS roof_facets_run_idx ON roof_facets (run_id);

ALTER TABLE roof_facets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can CRUD facets via run ownership"
  ON roof_facets FOR ALL
  USING (run_id IN (
    SELECT id FROM roof_measurement_runs WHERE axis_project_owner(project_id)
  ))
  WITH CHECK (run_id IN (
    SELECT id FROM roof_measurement_runs WHERE axis_project_owner(project_id)
  ));


-- ----------------------------------------------------------------------------
-- 4. Roof edges (labeled polygon edges)
-- ----------------------------------------------------------------------------
-- Each edge of a facet polygon is labeled by the user (or auto-suggested by
-- shared-edge analysis) as one of: eave, rake, ridge, hip, valley, gable_end,
-- or unlabeled. Length is computed deterministically from the polygon vertex
-- positions + lat + zoom.
--
-- For sloped edges (rake/hip/valley) we ALSO store slope_adjusted_ft, which
-- is the true 3D length along the roof surface: plan_length × √(1 + (rise/run)²).
-- This is what contractors actually order material against.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS roof_edges (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facet_id            UUID NOT NULL REFERENCES roof_facets(id) ON DELETE CASCADE,
  vertex_index_start  INTEGER NOT NULL,             -- which vertex this edge starts at
  vertex_index_end    INTEGER NOT NULL,             -- (start+1) % vertex_count usually
  edge_type           TEXT NOT NULL CHECK (edge_type IN (
                        'eave', 'rake', 'ridge', 'hip', 'valley',
                        'gable_end', 'wall_intersection', 'unlabeled'
                      )) DEFAULT 'unlabeled',
  plan_length_ft      NUMERIC NOT NULL DEFAULT 0,
  slope_adjusted_ft   NUMERIC NOT NULL DEFAULT 0,
  shared_with_facet   UUID REFERENCES roof_facets(id) ON DELETE SET NULL,
                                                    -- if this edge is shared with another facet (ridge/hip/valley)
  user_confirmed      BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS roof_edges_facet_idx ON roof_edges (facet_id);
CREATE INDEX IF NOT EXISTS roof_edges_type_idx ON roof_edges (edge_type);

ALTER TABLE roof_edges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can CRUD edges via facet ownership"
  ON roof_edges FOR ALL
  USING (facet_id IN (
    SELECT f.id FROM roof_facets f
    JOIN roof_measurement_runs r ON f.run_id = r.id
    WHERE axis_project_owner(r.project_id)
  ))
  WITH CHECK (facet_id IN (
    SELECT f.id FROM roof_facets f
    JOIN roof_measurement_runs r ON f.run_id = r.id
    WHERE axis_project_owner(r.project_id)
  ));


-- ----------------------------------------------------------------------------
-- 5. Roof penetrations (user-confirmed only)
-- ----------------------------------------------------------------------------
-- AI MAY suggest these (vision spotter) but every penetration in this table is
-- USER-CONFIRMED. The materials engine uses these for vent boots, pipe
-- flashing, etc. — only after the contractor has verified them.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS roof_penetrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES roof_measurement_runs(id) ON DELETE CASCADE,
  facet_id        UUID REFERENCES roof_facets(id) ON DELETE SET NULL,
  type            TEXT NOT NULL CHECK (type IN (
                    'plumbing_vent', 'exhaust_vent', 'ridge_vent', 'box_vent',
                    'turbine_vent', 'chimney', 'skylight', 'satellite_dish',
                    'solar_panel', 'hvac_unit', 'other'
                  )),
  count           INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  -- Position in image fraction coords (for display only)
  pos_x_frac      NUMERIC,
  pos_y_frac      NUMERIC,
  -- Approx dimensions in inches (user-entered or default for type)
  width_in        NUMERIC,
  height_in       NUMERIC,
  ai_suggested    BOOLEAN DEFAULT FALSE,    -- did vision spot this?
  user_confirmed  BOOLEAN NOT NULL DEFAULT FALSE,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS roof_penetrations_run_idx ON roof_penetrations (run_id);
CREATE INDEX IF NOT EXISTS roof_penetrations_confirmed_idx ON roof_penetrations (run_id, user_confirmed);

ALTER TABLE roof_penetrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can CRUD penetrations via run ownership"
  ON roof_penetrations FOR ALL
  USING (run_id IN (
    SELECT id FROM roof_measurement_runs WHERE axis_project_owner(project_id)
  ))
  WITH CHECK (run_id IN (
    SELECT id FROM roof_measurement_runs WHERE axis_project_owner(project_id)
  ));


-- ----------------------------------------------------------------------------
-- 6. Manual siding measurements (Phase-1 placeholder)
-- ----------------------------------------------------------------------------
-- True siding area cannot be measured from top-down satellite. Until oblique
-- imagery is integrated (EagleView/Nearmap connector), contractors trace
-- siding regions on ground-level elevation photos using a known reference
-- scale (standard door = 80 in, garage door = 84 in).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS manual_siding_measurements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  elevation           TEXT NOT NULL CHECK (elevation IN ('front', 'rear', 'left', 'right', 'other')),
  photo_url           TEXT,
  reference_object    TEXT CHECK (reference_object IN ('standard_door_80', 'garage_door_84', 'window_36', 'custom')),
  reference_height_in NUMERIC,                       -- e.g., 80 for standard door
  reference_pixel_h   NUMERIC,                       -- pixels the reference spans in the photo
  scale_in_per_px     NUMERIC,                       -- derived: reference_height_in / reference_pixel_h
  region_polygon      JSONB NOT NULL,                -- user-traced [[x,y],...] in image fractions
  area_sqft           NUMERIC NOT NULL DEFAULT 0,
  material_type       TEXT,                          -- 'vinyl', 'fiber_cement', 'brick', 'wood', etc.
  notes               TEXT,
  contractor_entered  BOOLEAN DEFAULT TRUE,          -- always true; reminder this is not auto-measured
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS manual_siding_project_idx ON manual_siding_measurements (project_id);

ALTER TABLE manual_siding_measurements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can CRUD their siding measurements"
  ON manual_siding_measurements FOR ALL
  USING (axis_project_owner(project_id))
  WITH CHECK (axis_project_owner(project_id));


-- ----------------------------------------------------------------------------
-- 7. County stored on projects (replaces unreliable static list)
-- ----------------------------------------------------------------------------
-- County now sourced server-side from US Census Geocoder /geographies endpoint
-- (authoritative FIPS) instead of a manually maintained dropdown. We store
-- the county name, FIPS, and the geocoded coordinates so the report can
-- reproduce the lookup deterministically.
-- ----------------------------------------------------------------------------

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS county           TEXT,
  ADD COLUMN IF NOT EXISTS county_fips      TEXT,
  ADD COLUMN IF NOT EXISTS state_fips       TEXT,
  ADD COLUMN IF NOT EXISTS geocoded_lat     NUMERIC,
  ADD COLUMN IF NOT EXISTS geocoded_lng     NUMERIC,
  ADD COLUMN IF NOT EXISTS geocode_source   TEXT;        -- 'census', 'fcc', 'manual', 'google'


-- ----------------------------------------------------------------------------
-- 8. Legacy compatibility view
-- ----------------------------------------------------------------------------
-- The existing roofing.py code reads/writes a `roof_measurements` table with
-- specific column names. To preserve that flow during migration, expose the
-- new `roof_measurement_runs` table through a view with the legacy column
-- names. Writes to it route to the new table via an INSTEAD OF trigger.
--
-- This view is intentionally read-mostly: writes from the existing
-- /roofing/{blueprint_id}/measure and /confirm endpoints continue to work,
-- but new features should target /v2 endpoints directly.
-- ----------------------------------------------------------------------------

-- The legacy `roof_measurements` may exist as a TABLE (created on-the-fly by
-- the old code path) rather than a view. If so, rename it so its rows survive
-- and the name is free for the new view. Idempotent: skips if already renamed
-- or if it's already the view shape.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'roof_measurements'
      AND table_type = 'BASE TABLE'
  ) THEN
    EXECUTE 'ALTER TABLE roof_measurements RENAME TO roof_measurements_legacy';
  END IF;
END $$;

-- Drop any leftover view so we can recreate cleanly.
DROP VIEW IF EXISTS roof_measurements CASCADE;

CREATE VIEW roof_measurements AS
SELECT
  r.id,
  r.blueprint_id,
  r.project_id,
  COALESCE(r.total_roof_sqft, r.total_plan_sqft, 0)         AS total_sqft,
  COALESCE(r.predominant_pitch, 'Unknown')                  AS pitch,
  COALESCE(r.facet_count, 0)                                AS facets,
  COALESCE(r.ridges_ft, 0)                                  AS ridges_ft,
  COALESCE(r.valleys_ft, 0)                                 AS valleys_ft,
  COALESCE(r.eaves_ft, 0)                                   AS eaves_ft,
  COALESCE(r.rakes_ft, 0)                                   AS rakes_ft,
  COALESCE(r.waste_pct_default, 12)                         AS waste_pct,
  COALESCE(r.roof_type, 'unknown')                          AS roof_type,
  COALESCE(r.stories, 1)                                    AS stories,
  -- Legacy code uses 0-100 integer confidence. Map 0..1 → 0..100.
  COALESCE(ROUND(r.confidence * 100)::int, 0)               AS confidence,
  COALESCE(r.notes, '')                                     AS notes,
  COALESCE(r.confirmed, FALSE)                              AS confirmed,
  r.created_at
FROM roof_measurement_runs r;


-- INSTEAD OF triggers translate legacy writes into the new schema.
CREATE OR REPLACE FUNCTION roof_measurements_insert_trigger()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO roof_measurement_runs (
    id, blueprint_id, project_id, source,
    total_roof_sqft, predominant_pitch, facet_count,
    ridges_ft, valleys_ft, eaves_ft, rakes_ft,
    waste_pct_default, roof_type, stories,
    confidence, notes, confirmed, measurement_unverified
  ) VALUES (
    COALESCE(NEW.id, gen_random_uuid()),
    NEW.blueprint_id,
    NEW.project_id,
    'blueprint',                                    -- legacy path = blueprint vision
    NEW.total_sqft,
    NEW.pitch,
    NEW.facets,
    NEW.ridges_ft, NEW.valleys_ft, NEW.eaves_ft, NEW.rakes_ft,
    NEW.waste_pct, NEW.roof_type, NEW.stories,
    CASE WHEN NEW.confidence > 1 THEN NEW.confidence / 100.0 ELSE NEW.confidence END,
    NEW.notes,
    COALESCE(NEW.confirmed, FALSE),
    NEW.total_sqft IS NULL OR NEW.total_sqft = 0
  ) RETURNING id INTO v_id;
  NEW.id := v_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER roof_measurements_instead_of_insert
  INSTEAD OF INSERT ON roof_measurements
  FOR EACH ROW EXECUTE FUNCTION roof_measurements_insert_trigger();


CREATE OR REPLACE FUNCTION roof_measurements_update_trigger()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE roof_measurement_runs SET
    total_roof_sqft        = NEW.total_sqft,
    predominant_pitch      = NEW.pitch,
    facet_count            = NEW.facets,
    ridges_ft              = NEW.ridges_ft,
    valleys_ft             = NEW.valleys_ft,
    eaves_ft               = NEW.eaves_ft,
    rakes_ft               = NEW.rakes_ft,
    waste_pct_default      = NEW.waste_pct,
    roof_type              = NEW.roof_type,
    stories                = NEW.stories,
    confidence             = CASE WHEN NEW.confidence > 1 THEN NEW.confidence / 100.0 ELSE NEW.confidence END,
    notes                  = NEW.notes,
    confirmed              = NEW.confirmed,
    confirmed_at           = CASE WHEN NEW.confirmed AND NOT OLD.confirmed THEN NOW() ELSE confirmed_at END,
    updated_at             = NOW()
  WHERE id = OLD.id OR (OLD.id IS NULL AND blueprint_id = NEW.blueprint_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER roof_measurements_instead_of_update
  INSTEAD OF UPDATE ON roof_measurements
  FOR EACH ROW EXECUTE FUNCTION roof_measurements_update_trigger();


CREATE OR REPLACE FUNCTION roof_measurements_delete_trigger()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM roof_measurement_runs WHERE id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER roof_measurements_instead_of_delete
  INSTEAD OF DELETE ON roof_measurements
  FOR EACH ROW EXECUTE FUNCTION roof_measurements_delete_trigger();


-- ----------------------------------------------------------------------------
-- 9. Update timestamps trigger (shared)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION axis_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rmr_touch_updated ON roof_measurement_runs;
CREATE TRIGGER rmr_touch_updated BEFORE UPDATE ON roof_measurement_runs
  FOR EACH ROW EXECUTE FUNCTION axis_touch_updated_at();

DROP TRIGGER IF EXISTS facets_touch_updated ON roof_facets;
CREATE TRIGGER facets_touch_updated BEFORE UPDATE ON roof_facets
  FOR EACH ROW EXECUTE FUNCTION axis_touch_updated_at();

DROP TRIGGER IF EXISTS edges_touch_updated ON roof_edges;
CREATE TRIGGER edges_touch_updated BEFORE UPDATE ON roof_edges
  FOR EACH ROW EXECUTE FUNCTION axis_touch_updated_at();

DROP TRIGGER IF EXISTS siding_touch_updated ON manual_siding_measurements;
CREATE TRIGGER siding_touch_updated BEFORE UPDATE ON manual_siding_measurements
  FOR EACH ROW EXECUTE FUNCTION axis_touch_updated_at();

DROP TRIGGER IF EXISTS catalog_touch_updated ON materials_catalog;
CREATE TRIGGER catalog_touch_updated BEFORE UPDATE ON materials_catalog
  FOR EACH ROW EXECUTE FUNCTION axis_touch_updated_at();
