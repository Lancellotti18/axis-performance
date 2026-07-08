-- ============================================================================
-- Axis Performance — contractor price book (per-user material prices)
-- ============================================================================
-- Contractors know their negotiated supplier pricing (ABC/SRS/Beacon desk
-- rates). Until a formal supplier API partnership exists, the price book IS
-- the dealer connection: set your real price once per SKU and every estimate,
-- material list, CSV export, and report uses YOUR numbers instead of national
-- averages.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_material_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  sku TEXT NOT NULL,
  unit_cost NUMERIC NOT NULL CHECK (unit_cost >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_user_material_prices_user ON user_material_prices(user_id);
ALTER TABLE user_material_prices ENABLE ROW LEVEL SECURITY;
