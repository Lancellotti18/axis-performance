-- Paid leads, and scheduled plan changes.

-- ── A downgrade someone asked for, landing at period end ──────────────────
-- Upgrades apply immediately so they need no record. A downgrade is a promise
-- about the future, and it has to survive until the renewal webhook lands —
-- holding it only in Stripe would mean Axis could not show "switching to Solo
-- on 20 Oct" anywhere in the UI.
ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS scheduled_plan_key text,
    ADD COLUMN IF NOT EXISTS scheduled_change_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
     WHERE table_name = 'subscriptions'
       AND constraint_name = 'subscriptions_scheduled_plan_valid'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_scheduled_plan_valid
      CHECK (scheduled_plan_key IS NULL
             OR scheduled_plan_key IN ('solo', 'crew', 'fleet'));
  END IF;
END $$;

-- ── Leads a contractor has actually paid for ──────────────────────────────
-- Find Roofs currently hands over every prospect in a county for free. This is
-- the record of what was BOUGHT, and it does two jobs:
--
--   1. Nobody sees a lead before their payment clears. A row appears only once
--      Stripe confirms, so a declined card grants nothing.
--   2. Each lead is sold ONCE. The unique index on (source_county, prospect_pin)
--      is what makes exclusivity real rather than a promise in the copy — it is
--      the whole reason contractors resent Angi, and the database enforces it
--      instead of application code remembering to.
CREATE TABLE IF NOT EXISTS purchased_leads (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                   uuid NOT NULL,
    -- Identifies the parcel in its county's own system.
    source_county             text NOT NULL,
    prospect_pin              text NOT NULL,
    -- Snapshot of what was sold. County services rewrite their data, and a
    -- contractor must still be able to see what they paid for a year later.
    snapshot                  jsonb,
    price_usd                 integer NOT NULL,
    status                    text NOT NULL DEFAULT 'pending',
    stripe_payment_intent_id  text,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now()
);

-- Exclusivity, enforced by the database. Partial so that a failed or refunded
-- purchase releases the lead back to the pool rather than burning it forever.
CREATE UNIQUE INDEX IF NOT EXISTS purchased_leads_exclusive_idx
    ON purchased_leads (source_county, prospect_pin)
    WHERE status IN ('pending', 'succeeded');

CREATE INDEX IF NOT EXISTS purchased_leads_user_idx
    ON purchased_leads (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS purchased_leads_intent_idx
    ON purchased_leads (stripe_payment_intent_id)
    WHERE stripe_payment_intent_id IS NOT NULL;
