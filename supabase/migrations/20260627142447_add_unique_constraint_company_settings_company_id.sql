-- Ensure company_id is unique in company_settings so upsert can use it as conflict target.
-- First remove any duplicate rows (keep the most recently updated one).
DELETE FROM public.company_settings
WHERE id NOT IN (
  SELECT DISTINCT ON (company_id) id
  FROM public.company_settings
  ORDER BY company_id, updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id
);

-- Add unique constraint (idempotent: only if it doesn't exist yet)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'company_settings_company_id_key'
      AND conrelid = 'public.company_settings'::regclass
  ) THEN
    ALTER TABLE public.company_settings
      ADD CONSTRAINT company_settings_company_id_key UNIQUE (company_id);
  END IF;
END $$;
