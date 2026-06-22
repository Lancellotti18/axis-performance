-- ============================================================================
-- Axis Performance — persist ground-photo findings on the run
-- ============================================================================
-- The ground-photo analyzer (/runs/{id}/ground-photos/analyze) reads pitch,
-- chimney, dormers, materials, etc. from an eye-level photo but persisted
-- NOTHING — every finding was discarded after display. That meant facet pitch
-- always fell back to the hardcoded 6/12 guess, silently corrupting slope area
-- → squares → material cost.
--
-- This column stores the consolidated findings (the highest-confidence pitch
-- read + penetration counts) so multiple features can read ONE shared artifact:
--   * facet pitch seeding (kills the 6/12 default)
--   * penetrations / flashing priors
--   * materials
-- One analysis, many consumers.
-- ============================================================================

ALTER TABLE roof_measurement_runs
  ADD COLUMN IF NOT EXISTS ground_findings JSONB;
