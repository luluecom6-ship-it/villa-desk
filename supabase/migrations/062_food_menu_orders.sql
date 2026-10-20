-- ============================================================
-- 062_food_menu_orders.sql — food menu and guest food orders
--
-- The owner or a caretaker keeps the menu (names, prices in INR, a menu picture).
-- A registered guest picks "Food" on the WhatsApp menu, sees the picture and the
-- numbered list, and replies with item numbers. The order goes to the caretaker;
-- once approved the guest is told it will be delivered.
--
--   food_items               the menu (a dish is switched off, never deleted)
--   food_orders              each order, with the items and prices as ordered
--                            (a snapshot, so later price changes never rewrite it)
--   properties.food_menu_image_url   the menu picture sent to guests
-- Writes are server-side (service role). Orders are never deleted. Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS food_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  price       NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_food_items_account ON food_items(account_id, sort_order);

DROP TRIGGER IF EXISTS food_items_updated_at ON food_items;
CREATE TRIGGER food_items_updated_at
  BEFORE UPDATE ON food_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE food_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS food_items_select ON food_items;
CREATE POLICY food_items_select ON food_items
  FOR SELECT USING (is_account_member(account_id, 'agent'));

CREATE TABLE IF NOT EXISTS food_orders (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  order_no        BIGINT GENERATED ALWAYS AS IDENTITY,
  stay_id         UUID REFERENCES stays(id),
  conversation_id UUID,
  guest_name      TEXT,
  -- [{ "name": "Idli", "price": 100, "qty": 2 }]
  items           JSONB NOT NULL,
  total           NUMERIC(10,2) NOT NULL CHECK (total >= 0),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'confirmed', 'declined')),
  decided_by      UUID,
  decided_by_name TEXT,
  decided_at      TIMESTAMPTZ,
  decline_reason  TEXT CHECK (decline_reason IS NULL OR length(decline_reason) <= 300),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT food_orders_decision_check CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_food_orders_account ON food_orders(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_food_orders_conversation ON food_orders(conversation_id, status);

ALTER TABLE food_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS food_orders_select ON food_orders;
CREATE POLICY food_orders_select ON food_orders
  FOR SELECT USING (is_account_member(account_id, 'agent'));

CREATE OR REPLACE FUNCTION food_orders_forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'food orders cannot be deleted';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS food_orders_no_delete ON food_orders;
CREATE TRIGGER food_orders_no_delete BEFORE DELETE ON food_orders
  FOR EACH ROW EXECUTE FUNCTION food_orders_forbid_delete();

ALTER TABLE properties ADD COLUMN IF NOT EXISTS food_menu_image_url TEXT;
