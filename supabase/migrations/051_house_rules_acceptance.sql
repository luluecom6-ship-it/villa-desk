-- ============================================================
-- 051_house_rules_acceptance.sql — villa-desk: rules text + signed evidence
--
-- The 13 house rules live in a versioned table so an old acceptance
-- always points to the exact wording the guest signed (PDR 6.4).
-- Rules are append-only: publish a new version instead of editing one.
--
-- stay_acceptances stores the evidence: typed full name as signature,
-- UTC timestamp, IP, user agent and the rules version id. One
-- acceptance per stay. Acceptances cannot be updated.
--
-- NOTE: no rules text is seeded here. The 13 rules come from the
-- client's Villa Forms Pack and are added as version 1 from the
-- dashboard (Settings) or a later seed migration.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS house_rules_versions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  property_id UUID REFERENCES properties(id) ON DELETE RESTRICT,
  version     INTEGER NOT NULL CHECK (version >= 1),
  title       TEXT NOT NULL DEFAULT 'House rules',
  body        TEXT NOT NULL,
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_house_rules_account_version
  ON house_rules_versions(account_id, version);

CREATE TABLE IF NOT EXISTS stay_acceptances (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  stay_id          UUID NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  rules_version_id UUID NOT NULL REFERENCES house_rules_versions(id) ON DELETE RESTRICT,

  typed_name       TEXT NOT NULL CHECK (char_length(btrim(typed_name)) >= 2),
  accepted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- stored in UTC
  ip_address       TEXT,
  user_agent       TEXT
);

-- One acceptance per stay.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stay_acceptances_stay ON stay_acceptances(stay_id);
CREATE INDEX IF NOT EXISTS idx_stay_acceptances_account ON stay_acceptances(account_id);

DROP TRIGGER IF EXISTS stay_acceptances_same_account ON stay_acceptances;
CREATE TRIGGER stay_acceptances_same_account
  BEFORE INSERT OR UPDATE OF account_id, stay_id ON stay_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.stay_child_same_account();

-- Signed evidence and published rule wording are immutable.
CREATE OR REPLACE FUNCTION public.forbid_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable; add a new row instead', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS stay_acceptances_immutable ON stay_acceptances;
CREATE TRIGGER stay_acceptances_immutable
  BEFORE UPDATE ON stay_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.forbid_update();

DROP TRIGGER IF EXISTS house_rules_versions_immutable ON house_rules_versions;
CREATE TRIGGER house_rules_versions_immutable
  BEFORE UPDATE ON house_rules_versions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_update();

ALTER TABLE house_rules_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stay_acceptances     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS house_rules_select ON house_rules_versions;
CREATE POLICY house_rules_select ON house_rules_versions
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS house_rules_insert ON house_rules_versions;
CREATE POLICY house_rules_insert ON house_rules_versions
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS stay_acceptances_select ON stay_acceptances;
CREATE POLICY stay_acceptances_select ON stay_acceptances
  FOR SELECT USING (is_account_member(account_id));

-- No client INSERT policy on stay_acceptances: the public guest form
-- writes it through the server (service role) together with the guest
-- and document rows, in one transaction.
