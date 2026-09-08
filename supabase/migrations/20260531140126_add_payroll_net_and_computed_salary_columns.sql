/*
  # Add Payroll Net and Computed Salary Columns

  ## Summary
  Replaces the old "additional net payment" pattern with the correct payroll split model:
  - payroll_gross_amount: Brutto in Lohnabrechnung (already exists)
  - payroll_net_amount: Netto laut Lohnabrechnung / Bankgehalt (new)
  - cash_salary_amount: Berechnetes Gehalt - Brutto (computed, stored for reference)
  - bank_salary_amount: Same as payroll_net_amount (stored for reference)
  - total_net_payout: cash_salary_amount + bank_salary_amount (stored for reference)

  ## New Columns
  - `payroll_net_amount` (numeric): Netto laut Lohnabrechnung (Bankgehalt)
  - `cash_salary_amount` (numeric): Bargehalt = calculated_total - payroll_gross
  - `bank_salary_amount` (numeric): Bankgehalt = payroll_net_amount
  - `total_net_payout` (numeric): Gesamt Netto Auszahlung = cash + bank

  ## Notes
  - payroll_gross_amount already exists from previous migration
  - All new columns nullable — existing records unaffected
  - salary_payments.payment_type already supports 'cash' and 'bank'
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salaries' AND column_name = 'payroll_net_amount'
  ) THEN
    ALTER TABLE salaries ADD COLUMN payroll_net_amount numeric(10,2);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salaries' AND column_name = 'cash_salary_amount'
  ) THEN
    ALTER TABLE salaries ADD COLUMN cash_salary_amount numeric(10,2);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salaries' AND column_name = 'bank_salary_amount'
  ) THEN
    ALTER TABLE salaries ADD COLUMN bank_salary_amount numeric(10,2);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salaries' AND column_name = 'total_net_payout'
  ) THEN
    ALTER TABLE salaries ADD COLUMN total_net_payout numeric(10,2);
  END IF;
END $$;
