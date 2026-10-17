-- ============================================================
-- 055_stay_messages.sql — villa-desk M3: scheduled stay messages
--
--   * stay_messages          one row per (stay, message key). The unique key
--                            is what stops a retry or a double cron run from
--                            sending twice (PDR 7.3).
--   * stay_message_log       append-only record of every send decision,
--                            including blocked_not_registered. Holds only the
--                            last 4 digits of a phone, never a full number.
--   * stay_message_templates editable wording per message key.
--   * properties             + directions, review_url, villa_mode
--   * stays                  + on_the_way_at (guest replied READY)
--   * conversations          + channel (meta | evolution | NULL = default)
--   * notifications          + type 'stay_alert' for staff alerts
--
-- Cancelling a stay cancels its queued messages (trigger) and keeps every
-- record. Nothing is deleted.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE properties ADD COLUMN IF NOT EXISTS directions  TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS review_url  TEXT;
-- "Villa mode" (PDR 4.2): while on, upstream automations / flows / AI replies
-- only reach numbers that are on the stay allow-list.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS villa_mode  BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE stays ADD COLUMN IF NOT EXISTS on_the_way_at TIMESTAMPTZ;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_channel_check CHECK (channel IS NULL OR channel IN ('meta', 'evolution'));

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check CHECK (type IN ('conversation_assigned', 'stay_alert'));

-- ------------------------------------------------------------
-- stay_messages
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stay_messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  stay_id         UUID NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  message_key     TEXT NOT NULL CHECK (message_key IN (
                    'form_link', 'form_reminder_3d', 'form_reminder_2d', 'form_reminder_1d',
                    'id_alert_staff', 'arrival_info', 'access_details', 'owner_alert',
                    'arrival_check', 'checkout_reminder', 'review_request')),
  due_at          TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
                    'queued', 'sending', 'sent', 'failed', 'blocked_not_registered',
                    'skipped_condition', 'cancelled')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error      TEXT,
  sent_at         TIMESTAMPTZ,
  wa_message_id   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stay_messages_stay_key ON stay_messages(stay_id, message_key);
CREATE INDEX IF NOT EXISTS idx_stay_messages_due ON stay_messages(due_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_stay_messages_account ON stay_messages(account_id);

DROP TRIGGER IF EXISTS stay_messages_same_account ON stay_messages;
CREATE TRIGGER stay_messages_same_account
  BEFORE INSERT OR UPDATE OF account_id, stay_id ON stay_messages
  FOR EACH ROW EXECUTE FUNCTION public.stay_child_same_account();

DROP TRIGGER IF EXISTS stay_messages_updated_at ON stay_messages;
CREATE TRIGGER stay_messages_updated_at
  BEFORE UPDATE ON stay_messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE stay_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stay_messages_select ON stay_messages;
CREATE POLICY stay_messages_select ON stay_messages
  FOR SELECT USING (is_account_member(account_id, 'agent'));
-- Writes: scheduler and server routes only (service role).

-- Cancelling a stay stops its queued messages. Sent rows stay as history.
CREATE OR REPLACE FUNCTION public.stays_cancel_queued_messages()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    UPDATE stay_messages
       SET status = 'cancelled', last_error = 'stay_cancelled'
     WHERE stay_id = NEW.id AND status IN ('queued', 'sending');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stays_cancel_messages ON stays;
CREATE TRIGGER stays_cancel_messages
  AFTER UPDATE OF status ON stays
  FOR EACH ROW EXECUTE FUNCTION public.stays_cancel_queued_messages();

-- ------------------------------------------------------------
-- stay_message_log (append-only)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stay_message_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  stay_id     UUID REFERENCES stays(id) ON DELETE RESTRICT,
  message_key TEXT,
  direction   TEXT NOT NULL DEFAULT 'out' CHECK (direction IN ('out', 'in')),
  outcome     TEXT NOT NULL CHECK (outcome IN (
                'sent', 'failed', 'blocked_not_registered', 'skipped_condition', 'cancelled',
                'inbound_handled', 'inbound_ignored')),
  reason      TEXT,
  phone_tail  TEXT CHECK (phone_tail IS NULL OR phone_tail ~ '^[0-9]{1,4}$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stay_message_log_account ON stay_message_log(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stay_message_log_stay    ON stay_message_log(stay_id, created_at DESC);

DROP TRIGGER IF EXISTS stay_message_log_no_update ON stay_message_log;
CREATE TRIGGER stay_message_log_no_update
  BEFORE UPDATE ON stay_message_log
  FOR EACH ROW EXECUTE FUNCTION public.forbid_update();
DROP TRIGGER IF EXISTS stay_message_log_no_delete ON stay_message_log;
CREATE TRIGGER stay_message_log_no_delete
  BEFORE DELETE ON stay_message_log
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();

ALTER TABLE stay_message_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stay_message_log_select ON stay_message_log;
CREATE POLICY stay_message_log_select ON stay_message_log
  FOR SELECT USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- stay_message_templates: wording override per key. No row = built-in text.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stay_message_templates (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_key        TEXT NOT NULL,
  body               TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  -- Meta channel: name of the approved template to send instead of free text.
  meta_template_name TEXT,
  updated_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stay_message_templates_key ON stay_message_templates(account_id, message_key);

ALTER TABLE stay_message_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stay_message_templates_select ON stay_message_templates;
CREATE POLICY stay_message_templates_select ON stay_message_templates
  FOR SELECT USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS stay_message_templates_insert ON stay_message_templates;
CREATE POLICY stay_message_templates_insert ON stay_message_templates
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS stay_message_templates_update ON stay_message_templates;
CREATE POLICY stay_message_templates_update ON stay_message_templates
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
