-- project_photos.storage_key blocked every upload.
--
-- 20260822_project_photos_repair added the columns the photo endpoint writes
-- (storage_path, user_id, caption, annotations, sort_order) and deliberately
-- left the three legacy columns alone "so anything still reading them keeps
-- working". But storage_key is NOT NULL with no default, and no code writes it,
-- so every insert died on:
--
--   null value in column "storage_key" violates not-null constraint  (23502)
--
-- The endpoint now writes storage_key alongside storage_path, so uploads work
-- without this migration. This drops the constraint so the legacy column can
-- eventually be retired without the write being load-bearing.
--
-- Idempotent and non-destructive: the column and its data stay.

alter table project_photos alter column storage_key drop not null;

-- Same trap, same table: filename/url are legacy too. Only relax them if they
-- are actually NOT NULL — on a table where they are already nullable this is a
-- no-op rather than an error.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_name = 'project_photos' and column_name = 'url'
       and is_nullable = 'NO'
  ) then
    alter table project_photos alter column url drop not null;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_name = 'project_photos' and column_name = 'filename'
       and is_nullable = 'NO'
  ) then
    alter table project_photos alter column filename drop not null;
  end if;
end $$;
