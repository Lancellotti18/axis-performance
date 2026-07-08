-- ============================================================================
-- Axis Performance — two-way portal messaging
-- ============================================================================
-- Contractor posts updates from the dashboard; the homeowner reads AND replies
-- on their portal page; the contractor sees replies in the same thread. No
-- homeowner account needed — the portal token scopes the thread.
-- ============================================================================

CREATE TABLE IF NOT EXISTS portal_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_id UUID NOT NULL REFERENCES client_portals(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('contractor', 'homeowner')),
  sender_name TEXT,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_messages_portal
  ON portal_messages(portal_id, created_at);

ALTER TABLE portal_messages ENABLE ROW LEVEL SECURITY;
