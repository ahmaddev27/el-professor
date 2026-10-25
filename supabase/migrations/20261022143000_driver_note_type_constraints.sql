-- ════════════════════════════════════════════════════════════════════════════
--  A driver note's type and its planning effect must agree
-- ════════════════════════════════════════════════════════════════════════════
--
--  `driver_notes.note_type` had no CHECK of its own, and nothing tied it to
--  `note_planning_behavior`, which is the only one of the two columns the
--  planner reads. A note of type `sick` stored with `neutral` is accepted, and
--  the planner does not exclude that driver: the new_month query
--  (`.eq('note_planning_behavior', 'exclude_from_plan')`), the monthly plan
--  (`.neq('note_planning_behavior', 'neutral')`), `findBlockingNote` and the
--  Stundennachweis ("Abwesenheit" / "Pflichtnotiz", printed on the document that
--  goes to the Steuerberater) all branch on the behaviour alone.
--
--  20261005140000 named the hole and closed it for the partner path only, by
--  deriving the behaviour in `app_private.note_behavior_for`. The Notizen screen
--  went on sending the behaviour as a free-standing column from a `<select>` the
--  operator can change, so the browser could still write the pairing the partner
--  door refuses. This migration makes the database refuse it, for every writer.
--
--  ── What the data said, and what that decided ───────────────────────────────
--
--  Measured read-only on staging, 22.10.2026: 37 notes in 2 companies. 32 carry
--  the pairing the derivation gives. Five do not, and they are not one thing:
--
--    general  + must_include_in_plan   1   an authority check, typed in the app
--    other    + must_include_in_plan   3   two sightings of the driver by a third
--                                          party, typed in the app, and the demo
--                                          company's "Kontrollfahrt eingeplant"
--    vacation + neutral                1   the demo company's "Urlaub beantragt,
--                                          noch offen"
--
--  Four of the five sit on the two types that carry no meaning of their own,
--  `general` and `other`. The three typed by an operator in a real company are
--  each "something happened to this driver at this hour and the plan must
--  contain it": an authority check, and two sightings of the driver by a third
--  party. The sightings fit none of the five incident types. The check is what
--  `kontrolle` is for, but since 13.10.2026 the five require a vehicle, so for an
--  event with no vehicle `other` + must_include_in_plan is the only way to say
--  it. Whether each was meant is the operator's to confirm; a row cannot prove
--  intent. The two demo rows come from scripts/seed-demo-company.sql, written
--  "one note per planning behaviour" so the screen and the planner each have
--  all three. Among the 26 notes whose type DOES have a fixed meaning, 25 agree
--  with it, and the one that does not is that seed's `vacation` + `neutral`.
--
--  So the override is a feature for exactly two types and a defect for the other
--  eight, and the constraint says so instead of choosing one answer for all ten:
--
--    general, other        the effect is the operator's choice (any of the three)
--    the other eight       the effect is the type's: sick, vacation, off exclude;
--                          blitzer, accident, kontrolle, breakdown, wait require
--
--  A request that really is "a vacation that is not approved yet" is a
--  `general` note that says so; it loses nothing, because `vacation` + `neutral`
--  and `general` + `neutral` are the same instruction to the planner.
--
--  Considered and not done:
--    - One rule for all ten. It would have refused the kind of row four of the
--      five are, which an operator wrote on purpose.
--    - An explicit "override" flag on the row. It needs a backfill of customers'
--      rows to make the constraint pass, and records a distinction the type
--      already carries.
--    - A lookup table with a composite foreign key. One table, its policies, its
--      place in the backup list and the matrix, for a vocabulary of ten values.
--
--  ── The rows that already disagree ──────────────────────────────────────────
--
--  Both constraints are added NOT VALID and then validated if, and only if, no
--  existing row breaks them. Nothing here ever rewrites a stored note: a
--  migration that changed a customer's `neutral` to `exclude_from_plan` would be
--  changing who the planner may assign, and that is the operator's decision.
--  On staging the type constraint validates and the pairing constraint stays
--  NOT VALID because of the one demo row; production was not read, so what it
--  does there is decided by its data, and the NOTICE below says which.
--
--  NOT VALID is not "ignore the old rows", and the cost is worth stating.
--  Measured on PostgreSQL 16.6 and 18.6 (tests/rls/note-type-constraint.sql,
--  section 5, records it): an UPDATE of a row that breaks a NOT VALID
--  constraint is refused unless it also fixes the row, whatever column it
--  touches; and deleting a car that such a note names is refused too, because
--  the foreign key's ON DELETE SET NULL is an UPDATE of the note. Reads and
--  DELETEs are untouched. The Notizen screen refuses the save with its own
--  sentence first (notes.behaviorMismatch), and unlocks the effect field for a
--  note in that state so the operator can fix it there.
--
--  To see what a database holds before this runs (and what validation will do):
--
--    SELECT note_type, note_planning_behavior, count(*) FROM public.driver_notes
--     GROUP BY 1, 2 ORDER BY 1, 2;
--
--  ── Why the CHECKs do not call app_private.note_behavior_for ────────────────
--
--  The obstacle is not immutability: the function is IMMUTABLE and PostgreSQL
--  accepts it in a CHECK. It is privilege. A CHECK is evaluated as the role that
--  writes the row, the Notizen screen writes as `authenticated`, and that role
--  has no USAGE on app_private and no EXECUTE on the function (revoked on
--  purpose). Measured on PostgreSQL 16.6 and 18.6 with the repository's own
--  function body, a CHECK of `note_planning_behavior = app_private.note_behavior_for(
--  note_type) OR note_type IN ('general', 'other')`:
--
--    owner inserts sick / exclude_from_plan            accepted
--    authenticated inserts sick / exclude_from_plan    42501 permission denied
--                                                      for function
--    authenticated inserts general / neutral           42501, the same
--
--  The last line is the one that matters: the call is refused even for a note
--  the OR would have passed without ever reaching the function, so the rule
--  would refuse every note the screen writes, including the ones it allows. (The
--  observation is what is claimed, not the mechanism behind it.) It is the
--  failure of the Rollen screen (a trigger naming app_private as the caller), and
--  the first line is why a probe run by the owner never sees it. A wrapper in
--  `public` fails twice: ungranted it is 42501 on the wrapper, granted it is
--  42501 on `app_private` one level down. A function in `public` that carries
--  the list itself would work, at the price of a new callable function and a
--  grant to keep right; the constraints below carry the list instead and call
--  nothing, so they need no privilege of anyone. Their pg_depend entries name
--  the table and nothing else, and the self-check asserts that.
--
--  ── Where the list now lives ────────────────────────────────────────────────
--
--  Ten values, written in more places than one. None is new; this is the map:
--
--    app_private.note_behavior_for   what SECURITY DEFINER code derives (the
--                                    partner door and its apply). Unchanged.
--    the two CHECKs below            the boundary, for every writer.
--    src/utils/noteRules.ts          the browser's one table; NotesPage reads it.
--    driverNoteValidation.ts         the German label of each type.
--    the driver app, note-rules.ts   another repository; not reachable from here.
--
--  The self-check below runs the function against the constraints for all
--  thirty (type, effect) pairs, and src/utils/noteTypeVocabulary.test.ts reads
--  this file and the function's migration and holds the TypeScript table to
--  both. tests/rls/note-type-constraint.sql is the kit's side of the same claim.
--
--  ── Rolling back ────────────────────────────────────────────────────────────
--
--  The release before this one can still save every pairing the constraints
--  admit. It would be refused for the pairings they now refuse, which is the
--  defect surfacing and not a new failure, and no read changes. So no
--  SCHEMA_EPOCH bump.

-- ─── 1. the type is one of the ten ──────────────────────────────────────────

ALTER TABLE public.driver_notes
  DROP CONSTRAINT IF EXISTS driver_notes_note_type_known;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_note_type_known
  CHECK (note_type IN ('general', 'sick', 'vacation', 'off', 'blitzer',
                       'accident', 'kontrolle', 'breakdown', 'wait', 'other'))
  NOT VALID;

-- ─── 2. the effect follows the type, except for the two free types ──────────
--
--  ELSE true is deliberate and not a gap: a type outside the ten is the other
--  constraint's to refuse. Without the ELSE the CASE answers NULL for a stranger
--  and a CHECK lets NULL through, which is the same result reached by accident.

ALTER TABLE public.driver_notes
  DROP CONSTRAINT IF EXISTS driver_notes_behavior_follows_type;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_behavior_follows_type
  CHECK (
    CASE note_type
      WHEN 'general'   THEN true
      WHEN 'other'     THEN true
      WHEN 'sick'      THEN note_planning_behavior = 'exclude_from_plan'
      WHEN 'vacation'  THEN note_planning_behavior = 'exclude_from_plan'
      WHEN 'off'       THEN note_planning_behavior = 'exclude_from_plan'
      WHEN 'blitzer'   THEN note_planning_behavior = 'must_include_in_plan'
      WHEN 'accident'  THEN note_planning_behavior = 'must_include_in_plan'
      WHEN 'kontrolle' THEN note_planning_behavior = 'must_include_in_plan'
      WHEN 'breakdown' THEN note_planning_behavior = 'must_include_in_plan'
      WHEN 'wait'      THEN note_planning_behavior = 'must_include_in_plan'
      ELSE true
    END
  )
  NOT VALID;

-- ─── 3. validate what can be validated, and leave the rest alone ────────────
--
--  VALIDATE raises check_violation when a row breaks the constraint, and the
--  subtransaction that catches it leaves the constraint NOT VALID. The count in
--  the NOTICE is taken with the constraint's own expression, so it cannot drift
--  from the rule.

DO $validate$
DECLARE
  v_name text;
  v_bad  bigint;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['driver_notes_note_type_known',
                                'driver_notes_behavior_follows_type'] LOOP
    BEGIN
      EXECUTE format('ALTER TABLE public.driver_notes VALIDATE CONSTRAINT %I', v_name);
    EXCEPTION WHEN check_violation THEN
      EXECUTE format(
        'SELECT count(*) FROM public.driver_notes WHERE (%s) IS FALSE',
        (SELECT pg_catalog.pg_get_expr(c.conbin, c.conrelid)
           FROM pg_catalog.pg_constraint c
          WHERE c.conrelid = 'public.driver_notes'::regclass AND c.conname = v_name))
        INTO v_bad;
      RAISE NOTICE '% stays NOT VALID: % existing note(s) break it; they are left as they are and new writes are checked',
        v_name, v_bad;
    END;
  END LOOP;
END
$validate$;

-- ─── 4. what the constraints say, for whoever meets them in an error ────────

COMMENT ON CONSTRAINT driver_notes_note_type_known ON public.driver_notes IS
  'The ten note types and nothing else, compared exactly (no case folding, no '
  'trimming): every reader compares the stored identifier as it is. Added NOT '
  'VALID and validated where the data allowed (20261022143000).';

COMMENT ON CONSTRAINT driver_notes_behavior_follows_type ON public.driver_notes IS
  'The planning effect a type carries: sick, vacation and off exclude; blitzer, '
  'accident, kontrolle, breakdown and wait require. general and other are the '
  'operator''s own categories and may carry any of the three. The planner reads '
  'the effect alone, so a sick note stored as neutral does not exclude the '
  'driver. Restates app_private.note_behavior_for, which a CHECK cannot call '
  'as the writing role (20261022143000).';

COMMENT ON FUNCTION app_private.note_behavior_for(text) IS
  'The planning behaviour a note type carries by default: neutral for general '
  'and other, exclude_from_plan for sick, vacation and off, must_include_in_plan '
  'for the five incident types, NULL for anything else. SECURITY DEFINER code '
  '(the partner door and its apply) derives a note''s behaviour here and never '
  'accepts it from a caller. driver_notes enforces the same pairing itself, as '
  'the CHECK driver_notes_behavior_follows_type, which restates this list because '
  'a CHECK runs as the writing role and that role cannot reach app_private; the '
  'self-check of 20261022143000 and tests/rls/note-type-constraint.sql keep the '
  'two equal.';

-- ─── 5. self-check ──────────────────────────────────────────────────────────
--
--  Everything runs through the table itself, with a driver and an account that
--  do not exist. The CHECKs are evaluated while the row is built; the foreign
--  keys are checked when the statement ends. So an INSERT that the constraints
--  admit dies on a foreign key (23503), and one they refuse dies on a CHECK
--  (23514) first, with the constraint's name. That difference is the probe, and
--  it needs no row to exist. An INSERT that succeeded would fall through to the
--  RAISE and fail the release.

DO $check$
DECLARE
  c_types     CONSTANT text[] := ARRAY['general', 'sick', 'vacation', 'off', 'blitzer',
                                       'accident', 'kontrolle', 'breakdown', 'wait', 'other'];
  c_free      CONSTANT text[] := ARRAY['general', 'other'];
  c_effects   CONSTANT text[] := ARRAY['neutral', 'exclude_from_plan', 'must_include_in_plan'];
  c_strangers CONSTANT text[] := ARRAY['krank', '', 'SICK', ' sick', 'sick '];

  v_type    text;
  v_effect  text;
  v_want    text;
  v_got     text;
  v_name    text;
  v_n       int;
  v_funcs   text;
  v_state   text := '';
BEGIN
  -- 1. Both constraints exist, as CHECKs, on the table.
  FOREACH v_name IN ARRAY ARRAY['driver_notes_note_type_known',
                                'driver_notes_behavior_follows_type'] LOOP
    SELECT count(*) INTO v_n
      FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.driver_notes'::regclass
       AND c.conname  = v_name
       AND c.contype  = 'c';
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'self-check 1: driver_notes has no CHECK named %', v_name;
    END IF;
  END LOOP;

  -- 2. They call no function. A CHECK runs as the writing role, which cannot
  --    reach app_private, so a function in either would refuse every write the
  --    Notizen screen makes (measured; see the header). Their dependencies are
  --    the table's columns and built-in operators, never a pg_proc row.
  SELECT string_agg(c.conname || ' -> ' || d.refobjid::regprocedure::text, ', ')
    INTO v_funcs
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_depend d
      ON d.classid = 'pg_catalog.pg_constraint'::regclass AND d.objid = c.oid
     AND d.refclassid = 'pg_catalog.pg_proc'::regclass
   WHERE c.conrelid = 'public.driver_notes'::regclass
     AND c.conname IN ('driver_notes_note_type_known', 'driver_notes_behavior_follows_type');
  IF v_funcs IS NOT NULL THEN
    RAISE EXCEPTION
      'self-check 2: a driver_notes CHECK now depends on a function (%). It runs as the writing role, which cannot execute app_private.*; every Notizen write would die 42501.', v_funcs;
  END IF;

  -- 3. The truth table: ten types by three effects, plus strangers, through the
  --    table. What the pairing should be is read from app_private.note_behavior_for,
  --    not written a second time, so the function and the constraints cannot
  --    drift apart without failing here.
  IF app_private.note_behavior_for('general') IS DISTINCT FROM 'neutral'
     OR app_private.note_behavior_for('other') IS DISTINCT FROM 'neutral' THEN
    RAISE EXCEPTION 'self-check 3: the free types no longer derive neutral';
  END IF;

  FOREACH v_type IN ARRAY c_types || c_strangers LOOP
    FOREACH v_effect IN ARRAY c_effects LOOP
      IF v_type <> ALL (c_types) THEN
        v_want := 'refused:driver_notes_note_type_known';
      ELSIF v_type = ANY (c_free) OR v_effect = app_private.note_behavior_for(v_type) THEN
        v_want := 'admitted';
      ELSE
        v_want := 'refused:driver_notes_behavior_follows_type';
      END IF;

      BEGIN
        INSERT INTO public.driver_notes
               (created_by, driver_id, note_text, note_type, note_planning_behavior)
        VALUES (gen_random_uuid(), gen_random_uuid(), 'self-check', v_type, v_effect);
        RAISE EXCEPTION 'self-check 3: the probe row for (%, %) was inserted', v_type, v_effect;
      EXCEPTION
        WHEN check_violation THEN
          GET STACKED DIAGNOSTICS v_name = CONSTRAINT_NAME;
          v_got := 'refused:' || v_name;
        WHEN foreign_key_violation THEN
          v_got := 'admitted';
      END;

      IF v_got IS DISTINCT FROM v_want THEN
        RAISE EXCEPTION 'self-check 3: note (%, %) should be %, but is %',
          quote_literal(v_type), quote_literal(v_effect), v_want, v_got;
      END IF;
    END LOOP;
  END LOOP;

  -- 4. The vocabulary CHECK this migration did not write is still there, and
  --    still the one that answers for an effect outside the three.
  SELECT count(*) INTO v_n
    FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'public.driver_notes'::regclass
     AND c.contype  = 'c'
     AND c.conname  = 'driver_notes_note_planning_behavior_check';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'self-check 4: driver_notes_note_planning_behavior_check is gone';
  END IF;

  -- 5. Say which state each constraint ended in, so a deploy log shows it.
  SELECT string_agg(c.conname || (CASE WHEN c.convalidated THEN ' VALID' ELSE ' NOT VALID' END),
                    '; ' ORDER BY c.conname)
    INTO v_state
    FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'public.driver_notes'::regclass
     AND c.conname IN ('driver_notes_note_type_known', 'driver_notes_behavior_follows_type');

  RAISE NOTICE 'ok  driver_notes: 10 types x 3 effects + % strangers agree with note_behavior_for, the CHECKs call no function; %',
    cardinality(c_strangers), v_state;
END
$check$;
