/*
  # Authentication Setup

  1. Authentication Configuration
    - Enable email/password authentication
    - Set up user profiles with roles
    - Configure admin user

  2. Security
    - Enable RLS on all tables
    - Set up proper policies for role-based access
    - Create functions for role management

  3. Admin User
    - Create admin user: support@yamobility.de
    - Set admin role and permissions
*/

-- Create user profiles table if it doesn't exist
CREATE TABLE IF NOT EXISTS user_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text,
  role text NOT NULL DEFAULT 'viewer',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Enable RLS on user_profiles
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- Create function to get current user role
CREATE OR REPLACE FUNCTION get_current_user_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT COALESCE(
    (SELECT role FROM user_profiles WHERE user_id = auth.uid()),
    'viewer'
  );
$$;

-- Create function to get user ID from auth
CREATE OR REPLACE FUNCTION uid()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT auth.uid();
$$;

-- User profiles policies
CREATE POLICY "Users can view own profile"
  ON user_profiles
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR get_current_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "Users can update own profile"
  ON user_profiles
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Admins can manage all profiles"
  ON user_profiles
  FOR ALL
  TO authenticated
  USING (get_current_user_role() = 'admin')
  WITH CHECK (get_current_user_role() = 'admin');

-- Enable RLS on receipts table
ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;

-- Update receipts policies
DROP POLICY IF EXISTS "Receipts: select owner or role-based" ON receipts;
DROP POLICY IF EXISTS "Receipts: insert with matching user or elevated role" ON receipts;
DROP POLICY IF EXISTS "Receipts: update owner or elevated role" ON receipts;
DROP POLICY IF EXISTS "Receipts: delete owner or supervisor/admin" ON receipts;

CREATE POLICY "Receipts: select authenticated users"
  ON receipts
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Receipts: insert authenticated users"
  ON receipts
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid() OR get_current_user_role() IN ('editor', 'supervisor', 'admin'));

CREATE POLICY "Receipts: update authenticated users"
  ON receipts
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid() OR get_current_user_role() IN ('editor', 'supervisor', 'admin'))
  WITH CHECK (user_id = auth.uid() OR get_current_user_role() IN ('editor', 'supervisor', 'admin'));

CREATE POLICY "Receipts: delete authenticated users"
  ON receipts
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid() OR get_current_user_role() IN ('supervisor', 'admin'));

-- Enable RLS on drivers table
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;

-- Update drivers policies
DROP POLICY IF EXISTS "Drivers: select owner or role-based" ON drivers;
DROP POLICY IF EXISTS "Drivers: insert with matching user or elevated role" ON drivers;
DROP POLICY IF EXISTS "Drivers: update owner or elevated role" ON drivers;
DROP POLICY IF EXISTS "Drivers: delete owner or supervisor/admin" ON drivers;

CREATE POLICY "Drivers: select authenticated users"
  ON drivers
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Drivers: insert authenticated users"
  ON drivers
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid() OR get_current_user_role() IN ('editor', 'supervisor', 'admin'));

CREATE POLICY "Drivers: update authenticated users"
  ON drivers
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid() OR get_current_user_role() IN ('editor', 'supervisor', 'admin'))
  WITH CHECK (user_id = auth.uid() OR get_current_user_role() IN ('editor', 'supervisor', 'admin'));

CREATE POLICY "Drivers: delete authenticated users"
  ON drivers
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid() OR get_current_user_role() IN ('supervisor', 'admin'));

-- Create trigger to automatically create user profile
CREATE OR REPLACE FUNCTION create_user_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO user_profiles (user_id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    CASE 
      WHEN NEW.email = 'support@yamobility.de' THEN 'admin'
      ELSE 'viewer'
    END
  );
  RETURN NEW;
END;
$$;

-- Create trigger on auth.users
DROP TRIGGER IF EXISTS create_user_profile_trigger ON auth.users;
CREATE TRIGGER create_user_profile_trigger
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION create_user_profile();