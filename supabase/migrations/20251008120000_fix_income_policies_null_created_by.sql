/*
  # Fix Income Policies for Null created_by

  1. Changes
    - Create a SECURITY DEFINER function to safely get current user's email
    - Update UPDATE and DELETE policies to allow operations on records where created_by is NULL
    - This allows editing/deleting old income records that were created before the created_by field was populated
    - Support users can still edit/delete all records

  2. Security
    - Function has SECURITY DEFINER to access auth.users safely
    - Maintains RLS protection
    - Users can only edit/delete their own records or records with NULL created_by
    - Support users retain full access
*/

-- Create function to get current user's email
CREATE OR REPLACE FUNCTION get_current_user_email()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN (
    SELECT email
    FROM auth.users
    WHERE id = auth.uid()
  );
END;
$$;

-- Drop existing policies
DROP POLICY IF EXISTS "Users can update own income or support can update all" ON income;
DROP POLICY IF EXISTS "Users can delete own income or support can delete all" ON income;

-- Policy: Users can update their own income entries, entries with NULL created_by, or if they are support/admin
CREATE POLICY "Users can update own income or support can update all"
  ON income
  FOR UPDATE
  TO authenticated
  USING (
    created_by IS NULL OR
    created_by = get_current_user_email() OR
    is_support_user()
  )
  WITH CHECK (
    created_by IS NULL OR
    created_by = get_current_user_email() OR
    is_support_user()
  );

-- Policy: Users can delete their own income entries, entries with NULL created_by, or if they are support/admin
CREATE POLICY "Users can delete own income or support can delete all"
  ON income
  FOR DELETE
  TO authenticated
  USING (
    created_by IS NULL OR
    created_by = get_current_user_email() OR
    is_support_user()
  );
