-- The language a driver's e-mails are written in.
--
-- The owner asked on 19.10.2026: a company sets a preferred language per driver,
-- and the mails that driver receives arrive in it. Arabic, English or German, and
-- the default is **English** — the owner's decision, and deliberately not the
-- product's own German fallback. Do not "correct" it.
--
-- ## One column, and no policy touched
--
-- `public.drivers` carries 20260917130000's shape, and every one of its four
-- policies keys on `company_id` (and, for writes, the table's page gate) rather
-- than on a column list, so a new column is covered the moment it exists. The
-- table has no column-level GRANT either (`20261002100000` added `email` and
-- `phone` on the same terms). Nothing here grants, revokes or redefines a policy
-- or a function, adds no SECURITY DEFINER function, and so changes nothing the
-- RLS kit's matrix records.
--
-- ## Backward compatible: no SCHEMA_EPOCH bump
--
-- `NOT NULL DEFAULT 'en'` with a constant default is a catalogue change, not a
-- table rewrite, and every existing row takes 'en'. The previous release writes a
-- driver without naming the column, so the default fills it, and never reads it,
-- so a rollback across this migration is safe.
--
-- ## The set of languages
--
-- 'ar' | 'en' | 'de', held by a CHECK. The same list is
-- `MAIL_LANGUAGES` in `supabase/functions/_shared/mail-language.ts` and
-- `DRIVER_LANGUAGES` in `src/lib/driverLanguage.ts`; a test in each reads this
-- file and fails when the three part. The mail code falls back to English for any
-- value it does not know, so adding a language later is: this CHECK, those two
-- lists, a copy table.

ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS preferred_language text NOT NULL DEFAULT 'en';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.drivers'::regclass AND conname = 'drivers_preferred_language_check'
  ) THEN
    ALTER TABLE public.drivers
      ADD CONSTRAINT drivers_preferred_language_check
      CHECK (preferred_language IN ('ar', 'en', 'de'));
  END IF;
END
$$;

COMMENT ON COLUMN public.drivers.preferred_language IS
  'The language this driver''s e-mails (the Abrechnung and its reminder) are written '
  'in: ar, en or de. Default en. Figures and dates stay German in every language.';

-- ── Self-check ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_col record;
BEGIN
  SELECT is_nullable, column_default INTO v_col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'drivers'
     AND column_name = 'preferred_language';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'drivers.preferred_language was not added';
  END IF;
  IF v_col.is_nullable <> 'NO' THEN
    RAISE EXCEPTION 'drivers.preferred_language must be NOT NULL';
  END IF;
  IF v_col.column_default IS DISTINCT FROM '''en''::text' THEN
    RAISE EXCEPTION 'drivers.preferred_language must default to en, found %', v_col.column_default;
  END IF;

  -- No existing driver may be left without a language, and none may hold a value
  -- the CHECK would refuse (a row cannot, but the assertion is cheap).
  IF EXISTS (SELECT 1 FROM public.drivers WHERE preferred_language NOT IN ('ar', 'en', 'de')) THEN
    RAISE EXCEPTION 'a driver holds a language outside ar/en/de';
  END IF;

  -- The CHECK refuses, asserted by trying and not by reading the catalogue.
  -- Cleared first so a run that died between the insert and its delete cannot
  -- turn the next run's valid insert into a unique_violation reported as a
  -- different defect.
  DELETE FROM public.drivers WHERE id = '00000000-0000-4000-8000-00000000dea1';

  BEGIN
    INSERT INTO public.drivers (id, name, preferred_language)
    VALUES ('00000000-0000-4000-8000-00000000dea1', '__selfcheck__', 'fr');
    RAISE EXCEPTION 'drivers_preferred_language_check accepted fr';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.drivers (id, name, preferred_language)
    VALUES ('00000000-0000-4000-8000-00000000dea1', '__selfcheck__', NULL);
    RAISE EXCEPTION 'drivers.preferred_language accepted NULL';
  EXCEPTION
    WHEN not_null_violation THEN NULL;
  END;

  -- A driver written without naming the column takes English: this is the
  -- previous release's insert, and it is the owner's default.
  INSERT INTO public.drivers (id, name) VALUES ('00000000-0000-4000-8000-00000000dea1', '__selfcheck__');
  IF (SELECT preferred_language FROM public.drivers WHERE id = '00000000-0000-4000-8000-00000000dea1') <> 'en' THEN
    RAISE EXCEPTION 'a driver written without a language did not take en';
  END IF;
  DELETE FROM public.drivers WHERE id = '00000000-0000-4000-8000-00000000dea1';
END
$$;
