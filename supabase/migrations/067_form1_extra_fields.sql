-- 067: the remaining Form 1 details. Lead guest: alternate mobile, occupation, emergency contact (name + phone).
-- Extra guests: their own mobile (optional). Same submit function as 063 with these fields added. Idempotent.

ALTER TABLE stay_guests ADD COLUMN IF NOT EXISTS alternate_mobile TEXT;
ALTER TABLE stay_guests ADD COLUMN IF NOT EXISTS occupation       TEXT;
ALTER TABLE stay_guests ADD COLUMN IF NOT EXISTS emergency_name   TEXT;
ALTER TABLE stay_guests ADD COLUMN IF NOT EXISTS emergency_phone  TEXT;

CREATE OR REPLACE FUNCTION public.submit_stay_form(
  p_token      TEXT,
  p_form       JSONB,
  p_ip         TEXT,
  p_user_agent TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stay          stays%ROWTYPE;
  v_lead          JSONB := COALESCE(p_form->'lead', '{}'::jsonb);
  v_arrival       JSONB := COALESCE(p_form->'arrival', '{}'::jsonb);
  v_accept        JSONB := COALESCE(p_form->'acceptance', '{}'::jsonb);
  v_occ           JSONB;
  v_doc           JSONB;
  v_latest_rules  UUID;
  v_lead_id       UUID;
  v_guest_id      UUID;
  v_keymap        JSONB := '{}'::jsonb;   -- client_key -> stay_guests.id
  v_has_accept    BOOLEAN;
  v_now           TIMESTAMPTZ := NOW();
  v_foreign       BOOLEAN;
  v_lead_name     TEXT;
  v_prefix        TEXT;
BEGIN
  SELECT * INTO v_stay FROM stays WHERE form_token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stay_form:not_found';
  END IF;

  -- Unknown, cancelled and finished stays all look the same to the guest.
  IF v_stay.status IN ('cancelled', 'sample', 'checked_out')
     OR v_stay.checkout_at < v_now THEN
    RAISE EXCEPTION 'stay_form:not_found';
  END IF;

  -- First submission is allowed until the stay ends; once submitted the form
  -- can be edited only until check-in, then it is read-only (PDR 6.1).
  -- Exception (migration 063): while staff have rejected an ID, the guest can always
  -- upload it again, even after check-in.
  IF v_stay.form_status = 'submitted'
     AND (v_stay.status = 'checked_in' OR v_stay.checkin_at <= v_now)
     AND NOT EXISTS (SELECT 1 FROM stay_guests g WHERE g.stay_id = v_stay.id AND g.id_rejected_at IS NOT NULL) THEN
    RAISE EXCEPTION 'stay_form:closed';
  END IF;

  v_prefix := 'account-' || v_stay.account_id::text || '/' || v_stay.id::text || '/';

  -- House rules acceptance: signed once, on the latest published version.
  SELECT id INTO v_latest_rules
    FROM house_rules_versions
   WHERE account_id = v_stay.account_id
   ORDER BY version DESC
   LIMIT 1;
  IF v_latest_rules IS NULL THEN
    RAISE EXCEPTION 'stay_form:no_rules';
  END IF;

  SELECT EXISTS (SELECT 1 FROM stay_acceptances WHERE stay_id = v_stay.id)
    INTO v_has_accept;

  IF NOT v_has_accept THEN
    IF (v_accept->>'rules_version_id') IS DISTINCT FROM v_latest_rules::text THEN
      RAISE EXCEPTION 'stay_form:rules_changed';
    END IF;
    IF char_length(btrim(COALESCE(v_accept->>'typed_name', ''))) < 2 THEN
      RAISE EXCEPTION 'stay_form:signature_required';
    END IF;
    INSERT INTO stay_acceptances (
      account_id, stay_id, rules_version_id, typed_name, accepted_at, ip_address, user_agent
    ) VALUES (
      v_stay.account_id, v_stay.id, v_latest_rules,
      btrim(v_accept->>'typed_name'), v_now,
      LEFT(p_ip, 64), LEFT(p_user_agent, 512)
    );
  END IF;

  -- Lead guest (insert on first submit, update on reopen).
  v_lead_name := btrim(COALESCE(v_lead->>'full_name', ''));
  IF v_lead_name = '' THEN
    RAISE EXCEPTION 'stay_form:name_required';
  END IF;
  v_foreign := COALESCE((v_lead->>'is_foreign')::boolean, FALSE);

  SELECT id INTO v_lead_id FROM stay_guests WHERE stay_id = v_stay.id AND role = 'lead';

  IF v_lead_id IS NULL THEN
    INSERT INTO stay_guests (
      account_id, stay_id, role, full_name, is_adult, mobile, email, nationality, address,
      id_type, id_last4, is_foreign, form_c_required, visa_type, visa_expiry, arrived_in_india_on,
      alternate_mobile, occupation, emergency_name, emergency_phone
    ) VALUES (
      v_stay.account_id, v_stay.id, 'lead', v_lead_name, TRUE,
      COALESCE(v_stay.guest_phone, NULLIF(regexp_replace(COALESCE(v_lead->>'mobile', ''), '\D', '', 'g'), '')),
      NULLIF(btrim(v_lead->>'email'), ''),
      NULLIF(btrim(v_lead->>'nationality'), ''),
      NULLIF(btrim(v_lead->>'address'), ''),
      NULLIF(v_lead->>'id_type', ''), NULLIF(v_lead->>'id_last4', ''),
      v_foreign, v_foreign,
      NULLIF(btrim(v_lead->>'visa_type'), ''),
      NULLIF(v_lead->>'visa_expiry', '')::date,
      NULLIF(v_lead->>'arrived_in_india_on', '')::date,
      NULLIF(regexp_replace(COALESCE(v_lead->>'alternate_mobile', ''), '\D', '', 'g'), ''),
      NULLIF(btrim(v_lead->>'occupation'), ''),
      NULLIF(btrim(v_lead->>'emergency_name'), ''),
      NULLIF(regexp_replace(COALESCE(v_lead->>'emergency_phone', ''), '\D', '', 'g'), '')
    ) RETURNING id INTO v_lead_id;
  ELSE
    UPDATE stay_guests SET
      full_name = v_lead_name,
      mobile = COALESCE(v_stay.guest_phone, NULLIF(regexp_replace(COALESCE(v_lead->>'mobile', ''), '\D', '', 'g'), ''), mobile),
      email = NULLIF(btrim(v_lead->>'email'), ''),
      nationality = NULLIF(btrim(v_lead->>'nationality'), ''),
      address = NULLIF(btrim(v_lead->>'address'), ''),
      id_type = NULLIF(v_lead->>'id_type', ''),
      id_last4 = NULLIF(v_lead->>'id_last4', ''),
      is_foreign = v_foreign,
      form_c_required = v_foreign,
      visa_type = NULLIF(btrim(v_lead->>'visa_type'), ''),
      visa_expiry = NULLIF(v_lead->>'visa_expiry', '')::date,
      arrived_in_india_on = NULLIF(v_lead->>'arrived_in_india_on', '')::date,
      alternate_mobile = NULLIF(regexp_replace(COALESCE(v_lead->>'alternate_mobile', ''), '\D', '', 'g'), ''),
      occupation = NULLIF(btrim(v_lead->>'occupation'), ''),
      emergency_name = NULLIF(btrim(v_lead->>'emergency_name'), ''),
      emergency_phone = NULLIF(regexp_replace(COALESCE(v_lead->>'emergency_phone', ''), '\D', '', 'g'), '')
    WHERE id = v_lead_id;
  END IF;
  v_keymap := jsonb_build_object('lead', v_lead_id);

  -- Occupants. Existing ones are updated by id; new ones inserted. A guest row
  -- is never removed (no deletes): the form only offers removal for rows that
  -- have not been saved yet.
  FOR v_occ IN SELECT * FROM jsonb_array_elements(COALESCE(p_form->'occupants', '[]'::jsonb)) LOOP
    v_guest_id := NULL;
    IF btrim(COALESCE(v_occ->>'full_name', '')) = '' THEN
      RAISE EXCEPTION 'stay_form:name_required';
    END IF;

    IF NULLIF(v_occ->>'id', '') IS NOT NULL THEN
      UPDATE stay_guests SET
        full_name = btrim(v_occ->>'full_name'),
        age = NULLIF(v_occ->>'age', '')::integer,
        is_adult = COALESCE((v_occ->>'is_adult')::boolean, TRUE),
        id_type = NULLIF(v_occ->>'id_type', ''),
        id_last4 = NULLIF(v_occ->>'id_last4', ''),
        mobile = NULLIF(regexp_replace(COALESCE(v_occ->>'mobile', ''), '\D', '', 'g'), '')
      WHERE id = (v_occ->>'id')::uuid AND stay_id = v_stay.id AND role = 'occupant'
      RETURNING id INTO v_guest_id;
      IF v_guest_id IS NULL THEN
        RAISE EXCEPTION 'stay_form:bad_guest';
      END IF;
    ELSE
      INSERT INTO stay_guests (
        account_id, stay_id, role, full_name, age, is_adult, id_type, id_last4, mobile
      ) VALUES (
        v_stay.account_id, v_stay.id, 'occupant', btrim(v_occ->>'full_name'),
        NULLIF(v_occ->>'age', '')::integer,
        COALESCE((v_occ->>'is_adult')::boolean, TRUE),
        NULLIF(v_occ->>'id_type', ''), NULLIF(v_occ->>'id_last4', ''),
        NULLIF(regexp_replace(COALESCE(v_occ->>'mobile', ''), '\D', '', 'g'), '')
      ) RETURNING id INTO v_guest_id;
    END IF;

    v_keymap := v_keymap || jsonb_build_object(v_occ->>'client_key', v_guest_id);
  END LOOP;

  -- ID files. The old live file for the same guest and side is superseded,
  -- never deleted, and a new upload clears any earlier verify / reject so
  -- staff review the new file.
  FOR v_doc IN SELECT * FROM jsonb_array_elements(COALESCE(p_form->'documents', '[]'::jsonb)) LOOP
    v_guest_id := NULLIF(v_keymap->>(v_doc->>'guest_key'), '')::uuid;
    IF v_guest_id IS NULL THEN
      RAISE EXCEPTION 'stay_form:bad_guest';
    END IF;
    IF NOT starts_with(COALESCE(v_doc->>'storage_path', ''), v_prefix) THEN
      RAISE EXCEPTION 'stay_form:bad_path';
    END IF;

    UPDATE stay_documents
       SET superseded_at = v_now
     WHERE guest_id = v_guest_id AND side = v_doc->>'side' AND superseded_at IS NULL;

    INSERT INTO stay_documents (
      account_id, stay_id, guest_id, side, storage_path, content_type, size_bytes, sha256
    ) VALUES (
      v_stay.account_id, v_stay.id, v_guest_id, v_doc->>'side', v_doc->>'storage_path',
      v_doc->>'content_type', (v_doc->>'size_bytes')::bigint, v_doc->>'sha256'
    );

    UPDATE stay_guests
       SET id_verified_at = NULL, id_verified_by = NULL,
           id_rejected_at = NULL, id_reject_reason = NULL
     WHERE id = v_guest_id;
  END LOOP;

  -- Every adult needs a front-side ID on file (new or from an earlier submit).
  IF EXISTS (
    SELECT 1 FROM stay_guests g
     WHERE g.stay_id = v_stay.id AND g.is_adult
       AND NOT EXISTS (
         SELECT 1 FROM stay_documents d
          WHERE d.guest_id = g.id AND d.side = 'front' AND d.superseded_at IS NULL
       )
  ) THEN
    RAISE EXCEPTION 'stay_form:id_required';
  END IF;

  UPDATE stays SET
    form_status = 'submitted',
    form_submitted_at = COALESCE(form_submitted_at, v_now),
    guest_email = COALESCE(guest_email, NULLIF(btrim(v_lead->>'email'), '')),
    expected_arrival_time = NULLIF(v_arrival->>'expected_arrival_time', '')::time,
    vehicle_number = NULLIF(btrim(v_arrival->>'vehicle_number'), ''),
    special_request = NULLIF(btrim(v_arrival->>'special_request'), ''),
    purpose_of_visit = NULLIF(btrim(v_arrival->>'purpose_of_visit'), '')
  WHERE id = v_stay.id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'stay_ref', v_stay.stay_ref,
    'edited', v_has_accept
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_stay_form(TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_stay_form(TEXT, JSONB, TEXT, TEXT) TO service_role;
