-- Run these queries ONE AT A TIME in Supabase SQL Editor
-- Copy each query separately and run it

-- QUERY 1: Check all user profiles
SELECT
  id as profile_id,
  user_id as auth_user_id,
  email,
  role,
  created_at
FROM user_profiles
ORDER BY created_at;
