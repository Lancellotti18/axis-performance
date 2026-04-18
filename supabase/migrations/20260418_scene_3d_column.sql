-- scene_3d cache for blueprint vision output.
-- Consumed by /blueprints/{id}/takeoff, /axis report, and /model3d so the
-- LLM vision pass runs once per blueprint and later calls hit the cache.
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS scene_3d JSONB;
