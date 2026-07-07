-- ============================================================================
-- Axis Performance — accuracy flywheel + report white-labeling
-- ============================================================================
-- 1. roof_actuals: after a job, the contractor enters what the roof ACTUALLY
--    measured. Each row snapshots Axis's prediction at entry time, so we can
--    compute real calibration stats ("Axis measured within X% across N
--    verified jobs") — the marketing number AND the input for correcting any
--    systematic bias in the measurement pipeline.
--
-- 2. contractor_profiles.logo_url: contractors put THEIR brand on the reports
--    they hand to homeowners (white-label).
-- ============================================================================

CREATE TABLE IF NOT EXISTS roof_actuals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES roof_measurement_runs(id) ON DELETE CASCADE,
  project_id UUID,
  user_id UUID NOT NULL,

  -- What the field crew actually measured (squares = 100 sqft units).
  actual_squares NUMERIC NOT NULL,
  actual_ridge_hip_ft NUMERIC,          -- optional line-item detail
  actual_valley_ft NUMERIC,
  actual_eave_ft NUMERIC,

  -- Snapshot of Axis's prediction AT ENTRY TIME (aggregates change if the
  -- trace is edited later — the comparison must be against what the
  -- contractor actually ordered from).
  predicted_squares NUMERIC,
  predicted_ridge_hip_ft NUMERIC,
  predicted_valley_ft NUMERIC,
  predicted_eave_ft NUMERIC,

  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_roof_actuals_run ON roof_actuals(run_id);
CREATE INDEX IF NOT EXISTS idx_roof_actuals_user ON roof_actuals(user_id);

-- Service-role only (backend verifies JWT + ownership before writing).
ALTER TABLE roof_actuals ENABLE ROW LEVEL SECURITY;

-- White-label branding for reports.
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS logo_url TEXT;
