-- ============================================================
-- BARGELDBESTAND (Cash Balance) SYSTEM - MIGRATION
-- ============================================================
--
-- INSTRUCTIONS:
-- 1. Go to: https://hnrvzakckwyomjwfizua.supabase.co
-- 2. Click: SQL Editor (left sidebar)
-- 3. Click: New Query
-- 4. Copy and paste this ENTIRE script
-- 5. Click: Run (or Cmd/Ctrl + Enter)
--
-- This migration adds:
-- - payment_method column to receipts table
-- - cash_transactions table for deposits/payments
-- - Function to calculate cash balance
-- ============================================================

-- Step 1: Add payment_method to receipts table
ALTER TABLE public.receipts
ADD COLUMN IF NOT EXISTS payment_method text DEFAULT 'bar'
CHECK (payment_method IN ('bar', 'uberweisung'));

-- Step 2: Create cash_transactions table
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

-- Step 3: Enable RLS on cash_transactions
ALTER TABLE cash_transactions ENABLE ROW LEVEL SECURITY;

-- Step 4: Create RLS policies for cash_transactions
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

-- Step 5: Create function to calculate cash balance
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

-- Step 6: Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_cash_transactions_date ON cash_transactions(date DESC);
CREATE INDEX IF NOT EXISTS idx_cash_transactions_created_by ON cash_transactions(created_by);
CREATE INDEX IF NOT EXISTS idx_receipts_payment_method ON receipts(payment_method);

-- ============================================================
-- VERIFICATION: Run this to check if everything was created
-- ============================================================
SELECT
  'payment_method column exists' as check_name,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'receipts' AND column_name = 'payment_method'
  ) as success
UNION ALL
SELECT
  'cash_transactions table exists',
  EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'cash_transactions'
  )
UNION ALL
SELECT
  'get_current_cash_balance function exists',
  EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'get_current_cash_balance'
  );
