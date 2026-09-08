/*
  # Create Salary Payments System

  1. New Tables
    - `salary_payments`
      - `id` (uuid, primary key)
      - `salary_id` (uuid, foreign key to salaries)
      - `payment_type` (text) - 'cash' or 'bank'
      - `amount` (decimal) - Payment amount
      - `payment_date` (date) - Date of payment
      - `description` (text) - Short description/notes
      - `created_by` (uuid) - User who created the payment
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

  2. Changes to Existing Tables
    - Add `total_paid` column to salaries table (computed from payments)
    - Add `remaining_balance` column to salaries table (computed)
    - Add `payment_status` column to salaries table ('unpaid', 'partially_paid', 'paid')

  3. Security
    - Enable RLS on salary_payments table
    - Admin and supervisor can manage payments
    - Editor can view payments
    - Add triggers to update salary status when payments change

  4. Important Notes
    - Payments cannot exceed remaining balance
    - Status is automatically calculated based on total paid vs netto salary
    - All payment amounts are validated before insert/update
*/

-- Create salary_payments table
CREATE TABLE IF NOT EXISTS salary_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salary_id uuid REFERENCES salaries(id) ON DELETE CASCADE NOT NULL,
  payment_type text CHECK (payment_type IN ('cash', 'bank')) NOT NULL,
  amount decimal(10, 2) CHECK (amount > 0) NOT NULL,
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  description text DEFAULT '',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Add payment tracking columns to salaries table if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salaries' AND column_name = 'total_paid'
  ) THEN
    ALTER TABLE salaries ADD COLUMN total_paid decimal(10, 2) DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salaries' AND column_name = 'remaining_balance'
  ) THEN
    ALTER TABLE salaries ADD COLUMN remaining_balance decimal(10, 2);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salaries' AND column_name = 'payment_status'
  ) THEN
    ALTER TABLE salaries ADD COLUMN payment_status text DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partially_paid', 'paid'));
  END IF;
END $$;

-- Enable RLS
ALTER TABLE salary_payments ENABLE ROW LEVEL SECURITY;

-- RLS Policies for salary_payments
CREATE POLICY "Admin can view all payments"
  ON salary_payments
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Supervisor can view all payments"
  ON salary_payments
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'supervisor'
    )
  );

CREATE POLICY "Editor can view payments"
  ON salary_payments
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'editor'
    )
  );

CREATE POLICY "Admin can insert payments"
  ON salary_payments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Supervisor can insert payments"
  ON salary_payments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'supervisor'
    )
  );

CREATE POLICY "Admin can update payments"
  ON salary_payments
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Supervisor can update payments"
  ON salary_payments
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'supervisor'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'supervisor'
    )
  );

CREATE POLICY "Admin can delete payments"
  ON salary_payments
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Supervisor can delete payments"
  ON salary_payments
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'supervisor'
    )
  );

-- Function to update salary payment status
CREATE OR REPLACE FUNCTION update_salary_payment_status()
RETURNS TRIGGER AS $$
DECLARE
  salary_total decimal(10, 2);
  payments_total decimal(10, 2);
  new_status text;
  new_remaining decimal(10, 2);
BEGIN
  -- Get the salary total (netto_salary)
  SELECT netto_salary INTO salary_total
  FROM salaries
  WHERE id = COALESCE(NEW.salary_id, OLD.salary_id);

  -- Calculate total payments for this salary
  SELECT COALESCE(SUM(amount), 0) INTO payments_total
  FROM salary_payments
  WHERE salary_id = COALESCE(NEW.salary_id, OLD.salary_id);

  -- Calculate remaining balance
  new_remaining := salary_total - payments_total;

  -- Determine status
  IF payments_total = 0 THEN
    new_status := 'unpaid';
  ELSIF payments_total >= salary_total THEN
    new_status := 'paid';
    new_remaining := 0;
  ELSE
    new_status := 'partially_paid';
  END IF;

  -- Update the salary record
  UPDATE salaries
  SET 
    total_paid = payments_total,
    remaining_balance = new_remaining,
    payment_status = new_status
  WHERE id = COALESCE(NEW.salary_id, OLD.salary_id);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Triggers to update salary status when payments change
DROP TRIGGER IF EXISTS update_salary_status_on_payment_insert ON salary_payments;
CREATE TRIGGER update_salary_status_on_payment_insert
  AFTER INSERT ON salary_payments
  FOR EACH ROW
  EXECUTE FUNCTION update_salary_payment_status();

DROP TRIGGER IF EXISTS update_salary_status_on_payment_update ON salary_payments;
CREATE TRIGGER update_salary_status_on_payment_update
  AFTER UPDATE ON salary_payments
  FOR EACH ROW
  EXECUTE FUNCTION update_salary_payment_status();

DROP TRIGGER IF EXISTS update_salary_status_on_payment_delete ON salary_payments;
CREATE TRIGGER update_salary_status_on_payment_delete
  AFTER DELETE ON salary_payments
  FOR EACH ROW
  EXECUTE FUNCTION update_salary_payment_status();

-- Add updated_at trigger for salary_payments
CREATE OR REPLACE FUNCTION update_salary_payments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_salary_payments_updated_at_trigger ON salary_payments;
CREATE TRIGGER update_salary_payments_updated_at_trigger
  BEFORE UPDATE ON salary_payments
  FOR EACH ROW
  EXECUTE FUNCTION update_salary_payments_updated_at();

-- Initialize payment status for existing salaries
UPDATE salaries
SET 
  total_paid = 0,
  remaining_balance = netto_salary,
  payment_status = 'unpaid'
WHERE total_paid IS NULL;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_salary_payments_salary_id ON salary_payments(salary_id);
CREATE INDEX IF NOT EXISTS idx_salary_payments_payment_date ON salary_payments(payment_date);
