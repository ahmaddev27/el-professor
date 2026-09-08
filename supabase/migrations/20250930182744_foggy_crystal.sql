/*
  # User Management Database Functions

  1. Functions
    - `create_user_profile` - Automatically creates user profile when auth user is created
    - `handle_new_user` - Trigger function for new user creation
  
  2. Triggers
    - Trigger on auth.users to auto-create profiles
  
  3. Security
    - Proper RLS policies for user management
*/

-- Create function to handle new user creation
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'viewer'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to automatically create user profile
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Create function to get current user role (if not exists)
CREATE OR REPLACE FUNCTION public.get_current_user_role()
RETURNS TEXT AS $$
BEGIN
  RETURN (
    SELECT role 
    FROM user_profiles 
    WHERE user_id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Ensure proper RLS policies exist
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to recreate them
DROP POLICY IF EXISTS "Support admin can manage all profiles" ON user_profiles;
DROP POLICY IF EXISTS "Users can view own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON user_profiles;

-- Create comprehensive RLS policies
CREATE POLICY "Support admin can manage all profiles" ON user_profiles
  FOR ALL USING (
    auth.email() = 'support@yamobility.de'
  );

CREATE POLICY "Users can view own profile" ON user_profiles
  FOR SELECT USING (
    user_id = auth.uid() OR 
    auth.email() = 'support@yamobility.de' OR
    get_current_user_role() IN ('admin', 'supervisor')
  );

CREATE POLICY "Users can update own profile" ON user_profiles
  FOR UPDATE USING (
    user_id = auth.uid() OR 
    auth.email() = 'support@yamobility.de' OR
    get_current_user_role() IN ('admin', 'supervisor')
  );

CREATE POLICY "Support admin can insert profiles" ON user_profiles
  FOR INSERT WITH CHECK (
    auth.email() = 'support@yamobility.de' OR
    get_current_user_role() IN ('admin', 'supervisor')
  );

CREATE POLICY "Support admin can delete profiles" ON user_profiles
  FOR DELETE USING (
    auth.email() = 'support@yamobility.de' OR
    get_current_user_role() = 'admin'
  );

-- Grant necessary permissions
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON public.user_profiles TO authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_current_user_role() TO authenticated;