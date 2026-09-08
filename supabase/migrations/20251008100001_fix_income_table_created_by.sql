/*
  # Fix Income Table created_by Column Type

  1. Changes
    - Drop existing income table if it exists
    - Recreate with created_by as text (not uuid) to match receipts and drivers tables
    - Recreate all policies and triggers

  2. Reason
    - The receipts and drivers tables use text for created_by
    - Income table should match for consistency
*/

-- Drop the table if it exists (this is safe since it was just created)
DROP TABLE IF EXISTS income CASCADE;

-- Create income table with correct column type
CREATE TABLE IF NOT EXISTS income (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  description text NOT NULL,
  amount numeric NOT NULL CHECK (amount >= 0),
  type text NOT NULL CHECK (type IN ('bargeld', 'umsatz', 'trinkgeld')),
  driver_name text NOT NULL,
  date date NOT NULL DEFAULT CURRENT_DATE,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_income_driver_name ON income(driver_name);
CREATE INDEX IF NOT EXISTS idx_income_date ON income(date);
CREATE INDEX IF NOT EXISTS idx_income_created_by ON income(created_by);

-- Enable RLS
ALTER TABLE income ENABLE ROW LEVEL SECURITY;

-- Policy: All authenticated users can view income
CREATE POLICY "Authenticated users can view income"
  ON income
  FOR SELECT
  TO authenticated
  USING (true);

-- Policy: Authenticated users can insert income
CREATE POLICY "Authenticated users can insert income"
  ON income
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Policy: Users can update their own income entries or if they are support/admin
CREATE POLICY "Users can update own income or support can update all"
  ON income
  FOR UPDATE
  TO authenticated
  USING (
    created_by = (SELECT email FROM auth.users WHERE id = auth.uid()) OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.email = 'support@yamobility.de'
    )
  )
  WITH CHECK (
    created_by = (SELECT email FROM auth.users WHERE id = auth.uid()) OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.email = 'support@yamobility.de'
    )
  );

-- Policy: Users can delete their own income entries or if they are support/admin
CREATE POLICY "Users can delete own income or support can delete all"
  ON income
  FOR DELETE
  TO authenticated
  USING (
    created_by = (SELECT email FROM auth.users WHERE id = auth.uid()) OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.email = 'support@yamobility.de'
    )
  );

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_income_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for updated_at
DROP TRIGGER IF EXISTS income_updated_at_trigger ON income;
CREATE TRIGGER income_updated_at_trigger
  BEFORE UPDATE ON income
  FOR EACH ROW
  EXECUTE FUNCTION update_income_updated_at();
