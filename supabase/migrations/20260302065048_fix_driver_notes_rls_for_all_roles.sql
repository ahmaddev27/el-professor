/*
  # Fix Driver Notes RLS Policies for All Roles

  1. Changes
    - Drop all existing 'support' role policies
    - Create new policies that work with admin, supervisor, and editor roles
    - Admin and supervisor can access all notes
    - Editors can only access notes for their own drivers

  2. Security
    - Maintains proper access control based on role hierarchy
    - Admin and supervisor have full access
    - Editors have restricted access to their own data
*/

-- Drop all existing policies
DROP POLICY IF EXISTS "Support can view all notes" ON driver_notes;
DROP POLICY IF EXISTS "Support can insert notes for any driver" ON driver_notes;
DROP POLICY IF EXISTS "Support can update any note" ON driver_notes;
DROP POLICY IF EXISTS "Support can delete any note" ON driver_notes;
DROP POLICY IF EXISTS "Users can view notes for own drivers" ON driver_notes;
DROP POLICY IF EXISTS "Users can insert notes for own drivers" ON driver_notes;
DROP POLICY IF EXISTS "Users can update own notes" ON driver_notes;
DROP POLICY IF EXISTS "Users can delete own notes" ON driver_notes;

-- SELECT policies
CREATE POLICY "Admin and supervisor can view all notes"
  ON driver_notes
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role IN ('admin', 'supervisor')
    )
  );

CREATE POLICY "Editors can view notes for own drivers"
  ON driver_notes
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM drivers
      WHERE drivers.id = driver_notes.driver_id
      AND drivers.created_by = (auth.uid())::text
    )
  );

-- INSERT policies
CREATE POLICY "Admin and supervisor can insert any note"
  ON driver_notes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role IN ('admin', 'supervisor')
    )
  );

CREATE POLICY "Editors can insert notes for own drivers"
  ON driver_notes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM drivers
      WHERE drivers.id = driver_notes.driver_id
      AND drivers.created_by = (auth.uid())::text
    )
  );

-- UPDATE policies
CREATE POLICY "Admin and supervisor can update any note"
  ON driver_notes
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role IN ('admin', 'supervisor')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role IN ('admin', 'supervisor')
    )
  );

CREATE POLICY "Editors can update own notes"
  ON driver_notes
  FOR UPDATE
  TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

-- DELETE policies
CREATE POLICY "Admin and supervisor can delete any note"
  ON driver_notes
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role IN ('admin', 'supervisor')
    )
  );

CREATE POLICY "Editors can delete own notes"
  ON driver_notes
  FOR DELETE
  TO authenticated
  USING (created_by = auth.uid());
