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
    8. scope        audit.read reads every actor's rows, and since 15.10.2026 all
                    four roles hold it (D3); a company admin is refused
    9. namespace    platform_audit_record refuses the platform_read. namespace
                    the database writes itself
   10. plans        EXPLAIN ANALYZE of each statement on seeded data: no scan
                    of fahrtenbuch_trips or receipts, and one scan per table
                    for the company figures rather than one per company row
   11. the team     platform_staff_list (20260920140000, plan 3.12), the sixth
                    read model: the same shape, staff.manage alone, the
                    documented columns with the sign-in address, every staff
                    row listed from the table itself — and the actor finding:
                    a change made through the staff functions names its caller
                    on both rows it writes and in created_by, while a row
                    written with no session has no actor at all
   12. the money    platform_invoices_list and platform_subscriptions_list
                    (20260924110000, decision D14): the seventh and eighth read
                    models, in the same shape, asking **billing.manage** — so a
                    `support` or `read_only` account, which keeps the company
                    list, is refused the invoices, the amounts and the payment
                    trail and gets a `denied` row for asking. Plus the six
                    figures the browser used to compute over every invoice of
                    every customer, the documented columns, and
                    generate_invoice_number, which had to become a definer or
                    invoice generation would have reported every company as
                    skipped and created nothing
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
  -- all four roles (D3, answered 15.10.2026), which section 8 checks.
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
      -- drivers_per_car_limit since 20260923100000 (plan 3.13b): the panel read
      -- it out of company_settings across every company, and that table is now
      -- readable only inside a context. It is the ONE column of company_settings
      -- this model carries — the table holds the company's IBAN, BIC, account
      -- holder, VAT and tax number, so a second one is a data protection
      -- decision, not a convenience.
      'active_driver_count','active_vehicle_count','approval_status','archived_at','billing_cycle','created_at',
      'deleted_at','drivers_per_car_limit','id','last_payment_at','name','open_invoice_count',
      'overdue_invoice_count','plan','slug','status','subscription_car_limit','subscription_duration_type',
      'subscription_expires_at','subscription_started_at','subscription_status','trial_end','trial_start',
      'trial_state','user_count']);
  PERFORM _rm_ok('companies: no other column of company_settings rides along',
    NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v -> 'items') i,
                    unnest(ARRAY['iban','bic','account_holder','vat_id','tax_number','legal_company_name',
                                 'commercial_register','court_of_registration','bank_name','manager_name',
                                 'owner_name','authorized_representative','street','house_number',
                                 'postal_code','phone','logo_url']) AS forbidden(col)
       WHERE i ? forbidden.col));

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
  billing  constant uuid := '3b000000-0000-4000-8000-000000000003';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  k        integer;
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

  -- D3 was answered on 15.10.2026: every active role holds audit.read, so
  -- none of the four is confined to its own rows any more. The 'own' scope of
  -- platform_audit_list is reachable by no role today; it stays in the
  -- function as the fallback for a role a later matrix gives no audit.read.
  FOR k IN 1..3 LOOP
    v := _rm_json((ARRAY[support, billing, readonly])[k],
                  'SELECT platform_audit_list(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,100)::text');
    PERFORM _rm_ok(format('audit.read: %s reads the whole log, other actors'' rows included',
                          (ARRAY['support', 'billing', 'read_only'])[k]),
      (v ->> 'scope') = 'all'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') x WHERE x ->> 'actor_user_id' = owner::text)
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') x WHERE x ->> 'actor_user_id' = support::text));
  END LOOP;
  PERFORM _rm_ok('audit.read: naming another actor is a filter for a role that holds it',
    (_rm_json(readonly, format('SELECT platform_audit_list(%L)::text', owner)) ->> 'scope') = 'all'
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(_rm_json(readonly, format('SELECT platform_audit_list(%L)::text', owner)) -> 'items') x
                     WHERE x ->> 'actor_user_id' IS DISTINCT FROM owner::text));
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

-- ─── 11. the team roster: platform_staff_list (20260920140000) ──────────────

/*
  Plan 3.12. The Team page used to fold the audit log into a roster; this read
  model reads app_private.platform_staff itself, so the roster no longer
  depends on how long the log is kept (open decision D4). Its capability is
  staff.manage, owners only, for the reasons in the migration header.

  11f is the actor finding. The NULL actors measured on staging came from rows
  written with no session at all. A change made through platform_staff_add,
  _disable, _enable and _set_role (20260923140000) names its caller, with its
  role, on the function's own row and on the trigger's row, and
  platform_staff_add records the caller in created_by, which is where the list's
  "granted by" comes from — and which a role change keeps, so the roster still
  names who granted a membership after the role has moved.
*/

-- One more account, company-less and still pending_invite: the owner adds it
-- to the team in 11f.
INSERT INTO auth.users (id, email, email_confirmed_at, created_at) VALUES
  ('3b000000-0000-4000-8000-000000000008', 'rm-invitee@test.invalid', now(), now() - interval '1 day');

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status, invited_at) VALUES
  ('3b000000-0000-4000-8000-000000000008', 'rm-invitee@test.invalid', 'RM Invitee', 'viewer', NULL, NULL,
   'pending_invite', now());

/** _rm_do with the session's sign-in method given, for the one check that needs another. */
CREATE OR REPLACE FUNCTION _rm_do_amr(p_user uuid, p_amr text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _rm_become(p_user);
    PERFORM set_config('request.jwt.claim.amr', p_amr, true);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _rm_reset();
  RETURN v_out;
END $$;

/** Whether an item carries exactly these keys, compared as sets so no collation decides it. */
CREATE OR REPLACE FUNCTION _rm_has_exactly(p_item jsonb, p_keys text[]) RETURNS boolean
LANGUAGE sql AS $$
  SELECT coalesce(_rm_keys(p_item), '{}'::text[]) @> p_keys
     AND coalesce(_rm_keys(p_item), '{}'::text[]) <@ p_keys
$$;

/** The plan of the staff list's statement, run with the values the page sends. */
CREATE OR REPLACE FUNCTION _rm_staff_plan() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_plan text := '';
  r      record;
BEGIN
  FOR r IN EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) '
                   || app_private.platform_staff_list_statement()
           USING NULL::text, 'status_asc'::text, 100, 0
  LOOP v_plan := v_plan || r."QUERY PLAN" || E'\n'; END LOOP;
  RETURN v_plan;
END $$;

-- 11a. privileges and shape

DO $$
DECLARE
  owner constant uuid := '3b000000-0000-4000-8000-000000000001';
  c_fn  constant text := 'public.platform_staff_list(text,text,integer,integer)';
  c_st  constant text := 'app_private.platform_staff_list_statement()';
BEGIN
  PERFORM _rm_reset();

  PERFORM _rm_ok('staff list: EXECUTE for authenticated alone',
    NOT has_function_privilege('anon', c_fn::regprocedure, 'EXECUTE')
    AND has_function_privilege('authenticated', c_fn::regprocedure, 'EXECUTE')
    AND NOT has_function_privilege('service_role', c_fn::regprocedure, 'EXECUTE'));
  PERFORM _rm_ok('staff list: its statement half is reachable by nobody the API authenticates as',
    NOT has_function_privilege('anon', c_st::regprocedure, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', c_st::regprocedure, 'EXECUTE')
    AND NOT has_function_privilege('service_role', c_st::regprocedure, 'EXECUTE'));
  PERFORM _rm_ok('staff list: SECURITY DEFINER, VOLATILE (so PostgREST uses POST) and a pinned search_path',
    EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid = c_fn::regprocedure
               AND p.prosecdef
               AND p.provolatile = 'v'
               AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c WHERE c LIKE 'search_path=%')));
  PERFORM _rm_ok('staff list: anon and the service role are refused for lack of EXECUTE',
    _rm_try(NULL, 'SELECT platform_staff_list()::text') LIKE 'ERR 42501%'
    AND _rm_try(NULL, 'SELECT platform_staff_list()::text', true) LIKE 'ERR 42501%');
  PERFORM _rm_ok('staff list: an owner cannot run the statement half directly',
    _rm_try(owner, 'SELECT app_private.platform_staff_list_statement()') LIKE 'ERR 42501%');
END $$;

-- 11b. staff.manage, and nothing else

DO $$
DECLARE
  p     record;
  v_got jsonb;
BEGIN
  PERFORM _rm_reset();

  -- read_only, support and billing all hold a staff row and companies.read;
  -- none of them reads who else holds platform rights.
  FOR p IN
    SELECT * FROM (VALUES
      ('owner',          '3b000000-0000-4000-8000-000000000001'::uuid, true),
      ('seeded owner',   '50000000-0000-4000-8000-000000000001'::uuid, true),
      ('support',        '3b000000-0000-4000-8000-000000000002'::uuid, false),
      ('billing',        '3b000000-0000-4000-8000-000000000003'::uuid, false),
      ('read_only',      '3b000000-0000-4000-8000-000000000004'::uuid, false),
      ('disabled',       '3b000000-0000-4000-8000-000000000005'::uuid, false),
      ('company admin',  'a0000000-0000-4000-8000-000000000001'::uuid, false),
      ('company viewer', 'a0000000-0000-4000-8000-000000000003'::uuid, false)
    ) AS t(label, uid, allowed)
  LOOP
    v_got := _rm_json(p.uid, 'SELECT platform_staff_list()::text');
    IF (v_got ->> 'ok')::boolean IS DISTINCT FROM p.allowed THEN
      RAISE EXCEPTION 'FAIL: platform_staff_list for % — expected ok %, got %', p.label, p.allowed, v_got::text;
    END IF;
    IF NOT p.allowed AND v_got IS DISTINCT FROM '{"ok": false, "reason": "not_authorized"}'::jsonb THEN
      RAISE EXCEPTION 'FAIL: platform_staff_list for % — a refusal is exactly not_authorized, got %', p.label, v_got::text;
    END IF;
  END LOOP;
  RAISE NOTICE 'ok  staff list: the owners read it; support, billing, read_only, a disabled row and company users are refused';
END $$;

-- 11c. one audit row per call

DO $$
DECLARE
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  support  constant uuid := '3b000000-0000-4000-8000-000000000002';
  disabled constant uuid := '3b000000-0000-4000-8000-000000000005';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_before bigint;
  v_json   jsonb;
  v_out    text;
  r        app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _rm_reset();

  -- Each write is its own statement and each count another, so no count can be
  -- read ahead of the write it is meant to see.
  v_before := _rm_audit_count();
  v_json := _rm_json(owner, $q$SELECT platform_staff_list(NULL, 'email_asc', 10, 0)::text$q$);
  PERFORM _rm_ok('staff list: exactly one audit row per call', _rm_audit_count() - v_before = 1);

  SELECT * INTO r FROM app_private.platform_audit_log ORDER BY id DESC LIMIT 1;
  PERFORM _rm_ok('staff list: the row is a read by the caller, in its role, about the staff table',
    r.category = 'read' AND r.action = 'platform_read.staff_list' AND r.outcome = 'ok'
    AND r.actor_user_id = owner AND r.actor_role = 'owner'
    AND r.target_type = 'platform_staff' AND r.target_id IS NULL AND r.company_id IS NULL
    AND r.before_value IS NULL
    AND r.after_value -> 'request' ->> 'sort' = 'email_asc'
    AND (r.after_value -> 'request' ->> 'limit')::int = 10
    AND (r.after_value ->> 'returned')::int = jsonb_array_length(v_json -> 'items')
    AND (r.after_value ->> 'total')::int = (v_json ->> 'total')::int);
  PERFORM _rm_ok('staff list: the row records the request and the counts, and no address',
    _rm_has_exactly(r.after_value, ARRAY['request', 'returned', 'total'])
    AND r.after_value::text NOT LIKE '%@test.invalid%');

  -- A staff member without the capability leaves its refusal.
  v_before := _rm_audit_count();
  v_json := _rm_json(support, 'SELECT platform_staff_list()::text');
  PERFORM _rm_ok('staff list: a staff refusal is one denied row', _rm_audit_count() - v_before = 1);
  SELECT * INTO r FROM app_private.platform_audit_log ORDER BY id DESC LIMIT 1;
  PERFORM _rm_ok('… by that member, in its role, with the request it made and nothing it read',
    r.outcome = 'denied' AND r.category = 'read' AND r.action = 'platform_read.staff_list'
    AND r.actor_user_id = support AND r.actor_role = 'support'
    AND r.after_value ? 'request' AND NOT r.after_value ? 'returned');

  -- Nobody without an active staff role writes a row, or any company user
  -- could fill the append-only log.
  v_before := _rm_audit_count();
  v_json := _rm_json(admin_a, 'SELECT platform_staff_list()::text');
  v_json := _rm_json(disabled, 'SELECT platform_staff_list()::text');
  PERFORM _rm_ok('staff list: a caller without an active staff role writes no row at all',
    _rm_audit_count() = v_before);

  -- The owner's own account, in a session Google minted: since 20260919130000
  -- such a session exercises no platform role, so it is refused like a
  -- stranger and, like a stranger, leaves no row.
  v_before := _rm_audit_count();
  v_out := _rm_do_amr(owner, '[{"method": "oauth", "timestamp": 1789416052}]', 'SELECT platform_staff_list()::text');
  PERFORM _rm_ok('staff list: an owner''s Google session is refused',
    v_out::jsonb = '{"ok": false, "reason": "not_authorized"}'::jsonb);
  PERFORM _rm_ok('… and writes no row', _rm_audit_count() = v_before);

  -- A broken contract raises before anything is read or recorded.
  v_before := _rm_audit_count();
  v_out := _rm_do(owner, $q$SELECT platform_staff_list(NULL, 'status_asc', 500, 0)::text$q$);
  PERFORM _rm_ok('staff list: a broken argument raises 22023', v_out LIKE 'ERR 22023%');
  PERFORM _rm_ok('… and records nothing', _rm_audit_count() = v_before);
END $$;

-- 11d. the argument contract

DO $$
DECLARE
  owner constant uuid := '3b000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _rm_reset();

  PERFORM _rm_ok('staff list: only the four listed sorts',
    _rm_do(owner, $q$SELECT platform_staff_list(NULL, 'email_desc')::text$q$) LIKE 'ERR 22023%'
    AND _rm_do(owner, $q$SELECT platform_staff_list(NULL, 'kennzeichen_asc')::text$q$) LIKE 'ERR 22023%'
    AND (_rm_json(owner, $q$SELECT platform_staff_list(NULL, 'status_asc')::text$q$) ->> 'ok')::boolean
    AND (_rm_json(owner, $q$SELECT platform_staff_list(NULL, 'email_asc')::text$q$) ->> 'ok')::boolean
    AND (_rm_json(owner, $q$SELECT platform_staff_list(NULL, 'created_at_asc')::text$q$) ->> 'ok')::boolean
    AND (_rm_json(owner, $q$SELECT platform_staff_list(NULL, 'created_at_desc')::text$q$) ->> 'ok')::boolean);
  PERFORM _rm_ok('staff list: a NULL or empty sort is status_asc',
    (_rm_json(owner, 'SELECT platform_staff_list(NULL, NULL)::text') ->> 'ok')::boolean
    AND (_rm_json(owner, $q$SELECT platform_staff_list(NULL, '')::text$q$) ->> 'ok')::boolean);
  PERFORM _rm_ok('staff list: the status filter takes active, disabled or nothing',
    _rm_do(owner, $q$SELECT platform_staff_list('paused')::text$q$) LIKE 'ERR 22023%'
    AND _rm_do(owner, $q$SELECT platform_staff_list('Active')::text$q$) LIKE 'ERR 22023%'
    AND (_rm_json(owner, $q$SELECT platform_staff_list('active')::text$q$) ->> 'ok')::boolean
    AND (_rm_json(owner, $q$SELECT platform_staff_list('disabled')::text$q$) ->> 'ok')::boolean
    AND (_rm_json(owner, $q$SELECT platform_staff_list('')::text$q$) ->> 'ok')::boolean);
  PERFORM _rm_ok('staff list: the page maximum and the offset ceiling of the other read models',
    _rm_do(owner, 'SELECT platform_staff_list(NULL, NULL, 0, 0)::text') LIKE 'ERR 22023%'
    AND _rm_do(owner, 'SELECT platform_staff_list(NULL, NULL, 101, 0)::text') LIKE 'ERR 22023%'
    AND _rm_do(owner, 'SELECT platform_staff_list(NULL, NULL, 10, -1)::text') LIKE 'ERR 22023%'
    AND _rm_do(owner, 'SELECT platform_staff_list(NULL, NULL, 10, 10001)::text') LIKE 'ERR 22023%'
    AND (_rm_json(owner, 'SELECT platform_staff_list(NULL, NULL, 100, 10000)::text') ->> 'ok')::boolean
    AND (_rm_json(owner, 'SELECT platform_staff_list(NULL, NULL, NULL, NULL)::text') ->> 'limit')::int = 50);
END $$;

-- 11e. the columns, and the rows

DO $$
DECLARE
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  disabled constant uuid := '3b000000-0000-4000-8000-000000000005';
  in_co    constant uuid := '3b000000-0000-4000-8000-000000000007';
  c_keys   constant text[] := ARRAY['created_at', 'created_by', 'created_by_email', 'disabled_at', 'email',
                                    'invitation_pending', 'note', 'role', 'status', 'user_id'];
  v        jsonb;
  p1       jsonb;
  p2       jsonb;
  v_all    bigint;
BEGIN
  PERFORM _rm_reset();
  SELECT count(*) INTO v_all FROM app_private.platform_staff;

  v := _rm_json(owner, $q$SELECT platform_staff_list(NULL, 'status_asc', 100, 0)::text$q$);
  PERFORM _rm_ok('staff list: total is every staff row, and one page holds them all here',
    (v ->> 'total')::bigint = v_all AND jsonb_array_length(v -> 'items') = v_all AND v_all >= 7);
  PERFORM _rm_ok('staff list: exactly the documented columns, in every row',
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i
                 WHERE NOT _rm_has_exactly(i, c_keys)));
  PERFORM _rm_ok('staff list: no password, token, metadata, phone, sign-in time, company, flag or name, in any row',
    NOT EXISTS (SELECT 1
                  FROM jsonb_array_elements(v -> 'items') i,
                       unnest(ARRAY['encrypted_password', 'confirmation_token', 'recovery_token', 'phone',
                                    'raw_user_meta_data', 'raw_app_meta_data', 'last_sign_in_at',
                                    'company_id', 'is_super_admin', 'full_name']) AS k
                 WHERE i ? k));
  PERFORM _rm_ok('staff list: each address is the account''s own sign-in address, from auth.users',
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i
                 WHERE (i ->> 'email') IS DISTINCT FROM
                       (SELECT u.email::text FROM auth.users u WHERE u.id = (i ->> 'user_id')::uuid)));
  PERFORM _rm_ok('staff list: every staff row is listed — the disabled one, and the one in a company that the user directory leaves out',
    NOT EXISTS (SELECT 1 FROM app_private.platform_staff s
                 WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i
                                    WHERE (i ->> 'user_id')::uuid = s.user_id))
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i WHERE (i ->> 'user_id')::uuid = in_co)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i WHERE (i ->> 'user_id')::uuid = disabled));
  PERFORM _rm_ok('staff list: status and disabled_at follow the row',
    (SELECT i ->> 'status' = 'disabled' AND (i ->> 'disabled_at') IS NOT NULL
       FROM jsonb_array_elements(v -> 'items') i WHERE (i ->> 'user_id')::uuid = disabled)
    AND (SELECT i ->> 'status' = 'active' AND (i ->> 'disabled_at') IS NULL AND i ->> 'role' = 'owner'
       FROM jsonb_array_elements(v -> 'items') i WHERE (i ->> 'user_id')::uuid = owner));
  PERFORM _rm_ok('staff list: status_asc puts every active member before every disabled one',
    NOT EXISTS (
      SELECT 1
        FROM (SELECT i ->> 'status' AS cur,
                     lag(i ->> 'status') OVER (ORDER BY ord) AS prev
                FROM jsonb_array_elements(v -> 'items') WITH ORDINALITY AS t(i, ord)) s
       WHERE s.prev = 'disabled' AND s.cur = 'active'));

  v := _rm_json(owner, $q$SELECT platform_staff_list('disabled', 'status_asc', 100, 0)::text$q$);
  PERFORM _rm_ok('staff list: the disabled filter answers exactly the disabled rows',
    (v ->> 'total')::bigint = (SELECT count(*) FROM app_private.platform_staff WHERE disabled_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i WHERE i ->> 'status' <> 'disabled'));
  v := _rm_json(owner, $q$SELECT platform_staff_list('active', 'status_asc', 100, 0)::text$q$);
  PERFORM _rm_ok('staff list: the active filter answers exactly the active rows',
    (v ->> 'total')::bigint = (SELECT count(*) FROM app_private.platform_staff WHERE disabled_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i WHERE i ->> 'status' <> 'active'));

  p1 := _rm_json(owner, $q$SELECT platform_staff_list(NULL, 'email_asc', 2, 0)::text$q$);
  p2 := _rm_json(owner, $q$SELECT platform_staff_list(NULL, 'email_asc', 2, 2)::text$q$);
  PERFORM _rm_ok('staff list: two pages of one sort do not overlap, and each carries the whole total',
    (p1 ->> 'total')::bigint = v_all AND (p2 ->> 'total')::bigint = v_all
    AND jsonb_array_length(p1 -> 'items') = 2 AND jsonb_array_length(p2 -> 'items') = 2
    AND (p2 ->> 'offset')::int = 2
    AND NOT EXISTS (SELECT (i ->> 'user_id') FROM jsonb_array_elements(p1 -> 'items') i
                    INTERSECT
                    SELECT (i ->> 'user_id') FROM jsonb_array_elements(p2 -> 'items') i));
  PERFORM _rm_ok('staff list: email_asc is by address',
    (SELECT bool_and(lower(s.prev) <= lower(s.cur))
       FROM (SELECT lag(i ->> 'email') OVER (ORDER BY ord) AS prev, i ->> 'email' AS cur
               FROM jsonb_array_elements(p1 -> 'items') WITH ORDINALITY AS t(i, ord)) s
      WHERE s.prev IS NOT NULL));
END $$;

-- 11f. who granted it: the actor finding

DO $$
DECLARE
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  invitee  constant uuid := '3b000000-0000-4000-8000-000000000008';
  v_from   bigint;
  v        jsonb;
  v_item   jsonb;
  r        app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _rm_reset();

  -- A row written with no session. The owner row at the top of this file was
  -- inserted by the connecting superuser with no claims at all, which is the
  -- shape of the 20260916110000 backfill and of a statement run by hand as
  -- supabase_admin: nobody to name as creator, and no actor on the trigger's row.
  PERFORM _rm_ok('no session: the row names no creator',
    (SELECT s.created_by IS NULL FROM app_private.platform_staff s WHERE s.user_id = owner));
  PERFORM _rm_ok('no session: the trigger''s row has no actor and no role — where the NULLs on staging came from',
    (SELECT count(*) >= 1 AND bool_and(l.actor_user_id IS NULL AND l.actor_role IS NULL)
       FROM app_private.platform_audit_log l
      WHERE l.action = 'platform_staff.insert' AND l.target_id = owner::text));

  -- The same change made through the function, under a password session.
  SELECT coalesce(max(l.id), 0) INTO v_from FROM app_private.platform_audit_log l;
  v := _rm_json(owner, format('SELECT platform_staff_add(%L, %L, %L)::text', invitee, 'owner', 'rm grant'));
  PERFORM _rm_ok('grant: an owner adds a company-less account through platform_staff_add',
    (v ->> 'success') = 'true');
  PERFORM _rm_reset();

  PERFORM _rm_ok('grant: the table row names the caller as its creator',
    (SELECT s.created_by = owner AND s.role = 'owner' AND s.disabled_at IS NULL
       FROM app_private.platform_staff s WHERE s.user_id = invitee));

  SELECT * INTO r FROM app_private.platform_audit_log l
   WHERE l.id > v_from AND l.action = 'platform_staff.insert' AND l.target_id = invitee::text
   ORDER BY l.id;
  PERFORM _rm_ok('grant: the trigger''s row carries the caller as actor, in its role, and the creator in the row it records',
    r.id IS NOT NULL AND r.category = 'staff' AND r.outcome = 'ok'
    AND r.actor_user_id = owner AND r.actor_role = 'owner'
    AND r.after_value ->> 'created_by' = owner::text);

  SELECT * INTO r FROM app_private.platform_audit_log l
   WHERE l.id > v_from AND l.action = 'platform_staff.add' AND l.target_id = invitee::text
   ORDER BY l.id;
  PERFORM _rm_ok('grant: the function''s own row carries the same actor and role',
    r.id IS NOT NULL AND r.category = 'staff' AND r.outcome = 'ok'
    AND r.actor_user_id = owner AND r.actor_role = 'owner');

  v := _rm_json(owner, $q$SELECT platform_staff_list(NULL, 'email_asc', 100, 0)::text$q$);
  SELECT i INTO v_item FROM jsonb_array_elements(v -> 'items') i WHERE (i ->> 'user_id')::uuid = invitee;
  PERFORM _rm_ok('grant: the list names who granted it, by address, and that the invitation is still open',
    v_item ->> 'created_by' = owner::text
    AND v_item ->> 'created_by_email' = 'rm-owner@test.invalid'
    AND v_item ->> 'email' = 'rm-invitee@test.invalid'
    AND (v_item ->> 'invitation_pending')::boolean
    AND v_item ->> 'role' = 'owner' AND v_item ->> 'status' = 'active');
  SELECT i INTO v_item FROM jsonb_array_elements(v -> 'items') i WHERE (i ->> 'user_id')::uuid = owner;
  PERFORM _rm_ok('grant: a row written with no session says so — no creator, no creator address — and its invitation is not open',
    (v_item -> 'created_by') = 'null'::jsonb
    AND (v_item -> 'created_by_email') = 'null'::jsonb
    AND NOT (v_item ->> 'invitation_pending')::boolean);

  -- Disabling and enabling through the functions name the caller too.
  SELECT coalesce(max(l.id), 0) INTO v_from FROM app_private.platform_audit_log l;
  v := _rm_json(owner, format('SELECT platform_staff_disable(%L)::text', invitee));
  PERFORM _rm_ok('disable: succeeds while other owners remain', (v ->> 'success') = 'true');
  PERFORM _rm_reset();
  PERFORM _rm_ok('disable: the trigger''s row carries the caller as actor, in its role',
    (SELECT count(*) = 1 AND bool_and(l.actor_user_id = owner AND l.actor_role = 'owner'
                                     AND (l.after_value ->> 'disabled_at') IS NOT NULL)
       FROM app_private.platform_audit_log l
      WHERE l.id > v_from AND l.action = 'platform_staff.update' AND l.target_id = invitee::text));

  v := _rm_json(owner, $q$SELECT platform_staff_list('disabled', 'status_asc', 100, 0)::text$q$);
  PERFORM _rm_ok('disable: the list shows the member disabled, still with its grantor',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'items') i
             WHERE (i ->> 'user_id')::uuid = invitee
               AND i ->> 'status' = 'disabled'
               AND i ->> 'created_by_email' = 'rm-owner@test.invalid'));

  SELECT coalesce(max(l.id), 0) INTO v_from FROM app_private.platform_audit_log l;
  v := _rm_json(owner, format('SELECT platform_staff_enable(%L)::text', invitee));
  PERFORM _rm_ok('enable: an owner row comes back', (v ->> 'success') = 'true');
  PERFORM _rm_reset();
  PERFORM _rm_ok('enable: the trigger''s row carries the caller as actor, in its role',
    (SELECT count(*) = 1 AND bool_and(l.actor_user_id = owner AND l.actor_role = 'owner'
                                     AND (l.after_value ->> 'disabled_at') IS NULL)
       FROM app_private.platform_audit_log l
      WHERE l.id > v_from AND l.action = 'platform_staff.update' AND l.target_id = invitee::text));

  -- So does a role change (20260923140000), which is the reason the roster can
  -- show a role at all without the row having been removed and written again:
  -- `created_by`, `created_at` and the note survive it, and the list still names
  -- who granted the membership.
  SELECT coalesce(max(l.id), 0) INTO v_from FROM app_private.platform_audit_log l;
  v := _rm_json(owner, format('SELECT platform_staff_set_role(%L, %L)::text', invitee, 'support'));
  PERFORM _rm_ok('set_role: an owner moves the member to support', (v ->> 'success') = 'true');
  PERFORM _rm_reset();

  SELECT * INTO r FROM app_private.platform_audit_log l
   WHERE l.id > v_from AND l.action = 'platform_staff.set_role' AND l.target_id = invitee::text
   ORDER BY l.id;
  PERFORM _rm_ok('set_role: the function''s own row carries the caller as actor, in its role, and both roles',
    r.id IS NOT NULL AND r.category = 'staff' AND r.outcome = 'ok'
    AND r.actor_user_id = owner AND r.actor_role = 'owner'
    AND r.before_value ->> 'role' = 'owner' AND r.after_value ->> 'role' = 'support'
    AND (r.after_value ->> 'self')::boolean = false);
  PERFORM _rm_ok('set_role: the trigger''s row carries the same actor and role',
    (SELECT count(*) = 1 AND bool_and(l.actor_user_id = owner AND l.actor_role = 'owner'
                                     AND (l.after_value ->> 'role') = 'support')
       FROM app_private.platform_audit_log l
      WHERE l.id > v_from AND l.action = 'platform_staff.update' AND l.target_id = invitee::text));

  v := _rm_json(owner, $q$SELECT platform_staff_list(NULL, 'email_asc', 100, 0)::text$q$);
  SELECT i INTO v_item FROM jsonb_array_elements(v -> 'items') i WHERE (i ->> 'user_id')::uuid = invitee;
  PERFORM _rm_ok('set_role: the list shows the new role and still names who granted the membership',
    v_item ->> 'role' = 'support'
    AND v_item ->> 'status' = 'active'
    AND v_item ->> 'created_by' = owner::text
    AND v_item ->> 'created_by_email' = 'rm-owner@test.invalid');
END $$;

-- 11g. the plan, and the namespace

DO $$
DECLARE
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  readonly constant uuid := '3b000000-0000-4000-8000-000000000004';
  v_plan   text;
BEGIN
  PERFORM _rm_reset();

  v_plan := _rm_staff_plan();
  RAISE NOTICE 'staff list plan:%', E'\n' || v_plan;
  PERFORM _rm_ok('staff list: the plan reads neither fahrtenbuch_trips nor receipts',
    v_plan !~ 'fahrtenbuch_trips' AND v_plan !~ 'receipts');
  PERFORM _rm_ok('staff list: platform_staff and user_profiles are each scanned once, auth.users once per join at most',
    _rm_scans(v_plan, 'platform_staff') = 1
    AND _rm_scans(v_plan, 'user_profiles') = 1
    AND _rm_scans(v_plan, 'users') BETWEEN 1 AND 2);

  PERFORM _rm_ok('platform_audit_record refuses platform_read.staff_list, whatever the role and outcome',
    _rm_try(owner,    $q$SELECT platform_audit_record('read', 'platform_read.staff_list', 'ok')::text$q$) LIKE 'ERR 22023%'
    AND _rm_try(readonly, $q$SELECT platform_audit_record('read', 'platform_read.staff_list', 'denied')::text$q$) LIKE 'ERR 22023%');
END $$;

-- ─── 12. the money: platform_invoices_list and platform_subscriptions_list ───
--
-- Migration 20260924110000, decision D14 (24.09.2026). The four billing tables
-- lost their `companies.read` branch, so a platform account reads an invoice,
-- a subscription, the payment trail or a coverage period inside an open context
-- or through these two models, and nowhere else. They ask **billing.manage** —
-- owner and billing — which is the capability that already writes all four.
--
-- What `support` and `read_only` lose is the whole point of the slice, so it is
-- asserted from both sides: the refusal here, and the tenant term in
-- tests/rls/matrix.sql and section 7 of tests/rls/subscriptions.sql.

CREATE OR REPLACE FUNCTION _rm_billing_plan(p_which text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_plan text := '';
  r      record;
BEGIN
  IF p_which = 'invoices' THEN
    FOR r IN EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) '
                     || app_private.platform_invoices_list_statement()
             USING NULL::uuid, NULL::integer, NULL::integer, NULL::text, NULL::text, 100, 0
    LOOP v_plan := v_plan || r."QUERY PLAN" || E'\n'; END LOOP;
  ELSIF p_which = 'subscriptions' THEN
    FOR r IN EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) '
                     || app_private.platform_subscriptions_list_statement()
             USING NULL::uuid, NULL::text, 100, 0
    LOOP v_plan := v_plan || r."QUERY PLAN" || E'\n'; END LOOP;
  ELSE
    RAISE EXCEPTION 'unknown billing statement %', p_which;
  END IF;
  RETURN v_plan;
END $$;

-- 12a. privileges and shape, on 20260916140000's terms

DO $$
DECLARE
  r record;
BEGIN
  PERFORM _rm_reset();

  FOR r IN
    SELECT * FROM (VALUES
      -- signature                                                                        anon   authn  service
      ('public.platform_invoices_list(uuid,integer,integer,text,text,integer,integer)',    false, true,  false),
      ('public.platform_subscriptions_list(uuid,text,integer,integer)',                    false, true,  false),
      ('app_private.platform_invoices_list_statement()',                                   false, false, false),
      ('app_private.platform_subscriptions_list_statement()',                              false, false, false),
      -- generate_invoice_number joined them as a definer. The service role keeps
      -- its grant (20260915120000) and now gets NULL: it has no auth.uid().
      ('public.generate_invoice_number(integer)',                                          false, true,  true)
    ) AS t(sig, anon, authn, service)
  LOOP
    PERFORM _rm_ok(format('EXECUTE on %s: anon %s, authenticated %s, service_role %s', r.sig, r.anon, r.authn, r.service),
      has_function_privilege('anon',           r.sig::regprocedure, 'EXECUTE') = r.anon
      AND has_function_privilege('authenticated', r.sig::regprocedure, 'EXECUTE') = r.authn
      AND has_function_privilege('service_role',  r.sig::regprocedure, 'EXECUTE') = r.service);
  END LOOP;

  PERFORM _rm_ok('both billing models are SECURITY DEFINER, VOLATILE and pin their search_path',
    NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('platform_invoices_list', 'platform_subscriptions_list', 'generate_invoice_number')
         AND (NOT p.prosecdef
              OR p.provolatile <> 'v'
              OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c WHERE c LIKE 'search_path=%'))));

  PERFORM _rm_ok('anon may call neither billing model',
    _rm_try(NULL, 'SELECT platform_invoices_list()::text') LIKE 'ERR 42501%'
    AND _rm_try(NULL, 'SELECT platform_subscriptions_list()::text') LIKE 'ERR 42501%');
  PERFORM _rm_ok('the service role may not call them either: it has no auth.uid() to answer for',
    _rm_try(NULL, 'SELECT platform_invoices_list()::text', true) LIKE 'ERR 42501%'
    AND _rm_try(NULL, 'SELECT platform_subscriptions_list()::text', true) LIKE 'ERR 42501%');
  PERFORM _rm_ok('authenticated cannot reach either app_private half',
    _rm_try('3b000000-0000-4000-8000-000000000001', 'SELECT app_private.platform_invoices_list_statement()') LIKE 'ERR 42501%'
    AND _rm_try('3b000000-0000-4000-8000-000000000001', 'SELECT app_private.platform_subscriptions_list_statement()') LIKE 'ERR 42501%');
END $$;

-- 12b. role x function: billing.manage, and what support and read_only lose

DO $$
DECLARE
  p      record;
  r      record;
  v_got  jsonb;
BEGIN
  FOR p IN
    SELECT * FROM (VALUES
      ('owner',          '3b000000-0000-4000-8000-000000000001'::uuid, true),
      ('billing',        '3b000000-0000-4000-8000-000000000003'::uuid, true),
      -- the behaviour change D14 makes, stated per role
      ('support',        '3b000000-0000-4000-8000-000000000002'::uuid, false),
      ('read_only',      '3b000000-0000-4000-8000-000000000004'::uuid, false),
      ('disabled',       '3b000000-0000-4000-8000-000000000005'::uuid, false),
      ('company admin',  'a0000000-0000-4000-8000-000000000001'::uuid, false),
      ('company viewer', 'a0000000-0000-4000-8000-000000000003'::uuid, false)
    ) AS t(label, uid, may)
  LOOP
    FOR r IN SELECT * FROM (VALUES
      ('platform_invoices_list()'), ('platform_subscriptions_list()')
    ) AS t(call)
    LOOP
      v_got := _rm_json(p.uid, format('SELECT %s::text', r.call));
      IF (v_got ->> 'ok')::boolean IS DISTINCT FROM p.may THEN
        RAISE EXCEPTION 'FAIL: % for % — expected ok %, got %', r.call, p.label, p.may, v_got::text;
      END IF;
      IF NOT p.may AND (v_got ->> 'reason') IS DISTINCT FROM 'not_authorized' THEN
        RAISE EXCEPTION 'FAIL: % for % — a refusal must say not_authorized, got %', r.call, p.label, v_got::text;
      END IF;
      IF NOT p.may AND v_got ? 'items' THEN
        RAISE EXCEPTION 'FAIL: % for % returned items with its refusal', r.call, p.label;
      END IF;
      -- A refusal carries no figure either: an amount beside "not permitted"
      -- would be the read this decision closed.
      IF NOT p.may AND v_got ? 'summary' THEN
        RAISE EXCEPTION 'FAIL: % for % returned a summary with its refusal', r.call, p.label;
      END IF;
    END LOOP;
    RAISE NOTICE 'ok  both billing lists answer as expected for %', p.label;
  END LOOP;

  -- The same two accounts still read the company list, which D14 left open on
  -- purpose: that list is how a company is chosen to open a context on.
  PERFORM _rm_ok('support and read_only keep the company list they pick a company from',
    (_rm_json('3b000000-0000-4000-8000-000000000002', 'SELECT platform_companies_list()::text') ->> 'ok')::boolean
    AND (_rm_json('3b000000-0000-4000-8000-000000000004', 'SELECT platform_companies_list()::text') ->> 'ok')::boolean);

  -- generate_invoice_number answers NULL rather than raising: a run must fail
  -- per company with a message, not abort halfway.
  PERFORM _rm_ok('generate_invoice_number: a number for billing.manage, NULL for everyone else',
    _rm_do('3b000000-0000-4000-8000-000000000001', 'SELECT generate_invoice_number(2026)') LIKE 'INV-2026-%'
    AND _rm_do('3b000000-0000-4000-8000-000000000003', 'SELECT generate_invoice_number(2026)') LIKE 'INV-2026-%'
    AND _rm_do('3b000000-0000-4000-8000-000000000002', 'SELECT generate_invoice_number(2026)') = '<null>'
    AND _rm_do('3b000000-0000-4000-8000-000000000004', 'SELECT generate_invoice_number(2026)') = '<null>'
    AND _rm_do('a0000000-0000-4000-8000-000000000001', 'SELECT generate_invoice_number(2026)') = '<null>');

  -- It runs as its owner now, so the sequence it continues is every company's
  -- and not the caller's. The seeded invoices are RM-2026-…, so 2026 has no
  -- INV- number yet and the first is 0001; what matters is that a platform
  -- account and not the policy decides.
  PERFORM _rm_ok('generate_invoice_number reads past the narrowed policy, as its owner',
    _rm_do('3b000000-0000-4000-8000-000000000001', 'SELECT generate_invoice_number(2026)')
      = _rm_do('3b000000-0000-4000-8000-000000000003', 'SELECT generate_invoice_number(2026)'));
END $$;

-- 12c. the columns, for the data protection review

DO $$
DECLARE
  c_invoice_keys CONSTANT text[] := ARRAY[
    'id','company_id','company_name','company_address','company_postal_code',
    'company_city','plan_name','invoice_month','invoice_year','invoice_number',
    'amount','status','due_date','paid_at','cash_received_amount','receipt_note',
    'created_at'];
  c_sub_keys CONSTANT text[] := ARRAY[
    'id','company_id','company_name','plan_id','plan_name','status','starts_at',
    'billing_day','monthly_price'];
  owner constant uuid := '3b000000-0000-4000-8000-000000000001';
  v      jsonb;
  v_item jsonb;
BEGIN
  PERFORM _rm_reset();

  -- The address is companies.address, one line. The screen this replaced asked
  -- PostgREST for companies(street, house_number), which are columns of
  -- company_settings: the query was answered 42703 and the invoice list was
  -- always empty. Naming either here is both a widening and a broken statement.
  UPDATE companies
     SET address = 'Hauptstr. 7', postal_code = '20095', city = 'Hamburg'
   WHERE id = 'c0000000-0000-4000-8000-00000000000a';

  v := _rm_json(owner, 'SELECT platform_invoices_list(NULL, NULL, NULL, NULL, NULL, 100, 0)::text');
  PERFORM _rm_ok('invoices: every row carries exactly the documented columns',
    jsonb_array_length(v -> 'items') >= 7
    AND (SELECT bool_and(_rm_keys(i) = (SELECT array_agg(k ORDER BY k) FROM unnest(c_invoice_keys) k))
           FROM jsonb_array_elements(v -> 'items') i));

  PERFORM _rm_ok('invoices: no account id, no payment method, no e-mail address, in any row',
    (SELECT bool_and(NOT (i ? 'paid_by') AND NOT (i ? 'collected_by')
                     AND NOT (i ? 'payment_method') AND NOT (i ? 'subscription_id')
                     AND NOT (i ? 'company_email') AND NOT (i ? 'updated_at')
                     AND NOT (i ? 'company_street') AND NOT (i ? 'company_house_number')
                     AND NOT (i ? 'company_country'))
       FROM jsonb_array_elements(v -> 'items') i));

  SELECT i INTO v_item FROM jsonb_array_elements(v -> 'items') i
   WHERE i ->> 'invoice_number' = 'RM-2026-0001';
  PERFORM _rm_ok('invoices: the recipient''s name, street line and town, for the PDF',
    v_item ->> 'company_name' IS NOT NULL
    AND v_item ->> 'company_address'     = 'Hauptstr. 7'
    AND v_item ->> 'company_postal_code' = '20095'
    AND v_item ->> 'company_city'        = 'Hamburg'
    AND v_item ->> 'plan_name'           = 'RM Plan');

  v := _rm_json(owner, 'SELECT platform_subscriptions_list(NULL, NULL, 100, 0)::text');
  PERFORM _rm_ok('subscriptions: every row carries exactly the documented columns',
    jsonb_array_length(v -> 'items') >= 2
    AND (SELECT bool_and(_rm_keys(i) = (SELECT array_agg(k ORDER BY k) FROM unnest(c_sub_keys) k))
           FROM jsonb_array_elements(v -> 'items') i));
  PERFORM _rm_ok('subscriptions: no notes — free text that may hold anything — and no ends_at',
    (SELECT bool_and(NOT (i ? 'notes') AND NOT (i ? 'ends_at')
                     AND NOT (i ? 'payment_method') AND NOT (i ? 'created_at')
                     AND NOT (i ? 'updated_at'))
       FROM jsonb_array_elements(v -> 'items') i));
END $$;

-- 12d. the six figures, and the one that moved to Europe/Berlin

DO $$
DECLARE
  owner constant uuid := '3b000000-0000-4000-8000-000000000001';
  v        jsonb;
  v_before integer;
  v_after  integer;
  v_month  integer := EXTRACT(month FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_year   integer := EXTRACT(year  FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
BEGIN
  PERFORM _rm_reset();

  v := _rm_json(owner, 'SELECT platform_invoices_list(NULL, NULL, NULL, NULL, NULL, 100, 0)::text') -> 'summary';

  -- Three 'open' rows: two of company A and one of company B.
  PERFORM _rm_ok('figures: open_count counts every open invoice, not the page''s',
    (v ->> 'open_count')::int = 3);

  -- The billing page's own rule, and it is *not* platform_companies_list's:
  -- status 'overdue' is not counted here, only an 'open' row past its due date.
  -- The fixture carries one of each, so the two figures differ by design and
  -- this line is what says which is which.
  PERFORM _rm_ok('figures: overdue_count is open-and-past-due, never status overdue',
    (v ->> 'overdue_count')::int = 1
    AND (SELECT (i ->> 'overdue_invoice_count')::int = 2
           FROM jsonb_array_elements(_rm_json(owner, 'SELECT platform_companies_list()::text') -> 'items') i
          WHERE i ->> 'id' = 'c0000000-0000-4000-8000-00000000000a'));

  -- Six invoices of 49, one of company B: 343 over the unfiltered set.
  PERFORM _rm_ok('figures: filtered_amount and filtered_collected sum the filtered set',
    (v ->> 'filtered_amount')::numeric = 343
    AND (v ->> 'filtered_collected')::numeric = 98);

  -- A receipt of exactly 0,00 counts the full amount, because the browser wrote
  -- `cash_received_amount || amount` and JavaScript's `||` takes 0 as absent.
  -- coalesce() here would count 0 and quietly change a figure an operator reads.
  UPDATE subscription_invoices SET cash_received_amount = 0
   WHERE id = 'ce000000-0000-4000-8000-000000000004';
  PERFORM _rm_ok('figures: a cash receipt of exactly 0,00 counts the invoice amount, as the browser did',
    (_rm_json(owner, 'SELECT platform_invoices_list(NULL, NULL, NULL, NULL, NULL, 100, 0)::text')
       -> 'summary' ->> 'filtered_collected')::numeric = 98);
  UPDATE subscription_invoices SET cash_received_amount = NULL
   WHERE id = 'ce000000-0000-4000-8000-000000000004';

  PERFORM _rm_ok('figures: the sums follow the filter, the three counts do not',
    (SELECT (s ->> 'filtered_amount')::numeric = 49 AND (s ->> 'open_count')::int = 3
       FROM (SELECT _rm_json(owner,
               $q$SELECT platform_invoices_list('c0000000-0000-4000-8000-00000000000b')::text$q$) -> 'summary' AS s) x));

  PERFORM _rm_ok('figures: years is the year picker''s options',
    (v -> 'years') @> '[2026]'::jsonb);

  -- paid_this_month_count is measured rather than recomputed: one paid invoice
  -- in the current Berlin month must raise it by exactly one, and one in another
  -- month must not raise it at all. The month the operator's browser was in is
  -- what this figure used to follow.
  v_before := (v ->> 'paid_this_month_count')::int;

  INSERT INTO company_subscriptions (id, company_id, plan_id, monthly_price)
  VALUES ('c1000000-0000-4000-8000-00000000000c', 'cb000000-0000-4000-8000-000000000003',
          'cf000000-0000-4000-8000-000000000001', 49);
  INSERT INTO subscription_invoices (id, company_id, subscription_id, invoice_month, invoice_year,
                                     invoice_number, amount, status, due_date, paid_at)
  VALUES ('ce000000-0000-4000-8000-00000000000c', 'cb000000-0000-4000-8000-000000000003',
          'c1000000-0000-4000-8000-00000000000c', v_month, v_year,
          'RM-NOW-0001', 49, 'paid', current_date, now());

  v_after := (_rm_json(owner, 'SELECT platform_invoices_list(NULL, NULL, NULL, NULL, NULL, 100, 0)::text')
                -> 'summary' ->> 'paid_this_month_count')::int;
  PERFORM _rm_ok('figures: paid_this_month_count counts the current Europe/Berlin month',
    v_after = v_before + 1);

  UPDATE subscription_invoices
     SET invoice_month = CASE WHEN v_month = 1 THEN 12 ELSE v_month - 1 END,
         invoice_year  = CASE WHEN v_month = 1 THEN v_year - 1 ELSE v_year END
   WHERE id = 'ce000000-0000-4000-8000-00000000000c';
  PERFORM _rm_ok('figures: …and not the month before it',
    (_rm_json(owner, 'SELECT platform_invoices_list(NULL, NULL, NULL, NULL, NULL, 100, 0)::text')
       -> 'summary' ->> 'paid_this_month_count')::int = v_before);

  DELETE FROM subscription_invoices WHERE id = 'ce000000-0000-4000-8000-00000000000c';
  DELETE FROM company_subscriptions WHERE id = 'c1000000-0000-4000-8000-00000000000c';

  -- The subscriptions summary: every active subscription, and the count each
  -- plan card prints. Both are the whole table's, not the page's.
  v := _rm_json(owner, 'SELECT platform_subscriptions_list(NULL, NULL, 100, 0)::text') -> 'summary';
  PERFORM _rm_ok('figures: active_count and active_by_plan are the whole table''s',
    (v ->> 'active_count')::int = 2
    AND (v -> 'active_by_plan' ->> 'cf000000-0000-4000-8000-000000000001')::int = 2);
END $$;

-- 12e. one audit row per call, and a refusal that keeps its own

DO $$
DECLARE
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  support  constant uuid := '3b000000-0000-4000-8000-000000000002';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_before bigint;
  r        record;
BEGIN
  PERFORM _rm_reset();

  v_before := _rm_audit_count();
  PERFORM _rm_do(owner, $q$SELECT platform_invoices_list('c0000000-0000-4000-8000-00000000000a', 9, 2026)::text$q$);
  PERFORM _rm_ok('audit: exactly one row per invoice-list call', _rm_audit_count() - v_before = 1);

  SELECT * INTO r FROM app_private.platform_audit_log ORDER BY id DESC LIMIT 1;
  PERFORM _rm_ok('audit: a read by that account, in its role, naming the request, the company and the count',
    r.category = 'read' AND r.action = 'platform_read.invoices_list' AND r.outcome = 'ok'
    AND r.actor_user_id = owner AND r.actor_role = 'owner'
    AND r.target_type = 'invoice'
    AND r.company_id = 'c0000000-0000-4000-8000-00000000000a'
    AND (r.after_value -> 'request' ->> 'month') = '9'
    AND (r.after_value ->> 'returned') IS NOT NULL);

  -- The row records what was asked and how much came back, never a row of it:
  -- an audit log that copies the invoices would be the read it records.
  PERFORM _rm_ok('audit: the row carries no invoice of its own',
    r.after_value::text !~ 'RM-2026-' AND r.before_value IS NULL);

  v_before := _rm_audit_count();
  PERFORM _rm_do(owner, 'SELECT platform_subscriptions_list()::text');
  PERFORM _rm_ok('audit: one row per subscription-list call, with its own action',
    _rm_audit_count() - v_before = 1
    AND (SELECT l.action = 'platform_read.subscriptions_list' AND l.target_type = 'subscription'
           FROM app_private.platform_audit_log l ORDER BY l.id DESC LIMIT 1));

  -- A refusal is a return value, so the row survives. This is the row that says
  -- a support account tried to read the money.
  v_before := _rm_audit_count();
  PERFORM _rm_do(support, 'SELECT platform_invoices_list()::text');
  PERFORM _rm_ok('audit: a staff refusal is one denied row, by that member, in its role',
    _rm_audit_count() - v_before = 1
    AND (SELECT l.outcome = 'denied' AND l.actor_user_id = support AND l.actor_role = 'support'
                AND l.action = 'platform_read.invoices_list'
           FROM app_private.platform_audit_log l ORDER BY l.id DESC LIMIT 1));

  -- A company user writes nothing at all, or any member could fill the log.
  v_before := _rm_audit_count();
  PERFORM _rm_do(admin_a, 'SELECT platform_invoices_list()::text');
  PERFORM _rm_do(admin_a, 'SELECT platform_subscriptions_list()::text');
  PERFORM _rm_ok('audit: a caller without a staff role writes no row at all',
    _rm_audit_count() = v_before);

  -- A broken contract raises before anything is read, so there is nothing to
  -- record.
  v_before := _rm_audit_count();
  PERFORM _rm_do(owner, 'SELECT platform_invoices_list(NULL, 13)::text');
  PERFORM _rm_ok('audit: a broken argument records nothing', _rm_audit_count() = v_before);

  -- The namespace belongs to the database: no staff role may forge either row
  -- through the edge functions' door.
  PERFORM _rm_ok('platform_audit_record refuses both new actions, whatever the role',
    _rm_try(owner,   $q$SELECT platform_audit_record('read', 'platform_read.invoices_list', 'ok')::text$q$) LIKE 'ERR 22023%'
    AND _rm_try(support, $q$SELECT platform_audit_record('read', 'platform_read.subscriptions_list', 'denied')::text$q$) LIKE 'ERR 22023%');
END $$;

-- 12f. the argument contract

DO $$
DECLARE
  owner constant uuid := '3b000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _rm_reset();

  -- A month or a year outside its range is a broken contract, not an empty
  -- result: the screen sends NULL for "all", never 0. The message is fixed and
  -- names no value.
  PERFORM _rm_ok('invoices: month 0 and 13 are refused with 22023, 1 and 12 are not',
    _rm_do(owner, 'SELECT platform_invoices_list(NULL, 0)::text')  LIKE 'ERR 22023%'
    AND _rm_do(owner, 'SELECT platform_invoices_list(NULL, 13)::text') LIKE 'ERR 22023%'
    AND (_rm_json(owner, 'SELECT platform_invoices_list(NULL, 1)::text')  ->> 'ok')::boolean
    AND (_rm_json(owner, 'SELECT platform_invoices_list(NULL, 12)::text') ->> 'ok')::boolean);
  PERFORM _rm_ok('invoices: a year outside 2020..2100 is refused, the bounds themselves are not',
    _rm_do(owner, 'SELECT platform_invoices_list(NULL, NULL, 2019)::text') LIKE 'ERR 22023%'
    AND _rm_do(owner, 'SELECT platform_invoices_list(NULL, NULL, 2101)::text') LIKE 'ERR 22023%'
    AND (_rm_json(owner, 'SELECT platform_invoices_list(NULL, NULL, 2020)::text') ->> 'ok')::boolean
    AND (_rm_json(owner, 'SELECT platform_invoices_list(NULL, NULL, 2100)::text') ->> 'ok')::boolean);

  -- The shared helpers, on both models: the page maximum and the offset ceiling.
  PERFORM _rm_ok('both: the page maximum is 100 and the offset ceiling 10000',
    _rm_do(owner, 'SELECT platform_invoices_list(NULL, NULL, NULL, NULL, NULL, 101, 0)::text') LIKE 'ERR 22023%'
    AND _rm_do(owner, 'SELECT platform_invoices_list(NULL, NULL, NULL, NULL, NULL, 100, 10001)::text') LIKE 'ERR 22023%'
    AND _rm_do(owner, 'SELECT platform_subscriptions_list(NULL, NULL, 0, 0)::text') LIKE 'ERR 22023%'
    AND _rm_do(owner, 'SELECT platform_subscriptions_list(NULL, NULL, 100, -1)::text') LIKE 'ERR 22023%'
    AND (_rm_json(owner, 'SELECT platform_subscriptions_list(NULL, NULL, 100, 10000)::text') ->> 'ok')::boolean);

  -- A status is a token: anything that is not one is refused before a row is
  -- read, and one no row carries finds nothing instead of raising. An empty
  -- string is "not given", which platform_read_token answers with NULL — so the
  -- screens send NULL for 'all' out of habit, not because '' would raise.
  PERFORM _rm_ok('both: a status must be a token; one no row carries just finds nothing',
    _rm_do(owner, $q$SELECT platform_invoices_list(NULL, NULL, NULL, 'Paid OR 1=1')::text$q$) LIKE 'ERR 22023%'
    AND _rm_do(owner, $q$SELECT platform_subscriptions_list(NULL, 'Active!')::text$q$) LIKE 'ERR 22023%'
    AND (_rm_json(owner, $q$SELECT platform_invoices_list(NULL, NULL, NULL, 'gibtsnicht')::text$q$) ->> 'total')::int = 0
    AND (_rm_json(owner, $q$SELECT platform_invoices_list(NULL, NULL, NULL, '')::text$q$) ->> 'total')::int = 7);

  -- The search reads the company name and the invoice number, and LIKE's own
  -- characters are literal. The negative controls are the two wildcards: an
  -- unescaped '%' or '_' would match every invoice number, and the only name
  -- carrying a literal percent sign has no invoice.
  PERFORM _rm_ok('invoices: the search reads the invoice number and the company name',
    (_rm_json(owner, $q$SELECT platform_invoices_list(NULL, NULL, NULL, NULL, 'RM-2026-0003')::text$q$) ->> 'total')::int = 1
    AND (_rm_json(owner, $q$SELECT platform_invoices_list(NULL, NULL, NULL, NULL, 'RM-2026-')::text$q$) ->> 'total')::int = 7);
  PERFORM _rm_ok('invoices: a wildcard in the search is a literal, not a match-all',
    (_rm_json(owner, $q$SELECT platform_invoices_list(NULL, NULL, NULL, NULL, '%')::text$q$) ->> 'total')::int = 0
    AND (_rm_json(owner, $q$SELECT platform_invoices_list(NULL, NULL, NULL, NULL, '_')::text$q$) ->> 'total')::int = 0);
  PERFORM _rm_ok('invoices: a search longer than 100 characters is refused',
    _rm_do(owner, format($q$SELECT platform_invoices_list(NULL, NULL, NULL, NULL, %L)::text$q$, repeat('a', 101)))
      LIKE 'ERR 22023%');
END $$;

-- 12g. paging, and the plan

DO $$
DECLARE
  owner constant uuid := '3b000000-0000-4000-8000-000000000001';
  v_p1   jsonb;
  v_p2   jsonb;
  v_plan text;
BEGIN
  PERFORM _rm_reset();

  v_p1 := _rm_json(owner, 'SELECT platform_invoices_list(NULL, NULL, NULL, NULL, NULL, 2, 0)::text');
  v_p2 := _rm_json(owner, 'SELECT platform_invoices_list(NULL, NULL, NULL, NULL, NULL, 2, 2)::text');
  PERFORM _rm_ok('paging: total is the whole set, items are the page, and two pages do not overlap',
    (v_p1 ->> 'total')::int = 7 AND (v_p2 ->> 'total')::int = 7
    AND jsonb_array_length(v_p1 -> 'items') = 2
    AND jsonb_array_length(v_p2 -> 'items') = 2
    AND NOT EXISTS (SELECT 1
                      FROM jsonb_array_elements(v_p1 -> 'items') a
                      JOIN jsonb_array_elements(v_p2 -> 'items') b
                        ON (a ->> 'id') = (b ->> 'id')));

  /*
    The order is fixed at newest period first: the three .order() calls the
    screen used to send PostgREST. There is no sort argument, deliberately.

    The whole sequence rather than four spot values, and read through `'items'`.
    The first version of these lines asked `v_p1 -> 0`, but the function answers
    an **object** and `jsonb -> integer` is the *array* accessor, so every one of
    them was NULL — and `_rm_ok` refuses NULL on the principle that a check which
    could not be evaluated proved nothing. **That principle is the only reason
    this surfaced instead of sitting green for ever**, which is worth knowing
    before anyone relaxes it the next time a NULL is inconvenient.
  */
  PERFORM _rm_ok('paging: the whole list is newest period first, with no sort argument to give',
    (SELECT array_agg((t.i ->> 'invoice_month')::int ORDER BY t.o)
       FROM jsonb_array_elements(
              _rm_json(owner, 'SELECT platform_invoices_list(NULL, NULL, NULL, NULL, NULL, 100, 0)::text')
                -> 'items') WITH ORDINALITY AS t(i, o))
      = ARRAY[9, 9, 8, 7, 6, 5, 4]);

  /*
    Two invoices share a period — company A's September and company B's — and
    `id` is what separates them. It is the primary key, so
    `ORDER BY invoice_year DESC, invoice_month DESC, created_at DESC, id` is
    **total**: no two rows tie on all four legs, and page 2 can never repeat a
    row from page 1. A list an operator pages through has to be totally ordered,
    and this is the leg that makes it so.

    **`created_at DESC` is the one leg this fixture cannot exercise, and it is
    not redundant.** All seven rows come from one multi-row INSERT, so they share
    a transaction timestamp and that leg always ties here. It earns its place on
    real data, where two invoices of the same period in different companies are
    ordered by when they were raised rather than by the accident of a uuid — the
    uuid is the last resort, not the intended sort. Do not delete it as dead.
  */
  PERFORM _rm_ok('paging: a shared period is broken by id, ascending, which is what makes the order total',
    (v_p1 -> 'items' -> 0 ->> 'invoice_month')::int = 9
    AND (v_p1 -> 'items' -> 1 ->> 'invoice_month')::int = 9
    AND (v_p1 -> 'items' -> 0 ->> 'id')::uuid < (v_p1 -> 'items' -> 1 ->> 'id')::uuid
    AND (v_p2 -> 'items' -> 0 ->> 'invoice_month')::int = 8
    AND (v_p2 -> 'items' -> 1 ->> 'invoice_month')::int = 7);

  -- And the property itself, measured rather than argued: every page of the
  -- list, two rows at a time, holds all seven invoices exactly once. Four
  -- audited calls, at offsets 0, 2, 4 and 6; the last page holds one row.
  PERFORM _rm_ok('paging: the four pages together hold every invoice exactly once',
    (SELECT count(*) = 7 AND count(DISTINCT p.id) = 7
       FROM (SELECT (t.i ->> 'id') AS id
               FROM generate_series(0, 6, 2) AS g(off)
               CROSS JOIN LATERAL jsonb_array_elements(
                 _rm_json(owner, format(
                   'SELECT platform_invoices_list(NULL, NULL, NULL, NULL, NULL, 2, %s)::text', g.off))
                   -> 'items') AS t(i)) AS p));

  -- The summary is the same whichever page is asked for: it describes the set,
  -- not the page.
  PERFORM _rm_ok('paging: the summary belongs to the set, not to the page',
    (v_p1 -> 'summary') = (v_p2 -> 'summary'));

  v_plan := _rm_billing_plan('invoices');
  RAISE NOTICE 'invoice list plan:%', E'\n' || v_plan;
  PERFORM _rm_ok('invoices: the plan reads neither fahrtenbuch_trips nor receipts nor company_settings',
    v_plan !~ 'fahrtenbuch_trips' AND v_plan !~ 'receipts' AND v_plan !~ 'company_settings');
  -- The three counts and the year list read the table once each, which is what
  -- the figures are; what must never appear is a scan per company row.
  PERFORM _rm_ok('invoices: subscription_invoices is scanned a fixed number of times, never once per company',
    _rm_scans(v_plan, 'subscription_invoices') BETWEEN 1 AND 4
    AND _rm_scans(v_plan, 'companies') BETWEEN 1 AND 2);

  v_plan := _rm_billing_plan('subscriptions');
  RAISE NOTICE 'subscription list plan:%', E'\n' || v_plan;
  PERFORM _rm_ok('subscriptions: the plan reads no tenant table',
    v_plan !~ 'fahrtenbuch_trips' AND v_plan !~ 'receipts'
    AND v_plan !~ 'drivers' AND v_plan !~ 'company_settings');
  PERFORM _rm_ok('subscriptions: company_subscriptions is scanned twice at most — the page and the active counts',
    _rm_scans(v_plan, 'company_subscriptions') BETWEEN 1 AND 2);
END $$;

DO $$ BEGIN RAISE NOTICE '── platform-readmodels: all checks passed ──'; END $$;

ROLLBACK;
