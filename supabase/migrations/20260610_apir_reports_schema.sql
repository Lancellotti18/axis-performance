-- APIR (Axis Property Intelligence Report) — Phase 0 schema
--
-- Adds the data layer for the 12-page contractor-grade PDF report:
--   1. New columns on roof_measurement_runs to capture scale calibration
--      provenance (method, confidence, px/ft, reference description) and
--      the per-run report_type + siding_waste_pct (the existing
--      waste_pct_default becomes roof_waste_pct conceptually — kept under
--      the original name to avoid breaking 4-week-old code that reads it).
--   2. New columns on exterior_measurements to support APIR's:
--        - WG-X window grouping (group_id text shared by identical openings)
--        - "Siding vs Other" Page 3 split (material_zone tag)
--   3. New company_profile table — contractor branding for the cover page
--      (logo, license #, contact info). Keyed on auth.users so it's truly
--      per-contractor and survives a project changing hands later.
--   4. New reports table — versioned, immutable record of every generated
--      PDF. measurements_snapshot is a frozen PropertyMeasurements JSONB so
--      a final report is reproducible even if underlying data changes.
--
-- All new tables use the established axis_project_owner(project_id) RLS
-- helper so contractors only see their own jobs.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Extend roof_measurement_runs with APIR scale + report metadata
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE roof_measurement_runs
  ADD COLUMN IF NOT EXISTS scale_method TEXT
    CHECK (scale_method IN ('web_mercator', 'reference_object', 'gsd', 'estimated')),
  ADD COLUMN IF NOT EXISTS scale_confidence TEXT
    CHECK (scale_confidence IN ('high', 'medium', 'estimated')),
  ADD COLUMN IF NOT EXISTS pixels_per_foot NUMERIC(10, 4),
  ADD COLUMN IF NOT EXISTS scale_reference_description TEXT,
  ADD COLUMN IF NOT EXISTS report_type TEXT DEFAULT 'full_exterior'
    CHECK (report_type IN ('full_exterior', 'roof_only', 'siding_only')),
  ADD COLUMN IF NOT EXISTS siding_waste_pct INTEGER DEFAULT 10
    CHECK (siding_waste_pct IN (0, 5, 10, 12, 15, 17, 20, 22));

COMMENT ON COLUMN roof_measurement_runs.scale_method IS
  'How pixels_per_foot was derived. web_mercator is preferred (exact from '
  'tile zoom+lat); reference_object falls back to AI-detected car/HVAC; '
  'gsd uses image metadata; estimated is the last-resort 40ft-wall guess.';
COMMENT ON COLUMN roof_measurement_runs.scale_confidence IS
  'high | medium | estimated. Drives the APIR cover page badge color and '
  'the per-page amber warning banner when "estimated".';
COMMENT ON COLUMN roof_measurement_runs.siding_waste_pct IS
  'Contractor-selected siding waste %. Separate from waste_pct_default '
  '(which is the roof waste %). Both feed the APIR waste calculator page.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Extend exterior_measurements with window grouping + material zone
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE exterior_measurements
  ADD COLUMN IF NOT EXISTS window_group_id TEXT,
  ADD COLUMN IF NOT EXISTS material_zone TEXT DEFAULT 'siding'
    CHECK (material_zone IN ('siding', 'brick', 'stone', 'unknown'));

COMMENT ON COLUMN exterior_measurements.window_group_id IS
  'APIR WG-X label. Multiple identical-dimension windows on the same '
  'elevation share a group_id (e.g. a triple window = 1 group, 3 members). '
  'NULL for windows that are not grouped.';
COMMENT ON COLUMN exterior_measurements.material_zone IS
  'Which exterior material zone this measurement belongs to. APIR Page 3 '
  'splits every siding table into "Siding" vs "Other" — material_zone '
  'distinguishes the two. brick/stone go to "Other"; unknown means a '
  'photo-coverage gap (UN-X facets).';

CREATE INDEX IF NOT EXISTS idx_exterior_measurements_window_group
  ON exterior_measurements (job_id, window_group_id)
  WHERE window_group_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. company_profile — contractor branding for APIR cover page
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS company_profile (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  contact_name TEXT,
  address TEXT,
  city_state_zip TEXT,
  phone TEXT,
  email TEXT,
  logo_url TEXT,
  license_number TEXT,
  website TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE company_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can CRUD their own company profile"
  ON company_profile FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Service role bypass (already implicit but documented for clarity)
COMMENT ON TABLE company_profile IS
  'Per-contractor branding shown on APIR cover page. One row per auth.user. '
  'Logo, license #, contact info, website. Editable from the Settings page.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. reports — versioned, immutable record of every generated APIR PDF
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id UUID REFERENCES roof_measurement_runs(id) ON DELETE SET NULL,

  -- versioning: every "Generate Report" click creates a new row;
  -- (project_id, version) is unique so we can address a specific past report.
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'final')),

  -- the rendered PDF lives in S3 (buildai-blueprints bucket)
  pdf_url TEXT,
  pdf_size_kb INTEGER,

  -- frozen PropertyMeasurements at generation time so old reports stay
  -- reproducible even after roof_facets / exterior_measurements drift
  measurements_snapshot JSONB NOT NULL,

  -- denormalized for fast filtering / display without parsing the snapshot
  scale_confidence TEXT
    CHECK (scale_confidence IN ('high', 'medium', 'estimated')),
  scale_method TEXT,
  report_type TEXT
    CHECK (report_type IN ('full_exterior', 'roof_only', 'siding_only')),
  ai_model_used TEXT,
  page_count INTEGER DEFAULT 12,

  -- audit
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  generated_by UUID REFERENCES auth.users(id),
  finalized_at TIMESTAMPTZ,
  finalized_by UUID REFERENCES auth.users(id),

  UNIQUE (project_id, version)
);

CREATE INDEX IF NOT EXISTS idx_reports_project ON reports (project_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status);

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can CRUD reports for their own projects"
  ON reports FOR ALL
  USING (axis_project_owner(project_id))
  WITH CHECK (axis_project_owner(project_id));

COMMENT ON TABLE reports IS
  'Immutable, versioned record of every generated APIR PDF. status=draft '
  'allows the contractor to regenerate; status=final locks the row (no '
  'edits, no regeneration — the PDF is the deliverable). measurements_'
  'snapshot freezes the data so finalized reports reproduce identically '
  'even after the underlying measurements change.';

-- Auto-bump version when a new report is generated for the same project.
-- The application can also compute the next version explicitly, but this
-- guard ensures we never collide on (project_id, version) due to a race.
CREATE OR REPLACE FUNCTION apir_next_report_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version IS NULL OR NEW.version = 0 THEN
    SELECT COALESCE(MAX(version), 0) + 1
      INTO NEW.version
      FROM reports
     WHERE project_id = NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_apir_next_report_version
  BEFORE INSERT ON reports
  FOR EACH ROW
  EXECUTE FUNCTION apir_next_report_version();

-- Lock finalized reports: once status flips to 'final', the row cannot be
-- changed (only deleted by cascade). This makes finalize a one-way door.
CREATE OR REPLACE FUNCTION apir_prevent_final_report_edits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'final' THEN
    RAISE EXCEPTION 'Report % is finalized and cannot be modified', OLD.id;
  END IF;
  IF NEW.status = 'final' AND OLD.status = 'draft' THEN
    NEW.finalized_at := COALESCE(NEW.finalized_at, NOW());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_apir_prevent_final_report_edits
  BEFORE UPDATE ON reports
  FOR EACH ROW
  EXECUTE FUNCTION apir_prevent_final_report_edits();
