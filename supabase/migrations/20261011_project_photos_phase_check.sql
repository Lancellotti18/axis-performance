-- Widen project_photos.phase to the phases the gallery actually uses.
--
-- The table pre-dates the current photo gallery (see 20260822_project_photos_repair).
-- Its old shape carried a check constraint allowing only before / during / after,
-- while the gallery writes before / progress / damage / completed — so every
-- upload outside "Before" failed with:
--   new row for relation "project_photos" violates check constraint "project_photos_phase_check"
--
-- Legacy rows are renamed to the current vocabulary so they land in the right
-- section. Idempotent.

alter table project_photos drop constraint if exists project_photos_phase_check;

update project_photos set phase = 'progress'  where phase = 'during';
update project_photos set phase = 'completed' where phase = 'after';

alter table project_photos
  add constraint project_photos_phase_check
  check (phase in ('before', 'progress', 'damage', 'completed'));
