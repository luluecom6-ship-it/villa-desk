-- ============================================================
-- 058_guest_message_escalation.sql
--
-- Every guest message that needs a person reaches an agent (caretaker). If
-- nobody replies within a few minutes it moves to the next available agent,
-- and when no agent is left, to the owner.
--
--   profiles.alert_phone   WhatsApp number (digits, country code) that gets the
--                          alert from the villa number. Optional: the bell in
--                          the app always works.
--   profiles.available     false = "off duty": skipped when choosing an agent.
--   properties.escalate_after_minutes   wait before moving on (default 10).
--   conversation_escalations  one row per guest message thread being chased.
--                          Rows are resolved, never deleted. No guest text.
-- Writes are server-side (service role). Idempotent.
-- ============================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS alert_phone TEXT;
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_alert_phone_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_alert_phone_check
  CHECK (alert_phone IS NULL OR alert_phone ~ '^[0-9]{8,15}$');
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS available BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS escalate_after_minutes INTEGER NOT NULL DEFAULT 10;
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_escalate_after_check;
ALTER TABLE properties ADD CONSTRAINT properties_escalate_after_check
  CHECK (escalate_after_minutes BETWEEN 1 AND 240);

CREATE TABLE IF NOT EXISTS conversation_escalations (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  conversation_id    UUID NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  stay_id            UUID REFERENCES stays(id) ON DELETE RESTRICT,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  notified_user_ids  UUID[] NOT NULL DEFAULT '{}',
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_notified_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_at             TIMESTAMPTZ NOT NULL,
  resolved_at        TIMESTAMPTZ,
  resolved_reason    TEXT CHECK (resolved_reason IS NULL OR resolved_reason IN ('replied', 'unanswered')),
  CONSTRAINT escalation_resolved_consistent CHECK ((status = 'open') = (resolved_at IS NULL))
);

-- One open chase per conversation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_escalations_open
  ON conversation_escalations (conversation_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_conversation_escalations_due
  ON conversation_escalations (status, due_at);

ALTER TABLE conversation_escalations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_escalations_select ON conversation_escalations;
CREATE POLICY conversation_escalations_select ON conversation_escalations
  FOR SELECT USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS conversation_escalations_no_delete ON conversation_escalations;
CREATE TRIGGER conversation_escalations_no_delete
  BEFORE DELETE ON conversation_escalations
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();
