-- Dispatch ↔ project link: a scheduled job can point at the real roofing
-- project (its satellite/outline, report, and crew photos), so the dispatcher
-- can open everything about a job from the board. One-way: CRM/deal → project →
-- scheduled onto dispatch. ON DELETE SET NULL so removing a project just unlinks.
alter table sched_job
  add column if not exists project_id uuid references projects(id) on delete set null;
create index if not exists idx_sched_job_project on sched_job(project_id);
