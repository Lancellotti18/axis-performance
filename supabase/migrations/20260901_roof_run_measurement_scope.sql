-- Partial roof measurements, as a first-class state.
--
-- Not every roof gets fully outlined — a contractor may trace only the section
-- being replaced. The system had no way to say so, which left two bad options:
-- the report presented a part as though it were the whole roof (a 44-square
-- number on an 83-square house), or the validators hard-blocked it with a
-- message about double-counted edges that had nothing to do with the cause.
--
-- 'full' is the default, so every existing run keeps its current meaning.

alter table roof_measurement_runs
  add column if not exists measurement_scope text not null default 'full';

alter table roof_measurement_runs
  add column if not exists scope_note text;

do $$
begin
  if not exists (
    select 1 from information_schema.constraint_column_usage
     where table_name = 'roof_measurement_runs' and constraint_name = 'roof_run_scope_valid'
  ) then
    alter table roof_measurement_runs
      add constraint roof_run_scope_valid check (measurement_scope in ('full', 'partial'));
  end if;
end $$;
