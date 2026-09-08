/*
  # Fix Income Table RLS Policies - Correct Auth Check

  1. Changes
    - Drop all existing income policies
    - Recreate policies with correct auth.uid() checks
    - Support role-based access using user_profiles.role = 'admin'
    - Remove hardcoded email checks

  2. Security
    - SELECT: All authenticated users can view all income
    - INSERT: Users can insert with their own created_by ID
    - UPDATE: Users can update their own records, admins can update all
    - DELETE: Users can delete their own records, admins can delete all
*/

-- Drop all existing policies
DROP POLICY IF EXISTS "Authenticated users can view income" ON income;
DROP POLICY IF EXISTS "Authenticated users can insert income" ON income;
DROP POLICY IF EXISTS "Users can update own income or support can update all" ON income;
DROP POLICY IF EXISTS "Users can delete own income or support can delete all" ON income;

-- SELECT: All authenticated users can view all income
CREATE POLICY "Authenticated users can view all income"
  ON income
  FOR SELECT
  TO authenticated
  USING (true);

-- INSERT: Users can insert income with their own created_by ID
CREATE POLICY "Users can insert own income"
  ON income
  FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = (
      SELECT id FROM user_profiles
      WHERE user_id = auth.uid()
      LIMIT 1
    )
  );

-- UPDATE: Users can update their own income, admins can update all
CREATE POLICY "Users can update own income, admins can update all"
  ON income
  FOR UPDATE
  TO authenticated
  USING (
    created_by = (
      SELECT id FROM user_profiles
      WHERE user_id = auth.uid()
      LIMIT 1
    )
    OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid()
      AND role = 'admin'
    )
  )
  WITH CHECK (
    created_by = (
      SELECT id FROM user_profiles
      WHERE user_id = auth.uid()
      LIMIT 1
    )
    OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid()
      AND role = 'admin'
    )
  );

-- DELETE: Users can delete their own income, admins can delete all
CREATE POLICY "Users can delete own income, admins can delete all"
  ON income
  FOR DELETE
  TO authenticated
  USING (
    created_by = (
      SELECT id FROM user_profiles
      WHERE user_id = auth.uid()
      LIMIT 1
    )
    OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid()
      AND role = 'admin'
    )
  );
