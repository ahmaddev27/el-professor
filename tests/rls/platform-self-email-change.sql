/*
  A platform account changes its own address without a code (20260919140000).

  Runs after assertions.sql and the matrix, against the same throwaway database,
  as supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it
  see the database as the seeds left it.

  The owner decided on 17.09.2026 that a platform account changes its own email
  address with its current password alone. The code is gone for that one case;
  company users keep it. What is left holding the door is written in two places
  and this file guards the database half:

  - the **session** half is the edge function's, `otp-core.ts`'s
    `PASSWORD_PROOF_MAX_AGE_SECONDS` read out of the token's `amr` claim, and
    `supabase/functions/_shared/platform-email-change.test.ts` pins it;
  - the **account** half is here: the two RPCs are reachable by the service role
    and nobody else, they answer `not_platform_account` for anything but an
    active staff row, and the one audit row they write cannot be written, forged
    or suppressed through the door the edge functions hold
    (`public.platform_audit_record`).

  What is covered, in order:

    1. grants     EXECUTE is service_role only; anon and authenticated are
                  refused by privilege, not by the function's own guard
    2. verdicts   every answer platform_self_email_change_check can give, for a
                  platform owner, a company admin, a disabled staff row and an
                  id with no account; the ban predicate (GoTrue keeps an issued
                  token valid through a ban, so containment depends on it); the
                  hourly cap on completed changes, which counts one actor's `ok`
                  rows and not its attempts; and 22023 for a broken contract
    3. audit      one row per call, with category auth, the account as actor,
                  its platform role, the session from the caller and the two
                  addresses; the `attempt` row that makes the audit fail closed,
                  and the `error` row for a change GoTrue refused; NULL and no
                  row for an account with no active staff row; 22023 for a
                  broken contract
    4. door       platform_audit_record still refuses the action, it is not on
                  the edge functions' list, and the row stays append-only

  Section 2 runs each probe in a subtransaction that is rolled back, so one
  principal never sees another's writes.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in platform-authority.sql) ────────────────────────────

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS banned_until       timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at         timestamptz,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT now();

-- GoTrue's own column is nullable — an account can have a phone and no address
-- — and section 2 needs that to reach the no_account branch. A no-op where the
-- column already is, and the whole file rolls back either way.
ALTER TABLE auth.users ALTER COLUMN email DROP NOT NULL;

-- ─── helpers (the shape of platform-authority.sql's) ────────────────────────

CREATE OR REPLACE FUNCTION _ec_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

/** Back to the connecting superuser with no JWT claims at all. */
CREATE OR REPLACE FUNCTION _ec_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

/** Become a principal: a user id (authenticated), NULL (anon), or the service role. */
CREATE OR REPLACE FUNCTION _ec_become(p_user uuid, p_service boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _ec_reset();
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
  back, and returns the scalar it produced or `ERR <sqlstate> <message>`.
*/
CREATE OR REPLACE FUNCTION _ec_try(p_user uuid, p_sql text, p_service boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _ec_become(p_user, p_service);
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
  PERFORM _ec_reset();
  RETURN v_out;
END $$;

/** Like _ec_try, but the statement's effect is kept. */
CREATE OR REPLACE FUNCTION _ec_do(p_user uuid, p_sql text, p_service boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _ec_become(p_user, p_service);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _ec_reset();
  RETURN v_out;
END $$;

-- ─── principals ─────────────────────────────────────────────────────────────

-- seed.sql already holds the platform owner 50000000-…-0001 (super@test.invalid)
-- and the company admin a0000000-…-0001 (admin-a@test.invalid). Added here:
-- a former colleague whose staff row is disabled, and an account with no staff
-- row at all that is not in any company.
INSERT INTO auth.users (id, email) VALUES
  ('5e000000-0000-4000-8000-000000000001', 'disabled-staff@test.invalid'),
  ('5e000000-0000-4000-8000-000000000002', 'nobody@test.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, disabled_at, note)
VALUES ('5e000000-0000-4000-8000-000000000001', 'support', now() - interval '1 day', 'email-change test')
ON CONFLICT (user_id) DO NOTHING;

-- ─── 1. grants ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_check  CONSTANT text := 'public.platform_self_email_change_check(uuid,text)';
  c_record CONSTANT text := 'public.platform_self_email_change_record(uuid,text,text,text,uuid)';
  v_sig text;
BEGIN
  PERFORM _ec_reset();

  FOREACH v_sig IN ARRAY ARRAY[c_check, c_record] LOOP
    PERFORM _ec_ok(format('%s exists', v_sig), to_regprocedure(v_sig) IS NOT NULL);
    PERFORM _ec_ok(format('EXECUTE on %s: anon no, authenticated no, service_role yes', v_sig),
      NOT has_function_privilege('anon', v_sig::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', v_sig::regprocedure, 'EXECUTE')
      AND has_function_privilege('service_role', v_sig::regprocedure, 'EXECUTE'));
    PERFORM _ec_ok(format('%s is SECURITY DEFINER with a pinned search_path', v_sig),
      (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig))
      AND EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                   WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=%'));
    -- SECURITY DEFINER runs as the owner, and both reach app_private.
    PERFORM _ec_ok(format('the owner of %s can reach app_private', v_sig),
      EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
               WHERE p.oid = to_regprocedure(v_sig)
                 AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private'))));
  END LOOP;

  -- Refused by privilege, before the function's own guard: the anon key must
  -- never learn whether an address is taken, and a signed-in company user must
  -- not be able to ask on anyone's behalf.
  PERFORM _ec_ok('anon is refused calling the check',
    _ec_try(NULL, $q$SELECT platform_self_email_change_check(
      '50000000-0000-4000-8000-000000000001'::uuid, 'neu@example.com')$q$) LIKE 'ERR 42501%');
  PERFORM _ec_ok('authenticated is refused calling the check',
    _ec_try('a0000000-0000-4000-8000-000000000001',
      $q$SELECT platform_self_email_change_check(
        '50000000-0000-4000-8000-000000000001'::uuid, 'neu@example.com')$q$) LIKE 'ERR 42501%');
  PERFORM _ec_ok('anon is refused calling the recorder',
    _ec_try(NULL, $q$SELECT platform_self_email_change_record(
      '50000000-0000-4000-8000-000000000001'::uuid, 'super@test.invalid', 'neu@example.com')::text$q$)
    LIKE 'ERR 42501%');
  PERFORM _ec_ok('authenticated, and a platform owner at that, is refused calling the recorder',
    _ec_try('50000000-0000-4000-8000-000000000001',
      $q$SELECT platform_self_email_change_record(
        '50000000-0000-4000-8000-000000000001'::uuid, 'super@test.invalid', 'neu@example.com')::text$q$)
    LIKE 'ERR 42501%');
END $$;

-- ─── 2. what the check answers ──────────────────────────────────────────────

DO $$
DECLARE
  c_owner    CONSTANT uuid := '50000000-0000-4000-8000-000000000001';
  c_admin    CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_disabled CONSTANT uuid := '5e000000-0000-4000-8000-000000000001';
  c_ghost    CONSTANT uuid := '5e000000-0000-4000-8000-0000000000ff';
  r record;
BEGIN
  PERFORM _ec_reset();

  FOR r IN
    SELECT * FROM (VALUES
      -- the account asked about                     the new address              expected
      (c_owner,    'neu@example.com',           'ok'),
      -- the account's own address, in any letter case
      (c_owner,    'super@test.invalid',        'same_email'),
      (c_owner,    '  SUPER@Test.Invalid  ',    'same_email'),
      -- an address another account already holds
      (c_owner,    'admin-a@test.invalid',      'email_taken'),
      (c_owner,    'ADMIN-A@test.invalid',      'email_taken'),
      -- a company user keeps the code path, whatever it asks for
      (c_admin,    'neu@example.com',           'not_platform_account'),
      -- a disabled staff row is not the platform's any more
      (c_disabled, 'neu@example.com',           'not_platform_account'),
      -- and an id GoTrue never heard of is refused before the staff lookup
      -- can be mistaken for an answer about it
      (c_ghost,    'neu@example.com',           'not_platform_account')
    ) AS t(account, new_email, expected)
  LOOP
    PERFORM _ec_ok(format('check(%s, %L) = %s', r.account, r.new_email, r.expected),
      _ec_try(NULL, format('SELECT platform_self_email_change_check(%L::uuid, %L)', r.account, r.new_email), true)
        = r.expected);
  END LOOP;

  -- An account with a staff row but no GoTrue row at all. The staff table's
  -- foreign key makes that impossible today; no_account is the answer if it
  -- ever becomes possible, and the branch is reachable through an account whose
  -- email column is NULL.
  -- Written as the connecting superuser; sync_user_profile_email leaves the
  -- profile's copy alone for a NULL address, which is why this is safe.
  UPDATE auth.users SET email = NULL WHERE id = c_owner;
  PERFORM _ec_ok('check() answers no_account for a staff account with no address',
    _ec_try(NULL, $q$SELECT platform_self_email_change_check(
      '50000000-0000-4000-8000-000000000001'::uuid, 'neu@example.com')$q$, true) = 'no_account');
  UPDATE auth.users SET email = 'super@test.invalid' WHERE id = c_owner;

  -- The containment lever. GoTrue does not revoke an issued access token when
  -- an account is banned, so a responder who bans a compromised platform
  -- account without also disabling its staff row must still stop it moving its
  -- own address. A ban that has already lapsed must not.
  UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = c_owner;
  PERFORM _ec_ok('check() answers account_blocked for a banned account with an active staff row',
    _ec_try(NULL, $q$SELECT platform_self_email_change_check(
      '50000000-0000-4000-8000-000000000001'::uuid, 'neu@example.com')$q$, true) = 'account_blocked');
  UPDATE auth.users SET banned_until = now() - interval '1 day' WHERE id = c_owner;
  PERFORM _ec_ok('a ban that has lapsed does not block',
    _ec_try(NULL, $q$SELECT platform_self_email_change_check(
      '50000000-0000-4000-8000-000000000001'::uuid, 'neu@example.com')$q$, true) = 'ok');
  UPDATE auth.users SET banned_until = NULL, deleted_at = now() WHERE id = c_owner;
  PERFORM _ec_ok('check() answers account_blocked for a deleted account',
    _ec_try(NULL, $q$SELECT platform_self_email_change_check(
      '50000000-0000-4000-8000-000000000001'::uuid, 'neu@example.com')$q$, true) = 'account_blocked');
  UPDATE auth.users SET deleted_at = NULL WHERE id = c_owner;

  -- The hourly cap on completed changes. It bounds the notice mail an insider
  -- loop would send; only `ok` rows count, and it is deliberately high enough
  -- that correcting a mistyped address is immediate.
  --
  -- The seeded rows are written as the connecting superuser, because nobody
  -- else holds EXECUTE on audit_write, and each subtransaction below is rolled
  -- back on the way out: the log is append-only, so they cannot be deleted
  -- again and would otherwise reach section 3's counts.
  BEGIN
    PERFORM app_private.audit_write('auth', 'auth.platform_email_change', 'ok', NULL::uuid,
              'user_account', c_owner::text, NULL::jsonb, NULL::jsonb, c_owner)
       FROM generate_series(1, 4);
    PERFORM _ec_ok('four completed changes in the hour still leave a fifth open',
      _ec_try(NULL, $q$SELECT platform_self_email_change_check(
        '50000000-0000-4000-8000-000000000001'::uuid, 'neu@example.com')$q$, true) = 'ok');

    PERFORM app_private.audit_write('auth', 'auth.platform_email_change', 'ok', NULL::uuid,
              'user_account', c_owner::text, NULL::jsonb, NULL::jsonb, c_owner);
    PERFORM _ec_ok('the fifth closes it',
      _ec_try(NULL, $q$SELECT platform_self_email_change_check(
        '50000000-0000-4000-8000-000000000001'::uuid, 'neu@example.com')$q$, true) = 'rate_limited');

    RAISE EXCEPTION USING ERRCODE = 'ZZ007';
  EXCEPTION WHEN SQLSTATE 'ZZ007' THEN NULL;
  END;

  -- Attempt rows are not counted: they mail nothing, and counting them would
  -- let a failing GoTrue lock the owner out of correcting his own address.
  BEGIN
    PERFORM app_private.audit_write('auth', 'auth.platform_email_change', 'attempt', NULL::uuid,
              'user_account', c_owner::text, NULL::jsonb, NULL::jsonb, c_owner)
       FROM generate_series(1, 20);
    PERFORM _ec_ok('twenty attempt rows do not close it',
      _ec_try(NULL, $q$SELECT platform_self_email_change_check(
        '50000000-0000-4000-8000-000000000001'::uuid, 'neu@example.com')$q$, true) = 'ok');
    RAISE EXCEPTION USING ERRCODE = 'ZZ007';
  EXCEPTION WHEN SQLSTATE 'ZZ007' THEN NULL;
  END;

  -- Another account's changes are not this account's.
  BEGIN
    PERFORM app_private.audit_write('auth', 'auth.platform_email_change', 'ok', NULL::uuid,
              'user_account', c_admin::text, NULL::jsonb, NULL::jsonb, c_admin)
       FROM generate_series(1, 9);
    PERFORM _ec_ok('the cap counts one actor, not the whole log',
      _ec_try(NULL, $q$SELECT platform_self_email_change_check(
        '50000000-0000-4000-8000-000000000001'::uuid, 'neu@example.com')$q$, true) = 'ok');
    RAISE EXCEPTION USING ERRCODE = 'ZZ007';
  EXCEPTION WHEN SQLSTATE 'ZZ007' THEN NULL;
  END;

  -- A broken argument contract raises 22023 with a fixed message and never
  -- returns a verdict, so the route can tell "the migration and I disagree"
  -- from "this address is refused".
  FOR r IN
    SELECT * FROM (VALUES
      ('NULL::uuid',                                  $q$'neu@example.com'$q$),
      ($q$'50000000-0000-4000-8000-000000000001'$q$,  'NULL'),
      ($q$'50000000-0000-4000-8000-000000000001'$q$,  $q$''$q$),
      ($q$'50000000-0000-4000-8000-000000000001'$q$,  $q$'not an address'$q$),
      ($q$'50000000-0000-4000-8000-000000000001'$q$,  $q$'a@b'$q$),
      ($q$'50000000-0000-4000-8000-000000000001'$q$,  $q$'a b@c.de'$q$),
      ($q$'50000000-0000-4000-8000-000000000001'$q$,  'repeat(''a'', 250) || ''@b.de''')
    ) AS t(account, new_email)
  LOOP
    PERFORM _ec_ok(format('check(%s, %s) raises 22023', r.account, r.new_email),
      _ec_try(NULL, format('SELECT platform_self_email_change_check(%s::uuid, %s)', r.account, r.new_email), true)
        LIKE 'ERR 22023 %');
  END LOOP;
END $$;

-- ─── 3. the one audit row ───────────────────────────────────────────────────

DO $$
DECLARE
  c_owner   CONSTANT uuid := '50000000-0000-4000-8000-000000000001';
  c_admin   CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_session CONSTANT uuid := '11111111-2222-4333-8444-555555555555';
  c_action  CONSTANT text := 'auth.platform_email_change';

  v_answer text;
  v_row    app_private.platform_audit_log;
  v_before bigint;
BEGIN
  PERFORM _ec_reset();
  SELECT count(*) INTO v_before FROM app_private.platform_audit_log WHERE action = c_action;

  v_answer := _ec_do(NULL, format(
    $q$SELECT platform_self_email_change_record(%L::uuid, 'super@test.invalid', '  NEU@Example.COM ', 'ok', %L::uuid)::text$q$,
    c_owner, c_session), true);
  PERFORM _ec_ok('record() returns the id of the row it wrote', v_answer ~ '^[0-9]+$');

  PERFORM _ec_reset();
  PERFORM _ec_ok('record() writes exactly one row',
    (SELECT count(*) FROM app_private.platform_audit_log WHERE action = c_action) = v_before + 1);

  SELECT * INTO v_row FROM app_private.platform_audit_log WHERE action = c_action ORDER BY id DESC LIMIT 1;

  PERFORM _ec_ok('the row is category auth, outcome ok',
    v_row.category = 'auth' AND v_row.outcome = 'ok');
  PERFORM _ec_ok('the actor is the account itself, with its platform role',
    v_row.actor_user_id = c_owner AND v_row.actor_role = 'owner');
  PERFORM _ec_ok('the session the route read out of the caller''s token is kept',
    v_row.session_id = c_session);
  PERFORM _ec_ok('the target is the account, and no company is named',
    v_row.target_type = 'user_account' AND v_row.target_id = c_owner::text AND v_row.company_id IS NULL);
  PERFORM _ec_ok('both addresses are recorded, normalised the way the route normalises them',
    v_row.before_value = jsonb_build_object('email', 'super@test.invalid')
    AND v_row.after_value = jsonb_build_object('email', 'neu@example.com'));

  -- A change recorded without a session id is still a complete row.
  v_answer := _ec_do(NULL, format(
    $q$SELECT platform_self_email_change_record(%L::uuid, 'super@test.invalid', 'zwei@example.com')::text$q$,
    c_owner), true);
  PERFORM _ec_ok('record() works without a session id', v_answer ~ '^[0-9]+$');
  PERFORM _ec_reset();
  PERFORM _ec_ok('and leaves the session column empty rather than failing',
    (SELECT l.session_id FROM app_private.platform_audit_log l
      WHERE l.action = c_action ORDER BY l.id DESC LIMIT 1) IS NULL);

  -- An account with no active staff row writes nothing and says so by
  -- returning NULL, rather than raising: the route has already refused such a
  -- caller, and a second refusal here would turn a completed change into a 500.
  SELECT count(*) INTO v_before FROM app_private.platform_audit_log WHERE action = c_action;
  PERFORM _ec_ok('record() returns NULL for a company user',
    _ec_do(NULL, format(
      $q$SELECT platform_self_email_change_record(%L::uuid, 'admin-a@test.invalid', 'neu@example.com')::text$q$,
      c_admin), true) = '<null>');
  PERFORM _ec_ok('record() returns NULL for a disabled staff row',
    _ec_do(NULL,
      $q$SELECT platform_self_email_change_record(
        '5e000000-0000-4000-8000-000000000001'::uuid,
        'disabled-staff@test.invalid', 'neu@example.com')::text$q$, true) = '<null>');
  PERFORM _ec_reset();
  PERFORM _ec_ok('and writes no row for either',
    (SELECT count(*) FROM app_private.platform_audit_log WHERE action = c_action) = v_before);

  -- The attempt row: written before the change, so an address the log cannot
  -- record is an address that does not move. It names both addresses, so an
  -- attempt with no outcome still says what was being attempted.
  SELECT count(*) INTO v_before FROM app_private.platform_audit_log WHERE action = c_action;
  PERFORM _ec_ok('record() writes an attempt row',
    _ec_do(NULL, format(
      $q$SELECT platform_self_email_change_record(%L::uuid, 'super@test.invalid', 'drei@example.com', 'attempt')::text$q$,
      c_owner), true) ~ '^[0-9]+$');
  PERFORM _ec_reset();
  SELECT * INTO v_row FROM app_private.platform_audit_log WHERE action = c_action ORDER BY id DESC LIMIT 1;
  PERFORM _ec_ok('the attempt row is outcome attempt and names both addresses',
    v_row.outcome = 'attempt' AND v_row.category = 'auth'
    AND v_row.before_value = jsonb_build_object('email', 'super@test.invalid')
    AND v_row.after_value = jsonb_build_object('email', 'drei@example.com'));

  PERFORM _ec_ok('record() writes an error row for a change GoTrue refused',
    _ec_do(NULL, format(
      $q$SELECT platform_self_email_change_record(%L::uuid, 'super@test.invalid', 'drei@example.com', 'error')::text$q$,
      c_owner), true) ~ '^[0-9]+$');
  PERFORM _ec_reset();
  PERFORM _ec_ok('and only those three outcomes exist',
    (SELECT count(*) FROM app_private.platform_audit_log WHERE action = c_action) = v_before + 2);

  -- `denied` belongs to the RPCs a client can call; this one is only ever
  -- reached after the route has already authorized the caller.
  PERFORM _ec_ok('record() refuses an outcome outside the three',
    _ec_try(NULL, format(
      $q$SELECT platform_self_email_change_record(%L::uuid, 'a@b.de', 'c@d.de', 'denied')::text$q$,
      c_owner), true) LIKE 'ERR 22023 %');

  -- A broken contract raises rather than writing a misleading row.
  PERFORM _ec_ok('record(NULL account) raises 22023',
    _ec_try(NULL, $q$SELECT platform_self_email_change_record(
      NULL::uuid, 'a@b.de', 'c@d.de')::text$q$, true) LIKE 'ERR 22023 %');
  PERFORM _ec_ok('record() with the same address twice raises 22023',
    _ec_try(NULL, format(
      $q$SELECT platform_self_email_change_record(%L::uuid, 'super@test.invalid', 'SUPER@test.invalid')::text$q$,
      c_owner), true) LIKE 'ERR 22023 %');
  PERFORM _ec_ok('record() with an empty address raises 22023',
    _ec_try(NULL, format(
      $q$SELECT platform_self_email_change_record(%L::uuid, '', 'c@d.de')::text$q$, c_owner), true)
    LIKE 'ERR 22023 %');
END $$;

-- ─── 4. the edge functions' door stays shut on this action ──────────────────

DO $$
DECLARE
  c_owner  CONSTANT uuid := '50000000-0000-4000-8000-000000000001';
  c_action CONSTANT text := 'auth.platform_email_change';
  v_id     bigint;
BEGIN
  PERFORM _ec_reset();

  -- platform_audit_record is reachable by *any* active staff role, read_only
  -- included. It must go on refusing the auth. namespace, or a read_only
  -- account could write a row saying an address changed when none did.
  PERFORM _ec_ok('a platform owner cannot record this action through platform_audit_record',
    _ec_try(c_owner, format($q$SELECT platform_audit_record('write', %L, 'ok')::text$q$, c_action))
      LIKE 'ERR 22023 %');
  PERFORM _ec_ok('nor with category auth, which that door does not accept at all',
    _ec_try(c_owner, format($q$SELECT platform_audit_record('auth', %L, 'ok')::text$q$, c_action))
      LIKE 'ERR 22023 %');
  PERFORM _ec_ok('nor under a name outside the reserved namespace',
    _ec_try(c_owner, $q$SELECT platform_audit_record('write', 'platform_email_change.apply', 'ok')::text$q$)
      LIKE 'ERR 22023 %');

  PERFORM _ec_ok('the action is not on the edge functions'' list either',
    NOT EXISTS (SELECT 1 FROM app_private.platform_edge_audit_actions() a WHERE a.action = c_action));

  -- The row the database did write is append-only like every other.
  SELECT l.id INTO v_id FROM app_private.platform_audit_log l WHERE l.action = c_action ORDER BY l.id DESC LIMIT 1;
  PERFORM _ec_ok('a written row exists to test against', v_id IS NOT NULL);
  BEGIN
    UPDATE app_private.platform_audit_log SET outcome = 'denied' WHERE id = v_id;
    -- Its own SQLSTATE: the trigger raises P0001 too, and a shared code would
    -- let this failure be swallowed by the handler meant for the refusal.
    RAISE EXCEPTION 'FAIL: the audit row could be updated' USING ERRCODE = 'ZZ006';
  EXCEPTION
    WHEN SQLSTATE 'ZZ006' THEN RAISE;
    WHEN SQLSTATE 'P0001' THEN
      PERFORM _ec_ok('the row cannot be updated', SQLERRM LIKE '%append-only%');
  END;
END $$;

ROLLBACK;
