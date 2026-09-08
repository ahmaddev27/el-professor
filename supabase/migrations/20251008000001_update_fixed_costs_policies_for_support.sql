/*
  # Update Fixed Costs RLS Policies for Support Access

  1. Changes
    - Update INSERT policy to include support@yamobility.de email check
    - Update UPDATE policy to include support@yamobility.de email check
    - Update DELETE policy to include support@yamobility.de email check

  2. Security
    - Support user (support@yamobility.de) has full access to all fixed costs operations
    - Maintains existing role-based permissions for other users
*/

DROP POLICY IF EXISTS "Editors and above can insert fixed costs" ON fixed_costs;
CREATE POLICY "Editors and above can insert fixed costs"
  ON fixed_costs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.jwt()->>'email' = 'support@yamobility.de'
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role IN ('editor', 'supervisor', 'admin')
    )
  );

DROP POLICY IF EXISTS "Editors and above can update fixed costs" ON fixed_costs;
CREATE POLICY "Editors and above can update fixed costs"
  ON fixed_costs
  FOR UPDATE
  TO authenticated
  USING (
    auth.jwt()->>'email' = 'support@yamobility.de'
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role IN ('editor', 'supervisor', 'admin')
    )
  )
  WITH CHECK (
    auth.jwt()->>'email' = 'support@yamobility.de'
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role IN ('editor', 'supervisor', 'admin')
    )
  );

DROP POLICY IF EXISTS "Supervisors and admins can delete fixed costs" ON fixed_costs;
CREATE POLICY "Supervisors and admins can delete fixed costs"
  ON fixed_costs
  FOR DELETE
  TO authenticated
  USING (
    auth.jwt()->>'email' = 'support@yamobility.de'
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role IN ('supervisor', 'admin')
    )
  );
