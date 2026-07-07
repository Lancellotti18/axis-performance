-- ============================================================================
-- Axis Performance — growth engine: instant quote widget, leads, proposals
-- ============================================================================
-- 1. quote_widgets — each contractor gets an embeddable/hosted instant-quote
--    tool (the Roofle/GeoQuote product, powered by the measurement pipeline
--    Axis already has). Homeowner types an address → instant size + price
--    range → contact capture → lead.
--
-- 2. widget_leads — captured homeowner leads with a simple pipeline
--    (new → contacted → quoted → won/lost). Speed-to-lead wins jobs.
--
-- 3. roof_proposals — good/better/best homeowner-facing proposals generated
--    from a measurement run, shareable by public token, acceptable online.
--    (Named roof_proposals: the blueprint side already owns `proposals`.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS quote_widgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  widget_key TEXT NOT NULL UNIQUE,          -- public token in the embed URL
  enabled BOOLEAN NOT NULL DEFAULT true,
  company_name TEXT,                        -- shown to the homeowner
  phone TEXT,
  -- $/square (100 sqft) per tier — drives the instant range.
  price_low NUMERIC NOT NULL DEFAULT 450,
  price_high NUMERIC NOT NULL DEFAULT 650,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS widget_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,                    -- the contractor who owns the widget
  widget_key TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT NOT NULL,
  lat NUMERIC,
  lng NUMERIC,
  squares_estimate NUMERIC,
  price_low NUMERIC,
  price_high NUMERIC,
  quote_source TEXT,                        -- 'solar' | 'footprint' | 'none'
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'quoted', 'won', 'lost')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_widget_leads_user ON widget_leads(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_widget_leads_status ON widget_leads(user_id, status);

CREATE TABLE IF NOT EXISTS roof_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  project_id UUID,
  run_id UUID,
  token TEXT NOT NULL UNIQUE,               -- public share token
  -- Snapshot of contractor branding at creation (profile edits later must not
  -- silently rewrite an already-sent proposal).
  company_name TEXT,
  license_number TEXT,
  phone TEXT,
  email TEXT,
  logo_url TEXT,
  -- Property + measurement snapshot
  address TEXT,
  squares NUMERIC,
  total_roof_sqft NUMERIC,
  predominant_pitch TEXT,
  -- Good / Better / Best
  tiers JSONB NOT NULL DEFAULT '[]',        -- [{name, headline, description, price, features: []}]
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'expired')),
  accepted_tier TEXT,
  accepted_by_name TEXT,
  accepted_by_email TEXT,
  accepted_at TIMESTAMPTZ,
  homeowner_note TEXT,
  valid_until DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_roof_proposals_user ON roof_proposals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_roof_proposals_run ON roof_proposals(run_id);

-- Service-role only (backend enforces JWT + ownership; public endpoints go
-- through the backend with token/key checks).
ALTER TABLE quote_widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE widget_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE roof_proposals ENABLE ROW LEVEL SECURITY;
