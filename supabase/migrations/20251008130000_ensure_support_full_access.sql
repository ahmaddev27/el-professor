/*
  # Ensure Support User Has Full Access

  1. Changes
    - Verify is_support_user() function exists
    - Update all policies to consistently use is_support_user() for support access
    - Ensure support@yamobility.de has full access to all tables:
      - user_profiles
      - receipts
      - drivers
      - fixed_costs
      - income

  2. Security
    - Uses SECURITY DEFINER function to safely check support user
    - Maintains RLS protection
    - Support user gets full CRUD access to all tables
*/

-- Ensure is_support_user() function exists
CREATE OR REPLACE FUNCTION is_support_user()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN (
    SELECT email = 'support@yamobility.de'
    FROM auth.users
    WHERE id = auth.uid()
  );
END;
$$;

-- Update user_profiles policies
DROP POLICY IF EXISTS "support_admin_full_access" ON user_profiles;
DROP POLICY IF EXISTS "users_own_profile" ON user_profiles;

CREATE POLICY "support_admin_full_access" ON user_profiles
  FOR ALL
  TO authenticated
  USING (is_support_user())
  WITH CHECK (is_support_user());

CREATE POLICY "users_own_profile" ON user_profiles
  FOR ALL
  TO authenticated
  USING (user_id = auth.uid() OR is_support_user())
  WITH CHECK (user_id = auth.uid() OR is_support_user());

-- Verify receipts policies include support access
DROP POLICY IF EXISTS "Receipts can update own or support" ON receipts;
DROP POLICY IF EXISTS "Receipts can delete own or support" ON receipts;

CREATE POLICY "Receipts can update own or support"
  ON receipts
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid() OR is_support_user())
  WITH CHECK (user_id = auth.uid() OR is_support_user());

CREATE POLICY "Receipts can delete own or support"
  ON receipts
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid() OR is_support_user());

-- Verify drivers policies include support access
DROP POLICY IF EXISTS "Drivers can update own or support" ON drivers;
DROP POLICY IF EXISTS "Drivers can delete own or support" ON drivers;

CREATE POLICY "Drivers can update own or support"
  ON drivers
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid() OR is_support_user())
  WITH CHECK (user_id = auth.uid() OR is_support_user());

CREATE POLICY "Drivers can delete own or support"
  ON drivers
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid() OR is_support_user());

-- Fixed costs already allows all authenticated users, but let's verify
-- No changes needed for fixed_costs as it already allows all authenticated users

-- Income policies already use is_support_user() from the previous migration
-- No changes needed for income as it already uses is_support_user()
