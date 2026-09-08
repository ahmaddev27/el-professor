/*
  # Fix RLS Policies for Creator and Support Access

  1. Changes
    - Drop existing RLS policies on drivers and receipts tables
    - Create new policies that allow:
      - All authenticated users can SELECT (view)
      - Only creator (user_id matches) OR support email can UPDATE
      - Only creator (user_id matches) OR support email can DELETE
      - All authenticated users can INSERT
    
  2. Security
    - Uses auth.uid() for creator check
    - Uses auth.jwt() to check email for support admin
    - Restrictive policies that prevent unauthorized modifications
*/

-- Drop existing policies for drivers
DROP POLICY IF EXISTS "Drivers: select authenticated users" ON drivers;
DROP POLICY IF EXISTS "Drivers: insert authenticated users" ON drivers;
DROP POLICY IF EXISTS "Drivers: update authenticated users" ON drivers;
DROP POLICY IF EXISTS "Drivers: delete authenticated users" ON drivers;

-- Create new policies for drivers
CREATE POLICY "Drivers can view all"
  ON drivers
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Drivers can insert own"
  ON drivers
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Drivers can update own or support"
  ON drivers
  FOR UPDATE
  TO authenticated
  USING (
    user_id = auth.uid() 
    OR 
    (SELECT email FROM auth.users WHERE id = auth.uid()) = 'support@yamobility.de'
  )
  WITH CHECK (
    user_id = auth.uid() 
    OR 
    (SELECT email FROM auth.users WHERE id = auth.uid()) = 'support@yamobility.de'
  );

CREATE POLICY "Drivers can delete own or support"
  ON drivers
  FOR DELETE
  TO authenticated
  USING (
    user_id = auth.uid() 
    OR 
    (SELECT email FROM auth.users WHERE id = auth.uid()) = 'support@yamobility.de'
  );

-- Drop existing policies for receipts
DROP POLICY IF EXISTS "Receipts: select authenticated users" ON receipts;
DROP POLICY IF EXISTS "Receipts: insert authenticated users" ON receipts;
DROP POLICY IF EXISTS "Receipts: update authenticated users" ON receipts;
DROP POLICY IF EXISTS "Receipts: delete authenticated users" ON receipts;

-- Create new policies for receipts
CREATE POLICY "Receipts can view all"
  ON receipts
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Receipts can insert own"
  ON receipts
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Receipts can update own or support"
  ON receipts
  FOR UPDATE
  TO authenticated
  USING (
    user_id = auth.uid() 
    OR 
    (SELECT email FROM auth.users WHERE id = auth.uid()) = 'support@yamobility.de'
  )
  WITH CHECK (
    user_id = auth.uid() 
    OR 
    (SELECT email FROM auth.users WHERE id = auth.uid()) = 'support@yamobility.de'
  );

CREATE POLICY "Receipts can delete own or support"
  ON receipts
  FOR DELETE
  TO authenticated
  USING (
    user_id = auth.uid() 
    OR 
    (SELECT email FROM auth.users WHERE id = auth.uid()) = 'support@yamobility.de'
  );
