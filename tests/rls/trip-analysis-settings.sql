/*
  Fahrtenanalyse settings and monthly budgets (Fahrtenbuch plan, slice C,
  migration 20260922110000).

  Runs after the files before it, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it
  see the database as the seeds left it.

  What is covered, in order:

    1. shape         both tables carry RLS, exactly the business shape's four
                     policies, the view-context refusal and the support-write
                     audit triggers; anon and the service role hold nothing;
                     the trigger functions are executable by no API role
    2. tenants       a member reads its own company's rows and never another
                     company's; nobody writes into another company or moves a
                     row there
    3. admin gate    a viewer and an editor read and write nothing; the
                     administrator writes
    4. state         a suspended company's administrator reads and writes
                     nothing, as on every business table
    5. budget        "not set" is NULL and 0 is an answer; the snapshot is
                     taken by the database on an explicit confirmation and
                     never from the client; a later salary change does not move
                     a confirmed month; a recompute and a reserve change on a
                     confirmed month are recorded; a confirmation is not taken
                     back; a budget stays with its driver, company and month;
                     another company's driver is refused
    6. view          a view context reads the company it opened and writes
                     nothing, and nothing is recorded for the refusal
    7. support       a support session writes as the company's administrator,
                     each row leaves exactly one audit row with the pay figures
                     redacted and the log recorded by size, and a write into
                     another company is refused and not recorded
    8. no context    a platform owner with no context open reads and writes
                     none of it

  The matrix lines for both tables are in tests/rls/matrix.sql.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in support-write-audit.sql) ───────────────────────────

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

CREATE OR REPLACE FUNCTION _ta_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _ta_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('ta:' || p_what)::uuid $$;

CREATE OR REPLACE FUNCTION _ta_reset() RETURNS void
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
CREATE OR REPLACE FUNCTION _ta_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _ta_reset();
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
  `ERR <sqlstate> <message>`. Nothing it writes survives, audit rows included.
*/
CREATE OR REPLACE FUNCTION _ta_try(p_user uuid, p_session uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _ta_as(p_user, p_session);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ011' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _ta_reset();
  RETURN v_out;
END $$;

/** The audit log's high-water mark, so each check counts only its own rows. */
CREATE OR REPLACE FUNCTION _ta_mark() RETURNS bigint
LANGUAGE sql AS $$ SELECT coalesce(max(l.id), 0) FROM app_private.platform_audit_log l $$;

/** Support-write rows after a mark, for one action or for all of them. */
CREATE OR REPLACE FUNCTION _ta_rows(p_since bigint, p_action text DEFAULT NULL) RETURNS bigint
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
-- context), plus:
--   - a suspended company with an administrator of its own,
--   - two company-less platform owners with a sign-in session each: one opens
--     a view context on company A, the other a support session.

CREATE TEMP TABLE _ta_who (who text PRIMARY KEY, uid uuid NOT NULL);
INSERT INTO _ta_who VALUES
  ('admin-a',  'a0000000-0000-4000-8000-000000000001'),
  ('editor-a', 'a0000000-0000-4000-8000-000000000002'),
  ('viewer-a', 'a0000000-0000-4000-8000-000000000003'),
  ('admin-b',  'b0000000-0000-4000-8000-000000000001'),
  ('super',    '50000000-0000-4000-8000-000000000001');

CREATE OR REPLACE FUNCTION _ta_u(p_who text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT coalesce((SELECT w.uid FROM _ta_who w WHERE w.who = p_who), _ta_id('user:' || p_who)) $$;

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
VALUES (_ta_id('company:suspended'), 'TA suspended', 'ta-suspended', 'approved', 'suspended', 'basic', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT _ta_id('user:' || v.who), 'ta-' || v.who || '@test.invalid', now()
FROM (VALUES ('admin-suspended'), ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
SELECT _ta_id('user:' || v.who), 'ta-' || v.who || '@test.invalid', 'TA ' || v.who, v.role,
       (SELECT r.id FROM roles r WHERE r.name = v.role AND r.company_id IS NULL),
       v.company_id, 'active'
FROM (VALUES
  ('admin-suspended', 'admin',  _ta_id('company:suspended')),
  ('owner-view',      'viewer', NULL::uuid),
  ('owner-support',   'viewer', NULL::uuid)
) AS v(who, role, company_id)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES (_ta_id('user:owner-view'),    'owner', 'ta'),
       (_ta_id('user:owner-support'), 'owner', 'ta')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
SELECT _ta_id('session:' || v.who), _ta_id('user:' || v.who)
FROM (VALUES ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

-- Drivers: seed.sql's Driver A and Driver B, a second driver in A whose budget
-- section 5 works on, and one in the suspended company. Driver A2 has the
-- figures of the plan's worked example: 1000 € ÷ 13,90 € = 71,94 h.
INSERT INTO drivers (id, company_id, name, planning_min_salary, planning_max_salary, planning_hourly_rate) VALUES
  (_ta_id('driver:a2'),        'c0000000-0000-4000-8000-00000000000a', 'TA Driver A2', 1000, 1500, 13.9),
  (_ta_id('driver:suspended'), _ta_id('company:suspended'),            'TA Driver S',  NULL, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- One settings row and one budget per company, written as the owner of the
-- tables (RLS does not apply; the triggers do).
INSERT INTO trip_analysis_settings (id, company_id, block_gap_minutes, travel_margin_minutes) VALUES
  (_ta_id('settings:a'),         'c0000000-0000-4000-8000-00000000000a', 45,   10),
  (_ta_id('settings:b'),         'c0000000-0000-4000-8000-00000000000b', 20,   NULL),
  (_ta_id('settings:suspended'), _ta_id('company:suspended'),            NULL, NULL);

INSERT INTO driver_month_budget (id, company_id, driver_id, year, month, reserved_hours) VALUES
  (_ta_id('budget:a'),         'c0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-00000000000a', 2026, 8, 10),
  (_ta_id('budget:b'),         'c0000000-0000-4000-8000-00000000000b', 'd0000000-0000-4000-8000-00000000000b', 2026, 8, NULL),
  (_ta_id('budget:suspended'), _ta_id('company:suspended'),            _ta_id('driver:suspended'),             2026, 8, NULL);

-- ─── 1. shape ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tbl   text;
  v_role  text;
  v_wrong text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['trip_analysis_settings', 'driver_month_budget'] LOOP
    PERFORM _ta_ok(format('shape: %s has row level security on', v_tbl),
      (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', v_tbl)::regclass));

    PERFORM _ta_ok(format('shape: %s carries exactly the four policies <table>_select|insert|update|delete, for authenticated', v_tbl),
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
    PERFORM _ta_ok(format('shape: every %s policy asks get_active_company_id() and nothing else [%s]', v_tbl, coalesce(v_wrong, 'none')),
      v_wrong IS NULL);

    SELECT string_agg(p.policyname::text, ', ') INTO v_wrong
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd <> 'SELECT'
       AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'is_company_admin';
    PERFORM _ta_ok(format('shape: every %s write policy asks for an administrator [%s]', v_tbl, coalesce(v_wrong, 'none')),
      v_wrong IS NULL);

    PERFORM _ta_ok(format('shape: the %s UPDATE policy states one predicate as USING and as WITH CHECK', v_tbl),
      (SELECT p.qual = p.with_check FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd = 'UPDATE'));

    PERFORM _ta_ok(format('shape: %s carries the view-context refusal, per statement', v_tbl),
      EXISTS (SELECT 1 FROM pg_trigger g
               WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                 AND g.tgname = 'refuse_read_only_context_write'
                 AND NOT g.tgisinternal AND g.tgtype = 30 AND g.tgenabled = 'O'));
    PERFORM _ta_ok(format('shape: %s carries the support-write audit, per row and gated on the flag', v_tbl),
      EXISTS (SELECT 1 FROM pg_trigger g
               WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                 AND g.tgname = 'record_support_write'
                 AND NOT g.tgisinternal AND g.tgtype = 29 AND g.tgenabled = 'O'
                 AND pg_get_triggerdef(g.oid) ~ 'app_private\.support_write_context'));

    FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
      PERFORM _ta_ok(format('privileges: %s holds nothing on %s', v_role, v_tbl),
        NOT has_table_privilege(v_role, format('public.%I', v_tbl), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
    END LOOP;
    PERFORM _ta_ok(format('privileges: authenticated holds SELECT, INSERT, UPDATE and DELETE on %s and nothing else', v_tbl),
      has_table_privilege('authenticated', format('public.%I', v_tbl), 'SELECT')
      AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'INSERT')
      AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'UPDATE')
      AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'DELETE')
      AND NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'TRUNCATE,REFERENCES,TRIGGER'));
  END LOOP;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM _ta_ok(format('privileges: %s can execute neither trigger function', v_role),
      NOT has_function_privilege(v_role, 'app_private.driver_month_budget_guard()', 'EXECUTE')
      AND NOT has_function_privilege(v_role, 'app_private.trip_analysis_settings_stamp()', 'EXECUTE'));
  END LOOP;

  PERFORM _ta_ok('privileges: anon is refused outright, not filtered',
    _ta_try(NULL, NULL, 'SELECT count(*)::text FROM trip_analysis_settings') LIKE 'ERR 42501 permission denied%'
    AND _ta_try(NULL, NULL, 'SELECT count(*)::text FROM driver_month_budget') LIKE 'ERR 42501 permission denied%');
END $$;

-- ─── 2. tenants ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  who  text;
BEGIN
  -- Impersonation proven first: a NULL uid would make every refusal below pass.
  PERFORM _ta_ok('impersonation: admin-a''s active company is company A',
    _ta_try(_ta_u('admin-a'), NULL, 'SELECT get_active_company_id()::text') = co_a::text);

  FOREACH who IN ARRAY ARRAY['viewer-a', 'editor-a', 'admin-a'] LOOP
    PERFORM _ta_ok(format('tenants: %s reads its company''s settings and budget', who),
      _ta_try(_ta_u(who), NULL, format('SELECT count(*)::text FROM trip_analysis_settings WHERE id = %L', _ta_id('settings:a'))) = '1'
      AND _ta_try(_ta_u(who), NULL, format('SELECT count(*)::text FROM driver_month_budget WHERE id = %L', _ta_id('budget:a'))) = '1');
    PERFORM _ta_ok(format('tenants: %s reads none of company B''s', who),
      _ta_try(_ta_u(who), NULL, format('SELECT count(*)::text FROM trip_analysis_settings WHERE company_id = %L', co_b)) = '0'
      AND _ta_try(_ta_u(who), NULL, format('SELECT count(*)::text FROM driver_month_budget WHERE company_id = %L', co_b)) = '0');
  END LOOP;

  PERFORM _ta_ok('tenants: admin-b reads its own and not company A''s',
    _ta_try(_ta_u('admin-b'), NULL, 'SELECT count(*)::text FROM trip_analysis_settings') = '1'
    AND _ta_try(_ta_u('admin-b'), NULL, format('SELECT count(*)::text FROM driver_month_budget WHERE company_id = %L', co_a)) = '0');

  PERFORM _ta_ok('tenants: admin-a changes and deletes nothing of company B''s — the rows are not even visible',
    _ta_try(_ta_u('admin-a'), NULL, format('UPDATE trip_analysis_settings SET block_gap_minutes = 5 WHERE id = %L', _ta_id('settings:b'))) = 'rows 0'
    AND _ta_try(_ta_u('admin-a'), NULL, format('DELETE FROM driver_month_budget WHERE id = %L', _ta_id('budget:b'))) = 'rows 0');

  PERFORM _ta_ok('tenants: admin-a inserts nothing into company B (a consistent row: B''s own driver)',
    _ta_try(_ta_u('admin-a'), NULL,
      format('INSERT INTO driver_month_budget (company_id, driver_id, year, month) VALUES (%L, %L, 2026, 9)',
             co_b, 'd0000000-0000-4000-8000-00000000000b')) LIKE 'ERR 42501%row-level security%'
    AND _ta_try(_ta_u('admin-a'), NULL,
      format('INSERT INTO trip_analysis_settings (company_id, block_gap_minutes) VALUES (%L, 30)',
             co_b)) LIKE 'ERR 42501%row-level security%');

  PERFORM _ta_ok('tenants: admin-a''s settings row cannot be moved to company B — RLS refuses the new row',
    _ta_try(_ta_u('admin-a'), NULL,
      format('UPDATE trip_analysis_settings SET company_id = %L WHERE id = %L', co_b, _ta_id('settings:a')))
      LIKE 'ERR 42501%row-level security%');

  PERFORM _ta_ok('tenants: a budget row cannot be moved at all — the guard keeps it with its company, for everyone',
    _ta_try(_ta_u('admin-a'), NULL,
      format('UPDATE driver_month_budget SET company_id = %L, driver_id = %L WHERE id = %L',
             co_b, 'd0000000-0000-4000-8000-00000000000b', _ta_id('budget:a'))) LIKE 'ERR P0001 Ein Monatsbudget bleibt%');
END $$;

-- ─── 3. the administrator gate ──────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  who  text;
BEGIN
  FOREACH who IN ARRAY ARRAY['viewer-a', 'editor-a'] LOOP
    PERFORM _ta_ok(format('admin gate: %s updates and deletes nothing', who),
      _ta_try(_ta_u(who), NULL, format('UPDATE trip_analysis_settings SET block_gap_minutes = 5 WHERE id = %L', _ta_id('settings:a'))) = 'rows 0'
      AND _ta_try(_ta_u(who), NULL, format('UPDATE trip_analysis_settings SET base_latitude = 51.2, base_longitude = 7.1 WHERE id = %L', _ta_id('settings:a'))) = 'rows 0'
      AND _ta_try(_ta_u(who), NULL, format('UPDATE driver_month_budget SET reserved_hours = 1 WHERE id = %L', _ta_id('budget:a'))) = 'rows 0'
      AND _ta_try(_ta_u(who), NULL, format('DELETE FROM driver_month_budget WHERE id = %L', _ta_id('budget:a'))) = 'rows 0'
      AND _ta_try(_ta_u(who), NULL, format('DELETE FROM trip_analysis_settings WHERE id = %L', _ta_id('settings:a'))) = 'rows 0');
    PERFORM _ta_ok(format('admin gate: %s inserts nothing', who),
      _ta_try(_ta_u(who), NULL,
        format('INSERT INTO driver_month_budget (company_id, driver_id, year, month) VALUES (%L, %L, 2026, 9)',
               co_a, _ta_id('driver:a2'))) LIKE 'ERR 42501%row-level security%');
  END LOOP;

  PERFORM _ta_ok('admin gate: the administrator updates, inserts and deletes',
    _ta_try(_ta_u('admin-a'), NULL, format('UPDATE trip_analysis_settings SET block_gap_minutes = 30 WHERE id = %L', _ta_id('settings:a'))) = 'rows 1'
    AND _ta_try(_ta_u('admin-a'), NULL,
      format('INSERT INTO driver_month_budget (company_id, driver_id, year, month) VALUES (%L, %L, 2026, 9)',
             co_a, _ta_id('driver:a2'))) = 'rows 1'
    AND _ta_try(_ta_u('admin-a'), NULL, format('DELETE FROM driver_month_budget WHERE id = %L', _ta_id('budget:a'))) = 'rows 1');
END $$;

-- ─── 4. company state ───────────────────────────────────────────────────────

DO $$
DECLARE
  u constant uuid := _ta_id('user:admin-suspended');
BEGIN
  PERFORM _ta_ok('state: impersonation — the suspended company''s admin is a member of it',
    _ta_try(u, NULL, 'SELECT get_user_company_id()::text') = _ta_id('company:suspended')::text);
  PERFORM _ta_ok('state: a suspended company''s administrator reads none of its own rows',
    _ta_try(u, NULL, 'SELECT count(*)::text FROM trip_analysis_settings') = '0'
    AND _ta_try(u, NULL, 'SELECT count(*)::text FROM driver_month_budget') = '0');
  PERFORM _ta_ok('state: …and writes none',
    _ta_try(u, NULL, format('UPDATE trip_analysis_settings SET block_gap_minutes = 30 WHERE id = %L', _ta_id('settings:suspended'))) = 'rows 0'
    AND _ta_try(u, NULL,
      format('INSERT INTO driver_month_budget (company_id, driver_id, year, month) VALUES (%L, %L, 2026, 9)',
             _ta_id('company:suspended'), _ta_id('driver:suspended'))) LIKE 'ERR 42501%row-level security%');
END $$;

-- ─── 5. the budget: not set, confirmed, recomputed on the record ────────────
--
-- Written as admin-a outside _ta_try, so each step builds on the last; read
-- back as the owner of the table.

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  id_  constant uuid := _ta_id('budget:a2');
  r    driver_month_budget%ROWTYPE;
BEGIN
  -- An insert that tries to bring its own snapshot, confirmer and log.
  PERFORM _ta_as(u_a);
  INSERT INTO driver_month_budget (id, company_id, driver_id, year, month, reserved_hours,
                                   planning_max_salary, confirmed_by, recompute_log)
  VALUES (id_, co_a, _ta_id('driver:a2'), 2026, 10, NULL, 99999, u_a, '[{"forged": true}]');
  PERFORM _ta_reset();

  SELECT * INTO r FROM driver_month_budget WHERE id = id_;
  PERFORM _ta_ok('budget: a new row is not confirmed and carries no snapshot, whatever the client sent',
    r.confirmed_at IS NULL AND r.confirmed_by IS NULL
    AND r.planning_min_salary IS NULL AND r.planning_max_salary IS NULL AND r.planning_hourly_rate IS NULL
    AND r.recompute_log = '[]'::jsonb);
  PERFORM _ta_ok('budget: the reserve is "not set" — NULL, not 0', r.reserved_hours IS NULL);
  PERFORM _ta_ok('budget: the writer is stamped by the database', r.updated_by = u_a);

  -- 0 is an answer.
  PERFORM _ta_as(u_a);
  UPDATE driver_month_budget SET reserved_hours = 0 WHERE id = id_;
  PERFORM _ta_reset();
  SELECT * INTO r FROM driver_month_budget WHERE id = id_;
  PERFORM _ta_ok('budget: a reserve of 0 is stored as 0, and an unconfirmed month logs nothing',
    r.reserved_hours = 0 AND r.recompute_log = '[]'::jsonb);

  -- Confirm: the client writes confirmed_at (any value) and a snapshot of its own.
  PERFORM _ta_as(u_a);
  UPDATE driver_month_budget
     SET confirmed_at = '2000-01-01', planning_max_salary = 1, planning_hourly_rate = 1
   WHERE id = id_;
  PERFORM _ta_reset();
  SELECT * INTO r FROM driver_month_budget WHERE id = id_;
  PERFORM _ta_ok('budget: confirming copies the driver''s figures from drivers — 1000 / 1500 / 13,9 — not the client''s',
    r.planning_min_salary = 1000 AND r.planning_max_salary = 1500 AND r.planning_hourly_rate = 13.9);
  PERFORM _ta_ok('budget: …and the database stamps who confirmed it and when',
    r.confirmed_by = u_a AND r.confirmed_at = now() AND r.recompute_log = '[]'::jsonb);

  -- The driver's pay changes afterwards: the confirmed month does not move.
  UPDATE drivers SET planning_max_salary = 1800 WHERE id = _ta_id('driver:a2');
  SELECT * INTO r FROM driver_month_budget WHERE id = id_;
  PERFORM _ta_ok('budget: a later salary change leaves the confirmed snapshot where it was',
    r.planning_max_salary = 1500);

  -- Writing the snapshot or the log directly changes nothing.
  PERFORM _ta_as(u_a);
  UPDATE driver_month_budget
     SET planning_max_salary = 1, recompute_log = '[]'::jsonb, confirmed_by = NULL
   WHERE id = id_;
  PERFORM _ta_reset();
  SELECT * INTO r FROM driver_month_budget WHERE id = id_;
  PERFORM _ta_ok('budget: the snapshot, the confirmer and the log are not the client''s to write',
    r.planning_max_salary = 1500 AND r.confirmed_by = u_a AND r.recompute_log = '[]'::jsonb);

  -- A reserve change on a confirmed month is recorded.
  PERFORM _ta_as(u_a);
  UPDATE driver_month_budget SET reserved_hours = 5 WHERE id = id_;
  PERFORM _ta_reset();
  SELECT * INTO r FROM driver_month_budget WHERE id = id_;
  PERFORM _ta_ok('budget: a reserve change on a confirmed month is recorded, with the previous value and the account',
    r.reserved_hours = 5
    AND jsonb_array_length(r.recompute_log) = 1
    AND (r.recompute_log -> 0 ->> 'kind') = 'reserve'
    AND (r.recompute_log -> 0 -> 'previous' ->> 'reserved_hours')::numeric = 0
    AND (r.recompute_log -> 0 ->> 'by') = u_a::text);

  -- An explicit recompute: the new figures, and the old ones on the record.
  PERFORM _ta_as(u_a);
  UPDATE driver_month_budget SET confirmed_at = '2001-01-01' WHERE id = id_;
  PERFORM _ta_reset();
  SELECT * INTO r FROM driver_month_budget WHERE id = id_;
  PERFORM _ta_ok('budget: a recompute takes the driver''s current figures',
    r.planning_max_salary = 1800 AND r.planning_min_salary = 1000 AND r.confirmed_by = u_a);
  PERFORM _ta_ok('budget: …and records the snapshot it replaced, who confirmed it, and who recomputed',
    jsonb_array_length(r.recompute_log) = 2
    AND (r.recompute_log -> 1 ->> 'kind') = 'recompute'
    AND (r.recompute_log -> 1 -> 'previous' ->> 'planning_max_salary')::numeric = 1500
    AND (r.recompute_log -> 1 -> 'previous' ->> 'confirmed_by') = u_a::text
    AND (r.recompute_log -> 1 ->> 'by') = u_a::text);

  PERFORM _ta_ok('budget: a confirmation is not taken back by writing NULL',
    _ta_try(u_a, NULL, format('UPDATE driver_month_budget SET confirmed_at = NULL WHERE id = %L', id_))
      LIKE 'ERR P0001 Eine Bestätigung kann nicht zurückgenommen werden%');
  PERFORM _ta_ok('budget: a budget stays with its driver and month',
    _ta_try(u_a, NULL, format('UPDATE driver_month_budget SET month = 11 WHERE id = %L', id_))
      LIKE 'ERR P0001 Ein Monatsbudget bleibt%'
    AND _ta_try(u_a, NULL, format('UPDATE driver_month_budget SET driver_id = %L WHERE id = %L',
                                  'd0000000-0000-4000-8000-00000000000a', id_))
      LIKE 'ERR P0001 Ein Monatsbudget bleibt%');
  PERFORM _ta_ok('budget: another company''s driver is refused before RLS is asked',
    _ta_try(u_a, NULL,
      format('INSERT INTO driver_month_budget (company_id, driver_id, year, month) VALUES (%L, %L, 2026, 11)',
             co_a, 'd0000000-0000-4000-8000-00000000000b')) LIKE 'ERR P0001 Der Fahrer gehört nicht%');
  PERFORM _ta_ok('budget: one row per driver and month',
    _ta_try(u_a, NULL,
      format('INSERT INTO driver_month_budget (company_id, driver_id, year, month) VALUES (%L, %L, 2026, 10)',
             co_a, _ta_id('driver:a2'))) LIKE 'ERR 23505%');
  PERFORM _ta_ok('budget: a negative reserve, and a settings threshold of 0, are refused by their constraints',
    _ta_try(u_a, NULL, format('UPDATE driver_month_budget SET reserved_hours = -1 WHERE id = %L', id_)) LIKE 'ERR 23514%'
    AND _ta_try(u_a, NULL, format('UPDATE trip_analysis_settings SET block_gap_minutes = 0 WHERE id = %L', _ta_id('settings:a'))) LIKE 'ERR 23514%');
  PERFORM _ta_ok('settings: "not set" is a value the administrator may store',
    _ta_try(u_a, NULL, format('UPDATE trip_analysis_settings SET block_gap_minutes = NULL, travel_margin_minutes = NULL WHERE id = %L',
                              _ta_id('settings:a'))) = 'rows 1');

  -- 20261008200000: the Betriebssitz. Stored by the administrator, in Germany, both coordinates or neither.
  PERFORM _ta_ok('base: the administrator stores a Betriebssitz in Germany with a radius',
    _ta_try(u_a, NULL, format('UPDATE trip_analysis_settings SET base_latitude = 51.1713, base_longitude = 7.0832, base_radius_km = 2 WHERE id = %L',
                              _ta_id('settings:a'))) = 'rows 1');
  PERFORM _ta_ok('base: a position outside Germany is refused (swapped coordinates land at sea)',
    _ta_try(u_a, NULL, format('UPDATE trip_analysis_settings SET base_latitude = 7.0832, base_longitude = 51.1713 WHERE id = %L',
                              _ta_id('settings:a'))) LIKE 'ERR 23514%');
  -- Each probe is rolled back, so the row is "not set" here: a latitude alone is half a pair.
  PERFORM _ta_ok('base: one coordinate without the other is refused',
    _ta_try(u_a, NULL, format('UPDATE trip_analysis_settings SET base_latitude = 51.2 WHERE id = %L',
                              _ta_id('settings:a'))) LIKE 'ERR 23514%');
  PERFORM _ta_ok('base: a radius of 0 is refused',
    _ta_try(u_a, NULL, format('UPDATE trip_analysis_settings SET base_radius_km = 0 WHERE id = %L',
                              _ta_id('settings:a'))) LIKE 'ERR 23514%');
  PERFORM _ta_ok('base: "not set" is a value the administrator may store',
    _ta_try(u_a, NULL, format('UPDATE trip_analysis_settings SET base_latitude = NULL, base_longitude = NULL, base_radius_km = NULL WHERE id = %L',
                              _ta_id('settings:a'))) = 'rows 1');

  -- A confirmation on insert takes the snapshot at once.
  PERFORM _ta_as(u_a);
  INSERT INTO driver_month_budget (id, company_id, driver_id, year, month, confirmed_at)
  VALUES (_ta_id('budget:a2-12'), co_a, _ta_id('driver:a2'), 2026, 12, '2000-01-01');
  PERFORM _ta_reset();
  SELECT * INTO r FROM driver_month_budget WHERE id = _ta_id('budget:a2-12');
  PERFORM _ta_ok('budget: a confirmation on insert takes the driver''s figures at once',
    r.planning_max_salary = 1800 AND r.confirmed_by = u_a AND r.confirmed_at = now());
END $$;

-- ─── 6. a view context reads and writes nothing ─────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u    constant uuid := _ta_id('user:owner-view');
  s    constant uuid := _ta_id('session:owner-view');
  v_open jsonb;
  v_mark bigint;
BEGIN
  PERFORM _ta_as(u, s);
  v_open := public.platform_context_open(co_a, 'view');
  PERFORM _ta_reset();
  PERFORM _ta_ok('view: the owner opens a view context on company A', (v_open ->> 'success') = 'true');

  PERFORM _ta_ok('view: it reads company A''s rows and none of company B''s',
    _ta_try(u, s, format('SELECT count(*)::text FROM trip_analysis_settings WHERE id = %L', _ta_id('settings:a'))) = '1'
    AND _ta_try(u, s, format('SELECT count(*)::text FROM driver_month_budget WHERE id = %L', _ta_id('budget:a'))) = '1'
    AND _ta_try(u, s, format('SELECT count(*)::text FROM trip_analysis_settings WHERE id = %L', _ta_id('settings:b'))) = '0');

  v_mark := _ta_mark();
  PERFORM _ta_ok('view: every write is refused by the statement trigger, with 3.4a''s sentence',
    _ta_try(u, s, format('UPDATE trip_analysis_settings SET block_gap_minutes = 5 WHERE id = %L', _ta_id('settings:a')))
      LIKE 'ERR P0001 Nur-Lese-Ansicht:%'
    AND _ta_try(u, s, format('UPDATE driver_month_budget SET reserved_hours = 1 WHERE id = %L', _ta_id('budget:a')))
      LIKE 'ERR P0001 Nur-Lese-Ansicht:%'
    AND _ta_try(u, s, format('INSERT INTO driver_month_budget (company_id, driver_id, year, month) VALUES (%L, %L, 2027, 1)',
                             co_a, _ta_id('driver:a2')))
      LIKE 'ERR P0001 Nur-Lese-Ansicht:%'
    AND _ta_try(u, s, format('DELETE FROM trip_analysis_settings WHERE id = %L', _ta_id('settings:a')))
      LIKE 'ERR P0001 Nur-Lese-Ansicht:%');
  PERFORM _ta_ok('view: …and nothing is recorded for the refusals', _ta_rows(v_mark) = 0);
END $$;

-- ─── 7. a support session writes, and every row is recorded ─────────────────

DO $$
DECLARE
  co_a  constant uuid  := 'c0000000-0000-4000-8000-00000000000a';
  co_b  constant uuid  := 'c0000000-0000-4000-8000-00000000000b';
  u     constant uuid  := _ta_id('user:owner-support');
  s     constant uuid  := _ta_id('session:owner-support');
  c_red constant jsonb := '{"redacted": true}';
  v_open jsonb;
  v_ctx  uuid;
  v_mark bigint;
  v_rows bigint;
  r      app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _ta_as(u, s);
  v_open := public.platform_context_open(co_a, 'support', 'Ticket Fahrtenanalyse');
  PERFORM _ta_reset();
  PERFORM _ta_ok('support: the owner opens a support session on company A with a reason',
    (v_open ->> 'success') = 'true');
  v_ctx := (v_open -> 'context' ->> 'id')::uuid;

  -- An update of the settings.
  UPDATE trip_analysis_settings SET block_gap_minutes = 45, travel_margin_minutes = 10 WHERE id = _ta_id('settings:a');
  v_mark := _ta_mark();
  PERFORM _ta_as(u, s);
  UPDATE trip_analysis_settings SET block_gap_minutes = 25 WHERE id = _ta_id('settings:a');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM _ta_reset();

  PERFORM _ta_ok('support: the session writes the settings as the company''s administrator', v_rows = 1);
  PERFORM _ta_ok('support: exactly one audit row for it', _ta_rows(v_mark) = 1);
  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _ta_ok('support: category support, the table and the operation, the company, the row',
    r.category = 'support' AND r.action = 'support_write.trip_analysis_settings.update' AND r.outcome = 'ok'
    AND r.company_id = co_a AND r.target_type = 'trip_analysis_settings' AND r.target_id = _ta_id('settings:a')::text);
  PERFORM _ta_ok('support: the actor, its role, its session, the context and its reason',
    r.actor_user_id = u AND r.actor_role = 'owner' AND r.session_id = s
    AND (r.after_value ->> 'context_id') = v_ctx::text AND (r.after_value ->> 'reason') = 'Ticket Fahrtenanalyse');
  PERFORM _ta_ok('support: the threshold in clear, before and after',
    (r.before_value -> 'values' ->> 'block_gap_minutes') = '45'
    AND (r.after_value -> 'values' ->> 'block_gap_minutes') = '25');

  -- A confirmed budget inserted in the session.
  v_mark := _ta_mark();
  PERFORM _ta_as(u, s);
  INSERT INTO driver_month_budget (id, company_id, driver_id, year, month, reserved_hours, confirmed_at)
  VALUES (_ta_id('budget:support'), co_a, _ta_id('driver:a2'), 2027, 2, 8, '2000-01-01');
  PERFORM _ta_reset();

  PERFORM _ta_ok('support: exactly one audit row for the budget', _ta_rows(v_mark, 'support_write.driver_month_budget.insert') = 1
    AND _ta_rows(v_mark) = 1);
  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _ta_ok('support: the pay figures are markers — that they were set, not to what',
    (r.after_value -> 'values' -> 'planning_min_salary') = c_red
    AND (r.after_value -> 'values' -> 'planning_max_salary') = c_red
    AND (r.after_value -> 'values' -> 'planning_hourly_rate') = c_red);
  PERFORM _ta_ok('support: the reserve in clear',
    (r.after_value -> 'values' ->> 'reserved_hours')::numeric = 8);
  PERFORM _ta_ok('support: the confirmer on the row is the platform account that confirmed',
    (SELECT b.confirmed_by FROM driver_month_budget b WHERE b.id = _ta_id('budget:support')) = u);

  -- A recompute in the session: one row, and the log recorded by its size.
  v_mark := _ta_mark();
  PERFORM _ta_as(u, s);
  UPDATE driver_month_budget SET confirmed_at = '2001-01-01' WHERE id = _ta_id('budget:support');
  PERFORM _ta_reset();
  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _ta_ok('support: a recompute leaves one audit row, with the log as a size and not a copy',
    _ta_rows(v_mark, 'support_write.driver_month_budget.update') = 1
    AND _ta_rows(v_mark) = 1
    AND (r.after_value -> 'values' -> 'recompute_log' ->> 'omitted') = 'true');

  -- Another company: not visible, not written, not recorded.
  v_mark := _ta_mark();
  PERFORM _ta_ok('support: another company''s rows are not visible and not written',
    _ta_try(u, s, format('UPDATE trip_analysis_settings SET block_gap_minutes = 5 WHERE id = %L', _ta_id('settings:b'))) = 'rows 0');
  PERFORM _ta_ok('support: an insert into another company is refused by RLS',
    _ta_try(u, s, format('INSERT INTO driver_month_budget (company_id, driver_id, year, month) VALUES (%L, %L, 2027, 3)',
                         co_b, 'd0000000-0000-4000-8000-00000000000b')) LIKE 'ERR 42501%row-level security%');
  PERFORM _ta_ok('support: …and nothing is recorded for either', _ta_rows(v_mark) = 0);
END $$;

-- ─── 8. a platform owner with no context ────────────────────────────────────

DO $$
DECLARE
  u constant uuid := '50000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _ta_ok('no context: super reads nothing of either company',
    _ta_try(u, NULL, 'SELECT count(*)::text FROM trip_analysis_settings') = '0'
    AND _ta_try(u, NULL, 'SELECT count(*)::text FROM driver_month_budget') = '0');
  PERFORM _ta_ok('no context: …and writes nothing',
    _ta_try(u, NULL, format('UPDATE trip_analysis_settings SET block_gap_minutes = 5 WHERE id = %L', _ta_id('settings:a'))) = 'rows 0'
    AND _ta_try(u, NULL,
      format('INSERT INTO trip_analysis_settings (company_id, block_gap_minutes) VALUES (%L, 30)',
             'c0000000-0000-4000-8000-00000000000a')) LIKE 'ERR 42501%row-level security%');
END $$;

DO $$ BEGIN RAISE NOTICE '── trip analysis settings: all checks passed ──'; END $$;

ROLLBACK;
