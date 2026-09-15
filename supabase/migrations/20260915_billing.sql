-- Subscriptions, entitlement state, and webhook bookkeeping.
--
-- Three tables, and what is deliberately NOT here matters as much as what is:
--
-- There is no `plans` table. Plan LIMITS (15 reports, 3 crews) are business
-- logic that belongs in code, versioned with the check that enforces them;
-- plan PRICES belong in Stripe, which is the only system that can charge a
-- card. A plans table would be a third copy that silently drifts from both.
-- The plan_key here is the join between them.
--
-- Report counting already exists — report_events is the meter and
-- already_generated() prevents double-charging. This adds only the question
-- "is this contractor allowed to do that", never a second count.

-- ── One row per contractor's Stripe subscription ──────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 uuid NOT NULL UNIQUE,
    stripe_customer_id      text,
    stripe_subscription_id  text UNIQUE,

    plan_key                text,          -- 'solo' | 'crew' | 'fleet'
    billing_interval        text,          -- 'month' | 'year'

    -- Stripe's own status, stored verbatim rather than mapped to a boolean.
    -- 'past_due' is not 'canceled': a card that failed today should not read
    -- the same as an account that quit, and collapsing them is how people get
    -- locked out over an expired card.
    status                  text NOT NULL DEFAULT 'none',

    current_period_start    timestamptz,
    current_period_end      timestamptz,
    cancel_at_period_end    boolean NOT NULL DEFAULT false,

    -- The one-free-report offer. Kept here rather than in a promo table
    -- because it is a property of the account's entitlement, and the
    -- entitlement check must answer in one read.
    trial_report_used       boolean NOT NULL DEFAULT false,
    promo_code              text,

    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions (status);
CREATE INDEX IF NOT EXISTS subscriptions_customer_idx
    ON subscriptions (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- ── Webhook idempotency ───────────────────────────────────────────────────
-- Stripe retries deliveries and does not promise exactly-once. Without this,
-- one retried invoice.paid can double-credit an account and one retried
-- subscription.deleted can cancel an account that already resubscribed.
-- Processing is: insert the id first, and skip anything already present.
CREATE TABLE IF NOT EXISTS stripe_events (
    id            text PRIMARY KEY,          -- Stripe's evt_… id
    type          text NOT NULL,
    processed_at  timestamptz NOT NULL DEFAULT now(),
    payload       jsonb
);

CREATE INDEX IF NOT EXISTS stripe_events_processed_idx
    ON stripe_events (processed_at DESC);

-- ── What enforcement WOULD have done, while the flag is off ───────────────
-- Shadow mode, the same pattern the auth rollout used. Enforcement ships
-- turned off and writes here instead of blocking, so the real question —
-- "would this have locked out someone who should have access?" — is answered
-- from production traffic before anyone is actually denied.
CREATE TABLE IF NOT EXISTS entitlement_denials (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL,
    action        text NOT NULL,             -- 'generate_report' | 'add_crew' | …
    reason        text NOT NULL,             -- why it would have been denied
    plan_key      text,
    status        text,
    enforced      boolean NOT NULL DEFAULT false,   -- false = shadow, logged only
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entitlement_denials_user_idx
    ON entitlement_denials (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS entitlement_denials_recent_idx
    ON entitlement_denials (created_at DESC);

do $$
begin
  if not exists (
    select 1 from information_schema.constraint_column_usage
     where table_name = 'subscriptions' and constraint_name = 'subscriptions_plan_key_valid'
  ) then
    alter table subscriptions
      add constraint subscriptions_plan_key_valid
      check (plan_key is null or plan_key in ('solo', 'crew', 'fleet'));
  end if;
  if not exists (
    select 1 from information_schema.constraint_column_usage
     where table_name = 'subscriptions' and constraint_name = 'subscriptions_interval_valid'
  ) then
    alter table subscriptions
      add constraint subscriptions_interval_valid
      check (billing_interval is null or billing_interval in ('month', 'year'));
  end if;
end $$;
