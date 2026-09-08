/*
  # Fix Drop Function Error

  This migration properly drops the function and trigger with CASCADE to resolve dependencies.
*/

-- Drop the trigger first
DROP TRIGGER IF EXISTS create_user_profile_trigger ON auth.users CASCADE;

-- Drop the function with CASCADE to handle any remaining dependencies
DROP FUNCTION IF EXISTS create_user_profile() CASCADE;
DROP FUNCTION IF EXISTS handle_new_user() CASCADE;

-- Recreate the improved function
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'viewer'
  );
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log the error but don't fail the user creation
    RAISE WARNING 'Failed to create user profile for %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Recreate the trigger
CREATE TRIGGER handle_new_user_trigger
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Grant necessary permissions
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Update RLS policies to be more permissive for service role
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to avoid conflicts
DROP POLICY IF EXISTS "Users can read own profile" ON user_profiles;
DROP POLICY IF EXISTS "service_role_all_access" ON user_profiles;
DROP POLICY IF EXISTS "support_admin_full_access" ON user_profiles;
DROP POLICY IF EXISTS "users_own_profile" ON user_profiles;

-- Create simplified policies
CREATE POLICY "service_role_full_access" ON user_profiles
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "users_can_read_own_profile" ON user_profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "support_admin_can_manage_all" ON user_profiles
  FOR ALL TO authenticated
  USING (auth.jwt() ->> 'email' = 'support@yamobility.de')
  WITH CHECK (auth.jwt() ->> 'email' = 'support@yamobility.de');