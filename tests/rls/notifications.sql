/*
  The notification job's table and its three service-role functions
  (migration 20260924100000).

  Runs after the files before it, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it
  see the database as the seeds left it.

  What is covered, in order:

    1. shape      the table carries RLS and exactly one policy, the business
                  SELECT shape; no client may write it, and it carries neither
                  of the two support-session triggers because nothing but the
                  job writes it; the three functions are SECURITY DEFINER with
                  a pinned search_path and EXECUTE for service_role alone —
                  anon in particular, which Supabase grants by default
    2. tenants    a member reads its own company's rows and never another
                  company's; nobody writes, so a move between companies is
                  refused for having no UPDATE policy at all
    3. blocked    a suspended company's administrator reads nothing, and the
                  candidate query does not offer that company to the job
    4. platform   a platform account reads nothing outside a context, reads the
                  opened company's rows inside one, and writes neither way
    5. dedupe     the unique constraint is the rule: a second claim for the
                  same occurrence answers NULL, a new expiry date is a new
                  occurrence, and the two TÜV types are separate occurrences
    6. claim      the boundary is checked again at claim time: a blocked
                  company, a target that is not the company's, a bad type and
                  a bad period key are all refused
    7. settle     an outcome is recorded once and never overwritten
    8. candidates the query's own boundary — approved and not suspended — and
                  the deliberate absence of a subscription term, which is what
                  lets trial_abgelaufen reach the company it is about

  The matrix lines for the table are in tests/rls/matrix.sql.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in trip-analysis-settings.sql) ────────────────────────

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

CREATE OR REPLACE FUNCTION _nt_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _nt_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('nt:' || p_what)::uuid $$;

CREATE OR REPLACE FUNCTION _nt_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/* Become a signed-in caller with a password sign-in, or anon when p_user is NULL. */
CREATE OR REPLACE FUNCTION _nt_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _nt_reset();
  IF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  IF p_session IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.session_id', p_session::text, true);
  END IF;
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/*
  Run p_sql as that caller in a subtransaction that is always rolled back, and
  return the scalar it answered, `rows N` for a statement without a result, or
  `ERR <sqlstate> <message>`.
*/
CREATE OR REPLACE FUNCTION _nt_try(p_user uuid, p_session uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _nt_as(p_user, p_session);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ011' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _nt_reset();
  RETURN v_out;
END $$;

-- ─── principals and data ────────────────────────────────────────────────────
--
-- seed.sql's two companies and their people, plus a suspended company with an
-- administrator, a company that was never approved, and two company-less
-- platform owners with a sign-in session each — one opens a view context on
-- company A, the other a support session.

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status,
                       trial_end)
VALUES
  (_nt_id('company:suspended'), 'NT suspended', 'nt-suspended', 'approved', 'suspended', 'basic',
   'active', NULL),
  (_nt_id('company:pending'),   'NT pending',   'nt-pending',   'pending',  'trial',     'basic',
   'inactive', now() + interval '3 days'),
  -- A company inside its trial, three days from the end. Its subscription has
  -- never been active, which is what signup writes.
  (_nt_id('company:trialing'),  'NT trialing',  'nt-trialing',  'approved', 'trial',     'basic',
   'inactive', now() + interval '3 days'),
  -- A paying customer that still reads as a trial company, which is the normal
  -- state after redeem_activation_code: its trial ended long ago.
  (_nt_id('company:paying'),    'NT paying',    'nt-paying',    'approved', 'trial',     'advanced',
   'active', now() - interval '40 days')
ON CONFLICT (id) DO NOTHING;

UPDATE companies SET subscription_expires_at = now() + interval '200 days'
 WHERE id = _nt_id('company:paying');

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT _nt_id('user:' || v.who), 'nt-' || v.who || '@test.invalid', now()
FROM (VALUES ('admin-suspended'), ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
SELECT _nt_id('user:' || v.who), 'nt-' || v.who || '@test.invalid', 'NT ' || v.who, v.role,
       (SELECT r.id FROM roles r WHERE r.name = v.role AND r.company_id IS NULL),
       v.company_id, 'active'
FROM (VALUES
  ('admin-suspended', 'admin',  _nt_id('company:suspended')),
  ('owner-view',      'viewer', NULL::uuid),
  ('owner-support',   'viewer', NULL::uuid)
) AS v(who, role, company_id)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES (_nt_id('user:owner-view'),    'owner', 'nt'),
       (_nt_id('user:owner-support'), 'owner', 'nt')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
SELECT _nt_id('session:' || v.who), _nt_id('user:' || v.who)
FROM (VALUES ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

-- One car per company, with a TÜV date inside the 60-day window except where a
-- section needs otherwise. `kennzeichen` is globally unique.
INSERT INTO cars (id, company_id, kennzeichen, created_by, tuev_gueltig_bis)
VALUES
  (_nt_id('car:a'),         'c0000000-0000-4000-8000-00000000000a', 'NT-A 1',
   'a0000000-0000-4000-8000-000000000001', (now() + interval '10 days')::date),
  (_nt_id('car:a2'),        'c0000000-0000-4000-8000-00000000000a', 'NT-A 2',
   'a0000000-0000-4000-8000-000000000001', (now() - interval '5 days')::date),
  -- Outside the window: the candidate query must not carry it.
  (_nt_id('car:a3'),        'c0000000-0000-4000-8000-00000000000a', 'NT-A 3',
   'a0000000-0000-4000-8000-000000000001', (now() + interval '400 days')::date),
  (_nt_id('car:b'),         'c0000000-0000-4000-8000-00000000000b', 'NT-B 1',
   'b0000000-0000-4000-8000-000000000001', (now() + interval '10 days')::date),
  (_nt_id('car:suspended'), _nt_id('company:suspended'),            'NT-S 1',
   _nt_id('user:admin-suspended'),         (now() + interval '10 days')::date),
  (_nt_id('car:pending'),   _nt_id('company:pending'),              'NT-P 1',
   'a0000000-0000-4000-8000-000000000001', (now() + interval '10 days')::date)
ON CONFLICT (id) DO NOTHING;

-- One delivery per company, written as the table's owner (RLS does not apply).
INSERT INTO notification_deliveries (id, company_id, notification_type, target_id, period_key,
                                     mail_sent, recipient_count, settled_at)
VALUES
  (_nt_id('delivery:a'), 'c0000000-0000-4000-8000-00000000000a', 'tuev_bald_ablaufend',
   _nt_id('car:a'), '2099-01-01', true, 1, now()),
  (_nt_id('delivery:b'), 'c0000000-0000-4000-8000-00000000000b', 'tuev_bald_ablaufend',
   _nt_id('car:b'), '2099-01-01', true, 1, now());

-- ─── 1. shape ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_wrong text;
  v_n     integer;
BEGIN
  PERFORM _nt_ok('shape: notification_deliveries has row level security on',
    (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.notification_deliveries'::regclass));

  PERFORM _nt_ok('shape: exactly one policy, the SELECT one, for authenticated',
    (SELECT array_agg(p.policyname::text ORDER BY p.policyname)
       FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = 'notification_deliveries')
      = ARRAY['notification_deliveries_select']
    AND NOT EXISTS (SELECT 1 FROM pg_policies p
                     WHERE p.schemaname = 'public' AND p.tablename = 'notification_deliveries'
                       AND (p.cmd <> 'SELECT' OR p.roles <> ARRAY['authenticated']::name[])));

  SELECT p.qual INTO v_wrong FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'notification_deliveries';
  PERFORM _nt_ok('shape: the SELECT policy is the tenant shape of 20260917130000',
    v_wrong ~ 'get_active_company_id' AND v_wrong ~ 'platform_reads_company_data'
    AND v_wrong !~ 'user_profiles' AND v_wrong !~ 'is_user_super_admin');

  PERFORM _nt_ok('shape: authenticated reads and nothing more; anon and service_role hold nothing',
    has_table_privilege('authenticated', 'public.notification_deliveries', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.notification_deliveries',
                                'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege('anon', 'public.notification_deliveries',
                                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege('service_role', 'public.notification_deliveries',
                                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));

  -- The two support-session triggers go together on the tables a client
  -- writes; support-write-audit.sql fails a table carrying one without the
  -- other. Nothing but the job writes this one, so it carries neither, and
  -- that has to stay true or that file will start reporting this table.
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.notification_deliveries'::regclass AND NOT tgisinternal;
  PERFORM _nt_ok('shape: no client-write triggers, because no client writes it', v_n = 0);

  -- The three functions.
  SELECT string_agg(v.sig, ', ') INTO v_wrong
    FROM (VALUES
      ('public.notification_candidates(integer, integer, uuid)'),
      ('public.notification_delivery_claim(uuid, text, uuid, text)'),
      ('public.notification_delivery_settle(uuid, boolean, integer)')
    ) AS v(sig)
   WHERE has_function_privilege('anon',          to_regprocedure(v.sig), 'EXECUTE')
      OR has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE')
      OR NOT has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE');
  PERFORM _nt_ok(format('shape: EXECUTE is service_role only on all three [%s]', coalesce(v_wrong, 'none')),
    v_wrong IS NULL);

  SELECT string_agg(p.proname, ', ') INTO v_wrong
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('notification_candidates', 'notification_delivery_claim',
                       'notification_delivery_settle')
     AND (NOT p.prosecdef
          OR p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
          OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c
                          WHERE c LIKE 'search\_path=%'));
  PERFORM _nt_ok(format('shape: all three are plpgsql SECURITY DEFINER with a pinned search_path [%s]',
                        coalesce(v_wrong, 'none')),
    v_wrong IS NULL);

  PERFORM _nt_ok('shape: the dedupe rule is a UNIQUE constraint, not a convention',
    EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.notification_deliveries'::regclass
               AND conname = 'notification_deliveries_once' AND contype = 'u'));
END $$;

-- ─── 2. tenants ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  view_a  constant uuid := 'a0000000-0000-4000-8000-000000000003';
  admin_b constant uuid := 'b0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _nt_ok('tenants: a member reads its own company''s deliveries',
    _nt_try(admin_a, NULL, format('SELECT count(*)::text FROM notification_deliveries WHERE id = %L',
                                  _nt_id('delivery:a'))) = '1');

  PERFORM _nt_ok('tenants: …and none of company B''s',
    _nt_try(admin_a, NULL, format('SELECT count(*)::text FROM notification_deliveries WHERE id = %L',
                                  _nt_id('delivery:b'))) = '0'
    AND _nt_try(admin_b, NULL, format('SELECT count(*)::text FROM notification_deliveries WHERE id = %L',
                                      _nt_id('delivery:a'))) = '0');

  PERFORM _nt_ok('tenants: a viewer reads its own company''s too — the read is not role-gated',
    _nt_try(view_a, NULL, format('SELECT count(*)::text FROM notification_deliveries WHERE id = %L',
                                 _nt_id('delivery:a'))) = '1');

  PERFORM _nt_ok('tenants: anon reads nothing',
    _nt_try(NULL, NULL, 'SELECT count(*)::text FROM notification_deliveries') IN ('0', '<null>')
    OR _nt_try(NULL, NULL, 'SELECT count(*)::text FROM notification_deliveries') LIKE 'ERR 42501%');

  -- There is no write policy at all, so every write is refused for want of one.
  PERFORM _nt_ok('tenants: an administrator inserts nothing — the job is the only writer',
    _nt_try(admin_a, NULL, format(
      'INSERT INTO notification_deliveries (company_id, notification_type, target_id, period_key) '
      'VALUES (%L, ''tuev_abgelaufen'', %L, ''2030-01-01'')',
      'c0000000-0000-4000-8000-00000000000a', _nt_id('car:a'))) LIKE 'ERR 42501%');

  PERFORM _nt_ok('tenants: …and updates and deletes nothing either',
    _nt_try(admin_a, NULL, format('UPDATE notification_deliveries SET recipient_count = 9 WHERE id = %L',
                                  _nt_id('delivery:a'))) LIKE 'ERR 42501%'
    AND _nt_try(admin_a, NULL, format('DELETE FROM notification_deliveries WHERE id = %L',
                                      _nt_id('delivery:a'))) LIKE 'ERR 42501%');

  -- The move between companies. With no UPDATE policy and no UPDATE privilege
  -- it is refused before any predicate is reached, which is the strongest
  -- possible answer: there is no WITH CHECK clause to get wrong.
  PERFORM _nt_ok('tenants: a row cannot be moved to another company',
    _nt_try(admin_a, NULL, format(
      'UPDATE notification_deliveries SET company_id = %L WHERE id = %L',
      'c0000000-0000-4000-8000-00000000000b', _nt_id('delivery:a'))) LIKE 'ERR 42501%');

  PERFORM _nt_ok('tenants: nobody may call the job''s functions with a session',
    _nt_try(admin_a, NULL, 'SELECT count(*)::text FROM notification_candidates(60)') LIKE 'ERR 42501%'
    AND _nt_try(admin_a, NULL, format(
      'SELECT notification_delivery_claim(%L, ''tuev_abgelaufen'', %L, ''2030-01-01'')::text',
      'c0000000-0000-4000-8000-00000000000a', _nt_id('car:a'))) LIKE 'ERR 42501%'
    AND _nt_try(NULL, NULL, 'SELECT count(*)::text FROM notification_candidates(60)') LIKE 'ERR 42501%');
END $$;

-- ─── 3. a blocked company ───────────────────────────────────────────────────

DO $$
DECLARE
  admin_s constant uuid := _nt_id('user:admin-suspended');
BEGIN
  -- The company is suspended, so get_active_company_id() answers NULL for its
  -- administrator and the SELECT policy matches nothing — the same as on every
  -- other business table.
  INSERT INTO notification_deliveries (id, company_id, notification_type, target_id, period_key)
  VALUES (_nt_id('delivery:suspended'), _nt_id('company:suspended'), 'tuev_abgelaufen',
          _nt_id('car:suspended'), '2099-01-01');

  PERFORM _nt_ok('blocked: a suspended company''s administrator reads none of its deliveries',
    _nt_try(admin_s, NULL, format('SELECT count(*)::text FROM notification_deliveries WHERE id = %L',
                                  _nt_id('delivery:suspended'))) = '0');

  PERFORM _nt_ok('blocked: the candidate query does not offer a suspended company to the job',
    NOT EXISTS (SELECT 1 FROM notification_candidates(60, 500)
                 WHERE company_id = _nt_id('company:suspended')));

  PERFORM _nt_ok('blocked: …nor one that was never approved',
    NOT EXISTS (SELECT 1 FROM notification_candidates(60, 500)
                 WHERE company_id = _nt_id('company:pending')));

  PERFORM _nt_ok('blocked: a claim for a suspended company answers NULL and writes nothing',
    notification_delivery_claim(_nt_id('company:suspended'), 'tuev_abgelaufen',
                                _nt_id('car:suspended'), '2030-06-01') IS NULL
    AND NOT EXISTS (SELECT 1 FROM notification_deliveries
                     WHERE company_id = _nt_id('company:suspended') AND period_key = '2030-06-01'));
END $$;

-- ─── 4. a platform account, with and without a context ──────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u_v  constant uuid := _nt_id('user:owner-view');
  s_v  constant uuid := _nt_id('session:owner-view');
  u_s  constant uuid := _nt_id('user:owner-support');
  s_s  constant uuid := _nt_id('session:owner-support');
  v_open jsonb;
BEGIN
  -- No context: platform_reads_company_data() is `SELECT false` since 3.4a, so
  -- the OR term contributes nothing and a company-less account matches no row.
  PERFORM _nt_ok('platform: a platform owner with no context reads nothing',
    _nt_try(u_v, s_v, format('SELECT count(*)::text FROM notification_deliveries WHERE id = %L',
                             _nt_id('delivery:a'))) = '0');

  PERFORM _nt_as(u_v, s_v);
  v_open := public.platform_context_open(co_a, 'view');
  PERFORM _nt_reset();
  PERFORM _nt_ok('platform: the owner opens a view context on company A',
    (v_open ->> 'success') = 'true');

  PERFORM _nt_ok('platform: a view context reads company A''s deliveries and none of B''s',
    _nt_try(u_v, s_v, format('SELECT count(*)::text FROM notification_deliveries WHERE id = %L',
                             _nt_id('delivery:a'))) = '1'
    AND _nt_try(u_v, s_v, format('SELECT count(*)::text FROM notification_deliveries WHERE id = %L',
                                 _nt_id('delivery:b'))) = '0');

  PERFORM _nt_ok('platform: a view context writes nothing — there is no write policy at all',
    _nt_try(u_v, s_v, format('UPDATE notification_deliveries SET recipient_count = 9 WHERE id = %L',
                             _nt_id('delivery:a'))) LIKE 'ERR 42501%');

  PERFORM _nt_as(u_s, s_s);
  v_open := public.platform_context_open(co_a, 'support', 'Ticket Benachrichtigungen');
  PERFORM _nt_reset();
  PERFORM _nt_ok('platform: the owner opens a support session on company A',
    (v_open ->> 'success') = 'true');

  PERFORM _nt_ok('platform: a support session reads the company''s deliveries',
    _nt_try(u_s, s_s, format('SELECT count(*)::text FROM notification_deliveries WHERE id = %L',
                             _nt_id('delivery:a'))) = '1');

  -- A support session writes every other tenant table; it writes this one as
  -- little as a company member does, because the job is the only writer. So
  -- there is no support-write audit row to look for, and none is expected.
  PERFORM _nt_ok('platform: a support session writes nothing here either',
    _nt_try(u_s, s_s, format('UPDATE notification_deliveries SET recipient_count = 9 WHERE id = %L',
                             _nt_id('delivery:a'))) LIKE 'ERR 42501%'
    AND _nt_try(u_s, s_s, format(
      'INSERT INTO notification_deliveries (company_id, notification_type, target_id, period_key) '
      'VALUES (%L, ''tuev_abgelaufen'', %L, ''2031-01-01'')', co_a, _nt_id('car:a')))
      LIKE 'ERR 42501%');

  PERFORM _nt_ok('platform: neither session may call the job''s functions',
    _nt_try(u_s, s_s, 'SELECT count(*)::text FROM notification_candidates(60)') LIKE 'ERR 42501%');
END $$;

-- ─── 5. the dedupe rule ─────────────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_first  uuid;
  v_second uuid;
BEGIN
  v_first := notification_delivery_claim(co_a, 'tuev_abgelaufen', _nt_id('car:a2'), '2026-09-19');
  PERFORM _nt_ok('dedupe: the first claim of an occurrence answers a row id', v_first IS NOT NULL);

  v_second := notification_delivery_claim(co_a, 'tuev_abgelaufen', _nt_id('car:a2'), '2026-09-19');
  PERFORM _nt_ok('dedupe: a second claim of the same occurrence answers NULL', v_second IS NULL);
  PERFORM _nt_ok('dedupe: …and left exactly one row',
    (SELECT count(*) FROM notification_deliveries
      WHERE company_id = co_a AND notification_type = 'tuev_abgelaufen'
        AND target_id = _nt_id('car:a2') AND period_key = '2026-09-19') = 1);

  -- A renewal is a new date, and a new date is a new occurrence: the job warns
  -- again 60 days before it, and says "expired" again if it lapses again.
  PERFORM _nt_ok('dedupe: a new expiry date is a new occurrence',
    notification_delivery_claim(co_a, 'tuev_abgelaufen', _nt_id('car:a2'), '2027-09-19') IS NOT NULL);

  -- The two TÜV types are separate occurrences of the same date, so a car
  -- warned at 60 days is still told on the day the date passes.
  PERFORM _nt_ok('dedupe: the warning and the expiry are separate occurrences',
    notification_delivery_claim(co_a, 'tuev_bald_ablaufend', _nt_id('car:a2'), '2026-09-19') IS NOT NULL);

  -- …and one car's claim never covers another car's.
  PERFORM _nt_ok('dedupe: the key names the target, so one car never covers another',
    notification_delivery_claim(co_a, 'tuev_abgelaufen', _nt_id('car:a'), '2026-09-19') IS NOT NULL);

  -- …and never another company's.
  PERFORM _nt_ok('dedupe: …nor another company''s',
    notification_delivery_claim('c0000000-0000-4000-8000-00000000000b', 'tuev_abgelaufen',
                                _nt_id('car:b'), '2026-09-19') IS NOT NULL);
END $$;

-- ─── 6. the claim checks the boundary again ─────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  v_state text;
BEGIN
  PERFORM _nt_ok('claim: a car of another company is not a target of this one',
    notification_delivery_claim(co_a, 'tuev_abgelaufen', _nt_id('car:b'), '2028-01-01') IS NULL);

  PERFORM _nt_ok('claim: the company itself is a valid target, for the trial types',
    notification_delivery_claim(co_a, 'trial_abgelaufen', co_a, '2028-01-01') IS NOT NULL);

  BEGIN
    PERFORM notification_delivery_claim(co_a, 'tuev_bald_abgelaufen', _nt_id('car:a'), '2028-02-01');
    v_state := 'no error';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  PERFORM _nt_ok('claim: an unknown notification type raises 22023, the broken-contract code',
    v_state = '22023');

  BEGIN
    PERFORM notification_delivery_claim(co_a, 'tuev_abgelaufen', _nt_id('car:a'), '01.02.2028');
    v_state := 'no error';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  PERFORM _nt_ok('claim: a period key that is not YYYY-MM-DD raises 22023', v_state = '22023');

  BEGIN
    PERFORM notification_candidates(-1);
    v_state := 'no error';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  PERFORM _nt_ok('claim: a negative window raises 22023', v_state = '22023');

  PERFORM _nt_ok('claim: company B''s own car is claimable by company B',
    notification_delivery_claim(co_b, 'tuev_abgelaufen', _nt_id('car:b'), '2028-01-01') IS NOT NULL);
END $$;

-- ─── 7. settling records an outcome once ────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_id uuid;
  r    public.notification_deliveries%ROWTYPE;
BEGIN
  v_id := notification_delivery_claim(co_a, 'trial_bald_ablaufend', co_a, '2029-01-01');
  SELECT * INTO r FROM notification_deliveries WHERE id = v_id;
  PERFORM _nt_ok('settle: a fresh claim is unsettled — the mail has not gone yet',
    r.mail_sent IS NULL AND r.settled_at IS NULL AND r.recipient_count = 0);

  PERFORM _nt_ok('settle: the first settle records the outcome',
    notification_delivery_settle(v_id, true, 2) = true);
  SELECT * INTO r FROM notification_deliveries WHERE id = v_id;
  PERFORM _nt_ok('settle: …with the count and the time',
    r.mail_sent = true AND r.recipient_count = 2 AND r.settled_at IS NOT NULL);

  PERFORM _nt_ok('settle: a second settle changes nothing, so a failure is never rewritten',
    notification_delivery_settle(v_id, false, 0) = false);
  SELECT * INTO r FROM notification_deliveries WHERE id = v_id;
  PERFORM _nt_ok('settle: …and the recorded outcome stands',
    r.mail_sent = true AND r.recipient_count = 2);

  PERFORM _nt_ok('settle: an unknown id settles nothing',
    notification_delivery_settle(_nt_id('delivery:nowhere'), true, 1) = false);
END $$;

-- ─── 8. what the candidate query offers ─────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  r      record;
  v_src  text;
BEGIN
  SELECT * INTO r FROM notification_candidates(60, 500) WHERE company_id = co_a;
  PERFORM _nt_ok('candidates: company A is offered, with its name', r.company_id = co_a);

  PERFORM _nt_ok('candidates: it carries only the cars inside the window',
    (SELECT count(*) FROM jsonb_array_elements(r.cars)) = 2
    AND r.cars::text LIKE '%' || _nt_id('car:a')::text || '%'
    AND r.cars::text LIKE '%' || _nt_id('car:a2')::text || '%'
    AND r.cars::text NOT LIKE '%' || _nt_id('car:a3')::text || '%');

  PERFORM _nt_ok('candidates: the TÜV date comes back as a YYYY-MM-DD day, never a timestamp',
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.cars) c
                 WHERE (c ->> 'tuev_gueltig_bis') !~ '^\d{4}-\d{2}-\d{2}$'));

  PERFORM _nt_ok('candidates: it carries the company''s own deliveries and no other company''s',
    r.sent::text LIKE '%' || _nt_id('car:a')::text || '%'
    AND r.sent::text NOT LIKE '%' || _nt_id('car:b')::text || '%');

  -- A company with a narrower window offered no cars, and so is offered at all
  -- only if it has a trial_end.
  PERFORM _nt_ok('candidates: the window is the caller''s argument, not a constant in here',
    (SELECT count(*) FROM jsonb_array_elements(
       (SELECT c.cars FROM notification_candidates(5, 500) c WHERE c.company_id = co_a))) = 1);

  -- The decision this whole feature turns on: the query must not gate on the
  -- subscription, or trial_abgelaufen could never reach the company it is
  -- about, and trial_bald_ablaufend could never be sent at all — a company
  -- inside its trial has subscription_status = 'inactive'.
  PERFORM _nt_ok('candidates: a company inside its trial is offered, although its subscription is inactive',
    EXISTS (SELECT 1 FROM notification_candidates(60, 500)
             WHERE company_id = _nt_id('company:trialing')));

  PERFORM _nt_ok('candidates: a paying customer still on status=trial is offered too — the job decides, not the query',
    EXISTS (SELECT 1 FROM notification_candidates(60, 500)
             WHERE company_id = _nt_id('company:paying')));

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'notification_candidates';
  PERFORM _nt_ok('candidates: the query has no subscription term and does not ask get_active_company_id()',
    v_src NOT LIKE '%subscription_status =%' AND v_src NOT LIKE '%get_active_company_id%');
  PERFORM _nt_ok('candidates: …and has kept its approval boundary',
    v_src LIKE '%approval_status%');

  -- Paging: the cursor is the company id, so a page never repeats a company.
  PERFORM _nt_ok('candidates: p_after pages past a company',
    NOT EXISTS (SELECT 1 FROM notification_candidates(60, 500, co_a) WHERE company_id <= co_a));
END $$;

ROLLBACK;
