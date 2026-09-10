-- Usage metering: what the AI actually costs, and how many reports each
-- contractor generated.
--
-- Neither number existed. Model choice was being argued from `max_tokens`
-- caps rather than measurement, and reports were written to object storage
-- with no database record at all — so "20 reports/month included" was a plan
-- nobody could enforce and a cost nobody could attribute.
--
-- Two tables rather than one: they answer different questions on different
-- cadences. llm_usage is high-volume and diagnostic (which provider, which
-- model, what did this run cost); report_events is low-volume and is the
-- billing record. Rolling reports up from llm_usage would tie the billing
-- number to the AI plumbing, which is exactly the coupling to avoid.

-- ── Every model call, with what it cost ────────────────────────────────────
CREATE TABLE IF NOT EXISTS llm_usage (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid,                    -- null for unauthenticated paths
    run_id         uuid,                    -- roof run this call belonged to
    provider       text NOT NULL,           -- 'gemini' | 'groq' | 'anthropic'
    model          text NOT NULL,
    kind           text NOT NULL,           -- 'text' | 'vision'
    input_tokens   integer NOT NULL DEFAULT 0,
    output_tokens  integer NOT NULL DEFAULT 0,
    -- Priced at call time from the rate table in llm_usage.py. Stored rather
    -- than derived so a later price change does not silently rewrite history.
    cost_usd       numeric(12, 6) NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS llm_usage_user_created_idx
    ON llm_usage (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_run_idx
    ON llm_usage (run_id) WHERE run_id IS NOT NULL;
-- "what did each model cost us this month" without scanning the table.
CREATE INDEX IF NOT EXISTS llm_usage_created_idx
    ON llm_usage (created_at DESC);

-- ── One row per report generated — the billing record ──────────────────────
CREATE TABLE IF NOT EXISTS report_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL,
    run_id      uuid NOT NULL,
    -- A contractor re-downloading a report they already paid for must not be
    -- billed twice. The first generation for a run is 'generate'; every
    -- rebuild after that is 'rebuild' and does not count against the plan.
    kind        text NOT NULL DEFAULT 'generate',
    bytes       integer,                    -- PDF size, for storage forecasting
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_events_user_created_idx
    ON report_events (user_id, created_at DESC);
-- The allowance query: billable reports for one contractor this period.
CREATE INDEX IF NOT EXISTS report_events_billable_idx
    ON report_events (user_id, created_at DESC) WHERE kind = 'generate';
