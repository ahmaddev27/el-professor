/*
  Run this SQL in your Supabase SQL Editor to fix admin role assignment

  This will:
  1. Update your user profile to have admin role
  2. Show current user roles for verification
*/

-- Update admin@yamobility.de user to admin role
UPDATE user_profiles
SET role = 'admin', updated_at = NOW()
WHERE email = 'admin@yamobility.de';

-- Verify the update
SELECT user_id, email, role, created_at, updated_at
FROM user_profiles
ORDER BY created_at DESC;
