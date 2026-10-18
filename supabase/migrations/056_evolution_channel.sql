-- ============================================================
-- 056_evolution_channel.sql — Evolution API (WhatsApp app number) channel
--
-- evolution_config     one row per account: the linked instance, its token
--                      (encrypted), webhook secret, live state, QR / pairing
--                      code while linking, and the safety settings.
--                      The Evolution server address and global key are NOT
--                      stored here: they are server env vars.
-- evolution_send_log   one row per send through the number (counts toward the
--                      daily warm-up limit and the auto-pause health check).
--                      Last 4 digits of the number only. Append-only.
-- evolution_event_log  connection events and webhook outcomes, no payloads,
--                      no message text, no numbers. Append-only.
--
-- Service role only (no policies): the token never reaches the browser.
-- Nothing here is ever deleted. Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS evolution_config (
  account_id          UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
  instance_name       TEXT NOT NULL,
  api_key             TEXT NOT NULL,                       -- instance token, encrypted
  webhook_secret      TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (state IN ('open', 'connecting', 'close', 'logged_out', 'unknown')),
  connected_number    TEXT,
  profile_name        TEXT,
  qr_code             TEXT,
  pairing_code        TEXT,
  qr_updated_at       TIMESTAMPTZ,
  last_event_at       TIMESTAMPTZ,
  -- Safety (PDR 8.5)
  warmup_started_at   TIMESTAMPTZ,
  max_daily           INTEGER NOT NULL DEFAULT 100,
  window_start_hour   INTEGER NOT NULL DEFAULT 9,
  window_end_hour     INTEGER NOT NULL DEFAULT 20,
  auto_pause          BOOLEAN NOT NULL DEFAULT TRUE,
  paused_at           TIMESTAMPTZ,
  paused_reason       TEXT,
  resumed_at          TIMESTAMPTZ,                         -- health check ignores sends before this
  created_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT evolution_config_window_check CHECK (
    window_start_hour BETWEEN 0 AND 23 AND window_end_hour BETWEEN 1 AND 24
    AND window_start_hour < window_end_hour AND max_daily BETWEEN 1 AND 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS evolution_config_secret_idx ON evolution_config (webhook_secret);
ALTER TABLE evolution_config ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS evolution_send_log (
  id          BIGSERIAL PRIMARY KEY,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ok          BOOLEAN NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'scheduled' CHECK (kind IN ('scheduled', 'reply', 'test')),
  phone_tail  TEXT CHECK (phone_tail IS NULL OR length(phone_tail) <= 4),
  error_code  TEXT
);
CREATE INDEX IF NOT EXISTS evolution_send_log_idx ON evolution_send_log (account_id, sent_at DESC);
ALTER TABLE evolution_send_log ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS evolution_event_log (
  id          BIGSERIAL PRIMARY KEY,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event       TEXT,
  outcome     TEXT
);
CREATE INDEX IF NOT EXISTS evolution_event_log_idx ON evolution_event_log (account_id, received_at DESC);
ALTER TABLE evolution_event_log ENABLE ROW LEVEL SECURITY;

-- Append-only logs (forbid_update / forbid_delete come from migration 053).
DROP TRIGGER IF EXISTS evolution_send_log_no_update ON evolution_send_log;
CREATE TRIGGER evolution_send_log_no_update BEFORE UPDATE ON evolution_send_log
  FOR EACH ROW EXECUTE FUNCTION public.forbid_update();
DROP TRIGGER IF EXISTS evolution_send_log_no_delete ON evolution_send_log;
CREATE TRIGGER evolution_send_log_no_delete BEFORE DELETE ON evolution_send_log
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();
DROP TRIGGER IF EXISTS evolution_event_log_no_update ON evolution_event_log;
CREATE TRIGGER evolution_event_log_no_update BEFORE UPDATE ON evolution_event_log
  FOR EACH ROW EXECUTE FUNCTION public.forbid_update();
DROP TRIGGER IF EXISTS evolution_event_log_no_delete ON evolution_event_log;
CREATE TRIGGER evolution_event_log_no_delete BEFORE DELETE ON evolution_event_log
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();
