/*
  # Add Netto Salary Column to Salaries Table

  1. Changes
    - Add `netto_salary` column to `salaries` table
      - Type: numeric(10,2)
      - Nullable: Yes (to support backward compatibility)
      - Description: Manually entered net salary amount for the driver

  2. Purpose
    - Allow manual input of netto (net) salary amounts
    - Store actual paid salary instead of only calculated amounts
    - Display netto salary in the salaries list
*/

-- Add netto_salary column to salaries table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'salaries'
    AND column_name = 'netto_salary'
  ) THEN
    ALTER TABLE public.salaries ADD COLUMN netto_salary numeric(10,2);
    RAISE NOTICE '✓ Added netto_salary column to salaries table';
  ELSE
    RAISE NOTICE '✓ netto_salary column already exists';
  END IF;
END $$;
