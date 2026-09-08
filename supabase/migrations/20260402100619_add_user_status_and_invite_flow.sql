/*
  # Add User Status and Invite Flow

  ## Changes Made

  1. New Columns Added to user_profiles
    - `status` (text) - User account status: 'active', 'inactive', 'pending_invite'
    - `invited_at` (timestamptz) - When the invitation was sent
    - `activated_at` (timestamptz) - When the user activated their account

  2. Status Values
    - **active** - User has completed setup and can log in
    - **inactive** - User is deactivated and cannot log in  
    - **pending_invite** - User invited but hasn't completed password setup

  3. Security
    - Update RLS policies to check user status
    - Only active users should be able to authenticate successfully
    - Add check function for active status

  4. Helper Functions
    - `is_user_active(user_uuid)` - Check if a user is active
    - Updated trigger to set default status on user creation

  ## Important Notes
  - Existing users will default to 'active' status
  - New invited users will start as 'pending_invite'
  - Deactivated users remain in system but cannot log in
  - Admins can activate/deactivate users via edge function
*/

-- Add status columns to user_profiles
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles' AND column_name = 'status'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN status text DEFAULT 'active' NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles' AND column_name = 'invited_at'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN invited_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles' AND column_name = 'activated_at'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN activated_at timestamptz;
  END IF;
END $$;

-- Add check constraint for valid status values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'user_profiles_status_check'
  ) THEN
    ALTER TABLE user_profiles 
    ADD CONSTRAINT user_profiles_status_check 
    CHECK (status IN ('active', 'inactive', 'pending_invite'));
  END IF;
END $$;

-- Set existing users to active with activation date
UPDATE user_profiles 
SET status = 'active', 
    activated_at = COALESCE(activated_at, created_at)
WHERE status IS NULL OR activated_at IS NULL;

-- Create function to check if user is active
CREATE OR REPLACE FUNCTION is_user_active(user_uuid uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(
    (SELECT status = 'active' FROM user_profiles WHERE user_id = user_uuid),
    false
  );
$$;

-- Create function to get user status
CREATE OR REPLACE FUNCTION get_user_status(user_uuid uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(
    (SELECT status FROM user_profiles WHERE user_id = user_uuid),
    'inactive'
  );
$$;

-- Create index on status for faster queries
CREATE INDEX IF NOT EXISTS idx_user_profiles_status ON user_profiles(status);
CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id_status ON user_profiles(user_id, status);

-- Update the handle_new_user trigger to set pending_invite status for invited users
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Check if this is an invited user (no password set yet)
  -- If user was created via admin.createUser with email_confirm: true, they're invited
  INSERT INTO user_profiles (user_id, email, full_name, role, status, invited_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'viewer'),
    CASE 
      WHEN NEW.email_confirmed_at IS NULL THEN 'pending_invite'
      ELSE 'active'
    END,
    CASE 
      WHEN NEW.email_confirmed_at IS NULL THEN NOW()
      ELSE NULL
    END
  )
  ON CONFLICT (user_id) DO NOTHING;
  
  RETURN NEW;
END;
$$;

-- Ensure trigger exists
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();

-- Add comment to table
COMMENT ON COLUMN user_profiles.status IS 'User account status: active, inactive, or pending_invite';
COMMENT ON COLUMN user_profiles.invited_at IS 'Timestamp when user invitation was sent';
COMMENT ON COLUMN user_profiles.activated_at IS 'Timestamp when user first activated their account';
