/*
  FIX: Income RLS policies to properly work with bigint user IDs from user_profiles
  
  The created_by column now stores user_profiles.id (bigint), not emails or auth.uid()
  We need to map auth.uid() to user_profiles.id in all policies
*/

-- Step 1: Drop ALL existing policies
DO $$ 
DECLARE
    pol record;
BEGIN
    FOR pol IN 
        SELECT policyname 
        FROM pg_policies 
        WHERE tablename = 'income' 
          AND schemaname = 'public'
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON income', pol.policyname);
    END LOOP;
END $$;

-- Step 2: Create new policies that map auth.uid() to user_profiles.id

-- SELECT: All authenticated users can view all income records
CREATE POLICY "Authenticated users can view income"
  ON income
  FOR SELECT
  TO authenticated
  USING (true);

-- INSERT: Users can insert records with their own user_profiles.id
CREATE POLICY "Authenticated users can insert income"
  ON income
  FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = (
      SELECT id FROM user_profiles 
      WHERE user_id = auth.uid()::text 
      LIMIT 1
    )
  );

-- UPDATE: Users can update their own records, admins/support can update all
CREATE POLICY "Users can update own income or admin can update all"
  ON income
  FOR UPDATE
  TO authenticated
  USING (
    created_by = (
      SELECT id FROM user_profiles 
      WHERE user_id = auth.uid()::text 
      LIMIT 1
    )
    OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid()::text
      AND (role = 'admin' OR email = 'support@yamobility.de')
    )
  )
  WITH CHECK (
    created_by = (
      SELECT id FROM user_profiles 
      WHERE user_id = auth.uid()::text 
      LIMIT 1
    )
    OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid()::text
      AND (role = 'admin' OR email = 'support@yamobility.de')
    )
  );

-- DELETE: Users can delete their own records, admins/support can delete all
CREATE POLICY "Users can delete own income or admin can delete all"
  ON income
  FOR DELETE
  TO authenticated
  USING (
    created_by = (
      SELECT id FROM user_profiles 
      WHERE user_id = auth.uid()::text 
      LIMIT 1
    )
    OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid()::text
      AND (role = 'admin' OR email = 'support@yamobility.de')
    )
  );

SELECT 'Income RLS policies updated to work with user_profiles.id!' as status;
