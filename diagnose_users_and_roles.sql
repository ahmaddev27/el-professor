-- DIAGNOSTIC SQL: Check users, roles, and income policies
-- Run this in Supabase SQL Editor to diagnose the problem

-- 1. Check all user profiles with their IDs and roles
SELECT
  'USER PROFILES' as section,
  id as profile_id,
  user_id as auth_user_id,
  email,
  role,
  created_at
FROM user_profiles
ORDER BY created_at;

-- 2. Check current RLS policies on income table
SELECT
  'INCOME RLS POLICIES' as section,
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd as command,
  qual as using_expression,
  with_check as with_check_expression
FROM pg_policies
WHERE tablename = 'income' AND schemaname = 'public'
ORDER BY cmd;

-- 3. Check structure of income table
SELECT
  'INCOME TABLE STRUCTURE' as section,
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'income'
ORDER BY ordinal_position;

-- 4. Check current authenticated user info
SELECT
  'CURRENT USER INFO' as section,
  auth.uid() as auth_uid,
  auth.jwt() -> 'email' as jwt_email,
  (SELECT id FROM user_profiles WHERE user_id::uuid = auth.uid() LIMIT 1) as profile_id,
  (SELECT email FROM user_profiles WHERE user_id::uuid = auth.uid() LIMIT 1) as profile_email,
  (SELECT role FROM user_profiles WHERE user_id::uuid = auth.uid() LIMIT 1) as profile_role;

-- 5. Check existing income records
SELECT
  'EXISTING INCOME RECORDS' as section,
  id,
  description,
  amount,
  type,
  driver_name,
  date,
  created_by,
  (SELECT email FROM user_profiles WHERE id = income.created_by LIMIT 1) as created_by_email,
  created_at
FROM income
ORDER BY created_at DESC
LIMIT 10;

-- 6. Test if INSERT would work with your current user
SELECT
  'INSERT TEST' as section,
  CASE
    WHEN (SELECT id FROM user_profiles WHERE user_id::uuid = auth.uid() LIMIT 1) IS NOT NULL
    THEN 'Your profile ID: ' || (SELECT id FROM user_profiles WHERE user_id::uuid = auth.uid() LIMIT 1)::text
    ELSE 'ERROR: No profile found for your auth.uid()'
  END as test_result;

-- 7. Check if RLS is enabled
SELECT
  'RLS STATUS' as section,
  schemaname,
  tablename,
  rowsecurity as rls_enabled
FROM pg_tables
WHERE tablename = 'income' AND schemaname = 'public';
