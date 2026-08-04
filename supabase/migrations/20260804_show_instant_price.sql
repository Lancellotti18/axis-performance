-- RoofIQ (item B): per-contractor toggle to show the instant estimate range on
-- the homeowner report + quote funnel. Opt-in — OFF by default, so existing
-- widgets keep hiding price until the contractor turns it on in RoofIQ settings
-- ("Show these prices to homeowners").
alter table quote_widgets
  add column if not exists show_instant_price boolean not null default false;
