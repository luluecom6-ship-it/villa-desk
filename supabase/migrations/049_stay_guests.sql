-- ============================================================
-- 049_stay_guests.sql — villa-desk: lead guest and occupants
--
-- One row per person on a stay (PDR 6.2). The lead guest is created
-- from the public form; occupants are the extra adults and children.
--
-- Privacy rule (PDR 6.3): only the LAST 4 characters of an ID number
-- are stored as text. The full number is never typed into the
-- database; the image lives in the private bucket (migration 050).
--
-- Reads: any account member. Writes: admin and above.
-- A stay with guests cannot be deleted (NO ACTION foreign key).
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS stay_guests (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  stay_id     UUID NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,

  role        TEXT NOT NULL CHECK (role IN ('lead', 'occupant')),
  full_name   TEXT NOT NULL,
  age         INTEGER CHECK (age IS NULL OR (age >= 0 AND age <= 120)),
  is_adult    BOOLEAN NOT NULL DEFAULT TRUE,

  mobile      TEXT,
  email       TEXT,
  nationality TEXT,
  address     TEXT,

  id_type     TEXT CHECK (id_type IS NULL OR id_type IN
                ('aadhaar', 'passport', 'driving_licence', 'voter_id', 'other')),
  id_last4    TEXT CHECK (id_last4 IS NULL OR id_last4 ~ '^[0-9A-Za-z]{4}$'),

  -- ID review by staff. verified and rejected are mutually exclusive.
  id_verified_at   TIMESTAMPTZ,
  id_verified_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  id_rejected_at   TIMESTAMPTZ,
  id_reject_reason TEXT,

  -- Foreign guests (Form C).
  is_foreign        BOOLEAN NOT NULL DEFAULT FALSE,
  form_c_required   BOOLEAN NOT NULL DEFAULT FALSE,
  visa_type         TEXT,
  visa_expiry       DATE,
  arrived_in_india_on DATE,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT stay_guests_not_both_verified_and_rejected
    CHECK (NOT (id_verified_at IS NOT NULL AND id_rejected_at IS NOT NULL))
);

-- Exactly one lead guest per stay.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stay_guests_one_lead
  ON stay_guests(stay_id) WHERE role = 'lead';
CREATE INDEX IF NOT EXISTS idx_stay_guests_stay    ON stay_guests(stay_id);
CREATE INDEX IF NOT EXISTS idx_stay_guests_account ON stay_guests(account_id);

DROP TRIGGER IF EXISTS stay_guests_updated_at ON stay_guests;
CREATE TRIGGER stay_guests_updated_at
  BEFORE UPDATE ON stay_guests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Keep the child row in the same account as its stay.
CREATE OR REPLACE FUNCTION public.stay_child_same_account()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_account UUID;
BEGIN
  SELECT account_id INTO v_account FROM stays WHERE id = NEW.stay_id;
  IF v_account IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'account_id does not match the stay''s account';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stay_guests_same_account ON stay_guests;
CREATE TRIGGER stay_guests_same_account
  BEFORE INSERT OR UPDATE OF account_id, stay_id ON stay_guests
  FOR EACH ROW EXECUTE FUNCTION public.stay_child_same_account();

ALTER TABLE stay_guests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stay_guests_select ON stay_guests;
CREATE POLICY stay_guests_select ON stay_guests
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS stay_guests_insert ON stay_guests;
CREATE POLICY stay_guests_insert ON stay_guests
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS stay_guests_update ON stay_guests;
CREATE POLICY stay_guests_update ON stay_guests
  FOR UPDATE USING (is_account_member(account_id, 'admin'));

-- No DELETE policy: an ID record cannot be erased by a mistaken click.
