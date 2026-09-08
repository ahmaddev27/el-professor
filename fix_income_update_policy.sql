/*
  FIX: created_by contains emails. user_profiles.id is bigint, not uuid.
  We need to use bigint for created_by instead of uuid.
*/

-- Step 1: Drop ALL policies on income table
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

-- Step 2: Add a temporary column for the bigint user ID
ALTER TABLE income ADD COLUMN created_by_bigint bigint;

-- Step 3: Map email addresses to user IDs from user_profiles
UPDATE income 
SET created_by_bigint = user_profiles.id
FROM user_profiles
WHERE income.created_by = user_profiles.email;

-- Step 4: Drop old text column and rename new bigint column
ALTER TABLE income DROP COLUMN created_by;
ALTER TABLE income RENAME COLUMN created_by_bigint TO created_by;

-- Step 5: Create new policies with proper bigint comparison
-- Note: auth.uid() returns uuid, so we need to join with user_profiles to get the bigint id
CREATE POLICY "Authenticated users can view income"
  ON income
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert income"
  ON income
  FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = (SELECT id FROM user_profiles WHERE user_profiles.id = (auth.jwt() ->> 'user_id')::bigint LIMIT 1)
  );

CREATE POLICY "Users can update own income or support can update all"
  ON income
  FOR UPDATE
  TO authenticated
  USING (
    created_by = (SELECT id FROM user_profiles WHERE user_profiles.id = (auth.jwt() ->> 'user_id')::bigint LIMIT 1) OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (auth.jwt() ->> 'user_id')::bigint
      AND user_profiles.email = 'support@yamobility.de'
    )
  )
  WITH CHECK (
    created_by = (SELECT id FROM user_profiles WHERE user_profiles.id = (auth.jwt() ->> 'user_id')::bigint LIMIT 1) OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (auth.jwt() ->> 'user_id')::bigint
      AND user_profiles.email = 'support@yamobility.de'
    )
  );

CREATE POLICY "Users can delete own income or support can delete all"
  ON income
  FOR DELETE
  TO authenticated
  USING (
    created_by = (SELECT id FROM user_profiles WHERE user_profiles.id = (auth.jwt() ->> 'user_id')::bigint LIMIT 1) OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (auth.jwt() ->> 'user_id')::bigint
      AND user_profiles.email = 'support@yamobility.de'
    )
  );

SELECT 'Income table fixed - emails converted to bigint user IDs!' as status;
