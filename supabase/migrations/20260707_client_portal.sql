-- ============================================================================
-- Axis Performance — homeowner client portal
-- ============================================================================
-- One tokenized link per project (/c/{token}) — the homeowner's window into
-- their job: status timeline, proposal, report, photos, contractor contact.
-- Link-based access (like proposals): no homeowner accounts, no passwords —
-- the unguessable token IS the auth. Contractor texts the link once.
-- ============================================================================

CREATE TABLE IF NOT EXISTS client_portals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL UNIQUE,
  user_id UUID NOT NULL,                    -- owning contractor
  token TEXT NOT NULL UNIQUE,
  stage TEXT NOT NULL DEFAULT 'measured'
    CHECK (stage IN ('measured', 'proposal', 'accepted', 'scheduled', 'in_progress', 'complete')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_portals_user ON client_portals(user_id);

-- Service-role only (backend enforces contractor ownership; public reads go
-- through the backend with token checks).
ALTER TABLE client_portals ENABLE ROW LEVEL SECURITY;
