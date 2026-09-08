/*
  # Fix Auth Users Permissions

  This migration removes the problematic trigger on auth.users and creates
  a proper user profile creation system that works with Supabase's constraints.

  1. Remove existing trigger on auth.users (we can't modify system tables)
  2. Create a new approach using RPC functions
  3. Set up proper permissions for user management
*/

-- Drop the existing trigger if it exists (this might fail, but that's ok)
DROP TRIGGER IF EXISTS create_user_profile_trigger ON auth.users;

-- Drop the existing function
DROP FUNCTION IF EXISTS create_user_profile() CASCADE;

-- Create a new function that can be called by the Edge Function
CREATE OR REPLACE FUNCTION create_user_profile_manual(
  user_id_param UUID,
  email_param TEXT,
  full_name_param TEXT DEFAULT '',
  role_param TEXT DEFAULT 'viewer'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result JSON;
BEGIN
  -- Insert the user profile
  INSERT INTO user_profiles (user_id, full_name, role, created_at, updated_at)
  VALUES (
    user_id_param,
    full_name_param,
    role_param,
    NOW(),
    NOW()
  )
  ON CONFLICT (user_id) 
  DO UPDATE SET
    full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
    updated_at = NOW();

  -- Return success
  SELECT json_build_object(
    'success', true,
    'user_id', user_id_param,
    'message', 'Profile created successfully'
  ) INTO result;

  RETURN result;
EXCEPTION
  WHEN OTHERS THEN
    -- Return error
    SELECT json_build_object(
      'success', false,
      'error', SQLERRM,
      'message', 'Failed to create user profile'
    ) INTO result;
    
    RETURN result;
END;
$$;

-- Grant execute permission to service_role
GRANT EXECUTE ON FUNCTION create_user_profile_manual(UUID, TEXT, TEXT, TEXT) TO service_role;

-- Ensure service_role has all necessary permissions on user_profiles
GRANT ALL ON user_profiles TO service_role;
GRANT USAGE, SELECT ON SEQUENCE user_profiles_id_seq TO service_role;

-- Create a function to safely get user profiles for the Edge Function
CREATE OR REPLACE FUNCTION get_all_user_profiles()
RETURNS TABLE (
  id BIGINT,
  user_id UUID,
  full_name TEXT,
  role TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    up.id,
    up.user_id,
    up.full_name,
    up.role,
    up.created_at,
    up.updated_at
  FROM user_profiles up;
END;
$$;

-- Grant execute permission to service_role
GRANT EXECUTE ON FUNCTION get_all_user_profiles() TO service_role;

-- Ensure the support admin can manage everything
DO $$
BEGIN
  -- Create policy for support admin if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'user_profiles' 
    AND policyname = 'support_admin_full_access'
  ) THEN
    CREATE POLICY "support_admin_full_access" ON user_profiles
      FOR ALL
      TO authenticated
      USING ((jwt() ->> 'email'::text) = 'support@yamobility.de'::text)
      WITH CHECK ((jwt() ->> 'email'::text) = 'support@yamobility.de'::text);
  END IF;
END $$;

-- Create a simple function to check if a user is support admin
CREATE OR REPLACE FUNCTION is_support_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN (jwt() ->> 'email'::text) = 'support@yamobility.de'::text;
END;
$$;

GRANT EXECUTE ON FUNCTION is_support_admin() TO authenticated, service_role;

-- Final verification
SELECT 'Migration completed successfully' as status;