/*
  Approval with a trial code, and a trial that starts when the code is redeemed
  (20260916160000_approval_trial_code.sql).

  Runs after assertions.sql, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass.

    1. privileges   the approval RPCs are service_role only, the helpers are
                    nobody's, redeem and preview stay with authenticated
    2. signup       signup_create_company no longer starts the clock, and is
                    otherwise unchanged
    3. approve      the argument contract; exactly one code for a trial signup
                    and none otherwise; a second approval changes nothing; a
                    colliding hash writes nothing
    4. redeem       only an admin of that company; the trial starts with the
                    existing length and grants what trials grant; a second
                    redemption is refused
    5. resend       revokes the old code, and only the new one redeems
    6. paid codes   the subscription path of redeem and preview still works

  Calls to redeem and preview impersonate a real principal (the JWT claim plus
  SET LOCAL ROLE authenticated), as assertions.sql does, so what runs is what
  PostgREST runs.

  The whole file is one transaction, rolled back at the end, so the next file
  sees the database as the seeds left it. now() is the same instant in every
  block below.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs ───────────────────────────────────────────────────────────

-- The fixture's auth.users carries only what the supabase/postgres image
-- creates; these are the columns the functions under test read. Same as otp.sql.
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS banned_until       timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at         timestamptz,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT now();

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _atc_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

/** How company-approval hashes a code, and how redeem_activation_code hashes what is typed. */
CREATE OR REPLACE FUNCTION _atc_hash(p_code text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(p_code, 'UTF8')), 'hex');
$$;

/**
  Runs p_sql as p_role: true if it ran, false if it was refused for lack of
  privilege. Any other error propagates, so a malformed statement cannot pass
  as a refusal.
*/
CREATE OR REPLACE FUNCTION _atc_runs_as(p_role text, p_sql text) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  EXECUTE p_sql;
  RESET ROLE;
  RETURN true;
EXCEPTION WHEN insufficient_privilege THEN
  RESET ROLE;
  RETURN false;
END $$;

/** True if p_sql raised SQLSTATE p_state. Any other error propagates. */
CREATE OR REPLACE FUNCTION _atc_raises(p_sql text, p_state text) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = p_state THEN
    RETURN true;
  END IF;
  RAISE;
END $$;

/** Becomes p_user for auth.uid(). See assertions.sql for why the singular claim. */
CREATE OR REPLACE FUNCTION _atc_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE OR REPLACE FUNCTION _atc_redeem(p_user uuid, p_code text) RETURNS json
LANGUAGE plpgsql AS $$
DECLARE
  r json;
BEGIN
  PERFORM _atc_as(p_user);
  r := public.redeem_activation_code(p_code);
  RESET ROLE;
  RETURN r;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE;
END $$;

CREATE OR REPLACE FUNCTION _atc_preview(p_user uuid, p_code text) RETURNS json
LANGUAGE plpgsql AS $$
DECLARE
  r json;
BEGIN
  PERFORM _atc_as(p_user);
  r := public.preview_activation_code(p_code);
  RESET ROLE;
  RETURN r;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE;
END $$;

-- ─── 1. privileges ──────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role   text;
  v_fn     text;
  -- An unknown actor: service_role gets a harmless 'forbidden', and writes nothing.
  v_approve text := format('SELECT public.company_approve(%L, %L, %L, %L)',
                           gen_random_uuid(), gen_random_uuid(), _atc_hash('000000'), '0000');
  v_resend  text := format('SELECT public.company_resend_trial_code(%L, %L, %L, %L)',
                           gen_random_uuid(), gen_random_uuid(), _atc_hash('000000'), '0000');
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    PERFORM _atc_ok(format('%s holds no EXECUTE on company_approve or company_resend_trial_code', v_role),
      NOT has_function_privilege(v_role, 'public.company_approve(uuid,uuid,text,text)', 'EXECUTE')
      AND NOT has_function_privilege(v_role, 'public.company_resend_trial_code(uuid,uuid,text,text)', 'EXECUTE'));
    PERFORM _atc_ok(format('%s is refused calling company_approve', v_role), NOT _atc_runs_as(v_role, v_approve));
    PERFORM _atc_ok(format('%s is refused calling company_resend_trial_code', v_role), NOT _atc_runs_as(v_role, v_resend));
    PERFORM _atc_ok(format('%s still cannot call signup_create_company', v_role),
      NOT has_function_privilege(v_role, 'public.signup_create_company(uuid,text,text,text,text,text,integer,text,text)', 'EXECUTE'));
  END LOOP;

  PERFORM _atc_ok('service_role can call company_approve', _atc_runs_as('service_role', v_approve));
  PERFORM _atc_ok('service_role can call company_resend_trial_code', _atc_runs_as('service_role', v_resend));

  FOREACH v_fn IN ARRAY ARRAY[
    'app_private.trial_length()',
    'app_private.company_admin_emails(uuid)',
    'app_private.issue_trial_code(uuid,uuid,text,text)',
    'app_private.redeem_trial_code(uuid,uuid,uuid,text)'
  ] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      PERFORM _atc_ok(format('%s cannot execute %s', v_role, v_fn),
        NOT has_function_privilege(v_role, v_fn, 'EXECUTE'));
    END LOOP;
  END LOOP;
  PERFORM _atc_ok('authenticated is refused calling an app_private helper',
    NOT _atc_runs_as('authenticated', 'SELECT app_private.trial_length()'));

  PERFORM _atc_ok('anon cannot redeem or preview a code',
    NOT has_function_privilege('anon', 'public.redeem_activation_code(text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.preview_activation_code(text)', 'EXECUTE'));
  PERFORM _atc_ok('a signed-in user still can',
    has_function_privilege('authenticated', 'public.redeem_activation_code(text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.preview_activation_code(text)', 'EXECUTE'));
END $$;

-- ─── 2. signup ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  owner uuid := 'a7c00000-0000-4000-8000-000000000001';
  r     jsonb;
  co    uuid;
  comp  record;
  prof  record;
BEGIN
  -- As company-signup leaves the account after createUser: unconfirmed.
  INSERT INTO auth.users (id, email, created_at) VALUES (owner, 'atc-owner@test.invalid', now());

  r := public.signup_create_company(owner, 'atc-owner@test.invalid', 'Olga Owner', 'ATC Trial GmbH',
                                    'advanced', 'yearly', 7, NULL, NULL);
  PERFORM _atc_ok('a signup returns ok with the company', r->>'ok' = 'true' AND r->'company' ? 'id');
  co := (r->'company'->>'id')::uuid;
  SELECT * INTO comp FROM companies WHERE id = co;

  PERFORM _atc_ok('signup does not start the trial clock: trial_start and trial_end stay NULL',
    comp.trial_start IS NULL AND comp.trial_end IS NULL AND comp.trial_activation_code_id IS NULL);
  PERFORM _atc_ok('the result still carries trial_end, now NULL',
    r->'company' ? 'trial_end' AND r->'company'->'trial_end' = 'null'::jsonb);
  PERFORM _atc_ok('otherwise unchanged: a pending, inactive trial in Deutschland with the chosen plan, cycle and car limit',
    comp.name = 'ATC Trial GmbH' AND comp.slug = 'atc-trial-gmbh'
    AND comp.status = 'trial' AND comp.approval_status = 'pending'
    AND comp.subscription_status = 'inactive' AND comp.subscription_expires_at IS NULL
    AND comp.country = 'Deutschland' AND comp.plan = 'advanced' AND comp.billing_cycle = 'yearly'
    AND comp.subscription_car_limit = 7 AND comp.approved_at IS NULL
    AND r->'company'->>'approval_status' = 'pending' AND r->'company'->>'slug' = comp.slug);

  SELECT * INTO prof FROM user_profiles WHERE user_id = owner;
  PERFORM _atc_ok('otherwise unchanged: the owner is a pending_invite admin, with settings and a pending signup',
    prof.role = 'admin' AND prof.company_id = co AND prof.status = 'pending_invite' AND NOT prof.is_super_admin
    AND EXISTS (SELECT 1 FROM company_settings WHERE company_id = co AND company_name = 'ATC Trial GmbH')
    AND EXISTS (SELECT 1 FROM app_private.pending_signups WHERE user_id = owner AND company_id = co));

  -- The owner enters the signup code. The call is its own statement: a
  -- subquery in the same statement would read the snapshot from before it.
  UPDATE auth.users SET email_confirmed_at = now() WHERE id = owner;
  r := public.signup_complete(owner);
  PERFORM _atc_ok('signup_complete activates the owner and still starts no trial',
    r->>'ok' = 'true'
    AND (SELECT status FROM user_profiles WHERE user_id = owner) = 'active'
    AND (SELECT trial_start IS NULL AND trial_end IS NULL FROM companies WHERE id = co));
END $$;

-- ─── principals and companies for 3–5 ───────────────────────────────────────

/*
    c7..02 atc-legacy       pending trial whose clock started at signup
    c7..03 atc-direct       pending, status active: not a trial signup
    c7..04 atc-subscribed   pending trial signup that already holds a subscription
    c7..05 atc-rejected     rejected trial signup, approved later
    c7..06 atc-collision    pending trial signup, for the colliding hash

    a7..02 member      viewer of ATC Trial GmbH
    a7..03 unconfirmed admin of ATC Trial GmbH whose address is not confirmed
    a7..04 second      admin of ATC Trial GmbH, address in mixed case
    a7..05 rita        admin of atc-rejected
    a7..06 banned      admin of ATC Trial GmbH, banned for a day
*/
INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status,
                       trial_start, trial_end, subscription_expires_at, rejection_reason) VALUES
  ('c7c00000-0000-4000-8000-000000000002', 'ATC Legacy',     'atc-legacy',     'pending',  'trial',  'basic', 'inactive',
   now() - interval '3 days', now() + interval '11 days', NULL, NULL),
  ('c7c00000-0000-4000-8000-000000000003', 'ATC Direct',     'atc-direct',     'pending',  'active', 'basic', 'inactive',
   NULL, NULL, NULL, NULL),
  ('c7c00000-0000-4000-8000-000000000004', 'ATC Subscribed', 'atc-subscribed', 'pending',  'trial',  'basic', 'active',
   NULL, NULL, now() + interval '20 days', NULL),
  ('c7c00000-0000-4000-8000-000000000005', 'ATC Rejected',   'atc-rejected',   'rejected', 'trial',  'basic', 'inactive',
   NULL, NULL, NULL, 'Unvollständige Angaben'),
  ('c7c00000-0000-4000-8000-000000000006', 'ATC Collision',  'atc-collision',  'pending',  'trial',  'basic', 'inactive',
   NULL, NULL, NULL, NULL);

INSERT INTO auth.users (id, email, email_confirmed_at, banned_until, created_at) VALUES
  ('a7c00000-0000-4000-8000-000000000002', 'atc-member@test.invalid',      now(), NULL,                     now() - interval '9 days'),
  ('a7c00000-0000-4000-8000-000000000003', 'atc-unconfirmed@test.invalid', NULL,  NULL,                     now() - interval '9 days'),
  ('a7c00000-0000-4000-8000-000000000004', 'ATC-Second@Test.Invalid',      now(), NULL,                     now() - interval '9 days'),
  ('a7c00000-0000-4000-8000-000000000005', 'atc-rejected@test.invalid',    now(), NULL,                     now() - interval '9 days'),
  ('a7c00000-0000-4000-8000-000000000006', 'atc-banned@test.invalid',      now(), now() + interval '1 day', now() - interval '9 days');

INSERT INTO user_profiles (user_id, email, full_name, role, company_id, is_super_admin, status)
SELECT v.user_id, v.email, v.full_name, v.role, c.id, false, 'active'
  FROM (VALUES
    ('a7c00000-0000-4000-8000-000000000002'::uuid, 'atc-member@test.invalid',      'Mia Member',  'viewer', 'atc-trial-gmbh'),
    ('a7c00000-0000-4000-8000-000000000003'::uuid, 'atc-unconfirmed@test.invalid', 'Uwe Offen',   'admin',  'atc-trial-gmbh'),
    ('a7c00000-0000-4000-8000-000000000004'::uuid, 'atc-second@test.invalid',      'Sara Second', 'admin',  'atc-trial-gmbh'),
    ('a7c00000-0000-4000-8000-000000000005'::uuid, 'atc-rejected@test.invalid',    'Rita Rejected', 'admin', 'atc-rejected'),
    ('a7c00000-0000-4000-8000-000000000006'::uuid, 'atc-banned@test.invalid',      'Ben Banned',  'admin',  'atc-trial-gmbh')
  ) AS v(user_id, email, full_name, role, slug)
  JOIN companies c ON c.slug = v.slug;

-- ─── 3. approve ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  super     uuid := '50000000-0000-4000-8000-000000000001';   -- seed.sql
  admin_a   uuid := 'a0000000-0000-4000-8000-000000000001';   -- seed.sql
  legacy    uuid := 'c7c00000-0000-4000-8000-000000000002';
  direct    uuid := 'c7c00000-0000-4000-8000-000000000003';
  subscribed uuid := 'c7c00000-0000-4000-8000-000000000004';
  rejected  uuid := 'c7c00000-0000-4000-8000-000000000005';
  collision uuid := 'c7c00000-0000-4000-8000-000000000006';
  t1        uuid;
  r         jsonb;
  comp      record;
  code      record;
BEGIN
  SELECT id INTO t1 FROM companies WHERE slug = 'atc-trial-gmbh';

  -- The argument contract.
  PERFORM _atc_ok('company_approve raises 22023 without a company',
    _atc_raises(format('SELECT public.company_approve(NULL, %L, %L, %L)', super, _atc_hash('111111'), '1111'), '22023'));
  PERFORM _atc_ok('company_approve raises 22023 without an actor',
    _atc_raises(format('SELECT public.company_approve(%L, NULL, %L, %L)', t1, _atc_hash('111111'), '1111'), '22023'));
  PERFORM _atc_ok('company_approve raises 22023 for a hash that is not 64 lower-case hex digits',
    _atc_raises(format('SELECT public.company_approve(%L, %L, %L, %L)', t1, super, upper(_atc_hash('111111')), '1111'), '22023'));
  PERFORM _atc_ok('company_approve raises 22023 when the last four are not four digits',
    _atc_raises(format('SELECT public.company_approve(%L, %L, %L, %L)', t1, super, _atc_hash('111111'), '111'), '22023'));
  PERFORM _atc_ok('company_resend_trial_code raises 22023 without a hash',
    _atc_raises(format('SELECT public.company_resend_trial_code(%L, %L, NULL, %L)', t1, super, '1111'), '22023'));

  r := public.company_approve(t1, admin_a, _atc_hash('111111'), '1111');
  PERFORM _atc_ok('a company admin is not a platform admin: forbidden, and nothing is written',
    r->>'ok' = 'false' AND r->>'reason' = 'forbidden'
    AND (SELECT approval_status FROM companies WHERE id = t1) = 'pending'
    AND NOT EXISTS (SELECT 1 FROM activation_codes WHERE company_id = t1));
  PERFORM _atc_ok('an unknown company is not_found',
    public.company_approve(gen_random_uuid(), super, _atc_hash('111111'), '1111')->>'reason' = 'not_found');

  -- A trial signup: exactly one code.
  r := public.company_approve(t1, super, _atc_hash('424242'), '4242');
  PERFORM _atc_ok('approving a trial signup returns ok and code_created, with the company name and 14 trial days',
    r->>'ok' = 'true' AND r->>'already_approved' = 'false' AND r->>'code_created' = 'true'
    AND r->>'company_name' = 'ATC Trial GmbH' AND (r->>'trial_days')::integer = 14);
  PERFORM _atc_ok('the result carries neither the code nor its hash',
    position('424242' IN r::text) = 0 AND position(_atc_hash('424242') IN r::text) = 0);

  SELECT * INTO comp FROM companies WHERE id = t1;
  PERFORM _atc_ok('the approval fields are set as handleApprove set them',
    comp.approval_status = 'approved' AND comp.approved_at = now() AND comp.approved_by = super
    AND comp.rejection_reason IS NULL AND comp.updated_at = now());
  PERFORM _atc_ok('approval starts no trial and writes no subscription',
    comp.trial_start IS NULL AND comp.trial_end IS NULL AND comp.trial_activation_code_id IS NULL
    AND comp.subscription_status = 'inactive' AND comp.subscription_expires_at IS NULL);

  PERFORM _atc_ok('exactly one code exists for the trial signup',
    (SELECT count(*) FROM activation_codes WHERE company_id = t1) = 1);
  SELECT * INTO code FROM activation_codes WHERE company_id = t1;
  PERFORM _atc_ok('it is an open trial code for that company, kept as hash and last four, with no redemption window',
    code.duration_type = 'testphase' AND code.status = 'active'
    AND code.code_hash = _atc_hash('424242') AND code.code_last4 = '4242'
    AND code.expires_at = 'infinity'::timestamptz AND code.created_by = super
    AND code.used_at IS NULL AND code.target_email IS NULL);
  PERFORM _atc_ok('the mail goes to the confirmed, active admins only, lower-cased',
    (SELECT array_agg(e ORDER BY e) FROM jsonb_array_elements_text(r->'recipients') AS e)
      = ARRAY['atc-owner@test.invalid', 'atc-second@test.invalid']);

  r := public.company_approve(t1, super, _atc_hash('515151'), '5151');
  PERFORM _atc_ok('approving it again changes nothing: already_approved, no code, nobody to mail',
    r->>'ok' = 'true' AND r->>'already_approved' = 'true' AND r->>'code_created' = 'false'
    AND r->'recipients' = '[]'::jsonb
    AND (SELECT count(*) FROM activation_codes WHERE company_id = t1) = 1
    AND NOT EXISTS (SELECT 1 FROM activation_codes WHERE code_hash = _atc_hash('515151'))
    AND (SELECT approved_at FROM companies WHERE id = t1) = now());

  -- None otherwise.
  r := public.company_approve(legacy, super, _atc_hash('626262'), '6262');
  PERFORM _atc_ok('a company whose trial started at signup is approved without a code, its dates untouched',
    r->>'ok' = 'true' AND r->>'code_created' = 'false'
    AND NOT EXISTS (SELECT 1 FROM activation_codes WHERE company_id = legacy)
    AND (SELECT approval_status = 'approved' AND trial_start = now() - interval '3 days'
                AND trial_end = now() + interval '11 days' AND trial_activation_code_id IS NULL
           FROM companies WHERE id = legacy));
  r := public.company_approve(direct, super, _atc_hash('636363'), '6363');
  PERFORM _atc_ok('a company that did not sign up for a trial is approved without a code',
    r->>'ok' = 'true' AND r->>'code_created' = 'false'
    AND NOT EXISTS (SELECT 1 FROM activation_codes WHERE company_id = direct));
  r := public.company_approve(subscribed, super, _atc_hash('646464'), '6464');
  PERFORM _atc_ok('a trial signup with an active subscription is approved without a code',
    r->>'ok' = 'true' AND r->>'code_created' = 'false'
    AND NOT EXISTS (SELECT 1 FROM activation_codes WHERE company_id = subscribed));

  r := public.company_approve(rejected, super, _atc_hash('656565'), '6565');
  PERFORM _atc_ok('a rejected trial signup approved later gets its code, and the rejection reason is cleared',
    r->>'ok' = 'true' AND r->>'code_created' = 'true'
    AND (SELECT approval_status = 'approved' AND rejection_reason IS NULL FROM companies WHERE id = rejected)
    AND (SELECT count(*) FROM activation_codes
          WHERE company_id = rejected AND duration_type = 'testphase' AND status = 'active') = 1
    AND r->'recipients' = '["atc-rejected@test.invalid"]'::jsonb);

  r := public.company_approve(collision, super, _atc_hash('424242'), '4242');
  PERFORM _atc_ok('a hash that already exists is refused as code_collision, and nothing is written',
    r->>'ok' = 'false' AND r->>'reason' = 'code_collision'
    AND (SELECT approval_status FROM companies WHERE id = collision) = 'pending'
    AND NOT EXISTS (SELECT 1 FROM activation_codes WHERE company_id = collision));

  PERFORM _atc_ok('the database itself refuses a second open trial code for one company',
    _atc_raises(format(
      'INSERT INTO activation_codes (code_hash, code_last4, company_id, duration_type, expires_at, created_by, status) '
      'VALUES (%L, %L, %L, %L, %L, %L, %L)',
      _atc_hash('999999'), '9999', t1, 'testphase', 'infinity', super, 'active'), '23505'));
END $$;

-- ─── 4. redeem ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  super   uuid := '50000000-0000-4000-8000-000000000001';
  admin_b uuid := 'b0000000-0000-4000-8000-000000000001';   -- seed.sql, company B
  owner   uuid := 'a7c00000-0000-4000-8000-000000000001';
  member  uuid := 'a7c00000-0000-4000-8000-000000000002';
  second  uuid := 'a7c00000-0000-4000-8000-000000000004';
  t1      uuid;
  code_id uuid;
  r       json;
  comp    record;
  code    record;
BEGIN
  SELECT id INTO t1 FROM companies WHERE slug = 'atc-trial-gmbh';
  SELECT id INTO code_id FROM activation_codes WHERE company_id = t1 AND duration_type = 'testphase';

  r := _atc_preview(owner, ' 424 242 ');
  PERFORM _atc_ok('the preview tells the company admin that the code starts a 14-day trial',
    r->>'success' = 'true' AND r->>'kind' = 'trial' AND r->>'status' = 'active'
    AND (r->>'trial_days')::integer = 14 AND r->>'seconds_remaining' IS NULL);
  r := _atc_preview(admin_b, '424242');
  PERFORM _atc_ok('another company previews it as a code that does not exist',
    r->>'success' = 'false' AND r->>'error' = 'Aktivierungscode nicht gefunden.');

  r := _atc_redeem(admin_b, '424242');
  PERFORM _atc_ok('an admin of another company is refused as if the code did not exist',
    r->>'success' = 'false' AND r->>'error' = 'Aktivierungscode ist ungültig.');
  r := _atc_redeem(member, '424242');
  PERFORM _atc_ok('a member of the company who is not its admin is refused',
    r->>'success' = 'false' AND r->>'error' = 'Nur ein Administrator des Unternehmens kann die Testphase starten.');
  r := _atc_redeem(super, '424242');
  PERFORM _atc_ok('a platform admin, who belongs to no company, is refused',
    r->>'success' = 'false' AND r->>'error' = 'Kein Unternehmenskonto gefunden.');
  PERFORM _atc_ok('after the refusals the code is still open and the trial has not started',
    (SELECT status FROM activation_codes WHERE id = code_id) = 'active'
    AND (SELECT trial_start IS NULL AND trial_end IS NULL FROM companies WHERE id = t1));

  r := _atc_redeem(owner, '424242');
  PERFORM _atc_ok('the company admin redeems it', r->>'success' = 'true' AND r->>'kind' = 'trial');

  SELECT * INTO comp FROM companies WHERE id = t1;
  PERFORM _atc_ok('the trial starts now and runs the existing 14 days, from app_private.trial_length()',
    app_private.trial_length() = interval '14 days'
    AND comp.trial_start = now() AND comp.trial_end = now() + interval '14 days'
    AND (r->>'trial_start')::timestamptz = comp.trial_start
    AND (r->>'trial_end')::timestamptz = comp.trial_end
    AND comp.trial_activation_code_id = code_id);
  PERFORM _atc_ok('it grants what a trial grants: a running trial (PlanContext) that came from a code (SubscriptionGuard), and nothing else',
    comp.trial_end > now() AND comp.status = 'trial' AND comp.plan = 'advanced'
    AND comp.subscription_status = 'inactive' AND comp.subscription_started_at IS NULL
    AND comp.subscription_expires_at IS NULL AND comp.subscription_duration_type IS NULL
    AND comp.last_activation_code_id IS NULL);

  SELECT * INTO code FROM activation_codes WHERE id = code_id;
  PERFORM _atc_ok('the code is used, by that admin for that company, and records no subscription period',
    code.status = 'used' AND code.used_by = owner AND code.used_company_id = t1 AND code.used_at = now()
    AND code.applied_subscription_started_at IS NULL AND code.applied_subscription_expires_at IS NULL);
  PERFORM _atc_ok('the success is logged once for the company',
    (SELECT count(*) FROM activation_code_attempts WHERE company_id = t1 AND success) = 1);

  r := _atc_redeem(owner, '424242');
  PERFORM _atc_ok('a second redemption is refused',
    r->>'success' = 'false' AND r->>'error' = 'Aktivierungscode wurde bereits verwendet.');
  r := _atc_redeem(second, '424242');
  PERFORM _atc_ok('so is one by the other admin, and the trial dates do not move',
    r->>'success' = 'false' AND r->>'error' = 'Aktivierungscode wurde bereits verwendet.'
    AND (SELECT trial_start = now() AND trial_end = now() + interval '14 days' FROM companies WHERE id = t1));

  PERFORM _atc_ok('once redeemed there is no open trial code to resend',
    public.company_resend_trial_code(t1, super, _atc_hash('737373'), '7373')->>'reason' = 'no_open_trial_code');
END $$;

-- ─── 5. resend ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  super     uuid := '50000000-0000-4000-8000-000000000001';
  admin_a   uuid := 'a0000000-0000-4000-8000-000000000001';
  legacy    uuid := 'c7c00000-0000-4000-8000-000000000002';
  rejected  uuid := 'c7c00000-0000-4000-8000-000000000005';
  collision uuid := 'c7c00000-0000-4000-8000-000000000006';
  rita      uuid := 'a7c00000-0000-4000-8000-000000000005';
  old_id    uuid;
  r         jsonb;
  j         json;
BEGIN
  SELECT id INTO old_id FROM activation_codes
   WHERE company_id = rejected AND duration_type = 'testphase' AND status = 'active';

  PERFORM _atc_ok('resend by someone who is not a platform admin is forbidden',
    public.company_resend_trial_code(rejected, admin_a, _atc_hash('818181'), '8181')->>'reason' = 'forbidden');
  PERFORM _atc_ok('resend for an unknown company is not_found',
    public.company_resend_trial_code(gen_random_uuid(), super, _atc_hash('818181'), '8181')->>'reason' = 'not_found');
  PERFORM _atc_ok('resend for a company that is not approved is not_approved',
    public.company_resend_trial_code(collision, super, _atc_hash('818181'), '8181')->>'reason' = 'not_approved');
  PERFORM _atc_ok('resend for an approved company without a trial code is no_open_trial_code',
    public.company_resend_trial_code(legacy, super, _atc_hash('818181'), '8181')->>'reason' = 'no_open_trial_code');
  PERFORM _atc_ok('none of the refusals wrote a code',
    NOT EXISTS (SELECT 1 FROM activation_codes WHERE code_hash = _atc_hash('818181'))
    AND (SELECT status FROM activation_codes WHERE id = old_id) = 'active');

  r := public.company_resend_trial_code(rejected, super, _atc_hash('808080'), '8080');
  PERFORM _atc_ok('resend returns ok with a new code, the company name, 14 days and the admin to mail',
    r->>'ok' = 'true' AND r->>'code_created' = 'true' AND r->>'company_name' = 'ATC Rejected'
    AND (r->>'trial_days')::integer = 14 AND r->'recipients' = '["atc-rejected@test.invalid"]'::jsonb
    AND position('808080' IN r::text) = 0);
  PERFORM _atc_ok('resend revokes the old code',
    (SELECT status = 'revoked' AND revoked_by = super AND revoked_at = now() FROM activation_codes WHERE id = old_id));
  PERFORM _atc_ok('and leaves exactly one open trial code, the new one',
    (SELECT count(*) FROM activation_codes
      WHERE company_id = rejected AND duration_type = 'testphase' AND status = 'active') = 1
    AND EXISTS (SELECT 1 FROM activation_codes
                 WHERE company_id = rejected AND status = 'active' AND code_hash = _atc_hash('808080')));

  r := public.company_resend_trial_code(rejected, super, _atc_hash('656565'), '6565');
  PERFORM _atc_ok('a resend whose hash already exists is code_collision and keeps the open code',
    r->>'reason' = 'code_collision'
    AND (SELECT status FROM activation_codes WHERE code_hash = _atc_hash('808080')) = 'active');

  j := _atc_redeem(rita, '656565');
  PERFORM _atc_ok('the revoked code no longer redeems',
    j->>'success' = 'false' AND j->>'error' = 'Aktivierungscode wurde widerrufen.'
    AND (SELECT trial_start IS NULL FROM companies WHERE id = rejected));
  j := _atc_redeem(rita, '808080');
  PERFORM _atc_ok('the new code starts the trial',
    j->>'success' = 'true'
    AND (SELECT trial_start = now() AND trial_end = now() + interval '14 days' FROM companies WHERE id = rejected));
END $$;

-- ─── 6. paid codes ──────────────────────────────────────────────────────────

DO $$
DECLARE
  super   uuid := '50000000-0000-4000-8000-000000000001';
  admin_b uuid := 'b0000000-0000-4000-8000-000000000001';
  co_b    uuid := 'c0000000-0000-4000-8000-00000000000b';
  j       json;
  comp    record;
BEGIN
  INSERT INTO activation_codes (code_hash, code_last4, company_id, duration_type, expires_at, created_by, status) VALUES
    (_atc_hash('313131'), '3131', co_b, '1_monat', now() + interval '2 minutes', super, 'active'),
    (_atc_hash('323232'), '3232', co_b, '1_monat', now() - interval '1 second',  super, 'active');

  j := _atc_preview(admin_b, '313131');
  PERFORM _atc_ok('a subscription code still previews with its duration and countdown',
    j->>'success' = 'true' AND j->>'duration_type' = '1_monat'
    AND (j->>'seconds_remaining')::integer = 120 AND j->>'kind' IS NULL);

  j := _atc_redeem(admin_b, '323232');
  PERFORM _atc_ok('an expired subscription code is still refused',
    j->>'success' = 'false' AND j->>'error' = 'Aktivierungscode ist abgelaufen.');

  j := _atc_redeem(admin_b, '313131');
  SELECT * INTO comp FROM companies WHERE id = co_b;
  PERFORM _atc_ok('a subscription code still grants its month and touches no trial field',
    j->>'success' = 'true'
    AND comp.subscription_status = 'active' AND comp.subscription_expires_at = now() + interval '1 month'
    AND comp.subscription_duration_type = '1_monat'
    AND comp.trial_start IS NULL AND comp.trial_end IS NULL AND comp.trial_activation_code_id IS NULL);
END $$;

ROLLBACK;
