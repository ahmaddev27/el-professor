/*
  # Add Week Column to Income Table

  1. Changes
    - Add `week` column to `income` table (integer, 1-5)
    - Week represents which week of the month (1st Monday to last Monday)
    
  2. Notes
    - Week is nullable for backward compatibility with existing data
    - Week 1 = week with first Monday of month
    - Week 4 or 5 = week with last Monday of month
*/

-- Add week column to income table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'income' AND column_name = 'week'
  ) THEN
    ALTER TABLE income ADD COLUMN week integer;
  END IF;
END $$;

-- Add check constraint to ensure week is between 1 and 5
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'income' AND constraint_name = 'income_week_check'
  ) THEN
    ALTER TABLE income ADD CONSTRAINT income_week_check CHECK (week >= 1 AND week <= 5);
  END IF;
END $$;
