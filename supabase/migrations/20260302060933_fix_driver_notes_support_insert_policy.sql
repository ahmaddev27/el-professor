/*
  # Fix Driver Notes Support Insert Policy

  1. Changes
    - Drop and recreate the INSERT policy for support users
    - Add proper created_by check to ensure the field is populated correctly
    - Support users must set created_by = auth.uid() when inserting notes

  2. Security
    - Maintains support role access while ensuring data integrity
    - Ensures created_by is always set to the current user's ID
*/

-- Drop the existing support insert policy
DROP POLICY IF EXISTS "Support can insert notes for any driver" ON driver_notes;

-- Recreate with proper created_by check
CREATE POLICY "Support can insert notes for any driver"
  ON driver_notes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 
      FROM user_profiles 
      WHERE user_profiles.user_id = auth.uid() 
      AND user_profiles.role = 'support'
    )
  );
