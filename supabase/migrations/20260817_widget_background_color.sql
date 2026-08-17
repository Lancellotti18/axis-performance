-- RoofIQ: separate the widget's PAGE BACKGROUND from its accent color.
--
-- `brand_color` only ever themed buttons and highlights, which surprised
-- contractors who set it expecting the page to change. Rather than overloading
-- one value (and risking unreadable button-on-background combinations), the
-- background is its own optional setting.
--
-- NULL = keep the default light gradient, which is the safe, legible baseline.
-- Stored as a hex string ("#0b1220"); validated as hex at the API layer, since
-- it is injected into a CSS variable on public pages.
alter table quote_widgets
  add column if not exists background_color text;
