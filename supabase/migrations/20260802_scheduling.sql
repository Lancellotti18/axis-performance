-- ============================================================================
-- Crew Scheduling & Dispatch — self-contained section (Milestone 1).
-- All tables are prefixed `sched_` so they never collide with existing tables,
-- and every row is keyed by `org_id` from day one so multi-tenancy can be added
-- later without a rewrite. No existing table is altered by this migration.
-- Enums are TEXT + CHECK for simple, migration-friendly evolution.
-- ============================================================================

-- Single seeded org for now (auth is stubbed). Everything keys off this.
-- 00000000-0000-0000-0000-000000000001

-- ---------- Organization ----------

create table if not exists sched_business_unit (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default '00000000-0000-0000-0000-000000000001',
  name        text not null,
  color_token text not null,
  sort_order  int  not null default 0,
  is_active   boolean not null default true
);

create table if not exists sched_person (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null default '00000000-0000-0000-0000-000000000001',
  first_name text not null,
  last_name  text not null,
  phone      text,
  avatar_url text,
  role       text not null check (role in ('FOREMAN','INSTALLER','APPRENTICE','SUBCONTRACTOR'))
);

create table if not exists sched_crew (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default '00000000-0000-0000-0000-000000000001',
  name             text not null,
  business_unit_id uuid not null references sched_business_unit(id) on delete cascade,
  lead_id          uuid references sched_person(id) on delete set null,
  is_active        boolean not null default true,
  -- PRODUCTION CAPACITY — the core differentiator
  squares_per_day          numeric(6,2) not null,
  tear_off_squares_per_day numeric(6,2) not null,
  max_pitch                numeric(3,1) not null default 12.0,
  max_stories              int not null default 2
);
create index if not exists idx_sched_crew_bu on sched_crew(org_id, business_unit_id);

create table if not exists sched_crew_membership (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default '00000000-0000-0000-0000-000000000001',
  crew_id     uuid not null references sched_crew(id) on delete cascade,
  person_id   uuid not null references sched_person(id) on delete cascade,
  is_floating boolean not null default false,
  unique (crew_id, person_id)
);

create table if not exists sched_crew_skill (
  id      uuid primary key default gen_random_uuid(),
  org_id  uuid not null default '00000000-0000-0000-0000-000000000001',
  crew_id uuid not null references sched_crew(id) on delete cascade,
  skill   text not null check (skill in ('ASPHALT_SHINGLE','METAL','TILE','FLAT_TPO','GUTTER','SIDING','STEEP_SLOPE')),
  unique (crew_id, skill)
);

-- ---------- Availability ----------

create table if not exists sched_shift (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null default '00000000-0000-0000-0000-000000000001',
  crew_id    uuid not null references sched_crew(id) on delete cascade,
  date       date not null,
  start_time text not null,   -- "07:00" local HH:mm
  end_time   text not null,   -- "17:00"
  type       text not null default 'REGULAR' check (type in ('REGULAR','OVERTIME','ON_CALL')),
  unique (crew_id, date)
);
create index if not exists idx_sched_shift_date on sched_shift(org_id, date);

create table if not exists sched_non_job_event (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default '00000000-0000-0000-0000-000000000001',
  crew_id         uuid not null references sched_crew(id) on delete cascade,
  title           text not null,
  start_at        timestamptz not null,
  end_at          timestamptz not null,
  blocks_capacity boolean not null default true
);
create index if not exists idx_sched_nonjob_crew on sched_non_job_event(org_id, crew_id, start_at);

-- ---------- Work ----------

create table if not exists sched_customer (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null default '00000000-0000-0000-0000-000000000001',
  first_name text not null,
  last_name  text not null,
  phone      text,
  email      text
);

create table if not exists sched_property (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default '00000000-0000-0000-0000-000000000001',
  line1       text not null,
  city        text not null,
  state       text not null,
  postal_code text not null,
  lat         double precision not null,
  lng         double precision not null
);

create table if not exists sched_job (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default '00000000-0000-0000-0000-000000000001',
  job_number       bigserial unique,
  business_unit_id uuid not null references sched_business_unit(id) on delete cascade,
  customer_id      uuid not null references sched_customer(id) on delete cascade,
  property_id      uuid not null references sched_property(id) on delete cascade,
  job_type text not null check (job_type in
    ('REROOF','NEW_ROOF_INSTALL','ROOF_REPAIR','GUTTER_REPAIR','GUTTER_INSTALL','SIDING_REPAIR','NEW_SIDING_INSTALL','INSPECTION')),
  status text not null default 'SOLD' check (status in
    ('ESTIMATE','SOLD','SCHEDULED','IN_PROGRESS','COMPLETE','ON_HOLD','CANCELED')),
  priority text not null default 'ROUTINE' check (priority in ('ROUTINE','HIGH','URGENT')),
  sold_amount    numeric(10,2),
  estimated_cost numeric(10,2),
  -- link to the measurement engine (Axis roof_measurement_runs); read-only usage
  measurement_run_id uuid,
  squares            numeric(6,2),
  predominant_pitch  numeric(3,1),
  stories            int,
  tear_off_layers    int not null default 0,
  waste_factor_pct   numeric(4,2),
  deadline           date,
  notes              text,
  created_at         timestamptz not null default now()
);
create index if not exists idx_sched_job_status on sched_job(org_id, status);
create index if not exists idx_sched_job_bu on sched_job(org_id, business_unit_id);

create table if not exists sched_appointment (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default '00000000-0000-0000-0000-000000000001',
  job_id          uuid not null references sched_job(id) on delete cascade,
  sequence        int not null default 1,      -- day 1 of 3 ...
  total_in_series int not null default 1,
  scheduled_start timestamptz not null,
  scheduled_end   timestamptz not null,
  status text not null default 'SCHEDULED' check (status in
    ('UNASSIGNED','SCHEDULED','DISPATCHED','WORKING','PAUSED','DONE','CANCELED','HOLD')),
  planned_squares numeric(6,2),
  waive_trip_fee  boolean not null default false,
  arrival_window_start timestamptz,
  arrival_window_end   timestamptz,
  customer_confirmed_at timestamptz,
  -- FLYWHEEL: capture actuals from day one so crew-throughput learning can accrue
  actual_squares  numeric(6,2),
  started_at      timestamptz,
  completed_at    timestamptz
);
create index if not exists idx_sched_appt_range on sched_appointment(org_id, scheduled_start);
create index if not exists idx_sched_appt_job on sched_appointment(job_id);

create table if not exists sched_assignment (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default '00000000-0000-0000-0000-000000000001',
  appointment_id uuid not null references sched_appointment(id) on delete cascade,
  crew_id        uuid not null references sched_crew(id) on delete cascade,
  is_primary     boolean not null default true,
  unique (appointment_id, crew_id)
);
create index if not exists idx_sched_assignment_crew on sched_assignment(org_id, crew_id);

-- ---------- Tags ----------

create table if not exists sched_job_tag (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default '00000000-0000-0000-0000-000000000001',
  label       text not null,
  color_token text not null,
  severity    text not null default 'INFO' check (severity in ('INFO','WARN','CRITICAL')),
  icon        text
);

create table if not exists sched_job_tag_link (
  org_id uuid not null default '00000000-0000-0000-0000-000000000001',
  job_id uuid not null references sched_job(id) on delete cascade,
  tag_id uuid not null references sched_job_tag(id) on delete cascade,
  primary key (job_id, tag_id)
);

-- ---------- Weather ----------

create table if not exists sched_weather_day (
  id                 uuid primary key default gen_random_uuid(),
  date               date not null,
  postal_prefix      text not null,        -- first 3 of zip
  precip_probability int  not null,        -- 0-100
  precip_inches      numeric(4,2) not null default 0,
  wind_mph           int not null default 0,
  temp_high_f        int,
  temp_low_f         int,
  fetched_at         timestamptz not null default now(),
  unique (date, postal_prefix)
);

-- ---------- Audit (who moved this job) ----------

create table if not exists sched_audit_event (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default '00000000-0000-0000-0000-000000000001',
  actor_id    text,
  entity_type text not null,
  entity_id   uuid,
  action      text not null,
  before_json jsonb,
  after_json  jsonb,
  request_id  text,                         -- idempotency for bulk ops / undo
  created_at  timestamptz not null default now()
);
create index if not exists idx_sched_audit_entity on sched_audit_event(org_id, entity_type, entity_id, created_at);
