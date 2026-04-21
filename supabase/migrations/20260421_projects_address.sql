-- Add location columns to projects for damage reports, permits, and proposals.
-- Safe to re-run: IF NOT EXISTS guards each column add.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS city    TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS state   TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS zip     TEXT;
