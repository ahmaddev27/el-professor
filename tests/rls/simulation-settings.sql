-- The simulator's company settings (FleetBook round 8, section 5 and section 3;
-- migration 20261127200000), public.company_simulation_settings.
--
-- Runs after the files before it, against the same throwaway database, as
-- supabase_admin. Every check raises on failure; a silent run is a pass. The
-- whole file is one transaction rolled back at the end.
--
-- NOT RUN WHEN WRITTEN: this file needs the Docker-backed kit
-- (`npm run test:rls` on the VPS). It follows tests/rls/monthly-revenue-share.sql
-- helper for helper, plus one DISCARD PLANS per principal (CLAUDE.md, the plan
-- cache: a probe run after the owner has run the same path is not a probe).
--
-- What is covered, in order (section 12, class 25: multi-tenant isolation):
--   1. shape       RLS on, exactly the four policies, every write asking an
--                  administrator, one predicate as USING and WITH CHECK, both
--                  tenant triggers, anon and service_role hold nothing
--   2. read/write  a company administrator reads and writes its own row; a
--                  viewer and an editor read it and write nothing; an
--                  administrator of the other company reaches neither; anon is
--                  refused outright; a platform owner with no context reaches
--                  nothing
--   3. move        re-pointing company_id is refused by WITH CHECK, probed with
--                  SELECT ... FOR UPDATE and UPDATE ... WHERE CURRENT OF, and a
--                  control loosens the WITH CHECK and requires the move to then
--                  succeed. One row per company, so the control first clears
--                  the target company's own row (as the owner, rolled back),
--                  or it would measure the unique constraint, not the policy.
--   4. values      fixed 30..33 and a seeded random row store; 29, 34, a fixed
--                  row with a seed, a random row without one, an unknown mode
--                  or scope, a negative seed and a percent with no mode are
--                  refused; return_to_base defaults to false and is NOT NULL
--   5. stamp       created_by / updated_by are the caller's, never the client's
--   6. owner       every statement a principal is refused above is run as the
--                  owner and must succeed, so a refusal is never a malformed
--                  statement in disguise

\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION _ss_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _ss_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('ss:' || p_what)::uuid $$;

CREATE OR REPLACE FUNCTION _ss_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

-- Become a signed-in caller with a password sign-in, or anon when NULL. The
-- plans the owner warmed are discarded first, so the principal is parsed as
-- itself.
CREATE OR REPLACE FUNCTION _ss_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _ss_reset();
  EXECUTE 'DISCARD PLANS';
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

-- Run p_sql as that caller (or as the owner when p_owner) in a subtransaction
-- that is always rolled back; return the scalar it answered, `rows N`, or
-- `ERR <sqlstate> <message>`.
CREATE OR REPLACE FUNCTION _ss_try(p_user uuid, p_sql text, p_owner boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    IF p_owner THEN PERFORM _ss_reset(); ELSE PERFORM _ss_as(p_user); END IF;
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
  PERFORM _ss_reset();
  RETURN v_out;
END $$;

-- Move a row to another company the way matrix.sql does. The target company's
-- own row is deleted first as the owner, inside the rolled-back
-- subtransaction, because one row per company would otherwise turn every
-- successful move into a 23505. p_loose swaps the UPDATE policy's WITH CHECK
-- for `true` first, so the control can show the probe sees a move succeed.
CREATE OR REPLACE FUNCTION _ss_move_try(p_user uuid, p_id uuid, p_to uuid, p_loose boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
  c       CURSOR (p uuid) FOR
            SELECT id FROM public.company_simulation_settings WHERE id = p FOR UPDATE;
  v_id    uuid;
BEGIN
  BEGIN
    PERFORM _ss_reset();
    DELETE FROM public.company_simulation_settings WHERE company_id = p_to AND id <> p_id;
    IF p_loose THEN
      EXECUTE 'ALTER POLICY company_simulation_settings_update ON public.company_simulation_settings WITH CHECK (true)';
    END IF;
    PERFORM _ss_as(p_user);
    OPEN c(p_id);
    FETCH c INTO v_id;
    IF v_id IS NULL THEN
      v_out := 'not visible';
    ELSE
      UPDATE public.company_simulation_settings SET company_id = p_to WHERE CURRENT OF c;
      v_out := 'moved';
    END IF;
    CLOSE c;
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ011' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _ss_reset();
  RETURN v_out;
END $$;

CREATE TEMP TABLE _ss_who (who text PRIMARY KEY, uid uuid NOT NULL);
INSERT INTO _ss_who VALUES
  ('admin-a',  'a0000000-0000-4000-8000-000000000001'),
  ('editor-a', 'a0000000-0000-4000-8000-000000000002'),
  ('viewer-a', 'a0000000-0000-4000-8000-000000000003'),
  ('admin-b',  'b0000000-0000-4000-8000-000000000001'),
  ('super',    '50000000-0000-4000-8000-000000000001');

CREATE OR REPLACE FUNCTION _ss_u(p_who text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT (SELECT w.uid FROM _ss_who w WHERE w.who = p_who) $$;

-- Company A has a fixed rate, company B a seeded draw and the return to base.
INSERT INTO company_simulation_settings (id, company_id, share_mode, share_percent, share_scope, seed, return_to_base) VALUES
  (_ss_id('a'), 'c0000000-0000-4000-8000-00000000000a', 'fixed',  32,   NULL,  NULL,  false),
  (_ss_id('b'), 'c0000000-0000-4000-8000-00000000000b', 'random', NULL, 'day', 12345, true);

-- ─── 1. shape ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_tbl   constant text := 'company_simulation_settings';
  v_role  text;
  v_wrong text;
BEGIN
  PERFORM _ss_ok('shape: row level security is on',
    (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', v_tbl)::regclass));
  PERFORM _ss_ok('shape: exactly the four policies <table>_select|insert|update|delete, for authenticated',
    (SELECT array_agg(p.policyname::text ORDER BY p.policyname)
       FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_tbl)
      = ARRAY[v_tbl || '_delete', v_tbl || '_insert', v_tbl || '_select', v_tbl || '_update']
    AND NOT EXISTS (SELECT 1 FROM pg_policies p
                     WHERE p.schemaname = 'public' AND p.tablename = v_tbl
                       AND p.roles <> ARRAY['authenticated']::name[]));
  SELECT string_agg(p.policyname::text, ', ') INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = v_tbl
     AND ((coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'get_active_company_id'
          OR (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'user_profiles|is_user_super_admin');
  PERFORM _ss_ok(format('shape: every policy asks get_active_company_id() and nothing about profiles [%s]', coalesce(v_wrong, 'none')),
    v_wrong IS NULL);
  SELECT string_agg(p.policyname::text, ', ') INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd <> 'SELECT'
     AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'is_company_admin';
  PERFORM _ss_ok(format('shape: every write policy asks for an administrator [%s]', coalesce(v_wrong, 'none')),
    v_wrong IS NULL);
  PERFORM _ss_ok('shape: the UPDATE policy states one predicate as USING and as WITH CHECK',
    (SELECT p.qual = p.with_check FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd = 'UPDATE'));
  PERFORM _ss_ok('shape: the view-context refusal trigger is present, per statement',
    EXISTS (SELECT 1 FROM pg_trigger g
             WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
               AND g.tgname = 'refuse_read_only_context_write'
               AND NOT g.tgisinternal AND g.tgtype = 30 AND g.tgenabled = 'O'));
  PERFORM _ss_ok('shape: the support-write audit trigger is present, per row and gated on the flag',
    EXISTS (SELECT 1 FROM pg_trigger g
             WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
               AND g.tgname = 'record_support_write'
               AND NOT g.tgisinternal AND g.tgtype = 29 AND g.tgenabled = 'O'
               AND pg_get_triggerdef(g.oid) ~ 'app_private\.support_write_context'));
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    PERFORM _ss_ok(format('privileges: %s holds nothing', v_role),
      NOT has_table_privilege(v_role, format('public.%I', v_tbl), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
  END LOOP;
  PERFORM _ss_ok('privileges: authenticated holds SELECT, INSERT, UPDATE and DELETE and nothing else',
    has_table_privilege('authenticated', format('public.%I', v_tbl), 'SELECT')
    AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'INSERT')
    AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'UPDATE')
    AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'DELETE')
    AND NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'TRUNCATE,REFERENCES,TRIGGER'));
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM _ss_ok(format('privileges: %s cannot execute the stamp trigger function', v_role),
      NOT has_function_privilege(v_role, 'app_private.company_simulation_settings_stamp()', 'EXECUTE'));
  END LOOP;
END $$;

-- ─── 2. read and write, per principal ───────────────────────────────────────
DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  who  text;
  v_upd_a  text := format('UPDATE company_simulation_settings SET return_to_base = true WHERE id = %L', _ss_id('a'));
  v_del_a  text := format('DELETE FROM company_simulation_settings WHERE id = %L', _ss_id('a'));
  -- One row per company: the INSERT probe clears the company's row first, as a
  -- separate statement of the same string. Not a data-modifying CTE: one that
  -- nothing references runs after the main INSERT, which would then meet the
  -- unique constraint instead of the policy. ROW_COUNT is the INSERT's.
  v_ins_a  text := format('DELETE FROM company_simulation_settings WHERE company_id = %L; '
                          'INSERT INTO company_simulation_settings (company_id, share_mode, share_percent) VALUES (%L, ''fixed'', 30)', co_a, co_a);
  v_ins_only_a text := format('INSERT INTO company_simulation_settings (company_id, share_mode, share_percent) VALUES (%L, ''fixed'', 30)', co_a);
  v_ins_only_b text := format('INSERT INTO company_simulation_settings (company_id, share_mode, share_percent) VALUES (%L, ''fixed'', 30)', co_b);
  v_upd_b  text := format('UPDATE company_simulation_settings SET return_to_base = false WHERE id = %L', _ss_id('b'));
  v_del_b  text := format('DELETE FROM company_simulation_settings WHERE id = %L', _ss_id('b'));
BEGIN
  PERFORM _ss_ok('impersonation: admin-a''s active company is company A',
    _ss_try(_ss_u('admin-a'), 'SELECT get_active_company_id()::text') = co_a::text);
  PERFORM _ss_ok('impersonation: admin-b''s active company is company B',
    _ss_try(_ss_u('admin-b'), 'SELECT get_active_company_id()::text') = co_b::text);

  PERFORM _ss_ok('admin-a reads its own row and only its own',
    _ss_try(_ss_u('admin-a'), format('SELECT share_mode || share_percent FROM company_simulation_settings WHERE id = %L', _ss_id('a'))) = 'fixed32'
    AND _ss_try(_ss_u('admin-a'), 'SELECT count(*)::text FROM company_simulation_settings') = '1');
  PERFORM _ss_ok('admin-a updates, replaces and deletes its own company''s row',
    _ss_try(_ss_u('admin-a'), v_upd_a) = 'rows 1'
    AND _ss_try(_ss_u('admin-a'), v_del_a) = 'rows 1');
  PERFORM _ss_ok('admin-a inserts its company''s row once the old one is gone',
    _ss_try(_ss_u('admin-a'), v_ins_a) = 'rows 1');

  FOREACH who IN ARRAY ARRAY['viewer-a', 'editor-a'] LOOP
    PERFORM _ss_ok(format('%s reads its company''s row (the simulator needs it)', who),
      _ss_try(_ss_u(who), format('SELECT count(*)::text FROM company_simulation_settings WHERE id = %L', _ss_id('a'))) = '1');
    PERFORM _ss_ok(format('%s updates and deletes nothing: the row is outside the statement''s scope', who),
      _ss_try(_ss_u(who), v_upd_a) = 'rows 0' AND _ss_try(_ss_u(who), v_del_a) = 'rows 0');
    PERFORM _ss_ok(format('%s inserts nothing: WITH CHECK refuses', who),
      _ss_try(_ss_u(who), v_ins_a) LIKE 'ERR 42501%row-level security%');
  END LOOP;

  PERFORM _ss_ok('admin-b reads none of company A''s settings and its own row',
    _ss_try(_ss_u('admin-b'), format('SELECT count(*)::text FROM company_simulation_settings WHERE company_id = %L', co_a)) = '0'
    AND _ss_try(_ss_u('admin-b'), 'SELECT count(*)::text FROM company_simulation_settings') = '1');
  PERFORM _ss_ok('admin-b updates and deletes nothing of company A''s',
    _ss_try(_ss_u('admin-b'), v_upd_a) = 'rows 0' AND _ss_try(_ss_u('admin-b'), v_del_a) = 'rows 0');
  PERFORM _ss_ok('admin-b inserts nothing into company A',
    _ss_try(_ss_u('admin-b'), v_ins_only_a) LIKE 'ERR 42501%row-level security%');
  PERFORM _ss_ok('admin-a inserts nothing into company B and changes nothing of B''s',
    _ss_try(_ss_u('admin-a'), v_ins_only_b) LIKE 'ERR 42501%row-level security%'
    AND _ss_try(_ss_u('admin-a'), v_upd_b) = 'rows 0'
    AND _ss_try(_ss_u('admin-a'), v_del_b) = 'rows 0');
  PERFORM _ss_ok('admin-b''s own row is unchanged by every refused write above',
    (SELECT share_mode = 'random' AND share_scope = 'day' AND seed = 12345 AND return_to_base
       FROM company_simulation_settings WHERE id = _ss_id('b')));

  PERFORM _ss_ok('anon is refused on read and on every write',
    _ss_try(NULL, 'SELECT count(*)::text FROM company_simulation_settings') LIKE 'ERR 42501 permission denied%'
    AND _ss_try(NULL, v_ins_only_a) LIKE 'ERR 42501 permission denied%'
    AND _ss_try(NULL, v_upd_a) LIKE 'ERR 42501 permission denied%'
    AND _ss_try(NULL, v_del_a) LIKE 'ERR 42501 permission denied%');
  PERFORM _ss_ok('no context: super reads nothing and writes nothing',
    _ss_try(_ss_u('super'), 'SELECT count(*)::text FROM company_simulation_settings') = '0'
    AND _ss_try(_ss_u('super'), v_upd_a) = 'rows 0'
    AND _ss_try(_ss_u('super'), v_ins_only_a) LIKE 'ERR 42501%row-level security%');
END $$;

-- ─── 3. move ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
BEGIN
  PERFORM _ss_ok('move: admin-a can take its own row with SELECT ... FOR UPDATE (the probe reaches the row)',
    _ss_move_try(_ss_u('admin-a'), _ss_id('a'), co_a) = 'moved');
  PERFORM _ss_ok('move: re-pointing admin-a''s row at company B is refused by WITH CHECK',
    _ss_move_try(_ss_u('admin-a'), _ss_id('a'), co_b) LIKE 'ERR 42501%row-level security%');
  PERFORM _ss_ok('move: admin-b cannot pull company A''s row into B: it cannot even take it',
    _ss_move_try(_ss_u('admin-b'), _ss_id('a'), co_b) = 'not visible');
  PERFORM _ss_ok('move: a viewer cannot move the row either',
    _ss_move_try(_ss_u('viewer-a'), _ss_id('a'), co_b) = 'not visible'
    OR _ss_move_try(_ss_u('viewer-a'), _ss_id('a'), co_b) LIKE 'ERR 42501%');
  PERFORM _ss_ok('move control: with WITH CHECK loosened the same move SUCCEEDS, so the probe can see a leak',
    _ss_move_try(_ss_u('admin-a'), _ss_id('a'), co_b, true) = 'moved');
  PERFORM _ss_ok('move: both rows are where they were after the rolled-back probes',
    (SELECT company_id = co_a FROM company_simulation_settings WHERE id = _ss_id('a'))
    AND (SELECT company_id = co_b FROM company_simulation_settings WHERE id = _ss_id('b')));
END $$;

-- ─── 4. values ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u    constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_clear text := format('DELETE FROM company_simulation_settings WHERE company_id = %L; ', co_a);
  p       int;
BEGIN
  FOREACH p IN ARRAY ARRAY[30, 31, 32, 33] LOOP
    PERFORM _ss_ok(format('values: a fixed %s %% is stored', p),
      _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, share_mode, share_percent) VALUES (%L, ''fixed'', %s)', co_a, p)) = 'rows 1');
  END LOOP;
  PERFORM _ss_ok('values: a seeded draw per month and per day is stored',
    _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, share_mode, share_scope, seed) VALUES (%L, ''random'', ''month'', 0)', co_a)) = 'rows 1'
    AND _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, share_mode, share_scope, seed) VALUES (%L, ''random'', ''day'', 2147483647)', co_a)) = 'rows 1');
  PERFORM _ss_ok('values: no share mode at all is stored (not configured), with the return to base on',
    _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, return_to_base) VALUES (%L, true)', co_a)) = 'rows 1');

  PERFORM _ss_ok('values: 29 and 34 per cent are refused',
    _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, share_mode, share_percent) VALUES (%L, ''fixed'', 29)', co_a)) LIKE 'ERR 23514%'
    AND _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, share_mode, share_percent) VALUES (%L, ''fixed'', 34)', co_a)) LIKE 'ERR 23514%');
  PERFORM _ss_ok('values: a fixed rate without a percent, or with a scope or a seed, is refused',
    _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, share_mode) VALUES (%L, ''fixed'')', co_a)) LIKE 'ERR 23514%'
    AND _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, share_mode, share_percent, share_scope) VALUES (%L, ''fixed'', 31, ''month'')', co_a)) LIKE 'ERR 23514%'
    AND _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, share_mode, share_percent, seed) VALUES (%L, ''fixed'', 31, 7)', co_a)) LIKE 'ERR 23514%');
  PERFORM _ss_ok('values: a draw without a scope or a seed, or with a percent, is refused',
    _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, share_mode, seed) VALUES (%L, ''random'', 7)', co_a)) LIKE 'ERR 23514%'
    AND _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, share_mode, share_scope) VALUES (%L, ''random'', ''day'')', co_a)) LIKE 'ERR 23514%'
    AND _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, share_mode, share_percent, share_scope, seed) VALUES (%L, ''random'', 31, ''day'', 7)', co_a)) LIKE 'ERR 23514%');
  PERFORM _ss_ok('values: an unknown mode or scope, and a negative seed, are refused',
    _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, share_mode, share_percent) VALUES (%L, ''booked'', 31)', co_a)) LIKE 'ERR 23514%'
    AND _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, share_mode, share_scope, seed) VALUES (%L, ''random'', ''week'', 7)', co_a)) LIKE 'ERR 23514%'
    AND _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, share_mode, share_scope, seed) VALUES (%L, ''random'', ''month'', -1)', co_a)) LIKE 'ERR 23514%');
  PERFORM _ss_ok('values: a percent with no mode is refused',
    _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, share_percent) VALUES (%L, 31)', co_a)) LIKE 'ERR 23514%');
  PERFORM _ss_ok('values: return_to_base is never NULL',
    _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id, return_to_base) VALUES (%L, NULL)', co_a)) LIKE 'ERR 23502%');
  PERFORM _ss_ok('values: a second row for the same company is refused',
    _ss_try(u, format('INSERT INTO company_simulation_settings (company_id) VALUES (%L)', co_a)) LIKE 'ERR 23505%');
  PERFORM _ss_ok('values: the administrator may store a row that names nothing',
    _ss_try(u, v_clear || format('INSERT INTO company_simulation_settings (company_id) VALUES (%L)', co_a)) = 'rows 1');
  -- As the owner, kept: section 5 clears it again.
  DELETE FROM company_simulation_settings WHERE company_id = co_a;
  INSERT INTO company_simulation_settings (company_id) VALUES (co_a);
  PERFORM _ss_ok('values: such a row defaults to no share mode and no return to base (D8)',
    (SELECT share_mode IS NULL AND share_percent IS NULL AND share_scope IS NULL AND seed IS NULL AND NOT return_to_base
       FROM company_simulation_settings WHERE company_id = co_a));
END $$;

-- ─── 5. stamp ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  r    company_simulation_settings%ROWTYPE;
BEGIN
  DELETE FROM company_simulation_settings WHERE company_id = co_a;
  PERFORM _ss_as(u_a);
  INSERT INTO company_simulation_settings (id, company_id, share_mode, share_percent, created_by, updated_by)
  VALUES (_ss_id('stamp'), co_a, 'fixed', 33, 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001');
  PERFORM _ss_reset();
  SELECT * INTO r FROM company_simulation_settings WHERE id = _ss_id('stamp');
  PERFORM _ss_ok('stamp: created_by and updated_by are the caller''s, whatever the client sent',
    r.created_by = u_a AND r.updated_by = u_a);
END $$;

-- ─── 6. owner control ───────────────────────────────────────────────────────
DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
BEGIN
  PERFORM _ss_ok('owner control: every statement refused to a principal succeeds as the owner',
    _ss_try(NULL, format('UPDATE company_simulation_settings SET return_to_base = true WHERE company_id = %L', co_a), true) = 'rows 1'
    AND _ss_try(NULL, format('UPDATE company_simulation_settings SET return_to_base = false WHERE id = %L', _ss_id('b')), true) = 'rows 1'
    AND _ss_try(NULL, format('DELETE FROM company_simulation_settings WHERE id = %L', _ss_id('b')), true) = 'rows 1'
    AND _ss_try(NULL, format('DELETE FROM company_simulation_settings WHERE company_id = %L; '
                             'INSERT INTO company_simulation_settings (company_id, share_mode, share_percent) VALUES (%L, ''fixed'', 30)', co_b, co_b), true) = 'rows 1'
    AND _ss_try(NULL, 'SELECT count(*)::text FROM company_simulation_settings', true) = '2');
END $$;

DO $$ BEGIN RAISE NOTICE '── simulation settings: all checks passed ──'; END $$;

ROLLBACK;
