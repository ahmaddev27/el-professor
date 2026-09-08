/*
  # Fix Driver Notes Insert Policy

  1. Changes
    - Drop and recreate the INSERT policy for regular users
    - Fix the type casting issue where created_by is text but auth.uid() returns uuid
    - Properly cast auth.uid()::text to match the created_by column type in drivers table

  2. Security
    - Maintains the same security level: users can only insert notes for their own drivers
    - Support users continue to have full access
*/

-- Drop the existing policy
DROP POLICY IF EXISTS "Users can insert notes for own drivers" ON driver_notes;

-- Recreate with proper type casting
CREATE POLICY "Users can insert notes for own drivers"
  ON driver_notes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = auth.uid() 
    AND EXISTS (
      SELECT 1 
      FROM drivers 
      WHERE drivers.id = driver_notes.driver_id 
      AND drivers.created_by = auth.uid()::text
    )
  );
