/*
  Change admin email from support@yamobility.de to admin@yamobility.de

  Run this in your Supabase SQL Editor to:
  1. Update the user creation trigger to use admin@yamobility.de
  2. Update any existing support@yamobility.de user to admin role
  3. Verify the changes
*/

-- Step 1: Update the trigger function to use admin@yamobility.de
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
      WHEN NEW.email = 'admin@yamobility.de' THEN 'admin'
      ELSE 'creator'
    END,
    NOW(),
    NOW()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(EXCLUDED.full_name, user_profiles.full_name),
    role = CASE
      WHEN EXCLUDED.email = 'admin@yamobility.de' THEN 'admin'
      ELSE user_profiles.role
    END,
    updated_at = NOW();

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Failed to create user profile for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;

-- Step 2: Update admin@yamobility.de user to have admin role
UPDATE user_profiles
SET role = 'admin', updated_at = NOW()
WHERE email = 'admin@yamobility.de';

-- Step 3: Verify the changes
SELECT
  user_id,
  email,
  role,
  full_name,
  created_at,
  updated_at
FROM user_profiles
ORDER BY created_at DESC;
