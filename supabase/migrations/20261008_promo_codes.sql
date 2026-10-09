-- Company promo codes, founding members, and the promo clock (2026-10-08).
--
-- One code per company we reach out to (FORTITUDE, ROOFPRO, ...). A code:
--   * can be redeemed ONCE, by the first account that enters it;
--   * stops working if nobody redeems it before expires_at;
--   * gives that account free_reports reports and access_days of full access,
--     counted from the moment THAT account redeems it, so contractors who sign
--     up weeks apart each get their own full window;
--   * marks the account a founding member for good (today's prices kept when
--     prices rise).
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS promo_codes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code          text NOT NULL UNIQUE,            -- stored upper-case
    company       text NOT NULL,                   -- who it was made for
    free_reports  integer NOT NULL DEFAULT 3 CHECK (free_reports >= 0),
    access_days   integer NOT NULL DEFAULT 7 CHECK (access_days >= 0),
    expires_at    timestamptz,                     -- unredeemed code dies after this
    notes         text,
    redeemed_by   uuid,                            -- the account that used it
    redeemed_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS promo_codes_redeemed_by_idx ON promo_codes (redeemed_by);

-- Codes are server-side only: no policy means no client can read or write them.
ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;

-- The promo clock and founder mark live on the account's subscription row, so
-- the access check answers in ONE read (same reason trial_report_used does).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS promo_reports_left   integer NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS promo_reports_total  integer NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS promo_access_until   timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS founding_member      boolean NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS founder_since        timestamptz;
-- So each email goes out once, however many times the check runs.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS promo_welcome_sent_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS promo_ended_sent_at   timestamptz;
