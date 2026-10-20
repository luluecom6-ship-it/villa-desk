-- ============================================================
-- 066_checklists_damage.sql  (PDR section 10: Forms 4, 5 and 6)
--
--   * checklist_templates: one editable list of rooms / appliances / meters per property.
--   * checklist_runs: an arrival checklist and a check-out inspection per stay. Each run stores a
--     SNAPSHOT of the template used, so editing the template never changes old runs. Answers are
--     merged one item at a time (checklist_save_answer) so two phones cannot overwrite each other.
--     A completed run is locked.
--   * checklist_photos: photos of an item or of a damage report (private stay-ids bucket,
--     folder account-<id>/checklists/...). Never deleted.
--   * damage_reports: raised from an inspection item; status Open / Discussed / Settled / Waived;
--     estimated cost and the deposit deduction are owner/admin only (RLS admin; caretakers read
--     through the server, which leaves cost out). Never deleted; every change is audited.
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS checklist_templates (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  items       JSONB NOT NULL DEFAULT '[]'::jsonb
                CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 200),
  updated_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_checklist_templates_property ON checklist_templates (property_id);
DROP TRIGGER IF EXISTS checklist_templates_updated_at ON checklist_templates;
CREATE TRIGGER checklist_templates_updated_at BEFORE UPDATE ON checklist_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS checklist_templates_no_delete ON checklist_templates;
CREATE TRIGGER checklist_templates_no_delete BEFORE DELETE ON checklist_templates
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();

CREATE TABLE IF NOT EXISTS checklist_runs (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  stay_id            UUID NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  kind               TEXT NOT NULL CHECK (kind IN ('arrival', 'checkout')),
  status             TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  template_snapshot  JSONB NOT NULL CHECK (jsonb_typeof(template_snapshot) = 'array'),
  answers            JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(answers) = 'object'),
  started_by         UUID,
  started_by_name    TEXT,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ,
  completed_by       UUID,
  completed_by_name  TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT checklist_runs_completed_has_time CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_checklist_runs_stay_kind ON checklist_runs (stay_id, kind);

CREATE OR REPLACE FUNCTION public.checklist_runs_lock_completed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'checklist_runs: a completed checklist cannot be changed';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS checklist_runs_lock ON checklist_runs;
CREATE TRIGGER checklist_runs_lock BEFORE UPDATE ON checklist_runs
  FOR EACH ROW EXECUTE FUNCTION public.checklist_runs_lock_completed();
DROP TRIGGER IF EXISTS checklist_runs_no_delete ON checklist_runs;
CREATE TRIGGER checklist_runs_no_delete BEFORE DELETE ON checklist_runs
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();

CREATE TABLE IF NOT EXISTS damage_reports (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  stay_id            UUID NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  run_id             UUID REFERENCES checklist_runs(id) ON DELETE RESTRICT,
  item_key           TEXT,
  report_no          INTEGER GENERATED ALWAYS AS IDENTITY,
  title              TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 120),
  description        TEXT CHECK (description IS NULL OR char_length(description) <= 1000),
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'discussed', 'settled', 'waived')),
  estimated_cost     NUMERIC(12,2) CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  deposit_deduction  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (deposit_deduction >= 0),
  applied_at         TIMESTAMPTZ,
  applied_by         UUID,
  raised_by          UUID,
  raised_by_name     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_damage_reports_stay ON damage_reports (stay_id);
CREATE INDEX IF NOT EXISTS idx_damage_reports_status ON damage_reports (account_id, status);
DROP TRIGGER IF EXISTS damage_reports_updated_at ON damage_reports;
CREATE TRIGGER damage_reports_updated_at BEFORE UPDATE ON damage_reports
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS damage_reports_no_delete ON damage_reports;
CREATE TRIGGER damage_reports_no_delete BEFORE DELETE ON damage_reports
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();

CREATE TABLE IF NOT EXISTS damage_audit (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  stay_id          UUID NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  damage_id        UUID NOT NULL REFERENCES damage_reports(id) ON DELETE RESTRICT,
  action           TEXT NOT NULL CHECK (action IN ('created', 'updated')),
  old_values       JSONB,
  new_values       JSONB NOT NULL,
  changed_by       UUID,
  changed_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_damage_audit_damage ON damage_audit (damage_id, created_at DESC);
DROP TRIGGER IF EXISTS damage_audit_no_update ON damage_audit;
CREATE TRIGGER damage_audit_no_update BEFORE UPDATE ON damage_audit
  FOR EACH ROW EXECUTE FUNCTION public.forbid_update();
DROP TRIGGER IF EXISTS damage_audit_no_delete ON damage_audit;
CREATE TRIGGER damage_audit_no_delete BEFORE DELETE ON damage_audit
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();

-- Who changed it: the server sets app.actor_id / app.actor_name just before the change (same as deposits).
CREATE OR REPLACE FUNCTION public.damage_audit_row()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor TEXT := NULLIF(current_setting('app.actor_id', TRUE), '');
  v_name  TEXT := NULLIF(current_setting('app.actor_name', TRUE), '');
BEGIN
  INSERT INTO damage_audit (account_id, stay_id, damage_id, action, old_values, new_values, changed_by, changed_by_name)
  VALUES (NEW.account_id, NEW.stay_id, NEW.id,
          CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'updated' END,
          CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) - 'updated_at' END,
          to_jsonb(NEW) - 'updated_at',
          CASE WHEN v_actor ~ '^[0-9a-fA-F-]{36}$' THEN v_actor::uuid ELSE NULL END,
          v_name);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS damage_reports_audit ON damage_reports;
CREATE TRIGGER damage_reports_audit AFTER INSERT OR UPDATE ON damage_reports
  FOR EACH ROW EXECUTE FUNCTION public.damage_audit_row();

CREATE TABLE IF NOT EXISTS checklist_photos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  stay_id       UUID NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  run_id        UUID REFERENCES checklist_runs(id) ON DELETE RESTRICT,
  damage_id     UUID REFERENCES damage_reports(id) ON DELETE RESTRICT,
  item_key      TEXT,
  storage_path  TEXT NOT NULL,
  content_type  TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes    BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 8388608),
  sha256        TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by   UUID,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT checklist_photos_belongs_somewhere CHECK (run_id IS NOT NULL OR damage_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_checklist_photos_path ON checklist_photos (storage_path);
CREATE INDEX IF NOT EXISTS idx_checklist_photos_run ON checklist_photos (run_id, item_key);
CREATE INDEX IF NOT EXISTS idx_checklist_photos_damage ON checklist_photos (damage_id);
DROP TRIGGER IF EXISTS checklist_photos_no_update ON checklist_photos;
CREATE TRIGGER checklist_photos_no_update BEFORE UPDATE ON checklist_photos
  FOR EACH ROW EXECUTE FUNCTION public.forbid_update();
DROP TRIGGER IF EXISTS checklist_photos_no_delete ON checklist_photos;
CREATE TRIGGER checklist_photos_no_delete BEFORE DELETE ON checklist_photos
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();

-- ---- RLS: reads only; every write goes through the server (service role) ----------------
ALTER TABLE checklist_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_photos    ENABLE ROW LEVEL SECURITY;
ALTER TABLE damage_reports      ENABLE ROW LEVEL SECURITY;
ALTER TABLE damage_audit        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checklist_templates_select ON checklist_templates;
CREATE POLICY checklist_templates_select ON checklist_templates FOR SELECT USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS checklist_runs_select ON checklist_runs;
CREATE POLICY checklist_runs_select ON checklist_runs FOR SELECT USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS checklist_photos_select ON checklist_photos;
CREATE POLICY checklist_photos_select ON checklist_photos FOR SELECT USING (is_account_member(account_id, 'agent'));
-- Cost and deduction are money: caretakers read damage reports only through the server, which omits them.
DROP POLICY IF EXISTS damage_reports_select ON damage_reports;
CREATE POLICY damage_reports_select ON damage_reports FOR SELECT USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS damage_audit_select ON damage_audit;
CREATE POLICY damage_audit_select ON damage_audit FOR SELECT USING (is_account_member(account_id, 'admin'));

-- Save one answer without overwriting the others. Fails on a completed run (trigger above).
CREATE OR REPLACE FUNCTION public.checklist_save_answer(p_account_id UUID, p_run_id UUID, p_key TEXT, p_answer JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run checklist_runs;
BEGIN
  UPDATE checklist_runs
     SET answers = answers || jsonb_build_object(p_key, p_answer)
   WHERE id = p_run_id AND account_id = p_account_id
  RETURNING * INTO v_run;
  IF NOT FOUND THEN RAISE EXCEPTION 'checklist:not_found'; END IF;
  RETURN v_run.answers;
END;
$$;
REVOKE ALL ON FUNCTION public.checklist_save_answer(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checklist_save_answer(UUID, UUID, TEXT, JSONB) TO service_role;

-- ---- damage reports: create / update / apply to the deposit, each in ONE transaction so the audit row
--      names the person (app.actor_*) and the deposit and report cannot drift apart. -----------------
CREATE OR REPLACE FUNCTION public.damage_create(
  p_account_id UUID, p_stay_id UUID, p_run_id UUID, p_actor UUID, p_actor_name TEXT, p_values JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row damage_reports;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stays WHERE id = p_stay_id AND account_id = p_account_id) THEN
    RAISE EXCEPTION 'damage:not_found';
  END IF;
  PERFORM set_config('app.actor_id', COALESCE(p_actor::text, ''), TRUE);
  PERFORM set_config('app.actor_name', COALESCE(p_actor_name, ''), TRUE);
  INSERT INTO damage_reports (account_id, stay_id, run_id, item_key, title, description, estimated_cost, raised_by, raised_by_name)
  VALUES (p_account_id, p_stay_id, p_run_id, NULLIF(p_values->>'item_key', ''), p_values->>'title',
          NULLIF(p_values->>'description', ''), NULLIF(p_values->>'estimated_cost', '')::numeric, p_actor, p_actor_name)
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

-- Patch only the keys present: status, description, estimated_cost (the server drops cost for caretakers).
CREATE OR REPLACE FUNCTION public.damage_update(
  p_account_id UUID, p_damage_id UUID, p_actor UUID, p_actor_name TEXT, p_patch JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row damage_reports;
BEGIN
  PERFORM set_config('app.actor_id', COALESCE(p_actor::text, ''), TRUE);
  PERFORM set_config('app.actor_name', COALESCE(p_actor_name, ''), TRUE);
  UPDATE damage_reports SET
    status         = CASE WHEN p_patch ? 'status' THEN p_patch->>'status' ELSE status END,
    description    = CASE WHEN p_patch ? 'description' THEN NULLIF(p_patch->>'description', '') ELSE description END,
    estimated_cost = CASE WHEN p_patch ? 'estimated_cost' THEN NULLIF(p_patch->>'estimated_cost', '')::numeric ELSE estimated_cost END
   WHERE id = p_damage_id AND account_id = p_account_id
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'damage:not_found'; END IF;
  RETURN to_jsonb(v_row);
END;
$$;

-- Take the estimated cost off the stay's deposit (Phase 2 link, PDR 9/10). Once only; the deposit must be
-- Held or Refund due and have enough left. The report becomes Settled.
CREATE OR REPLACE FUNCTION public.damage_apply_to_deposit(
  p_account_id UUID, p_damage_id UUID, p_actor UUID, p_actor_name TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_d damage_reports;
  v_dep deposits;
  v_reason TEXT;
BEGIN
  PERFORM set_config('app.actor_id', COALESCE(p_actor::text, ''), TRUE);
  PERFORM set_config('app.actor_name', COALESCE(p_actor_name, ''), TRUE);
  SELECT * INTO v_d FROM damage_reports WHERE id = p_damage_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'damage:not_found'; END IF;
  IF v_d.applied_at IS NOT NULL THEN RAISE EXCEPTION 'damage:already_applied'; END IF;
  IF COALESCE(v_d.estimated_cost, 0) <= 0 THEN RAISE EXCEPTION 'damage:no_cost'; END IF;

  SELECT * INTO v_dep FROM deposits WHERE stay_id = v_d.stay_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND OR v_dep.status NOT IN ('held', 'refund_due', 'partly_deducted') THEN RAISE EXCEPTION 'damage:no_deposit_held'; END IF;
  IF v_dep.deducted_amount + v_d.estimated_cost > v_dep.amount THEN RAISE EXCEPTION 'damage:exceeds_deposit'; END IF;

  v_reason := LEFT(concat_ws('; ', NULLIF(btrim(v_dep.deduction_reason), ''), 'Damage #' || v_d.report_no || ': ' || v_d.title), 300);
  UPDATE deposits
     SET deducted_amount = v_dep.deducted_amount + v_d.estimated_cost,
         deduction_reason = v_reason,
         status = CASE WHEN v_dep.status = 'refund_due' THEN 'refund_due' ELSE 'partly_deducted' END
   WHERE id = v_dep.id;
  UPDATE damage_reports
     SET deposit_deduction = v_d.estimated_cost, applied_at = NOW(), applied_by = p_actor, status = 'settled'
   WHERE id = v_d.id
  RETURNING * INTO v_d;
  RETURN to_jsonb(v_d);
END;
$$;

REVOKE ALL ON FUNCTION public.damage_create(UUID, UUID, UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.damage_update(UUID, UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.damage_apply_to_deposit(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.damage_create(UUID, UUID, UUID, UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.damage_update(UUID, UUID, UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.damage_apply_to_deposit(UUID, UUID, UUID, TEXT) TO service_role;
