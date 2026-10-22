/*
  Vehicle day plans: the forward plan, per vehicle and operating day, kept as a
  record (migration 20261022140000).

  Runs after the files before it, against the same throwaway database, as
  supabase_admin. The whole file is one transaction rolled back at the end, so
  the files after it see the database as the seeds left it.

  ── HOW THIS FILE REPORTS ────────────────────────────────────────────────────

  Every probe RECORDS its outcome in a table and the file asserts them all at
  the end (Docs/operating-rules.md, section 6): one run answers every question
  instead of the first wrong guess hiding the rest. Each line prints what the
  probe actually returned, in brackets, and a mismatch prints DIFF with the
  expected and the actual text. A statement that fails for a reason this file
  did not expect still aborts it, which is the right behaviour for a fixture.

  A probe whose refusals all share one SQLSTATE measures nothing, and the kit
  has been bitten by that twice. Here the refusals that share 42501 are told
  apart by what they print, and every one is asserted by its exact text:

      new row violates row-level security policy for table "…"   a policy
      permission denied for table / function …                    a missing GRANT
      not_authorized                                              the role gate of an RPC
      no_company                                                  the state gate of an RPC
      unauthenticated                                             no subject at all

  and each guard refusal prints its own HINT (vehicle_day_shift_moments_mismatch,
  vehicle_day_plan_is_final, …), each check its own constraint name.

  ── WHAT IS COVERED ──────────────────────────────────────────────────────────

    1. shape        both tables: RLS, exactly the four policies of the project's
                    one shape (SELECT is the tenant term or the read seam, no role
                    term; every write repeats one predicate as USING and WITH
                    CHECK plus the Dokumente page), both context triggers, the
                    guard, privileges, the five functions, and a closed list of
                    columns
    2. the rules    rule 1: the hour, the slot length and the algorithm version
                    are NOT NULL with no default; rule 2: nothing named like a
                    driver, and a payload key the RPC does not know is refused by
                    name; rule 3: no foreign key to the trips or the drivers and
                    no ride, address or fare key
    3. the hour     the stored hour is the reading: the same positions are 10:00
                    to 13:00 under hour 4 and 06:00 to 09:00 under hour 0, an
                    overnight shift and the end of the day are stored verbatim, a
                    shift whose moments contradict the stored hour is refused,
                    the hour cannot be edited, and the two DST nights play no part
    4. tenancy      a member reads only its own company; a plan cannot be moved to
                    another company, by the guard AND, with the guard switched
                    off, by the policy's WITH CHECK
    5. role gate    viewer and editor read and write nothing, directly or through
                    either RPC; supervisor and administrator write
    6. one active   the partial unique index refuses a second confirmed plan of a
                    month when written directly
    7. lifecycle    confirm, replace, generation, the freeze, status only through
                    the RPC, a draft's shifts go with it
    8. save         what the RPC refuses, by name; the totals are the database's;
                    a failed save leaves the earlier draft alone
    9. state        a suspended company and anon
   10. contexts     a view context reads and writes nothing; a support session
                    writes and each row leaves one audit row
   11. deletion     a company holding a confirmed and a superseded plan can still
                    be deleted (the defect 20261016140000 fixed for the monthly
                    plan), while the same delete of one plan is refused
   12. mutations    ten controls: break one rule inside a subtransaction, require
                    the probe to notice, and let the rollback restore it

  The matrix lines for both tables, and the EXECUTE grants of both RPCs, are in
  tests/rls/matrix.sql.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in monthly-plan.sql) ──────────────────────────────────

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

CREATE TEMP TABLE _vd_results (
  n        serial PRIMARY KEY,
  label    text   NOT NULL,
  expected text,
  actual   text,
  ok       boolean NOT NULL
);

/* Record one outcome and print it. A NULL actual never equals anything. */
CREATE OR REPLACE FUNCTION _vd_expect(p_label text, p_expected text, p_actual text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean := p_actual IS NOT DISTINCT FROM p_expected;
BEGIN
  INSERT INTO _vd_results (label, expected, actual, ok) VALUES (p_label, p_expected, p_actual, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok   % [%]', p_label, p_actual;
  ELSE
    RAISE NOTICE 'DIFF % -- expected [%] got [%]', p_label, p_expected, p_actual;
  END IF;
END $$;

/* A boolean check. NULL is a failure: a check that could not be evaluated proved nothing. */
CREATE OR REPLACE FUNCTION _vd_ok(p_label text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _vd_expect(p_label, 'true', coalesce(p_ok::text, 'NULL'));
END $$;

CREATE OR REPLACE FUNCTION _vd_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('vd:' || p_what)::uuid $$;

CREATE OR REPLACE FUNCTION _vd_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/* Become a signed-in caller with a password sign-in (and, when given, the
   session a platform context is answered to) -- or anon when p_user is NULL.
   Two sentinels: _vd_owner() keeps the table owner, to probe what no policy is
   asked about, and _vd_nobody() is the authenticated role with no subject. */
CREATE OR REPLACE FUNCTION _vd_owner() RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid $$;
CREATE OR REPLACE FUNCTION _vd_nobody() RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid $$;

CREATE OR REPLACE FUNCTION _vd_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _vd_reset();
  IF p_user = _vd_owner() THEN
    RETURN;
  END IF;
  IF p_user = _vd_nobody() THEN
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

/* Run p_sql as that caller in a subtransaction that is always rolled back and
   return the scalar it answered, `rows N` for a statement without a result, or
   `ERR <sqlstate> <hint, else message>`. Nothing it writes survives. The HINT is
   preferred because every refusal of the guards and the RPCs carries one. */
CREATE OR REPLACE FUNCTION _vd_try(p_user uuid, p_session uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
  v_hint  text;
BEGIN
  BEGIN
    PERFORM _vd_as(p_user, p_session);
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
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_hint = PG_EXCEPTION_HINT;
      v_out := 'ERR ' || v_state || ' ' || coalesce(nullif(v_hint, ''), v_msg);
  END;
  PERFORM _vd_reset();
  RETURN v_out;
END $$;

/* The same probe with a rule broken first. p_mutation runs as the owner inside
   the subtransaction (a DO block, so it may hold several statements and DDL),
   the probe then runs as the caller, and the whole subtransaction -- the
   mutation with it -- is rolled back. The plan cache does not hold the mutated
   body afterwards: PL/pgSQL re-reads a function whose catalogue tuple moved. */
CREATE OR REPLACE FUNCTION _vd_mutant(p_mutation text, p_user uuid, p_session uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text;
BEGIN
  BEGIN
    PERFORM _vd_reset();
    EXECUTE p_mutation;
    v_out := _vd_try(p_user, p_session, p_sql);
    RAISE EXCEPTION USING ERRCODE = 'ZZ032', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ032' THEN
      v_out := SQLERRM;
  END;
  PERFORM _vd_reset();
  RETURN v_out;
END $$;

/* The statement that moves one row, as a DO block for _vd_try. SELECT ... FOR UPDATE
   takes the row (which applies the UPDATE policy's USING to the existing row) and
   UPDATE ... WHERE CURRENT OF sets p_set without reading a column, so the new row
   meets the UPDATE policy's WITH CHECK and nothing else. A plain UPDATE ... WHERE id
   reads a column, and PostgreSQL then also asks the SELECT policy about the new
   row, which would let a tenant-scoped SELECT policy hide a WITH CHECK that lets
   the row go anywhere (the matrix's _mx_move_try is written for the same reason). */
CREATE OR REPLACE FUNCTION _vd_move_sql(p_table text, p_id uuid, p_set text) RETURNS text
LANGUAGE sql IMMUTABLE AS $body$
  SELECT format($f$DO $q$
    DECLARE
      c refcursor := 'vd_move';
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

/* A mutation of one function: take its live definition from the catalogue,
   replace one fragment and install the result. It refuses when the fragment is
   not there, because a mutation that changes nothing would make its control
   pass for the wrong reason. */
CREATE OR REPLACE FUNCTION _vd_mutate_fn(p_sig text, p_from text, p_to text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_old text := pg_get_functiondef(to_regprocedure(p_sig));
BEGIN
  IF v_old IS NULL OR position(p_from IN v_old) = 0 THEN
    RAISE EXCEPTION 'mutation control: % does not contain [%], so the mutation would change nothing', p_sig, p_from;
  END IF;
  EXECUTE replace(v_old, p_from, p_to);
END $$;

/* The audit log's high-water mark, so each check counts only its own rows. */
CREATE OR REPLACE FUNCTION _vd_mark() RETURNS bigint
LANGUAGE sql AS $$ SELECT coalesce(max(l.id), 0) FROM app_private.platform_audit_log l $$;

CREATE OR REPLACE FUNCTION _vd_rows(p_since bigint, p_action text DEFAULT NULL) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*)
    FROM app_private.platform_audit_log l
   WHERE l.id > p_since
     AND l.action ~ '^support_write\.'
     AND (p_action IS NULL OR l.action = p_action)
$$;

/* One shift as the RPC's payload carries it, computed from the positions the way
   the engine's SlotClock does. Used for volume; the cases that decide something
   also carry hand-computed literals. */
CREATE OR REPLACE FUNCTION _vd_shift(p_date date, p_vehicle text, p_index integer,
                                     p_from integer, p_to integer, p_hour integer,
                                     p_slot integer DEFAULT 15, p_revenue bigint DEFAULT 12345)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'operating_date', p_date,
    'vehicle', p_vehicle,
    'shift_index', p_index,
    'start_position', p_from,
    'end_position', p_to,
    'starts_local', to_char(p_date::timestamp + make_interval(mins => p_hour * 60 + p_from * p_slot), 'YYYY-MM-DD"T"HH24:MI'),
    'ends_local',   to_char(p_date::timestamp + make_interval(mins => p_hour * 60 + p_to   * p_slot), 'YYYY-MM-DD"T"HH24:MI'),
    'minutes', (p_to - p_from) * p_slot,
    'day_type', EXTRACT(ISODOW FROM p_date)::integer - 1,
    'is_holiday', false,
    'expected_revenue_cents', p_revenue,
    'expected_revenue_per_hour_cents', p_revenue * 60 / ((p_to - p_from) * p_slot),
    'confidence', 'high',
    'evidence_days', 9)
$$;

CREATE OR REPLACE FUNCTION _vd_payload(p_year integer, p_month integer, p_hour integer,
                                       p_slot integer, p_shifts jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'year', p_year, 'month', p_month,
    'operating_day_start_hour', p_hour, 'slot_minutes', p_slot,
    'algorithm_version', 'shift-recommendation/1.0.0',
    'shifts', p_shifts)
$$;

/* A fixture shift, written as the owner (RLS does not apply; the guards do). */
CREATE OR REPLACE FUNCTION _vd_put_shift(p_company uuid, p_plan uuid, p_date date, p_vehicle text,
                                         p_index integer, p_from integer, p_to integer,
                                         p_hour integer, p_slot integer DEFAULT 15) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  s    jsonb := _vd_shift(p_date, p_vehicle, p_index, p_from, p_to, p_hour, p_slot);
BEGIN
  INSERT INTO vehicle_day_shifts (id, company_id, plan_id, operating_date, vehicle, shift_index,
                                  start_position, end_position, starts_local, ends_local, minutes,
                                  day_type, is_holiday, expected_revenue_cents,
                                  expected_revenue_per_hour_cents, confidence, evidence_days)
  VALUES (v_id, p_company, p_plan, p_date, p_vehicle, p_index, p_from, p_to,
          (s ->> 'starts_local')::timestamp, (s ->> 'ends_local')::timestamp, (s ->> 'minutes')::integer,
          (s ->> 'day_type')::integer, false, (s ->> 'expected_revenue_cents')::bigint,
          (s ->> 'expected_revenue_per_hour_cents')::bigint, 'high', 9);
  RETURN v_id;
END $$;

-- ─── principals and data ────────────────────────────────────────────────────
--
-- seed.sql's two companies and their people (admin-a, editor-a, viewer-a,
-- admin-b, and `super`, a platform owner with no session), plus a supervisor,
-- a suspended company with an administrator, and two company-less platform
-- owners with a session each: one opens a view context on company A, the other a
-- support session. Ids are resolved by constants and md5, never by reading a
-- temp table, because the first role switch would lock this file's own helpers
-- out of any table the owner alone may select.

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
VALUES (_vd_id('company:suspended'), 'VD suspended', 'vd-suspended', 'approved', 'suspended', 'basic', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT _vd_id('user:' || v.who), 'vd-' || v.who || '@test.invalid', now()
FROM (VALUES ('supervisor-a'), ('admin-suspended'), ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
SELECT _vd_id('user:' || v.who), 'vd-' || v.who || '@test.invalid', 'VD ' || v.who, v.role,
       (SELECT r.id FROM roles r WHERE r.name = v.role AND r.company_id IS NULL),
       v.company_id, 'active'
FROM (VALUES
  ('supervisor-a',    'supervisor', 'c0000000-0000-4000-8000-00000000000a'::uuid),
  ('admin-suspended', 'admin',      _vd_id('company:suspended')),
  ('owner-view',      'viewer',     NULL::uuid),
  ('owner-support',   'viewer',     NULL::uuid)
) AS v(who, role, company_id)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES (_vd_id('user:owner-view'),    'owner', 'vd'),
       (_vd_id('user:owner-support'), 'owner', 'vd')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
SELECT _vd_id('session:' || v.who), _vd_id('user:' || v.who)
FROM (VALUES ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

-- One draft plan with two shifts for each of company A, company B and the
-- suspended company, written as the owner. October 2026 is the month the
-- matrix uses for the monthly plan; this file keeps to November 2026 and 2027.
INSERT INTO vehicle_day_plans (id, company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version)
VALUES
  (_vd_id('plan:a-draft'),    'c0000000-0000-4000-8000-00000000000a', 2026, 11, 4, 15, 'shift-recommendation/1.0.0'),
  (_vd_id('plan:b-draft'),    'c0000000-0000-4000-8000-00000000000b', 2026, 11, 4, 15, 'shift-recommendation/1.0.0'),
  (_vd_id('plan:susp-draft'), _vd_id('company:suspended'),            2026, 11, 4, 15, 'shift-recommendation/1.0.0');

-- Tuesday 2026-11-03, positions 24 to 36 under hour 4: 10:00 to 13:00.
SELECT _vd_put_shift('c0000000-0000-4000-8000-00000000000a', _vd_id('plan:a-draft'), DATE '2026-11-03', 'VD-CAR-A1', 0, 24, 36, 4);
SELECT _vd_put_shift('c0000000-0000-4000-8000-00000000000a', _vd_id('plan:a-draft'), DATE '2026-11-03', 'VD-CAR-A2', 0, 24, 36, 4);
SELECT _vd_put_shift('c0000000-0000-4000-8000-00000000000b', _vd_id('plan:b-draft'), DATE '2026-11-03', 'VD-CAR-B1', 0, 24, 36, 4);
SELECT _vd_put_shift(_vd_id('company:suspended'),            _vd_id('plan:susp-draft'), DATE '2026-11-03', 'VD-CAR-S1', 0, 24, 36, 4);

-- ─── 1. shape ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tbl   text;
  v_role  text;
  v_sig   text;
  v_wrong text;
  c_tables CONSTANT text[] := ARRAY['vehicle_day_plans', 'vehicle_day_shifts'];
BEGIN
  FOREACH v_tbl IN ARRAY c_tables LOOP
    PERFORM _vd_ok(format('shape: %s has row level security on', v_tbl),
      (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', v_tbl)::regclass));

    PERFORM _vd_ok(format('shape: %s carries exactly the four policies, for authenticated alone', v_tbl),
      (SELECT array_agg(p.policyname::text ORDER BY p.policyname)
         FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_tbl)
        = ARRAY[v_tbl || '_delete', v_tbl || '_insert', v_tbl || '_select', v_tbl || '_update']
      AND NOT EXISTS (SELECT 1 FROM pg_policies p
                       WHERE p.schemaname = 'public' AND p.tablename = v_tbl
                         AND p.roles <> ARRAY['authenticated']::name[]));

    SELECT string_agg(p.policyname::text, ', ') INTO v_wrong
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = v_tbl
       AND ((coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'get_active_company_id'
            OR (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'user_profiles|is_user_super_admin');
    PERFORM _vd_expect(format('shape: every %s policy asks get_active_company_id() and reads no profile', v_tbl),
                       '<none>', coalesce(v_wrong, '<none>'));

    SELECT string_agg(p.policyname::text, ', ') INTO v_wrong
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd <> 'SELECT'
       AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'current_role_permits\(''documents''';
    PERFORM _vd_expect(format('shape: every %s write policy asks the Dokumente page', v_tbl),
                       '<none>', coalesce(v_wrong, '<none>'));
    PERFORM _vd_ok(format('shape: the %s SELECT policy has no role term and reads the platform seam', v_tbl),
      (SELECT p.qual !~ 'current_role_permits' AND p.qual ~ 'platform_reads_company_data'
         FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd = 'SELECT'));
    PERFORM _vd_ok(format('shape: the %s UPDATE policy states one predicate as USING and as WITH CHECK', v_tbl),
      (SELECT p.qual = p.with_check FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd = 'UPDATE'));
    PERFORM _vd_ok(format('shape: the %s INSERT and DELETE policies carry the same write predicate as UPDATE', v_tbl),
      (SELECT count(DISTINCT coalesce(p.with_check, p.qual)) = 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE')));

    PERFORM _vd_ok(format('shape: %s carries the view-context refusal, per statement', v_tbl),
      EXISTS (SELECT 1 FROM pg_trigger g
               WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                 AND g.tgname = 'refuse_read_only_context_write'
                 AND NOT g.tgisinternal AND g.tgtype = 30 AND g.tgenabled = 'O'));
    PERFORM _vd_ok(format('shape: %s carries the support-write audit, per row and gated on the flag', v_tbl),
      EXISTS (SELECT 1 FROM pg_trigger g
               WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                 AND g.tgname = 'record_support_write'
                 AND NOT g.tgisinternal AND g.tgtype = 29 AND g.tgenabled = 'O'
                 AND pg_get_triggerdef(g.oid) ~ 'app_private\.support_write_context'));
    PERFORM _vd_ok(format('shape: %s carries its guard, BEFORE INSERT OR UPDATE OR DELETE per row', v_tbl),
      EXISTS (SELECT 1 FROM pg_trigger g
               WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                 AND g.tgname IN ('vehicle_day_plan_guard', 'vehicle_day_shift_guard')
                 AND NOT g.tgisinternal AND g.tgtype = 31 AND g.tgenabled = 'O'));
    PERFORM _vd_ok(format('shape: %s has the id column the support-write audit names its rows by', v_tbl),
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = format('public.%I', v_tbl)::regclass
                AND a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped));

    FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
      PERFORM _vd_ok(format('privileges: %s holds nothing on %s', v_role, v_tbl),
        NOT has_table_privilege(v_role, format('public.%I', v_tbl),
                                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
    END LOOP;
    PERFORM _vd_ok(format('privileges: authenticated holds SELECT, INSERT, UPDATE and DELETE on %s and nothing else', v_tbl),
      has_table_privilege('authenticated', format('public.%I', v_tbl), 'SELECT')
      AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'INSERT')
      AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'UPDATE')
      AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'DELETE')
      AND NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'TRUNCATE,REFERENCES,TRIGGER'));
  END LOOP;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM _vd_ok(format('privileges: %s cannot reach app_private', v_role),
      NOT has_schema_privilege(v_role, 'app_private', 'USAGE'));
  END LOOP;

  -- The three guards: SECURITY DEFINER, a pinned search_path, executable by no
  -- API role. A SECURITY INVOKER function here would be 42501 for every company
  -- administrator, which is PR #117's defect.
  FOREACH v_sig IN ARRAY ARRAY['app_private.vehicle_day_plan_guard()',
                               'app_private.vehicle_day_shift_guard()',
                               'app_private.vehicle_day_plan_parent_is_open(uuid,uuid)'] LOOP
    PERFORM _vd_ok(format('shape: %s is SECURITY DEFINER with a pinned search_path', v_sig),
      to_regprocedure(v_sig) IS NOT NULL
      AND (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig))
      AND EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                   WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=%'));
    PERFORM _vd_ok(format('privileges: no API role can execute %s', v_sig),
      NOT has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
      AND NOT has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE')
      AND NOT has_function_privilege('service_role', to_regprocedure(v_sig), 'EXECUTE'));
  END LOOP;

  -- Both RPCs: SECURITY DEFINER and VOLATILE, so supabase-js calls them with
  -- POST; authenticated only; the state helper, the Dokumente page and the lock.
  FOREACH v_sig IN ARRAY ARRAY['public.vehicle_day_plan_save(jsonb)',
                               'public.vehicle_day_plan_confirm(uuid,boolean)'] LOOP
    PERFORM _vd_ok(format('shape: %s is SECURITY DEFINER, VOLATILE, search_path pinned', v_sig),
      to_regprocedure(v_sig) IS NOT NULL
      AND (SELECT p.prosecdef AND p.provolatile = 'v' FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig))
      AND EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                   WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=%'));
    PERFORM _vd_ok(format('privileges: %s is authenticated''s alone', v_sig),
      has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE')
      AND NOT has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
      AND NOT has_function_privilege('service_role', to_regprocedure(v_sig), 'EXECUTE'));
    PERFORM _vd_ok(format('shape: %s asks the state helper, the Dokumente page and takes the month''s lock', v_sig),
      (SELECT p.prosrc ~ 'get_active_company_id'
              AND p.prosrc ~ 'current_role_permits\(''documents'', true\)'
              AND p.prosrc ~ 'not_authorized'
              AND p.prosrc ~ 'pg_advisory_xact_lock'
         FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)));
  END LOOP;

  -- A closed list of columns. A new column is a deliberate edit of this line, and
  -- so a conversation about whether it widens rules 2 and 3.
  PERFORM _vd_expect('shape: the columns of vehicle_day_plans are exactly these',
    'id, company_id, year, month, status, operating_day_start_hour, slot_minutes, algorithm_version, generation, summary, confirmed_at, confirmed_by, superseded_at, superseded_by, replaced_by_plan_id, created_by, created_at, updated_by, updated_at',
    (SELECT string_agg(a.attname, ', ' ORDER BY a.attnum) FROM pg_attribute a
      WHERE a.attrelid = 'public.vehicle_day_plans'::regclass AND a.attnum > 0 AND NOT a.attisdropped));
  PERFORM _vd_expect('shape: the columns of vehicle_day_shifts are exactly these',
    'id, company_id, plan_id, operating_date, vehicle, shift_index, start_position, end_position, starts_local, ends_local, minutes, day_type, is_holiday, expected_revenue_cents, expected_revenue_per_hour_cents, confidence, evidence_days, created_at',
    (SELECT string_agg(a.attname, ', ' ORDER BY a.attnum) FROM pg_attribute a
      WHERE a.attrelid = 'public.vehicle_day_shifts'::regclass AND a.attnum > 0 AND NOT a.attisdropped));
END $$;

-- ─── 2. the three rules, as structure ───────────────────────────────────────

DO $$
DECLARE
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_co    CONSTANT text := 'c0000000-0000-4000-8000-00000000000a';
  v_base  text;
BEGIN
  -- Rule 1. No default, NOT NULL, and the refusals say which.
  PERFORM _vd_ok('rule 1: the hour, the slot length and the algorithm version are NOT NULL with no default',
    (SELECT count(*) = 3 AND bool_and(a.attnotnull) AND NOT bool_or(a.atthasdef)
       FROM pg_attribute a
      WHERE a.attrelid = 'public.vehicle_day_plans'::regclass
        AND a.attname IN ('operating_day_start_hour', 'slot_minutes', 'algorithm_version')));

  PERFORM _vd_expect('rule 1: a plan inserted without the hour is refused as a NULL, not defaulted to 4',
    'ERR 23502 null value in column "operating_day_start_hour" of relation "vehicle_day_plans" violates not-null constraint',
    _vd_try(c_admin, NULL, format(
      'INSERT INTO vehicle_day_plans (company_id, year, month, slot_minutes, algorithm_version) VALUES (%L, 2030, 1, 15, ''v'')', c_co)));
  PERFORM _vd_expect('rule 1: hour 24 is refused by name',
    'ERR 23514 new row for relation "vehicle_day_plans" violates check constraint "vehicle_day_plans_start_hour_valid"',
    _vd_try(c_admin, NULL, format(
      'INSERT INTO vehicle_day_plans (company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version) VALUES (%L, 2030, 1, 24, 15, ''v'')', c_co)));
  PERFORM _vd_expect('rule 1: hour -1 is refused by the same check',
    'ERR 23514 new row for relation "vehicle_day_plans" violates check constraint "vehicle_day_plans_start_hour_valid"',
    _vd_try(c_admin, NULL, format(
      'INSERT INTO vehicle_day_plans (company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version) VALUES (%L, 2030, 1, -1, 15, ''v'')', c_co)));
  PERFORM _vd_expect('rule 1: a slot length of 20 is refused by name',
    'ERR 23514 new row for relation "vehicle_day_plans" violates check constraint "vehicle_day_plans_slot_minutes_supported"',
    _vd_try(c_admin, NULL, format(
      'INSERT INTO vehicle_day_plans (company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version) VALUES (%L, 2030, 1, 4, 20, ''v'')', c_co)));
  PERFORM _vd_expect('rule 1: the hours 0 and 23 are the ends of the range and are accepted',
    'rows 1|rows 1',
    _vd_try(c_admin, NULL, format(
      'INSERT INTO vehicle_day_plans (company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version) VALUES (%L, 2030, 1, 0, 15, ''v'')', c_co))
    || '|' ||
    _vd_try(c_admin, NULL, format(
      'INSERT INTO vehicle_day_plans (company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version) VALUES (%L, 2030, 2, 23, 60, ''v'')', c_co)));

  -- Rule 2. Nothing named like a driver, a ride, an address or a fare.
  PERFORM _vd_expect('rule 2: no column of either table is named like a driver, a ride, an address or a fare',
    '<none>',
    coalesce((SELECT string_agg(format('%s.%s', c.relname, a.attname), ', ' ORDER BY c.relname, a.attname)
                FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
               WHERE c.oid IN ('public.vehicle_day_plans'::regclass, 'public.vehicle_day_shifts'::regclass)
                 AND a.attnum > 0 AND NOT a.attisdropped
                 AND a.attname ~ '(^|_)(driver|fahrer|ride|trip|address|adresse|fare|tip|trinkgeld|passenger|customer|pickup|destination|route|gps|lat|lng|latitude|longitude)(_|$)'),
             '<none>'));

  -- Rule 3. No foreign key to the trips or the drivers, and no function names them.
  PERFORM _vd_expect('rule 3: neither table references fahrtenbuch_trips or drivers',
    '<none>',
    coalesce((SELECT string_agg(format('%s.%s', c.conrelid::regclass, c.conname), ', ')
                FROM pg_constraint c
               WHERE c.contype = 'f'
                 AND c.conrelid IN ('public.vehicle_day_plans'::regclass, 'public.vehicle_day_shifts'::regclass)
                 AND c.confrelid IN (to_regclass('public.fahrtenbuch_trips'), to_regclass('public.drivers'))),
             '<none>'));
  PERFORM _vd_expect('rule 3: none of the five functions names the trips or the drivers',
    '<none>',
    coalesce((SELECT string_agg(f.sig, ', ')
                FROM unnest(ARRAY['app_private.vehicle_day_plan_guard()',
                                  'app_private.vehicle_day_shift_guard()',
                                  'app_private.vehicle_day_plan_parent_is_open(uuid,uuid)',
                                  'public.vehicle_day_plan_save(jsonb)',
                                  'public.vehicle_day_plan_confirm(uuid,boolean)']) AS f(sig)
               WHERE (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure(f.sig))
                       ~* 'fahrtenbuch_trips|\mdrivers\M'),
             '<none>'));
  PERFORM _vd_ok('rule 3: fahrtenbuch_trips still has no UPDATE policy, which a plan that "applied" would have needed',
    NOT EXISTS (SELECT 1 FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = 'fahrtenbuch_trips' AND p.cmd = 'UPDATE'));

  -- The RPC's two closed key lists: a driver, an address or a fare sent to it
  -- is refused and named, not ignored.
  v_base := '"year": 2030, "month": 3, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v"';
  PERFORM _vd_expect('rule 2: a payload that carries a drivers list is refused, and the key is named',
    'ERR 22023 vehicle_day_plan_save: unknown payload key(s): drivers',
    _vd_try(c_admin, NULL, format(
      'SELECT public.vehicle_day_plan_save(%L::jsonb)::text', '{' || v_base || ', "drivers": [], "shifts": []}')));
  PERFORM _vd_expect('rule 2: a shift that names a driver is refused, and the key is named',
    'ERR 22023 vehicle_day_plan_save: unknown shift key(s): driver_id',
    _vd_try(c_admin, NULL, format(
      'SELECT public.vehicle_day_plan_save(%L::jsonb)::text',
      '{' || v_base || ', "shifts": [' || ((_vd_shift(DATE '2030-03-04', 'X', 0, 24, 36, 4)) || '{"driver_id": "x"}'::jsonb)::text || ']}')));
  PERFORM _vd_expect('rule 3: a shift that carries an address and a fare is refused, both keys named',
    'ERR 22023 vehicle_day_plan_save: unknown shift key(s): address, fare',
    _vd_try(c_admin, NULL, format(
      'SELECT public.vehicle_day_plan_save(%L::jsonb)::text',
      '{' || v_base || ', "shifts": [' || ((_vd_shift(DATE '2030-03-04', 'X', 0, 24, 36, 4)) || '{"address": "a", "fare": 5}'::jsonb)::text || ']}')));
  PERFORM _vd_expect('rule 3: a shift that names a ride is refused',
    'ERR 22023 vehicle_day_plan_save: unknown shift key(s): ride_id',
    _vd_try(c_admin, NULL, format(
      'SELECT public.vehicle_day_plan_save(%L::jsonb)::text',
      '{' || v_base || ', "shifts": [' || ((_vd_shift(DATE '2030-03-04', 'X', 0, 24, 36, 4)) || '{"ride_id": "x"}'::jsonb)::text || ']}')));
END $$;


-- ─── 3. the stored hour is the reading ──────────────────────────────────────
--
-- Weekdays used below, worked out by hand and not by the database: 1 January 2027
-- is a Friday, so 1 February 2027 is a Monday (31 days on), 2 February a Tuesday,
-- 5 February a Friday, 6 February a Saturday; 1 March 2027 is a Monday too (28
-- days on). The positions are 15-minute slots counted from the operating day's
-- start, so under hour 4 position 24 is 04:00 + 6 h = 10:00 and position 36 is
-- 04:00 + 9 h = 13:00.

DO $$
DECLARE
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  v_res   jsonb;
  v_plan  uuid;
BEGIN
  -- 3a. Hour 4: an ordinary shift, an overnight shift and the end of the day.
  PERFORM _vd_as(c_admin);
  v_res := public.vehicle_day_plan_save('{
    "year": 2027, "month": 2, "operating_day_start_hour": 4, "slot_minutes": 15,
    "algorithm_version": "shift-recommendation/1.0.0",
    "shifts": [
      {"operating_date": "2027-02-02", "vehicle": "VD-HOUR", "shift_index": 0,
       "start_position": 24, "end_position": 36,
       "starts_local": "2027-02-02T10:00", "ends_local": "2027-02-02T13:00",
       "minutes": 180, "day_type": 1, "is_holiday": false,
       "expected_revenue_cents": 12345, "expected_revenue_per_hour_cents": 4115,
       "confidence": "high", "evidence_days": 9},
      {"operating_date": "2027-02-05", "vehicle": "VD-HOUR", "shift_index": 0,
       "start_position": 72, "end_position": 88,
       "starts_local": "2027-02-05T22:00", "ends_local": "2027-02-06T02:00",
       "minutes": 240, "day_type": 4, "is_holiday": false,
       "expected_revenue_cents": 20000, "expected_revenue_per_hour_cents": 5000,
       "confidence": "medium", "evidence_days": 5},
      {"operating_date": "2027-02-06", "vehicle": "VD-HOUR", "shift_index": 0,
       "start_position": 80, "end_position": 96,
       "starts_local": "2027-02-07T00:00", "ends_local": "2027-02-07T04:00",
       "minutes": 240, "day_type": 5, "is_holiday": false,
       "expected_revenue_cents": 9000, "expected_revenue_per_hour_cents": 2250,
       "confidence": "low", "evidence_days": 2}
    ]}'::jsonb);
  PERFORM _vd_reset();
  v_plan := (v_res ->> 'plan_id')::uuid;

  PERFORM _vd_expect('hour: the save answers success with three shifts', 'true|3',
    (v_res ->> 'success') || '|' || (v_res ->> 'shift_count'));
  PERFORM _vd_expect('hour: the plan row stores the hour, the slot length and the version that were sent',
    '4|15|shift-recommendation/1.0.0',
    (SELECT operating_day_start_hour || '|' || slot_minutes || '|' || algorithm_version
       FROM vehicle_day_plans WHERE id = v_plan));
  PERFORM _vd_expect('hour: positions 24 to 36 under hour 4 are 10:00 to 13:00, 180 minutes',
    '2027-02-02 10:00:00|2027-02-02 13:00:00|180',
    (SELECT starts_local || '|' || ends_local || '|' || minutes FROM vehicle_day_shifts
      WHERE plan_id = v_plan AND operating_date = DATE '2027-02-02'));
  PERFORM _vd_expect('hour: an overnight shift crosses midnight by adding minutes, 22:00 to 02:00',
    '2027-02-05 22:00:00|2027-02-06 02:00:00|240',
    (SELECT starts_local || '|' || ends_local || '|' || minutes FROM vehicle_day_shifts
      WHERE plan_id = v_plan AND operating_date = DATE '2027-02-05'));
  PERFORM _vd_expect('hour: the last slot of the operating day ends at the next day''s 04:00',
    '2027-02-07 00:00:00|2027-02-07 04:00:00|240',
    (SELECT starts_local || '|' || ends_local || '|' || minutes FROM vehicle_day_shifts
      WHERE plan_id = v_plan AND operating_date = DATE '2027-02-06'));
  PERFORM _vd_expect('hour: the engine''s estimates, confidence and evidence travel with the shift',
    '12345|4115|high|9',
    (SELECT expected_revenue_cents || '|' || expected_revenue_per_hour_cents || '|' || confidence || '|' || evidence_days
       FROM vehicle_day_shifts WHERE plan_id = v_plan AND operating_date = DATE '2027-02-02'));
  PERFORM _vd_expect('hour: a reader takes the hour from the row, as the member who may read it',
    '4', _vd_try(c_admin, NULL, format('SELECT operating_day_start_hour::text FROM vehicle_day_plans WHERE id = %L', v_plan)));

  -- 3b. The SAME positions under hour 0 are a different window: the hour is what
  -- gives the positions their meaning, and it is the plan's, not a constant.
  PERFORM _vd_as(c_admin);
  v_res := public.vehicle_day_plan_save('{
    "year": 2027, "month": 3, "operating_day_start_hour": 0, "slot_minutes": 15,
    "algorithm_version": "shift-recommendation/1.0.0",
    "shifts": [
      {"operating_date": "2027-03-02", "vehicle": "VD-HOUR", "shift_index": 0,
       "start_position": 24, "end_position": 36,
       "starts_local": "2027-03-02T06:00", "ends_local": "2027-03-02T09:00",
       "minutes": 180, "day_type": 1, "is_holiday": false,
       "expected_revenue_cents": 12345, "expected_revenue_per_hour_cents": 4115,
       "confidence": "high", "evidence_days": 9}
    ]}'::jsonb);
  PERFORM _vd_reset();
  v_plan := (v_res ->> 'plan_id')::uuid;
  PERFORM _vd_expect('hour: hour 0 is stored as 0, not mistaken for "unset"',
    '0', (SELECT operating_day_start_hour::text FROM vehicle_day_plans WHERE id = v_plan));
  PERFORM _vd_expect('hour: positions 24 to 36 under hour 0 are 06:00 to 09:00, not 10:00 to 13:00',
    '2027-03-02 06:00:00|2027-03-02 09:00:00',
    (SELECT starts_local || '|' || ends_local FROM vehicle_day_shifts WHERE plan_id = v_plan));
END $$;

DO $$
DECLARE
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  v_plan  uuid;
  v_out   text;
  v_hint  text;
  v_four  text := '"year": 2027, "month": 4, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v"';
  v_zero  text := '"year": 2027, "month": 4, "operating_day_start_hour": 0, "slot_minutes": 15, "algorithm_version": "v"';
  v_s60   text := '"year": 2027, "month": 4, "operating_day_start_hour": 4, "slot_minutes": 60, "algorithm_version": "v"';
  v_s30   text := '"year": 2027, "month": 4, "operating_day_start_hour": 4, "slot_minutes": 30, "algorithm_version": "v"';
  -- Thursday 1 April 2027, positions 24 to 36. Fields in the payload's order.
  v_head  text := '"operating_date": "2027-04-01", "vehicle": "VD-X", "shift_index": 0, "day_type": 3, "is_holiday": false, "expected_revenue_cents": 100, "expected_revenue_per_hour_cents": 33, "confidence": "high", "evidence_days": 3';
BEGIN
  -- 3c. A shift whose moments contradict the plan's stored hour is refused, and
  -- the refusal names the contradiction. Both directions of the lie.
  PERFORM _vd_expect('hour: plan says 4 but the shift''s moments are cut by hour 0 (06:00 to 09:00)',
    'ERR P0001 vehicle_day_shift_moments_mismatch',
    _vd_try(c_admin, NULL, format('SELECT public.vehicle_day_plan_save(%L::jsonb)::text',
      '{' || v_four || ', "shifts": [{' || v_head || ', "start_position": 24, "end_position": 36, "starts_local": "2027-04-01T06:00", "ends_local": "2027-04-01T09:00", "minutes": 180}]}')));
  PERFORM _vd_expect('hour: plan says 0 but the shift''s moments are cut by hour 4 (10:00 to 13:00)',
    'ERR P0001 vehicle_day_shift_moments_mismatch',
    _vd_try(c_admin, NULL, format('SELECT public.vehicle_day_plan_save(%L::jsonb)::text',
      '{' || v_zero || ', "shifts": [{' || v_head || ', "start_position": 24, "end_position": 36, "starts_local": "2027-04-01T10:00", "ends_local": "2027-04-01T13:00", "minutes": 180}]}')));
  PERFORM _vd_expect('hour: the end alone is a quarter hour out',
    'ERR P0001 vehicle_day_shift_moments_mismatch',
    _vd_try(c_admin, NULL, format('SELECT public.vehicle_day_plan_save(%L::jsonb)::text',
      '{' || v_four || ', "shifts": [{' || v_head || ', "start_position": 24, "end_position": 36, "starts_local": "2027-04-01T10:00", "ends_local": "2027-04-01T13:15", "minutes": 180}]}')));
  PERFORM _vd_expect('hour: the same shift with consistent moments is accepted (the control for the three refusals above)',
    'true',
    _vd_try(c_admin, NULL, format('SELECT (public.vehicle_day_plan_save(%L::jsonb) ->> ''success'')',
      '{' || v_four || ', "shifts": [{' || v_head || ', "start_position": 24, "end_position": 36, "starts_local": "2027-04-01T10:00", "ends_local": "2027-04-01T13:00", "minutes": 180}]}')));

  -- 3d. The other things the guard recomputes, each with its own hint.
  PERFORM _vd_expect('hour: minutes that are not (end - start) slots',
    'ERR P0001 vehicle_day_shift_minutes_mismatch',
    _vd_try(c_admin, NULL, format('SELECT public.vehicle_day_plan_save(%L::jsonb)::text',
      '{' || v_four || ', "shifts": [{' || v_head || ', "start_position": 24, "end_position": 36, "starts_local": "2027-04-01T10:00", "ends_local": "2027-04-01T13:00", "minutes": 175}]}')));
  PERFORM _vd_expect('hour: a 60-minute plan has 24 positions, so end position 25 does not fit the day',
    'ERR P0001 vehicle_day_shift_positions_invalid',
    _vd_try(c_admin, NULL, format('SELECT public.vehicle_day_plan_save(%L::jsonb)::text',
      '{' || v_s60 || ', "shifts": [{' || v_head || ', "start_position": 20, "end_position": 25, "starts_local": "2027-04-02T00:00", "ends_local": "2027-04-02T05:00", "minutes": 300}]}')));
  PERFORM _vd_expect('hour: a 15-minute plan has 96 positions, so end position 97 does not fit the day',
    'ERR P0001 vehicle_day_shift_positions_invalid',
    _vd_try(c_admin, NULL, format('SELECT public.vehicle_day_plan_save(%L::jsonb)::text',
      '{' || v_four || ', "shifts": [{' || v_head || ', "start_position": 90, "end_position": 97, "starts_local": "2027-04-02T02:30", "ends_local": "2027-04-02T04:15", "minutes": 105}]}')));
  PERFORM _vd_expect('hour: a 30-minute plan has 48 positions, and end position 48 is the end of the day (accepted)',
    'true',
    _vd_try(c_admin, NULL, format('SELECT (public.vehicle_day_plan_save(%L::jsonb) ->> ''success'')',
      '{' || v_s30 || ', "shifts": [{' || v_head || ', "start_position": 42, "end_position": 48, "starts_local": "2027-04-02T01:00", "ends_local": "2027-04-02T04:00", "minutes": 180}]}')));
  PERFORM _vd_expect('hour: an operating day outside the plan''s month',
    'ERR P0001 vehicle_day_shift_outside_month',
    _vd_try(c_admin, NULL, format('SELECT public.vehicle_day_plan_save(%L::jsonb)::text',
      '{' || v_four || ', "shifts": [{' || replace(v_head, '2027-04-01', '2027-05-01') || ', "start_position": 24, "end_position": 36, "starts_local": "2027-05-01T10:00", "ends_local": "2027-05-01T13:00", "minutes": 180}]}')));

  -- 3e. The hour, the slot length and the version are the plan's for its life.
  SELECT id INTO v_plan FROM vehicle_day_plans WHERE company_id = 'c0000000-0000-4000-8000-00000000000a' AND year = 2027 AND month = 2;
  PERFORM _vd_expect('hour: a member cannot edit the stored hour of a draft',
    'ERR P0001 vehicle_day_plan_key_fixed',
    _vd_try(c_admin, NULL, format('UPDATE vehicle_day_plans SET operating_day_start_hour = 0 WHERE id = %L', v_plan)));
  PERFORM _vd_expect('hour: nor the slot length',
    'ERR P0001 vehicle_day_plan_key_fixed',
    _vd_try(c_admin, NULL, format('UPDATE vehicle_day_plans SET slot_minutes = 30 WHERE id = %L', v_plan)));
  PERFORM _vd_expect('hour: nor the algorithm version',
    'ERR P0001 vehicle_day_plan_key_fixed',
    _vd_try(c_admin, NULL, format('UPDATE vehicle_day_plans SET algorithm_version = ''other'' WHERE id = %L', v_plan)));
  BEGIN
    UPDATE vehicle_day_plans SET operating_day_start_hour = 0 WHERE id = v_plan;
    v_out := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    v_out := 'ERR ' || SQLSTATE || ' ' || coalesce(nullif(v_hint, ''), SQLERRM);
  END;
  PERFORM _vd_expect('hour: the owner of the table cannot either, because the guard is a trigger and not a policy',
    'ERR P0001 vehicle_day_plan_key_fixed', v_out);
  PERFORM _vd_expect('hour: …and the stored hour is still 4 afterwards',
    '4', (SELECT operating_day_start_hour::text FROM vehicle_day_plans WHERE id = v_plan));
  PERFORM _vd_expect('hour: the same update of a field that may change is accepted (the control)',
    'rows 1',
    _vd_try(c_admin, NULL, format('UPDATE vehicle_day_plans SET summary = summary || ''{"note": "x"}''::jsonb WHERE id = %L', v_plan)));
END $$;

-- 3f. The two nights a year the clocks change. A shift is stored as wall-clock
-- moments, so neither night skips or repeats anything: 2026-03-29 02:00 to 03:00
-- does not exist in Europe/Berlin and 2026-10-25 02:00 to 03:00 happens twice,
-- and the schema stores what the engine said and does not guess an instant. The
-- first shift ends at 02:30 on the night that has no 02:30.
DO $$
DECLARE
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  v_res   jsonb;
  v_plan  uuid;
BEGIN
  PERFORM _vd_as(c_admin);
  v_res := public.vehicle_day_plan_save('{
    "year": 2026, "month": 3, "operating_day_start_hour": 4, "slot_minutes": 15,
    "algorithm_version": "shift-recommendation/1.0.0",
    "shifts": [
      {"operating_date": "2026-03-28", "vehicle": "VD-DST", "shift_index": 0,
       "start_position": 72, "end_position": 90,
       "starts_local": "2026-03-28T22:00", "ends_local": "2026-03-29T02:30",
       "minutes": 270, "day_type": 5, "is_holiday": false,
       "expected_revenue_cents": 100, "expected_revenue_per_hour_cents": 22,
       "confidence": "low", "evidence_days": 2},
      {"operating_date": "2026-03-28", "vehicle": "VD-DST", "shift_index": 1,
       "start_position": 90, "end_position": 96,
       "starts_local": "2026-03-29T02:30", "ends_local": "2026-03-29T04:00",
       "minutes": 90, "day_type": 5, "is_holiday": false,
       "expected_revenue_cents": 100, "expected_revenue_per_hour_cents": 67,
       "confidence": "low", "evidence_days": 2}
    ]}'::jsonb);
  PERFORM _vd_reset();
  v_plan := (v_res ->> 'plan_id')::uuid;
  PERFORM _vd_expect('DST: a shift ending at 02:30 on the night that has no 02:30 is stored verbatim',
    '2026-03-29 02:30:00|270',
    (SELECT ends_local || '|' || minutes FROM vehicle_day_shifts WHERE plan_id = v_plan AND shift_index = 0));
  PERFORM _vd_expect('DST: and the next shift starts at that same wall time, so the two touch and do not overlap',
    '2026-03-29 02:30:00',
    (SELECT starts_local::text FROM vehicle_day_shifts WHERE plan_id = v_plan AND shift_index = 1));

  PERFORM _vd_as(c_admin);
  v_res := public.vehicle_day_plan_save('{
    "year": 2026, "month": 10, "operating_day_start_hour": 4, "slot_minutes": 15,
    "algorithm_version": "shift-recommendation/1.0.0",
    "shifts": [
      {"operating_date": "2026-10-24", "vehicle": "VD-DST", "shift_index": 0,
       "start_position": 72, "end_position": 96,
       "starts_local": "2026-10-24T22:00", "ends_local": "2026-10-25T04:00",
       "minutes": 360, "day_type": 5, "is_holiday": false,
       "expected_revenue_cents": 100, "expected_revenue_per_hour_cents": 17,
       "confidence": "low", "evidence_days": 2}
    ]}'::jsonb);
  PERFORM _vd_reset();
  v_plan := (v_res ->> 'plan_id')::uuid;
  PERFORM _vd_expect('DST: the night the clocks go back is 360 wall minutes from 22:00 to 04:00, not 420',
    '2026-10-24 22:00:00|2026-10-25 04:00:00|360',
    (SELECT starts_local || '|' || ends_local || '|' || minutes FROM vehicle_day_shifts WHERE plan_id = v_plan));
  PERFORM _vd_ok('DST: the moments are timestamps without time zone, so no instant was guessed',
    (SELECT bool_and(format_type(a.atttypid, a.atttypmod) = 'timestamp without time zone')
       FROM pg_attribute a
      WHERE a.attrelid = 'public.vehicle_day_shifts'::regclass AND a.attname IN ('starts_local', 'ends_local')));
END $$;

-- 3g. Other slot lengths and an hour late in the day. Persisted so the reading
-- can be checked from the stored row.
DO $$
DECLARE
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  v_res   jsonb;
BEGIN
  PERFORM _vd_as(c_admin);
  v_res := public.vehicle_day_plan_save('{
    "year": 2027, "month": 6, "operating_day_start_hour": 22, "slot_minutes": 60,
    "algorithm_version": "shift-recommendation/1.0.0",
    "shifts": [
      {"operating_date": "2027-06-01", "vehicle": "VD-LATE", "shift_index": 0,
       "start_position": 0, "end_position": 6,
       "starts_local": "2027-06-01T22:00", "ends_local": "2027-06-02T04:00",
       "minutes": 360, "day_type": 1, "is_holiday": false,
       "expected_revenue_cents": 100, "expected_revenue_per_hour_cents": 17,
       "confidence": "low", "evidence_days": 2},
      {"operating_date": "2027-06-01", "vehicle": "VD-LATE", "shift_index": 1,
       "start_position": 22, "end_position": 24,
       "starts_local": "2027-06-02T20:00", "ends_local": "2027-06-02T22:00",
       "minutes": 120, "day_type": 1, "is_holiday": false,
       "expected_revenue_cents": 100, "expected_revenue_per_hour_cents": 50,
       "confidence": "low", "evidence_days": 2}
    ]}'::jsonb);
  PERFORM _vd_reset();
  PERFORM _vd_expect('slot: hour 22 with 60-minute slots, positions 0 to 6, is 22:00 to 04:00 the next day',
    '2027-06-01 22:00:00|2027-06-02 04:00:00',
    (SELECT starts_local || '|' || ends_local FROM vehicle_day_shifts
      WHERE plan_id = (v_res ->> 'plan_id')::uuid AND shift_index = 0));
  PERFORM _vd_expect('slot: and the last two slots of that operating day end at the next day''s 22:00',
    '2027-06-02 20:00:00|2027-06-02 22:00:00',
    (SELECT starts_local || '|' || ends_local FROM vehicle_day_shifts
      WHERE plan_id = (v_res ->> 'plan_id')::uuid AND shift_index = 1));
END $$;

-- ─── 4. tenancy ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_admin_a CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_admin_b CONSTANT uuid := 'b0000000-0000-4000-8000-000000000001';
  c_super   CONSTANT uuid := '50000000-0000-4000-8000-000000000001';
  c_co_a    CONSTANT text := 'c0000000-0000-4000-8000-00000000000a';
  c_co_b    CONSTANT text := 'c0000000-0000-4000-8000-00000000000b';
  v_tbl     text;
  v_shift   text := '2026-11-03';
  v_shift_id uuid;
BEGIN
  -- Read once, here: ALTER TABLE below refuses a table the same statement still has open.
  SELECT s.id INTO v_shift_id FROM vehicle_day_shifts s WHERE s.plan_id = _vd_id('plan:a-draft') ORDER BY s.vehicle LIMIT 1;

  FOREACH v_tbl IN ARRAY ARRAY['vehicle_day_plans', 'vehicle_day_shifts'] LOOP
    PERFORM _vd_expect(format('tenants: company A''s administrator reads none of company B''s %s', v_tbl),
      '0', _vd_try(c_admin_a, NULL, format('SELECT count(*)::text FROM %I WHERE company_id = %L', v_tbl, c_co_b)));
    PERFORM _vd_expect(format('tenants: company B''s administrator reads none of company A''s %s', v_tbl),
      '0', _vd_try(c_admin_b, NULL, format('SELECT count(*)::text FROM %I WHERE company_id = %L', v_tbl, c_co_a)));
    PERFORM _vd_ok(format('tenants: …and each reads its own (the control for the two zeros above) [%s]', v_tbl),
      _vd_try(c_admin_a, NULL, format('SELECT (count(*) > 0)::text FROM %I WHERE company_id = %L', v_tbl, c_co_a)) = 'true'
      AND _vd_try(c_admin_b, NULL, format('SELECT (count(*) > 0)::text FROM %I WHERE company_id = %L', v_tbl, c_co_b)) = 'true');
    PERFORM _vd_expect(format('tenants: a platform owner with no context reads no %s', v_tbl),
      '0', _vd_try(c_super, NULL, format('SELECT count(*)::text FROM %I', v_tbl)));
  END LOOP;

  PERFORM _vd_expect('tenants: company B''s administrator cannot insert a plan into company A',
    'ERR 42501 new row violates row-level security policy for table "vehicle_day_plans"',
    _vd_try(c_admin_b, NULL, format(
      'INSERT INTO vehicle_day_plans (company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version) VALUES (%L, 2031, 1, 4, 15, ''v'')', c_co_a)));
  PERFORM _vd_expect('tenants: …and can insert one into its own company (the control)',
    'rows 1',
    _vd_try(c_admin_b, NULL, format(
      'INSERT INTO vehicle_day_plans (company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version) VALUES (%L, 2031, 1, 4, 15, ''v'')', c_co_b)));
  PERFORM _vd_expect('tenants: company B''s administrator cannot insert a shift into company A''s plan, as company A',
    'ERR 42501 new row violates row-level security policy for table "vehicle_day_shifts"',
    _vd_try(c_admin_b, NULL, format(
      'INSERT INTO vehicle_day_shifts (company_id, plan_id, operating_date, vehicle, shift_index, start_position, end_position, starts_local, ends_local, minutes, day_type, is_holiday, expected_revenue_cents, expected_revenue_per_hour_cents, confidence, evidence_days) VALUES (%L, %L, %L, ''VD-CAR-A9'', 0, 24, 36, ''2026-11-03 10:00'', ''2026-11-03 13:00'', 180, 1, false, 1, 1, ''low'', 1)',
      c_co_a, _vd_id('plan:a-draft'), v_shift)));
  PERFORM _vd_expect('tenants: …and cannot hang a shift of its own company on company A''s plan',
    'ERR P0001 vehicle_day_plan_company_mismatch',
    _vd_try(c_admin_b, NULL, format(
      'INSERT INTO vehicle_day_shifts (company_id, plan_id, operating_date, vehicle, shift_index, start_position, end_position, starts_local, ends_local, minutes, day_type, is_holiday, expected_revenue_cents, expected_revenue_per_hour_cents, confidence, evidence_days) VALUES (%L, %L, %L, ''VD-CAR-B9'', 0, 24, 36, ''2026-11-03 10:00'', ''2026-11-03 13:00'', 180, 1, false, 1, 1, ''low'', 1)',
      c_co_b, _vd_id('plan:a-draft'), v_shift)));

  -- A move. The guards refuse it first, with a name of their own.
  PERFORM _vd_expect('tenants: a plan cannot be moved from company A to company B',
    'ERR P0001 vehicle_day_plan_key_fixed',
    _vd_try(c_admin_a, NULL, format('UPDATE vehicle_day_plans SET company_id = %L WHERE id = %L', c_co_b, _vd_id('plan:a-draft'))));
  PERFORM _vd_expect('tenants: a shift cannot be moved from company A to company B',
    'ERR P0001 vehicle_day_plan_child_key_fixed',
    _vd_try(c_admin_a, NULL, format('UPDATE vehicle_day_shifts SET company_id = %L WHERE plan_id = %L', c_co_b, _vd_id('plan:a-draft'))));
  PERFORM _vd_expect('tenants: company B''s administrator updating company A''s plan touches nothing',
    'rows 0',
    _vd_try(c_admin_b, NULL, format('UPDATE vehicle_day_plans SET summary = summary WHERE id = %L', _vd_id('plan:a-draft'))));
  PERFORM _vd_expect('tenants: …nor deletes it',
    'rows 0',
    _vd_try(c_admin_b, NULL, format('DELETE FROM vehicle_day_plans WHERE id = %L', _vd_id('plan:a-draft'))));

  -- The policy's own WITH CHECK, with the guard switched off: a move is refused
  -- by the policy and not only by the trigger in front of it. The guard is
  -- disabled inside the probe's subtransaction, so the rollback re-enables it.
  PERFORM _vd_expect('tenants: with the plan guard off, the UPDATE policy''s WITH CHECK still refuses the move to company B',
    'ERR 42501 new row violates row-level security policy for table "vehicle_day_plans"',
    _vd_mutant('ALTER TABLE vehicle_day_plans DISABLE TRIGGER vehicle_day_plan_guard', c_admin_a, NULL,
      _vd_move_sql('vehicle_day_plans', _vd_id('plan:a-draft'), format('company_id = %L', c_co_b))));
  PERFORM _vd_expect('tenants: with the shift guard off, the UPDATE policy''s WITH CHECK still refuses the move to company B',
    'ERR 42501 new row violates row-level security policy for table "vehicle_day_shifts"',
    _vd_mutant('ALTER TABLE vehicle_day_shifts DISABLE TRIGGER vehicle_day_shift_guard', c_admin_a, NULL,
      _vd_move_sql('vehicle_day_shifts', v_shift_id, format('company_id = %L', c_co_b))));
END $$;

-- ─── 5. the role gate ───────────────────────────────────────────────────────
--
-- The seeded roles, read out of role_permissions rather than written down, so
-- the probe and the seed cannot drift: an administrator and a supervisor hold
-- can_edit on the Dokumente page, an editor and a viewer do not.

DO $$
DECLARE
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_edit  CONSTANT uuid := 'a0000000-0000-4000-8000-000000000002';
  c_view  CONSTANT uuid := 'a0000000-0000-4000-8000-000000000003';
  c_sup   CONSTANT uuid := _vd_id('user:supervisor-a');
  c_co    CONSTANT text := 'c0000000-0000-4000-8000-00000000000a';
  v_payload text := '{"year": 2031, "month": 5, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v", "shifts": []}';
  v_ins   text := format('INSERT INTO vehicle_day_plans (company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version) VALUES (%L, 2031, 6, 4, 15, ''v'')', c_co);
  v_upd   text := format('UPDATE vehicle_day_plans SET summary = summary WHERE id = %L', _vd_id('plan:a-draft'));
  v_del   text := format('DELETE FROM vehicle_day_plans WHERE id = %L', _vd_id('plan:a-draft'));
  v_sins  text := format('INSERT INTO vehicle_day_shifts (company_id, plan_id, operating_date, vehicle, shift_index, start_position, end_position, starts_local, ends_local, minutes, day_type, is_holiday, expected_revenue_cents, expected_revenue_per_hour_cents, confidence, evidence_days) VALUES (%L, %L, ''2026-11-04'', ''VD-CAR-A7'', 0, 24, 36, ''2026-11-04 10:00'', ''2026-11-04 13:00'', 180, 2, false, 1, 1, ''low'', 1)', c_co, _vd_id('plan:a-draft'));
  v_who   record;
BEGIN
  PERFORM _vd_expect('roles: the viewer and the editor hold no can_edit on the Dokumente page; the supervisor and the administrator do',
    'admin:true,editor:false,supervisor:true,viewer:false',
    (SELECT string_agg(r.name || ':' || rp.can_edit::text, ',' ORDER BY r.name)
       FROM roles r JOIN role_permissions rp ON rp.role_id = r.id AND rp.page_key = 'documents'
      WHERE r.company_id IS NULL AND r.name IN ('viewer', 'editor', 'supervisor', 'admin')));

  FOR v_who IN
    SELECT * FROM (VALUES ('viewer', c_view), ('editor', c_edit)) AS w(label, uid)
  LOOP
    PERFORM _vd_expect(format('roles: the %s still reads the plan', v_who.label),
      'true', _vd_try(v_who.uid, NULL, 'SELECT (count(*) > 0)::text FROM vehicle_day_plans'));
    PERFORM _vd_expect(format('roles: the %s reads the shifts too', v_who.label),
      'true', _vd_try(v_who.uid, NULL, 'SELECT (count(*) > 0)::text FROM vehicle_day_shifts'));
    PERFORM _vd_expect(format('roles: a direct insert of a plan is refused for the %s, by the policy', v_who.label),
      'ERR 42501 new row violates row-level security policy for table "vehicle_day_plans"', _vd_try(v_who.uid, NULL, v_ins));
    PERFORM _vd_expect(format('roles: a direct insert of a shift is refused for the %s, by the policy', v_who.label),
      'ERR 42501 new row violates row-level security policy for table "vehicle_day_shifts"', _vd_try(v_who.uid, NULL, v_sins));
    PERFORM _vd_expect(format('roles: an update touches nothing for the %s, because the row is out of its reach', v_who.label),
      'rows 0', _vd_try(v_who.uid, NULL, v_upd));
    PERFORM _vd_expect(format('roles: a delete touches nothing for the %s', v_who.label),
      'rows 0', _vd_try(v_who.uid, NULL, v_del));
    PERFORM _vd_expect(format('roles: vehicle_day_plan_save is refused for the %s, by the function''s own gate', v_who.label),
      'ERR 42501 not_authorized', _vd_try(v_who.uid, NULL, format('SELECT public.vehicle_day_plan_save(%L::jsonb)::text', v_payload)));
    PERFORM _vd_expect(format('roles: vehicle_day_plan_confirm is refused for the %s, before it looks at the plan', v_who.label),
      'ERR 42501 not_authorized', _vd_try(v_who.uid, NULL, format('SELECT public.vehicle_day_plan_confirm(%L)::text', _vd_id('plan:a-draft'))));
  END LOOP;

  FOR v_who IN
    SELECT * FROM (VALUES ('supervisor', c_sup), ('administrator', c_admin)) AS w(label, uid)
  LOOP
    PERFORM _vd_expect(format('roles: the %s inserts a plan directly', v_who.label), 'rows 1', _vd_try(v_who.uid, NULL, v_ins));
    PERFORM _vd_expect(format('roles: the %s inserts a shift directly', v_who.label), 'rows 1', _vd_try(v_who.uid, NULL, v_sins));
    PERFORM _vd_expect(format('roles: the %s updates a draft', v_who.label), 'rows 1', _vd_try(v_who.uid, NULL, v_upd));
    PERFORM _vd_expect(format('roles: the %s deletes a draft', v_who.label), 'rows 1', _vd_try(v_who.uid, NULL, v_del));
    PERFORM _vd_expect(format('roles: vehicle_day_plan_save answers the %s', v_who.label),
      'true', _vd_try(v_who.uid, NULL, format('SELECT (public.vehicle_day_plan_save(%L::jsonb) ->> ''success'')', v_payload)));
    PERFORM _vd_expect(format('roles: vehicle_day_plan_confirm answers the %s', v_who.label),
      'true', _vd_try(v_who.uid, NULL, format('SELECT (public.vehicle_day_plan_confirm(%L) ->> ''success'')', _vd_id('plan:a-draft'))));
  END LOOP;
END $$;

-- ─── 6. one confirmed plan per month, in the database ───────────────────────
--
-- Written directly, with no RPC in the path: the second confirmed plan of one
-- month is refused by the index and not by a function anybody could bypass.
-- The marker is what the plan guard asks of a status change, set here by hand
-- the way the RPC sets it, and the statement runs inside a session because the
-- guard stamps confirmed_by from it.

DO $$
DECLARE
  c_admin_a CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_admin_b CONSTANT uuid := 'b0000000-0000-4000-8000-000000000001';
  c_co_a    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_co_b    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000b';
  v_def     text;
  v_out     text;
BEGIN
  SELECT pg_get_indexdef(to_regclass('public.vehicle_day_plans_one_confirmed_per_month')) INTO v_def;
  PERFORM _vd_ok('index: unique, on (company_id, year, month), partial on confirmed, and on nothing else',
    v_def ~ 'CREATE UNIQUE INDEX' AND v_def ~ 'company_id, year, month\)'
    AND v_def ~ 'WHERE \(status = ''confirmed''::text\)');

  INSERT INTO vehicle_day_plans (id, company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version)
  VALUES (_vd_id('plan:a-1'), c_co_a, 2028, 1, 4, 15, 'v'),
         (_vd_id('plan:a-2'), c_co_a, 2028, 1, 4, 15, 'v'),
         (_vd_id('plan:b-1'), c_co_b, 2028, 1, 4, 15, 'v');
  PERFORM _vd_expect('index: two drafts of one month may coexist, a new proposal beside a saved one', '2',
    (SELECT count(*)::text FROM vehicle_day_plans WHERE company_id = c_co_a AND year = 2028 AND month = 1));

  PERFORM set_config('app_private.vehicle_day_plan_transition',
    'plan:' || _vd_id('plan:a-1')::text || ':' || pg_current_xact_id()::text, true);
  PERFORM _vd_as(c_admin_a);
  UPDATE vehicle_day_plans SET status = 'confirmed' WHERE id = _vd_id('plan:a-1');
  PERFORM _vd_reset();
  PERFORM set_config('app_private.vehicle_day_plan_transition', '', true);
  PERFORM _vd_expect('index: the first plan of the month is confirmed, stamped by the database with the caller and the time',
    'confirmed|true|true',
    (SELECT status || '|' || (confirmed_by = c_admin_a)::text || '|' || (confirmed_at IS NOT NULL)::text
       FROM vehicle_day_plans WHERE id = _vd_id('plan:a-1')));

  BEGIN
    PERFORM set_config('app_private.vehicle_day_plan_transition',
      'plan:' || _vd_id('plan:a-2')::text || ':' || pg_current_xact_id()::text, true);
    PERFORM _vd_as(c_admin_a);
    UPDATE vehicle_day_plans SET status = 'confirmed' WHERE id = _vd_id('plan:a-2');
    v_out := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    v_out := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM _vd_reset();
  PERFORM set_config('app_private.vehicle_day_plan_transition', '', true);
  PERFORM _vd_expect('index: a second CONFIRMED plan of the same month is refused by the index itself',
    '23505 duplicate key value violates unique constraint "vehicle_day_plans_one_confirmed_per_month"', v_out);

  -- The same month of another company is untouched by the rule.
  PERFORM set_config('app_private.vehicle_day_plan_transition',
    'plan:' || _vd_id('plan:b-1')::text || ':' || pg_current_xact_id()::text, true);
  PERFORM _vd_as(c_admin_b);
  UPDATE vehicle_day_plans SET status = 'confirmed' WHERE id = _vd_id('plan:b-1');
  PERFORM _vd_reset();
  PERFORM set_config('app_private.vehicle_day_plan_transition', '', true);
  PERFORM _vd_expect('index: the same month of another company may be confirmed too', 'confirmed',
    (SELECT status FROM vehicle_day_plans WHERE id = _vd_id('plan:b-1')));
  PERFORM _vd_expect('index: …and a draft beside a confirmed plan is still allowed',
    'confirmed|draft',
    (SELECT string_agg(status, '|' ORDER BY status) FROM vehicle_day_plans
      WHERE company_id = c_co_a AND year = 2028 AND month = 1));
END $$;


-- ─── 7. confirming, replacing, and the freeze ───────────────────────────────
--
-- August 2027 for company A. Each save replaces the month's draft, so the
-- scenarios run in order: an empty plan, an overlap, a legal plan that is
-- confirmed, a second plan that is refused beside it and then replaces it, and a
-- third that stays a draft.

DO $$
DECLARE
  c_admin   CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_admin_b CONSTANT uuid := 'b0000000-0000-4000-8000-000000000001';
  c_co      CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_res     jsonb;
  v_empty   uuid;
  v_overlap uuid;
  v_p1      uuid;
  v_p2      uuid;
  v_p3      uuid;
  v_n       bigint;
BEGIN
  -- 7a. A month may plan nothing, and may save it; it may not confirm it.
  PERFORM _vd_as(c_admin);
  v_res := public.vehicle_day_plan_save(_vd_payload(2027, 8, 4, 15, '[]'::jsonb));
  PERFORM _vd_reset();
  v_empty := (v_res ->> 'plan_id')::uuid;
  PERFORM _vd_expect('lifecycle: an empty proposal can be saved', 'true|0',
    (v_res ->> 'success') || '|' || (v_res ->> 'shift_count'));
  PERFORM _vd_expect('lifecycle: …its summary says it holds nothing', '0|0|0|0|0',
    (SELECT concat_ws('|', summary ->> 'shift_count', summary ->> 'vehicle_count', summary ->> 'operating_day_count',
                      summary ->> 'total_minutes', summary ->> 'expected_revenue_cents')
       FROM vehicle_day_plans WHERE id = v_empty));
  PERFORM _vd_expect('lifecycle: …but confirming it is refused, by return value and not by exception', 'plan_empty',
    _vd_try(c_admin, NULL, format('SELECT public.vehicle_day_plan_confirm(%L) ->> ''reason''', v_empty)));

  -- 7b. A vehicle is never on the road twice at once: 10:00 to 13:00 and 12:45 to 14:00.
  PERFORM _vd_as(c_admin);
  v_res := public.vehicle_day_plan_save(_vd_payload(2027, 8, 4, 15, jsonb_build_array(
    _vd_shift(DATE '2027-08-02', 'VD-O', 0, 24, 36, 4),
    _vd_shift(DATE '2027-08-02', 'VD-O', 1, 35, 40, 4))));
  PERFORM _vd_reset();
  v_overlap := (v_res ->> 'plan_id')::uuid;
  PERFORM _vd_expect('lifecycle: the save accepts two overlapping shifts of one vehicle (each is legal alone)', 'true', v_res ->> 'success');
  PERFORM _vd_expect('lifecycle: confirming them is refused, by return value', 'vehicle_overlap',
    _vd_try(c_admin, NULL, format('SELECT public.vehicle_day_plan_confirm(%L) ->> ''reason''', v_overlap)));
  PERFORM _vd_expect('lifecycle: …and the plan is still a draft', 'draft',
    (SELECT status FROM vehicle_day_plans WHERE id = v_overlap));

  -- 7c. A legal plan: shifts of one vehicle that touch (13:00 ends, 13:00 begins), a
  -- second vehicle out at the same hours, and the end of one operating day
  -- meeting the start of the next (04:00).
  PERFORM _vd_as(c_admin);
  v_res := public.vehicle_day_plan_save(_vd_payload(2027, 8, 4, 15, jsonb_build_array(
    _vd_shift(DATE '2027-08-02', 'VD-O', 0, 24, 36, 4),
    _vd_shift(DATE '2027-08-02', 'VD-O', 1, 36, 40, 4),
    _vd_shift(DATE '2027-08-02', 'VD-P', 0, 24, 36, 4),
    _vd_shift(DATE '2027-08-03', 'VD-O', 0, 80, 96, 4),
    _vd_shift(DATE '2027-08-04', 'VD-O', 0, 0, 12, 4))));
  PERFORM _vd_reset();
  v_p1 := (v_res ->> 'plan_id')::uuid;
  PERFORM _vd_expect('lifecycle: the first plan of a month is generation 0', '0',
    (SELECT generation::text FROM vehicle_day_plans WHERE id = v_p1));

  PERFORM _vd_as(c_admin);
  v_res := public.vehicle_day_plan_confirm(v_p1);
  PERFORM _vd_reset();
  PERFORM _vd_expect('lifecycle: touching shifts, two vehicles at once and a day boundary are not overlaps, so it is confirmed',
    'true|' || v_p1::text || '|', (v_res ->> 'success') || '|' || (v_res ->> 'plan_id') || '|' || coalesce(v_res ->> 'superseded_plan_id', ''));
  PERFORM _vd_expect('lifecycle: the database stamps the confirmation with the caller and the time', 'confirmed|true|true',
    (SELECT status || '|' || (confirmed_by = c_admin)::text || '|' || (confirmed_at IS NOT NULL)::text
       FROM vehicle_day_plans WHERE id = v_p1));
  PERFORM _vd_expect('lifecycle: a plan that is no longer a draft cannot be confirmed again', 'not_a_draft',
    _vd_try(c_admin, NULL, format('SELECT public.vehicle_day_plan_confirm(%L) ->> ''reason''', v_p1)));

  -- 7d. A second proposal for the same month: generation 1, refused beside the
  -- active plan, the active plan untouched.
  PERFORM _vd_as(c_admin);
  v_res := public.vehicle_day_plan_save(_vd_payload(2027, 8, 4, 15, jsonb_build_array(
    _vd_shift(DATE '2027-08-09', 'VD-O', 0, 24, 36, 4))));
  PERFORM _vd_reset();
  v_p2 := (v_res ->> 'plan_id')::uuid;
  PERFORM _vd_expect('lifecycle: a new proposal beside a confirmed plan is generation 1 and a draft', '1|draft',
    (SELECT generation || '|' || status FROM vehicle_day_plans WHERE id = v_p2));
  PERFORM _vd_expect('lifecycle: confirming it without asking to replace answers plan_exists and names the active plan',
    'plan_exists|' || v_p1::text,
    _vd_try(c_admin, NULL, format(
      'SELECT concat_ws(''|'', r ->> ''reason'', r ->> ''existing_plan_id'') FROM (SELECT public.vehicle_day_plan_confirm(%L) AS r) x', v_p2)));
  PERFORM _vd_expect('lifecycle: …and writes nothing', 'confirmed|draft',
    (SELECT string_agg(status, '|' ORDER BY status) FROM vehicle_day_plans WHERE id IN (v_p1, v_p2)));

  -- 7e. The replacement is one transaction: the old plan is superseded and points
  -- at the new one, the new one is confirmed, and the month holds one confirmed plan.
  PERFORM _vd_as(c_admin);
  v_res := public.vehicle_day_plan_confirm(v_p2, true);
  PERFORM _vd_reset();
  PERFORM _vd_expect('lifecycle: replacing confirms the new plan and names the one it superseded',
    'true|' || v_p1::text, (v_res ->> 'success') || '|' || (v_res ->> 'superseded_plan_id'));
  PERFORM _vd_expect('lifecycle: the old plan is superseded, stamped, and points at its replacement',
    'superseded|true|true|' || v_p2::text,
    (SELECT status || '|' || (superseded_by = c_admin)::text || '|' || (superseded_at IS NOT NULL AND confirmed_at IS NOT NULL)::text
                || '|' || replaced_by_plan_id::text FROM vehicle_day_plans WHERE id = v_p1));
  PERFORM _vd_expect('lifecycle: exactly one plan of the month is confirmed, and it is the new one', '1|' || v_p2::text,
    (SELECT count(*)::text || '|' || min(id::text) FROM vehicle_day_plans
      WHERE company_id = c_co AND year = 2027 AND month = 8 AND status = 'confirmed'));

  -- 7f. The next proposal is generation 2: two plans of the month were confirmed.
  PERFORM _vd_as(c_admin);
  v_res := public.vehicle_day_plan_save(_vd_payload(2027, 8, 4, 15, jsonb_build_array(
    _vd_shift(DATE '2027-08-10', 'VD-O', 0, 24, 36, 4))));
  PERFORM _vd_reset();
  v_p3 := (v_res ->> 'plan_id')::uuid;
  PERFORM _vd_expect('lifecycle: after a replacement the next proposal is generation 2', '2',
    (SELECT generation::text FROM vehicle_day_plans WHERE id = v_p3));
  PERFORM _vd_expect('lifecycle: the empty and the overlapping drafts of the same month are gone', '1',
    (SELECT count(*)::text FROM vehicle_day_plans WHERE company_id = c_co AND year = 2027 AND month = 8 AND status = 'draft'));

  -- 7g. Status is the RPC's. Nobody writes it directly, the owner included.
  PERFORM _vd_expect('lifecycle: a member cannot confirm a plan by writing its status', 'ERR P0001 vehicle_day_plan_transition_needs_rpc',
    _vd_try(c_admin, NULL, format('UPDATE vehicle_day_plans SET status = ''confirmed'' WHERE id = %L', v_p3)));
  PERFORM _vd_expect('lifecycle: nor take a confirmed plan back to a draft', 'ERR P0001 vehicle_day_plan_transition_needs_rpc',
    _vd_try(c_admin, NULL, format('UPDATE vehicle_day_plans SET status = ''draft'' WHERE id = %L', v_p2)));
  PERFORM _vd_expect('lifecycle: the owner of the table cannot either', 'ERR P0001 vehicle_day_plan_transition_needs_rpc',
    _vd_try(_vd_owner(), NULL, format('UPDATE vehicle_day_plans SET status = ''confirmed'' WHERE id = %L', v_p3)));
  PERFORM _vd_expect('lifecycle: nor stamp a confirmation in someone else''s name', 'ERR P0001 vehicle_day_plan_transition_needs_rpc',
    _vd_try(c_admin, NULL, format('UPDATE vehicle_day_plans SET confirmed_by = %L WHERE id = %L', c_admin_b, v_p2)));

  -- 7h. A confirmed plan is the month's record and a superseded one its history.
  PERFORM _vd_expect('freeze: a confirmed plan''s header cannot be edited', 'ERR P0001 vehicle_day_plan_is_final',
    _vd_try(c_admin, NULL, format('UPDATE vehicle_day_plans SET summary = summary WHERE id = %L', v_p2)));
  PERFORM _vd_expect('freeze: a confirmed plan cannot be deleted', 'ERR P0001 vehicle_day_plan_is_final',
    _vd_try(c_admin, NULL, format('DELETE FROM vehicle_day_plans WHERE id = %L', v_p2)));
  PERFORM _vd_expect('freeze: a superseded plan cannot be deleted either', 'ERR P0001 vehicle_day_plan_is_final',
    _vd_try(c_admin, NULL, format('DELETE FROM vehicle_day_plans WHERE id = %L', v_p1)));
  PERFORM _vd_expect('freeze: the owner of the table cannot delete a confirmed plan', 'ERR P0001 vehicle_day_plan_is_final',
    _vd_try(_vd_owner(), NULL, format('DELETE FROM vehicle_day_plans WHERE id = %L', v_p2)));
  PERFORM _vd_expect('freeze: no shift can be added to a confirmed plan', 'ERR P0001 vehicle_day_plan_is_final',
    _vd_try(c_admin, NULL, format(
      'INSERT INTO vehicle_day_shifts (company_id, plan_id, operating_date, vehicle, shift_index, start_position, end_position, starts_local, ends_local, minutes, day_type, is_holiday, expected_revenue_cents, expected_revenue_per_hour_cents, confidence, evidence_days) VALUES (%L, %L, ''2027-08-11'', ''VD-LATE'', 0, 24, 36, ''2027-08-11 10:00'', ''2027-08-11 13:00'', 180, 2, false, 1, 1, ''low'', 1)',
      c_co, v_p2)));
  PERFORM _vd_expect('freeze: no shift of a confirmed plan can be edited', 'ERR P0001 vehicle_day_plan_is_final',
    _vd_try(c_admin, NULL, format('UPDATE vehicle_day_shifts SET evidence_days = 1 WHERE plan_id = %L', v_p2)));
  PERFORM _vd_expect('freeze: no shift of a confirmed plan can be deleted', 'ERR P0001 vehicle_day_plan_is_final',
    _vd_try(c_admin, NULL, format('DELETE FROM vehicle_day_shifts WHERE plan_id = %L', v_p2)));
  PERFORM _vd_expect('freeze: nor can a shift of a superseded plan', 'ERR P0001 vehicle_day_plan_is_final',
    _vd_try(c_admin, NULL, format('DELETE FROM vehicle_day_shifts WHERE plan_id = %L', v_p1)));
  PERFORM _vd_expect('freeze: the same edits of a DRAFT''s shift are accepted (the control for the four refusals above)', 'rows 1',
    _vd_try(c_admin, NULL, format('UPDATE vehicle_day_shifts SET evidence_days = 1 WHERE plan_id = %L', v_p3)));

  -- 7i. A draft goes with its shifts.
  SELECT count(*) INTO v_n FROM vehicle_day_shifts WHERE plan_id = v_p3;
  PERFORM _vd_as(c_admin);
  DELETE FROM vehicle_day_plans WHERE id = v_p3;
  PERFORM _vd_reset();
  PERFORM _vd_expect('freeze: deleting a draft takes its shifts with it', '1|0',
    v_n::text || '|' || (SELECT count(*)::text FROM vehicle_day_shifts WHERE plan_id = v_p3));

  -- 7j. Another company's plan is not found, and a missing id is a contract error.
  PERFORM _vd_expect('lifecycle: company B''s administrator confirming company A''s plan is told it does not exist', 'plan_not_found',
    _vd_try(c_admin_b, NULL, format('SELECT public.vehicle_day_plan_confirm(%L) ->> ''reason''', v_p1)));
  PERFORM _vd_expect('lifecycle: an id that exists nowhere is told the same', 'plan_not_found',
    _vd_try(c_admin, NULL, format('SELECT public.vehicle_day_plan_confirm(%L) ->> ''reason''', _vd_id('plan:nowhere'))));
  PERFORM _vd_expect('lifecycle: no id at all is a broken contract, not a refusal', 'ERR 22023 vehicle_day_plan_confirm: p_plan_id is required',
    _vd_try(c_admin, NULL, 'SELECT public.vehicle_day_plan_confirm(NULL)::text'));

  -- 7k. The numbering is per company and per month.
  PERFORM _vd_as(c_admin_b);
  v_res := public.vehicle_day_plan_save(_vd_payload(2027, 8, 4, 15, jsonb_build_array(
    _vd_shift(DATE '2027-08-02', 'VD-BO', 0, 24, 36, 4))));
  PERFORM _vd_reset();
  PERFORM _vd_expect('lifecycle: company B''s first plan of the same month is generation 0, whatever company A has done', '0',
    (SELECT generation::text FROM vehicle_day_plans WHERE id = (v_res ->> 'plan_id')::uuid));
END $$;

-- ─── 8. what the save refuses, and what it computes ─────────────────────────

DO $$
DECLARE
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_co    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_res   jsonb;
  v_first uuid;
  v_out   text;
  v_hint  text;
  v_rec   record;
  v_big   text;
BEGIN
  -- 8a. A new save replaces the month's draft rather than adding a second.
  PERFORM _vd_as(c_admin);
  v_res := public.vehicle_day_plan_save(_vd_payload(2027, 9, 4, 15, jsonb_build_array(
    _vd_shift(DATE '2027-09-06', 'VD-S', 0, 24, 36, 4))));
  v_first := (v_res ->> 'plan_id')::uuid;
  PERFORM _vd_reset();
  PERFORM _vd_expect('save: the first save of a month discards nothing', '0', v_res ->> 'discarded_drafts');

  -- 8b. Three shifts, two vehicles, two operating days. The client lies about the
  -- totals and keeps a note of its own; the database writes the totals itself.
  PERFORM _vd_as(c_admin);
  v_res := public.vehicle_day_plan_save(
    _vd_payload(2027, 9, 4, 15, jsonb_build_array(
      _vd_shift(DATE '2027-09-06', 'VD-S', 0, 24, 36, 4, 15, 12345),
      _vd_shift(DATE '2027-09-07', 'VD-S', 0, 24, 40, 4, 15, 12345),
      _vd_shift(DATE '2027-09-06', 'VD-T', 0, 24, 36, 4, 15, 12345)))
    || '{"summary": {"shift_count": 999, "total_minutes": -1, "note": "kept", "history_months": [{"year": 2027, "month": 7}]}}'::jsonb);
  PERFORM _vd_reset();
  PERFORM _vd_expect('save: a second save of the month discards the earlier draft and says so', '1',
    v_res ->> 'discarded_drafts');
  PERFORM _vd_expect('save: …the old draft is gone and one draft remains', '0|1',
    (SELECT count(*) FILTER (WHERE id = v_first)::text || '|' || count(*)::text FROM vehicle_day_plans
      WHERE company_id = c_co AND year = 2027 AND month = 9 AND status = 'draft'));
  PERFORM _vd_expect('save: the database writes the five totals over what the client sent',
    '3|2|2|600|37035',
    (SELECT concat_ws('|', summary ->> 'shift_count', summary ->> 'vehicle_count', summary ->> 'operating_day_count',
                      summary ->> 'total_minutes', summary ->> 'expected_revenue_cents')
       FROM vehicle_day_plans WHERE id = (v_res ->> 'plan_id')::uuid));
  PERFORM _vd_expect('save: …and keeps the client''s own provenance beside them', 'kept|2027',
    (SELECT (summary ->> 'note') || '|' || (summary -> 'history_months' -> 0 ->> 'year')
       FROM vehicle_day_plans WHERE id = (v_res ->> 'plan_id')::uuid));
  v_first := (v_res ->> 'plan_id')::uuid;

  -- 8c. A refused save leaves the earlier draft exactly as it was.
  BEGIN
    PERFORM _vd_as(c_admin);
    PERFORM public.vehicle_day_plan_save(_vd_payload(2027, 9, 4, 15, jsonb_build_array(
      _vd_shift(DATE '2027-09-08', 'VD-S', 0, 24, 36, 4) || '{"driver_id": "x"}'::jsonb)));
    v_out := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    v_out := SQLSTATE;
  END;
  PERFORM _vd_reset();
  PERFORM _vd_expect('save: a refused payload is refused with 22023', '22023', v_out);
  PERFORM _vd_expect('save: …and the draft it would have replaced is still there, untouched', '1|3',
    (SELECT count(*)::text || '|' || max((summary ->> 'shift_count')) FROM vehicle_day_plans
      WHERE id = v_first AND status = 'draft'));

  -- 8d. The refusals, one at a time, each by its own text.
  FOR v_rec IN
    SELECT * FROM (VALUES
      ('a payload that is not an object',        '[]'::jsonb,                                  'ERR 22023 vehicle_day_plan_save: p_payload must be a JSON object'),
      ('a payload without a month',              '{"year": 2027, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v"}'::jsonb,
                                                                                               'ERR 22023 vehicle_day_plan_save: year, month, operating_day_start_hour, slot_minutes and algorithm_version are required'),
      ('a year that is not a number',            '{"year": "abcd", "month": 1, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v"}'::jsonb,
                                                                                               'ERR 22023 vehicle_day_plan_save: year, month, operating_day_start_hour, slot_minutes and algorithm_version are required'),
      ('an hour with three digits',              '{"year": 2027, "month": 1, "operating_day_start_hour": 100, "slot_minutes": 15, "algorithm_version": "v"}'::jsonb,
                                                                                               'ERR 22023 vehicle_day_plan_save: year, month, operating_day_start_hour, slot_minutes and algorithm_version are required'),
      ('no algorithm version',                   '{"year": 2027, "month": 1, "operating_day_start_hour": 4, "slot_minutes": 15}'::jsonb,
                                                                                               'ERR 22023 vehicle_day_plan_save: year, month, operating_day_start_hour, slot_minutes and algorithm_version are required'),
      ('shifts that are not an array',           '{"year": 2027, "month": 1, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v", "shifts": {}}'::jsonb,
                                                                                               'ERR 22023 vehicle_day_plan_save: shifts must be a JSON array'),
      ('a summary that is an array',             '{"year": 2027, "month": 1, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v", "summary": []}'::jsonb,
                                                                                               'ERR 22023 vehicle_day_plan_save: summary must be a JSON object'),
      ('a summary that is null',                 '{"year": 2027, "month": 1, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v", "summary": null}'::jsonb,
                                                                                               'ERR 22023 vehicle_day_plan_save: summary must be a JSON object'),
      ('a shift that is not an object',          '{"year": 2027, "month": 1, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v", "shifts": [1]}'::jsonb,
                                                                                               'ERR 22023 cannot call jsonb_object_keys on a scalar'),
      ('month 13',                               '{"year": 2027, "month": 13, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v", "shifts": []}'::jsonb,
                                                                                               'ERR 23514 new row for relation "vehicle_day_plans" violates check constraint "vehicle_day_plans_month_check"'),
      ('year 1999',                              '{"year": 1999, "month": 1, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v", "shifts": []}'::jsonb,
                                                                                               'ERR 23514 new row for relation "vehicle_day_plans" violates check constraint "vehicle_day_plans_year_check"'),
      ('hour 24',                                '{"year": 2027, "month": 1, "operating_day_start_hour": 24, "slot_minutes": 15, "algorithm_version": "v", "shifts": []}'::jsonb,
                                                                                               'ERR 23514 new row for relation "vehicle_day_plans" violates check constraint "vehicle_day_plans_start_hour_valid"'),
      ('a slot of 20 minutes',                   '{"year": 2027, "month": 1, "operating_day_start_hour": 4, "slot_minutes": 20, "algorithm_version": "v", "shifts": []}'::jsonb,
                                                                                               'ERR 23514 new row for relation "vehicle_day_plans" violates check constraint "vehicle_day_plans_slot_minutes_supported"')
    ) AS t(what, payload, expected)
  LOOP
    PERFORM _vd_expect('save: ' || v_rec.what, v_rec.expected,
      _vd_try(c_admin, NULL, format('SELECT public.vehicle_day_plan_save(%L::jsonb)::text', v_rec.payload::text)));
  END LOOP;
  PERFORM _vd_expect('save: NULL is not an object either', 'ERR 22023 vehicle_day_plan_save: p_payload must be a JSON object',
    _vd_try(c_admin, NULL, 'SELECT public.vehicle_day_plan_save(NULL)::text'));
  v_big := '{"year": 2027, "month": 1, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v", "shifts": [], "summary": {"x": "'
           || repeat('a', 17000) || '"}}';
  PERFORM _vd_expect('save: a summary of 17,000 bytes is not a place to keep a document',
    'ERR 23514 new row for relation "vehicle_day_plans" violates check constraint "vehicle_day_plans_summary_small"',
    _vd_try(c_admin, NULL, format('SELECT public.vehicle_day_plan_save(%L::jsonb)::text', v_big)));

  -- 8e. One shift at a time. Thursday 2027-09-02 is day type 3; Wednesday 2027-09-01 is 2.
  FOR v_rec IN
    SELECT * FROM (VALUES
      ('a vehicle with a leading space',
         _vd_shift(DATE '2027-09-02', ' VD-S', 0, 24, 36, 4),
         'ERR 23514 new row for relation "vehicle_day_shifts" violates check constraint "vehicle_day_shifts_vehicle_named"'),
      ('an empty vehicle',
         _vd_shift(DATE '2027-09-02', '', 0, 24, 36, 4),
         'ERR 23514 new row for relation "vehicle_day_shifts" violates check constraint "vehicle_day_shifts_vehicle_named"'),
      ('a fifth shift of one vehicle on one day',
         _vd_shift(DATE '2027-09-02', 'VD-S', 4, 24, 36, 4),
         'ERR 23514 new row for relation "vehicle_day_shifts" violates check constraint "vehicle_day_shifts_index_valid"'),
      ('a day type that does not match the date',
         _vd_shift(DATE '2027-09-02', 'VD-S', 0, 24, 36, 4) || '{"day_type": 2}'::jsonb,
         'ERR 23514 new row for relation "vehicle_day_shifts" violates check constraint "vehicle_day_shifts_day_type_matches_date"'),
      ('a holiday that is not read as a Sunday',
         _vd_shift(DATE '2027-09-02', 'VD-S', 0, 24, 36, 4) || '{"is_holiday": true}'::jsonb,
         'ERR 23514 new row for relation "vehicle_day_shifts" violates check constraint "vehicle_day_shifts_day_type_matches_date"'),
      ('a holiday on a Thursday, read as the Sunday it is',
         _vd_shift(DATE '2027-09-02', 'VD-S', 0, 24, 36, 4) || '{"is_holiday": true, "day_type": 6}'::jsonb,
         'true'),
      ('a negative estimate',
         _vd_shift(DATE '2027-09-02', 'VD-S', 0, 24, 36, 4) || '{"expected_revenue_cents": -1}'::jsonb,
         'ERR 23514 new row for relation "vehicle_day_shifts" violates check constraint "vehicle_day_shifts_revenue_not_negative"'),
      ('a confidence the engine does not use',
         _vd_shift(DATE '2027-09-02', 'VD-S', 0, 24, 36, 4) || '{"confidence": "certain"}'::jsonb,
         'ERR 23514 new row for relation "vehicle_day_shifts" violates check constraint "vehicle_day_shifts_confidence_known"'),
      ('negative evidence',
         _vd_shift(DATE '2027-09-02', 'VD-S', 0, 24, 36, 4) || '{"evidence_days": -1}'::jsonb,
         'ERR 23514 new row for relation "vehicle_day_shifts" violates check constraint "vehicle_day_shifts_evidence_not_negative"'),
      ('a shift of no length',
         _vd_shift(DATE '2027-09-02', 'VD-S', 0, 24, 36, 4)
           || '{"end_position": 24, "ends_local": "2027-09-02T10:00", "minutes": 0}'::jsonb,
         'ERR 23514 new row for relation "vehicle_day_shifts" violates check constraint "vehicle_day_shifts_minutes_positive"'),
      ('a start position below zero',
         _vd_shift(DATE '2027-09-02', 'VD-S', 0, -1, 4, 4),
         'ERR 23514 new row for relation "vehicle_day_shifts" violates check constraint "vehicle_day_shifts_positions_ordered"')
    ) AS t(what, shift, expected)
  LOOP
    PERFORM _vd_expect('save: ' || v_rec.what, v_rec.expected,
      _vd_try(c_admin, NULL, format('SELECT (public.vehicle_day_plan_save(%L::jsonb) ->> ''success'')',
                                    _vd_payload(2027, 9, 4, 15, jsonb_build_array(v_rec.shift))::text)));
  END LOOP;
  PERFORM _vd_expect('save: two shifts with one (date, vehicle, index) are refused by the key',
    'ERR 23505 duplicate key value violates unique constraint "vehicle_day_shifts_one_per_slot"',
    _vd_try(c_admin, NULL, format('SELECT (public.vehicle_day_plan_save(%L::jsonb) ->> ''success'')',
      _vd_payload(2027, 9, 4, 15, jsonb_build_array(
        _vd_shift(DATE '2027-09-02', 'VD-S', 0, 24, 36, 4), _vd_shift(DATE '2027-09-02', 'VD-S', 0, 40, 48, 4)))::text)));
END $$;


-- ─── 9. company and account state ───────────────────────────────────────────

DO $$
DECLARE
  c_susp  CONSTANT uuid := _vd_id('user:admin-suspended');
  c_super CONSTANT uuid := '50000000-0000-4000-8000-000000000001';
  c_payload CONSTANT text := '{"year": 2031, "month": 9, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v", "shifts": []}';
  v_who   record;
BEGIN
  PERFORM _vd_expect('state: a suspended company''s administrator reads no plan', '0',
    _vd_try(c_susp, NULL, 'SELECT count(*)::text FROM vehicle_day_plans'));
  PERFORM _vd_expect('state: …and no shift', '0',
    _vd_try(c_susp, NULL, 'SELECT count(*)::text FROM vehicle_day_shifts'));
  PERFORM _vd_expect('state: …and a direct insert is refused by the policy', 'ERR 42501 new row violates row-level security policy for table "vehicle_day_plans"',
    _vd_try(c_susp, NULL, format(
      'INSERT INTO vehicle_day_plans (company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version) VALUES (%L, 2031, 2, 4, 15, ''v'')',
      _vd_id('company:suspended'))));
  PERFORM _vd_expect('state: …and vehicle_day_plan_save is refused by the state gate, which is not the role gate', 'ERR 42501 no_company',
    _vd_try(c_susp, NULL, format('SELECT public.vehicle_day_plan_save(%L::jsonb)::text', c_payload)));
  PERFORM _vd_expect('state: …and so is vehicle_day_plan_confirm, for a plan that exists', 'ERR 42501 no_company',
    _vd_try(c_susp, NULL, format('SELECT public.vehicle_day_plan_confirm(%L)::text', _vd_id('plan:susp-draft'))));

  -- A platform owner with no context has no company, so the state gate answers.
  PERFORM _vd_expect('state: a platform owner with no context is refused by the state gate on save', 'ERR 42501 no_company',
    _vd_try(c_super, NULL, format('SELECT public.vehicle_day_plan_save(%L::jsonb)::text', c_payload)));
  PERFORM _vd_expect('state: …and on confirm', 'ERR 42501 no_company',
    _vd_try(c_super, NULL, format('SELECT public.vehicle_day_plan_confirm(%L)::text', _vd_id('plan:a-draft'))));

  -- anon holds no privilege at all, so it never reaches a policy or a function body.
  PERFORM _vd_expect('state: anon cannot read the plans', 'ERR 42501 permission denied for table vehicle_day_plans',
    _vd_try(NULL, NULL, 'SELECT count(*)::text FROM vehicle_day_plans'));
  PERFORM _vd_expect('state: anon cannot read the shifts', 'ERR 42501 permission denied for table vehicle_day_shifts',
    _vd_try(NULL, NULL, 'SELECT count(*)::text FROM vehicle_day_shifts'));
  PERFORM _vd_expect('state: anon cannot call vehicle_day_plan_save', 'ERR 42501 permission denied for function vehicle_day_plan_save',
    _vd_try(NULL, NULL, format('SELECT public.vehicle_day_plan_save(%L::jsonb)::text', c_payload)));
  PERFORM _vd_expect('state: anon cannot call vehicle_day_plan_confirm', 'ERR 42501 permission denied for function vehicle_day_plan_confirm',
    _vd_try(NULL, NULL, format('SELECT public.vehicle_day_plan_confirm(%L)::text', _vd_id('plan:a-draft'))));

  -- The authenticated role with no subject at all: the function's first gate.
  PERFORM _vd_expect('state: a token with no subject is refused as unauthenticated, before the company is asked', 'ERR 42501 unauthenticated',
    _vd_try(_vd_nobody(), NULL, format('SELECT public.vehicle_day_plan_save(%L::jsonb)::text', c_payload)));
  PERFORM _vd_expect('state: …on confirm too', 'ERR 42501 unauthenticated',
    _vd_try(_vd_nobody(), NULL, format('SELECT public.vehicle_day_plan_confirm(%L)::text', _vd_id('plan:a-draft'))));
END $$;

-- ─── 10. platform contexts ──────────────────────────────────────────────────
--
-- A platform owner reads a company's rows only through an open context, and
-- writes them only inside a support session (3.4a). The view context is left
-- open: section 12's last control needs it.

DO $$
DECLARE
  c_view    CONSTANT uuid := _vd_id('user:owner-view');
  c_support CONSTANT uuid := _vd_id('user:owner-support');
  c_s_view  CONSTANT uuid := _vd_id('session:owner-view');
  c_s_supp  CONSTANT uuid := _vd_id('session:owner-support');
  c_co_a    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_co_b    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000b';
  c_payload CONSTANT text := '{"year": 2031, "month": 10, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v", "shifts": []}';
  v_open    jsonb;
  v_res     jsonb;
  v_mark    bigint;
  v_after   jsonb;
  v_plan    uuid;
BEGIN
  PERFORM _vd_as(c_view, c_s_view);
  v_open := public.platform_context_open(c_co_a, 'view');
  PERFORM _vd_reset();
  PERFORM _vd_expect('contexts: the view context opened', 'true', v_open ->> 'success');

  PERFORM _vd_expect('contexts: a view context reads the company it opened', 'true',
    _vd_try(c_view, c_s_view, format('SELECT (count(*) > 0)::text FROM vehicle_day_plans WHERE company_id = %L', c_co_a)));
  PERFORM _vd_expect('contexts: …and its shifts', 'true',
    _vd_try(c_view, c_s_view, format('SELECT (count(*) > 0)::text FROM vehicle_day_shifts WHERE company_id = %L', c_co_a)));
  PERFORM _vd_expect('contexts: …and no other company''s', '0',
    _vd_try(c_view, c_s_view, format('SELECT count(*)::text FROM vehicle_day_plans WHERE company_id = %L', c_co_b)));
  PERFORM _vd_expect('contexts: a view context writes nothing, and says why (3.4a)', 'ERR P0001 support_session_required',
    _vd_try(c_view, c_s_view, format(
      'INSERT INTO vehicle_day_plans (company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version) VALUES (%L, 2031, 3, 4, 15, ''v'')', c_co_a)));
  PERFORM _vd_expect('contexts: …not even an update that would touch no row', 'ERR P0001 support_session_required',
    _vd_try(c_view, c_s_view, format('UPDATE vehicle_day_plans SET summary = summary WHERE id = %L', _vd_id('plan:a-draft'))));
  PERFORM _vd_expect('contexts: a view context is refused by the save RPC''s role gate', 'ERR 42501 not_authorized',
    _vd_try(c_view, c_s_view, format('SELECT public.vehicle_day_plan_save(%L::jsonb)::text', c_payload)));
  PERFORM _vd_expect('contexts: …and by the confirm RPC''s', 'ERR 42501 not_authorized',
    _vd_try(c_view, c_s_view, format('SELECT public.vehicle_day_plan_confirm(%L)::text', _vd_id('plan:a-draft'))));

  -- The support session: it writes the company it opened, through the RPC as the
  -- company's own administrator would, and every row it writes leaves one audit row.
  PERFORM _vd_as(c_support, c_s_supp);
  v_open := public.platform_context_open(c_co_a, 'support', 'Ticket Fahrzeug-Tagesplan');
  PERFORM _vd_reset();
  PERFORM _vd_expect('contexts: the support session opened', 'true', v_open ->> 'success');

  v_mark := _vd_mark();
  PERFORM _vd_as(c_support, c_s_supp);
  v_res := public.vehicle_day_plan_save(_vd_payload(2027, 11, 4, 15, jsonb_build_array(
    _vd_shift(DATE '2027-11-02', 'VD-SUP-1', 0, 24, 36, 4, 15, 12345),
    _vd_shift(DATE '2027-11-02', 'VD-SUP-2', 0, 24, 36, 4, 15, 12345))));
  PERFORM _vd_reset();
  v_plan := (v_res ->> 'plan_id')::uuid;
  PERFORM _vd_expect('contexts: a support session saves a plan for the company it opened', 'true|2',
    (v_res ->> 'success') || '|' || (v_res ->> 'shift_count'));
  PERFORM _vd_expect('contexts: each row it wrote left exactly one audit row (3.4c): one plan, two shifts', '1|2|0',
    _vd_rows(v_mark, 'support_write.vehicle_day_plans.insert')::text || '|'
    || _vd_rows(v_mark, 'support_write.vehicle_day_shifts.insert')::text || '|'
    || _vd_rows(v_mark, 'support_write.vehicle_day_plans.delete')::text);
  SELECT l.after_value INTO v_after
    FROM app_private.platform_audit_log l
   WHERE l.id > v_mark AND l.action = 'support_write.vehicle_day_shifts.insert'
   ORDER BY l.id LIMIT 1;
  PERFORM _vd_expect('contexts: the audit row names the reason and keeps the window, which is no pay figure',
    'Ticket Fahrzeug-Tagesplan|VD-SUP-1|12345',
    (v_after ->> 'reason') || '|' || (v_after -> 'values' ->> 'vehicle') || '|' || (v_after -> 'values' ->> 'expected_revenue_cents'));

  -- Saving again replaces the draft: the old plan and its two shifts are deleted
  -- and recorded, the new ones inserted and recorded.
  v_mark := _vd_mark();
  PERFORM _vd_as(c_support, c_s_supp);
  v_res := public.vehicle_day_plan_save(_vd_payload(2027, 11, 4, 15, jsonb_build_array(
    _vd_shift(DATE '2027-11-02', 'VD-SUP-1', 0, 24, 36, 4, 15, 12345),
    _vd_shift(DATE '2027-11-02', 'VD-SUP-2', 0, 24, 36, 4, 15, 12345))));
  PERFORM _vd_reset();
  v_plan := (v_res ->> 'plan_id')::uuid;
  PERFORM _vd_expect('contexts: replacing a draft is recorded row by row: plan and shifts deleted, new ones inserted', '1|2|1|2',
    _vd_rows(v_mark, 'support_write.vehicle_day_plans.delete')::text || '|'
    || _vd_rows(v_mark, 'support_write.vehicle_day_shifts.delete')::text || '|'
    || _vd_rows(v_mark, 'support_write.vehicle_day_plans.insert')::text || '|'
    || _vd_rows(v_mark, 'support_write.vehicle_day_shifts.insert')::text);

  v_mark := _vd_mark();
  PERFORM _vd_as(c_support, c_s_supp);
  v_res := public.vehicle_day_plan_confirm(v_plan);
  PERFORM _vd_reset();
  PERFORM _vd_expect('contexts: a support session confirms through the RPC, and the status change is recorded once', 'true|1',
    (v_res ->> 'success') || '|' || _vd_rows(v_mark, 'support_write.vehicle_day_plans.update')::text);

  PERFORM _vd_expect('contexts: a support session writes no other company''s plan', 'ERR 42501 new row violates row-level security policy for table "vehicle_day_plans"',
    _vd_try(c_support, c_s_supp, format(
      'INSERT INTO vehicle_day_plans (company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version) VALUES (%L, 2031, 4, 4, 15, ''v'')', c_co_b)));
END $$;

-- ─── 11. a company that holds a confirmed plan can still be deleted ─────────
--
-- 20261016140000 found, by deleting a company that had done real work, that the
-- monthly plan's freeze refused the company's own cascade. The same shape is
-- here, so the same deletion is tried: a company with a superseded plan, the
-- confirmed plan that replaced it (which makes the plan table point at itself)
-- and a draft.

DO $$
DECLARE
  c_x       CONSTANT uuid := _vd_id('company:x');
  c_admin_x CONSTANT uuid := _vd_id('user:admin-x');
  v_res     jsonb;
  v_p1      uuid;
  v_p2      uuid;
  v_probe   text;
BEGIN
  INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
  VALUES (c_x, 'VD delete', 'vd-delete', 'approved', 'active', 'basic', 'active');
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES (c_admin_x, 'vd-admin-x@test.invalid', now());
  INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
  VALUES (c_admin_x, 'vd-admin-x@test.invalid', 'VD admin x', 'admin',
          (SELECT r.id FROM roles r WHERE r.name = 'admin' AND r.company_id IS NULL), c_x, 'active');

  PERFORM _vd_as(c_admin_x);
  v_res := public.vehicle_day_plan_save(_vd_payload(2027, 12, 4, 15, jsonb_build_array(
    _vd_shift(DATE '2027-12-06', 'VD-X', 0, 24, 36, 4), _vd_shift(DATE '2027-12-06', 'VD-Y', 0, 24, 36, 4))));
  v_p1 := (v_res ->> 'plan_id')::uuid;
  PERFORM public.vehicle_day_plan_confirm(v_p1);
  v_res := public.vehicle_day_plan_save(_vd_payload(2027, 12, 4, 15, jsonb_build_array(
    _vd_shift(DATE '2027-12-07', 'VD-X', 0, 24, 36, 4))));
  v_p2 := (v_res ->> 'plan_id')::uuid;
  PERFORM public.vehicle_day_plan_confirm(v_p2, true);
  PERFORM public.vehicle_day_plan_save(_vd_payload(2028, 1, 4, 15, jsonb_build_array(
    _vd_shift(DATE '2028-01-03', 'VD-X', 0, 24, 36, 4))));
  PERFORM _vd_reset();

  PERFORM _vd_expect('deletion: the company now holds a superseded plan, a confirmed plan and a draft, with four shifts',
    'confirmed|draft|superseded|4',
    (SELECT string_agg(status, '|' ORDER BY status) FROM vehicle_day_plans WHERE company_id = c_x)
    || '|' || (SELECT count(*)::text FROM vehicle_day_shifts WHERE company_id = c_x));
  PERFORM _vd_expect('deletion: the superseded plan points at the confirmed one, so the table references itself', 'true',
    (SELECT (replaced_by_plan_id = v_p2)::text FROM vehicle_day_plans WHERE id = v_p1));

  PERFORM _vd_expect('deletion: while the company exists its confirmed plan cannot be deleted', 'ERR P0001 vehicle_day_plan_is_final',
    _vd_try(_vd_owner(), NULL, format('DELETE FROM vehicle_day_plans WHERE id = %L', v_p2)));

  -- The deletion itself, with its effect checked inside the same subtransaction
  -- and rolled back, so the company is still there for section 12.
  v_probe := format($p$DO $q$
    DECLARE n bigint;
    BEGIN
      DELETE FROM companies WHERE id = %L;
      SELECT count(*) INTO n FROM vehicle_day_plans WHERE company_id = %L;
      IF n <> 0 THEN RAISE EXCEPTION 'plans left: %%', n; END IF;
      SELECT count(*) INTO n FROM vehicle_day_shifts WHERE company_id = %L;
      IF n <> 0 THEN RAISE EXCEPTION 'shifts left: %%', n; END IF;
    END $q$
  $p$, c_x, c_x, c_x);
  PERFORM _vd_expect('deletion: deleting the company takes all three plans and all four shifts with it', 'rows 0',
    _vd_try(_vd_owner(), NULL, v_probe));
END $$;

-- ─── 12. mutation controls ──────────────────────────────────────────────────
--
-- A probe that cannot fail measures nothing. Each control below breaks ONE rule
-- inside a subtransaction, runs the same probe that asserted the rule above, and
-- requires its answer to change. The subtransaction is rolled back, so the rule
-- is whole again for the next control. Every line prints "before => after".
-- A mutation that would change nothing raises (see _vd_mutate_fn), so a control
-- cannot pass for want of a mutation.

DO $$
DECLARE
  c_admin   CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_admin_b CONSTANT uuid := 'b0000000-0000-4000-8000-000000000001';
  c_view    CONSTANT uuid := 'a0000000-0000-4000-8000-000000000003';
  c_view_p  CONSTANT uuid := _vd_id('user:owner-view');
  c_s_view  CONSTANT uuid := _vd_id('session:owner-view');
  c_co_a    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_co_b    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000b';
  c_x       CONSTANT uuid := _vd_id('company:x');
  v_head    text := '"year": 2027, "month": 4, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v"';
  v_shift   text := '"operating_date": "2027-04-01", "vehicle": "VD-X", "shift_index": 0, "day_type": 3, "is_holiday": false, "expected_revenue_cents": 100, "expected_revenue_per_hour_cents": 33, "confidence": "high", "evidence_days": 3, "start_position": 24, "end_position": 36, "minutes": 180';
  v_probe   text;
  v_mut     text;
  v_before  text;
  v_after   text;
  v_hour_plan uuid := (SELECT id FROM vehicle_day_plans WHERE company_id = 'c0000000-0000-4000-8000-00000000000a' AND year = 2027 AND month = 2);
BEGIN
  -- M1. The role gate leaves the plan INSERT policy.
  v_probe := format('INSERT INTO vehicle_day_plans (company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version) VALUES (%L, 2031, 8, 4, 15, ''v'')', c_co_a);
  v_before := _vd_try(c_view, NULL, v_probe);
  v_after  := _vd_mutant('ALTER POLICY vehicle_day_plans_insert ON public.vehicle_day_plans WITH CHECK (company_id = (SELECT public.get_active_company_id()))', c_view, NULL, v_probe);
  PERFORM _vd_expect('mutation M1: without the role gate in the INSERT policy the viewer''s insert is admitted',
    'ERR 42501 new row violates row-level security policy for table "vehicle_day_plans" => rows 1', v_before || ' => ' || v_after);

  -- M2. The tenant term leaves the UPDATE policy's WITH CHECK (the guard is off in both runs).
  v_probe := _vd_move_sql('vehicle_day_plans', _vd_id('plan:a-draft'), format('company_id = %L', c_co_b));
  v_before := _vd_mutant('ALTER TABLE vehicle_day_plans DISABLE TRIGGER vehicle_day_plan_guard', c_admin, NULL, v_probe);
  v_after  := _vd_mutant('DO $m$ BEGIN ALTER TABLE vehicle_day_plans DISABLE TRIGGER vehicle_day_plan_guard; '
                         'ALTER POLICY vehicle_day_plans_update ON public.vehicle_day_plans WITH CHECK ((SELECT public.current_role_permits(''documents'', true))); END $m$',
                         c_admin, NULL, v_probe);
  PERFORM _vd_expect('mutation M2: without the tenant term in WITH CHECK a plan can be moved to another company',
    'ERR 42501 new row violates row-level security policy for table "vehicle_day_plans" => rows 0', v_before || ' => ' || v_after);

  -- M3. The partial unique index is dropped.
  v_probe := format($p$DO $q$ BEGIN
      PERFORM set_config('app_private.vehicle_day_plan_transition', 'plan:%s:' || pg_current_xact_id()::text, true);
      UPDATE vehicle_day_plans SET status = 'confirmed' WHERE id = %L;
    END $q$
  $p$, _vd_id('plan:a-2'), _vd_id('plan:a-2'));
  v_before := _vd_try(c_admin, NULL, v_probe);
  v_after  := _vd_mutant('DROP INDEX public.vehicle_day_plans_one_confirmed_per_month', c_admin, NULL, v_probe);
  PERFORM _vd_expect('mutation M3: without the index a month gets a second confirmed plan',
    'ERR 23505 duplicate key value violates unique constraint "vehicle_day_plans_one_confirmed_per_month" => rows 0', v_before || ' => ' || v_after);

  -- M4. The save RPC stops asking the role gate.
  v_probe := 'SELECT (public.vehicle_day_plan_save(''{"year": 2031, "month": 11, "operating_day_start_hour": 4, "slot_minutes": 15, "algorithm_version": "v", "shifts": []}''::jsonb) ->> ''success'')';
  v_before := _vd_try(c_view, NULL, v_probe);
  v_after  := _vd_mutant($m$SELECT _vd_mutate_fn('public.vehicle_day_plan_save(jsonb)', 'IF NOT public.current_role_permits(''documents'', true) THEN', 'IF false THEN')$m$, c_view, NULL, v_probe);
  PERFORM _vd_expect('mutation M4: without the role gate in the function the viewer saves a plan',
    'ERR 42501 not_authorized => true', v_before || ' => ' || v_after);

  -- M5. The shift guard stops checking the moments against the stored hour.
  v_probe := format('SELECT (public.vehicle_day_plan_save(%L::jsonb) ->> ''success'')',
    '{' || v_head || ', "shifts": [{' || v_shift || ', "starts_local": "2027-04-01T06:00", "ends_local": "2027-04-01T09:00"}]}');
  v_before := _vd_try(c_admin, NULL, v_probe);
  -- Both halves of the OR are neutralised: `false AND a OR b` would leave b live, and the
  -- control would then pass for the wrong reason (the first version of this line did).
  v_after  := _vd_mutant($m$DO $mm$ BEGIN
      PERFORM _vd_mutate_fn('app_private.vehicle_day_shift_guard()', 'IF NEW.starts_local IS DISTINCT FROM', 'IF false AND NEW.starts_local IS DISTINCT FROM');
      PERFORM _vd_mutate_fn('app_private.vehicle_day_shift_guard()', 'OR NEW.ends_local IS DISTINCT FROM', 'OR false AND NEW.ends_local IS DISTINCT FROM');
    END $mm$
    $m$, c_admin, NULL, v_probe);
  PERFORM _vd_expect('mutation M5: without the moment check a shift cut by hour 0 is stored under a plan that says hour 4',
    'ERR P0001 vehicle_day_shift_moments_mismatch => true', v_before || ' => ' || v_after);

  -- M6. The plan guard stops fixing the hour.
  v_probe := format('UPDATE vehicle_day_plans SET operating_day_start_hour = 0 WHERE id = %L', v_hour_plan);
  v_before := _vd_try(c_admin, NULL, v_probe);
  v_after  := _vd_mutant($m$SELECT _vd_mutate_fn('app_private.vehicle_day_plan_guard()', 'OR NEW.operating_day_start_hour IS DISTINCT FROM OLD.operating_day_start_hour', '')$m$, c_admin, NULL, v_probe);
  PERFORM _vd_expect('mutation M6: without the guard''s clause the stored hour of a plan can be edited',
    'ERR P0001 vehicle_day_plan_key_fixed => rows 1', v_before || ' => ' || v_after);

  -- M7. The tenant term leaves the SELECT policy.
  v_probe := format('SELECT (count(*) > 0)::text FROM vehicle_day_plans WHERE company_id = %L', c_co_a);
  v_before := _vd_try(c_admin_b, NULL, v_probe);
  v_after  := _vd_mutant('ALTER POLICY vehicle_day_plans_select ON public.vehicle_day_plans USING (true)', c_admin_b, NULL, v_probe);
  PERFORM _vd_expect('mutation M7: without the tenant term company B reads company A''s plans',
    'false => true', v_before || ' => ' || v_after);

  -- M8. The plan guard stops standing aside for a company's own cascade.
  v_probe := format($p$DO $q$ BEGIN DELETE FROM companies WHERE id = %L; END $q$
  $p$, c_x);
  v_before := _vd_try(_vd_owner(), NULL, v_probe);
  v_after  := _vd_mutant($m$SELECT _vd_mutate_fn('app_private.vehicle_day_plan_guard()', 'AND EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id) THEN', 'THEN')$m$, _vd_owner(), NULL, v_probe);
  PERFORM _vd_expect('mutation M8: without the condition a company holding a confirmed plan cannot be deleted',
    'rows 0 => ERR P0001 vehicle_day_plan_is_final', v_before || ' => ' || v_after);

  -- M9. The shift key list is opened.
  v_probe := format('SELECT (public.vehicle_day_plan_save(%L::jsonb) ->> ''success'')',
    '{' || v_head || ', "shifts": [{' || v_shift || ', "starts_local": "2027-04-01T10:00", "ends_local": "2027-04-01T13:00", "driver_id": "x"}]}');
  v_before := _vd_try(c_admin, NULL, v_probe);
  v_after  := _vd_mutant($m$SELECT _vd_mutate_fn('public.vehicle_day_plan_save(jsonb)', 'WHERE k.key <> ALL (c_shift_keys)', 'WHERE false')$m$, c_admin, NULL, v_probe);
  PERFORM _vd_expect('mutation M9: with the key list opened a shift that names a driver is accepted and the driver silently dropped',
    'ERR 22023 vehicle_day_plan_save: unknown shift key(s): driver_id => true', v_before || ' => ' || v_after);

  -- M10. The view-context refusal trigger is dropped; the policy still refuses, but with a different text.
  v_probe := format('INSERT INTO vehicle_day_plans (company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version) VALUES (%L, 2031, 12, 4, 15, ''v'')', c_co_a);
  v_before := _vd_try(c_view_p, c_s_view, v_probe);
  v_after  := _vd_mutant('DROP TRIGGER refuse_read_only_context_write ON public.vehicle_day_plans', c_view_p, c_s_view, v_probe);
  PERFORM _vd_expect('mutation M10: without the refusal trigger the view context is still refused, but no longer by name',
    'ERR P0001 support_session_required => ERR 42501 new row violates row-level security policy for table "vehicle_day_plans"',
    v_before || ' => ' || v_after);

  -- Every control left the rules whole: the baselines still hold after all ten.
  PERFORM _vd_expect('mutations: the ten controls were rolled back, so the policies and triggers are whole', '4|4|2',
    (SELECT count(*)::text FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vehicle_day_plans') || '|'
    || (SELECT count(*)::text FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vehicle_day_shifts') || '|'
    || (SELECT count(*)::text FROM pg_trigger WHERE tgrelid = 'public.vehicle_day_plans'::regclass
          AND tgname IN ('refuse_read_only_context_write', 'vehicle_day_plan_guard') AND NOT tgisinternal AND tgenabled = 'O'));
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
    FROM _vd_results r;

  RAISE NOTICE 'vehicle day plans: % checks, % passed, % differ', v_ok + v_bad, v_ok, v_bad;

  IF v_bad > 0 THEN
    RAISE EXCEPTION E'vehicle day plans: % check(s) differ from what migration 20261022140000 promises\n%',
      v_bad, v_list;
  END IF;
END $$;

ROLLBACK;
