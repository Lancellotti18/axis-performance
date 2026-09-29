-- Google Solar's view of the whole building, recorded when a run's facets are
-- saved: {"ground_sqft", "roof_sqft", "distance_m", "imagery_quality",
-- "imagery_date"}. _aggregate_run compares the traced plan area against
-- ground_sqft to catch a clean trace of only PART of a roof, which no check on
-- the trace itself can see (run e420330e: 71% traced, reported High 97%).
--
-- Safe to run more than once. Until it runs, the backend fails open: the
-- reference is not stored and coverage is simply not judged.
ALTER TABLE roof_measurement_runs
  ADD COLUMN IF NOT EXISTS solar_reference JSONB;
