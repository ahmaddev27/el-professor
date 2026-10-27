/*
  Per-company sidebar modules, slice 3: the write gate (20261027120000).

  The defect, on production 27.10.2026: the owner switched Fahrtenbuch off for
  his own company and then typed `/fahrtenbuch`. The page rendered, fully
  working. Slice 1 stored the decision and hid the sidebar link; nothing else in
  the product read it, in the browser or in the database.

  What this file proves, in order:

    1. shape        the two helpers, and no client role reaching either
    2. ABSENCE      a company with zero company_modules rows loses NOTHING —
                    the property the whole fail-open design rests on, probed on
                    a seeded company and on every page key there is
    3. closed       a module switched off closes its page's writes, for every
                    role including an administrator
    4. reads open   the same row stays READABLE and SELECT is untouched, which
                    is the wall-C / wall-D line
    5. shared page  `documents` is claimed by four modules: one off closes
                    nothing, all four off closes it. The statutory chain.
    6. need_edit    the term is gated on p_need_edit, so a view call is
                    unaffected — measured, not read off the source
    7. tables       a real INSERT, UPDATE and DELETE on a gated table, including
                    the zero-row DELETE that answers 200 through PostgREST
    8. tenancy      company A's decision does not touch company B
    9. RPCs         the eight SECURITY DEFINER callers inherit the term
   10. unknown key  a row naming a module this build does not have changes
                    nothing, in either direction

  Mutation controls for every section are in the pull request.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in company-modules.sql) ───────────────────────────────

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS banned_until       timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at         timestamptz,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT now();

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _mw_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _mw_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

CREATE OR REPLACE FUNCTION _mw_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _mw_reset();
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  -- A password sign-in: since 20260919130000 a platform capability answers NULL
  -- without one, so a probe left without it can pass vacuously.
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/* The gate's answer for one caller and one page, as the policies ask it. */
CREATE OR REPLACE FUNCTION _mw_permits(p_user uuid, p_page text, p_edit boolean DEFAULT true)
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE v_out boolean;
BEGIN
  PERFORM _mw_as(p_user);
  SELECT public.current_role_permits(p_page, p_edit) INTO v_out;
  PERFORM _mw_reset();
  RETURN v_out;
END $$;

/*
  Run p_sql as that caller in a subtransaction that is always rolled back, and
  return the scalar, `rows N`, or `ERR <sqlstate>`. company-modules.sql's
  `_cm_try`, trimmed to what this file needs.
*/
CREATE OR REPLACE FUNCTION _mw_try(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
BEGIN
  BEGIN
    PERFORM _mw_as(p_user);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    v_out := 'ERR ' || v_state;
  END;
  PERFORM _mw_reset();
  RETURN v_out;
END $$;

/* Switch a module off / on for a company, as the owner — the RPC's effect
   without the RPC, so this file tests the gate and not the writer. */
CREATE OR REPLACE FUNCTION _mw_set(p_company uuid, p_module text, p_enabled boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _mw_reset();
  INSERT INTO public.company_modules (company_id, module_key, enabled)
  VALUES (p_company, p_module, p_enabled)
      ON CONFLICT (company_id, module_key) DO UPDATE SET enabled = EXCLUDED.enabled;
END $$;

CREATE OR REPLACE FUNCTION _mw_clear(p_company uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _mw_reset();
  DELETE FROM public.company_modules WHERE company_id = p_company;
END $$;

-- The seed's principals and companies (tests/rls/seed.sql).
CREATE OR REPLACE FUNCTION _mw_admin_a()  RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT 'a0000000-0000-4000-8000-000000000001'::uuid $$;
CREATE OR REPLACE FUNCTION _mw_editor_a() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT 'a0000000-0000-4000-8000-000000000002'::uuid $$;
CREATE OR REPLACE FUNCTION _mw_viewer_a() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT 'a0000000-0000-4000-8000-000000000003'::uuid $$;
CREATE OR REPLACE FUNCTION _mw_admin_b()  RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT 'b0000000-0000-4000-8000-000000000001'::uuid $$;
CREATE OR REPLACE FUNCTION _mw_co_a()     RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT 'c0000000-0000-4000-8000-00000000000a'::uuid $$;
CREATE OR REPLACE FUNCTION _mw_co_b()     RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT 'c0000000-0000-4000-8000-00000000000b'::uuid $$;

-- ─── 1. shape ───────────────────────────────────────────────────────────────

DO $$
DECLARE v_role text;
BEGIN
  PERFORM _mw_ok('1a  company_module_pages() exists and is IMMUTABLE',
    EXISTS (SELECT 1 FROM pg_proc
             WHERE oid = to_regprocedure('app_private.company_module_pages()')
               AND provolatile = 'i'));

  PERFORM _mw_ok('1b  company_module_page_closed() exists, STABLE, with a pinned search_path',
    EXISTS (SELECT 1 FROM pg_proc
             WHERE oid = to_regprocedure('app_private.company_module_page_closed(uuid,text)')
               AND provolatile = 's'
               AND proconfig @> ARRAY['search_path=pg_catalog, public']));

  -- A SET clause is what keeps an `sql` callee out of the plan cache's masked
  -- class: without it the planner inlines the call and the EXECUTE check can be
  -- warmed by a role that holds it (CLAUDE.md, F2 against F3).
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM _mw_ok(format('1c  %s reaches neither module helper', v_role),
      NOT has_function_privilege(v_role, 'app_private.company_module_pages()', 'EXECUTE')
      AND NOT has_function_privilege(v_role, 'app_private.company_module_page_closed(uuid,text)', 'EXECUTE'));
  END LOOP;

  -- The PR #117 class: current_role_permits is SECURITY DEFINER, so its OWNER
  -- is the role that must reach app_private. If it cannot, every gated write
  -- raises 42501 and the product reports "Keine Berechtigung".
  PERFORM _mw_ok('1d  current_role_permits'' owner can use app_private and execute the helper',
    (SELECT has_schema_privilege(pg_get_userbyid(proowner), 'app_private', 'USAGE')
            AND has_function_privilege(pg_get_userbyid(proowner),
                  'app_private.company_module_page_closed(uuid,text)', 'EXECUTE')
       FROM pg_proc WHERE oid = to_regprocedure('public.current_role_permits(text,boolean)')));
END $$;

-- ─── 2. ABSENCE MEANS ON ────────────────────────────────────────────────────

/*
  The property the whole design rests on, and the one whose failure would be
  catastrophic rather than merely wrong: no company has rows for modules nobody
  has touched, so a predicate reading "no row means off" would take every
  existing customer dark the instant the migration applied.

  Probed three ways: on the seeded company with its rows removed, on every page
  key the product has, and through the gate as an administrator and an editor.
*/
DO $$
DECLARE
  v_page text;
  v_n    int := 0;
BEGIN
  PERFORM _mw_clear(_mw_co_a());

  PERFORM _mw_ok('2a  company A holds no company_modules row',
    NOT EXISTS (SELECT 1 FROM public.company_modules WHERE company_id = _mw_co_a()));

  FOREACH v_page IN ARRAY public.role_page_keys() LOOP
    IF app_private.company_module_page_closed(_mw_co_a(), v_page) THEN
      RAISE EXCEPTION 'FAIL: 2b  page % reads as closed for a company with no rows', v_page;
    END IF;
    v_n := v_n + 1;
  END LOOP;
  PERFORM _mw_ok(format('2b  all %s page keys read as OPEN for a company with no rows', v_n), v_n = 16);

  -- And through the gate itself, which is what the policies ask.
  PERFORM _mw_ok('2c  the administrator still edits every gated page',
    _mw_permits(_mw_admin_a(), 'receipts')
    AND _mw_permits(_mw_admin_a(), 'documents')
    AND _mw_permits(_mw_admin_a(), 'salaries')
    AND _mw_permits(_mw_admin_a(), 'cars'));

  -- The editor's own rights are unchanged too: it holds `receipts` and lacks
  -- `documents` exactly as 20260923130000 left it, so this release moves
  -- nobody's role.
  PERFORM _mw_ok('2d  the editor keeps receipts and still lacks documents',
    _mw_permits(_mw_editor_a(), 'receipts') AND NOT _mw_permits(_mw_editor_a(), 'documents'));

  PERFORM _mw_ok('2e  a NULL company and an unclaimed page are open',
    NOT app_private.company_module_page_closed(NULL, 'receipts')
    AND NOT app_private.company_module_page_closed(_mw_co_a(), 'statistics')
    AND NOT app_private.company_module_page_closed(_mw_co_a(), NULL));
END $$;

-- ─── 3. a module switched off closes its page ───────────────────────────────

DO $$
BEGIN
  PERFORM _mw_clear(_mw_co_a());
  PERFORM _mw_set(_mw_co_a(), 'belege', false);

  PERFORM _mw_ok('3a  `receipts` is closed for company A',
    app_private.company_module_page_closed(_mw_co_a(), 'receipts'));

  -- Including for an administrator. The module is not a role: it is a decision
  -- about the company, so the company's own administrator is inside it.
  PERFORM _mw_ok('3b  the administrator cannot edit receipts', NOT _mw_permits(_mw_admin_a(), 'receipts'));
  PERFORM _mw_ok('3c  nor can the editor',                     NOT _mw_permits(_mw_editor_a(), 'receipts'));

  -- And no other page moved. A gate that closed everything would pass 3a-3c.
  PERFORM _mw_ok('3d  every other page is untouched',
    _mw_permits(_mw_admin_a(), 'documents')
    AND _mw_permits(_mw_admin_a(), 'cars')
    AND _mw_permits(_mw_admin_a(), 'salaries')
    AND _mw_permits(_mw_admin_a(), 'income'));

  -- Switching it back on restores it exactly: the toggle is a predicate over
  -- one row and touches no tenant data, so on -> off -> on is the identity.
  PERFORM _mw_set(_mw_co_a(), 'belege', true);
  PERFORM _mw_ok('3e  switched back on, receipts is editable again', _mw_permits(_mw_admin_a(), 'receipts'));

  -- A row that says `true` is a decision too, and must read as on, not merely
  -- as "present".
  PERFORM _mw_ok('3f  an enabled row does not close the page',
    NOT app_private.company_module_page_closed(_mw_co_a(), 'receipts'));
END $$;

-- ─── 4. reads stay open, which is the wall-C / wall-D line ──────────────────

/*
  The deliberate limit of this slice. The owner said "the query too"; closing
  reads is section 5's recommendation against, because a SELECT a policy hides
  returns [] with a 200 and the product's own rule is that an empty list and a
  total of 0,00 € are claims about a customer's money.

  So this section asserts the limit rather than hiding it: with the module off,
  the company's existing rows are still readable. If a later slice closes reads,
  this section is where it has to change, with its own approval.
*/
DO $$
DECLARE v_seen text;
BEGIN
  PERFORM _mw_clear(_mw_co_a());
  PERFORM _mw_reset();
  INSERT INTO public.receipts (company_id, receipt_number, date, description, driver_name)
  VALUES (_mw_co_a(), 'BEL-MW-READ-1', current_date, 'module read probe', 'Fahrer 1');

  PERFORM _mw_set(_mw_co_a(), 'belege', false);

  v_seen := _mw_try(_mw_admin_a(),
    format('SELECT count(*)::text FROM public.receipts WHERE company_id = %L AND receipt_number = %L',
           _mw_co_a(), 'BEL-MW-READ-1'));
  PERFORM _mw_ok(format('4a  the row is still readable with the module off [%s]', v_seen), v_seen = '1');

  PERFORM _mw_ok('4b  no SELECT policy on receipts names the module helper',
    NOT EXISTS (SELECT 1 FROM pg_policy
                 WHERE polrelid = 'public.receipts'::regclass AND polcmd = 'r'
                   AND coalesce(pg_get_expr(polqual, polrelid), '') ~ 'company_module'));

  -- Nor any other SELECT policy anywhere: wall D would show up here first.
  PERFORM _mw_ok('4c  no SELECT policy in the database names the module helper',
    NOT EXISTS (SELECT 1 FROM pg_policy
                 WHERE polcmd = 'r'
                   AND coalesce(pg_get_expr(polqual, polrelid), '') ~ 'company_module'));
END $$;

-- ─── 5. the shared `documents` page: the statutory chain ────────────────────

/*
  `documents` is claimed by FOUR sidebar entries and gates 24 tables — the
  Fahrtenbuch imports and trips, the assignment audit, the five planning tables,
  the six historical_* tables with their three children, and the saved
  Stundennachweise. Monatsplanung and the Stundennachweis produce a statutory
  document that goes to a Steuerberater.

  So the rule is "closed if and only if NO enabled module claims it". Switching
  **Fahrtenbuch** off — exactly what the owner did — must close nothing.
*/
DO $$
BEGIN
  PERFORM _mw_clear(_mw_co_a());

  PERFORM _mw_set(_mw_co_a(), 'fahrtenbuch', false);
  PERFORM _mw_ok('5a  Fahrtenbuch off alone closes NO table: /dokumente, /company-planner and /monatsplan still claim `documents`',
    NOT app_private.company_module_page_closed(_mw_co_a(), 'documents'));
  PERFORM _mw_ok('5b  …and the administrator can still apply a month and save a Stundennachweis',
    _mw_permits(_mw_admin_a(), 'documents'));

  PERFORM _mw_set(_mw_co_a(), 'dokumente', false);
  PERFORM _mw_set(_mw_co_a(), 'company_planner', false);
  PERFORM _mw_ok('5c  three of four off still closes nothing',
    NOT app_private.company_module_page_closed(_mw_co_a(), 'documents'));

  PERFORM _mw_set(_mw_co_a(), 'monatsplan', false);
  PERFORM _mw_ok('5d  all four off closes `documents`',
    app_private.company_module_page_closed(_mw_co_a(), 'documents'));
  PERFORM _mw_ok('5e  …and the administrator can no longer write it',
    NOT _mw_permits(_mw_admin_a(), 'documents'));

  -- One of the four back on reopens it, which is what makes the operator's
  -- mistake recoverable in one click.
  PERFORM _mw_set(_mw_co_a(), 'monatsplan', true);
  PERFORM _mw_ok('5f  one of the four back on reopens `documents`',
    NOT app_private.company_module_page_closed(_mw_co_a(), 'documents'));
END $$;

-- ─── 6. the term is gated on p_need_edit ────────────────────────────────────

/*
  Measured rather than read off the source. No live caller passes false — the
  codebase records that as VIEW_IS_ENFORCED in
  src/lib/rolePermissionEnforcement.ts — so today this is behaviourally
  identical to an unconditional term. It is written as a conjunct because of
  tomorrow: an unconditional term would make the day someone adds a view gate
  the day this silently becomes wall D, with no migration and no decision.
*/
DO $$
BEGIN
  PERFORM _mw_clear(_mw_co_a());
  PERFORM _mw_set(_mw_co_a(), 'belege', false);

  PERFORM _mw_ok('6a  the edit answer is closed',
    NOT _mw_permits(_mw_admin_a(), 'receipts', true));
  PERFORM _mw_ok('6b  the VIEW answer is untouched — the module term is a write wall',
    _mw_permits(_mw_admin_a(), 'receipts', false));

  PERFORM _mw_ok('6c  no policy and no function asks current_role_permits(page, false)',
    NOT EXISTS (
      SELECT 1 FROM pg_policy
       WHERE (coalesce(pg_get_expr(polqual, polrelid), '')
              || ' ' || coalesce(pg_get_expr(polwithcheck, polrelid), ''))
             ~ 'current_role_permits\([^)]*false'));
END $$;

-- ─── 7. a real table, and the zero-row DELETE ───────────────────────────────

/*
  The gate lives in USING as well as WITH CHECK, so for a closed module the row
  is simply not in an UPDATE's or DELETE's scope: the statement succeeds, zero
  rows change, and PostgREST answers 200. That is why the product routes every
  such write through deleteChecked / updateChecked (src/lib/writeOutcome.ts).
  This section measures the shape so the browser's helper is known to be needed
  here too, and is not quietly dropped as "the database raises anyway".
*/
DO $$
DECLARE
  v_ins text;
  v_upd text;
  v_del text;
  v_left text;
BEGIN
  PERFORM _mw_clear(_mw_co_a());
  PERFORM _mw_reset();
  DELETE FROM public.receipts WHERE company_id = _mw_co_a() AND receipt_number LIKE 'BEL-MW-%';
  INSERT INTO public.receipts (company_id, receipt_number, date, description, driver_name)
  VALUES (_mw_co_a(), 'BEL-MW-1', current_date, 'module write probe', 'Fahrer 1');

  -- Control first: with no decision stored, the administrator writes normally.
  v_ins := _mw_try(_mw_admin_a(), format(
    'INSERT INTO public.receipts (company_id, receipt_number, date, description, driver_name) VALUES (%L, %L, current_date, %L, %L)',
    _mw_co_a(), 'BEL-MW-CTRL', 'control', 'Fahrer 1'));
  PERFORM _mw_ok(format('7a  control: the insert succeeds with no module decision [%s]', v_ins), v_ins = 'rows 1');

  PERFORM _mw_set(_mw_co_a(), 'belege', false);

  v_ins := _mw_try(_mw_admin_a(), format(
    'INSERT INTO public.receipts (company_id, receipt_number, date, description, driver_name) VALUES (%L, %L, current_date, %L, %L)',
    _mw_co_a(), 'BEL-MW-2', 'refused', 'Fahrer 1'));
  -- INSERT is the one command that raises: a refused WITH CHECK is 42501.
  PERFORM _mw_ok(format('7b  INSERT raises 42501 with the module off [%s]', v_ins), v_ins = 'ERR 42501');

  v_upd := _mw_try(_mw_admin_a(), format(
    'UPDATE public.receipts SET description = %L WHERE company_id = %L AND receipt_number = %L',
    'edited', _mw_co_a(), 'BEL-MW-1'));
  PERFORM _mw_ok(format('7c  UPDATE touches zero rows and does NOT raise [%s]', v_upd), v_upd = 'rows 0');

  v_del := _mw_try(_mw_admin_a(), format(
    'DELETE FROM public.receipts WHERE company_id = %L AND receipt_number = %L',
    _mw_co_a(), 'BEL-MW-1'));
  PERFORM _mw_ok(format('7d  DELETE touches zero rows and does NOT raise — this is why deleteChecked exists [%s]', v_del), v_del = 'rows 0');

  -- And the row really is still there, unedited. A `rows 0` that had in fact
  -- deleted it would be the worse defect.
  PERFORM _mw_reset();
  SELECT description INTO v_left
    FROM public.receipts WHERE company_id = _mw_co_a() AND receipt_number = 'BEL-MW-1';
  PERFORM _mw_ok(format('7e  the row survived both refused writes, unedited [%s]', coalesce(v_left, '<gone>')),
    v_left = 'module write probe');
END $$;

-- ─── 8. tenancy ─────────────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _mw_clear(_mw_co_a());
  PERFORM _mw_clear(_mw_co_b());
  PERFORM _mw_set(_mw_co_a(), 'belege', false);

  PERFORM _mw_ok('8a  company A''s decision closes A''s receipts',
    app_private.company_module_page_closed(_mw_co_a(), 'receipts'));
  PERFORM _mw_ok('8b  …and leaves company B''s open',
    NOT app_private.company_module_page_closed(_mw_co_b(), 'receipts'));
  PERFORM _mw_ok('8c  company B''s administrator still edits receipts',
    _mw_permits(_mw_admin_b(), 'receipts'));
END $$;

-- ─── 9. the SECURITY DEFINER callers inherit the term ───────────────────────

/*
  The door and the window. Eight RPCs run past RLS entirely and ask the gate
  themselves — the five planning RPCs since 20260923130000 and the three
  Gehaltsquittung RPCs since they were written. They inherit the module term by
  calling the same function, which is the whole argument for wall C being one
  body rather than 33 policy edits.

  Asserted from the catalogue rather than by calling each one: their arguments
  run to a dozen columns and a planning run, and what is being proved is that
  the call is still there — not what each RPC does with the answer, which
  20260923130000's own kit coverage already pins.
*/
DO $$
DECLARE
  v_fn   text;
  v_miss text := '';
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'apply_monthly_planning_run',
    'replace_monthly_planning_run',
    'delete_or_archive_monthly_planning_run',
    'purge_old_monthly_planning_runs',
    'reassign_fahrtenbuch_trip',
    'confirm_salary_cash_payment',
    'void_salary_cash_receipt',
    'attach_salary_cash_receipt_signed_copy'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_fn
         AND p.prosecdef
         AND p.prosrc ~ 'current_role_permits'
    ) THEN
      v_miss := v_miss || ' ' || v_fn;
    END IF;
  END LOOP;
  PERFORM _mw_ok(format('9a  all eight SECURITY DEFINER callers still ask current_role_permits [missing:%s]',
                        coalesce(nullif(v_miss, ''), ' none')), v_miss = '');

  -- The gate they ask is the one this file changed.
  PERFORM _mw_ok('9b  current_role_permits names the module helper',
    (SELECT prosrc ~ 'company_module_page_closed' FROM pg_proc
      WHERE oid = to_regprocedure('public.current_role_permits(text,boolean)')));
END $$;

-- ─── 10. a module key this build does not have ──────────────────────────────

/*
  Such a row cannot be written through platform_company_set_module (slice 1
  refuses it as `invalid`) and the table has no write policy, so this is the
  rollback case: a newer release's row surviving into an older build. It must
  change nothing, in either direction — it claims no page, so it cannot close
  one, and it must not make a claimed page look claimed either.
*/
DO $$
BEGIN
  PERFORM _mw_clear(_mw_co_a());
  PERFORM _mw_set(_mw_co_a(), 'something_newer', false);

  PERFORM _mw_ok('10a an unknown module key closes nothing',
    NOT app_private.company_module_page_closed(_mw_co_a(), 'receipts')
    AND NOT app_private.company_module_page_closed(_mw_co_a(), 'documents'));
  PERFORM _mw_ok('10b …and the administrator writes as before', _mw_permits(_mw_admin_a(), 'receipts'));

  -- A known module off beside it still closes, so 10a is not passing because
  -- the whole mechanism stopped working.
  PERFORM _mw_set(_mw_co_a(), 'belege', false);
  PERFORM _mw_ok('10c a known module off beside it still closes',
    app_private.company_module_page_closed(_mw_co_a(), 'receipts'));
END $$;

ROLLBACK;
