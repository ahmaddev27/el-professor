-- Safe, read-only preview RPC for activation codes.
-- Returns status/expiry/countdown without consuming the code.
-- Uses same search_path fix as redeem_activation_code.

CREATE OR REPLACE FUNCTION preview_activation_code(input_code text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_caller_id    uuid;
  v_company_id   uuid;
  v_caller_email text;
  v_code_hash    text;
  v_code         activation_codes%ROWTYPE;
  v_clean_code   text;
  v_seconds_rem  integer;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Nicht authentifiziert.');
  END IF;

  SELECT company_id, email INTO v_company_id, v_caller_email
  FROM user_profiles
  WHERE user_id = v_caller_id
  LIMIT 1;

  v_clean_code := trim(regexp_replace(input_code, '\s', '', 'g'));

  IF v_clean_code !~ '^[0-9]{6}$' THEN
    RETURN json_build_object('success', false, 'error', 'Ungültiges Format.');
  END IF;

  v_code_hash := encode(digest(v_clean_code::bytea, 'sha256'), 'hex');

  SELECT * INTO v_code
  FROM activation_codes
  WHERE code_hash = v_code_hash
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode nicht gefunden.');
  END IF;

  -- Binding check: code locked to a specific company/email must match caller
  IF v_code.company_id IS NOT NULL AND v_code.company_id <> v_company_id THEN
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu diesem Unternehmen.');
  END IF;

  IF v_code.target_email IS NOT NULL AND lower(v_caller_email) <> lower(v_code.target_email) THEN
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu dieser E-Mail.');
  END IF;

  v_seconds_rem := GREATEST(0, EXTRACT(EPOCH FROM (v_code.expires_at - now()))::integer);

  RETURN json_build_object(
    'success',           true,
    'status',            v_code.status,
    'expires_at',        v_code.expires_at,
    'duration_type',     v_code.duration_type,
    'seconds_remaining', v_seconds_rem
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', 'Fehler: ' || SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION preview_activation_code(text) TO authenticated;
