/*
  Driver month assignments: the month-end record of who drove, and the gate that
  keeps it from being written too early (migration 20261023120000).

  Runs after the files before it, against the same throwaway database, as
  supabase_admin. The whole file is one transaction rolled back at the end, so
  the files after it -- matrix.sql among them, which sorts later -- see the
  database as the seeds left it.

  ── HOW THIS FILE REPORTS ────────────────────────────────────────────────────

  Every probe RECORDS its outcome in a table and the file asserts them all at
  the end (Docs/operating-rules.md, section 6): one run answers every question
  instead of the first wrong guess hiding the rest. Each line prints what the
  probe actually returned, in brackets, and a mismatch prints DIFF with the
  expected and the actual text. A statement that fails for a reason this file did
  not expect still aborts it, which is the right behaviour for a fixture.

  A PROBE WHOSE REFUSALS SHARE ONE CLASS MEASURES NOTHING, and this kit has been
  bitten by that twice in one day. The whole point of the gate is that it is a
  DIFFERENT refusal from the tenancy and role walls beside it, so every kind is
  asserted by its exact text and no two of them print the same thing:

      new row violates row-level security policy for table "…"   a policy
      privilege table <name> / privilege function <name>          a missing GRANT
      not_authorized                                              the role gate of an RPC
      no_company                                                  the state gate of an RPC
      unauthenticated                                              no subject at all
      driver_month_assignment_month_not_ended                      THE GATE
      driver_month_assignment_driver_mismatch                      the driver's company
      driver_month_assignment_plan_mismatch                        the plan's company or month
      driver_month_assignment_key_fixed                            the key, and the early record
      driver_month_assignment_is_final                             the freeze
      driver_month_assignment_shift_plan_mismatch                  a window of another plan
      driver_month_assignment_shift_minutes_mismatch               a length the window has not
      driver_month_assignment_transition_needs_rpc                 a status moved by hand
      23514 / 23505 + the constraint's own name                    a CHECK or a unique index

  A missing GRANT is reported by what was refused, read out of PostgreSQL's own
  message ("permission denied for table X"), and never by the HINT: the
  supabase/postgres image of 17.6 adds a prose hint to that error that
  PostgreSQL 16 does not write, and the first VPS run of
  tests/rls/vehicle-day-plans.sql differed on exactly two lines for that reason.
  The SQLSTATE and the object's name are what is stable.

  ── THE CLOCK, AND WHY THIS FILE DOES NOT AGE ────────────────────────────────

  The gate reads today's date in Europe/Berlin, so a file that probed it against
  "next month" would pass this year and fail the next. Every gate probe therefore
  uses one of exactly two months:

      January 2020    ended long ago, in every year this file will ever run
      December 2099   will not have ended in any of them

  so "the month is over" and "the month is not over" are both constants here, and
  the assertions mean the same thing in 2027 as in 2026. The migration's own
  self-check 10a asserts the helper on the same two literals.

  ── WHY EVERY SECTION HAS ITS OWN DRIVER AND ITS OWN WINDOWS ─────────────────

  The first draft of this file shared one driver and four windows between the
  sections, and that was wrong in a way worth recording: a window a release had
  freed, a draft an earlier section had left behind and a live row the partial
  unique index refuses a second of all made later sections answer something other
  than what their label claimed -- and every one of those would have read as a
  defect in the migration. The fixture therefore gives EACH SECTION its own
  drivers and its own vehicle windows, listed below with the section that owns
  them, so a section's state is local and can be reasoned about exactly.

  ── WHAT IS COVERED ──────────────────────────────────────────────────────────

    1. shape        both tables: RLS, exactly the four policies of the project's
                    one shape (SELECT is the tenant term or the read seam, with no
                    role term; every write repeats one predicate as USING and as
                    WITH CHECK plus the Dokumente page), both context triggers,
                    the guard, privileges, the seven functions, the two keys, and
                    the boundary (no ride, address, fare or pipeline reference)
    2. THE GATE     the two months; refused for a month that has not ended;
                    allowed with a reason and the shortfall the DATABASE
                    measured; the reason dropped once the month is over; the
                    warning unerasable afterwards; the wall in the GUARD and not
                    only in the RPC; and the CHECK that carries the half the
                    clock cannot
    3. the record   the four figures are the database's on the save, re-derived
                    from the windows on the commit, and KEPT when a release
                    deletes them; a freed window is taken at once; the closed list
                    of reasons is the constraint's
    4. tenancy      a member reads only its own company; an assignment cannot be
                    moved, by the guard AND, with the guard off, by the policy's
                    WITH CHECK; a driver, a plan of another company and a plan of
                    another month, each by its own hint; a window of another plan
                    and a length the window has not
    5. role gate    viewer and editor read and write nothing, directly or through
                    any of the three RPCs; a supervisor assigns
    6. one each     one LIVE assignment per driver and month, by the index; one
                    driver per window, by the constraint and by the save's own
                    reason
    7. lifecycle    save, commit, release; the freeze on the row and on its
                    windows; status only through the RPCs; a draft may go
    8. the RPCs     what each refuses, by name: an unknown payload key, an id that
                    is not a uuid, the same window twice, no confirmed plan, a
                    window outside it, a driver of another company, a driver in
                    two places at once, an empty assignment, a plan that stopped
                    being the active one, and the two broken contracts
    9. state        a suspended company, a platform owner with no context, anon,
                    and a token with no subject
   10. contexts     a view context reads the opened company and writes nothing; a
                    support session writes, commits and releases, and each row
                    leaves one audit row
   11. deletion     a company, a DRIVER and a vehicle day plan that hold a
                    COMMITTED assignment can still be deleted (the defect
                    20261016140000 fixed for the monthly plan), while the same
                    delete of the one row is refused
   12. mutations    fourteen controls: break one rule inside a subtransaction,
                    require the probe to notice, and let the rollback restore it.
                    M14 is the one whose first expectation was WRONG and whose
                    measurement is the better statement: a view context meets two
                    independent walls here, so dropping the refusal trigger leaves
                    the Dokumente page gate standing. Its own comment has the
                    numbers.

  The matrix lines for both tables, and the EXECUTE grants of the three RPCs, are
  in tests/rls/matrix.sql.

  WHAT IS NOT HERE AND WHY. The two-session races (a window written while a commit
  is open, in either order) are the same shape as
  tests/rls/vehicle-day-two-sessions.sql, which already drives that pattern
  through dblink for the parent this table hangs off; the properties one session
  cannot reach -- parent_is_open reading FOR KEY SHARE and never FOR UPDATE, the
  commit reading FOR UPDATE, the single-pass overlap check -- are asserted from the
  source in the migration's self-check 15. And nothing here touches phase 1, phase
  3, phase 4, the repair pass, the finalization checks or any document builder:
  this slice added a table beside that pipeline and did not rewire it, which
  self-check 9 enforces from the catalogue and section 1 re-asserts.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in vehicle-day-plans.sql) ─────────────────────────────

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS banned_until       timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at         timestamptz,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS auth.sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  not_after  timestamptz
);

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _dma_results (
  n        serial PRIMARY KEY,
  label    text   NOT NULL,
  expected text,
  actual   text,
  ok       boolean NOT NULL
);

/* Record one outcome and print it. A NULL actual never equals anything. */
CREATE OR REPLACE FUNCTION _dma_expect(p_label text, p_expected text, p_actual text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean := p_actual IS NOT DISTINCT FROM p_expected;
BEGIN
  INSERT INTO _dma_results (label, expected, actual, ok) VALUES (p_label, p_expected, p_actual, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok   % [%]', p_label, p_actual;
  ELSE
    RAISE NOTICE 'DIFF % -- expected [%] got [%]', p_label, p_expected, p_actual;
  END IF;
END $$;

/* A boolean check. NULL is a failure: a check that could not be evaluated proved nothing. */
CREATE OR REPLACE FUNCTION _dma_ok(p_label text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _dma_expect(p_label, 'true', coalesce(p_ok::text, 'NULL'));
END $$;

CREATE OR REPLACE FUNCTION _dma_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('dma:' || p_what)::uuid $$;

CREATE OR REPLACE FUNCTION _dma_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

CREATE OR REPLACE FUNCTION _dma_owner() RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid $$;
CREATE OR REPLACE FUNCTION _dma_nobody() RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid $$;

/* Become a signed-in caller with a password sign-in (and, when given, the session
   a platform context is answered to) -- or anon when p_user is NULL. Two
   sentinels: _dma_owner() keeps the table owner, to probe what no policy is asked
   about, and _dma_nobody() is the authenticated role with no subject. */
CREATE OR REPLACE FUNCTION _dma_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _dma_reset();
  IF p_user = _dma_owner() THEN
    RETURN;
  END IF;
  IF p_user = _dma_nobody() THEN
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    RETURN;
  END IF;
  IF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  IF p_session IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.session_id', p_session::text, true);
  END IF;
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/* What a refusal is reported as, after its SQLSTATE. See the header: a missing
   GRANT is read out of PostgreSQL's own message, a policy prints the message that
   names the table, a CHECK and a unique index print their own constraint's name,
   and every guard and RPC of this migration prints its own snake_case hint. */
CREATE OR REPLACE FUNCTION _dma_reason(p_state text, p_message text, p_hint text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_state = '42501' AND p_message ~ '^permission denied for (table|function|schema) '
      THEN 'privilege ' || regexp_replace(p_message, '^permission denied for (table|function|schema) .*$', '\1')
           || ' ' || regexp_replace(p_message, '^permission denied for (table|function|schema) ', '')
    WHEN p_state = '23514' AND p_message ~ 'violates check constraint'
      THEN regexp_replace(p_message, '^.*violates check constraint "([^"]+)".*$', '\1')
    WHEN p_state = '23505' AND p_message ~ 'violates unique constraint'
      THEN regexp_replace(p_message, '^.*violates unique constraint "([^"]+)".*$', '\1')
    WHEN p_hint ~ '^[a-z][a-z0-9_]*$' THEN p_hint
    ELSE p_message
  END
$$;

/* Run p_sql as that caller in a subtransaction that is always rolled back and
   return the scalar it answered, `rows N` for a statement without a result (a DO
   block always answers `rows 0`), or `ERR <sqlstate> <reason>`. Nothing it writes
   survives. A statement the server cancels is reported as ERR 57014: WHEN OTHERS
   does not catch it, and an uncaught one would end the file. */
CREATE OR REPLACE FUNCTION _dma_try(p_user uuid, p_session uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
  v_hint  text;
BEGIN
  BEGIN
    PERFORM _dma_as(p_user, p_session);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ031', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ031' THEN
      v_out := SQLERRM;
    WHEN query_canceled THEN
      v_out := 'ERR 57014 ' || SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_hint = PG_EXCEPTION_HINT;
      v_out := 'ERR ' || v_state || ' ' || _dma_reason(v_state, v_msg, v_hint);
  END;
  PERFORM _dma_reset();
  RETURN v_out;
END $$;

/* The same probe with a rule broken first. p_mutation runs as the owner inside
   the subtransaction (a DO block, so it may hold several statements and DDL), the
   probe then runs as the caller, and the whole subtransaction -- the mutation
   with it -- is rolled back. */
CREATE OR REPLACE FUNCTION _dma_mutant(p_mutation text, p_user uuid, p_session uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text;
BEGIN
  BEGIN
    PERFORM _dma_reset();
    EXECUTE p_mutation;
    v_out := _dma_try(p_user, p_session, p_sql);
    RAISE EXCEPTION USING ERRCODE = 'ZZ032', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ032' THEN
      v_out := SQLERRM;
  END;
  PERFORM _dma_reset();
  RETURN v_out;
END $$;

/* A mutation of one function: take its live definition from the catalogue,
   replace one fragment and install the result. It REFUSES when the fragment is
   not there, because a mutation that changes nothing would make its control pass
   for the wrong reason. Every fragment below is on ONE line of the function's
   source: a multi-line fragment has to reproduce the indentation exactly, and a
   control that silently stopped matching would be the same defect this guard
   exists to prevent. */
CREATE OR REPLACE FUNCTION _dma_mutate_fn(p_sig text, p_from text, p_to text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_old text := pg_get_functiondef(to_regprocedure(p_sig));
BEGIN
  IF v_old IS NULL OR position(p_from IN v_old) = 0 THEN
    RAISE EXCEPTION 'mutation control: % does not contain [%], so the mutation would change nothing', p_sig, p_from;
  END IF;
  EXECUTE replace(v_old, p_from, p_to);
END $$;

/* The statement that moves one row. SELECT ... FOR UPDATE takes the row (which
   applies the UPDATE policy's USING to the existing row) and UPDATE ... WHERE
   CURRENT OF sets p_set without reading a column, so the new row meets the UPDATE
   policy's WITH CHECK and nothing else. A plain UPDATE ... WHERE id reads a
   column, and PostgreSQL then also asks the SELECT policy about the new row,
   which would let a tenant-scoped SELECT policy hide a WITH CHECK that lets the
   row go anywhere. A successful move answers `rows 0`, because a DO block does. */
CREATE OR REPLACE FUNCTION _dma_move_sql(p_table text, p_id uuid, p_set text) RETURNS text
LANGUAGE sql IMMUTABLE AS $body$
  SELECT format($f$DO $q$
    DECLARE
      c refcursor := 'dma_move';
      r integer;
    BEGIN
      OPEN c FOR SELECT 1 FROM %I WHERE id = %L FOR UPDATE;
      FETCH c INTO r;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'the row is out of reach' USING ERRCODE = 'ZZ041';
      END IF;
      UPDATE %I SET %s WHERE CURRENT OF c;
      CLOSE c;
    END $q$$f$, p_table, p_id, p_table, p_set)
$body$;

/* The audit log's high-water mark, so each check counts only its own rows. */
CREATE OR REPLACE FUNCTION _dma_mark() RETURNS bigint
LANGUAGE sql AS $$ SELECT coalesce(max(l.id), 0) FROM app_private.platform_audit_log l $$;

CREATE OR REPLACE FUNCTION _dma_rows(p_since bigint, p_action text DEFAULT NULL) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*)
    FROM app_private.platform_audit_log l
   WHERE l.id > p_since
     AND l.action ~ '^support_write\.'
     AND (p_action IS NULL OR l.action = p_action)
$$;

/* One vehicle window, written as the owner into a DRAFT plan (RLS does not apply
   to the owner; 20261022140000's guards do, so the plan has to be a draft and the
   moments have to follow from its stored hour). Every window below is twelve
   15-minute slots, so each is 180 minutes long. */
CREATE OR REPLACE FUNCTION _dma_put_shift(p_company uuid, p_plan uuid, p_date date, p_vehicle text,
                                          p_index integer, p_from integer, p_to integer,
                                          p_hour integer DEFAULT 4, p_slot integer DEFAULT 15)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO vehicle_day_shifts (id, company_id, plan_id, operating_date, vehicle, shift_index,
                                  start_position, end_position, starts_local, ends_local, minutes,
                                  day_type, is_holiday, expected_revenue_cents,
                                  expected_revenue_per_hour_cents, confidence, evidence_days)
  VALUES (v_id, p_company, p_plan, p_date, p_vehicle, p_index, p_from, p_to,
          p_date::timestamp + make_interval(mins => p_hour * 60 + p_from * p_slot),
          p_date::timestamp + make_interval(mins => p_hour * 60 + p_to   * p_slot),
          (p_to - p_from) * p_slot,
          EXTRACT(ISODOW FROM p_date)::integer - 1, false, 12345, 4115, 'high', 9);
  RETURN v_id;
END $$;

/*
  Confirm a vehicle day plan AS A FIXTURE, without going through
  vehicle_day_plan_confirm. Needed for the suspended company, whose administrator
  gets no_company from get_active_company_id() and so cannot call that RPC at all.

  It sets 20261022140000's own transition marker by hand, exactly as that function
  does, and it sets request.jwt.claim.sub WITHOUT switching role: the plan guard
  writes confirmed_by := auth.uid(), and vehicle_day_plans_confirmed_together
  pairs that column with confirmed_at, so a confirmation with no subject at all
  would fail that CHECK. Staying the owner keeps RLS out of the fixture.
*/
CREATE OR REPLACE FUNCTION _dma_confirm_plan(p_plan uuid, p_actor uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_actor::text, true);
  PERFORM set_config('app_private.vehicle_day_plan_transition',
                     'plan:' || p_plan::text || ':' || pg_current_xact_id()::text, true);
  UPDATE vehicle_day_plans SET status = 'confirmed' WHERE id = p_plan;
  PERFORM set_config('app_private.vehicle_day_plan_transition', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
END $$;

/* The save RPC's payload, spelled once. p_early NULL means "send no reason at
   all", which is not the same as sending an empty one (section 2 probes both). */
CREATE OR REPLACE FUNCTION _dma_payload(p_year integer, p_month integer, p_driver uuid,
                                        p_ids uuid[], p_early text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('year', p_year, 'month', p_month, 'driver_id', p_driver,
                            'shift_ids', to_jsonb(coalesce(p_ids, ARRAY[]::uuid[])))
         || CASE WHEN p_early IS NULL THEN '{}'::jsonb
                 ELSE jsonb_build_object('early_reason', p_early) END
$$;

-- ─── principals, drivers and windows ────────────────────────────────────────
--
-- seed.sql's two companies and their people (admin-a, editor-a, viewer-a,
-- admin-b, and `super`, a platform owner with no session), plus a supervisor, a
-- suspended company with an administrator and a driver, and two company-less
-- platform owners with a session each: one opens a view context on company A, the
-- other a support session.

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
VALUES (_dma_id('company:suspended'), 'DMA suspended', 'dma-suspended', 'approved', 'suspended', 'basic', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT _dma_id('user:' || v.who), 'dma-' || v.who || '@test.invalid', now()
FROM (VALUES ('supervisor-a'), ('admin-suspended'), ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
SELECT _dma_id('user:' || v.who), 'dma-' || v.who || '@test.invalid', 'DMA ' || v.who, v.role,
       (SELECT r.id FROM roles r WHERE r.name = v.role AND r.company_id IS NULL),
       v.company_id, 'active'
FROM (VALUES
  ('supervisor-a',    'supervisor', 'c0000000-0000-4000-8000-00000000000a'::uuid),
  ('admin-suspended', 'admin',      _dma_id('company:suspended')),
  ('owner-view',      'viewer',     NULL::uuid),
  ('owner-support',   'viewer',     NULL::uuid)
) AS v(who, role, company_id)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES (_dma_id('user:owner-view'),    'owner', 'dma'),
       (_dma_id('user:owner-support'), 'owner', 'dma')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
SELECT _dma_id('session:' || v.who), _dma_id('user:' || v.who)
FROM (VALUES ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

-- ONE DRIVER PER SECTION (see the header): d<section>, and d<section>b where a
-- section needs a second. seed.sql's own driver of company A is left alone, so
-- the files after this one find it as they left it.
INSERT INTO drivers (id, company_id, name)
SELECT _dma_id('driver:' || v.who), 'c0000000-0000-4000-8000-00000000000a', 'DMA ' || v.who
FROM (VALUES ('d2'), ('d2b'), ('d3'), ('d3b'), ('d4'), ('d5'), ('d5b'),
             ('d6'), ('d6b'), ('d7'), ('d8'), ('d10'), ('d12'), ('d12b'), ('d12c')) AS v(who)
ON CONFLICT (id) DO NOTHING;

INSERT INTO drivers (id, company_id, name)
VALUES (_dma_id('driver:susp'), _dma_id('company:suspended'), 'DMA Driver S')
ON CONFLICT (id) DO NOTHING;

-- Four vehicle day plans, each a draft first so its windows can be written, then
-- confirmed: company A for both months, company B and the suspended company for
-- January 2020.
INSERT INTO vehicle_day_plans (id, company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version)
VALUES
  (_dma_id('plan:a-2020'), 'c0000000-0000-4000-8000-00000000000a', 2020,  1, 4, 15, 'shift-recommendation/1.0.0'),
  (_dma_id('plan:a-2099'), 'c0000000-0000-4000-8000-00000000000a', 2099, 12, 4, 15, 'shift-recommendation/1.0.0'),
  (_dma_id('plan:b-2020'), 'c0000000-0000-4000-8000-00000000000b', 2020,  1, 4, 15, 'shift-recommendation/1.0.0'),
  (_dma_id('plan:s-2020'), _dma_id('company:suspended'),           2020,  1, 4, 15, 'shift-recommendation/1.0.0');

/*
  ONE SET OF WINDOWS PER SECTION. Under hour 4 and 15-minute slots, positions
  24..36 are 10:00-13:00 and 40..52 are 14:00-17:00, so every window is 180
  minutes and two windows of one vehicle on one day do not overlap. The two pairs
  that DO overlap are deliberate and are named: 4b against 4a, and 8b against 8a,
  both 11:00-14:00 against 10:00-13:00 on another vehicle on the same day, which
  is exactly "one driver, two places at once" and not "one vehicle, two places".
*/
CREATE TEMP TABLE _dma_w (name text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO _dma_w (name, id) VALUES
  ('2a',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-02', 'DMA-02', 0, 24, 36)),
  ('3a',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-03', 'DMA-03', 0, 24, 36)),
  ('3b',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-03', 'DMA-03', 1, 40, 52)),
  ('3c',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-06', 'DMA-04', 0, 24, 36)),
  ('4a',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-08', 'DMA-05', 0, 24, 36)),
  ('4b',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-08', 'DMA-06', 0, 28, 40)),
  ('5a',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-09', 'DMA-07', 0, 24, 36)),
  ('5b',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-09', 'DMA-08', 0, 24, 36)),
  ('6a',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-10', 'DMA-09', 0, 24, 36)),
  ('6b',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-13', 'DMA-09', 0, 24, 36)),
  ('7a',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-14', 'DMA-10', 0, 24, 36)),
  ('7b',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-15', 'DMA-10', 0, 24, 36)),
  ('8a',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-16', 'DMA-11', 0, 24, 36)),
  ('8b',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-16', 'DMA-12', 0, 28, 40)),
  ('10a', _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-20', 'DMA-13', 0, 24, 36)),
  ('12a', _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-21', 'DMA-14', 0, 24, 36)),
  ('12b', _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2020'), DATE '2020-01-22', 'DMA-14', 0, 24, 36)),
  ('f1',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2099'), DATE '2099-12-01', 'DMA-FUT-1', 0, 24, 36)),
  ('f2',  _dma_put_shift('c0000000-0000-4000-8000-00000000000a', _dma_id('plan:a-2099'), DATE '2099-12-02', 'DMA-FUT-2', 0, 24, 36)),
  ('b1',  _dma_put_shift('c0000000-0000-4000-8000-00000000000b', _dma_id('plan:b-2020'), DATE '2020-01-02', 'DMA-B', 0, 24, 36)),
  ('s1',  _dma_put_shift(_dma_id('company:suspended'),           _dma_id('plan:s-2020'), DATE '2020-01-02', 'DMA-S', 0, 24, 36));

SELECT _dma_confirm_plan(_dma_id('plan:a-2020'), 'a0000000-0000-4000-8000-000000000001');
SELECT _dma_confirm_plan(_dma_id('plan:a-2099'), 'a0000000-0000-4000-8000-000000000001');
SELECT _dma_confirm_plan(_dma_id('plan:b-2020'), 'b0000000-0000-4000-8000-000000000001');
SELECT _dma_confirm_plan(_dma_id('plan:s-2020'), _dma_id('user:admin-suspended'));

-- The suspended company holds one assignment and one claimed window, written as
-- the owner. Without it section 9's "reads none of them" would be counting an
-- empty table and measuring nothing.
INSERT INTO driver_month_assignments (id, company_id, year, month, driver_id, plan_id,
                                      assigned_shift_count, assigned_minutes,
                                      assigned_vehicle_count, assigned_day_count)
VALUES (_dma_id('assignment:susp'), _dma_id('company:suspended'), 2020, 1,
        _dma_id('driver:susp'), _dma_id('plan:s-2020'), 1, 180, 1, 1);
INSERT INTO driver_month_assignment_shifts (company_id, assignment_id, shift_id, minutes)
VALUES (_dma_id('company:suspended'), _dma_id('assignment:susp'),
        (SELECT id FROM _dma_w WHERE name = 's1'), 180);

-- ─── 1. shape ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tbl    text;
  v_sig    text;
  v_wrong  text;
  c_tables CONSTANT text[] := ARRAY['driver_month_assignments', 'driver_month_assignment_shifts'];
  c_funcs  CONSTANT text[] := ARRAY['app_private.driver_month_assignment_guard()',
                                    'app_private.driver_month_assignment_shift_guard()',
                                    'app_private.driver_month_assignment_parent_is_open(uuid,uuid)',
                                    'app_private.driver_month_assignment_days_remaining(integer,integer)',
                                    'public.driver_month_assignment_save(jsonb)',
                                    'public.driver_month_assignment_commit(uuid)',
                                    'public.driver_month_assignment_release(uuid,text,text)'];
BEGIN
  FOREACH v_tbl IN ARRAY c_tables LOOP
    PERFORM _dma_ok(format('shape: %s has row level security on', v_tbl),
      (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', v_tbl)::regclass));

    PERFORM _dma_ok(format('shape: %s carries exactly the four policies, for authenticated alone', v_tbl),
      (SELECT array_agg(p.policyname::text ORDER BY p.policyname)
         FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_tbl)
        = ARRAY[v_tbl || '_delete', v_tbl || '_insert', v_tbl || '_select', v_tbl || '_update']
      AND NOT EXISTS (SELECT 1 FROM pg_policies p
                       WHERE p.schemaname = 'public' AND p.tablename = v_tbl
                         AND p.roles <> ARRAY['authenticated']::name[]));

    PERFORM _dma_ok(format('shape: %s SELECT is the tenant term or the read seam, with no role term', v_tbl),
      (SELECT p.qual ~ 'get_active_company_id' AND p.qual ~ 'platform_reads_company_data'
          AND p.qual !~ 'current_role_permits'
         FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd = 'SELECT'));

    SELECT string_agg(format('%s (%s)', p.policyname, p.cmd), ', ' ORDER BY p.policyname) INTO v_wrong
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd <> 'SELECT'
       AND NOT ((coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'get_active_company_id'
            AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'current_role_permits\(''documents'''
            AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'platform_writes_company_data');
    PERFORM _dma_expect(format('shape: every write policy of %s asks the tenant term, the Dokumente page and the write seam', v_tbl),
      '<null>', coalesce(v_wrong, '<null>'));

    PERFORM _dma_ok(format('shape: %s UPDATE states one predicate as USING and as WITH CHECK', v_tbl),
      (SELECT p.qual = p.with_check FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd = 'UPDATE'));

    PERFORM _dma_ok(format('shape: %s carries the view-context refusal trigger', v_tbl),
      EXISTS (SELECT 1 FROM pg_trigger g
               WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                 AND g.tgname = 'refuse_read_only_context_write'
                 AND NOT g.tgisinternal AND g.tgtype = 30 AND g.tgenabled = 'O'
                 AND g.tgfoid = 'app_private.refuse_read_only_context_write()'::regprocedure));
    PERFORM _dma_ok(format('shape: %s carries the gated support-write audit trigger', v_tbl),
      EXISTS (SELECT 1 FROM pg_trigger g
               WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                 AND g.tgname = 'record_support_write'
                 AND NOT g.tgisinternal AND g.tgtype = 29 AND g.tgenabled = 'O'
                 AND g.tgqual IS NOT NULL
                 AND g.tgfoid = 'app_private.record_support_write()'::regprocedure));

    PERFORM _dma_ok(format('shape: anon and the service role hold nothing on %s', v_tbl),
      NOT has_table_privilege('anon', format('public.%I', v_tbl), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_table_privilege('service_role', format('public.%I', v_tbl), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
    PERFORM _dma_ok(format('shape: authenticated holds the four DML commands on %s and nothing else', v_tbl),
      has_table_privilege('authenticated', format('public.%I', v_tbl), 'SELECT')
      AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'INSERT')
      AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'UPDATE')
      AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'DELETE')
      AND NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'TRUNCATE,REFERENCES,TRIGGER'));

    PERFORM _dma_ok(format('shape: %s carries its OWN guard as a BEFORE INSERT OR UPDATE OR DELETE row trigger', v_tbl),
      EXISTS (SELECT 1 FROM pg_trigger g
               WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                 AND NOT g.tgisinternal AND g.tgtype = 31 AND g.tgenabled = 'O'
                 AND g.tgfoid = CASE v_tbl
                                  WHEN 'driver_month_assignments'
                                    THEN 'app_private.driver_month_assignment_guard()'::regprocedure
                                  ELSE 'app_private.driver_month_assignment_shift_guard()'::regprocedure
                                END));
  END LOOP;

  FOREACH v_sig IN ARRAY c_funcs LOOP
    PERFORM _dma_ok(format('shape: %s is SECURITY DEFINER with a pinned search_path', v_sig),
      (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig))
      AND EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                   WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=pg_catalog,%'));
    PERFORM _dma_ok(format('shape: neither anon nor the service role may call %s', v_sig),
      NOT has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
      AND NOT has_function_privilege('service_role', to_regprocedure(v_sig), 'EXECUTE'));
    IF v_sig LIKE 'app\_private.%' THEN
      PERFORM _dma_ok(format('shape: authenticated may not call %s', v_sig),
        NOT has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE'));
    ELSE
      PERFORM _dma_ok(format('shape: authenticated may call %s, and it is VOLATILE', v_sig),
        has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE')
        AND (SELECT p.provolatile FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) = 'v');
    END IF;
  END LOOP;

  PERFORM _dma_ok('shape: one LIVE assignment per company, month and driver, by a partial unique index',
    (SELECT pg_get_indexdef(i.indexrelid) ~ 'CREATE UNIQUE INDEX'
        AND pg_get_indexdef(i.indexrelid) ~ 'company_id, year, month, driver_id'
        AND pg_get_indexdef(i.indexrelid) ~ 'WHERE \(status <> ''released''::text\)'
       FROM pg_index i
      WHERE i.indexrelid = to_regclass('public.driver_month_assignments_one_live_per_driver')));
  PERFORM _dma_ok('shape: one driver per vehicle window, by a UNIQUE constraint and not by a comment',
    (SELECT pg_get_constraintdef(c.oid) ~ '^UNIQUE \(shift_id\)'
       FROM pg_constraint c
      WHERE c.conrelid = 'public.driver_month_assignment_shifts'::regclass
        AND c.conname = 'driver_month_assignment_shifts_one_claim_per_shift'));

  -- The boundary: no ride, address, fare or payroll figure, and no key into the
  -- pipeline this slice must not touch. A DRIVER column is the point of the table
  -- and is deliberately not on the list, which is where this differs from
  -- 20261022140000's rule 2.
  SELECT string_agg(format('%s.%s', c.relname, a.attname), ', ' ORDER BY 1) INTO v_wrong
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.oid IN ('public.driver_month_assignments'::regclass,
                   'public.driver_month_assignment_shifts'::regclass)
     AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname ~ '(^|_)(ride|trip|fahrt|address|adresse|fare|tip|trinkgeld|passenger|customer|pickup|destination|route|gps|lat|lng|lohnart|brutto|netto)(_|$)';
  PERFORM _dma_expect('shape: no column is named like a ride, an address, a fare or a payroll figure',
    '<null>', coalesce(v_wrong, '<null>'));
  SELECT string_agg(c.conname, ', ') INTO v_wrong
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.conrelid IN ('public.driver_month_assignments'::regclass,
                        'public.driver_month_assignment_shifts'::regclass)
     AND c.confrelid IN (to_regclass('public.fahrtenbuch_trips'),
                         to_regclass('public.fahrtenbuch_imports'),
                         to_regclass('public.company_planning_runs'),
                         to_regclass('public.saved_stundennachweise'));
  PERFORM _dma_expect('shape: no foreign key reaches the trips, the imports, a planning run or a saved Stundennachweis',
    '<null>', coalesce(v_wrong, '<null>'));
END $$;

-- ─── 2. THE MONTH-END GATE ──────────────────────────────────────────────────
--
-- The feature this slice exists for, and the section to read first. Drivers d2
-- and d2b, windows 2a, f1.

DO $$
DECLARE
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_co_a  CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_d2    CONSTANT uuid := _dma_id('driver:d2');
  v_2a    uuid := (SELECT id FROM _dma_w WHERE name = '2a');
  v_f1    uuid := (SELECT id FROM _dma_w WHERE name = 'f1');
  v_res   jsonb;
  v_left  integer;
BEGIN
  -- (a) The clock itself, on the two literals.
  PERFORM _dma_expect('gate: January 2020 has ended, so no days remain before assignment opens', '0',
    app_private.driver_month_assignment_days_remaining(2020, 1)::text);
  PERFORM _dma_ok('gate: December 2099 has not ended, so days still remain',
    app_private.driver_month_assignment_days_remaining(2099, 12) > 0);
  v_left := app_private.driver_month_assignment_days_remaining(2099, 12);

  -- (b) A month that has ended: the ordinary path, no warning anywhere.
  PERFORM _dma_as(c_admin);
  v_res := public.driver_month_assignment_save(_dma_payload(2020, 1, c_d2, ARRAY[v_2a]));
  PERFORM _dma_reset();
  PERFORM _dma_expect('gate: a month that has ended is assigned with no reason and no warning', 'true|false|0',
    (v_res ->> 'success') || '|' || (v_res ->> 'opened_early') || '|' || (v_res ->> 'days_remaining'));
  PERFORM _dma_expect('gate: …and the stored row records no early opening', 'false|<null>|<null>',
    (SELECT a.opened_early::text || '|' || coalesce(a.early_reason, '<null>')
            || '|' || coalesce(a.early_days_remaining::text, '<null>')
       FROM driver_month_assignments a WHERE a.id = (v_res ->> 'assignment_id')::uuid));

  -- (c) A month that has NOT ended, with no reason: refused BY RETURN VALUE, and
  --     the answer carries the number of days, which is what lets a screen offer
  --     the early opening instead of showing a raw error.
  PERFORM _dma_as(c_admin);
  v_res := public.driver_month_assignment_save(_dma_payload(2099, 12, c_d2, ARRAY[v_f1]));
  PERFORM _dma_reset();
  PERFORM _dma_expect('gate: a month that has not ended is refused, by return value, with the days still to run',
    'false|month_not_ended|' || v_left::text,
    (v_res ->> 'success') || '|' || (v_res ->> 'reason') || '|' || (v_res ->> 'days_remaining'));
  PERFORM _dma_expect('gate: …and nothing was written', '0',
    (SELECT count(*)::text FROM driver_month_assignments a
      WHERE a.company_id = c_co_a AND a.year = 2099 AND a.month = 12));

  -- (d) The same month WITH a reason: allowed, and the warning is the database's.
  PERFORM _dma_as(c_admin);
  v_res := public.driver_month_assignment_save(
    _dma_payload(2099, 12, c_d2, ARRAY[v_f1], 'Fahrer verlaesst das Unternehmen zum Monatsende'));
  PERFORM _dma_reset();
  PERFORM _dma_expect('gate: with a reason the same month is assigned, and the answer says it was early', 'true|true',
    (v_res ->> 'success') || '|' || (v_res ->> 'opened_early'));
  PERFORM _dma_expect('gate: …and the stored row carries the reason and the shortfall THE DATABASE measured',
    'true|Fahrer verlaesst das Unternehmen zum Monatsende|' || v_left::text,
    (SELECT a.opened_early::text || '|' || a.early_reason || '|' || a.early_days_remaining::text
       FROM driver_month_assignments a WHERE a.id = (v_res ->> 'assignment_id')::uuid));

  -- (e) A reason sent for a month that HAS ended is dropped: nothing was early.
  PERFORM _dma_as(c_admin);
  v_res := public.driver_month_assignment_save(_dma_payload(2020, 1, c_d2, ARRAY[v_2a], 'nicht noetig'));
  PERFORM _dma_reset();
  PERFORM _dma_expect('gate: a reason sent for a month that has ended is dropped, because nothing was early',
    'true|false|<null>',
    (v_res ->> 'success') || '|'
    || (SELECT a.opened_early::text || '|' || coalesce(a.early_reason, '<null>')
          FROM driver_month_assignments a WHERE a.id = (v_res ->> 'assignment_id')::uuid));
END $$;

DO $$
DECLARE
  c_admin  CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_co_a   CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_d2b    CONSTANT uuid := _dma_id('driver:d2b');
  c_plan99 CONSTANT uuid := _dma_id('plan:a-2099');
  v_early  uuid := (SELECT a.id FROM driver_month_assignments a
                     WHERE a.company_id = c_co_a AND a.year = 2099 AND a.month = 12 LIMIT 1);
BEGIN
  PERFORM _dma_ok('gate: the early-opened row of (d) is the one row of December 2099', v_early IS NOT NULL);

  -- (f) THE WALL. The gate is in the GUARD, not only in the RPC, so a second
  --     caller writing the table directly meets exactly the same question -- and
  --     with its own hint, which no other refusal in this file prints. Driver d2b,
  --     which holds no live row, so what answers is the gate and never the index.
  PERFORM _dma_expect('gate: a DIRECT insert for a month that has not ended is refused by the guard',
    'ERR P0001 driver_month_assignment_month_not_ended',
    _dma_try(c_admin, NULL, format(
      'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id) VALUES (%L, 2099, 12, %L, %L)',
      c_co_a, c_d2b, c_plan99)));
  PERFORM _dma_expect('gate: …claiming opened_early without a reason does not get past it either',
    'ERR P0001 driver_month_assignment_month_not_ended',
    _dma_try(c_admin, NULL, format(
      'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id, opened_early) VALUES (%L, 2099, 12, %L, %L, true)',
      c_co_a, c_d2b, c_plan99)));
  PERFORM _dma_expect('gate: …and a blank reason is no reason',
    'ERR P0001 driver_month_assignment_month_not_ended',
    _dma_try(c_admin, NULL, format(
      'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id, early_reason) VALUES (%L, 2099, 12, %L, %L, ''   '')',
      c_co_a, c_d2b, c_plan99)));
  PERFORM _dma_expect('gate: a direct insert WITH a reason is stored, and the guard records the warning itself',
    'rows 1',
    _dma_try(c_admin, NULL, format(
      'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id, early_reason) VALUES (%L, 2099, 12, %L, %L, ''Direkt mit Begruendung'')',
      c_co_a, c_d2b, c_plan99)));

  -- (g) The warning cannot be erased afterwards: opened_early, its reason and the
  --     measured shortfall are part of the row's fixed key.
  PERFORM _dma_expect('gate: opened_early cannot be edited away', 'ERR P0001 driver_month_assignment_key_fixed',
    _dma_try(c_admin, NULL, format('UPDATE driver_month_assignments SET opened_early = false WHERE id = %L', v_early)));
  PERFORM _dma_expect('gate: …nor its reason', 'ERR P0001 driver_month_assignment_key_fixed',
    _dma_try(c_admin, NULL, format('UPDATE driver_month_assignments SET early_reason = ''etwas anderes'' WHERE id = %L', v_early)));
  PERFORM _dma_expect('gate: …nor the number of days the database measured', 'ERR P0001 driver_month_assignment_key_fixed',
    _dma_try(c_admin, NULL, format('UPDATE driver_month_assignments SET early_days_remaining = 1 WHERE id = %L', v_early)));

  -- (h) The CHECK carries the half the clock cannot: "opened early" never stands
  --     without a reason and a shortfall. Written as the owner with the guard
  --     disabled, so what answers here is the constraint and nothing else.
  PERFORM _dma_expect('gate: the CHECK refuses opened_early with no reason, with the guard off',
    'ERR 23514 driver_month_assignments_early_recorded',
    _dma_mutant('ALTER TABLE driver_month_assignments DISABLE TRIGGER driver_month_assignment_guard',
      _dma_owner(), NULL, format(
        'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id, opened_early, early_days_remaining) VALUES (%L, 2099, 12, %L, %L, true, 5)',
        c_co_a, c_d2b, c_plan99)));
  PERFORM _dma_expect('gate: …and a reason with no measured shortfall',
    'ERR 23514 driver_month_assignments_early_recorded',
    _dma_mutant('ALTER TABLE driver_month_assignments DISABLE TRIGGER driver_month_assignment_guard',
      _dma_owner(), NULL, format(
        'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id, opened_early, early_reason) VALUES (%L, 2099, 12, %L, %L, true, ''ohne Zahl'')',
        c_co_a, c_d2b, c_plan99)));

  -- (i) The gate is on OPENING and on nothing else: releasing the early row --
  --     the one act the whole design exists to make cheap -- is never gated by
  --     the clock.
  PERFORM _dma_expect('gate: releasing an early-opened month is not gated by the clock', 'true',
    _dma_try(c_admin, NULL, format(
      'SELECT (public.driver_month_assignment_release(%L, ''accident'') ->> ''success'')', v_early)));
END $$;

-- ─── 3. the record: the figures are the database's, and they survive ────────
--
-- Drivers d3 and d3b, windows 3a, 3b (one vehicle, two windows of one day) and
-- 3c (another vehicle, another day): three windows, 540 minutes, two vehicles,
-- two operating days, no overlap.

DO $$
DECLARE
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_co_a  CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_d3    CONSTANT uuid := _dma_id('driver:d3');
  c_d3b   CONSTANT uuid := _dma_id('driver:d3b');
  v_3a    uuid := (SELECT id FROM _dma_w WHERE name = '3a');
  v_3b    uuid := (SELECT id FROM _dma_w WHERE name = '3b');
  v_3c    uuid := (SELECT id FROM _dma_w WHERE name = '3c');
  v_res   jsonb;
  v_id    uuid;
BEGIN
  PERFORM _dma_as(c_admin);
  v_res := public.driver_month_assignment_save(_dma_payload(2020, 1, c_d3, ARRAY[v_3a, v_3b, v_3c]));
  PERFORM _dma_reset();
  v_id := (v_res ->> 'assignment_id')::uuid;
  PERFORM _dma_expect('record: the save computes the four figures from the windows it was given', '3|540|2|2|0',
    (v_res ->> 'assigned_shift_count') || '|' || (v_res ->> 'assigned_minutes') || '|'
    || (v_res ->> 'assigned_vehicle_count') || '|' || (v_res ->> 'assigned_day_count') || '|'
    || (v_res ->> 'discarded_drafts'));
  PERFORM _dma_expect('record: the windows it stands for are rows, each with the window''s own length', '3|540',
    (SELECT count(*)::text || '|' || sum(c.minutes)::text
       FROM driver_month_assignment_shifts c WHERE c.assignment_id = v_id));

  -- A draft's figures are editable, so they are not a source yet -- 20261022140000
  -- says the same of its summary totals. The commit is what makes them one.
  PERFORM _dma_expect('record: a draft''s figures can be edited, so they are not a source yet', 'rows 1',
    _dma_try(c_admin, NULL, format('UPDATE driver_month_assignments SET assigned_minutes = 99999 WHERE id = %L', v_id)));

  PERFORM _dma_as(c_admin);
  v_res := public.driver_month_assignment_save(_dma_payload(2020, 1, c_d3, ARRAY[v_3a, v_3b, v_3c]));
  PERFORM _dma_reset();
  v_id := (v_res ->> 'assignment_id')::uuid;
  PERFORM _dma_expect('record: saving again discards the driver''s earlier draft for that month', '1',
    (v_res ->> 'discarded_drafts'));

  PERFORM _dma_as(c_admin);
  v_res := public.driver_month_assignment_commit(v_id);
  PERFORM _dma_reset();
  PERFORM _dma_expect('record: the commit re-derives the four figures from the windows themselves', 'true|3|540|2|2',
    (v_res ->> 'success') || '|' || (v_res ->> 'assigned_shift_count') || '|' || (v_res ->> 'assigned_minutes')
    || '|' || (v_res ->> 'assigned_vehicle_count') || '|' || (v_res ->> 'assigned_day_count'));
  PERFORM _dma_expect('record: …and stamps the actor and the time itself', 'assigned|true',
    (SELECT a.status || '|' || (a.assigned_at IS NOT NULL AND a.assigned_by = c_admin)::text
       FROM driver_month_assignments a WHERE a.id = v_id));

  -- THE UNIT AN INCIDENT MOVES: one call on one row, and the figures survive it.
  PERFORM _dma_as(c_admin);
  v_res := public.driver_month_assignment_release(v_id, 'accident', NULL);
  PERFORM _dma_reset();
  PERFORM _dma_expect('record: a release is ONE call on ONE row, and it frees the three windows', 'true|3',
    (v_res ->> 'success') || '|' || (v_res ->> 'freed_shift_count'));
  PERFORM _dma_expect('record: the figures are KEPT, so what the driver held is still on the record',
    'released|accident|3|540|2|2|0',
    (SELECT a.status || '|' || a.release_reason || '|' || a.assigned_shift_count || '|'
            || a.assigned_minutes || '|' || a.assigned_vehicle_count || '|' || a.assigned_day_count
            || '|' || (SELECT count(*) FROM driver_month_assignment_shifts c WHERE c.assignment_id = a.id)
       FROM driver_month_assignments a WHERE a.id = v_id));
  PERFORM _dma_expect('record: …and the release stamped its own time and actor', 'true',
    (SELECT (a.released_at IS NOT NULL AND a.released_by = c_admin)::text
       FROM driver_month_assignments a WHERE a.id = v_id));

  -- The freed window is taken by another driver at once, which is the point of
  -- deleting the child rows rather than flagging them.
  PERFORM _dma_as(c_admin);
  v_res := public.driver_month_assignment_save(_dma_payload(2020, 1, c_d3b, ARRAY[v_3a]));
  PERFORM _dma_reset();
  PERFORM _dma_expect('record: a freed window is taken by another driver at once', 'true|1',
    (v_res ->> 'success') || '|' || (v_res ->> 'assigned_shift_count'));

  -- And the released row stands beside a new live one for the SAME driver, which
  -- is why the key is partial: a driver back after a week is not locked out of the
  -- month he was released from.
  PERFORM _dma_as(c_admin);
  v_res := public.driver_month_assignment_save(_dma_payload(2020, 1, c_d3, ARRAY[v_3b]));
  PERFORM _dma_reset();
  PERFORM _dma_expect('record: the released row stands beside a new live one for the same driver and month', '1|1',
    (SELECT count(*) FILTER (WHERE a.status = 'released')::text || '|'
            || count(*) FILTER (WHERE a.status <> 'released')::text
       FROM driver_month_assignments a
      WHERE a.company_id = c_co_a AND a.year = 2020 AND a.month = 1 AND a.driver_id = c_d3));

  -- The closed list of reasons lives in the CHECK and nowhere else, so an unknown
  -- code is reported as that constraint's name.
  v_id := (v_res ->> 'assignment_id')::uuid;
  PERFORM _dma_expect('record: an unknown release reason is refused by the constraint that holds the list',
    'ERR 23514 driver_month_assignments_release_reason_known',
    _dma_try(c_admin, NULL, format('SELECT public.driver_month_assignment_release(%L, ''weil'')::text', v_id)));
  PERFORM _dma_expect('record: ''other'' says nothing on its own, so the note is required',
    'ERR 23514 driver_month_assignments_release_note_required_for_other',
    _dma_try(c_admin, NULL, format('SELECT public.driver_month_assignment_release(%L, ''other'')::text', v_id)));
  PERFORM _dma_expect('record: …and with a note ''other'' is accepted', 'true',
    _dma_try(c_admin, NULL, format(
      'SELECT (public.driver_month_assignment_release(%L, ''other'', ''Fahrer hat selbst gekuendigt'') ->> ''success'')', v_id)));
END $$;

-- ─── 4. tenancy ─────────────────────────────────────────────────────────────
--
-- Driver d4, windows 4a (its own) and 4b, plus f2 from the other month's plan.

DO $$
DECLARE
  c_admin   CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_admin_b CONSTANT uuid := 'b0000000-0000-4000-8000-000000000001';
  c_co_a    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_co_b    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000b';
  c_d4      CONSTANT uuid := _dma_id('driver:d4');
  c_drv_b   CONSTANT uuid := 'd0000000-0000-4000-8000-00000000000b';
  v_4a      uuid := (SELECT id FROM _dma_w WHERE name = '4a');
  v_4b      uuid := (SELECT id FROM _dma_w WHERE name = '4b');
  v_f2      uuid := (SELECT id FROM _dma_w WHERE name = 'f2');
  v_a       uuid;
BEGIN
  PERFORM _dma_as(c_admin);
  v_a := (public.driver_month_assignment_save(_dma_payload(2020, 1, c_d4, ARRAY[v_4a])) ->> 'assignment_id')::uuid;
  PERFORM _dma_reset();

  PERFORM _dma_expect('tenancy: company A''s administrator reads its own assignments', 'true',
    _dma_try(c_admin, NULL, format('SELECT (count(*) > 0)::text FROM driver_month_assignments WHERE company_id = %L', c_co_a)));
  PERFORM _dma_expect('tenancy: …and company B''s administrator reads none of them', '0',
    _dma_try(c_admin_b, NULL, format('SELECT count(*)::text FROM driver_month_assignments WHERE company_id = %L', c_co_a)));
  PERFORM _dma_expect('tenancy: …and none of the windows they stand for', '0',
    _dma_try(c_admin_b, NULL, format('SELECT count(*)::text FROM driver_month_assignment_shifts WHERE company_id = %L', c_co_a)));

  -- The guard refuses the move first, for everyone, the owner included.
  PERFORM _dma_expect('tenancy: an assignment cannot be moved to another company -- the guard refuses it',
    'ERR P0001 driver_month_assignment_key_fixed',
    _dma_try(c_admin, NULL, _dma_move_sql('driver_month_assignments', v_a, format('company_id = %L', c_co_b))));
  PERFORM _dma_expect('tenancy: …and the owner''s own attempt is refused by the same guard',
    'ERR P0001 driver_month_assignment_key_fixed',
    _dma_try(_dma_owner(), NULL, _dma_move_sql('driver_month_assignments', v_a, format('company_id = %L', c_co_b))));
  -- With the guard switched off the POLICY refuses it, which is the wall the guard
  -- stands in front of. A different SQLSTATE and a different message, so the two
  -- can never be one measurement.
  PERFORM _dma_expect('tenancy: …and with the guard off, the policy''s WITH CHECK refuses it',
    'ERR 42501 new row violates row-level security policy for table "driver_month_assignments"',
    _dma_mutant('ALTER TABLE driver_month_assignments DISABLE TRIGGER driver_month_assignment_guard',
      c_admin, NULL, _dma_move_sql('driver_month_assignments', v_a, format('company_id = %L', c_co_b))));

  -- A driver and a plan of another company, and a plan of another month: three
  -- refusals, two hints, and neither is the gate's.
  PERFORM _dma_expect('tenancy: a driver of another company is refused, with its own hint',
    'ERR P0001 driver_month_assignment_driver_mismatch',
    _dma_try(c_admin, NULL, format(
      'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id) VALUES (%L, 2020, 1, %L, %L)',
      c_co_a, c_drv_b, _dma_id('plan:a-2020'))));
  PERFORM _dma_expect('tenancy: a plan of another company is refused, with its own',
    'ERR P0001 driver_month_assignment_plan_mismatch',
    _dma_try(c_admin, NULL, format(
      'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id) VALUES (%L, 2020, 1, %L, %L)',
      c_co_a, c_d4, _dma_id('plan:b-2020'))));
  PERFORM _dma_expect('tenancy: a plan of another MONTH is refused by that hint too, and not by the gate',
    'ERR P0001 driver_month_assignment_plan_mismatch',
    _dma_try(c_admin, NULL, format(
      'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id, early_reason) VALUES (%L, 2099, 12, %L, %L, ''Monat passt nicht'')',
      c_co_a, c_d4, _dma_id('plan:a-2020'))));

  -- The child guard's own two refusals.
  PERFORM _dma_expect('tenancy: a window of another plan cannot be claimed',
    'ERR P0001 driver_month_assignment_shift_plan_mismatch',
    _dma_try(c_admin, NULL, format(
      'INSERT INTO driver_month_assignment_shifts (company_id, assignment_id, shift_id, minutes) VALUES (%L, %L, %L, 180)',
      c_co_a, v_a, v_f2)));
  PERFORM _dma_expect('tenancy: a window''s length is the window''s own, not the caller''s',
    'ERR P0001 driver_month_assignment_shift_minutes_mismatch',
    _dma_try(c_admin, NULL, format(
      'INSERT INTO driver_month_assignment_shifts (company_id, assignment_id, shift_id, minutes) VALUES (%L, %L, %L, 60)',
      c_co_a, v_a, v_4b)));
END $$;

-- ─── 5. the role gate ───────────────────────────────────────────────────────
--
-- Drivers d5 (holds the row the viewer and the editor try to touch) and d5b
-- (holds nothing, so a refused INSERT is the policy's and never the index's).

DO $$
DECLARE
  c_admin  CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_view   CONSTANT uuid := 'a0000000-0000-4000-8000-000000000003';
  c_edit   CONSTANT uuid := 'a0000000-0000-4000-8000-000000000002';
  c_sup    CONSTANT uuid := _dma_id('user:supervisor-a');
  c_co_a   CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_d5     CONSTANT uuid := _dma_id('driver:d5');
  c_d5b    CONSTANT uuid := _dma_id('driver:d5b');
  v_5a     uuid := (SELECT id FROM _dma_w WHERE name = '5a');
  v_5b     uuid := (SELECT id FROM _dma_w WHERE name = '5b');
  v_a      uuid;
  v_who    text;
  v_user   uuid;
BEGIN
  PERFORM _dma_as(c_admin);
  v_a := (public.driver_month_assignment_save(_dma_payload(2020, 1, c_d5, ARRAY[v_5a])) ->> 'assignment_id')::uuid;
  PERFORM _dma_reset();

  FOREACH v_who IN ARRAY ARRAY['viewer', 'editor'] LOOP
    v_user := CASE v_who WHEN 'viewer' THEN c_view ELSE c_edit END;
    PERFORM _dma_expect(format('roles: the %s reads the assignments of its own company', v_who), 'true',
      _dma_try(v_user, NULL, format('SELECT (count(*) > 0)::text FROM driver_month_assignments WHERE company_id = %L', c_co_a)));
    PERFORM _dma_expect(format('roles: the %s''s direct insert is refused by the policy', v_who),
      'ERR 42501 new row violates row-level security policy for table "driver_month_assignments"',
      _dma_try(v_user, NULL, format(
        'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id) VALUES (%L, 2020, 1, %L, %L)',
        c_co_a, c_d5b, _dma_id('plan:a-2020'))));
    PERFORM _dma_expect(format('roles: the %s''s update touches no row, because the page gate is in USING', v_who), 'rows 0',
      _dma_try(v_user, NULL, format('UPDATE driver_month_assignments SET assigned_minutes = assigned_minutes WHERE id = %L', v_a)));
    PERFORM _dma_expect(format('roles: the %s''s delete touches no row either', v_who), 'rows 0',
      _dma_try(v_user, NULL, format('DELETE FROM driver_month_assignments WHERE id = %L', v_a)));
    -- The RPCs run past RLS, so each asks the page itself and says so.
    PERFORM _dma_expect(format('roles: the save RPC refuses the %s with not_authorized', v_who), 'ERR 42501 not_authorized',
      _dma_try(v_user, NULL, format('SELECT public.driver_month_assignment_save(%L::jsonb)::text',
        _dma_payload(2020, 1, c_d5b, ARRAY[v_5b])::text)));
    PERFORM _dma_expect(format('roles: the commit RPC refuses the %s too', v_who), 'ERR 42501 not_authorized',
      _dma_try(v_user, NULL, format('SELECT public.driver_month_assignment_commit(%L)::text', v_a)));
    PERFORM _dma_expect(format('roles: and the release RPC refuses the %s', v_who), 'ERR 42501 not_authorized',
      _dma_try(v_user, NULL, format('SELECT public.driver_month_assignment_release(%L, ''leave'')::text', v_a)));
  END LOOP;

  PERFORM _dma_expect('roles: a supervisor, who holds can_edit everywhere, assigns a driver', 'true',
    _dma_try(c_sup, NULL, format('SELECT (public.driver_month_assignment_save(%L::jsonb) ->> ''success'')',
      _dma_payload(2020, 1, c_d5b, ARRAY[v_5b])::text)));
END $$;

-- ─── 6. one live assignment per driver, one driver per window ───────────────
--
-- Drivers d6 (window 6a) and d6b (window 6b).

DO $$
DECLARE
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_co_a  CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_d6    CONSTANT uuid := _dma_id('driver:d6');
  c_d6b   CONSTANT uuid := _dma_id('driver:d6b');
  v_6a    uuid := (SELECT id FROM _dma_w WHERE name = '6a');
  v_6b    uuid := (SELECT id FROM _dma_w WHERE name = '6b');
  v_live  uuid;
BEGIN
  PERFORM _dma_as(c_admin);
  v_live := (public.driver_month_assignment_save(_dma_payload(2020, 1, c_d6, ARRAY[v_6a])) ->> 'assignment_id')::uuid;
  PERFORM public.driver_month_assignment_save(_dma_payload(2020, 1, c_d6b, ARRAY[v_6b]));
  PERFORM _dma_reset();

  PERFORM _dma_expect('one each: a second live assignment for one driver and month is refused by the index',
    'ERR 23505 driver_month_assignments_one_live_per_driver',
    _dma_try(_dma_owner(), NULL, format(
      'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id) VALUES (%L, 2020, 1, %L, %L)',
      c_co_a, c_d6, _dma_id('plan:a-2020'))));

  PERFORM _dma_expect('one each: the save refuses a window another driver already holds, by name',
    'shift_already_assigned',
    _dma_try(c_admin, NULL, format(
      'SELECT (public.driver_month_assignment_save(%L::jsonb) ->> ''reason'')',
      _dma_payload(2020, 1, c_d6b, ARRAY[v_6a])::text)));
  PERFORM _dma_expect('one each: …and a direct second claim on one window is refused by the constraint',
    'ERR 23505 driver_month_assignment_shifts_one_claim_per_shift',
    _dma_try(_dma_owner(), NULL, format(
      'INSERT INTO driver_month_assignment_shifts (company_id, assignment_id, shift_id, minutes) VALUES (%L, %L, %L, 180)',
      c_co_a, v_live, v_6b)));
END $$;

-- ─── 7. the lifecycle, and the freeze ───────────────────────────────────────
--
-- Driver d7, windows 7a and 7b.

DO $$
DECLARE
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_co_a  CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_d7    CONSTANT uuid := _dma_id('driver:d7');
  v_7a    uuid := (SELECT id FROM _dma_w WHERE name = '7a');
  v_7b    uuid := (SELECT id FROM _dma_w WHERE name = '7b');
  v_id    uuid;
  v_res   jsonb;
BEGIN
  PERFORM _dma_as(c_admin);
  v_id := (public.driver_month_assignment_save(_dma_payload(2020, 1, c_d7, ARRAY[v_7a])) ->> 'assignment_id')::uuid;
  PERFORM _dma_reset();

  PERFORM _dma_expect('lifecycle: a status moved by hand is refused',
    'ERR P0001 driver_month_assignment_transition_needs_rpc',
    _dma_try(c_admin, NULL, format('UPDATE driver_month_assignments SET status = ''assigned'' WHERE id = %L', v_id)));
  PERFORM _dma_expect('lifecycle: …for the owner too, because the marker and not the role is what opens it',
    'ERR P0001 driver_month_assignment_transition_needs_rpc',
    _dma_try(_dma_owner(), NULL, format('UPDATE driver_month_assignments SET status = ''released'', release_reason = ''leave'' WHERE id = %L', v_id)));

  PERFORM _dma_as(c_admin);
  v_res := public.driver_month_assignment_commit(v_id);
  PERFORM _dma_reset();
  PERFORM _dma_expect('lifecycle: the commit moves a draft to assigned', 'true', v_res ->> 'success');
  PERFORM _dma_expect('lifecycle: committing it twice is refused by return value, so the screen can say why',
    'not_a_draft',
    _dma_try(c_admin, NULL, format('SELECT (public.driver_month_assignment_commit(%L) ->> ''reason'')', v_id)));

  PERFORM _dma_expect('lifecycle: a committed assignment is not edited', 'ERR P0001 driver_month_assignment_is_final',
    _dma_try(c_admin, NULL, format('UPDATE driver_month_assignments SET assigned_minutes = 1 WHERE id = %L', v_id)));
  PERFORM _dma_expect('lifecycle: …nor deleted while its company, driver and plan all exist',
    'ERR P0001 driver_month_assignment_is_final',
    _dma_try(c_admin, NULL, format('DELETE FROM driver_month_assignments WHERE id = %L', v_id)));
  PERFORM _dma_expect('lifecycle: …and its windows cannot be deleted by hand',
    'ERR P0001 driver_month_assignment_is_final',
    _dma_try(c_admin, NULL, format('DELETE FROM driver_month_assignment_shifts WHERE assignment_id = %L', v_id)));
  PERFORM _dma_expect('lifecycle: …nor added to',
    'ERR P0001 driver_month_assignment_is_final',
    _dma_try(c_admin, NULL, format(
      'INSERT INTO driver_month_assignment_shifts (company_id, assignment_id, shift_id, minutes) VALUES (%L, %L, %L, 180)',
      c_co_a, v_id, v_7b)));

  PERFORM _dma_as(c_admin);
  v_res := public.driver_month_assignment_release(v_id, 'fine', NULL);
  PERFORM _dma_reset();
  PERFORM _dma_expect('lifecycle: the release is the one door through the freeze', 'true|fine',
    (v_res ->> 'success') || '|' || (v_res ->> 'release_reason'));
  PERFORM _dma_expect('lifecycle: releasing twice is refused by return value', 'already_released',
    _dma_try(c_admin, NULL, format('SELECT (public.driver_month_assignment_release(%L, ''leave'') ->> ''reason'')', v_id)));
  PERFORM _dma_expect('lifecycle: a released assignment is history and is not deleted either',
    'ERR P0001 driver_month_assignment_is_final',
    _dma_try(c_admin, NULL, format('DELETE FROM driver_month_assignments WHERE id = %L', v_id)));

  -- A draft, on the other hand, is a proposal and may go.
  PERFORM _dma_as(c_admin);
  v_id := (public.driver_month_assignment_save(_dma_payload(2020, 1, c_d7, ARRAY[v_7a])) ->> 'assignment_id')::uuid;
  PERFORM _dma_reset();
  PERFORM _dma_expect('lifecycle: a draft is a proposal and may be deleted', 'rows 1',
    _dma_try(c_admin, NULL, format('DELETE FROM driver_month_assignments WHERE id = %L', v_id)));
END $$;

-- ─── 8. what each RPC refuses, by name ──────────────────────────────────────
--
-- Driver d8, windows 8a and 8b (which overlap in wall-clock time, on two
-- vehicles, on one operating day), and b1 from company B's plan.

DO $$
DECLARE
  c_admin   CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_admin_b CONSTANT uuid := 'b0000000-0000-4000-8000-000000000001';
  c_d8      CONSTANT uuid := _dma_id('driver:d8');
  c_drv_b   CONSTANT uuid := 'd0000000-0000-4000-8000-00000000000b';
  v_8a      uuid := (SELECT id FROM _dma_w WHERE name = '8a');
  v_8b      uuid := (SELECT id FROM _dma_w WHERE name = '8b');
  v_b1      uuid := (SELECT id FROM _dma_w WHERE name = 'b1');
  v_res     jsonb;
  v_id      uuid;
BEGIN
  -- A key the function does not know is NAMED, not ignored: a client that sent a
  -- plan_id, a ride or an address must be told it was not stored.
  PERFORM _dma_expect('save: an unknown payload key is refused and named',
    'ERR 22023 driver_month_assignment_save: unknown payload key(s): plan_id',
    _dma_try(c_admin, NULL, format('SELECT public.driver_month_assignment_save(%L::jsonb)::text',
      '{"year": 2020, "month": 1, "driver_id": "' || c_d8 || '", "shift_ids": [], "plan_id": "x"}')));
  PERFORM _dma_expect('save: …and two of them at once, in order',
    'ERR 22023 driver_month_assignment_save: unknown payload key(s): address, trip_id',
    _dma_try(c_admin, NULL, format('SELECT public.driver_month_assignment_save(%L::jsonb)::text',
      '{"year": 2020, "month": 1, "driver_id": "' || c_d8 || '", "trip_id": "x", "address": "y"}')));
  PERFORM _dma_expect('save: a shift id that is not a uuid is refused by the contract, not by a cast',
    'ERR 22023 driver_month_assignment_save: shift_ids must be a JSON array of uuid strings',
    _dma_try(c_admin, NULL, format('SELECT public.driver_month_assignment_save(%L::jsonb)::text',
      '{"year": 2020, "month": 1, "driver_id": "' || c_d8 || '", "shift_ids": ["nope"]}')));
  PERFORM _dma_expect('save: the same window twice in one payload is refused by name',
    'ERR 22023 driver_month_assignment_save: shift_ids holds the same id twice',
    _dma_try(c_admin, NULL, format('SELECT public.driver_month_assignment_save(%L::jsonb)::text',
      _dma_payload(2020, 1, c_d8, ARRAY[v_8a, v_8a])::text)));

  PERFORM _dma_expect('save: a month with no confirmed vehicle plan is refused by return value',
    'no_confirmed_plan',
    _dma_try(c_admin, NULL, format('SELECT (public.driver_month_assignment_save(%L::jsonb) ->> ''reason'')',
      _dma_payload(2020, 3, c_d8, ARRAY[]::uuid[])::text)));
  PERFORM _dma_expect('save: a window of another company''s plan is refused by return value',
    'shift_not_in_plan',
    _dma_try(c_admin, NULL, format('SELECT (public.driver_month_assignment_save(%L::jsonb) ->> ''reason'')',
      _dma_payload(2020, 1, c_d8, ARRAY[v_b1])::text)));
  PERFORM _dma_expect('save: a driver of another company is refused by return value',
    'driver_not_found',
    _dma_try(c_admin, NULL, format('SELECT (public.driver_month_assignment_save(%L::jsonb) ->> ''reason'')',
      _dma_payload(2020, 1, c_drv_b, ARRAY[v_8a])::text)));
  PERFORM _dma_expect('save: A DRIVER IN TWO PLACES AT ONCE is refused by return value',
    'driver_overlap',
    _dma_try(c_admin, NULL, format('SELECT (public.driver_month_assignment_save(%L::jsonb) ->> ''reason'')',
      _dma_payload(2020, 1, c_d8, ARRAY[v_8a, v_8b])::text)));

  -- An empty assignment is a failed preparation: the save stores it, the commit
  -- refuses to make it a driver's record.
  PERFORM _dma_as(c_admin);
  v_res := public.driver_month_assignment_save(_dma_payload(2020, 1, c_d8, ARRAY[]::uuid[]));
  PERFORM _dma_reset();
  v_id := (v_res ->> 'assignment_id')::uuid;
  PERFORM _dma_expect('commit: an empty assignment is saved but never committed', 'true|assignment_empty',
    (v_res ->> 'success') || '|'
    || _dma_try(c_admin, NULL, format('SELECT (public.driver_month_assignment_commit(%L) ->> ''reason'')', v_id)));
  PERFORM _dma_expect('commit: an assignment of another company is simply not found', 'assignment_not_found',
    _dma_try(c_admin_b, NULL, format('SELECT (public.driver_month_assignment_commit(%L) ->> ''reason'')', v_id)));
  PERFORM _dma_expect('commit: a missing argument is a broken contract and raises',
    'ERR 22023 driver_month_assignment_commit: p_assignment_id is required',
    _dma_try(c_admin, NULL, 'SELECT public.driver_month_assignment_commit(NULL)::text'));
  PERFORM _dma_expect('release: a missing reason is a broken contract and raises',
    'ERR 22023 driver_month_assignment_release: p_reason is required',
    _dma_try(c_admin, NULL, format('SELECT public.driver_month_assignment_release(%L, ''  '')::text', v_id)));

  -- The vehicle plan stopped being the month's active one between the preparation
  -- and the commit: a real race for a feature whose two halves are confirmed at
  -- different times. The mutation sets the sub claim as well, because
  -- 20261022140000's guard writes superseded_by := auth.uid() and pairs it with
  -- superseded_at.
  PERFORM _dma_as(c_admin);
  v_id := (public.driver_month_assignment_save(_dma_payload(2020, 1, c_d8, ARRAY[v_8a])) ->> 'assignment_id')::uuid;
  PERFORM _dma_reset();
  PERFORM _dma_expect('commit: a vehicle plan that stopped being the active one is refused by name',
    'plan_not_active',
    _dma_mutant(format($m$DO $mm$ BEGIN
        PERFORM set_config('request.jwt.claim.sub', %L, true);
        PERFORM set_config('app_private.vehicle_day_plan_transition',
                           'plan:%s:' || pg_current_xact_id()::text, true);
        UPDATE vehicle_day_plans SET status = 'superseded' WHERE id = %L;
        PERFORM set_config('app_private.vehicle_day_plan_transition', '', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
      END $mm$ $m$, c_admin::text, _dma_id('plan:a-2020'), _dma_id('plan:a-2020')),
      c_admin, NULL, format('SELECT (public.driver_month_assignment_commit(%L) ->> ''reason'')', v_id)));
END $$;

-- ─── 9. company and account state, and anon ─────────────────────────────────

DO $$
DECLARE
  c_susp  CONSTANT uuid := _dma_id('user:admin-suspended');
  c_co_s  CONSTANT uuid := _dma_id('company:suspended');
  c_super CONSTANT uuid := '50000000-0000-4000-8000-000000000001';
  v_pay   text := _dma_payload(2020, 1, _dma_id('driver:susp'),
                               ARRAY[(SELECT id FROM _dma_w WHERE name = 's1')])::text;
BEGIN
  -- The suspended company HOLDS an assignment and a claimed window (the fixture
  -- wrote them as the owner), so "reads none of them" is a measurement and not an
  -- empty table.
  PERFORM _dma_ok('state: the suspended company really holds an assignment and a window',
    (SELECT count(*) FROM driver_month_assignments a WHERE a.company_id = c_co_s) = 1
    AND (SELECT count(*) FROM driver_month_assignment_shifts c WHERE c.company_id = c_co_s) = 1);
  PERFORM _dma_expect('state: a suspended company''s administrator reads none of them', '0',
    _dma_try(c_susp, NULL, format('SELECT count(*)::text FROM driver_month_assignments WHERE company_id = %L', c_co_s)));
  PERFORM _dma_expect('state: …nor the windows', '0',
    _dma_try(c_susp, NULL, format('SELECT count(*)::text FROM driver_month_assignment_shifts WHERE company_id = %L', c_co_s)));
  PERFORM _dma_expect('state: …and the save RPC answers no_company, not not_authorized', 'ERR 42501 no_company',
    _dma_try(c_susp, NULL, format('SELECT public.driver_month_assignment_save(%L::jsonb)::text', v_pay)));
  PERFORM _dma_expect('state: …and so does the commit RPC', 'ERR 42501 no_company',
    _dma_try(c_susp, NULL, format('SELECT public.driver_month_assignment_commit(%L)::text', _dma_id('assignment:susp'))));
  PERFORM _dma_expect('state: …and the release RPC', 'ERR 42501 no_company',
    _dma_try(c_susp, NULL, format('SELECT public.driver_month_assignment_release(%L, ''leave'')::text', _dma_id('assignment:susp'))));

  -- A platform owner with no open context has no company either.
  PERFORM _dma_expect('state: a platform owner with no context reads nothing', '0',
    _dma_try(c_super, NULL, 'SELECT count(*)::text FROM driver_month_assignments'));
  PERFORM _dma_expect('state: …and the save RPC answers no_company', 'ERR 42501 no_company',
    _dma_try(c_super, NULL, format('SELECT public.driver_month_assignment_save(%L::jsonb)::text', v_pay)));

  -- anon holds no privilege at all: a MISSING GRANT, read out of PostgreSQL's own
  -- message and never out of the HINT.
  PERFORM _dma_expect('state: anon cannot read the table at all', 'ERR 42501 privilege table driver_month_assignments',
    _dma_try(NULL, NULL, 'SELECT count(*)::text FROM driver_month_assignments'));
  PERFORM _dma_expect('state: …nor the windows', 'ERR 42501 privilege table driver_month_assignment_shifts',
    _dma_try(NULL, NULL, 'SELECT count(*)::text FROM driver_month_assignment_shifts'));
  PERFORM _dma_expect('state: …nor call the save RPC', 'ERR 42501 privilege function driver_month_assignment_save',
    _dma_try(NULL, NULL, format('SELECT public.driver_month_assignment_save(%L::jsonb)::text', v_pay)));

  PERFORM _dma_expect('state: a token with no subject is refused with unauthenticated', 'ERR 42501 unauthenticated',
    _dma_try(_dma_nobody(), NULL, format('SELECT public.driver_month_assignment_save(%L::jsonb)::text', v_pay)));
END $$;

-- ─── 10. platform contexts ──────────────────────────────────────────────────
--
-- Driver d10, window 10a. The view context is left open: section 12's last
-- control needs it.

DO $$
DECLARE
  c_view    CONSTANT uuid := _dma_id('user:owner-view');
  c_support CONSTANT uuid := _dma_id('user:owner-support');
  c_s_view  CONSTANT uuid := _dma_id('session:owner-view');
  c_s_supp  CONSTANT uuid := _dma_id('session:owner-support');
  c_co_a    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_co_b    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000b';
  c_d10     CONSTANT uuid := _dma_id('driver:d10');
  c_drv_b   CONSTANT uuid := 'd0000000-0000-4000-8000-00000000000b';
  v_10a     uuid := (SELECT id FROM _dma_w WHERE name = '10a');
  v_open    jsonb;
  v_res     jsonb;
  v_mark    bigint;
  v_after   jsonb;
  v_id      uuid;
BEGIN
  PERFORM _dma_as(c_view, c_s_view);
  v_open := public.platform_context_open(c_co_a, 'view');
  PERFORM _dma_reset();
  PERFORM _dma_expect('contexts: the view context opened', 'true', v_open ->> 'success');

  PERFORM _dma_expect('contexts: a view context reads the assignments of the company it opened', 'true',
    _dma_try(c_view, c_s_view, format('SELECT (count(*) > 0)::text FROM driver_month_assignments WHERE company_id = %L', c_co_a)));
  PERFORM _dma_expect('contexts: …and the windows they stand for', 'true',
    _dma_try(c_view, c_s_view, format('SELECT (count(*) > 0)::text FROM driver_month_assignment_shifts WHERE company_id = %L', c_co_a)));
  PERFORM _dma_expect('contexts: …and no other company''s', '0',
    _dma_try(c_view, c_s_view, format('SELECT count(*)::text FROM driver_month_assignments WHERE company_id = %L', c_co_b)));
  PERFORM _dma_expect('contexts: a view context writes nothing, and says why (3.4a)', 'ERR P0001 support_session_required',
    _dma_try(c_view, c_s_view, format(
      'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id) VALUES (%L, 2020, 1, %L, %L)',
      c_co_a, c_d10, _dma_id('plan:a-2020'))));
  PERFORM _dma_expect('contexts: …not even an update that would touch no row', 'ERR P0001 support_session_required',
    _dma_try(c_view, c_s_view, format('UPDATE driver_month_assignments SET assigned_minutes = assigned_minutes WHERE company_id = %L', c_co_a)));
  PERFORM _dma_expect('contexts: a view context is refused by the save RPC''s role gate', 'ERR 42501 not_authorized',
    _dma_try(c_view, c_s_view, format('SELECT public.driver_month_assignment_save(%L::jsonb)::text',
      _dma_payload(2020, 1, c_d10, ARRAY[v_10a])::text)));

  -- The support session writes the company it opened, as its own administrator
  -- would, and every row leaves one audit row.
  PERFORM _dma_as(c_support, c_s_supp);
  v_open := public.platform_context_open(c_co_a, 'support', 'Ticket Fahrerzuordnung');
  PERFORM _dma_reset();
  PERFORM _dma_expect('contexts: the support session opened', 'true', v_open ->> 'success');

  v_mark := _dma_mark();
  PERFORM _dma_as(c_support, c_s_supp);
  v_res := public.driver_month_assignment_save(_dma_payload(2020, 1, c_d10, ARRAY[v_10a]));
  PERFORM _dma_reset();
  v_id := (v_res ->> 'assignment_id')::uuid;
  PERFORM _dma_expect('contexts: a support session saves an assignment for the company it opened', 'true|1',
    (v_res ->> 'success') || '|' || (v_res ->> 'assigned_shift_count'));
  PERFORM _dma_expect('contexts: each row it wrote left exactly one audit row (3.4c): one assignment, one window',
    '1|1',
    _dma_rows(v_mark, 'support_write.driver_month_assignments.insert')::text || '|'
    || _dma_rows(v_mark, 'support_write.driver_month_assignment_shifts.insert')::text);

  SELECT l.after_value INTO v_after
    FROM app_private.platform_audit_log l
   WHERE l.id > v_mark AND l.action = 'support_write.driver_month_assignments.insert'
   ORDER BY l.id LIMIT 1;
  PERFORM _dma_expect('contexts: the audit row names the reason and keeps the month, which is no pay figure',
    'Ticket Fahrerzuordnung|2020|1',
    (v_after ->> 'reason') || '|' || (v_after -> 'values' ->> 'year') || '|' || (v_after -> 'values' ->> 'month'));

  v_mark := _dma_mark();
  PERFORM _dma_as(c_support, c_s_supp);
  v_res := public.driver_month_assignment_commit(v_id);
  PERFORM _dma_reset();
  PERFORM _dma_expect('contexts: a support session commits through the RPC, and the status change is recorded once',
    'true|1',
    (v_res ->> 'success') || '|' || _dma_rows(v_mark, 'support_write.driver_month_assignments.update')::text);

  -- The release inside a support session: the window it frees is recorded as a
  -- delete, so the withdrawal marker does not make the audit blind.
  v_mark := _dma_mark();
  PERFORM _dma_as(c_support, c_s_supp);
  v_res := public.driver_month_assignment_release(v_id, 'roadside_incident', NULL);
  PERFORM _dma_reset();
  PERFORM _dma_expect('contexts: the release is recorded too -- the freed window as a delete, the row as an update',
    'true|1|1',
    (v_res ->> 'success') || '|'
    || _dma_rows(v_mark, 'support_write.driver_month_assignment_shifts.delete')::text || '|'
    || _dma_rows(v_mark, 'support_write.driver_month_assignments.update')::text);

  PERFORM _dma_expect('contexts: a support session writes no other company''s assignment',
    'ERR 42501 new row violates row-level security policy for table "driver_month_assignments"',
    _dma_try(c_support, c_s_supp, format(
      'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id) VALUES (%L, 2020, 1, %L, %L)',
      c_co_b, c_drv_b, _dma_id('plan:b-2020'))));
END $$;

-- ─── 11. a company, a driver and a plan holding a committed assignment ──────
--
-- 20261016140000 found, by deleting a company that had done real work, that the
-- monthly plan's freeze refused the company's own cascade. The same freeze is
-- here, widened to the three rows an assignment hangs from, so all three
-- deletions are tried. The driver matters most: deleting one already destroys his
-- salaries and his Gehaltsquittungen (tests/rls/driver-deletion.sql section 1),
-- and this table must not start making that delete fail.

DO $$
DECLARE
  c_x       CONSTANT uuid := _dma_id('company:x');
  c_admin_x CONSTANT uuid := _dma_id('user:admin-x');
  c_drv_x   CONSTANT uuid := _dma_id('driver:x');
  c_plan    CONSTANT uuid := _dma_id('plan:x');
  v_res     jsonb;
  v_id      uuid;
  v_probe   text;
BEGIN
  INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
  VALUES (c_x, 'DMA delete', 'dma-delete', 'approved', 'active', 'basic', 'active');
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES (c_admin_x, 'dma-admin-x@test.invalid', now());
  INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
  VALUES (c_admin_x, 'dma-admin-x@test.invalid', 'DMA admin x', 'admin',
          (SELECT r.id FROM roles r WHERE r.name = 'admin' AND r.company_id IS NULL), c_x, 'active');
  INSERT INTO drivers (id, company_id, name) VALUES (c_drv_x, c_x, 'DMA Driver X');
  INSERT INTO vehicle_day_plans (id, company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version)
  VALUES (c_plan, c_x, 2020, 1, 4, 15, 'shift-recommendation/1.0.0');
  PERFORM _dma_put_shift(c_x, c_plan, DATE '2020-01-08', 'DMA-X-1', 0, 24, 36);
  PERFORM _dma_confirm_plan(c_plan, c_admin_x);

  PERFORM _dma_as(c_admin_x);
  v_res := public.driver_month_assignment_save(
    _dma_payload(2020, 1, c_drv_x, ARRAY[(SELECT f.id FROM vehicle_day_shifts f WHERE f.plan_id = c_plan)]));
  v_id := (v_res ->> 'assignment_id')::uuid;
  PERFORM public.driver_month_assignment_commit(v_id);
  PERFORM _dma_reset();

  PERFORM _dma_expect('deletion: the company now holds one committed assignment and one claimed window', 'assigned|1',
    (SELECT a.status FROM driver_month_assignments a WHERE a.id = v_id)
    || '|' || (SELECT count(*)::text FROM driver_month_assignment_shifts c WHERE c.company_id = c_x));

  PERFORM _dma_expect('deletion: while all three parents exist the committed assignment cannot be deleted',
    'ERR P0001 driver_month_assignment_is_final',
    _dma_try(_dma_owner(), NULL, format('DELETE FROM driver_month_assignments WHERE id = %L', v_id)));

  v_probe := format($p$DO $q$
    DECLARE n bigint;
    BEGIN
      DELETE FROM drivers WHERE id = %L;
      SELECT count(*) INTO n FROM driver_month_assignments WHERE driver_id = %L;
      IF n <> 0 THEN RAISE EXCEPTION 'assignments left: %%', n; END IF;
      SELECT count(*) INTO n FROM driver_month_assignment_shifts WHERE company_id = %L;
      IF n <> 0 THEN RAISE EXCEPTION 'windows left: %%', n; END IF;
    END $q$
  $p$, c_drv_x, c_drv_x, c_x);
  PERFORM _dma_expect('deletion: deleting the DRIVER takes his committed assignment and its window with it, and is not refused',
    'rows 0', _dma_try(_dma_owner(), NULL, v_probe));

  v_probe := format($p$DO $q$
    DECLARE n bigint;
    BEGIN
      DELETE FROM companies WHERE id = %L;
      SELECT count(*) INTO n FROM driver_month_assignments WHERE company_id = %L;
      IF n <> 0 THEN RAISE EXCEPTION 'assignments left: %%', n; END IF;
      SELECT count(*) INTO n FROM driver_month_assignment_shifts WHERE company_id = %L;
      IF n <> 0 THEN RAISE EXCEPTION 'windows left: %%', n; END IF;
    END $q$
  $p$, c_x, c_x, c_x);
  PERFORM _dma_expect('deletion: deleting the COMPANY takes them with it too',
    'rows 0', _dma_try(_dma_owner(), NULL, v_probe));

  -- And the vehicle day plan the assignment names. 20261022140000's own guard
  -- refuses deleting a confirmed plan while the company exists, so that guard is
  -- switched off here and what is being measured is THIS file's: the assignment's
  -- freeze must stand aside for the plan's cascade.
  PERFORM _dma_expect('deletion: deleting the vehicle day plan takes the assignment that named it with it',
    'rows 0',
    _dma_mutant('ALTER TABLE vehicle_day_plans DISABLE TRIGGER vehicle_day_plan_guard',
      _dma_owner(), NULL, format($p$DO $q$
        DECLARE n bigint;
        BEGIN
          DELETE FROM vehicle_day_plans WHERE id = %L;
          SELECT count(*) INTO n FROM driver_month_assignments WHERE plan_id = %L;
          IF n <> 0 THEN RAISE EXCEPTION 'assignments left: %%', n; END IF;
        END $q$
      $p$, c_plan, c_plan)));
END $$;

-- ─── 12. mutation controls ──────────────────────────────────────────────────
--
-- A probe that cannot fail measures nothing. Each control below breaks ONE rule
-- inside a subtransaction, runs the same probe that asserted the rule above, and
-- requires its answer to change. The subtransaction is rolled back, so the rule
-- is whole again for the next control. Every line prints "before => after".
-- A mutation that would change nothing raises (see _dma_mutate_fn), so a control
-- cannot pass for want of a mutation.
--
-- Drivers d12 (holds a draft), d12b (holds a committed row) and d12c (holds
-- nothing, so a refused insert is the policy's and never the index's).

DO $$
DECLARE
  c_admin   CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_admin_b CONSTANT uuid := 'b0000000-0000-4000-8000-000000000001';
  c_view    CONSTANT uuid := 'a0000000-0000-4000-8000-000000000003';
  c_view_p  CONSTANT uuid := _dma_id('user:owner-view');
  c_s_view  CONSTANT uuid := _dma_id('session:owner-view');
  c_co_a    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_co_b    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000b';
  c_d12     CONSTANT uuid := _dma_id('driver:d12');
  c_d12b    CONSTANT uuid := _dma_id('driver:d12b');
  c_d12c    CONSTANT uuid := _dma_id('driver:d12c');
  c_plan20  CONSTANT uuid := _dma_id('plan:a-2020');
  c_plan99  CONSTANT uuid := _dma_id('plan:a-2099');
  v_12a     uuid := (SELECT id FROM _dma_w WHERE name = '12a');
  v_12b     uuid := (SELECT id FROM _dma_w WHERE name = '12b');
  v_f2      uuid := (SELECT id FROM _dma_w WHERE name = 'f2');
  v_early   uuid := (SELECT a.id FROM driver_month_assignments a
                      WHERE a.company_id = 'c0000000-0000-4000-8000-00000000000a'
                        AND a.year = 2099 AND a.month = 12 LIMIT 1);
  v_live    uuid;
  v_done    uuid;
  v_probe   text;
  v_before  text;
  v_after   text;
BEGIN
  PERFORM _dma_as(c_admin);
  v_live := (public.driver_month_assignment_save(_dma_payload(2020, 1, c_d12, ARRAY[v_12a])) ->> 'assignment_id')::uuid;
  v_done := (public.driver_month_assignment_save(_dma_payload(2020, 1, c_d12b, ARRAY[v_12b])) ->> 'assignment_id')::uuid;
  PERFORM public.driver_month_assignment_commit(v_done);
  PERFORM _dma_reset();

  -- M1. THE GATE leaves the guard: a month that has not ended is assigned
  --     silently, with no reason and no warning.
  v_probe := format(
    'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id) VALUES (%L, 2099, 12, %L, %L)',
    c_co_a, c_d12, c_plan99);
  v_before := _dma_try(c_admin, NULL, v_probe);
  v_after  := _dma_mutant($m$SELECT _dma_mutate_fn('app_private.driver_month_assignment_guard()', 'IF v_remaining > 0 THEN', 'IF false THEN')$m$,
    c_admin, NULL, v_probe);
  PERFORM _dma_expect('mutation M1: without the gate in the guard a month that has not ended is assigned silently',
    'ERR P0001 driver_month_assignment_month_not_ended => rows 1', v_before || ' => ' || v_after);

  -- M2. The gate stops REQUIRING a reason: an early opening is then recorded with
  --     none, and the pairing CHECK is what catches it. Both halves of the OR are
  --     neutralised (`false AND B`), because `false AND A OR B` would leave B live
  --     and the control would pass for the wrong reason.
  v_before := _dma_try(c_admin, NULL, v_probe);
  v_after  := _dma_mutant($m$SELECT _dma_mutate_fn('app_private.driver_month_assignment_guard()', 'IF NEW.early_reason IS NULL OR btrim', 'IF false AND btrim')$m$,
    c_admin, NULL, v_probe);
  PERFORM _dma_expect('mutation M2: without the required reason an early opening has none, and the CHECK is what catches it',
    'ERR P0001 driver_month_assignment_month_not_ended => ERR 23514 driver_month_assignments_early_recorded',
    v_before || ' => ' || v_after);

  -- M3. The guard stops recording the shortfall it measured: the CHECK refuses the
  --     row, so the pairing is load-bearing and not decoration.
  v_probe := format(
    'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id, early_reason) VALUES (%L, 2099, 12, %L, %L, ''Begruendung'')',
    c_co_a, c_d12, c_plan99);
  v_before := _dma_try(c_admin, NULL, v_probe);
  v_after  := _dma_mutant($m$SELECT _dma_mutate_fn('app_private.driver_month_assignment_guard()', 'NEW.early_days_remaining := v_remaining;', 'NEW.early_days_remaining := NULL;')$m$,
    c_admin, NULL, v_probe);
  PERFORM _dma_expect('mutation M3: a guard that stops measuring the shortfall is refused by the pairing CHECK',
    'rows 1 => ERR 23514 driver_month_assignments_early_recorded', v_before || ' => ' || v_after);

  -- M4. The guard stops fixing the early record: the warning''s text can be
  --     rewritten after the fact. The reason is replaced by another non-empty one,
  --     so the pairing CHECK still holds and what moves is only the guard.
  v_probe := format('UPDATE driver_month_assignments SET early_reason = ''etwas anderes'' WHERE id = %L', v_early);
  v_before := _dma_try(c_admin, NULL, v_probe);
  v_after  := _dma_mutant($m$SELECT _dma_mutate_fn('app_private.driver_month_assignment_guard()', 'IS DISTINCT FROM OLD.early_reason', 'IS DISTINCT FROM OLD.early_reason AND false')$m$,
    c_admin, NULL, v_probe);
  PERFORM _dma_expect('mutation M4: without the guard''s clause the early-opening reason can be rewritten after the fact',
    'ERR P0001 driver_month_assignment_key_fixed => rows 1', v_before || ' => ' || v_after);

  -- M5. The role gate leaves the INSERT policy: the viewer's insert is admitted.
  v_probe := format(
    'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id) VALUES (%L, 2020, 1, %L, %L)',
    c_co_a, c_d12c, c_plan20);
  v_before := _dma_try(c_view, NULL, v_probe);
  v_after  := _dma_mutant('ALTER POLICY driver_month_assignments_insert ON public.driver_month_assignments WITH CHECK (company_id = (SELECT public.get_active_company_id()))',
    c_view, NULL, v_probe);
  PERFORM _dma_expect('mutation M5: without the role gate in the INSERT policy the viewer''s insert is admitted',
    'ERR 42501 new row violates row-level security policy for table "driver_month_assignments" => rows 1',
    v_before || ' => ' || v_after);

  -- M6. The tenant term leaves the UPDATE policy's WITH CHECK. The guard is off in
  --     BOTH runs, so what moves is the policy and not the guard.
  v_probe := _dma_move_sql('driver_month_assignments', v_live, format('company_id = %L', c_co_b));
  v_before := _dma_mutant('ALTER TABLE driver_month_assignments DISABLE TRIGGER driver_month_assignment_guard',
    c_admin, NULL, v_probe);
  v_after  := _dma_mutant('DO $m$ BEGIN ALTER TABLE driver_month_assignments DISABLE TRIGGER driver_month_assignment_guard; '
                          'ALTER POLICY driver_month_assignments_update ON public.driver_month_assignments WITH CHECK ((SELECT public.current_role_permits(''documents'', true))); END $m$',
    c_admin, NULL, v_probe);
  PERFORM _dma_expect('mutation M6: without the tenant term in WITH CHECK an assignment can be moved to another company',
    'ERR 42501 new row violates row-level security policy for table "driver_month_assignments" => rows 0',
    v_before || ' => ' || v_after);

  -- M7. The save RPC stops asking the role gate.
  v_probe := format('SELECT (public.driver_month_assignment_save(%L::jsonb) ->> ''success'')',
    _dma_payload(2020, 1, c_d12c, ARRAY[]::uuid[])::text);
  v_before := _dma_try(c_view, NULL, v_probe);
  v_after  := _dma_mutant($m$SELECT _dma_mutate_fn('public.driver_month_assignment_save(jsonb)', 'IF NOT public.current_role_permits(''documents'', true) THEN', 'IF false THEN')$m$,
    c_view, NULL, v_probe);
  PERFORM _dma_expect('mutation M7: without the role gate in the function the viewer assigns a driver',
    'ERR 42501 not_authorized => true', v_before || ' => ' || v_after);

  -- M8. The partial unique index is dropped: one driver gets two live assignments
  --     for one month.
  v_probe := format(
    'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id) VALUES (%L, 2020, 1, %L, %L)',
    c_co_a, c_d12, c_plan20);
  v_before := _dma_try(_dma_owner(), NULL, v_probe);
  v_after  := _dma_mutant('DROP INDEX public.driver_month_assignments_one_live_per_driver', _dma_owner(), NULL, v_probe);
  PERFORM _dma_expect('mutation M8: without the index a driver gets a second live assignment for one month',
    'ERR 23505 driver_month_assignments_one_live_per_driver => rows 1', v_before || ' => ' || v_after);

  -- M9. The one-claim-per-window constraint is dropped: two drivers hold one
  --     vehicle window.
  v_probe := format(
    'INSERT INTO driver_month_assignment_shifts (company_id, assignment_id, shift_id, minutes) VALUES (%L, %L, %L, 180)',
    c_co_a, v_live, v_12b);
  v_before := _dma_try(_dma_owner(), NULL, v_probe);
  v_after  := _dma_mutant('ALTER TABLE driver_month_assignment_shifts DROP CONSTRAINT driver_month_assignment_shifts_one_claim_per_shift',
    _dma_owner(), NULL, v_probe);
  PERFORM _dma_expect('mutation M9: without the constraint two drivers hold the same vehicle window',
    'ERR 23505 driver_month_assignment_shifts_one_claim_per_shift => rows 1', v_before || ' => ' || v_after);

  -- M10. The child guard stops checking the window's plan: an assignment for one
  --      month claims a window of another.
  v_probe := format(
    'INSERT INTO driver_month_assignment_shifts (company_id, assignment_id, shift_id, minutes) VALUES (%L, %L, %L, 180)',
    c_co_a, v_live, v_f2);
  v_before := _dma_try(c_admin, NULL, v_probe);
  v_after  := _dma_mutant($m$SELECT _dma_mutate_fn('app_private.driver_month_assignment_shift_guard()', 'IF v_shift.plan_id IS DISTINCT FROM v_parent.plan_id THEN', 'IF false THEN')$m$,
    c_admin, NULL, v_probe);
  PERFORM _dma_expect('mutation M10: without the plan check a window of another month''s plan is claimed',
    'ERR P0001 driver_month_assignment_shift_plan_mismatch => rows 1', v_before || ' => ' || v_after);

  -- M11. The freeze leaves the child guard: a committed assignment's windows can
  --      be deleted by hand, with no release behind it.
  v_probe := format('DELETE FROM driver_month_assignment_shifts WHERE assignment_id = %L', v_done);
  v_before := _dma_try(c_admin, NULL, v_probe);
  v_after  := _dma_mutant($m$SELECT _dma_mutate_fn('app_private.driver_month_assignment_shift_guard()', 'PERFORM app_private.driver_month_assignment_parent_is_open(OLD.assignment_id, OLD.company_id);', '')$m$,
    c_admin, NULL, v_probe);
  PERFORM _dma_expect('mutation M11: without the freeze in the child guard a committed assignment''s windows go by hand',
    'ERR P0001 driver_month_assignment_is_final => rows 1', v_before || ' => ' || v_after);

  -- M12. The release sets a marker the child guard does not read: it can then no
  --      longer free the windows at all, so the marker is load-bearing and not a
  --      convention.
  v_probe := format('SELECT (public.driver_month_assignment_release(%L, ''leave'') ->> ''success'')', v_done);
  v_before := _dma_try(c_admin, NULL, v_probe);
  v_after  := _dma_mutant($m$SELECT _dma_mutate_fn('public.driver_month_assignment_release(uuid,text,text)', 'app_private.driver_month_assignment_withdrawal', 'app_private.driver_month_assignment_nothing')$m$,
    c_admin, NULL, v_probe);
  PERFORM _dma_expect('mutation M12: with a marker the child guard does not read, the release cannot free the windows',
    'true => ERR P0001 driver_month_assignment_is_final', v_before || ' => ' || v_after);

  -- M13. The tenant term leaves the SELECT policy: company B reads company A's
  --      assignments.
  v_probe := format('SELECT (count(*) > 0)::text FROM driver_month_assignments WHERE company_id = %L', c_co_a);
  v_before := _dma_try(c_admin_b, NULL, v_probe);
  v_after  := _dma_mutant('ALTER POLICY driver_month_assignments_select ON public.driver_month_assignments USING (true)',
    c_admin_b, NULL, v_probe);
  PERFORM _dma_expect('mutation M13: without the tenant term company B reads company A''s assignments',
    'false => true', v_before || ' => ' || v_after);

  /*
    M14. The view-context refusal trigger is dropped -- and A VIEW CONTEXT STILL
    WRITES NOTHING, because there are TWO independent walls here and this control
    removes one of them. MEASURED on the VPS, 23.10.2026, against the expectation
    this line first carried (`=> rows 1`), which was wrong:

      with the trigger:     ERR P0001 support_session_required   (the trigger)
      without the trigger:  ERR 42501 new row violates row-level security policy

    The second wall is the Dokumente page gate inside the write policies.
    current_role_permits() has a platform branch that grants edit AS THE
    COMPANY'S OWN ADMINISTRATOR WOULD -- but only inside a SUPPORT session (3.4a),
    so for a VIEW context it answers false and the policy's WITH CHECK refuses the
    row on its own. tests/rls/matrix.sql says the same of monthly_plan_save and
    _confirm, for the same reason.

    So the control stands as a control -- the answer changes when the rule is
    removed, which is all a mutation control has to show -- and what it records is
    worth more than the sentence it replaced: the refusal trigger is not the only
    thing keeping a view context out of this table, and `support_session_required`
    is the trigger's own word and can come from nowhere else, which is what
    section 10 asserts.
  */
  v_probe := format(
    'INSERT INTO driver_month_assignments (company_id, year, month, driver_id, plan_id) VALUES (%L, 2020, 1, %L, %L)',
    c_co_a, c_d12c, c_plan20);
  v_before := _dma_try(c_view_p, c_s_view, v_probe);
  v_after  := _dma_mutant('DROP TRIGGER refuse_read_only_context_write ON public.driver_month_assignments',
    c_view_p, c_s_view, v_probe);
  PERFORM _dma_expect('mutation M14: without the refusal trigger a view context is still refused -- by the Dokumente page gate, the second of two walls',
    'ERR P0001 support_session_required => ERR 42501 new row violates row-level security policy for table "driver_month_assignments"',
    v_before || ' => ' || v_after);
END $$;

-- ─── 13. the verdict ────────────────────────────────────────────────────────
--
-- Every probe above recorded its outcome and none of them stopped the file, so
-- this is the one place the file can fail, and it fails with every difference at
-- once.

DO $$
DECLARE
  v_ok   bigint;
  v_bad  bigint;
  v_list text;
BEGIN
  SELECT count(*) FILTER (WHERE r.ok),
         count(*) FILTER (WHERE NOT r.ok),
         string_agg(format(E'  #%s %s\n      expected [%s]\n      got      [%s]',
                           r.n, r.label, r.expected, r.actual), E'\n' ORDER BY r.n) FILTER (WHERE NOT r.ok)
    INTO v_ok, v_bad, v_list
    FROM _dma_results r;

  RAISE NOTICE 'driver month assignments: % checks, % passed, % differ', v_ok + v_bad, v_ok, v_bad;

  IF v_bad > 0 THEN
    RAISE EXCEPTION E'driver month assignments: % check(s) differ from what migration 20261023120000 promises\n%',
      v_bad, v_list;
  END IF;
END $$;

ROLLBACK;
