-- New-project flow (#2): projects now start from an address + customer instead of
-- a blueprint upload. Store the geocoded county/lat/lng (auto-filled from the
-- address) and the optional customer contact so the whole record is captured up
-- front and the satellite/roof workflow can run off the address.
alter table projects
  add column if not exists county          text,
  add column if not exists lat             double precision,
  add column if not exists lng             double precision,
  add column if not exists customer_name   text,
  add column if not exists customer_phone  text,
  add column if not exists customer_email  text;
