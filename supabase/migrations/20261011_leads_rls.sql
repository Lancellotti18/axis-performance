-- Row-level security for bought leads.
--
-- purchased_leads was created without RLS. The backend reaches Supabase with
-- the service key, which bypasses RLS entirely, so the API has always been
-- correctly scoped — but the anon key is published in the site's JS bundle,
-- and with RLS off that key can read the table straight from the REST endpoint.
-- Every owner name and mailing address anybody has paid for would be readable
-- by anyone who opened the bundle. That is exactly the data contractors are
-- paying to have exclusively.
--
-- Enabling RLS with a single owner-only policy closes that door without
-- touching the backend: the service key is unaffected, and a signed-in
-- contractor can read their own purchases and nothing else.

ALTER TABLE purchased_leads ENABLE ROW LEVEL SECURITY;

-- Read your own purchases. No INSERT/UPDATE/DELETE policy on purpose: writes
-- belong to the server, because a client that could insert its own row could
-- reserve every lead in a county for free.
DROP POLICY IF EXISTS purchased_leads_select_own ON purchased_leads;
CREATE POLICY purchased_leads_select_own ON purchased_leads
    FOR SELECT
    USING (auth.uid() = user_id);

-- A reservation that was never paid for. Previously these rows sat 'pending'
-- for good, and the partial unique index treats pending as taken, so a lead
-- behind an abandoned checkout could never be sold to anyone. 'expired' is
-- outside that index, which returns the lead to the pool.
ALTER TABLE purchased_leads
    DROP CONSTRAINT IF EXISTS purchased_leads_status_valid;
ALTER TABLE purchased_leads
    ADD CONSTRAINT purchased_leads_status_valid
    CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'expired'));
