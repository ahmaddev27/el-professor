/*
  # Simplify Fixed Costs RLS Policies - Give Full Access to Authenticated Users

  1. Changes
    - Drop all existing restrictive policies
    - Create simple policies that allow all authenticated users to manage fixed costs
    - This ensures support@yamobility.de and all other authenticated users have full access

  2. Security
    - All authenticated users can INSERT, UPDATE, DELETE fixed costs
    - Only authenticated users can access the data (not public)
*/

-- Drop all existing policies
DROP POLICY IF EXISTS "Authenticated users can view fixed costs" ON fixed_costs;
DROP POLICY IF EXISTS "Editors and above can insert fixed costs" ON fixed_costs;
DROP POLICY IF EXISTS "Editors and above can update fixed costs" ON fixed_costs;
DROP POLICY IF EXISTS "Supervisors and admins can delete fixed costs" ON fixed_costs;

-- Create simple policies for all authenticated users
CREATE POLICY "Authenticated users can view all fixed costs"
  ON fixed_costs
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert fixed costs"
  ON fixed_costs
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update fixed costs"
  ON fixed_costs
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete fixed costs"
  ON fixed_costs
  FOR DELETE
  TO authenticated
  USING (true);
