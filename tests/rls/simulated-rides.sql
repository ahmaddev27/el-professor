/*
  Simulated rides (migration 20261020110000).

  Runs after assertions.sql against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. One
  transaction, rolled back at the end.

    1. shape       both columns exist, boolean NOT NULL DEFAULT false; the three
                   trigger functions are SECURITY INVOKER and executable by no API role
    2. inherit     a trip takes the marker from its import whatever it sends, in
                   both directions (the marker cannot be left off, or forged on)
    3. fixed       neither marker changes after insert, for the owner too
    4. double count a driver-week (company, driver, Monday-Sunday) holds real or
                   simulated trips, never both; other weeks and drivers untouched
    5. caller      an administrator creates a simulated import and its trips as
                   `authenticated` (the triggers run as the caller and need no
                   app_private), and is refused the double count
    6. books       income, cash and tip rows are identical before and after

  Each refusal is told apart by SQLSTATE and HINT, so a probe that fails for
  another reason (a malformed statement, a missing privilege) is not a pass.
*/

\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION _sr_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_desc; END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _sr_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

CREATE OR REPLACE FUNCTION _sr_become(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _sr_reset();
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/* Runs one statement; returns its scalar, '<null>' or `ERR <sqlstate> <hint> <message>`. */
CREATE OR REPLACE FUNCTION _sr_do(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text; v_state text; v_msg text; v_hint text;
BEGIN
  BEGIN
    IF p_user IS NULL THEN PERFORM _sr_reset(); ELSE PERFORM _sr_become(p_user); END IF;
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_hint = PG_EXCEPTION_HINT;
    v_out := 'ERR ' || v_state || ' ' || coalesce(v_hint, '-') || ' ' || v_msg;
  END;
  PERFORM _sr_reset();
  RETURN v_out;
END $$;

-- ─── fixtures: company A is emptied of imports so the double-count rule starts clean ──

DELETE FROM fahrtenbuch_imports WHERE company_id IN
  ('c0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-00000000000b');

-- Company B holds a real import (the default), company A a simulated one.
INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by)
VALUES ('51000000-0000-4000-8000-0000000000b1', 'c0000000-0000-4000-8000-00000000000b', 9, 2026, 'real-b.xlsx',
        'b0000000-0000-4000-8000-000000000001');
INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by, is_simulated)
VALUES ('51000000-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-00000000000a', 9, 2026, 'SIMULIERT_a.xlsx',
        'a0000000-0000-4000-8000-000000000001', true);

-- ─── 1. shape ───────────────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _sr_ok('shape: is_simulated is boolean NOT NULL DEFAULT false on both tables',
    (SELECT count(*) = 2 FROM pg_attribute a
       JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attname = 'is_simulated' AND a.attnotnull AND a.atttypid = 'boolean'::regtype
        AND pg_get_expr(d.adbin, d.adrelid) = 'false'
        AND a.attrelid IN ('public.fahrtenbuch_imports'::regclass, 'public.fahrtenbuch_trips'::regclass)));
  PERFORM _sr_ok('shape: the four trigger functions are INVOKER and executable by no API role',
    (SELECT count(*) = 4 AND bool_and(NOT p.prosecdef)
            AND bool_and(NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
            AND bool_and(NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('fahrtenbuch_trips_keep_simulated', 'fahrtenbuch_imports_keep_simulated',
                          'fahrtenbuch_trips_refuse_double_count', 'saved_stundennachweise_keep_simulated')));
END $$;

-- ─── 2. inherit ─────────────────────────────────────────────────────────────

-- A trip that says it is real, in a simulated import ...
INSERT INTO fahrtenbuch_trips (id, company_id, import_id, trip_date, original_driver_name, assigned_driver_name, is_simulated)
VALUES ('51000000-0000-4000-8000-0000000000a2', 'c0000000-0000-4000-8000-00000000000a',
        '51000000-0000-4000-8000-0000000000a1', '2026-09-01', 'X', 'X', false);
-- ... and one that says it is simulated, in a real import.
INSERT INTO fahrtenbuch_trips (id, company_id, import_id, trip_date, original_driver_name, assigned_driver_name, is_simulated)
VALUES ('51000000-0000-4000-8000-0000000000b2', 'c0000000-0000-4000-8000-00000000000b',
        '51000000-0000-4000-8000-0000000000b1', '2026-09-01', 'X', 'X', true);
-- One that says nothing.
INSERT INTO fahrtenbuch_trips (id, company_id, import_id, trip_date, original_driver_name, assigned_driver_name)
VALUES ('51000000-0000-4000-8000-0000000000a3', 'c0000000-0000-4000-8000-00000000000a',
        '51000000-0000-4000-8000-0000000000a1', '2026-09-02', 'X', 'X');

DO $$
BEGIN
  PERFORM _sr_ok('inherit: a trip claiming to be real, in a simulated import, is simulated',
    (SELECT is_simulated FROM fahrtenbuch_trips WHERE id = '51000000-0000-4000-8000-0000000000a2'));
  PERFORM _sr_ok('inherit: a trip that says nothing, in a simulated import, is simulated',
    (SELECT is_simulated FROM fahrtenbuch_trips WHERE id = '51000000-0000-4000-8000-0000000000a3'));
  PERFORM _sr_ok('inherit: a trip claiming to be simulated, in a real import, is real',
    (SELECT NOT is_simulated FROM fahrtenbuch_trips WHERE id = '51000000-0000-4000-8000-0000000000b2'));
END $$;

-- ─── 3. fixed ───────────────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _sr_ok('fixed: a trip''s marker cannot be switched off, even by the owner',
    _sr_do(NULL, $q$UPDATE fahrtenbuch_trips SET is_simulated = false WHERE id = '51000000-0000-4000-8000-0000000000a2' RETURNING 'changed'$q$)
      LIKE 'ERR P0001 simulated_marker_fixed %');
  PERFORM _sr_ok('fixed: a trip''s marker cannot be switched on',
    _sr_do(NULL, $q$UPDATE fahrtenbuch_trips SET is_simulated = true WHERE id = '51000000-0000-4000-8000-0000000000b2' RETURNING 'changed'$q$)
      LIKE 'ERR P0001 simulated_marker_fixed %');
  PERFORM _sr_ok('fixed: an import''s marker cannot be switched off',
    _sr_do(NULL, $q$UPDATE fahrtenbuch_imports SET is_simulated = false WHERE id = '51000000-0000-4000-8000-0000000000a1' RETURNING 'changed'$q$)
      LIKE 'ERR P0001 simulated_marker_fixed %');
  PERFORM _sr_ok('fixed: an unrelated update of a simulated import still works',
    _sr_do(NULL, $q$UPDATE fahrtenbuch_imports SET notes = 'n' WHERE id = '51000000-0000-4000-8000-0000000000a1' RETURNING 'ok'$q$) = 'ok');
END $$;

-- ─── 4. double count: a driver-week is explained once ───────────────────────

-- The books of company A, which the generator reads and must never change.
INSERT INTO income (company_id, description, amount, type, driver_name, date) VALUES
  ('c0000000-0000-4000-8000-00000000000a', 'sr', 1647.08, 'umsatz', 'X', '2026-09-06'),
  ('c0000000-0000-4000-8000-00000000000a', 'sr',  523.37, 'bargeld', 'X', '2026-09-06'),
  ('c0000000-0000-4000-8000-00000000000a', 'sr',   41.50, 'trinkgeld', 'X', '2026-09-06');
CREATE TEMP TABLE _sr_books AS SELECT type, driver_name, amount FROM income WHERE company_id = 'c0000000-0000-4000-8000-00000000000a';

-- 2026-09-01 is a Tuesday: its week runs from Monday 2026-08-31 to Sunday 2026-09-06.
INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by)
VALUES ('51000000-0000-4000-8000-0000000000a9', 'c0000000-0000-4000-8000-00000000000a', 10, 2026, 'real-a.xlsx',
        'a0000000-0000-4000-8000-000000000001');
INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by, is_simulated)
VALUES ('51000000-0000-4000-8000-0000000000b9', 'c0000000-0000-4000-8000-00000000000b', 9, 2026, 'SIMULIERT_b.xlsx',
        'b0000000-0000-4000-8000-000000000001', true);

DO $$
BEGIN
  PERFORM _sr_ok('double count: a real trip into a driver-week holding simulated trips is refused (name compared case- and space-blind)',
    _sr_do(NULL, $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name)
      VALUES ('c0000000-0000-4000-8000-00000000000a', '51000000-0000-4000-8000-0000000000a9', '2026-09-03', '  x ', 'X') RETURNING 'in'$q$)
      LIKE 'ERR P0001 simulated_double_count_refused %');
  PERFORM _sr_ok('double count: the Sunday of that week is the same week',
    _sr_do(NULL, $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name)
      VALUES ('c0000000-0000-4000-8000-00000000000a', '51000000-0000-4000-8000-0000000000a9', '2026-09-06', 'X', 'X') RETURNING 'in'$q$)
      LIKE 'ERR P0001 simulated_double_count_refused %');
  PERFORM _sr_ok('double count: the Monday after is another week and is accepted',
    _sr_do(NULL, $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name)
      VALUES ('c0000000-0000-4000-8000-00000000000a', '51000000-0000-4000-8000-0000000000a9', '2026-09-07', 'X', 'X') RETURNING 'in'$q$) = 'in');
  PERFORM _sr_ok('double count: another driver in the same week is accepted',
    _sr_do(NULL, $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name)
      VALUES ('c0000000-0000-4000-8000-00000000000a', '51000000-0000-4000-8000-0000000000a9', '2026-09-03', 'Y', 'Y') RETURNING 'in'$q$) = 'in');
  PERFORM _sr_ok('double count: a simulated trip into the real week of the same driver in company B is refused',
    _sr_do(NULL, $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name)
      VALUES ('c0000000-0000-4000-8000-00000000000b', '51000000-0000-4000-8000-0000000000b9', '2026-09-02', 'X', 'X') RETURNING 'in'$q$)
      LIKE 'ERR P0001 simulated_double_count_refused %');
  PERFORM _sr_ok('double count: a company that holds real imports takes a simulated trip into a week with no real trips',
    _sr_do(NULL, $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name)
      VALUES ('c0000000-0000-4000-8000-00000000000b', '51000000-0000-4000-8000-0000000000b9', '2026-09-16', 'X', 'X') RETURNING is_simulated::text$q$) = 'true');
END $$;

-- ─── 5. caller ──────────────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _sr_ok('caller: company B administrator is refused the same double count as authenticated',
    _sr_do('b0000000-0000-4000-8000-000000000001'::uuid, $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name)
      VALUES ('c0000000-0000-4000-8000-00000000000b', '51000000-0000-4000-8000-0000000000b9', '2026-09-02', 'X', 'X') RETURNING 'in'$q$)
      LIKE 'ERR P0001 simulated_double_count_refused %');
  PERFORM _sr_ok('caller: company A administrator creates a simulated import and a trip as authenticated',
    _sr_do('a0000000-0000-4000-8000-000000000001'::uuid, $q$WITH i AS (
        INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by, is_simulated)
        VALUES ('c0000000-0000-4000-8000-00000000000a', 11, 2026, 'SIMULIERT_z.xlsx', 'a0000000-0000-4000-8000-000000000001', true)
        RETURNING id)
      INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name)
      SELECT 'c0000000-0000-4000-8000-00000000000a', id, '2026-11-02', 'Z', 'Z' FROM i RETURNING is_simulated::text$q$) = 'true');
END $$;

-- ─── 6. the books do not move ───────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _sr_ok('books: income, cash and tips of company A are exactly what they were before any simulated import or trip',
    (SELECT count(*) = 0 FROM (
       (SELECT type, driver_name, amount FROM income WHERE company_id = 'c0000000-0000-4000-8000-00000000000a'
        EXCEPT SELECT type, driver_name, amount FROM _sr_books)
       UNION ALL
       (SELECT type, driver_name, amount FROM _sr_books
        EXCEPT SELECT type, driver_name, amount FROM income WHERE company_id = 'c0000000-0000-4000-8000-00000000000a')) d)
    AND (SELECT sum(amount) FROM income WHERE company_id = 'c0000000-0000-4000-8000-00000000000a' AND type = 'umsatz') = 1647.08);
END $$;

-- Delete the simulated import of A: the driver-week is free for real trips again.
DELETE FROM fahrtenbuch_imports WHERE company_id = 'c0000000-0000-4000-8000-00000000000a' AND is_simulated;
DO $$
BEGIN
  PERFORM _sr_ok('double count: with the simulated import deleted, a real trip into that week is accepted again',
    _sr_do(NULL, $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name)
      VALUES ('c0000000-0000-4000-8000-00000000000a', '51000000-0000-4000-8000-0000000000a9', '2026-09-03', 'X', 'X') RETURNING 'in'$q$) = 'in');
END $$;

-- ─── 7. a saved Stundennachweis keeps the marker of the rides it came from ──

INSERT INTO company_planning_runs (id, company_id, month, year, import_id)
VALUES ('51000000-0000-4000-8000-0000000000c1', 'c0000000-0000-4000-8000-00000000000b', 9, 2026, '51000000-0000-4000-8000-0000000000b9'),
       ('51000000-0000-4000-8000-0000000000c2', 'c0000000-0000-4000-8000-00000000000b', 8, 2026, '51000000-0000-4000-8000-0000000000b1');
INSERT INTO saved_stundennachweise (id, company_id, driver_id, driver_name, month, year, source_run_id, is_simulated)
VALUES ('51000000-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-00000000000b', 'd0000000-0000-4000-8000-00000000000b', 'X', 9, 2026,
        '51000000-0000-4000-8000-0000000000c1', false),
       ('51000000-0000-4000-8000-0000000000d2', 'c0000000-0000-4000-8000-00000000000b', 'd0000000-0000-4000-8000-00000000000b', 'X', 8, 2026,
        '51000000-0000-4000-8000-0000000000c2', false);

DO $$
BEGIN
  PERFORM _sr_ok('saved: a record saved from a simulated run is simulated, whatever the insert said',
    (SELECT is_simulated FROM saved_stundennachweise WHERE id = '51000000-0000-4000-8000-0000000000d1'));
  PERFORM _sr_ok('saved: control, a record saved from a real run is not',
    (SELECT NOT is_simulated FROM saved_stundennachweise WHERE id = '51000000-0000-4000-8000-0000000000d2'));
  PERFORM _sr_ok('saved: once simulated it cannot be saved back to real',
    _sr_do(NULL, $q$UPDATE saved_stundennachweise SET is_simulated = false, source_run_id = NULL WHERE id = '51000000-0000-4000-8000-0000000000d1' RETURNING is_simulated::text$q$) = 'true');
  PERFORM _sr_ok('saved: a caller may mark a record more, not less',
    _sr_do(NULL, $q$UPDATE saved_stundennachweise SET is_simulated = true WHERE id = '51000000-0000-4000-8000-0000000000d2' RETURNING is_simulated::text$q$) = 'true');
END $$;

ROLLBACK;
