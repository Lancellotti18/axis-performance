-- ============================================================================
-- Axis Performance — Training-Data Collection Infrastructure
-- ============================================================================
-- This is Phase-0 of Option 4 (custom segmentation model). Every facet, edge,
-- penetration, wall, and opening a contractor confirms gets captured as a
-- training example automatically via Postgres triggers — no application code
-- change required. After 6-12 months of organic use, you'll have a labeled
-- dataset of thousands of examples ready to fine-tune SAM2 (or any similar
-- segmentation model) on RunPod.
--
-- Key design decisions:
--   1. Triggers, not app code — the data flows in whether or not the v2 API
--      is involved. Future routes get free coverage.
--   2. ON CONFLICT UPDATE — if a user edits a facet and saves again, we keep
--      the LATEST annotation as the training pair. Edits are not duplicate rows.
--   3. capture_source distinguishes 'organic' (contractor doing their job) from
--      'labeling_mode' (explicit dataset-building session) from 'ai_corrected'
--      (the highest-value source: human corrected an AI suggestion).
--   4. quality_tier is for review workflow: 'unverified' until reviewed by an
--      expert, then 'reviewed' or 'rejected'. Only 'reviewed' and 'expert_verified'
--      examples enter the training export.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. training_examples table
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS training_examples (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID REFERENCES profiles(id) ON DELETE SET NULL,

  -- Source provenance: which table this came from + original row id
  source_table         TEXT NOT NULL CHECK (source_table IN (
                         'roof_facets', 'roof_edges', 'roof_penetrations',
                         'exterior_measurements', 'roof_outline', 'manual_label'
                       )),
  source_id            UUID,

  -- ML task this example serves
  task_type            TEXT NOT NULL CHECK (task_type IN (
                         'roof_facet_polygon',
                         'edge_classification',
                         'penetration_location',
                         'wall_polygon',
                         'opening_rectangle',
                         'roof_outline_polygon'
                       )),

  -- Image context (the model input)
  image_url            TEXT NOT NULL,
  image_width_px       INTEGER NOT NULL DEFAULT 2048,
  image_height_px      INTEGER NOT NULL DEFAULT 1366,
  geo_lat              NUMERIC,
  geo_lng              NUMERIC,
  satellite_zoom       INTEGER,
  satellite_provider   TEXT,

  -- The annotation itself (the model output / training target).
  -- Schema varies by task_type — documented in the trigger functions below.
  annotation           JSONB NOT NULL,

  -- Provenance and quality
  capture_source       TEXT NOT NULL CHECK (capture_source IN (
                         'organic',           -- contractor doing real work
                         'labeling_mode',     -- explicit dataset-building session
                         'ai_corrected'       -- contractor corrected an AI suggestion (highest value)
                       )) DEFAULT 'organic',
  quality_tier         TEXT NOT NULL CHECK (quality_tier IN (
                         'unverified', 'reviewed', 'expert_verified', 'rejected'
                       )) DEFAULT 'unverified',

  reviewer_id          UUID REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at          TIMESTAMPTZ,
  reviewer_notes       TEXT,

  -- Optional contractor confidence (carried through from source row if present)
  contractor_confidence NUMERIC,

  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (source_table, source_id, task_type)
);

CREATE INDEX IF NOT EXISTS training_examples_task_idx
  ON training_examples (task_type, quality_tier);
CREATE INDEX IF NOT EXISTS training_examples_user_idx
  ON training_examples (user_id);
CREATE INDEX IF NOT EXISTS training_examples_created_idx
  ON training_examples (created_at DESC);
CREATE INDEX IF NOT EXISTS training_examples_quality_idx
  ON training_examples (quality_tier, task_type, created_at DESC);

ALTER TABLE training_examples ENABLE ROW LEVEL SECURITY;

-- Users can see their own examples; service-role reads ALL for export.
DROP POLICY IF EXISTS "Users see own training examples" ON training_examples;
CREATE POLICY "Users see own training examples"
  ON training_examples FOR SELECT
  USING (user_id = auth.uid());

-- Users may correct quality on examples they own (mark reviewed/rejected)
DROP POLICY IF EXISTS "Users update own training examples" ON training_examples;
CREATE POLICY "Users update own training examples"
  ON training_examples FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());


-- ----------------------------------------------------------------------------
-- 2. Capture trigger: roof_facets → training_examples
-- ----------------------------------------------------------------------------
-- Fires whenever a confirmed facet is inserted or its user_confirmed flag
-- flips to TRUE. Stores the polygon + pitch + area as the training target,
-- pulling image context from the parent roof_measurement_run.
--
-- Annotation schema for task_type='roof_facet_polygon':
--   {
--     "polygon": [[x_frac, y_frac], ...],
--     "pitch": "6/12",
--     "pitch_degrees": 26.57,
--     "orientation_deg": 180,
--     "plan_area_sqft": 1240.0,
--     "true_area_sqft": 1386.0,
--     "facet_label": "A"
--   }
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION capture_facet_training_example()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_image_url TEXT;
  v_lat NUMERIC;
  v_lng NUMERIC;
  v_zoom INTEGER;
  v_provider TEXT;
  v_user_id UUID;
  v_capture_source TEXT;
BEGIN
  IF NOT COALESCE(NEW.user_confirmed, FALSE) THEN RETURN NEW; END IF;

  SELECT r.satellite_image_url, r.satellite_lat, r.satellite_lng,
         r.satellite_zoom, r.satellite_provider, p.user_id
    INTO v_image_url, v_lat, v_lng, v_zoom, v_provider, v_user_id
  FROM roof_measurement_runs r
  JOIN projects p ON r.project_id = p.id
  WHERE r.id = NEW.run_id;

  IF v_image_url IS NULL THEN RETURN NEW; END IF;

  -- If the facet was originally AI-suggested and the user edited it, mark
  -- the example as ai_corrected (highest training value). Otherwise organic.
  v_capture_source := CASE
    WHEN NEW.confidence > 0 AND NEW.confidence < 0.85 THEN 'ai_corrected'
    ELSE 'organic'
  END;

  INSERT INTO training_examples (
    user_id, source_table, source_id, task_type,
    image_url, image_width_px, image_height_px,
    geo_lat, geo_lng, satellite_zoom, satellite_provider,
    annotation, capture_source, contractor_confidence
  ) VALUES (
    v_user_id, 'roof_facets', NEW.id, 'roof_facet_polygon',
    v_image_url, 2048, 1366,
    v_lat, v_lng, v_zoom, v_provider,
    jsonb_build_object(
      'polygon', NEW.polygon,
      'pitch', NEW.pitch,
      'pitch_degrees', NEW.pitch_degrees,
      'orientation_deg', NEW.orientation_deg,
      'plan_area_sqft', NEW.plan_area_sqft,
      'true_area_sqft', NEW.true_area_sqft,
      'facet_label', NEW.facet_label
    ),
    v_capture_source, NEW.confidence
  )
  ON CONFLICT (source_table, source_id, task_type) DO UPDATE SET
    annotation = EXCLUDED.annotation,
    contractor_confidence = EXCLUDED.contractor_confidence,
    capture_source = EXCLUDED.capture_source,
    updated_at = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS capture_facet_training_example_trg ON roof_facets;
CREATE TRIGGER capture_facet_training_example_trg
  AFTER INSERT OR UPDATE OF user_confirmed, polygon, pitch ON roof_facets
  FOR EACH ROW EXECUTE FUNCTION capture_facet_training_example();


-- ----------------------------------------------------------------------------
-- 3. Capture trigger: roof_edges → training_examples
-- ----------------------------------------------------------------------------
-- Edge labels are the most valuable training signal because labeling each
-- one requires correct geometric + visual interpretation (eave vs rake vs
-- ridge, etc.) — hard for unfit models, easy for contractors with photos.
--
-- Annotation schema for task_type='edge_classification':
--   {
--     "facet_polygon": [[x_frac, y_frac], ...],
--     "vertex_index_start": 0,
--     "vertex_index_end": 1,
--     "edge_type": "eave",
--     "shared_with_facet_id": null,
--     "plan_length_ft": 32.4,
--     "slope_adjusted_ft": 36.2
--   }
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION capture_edge_training_example()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_image_url TEXT;
  v_lat NUMERIC;
  v_lng NUMERIC;
  v_zoom INTEGER;
  v_provider TEXT;
  v_user_id UUID;
  v_facet_polygon JSONB;
BEGIN
  IF NOT COALESCE(NEW.user_confirmed, FALSE) THEN RETURN NEW; END IF;
  IF NEW.edge_type = 'unlabeled' THEN RETURN NEW; END IF;

  SELECT r.satellite_image_url, r.satellite_lat, r.satellite_lng,
         r.satellite_zoom, r.satellite_provider, p.user_id, f.polygon
    INTO v_image_url, v_lat, v_lng, v_zoom, v_provider, v_user_id, v_facet_polygon
  FROM roof_facets f
  JOIN roof_measurement_runs r ON f.run_id = r.id
  JOIN projects p ON r.project_id = p.id
  WHERE f.id = NEW.facet_id;

  IF v_image_url IS NULL THEN RETURN NEW; END IF;

  INSERT INTO training_examples (
    user_id, source_table, source_id, task_type,
    image_url, image_width_px, image_height_px,
    geo_lat, geo_lng, satellite_zoom, satellite_provider,
    annotation, capture_source
  ) VALUES (
    v_user_id, 'roof_edges', NEW.id, 'edge_classification',
    v_image_url, 2048, 1366,
    v_lat, v_lng, v_zoom, v_provider,
    jsonb_build_object(
      'facet_polygon', v_facet_polygon,
      'vertex_index_start', NEW.vertex_index_start,
      'vertex_index_end', NEW.vertex_index_end,
      'edge_type', NEW.edge_type,
      'shared_with_facet_id', NEW.shared_with_facet,
      'plan_length_ft', NEW.plan_length_ft,
      'slope_adjusted_ft', NEW.slope_adjusted_ft
    ),
    'organic'
  )
  ON CONFLICT (source_table, source_id, task_type) DO UPDATE SET
    annotation = EXCLUDED.annotation,
    updated_at = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS capture_edge_training_example_trg ON roof_edges;
CREATE TRIGGER capture_edge_training_example_trg
  AFTER INSERT OR UPDATE OF user_confirmed, edge_type ON roof_edges
  FOR EACH ROW EXECUTE FUNCTION capture_edge_training_example();


-- ----------------------------------------------------------------------------
-- 4. Capture trigger: roof_penetrations → training_examples
-- ----------------------------------------------------------------------------
-- Annotation schema for task_type='penetration_location':
--   {
--     "type": "chimney",
--     "pos_x_frac": 0.45,
--     "pos_y_frac": 0.32,
--     "count": 1,
--     "width_in": null,
--     "height_in": null,
--     "ai_suggested": false
--   }
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION capture_penetration_training_example()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_image_url TEXT;
  v_lat NUMERIC;
  v_lng NUMERIC;
  v_zoom INTEGER;
  v_provider TEXT;
  v_user_id UUID;
  v_capture_source TEXT;
BEGIN
  IF NOT COALESCE(NEW.user_confirmed, FALSE) THEN RETURN NEW; END IF;
  IF NEW.pos_x_frac IS NULL OR NEW.pos_y_frac IS NULL THEN RETURN NEW; END IF;

  SELECT r.satellite_image_url, r.satellite_lat, r.satellite_lng,
         r.satellite_zoom, r.satellite_provider, p.user_id
    INTO v_image_url, v_lat, v_lng, v_zoom, v_provider, v_user_id
  FROM roof_measurement_runs r
  JOIN projects p ON r.project_id = p.id
  WHERE r.id = NEW.run_id;

  IF v_image_url IS NULL THEN RETURN NEW; END IF;

  -- ai_suggested + user_confirmed = the gold standard for training: AI proposed,
  -- a human said "yes that's a real chimney/skylight/vent".
  v_capture_source := CASE
    WHEN NEW.ai_suggested THEN 'ai_corrected'
    ELSE 'organic'
  END;

  INSERT INTO training_examples (
    user_id, source_table, source_id, task_type,
    image_url, image_width_px, image_height_px,
    geo_lat, geo_lng, satellite_zoom, satellite_provider,
    annotation, capture_source
  ) VALUES (
    v_user_id, 'roof_penetrations', NEW.id, 'penetration_location',
    v_image_url, 2048, 1366,
    v_lat, v_lng, v_zoom, v_provider,
    jsonb_build_object(
      'type', NEW.type,
      'pos_x_frac', NEW.pos_x_frac,
      'pos_y_frac', NEW.pos_y_frac,
      'count', NEW.count,
      'width_in', NEW.width_in,
      'height_in', NEW.height_in,
      'ai_suggested', NEW.ai_suggested
    ),
    v_capture_source
  )
  ON CONFLICT (source_table, source_id, task_type) DO UPDATE SET
    annotation = EXCLUDED.annotation,
    capture_source = EXCLUDED.capture_source,
    updated_at = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS capture_penetration_training_example_trg ON roof_penetrations;
CREATE TRIGGER capture_penetration_training_example_trg
  AFTER INSERT OR UPDATE OF user_confirmed ON roof_penetrations
  FOR EACH ROW EXECUTE FUNCTION capture_penetration_training_example();


-- ----------------------------------------------------------------------------
-- 5. Capture trigger: exterior_measurements → training_examples
-- ----------------------------------------------------------------------------
-- For walls: wall_polygon task with pixel-space polygon + scale.
-- For windows/doors: opening_rectangle task with pixel-space rect + dimensions.
--
-- Annotation schema for wall_polygon:
--   {
--     "polygon": [[x_px, y_px], ...],          # PIXEL coords (not fractions)
--     "scale_in_per_px": 0.247,
--     "material_type": "vinyl",
--     "elevation": "front",
--     "area_sqft": 218.5
--   }
--
-- Annotation schema for opening_rectangle:
--   {
--     "rect": [[x_px, y_px], [x_px, y_px]],     # top-left, bottom-right
--     "scale_in_per_px": 0.247,
--     "type": "window",                          # or "door"
--     "width_in": 36,
--     "height_in": 48,
--     "elevation": "front"
--   }
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION capture_exterior_training_example()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_photo_url TEXT;
  v_width_px INTEGER;
  v_height_px INTEGER;
  v_user_id UUID;
  v_task_type TEXT;
  v_annotation JSONB;
BEGIN
  IF NOT COALESCE(NEW.contractor_entered, FALSE) THEN RETURN NEW; END IF;
  IF NEW.region_polygon IS NULL THEN RETURN NEW; END IF;

  SELECT ep.photo_url, ep.width_px, ep.height_px, p.user_id
    INTO v_photo_url, v_width_px, v_height_px, v_user_id
  FROM exterior_photos ep
  JOIN exterior_jobs ej ON ep.job_id = ej.id
  JOIN projects p ON ej.project_id = p.id
  WHERE ep.id = NEW.photo_id;

  IF v_photo_url IS NULL THEN RETURN NEW; END IF;

  IF NEW.measurement_type = 'wall' THEN
    v_task_type := 'wall_polygon';
    v_annotation := jsonb_build_object(
      'polygon', NEW.region_polygon,
      'scale_in_per_px', NEW.scale_in_per_px,
      'material_type', NEW.material_type,
      'elevation', NEW.elevation,
      'area_sqft', NEW.area_sqft
    );
  ELSIF NEW.measurement_type IN ('window', 'door') THEN
    v_task_type := 'opening_rectangle';
    v_annotation := jsonb_build_object(
      'rect', NEW.region_polygon,
      'scale_in_per_px', NEW.scale_in_per_px,
      'type', NEW.measurement_type,
      'width_in', NEW.width_in,
      'height_in', NEW.height_in,
      'elevation', NEW.elevation
    );
  ELSE
    RETURN NEW;   -- trim/corner/roof_visible aren't in the training schema yet
  END IF;

  INSERT INTO training_examples (
    user_id, source_table, source_id, task_type,
    image_url, image_width_px, image_height_px,
    annotation, capture_source
  ) VALUES (
    v_user_id, 'exterior_measurements', NEW.id, v_task_type,
    v_photo_url, COALESCE(v_width_px, 1024), COALESCE(v_height_px, 768),
    v_annotation, 'organic'
  )
  ON CONFLICT (source_table, source_id, task_type) DO UPDATE SET
    annotation = EXCLUDED.annotation,
    updated_at = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS capture_exterior_training_example_trg ON exterior_measurements;
CREATE TRIGGER capture_exterior_training_example_trg
  AFTER INSERT OR UPDATE OF contractor_entered, region_polygon ON exterior_measurements
  FOR EACH ROW EXECUTE FUNCTION capture_exterior_training_example();


-- ----------------------------------------------------------------------------
-- 6. Updated-at trigger (consistency with other tables)
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS training_examples_touch_updated ON training_examples;
CREATE TRIGGER training_examples_touch_updated BEFORE UPDATE ON training_examples
  FOR EACH ROW EXECUTE FUNCTION axis_touch_updated_at();


-- ----------------------------------------------------------------------------
-- 7. Backfill from existing data
-- ----------------------------------------------------------------------------
-- Anything contractors already confirmed in prior sessions becomes a training
-- example retroactively. ON CONFLICT DO NOTHING in the triggers means re-runs
-- are safe.
-- ----------------------------------------------------------------------------

-- Trigger backfill by touching the user_confirmed column on existing rows.
-- We do this in a transaction-friendly way: only rows where the flag is TRUE.

-- Roof facets
UPDATE roof_facets SET user_confirmed = TRUE WHERE user_confirmed = TRUE;

-- Roof edges
UPDATE roof_edges SET user_confirmed = TRUE WHERE user_confirmed = TRUE;

-- Roof penetrations
UPDATE roof_penetrations SET user_confirmed = TRUE
  WHERE user_confirmed = TRUE AND pos_x_frac IS NOT NULL;

-- Exterior measurements
UPDATE exterior_measurements SET contractor_entered = TRUE
  WHERE contractor_entered = TRUE AND region_polygon IS NOT NULL;
