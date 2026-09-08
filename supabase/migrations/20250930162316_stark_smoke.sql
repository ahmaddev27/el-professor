/*
  # Enable user management for support admin

  1. Security Updates
    - Add RLS policies for user management by support admin
    - Enable service role access for user administration
    - Add proper permissions for user profile management

  2. Functions
    - Create helper function to check if user is support admin
    - Update existing functions for better user management

  3. Policies
    - Allow support admin to manage all user profiles
    - Enable user profile creation and updates
    - Secure access to user management features
*/

-- Create function to check if current user is support admin
CREATE OR REPLACE FUNCTION is_support_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(
    (SELECT email FROM auth.users WHERE id = auth.uid()) = 'support@yamobility.de',
    false
  );
$$;

-- Grant necessary permissions for user management
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT SELECT ON auth.users TO service_role;

-- Update user profiles policies for support admin
DROP POLICY IF EXISTS "Support admin can manage all profiles" ON user_profiles;
CREATE POLICY "Support admin can manage all profiles"
  ON user_profiles
  FOR ALL
  TO authenticated
  USING (is_support_admin())
  WITH CHECK (is_support_admin());

-- Allow support admin to view all user profiles
DROP POLICY IF EXISTS "Support admin can view all profiles" ON user_profiles;
CREATE POLICY "Support admin can view all profiles"
  ON user_profiles
  FOR SELECT
  TO authenticated
  USING (is_support_admin());

-- Update the create_user_profile function to handle support admin operations
CREATE OR REPLACE FUNCTION create_user_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  BEGIN
    -- Create user profile with default role
    INSERT INTO public.user_profiles (user_id, full_name, role)
    VALUES (
      NEW.id,
      COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
      CASE 
        WHEN NEW.email = 'support@yamobility.de' THEN 'admin'
        ELSE 'viewer'
      END
    );
    
    RETURN NEW;
  EXCEPTION
    WHEN unique_violation THEN
      -- Profile already exists, update it instead
      UPDATE public.user_profiles 
      SET 
        full_name = COALESCE(NEW.raw_user_meta_data->>'full_name', full_name),
        updated_at = now()
      WHERE user_id = NEW.id;
      
      RETURN NEW;
    WHEN OTHERS THEN
      -- Log the error but don't fail the user creation
      RAISE WARNING 'Failed to create user profile for %: %', NEW.id, SQLERRM;
      RETURN NEW;
  END;
END;
$$;

-- Ensure the trigger exists
DROP TRIGGER IF EXISTS create_user_profile_trigger ON auth.users;
CREATE TRIGGER create_user_profile_trigger
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION create_user_profile();

-- Add index for better performance on email lookups
CREATE INDEX IF NOT EXISTS idx_auth_users_email ON auth.users(email);

-- Grant permissions to authenticated users for profile management
GRANT SELECT, INSERT, UPDATE ON user_profiles TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE user_profiles_id_seq TO authenticated;

-- Ensure support admin gets admin role
DO $$
BEGIN
  -- Update support admin profile if it exists
  UPDATE user_profiles 
  SET role = 'admin'
  WHERE user_id IN (
    SELECT id FROM auth.users WHERE email = 'support@yamobility.de'
  );
  
  -- If no rows were updated, the profile might not exist yet
  -- The trigger will handle it when the user signs in
END $$;