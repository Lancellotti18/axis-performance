-- ============================================================================
-- Axis Performance — version the CRM + contractor-profile tables
-- ============================================================================
-- These three tables were created ad-hoc in the live dashboard and never
-- landed in the repo, so a fresh Supabase project could not be stood up from
-- source (overnight code-audit finding). IF NOT EXISTS everywhere: applying
-- this against the live DB is a no-op; applying to a fresh DB builds the
-- exact shape the code expects (crm.py, instant_quote.py, contractor_profile.py).
-- ============================================================================

CREATE TABLE IF NOT EXISTS contractor_profiles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL UNIQUE,
  company_name   TEXT,
  license_number TEXT,
  phone          TEXT,
  email          TEXT,
  address        TEXT,
  city           TEXT,
  state          TEXT,
  zip_code       TEXT,
  logo_url       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  name            TEXT NOT NULL,
  phone           TEXT,
  email           TEXT,
  address         TEXT,
  city            TEXT,
  state           TEXT,
  job_type        TEXT DEFAULT 'residential',
  stage           TEXT NOT NULL DEFAULT 'new'
    CHECK (stage IN ('new', 'contacted', 'site_visit', 'estimate_sent', 'won', 'lost')),
  notes           TEXT,
  estimated_value NUMERIC DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_leads_user ON crm_leads(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_lead_notes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    UUID NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL,
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_lead_notes_lead ON crm_lead_notes(lead_id, created_at);

-- Service-role only (the backend enforces JWT + ownership in
-- app/core/ownership.py; RLS is defense-in-depth if a user-scoped client
-- ever talks to these tables directly).
ALTER TABLE contractor_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_leads           ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_lead_notes      ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY contractor_profiles_owner ON contractor_profiles
    FOR ALL USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY crm_leads_owner ON crm_leads
    FOR ALL USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY crm_lead_notes_owner ON crm_lead_notes
    FOR ALL USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
