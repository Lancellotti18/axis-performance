-- CompanyCam-style photo metadata.
-- Additive columns on project_photos. Safe to re-run (IF NOT EXISTS).

ALTER TABLE project_photos
  ADD COLUMN IF NOT EXISTS captured_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS latitude      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS notes         TEXT,
  ADD COLUMN IF NOT EXISTS tags          TEXT[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS auto_tags     JSONB,
  ADD COLUMN IF NOT EXISTS ai_tagged_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_project_photos_project_captured
  ON project_photos (project_id, captured_at DESC);
