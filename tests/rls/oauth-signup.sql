/*
  Google sign-in, plan step 1.6 PR A: do the database guarantees hold?

  Runs after assertions.sql, against the same throwaway database, as
  supabase_admin, in one transaction that is rolled back at the end. Every
  check raises on failure; a silent run is a pass.

    1. privileges      the table, the trigger function and the helpers are
                       nobody's; the four RPCs are service_role only, and anon
                       and authenticated are refused when they try
    2. the trigger     marks the accounts GoTrue v2.170.0 creates for Google and
                       nothing else, never fails an insert whatever the
                       metadata, and leaves the email signup, the admin invite
                       and GoTrue's own invite as they were
    3. signup_create_company is unchanged: the same signups through a verbatim
                       copy of the 20260915100200 function and through today's
                       write the same rows and return the same result
    4. oauth_signup_create_company   every refusal, then the success paths
    5. oauth_session_reconcile       cancel, keep, accept, and the no-ops
    6. oauth_signup_discard
    7. purge_abandoned_oauth_signups the age boundary, and what it never touches

  ## Stand-ins for GoTrue

  The fixture was dumped with --schema=public. auth.users here is the table the
  supabase/postgres image creates, without GoTrue's later columns, and
  auth.identities does not exist at all. The prelude adds the auth.users columns
  the functions read and creates auth.identities with the columns of GoTrue
  v2.170.0 (internal/models/identity.go and its migrations). production's
  on_auth_user_created trigger, which runs public.handle_new_user for every new
  account, is not in the fixture either; the prelude creates it, so accounts
  here start with the profile they get in production.

  _oauth_insert_user() inserts an account as supabase_auth_admin, the role
  GoTrue connects as, whenever that role may insert, which proves the trigger
  works as GoTrue's role. _oauth_google_signup() then writes what
  createAccountFromExternalIdentity writes for a new address: the account with
  ToUserModel's metadata and no confirmation, the google identity, and the
  confirming UPDATE. _oauth_link_google() writes what it does for a known
  address: an identity and UPDATEs, never an INSERT into auth.users.

  now() is one instant for the whole file: age is simulated by backdating rows.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stand-ins ───────────────────────────────────────────────────────

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS banned_until        timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at          timestamptz,
  ADD COLUMN IF NOT EXISTS created_at          timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS encrypted_password  varchar(255),
  ADD COLUMN IF NOT EXISTS raw_app_meta_data   jsonb,
  ADD COLUMN IF NOT EXISTS raw_user_meta_data  jsonb;

CREATE TABLE IF NOT EXISTS auth.identities (
  provider_id     text        NOT NULL,
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  identity_data   jsonb       NOT NULL,
  provider        text        NOT NULL,
  last_sign_in_at timestamptz NULL,
  created_at      timestamptz NULL,
  updated_at      timestamptz NULL,
  email           text        GENERATED ALWAYS AS (lower(identity_data ->> 'email')) STORED,
  id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  CONSTRAINT identities_provider_id_provider_unique UNIQUE (provider_id, provider)
);

-- otp_issue plans its whole eligibility CASE, platform_login branch included,
-- so it needs the table to exist even for the purposes used here.
CREATE TABLE IF NOT EXISTS auth.sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  not_after  timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'auth.users'::regclass AND tgname = 'on_auth_user_created') THEN
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
  END IF;
END $$;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _oauth_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _oauth_same(p_desc text, p_before jsonb, p_after jsonb) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_before IS NULL OR p_after IS DISTINCT FROM p_before THEN
    RAISE EXCEPTION 'FAIL: %', p_desc
      USING DETAIL = format('before: %s | after: %s', p_before, p_after);
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

/**
  Runs p_sql as p_role: true if it ran, false if it was refused for lack of
  privilege. Any other error propagates, so a malformed statement cannot pass
  as a refusal.
*/
CREATE OR REPLACE FUNCTION _oauth_runs_as(p_role text, p_sql text) RETURNS boolean
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

/** The SQLSTATE p_sql raised, or NULL when it ran. Whatever it wrote is undone either way when it raised. */
CREATE OR REPLACE FUNCTION _oauth_sqlstate(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $$;

CREATE OR REPLACE FUNCTION _oauth_hash(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(p_text, 'UTF8')), 'hex');
$$;

/** One INSERT into auth.users, as GoTrue's role when it may, with the metadata the caller names. */
CREATE OR REPLACE FUNCTION _oauth_insert_user(p_id uuid, p_email text, p_app_meta jsonb, p_confirmed_at timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF has_table_privilege('supabase_auth_admin', 'auth.users', 'INSERT') THEN
    EXECUTE 'SET LOCAL ROLE supabase_auth_admin';
  END IF;
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data, email_confirmed_at, created_at)
  VALUES (p_id, p_email, p_app_meta, jsonb_build_object('full_name', 'Test Nutzer'), p_confirmed_at, now());
  RESET ROLE;
  -- handle_new_user turns row security off for the rest of the transaction.
  -- The refusal checks below must not be answered by that instead of by a grant.
  SET LOCAL row_security = on;
END $$;

/** A new address signing in with Google: createAccountFromExternalIdentity, decision CreateAccount. */
CREATE OR REPLACE FUNCTION _oauth_google_signup(p_id uuid, p_email text, p_confirm boolean DEFAULT true)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _oauth_insert_user(p_id, p_email, '{"provider": "google", "providers": ["google"]}'::jsonb);
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  VALUES ('google-' || p_id, p_id,
          jsonb_build_object('sub', 'google-' || p_id, 'email', p_email, 'email_verified', true),
          'google', now(), now());
  IF p_confirm THEN
    UPDATE auth.users SET email_confirmed_at = now() WHERE id = p_id;
  END IF;
END $$;

/**
  A known address signing in with Google: decision LinkAccount. An unconfirmed
  account also loses its password and other identities and is confirmed
  (RemoveUnconfirmedIdentities, then Confirm). Nothing is inserted into auth.users.
*/
CREATE OR REPLACE FUNCTION _oauth_link_google(p_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_email     text;
  v_confirmed boolean;
BEGIN
  SELECT email, email_confirmed_at IS NOT NULL INTO v_email, v_confirmed FROM auth.users WHERE id = p_id;
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  VALUES ('google-' || p_id, p_id,
          jsonb_build_object('sub', 'google-' || p_id, 'email', v_email, 'email_verified', true),
          'google', now(), now());
  IF v_confirmed THEN
    UPDATE auth.users SET raw_app_meta_data = '{"provider": "email", "providers": ["email", "google"]}' WHERE id = p_id;
  ELSE
    DELETE FROM auth.identities WHERE user_id = p_id AND provider <> 'google';
    UPDATE auth.users
       SET encrypted_password = NULL,
           raw_app_meta_data  = '{"provider": "google", "providers": ["google"]}',
           email_confirmed_at = now()
     WHERE id = p_id;
  END IF;
END $$;

/** The account company-signup creates: admin createUser, unconfirmed, with its email identity. */
CREATE OR REPLACE FUNCTION _oauth_password_signup_account(p_id uuid, p_email text)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _oauth_insert_user(p_id, p_email, '{"provider": "email", "providers": ["email"]}'::jsonb);
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  VALUES (p_id::text, p_id, jsonb_build_object('sub', p_id::text, 'email', p_email), 'email', now(), now());
END $$;

/** An employee as manage-users invites one: createUser with email_confirm, then the profile upsert. */
CREATE OR REPLACE FUNCTION _oauth_invited_employee(p_id uuid, p_email text, p_company uuid)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _oauth_insert_user(p_id, p_email, '{"provider": "email", "providers": ["email"]}'::jsonb);
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  VALUES (p_id::text, p_id, jsonb_build_object('sub', p_id::text, 'email', p_email), 'email', now(), now());
  UPDATE auth.users SET email_confirmed_at = now() WHERE id = p_id;
  UPDATE user_profiles
     SET full_name = 'Eva Eingeladen', role = 'viewer',
         role_id = 'fdb2798f-08a7-481c-8bbb-67e15540926e',
         company_id = p_company, status = 'pending_invite', invited_at = now(),
         must_change_password = false
   WHERE user_id = p_id;
END $$;

-- ─── 1. privileges and hardening ────────────────────────────────────────────

DO $$
DECLARE
  r      record;
  v_role text;
  v_def  boolean;
  v_cfg  text[];
  v_src  text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM _oauth_ok(format('%s has no USAGE on schema app_private', v_role),
      NOT has_schema_privilege(v_role, 'app_private', 'USAGE'));
    PERFORM _oauth_ok(format('%s holds no privilege on app_private.pending_oauth_signups', v_role),
      NOT has_table_privilege(v_role, 'app_private.pending_oauth_signups',
                              'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'));
  END LOOP;

  FOR r IN
    SELECT v.sig, to_regprocedure(v.sig) AS fn, v.service_role_may, v.is_public
      FROM (VALUES
        ('public.oauth_signup_create_company(uuid,text,text,text,text,integer,text,text)',            true,  true),
        ('public.oauth_session_reconcile(uuid)',                                                      true,  true),
        ('public.oauth_signup_discard(uuid)',                                                         true,  true),
        ('public.purge_abandoned_oauth_signups(interval)',                                            true,  true),
        ('public.signup_create_company(uuid,text,text,text,text,text,integer,text,text)',             true,  true),
        ('app_private.mark_pending_oauth_signup()',                                                   false, false),
        ('app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)',   false, false),
        ('app_private.oauth_account_is_platform_staff(uuid)',                                         false, false)
      ) AS v(sig, service_role_may, is_public)
  LOOP
    PERFORM _oauth_ok(format('%s exists', r.sig), r.fn IS NOT NULL);

    SELECT p.prosecdef, p.proconfig, p.prosrc INTO v_def, v_cfg, v_src
      FROM pg_proc p WHERE p.oid = r.fn::oid;

    PERFORM _oauth_ok(format('%s is SECURITY DEFINER with a pinned search_path', r.sig),
      v_def AND EXISTS (SELECT 1 FROM unnest(v_cfg) AS s(setting) WHERE s.setting LIKE 'search_path=%'));
    PERFORM _oauth_ok(format('%s neither returns SQLERRM nor swallows errors', r.sig),
      v_src !~* 'sqlerrm' AND v_src !~* 'when\s+others');
    PERFORM _oauth_ok(format('%s: anon and authenticated cannot EXECUTE, service_role %s', r.sig,
                             CASE WHEN r.service_role_may THEN 'can' ELSE 'cannot' END),
      NOT has_function_privilege('anon', r.fn::oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', r.fn::oid, 'EXECUTE')
      AND has_function_privilege('service_role', r.fn::oid, 'EXECUTE') = r.service_role_may);
  END LOOP;

  -- tests/rls/matrix.sql counts the public functions that read the staff column
  -- directly; the new ones ask app_private.oauth_account_is_platform_staff.
  PERFORM _oauth_ok('the four new public functions do not read the staff column directly',
    NOT EXISTS (SELECT 1 FROM pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace
                   AND p.proname IN ('oauth_signup_create_company', 'oauth_session_reconcile',
                                     'oauth_signup_discard', 'purge_abandoned_oauth_signups')
                   AND p.prosrc ~ '(^|[^a-z_])is_super_admin([^a-z_]|$)'));

  PERFORM _oauth_ok('oauth_signup_create_company has exactly one default, the discount code',
    (SELECT p.pronargdefaults FROM pg_proc p
      WHERE p.oid = 'public.oauth_signup_create_company(uuid,text,text,text,text,integer,text,text)'::regprocedure) = 1);

  PERFORM _oauth_ok('mark_pending_oauth_signup is an enabled AFTER INSERT row trigger on auth.users',
    EXISTS (SELECT 1 FROM pg_trigger t
             WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'mark_pending_oauth_signup'
               AND t.tgfoid = 'app_private.mark_pending_oauth_signup()'::regprocedure
               AND t.tgenabled = 'O' AND t.tgtype & 1 = 1 AND t.tgtype & 4 = 4
               AND t.tgtype & (2 | 8 | 16 | 32 | 64) = 0));

  -- Privilege functions can be wrong in ways a real call exposes, so try.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    PERFORM _oauth_ok(format('%s is refused calling oauth_signup_create_company', v_role),
      NOT _oauth_runs_as(v_role, format(
        'SELECT public.oauth_signup_create_company(%L, %L, %L, NULL, NULL, NULL, NULL, NULL)',
        gen_random_uuid(), 'X', 'X GmbH')));
    PERFORM _oauth_ok(format('%s is refused calling oauth_session_reconcile', v_role),
      NOT _oauth_runs_as(v_role, format('SELECT public.oauth_session_reconcile(%L)', gen_random_uuid())));
    PERFORM _oauth_ok(format('%s is refused calling oauth_signup_discard', v_role),
      NOT _oauth_runs_as(v_role, format('SELECT public.oauth_signup_discard(%L)', gen_random_uuid())));
    PERFORM _oauth_ok(format('%s is refused calling purge_abandoned_oauth_signups', v_role),
      NOT _oauth_runs_as(v_role, 'SELECT public.purge_abandoned_oauth_signups()'));
    PERFORM _oauth_ok(format('%s is refused calling signup_create_company', v_role),
      NOT _oauth_runs_as(v_role, format(
        'SELECT public.signup_create_company(%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL)',
        gen_random_uuid(), 'x@test.invalid', 'X', 'X GmbH')));
    PERFORM _oauth_ok(format('%s cannot read app_private.pending_oauth_signups', v_role),
      NOT _oauth_runs_as(v_role, 'SELECT count(*) FROM app_private.pending_oauth_signups'));
  END LOOP;

  -- The matching "can", so the refusals above are not a broken statement.
  PERFORM _oauth_ok('service_role CAN call oauth_session_reconcile',
    _oauth_runs_as('service_role', format('SELECT public.oauth_session_reconcile(%L)', gen_random_uuid())));
  PERFORM _oauth_ok('service_role CAN call oauth_signup_discard',
    _oauth_runs_as('service_role', format('SELECT public.oauth_signup_discard(%L)', gen_random_uuid())));
  PERFORM _oauth_ok('service_role cannot read app_private.pending_oauth_signups',
    NOT _oauth_runs_as('service_role', 'SELECT count(*) FROM app_private.pending_oauth_signups'));
  PERFORM _oauth_ok('service_role cannot call app_private.signup_insert_company',
    NOT _oauth_runs_as('service_role', format(
      'SELECT app_private.signup_insert_company(%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL, %L)',
      gen_random_uuid(), 'x@test.invalid', 'X', 'X GmbH', 'active')));
  PERFORM _oauth_ok('service_role cannot call app_private.oauth_account_is_platform_staff',
    NOT _oauth_runs_as('service_role', format(
      'SELECT app_private.oauth_account_is_platform_staff(%L)', gen_random_uuid())));
END $$;

-- ─── 2. the trigger ─────────────────────────────────────────────────────────

DO $$
DECLARE
  t_google    uuid := '9a000002-0000-4000-8000-000000000001';
  t_mixed     uuid := '9a000002-0000-4000-8000-000000000002';
  t_prov_only uuid := '9a000002-0000-4000-8000-000000000003';
  t_list_only uuid := '9a000002-0000-4000-8000-000000000004';
  t_list_str  uuid := '9a000002-0000-4000-8000-000000000005';
  t_no_email  uuid := '9a000002-0000-4000-8000-000000000006';
  t_email     uuid := '9a000002-0000-4000-8000-000000000020';
  t_invite    uuid := '9a000002-0000-4000-8000-000000000021';
  t_gt_invite uuid := '9a000002-0000-4000-8000-000000000022';
  company_a   uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a     uuid := 'a0000000-0000-4000-8000-000000000001';
  s           record;
  r           jsonb;
  prof        record;
BEGIN
  RAISE NOTICE 'note: accounts are inserted as %',
    CASE WHEN has_table_privilege('supabase_auth_admin', 'auth.users', 'INSERT')
         THEN 'supabase_auth_admin, the role GoTrue connects as'
         ELSE 'supabase_admin (supabase_auth_admin may not INSERT into auth.users here)' END;

  -- What GoTrue writes for a new Google address.
  PERFORM _oauth_google_signup(t_google, 'oauth-t-google@test.invalid');
  PERFORM _oauth_ok('a Google account is marked as a pending Google signup, with its address and now()',
    EXISTS (SELECT 1 FROM app_private.pending_oauth_signups
             WHERE user_id = t_google AND email = 'oauth-t-google@test.invalid' AND created_at = now()));
  SELECT * INTO prof FROM user_profiles WHERE user_id = t_google;
  PERFORM _oauth_ok('handle_new_user still gives it its company-less viewer profile, pending_invite',
    prof.company_id IS NULL AND prof.role = 'viewer' AND prof.status = 'pending_invite' AND NOT prof.is_super_admin);

  PERFORM _oauth_insert_user(t_mixed, 'OAuth-T-Mixed@Test.Invalid', '{"provider": "google", "providers": ["google"]}');
  PERFORM _oauth_ok('the marked address is lower-cased',
    (SELECT email FROM app_private.pending_oauth_signups WHERE user_id = t_mixed) = 'oauth-t-mixed@test.invalid');

  PERFORM _oauth_insert_user(t_prov_only, 'oauth-t-prov-only@test.invalid', '{"provider": "google"}');
  PERFORM _oauth_ok('"provider": "google" alone marks the account',
    EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = t_prov_only));
  PERFORM _oauth_insert_user(t_list_only, 'oauth-t-list-only@test.invalid', '{"providers": ["google"]}');
  PERFORM _oauth_ok('"providers": ["google"] alone marks the account (GoTrue may drop the deprecated key)',
    EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = t_list_only));
  PERFORM _oauth_insert_user(t_list_str, 'oauth-t-list-str@test.invalid', '{"providers": "google"}');
  PERFORM _oauth_ok('"providers" as a bare string still matches, and does not raise',
    EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = t_list_str));

  -- Without an address. handle_new_user cannot write a profile for such an
  -- account (user_profiles.email is NOT NULL), so it is held off for this one
  -- insert: the point is only that the mark itself never fails.
  ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created;
  PERFORM _oauth_insert_user(t_no_email, NULL, '{"provider": "google", "providers": ["google"]}');
  ALTER TABLE auth.users ENABLE TRIGGER on_auth_user_created;
  PERFORM _oauth_ok('a Google account without an address is still created, and marked with a NULL address',
    EXISTS (SELECT 1 FROM auth.users WHERE id = t_no_email)
    AND EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = t_no_email AND email IS NULL));

  -- Every other shape: created, profiled, not marked, and never an error.
  FOR s IN
    SELECT *
      FROM (VALUES
        ('9a000002-0000-4000-8000-000000000010'::uuid, 'admin createUser, /invite and /signup (email)', '{"provider": "email", "providers": ["email"]}'::jsonb),
        ('9a000002-0000-4000-8000-000000000011'::uuid, 'phone signup',                     '{"provider": "phone", "providers": ["phone"]}'::jsonb),
        ('9a000002-0000-4000-8000-000000000012'::uuid, 'anonymous sign-in (no provider)',  '{}'::jsonb),
        ('9a000002-0000-4000-8000-000000000013'::uuid, 'SQL NULL metadata',                NULL::jsonb),
        ('9a000002-0000-4000-8000-000000000014'::uuid, 'JSON null metadata',               'null'::jsonb),
        ('9a000002-0000-4000-8000-000000000015'::uuid, 'an array',                         '[]'::jsonb),
        ('9a000002-0000-4000-8000-000000000016'::uuid, 'the bare string "google"',         '"google"'::jsonb),
        ('9a000002-0000-4000-8000-000000000017'::uuid, 'a number',                         '42'::jsonb),
        ('9a000002-0000-4000-8000-000000000018'::uuid, 'SSO',                              '{"provider": "sso:0d4e", "providers": ["sso:0d4e"]}'::jsonb),
        ('9a000002-0000-4000-8000-000000000019'::uuid, '"Google" in another case',         '{"provider": "Google", "providers": ["Google"]}'::jsonb),
        ('9a000002-0000-4000-8000-00000000001a'::uuid, 'provider as an array',             '{"provider": ["google"]}'::jsonb),
        ('9a000002-0000-4000-8000-00000000001b'::uuid, 'a provider number and a providers object', '{"provider": 7, "providers": {"email": true}}'::jsonb)
      ) AS v(id, label, meta)
  LOOP
    PERFORM _oauth_insert_user(s.id, format('oauth-t-%s@test.invalid', right(s.id::text, 2)), s.meta);
    PERFORM _oauth_ok(format('%s: created with its profile, not marked', s.label),
      EXISTS (SELECT 1 FROM auth.users WHERE id = s.id)
      AND EXISTS (SELECT 1 FROM user_profiles WHERE user_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = s.id));
  END LOOP;

  -- company-signup, end to end: nothing about it changes.
  PERFORM _oauth_password_signup_account(t_email, 'oauth-t-email@test.invalid');
  r := public.signup_create_company(t_email, 'oauth-t-email@test.invalid', 'Emil Email', 'Emil Taxi',
                                    NULL, NULL, NULL, NULL, NULL);
  PERFORM _oauth_ok('email signup: signup_create_company still answers ok', r->>'ok' = 'true');
  PERFORM _oauth_ok('email signup: a signup_verify code can be issued',
    public.otp_issue(gen_random_uuid(), 'signup_verify', 'oauth-t-email@test.invalid', NULL, NULL, NULL,
                     _oauth_hash('1'), NULL, NULL)->>'status' = 'issued');
  UPDATE auth.users SET email_confirmed_at = now() WHERE id = t_email;
  r := public.signup_complete(t_email);
  PERFORM _oauth_ok('email signup: signup_complete activates the owner',
    r->>'ok' = 'true' AND (SELECT status FROM user_profiles WHERE user_id = t_email) = 'active');
  PERFORM _oauth_ok('email signup: never marked as a Google signup',
    NOT EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = t_email));

  -- manage-users inviting an employee, and GoTrue's own /invite.
  PERFORM _oauth_invited_employee(t_invite, 'oauth-t-invite@test.invalid', company_a);
  PERFORM _oauth_ok('admin invite: an invite_activate code can be issued',
    public.otp_issue(gen_random_uuid(), 'invite_activate', 'oauth-t-invite@test.invalid', NULL, NULL, NULL,
                     _oauth_hash('2'), NULL, admin_a)->>'status' = 'issued');
  PERFORM _oauth_ok('admin invite: never marked as a Google signup',
    NOT EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = t_invite));
  PERFORM _oauth_insert_user(t_gt_invite, 'oauth-t-gt-invite@test.invalid', '{"provider": "email", "providers": ["email"]}');
  PERFORM _oauth_ok('GoTrue /invite: never marked as a Google signup',
    NOT EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = t_gt_invite));

  -- Linking Google later is an UPDATE: no mark.
  PERFORM _oauth_link_google(t_invite);
  PERFORM _oauth_ok('linking Google to an existing account marks nothing',
    NOT EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = t_invite));
END $$;

-- ─── 3. signup_create_company is unchanged ──────────────────────────────────

/*
  Verbatim from supabase/migrations/20260915100200_signup_rpcs.sql, renamed.
  This is the function as it stood before 20260916100010. A later migration
  that changes signup behaviour on purpose updates or removes this comparison
  in the same commit.
*/
CREATE OR REPLACE FUNCTION _oauth_ref_signup_create_company(
  p_user_id       uuid,
  p_email         text,
  p_full_name     text,
  p_company_name  text,
  p_plan          text,
  p_billing_cycle text,
  p_car_limit     integer,
  p_referral_code text,
  p_discount_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_trial_length  CONSTANT interval := interval '14 days';
  c_slug_attempts CONSTANT integer  := 10;

  v_email         text := lower(trim(p_email));
  v_full_name     text := trim(p_full_name);
  v_company_name  text := trim(p_company_name);
  v_ref_code      text := upper(trim(coalesce(p_referral_code, '')));
  v_now           timestamptz := now();
  v_plan          text;
  v_cycle         text;
  v_car_limit     integer;
  v_referral_id   uuid;
  v_ref_active    boolean;
  v_user          record;
  v_base_slug     text;
  v_company       public.companies%ROWTYPE;
  v_admin_role_id uuid;
BEGIN
  IF p_user_id IS NULL
     OR coalesce(v_email, '') = ''
     OR coalesce(v_full_name, '') = ''
     OR coalesce(v_company_name, '') = ''
  THEN
    RAISE EXCEPTION 'signup_create_company: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- 1. The same normalization company-signup applied in TypeScript:
  --    Math.max(1, Math.min(100, Math.floor(Number(x) || 3))) — so 0 and a
  --    missing value both mean 3.
  v_plan      := CASE WHEN p_plan IN ('basic','advanced','premium') THEN p_plan ELSE 'basic' END;
  v_cycle     := CASE WHEN p_billing_cycle = 'yearly' THEN 'yearly' ELSE 'monthly' END;
  v_car_limit := CASE WHEN coalesce(p_car_limit, 0) = 0 THEN 3
                      ELSE greatest(1, least(100, p_car_limit)) END;

  -- 2. Referral, before anything is written.
  IF v_ref_code <> '' THEN
    SELECT r.id, r.is_active INTO v_referral_id, v_ref_active
      FROM public.referrals r
     WHERE r.ref_code = v_ref_code;

    IF v_referral_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'referral_invalid');
    END IF;
    IF NOT v_ref_active THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'referral_inactive');
    END IF;
  END IF;

  -- 3. The account company-signup has just created: unconfirmed, the address
  --    the caller named, and not already attached to anything.
  SELECT u.id, u.email, u.email_confirmed_at INTO v_user
    FROM auth.users u
   WHERE u.id = p_user_id;

  IF NOT FOUND
     OR v_user.email_confirmed_at IS NOT NULL
     OR lower(v_user.email) IS DISTINCT FROM v_email
     OR EXISTS (SELECT 1 FROM app_private.pending_signups ps WHERE ps.user_id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.user_profiles up
                 WHERE up.user_id = p_user_id AND (up.company_id IS NOT NULL OR up.is_super_admin))
  THEN
    RAISE EXCEPTION 'signup_create_company: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- 4. Slug: the TypeScript transliteration. Upper-case umlauts are mapped
  --    first because lower() only folds non-ASCII letters under a UTF-8
  --    ctype, while JavaScript's toLowerCase always does.
  v_base_slug := replace(replace(replace(replace(v_company_name, 'Ä', 'ä'), 'Ö', 'ö'), 'Ü', 'ü'), 'ẞ', 'ß');
  v_base_slug := lower(v_base_slug);
  v_base_slug := replace(replace(replace(replace(v_base_slug, 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss');
  v_base_slug := regexp_replace(v_base_slug, '[^a-z0-9]+', '-', 'g');
  v_base_slug := regexp_replace(v_base_slug, '^-|-$', '', 'g');
  v_base_slug := left(v_base_slug, 60);

  -- 5. The company. ON CONFLICT on the slug instead of a look-then-insert, so
  --    two signups with the same name cannot both pick the same free slug.
  FOR i IN 1..c_slug_attempts LOOP
    INSERT INTO public.companies
      (name, slug, status, approval_status, plan, billing_cycle, subscription_car_limit,
       trial_start, trial_end, country, subscription_status,
       referral_id, referral_code_used, referred_at)
    VALUES
      (v_company_name,
       CASE WHEN i = 1 THEN v_base_slug
            ELSE v_base_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6) END,
       'trial', 'pending', v_plan, v_cycle, v_car_limit,
       v_now, v_now + c_trial_length, 'Deutschland', 'inactive',
       v_referral_id,
       CASE WHEN v_referral_id IS NOT NULL THEN v_ref_code END,
       CASE WHEN v_referral_id IS NOT NULL THEN v_now END)
    ON CONFLICT (slug) DO NOTHING
    RETURNING * INTO v_company;

    EXIT WHEN v_company.id IS NOT NULL;
  END LOOP;

  IF v_company.id IS NULL THEN
    RAISE EXCEPTION 'signup_create_company: no free slug';
  END IF;

  -- 6. The owner. pending_invite until the code is entered: an unconfirmed
  --    owner must not count as an active member of anything.
  SELECT r.id INTO v_admin_role_id
    FROM public.roles r
   WHERE r.name = 'admin' AND r.company_id IS NULL
   ORDER BY r.is_system DESC NULLS LAST, r.created_at
   LIMIT 1;

  INSERT INTO public.user_profiles
    (user_id, email, full_name, role, role_id, company_id, is_super_admin, status)
  VALUES
    (p_user_id, v_user.email, v_full_name, 'admin', v_admin_role_id, v_company.id, false, 'pending_invite')
  ON CONFLICT (user_id) DO UPDATE
    SET email          = EXCLUDED.email,
        full_name      = EXCLUDED.full_name,
        role           = EXCLUDED.role,
        role_id        = EXCLUDED.role_id,
        company_id     = EXCLUDED.company_id,
        is_super_admin = false,
        status         = 'pending_invite',
        updated_at     = now();

  -- 7.
  INSERT INTO public.company_settings (company_id, company_name)
  VALUES (v_company.id, v_company_name);

  INSERT INTO app_private.pending_signups (user_id, company_id, discount_code)
  VALUES (p_user_id, v_company.id, nullif(upper(trim(p_discount_code)), ''));

  -- 8.
  RETURN jsonb_build_object(
    'ok', true,
    'company', jsonb_build_object(
      'id',              v_company.id,
      'name',            v_company.name,
      'slug',            v_company.slug,
      'trial_end',       v_company.trial_end,
      'approval_status', v_company.approval_status
    )
  );
END;
$$;

/**
  A row as JSON with what legitimately differs between two runs replaced:
  generated ids, the random slug suffix, and timestamps (as seconds from now(),
  so the comparison also holds across transactions).
*/
CREATE OR REPLACE FUNCTION _oauth_norm(p_row jsonb) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_object_agg(e.key,
           CASE
             WHEN e.key IN ('id', 'company_id', 'referral_id') AND jsonb_typeof(e.value) <> 'null'
               THEN to_jsonb('<generated>'::text)
             WHEN e.key = 'slug'
               THEN to_jsonb(regexp_replace(e.value #>> '{}', '-[0-9a-f]{6}$', '-<suffix>'))
             WHEN jsonb_typeof(e.value) = 'string'
                  AND e.value #>> '{}' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'
               THEN to_jsonb(extract(epoch FROM ((e.value #>> '{}')::timestamptz - now())))
             ELSE e.value
           END)
    FROM jsonb_each(p_row) AS e
$$;

/** Everything a signup call wrote for one account, and the result it returned. */
CREATE OR REPLACE FUNCTION _oauth_signup_snapshot(p_user_id uuid, p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_co uuid;
BEGIN
  SELECT up.company_id INTO v_co FROM user_profiles up WHERE up.user_id = p_user_id;
  RETURN jsonb_build_object(
    'result', CASE WHEN p_result ? 'company'
                   THEN jsonb_set(p_result, '{company}', _oauth_norm(p_result -> 'company'))
                   ELSE p_result END,
    'result_names_the_company', (p_result -> 'company' ->> 'id')::uuid IS NOT DISTINCT FROM v_co,
    'company',        (SELECT _oauth_norm(to_jsonb(c))  FROM companies c WHERE c.id = v_co),
    'profile',        (SELECT _oauth_norm(to_jsonb(up)) FROM user_profiles up WHERE up.user_id = p_user_id),
    'settings',       (SELECT jsonb_agg(_oauth_norm(to_jsonb(s))) FROM company_settings s WHERE s.company_id = v_co),
    'pending_signup', (SELECT _oauth_norm(to_jsonb(ps)) || jsonb_build_object('same_company', ps.company_id = v_co)
                         FROM app_private.pending_signups ps WHERE ps.user_id = p_user_id),
    'rows', jsonb_build_object(
      'companies',   (SELECT count(*) FROM companies),
      'settings',    (SELECT count(*) FROM company_settings),
      'profiles',    (SELECT count(*) FROM user_profiles),
      'pending',     (SELECT count(*) FROM app_private.pending_signups),
      'redemptions', (SELECT count(*) FROM discount_code_redemptions)));
END $$;

/**
  Runs one signup call in a subtransaction that is always rolled back and
  returns what it wrote, or the error it raised. Two calls made this way start
  from exactly the same state.
*/
CREATE OR REPLACE FUNCTION _oauth_discarded(p_user_id uuid, p_call text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_result jsonb;
  v_out    jsonb;
BEGIN
  BEGIN
    EXECUTE p_call INTO v_result;
    v_out := _oauth_signup_snapshot(p_user_id, v_result);
    RAISE EXCEPTION USING ERRCODE = 'OAT01', MESSAGE = 'discard this run';
  EXCEPTION
    WHEN SQLSTATE 'OAT01' THEN
      RETURN v_out;
    WHEN OTHERS THEN
      RETURN jsonb_build_object('raised', SQLSTATE, 'message', SQLERRM);
  END;
END $$;

/** The same arguments through the 20260915100200 copy and through today's function. */
CREATE OR REPLACE FUNCTION _oauth_compare_signup(p_desc text, p_user_id uuid, p_args text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_before jsonb := _oauth_discarded(p_user_id, format('SELECT _oauth_ref_signup_create_company(%s)', p_args));
  v_after  jsonb := _oauth_discarded(p_user_id, format('SELECT public.signup_create_company(%s)', p_args));
BEGIN
  PERFORM _oauth_same(p_desc, v_before, v_after);
  RETURN v_after;
END $$;

DO $$
DECLARE
  e_pre      uuid := '9a000003-0000-4000-8000-000000000001';
  e_noprof   uuid := '9a000003-0000-4000-8000-000000000002';
  e_coll     uuid := '9a000003-0000-4000-8000-000000000003';
  e_ref      uuid := '9a000003-0000-4000-8000-000000000004';
  e_conf     uuid := '9a000003-0000-4000-8000-000000000005';
  e_attached uuid := '9a000003-0000-4000-8000-000000000006';
  e_super    uuid := '9a000003-0000-4000-8000-000000000007';
  e_pending  uuid := '9a000003-0000-4000-8000-000000000008';
  e_neg      uuid := '9a000003-0000-4000-8000-000000000009';
  e_nulls    uuid := '9a000003-0000-4000-8000-00000000000a';
  e_umlaut   uuid := '9a000003-0000-4000-8000-00000000000b';
  v          jsonb;
BEGIN
  -- Accounts as company-signup leaves them after createUser: unconfirmed, with
  -- the profile handle_new_user writes. e_noprof has none, for the insert
  -- branch of the profile upsert.
  PERFORM _oauth_password_signup_account(e_pre,      'oauth-e-pre@test.invalid');
  PERFORM _oauth_password_signup_account(e_noprof,   'oauth-e-noprof@test.invalid');
  PERFORM _oauth_password_signup_account(e_coll,     'oauth-e-coll@test.invalid');
  PERFORM _oauth_password_signup_account(e_ref,      'oauth-e-ref@test.invalid');
  PERFORM _oauth_password_signup_account(e_conf,     'oauth-e-conf@test.invalid');
  PERFORM _oauth_password_signup_account(e_attached, 'oauth-e-attached@test.invalid');
  PERFORM _oauth_password_signup_account(e_super,    'oauth-e-super@test.invalid');
  PERFORM _oauth_password_signup_account(e_pending,  'oauth-e-pending@test.invalid');
  PERFORM _oauth_password_signup_account(e_neg,      'oauth-e-neg@test.invalid');
  PERFORM _oauth_password_signup_account(e_nulls,    'oauth-e-nulls@test.invalid');
  PERFORM _oauth_password_signup_account(e_umlaut,   'oauth-e-umlaut@test.invalid');

  DELETE FROM user_profiles WHERE user_id = e_noprof;
  UPDATE auth.users SET email_confirmed_at = now() WHERE id = e_conf;
  UPDATE user_profiles SET company_id = 'c0000000-0000-4000-8000-00000000000a' WHERE user_id = e_attached;
  UPDATE user_profiles SET is_super_admin = true WHERE user_id = e_super;
  PERFORM public.signup_create_company(e_pending, 'oauth-e-pending@test.invalid', 'Pia', 'Pia GmbH',
                                       NULL, NULL, NULL, NULL, NULL);

  INSERT INTO referrals (ref_code, name, is_active) VALUES
    ('EQ-ON', 'Equivalence active', true),
    ('EQ-OFF', 'Equivalence inactive', false);
  INSERT INTO companies (name, slug, approval_status, status, plan, subscription_status)
  VALUES ('EQ Kollision GmbH', 'eq-kollision-gmbh', 'approved', 'active', 'basic', 'active');

  v := _oauth_compare_signup('same rows: a profile from handle_new_user, active referral, discount, odd plan and cycle',
    e_pre, format('%L, %L, %L, %L, %L, %L, %L, %L, %L', e_pre, ' OAuth-E-Pre@Test.Invalid ', ' Olga Owner ',
                  ' Müller & Söhne Taxi ', 'platinum', 'weekly', 0, ' eq-on ', ' spring10 '));
  PERFORM _oauth_ok('(control) that signup succeeded, pending_invite, transliterated slug',
    v->'result'->>'ok' = 'true' AND v->'profile'->>'status' = 'pending_invite'
    AND v->'company'->>'slug' = 'mueller-soehne-taxi' AND v->'pending_signup'->>'discount_code' = 'SPRING10');

  v := _oauth_compare_signup('same rows: no profile yet, premium yearly, 500 cars, blank discount',
    e_noprof, format('%L, %L, %L, %L, %L, %L, %L, NULL, %L', e_noprof, 'oauth-e-noprof@test.invalid', 'Nora',
                     'Nora Fahrdienst', 'premium', 'yearly', 500, '  '));
  PERFORM _oauth_ok('(control) the profile was inserted, 100 cars',
    v->'result'->>'ok' = 'true' AND v->'profile'->>'role' = 'admin' AND (v->'company'->>'subscription_car_limit')::int = 100);

  v := _oauth_compare_signup('same rows: a slug that is taken gets the suffix',
    e_coll, format('%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL', e_coll, 'oauth-e-coll@test.invalid', 'Kai', 'EQ Kollision GmbH'));
  PERFORM _oauth_ok('(control) the suffix path ran', v->'company'->>'slug' = 'eq-kollision-gmbh-<suffix>');

  v := _oauth_compare_signup('same result: an unknown referral code',
    e_ref, format('%L, %L, %L, %L, NULL, NULL, NULL, %L, NULL', e_ref, 'oauth-e-ref@test.invalid', 'R', 'R GmbH', 'no-such'));
  PERFORM _oauth_ok('(control) referral_invalid, nothing written',
    v->'result'->>'reason' = 'referral_invalid' AND jsonb_typeof(v->'company') = 'null');
  v := _oauth_compare_signup('same result: an inactive referral code',
    e_ref, format('%L, %L, %L, %L, NULL, NULL, NULL, %L, NULL', e_ref, 'oauth-e-ref@test.invalid', 'R', 'R GmbH', 'EQ-OFF'));
  PERFORM _oauth_ok('(control) referral_inactive', v->'result'->>'reason' = 'referral_inactive');

  v := _oauth_compare_signup('same error: a confirmed account',
    e_conf, format('%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL', e_conf, 'oauth-e-conf@test.invalid', 'C', 'C GmbH'));
  PERFORM _oauth_ok('(control) 22023', v->>'raised' = '22023');
  v := _oauth_compare_signup('same error: an address that is not the account''s',
    e_pre, format('%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL', e_pre, 'someone-else@test.invalid', 'C', 'C GmbH'));
  PERFORM _oauth_ok('(control) 22023', v->>'raised' = '22023');
  v := _oauth_compare_signup('same error: a blank company name',
    e_pre, format('%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL', e_pre, 'oauth-e-pre@test.invalid', 'C', '   '));
  PERFORM _oauth_ok('(control) 22023', v->>'raised' = '22023');
  v := _oauth_compare_signup('same error: an account already in a company',
    e_attached, format('%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL', e_attached, 'oauth-e-attached@test.invalid', 'C', 'C GmbH'));
  PERFORM _oauth_ok('(control) 22023', v->>'raised' = '22023');
  v := _oauth_compare_signup('same error: platform staff',
    e_super, format('%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL', e_super, 'oauth-e-super@test.invalid', 'C', 'C GmbH'));
  PERFORM _oauth_ok('(control) 22023', v->>'raised' = '22023');
  v := _oauth_compare_signup('same error: a second signup for the same account',
    e_pending, format('%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL', e_pending, 'oauth-e-pending@test.invalid', 'C', 'Noch eine GmbH'));
  PERFORM _oauth_ok('(control) 22023', v->>'raised' = '22023');

  v := _oauth_compare_signup('same rows: a negative car limit',
    e_neg, format('%L, %L, %L, %L, %L, NULL, %L, NULL, NULL', e_neg, 'oauth-e-neg@test.invalid', 'N', 'Neg GmbH', 'advanced', -5));
  PERFORM _oauth_ok('(control) clamped to 1', (v->'company'->>'subscription_car_limit')::int = 1);
  v := _oauth_compare_signup('same rows: no plan, cycle or car limit at all',
    e_nulls, format('%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL', e_nulls, 'oauth-e-nulls@test.invalid', 'N', 'Null GmbH'));
  PERFORM _oauth_ok('(control) basic, monthly, 3',
    v->'company'->>'plan' = 'basic' AND v->'company'->>'billing_cycle' = 'monthly'
    AND (v->'company'->>'subscription_car_limit')::int = 3);
  v := _oauth_compare_signup('same rows: upper-case umlauts and ẞ',
    e_umlaut, format('%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL', e_umlaut, 'oauth-e-umlaut@test.invalid', 'U', 'ÄÖÜ GROẞE Straße'));
  PERFORM _oauth_ok('(control) transliterated', v->'company'->>'slug' = 'aeoeue-grosse-strasse');
END $$;

-- ─── 4. oauth_signup_create_company ─────────────────────────────────────────

DO $$
DECLARE
  c_ok      uuid := '9a000004-0000-4000-8000-000000000001';
  c_plain   uuid := '9a000004-0000-4000-8000-000000000002';
  c_baddisc uuid := '9a000004-0000-4000-8000-000000000003';
  c_unconf  uuid := '9a000004-0000-4000-8000-000000000004';
  c_noid    uuid := '9a000004-0000-4000-8000-000000000005';
  c_staff   uuid := '9a000004-0000-4000-8000-000000000006';
  c_company uuid := '9a000004-0000-4000-8000-000000000007';
  c_nopend  uuid := '9a000004-0000-4000-8000-000000000008';
  c_banned  uuid := '9a000004-0000-4000-8000-000000000009';
  c_deleted uuid := '9a000004-0000-4000-8000-00000000000a';
  c_susp    uuid := '9a000004-0000-4000-8000-00000000000b';
  c_ref     uuid := '9a000004-0000-4000-8000-00000000000c';
  sys_admin uuid := '84626035-c3a2-4ff5-96b9-a95cceb85cb0';   -- roles-seed.sql
  company_a uuid := 'c0000000-0000-4000-8000-00000000000a';
  ref_on    uuid;
  dc        uuid;
  co        uuid;
  r         jsonb;
  comp      record;
  prof      record;
  n_before  bigint;
BEGIN
  PERFORM _oauth_google_signup(c_ok,      'oauth-c-ok@test.invalid');
  PERFORM _oauth_google_signup(c_plain,   'oauth-c-plain@test.invalid');
  PERFORM _oauth_google_signup(c_baddisc, 'oauth-c-baddisc@test.invalid');
  PERFORM _oauth_google_signup(c_unconf,  'oauth-c-unconf@test.invalid', false);
  PERFORM _oauth_google_signup(c_staff,   'oauth-c-staff@test.invalid');
  PERFORM _oauth_google_signup(c_company, 'oauth-c-company@test.invalid');
  PERFORM _oauth_google_signup(c_nopend,  'oauth-c-nopend@test.invalid');
  PERFORM _oauth_google_signup(c_banned,  'oauth-c-banned@test.invalid');
  PERFORM _oauth_google_signup(c_deleted, 'oauth-c-deleted@test.invalid');
  PERFORM _oauth_google_signup(c_susp,    'oauth-c-susp@test.invalid');
  PERFORM _oauth_google_signup(c_ref,     'oauth-c-ref@test.invalid');
  -- Marked and confirmed, but its only identity is an email one.
  PERFORM _oauth_insert_user(c_noid, 'oauth-c-noid@test.invalid', '{"provider": "google", "providers": ["google"]}', now());
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  VALUES (c_noid::text, c_noid, jsonb_build_object('sub', c_noid::text, 'email', 'oauth-c-noid@test.invalid'), 'email', now(), now());

  UPDATE user_profiles SET is_super_admin = true WHERE user_id = c_staff;
  UPDATE user_profiles SET company_id = company_a, status = 'active' WHERE user_id = c_company;
  DELETE FROM app_private.pending_oauth_signups WHERE user_id = c_nopend;
  UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = c_banned;
  UPDATE auth.users SET deleted_at = now() WHERE id = c_deleted;
  UPDATE user_profiles SET status = 'suspended' WHERE user_id = c_susp;

  INSERT INTO referrals (ref_code, name, is_active) VALUES
    ('G-ON', 'Google active', true),
    ('G-OFF', 'Google inactive', false);
  SELECT id INTO ref_on FROM referrals WHERE ref_code = 'G-ON';
  INSERT INTO discount_codes (code, discount_type, discount_value, usage_mode, audience_type, max_redemptions)
  VALUES ('GOOGLE10', 'percentage', 10, 'once', 'multiple', 5)
  RETURNING id INTO dc;

  -- refusals, in the order the function checks them
  PERFORM _oauth_ok('no user id raises 22023',
    _oauth_sqlstate('SELECT public.oauth_signup_create_company(NULL, ''X'', ''X GmbH'', NULL, NULL, NULL, NULL)') = '22023');
  PERFORM _oauth_ok('a blank owner name raises 22023',
    _oauth_sqlstate(format('SELECT public.oauth_signup_create_company(%L, %L, %L, NULL, NULL, NULL, NULL)', c_ok, '  ', 'X GmbH')) = '22023');
  PERFORM _oauth_ok('a blank company name raises 22023',
    _oauth_sqlstate(format('SELECT public.oauth_signup_create_company(%L, %L, %L, NULL, NULL, NULL, NULL)', c_ok, 'X', ' ')) = '22023');
  PERFORM _oauth_ok('an unknown account raises OA001 account_not_found',
    _oauth_sqlstate(format('SELECT public.oauth_signup_create_company(%L, %L, %L, NULL, NULL, NULL, NULL)', gen_random_uuid(), 'X', 'X GmbH')) = 'OA001');
  PERFORM _oauth_ok('a banned account raises OA002 account_blocked',
    _oauth_sqlstate(format('SELECT public.oauth_signup_create_company(%L, %L, %L, NULL, NULL, NULL, NULL)', c_banned, 'X', 'X GmbH')) = 'OA002');
  PERFORM _oauth_ok('a soft-deleted account raises OA002 account_blocked',
    _oauth_sqlstate(format('SELECT public.oauth_signup_create_company(%L, %L, %L, NULL, NULL, NULL, NULL)', c_deleted, 'X', 'X GmbH')) = 'OA002');
  PERFORM _oauth_ok('a suspended profile raises OA002 account_blocked',
    _oauth_sqlstate(format('SELECT public.oauth_signup_create_company(%L, %L, %L, NULL, NULL, NULL, NULL)', c_susp, 'X', 'X GmbH')) = 'OA002');
  PERFORM _oauth_ok('an unconfirmed address raises OA003 email_not_confirmed',
    _oauth_sqlstate(format('SELECT public.oauth_signup_create_company(%L, %L, %L, NULL, NULL, NULL, NULL)', c_unconf, 'X', 'X GmbH')) = 'OA003');
  PERFORM _oauth_ok('an account without a google identity raises OA004 not_google_account',
    _oauth_sqlstate(format('SELECT public.oauth_signup_create_company(%L, %L, %L, NULL, NULL, NULL, NULL)', c_noid, 'X', 'X GmbH')) = 'OA004');
  PERFORM _oauth_ok('platform staff raise OA005 platform_staff',
    _oauth_sqlstate(format('SELECT public.oauth_signup_create_company(%L, %L, %L, NULL, NULL, NULL, NULL)', c_staff, 'X', 'X GmbH')) = 'OA005');
  PERFORM _oauth_ok('an account in a company raises OA006 company_exists',
    _oauth_sqlstate(format('SELECT public.oauth_signup_create_company(%L, %L, %L, NULL, NULL, NULL, NULL)', c_company, 'X', 'X GmbH')) = 'OA006');
  PERFORM _oauth_ok('a Google account that is no pending signup raises OA007 no_pending_signup',
    _oauth_sqlstate(format('SELECT public.oauth_signup_create_company(%L, %L, %L, NULL, NULL, NULL, NULL)', c_nopend, 'X', 'X GmbH')) = 'OA007');

  SELECT (SELECT count(*) FROM companies) + (SELECT count(*) FROM company_settings)
       + (SELECT count(*) FROM discount_code_redemptions) INTO n_before;
  PERFORM _oauth_ok('an unknown referral code raises OA008 referral_invalid',
    _oauth_sqlstate(format('SELECT public.oauth_signup_create_company(%L, %L, %L, NULL, NULL, NULL, %L, %L)',
                           c_ref, 'X', 'X GmbH', 'no-such-code', 'GOOGLE10')) = 'OA008');
  PERFORM _oauth_ok('an inactive referral code raises OA009 referral_inactive',
    _oauth_sqlstate(format('SELECT public.oauth_signup_create_company(%L, %L, %L, NULL, NULL, NULL, %L, %L)',
                           c_ref, 'X', 'X GmbH', ' g-off ', 'GOOGLE10')) = 'OA009');
  PERFORM _oauth_ok('a refusal writes nothing: no company, settings or redemption, the mark and the profile as they were',
    (SELECT count(*) FROM companies) + (SELECT count(*) FROM company_settings)
      + (SELECT count(*) FROM discount_code_redemptions) = n_before
    AND EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = c_ref)
    AND (SELECT company_id IS NULL AND status = 'pending_invite' FROM user_profiles WHERE user_id = c_ref)
    AND (SELECT used_count FROM discount_codes WHERE id = dc) = 0);

  -- success, with a referral and a discount code
  r := public.oauth_signup_create_company(c_ok, ' Greta Google ', ' Straßen & Söhne Taxi ',
                                          'premium', 'yearly', 12, ' g-on ', ' google10 ');
  PERFORM _oauth_ok('a valid Google signup returns ok with the company summary',
    r->>'ok' = 'true' AND r->'company'->>'name' = 'Straßen & Söhne Taxi'
    AND r->'company'->>'slug' = 'strassen-soehne-taxi' AND r->'company'->>'approval_status' = 'pending');
  co := (r->'company'->>'id')::uuid;
  SELECT * INTO comp FROM companies WHERE id = co;
  PERFORM _oauth_ok('the company waits for approval: a pending, inactive trial in Deutschland',
    comp.approval_status = 'pending' AND comp.status = 'trial' AND comp.subscription_status = 'inactive'
    AND comp.country = 'Deutschland' AND comp.approved_at IS NULL);
  PERFORM _oauth_ok('plan, cycle, cars and the 14-day trial as asked',
    comp.plan = 'premium' AND comp.billing_cycle = 'yearly' AND comp.subscription_car_limit = 12
    AND comp.trial_start = now() AND comp.trial_end = now() + interval '14 days'
    AND (r->'company'->>'trial_end')::timestamptz = comp.trial_end);
  PERFORM _oauth_ok('the referral is recorded under its upper-cased code',
    comp.referral_id = ref_on AND comp.referral_code_used = 'G-ON' AND comp.referred_at = now());

  SELECT * INTO prof FROM user_profiles WHERE user_id = c_ok;
  PERFORM _oauth_ok('the owner is the company admin with the system admin role_id, not staff',
    prof.role = 'admin' AND prof.role_id = sys_admin AND prof.company_id = co AND NOT prof.is_super_admin);
  PERFORM _oauth_ok('the owner is active at once, activated now, with the account address and the trimmed name',
    prof.status = 'active' AND prof.activated_at = now()
    AND prof.email = 'oauth-c-ok@test.invalid' AND prof.full_name = 'Greta Google');
  PERFORM _oauth_ok('company_settings is created with the company name',
    EXISTS (SELECT 1 FROM company_settings WHERE company_id = co AND company_name = 'Straßen & Söhne Taxi'));
  PERFORM _oauth_ok('the mark is gone and no code-confirmed pending signup exists',
    NOT EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = c_ok)
    AND NOT EXISTS (SELECT 1 FROM app_private.pending_signups WHERE user_id = c_ok));
  PERFORM _oauth_ok('the discount code is redeemed at once through redeem_discount_code',
    r->'discount'->>'success' = 'true' AND (r->'discount'->>'discount_code_id')::uuid = dc
    AND (SELECT count(*) FROM discount_code_redemptions WHERE company_id = co) = 1
    AND (SELECT used_count FROM discount_codes WHERE id = dc) = 1
    AND (SELECT active_discount_code_id FROM companies WHERE id = co) = dc);

  PERFORM _oauth_ok('a second submission raises OA006 company_exists',
    _oauth_sqlstate(format('SELECT public.oauth_signup_create_company(%L, %L, %L, NULL, NULL, NULL, NULL, %L)',
                           c_ok, 'Greta', 'Zweite GmbH', 'GOOGLE10')) = 'OA006');
  PERFORM _oauth_ok('and changes nothing: one company, one redemption',
    (SELECT company_id FROM user_profiles WHERE user_id = c_ok) = co
    AND NOT EXISTS (SELECT 1 FROM companies WHERE name = 'Zweite GmbH')
    AND (SELECT used_count FROM discount_codes WHERE id = dc) = 1);

  -- success without referral or discount, through the parameter default
  r := public.oauth_signup_create_company(c_plain, 'Paul Plain', 'Plain GmbH', 'platinum', 'weekly', 0, NULL);
  SELECT * INTO comp FROM companies WHERE id = (r->'company'->>'id')::uuid;
  PERFORM _oauth_ok('without a discount code: ok, discount null, and the password signup''s normalization',
    r->>'ok' = 'true' AND jsonb_typeof(r->'discount') = 'null'
    AND comp.plan = 'basic' AND comp.billing_cycle = 'monthly' AND comp.subscription_car_limit = 3
    AND comp.referral_id IS NULL AND comp.referral_code_used IS NULL AND comp.referred_at IS NULL);

  -- a discount code that does not apply does not undo the company
  r := public.oauth_signup_create_company(c_baddisc, 'Berta', 'Berta Taxi', NULL, NULL, NULL, NULL, 'no-such-discount');
  co := (r->'company'->>'id')::uuid;
  PERFORM _oauth_ok('an unusable discount code: the company stands and the refusal is returned',
    r->>'ok' = 'true' AND r->'discount'->>'success' = 'false' AND r->'discount'->>'reason_code' = 'INVALID'
    AND EXISTS (SELECT 1 FROM companies WHERE id = co)
    AND (SELECT status FROM user_profiles WHERE user_id = c_baddisc) = 'active'
    AND NOT EXISTS (SELECT 1 FROM discount_code_redemptions WHERE company_id = co)
    AND NOT EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = c_baddisc));
END $$;

-- ─── 5. oauth_session_reconcile ─────────────────────────────────────────────

DO $$
DECLARE
  r_pend    uuid := '9a000005-0000-4000-8000-000000000001';
  r_appr    uuid := '9a000005-0000-4000-8000-000000000002';
  r_member  uuid := '9a000005-0000-4000-8000-000000000003';
  r_other   uuid := '9a000005-0000-4000-8000-000000000013';
  r_inv     uuid := '9a000005-0000-4000-8000-000000000004';
  r_inv_pw  uuid := '9a000005-0000-4000-8000-000000000005';
  r_active  uuid := '9a000005-0000-4000-8000-000000000006';
  r_staff   uuid := '9a000005-0000-4000-8000-000000000007';
  r_fresh   uuid := '9a000005-0000-4000-8000-000000000008';
  r_unconf  uuid := '9a000005-0000-4000-8000-000000000009';
  r_banned  uuid := '9a000005-0000-4000-8000-00000000000a';
  r_staff_inv  uuid := '9a000005-0000-4000-8000-00000000000b';
  r_staff_pend uuid := '9a000005-0000-4000-8000-00000000000c';
  company_a uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a   uuid := 'a0000000-0000-4000-8000-000000000001';
  c_signup  uuid := gen_random_uuid();
  c_invite  uuid := gen_random_uuid();
  co        uuid;
  co_appr   uuid;
  co_member uuid;
  co_staff  uuid;
  r         jsonb;
  prof      record;
  before    jsonb;
BEGIN
  -- A password signup that never entered its code, with its code still open ...
  PERFORM _oauth_password_signup_account(r_pend, 'oauth-r-pend@test.invalid');
  co := (public.signup_create_company(r_pend, 'oauth-r-pend@test.invalid', 'Rita Rückzug', 'Rückzug GmbH',
                                      NULL, NULL, NULL, NULL, 'SPRING10')->'company'->>'id')::uuid;
  PERFORM _oauth_ok('reconcile setup: the pending signup holds an open code',
    public.otp_issue(c_signup, 'signup_verify', 'oauth-r-pend@test.invalid', NULL, NULL, NULL,
                     _oauth_hash('r1'), NULL, NULL)->>'status' = 'issued');
  -- ... then its owner signs in with Google.
  PERFORM _oauth_link_google(r_pend);
  PERFORM _oauth_ok('the Google sign-in inserted nothing, so the account is not marked yet',
    NOT EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = r_pend));

  r := public.oauth_session_reconcile(r_pend);
  PERFORM _oauth_ok('a never-approved pending signup with only its owner is cancelled',
    r->>'action' = 'pending_signup_cancelled' AND (r->>'company_id')::uuid = co);
  PERFORM _oauth_ok('its company, settings and pending signup are gone',
    NOT EXISTS (SELECT 1 FROM companies WHERE id = co)
    AND NOT EXISTS (SELECT 1 FROM company_settings WHERE company_id = co)
    AND NOT EXISTS (SELECT 1 FROM app_private.pending_signups WHERE user_id = r_pend));
  SELECT * INTO prof FROM user_profiles WHERE user_id = r_pend;
  PERFORM _oauth_ok('the account, its google identity and its profile stay, the profile as a new Google account''s',
    EXISTS (SELECT 1 FROM auth.users WHERE id = r_pend)
    AND EXISTS (SELECT 1 FROM auth.identities WHERE user_id = r_pend AND provider = 'google')
    AND prof.company_id IS NULL AND prof.role = 'viewer' AND prof.role_id IS NULL
    AND prof.status = 'pending_invite' AND NOT prof.is_super_admin);
  PERFORM _oauth_ok('the account is now marked, so it can register again or be purged',
    EXISTS (SELECT 1 FROM app_private.pending_oauth_signups
             WHERE user_id = r_pend AND email = 'oauth-r-pend@test.invalid' AND created_at = now()));
  PERFORM _oauth_ok('the code mailed for the cancelled signup is closed and no longer verifies',
    (SELECT superseded_at IS NOT NULL FROM app_private.otp_challenges WHERE id = c_signup)
    AND public.otp_verify(c_signup, 'signup_verify', _oauth_hash('r1'), NULL)->>'status' = 'not_found');
  r := public.oauth_session_reconcile(r_pend);
  PERFORM _oauth_ok('reconciling again does nothing', r->>'action' = 'none' AND r->>'reason' = 'nothing_pending');
  r := public.oauth_signup_create_company(r_pend, 'Rita Rückzug', 'Neustart GmbH', NULL, NULL, NULL, NULL);
  PERFORM _oauth_ok('the owner registers again through Google and is active in the new company',
    r->>'ok' = 'true'
    AND (SELECT status = 'active' AND company_id = (r->'company'->>'id')::uuid FROM user_profiles WHERE user_id = r_pend));

  -- approved in the meantime
  PERFORM _oauth_password_signup_account(r_appr, 'oauth-r-appr@test.invalid');
  co_appr := (public.signup_create_company(r_appr, 'oauth-r-appr@test.invalid', 'Anna', 'Anna GmbH',
                                           NULL, NULL, NULL, NULL, NULL)->'company'->>'id')::uuid;
  UPDATE companies SET approval_status = 'approved', approved_at = now() WHERE id = co_appr;
  PERFORM _oauth_link_google(r_appr);
  r := public.oauth_session_reconcile(r_appr);
  PERFORM _oauth_ok('a pending signup whose company was approved is kept',
    r->>'action' = 'none' AND r->>'reason' = 'pending_signup_kept' AND (r->>'company_id')::uuid = co_appr);
  PERFORM _oauth_ok('and nothing of it is touched',
    EXISTS (SELECT 1 FROM companies WHERE id = co_appr)
    AND EXISTS (SELECT 1 FROM app_private.pending_signups WHERE user_id = r_appr)
    AND (SELECT company_id FROM user_profiles WHERE user_id = r_appr) = co_appr
    AND NOT EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = r_appr));

  -- someone else belongs to it
  PERFORM _oauth_password_signup_account(r_member, 'oauth-r-member@test.invalid');
  co_member := (public.signup_create_company(r_member, 'oauth-r-member@test.invalid', 'Mia', 'Mia GmbH',
                                             NULL, NULL, NULL, NULL, NULL)->'company'->>'id')::uuid;
  PERFORM _oauth_insert_user(r_other, 'oauth-r-other@test.invalid', '{"provider": "email", "providers": ["email"]}', now());
  UPDATE user_profiles SET company_id = co_member, status = 'active' WHERE user_id = r_other;
  PERFORM _oauth_link_google(r_member);
  r := public.oauth_session_reconcile(r_member);
  PERFORM _oauth_ok('a pending signup with a second member is kept',
    r->>'action' = 'none' AND r->>'reason' = 'pending_signup_kept'
    AND EXISTS (SELECT 1 FROM companies WHERE id = co_member)
    AND (SELECT company_id FROM user_profiles WHERE user_id = r_other) = co_member);

  -- an invited employee who has not accepted yet
  PERFORM _oauth_invited_employee(r_inv, 'oauth-r-inv@test.invalid', company_a);
  PERFORM _oauth_ok('invite setup: the invitation code is open',
    public.otp_issue(c_invite, 'invite_activate', 'oauth-r-inv@test.invalid', NULL, NULL, NULL,
                     _oauth_hash('r2'), NULL, admin_a)->>'status' = 'issued');
  PERFORM _oauth_link_google(r_inv);
  r := public.oauth_session_reconcile(r_inv);
  PERFORM _oauth_ok('a pending invitation is accepted', r->>'action' = 'invite_accepted' AND (r->>'company_id')::uuid = company_a);
  SELECT * INTO prof FROM user_profiles WHERE user_id = r_inv;
  PERFORM _oauth_ok('the employee is active in the same company, with the same role, activated now',
    prof.status = 'active' AND prof.activated_at = now() AND prof.company_id = company_a
    AND prof.role = 'viewer' AND prof.role_id = 'fdb2798f-08a7-481c-8bbb-67e15540926e'
    AND NOT prof.must_change_password);
  PERFORM _oauth_ok('the invitation code is closed',
    (SELECT superseded_at IS NOT NULL FROM app_private.otp_challenges WHERE id = c_invite));
  PERFORM _oauth_ok('no company or mark was created for the employee',
    NOT EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = r_inv)
    AND NOT EXISTS (SELECT 1 FROM app_private.pending_signups WHERE user_id = r_inv));
  r := public.oauth_session_reconcile(r_inv);
  PERFORM _oauth_ok('reconciling the accepted employee again does nothing',
    r->>'action' = 'none' AND r->>'reason' = 'nothing_pending');

  -- the same invitation without Google: nothing
  PERFORM _oauth_invited_employee(r_inv_pw, 'oauth-r-inv-pw@test.invalid', company_a);
  r := public.oauth_session_reconcile(r_inv_pw);
  PERFORM _oauth_ok('without a google identity an invitation is not accepted',
    r->>'action' = 'none' AND r->>'reason' = 'not_google_account'
    AND (SELECT status FROM user_profiles WHERE user_id = r_inv_pw) = 'pending_invite');

  -- no-ops
  PERFORM _oauth_insert_user(r_active, 'oauth-r-active@test.invalid', '{"provider": "email", "providers": ["email"]}', now());
  UPDATE user_profiles SET company_id = company_a, status = 'active', activated_at = now() - interval '30 days'
   WHERE user_id = r_active;
  PERFORM _oauth_link_google(r_active);
  SELECT to_jsonb(up) INTO before FROM user_profiles up WHERE up.user_id = r_active;
  r := public.oauth_session_reconcile(r_active);
  PERFORM _oauth_ok('an active member signing in with Google: nothing to do, profile untouched',
    r->>'action' = 'none' AND r->>'reason' = 'nothing_pending'
    AND (SELECT to_jsonb(up) FROM user_profiles up WHERE up.user_id = r_active) = before);

  PERFORM _oauth_google_signup(r_staff, 'oauth-r-staff@test.invalid');
  UPDATE user_profiles SET is_super_admin = true WHERE user_id = r_staff;
  SELECT to_jsonb(up) INTO before FROM user_profiles up WHERE up.user_id = r_staff;
  r := public.oauth_session_reconcile(r_staff);
  PERFORM _oauth_ok('platform staff: nothing, whatever else holds',
    r->>'action' = 'none' AND r->>'reason' = 'platform_staff'
    AND (SELECT to_jsonb(up) FROM user_profiles up WHERE up.user_id = r_staff) = before);

  -- Platform staff never sign in with Google (owner decision, 16.09.2026), so a
  -- Google sign-in settles nothing that is pending on a staff account either.
  PERFORM _oauth_invited_employee(r_staff_inv, 'oauth-r-staff-inv@test.invalid', company_a);
  UPDATE user_profiles SET is_super_admin = true WHERE user_id = r_staff_inv;
  PERFORM _oauth_link_google(r_staff_inv);
  SELECT to_jsonb(up) INTO before FROM user_profiles up WHERE up.user_id = r_staff_inv;
  r := public.oauth_session_reconcile(r_staff_inv);
  PERFORM _oauth_ok('platform staff with a pending invitation: platform_staff, and the invitation is not accepted',
    r->>'action' = 'none' AND r->>'reason' = 'platform_staff'
    AND before->>'status' = 'pending_invite'
    AND (SELECT to_jsonb(up) FROM user_profiles up WHERE up.user_id = r_staff_inv) = before);

  PERFORM _oauth_password_signup_account(r_staff_pend, 'oauth-r-staff-pend@test.invalid');
  co_staff := (public.signup_create_company(r_staff_pend, 'oauth-r-staff-pend@test.invalid', 'Paula Plattform', 'Plattform GmbH',
                                            NULL, NULL, NULL, NULL, NULL)->'company'->>'id')::uuid;
  UPDATE user_profiles SET is_super_admin = true WHERE user_id = r_staff_pend;
  PERFORM _oauth_link_google(r_staff_pend);
  SELECT to_jsonb(up) INTO before FROM user_profiles up WHERE up.user_id = r_staff_pend;
  r := public.oauth_session_reconcile(r_staff_pend);
  PERFORM _oauth_ok('platform staff with a pending password signup: platform_staff, and the signup is not cancelled',
    r->>'action' = 'none' AND r->>'reason' = 'platform_staff'
    AND EXISTS (SELECT 1 FROM companies WHERE id = co_staff)
    AND EXISTS (SELECT 1 FROM app_private.pending_signups WHERE user_id = r_staff_pend AND company_id = co_staff)
    AND (SELECT to_jsonb(up) FROM user_profiles up WHERE up.user_id = r_staff_pend) = before
    AND NOT EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = r_staff_pend));

  PERFORM _oauth_google_signup(r_fresh, 'oauth-r-fresh@test.invalid');
  r := public.oauth_session_reconcile(r_fresh);
  PERFORM _oauth_ok('a new Google account without a company: nothing, and its pending_invite profile is no invitation',
    r->>'action' = 'none' AND r->>'reason' = 'nothing_pending'
    AND (SELECT status = 'pending_invite' AND company_id IS NULL FROM user_profiles WHERE user_id = r_fresh)
    AND EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = r_fresh));

  PERFORM _oauth_google_signup(r_unconf, 'oauth-r-unconf@test.invalid', false);
  r := public.oauth_session_reconcile(r_unconf);
  PERFORM _oauth_ok('an unconfirmed account: nothing', r->>'action' = 'none' AND r->>'reason' = 'not_google_account');

  PERFORM _oauth_google_signup(r_banned, 'oauth-r-banned@test.invalid');
  UPDATE auth.users SET banned_until = now() + interval '1 hour' WHERE id = r_banned;
  r := public.oauth_session_reconcile(r_banned);
  PERFORM _oauth_ok('a banned account: nothing', r->>'action' = 'none' AND r->>'reason' = 'account_blocked');

  r := public.oauth_session_reconcile(gen_random_uuid());
  PERFORM _oauth_ok('an unknown account: nothing', r->>'action' = 'none' AND r->>'reason' = 'account_not_found');
  PERFORM _oauth_ok('no user id raises 22023',
    _oauth_sqlstate('SELECT public.oauth_session_reconcile(NULL)') = '22023');
END $$;

-- ─── 6. oauth_signup_discard ────────────────────────────────────────────────

DO $$
DECLARE
  d_fresh   uuid := '9a000006-0000-4000-8000-000000000001';
  d_company uuid := '9a000006-0000-4000-8000-000000000002';
  d_staff   uuid := '9a000006-0000-4000-8000-000000000003';
  d_invite  uuid := '9a000006-0000-4000-8000-000000000004';
  d_pw      uuid := '9a000006-0000-4000-8000-000000000005';
  company_a uuid := 'c0000000-0000-4000-8000-00000000000a';
  co        uuid;
  co_pw     uuid;
  v_ok      boolean;
BEGIN
  /*
    Each discard is called in its own statement and checked in the next: rows a
    function deletes are still visible to the rest of the statement that called
    it (see otp.sql, section 8c).
  */
  PERFORM _oauth_google_signup(d_fresh, 'oauth-d-fresh@test.invalid');
  v_ok := public.oauth_signup_discard(d_fresh);
  PERFORM _oauth_ok('a Google signup that never registered is discarded', v_ok);
  PERFORM _oauth_ok('its account, identity, profile and mark are all gone',
    NOT EXISTS (SELECT 1 FROM auth.users WHERE id = d_fresh)
    AND NOT EXISTS (SELECT 1 FROM auth.identities WHERE user_id = d_fresh)
    AND NOT EXISTS (SELECT 1 FROM user_profiles WHERE user_id = d_fresh)
    AND NOT EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = d_fresh));

  PERFORM _oauth_google_signup(d_company, 'oauth-d-company@test.invalid');
  co := (public.oauth_signup_create_company(d_company, 'Dora', 'Dora GmbH', NULL, NULL, NULL, NULL)->'company'->>'id')::uuid;
  v_ok := public.oauth_signup_discard(d_company);
  PERFORM _oauth_ok('a Google account that registered its company is refused',
    NOT v_ok AND EXISTS (SELECT 1 FROM auth.users WHERE id = d_company) AND EXISTS (SELECT 1 FROM companies WHERE id = co));
  INSERT INTO app_private.pending_oauth_signups (user_id, email) VALUES (d_company, 'oauth-d-company@test.invalid');
  v_ok := public.oauth_signup_discard(d_company);
  PERFORM _oauth_ok('... even with a leftover mark, because it belongs to a company',
    NOT v_ok AND EXISTS (SELECT 1 FROM auth.users WHERE id = d_company)
    AND (SELECT company_id FROM user_profiles WHERE user_id = d_company) = co);

  PERFORM _oauth_google_signup(d_staff, 'oauth-d-staff@test.invalid');
  UPDATE user_profiles SET is_super_admin = true WHERE user_id = d_staff;
  v_ok := public.oauth_signup_discard(d_staff);
  PERFORM _oauth_ok('platform staff are refused, marked or not',
    NOT v_ok AND EXISTS (SELECT 1 FROM auth.users WHERE id = d_staff) AND EXISTS (SELECT 1 FROM user_profiles WHERE user_id = d_staff));

  PERFORM _oauth_invited_employee(d_invite, 'oauth-d-invite@test.invalid', company_a);
  PERFORM _oauth_link_google(d_invite);
  v_ok := public.oauth_signup_discard(d_invite);
  PERFORM _oauth_ok('an invited employee is refused',
    NOT v_ok AND EXISTS (SELECT 1 FROM auth.users WHERE id = d_invite) AND EXISTS (SELECT 1 FROM user_profiles WHERE user_id = d_invite));

  PERFORM _oauth_password_signup_account(d_pw, 'oauth-d-pw@test.invalid');
  co_pw := (public.signup_create_company(d_pw, 'oauth-d-pw@test.invalid', 'Pit', 'Pit GmbH',
                                         NULL, NULL, NULL, NULL, NULL)->'company'->>'id')::uuid;
  v_ok := public.oauth_signup_discard(d_pw);
  PERFORM _oauth_ok('a pending password signup is refused (it belongs to signup_discard)',
    NOT v_ok AND EXISTS (SELECT 1 FROM auth.users WHERE id = d_pw) AND EXISTS (SELECT 1 FROM companies WHERE id = co_pw));

  PERFORM _oauth_ok('an unknown account returns false', NOT public.oauth_signup_discard(gen_random_uuid()));
  PERFORM _oauth_ok('no user id raises 22023', _oauth_sqlstate('SELECT public.oauth_signup_discard(NULL)') = '22023');
  PERFORM _oauth_ok('the seeded tenants and their admin are untouched',
    EXISTS (SELECT 1 FROM companies WHERE id = 'c0000000-0000-4000-8000-00000000000a')
    AND EXISTS (SELECT 1 FROM companies WHERE id = 'c0000000-0000-4000-8000-00000000000b')
    AND EXISTS (SELECT 1 FROM auth.users WHERE id = 'a0000000-0000-4000-8000-000000000001'));
END $$;

-- ─── 7. purge_abandoned_oauth_signups ───────────────────────────────────────

DO $$
DECLARE
  p_old     uuid := '9a000007-0000-4000-8000-000000000001';
  p_edge    uuid := '9a000007-0000-4000-8000-000000000002';
  p_young   uuid := '9a000007-0000-4000-8000-000000000003';
  p_done    uuid := '9a000007-0000-4000-8000-000000000004';
  p_inv     uuid := '9a000007-0000-4000-8000-000000000005';
  p_staff   uuid := '9a000007-0000-4000-8000-000000000006';
  p_pw      uuid := '9a000007-0000-4000-8000-000000000007';
  company_a uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_done   uuid;
  co_pw     uuid;
  n         integer;
BEGIN
  PERFORM _oauth_google_signup(p_old,   'oauth-p-old@test.invalid');
  PERFORM _oauth_google_signup(p_edge,  'oauth-p-edge@test.invalid');
  PERFORM _oauth_google_signup(p_young, 'oauth-p-young@test.invalid');
  UPDATE app_private.pending_oauth_signups SET created_at = now() - interval '24 hours 1 second'  WHERE user_id = p_old;
  UPDATE app_private.pending_oauth_signups SET created_at = now() - interval '24 hours'           WHERE user_id = p_edge;
  UPDATE app_private.pending_oauth_signups SET created_at = now() - interval '23 hours 59 minutes' WHERE user_id = p_young;

  -- Accounts that must survive even with a stale mark.
  PERFORM _oauth_google_signup(p_done, 'oauth-p-done@test.invalid');
  co_done := (public.oauth_signup_create_company(p_done, 'Doris', 'Doris GmbH', NULL, NULL, NULL, NULL)->'company'->>'id')::uuid;
  INSERT INTO app_private.pending_oauth_signups (user_id, email, created_at)
  VALUES (p_done, 'oauth-p-done@test.invalid', now() - interval '30 days');

  PERFORM _oauth_invited_employee(p_inv, 'oauth-p-inv@test.invalid', company_a);
  INSERT INTO app_private.pending_oauth_signups (user_id, email, created_at)
  VALUES (p_inv, 'oauth-p-inv@test.invalid', now() - interval '30 days');

  PERFORM _oauth_google_signup(p_staff, 'oauth-p-staff@test.invalid');
  UPDATE user_profiles SET is_super_admin = true WHERE user_id = p_staff;
  UPDATE app_private.pending_oauth_signups SET created_at = now() - interval '30 days' WHERE user_id = p_staff;

  -- A stale password signup belongs to purge_unverified_signups, not here.
  PERFORM _oauth_password_signup_account(p_pw, 'oauth-p-pw@test.invalid');
  co_pw := (public.signup_create_company(p_pw, 'oauth-p-pw@test.invalid', 'Pat', 'Pat GmbH',
                                         NULL, NULL, NULL, NULL, NULL)->'company'->>'id')::uuid;
  UPDATE app_private.pending_signups SET created_at = now() - interval '25 hours' WHERE user_id = p_pw;

  PERFORM _oauth_ok('a window under an hour raises 22023',
    _oauth_sqlstate('SELECT public.purge_abandoned_oauth_signups(interval ''59 minutes'')') = '22023');
  PERFORM _oauth_ok('a NULL window raises 22023',
    _oauth_sqlstate('SELECT public.purge_abandoned_oauth_signups(NULL)') = '22023');

  n := public.purge_abandoned_oauth_signups();
  PERFORM _oauth_ok('the 24-hour purge removes exactly the one signup older than 24 hours', n = 1);
  PERFORM _oauth_ok('it is gone, account, identity, profile and mark',
    NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_old)
    AND NOT EXISTS (SELECT 1 FROM auth.identities WHERE user_id = p_old)
    AND NOT EXISTS (SELECT 1 FROM user_profiles WHERE user_id = p_old)
    AND NOT EXISTS (SELECT 1 FROM app_private.pending_oauth_signups WHERE user_id = p_old));
  PERFORM _oauth_ok('a signup exactly 24 hours old is kept, and one 23:59 old',
    EXISTS (SELECT 1 FROM auth.users WHERE id = p_edge) AND EXISTS (SELECT 1 FROM auth.users WHERE id = p_young));
  PERFORM _oauth_ok('a completed account with a stale mark is kept, with its company',
    EXISTS (SELECT 1 FROM auth.users WHERE id = p_done) AND EXISTS (SELECT 1 FROM companies WHERE id = co_done)
    AND (SELECT company_id FROM user_profiles WHERE user_id = p_done) = co_done);
  PERFORM _oauth_ok('an invited employee with a stale mark is kept',
    EXISTS (SELECT 1 FROM auth.users WHERE id = p_inv)
    AND (SELECT company_id FROM user_profiles WHERE user_id = p_inv) = company_a);
  PERFORM _oauth_ok('platform staff with a stale mark are kept',
    EXISTS (SELECT 1 FROM auth.users WHERE id = p_staff) AND EXISTS (SELECT 1 FROM user_profiles WHERE user_id = p_staff));
  PERFORM _oauth_ok('a stale password signup is left to purge_unverified_signups',
    EXISTS (SELECT 1 FROM auth.users WHERE id = p_pw) AND EXISTS (SELECT 1 FROM companies WHERE id = co_pw)
    AND EXISTS (SELECT 1 FROM app_private.pending_signups WHERE user_id = p_pw));

  n := public.purge_abandoned_oauth_signups(interval '1 hour');
  PERFORM _oauth_ok('a one-hour window then takes the two that were younger than a day, and nothing else', n = 2);
  PERFORM _oauth_ok('those two are gone; the completed account, the employee and the staff member remain',
    NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_edge)
    AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_young)
    AND EXISTS (SELECT 1 FROM auth.users WHERE id = p_done)
    AND EXISTS (SELECT 1 FROM auth.users WHERE id = p_inv)
    AND EXISTS (SELECT 1 FROM auth.users WHERE id = p_staff));
  PERFORM _oauth_ok('the seeded tenants are untouched',
    EXISTS (SELECT 1 FROM companies WHERE id = 'c0000000-0000-4000-8000-00000000000a')
    AND EXISTS (SELECT 1 FROM companies WHERE id = 'c0000000-0000-4000-8000-00000000000b'));

  RAISE NOTICE '── all Google sign-in database assertions passed ──';
END $$;

-- Everything above was test data; the next test file starts from the seeds.
ROLLBACK;
