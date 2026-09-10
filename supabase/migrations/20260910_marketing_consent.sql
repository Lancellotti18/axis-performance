-- Marketing consent — separate from the Terms/Privacy acceptance on purpose.
--
-- Those two are contract terms: required, versioned, and accepted once per
-- version. This is permission to SOLICIT someone, and it is a different animal:
--
--   * It must be refusable. Under the TCPA you may not condition access to a
--     product on consent to receive marketing texts. A required checkbox does
--     not produce weak consent — it produces NO valid consent, plus written
--     evidence that service was conditioned on it. So this is optional and
--     unchecked, and the signup button does not wait on it.
--   * It changes on its own schedule. Someone unsubscribes from texts without
--     re-accepting the Terms, so it cannot live as a column on that row.
--   * It must be provable. Damages run $500–1,500 per message with no cap, and
--     the defence is showing what someone agreed to and when — hence
--     consent_text, which stores the exact wording that was on screen.
--
-- One row per change rather than one row per user: the history is the record.
-- Current state is the newest row for a (user_id, channel).

CREATE TABLE IF NOT EXISTS marketing_consent (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL,
    -- Split even though one checkbox grants both, because SMS is governed far
    -- more strictly than email and someone will want to leave one and keep the
    -- other. Merging them now would mean a migration the first time that happens.
    channel       text NOT NULL,              -- 'sms' | 'email'
    granted       boolean NOT NULL,
    -- Where it came from: 'signup_gate', 'settings', 'unsubscribe_link', …
    source        text,
    -- The exact sentence shown when they agreed. This is the evidence.
    consent_text  text,
    ip_address    text,
    user_agent    text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- "What is this contractor's current permission?" — newest row per channel.
CREATE INDEX IF NOT EXISTS marketing_consent_user_channel_idx
    ON marketing_consent (user_id, channel, created_at DESC);

-- "Who may we text right now?" for building a send list.
CREATE INDEX IF NOT EXISTS marketing_consent_granted_idx
    ON marketing_consent (channel, created_at DESC) WHERE granted = true;

do $$
begin
  if not exists (
    select 1 from information_schema.constraint_column_usage
     where table_name = 'marketing_consent' and constraint_name = 'marketing_consent_channel_valid'
  ) then
    alter table marketing_consent
      add constraint marketing_consent_channel_valid check (channel in ('sms', 'email'));
  end if;
end $$;
