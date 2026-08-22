-- Repair project_photos.
--
-- 20260731_project_photos.sql declared the table with `create table if not
-- exists`, but a table of that name already existed from an earlier feature
-- with an entirely different shape (storage_key / filename / url). The guard
-- did exactly what it says: it saw the name, skipped the statement, and
-- reported success — while every column the photo endpoint writes was missing.
--
-- The result: uploading a photo threw a Postgres "column does not exist" from
-- inside the insert, which escaped as a bare 500 Internal Server Error, and
-- project_photos stayed empty forever.
--
-- Additive and idempotent. The three legacy columns are left alone so anything
-- still reading them keeps working.

alter table project_photos add column if not exists user_id      uuid;
alter table project_photos add column if not exists storage_path text;
alter table project_photos add column if not exists caption      text;
alter table project_photos add column if not exists annotations  jsonb not null default '[]'::jsonb;
alter table project_photos add column if not exists sort_order   int   not null default 0;

-- Backfill from the legacy column where one exists, so any historic row can
-- still be located in storage.
update project_photos
   set storage_path = storage_key
 where storage_path is null
   and storage_key is not null;

create index if not exists idx_project_photos_project on project_photos(project_id);
create index if not exists idx_project_photos_phase   on project_photos(project_id, phase);
