-- ── redeem_activation_code RPC ────────────────────────────────────────────────
-- Returns: JSON with keys: success, subscription_expires_at, error
CREATE OR REPLACE FUNCTION redeem_activation_code(input_code text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id     uuid;
  v_company_id    uuid;
  v_code_hash     text;
  v_code          activation_codes%ROWTYPE;
  v_base_date     timestamptz;
  v_new_expiry    timestamptz;
  v_attempt_count integer;
  v_clean_code    text;
BEGIN
  -- ── 0. Identify caller ──────────────────────────────────────────────────────
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Nicht authentifiziert.');
  END IF;

  -- ── 1. Get company_id from caller's profile ────────────────────────────────
  SELECT company_id INTO v_company_id
  FROM user_profiles
  WHERE user_id = v_caller_id
  LIMIT 1;

  IF v_company_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Kein Unternehmenskonto gefunden.');
  END IF;

  -- ── 2. Normalize input ─────────────────────────────────────────────────────
  v_clean_code := trim(regexp_replace(input_code, '\s', '', 'g'));

  IF v_clean_code !~ '^[0-9]{6}$' THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Ungültiges Format');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode muss genau 6 Ziffern haben.');
  END IF;

  -- ── 3. Brute-force check: max 10 failed attempts in 15 minutes ─────────────
  SELECT COUNT(*) INTO v_attempt_count
  FROM activation_code_attempts
  WHERE company_id = v_company_id
    AND success = false
    AND created_at > now() - INTERVAL '15 minutes';

  IF v_attempt_count >= 10 THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Rate limit');
    RETURN json_build_object('success', false, 'error', 'Zu viele Versuche. Bitte warten Sie 15 Minuten.');
  END IF;

  -- ── 4. Hash the input and find matching code ───────────────────────────────
  v_code_hash := encode(digest(v_clean_code, 'sha256'), 'hex');

  SELECT * INTO v_code
  FROM activation_codes
  WHERE code_hash = v_code_hash
  LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Nicht gefunden');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode ist ungültig.');
  END IF;

  -- ── 5. Validate code state ─────────────────────────────────────────────────
  IF v_code.status = 'used' THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Bereits verwendet');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode wurde bereits verwendet.');
  END IF;

  IF v_code.status = 'revoked' THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Widerrufen');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode wurde widerrufen.');
  END IF;

  IF v_code.expires_at < now() OR v_code.status = 'expired' THEN
    UPDATE activation_codes SET status = 'expired' WHERE id = v_code.id AND status = 'active';
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Abgelaufen');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode ist abgelaufen.');
  END IF;

  -- ── 6. Company/email binding check ────────────────────────────────────────
  IF v_code.company_id IS NOT NULL AND v_code.company_id <> v_company_id THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Falsches Unternehmen');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu diesem Unternehmen.');
  END IF;

  IF v_code.target_email IS NOT NULL THEN
    DECLARE
      v_caller_email text;
    BEGIN
      SELECT email INTO v_caller_email FROM user_profiles WHERE user_id = v_caller_id LIMIT 1;
      IF lower(v_caller_email) <> lower(v_code.target_email) THEN
        INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
        VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Falsche E-Mail');
        RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu diesem Unternehmen.');
      END IF;
    END;
  END IF;

  -- ── 7. Atomically mark code as used ───────────────────────────────────────
  UPDATE activation_codes
  SET status          = 'used',
      used_at         = now(),
      used_by         = v_caller_id,
      used_company_id = v_company_id
  WHERE id = v_code.id
    AND status = 'active'
    AND expires_at > now();

  IF NOT FOUND THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Race condition');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode konnte nicht eingelöst werden. Bitte erneut versuchen.');
  END IF;

  -- ── 8. Calculate new subscription expiry ──────────────────────────────────
  -- Extend from current active subscription if not yet expired
  SELECT subscription_status, subscription_expires_at
  INTO v_base_date
  FROM (
    SELECT subscription_status,
           CASE
             WHEN subscription_status = 'active' AND subscription_expires_at IS NOT NULL AND subscription_expires_at > now()
               THEN subscription_expires_at
             ELSE now()
           END AS subscription_expires_at
    FROM companies WHERE id = v_company_id
  ) sub;

  -- Actually just recalculate properly
  DECLARE
    v_sub_status  text;
    v_sub_expiry  timestamptz;
  BEGIN
    SELECT subscription_status, subscription_expires_at
    INTO v_sub_status, v_sub_expiry
    FROM companies WHERE id = v_company_id;

    IF v_sub_status = 'active' AND v_sub_expiry IS NOT NULL AND v_sub_expiry > now() THEN
      v_base_date := v_sub_expiry;
    ELSE
      v_base_date := now();
    END IF;
  END;

  CASE v_code.duration_type
    WHEN '1_monat'   THEN v_new_expiry := v_base_date + INTERVAL '1 month';
    WHEN '3_monate'  THEN v_new_expiry := v_base_date + INTERVAL '3 months';
    WHEN '1_jahr'    THEN v_new_expiry := v_base_date + INTERVAL '1 year';
    WHEN 'benutzerdefiniert' THEN
      IF v_code.custom_expires_at IS NOT NULL THEN
        v_new_expiry := v_code.custom_expires_at;
      ELSIF v_code.custom_days IS NOT NULL THEN
        v_new_expiry := v_base_date + (v_code.custom_days || ' days')::INTERVAL;
      ELSE
        v_new_expiry := v_base_date + INTERVAL '30 days';
      END IF;
    ELSE
      v_new_expiry := v_base_date + INTERVAL '1 month';
  END CASE;

  -- ── 9. Update company subscription ────────────────────────────────────────
  UPDATE companies SET
    subscription_status        = 'active',
    subscription_started_at    = now(),
    subscription_expires_at    = v_new_expiry,
    subscription_duration_type = v_code.duration_type,
    last_activation_code_id    = v_code.id,
    updated_at                 = now()
  WHERE id = v_company_id;

  -- ── 10. Log success ────────────────────────────────────────────────────────
  INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
  VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), true, 'OK');

  RETURN json_build_object(
    'success',               true,
    'subscription_expires_at', v_new_expiry
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', 'Interner Fehler: ' || SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION redeem_activation_code(text) TO authenticated;
