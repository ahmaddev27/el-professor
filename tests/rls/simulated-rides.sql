/*
  Simulated rides (migration 20261020100000).

  Runs after assertions.sql against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. One
  transaction, rolled back at the end.

    1. shape       both columns exist, boolean NOT NULL DEFAULT false; the three
                   trigger functions are SECURITY INVOKER and executable by no API role
    2. inherit     a trip takes the marker from its import whatever it sends, in
                   both directions (the marker cannot be left off, or forged on)
    3. fixed       neither marker changes after insert, for the owner too
    4. mixing      a company holds simulated rides or real ones, never both, in
                   both directions; deleting the simulated imports lifts it
    5. caller      an administrator creates a simulated import and its trips as
                   `authenticated` (the triggers run as the caller and need no
                   app_private), and is refused the mix

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

-- ─── fixtures: company A is emptied of imports so the mixing rule starts clean ──

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
  PERFORM _sr_ok('shape: the three trigger functions are INVOKER and executable by no API role',
    (SELECT count(*) = 3 AND bool_and(NOT p.prosecdef)
            AND bool_and(NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
            AND bool_and(NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('fahrtenbuch_trips_keep_simulated', 'fahrtenbuch_imports_keep_simulated',
                          'fahrtenbuch_imports_refuse_mixing')));
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

-- ─── 4. mixing ──────────────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _sr_ok('mixing: a real import into a company holding simulated rides is refused',
    _sr_do(NULL, $q$INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by)
      VALUES ('c0000000-0000-4000-8000-00000000000a', 10, 2026, 'real.xlsx', 'a0000000-0000-4000-8000-000000000001') RETURNING 'in'$q$)
      LIKE 'ERR P0001 simulated_mixing_refused %');
  PERFORM _sr_ok('mixing: a simulated import into a company holding real rides is refused',
    _sr_do(NULL, $q$INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by, is_simulated)
      VALUES ('c0000000-0000-4000-8000-00000000000b', 10, 2026, 'SIMULIERT_x.xlsx', 'b0000000-0000-4000-8000-000000000001', true) RETURNING 'in'$q$)
      LIKE 'ERR P0001 simulated_mixing_refused %');
  PERFORM _sr_ok('mixing: another simulated import into a simulated company is fine',
    _sr_do(NULL, $q$INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by, is_simulated)
      VALUES ('c0000000-0000-4000-8000-00000000000a', 10, 2026, 'SIMULIERT_2.xlsx', 'a0000000-0000-4000-8000-000000000001', true) RETURNING 'in'$q$) = 'in');
  PERFORM _sr_ok('mixing: another real import into a real company is fine',
    _sr_do(NULL, $q$INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by)
      VALUES ('c0000000-0000-4000-8000-00000000000b', 10, 2026, 'real2.xlsx', 'b0000000-0000-4000-8000-000000000001') RETURNING 'in'$q$) = 'in');
END $$;

-- ─── 5. caller ──────────────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _sr_ok('caller: company B''s administrator is refused a simulated import (company holds real rides)',
    _sr_do('b0000000-0000-4000-8000-000000000001'::uuid, $q$INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by, is_simulated)
      VALUES ('c0000000-0000-4000-8000-00000000000b', 11, 2026, 'SIMULIERT_y.xlsx', 'b0000000-0000-4000-8000-000000000001', true) RETURNING 'in'$q$)
      LIKE 'ERR P0001 simulated_mixing_refused %');
  PERFORM _sr_ok('caller: company A''s administrator creates a simulated import and a trip as authenticated',
    _sr_do('a0000000-0000-4000-8000-000000000001'::uuid, $q$WITH i AS (
        INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by, is_simulated)
        VALUES ('c0000000-0000-4000-8000-00000000000a', 11, 2026, 'SIMULIERT_z.xlsx', 'a0000000-0000-4000-8000-000000000001', true)
        RETURNING id)
      INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name)
      SELECT 'c0000000-0000-4000-8000-00000000000a', id, '2026-11-01', 'X', 'X' FROM i RETURNING is_simulated::text$q$) = 'true');
END $$;

-- Delete the simulated imports of A: the company may import real rides again.
DELETE FROM fahrtenbuch_imports WHERE company_id = 'c0000000-0000-4000-8000-00000000000a';
DO $$
BEGIN
  PERFORM _sr_ok('mixing: with the simulated imports deleted, a real import is accepted again',
    _sr_do(NULL, $q$INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by)
      VALUES ('c0000000-0000-4000-8000-00000000000a', 12, 2026, 'real-again.xlsx', 'a0000000-0000-4000-8000-000000000001') RETURNING 'in'$q$) = 'in');
END $$;

ROLLBACK;
