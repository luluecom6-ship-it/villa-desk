-- ============================================================
-- 060_agent_whatsapp_relay.sql — agents answer guests from their own WhatsApp
--
-- A guest writes to the villa WhatsApp number. The message is copied to the
-- on-duty agent's own WhatsApp (profiles.alert_phone). The agent swipe-replies
-- and the answer goes to the guest from the villa number and is saved in the
-- inbox. No reply in time -> next agent -> owner (migration 058 chain).
--
--   conversations.relay_code   short number shown to agents ("#482") so they can
--                              answer without swiping
--   relay_forwards             each copy sent to an agent, so a swipe-reply finds
--                              its guest (append-only)
-- Writes are server-side (service role). Idempotent.
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS relay_code_seq START 100;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS relay_code BIGINT;
UPDATE conversations SET relay_code = nextval('relay_code_seq') WHERE relay_code IS NULL;
ALTER TABLE conversations ALTER COLUMN relay_code SET DEFAULT nextval('relay_code_seq');
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_relay_code ON conversations (relay_code);

CREATE TABLE IF NOT EXISTS relay_forwards (
  id                  BIGSERIAL PRIMARY KEY,
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  user_id             UUID NOT NULL,
  forward_message_id  TEXT,   -- id of the copy sent to the agent (what a swipe-reply quotes)
  source_message_id   TEXT,   -- the guest's message id (so it is never sent twice)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_relay_forwards_fwd ON relay_forwards (account_id, forward_message_id);
CREATE INDEX IF NOT EXISTS idx_relay_forwards_user ON relay_forwards (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_relay_forwards_source
  ON relay_forwards (conversation_id, user_id, source_message_id) WHERE source_message_id IS NOT NULL;

ALTER TABLE relay_forwards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS relay_forwards_select ON relay_forwards;
CREATE POLICY relay_forwards_select ON relay_forwards
  FOR SELECT USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS relay_forwards_no_update ON relay_forwards;
CREATE TRIGGER relay_forwards_no_update BEFORE UPDATE ON relay_forwards
  FOR EACH ROW EXECUTE FUNCTION public.forbid_update();
DROP TRIGGER IF EXISTS relay_forwards_no_delete ON relay_forwards;
CREATE TRIGGER relay_forwards_no_delete BEFORE DELETE ON relay_forwards
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();
