-- ============================================================================
-- Axis Performance — RoofIQ: intelligence portal upgrade for the quote widget
-- ============================================================================
-- 1. widget_leads grows qualification data (age/stories/issues), a
--    deterministic lead score, a quote snapshot (so the report renders later
--    exactly as the homeowner saw it), and a shareable report token.
-- 2. widget_events powers the contractor funnel analytics
--    (view → address → confirmed → qualified → lead).
-- ============================================================================

ALTER TABLE widget_leads ADD COLUMN IF NOT EXISTS roof_age TEXT;
ALTER TABLE widget_leads ADD COLUMN IF NOT EXISTS stories INT;
ALTER TABLE widget_leads ADD COLUMN IF NOT EXISTS issues JSONB;          -- ["leak","storm_damage",...]
ALTER TABLE widget_leads ADD COLUMN IF NOT EXISTS lead_score INT;
ALTER TABLE widget_leads ADD COLUMN IF NOT EXISTS score_reasons JSONB;   -- ["Active leak (+25)", ...]
ALTER TABLE widget_leads ADD COLUMN IF NOT EXISTS quote JSONB;           -- snapshot: sqft/squares/prices/source/imagery
ALTER TABLE widget_leads ADD COLUMN IF NOT EXISTS report_token TEXT UNIQUE;
ALTER TABLE widget_leads ADD COLUMN IF NOT EXISTS report_opens INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_widget_leads_report ON widget_leads(report_token);

CREATE TABLE IF NOT EXISTS widget_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  widget_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN (
    'view', 'address_entered', 'roof_confirmed', 'qualified', 'lead_captured', 'report_opened'
  )),
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_widget_events_key ON widget_events(widget_key, created_at DESC);
ALTER TABLE widget_events ENABLE ROW LEVEL SECURITY;
