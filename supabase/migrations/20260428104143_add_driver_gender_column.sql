-- Add gender field to drivers
--
-- Purpose:
--   Store each driver's gender so documents (e.g. Trinkgeld Quittung) can pick
--   the correct German salutation (Herr / Frau).
--
-- Changes:
--   - Add `gender` column to `public.drivers` (text, nullable).
--   - Constrain values to 'male' | 'female' (NULL allowed for legacy rows).
--
-- Security:
--   - No RLS changes. Existing policies on `drivers` continue to apply.
--   - Column is nullable so existing rows keep working without a backfill.

DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'drivers'
      AND column_name = 'gender'
  ) THEN
    ALTER TABLE public.drivers ADD COLUMN gender text;
  END IF;
END
$mig$;

DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'drivers_gender_check'
      AND conrelid = 'public.drivers'::regclass
  ) THEN
    ALTER TABLE public.drivers
      ADD CONSTRAINT drivers_gender_check
      CHECK (gender IS NULL OR gender IN ('male', 'female'));
  END IF;
END
$mig$;
