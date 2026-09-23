/*
  Slice C (20260923130000): the company permission system reaches the tables it
  did not.

  Runs after seed.sql and roles-seed.sql, against the live policies and the live
  function bodies, as real principals — the JWT claims plus SET LOCAL ROLE
  authenticated, as assertions.sql and salary-cash.sql do — so what is tested is
  what PostgREST runs. Every check raises on failure; a silent run is a pass.

  ## What is claimed

  Twenty-three tables carry the `page_key` of the screen that writes them, and
  the five planning RPCs ask the same page:

      documents      the Fahrtenbuch (imports, trips, assignment audit), the
                     planning tables, the historical tables and their three
                     child tables, the saved Stundennachweise, the document
                     templates, and the document blocks and variables
      cash-balance   cash_transactions
      cars           car_driver_assignments

  Each table is probed with **a role that may and a role that may not**, on both
  a read and a write, and each RPC with the roles that lack the page. The pairs
  come from the four system roles as 20260302065621 seeded them and
  roles-seed.sql restates them:

      page           may (can_edit)              may not (no can_edit)
      documents      admin, supervisor           editor, viewer
      cash-balance   admin, supervisor, editor   viewer
      cars           admin, supervisor, editor   viewer

  The `documents` group is the one where the two differ, so it is probed with
  **both** an editor and a viewer: a gate that read `can_view` instead of
  `can_edit` would let the editor through and would still refuse the viewer, and
  only the editor probe tells the two apart.

  ## What it does not claim

  Tenancy. matrix.sql and tenant-state.sql own that, and nothing here re-derives
  it: the probes all stay inside company A. Section 2 is the one exception, and
  it is about the two INSERT clauses a restatement could silently drop, not
  about tenancy as such.

  Runs inside BEGIN … ROLLBACK, so the files after it see only the migrations
  and the seeds.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _pk_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  -- A password sign-in. Nothing here is platform staff, but the claim shape is
  -- the one 20260919130000 expects and every other file in the kit sends.
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE OR REPLACE FUNCTION _pk_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/*
  Runs one statement as one principal in a subtransaction that is always rolled
  back, and returns what happened: `rows N` for a write, the scalar for a
  SELECT, or `ERR <sqlstate> <message>`. The rollback is what lets one table be
  probed with four principals in a row without one probe seeing another's work.
*/
CREATE OR REPLACE FUNCTION _pk_try(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _pk_as(p_user);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    -- Undo whatever the statement did, and carry the answer out on the error.
    RAISE EXCEPTION USING ERRCODE = 'ZZ007', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ007' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _pk_reset();
  RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION _pk_ok(p_label text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'permission-coverage: FAIL — %', p_label;
  END IF;
  RAISE NOTICE 'permission-coverage: ok — %', p_label;
END $$;

-- ─── fixtures ───────────────────────────────────────────────────────────────
--
-- One row per gated table, all inside company A, written as the owner so RLS
-- does not apply while seeding. The column lists are matrix.sql's, which is the
-- kit's record of what these tables actually require.

DO $$
DECLARE
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  drv_a   constant uuid := 'd0000000-0000-4000-8000-00000000000a';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  -- a supervisor, the principal that says whether a DELETE is gated by the page
  -- or by the administrator, and a second driver, because a car may not hold
  -- the same driver twice
  INSERT INTO auth.users (id, email)
  VALUES ('a0000000-0000-4000-8000-000000000009', 'supervisor-a@test.invalid')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
  VALUES ('a0000000-0000-4000-8000-000000000009', 'supervisor-a@test.invalid', 'Supervisor A',
          'supervisor', (SELECT id FROM roles WHERE name = 'supervisor' AND company_id IS NULL),
          co_a, 'active')
  ON CONFLICT (user_id) DO NOTHING;

  -- an account with no company at all, for the ordering check in section 3
  INSERT INTO auth.users (id, email)
  VALUES ('a0000000-0000-4000-8000-00000000000f', 'nocompany@test.invalid')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
  VALUES ('a0000000-0000-4000-8000-00000000000f', 'nocompany@test.invalid', 'No Company',
          'admin', (SELECT id FROM roles WHERE name = 'admin' AND company_id IS NULL), NULL, 'active')
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO drivers (id, company_id, name)
  VALUES ('caaa0010-0000-4000-8000-00000000000a', co_a, 'PK second driver');

  INSERT INTO cars (id, company_id, kennzeichen, created_by)
  VALUES ('caaa0000-0000-4000-8000-00000000000a', co_a, 'PK-AA 1', admin_a);

  INSERT INTO car_driver_assignments (id, car_id, driver_id, created_by, company_id)
  VALUES ('caaa0001-0000-4000-8000-00000000000a', 'caaa0000-0000-4000-8000-00000000000a',
          drv_a, admin_a, co_a);

  INSERT INTO cash_transactions (id, transaction_type, amount, description, created_by, company_id)
  VALUES ('caaa0002-0000-4000-8000-00000000000a', 'deposit', 1, 'pk', 'pk', co_a);

  INSERT INTO documents (id, title, created_by, company_id)
  VALUES ('caaa0003-0000-4000-8000-00000000000a', 'PK document', admin_a, co_a);

  INSERT INTO document_blocks (id, document_id, block_type)
  VALUES ('caaa0004-0000-4000-8000-00000000000a', 'caaa0003-0000-4000-8000-00000000000a', 'title');

  INSERT INTO document_variables (id, document_id, label, key)
  VALUES ('caaa0005-0000-4000-8000-00000000000a', 'caaa0003-0000-4000-8000-00000000000a', 'pk', 'pk_key');

  INSERT INTO document_templates (id, name, file_path, file_url, company_id)
  VALUES ('caaa0006-0000-4000-8000-00000000000a', 'PK template', 'pk/path', 'pk-url', co_a);

  INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by)
  VALUES ('caaa0007-0000-4000-8000-00000000000a', co_a, 3, 2026, 'pk.xlsx', admin_a);

  INSERT INTO fahrtenbuch_trips (id, company_id, import_id, trip_date, start_time, end_time,
                                 original_driver_name, assigned_driver_name)
  VALUES ('caaa0008-0000-4000-8000-00000000000a', co_a, 'caaa0007-0000-4000-8000-00000000000a',
          DATE '2026-03-02', '08:00', '09:00', 'PK', 'PK');

  INSERT INTO company_planning_runs (id, company_id, month, year)
  VALUES ('caaa0009-0000-4000-8000-00000000000a', co_a, 3, 2026);

  INSERT INTO historical_reconciliations (id, company_id, month, year)
  VALUES ('caaa000a-0000-4000-8000-00000000000a', co_a, 3, 2026);

  INSERT INTO historical_reconciliation_drivers (id, reconciliation_id, driver_id, driver_name)
  VALUES ('caaa000b-0000-4000-8000-00000000000a', 'caaa000a-0000-4000-8000-00000000000a', drv_a, 'PK');

  INSERT INTO saved_stundennachweise (id, company_id, driver_id, driver_name, month, year)
  VALUES ('caaa000c-0000-4000-8000-00000000000a', co_a, drv_a, 'PK', 3, 2026);
END $$;

-- ─── 1. the page a table carries, per role ──────────────────────────────────
--
-- One probe per (table, role, statement). A role that holds can_edit on the
-- page writes; a role that does not is refused — by WITH CHECK on an INSERT
-- (42501, "row-level security"), and by the USING clause on an UPDATE or a
-- DELETE, which is silent: the row is simply not there to change, so the
-- answer is `rows 0` and not an error. Both are refusals; only the shape
-- differs, and saying which is what makes this a test rather than a wish.
--
-- Whether a role may is read out of role_permissions rather than written here,
-- so the probe and the seed cannot drift. Section 6 is what pins the seed.

DO $$
DECLARE
  t        record;
  r        record;
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  editor_a constant uuid := 'a0000000-0000-4000-8000-000000000002';
  viewer_a constant uuid := 'a0000000-0000-4000-8000-000000000003';
  uid      uuid;
  got      text;
  may      boolean;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('car_driver_assignments', 'cars', 'caaa0001-0000-4000-8000-00000000000a',
       $q$INSERT INTO car_driver_assignments (car_id, driver_id, created_by, company_id, role)
          VALUES ('caaa0000-0000-4000-8000-00000000000a', 'caaa0010-0000-4000-8000-00000000000a',
                  'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
                  'hauptfahrer_2')$q$,
       $q$UPDATE car_driver_assignments SET role = role WHERE id = 'caaa0001-0000-4000-8000-00000000000a'$q$,
       $q$DELETE FROM car_driver_assignments WHERE id = 'caaa0001-0000-4000-8000-00000000000a'$q$),

      ('cash_transactions', 'cash-balance', 'caaa0002-0000-4000-8000-00000000000a',
       $q$INSERT INTO cash_transactions (transaction_type, amount, description, created_by, company_id)
          VALUES ('deposit', 2, 'pk new', 'pk', 'c0000000-0000-4000-8000-00000000000a')$q$,
       $q$UPDATE cash_transactions SET description = description WHERE id = 'caaa0002-0000-4000-8000-00000000000a'$q$,
       $q$DELETE FROM cash_transactions WHERE id = 'caaa0002-0000-4000-8000-00000000000a'$q$),

      ('document_templates', 'documents', 'caaa0006-0000-4000-8000-00000000000a',
       $q$INSERT INTO document_templates (name, file_path, file_url, company_id)
          VALUES ('PK new', 'pk/new', 'pk-new-url', 'c0000000-0000-4000-8000-00000000000a')$q$,
       $q$UPDATE document_templates SET name = name WHERE id = 'caaa0006-0000-4000-8000-00000000000a'$q$,
       $q$DELETE FROM document_templates WHERE id = 'caaa0006-0000-4000-8000-00000000000a'$q$),

      ('company_planning_runs', 'documents', 'caaa0009-0000-4000-8000-00000000000a',
       $q$INSERT INTO company_planning_runs (company_id, month, year)
          VALUES ('c0000000-0000-4000-8000-00000000000a', 4, 2026)$q$,
       $q$UPDATE company_planning_runs SET status = status WHERE id = 'caaa0009-0000-4000-8000-00000000000a'$q$,
       $q$DELETE FROM company_planning_runs WHERE id = 'caaa0009-0000-4000-8000-00000000000a'$q$),

      ('historical_reconciliations', 'documents', 'caaa000a-0000-4000-8000-00000000000a',
       $q$INSERT INTO historical_reconciliations (company_id, month, year)
          VALUES ('c0000000-0000-4000-8000-00000000000a', 4, 2026)$q$,
       $q$UPDATE historical_reconciliations SET notes = notes WHERE id = 'caaa000a-0000-4000-8000-00000000000a'$q$,
       $q$DELETE FROM historical_reconciliations WHERE id = 'caaa000a-0000-4000-8000-00000000000a'$q$),

      ('saved_stundennachweise', 'documents', 'caaa000c-0000-4000-8000-00000000000a',
       $q$INSERT INTO saved_stundennachweise (company_id, driver_id, driver_name, month, year)
          VALUES ('c0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-00000000000a', 'PK', 4, 2026)$q$,
       $q$UPDATE saved_stundennachweise SET driver_name = driver_name WHERE id = 'caaa000c-0000-4000-8000-00000000000a'$q$,
       $q$DELETE FROM saved_stundennachweise WHERE id = 'caaa000c-0000-4000-8000-00000000000a'$q$),

      -- a child table that reaches its company through a parent: the page is
      -- the parent's, which 3.3's child loop did not carry
      ('historical_reconciliation_drivers', 'documents', 'caaa000b-0000-4000-8000-00000000000a',
       $q$INSERT INTO historical_reconciliation_drivers (reconciliation_id, driver_id, driver_name)
          VALUES ('caaa000a-0000-4000-8000-00000000000a', 'caaa0010-0000-4000-8000-00000000000a', 'PK 2')$q$,
       $q$UPDATE historical_reconciliation_drivers SET driver_name = driver_name WHERE id = 'caaa000b-0000-4000-8000-00000000000a'$q$,
       $q$DELETE FROM historical_reconciliation_drivers WHERE id = 'caaa000b-0000-4000-8000-00000000000a'$q$),

      ('document_blocks', 'documents', 'caaa0004-0000-4000-8000-00000000000a',
       $q$INSERT INTO document_blocks (document_id, block_type)
          VALUES ('caaa0003-0000-4000-8000-00000000000a', 'paragraph')$q$,
       $q$UPDATE document_blocks SET block_type = block_type WHERE id = 'caaa0004-0000-4000-8000-00000000000a'$q$,
       $q$DELETE FROM document_blocks WHERE id = 'caaa0004-0000-4000-8000-00000000000a'$q$),

      ('document_variables', 'documents', 'caaa0005-0000-4000-8000-00000000000a',
       $q$INSERT INTO document_variables (document_id, label, key)
          VALUES ('caaa0003-0000-4000-8000-00000000000a', 'pk new', 'pk_new_key')$q$,
       $q$UPDATE document_variables SET label = label WHERE id = 'caaa0005-0000-4000-8000-00000000000a'$q$,
       $q$DELETE FROM document_variables WHERE id = 'caaa0005-0000-4000-8000-00000000000a'$q$)
    ) AS v(tbl, page, row_id, ins, upd, del)
  LOOP
    FOR r IN
      SELECT * FROM (VALUES ('admin', admin_a), ('editor', editor_a), ('viewer', viewer_a))
        AS p(role_name, user_id)
    LOOP
      uid := r.user_id;

      -- The read is never gated: 3.3's shape carries no role term on SELECT,
      -- and slice C did not invent one.
      PERFORM _pk_ok(format('%s: %s reads the row whatever its page rights', t.tbl, r.role_name),
        _pk_try(uid, format('SELECT count(*)::text FROM %I WHERE id = %L', t.tbl, t.row_id)) = '1');

      SELECT rp.can_edit INTO may
        FROM public.roles ro
        JOIN public.role_permissions rp ON rp.role_id = ro.id
       WHERE ro.name = r.role_name AND ro.company_id IS NULL AND rp.page_key = t.page;

      IF may THEN
        PERFORM _pk_ok(format('%s: %s holds can_edit on %s and inserts', t.tbl, r.role_name, t.page),
          _pk_try(uid, t.ins) = 'rows 1');
        PERFORM _pk_ok(format('%s: %s updates', t.tbl, r.role_name),
          _pk_try(uid, t.upd) = 'rows 1');
        PERFORM _pk_ok(format('%s: %s deletes', t.tbl, r.role_name),
          _pk_try(uid, t.del) = 'rows 1');
      ELSE
        got := _pk_try(uid, t.ins);
        PERFORM _pk_ok(format('%s: %s holds no can_edit on %s, so its insert is refused by WITH CHECK [%s]',
                              t.tbl, r.role_name, t.page, got),
          got LIKE 'ERR 42501%row-level security%');
        PERFORM _pk_ok(format('%s: %s matches no row to update', t.tbl, r.role_name),
          _pk_try(uid, t.upd) = 'rows 0');
        PERFORM _pk_ok(format('%s: %s matches no row to delete', t.tbl, r.role_name),
          _pk_try(uid, t.del) = 'rows 0');
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ─── 2. the Fahrtenbuch, whose commands are not uniform ─────────────────────
--
-- fahrtenbuch_trips has no UPDATE policy at all and fahrtenbuch_assignment_audit
-- has neither UPDATE nor DELETE, so they are probed by hand. Both DELETEs that
-- were the administrator's before this slice still are, which is the half of
-- the claim a page gate could have widened rather than narrowed — a supervisor
-- holds can_edit on every page, so if the page had replaced the administrator
-- term it would now delete an import, and that is what these probes say it
-- does not.
--
-- And the two INSERT clauses CLAUDE.md names as load-bearing survived the
-- restatement: an import and a reassignment record may not be filed in another
-- member's name.

DO $$
DECLARE
  co_a     constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  editor_a constant uuid := 'a0000000-0000-4000-8000-000000000002';
  viewer_a constant uuid := 'a0000000-0000-4000-8000-000000000003';
  sup_a    constant uuid := 'a0000000-0000-4000-8000-000000000009';
  import_a constant uuid := 'caaa0007-0000-4000-8000-00000000000a';
  trip_a   constant uuid := 'caaa0008-0000-4000-8000-00000000000a';
  drv_a    constant uuid := 'd0000000-0000-4000-8000-00000000000a';
  ins_imp  text;
  ins_trip text;
  ins_aud  text;
BEGIN
  ins_imp := $q$INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by)
                VALUES ('c0000000-0000-4000-8000-00000000000a', 5, 2026, 'pk2.xlsx', %L)$q$;
  ins_trip := $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name)
                 VALUES ('c0000000-0000-4000-8000-00000000000a', 'caaa0007-0000-4000-8000-00000000000a',
                         DATE '2026-03-03', 'PK', 'PK')$q$;
  ins_aud := $q$INSERT INTO fahrtenbuch_assignment_audit
                  (company_id, trip_id, trip_date, start_time, end_time, price_amount,
                   original_driver_name, new_assigned_driver_name, changed_by)
                VALUES ('c0000000-0000-4000-8000-00000000000a', 'caaa0008-0000-4000-8000-00000000000a',
                        DATE '2026-03-02', '08:00', '09:00', 0, 'PK', 'PK', %L)$q$;

  PERFORM _pk_ok('fahrtenbuch_imports: an administrator files an import',
    _pk_try(admin_a, format(ins_imp, admin_a)) = 'rows 1');
  PERFORM _pk_ok('fahrtenbuch_imports: a supervisor does too — it holds can_edit on documents',
    _pk_try(sup_a, format(ins_imp, sup_a)) = 'rows 1');
  PERFORM _pk_ok('fahrtenbuch_imports: an editor holds no can_edit on documents and files none',
    _pk_try(editor_a, format(ins_imp, editor_a)) LIKE 'ERR 42501%row-level security%');
  PERFORM _pk_ok('fahrtenbuch_imports: nor does a viewer',
    _pk_try(viewer_a, format(ins_imp, viewer_a)) LIKE 'ERR 42501%row-level security%');
  PERFORM _pk_ok('fahrtenbuch_imports: imported_by must be the caller — an import in a colleague''s name is refused',
    _pk_try(admin_a, format(ins_imp, editor_a)) LIKE 'ERR 42501%row-level security%');

  PERFORM _pk_ok('fahrtenbuch_imports: a supervisor still deletes none — DELETE is the administrator''s',
    _pk_try(sup_a, format('DELETE FROM fahrtenbuch_imports WHERE id = %L', import_a)) = 'rows 0');
  PERFORM _pk_ok('fahrtenbuch_imports: an administrator deletes one',
    _pk_try(admin_a, format('DELETE FROM fahrtenbuch_imports WHERE id = %L', import_a)) = 'rows 1');

  PERFORM _pk_ok('fahrtenbuch_trips: an administrator inserts a trip',
    _pk_try(admin_a, ins_trip) = 'rows 1');
  PERFORM _pk_ok('fahrtenbuch_trips: an editor does not',
    _pk_try(editor_a, ins_trip) LIKE 'ERR 42501%row-level security%');
  PERFORM _pk_ok('fahrtenbuch_trips: a viewer does not',
    _pk_try(viewer_a, ins_trip) LIKE 'ERR 42501%row-level security%');
  PERFORM _pk_ok('fahrtenbuch_trips: a supervisor deletes none — DELETE is the administrator''s',
    _pk_try(sup_a, format('DELETE FROM fahrtenbuch_trips WHERE id = %L', trip_a)) = 'rows 0');
  PERFORM _pk_ok('fahrtenbuch_trips: not even an administrator has an UPDATE path',
    _pk_try(admin_a, format('UPDATE fahrtenbuch_trips SET assignment_note = ''pk'' WHERE id = %L', trip_a)) = 'rows 0');

  PERFORM _pk_ok('fahrtenbuch_assignment_audit: an administrator records a reassignment',
    _pk_try(admin_a, format(ins_aud, admin_a)) = 'rows 1');
  PERFORM _pk_ok('fahrtenbuch_assignment_audit: an editor holds no can_edit on documents and records none',
    _pk_try(editor_a, format(ins_aud, editor_a)) LIKE 'ERR 42501%row-level security%');
  PERFORM _pk_ok('fahrtenbuch_assignment_audit: a viewer records none either',
    _pk_try(viewer_a, format(ins_aud, viewer_a)) LIKE 'ERR 42501%row-level security%');
  PERFORM _pk_ok('fahrtenbuch_assignment_audit: changed_by must be the caller — a record in a colleague''s name is refused',
    _pk_try(admin_a, format(ins_aud, editor_a)) LIKE 'ERR 42501%row-level security%');
END $$;

-- ─── 3. the five planning RPCs ──────────────────────────────────────────────
--
-- They are SECURITY DEFINER and run past RLS, so the table gates above say
-- nothing about them: gating the tables alone would have closed the door and
-- left the window open. Each must refuse the role that lacks the page with
-- 42501, and must refuse it *after* its own company branch, so an account with
-- no company still hears about the company first — which is what
-- tenant-state.sql section 4 depends on.

DO $$
DECLARE
  r        record;
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  editor_a constant uuid := 'a0000000-0000-4000-8000-000000000002';
  viewer_a constant uuid := 'a0000000-0000-4000-8000-000000000003';
  import_a constant uuid := 'caaa0007-0000-4000-8000-00000000000a';
  trip_a   constant uuid := 'caaa0008-0000-4000-8000-00000000000a';
  run_a    constant uuid := 'caaa0009-0000-4000-8000-00000000000a';
  drv_a    constant uuid := 'd0000000-0000-4000-8000-00000000000a';
  got      text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('apply_monthly_planning_run',
       format($q$SELECT apply_monthly_planning_run(jsonb_build_object(
                   'import_id', %L, 'month', 9, 'year', 2026,
                   'change_rows', jsonb_build_array()))::text$q$, import_a)),
      ('replace_monthly_planning_run',
       format($q$SELECT replace_monthly_planning_run(jsonb_build_object(
                   'import_id', %L, 'month', 9, 'year', 2026,
                   'change_rows', jsonb_build_array()), %L)::text$q$, import_a, run_a)),
      ('delete_or_archive_monthly_planning_run',
       format($q$SELECT delete_or_archive_monthly_planning_run(%L)::text$q$, run_a)),
      ('purge_old_monthly_planning_runs',
       $q$SELECT purge_old_monthly_planning_runs(3, 2026)::text$q$),
      ('reassign_fahrtenbuch_trip',
       format($q$SELECT reassign_fahrtenbuch_trip(%L, %L, 'PK')::text$q$, trip_a, drv_a))
    ) AS v(fn, call)
  LOOP
    got := _pk_try(viewer_a, r.call);
    PERFORM _pk_ok(format('%s: a viewer is refused by the Dokumente page [%s]', r.fn, got),
      got LIKE 'ERR 42501%' AND got NOT LIKE '%caller has no company%');

    got := _pk_try(editor_a, r.call);
    PERFORM _pk_ok(format('%s: so is an editor, which holds no can_edit there either', r.fn),
      got LIKE 'ERR 42501%' AND got NOT LIKE '%caller has no company%');

    -- The control. What an administrator's call answers past the gate is the
    -- planning pipeline's business and not this file's; only that the page did
    -- not refuse it.
    got := _pk_try(admin_a, r.call);
    PERFORM _pk_ok(format('%s: an administrator is not refused by the page [%s]', r.fn, left(got, 70)),
      got NOT LIKE 'ERR 42501%');
  END LOOP;

  PERFORM _pk_ok('reassign_fahrtenbuch_trip: an account with no company still hears about the company first',
    _pk_try('a0000000-0000-4000-8000-00000000000f',
            format($q$SELECT reassign_fahrtenbuch_trip(%L, %L, 'PK')::text$q$, trip_a, drv_a))
      LIKE 'ERR P0001%caller has no company%');
END $$;

-- ─── 4. the RPCs this slice deliberately did not change ─────────────────────

DO $$
DECLARE
  v_sig text;
BEGIN
  -- The three Gehaltsquittung RPCs already asked a page, and still do.
  FOREACH v_sig IN ARRAY ARRAY[
    'public.confirm_salary_cash_payment(uuid, uuid, numeric, date, text)',
    'public.void_salary_cash_receipt(uuid, text)',
    'public.attach_salary_cash_receipt_signed_copy(uuid, text)'
  ]
  LOOP
    PERFORM _pk_ok(format('%s still asks current_role_permits(''salaries'', true)', v_sig),
      pg_get_functiondef(to_regprocedure(v_sig)) ~ 'current_role_permits\(\s*''salaries''\s*,\s*true\s*\)');
  END LOOP;

  -- The Abrechnung readers need no gate, and the reason is a fact rather than a
  -- judgement: they are SECURITY INVOKER, so the caller's own policies on
  -- income, receipts and cash_transactions answer them. If one ever became a
  -- definer it would need one, and this is where that shows up.
  FOREACH v_sig IN ARRAY ARRAY[
    'public.get_weekly_abrechnung(integer, integer)',
    'public.get_monthly_abrechnung(integer, integer)',
    'public.get_driver_weekly_abrechnung(text, integer, integer)',
    'public.get_driver_monthly_abrechnung(text, integer, integer)'
  ]
  LOOP
    IF to_regprocedure(v_sig) IS NOT NULL THEN
      PERFORM _pk_ok(format('%s is SECURITY INVOKER, so RLS answers for it', v_sig),
        NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)));
    END IF;
  END LOOP;
END $$;

-- ─── 5. the shape, and the tables deliberately left alone ───────────────────

DO $$
DECLARE
  v_wrong text;
  v_n     int;
BEGIN
  -- Every newly gated table asks its page on every write command it has …
  SELECT string_agg(format('%s %s', p.tablename, p.cmd), ', ' ORDER BY p.tablename, p.cmd)
    INTO v_wrong
    FROM pg_policies p
    JOIN (VALUES
      ('car_driver_assignments','cars'), ('cash_transactions','cash-balance'),
      ('document_templates','documents'), ('company_planning_runs','documents'),
      ('company_planning_run_blocks','documents'), ('monthly_planning_manual_exceptions','documents'),
      ('planning_finalizations','documents'), ('planning_run_adjustments','documents'),
      ('historical_reconciliations','documents'), ('historical_block_adjustments','documents'),
      ('historical_driver_hour_targets','documents'), ('historical_payroll_targets','documents'),
      ('historical_time_adjustments','documents'), ('historical_wh_saved_plans','documents'),
      ('saved_stundennachweise','documents'), ('document_blocks','documents'),
      ('document_variables','documents'), ('historical_reconciliation_drivers','documents'),
      ('historical_reconciliation_results','documents'), ('historical_reconciliation_wh_drivers','documents'),
      ('fahrtenbuch_imports','documents'), ('fahrtenbuch_trips','documents'),
      ('fahrtenbuch_assignment_audit','documents')
    ) AS w(tbl, page) ON w.tbl = p.tablename
   WHERE p.schemaname = 'public'
     AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE')
     -- the two DELETEs that are the administrator's are the exception
     AND NOT (p.cmd = 'DELETE' AND p.tablename IN ('fahrtenbuch_imports', 'fahrtenbuch_trips'))
     AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''))
         !~ ('current_role_permits\(''' || w.page || '''');
  PERFORM _pk_ok(format('shape: every write policy of the newly gated tables asks its page [%s]',
                        coalesce(v_wrong, 'none')),
    v_wrong IS NULL);

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname IN ('fahrtenbuch_imports_delete', 'fahrtenbuch_trips_delete')
     AND qual ~ 'is_company_admin\(\)' AND qual !~ 'current_role_permits';
  PERFORM _pk_ok('shape: deleting an import or a trip is still the administrator''s alone', v_n = 2);

  PERFORM _pk_ok('shape: fahrtenbuch_trips still has no UPDATE policy — every mutable field is an RPC''s',
    NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'fahrtenbuch_trips' AND cmd = 'UPDATE'));

  -- The eleven objects that were gated before this slice still are. A release
  -- that loses one of them fails here even if it never touched slice C.
  SELECT string_agg(format('%s %s', p.tablename, p.cmd), ', ' ORDER BY p.tablename, p.cmd)
    INTO v_wrong
    FROM pg_policies p
    JOIN (VALUES
      ('cars','cars'), ('documents','documents'), ('driver_notes','notes'), ('drivers','drivers'),
      ('fixed_costs','fixed-costs'), ('income','income'), ('receipts','receipts'),
      ('salaries','salaries'), ('salary_payments','salaries'), ('werkstatt_checks','werkstatt')
    ) AS w(tbl, page) ON w.tbl = p.tablename
   WHERE p.schemaname = 'public'
     AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE')
     AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''))
         !~ ('current_role_permits\(''' || w.page || '''');
  PERFORM _pk_ok(format('shape: the ten tables gated by 20260910120000 are still gated [%s]',
                        coalesce(v_wrong, 'none')),
    v_wrong IS NULL);

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ 'current_role_permits\(''salaries''';
  PERFORM _pk_ok(format('shape: the salary-receipts bucket still asks the salaries page [%s policies]', v_n),
    v_n > 0);

  -- The four the slice deliberately did not gate, each for its own reason.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'notification_settings'
     AND cmd IN ('INSERT', 'UPDATE')
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ 'is_company_admin\(\)';
  PERFORM _pk_ok('left alone: notification_settings asks for an administrator, which is stricter than a page', v_n = 2);

  PERFORM _pk_ok('left alone: cash_movements and salary_cash_receipts carry no write policy to gate',
    NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public'
                   AND tablename IN ('cash_movements', 'salary_cash_receipts')
                   AND cmd <> 'SELECT'));
  PERFORM _pk_ok('left alone: …and no client role holds a write privilege on them anyway',
    NOT has_table_privilege('authenticated', 'public.cash_movements', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.salary_cash_receipts', 'INSERT'));

  PERFORM _pk_ok('left alone: document_counters is out of every client role''s reach',
    NOT has_table_privilege('anon', 'public.document_counters', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.document_counters', 'SELECT'));
END $$;

-- ─── 6. nobody's role definition was edited ─────────────────────────────────
--
-- The migration creates no page key and writes no role_permissions row; its own
-- self-check 6 proves that by digest across the file. What this section states
-- is the consequence the pull request claims: the four system roles hold, on
-- the three pages this slice uses, exactly what 20260302065621 seeded. If that
-- ever changes, the cells in matrix.sql and the probes in section 1 move with
-- it, and this is the line that says so.

DO $$
DECLARE
  v_wrong text;
BEGIN
  SELECT string_agg(format('%s/%s view=%s edit=%s', w.role_name, w.page_key, rp.can_view, rp.can_edit), ', ')
    INTO v_wrong
    FROM (VALUES
      ('admin',      'documents',    true,  true),
      ('supervisor', 'documents',    true,  true),
      ('editor',     'documents',    true,  false),
      ('viewer',     'documents',    true,  false),
      ('admin',      'cash-balance', true,  true),
      ('supervisor', 'cash-balance', true,  true),
      ('editor',     'cash-balance', true,  true),
      ('viewer',     'cash-balance', true,  false),
      ('admin',      'cars',         true,  true),
      ('supervisor', 'cars',         true,  true),
      ('editor',     'cars',         true,  true),
      ('viewer',     'cars',         true,  false)
    ) AS w(role_name, page_key, want_view, want_edit)
    JOIN public.roles ro
      ON ro.name = w.role_name AND ro.company_id IS NULL AND ro.is_system
    JOIN public.role_permissions rp
      ON rp.role_id = ro.id AND rp.page_key = w.page_key
   WHERE rp.can_view IS DISTINCT FROM w.want_view
      OR rp.can_edit IS DISTINCT FROM w.want_edit;
  PERFORM _pk_ok(format('seeds: the four system roles hold what they always held on documents, cash-balance and cars [%s]',
                        coalesce(v_wrong, 'unchanged')),
    v_wrong IS NULL);

  -- And the mapping introduced no key: every page a policy names is one of the
  -- sixteen the Rollen screen offers, so no role can hold a right nothing shows
  -- — and no role can lose one to a key the screen drops when it saves.
  SELECT string_agg(DISTINCT m.parts[1], ', ')
    INTO v_wrong
    FROM pg_policies p
    CROSS JOIN LATERAL regexp_matches(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''),
                                      'current_role_permits\(''([a-z-]+)''', 'g') AS m(parts)
   WHERE p.schemaname IN ('public', 'storage')
     AND m.parts[1] NOT IN ('accounting','cars','cash-balance','documents','drivers','fixed-costs',
                            'income','notes','overview','receipts','roles','salaries','settings',
                            'statistics','users','werkstatt');
  PERFORM _pk_ok(format('seeds: no policy names a page outside the sixteen the Rollen screen offers [%s]',
                        coalesce(v_wrong, 'none')),
    v_wrong IS NULL);
END $$;

ROLLBACK;
