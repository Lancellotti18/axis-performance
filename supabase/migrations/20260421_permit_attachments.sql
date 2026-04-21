-- Permit requirement attachments.
-- Stores either an uploaded file (kind='file' with storage_path) or a
-- contractor-typed text blob (kind='text' with text_value) for each
-- required document in a permit package. One attachment per
-- (project_id, requirement_index) — upload/text replaces the prior one.
--
-- Also requires a Supabase Storage bucket `permit-attachments` with RLS:
--   (project_id in (select id from projects where user_id = auth.uid()))
-- Create that bucket via the Supabase dashboard or CLI; it cannot be
-- provisioned reliably from a SQL migration.

CREATE TABLE IF NOT EXISTS permit_attachments (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    requirement_index int  NOT NULL,
    kind              text NOT NULL CHECK (kind IN ('file', 'text')),
    filename          text,
    content_type      text,
    size_bytes        int,
    storage_path      text,
    text_value        text,
    uploaded_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, requirement_index)
);

CREATE INDEX IF NOT EXISTS idx_permit_attachments_project
    ON permit_attachments (project_id);

ALTER TABLE permit_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS permit_attachments_owner ON permit_attachments;
CREATE POLICY permit_attachments_owner
    ON permit_attachments
    FOR ALL
    USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()))
    WITH CHECK (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
