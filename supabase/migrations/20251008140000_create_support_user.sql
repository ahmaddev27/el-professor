/*
  # Create Support User

  1. Changes
    - Create support@yamobility.de user in auth.users table
    - Create corresponding user profile
    - Set role as 'admin'

  2. Security
    - User is created with a secure default password that should be changed
    - Email is automatically confirmed
    - Has admin role for full system access

  3. Important
    - The default password is: SupportYamo2024!
    - This should be changed immediately after first login
*/

-- Create the support user in auth.users
DO $$
DECLARE
  support_user_id uuid;
  support_email text := 'support@yamobility.de';
  support_password text := 'SupportYamo2024!';
BEGIN
  -- Check if user already exists
  SELECT id INTO support_user_id
  FROM auth.users
  WHERE email = support_email;

  -- Only create if doesn't exist
  IF support_user_id IS NULL THEN
    -- Insert into auth.users
    INSERT INTO auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      recovery_sent_at,
      last_sign_in_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      confirmation_token,
      email_change,
      email_change_token_new,
      recovery_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      gen_random_uuid(),
      'authenticated',
      'authenticated',
      support_email,
      crypt(support_password, gen_salt('bf')),
      NOW(),
      NOW(),
      NOW(),
      '{"provider":"email","providers":["email"]}',
      jsonb_build_object('full_name', 'Support Admin'),
      NOW(),
      NOW(),
      '',
      '',
      '',
      ''
    )
    RETURNING id INTO support_user_id;

    -- Insert into user_profiles
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

    RAISE NOTICE 'Support user created successfully with ID: %', support_user_id;
    RAISE NOTICE 'Default password: SupportYamo2024! (please change after first login)';
  ELSE
    RAISE NOTICE 'Support user already exists with ID: %', support_user_id;
  END IF;
END $$;
