-- ============================================================================
-- Axis Performance — Capture REJECTED AI facet suggestions (hard negatives)
-- ============================================================================
-- The 20260606 training-data triggers only capture CONFIRMED annotations
-- (user_confirmed = TRUE) — positive examples. But when a contractor REJECTS an
-- AI facet suggestion ("that polygon is the driveway / the neighbor's roof"),
-- that verdict is dropped on the client and never stored. Hard negatives are the
-- single most valuable signal for teaching a future segmentation model what is
-- NOT a roof plane — i.e. for killing the exact false positives contractors keep
-- hitting.
--
-- The /runs/{id}/facets/rejections endpoint inserts those rejected polygons into
-- training_examples with capture_source = 'ai_rejected'. This migration just
-- widens the capture_source CHECK to permit that value. (source_id is NULL for a
-- rejection — the polygon was never saved as a roof_facets row — and NULLs are
-- distinct in the UNIQUE(source_table, source_id, task_type) index, so multiple
-- rejections coexist fine.)
-- ============================================================================

ALTER TABLE training_examples
  DROP CONSTRAINT IF EXISTS training_examples_capture_source_check;

ALTER TABLE training_examples
  ADD CONSTRAINT training_examples_capture_source_check
  CHECK (capture_source IN (
    'organic',        -- contractor doing real work
    'labeling_mode',  -- explicit dataset-building session
    'ai_corrected',   -- contractor corrected/confirmed an AI suggestion (positive)
    'ai_rejected'     -- contractor rejected an AI suggestion (hard NEGATIVE)
  ));

-- Fast filtering of negatives for the training export / review queue.
CREATE INDEX IF NOT EXISTS training_examples_negatives_idx
  ON training_examples (task_type, created_at DESC)
  WHERE capture_source = 'ai_rejected';
