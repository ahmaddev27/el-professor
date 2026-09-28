/*
  # A driver note records which car the incident happened on

  A Blitzer photo or a Bußgeldbescheid arrives addressed to a **car**, weeks
  later, and the office has to work out who was driving it. The incident note
  types already exist — `blitzer`, `accident`, `kontrolle`, `breakdown`, `wait`,
  all `must_include_in_plan` — and every one of them names a driver and a date
  but no vehicle. So the one fact the letter arrives with is the one fact the
  note does not hold, and the tie back to the Fahrtenbuch is done from memory.

  This migration adds that one fact: `driver_notes.car_id`, optional, a key into
  `public.cars`.

  ## What it is, and what it deliberately is not

  - **Optional.** NULL is the normal case; a sickness note names no car. The
    column is nullable with no default and the screen leaves it empty.
  - **A key, not text.** The owner chose a picker over free text so that
    `B-XX 1234` and `B-XX-1234` cannot become two vehicles. The join for a later
    Fahrtenanalyse is then `driver_notes.car_id = cars.id`, not a string match.
  - **Plate only.** `public.cars` carries `kennzeichen, tuev_gueltig_bis,
    letzte_hu, status, company_id` and no model or type column (measured on
    staging, 28.09.2026). The owner was told and chose "plate only for now", so
    nothing here invents a vehicle description.
  - **It records; it does not look up.** No view, no RPC and no read model reads
    this column. Nothing in the planning engine learns about it — see the safety
    property below.

  ## ON DELETE SET NULL, following fahrtenbuch_trips

  `fahrtenbuch_trips.car_id` is `uuid REFERENCES cars(id) ON DELETE SET NULL`
  (20260605082340) and this follows it, for the same reason: an incident still
  happened after the car is sold. CASCADE would delete the note — the record of
  an accident — because a vehicle left the fleet, which is the wrong trade in
  both directions.

  One consequence worth stating rather than discovering: deleting a car sets
  `car_id` to NULL on its notes, which is an UPDATE on `driver_notes`, so
  `trigger_update_driver_notes_updated_at` bumps their `updated_at` and — inside
  a support session — `record_support_write` records each one. Both are correct:
  the row did change, and who changed it is worth knowing.

  ## No policy changes, and none are needed

  `driver_notes` already carries the unified tenant policies of 20260917130000
  (`company_id = get_active_company_id() OR platform_reads_company_data()` for
  SELECT, the same predicate as USING **and** WITH CHECK for every write), the
  statement trigger `refuse_read_only_context_write` of 20260917140000 and the
  row trigger `record_support_write` of 20260920110000 (all three measured on
  staging, 28.09.2026). A new column inherits every one of them. This migration
  adds no policy, widens none, and drops no guard.

  ## The one guard it does add: a car of another company

  A foreign key is checked without regard to RLS, so nothing in the four
  policies stops a note of company A naming a car of company B by its uuid.
  Nothing leaks that way — reading the note back joins `cars` through its own
  SELECT policy and answers nothing — but the link the column exists for would
  be silently wrong, and CLAUDE.md's rule is that the browser is never the
  boundary. So a BEFORE INSERT OR UPDATE row trigger refuses it.

  Its decision is a separate pure function, `driver_note_car_company_ok`, for
  one reason: the self-check below can then test the rule as a truth table with
  no companies, no cars and no notes in the database — which is exactly what the
  RLS kit's fixture (a --schema=public dump) has. The negative control is the
  (A, B) row: before this migration every database allowed it.

  The rule refuses only what it can judge — both companies known and different.
  A row where either side is NULL is allowed, because "unknown" is not
  "mismatched" and refusing it would break a legacy row for no gain. Measured on
  staging, 28.09.2026: 30 notes and 15 cars, and `company_id` is NULL on none of
  them, so the lenient branch is unreachable there today.

  The trigger function is SECURITY DEFINER, and that is the honest choice rather
  than the convenient one. As INVOKER it would read `cars` through that table's
  SELECT policy, so the rule would become "the car is invisible to me" — which
  is a different sentence, and a different one again for a platform account
  inside a support session. As DEFINER it reads `cars.company_id` for the row the
  caller named and compares the two companies, whoever is asking.

  What it does **not** cover, stated rather than discovered: it guards writes to
  the *note*, so a car later moved to another company would leave an existing
  note pointing across the boundary. Nothing in the product moves a car between
  companies, and giving `cars` a guard of its own is a change to that table, not
  to this column.

  ## THE SAFETY PROPERTY

  Nothing in `StructuredNote` (src/utils/monatsplanungPhase3.ts),
  `monatsplanungPhase3` or `driverNoteValidation` may learn about the car, and
  the planning engine's behaviour must be provably unchanged. In the database
  half that is a catalogue fact, asserted below: no policy on `driver_notes`
  mentions `car_id`, so the column is not a tenancy term. In the browser half it
  holds by construction — every consumer other than the Notizen screen names its
  columns explicitly (measured: MonatsplanungAssignmentPreview,
  MonatsplanungStundennachweisPreview, StundennachweisPage twice and
  HistoricalWorkingHoursWizard all pass a column list, none uses `select('*')`),
  so no query that feeds the engine can return this column.

  ## The redaction judgement, which changes no function

  `app_private.support_write_redaction_pattern('driver_notes')`
  (20260920110000) redacts `note_text` and nothing else beyond its two general
  alternatives, and both of those exclude any column whose name ends in `_id`.
  So `car_id` is recorded, not redacted. Measured against the live pattern on
  staging, 28.09.2026: `car_id` → false, `note_text` → true.

  That is the right answer, and it agrees with the precedent: no `car_id`
  anywhere is redacted, and `fahrtenbuch_trips.assigned_driver_name` is not
  either. A Kennzeichen identifies a company asset, not a person — it is the
  same class of fact as the note's `driver_id`, which the audit already keeps.
  This migration therefore does **not** touch that function; it asserts the
  behaviour instead, so that a later migration which starts redacting `car_id`
  fails here and has to say why.

  PostgREST learns the new column from the image's own `pgrst_ddl_watch` event
  trigger, which fires on `ddl_command_end`; ALTER TABLE is DDL, so no NOTIFY.
*/

-- ─── 1. The column ──────────────────────────────────────────────────────────

ALTER TABLE public.driver_notes
  ADD COLUMN IF NOT EXISTS car_id uuid;

COMMENT ON COLUMN public.driver_notes.car_id IS
  'Optional: the car an incident note happened on, so a ticket addressed to a '
  'plate can be tied back to the Fahrtenbuch. A key into public.cars, never '
  'free text; NULL for every note that is not about a vehicle (20260928120000).';

-- ─── 2. The foreign key ─────────────────────────────────────────────────────

-- Guarded rather than unconditional so the migration is idempotent; ADD
-- CONSTRAINT has no IF NOT EXISTS.
DO $mig$
BEGIN
  IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
         WHERE conname  = 'driver_notes_car_id_fkey'
           AND conrelid = 'public.driver_notes'::regclass) THEN
    ALTER TABLE public.driver_notes
      ADD CONSTRAINT driver_notes_car_id_fkey
      FOREIGN KEY (car_id) REFERENCES public.cars(id) ON DELETE SET NULL;
  END IF;
END $mig$;

-- ─── 3. The index ───────────────────────────────────────────────────────────

-- Partial: the overwhelming majority of notes name no car, and the only query
-- this column will ever serve asks for the ones that do.
CREATE INDEX IF NOT EXISTS idx_driver_notes_car_id
  ON public.driver_notes (car_id)
  WHERE car_id IS NOT NULL;

-- ─── 4. The rule, as a pure function ────────────────────────────────────────

/*
  May a note of company `p_note_company` name a car of company `p_car_company`?

  Only what can be judged is refused: both known and different. Either side NULL
  is allowed — see the header.
*/
CREATE OR REPLACE FUNCTION app_private.driver_note_car_company_ok(
  p_note_company uuid,
  p_car_company  uuid)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_note_company IS NULL OR p_car_company IS NULL THEN
    RETURN true;
  END IF;

  RETURN p_note_company = p_car_company;
END;
$$;

COMMENT ON FUNCTION app_private.driver_note_car_company_ok(uuid, uuid) IS
  'Whether a driver note of one company may name a car of another: no, when '
  'both companies are known and differ; yes otherwise (20260928120000).';

-- ─── 5. The trigger function ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.enforce_driver_note_car_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_car_company uuid;
BEGIN
  -- The normal case: no car named, nothing to check.
  IF NEW.car_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- An UPDATE that moves neither the car nor the company cannot break the rule,
  -- so it is not worth a lookup — and the Notizen screen sends every column on
  -- every edit.
  IF TG_OP = 'UPDATE'
     AND NEW.car_id     IS NOT DISTINCT FROM OLD.car_id
     AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id THEN
    RETURN NEW;
  END IF;

  SELECT c.company_id
    INTO v_car_company
    FROM public.cars c
   WHERE c.id = NEW.car_id;

  -- A car that does not exist is the foreign key's refusal to make, with its
  -- own message; saying it twice here would only hide which check spoke.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NOT app_private.driver_note_car_company_ok(NEW.company_id, v_car_company) THEN
    RAISE EXCEPTION
      'Eine Notiz kann nur ein Fahrzeug des eigenen Unternehmens nennen.'
      USING ERRCODE = '42501', HINT = 'driver_note_car_company_mismatch';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_private.enforce_driver_note_car_company() IS
  'Refuses a driver note that names a car of another company: a foreign key is '
  'checked without regard to RLS, so the four tenant policies cannot (20260928120000).';

DROP TRIGGER IF EXISTS enforce_driver_note_car_company ON public.driver_notes;
CREATE TRIGGER enforce_driver_note_car_company
  BEFORE INSERT OR UPDATE ON public.driver_notes
  FOR EACH ROW
  EXECUTE FUNCTION app_private.enforce_driver_note_car_company();

-- ─── 6. Ownership and privileges ────────────────────────────────────────────

-- The definer reaches app_private, so it must belong to the role that owns it;
-- CREATE OR REPLACE keeps whatever owner a function already had.
ALTER FUNCTION app_private.driver_note_car_company_ok(uuid, uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.enforce_driver_note_car_company()      OWNER TO CURRENT_USER;

-- Fired by a trigger or called from it, never by a client. Triggers do not check
-- EXECUTE; the REVOKE is the second wall behind the missing USAGE on app_private.
REVOKE ALL ON FUNCTION app_private.driver_note_car_company_ok(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.enforce_driver_note_car_company()      FROM PUBLIC, anon, authenticated, service_role;

-- ─── 7. Self-check ──────────────────────────────────────────────────────────

/*
  Everything here holds on a database with no companies, no cars and no notes:
  the truth table is a pure function call, and the rest reads the catalogue.
*/
DO $mig$
DECLARE
  c_a CONSTANT uuid := '00000000-0000-4000-8000-00000000000a';
  c_b CONSTANT uuid := '00000000-0000-4000-8000-00000000000b';
  v_n     int;
  v_txt   text;
  v_bad   text;
BEGIN
  -- 1. The column: uuid, nullable, no default.
  SELECT count(*) INTO v_n
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'public.driver_notes'::regclass
     AND a.attname  = 'car_id'
     AND NOT a.attisdropped
     AND a.atttypid = 'uuid'::regtype
     AND NOT a.attnotnull
     AND NOT a.atthasdef;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'driver_notes.car_id is missing, or is not a nullable uuid without a default';
  END IF;

  -- 2. The foreign key: into cars(id), ON DELETE SET NULL.
  SELECT count(*) INTO v_n
    FROM pg_catalog.pg_constraint c
   WHERE c.conrelid    = 'public.driver_notes'::regclass
     AND c.contype     = 'f'
     AND c.confrelid   = 'public.cars'::regclass
     AND c.confdeltype = 'n'
     AND c.conkey      = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
                                 WHERE a.attrelid = 'public.driver_notes'::regclass
                                   AND a.attname = 'car_id')]::smallint[];
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'driver_notes.car_id has no foreign key into cars(id) with ON DELETE SET NULL. '
      'An incident still happened after the car is sold; CASCADE would delete the record of it.';
  END IF;

  -- 3. The index.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
                  WHERE relname = 'idx_driver_notes_car_id'
                    AND relnamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'idx_driver_notes_car_id is missing';
  END IF;

  -- 4. The trigger: BEFORE, per row, on INSERT and UPDATE, our function.
  SELECT count(*) INTO v_n
    FROM pg_catalog.pg_trigger t
   WHERE t.tgrelid = 'public.driver_notes'::regclass
     AND t.tgname  = 'enforce_driver_note_car_company'
     AND NOT t.tgisinternal
     AND t.tgfoid  = 'app_private.enforce_driver_note_car_company()'::regprocedure
     AND (t.tgtype & 1) = 1      -- FOR EACH ROW
     AND (t.tgtype & 2) = 2      -- BEFORE
     AND (t.tgtype & 4) = 4      -- INSERT
     AND (t.tgtype & 16) = 16;   -- UPDATE
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'the BEFORE INSERT OR UPDATE row trigger enforce_driver_note_car_company is '
      'missing from driver_notes, or is not wired to app_private.enforce_driver_note_car_company()';
  END IF;

  -- 5. The rule, as a truth table. Row two is the NEGATIVE CONTROL: it is what
  --    every database did before this migration, and it must now be refused.
  IF NOT app_private.driver_note_car_company_ok(c_a, c_a) THEN
    RAISE EXCEPTION 'the rule refuses a car of the note''s own company';
  END IF;
  IF app_private.driver_note_car_company_ok(c_a, c_b) THEN
    RAISE EXCEPTION
      'NEGATIVE CONTROL: the rule still allows a note of one company to name a '
      'car of another — the behaviour this migration exists to end';
  END IF;
  IF NOT app_private.driver_note_car_company_ok(NULL, c_a) THEN
    RAISE EXCEPTION 'the rule refuses a note whose own company is unknown; unknown is not mismatched';
  END IF;
  IF NOT app_private.driver_note_car_company_ok(c_a, NULL) THEN
    RAISE EXCEPTION 'the rule refuses a car whose company is unknown; unknown is not mismatched';
  END IF;
  IF NOT app_private.driver_note_car_company_ok(NULL, NULL) THEN
    RAISE EXCEPTION 'the rule refuses two unknown companies';
  END IF;

  -- 6. Both functions: pinned search_path, the right volatility and security,
  --    an owner that can reach app_private, and no EXECUTE for an API role.
  FOR v_txt IN
    SELECT unnest(ARRAY['app_private.driver_note_car_company_ok(uuid,uuid)',
                        'app_private.enforce_driver_note_car_company()'])
  LOOP
    IF pg_catalog.to_regprocedure(v_txt) IS NULL THEN
      RAISE EXCEPTION '% does not exist', v_txt;
    END IF;

    IF NOT EXISTS (SELECT 1
                     FROM pg_catalog.pg_proc p, unnest(p.proconfig) AS c(setting)
                    WHERE p.oid = pg_catalog.to_regprocedure(v_txt)
                      AND c.setting = 'search_path=pg_catalog, public') THEN
      RAISE EXCEPTION
        '% must pin SET search_path = pg_catalog, public; its settings are %',
        v_txt,
        coalesce((SELECT p.proconfig::text FROM pg_catalog.pg_proc p
                   WHERE p.oid = pg_catalog.to_regprocedure(v_txt)), 'none');
    END IF;

    -- The owner idiom of 20260920110000: a superuser, or the role that owns
    -- app_private — the only owners that can reach the schema.
    IF NOT EXISTS (SELECT 1
                     FROM pg_catalog.pg_proc p
                     JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = pg_catalog.to_regprocedure(v_txt)
                      AND (r.rolsuper
                           OR r.oid = (SELECT nspowner FROM pg_catalog.pg_namespace
                                        WHERE nspname = 'app_private'))) THEN
      RAISE EXCEPTION '%: its owner cannot reach app_private', v_txt;
    END IF;

    IF pg_catalog.has_function_privilege('anon', pg_catalog.to_regprocedure(v_txt), 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', pg_catalog.to_regprocedure(v_txt), 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', pg_catalog.to_regprocedure(v_txt), 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by an API role; it is only ever fired by a trigger', v_txt;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.oid = 'app_private.enforce_driver_note_car_company()'::regprocedure
                AND NOT p.prosecdef) THEN
    RAISE EXCEPTION
      'enforce_driver_note_car_company is SECURITY INVOKER. As the caller it would '
      'read cars through that table''s SELECT policy, so the rule would become '
      '"the car is invisible to me" instead of "the car belongs to another company".';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.oid = 'app_private.driver_note_car_company_ok(uuid,uuid)'::regprocedure
                AND p.provolatile <> 'i') THEN
    RAISE EXCEPTION 'driver_note_car_company_ok is not IMMUTABLE; it reads nothing and must say so';
  END IF;

  -- 7. THE SAFETY PROPERTY, as a catalogue fact: no policy on driver_notes
  --    mentions car_id, so the car is not a tenancy term and no planning query
  --    can be steered by it.
  SELECT string_agg(pol.policyname, ', ' ORDER BY pol.policyname)
    INTO v_bad
    FROM pg_catalog.pg_policies pol
   WHERE pol.schemaname = 'public'
     AND pol.tablename  = 'driver_notes'
     AND (coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')) ~ '\mcar_id\M';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'a policy on driver_notes reads car_id (%): the car records an incident and '
      'must never decide who may read or write a note', v_bad;
  END IF;

  -- 8. The redaction judgement (20260920110000 is unchanged by this migration):
  --    car_id is recorded, note_text is redacted. Skipped where that function
  --    does not exist.
  IF pg_catalog.to_regprocedure('app_private.support_write_redaction_pattern(text)') IS NOT NULL THEN
    SELECT app_private.support_write_redaction_pattern('driver_notes') INTO v_txt;

    IF 'car_id' ~ v_txt THEN
      RAISE EXCEPTION
        'the support-write audit now redacts driver_notes.car_id. A Kennzeichen '
        'identifies a company asset, not a person, and no car_id anywhere else is '
        'redacted; if that changed on purpose, change this check and say why.';
    END IF;

    IF NOT ('note_text' ~ v_txt) THEN
      RAISE EXCEPTION
        'the support-write audit no longer redacts driver_notes.note_text — the '
        'free text about a person''s absence; this migration relies on that rule '
        'still being there.';
    END IF;
  END IF;

  -- 9. The claim that no policy change is needed: the column inherits the shape
  --    the table already carries. Asserted where that shape exists — a database
  --    without 20260917140000 / 20260920110000 has nothing to inherit.
  IF pg_catalog.to_regprocedure('app_private.refuse_read_only_context_write()') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                      WHERE t.tgrelid = 'public.driver_notes'::regclass
                        AND NOT t.tgisinternal
                        AND t.tgfoid = 'app_private.refuse_read_only_context_write()'::regprocedure) THEN
    RAISE EXCEPTION
      'driver_notes has lost refuse_read_only_context_write: a view context could '
      'write this column, which is the defect 20260920100000 closed for storage';
  END IF;

  IF pg_catalog.to_regprocedure('app_private.record_support_write()') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                      WHERE t.tgrelid = 'public.driver_notes'::regclass
                        AND NOT t.tgisinternal
                        AND t.tgfoid = 'app_private.record_support_write()'::regprocedure) THEN
    RAISE EXCEPTION
      'driver_notes has lost record_support_write: a support session could set this '
      'column with no audit row';
  END IF;

  RAISE NOTICE 'ok  driver_notes.car_id: nullable uuid, FK to cars ON DELETE SET NULL, partial index, same-company trigger, no policy reads it, car_id not redacted, support triggers still in place';
END $mig$;
