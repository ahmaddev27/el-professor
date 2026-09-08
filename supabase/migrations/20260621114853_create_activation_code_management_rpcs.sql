SET search_path = public, extensions;

-- ── revoke_activation_code ────────────────────────────────────────────────────
-- Only callable by superadmins. Sets status=revoked for active, unused codes.

CREATE OR REPLACE FUNCTION revoke_activation_code(p_code_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caller_id   uuid := auth.uid();
  v_is_super    boolean;
  v_code        activation_codes%ROWTYPE;
BEGIN
  -- Auth check
  SELECT is_super_admin INTO v_is_super
  FROM user_profiles WHERE user_id = v_caller_id;
  IF NOT COALESCE(v_is_super, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert');
  END IF;

  -- Load code
  SELECT * INTO v_code FROM activation_codes WHERE id = p_code_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Code nicht gefunden');
  END IF;
  IF v_code.status <> 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nur aktive Codes können widerrufen werden');
  END IF;
  IF v_code.used_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Verwendete Codes können nicht widerrufen werden');
  END IF;

  UPDATE activation_codes
  SET status = 'revoked', revoked_at = now(), revoked_by = v_caller_id
  WHERE id = p_code_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION revoke_activation_code(uuid) TO authenticated;


-- ── delete_activation_code ────────────────────────────────────────────────────
-- Soft-deletes unused codes. Refuses to delete used codes.

CREATE OR REPLACE FUNCTION delete_activation_code(p_code_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caller_id   uuid := auth.uid();
  v_is_super    boolean;
  v_code        activation_codes%ROWTYPE;
BEGIN
  SELECT is_super_admin INTO v_is_super
  FROM user_profiles WHERE user_id = v_caller_id;
  IF NOT COALESCE(v_is_super, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert');
  END IF;

  SELECT * INTO v_code FROM activation_codes WHERE id = p_code_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Code nicht gefunden');
  END IF;
  IF v_code.used_at IS NOT NULL OR v_code.used_company_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Verwendete Codes können nicht gelöscht werden');
  END IF;
  IF v_code.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Code wurde bereits gelöscht');
  END IF;

  UPDATE activation_codes
  SET deleted_at = now(), deleted_by = v_caller_id
  WHERE id = p_code_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION delete_activation_code(uuid) TO authenticated;


-- ── hide_activation_code ──────────────────────────────────────────────────────
-- Hides any code from default views (including client history) without deleting.

CREATE OR REPLACE FUNCTION hide_activation_code(p_code_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caller_id   uuid := auth.uid();
  v_is_super    boolean;
BEGIN
  SELECT is_super_admin INTO v_is_super
  FROM user_profiles WHERE user_id = v_caller_id;
  IF NOT COALESCE(v_is_super, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM activation_codes WHERE id = p_code_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Code nicht gefunden');
  END IF;

  UPDATE activation_codes
  SET hidden_at = now(), hidden_by = v_caller_id, hidden_reason = p_reason
  WHERE id = p_code_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION hide_activation_code(uuid, text) TO authenticated;
