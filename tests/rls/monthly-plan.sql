/*
  The monthly plan: one active plan per month, and the snapshot of the driver
  values it was made with (migration 20260930100000, requirement sections 9 and
  13).

  Runs after the files before it, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it
  see the database as the seeds left it.

  What is covered, in order:

    1. shape       all four tables carry RLS, exactly the business shape's four
                   policies with slice C's Dokumente page on every write, the
                   view-context refusal and the support-write audit triggers,
                   their own guard, and no privilege for anon or the service
                   role; both RPCs are SECURITY DEFINER, VOLATILE, callable by
                   authenticated alone
    2. section 9   the partial unique index refuses a second confirmed plan for
                   one month *directly*, not only through the RPC; a draft
                   beside a confirmed plan is allowed; the same month of another
                   company is allowed; and the index does not key on the import,
                   which is the legacy defect
    3. section 13  the snapshot is taken by the database from public.drivers and
                   never from the client; a later edit to the driver does not
                   move it; range_problems names an unusable rate and an
                   inverted salary range and the figures are then NULL; another
                   company's driver is refused; the key is fixed;
                   target_monthly_hours is absent
    4. section 14  the two CHECKs live where the plan reads the value and not on
                   public.drivers, NaN included; the same two figures are
                   unconstrained on public.drivers, which is the measurement the
                   migration header rests on
    5. the rule    nothing here can write a trip: no foreign key to
                   fahrtenbuch_trips, and no function of this slice names it
    6. confirm     the RPC refuses an empty plan, an overlap, a short vehicle
                   switch, a driver with no usable range, a driver over the
                   hours cap and a driver who is not in the plan; it answers
                   plan_exists rather than raising, and the replace is one
                   transaction that supersedes and confirms together
    7. freeze      a confirmed plan's header, blocks, rides and snapshot cannot
                   be changed or deleted, and status moves only through the RPC
    8. roles       a viewer and an editor hold no can_edit on the Dokumente
                   page, so both RPCs and every direct write are refused; the
                   administrator writes
    9. tenants     a member reads its own company's rows and never another
                   company's; nobody writes into another company or moves a row
                   there
   10. state       a suspended company's administrator reads and writes nothing,
                   as on every business table
   11. contexts    a view context reads the company it opened and writes
                   nothing; a support session writes and each row leaves exactly
                   one audit row with the pay figures redacted; a platform owner
                   with no context reads and writes none of it

  The matrix lines for the four tables and both RPCs are in tests/rls/matrix.sql.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in trip-analysis-settings.sql) ────────────────────────

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

CREATE OR REPLACE FUNCTION _mp_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _mp_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('mp:' || p_what)::uuid $$;

CREATE OR REPLACE FUNCTION _mp_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/*
  Become a signed-in caller with a password sign-in and, when given, the
  sign-in session a context is answered to — or anon when p_user is NULL.
*/
CREATE OR REPLACE FUNCTION _mp_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _mp_reset();
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

/*
  Run p_sql as that caller in a subtransaction that is always rolled back, and
  return the scalar it answered, `rows N` for a statement without a result, or
  `ERR <sqlstate> <hint or message>`. Nothing it writes survives, audit rows
  included — so a check that wants to count audit rows does its own write at top
  level instead.

  The HINT is preferred over the message because every refusal in this slice
  carries one and a hint is the stable half; the message is German prose.
*/
CREATE OR REPLACE FUNCTION _mp_try(p_user uuid, p_session uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
  v_hint  text;
BEGIN
  BEGIN
    PERFORM _mp_as(p_user, p_session);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ021', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ021' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_hint = PG_EXCEPTION_HINT;
      v_out := 'ERR ' || v_state || ' ' || coalesce(nullif(v_hint, ''), v_msg);
  END;
  PERFORM _mp_reset();
  RETURN v_out;
END $$;

/** The audit log's high-water mark, so each check counts only its own rows. */
CREATE OR REPLACE FUNCTION _mp_mark() RETURNS bigint
LANGUAGE sql AS $$ SELECT coalesce(max(l.id), 0) FROM app_private.platform_audit_log l $$;

/** Support-write rows after a mark, for one action or for all of them. */
CREATE OR REPLACE FUNCTION _mp_rows(p_since bigint, p_action text DEFAULT NULL) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*)
    FROM app_private.platform_audit_log l
   WHERE l.id > p_since
     AND l.action ~ '^support_write\.'
     AND (p_action IS NULL OR l.action = p_action)
$$;

-- ─── principals and data ────────────────────────────────────────────────────
--
-- seed.sql's two companies and their people (admin-a, editor-a, viewer-a,
-- admin-b, and `super`, a platform owner with no sign-in session and so no
-- context), plus a suspended company with an administrator, and two
-- company-less platform owners with a session each: one opens a view context on
-- company A, the other a support session.

CREATE TEMP TABLE _mp_who (who text PRIMARY KEY, uid uuid NOT NULL);
INSERT INTO _mp_who VALUES
  ('admin-a',  'a0000000-0000-4000-8000-000000000001'),
  ('editor-a', 'a0000000-0000-4000-8000-000000000002'),
  ('viewer-a', 'a0000000-0000-4000-8000-000000000003'),
  ('admin-b',  'b0000000-0000-4000-8000-000000000001'),
  ('super',    '50000000-0000-4000-8000-000000000001');

CREATE OR REPLACE FUNCTION _mp_u(p_who text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT coalesce((SELECT w.uid FROM _mp_who w WHERE w.who = p_who), _mp_id('user:' || p_who)) $$;

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
VALUES (_mp_id('company:suspended'), 'MP suspended', 'mp-suspended', 'approved', 'suspended', 'basic', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT _mp_id('user:' || v.who), 'mp-' || v.who || '@test.invalid', now()
FROM (VALUES ('admin-suspended'), ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
SELECT _mp_id('user:' || v.who), 'mp-' || v.who || '@test.invalid', 'MP ' || v.who, v.role,
       (SELECT r.id FROM roles r WHERE r.name = v.role AND r.company_id IS NULL),
       v.company_id, 'active'
FROM (VALUES
  ('admin-suspended', 'admin',  _mp_id('company:suspended')),
  ('owner-view',      'viewer', NULL::uuid),
  ('owner-support',   'viewer', NULL::uuid)
) AS v(who, role, company_id)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES (_mp_id('user:owner-view'),    'owner', 'mp'),
       (_mp_id('user:owner-support'), 'owner', 'mp')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
SELECT _mp_id('session:' || v.who), _mp_id('user:' || v.who)
FROM (VALUES ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

/*
  Drivers of company A, with the requirement's own worked figures:

    ok     1950 to 2100 € at 14 €/h — section 5's example, so the cap is
           2100 / 14 = 150 h exactly and the floor 1950 / 14 = 139.2857… h
    zero   an hourly rate of 0, which DriverModal's `min="0"` accepts today and
           which section 5 calls a configuration error
    inv    a minimum salary above the maximum (section 14)
    owner  employment_type = 'company_owner', with no ceiling (section 8)
*/
INSERT INTO drivers (id, company_id, name, employment_type, planning_min_salary,
                     planning_max_salary, planning_hourly_rate, max_monthly_hours,
                     planning_priority, planning_enabled, can_cover_other_drivers)
VALUES
  (_mp_id('driver:ok'),    'c0000000-0000-4000-8000-00000000000a', 'MP Ok',    'employee',      1950, 2100, 14,   NULL, 100, true,  true),
  (_mp_id('driver:zero'),  'c0000000-0000-4000-8000-00000000000a', 'MP Zero',  'employee',      1000, 1500, 0,    NULL, 100, true,  true),
  (_mp_id('driver:inv'),   'c0000000-0000-4000-8000-00000000000a', 'MP Inv',   'employee',      2000, 1000, 14,   NULL, 100, true,  true),
  (_mp_id('driver:owner'), 'c0000000-0000-4000-8000-00000000000a', 'MP Owner', 'company_owner', 1000, 2000, 14,   NULL, 100, true,  true),
  (_mp_id('driver:b'),     'c0000000-0000-4000-8000-00000000000b', 'MP B',     'employee',      1950, 2100, 14,   NULL, 100, true,  true),
  (_mp_id('driver:susp'),  _mp_id('company:suspended'),            'MP Susp',  'employee',      NULL, NULL, NULL, NULL, 100, true,  true)
ON CONFLICT (id) DO NOTHING;

-- One draft plan per company plus a confirmed one in A, written as the owner of
-- the tables (RLS does not apply; the triggers do). The confirmed plan is made
-- through the RPC's own path further down; here it is stamped directly, which
-- the guard permits only with the marker — so this seed uses the marker too,
-- which is itself a check that the marker is what the guard reads.
INSERT INTO monthly_plans (id, company_id, year, month, switch_minutes)
VALUES
  (_mp_id('plan:a-draft'),     'c0000000-0000-4000-8000-00000000000a', 2026, 10, 30),
  (_mp_id('plan:b-draft'),     'c0000000-0000-4000-8000-00000000000b', 2026, 10, 30),
  (_mp_id('plan:susp-draft'),  _mp_id('company:suspended'),            2026, 10, 30);

INSERT INTO monthly_plan_drivers (id, company_id, plan_id, driver_id, driver_name, selected, is_owner)
VALUES
  (_mp_id('pd:a-ok'),    'c0000000-0000-4000-8000-00000000000a', _mp_id('plan:a-draft'), _mp_id('driver:ok'),    NULL, true, false),
  (_mp_id('pd:a-owner'), 'c0000000-0000-4000-8000-00000000000a', _mp_id('plan:a-draft'), _mp_id('driver:owner'), NULL, true, false),
  (_mp_id('pd:b'),       'c0000000-0000-4000-8000-00000000000b', _mp_id('plan:b-draft'), _mp_id('driver:b'),     NULL, true, false),
  (_mp_id('pd:susp'),    _mp_id('company:suspended'),            _mp_id('plan:susp-draft'), _mp_id('driver:susp'), NULL, true, false);

INSERT INTO monthly_plan_blocks (id, company_id, plan_id, block_key, car_id, car_identifier,
                                 starts_at, ends_at, span_minutes, ride_minutes,
                                 driver_id, driver_name, assignment_reason)
VALUES
  -- Section 16's figure: 08:23 to 09:44 is 81 minutes, which is 1,35 hours.
  (_mp_id('blk:a-1'), 'c0000000-0000-4000-8000-00000000000a', _mp_id('plan:a-draft'), 'car-1@2026-10-01T08:23',
   NULL, 'MP-CAR-1', '2026-10-01 08:23+02', '2026-10-01 09:44+02', 81, 81,
   _mp_id('driver:ok'), NULL, 'best_fit'),
  (_mp_id('blk:b-1'), 'c0000000-0000-4000-8000-00000000000b', _mp_id('plan:b-draft'), 'car-b@2026-10-01T08:00',
   NULL, 'MP-CAR-B', '2026-10-01 08:00+02', '2026-10-01 09:00+02', 60, 60,
   _mp_id('driver:b'), NULL, 'best_fit');

INSERT INTO monthly_plan_block_trips (id, company_id, plan_id, block_id, trip_id,
                                      starts_at, ends_at, minutes, time_source)
VALUES
  (_mp_id('bt:a-1'), 'c0000000-0000-4000-8000-00000000000a', _mp_id('plan:a-draft'), _mp_id('blk:a-1'),
   _mp_id('trip:a-1'), '2026-10-01 08:23+02', '2026-10-01 09:44+02', 81, 'instants'),
  (_mp_id('bt:b-1'), 'c0000000-0000-4000-8000-00000000000b', _mp_id('plan:b-draft'), _mp_id('blk:b-1'),
   _mp_id('trip:b-1'), '2026-10-01 08:00+02', '2026-10-01 09:00+02', 60, 'instants');

-- ─── 1. shape ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tbl   text;
  v_role  text;
  v_sig   text;
  v_wrong text;
  c_tables CONSTANT text[] := ARRAY['monthly_plans', 'monthly_plan_drivers',
                                    'monthly_plan_blocks', 'monthly_plan_block_trips'];
BEGIN
  FOREACH v_tbl IN ARRAY c_tables LOOP
    PERFORM _mp_ok(format('shape: %s has row level security on', v_tbl),
      (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', v_tbl)::regclass));

    PERFORM _mp_ok(format('shape: %s carries exactly the four policies, for authenticated', v_tbl),
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
    PERFORM _mp_ok(format('shape: every %s policy asks get_active_company_id() and nothing else [%s]',
                          v_tbl, coalesce(v_wrong, 'none')), v_wrong IS NULL);

    -- Slice C: the planning tables' page is `documents`, and SELECT carries no
    -- role term at all — 3.3's shape has none and this slice invented none.
    SELECT string_agg(p.policyname::text, ', ') INTO v_wrong
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd <> 'SELECT'
       AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'current_role_permits';
    PERFORM _mp_ok(format('shape: every %s write policy asks the Dokumente page [%s]',
                          v_tbl, coalesce(v_wrong, 'none')), v_wrong IS NULL);
    PERFORM _mp_ok(format('shape: the %s SELECT policy has no role term', v_tbl),
      (SELECT p.qual !~ 'current_role_permits' FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd = 'SELECT'));

    PERFORM _mp_ok(format('shape: the %s UPDATE policy states one predicate as USING and as WITH CHECK', v_tbl),
      (SELECT p.qual = p.with_check FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd = 'UPDATE'));

    PERFORM _mp_ok(format('shape: %s carries the view-context refusal, per statement', v_tbl),
      EXISTS (SELECT 1 FROM pg_trigger g
               WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                 AND g.tgname = 'refuse_read_only_context_write'
                 AND NOT g.tgisinternal AND g.tgtype = 30 AND g.tgenabled = 'O'));
    PERFORM _mp_ok(format('shape: %s carries the support-write audit, per row and gated on the flag', v_tbl),
      EXISTS (SELECT 1 FROM pg_trigger g
               WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                 AND g.tgname = 'record_support_write'
                 AND NOT g.tgisinternal AND g.tgtype = 29 AND g.tgenabled = 'O'
                 AND pg_get_triggerdef(g.oid) ~ 'app_private\.support_write_context'));
    PERFORM _mp_ok(format('shape: %s carries its guard, BEFORE INSERT OR UPDATE OR DELETE per row', v_tbl),
      EXISTS (SELECT 1 FROM pg_trigger g
               WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                 AND g.tgname IN ('monthly_plan_guard', 'monthly_plan_driver_guard',
                                  'monthly_plan_child_guard')
                 AND NOT g.tgisinternal AND g.tgtype = 31 AND g.tgenabled = 'O'));

    FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
      PERFORM _mp_ok(format('privileges: %s holds nothing on %s', v_role, v_tbl),
        NOT has_table_privilege(v_role, format('public.%I', v_tbl),
                                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
    END LOOP;
    PERFORM _mp_ok(format('privileges: authenticated holds SELECT, INSERT, UPDATE and DELETE on %s and nothing else', v_tbl),
      has_table_privilege('authenticated', format('public.%I', v_tbl), 'SELECT')
      AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'INSERT')
      AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'UPDATE')
      AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'DELETE')
      AND NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'TRUNCATE,REFERENCES,TRIGGER'));
  END LOOP;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM _mp_ok(format('privileges: %s cannot reach app_private', v_role),
      NOT has_schema_privilege(v_role, 'app_private', 'USAGE'));
  END LOOP;

  -- The four guards: SECURITY DEFINER, a pinned search_path, executable by no
  -- API role. A SECURITY INVOKER function here would be 42501 for every company
  -- administrator, which is PR #117's defect.
  FOREACH v_sig IN ARRAY ARRAY['app_private.monthly_plan_guard()',
                               'app_private.monthly_plan_driver_guard()',
                               'app_private.monthly_plan_child_guard()',
                               'app_private.monthly_plan_parent_is_open(uuid,uuid)'] LOOP
    PERFORM _mp_ok(format('shape: %s is SECURITY DEFINER with a pinned search_path', v_sig),
      to_regprocedure(v_sig) IS NOT NULL
      AND (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig))
      AND EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                   WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=%'));
    PERFORM _mp_ok(format('privileges: no API role can execute %s', v_sig),
      NOT has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
      AND NOT has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE')
      AND NOT has_function_privilege('service_role', to_regprocedure(v_sig), 'EXECUTE'));
  END LOOP;

  -- Both RPCs: SECURITY DEFINER and VOLATILE, so supabase-js calls them with
  -- POST and not in a read-only transaction; authenticated only.
  FOREACH v_sig IN ARRAY ARRAY['public.monthly_plan_save(jsonb)',
                               'public.monthly_plan_confirm(uuid,boolean)'] LOOP
    PERFORM _mp_ok(format('shape: %s is SECURITY DEFINER, VOLATILE, search_path pinned', v_sig),
      to_regprocedure(v_sig) IS NOT NULL
      AND (SELECT p.prosecdef AND p.provolatile = 'v' FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig))
      AND EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                   WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=%'));
    PERFORM _mp_ok(format('privileges: %s is authenticated''s alone', v_sig),
      has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE')
      AND NOT has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
      AND NOT has_function_privilege('service_role', to_regprocedure(v_sig), 'EXECUTE'));
    PERFORM _mp_ok(format('shape: %s asks the state helper and the Dokumente page', v_sig),
      (SELECT p.prosrc ~ 'get_active_company_id'
              AND p.prosrc ~ 'current_role_permits\(''documents'', true\)'
              AND p.prosrc ~ 'not_authorized'
         FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)));
    PERFORM _mp_ok(format('shape: %s takes pg_advisory_xact_lock on the month', v_sig),
      (SELECT p.prosrc ~ 'pg_advisory_xact_lock' FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)));
  END LOOP;
END $$;

-- ─── 2. section 9: one active plan per month, in the database ───────────────

DO $$
DECLARE
  c_co CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_def text;
  v_admin_a uuid;
  v_admin_b uuid;
  v_out text;
BEGIN
  SELECT pg_get_indexdef(to_regclass('public.monthly_plans_one_confirmed_per_month')) INTO v_def;
  PERFORM _mp_ok('section 9: the index is unique, on (company_id, year, month), partial on confirmed',
    v_def ~ 'CREATE UNIQUE INDEX' AND v_def ~ 'company_id, year, month'
    AND v_def ~ 'WHERE \(status = ''confirmed''::text\)');
  -- The legacy guard keys on the import as well, and fahrtenbuch_imports has
  -- only a non-unique (company_id, year, month) index, so two imports of one
  -- month give two applied runs. This index cannot.
  PERFORM _mp_ok('section 9: the index does not key on the import, which is the legacy defect',
    v_def !~ 'import_id');

  -- `_mp_as` does `SET LOCAL ROLE authenticated`, and `_mp_u` reads a TEMP table
  -- the owner alone may select — so the first role switch locks every later
  -- `_mp_u` out with "permission denied for table _mp_who". Resolved once here,
  -- as the owner, before any switch.
  v_admin_a := _mp_u('admin-a');
  v_admin_b := _mp_u('admin-b');

  -- Directly, with no RPC in the path: the second confirmed plan of one month
  -- is refused by the index and not by a function anybody could bypass.
  PERFORM set_config('app_private.monthly_plan_transition',
    'plan:' || _mp_id('plan:a-draft')::text || ':' || pg_current_xact_id()::text, true);
  -- The trigger writes confirmed_at and confirmed_by ITSELF, from the session —
  -- "the actor and the time are the database's, whatever the caller sent". So
  -- the statement must run inside a session, not carry the stamps: passing them
  -- is overwritten, and with no session confirmed_by comes out NULL and the
  -- pair constraint refuses the row, which is the WRONG constraint and proves
  -- nothing about the unique index this section tests.
  PERFORM _mp_as(v_admin_a);
  UPDATE monthly_plans SET status = 'confirmed'
   WHERE id = _mp_id('plan:a-draft');
  PERFORM set_config('app_private.monthly_plan_transition', '', true);
  PERFORM _mp_ok('section 9: the seeded plan of company A is now the month''s confirmed plan',
    (SELECT status = 'confirmed' AND confirmed_at IS NOT NULL
       FROM monthly_plans WHERE id = _mp_id('plan:a-draft')));

  -- A draft beside it is fine: screen 1 prepares a new proposal for a month
  -- that already has a saved plan.
  INSERT INTO monthly_plans (id, company_id, year, month, switch_minutes)
  VALUES (_mp_id('plan:a-second'), c_co, 2026, 10, 30);
  PERFORM _mp_ok('section 9: a second draft for the same month is allowed',
    (SELECT count(*) = 2 FROM monthly_plans
      WHERE company_id = c_co AND year = 2026 AND month = 10));

  BEGIN
    PERFORM set_config('app_private.monthly_plan_transition',
      'plan:' || _mp_id('plan:a-second')::text || ':' || pg_current_xact_id()::text, true);
    -- The trigger writes confirmed_at and confirmed_by ITSELF, from the session —
  -- "the actor and the time are the database's, whatever the caller sent". So
  -- the statement must run inside a session, not carry the stamps: passing them
  -- is overwritten, and with no session confirmed_by comes out NULL and the
  -- pair constraint refuses the row, which is the WRONG constraint and proves
  -- nothing about the unique index this section tests.
  PERFORM _mp_as(v_admin_a);
  UPDATE monthly_plans SET status = 'confirmed'
   WHERE id = _mp_id('plan:a-second');
    v_out := 'allowed';
  EXCEPTION WHEN unique_violation THEN
    v_out := 'refused';
  END;
  PERFORM set_config('app_private.monthly_plan_transition', '', true);
  PERFORM _mp_ok('section 9: a second CONFIRMED plan for one month is refused by the database itself',
    v_out = 'refused');

  -- The same month of another company is untouched by the rule.
  PERFORM set_config('app_private.monthly_plan_transition',
    'plan:' || _mp_id('plan:b-draft')::text || ':' || pg_current_xact_id()::text, true);
  -- The trigger writes confirmed_at and confirmed_by ITSELF, from the session —
  -- "the actor and the time are the database's, whatever the caller sent". So
  -- the statement must run inside a session, not carry the stamps: passing them
  -- is overwritten, and with no session confirmed_by comes out NULL and the
  -- pair constraint refuses the row, which is the WRONG constraint and proves
  -- nothing about the unique index this section tests.
  -- Company B's plan, so company B's administrator: the tenant policies refuse
  -- admin-a here, and rightly — the row is not that company's.
  PERFORM _mp_as(v_admin_b);
  UPDATE monthly_plans SET status = 'confirmed'
   WHERE id = _mp_id('plan:b-draft');
  PERFORM set_config('app_private.monthly_plan_transition', '', true);
  PERFORM _mp_ok('section 9: the same month of another company may be confirmed too',
    (SELECT status = 'confirmed' FROM monthly_plans WHERE id = _mp_id('plan:b-draft')));

  -- Back to the owner before the delete, and this is not tidiness.
  --
  -- The statement above left the session as company B's administrator, and this
  -- row is company A's. A DELETE whose WHERE names a row the SELECT policy hides
  -- is not an error — RLS filters it, so it deletes ZERO rows and reports
  -- success. The row would have stayed confirmed, silently, and the sections
  -- below would have run against a month that already has its one confirmed
  -- plan. Only INSERT and UPDATE raise on a hidden row, which is why the file
  -- first failed on the statement AFTER this one and not on this one.
  PERFORM _mp_reset();

  -- Put both back to drafts for the sections below. A superseded plan is the
  -- only other way out, and it needs the marker too, so this is a delete.
  DELETE FROM monthly_plans WHERE id = _mp_id('plan:a-second');
  PERFORM _mp_ok('section 9: the second plan is gone, so the month is free again',
    NOT EXISTS (SELECT 1 FROM monthly_plans WHERE id = _mp_id('plan:a-second')));
END $$;

-- The two plans confirmed above are frozen now, so section 7 uses them and the
-- sections in between get drafts of their own.
--
-- As the owner: `SET LOCAL ROLE` outlives the DO block that issued it, so a
-- file-level statement runs as whatever role the last block left behind. The
-- block above ends with `_mp_reset()` for exactly this reason.
INSERT INTO monthly_plans (id, company_id, year, month, switch_minutes)
VALUES (_mp_id('plan:a-work'), 'c0000000-0000-4000-8000-00000000000a', 2026, 11, 30);

-- ─── 3. section 13: the snapshot is the database's ──────────────────────────

DO $$
DECLARE
  c_co   CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_plan CONSTANT uuid := _mp_id('plan:a-work');
  v_row  monthly_plan_drivers;
  v_out  text;
  v_hint text;
BEGIN
  -- Everything but driver_id and `selected` is the database's. The client sends
  -- a wrong name, a wrong owner flag and invented pay, and none of it survives.
  INSERT INTO monthly_plan_drivers (id, company_id, plan_id, driver_id, driver_name, selected,
                                    is_owner, planning_min_salary, planning_max_salary,
                                    planning_hourly_rate, max_monthly_hours, planning_priority,
                                    range_problems)
  VALUES (_mp_id('pd:work-ok'), c_co, c_plan, _mp_id('driver:ok'), 'NOT THE NAME', true,
          true, 1, 2, 3, 4, 5, ARRAY['missing_min_salary']);

  SELECT * INTO v_row FROM monthly_plan_drivers WHERE id = _mp_id('pd:work-ok');
  PERFORM _mp_ok('section 13: the name, the owner flag and the eight figures are copied from public.drivers',
    v_row.driver_name = 'MP Ok' AND v_row.is_owner = false
    AND v_row.planning_min_salary = 1950 AND v_row.planning_max_salary = 2100
    AND v_row.planning_hourly_rate = 14 AND v_row.max_monthly_hours IS NULL
    AND v_row.planning_priority = 100 AND v_row.planning_enabled = true
    AND v_row.can_cover_other_drivers = true AND v_row.range_problems = '{}'::text[]);

  -- Section 5's own arithmetic, from the stored snapshot: 1950 / 14 is
  -- 139,2857… and 2100 / 14 is exactly 150.
  PERFORM _mp_ok('section 13: the stored snapshot gives section 5''s figures — 139,29 h to 150 h',
    (SELECT round(planning_min_salary / planning_hourly_rate, 2) = 139.29
            AND planning_max_salary / planning_hourly_rate = 150
       FROM monthly_plan_drivers WHERE id = _mp_id('pd:work-ok')));

  -- A later edit to the driver does not move the plan.
  UPDATE drivers SET planning_min_salary = 1, planning_max_salary = 2, planning_hourly_rate = 3,
                     name = 'MP Ok renamed'
   WHERE id = _mp_id('driver:ok');
  PERFORM _mp_ok('section 13: editing the driver afterwards does not move the snapshot',
    (SELECT driver_name = 'MP Ok' AND planning_min_salary = 1950 AND planning_hourly_rate = 14
       FROM monthly_plan_drivers WHERE id = _mp_id('pd:work-ok')));
  UPDATE drivers SET planning_min_salary = 1950, planning_max_salary = 2100,
                     planning_hourly_rate = 14, name = 'MP Ok'
   WHERE id = _mp_id('driver:ok');

  -- An hourly rate of 0 is a configuration error, named and not divided by.
  INSERT INTO monthly_plan_drivers (id, company_id, plan_id, driver_id, driver_name, selected, is_owner)
  VALUES (_mp_id('pd:work-zero'), c_co, c_plan, _mp_id('driver:zero'), NULL, true, false);
  PERFORM _mp_ok('section 14: an hourly rate of 0 is invalid_hourly_rate and the three figures are NULL',
    (SELECT range_problems = ARRAY['invalid_hourly_rate']
            AND planning_hourly_rate IS NULL AND planning_min_salary IS NULL
            AND planning_max_salary IS NULL
       FROM monthly_plan_drivers WHERE id = _mp_id('pd:work-zero')));

  -- A minimum salary above the maximum, likewise.
  INSERT INTO monthly_plan_drivers (id, company_id, plan_id, driver_id, driver_name, selected, is_owner)
  VALUES (_mp_id('pd:work-inv'), c_co, c_plan, _mp_id('driver:inv'), NULL, true, false);
  PERFORM _mp_ok('section 14: a minimum above the maximum is min_salary_above_max and is never swapped',
    (SELECT range_problems = ARRAY['min_salary_above_max'] AND planning_min_salary IS NULL
       FROM monthly_plan_drivers WHERE id = _mp_id('pd:work-inv')));

  -- A missing rate is a different problem from an invalid one: the fix differs.
  UPDATE drivers SET planning_hourly_rate = NULL WHERE id = _mp_id('driver:zero');
  UPDATE monthly_plan_drivers SET selected = true WHERE id = _mp_id('pd:work-zero');
  PERFORM _mp_ok('section 14: a missing rate is missing_hourly_rate, a distinct problem',
    (SELECT range_problems = ARRAY['missing_hourly_rate']
       FROM monthly_plan_drivers WHERE id = _mp_id('pd:work-zero')));
  UPDATE drivers SET planning_hourly_rate = 0 WHERE id = _mp_id('driver:zero');

  -- The owner is read from employment_type and gets no ceiling of its own.
  INSERT INTO monthly_plan_drivers (id, company_id, plan_id, driver_id, driver_name, selected, is_owner)
  VALUES (_mp_id('pd:work-owner'), c_co, c_plan, _mp_id('driver:owner'), NULL, false, false);
  PERFORM _mp_ok('section 8: the owner is derived from employment_type and may be unselected',
    (SELECT is_owner AND NOT selected FROM monthly_plan_drivers WHERE id = _mp_id('pd:work-owner')));

  -- Section 7 rule 8: anybody else who is not selected is refused.
  BEGIN
    INSERT INTO monthly_plan_drivers (company_id, plan_id, driver_id, driver_name, selected, is_owner)
    VALUES (c_co, c_plan, _mp_id('driver:inv'), NULL, false, false);
    v_out := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    v_out := coalesce(nullif(v_hint, ''), SQLSTATE);
  END;
  PERFORM _mp_ok('section 7 rule 8: only the owner may be in a plan without being selected [' || v_out || ']',
    v_out = 'monthly_plan_driver_not_selected');

  -- Another company's driver is refused, so a snapshot cannot cross tenants.
  BEGIN
    INSERT INTO monthly_plan_drivers (company_id, plan_id, driver_id, driver_name, selected, is_owner)
    VALUES (c_co, c_plan, _mp_id('driver:b'), NULL, true, false);
    v_out := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    v_out := coalesce(nullif(v_hint, ''), SQLSTATE);
  END;
  PERFORM _mp_ok('section 13: another company''s driver is refused [' || v_out || ']',
    v_out = 'driver_company_mismatch');

  -- The key is fixed: a snapshot cannot be re-pointed at another driver, plan
  -- or company, which would put one month's figures on another.
  BEGIN
    UPDATE monthly_plan_drivers SET driver_id = _mp_id('driver:inv')
     WHERE id = _mp_id('pd:work-ok');
    v_out := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    v_out := coalesce(nullif(v_hint, ''), SQLSTATE);
  END;
  PERFORM _mp_ok('section 13: a snapshot stays with its plan and its driver [' || v_out || ']',
    v_out = 'monthly_plan_child_key_fixed');

  -- Section 5's mandatory rule.
  PERFORM _mp_ok('section 5: the snapshot has no target_monthly_hours column',
    NOT EXISTS (SELECT 1 FROM pg_attribute a
                 WHERE a.attrelid = 'public.monthly_plan_drivers'::regclass
                   AND a.attnum > 0 AND NOT a.attisdropped
                   AND a.attname LIKE '%target_monthly_hours%'));
END $$;

-- ─── 4. section 14: where the two checks are, and where they are not ────────

DO $$
DECLARE v_out text;
BEGIN
  -- The measurement the migration header rests on: public.drivers constrains
  -- neither figure, so an ALTER TABLE ... CHECK there would be validated
  -- against production rows this branch cannot read. If that ever changes, this
  -- check fails and the header's reasoning is re-read rather than assumed.
  PERFORM _mp_ok('section 14: public.drivers has no CHECK on planning_hourly_rate or the salary range',
    NOT EXISTS (SELECT 1 FROM pg_constraint c
                 WHERE c.conrelid = 'public.drivers'::regclass AND c.contype = 'c'
                   AND pg_get_constraintdef(c.oid) ~ 'planning_hourly_rate|planning_min_salary'));
  PERFORM _mp_ok('section 14: a driver with an hourly rate of 0 exists and public.drivers accepts it',
    (SELECT planning_hourly_rate = 0 FROM drivers WHERE id = _mp_id('driver:zero')));

  -- …and the snapshot does constrain both, NaN included. `> 0` alone would let
  -- NaN through, because numeric orders NaN above every other value.
  PERFORM _mp_ok('section 14: numeric NaN really is greater than every number, so `> 0` alone is not enough',
    'NaN'::numeric > 0 AND NOT ('NaN'::numeric < 'Infinity'::numeric));

  BEGIN
    UPDATE monthly_plan_drivers SET planning_hourly_rate = 0 WHERE id = _mp_id('pd:work-ok');
    v_out := 'allowed';
  EXCEPTION WHEN check_violation THEN v_out := 'refused';
            WHEN OTHERS THEN v_out := SQLSTATE;
  END;
  -- The guard rewrites the figure from public.drivers before the CHECK is
  -- reached, so the stored value stays 14 either way; what this proves is that
  -- no path leaves an unusable rate in the snapshot.
  PERFORM _mp_ok('section 14: the snapshot never holds an unusable hourly rate [' || v_out || ']',
    (SELECT planning_hourly_rate = 14 FROM monthly_plan_drivers WHERE id = _mp_id('pd:work-ok')));

  PERFORM _mp_ok('section 14: the two CHECKs exist on the snapshot, where the plan reads the value',
    EXISTS (SELECT 1 FROM pg_constraint c
             WHERE c.conname = 'monthly_plan_drivers_hourly_rate_usable'
               AND pg_get_constraintdef(c.oid) ~ 'Infinity')
    AND EXISTS (SELECT 1 FROM pg_constraint c
                 WHERE c.conname = 'monthly_plan_drivers_salary_range_ordered'));
END $$;

-- ─── 5. the rule: nothing here writes a trip ───────────────────────────────

DO $$
DECLARE
  c_tables CONSTANT text[] := ARRAY['monthly_plans', 'monthly_plan_drivers',
                                    'monthly_plan_blocks', 'monthly_plan_block_trips'];
  c_funcs  CONSTANT text[] := ARRAY['app_private.monthly_plan_guard()',
                                    'app_private.monthly_plan_driver_guard()',
                                    'app_private.monthly_plan_child_guard()',
                                    'app_private.monthly_plan_parent_is_open(uuid,uuid)',
                                    'public.monthly_plan_save(jsonb)',
                                    'public.monthly_plan_confirm(uuid,boolean)'];
BEGIN
  PERFORM _mp_ok('the rule: no monthly-plan table has a foreign key to fahrtenbuch_trips',
    NOT EXISTS (SELECT 1 FROM pg_constraint c
                 WHERE c.contype = 'f'
                   AND c.conrelid IN (SELECT format('public.%I', u.t)::regclass
                                        FROM unnest(c_tables) AS u(t))
                   AND c.confrelid = 'public.fahrtenbuch_trips'::regclass));
  PERFORM _mp_ok('the rule: no monthly-plan function names fahrtenbuch_trips',
    NOT EXISTS (SELECT 1 FROM unnest(c_funcs) AS f(sig)
                 WHERE (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure(f.sig))
                         ~ 'fahrtenbuch_trips'));
  -- And the reason that matters: the trips table still has no UPDATE policy at
  -- all, which 20260917130000's self-check also asserts. A slice that quietly
  -- added one to make a plan "apply" would fail here too.
  PERFORM _mp_ok('the rule: fahrtenbuch_trips still has no UPDATE policy',
    NOT EXISTS (SELECT 1 FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = 'fahrtenbuch_trips'
                   AND p.cmd = 'UPDATE'));

  -- A ride whose instants could not be read is rejected by the engine and never
  -- blocked, so it cannot be stored either.
  PERFORM _mp_ok('section 3: a block''s ride cannot carry the unusable time source',
    EXISTS (SELECT 1 FROM pg_constraint c
             WHERE c.conrelid = 'public.monthly_plan_block_trips'::regclass
               AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ 'time_source'
               AND pg_get_constraintdef(c.oid) !~ 'unusable'));
END $$;

-- ─── 6. confirming, and replacing atomically ───────────────────────────────

DO $$
DECLARE
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_co    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_plan  CONSTANT uuid := _mp_id('plan:a-work');
  v_out   text;
  v_hint  text;
BEGIN
  -- Section 23: an empty plan is a failed save, not a month with nothing to do.
  PERFORM _mp_ok('confirm: a plan with no blocks is refused, by return value',
    _mp_try(c_admin, NULL,
      format('SELECT public.monthly_plan_confirm(%L) ->> ''reason''', c_plan)) = 'plan_empty');

  -- Give it one legal block for the driver with the good figures: 81 minutes,
  -- well inside 139,29 h to 150 h.
  INSERT INTO monthly_plan_blocks (id, company_id, plan_id, block_key, car_identifier,
                                   starts_at, ends_at, span_minutes, ride_minutes,
                                   driver_id, driver_name, assignment_reason)
  VALUES (_mp_id('blk:work-1'), c_co, c_plan, 'w1', 'MP-CAR-1',
          '2026-11-02 08:23+01', '2026-11-02 09:44+01', 81, 81,
          _mp_id('driver:ok'), NULL, 'best_fit');

  PERFORM _mp_ok('confirm: a block''s driver_name is resolved from the plan''s own snapshot',
    (SELECT driver_name = 'MP Ok' FROM monthly_plan_blocks WHERE id = _mp_id('blk:work-1')));

  -- Section 7 rule 8, on the way in: a driver the plan does not list is refused
  -- before any confirmation is asked for.
  BEGIN
    INSERT INTO monthly_plan_blocks (company_id, plan_id, block_key, car_identifier,
                                     starts_at, ends_at, span_minutes, ride_minutes,
                                     driver_id, driver_name, assignment_reason)
    VALUES (c_co, c_plan, 'w-alien', 'MP-CAR-1',
            '2026-11-03 08:00+01', '2026-11-03 09:00+01', 60, 60,
            _mp_id('driver:b'), NULL, 'best_fit');
    v_out := 'allowed';
  EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      v_out := coalesce(nullif(v_hint, ''), SQLSTATE);
  END;
  PERFORM _mp_ok('section 7 rule 8: a block cannot be given to a driver the plan does not list [' || v_out || ']',
    v_out = 'monthly_plan_driver_not_in_plan');

  -- Section 7 rule 2: an overlapping second block for the same driver.
  INSERT INTO monthly_plan_blocks (id, company_id, plan_id, block_key, car_identifier,
                                   starts_at, ends_at, span_minutes, ride_minutes,
                                   driver_id, driver_name, assignment_reason)
  VALUES (_mp_id('blk:work-overlap'), c_co, c_plan, 'w-overlap', 'MP-CAR-1',
          '2026-11-02 09:00+01', '2026-11-02 10:00+01', 60, 60,
          _mp_id('driver:ok'), NULL, 'best_fit');
  PERFORM _mp_ok('confirm: an overlap for one driver is refused, re-derived from the blocks',
    _mp_try(c_admin, NULL,
      format('SELECT public.monthly_plan_confirm(%L) ->> ''reason''', c_plan)) = 'driver_overlap');
  DELETE FROM monthly_plan_blocks WHERE id = _mp_id('blk:work-overlap');

  -- The derived cross-vehicle check: 10 minutes between two cars when the plan
  -- was made with a switch duration of 30 is the same impossibility as an
  -- overlap. The same gap on the SAME car is legal, and is checked after.
  INSERT INTO monthly_plan_blocks (id, company_id, plan_id, block_key, car_identifier,
                                   starts_at, ends_at, span_minutes, ride_minutes,
                                   driver_id, driver_name, assignment_reason)
  VALUES (_mp_id('blk:work-switch'), c_co, c_plan, 'w-switch', 'MP-CAR-2',
          '2026-11-02 09:54+01', '2026-11-02 10:30+01', 36, 36,
          _mp_id('driver:ok'), NULL, 'best_fit');
  PERFORM _mp_ok('confirm: a 10-minute hop between two cars under a 30-minute switch duration is refused',
    _mp_try(c_admin, NULL,
      format('SELECT public.monthly_plan_confirm(%L) ->> ''reason''', c_plan)) = 'vehicle_switch_gap');

  UPDATE monthly_plan_blocks SET car_identifier = 'MP-CAR-1' WHERE id = _mp_id('blk:work-switch');
  PERFORM _mp_ok('confirm: the same 10-minute gap on the same car is not the switch check''s business',
    _mp_try(c_admin, NULL,
      format('SELECT public.monthly_plan_confirm(%L) ->> ''reason''', c_plan)) IS DISTINCT FROM 'vehicle_switch_gap');
  DELETE FROM monthly_plan_blocks WHERE id = _mp_id('blk:work-switch');

  -- Sections 5 and 14: a regular driver with work and no usable range.
  INSERT INTO monthly_plan_blocks (id, company_id, plan_id, block_key, car_identifier,
                                   starts_at, ends_at, span_minutes, ride_minutes,
                                   driver_id, driver_name, assignment_reason)
  VALUES (_mp_id('blk:work-zero'), c_co, c_plan, 'w-zero', 'MP-CAR-3',
          '2026-11-04 08:00+01', '2026-11-04 09:00+01', 60, 60,
          _mp_id('driver:zero'), NULL, 'best_fit');
  PERFORM _mp_ok('confirm: a regular driver with blocks and no usable range is refused',
    _mp_try(c_admin, NULL,
      format('SELECT public.monthly_plan_confirm(%L) ->> ''reason''', c_plan)) = 'no_usable_range');
  DELETE FROM monthly_plan_blocks WHERE id = _mp_id('blk:work-zero');

  -- Section 7 rule 3: 151 hours for a driver capped at 2100 / 14 = 150.
  INSERT INTO monthly_plan_blocks (id, company_id, plan_id, block_key, car_identifier,
                                   starts_at, ends_at, span_minutes, ride_minutes,
                                   driver_id, driver_name, assignment_reason)
  VALUES (_mp_id('blk:work-cap'), c_co, c_plan, 'w-cap', 'MP-CAR-1',
          '2026-11-10 00:00+01', '2026-11-16 05:39+01', 8979, 8979,
          _mp_id('driver:ok'), NULL, 'best_fit');
  PERFORM _mp_ok('section 7 rule 3: 151 h for a driver capped at 150 h is refused',
    _mp_try(c_admin, NULL,
      format('SELECT public.monthly_plan_confirm(%L) ->> ''reason''', c_plan)) = 'exceeds_hours_cap');

  -- Section 8: the owner has no monthly ceiling, so the very same hours are
  -- legal for the owner. That is the one asymmetry of the whole assigner.
  UPDATE monthly_plan_blocks SET driver_id = _mp_id('driver:owner'), driver_name = NULL
   WHERE id = _mp_id('blk:work-cap');
  PERFORM _mp_ok('section 8: the owner is under no monthly hours ceiling',
    _mp_try(c_admin, NULL,
      format('SELECT public.monthly_plan_confirm(%L) ->> ''reason''', c_plan)) IS DISTINCT FROM 'exceeds_hours_cap');
  DELETE FROM monthly_plan_blocks WHERE id = _mp_id('blk:work-cap');

  -- Exactly at the cap is not over it: 150 h is 9000 minutes, and the 81 above
  -- leaves 8919.
  INSERT INTO monthly_plan_blocks (id, company_id, plan_id, block_key, car_identifier,
                                   starts_at, ends_at, span_minutes, ride_minutes,
                                   driver_id, driver_name, assignment_reason)
  VALUES (_mp_id('blk:work-exact'), c_co, c_plan, 'w-exact', 'MP-CAR-1',
          '2026-11-10 00:00+01', '2026-11-16 04:39+01', 8919, 8919,
          _mp_id('driver:ok'), NULL, 'best_fit');
  PERFORM _mp_ok('section 7 rule 3: exactly 150 h is inside the cap, not over it',
    _mp_try(c_admin, NULL,
      format('SELECT public.monthly_plan_confirm(%L) ->> ''reason''', c_plan)) IS DISTINCT FROM 'exceeds_hours_cap');
  DELETE FROM monthly_plan_blocks WHERE id = _mp_id('blk:work-exact');
END $$;

-- The confirmation itself, at top level so its rows survive for section 7.
DO $$
DECLARE
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_co    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_res   jsonb;
BEGIN
  PERFORM _mp_as(c_admin);
  v_res := public.monthly_plan_confirm(_mp_id('plan:a-work'));
  PERFORM _mp_reset();
  PERFORM _mp_ok('confirm: a legal plan is confirmed and stamped by the database',
    (v_res ->> 'success')::boolean
    AND (SELECT status = 'confirmed' AND confirmed_at IS NOT NULL
                AND confirmed_by = c_admin
           FROM monthly_plans WHERE id = _mp_id('plan:a-work')));

  -- Section 9's two choices. Without p_replace the answer names the active plan
  -- and writes nothing; it is a return value and not an exception, because the
  -- screen has to offer both.
  INSERT INTO monthly_plans (id, company_id, year, month, switch_minutes)
  VALUES (_mp_id('plan:a-next'), c_co, 2026, 11, 30);
  INSERT INTO monthly_plan_drivers (company_id, plan_id, driver_id, driver_name, selected, is_owner)
  VALUES (c_co, _mp_id('plan:a-next'), _mp_id('driver:ok'), NULL, true, false);
  INSERT INTO monthly_plan_blocks (company_id, plan_id, block_key, car_identifier,
                                   starts_at, ends_at, span_minutes, ride_minutes,
                                   driver_id, driver_name, assignment_reason)
  VALUES (c_co, _mp_id('plan:a-next'), 'n1', 'MP-CAR-1',
          '2026-11-05 08:00+01', '2026-11-05 09:00+01', 60, 60,
          _mp_id('driver:ok'), NULL, 'best_fit');

  PERFORM _mp_as(c_admin);
  v_res := public.monthly_plan_confirm(_mp_id('plan:a-next'));
  PERFORM _mp_reset();
  PERFORM _mp_ok('section 9: confirming beside an active plan answers plan_exists and names it',
    (v_res ->> 'success')::boolean = false
    AND v_res ->> 'reason' = 'plan_exists'
    AND (v_res ->> 'existing_plan_id')::uuid = _mp_id('plan:a-work'));
  PERFORM _mp_ok('section 9: …and writes nothing',
    (SELECT status = 'draft' FROM monthly_plans WHERE id = _mp_id('plan:a-next'))
    AND (SELECT status = 'confirmed' FROM monthly_plans WHERE id = _mp_id('plan:a-work')));

  -- And the replacement, which must be one transaction: the old plan becomes
  -- superseded and points at the new one, the new one becomes confirmed, and
  -- the month never holds two confirmed plans in between.
  PERFORM _mp_as(c_admin);
  v_res := public.monthly_plan_confirm(_mp_id('plan:a-next'), true);
  PERFORM _mp_reset();
  PERFORM _mp_ok('section 9: the replacement supersedes and confirms in one transaction',
    (v_res ->> 'success')::boolean
    AND (v_res ->> 'superseded_plan_id')::uuid = _mp_id('plan:a-work')
    AND (SELECT status = 'superseded' AND superseded_at IS NOT NULL
                AND superseded_by = c_admin AND replaced_by_plan_id = _mp_id('plan:a-next')
                AND confirmed_at IS NOT NULL
           FROM monthly_plans WHERE id = _mp_id('plan:a-work'))
    AND (SELECT status = 'confirmed' FROM monthly_plans WHERE id = _mp_id('plan:a-next'))
    AND (SELECT count(*) = 1 FROM monthly_plans
          WHERE company_id = c_co AND year = 2026 AND month = 11 AND status = 'confirmed'));
END $$;

-- ─── 7. a confirmed plan is frozen ─────────────────────────────────────────

DO $$
DECLARE
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_plan  CONSTANT uuid := _mp_id('plan:a-next');
  v_out   text;
BEGIN
  -- Section 22: every document's totals come from the same plan, so once the
  -- plan is confirmed nothing under it moves.
  v_out := _mp_try(c_admin, NULL,
    format('UPDATE monthly_plans SET switch_minutes = 45 WHERE id = %L', c_plan));
  PERFORM _mp_ok('section 22: a confirmed plan''s header cannot be edited [' || v_out || ']',
    v_out = 'ERR P0001 monthly_plan_is_final');

  v_out := _mp_try(c_admin, NULL,
    format('UPDATE monthly_plan_blocks SET span_minutes = 1 WHERE plan_id = %L', c_plan));
  PERFORM _mp_ok('section 22: a confirmed plan''s blocks cannot be edited [' || v_out || ']',
    v_out = 'ERR P0001 monthly_plan_is_final');

  v_out := _mp_try(c_admin, NULL,
    format('UPDATE monthly_plan_drivers SET selected = false WHERE plan_id = %L', c_plan));
  PERFORM _mp_ok('section 22: a confirmed plan''s snapshot cannot be edited [' || v_out || ']',
    v_out = 'ERR P0001 monthly_plan_is_final');

  v_out := _mp_try(c_admin, NULL,
    format('INSERT INTO monthly_plan_blocks (company_id, plan_id, block_key, car_identifier, starts_at, ends_at, span_minutes, ride_minutes) VALUES (%L, %L, ''late'', ''X'', now(), now(), 0, 0)',
           'c0000000-0000-4000-8000-00000000000a', c_plan));
  PERFORM _mp_ok('section 22: no block can be added to a confirmed plan [' || v_out || ']',
    v_out = 'ERR P0001 monthly_plan_is_final');

  v_out := _mp_try(c_admin, NULL, format('DELETE FROM monthly_plans WHERE id = %L', c_plan));
  PERFORM _mp_ok('section 22: a confirmed plan cannot be deleted [' || v_out || ']',
    v_out = 'ERR P0001 monthly_plan_is_final');

  -- And status is not the client's, even on a draft: without the marker the
  -- guard refuses, so the stamping and the atomic supersede stay the RPC's.
  INSERT INTO monthly_plans (id, company_id, year, month, switch_minutes)
  VALUES (_mp_id('plan:a-status'), 'c0000000-0000-4000-8000-00000000000a', 2026, 12, 30);
  v_out := _mp_try(c_admin, NULL,
    format('UPDATE monthly_plans SET status = ''confirmed'' WHERE id = %L', _mp_id('plan:a-status')));
  PERFORM _mp_ok('section 9: a client cannot confirm a plan by writing its status [' || v_out || ']',
    v_out = 'ERR P0001 monthly_plan_transition_needs_rpc');

  -- The key is fixed on the header too: a plan cannot be moved to another month
  -- or another company, which would slide a snapshot onto a month it was not
  -- made for and walk around the unique index.
  v_out := _mp_try(c_admin, NULL,
    format('UPDATE monthly_plans SET month = 1 WHERE id = %L', _mp_id('plan:a-status')));
  PERFORM _mp_ok('section 9: a plan cannot be moved to another month [' || v_out || ']',
    v_out = 'ERR P0001 monthly_plan_key_fixed');
END $$;

-- ─── 8. saving, and the role gate ──────────────────────────────────────────

DO $$
DECLARE
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_edit  CONSTANT uuid := 'a0000000-0000-4000-8000-000000000002';
  c_view  CONSTANT uuid := 'a0000000-0000-4000-8000-000000000003';
  v_payload text;
  v_res   jsonb;
  v_role  text;
BEGIN
  -- The seeded roles: an editor and a viewer hold no can_edit on the Dokumente
  -- page, which is what slice C decided for every planning table. Read out of
  -- role_permissions rather than written down, so the probe and the seed cannot
  -- drift.
  PERFORM _mp_ok('roles: neither the viewer nor the editor may edit the Dokumente page',
    (SELECT count(*) = 2 FROM roles r
       JOIN role_permissions rp ON rp.role_id = r.id AND rp.page_key = 'documents'
      WHERE r.company_id IS NULL AND r.name IN ('viewer', 'editor') AND rp.can_edit = false));

  v_payload := format($j${"year": 2027, "month": 1, "switch_minutes": 30,
     "drivers": [{"driver_id": "%s", "selected": true}],
     "blocks": [{"block_key": "s1", "car_identifier": "MP-CAR-1",
                 "starts_at": "2027-01-04 08:23+01", "ends_at": "2027-01-04 09:44+01",
                 "span_minutes": 81, "ride_minutes": 81,
                 "driver_id": "%s", "assignment_reason": "best_fit",
                 "trips": [{"trip_id": "%s", "starts_at": "2027-01-04 08:23+01",
                            "ends_at": "2027-01-04 09:44+01", "minutes": 81,
                            "time_source": "instants"}]}]}$j$,
    _mp_id('driver:ok'), _mp_id('driver:ok'), _mp_id('trip:save-1'));

  FOREACH v_role IN ARRAY ARRAY['viewer', 'editor'] LOOP
    PERFORM _mp_ok(format('roles: monthly_plan_save is refused for the %s', v_role),
      _mp_try(CASE v_role WHEN 'viewer' THEN c_view ELSE c_edit END, NULL,
        format('SELECT (public.monthly_plan_save(%L::jsonb) -> ''success'')::text', v_payload))
        = 'ERR 42501 not_authorized');
    PERFORM _mp_ok(format('roles: monthly_plan_confirm is refused for the %s', v_role),
      _mp_try(CASE v_role WHEN 'viewer' THEN c_view ELSE c_edit END, NULL,
        format('SELECT public.monthly_plan_confirm(%L) ->> ''reason''', _mp_id('plan:a-status')))
        = 'ERR 42501 not_authorized');
    PERFORM _mp_ok(format('roles: a direct insert is refused for the %s', v_role),
      _mp_try(CASE v_role WHEN 'viewer' THEN c_view ELSE c_edit END, NULL,
        'INSERT INTO monthly_plans (company_id, year, month, switch_minutes) VALUES ('
        || quote_literal('c0000000-0000-4000-8000-00000000000a') || ', 2027, 6, 30)')
        ~ '^ERR 42501');
    PERFORM _mp_ok(format('roles: …but the %s still reads the plan', v_role),
      _mp_try(CASE v_role WHEN 'viewer' THEN c_view ELSE c_edit END, NULL,
        'SELECT count(*)::text FROM monthly_plans')::int > 0);
  END LOOP;

  -- The administrator saves, in one transaction, with every row accounted for.
  PERFORM _mp_as(c_admin);
  v_res := public.monthly_plan_save(v_payload::jsonb);
  PERFORM _mp_reset();
  PERFORM _mp_ok('section 21: the administrator''s save writes header, snapshot, block and ride together',
    (v_res ->> 'success')::boolean
    AND (v_res ->> 'driver_count')::int = 1
    AND (v_res ->> 'block_count')::int = 1
    AND (v_res ->> 'trip_count')::int = 1
    AND (SELECT count(*) = 1 FROM monthly_plan_block_trips
          WHERE plan_id = (v_res ->> 'plan_id')::uuid));
  PERFORM _mp_ok('section 13: the save takes the snapshot from public.drivers, not from the payload',
    (SELECT driver_name = 'MP Ok' AND planning_hourly_rate = 14 AND range_problems = '{}'::text[]
       FROM monthly_plan_drivers WHERE plan_id = (v_res ->> 'plan_id')::uuid));

  -- "Neu generieren" replaces the proposal rather than adding a second one.
  PERFORM _mp_as(c_admin);
  v_res := public.monthly_plan_save(v_payload::jsonb);
  PERFORM _mp_reset();
  PERFORM _mp_ok('section 1: a second save of the same month discards the earlier draft',
    (v_res ->> 'discarded_drafts')::int = 1
    AND (SELECT count(*) = 1 FROM monthly_plans
          WHERE company_id = 'c0000000-0000-4000-8000-00000000000a'
            AND year = 2027 AND month = 1));

  -- A broken contract raises 22023 and is not silently stored as an empty plan.
  PERFORM _mp_ok('section 14: a payload without a month is a broken contract, not an empty plan',
    _mp_try(c_admin, NULL, 'SELECT public.monthly_plan_save(''{"year": 2027}''::jsonb)::text')
      ~ '^ERR 22023');
  PERFORM _mp_ok('section 14: a payload whose drivers are not an array is refused',
    _mp_try(c_admin, NULL,
      'SELECT public.monthly_plan_save(''{"year": 2027, "month": 2, "switch_minutes": 30, "drivers": {}}''::jsonb)::text')
      ~ '^ERR 22023');
END $$;

-- ─── 9. tenants ────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_admin_a CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_admin_b CONSTANT uuid := 'b0000000-0000-4000-8000-000000000001';
  c_co_a    CONSTANT text := 'c0000000-0000-4000-8000-00000000000a';
  v_tbl     text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['monthly_plans', 'monthly_plan_drivers',
                               'monthly_plan_blocks', 'monthly_plan_block_trips'] LOOP
    PERFORM _mp_ok(format('tenants: company A''s administrator reads only A''s %s rows', v_tbl),
      _mp_try(c_admin_a, NULL,
        format('SELECT count(*)::text FROM %I WHERE company_id <> %L', v_tbl, c_co_a)) = '0');
    PERFORM _mp_ok(format('tenants: company B''s administrator sees none of A''s %s rows', v_tbl),
      _mp_try(c_admin_b, NULL,
        format('SELECT count(*)::text FROM %I WHERE company_id = %L', v_tbl, c_co_a)) = '0');
  END LOOP;

  -- The same predicate as USING and as WITH CHECK is what refuses a move.
  PERFORM _mp_ok('tenants: company B''s administrator cannot insert a plan into company A',
    _mp_try(c_admin_b, NULL,
      format('INSERT INTO monthly_plans (company_id, year, month, switch_minutes) VALUES (%L, 2028, 1, 30)', c_co_a))
      ~ '^ERR 42501');
  PERFORM _mp_ok('tenants: company A''s administrator cannot move a plan to company B',
    _mp_try(c_admin_a, NULL,
      format('UPDATE monthly_plans SET company_id = %L WHERE id = %L',
             'c0000000-0000-4000-8000-00000000000b', _mp_id('plan:a-status')))
      = 'ERR P0001 monthly_plan_key_fixed');
  PERFORM _mp_ok('tenants: confirming another company''s plan answers plan_not_found',
    _mp_try(c_admin_b, NULL,
      format('SELECT public.monthly_plan_confirm(%L) ->> ''reason''', _mp_id('plan:a-status')))
      = 'plan_not_found');
END $$;

-- ─── 10. company and account state ─────────────────────────────────────────

DO $$
DECLARE
  c_susp CONSTANT uuid := _mp_id('user:admin-suspended');
BEGIN
  PERFORM _mp_ok('state: a suspended company''s administrator reads no plan',
    _mp_try(c_susp, NULL, 'SELECT count(*)::text FROM monthly_plans') = '0');
  PERFORM _mp_ok('state: …and writes none',
    _mp_try(c_susp, NULL,
      format('INSERT INTO monthly_plans (company_id, year, month, switch_minutes) VALUES (%L, 2028, 2, 30)',
             _mp_id('company:suspended'))) ~ '^ERR 42501');
  PERFORM _mp_ok('state: …and monthly_plan_save refuses with its own no_company branch',
    _mp_try(c_susp, NULL,
      'SELECT public.monthly_plan_save(''{"year": 2028, "month": 3, "switch_minutes": 30}''::jsonb)::text')
      = 'ERR 42501 no_company');
  PERFORM _mp_ok('state: …and so does monthly_plan_confirm, before the role gate',
    _mp_try(c_susp, NULL,
      format('SELECT public.monthly_plan_confirm(%L) ->> ''reason''', _mp_id('plan:susp-draft')))
      = 'ERR 42501 no_company');
  PERFORM _mp_ok('state: anon reads nothing and calls neither RPC',
    _mp_try(NULL, NULL, 'SELECT count(*)::text FROM monthly_plans') ~ '^ERR 42501'
    AND _mp_try(NULL, NULL, 'SELECT public.monthly_plan_save(''{}''::jsonb)::text') ~ '^ERR 42501');
END $$;

-- ─── 11. platform contexts ─────────────────────────────────────────────────

DO $$
DECLARE
  c_view    CONSTANT uuid := _mp_id('user:owner-view');
  c_support CONSTANT uuid := _mp_id('user:owner-support');
  c_co_a    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_open    jsonb;
BEGIN
  -- No context at all: a platform owner reaches none of it, because
  -- platform_reads_company_data() and platform_writes_company_data() are both
  -- `SELECT false` since 20260917140000.
  PERFORM _mp_ok('contexts: a platform owner with no context reads no plan',
    _mp_try('50000000-0000-4000-8000-000000000001', NULL,
      'SELECT count(*)::text FROM monthly_plans') = '0');

  PERFORM _mp_as(c_view, _mp_id('session:owner-view'));
  v_open := public.platform_context_open(c_co_a, 'view');
  PERFORM _mp_reset();
  PERFORM _mp_ok('contexts: the view context opened', (v_open ->> 'success') = 'true');

  PERFORM _mp_ok('contexts: a view context reads the company it opened',
    _mp_try(c_view, _mp_id('session:owner-view'),
      format('SELECT count(*)::text FROM monthly_plans WHERE company_id = %L', c_co_a))::int > 0);
  PERFORM _mp_ok('contexts: a view context writes nothing (3.4a)',
    _mp_try(c_view, _mp_id('session:owner-view'),
      format('INSERT INTO monthly_plans (company_id, year, month, switch_minutes) VALUES (%L, 2029, 1, 30)', c_co_a))
      = 'ERR P0001 support_session_required');
END $$;

-- The support session's write and its audit row, at top level so the rows
-- survive to be counted.
DO $$
DECLARE
  c_support CONSTANT uuid := _mp_id('user:owner-support');
  c_co_a    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_open    jsonb;
  v_mark    bigint;
  v_after   jsonb;
BEGIN
  PERFORM _mp_as(c_support, _mp_id('session:owner-support'));
  v_open := public.platform_context_open(c_co_a, 'support', 'Ticket Monatsplan');
  PERFORM _mp_reset();
  PERFORM _mp_ok('contexts: the support session opened', (v_open ->> 'success') = 'true');

  v_mark := _mp_mark();
  PERFORM _mp_as(c_support, _mp_id('session:owner-support'));
  INSERT INTO monthly_plans (id, company_id, year, month, switch_minutes)
  VALUES (_mp_id('plan:support'), c_co_a, 2029, 2, 30);
  INSERT INTO monthly_plan_drivers (company_id, plan_id, driver_id, driver_name, selected, is_owner)
  VALUES (c_co_a, _mp_id('plan:support'), _mp_id('driver:ok'), NULL, true, false);
  PERFORM _mp_reset();

  PERFORM _mp_ok('contexts: a support session writes the company it opened',
    (SELECT count(*) = 1 FROM monthly_plans WHERE id = _mp_id('plan:support')));
  PERFORM _mp_ok('contexts: each row it wrote left exactly one audit row (3.4c)',
    _mp_rows(v_mark, 'support_write.monthly_plans.insert') = 1
    AND _mp_rows(v_mark, 'support_write.monthly_plan_drivers.insert') = 1);

  SELECT l.after_value INTO v_after
    FROM app_private.platform_audit_log l
   WHERE l.id > v_mark AND l.action = 'support_write.monthly_plan_drivers.insert'
   ORDER BY l.id LIMIT 1;
  PERFORM _mp_ok('contexts: the audit row redacts the snapshot''s pay figures and keeps the operator''s choice',
    v_after -> 'values' -> 'planning_hourly_rate' = '{"redacted": true}'::jsonb
    AND v_after -> 'values' -> 'planning_min_salary' = '{"redacted": true}'::jsonb
    AND v_after -> 'values' ->> 'selected' = 'true'
    AND v_after ->> 'reason' = 'Ticket Monatsplan');

  -- A write into another company is refused by the audit function as well as by
  -- the policies: the session is one company's.
  PERFORM _mp_ok('contexts: a support session writes no other company''s plan',
    _mp_try(c_support, _mp_id('session:owner-support'),
      format('INSERT INTO monthly_plans (company_id, year, month, switch_minutes) VALUES (%L, 2029, 3, 30)',
             'c0000000-0000-4000-8000-00000000000b')) ~ '^ERR');
END $$;

ROLLBACK;
