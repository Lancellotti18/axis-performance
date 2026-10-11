-- ============================================================================
-- Axis Performance — row-level security on every remaining table
-- ============================================================================
-- Found 2026-10-11 while finishing the dispatch-tenancy work. The anon key
-- ships in the public JS bundle, so anything the `anon` role can SELECT is
-- world-readable. A probe with that key against production returned REAL ROWS
-- from:
--     crm_leads            15 rows — homeowner name, phone, email, address
--     crm_lead_notes        3 rows — private notes about homeowners
--     contractor_profiles   1 row  — company name, license, phone, email
--     legal_acknowledgments 3 rows — user_id, IP address, user agent
-- The first three are already fixed by 20260712_version_crm_tables.sql, which
-- was written but never applied to production — APPLY THAT ONE TOO.
--
-- The sched_* tables were the original worry and came back clean (RLS is on in
-- the live project even though no migration did it). They are listed here so
-- the repo matches production and a fresh project is not born wide open.
--
-- No policies: nothing is granted to anon or authenticated, which denies all
-- direct access. Every read and write in this product goes through the FastAPI
-- backend on the SERVICE key, which bypasses RLS, so this changes no behaviour.
-- The frontend never queries these tables directly (no supabase.from() calls
-- outside storage buckets) — checked before writing this.
--
-- Safe to run repeatedly.
-- ============================================================================

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    -- dispatch / scheduling
    'sched_appointment', 'sched_assignment', 'sched_audit_event', 'sched_business_unit',
    'sched_crew', 'sched_crew_membership', 'sched_crew_skill', 'sched_customer',
    'sched_job', 'sched_job_tag', 'sched_job_tag_link', 'sched_non_job_event',
    'sched_person', 'sched_property', 'sched_shift', 'sched_weather_day',
    -- money (empty today only because billing is dormant — lock before it goes live)
    'subscriptions', 'payment_methods', 'overage_purchases', 'stripe_events',
    'purchased_leads',
    -- people and PII
    'legal_acknowledgments', 'marketing_consent', 'notifications',
    'project_photos', 'project_photo_shares',
    -- internal telemetry
    'briefing_snoozes', 'entitlement_denials', 'llm_usage', 'report_events'
  ])
  LOOP
    -- ENABLE only, never FORCE: FORCE would apply to the table owner too, and
    -- the backend must keep working. Enabling with no policy already denies
    -- anon and authenticated, while the service key bypasses RLS.
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;
