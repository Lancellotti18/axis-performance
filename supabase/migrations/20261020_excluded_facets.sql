-- Sections a contractor marked "Not roof" (a tree or its shadow picked up as
-- roof). Kept on the run rather than in roof_facets so nothing that totals the
-- roof can count them; the editor shows them greyed out and can restore them.
alter table public.roof_measurement_runs
  add column if not exists excluded_facets jsonb not null default '[]'::jsonb;
