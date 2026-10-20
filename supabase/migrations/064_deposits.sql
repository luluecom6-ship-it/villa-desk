-- ============================================================
-- 064_deposits.sql  (PDR section 9, Form 3)
--
-- Refundable security deposit per stay. The app only RECORDS the money; it never
-- moves it. One row per stay (a stay with no row = "not recorded yet"; platform
-- bookings read as "Not required" in the app). Owner/admin only: caretakers and
-- viewers cannot read amounts (RLS). Writes go through the server (service role).
-- Never deleted. Every change is written to deposit_audit (append-only) by a trigger,
-- with the old and new values. Checking a stay out moves a Held deposit to
-- Refund due. Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS deposits (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  stay_id           UUID NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('not_required', 'pending', 'held', 'refund_due', 'refunded', 'partly_deducted')),
  amount            NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  mode              TEXT CHECK (mode IS NULL OR mode IN ('upi', 'cash', 'bank_transfer')),
  received_at       TIMESTAMPTZ,
  received_by       UUID,
  received_by_name  TEXT,
  reference_note    TEXT CHECK (reference_note IS NULL OR char_length(reference_note) <= 300),
  deducted_amount   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (deducted_amount >= 0),
  deduction_reason  TEXT CHECK (deduction_reason IS NULL OR char_length(deduction_reason) <= 300),
  refunded_at       TIMESTAMPTZ,
  refund_reference  TEXT CHECK (refund_reference IS NULL OR char_length(refund_reference) <= 300),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT deposits_deduction_within_amount CHECK (deducted_amount <= amount),
  CONSTRAINT deposits_deduction_needs_reason CHECK (deducted_amount = 0 OR deduction_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_deposits_stay ON deposits (stay_id);
CREATE INDEX IF NOT EXISTS idx_deposits_account_status ON deposits (account_id, status);

DROP TRIGGER IF EXISTS deposits_updated_at ON deposits;
CREATE TRIGGER deposits_updated_at BEFORE UPDATE ON deposits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deposits_select ON deposits;
CREATE POLICY deposits_select ON deposits
  FOR SELECT USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS deposits_no_delete ON deposits;
CREATE TRIGGER deposits_no_delete BEFORE DELETE ON deposits
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();

-- ---- audit (append-only) -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS deposit_audit (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  stay_id     UUID NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  deposit_id  UUID NOT NULL REFERENCES deposits(id) ON DELETE RESTRICT,
  action      TEXT NOT NULL CHECK (action IN ('created', 'updated')),
  old_values  JSONB,
  new_values  JSONB NOT NULL,
  changed_by  UUID,
  changed_by_name TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deposit_audit_stay ON deposit_audit (stay_id, created_at DESC);

ALTER TABLE deposit_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deposit_audit_select ON deposit_audit;
CREATE POLICY deposit_audit_select ON deposit_audit
  FOR SELECT USING (is_account_member(account_id, 'admin'));
DROP TRIGGER IF EXISTS deposit_audit_no_update ON deposit_audit;
CREATE TRIGGER deposit_audit_no_update BEFORE UPDATE ON deposit_audit
  FOR EACH ROW EXECUTE FUNCTION public.forbid_update();
DROP TRIGGER IF EXISTS deposit_audit_no_delete ON deposit_audit;
CREATE TRIGGER deposit_audit_no_delete BEFORE DELETE ON deposit_audit
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();

-- Who changed it comes from a transaction setting the server writes just before the
-- change (app.actor_id / app.actor_name); empty for system changes (e.g. check-out).
CREATE OR REPLACE FUNCTION public.deposits_audit_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor TEXT := NULLIF(current_setting('app.actor_id', TRUE), '');
  v_name  TEXT := NULLIF(current_setting('app.actor_name', TRUE), '');
BEGIN
  INSERT INTO deposit_audit (account_id, stay_id, deposit_id, action, old_values, new_values, changed_by, changed_by_name)
  VALUES (
    NEW.account_id, NEW.stay_id, NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'updated' END,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) - 'updated_at' END,
    to_jsonb(NEW) - 'updated_at',
    CASE WHEN v_actor ~ '^[0-9a-fA-F-]{36}$' THEN v_actor::uuid ELSE NULL END,
    v_name
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deposits_audit ON deposits;
CREATE TRIGGER deposits_audit
  AFTER INSERT OR UPDATE ON deposits
  FOR EACH ROW EXECUTE FUNCTION public.deposits_audit_row();

-- Check-out: a Held deposit becomes Refund due (PDR 9).
CREATE OR REPLACE FUNCTION public.stays_deposit_refund_due()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'checked_out' AND OLD.status IS DISTINCT FROM 'checked_out' THEN
    UPDATE deposits SET status = 'refund_due' WHERE stay_id = NEW.id AND status = 'held';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stays_deposit_refund ON stays;
CREATE TRIGGER stays_deposit_refund
  AFTER UPDATE OF status ON stays
  FOR EACH ROW EXECUTE FUNCTION public.stays_deposit_refund_due();

-- Staff save through one function so the actor and the change land in one transaction.
CREATE OR REPLACE FUNCTION public.save_deposit(
  p_account_id UUID, p_stay_id UUID, p_actor UUID, p_actor_name TEXT, p_values JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row deposits;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stays WHERE id = p_stay_id AND account_id = p_account_id) THEN
    RAISE EXCEPTION 'deposit:not_found';
  END IF;
  PERFORM set_config('app.actor_id', COALESCE(p_actor::text, ''), TRUE);
  PERFORM set_config('app.actor_name', COALESCE(p_actor_name, ''), TRUE);

  INSERT INTO deposits (account_id, stay_id, status, amount, mode, received_at, received_by, received_by_name,
                        reference_note, deducted_amount, deduction_reason, refunded_at, refund_reference)
  VALUES (
    p_account_id, p_stay_id,
    COALESCE(p_values->>'status', 'pending'),
    COALESCE((p_values->>'amount')::numeric, 0),
    NULLIF(p_values->>'mode', ''),
    NULLIF(p_values->>'received_at', '')::timestamptz,
    CASE WHEN NULLIF(p_values->>'received_at', '') IS NOT NULL THEN p_actor END,
    CASE WHEN NULLIF(p_values->>'received_at', '') IS NOT NULL THEN p_actor_name END,
    NULLIF(p_values->>'reference_note', ''),
    COALESCE((p_values->>'deducted_amount')::numeric, 0),
    NULLIF(p_values->>'deduction_reason', ''),
    NULLIF(p_values->>'refunded_at', '')::timestamptz,
    NULLIF(p_values->>'refund_reference', '')
  )
  ON CONFLICT (stay_id) DO UPDATE SET
    status           = EXCLUDED.status,
    amount           = EXCLUDED.amount,
    mode             = EXCLUDED.mode,
    received_at      = EXCLUDED.received_at,
    received_by      = CASE WHEN EXCLUDED.received_at IS DISTINCT FROM deposits.received_at THEN EXCLUDED.received_by ELSE deposits.received_by END,
    received_by_name = CASE WHEN EXCLUDED.received_at IS DISTINCT FROM deposits.received_at THEN EXCLUDED.received_by_name ELSE deposits.received_by_name END,
    reference_note   = EXCLUDED.reference_note,
    deducted_amount  = EXCLUDED.deducted_amount,
    deduction_reason = EXCLUDED.deduction_reason,
    refunded_at      = EXCLUDED.refunded_at,
    refund_reference = EXCLUDED.refund_reference
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$$;

REVOKE ALL ON FUNCTION public.save_deposit(UUID, UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_deposit(UUID, UUID, UUID, TEXT, JSONB) TO service_role;
