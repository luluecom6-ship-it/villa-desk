-- 069: owner-approved deletion of old checklist / damage photos (no Drive backup, owner decision 21 Oct 2026).
-- The photo FILE is removed from storage; the checklist_photos row stays (append-only, keeps sha256 and size)
-- and this append-only log records that the file was deleted, when, by whom. Idempotent.

CREATE TABLE IF NOT EXISTS checklist_photo_purges (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  stay_id     UUID NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  photo_id    UUID NOT NULL REFERENCES checklist_photos(id) ON DELETE RESTRICT,
  size_bytes  BIGINT NOT NULL CHECK (size_bytes > 0),
  purged_by   UUID,
  purged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_checklist_photo_purges_photo ON checklist_photo_purges (photo_id);
CREATE INDEX IF NOT EXISTS idx_checklist_photo_purges_account ON checklist_photo_purges (account_id, purged_at DESC);

DROP TRIGGER IF EXISTS checklist_photo_purges_no_update ON checklist_photo_purges;
CREATE TRIGGER checklist_photo_purges_no_update BEFORE UPDATE ON checklist_photo_purges
  FOR EACH ROW EXECUTE FUNCTION public.forbid_update();
DROP TRIGGER IF EXISTS checklist_photo_purges_no_delete ON checklist_photo_purges;
CREATE TRIGGER checklist_photo_purges_no_delete BEFORE DELETE ON checklist_photo_purges
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();

ALTER TABLE checklist_photo_purges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS checklist_photo_purges_select ON checklist_photo_purges;
CREATE POLICY checklist_photo_purges_select ON checklist_photo_purges FOR SELECT USING (is_account_member(account_id, 'admin'));
