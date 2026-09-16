/*
  Plan 3.3: one policy shape, and company and user state decided by the
  database.

  Runs after the migrations and the seeds, as supabase_admin, in one transaction
  that is rolled back at the end, so the files after it see the database as the
  seeds left it.

  What is covered, in order:

    1. the helper      get_active_company_id() answers the company for a healthy
                       member and NULL for every state App.tsx refuses; the
                       trial company and an invited employee are the two
                       controls that must stay allowed
    2. business data   a blocked company and a blocked account read and write
                       nothing through the tables, whatever their role
   2b. attribution     the import and the assignment audit row carry the caller
                       who made them: a healthy company's own administrator may
                       not file either in a colleague's name
    3. the shell       …and still read the pages that explain the block: the
                       company row, its settings, the caller's own profile, the
                       role matrix, the subscription and its invoices
    4. the RPCs        the planning RPCs and the three Gehaltsquittung RPCs
                       refuse the same callers, so a SECURITY DEFINER function
                       is not a way around the state rules — and
                       redeem_activation_code, the way out of the blocked state,
                       still answers
    5. the seams       both are false since 20260917140000: neither names a
                       company, and each sits in an OR beside the tenant term,
                       so neither can confine anything
    6. staff           an owner with no open context reads none of a company's
                       business data and writes none of it, and cannot move a
                       row between companies. What an open context changes is
                       tests/rls/platform-contexts.sql's
    7. the shape       every business table asks the same helper, in every
                       command it admits

  The principals are created here rather than in seed.sql because they exist to
  be refused: every one of them would otherwise widen what the other test files
  see.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _ts_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _ts_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $$;

/** Become a signed-in user, or anon when p_user is NULL. */
CREATE OR REPLACE FUNCTION _ts_become(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _ts_reset();
  IF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
  ELSE
    PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
END $$;

/*
  Run p_sql as p_user in a subtransaction that is always rolled back, and return
  the scalar it answered, `rows N` for a statement without a result, or
  `ERR <sqlstate> <message>`.
*/
CREATE OR REPLACE FUNCTION _ts_try(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _ts_become(p_user);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ005', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ005' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _ts_reset();
  RETURN v_out;
END $$;

/** Fixed, readable-by-construction ids, as in matrix.sql. */
CREATE OR REPLACE FUNCTION _ts_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('ts:' || p_what)::uuid $$;

-- ─── principals ─────────────────────────────────────────────────────────────
--
-- One company per state the CHECK constraints allow and App.tsx refuses, plus
-- the two controls, each with an administrator, a driver and a trip of its own;
-- and, inside the healthy company, one user per account status.
--
-- The company states are transcribed from AuthContext.checkProfileAccess()
-- (company status and approval) and App.tsx's SubscriptionGuard together with
-- AuthContext.isSubscriptionActive (subscription status and expiry).

CREATE TEMP TABLE _ts_company (slug text, label text, approval_status text, status text,
                               subscription_status text, expires_at timestamptz, allowed boolean);
INSERT INTO _ts_company VALUES
  ('ok',              'approved, active, subscribed',                'approved',  'active',    'active',    NULL,                      true),
  ('trial',           'trial company with an active subscription',   'approved',  'trial',     'active',    now() + interval '30 days', true),
  ('future',          'subscription that expires tomorrow',          'approved',  'active',    'active',    now() + interval '1 day',   true),
  ('pending',         'still waiting for approval',                  'pending',   'active',    'active',    NULL,                      false),
  ('rejected',        'rejected',                                    'rejected',  'active',    'active',    NULL,                      false),
  ('approvsusp',      'approval suspended',                          'suspended', 'active',    'active',    NULL,                      false),
  ('suspended',       'suspended',                                   'approved',  'suspended', 'active',    NULL,                      false),
  ('statusinactive',  'company status inactive',                     'approved',  'inactive',  'active',    NULL,                      false),
  ('subinactive',     'subscription inactive',                       'approved',  'active',    'inactive',  NULL,                      false),
  ('subexpiredstate', 'subscription status expired',                 'approved',  'active',    'expired',   NULL,                      false),
  ('subsuspended',    'subscription suspended',                      'approved',  'active',    'suspended', NULL,                      false),
  ('subpast',         'subscription expired yesterday',              'approved',  'active',    'active',    now() - interval '1 day',   false);

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status, subscription_expires_at)
SELECT _ts_id('company:' || c.slug), 'TS ' || c.slug, 'ts-' || c.slug,
       c.approval_status, c.status, 'basic', c.subscription_status, c.expires_at
  FROM _ts_company c;

INSERT INTO company_settings (company_id, company_name)
SELECT _ts_id('company:' || c.slug), 'TS ' || c.slug FROM _ts_company c;

-- One administrator per company, and the four account statuses inside the
-- healthy one. `pending_invite` is a control: App.tsx does not block it, so
-- neither may the database, or a newly invited employee could not finish.
CREATE TEMP TABLE _ts_user (who text, label text, company_slug text, role text, status text, allowed boolean);
INSERT INTO _ts_user
SELECT 'admin-' || c.slug, 'administrator of a ' || c.label, c.slug, 'admin', 'active', c.allowed
  FROM _ts_company c;
INSERT INTO _ts_user VALUES
  ('deactivated',   'deactivated administrator of a healthy company', 'ok', 'admin',  'deactivated',    false),
  ('suspendeduser', 'suspended editor of a healthy company',          'ok', 'editor', 'suspended',      false),
  ('inactiveuser',  'inactive editor of a healthy company',           'ok', 'editor', 'inactive',       false),
  ('invited',       'invited editor of a healthy company',            'ok', 'editor', 'pending_invite', true);

INSERT INTO auth.users (id, email)
SELECT _ts_id('user:' || u.who), 'ts-' || u.who || '@test.invalid' FROM _ts_user u;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, is_super_admin, status, must_change_password)
SELECT _ts_id('user:' || u.who), 'ts-' || u.who || '@test.invalid', 'TS ' || u.who, u.role,
       (SELECT id FROM roles WHERE name = u.role AND company_id IS NULL LIMIT 1),
       _ts_id('company:' || u.company_slug), false, u.status, false
  FROM _ts_user u;

-- A driver, an import and a trip per company, so each probe has a real target.
INSERT INTO drivers (id, company_id, name)
SELECT _ts_id('driver:' || c.slug), _ts_id('company:' || c.slug), 'TS driver' FROM _ts_company c;

INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by)
SELECT _ts_id('import:' || c.slug), _ts_id('company:' || c.slug), 1, 2026, 'ts.xlsx',
       _ts_id('user:admin-' || c.slug)
  FROM _ts_company c;

-- start and end time: reassign_fahrtenbuch_trip copies both into the audit,
-- where they are NOT NULL.
INSERT INTO fahrtenbuch_trips (id, company_id, import_id, trip_date, start_time, end_time,
                               original_driver_name, assigned_driver_name)
SELECT _ts_id('trip:' || c.slug), _ts_id('company:' || c.slug), _ts_id('import:' || c.slug),
       '2026-01-05', '08:00', '09:00', 'TS', 'TS'
  FROM _ts_company c;

-- company_subscriptions.plan_id is NOT NULL, so the subscriptions need a plan
-- of their own rather than the platform's.
INSERT INTO subscription_plans (id, name, monthly_price, included_cars)
VALUES (_ts_id('plan'), 'TS plan', 20, 1);

INSERT INTO company_subscriptions (id, company_id, plan_id, monthly_price)
SELECT _ts_id('subscription:' || c.slug), _ts_id('company:' || c.slug), _ts_id('plan'), 20 FROM _ts_company c;

INSERT INTO subscription_invoices (id, company_id, subscription_id, invoice_month, invoice_year,
                                   invoice_number, amount, due_date)
SELECT _ts_id('invoice:' || c.slug), _ts_id('company:' || c.slug), _ts_id('subscription:' || c.slug),
       1, 2026, 'INV-TS-' || c.slug, 20, '2026-01-31'
  FROM _ts_company c;

-- Platform principals: the seeded owner (seed.sql), plus one of each other role
-- on company-less accounts, for the capability half of the checks.
INSERT INTO auth.users (id, email) VALUES
  (_ts_id('user:staff-support'),  'ts-staff-support@test.invalid'),
  (_ts_id('user:staff-billing'),  'ts-staff-billing@test.invalid'),
  (_ts_id('user:staff-readonly'), 'ts-staff-readonly@test.invalid');

INSERT INTO user_profiles (user_id, email, full_name, role, company_id, status) VALUES
  (_ts_id('user:staff-support'),  'ts-staff-support@test.invalid',  'TS Support',  'viewer', NULL, 'active'),
  (_ts_id('user:staff-billing'),  'ts-staff-billing@test.invalid',  'TS Billing',  'viewer', NULL, 'active'),
  (_ts_id('user:staff-readonly'), 'ts-staff-readonly@test.invalid', 'TS ReadOnly', 'viewer', NULL, 'active');

INSERT INTO app_private.platform_staff (user_id, role, note) VALUES
  (_ts_id('user:staff-support'),  'support',   'tenant-state'),
  (_ts_id('user:staff-billing'),  'billing',   'tenant-state'),
  (_ts_id('user:staff-readonly'), 'read_only', 'tenant-state');

-- A document category of its own, so the settings.manage check below updates a
-- real row instead of passing because the catalogue happens to be empty.
INSERT INTO document_categories (id, name) VALUES (_ts_id('category'), 'TS category');

-- ─── 1. the helper ──────────────────────────────────────────────────────────

DO $$
DECLARE
  u   record;
  got text;
BEGIN
  -- Prove impersonation takes before trusting a NULL: a NULL uid would make
  -- every "refused" below pass for the wrong reason.
  PERFORM _ts_ok('impersonation works — get_user_company_id() answers for a suspended company''s admin',
    _ts_try(_ts_id('user:admin-suspended'), 'SELECT get_user_company_id()::text')
      = _ts_id('company:suspended')::text);

  FOR u IN SELECT * FROM _ts_user ORDER BY who LOOP
    got := _ts_try(_ts_id('user:' || u.who), 'SELECT get_active_company_id()::text');
    PERFORM _ts_ok(format('get_active_company_id(): %s → %s',
                          u.label, CASE WHEN u.allowed THEN 'its company' ELSE 'NULL' END),
      CASE WHEN u.allowed THEN got = _ts_id('company:' || u.company_slug)::text
           ELSE got = '<null>' END);
  END LOOP;

  -- anon does not call it at all: every policy that calls it applies TO
  -- authenticated, so the grant block revoked EXECUTE from PUBLIC and anon.
  PERFORM _ts_ok('anon may not call get_active_company_id()',
    _ts_try(NULL, 'SELECT get_active_company_id()::text') LIKE 'ERR 42501%');
  PERFORM _ts_ok('get_active_company_id() is NULL for a signed-in account without a profile',
    _ts_try(_ts_id('user:nobody'), 'SELECT get_active_company_id()::text') = '<null>');
  PERFORM _ts_ok('get_active_company_id() is NULL for a platform account, which has no company',
    _ts_try('50000000-0000-4000-8000-000000000001', 'SELECT get_active_company_id()::text') = '<null>');
  PERFORM _ts_reset();
  PERFORM _ts_ok('… and holds EXECUTE on neither the helper nor either seam',
    NOT has_function_privilege('anon', 'public.get_active_company_id()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.platform_reads_company_data()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.platform_writes_company_data()', 'EXECUTE'));
  PERFORM _ts_ok('… while a signed-in caller holds EXECUTE on all three, because the policies call them as the caller',
    has_function_privilege('authenticated', 'public.get_active_company_id()', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.platform_reads_company_data()', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.platform_writes_company_data()', 'EXECUTE'));
END $$;

-- ─── 2. business data, and 3. the shell ─────────────────────────────────────

DO $$
DECLARE
  u      record;
  uid    uuid;
  co     uuid;
  drv    uuid;
  reads  text;
  writes text;
BEGIN
  FOR u IN SELECT * FROM _ts_user ORDER BY who LOOP
    uid := _ts_id('user:' || u.who);
    co  := _ts_id('company:' || u.company_slug);
    drv := _ts_id('driver:' || u.company_slug);

    reads := _ts_try(uid, format('SELECT count(*)::text FROM drivers WHERE id = %L', drv));
    PERFORM _ts_ok(format('drivers: %s %s its company''s rows', u.label,
                          CASE WHEN u.allowed THEN 'reads' ELSE 'reads none of' END),
      CASE WHEN u.allowed THEN reads = '1' ELSE reads = '0' END);

    writes := _ts_try(uid, format('INSERT INTO drivers (company_id, name) VALUES (%L, %L)', co, 'TS probe'));
    PERFORM _ts_ok(format('drivers: %s %s', u.label,
                          CASE WHEN u.allowed THEN 'inserts' ELSE 'is refused by WITH CHECK' END),
      CASE WHEN u.allowed THEN writes = 'rows 1'
           ELSE writes LIKE 'ERR 42501%row-level security%' END);

    writes := _ts_try(uid, format('UPDATE drivers SET name = name WHERE id = %L', drv));
    PERFORM _ts_ok(format('drivers: %s %s an existing row', u.label,
                          CASE WHEN u.allowed THEN 'updates' ELSE 'matches no' END),
      writes = CASE WHEN u.allowed THEN 'rows 1' ELSE 'rows 0' END);

    writes := _ts_try(uid, format('DELETE FROM drivers WHERE id = %L', drv));
    PERFORM _ts_ok(format('drivers: %s %s an existing row', u.label,
                          CASE WHEN u.allowed THEN 'deletes' ELSE 'matches no' END),
      writes = CASE WHEN u.allowed THEN 'rows 1' ELSE 'rows 0' END);

    -- The Fahrtenbuch, the planning tables and the historical tables had no
    -- tenant path of their own before this slice; now they answer like the rest.
    PERFORM _ts_ok(format('fahrtenbuch_trips: %s %s its company''s trips', u.label,
                          CASE WHEN u.allowed THEN 'reads' ELSE 'reads none of' END),
      _ts_try(uid, format('SELECT count(*)::text FROM fahrtenbuch_trips WHERE id = %L',
                          _ts_id('trip:' || u.company_slug)))
        = CASE WHEN u.allowed THEN '1' ELSE '0' END);

    -- …and the account shell stays readable whatever the state, or the page
    -- that explains the block would come up empty.
    PERFORM _ts_ok(format('shell: %s still reads its own company row', u.label),
      _ts_try(uid, format('SELECT count(*)::text FROM companies WHERE id = %L', co)) = '1');
    PERFORM _ts_ok(format('shell: %s still reads its company settings', u.label),
      _ts_try(uid, format('SELECT count(*)::text FROM company_settings WHERE company_id = %L', co)) = '1');
    PERFORM _ts_ok(format('shell: %s still reads its own profile', u.label),
      _ts_try(uid, format('SELECT count(*)::text FROM user_profiles WHERE user_id = %L', uid)) = '1');
    PERFORM _ts_ok(format('shell: %s still reads its subscription and its invoices', u.label),
      _ts_try(uid, format('SELECT count(*)::text FROM company_subscriptions WHERE company_id = %L', co)) = '1'
      AND _ts_try(uid, format('SELECT count(*)::text FROM subscription_invoices WHERE company_id = %L', co)) = '1');
    PERFORM _ts_ok(format('shell: %s still reads the role matrix', u.label),
      _ts_try(uid, 'SELECT (count(*) > 0)::text FROM role_permissions') = 'true');
  END LOOP;
END $$;

-- ─── 2b. attribution ────────────────────────────────────────────────────────
--
-- Two tables record *who* acted, and a WITH CHECK clause pinning the new row to
-- auth.uid() is the only thing enforcing it. Neither has a role gate on INSERT,
-- before this slice or after, so without that clause any member of a company
-- could file a Fahrtenbuch import — the artefact the whole payroll chain hangs
-- off — or an assignment audit row in a colleague's name.
--
-- Both probes stay inside one healthy company, so what refuses the first is
-- attribution and not tenancy. matrix.sql cannot see this: its INSERT probes
-- supply the caller's own id, so the cell reads the same either way.

DO $$
DECLARE
  admin_ok constant uuid := _ts_id('user:admin-ok');
  other    constant uuid := _ts_id('user:invited');  -- same company, real profile row
  co_ok    constant uuid := _ts_id('company:ok');
  trip_ok  constant uuid := _ts_id('trip:ok');
BEGIN
  PERFORM _ts_ok('attribution: an administrator may not file an import in a colleague''s name',
    _ts_try(admin_ok, format(
      $q$INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by)
         VALUES (%L, 3, 2026, 'ts-attribution.xlsx', %L)$q$, co_ok, other))
      LIKE 'ERR 42501%row-level security%');
  PERFORM _ts_ok('attribution: … and files the very same import under its own id',
    _ts_try(admin_ok, format(
      $q$INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by)
         VALUES (%L, 3, 2026, 'ts-attribution.xlsx', %L)$q$, co_ok, admin_ok))
      = 'rows 1');

  PERFORM _ts_ok('attribution: an administrator may not file an assignment audit row in a colleague''s name',
    _ts_try(admin_ok, format(
      $q$INSERT INTO fahrtenbuch_assignment_audit (company_id, trip_id, trip_date, start_time, end_time,
                                                   price_amount, original_driver_name,
                                                   new_assigned_driver_name, changed_by)
         VALUES (%L, %L, '2026-01-05', '08:00', '09:00', 0, 'TS', 'TS', %L)$q$, co_ok, trip_ok, other))
      LIKE 'ERR 42501%row-level security%');
  PERFORM _ts_ok('attribution: … and writes the very same row under its own id',
    _ts_try(admin_ok, format(
      $q$INSERT INTO fahrtenbuch_assignment_audit (company_id, trip_id, trip_date, start_time, end_time,
                                                   price_amount, original_driver_name,
                                                   new_assigned_driver_name, changed_by)
         VALUES (%L, %L, '2026-01-05', '08:00', '09:00', 0, 'TS', 'TS', %L)$q$, co_ok, trip_ok, admin_ok))
      = 'rows 1');
END $$;

-- ─── 4. the planning and Gehaltsquittung RPCs ───────────────────────────────
-- SECURITY DEFINER functions run past RLS, so the state rules have to hold
-- inside them too, or a suspended company would still reassign its trips — and,
-- through the Gehaltsquittung RPCs, still pay a salary in cash.

DO $$
DECLARE
  u   record;
  got text;
BEGIN
  FOR u IN SELECT * FROM _ts_user ORDER BY who LOOP
    got := _ts_try(_ts_id('user:' || u.who),
                   format('SELECT reassign_fahrtenbuch_trip(%L, %L, %L)::text',
                          _ts_id('trip:' || u.company_slug), _ts_id('driver:' || u.company_slug), 'TS'));
    PERFORM _ts_ok(format('reassign_fahrtenbuch_trip: %s %s', u.label,
                          CASE WHEN u.allowed THEN 'reassigns its own trip' ELSE 'is refused' END),
      CASE WHEN u.allowed THEN got NOT LIKE 'ERR %'
           ELSE got LIKE 'ERR P0001%caller has no company%' END);
  END LOOP;

  PERFORM _ts_ok('apply_monthly_planning_run: a suspended company''s admin is refused',
    _ts_try(_ts_id('user:admin-suspended'),
            format($q$SELECT apply_monthly_planning_run(jsonb_build_object(
                        'import_id', %L, 'month', 1, 'year', 2026,
                        'change_rows', jsonb_build_array()))::text$q$,
                   _ts_id('import:suspended')))
      LIKE 'ERR P0001%caller has no company%');
  -- The control: the same call by a healthy company's administrator is not
  -- refused for state. What it answers past that point is the planning
  -- pipeline's business, not this file's.
  PERFORM _ts_ok('apply_monthly_planning_run: the healthy company''s admin is not refused for state',
    _ts_try(_ts_id('user:admin-ok'),
            format($q$SELECT apply_monthly_planning_run(jsonb_build_object(
                        'import_id', %L, 'month', 1, 'year', 2026,
                        'change_rows', jsonb_build_array()))::text$q$,
                   _ts_id('import:ok')))
      NOT LIKE 'ERR P0001%caller has no company%');
END $$;

/*
  The Gehaltsquittung RPCs, the one other door a SECURITY DEFINER function opens
  for a write — and the one that moves money: a confirmation writes a gapless GQ
  receipt, a salary_payments row and an outgoing cash_movements row. Until
  20260917130000 they read get_user_company_id(), and their only other guard was
  current_role_permits('salaries', true), which reads the role matrix and
  nothing about state — so a blocked account or company paid a salary in cash
  with the token it already held, and voided receipts the same way.

  A refused caller gets 42501 (HINT not_authorized). The control is a healthy
  administrator, who passes the guard and is then refused by the business rule
  for the salary or the receipt that does not exist (P0002) — which is the only
  way to tell "refused for state" from "refused for everything".
*/

DO $$
DECLARE
  u       record;
  got     text;
  absent  constant uuid := _ts_id('absent');   -- no salary and no receipt has it
BEGIN
  FOR u IN SELECT * FROM _ts_user ORDER BY who LOOP
    got := _ts_try(_ts_id('user:' || u.who),
                   format('SELECT confirm_salary_cash_payment(%L, %L, 10.00, %L, %L)::text',
                          gen_random_uuid(), absent, current_date, 'Berlin'));
    PERFORM _ts_ok(format('confirm_salary_cash_payment: %s %s', u.label,
                          CASE WHEN u.allowed THEN 'gets past the state guard'
                               ELSE 'is refused' END),
      CASE WHEN u.allowed THEN got LIKE 'ERR P0002%'
           ELSE got LIKE 'ERR 42501%' END);
  END LOOP;

  PERFORM _ts_ok('void_salary_cash_receipt: a suspended company''s admin is refused',
    _ts_try(_ts_id('user:admin-suspended'),
            format('SELECT void_salary_cash_receipt(%L, %L)::text', absent, 'TS'))
      LIKE 'ERR 42501%');
  PERFORM _ts_ok('void_salary_cash_receipt: a deactivated administrator is refused',
    _ts_try(_ts_id('user:deactivated'),
            format('SELECT void_salary_cash_receipt(%L, %L)::text', absent, 'TS'))
      LIKE 'ERR 42501%');
  PERFORM _ts_ok('void_salary_cash_receipt: the healthy company''s admin gets past the state guard',
    _ts_try(_ts_id('user:admin-ok'),
            format('SELECT void_salary_cash_receipt(%L, %L)::text', absent, 'TS'))
      LIKE 'ERR P0002%');

  PERFORM _ts_ok('attach_salary_cash_receipt_signed_copy: a suspended company''s admin is refused',
    _ts_try(_ts_id('user:admin-suspended'),
            format('SELECT attach_salary_cash_receipt_signed_copy(%L, %L)::text', absent,
                   _ts_id('company:suspended')::text || '/gq.pdf'))
      LIKE 'ERR 42501%');
  PERFORM _ts_ok('attach_salary_cash_receipt_signed_copy: the healthy company''s admin gets past the state guard',
    _ts_try(_ts_id('user:admin-ok'),
            format('SELECT attach_salary_cash_receipt_signed_copy(%L, %L)::text', absent,
                   _ts_id('company:ok')::text || '/gq.pdf'))
      LIKE 'ERR P0002%');

  -- The way out stays open. redeem_activation_code is how a company whose
  -- subscription lapsed comes back, so it reads the caller's membership and not
  -- the active helper, which would answer NULL for exactly that caller. It
  -- answers rather than refusing: the code below is not six digits, so what
  -- comes back is its own JSON, from past the company check.
  PERFORM _ts_ok('redeem_activation_code: a suspended company''s admin is still let in to redeem a code',
    _ts_try(_ts_id('user:admin-suspended'), 'SELECT redeem_activation_code(''NOPE'')::text')
      LIKE '%Aktivierungscode%');
  PERFORM _ts_ok('redeem_activation_code: … and a subscription that expired yesterday, the case it exists for',
    _ts_try(_ts_id('user:admin-subpast'), 'SELECT redeem_activation_code(''NOPE'')::text')
      LIKE '%Aktivierungscode%');
END $$;

-- ─── 5. the seams, and 6. platform staff ────────────────────────────────────

DO $$
DECLARE
  owner_u   constant uuid := '50000000-0000-4000-8000-000000000001';  -- seed.sql
  support   constant uuid := _ts_id('user:staff-support');
  billing   constant uuid := _ts_id('user:staff-billing');
  readonly  constant uuid := _ts_id('user:staff-readonly');
  co_ok     constant uuid := _ts_id('company:ok');
  drv_ok    constant uuid := _ts_id('driver:ok');
BEGIN
  -- Both seams are constants since 20260917140000 (plan 3.4): neither takes a
  -- company, and each sits in an OR beside the tenant term, so a true in either
  -- would open every company at once. What a staff account may reach is the
  -- company its open context names, answered by get_active_company_id();
  -- tests/rls/platform-contexts.sql takes that through every mode and every way
  -- a context ends.
  PERFORM _ts_ok('seam: platform_writes_company_data() is false — a support session writes through the tenant term, not through this branch',
    _ts_try(owner_u, 'SELECT platform_writes_company_data()::text') = 'false'
    AND _ts_try(support, 'SELECT platform_writes_company_data()::text') = 'false');
  PERFORM _ts_ok('seam: platform_reads_company_data() is false for every staff role, business.read included',
    _ts_try(owner_u,  'SELECT platform_reads_company_data()::text') = 'false'
    AND _ts_try(support,  'SELECT platform_reads_company_data()::text') = 'false'
    AND _ts_try(readonly, 'SELECT platform_reads_company_data()::text') = 'false'
    AND _ts_try(billing,  'SELECT platform_reads_company_data()::text') = 'false');
  PERFORM _ts_ok('seam: a company user holds neither',
    _ts_try('a0000000-0000-4000-8000-000000000001', 'SELECT platform_reads_company_data()::text') = 'false'
    AND _ts_try('a0000000-0000-4000-8000-000000000001', 'SELECT platform_writes_company_data()::text') = 'false');

  -- Reading is now the context's too: none of these principals has opened one,
  -- and _ts_become carries no session claim, so an owner reads a company's
  -- operational data exactly as anon does.
  PERFORM _ts_ok('staff: an owner with no open context reads neither a company''s drivers nor its Fahrtenbuch',
    _ts_try(owner_u, format('SELECT count(*)::text FROM drivers WHERE id = %L', drv_ok)) = '0'
    AND _ts_try(owner_u, format('SELECT count(*)::text FROM fahrtenbuch_trips WHERE id = %L', _ts_id('trip:ok'))) = '0');
  PERFORM _ts_ok('staff: billing holds no business.read, so it reads no company''s drivers',
    _ts_try(billing, format('SELECT count(*)::text FROM drivers WHERE id = %L', drv_ok)) = '0');

  -- Writing is what this slice closes.
  PERFORM _ts_ok('staff: an owner cannot insert a driver into a company',
    _ts_try(owner_u, format('INSERT INTO drivers (company_id, name) VALUES (%L, %L)', co_ok, 'TS staff'))
      LIKE 'ERR 42501%row-level security%');
  PERFORM _ts_ok('staff: an owner cannot update or delete a company''s driver',
    _ts_try(owner_u, format('UPDATE drivers SET name = name WHERE id = %L', drv_ok)) = 'rows 0'
    AND _ts_try(owner_u, format('DELETE FROM drivers WHERE id = %L', drv_ok)) = 'rows 0');
  PERFORM _ts_ok('staff: an owner cannot move a driver into another company',
    _ts_try(owner_u, format('UPDATE drivers SET company_id = %L WHERE id = %L',
                            _ts_id('company:trial'), drv_ok)) = 'rows 0');
  PERFORM _ts_ok('staff: an owner writes none of a company''s business data — not its receipts, not its salaries',
    _ts_try(owner_u, format('INSERT INTO receipts (company_id, receipt_number, date, description, driver_name) VALUES (%L, %L, current_date, %L, %L)',
                            co_ok, 'BEL-TS-1', 'ts', 'TS')) LIKE 'ERR 42501%'
    AND _ts_try(owner_u, format('INSERT INTO salaries (driver_id, period_start, period_end, created_by, company_id) VALUES (%L, %L, %L, %L, %L)',
                                drv_ok, '2026-05-01', '2026-05-31', owner_u, co_ok)) LIKE 'ERR 42501%');
  -- company_settings is the account shell, not business data: it carries the
  -- company's legal details, and changing them is a lifecycle act an owner
  -- performs today. That branch asks companies.lifecycle, so support, billing
  -- and read_only do not have it.
  PERFORM _ts_ok('shell: an owner still writes a company''s settings (companies.lifecycle), support does not',
    _ts_try(owner_u, format('UPDATE company_settings SET company_name = %L WHERE company_id = %L', 'TS', co_ok)) = 'rows 1'
    AND _ts_try(support, format('UPDATE company_settings SET company_name = %L WHERE company_id = %L', 'TS', co_ok)) = 'rows 0');

  -- The capability half: the platform tables now ask what the act is, not
  -- whether the caller is staff at all.
  PERFORM _ts_ok('capabilities: read_only cannot update a company, an owner can',
    _ts_try(readonly, format('UPDATE companies SET name = name WHERE id = %L', co_ok)) = 'rows 0'
    AND _ts_try(owner_u, format('UPDATE companies SET name = name WHERE id = %L', co_ok)) = 'rows 1');
  PERFORM _ts_ok('capabilities: support cannot delete a company (companies.hard_delete is the owner''s)',
    _ts_try(support, format('DELETE FROM companies WHERE id = %L', _ts_id('company:rejected'))) = 'rows 0');
  PERFORM _ts_ok('capabilities: read_only cannot write a subscription or an invoice, billing can',
    _ts_try(readonly, format('UPDATE company_subscriptions SET monthly_price = monthly_price WHERE company_id = %L', co_ok)) = 'rows 0'
    AND _ts_try(billing, format('UPDATE company_subscriptions SET monthly_price = monthly_price WHERE company_id = %L', co_ok)) = 'rows 1');
  PERFORM _ts_ok('capabilities: support cannot change the price list (pricing.manage is billing''s and the owner''s)',
    _ts_try(support, 'UPDATE subscription_plans SET name = name') = 'rows 0'
    AND _ts_try(billing, 'UPDATE subscription_plans SET name = name') <> 'rows 0');
  PERFORM _ts_ok('capabilities: billing cannot change the document categories (settings.manage is the owner''s), and an owner can',
    _ts_try(billing, format('UPDATE document_categories SET name = name WHERE id = %L', _ts_id('category'))) = 'rows 0'
    AND _ts_try(owner_u, format('UPDATE document_categories SET name = name WHERE id = %L', _ts_id('category'))) = 'rows 1');
  PERFORM _ts_ok('capabilities: support manages a company''s users, billing does not',
    _ts_try(support, format('UPDATE user_profiles SET full_name = full_name WHERE user_id = %L',
                            _ts_id('user:admin-ok'))) = 'rows 1'
    AND _ts_try(billing, format('UPDATE user_profiles SET full_name = full_name WHERE user_id = %L',
                                _ts_id('user:admin-ok'))) = 'rows 0');
END $$;

-- ─── 7. the shape ───────────────────────────────────────────────────────────
-- Stated as a rule rather than as a list: a table added later that copies one
-- of the old shapes fails here.

DO $$
DECLARE
  v_wrong text;
BEGIN
  PERFORM _ts_reset();

  SELECT string_agg(format('%s "%s"', p.tablename, p.policyname), ', ' ORDER BY p.tablename, p.policyname)
    INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname IN ('public', 'storage')
     AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'is_user_super_admin';
  PERFORM _ts_ok(format('shape: no policy decides by is_user_super_admin() any more [%s]', coalesce(v_wrong, 'none')),
    v_wrong IS NULL);

  -- One indirection deeper, which is where the term actually survived:
  -- current_role_permits() began with `is_user_super_admin() OR …` and gates
  -- ten business tables, so the check above was true of the policy text and
  -- false of what the policy evaluates. 20260917130000 rewrote that body.
  SELECT string_agg(DISTINCT f.proname::text, ', ')
    INTO v_wrong
    FROM (
      SELECT (regexp_matches(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''),
                             '([a-z_][a-z0-9_]*)\s*\(', 'g'))[1] AS name
        FROM pg_policies p
       WHERE p.schemaname IN ('public', 'storage')
    ) c
    JOIN pg_proc f      ON f.proname = c.name
    JOIN pg_namespace n ON n.oid = f.pronamespace
   WHERE n.nspname = 'public'
     AND f.prosrc ~ 'is_user_super_admin';
  PERFORM _ts_ok(format('shape: no function a policy calls reads is_user_super_admin() either [%s]',
                        coalesce(v_wrong, 'none')),
    v_wrong IS NULL);

  -- The seams are SECURITY INVOKER wrappers around platform_can(), which the
  -- service role may not execute: a grant would hand it a call that raises.
  PERFORM _ts_ok('shape: the service role holds EXECUTE on neither seam',
    NOT has_function_privilege('service_role', 'public.platform_reads_company_data()', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'public.platform_writes_company_data()', 'EXECUTE'));

  -- The four old tenant shapes, gone from the business tables: a policy that
  -- reaches user_profiles for the caller's company instead of asking the helper.
  SELECT string_agg(format('%s "%s"', p.tablename, p.policyname), ', ' ORDER BY p.tablename, p.policyname)
    INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename IN ('receipts','income','drivers','cars','fixed_costs','salaries','salary_payments',
                         'werkstatt_checks','driver_notes','documents','car_driver_assignments',
                         'cash_transactions','document_templates','company_planning_runs',
                         'company_planning_run_blocks','monthly_planning_manual_exceptions',
                         'planning_finalizations','planning_run_adjustments','historical_reconciliations',
                         'historical_block_adjustments','historical_driver_hour_targets',
                         'historical_payroll_targets','historical_time_adjustments',
                         'historical_wh_saved_plans','saved_stundennachweise','fahrtenbuch_imports',
                         'fahrtenbuch_trips','fahrtenbuch_assignment_audit','notification_settings',
                         'cash_movements','salary_cash_receipts','document_blocks','document_variables',
                         'historical_reconciliation_drivers','historical_reconciliation_results',
                         'historical_reconciliation_wh_drivers')
     AND ((coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'user_profiles'
          OR (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'get_active_company_id');
  PERFORM _ts_ok(format('shape: every business policy asks get_active_company_id() and nothing else [%s]',
                        coalesce(v_wrong, 'none')),
    v_wrong IS NULL);

  PERFORM _ts_ok('shape: fahrtenbuch_trips still has no UPDATE policy — trips are written by RPC',
    NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'fahrtenbuch_trips' AND cmd = 'UPDATE'));
END $$;

ROLLBACK;
