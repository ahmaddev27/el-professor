-- ============================================================
-- Migration: Add netto_salary column to salaries table
-- ============================================================
--
-- Instructions:
-- 1. Go to your Supabase Dashboard: https://hnrvzakckwyomjwfizua.supabase.co
-- 2. Navigate to: SQL Editor (in the left sidebar)
-- 3. Click "New Query"
-- 4. Copy and paste this entire SQL script
-- 5. Click "Run" or press Cmd/Ctrl + Enter
--
-- This will add the netto_salary column to your salaries table.
-- ============================================================

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

-- Verify the column was added
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'salaries'
ORDER BY ordinal_position;
