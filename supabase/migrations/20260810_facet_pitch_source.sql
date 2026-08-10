-- Phase 1: persist per-facet pitch PROVENANCE so the report and editor can tell a
-- MEASURED pitch (Google Solar / LiDAR) apart from a contractor-entered value or
-- the silent 6/12 default. Detection already computes pitch_source; without a
-- column to store it the provenance was lost the moment facets were saved.
--
-- Values: 'solar_measured' | 'solar_direction' | 'lidar_measured'
--         | 'ground_photo' | 'ai_satellite' | 'manual' | 'default'
ALTER TABLE roof_facets
  ADD COLUMN IF NOT EXISTS pitch_source TEXT;

-- Backfill: an existing facet still on the exact 6/12 / 26.57° default almost
-- certainly never had its pitch confirmed — mark it 'default' so the report stops
-- presenting it as a known value. Everything else is left NULL (unknown provenance)
-- rather than claiming a source we can't prove.
UPDATE roof_facets
   SET pitch_source = 'default'
 WHERE pitch_source IS NULL
   AND pitch = '6/12'
   AND (pitch_degrees IS NULL OR round(pitch_degrees::numeric, 2) = 26.57);
