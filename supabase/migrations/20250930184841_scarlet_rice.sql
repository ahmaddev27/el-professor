/*
  # Fix Auth Permissions for User Creation

  1. Database Setup
    - Ensure proper permissions for service role
    - Fix RLS policies that might be blocking user creation
    - Add proper constraints and defaults

  2. Security
    - Maintain RLS while allowing service role operations
    - Ensure proper user profile creation
*/

-- First, ensure the service role has proper permissions on auth schema
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA auth TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO service_role;

-- Ensure service role can manage user_profiles
GRANT ALL ON public.user_profiles TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Temporarily disable RLS for service role operations
ALTER TABLE public.user_profiles DISABLE ROW LEVEL SECURITY;

-- Re-enable RLS with proper policies
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- Drop existing conflicting policies
DROP POLICY IF EXISTS "Service role can manage all profiles" ON public.user_profiles;
DROP POLICY IF EXISTS "Support admin can manage all profiles" ON public.user_profiles;
DROP POLICY IF EXISTS "Support admin can insert profiles" ON public.user_profiles;
DROP POLICY IF EXISTS "Support admin can delete profiles" ON public.user_profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.user_profiles;
DROP POLICY IF EXISTS "Users can view own profile" ON public.user_profiles;
DROP POLICY IF EXISTS "profile_delete_policy" ON public.user_profiles;
DROP POLICY IF EXISTS "profile_insert_policy" ON public.user_profiles;
DROP POLICY IF EXISTS "profile_select_policy" ON public.user_profiles;
DROP POLICY IF EXISTS "profile_update_policy" ON public.user_profiles;

-- Create simplified policies
CREATE POLICY "service_role_all_access" ON public.user_profiles
  FOR ALL 
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "support_admin_full_access" ON public.user_profiles
  FOR ALL 
  TO authenticated
  USING (
    auth.jwt() ->> 'email' = 'support@yamobility.de'
  )
  WITH CHECK (
    auth.jwt() ->> 'email' = 'support@yamobility.de'
  );

CREATE POLICY "users_own_profile" ON public.user_profiles
  FOR ALL 
  TO authenticated
  USING (
    user_id = auth.uid() OR 
    auth.jwt() ->> 'email' = 'support@yamobility.de'
  )
  WITH CHECK (
    user_id = auth.uid() OR 
    auth.jwt() ->> 'email' = 'support@yamobility.de'
  );

-- Ensure the trigger function has proper permissions
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger 
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email, 'Unknown User'),
    'viewer'
  );
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log the error but don't fail the user creation
    RAISE WARNING 'Failed to create user profile for %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;

-- Recreate the trigger
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW 
  EXECUTE FUNCTION public.handle_new_user();

-- Grant execute permission on the function
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO authenticated;