/*
  # Add created_by column to drivers table

  1. Changes
    - Add `created_by` column to `drivers` table to track who created each driver
    - This matches the existing pattern in the `receipts` table

  2. Notes
    - Column is nullable to support existing records
    - No default value to avoid masking problems
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'created_by'
  ) THEN
    ALTER TABLE drivers ADD COLUMN created_by text;
  END IF;
END $$;
