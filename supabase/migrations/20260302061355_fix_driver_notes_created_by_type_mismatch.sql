/*
  # Fix Driver Notes Created By Type Mismatch

  1. Issue
    - driver_notes.created_by is UUID type
    - drivers.created_by is TEXT type
    - The INSERT policy comparison fails due to type mismatch

  2. Solution
    - Update the INSERT policy to cast UUID to TEXT for comparison
    - This ensures the driver ownership check works correctly

  3. Security
    - Maintains all existing security requirements
    - Users can only insert notes for their own drivers
    - Support users can insert notes for any driver
*/

-- Fix the regular user INSERT policy with proper type casting
DROP POLICY IF EXISTS "Users can insert notes for own drivers" ON driver_notes;

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
