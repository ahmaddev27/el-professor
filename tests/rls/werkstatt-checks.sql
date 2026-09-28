/*
  The Werkstatt check week key (migration 20260928121500).

  Runs after assertions.sql against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it see
  the database as the seeds left it — including section 3, which thins the table
  and puts the rows back, and section 4, which drops the new unique index, seeds
  a colliding pair and rebuilds it.

  The kit's fixture is a --schema=public dump, so it carries the table and no
  rows; the two companies and five principals come from tests/rls/seed.sql. The
  cars and checks below are this file's own.

  The rule, written down so that a later change has to argue with it rather than
  with a constraint name: **one Werkstatt check per car per week**, where the week
  is the one `check_date` falls in, Monday to Sunday. That is the business week of
  CLAUDE.md ("a week belongs to the month containing its Monday"), and
  `date_trunc('week', check_date::timestamp)` returns that week's Monday.

  What is covered, in order:

    1. shape       the old UNIQUE (car_id, week_number, year) is gone under that
                   name and under any other; the new unique index exists, is
                   valid, and keys on the immutable expression; week_number and
                   year survive as NOT NULL descriptive columns; the collision
                   guard is invoker, pinned, and executable by no API role
    2. the rule    the review's January/February scenario is accepted, two checks
                   in one week are refused, two cars in one week are accepted,
                   the 29.12./01.01. week is one week, and a full 52 weeks of one
                   car all go in
    3. control     the OLD key, re-added to the very rows section 2 stored, is
                   refused — 52 rows, 5 distinct (week_number, year) pairs — and
                   is accepted again once the table holds one row per pair, so the
                   refusal is about the data and not about the statement
    4. guard       app_private.werkstatt_check_week_collisions() reports exactly
                   the car and Monday of a seeded pair and nothing when there is
                   none, and the unique index cannot be built while that pair
                   exists — the wall the migration's message explains
    5. untouched   the four tenant policies and both support-write triggers are
                   still on the table, and the indexed expression is immutable
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _wc_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

/*
  Run one statement and return 'ok' or `ERR <sqlstate>`. What a statement that
  succeeds wrote is KEPT; what a failed one wrote is rolled back with its
  subtransaction, which is what makes the refusal probes below safe to run
  inside one transaction.
*/
CREATE OR REPLACE FUNCTION _wc_try(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    RETURN 'ERR ' || v_state;
  END;
END $$;

/*
  One check for that car on that date, with the descriptive ordinals given, so a
  test can store the pair the old key would have refused. 'ERR no-car' rather
  than 'ok' when the car does not exist: an INSERT … SELECT that matches nothing
  reports success, and a probe that silently wrote no row would pass for the
  wrong reason.
*/
CREATE OR REPLACE FUNCTION _wc_insert(p_car uuid, p_date date, p_week int, p_year int)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
  v_rows  int;
BEGIN
  BEGIN
    INSERT INTO public.werkstatt_checks
      (car_id, week_number, year, check_date, status, notes, km_stand, created_by, company_id)
    SELECT c.id, p_week, p_year, p_date, 'positive', 'probe', 1000, c.created_by, c.company_id
      FROM public.cars c
     WHERE c.id = p_car;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RETURN 'ERR no-car';
    END IF;
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    RETURN 'ERR ' || v_state;
  END;
END $$;

-- ─── fixtures of this file ──────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.werkstatt_checks') IS NULL THEN
    RAISE EXCEPTION 'werkstatt-checks: public.werkstatt_checks does not exist — the fixture is not production''s public schema';
  END IF;
END $$;

INSERT INTO public.cars (id, kennzeichen, created_by, company_id)
VALUES
  ('0a000000-0000-4000-8000-0000000000a1', 'WC-A 1', 'a0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-00000000000a'),
  ('0a000000-0000-4000-8000-0000000000a2', 'WC-A 2', 'a0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-00000000000a'),
  ('0a000000-0000-4000-8000-0000000000a3', 'WC-A 3', 'a0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-00000000000a'),
  ('0a000000-0000-4000-8000-0000000000a4', 'WC-A 4', 'a0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-00000000000a'),
  ('0b000000-0000-4000-8000-0000000000b1', 'WC-B 1', 'b0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-00000000000b')
ON CONFLICT (id) DO NOTHING;

SELECT _wc_ok('fixtures: five cars, and no Werkstatt check on any of them yet',
              (SELECT count(*) = 5 FROM public.cars WHERE kennzeichen LIKE 'WC-%')
              AND (SELECT count(*) = 0 FROM public.werkstatt_checks w
                     JOIN public.cars c ON c.id = w.car_id
                    WHERE c.kennzeichen LIKE 'WC-%'));

-- ─── 1. shape ───────────────────────────────────────────────────────────────

SELECT _wc_ok('1a the old UNIQUE (car_id, week_number, year) constraint is gone',
              NOT EXISTS (SELECT 1 FROM pg_constraint
                           WHERE conrelid = 'public.werkstatt_checks'::regclass
                             AND conname = 'werkstatt_checks_car_id_week_number_year_key'));

SELECT _wc_ok('1b and no unique index keys on those three columns under any other name',
              NOT EXISTS (SELECT 1 FROM pg_index i
                           WHERE i.indrelid = 'public.werkstatt_checks'::regclass
                             AND i.indisunique
                             AND pg_get_indexdef(i.indexrelid) LIKE '%(car\_id, week\_number, year)%'));

SELECT _wc_ok('1c werkstatt_checks_car_week_key is a valid unique index on the table',
              EXISTS (SELECT 1 FROM pg_index i
                       WHERE i.indexrelid = 'public.werkstatt_checks_car_week_key'::regclass
                         AND i.indrelid   = 'public.werkstatt_checks'::regclass
                         AND i.indisunique AND i.indisvalid));

SELECT _wc_ok('1d and it keys on (car_id, date_trunc(''week'', check_date::timestamp))',
              strpos(pg_get_indexdef('public.werkstatt_checks_car_week_key'::regclass), 'car_id') > 0
              AND strpos(pg_get_indexdef('public.werkstatt_checks_car_week_key'::regclass), 'date_trunc(''week''') > 0
              AND strpos(pg_get_indexdef('public.werkstatt_checks_car_week_key'::regclass), 'check_date') > 0
              -- the timestamptz overload is STABLE and could not be indexed at
              -- all, which is what the cast in the migration is for
              AND strpos(pg_get_indexdef('public.werkstatt_checks_car_week_key'::regclass),
                         'timestamp without time zone') > 0);

SELECT _wc_ok('1e week_number and year survive, NOT NULL, as descriptive ordinals',
              (SELECT count(*) = 2 FROM pg_attribute
                WHERE attrelid = 'public.werkstatt_checks'::regclass
                  AND attname IN ('week_number', 'year')
                  AND attnotnull AND NOT attisdropped));

SELECT _wc_ok('1f the collision guard is plpgsql, SECURITY INVOKER and search_path-pinned',
              (SELECT l.lanname = 'plpgsql' AND NOT p.prosecdef
                      AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                                   WHERE cfg LIKE 'search\_path=%')
                 FROM pg_proc p
                 JOIN pg_language l ON l.oid = p.prolang
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'app_private'
                  AND p.proname = 'werkstatt_check_week_collisions'));

SELECT _wc_ok('1g no API role may execute the collision guard, and PUBLIC holds no default grant',
              NOT has_function_privilege('anon', 'app_private.werkstatt_check_week_collisions()', 'EXECUTE')
              AND NOT has_function_privilege('authenticated', 'app_private.werkstatt_check_week_collisions()', 'EXECUTE')
              AND NOT has_function_privilege('service_role', 'app_private.werkstatt_check_week_collisions()', 'EXECUTE')
              -- a NULL acl is the built-in default, which grants EXECUTE to
              -- PUBLIC; it is the state a plain DROP + CREATE would restore
              AND (SELECT p.proacl IS NOT NULL
                          AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                                           WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                     FROM pg_proc p
                     JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'app_private'
                      AND p.proname = 'werkstatt_check_week_collisions'));

SELECT _wc_ok('1h and no API role can reach app_private at all',
              NOT has_schema_privilege('anon', 'app_private', 'USAGE')
              AND NOT has_schema_privilege('authenticated', 'app_private', 'USAGE')
              AND NOT has_schema_privilege('service_role', 'app_private', 'USAGE'));

-- ─── 2. the rule: one check per car per week ─────────────────────────────────

-- The review's scenario, in its own words: week 1 of January, then week 1 of
-- February. Both are (car, 1, 2026), so the old key refused the second one and
-- left the feature dead for that car for the rest of the year. 2b IS THE
-- ASSERTION THAT FAILS BEFORE THIS MIGRATION AND PASSES AFTER IT.
SELECT _wc_ok('2a week 1 of January is accepted',
              _wc_insert('0a000000-0000-4000-8000-0000000000a1', '2026-01-05', 1, 2026) = 'ok');
SELECT _wc_ok('2b week 1 of February is accepted too, although the old key called it the same row',
              _wc_insert('0a000000-0000-4000-8000-0000000000a1', '2026-02-02', 1, 2026) = 'ok');

-- and the rule that must survive: the same week twice is still one check. The
-- next date is the Sunday of that Monday, so both are one business week and one
-- date_trunc('week') value.
SELECT _wc_ok('2c a second check in the same week is refused (23505)',
              _wc_insert('0a000000-0000-4000-8000-0000000000a1', '2026-02-08', 2, 2026) = 'ERR 23505');
SELECT _wc_ok('2d the Monday itself is refused a second time as well, whatever ordinals are written beside it',
              _wc_insert('0a000000-0000-4000-8000-0000000000a1', '2026-02-02', 4, 2099) = 'ERR 23505');

-- the key is per car, not per company or per fleet
SELECT _wc_ok('2e another car of the same company may be checked in that week',
              _wc_insert('0a000000-0000-4000-8000-0000000000a2', '2026-02-04', 1, 2026) = 'ok');
SELECT _wc_ok('2f and a car of another company as well',
              _wc_insert('0b000000-0000-4000-8000-0000000000b1', '2026-02-04', 1, 2026) = 'ok');

-- the year boundary the modal used to mislabel: 29.12.2025 is a Monday and
-- 01.01.2026 belongs to that same week
SELECT _wc_ok('2g 29.12.2025 is accepted',
              _wc_insert('0a000000-0000-4000-8000-0000000000a3', '2025-12-29', 5, 2025) = 'ok');
SELECT _wc_ok('2h 01.01.2026 is that same week and is refused, although it carries the other year',
              _wc_insert('0a000000-0000-4000-8000-0000000000a3', '2026-01-01', 5, 2026) = 'ERR 23505');
SELECT _wc_ok('2i 05.01.2026 is the next week and is accepted',
              _wc_insert('0a000000-0000-4000-8000-0000000000a3', '2026-01-05', 1, 2026) = 'ok');

-- a full year of weekly checks for one car: 52 Mondays, 52 rows. Under the old
-- key 47 of these 52 inserts were refused (measured; see the migration header).
DO $$
DECLARE
  v_n    int;
  v_fail int := 0;
  v_date date;
  v_res  text;
BEGIN
  FOR v_n IN 0 .. 51 LOOP
    v_date := DATE '2026-01-05' + (v_n * 7);
    -- week_number cycles 1..5 the way a month ordinal does, so these are exactly
    -- the rows section 3 re-offers to the old key.
    v_res := _wc_insert('0a000000-0000-4000-8000-0000000000a4', v_date, (v_n % 5) + 1, 2026);
    IF v_res <> 'ok' THEN
      v_fail := v_fail + 1;
      RAISE WARNING 'week of % refused: %', v_date, v_res;
    END IF;
  END LOOP;
  IF v_fail > 0 THEN
    RAISE EXCEPTION 'FAIL: 2j % of 52 weekly checks were refused — the cap is still there', v_fail;
  END IF;
  RAISE NOTICE 'ok  2j 52 weekly checks for one car all stored';
END $$;

SELECT _wc_ok('2k which is 52 rows for that car, one per week',
              (SELECT count(*) = 52 FROM public.werkstatt_checks
                WHERE car_id = '0a000000-0000-4000-8000-0000000000a4')
              AND (SELECT count(DISTINCT date_trunc('week', check_date::timestamp)) = 52
                     FROM public.werkstatt_checks
                    WHERE car_id = '0a000000-0000-4000-8000-0000000000a4'));

-- ─── 3. negative control: the old key, on the rows the new one accepts ──────

SELECT _wc_ok('3a those 52 rows hold only 5 distinct (week_number, year) pairs',
              (SELECT count(DISTINCT (week_number, year)) = 5
                 FROM public.werkstatt_checks
                WHERE car_id = '0a000000-0000-4000-8000-0000000000a4'));

SELECT _wc_ok('3b so the OLD key cannot be added back (23505) — the cap, restated as a control',
              _wc_try('ALTER TABLE public.werkstatt_checks '
                      || 'ADD CONSTRAINT _wc_old_key UNIQUE (car_id, week_number, year)') = 'ERR 23505');

/*
  The other half of the control: the statement itself is sound. Thinned down to
  one row per (car_id, week_number, year), the very same ALTER succeeds — so 3b
  measured the data and not a malformed statement. The rows go back afterwards;
  they can, because every one of them has its own week under the new key.
*/
DO $$
DECLARE
  v_res    text;
  v_before bigint;
  v_after  bigint;
BEGIN
  SELECT count(*) INTO v_before FROM public.werkstatt_checks;

  CREATE TEMP TABLE _wc_parked AS SELECT * FROM public.werkstatt_checks;

  DELETE FROM public.werkstatt_checks w
   USING (SELECT id,
                 row_number() OVER (PARTITION BY car_id, week_number, year
                                        ORDER BY check_date, id) AS rn
            FROM public.werkstatt_checks) d
   WHERE d.id = w.id AND d.rn > 1;

  v_res := _wc_try('ALTER TABLE public.werkstatt_checks '
                   || 'ADD CONSTRAINT _wc_old_key UNIQUE (car_id, week_number, year)');
  PERFORM _wc_ok('3c and it is accepted once one row per pair is left, so 3b was about the data',
                 v_res = 'ok');

  EXECUTE 'ALTER TABLE public.werkstatt_checks DROP CONSTRAINT _wc_old_key';

  INSERT INTO public.werkstatt_checks
  SELECT * FROM _wc_parked p
   WHERE NOT EXISTS (SELECT 1 FROM public.werkstatt_checks x WHERE x.id = p.id);

  SELECT count(*) INTO v_after FROM public.werkstatt_checks;
  PERFORM _wc_ok('3d every row is back, so the sections after this one read the same table',
                 v_after = v_before);

  DROP TABLE _wc_parked;
END $$;

SELECT _wc_ok('3e and the control constraint is not left behind',
              NOT EXISTS (SELECT 1 FROM pg_constraint
                           WHERE conrelid = 'public.werkstatt_checks'::regclass
                             AND conname = '_wc_old_key'));

-- ─── 4. the collision guard the migration refuses on ────────────────────────

SELECT _wc_ok('4a with the key in force the guard reports nothing',
              NOT EXISTS (SELECT 1 FROM app_private.werkstatt_check_week_collisions()));

DO $$
DECLARE
  v_car uuid := '0b000000-0000-4000-8000-0000000000b1';
  v_row record;
  v_n   int;
  v_res text;
BEGIN
  -- The index is the only thing stopping the pair, so it has to come off to
  -- create the state the migration's precheck exists for. It goes back below.
  EXECUTE 'DROP INDEX public.werkstatt_checks_car_week_key';

  -- 2f already stored 04.02.2026 for this car; 06.02. is the same week.
  PERFORM _wc_ok('4b two checks in one week can be seeded once the index is off',
                 _wc_insert(v_car, '2026-02-06', 1, 2026) = 'ok');

  SELECT count(*) INTO v_n FROM app_private.werkstatt_check_week_collisions();
  PERFORM _wc_ok('4c the guard reports exactly one colliding pair in the whole table', v_n = 1);

  SELECT * INTO v_row FROM app_private.werkstatt_check_week_collisions();
  PERFORM _wc_ok('4d naming that car, that week''s Monday and two checks',
                 v_row.car_id = v_car
                 AND v_row.week_start = DATE '2026-02-02'
                 AND v_row.check_count = 2);

  -- and the wall behind the message: the index cannot be built on this data, so
  -- a migration without the precheck would abort here instead of explaining.
  v_res := _wc_try('CREATE UNIQUE INDEX werkstatt_checks_car_week_key '
                   || 'ON public.werkstatt_checks (car_id, date_trunc(''week'', check_date::timestamp))');
  PERFORM _wc_ok('4e the unique index refuses to build while the pair exists (23505)',
                 v_res = 'ERR 23505');

  DELETE FROM public.werkstatt_checks
   WHERE car_id = v_car AND check_date = DATE '2026-02-06';

  PERFORM _wc_ok('4f and nothing collides once it is resolved',
                 NOT EXISTS (SELECT 1 FROM app_private.werkstatt_check_week_collisions()));

  EXECUTE 'CREATE UNIQUE INDEX werkstatt_checks_car_week_key '
       || 'ON public.werkstatt_checks (car_id, date_trunc(''week'', check_date::timestamp))';
END $$;

SELECT _wc_ok('4g the key is back, unique and valid',
              EXISTS (SELECT 1 FROM pg_index i
                       WHERE i.indexrelid = 'public.werkstatt_checks_car_week_key'::regclass
                         AND i.indisunique AND i.indisvalid));

-- ─── 5. what this migration must not have touched ────────────────────────────

SELECT _wc_ok('5a the four tenant policies of 20260917130000 are still on the table',
              (SELECT count(*) = 4 FROM pg_policy
                WHERE polrelid = 'public.werkstatt_checks'::regclass
                  AND polname IN ('werkstatt_checks_select', 'werkstatt_checks_insert',
                                  'werkstatt_checks_update', 'werkstatt_checks_delete')));

SELECT _wc_ok('5b and both support-write triggers (3.4a / 3.4c)',
              (SELECT count(*) = 2 FROM pg_trigger
                WHERE tgrelid = 'public.werkstatt_checks'::regclass
                  AND NOT tgisinternal
                  AND tgname IN ('refuse_read_only_context_write', 'record_support_write')));

SELECT _wc_ok('5c the indexed expression is immutable, and the timestamptz overload is not',
              (SELECT provolatile = 'i' FROM pg_proc
                WHERE oid = 'pg_catalog.date_trunc(text,timestamp)'::regprocedure)
              AND (SELECT provolatile = 's' FROM pg_proc
                    WHERE oid = 'pg_catalog.date_trunc(text,timestamptz)'::regprocedure));

ROLLBACK;
