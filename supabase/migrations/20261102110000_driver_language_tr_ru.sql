-- Turkish and Russian as a driver's e-mail language.
--
-- The owner asked on 02.11.2026. `20261019100000` wrote down what adding a
-- language is: this CHECK, `MAIL_LANGUAGES`, `DRIVER_LANGUAGES` and a copy table.
-- A test in `src/lib/driverLanguage.test.ts` reads the newest migration that
-- defines the CHECK, so this file is now what it compares the two lists with.
--
-- ## Backward compatible: no SCHEMA_EPOCH bump
--
-- The CHECK only widens, so every stored value stays valid and no row changes.
-- A rollback across this migration is safe: the previous release's mail code and
-- its form both read a language they do not know as English
-- (`resolveMailLanguage`, `toDriverLanguage`), so a driver set to Turkish gets
-- English mail under that release and nothing fails.
--
-- ## No policy touched
--
-- Nothing here grants, revokes or redefines a policy or a function, so nothing
-- the RLS kit's matrix records moves. The default stays English.

ALTER TABLE public.drivers DROP CONSTRAINT IF EXISTS drivers_preferred_language_check;

ALTER TABLE public.drivers
  ADD CONSTRAINT drivers_preferred_language_check
  CHECK (preferred_language IN ('ar', 'en', 'de', 'tr', 'ru'));

COMMENT ON COLUMN public.drivers.preferred_language IS
  'The language this driver''s e-mails (the Abrechnung and its reminder) are written '
  'in: ar, en, de, tr or ru. Default en. Figures and dates stay German in every language.';

-- ── Self-check ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_probe constant uuid := '00000000-0000-4000-8000-00000000dea2';
  v_language text;
BEGIN
  -- Cleared first, so a run that died between an insert and its delete cannot
  -- turn the next run's valid insert into a different defect.
  DELETE FROM public.drivers WHERE id = v_probe;

  -- Every language is accepted, asserted by trying and not by reading the catalogue.
  FOREACH v_language IN ARRAY ARRAY['ar', 'en', 'de', 'tr', 'ru'] LOOP
    INSERT INTO public.drivers (id, name, preferred_language) VALUES (v_probe, '__selfcheck__', v_language);
    DELETE FROM public.drivers WHERE id = v_probe;
  END LOOP;

  BEGIN
    INSERT INTO public.drivers (id, name, preferred_language) VALUES (v_probe, '__selfcheck__', 'fr');
    RAISE EXCEPTION 'drivers_preferred_language_check accepted fr';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  -- The default did not move: a driver written without naming the column takes English.
  INSERT INTO public.drivers (id, name) VALUES (v_probe, '__selfcheck__');
  IF (SELECT preferred_language FROM public.drivers WHERE id = v_probe) <> 'en' THEN
    RAISE EXCEPTION 'a driver written without a language did not take en';
  END IF;
  DELETE FROM public.drivers WHERE id = v_probe;
END
$$;
