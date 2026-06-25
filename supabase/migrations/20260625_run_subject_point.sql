-- ============================================================================
-- Axis Performance — store the contractor's "tap your house" point on the run
-- ============================================================================
-- Address geocodes are often offset (to the street/parcel, not the rooftop), so
-- "the building at the tile center" or "the building Google returns" isn't
-- reliably the subject house — especially on tight lots. The contractor taps
-- their roof once; we store that point (image fractions 0..1) and anchor facet
-- detection (mask/crop) on it. 100% reliable, one tap.
-- ============================================================================

ALTER TABLE roof_measurement_runs
  ADD COLUMN IF NOT EXISTS subject_point JSONB;   -- {"x": 0.5, "y": 0.5}
