-- ============================================================
-- 065_drive_archive.sql  (PDR 13.4, 14.3)
--
-- Backup of ID files to Google Drive and (with owner approval) archiving.
--
--   * stay_documents gets the Drive copy fields. A file counts as backed up only when the
--     Drive size and SHA-256 match what we stored (the server checks; the database
--     constraint below refuses to archive anything that does not match).
--   * archived_at / archived_by: the Supabase object was removed after a verified copy and
--     the owner's approval. The row (and everything else) stays.
--   * document_archive_log: append-only history of copies, failures, missing-file alerts
--     and archives. No ID content.
--   * document_access_log may now also record opening the Drive copy.
--   * archive_document(): one transaction that marks the row archived and logs it.
-- Idempotent.
-- ============================================================

ALTER TABLE stay_documents
  ADD COLUMN IF NOT EXISTS drive_file_id    TEXT,
  ADD COLUMN IF NOT EXISTS drive_url        TEXT,
  ADD COLUMN IF NOT EXISTS drive_checksum   TEXT,
  ADD COLUMN IF NOT EXISTS drive_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS drive_copied_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS drive_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS drive_missing_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by      UUID;

ALTER TABLE stay_documents DROP CONSTRAINT IF EXISTS stay_documents_archive_needs_verified_copy;
ALTER TABLE stay_documents ADD CONSTRAINT stay_documents_archive_needs_verified_copy CHECK (
  archived_at IS NULL OR (
    drive_file_id IS NOT NULL
    AND drive_copied_at IS NOT NULL
    AND drive_checksum = sha256
    AND drive_size_bytes = size_bytes
  )
);

CREATE INDEX IF NOT EXISTS idx_stay_documents_backup_pending
  ON stay_documents (uploaded_at) WHERE drive_copied_at IS NULL AND archived_at IS NULL;

-- ---- archive / backup log (append-only) -------------------------------------------
CREATE TABLE IF NOT EXISTS document_archive_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  stay_id     UUID NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  document_id UUID NOT NULL REFERENCES stay_documents(id) ON DELETE RESTRICT,
  action      TEXT NOT NULL CHECK (action IN ('copied', 'copy_failed', 'drive_missing', 'drive_found', 'archived', 'archive_delete_failed')),
  actor       UUID,
  detail      TEXT CHECK (detail IS NULL OR char_length(detail) <= 200),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_document_archive_log_doc ON document_archive_log (document_id, created_at DESC);

ALTER TABLE document_archive_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_archive_log_select ON document_archive_log;
CREATE POLICY document_archive_log_select ON document_archive_log
  FOR SELECT USING (is_account_member(account_id, 'admin'));
DROP TRIGGER IF EXISTS document_archive_log_no_update ON document_archive_log;
CREATE TRIGGER document_archive_log_no_update BEFORE UPDATE ON document_archive_log
  FOR EACH ROW EXECUTE FUNCTION public.forbid_update();
DROP TRIGGER IF EXISTS document_archive_log_no_delete ON document_archive_log;
CREATE TRIGGER document_archive_log_no_delete BEFORE DELETE ON document_archive_log
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();

-- Opening the Drive copy of an archived file is logged like opening a signed link.
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'document_access_log'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%action%'
  LOOP
    EXECUTE format('ALTER TABLE document_access_log DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE document_access_log
  ADD CONSTRAINT document_access_log_action_check
  CHECK (action IN ('signed_url', 'staff_upload', 'drive_open'));

-- Mark a file archived (after the owner approved). The CHECK above makes the database refuse
-- it unless a verified Drive copy exists. The server deletes the storage object afterwards.
CREATE OR REPLACE FUNCTION public.archive_document(p_account_id UUID, p_document_id UUID, p_actor UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doc stay_documents;
BEGIN
  SELECT * INTO v_doc FROM stay_documents
   WHERE id = p_document_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'archive:not_found'; END IF;
  IF v_doc.archived_at IS NOT NULL THEN RETURN FALSE; END IF;
  IF v_doc.drive_missing_at IS NOT NULL THEN RAISE EXCEPTION 'archive:drive_missing'; END IF;

  UPDATE stay_documents SET archived_at = NOW(), archived_by = p_actor WHERE id = p_document_id;
  INSERT INTO document_archive_log (account_id, stay_id, document_id, action, actor)
  VALUES (p_account_id, v_doc.stay_id, p_document_id, 'archived', p_actor);
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_document(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_document(UUID, UUID, UUID) TO service_role;
