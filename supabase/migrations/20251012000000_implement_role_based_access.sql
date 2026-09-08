/*
  # Implement Role-Based Access Control

  ## Summary
  This migration implements a comprehensive role-based access control (RBAC) system
  with three roles: admin, creator, and viewer.

  ## Changes Made

  ### 1. Role System Updates
  - Update user_profiles.role to use CHECK constraint for admin/creator/viewer only
  - Create is_role() helper function for permission checks
  - Update default role assignment logic

  ### 2. Table Schema Updates
  - Ensure all domain tables have created_by column as UUID referencing auth.users(id)
  - Add appropriate indexes for performance
  - Backfill created_by where needed

  ### 3. Row Level Security Policies

  #### Receipts Table
  - SELECT: All authenticated users can read
  - INSERT: Admins and creators only
  - UPDATE: Admin or record owner
  - DELETE: Admin or record owner

  #### Drivers Table
  - SELECT: All authenticated users can read
  - INSERT: Admins and creators only
  - UPDATE: Admin or record owner
  - DELETE: Admin or record owner

  #### Income Table
  - SELECT: All authenticated users can read
  - INSERT: Admins and creators only
  - UPDATE: Admin or record owner
  - DELETE: Admin or record owner

  #### Fixed Costs Table
  - SELECT: All authenticated users can read
  - INSERT: Admins and creators only
  - UPDATE: Admin or record owner
  - DELETE: Admin or record owner

  ## Security Notes
  - Viewers can only read data, no modifications allowed
  - Creators can create records and modify their own
  - Admins can modify/delete any record
  - All policies enforce permissions at the database level
  - UI should reflect these permissions but DB is the source of truth
*/

-- ============================================================================
-- 1. UPDATE ROLE SYSTEM
-- ============================================================================

-- Drop old role constraint if it exists and add new one
ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_role_check;
ALTER TABLE user_profiles
  ADD CONSTRAINT user_profiles_role_check
  CHECK (role IN ('admin', 'creator', 'viewer'));

-- Update existing roles to new system (map old roles to new)
UPDATE user_profiles SET role = 'admin'
WHERE role IN ('admin', 'supervisor');

UPDATE user_profiles SET role = 'creator'
WHERE role IN ('editor', 'user');

UPDATE user_profiles SET role = 'viewer'
WHERE role NOT IN ('admin', 'creator');

-- Create is_role helper function
CREATE OR REPLACE FUNCTION public.is_role(r text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.user_profiles p
    WHERE p.user_id = auth.uid() AND p.role = r
  );
$$;

-- Update get_current_user_role function
CREATE OR REPLACE FUNCTION public.get_current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT role FROM public.user_profiles WHERE user_id = auth.uid()),
    'viewer'
  );
$$;

-- Update user profile creation trigger
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
    updated_at = NOW();

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Failed to create user profile for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;

-- ============================================================================
-- 2. UPDATE TABLE SCHEMAS - Ensure created_by is UUID
-- ============================================================================

-- Update receipts.created_by to UUID if it's text
DO $$
BEGIN
  -- Check if created_by exists and is text
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'receipts'
    AND column_name = 'created_by'
    AND data_type = 'text'
  ) THEN
    -- Add new UUID column
    ALTER TABLE receipts ADD COLUMN created_by_uuid uuid;

    -- Try to map text emails to user IDs
    UPDATE receipts r
    SET created_by_uuid = up.user_id
    FROM user_profiles up
    WHERE r.created_by = up.email;

    -- For unmapped records, try to use user_id if it exists
    UPDATE receipts
    SET created_by_uuid = user_id
    WHERE created_by_uuid IS NULL AND user_id IS NOT NULL;

    -- Drop old column and rename new one
    ALTER TABLE receipts DROP COLUMN created_by;
    ALTER TABLE receipts RENAME COLUMN created_by_uuid TO created_by;
  END IF;

  -- Ensure created_by column exists as UUID
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'receipts' AND column_name = 'created_by'
  ) THEN
    ALTER TABLE receipts ADD COLUMN created_by uuid REFERENCES auth.users(id);
  END IF;

  -- Set default for new records
  ALTER TABLE receipts ALTER COLUMN created_by SET DEFAULT auth.uid();
END $$;

-- Update drivers.created_by to UUID if needed
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers'
    AND column_name = 'created_by'
    AND data_type = 'text'
  ) THEN
    ALTER TABLE drivers ADD COLUMN created_by_uuid uuid;

    UPDATE drivers d
    SET created_by_uuid = up.user_id
    FROM user_profiles up
    WHERE d.created_by = up.email;

    UPDATE drivers
    SET created_by_uuid = user_id
    WHERE created_by_uuid IS NULL AND user_id IS NOT NULL;

    ALTER TABLE drivers DROP COLUMN created_by;
    ALTER TABLE drivers RENAME COLUMN created_by_uuid TO created_by;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'created_by'
  ) THEN
    ALTER TABLE drivers ADD COLUMN created_by uuid REFERENCES auth.users(id);
  END IF;

  ALTER TABLE drivers ALTER COLUMN created_by SET DEFAULT auth.uid();
END $$;

-- Ensure income table has created_by as UUID
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'income') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'income' AND column_name = 'created_by'
    ) THEN
      ALTER TABLE income ADD COLUMN created_by uuid REFERENCES auth.users(id) DEFAULT auth.uid();
    END IF;
  END IF;
END $$;

-- Ensure fixed_costs table has created_by as UUID
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'fixed_costs') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'fixed_costs' AND column_name = 'created_by'
    ) THEN
      ALTER TABLE fixed_costs ADD COLUMN created_by uuid REFERENCES auth.users(id) DEFAULT auth.uid();
    END IF;
  END IF;
END $$;

-- ============================================================================
-- 3. ROW LEVEL SECURITY POLICIES
-- ============================================================================

-- ============================================================================
-- RECEIPTS TABLE POLICIES
-- ============================================================================

-- Drop all existing policies
DROP POLICY IF EXISTS "Receipts: select authenticated users" ON receipts;
DROP POLICY IF EXISTS "Receipts: insert authenticated users" ON receipts;
DROP POLICY IF EXISTS "Receipts: update authenticated users" ON receipts;
DROP POLICY IF EXISTS "Receipts: delete authenticated users" ON receipts;
DROP POLICY IF EXISTS "Allow authenticated users to read receipts" ON receipts;
DROP POLICY IF EXISTS "Allow authenticated users to insert receipts" ON receipts;
DROP POLICY IF EXISTS "Allow users to update own receipts or admins to update any" ON receipts;
DROP POLICY IF EXISTS "Allow users to delete own receipts or admins to delete any" ON receipts;

-- Everyone authenticated can read
CREATE POLICY "receipts_select"
  ON receipts
  FOR SELECT
  TO authenticated
  USING (true);

-- Insert: only admins and creators
CREATE POLICY "receipts_insert"
  ON receipts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    is_role('admin') OR is_role('creator')
  );

-- Update: admin or record owner
CREATE POLICY "receipts_update"
  ON receipts
  FOR UPDATE
  TO authenticated
  USING (
    is_role('admin') OR created_by = auth.uid()
  )
  WITH CHECK (
    is_role('admin') OR created_by = auth.uid()
  );

-- Delete: admin or record owner
CREATE POLICY "receipts_delete"
  ON receipts
  FOR DELETE
  TO authenticated
  USING (
    is_role('admin') OR created_by = auth.uid()
  );

-- ============================================================================
-- DRIVERS TABLE POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Drivers: select authenticated users" ON drivers;
DROP POLICY IF EXISTS "Drivers: insert authenticated users" ON drivers;
DROP POLICY IF EXISTS "Drivers: update authenticated users" ON drivers;
DROP POLICY IF EXISTS "Drivers: delete authenticated users" ON drivers;
DROP POLICY IF EXISTS "Allow authenticated users to read drivers" ON drivers;
DROP POLICY IF EXISTS "Allow authenticated users to insert drivers" ON drivers;
DROP POLICY IF EXISTS "Allow users to update own drivers or admins to update any" ON drivers;
DROP POLICY IF EXISTS "Allow users to delete own drivers or admins to delete any" ON drivers;

CREATE POLICY "drivers_select"
  ON drivers
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "drivers_insert"
  ON drivers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    is_role('admin') OR is_role('creator')
  );

CREATE POLICY "drivers_update"
  ON drivers
  FOR UPDATE
  TO authenticated
  USING (
    is_role('admin') OR created_by = auth.uid()
  )
  WITH CHECK (
    is_role('admin') OR created_by = auth.uid()
  );

CREATE POLICY "drivers_delete"
  ON drivers
  FOR DELETE
  TO authenticated
  USING (
    is_role('admin') OR created_by = auth.uid()
  );

-- ============================================================================
-- INCOME TABLE POLICIES
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'income') THEN
    -- Drop existing policies
    DROP POLICY IF EXISTS "income_select" ON income;
    DROP POLICY IF EXISTS "income_insert" ON income;
    DROP POLICY IF EXISTS "income_update" ON income;
    DROP POLICY IF EXISTS "income_delete" ON income;
    DROP POLICY IF EXISTS "Allow all authenticated users to read income entries" ON income;
    DROP POLICY IF EXISTS "Allow authenticated users to insert income entries" ON income;
    DROP POLICY IF EXISTS "Allow users to update own income or admins/support" ON income;
    DROP POLICY IF EXISTS "Allow users to delete own income or admins/support" ON income;

    -- Enable RLS
    ALTER TABLE income ENABLE ROW LEVEL SECURITY;

    -- Create new policies
    EXECUTE 'CREATE POLICY "income_select" ON income FOR SELECT TO authenticated USING (true)';
    EXECUTE 'CREATE POLICY "income_insert" ON income FOR INSERT TO authenticated WITH CHECK (is_role(''admin'') OR is_role(''creator''))';
    EXECUTE 'CREATE POLICY "income_update" ON income FOR UPDATE TO authenticated USING (is_role(''admin'') OR created_by = auth.uid()) WITH CHECK (is_role(''admin'') OR created_by = auth.uid())';
    EXECUTE 'CREATE POLICY "income_delete" ON income FOR DELETE TO authenticated USING (is_role(''admin'') OR created_by = auth.uid())';
  END IF;
END $$;

-- ============================================================================
-- FIXED_COSTS TABLE POLICIES
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'fixed_costs') THEN
    -- Drop existing policies
    DROP POLICY IF EXISTS "fixed_costs_select" ON fixed_costs;
    DROP POLICY IF EXISTS "fixed_costs_insert" ON fixed_costs;
    DROP POLICY IF EXISTS "fixed_costs_update" ON fixed_costs;
    DROP POLICY IF EXISTS "fixed_costs_delete" ON fixed_costs;
    DROP POLICY IF EXISTS "Allow all authenticated users to read fixed costs" ON fixed_costs;
    DROP POLICY IF EXISTS "Allow authenticated users to insert fixed costs" ON fixed_costs;
    DROP POLICY IF EXISTS "Allow users to update own costs or admins/support" ON fixed_costs;
    DROP POLICY IF EXISTS "Allow users to delete own costs or admins/support" ON fixed_costs;

    -- Enable RLS
    ALTER TABLE fixed_costs ENABLE ROW LEVEL SECURITY;

    -- Create new policies
    EXECUTE 'CREATE POLICY "fixed_costs_select" ON fixed_costs FOR SELECT TO authenticated USING (true)';
    EXECUTE 'CREATE POLICY "fixed_costs_insert" ON fixed_costs FOR INSERT TO authenticated WITH CHECK (is_role(''admin'') OR is_role(''creator''))';
    EXECUTE 'CREATE POLICY "fixed_costs_update" ON fixed_costs FOR UPDATE TO authenticated USING (is_role(''admin'') OR created_by = auth.uid()) WITH CHECK (is_role(''admin'') OR created_by = auth.uid())';
    EXECUTE 'CREATE POLICY "fixed_costs_delete" ON fixed_costs FOR DELETE TO authenticated USING (is_role(''admin'') OR created_by = auth.uid())';
  END IF;
END $$;

-- ============================================================================
-- CREATE INDEXES FOR PERFORMANCE
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_receipts_created_by ON receipts(created_by);
CREATE INDEX IF NOT EXISTS idx_drivers_created_by ON drivers(created_by);
CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON user_profiles(role);
CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'income') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_income_created_by ON income(created_by)';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'fixed_costs') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_fixed_costs_created_by ON fixed_costs(created_by)';
  END IF;
END $$;
