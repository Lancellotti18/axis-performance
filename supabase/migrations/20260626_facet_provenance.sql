-- ============================================================================
-- Axis Performance — airtight training provenance for roof facets
-- ============================================================================
-- The facet capture trigger labeled capture_source by CONFIDENCE
-- (<0.85 => 'ai_corrected'), but a MANUAL trace has confidence 0.8 — so pure
-- human-drawn facets (the highest-value, unbiased training labels) were
-- mislabeled 'ai_corrected', indistinguishable from accepted-AI facets.
--
-- Fix: an explicit ai_suggested flag on roof_facets (mirrors roof_penetrations),
-- and the trigger keys capture_source off it:
--   ai_suggested = true  -> 'ai_corrected' (human accepted/fixed an AI facet)
--   ai_suggested = false -> 'organic'      (contractor drew it by hand)
-- ============================================================================

ALTER TABLE roof_facets
  ADD COLUMN IF NOT EXISTS ai_suggested BOOLEAN DEFAULT FALSE;

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

  -- Explicit provenance: AI-origin facet the human kept/fixed vs a hand trace.
  v_capture_source := CASE
    WHEN COALESCE(NEW.ai_suggested, FALSE) THEN 'ai_corrected'
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
