-- Create referrals table
CREATE TABLE IF NOT EXISTS referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- FK from companies to referrals
ALTER TABLE companies
  ADD CONSTRAINT fk_companies_referral_id
  FOREIGN KEY (referral_id) REFERENCES referrals(id) ON DELETE SET NULL;

-- RLS
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

-- Only super admins can read referrals (via service role in edge functions)
-- Regular users cannot access this table at all
CREATE POLICY "super_admin_select_referrals" ON referrals FOR SELECT
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
        AND user_profiles.is_super_admin = true
    )
  );

CREATE POLICY "super_admin_insert_referrals" ON referrals FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
        AND user_profiles.is_super_admin = true
    )
  );

CREATE POLICY "super_admin_update_referrals" ON referrals FOR UPDATE
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
        AND user_profiles.is_super_admin = true
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
        AND user_profiles.is_super_admin = true
    )
  );

CREATE POLICY "super_admin_delete_referrals" ON referrals FOR DELETE
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
        AND user_profiles.is_super_admin = true
    )
  );

CREATE INDEX IF NOT EXISTS idx_referrals_ref_code ON referrals(ref_code);
CREATE INDEX IF NOT EXISTS idx_companies_referral_id ON companies(referral_id);
