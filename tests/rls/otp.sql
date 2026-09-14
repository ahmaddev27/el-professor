/*
  One-time codes and code-confirmed signup: do the database guarantees hold?

  Runs after assertions.sql, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass.

  What is covered, in order:

    1. privileges     nobody but the functions' owner reaches app_private;
                      the RPCs are service_role only, and anon/authenticated
                      are refused when they actually try
    2. issuing        the issued shape, cooldown, supersede, hourly and IP
                      limits, no_user
    3. eligibility    one case per purpose rule
    4. verifying      wrong / locked / expired / ok / replay / email_taken
    5. platform login session binding, session_invalid, the verification
                      and platform_login_verified()
    6. failed sends   do not start the cooldown
    7. email sync     auth.users.email -> user_profiles.email
    8. signup         create, complete, discard, purge
    9. otp_purge

  The fixture was dumped with --schema=public, so auth.users here carries only
  what the supabase/postgres image creates, and GoTrue's auth.sessions does not
  exist. The prelude adds exactly the columns and the table the functions read.

  The database never sees a real code or the pepper. `_otp_hash()` below just
  produces distinct 64-character hex strings, which is all it compares.

  The whole file runs in one transaction that is rolled back at the end: the
  stubs, helpers, accounts and companies it creates are gone before the next
  test file runs, so that file sees the database as the seeds left it. One
  consequence to keep in mind when adding checks: now() is the same instant
  in every block below, so time only passes where a check backdates rows.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs ───────────────────────────────────────────────────────────

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

CREATE OR REPLACE FUNCTION _otp_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _otp_hash(p_code text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(p_code, 'UTF8')), 'hex');
$$;

/** Pretend time has passed for one recipient's send history. */
CREATE OR REPLACE FUNCTION _otp_age_events(p_recipient text, p_by interval) RETURNS void
LANGUAGE sql AS $$
  UPDATE app_private.otp_send_events SET created_at = created_at - p_by WHERE recipient_email = p_recipient;
$$;

/**
  Runs p_sql as p_role: true if it ran, false if it was refused for lack of
  privilege. Any other error propagates, so a malformed statement cannot pass
  as a refusal.
*/
CREATE OR REPLACE FUNCTION _otp_runs_as(p_role text, p_sql text) RETURNS boolean
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

/** True if p_sql raised the argument-contract error 22023. Other errors propagate. */
CREATE OR REPLACE FUNCTION _otp_raises_22023(p_sql text) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN invalid_parameter_value THEN
  RETURN true;
END $$;

-- ─── principals ─────────────────────────────────────────────────────────────

/*
  Dedicated accounts, so no check depends on another's cooldown. Fixed UUIDs:

    0e..01 otp-active            confirmed, active, company A
    0e..02 otp-invite            confirmed, pending_invite, company A
    0e..03 otp-invite-nocompany  confirmed, pending_invite, no company
    0e..04 otp-suspended         confirmed, suspended
    0e..05 otp-banned            confirmed, active, banned for a day
    0e..06 otp-deleted           confirmed, active, soft-deleted
    0e..07 otp-super             platform admin, sessions 5e..01/02/04/05
    0e..08 otp-member            confirmed, active, not super, session 5e..03
    0e..09 otp-legacy            unconfirmed for 30 days, no pending signup
    0e..0a otp-taken             an address someone else already holds
    0e..0b..0f                   one account per test section
    0e..10 otp-pending           unconfirmed, in pending_signups
*/
INSERT INTO auth.users (id, email, email_confirmed_at, banned_until, deleted_at, created_at) VALUES
  ('0e000000-0000-4000-8000-000000000001', 'otp-active@test.invalid',           now(), NULL,                    NULL,  now() - interval '90 days'),
  ('0e000000-0000-4000-8000-000000000002', 'otp-invite@test.invalid',           now(), NULL,                    NULL,  now() - interval '2 days'),
  ('0e000000-0000-4000-8000-000000000003', 'otp-invite-nocompany@test.invalid', now(), NULL,                    NULL,  now() - interval '2 days'),
  ('0e000000-0000-4000-8000-000000000004', 'otp-suspended@test.invalid',        now(), NULL,                    NULL,  now() - interval '90 days'),
  ('0e000000-0000-4000-8000-000000000005', 'otp-banned@test.invalid',           now(), now() + interval '1 day', NULL,  now() - interval '90 days'),
  ('0e000000-0000-4000-8000-000000000006', 'otp-deleted@test.invalid',          now(), NULL,                    now(), now() - interval '90 days'),
  ('0e000000-0000-4000-8000-000000000007', 'otp-super@test.invalid',            now(), NULL,                    NULL,  now() - interval '90 days'),
  ('0e000000-0000-4000-8000-000000000008', 'otp-member@test.invalid',           now(), NULL,                    NULL,  now() - interval '90 days'),
  ('0e000000-0000-4000-8000-000000000009', 'otp-legacy@test.invalid',           NULL,  NULL,                    NULL,  now() - interval '30 days'),
  ('0e000000-0000-4000-8000-00000000000a', 'otp-taken@test.invalid',            now(), NULL,                    NULL,  now() - interval '90 days'),
  ('0e000000-0000-4000-8000-00000000000b', 'otp-hourly@test.invalid',           now(), NULL,                    NULL,  now() - interval '90 days'),
  ('0e000000-0000-4000-8000-00000000000c', 'otp-verify@test.invalid',           now(), NULL,                    NULL,  now() - interval '90 days'),
  ('0e000000-0000-4000-8000-00000000000d', 'otp-change@test.invalid',           now(), NULL,                    NULL,  now() - interval '90 days'),
  ('0e000000-0000-4000-8000-00000000000e', 'otp-sendfail@test.invalid',         now(), NULL,                    NULL,  now() - interval '90 days'),
  ('0e000000-0000-4000-8000-00000000000f', 'otp-sync@test.invalid',             now(), NULL,                    NULL,  now() - interval '90 days'),
  ('0e000000-0000-4000-8000-000000000010', 'otp-pending@test.invalid',          NULL,  NULL,                    NULL,  now() - interval '5 minutes');

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status) VALUES
  ('c0000000-0000-4000-8000-0000000000e1', 'OTP Pending Co', 'otp-pending-co', 'pending', 'trial', 'basic', 'inactive');

INSERT INTO user_profiles (user_id, email, full_name, role, company_id, is_super_admin, status) VALUES
  ('0e000000-0000-4000-8000-000000000001', 'otp-active@test.invalid',           'Otto Aktiv', 'viewer', 'c0000000-0000-4000-8000-00000000000a', false, 'active'),
  ('0e000000-0000-4000-8000-000000000002', 'otp-invite@test.invalid',           'Ina Invite', 'viewer', 'c0000000-0000-4000-8000-00000000000a', false, 'pending_invite'),
  ('0e000000-0000-4000-8000-000000000003', 'otp-invite-nocompany@test.invalid', '',           'viewer', NULL,                                   false, 'pending_invite'),
  ('0e000000-0000-4000-8000-000000000004', 'otp-suspended@test.invalid',        '',           'viewer', 'c0000000-0000-4000-8000-00000000000a', false, 'suspended'),
  ('0e000000-0000-4000-8000-000000000005', 'otp-banned@test.invalid',           '',           'viewer', 'c0000000-0000-4000-8000-00000000000a', false, 'active'),
  ('0e000000-0000-4000-8000-000000000006', 'otp-deleted@test.invalid',          '',           'viewer', 'c0000000-0000-4000-8000-00000000000a', false, 'active'),
  ('0e000000-0000-4000-8000-000000000007', 'otp-super@test.invalid',            'Plattform',  'admin',  NULL,                                   true,  'active'),
  ('0e000000-0000-4000-8000-000000000008', 'otp-member@test.invalid',           '',           'viewer', 'c0000000-0000-4000-8000-00000000000a', false, 'active'),
  ('0e000000-0000-4000-8000-000000000009', 'otp-legacy@test.invalid',           '',           'viewer', NULL,                                   false, 'pending_invite'),
  ('0e000000-0000-4000-8000-00000000000a', 'otp-taken@test.invalid',            '',           'viewer', 'c0000000-0000-4000-8000-00000000000a', false, 'active'),
  ('0e000000-0000-4000-8000-00000000000b', 'otp-hourly@test.invalid',           '',           'viewer', 'c0000000-0000-4000-8000-00000000000a', false, 'active'),
  ('0e000000-0000-4000-8000-00000000000c', 'otp-verify@test.invalid',           '',           'viewer', 'c0000000-0000-4000-8000-00000000000a', false, 'active'),
  ('0e000000-0000-4000-8000-00000000000d', 'otp-change@test.invalid',           '',           'viewer', 'c0000000-0000-4000-8000-00000000000a', false, 'active'),
  ('0e000000-0000-4000-8000-00000000000e', 'otp-sendfail@test.invalid',         '',           'viewer', 'c0000000-0000-4000-8000-00000000000a', false, 'active'),
  ('0e000000-0000-4000-8000-00000000000f', 'otp-sync@test.invalid',             '',           'viewer', 'c0000000-0000-4000-8000-00000000000a', false, 'active'),
  ('0e000000-0000-4000-8000-000000000010', 'otp-pending@test.invalid',          'Pia Pending','admin',  'c0000000-0000-4000-8000-0000000000e1', false, 'pending_invite');

INSERT INTO app_private.pending_signups (user_id, company_id) VALUES
  ('0e000000-0000-4000-8000-000000000010', 'c0000000-0000-4000-8000-0000000000e1');

INSERT INTO auth.sessions (id, user_id, not_after) VALUES
  ('5e000000-0000-4000-8000-000000000001', '0e000000-0000-4000-8000-000000000007', NULL),
  ('5e000000-0000-4000-8000-000000000002', '0e000000-0000-4000-8000-000000000007', now() - interval '1 minute'),
  ('5e000000-0000-4000-8000-000000000003', '0e000000-0000-4000-8000-000000000008', NULL),
  ('5e000000-0000-4000-8000-000000000004', '0e000000-0000-4000-8000-000000000007', NULL),
  ('5e000000-0000-4000-8000-000000000005', '0e000000-0000-4000-8000-000000000007', NULL);

-- ─── 1. privileges and hardening ────────────────────────────────────────────

DO $$
DECLARE
  r      record;
  v_role text;
  v_list text;
  v_def  boolean;
  v_cfg  text[];
  v_src  text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM _otp_ok(format('%s has no USAGE on schema app_private', v_role),
                    NOT has_schema_privilege(v_role, 'app_private', 'USAGE'));

    SELECT string_agg(c.relname, ', ') INTO v_list
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app_private'
       AND ((c.relkind = 'r' AND has_table_privilege(v_role, c.oid,
               'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
         OR (c.relkind = 'S' AND has_sequence_privilege(v_role, c.oid, 'USAGE, SELECT, UPDATE')));
    PERFORM _otp_ok(format('%s holds no privilege on any app_private table or sequence%s',
                           v_role, coalesce(' — but has: ' || v_list, '')),
                    v_list IS NULL);
  END LOOP;

  PERFORM _otp_ok('the four OTP tables exist in app_private',
    to_regclass('app_private.otp_challenges') IS NOT NULL
    AND to_regclass('app_private.otp_send_events') IS NOT NULL
    AND to_regclass('app_private.pending_signups') IS NOT NULL
    AND to_regclass('app_private.platform_login_verifications') IS NOT NULL);

  FOR r IN
    SELECT v.sig, to_regprocedure(v.sig) AS fn, v.service_role_may
      FROM (VALUES
        ('public.otp_issue(uuid,text,text,uuid,text,uuid,text,inet,uuid)',                 true),
        ('public.otp_mark_send_failed(uuid)',                                              true),
        ('public.otp_open_challenge(text,text,uuid)',                                      true),
        ('public.otp_verify(uuid,text,text,uuid)',                                         true),
        ('public.otp_purge(interval)',                                                     true),
        ('public.signup_create_company(uuid,text,text,text,text,text,integer,text,text)', true),
        ('public.signup_complete(uuid)',                                                   true),
        ('public.signup_discard(uuid)',                                                    true),
        ('public.signup_discard_unverified(text)',                                         true),
        ('public.purge_unverified_signups(interval)',                                      true),
        ('public.sync_user_profile_email()',                                               false),
        ('app_private.platform_login_verified(uuid,uuid)',                                 false)
      ) AS v(sig, service_role_may)
  LOOP
    PERFORM _otp_ok(format('%s exists', r.sig), r.fn IS NOT NULL);

    SELECT p.prosecdef, p.proconfig, p.prosrc INTO v_def, v_cfg, v_src
      FROM pg_proc p WHERE p.oid = r.fn::oid;

    PERFORM _otp_ok(format('%s is SECURITY DEFINER with a pinned search_path', r.sig),
      v_def AND EXISTS (SELECT 1 FROM unnest(v_cfg) AS s(setting) WHERE s.setting LIKE 'search_path=%'));
    PERFORM _otp_ok(format('%s neither returns SQLERRM nor swallows errors', r.sig),
      v_src !~* 'sqlerrm' AND v_src !~* 'when\s+others');
    PERFORM _otp_ok(format('%s: anon and authenticated cannot EXECUTE, service_role %s', r.sig,
                           CASE WHEN r.service_role_may THEN 'can' ELSE 'cannot' END),
      NOT has_function_privilege('anon', r.fn::oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', r.fn::oid, 'EXECUTE')
      AND has_function_privilege('service_role', r.fn::oid, 'EXECUTE') = r.service_role_may);
  END LOOP;

  -- Privilege functions can be wrong in ways a real call exposes, so try.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    PERFORM _otp_ok(format('%s is refused calling otp_issue', v_role),
      NOT _otp_runs_as(v_role, format(
        'SELECT public.otp_issue(gen_random_uuid(), %L, %L, NULL, NULL, NULL, %L, NULL, NULL)',
        'password_reset', 'otp-active@test.invalid', repeat('a', 64))));
    PERFORM _otp_ok(format('%s is refused calling otp_verify', v_role),
      NOT _otp_runs_as(v_role, format(
        'SELECT public.otp_verify(gen_random_uuid(), %L, %L, NULL)', 'password_reset', repeat('a', 64))));
    PERFORM _otp_ok(format('%s is refused calling otp_open_challenge', v_role),
      NOT _otp_runs_as(v_role, format(
        'SELECT public.otp_open_challenge(%L, %L, NULL)', 'password_reset', 'otp-active@test.invalid')));
    PERFORM _otp_ok(format('%s is refused calling signup_create_company', v_role),
      NOT _otp_runs_as(v_role, format(
        'SELECT public.signup_create_company(%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL)',
        '0e000000-0000-4000-8000-000000000010', 'otp-pending@test.invalid', 'x', 'x')));
    PERFORM _otp_ok(format('%s is refused calling signup_discard', v_role),
      NOT _otp_runs_as(v_role, format(
        'SELECT public.signup_discard(%L)', '0e000000-0000-4000-8000-000000000010')));
    PERFORM _otp_ok(format('%s is refused calling app_private.platform_login_verified', v_role),
      NOT _otp_runs_as(v_role, format(
        'SELECT app_private.platform_login_verified(%L, %L)',
        '0e000000-0000-4000-8000-000000000007', '5e000000-0000-4000-8000-000000000001')));
  END LOOP;

  -- The matching "can", so the refusals above are not a broken statement.
  PERFORM _otp_ok('service_role CAN call otp_open_challenge',
    _otp_runs_as('service_role', format(
      'SELECT public.otp_open_challenge(%L, %L, NULL)', 'password_reset', 'nobody@test.invalid')));
  PERFORM _otp_ok('service_role cannot read app_private.otp_challenges directly',
    NOT _otp_runs_as('service_role', 'SELECT count(*) FROM app_private.otp_challenges'));
  PERFORM _otp_ok('service_role cannot call app_private.platform_login_verified',
    NOT _otp_runs_as('service_role', format(
      'SELECT app_private.platform_login_verified(%L, %L)',
      '0e000000-0000-4000-8000-000000000007', '5e000000-0000-4000-8000-000000000001')));

  PERFORM _otp_ok('the unique open-challenge index exists on (purpose, user_id) for open rows',
    EXISTS (SELECT 1 FROM pg_indexes
             WHERE schemaname = 'app_private' AND indexname = 'otp_challenges_one_open'
               AND indexdef LIKE 'CREATE UNIQUE INDEX%(purpose, user_id)%'
               AND indexdef LIKE '%consumed_at IS NULL%superseded_at IS NULL%'));
END $$;

-- ─── 2. issuing, cooldown, supersede, limits ────────────────────────────────

DO $$
DECLARE
  active uuid := '0e000000-0000-4000-8000-000000000001';
  c1     uuid := gen_random_uuid();
  c2     uuid := gen_random_uuid();
  r      jsonb;
  ch     record;
  v_dup  boolean := false;
  i      integer;
BEGIN
  -- issued
  r := public.otp_issue(c1, 'password_reset', '  OTP-Active@Test.Invalid ', NULL, NULL, NULL,
                        _otp_hash('111111'), '203.0.113.10', NULL);
  PERFORM _otp_ok('password_reset for an active account is issued', r->>'status' = 'issued');
  PERFORM _otp_ok('issue returns the id it was given, the account and the normalized address',
    (r->>'challenge_id')::uuid = c1 AND (r->>'user_id')::uuid = active
    AND r->>'recipient_email' = 'otp-active@test.invalid');
  PERFORM _otp_ok('issue returns the profile name and no company name outside invites',
    r->>'full_name' = 'Otto Aktiv' AND jsonb_typeof(r->'company_name') = 'null');
  PERFORM _otp_ok('issue never returns the hash',
    NOT (r ? 'code_hash') AND position(_otp_hash('111111') IN r::text) = 0);
  PERFORM _otp_ok('expires_at is ten minutes from now',
    abs(extract(epoch FROM (r->>'expires_at')::timestamptz - (now() + interval '10 minutes'))) < 1);

  SELECT * INTO ch FROM app_private.otp_challenges WHERE id = c1;
  PERFORM _otp_ok('the challenge holds the hash, the lower-cased address, the IP and no attempts',
    ch.code_hash = _otp_hash('111111') AND ch.email = 'otp-active@test.invalid'
    AND ch.client_ip = '203.0.113.10'::inet AND ch.attempts = 0
    AND ch.new_email IS NULL AND ch.session_id IS NULL);
  PERFORM _otp_ok('an issued event is recorded for the challenge',
    EXISTS (SELECT 1 FROM app_private.otp_send_events
             WHERE challenge_id = c1 AND outcome = 'issued' AND recipient_email = 'otp-active@test.invalid'
               AND user_id = active AND client_ip = '203.0.113.10'::inet));

  -- cooldown
  r := public.otp_issue(gen_random_uuid(), 'password_reset', 'otp-active@test.invalid', NULL, NULL, NULL,
                        _otp_hash('222222'), '203.0.113.10', NULL);
  PERFORM _otp_ok('a second code inside 60 s is refused with reason cooldown',
    r->>'status' = 'rate_limited' AND r->>'reason' = 'cooldown');
  PERFORM _otp_ok('the cooldown retry_after_seconds is an integer between 1 and 60',
    jsonb_typeof(r->'retry_after_seconds') = 'number' AND (r->>'retry_after_seconds')::integer BETWEEN 1 AND 60);
  PERFORM _otp_ok('the cooldown is recorded and the first code stays the open one',
    EXISTS (SELECT 1 FROM app_private.otp_send_events
             WHERE recipient_email = 'otp-active@test.invalid' AND outcome = 'cooldown')
    AND public.otp_open_challenge('password_reset', 'otp-active@test.invalid', NULL) = c1);

  -- supersede
  PERFORM _otp_age_events('otp-active@test.invalid', interval '61 seconds');
  r := public.otp_issue(c2, 'password_reset', 'otp-active@test.invalid', NULL, NULL, NULL,
                        _otp_hash('333333'), '203.0.113.10', NULL);
  PERFORM _otp_ok('after 61 s a new code is issued', r->>'status' = 'issued');
  PERFORM _otp_ok('the open challenge is now the new one',
    public.otp_open_challenge('password_reset', 'otp-active@test.invalid', NULL) = c2);
  PERFORM _otp_ok('the old challenge is marked superseded',
    (SELECT superseded_at IS NOT NULL AND consumed_at IS NULL FROM app_private.otp_challenges WHERE id = c1));
  PERFORM _otp_ok('the old code no longer verifies: not_found',
    public.otp_verify(c1, 'password_reset', _otp_hash('111111'), NULL)->>'status' = 'not_found');
  PERFORM _otp_ok('checking a superseded code does not count an attempt',
    (SELECT attempts FROM app_private.otp_challenges WHERE id = c1) = 0);
  PERFORM _otp_ok('exactly one open password_reset challenge for the account',
    (SELECT count(*) FROM app_private.otp_challenges
      WHERE purpose = 'password_reset' AND user_id = active
        AND consumed_at IS NULL AND superseded_at IS NULL) = 1);

  BEGIN
    INSERT INTO app_private.otp_challenges (id, purpose, user_id, email, code_hash, expires_at)
    VALUES (gen_random_uuid(), 'password_reset', active, 'otp-active@test.invalid',
            _otp_hash('x'), now() + interval '10 minutes');
  EXCEPTION WHEN unique_violation THEN
    v_dup := true;
  END;
  PERFORM _otp_ok('the index refuses a second open challenge written behind the function''s back', v_dup);

  -- hourly limit per address
  FOR i IN 1..5 LOOP
    r := public.otp_issue(gen_random_uuid(), 'password_reset', 'otp-hourly@test.invalid', NULL, NULL, NULL,
                          _otp_hash('4' || i), NULL, NULL);
    PERFORM _otp_ok(format('hourly limit: code %s of 5 is issued', i), r->>'status' = 'issued');
    PERFORM _otp_age_events('otp-hourly@test.invalid', interval '61 seconds');
  END LOOP;

  r := public.otp_issue(gen_random_uuid(), 'password_reset', 'otp-hourly@test.invalid', NULL, NULL, NULL,
                        _otp_hash('46'), NULL, NULL);
  PERFORM _otp_ok('the 6th code within an hour is refused with reason email_hourly',
    r->>'status' = 'rate_limited' AND r->>'reason' = 'email_hourly');
  -- The oldest code is 5 x 61 = 305 s old; the window reopens when it turns an hour.
  PERFORM _otp_ok('email_hourly retry_after_seconds counts down to the oldest code leaving the hour',
    (r->>'retry_after_seconds')::integer = 3600 - 305);
  PERFORM _otp_ok('the refused 6th request wrote an email_hourly event and no challenge',
    EXISTS (SELECT 1 FROM app_private.otp_send_events
             WHERE recipient_email = 'otp-hourly@test.invalid' AND outcome = 'email_hourly')
    AND (SELECT count(*) FROM app_private.otp_challenges WHERE email = 'otp-hourly@test.invalid') = 5);

  PERFORM _otp_age_events('otp-hourly@test.invalid', interval '1 hour');
  r := public.otp_issue(gen_random_uuid(), 'password_reset', 'otp-hourly@test.invalid', NULL, NULL, NULL,
                        _otp_hash('47'), NULL, NULL);
  PERFORM _otp_ok('an hour later the address may receive codes again', r->>'status' = 'issued');

  -- per-IP limit, driven by unknown addresses: no_user counts too
  FOR i IN 1..20 LOOP
    r := public.otp_issue(gen_random_uuid(), 'password_reset', format('nobody-%s@test.invalid', i),
                          NULL, NULL, NULL, _otp_hash('5'), '198.51.100.7', NULL);
    IF r->>'status' IS DISTINCT FROM 'no_user' THEN
      RAISE EXCEPTION 'FAIL: IP limit setup: request % answered %', i, r;
    END IF;
  END LOOP;
  PERFORM _otp_ok('no_user writes no challenge',
    NOT EXISTS (SELECT 1 FROM app_private.otp_challenges WHERE email LIKE 'nobody-%'));
  PERFORM _otp_ok('each no_user is recorded against the client IP',
    (SELECT count(*) FROM app_private.otp_send_events
      WHERE client_ip = '198.51.100.7'::inet AND outcome = 'no_user' AND user_id IS NULL) = 20);

  r := public.otp_issue(gen_random_uuid(), 'password_reset', 'otp-member@test.invalid', NULL, NULL, NULL,
                        _otp_hash('5'), '198.51.100.7', NULL);
  PERFORM _otp_ok('the 21st request from one IP is refused with ip_hourly, even for a real account',
    r->>'status' = 'rate_limited' AND r->>'reason' = 'ip_hourly'
    AND (r->>'retry_after_seconds')::integer BETWEEN 1 AND 3600);
  PERFORM _otp_ok('an ip_hourly refusal records nothing and issues nothing',
    (SELECT count(*) FROM app_private.otp_send_events WHERE client_ip = '198.51.100.7'::inet) = 20
    AND NOT EXISTS (SELECT 1 FROM app_private.otp_challenges WHERE email = 'otp-member@test.invalid'));

  FOR i IN 1..25 LOOP
    r := public.otp_issue(gen_random_uuid(), 'password_reset', format('nobody-noip-%s@test.invalid', i),
                          NULL, NULL, NULL, _otp_hash('6'), NULL, NULL);
    IF r->>'status' IS DISTINCT FROM 'no_user' THEN
      RAISE EXCEPTION 'FAIL: a request without a client IP was limited at %: %', i, r;
    END IF;
  END LOOP;
  PERFORM _otp_ok('without a client IP there is no IP limit (25 requests, none refused)', true);
END $$;

-- ─── 3. eligibility and the argument contract ───────────────────────────────

DO $$
DECLARE
  super   uuid := '0e000000-0000-4000-8000-000000000007';
  member  uuid := '0e000000-0000-4000-8000-000000000008';
  admin_a uuid := 'a0000000-0000-4000-8000-000000000001';
  h       text := _otp_hash('777777');
  n       integer;
  r       jsonb;
  c       uuid;
BEGIN
  -- signup_verify
  r := public.otp_issue(gen_random_uuid(), 'signup_verify', 'otp-pending@test.invalid', NULL, NULL, NULL, h, NULL, NULL);
  PERFORM _otp_ok('signup_verify: an unconfirmed pending signup is issued', r->>'status' = 'issued');
  r := public.otp_issue(gen_random_uuid(), 'signup_verify', 'otp-active@test.invalid', NULL, NULL, NULL, h, NULL, NULL);
  PERFORM _otp_ok('signup_verify: a confirmed account is ineligible, and it is recorded',
    r->>'status' = 'ineligible'
    AND EXISTS (SELECT 1 FROM app_private.otp_send_events
                 WHERE purpose = 'signup_verify' AND recipient_email = 'otp-active@test.invalid'
                   AND outcome = 'ineligible'));
  r := public.otp_issue(gen_random_uuid(), 'signup_verify', 'otp-legacy@test.invalid', NULL, NULL, NULL, h, NULL, NULL);
  PERFORM _otp_ok('signup_verify: an unconfirmed account that is no pending signup is ineligible',
    r->>'status' = 'ineligible');

  -- password_reset
  r := public.otp_issue(gen_random_uuid(), 'password_reset', 'otp-invite@test.invalid', NULL, NULL, NULL, h, NULL, NULL);
  PERFORM _otp_ok('password_reset: a confirmed pending_invite account is issued', r->>'status' = 'issued');
  r := public.otp_issue(gen_random_uuid(), 'password_reset', 'otp-legacy@test.invalid', NULL, NULL, NULL, h, NULL, NULL);
  PERFORM _otp_ok('password_reset: an unconfirmed account is ineligible', r->>'status' = 'ineligible');
  r := public.otp_issue(gen_random_uuid(), 'password_reset', 'otp-suspended@test.invalid', NULL, NULL, NULL, h, NULL, NULL);
  PERFORM _otp_ok('password_reset: a suspended profile is ineligible', r->>'status' = 'ineligible');
  r := public.otp_issue(gen_random_uuid(), 'password_reset', 'otp-banned@test.invalid', NULL, NULL, NULL, h, NULL, NULL);
  PERFORM _otp_ok('password_reset: a banned account is ineligible', r->>'status' = 'ineligible');
  r := public.otp_issue(gen_random_uuid(), 'password_reset', 'otp-deleted@test.invalid', NULL, NULL, NULL, h, NULL, NULL);
  PERFORM _otp_ok('password_reset: a soft-deleted account is ineligible', r->>'status' = 'ineligible');

  -- An auth user whose profile row never got written: the profile lookup
  -- finds nothing, and that must read as ineligible, not raise.
  INSERT INTO auth.users (id, email, email_confirmed_at, created_at)
  VALUES ('0e000000-0000-4000-8000-000000000011', 'otp-noprofile@test.invalid', now(), now() - interval '90 days');
  r := public.otp_issue(gen_random_uuid(), 'password_reset', 'otp-noprofile@test.invalid', NULL, NULL, NULL, h, NULL, NULL);
  PERFORM _otp_ok('password_reset: a confirmed account without a profile is ineligible', r->>'status' = 'ineligible');

  -- invite_activate, as manage-users sends it: no client IP, the admin as actor
  PERFORM _otp_age_events('otp-invite@test.invalid', interval '61 seconds');
  c := gen_random_uuid();
  r := public.otp_issue(c, 'invite_activate', 'otp-invite@test.invalid', NULL, NULL, NULL, h, NULL, admin_a);
  PERFORM _otp_ok('invite_activate: a confirmed pending_invite member of a company is issued',
    r->>'status' = 'issued');
  PERFORM _otp_ok('invite_activate returns the company name and the invitee''s name',
    r->>'company_name' = 'Test A' AND r->>'full_name' = 'Ina Invite');
  PERFORM _otp_ok('invite_activate records the inviting admin on the event',
    EXISTS (SELECT 1 FROM app_private.otp_send_events
             WHERE challenge_id = c AND actor_user_id = admin_a AND client_ip IS NULL));
  r := public.otp_issue(gen_random_uuid(), 'invite_activate', 'otp-active@test.invalid', NULL, NULL, NULL, h, NULL, NULL);
  PERFORM _otp_ok('invite_activate: an already active account is ineligible', r->>'status' = 'ineligible');
  r := public.otp_issue(gen_random_uuid(), 'invite_activate', 'otp-invite-nocompany@test.invalid', NULL, NULL, NULL, h, NULL, NULL);
  PERFORM _otp_ok('invite_activate: pending_invite without a company is ineligible', r->>'status' = 'ineligible');

  -- email_change
  c := gen_random_uuid();
  r := public.otp_issue(c, 'email_change', NULL, '0e000000-0000-4000-8000-000000000001',
                        ' OTP-Active-New@Test.Invalid', NULL, h, NULL, NULL);
  PERFORM _otp_ok('email_change: an active account is issued, to the new address',
    r->>'status' = 'issued' AND r->>'recipient_email' = 'otp-active-new@test.invalid');
  PERFORM _otp_ok('email_change: the challenge keeps the old address and the new one',
    (SELECT email = 'otp-active@test.invalid' AND new_email = 'otp-active-new@test.invalid'
       FROM app_private.otp_challenges WHERE id = c));
  r := public.otp_issue(gen_random_uuid(), 'email_change', NULL, '0e000000-0000-4000-8000-000000000001',
                        'OTP-Active@test.invalid', NULL, h, NULL, NULL);
  PERFORM _otp_ok('email_change: the current address, in any case, is same_email',
    r->>'status' = 'same_email'
    AND EXISTS (SELECT 1 FROM app_private.otp_send_events
                 WHERE purpose = 'email_change' AND outcome = 'same_email'));
  r := public.otp_issue(gen_random_uuid(), 'email_change', NULL, '0e000000-0000-4000-8000-000000000001',
                        'otp-taken@test.invalid', NULL, h, NULL, NULL);
  PERFORM _otp_ok('email_change: another account''s address is email_taken',
    r->>'status' = 'email_taken'
    AND EXISTS (SELECT 1 FROM app_private.otp_send_events
                 WHERE recipient_email = 'otp-taken@test.invalid' AND outcome = 'email_taken'));
  r := public.otp_issue(gen_random_uuid(), 'email_change', NULL, '0e000000-0000-4000-8000-000000000004',
                        'otp-suspended-new@test.invalid', NULL, h, NULL, NULL);
  PERFORM _otp_ok('email_change: a suspended profile is ineligible', r->>'status' = 'ineligible');

  SELECT count(*) INTO n FROM app_private.otp_send_events;
  r := public.otp_issue(gen_random_uuid(), 'email_change', NULL, gen_random_uuid(),
                        'ghost-new@test.invalid', NULL, h, NULL, NULL);
  PERFORM _otp_ok('email_change: an unknown user id is ineligible and records nothing',
    r->>'status' = 'ineligible' AND (SELECT count(*) FROM app_private.otp_send_events) = n);

  -- platform_login
  r := public.otp_issue(gen_random_uuid(), 'platform_login', NULL, super, NULL,
                        '5e000000-0000-4000-8000-000000000001', h, NULL, NULL);
  PERFORM _otp_ok('platform_login: a super admin with a live session is issued', r->>'status' = 'issued');
  r := public.otp_issue(gen_random_uuid(), 'platform_login', NULL, super, NULL, gen_random_uuid(), h, NULL, NULL);
  PERFORM _otp_ok('platform_login: a session that does not exist is ineligible', r->>'status' = 'ineligible');
  r := public.otp_issue(gen_random_uuid(), 'platform_login', NULL, super, NULL,
                        '5e000000-0000-4000-8000-000000000002', h, NULL, NULL);
  PERFORM _otp_ok('platform_login: a session past not_after is ineligible', r->>'status' = 'ineligible');
  r := public.otp_issue(gen_random_uuid(), 'platform_login', NULL, super, NULL,
                        '5e000000-0000-4000-8000-000000000003', h, NULL, NULL);
  PERFORM _otp_ok('platform_login: another user''s session is ineligible', r->>'status' = 'ineligible');
  r := public.otp_issue(gen_random_uuid(), 'platform_login', NULL, member, NULL,
                        '5e000000-0000-4000-8000-000000000003', h, NULL, NULL);
  PERFORM _otp_ok('platform_login: an account that is not a super admin is ineligible', r->>'status' = 'ineligible');

  -- a broken argument contract raises 22023 instead of returning an outcome
  PERFORM _otp_ok('otp_issue: a public purpose with a user id raises 22023',
    _otp_raises_22023(format('SELECT public.otp_issue(gen_random_uuid(), %L, %L, %L, NULL, NULL, %L, NULL, NULL)',
                             'password_reset', 'otp-active@test.invalid', super, h)));
  PERFORM _otp_ok('otp_issue: a hash that is not 64 lower-case hex characters raises 22023',
    _otp_raises_22023(format('SELECT public.otp_issue(gen_random_uuid(), %L, %L, NULL, NULL, NULL, %L, NULL, NULL)',
                             'password_reset', 'otp-active@test.invalid', upper(h))));
  PERFORM _otp_ok('otp_issue: platform_login without a session raises 22023',
    _otp_raises_22023(format('SELECT public.otp_issue(gen_random_uuid(), %L, NULL, %L, NULL, NULL, %L, NULL, NULL)',
                             'platform_login', super, h)));
  PERFORM _otp_ok('otp_issue: an actor on anything but invite_activate raises 22023',
    _otp_raises_22023(format('SELECT public.otp_issue(gen_random_uuid(), %L, %L, NULL, NULL, NULL, %L, NULL, %L)',
                             'password_reset', 'otp-active@test.invalid', h, admin_a)));
  PERFORM _otp_ok('otp_issue: an unknown purpose raises 22023',
    _otp_raises_22023(format('SELECT public.otp_issue(gen_random_uuid(), %L, %L, NULL, NULL, NULL, %L, NULL, NULL)',
                             'magic_link', 'otp-active@test.invalid', h)));
  PERFORM _otp_ok('otp_open_challenge: both an address and a user id raises 22023',
    _otp_raises_22023(format('SELECT public.otp_open_challenge(%L, %L, %L)',
                             'password_reset', 'otp-active@test.invalid', super)));
  PERFORM _otp_ok('otp_open_challenge: an authenticated purpose looked up by address raises 22023',
    _otp_raises_22023(format('SELECT public.otp_open_challenge(%L, %L, NULL)',
                             'email_change', 'otp-active@test.invalid')));
  PERFORM _otp_ok('otp_verify: platform_login without a session raises 22023',
    _otp_raises_22023(format('SELECT public.otp_verify(gen_random_uuid(), %L, %L, NULL)', 'platform_login', h)));
  PERFORM _otp_ok('otp_verify: a session on another purpose raises 22023',
    _otp_raises_22023(format('SELECT public.otp_verify(gen_random_uuid(), %L, %L, %L)',
                             'password_reset', h, gen_random_uuid())));
END $$;

-- ─── 4. verifying ───────────────────────────────────────────────────────────

DO $$
DECLARE
  verify_u uuid := '0e000000-0000-4000-8000-00000000000c';
  change_u uuid := '0e000000-0000-4000-8000-00000000000d';
  good     text := _otp_hash('123456');
  bad      text := _otp_hash('654321');
  c        uuid;
  r        jsonb;
  i        integer;
BEGIN
  c := gen_random_uuid();
  r := public.otp_issue(c, 'password_reset', 'otp-verify@test.invalid', NULL, NULL, NULL, good, NULL, NULL);
  PERFORM _otp_ok('verify setup: a code is issued', r->>'status' = 'issued');
  PERFORM _otp_ok('otp_open_challenge finds it by the typed address, whatever its case and spacing',
    public.otp_open_challenge('password_reset', ' OTP-Verify@Test.Invalid', NULL) = c);
  PERFORM _otp_ok('the same challenge under another purpose is not_found',
    public.otp_verify(c, 'invite_activate', good, NULL)->>'status' = 'not_found');

  FOR i IN 1..4 LOOP
    r := public.otp_verify(c, 'password_reset', bad, NULL);
    PERFORM _otp_ok(format('wrong code %s: attempts_left %s', i, 5 - i),
      r->>'status' = 'wrong' AND (r->>'attempts_left')::integer = 5 - i);
  END LOOP;
  r := public.otp_verify(c, 'password_reset', bad, NULL);
  PERFORM _otp_ok('the 5th wrong code locks the challenge', r->>'status' = 'locked');
  r := public.otp_verify(c, 'password_reset', good, NULL);
  PERFORM _otp_ok('the correct code after the lock is still locked', r->>'status' = 'locked');
  PERFORM _otp_ok('attempts stop at 5 and a locked challenge is never consumed',
    (SELECT attempts = 5 AND consumed_at IS NULL FROM app_private.otp_challenges WHERE id = c));

  -- expired
  PERFORM _otp_age_events('otp-verify@test.invalid', interval '61 seconds');
  c := gen_random_uuid();
  r := public.otp_issue(c, 'password_reset', 'otp-verify@test.invalid', NULL, NULL, NULL, good, NULL, NULL);
  PERFORM _otp_ok('a new code replaces the locked one', r->>'status' = 'issued');
  UPDATE app_private.otp_challenges
     SET created_at = created_at - interval '11 minutes', expires_at = expires_at - interval '11 minutes'
   WHERE id = c;
  r := public.otp_verify(c, 'password_reset', good, NULL);
  PERFORM _otp_ok('a code past expires_at is expired, even when correct', r->>'status' = 'expired');
  PERFORM _otp_ok('an expired check counts no attempt',
    (SELECT attempts FROM app_private.otp_challenges WHERE id = c) = 0);

  -- ok, then replay
  PERFORM _otp_age_events('otp-verify@test.invalid', interval '61 seconds');
  c := gen_random_uuid();
  r := public.otp_issue(c, 'password_reset', 'otp-verify@test.invalid', NULL, NULL, NULL, good, NULL, NULL);
  PERFORM _otp_ok('a third code is issued', r->>'status' = 'issued');
  r := public.otp_verify(c, 'password_reset', bad, NULL);
  r := public.otp_verify(c, 'password_reset', good, NULL);
  PERFORM _otp_ok('the correct code is ok and names the account',
    r->>'status' = 'ok' AND r->>'purpose' = 'password_reset'
    AND (r->>'user_id')::uuid = verify_u AND r->>'email' = 'otp-verify@test.invalid'
    AND jsonb_typeof(r->'new_email') = 'null' AND jsonb_typeof(r->'platform_verified_until') = 'null');
  PERFORM _otp_ok('the verified challenge is consumed, with the wrong attempt before it counted',
    (SELECT consumed_at IS NOT NULL AND superseded_at IS NULL AND attempts = 2
       FROM app_private.otp_challenges WHERE id = c));
  PERFORM _otp_ok('replaying a used code is not_found',
    public.otp_verify(c, 'password_reset', good, NULL)->>'status' = 'not_found');
  PERFORM _otp_ok('a used code is no longer open',
    public.otp_open_challenge('password_reset', 'otp-verify@test.invalid', NULL) IS NULL);

  -- email_change: the address is taken between the send and the verify
  c := gen_random_uuid();
  r := public.otp_issue(c, 'email_change', NULL, change_u, 'otp-change-new@test.invalid', NULL, good, NULL, NULL);
  PERFORM _otp_ok('email_change verify setup: a code is issued', r->>'status' = 'issued');
  PERFORM _otp_ok('an email_change challenge is found by user id',
    public.otp_open_challenge('email_change', NULL, change_u) = c);
  INSERT INTO auth.users (id, email, email_confirmed_at, created_at)
  VALUES ('0e000000-0000-4000-8000-00000000001d', 'otp-change-new@test.invalid', now(), now());
  r := public.otp_verify(c, 'email_change', good, NULL);
  PERFORM _otp_ok('a correct code for an address taken in the meantime is email_taken',
    r->>'status' = 'email_taken');
  PERFORM _otp_ok('and that challenge is closed, not consumed',
    (SELECT superseded_at IS NOT NULL AND consumed_at IS NULL FROM app_private.otp_challenges WHERE id = c));

  c := gen_random_uuid();
  r := public.otp_issue(c, 'email_change', NULL, change_u, 'OTP-Change-New2@Test.Invalid', NULL, good, NULL, NULL);
  r := public.otp_verify(c, 'email_change', good, NULL);
  PERFORM _otp_ok('email_change ok returns the old address and the new one',
    r->>'status' = 'ok' AND r->>'purpose' = 'email_change'
    AND r->>'email' = 'otp-change@test.invalid' AND r->>'new_email' = 'otp-change-new2@test.invalid');
END $$;

-- ─── 5. platform login ──────────────────────────────────────────────────────

DO $$
DECLARE
  super  uuid := '0e000000-0000-4000-8000-000000000007';
  member uuid := '0e000000-0000-4000-8000-000000000008';
  s1     uuid := '5e000000-0000-4000-8000-000000000001';
  s4     uuid := '5e000000-0000-4000-8000-000000000004';
  s5     uuid := '5e000000-0000-4000-8000-000000000005';
  h      text := _otp_hash('246810');
  c      uuid;
  c2     uuid;
  r      jsonb;
  v      record;
BEGIN
  PERFORM _otp_age_events('otp-super@test.invalid', interval '61 seconds');
  c := gen_random_uuid();
  r := public.otp_issue(c, 'platform_login', NULL, super, NULL, s1, h, NULL, NULL);
  PERFORM _otp_ok('platform setup: a code is issued for session 1', r->>'status' = 'issued');

  r := public.otp_verify(c, 'platform_login', h, s4);
  PERFORM _otp_ok('the right code from another live session of the same admin is not_found',
    r->>'status' = 'not_found');
  PERFORM _otp_ok('a session mismatch counts no attempt',
    (SELECT attempts FROM app_private.otp_challenges WHERE id = c) = 0);

  r := public.otp_verify(c, 'platform_login', h, s1);
  PERFORM _otp_ok('the right code from its own session is ok', r->>'status' = 'ok');
  PERFORM _otp_ok('platform_verified_until is twelve hours out',
    abs(extract(epoch FROM (r->>'platform_verified_until')::timestamptz - (now() + interval '12 hours'))) < 1);

  SELECT * INTO v FROM app_private.platform_login_verifications WHERE session_id = s1;
  PERFORM _otp_ok('a verification row is written for that session, user and challenge',
    v.user_id = super AND v.challenge_id = c
    AND abs(extract(epoch FROM v.expires_at - (now() + interval '12 hours'))) < 1);

  PERFORM _otp_ok('platform_login_verified is true for the verified session',
    app_private.platform_login_verified(super, s1));
  PERFORM _otp_ok('platform_login_verified is false for another session of the same admin',
    NOT app_private.platform_login_verified(super, s4));
  PERFORM _otp_ok('platform_login_verified is false for another user on that session',
    NOT app_private.platform_login_verified(member, s1));
  PERFORM _otp_ok('platform_login_verified is false, not an error, on NULL arguments',
    NOT app_private.platform_login_verified(super, NULL) AND NOT app_private.platform_login_verified(NULL, s1));

  -- a second verification of the same session replaces the row
  PERFORM _otp_age_events('otp-super@test.invalid', interval '61 seconds');
  c2 := gen_random_uuid();
  r := public.otp_issue(c2, 'platform_login', NULL, super, NULL, s1, h, NULL, NULL);
  r := public.otp_verify(c2, 'platform_login', h, s1);
  PERFORM _otp_ok('verifying the same session again updates its single row',
    r->>'status' = 'ok'
    AND (SELECT count(*) FROM app_private.platform_login_verifications WHERE session_id = s1) = 1
    AND (SELECT challenge_id FROM app_private.platform_login_verifications WHERE session_id = s1) = c2);

  -- the session ends between the send and the verify
  PERFORM _otp_age_events('otp-super@test.invalid', interval '61 seconds');
  c := gen_random_uuid();
  r := public.otp_issue(c, 'platform_login', NULL, super, NULL, s4, h, NULL, NULL);
  PERFORM _otp_ok('a code is issued for session 4', r->>'status' = 'issued');
  DELETE FROM auth.sessions WHERE id = s4;
  r := public.otp_verify(c, 'platform_login', h, s4);
  PERFORM _otp_ok('a code whose session is gone is session_invalid', r->>'status' = 'session_invalid');
  PERFORM _otp_ok('session_invalid counts no attempt and consumes nothing',
    (SELECT attempts = 0 AND consumed_at IS NULL FROM app_private.otp_challenges WHERE id = c));

  -- signing out ends the verification
  DELETE FROM auth.sessions WHERE id = s1;
  PERFORM _otp_ok('platform_login_verified is false once the session is deleted',
    NOT app_private.platform_login_verified(super, s1));

  -- expiry, of the verification and of the session
  INSERT INTO app_private.platform_login_verifications (session_id, user_id, challenge_id, verified_at, expires_at)
  VALUES (s5, super, gen_random_uuid(), now() - interval '13 hours', now() - interval '1 hour');
  PERFORM _otp_ok('platform_login_verified is false after the verification expired',
    NOT app_private.platform_login_verified(super, s5));
  UPDATE app_private.platform_login_verifications SET expires_at = now() + interval '1 hour' WHERE session_id = s5;
  PERFORM _otp_ok('(control) the same row inside its validity is true',
    app_private.platform_login_verified(super, s5));
  UPDATE auth.sessions SET not_after = now() - interval '1 second' WHERE id = s5;
  PERFORM _otp_ok('platform_login_verified is false once the session is past not_after',
    NOT app_private.platform_login_verified(super, s5));
END $$;

-- ─── 6. failed sends ────────────────────────────────────────────────────────

DO $$
DECLARE
  c uuid := gen_random_uuid();
  r jsonb;
BEGIN
  r := public.otp_issue(c, 'password_reset', 'otp-sendfail@test.invalid', NULL, NULL, NULL,
                        _otp_hash('1'), '192.0.2.44', NULL);
  PERFORM _otp_ok('send-failure setup: a code is issued', r->>'status' = 'issued');

  PERFORM public.otp_mark_send_failed(c);
  PERFORM _otp_ok('a failed send closes its challenge',
    (SELECT superseded_at IS NOT NULL FROM app_private.otp_challenges WHERE id = c));
  PERFORM _otp_ok('a failed send turns its issued event into send_failed',
    (SELECT outcome FROM app_private.otp_send_events WHERE challenge_id = c) = 'send_failed');

  r := public.otp_issue(gen_random_uuid(), 'password_reset', 'otp-sendfail@test.invalid', NULL, NULL, NULL,
                        _otp_hash('2'), '192.0.2.44', NULL);
  PERFORM _otp_ok('an immediate retry after a failed send is issued, not held by the cooldown',
    r->>'status' = 'issued');
  PERFORM _otp_ok('the failed send still counts toward the IP limit',
    (SELECT count(*) FROM app_private.otp_send_events WHERE client_ip = '192.0.2.44'::inet) = 2);

  PERFORM public.otp_mark_send_failed(gen_random_uuid());
  PERFORM _otp_ok('marking an unknown challenge is a no-op, not an error', true);
END $$;

-- ─── 7. user_profiles.email follows auth.users.email ────────────────────────

DO $$
DECLARE
  sync_u uuid := '0e000000-0000-4000-8000-00000000000f';
BEGIN
  -- In production GoTrue's own role makes this update, and it holds no grant
  -- on user_profiles; running as it proves the trigger works as its owner.
  IF has_table_privilege('supabase_auth_admin', 'auth.users', 'UPDATE') THEN
    EXECUTE 'SET LOCAL ROLE supabase_auth_admin';
  ELSE
    RAISE NOTICE 'note: supabase_auth_admin cannot UPDATE auth.users here; updating as supabase_admin';
  END IF;
  UPDATE auth.users SET email = 'otp-sync-new@test.invalid' WHERE id = sync_u;
  RESET ROLE;
  PERFORM _otp_ok('changing auth.users.email updates user_profiles.email',
    (SELECT email FROM user_profiles WHERE user_id = sync_u) = 'otp-sync-new@test.invalid');

  UPDATE user_profiles SET email = 'drifted@test.invalid' WHERE user_id = sync_u;
  UPDATE auth.users SET email = email WHERE id = sync_u;
  PERFORM _otp_ok('an update that leaves the address unchanged does not touch the profile',
    (SELECT email FROM user_profiles WHERE user_id = sync_u) = 'drifted@test.invalid');

  UPDATE auth.users SET email = NULL WHERE id = sync_u;
  PERFORM _otp_ok('an account losing its address keeps the last one on the profile',
    (SELECT email FROM user_profiles WHERE user_id = sync_u) = 'drifted@test.invalid');
END $$;

-- ─── 8a. signup_create_company ──────────────────────────────────────────────

DO $$
DECLARE
  owner     uuid := '0e000000-0000-4000-8000-000000000020';
  owner2    uuid := '0e000000-0000-4000-8000-000000000021';
  owner3    uuid := '0e000000-0000-4000-8000-000000000022';
  owner4    uuid := '0e000000-0000-4000-8000-000000000023';
  sys_admin uuid := '84626035-c3a2-4ff5-96b9-a95cceb85cb0';   -- roles-seed.sql
  ref_on    uuid;
  co        uuid;
  r         jsonb;
  comp      record;
  prof      record;
  n_before  bigint;
BEGIN
  -- As company-signup leaves them after createUser: unconfirmed. owner gets
  -- the profile handle_new_user writes in production; owner2 gets none, to
  -- cover the insert branch of the upsert.
  INSERT INTO auth.users (id, email, created_at) VALUES
    (owner,  'otp-owner@test.invalid',  now()),
    (owner2, 'otp-owner2@test.invalid', now()),
    (owner3, 'otp-owner3@test.invalid', now()),
    (owner4, 'otp-owner4@test.invalid', now());
  INSERT INTO user_profiles (user_id, email, full_name, role, status, invited_at)
  VALUES (owner, 'otp-owner@test.invalid', '', 'viewer', 'pending_invite', now());

  INSERT INTO referrals (ref_code, name, is_active) VALUES
    ('OTP-OFF', 'Inactive referral', false),
    ('OTP-ON',  'Active referral',   true);
  SELECT id INTO ref_on FROM referrals WHERE ref_code = 'OTP-ON';

  SELECT (SELECT count(*) FROM companies) + (SELECT count(*) FROM company_settings)
       + (SELECT count(*) FROM app_private.pending_signups) INTO n_before;

  r := public.signup_create_company(owner, 'otp-owner@test.invalid', 'Olga Owner', 'Müller & Söhne GmbH',
                                    'basic', 'monthly', 3, 'no-such-code', NULL);
  PERFORM _otp_ok('an unknown referral code returns referral_invalid',
    r->>'ok' = 'false' AND r->>'reason' = 'referral_invalid');
  r := public.signup_create_company(owner, 'otp-owner@test.invalid', 'Olga Owner', 'Müller & Söhne GmbH',
                                    'basic', 'monthly', 3, ' otp-off ', NULL);
  PERFORM _otp_ok('an inactive referral code returns referral_inactive',
    r->>'ok' = 'false' AND r->>'reason' = 'referral_inactive');
  PERFORM _otp_ok('a refused referral writes nothing at all',
    (SELECT count(*) FROM companies) + (SELECT count(*) FROM company_settings)
      + (SELECT count(*) FROM app_private.pending_signups) = n_before
    AND (SELECT company_id FROM user_profiles WHERE user_id = owner) IS NULL);

  PERFORM _otp_ok('a confirmed account raises 22023',
    _otp_raises_22023(format('SELECT public.signup_create_company(%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL)',
                             '0e000000-0000-4000-8000-000000000001', 'otp-active@test.invalid', 'X', 'X GmbH')));
  PERFORM _otp_ok('an address that is not the account''s raises 22023',
    _otp_raises_22023(format('SELECT public.signup_create_company(%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL)',
                             owner, 'someone-else@test.invalid', 'X', 'X GmbH')));
  PERFORM _otp_ok('a blank company name raises 22023',
    _otp_raises_22023(format('SELECT public.signup_create_company(%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL)',
                             owner, 'otp-owner@test.invalid', 'X', '   ')));

  r := public.signup_create_company(owner, ' OTP-Owner@Test.Invalid ', ' Olga Owner ', ' Müller & Söhne GmbH ',
                                    'platinum', 'weekly', 0, ' otp-on ', ' spring10 ');
  PERFORM _otp_ok('a valid signup returns ok with the company', r->>'ok' = 'true' AND r->'company' ? 'id');
  co := (r->'company'->>'id')::uuid;
  SELECT * INTO comp FROM companies WHERE id = co;

  PERFORM _otp_ok('the slug is company-signup''s transliteration',
    comp.slug = 'mueller-soehne-gmbh' AND r->'company'->>'slug' = comp.slug);
  PERFORM _otp_ok('the company is a pending, inactive trial in Deutschland, named without the padding',
    comp.name = 'Müller & Söhne GmbH' AND comp.status = 'trial' AND comp.approval_status = 'pending'
    AND comp.subscription_status = 'inactive' AND comp.country = 'Deutschland'
    AND r->'company'->>'approval_status' = 'pending' AND r->'company'->>'name' = comp.name);
  PERFORM _otp_ok('the trial runs 14 days from now',
    comp.trial_start = now() AND comp.trial_end = now() + interval '14 days'
    AND (r->'company'->>'trial_end')::timestamptz = comp.trial_end);
  PERFORM _otp_ok('an unknown plan becomes basic, an unknown cycle monthly, and car limit 0 becomes 3',
    comp.plan = 'basic' AND comp.billing_cycle = 'monthly' AND comp.subscription_car_limit = 3);
  PERFORM _otp_ok('the referral is recorded under its upper-cased code',
    comp.referral_id = ref_on AND comp.referral_code_used = 'OTP-ON' AND comp.referred_at IS NOT NULL);

  SELECT * INTO prof FROM user_profiles WHERE user_id = owner;
  PERFORM _otp_ok('the owner becomes the company admin, with the system admin role_id',
    prof.role = 'admin' AND prof.role_id = sys_admin AND prof.company_id = co AND NOT prof.is_super_admin);
  PERFORM _otp_ok('the owner stays pending_invite, with the account''s address and the trimmed name',
    prof.status = 'pending_invite' AND prof.email = 'otp-owner@test.invalid' AND prof.full_name = 'Olga Owner');
  PERFORM _otp_ok('company_settings is created with the company name',
    EXISTS (SELECT 1 FROM company_settings WHERE company_id = co AND company_name = 'Müller & Söhne GmbH'));
  PERFORM _otp_ok('the pending signup keeps the discount code upper-cased, and nothing is redeemed yet',
    (SELECT discount_code FROM app_private.pending_signups WHERE user_id = owner AND company_id = co) = 'SPRING10'
    AND NOT EXISTS (SELECT 1 FROM discount_code_redemptions WHERE company_id = co));
  PERFORM _otp_ok('a signup_verify code can now be issued to the owner',
    public.otp_issue(gen_random_uuid(), 'signup_verify', 'otp-owner@test.invalid', NULL, NULL, NULL,
                     _otp_hash('9'), NULL, NULL)->>'status' = 'issued');
  PERFORM _otp_ok('a second signup_create_company for the same account raises 22023',
    _otp_raises_22023(format('SELECT public.signup_create_company(%L, %L, %L, %L, NULL, NULL, NULL, NULL, NULL)',
                             owner, 'otp-owner@test.invalid', 'Olga', 'Noch eine GmbH')));

  r := public.signup_create_company(owner2, 'otp-owner2@test.invalid', 'Otto Zwei', 'MÜLLER & SÖHNE GMBH',
                                    'premium', 'yearly', 500, NULL, '  ');
  SELECT * INTO comp FROM companies WHERE id = (r->'company'->>'id')::uuid;
  PERFORM _otp_ok('a name whose slug is taken gets a six-hex-digit suffix',
    comp.slug ~ '^mueller-soehne-gmbh-[0-9a-f]{6}$');
  PERFORM _otp_ok('premium and yearly are kept, and 500 cars clamp to 100',
    comp.plan = 'premium' AND comp.billing_cycle = 'yearly' AND comp.subscription_car_limit = 100);
  PERFORM _otp_ok('no referral and a blank discount code store nothing',
    comp.referral_id IS NULL AND comp.referral_code_used IS NULL AND comp.referred_at IS NULL
    AND (SELECT discount_code FROM app_private.pending_signups WHERE user_id = owner2) IS NULL);
  PERFORM _otp_ok('a profile is inserted when none existed',
    EXISTS (SELECT 1 FROM user_profiles
             WHERE user_id = owner2 AND company_id = comp.id AND role = 'admin' AND status = 'pending_invite'));

  r := public.signup_create_company(owner3, 'otp-owner3@test.invalid', 'Drei', 'Drei GmbH', 'advanced', 'monthly', -5, NULL, NULL);
  PERFORM _otp_ok('a negative car limit clamps to 1',
    (SELECT subscription_car_limit FROM companies WHERE id = (r->'company'->>'id')::uuid) = 1);
  r := public.signup_create_company(owner4, 'otp-owner4@test.invalid', 'Vier', 'Vier GmbH', NULL, NULL, NULL, NULL, NULL);
  PERFORM _otp_ok('no car limit at all becomes 3, no plan basic, no cycle monthly',
    (SELECT subscription_car_limit = 3 AND plan = 'basic' AND billing_cycle = 'monthly'
       FROM companies WHERE id = (r->'company'->>'id')::uuid));
END $$;

-- ─── 8b. signup_complete ────────────────────────────────────────────────────

DO $$
DECLARE
  owner  uuid := '0e000000-0000-4000-8000-000000000020';
  owner2 uuid := '0e000000-0000-4000-8000-000000000021';
  co     uuid;
  dc     uuid;
  r      jsonb;
  prof   record;
BEGIN
  SELECT company_id INTO co FROM app_private.pending_signups WHERE user_id = owner;
  INSERT INTO discount_codes (code, discount_type, discount_value, usage_mode, audience_type, max_redemptions)
  VALUES ('SPRING10', 'percentage', 10, 'once', 'multiple', 5)
  RETURNING id INTO dc;

  PERFORM _otp_ok('signup_complete before the address is confirmed raises 22023',
    _otp_raises_22023(format('SELECT public.signup_complete(%L)', owner)));

  UPDATE auth.users SET email_confirmed_at = now() WHERE id = owner;
  r := public.signup_complete(owner);
  PERFORM _otp_ok('signup_complete returns ok with the company', r->>'ok' = 'true' AND (r->>'company_id')::uuid = co);
  PERFORM _otp_ok('the stored discount code is redeemed through redeem_discount_code',
    r->'discount'->>'success' = 'true' AND (r->'discount'->>'discount_code_id')::uuid = dc);

  SELECT * INTO prof FROM user_profiles WHERE user_id = owner;
  PERFORM _otp_ok('the owner becomes active, with activated_at', prof.status = 'active' AND prof.activated_at IS NOT NULL);
  PERFORM _otp_ok('exactly one redemption is recorded and counted',
    (SELECT count(*) FROM discount_code_redemptions WHERE company_id = co) = 1
    AND (SELECT used_count FROM discount_codes WHERE id = dc) = 1
    AND (SELECT active_discount_code_id FROM companies WHERE id = co) = dc);
  PERFORM _otp_ok('the pending row is gone', NOT EXISTS (SELECT 1 FROM app_private.pending_signups WHERE user_id = owner));

  r := public.signup_complete(owner);
  PERFORM _otp_ok('a second call is already_completed, with no discount',
    r->>'ok' = 'true' AND r->>'already_completed' = 'true' AND jsonb_typeof(r->'discount') = 'null');
  PERFORM _otp_ok('and redeems nothing a second time',
    (SELECT count(*) FROM discount_code_redemptions WHERE company_id = co) = 1
    AND (SELECT used_count FROM discount_codes WHERE id = dc) = 1);

  PERFORM _otp_age_events('otp-owner@test.invalid', interval '61 seconds');
  PERFORM _otp_ok('the confirmed, active owner can now reset a password',
    public.otp_issue(gen_random_uuid(), 'password_reset', 'otp-owner@test.invalid', NULL, NULL, NULL,
                     _otp_hash('10'), NULL, NULL)->>'status' = 'issued');

  UPDATE auth.users SET email_confirmed_at = now() WHERE id = owner2;
  r := public.signup_complete(owner2);
  PERFORM _otp_ok('a signup without a discount code completes with discount null',
    r->>'ok' = 'true' AND jsonb_typeof(r->'discount') = 'null'
    AND (SELECT status FROM user_profiles WHERE user_id = owner2) = 'active');
END $$;

-- ─── 8c. discard and purge ──────────────────────────────────────────────────

DO $$
DECLARE
  owner   uuid := '0e000000-0000-4000-8000-000000000020';
  legacy  uuid := '0e000000-0000-4000-8000-000000000009';
  p_old   uuid := '0e000000-0000-4000-8000-000000000030';
  p_new   uuid := '0e000000-0000-4000-8000-000000000031';
  squat   uuid := '0e000000-0000-4000-8000-000000000032';
  fresh   uuid := '0e000000-0000-4000-8000-000000000033';
  p_conf  uuid := '0e000000-0000-4000-8000-000000000034';
  c       uuid := gen_random_uuid();
  co      uuid;
  co_old  uuid;
  co_new  uuid;
  co_conf uuid;
  r       jsonb;
  n       integer;
  v_ok    boolean;
BEGIN
  /*
    Every discard below is called in its own statement and checked in the
    next. Rows a function deletes are still visible to the rest of the
    statement that called it — that statement's snapshot predates the call —
    so "call AND NOT EXISTS" in one expression can never pass, and
    "NOT call AND EXISTS" passes even when the call deleted everything.
  */
  SELECT company_id INTO co FROM user_profiles WHERE user_id = owner;
  v_ok := public.signup_discard(owner);
  PERFORM _otp_ok('signup_discard refuses a confirmed owner and deletes nothing',
    NOT v_ok
    AND EXISTS (SELECT 1 FROM auth.users WHERE id = owner) AND EXISTS (SELECT 1 FROM companies WHERE id = co));
  v_ok := public.signup_discard(legacy);
  PERFORM _otp_ok('signup_discard refuses an unconfirmed company-less account older than an hour',
    NOT v_ok
    AND EXISTS (SELECT 1 FROM auth.users WHERE id = legacy) AND EXISTS (SELECT 1 FROM user_profiles WHERE user_id = legacy));
  PERFORM _otp_ok('signup_discard of an unknown user returns false', NOT public.signup_discard(gen_random_uuid()));

  -- an unconfirmed signup squatting an address, with an open code
  INSERT INTO auth.users (id, email, created_at) VALUES (squat, 'otp-squat@test.invalid', now());
  r := public.signup_create_company(squat, 'otp-squat@test.invalid', 'Sam Squat', 'Squat GmbH', NULL, NULL, NULL, NULL, NULL);
  co := (r->'company'->>'id')::uuid;
  r := public.otp_issue(c, 'signup_verify', 'otp-squat@test.invalid', NULL, NULL, NULL, _otp_hash('8'), NULL, NULL);
  PERFORM _otp_ok('squat setup: the pending signup holds an open code', r->>'status' = 'issued');

  v_ok := public.signup_discard_unverified('OTP-Active@test.invalid');
  PERFORM _otp_ok('signup_discard_unverified leaves a confirmed account alone',
    NOT v_ok AND EXISTS (SELECT 1 FROM auth.users WHERE id = '0e000000-0000-4000-8000-000000000001'));
  v_ok := public.signup_discard_unverified('otp-legacy@test.invalid');
  PERFORM _otp_ok('signup_discard_unverified leaves a legacy unconfirmed account alone',
    NOT v_ok AND EXISTS (SELECT 1 FROM auth.users WHERE id = legacy));
  v_ok := public.signup_discard_unverified(' OTP-Squat@Test.Invalid ');
  PERFORM _otp_ok('signup_discard_unverified removes the pending signup for that address', v_ok);
  PERFORM _otp_ok('its account, company, profile, settings, pending row and code are all gone',
    NOT EXISTS (SELECT 1 FROM auth.users WHERE id = squat)
    AND NOT EXISTS (SELECT 1 FROM companies WHERE id = co)
    AND NOT EXISTS (SELECT 1 FROM user_profiles WHERE user_id = squat)
    AND NOT EXISTS (SELECT 1 FROM company_settings WHERE company_id = co)
    AND NOT EXISTS (SELECT 1 FROM app_private.pending_signups WHERE user_id = squat)
    AND NOT EXISTS (SELECT 1 FROM app_private.otp_challenges WHERE id = c));
  PERFORM _otp_ok('the discarded signup''s code no longer verifies',
    public.otp_verify(c, 'signup_verify', _otp_hash('8'), NULL)->>'status' = 'not_found');

  -- company-signup compensating: createUser worked, signup_create_company did not
  INSERT INTO auth.users (id, email, created_at) VALUES (fresh, 'otp-fresh@test.invalid', now() - interval '5 minutes');
  INSERT INTO user_profiles (user_id, email, full_name, role, status)
  VALUES (fresh, 'otp-fresh@test.invalid', '', 'viewer', 'pending_invite');
  v_ok := public.signup_discard(fresh);
  PERFORM _otp_ok('signup_discard removes a company-less account created minutes ago',
    v_ok
    AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = fresh)
    AND NOT EXISTS (SELECT 1 FROM user_profiles WHERE user_id = fresh));

  -- the 24-hour purge
  INSERT INTO auth.users (id, email, created_at) VALUES
    (p_old,  'otp-purge-old@test.invalid',  now() - interval '25 hours'),
    (p_new,  'otp-purge-new@test.invalid',  now()),
    (p_conf, 'otp-purge-conf@test.invalid', now() - interval '25 hours');
  co_old  := (public.signup_create_company(p_old,  'otp-purge-old@test.invalid',  'Alt',  'Alt GmbH',  NULL, NULL, NULL, NULL, NULL)->'company'->>'id')::uuid;
  co_new  := (public.signup_create_company(p_new,  'otp-purge-new@test.invalid',  'Neu',  'Neu GmbH',  NULL, NULL, NULL, NULL, NULL)->'company'->>'id')::uuid;
  co_conf := (public.signup_create_company(p_conf, 'otp-purge-conf@test.invalid', 'Fest', 'Fest GmbH', NULL, NULL, NULL, NULL, NULL)->'company'->>'id')::uuid;
  UPDATE app_private.pending_signups SET created_at = now() - interval '25 hours' WHERE user_id IN (p_old, p_conf);
  -- p_conf entered its code but completion failed: confirmed, pending row left behind
  UPDATE auth.users SET email_confirmed_at = now() WHERE id = p_conf;

  PERFORM _otp_ok('purge_unverified_signups refuses a window under an hour',
    _otp_raises_22023('SELECT public.purge_unverified_signups(interval ''10 minutes'')'));

  n := public.purge_unverified_signups();
  PERFORM _otp_ok('purge_unverified_signups removes exactly the one stale unconfirmed signup', n = 1);
  PERFORM _otp_ok('the stale signup and its company are gone',
    NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_old) AND NOT EXISTS (SELECT 1 FROM companies WHERE id = co_old));
  PERFORM _otp_ok('a fresh pending signup is kept',
    EXISTS (SELECT 1 FROM auth.users WHERE id = p_new) AND EXISTS (SELECT 1 FROM companies WHERE id = co_new));
  PERFORM _otp_ok('a confirmed account with a stale pending row is kept',
    EXISTS (SELECT 1 FROM auth.users WHERE id = p_conf) AND EXISTS (SELECT 1 FROM companies WHERE id = co_conf));
  PERFORM _otp_ok('the legacy unconfirmed account, never a pending signup, is kept',
    EXISTS (SELECT 1 FROM auth.users WHERE id = legacy) AND EXISTS (SELECT 1 FROM user_profiles WHERE user_id = legacy));
  PERFORM _otp_ok('the other tenants are untouched',
    EXISTS (SELECT 1 FROM companies WHERE id = 'c0000000-0000-4000-8000-00000000000a')
    AND EXISTS (SELECT 1 FROM companies WHERE id = 'c0000000-0000-4000-8000-0000000000e1'));
END $$;

-- ─── 9. otp_purge ───────────────────────────────────────────────────────────

DO $$
DECLARE
  r     jsonb;
  e_ch  bigint;
  e_ev  bigint;
  e_ver bigint;
BEGIN
  UPDATE app_private.otp_challenges
     SET created_at = created_at - interval '25 hours', expires_at = expires_at - interval '25 hours'
   WHERE email = 'otp-hourly@test.invalid';
  PERFORM _otp_age_events('otp-hourly@test.invalid', interval '25 hours');
  INSERT INTO app_private.platform_login_verifications (session_id, user_id, challenge_id, verified_at, expires_at)
  VALUES (gen_random_uuid(), '0e000000-0000-4000-8000-000000000007', gen_random_uuid(),
          now() - interval '40 hours', now() - interval '28 hours');

  SELECT count(*) INTO e_ch  FROM app_private.otp_challenges               WHERE created_at < now() - interval '24 hours';
  SELECT count(*) INTO e_ev  FROM app_private.otp_send_events              WHERE created_at < now() - interval '24 hours';
  SELECT count(*) INTO e_ver FROM app_private.platform_login_verifications WHERE expires_at < now() - interval '24 hours';
  PERFORM _otp_ok('purge setup: all three tables hold rows older than 24 h', e_ch > 0 AND e_ev > 0 AND e_ver > 0);

  PERFORM _otp_ok('otp_purge refuses a window under an hour',
    _otp_raises_22023('SELECT public.otp_purge(interval ''30 minutes'')'));

  r := public.otp_purge();
  PERFORM _otp_ok('otp_purge deletes and reports exactly the rows older than 24 h',
    (r->>'challenges')::bigint = e_ch AND (r->>'events')::bigint = e_ev AND (r->>'verifications')::bigint = e_ver);
  PERFORM _otp_ok('nothing older than 24 h is left',
    NOT EXISTS (SELECT 1 FROM app_private.otp_challenges WHERE created_at < now() - interval '24 hours')
    AND NOT EXISTS (SELECT 1 FROM app_private.otp_send_events WHERE created_at < now() - interval '24 hours')
    AND NOT EXISTS (SELECT 1 FROM app_private.platform_login_verifications WHERE expires_at < now() - interval '24 hours'));
  PERFORM _otp_ok('younger rows are kept',
    EXISTS (SELECT 1 FROM app_private.otp_challenges)
    AND EXISTS (SELECT 1 FROM app_private.otp_send_events)
    AND EXISTS (SELECT 1 FROM app_private.platform_login_verifications));

  RAISE NOTICE '── all OTP and signup assertions passed ──';
END $$;

-- Everything above was test data; the next test file starts from the seeds.
ROLLBACK;
