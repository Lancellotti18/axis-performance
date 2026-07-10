-- ============================================================================
-- Axis Performance — RoofIQ: qualification v3 details column
-- ============================================================================
-- The homeowner flow now asks six estimator-grade questions (work type, roof
-- condition, rooftop equipment, chimneys/skylights, attic, drainage). Their
-- answers are stored as one JSONB blob on the lead so the report and CRM can
-- render them, and so _score_lead can factor them in.
--
-- Without this column, capture_lead's insert throws on the unknown column and
-- the bare except silently degrades the row — dropping the report token, lead
-- score, and quote snapshot on EVERY lead. This migration is required for the
-- feature to persist anything. (See code-audit: widget_leads.details.)
-- ============================================================================

ALTER TABLE widget_leads ADD COLUMN IF NOT EXISTS details JSONB;
-- { work_type, condition, rooftop_items[], chimney_skylights, attic, drainage }
