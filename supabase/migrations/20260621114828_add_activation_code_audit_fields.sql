-- Add soft-delete and hide fields to activation_codes
ALTER TABLE activation_codes
  ADD COLUMN IF NOT EXISTS deleted_at   timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deleted_by   uuid        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS hidden_at    timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS hidden_by    uuid        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS hidden_reason text        DEFAULT NULL;

-- Audit table for manual superadmin subscription edits
CREATE TABLE IF NOT EXISTS subscription_admin_actions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  action_type text        NOT NULL DEFAULT 'manual_edit',
  old_status  text,
  new_status  text,
  old_expires_at timestamptz,
  new_expires_at timestamptz,
  reason      text,
  created_by  uuid        REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE subscription_admin_actions ENABLE ROW LEVEL SECURITY;

-- Only super admins (is_super_admin = true) can read/write this table
CREATE POLICY "super_admin_all_subscription_admin_actions"
  ON subscription_admin_actions
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
        AND user_profiles.is_super_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
        AND user_profiles.is_super_admin = true
    )
  );
