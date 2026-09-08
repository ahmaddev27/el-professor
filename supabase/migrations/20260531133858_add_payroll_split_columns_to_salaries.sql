/*
  # Add Payroll Split Columns to Salaries

  ## Summary
  Extends the `salaries` table to support a payroll gross / additional net payment split.
  This allows tracking how a driver's total salary is split between:
  - A gross amount processed through payroll (Lohnabrechnung)
  - An additional net/bank payment (Zusätzliche Netto-/Bankzahlung)

  ## New Columns
  - `payroll_gross_amount` (numeric): Amount to be processed as gross salary through payroll
  - `additional_net_payment_amount` (numeric): Additional net/bank payment amount
  - `additional_payment_category` (text): Category of the additional payment (e.g. Sonderzahlung, Netto-Auszahlung)
  - `additional_payment_note` (text): Internal note about the additional payment
  - `show_additional_note_in_pdf` (boolean): Whether to show the internal note in the driver-facing PDF
  - `tax_review_confirmed` (boolean): Whether the tax treatment has been reviewed/confirmed
  - `tax_review_confirmed_at` (timestamptz): When the tax review was confirmed
  - `tax_review_confirmed_by` (uuid): Which user confirmed the tax review

  ## Notes
  - All new columns are nullable so existing salary records are not affected
  - No RLS changes needed — existing policies cover the new columns
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salaries' AND column_name = 'payroll_gross_amount'
  ) THEN
    ALTER TABLE salaries ADD COLUMN payroll_gross_amount numeric(10,2);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salaries' AND column_name = 'additional_net_payment_amount'
  ) THEN
    ALTER TABLE salaries ADD COLUMN additional_net_payment_amount numeric(10,2);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salaries' AND column_name = 'additional_payment_category'
  ) THEN
    ALTER TABLE salaries ADD COLUMN additional_payment_category text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salaries' AND column_name = 'additional_payment_note'
  ) THEN
    ALTER TABLE salaries ADD COLUMN additional_payment_note text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salaries' AND column_name = 'show_additional_note_in_pdf'
  ) THEN
    ALTER TABLE salaries ADD COLUMN show_additional_note_in_pdf boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salaries' AND column_name = 'tax_review_confirmed'
  ) THEN
    ALTER TABLE salaries ADD COLUMN tax_review_confirmed boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salaries' AND column_name = 'tax_review_confirmed_at'
  ) THEN
    ALTER TABLE salaries ADD COLUMN tax_review_confirmed_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'salaries' AND column_name = 'tax_review_confirmed_by'
  ) THEN
    ALTER TABLE salaries ADD COLUMN tax_review_confirmed_by uuid REFERENCES auth.users(id);
  END IF;
END $$;
