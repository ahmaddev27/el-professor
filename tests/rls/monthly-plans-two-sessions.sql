/*
  The monthly plan: the races a single session cannot show (migration
  20261023110000).

  ── THE NAME ────────────────────────────────────────────────────────────────

  `monthly-plans-two-sessions.sql`, with the plural, and not
  `monthly-plan-two-sessions.sql`. The runner sorts with JavaScript's own
  `.sort()`, which is code-unit order, and `-` (0x2D) sorts before `.` (0x2E) —
  so the singular name would run BEFORE tests/rls/monthly-plan.sql. That matters
  because the kit stops at the first file that fails: this is the file that
  depends on dblink and on a second session, and the main file's verdict should
  be on the screen whatever this one does. The plural puts `s` (0x73) against
  `.` and sorts after. Measured, not reasoned:

      node -e "console.log(['monthly-plan.sql','monthly-plan-two-sessions.sql',
                            'monthly-plans-two-sessions.sql'].sort().join('\n'))"

  Runs after seed.sql, against the same throwaway database as every other file,
  as supabase_admin. tests/rls/monthly-plan.sql is one transaction and one
  session; a lock is only shown to work by something waiting on it, so this file
  opens two real sessions through dblink, as salary-cash.sql does for its
  receipts and as vehicle-day-two-sessions.sql does for the newer family, and
  gives each its own transaction. The fixtures are therefore COMMITTED — seven
  plans of one vehicle in company A in the year 2064, one month for each
  scenario, plus a company of its own for the two cascade scenarios — and the
  file removes them again at the end, so the files after it see the database as
  the seeds left it.

  ── WHAT WENT WRONG, AND WHAT IS ASSERTED ───────────────────────────────────

  app_private.monthly_plan_parent_is_open is the one place the two child guards
  ask whether a plan exists, belongs to the row's company and is still a draft,
  and it read the plan with no lock. public.monthly_plan_confirm counts the
  plan's blocks, re-derives requirement section 7's rules over them and then
  stamps the plan confirmed, all in one transaction; a child write made while
  that was uncommitted read the committed `draft` and was allowed:

      INSERT   waits on the foreign key check of monthly_plan_blocks.plan_id,
               which takes KEY SHARE on the plan and so conflicts with the
               confirmation's FOR UPDATE — and once the confirmation commits the
               key has not moved, so the row lands in a plan that is now
               confirmed. Two overlapping blocks of one driver, which is what
               `driver_overlap` had just been re-derived to refuse.
      DELETE   worse, because a DELETE of a child has no foreign key check
               against the parent to wait on. It did not even wait: the stale
               read allowed it and it committed, leaving the plan confirmed with
               fewer blocks than were validated — in the worst case none, which
               is what `plan_empty` exists to prevent.

  The guard now reads the plan FOR KEY SHARE, which conflicts with the FOR
  UPDATE the confirmation takes, so the two take turns in either order and
  whichever comes second sees what the first did. Seven scenarios:

    M1  a block is INSERTED while a confirmation is open  -> waits, then refused
    M2  a block is DELETED  while a confirmation is open  -> waits, then refused
    M3  a block is DELETED, and a confirmation begins     -> waits, then plan_empty
    M4  a block is INSERTED, and a confirmation begins    -> waits, then driver_overlap
    M5  two sessions write blocks of ONE DRAFT plan       -> neither blocks the other
    M6  a company holding a confirmed plan is deleted     -> the cascade goes through
    M7  a child is written while its plan is being deleted in another session

  M1 and M2 are the two that failed. M3 fails without the lock for the same
  reason (the delete is invisible to the confirmation until it commits). M4
  passes with or without it, because the foreign key check already holds the
  row; it is here so that a change to the locking which breaks the other
  direction is seen.

  M5 is the one that measures the lock MODE rather than its presence, and
  without it this file would say nothing about FOR KEY SHARE as against FOR
  UPDATE — both of which fix M1 to M4. FOR KEY SHARE is a shared mode and is
  exactly what a child row's own foreign key check already takes on its parent,
  so two sessions writing children of one plan hold it at once and neither
  waits. FOR UPDATE is exclusive: the second session would block until the
  first committed, which M5 reads as `<still running>`. That is also the mode a
  child's own foreign key check conflicts with, which is the deadlock
  confirm_salary_cash_payment's standing rule was written for.

  M6 and M7 are the cascade, which rule 2 of this work required be tested and
  not assumed, because FOR KEY SHARE on a row another session is deleting could
  in principle raise rather than wait. M6 is 20261016140000's own case — a
  company that had confirmed a monthly plan could not be deleted — re-run under
  the new lock, in one session, where the parent row is gone by the time the
  cascade reaches the children, so the locking read finds nothing and the first
  branch returns. M7 is the cross-session form: the plan is being deleted
  elsewhere, so the child write waits on that delete and then finds no plan.
  It does not raise there, and what refuses it instead was measured and was NOT
  what had been predicted — see M7's own note.

  "Waits" is asserted by what the server says, not by a sleep: the second
  session's backend must show wait_event_type = 'Lock' in pg_stat_activity
  within ten seconds. A refusal is asserted by the guard's HINT, which dblink
  carries in the text of the error: `monthly_plan_is_final`, a machine word and
  not a sentence of one language, and one that tells the two P0001 refusals of
  this guard apart — `monthly_plan_company_mismatch` is the other, and a cell
  that accepted either would be green while measuring nothing. The HINT is read
  here rather than the message because it is OUR hint, set with USING HINT, and
  not one PostgreSQL writes itself; the kit's rule about preferring the message
  is about the prose hints the supabase/postgres 17.6 image adds to a privilege
  error, which is a different thing.
*/

\set ON_ERROR_STOP on

-- ─── dblink ─────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'dblink') THEN
    CREATE SCHEMA IF NOT EXISTS _mptr_dblink;
    CREATE EXTENSION dblink WITH SCHEMA _mptr_dblink;
  END IF;
  PERFORM set_config('search_path',
    current_setting('search_path') || ', ' ||
    (SELECT quote_ident(n.nspname) FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'dblink'),
    false);
END $$;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _mptr_results (
  n        serial PRIMARY KEY,
  label    text   NOT NULL,
  expected text,
  actual   text,
  ok       boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _mptr_expect(p_label text, p_expected text, p_actual text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean := p_actual IS NOT DISTINCT FROM p_expected;
BEGIN
  INSERT INTO _mptr_results (label, expected, actual, ok) VALUES (p_label, p_expected, p_actual, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok   % [%]', p_label, p_actual;
  ELSE
    RAISE NOTICE 'DIFF % -- expected [%] got [%]', p_label, p_expected, p_actual;
  END IF;
END $$;

/* Recorded, not asserted: a measurement this file reports and does not pass or
   fail on, because nobody had established what the answer is. */
CREATE OR REPLACE FUNCTION _mptr_record(p_label text, p_actual text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'measured   % -> [%]', p_label, p_actual;
END $$;

/* How a second session reaches this server. Where the server has a Unix socket
   (the supabase/postgres image) that is the database and the user and nothing
   else, exactly as salary-cash.sql connects; a server with no socket (a Windows
   build, which is what a local replica of this kit runs on) is reached over TCP
   on the address and port this session came in on. */
CREATE OR REPLACE FUNCTION _mptr_conninfo() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT format('dbname=%s user=supabase_admin', current_database())
         || CASE WHEN coalesce(current_setting('unix_socket_directories', true), '') = ''
                 THEN format(' host=%s port=%s', coalesce(host(inet_server_addr()), 'localhost'), current_setting('port'))
                 ELSE '' END
$$;

/* A session that is company A's administrator, inside its own transaction, in
   the role PostgREST would run it as. */
CREATE OR REPLACE FUNCTION _mptr_open(p_name text) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_pid integer;
BEGIN
  PERFORM dblink_connect(p_name, _mptr_conninfo());
  PERFORM dblink_exec(p_name, 'BEGIN');
  PERFORM * FROM dblink(p_name, format('SELECT set_config(%L, %L, true)', 'request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001')) AS t(v text);
  PERFORM * FROM dblink(p_name, format('SELECT set_config(%L, %L, true)', 'request.jwt.claim.role', 'authenticated')) AS t(v text);
  PERFORM * FROM dblink(p_name, format('SELECT set_config(%L, %L, true)', 'request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]')) AS t(v text);
  PERFORM dblink_exec(p_name, 'SET LOCAL ROLE authenticated');
  SELECT t.pid INTO v_pid FROM dblink(p_name, 'SELECT pg_backend_pid()') AS t(pid integer);
  RETURN v_pid;
END $$;

/* True when that backend is waiting on a lock, within p_seconds. */
CREATE OR REPLACE FUNCTION _mptr_waits(p_pid integer, p_seconds integer DEFAULT 10) RETURNS boolean
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

/*
  Waits for an asynchronous statement to finish and returns its error message,
  or its one text value, or '<still running>'. A statement that is STILL running
  is cancelled and drained before the answer is given: the connection is left
  usable, so the COMMIT that follows a failed scenario does not fail for a
  second reason and hide the first. (vehicle-day-two-sessions.sql returns early
  there, which is correct for its four scenarios because none of them expects a
  statement to keep running; M5 below does.)
*/
CREATE OR REPLACE FUNCTION _mptr_result(p_name text, p_seconds integer DEFAULT 20) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_tries integer := 0;
  v_value text;
  v_err   text;
  v_stuck boolean := false;
BEGIN
  WHILE dblink_is_busy(p_name) = 1 AND v_tries < p_seconds * 20 LOOP
    PERFORM pg_sleep(0.05);
    v_tries := v_tries + 1;
  END LOOP;
  IF dblink_is_busy(p_name) = 1 THEN
    v_stuck := true;
    PERFORM dblink_cancel_query(p_name);
    v_tries := 0;
    WHILE dblink_is_busy(p_name) = 1 AND v_tries < 100 LOOP
      PERFORM pg_sleep(0.05);
      v_tries := v_tries + 1;
    END LOOP;
  END IF;
  BEGIN
    SELECT t.v INTO v_value FROM dblink_get_result(p_name, false) AS t(v text);
    v_err := dblink_error_message(p_name);
    PERFORM * FROM dblink_get_result(p_name, false) AS t(v text);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  IF v_stuck THEN
    RETURN '<still running>';
  END IF;
  RETURN CASE WHEN v_err IS NOT NULL AND v_err <> 'OK' THEN 'ERROR ' || v_err ELSE coalesce(v_value, '<no value>') END;
END $$;

CREATE OR REPLACE FUNCTION _mptr_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('mptr:' || p_what)::uuid $$;

/* A moment on the 1st of the given month of 2064, p_minutes after midnight UTC.
   Written as a literal with an explicit offset: the month only has to be the
   same for every row of one plan, and a session timezone the kit does not pin
   must not be able to move it. */
CREATE OR REPLACE FUNCTION _mptr_moment(p_month integer, p_minutes integer) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $$
  SELECT format('2064-%s-01 00:00:00+00', lpad(p_month::text, 2, '0'))::timestamptz
         + make_interval(mins => p_minutes)
$$;

/* The statement that adds one block of MPTR-CAR to a plan, assigned to the
   plan's one driver, from p_from to p_to minutes after midnight. The guard
   fills driver_name from the plan's own snapshot, so NULL is sent for it —
   which is also what tests/rls/monthly-plan.sql's fixtures send. */
CREATE OR REPLACE FUNCTION _mptr_block_sql(p_company uuid, p_plan uuid, p_driver uuid,
                                           p_month integer, p_key text,
                                           p_from integer, p_to integer) RETURNS text
LANGUAGE sql STABLE AS $body$
  SELECT format($f$INSERT INTO monthly_plan_blocks (company_id, plan_id, block_key, car_id, car_identifier,
      starts_at, ends_at, span_minutes, ride_minutes, driver_id, driver_name, assignment_reason)
    VALUES (%L, %L, %L, NULL, 'MPTR-CAR', %L, %L, %s, %s, %L, NULL, 'best_fit')$f$,
    p_company, p_plan, p_key,
    _mptr_moment(p_month, p_from), _mptr_moment(p_month, p_to),
    p_to - p_from, p_to - p_from, p_driver)
$body$;

/* `<blocks>|<status>` — the whole state each scenario reads back. */
CREATE OR REPLACE FUNCTION _mptr_state(p_plan uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM monthly_plan_blocks b WHERE b.plan_id = p_plan)::text || '|' || p.status
    FROM monthly_plans p WHERE p.id = p_plan
$$;

-- ─── fixtures, committed ────────────────────────────────────────────────────
--
-- A clean slate first, in case an earlier run of this file was cut short. The
-- guards refuse to delete a confirmed plan while its company exists, so they
-- stand aside for this one statement and are put back immediately.

BEGIN;
ALTER TABLE monthly_plans            DISABLE TRIGGER monthly_plan_guard;
ALTER TABLE monthly_plan_blocks      DISABLE TRIGGER monthly_plan_child_guard;
ALTER TABLE monthly_plan_block_trips DISABLE TRIGGER monthly_plan_child_guard;
ALTER TABLE monthly_plan_drivers     DISABLE TRIGGER monthly_plan_driver_guard;
DELETE FROM monthly_plans WHERE year = 2064;
DELETE FROM companies     WHERE id = _mptr_id('company');
DELETE FROM drivers       WHERE id IN (_mptr_id('driver'), _mptr_id('driver:own'));
ALTER TABLE monthly_plans            ENABLE TRIGGER monthly_plan_guard;
ALTER TABLE monthly_plan_blocks      ENABLE TRIGGER monthly_plan_child_guard;
ALTER TABLE monthly_plan_block_trips ENABLE TRIGGER monthly_plan_child_guard;
ALTER TABLE monthly_plan_drivers     ENABLE TRIGGER monthly_plan_driver_guard;
COMMIT;

/*
  The driver is given requirement section 5's own worked figures — 1950 to 2100 €
  at 14 €/h — so that range_problems comes out EMPTY and the confirmation's
  `no_usable_range` and `exceeds_hours_cap` branches stay out of the way. The
  seed's own `Driver A` carries no planning figures at all, so a block assigned
  to it would be refused with no_usable_range and every scenario below would
  measure that instead of the lock.
*/
INSERT INTO drivers (id, company_id, name, employment_type, planning_min_salary,
                     planning_max_salary, planning_hourly_rate, max_monthly_hours,
                     planning_priority, planning_enabled, can_cover_other_drivers)
VALUES (_mptr_id('driver'), 'c0000000-0000-4000-8000-00000000000a', 'MPTR Ok', 'employee',
        1950, 2100, 14, NULL, 100, true, true);

-- The seven plans and their one block each, in a statement of their own: a
-- second session sees nothing a transaction has not committed, and a DO block is
-- one transaction.
DO $$
DECLARE
  v_month integer;
  v_plan  uuid;
BEGIN
  FOR v_month IN 1..7 LOOP
    v_plan := _mptr_id('plan:' || v_month);
    INSERT INTO monthly_plans (id, company_id, year, month, switch_minutes)
    VALUES (v_plan, 'c0000000-0000-4000-8000-00000000000a', 2064, v_month, 30);
    INSERT INTO monthly_plan_drivers (company_id, plan_id, driver_id, driver_name, selected, is_owner)
    VALUES ('c0000000-0000-4000-8000-00000000000a', v_plan, _mptr_id('driver'), NULL, true, false);
    EXECUTE _mptr_block_sql('c0000000-0000-4000-8000-00000000000a', v_plan, _mptr_id('driver'),
                            v_month, 'base', 480, 540);
  END LOOP;
END $$;

DO $$
BEGIN
  PERFORM _mptr_expect('the fixtures: seven drafts of 2064, one block and one driver each', '7|7|7',
    (SELECT count(*) FROM monthly_plans WHERE year = 2064 AND status = 'draft')::text || '|'
    || (SELECT count(*) FROM monthly_plan_blocks b JOIN monthly_plans p ON p.id = b.plan_id WHERE p.year = 2064)::text || '|'
    || (SELECT count(*) FROM monthly_plan_drivers d JOIN monthly_plans p ON p.id = d.plan_id WHERE p.year = 2064)::text);
  -- The snapshot the confirmation's two driver branches read. If this is not
  -- empty, every scenario below measures a configuration error and not a lock.
  PERFORM _mptr_expect('the fixtures: the driver snapshot has no range problem, so the confirmation reaches the blocks',
    '0', (SELECT cardinality(d.range_problems)::text FROM monthly_plan_drivers d
           WHERE d.plan_id = _mptr_id('plan:1')));
END $$;

-- ─── M1. a block is INSERTED while a confirmation is open ───────────────────

DO $$
DECLARE
  v_plan    uuid := _mptr_id('plan:1');
  v_pid_b   integer;
  v_wait    boolean;
  v_res     text;
  v_confirm text;
BEGIN
  PERFORM _mptr_open('mptr_m1_a');
  v_pid_b := _mptr_open('mptr_m1_b');

  SELECT t.r INTO v_confirm FROM dblink('mptr_m1_a',
    format('SELECT (public.monthly_plan_confirm(%L) ->> ''success'')', v_plan)) AS t(r text);
  PERFORM _mptr_expect('M1: session A confirms the plan and keeps its transaction open', 'true', v_confirm);

  -- 08:30 to 09:30 overlaps the 08:00 to 09:00 block of the same driver that the
  -- confirmation has just certified does not overlap anything.
  PERFORM dblink_send_query('mptr_m1_b',
    _mptr_block_sql('c0000000-0000-4000-8000-00000000000a', v_plan, _mptr_id('driver'), 1, 'race', 510, 570));
  v_wait := _mptr_waits(v_pid_b);
  PERFORM _mptr_expect('M1: session B, writing a block into the plan, waits for the confirmation', 'true', v_wait::text);

  PERFORM dblink_exec('mptr_m1_a', 'COMMIT');
  v_res := _mptr_result('mptr_m1_b');
  PERFORM _mptr_expect('M1: …and is refused once the confirmation has committed, because the plan is final',
    'refused as final', CASE WHEN v_res LIKE '%monthly_plan_is_final%' THEN 'refused as final' ELSE v_res END);

  PERFORM dblink_exec('mptr_m1_b', 'COMMIT');
  PERFORM dblink_disconnect('mptr_m1_a');
  PERFORM dblink_disconnect('mptr_m1_b');
  PERFORM _mptr_expect('M1: the confirmed plan holds exactly the block it was confirmed with',
    '1|confirmed', _mptr_state(v_plan));
END $$;

-- ─── M2. a block is DELETED while a confirmation is open ────────────────────

DO $$
DECLARE
  v_plan    uuid := _mptr_id('plan:2');
  v_pid_b   integer;
  v_wait    boolean;
  v_res     text;
  v_confirm text;
BEGIN
  PERFORM _mptr_open('mptr_m2_a');
  v_pid_b := _mptr_open('mptr_m2_b');

  SELECT t.r INTO v_confirm FROM dblink('mptr_m2_a',
    format('SELECT (public.monthly_plan_confirm(%L) ->> ''success'')', v_plan)) AS t(r text);
  PERFORM _mptr_expect('M2: session A confirms the plan and keeps its transaction open', 'true', v_confirm);

  PERFORM dblink_send_query('mptr_m2_b', format('DELETE FROM monthly_plan_blocks WHERE plan_id = %L', v_plan));
  v_wait := _mptr_waits(v_pid_b);
  -- Without the lock this is the scenario that did not even wait: a DELETE of a
  -- child has no foreign key check against the parent to block on.
  PERFORM _mptr_expect('M2: session B, deleting the plan''s block, waits for the confirmation', 'true', v_wait::text);

  PERFORM dblink_exec('mptr_m2_a', 'COMMIT');
  v_res := _mptr_result('mptr_m2_b');
  PERFORM _mptr_expect('M2: …and is refused once the confirmation has committed, because the plan is final',
    'refused as final', CASE WHEN v_res LIKE '%monthly_plan_is_final%' THEN 'refused as final' ELSE v_res END);

  PERFORM dblink_exec('mptr_m2_b', 'COMMIT');
  PERFORM dblink_disconnect('mptr_m2_a');
  PERFORM dblink_disconnect('mptr_m2_b');
  PERFORM _mptr_expect('M2: the confirmed plan still has its block (a confirmed plan with none is what plan_empty prevents)',
    '1|confirmed', _mptr_state(v_plan));
END $$;

-- ─── M3. a block is DELETED, and a confirmation begins ──────────────────────

DO $$
DECLARE
  v_plan  uuid := _mptr_id('plan:3');
  v_pid_a integer;
  v_wait  boolean;
  v_res   text;
BEGIN
  v_pid_a := _mptr_open('mptr_m3_a');
  PERFORM _mptr_open('mptr_m3_b');

  PERFORM dblink_exec('mptr_m3_b', format('DELETE FROM monthly_plan_blocks WHERE plan_id = %L', v_plan));

  PERFORM dblink_send_query('mptr_m3_a', format('SELECT (public.monthly_plan_confirm(%L) ->> ''reason'')', v_plan));
  v_wait := _mptr_waits(v_pid_a);
  PERFORM _mptr_expect('M3: a confirmation that begins while a block is being deleted waits for the delete',
    'true', v_wait::text);

  PERFORM dblink_exec('mptr_m3_b', 'COMMIT');
  v_res := _mptr_result('mptr_m3_a');
  PERFORM _mptr_expect('M3: …and, once the delete has committed, finds the plan empty', 'plan_empty', v_res);

  PERFORM dblink_exec('mptr_m3_a', 'COMMIT');
  PERFORM dblink_disconnect('mptr_m3_a');
  PERFORM dblink_disconnect('mptr_m3_b');
  PERFORM _mptr_expect('M3: the plan is still a draft, with no block', '0|draft', _mptr_state(v_plan));
END $$;

-- ─── M4. a block is INSERTED, and a confirmation begins ─────────────────────

DO $$
DECLARE
  v_plan  uuid := _mptr_id('plan:4');
  v_pid_a integer;
  v_wait  boolean;
  v_res   text;
BEGIN
  v_pid_a := _mptr_open('mptr_m4_a');
  PERFORM _mptr_open('mptr_m4_b');

  PERFORM dblink_exec('mptr_m4_b',
    _mptr_block_sql('c0000000-0000-4000-8000-00000000000a', v_plan, _mptr_id('driver'), 4, 'race', 510, 570));

  PERFORM dblink_send_query('mptr_m4_a', format('SELECT (public.monthly_plan_confirm(%L) ->> ''reason'')', v_plan));
  v_wait := _mptr_waits(v_pid_a);
  PERFORM _mptr_expect('M4: a confirmation that begins while an overlapping block is being written waits for the write',
    'true', v_wait::text);

  PERFORM dblink_exec('mptr_m4_b', 'COMMIT');
  v_res := _mptr_result('mptr_m4_a');
  -- The reason, and not merely "refused": driver_overlap is section 7 rule 2,
  -- which is exactly what M1's damage would have put into a confirmed plan.
  PERFORM _mptr_expect('M4: …and, once the write has committed, sees the overlap', 'driver_overlap', v_res);

  PERFORM dblink_exec('mptr_m4_a', 'COMMIT');
  PERFORM dblink_disconnect('mptr_m4_a');
  PERFORM dblink_disconnect('mptr_m4_b');
  PERFORM _mptr_expect('M4: the plan is still a draft, with both blocks', '2|draft', _mptr_state(v_plan));
END $$;

-- ─── M5. the lock MODE: two sessions write blocks of one draft plan ─────────
--
-- The scenario that tells FOR KEY SHARE from FOR UPDATE. Both fix M1 to M4;
-- only FOR KEY SHARE leaves ordinary concurrent writing alone, because it is a
-- shared mode and is the same lock the child's own foreign key check takes.
-- Session B's insert must COMPLETE while session A's transaction is still open.
-- Under FOR UPDATE it would block on A until A committed, which _mptr_result
-- reads as `<still running>`.

DO $$
DECLARE
  v_plan  uuid := _mptr_id('plan:5');
  v_pid_b integer;
  v_res   text;
BEGIN
  PERFORM _mptr_open('mptr_m5_a');
  v_pid_b := _mptr_open('mptr_m5_b');

  PERFORM dblink_exec('mptr_m5_a',
    _mptr_block_sql('c0000000-0000-4000-8000-00000000000a', v_plan, _mptr_id('driver'), 5, 'a', 600, 660));

  PERFORM dblink_send_query('mptr_m5_b',
    _mptr_block_sql('c0000000-0000-4000-8000-00000000000a', v_plan, _mptr_id('driver'), 5, 'b', 700, 760));
  -- Five seconds, not twenty: a regression to an exclusive mode should fail
  -- fast rather than make the kit look hung.
  v_res := _mptr_result('mptr_m5_b', 5);
  -- `INSERT 0 1` is dblink's command status for the statement, and it is the
  -- answer to want: it says the row went in, not merely that nothing raised.
  -- (vehicle-day-two-sessions.sql reads `<no value>` for its inserts because the
  -- only one it sends asynchronously is refused; an async INSERT that SUCCEEDS
  -- has a status, which is what this scenario is for.)
  PERFORM _mptr_expect('M5: a second session''s block lands while the first session''s transaction is still open, '
    'so the guard''s lock is shared and not exclusive', 'INSERT 0 1', v_res);

  PERFORM dblink_exec('mptr_m5_a', 'COMMIT');
  PERFORM dblink_exec('mptr_m5_b', 'COMMIT');
  PERFORM dblink_disconnect('mptr_m5_a');
  PERFORM dblink_disconnect('mptr_m5_b');
  PERFORM _mptr_expect('M5: the draft holds all three blocks', '3|draft', _mptr_state(v_plan));
END $$;

-- ─── M6. the cascade, in one session ───────────────────────────────────────
--
-- 20261016140000's own case, re-run under the new lock: a company that has
-- confirmed a monthly plan must still be deletable. By the time the cascade
-- reaches a child the plan row is already deleted in this transaction, so the
-- locking read finds nothing and parent_is_open's first branch returns — the
-- lock is never taken on a row the cascade is removing. A company of its own,
-- never company A, so the files after this one are untouched.

DO $$
DECLARE
  v_company uuid := _mptr_id('company');
  v_plan    uuid := _mptr_id('plan:cascade');
  v_driver  uuid := _mptr_id('driver:own');
  v_block   uuid := _mptr_id('block:cascade');
  v_err     text;
  v_hint    text;
BEGIN
  INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
  VALUES (v_company, 'MPTR Cascade', 'mptr-cascade', 'approved', 'active', 'basic', 'active');
  INSERT INTO drivers (id, company_id, name, employment_type, planning_min_salary,
                       planning_max_salary, planning_hourly_rate, max_monthly_hours,
                       planning_priority, planning_enabled, can_cover_other_drivers)
  VALUES (v_driver, v_company, 'MPTR Own', 'employee', 1950, 2100, 14, NULL, 100, true, true);
  INSERT INTO monthly_plans (id, company_id, year, month, switch_minutes)
  VALUES (v_plan, v_company, 2064, 12, 30);
  INSERT INTO monthly_plan_drivers (company_id, plan_id, driver_id, driver_name, selected, is_owner)
  VALUES (v_company, v_plan, v_driver, NULL, true, false);
  INSERT INTO monthly_plan_blocks (id, company_id, plan_id, block_key, car_id, car_identifier,
                                   starts_at, ends_at, span_minutes, ride_minutes,
                                   driver_id, driver_name, assignment_reason)
  VALUES (v_block, v_company, v_plan, 'cascade', NULL, 'MPTR-CAR',
          _mptr_moment(12, 480), _mptr_moment(12, 540), 60, 60, v_driver, NULL, 'best_fit');
  INSERT INTO monthly_plan_block_trips (company_id, plan_id, block_id, trip_id,
                                        starts_at, ends_at, minutes, time_source)
  VALUES (v_company, v_plan, v_block, _mptr_id('trip:cascade'),
          _mptr_moment(12, 480), _mptr_moment(12, 540), 60, 'instants');

  -- Confirmed directly, with the marker and inside a session: the guard writes
  -- confirmed_at and confirmed_by ITSELF from auth.uid(), so with no session
  -- confirmed_by comes out NULL and monthly_plans_confirmed_together refuses the
  -- row — the wrong constraint, proving nothing. (The same note is in
  -- tests/rls/monthly-plan.sql, where it was learnt.)
  PERFORM set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);
  PERFORM set_config('app_private.monthly_plan_transition',
    'plan:' || v_plan::text || ':' || pg_current_xact_id()::text, true);
  UPDATE monthly_plans SET status = 'confirmed' WHERE id = v_plan;
  PERFORM set_config('app_private.monthly_plan_transition', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  PERFORM _mptr_expect('M6: the company holds a confirmed plan with a block and a ride', 'confirmed|1|1',
    (SELECT p.status FROM monthly_plans p WHERE p.id = v_plan) || '|'
    || (SELECT count(*) FROM monthly_plan_blocks b WHERE b.plan_id = v_plan)::text || '|'
    || (SELECT count(*) FROM monthly_plan_block_trips t WHERE t.plan_id = v_plan)::text);

  -- The plan itself cannot be deleted while its company exists; that is the
  -- rule, and the control that proves the cascade below is not vacuous.
  BEGIN
    DELETE FROM monthly_plans WHERE id = v_plan;
    v_err := '<allowed>';
  EXCEPTION WHEN OTHERS THEN
    -- The hint is reachable only through GET STACKED DIAGNOSTICS; it is not a
    -- plpgsql variable the way SQLSTATE and SQLERRM are.
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_err = MESSAGE_TEXT;
    v_err := coalesce(nullif(v_hint, ''), v_err);
  END;
  PERFORM _mptr_expect('M6: deleting the confirmed plan on its own is still refused',
    'monthly_plan_is_final', v_err);

  BEGIN
    DELETE FROM companies WHERE id = v_company;
    v_err := '<deleted>';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM _mptr_expect('M6: deleting the company takes the confirmed plan, its block and its ride with it',
    '<deleted>', v_err);
  PERFORM _mptr_expect('M6: nothing of it is left', '0|0|0|0',
    (SELECT count(*) FROM monthly_plans WHERE id = v_plan)::text || '|'
    || (SELECT count(*) FROM monthly_plan_blocks WHERE plan_id = v_plan)::text || '|'
    || (SELECT count(*) FROM monthly_plan_block_trips WHERE plan_id = v_plan)::text || '|'
    || (SELECT count(*) FROM monthly_plan_drivers WHERE plan_id = v_plan)::text);
END $$;

-- ─── M7. the cascade, across two sessions ──────────────────────────────────
--
-- Rule 2 of this work asked for this explicitly, because FOR KEY SHARE on a row
-- another session is deleting could in principle raise a serialization failure
-- rather than wait. Session B deletes a DRAFT plan (which the plan guard allows)
-- and holds its transaction; session A then writes a child of that plan, so the
-- guard's locking read meets B's delete.
--
-- MEASURED on the VPS, 23.10.2026, and NOT what was predicted. The prediction
-- was that parent_is_open would stand aside (the row is gone, so its first
-- branch returns) and the insert would then meet the foreign key on plan_id
-- with no plan to point at, 23503. The first half is right and the second never
-- happens: the plan's monthly_plan_drivers snapshot row was cascaded away with
-- the plan, so the NEXT check in monthly_plan_child_guard fires first and
-- refuses with `monthly_plan_driver_not_in_plan`, before the foreign key is
-- reached. That is asserted here rather than the vaguer "not a serialization
-- failure", because it is the stronger statement: a refusal from a check that
-- sits BELOW parent_is_open in the same function is proof that parent_is_open
-- let the row through, which is the cascade behaviour this scenario exists to
-- show. The two weaker properties are asserted beside it — the wait, and that
-- the answer is not a 40001-class serialization failure or deadlock — and the
-- foreign key is then met directly by an unassigned block, which skips the
-- driver check.

DO $$
DECLARE
  v_plan  uuid := _mptr_id('plan:7');
  v_pid_a integer;
  v_wait  boolean;
  v_res   text;
BEGIN
  v_pid_a := _mptr_open('mptr_m7_a');
  PERFORM _mptr_open('mptr_m7_b');

  -- A draft, so the plan guard allows the delete; its one block goes with it by
  -- cascade, and that child's own guard stands aside because the plan row is
  -- already gone inside B's transaction.
  PERFORM dblink_exec('mptr_m7_b', format('DELETE FROM monthly_plans WHERE id = %L', v_plan));

  PERFORM dblink_send_query('mptr_m7_a',
    _mptr_block_sql('c0000000-0000-4000-8000-00000000000a', v_plan, _mptr_id('driver'), 7, 'race', 600, 660));
  v_wait := _mptr_waits(v_pid_a);
  PERFORM _mptr_expect('M7: a child write waits for the session that is deleting its plan', 'true', v_wait::text);

  PERFORM dblink_exec('mptr_m7_b', 'COMMIT');
  v_res := _mptr_result('mptr_m7_a');
  PERFORM _mptr_record('M7: what the child write gets once the plan is gone', v_res);
  PERFORM _mptr_expect('M7: …and it is not a serialization failure and not a deadlock',
    'neither',
    CASE WHEN v_res ~ '40001|40P01|could not serialize|deadlock' THEN v_res ELSE 'neither' END);
  -- The refusal comes from BELOW parent_is_open in the same guard, which is the
  -- proof that parent_is_open stood aside for the cascade rather than raising
  -- monthly_plan_is_final or monthly_plan_company_mismatch on a vanished plan.
  PERFORM _mptr_expect('M7: …and it is refused by the check below parent_is_open, so parent_is_open stood aside',
    'monthly_plan_driver_not_in_plan',
    CASE WHEN v_res LIKE '%monthly_plan_driver_not_in_plan%' THEN 'monthly_plan_driver_not_in_plan' ELSE v_res END);

  PERFORM dblink_exec('mptr_m7_a', 'COMMIT');
  PERFORM dblink_disconnect('mptr_m7_a');
  PERFORM dblink_disconnect('mptr_m7_b');

  -- And the foreign key, met directly: an UNASSIGNED block skips the driver
  -- check, so this is the row whose only remaining problem is that its plan is
  -- gone. 23503 and not a guard refusal, which is the other half of "the guard
  -- stood aside".
  BEGIN
    INSERT INTO monthly_plan_blocks (company_id, plan_id, block_key, car_id, car_identifier,
                                     starts_at, ends_at, span_minutes, ride_minutes,
                                     driver_id, driver_name, assignment_reason)
    VALUES ('c0000000-0000-4000-8000-00000000000a', v_plan, 'orphan', NULL, 'MPTR-CAR',
            _mptr_moment(7, 600), _mptr_moment(7, 660), 60, 60, NULL, NULL, NULL);
    v_res := '<allowed>';
  EXCEPTION WHEN OTHERS THEN
    v_res := SQLSTATE;
  END;
  PERFORM _mptr_expect('M7: an unassigned block pointing at the gone plan is refused by the foreign key, '
    'not by the guard', '23503', v_res);
  PERFORM _mptr_expect('M7: the plan and its block are gone, and no orphan block was written', '0|0',
    (SELECT count(*) FROM monthly_plans WHERE id = v_plan)::text || '|'
    || (SELECT count(*) FROM monthly_plan_blocks WHERE plan_id = v_plan)::text);
END $$;

-- ─── the fixtures go ────────────────────────────────────────────────────────
-- Confirmed plans cannot be deleted while their company exists, which is the
-- rule; the four guards step aside for this one transaction, and are put back.

BEGIN;
ALTER TABLE monthly_plans            DISABLE TRIGGER monthly_plan_guard;
ALTER TABLE monthly_plan_blocks      DISABLE TRIGGER monthly_plan_child_guard;
ALTER TABLE monthly_plan_block_trips DISABLE TRIGGER monthly_plan_child_guard;
ALTER TABLE monthly_plan_drivers     DISABLE TRIGGER monthly_plan_driver_guard;
DELETE FROM monthly_plans WHERE year = 2064;
DELETE FROM companies     WHERE id = _mptr_id('company');
DELETE FROM drivers       WHERE id IN (_mptr_id('driver'), _mptr_id('driver:own'));
ALTER TABLE monthly_plans            ENABLE TRIGGER monthly_plan_guard;
ALTER TABLE monthly_plan_blocks      ENABLE TRIGGER monthly_plan_child_guard;
ALTER TABLE monthly_plan_block_trips ENABLE TRIGGER monthly_plan_child_guard;
ALTER TABLE monthly_plan_drivers     ENABLE TRIGGER monthly_plan_driver_guard;
COMMIT;

-- ─── the verdict ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_ok   bigint;
  v_bad  bigint;
  v_list text;
BEGIN
  PERFORM _mptr_expect('the fixtures are gone, and all four guards are back', '0|0|0|4',
    (SELECT count(*) FROM monthly_plans WHERE year = 2064)::text || '|'
    || (SELECT count(*) FROM companies WHERE id = _mptr_id('company'))::text || '|'
    || (SELECT count(*) FROM drivers WHERE id IN (_mptr_id('driver'), _mptr_id('driver:own')))::text || '|'
    || (SELECT count(*) FROM pg_trigger g
         WHERE g.tgname IN ('monthly_plan_guard', 'monthly_plan_child_guard', 'monthly_plan_driver_guard')
           AND NOT g.tgisinternal AND g.tgenabled = 'O')::text);

  SELECT count(*) FILTER (WHERE r.ok),
         count(*) FILTER (WHERE NOT r.ok),
         string_agg(format(E'  #%s %s\n      expected [%s]\n      got      [%s]',
                           r.n, r.label, r.expected, r.actual), E'\n' ORDER BY r.n) FILTER (WHERE NOT r.ok)
    INTO v_ok, v_bad, v_list
    FROM _mptr_results r;

  RAISE NOTICE 'monthly plans, two sessions: % checks, % passed, % differ', v_ok + v_bad, v_ok, v_bad;

  IF v_bad > 0 THEN
    RAISE EXCEPTION E'monthly plans, two sessions: % check(s) differ from what migration 20261023110000 promises\n%',
      v_bad, v_list;
  END IF;
END $$;
