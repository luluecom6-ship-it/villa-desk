-- ============================================================
-- 054_caretaker_id_access.sql — villa-desk: caretakers handle IDs
--
-- Owner decision (overrides PDR 2 / 13.3 "caretaker never sees ID images"):
-- caretakers (role agent) may VIEW ID files and ATTACH an ID on a guest's
-- behalf. They still cannot verify / reject IDs, see the access log, or see
-- deposit amounts. Every view and every staff upload is logged.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DROP POLICY IF EXISTS stay_documents_select ON stay_documents;
CREATE POLICY stay_documents_select ON stay_documents
  FOR SELECT USING (is_account_member(account_id, 'agent'));

ALTER TABLE document_access_log DROP CONSTRAINT IF EXISTS document_access_log_action_check;
ALTER TABLE document_access_log
  ADD CONSTRAINT document_access_log_action_check CHECK (action IN ('signed_url', 'staff_upload'));

-- Attach an ID file on a guest's behalf. The file is already in the private
-- bucket; this records it in one transaction: supersede the live file for the
-- same person + side (never deleted), insert, send the guest back to review,
-- and write the audit row.
CREATE OR REPLACE FUNCTION public.staff_attach_document(
  p_account      UUID,
  p_stay         UUID,
  p_guest        UUID,
  p_side         TEXT,
  p_path         TEXT,
  p_content_type TEXT,
  p_size         BIGINT,
  p_sha256       TEXT,
  p_user         UUID,
  p_role         TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stay   stays%ROWTYPE;
  v_prefix TEXT;
  v_id     UUID;
BEGIN
  SELECT * INTO v_stay FROM stays WHERE id = p_stay AND account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stay_doc:not_found'; END IF;
  IF v_stay.status = 'cancelled' THEN RAISE EXCEPTION 'stay_doc:locked'; END IF;

  PERFORM 1 FROM stay_guests WHERE id = p_guest AND stay_id = p_stay AND account_id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'stay_doc:bad_guest'; END IF;

  IF p_side NOT IN ('front', 'back') THEN RAISE EXCEPTION 'stay_doc:bad_side'; END IF;
  v_prefix := 'account-' || p_account::text || '/' || p_stay::text || '/';
  IF NOT starts_with(COALESCE(p_path, ''), v_prefix) THEN RAISE EXCEPTION 'stay_doc:bad_path'; END IF;

  UPDATE stay_documents SET superseded_at = NOW()
   WHERE guest_id = p_guest AND side = p_side AND superseded_at IS NULL;

  INSERT INTO stay_documents (account_id, stay_id, guest_id, side, storage_path, content_type, size_bytes, sha256, uploaded_by)
  VALUES (p_account, p_stay, p_guest, p_side, p_path, p_content_type, p_size, p_sha256, p_user)
  RETURNING id INTO v_id;

  -- A new image has not been reviewed.
  UPDATE stay_guests
     SET id_verified_at = NULL, id_verified_by = NULL, id_rejected_at = NULL, id_reject_reason = NULL
   WHERE id = p_guest;

  INSERT INTO document_access_log (account_id, stay_id, document_id, opened_by, opened_role, action)
  VALUES (p_account, p_stay, v_id, p_user, p_role, 'staff_upload');

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_attach_document(UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_attach_document(UUID, UUID, UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, UUID, TEXT) TO service_role;
