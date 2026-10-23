/*
  A ninth review reason: an order time the importer cannot read (20261023170000).

  `Uhrzeit der Auftragsuebermittlung` is parsed into no column of
  `fahrtenbuch_trips`. It reaches `source_row_key`, which hashes it as TEXT,
  and `raw_data_json`, which copies it — and until this migration none of the
  eight values `fahrtenbuch_trips_review_check` admitted named that column, so
  a cell holding something that is not a timestamp was stored with
  `needs_review = false` and nothing anywhere saying its order time could not
  be read. `20260922100000`'s own rule is that such a row is "stored and
  flagged, not dropped"; the flag was the half that was missing.

  The CHECK had to be widened BEFORE any code could write the value, because a
  ninth value against the old constraint is refused and every import of a file
  holding one malformed cell would then have failed entirely — worse than the
  defect. That ordering is safe and is read out of `deploy/deploy.sh` rather
  than assumed: migrations are applied at its migration step and the bundle is
  swapped afterwards (`mv dist.new dist`), and a rollback leaves a widened
  CHECK with older code, which never writes the value.

  ## What each section says, and why it is not obvious

  0. The catalogue. The constraint exists under its own name, is a VALIDATED
     CHECK, admits exactly the nine values in the parser's canonical order, and
     still carries the `needs_review` pairing. Read out of
     `pg_get_constraintdef`, so a migration that widened the set by dropping
     the pairing — which would let the flag be false on a row that names a
     reason — fails here.

  1. The ninth value is accepted on an INSERT, and the eight old ones still
     are. Both halves matter: a widened set that had lost a value would pass a
     probe testing only the new one.

  2. The defect, reproduced. The constraint is narrowed back to the eight
     values of `20260922100000` and the same INSERT is run: refused, 23514, by
     the constraint's NAME. **`fahrtenbuch_trips` carries at least four other
     CHECKs that raise 23514** (`..._time_check`, `..._trip_status_check`,
     `..._currency_check`, `..._source_row_key_check`) plus the column-level
     ones, so a probe reading only the SQLSTATE would pass on the wrong wall.
     The original definition is then restored.

  3. What the widening did NOT loosen. `needs_review = false` beside a reason
     is still refused, `needs_review = true` beside an empty array is still
     refused, and a tenth value nobody writes is still refused — all by the
     same named constraint. The set is a contract in both directions:
     `src/utils/fahrtenbuchImportParser.test.ts` compares it with
     `REVIEW_REASONS` key for key, and a value the parser cannot produce is as
     much a defect as a missing one.

  4. The flag is written once and cannot be changed afterwards.
     `protect_fahrtenbuch_immutable_fields` lists both `needs_review` and
     `review_reasons`, and `fahrtenbuch_trips` has no UPDATE policy at all, so
     the reason is a record of what the import saw rather than a mutable note.
     Measured as a refusal here, and as the owner, because the trigger does not
     care who the caller is.

  5. Tenancy, unchanged, and the one clause a restatement loses:
     `fahrtenbuch_imports.imported_by` must equal `auth.uid()` on INSERT, and
     `fahrtenbuch_trips` is written under the tenant term plus
     `current_role_permits('documents', true)`. A viewer holds `can_edit`
     nowhere, so it reaches nothing; an administrator does. Not this change's
     subject, but this file inserts trips as a principal, so it says which
     principal and why rather than leaving it to be inferred.

  6. The mutation controls, which are what make sections 0 to 5 worth reading.

  ## What it does not claim

  Nothing about the 369 malformed rows on staging, which are NOT backfilled
  (they are the record of what was imported, both columns are immutable, and
  every one of them is `is_simulated`). Nothing about whether the parser writes
  the value — that is `fahrtenbuchImportParser.test.ts`, which also pins the
  three-row difference between "the parser cannot read it" and "a regular
  expression over the stored text cannot read it". Nothing about the rest of
  `20260922100000`'s derivation (fahrtenbuch-import.sql) or about tenancy and
  the role gate on trips in general (matrix.sql, permission-coverage.sql).

  Collect-then-raise: every probe is recorded and the file fails at the end, so
  one run answers everything instead of stopping at the first surprise. Runs
  inside BEGIN ... ROLLBACK, so the files after it see only the migrations and
  the seeds. Probe numbers are never reused.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _rr_out (
  n        integer PRIMARY KEY,
  label    text    NOT NULL,
  actual   text    NOT NULL,
  expected text    NOT NULL,
  matched  boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _rr_rec(p_n integer, p_label text, p_actual text, p_expected text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ok boolean := p_actual IS NOT DISTINCT FROM p_expected;
BEGIN
  INSERT INTO _rr_out VALUES (p_n, p_label, coalesce(p_actual, '<null>'), p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', coalesce(p_actual, '<null>');
  END IF;
END $$;

/*
  Become a principal for the rest of the current subtransaction. The plans go
  first: schema USAGE and function EXECUTE are resolved when a statement is
  planned, the owner runs every fixture, and a plan the owner cached would let
  every principal after it through (matrix.sql's `_mx_become` has the account).
*/
CREATE OR REPLACE FUNCTION _rr_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  EXECUTE 'DISCARD PLANS';
  IF p_user IS NULL THEN
    RETURN;                              -- the owner, for fixtures
  END IF;
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr',
                     '[{"method": "password", "timestamp": 1789416052}]', true);
  PERFORM set_config('request.jwt.claim.session_id', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE OR REPLACE FUNCTION _rr_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('app_private.support_write_context', '', true);
END $$;

/*
  Runs one statement as one principal in a subtransaction that is always rolled
  back, and says what happened:

      `rows N`                          a write, and how many rows it touched
      the scalar                        a SELECT
      `ERR <sqlstate> <constraint>`     a refusal, by the constraint's name
      `ERR <sqlstate> -`                ... or bare (row-level security, a
                                        missing privilege, a trigger's RAISE)

  Comparing by the constraint's NAME is the rule this file is built on:
  `fahrtenbuch_trips` carries several unrelated CHECKs that all raise 23514, so
  a probe reading the SQLSTATE alone would pass on the wrong wall.
*/
CREATE OR REPLACE FUNCTION _rr_try(p_user uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_con   text;
BEGIN
  BEGIN
    PERFORM _rr_as(p_user);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ010', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ010' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_con = CONSTRAINT_NAME;
      v_out := 'ERR ' || v_state || ' ' || coalesce(nullif(v_con, ''), '-');
  END;
  PERFORM _rr_reset();
  RETURN v_out;
END $$;

/** Insert one trip of company A carrying exactly these review reasons. */
CREATE OR REPLACE FUNCTION _rr_insert(p_user uuid, p_reasons text[], p_flag boolean DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN _rr_try(p_user, format(
    'INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, '
    'original_driver_name, assigned_driver_name, needs_review, review_reasons) '
    'VALUES (%L, %L, ''2026-08-02'', ''RR Fahrer'', ''RR Fahrer'', %L, %L::text[])',
    'c0000000-0000-4000-8000-00000000000a',
    'f9000000-0000-4000-8000-000000000001',
    coalesce(p_flag, cardinality(p_reasons) > 0),
    p_reasons));
END $$;

/** The admitted set, in the order the constraint's own text lists it. */
CREATE OR REPLACE FUNCTION _rr_admitted() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT string_agg(m[1], ',' ORDER BY ord)
    FROM pg_constraint c,
         regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g')
           WITH ORDINALITY AS t(m, ord)
   WHERE c.conrelid = 'public.fahrtenbuch_trips'::regclass
     AND c.conname = 'fahrtenbuch_trips_review_check'
$$;

/** Replace the constraint with an arbitrary admitted set, for the mutations. */
CREATE OR REPLACE FUNCTION _rr_set_admitted(p_values text[], p_pairing boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'ALTER TABLE public.fahrtenbuch_trips '
    'DROP CONSTRAINT fahrtenbuch_trips_review_check, '
    'ADD  CONSTRAINT fahrtenbuch_trips_review_check CHECK (%s review_reasons <@ %L::text[])',
    CASE WHEN p_pairing THEN 'needs_review = (cardinality(review_reasons) > 0) AND' ELSE '' END,
    p_values);
END $$;

-- ─── fixtures ───────────────────────────────────────────────────────────────
--
-- One import of company A. `imported_by` must equal `auth.uid()` on INSERT
-- (20260917130000's extra clause), so it is the seed's administrator and the
-- import is filed as that principal rather than as the owner.

DO $$
BEGIN
  PERFORM _rr_as('a0000000-0000-4000-8000-000000000001'::uuid);
  INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by, file_sha256)
  VALUES ('f9000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
          8, 2026, 'rr-a.xlsx', 'a0000000-0000-4000-8000-000000000001', repeat('9', 64));
  PERFORM _rr_reset();
END $$;

-- ─── 0. the catalogue ───────────────────────────────────────────────────────

DO $$
BEGIN
  -- `contype::text` and not a bare `contype`: the column is `"char"`, and
  -- `"char" || unknown` is ambiguous on this engine — measured, the kit
  -- answered `operator is not unique: "char" || unknown` on the first run.
  PERFORM _rr_rec(1, 'fahrtenbuch_trips_review_check exists and is a VALIDATED check',
    (SELECT contype::text || '/' || convalidated::text FROM pg_constraint
      WHERE conrelid = 'public.fahrtenbuch_trips'::regclass
        AND conname = 'fahrtenbuch_trips_review_check'),
    'c/true');

  -- Exactly nine, in the parser's canonical order. A tenth value nobody writes
  -- is as much a defect as a missing ninth: the set is the contract
  -- fahrtenbuchImportParser.test.ts compares with REVIEW_REASONS.
  PERFORM _rr_rec(2, 'it admits exactly the nine reasons, in the parser''s order',
    _rr_admitted(),
    'missing_trip_date,missing_start,unreadable_start,missing_end,unreadable_end,'
    || 'end_before_start,missing_driver,unknown_status,unreadable_order_transmission');

  -- The widening must not have cost the pairing. Without it needs_review could
  -- be false on a row that names a reason, which is the state the whole family
  -- of columns exists to make impossible.
  PERFORM _rr_rec(3, 'and it still pairs needs_review with the array''s cardinality',
    (SELECT (pg_get_constraintdef(oid) LIKE '%needs_review = (cardinality(review_reasons) > 0)%')::text
       FROM pg_constraint WHERE conrelid = 'public.fahrtenbuch_trips'::regclass
        AND conname = 'fahrtenbuch_trips_review_check'),
    'true');

  -- Both columns are protected after insert, and the table has no UPDATE
  -- policy. Together those are what make the flag a record rather than a note.
  PERFORM _rr_rec(4, 'both columns are still in the immutability trigger, and there is no UPDATE policy',
    (SELECT (prosrc LIKE '%OLD.review_reasons%IS DISTINCT FROM%NEW.review_reasons%')::text
            || '/' ||
            (prosrc LIKE '%OLD.needs_review%IS DISTINCT FROM%NEW.needs_review%')::text
       FROM pg_proc WHERE oid = 'public.protect_fahrtenbuch_immutable_fields()'::regprocedure)
      || '/' ||
      (SELECT count(*)::text FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'fahrtenbuch_trips' AND cmd = 'UPDATE'),
    'true/true/0');

  -- No stored row carries the new reason: the migration widens what is allowed
  -- and writes nothing. The 369 malformed staging rows are deliberately not
  -- backfilled.
  PERFORM _rr_rec(5, 'the migration backfilled nothing',
    (SELECT count(*)::text FROM fahrtenbuch_trips
      WHERE 'unreadable_order_transmission' = ANY (review_reasons)), '0');
END $$;

-- ─── 1. the ninth value is accepted, and the eight old ones still are ───────

DO $$
DECLARE
  co_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
  r        text;
  v_bad    text := '';
BEGIN
  PERFORM _rr_rec(6, 'a trip may be stored flagged unreadable_order_transmission',
    _rr_insert(co_admin, ARRAY['unreadable_order_transmission']), 'rows 1');

  -- Each old reason on its own, so a widening that dropped one fails here
  -- rather than on the next import of an incomplete file.
  FOREACH r IN ARRAY ARRAY['missing_trip_date', 'missing_start', 'unreadable_start',
                           'missing_end', 'unreadable_end', 'end_before_start',
                           'missing_driver', 'unknown_status'] LOOP
    IF _rr_insert(co_admin, ARRAY[r]) IS DISTINCT FROM 'rows 1' THEN
      v_bad := v_bad || r || ' ';
    END IF;
  END LOOP;
  -- `none` rather than NULL on both sides: `_rr_out.expected` is NOT NULL, so
  -- a NULL expectation would make the probe raise instead of record, and a
  -- probe that cannot record cannot fail.
  PERFORM _rr_rec(7, 'and every one of the eight older reasons still is',
    coalesce(nullif(btrim(v_bad), ''), 'none'), 'none');

  -- Alongside others, which is how it actually arrives: a row whose order time
  -- is unreadable usually has readable start and end times and may be missing
  -- a driver as well.
  PERFORM _rr_rec(8, 'and beside other reasons, in the parser''s canonical order',
    _rr_insert(co_admin, ARRAY['missing_driver', 'unknown_status', 'unreadable_order_transmission']),
    'rows 1');

  PERFORM _rr_rec(9, 'an unflagged trip is still the ordinary case',
    _rr_insert(co_admin, ARRAY[]::text[]), 'rows 1');
END $$;

-- ─── 2. the defect, reproduced ──────────────────────────────────────────────
-- The constraint is narrowed back to 20260922100000's eight values and the
-- same INSERT is run. This is the measurement the migration's header rests on
-- — "an import of a file holding one malformed cell would fail entirely" —
-- taken here rather than quoted. Compared by the constraint's NAME.

DO $$
DECLARE
  co_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_was    text;
BEGIN
  v_was := _rr_admitted();
  PERFORM _rr_set_admitted(ARRAY['missing_trip_date', 'missing_start', 'unreadable_start',
                                 'missing_end', 'unreadable_end', 'end_before_start',
                                 'missing_driver', 'unknown_status']);

  PERFORM _rr_rec(10, 'against the eight-value CHECK the ninth reason is refused, by name',
    _rr_insert(co_admin, ARRAY['unreadable_order_transmission']),
    'ERR 23514 fahrtenbuch_trips_review_check');

  -- The row the real file produces: an unreadable order time beside reasons
  -- the old set DID admit. The whole INSERT is refused, which is why the CHECK
  -- had to be widened before any code could write the value.
  PERFORM _rr_rec(11, 'and so is a row that merely MENTIONS it beside admitted reasons',
    _rr_insert(co_admin, ARRAY['missing_driver', 'unreadable_order_transmission']),
    'ERR 23514 fahrtenbuch_trips_review_check');

  PERFORM _rr_rec(12, 'not even as the table owner, because it is a constraint and not a policy',
    _rr_insert(NULL, ARRAY['unreadable_order_transmission']),
    'ERR 23514 fahrtenbuch_trips_review_check');

  PERFORM _rr_set_admitted(ARRAY['missing_trip_date', 'missing_start', 'unreadable_start',
                                 'missing_end', 'unreadable_end', 'end_before_start',
                                 'missing_driver', 'unknown_status',
                                 'unreadable_order_transmission']);
  PERFORM _rr_rec(13, 'and the nine values are back for the sections below', _rr_admitted(), v_was);
END $$;

-- ─── 3. what the widening did NOT loosen ────────────────────────────────────

DO $$
DECLARE co_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _rr_rec(14, 'a reason with needs_review false is still refused',
    _rr_insert(co_admin, ARRAY['unreadable_order_transmission'], false),
    'ERR 23514 fahrtenbuch_trips_review_check');

  PERFORM _rr_rec(15, 'and needs_review true with no reason at all',
    _rr_insert(co_admin, ARRAY[]::text[], true),
    'ERR 23514 fahrtenbuch_trips_review_check');

  -- A tenth value nobody writes. The set is a contract in both directions, and
  -- this is the probe that fails if a future migration replaces the array with
  -- something open-ended to "make room".
  PERFORM _rr_rec(16, 'and a tenth value no parser produces',
    _rr_insert(co_admin, ARRAY['unreadable_order_transmission', 'unreadable_pickup']),
    'ERR 23514 fahrtenbuch_trips_review_check');

  PERFORM _rr_rec(17, 'and NULL is not an empty array: the column is NOT NULL',
    _rr_try(co_admin,
      'INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, '
      'assigned_driver_name, needs_review, review_reasons) VALUES ('
      '''c0000000-0000-4000-8000-00000000000a'', ''f9000000-0000-4000-8000-000000000001'', '
      '''2026-08-02'', ''RR Fahrer'', ''RR Fahrer'', false, NULL)'),
    'ERR 23502 -');
END $$;

-- ─── 4. the flag is written once ────────────────────────────────────────────
-- `protect_fahrtenbuch_immutable_fields` lists both columns, so the reason is
-- a record of what the import saw and not a note anyone can revise. There is
-- no UPDATE policy either (probe 4), so a client cannot reach the statement at
-- all; this section measures the trigger, as the OWNER, because the trigger
-- does not care who the caller is — which is also why the 369 malformed rows
-- on staging cannot be backfilled by accident.

INSERT INTO fahrtenbuch_trips (id, company_id, import_id, trip_date,
                               original_driver_name, assigned_driver_name,
                               needs_review, review_reasons)
VALUES ('f9000000-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-00000000000a',
        'f9000000-0000-4000-8000-000000000001', '2026-08-03', 'RR Fahrer', 'RR Fahrer',
        true, ARRAY['unreadable_order_transmission']::text[]);

DO $$
BEGIN
  PERFORM _rr_rec(18, 'the stored row carries the reason and the flag',
    (SELECT needs_review::text || '/' || array_to_string(review_reasons, ',')
       FROM fahrtenbuch_trips WHERE id = 'f9000000-0000-4000-8000-0000000000a1'),
    'true/unreadable_order_transmission');

  PERFORM _rr_rec(19, 'clearing the reason afterwards is refused by the immutability trigger',
    _rr_try(NULL,
      'UPDATE fahrtenbuch_trips SET needs_review = false, review_reasons = ARRAY[]::text[] '
      'WHERE id = ''f9000000-0000-4000-8000-0000000000a1'''),
    'ERR P0001 -');

  PERFORM _rr_rec(20, 'and so is adding one to a row that was stored clean',
    _rr_try(NULL,
      'UPDATE fahrtenbuch_trips SET needs_review = true, '
      'review_reasons = ARRAY[''unreadable_order_transmission'']::text[] '
      'WHERE id = ''f9000000-0000-4000-8000-0000000000a1'''),
    'ERR P0001 -');

  PERFORM _rr_rec(21, 'so the row is exactly as it was stored',
    (SELECT needs_review::text || '/' || array_to_string(review_reasons, ',')
       FROM fahrtenbuch_trips WHERE id = 'f9000000-0000-4000-8000-0000000000a1'),
    'true/unreadable_order_transmission');
END $$;

-- ─── 5. tenancy and the role gate, unchanged ────────────────────────────────
-- Not this change's subject, but this file writes trips as a principal, so it
-- says which principal and why. `fahrtenbuch_trips_insert` is the tenant term
-- AND `current_role_permits('documents', true)`, both in WITH CHECK — and an
-- INSERT is the one command where a refused WITH CHECK does RAISE, so these
-- are 42501 and not `rows 0`.

DO $$
BEGIN
  PERFORM _rr_rec(22, 'a viewer, holding can_edit on no page, cannot store a flagged trip',
    _rr_insert('a0000000-0000-4000-8000-000000000003'::uuid,
               ARRAY['unreadable_order_transmission']),
    'ERR 42501 -');

  PERFORM _rr_rec(23, 'nor can an administrator of the other company, into this one''s import',
    _rr_insert('b0000000-0000-4000-8000-000000000001'::uuid,
               ARRAY['unreadable_order_transmission']),
    'ERR 42501 -');

  -- The clause a restatement of the tenancy predicate loses: the import is the
  -- artefact the whole payroll chain hangs off, so its filer is named.
  PERFORM _rr_rec(24, 'and an import may still only be filed in the caller''s own name',
    _rr_try('a0000000-0000-4000-8000-000000000001'::uuid,
      'INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by, file_sha256) '
      'VALUES (''c0000000-0000-4000-8000-00000000000a'', 9, 2026, ''rr-b.xlsx'', '
      '''a0000000-0000-4000-8000-000000000002'', ' || quote_literal(repeat('8', 64)) || ')'),
    'ERR 42501 -');
END $$;

-- ─── 6. the mutation controls ───────────────────────────────────────────────
--
-- Each one breaks a rule, re-runs the probes that depend on it, counts the
-- mismatches, and rolls the mutation back. Counting rather than eyeballing is
-- what makes sections 0 to 5 evidence: a probe that cannot fail proves nothing.

CREATE OR REPLACE FUNCTION _rr_battery() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_bad    integer := 0;
  co_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  -- the catalogue claim
  IF _rr_admitted() IS DISTINCT FROM
     'missing_trip_date,missing_start,unreadable_start,missing_end,unreadable_end,'
     || 'end_before_start,missing_driver,unknown_status,unreadable_order_transmission' THEN
    v_bad := v_bad + 1;
  END IF;

  -- the ninth value is accepted
  IF _rr_insert(co_admin, ARRAY['unreadable_order_transmission']) IS DISTINCT FROM 'rows 1' THEN
    v_bad := v_bad + 1;
  END IF;

  -- an old value is still accepted
  IF _rr_insert(co_admin, ARRAY['missing_driver']) IS DISTINCT FROM 'rows 1' THEN
    v_bad := v_bad + 1;
  END IF;

  -- the pairing still refuses a reason with the flag off
  IF _rr_insert(co_admin, ARRAY['unreadable_order_transmission'], false)
       IS DISTINCT FROM 'ERR 23514 fahrtenbuch_trips_review_check' THEN
    v_bad := v_bad + 1;
  END IF;

  -- and a tenth value is still refused
  IF _rr_insert(co_admin, ARRAY['unreadable_pickup'])
       IS DISTINCT FROM 'ERR 23514 fahrtenbuch_trips_review_check' THEN
    v_bad := v_bad + 1;
  END IF;

  -- and the role gate still refuses a viewer
  IF _rr_insert('a0000000-0000-4000-8000-000000000003'::uuid,
                ARRAY['unreadable_order_transmission']) IS DISTINCT FROM 'ERR 42501 -' THEN
    v_bad := v_bad + 1;
  END IF;

  RETURN v_bad;
END $$;

/*
  Each mutation runs inside a subtransaction that is rolled back by raising
  `ZZ011`, which is also what undoes the schema change. The COUNT is therefore
  assigned to a variable declared OUT HERE and recorded only after the handler
  has run: plpgsql variables are memory and survive the rollback, while
  anything `_rr_rec` inserted inside the block would go with it.

  `partner-submission-delete.sql` records calling its recorder inside each
  block and losing all three mutation rows to the rollback, so its run was
  green at 34 of 37 probes and the three missing were exactly the controls.
  That is why the verdict below asserts the probe COUNT first.
*/
DO $$
DECLARE
  v_m1 integer;
  v_m2 integer;
  v_m3 integer;
  v_m4 integer;
BEGIN
  PERFORM _rr_rec(25, 'control: against the real schema the battery has no mismatch',
    _rr_battery()::text, '0');

  -- M1. back to the eight values of 20260922100000 — the defect. Two move: the
  --     catalogue, and the insert of the ninth value. The old value, the
  --     pairing, the tenth value and the viewer are all unaffected, which is
  --     the point of having them in the battery.
  BEGIN
    PERFORM _rr_set_admitted(ARRAY['missing_trip_date', 'missing_start', 'unreadable_start',
                                   'missing_end', 'unreadable_end', 'end_before_start',
                                   'missing_driver', 'unknown_status']);
    v_m1 := _rr_battery();
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = 'rollback M1';
  EXCEPTION WHEN SQLSTATE 'ZZ011' THEN NULL;
  END;
  PERFORM _rr_rec(26, 'mutation M1 (the eight-value CHECK, the original defect) moves two of six probes',
    v_m1::text, '2');

  -- M2. the pairing dropped, the nine values kept. Only the pairing probe
  --     moves — to `rows 1` — so a widening that cost the pairing cannot pass
  --     unnoticed, which is what self-check 3 of the migration also guards.
  BEGIN
    PERFORM _rr_set_admitted(ARRAY['missing_trip_date', 'missing_start', 'unreadable_start',
                                   'missing_end', 'unreadable_end', 'end_before_start',
                                   'missing_driver', 'unknown_status',
                                   'unreadable_order_transmission'], false);
    v_m2 := _rr_battery();
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = 'rollback M2';
  EXCEPTION WHEN SQLSTATE 'ZZ011' THEN NULL;
  END;
  PERFORM _rr_rec(27, 'mutation M2 (the needs_review pairing dropped) moves one of six probes',
    v_m2::text, '1');

  -- M3. a TENTH value admitted. Two move: the catalogue, and the probe that
  --     requires an unknown reason to be refused. This is the control that
  --     stops the set being read as "at least these nine".
  BEGIN
    PERFORM _rr_set_admitted(ARRAY['missing_trip_date', 'missing_start', 'unreadable_start',
                                   'missing_end', 'unreadable_end', 'end_before_start',
                                   'missing_driver', 'unknown_status',
                                   'unreadable_order_transmission', 'unreadable_pickup']);
    v_m3 := _rr_battery();
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = 'rollback M3';
  EXCEPTION WHEN SQLSTATE 'ZZ011' THEN NULL;
  END;
  PERFORM _rr_rec(28, 'mutation M3 (a tenth value admitted) moves two of six probes',
    v_m3::text, '2');

  -- M4. the documents page gate removed from fahrtenbuch_trips_insert. Only
  --     the viewer moves, so the CHECK probes above are not quietly measuring
  --     the role gate, and the viewer probe is not vacuous.
  BEGIN
    EXECUTE 'DROP POLICY fahrtenbuch_trips_insert ON public.fahrtenbuch_trips';
    EXECUTE $p$CREATE POLICY fahrtenbuch_trips_insert ON public.fahrtenbuch_trips
                 FOR INSERT TO authenticated
                 WITH CHECK (company_id = (SELECT get_active_company_id()))$p$;
    v_m4 := _rr_battery();
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = 'rollback M4';
  EXCEPTION WHEN SQLSTATE 'ZZ011' THEN NULL;
  END;
  PERFORM _rr_rec(29, 'mutation M4 (the documents page gate dropped) moves one of six probes',
    v_m4::text, '1');

  PERFORM _rr_rec(30, 'control: after the four mutations are rolled back the battery is clean again',
    _rr_battery()::text, '0');
END $$;

-- ─── the verdict, all at once ───────────────────────────────────────────────

DO $$
DECLARE
  v_bad integer;
  r     record;
  v_msg text := '';
BEGIN
  -- A probe that never recorded cannot fail, so the count is asserted first.
  IF (SELECT count(*) FROM _rr_out) <> 30 THEN
    RAISE EXCEPTION 'review reason: % of 30 probes recorded — missing: %',
      (SELECT count(*) FROM _rr_out),
      (SELECT string_agg(n::text, ', ' ORDER BY n) FROM generate_series(1, 30) AS g(n)
        WHERE NOT EXISTS (SELECT 1 FROM _rr_out o WHERE o.n = g.n));
  END IF;

  SELECT count(*) INTO v_bad FROM _rr_out WHERE NOT matched;
  IF v_bad = 0 THEN
    RAISE NOTICE '── review reason: all % probes matched ──', (SELECT count(*) FROM _rr_out);
    RETURN;
  END IF;
  FOR r IN SELECT * FROM _rr_out WHERE NOT matched ORDER BY n LOOP
    v_msg := v_msg || format(E'\n  %s. %s\n     expected: %s\n     actual:   %s',
                             r.n, r.label, r.expected, r.actual);
  END LOOP;
  RAISE EXCEPTION 'review reason: % of % probes did not match:%',
    v_bad, (SELECT count(*) FROM _rr_out), v_msg;
END $$;

ROLLBACK;
