-- RoofIQ (item A): per-contractor brand accent color for the report + quote page.
-- Cosmetic white-label — buttons and highlights pick it up; layout, trust
-- language, and the "Powered by Axis" footer stay locked. NULL = default blue.
-- Stored as a hex string ("#2563eb"); validated as hex at the API layer.
alter table quote_widgets
  add column if not exists brand_color text;
