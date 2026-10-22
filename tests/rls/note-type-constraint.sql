/*
  A driver note's type is one of ten, and its planning effect follows it
  (20261022143000).

  `driver_notes.note_type` had no CHECK and nothing tied it to
  `note_planning_behavior`, the only column the planner reads, so a `sick` note
  stored as `neutral` did not exclude the driver. The migration adds two CHECKs:
  the type is one of the ten, and the eight types with a fixed meaning carry
  their type's effect while `general` and `other` keep any of the three. This
  file is the kit's side of that claim.

  ## What each section says, and why it is not obvious

  0. The catalogue, and the one fact that is easy to lose: `note_behavior_for`
     folds case and trims, the CHECK compares exactly, and the partner door
     stores the normalised type. The asymmetry is recorded so nobody "fixes" it
     in one place.

  1. The truth table, thirty (type, effect) pairs, five strangers and a NULL
     type, through real INSERTs shaped as the Notizen screen sends them. The
     expectation is a literal in this file, and probe 3 holds `note_behavior_for`
     (what the partner path derives) to the same literal, so the function, the
     constraints and this file cannot drift in pairs without one of them failing
     by name.

  2. The same battery as the principals who write notes: a company administrator
     and an editor, who pass the page gate and so are decided by the constraint
     alone; and a viewer, who is refused by the page gate with a different
     SQLSTATE (42501, not 23514) before the constraint is asked. A probe whose
     refusals all share one SQLSTATE measures nothing, so every refusal here
     also carries the CONSTRAINT's name.

  3. The Notizen screen's edit, which sends every column on every save: the type
     changed alone (a stale client), the effect changed alone, both together, and
     a delete. And a car deleted from under a valid note, which is an UPDATE of
     the note through ON DELETE SET NULL.

  4. The partner path: every type written exactly as `partner_note_apply` writes
     it (the type with `note_behavior_for(type)`), and the door itself,
     `partner_note_submission_record`, as `service_role`, for all ten.

  5. NOT VALID, recorded and not endorsed. The migration adds both constraints
     NOT VALID and validates only what is clean, so a database can carry a row
     that breaks the rule. Measured: it stays readable; an UPDATE of it is
     refused unless it also fixes it, whatever column it touches; deleting a car
     it names is refused (the foreign key's SET NULL is an UPDATE); VALIDATE
     fails until it is fixed. Like the matrix, this records today's behaviour so
     a change to it has to say so.

  6. The mutation control, which is what makes sections 1 and 2 worth reading.
     The battery is run against the real constraints (no mismatch), against
     four broken ones (an exact, countable number of mismatches each), and again
     against the real ones after the rolled-back mutations (no mismatch). The
     fourth is the reason the constraints are literals: a pairing CHECK that
     calls `app_private.note_behavior_for` passes every probe run as the owner
     and refuses every note written by `authenticated` (42501), which is the
     failure of the Rollen screen again. The battery is run both ways to show
     the owner cannot see it.

  7. The premises the design stands on: the API roles cannot reach app_private or
     the function, and no CHECK on the table depends on a function. If the first
     ever stops being true the argument for literals is gone and should be
     reconsidered; the second is the standing guard that the migration's
     self-check only applies once.

  ## What it does not claim

  Tenancy, role gates and the support-write audit on this table (matrix.sql,
  tenant-state.sql, permission-coverage.sql and support-write-audit.sql own
  those), and the partner path's refusals (partner-note-intake.sql). The late
  link, where a waiting note becomes a row when its driver is confirmed, is
  exercised there too and writes through the same `partner_note_apply`.

  Collect-then-raise: every probe is recorded and the file fails at the end, so
  one run answers everything instead of stopping at the first surprise. Runs
  inside BEGIN ... ROLLBACK, so the files after it see only the migrations and
  the seeds. Probe numbers are never reused.

  `SET nt.skip_partner = 'on'` skips section 4b's door calls and nothing else. It
  exists for a throwaway database that does not carry the partner schema and is
  off by default: in the kit its absence is what makes the door mandatory.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _nt_out (
  n        integer PRIMARY KEY,
  label    text    NOT NULL,
  actual   text    NOT NULL,
  expected text    NOT NULL,
  matched  boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _nt_rec(p_n integer, p_label text, p_actual text, p_expected text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ok boolean := p_actual IS NOT DISTINCT FROM p_expected;
BEGIN
  INSERT INTO _nt_out VALUES (p_n, p_label, coalesce(p_actual, '<null>'), p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', coalesce(p_actual, '<null>');
  END IF;
END $$;

/* 'none' for an empty list, the list otherwise. array_to_string of an empty array is '' and not NULL. */
CREATE OR REPLACE FUNCTION _nt_list(p_items text[], p_sep text DEFAULT E'\n          ') RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN cardinality(p_items) = 0 THEN 'none' ELSE array_to_string(p_items, p_sep) END
$$;

/* The kit's principals (seed.sql). */
CREATE OR REPLACE FUNCTION _nt_uid(p_who text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_who
    WHEN 'admin'  THEN 'a0000000-0000-4000-8000-000000000001'::uuid
    WHEN 'editor' THEN 'a0000000-0000-4000-8000-000000000002'::uuid
    WHEN 'viewer' THEN 'a0000000-0000-4000-8000-000000000003'::uuid
    WHEN 'owner'  THEN 'a0000000-0000-4000-8000-000000000001'::uuid  -- rows are filed in admin A's name
  END
$$;

/*
  Become a principal for the rest of the current subtransaction. The plans go
  first: schema USAGE and function EXECUTE are resolved when a statement is
  planned, the owner runs every fixture, and a plan the owner cached would let
  every principal after it through (the matrix's `_mx_become` has the account).
*/
CREATE OR REPLACE FUNCTION _nt_as(p_who text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  EXECUTE 'DISCARD PLANS';
  IF p_who = 'owner' THEN
    RETURN;
  ELSIF p_who = 'service' THEN
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
  ELSE
    PERFORM set_config('request.jwt.claim.sub', _nt_uid(p_who)::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.session_id', _nt_uid(p_who)::text, true);
    PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION _nt_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/*
  Runs one statement as one principal in a subtransaction that is always rolled
  back, and says what happened:

      `rows N`                          a write, and how many rows it touched
      the scalar                        a SELECT
      `ERR <sqlstate> <constraint>`     a refusal, by the constraint's name
      `ERR <sqlstate> <hint>`           ... or by the HINT when there is none
      `ERR <sqlstate> -`                ... or bare (a row-level security refusal)

  The constraint's name is what tells the two CHECKs and the existing
  behaviour-vocabulary CHECK apart, and all three raise 23514. A NOT NULL
  refusal is reported bare: PostgreSQL 18 names that constraint and 17 does not,
  and a probe must not depend on which one is running.
*/
CREATE OR REPLACE FUNCTION _nt_try(p_who text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_con   text;
  v_hint  text;
BEGIN
  BEGIN
    PERFORM _nt_as(p_who);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ009' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE,
                              v_con   = CONSTRAINT_NAME,
                              v_hint  = PG_EXCEPTION_HINT;
      IF v_state = '23502' THEN
        v_con := NULL;
        v_hint := NULL;
      END IF;
      v_out := 'ERR ' || v_state || ' ' || coalesce(nullif(v_con, ''), nullif(v_hint, ''), '-');
  END;
  PERFORM _nt_reset();
  RETURN v_out;
END $$;

/* Company A, driver A and the principals are the seed's. */
CREATE OR REPLACE FUNCTION _nt_insert_sql(p_who text, p_type text, p_effect text) RETURNS text
LANGUAGE sql STABLE AS $$
  -- Every column the Notizen screen's handleSubmit sends (NotesPage.tsx, `noteData`).
  SELECT format(
    'INSERT INTO driver_notes (driver_id, car_id, note_date, note_text, created_by, company_id, '
    'note_type, note_planning_behavior, is_full_day, start_time, end_time, start_date, end_date) '
    'VALUES (%L, NULL, now(), %L, %L, %L, %L, %L, false, NULL, NULL, %L, %L)',
    'd0000000-0000-4000-8000-00000000000a', 'nt probe', _nt_uid(p_who),
    'c0000000-0000-4000-8000-00000000000a', p_type, p_effect, '2026-11-02', '2026-11-02')
$$;

/*
  The expectation, as a literal. NULL means the type has no fixed effect: the
  operator's own category, any of the three. Written out here, not read from
  note_behavior_for, because probe 3 holds that function to this table.
*/
CREATE OR REPLACE FUNCTION _nt_fixed_effect(p_type text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type
    WHEN 'sick'      THEN 'exclude_from_plan'
    WHEN 'vacation'  THEN 'exclude_from_plan'
    WHEN 'off'       THEN 'exclude_from_plan'
    WHEN 'blitzer'   THEN 'must_include_in_plan'
    WHEN 'accident'  THEN 'must_include_in_plan'
    WHEN 'kontrolle' THEN 'must_include_in_plan'
    WHEN 'breakdown' THEN 'must_include_in_plan'
    WHEN 'wait'      THEN 'must_include_in_plan'
  END
$$;

/*
  What a principal who passes the page gate should be told for one (type,
  effect): `rows 1` when the constraints admit it, otherwise the refusal and the
  constraint that speaks. A NULL type is the column's NOT NULL; a stranger is the
  type constraint's; a wrong effect on a fixed type is the pairing constraint's.
*/
CREATE OR REPLACE FUNCTION _nt_expected(p_type text, p_effect text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_type IS NULL THEN 'ERR 23502 -'
    WHEN p_type <> ALL (ARRAY['general', 'other', 'sick', 'vacation', 'off', 'blitzer',
                              'accident', 'kontrolle', 'breakdown', 'wait'])
         THEN 'ERR 23514 driver_notes_note_type_known'
    WHEN _nt_fixed_effect(p_type) IS NULL OR _nt_fixed_effect(p_type) = p_effect THEN 'rows 1'
    ELSE 'ERR 23514 driver_notes_behavior_follows_type'
  END
$$;

/* A refusal without its constraint's name: for a mutation that moves who speaks, not what is decided. */
CREATE OR REPLACE FUNCTION _nt_unnamed(p_answer text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(p_answer, '^(ERR 23514) .*$', '\1')
$$;

/*
  The whole battery as one principal: ten types by three effects, then the
  strangers with a valid effect, then a NULL type. Returns the probes that did
  not come out as expected, so a caller can count them: 0 means the constraints
  do what the literal says. 36 probes. With p_named false a CHECK refusal is
  compared without the constraint's name (see mutation D).
*/
CREATE OR REPLACE FUNCTION _nt_battery(p_who text, p_named boolean DEFAULT true) RETURNS text[]
LANGUAGE plpgsql AS $$
DECLARE
  v_types     constant text[] := ARRAY['general', 'other', 'sick', 'vacation', 'off', 'blitzer',
                                       'accident', 'kontrolle', 'breakdown', 'wait'];
  v_effects   constant text[] := ARRAY['neutral', 'exclude_from_plan', 'must_include_in_plan'];
  v_strangers constant text[] := ARRAY['krank', '', 'SICK', ' sick', 'sick '];
  v_bad  text[] := '{}';
  v_t    text;
  v_e    text;
  v_got  text;
  v_want text;
BEGIN
  FOREACH v_t IN ARRAY v_types || v_strangers || ARRAY[NULL]::text[] LOOP
    FOREACH v_e IN ARRAY (CASE WHEN v_t = ANY (v_types) THEN v_effects ELSE ARRAY['neutral'] END) LOOP
      v_got  := _nt_try(p_who, _nt_insert_sql(p_who, v_t, v_e));
      v_want := _nt_expected(v_t, v_e);
      IF NOT p_named THEN
        v_got  := _nt_unnamed(v_got);
        v_want := _nt_unnamed(v_want);
      END IF;
      IF v_got IS DISTINCT FROM v_want THEN
        v_bad := v_bad || format('(%L, %L) wanted %s, got %s', v_t, v_e, v_want, v_got);
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_bad;
END $$;

-- ─── fixtures ───────────────────────────────────────────────────────────────

-- Cars of company A: one a valid note will name, one for the NOT VALID section,
-- one the door's incident types resolve their plate to. `kennzeichen` is
-- globally unique.
INSERT INTO cars (id, company_id, kennzeichen, created_by) VALUES
  ('a7000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'B-NT 1001', 'a0000000-0000-4000-8000-000000000001'),
  ('a7000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000a', 'B-NT 2002', 'a0000000-0000-4000-8000-000000000001'),
  ('a7000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-00000000000a', 'B-NT 3003', 'a0000000-0000-4000-8000-000000000001');

-- Two ordinary notes of company A: one with a free type, one with a fixed type
-- and a car. Section 3 edits them.
INSERT INTO driver_notes (id, created_by, driver_id, company_id, note_text, note_type, note_planning_behavior, car_id)
VALUES
  ('a7100000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-00000000000a',
   'nt free', 'general', 'neutral', NULL),
  ('a7100000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-00000000000a',
   'nt fixed', 'accident', 'must_include_in_plan', 'a7000000-0000-4000-8000-000000000001');

-- ─── 0. what the catalogue holds ────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _nt_rec(1, 'both CHECKs exist on driver_notes',
    (SELECT count(*)::text FROM pg_constraint
      WHERE conrelid = 'public.driver_notes'::regclass AND contype = 'c'
        AND conname IN ('driver_notes_note_type_known', 'driver_notes_behavior_follows_type')),
    '2');

  PERFORM _nt_rec(2, 'and the behaviour-vocabulary CHECK they rely on for the free types is still there',
    (SELECT count(*)::text FROM pg_constraint
      WHERE conrelid = 'public.driver_notes'::regclass AND contype = 'c'
        AND conname = 'driver_notes_note_planning_behavior_check'),
    '1');

  -- Held to the literal. A function that drifts from the constraints is caught
  -- by the migration's self-check; this also catches the function, the
  -- constraints and the literal all moving together.
  PERFORM _nt_rec(3, 'note_behavior_for derives exactly the literal (fixed effect, else neutral), for all ten',
    (SELECT string_agg(t || '=' || coalesce(app_private.note_behavior_for(t), '<null>'), ',' ORDER BY t)
       FROM unnest(ARRAY['general','other','sick','vacation','off','blitzer','accident','kontrolle','breakdown','wait']) AS t),
    (SELECT string_agg(t || '=' || coalesce(_nt_fixed_effect(t), 'neutral'), ',' ORDER BY t)
       FROM unnest(ARRAY['general','other','sick','vacation','off','blitzer','accident','kontrolle','breakdown','wait']) AS t));

  PERFORM _nt_rec(4, 'and derives nothing for a stranger or a NULL, so the partner door refuses them',
    coalesce(app_private.note_behavior_for('krank'), 'null') || ',' ||
    coalesce(app_private.note_behavior_for(''), 'null')      || ',' ||
    coalesce(app_private.note_behavior_for(NULL), 'null'),
    'null,null,null');

  -- The asymmetry that must not be "fixed" in one place. The function folds case
  -- and trims, so ' Sick ' derives a behaviour; the CHECK compares exactly, so
  -- the table refuses ' Sick ' (probe 10 covers 'SICK', ' sick' and 'sick ').
  -- The door normalises with lower(btrim()) before it stores, which is why the
  -- two never meet. Remove the normalisation and a partner note would be refused.
  PERFORM _nt_rec(5, 'RECORDED: the function folds case and trims where the CHECK does not',
    coalesce(app_private.note_behavior_for(' Sick '), 'null'), 'exclude_from_plan');

  -- On a database whose driver_notes was clean when the migration ran, both end
  -- up validated. That is the positive branch of the migration's own VALIDATE
  -- step; the NOT VALID branch is section 5.
  PERFORM _nt_rec(6, 'on this clean database both constraints ended VALIDATED',
    (SELECT string_agg(conname || '=' || convalidated, ',' ORDER BY conname) FROM pg_constraint
      WHERE conrelid = 'public.driver_notes'::regclass
        AND conname IN ('driver_notes_note_type_known', 'driver_notes_behavior_follows_type')),
    'driver_notes_behavior_follows_type=true,driver_notes_note_type_known=true');
END $$;

-- ─── 1. the truth table, as the owner ───────────────────────────────────────
-- The owner bypasses row-level security, so this is the constraints and nothing
-- else answering. Section 2 asks the same of the principals who really write.

DO $$
BEGIN
  PERFORM _nt_rec(10, 'the 36-probe battery as the owner: no mismatch with the literal',
    _nt_list(_nt_battery('owner')), 'none');
END $$;

-- ─── 2. the same battery as the principals who write notes ──────────────────

DO $$
BEGIN
  PERFORM _nt_rec(20, 'as a company administrator, through RLS: no mismatch',
    _nt_list(_nt_battery('admin')), 'none');
  PERFORM _nt_rec(21, 'as an editor (the notes page right), through RLS: no mismatch',
    _nt_list(_nt_battery('editor')), 'none');

  -- A viewer holds can_edit on no page. The page gate refuses before the
  -- constraint is asked, with a different SQLSTATE, and the refusal does not
  -- depend on whether the pairing is right.
  PERFORM _nt_rec(22, 'a viewer with a valid pairing: the page gate refuses (42501, no constraint)',
    _nt_try('viewer', _nt_insert_sql('viewer', 'sick', 'exclude_from_plan')), 'ERR 42501 -');
  PERFORM _nt_rec(23, 'a viewer with a wrong pairing: still the page gate, not the CHECK',
    _nt_try('viewer', _nt_insert_sql('viewer', 'sick', 'neutral')), 'ERR 42501 -');

  PERFORM _nt_rec(24, 'the browser''s hole, closed: sick + neutral from the Notizen screen',
    _nt_try('admin', _nt_insert_sql('admin', 'sick', 'neutral')),
    'ERR 23514 driver_notes_behavior_follows_type');
  PERFORM _nt_rec(25, 'the override that is a feature: general + must_include_in_plan',
    _nt_try('admin', _nt_insert_sql('admin', 'general', 'must_include_in_plan')), 'rows 1');
  PERFORM _nt_rec(26, 'and other + exclude_from_plan',
    _nt_try('admin', _nt_insert_sql('admin', 'other', 'exclude_from_plan')), 'rows 1');
  PERFORM _nt_rec(27, 'an effect outside the three is the vocabulary CHECK''s, on a free type too',
    _nt_try('admin', _nt_insert_sql('admin', 'general', 'always')),
    'ERR 23514 driver_notes_note_planning_behavior_check');
  PERFORM _nt_rec(28, 'no type at all is the column''s NOT NULL, not a CHECK (a CHECK lets NULL through)',
    _nt_try('admin', _nt_insert_sql('admin', NULL, 'neutral')), 'ERR 23502 -');
END $$;

-- ─── 3. the screen's edit, and a car deleted from under a note ──────────────
-- handleSubmit sends every column on an edit, `created_by` included.

DO $$
DECLARE
  v_free  constant text := 'a7100000-0000-4000-8000-000000000001';
  v_fixed constant text := 'a7100000-0000-4000-8000-000000000002';
BEGIN
  PERFORM _nt_rec(30, 'editing only the text of a valid note',
    _nt_try('editor', format($q$UPDATE driver_notes SET note_text = 'edited' WHERE id = %L$q$, v_fixed)), 'rows 1');

  PERFORM _nt_rec(31, 'the type alone, to a fixed type, with the old effect (a stale client): refused',
    _nt_try('admin', format($q$UPDATE driver_notes SET note_type = 'sick' WHERE id = %L$q$, v_free)),
    'ERR 23514 driver_notes_behavior_follows_type');

  PERFORM _nt_rec(32, 'the type and its effect together, as the screen sends them: accepted',
    _nt_try('admin', format($q$UPDATE driver_notes SET note_type = 'sick', note_planning_behavior = 'exclude_from_plan' WHERE id = %L$q$, v_free)),
    'rows 1');

  PERFORM _nt_rec(33, 'the effect alone on a fixed type (accident -> neutral): refused',
    _nt_try('admin', format($q$UPDATE driver_notes SET note_planning_behavior = 'neutral' WHERE id = %L$q$, v_fixed)),
    'ERR 23514 driver_notes_behavior_follows_type');

  PERFORM _nt_rec(34, 'the effect alone on a free type (general -> must_include_in_plan): accepted',
    _nt_try('admin', format($q$UPDATE driver_notes SET note_planning_behavior = 'must_include_in_plan' WHERE id = %L$q$, v_free)),
    'rows 1');

  PERFORM _nt_rec(35, 'a type unknown to the constraint, by an edit',
    _nt_try('admin', format($q$UPDATE driver_notes SET note_type = 'krank' WHERE id = %L$q$, v_free)),
    'ERR 23514 driver_notes_note_type_known');

  PERFORM _nt_rec(36, 'a delete is not asked anything',
    _nt_try('admin', format($q$DELETE FROM driver_notes WHERE id = %L$q$, v_fixed)), 'rows 1');

  -- ON DELETE SET NULL is an UPDATE of the note, and a CHECK is evaluated on it.
  -- A valid note passes; section 5 records what a legacy one does.
  PERFORM _nt_rec(37, 'deleting the car a VALID note names: the SET NULL update passes the CHECKs',
    _nt_try('owner', $q$DELETE FROM cars WHERE id = 'a7000000-0000-4000-8000-000000000001'$q$), 'rows 1');
END $$;

-- ─── 4. the partner path ────────────────────────────────────────────────────

-- 4a. exactly what partner_note_apply writes: the type, and note_behavior_for(type)
DO $$
DECLARE
  v_bad text[] := '{}';
  v_t   text;
  v_got text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['general','other','sick','vacation','off','blitzer','accident','kontrolle','breakdown','wait'] LOOP
    v_got := _nt_try('owner', _nt_insert_sql('owner', v_t, app_private.note_behavior_for(v_t)));
    IF v_got IS DISTINCT FROM 'rows 1' THEN
      v_bad := v_bad || format('%s with %s: %s', v_t, app_private.note_behavior_for(v_t), v_got);
    END IF;
  END LOOP;
  PERFORM _nt_rec(40, 'each of the ten, written with the behaviour the partner path derives, is admitted',
    _nt_list(v_bad, '; '), 'none');
END $$;

-- 4b. the door itself, as service_role, for a linked driver
CREATE OR REPLACE FUNCTION _nt_service_call(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_hint  text;
BEGIN
  BEGIN
    PERFORM _nt_as('service');
    EXECUTE p_sql INTO v_out;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
    v_out := 'ERR ' || v_state || ' ' || coalesce(nullif(v_hint, ''), '-');
  END;
  PERFORM _nt_reset();
  RETURN coalesce(v_out, '<null>');
END $$;

DO $$
DECLARE
  v_co    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_door  constant text := 'public.partner_note_submission_record(uuid,text,text,text,text,text,date,date,boolean,text,text,jsonb,text)';
  v_bad   text[] := '{}';
  v_t     text;
  v_resp  text;
  v_beh   text;
BEGIN
  IF current_setting('nt.skip_partner', true) = 'on' THEN
    RAISE NOTICE 'note-type-constraint: section 4b skipped (nt.skip_partner = on)';
    RETURN;
  END IF;

  IF to_regprocedure(v_door) IS NULL THEN
    RAISE EXCEPTION 'note-type-constraint: % does not exist. Section 4b is the door the partner app writes notes through; a rename must be followed here, not skipped', v_door;
  END IF;

  -- One confirmed link, as partner-note-intake.sql files it.
  EXECUTE format(
    'INSERT INTO partner_driver_links (id, company_id, partner, external_driver_id, driver_id, status, linked_at) '
    'VALUES (%L, %L, ''reidey'', ''nt-linked'', %L, ''linked'', now())',
    'a7200000-0000-4000-8000-000000000001', v_co, 'd0000000-0000-4000-8000-00000000000a');

  FOREACH v_t IN ARRAY ARRAY['general','other','sick','vacation','off','blitzer','accident','kontrolle','breakdown','wait'] LOOP
    -- Two statements: a subquery in the same SELECT as the call would read the
    -- snapshot from before the call wrote the note. The plate is this file's
    -- third car; the five incident types require one.
    v_resp := _nt_service_call(format(
      $q$SELECT public.partner_note_submission_record(%L, 'reidey', %L, 'nt-linked', %L, 'nt', NULL, NULL, false, NULL, NULL, NULL, 'B-NT 3003') ->> 'status'$q$,
      v_co, 'nt-door-' || v_t, v_t));

    SELECT n.note_planning_behavior INTO v_beh
      FROM partner_note_submissions s JOIN driver_notes n ON n.id = s.driver_note_id
     WHERE s.company_id = v_co AND s.external_submission_id = 'nt-door-' || v_t;

    IF v_resp IS DISTINCT FROM 'accepted' OR v_beh IS DISTINCT FROM app_private.note_behavior_for(v_t) THEN
      v_bad := v_bad || format('%s: status %s, stored %s, derived %s',
                               v_t, v_resp, coalesce(v_beh, 'no note'), app_private.note_behavior_for(v_t));
    END IF;
  END LOOP;

  PERFORM _nt_rec(41, 'the door, as service_role, files all ten for a linked driver and stores the derived behaviour',
    _nt_list(v_bad, '; '), 'none');
END $$;

-- ─── 5. NOT VALID: a row that already breaks the rule ───────────────────────
-- Built by dropping the pairing constraint, filing the row the way a database
-- from before this migration could hold it, and adding the constraint back
-- exactly as the catalogue spells it, NOT VALID. All in one subtransaction that
-- is rolled back, so the real constraint is untouched afterwards.

-- ALTER TABLE refuses a table with pending trigger events; fire any deferred ones first.
SET CONSTRAINTS ALL IMMEDIATE;

CREATE OR REPLACE FUNCTION _nt_legacy() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  c_bad  constant uuid := 'a7100000-0000-4000-8000-000000000009';
  c_car  constant uuid := 'a7000000-0000-4000-8000-000000000002';
  v_def  text;
  v      jsonb := '{}';
BEGIN
  BEGIN
    SELECT regexp_replace(pg_get_constraintdef(c.oid), ' NOT VALID$', '')
      INTO v_def
      FROM pg_constraint c
     WHERE c.conrelid = 'public.driver_notes'::regclass AND c.conname = 'driver_notes_behavior_follows_type';

    EXECUTE 'ALTER TABLE public.driver_notes DROP CONSTRAINT driver_notes_behavior_follows_type';
    INSERT INTO driver_notes (id, created_by, driver_id, company_id, note_text, note_type, note_planning_behavior, car_id)
    VALUES (c_bad, 'a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-00000000000a',
            'c0000000-0000-4000-8000-00000000000a', 'nt legacy', 'vacation', 'neutral', c_car);
    EXECUTE 'ALTER TABLE public.driver_notes ADD CONSTRAINT driver_notes_behavior_follows_type ' || v_def || ' NOT VALID';

    v := v || jsonb_build_object('state',
      (SELECT convalidated::text FROM pg_constraint
        WHERE conrelid = 'public.driver_notes'::regclass AND conname = 'driver_notes_behavior_follows_type'));
    v := v || jsonb_build_object('read',
      _nt_try('admin', format('SELECT note_type || ''/'' || note_planning_behavior FROM driver_notes WHERE id = %L', c_bad)));
    v := v || jsonb_build_object('new',
      _nt_try('admin', _nt_insert_sql('admin', 'sick', 'neutral')));
    v := v || jsonb_build_object('edit_text',
      _nt_try('admin', format($q$UPDATE driver_notes SET note_text = 'edited' WHERE id = %L$q$, c_bad)));
    v := v || jsonb_build_object('fix',
      _nt_try('admin', format($q$UPDATE driver_notes SET note_planning_behavior = 'exclude_from_plan' WHERE id = %L$q$, c_bad)));
    v := v || jsonb_build_object('delete_row',
      _nt_try('admin', format($q$DELETE FROM driver_notes WHERE id = %L$q$, c_bad)));
    v := v || jsonb_build_object('delete_car',
      _nt_try('owner', format($q$DELETE FROM cars WHERE id = %L$q$, c_car)));

    -- VALIDATE is not an INSERT; run it directly and read what it says.
    BEGIN
      EXECUTE 'ALTER TABLE public.driver_notes VALIDATE CONSTRAINT driver_notes_behavior_follows_type';
      v := v || jsonb_build_object('validate_dirty', 'validated');
    EXCEPTION WHEN check_violation THEN
      v := v || jsonb_build_object('validate_dirty', 'ERR ' || SQLSTATE);
    END;

    UPDATE driver_notes SET note_planning_behavior = 'exclude_from_plan' WHERE id = c_bad;
    EXECUTE 'ALTER TABLE public.driver_notes VALIDATE CONSTRAINT driver_notes_behavior_follows_type';
    v := v || jsonb_build_object('validate_clean',
      (SELECT convalidated::text FROM pg_constraint
        WHERE conrelid = 'public.driver_notes'::regclass AND conname = 'driver_notes_behavior_follows_type'));

    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'rolled back';
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN
    NULL;
  END;
  RETURN v;
END $$;

DO $$
DECLARE
  v jsonb := _nt_legacy();
BEGIN
  PERFORM _nt_rec(50, 'the constraint, re-added over a legacy row, is NOT VALID', v ->> 'state', 'false');
  PERFORM _nt_rec(51, 'the legacy row stays readable', v ->> 'read', 'vacation/neutral');
  PERFORM _nt_rec(52, 'a NEW wrong pairing is refused while the constraint is NOT VALID',
    v ->> 'new', 'ERR 23514 driver_notes_behavior_follows_type');
  PERFORM _nt_rec(53, 'RECORDED, NOT ENDORSED: editing only the text of the legacy row is refused',
    v ->> 'edit_text', 'ERR 23514 driver_notes_behavior_follows_type');
  PERFORM _nt_rec(54, 'fixing its effect is accepted', v ->> 'fix', 'rows 1');
  PERFORM _nt_rec(55, 'deleting it is never checked', v ->> 'delete_row', 'rows 1');
  PERFORM _nt_rec(56, 'RECORDED, NOT ENDORSED: deleting the car it names is refused (SET NULL is an UPDATE)',
    v ->> 'delete_car', 'ERR 23514 driver_notes_behavior_follows_type');
  PERFORM _nt_rec(57, 'VALIDATE fails while the row exists', v ->> 'validate_dirty', 'ERR 23514');
  PERFORM _nt_rec(58, 'and succeeds once it is fixed', v ->> 'validate_clean', 'true');

  -- The rollback must have restored the real constraint, validated.
  PERFORM _nt_rec(59, 'the real constraint is back and validated after the rolled-back scenario',
    (SELECT convalidated::text FROM pg_constraint
      WHERE conrelid = 'public.driver_notes'::regclass AND conname = 'driver_notes_behavior_follows_type'),
    'true');
END $$;

-- ─── 6. the mutation control ────────────────────────────────────────────────
-- Break one rule at a time, in a subtransaction that is rolled back, and count
-- what the battery catches. A battery that stayed at zero here would be reading
-- nothing. The counts are exact because the battery is: 36 probes, of which 16
-- are wrong pairings on a fixed type, 5 are strangers and 1 is a NULL type.

SET CONSTRAINTS ALL IMMEDIATE;

CREATE OR REPLACE FUNCTION _nt_mutations() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v     jsonb := '{}';
  v_msg text;
BEGIN
  -- A. the pairing constraint is gone: the 16 wrong pairings get through.
  BEGIN
    EXECUTE 'ALTER TABLE public.driver_notes DROP CONSTRAINT driver_notes_behavior_follows_type';
    v := v || jsonb_build_object('a', cardinality(_nt_battery('admin')));
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'back';
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN NULL; END;

  -- B. the type constraint is gone: the 5 strangers get through.
  BEGIN
    EXECUTE 'ALTER TABLE public.driver_notes DROP CONSTRAINT driver_notes_note_type_known';
    v := v || jsonb_build_object('b', cardinality(_nt_battery('admin')));
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'back';
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN NULL; END;

  -- C. drift: `kontrolle` is made to exclude instead of require. kontrolle with
  --    exclude is now admitted (1) and kontrolle with must_include is refused (1).
  BEGIN
    EXECUTE 'ALTER TABLE public.driver_notes DROP CONSTRAINT driver_notes_behavior_follows_type';
    EXECUTE 'ALTER TABLE public.driver_notes ADD CONSTRAINT driver_notes_behavior_follows_type CHECK ('
         || 'CASE note_type WHEN ''sick'' THEN note_planning_behavior = ''exclude_from_plan'' '
         || 'WHEN ''vacation'' THEN note_planning_behavior = ''exclude_from_plan'' '
         || 'WHEN ''off'' THEN note_planning_behavior = ''exclude_from_plan'' '
         || 'WHEN ''blitzer'' THEN note_planning_behavior = ''must_include_in_plan'' '
         || 'WHEN ''accident'' THEN note_planning_behavior = ''must_include_in_plan'' '
         || 'WHEN ''kontrolle'' THEN note_planning_behavior = ''exclude_from_plan'' '
         || 'WHEN ''breakdown'' THEN note_planning_behavior = ''must_include_in_plan'' '
         || 'WHEN ''wait'' THEN note_planning_behavior = ''must_include_in_plan'' ELSE true END) NOT VALID';
    v := v || jsonb_build_object('c', cardinality(_nt_battery('admin')));
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'back';
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN NULL; END;

  -- D. the rule written the obvious way, by asking the function the vocabulary
  --    already lives in. It means the same thing, so the battery is run without
  --    constraint names (the function folds case, so a stranger is refused by
  --    the pairing constraint instead of the type constraint: who speaks moves,
  --    what is decided does not). As the owner it changes nothing. As
  --    `authenticated` the constraint cannot be evaluated at all: the 35 probes
  --    that get as far as the CHECKs are refused 42501 (the 36th, a NULL type,
  --    never gets that far; NOT NULL is checked first).
  BEGIN
    EXECUTE 'ALTER TABLE public.driver_notes DROP CONSTRAINT driver_notes_behavior_follows_type';
    EXECUTE 'ALTER TABLE public.driver_notes ADD CONSTRAINT driver_notes_behavior_follows_type CHECK ('
         || 'note_planning_behavior = app_private.note_behavior_for(note_type) '
         || 'OR note_type IN (''general'', ''other'')) NOT VALID';
    v := v || jsonb_build_object('d_owner', cardinality(_nt_battery('owner', false)));
    v := v || jsonb_build_object('d_admin', cardinality(_nt_battery('admin', false)));

    -- and the sentence the screen would meet, for a note the rule allows
    BEGIN
      PERFORM _nt_as('admin');
      EXECUTE _nt_insert_sql('admin', 'general', 'neutral');
      v := v || jsonb_build_object('d_msg', 'accepted');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      v := v || jsonb_build_object('d_msg', v_msg);
    END;
    PERFORM _nt_reset();
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'back';
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN NULL; END;

  RETURN v;
END $$;

DO $$
DECLARE
  v_before text[] := _nt_battery('admin');
  v        jsonb  := _nt_mutations();
  v_after  text[] := _nt_battery('admin');
BEGIN
  PERFORM _nt_rec(60, 'before: the battery is clean against the real constraints',
    cardinality(v_before)::text, '0');
  PERFORM _nt_rec(61, 'A. pairing constraint dropped: the 16 wrong pairings get through',
    v ->> 'a', '16');
  PERFORM _nt_rec(62, 'B. type constraint dropped: the 5 strangers get through',
    v ->> 'b', '5');
  PERFORM _nt_rec(63, 'C. one type''s effect changed (drift): both of its pairings are caught',
    v ->> 'c', '2');
  PERFORM _nt_rec(64, 'D. pairing CHECK that calls note_behavior_for, battery run as the OWNER: nothing caught (the blind spot)',
    v ->> 'd_owner', '0');
  PERFORM _nt_rec(65, 'D. the same CHECK, battery run as authenticated: 35 of 36 writes refused',
    v ->> 'd_admin', '35');
  PERFORM _nt_rec(66, 'D. and what the screen would be told, for a note the rule allows',
    v ->> 'd_msg', 'permission denied for function note_behavior_for');
  PERFORM _nt_rec(67, 'after the rolled-back mutations: the battery is clean again',
    cardinality(v_after)::text, '0');
END $$;

-- ─── 7. the premises, and the standing guard ────────────────────────────────

DO $$
BEGIN
  PERFORM _nt_rec(70, 'no API role can use app_private (the premise of writing the rule as literals)',
    (SELECT string_agg(r || '=' || has_schema_privilege(r, 'app_private', 'USAGE'), ',' ORDER BY r)
       FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r),
    'anon=false,authenticated=false,service_role=false');

  PERFORM _nt_rec(71, 'and none can execute note_behavior_for',
    (SELECT string_agg(r || '=' || has_function_privilege(r, 'app_private.note_behavior_for(text)', 'EXECUTE'), ',' ORDER BY r)
       FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r),
    'anon=false,authenticated=false,service_role=false');

  -- A CHECK that calls a function is a CHECK that needs the writing role to
  -- execute it. These two call none: their dependencies are the table's columns
  -- and built-in operators, never a pg_proc row.
  PERFORM _nt_rec(72, 'neither of the two constraints depends on a function',
    coalesce((SELECT string_agg(c.conname || ' -> ' || d.refobjid::regprocedure::text, '; ')
                FROM pg_constraint c
                JOIN pg_depend d ON d.classid = 'pg_constraint'::regclass AND d.objid = c.oid
                                AND d.refclassid = 'pg_proc'::regclass
               WHERE c.conrelid = 'public.driver_notes'::regclass
                 AND c.conname IN ('driver_notes_note_type_known', 'driver_notes_behavior_follows_type')),
             'none'),
    'none');

  -- Whoever adds the next CHECK to this table: it runs as the writing role, so
  -- it may call only what that role may execute.
  PERFORM _nt_rec(73, 'no CHECK on driver_notes calls a function the authenticated role cannot execute',
    coalesce((SELECT string_agg(c.conname || ' -> ' || d.refobjid::regprocedure::text, '; ')
                FROM pg_constraint c
                JOIN pg_depend d ON d.classid = 'pg_constraint'::regclass AND d.objid = c.oid
                                AND d.refclassid = 'pg_proc'::regclass
               WHERE c.conrelid = 'public.driver_notes'::regclass AND c.contype = 'c'
                 AND NOT has_function_privilege('authenticated', d.refobjid, 'EXECUTE')),
             'none'),
    'none');
END $$;

-- ─── verdict ────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_failed int;
  v_total  int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT matched), count(*) INTO v_failed, v_total FROM _nt_out;
  IF v_failed > 0 THEN
    RAISE EXCEPTION 'note-type-constraint: % of % probes did not match (see the XX lines above)', v_failed, v_total;
  END IF;
  RAISE NOTICE 'note-type-constraint: all % probes matched', v_total;
END $$;

ROLLBACK;
