-- Adds columns to permit_form_cache for the contractor-friendly permit flow:
--   confirmed_at          — when the contractor confirmed this form is the right one
--   blueprint_scan        — Vision-extracted fields from the blueprint (sqft, BR/BA, etc.)
--   fees_estimate         — LLM-estimated fee range, cached so we don't re-call per page load
--   review_days_estimate  — LLM-estimated review timeline, cached
--
-- Table created with IF NOT EXISTS in case the schema was provisioned ad hoc
-- in an earlier deploy. Existing rows keep their data.

CREATE TABLE IF NOT EXISTS permit_form_cache (
    city          TEXT NOT NULL,
    state         TEXT NOT NULL,
    project_type  TEXT NOT NULL DEFAULT 'residential',
    form_url      TEXT,
    form_fields   JSONB,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (city, state, project_type)
);

ALTER TABLE permit_form_cache
    ADD COLUMN IF NOT EXISTS confirmed_at         TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS blueprint_scan       JSONB,
    ADD COLUMN IF NOT EXISTS fees_estimate        TEXT,
    ADD COLUMN IF NOT EXISTS review_days_estimate TEXT;

-- Service role writes; reads are public (no PII in this table — just form
-- structure and fee estimates per jurisdiction).
ALTER TABLE permit_form_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "permit_form_cache_read_all" ON permit_form_cache;
CREATE POLICY "permit_form_cache_read_all"
    ON permit_form_cache FOR SELECT
    USING (true);
