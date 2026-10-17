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
    5. staff       all four roles can be added, disabled and re-enabled, each
                   with its own audit row; the last active owner is protected;
                   and a role outside the four is refused
    5b. set_role   an existing member moves between the four, keeping who
                   granted it, when and the note; the last active owner is not
                   demoted; a missing row, a disabled one, a no-op and an
                   unknown role are each refused with their own reason; and an
                   owner may step back from their own row while another remains
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
    3b..08 pr-cand-sup   ) three more free accounts, so section 5 can add one
    3b..09 pr-cand-bil   ) staff row per role and watch each of the four
    3b..0a pr-cand-ro    ) through add, disable and re-enable
*/
INSERT INTO auth.users (id, email, email_confirmed_at, created_at) VALUES
  ('3b000000-0000-4000-8000-000000000001', 'pr-owner@test.invalid',      now(), now() - interval '90 days'),
  ('3b000000-0000-4000-8000-000000000002', 'pr-owner-two@test.invalid',  now(), now() - interval '90 days'),
  ('3b000000-0000-4000-8000-000000000003', 'pr-support@test.invalid',    now(), now() - interval '90 days'),
  ('3b000000-0000-4000-8000-000000000004', 'pr-billing@test.invalid',    now(), now() - interval '90 days'),
  ('3b000000-0000-4000-8000-000000000005', 'pr-readonly@test.invalid',   now(), now() - interval '90 days'),
  ('3b000000-0000-4000-8000-000000000006', 'pr-target@test.invalid',     now(), now() - interval '90 days'),
  ('3b000000-0000-4000-8000-000000000007', 'pr-in-company@test.invalid', now(), now() - interval '90 days'),
  ('3b000000-0000-4000-8000-000000000008', 'pr-cand-sup@test.invalid',   now(), now() - interval '90 days'),
  ('3b000000-0000-4000-8000-000000000009', 'pr-cand-bil@test.invalid',   now(), now() - interval '90 days'),
  ('3b000000-0000-4000-8000-00000000000a', 'pr-cand-ro@test.invalid',    now(), now() - interval '90 days');

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
     'c0000000-0000-4000-8000-00000000000a', false, 'active'),
  ('3b000000-0000-4000-8000-000000000008', 'pr-cand-sup@test.invalid',   'PR Cand Sup',  'viewer', NULL, false, 'active'),
  ('3b000000-0000-4000-8000-000000000009', 'pr-cand-bil@test.invalid',   'PR Cand Bil',  'viewer', NULL, false, 'active'),
  ('3b000000-0000-4000-8000-00000000000a', 'pr-cand-ro@test.invalid',    'PR Cand RO',   'viewer', NULL, false, 'active');

INSERT INTO app_private.platform_staff (user_id, role, note) VALUES
  ('3b000000-0000-4000-8000-000000000001', 'owner',     'pr'),
  ('3b000000-0000-4000-8000-000000000002', 'owner',     'pr'),
  ('3b000000-0000-4000-8000-000000000003', 'support',   'pr'),
  ('3b000000-0000-4000-8000-000000000004', 'billing',   'pr'),
  ('3b000000-0000-4000-8000-000000000005', 'read_only', 'pr');

-- ─── fixtures the write RPCs act on ─────────────────────────────────────────

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
      'public.platform_staff_enable(uuid)',
      'public.platform_staff_set_role(uuid,text,text)'
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
    -- companies.lifecycle: owners and support (D2, answered 15.10.2026)
    ('platform_company_create',
     $q$SELECT platform_company_create('PR Neu', 'pr-neu')::text$q$, 'YYNNN'),
    ('platform_company_update',
     $q$SELECT platform_company_update('c0000000-0000-4000-8000-00000000000a', 'Test A', 'test-a')::text$q$, 'YYNNN'),
    ('platform_company_set_approval(approve)',
     $q$SELECT platform_company_set_approval('c0000000-0000-4000-8000-00000000000a', 'approve')::text$q$, 'YYNNN'),
    ('platform_company_set_approval(reject)',
     $q$SELECT platform_company_set_approval('c0000000-0000-4000-8000-00000000000a', 'reject', 'pr')::text$q$, 'YYNNN'),
    ('platform_company_set_status(suspended)',
     $q$SELECT platform_company_set_status('c0000000-0000-4000-8000-00000000000a', 'suspended')::text$q$, 'YYNNN'),
    ('platform_company_lifecycle(suspend)',
     $q$SELECT platform_company_lifecycle('c0000000-0000-4000-8000-00000000000a', 'suspend')::text$q$, 'YYNNN'),
    ('platform_company_lifecycle(archive)',
     $q$SELECT platform_company_lifecycle('c0000000-0000-4000-8000-00000000000a', 'archive')::text$q$, 'YYNNN'),
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
     $q$SELECT platform_staff_disable('3b000000-0000-4000-8000-000000000002')::text$q$, 'YNNNN'),
    -- 20260923140000. Moving the seeded support row to billing: a change no
    -- role but owner may make, and one the owner may make because two active
    -- owners remain at this point, so nothing here is a last-owner refusal.
    ('platform_staff_set_role(support → billing)',
     $q$SELECT platform_staff_set_role('3b000000-0000-4000-8000-000000000003', 'billing')::text$q$, 'YNNNN');

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

  -- The refusal is the capability's, not the staff row's: billing holds a row
  -- and is still refused (support no longer is: D2 was answered 15.10.2026), and says so with the same reason a stranger gets.
  PERFORM _pr_ok('a refused platform role is told it lacks permission, not that the row is missing',
    _pr_reason(_pr_try(billing, $q$SELECT platform_company_set_status('c0000000-0000-4000-8000-00000000000a', 'active')::text$q$)) = 'denied'
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

  -- There is no trial to extend (20261015170000 dropped the RPC), so the call
  -- cannot be made at all, and a status of 'trial' is refused as invalid.
  PERFORM _pr_ok('platform_company_extend_trial does not exist any more',
    to_regprocedure('public.platform_company_extend_trial(uuid,integer)') IS NULL);
  PERFORM _pr_ok('setting a company to status trial is refused as invalid, and writes no company row',
    _pr_reason(_pr_do(owner, format('SELECT platform_company_set_status(%L, %L)::text',
      'c0000000-0000-4000-8000-00000000000b', 'trial'))) = 'invalid');
END $$;

-- ─── 4. a refused call is audited too ───────────────────────────────────────

DO $$
DECLARE
  billing constant uuid := '3b000000-0000-4000-8000-000000000004';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_from  bigint;
  v_row   app_private.platform_audit_log%ROWTYPE;
  v_rows  bigint;
  i       integer;
BEGIN
  SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;
  PERFORM _pr_do(billing, format('SELECT platform_company_lifecycle(%L, %L)::text', co_a, 'archive'));
  SELECT * INTO v_row FROM app_private.platform_audit_log WHERE id > v_from;
  PERFORM _pr_ok('a platform role without the capability leaves a denied row naming what it lacked',
    v_row.action = 'company.archive' AND v_row.outcome = 'denied'
    AND v_row.actor_user_id = billing AND v_row.actor_role = 'billing'
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

-- ─── 5. staff: all four roles, and the last owner ───────────────────────────

/*
  20260923110000 lifted the `role_requires_3_3` guard (owner's decision,
  23.09.2026), so `platform_staff_add` writes any of the four roles and
  `platform_staff_enable` restores any of them. What did **not** move is the
  last-active-owner guard, the argument contract, the audit row per call, and
  the capability the caller needs.
*/
DO $$
DECLARE
  owner   constant uuid := '3b000000-0000-4000-8000-000000000001';
  target  constant uuid := '3b000000-0000-4000-8000-000000000006';
  in_co   constant uuid := '3b000000-0000-4000-8000-000000000007';
  support constant uuid := '3b000000-0000-4000-8000-000000000003';
  seeded  constant uuid := '50000000-0000-4000-8000-000000000001';
  -- One free account per role this section grants, so each of the four walks
  -- add → disable → re-enable on a row of its own.
  cand    constant uuid[] := ARRAY['3b000000-0000-4000-8000-000000000006',
                                   '3b000000-0000-4000-8000-000000000008',
                                   '3b000000-0000-4000-8000-000000000009',
                                   '3b000000-0000-4000-8000-00000000000a'];
  -- Named staff_roles, not roles: `roles` is also a table in this database.
  staff_roles constant text[] := ARRAY['owner', 'support', 'billing', 'read_only'];
  v_from  bigint;
  v_row   app_private.platform_audit_log%ROWTYPE;
  v_role  text;
  v_user  uuid;
  i       integer;
BEGIN
  PERFORM _pr_ok('adding an existing account as owner succeeds',
    (_pr_do(owner, format('SELECT platform_staff_add(%L, %L, %L)::text', target, 'owner', 'pr'))::jsonb ->> 'success') = 'true');
  PERFORM _pr_reset();
  PERFORM _pr_ok('…and the account now holds an active owner row',
    app_private.platform_staff_role_of(target) = 'owner');
  PERFORM _pr_ok('adding it twice answers already_staff',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_add(%L)::text', target))) = 'already_staff');

  -- Each of the other three roles: added, recorded with its own role, disabled
  -- and re-enabled. `owner` is index 1 and was added above.
  FOR i IN 2..4 LOOP
    v_role := staff_roles[i];
    v_user := cand[i];

    SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;
    PERFORM _pr_ok(format('adding a %s row succeeds', v_role),
      (_pr_do(owner, format('SELECT platform_staff_add(%L, %L, %L)::text', v_user, v_role, 'pr'))::jsonb ->> 'success') = 'true');
    PERFORM _pr_reset();
    PERFORM _pr_ok(format('…and the account holds an active %s row', v_role),
      app_private.platform_staff_role_of(v_user) = v_role);
    PERFORM _pr_ok(format('…with the caller recorded as who granted it (%s)', v_role),
      EXISTS (SELECT 1 FROM app_private.platform_staff s WHERE s.user_id = v_user AND s.created_by = owner));

    -- The function's own row, and the table trigger's, both name the role.
    PERFORM _pr_ok(format('…and platform_staff.add is audited ok, naming the %s role', v_role),
      EXISTS (SELECT 1 FROM app_private.platform_audit_log l
               WHERE l.id > v_from AND l.category = 'staff' AND l.action = 'platform_staff.add'
                 AND l.outcome = 'ok' AND l.actor_user_id = owner AND l.actor_role = 'owner'
                 AND l.target_type = 'platform_staff' AND l.target_id = v_user::text
                 AND l.after_value ->> 'role' = v_role));

    PERFORM _pr_ok(format('disabling a %s row succeeds', v_role),
      (_pr_do(owner, format('SELECT platform_staff_disable(%L)::text', v_user))::jsonb ->> 'success') = 'true');
    PERFORM _pr_reset();
    PERFORM _pr_ok(format('…and the %s row no longer answers a role', v_role),
      app_private.platform_staff_role_of(v_user) IS NULL);
    PERFORM _pr_ok(format('disabling the %s row twice answers already_disabled', v_role),
      _pr_reason(_pr_do(owner, format('SELECT platform_staff_disable(%L)::text', v_user))) = 'already_disabled');

    SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;
    PERFORM _pr_ok(format('re-enabling a %s row succeeds since 20260923110000', v_role),
      (_pr_do(owner, format('SELECT platform_staff_enable(%L)::text', v_user))::jsonb ->> 'success') = 'true');
    PERFORM _pr_reset();
    PERFORM _pr_ok(format('…and it holds the %s role again, not owner', v_role),
      app_private.platform_staff_role_of(v_user) = v_role);
    PERFORM _pr_ok(format('…and platform_staff.enable is audited ok for the %s row', v_role),
      EXISTS (SELECT 1 FROM app_private.platform_audit_log l
               WHERE l.id > v_from AND l.category = 'staff' AND l.action = 'platform_staff.enable'
                 AND l.outcome = 'ok' AND l.actor_user_id = owner
                 AND l.target_id = v_user::text
                 AND l.after_value ->> 'role' = v_role
                 AND l.after_value ->> 'disabled_at' IS NULL));
    PERFORM _pr_ok(format('re-enabling the %s row twice answers already_enabled', v_role),
      _pr_reason(_pr_do(owner, format('SELECT platform_staff_enable(%L)::text', v_user))) = 'already_enabled');
  END LOOP;

  -- The guard is gone as a reason, not merely unreachable from the browser.
  PERFORM _pr_ok('no staff call answers role_requires_3_3 any more',
    NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log l
                 WHERE l.action LIKE 'platform_staff.%'
                   AND l.after_value ->> 'reason' = 'role_requires_3_3'));

  -- What replaced it: the argument contract, which never admitted anything but
  -- the four the table's CHECK constraint knows.
  SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;
  PERFORM _pr_ok('a role outside the four is refused as invalid',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_add(%L, %L)::text', in_co, 'admin'))) = 'invalid');
  SELECT * INTO v_row FROM app_private.platform_audit_log WHERE id > v_from;
  PERFORM _pr_ok('…and that refusal is audited as an error, in the staff category',
    v_row.category = 'staff' AND v_row.action = 'platform_staff.add' AND v_row.outcome = 'error'
    AND v_row.after_value ->> 'reason' = 'invalid');
  PERFORM _pr_reset();
  PERFORM _pr_ok('…and no staff row was written for it',
    NOT EXISTS (SELECT 1 FROM app_private.platform_staff s WHERE s.user_id = in_co));
  PERFORM _pr_ok('an empty role is refused as invalid too',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_add(%L, %L)::text', in_co, ''))) = 'invalid');
  PERFORM _pr_ok('a NULL role is refused as invalid',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_add(%L, NULL)::text', in_co))) = 'invalid');

  PERFORM _pr_ok('an account that belongs to a company is refused',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_add(%L)::text', in_co))) = 'account_in_company');
  PERFORM _pr_ok('an account that does not exist is refused',
    _pr_reason(_pr_do(owner, 'SELECT platform_staff_add(''3b000000-0000-4000-8000-0000000000ff'')::text')) = 'account_not_found');

  -- A role the caller does not hold is still refused, whatever the target role:
  -- staff.manage is the owner's alone, and the three new roles do not get it.
  PERFORM _pr_ok('a support account cannot add a staff row of any role',
    _pr_reason(_pr_do(support, format('SELECT platform_staff_add(%L, %L)::text',
      '3b000000-0000-4000-8000-0000000000fe', 'read_only'))) = 'denied');
  PERFORM _pr_ok('a support account cannot re-enable one either',
    _pr_reason(_pr_do(support, format('SELECT platform_staff_enable(%L)::text', target))) = 'denied');

  -- Disabling a non-owner never touches the owner count.
  PERFORM _pr_ok('disabling the seeded support row succeeds',
    (_pr_do(owner, format('SELECT platform_staff_disable(%L)::text', support))::jsonb ->> 'success') = 'true');
  -- Two statements, not one AND: SQL does not promise to evaluate the operands
  -- left to right, so reading the row in the same expression that re-enables it
  -- could read it first and fail for no reason.
  PERFORM _pr_ok('re-enabling it succeeds',
    (_pr_do(owner, format('SELECT platform_staff_enable(%L)::text', support))::jsonb ->> 'success') = 'true');
  PERFORM _pr_reset();
  PERFORM _pr_ok('…and it holds support again, not owner',
    app_private.platform_staff_role_of(support) = 'support');
  PERFORM _pr_ok('disabling it again succeeds',
    (_pr_do(owner, format('SELECT platform_staff_disable(%L)::text', support))::jsonb ->> 'success') = 'true');
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

-- ─── 5b. platform_staff_set_role (20260923140000) ───────────────────────────

/*
  An existing member moves between the four roles. Before it, the only way was
  to disable the row and add it again, which lost `created_by`, `created_at` and
  the note and wrote a removal and a fresh grant for what was one change — so
  those three columns surviving is an assertion here, not a detail.

  Section 5 leaves exactly one active owner (the `owner` principal) and three
  active members, one per other role. This section ends by putting the team back
  as it found it, so sections 6 to 9 see what they always did.
*/
DO $$
DECLARE
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  billing  constant uuid := '3b000000-0000-4000-8000-000000000004';  -- active, billing
  readonly constant uuid := '3b000000-0000-4000-8000-000000000005';  -- active, read_only
  cand_sup constant uuid := '3b000000-0000-4000-8000-000000000008';  -- active, support
  cand_bil constant uuid := '3b000000-0000-4000-8000-000000000009';  -- active, billing
  cand_ro  constant uuid := '3b000000-0000-4000-8000-00000000000a';  -- active, read_only
  target   constant uuid := '3b000000-0000-4000-8000-000000000006';  -- disabled owner
  in_co    constant uuid := '3b000000-0000-4000-8000-000000000007';  -- no staff row
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_from    bigint;
  v_rows    bigint;
  v_row     app_private.platform_audit_log%ROWTYPE;
  v_by      uuid;
  v_created timestamptz;
  v_note    text;
BEGIN
  -- Each of the four roles against it, and a company admin. Every probe here is
  -- _pr_try, so nothing it might change survives.
  PERFORM _pr_ok('changing a role is staff.manage: an active support account is denied',
    _pr_reason(_pr_try(cand_sup, format('SELECT platform_staff_set_role(%L, %L)::text', billing, 'owner'))) = 'denied');
  PERFORM _pr_ok('…a billing account is denied',
    _pr_reason(_pr_try(cand_bil, format('SELECT platform_staff_set_role(%L, %L)::text', billing, 'owner'))) = 'denied');
  PERFORM _pr_ok('…a read_only account is denied',
    _pr_reason(_pr_try(cand_ro, format('SELECT platform_staff_set_role(%L, %L)::text', billing, 'owner'))) = 'denied');
  PERFORM _pr_ok('…a company administrator is denied, with the same reason as a platform role',
    _pr_reason(_pr_try(admin_a, format('SELECT platform_staff_set_role(%L, %L)::text', billing, 'owner'))) = 'denied');
  PERFORM _pr_ok('…and an owner is not',
    _pr_yn(_pr_try(owner, format('SELECT platform_staff_set_role(%L, %L)::text', billing, 'owner'))) = 'Y');

  -- The change itself, and the three columns the old dance destroyed.
  PERFORM _pr_reset();
  SELECT s.created_by, s.created_at, s.note INTO v_by, v_created, v_note
    FROM app_private.platform_staff s WHERE s.user_id = cand_sup;

  SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;
  PERFORM _pr_ok('an owner moves a support member to billing',
    (_pr_do(owner, format('SELECT platform_staff_set_role(%L, %L)::text', cand_sup, 'billing'))::jsonb ->> 'success') = 'true');
  PERFORM _pr_reset();
  PERFORM _pr_ok('…and the row holds billing',
    app_private.platform_staff_role_of(cand_sup) = 'billing');
  PERFORM _pr_ok('…keeping who granted it, when, and the note — the three the disable-and-add-again dance lost',
    EXISTS (SELECT 1 FROM app_private.platform_staff s
             WHERE s.user_id = cand_sup
               AND s.created_by IS NOT DISTINCT FROM v_by
               AND s.created_at = v_created
               AND s.note IS NOT DISTINCT FROM v_note));

  SELECT count(*) INTO v_rows FROM app_private.platform_audit_log
   WHERE id > v_from AND action = 'platform_staff.set_role';
  PERFORM _pr_ok(format('…and the function wrote exactly one row of its own, got %s', v_rows), v_rows = 1);

  SELECT * INTO v_row FROM app_private.platform_audit_log
   WHERE id > v_from AND action = 'platform_staff.set_role';
  PERFORM _pr_ok('…naming the actor, its role, the target and the role before and after',
    v_row.category = 'staff' AND v_row.outcome = 'ok'
    AND v_row.actor_user_id = owner AND v_row.actor_role = 'owner'
    AND v_row.target_type = 'platform_staff' AND v_row.target_id = cand_sup::text
    AND v_row.before_value ->> 'role' = 'support'
    AND v_row.after_value ->> 'role' = 'billing'
    AND (v_row.after_value ->> 'self')::boolean = false);
  PERFORM _pr_ok('…and the table''s own trigger recorded the same change beside it',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log l
             WHERE l.id > v_from AND l.action = 'platform_staff.update'
               AND l.target_id = cand_sup::text
               AND l.actor_user_id = owner AND l.actor_role = 'owner'
               AND l.after_value ->> 'role' = 'billing'));

  -- A call that would change nothing is refused, not recorded as a change.
  SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;
  PERFORM _pr_ok('asking for the role the member already holds answers already_in_role',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_set_role(%L, %L)::text', cand_sup, 'billing'))) = 'already_in_role');
  SELECT count(*) INTO v_rows FROM app_private.platform_audit_log WHERE id > v_from;
  PERFORM _pr_ok(format('…and that is one audit row and no table change, got %s', v_rows), v_rows = 1);
  SELECT * INTO v_row FROM app_private.platform_audit_log WHERE id > v_from;
  PERFORM _pr_ok('…recorded as an error, in the staff category, naming the reason',
    v_row.category = 'staff' AND v_row.action = 'platform_staff.set_role'
    AND v_row.outcome = 'error' AND v_row.after_value ->> 'reason' = 'already_in_role');

  -- The argument contract, the same four as platform_staff_add's.
  PERFORM _pr_ok('a role outside the four is refused as invalid',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_set_role(%L, %L)::text', cand_sup, 'admin'))) = 'invalid');
  PERFORM _pr_ok('an empty role is refused as invalid',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_set_role(%L, %L)::text', cand_sup, ''))) = 'invalid');
  PERFORM _pr_ok('a NULL role is refused as invalid',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_set_role(%L, NULL)::text', cand_sup))) = 'invalid');
  PERFORM _pr_reset();
  PERFORM _pr_ok('…and none of the three changed the row',
    app_private.platform_staff_role_of(cand_sup) = 'billing');

  -- An account with no staff row, and one whose row is paused.
  PERFORM _pr_ok('an account that is not on the team is not_found',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_set_role(%L, %L)::text', in_co, 'support'))) = 'not_found');
  PERFORM _pr_ok('a disabled member is refused: enable it first, and the role comes back as it was',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_set_role(%L, %L)::text', target, 'read_only'))) = 'member_disabled');
  PERFORM _pr_reset();
  PERFORM _pr_ok('…and the paused row still carries the role it was paused with',
    EXISTS (SELECT 1 FROM app_private.platform_staff s
             WHERE s.user_id = target AND s.role = 'owner' AND s.disabled_at IS NOT NULL));

  -- The last active owner: the same refusal as disabling it, recorded the same
  -- way, and the trigger underneath refuses the same change directly.
  SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;
  PERFORM _pr_ok('the last active owner cannot be demoted',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_set_role(%L, %L)::text', owner, 'read_only'))) = 'last_owner');
  SELECT * INTO v_row FROM app_private.platform_audit_log WHERE id > v_from;
  PERFORM _pr_ok('…and that refusal is audited as denied, like disabling it',
    v_row.action = 'platform_staff.set_role' AND v_row.outcome = 'denied'
    AND v_row.after_value ->> 'reason' = 'last_owner');
  PERFORM _pr_reset();
  PERFORM _pr_ok('…and the owner still holds the role',
    app_private.platform_staff_role_of(owner) = 'owner');

  BEGIN
    UPDATE app_private.platform_staff SET role = 'support' WHERE user_id = owner;
    RAISE EXCEPTION 'FAIL: the last active owner was demoted directly';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    PERFORM _pr_ok('the trigger refuses demoting the last active owner directly',
      SQLERRM LIKE '%last active owner%');
  END;

  /*
    The caller's own row. staff.manage is the owner's capability alone, so the
    only self-change that can reach this function is an owner taking power away
    from itself — and the case that would lock the platform out is the one
    above, which is refused for anybody. With a second owner present it is
    allowed, and the `self` flag makes it findable in the log.
  */
  PERFORM _pr_ok('an owner promotes the billing member to owner, so two remain',
    (_pr_do(owner, format('SELECT platform_staff_set_role(%L, %L)::text', cand_sup, 'owner'))::jsonb ->> 'success') = 'true');
  PERFORM _pr_reset();
  PERFORM _pr_ok('…and the platform now has two active owners',
    (SELECT count(*) FROM app_private.platform_staff s
      WHERE s.role = 'owner' AND s.disabled_at IS NULL) = 2);

  SELECT coalesce(max(id), 0) INTO v_from FROM app_private.platform_audit_log;
  PERFORM _pr_ok('an owner may step back from their own row while another owner remains',
    (_pr_do(owner, format('SELECT platform_staff_set_role(%L, %L)::text', owner, 'read_only'))::jsonb ->> 'success') = 'true');
  SELECT * INTO v_row FROM app_private.platform_audit_log
   WHERE id > v_from AND action = 'platform_staff.set_role';
  PERFORM _pr_ok('…and the row marks it as the caller''s own, so a self-demotion is findable',
    (v_row.after_value ->> 'self')::boolean
    AND v_row.actor_user_id = owner AND v_row.target_id = owner::text
    AND v_row.before_value ->> 'role' = 'owner'
    AND v_row.after_value ->> 'role' = 'read_only');
  PERFORM _pr_reset();
  PERFORM _pr_ok('…and the account holds read_only from that moment',
    app_private.platform_staff_role_of(owner) = 'read_only');
  PERFORM _pr_ok('…so it can no longer change any role, its own included',
    _pr_reason(_pr_do(owner, format('SELECT platform_staff_set_role(%L, %L)::text', owner, 'owner'))) = 'denied');

  -- Put the team back as section 5 left it: the other owner restores this one,
  -- then steps back itself, which is a second self-demotion from the other side.
  PERFORM _pr_ok('the remaining owner restores it',
    (_pr_do(cand_sup, format('SELECT platform_staff_set_role(%L, %L)::text', owner, 'owner'))::jsonb ->> 'success') = 'true');
  PERFORM _pr_ok('…and then steps back to support itself',
    (_pr_do(cand_sup, format('SELECT platform_staff_set_role(%L, %L)::text', cand_sup, 'support'))::jsonb ->> 'success') = 'true');
  PERFORM _pr_reset();
  PERFORM _pr_ok('the team is as section 5 left it: one active owner, the candidate back on support',
    app_private.platform_staff_role_of(owner) = 'owner'
    AND app_private.platform_staff_role_of(cand_sup) = 'support'
    AND app_private.platform_staff_role_of(readonly) = 'read_only'
    AND (SELECT count(*) FROM app_private.platform_staff s
          WHERE s.role = 'owner' AND s.disabled_at IS NULL) = 1);
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
    _pr_reason(_pr_do(owner, format('SELECT platform_company_set_approval(%L, %L)::text',
      'c0000000-0000-4000-8000-0000000000ff', 'approve'))) = 'not_found');
END $$;

-- ─── 9. the write that reads no column (20260923110010) ─────────────────────

/*
  `roles_delete` and `role_permissions_delete` carried a platform branch naming
  `company_users.manage` with no company term. `matrix.sql` reads `..` for those
  cells and explains it by the row not being *visible* — which is true of every
  probe it makes, because every one of them carries a WHERE, and a WHERE that
  reads a column brings the SELECT policy with it.

  **A statement that reads no column does not.** `DELETE FROM public.roles;`
  consults `roles_delete`'s USING clause and nothing else, so before
  20260923110010 a staff account holding that capability with no context open
  deleted every custom role of every company in one statement.

  This is the probe the matrix cannot make. It is here rather than there because
  it must not carry a WHERE — which is the whole point — and because an
  unfiltered DELETE is not a shape the matrix's grid can express.

  Each probe runs as a caller and is rolled back by _pr_try.
*/
DO $$
DECLARE
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  co_a     constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_before bigint;
  v_id     uuid;
BEGIN
  -- A custom role of company A, so there is something for an unfiltered
  -- statement to take. is_system = false is what the policy keys on.
  INSERT INTO roles (name, description, company_id, is_system)
  VALUES ('PR custom role', 'pr', co_a, false)
  RETURNING id INTO v_id;
  INSERT INTO role_permissions (role_id, page_key, can_view, can_edit)
  VALUES (v_id, 'salaries', true, true);

  SELECT count(*) INTO v_before FROM roles WHERE is_system = false;
  PERFORM _pr_ok('there is a custom role for an unfiltered DELETE to reach',
    v_before > 0);

  -- The platform owner holds company_users.manage and has no context open.
  PERFORM _pr_ok('an unfiltered DELETE on roles takes nothing from a platform account with no context',
    _pr_try(owner, 'WITH d AS (DELETE FROM public.roles RETURNING 1) SELECT count(*)::text FROM d') = '0');
  PERFORM _pr_ok('…and the same on role_permissions',
    _pr_try(owner, 'WITH d AS (DELETE FROM public.role_permissions RETURNING 1) SELECT count(*)::text FROM d') = '0');
  PERFORM _pr_reset();
  PERFORM _pr_ok('…and the custom role is still there',
    (SELECT count(*) FROM roles WHERE is_system = false) = v_before);

  /*
    The same for UPDATE, and note what changed about *how* it is refused. RLS
    filters an UPDATE by USING and raises 42501 only for a row that passes USING
    and fails WITH CHECK. Before 20260923110010 the capability branch let every
    non-system row through USING, so an unfiltered UPDATE reached the WITH CHECK
    and raised; now no row passes USING, so it touches nothing and raises
    nothing. Both are refusals — this asserts the count, which is the part that
    means "no row was changed" under either shape.
  */
  PERFORM _pr_ok('an unfiltered UPDATE on roles changes nothing either',
    _pr_try(owner, 'WITH u AS (UPDATE public.roles SET description = ''pr'' RETURNING 1) SELECT count(*)::text FROM u') = '0');
  PERFORM _pr_reset();

  /*
    The negative control, without which '0' above proves nothing: the same
    unfiltered shape, run by a principal the policy does admit, must return a
    non-zero count. It is run on role_permissions rather than roles, because an
    unfiltered DELETE on roles can meet a foreign key from a profile that
    references one and raise instead of answering a count.
  */
  PERFORM _pr_ok('the probe can return a non-zero count: a company admin''s unfiltered DELETE does',
    _pr_try('a0000000-0000-4000-8000-000000000001',
            'WITH d AS (DELETE FROM public.role_permissions RETURNING 1) SELECT count(*)::text FROM d') <> '0');
  PERFORM _pr_reset();
END $$;

ROLLBACK;
