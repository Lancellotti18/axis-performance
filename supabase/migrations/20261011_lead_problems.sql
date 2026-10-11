-- Reporting a bad lead, and the credit that makes up for it.
--
-- Duds are mostly prevented before sale (non-residential and recently-sold
-- parcels are filtered out, and duplicates are impossible by index). This is
-- for the ones that get through: the record was wrong, the house had already
-- changed hands, or it is not a home at all.
--
-- Deliberately NOT a general complaints table. "Nobody answered" and "not
-- interested" are the job, not a defect, and nothing here accepts them.

CREATE TABLE IF NOT EXISTS lead_problem_reports (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL,
    purchase_id   uuid NOT NULL REFERENCES purchased_leads(id) ON DELETE CASCADE,
    -- Only reasons that can be checked against the county record.
    reason        text NOT NULL,
    detail        text,
    -- open -> approved | rejected. 'approved' is set by the server itself when
    -- the county's current record corroborates the claim; everything else waits
    -- for a human.
    status        text NOT NULL DEFAULT 'open',
    -- How it was made good: a replacement lead (the default) or cash.
    resolution    text,
    auto_verified boolean NOT NULL DEFAULT false,
    -- What the county said at the moment of the claim, kept so a decision made
    -- later can be understood.
    evidence      jsonb,
    reviewed_at   timestamptz,
    reviewed_by   uuid,
    review_note   text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lead_problem_reason_valid
        CHECK (reason IN ('not_a_home', 'sold_before_purchase', 'record_wrong')),
    CONSTRAINT lead_problem_status_valid
        CHECK (status IN ('open', 'approved', 'rejected')),
    CONSTRAINT lead_problem_resolution_valid
        CHECK (resolution IS NULL OR resolution IN ('replacement', 'refund', 'none'))
);

-- One claim per purchase. Re-reporting the same lead is not a second claim,
-- and without this a rejected claim could be filed again until it stuck.
CREATE UNIQUE INDEX IF NOT EXISTS lead_problem_one_per_purchase
    ON lead_problem_reports (purchase_id);

CREATE INDEX IF NOT EXISTS lead_problem_user_idx
    ON lead_problem_reports (user_id, created_at DESC);
-- The admin review queue reads this constantly; 'open' is the only hot subset.
CREATE INDEX IF NOT EXISTS lead_problem_open_idx
    ON lead_problem_reports (created_at DESC) WHERE status = 'open';

ALTER TABLE lead_problem_reports ENABLE ROW LEVEL SECURITY;

-- Read your own claims. No client writes: filing and deciding both belong to
-- the server, or an account could approve its own credits.
DROP POLICY IF EXISTS lead_problem_select_own ON lead_problem_reports;
CREATE POLICY lead_problem_select_own ON lead_problem_reports
    FOR SELECT
    USING (auth.uid() = user_id);

-- ── The credit ────────────────────────────────────────────────────────────
-- An approved claim grants a replacement lead rather than a refund, so the
-- contractor ends up with what they were trying to buy. Spent by the next lead
-- purchase, which skips the card entirely when a credit is available.
ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS lead_credits integer NOT NULL DEFAULT 0;

ALTER TABLE subscriptions
    DROP CONSTRAINT IF EXISTS subscriptions_lead_credits_sane;
ALTER TABLE subscriptions
    ADD CONSTRAINT subscriptions_lead_credits_sane
    CHECK (lead_credits >= 0 AND lead_credits <= 100);
