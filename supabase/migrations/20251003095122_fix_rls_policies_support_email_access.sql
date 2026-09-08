/*
  # Fix RLS Policies for Support Email Access

  1. Changes
    - Create a SECURITY DEFINER function to safely check user email
    - Update RLS policies to use this function instead of direct auth.users access
    - Policies allow creator OR support@yamobility.de to edit/delete
    
  2. Security
    - Function has SECURITY DEFINER to access auth.users safely
    - All authenticated users can view
    - Only creator or support can edit/delete
*/

-- Create function to check if current user is support
CREATE OR REPLACE FUNCTION is_support_user()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN (
    SELECT email = 'support@yamobility.de'
    FROM auth.users
    WHERE id = auth.uid()
  );
END;
$$;

-- Drop and recreate policies for drivers
DROP POLICY IF EXISTS "Drivers can update own or support" ON drivers;
DROP POLICY IF EXISTS "Drivers can delete own or support" ON drivers;

CREATE POLICY "Drivers can update own or support"
  ON drivers
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid() OR is_support_user())
  WITH CHECK (user_id = auth.uid() OR is_support_user());

CREATE POLICY "Drivers can delete own or support"
  ON drivers
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid() OR is_support_user());

-- Drop and recreate policies for receipts
DROP POLICY IF EXISTS "Receipts can update own or support" ON receipts;
DROP POLICY IF EXISTS "Receipts can delete own or support" ON receipts;

CREATE POLICY "Receipts can update own or support"
  ON receipts
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid() OR is_support_user())
  WITH CHECK (user_id = auth.uid() OR is_support_user());

CREATE POLICY "Receipts can delete own or support"
  ON receipts
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid() OR is_support_user());
