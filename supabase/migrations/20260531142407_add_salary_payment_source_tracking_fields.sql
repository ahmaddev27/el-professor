/*
  # Add Source Tracking Fields to Salary Payments

  ## Summary
  Extends the `salary_payments` table to support automatic payment creation from
  weekly Abrechnung (cash difference) and other sources, with full duplicate protection.

  ## New Columns
  - `payment_category` (text): Category label, e.g. 'Bargehalt', 'Bankgehalt', 'Sonstige'
  - `source_type` (text): Origin of payment — 'manual' | 'weekly_cash_difference'
  - `source_reference` (text): Unique reference for dedup — e.g. '{driver_id}_{year}_{month}_{week}'
  - `week_start` (date): Start of the weekly period this payment refers to
  - `week_end` (date): End of the weekly period this payment refers to

  ## Unique Constraint
  Prevents duplicate automatic payments for the same driver+week:
  UNIQUE on (company_id, salary_id, source_type, source_reference)
  — only applied when source_reference IS NOT NULL

  ## Notes
  - All columns nullable so existing salary_payments rows are unaffected
  - source_reference should be set when source_type = 'weekly_cash_difference'
    Format: '{driver_id}_{year}_{month}_{week_number}'
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salary_payments' AND column_name = 'payment_category'
  ) THEN
    ALTER TABLE salary_payments ADD COLUMN payment_category text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salary_payments' AND column_name = 'source_type'
  ) THEN
    ALTER TABLE salary_payments ADD COLUMN source_type text DEFAULT 'manual';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salary_payments' AND column_name = 'source_reference'
  ) THEN
    ALTER TABLE salary_payments ADD COLUMN source_reference text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salary_payments' AND column_name = 'week_start'
  ) THEN
    ALTER TABLE salary_payments ADD COLUMN week_start date;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salary_payments' AND column_name = 'week_end'
  ) THEN
    ALTER TABLE salary_payments ADD COLUMN week_end date;
  END IF;
END $$;

-- Partial unique index to prevent duplicate automatic weekly cash payments
-- Only enforced when source_reference is not null (i.e. automatic payments)
CREATE UNIQUE INDEX IF NOT EXISTS uq_salary_payments_weekly_source
  ON salary_payments (company_id, salary_id, source_type, source_reference)
  WHERE source_reference IS NOT NULL;
