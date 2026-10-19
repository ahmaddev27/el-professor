/*
  Who handed the cash back (migration 20261019110000).

  Runs after the files before it, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end.

  What is covered, in order:

    1. shape       RLS on, exactly the four policies for authenticated, each
                   write asks the income page and the tenant term, both context
                   triggers, anon holds nothing, the service role only reads,
                   the guard is executable by no API role and runs as the caller
    2. roles       a viewer reads and writes nothing, an editor (who holds
                   can_edit on income) writes; reading is never role-gated
    3. tenants     nobody reads, writes or moves a row of another company, and
                   an insert into another company is refused
    4. guard       the driver is resolved when the name matches exactly one
                   ACTIVE driver (case and repeated spaces ignored) and is NULL
                   for two matches, none, or an inactive driver; the writer is
                   stamped by the database whatever the client sent
    5. amount      0 is an answer and is stored, a negative is refused, the key
                   collides, and an upsert on the key replaces the amount
    6. state       a suspended company's administrator reads and writes nothing
    7. till        writing, changing and deleting hand-overs moves no row of
                   cash_movements, cash_transactions, salary_payments or
                   salary_cash_receipts, and the guard names none of them
    8. view        a view context reads the company it opened and writes nothing
    9. support     a support session writes as the company's administrator and
                   each row leaves exactly one audit row, amount in clear
   10. no context  a platform owner with no context reads and writes none of it

  The matrix lines are in tests/rls/matrix.sql. A probe in this file whose
  refusal and whose lookup raise the same class would measure nothing, so each
  refusal below states which class it expects and a different mistake raises a
  different one.
*/

\set ON_ERROR_STOP on

BEGIN;

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

CREATE OR REPLACE FUNCTION _ah_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _ah_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('ah:' || p_what)::uuid $$;

CREATE OR REPLACE FUNCTION _ah_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

CREATE OR REPLACE FUNCTION _ah_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _ah_reset();
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

/* Run p_sql as that caller in a subtransaction that is always rolled back. */
CREATE OR REPLACE FUNCTION _ah_try(p_user uuid, p_session uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _ah_as(p_user, p_session);
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
  PERFORM _ah_reset();
  RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION _ah_mark() RETURNS bigint
LANGUAGE sql AS $$ SELECT coalesce(max(l.id), 0) FROM app_private.platform_audit_log l $$;

CREATE OR REPLACE FUNCTION _ah_rows(p_since bigint, p_action text DEFAULT NULL) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*)
    FROM app_private.platform_audit_log l
   WHERE l.id > p_since
     AND l.action ~ '^support_write\.'
     AND (p_action IS NULL OR l.action = p_action)
$$;

-- ─── principals and data ────────────────────────────────────────────────────

CREATE TEMP TABLE _ah_who (who text PRIMARY KEY, uid uuid NOT NULL);
INSERT INTO _ah_who VALUES
  ('admin-a',  'a0000000-0000-4000-8000-000000000001'),
  ('editor-a', 'a0000000-0000-4000-8000-000000000002'),
  ('viewer-a', 'a0000000-0000-4000-8000-000000000003'),
  ('admin-b',  'b0000000-0000-4000-8000-000000000001'),
  ('super',    '50000000-0000-4000-8000-000000000001');

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
VALUES (_ah_id('company:suspended'), 'AH suspended', 'ah-suspended', 'approved', 'suspended', 'basic', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT _ah_id('user:' || v.who), 'ah-' || v.who || '@test.invalid', now()
FROM (VALUES ('admin-suspended'), ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
SELECT _ah_id('user:' || v.who), 'ah-' || v.who || '@test.invalid', 'AH ' || v.who, v.role,
       (SELECT r.id FROM roles r WHERE r.name = v.role AND r.company_id IS NULL),
       v.company_id, 'active'
FROM (VALUES
  ('admin-suspended', 'admin',  _ah_id('company:suspended')),
  ('owner-view',      'viewer', NULL::uuid),
  ('owner-support',   'viewer', NULL::uuid)
) AS v(who, role, company_id)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES (_ah_id('user:owner-view'),    'owner', 'ah'),
       (_ah_id('user:owner-support'), 'owner', 'ah')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
SELECT _ah_id('session:' || v.who), _ah_id('user:' || v.who)
FROM (VALUES ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

-- Drivers of company A for the guard's name resolution: one unique active
-- name, two active drivers sharing a name, one inactive driver. One driver in
-- company B who has A's unique name, to show the lookup stays in the company.
INSERT INTO drivers (id, company_id, name, status) VALUES
  (_ah_id('driver:unique'),   'c0000000-0000-4000-8000-00000000000a', 'AH Anna Unique',  'active'),
  (_ah_id('driver:twin1'),    'c0000000-0000-4000-8000-00000000000a', 'AH Twin',         'active'),
  (_ah_id('driver:twin2'),    'c0000000-0000-4000-8000-00000000000a', 'AH Twin',         'active'),
  (_ah_id('driver:inactive'), 'c0000000-0000-4000-8000-00000000000a', 'AH Inactive Ina', 'inactive'),
  (_ah_id('driver:other'),    'c0000000-0000-4000-8000-00000000000b', 'AH Only In B',    'active')
ON CONFLICT (id) DO NOTHING;

-- One row per company, written as the table owner (RLS does not apply).
INSERT INTO abrechnung_handovers (id, company_id, year, month, week_number, driver_name, amount) VALUES
  (_ah_id('row:a'),         'c0000000-0000-4000-8000-00000000000a', 2099, 1, 1, 'AH Anna Unique',  30.00),
  (_ah_id('row:b'),         'c0000000-0000-4000-8000-00000000000b', 2099, 1, 1, 'AH Only In B',    12.50),
  (_ah_id('row:suspended'), _ah_id('company:suspended'),            2099, 1, 1, 'AH Susi',         7.00);

-- ─── 1. shape ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_cmd text;
  v_src text;
BEGIN
  PERFORM _ah_ok('shape: abrechnung_handovers has row level security on',
    (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.abrechnung_handovers'::regclass));

  PERFORM _ah_ok('shape: exactly the four policies <table>_select|insert|update|delete, for authenticated',
    (SELECT array_agg(p.policyname::text ORDER BY p.policyname)
       FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'abrechnung_handovers')
      = ARRAY['abrechnung_handovers_delete', 'abrechnung_handovers_insert',
              'abrechnung_handovers_select', 'abrechnung_handovers_update']
    AND NOT EXISTS (SELECT 1 FROM pg_policies p
                     WHERE p.schemaname = 'public' AND p.tablename = 'abrechnung_handovers'
                       AND p.roles <> ARRAY['authenticated']::name[]));

  FOREACH v_cmd IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    SELECT coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') INTO v_src
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = 'abrechnung_handovers' AND p.cmd = v_cmd;
    PERFORM _ah_ok(format('shape: the %s policy asks the income page and the active company', v_cmd),
      v_src ~ 'current_role_permits\(''income''' AND v_src ~ 'get_active_company_id'
      AND v_src !~ 'cash-balance' AND v_src !~ 'user_profiles|is_user_super_admin');
  END LOOP;

  PERFORM _ah_ok('shape: the select policy asks the active company and no role',
    (SELECT coalesce(p.qual, '') ~ 'get_active_company_id' AND coalesce(p.qual, '') !~ 'current_role_permits'
       FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'abrechnung_handovers' AND p.cmd = 'SELECT'));

  PERFORM _ah_ok('shape: UPDATE states one predicate as USING and as WITH CHECK',
    (SELECT p.qual = p.with_check FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = 'abrechnung_handovers' AND p.cmd = 'UPDATE'));

  PERFORM _ah_ok('shape: both context triggers are on, enabled, with the right timing',
    EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = 'public.abrechnung_handovers'::regclass
              AND g.tgname = 'refuse_read_only_context_write' AND g.tgtype = 30 AND g.tgenabled = 'O')
    AND EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = 'public.abrechnung_handovers'::regclass
              AND g.tgname = 'record_support_write' AND g.tgtype = 29 AND g.tgenabled = 'O'));

  PERFORM _ah_ok('shape: anon holds nothing; the service role only reads',
    NOT has_table_privilege('anon', 'public.abrechnung_handovers', 'SELECT,INSERT,UPDATE,DELETE')
    AND has_table_privilege('service_role', 'public.abrechnung_handovers', 'SELECT')
    AND NOT has_table_privilege('service_role', 'public.abrechnung_handovers', 'INSERT,UPDATE,DELETE'));

  PERFORM _ah_ok('shape: the guard is SECURITY INVOKER and executable by no API role',
    NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'app_private.abrechnung_handovers_guard()'::regprocedure)
    AND NOT has_function_privilege('anon', 'app_private.abrechnung_handovers_guard()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'app_private.abrechnung_handovers_guard()', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'app_private.abrechnung_handovers_guard()', 'EXECUTE'));

  PERFORM _ah_ok('shape: no page key was created for the Abrechnung',
    NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE page_key IN ('abrechnung', 'abrechnung-handovers')));
END $$;

-- ─── 2. roles: reading is open, writing asks the income page ────────────────

DO $$
DECLARE
  co_a     constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  editor   constant uuid := 'a0000000-0000-4000-8000-000000000002';
  viewer   constant uuid := 'a0000000-0000-4000-8000-000000000003';
  v_ins    text;
BEGIN
  v_ins := format('INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount) VALUES (%L, 2099, 2, 1, %L, 5)',
                  co_a, 'AH Role Probe');

  PERFORM _ah_ok('roles: viewer, editor and admin all read company A''s row',
    _ah_try(viewer,  NULL, format('SELECT count(*)::text FROM abrechnung_handovers WHERE id = %L', _ah_id('row:a'))) = '1'
    AND _ah_try(editor,  NULL, format('SELECT count(*)::text FROM abrechnung_handovers WHERE id = %L', _ah_id('row:a'))) = '1'
    AND _ah_try(admin_a, NULL, format('SELECT count(*)::text FROM abrechnung_handovers WHERE id = %L', _ah_id('row:a'))) = '1');

  PERFORM _ah_ok('roles: a viewer''s INSERT is refused by the row-level policy (42501)',
    _ah_try(viewer, NULL, v_ins) LIKE 'ERR 42501%row-level security%');
  PERFORM _ah_ok('roles: …and its UPDATE and DELETE reach no row (the USING clause)',
    _ah_try(viewer, NULL, format('UPDATE abrechnung_handovers SET amount = 1 WHERE id = %L', _ah_id('row:a'))) = 'rows 0'
    AND _ah_try(viewer, NULL, format('DELETE FROM abrechnung_handovers WHERE id = %L', _ah_id('row:a'))) = 'rows 0');

  PERFORM _ah_ok('roles: an editor inserts, updates and deletes',
    _ah_try(editor, NULL, v_ins) = 'rows 1'
    AND _ah_try(editor, NULL, format('UPDATE abrechnung_handovers SET amount = 1 WHERE id = %L', _ah_id('row:a'))) = 'rows 1'
    AND _ah_try(editor, NULL, format('DELETE FROM abrechnung_handovers WHERE id = %L', _ah_id('row:a'))) = 'rows 1');
  PERFORM _ah_ok('roles: an administrator inserts',
    _ah_try(admin_a, NULL, v_ins) = 'rows 1');
END $$;

-- ─── 3. tenants ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b    constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  admin_b constant uuid := 'b0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _ah_ok('tenants: each administrator reads only its own company''s row',
    _ah_try(admin_a, NULL, format('SELECT count(*)::text FROM abrechnung_handovers WHERE id = %L', _ah_id('row:b'))) = '0'
    AND _ah_try(admin_b, NULL, format('SELECT count(*)::text FROM abrechnung_handovers WHERE id = %L', _ah_id('row:a'))) = '0'
    AND _ah_try(admin_b, NULL, format('SELECT count(*)::text FROM abrechnung_handovers WHERE id = %L', _ah_id('row:b'))) = '1');
  PERFORM _ah_ok('tenants: nobody updates or deletes another company''s row',
    _ah_try(admin_b, NULL, format('UPDATE abrechnung_handovers SET amount = 1 WHERE id = %L', _ah_id('row:a'))) = 'rows 0'
    AND _ah_try(admin_b, NULL, format('DELETE FROM abrechnung_handovers WHERE id = %L', _ah_id('row:a'))) = 'rows 0');
  PERFORM _ah_ok('tenants: an insert naming another company is refused (42501)',
    _ah_try(admin_a, NULL, format('INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount) VALUES (%L, 2099, 3, 1, %L, 5)',
                                  co_b, 'AH Smuggle')) LIKE 'ERR 42501%row-level security%');
  -- The move is probed properly in matrix.sql (a cursor, so the new row also has
  -- to be visible). Here the plain form must at least be refused with the same class.
  PERFORM _ah_ok('tenants: pointing a row at the other company is refused (42501)',
    _ah_try(admin_a, NULL, format('UPDATE abrechnung_handovers SET company_id = %L WHERE id = %L', co_b, _ah_id('row:a')))
      LIKE 'ERR 42501%row-level security%');
END $$;

-- ─── 4. the guard: the driver and the writer ────────────────────────────────

DO $$
DECLARE
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  editor  constant uuid := 'a0000000-0000-4000-8000-000000000002';
  r       abrechnung_handovers%ROWTYPE;
BEGIN
  -- Through the door the screen uses, as an editor, in this transaction.
  PERFORM _ah_as(editor);
  INSERT INTO abrechnung_handovers (id, company_id, year, month, week_number, driver_name, amount, confirmed_by, updated_by) VALUES
    (_ah_id('g:unique'),   co_a, 2099, 4, 1, 'AH Anna Unique',  1, admin_a, admin_a),
    (_ah_id('g:spaces'),   co_a, 2099, 4, 2, '  ah   ANNA  unique ', 1, NULL, NULL),
    (_ah_id('g:twin'),     co_a, 2099, 4, 3, 'AH Twin',         1, NULL, NULL),
    (_ah_id('g:none'),     co_a, 2099, 4, 4, 'AH Nobody',       1, NULL, NULL),
    (_ah_id('g:inactive'), co_a, 2099, 4, 5, 'AH Inactive Ina', 1, NULL, NULL);
  PERFORM _ah_reset();
  -- As the table's owner, where RLS hides no driver: under the editor's own
  -- policies a driver of company B is invisible anyway, so the guard's explicit
  -- company term would be untested. Without it this name would resolve to B's driver.
  INSERT INTO abrechnung_handovers (id, company_id, year, month, week_number, driver_name, amount)
  VALUES (_ah_id('g:otherco'), co_a, 2099, 4, 6, 'AH Only In B', 1);

  PERFORM _ah_ok('guard: a name matching exactly one active driver resolves to it',
    (SELECT driver_id FROM abrechnung_handovers WHERE id = _ah_id('g:unique')) = _ah_id('driver:unique'));
  PERFORM _ah_ok('guard: case and repeated spaces are ignored, as the reminder facts do',
    (SELECT driver_id FROM abrechnung_handovers WHERE id = _ah_id('g:spaces')) = _ah_id('driver:unique'));
  PERFORM _ah_ok('guard: two active drivers with that name resolve to nobody',
    (SELECT driver_id IS NULL FROM abrechnung_handovers WHERE id = _ah_id('g:twin')));
  PERFORM _ah_ok('guard: an unmatched name resolves to nobody and is still recorded',
    (SELECT driver_id IS NULL FROM abrechnung_handovers WHERE id = _ah_id('g:none')));
  PERFORM _ah_ok('guard: an inactive driver resolves to nobody',
    (SELECT driver_id IS NULL FROM abrechnung_handovers WHERE id = _ah_id('g:inactive')));
  PERFORM _ah_ok('guard: the lookup stays inside the company (a driver of company B is not found)',
    (SELECT driver_id IS NULL FROM abrechnung_handovers WHERE id = _ah_id('g:otherco')));

  PERFORM _ah_ok('guard: the writer is stamped by the database, whatever the client sent',
    (SELECT confirmed_by = editor AND updated_by = editor FROM abrechnung_handovers WHERE id = _ah_id('g:unique')));

  -- An update by another writer changes updated_by and never confirmed_by.
  PERFORM _ah_as(admin_a);
  UPDATE abrechnung_handovers SET amount = 2, confirmed_by = admin_a WHERE id = _ah_id('g:unique');
  PERFORM _ah_reset();
  SELECT * INTO r FROM abrechnung_handovers WHERE id = _ah_id('g:unique');
  PERFORM _ah_ok('guard: an update stamps updated_by and cannot rewrite who confirmed',
    r.amount = 2 AND r.updated_by = admin_a AND r.confirmed_by = editor);
END $$;

-- ─── 5. the amount and the key ──────────────────────────────────────────────

DO $$
DECLARE
  co_a   constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  editor constant uuid := 'a0000000-0000-4000-8000-000000000002';
  v_row  text := 'INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount) VALUES (%L, 2099, 5, 1, %L, %s)';
BEGIN
  PERFORM _ah_ok('amount: 0 is a real answer and is stored',
    _ah_try(editor, NULL, format(v_row, co_a, 'AH Zero', '0')) = 'rows 1');
  PERFORM _ah_ok('amount: a negative amount is refused by the check (23514)',
    _ah_try(editor, NULL, format(v_row, co_a, 'AH Neg', '-0.01')) LIKE 'ERR 23514%');
  PERFORM _ah_ok('amount: month 13, week 0 and an empty name are refused (23514)',
    _ah_try(editor, NULL, format('INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount) VALUES (%L, 2099, 13, 1, %L, 1)', co_a, 'AH X')) LIKE 'ERR 23514%'
    AND _ah_try(editor, NULL, format('INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount) VALUES (%L, 2099, 5, 0, %L, 1)', co_a, 'AH X')) LIKE 'ERR 23514%'
    AND _ah_try(editor, NULL, format('INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount) VALUES (%L, 2099, 5, 1, %L, 1)', co_a, '   ')) LIKE 'ERR 23514%');

  -- The key collides: the same week of the same driver cannot be recorded twice.
  INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount)
  VALUES (co_a, 2099, 6, 1, 'AH Dup', 10);
  PERFORM _ah_ok('amount: the same company, week and driver name collides (23505)',
    _ah_try(editor, NULL, format('INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount) VALUES (%L, 2099, 6, 1, %L, 5)', co_a, 'AH Dup')) LIKE 'ERR 23505%');
  PERFORM _ah_ok('amount: a different week of the same driver does not',
    _ah_try(editor, NULL, format('INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount) VALUES (%L, 2099, 6, 2, %L, 5)', co_a, 'AH Dup')) = 'rows 1');

  -- The screen's upsert on the key, as an editor: it needs SELECT, INSERT and
  -- UPDATE to agree.
  PERFORM _ah_ok('amount: an upsert on the key replaces the amount in place',
    _ah_try(editor, NULL, format($q$WITH u AS (
        INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount)
        VALUES (%L, 2099, 6, 1, 'AH Dup', 99.50)
        ON CONFLICT (company_id, year, month, week_number, driver_name) DO UPDATE SET amount = EXCLUDED.amount
        RETURNING amount)
      SELECT amount::text FROM u$q$, co_a)) = '99.50');
END $$;

-- ─── 6. state: a suspended company reads and writes nothing ─────────────────

DO $$
DECLARE
  u constant uuid := _ah_id('user:admin-suspended');
BEGIN
  PERFORM _ah_ok('state: a suspended company''s administrator reads nothing',
    _ah_try(u, NULL, 'SELECT count(*)::text FROM abrechnung_handovers') = '0');
  PERFORM _ah_ok('state: …and writes nothing (42501 on insert, no row on update)',
    _ah_try(u, NULL, format('INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount) VALUES (%L, 2099, 7, 1, %L, 1)',
                            _ah_id('company:suspended'), 'AH S')) LIKE 'ERR 42501%row-level security%'
    AND _ah_try(u, NULL, format('UPDATE abrechnung_handovers SET amount = 1 WHERE id = %L', _ah_id('row:suspended'))) = 'rows 0');
END $$;

-- ─── 7. the till does not move ──────────────────────────────────────────────

DO $$
DECLARE
  co_a   constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  editor constant uuid := 'a0000000-0000-4000-8000-000000000002';
  v_before text;
  v_after  text;
  v_src    text;
  v_sql    text := $q$SELECT concat_ws('|',
      (SELECT count(*) FROM cash_movements),
      (SELECT count(*) FROM cash_transactions),
      (SELECT count(*) FROM salary_payments),
      (SELECT count(*) FROM salary_cash_receipts),
      (SELECT count(*) FROM income),
      (SELECT count(*) FROM receipts),
      (SELECT coalesce(sum(amount), 0) FROM income),
      (SELECT coalesce(sum(expense), 0) FROM receipts))$q$;
BEGIN
  EXECUTE v_sql INTO v_before;
  PERFORM _ah_as(editor);
  INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount)
  VALUES (co_a, 2099, 8, 1, 'AH Till', 40);
  UPDATE abrechnung_handovers SET amount = 25 WHERE company_id = co_a AND driver_name = 'AH Till';
  DELETE FROM abrechnung_handovers WHERE company_id = co_a AND driver_name = 'AH Till';
  PERFORM _ah_reset();
  EXECUTE v_sql INTO v_after;
  PERFORM _ah_ok(format('till: an insert, an update and a delete of a hand-over move no ledger, income or receipt row or sum [%s]', v_before),
    v_before = v_after);

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'app_private.abrechnung_handovers_guard()'::regprocedure;
  PERFORM _ah_ok('till: the guard names none of the ledger tables',
    v_src !~* 'cash_movements|cash_transactions|salary_payments|salary_cash_receipts|income|receipts');
  PERFORM _ah_ok('till: no trigger of another table is fired by the table (it carries its own three only)',
    (SELECT array_agg(g.tgname::text ORDER BY g.tgname) FROM pg_trigger g
      WHERE g.tgrelid = 'public.abrechnung_handovers'::regclass AND NOT g.tgisinternal)
      = ARRAY['abrechnung_handovers_guard', 'record_support_write', 'refuse_read_only_context_write']);
  PERFORM _ah_ok('till: no ledger table is referenced by a foreign key from the hand-overs',
    NOT EXISTS (SELECT 1 FROM pg_constraint k
                 WHERE k.conrelid = 'public.abrechnung_handovers'::regclass AND k.contype = 'f'
                   AND k.confrelid::regclass::text NOT IN ('companies', 'drivers')));
END $$;

-- ─── 8. a view context reads and writes nothing ─────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u    constant uuid := _ah_id('user:owner-view');
  s    constant uuid := _ah_id('session:owner-view');
  v_open jsonb;
  v_mark bigint;
BEGIN
  PERFORM _ah_as(u, s);
  v_open := public.platform_context_open(co_a, 'view');
  PERFORM _ah_reset();
  PERFORM _ah_ok('view: the owner opens a view context on company A', (v_open ->> 'success') = 'true');

  PERFORM _ah_ok('view: it reads company A''s row and none of company B''s',
    _ah_try(u, s, format('SELECT count(*)::text FROM abrechnung_handovers WHERE id = %L', _ah_id('row:suspended'))) = '0'
    AND _ah_try(u, s, format('SELECT count(*)::text FROM abrechnung_handovers WHERE id = %L', _ah_id('row:b'))) = '0'
    AND _ah_try(u, s, 'SELECT (count(*) > 0)::text FROM abrechnung_handovers WHERE company_id = ' || quote_literal(co_a)) = 'true');

  v_mark := _ah_mark();
  PERFORM _ah_ok('view: every write is refused by the statement trigger, with 3.4a''s sentence',
    _ah_try(u, s, format('UPDATE abrechnung_handovers SET amount = 1 WHERE company_id = %L', co_a)) LIKE 'ERR P0001 Nur-Lese-Ansicht:%'
    AND _ah_try(u, s, format('INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount) VALUES (%L, 2099, 9, 1, %L, 1)', co_a, 'AH V')) LIKE 'ERR P0001 Nur-Lese-Ansicht:%'
    AND _ah_try(u, s, format('DELETE FROM abrechnung_handovers WHERE company_id = %L', co_a)) LIKE 'ERR P0001 Nur-Lese-Ansicht:%');
  PERFORM _ah_ok('view: …and nothing is recorded for the refusals', _ah_rows(v_mark) = 0);
END $$;

-- ─── 9. a support session writes, and every row is recorded ─────────────────

DO $$
DECLARE
  co_a  constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b  constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  u     constant uuid := _ah_id('user:owner-support');
  s     constant uuid := _ah_id('session:owner-support');
  v_open jsonb;
  v_mark bigint;
  v_rows bigint;
  r      app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _ah_as(u, s);
  v_open := public.platform_context_open(co_a, 'support', 'Ticket Abrechnung');
  PERFORM _ah_reset();
  PERFORM _ah_ok('support: the owner opens a support session on company A', (v_open ->> 'success') = 'true');

  v_mark := _ah_mark();
  PERFORM _ah_as(u, s);
  INSERT INTO abrechnung_handovers (id, company_id, year, month, week_number, driver_name, amount)
  VALUES (_ah_id('row:support'), co_a, 2099, 10, 1, 'AH Support', 17.25);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM _ah_reset();
  PERFORM _ah_ok('support: the session inserts a hand-over', v_rows = 1);
  PERFORM _ah_ok('support: exactly one audit row for it', _ah_rows(v_mark) = 1);
  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _ah_ok('support: category support, the table and operation, the company and the row',
    r.category = 'support' AND r.action = 'support_write.abrechnung_handovers.insert' AND r.outcome = 'ok'
    AND r.company_id = co_a AND r.target_id = _ah_id('row:support')::text);
  PERFORM _ah_ok('support: the amount and the name are copied in clear, as the header records',
    (r.after_value -> 'values' ->> 'amount')::numeric = 17.25
    AND (r.after_value -> 'values' ->> 'driver_name') = 'AH Support');

  v_mark := _ah_mark();
  PERFORM _ah_ok('support: another company''s insert is refused by RLS and not recorded',
    _ah_try(u, s, format('INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount) VALUES (%L, 2099, 10, 2, %L, 1)', co_b, 'AH X')) LIKE 'ERR 42501%row-level security%'
    AND _ah_rows(v_mark) = 0);
END $$;

-- ─── 10. a platform owner with no context ───────────────────────────────────

DO $$
DECLARE
  u constant uuid := '50000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _ah_ok('no context: super reads nothing',
    _ah_try(u, NULL, 'SELECT count(*)::text FROM abrechnung_handovers') = '0');
  PERFORM _ah_ok('no context: …and writes nothing',
    _ah_try(u, NULL, format('UPDATE abrechnung_handovers SET amount = 5 WHERE id = %L', _ah_id('row:a'))) = 'rows 0'
    AND _ah_try(u, NULL, format('INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount) VALUES (%L, 2099, 11, 1, %L, 1)',
                                'c0000000-0000-4000-8000-00000000000a', 'AH Z')) LIKE 'ERR 42501%row-level security%');
END $$;

DO $$ BEGIN RAISE NOTICE '── abrechnung hand-overs: all checks passed ──'; END $$;

ROLLBACK;
