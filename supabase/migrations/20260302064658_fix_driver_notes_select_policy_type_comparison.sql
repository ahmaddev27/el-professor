/*
  # Fix Driver Notes SELECT Policy Type Comparison

  1. Changes
    - Drop the existing "Users can view notes for own drivers" policy
    - Create a new policy that properly compares UUID types
    - The issue was that drivers.created_by is TEXT but we're comparing with auth.uid() which is UUID

  2. Notes
    - This fixes the notes list not showing any data for regular users
    - Support users are unaffected as they have a separate policy
*/

-- Drop the problematic policy
DROP POLICY IF EXISTS "Users can view notes for own drivers" ON driver_notes;

-- Create the corrected policy with proper type casting
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
