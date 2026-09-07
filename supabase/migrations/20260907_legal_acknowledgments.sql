-- Legal acknowledgments: proof that a contractor accepted the Terms of Service
-- and Privacy Policy before using Axis.
--
-- Why a table and not a boolean on the user: consent has to be provable and
-- versioned. If the ToS changes (new pricing clause, a widened data-licensing
-- grant), everyone must accept the NEW version — a single boolean cannot say
-- WHICH document someone agreed to, or when. One row per acceptance keeps the
-- full audit trail; the app asks "has this user accepted the versions that are
-- current right now?" and re-prompts when the answer is no.
--
-- ip_address / user_agent are recorded because a consent record that cannot be
-- tied to a session is weak evidence in a dispute. Both are nullable — a
-- missing value never blocks acceptance.
--
-- App-layer ownership (service-role key), consistent with the rest of Axis.

CREATE TABLE IF NOT EXISTS legal_acknowledgments (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL,
    tos_version       text NOT NULL,
    privacy_version   text NOT NULL,
    ip_address        text,
    user_agent        text,
    accepted_at       timestamptz NOT NULL DEFAULT now()
);

-- One acceptance per user per version pair. Re-accepting the same versions is
-- a no-op rather than a duplicate row (the API upserts on this constraint).
CREATE UNIQUE INDEX IF NOT EXISTS legal_ack_user_versions_idx
    ON legal_acknowledgments (user_id, tos_version, privacy_version);

-- The hot path: "what has this user accepted?" on every dashboard load.
CREATE INDEX IF NOT EXISTS legal_ack_user_idx
    ON legal_acknowledgments (user_id, accepted_at DESC);
