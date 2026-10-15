-- ============================================================
-- 050_stay_documents.sql — villa-desk: ID files + private bucket
--
-- ID images are the most sensitive data in the system (PDR 2, 13.3).
--
--   * Bucket `stay-ids` is PRIVATE and gets NO storage.objects policy
--     for anon or authenticated: with RLS on and no matching policy,
--     those roles can neither read nor write it.
--   * Every file is read and written through the server using the
--     service role (uploads from the public guest form, 60-second
--     signed URLs for staff). Each open is logged in
--     document_access_log (migration 054).
--   * Object path: account-<account_id>/<stay_id>/<guest_id>-<side>-<uuid>.<ext>
--
-- This table stores the object PATH and metadata only, never a URL.
-- Visible to admin and above: caretakers and viewers cannot see
-- that, or where, an ID file exists.
--
-- The Drive-archive columns arrive in migration 058.
-- Idempotent — safe to run multiple times.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('stay-ids', 'stay-ids', FALSE, 8388608)   -- 8 MB per file (PDR 6.3)
ON CONFLICT (id) DO UPDATE
  SET public = FALSE,
      file_size_limit = 8388608;

CREATE TABLE IF NOT EXISTS stay_documents (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  stay_id      UUID NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  guest_id     UUID NOT NULL REFERENCES stay_guests(id) ON DELETE RESTRICT,

  side         TEXT NOT NULL DEFAULT 'front' CHECK (side IN ('front', 'back')),
  storage_path TEXT NOT NULL,
  content_type TEXT NOT NULL
                 CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes   BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 8388608),
  sha256       TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),

  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL when the guest uploaded it from the public form.
  uploaded_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stay_documents_path ON stay_documents(storage_path);
-- At most 2 files (front and back) per person (PDR 6.3).
CREATE UNIQUE INDEX IF NOT EXISTS uq_stay_documents_guest_side ON stay_documents(guest_id, side);
CREATE INDEX IF NOT EXISTS idx_stay_documents_stay    ON stay_documents(stay_id);
CREATE INDEX IF NOT EXISTS idx_stay_documents_account ON stay_documents(account_id);

DROP TRIGGER IF EXISTS stay_documents_same_account ON stay_documents;
CREATE TRIGGER stay_documents_same_account
  BEFORE INSERT OR UPDATE OF account_id, stay_id ON stay_documents
  FOR EACH ROW EXECUTE FUNCTION public.stay_child_same_account();

ALTER TABLE stay_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stay_documents_select ON stay_documents;
CREATE POLICY stay_documents_select ON stay_documents
  FOR SELECT USING (is_account_member(account_id, 'admin'));

-- No INSERT / UPDATE / DELETE policies: all writes go through server
-- routes using the service role, after a role check and content sniff.
