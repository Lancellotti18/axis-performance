-- Dashboard briefing: let a contractor put one line away for a while.
--
-- Without decay a stale lead sits in the briefing for two weeks and trains the
-- reader to skim past the whole card — at which point the urgent lines stop
-- landing too. Snoozing is what keeps the list honest.
--
-- This started as localStorage, which worked but didn't follow the contractor
-- from the truck to the office: a line dismissed on the phone reappeared on the
-- laptop. Snoozes are per-user state, so they belong on the server.
--
-- `item_key` is the briefing item's stable key (e.g. "cold:leads",
-- "appt:<uuid>"), so a snooze survives the item being recomputed each morning.
create table if not exists briefing_snoozes (
  user_id       uuid        not null,
  item_key      text        not null,
  snoozed_until timestamptz not null,
  created_at    timestamptz not null default now(),
  primary key (user_id, item_key)
);

-- The briefing only ever asks "what is still snoozed for me, right now".
create index if not exists idx_briefing_snoozes_active
  on briefing_snoozes (user_id, snoozed_until);
