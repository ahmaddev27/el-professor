/*
  # Create Income Table

  1. New Tables
    - `income`
      - `id` (uuid, primary key)
      - `description` (text)
      - `amount` (numeric)
      - `type` (text, enum: bargeld, umsatz, trinkgeld)
      - `driver_name` (text, foreign key to drivers)
      - `date` (date)
      - `created_by` (uuid, foreign key to auth.users)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

  2. Security
    - Enable RLS on `income` table
    - Add policies for authenticated users to manage income entries
    - Support role-based access (creators can edit their own, admins can edit all)

  3. Notes
    - Income entries are weekly and tracked per driver
    - Types: bargeld (cash), umsatz (revenue), trinkgeld (tips)
*/

-- Create income table
CREATE TABLE IF NOT EXISTS income (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  description text NOT NULL,
  amount numeric NOT NULL CHECK (amount >= 0),
  type text NOT NULL CHECK (type IN ('bargeld', 'umsatz', 'trinkgeld')),
  driver_name text NOT NULL,
  date date NOT NULL DEFAULT CURRENT_DATE,
  created_by uuid REFERENCES auth.users(id),
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
  WITH CHECK (auth.uid() = created_by);

-- Policy: Users can update their own income entries or if they are support/admin
CREATE POLICY "Users can update own income or support can update all"
  ON income
  FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = created_by OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.email = 'support@yamobility.de'
    )
  )
  WITH CHECK (
    auth.uid() = created_by OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.email = 'support@yamobility.de'
    )
  );

-- Policy: Users can delete their own income entries or if they are support/admin
CREATE POLICY "Users can delete own income or support can delete all"
  ON income
  FOR DELETE
  TO authenticated
  USING (
    auth.uid() = created_by OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
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
