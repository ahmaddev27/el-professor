/*
  Vehicle day plans: the races a single session cannot show (migration
  20261022140000).

  Named to sort AFTER vehicle-day-plans.sql: the runner stops at the first file
  that fails, this is the one that depends on dblink and on a second session, and
  the main file's verdict should be on the screen whatever this one does.

  Runs after seed.sql, against the same throwaway database as every other file,
  as supabase_admin. tests/rls/vehicle-day-plans.sql is one transaction and one
  session; a lock is only shown to work by something waiting on it, so this file
  opens two real sessions through dblink, as salary-cash.sql does for its
  receipts, and gives each its own transaction. The fixtures are therefore
  COMMITTED -- four plans of one vehicle, in company A in the year 2063, one
  month for each scenario -- and the last statement of the file removes them
  again, so the files after it see the database as the seeds left it.

  ── WHAT WENT WRONG, AND WHAT IS ASSERTED ────────────────────────────────────

  A reviewer of the migration found that the shift guard read its plan's status
  with no lock. vehicle_day_plan_confirm checks the plan's shifts for an
  overlap and for emptiness and then makes the plan final; a shift written
  while that confirmation was uncommitted read "draft", waited on the foreign
  key check, and landed in the plan after the confirmation committed:

      INSERT   a confirmed plan with two overlapping shifts of one vehicle
      DELETE   a confirmed plan with no shift at all (a DELETE has no foreign
               key check to wait on, so it did not even wait)

  Both are a confirmed plan that the confirmation had just certified was not
  there. The guard now reads the plan FOR KEY SHARE, which conflicts with the
  FOR UPDATE the confirmation takes, so the two take turns in either order and
  whichever comes second sees what the first did. Four scenarios, each with
  the writer second or first:

    R1  a shift is INSERTED while a confirmation is open   -> waits, then refused
    R2  a shift is DELETED  while a confirmation is open   -> waits, then refused
    R3  a shift is DELETED, and a confirmation begins      -> waits, then plan_empty
    R4  a shift is INSERTED, and a confirmation begins     -> waits, then vehicle_overlap

  R1 and R2 are the two that failed. R3 fails without the lock for the same reason
  (the delete is invisible to the confirmation until it commits). R4 passes with or
  without it, because the foreign key check already holds the row; it is here so
  that a change to the locking which breaks the other direction is seen.

  Whichever session came second COMMITS at the end of its scenario. Where it was
  refused its transaction is aborted and the commit is a rollback; where it was
  not (the fault) the commit makes the damage visible, and the last check of each
  scenario reads the plan back.

  "Waits" is asserted by what the server says, not by a sleep: the second
  session's backend must show wait_event_type = 'Lock' in pg_stat_activity within
  ten seconds. A refusal is asserted by the guard's HINT, which dblink carries in
  the text of the error (vehicle_day_plan_is_final): a machine word, not a sentence
  of one language.

  The file was run against the migration as shipped (all pass) and against the
  same migration with the lock taken out of parent_is_open (R1, R2 and R3 fail;
  R4 passes), which is the control.
*/

\set ON_ERROR_STOP on

-- ─── dblink ─────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'dblink') THEN
    CREATE SCHEMA IF NOT EXISTS _vdc_dblink;
    CREATE EXTENSION dblink WITH SCHEMA _vdc_dblink;
  END IF;
  PERFORM set_config('search_path',
    current_setting('search_path') || ', ' ||
    (SELECT quote_ident(n.nspname) FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'dblink'),
    false);
END $$;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _vdc_results (
  n        serial PRIMARY KEY,
  label    text   NOT NULL,
  expected text,
  actual   text,
  ok       boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _vdc_expect(p_label text, p_expected text, p_actual text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean := p_actual IS NOT DISTINCT FROM p_expected;
BEGIN
  INSERT INTO _vdc_results (label, expected, actual, ok) VALUES (p_label, p_expected, p_actual, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok   % [%]', p_label, p_actual;
  ELSE
    RAISE NOTICE 'DIFF % -- expected [%] got [%]', p_label, p_expected, p_actual;
  END IF;
END $$;

/* How a second session reaches this server. Where the server has a Unix socket
   (the supabase/postgres image) that is the database and the user and nothing
   else, exactly as salary-cash.sql connects; a server with no socket (a Windows
   build, which is what a local replica of this kit runs on) is reached over TCP
   on the address and port this session came in on. */
CREATE OR REPLACE FUNCTION _vdc_conninfo() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT format('dbname=%s user=supabase_admin', current_database())
         || CASE WHEN coalesce(current_setting('unix_socket_directories', true), '') = ''
                 THEN format(' host=%s port=%s', coalesce(host(inet_server_addr()), 'localhost'), current_setting('port'))
                 ELSE '' END
$$;

/* A session that is company A's administrator, inside its own transaction, in the
   role PostgREST would run it as. */
CREATE OR REPLACE FUNCTION _vdc_open(p_name text) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_pid integer;
BEGIN
  PERFORM dblink_connect(p_name, _vdc_conninfo());
  PERFORM dblink_exec(p_name, 'BEGIN');
  PERFORM * FROM dblink(p_name, format('SELECT set_config(%L, %L, true)', 'request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001')) AS t(v text);
  PERFORM * FROM dblink(p_name, format('SELECT set_config(%L, %L, true)', 'request.jwt.claim.role', 'authenticated')) AS t(v text);
  PERFORM * FROM dblink(p_name, format('SELECT set_config(%L, %L, true)', 'request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]')) AS t(v text);
  PERFORM dblink_exec(p_name, 'SET LOCAL ROLE authenticated');
  SELECT t.pid INTO v_pid FROM dblink(p_name, 'SELECT pg_backend_pid()') AS t(pid integer);
  RETURN v_pid;
END $$;

/* True when that backend is waiting on a lock, within p_seconds. */
CREATE OR REPLACE FUNCTION _vdc_waits(p_pid integer, p_seconds integer DEFAULT 10) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_tries integer := 0;
BEGIN
  WHILE v_tries < p_seconds * 20 LOOP
    IF EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.pid = p_pid AND a.wait_event_type = 'Lock') THEN
      RETURN true;
    END IF;
    PERFORM pg_sleep(0.05);
    v_tries := v_tries + 1;
  END LOOP;
  RETURN false;
END $$;

/* Waits for an asynchronous statement to finish and returns its error message,
   or its one text value, or '<still running>'. */
CREATE OR REPLACE FUNCTION _vdc_result(p_name text, p_seconds integer DEFAULT 20) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_tries integer := 0;
  v_value text;
  v_err   text;
BEGIN
  WHILE dblink_is_busy(p_name) = 1 AND v_tries < p_seconds * 20 LOOP
    PERFORM pg_sleep(0.05);
    v_tries := v_tries + 1;
  END LOOP;
  IF dblink_is_busy(p_name) = 1 THEN
    RETURN '<still running>';
  END IF;
  SELECT t.v INTO v_value FROM dblink_get_result(p_name, false) AS t(v text);
  v_err := dblink_error_message(p_name);
  PERFORM * FROM dblink_get_result(p_name, false) AS t(v text);
  RETURN CASE WHEN v_err IS NOT NULL AND v_err <> 'OK' THEN 'ERROR ' || v_err ELSE coalesce(v_value, '<no value>') END;
END $$;

/* The statement that adds one shift of VDC-CAR to a plan of 2063, month p_month,
   on that month's 4th (the operating day), in the plan's hour 4 and 15-minute
   slots. Each scenario has a month of its own, because a month has one confirmed
   plan and the scenarios confirm. */
CREATE OR REPLACE FUNCTION _vdc_insert_sql(p_plan uuid, p_month integer, p_index integer, p_from integer, p_to integer) RETURNS text
LANGUAGE sql IMMUTABLE AS $body$
  SELECT format($f$INSERT INTO vehicle_day_shifts (company_id, plan_id, operating_date, vehicle, shift_index,
      start_position, end_position, starts_local, ends_local, minutes, day_type, is_holiday,
      expected_revenue_cents, expected_revenue_per_hour_cents, confidence, evidence_days)
    VALUES (%L, %L, %L, 'VDC-CAR', %s, %s, %s, %L, %L, %s, %s, false, 1000, 333, 'high', 5)$f$,
    'c0000000-0000-4000-8000-00000000000a', p_plan, d.day, p_index, p_from, p_to,
    to_char(d.day + make_interval(mins => 240 + p_from * 15), 'YYYY-MM-DD"T"HH24:MI'),
    to_char(d.day + make_interval(mins => 240 + p_to * 15), 'YYYY-MM-DD"T"HH24:MI'),
    (p_to - p_from) * 15,
    EXTRACT(ISODOW FROM d.day)::integer - 1)
    FROM (SELECT make_date(2063, p_month, 4) AS day) d
$body$;

CREATE OR REPLACE FUNCTION _vdc_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('vdc:' || p_what)::uuid $$;

/* A draft of company A in the month p_month of 2063, with one shift of VDC-CAR from 10:00 to 13:00. */
CREATE OR REPLACE FUNCTION _vdc_plan(p_what text, p_month integer) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_plan uuid := _vdc_id(p_what);
BEGIN
  INSERT INTO vehicle_day_plans (id, company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version)
  VALUES (v_plan, 'c0000000-0000-4000-8000-00000000000a', 2063, p_month, 4, 15, 'v');
  EXECUTE _vdc_insert_sql(v_plan, p_month, 0, 24, 36);
  RETURN v_plan;
END $$;

CREATE OR REPLACE FUNCTION _vdc_state(p_plan uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM vehicle_day_shifts s WHERE s.plan_id = p_plan)::text || '|' || p.status
    FROM vehicle_day_plans p WHERE p.id = p_plan
$$;

-- The fixtures are committed from here on, so the file starts from a clean slate
-- in case an earlier run of it was cut short.
DELETE FROM vehicle_day_plans WHERE company_id = 'c0000000-0000-4000-8000-00000000000a' AND year = 2063;

-- The four plans are created here, in a statement of their own: a second session
-- sees nothing a transaction has not committed, and a DO block is one transaction.
DO $$
BEGIN
  PERFORM _vdc_plan('r1', 5);
  PERFORM _vdc_plan('r2', 6);
  PERFORM _vdc_plan('r3', 7);
  PERFORM _vdc_plan('r4', 8);
END $$;

-- ─── R1. a shift is INSERTED while a confirmation is open ───────────────────

DO $$
DECLARE
  v_plan  uuid := _vdc_id('r1');
  v_pid_a integer;
  v_pid_b integer;
  v_wait  boolean;
  v_res   text;
  v_confirm text;
BEGIN
  v_pid_a := _vdc_open('vdc_r1_a');
  v_pid_b := _vdc_open('vdc_r1_b');

  SELECT t.r INTO v_confirm FROM dblink('vdc_r1_a',
    format('SELECT (public.vehicle_day_plan_confirm(%L) ->> ''success'')', v_plan)) AS t(r text);
  PERFORM _vdc_expect('R1: session A confirms the plan and keeps its transaction open', 'true', v_confirm);

  -- 11:30 to 14:30 overlaps the 10:00 to 13:00 shift the confirmation has just checked.
  PERFORM dblink_send_query('vdc_r1_b', _vdc_insert_sql(v_plan, 5, 1, 30, 42));
  v_wait := _vdc_waits(v_pid_b);
  PERFORM _vdc_expect('R1: session B, writing a shift into the plan, waits for the confirmation', 'true', v_wait::text);

  PERFORM dblink_exec('vdc_r1_a', 'COMMIT');
  v_res := _vdc_result('vdc_r1_b');
  PERFORM _vdc_expect('R1: …and is refused once the confirmation has committed, because the plan is final',
    'refused as final', CASE WHEN v_res LIKE 'ERROR%HINT:  vehicle_day_plan_is_final%' THEN 'refused as final' ELSE v_res END);

  PERFORM dblink_exec('vdc_r1_b', 'COMMIT');
  PERFORM dblink_disconnect('vdc_r1_a');
  PERFORM dblink_disconnect('vdc_r1_b');
  PERFORM _vdc_expect('R1: the confirmed plan holds exactly the shift it was confirmed with', '1|confirmed', _vdc_state(v_plan));
END $$;

-- ─── R2. a shift is DELETED while a confirmation is open ────────────────────

DO $$
DECLARE
  v_plan  uuid := _vdc_id('r2');
  v_pid_b integer;
  v_wait  boolean;
  v_res   text;
  v_confirm text;
BEGIN
  PERFORM _vdc_open('vdc_r2_a');
  v_pid_b := _vdc_open('vdc_r2_b');

  SELECT t.r INTO v_confirm FROM dblink('vdc_r2_a',
    format('SELECT (public.vehicle_day_plan_confirm(%L) ->> ''success'')', v_plan)) AS t(r text);
  PERFORM _vdc_expect('R2: session A confirms the plan and keeps its transaction open', 'true', v_confirm);

  PERFORM dblink_send_query('vdc_r2_b', format('DELETE FROM vehicle_day_shifts WHERE plan_id = %L', v_plan));
  v_wait := _vdc_waits(v_pid_b);
  PERFORM _vdc_expect('R2: session B, deleting the plan''s shift, waits for the confirmation', 'true', v_wait::text);

  PERFORM dblink_exec('vdc_r2_a', 'COMMIT');
  v_res := _vdc_result('vdc_r2_b');
  PERFORM _vdc_expect('R2: …and is refused once the confirmation has committed, because the plan is final',
    'refused as final', CASE WHEN v_res LIKE 'ERROR%HINT:  vehicle_day_plan_is_final%' THEN 'refused as final' ELSE v_res END);

  PERFORM dblink_exec('vdc_r2_b', 'COMMIT');
  PERFORM dblink_disconnect('vdc_r2_a');
  PERFORM dblink_disconnect('vdc_r2_b');
  PERFORM _vdc_expect('R2: the confirmed plan still has its shift (a confirmed plan with none is what plan_empty exists to prevent)',
    '1|confirmed', _vdc_state(v_plan));
END $$;

-- ─── R3. a shift is DELETED, and a confirmation begins ──────────────────────

DO $$
DECLARE
  v_plan  uuid := _vdc_id('r3');
  v_pid_a integer;
  v_wait  boolean;
  v_res   text;
BEGIN
  v_pid_a := _vdc_open('vdc_r3_a');
  PERFORM _vdc_open('vdc_r3_b');

  PERFORM dblink_exec('vdc_r3_b', format('DELETE FROM vehicle_day_shifts WHERE plan_id = %L', v_plan));

  PERFORM dblink_send_query('vdc_r3_a', format('SELECT (public.vehicle_day_plan_confirm(%L) ->> ''reason'')', v_plan));
  v_wait := _vdc_waits(v_pid_a);
  PERFORM _vdc_expect('R3: a confirmation that begins while a shift is being deleted waits for the delete', 'true', v_wait::text);

  PERFORM dblink_exec('vdc_r3_b', 'COMMIT');
  v_res := _vdc_result('vdc_r3_a');
  PERFORM _vdc_expect('R3: …and, once the delete has committed, finds the plan empty', 'plan_empty', v_res);

  PERFORM dblink_exec('vdc_r3_a', 'COMMIT');
  PERFORM dblink_disconnect('vdc_r3_a');
  PERFORM dblink_disconnect('vdc_r3_b');
  PERFORM _vdc_expect('R3: the plan is still a draft, with no shift', '0|draft', _vdc_state(v_plan));
END $$;

-- ─── R4. a shift is INSERTED, and a confirmation begins ─────────────────────

DO $$
DECLARE
  v_plan  uuid := _vdc_id('r4');
  v_pid_a integer;
  v_wait  boolean;
  v_res   text;
BEGIN
  v_pid_a := _vdc_open('vdc_r4_a');
  PERFORM _vdc_open('vdc_r4_b');

  PERFORM dblink_exec('vdc_r4_b', _vdc_insert_sql(v_plan, 8, 1, 30, 42));

  PERFORM dblink_send_query('vdc_r4_a', format('SELECT (public.vehicle_day_plan_confirm(%L) ->> ''reason'')', v_plan));
  v_wait := _vdc_waits(v_pid_a);
  PERFORM _vdc_expect('R4: a confirmation that begins while an overlapping shift is being written waits for the write', 'true', v_wait::text);

  PERFORM dblink_exec('vdc_r4_b', 'COMMIT');
  v_res := _vdc_result('vdc_r4_a');
  PERFORM _vdc_expect('R4: …and, once the write has committed, sees the overlap', 'vehicle_overlap', v_res);

  PERFORM dblink_exec('vdc_r4_a', 'COMMIT');
  PERFORM dblink_disconnect('vdc_r4_a');
  PERFORM dblink_disconnect('vdc_r4_b');
  PERFORM _vdc_expect('R4: the plan is still a draft, with both shifts', '2|draft', _vdc_state(v_plan));
END $$;

-- ─── the fixtures go ────────────────────────────────────────────────────────
-- Confirmed plans cannot be deleted while their company exists, which is the
-- rule; the two guards step aside for this one transaction, and are put back.

BEGIN;
ALTER TABLE vehicle_day_plans  DISABLE TRIGGER vehicle_day_plan_guard;
ALTER TABLE vehicle_day_shifts DISABLE TRIGGER vehicle_day_shift_guard;
DELETE FROM vehicle_day_shifts WHERE company_id = 'c0000000-0000-4000-8000-00000000000a' AND vehicle = 'VDC-CAR';
DELETE FROM vehicle_day_plans  WHERE company_id = 'c0000000-0000-4000-8000-00000000000a' AND year = 2063;
ALTER TABLE vehicle_day_plans  ENABLE TRIGGER vehicle_day_plan_guard;
ALTER TABLE vehicle_day_shifts ENABLE TRIGGER vehicle_day_shift_guard;
COMMIT;

-- ─── the verdict ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_ok   bigint;
  v_bad  bigint;
  v_list text;
BEGIN
  PERFORM _vdc_expect('the fixtures are gone, and both guards are back', '0|0|2',
    (SELECT count(*) FROM vehicle_day_plans WHERE company_id = 'c0000000-0000-4000-8000-00000000000a' AND year = 2063)::text || '|'
    || (SELECT count(*) FROM vehicle_day_shifts WHERE vehicle = 'VDC-CAR')::text || '|'
    || (SELECT count(*) FROM pg_trigger g
         WHERE g.tgname IN ('vehicle_day_plan_guard', 'vehicle_day_shift_guard') AND NOT g.tgisinternal AND g.tgenabled = 'O')::text);

  SELECT count(*) FILTER (WHERE r.ok),
         count(*) FILTER (WHERE NOT r.ok),
         string_agg(format(E'  #%s %s\n      expected [%s]\n      got      [%s]',
                           r.n, r.label, r.expected, r.actual), E'\n' ORDER BY r.n) FILTER (WHERE NOT r.ok)
    INTO v_ok, v_bad, v_list
    FROM _vdc_results r;

  RAISE NOTICE 'vehicle day plans, two sessions: % checks, % passed, % differ', v_ok + v_bad, v_ok, v_bad;

  IF v_bad > 0 THEN
    RAISE EXCEPTION E'vehicle day plans, two sessions: % check(s) differ from what migration 20261022140000 promises\n%',
      v_bad, v_list;
  END IF;
END $$;
