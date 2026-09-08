-- Run this SQL in your Supabase SQL Editor to create the support user profile
-- This assumes the support@yamobility.de user already exists in auth.users

DO $$
DECLARE
  support_user_id uuid;
  support_email text := 'support@yamobility.de';
BEGIN
  -- Get the user ID from auth.users
  SELECT id INTO support_user_id
  FROM auth.users
  WHERE email = support_email;

  IF support_user_id IS NULL THEN
    RAISE EXCEPTION 'Support user % does not exist in auth.users. Please create the user first through Supabase Auth.', support_email;
  END IF;

  -- Check if profile already exists
  IF EXISTS (SELECT 1 FROM user_profiles WHERE user_id = support_user_id) THEN
    -- Update existing profile to admin
    UPDATE user_profiles
    SET
      role = 'admin',
      full_name = 'Support Admin',
      email = support_email,
      updated_at = NOW()
    WHERE user_id = support_user_id;

    RAISE NOTICE 'Profile updated for support user % with ID: %', support_email, support_user_id;
  ELSE
    -- Create new profile
    INSERT INTO user_profiles (
      user_id,
      email,
      full_name,
      role,
      created_at,
      updated_at
    ) VALUES (
      support_user_id,
      support_email,
      'Support Admin',
      'admin',
      NOW(),
      NOW()
    );

    RAISE NOTICE 'Profile created for support user % with ID: %', support_email, support_user_id;
  END IF;
END $$;
