/*
  # Create Fixed Costs Table

  1. New Tables
    - `fixed_costs`
      - `id` (uuid, primary key) - Unique identifier
      - `description` (text) - Description of the fixed cost
      - `amount` (numeric) - Monthly cost amount
      - `created_by` (uuid) - User who created this cost (references auth.users)
      - `created_at` (timestamptz) - Creation timestamp
      - `updated_at` (timestamptz) - Last update timestamp

  2. Security
    - Enable RLS on `fixed_costs` table
    - Policies for authenticated users:
      - SELECT: All authenticated users can view fixed costs
      - INSERT: Editors, supervisors, and admins can create fixed costs
      - UPDATE: Editors, supervisors, and admins can update fixed costs
      - DELETE: Supervisors and admins can delete fixed costs

  3. Important Notes
    - Fixed costs are applied monthly across all statistics
    - Deletion requires supervisor or admin role
    - All monetary amounts stored with precision of 2 decimal places
*/

CREATE TABLE IF NOT EXISTS fixed_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  description text NOT NULL,
  amount numeric(10, 2) NOT NULL DEFAULT 0,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE fixed_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view fixed costs" ON fixed_costs;
CREATE POLICY "Authenticated users can view fixed costs"
  ON fixed_costs
  FOR SELECT
  TO authenticated
  USING (true);

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

CREATE OR REPLACE FUNCTION update_fixed_costs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_fixed_costs_timestamp ON fixed_costs;
CREATE TRIGGER update_fixed_costs_timestamp
  BEFORE UPDATE ON fixed_costs
  FOR EACH ROW
  EXECUTE FUNCTION update_fixed_costs_updated_at();
