SET search_path = public, extensions;

-- ── update_company_subscription_manual ───────────────────────────────────────
-- Allows superadmins to manually override company subscription fields
-- and writes an audit row to subscription_admin_actions.

CREATE OR REPLACE FUNCTION update_company_subscription_manual(
  p_company_id       uuid,
  p_subscription_status text,
  p_subscription_started_at timestamptz DEFAULT NULL,
  p_subscription_expires_at timestamptz DEFAULT NULL,
  p_subscription_duration_type text DEFAULT NULL,
  p_reason           text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caller_id   uuid := auth.uid();
  v_is_super    boolean;
  v_company     companies%ROWTYPE;
  v_allowed_statuses text[] := ARRAY['inactive','active','expired','suspended'];
BEGIN
  -- Auth check
  SELECT is_super_admin INTO v_is_super
  FROM user_profiles WHERE user_id = v_caller_id;
  IF NOT COALESCE(v_is_super, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert');
  END IF;

  -- Validate status
  IF p_subscription_status <> ALL(v_allowed_statuses) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Ungültiger Abo-Status');
  END IF;

  -- Load current company
  SELECT * INTO v_company FROM companies WHERE id = p_company_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unternehmen nicht gefunden');
  END IF;

  -- Write audit row
  INSERT INTO subscription_admin_actions
    (company_id, action_type, old_status, new_status, old_expires_at, new_expires_at, reason, created_by)
  VALUES
    (p_company_id, 'manual_edit',
     v_company.subscription_status, p_subscription_status,
     v_company.subscription_expires_at, p_subscription_expires_at,
     p_reason, v_caller_id);

  -- Apply update
  UPDATE companies
  SET
    subscription_status       = p_subscription_status,
    subscription_started_at   = COALESCE(p_subscription_started_at, subscription_started_at),
    subscription_expires_at   = p_subscription_expires_at,
    subscription_duration_type = COALESCE(p_subscription_duration_type, subscription_duration_type),
    updated_at                = now()
  WHERE id = p_company_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION update_company_subscription_manual(uuid, text, timestamptz, timestamptz, text, text) TO authenticated;
