-- Notifications: an in-app feed the contractor sees via the top-bar bell.
-- Events (bookings, accepted proposals, customer messages, …) insert a row;
-- the bell shows the unread count and the panel lists them newest-first.
-- App-layer ownership (service-role key), consistent with the rest of Axis.

CREATE TABLE IF NOT EXISTS notifications (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL,
    -- 'appointment' | 'proposal_accepted' | 'message' | 'system'
    type        text NOT NULL,
    title       text NOT NULL,
    body        text,
    link        text,                       -- in-app path to open (e.g. /crm)
    read        boolean NOT NULL DEFAULT false,
    metadata    jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Fast "my unread, newest first" + "my recent feed" queries.
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
    ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
    ON notifications (user_id, read) WHERE read = false;
