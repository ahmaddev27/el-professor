/*
  # Fix Missing Email Column in User Profiles

  ## Problem Fixed
  The user_profiles table is missing the email column which is referenced
  by several triggers and indexes. This migration adds the email column back.

  ## Changes Made
  1. Add email column to user_profiles table
  2. Populate email from auth.users for existing profiles
  3. Recreate index on email column
  4. Update trigger functions to include email
  
  ## Security
  - Maintains existing RLS policies
  - No changes to security model
*/

-- Add email column to user_profiles if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' 
    AND column_name = 'email'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN email text;
  END IF;
END $$;

-- Populate email from auth.users for existing profiles
UPDATE user_profiles up
SET email = au.email
FROM auth.users au
WHERE up.user_id = au.id
AND up.email IS NULL;

-- Make email NOT NULL after populating
ALTER TABLE user_profiles ALTER COLUMN email SET NOT NULL;

-- Recreate index on email
DROP INDEX IF EXISTS idx_user_profiles_email;
CREATE INDEX idx_user_profiles_email ON user_profiles(email);

-- Update the create_user_profile trigger function to include email
CREATE OR REPLACE FUNCTION public.create_user_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_profiles (
    user_id,
    email,
    full_name,
    role,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    CASE 
      WHEN NEW.email = 'support@yamobility.de' THEN 'admin'
      ELSE 'viewer'
    END,
    NOW(),
    NOW()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(EXCLUDED.full_name, user_profiles.full_name),
    updated_at = NOW();
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Failed to create user profile for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;

-- Ensure the trigger exists
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.create_user_profile();