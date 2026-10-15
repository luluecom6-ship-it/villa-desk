-- ============================================================
-- 047_properties.sql — villa-desk: the rented property
--
-- One account = one business. Phase 1 ships with a single property
-- row per account, but every stay carries property_id from day one
-- so several villas can be supported later (PDR section 2).
--
-- Reads: any account member. Writes: admin and above.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS properties (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  address             TEXT,
  map_url             TEXT,
  -- Gate and lock instructions, sent only in the access_details message.
  access_instructions TEXT,
  caretaker_phone     TEXT,
  default_checkin_time  TIME NOT NULL DEFAULT '14:00',
  default_checkout_time TIME NOT NULL DEFAULT '11:00',
  timezone            TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  -- Which WhatsApp channel new chats use. Per-chat override lives on
  -- conversations.channel (added in migration 055).
  default_channel     TEXT NOT NULL DEFAULT 'evolution'
                        CHECK (default_channel IN ('meta', 'evolution')),
  -- Shown in the checkout message ("refund within N working days").
  deposit_refund_days INTEGER NOT NULL DEFAULT 3 CHECK (deposit_refund_days >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_properties_account ON properties(account_id);

DROP TRIGGER IF EXISTS properties_updated_at ON properties;
CREATE TRIGGER properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS properties_select ON properties;
CREATE POLICY properties_select ON properties
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS properties_insert ON properties;
CREATE POLICY properties_insert ON properties
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS properties_update ON properties;
CREATE POLICY properties_update ON properties
  FOR UPDATE USING (is_account_member(account_id, 'admin'));

-- No DELETE policy on purpose: a property with stays must never vanish.
