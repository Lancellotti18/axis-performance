-- ============================================================================
-- Axis Performance — RoofVision palette curation
-- ============================================================================
-- Lets each contractor choose which shingle colors RoofVision renders for their
-- homeowners (a subset of the catalog in roofvision_service.SHINGLE_OPTIONS),
-- so the previews only ever show products they actually install.
--
-- Additive / IF NOT EXISTS — a live no-op-safe upgrade. When absent, the code
-- falls back to the default palette (first three catalog colors).
-- ============================================================================

ALTER TABLE quote_widgets ADD COLUMN IF NOT EXISTS roofvision_palette JSONB;
-- e.g. ["charcoal", "slate", "hunter_green"] — ordered keys from the catalog.
