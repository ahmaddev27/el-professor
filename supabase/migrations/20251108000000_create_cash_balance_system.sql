/*
  # Cash Balance System (Bargeldbestand)

  1. New Tables
    - `cash_transactions`
      - Track all cash deposits and payments
      - `id` (uuid, primary key)
      - `transaction_type` (text: 'deposit' or 'payment')
      - `amount` (numeric)
      - `description` (text)
      - `reference_id` (uuid, optional) - links to receipt or other record
      - `reference_type` (text, optional) - 'receipt', 'salary', etc.
      - `date` (date)
      - `created_by` (text)
      - `created_at` (timestamptz)

  2. Changes to Existing Tables
    - Add `payment_method` column to `receipts` table
      - Values: 'bar' (cash) or 'uberweisung' (bank transfer)
      - Default: 'bar' for backwards compatibility

  3. Security
    - Enable RLS on `cash_transactions` table
    - Add policies for authenticated users with role-based access
    - Support role has full access

  4. Functions
    - `get_current_cash_balance()` - calculates current cash balance
*/

-- Add payment_method to receipts table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'receipts'
    AND column_name = 'payment_method'
  ) THEN
    ALTER TABLE public.receipts ADD COLUMN payment_method text DEFAULT 'bar' CHECK (payment_method IN ('bar', 'uberweisung'));
  END IF;
END $$;

-- Create cash_transactions table
CREATE TABLE IF NOT EXISTS cash_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_type text NOT NULL CHECK (transaction_type IN ('deposit', 'payment')),
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  description text NOT NULL,
  reference_id uuid,
  reference_type text,
  date date NOT NULL DEFAULT CURRENT_DATE,
  created_by text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS on cash_transactions
ALTER TABLE cash_transactions ENABLE ROW LEVEL SECURITY;

-- Cash transactions policies
CREATE POLICY "Cash transactions: select authenticated users"
  ON cash_transactions
  FOR SELECT
  TO authenticated
  USING (
    created_by = (SELECT email FROM user_profiles WHERE user_id = auth.uid())
    OR (SELECT role FROM user_profiles WHERE user_id = auth.uid()) IN ('admin', 'supervisor', 'editor')
    OR (SELECT email FROM user_profiles WHERE user_id = auth.uid()) = 'support@yamobility.de'
  );

CREATE POLICY "Cash transactions: insert authenticated users"
  ON cash_transactions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = (SELECT email FROM user_profiles WHERE user_id = auth.uid())
    OR (SELECT role FROM user_profiles WHERE user_id = auth.uid()) IN ('admin', 'supervisor', 'editor')
    OR (SELECT email FROM user_profiles WHERE user_id = auth.uid()) = 'support@yamobility.de'
  );

CREATE POLICY "Cash transactions: update elevated roles"
  ON cash_transactions
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT role FROM user_profiles WHERE user_id = auth.uid()) IN ('admin', 'supervisor')
    OR (SELECT email FROM user_profiles WHERE user_id = auth.uid()) = 'support@yamobility.de'
  )
  WITH CHECK (
    (SELECT role FROM user_profiles WHERE user_id = auth.uid()) IN ('admin', 'supervisor')
    OR (SELECT email FROM user_profiles WHERE user_id = auth.uid()) = 'support@yamobility.de'
  );

CREATE POLICY "Cash transactions: delete admin only"
  ON cash_transactions
  FOR DELETE
  TO authenticated
  USING (
    (SELECT role FROM user_profiles WHERE user_id = auth.uid()) = 'admin'
    OR (SELECT email FROM user_profiles WHERE user_id = auth.uid()) = 'support@yamobility.de'
  );

-- Function to calculate current cash balance
CREATE OR REPLACE FUNCTION get_current_cash_balance(user_email text DEFAULT NULL)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  total_deposits numeric;
  total_payments numeric;
  balance numeric;
BEGIN
  -- Calculate total deposits
  SELECT COALESCE(SUM(amount), 0)
  INTO total_deposits
  FROM cash_transactions
  WHERE transaction_type = 'deposit'
    AND (user_email IS NULL OR created_by = user_email);

  -- Calculate total payments (cash receipts)
  SELECT COALESCE(SUM(expense), 0)
  INTO total_payments
  FROM receipts
  WHERE payment_method = 'bar'
    AND (user_email IS NULL OR "user" = user_email);

  -- Also subtract cash payments from cash_transactions
  SELECT COALESCE(SUM(amount), 0) + total_payments
  INTO total_payments
  FROM cash_transactions
  WHERE transaction_type = 'payment'
    AND (user_email IS NULL OR created_by = user_email);

  balance := total_deposits - total_payments;

  RETURN balance;
END;
$$;

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_cash_transactions_date ON cash_transactions(date DESC);
CREATE INDEX IF NOT EXISTS idx_cash_transactions_created_by ON cash_transactions(created_by);
CREATE INDEX IF NOT EXISTS idx_receipts_payment_method ON receipts(payment_method);
