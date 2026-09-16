/*
  Support sessions (plan 3.C, migration 20260917140000): what a platform account
  may reach, in which mode, and every way a context ends.

  Runs after assertions.sql and the matrix, against the same throwaway database,
  as supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it
  see the database as the seeds left it.

  What is covered, in order:

    1. privileges     app_private.platform_company_contexts is unreachable; the
                      three RPCs and the two mode helpers are authenticated-only
    2. opening        a view context needs business.read and no reason; a
                      support session needs support.session and a reason; a
                      broken mode or company raises 22023; every refusal is a
                      return value with a stable reason, and is audited
    3. one at a time  a second company is refused while one is open; asking
                      again for the same company and mode returns the open one
                      unchanged; view -> support supersedes on the same company
    4. reads          confined to the context's company, in both modes, through
                      the tenant term — and nothing at all without a context
    5. view writes    nothing: role-gated and ungated tables alike, INSERT,
                      UPDATE and DELETE, refused by the statement trigger
    6. support writes only inside its own company, and cannot move a row out of
                      it; the role gates answer true while it is open
    7. expiry         ends the context, and platform_contexts_expire() writes it
                      down
    8. the session    a context is answered only to the sign-in session that
                      opened it, and not after that session is gone
    9. the staff row  disabling it ends the context at once and closes the row
   10. closing        by hand, once; and nothing is left to close afterwards
   11. audit          one `support` row per call, refusals included
   12. whoami         carries the open context, and writes nothing
   13. roles          a support session cannot pull another company's role or
                      permission row into the company it is supporting

  What is deliberately not here: the storage policies (the file half of plan
  3.C is not built), and the browser, which is slice 3.4b.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in otp.sql and platform-authority.sql) ────────────────

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

CREATE OR REPLACE FUNCTION _pc_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _pc_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('pc:' || p_what)::uuid $$;

CREATE OR REPLACE FUNCTION _pc_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
END $$;

/*
  Become a signed-in caller, with the sign-in session in the token — the claim
  20260917140000 answers a context to. NULL user: anon. NULL session: a token
  without one, which is what every older test file carries.
*/
CREATE OR REPLACE FUNCTION _pc_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pc_reset();
  IF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  IF p_session IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.session_id', p_session::text, true);
  END IF;
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/*
  Run p_sql as that caller in a subtransaction that is always rolled back, and
  return the scalar it answered, `rows N` for a statement without a result, or
  `ERR <sqlstate> <message>`. Nothing it writes survives, which is what a write
  probe needs; a context that must persist is opened outside this.
*/
CREATE OR REPLACE FUNCTION _pc_try(p_user uuid, p_session uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _pc_as(p_user, p_session);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ007', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ007' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _pc_reset();
  RETURN v_out;
END $$;

/** One field of a jsonb answer, as text, for a call that must not be rolled back. */
CREATE OR REPLACE FUNCTION _pc_field(p_json text, p_key text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT (p_json::jsonb) ->> p_key $$;

-- ─── principals ─────────────────────────────────────────────────────────────
--
-- Two healthy companies with a driver and a receipt each, one administrator in
-- the first, and four platform accounts — one per role — each with a sign-in
-- session of its own. seed.sql's platform owner stays active throughout, so the
-- last-owner trigger is never what a check below measures.

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
VALUES
  (_pc_id('company:x'), 'PC X', 'pc-x', 'approved', 'active', 'basic', 'active'),
  (_pc_id('company:y'), 'PC Y', 'pc-y', 'approved', 'active', 'basic', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT _pc_id('user:' || v.who), 'pc-' || v.who || '@test.invalid', now()
FROM (VALUES ('admin-x'), ('owner'), ('support'), ('readonly'), ('billing')) AS v(who)
ON CONFLICT (id) DO NOTHING;

-- The platform accounts carry no company and the text role `viewer`: platform
-- rights come from platform_staff, and a viewer's can_edit is false everywhere,
-- so any write one of them makes below is the support session's doing.
INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
SELECT _pc_id('user:' || v.who), 'pc-' || v.who || '@test.invalid', 'PC ' || v.who, v.role,
       (SELECT id FROM roles WHERE name = v.role AND company_id IS NULL LIMIT 1),
       v.company_id, 'active'
FROM (VALUES
  ('admin-x',  'admin',  _pc_id('company:x')),
  ('owner',    'viewer', NULL::uuid),
  ('support',  'viewer', NULL::uuid),
  ('readonly', 'viewer', NULL::uuid),
  ('billing',  'viewer', NULL::uuid)
) AS v(who, role, company_id)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
SELECT _pc_id('user:' || v.who), v.role, 'pc'
FROM (VALUES ('owner', 'owner'), ('support', 'support'),
             ('readonly', 'read_only'), ('billing', 'billing')) AS v(who, role)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
SELECT _pc_id('session:' || v.who), _pc_id('user:' || v.who)
FROM (VALUES ('owner'), ('owner2'), ('support'), ('readonly'), ('billing'), ('admin-x')) AS v(who)
WHERE EXISTS (SELECT 1 FROM auth.users u WHERE u.id = _pc_id('user:' || v.who))
ON CONFLICT (id) DO NOTHING;

-- A second sign-in session for the owner, to prove a context is not inherited.
INSERT INTO auth.sessions (id, user_id)
VALUES (_pc_id('session:owner2'), _pc_id('user:owner'))
ON CONFLICT (id) DO NOTHING;

INSERT INTO drivers (id, company_id, name) VALUES
  (_pc_id('driver:x'), _pc_id('company:x'), 'PC Driver X'),
  (_pc_id('driver:y'), _pc_id('company:y'), 'PC Driver Y')
ON CONFLICT (id) DO NOTHING;

INSERT INTO receipts (id, company_id, receipt_number, date, description, driver_name) VALUES
  (_pc_id('receipt:x'), _pc_id('company:x'), 'BEL-PC-X', current_date, 'pc', 'PC Driver X'),
  (_pc_id('receipt:y'), _pc_id('company:y'), 'BEL-PC-Y', current_date, 'pc', 'PC Driver Y')
ON CONFLICT (id) DO NOTHING;

INSERT INTO roles (id, name, description, company_id, is_system) VALUES
  (_pc_id('role:x'), 'PC role X', 'pc', _pc_id('company:x'), false),
  (_pc_id('role:y'), 'PC role Y', 'pc', _pc_id('company:y'), false)
ON CONFLICT (id) DO NOTHING;

-- ─── 1. privileges ──────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role text;
  v_sig  text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM _pc_ok(format('privileges: %s reaches no context row', v_role),
      NOT has_schema_privilege(v_role, 'app_private', 'USAGE')
      AND NOT has_table_privilege(v_role, 'app_private.platform_company_contexts',
                                  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'));
  END LOOP;

  FOREACH v_sig IN ARRAY ARRAY[
    'public.platform_context_open(uuid,text,text)',
    'public.platform_context_close(uuid)',
    'public.platform_context_current()',
    'public.platform_view_company_id()',
    'public.platform_support_company_id()'
  ]
  LOOP
    PERFORM _pc_ok(format('privileges: %s is for signed-in callers only', v_sig),
      NOT has_function_privilege('anon', v_sig, 'EXECUTE')
      AND has_function_privilege('authenticated', v_sig, 'EXECUTE')
      AND NOT has_function_privilege('service_role', v_sig, 'EXECUTE'));
  END LOOP;

  PERFORM _pc_ok('privileges: the seams answer false to every caller',
    public.platform_reads_company_data() = false
    AND public.platform_writes_company_data() = false);
END $$;

-- ─── 2. opening ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  co_x constant uuid := _pc_id('company:x');
  co_y constant uuid := _pc_id('company:y');
  u_o  constant uuid := _pc_id('user:owner');
  s_o  constant uuid := _pc_id('session:owner');
  v_out text;
BEGIN
  -- The argument contract raises; everything else is a return value.
  PERFORM _pc_ok('open: an unknown mode is a broken contract (22023)',
    _pc_try(u_o, s_o, format('SELECT platform_context_open(%L, ''peek'')::text', co_x))
      LIKE 'ERR 22023%');
  PERFORM _pc_ok('open: no company is a broken contract (22023)',
    _pc_try(u_o, s_o, 'SELECT platform_context_open(NULL, ''view'')::text')
      LIKE 'ERR 22023%');

  PERFORM _pc_ok('open: a company nobody has is not_found, and not an exception',
    _pc_field(_pc_try(u_o, s_o,
      format('SELECT platform_context_open(%L, ''view'')::text', _pc_id('company:none'))), 'reason') = 'not_found');

  PERFORM _pc_ok('open: a support session without a reason is refused',
    _pc_field(_pc_try(u_o, s_o, format('SELECT platform_context_open(%L, ''support'')::text', co_x)), 'reason')
      = 'reason_required');
  PERFORM _pc_ok('open: a view context with a reason is refused — a read needs no justification',
    _pc_field(_pc_try(u_o, s_o, format('SELECT platform_context_open(%L, ''view'', ''why'')::text', co_x)), 'reason')
      = 'invalid');

  -- Capabilities: business.read opens a view, support.session a support
  -- session, and billing holds neither.
  PERFORM _pc_ok('open: read_only opens a view context',
    _pc_field(_pc_try(_pc_id('user:readonly'), _pc_id('session:readonly'),
      format('SELECT platform_context_open(%L, ''view'')::text', co_x)), 'success') = 'true');
  PERFORM _pc_ok('open: …but not a support session (support.session is the owner''s and support''s)',
    _pc_field(_pc_try(_pc_id('user:readonly'), _pc_id('session:readonly'),
      format('SELECT platform_context_open(%L, ''support'', ''why'')::text', co_x)), 'reason') = 'denied');
  PERFORM _pc_ok('open: billing holds no business.read, so it opens nothing at all',
    _pc_field(_pc_try(_pc_id('user:billing'), _pc_id('session:billing'),
      format('SELECT platform_context_open(%L, ''view'')::text', co_x)), 'reason') = 'denied');
  PERFORM _pc_ok('open: support opens a support session with a reason',
    _pc_field(_pc_try(_pc_id('user:support'), _pc_id('session:support'),
      format('SELECT platform_context_open(%L, ''support'', ''Ticket 1'')::text', co_x)), 'success') = 'true');

  -- A company user is not staff, whatever else it is.
  PERFORM _pc_ok('open: a company administrator is refused',
    _pc_field(_pc_try(_pc_id('user:admin-x'), _pc_id('session:admin-x'),
      format('SELECT platform_context_open(%L, ''view'')::text', co_x)), 'reason') = 'denied');

  -- A token with no session at all cannot be tied to one.
  PERFORM _pc_ok('open: a token without a sign-in session is refused',
    _pc_field(_pc_try(u_o, NULL, format('SELECT platform_context_open(%L, ''view'')::text', co_x)), 'reason')
      = 'no_session');
  -- …and neither is a session id the account does not hold.
  PERFORM _pc_ok('open: another account''s session id is refused',
    _pc_field(_pc_try(u_o, _pc_id('session:support'),
      format('SELECT platform_context_open(%L, ''view'')::text', co_x)), 'reason') = 'no_session');

  -- Nothing above was allowed to persist: every probe rolled back.
  PERFORM _pc_ok('open: the probes above left no context behind',
    (SELECT count(*) FROM app_private.platform_company_contexts) = 0);
END $$;

-- ─── 3. one context at a time ───────────────────────────────────────────────

DO $$
DECLARE
  co_x constant uuid := _pc_id('company:x');
  co_y constant uuid := _pc_id('company:y');
  u_o  constant uuid := _pc_id('user:owner');
  s_o  constant uuid := _pc_id('session:owner');
  v_first  jsonb;
  v_again  jsonb;
  v_out    text;
BEGIN
  PERFORM _pc_as(u_o, s_o);
  v_first := public.platform_context_open(co_x, 'view');
  PERFORM _pc_reset();
  PERFORM _pc_ok('open: a view context on company X',
    (v_first ->> 'success') = 'true' AND (v_first -> 'context' ->> 'mode') = 'view');

  PERFORM _pc_ok('one at a time: a second company is refused while one is open',
    _pc_field(_pc_try(u_o, s_o, format('SELECT platform_context_open(%L, ''view'')::text', co_y)), 'reason')
      = 'context_open');

  PERFORM _pc_as(u_o, s_o);
  v_again := public.platform_context_open(co_x, 'view');
  PERFORM _pc_reset();
  PERFORM _pc_ok('one at a time: asking again for the same company and mode returns the open context',
    (v_again -> 'context' ->> 'id') = (v_first -> 'context' ->> 'id'));
  PERFORM _pc_ok('one at a time: …and does not extend it, so polling cannot hold a session open',
    (v_again -> 'context' ->> 'expires_at') = (v_first -> 'context' ->> 'expires_at'));

  PERFORM _pc_ok('one at a time: exactly one row is open',
    (SELECT count(*) FROM app_private.platform_company_contexts WHERE closed_at IS NULL) = 1);
END $$;

-- ─── 4. reads are confined to the context's company ─────────────────────────

DO $$
DECLARE
  co_x constant uuid := _pc_id('company:x');
  u_o  constant uuid := _pc_id('user:owner');
  s_o  constant uuid := _pc_id('session:owner');
BEGIN
  PERFORM _pc_ok('read: the tenant term answers the context''s company',
    _pc_try(u_o, s_o, 'SELECT get_active_company_id()::text') = co_x::text
    AND _pc_try(u_o, s_o, 'SELECT get_user_company_id()::text') = co_x::text
    AND _pc_try(u_o, s_o, 'SELECT platform_view_company_id()::text') = co_x::text);
  PERFORM _pc_ok('read: …and the support helper says no, because this is a view context',
    _pc_try(u_o, s_o, 'SELECT platform_support_company_id()::text') = '<null>');

  PERFORM _pc_ok('read: company X''s driver and receipt are visible',
    _pc_try(u_o, s_o, format('SELECT count(*)::text FROM drivers WHERE id = %L', _pc_id('driver:x'))) = '1'
    AND _pc_try(u_o, s_o, format('SELECT count(*)::text FROM receipts WHERE id = %L', _pc_id('receipt:x'))) = '1');
  PERFORM _pc_ok('read: company Y''s are not — one company at a time means one company',
    _pc_try(u_o, s_o, format('SELECT count(*)::text FROM drivers WHERE id = %L', _pc_id('driver:y'))) = '0'
    AND _pc_try(u_o, s_o, format('SELECT count(*)::text FROM receipts WHERE id = %L', _pc_id('receipt:y'))) = '0');

  -- The same account, same instant, without the session claim: no context, so
  -- nothing at all. This is what closes 3.3's concession.
  PERFORM _pc_ok('read: the same owner without its session claim reads neither company',
    _pc_try(u_o, NULL, format('SELECT count(*)::text FROM drivers WHERE id = %L', _pc_id('driver:x'))) = '0'
    AND _pc_try(u_o, NULL, format('SELECT count(*)::text FROM drivers WHERE id = %L', _pc_id('driver:y'))) = '0');
  PERFORM _pc_ok('read: and a staff account that has opened nothing reads nothing',
    _pc_try(_pc_id('user:support'), _pc_id('session:support'),
            format('SELECT count(*)::text FROM drivers WHERE id = %L', _pc_id('driver:x'))) = '0');
END $$;

-- ─── 5. a view context writes nothing ───────────────────────────────────────

DO $$
DECLARE
  co_x constant uuid := _pc_id('company:x');
  u_o  constant uuid := _pc_id('user:owner');
  s_o  constant uuid := _pc_id('session:owner');
BEGIN
  PERFORM _pc_ok('view: the role gates are false, so the ten role-gated tables refuse it',
    _pc_try(u_o, s_o, 'SELECT current_role_permits(''drivers'', true)::text') = 'false'
    AND _pc_try(u_o, s_o, 'SELECT current_role_permits(''salaries'', true)::text') = 'false'
    AND _pc_try(u_o, s_o, 'SELECT is_company_admin()::text') = 'false');

  -- drivers is role-gated; car_driver_assignments is one of the twenty-two
  -- tables with no role gate at all, where the trigger is the only refusal.
  PERFORM _pc_ok('view: inserting a driver is refused',
    _pc_try(u_o, s_o, format('INSERT INTO drivers (company_id, name) VALUES (%L, ''PC view'')', co_x))
      LIKE 'ERR P0001%');
  PERFORM _pc_ok('view: …and so is inserting into a table nothing else gates',
    _pc_try(u_o, s_o, format('INSERT INTO car_driver_assignments (company_id, driver_id) VALUES (%L, %L)',
                             co_x, _pc_id('driver:x'))) LIKE 'ERR P0001%');
  PERFORM _pc_ok('view: updating and deleting a driver of the company it is reading are refused',
    _pc_try(u_o, s_o, format('UPDATE drivers SET name = name WHERE id = %L', _pc_id('driver:x')))
      LIKE 'ERR P0001%'
    AND _pc_try(u_o, s_o, format('DELETE FROM drivers WHERE id = %L', _pc_id('driver:x')))
      LIKE 'ERR P0001%');
  PERFORM _pc_ok('view: the Fahrtenbuch and the planning tables are refused the same way',
    _pc_try(u_o, s_o, format('INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by) VALUES (%L, 1, 2026, ''pc.xlsx'', %L)',
                             co_x, u_o)) LIKE 'ERR P0001%'
    AND _pc_try(u_o, s_o, format('UPDATE company_planning_runs SET status = status WHERE company_id = %L', co_x))
      LIKE 'ERR P0001%');
  PERFORM _pc_ok('view: the refusal says what is missing',
    _pc_try(u_o, s_o, format('DELETE FROM drivers WHERE id = %L', _pc_id('driver:x')))
      LIKE '%Support-Sitzung%');
  -- The trigger asks about the caller, not about the row, so a statement that
  -- would have matched nothing is refused too — there is no way to learn from
  -- it whether a row was there.
  PERFORM _pc_ok('view: a write that would match no row is refused just the same',
    _pc_try(u_o, s_o, format('UPDATE drivers SET name = name WHERE id = %L', _pc_id('driver:none')))
      LIKE 'ERR P0001%');
END $$;

-- ─── 5b. …and neither does it write the shell tables a context unlocks ──────
--
-- Three tables of the account shell have the write predicate
--   company_id = get_user_company_id() AND (is_company_admin() OR platform_can(…))
-- which refused a company-less platform account only because the first conjunct
-- was NULL. Answering the open context there completes it, and the capability
-- supplies the rest — so without the trigger on these three, a view context
-- could create a role, give it can_edit on every page through role_permissions,
-- and point a company's profile at it: three writes, no reason recorded, in the
-- mode that is supposed to write nothing.

DO $$
DECLARE
  co_x constant uuid := _pc_id('company:x');
  u_o  constant uuid := _pc_id('user:owner');
  s_o  constant uuid := _pc_id('session:owner');
BEGIN
  PERFORM _pc_ok('view: cannot create a role in the company it is reading',
    _pc_try(u_o, s_o, format('INSERT INTO roles (name, description, company_id, is_system) VALUES (''PC view role'', ''pc'', %L, false)', co_x))
      LIKE 'ERR P0001%');
  PERFORM _pc_ok('view: cannot grant a permission to a role that exists',
    _pc_try(u_o, s_o, format('INSERT INTO role_permissions (role_id, page_key, can_view, can_edit) VALUES (%L, ''salaries'', true, true)', _pc_id('role:x')))
      LIKE 'ERR P0001%');
  -- company_settings is deliberately *not* behind the trigger. Its UPDATE names
  -- no company at all (companies.lifecycle), so an owner edits any tenant's
  -- settings with or without a context and refusing only the INSERT would be
  -- incoherent — and a trigger there refuses platform_subscription_assign,
  -- which names its own company, checks billing.manage and writes its own audit
  -- row that the RAISE would roll back. Recorded as residual, like the matrix
  -- tag, rather than asserted away.
  PERFORM _pc_ok('view: …but companies.lifecycle still edits the company''s settings — residual, tagged for 3.4c/3.13',
    _pc_try(u_o, s_o, format('UPDATE company_settings SET company_name = ''PC view'' WHERE company_id = %L', co_x))
      = 'rows 1');
  PERFORM _pc_ok('view: cannot record an activation-code attempt in the company''s name',
    _pc_try(u_o, s_o, format('INSERT INTO activation_code_attempts (company_id, user_id, input_last4, success, reason, kind) VALUES (%L, %L, NULL, false, ''pc'', ''preview'')', co_x, u_o))
      LIKE 'ERR P0001%');

  -- Recorded, not asserted away: company_users.manage carries no company term
  -- at all (20260917130000's deliberate design), so a staff account may still
  -- point a profile at a role that already exists — with a context and, for a
  -- row it can see, without one. What this section closes is the escalation:
  -- the role and the permissions behind it can no longer be made. Confining the
  -- capability itself is 3.4c's and 3.13's, and matrix.sql tags it.
  PERFORM _pc_ok('view: …but company_users.manage still re-points a profile — residual, tagged for 3.4c/3.13',
    _pc_try(u_o, s_o, format('UPDATE user_profiles SET role_id = %L WHERE user_id = %L',
                             _pc_id('role:x'), _pc_id('user:admin-x'))) = 'rows 1');
END $$;

-- ─── 6. a support session writes, inside its own company ────────────────────

DO $$
DECLARE
  co_x constant uuid := _pc_id('company:x');
  co_y constant uuid := _pc_id('company:y');
  u_o  constant uuid := _pc_id('user:owner');
  s_o  constant uuid := _pc_id('session:owner');
  v_up jsonb;
BEGIN
  PERFORM _pc_as(u_o, s_o);
  v_up := public.platform_context_open(co_x, 'support', 'Ticket 4711');
  PERFORM _pc_reset();
  PERFORM _pc_ok('upgrade: view -> support on the same company is allowed and says why',
    (v_up ->> 'success') = 'true'
    AND (v_up -> 'context' ->> 'mode') = 'support'
    AND (v_up -> 'context' ->> 'reason') = 'Ticket 4711');
  PERFORM _pc_ok('upgrade: the view context it replaced is closed as superseded, and only one is open',
    (SELECT count(*) FROM app_private.platform_company_contexts
      WHERE closed_reason = 'superseded') = 1
    AND (SELECT count(*) FROM app_private.platform_company_contexts WHERE closed_at IS NULL) = 1);

  PERFORM _pc_ok('support: the role gates answer true while the session is open',
    _pc_try(u_o, s_o, 'SELECT current_role_permits(''drivers'', true)::text') = 'true'
    AND _pc_try(u_o, s_o, 'SELECT is_company_admin()::text') = 'true'
    AND _pc_try(u_o, s_o, 'SELECT platform_support_company_id()::text') = co_x::text);

  PERFORM _pc_ok('support: a driver of the company being supported can be written',
    _pc_try(u_o, s_o, format('INSERT INTO drivers (company_id, name) VALUES (%L, ''PC support'')', co_x))
      = 'rows 1'
    AND _pc_try(u_o, s_o, format('UPDATE drivers SET name = ''PC fixed'' WHERE id = %L', _pc_id('driver:x')))
      = 'rows 1');
  PERFORM _pc_ok('support: …and one of the other company cannot',
    _pc_try(u_o, s_o, format('INSERT INTO drivers (company_id, name) VALUES (%L, ''PC support'')', co_y))
      LIKE 'ERR 42501%row-level security%'
    AND _pc_try(u_o, s_o, format('UPDATE drivers SET name = ''PC fixed'' WHERE id = %L', _pc_id('driver:y')))
      = 'rows 0');
  PERFORM _pc_ok('support: a row cannot be moved out of the company being supported',
    _pc_try(u_o, s_o, format('UPDATE drivers SET company_id = %L WHERE id = %L', co_y, _pc_id('driver:x')))
      LIKE 'ERR 42501%');
  PERFORM _pc_ok('support: nor can one be pulled in from the other company',
    _pc_try(u_o, s_o, format('UPDATE drivers SET company_id = %L WHERE id = %L', co_x, _pc_id('driver:y')))
      = 'rows 0');

  -- The shell tables of section 5b, from the other side: what a view context is
  -- refused, a support session carries out — in its own company. company_settings
  -- is here for completeness rather than as a contrast: it carries no refusal
  -- trigger, so a support session writes it for the same reason an owner does
  -- without one.
  PERFORM _pc_ok('support: a role and its permissions can be written for the company being supported',
    _pc_try(u_o, s_o, format('INSERT INTO roles (name, description, company_id, is_system) VALUES (''PC support role'', ''pc'', %L, false)', co_x))
      = 'rows 1'
    AND _pc_try(u_o, s_o, format('INSERT INTO role_permissions (role_id, page_key, can_view, can_edit) VALUES (%L, ''salaries'', true, true)', _pc_id('role:x')))
      = 'rows 1');
  PERFORM _pc_ok('support: …and the company''s settings, but not another company''s role',
    _pc_try(u_o, s_o, format('UPDATE company_settings SET company_name = ''PC support'' WHERE company_id = %L', co_x))
      = 'rows 1'
    AND _pc_try(u_o, s_o, format('INSERT INTO roles (name, description, company_id, is_system) VALUES (''PC no'', ''pc'', %L, false)', co_y))
      LIKE 'ERR 42501%row-level security%');

  -- Everything it wrote is still the company's own data, and the company's
  -- people still see it: the session is a way in, not a second tenant.
  PERFORM _pc_ok('support: what it wrote belongs to the company, and the company reads it',
    _pc_try(_pc_id('user:admin-x'), _pc_id('session:admin-x'),
            format('SELECT count(*)::text FROM drivers WHERE company_id = %L AND name = ''PC fixed''', co_x)) = '1');
END $$;

-- ─── 7. expiry ends it ──────────────────────────────────────────────────────

DO $$
DECLARE
  u_o constant uuid := _pc_id('user:owner');
  s_o constant uuid := _pc_id('session:owner');
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM app_private.platform_company_contexts WHERE closed_at IS NULL;

  UPDATE app_private.platform_company_contexts
     SET opened_at = now() - interval '61 minutes', expires_at = now() - interval '1 minute'
   WHERE id = v_id;

  PERFORM _pc_ok('expiry: the tenant term answers NULL the moment it is past',
    _pc_try(u_o, s_o, 'SELECT get_active_company_id()::text') = '<null>'
    AND _pc_try(u_o, s_o, 'SELECT platform_view_company_id()::text') = '<null>');
  PERFORM _pc_ok('expiry: and the company''s data is gone with it',
    _pc_try(u_o, s_o, format('SELECT count(*)::text FROM drivers WHERE id = %L', _pc_id('driver:x'))) = '0');
  PERFORM _pc_ok('expiry: the role gates fall back to the profile, which is a viewer',
    _pc_try(u_o, s_o, 'SELECT current_role_permits(''drivers'', true)::text') = 'false'
    AND _pc_try(u_o, s_o, 'SELECT is_company_admin()::text') = 'false');

  PERFORM _pc_ok('expiry: nothing has closed the row yet — it is ineffective, not tidied',
    (SELECT closed_at IS NULL FROM app_private.platform_company_contexts WHERE id = v_id));
  PERFORM _pc_ok('expiry: platform_contexts_expire() writes it down',
    app_private.platform_contexts_expire() >= 1
    AND (SELECT closed_reason FROM app_private.platform_company_contexts WHERE id = v_id) = 'expired');
  PERFORM _pc_ok('expiry: …and a new context can be opened again afterwards',
    _pc_field(_pc_try(u_o, s_o, format('SELECT platform_context_open(%L, ''view'')::text', _pc_id('company:y'))),
              'success') = 'true');
END $$;

-- ─── 8. the sign-in session ends it ─────────────────────────────────────────

DO $$
DECLARE
  co_x constant uuid := _pc_id('company:x');
  u_o  constant uuid := _pc_id('user:owner');
  s_o  constant uuid := _pc_id('session:owner');
  v_id uuid;
BEGIN
  PERFORM _pc_as(u_o, s_o);
  PERFORM public.platform_context_open(co_x, 'view');
  PERFORM _pc_reset();

  PERFORM _pc_ok('session: the context is answered to the session that opened it',
    _pc_try(u_o, s_o, 'SELECT platform_view_company_id()::text') = co_x::text);
  PERFORM _pc_ok('session: a second sign-in of the same account inherits nothing',
    _pc_try(u_o, _pc_id('session:owner2'), 'SELECT platform_view_company_id()::text') = '<null>'
    AND _pc_try(u_o, _pc_id('session:owner2'),
                format('SELECT count(*)::text FROM drivers WHERE id = %L', _pc_id('driver:x'))) = '0');

  -- Signing out revokes the refresh token; the access token lives on for a
  -- while, so the context has to end with the session and not with the token.
  DELETE FROM auth.sessions WHERE id = s_o;
  PERFORM _pc_ok('session: when the sign-in session is gone, so is the context',
    _pc_try(u_o, s_o, 'SELECT platform_view_company_id()::text') = '<null>'
    AND _pc_try(u_o, s_o, format('SELECT count(*)::text FROM drivers WHERE id = %L', _pc_id('driver:x'))) = '0');

  INSERT INTO auth.sessions (id, user_id) VALUES (s_o, u_o) ON CONFLICT (id) DO NOTHING;
  UPDATE auth.sessions SET not_after = now() - interval '1 minute' WHERE id = s_o;
  PERFORM _pc_ok('session: an expired session does not carry it either',
    _pc_try(u_o, s_o, 'SELECT platform_view_company_id()::text') = '<null>');
  UPDATE auth.sessions SET not_after = NULL WHERE id = s_o;

  -- Close what section 9 does not need, so its count is about one account.
  SELECT id INTO v_id FROM app_private.platform_company_contexts
   WHERE staff_user_id = u_o AND closed_at IS NULL;
  UPDATE app_private.platform_company_contexts
     SET closed_at = now(), closed_reason = 'manual' WHERE id = v_id;
END $$;

-- ─── 9. a disabled staff row ends it ────────────────────────────────────────

DO $$
DECLARE
  co_x constant uuid := _pc_id('company:x');
  u_s  constant uuid := _pc_id('user:support');
  s_s  constant uuid := _pc_id('session:support');
  v_id uuid;
BEGIN
  PERFORM _pc_as(u_s, s_s);
  PERFORM public.platform_context_open(co_x, 'support', 'Ticket 4712');
  PERFORM _pc_reset();

  SELECT id INTO v_id FROM app_private.platform_company_contexts
   WHERE staff_user_id = u_s AND closed_at IS NULL;

  PERFORM _pc_ok('staff: the support account is inside its session',
    _pc_try(u_s, s_s, 'SELECT platform_support_company_id()::text') = co_x::text
    AND _pc_try(u_s, s_s, format('SELECT count(*)::text FROM receipts WHERE id = %L', _pc_id('receipt:x'))) = '1');

  UPDATE app_private.platform_staff SET disabled_at = now() WHERE user_id = u_s;

  PERFORM _pc_ok('staff: disabling the row ends the session at once',
    _pc_try(u_s, s_s, 'SELECT platform_support_company_id()::text') = '<null>'
    AND _pc_try(u_s, s_s, 'SELECT get_active_company_id()::text') = '<null>'
    AND _pc_try(u_s, s_s, format('SELECT count(*)::text FROM receipts WHERE id = %L', _pc_id('receipt:x'))) = '0');
  PERFORM _pc_ok('staff: …and the trigger writes down that it ended',
    (SELECT closed_reason FROM app_private.platform_company_contexts WHERE id = v_id) = 'staff_disabled');
  PERFORM _pc_ok('staff: the end of the session is in the audit log',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log l
             WHERE l.category = 'support' AND l.action = 'platform_context.close'
               AND l.after_value ->> 'closed_reason' = 'staff_disabled'));

  -- A role that no longer holds the capability loses it the same way: put the
  -- row back as read_only, which may look but not support.
  UPDATE app_private.platform_staff SET disabled_at = NULL, role = 'read_only' WHERE user_id = u_s;
  PERFORM _pc_as(u_s, s_s);
  PERFORM public.platform_context_open(co_x, 'view');
  PERFORM _pc_reset();
  PERFORM _pc_ok('staff: a read_only role opens a view context and holds no write',
    _pc_try(u_s, s_s, 'SELECT platform_view_company_id()::text') = co_x::text
    AND _pc_try(u_s, s_s, 'SELECT platform_support_company_id()::text') = '<null>'
    AND _pc_try(u_s, s_s, format('DELETE FROM receipts WHERE id = %L', _pc_id('receipt:x'))) LIKE 'ERR P0001%');
END $$;

-- ─── 10. closing ────────────────────────────────────────────────────────────

DO $$
DECLARE
  u_s constant uuid := _pc_id('user:support');
  s_s constant uuid := _pc_id('session:support');
  v_out jsonb;
BEGIN
  PERFORM _pc_as(u_s, s_s);
  v_out := public.platform_context_close();
  PERFORM _pc_reset();

  PERFORM _pc_ok('close: the caller closes its own context', (v_out ->> 'success') = 'true');
  PERFORM _pc_ok('close: …and it is marked closed by hand',
    (SELECT count(*) FROM app_private.platform_company_contexts
      WHERE staff_user_id = u_s AND closed_reason = 'manual') = 1);
  PERFORM _pc_ok('close: the company''s data is out of reach again',
    _pc_try(u_s, s_s, format('SELECT count(*)::text FROM receipts WHERE id = %L', _pc_id('receipt:x'))) = '0');
  PERFORM _pc_ok('close: closing again has nothing to close',
    _pc_field(_pc_try(u_s, s_s, 'SELECT platform_context_close()::text'), 'reason') = 'no_context');

  PERFORM _pc_ok('close: no context is left open for anybody',
    (SELECT count(*) FROM app_private.platform_company_contexts WHERE closed_at IS NULL) = 0);
END $$;

-- ─── 11. the audit log ──────────────────────────────────────────────────────

DO $$
DECLARE
  co_x constant uuid := _pc_id('company:x');
  u_o  constant uuid := _pc_id('user:owner');
BEGIN
  -- Two refusals that are allowed to stand: every probe above ran inside
  -- _pc_try, which rolls back, and a rolled-back refusal takes its audit row
  -- with it. These two are what the checks below read.
  PERFORM _pc_as(u_o, _pc_id('session:owner'));
  PERFORM public.platform_context_open(co_x, 'support');          -- no reason
  PERFORM _pc_reset();
  PERFORM _pc_as(_pc_id('user:billing'), _pc_id('session:billing'));
  PERFORM public.platform_context_open(co_x, 'view');             -- no capability
  PERFORM _pc_reset();

  PERFORM _pc_ok('audit: opening and closing are recorded in the support category',
    (SELECT count(*) FROM app_private.platform_audit_log
      WHERE category = 'support' AND action = 'platform_context.open' AND outcome = 'ok') >= 3
    AND (SELECT count(*) FROM app_private.platform_audit_log
          WHERE category = 'support' AND action = 'platform_context.close' AND outcome = 'ok') >= 2);
  PERFORM _pc_ok('audit: a refusal is recorded too, with its reason',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log
             WHERE action = 'platform_context.open'
               AND after_value ->> 'reason' = 'reason_required'));
  PERFORM _pc_ok('audit: a caller without the capability leaves a denied row',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log
             WHERE action = 'platform_context.open' AND outcome = 'denied'
               AND actor_user_id = _pc_id('user:billing')));
  PERFORM _pc_ok('audit: the row names the company and the actor''s role',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log
             WHERE action = 'platform_context.open' AND outcome = 'ok'
               AND actor_user_id = u_o AND actor_role = 'owner'
               AND company_id = _pc_id('company:x')));

  -- The edge functions' door stays shut to these actions: the allow-list of
  -- 20260916150000 refuses anything the functions do not send, which is
  -- stricter than a reserved namespace.
  PERFORM _pc_ok('audit: an edge function cannot forge a support-session row',
    _pc_try(u_o, _pc_id('session:owner'),
            'SELECT platform_audit_record(''write'', ''platform_context.open'', ''ok'')::text')
      LIKE 'ERR 22023%');
END $$;

-- ─── 12. whoami ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  co_x constant uuid := _pc_id('company:x');
  u_o  constant uuid := _pc_id('user:owner');
  s_o  constant uuid := _pc_id('session:owner');
  v_who jsonb;
BEGIN
  PERFORM _pc_as(u_o, s_o);
  v_who := public.platform_whoami();
  PERFORM _pc_reset();
  PERFORM _pc_ok('whoami: no context open, so the field is null',
    (v_who ->> 'role') = 'owner' AND v_who -> 'company_context' = 'null'::jsonb);

  PERFORM _pc_as(u_o, s_o);
  PERFORM public.platform_context_open(co_x, 'support', 'Ticket 4713');
  v_who := public.platform_whoami();
  PERFORM _pc_reset();

  PERFORM _pc_ok('whoami: it carries the open context, its mode, its reason and what is left of it',
    (v_who -> 'company_context' ->> 'company_id') = co_x::text
    AND (v_who -> 'company_context' ->> 'company_name') = 'PC X'
    AND (v_who -> 'company_context' ->> 'mode') = 'support'
    AND (v_who -> 'company_context' ->> 'reason') = 'Ticket 4713'
    AND ((v_who -> 'company_context' ->> 'seconds_remaining')::int) BETWEEN 3500 AND 3600);
  PERFORM _pc_ok('whoami: a company user gets no role and no context',
    _pc_try(_pc_id('user:admin-x'), _pc_id('session:admin-x'),
            'SELECT (platform_whoami() ->> ''role'')') = '<null>');
END $$;

-- ─── 13. a role row cannot be pulled into the company being supported ───────

DO $$
DECLARE
  co_x constant uuid := _pc_id('company:x');
  u_o  constant uuid := _pc_id('user:owner');
  s_o  constant uuid := _pc_id('session:owner');
BEGIN
  -- company_users.manage names no company by design, and the shell term now
  -- answers the context — so without the pin this UPDATE would satisfy the
  -- WITH CHECK and move company Y's role into company X.
  PERFORM _pc_ok('roles: a support session cannot pull another company''s role into the one it is supporting',
    _pc_try(u_o, s_o, format('UPDATE roles SET company_id = %L WHERE id = %L', co_x, _pc_id('role:y')))
      LIKE 'ERR P0001%');
  PERFORM _pc_ok('roles: nor push its own out',
    _pc_try(u_o, s_o, format('UPDATE roles SET company_id = %L WHERE id = %L',
                             _pc_id('company:y'), _pc_id('role:x'))) LIKE 'ERR P0001%');
  PERFORM _pc_ok('roles: the company''s own role is still readable and editable inside the session',
    _pc_try(u_o, s_o, format('SELECT count(*)::text FROM roles WHERE id = %L', _pc_id('role:x'))) = '1'
    AND _pc_try(u_o, s_o, format('UPDATE roles SET name = ''PC renamed'' WHERE id = %L', _pc_id('role:x')))
      = 'rows 1');
END $$;

DO $$ BEGIN RAISE NOTICE '── platform contexts: all checks passed ──'; END $$;

ROLLBACK;
