-- ============================================================================
-- Axis Performance — persist uploaded ground photos so they can appear in the
-- report's Photos page (like Hover/EagleView's photo pages).
-- ============================================================================
-- analyze_ground_photo previously read photos in-memory and discarded them, so
-- there was nothing to embed in the PDF. We now upload each photo to Supabase
-- Storage and keep its (signed) URL here.
-- ============================================================================

ALTER TABLE roof_measurement_runs
  ADD COLUMN IF NOT EXISTS ground_photo_urls JSONB;   -- ["https://...signed...", ...]
