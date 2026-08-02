-- Project photos: a crew-facing gallery per project, organized by job phase,
-- with per-photo captions and non-destructive markup (arrows/circles/text pins).
-- App-layer ownership (service-role key), consistent with the rest of the app.

create table if not exists project_photos (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  user_id      uuid not null,
  -- before | progress | damage | completed  (phases feed the before/after report)
  phase        text not null default 'before',
  storage_path text not null,              -- key in the 'blueprints' bucket
  caption      text,
  annotations  jsonb not null default '[]'::jsonb,  -- [{type,x,y,...}] fractional coords
  sort_order   int  not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists idx_project_photos_project on project_photos(project_id);
create index if not exists idx_project_photos_phase   on project_photos(project_id, phase);

-- One shareable, read-only crew link per project. The unguessable token IS the
-- auth (same pattern as client_portals) — crews view on their phone, no login.
create table if not exists project_photo_shares (
  project_id uuid primary key references projects(id) on delete cascade,
  user_id    uuid not null,
  token      text not null unique,
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);
