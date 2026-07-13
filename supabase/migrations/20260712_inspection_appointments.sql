-- ============================================================================
-- Axis Performance — inspection appointments (homeowner booking + contractor calendar)
-- ============================================================================
-- Roofr's highest-converting widget element is a "book a free inspection" CTA
-- on the result. This is the internal appointment model behind it: a homeowner
-- books a preferred day + time window from their RoofIQ report, it lands on the
-- contractor's calendar, and the linked CRM lead advances to 'site_visit'.
-- No external calendar dependency — contractors manage it in-app.
-- ============================================================================

CREATE TABLE IF NOT EXISTS inspection_appointments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL,                 -- the contractor who owns the lead
  widget_lead_id   UUID,                          -- capture-log link (nullable)
  crm_lead_id      UUID,                          -- pipeline link (nullable)
  report_token     TEXT,                          -- the report this was booked from

  homeowner_name   TEXT,
  homeowner_phone  TEXT,
  homeowner_email  TEXT,
  address          TEXT,

  preferred_date   DATE NOT NULL,
  time_window      TEXT NOT NULL DEFAULT 'anytime'
    CHECK (time_window IN ('morning', 'afternoon', 'evening', 'anytime')),
  homeowner_note   TEXT,

  status           TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'confirmed', 'completed', 'cancelled', 'no_show')),
  contractor_note  TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appointments_user_date
  ON inspection_appointments(user_id, preferred_date);
CREATE INDEX IF NOT EXISTS idx_appointments_report
  ON inspection_appointments(report_token);

-- Service-role only (backend enforces JWT + ownership; the public booking
-- endpoint validates the report token). RLS is defense-in-depth.
ALTER TABLE inspection_appointments ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY inspection_appointments_owner ON inspection_appointments
    FOR ALL USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
