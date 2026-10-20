-- ============================================================
-- 061_guest_menu_state.sql — the guest's WhatsApp menu
--
-- A registered guest who writes "hi" gets a numbered menu from the villa number
-- (update ID / form, WiFi and access, caretaker, food, on my way). Their next reply
-- is read as a menu choice only for a short while, so a plain "2" in a normal
-- conversation is never mistaken for one.
--
--   conversations.guest_menu_state  null | 'main' | 'food'
--   conversations.guest_menu_at     when the menu / question was sent
-- Written by the server (service role). Idempotent.
-- ============================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS guest_menu_state TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS guest_menu_at TIMESTAMPTZ;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_guest_menu_state_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_guest_menu_state_check
  CHECK (guest_menu_state IS NULL OR guest_menu_state IN ('main', 'food'));
