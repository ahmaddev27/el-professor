/*
  Per-company sidebar modules: the table, its one writer, and the refusals
  (migration 20261025120000, Docs/design/per-company-modules.md slice 1).

  Runs after the files before it, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it see
  the database as the seeds left it.

  Every check is a BEHAVIOUR: a caller does something and the database answers.
  Nothing here reads the text of a policy or a function — the migration's own
  self-check does the catalogue reading — so a rewrite that keeps the behaviour
  keeps this file green.

  What is covered, in order:

    1. access       row level security is on; anon is refused outright; the
                    service role holds nothing; authenticated holds SELECT and
                    nothing else; the table carries no trigger
    2. tenants      every member of a company reads its own module rows and
                    none of another company's; nobody writes, in any direction
    3. state        a SUSPENDED company's administrator still reads its rows,
                    which is the whole reason the policy is on the account
                    shell helper and not on get_active_company_id()
    4. platform     an active staff role reads every company's rows through
                    companies.read; an account with no staff row reads none
    5. who may      the RPC per platform role and for a company admin: owner and
                    write        support write, billing and read_only are
                    refused, anon and the service role hold no EXECUTE
    6. locked       each of the six locked modules is refused with
                    module_locked, for an owner, and its German sentence is the
                    database's own
    7. contract     an unknown key, a NULL key, a NULL flag, a NULL company, an
                    over-long note and an unknown company are each refused with
                    their own reason
    8. audit        one row per call, with the category, action, target type and
                    id, the values before and after, and the actor with its role
                    — for a success, a refusal and a denial
    9. identity     off then on leaves the row as it was found, and NOT ONE
                    tenant row anywhere moves: the design's prohibition, as a
                    measurement rather than a catalogue read
   10. company      the module rows go with their company

  The matrix lines for the table and the RPC are in tests/rls/matrix.sql.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in support-write-audit.sql) ───────────────────────────

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

CREATE OR REPLACE FUNCTION _cm_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _cm_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('cm:' || p_what)::uuid $$;

CREATE OR REPLACE FUNCTION _cm_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/*
  Become a signed-in caller with a password sign-in — since 20260919130000 a
  platform capability answers NULL without one, so every platform probe below
  would read as "no role" and pass vacuously if this were left out. anon when
  p_user is NULL; the service role when p_service.
*/
CREATE OR REPLACE FUNCTION _cm_as(p_user uuid, p_service boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _cm_reset();
  IF p_service THEN
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
    RETURN;
  END IF;
  IF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/*
  Run p_sql as that caller in a subtransaction that is always rolled back, and
  return the scalar it answered, `rows N` for a statement without a result, or
  `ERR <sqlstate> <message>`. Nothing it writes survives, audit rows included.
*/
CREATE OR REPLACE FUNCTION _cm_try(p_user uuid, p_sql text, p_service boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _cm_as(p_user, p_service);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ021', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ021' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _cm_reset();
  RETURN v_out;
END $$;

/** Like _cm_try, but keeps what the statement did — for the audit checks. */
CREATE OR REPLACE FUNCTION _cm_do(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _cm_as(p_user);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _cm_reset();
  RETURN v_out;
END $$;

/** 'Y' when the answer says success, 'N' when it says failure, 'P' for no EXECUTE. */
CREATE OR REPLACE FUNCTION _cm_yn(p_answer text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  IF p_answer LIKE 'ERR 42501 permission denied%' THEN RETURN 'P'; END IF;
  IF p_answer LIKE 'ERR%' THEN RETURN p_answer; END IF;
  RETURN CASE WHEN (p_answer::jsonb ->> 'success') = 'true' THEN 'Y' ELSE 'N' END;
EXCEPTION WHEN OTHERS THEN
  RETURN p_answer;
END $$;

/** The stable reason a refused answer carries. */
CREATE OR REPLACE FUNCTION _cm_reason(p_answer text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN p_answer::jsonb ->> 'reason';
EXCEPTION WHEN OTHERS THEN
  RETURN p_answer;
END $$;

/** The audit log's high-water mark, so each check counts only its own rows. */
CREATE OR REPLACE FUNCTION _cm_mark() RETURNS bigint
LANGUAGE sql AS $$ SELECT coalesce(max(l.id), 0) FROM app_private.platform_audit_log l $$;

/** Every row of every tenant-ish table, counted once — section 9's instrument. */
CREATE OR REPLACE FUNCTION _cm_tenant_rows() RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  r     record;
  v_n   bigint;
  v_sum bigint := 0;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p')
       AND c.relname <> 'company_modules'
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped)
     ORDER BY 1
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', r.relname) INTO v_n;
    v_sum := v_sum + v_n;
  END LOOP;
  RETURN v_sum;
END $$;

-- ─── principals and data ────────────────────────────────────────────────────
--
-- seed.sql's two companies and their people (admin-a, editor-a, viewer-a,
-- admin-b, and `super`, a platform owner), plus a suspended company with an
-- administrator of its own, and one staff account per platform role so the
-- capability and not the staff row is what section 5 measures.

CREATE TEMP TABLE _cm_who (who text PRIMARY KEY, uid uuid NOT NULL);
INSERT INTO _cm_who VALUES
  ('admin-a',  'a0000000-0000-4000-8000-000000000001'),
  ('editor-a', 'a0000000-0000-4000-8000-000000000002'),
  ('viewer-a', 'a0000000-0000-4000-8000-000000000003'),
  ('admin-b',  'b0000000-0000-4000-8000-000000000001'),
  ('super',    '50000000-0000-4000-8000-000000000001');

CREATE OR REPLACE FUNCTION _cm_u(p_who text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT coalesce((SELECT w.uid FROM _cm_who w WHERE w.who = p_who), _cm_id('user:' || p_who)) $$;

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
VALUES (_cm_id('company:suspended'), 'CM suspended', 'cm-suspended', 'approved', 'suspended', 'advanced', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT _cm_id('user:' || v.who), 'cm-' || v.who || '@test.invalid', now()
FROM (VALUES ('admin-suspended'), ('staff-support'), ('staff-billing'), ('staff-readonly'), ('no-staff-row'))
  AS v(who)
ON CONFLICT (id) DO NOTHING;

-- A platform profile carries no company and the least role the product has:
-- platform rights come from platform_staff, never from the profile.
INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
SELECT _cm_id('user:' || v.who), 'cm-' || v.who || '@test.invalid', 'CM ' || v.who, v.role,
       (SELECT r.id FROM roles r WHERE r.name = v.role AND r.company_id IS NULL),
       v.company_id, 'active'
FROM (VALUES
  ('admin-suspended', 'admin',  _cm_id('company:suspended')),
  ('staff-support',   'viewer', NULL::uuid),
  ('staff-billing',   'viewer', NULL::uuid),
  ('staff-readonly',  'viewer', NULL::uuid),
  ('no-staff-row',    'viewer', NULL::uuid)
) AS v(who, role, company_id)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES (_cm_id('user:staff-support'),  'support',   'cm'),
       (_cm_id('user:staff-billing'),  'billing',   'cm'),
       (_cm_id('user:staff-readonly'), 'read_only', 'cm')
ON CONFLICT (user_id) DO NOTHING;

-- One decision per company, written as the owner of the table (RLS does not
-- apply to it, and the table carries no trigger).
INSERT INTO company_modules (company_id, module_key, enabled, note) VALUES
  ('c0000000-0000-4000-8000-00000000000a', 'werkstatt', false, 'CM fixture A'),
  ('c0000000-0000-4000-8000-00000000000b', 'notes',     false, 'CM fixture B'),
  (_cm_id('company:suspended'),            'belege',    false, 'CM fixture suspended');

-- ─── 1. access ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role text;
  v_n    int;
BEGIN
  PERFORM _cm_ok('access: company_modules has row level security on',
    (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.company_modules'::regclass));

  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    PERFORM _cm_ok(format('access: %s holds nothing at all on company_modules', v_role),
      NOT has_table_privilege(v_role, 'public.company_modules',
                              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
  END LOOP;

  PERFORM _cm_ok('access: authenticated may select and nothing else',
    has_table_privilege('authenticated', 'public.company_modules', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.company_modules',
                                'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));

  PERFORM _cm_ok('access: anon is refused outright, not filtered',
    _cm_try(NULL, 'SELECT count(*)::text FROM company_modules') LIKE 'ERR 42501 permission denied%');

  -- A move between companies is refused for having no UPDATE policy at all,
  -- rather than by a WITH CHECK clause a later migration could restate away.
  SELECT count(*) INTO v_n FROM pg_policy p
   WHERE p.polrelid = 'public.company_modules'::regclass;
  PERFORM _cm_ok('access: exactly one policy exists, and it is the SELECT one',
    v_n = 1 AND EXISTS (SELECT 1 FROM pg_policy p
                         WHERE p.polrelid = 'public.company_modules'::regclass AND p.polcmd = 'r'));

  -- Not refuse_read_only_context_write and not record_support_write: the pair
  -- belongs on a table whose policies name get_active_company_id(), and this
  -- one is on the account shell helper. tests/rls/platform-contexts.sql
  -- section 14 would demand the first if that ever changed.
  SELECT count(*) INTO v_n FROM pg_trigger t
   WHERE t.tgrelid = 'public.company_modules'::regclass AND NOT t.tgisinternal;
  PERFORM _cm_ok('access: the table carries no trigger of its own', v_n = 0);
END $$;

-- ─── 2. tenants ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  who  text;
BEGIN
  -- Impersonation proven first: a NULL uid would make every refusal below pass.
  PERFORM _cm_ok('impersonation: admin-a''s company is company A',
    _cm_try(_cm_u('admin-a'), 'SELECT get_user_company_id()::text') = co_a::text);

  FOREACH who IN ARRAY ARRAY['viewer-a', 'editor-a', 'admin-a'] LOOP
    PERFORM _cm_ok(format('tenants: %s reads its own company''s decision', who),
      _cm_try(_cm_u(who), format('SELECT count(*)::text FROM company_modules WHERE company_id = %L', co_a)) = '1');
    PERFORM _cm_ok(format('tenants: %s reads none of company B''s — SELECT is not role-gated, and must not be', who),
      _cm_try(_cm_u(who), format('SELECT count(*)::text FROM company_modules WHERE company_id = %L', co_b)) = '0');
  END LOOP;

  PERFORM _cm_ok('tenants: admin-b reads its own and not company A''s',
    _cm_try(_cm_u('admin-b'), 'SELECT count(*)::text FROM company_modules') = '1');

  -- No write privilege at all, so every direction is `permission denied` rather
  -- than a filtered statement that reports success over nothing.
  PERFORM _cm_ok('tenants: an administrator inserts nothing, into either company',
    _cm_try(_cm_u('admin-a'),
      format('INSERT INTO company_modules (company_id, module_key, enabled) VALUES (%L, ''notes'', false)', co_a))
      LIKE 'ERR 42501 permission denied%'
    AND _cm_try(_cm_u('admin-a'),
      format('INSERT INTO company_modules (company_id, module_key, enabled) VALUES (%L, ''notes'', false)', co_b))
      LIKE 'ERR 42501 permission denied%');
  PERFORM _cm_ok('tenants: an administrator updates and deletes nothing, not even its own row',
    _cm_try(_cm_u('admin-a'),
      format('UPDATE company_modules SET enabled = true WHERE company_id = %L', co_a))
      LIKE 'ERR 42501 permission denied%'
    AND _cm_try(_cm_u('admin-a'),
      format('DELETE FROM company_modules WHERE company_id = %L', co_a))
      LIKE 'ERR 42501 permission denied%');
END $$;

-- ─── 3. state: the account shell helper, and why it is the one chosen ───────

DO $$
DECLARE
  v_suspended constant uuid := _cm_id('company:suspended');
  u           constant uuid := _cm_id('user:admin-suspended');
BEGIN
  -- The whole reason the policy reads get_user_company_id(). A suspended
  -- company has to render the page that explains the suspension and reach
  -- /abo-aktivieren and /billing, and both are modules this table can speak
  -- about — so if its rows were unreadable the screen could not even tell that
  -- /billing is locked.
  PERFORM _cm_ok('state: the suspended company''s active helper answers NULL',
    _cm_try(u, 'SELECT coalesce(get_active_company_id()::text, ''<none>'')') = '<none>');
  PERFORM _cm_ok('state: …and its administrator still reads its module rows',
    _cm_try(u, format('SELECT count(*)::text FROM company_modules WHERE company_id = %L', v_suspended)) = '1');
  PERFORM _cm_ok('state: …and still none of another company''s',
    _cm_try(u, 'SELECT count(*)::text FROM company_modules WHERE company_id <> '
               || quote_literal(v_suspended)) = '0');
END $$;

-- ─── 4. a platform account reads every company's rows ──────────────────────

DO $$
DECLARE
  who text;
BEGIN
  -- companies.read, which all four roles hold since 20261015150000 — the same
  -- capability that reads the company list the panel chooses a company from.
  -- Three rows exist: company A's, company B's and the suspended company's.
  FOREACH who IN ARRAY ARRAY['super', 'staff-support', 'staff-billing', 'staff-readonly'] LOOP
    PERFORM _cm_ok(format('platform: %s reads every company''s decisions', who),
      _cm_try(_cm_u(who), 'SELECT count(*)::text FROM company_modules') = '3');
  END LOOP;

  PERFORM _cm_ok('platform: an account with no staff row and no company reads none',
    _cm_try(_cm_id('user:no-staff-row'), 'SELECT count(*)::text FROM company_modules') = '0');
END $$;

-- ─── 5. who may write ───────────────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_call constant text := format(
    'SELECT platform_company_set_module(%L, ''notes'', false)::text', co_a);
  r      record;
BEGIN
  -- The capability decides, not the staff row's existence: billing and
  -- read_only hold companies.read (section 4 just proved they read the table)
  -- and do not hold companies.lifecycle, so they are refused here.
  FOR r IN
    SELECT * FROM (VALUES
      ('super',          'Y'),   -- owner
      ('staff-support',  'Y'),   -- support, since D2 was answered 15.10.2026
      ('staff-billing',  'N'),
      ('staff-readonly', 'N'),
      ('admin-a',        'N'),   -- a company administrator is not platform staff
      ('no-staff-row',   'N')
    ) AS v(who, want)
  LOOP
    PERFORM _cm_ok(format('write: %s -> %s', r.who, r.want),
      _cm_yn(_cm_try(_cm_u(r.who), v_call)) = r.want);
  END LOOP;

  PERFORM _cm_ok('write: anon and the service role hold no EXECUTE',
    _cm_yn(_cm_try(NULL, v_call)) = 'P'
    AND _cm_yn(_cm_try(NULL, v_call, true)) = 'P');

  PERFORM _cm_ok('write: a refused caller is told `denied`, not something it could act on',
    _cm_reason(_cm_try(_cm_u('staff-billing'), v_call)) = 'denied');
END $$;

-- ─── 6. the locked modules ──────────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u    constant uuid := _cm_u('super');
  v_key  text;
  v_ans  text;
BEGIN
  -- The refusal is in the DATABASE and not only in the panel: a deadlock the
  -- screen could create by accident has to be impossible. Two of these six are
  -- genuine deadlocks — /billing (the company could not pay, so could never
  -- leave the blocked state) and /overview (the target of every fallback
  -- redirect).
  FOREACH v_key IN ARRAY ARRAY['overview', 'billing', 'users', 'roles', 'settings', 'datensicherung'] LOOP
    v_ans := _cm_try(u, format('SELECT platform_company_set_module(%L, %L, false)::text', co_a, v_key));
    PERFORM _cm_ok(format('locked: %s is refused with module_locked', v_key),
      _cm_yn(v_ans) = 'N' AND _cm_reason(v_ans) = 'module_locked');
    PERFORM _cm_ok(format('locked: …and %s is still not stored', v_key),
      (SELECT count(*) FROM company_modules
        WHERE company_id = co_a AND module_key = v_key) = 0);
  END LOOP;

  -- Switching a locked module ON is refused too, and deliberately: the list is
  -- about the key, not about the direction, so nothing can create the row that
  -- a later careless UPDATE would flip.
  v_ans := _cm_try(u, format('SELECT platform_company_set_module(%L, ''billing'', true)::text', co_a));
  PERFORM _cm_ok('locked: switching a locked module on is refused as well',
    _cm_reason(v_ans) = 'module_locked');

  -- The sentence a user actually sees is the one the database wrote, which is
  -- why platform_rpc_response was not restated for it (20261016140000's idiom).
  PERFORM _cm_ok('locked: the German sentence is the database''s own, not the generic one',
    (v_ans::jsonb ->> 'error') LIKE 'Dieses Modul kann nicht abgeschaltet werden.%');

  -- Every lockable module is accepted, so the list refuses six and not seven.
  FOREACH v_key IN ARRAY ARRAY['belege', 'fahrer', 'cars', 'umsaetze', 'fixkosten', 'bargeldbestand',
                               'werkstatt', 'abrechnung', 'notes', 'benachrichtigungen', 'salaries',
                               'dokumente', 'fahrtenbuch', 'company_planner', 'monatsplan', 'datenimport'] LOOP
    PERFORM _cm_ok(format('locked: %s is toggleable', v_key),
      _cm_yn(_cm_try(u, format('SELECT platform_company_set_module(%L, %L, false)::text', co_a, v_key))) = 'Y');
  END LOOP;
END $$;

-- ─── 7. the argument contract ───────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u    constant uuid := _cm_u('super');
  r    record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- A key the product does not have would be invisible state: the browser
      -- reads a row it does not know as nothing at all.
      ('an unknown key',        format('SELECT platform_company_set_module(%L, ''plausible'', false)::text', co_a), 'invalid'),
      -- Not even a key that merely looks like a module.
      ('a sidebar path as a key', format('SELECT platform_company_set_module(%L, ''company-planner'', false)::text', co_a), 'invalid'),
      ('a NULL key',            format('SELECT platform_company_set_module(%L, NULL, false)::text', co_a), 'invalid'),
      ('a NULL flag',           format('SELECT platform_company_set_module(%L, ''notes'', NULL)::text', co_a), 'invalid'),
      ('a NULL company',        'SELECT platform_company_set_module(NULL, ''notes'', false)::text', 'invalid'),
      ('an over-long note',     format('SELECT platform_company_set_module(%L, ''notes'', false, %L)::text', co_a, repeat('x', 501)), 'invalid'),
      -- A company that does not exist, which is distinguishable from a refusal.
      ('an unknown company',    format('SELECT platform_company_set_module(%L, ''notes'', false)::text', _cm_id('company:nowhere')), 'not_found')
    ) AS v(what, stmt, want)
  LOOP
    PERFORM _cm_ok(format('contract: %s -> %s', r.what, r.want),
      _cm_reason(_cm_try(u, r.stmt)) = r.want);
  END LOOP;

  PERFORM _cm_ok('contract: a note of exactly 500 characters is accepted',
    _cm_yn(_cm_try(u, format('SELECT platform_company_set_module(%L, ''notes'', false, %L)::text', co_a, repeat('x', 500)))) = 'Y');
  PERFORM _cm_ok('contract: a blank note is stored as no note',
    _cm_yn(_cm_try(u, format('SELECT platform_company_set_module(%L, ''notes'', false, ''   '')::text', co_a))) = 'Y');

  -- Every refusal is a RETURN VALUE and never an exception, or the audit row
  -- that records it would be rolled back with the transaction.
  PERFORM _cm_ok('contract: nothing above raised — a refusal is an answer',
    _cm_try(u, format('SELECT platform_company_set_module(%L, ''plausible'', false)::text', co_a)) NOT LIKE 'ERR%');
END $$;

-- ─── 8. the audit row ───────────────────────────────────────────────────────

DO $$
DECLARE
  co_a   constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u      constant uuid := _cm_u('super');
  v_mark bigint;
  v_ans  text;
  r      app_private.platform_audit_log%ROWTYPE;
  v_n    bigint;
BEGIN
  -- 8a. a success over a row that already existed: before AND after.
  v_mark := _cm_mark();
  v_ans := _cm_do(u, format('SELECT platform_company_set_module(%L, ''werkstatt'', true, ''wieder an'')::text', co_a));
  PERFORM _cm_ok('audit: the call succeeded', (v_ans::jsonb ->> 'success') = 'true');

  SELECT count(*) INTO v_n FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _cm_ok('audit: exactly one row per call', v_n = 1);

  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _cm_ok('audit: category write, outcome ok, the company, the target type and id',
    r.category = 'write' AND r.action = 'company.set_module' AND r.outcome = 'ok'
    AND r.company_id = co_a AND r.target_type = 'company_module'
    AND r.target_id = co_a::text || ':werkstatt');
  PERFORM _cm_ok('audit: the actor and its role, looked up and never passed',
    r.actor_user_id = u AND r.actor_role = 'owner');
  PERFORM _cm_ok('audit: the values before and after, with the note',
    (r.before_value ->> 'module_key') = 'werkstatt' AND (r.before_value ->> 'enabled') = 'false'
    AND (r.after_value ->> 'enabled') = 'true' AND (r.after_value ->> 'note') = 'wieder an');

  -- 8b. a success where no row existed: before_value is NULL, so the log says
  --     "there was no decision" rather than inventing the default.
  v_mark := _cm_mark();
  PERFORM _cm_do(u, format('SELECT platform_company_set_module(%L, ''salaries'', false)::text', co_a));
  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _cm_ok('audit: no earlier row means before_value is NULL, not a fabricated default',
    r.before_value IS NULL AND (r.after_value ->> 'enabled') = 'false'
    AND r.after_value ->> 'note' IS NULL);

  -- 8c. a refusal a valid caller ran into is an `error` row that names it.
  v_mark := _cm_mark();
  PERFORM _cm_do(u, format('SELECT platform_company_set_module(%L, ''billing'', false)::text', co_a));
  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _cm_ok('audit: module_locked is recorded as an error row naming the reason',
    r.outcome = 'error' AND r.action = 'company.set_module'
    AND (r.after_value ->> 'reason') = 'module_locked'
    AND (r.after_value ->> 'module_key') = 'billing'
    AND r.target_id = co_a::text || ':billing');

  v_mark := _cm_mark();
  PERFORM _cm_do(u, format('SELECT platform_company_set_module(%L, ''plausible'', false)::text', co_a));
  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _cm_ok('audit: an invalid argument is recorded too',
    r.outcome = 'error' AND (r.after_value ->> 'reason') = 'invalid');

  -- 8d. a caller the capability refused leaves a `denied` row with its own role.
  v_mark := _cm_mark();
  PERFORM _cm_do(_cm_id('user:staff-billing'),
    format('SELECT platform_company_set_module(%L, ''notes'', false)::text', co_a));
  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _cm_ok('audit: a denied call records the actor, its real role and the capability',
    r.outcome = 'denied' AND r.actor_user_id = _cm_id('user:staff-billing')
    AND r.actor_role = 'billing'
    AND (r.after_value ->> 'capability') = 'companies.lifecycle');

  -- 8e. a company administrator's refusal is recorded with no role at all.
  v_mark := _cm_mark();
  PERFORM _cm_do(_cm_u('admin-a'), format('SELECT platform_company_set_module(%L, ''notes'', false)::text', co_a));
  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _cm_ok('audit: a company user''s refusal is recorded with the actor and a NULL role',
    r.outcome = 'denied' AND r.actor_user_id = _cm_u('admin-a') AND r.actor_role IS NULL);
END $$;

-- ─── 9. on -> off -> on is the identity, measured ──────────────────────────

DO $$
DECLARE
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u       constant uuid := _cm_u('super');
  v_rows  bigint;
  v_after bigint;
  v_was   boolean;
  v_now   boolean;
BEGIN
  /*
    The design's one prohibition: nothing in this feature may ever delete,
    archive, anonymise or clean up tenant data when a module is switched off.
    The migration's self-check 6 reads it out of the catalogue; this measures
    it — every row of every table that has a company_id, counted before and
    after a full round trip through the busiest module there is.

    `dokumente` is the one to use: its page key gates 24 tables, so if any
    disable step were ever added it would be added there.
  */
  v_rows := _cm_tenant_rows();
  SELECT cm.enabled INTO v_was FROM company_modules cm
   WHERE cm.company_id = co_a AND cm.module_key = 'dokumente';

  PERFORM _cm_do(u, format('SELECT platform_company_set_module(%L, ''dokumente'', false)::text', co_a));
  v_after := _cm_tenant_rows();
  PERFORM _cm_ok('identity: switching a module off removes not one tenant row', v_after = v_rows);

  PERFORM _cm_do(u, format('SELECT platform_company_set_module(%L, ''dokumente'', true)::text', co_a));
  PERFORM _cm_ok('identity: switching it back on adds none either', _cm_tenant_rows() = v_rows);

  SELECT cm.enabled INTO v_now FROM company_modules cm
   WHERE cm.company_id = co_a AND cm.module_key = 'dokumente';
  PERFORM _cm_ok('identity: and the module is on again', v_now AND v_was IS NULL);

  -- One row per company and module, however many times it is called: the
  -- ON CONFLICT is what makes a second call an update and not a second row.
  PERFORM _cm_do(u, format('SELECT platform_company_set_module(%L, ''dokumente'', false)::text', co_a));
  PERFORM _cm_do(u, format('SELECT platform_company_set_module(%L, ''dokumente'', false)::text', co_a));
  PERFORM _cm_ok('identity: one row per company and module, not one per call',
    (SELECT count(*) FROM company_modules
      WHERE company_id = co_a AND module_key = 'dokumente') = 1);

  -- The operator and the moment are stamped by the function, never taken from
  -- the caller's payload: there is no argument for either.
  PERFORM _cm_ok('identity: set_by is the operator and set_at is now',
    (SELECT cm.set_by = u AND cm.set_at > now() - interval '1 minute'
       FROM company_modules cm WHERE cm.company_id = co_a AND cm.module_key = 'dokumente'));

  -- The same module for another company is a different decision.
  PERFORM _cm_do(u, format('SELECT platform_company_set_module(%L, ''dokumente'', false)::text',
    'c0000000-0000-4000-8000-00000000000b'));
  PERFORM _cm_ok('identity: a decision belongs to one company',
    (SELECT count(*) FROM company_modules WHERE module_key = 'dokumente') = 2);
END $$;

-- ─── 10. the rows go with their company ────────────────────────────────────

DO $$
DECLARE
  v_company constant uuid := _cm_id('company:short-lived');
BEGIN
  INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
  VALUES (v_company, 'CM short-lived', 'cm-short-lived', 'approved', 'active', 'basic', 'active');
  INSERT INTO company_modules (company_id, module_key, enabled) VALUES (v_company, 'werkstatt', false);
  PERFORM _cm_ok('company: the decision is stored for it',
    (SELECT count(*) FROM company_modules WHERE company_id = v_company) = 1);

  DELETE FROM companies WHERE id = v_company;
  PERFORM _cm_ok('company: deleting the company deletes its module decisions',
    (SELECT count(*) FROM company_modules WHERE company_id = v_company) = 0);
END $$;

DO $$ BEGIN RAISE NOTICE '── company modules: all checks passed ──'; END $$;

ROLLBACK;
