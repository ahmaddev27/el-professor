/*
  Platform read models (plan 3.6b, first part, migration 20260916140000): the
  five audited list functions platform staff call across companies.

  Runs after platform-authority.sql, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it
  see the database as the seeds left it.

  What is covered, in order:

    1. privileges   authenticated alone holds EXECUTE; anon and the service
                    role hold none, and the app_private halves are unreachable.
                    Each public function is SECURITY DEFINER, VOLATILE (so
                    PostgREST calls it with POST) and pins its search_path
    2. role x fn    companies.read for the company list, business.read for the
                    three directories, audit.read for the whole log. A disabled
                    row, the profile flag alone and a company admin get
                    not_authorized, never data and never an exception
    3. audit        exactly one row per call, category read, action
                    platform_read.<fn>, actor and role from the JWT; a refusal
                    by staff is a `denied` row; a refusal of an account without
                    a staff role writes nothing; a broken argument writes
                    nothing at all
    4. arguments    the page maximum (1..100), the offset ceiling (0..10000),
                    the sort whitelist, the trial whitelist, the token and
                    search shapes, and the audit cursor's pair rule
    5. columns      every item carries exactly the documented keys — the data
                    protection list of the migration header — and none of the
                    salary, bank, personal or platform columns
    6. figures      the company row's counts and invoice figures follow the
                    screens they come from
    7. paging       total is the whole filtered set, items are the page, and
                    two pages of the same list do not overlap. The audit list
                    pages by its (occurred_at, id) cursor
    8. scope        audit.read reads every actor's rows; any other active role
                    reads its own, and naming another actor is a refusal
    9. namespace    platform_audit_record refuses the platform_read. namespace
                    the database writes itself
   10. plans        EXPLAIN ANALYZE of each statement on seeded data: no scan
                    of fahrtenbuch_trips or receipts, and one scan per table
                    for the company figures rather than one per company row
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in platform-authority.sql) ────────────────────────────

-- The fixture is --schema=public, so auth.users carries only what the foreign
-- keys needed. platform_users_list reads two GoTrue columns.
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sign_in_at    timestamptz,
  ADD COLUMN IF NOT EXISTS banned_until       timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at         timestamptz,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT now();

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _rm_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

/** Back to the connecting superuser with no JWT claims at all. */
CREATE OR REPLACE FUNCTION _rm_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

/** Become a principal: a user id (authenticated), NULL (anon), or the service role. */
CREATE OR REPLACE FUNCTION _rm_become(p_user uuid, p_service boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _rm_reset();
  IF p_service THEN
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
  ELSIF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
  ELSE
    PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    -- A password sign-in: since 20260919130000 a platform capability needs one.
    PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
END $$;

/**
  Runs p_sql as the principal inside a subtransaction that is always rolled
  back — audit rows included — and returns the scalar it produced or
  `ERR <sqlstate> <message>`.
*/
CREATE OR REPLACE FUNCTION _rm_try(p_user uuid, p_sql text, p_service boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _rm_become(p_user, p_service);
    EXECUTE p_sql INTO v_out;
    RAISE EXCEPTION USING ERRCODE = 'ZZ005', MESSAGE = coalesce(v_out, '<null>');
  EXCEPTION
    WHEN SQLSTATE 'ZZ005' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _rm_reset();
  RETURN v_out;
END $$;

/** Like _rm_try, but keeps what the statement wrote: the audit row is the point. */
CREATE OR REPLACE FUNCTION _rm_do(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _rm_become(p_user);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _rm_reset();
  RETURN v_out;
END $$;

/** _rm_do for a function that must answer, not raise. */
CREATE OR REPLACE FUNCTION _rm_json(p_user uuid, p_sql text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_out text := _rm_do(p_user, p_sql);
BEGIN
  IF left(v_out, 4) = 'ERR ' OR v_out = '<null>' THEN
    RAISE EXCEPTION 'FAIL: % answered %', p_sql, v_out;
  END IF;
  RETURN v_out::jsonb;
END $$;

CREATE OR REPLACE FUNCTION _rm_audit_count() RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM app_private.platform_audit_log $$;

/** The keys of one returned item, sorted: the data protection list. */
CREATE OR REPLACE FUNCTION _rm_keys(p_item jsonb) RETURNS text[]
LANGUAGE sql AS $$ SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_item) k $$;

/**
  The plan of one read model's statement, run with the values its function
  passes for an unfiltered first page. EXPLAIN ANALYZE, so what is measured is
  the plan that actually ran, not one the planner might have chosen.
*/
CREATE OR REPLACE FUNCTION _rm_plan(p_which text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_plan text := '';
  r      record;
BEGIN
  IF p_which = 'companies' THEN
    FOR r IN EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) '
                     || app_private.platform_companies_list_statement()
             USING NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
                   false, 'created_at_desc'::text, 50, 0
    LOOP v_plan := v_plan || r."QUERY PLAN" || E'\n'; END LOOP;
  ELSIF p_which = 'vehicles' THEN
    FOR r IN EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) '
                     || app_private.platform_vehicles_list_statement()
             USING NULL::uuid, NULL::text, NULL::text, 'kennzeichen_asc'::text, 50, 0
    LOOP v_plan := v_plan || r."QUERY PLAN" || E'\n'; END LOOP;
  ELSIF p_which = 'drivers' THEN
    FOR r IN EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) '
                     || app_private.platform_drivers_list_statement()
             USING NULL::uuid, NULL::text, NULL::text, 'name_asc'::text, 50, 0
    LOOP v_plan := v_plan || r."QUERY PLAN" || E'\n'; END LOOP;
  ELSIF p_which = 'users' THEN
    FOR r IN EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) '
                     || app_private.platform_users_list_statement()
             USING NULL::uuid, NULL::text, NULL::text, 'created_at_desc'::text, 50, 0
    LOOP v_plan := v_plan || r."QUERY PLAN" || E'\n'; END LOOP;
  ELSE
    RAISE EXCEPTION 'unknown read-model statement %', p_which;
  END IF;
  RETURN v_plan;
END $$;

/**
  How many nodes of a plan scan one table. The schema is optional because
  EXPLAIN prints it only for a relation outside the search_path (auth.users),
  and \M keeps `users` from matching `user_profiles`.
*/
CREATE OR REPLACE FUNCTION _rm_scans(p_plan text, p_table text) RETURNS integer
LANGUAGE sql AS $$
  SELECT regexp_count(p_plan, ' on ([a-z_]+\.)?' || p_table || '\M')
$$;

-- ─── principals ─────────────────────────────────────────────────────────────

/*
    3b..01 rm-owner      owner
    3b..02 rm-support    support
    3b..03 rm-billing    billing
    3b..04 rm-readonly   read_only
    3b..05 rm-disabled   support, disabled
    3b..06 rm-member     editor in company A: a company user the list shows
    3b..07 rm-staff-in-a support, whose profile still sits in company A: a
                         company user the list must NOT show
*/
INSERT INTO auth.users (id, email, email_confirmed_at, last_sign_in_at, created_at) VALUES
  ('3b000000-0000-4000-8000-000000000001', 'rm-owner@test.invalid',      now(), now() - interval '2 hours', now() - interval '60 days'),
  ('3b000000-0000-4000-8000-000000000002', 'rm-support@test.invalid',    now(), now() - interval '3 hours', now() - interval '60 days'),
  ('3b000000-0000-4000-8000-000000000003', 'rm-billing@test.invalid',    now(), NULL,                       now() - interval '60 days'),
  ('3b000000-0000-4000-8000-000000000004', 'rm-readonly@test.invalid',   now(), NULL,                       now() - interval '60 days'),
  ('3b000000-0000-4000-8000-000000000005', 'rm-disabled@test.invalid',   now(), NULL,                       now() - interval '60 days'),
  ('3b000000-0000-4000-8000-000000000006', 'rm-member@test.invalid',     now(), now() - interval '1 day',   now() - interval '30 days'),
  ('3b000000-0000-4000-8000-000000000007', 'rm-staff-in-a@test.invalid', now(), NULL,                       now() - interval '30 days');

INSERT INTO app_private.platform_staff (user_id, role, disabled_at, note) VALUES
  ('3b000000-0000-4000-8000-000000000001', 'owner',     NULL,  'rm'),
  ('3b000000-0000-4000-8000-000000000002', 'support',   NULL,  'rm'),
  ('3b000000-0000-4000-8000-000000000003', 'billing',   NULL,  'rm'),
  ('3b000000-0000-4000-8000-000000000004', 'read_only', NULL,  'rm'),
  ('3b000000-0000-4000-8000-000000000005', 'support',   now(), 'rm'),
  ('3b000000-0000-4000-8000-000000000007', 'support',   NULL,  'rm');

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status, invited_at, activated_at) VALUES
  ('3b000000-0000-4000-8000-000000000001', 'rm-owner@test.invalid',    'RM Owner',    'admin',  NULL, NULL, 'active', NULL, NULL),
  ('3b000000-0000-4000-8000-000000000002', 'rm-support@test.invalid',  'RM Support',  'admin',  NULL, NULL, 'active', NULL, NULL),
  ('3b000000-0000-4000-8000-000000000003', 'rm-billing@test.invalid',  'RM Billing',  'admin',  NULL, NULL, 'active', NULL, NULL),
  ('3b000000-0000-4000-8000-000000000004', 'rm-readonly@test.invalid', 'RM Read',     'admin',  NULL, NULL, 'active', NULL, NULL),
  ('3b000000-0000-4000-8000-000000000005', 'rm-disabled@test.invalid', 'RM Disabled', 'admin',  NULL, NULL, 'active', NULL, NULL),
  ('3b000000-0000-4000-8000-000000000006', 'rm-member@test.invalid',   'RM Member',   'editor',
     (SELECT id FROM roles WHERE name = 'editor' AND company_id IS NULL LIMIT 1),
     'c0000000-0000-4000-8000-00000000000a', 'active', now() - interval '31 days', now() - interval '30 days'),
  ('3b000000-0000-4000-8000-000000000007', 'rm-staff-in-a@test.invalid', 'RM Staff in A', 'editor',
     (SELECT id FROM roles WHERE name = 'editor' AND company_id IS NULL LIMIT 1),
     'c0000000-0000-4000-8000-00000000000a', 'active', NULL, NULL);

-- ─── the data the figures are read from ─────────────────────────────────────

-- Two more companies, so the trial states and the search have something to
-- find. Company A (seeded) is 'active', company B 'active'.
INSERT INTO companies (id, name, slug, status, approval_status, plan, billing_cycle,
                       subscription_status, subscription_car_limit, trial_start, trial_end, created_at) VALUES
  ('cb000000-0000-4000-8000-000000000001', 'RM Trial läuft',    'rm-trial-running', 'trial', 'approved', 'advanced', 'monthly',
   'inactive', 5, now() - interval '9 days',  now() + interval '5 days', now() - interval '9 days'),
  ('cb000000-0000-4000-8000-000000000002', 'RM Trial vorbei',   'rm-trial-expired', 'trial', 'pending',  'basic',    'monthly',
   'inactive', 5, now() - interval '30 days', now() - interval '5 days', now() - interval '30 days'),
  ('cb000000-0000-4000-8000-000000000003', 'RM Prozent 100%',   'rm-prozent',       'active', 'approved', 'premium', 'yearly',
   'active',   5, NULL, NULL, now() - interval '3 days');

INSERT INTO company_settings (company_id, company_name) VALUES
  ('cb000000-0000-4000-8000-000000000001', 'RM Trial läuft'),
  ('cb000000-0000-4000-8000-000000000002', 'RM Trial vorbei'),
  ('cb000000-0000-4000-8000-000000000003', 'RM Prozent 100%')
ON CONFLICT (company_id) DO NOTHING;

-- Vehicles: two active and one inactive in A, one active in B. created_by has
-- no foreign key; the trigger only counts rows that are not 'inactive'.
INSERT INTO cars (id, kennzeichen, created_by, company_id, status, tuev_gueltig_bis, letzte_hu, created_at) VALUES
  ('cc000000-0000-4000-8000-000000000001', 'RM-AA 1', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'active',   current_date + 30, current_date - 300, now() - interval '20 days'),
  ('cc000000-0000-4000-8000-000000000002', 'RM-AA 2', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'active',   current_date + 60, NULL,               now() - interval '10 days'),
  ('cc000000-0000-4000-8000-000000000003', 'RM-AA 3', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'inactive', NULL,              NULL,               now() - interval '5 days'),
  ('cc000000-0000-4000-8000-000000000004', 'RM-BB 1', 'b0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000b', 'active',   current_date + 10, NULL,               now() - interval '2 days');

-- Drivers: the seed already put one active driver in each company.
INSERT INTO drivers (id, company_id, name, status, driver_usage_type, created_at) VALUES
  ('cd000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'RM Fahrer Aktiv',   'active',   'regular',       now() - interval '15 days'),
  ('cd000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000a', 'RM Fahrer Inaktiv', 'inactive', 'coverage_only', now() - interval '14 days');

-- The invoice figures need a subscription to hang off.
INSERT INTO subscription_plans (id, name, monthly_price, included_cars)
VALUES ('cf000000-0000-4000-8000-000000000001', 'RM Plan', 49, 5);

INSERT INTO company_subscriptions (id, company_id, plan_id, monthly_price) VALUES
  ('c1000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-00000000000a', 'cf000000-0000-4000-8000-000000000001', 49),
  ('c1000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-00000000000b', 'cf000000-0000-4000-8000-000000000001', 49);

/*
  Company A: two 'open' (one of them past its due date), one 'overdue', two
  'paid' and one 'canceled'. So open = 2, overdue = 2 (the past-due open one
  plus the 'overdue' one, which is how the billing page and the badge count
  them), and the last payment is the newer paid_at. Company B: one open
  invoice, not yet due, never paid.
*/
INSERT INTO subscription_invoices (id, company_id, subscription_id, invoice_month, invoice_year,
                                   invoice_number, amount, status, due_date, paid_at) VALUES
  ('ce000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-00000000000a', 9, 2026, 'RM-2026-0001', 49, 'open',     current_date + 10, NULL),
  ('ce000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-00000000000a', 8, 2026, 'RM-2026-0002', 49, 'open',     current_date - 10, NULL),
  ('ce000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-00000000000a', 7, 2026, 'RM-2026-0003', 49, 'overdue',  current_date - 40, NULL),
  ('ce000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-00000000000a', 6, 2026, 'RM-2026-0004', 49, 'paid',     current_date - 70, now() - interval '1 day'),
  ('ce000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-00000000000a', 5, 2026, 'RM-2026-0005', 49, 'paid',     current_date - 100, now() - interval '10 days'),
  ('ce000000-0000-4000-8000-000000000006', 'c0000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-00000000000a', 4, 2026, 'RM-2026-0006', 49, 'canceled', current_date - 130, NULL),
  ('ce000000-0000-4000-8000-000000000007', 'c0000000-0000-4000-8000-00000000000b', 'c1000000-0000-4000-8000-00000000000b', 9, 2026, 'RM-2026-0007', 49, 'open',     current_date + 20, NULL);

ANALYZE public.companies;
ANALYZE public.subscription_invoices;
ANALYZE public.user_profiles;
ANALYZE public.drivers;
ANALYZE public.cars;

-- ─── 1. privileges and shape ────────────────────────────────────────────────

DO $$
DECLARE
  r record;
BEGIN
  PERFORM _rm_reset();

  FOR r IN
    SELECT * FROM (VALUES
      -- signature                                                                                              anon   authn  service
      ('public.platform_companies_list(text,text,text,text,text,text,boolean,text,integer,integer)',             false, true,  false),
      ('public.platform_vehicles_list(uuid,text,text,text,integer,integer)',                                     false, true,  false),
      ('public.platform_drivers_list(uuid,text,text,text,integer,integer)',                                      false, true,  false),
      ('public.platform_users_list(uuid,text,text,text,integer,integer)',                                        false, true,  false),
      ('public.platform_audit_list(uuid,uuid,text,text,text,timestamptz,timestamptz,timestamptz,bigint,integer)', false, true, false),
      ('app_private.platform_read_record(text,text,uuid,text,jsonb)',                                            false, false, false),
      ('app_private.platform_read_limit(integer)',                                                               false, false, false),
      ('app_private.platform_read_offset(integer)',                                                              false, false, false),
      ('app_private.platform_read_token(text)',                                                                  false, false, false),
      ('app_private.platform_read_search(text)',                                                                 false, false, false),
      ('app_private.platform_read_like(text)',                                                                   false, false, false),
      ('app_private.platform_companies_list_statement()',                                                        false, false, false),
      ('app_private.platform_vehicles_list_statement()',                                                         false, false, false),
      ('app_private.platform_drivers_list_statement()',                                                          false, false, false),
      ('app_private.platform_users_list_statement()',                                                            false, false, false),
      ('app_private.platform_audit_list_statement()',                                                            false, false, false)
    ) AS t(sig, anon, authn, service)
  LOOP
    PERFORM _rm_ok(format('EXECUTE on %s: anon %s, authenticated %s, service_role %s', r.sig, r.anon, r.authn, r.service),
      has_function_privilege('anon',          r.sig::regprocedure, 'EXECUTE') = r.anon
      AND has_function_privilege('authenticated', r.sig::regprocedure, 'EXECUTE') = r.authn
      AND has_function_privilege('service_role',  r.sig::regprocedure, 'EXECUTE') = r.service);
  END LOOP;

  -- VOLATILE is what makes PostgREST use POST: a GET runs in a read-only
  -- transaction, where the audit row could not be written.
  PERFORM _rm_ok('every read model is SECURITY DEFINER, VOLATILE and pins its search_path',
    NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('platform_companies_list', 'platform_vehicles_list', 'platform_drivers_list',
                           'platform_users_list', 'platform_audit_list')
         AND (NOT p.prosecdef
              OR p.provolatile <> 'v'
              OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c WHERE c LIKE 'search_path=%'))));

  PERFORM _rm_ok('anon may not call the company list',
    _rm_try(NULL, 'SELECT platform_companies_list()::text') LIKE 'ERR 42501%');
  PERFORM _rm_ok('anon may not call the three directories or the audit list',
    _rm_try(NULL, 'SELECT platform_vehicles_list()::text') LIKE 'ERR 42501%'
    AND _rm_try(NULL, 'SELECT platform_drivers_list()::text') LIKE 'ERR 42501%'
    AND _rm_try(NULL, 'SELECT platform_users_list()::text') LIKE 'ERR 42501%'
    AND _rm_try(NULL, 'SELECT platform_audit_list()::text') LIKE 'ERR 42501%');
  PERFORM _rm_ok('the service role may not call them either: it has no auth.uid() to answer for',
    _rm_try(NULL, 'SELECT platform_companies_list()::text', true) LIKE 'ERR 42501%'
    AND _rm_try(NULL, 'SELECT platform_users_list()::text', true) LIKE 'ERR 42501%');
  PERFORM _rm_ok('authenticated cannot reach the app_private halves',
    _rm_try('3b000000-0000-4000-8000-000000000001', 'SELECT app_private.platform_companies_list_statement()') LIKE 'ERR 42501%'
    AND _rm_try('3b000000-0000-4000-8000-000000000001',
                $q$SELECT app_private.platform_read_record('platform_read.probe', 'ok', NULL, NULL, NULL)::text$q$) LIKE 'ERR 42501%');
END $$;

-- ─── 2. role x function ─────────────────────────────────────────────────────

DO $$
DECLARE
  r        record;
  p        record;
  v_want   boolean;
  v_got    jsonb;
BEGIN
  -- companies.read: all four roles. business.read: not billing. audit.read:
  -- owner only (open decision D3) — the audit list still answers ok for any
  -- active role, with its own rows, which section 8 checks.
  FOR p IN
    SELECT * FROM (VALUES
      ('owner',         '3b000000-0000-4000-8000-000000000001'::uuid, true,  true),
      ('support',       '3b000000-0000-4000-8000-000000000002'::uuid, true,  true),
      ('billing',       '3b000000-0000-4000-8000-000000000003'::uuid, true,  false),
      ('read_only',     '3b000000-0000-4000-8000-000000000004'::uuid, true,  true),
      ('disabled',      '3b000000-0000-4000-8000-000000000005'::uuid, false, false),
      ('company admin', 'a0000000-0000-4000-8000-000000000001'::uuid, false, false),
      ('company viewer','a0000000-0000-4000-8000-000000000003'::uuid, false, false)
    ) AS t(label, uid, companies_read, business_read)
  LOOP
    FOR r IN
      SELECT * FROM (VALUES
        ('platform_companies_list()',   'companies'),
        ('platform_vehicles_list()',    'business'),
        ('platform_drivers_list()',     'business'),
        ('platform_users_list()',       'business')
      ) AS t(call, capability)
    LOOP
      v_want := CASE WHEN r.capability = 'companies' THEN p.companies_read ELSE p.business_read END;
      v_got  := _rm_json(p.uid, format('SELECT %s::text', r.call));
      IF (v_got ->> 'ok')::boolean IS DISTINCT FROM v_want THEN
        RAISE EXCEPTION 'FAIL: % for % — expected ok %, got %', r.call, p.label, v_want, v_got::text;
      END IF;
      IF NOT v_want AND (v_got ->> 'reason') IS DISTINCT FROM 'not_authorized' THEN
        RAISE EXCEPTION 'FAIL: % for % — a refusal must say not_authorized, got %', r.call, p.label, v_got::text;
      END IF;
      IF NOT v_want AND v_got ? 'items' THEN
        RAISE EXCEPTION 'FAIL: % for % returned items with its refusal', r.call, p.label;
      END IF;
    END LOOP;
    RAISE NOTICE 'ok  the four lists answer as expected for %', p.label;
  END LOOP;

  PERFORM _rm_ok('an owner reads every company, a company admin none',
    jsonb_array_length(_rm_json('3b000000-0000-4000-8000-000000000001', 'SELECT platform_companies_list()::text') -> 'items') >= 5
    AND NOT (_rm_json('a0000000-0000-4000-8000-000000000001', 'SELECT platform_companies_list()::text') ->> 'ok')::boolean);

  -- The company a staff member reads is not its own: there is none.
  PERFORM _rm_ok('an owner reads the vehicles of both companies',
    (SELECT count(DISTINCT i ->> 'company_id') >= 2
       FROM jsonb_array_elements(_rm_json('3b000000-0000-4000-8000-000000000001',
              'SELECT platform_vehicles_list(NULL, NULL, NULL, ''kennzeichen_asc'', 100, 0)::text') -> 'items') i));
  PERFORM _rm_ok('read_only reads the drivers of company B, which nobody in company A may',
    (_rm_json('3b000000-0000-4000-8000-000000000004',
       $q$SELECT platform_drivers_list('c0000000-0000-4000-8000-00000000000b')::text$q$) ->> 'total')::int = 1
    AND _rm_try('a0000000-0000-4000-8000-000000000001',
       $q$SELECT count(*)::text FROM drivers WHERE company_id = 'c0000000-0000-4000-8000-00000000000b'$q$) = '0');
END $$;

-- ─── 3. one audit row per call ──────────────────────────────────────────────

DO $$
DECLARE
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  billing  constant uuid := '3b000000-0000-4000-8000-000000000003';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_before bigint;
  v_json   jsonb;
  r        app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _rm_reset();

  v_before := _rm_audit_count();
  v_json := _rm_json(owner, $q$SELECT platform_companies_list(NULL, 'approved', NULL, NULL, NULL, NULL, false, 'name_asc', 3, 0)::text$q$);
  PERFORM _rm_ok('companies list: exactly one audit row per call', _rm_audit_count() - v_before = 1);

  SELECT * INTO r FROM app_private.platform_audit_log ORDER BY id DESC LIMIT 1;
  PERFORM _rm_ok('companies list: the row is a read by the caller, in its role, naming the request and the count',
    r.category = 'read' AND r.action = 'platform_read.companies_list' AND r.outcome = 'ok'
    AND r.actor_user_id = owner AND r.actor_role = 'owner' AND r.target_type = 'company'
    AND r.after_value -> 'request' ->> 'approval_status' = 'approved'
    AND r.after_value -> 'request' ->> 'sort' = 'name_asc'
    AND (r.after_value -> 'request' ->> 'limit')::int = 3
    AND (r.after_value ->> 'returned')::int = jsonb_array_length(v_json -> 'items'));
  PERFORM _rm_ok('companies list: the row records no company data, only the request and the counts',
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r.after_value) k) = ARRAY['request', 'returned', 'total']
    AND r.before_value IS NULL);

  -- Every read model, once, and each writes its own action.
  v_before := _rm_audit_count();
  PERFORM _rm_json(owner, $q$SELECT platform_vehicles_list('c0000000-0000-4000-8000-00000000000a')::text$q$);
  PERFORM _rm_json(owner, $q$SELECT platform_drivers_list('c0000000-0000-4000-8000-00000000000a')::text$q$);
  PERFORM _rm_json(owner, $q$SELECT platform_users_list('c0000000-0000-4000-8000-00000000000a')::text$q$);
  PERFORM _rm_json(owner, 'SELECT platform_audit_list()::text');
  PERFORM _rm_ok('one row per call for the other four read models', _rm_audit_count() - v_before = 4);
  PERFORM _rm_ok('each names its own action and the company it was asked about',
    (SELECT count(*) FROM app_private.platform_audit_log
      WHERE id > (SELECT max(id) - 4 FROM app_private.platform_audit_log)
        AND action IN ('platform_read.vehicles_list', 'platform_read.drivers_list',
                       'platform_read.users_list', 'platform_read.audit_list')) = 4
    AND (SELECT count(*) FROM app_private.platform_audit_log
          WHERE action IN ('platform_read.vehicles_list', 'platform_read.drivers_list', 'platform_read.users_list')
            AND company_id = 'c0000000-0000-4000-8000-00000000000a') = 3);

  -- A refusal of a staff member is kept; a refusal of an account without a
  -- staff role writes nothing, or any company user could fill the log.
  v_before := _rm_audit_count();
  PERFORM _rm_json(billing, 'SELECT platform_vehicles_list()::text');
  PERFORM _rm_ok('a staff refusal is one denied row', _rm_audit_count() - v_before = 1);
  SELECT * INTO r FROM app_private.platform_audit_log ORDER BY id DESC LIMIT 1;
  PERFORM _rm_ok('… by that staff member, in its role, with the request it made',
    r.outcome = 'denied' AND r.category = 'read' AND r.action = 'platform_read.vehicles_list'
    AND r.actor_user_id = billing AND r.actor_role = 'billing' AND r.after_value ? 'request');

  v_before := _rm_audit_count();
  PERFORM _rm_json(admin_a, 'SELECT platform_companies_list()::text');
  PERFORM _rm_json(admin_a, 'SELECT platform_users_list()::text');
  PERFORM _rm_json('3b000000-0000-4000-8000-000000000005', 'SELECT platform_drivers_list()::text');
  PERFORM _rm_ok('a caller without an active staff role writes no row at all', _rm_audit_count() = v_before);

  -- A broken contract raises before anything is read or recorded.
  v_before := _rm_audit_count();
  PERFORM _rm_ok('a broken argument raises 22023 and records nothing',
    _rm_do(owner, 'SELECT platform_companies_list(NULL, NULL, NULL, NULL, NULL, NULL, false, ''name_asc'', 500, 0)::text') LIKE 'ERR 22023%'
    AND _rm_audit_count() = v_before);
END $$;

-- ─── 4. the argument contract ───────────────────────────────────────────────

DO $$
DECLARE
  owner constant uuid := '3b000000-0000-4000-8000-000000000001';
  v     jsonb;
BEGIN
  PERFORM _rm_reset();

  PERFORM _rm_ok('page size: 0, 101 and a negative are refused',
    _rm_do(owner, 'SELECT platform_companies_list(NULL,NULL,NULL,NULL,NULL,NULL,false,''name_asc'',0,0)::text')   LIKE 'ERR 22023%'
    AND _rm_do(owner, 'SELECT platform_companies_list(NULL,NULL,NULL,NULL,NULL,NULL,false,''name_asc'',101,0)::text') LIKE 'ERR 22023%'
    AND _rm_do(owner, 'SELECT platform_vehicles_list(NULL,NULL,NULL,''kennzeichen_asc'',-1,0)::text') LIKE 'ERR 22023%');
  PERFORM _rm_ok('page size: 1 and 100 are accepted, and NULL means the default 50',
    (_rm_json(owner, 'SELECT platform_companies_list(NULL,NULL,NULL,NULL,NULL,NULL,false,''name_asc'',1,0)::text') ->> 'limit')::int = 1
    AND (_rm_json(owner, 'SELECT platform_companies_list(NULL,NULL,NULL,NULL,NULL,NULL,false,''name_asc'',100,0)::text') ->> 'limit')::int = 100
    AND (_rm_json(owner, 'SELECT platform_companies_list(NULL,NULL,NULL,NULL,NULL,NULL,false,''name_asc'',NULL,0)::text') ->> 'limit')::int = 50);
  PERFORM _rm_ok('offset: a negative and anything past 10000 are refused, 10000 is not',
    _rm_do(owner, 'SELECT platform_drivers_list(NULL,NULL,NULL,''name_asc'',10,-1)::text') LIKE 'ERR 22023%'
    AND _rm_do(owner, 'SELECT platform_drivers_list(NULL,NULL,NULL,''name_asc'',10,10001)::text') LIKE 'ERR 22023%'
    AND (_rm_json(owner, 'SELECT platform_drivers_list(NULL,NULL,NULL,''name_asc'',10,10000)::text') ->> 'ok')::boolean);
  PERFORM _rm_ok('sort: only the listed keys, for every list',
    _rm_do(owner, 'SELECT platform_companies_list(NULL,NULL,NULL,NULL,NULL,NULL,false,''plan_asc'',10,0)::text') LIKE 'ERR 22023%'
    AND _rm_do(owner, 'SELECT platform_vehicles_list(NULL,NULL,NULL,''name_asc'',10,0)::text') LIKE 'ERR 22023%'
    AND _rm_do(owner, 'SELECT platform_users_list(NULL,NULL,NULL,''kennzeichen_asc'',10,0)::text') LIKE 'ERR 22023%');
  PERFORM _rm_ok('trial: only running, expired and none — and NULL, which is no filter',
    _rm_do(owner, 'SELECT platform_companies_list(NULL,NULL,NULL,NULL,NULL,''maybe'',false,''name_asc'',10,0)::text') LIKE 'ERR 22023%'
    AND (_rm_json(owner, 'SELECT platform_companies_list(NULL,NULL,NULL,NULL,NULL,NULL,false,''name_asc'',10,0)::text') ->> 'ok')::boolean);
  PERFORM _rm_ok('a status or plan that is not a token is refused; one no row carries just finds nothing',
    _rm_do(owner, 'SELECT platform_companies_list(NULL,''Approved OR 1=1'',NULL,NULL,NULL,NULL,false,''name_asc'',10,0)::text') LIKE 'ERR 22023%'
    AND (_rm_json(owner, 'SELECT platform_companies_list(NULL,''nosuchstatus'',NULL,NULL,NULL,NULL,false,''name_asc'',10,0)::text') ->> 'total')::int = 0);
  PERFORM _rm_ok('a search longer than 100 characters is refused',
    _rm_do(owner, format('SELECT platform_companies_list(%L)::text', repeat('a', 101))) LIKE 'ERR 22023%');

  -- LIKE's own characters are taken literally: a search for "%" must not match
  -- every company.
  v := _rm_json(owner, 'SELECT platform_companies_list(''%'')::text');
  PERFORM _rm_ok('a search for a percent sign matches only the name that carries one',
    (v ->> 'total')::int = 1 AND (v -> 'items' -> 0 ->> 'name') = 'RM Prozent 100%');

  PERFORM _rm_ok('the audit cursor takes both halves or neither',
    _rm_do(owner, 'SELECT platform_audit_list(NULL,NULL,NULL,NULL,NULL,NULL,NULL,now(),NULL,10)::text') LIKE 'ERR 22023%'
    AND _rm_do(owner, 'SELECT platform_audit_list(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,10)::text') LIKE 'ERR 22023%');
  PERFORM _rm_ok('a malformed action prefix is refused',
    _rm_do(owner, 'SELECT platform_audit_list(NULL,NULL,NULL,''Platform Read'',NULL,NULL,NULL,NULL,NULL,10)::text') LIKE 'ERR 22023%');
END $$;

-- ─── 5. the columns, for the data protection review ─────────────────────────

DO $$
DECLARE
  owner constant uuid := '3b000000-0000-4000-8000-000000000001';
  v     jsonb;
BEGIN
  PERFORM _rm_reset();

  v := _rm_json(owner, $q$SELECT platform_companies_list(NULL,NULL,NULL,NULL,NULL,NULL,false,'name_asc',100,0)::text$q$);
  PERFORM _rm_ok('companies: exactly the documented columns',
    _rm_keys(v -> 'items' -> 0) = ARRAY[
      'active_driver_count','active_vehicle_count','approval_status','archived_at','billing_cycle','created_at',
      'deleted_at','id','last_payment_at','name','open_invoice_count','overdue_invoice_count','plan','slug',
      'status','subscription_car_limit','subscription_duration_type','subscription_expires_at',
      'subscription_started_at','subscription_status','trial_end','trial_start','trial_state','user_count']);

  v := _rm_json(owner, $q$SELECT platform_vehicles_list('c0000000-0000-4000-8000-00000000000a')::text$q$);
  PERFORM _rm_ok('vehicles: exactly the documented columns, and never created_by',
    _rm_keys(v -> 'items' -> 0) = ARRAY[
      'company_id','company_name','created_at','id','kennzeichen','letzte_hu','status','tuev_gueltig_bis']
    AND NOT (v -> 'items' -> 0) ? 'created_by');

  v := _rm_json(owner, $q$SELECT platform_drivers_list('c0000000-0000-4000-8000-00000000000a')::text$q$);
  PERFORM _rm_ok('drivers: exactly the documented columns',
    _rm_keys(v -> 'items' -> 0) = ARRAY[
      'company_id','company_name','created_at','driver_usage_type','id','name','status']);
  PERFORM _rm_ok('drivers: no salary, no personal identifier, no planning figure, in any row',
    NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v -> 'items') i,
                    unnest(ARRAY['salary_ratio','personalnummer','gender','employment_type','user_id',
                                 'planning_target_salary','planning_hourly_rate','planning_min_salary',
                                 'planning_max_salary','target_monthly_hours','max_monthly_hours',
                                 'allowed_weekdays','work_window_start','planned_shift_start_time']) AS k
       WHERE i ? k));

  v := _rm_json(owner, $q$SELECT platform_users_list('c0000000-0000-4000-8000-00000000000a')::text$q$);
  PERFORM _rm_ok('users: exactly the documented columns, with the two GoTrue ones',
    _rm_keys(v -> 'items' -> 0) = ARRAY[
      'activated_at','company_id','company_name','created_at','email','email_confirmed_at','full_name',
      'invited_at','last_sign_in_at','role','role_name','status','user_id']);
  PERFORM _rm_ok('users: no metadata, no password flag, no profile id, in any row',
    NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v -> 'items') i,
                    unnest(ARRAY['metadata','must_change_password','id','is_super_admin','encrypted_password']) AS k
       WHERE i ? k));
  PERFORM _rm_ok('users: the platform account sitting in company A is not listed (conservative, open for the owner)',
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i
                 WHERE i ->> 'user_id' = '3b000000-0000-4000-8000-000000000007')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i
                 WHERE i ->> 'user_id' = '3b000000-0000-4000-8000-000000000006'));
  PERFORM _rm_ok('users: last sign-in and email confirmation come from auth.users',
    (SELECT (i ->> 'last_sign_in_at') IS NOT NULL AND (i ->> 'email_confirmed_at') IS NOT NULL
       FROM jsonb_array_elements(v -> 'items') i
      WHERE i ->> 'user_id' = '3b000000-0000-4000-8000-000000000006'));

  v := _rm_json(owner, 'SELECT platform_audit_list(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,5)::text');
  PERFORM _rm_ok('audit: exactly the documented columns',
    _rm_keys(v -> 'items' -> 0) = ARRAY[
      'action','actor_email','actor_role','actor_user_id','after_value','before_value','category','company_id',
      'company_name','id','occurred_at','outcome','session_id','target_id','target_type']);
END $$;

-- ─── 6. the company figures ─────────────────────────────────────────────────

DO $$
DECLARE
  owner constant uuid := '3b000000-0000-4000-8000-000000000001';
  co_a  constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b  constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  a     jsonb;
  b     jsonb;
  v     jsonb;
BEGIN
  PERFORM _rm_reset();

  /*
    Each figure is compared with the same question asked directly of the
    tables, not with a number written down here: a count written down would
    also have to be maintained whenever an earlier test file seeds another row.
    The exclusions are then pinned separately, against rows this file inserted
    on purpose — a staff profile in company A, and an inactive driver and
    vehicle — so an implementation that simply counted everything would fail.
  */
  v := _rm_json(owner, $q$SELECT platform_companies_list('Test',NULL,NULL,NULL,NULL,NULL,false,'name_asc',100,0)::text$q$);
  SELECT i INTO a FROM jsonb_array_elements(v -> 'items') i WHERE i ->> 'slug' = 'test-a';
  SELECT i INTO b FROM jsonb_array_elements(v -> 'items') i WHERE i ->> 'slug' = 'test-b';

  PERFORM _rm_ok('company A: every profile of the company counts, except the platform account sitting in it',
    (a ->> 'user_count')::int
      = (SELECT count(*) FROM user_profiles up
          WHERE up.company_id = co_a
            AND NOT EXISTS (SELECT 1 FROM app_private.platform_staff s WHERE s.user_id = up.user_id))
    AND (SELECT count(*) FROM user_profiles WHERE company_id = co_a) = (a ->> 'user_count')::int + 1);
  PERFORM _rm_ok('company A: only drivers and vehicles that are not inactive count, the rule the limit triggers use',
    (a ->> 'active_driver_count')::int
      = (SELECT count(*) FROM drivers WHERE company_id = co_a AND status IS DISTINCT FROM 'inactive')
    AND (a ->> 'active_vehicle_count')::int
      = (SELECT count(*) FROM cars WHERE company_id = co_a AND status IS DISTINCT FROM 'inactive')
    AND (SELECT count(*) FROM drivers WHERE company_id = co_a) > (a ->> 'active_driver_count')::int
    AND (SELECT count(*) FROM cars WHERE company_id = co_a) > (a ->> 'active_vehicle_count')::int);
  PERFORM _rm_ok('company A: open counts the open invoices, and neither the paid nor the canceled ones',
    (a ->> 'open_invoice_count')::int
      = (SELECT count(*) FROM subscription_invoices WHERE company_id = co_a AND status = 'open')
    AND (SELECT count(*) FROM subscription_invoices WHERE company_id = co_a AND status IN ('paid', 'canceled')) >= 3);
  PERFORM _rm_ok('company A: overdue is an open invoice past its due date, plus one already marked overdue',
    (a ->> 'overdue_invoice_count')::int
      = (SELECT count(*) FROM subscription_invoices
          WHERE company_id = co_a
            AND (status = 'overdue'
                 OR (status = 'open' AND (due_date::timestamp AT TIME ZONE 'UTC') < now())))
    AND (a ->> 'overdue_invoice_count')::int >= 2);
  PERFORM _rm_ok('company A: the last payment is the newest paid_at of a paid invoice',
    (a ->> 'last_payment_at')::timestamptz
      = (SELECT max(paid_at) FROM subscription_invoices WHERE company_id = co_a AND status = 'paid'));
  PERFORM _rm_ok('company B: its own figures, not company A''s',
    (b ->> 'user_count')::int
      = (SELECT count(*) FROM user_profiles up WHERE up.company_id = co_b
           AND NOT EXISTS (SELECT 1 FROM app_private.platform_staff s WHERE s.user_id = up.user_id))
    AND (b ->> 'active_driver_count')::int
      = (SELECT count(*) FROM drivers WHERE company_id = co_b AND status IS DISTINCT FROM 'inactive')
    AND (b ->> 'active_vehicle_count')::int
      = (SELECT count(*) FROM cars WHERE company_id = co_b AND status IS DISTINCT FROM 'inactive')
    AND (b ->> 'open_invoice_count')::int = 1 AND (b ->> 'overdue_invoice_count')::int = 0
    AND (b ->> 'last_payment_at') IS NULL);
  PERFORM _rm_ok('an active company has no trial state', (a ->> 'trial_state') IS NULL);

  v := _rm_json(owner, $q$SELECT platform_companies_list(NULL,NULL,NULL,NULL,NULL,'running',false,'name_asc',100,0)::text$q$);
  PERFORM _rm_ok('trial running: exactly the companies in a trial that has not ended',
    (v ->> 'total')::int = (SELECT count(*) FROM companies WHERE status = 'trial' AND trial_end > now())
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i WHERE i ->> 'slug' = 'rm-trial-running')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i WHERE i ->> 'trial_state' <> 'running'));
  v := _rm_json(owner, $q$SELECT platform_companies_list(NULL,NULL,NULL,NULL,NULL,'expired',false,'name_asc',100,0)::text$q$);
  PERFORM _rm_ok('trial expired: exactly the companies whose trial_end has passed',
    (v ->> 'total')::int = (SELECT count(*) FROM companies WHERE status = 'trial' AND trial_end <= now())
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i WHERE i ->> 'slug' = 'rm-trial-expired')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i WHERE i ->> 'trial_state' <> 'expired'));
  v := _rm_json(owner, $q$SELECT platform_companies_list(NULL,NULL,NULL,NULL,NULL,'none',false,'name_asc',100,0)::text$q$);
  PERFORM _rm_ok('trial none: every company that is not in a dated trial, and no other',
    (v ->> 'total')::int = (SELECT count(*) FROM companies c
                             WHERE NOT (c.status = 'trial' AND c.trial_end IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i WHERE i ->> 'trial_state' IS NOT NULL));

  v := _rm_json(owner, $q$SELECT platform_companies_list(NULL,NULL,NULL,NULL,NULL,NULL,true,'name_asc',100,0)::text$q$);
  PERFORM _rm_ok('overdue only: the companies that have such an invoice, company A among them',
    (v ->> 'total')::int
      = (SELECT count(DISTINCT i.company_id) FROM subscription_invoices i
          WHERE i.status = 'overdue'
             OR (i.status = 'open' AND (i.due_date::timestamp AT TIME ZONE 'UTC') < now()))
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i WHERE i ->> 'slug' = 'test-a'));
  v := _rm_json(owner, $q$SELECT platform_companies_list(NULL,'pending',NULL,NULL,NULL,NULL,false,'name_asc',100,0)::text$q$);
  PERFORM _rm_ok('the approval filter answers with the pending companies and no other',
    (v ->> 'total')::int = (SELECT count(*) FROM companies WHERE approval_status = 'pending')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i WHERE i ->> 'approval_status' <> 'pending'));
END $$;

-- ─── 7. paging ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  owner constant uuid := '3b000000-0000-4000-8000-000000000001';
  p1    jsonb;
  p2    jsonb;
  v_all int;
BEGIN
  PERFORM _rm_reset();

  p1 := _rm_json(owner, $q$SELECT platform_companies_list(NULL,NULL,NULL,NULL,NULL,NULL,false,'name_asc',2,0)::text$q$);
  p2 := _rm_json(owner, $q$SELECT platform_companies_list(NULL,NULL,NULL,NULL,NULL,NULL,false,'name_asc',2,2)::text$q$);
  SELECT count(*) INTO v_all FROM companies;

  PERFORM _rm_ok('total is the whole filtered set, not the page',
    (p1 ->> 'total')::int = v_all AND (p2 ->> 'total')::int = v_all
    AND jsonb_array_length(p1 -> 'items') = 2 AND jsonb_array_length(p2 -> 'items') = 2);
  PERFORM _rm_ok('the page echoes the limit and offset it used',
    (p1 ->> 'offset')::int = 0 AND (p2 ->> 'offset')::int = 2 AND (p2 ->> 'limit')::int = 2);
  PERFORM _rm_ok('two pages of one sort do not overlap',
    NOT EXISTS (SELECT (i ->> 'id') FROM jsonb_array_elements(p1 -> 'items') i
                INTERSECT
                SELECT (i ->> 'id') FROM jsonb_array_elements(p2 -> 'items') i));
  PERFORM _rm_ok('the sort is the one that was asked for',
    (SELECT bool_and(lower(prev) <= lower(cur))
       FROM (SELECT lag(i ->> 'name') OVER (ORDER BY ord) AS prev, i ->> 'name' AS cur
               FROM jsonb_array_elements(p1 -> 'items') WITH ORDINALITY AS t(i, ord)) s
      WHERE prev IS NOT NULL));

  -- The directories page the same way.
  p1 := _rm_json(owner, $q$SELECT platform_vehicles_list(NULL,NULL,NULL,'kennzeichen_asc',2,0)::text$q$);
  p2 := _rm_json(owner, $q$SELECT platform_vehicles_list(NULL,NULL,NULL,'kennzeichen_asc',2,2)::text$q$);
  PERFORM _rm_ok('vehicles page without overlap, with the full total on both pages',
    (p1 ->> 'total')::int = (p2 ->> 'total')::int
    AND (p1 ->> 'total')::int = (SELECT count(*) FROM cars)
    AND NOT EXISTS (SELECT (i ->> 'id') FROM jsonb_array_elements(p1 -> 'items') i
                    INTERSECT
                    SELECT (i ->> 'id') FROM jsonb_array_elements(p2 -> 'items') i));
END $$;

-- ─── 8. who reads which audit rows, and the keyset cursor ───────────────────

DO $$
DECLARE
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  support  constant uuid := '3b000000-0000-4000-8000-000000000002';
  readonly constant uuid := '3b000000-0000-4000-8000-000000000004';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v        jsonb;
  p1       jsonb;
  p2       jsonb;
BEGIN
  PERFORM _rm_reset();

  -- Give support and read_only rows of their own to find.
  PERFORM _rm_json(support,  $q$SELECT platform_drivers_list('c0000000-0000-4000-8000-00000000000a')::text$q$);
  PERFORM _rm_json(readonly, $q$SELECT platform_drivers_list('c0000000-0000-4000-8000-00000000000a')::text$q$);

  v := _rm_json(owner, 'SELECT platform_audit_list(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,100)::text');
  PERFORM _rm_ok('audit.read: the scope is all, and other actors'' rows are there',
    (v ->> 'scope') = 'all'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i WHERE i ->> 'actor_user_id' = support::text)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i WHERE i ->> 'actor_user_id' = readonly::text));
  PERFORM _rm_ok('audit.read: the rows carry the actor''s address and the company name',
    (SELECT bool_or((i ->> 'actor_email') IS NOT NULL) FROM jsonb_array_elements(v -> 'items') i));

  v := _rm_json(support, 'SELECT platform_audit_list(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,100)::text');
  PERFORM _rm_ok('without audit.read: the scope is own, and every row is the caller''s',
    (v ->> 'scope') = 'own'
    AND jsonb_array_length(v -> 'items') > 0
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i
                     WHERE i ->> 'actor_user_id' IS DISTINCT FROM support::text));
  PERFORM _rm_ok('without audit.read: naming another actor is a refusal, not a filter',
    NOT (_rm_json(support, format('SELECT platform_audit_list(%L)::text', owner)) ->> 'ok')::boolean
    AND (_rm_json(support, format('SELECT platform_audit_list(%L)::text', support)) ->> 'scope') = 'own');
  PERFORM _rm_ok('read_only reads its own rows too (open decision D3 keeps the whole log with the owner)',
    (_rm_json(readonly, 'SELECT platform_audit_list()::text') ->> 'scope') = 'own');
  PERFORM _rm_ok('a company admin reads no audit row at all',
    NOT (_rm_json(admin_a, 'SELECT platform_audit_list()::text') ->> 'ok')::boolean);

  -- The keyset cursor. Rows written after the first page are newer, so the
  -- cursor excludes them; the two pages cannot overlap.
  p1 := _rm_json(owner, 'SELECT platform_audit_list(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,2)::text');
  PERFORM _rm_ok('a full page hands back a cursor',
    jsonb_array_length(p1 -> 'items') = 2 AND (p1 -> 'next_cursor' ->> 'before_id') IS NOT NULL);
  p2 := _rm_json(owner, format('SELECT platform_audit_list(NULL,NULL,NULL,NULL,NULL,NULL,NULL,%L,%s,2)::text',
                               p1 -> 'next_cursor' ->> 'before_occurred_at',
                               p1 -> 'next_cursor' ->> 'before_id'));
  PERFORM _rm_ok('following the cursor returns older rows and repeats none',
    jsonb_array_length(p2 -> 'items') > 0
    AND NOT EXISTS (SELECT (i ->> 'id') FROM jsonb_array_elements(p1 -> 'items') i
                    INTERSECT
                    SELECT (i ->> 'id') FROM jsonb_array_elements(p2 -> 'items') i)
    AND (p2 -> 'items' -> 0 ->> 'id')::bigint < (p1 -> 'items' -> 1 ->> 'id')::bigint);
  PERFORM _rm_ok('the newest row comes first',
    (SELECT bool_and(prev >= cur)
       FROM (SELECT lag((i ->> 'id')::bigint) OVER (ORDER BY ord) AS prev, (i ->> 'id')::bigint AS cur
               FROM jsonb_array_elements(p1 -> 'items') WITH ORDINALITY AS t(i, ord)) s
      WHERE prev IS NOT NULL));

  v := _rm_json(owner, $q$SELECT platform_audit_list(NULL,NULL,'read','platform_read.',NULL,NULL,NULL,NULL,NULL,100)::text$q$);
  PERFORM _rm_ok('the category and action-prefix filters narrow to the read models'' own rows',
    jsonb_array_length(v -> 'items') > 0
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i
                     WHERE i ->> 'category' <> 'read' OR left(i ->> 'action', 14) <> 'platform_read.'));
END $$;

-- ─── 9. platform_read. belongs to the database ──────────────────────────────

DO $$
DECLARE
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  readonly constant uuid := '3b000000-0000-4000-8000-000000000004';
BEGIN
  PERFORM _rm_reset();
  PERFORM _rm_ok('platform_audit_record refuses the platform_read namespace, whatever the role',
    _rm_try(owner,    $q$SELECT platform_audit_record('read', 'platform_read.companies_list', 'ok')::text$q$) LIKE 'ERR 22023%'
    AND _rm_try(readonly, $q$SELECT platform_audit_record('write', 'platform_read.anything', 'ok')::text$q$) LIKE 'ERR 22023%'
    AND _rm_try(readonly, $q$SELECT platform_audit_record('read', 'platform_read', 'ok')::text$q$) LIKE 'ERR 22023%');
  -- This read a name that only starts like the namespace as still accepted,
  -- which it was while any action could be recorded. Since 20260916130000,
  -- restated in 20260916150000, the door also takes only the actions the edge
  -- functions send, so `platform_readiness.check` is refused as well — for not
  -- being on that list, not for the namespace. The distinction the line was
  -- written for lives on in the regex itself: a listed action could never be
  -- placed inside `platform_read.`, while one merely starting with those
  -- letters would pass the namespace check.
  PERFORM _rm_ok('a name that only starts like it is refused by the action list, not by the namespace',
    _rm_try(readonly, $q$SELECT platform_audit_record('read', 'platform_readiness.check', 'ok')::text$q$) LIKE 'ERR 22023%'
    AND _rm_try(readonly, $q$SELECT (platform_audit_record('read', 'manage_users.list', 'ok') IS NOT NULL)::text$q$) = 'true');
  PERFORM _rm_ok('the namespaces of 20260916110000 are still refused',
    _rm_try(readonly, $q$SELECT platform_audit_record('write', 'platform_staff.delete', 'ok')::text$q$) LIKE 'ERR 22023%'
    AND _rm_try(readonly, $q$SELECT platform_audit_record('write', 'legacy.subscription_admin_actions', 'ok')::text$q$) LIKE 'ERR 22023%'
    AND _rm_try(readonly, $q$SELECT platform_audit_record('read', 'auth.sign_in', 'ok')::text$q$) LIKE 'ERR 22023%');
END $$;

-- ─── 10. the plans ──────────────────────────────────────────────────────────

/*
  The statement each read model runs is EXPLAINed here exactly as the function
  runs it. Two things must hold whatever the data:

    * neither fahrtenbuch_trips nor receipts is read at all — the company row
      carries no figure that needs them;
    * each table behind a company figure is scanned once for the whole page,
      not once per company row. A per-company subquery would show up as a
      SubPlan or a nested loop over the same table, and the scan count would
      rise with the page.
*/
DO $$
DECLARE
  v_plan text;
BEGIN
  PERFORM _rm_reset();

  v_plan := _rm_plan('companies');
  RAISE NOTICE 'companies plan:%', E'\n' || v_plan;
  PERFORM _rm_ok('companies: the plan reads neither fahrtenbuch_trips nor receipts',
    v_plan !~ 'fahrtenbuch_trips' AND v_plan !~ 'receipts');
  PERFORM _rm_ok('companies: user_profiles, drivers and cars are each scanned once for the whole page',
    _rm_scans(v_plan, 'user_profiles') = 1
    AND _rm_scans(v_plan, 'drivers') = 1
    AND _rm_scans(v_plan, 'cars') = 1);
  PERFORM _rm_ok('companies: subscription_invoices is read at most twice — the figures and the overdue filter',
    _rm_scans(v_plan, 'subscription_invoices') BETWEEN 1 AND 2);
  PERFORM _rm_ok('companies: platform_staff is read to leave staff out of the user count',
    _rm_scans(v_plan, 'platform_staff') >= 1);

  v_plan := _rm_plan('vehicles');
  PERFORM _rm_ok('vehicles: one scan of cars, no trips and no receipts',
    _rm_scans(v_plan, 'cars') = 1 AND v_plan !~ 'fahrtenbuch_trips' AND v_plan !~ 'receipts');

  v_plan := _rm_plan('drivers');
  PERFORM _rm_ok('drivers: one scan of drivers, no trips, no receipts and no salaries',
    _rm_scans(v_plan, 'drivers') = 1 AND v_plan !~ 'fahrtenbuch_trips'
    AND v_plan !~ 'receipts' AND v_plan !~ 'salaries');

  v_plan := _rm_plan('users');
  PERFORM _rm_ok('users: one scan of user_profiles, and auth.users joined once',
    _rm_scans(v_plan, 'user_profiles') = 1 AND _rm_scans(v_plan, 'users') >= 1
    AND v_plan !~ 'fahrtenbuch_trips' AND v_plan !~ 'receipts');
END $$;

DO $$ BEGIN RAISE NOTICE '── platform-readmodels: all checks passed ──'; END $$;

ROLLBACK;
