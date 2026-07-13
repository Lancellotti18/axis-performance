-- ============================================================================
-- Axis Performance — link crm_leads ↔ widget_leads (kill the dual-table drift)
-- ============================================================================
-- RoofIQ writes every lead to BOTH widget_leads (immutable capture log: score,
-- report_token, details, quote snapshot, report_opens) AND crm_leads (the
-- pipeline kanban). They were unlinked, so the CRM re-parsed the RoofIQ
-- intelligence out of a notes string and the two rows could silently drift.
--
-- This makes crm_leads the pipeline system-of-record and links it back to its
-- capture record, surfacing the score + report as first-class columns. All
-- additive / IF NOT EXISTS — a live no-op-safe upgrade; older rows keep their
-- report_token embedded in notes and the UI falls back to parsing it.
-- ============================================================================

ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS source          TEXT;      -- 'roofiq' | 'manual' | ...
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS widget_lead_id  UUID;      -- FK → widget_leads.id (capture log)
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS lead_score      INT;       -- 0–100, mirrored from the capture
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS report_token    TEXT;      -- homeowner report /r/{token}

CREATE INDEX IF NOT EXISTS idx_crm_leads_widget_lead ON crm_leads(widget_lead_id);
