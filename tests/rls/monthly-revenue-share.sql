/*
  The monthly revenue share (external audit, section 4; migration
  20261027150000), public.company_monthly_revenue_share.

  Runs after the files before it, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end.

  NOT RUN WHEN WRITTEN: this file needs the Docker-backed kit
  (`npm run test:rls` on the VPS). It follows tests/rls/trip-analysis-settings.sql
  helper for helper, but a first run may still need a correction.

  What is covered, in order:

    1. shape       RLS on, exactly the four policies, every write asking an
                   administrator, one predicate as USING and WITH CHECK, both
                   tenant triggers, anon and service_role hold nothing, the
                   rate bounds are constraints
    2. read/write  a company administrator reads and writes its own row; a
                   viewer and an editor read it and write nothing; an
                   administrator of the other company reaches neither; anon is
                   refused outright; a platform owner with no context reaches
                   nothing
    3. move        the UPDATE that re-points company_id is refused by the
                   policy's WITH CHECK. It is probed with SELECT … FOR UPDATE
                   and UPDATE … WHERE CURRENT OF, so the SELECT policy cannot
                   hide the WITH CHECK, and a control loosens the WITH CHECK
                   inside a rolled-back subtransaction and requires the move
                   to then succeed — a probe that cannot fail proves nothing
    4. bounds      0 and 10000 basis points store; -1 and 10001, a month of 0
                   or 13 and a note over 500 characters are refused
    5. stamp       created_by / updated_by are the caller's, never the client's
    6. owner       every statement a principal is refused above is run as the
                   owner and must succeed, so a refusal is never a malformed
                   statement in disguise
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers (trip-analysis-settings.sql's, renamed) ────────────────────────

CREATE OR REPLACE FUNCTION _rs_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _rs_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('rs:' || p_what)::uuid $$;

CREATE OR REPLACE FUNCTION _rs_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/* Become a signed-in caller with a password sign-in, or anon when NULL. */
CREATE OR REPLACE FUNCTION _rs_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _rs_reset();
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
  Run p_sql as that caller (or as the owner when p_owner) in a subtransaction
  that is always rolled back; return the scalar it answered, `rows N`, or
  `ERR <sqlstate> <message>`.
*/
CREATE OR REPLACE FUNCTION _rs_try(p_user uuid, p_sql text, p_owner boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    IF p_owner THEN PERFORM _rs_reset(); ELSE PERFORM _rs_as(p_user); END IF;
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
  PERFORM _rs_reset();
  RETURN v_out;
END $$;

/*
  Move a row to another company the way matrix.sql does: take it with
  SELECT … FOR UPDATE and move it with UPDATE … WHERE CURRENT OF, because an
  UPDATE whose WHERE reads a column also has to leave the new row visible to
  the SELECT policy, and a tenant-scoped SELECT policy would then hide a WITH
  CHECK that lets the row go anywhere. p_loose swaps the UPDATE policy's WITH
  CHECK for `true` first (as the owner, inside this rolled-back subtransaction)
  so the control can show the probe is able to see a move succeed.
*/
CREATE OR REPLACE FUNCTION _rs_move_try(p_user uuid, p_id uuid, p_to uuid, p_loose boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
  c       CURSOR (p uuid) FOR
            SELECT id FROM public.company_monthly_revenue_share WHERE id = p FOR UPDATE;
  v_id    uuid;
BEGIN
  BEGIN
    PERFORM _rs_reset();
    IF p_loose THEN
      EXECUTE 'ALTER POLICY company_monthly_revenue_share_update ON public.company_monthly_revenue_share WITH CHECK (true)';
    END IF;
    PERFORM _rs_as(p_user);
    OPEN c(p_id);
    FETCH c INTO v_id;
    IF v_id IS NULL THEN
      v_out := 'not visible';
    ELSE
      UPDATE public.company_monthly_revenue_share SET company_id = p_to WHERE CURRENT OF c;
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
  PERFORM _rs_reset();
  RETURN v_out;
END $$;

-- ─── principals and data (seed.sql's) ───────────────────────────────────────
--   admin-a, editor-a, viewer-a in company A; admin-b in company B; `super`, a
--   platform owner with no sign-in session and so no context.

CREATE TEMP TABLE _rs_who (who text PRIMARY KEY, uid uuid NOT NULL);
INSERT INTO _rs_who VALUES
  ('admin-a',  'a0000000-0000-4000-8000-000000000001'),
  ('editor-a', 'a0000000-0000-4000-8000-000000000002'),
  ('viewer-a', 'a0000000-0000-4000-8000-000000000003'),
  ('admin-b',  'b0000000-0000-4000-8000-000000000001'),
  ('super',    '50000000-0000-4000-8000-000000000001');

CREATE OR REPLACE FUNCTION _rs_u(p_who text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT (SELECT w.uid FROM _rs_who w WHERE w.who = p_who) $$;

-- One configured month per company, written as the table's owner.
/*
  The two rows are deliberately for **different months**, and tidying them to
  the same month breaks the move control rather than the move probe.

  `UNIQUE (company_id, year, month)` is what the table is for. With both rows at
  2026-08, re-pointing company A's row at company B collides with company B's
  own row, so the move fails with 23505 — and the control below, which loosens
  the WITH CHECK and requires the move to SUCCEED, could never pass. The
  refusal probe above it would still have read as green, because RLS refuses
  before the unique constraint is reached, so the pair would have looked fine
  while the control was measuring a constraint instead of the policy. The first
  run of this file failed on exactly that, and the control is what caught it.
*/
INSERT INTO company_monthly_revenue_share (id, company_id, year, month, rate_basis_points) VALUES
  (_rs_id('share:a'), 'c0000000-0000-4000-8000-00000000000a', 2026, 8, 3142),
  (_rs_id('share:b'), 'c0000000-0000-4000-8000-00000000000b', 2026, 7, 2500);

-- ─── 1. shape ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tbl   constant text := 'company_monthly_revenue_share';
  v_role  text;
  v_wrong text;
BEGIN
  PERFORM _rs_ok('shape: row level security is on',
    (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', v_tbl)::regclass));

  PERFORM _rs_ok('shape: exactly the four policies <table>_select|insert|update|delete, for authenticated',
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
  PERFORM _rs_ok(format('shape: every policy asks get_active_company_id() and nothing about profiles [%s]', coalesce(v_wrong, 'none')),
    v_wrong IS NULL);

  SELECT string_agg(p.policyname::text, ', ') INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd <> 'SELECT'
     AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'is_company_admin';
  PERFORM _rs_ok(format('shape: every write policy asks for an administrator [%s]', coalesce(v_wrong, 'none')),
    v_wrong IS NULL);

  PERFORM _rs_ok('shape: the UPDATE policy states one predicate as USING and as WITH CHECK',
    (SELECT p.qual = p.with_check FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.cmd = 'UPDATE'));

  PERFORM _rs_ok('shape: the view-context refusal trigger is present, per statement',
    EXISTS (SELECT 1 FROM pg_trigger g
             WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
               AND g.tgname = 'refuse_read_only_context_write'
               AND NOT g.tgisinternal AND g.tgtype = 30 AND g.tgenabled = 'O'));
  PERFORM _rs_ok('shape: the support-write audit trigger is present, per row and gated on the flag',
    EXISTS (SELECT 1 FROM pg_trigger g
             WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
               AND g.tgname = 'record_support_write'
               AND NOT g.tgisinternal AND g.tgtype = 29 AND g.tgenabled = 'O'
               AND pg_get_triggerdef(g.oid) ~ 'app_private\.support_write_context'));

  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    PERFORM _rs_ok(format('privileges: %s holds nothing', v_role),
      NOT has_table_privilege(v_role, format('public.%I', v_tbl), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
  END LOOP;
  PERFORM _rs_ok('privileges: authenticated holds SELECT, INSERT, UPDATE and DELETE and nothing else',
    has_table_privilege('authenticated', format('public.%I', v_tbl), 'SELECT')
    AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'INSERT')
    AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'UPDATE')
    AND has_table_privilege('authenticated', format('public.%I', v_tbl), 'DELETE')
    AND NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'TRUNCATE,REFERENCES,TRIGGER'));

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM _rs_ok(format('privileges: %s cannot execute the stamp trigger function', v_role),
      NOT has_function_privilege(v_role, 'app_private.company_monthly_revenue_share_stamp()', 'EXECUTE'));
  END LOOP;

  PERFORM _rs_ok('shape: the rate bounds are a constraint, 0 to 10000 basis points',
    EXISTS (SELECT 1 FROM pg_constraint k
             WHERE k.conrelid = format('public.%I', v_tbl)::regclass AND k.contype = 'c'
               AND pg_get_constraintdef(k.oid) ~ 'rate_basis_points >= 0'
               AND pg_get_constraintdef(k.oid) ~ 'rate_basis_points <= 10000'));
END $$;

-- ─── 2. read and write, per principal ───────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  who  text;
  v_upd_a  text := format('UPDATE company_monthly_revenue_share SET rate_basis_points = 3000 WHERE id = %L', _rs_id('share:a'));
  v_del_a  text := format('DELETE FROM company_monthly_revenue_share WHERE id = %L', _rs_id('share:a'));
  v_ins_a  text := format('INSERT INTO company_monthly_revenue_share (company_id, year, month, rate_basis_points) VALUES (%L, 2026, 9, 3000)', co_a);
  v_ins_b  text := format('INSERT INTO company_monthly_revenue_share (company_id, year, month, rate_basis_points) VALUES (%L, 2026, 9, 3000)', co_b);
  v_upd_b  text := format('UPDATE company_monthly_revenue_share SET rate_basis_points = 3000 WHERE id = %L', _rs_id('share:b'));
  v_del_b  text := format('DELETE FROM company_monthly_revenue_share WHERE id = %L', _rs_id('share:b'));
BEGIN
  -- Impersonation proven first: a NULL uid would make every refusal below pass.
  PERFORM _rs_ok('impersonation: admin-a''s active company is company A',
    _rs_try(_rs_u('admin-a'), 'SELECT get_active_company_id()::text') = co_a::text);

  -- Owner control: each statement a principal is refused below succeeds as
  -- the owner, so a refusal is the policy and not a malformed statement.
  PERFORM _rs_ok('owner control: every probe statement succeeds as the owner',
    _rs_try(NULL, v_upd_a, true) = 'rows 1' AND _rs_try(NULL, v_del_a, true) = 'rows 1'
    AND _rs_try(NULL, v_ins_a, true) = 'rows 1' AND _rs_try(NULL, v_ins_b, true) = 'rows 1'
    AND _rs_try(NULL, v_upd_b, true) = 'rows 1' AND _rs_try(NULL, v_del_b, true) = 'rows 1');

  -- A company administrator reads and writes its own row.
  PERFORM _rs_ok('admin-a reads its own row',
    _rs_try(_rs_u('admin-a'), format('SELECT rate_basis_points::text FROM company_monthly_revenue_share WHERE id = %L', _rs_id('share:a'))) = '3142');
  PERFORM _rs_ok('admin-a updates, inserts and deletes in its own company',
    _rs_try(_rs_u('admin-a'), v_upd_a) = 'rows 1'
    AND _rs_try(_rs_u('admin-a'), v_ins_a) = 'rows 1'
    AND _rs_try(_rs_u('admin-a'), v_del_a) = 'rows 1');

  -- A viewer and an editor read it and write nothing.
  FOREACH who IN ARRAY ARRAY['viewer-a', 'editor-a'] LOOP
    PERFORM _rs_ok(format('%s reads its company''s row', who),
      _rs_try(_rs_u(who), format('SELECT count(*)::text FROM company_monthly_revenue_share WHERE id = %L', _rs_id('share:a'))) = '1');
    PERFORM _rs_ok(format('%s updates and deletes nothing — the row is outside the statement''s scope', who),
      _rs_try(_rs_u(who), v_upd_a) = 'rows 0' AND _rs_try(_rs_u(who), v_del_a) = 'rows 0');
    PERFORM _rs_ok(format('%s inserts nothing — WITH CHECK refuses', who),
      _rs_try(_rs_u(who), v_ins_a) LIKE 'ERR 42501%row-level security%');
  END LOOP;

  -- The other company's administrator reaches nothing of company A's.
  PERFORM _rs_ok('admin-b reads none of company A''s rows and its own one',
    _rs_try(_rs_u('admin-b'), format('SELECT count(*)::text FROM company_monthly_revenue_share WHERE company_id = %L', co_a)) = '0'
    AND _rs_try(_rs_u('admin-b'), 'SELECT count(*)::text FROM company_monthly_revenue_share') = '1');
  PERFORM _rs_ok('admin-b updates and deletes nothing of company A''s',
    _rs_try(_rs_u('admin-b'), v_upd_a) = 'rows 0' AND _rs_try(_rs_u('admin-b'), v_del_a) = 'rows 0');
  PERFORM _rs_ok('admin-b inserts nothing into company A',
    _rs_try(_rs_u('admin-b'), v_ins_a) LIKE 'ERR 42501%row-level security%');
  PERFORM _rs_ok('admin-a inserts nothing into company B and changes nothing of B''s',
    _rs_try(_rs_u('admin-a'), v_ins_b) LIKE 'ERR 42501%row-level security%'
    AND _rs_try(_rs_u('admin-a'), v_upd_b) = 'rows 0'
    AND _rs_try(_rs_u('admin-a'), v_del_b) = 'rows 0');

  -- anon is refused outright (no privilege), not filtered.
  PERFORM _rs_ok('anon is refused on read and on every write',
    _rs_try(NULL, 'SELECT count(*)::text FROM company_monthly_revenue_share') LIKE 'ERR 42501 permission denied%'
    AND _rs_try(NULL, v_ins_a) LIKE 'ERR 42501 permission denied%'
    AND _rs_try(NULL, v_upd_a) LIKE 'ERR 42501 permission denied%'
    AND _rs_try(NULL, v_del_a) LIKE 'ERR 42501 permission denied%');

  -- A platform owner with no context open.
  PERFORM _rs_ok('no context: super reads nothing and writes nothing',
    _rs_try(_rs_u('super'), 'SELECT count(*)::text FROM company_monthly_revenue_share') = '0'
    AND _rs_try(_rs_u('super'), v_upd_a) = 'rows 0'
    AND _rs_try(_rs_u('super'), v_ins_a) LIKE 'ERR 42501%row-level security%');
END $$;

-- ─── 3. a row cannot be moved to another company ────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
BEGIN
  PERFORM _rs_ok('move: admin-a can take its own row with SELECT … FOR UPDATE (the probe reaches the row)',
    _rs_move_try(_rs_u('admin-a'), _rs_id('share:a'), co_a) = 'moved');
  PERFORM _rs_ok('move: re-pointing admin-a''s row at company B is refused by WITH CHECK',
    _rs_move_try(_rs_u('admin-a'), _rs_id('share:a'), co_b) LIKE 'ERR 42501%row-level security%');
  PERFORM _rs_ok('move: admin-b cannot pull company A''s row into B — it cannot even take it',
    _rs_move_try(_rs_u('admin-b'), _rs_id('share:a'), co_b) = 'not visible');
  PERFORM _rs_ok('move: a viewer cannot move the row either',
    _rs_move_try(_rs_u('viewer-a'), _rs_id('share:a'), co_b) IN ('not visible')
    OR _rs_move_try(_rs_u('viewer-a'), _rs_id('share:a'), co_b) LIKE 'ERR 42501%');

  -- Negative control: with the WITH CHECK loosened to true the same probe
  -- must report `moved`. If it does not, the probe above could not see a leak.
  PERFORM _rs_ok('move control: with WITH CHECK loosened the same move SUCCEEDS, so the probe can see a leak',
    _rs_move_try(_rs_u('admin-a'), _rs_id('share:a'), co_b, true) = 'moved');
END $$;

-- ─── 4. bounds ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u    constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _rs_ok('bounds: 0 and 10000 basis points are stored',
    _rs_try(u, format('INSERT INTO company_monthly_revenue_share (company_id, year, month, rate_basis_points) VALUES (%L, 2026, 10, 0)', co_a)) = 'rows 1'
    AND _rs_try(u, format('INSERT INTO company_monthly_revenue_share (company_id, year, month, rate_basis_points) VALUES (%L, 2026, 10, 10000)', co_a)) = 'rows 1');
  PERFORM _rs_ok('bounds: -1 and 10001 basis points are refused by the check constraint',
    _rs_try(u, format('INSERT INTO company_monthly_revenue_share (company_id, year, month, rate_basis_points) VALUES (%L, 2026, 10, -1)', co_a)) LIKE 'ERR 23514%'
    AND _rs_try(u, format('INSERT INTO company_monthly_revenue_share (company_id, year, month, rate_basis_points) VALUES (%L, 2026, 10, 10001)', co_a)) LIKE 'ERR 23514%');
  PERFORM _rs_ok('bounds: month 0 and 13 are refused',
    _rs_try(u, format('INSERT INTO company_monthly_revenue_share (company_id, year, month, rate_basis_points) VALUES (%L, 2026, 0, 3000)', co_a)) LIKE 'ERR 23514%'
    AND _rs_try(u, format('INSERT INTO company_monthly_revenue_share (company_id, year, month, rate_basis_points) VALUES (%L, 2026, 13, 3000)', co_a)) LIKE 'ERR 23514%');
  PERFORM _rs_ok('bounds: a note over 500 characters is refused',
    _rs_try(u, format('INSERT INTO company_monthly_revenue_share (company_id, year, month, rate_basis_points, note) VALUES (%L, 2026, 10, 3000, %L)', co_a, repeat('x', 501))) LIKE 'ERR 23514%');
  PERFORM _rs_ok('bounds: a second row for the same company and month is refused',
    _rs_try(u, format('INSERT INTO company_monthly_revenue_share (company_id, year, month, rate_basis_points) VALUES (%L, 2026, 8, 3000)', co_a)) LIKE 'ERR 23505%');
  PERFORM _rs_ok('bounds: the defaults are tips excluded and declined fees included',
    (SELECT NOT basis_includes_tips AND basis_includes_declined_fees
       FROM company_monthly_revenue_share WHERE id = _rs_id('share:a')));
END $$;

-- ─── 5. the stamp is the database's ─────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  id_  constant uuid := _rs_id('share:stamp');
  r    company_monthly_revenue_share%ROWTYPE;
BEGIN
  PERFORM _rs_as(u_a);
  INSERT INTO company_monthly_revenue_share (id, company_id, year, month, rate_basis_points, created_by, updated_by)
  VALUES (id_, co_a, 2026, 11, 3000, 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001');
  PERFORM _rs_reset();

  SELECT * INTO r FROM company_monthly_revenue_share WHERE id = id_;
  PERFORM _rs_ok('stamp: created_by and updated_by are the caller''s, whatever the client sent',
    r.created_by = u_a AND r.updated_by = u_a);
END $$;

DO $$ BEGIN RAISE NOTICE '── monthly revenue share: all checks passed ──'; END $$;

ROLLBACK;
