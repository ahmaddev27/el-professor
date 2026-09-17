/*
  The platform write RPCs (plan 3.5): who may call each one, and what each call
  leaves in the audit log.

  Runs after assertions.sql and the matrix, against the same throwaway database,
  as supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it see
  the database as the seeds left it.

  What is covered, in order:

    1. grants      anon holds EXECUTE on none of them; the service role, which
                   has no auth.uid() to be an actor, holds none either
    2. role x RPC  every RPC against every platform role and a company admin:
                   the capability decides, not the staff row's existence
    3. audit       exactly one row per call, with the caller as actor, its role,
                   the company it touched, and the values before and after
    4. refusals    a refused call is audited too, for a company admin as well
                   (actor recorded, role NULL), and the denied rows are capped
    5. staff       the last active owner is protected, and no role other than
                   owner can be created or re-enabled before plan step 3.3
    6. edge door   platform_audit_record accepts only the listed actions, lets a
                   role without the capability record nothing but its refusal,
                   and refuses a namespace the database writes itself
    7. money       an amount in integer cents is stored as euros with two
                   decimals, the column's own unit
    8. approval    approving writes the approval columns and nothing else — no
                   code and no mail, as the screen behaved (owner, 15.09.2026)

  The probes of section 2 each run in a subtransaction that is rolled back, so
  one principal never sees another's writes and the order of the table does not
  matter.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in platform-authority.sql) ────────────────────────────

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS banned_until       timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at         timestamptz,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT now();

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _pr_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _pr_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

/** A user id becomes that authenticated caller; NULL becomes anon. */
CREATE OR REPLACE FUNCTION _pr_become(p_user uuid, p_service boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pr_reset();
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
  Runs p_sql as the principal in a subtransaction that is always rolled back,
  and returns the scalar it produced, or `ERR <sqlstate> <message>`.
*/
CREATE OR REPLACE FUNCTION _pr_try(p_user uuid, p_sql text, p_service boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _pr_become(p_user, p_service);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
    RAISE EXCEPTION USING ERRCODE = 'ZZ005', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ005' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _pr_reset();
  RETURN v_out;
END $$;

/** Like _pr_try, but keeps what the statement did. */
CREATE OR REPLACE FUNCTION _pr_do(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _pr_become(p_user);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _pr_reset();
  RETURN v_out;
END $$;

/** 'Y' when the answer says success, 'N' when it says failure, else the answer. */
CREATE OR REPLACE FUNCTION _pr_yn(p_answer text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  IF p_answer LIKE 'ERR 42501 permission denied%' THEN RETURN 'P'; END IF;
  IF p_answer LIKE 'ERR%' THEN RETURN p_answer; END IF;
  RETURN CASE WHEN (p_answer::jsonb ->> 'success') = 'true' THEN 'Y' ELSE 'N' END;
EXCEPTION WHEN OTHERS THEN
  RETURN p_answer;
END $$;

/** The reason a refused answer carries. */
CREATE OR REPLACE FUNCTION _pr_reason(p_answer text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN p_answer::jsonb ->> 'reason';
EXCEPTION WHEN OTHERS THEN
  RETURN p_answer;
END $$;

-- ─── principals ─────────────────────────────────────────────────────────────

/*
    3b..01 pr-owner      owner
    3b..02 pr-owner-two  owner, so the last-owner check has something to remove
    3b..03 pr-support    support
    3b..04 pr-billing    billing
    3b..05 pr-readonly   read_only
    3b..06 pr-target     no staff row, no company: what staff.manage acts on
    3b..07 pr-in-company a company member, so "already in a company" is covered
*/
INSERT INTO auth.users (id, email, email_confirmed_at, created_at) VALUES
  ('3b000000-0000-4000-8000-000000000001', 'pr-owner@test.invalid',      now(), now() - interval '90 days'),
  ('3b000000-0000-4000-8000-000000000002', 'pr-owner-two@test.invalid',  now(), now() - interval '90 days'),
  ('3b000000-0000-4000-8000-000000000003', 'pr-support@test.invalid',    now(), now() - interval '90 days'),
  ('3b000000-0000-4000-8000-000000000004', 'pr-billing@test.invalid',    now(), now() - interval '90 days'),
  ('3b000000-0000-4000-8000-000000000005', 'pr-readonly@test.invalid',   now(), now() - interval '90 days'),
  ('3b000000-0000-4000-8000-000000000006', 'pr-target@test.invalid',     now(), now() - interval '90 days'),
  ('3b000000-0000-4000-8000-000000000007', 'pr-in-company@test.invalid', now(), now() - interval '90 days');

-- Platform profiles carry no company and the least role the product has:
-- platform rights come from platform_staff, never from the profile.
INSERT INTO user_profiles (user_id, email, full_name, role, company_id, is_super_admin, status) VALUES
  ('3b000000-0000-4000-8000-000000000001', 'pr-owner@test.invalid',      'PR Owner',     'viewer', NULL, false, 'active'),
  ('3b000000-0000-4000-8000-000000000002', 'pr-owner-two@test.invalid',  'PR Owner Two', 'viewer', NULL, false, 'active'),
  ('3b000000-0000-4000-8000-000000000003', 'pr-support@test.invalid',    'PR Support',   'viewer', NULL, false, 'active'),
  ('3b000000-0000-4000-8000-000000000004', 'pr-billing@test.invalid',    'PR Billing',   'viewer', NULL, false, 'active'),
  ('3b000000-0000-4000-8000-000000000005', 'pr-readonly@test.invalid',   'PR Read',      'viewer', NULL, false, 'active'),
  ('3b000000-0000-4000-8000-000000000006', 'pr-target@test.invalid',     'PR Target',    'viewer', NULL, false, 'active'),
  ('3b000000-0000-4000-8000-000000000007', 'pr-in-company@test.invalid', 'PR In Co',     'viewer',
     'c0000000-0000-4000-8000-00000000000a', false, 'active');

INSERT INTO app_private.platform_staff (user_id, role, note) VALUES
  ('3b000000-0000-4000-8000-000000000001', 'owner',     'pr'),
  ('3b000000-0000-4000-8000-000000000002', 'owner',     'pr'),
  ('3b000000-0000-4000-8000-000000000003', 'support',   'pr'),
  ('3b000000-0000-4000-8000-000000000004', 'billing',   'pr'),
  ('3b000000-0000-4000-8000-000000000005', 'read_only', 'pr');

-- ─── fixtures the write RPCs act on ─────────────────────────────────────────

-- A trial to extend, so platform_company_extend_trial has something to move.
UPDATE companies SET trial_end = now() + interval '7 days'
 WHERE id = 'c0000000-0000-4000-8000-00000000000a';

INSERT INTO subscription_plans (id, name, monthly_price, included_cars, drivers_per_car_limit, is_active)
VALUES ('3b100000-0000-4000-8000-000000000001', 'PR Plan', 49, 5, 4, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO company_subscriptions (id, company_id, plan_id, monthly_price)
VALUES ('3b200000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
        '3b100000-0000-4000-8000-000000000001', 49)
ON CONFLICT (id) DO NOTHING;

INSERT INTO subscription_invoices
  (id, company_id, subscription_id, invoice_month, invoice_year, invoice_number, amount, due_date, status)
VALUES
  ('3b300000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
   '3b200000-0000-4000-8000-000000000001', 7, 2026, 'INV-2026-3501', 49, '2026-07-31', 'open')
ON CONFLICT (id) DO NOTHING;

INSERT INTO activation_codes (id, code_hash, duration_type, expires_at, created_by, company_id)
VALUES ('3b400000-0000-4000-8000-000000000001', encode(sha256('pr-code'::bytea), 'hex'), '1_monat',
        now() + interval '1 day', '50000000-0000-4000-8000-000000000001',
        'c0000000-0000-4000-8000-00000000000a')
ON CONFLICT (id) DO NOTHING;

INSERT INTO discount_codes (id, code, discount_type, discount_value, usage_mode, audience_type, active)
VALUES ('3b500000-0000-4000-8000-000000000001', 'PR-DISC', 'percentage', 5, 'once', 'multiple', true)
ON CONFLICT (id) DO NOTHING;

-- ─── 1. grants ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'public.platform_company_create(text,text,text,text,text,text,text,text,text,text)',
      'public.platform_company_update(uuid,text,text,text,text,text,text,text,text,text,text)',
      'public.platform_company_set_approval(uuid,text,text)',
      'public.platform_company_set_status(uuid,text)',
      'public.platform_company_lifecycle(uuid,text)',
      'public.platform_company_extend_trial(uuid,integer)',
      'public.platform_company_set_plan(uuid,text,text,integer)',
      'public.platform_subscription_assign(uuid,uuid,integer,text)',
      'public.platform_invoice_mark_paid(uuid,bigint,timestamptz,text)',
      'public.platform_invoice_mark_unpaid(uuid)',
      'public.platform_invoice_cancel(uuid)',
      'public.platform_discount_code_save(uuid,jsonb)',
      'public.platform_discount_code_set_active(uuid,boolean)',
      'public.platform_discount_code_delete(uuid)',
      'public.platform_staff_add(uuid,text,text)',
      'public.platform_staff_disable(uuid)',
      'public.platform_staff_enable(uuid)'
    ]) AS sig
  LOOP
    PERFORM _pr_ok(format('EXECUTE on %s: anon no, authenticated yes, service_role no', r.sig),
      has_function_privilege('anon',          r.sig::regprocedure, 'EXECUTE') = false
      AND has_function_privilege('authenticated', r.sig::regprocedure, 'EXECUTE') = true
      -- The service role has no auth.uid(): it could be authorized by nothing
      -- and recorded as nobody.
      AND has_function_privilege('service_role',  r.sig::regprocedure, 'EXECUTE') = false);
  END LOOP;

  PERFORM _pr_ok('anon calling a platform write RPC is refused for lack of EXECUTE',
    _pr_try(NULL, $q$SELECT platform_company_set_status('c0000000-0000-4000-8000-00000000000a', 'active')::text$q$)
      LIKE 'ERR 42501%');
  PERFORM _pr_ok('the service role may not call one either',
    _pr_try(NULL, $q$SELECT platform_staff_add('3b000000-0000-4000-8000-000000000006')::text$q$, true)
      LIKE 'ERR 42501%');
END $$;

-- ─── 2. role × RPC ──────────────────────────────────────────────────────────

DO $$
DECLARE
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  support  constant uuid := '3b000000-0000-4000-8000-000000000003';
  billing  constant uuid := '3b000000-0000-4000-8000-000000000004';
  readonly constant uuid := '3b000000-0000-4000-8000-000000000005';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  r        record;
  p        record;
  v_want   text;
  v_got    text;
BEGIN
  -- want: one character per principal, in the order owner, support, billing,
  -- read_only, company admin. Y = the RPC answered success.
  CREATE TEMP TABLE _pr_rpc (ord serial, label text, stmt text, want text) ON COMMIT DROP;

  INSERT INTO _pr_rpc (label, stmt, want) VALUES
    -- companies.lifecycle: owners only, open decision D2
    ('platform_company_create',
     $q$SELECT platform_company_create('PR Neu', 'pr-neu')::text$q$, 'YNNNN'),
    ('platform_company_update',
     $q$SELECT platform_company_update('c0000000-0000-4000-8000-00000000000a', 'Test A', 'test-a')::text$q$, 'YNNNN'),
    ('platform_company_set_approval(approve)',
     $q$SELECT platform_company_set_approval('c0000000-0000-4000-8000-00000000000a', 'approve')::text$q$, 'YNNNN'),
    ('platform_company_set_approval(reject)',
     $q$SELECT platform_company_set_approval('c0000000-0000-4000-8000-00000000000a', 'reject', 'pr')::text$q$, 'YNNNN'),
    ('platform_company_set_status(suspended)',
     $q$SELECT platform_company_set_status('c0000000-0000-4000-8000-00000000000a', 'suspended')::text$q$, 'YNNNN'),
    ('platform_company_lifecycle(suspend)',
     $q$SELECT platform_company_lifecycle('c0000000-0000-4000-8000-00000000000a', 'suspend')::text$q$, 'YNNNN'),
    ('platform_company_lifecycle(archive)',
     $q$SELECT platform_company_lifecycle('c0000000-0000-4000-8000-00000000000a', 'archive')::text$q$, 'YNNNN'),
    ('platform_company_extend_trial(7)',
     $q$SELECT platform_company_extend_trial('c0000000-0000-4000-8000-00000000000a', 7)::text$q$, 'YNNNN'),
    -- billing.manage: owners and billing
    ('platform_company_set_plan',
     $q$SELECT platform_company_set_plan('c0000000-0000-4000-8000-00000000000a', 'premium')::text$q$, 'YNYNN'),
    ('platform_subscription_assign',
     $q$SELECT platform_subscription_assign('c0000000-0000-4000-8000-00000000000a', '3b100000-0000-4000-8000-000000000001')::text$q$, 'YNYNN'),
    ('platform_invoice_mark_paid',
     $q$SELECT platform_invoice_mark_paid('3b300000-0000-4000-8000-000000000001', 4900)::text$q$, 'YNYNN'),
    ('platform_invoice_cancel',
     $q$SELECT platform_invoice_cancel('3b300000-0000-4000-8000-000000000001')::text$q$, 'YNYNN'),
    ('update_company_subscription_manual',
     $q$SELECT update_company_subscription_manual('c0000000-0000-4000-8000-00000000000b', 'active')::text$q$, 'YNYNN'),
    -- codes.manage: owners and billing
    ('revoke_activation_code',
     $q$SELECT revoke_activation_code('3b400000-0000-4000-8000-000000000001')::text$q$, 'YNYNN'),
    ('hide_activation_code',
     $q$SELECT hide_activation_code('3b400000-0000-4000-8000-000000000001', 'pr')::text$q$, 'YNYNN'),
    ('delete_activation_code',
     $q$SELECT delete_activation_code('3b400000-0000-4000-8000-000000000001')::text$q$, 'YNYNN'),
    ('platform_discount_code_save(create)',
     $q$SELECT platform_discount_code_save(NULL, '{"code":"PR-NEW","discount_type":"percentage","discount_value":5,"usage_mode":"once","audience_type":"multiple"}'::jsonb)::text$q$, 'YNYNN'),
    ('platform_discount_code_save(update)',
     $q$SELECT platform_discount_code_save('3b500000-0000-4000-8000-000000000001', '{"discount_value":7}'::jsonb)::text$q$, 'YNYNN'),
    ('platform_discount_code_set_active(false)',
     $q$SELECT platform_discount_code_set_active('3b500000-0000-4000-8000-000000000001', false)::text$q$, 'YNYNN'),
    ('platform_discount_code_delete',
     $q$SELECT platform_discount_code_delete('3b500000-0000-4000-8000-000000000001')::text$q$, 'YNYNN'),
    -- staff.manage: owners only
    ('platform_staff_add(owner)',
     $q$SELECT platform_staff_add('3b000000-0000-4000-8000-000000000006', 'owner', 'pr')::text$q$, 'YNNNN'),
    ('platform_staff_disable(another owner)',
     $q$SELECT platform_staff_disable('3b000000-0000-4000-8000-000000000002')::text$q$, 'YNNNN');

  FOR r IN SELECT * FROM _pr_rpc ORDER BY ord LOOP
    v_got := '';
    FOR p IN
      SELECT * FROM (VALUES
        (1, owner), (2, support), (3, billing), (4, readonly), (5, admin_a)
      ) AS t(pos, uid) ORDER BY pos
    LOOP
      v_got := v_got || _pr_yn(_pr_try(p.uid, r.stmt));
    END LOOP;
    IF v_got IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'FAIL: % — expected % (owner, support, billing, read_only, company admin), got %',
        r.label, r.want, v_got;
    END IF;
    RAISE NOTICE 'ok  role x rpc  %  (%)', r.label, r.want;
  END LOOP;

  -- The refusal is the capability's, not the staff row's: support holds a row
  -- and is still refused, and says so with the same reason a stranger gets.
  PERFORM _pr_ok('a refused platform role is told it lacks permission, not that the row is missing',
    _pr_reason(_pr_try(support, $q$SELECT platform_company_set_status('c0000000-0000-4000-8000-00000000000a', 'active')::text$q$)) = 'denied'
    AND _pr_reason(_pr_try(admin_a, $q$SELECT platform_company_set_status('c0000000-0000-4000-8000-00000000000a', 'active')::text$q$)) = 'denied');
END $$;

-- ─── 3. one audit row per call ──────────────────────────────────────────────

DO $$
DECLARE
  owner  constant uuid := '3b000000-0000-4000-8000-000000000001';
  co_a   constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_from bigint;
  v_rows bigint;
  v_row  app_private.platform_audit_log%ROWTYPE;
BEGIN
  SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;

  PERFORM _pr_ok('an owner sets the status',
    (_pr_do(owner, format('SELECT platform_company_set_status(%L, %L)::text', co_a, 'suspended'))::jsonb ->> 'success') = 'true');

  SELECT count(*) INTO v_rows FROM app_private.platform_audit_log WHERE id > v_from;
  PERFORM _pr_ok(format('exactly one audit row was written, got %s', v_rows), v_rows = 1);

  SELECT * INTO v_row FROM app_private.platform_audit_log WHERE id > v_from;
  PERFORM _pr_ok('the row names the action, the actor, its role, the company and the outcome',
    v_row.action = 'company.set_status'
    AND v_row.category = 'write'
    AND v_row.outcome = 'ok'
    AND v_row.actor_user_id = owner
    AND v_row.actor_role = 'owner'
    AND v_row.company_id = co_a
    AND v_row.target_type = 'company'
    AND v_row.target_id = co_a::text);
  PERFORM _pr_ok('the row carries the value before and the value after',
    v_row.before_value ->> 'status' IS NOT NULL
    AND v_row.after_value ->> 'status' = 'suspended');

  -- An error inside a call that passed authorization is recorded as an error,
  -- with its reason, and the call changes nothing.
  SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;
  PERFORM _pr_ok('extending a trial on a company that has none answers no_trial',
    _pr_reason(_pr_do(owner, format('SELECT platform_company_extend_trial(%L, 7)::text',
      'c0000000-0000-4000-8000-00000000000b'))) = 'no_trial');
  SELECT * INTO v_row FROM app_private.platform_audit_log WHERE id > v_from;
  PERFORM _pr_ok('…and that is one audit row, outcome error, naming the reason',
    v_row.action = 'company.extend_trial' AND v_row.outcome = 'error'
    AND v_row.after_value ->> 'reason' = 'no_trial');
END $$;

-- ─── 4. a refused call is audited too ───────────────────────────────────────

DO $$
DECLARE
  support constant uuid := '3b000000-0000-4000-8000-000000000003';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_from  bigint;
  v_row   app_private.platform_audit_log%ROWTYPE;
  v_rows  bigint;
  i       integer;
BEGIN
  SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;
  PERFORM _pr_do(support, format('SELECT platform_company_lifecycle(%L, %L)::text', co_a, 'archive'));
  SELECT * INTO v_row FROM app_private.platform_audit_log WHERE id > v_from;
  PERFORM _pr_ok('a platform role without the capability leaves a denied row naming what it lacked',
    v_row.action = 'company.archive' AND v_row.outcome = 'denied'
    AND v_row.actor_user_id = support AND v_row.actor_role = 'support'
    AND v_row.after_value ->> 'capability' = 'companies.lifecycle');

  SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;
  PERFORM _pr_do(admin_a, format('SELECT platform_company_set_status(%L, %L)::text', co_a, 'active'));
  SELECT * INTO v_row FROM app_private.platform_audit_log WHERE id > v_from;
  PERFORM _pr_ok('a company admin is recorded as the actor with no platform role',
    v_row.outcome = 'denied' AND v_row.actor_user_id = admin_a AND v_row.actor_role IS NULL);

  -- Calling in a loop cannot grow the log without bound.
  SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;
  FOR i IN 1 .. 45 LOOP
    PERFORM _pr_do(admin_a, format('SELECT platform_company_set_status(%L, %L)::text', co_a, 'active'));
  END LOOP;
  SELECT count(*) INTO v_rows FROM app_private.platform_audit_log WHERE id > v_from;
  PERFORM _pr_ok(format('45 refused calls wrote at most 30 rows, got %s', v_rows), v_rows <= 30);
END $$;

-- ─── 5. staff: the last owner, and no other role before 3.3 ─────────────────

DO $$
DECLARE
  owner   constant uuid := '3b000000-0000-4000-8000-000000000001';
  target  constant uuid := '3b000000-0000-4000-8000-000000000006';
  in_co   constant uuid := '3b000000-0000-4000-8000-000000000007';
  support constant uuid := '3b000000-0000-4000-8000-000000000003';
  seeded  constant uuid := '50000000-0000-4000-8000-000000000001';
  v_from  bigint;
  v_row   app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _pr_ok('adding an existing account as owner succeeds',
    (_pr_do(owner, format('SELECT platform_staff_add(%L, %L, %L)::text', target, 'owner', 'pr'))::jsonb ->> 'success') = 'true');
  PERFORM _pr_reset();
  PERFORM _pr_ok('…and the account now holds an active owner row',
    app_private.platform_staff_role_of(target) = 'owner');
  PERFORM _pr_ok('adding it twice answers already_staff',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_add(%L)::text', target))) = 'already_staff');

  -- Rule 8 of plan 3.5: every active staff role still holds an owner's writes
  -- through the older policies, so nothing may create another role yet.
  SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;
  PERFORM _pr_ok('adding a support row is refused until plan step 3.3',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_add(%L, %L)::text',
      '3b000000-0000-4000-8000-000000000007', 'support'))) = 'role_requires_3_3');
  SELECT * INTO v_row FROM app_private.platform_audit_log WHERE id > v_from;
  PERFORM _pr_ok('…and that refusal is audited as denied, in the staff category',
    v_row.category = 'staff' AND v_row.action = 'platform_staff.add' AND v_row.outcome = 'denied');
  PERFORM _pr_reset();
  PERFORM _pr_ok('…and no staff row was written for it',
    NOT EXISTS (SELECT 1 FROM app_private.platform_staff s WHERE s.user_id = in_co));

  PERFORM _pr_ok('an account that belongs to a company is refused',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_add(%L)::text', in_co))) = 'account_in_company');
  PERFORM _pr_ok('an account that does not exist is refused',
    _pr_reason(_pr_do(owner, 'SELECT platform_staff_add(''3b000000-0000-4000-8000-0000000000ff'')::text')) = 'account_not_found');

  -- Disabling a non-owner only takes power away, so it stays allowed; enabling
  -- one would give it an owner's writes again, so it does not.
  PERFORM _pr_ok('disabling a support row succeeds',
    (_pr_do(owner, format('SELECT platform_staff_disable(%L)::text', support))::jsonb ->> 'success') = 'true');
  PERFORM _pr_ok('re-enabling it is refused until plan step 3.3',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_enable(%L)::text', support))) = 'role_requires_3_3');
  PERFORM _pr_ok('disabling it twice answers already_disabled',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_disable(%L)::text', support))) = 'already_disabled');

  -- Leave exactly one active owner: this caller.
  PERFORM _pr_ok('the other owners can be disabled while one remains',
    (_pr_do(owner, format('SELECT platform_staff_disable(%L)::text', target))::jsonb ->> 'success') = 'true'
    AND (_pr_do(owner, format('SELECT platform_staff_disable(%L)::text', seeded))::jsonb ->> 'success') = 'true'
    AND (_pr_do(owner, format('SELECT platform_staff_disable(%L)::text',
                              '3b000000-0000-4000-8000-000000000002'))::jsonb ->> 'success') = 'true');

  SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;
  PERFORM _pr_ok('the last active owner cannot disable itself',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_disable(%L)::text', owner))) = 'last_owner');
  SELECT * INTO v_row FROM app_private.platform_audit_log WHERE id > v_from;
  PERFORM _pr_ok('…and that refusal is audited as denied',
    v_row.action = 'platform_staff.disable' AND v_row.outcome = 'denied');
  PERFORM _pr_reset();
  PERFORM _pr_ok('…and the owner is still active',
    app_private.platform_staff_role_of(owner) = 'owner');

  -- The RPC answers rather than raising, but the table's own trigger still
  -- refuses the same removal underneath, whichever path attempts it.
  BEGIN
    DELETE FROM app_private.platform_staff WHERE user_id = owner;
    RAISE EXCEPTION 'FAIL: the last active owner was deleted directly';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    PERFORM _pr_ok('the trigger refuses deleting the last active owner directly',
      SQLERRM LIKE '%last active owner%');
  END;
END $$;

-- ─── 6. the edge functions' door ────────────────────────────────────────────

DO $$
DECLARE
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  readonly constant uuid := '3b000000-0000-4000-8000-000000000005';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _pr_ok('an owner records a listed action',
    _pr_do(owner, $q$SELECT (platform_audit_record('write', 'manage_users.create', 'ok') IS NOT NULL)::text$q$) = 'true');
  PERFORM _pr_ok('an action nobody sends is refused as an argument error',
    _pr_do(owner, $q$SELECT platform_audit_record('write', 'something.else', 'ok')::text$q$) LIKE 'ERR 22023%');
  PERFORM _pr_ok('a namespace the database writes itself is refused',
    _pr_do(owner, $q$SELECT platform_audit_record('write', 'platform_staff.add', 'ok')::text$q$) LIKE 'ERR 22023%'
    AND _pr_do(owner, $q$SELECT platform_audit_record('write', 'legacy.subscription_admin_actions', 'ok')::text$q$) LIKE 'ERR 22023%');
  PERFORM _pr_ok('a category the database keeps for itself is refused',
    _pr_do(owner, $q$SELECT platform_audit_record('staff', 'manage_users.create', 'ok')::text$q$) LIKE 'ERR 22023%');
  PERFORM _pr_ok('the wrong category for a listed action is refused',
    _pr_do(owner, $q$SELECT platform_audit_record('read', 'manage_users.create', 'ok')::text$q$) LIKE 'ERR 22023%');

  -- read_only may open this door — it holds a staff row — so what it may write
  -- through it is exactly its own refusal.
  PERFORM _pr_ok('read_only may record a refusal of an action it cannot perform',
    _pr_do(readonly, $q$SELECT (platform_audit_record('write', 'manage_users.create', 'denied') IS NOT NULL)::text$q$) = 'true');
  PERFORM _pr_ok('…but not an ok or an attempt for it',
    _pr_do(readonly, $q$SELECT platform_audit_record('write', 'manage_users.create', 'ok')::text$q$) LIKE 'ERR 42501%'
    AND _pr_do(readonly, $q$SELECT platform_audit_record('write', 'manage_users.create', 'attempt')::text$q$) LIKE 'ERR 42501%');
  PERFORM _pr_ok('read_only holds business.read, so it may record a read it is allowed',
    _pr_do(readonly, $q$SELECT (platform_audit_record('read', 'manage_users.list', 'ok') IS NOT NULL)::text$q$) = 'true');
  PERFORM _pr_ok('a caller with no staff row writes nothing and is told nothing',
    _pr_do(admin_a, $q$SELECT coalesce(platform_audit_record('write', 'manage_users.create', 'denied')::text, 'null')$q$) = 'null');
END $$;

-- ─── 7. money: cents in, the column's euros out ─────────────────────────────

DO $$
DECLARE
  owner   constant uuid := '3b000000-0000-4000-8000-000000000001';
  inv     constant uuid := '3b300000-0000-4000-8000-000000000001';
  v_row   subscription_invoices%ROWTYPE;
  v_audit app_private.platform_audit_log%ROWTYPE;
  v_from  bigint;
BEGIN
  SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;

  -- 4999 cents is 49,99 €: the rule is that the figure stored is the figure the
  -- operator typed, converted once, never a float sum.
  PERFORM _pr_ok('marking an invoice paid with 4999 cents succeeds',
    (_pr_do(owner, format('SELECT platform_invoice_mark_paid(%L, 4999)::text', inv))::jsonb ->> 'success') = 'true');

  PERFORM _pr_reset();
  SELECT * INTO v_row FROM subscription_invoices WHERE id = inv;
  PERFORM _pr_ok(format('cash_received_amount is 49.99, got %s', v_row.cash_received_amount),
    v_row.cash_received_amount = 49.99);
  PERFORM _pr_ok('the invoice is paid, by the caller', v_row.status = 'paid' AND v_row.paid_by = owner);
  PERFORM _pr_ok('the payment trail kept its German wording',
    EXISTS (SELECT 1 FROM subscription_payment_audit
             WHERE invoice_id = inv AND action = 'marked_paid_cash' AND note LIKE 'Barzahlung von%'));

  SELECT * INTO v_audit FROM app_private.platform_audit_log
   WHERE id > v_from AND action = 'invoice.mark_paid';
  PERFORM _pr_ok('the audit row keeps the amount in cents, as it was sent',
    (v_audit.after_value ->> 'amount_cents')::bigint = 4999);

  PERFORM _pr_ok('marking it paid again is refused as invalid_status',
    _pr_reason(_pr_do(owner, format('SELECT platform_invoice_mark_paid(%L, 4999)::text', inv))) = 'invalid_status');
  PERFORM _pr_ok('a negative or zero amount is refused',
    _pr_reason(_pr_do(owner, format('SELECT platform_invoice_mark_paid(%L, 0)::text', inv))) = 'invalid');

  PERFORM _pr_ok('marking it unpaid clears what the payment wrote',
    (_pr_do(owner, format('SELECT platform_invoice_mark_unpaid(%L)::text', inv))::jsonb ->> 'success') = 'true');
  PERFORM _pr_reset();
  SELECT * INTO v_row FROM subscription_invoices WHERE id = inv;
  PERFORM _pr_ok('…the invoice is open again with no amount and no collector',
    v_row.status = 'open' AND v_row.cash_received_amount IS NULL AND v_row.paid_by IS NULL);
END $$;

-- ─── 8. approval writes the approval columns and nothing else ───────────────

DO $$
DECLARE
  owner  constant uuid := '3b000000-0000-4000-8000-000000000001';
  co_b   constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  v_before companies%ROWTYPE;
  v_after  companies%ROWTYPE;
BEGIN
  PERFORM _pr_reset();
  SELECT * INTO v_before FROM companies WHERE id = co_b;

  PERFORM _pr_ok('rejecting with a reason succeeds',
    (_pr_do(owner, format('SELECT platform_company_set_approval(%L, %L, %L)::text', co_b, 'reject', 'kein Nachweis'))::jsonb ->> 'success') = 'true');
  PERFORM _pr_reset();
  SELECT * INTO v_after FROM companies WHERE id = co_b;
  PERFORM _pr_ok('the approval columns moved and the reason was kept',
    v_after.approval_status = 'rejected' AND v_after.rejection_reason = 'kein Nachweis'
    AND v_after.rejected_by = owner AND v_after.rejected_at IS NOT NULL);
  PERFORM _pr_ok('nothing else about the company changed: no status, plan or subscription',
    v_after.status IS NOT DISTINCT FROM v_before.status
    AND v_after.plan IS NOT DISTINCT FROM v_before.plan
    AND v_after.subscription_status IS NOT DISTINCT FROM v_before.subscription_status
    AND v_after.trial_end IS NOT DISTINCT FROM v_before.trial_end);

  PERFORM _pr_ok('approving clears the rejection reason and records the approver',
    (_pr_do(owner, format('SELECT platform_company_set_approval(%L, %L)::text', co_b, 'approve'))::jsonb ->> 'success') = 'true');
  PERFORM _pr_reset();
  SELECT * INTO v_after FROM companies WHERE id = co_b;
  PERFORM _pr_ok('…and no code was created and no note was stored with it',
    v_after.approval_status = 'approved' AND v_after.rejection_reason IS NULL
    AND v_after.approved_by = owner AND v_after.approval_note IS NULL
    AND NOT EXISTS (SELECT 1 FROM activation_codes WHERE company_id = co_b AND created_at > now() - interval '1 minute'));

  PERFORM _pr_ok('an unknown decision is refused as invalid',
    _pr_reason(_pr_do(owner, format('SELECT platform_company_set_approval(%L, %L)::text', co_b, 'maybe'))) = 'invalid');
  PERFORM _pr_ok('a company that does not exist is not_found',
    _pr_reason(_pr_do(owner, 'SELECT platform_company_set_approval(''c0000000-0000-4000-8000-0000000000ff'', ''approve'')::text')) = 'not_found');
END $$;

ROLLBACK;
