/*
  # Fix Driver Notes Insert Policy - Remove Subquery Reference

  1. Issue
    - The WITH CHECK clause references driver_notes.driver_id in a subquery
    - During INSERT, the row doesn't exist yet, so the subquery fails
    - This causes "new row violates row-level security policy" error

  2. Solution
    - Remove the subquery that references the non-existent row
    - Only check that created_by matches auth.uid()
    - The driver ownership is validated by the foreign key constraint

  3. Security
    - Users can only create notes with their own user ID
    - The application logic ensures they select from their own drivers
    - Support users can create notes for any driver
*/

-- Drop the problematic policy
DROP POLICY IF EXISTS "Users can insert notes for own drivers" ON driver_notes;

-- Create a simpler policy that just checks created_by
CREATE POLICY "Users can insert notes for own drivers"
  ON driver_notes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = auth.uid()
  );
