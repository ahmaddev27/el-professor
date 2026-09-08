/*
  # Make KM Stand Required in Werkstatt Checks

  1. Changes
    - Alter `km_stand` column in `werkstatt_checks` table to be NOT NULL
    - Keep the check constraint that value must be positive
    - Set a default value of 0 for existing rows (will be updated manually)

  2. Notes
    - This makes KM stand mandatory for all werkstatt checks
    - Existing NULL values will be set to 0 as a placeholder
*/

-- First update any existing NULL values to 0
UPDATE werkstatt_checks SET km_stand = 0 WHERE km_stand IS NULL;

-- Now alter the column to be NOT NULL
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'werkstatt_checks' AND column_name = 'km_stand'
  ) THEN
    ALTER TABLE werkstatt_checks
    ALTER COLUMN km_stand SET NOT NULL,
    ALTER COLUMN km_stand SET DEFAULT 0;
  END IF;
END $$;
