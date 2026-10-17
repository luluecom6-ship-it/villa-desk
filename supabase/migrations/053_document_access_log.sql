-- ============================================================
-- 053_document_access_log.sql — villa-desk: who opened which ID file
--
-- Every time staff request a signed link to an ID file, a row is written here
-- BEFORE the link is created (PDR 2, 13.3). If the log write fails no link is
-- issued. The log is append-only: rows cannot be updated or deleted, even by
-- the service role, and members can read it only as admin or above.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS document_access_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  stay_id     UUID NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  document_id UUID NOT NULL REFERENCES stay_documents(id) ON DELETE RESTRICT,
  opened_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  opened_role TEXT,
  action      TEXT NOT NULL DEFAULT 'signed_url' CHECK (action IN ('signed_url')),
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_access_log_document ON document_access_log(document_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_doc_access_log_account  ON document_access_log(account_id, opened_at DESC);

CREATE OR REPLACE FUNCTION public.forbid_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS document_access_log_no_update ON document_access_log;
CREATE TRIGGER document_access_log_no_update
  BEFORE UPDATE ON document_access_log
  FOR EACH ROW EXECUTE FUNCTION public.forbid_update();

DROP TRIGGER IF EXISTS document_access_log_no_delete ON document_access_log;
CREATE TRIGGER document_access_log_no_delete
  BEFORE DELETE ON document_access_log
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();

ALTER TABLE document_access_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_access_log_select ON document_access_log;
CREATE POLICY document_access_log_select ON document_access_log
  FOR SELECT USING (is_account_member(account_id, 'admin'));

-- No INSERT / UPDATE / DELETE policies: rows are written by the server
-- (service role) only, right before a signed link is issued.
