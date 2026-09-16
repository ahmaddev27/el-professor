/*
  Platform authority (plan 3.1): do the staff roles, the capability matrix and
  the audit log hold, and does the old profile flag really grant nothing?

  Runs after assertions.sql and the matrix, against the same throwaway
  database, as supabase_admin. Every check raises on failure; a silent run is a
  pass. The whole file is one transaction rolled back at the end, so the files
  after it see the database as the seeds left it.

  What is covered, in order:

    1. privileges     app_private stays unreachable; each helper has exactly
                      its stated EXECUTE grants
    2. matrix         every role x every capability through platform_can(),
                      platform_staff_role(), platform_whoami() and
                      is_user_super_admin(), for each role, a disabled staff
                      row, the flag alone, a company admin and anon
    3. flag alone     a profile flagged as a platform account without a staff
                      row reads no platform table, runs no platform RPC, gets
                      no platform_login code
    4. policies       the fifteen rewritten policies answer by capability; the
                      read_only hole of the older policies, recorded for 3.3
   4b. accounts       platform_can_manage_account: an account with a staff row
                      (a disabled one included) needs staff.manage, any other
                      company_users.manage; support is refused on owners.
                      account_is_platform_staff, for a company admin's target,
                      service role only
    5. sync           the flag follows every staff change, and a profile
                      created after its staff row starts in step
    6. guard          no JWT changes company_id or user_id; a JWT without a
                      subject writes no profile, also past RLS; a JWT sets the
                      flag only to what platform_staff says; capability-based
                      exceptions; a company admin's exceptions skip staff
                      profiles; the service role and migrations stay unguarded
    7. last owner     cannot be removed, disabled, demoted or deleted with its
                      account; any other owner can
    8. audit log      append-only (UPDATE, DELETE, TRUNCATE refused); actor,
                      role and session come from the JWT; platform_audit_record
                      writes for staff only, only read and write rows, and no
                      action in a namespace the database writes; since
                      20260916130000 only the actions the edge functions send
                      (app_private.platform_edge_audit_actions()), and a role
                      without an action's capability records only its refusal;
                      attempt rows; staff changes are audited
    9. signup         a staff account is never signed up or discarded; every
                      signup path asks oauth_account_is_platform_staff
   10. backfill       every flagged profile that existed before this file ran
                      is an owner

  About 10: the migration ran on the schema-only fixture, whose user_profiles
  is empty, so the backfill itself added nobody here. What this file can check
  is the invariant it establishes, before any principal below is created. The
  backfill and the legacy copy were exercised with real rows in a kit run that
  inserted them before applying 20260916110000 (see the pull request).
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in otp.sql) ───────────────────────────────────────────

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

CREATE OR REPLACE FUNCTION _pa_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

/** Back to the connecting superuser with no JWT claims at all. */
CREATE OR REPLACE FUNCTION _pa_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

/**
  Become a principal: a user id (authenticated), NULL (anon), or the literal
  service role when p_service is true. The singular claim is the form auth.uid()
  reads first; see _as() in assertions.sql.
*/
CREATE OR REPLACE FUNCTION _pa_become(p_user uuid, p_service boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pa_reset();
  IF p_service THEN
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
  ELSIF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
  ELSE
    PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
END $$;

/**
  Runs p_sql as the principal inside a subtransaction that is always rolled
  back, and returns what happened: the scalar the statement returned (or
  `rows N` for a statement without a result), or `ERR <sqlstate> <message>`.
*/
CREATE OR REPLACE FUNCTION _pa_try(p_user uuid, p_sql text, p_service boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _pa_become(p_user, p_service);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ003', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ003' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _pa_reset();
  RETURN v_out;
END $$;

/** Like _pa_try, but keeps the statement's effect. */
CREATE OR REPLACE FUNCTION _pa_do(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _pa_become(p_user);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _pa_reset();
  RETURN v_out;
END $$;

/** The SQLSTATE p_sql raised as the superuser (rolled back), or NULL if it ran. */
CREATE OR REPLACE FUNCTION _pa_raises(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION USING ERRCODE = 'ZZ004';
  EXCEPTION
    WHEN SQLSTATE 'ZZ004' THEN RETURN NULL;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      RETURN v_state;
  END;
END $$;

-- ─── 10. backfill invariant, before anything below adds a principal ─────────

DO $$
BEGIN
  PERFORM _pa_reset();
  PERFORM _pa_ok('backfill: every flagged profile with an account holds an active owner or staff row',
    NOT EXISTS (SELECT 1
                  FROM user_profiles up
                  JOIN auth.users u ON u.id = up.user_id
                 WHERE up.is_super_admin
                   AND app_private.platform_staff_role_of(up.user_id) IS NULL));
  PERFORM _pa_ok('backfill: the seeded platform principal is an owner',
    app_private.platform_staff_role_of('50000000-0000-4000-8000-000000000001') = 'owner');
  PERFORM _pa_ok('legacy copy: one legacy audit row per subscription_payment_audit row',
    (SELECT count(*) FROM app_private.platform_audit_log WHERE action = 'legacy.subscription_payment_audit')
      = (SELECT count(*) FROM subscription_payment_audit));
  PERFORM _pa_ok('legacy copy: one legacy audit row per subscription_admin_actions row',
    (SELECT count(*) FROM app_private.platform_audit_log WHERE action = 'legacy.subscription_admin_actions')
      = (SELECT count(*) FROM subscription_admin_actions));
END $$;

-- ─── principals ─────────────────────────────────────────────────────────────

/*
    3a..01 pa-owner       owner
    3a..02 pa-owner-two   owner
    3a..03 pa-support     support
    3a..04 pa-billing     billing
    3a..05 pa-readonly    read_only
    3a..06 pa-disabled    support, disabled
    3a..07 pa-flag        profile flagged, no staff row: the flag alone
    3a..08 pa-member      editor in company A, the guard's target
    3a..09 pa-late        staff row first, profile afterwards
    3a..0a pa-self        staff row, then inserts its own profile with its JWT
    3a..0b pa-signup      unconfirmed, fresh, disabled staff row, no profile
    3a..0c pa-plain       unconfirmed, fresh, no staff row, no profile (control)
    3a..0d pa-staff-in-a  support, whose profile still sits in company A
*/
INSERT INTO auth.users (id, email, email_confirmed_at, created_at) VALUES
  ('3a000000-0000-4000-8000-000000000001', 'pa-owner@test.invalid',     now(), now() - interval '90 days'),
  ('3a000000-0000-4000-8000-000000000002', 'pa-owner-two@test.invalid', now(), now() - interval '90 days'),
  ('3a000000-0000-4000-8000-000000000003', 'pa-support@test.invalid',   now(), now() - interval '90 days'),
  ('3a000000-0000-4000-8000-000000000004', 'pa-billing@test.invalid',   now(), now() - interval '90 days'),
  ('3a000000-0000-4000-8000-000000000005', 'pa-readonly@test.invalid',  now(), now() - interval '90 days'),
  ('3a000000-0000-4000-8000-000000000006', 'pa-disabled@test.invalid',  now(), now() - interval '90 days'),
  ('3a000000-0000-4000-8000-000000000007', 'pa-flag@test.invalid',      now(), now() - interval '90 days'),
  ('3a000000-0000-4000-8000-000000000008', 'pa-member@test.invalid',    now(), now() - interval '90 days'),
  ('3a000000-0000-4000-8000-000000000009', 'pa-late@test.invalid',      now(), now() - interval '90 days'),
  ('3a000000-0000-4000-8000-00000000000a', 'pa-self@test.invalid',      now(), now() - interval '90 days'),
  ('3a000000-0000-4000-8000-00000000000b', 'pa-signup@test.invalid',    NULL,  now() - interval '5 minutes'),
  ('3a000000-0000-4000-8000-00000000000c', 'pa-plain@test.invalid',     NULL,  now() - interval '5 minutes'),
  ('3a000000-0000-4000-8000-00000000000d', 'pa-staff-in-a@test.invalid', now(), now() - interval '90 days');

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, is_super_admin, status) VALUES
  ('3a000000-0000-4000-8000-000000000001', 'pa-owner@test.invalid',     'PA Owner',     'admin',  NULL, NULL, false, 'active'),
  ('3a000000-0000-4000-8000-000000000002', 'pa-owner-two@test.invalid', 'PA Owner Two', 'admin',  NULL, NULL, false, 'active'),
  ('3a000000-0000-4000-8000-000000000003', 'pa-support@test.invalid',   'PA Support',   'admin',  NULL, NULL, false, 'active'),
  ('3a000000-0000-4000-8000-000000000004', 'pa-billing@test.invalid',   'PA Billing',   'admin',  NULL, NULL, false, 'active'),
  ('3a000000-0000-4000-8000-000000000005', 'pa-readonly@test.invalid',  'PA Read',      'admin',  NULL, NULL, false, 'active'),
  ('3a000000-0000-4000-8000-000000000006', 'pa-disabled@test.invalid',  'PA Disabled',  'admin',  NULL, NULL, false, 'active'),
  -- written without a JWT, the way a migration or the service role could
  ('3a000000-0000-4000-8000-000000000007', 'pa-flag@test.invalid',      'PA Flag',      'admin',  NULL, NULL, true,  'active'),
  ('3a000000-0000-4000-8000-000000000008', 'pa-member@test.invalid',    'PA Member',    'editor',
     (SELECT id FROM roles WHERE name = 'editor' AND company_id IS NULL LIMIT 1),
     'c0000000-0000-4000-8000-00000000000a', false, 'active'),
  -- a platform account whose profile still sits in company A (3.7b detaches such profiles)
  ('3a000000-0000-4000-8000-00000000000d', 'pa-staff-in-a@test.invalid', 'PA Staff in A', 'editor',
     (SELECT id FROM roles WHERE name = 'editor' AND company_id IS NULL LIMIT 1),
     'c0000000-0000-4000-8000-00000000000a', false, 'active');

INSERT INTO app_private.platform_staff (user_id, role, disabled_at, note) VALUES
  ('3a000000-0000-4000-8000-000000000001', 'owner',     NULL,  'pa'),
  ('3a000000-0000-4000-8000-000000000002', 'owner',     NULL,  'pa'),
  ('3a000000-0000-4000-8000-000000000003', 'support',   NULL,  'pa'),
  ('3a000000-0000-4000-8000-000000000004', 'billing',   NULL,  'pa'),
  ('3a000000-0000-4000-8000-000000000005', 'read_only', NULL,  'pa'),
  ('3a000000-0000-4000-8000-000000000006', 'support',   now(), 'pa'),
  ('3a000000-0000-4000-8000-00000000000d', 'support',   NULL,  'pa');

-- ─── 1. privileges ──────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role text;
  v_list text;
  r      record;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM _pa_ok(format('%s has no USAGE on schema app_private', v_role),
                   NOT has_schema_privilege(v_role, 'app_private', 'USAGE'));
    SELECT string_agg(c.relname, ', ') INTO v_list
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app_private'
       AND c.relname IN ('platform_staff', 'platform_audit_log')
       AND has_table_privilege(v_role, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');
    PERFORM _pa_ok(format('%s holds no privilege on platform_staff or platform_audit_log%s',
                          v_role, coalesce(' — but has: ' || v_list, '')), v_list IS NULL);
  END LOOP;

  FOR r IN
    SELECT * FROM (VALUES
      -- signature                                                                                 anon   authn  service
      ('public.platform_staff_role()',                                                             false, true,  false),
      ('public.platform_can(text)',                                                                false, true,  false),
      ('public.platform_whoami()',                                                                 false, true,  false),
      ('public.platform_audit_record(text,text,text,uuid,text,text,jsonb,jsonb)',                   false, true,  false),
      ('public.platform_can_manage_account(uuid)',                                                 false, true,  false),
      ('app_private.oauth_account_is_platform_staff(uuid)',                                        false, false, false),
      ('public.account_is_platform_staff(uuid)',                                                   false, false, true),
      ('public.is_user_super_admin()',                                                             true,  true,  true),
      ('public.delete_activation_code(uuid)',                                                      false, true,  true),
      ('public.hide_activation_code(uuid,text)',                                                   false, true,  true),
      ('public.revoke_activation_code(uuid)',                                                      false, true,  true),
      ('public.update_company_subscription_manual(uuid,text,timestamptz,timestamptz,text,text)',   false, true,  true),
      ('public.enforce_user_profile_privilege_guard()',                                            false, false, false),
      ('app_private.audit_write(text,text,text,uuid,text,text,jsonb,jsonb,uuid,uuid,timestamptz)', false, false, false),
      ('app_private.platform_staff_role_of(uuid)',                                                 false, false, false),
      ('app_private.platform_capability_matrix()',                                                 false, false, false)
    ) AS t(sig, anon, authn, service)
  LOOP
    PERFORM _pa_ok(format('EXECUTE on %s: anon %s, authenticated %s, service_role %s', r.sig, r.anon, r.authn, r.service),
      has_function_privilege('anon',          r.sig::regprocedure, 'EXECUTE') = r.anon
      AND has_function_privilege('authenticated', r.sig::regprocedure, 'EXECUTE') = r.authn
      AND has_function_privilege('service_role',  r.sig::regprocedure, 'EXECUTE') = r.service);
  END LOOP;

  PERFORM _pa_ok('authenticated is refused calling app_private.audit_write',
    _pa_try('3a000000-0000-4000-8000-000000000001',
            $q$SELECT app_private.audit_write('write', 'pa.probe')::text$q$) LIKE 'ERR 42501%');
  PERFORM _pa_ok('authenticated is refused reading app_private.platform_staff',
    _pa_try('3a000000-0000-4000-8000-000000000001',
            'SELECT count(*)::text FROM app_private.platform_staff') LIKE 'ERR 42501%');
  PERFORM _pa_ok('anon is refused calling platform_whoami',
    _pa_try(NULL, 'SELECT platform_whoami()::text') LIKE 'ERR 42501%');
  PERFORM _pa_ok('service_role is refused calling platform_audit_record',
    _pa_try(NULL, $q$SELECT platform_audit_record('write', 'pa.probe', 'ok')::text$q$, true) LIKE 'ERR 42501%');

  -- The app_private helpers grant EXECUTE to nobody, so a SECURITY DEFINER
  -- function reaching them works only for the schema's owner or a superuser.
  PERFORM _pa_ok('every SECURITY DEFINER function that references app_private belongs to its owner or a superuser',
    NOT EXISTS (SELECT 1
                  FROM pg_proc p
                  JOIN pg_namespace n ON n.oid = p.pronamespace
                  JOIN pg_roles owner_role ON owner_role.oid = p.proowner
                 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
                   AND p.prosecdef
                   AND p.prosrc ~ 'app_private\.'
                   AND NOT owner_role.rolsuper
                   AND owner_role.oid <> (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private')));
END $$;

-- ─── 2. the matrix, through the helpers, as each principal ──────────────────

DO $$
DECLARE
  -- Plan 3.A, restated here independently of app_private.platform_capability_matrix().
  -- support has no companies.lifecycle (D2) and read_only no audit.read (D3).
  c record;
  p record;
  v_want boolean;
  v_got  text;
BEGIN
  CREATE TEMP TABLE _pa_matrix (capability text, owner boolean, support boolean, billing boolean, read_only boolean) ON COMMIT DROP;
  INSERT INTO _pa_matrix VALUES
    ('companies.read',        true,  true,  true,  true),
    ('business.read',         true,  true,  false, true),
    ('support.session',       true,  true,  false, false),
    ('company_users.manage',  true,  true,  false, false),
    ('companies.lifecycle',   true,  false, false, false),
    ('companies.hard_delete', true,  false, false, false),
    ('billing.manage',        true,  false, true,  false),
    ('pricing.manage',        true,  false, true,  false),
    ('codes.manage',          true,  false, true,  false),
    ('settings.read',         true,  false, true,  true),
    ('settings.manage',       true,  false, false, false),
    ('metrics.read',          true,  false, true,  true),
    ('audit.read',            true,  false, false, false),
    ('staff.manage',          true,  false, false, false);

  PERFORM _pa_ok('the restated matrix and app_private.platform_capability_matrix() hold the same pairs',
    NOT EXISTS (
      (SELECT r.role, m.capability FROM _pa_matrix m,
              LATERAL (VALUES ('owner', m.owner), ('support', m.support), ('billing', m.billing), ('read_only', m.read_only)) AS r(role, allowed)
        WHERE r.allowed
       EXCEPT SELECT role, capability FROM app_private.platform_capability_matrix())
      UNION ALL
      (SELECT role, capability FROM app_private.platform_capability_matrix()
       EXCEPT SELECT r.role, m.capability FROM _pa_matrix m,
              LATERAL (VALUES ('owner', m.owner), ('support', m.support), ('billing', m.billing), ('read_only', m.read_only)) AS r(role, allowed)
        WHERE r.allowed)));

  FOR p IN
    SELECT * FROM (VALUES
      ('owner',         '3a000000-0000-4000-8000-000000000001'::uuid, 'owner'),
      ('support',       '3a000000-0000-4000-8000-000000000003'::uuid, 'support'),
      ('billing',       '3a000000-0000-4000-8000-000000000004'::uuid, 'billing'),
      ('read_only',     '3a000000-0000-4000-8000-000000000005'::uuid, 'read_only'),
      ('disabled',      '3a000000-0000-4000-8000-000000000006'::uuid, NULL),
      ('flag alone',    '3a000000-0000-4000-8000-000000000007'::uuid, NULL),
      ('company admin', 'a0000000-0000-4000-8000-000000000001'::uuid, NULL)
    ) AS t(label, uid, role)
  LOOP
    FOR c IN SELECT * FROM _pa_matrix ORDER BY capability LOOP
      v_want := CASE p.role WHEN 'owner' THEN c.owner WHEN 'support' THEN c.support
                            WHEN 'billing' THEN c.billing WHEN 'read_only' THEN c.read_only
                            ELSE false END;
      v_got := _pa_try(p.uid, format('SELECT platform_can(%L)::text', c.capability));
      IF v_got IS DISTINCT FROM v_want::text THEN
        RAISE EXCEPTION 'FAIL: platform_can(%) for % — expected %, got %', c.capability, p.label, v_want, v_got;
      END IF;
    END LOOP;
    RAISE NOTICE 'ok  platform_can: all 14 capabilities as expected for %', p.label;

    PERFORM _pa_ok(format('platform_staff_role() for %s is %s', p.label, coalesce(p.role, 'NULL')),
      _pa_try(p.uid, 'SELECT platform_staff_role()') = coalesce(p.role, '<null>'));
    PERFORM _pa_ok(format('is_user_super_admin() for %s is %s', p.label, p.role IS NOT NULL),
      _pa_try(p.uid, 'SELECT is_user_super_admin()::text') = (p.role IS NOT NULL)::text);
    PERFORM _pa_ok(format('platform_whoami() for %s names role %s and exactly its capabilities, no company context',
                          p.label, coalesce(p.role, 'null')),
      _pa_try(p.uid, 'SELECT platform_whoami()::text')::jsonb
        = jsonb_build_object(
            'role', p.role,
            'capabilities', coalesce((SELECT jsonb_agg(m.capability ORDER BY m.capability)
                                        FROM _pa_matrix m
                                       WHERE CASE p.role WHEN 'owner' THEN m.owner WHEN 'support' THEN m.support
                                                         WHEN 'billing' THEN m.billing WHEN 'read_only' THEN m.read_only
                                                         ELSE false END), '[]'::jsonb),
            'company_context', NULL::jsonb));
  END LOOP;

  PERFORM _pa_ok('anon: may not execute platform_can or platform_staff_role, and is_user_super_admin is false',
    _pa_try(NULL, $q$SELECT platform_can('companies.read')::text$q$) LIKE 'ERR 42501%'
    AND _pa_try(NULL, 'SELECT platform_staff_role()') LIKE 'ERR 42501%'
    AND _pa_try(NULL, 'SELECT is_user_super_admin()::text') = 'false');
  PERFORM _pa_ok('an unknown capability is refused, even for an owner',
    _pa_try('3a000000-0000-4000-8000-000000000001', $q$SELECT platform_can('everything')::text$q$) = 'false'
    AND _pa_try('3a000000-0000-4000-8000-000000000001', 'SELECT platform_can(NULL)::text') = 'false');
END $$;

-- ─── 3. the flag alone ──────────────────────────────────────────────────────

-- created_by is the seeded owner: activation_codes.created_by is ON DELETE
-- RESTRICT, and section 7 deletes pa-owner's account.
INSERT INTO activation_codes (id, code_hash, duration_type, expires_at, created_by, company_id)
VALUES ('3ac00000-0000-4000-8000-000000000001', encode(sha256('pa-code'::bytea), 'hex'), '1_monat',
        now() + interval '1 day', '50000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a');

INSERT INTO auth.sessions (id, user_id, not_after) VALUES
  ('5a000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000001', NULL),
  ('5a000000-0000-4000-8000-000000000007', '3a000000-0000-4000-8000-000000000007', NULL),
  ('5a000000-0000-4000-8000-000000000006', '3a000000-0000-4000-8000-000000000006', NULL);

DO $$
DECLARE
  flag  constant uuid := '3a000000-0000-4000-8000-000000000007';
  owner constant uuid := '3a000000-0000-4000-8000-000000000001';
  h     constant text := encode(sha256('pa-otp'::bytea), 'hex');
BEGIN
  PERFORM _pa_ok('flag alone: reads no company', _pa_try(flag, 'SELECT count(*)::text FROM companies') = '0');
  PERFORM _pa_ok('owner (control): reads every company', _pa_try(owner, 'SELECT count(*)::text FROM companies')::int >= 2);
  PERFORM _pa_ok('flag alone: reads no activation code', _pa_try(flag, 'SELECT count(*)::text FROM activation_codes') = '0');
  PERFORM _pa_ok('flag alone: cannot update a company',
    _pa_try(flag, $q$UPDATE companies SET plan = 'premium' WHERE id = 'c0000000-0000-4000-8000-00000000000a'$q$) = 'rows 0');
  PERFORM _pa_ok('flag alone: revoke_activation_code answers Nicht autorisiert',
    (_pa_try(flag, $q$SELECT revoke_activation_code('3ac00000-0000-4000-8000-000000000001')::text$q$)::jsonb ->> 'success') = 'false');
  PERFORM _pa_ok('flag alone: update_company_subscription_manual answers Nicht autorisiert',
    (_pa_try(flag, $q$SELECT update_company_subscription_manual('c0000000-0000-4000-8000-00000000000b', 'active')::text$q$)::jsonb ->> 'success') = 'false');
  PERFORM _pa_ok('flag alone: otp_issue(platform_login) is ineligible',
    (public.otp_issue(gen_random_uuid(), 'platform_login', NULL, flag, NULL,
                      '5a000000-0000-4000-8000-000000000007', h, NULL, NULL) ->> 'status') = 'ineligible');
  PERFORM _pa_ok('disabled staff: otp_issue(platform_login) is ineligible',
    (public.otp_issue(gen_random_uuid(), 'platform_login', NULL, '3a000000-0000-4000-8000-000000000006', NULL,
                      '5a000000-0000-4000-8000-000000000006', h, NULL, NULL) ->> 'status') = 'ineligible');
  PERFORM _pa_ok('owner (control): otp_issue(platform_login) is issued',
    (public.otp_issue(gen_random_uuid(), 'platform_login', NULL, owner, NULL,
                      '5a000000-0000-4000-8000-000000000001', h, NULL, NULL) ->> 'status') = 'issued');
END $$;

-- ─── 4. the fifteen policies and the four RPCs, by capability ───────────────

INSERT INTO referrals (id, ref_code, name) VALUES ('3ae00000-0000-4000-8000-000000000001', 'PA-REF', 'PA');
INSERT INTO discount_codes (id, code, discount_type, discount_value, usage_mode, audience_type, active)
VALUES ('3ad00000-0000-4000-8000-000000000001', 'PA-DISC', 'percentage', 5, 'once', 'multiple', true);
INSERT INTO subscription_admin_actions (id, company_id) VALUES ('3af00000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a');

DO $$
DECLARE
  owner    constant uuid := '3a000000-0000-4000-8000-000000000001';
  support  constant uuid := '3a000000-0000-4000-8000-000000000003';
  billing  constant uuid := '3a000000-0000-4000-8000-000000000004';
  readonly constant uuid := '3a000000-0000-4000-8000-000000000005';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  code     constant text := '3ac00000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _pa_ok('activation_codes: owner and billing read, support and read_only do not',
    _pa_try(owner,    'SELECT count(*)::text FROM activation_codes') <> '0'
    AND _pa_try(billing,  'SELECT count(*)::text FROM activation_codes') <> '0'
    AND _pa_try(support,  'SELECT count(*)::text FROM activation_codes') = '0'
    AND _pa_try(readonly, 'SELECT count(*)::text FROM activation_codes') = '0');
  PERFORM _pa_ok('referrals: billing inserts, support is refused by RLS',
    _pa_try(billing, $q$INSERT INTO referrals (ref_code, name) VALUES ('PA-REF-B', 'b')$q$) = 'rows 1'
    AND _pa_try(support, $q$INSERT INTO referrals (ref_code, name) VALUES ('PA-REF-S', 's')$q$) LIKE 'ERR 42501%row-level security%');
  PERFORM _pa_ok('discount_codes: billing deletes, read_only matches no row',
    _pa_try(billing,  $q$DELETE FROM discount_codes WHERE id = '3ad00000-0000-4000-8000-000000000001'$q$) = 'rows 1'
    AND _pa_try(readonly, $q$DELETE FROM discount_codes WHERE id = '3ad00000-0000-4000-8000-000000000001'$q$) = 'rows 0');
  PERFORM _pa_ok('subscription_admin_actions: billing reads, support does not, a company admin does not',
    _pa_try(billing, 'SELECT count(*)::text FROM subscription_admin_actions') <> '0'
    AND _pa_try(support, 'SELECT count(*)::text FROM subscription_admin_actions') = '0'
    AND _pa_try(admin_a, 'SELECT count(*)::text FROM subscription_admin_actions') = '0');
  PERFORM _pa_ok('discount_code_redemptions and activation_code_attempts: support reads nothing through the platform policies',
    _pa_try(support, 'SELECT count(*)::text FROM activation_code_attempts') = '0');

  PERFORM _pa_ok('revoke_activation_code: billing succeeds, support is not authorised',
    (_pa_try(billing, format('SELECT revoke_activation_code(%L)::text', code))::jsonb ->> 'success') = 'true'
    AND (_pa_try(support, format('SELECT revoke_activation_code(%L)::text', code))::jsonb ->> 'error') = 'Nicht autorisiert');
  PERFORM _pa_ok('hide_activation_code: owner succeeds, read_only is not authorised',
    (_pa_try(owner, format('SELECT hide_activation_code(%L, %L)::text', code, 'pa'))::jsonb ->> 'success') = 'true'
    AND (_pa_try(readonly, format('SELECT hide_activation_code(%L, %L)::text', code, 'pa'))::jsonb ->> 'success') = 'false');
  PERFORM _pa_ok('delete_activation_code: billing succeeds, a company admin is not authorised',
    (_pa_try(billing, format('SELECT delete_activation_code(%L)::text', code))::jsonb ->> 'success') = 'true'
    AND (_pa_try(admin_a, format('SELECT delete_activation_code(%L)::text', code))::jsonb ->> 'success') = 'false');
  PERFORM _pa_ok('update_company_subscription_manual: billing succeeds, support is not authorised',
    (_pa_try(billing, $q$SELECT update_company_subscription_manual('c0000000-0000-4000-8000-00000000000b', 'active', now(), now() + interval '30 days', '1_monat', 'pa')::text$q$)::jsonb ->> 'success') = 'true'
    AND (_pa_try(support, $q$SELECT update_company_subscription_manual('c0000000-0000-4000-8000-00000000000b', 'active')::text$q$)::jsonb ->> 'success') = 'false');
  PERFORM _pa_ok('anon may not execute the four platform RPCs',
    _pa_try(NULL, format('SELECT revoke_activation_code(%L)::text', code)) LIKE 'ERR 42501%'
    AND _pa_try(NULL, $q$SELECT update_company_subscription_manual('c0000000-0000-4000-8000-00000000000b', 'active')::text$q$) LIKE 'ERR 42501%');

  -- Until 20260917130000 is_user_super_admin() was true for any active staff
  -- role, so every policy built on it gave read_only the writes of an owner.
  -- The companies policies now ask companies.lifecycle, which read_only does
  -- not hold, so the row it used to update is not visible to its UPDATE at all.
  -- This check was the HOLE[3.3] the plan named; it is turned around here.
  PERFORM _pa_ok('read_only cannot update a company: the policy asks companies.lifecycle, not whether the caller is staff',
    _pa_try(readonly, $q$UPDATE companies SET plan = plan WHERE id = 'c0000000-0000-4000-8000-00000000000a'$q$) = 'rows 0');
  PERFORM _pa_ok('…and an owner, which holds companies.lifecycle, still updates it',
    _pa_try(owner, $q$UPDATE companies SET plan = plan WHERE id = 'c0000000-0000-4000-8000-00000000000a'$q$) = 'rows 1');
END $$;

-- ─── 4b. who may act on an account: platform_can_manage_account ─────────────

-- manage-users asks this before every platform change to an existing account.
-- Without it support, holding company_users.manage, could set an owner's
-- address and password through the service role and sign in as the owner.
DO $$
DECLARE
  owner     constant uuid := '3a000000-0000-4000-8000-000000000001';
  owner_two constant uuid := '3a000000-0000-4000-8000-000000000002';
  support   constant uuid := '3a000000-0000-4000-8000-000000000003';
  billing   constant uuid := '3a000000-0000-4000-8000-000000000004';
  readonly  constant uuid := '3a000000-0000-4000-8000-000000000005';
  disabled  constant uuid := '3a000000-0000-4000-8000-000000000006';
  flag      constant uuid := '3a000000-0000-4000-8000-000000000007';
  member    constant uuid := '3a000000-0000-4000-8000-000000000008';
  admin_a   constant uuid := 'a0000000-0000-4000-8000-000000000001';
  seeded    constant uuid := '50000000-0000-4000-8000-000000000001';
  staff_a   constant uuid := '3a000000-0000-4000-8000-00000000000d';
  q         constant text := 'SELECT platform_can_manage_account(%L)::text';
BEGIN
  -- support: refused on every account with a staff row, allowed on a company user
  PERFORM _pa_ok('manage account: support is refused on an owner',
    _pa_try(support, format(q, owner)) = 'false' AND _pa_try(support, format(q, seeded)) = 'false');
  PERFORM _pa_ok('manage account: support is refused on another staff account, whatever its role',
    _pa_try(support, format(q, billing)) = 'false' AND _pa_try(support, format(q, readonly)) = 'false');
  PERFORM _pa_ok('manage account: support is refused on a disabled staff row too',
    _pa_try(support, format(q, disabled)) = 'false');
  PERFORM _pa_ok('manage account: support is refused on its own staff account',
    _pa_try(support, format(q, support)) = 'false');
  PERFORM _pa_ok('manage account: support is allowed on a normal company user',
    _pa_try(support, format(q, member)) = 'true' AND _pa_try(support, format(q, admin_a)) = 'true');
  PERFORM _pa_ok('manage account: the flag alone does not make an account staff',
    _pa_try(support, format(q, flag)) = 'true');

  -- owner (staff.manage): allowed on every account
  PERFORM _pa_ok('manage account: an owner is allowed on another owner, on staff and on a company user',
    _pa_try(owner, format(q, owner_two)) = 'true'
    AND _pa_try(owner, format(q, support)) = 'true'
    AND _pa_try(owner, format(q, disabled)) = 'true'
    AND _pa_try(owner, format(q, member)) = 'true');

  -- without company_users.manage or staff.manage: nothing
  PERFORM _pa_ok('manage account: billing and read_only are refused even on a company user',
    _pa_try(billing, format(q, member)) = 'false' AND _pa_try(readonly, format(q, member)) = 'false');
  PERFORM _pa_ok('manage account: a disabled support row grants nothing',
    _pa_try(disabled, format(q, member)) = 'false');
  PERFORM _pa_ok('manage account: a company admin and the flag alone get false, not NULL',
    _pa_try(admin_a, format(q, member)) = 'false' AND _pa_try(flag, format(q, member)) = 'false');
  PERFORM _pa_ok('manage account: a missing id is false, even for an owner',
    _pa_try(owner, 'SELECT platform_can_manage_account(NULL)::text') = 'false');
  PERFORM _pa_ok('manage account: anon may not execute it',
    _pa_try(NULL, format(q, member)) LIKE 'ERR 42501%');
  PERFORM _pa_ok('manage account: the service role may not execute it',
    _pa_try(NULL, format(q, member), true) LIKE 'ERR 42501%');
  PERFORM _pa_ok('manage account: support is refused on the staff account in company A too',
    _pa_try(support, format(q, staff_a)) = 'false');

  -- A company admin acts through manage-users with the service role, so its
  -- side is account_is_platform_staff: a same-company account with a staff row
  -- is refused, a normal same-company user is allowed.
  PERFORM _pa_ok('company admin target: a same-company account with a staff row is platform staff (refused)',
    _pa_try(NULL, format('SELECT account_is_platform_staff(%L)::text', staff_a), true) = 'true');
  PERFORM _pa_ok('company admin target: a normal same-company user is not (allowed)',
    _pa_try(NULL, format('SELECT account_is_platform_staff(%L)::text', member), true) = 'false'
    AND _pa_try(NULL, format('SELECT account_is_platform_staff(%L)::text', admin_a), true) = 'false');
  PERFORM _pa_ok('company admin target: a disabled staff row counts, the flag alone and a NULL id do not',
    _pa_try(NULL, format('SELECT account_is_platform_staff(%L)::text', disabled), true) = 'true'
    AND _pa_try(NULL, format('SELECT account_is_platform_staff(%L)::text', flag), true) = 'false'
    AND _pa_try(NULL, 'SELECT account_is_platform_staff(NULL)::text', true) = 'false');
  PERFORM _pa_ok('company admin target: only the service role may ask',
    _pa_try(admin_a, format('SELECT account_is_platform_staff(%L)::text', member)) LIKE 'ERR 42501%'
    AND _pa_try(owner, format('SELECT account_is_platform_staff(%L)::text', member)) LIKE 'ERR 42501%'
    AND _pa_try(NULL, format('SELECT account_is_platform_staff(%L)::text', member)) LIKE 'ERR 42501%');
END $$;

-- ─── 5. the flag follows platform_staff ─────────────────────────────────────

DO $$
DECLARE
  support constant uuid := '3a000000-0000-4000-8000-000000000003';
  late    constant uuid := '3a000000-0000-4000-8000-000000000009';
  self    constant uuid := '3a000000-0000-4000-8000-00000000000a';
  flag_of text := 'SELECT is_super_admin FROM user_profiles WHERE user_id = %L';
  v       boolean;
BEGIN
  PERFORM _pa_reset();
  EXECUTE format(flag_of, '3a000000-0000-4000-8000-000000000001') INTO v;
  PERFORM _pa_ok('sync: inserting an owner row set the flag', v);
  EXECUTE format(flag_of, '3a000000-0000-4000-8000-000000000006') INTO v;
  PERFORM _pa_ok('sync: inserting a disabled row left the flag false', NOT v);

  UPDATE app_private.platform_staff SET disabled_at = now() WHERE user_id = support;
  EXECUTE format(flag_of, support) INTO v;
  PERFORM _pa_ok('sync: disabling a staff row clears the flag', NOT v);
  UPDATE app_private.platform_staff SET disabled_at = NULL WHERE user_id = support;
  EXECUTE format(flag_of, support) INTO v;
  PERFORM _pa_ok('sync: re-enabling it sets the flag again', v);
  UPDATE app_private.platform_staff SET role = 'read_only' WHERE user_id = support;
  EXECUTE format(flag_of, support) INTO v;
  PERFORM _pa_ok('sync: a role change keeps the flag', v);
  UPDATE app_private.platform_staff SET role = 'support' WHERE user_id = support;

  INSERT INTO app_private.platform_staff (user_id, role, note) VALUES (late, 'billing', 'pa');
  INSERT INTO user_profiles (user_id, email, full_name, role, company_id, is_super_admin, status)
  VALUES (late, 'pa-late@test.invalid', 'PA Late', 'admin', NULL, false, 'active');
  EXECUTE format(flag_of, late) INTO v;
  PERFORM _pa_ok('sync: a profile created after its staff row starts flagged', v);

  -- The trigger lives in app_private, which authenticated cannot reach. A
  -- trigger function is not looked up by the caller, so this insert still works.
  INSERT INTO app_private.platform_staff (user_id, role, note) VALUES (self, 'read_only', 'pa');
  PERFORM _pa_ok('sync: a staff account inserting its own profile with its JWT gets through the triggers',
    _pa_do(self, $q$INSERT INTO user_profiles (user_id, email, full_name, role, company_id, status)
                    VALUES ('3a000000-0000-4000-8000-00000000000a', 'pa-self@test.invalid', 'PA Self', 'viewer', NULL, 'active')
                    RETURNING is_super_admin::text$q$) = 'true');

  DELETE FROM app_private.platform_staff WHERE user_id = late;
  EXECUTE format(flag_of, late) INTO v;
  PERFORM _pa_ok('sync: deleting the staff row clears the flag', NOT v);
END $$;

-- ─── 6. the profile guard ───────────────────────────────────────────────────

DO $$
DECLARE
  owner    constant uuid := '3a000000-0000-4000-8000-000000000001';
  support  constant uuid := '3a000000-0000-4000-8000-000000000003';
  billing  constant uuid := '3a000000-0000-4000-8000-000000000004';
  readonly constant uuid := '3a000000-0000-4000-8000-000000000005';
  member   constant uuid := '3a000000-0000-4000-8000-000000000008';
  staff_a  constant uuid := '3a000000-0000-4000-8000-00000000000d';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  co_b     constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  r_viewer uuid := (SELECT id FROM roles WHERE name = 'viewer' AND company_id IS NULL LIMIT 1);
BEGIN
  /*
    One rule governs every probe in this section where a platform account acts
    on somebody else's profile, and it is stated once here rather than line by
    line. Since 20260917140000 (plan 3.4) `platform_reads_company_data()` is a
    constant false, so user_profiles_select reads

        user_id = auth.uid() OR company_id = get_user_company_id()

    and a company-less platform account therefore sees **exactly one row — its
    own**. Not a company member's: it has no company for the second term to
    match. Not another staff account's either: both are company-less, and
    NULL = NULL is NULL, not true. And not with a context open, which names a
    *company* while every staff row's company_id stays NULL.

    An UPDATE whose WHERE reads `user_id` needs that SELECT before any policy or
    trigger is consulted, so each of those probes now matches nothing, whatever
    capability the caller holds. They are written as `rows 0` and grouped, so
    that none of them reads as a refusal it no longer proves.

    Where the properties they used to carry now live:
      * the capability itself — section 2 (role x capability) and section 4b
        (platform_can_manage_account), neither of which depends on visibility;
      * what holding it *does* — tests/rls/matrix.sql, whose staff_support
        principal updates and deletes a profile of the company it has opened
        (user_profiles U and D = 'Y.') and is refused on the other company's;
      * the guard's own refusals — the same file's three staff-support guard
        scenarios, which run these probes from inside a context where the row is
        visible and the guard is the only thing left to answer.
    That division is deliberate: this file is about the capability matrix and
    carries no context machinery, and it should not grow any.

    No product path is affected, which is the reason this is a test change and
    not a regression: manage-users and platform-staff perform every
    user_profiles write with the service role (`supabaseAdmin`), using the
    caller's JWT only for platformCan(), platformCanManageAccount() and the
    audit row. Direct DML on another account's profile with a platform
    account's own JWT is a capability no product path uses.

    The neighbours left alone here each survive for a reason worth keeping in
    view: an owner still sees its **own** profile, a company admin still sees a
    member of its own company, an INSERT needs no visibility at all, and the
    service role is not guarded.
  */
  PERFORM _pa_ok('no context: a platform account reaches no other profile — not a member''s, not another staff account''s',
    _pa_try(owner,    format('UPDATE user_profiles SET company_id = %L WHERE user_id = %L', co_b, member)) = 'rows 0'
    AND _pa_try(owner,    format('UPDATE user_profiles SET is_super_admin = true WHERE user_id = %L', member)) = 'rows 0'
    AND _pa_try(owner,    format('UPDATE user_profiles SET user_id = %L WHERE user_id = %L', gen_random_uuid(), member)) = 'rows 0'
    AND _pa_try(owner,    format('UPDATE user_profiles SET is_super_admin = true WHERE user_id = %L', support)) = 'rows 0');
  PERFORM _pa_ok('no context: …and neither role nor status, whatever capability the role holds',
    _pa_try(owner,    format('UPDATE user_profiles SET role_id = %L WHERE user_id = %L', r_viewer, member)) = 'rows 0'
    AND _pa_try(support,  format('UPDATE user_profiles SET role_id = %L WHERE user_id = %L', r_viewer, member)) = 'rows 0'
    AND _pa_try(billing,  format('UPDATE user_profiles SET role_id = %L WHERE user_id = %L', r_viewer, member)) = 'rows 0'
    AND _pa_try(readonly, format($q$UPDATE user_profiles SET status = 'suspended' WHERE user_id = %L$q$, member)) = 'rows 0'
    AND _pa_try(support,  format($q$UPDATE user_profiles SET status = 'suspended' WHERE user_id = %L$q$, member)) = 'rows 0');
  -- …including a staff profile that still sits inside a company (3.7b detaches
  -- those): company A is not the owner's company either.
  PERFORM _pa_ok('no context: an owner does not reach a staff profile sitting in a company',
    _pa_try(owner, format($q$UPDATE user_profiles SET status = 'deactivated' WHERE user_id = %L$q$, staff_a)) = 'rows 0');
  PERFORM _pa_ok('guard: an owner cannot move its own profile into a company',
    _pa_try(owner, format('UPDATE user_profiles SET company_id = %L WHERE user_id = %L', co_b, owner))
      LIKE 'ERR P0001 Not allowed: cannot change company assignment%');
  PERFORM _pa_ok('guard: a company admin cannot move a member either (unchanged)',
    _pa_try(admin_a, format('UPDATE user_profiles SET company_id = %L WHERE user_id = %L', co_b, member))
      LIKE 'ERR P0001%');
  PERFORM _pa_ok('guard: the service role still moves a profile',
    _pa_try(NULL, format('UPDATE user_profiles SET company_id = %L WHERE user_id = %L', co_b, member), true) = 'rows 1');
  PERFORM _pa_ok('guard: anon inserting a profile into a company is refused',
    _pa_try(NULL, format($q$INSERT INTO user_profiles (user_id, email, role, company_id) VALUES (%L, 'x@test.invalid', 'viewer', %L)$q$,
                         gen_random_uuid(), co_b)) LIKE 'ERR P0001%');
  PERFORM _pa_ok('guard: a JWT inserts its own profile into a foreign company — refused, an owner included',
    _pa_try(owner, format($q$INSERT INTO user_profiles (user_id, email, role, company_id) VALUES (%L, 'pa-owner@test.invalid', 'admin', %L)
                             ON CONFLICT (user_id) DO NOTHING$q$, owner, co_b)) LIKE 'ERR P0001 Not allowed: cannot insert profile for another company%');

  -- the flag: only to what platform_staff says
  PERFORM _pa_ok('guard: a company admin cannot flag itself',
    _pa_try(admin_a, format('UPDATE user_profiles SET is_super_admin = true WHERE user_id = %L', admin_a))
      LIKE 'ERR P0001 Not allowed: cannot modify is_super_admin%');
  PERFORM _pa_ok('guard: an owner cannot clear its own flag while its staff row is active',
    _pa_try(owner, format('UPDATE user_profiles SET is_super_admin = false WHERE user_id = %L', owner))
      LIKE 'ERR P0001 Not allowed: cannot modify is_super_admin%');
  PERFORM _pa_ok('guard: the service role can still write the flag (and it grants nothing, see 3)',
    _pa_try(NULL, format('UPDATE user_profiles SET is_super_admin = true WHERE user_id = %L', member), true) = 'rows 1');
  -- A divergence only the service role or a migration can create; a JWT may
  -- then set the flag back to what platform_staff says, and to nothing else.
  -- Probed on the owner's **own** row, which is the only profile a platform
  -- account can still see: the same probe aimed at another staff account now
  -- matches nothing, and is grouped with the other `rows 0` lines above.
  PERFORM _pa_reset();
  UPDATE user_profiles SET is_super_admin = false WHERE user_id = owner;
  PERFORM _pa_ok('guard: a JWT may set the flag back to what platform_staff says',
    _pa_try(owner, format('UPDATE user_profiles SET is_super_admin = true WHERE user_id = %L', owner)) = 'rows 1');
  PERFORM _pa_reset();
  UPDATE user_profiles SET is_super_admin = true WHERE user_id = owner;

  -- the other rules, by capability. What a platform account may do to a
  -- company's users is grouped above as `rows 0`, for the reason stated there;
  -- a company administrator's own reach is unchanged and stays here.
  PERFORM _pa_ok('guard: a company admin changes its member''s role (unchanged)',
    _pa_try(admin_a, format('UPDATE user_profiles SET role_id = %L WHERE user_id = %L', r_viewer, member)) = 'rows 1');

  -- A platform account whose profile sits in the admin's company is out of the
  -- admin's reach: no role change, no status change that would lock it out.
  PERFORM _pa_ok('guard: a company admin cannot change the role of a same-company staff profile',
    _pa_try(admin_a, format('UPDATE user_profiles SET role_id = %L WHERE user_id = %L', r_viewer, staff_a))
      LIKE 'ERR P0001 Not allowed: cannot change role assignment%');
  PERFORM _pa_ok('guard: a company admin cannot change the status of a same-company staff profile',
    _pa_try(admin_a, format($q$UPDATE user_profiles SET status = 'deactivated' WHERE user_id = %L$q$, staff_a))
      LIKE 'ERR P0001 Not allowed: cannot change account status%');
  -- The owner's half of this moved into the grouped `rows 0` lines above: a
  -- company-less platform account does not see a profile sitting in company A
  -- either. The service role does, and still may.
  PERFORM _pa_ok('guard: the service role still changes a same-company staff profile',
    _pa_try(NULL, format($q$UPDATE user_profiles SET status = 'deactivated' WHERE user_id = %L$q$, staff_a), true) = 'rows 1');

  -- The NULL hole: the company-admin exception compared a NULL company and let
  -- the condition fall through. A company-less admin-role profile without a
  -- staff row (pa-flag) edits only its own row under RLS, and may change neither.
  PERFORM _pa_ok('guard: a company-less admin-role profile cannot change its own role',
    _pa_try('3a000000-0000-4000-8000-000000000007',
            format($q$UPDATE user_profiles SET role_id = %L WHERE user_id = '3a000000-0000-4000-8000-000000000007'$q$, r_viewer))
      LIKE 'ERR P0001 Not allowed: cannot change role assignment%');
  PERFORM _pa_ok('guard: a company-less admin-role profile cannot change its own status',
    _pa_try('3a000000-0000-4000-8000-000000000007',
            $q$UPDATE user_profiles SET status = 'inactive' WHERE user_id = '3a000000-0000-4000-8000-000000000007'$q$)
      LIKE 'ERR P0001 Not allowed: cannot change account status%');

  -- user_id: a profile belongs to one account for good
  PERFORM _pa_ok('guard: a company admin cannot change a member''s user_id',
    _pa_try(admin_a, format('UPDATE user_profiles SET user_id = %L WHERE user_id = %L', gen_random_uuid(), member))
      LIKE 'ERR P0001 Not allowed: cannot change user_id%');
  -- An owner aimed at a member is grouped above as `rows 0`; aimed at its own
  -- row, which it can still see, the guard answers as it always did.
  PERFORM _pa_ok('guard: an owner cannot hand its own profile to another account',
    _pa_try(owner, format('UPDATE user_profiles SET user_id = %L WHERE user_id = %L', gen_random_uuid(), owner))
      LIKE 'ERR P0001 Not allowed: cannot change user_id%');
  PERFORM _pa_ok('guard: the service role still changes a user_id',
    _pa_try(NULL, format('UPDATE user_profiles SET user_id = %L WHERE user_id = %L', gen_random_uuid(), member), true) = 'rows 1');
END $$;

/*
  A JWT without a subject writes no profile, also where RLS does not stand in
  the way. Before 3.1 the guard returned early for any caller whose auth.uid()
  was NULL, so a SECURITY DEFINER function anon could reach (as
  create_user_profile_manual was until 20260915130000) wrote roles unguarded.
  This stand-in is such a function; the transaction rolls it back.
*/
CREATE OR REPLACE FUNCTION public._pa_anon_reachable_role_write(p_user uuid) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.user_profiles SET role = 'admin' WHERE user_id = p_user;
  RETURN 'written';
END $$;
GRANT EXECUTE ON FUNCTION public._pa_anon_reachable_role_write(uuid) TO anon;

DO $$
DECLARE
  member constant uuid := '3a000000-0000-4000-8000-000000000008';
BEGIN
  PERFORM _pa_ok('guard: anon reaching a profile write through a SECURITY DEFINER function is refused',
    _pa_try(NULL, format('SELECT _pa_anon_reachable_role_write(%L)', member))
      LIKE 'ERR P0001 Not allowed: a request without a signed-in user cannot write profiles%');
  PERFORM _pa_ok('guard: the same function as a signed-in company admin meets the ordinary rules',
    _pa_try('a0000000-0000-4000-8000-000000000001', format('SELECT _pa_anon_reachable_role_write(%L)', member)) = 'written');

  -- The same with anon's claims on a connection RLS does not bind.
  PERFORM _pa_reset();
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM _pa_ok('guard: anon claims past RLS cannot change a role',
    _pa_raises(format($q$UPDATE user_profiles SET role = 'admin' WHERE user_id = %L$q$, member)) = 'P0001');
  PERFORM _pa_ok('guard: anon claims past RLS cannot change a status',
    _pa_raises(format($q$UPDATE user_profiles SET status = 'suspended' WHERE user_id = %L$q$, member)) = 'P0001');
  PERFORM _pa_ok('guard: anon claims past RLS cannot insert even a company-less profile',
    _pa_raises(format($q$INSERT INTO user_profiles (user_id, email, role) VALUES (%L, 'pa-anon@test.invalid', 'admin')$q$,
                      gen_random_uuid())) = 'P0001');

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM _pa_ok('guard: the service role''s claims still pass',
    _pa_raises(format($q$UPDATE user_profiles SET role = 'admin' WHERE user_id = %L$q$, member)) IS NULL);
  PERFORM _pa_reset();
  PERFORM _pa_ok('guard: no claims at all (a migration, GoTrue) still pass',
    _pa_raises(format($q$UPDATE user_profiles SET role = 'admin' WHERE user_id = %L$q$, member)) IS NULL);
END $$;

-- ─── 7. the last owner ──────────────────────────────────────────────────────

DO $$
DECLARE
  owner     constant uuid := '3a000000-0000-4000-8000-000000000001';
  owner_two constant uuid := '3a000000-0000-4000-8000-000000000002';
  seeded    constant uuid := '50000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _pa_reset();
  UPDATE app_private.platform_staff SET disabled_at = now() WHERE user_id IN (owner_two, seeded);
  PERFORM _pa_ok('last owner: the others could be disabled while one owner stayed',
    (SELECT count(*) FROM app_private.platform_staff WHERE role = 'owner' AND disabled_at IS NULL) = 1);

  PERFORM _pa_ok('last owner: cannot be demoted',
    _pa_raises(format($q$UPDATE app_private.platform_staff SET role = 'support' WHERE user_id = %L$q$, owner)) = 'P0001');
  PERFORM _pa_ok('last owner: cannot be disabled',
    _pa_raises(format('UPDATE app_private.platform_staff SET disabled_at = now() WHERE user_id = %L', owner)) = 'P0001');
  PERFORM _pa_ok('last owner: cannot be deleted',
    _pa_raises(format('DELETE FROM app_private.platform_staff WHERE user_id = %L', owner)) = 'P0001');
  PERFORM _pa_ok('last owner: deleting the auth account fails instead of removing the owner',
    _pa_raises(format('DELETE FROM auth.users WHERE id = %L', owner)) = 'P0001'
    AND EXISTS (SELECT 1 FROM auth.users WHERE id = owner)
    AND app_private.platform_staff_role_of(owner) = 'owner');
  PERFORM _pa_ok('last owner: a disabled owner row can still be edited',
    _pa_raises(format($q$UPDATE app_private.platform_staff SET note = 'edited' WHERE user_id = %L$q$, owner_two)) IS NULL);

  UPDATE app_private.platform_staff SET disabled_at = NULL WHERE user_id = owner_two;
  DELETE FROM auth.users WHERE id = owner;
  PERFORM _pa_ok('with a second active owner, deleting an owner''s account removes its staff row',
    NOT EXISTS (SELECT 1 FROM app_private.platform_staff WHERE user_id = owner));
  PERFORM _pa_ok('… clears the flag on the profile it leaves behind',
    (SELECT NOT is_super_admin FROM user_profiles WHERE user_id = owner));
  PERFORM _pa_ok('… and is audited',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log
             WHERE action = 'platform_staff.delete' AND target_id = owner::text AND category = 'staff'));
END $$;

-- ─── 8. the audit log ───────────────────────────────────────────────────────

DO $$
DECLARE
  billing  constant uuid := '3a000000-0000-4000-8000-000000000004';
  readonly constant uuid := '3a000000-0000-4000-8000-000000000005';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  flag     constant uuid := '3a000000-0000-4000-8000-000000000007';
  sess     constant uuid := '5a000000-0000-4000-8000-0000000000b1';
  v_id     text;
  v_ro_id  text;
  v_legacy bigint;
  r        app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _pa_reset();
  PERFORM _pa_ok('audit: every staff insert above was recorded',
    (SELECT count(*) FROM app_private.platform_audit_log
      WHERE action = 'platform_staff.insert' AND target_id LIKE '3a000000-%') = 9);

  -- platform_audit_record under a JWT whose claims carry a session, the way
  -- PostgREST sets them
  PERFORM set_config('request.jwt.claim.sub', billing::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', billing, 'role', 'authenticated', 'session_id', sess)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  -- Since 20260916130000 the action must be one the edge functions send, and
  -- the caller must hold its capability to record anything but a refusal.
  -- `activation_code.generate` needs codes.manage, which billing holds.
  v_id := public.platform_audit_record('write', 'activation_code.generate', 'ok', 'c0000000-0000-4000-8000-00000000000a',
                                       'company', 'c0000000-0000-4000-8000-00000000000a', NULL, '{"x": 1}'::jsonb)::text;
  PERFORM _pa_reset();
  SELECT * INTO r FROM app_private.platform_audit_log WHERE id = v_id::bigint;
  PERFORM _pa_ok('audit: platform_audit_record writes for staff, with actor, role and session from the JWT',
    r.actor_user_id = billing AND r.actor_role = 'billing' AND r.session_id = sess
    AND r.category = 'write' AND r.action = 'activation_code.generate' AND r.outcome = 'ok'
    AND r.company_id = 'c0000000-0000-4000-8000-00000000000a' AND r.after_value = '{"x": 1}'::jsonb);

  PERFORM _pa_ok('audit: platform_audit_record writes nothing for a company admin',
    _pa_try(admin_a, $q$SELECT platform_audit_record('write', 'activation_code.generate', 'denied')::text$q$) = '<null>');
  PERFORM _pa_ok('audit: platform_audit_record writes nothing for the flag alone',
    _pa_try(flag, $q$SELECT platform_audit_record('write', 'activation_code.generate', 'denied')::text$q$) = '<null>');
  PERFORM _pa_ok('audit: platform_audit_record accepts only the read and write categories',
    _pa_try(billing, $q$SELECT platform_audit_record('legacy', 'pa.record', 'ok')::text$q$) LIKE 'ERR 22023%'
    AND _pa_try(billing, $q$SELECT platform_audit_record('auth', 'pa.record', 'ok')::text$q$) LIKE 'ERR 22023%'
    AND _pa_try(billing, $q$SELECT platform_audit_record('staff', 'pa.record', 'ok')::text$q$) LIKE 'ERR 22023%'
    AND _pa_try(billing, $q$SELECT platform_audit_record('support', 'pa.record', 'ok')::text$q$) LIKE 'ERR 22023%'
    AND _pa_try(billing, $q$SELECT platform_audit_record('settings', 'pa.record', 'ok')::text$q$) LIKE 'ERR 22023%');

  -- Any active staff role may call it, read_only included; none may write a row
  -- that passes for one the database wrote itself.
  PERFORM _pa_ok('audit: read_only cannot forge the row the staff trigger writes',
    _pa_try(readonly, $q$SELECT platform_audit_record('staff', 'platform_staff.delete', 'ok', NULL, 'platform_staff', '3a000000-0000-4000-8000-000000000001')::text$q$) LIKE 'ERR 22023%'
    AND _pa_try(readonly, $q$SELECT platform_audit_record('write', 'platform_staff.delete', 'ok', NULL, 'platform_staff', '3a000000-0000-4000-8000-000000000001')::text$q$) LIKE 'ERR 22023%');
  PERFORM _pa_ok('audit: the legacy. and auth. namespaces belong to the database too',
    _pa_try(readonly, $q$SELECT platform_audit_record('write', 'legacy.subscription_admin_actions', 'ok')::text$q$) LIKE 'ERR 22023%'
    AND _pa_try(readonly, $q$SELECT platform_audit_record('read', 'auth.sign_in', 'ok')::text$q$) LIKE 'ERR 22023%'
    AND _pa_try(readonly, $q$SELECT platform_audit_record('write', 'legacy', 'ok')::text$q$) LIKE 'ERR 22023%');
  -- `platform_staff_invite.create` starts like the reserved `platform_staff`
  -- namespace but is a different name, and the pattern only reserves the name
  -- followed by a dot or the end. read_only lacks staff.manage, so what it may
  -- record under that action is its own refusal — which is what it does here.
  PERFORM _pa_ok('audit: a name that only starts like a reserved namespace is not refused',
    _pa_try(readonly, $q$SELECT (platform_audit_record('write', 'platform_staff_invite.create', 'denied') IS NOT NULL)::text$q$) = 'true');
  PERFORM _pa_ok('audit: an action no edge function sends is refused (20260916130000)',
    _pa_try(billing, $q$SELECT platform_audit_record('write', 'pa.record', 'ok')::text$q$) LIKE 'ERR 22023%'
    AND _pa_try(billing, $q$SELECT platform_audit_record('read', 'manage_users.create', 'ok')::text$q$) LIKE 'ERR 22023%');
  PERFORM _pa_ok('audit: a role without an action''s capability records only its refusal',
    _pa_try(readonly, $q$SELECT platform_audit_record('write', 'activation_code.generate', 'ok')::text$q$) LIKE 'ERR 42501%'
    AND _pa_try(readonly, $q$SELECT platform_audit_record('write', 'activation_code.generate', 'attempt')::text$q$) LIKE 'ERR 42501%'
    AND _pa_try(readonly, $q$SELECT (platform_audit_record('write', 'activation_code.generate', 'denied') IS NOT NULL)::text$q$) = 'true');

  v_ro_id := _pa_do(readonly, $q$SELECT platform_audit_record('read', 'manage_users.list', 'ok')::text$q$);
  PERFORM _pa_ok('audit: read_only records a read, attributed to itself and its role',
    (SELECT actor_user_id = readonly AND actor_role = 'read_only' AND category = 'read' AND outcome = 'ok'
       FROM app_private.platform_audit_log WHERE id = v_ro_id::bigint));
  v_ro_id := _pa_do(billing, $q$SELECT platform_audit_record('write', 'activation_code.generate', 'attempt')::text$q$);
  PERFORM _pa_ok('audit: an attempt row is accepted, for a write about to start',
    (SELECT outcome = 'attempt' AND actor_role = 'billing' FROM app_private.platform_audit_log WHERE id = v_ro_id::bigint));
  PERFORM _pa_ok('audit: a malformed action is refused',
    _pa_try(billing, $q$SELECT platform_audit_record('write', 'Drop Table', 'ok')::text$q$) LIKE 'ERR 22023%');

  PERFORM _pa_ok('audit_write: only legacy rows may carry their own timestamp',
    _pa_raises($q$SELECT app_private.audit_write('write', 'pa.backdated', 'ok', NULL, NULL, NULL, NULL, NULL, NULL, NULL, now() - interval '1 year')$q$) = '22023'
    AND _pa_raises($q$SELECT app_private.audit_write('legacy', 'legacy.pa', 'ok', NULL, NULL, NULL, NULL, NULL, NULL, NULL, now() - interval '1 year')$q$) IS NULL);
  v_legacy := app_private.audit_write('legacy', 'legacy.pa', 'ok', NULL, NULL, NULL, NULL, NULL,
                                      billing, NULL, now() - interval '1 day');
  PERFORM _pa_ok('audit_write: a legacy row keeps its actor and timestamp but carries no role, even for a staff actor',
    (SELECT actor_user_id = billing AND actor_role IS NULL AND occurred_at < now() - interval '23 hours'
       FROM app_private.platform_audit_log WHERE id = v_legacy));

  PERFORM _pa_ok('audit: UPDATE is refused, even for the owner of the table',
    _pa_raises(format($q$UPDATE app_private.platform_audit_log SET action = 'pa.changed' WHERE id = %s$q$, v_id)) = 'P0001');
  PERFORM _pa_ok('audit: DELETE is refused',
    _pa_raises(format('DELETE FROM app_private.platform_audit_log WHERE id = %s', v_id)) = 'P0001');
  PERFORM _pa_ok('audit: TRUNCATE is refused',
    _pa_raises('TRUNCATE app_private.platform_audit_log') = 'P0001');
  PERFORM _pa_ok('audit: the row is still there',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log WHERE id = v_id::bigint AND action = 'activation_code.generate'));
END $$;

-- ─── 9. signup never takes a staff account ──────────────────────────────────

DO $$
DECLARE
  signup constant uuid := '3a000000-0000-4000-8000-00000000000b';
  plain  constant uuid := '3a000000-0000-4000-8000-00000000000c';
BEGIN
  PERFORM _pa_reset();
  -- disabled on purpose: a former staff member is refused too
  INSERT INTO app_private.platform_staff (user_id, role, disabled_at, note) VALUES (signup, 'support', now(), 'pa');

  PERFORM _pa_ok('signup_create_company refuses an account with a (disabled) staff row',
    _pa_raises(format($q$SELECT public.signup_create_company(%L, 'pa-signup@test.invalid', 'PA', 'PA Signup Co', 'basic', 'monthly', 3, NULL, NULL)$q$, signup)) = '22023');
  PERFORM _pa_ok('signup_create_company still signs up an account without one (control)',
    (public.signup_create_company(plain, 'pa-plain@test.invalid', 'PA', 'PA Plain Co', 'basic', 'monthly', 3, NULL, NULL) ->> 'ok') = 'true');

  PERFORM _pa_ok('signup_discard keeps a fresh unconfirmed account with a staff row',
    NOT public.signup_discard(signup) AND EXISTS (SELECT 1 FROM auth.users WHERE id = signup));

  -- Every signup path asks one body, which reads platform_staff.
  PERFORM _pa_ok('oauth_account_is_platform_staff: a disabled staff row counts',
    app_private.oauth_account_is_platform_staff(signup));
  PERFORM _pa_ok('oauth_account_is_platform_staff: no staff row, a NULL id and the flag alone are not staff',
    NOT app_private.oauth_account_is_platform_staff(plain)
    AND NOT app_private.oauth_account_is_platform_staff(NULL)
    AND NOT app_private.oauth_account_is_platform_staff('3a000000-0000-4000-8000-000000000007'));
  PERFORM _pa_ok('signup_create_company writes through signup_insert_company and asks oauth_account_is_platform_staff',
    (SELECT p.prosrc ~ 'app_private\.signup_insert_company\('
            AND p.prosrc ~ 'app_private\.oauth_account_is_platform_staff\('
            AND p.prosrc !~ 'is_super_admin'
       FROM pg_proc p
      WHERE p.oid = 'public.signup_create_company(uuid,text,text,text,text,text,integer,text,text)'::regprocedure));
  PERFORM _pa_ok('signup_discard asks oauth_account_is_platform_staff and reads no flag',
    (SELECT p.prosrc ~ 'app_private\.oauth_account_is_platform_staff\(' AND p.prosrc !~ 'is_super_admin'
       FROM pg_proc p WHERE p.oid = 'public.signup_discard(uuid)'::regprocedure));
END $$;

DO $$ BEGIN RAISE NOTICE '── platform-authority: all checks passed ──'; END $$;

ROLLBACK;
