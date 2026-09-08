/*
  # Fix JWT Function Error

  This migration fixes the JWT function reference error by using the correct auth.jwt() function
  and simplifies the user profile policies.

  1. Security
    - Drop existing policies that use incorrect jwt() function
    - Create new policies using auth.jwt() function
    - Ensure support admin access works correctly
*/

-- Drop existing policies that might have JWT issues
DROP POLICY IF EXISTS "support_admin_full_access" ON user_profiles;
DROP POLICY IF EXISTS "users_own_profile" ON user_profiles;

-- Create simplified policies using auth.jwt()
CREATE POLICY "support_admin_full_access" ON user_profiles
  FOR ALL
  TO authenticated
  USING ((auth.jwt() ->> 'email'::text) = 'support@yamobility.de'::text)
  WITH CHECK ((auth.jwt() ->> 'email'::text) = 'support@yamobility.de'::text);

CREATE POLICY "users_own_profile" ON user_profiles
  FOR ALL
  TO authenticated
  USING ((user_id = auth.uid()) OR ((auth.jwt() ->> 'email'::text) = 'support@yamobility.de'::text))
  WITH CHECK ((user_id = auth.uid()) OR ((auth.jwt() ->> 'email'::text) = 'support@yamobility.de'::text));

-- Ensure service role has full access
GRANT ALL ON user_profiles TO service_role;

-- Create the manual profile creation function for Edge Functions
CREATE OR REPLACE FUNCTION create_user_profile_manual(
  p_user_id uuid,
  p_full_name text,
  p_role text DEFAULT 'viewer'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO user_profiles (user_id, full_name, role)
  VALUES (p_user_id, p_full_name, p_role)
  ON CONFLICT (user_id) 
  DO UPDATE SET 
    full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
    updated_at = now();
END;
$$;

-- Grant execute permission to service role
GRANT EXECUTE ON FUNCTION create_user_profile_manual TO service_role;