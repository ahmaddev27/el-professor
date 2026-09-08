/*
  # Fix Driver Notes Select Policy - Type Mismatch

  1. Issue
    - The SELECT policy compares drivers.created_by (TEXT) with auth.uid() (UUID)
    - This type mismatch prevents notes from being visible
    - Need to cast auth.uid() to TEXT for comparison

  2. Solution
    - Update SELECT policy to cast auth.uid()::text
    - This matches the drivers.created_by column type

  3. Security
    - Users can only view notes for drivers they own
    - Support users can view all notes
*/

-- Drop the existing SELECT policy
DROP POLICY IF EXISTS "Users can view notes for own drivers" ON driver_notes;

-- Recreate with proper type casting
CREATE POLICY "Users can view notes for own drivers"
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
