/*
  # The company permission system reaches the tables it did not (slice C)

  Owner's approval, 23.09.2026.

  ## What was open

  `20260910120000` put ten business tables behind `current_role_permits(page,
  true)`, and `20260917130000` (plan 3.3) carried that gate — and only that
  gate — into the one shape every tenant table now wears. Its own table list
  says so in a comment:

      -- no role gate today, and none added: a viewer writes these exactly as it
      -- does now. Narrowing them is a decision about roles, not about tenancy.

  That decision is this file. Measured on production on 23.09.2026 and
  re-measured here against the migration chain: eleven objects are gated
  (`cars`, `documents`, `driver_notes`, `drivers`, `fixed_costs`, `income`,
  `receipts`, `salaries`, `salary_payments`, `werkstatt_checks` and the
  `salary-receipts` bucket), and every other company table answers only the
  tenant question. So a member of a company writes them whatever role it holds:
  a `viewer` — the product's read-only role, `can_edit = false` on all sixteen
  pages since 20260302065621 — imports a Fahrtenbuch, applies a month's
  planning, finalizes it, edits a historical reconciliation, saves a
  Stundennachweis and reassigns a trip. tests/rls/matrix.sql records it under
  "Recorded without a plan step": *a viewer can apply a monthly plan, as it can
  already write the planning tables directly*.

  Two halves, because the tables are only one of them. The five planning RPCs
  are `SECURITY DEFINER` and run past RLS entirely, so gating the tables alone
  would close the door and leave the window open.

  ## The mapping, table by table, and the reason for each

  No new `page_key` is introduced. Three reasons, in order of weight:

  1. The Rollen screen writes a role by **deleting every `role_permissions` row
     it has and re-inserting one per key in `PAGE_DEFINITIONS`**
     (`src/components/RolesManagement.tsx`, `handleSaveRole`). A key the screen
     does not know is therefore dropped the first time anyone edits that role —
     so a new key seeded by a migration is a landmine that goes off on the first
     edit, silently, per role.
  2. `PAGE_DEFINITIONS` and the Rollen screen belong to the parallel slice on a
     company's own roles, which this file must not touch.
  3. Every table below is written from a screen that already has a page.

  | table(s)                                                            | page           | why |
  |---------------------------------------------------------------------|----------------|-----|
  | `fahrtenbuch_imports`, `fahrtenbuch_trips`, `fahrtenbuch_assignment_audit` | `documents` | The Fahrtenbuch is a statutory document. It is imported, corrected and exported on `/company-planner` and `/stundennachweis`, and App.tsx gates both routes with the `dokumente` plan feature. |
  | `company_planning_runs`, `company_planning_run_blocks`, `planning_finalizations`, `planning_run_adjustments`, `monthly_planning_manual_exceptions` | `documents` | The Monatsplanung's whole output is the Stundennachweis PDF and the corrected Fahrtenbuch; its screen is `/company-planner`, plan feature `dokumente`. |
  | `historical_reconciliations`, `historical_block_adjustments`, `historical_driver_hour_targets`, `historical_payroll_targets`, `historical_time_adjustments`, `historical_wh_saved_plans` and the three `historical_reconciliation_*` children | `documents` | the two historical wizards are modes of that same screen (`CompanyPlannerPage` branches on `planningMode`). |
  | `saved_stundennachweise`                                            | `documents`    | a saved Stundennachweis; `DocumentsPage` is what lists, opens and deletes them. |
  | `document_templates`                                                | `documents`    | the Dokumente screen's own templates. |
  | `document_blocks`, `document_variables`                             | `documents`    | children of `documents`, which has been gated on that page since 20260910120000 — 3.3's child loop carried the tenant term and not the gate, so a role that may not edit a document could edit its blocks and variables. Not on the owner's list; found here. |
  | `cash_transactions`                                                 | `cash-balance` | the Bargeldbestand screen's table. |
  | `car_driver_assignments`                                            | `cars`         | written from `CarModal` and `CarsManagement` and from nowhere else. |

  Four tables on the owner's list are deliberately **not** gated, each for a
  reason that already closes it or makes a page gate wrong:

  - `notification_settings` — its writes ask `is_company_admin()`, which is
    stricter than any page. Giving it a page would widen it.
  - `cash_movements`, `salary_cash_receipts` — `authenticated` holds SELECT and
    nothing else (20260914140000), so they carry no write policy to gate. Their
    three writers are the Gehaltsquittung RPCs, which have asked
    `current_role_permits('salaries', true)` since they were written.
  - `document_counters` — `REVOKE ALL ... FROM anon, authenticated`. No client
    role reaches it at all; matrix.sql reads `PP` in every cell.

  SELECT is **not** gated anywhere here. 3.3's shape has no role term on SELECT
  and this file does not invent one: a page a role may not edit is still a page
  it may read, and `can_view` already governs what the screens show.

  ## Whose access changes, exactly

  A gate is a conjunct, so this file can only ever narrow. Against the four
  system roles as 20260302065621 seeded them and `tests/rls/roles-seed.sql`
  restates them:

      admin       can_edit on all sixteen pages            → nothing changes
      supervisor  can_edit on all sixteen pages            → nothing changes
      editor      can_edit everywhere except accounting,
                  documents, settings, statistics, users,
                  roles                                     → loses the writes of
                  the `documents` group above (Fahrtenbuch, planning,
                  historical, Stundennachweis, templates, blocks, variables) and
                  the five planning RPCs. Keeps cash_transactions and
                  car_driver_assignments.
      viewer      can_edit nowhere                          → loses every write
                  in the table above and the five planning RPCs. This is the
                  hole the slice closes.

  **This migration writes no `role_permissions` row and creates no page key.**
  Self-check 6 proves it by comparing the table's row count and content hash
  from before the first statement of this file to after the last, so no role's
  definition is edited here and no role gains anything.

  What a company *keeps* is the ability to decide: an administrator who wants
  an editor to go on planning months ticks *Bearbeiten* on the Dokumente page of
  that role, in the Rollen screen, and the database follows at once.

  ## How to verify on a copy of production

  Restore a copy, apply this migration, and run the read-only query in the pull
  request. It lists every **active** account whose effective rights change —
  one row per (company, account, role, capability lost) — by asking
  `role_permissions` which roles lack `can_edit` on `documents`, `cash-balance`
  and `cars` and joining the accounts that hold them. An empty result is the
  proof that nobody's access changed in fact. A non-empty one names exactly the
  people to decide about before merging.

  ## The RPCs

  `apply_monthly_planning_run`, `replace_monthly_planning_run`,
  `delete_or_archive_monthly_planning_run`, `purge_old_monthly_planning_runs`
  and `reassign_fahrtenbuch_trip` are `SECURITY DEFINER`: they run as their
  owner, past RLS, and each writes the tables above. Each now asks
  `current_role_permits('documents', true)` — the page its tables carry —
  immediately **after** its own "caller has no company" branch, so the state
  rules of 3.3 still answer first and a suspended company's administrator gets
  the same message it gets today.

  The three Gehaltsquittung RPCs are unchanged: they already ask
  `current_role_permits('salaries', true)`. `get_weekly_abrechnung`,
  `get_monthly_abrechnung`, `get_driver_weekly_abrechnung` and
  `get_driver_monthly_abrechnung` are unchanged too, and the reason is a fact
  rather than a judgement: they are `SECURITY INVOKER` (`prosecdef = false`,
  asserted in self-check 5), so they return exactly what the caller's own
  policies on `income`, `receipts` and `cash_transactions` admit. A caller that
  may not read them gets no rows. `redeem_activation_code` is untouched for
  3.3's reason: it is the way *out* of a blocked state.

  Each body is changed **from the catalogue**, as 20260917130000 and
  20260921110010 did for these same functions: `pg_get_functiondef()` is read,
  one anchor must match exactly once or the migration fails having changed
  nothing, the block is spliced in and the result executed. `CREATE OR REPLACE`
  keeps the owner, `SECURITY DEFINER`, the pinned `search_path` and the ACL.

  ## Compatibility — this does NOT bump deploy/SCHEMA_EPOCH

  Policies are replaced with narrower ones and five function bodies gain a
  refusal. No object is dropped, no column changes meaning, no data is
  rewritten and no grant is widened. A rollback across this file restores the
  previous release's policies and bodies, which are the wider ones — so the
  previous release's screens work exactly as they did.
*/

-- ─── 0. What role_permissions holds before this file touches anything ───────
--
-- Captured so self-check 6 can prove this migration wrote none of it.

DROP TABLE IF EXISTS _pc_before_role_permissions;
CREATE TEMP TABLE _pc_before_role_permissions AS
SELECT count(*) AS n,
       md5(coalesce(string_agg(role_id::text || '|' || page_key || '|' ||
                               can_view::text || '|' || can_edit::text,
                               ',' ORDER BY role_id, page_key), '')) AS digest
  FROM public.role_permissions;

-- ─── 1. The tables, restated in 20260917130000's shape with the page gate ───
--
-- One shape, canonical names, and nothing else touched:
--
--   SELECT  company_id = active            OR  platform reads
--   INSERT  company_id = active AND gate   OR  platform writes (false today)
--   UPDATE  the same, as USING and as WITH CHECK
--   DELETE  the same USING, with the delete gate
--
-- Writing the same predicate as USING and as WITH CHECK is what refuses a move
-- between companies, and the extra INSERT clauses are carried character for
-- character: `fahrtenbuch_imports.imported_by = auth.uid()` and
-- `fahrtenbuch_assignment_audit.changed_by = auth.uid()` are the only thing
-- stopping one member filing an import, or a reassignment record, in another
-- member's name (CLAUDE.md; self-check 10 of 20260917130000 exists for them).
-- `fahrtenbuch_trips` keeps no UPDATE policy at all.

DO $mig$
DECLARE
  t        record;
  p        record;
  v_tbl    text;
  v_gate_w text;
  v_gate_d text;
  v_where  text;
  v_count  int := 0;
  v_admin  constant text := '(SELECT public.is_company_admin())';
  v_tenant constant text := 'company_id = (SELECT public.get_active_company_id())';
  v_reads  constant text := '(SELECT public.platform_reads_company_data())';
  v_writes constant text := '(SELECT public.platform_writes_company_data())';
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      -- table                                ops     page            delete_stays_admin  extra INSERT predicate
      ('car_driver_assignments',              'SIUD', 'cars',         false, NULL),
      ('cash_transactions',                   'SIUD', 'cash-balance', false, NULL),
      ('document_templates',                  'SIUD', 'documents',    false, NULL),
      ('company_planning_runs',               'SIUD', 'documents',    false, NULL),
      ('company_planning_run_blocks',         'SIUD', 'documents',    false, NULL),
      ('monthly_planning_manual_exceptions',  'SIUD', 'documents',    false, NULL),
      ('planning_finalizations',              'SIUD', 'documents',    false, NULL),
      ('planning_run_adjustments',            'SIUD', 'documents',    false, NULL),
      ('historical_reconciliations',          'SIUD', 'documents',    false, NULL),
      ('historical_block_adjustments',        'SIUD', 'documents',    false, NULL),
      ('historical_driver_hour_targets',      'SIUD', 'documents',    false, NULL),
      ('historical_payroll_targets',          'SIUD', 'documents',    false, NULL),
      ('historical_time_adjustments',         'SIUD', 'documents',    false, NULL),
      ('historical_wh_saved_plans',           'SIUD', 'documents',    false, NULL),
      ('saved_stundennachweise',              'SIUD', 'documents',    false, NULL),
      -- Deleting an import takes a finalized month's trips with it, so DELETE
      -- stays the administrator's alone, exactly as 20260917130000 left it.
      -- Replacing that term with the page gate would *widen* it: a supervisor
      -- holds can_edit on every page and would gain the delete.
      ('fahrtenbuch_imports',                 'SIUD', 'documents',    true,  'imported_by = auth.uid()'),
      ('fahrtenbuch_trips',                   'SID',  'documents',    true,  NULL),
      ('fahrtenbuch_assignment_audit',        'SI',   'documents',    false, 'changed_by = auth.uid()')
    ) AS v(tbl, ops, page, delete_admin, ins_extra)
  LOOP
    v_tbl := t.tbl;

    IF to_regclass('public.' || v_tbl) IS NULL THEN
      RAISE EXCEPTION 'slice C: % is not present', v_tbl;
    END IF;

    v_gate_w := format('(SELECT public.current_role_permits(%L, true))', t.page);
    v_gate_d := CASE WHEN t.delete_admin THEN v_admin ELSE v_gate_w END;

    FOR p IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, v_tbl);
    END LOOP;

    IF position('S' in t.ops) > 0 THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s OR %s)',
        v_tbl || '_select', v_tbl, v_tenant, v_reads);
    END IF;

    IF position('I' in t.ops) > 0 THEN
      v_where := v_tenant || ' AND ' || v_gate_w
                 || coalesce(' AND ' || t.ins_extra, '');
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK ((%s) OR %s)',
        v_tbl || '_insert', v_tbl, v_where, v_writes);
    END IF;

    IF position('U' in t.ops) > 0 THEN
      v_where := v_tenant || ' AND ' || v_gate_w;
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated '
        'USING ((%s) OR %s) WITH CHECK ((%s) OR %s)',
        v_tbl || '_update', v_tbl, v_where, v_writes, v_where, v_writes);
    END IF;

    IF position('D' in t.ops) > 0 THEN
      v_where := v_tenant || ' AND ' || v_gate_d;
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING ((%s) OR %s)',
        v_tbl || '_delete', v_tbl, v_where, v_writes);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  IF v_count <> 18 THEN
    RAISE EXCEPTION 'slice C: restated % tables, expected 18', v_count;
  END IF;
  RAISE NOTICE 'slice C: % tenant tables now carry a page gate', v_count;
END $mig$;

-- ─── 2. The tables that reach their company through a parent ────────────────
--
-- The same shape, with the parent's company in place of the row's own and the
-- parent's page beside it. The platform read term stays inside the EXISTS, as
-- 20260917130000 wrote it: without a parent row there is nothing to read
-- either way.

DO $mig$
DECLARE
  t       record;
  p       record;
  v_read  text;
  v_write text;
  v_gate  text;
  v_count int := 0;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('document_blocks',                      'documents',                  'document_id',       'd',  'documents'),
      ('document_variables',                   'documents',                  'document_id',       'd',  'documents'),
      ('historical_reconciliation_drivers',    'historical_reconciliations', 'reconciliation_id', 'hr', 'documents'),
      ('historical_reconciliation_results',    'historical_reconciliations', 'reconciliation_id', 'hr', 'documents'),
      ('historical_reconciliation_wh_drivers', 'historical_reconciliations', 'reconciliation_id', 'hr', 'documents')
    ) AS v(tbl, parent, fk, alias, page)
  LOOP
    IF to_regclass('public.' || t.tbl) IS NULL THEN
      RAISE EXCEPTION 'slice C: % is not present', t.tbl;
    END IF;

    v_gate := format('(SELECT public.current_role_permits(%L, true))', t.page);

    v_read := format(
      'EXISTS (SELECT 1 FROM public.%I %I WHERE %I.id = %I.%I '
      'AND (%I.company_id = (SELECT public.get_active_company_id()) '
      'OR (SELECT public.platform_reads_company_data())))',
      t.parent, t.alias, t.alias, t.tbl, t.fk, t.alias);

    v_write := format(
      '(EXISTS (SELECT 1 FROM public.%I %I WHERE %I.id = %I.%I '
      'AND %I.company_id = (SELECT public.get_active_company_id())) AND %s) '
      'OR (SELECT public.platform_writes_company_data())',
      t.parent, t.alias, t.alias, t.tbl, t.fk, t.alias, v_gate);

    FOR p IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t.tbl
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t.tbl);
    END LOOP;

    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)',
                   t.tbl || '_select', t.tbl, v_read);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)',
                   t.tbl || '_insert', t.tbl, v_write);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',
                   t.tbl || '_update', t.tbl, v_write, v_write);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (%s)',
                   t.tbl || '_delete', t.tbl, v_write);

    v_count := v_count + 1;
  END LOOP;

  IF v_count <> 5 THEN
    RAISE EXCEPTION 'slice C: restated % child tables, expected 5', v_count;
  END IF;
  RAISE NOTICE 'slice C: % child tables now carry their parent''s page gate', v_count;
END $mig$;

-- ─── 3. The five planning RPCs ask the same page ────────────────────────────
--
-- Spliced in after each function's own "caller has no company" branch, so the
-- state gate of 20260917130000 still answers first: a suspended company's
-- administrator keeps getting `caller has no company`, which is what
-- tests/rls/tenant-state.sql section 4 asserts.

DO $mig$
DECLARE
  -- The company branch, as all five write it. \1 puts it back character for
  -- character, and the block follows it.
  c_anchor CONSTANT text :=
    '(IF\s+(?:v_company|v_caller_company)\s+IS\s+NULL\s+THEN\s*'
    || 'RAISE\s+EXCEPTION\s+''[a-z_]+: caller has no company''\s*;\s*'
    || 'END\s+IF\s*;)';

  v_sig     text;
  v_def     text;
  v_new     text;
  v_hits    integer;
  v_block   text;
  v_changed integer := 0;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.apply_monthly_planning_run(jsonb)',
    'public.replace_monthly_planning_run(jsonb, uuid)',
    'public.delete_or_archive_monthly_planning_run(uuid)',
    'public.purge_old_monthly_planning_runs(integer, integer)',
    'public.reassign_fahrtenbuch_trip(uuid, uuid, text, text, text, text)'
  ]
  LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'slice C: % does not exist', v_sig;
    END IF;

    v_def := pg_get_functiondef(to_regprocedure(v_sig));

    IF v_def ~ 'current_role_permits' THEN
      RAISE EXCEPTION 'slice C: % already asks a page — read its body before running this again', v_sig;
    END IF;

    SELECT count(*) INTO v_hits FROM regexp_matches(v_def, c_anchor, 'g');
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'slice C: % has its company branch % times in the shape this migration expects, not exactly once — read its body before changing this',
        v_sig, v_hits;
    END IF;

    -- Kept free of the words self-check 4 looks for, so a comment cannot be
    -- mistaken for the code it describes.
    v_block :=
         chr(10) || chr(10)
      || '-- 20260923130000 (slice C): the tables this function writes carry the' || chr(10)
      || '-- Dokumente page of role_permissions, so the function asks the same' || chr(10)
      || '-- question. Without it a role that may not edit that page applied,' || chr(10)
      || '-- replaced, archived, purged or reassigned a whole month through' || chr(10)
      || '-- PostgREST with the token it already held.' || chr(10)
      || 'IF NOT current_role_permits(''documents'', true) THEN' || chr(10)
      || 'RAISE EXCEPTION ''Keine Berechtigung: die Rolle darf die Seite Dokumente nicht bearbeiten.''' || chr(10)
      || 'USING ERRCODE = ''42501'', HINT = ''not_authorized'';' || chr(10)
      || 'END IF;';

    v_new := regexp_replace(v_def, c_anchor, '\1' || v_block);

    IF v_new = v_def THEN
      RAISE EXCEPTION 'slice C: the splice changed nothing in %', v_sig;
    END IF;

    EXECUTE v_new;
    v_changed := v_changed + 1;
  END LOOP;

  IF v_changed <> 5 THEN
    RAISE EXCEPTION 'slice C: changed % planning functions, expected 5', v_changed;
  END IF;
  RAISE NOTICE 'slice C: % planning functions ask current_role_permits(''documents'', true)', v_changed;
END $mig$;

/*
  A SECURITY DEFINER function runs as its owner, and on the live databases these
  five belong to `postgres` rather than to the role running the migrations
  (`CREATE OR REPLACE` keeps the owner). 20260910120000 revoked EXECUTE on
  current_role_permits() from PUBLIC and granted it to `authenticated` alone, so
  an owner that is not a superuser and holds no grant of its own would fail at
  call time — inside the planning apply step. The loop asks the catalogue rather
  than a list, exactly as 20260917130000's does for get_active_company_id(), so
  it also covers anything a later migration rewrites onto the helper.
*/
DO $mig$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT ro.rolname
      FROM pg_proc p
      JOIN pg_roles ro ON ro.oid = p.proowner
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef
       AND n.nspname IN ('public', 'app_private')
       AND p.prosrc ~ 'current_role_permits'
       AND NOT ro.rolsuper
       AND NOT has_function_privilege(ro.oid, 'public.current_role_permits(text,boolean)', 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.current_role_permits(text, boolean) TO %I', r.rolname);
    RAISE NOTICE 'slice C: granted EXECUTE on current_role_permits() to %', r.rolname;
  END LOOP;
END $mig$;

COMMENT ON FUNCTION public.apply_monthly_planning_run(jsonb) IS
  'Applies a monthly planning run in one transaction. Since 20260923130000 the caller must hold can_edit on the Dokumente page, the page its tables carry.';
COMMENT ON FUNCTION public.replace_monthly_planning_run(jsonb, uuid) IS
  'Replaces an applied planning run and archives the old one. Since 20260923130000 the caller must hold can_edit on the Dokumente page.';
COMMENT ON FUNCTION public.delete_or_archive_monthly_planning_run(uuid) IS
  'Deletes or archives a planning run of the caller''s company. Since 20260923130000 the caller must hold can_edit on the Dokumente page.';
COMMENT ON FUNCTION public.purge_old_monthly_planning_runs(integer, integer) IS
  'Purges replaced and archived planning runs of the caller''s company. Since 20260923130000 the caller must hold can_edit on the Dokumente page.';
COMMENT ON FUNCTION public.reassign_fahrtenbuch_trip(uuid, uuid, text, text, text, text) IS
  'Reassigns one trip and records it in fahrtenbuch_assignment_audit. Since 20260923130000 the caller must hold can_edit on the Dokumente page.';

-- ─── 4. Self-check ──────────────────────────────────────────────────────────

DO $mig$
DECLARE
  t          record;
  v_cmd      text;
  v_expr     text;
  v_n        int;
  v_missing  text[] := '{}';
  v_before   record;
  v_after_n  int;
  v_after_d  text;
  v_src      text;
  v_frag     text;
  v_sig      text;
BEGIN
  -- 1. every newly gated table carries the page gate on every write command it
  --    has, and the tenant term with it.
  FOR t IN
    SELECT * FROM (VALUES
      ('car_driver_assignments',              'cars',         'IUD'),
      ('cash_transactions',                   'cash-balance', 'IUD'),
      ('document_templates',                  'documents',    'IUD'),
      ('company_planning_runs',               'documents',    'IUD'),
      ('company_planning_run_blocks',         'documents',    'IUD'),
      ('monthly_planning_manual_exceptions',  'documents',    'IUD'),
      ('planning_finalizations',              'documents',    'IUD'),
      ('planning_run_adjustments',            'documents',    'IUD'),
      ('historical_reconciliations',          'documents',    'IUD'),
      ('historical_block_adjustments',        'documents',    'IUD'),
      ('historical_driver_hour_targets',      'documents',    'IUD'),
      ('historical_payroll_targets',          'documents',    'IUD'),
      ('historical_time_adjustments',         'documents',    'IUD'),
      ('historical_wh_saved_plans',           'documents',    'IUD'),
      ('saved_stundennachweise',              'documents',    'IUD'),
      -- the two whose DELETE is the administrator's; I and U carry the page
      ('fahrtenbuch_imports',                 'documents',    'IU'),
      ('fahrtenbuch_trips',                   'documents',    'I'),
      ('fahrtenbuch_assignment_audit',        'documents',    'I'),
      ('document_blocks',                     'documents',    'IUD'),
      ('document_variables',                  'documents',    'IUD'),
      ('historical_reconciliation_drivers',   'documents',    'IUD'),
      ('historical_reconciliation_results',   'documents',    'IUD'),
      ('historical_reconciliation_wh_drivers','documents',    'IUD')
    ) AS v(tbl, page, cmds)
  LOOP
    FOREACH v_cmd IN ARRAY regexp_split_to_array(t.cmds, '')
    LOOP
      SELECT count(*) INTO v_n
        FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = t.tbl
         AND cmd = CASE v_cmd WHEN 'I' THEN 'INSERT' WHEN 'U' THEN 'UPDATE' ELSE 'DELETE' END
         AND coalesce(qual, '') || ' ' || coalesce(with_check, '')
             ~ ('current_role_permits\(''' || t.page || '''')
         AND coalesce(qual, '') || ' ' || coalesce(with_check, '')
             ~ 'get_active_company_id\(\)';
      IF v_n <> 1 THEN
        v_missing := v_missing || (t.tbl || '.' || v_cmd);
      END IF;
    END LOOP;
  END LOOP;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'slice C self-check 1: these write policies do not carry the page gate beside the tenant term: %',
      array_to_string(v_missing, ', ');
  END IF;

  -- 1b. an UPDATE states the same predicate as USING and as WITH CHECK, or the
  --     row could leave its company.
  SELECT count(*) INTO v_n
    FROM pg_policies
   WHERE schemaname = 'public'
     AND cmd = 'UPDATE'
     AND policyname IN (
       'car_driver_assignments_update','cash_transactions_update','document_templates_update',
       'company_planning_runs_update','company_planning_run_blocks_update',
       'monthly_planning_manual_exceptions_update','planning_finalizations_update',
       'planning_run_adjustments_update','historical_reconciliations_update',
       'historical_block_adjustments_update','historical_driver_hour_targets_update',
       'historical_payroll_targets_update','historical_time_adjustments_update',
       'historical_wh_saved_plans_update','saved_stundennachweise_update',
       'fahrtenbuch_imports_update','document_blocks_update','document_variables_update',
       'historical_reconciliation_drivers_update','historical_reconciliation_results_update',
       'historical_reconciliation_wh_drivers_update')
     AND qual IS NOT DISTINCT FROM with_check;
  IF v_n <> 21 THEN
    RAISE EXCEPTION 'slice C self-check 1b: % of 21 UPDATE policies state the same predicate twice', v_n;
  END IF;

  -- 2. the two load-bearing INSERT clauses survived the restatement.
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND policyname = 'fahrtenbuch_imports_insert'
                    AND with_check ~ 'imported_by = auth\.uid\(\)') THEN
    RAISE EXCEPTION 'slice C self-check 2: fahrtenbuch_imports_insert lost imported_by = auth.uid()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND policyname = 'fahrtenbuch_assignment_audit_insert'
                    AND with_check ~ 'changed_by = auth\.uid\(\)') THEN
    RAISE EXCEPTION 'slice C self-check 2: fahrtenbuch_assignment_audit_insert lost changed_by = auth.uid()';
  END IF;

  -- 3. fahrtenbuch_trips still has no UPDATE policy, and the two DELETEs that
  --    were the administrator's still are.
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'fahrtenbuch_trips' AND cmd = 'UPDATE') THEN
    RAISE EXCEPTION 'slice C self-check 3: fahrtenbuch_trips gained an UPDATE policy — every mutable field is an RPC''s';
  END IF;
  FOR t IN SELECT unnest(ARRAY['fahrtenbuch_imports_delete', 'fahrtenbuch_trips_delete']) AS pol
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND policyname = t.pol
                      AND qual ~ 'is_company_admin\(\)'
                      AND qual !~ 'current_role_permits') THEN
      RAISE EXCEPTION 'slice C self-check 3: % is no longer the administrator''s alone', t.pol;
    END IF;
  END LOOP;

  -- 4. the five planning functions ask the page exactly once, after their own
  --    company branch, and kept every load-bearing fragment of their old body.
  FOR t IN
    SELECT * FROM (VALUES
      ('public.apply_monthly_planning_run(jsonb)',
       ARRAY['get_active_company_id', 'apply_summary_json', 'is_canceled',
             'INSERT INTO company_planning_runs', 'v_updated_count']),
      ('public.replace_monthly_planning_run(jsonb, uuid)',
       ARRAY['get_active_company_id', 'p_old_run_id', 'apply_summary_json', 'is_canceled']),
      ('public.delete_or_archive_monthly_planning_run(uuid)',
       ARRAY['get_active_company_id', 'run does not belong to caller company']),
      ('public.purge_old_monthly_planning_runs(integer, integer)',
       ARRAY['get_active_company_id', 'replaced', 'archived']),
      ('public.reassign_fahrtenbuch_trip(uuid, uuid, text, text, text, text)',
       ARRAY['get_active_company_id', 'fahrtenbuch_assignment_audit', 'assigned_driver_id'])
    ) AS v(sig, fragments)
  LOOP
    v_sig := t.sig;
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'slice C self-check 4: % does not exist', v_sig;
    END IF;
    v_src := pg_get_functiondef(to_regprocedure(v_sig));

    SELECT count(*) INTO v_n FROM regexp_matches(v_src, 'IF NOT current_role_permits\(''documents'', true\) THEN', 'g');
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'slice C self-check 4: % asks the Dokumente page % times, expected once', v_sig, v_n;
    END IF;
    IF position('caller has no company' in v_src) = 0
       OR position('caller has no company' in v_src) > position('IF NOT current_role_permits' in v_src) THEN
      RAISE EXCEPTION 'slice C self-check 4: the page check of % does not sit after its own company branch', v_sig;
    END IF;
    IF v_src !~ 'not_authorized' THEN
      RAISE EXCEPTION 'slice C self-check 4: % lost the not_authorized hint', v_sig;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) THEN
      RAISE EXCEPTION 'slice C self-check 4: % is no longer SECURITY DEFINER', v_sig;
    END IF;
    FOREACH v_frag IN ARRAY t.fragments
    LOOP
      IF position(v_frag in v_src) = 0 THEN
        RAISE EXCEPTION 'slice C self-check 4: % lost the fragment %', v_sig, v_frag;
      END IF;
    END LOOP;
  END LOOP;

  -- 5. the Abrechnung readers are SECURITY INVOKER, which is why they need no
  --    gate of their own: the caller's own policies answer them.
  FOR t IN
    SELECT unnest(ARRAY[
      'public.get_weekly_abrechnung(integer, integer)',
      'public.get_monthly_abrechnung(integer, integer)']) AS sig
  LOOP
    IF to_regprocedure(t.sig) IS NOT NULL
       AND (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(t.sig)) THEN
      RAISE EXCEPTION 'slice C self-check 5: % became SECURITY DEFINER — it now needs a page gate of its own', t.sig;
    END IF;
  END LOOP;

  -- 6. nobody's rights were edited here: this migration wrote no
  --    role_permissions row and created no page key.
  SELECT * INTO v_before FROM _pc_before_role_permissions;
  SELECT count(*),
         md5(coalesce(string_agg(role_id::text || '|' || page_key || '|' ||
                                 can_view::text || '|' || can_edit::text,
                                 ',' ORDER BY role_id, page_key), ''))
    INTO v_after_n, v_after_d
    FROM public.role_permissions;
  IF v_after_n <> v_before.n OR v_after_d IS DISTINCT FROM v_before.digest THEN
    RAISE EXCEPTION 'slice C self-check 6: role_permissions changed (% rows before, % after) — this migration must not edit anybody''s role',
      v_before.n, v_after_n;
  END IF;

  -- 7. the eleven objects that were already gated still are. A release that
  --    loses one of them fails here, whatever else it was doing.
  v_missing := '{}';
  FOR t IN
    SELECT * FROM (VALUES
      ('cars', 'cars'), ('documents', 'documents'), ('driver_notes', 'notes'),
      ('drivers', 'drivers'), ('fixed_costs', 'fixed-costs'), ('income', 'income'),
      ('receipts', 'receipts'), ('salaries', 'salaries'), ('salary_payments', 'salaries'),
      ('werkstatt_checks', 'werkstatt')
    ) AS v(tbl, page)
  LOOP
    FOREACH v_cmd IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE']
    LOOP
      SELECT count(*) INTO v_n
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t.tbl AND cmd = v_cmd
         AND coalesce(qual, '') || ' ' || coalesce(with_check, '')
             ~ ('current_role_permits\(''' || t.page || '''');
      IF v_n <> 1 THEN
        v_missing := v_missing || (t.tbl || '.' || v_cmd);
      END IF;
    END LOOP;
  END LOOP;
  -- the eleventh: the salary-receipts bucket (20260917130000 section 7,
  -- restated by 20260920100000).
  SELECT count(*) INTO v_n
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ 'current_role_permits\(''salaries''';
  IF v_n = 0 THEN
    v_missing := v_missing || 'storage.objects(salary-receipts)';
  END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'slice C self-check 7: an object that was already role-gated lost its gate: %',
      array_to_string(v_missing, ', ');
  END IF;

  RAISE NOTICE 'slice C: self-check passed — 23 tables gated, 5 RPCs gated, role_permissions untouched, the 11 old gates intact';
END $mig$;

-- 8. What the four system roles may write on the three pages this slice uses,
--    printed into the release log so the change is on the record rather than in
--    a pull request only.
DO $mig$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT ro.name AS role_name, rp.page_key, rp.can_view, rp.can_edit
      FROM public.roles ro
      JOIN public.role_permissions rp ON rp.role_id = ro.id
     WHERE ro.is_system
       AND rp.page_key IN ('documents', 'cash-balance', 'cars')
     ORDER BY rp.page_key, ro.name
  LOOP
    RAISE NOTICE 'slice C: system role % on page % — view %, edit %',
      r.role_name, r.page_key, r.can_view, r.can_edit;
  END LOOP;
END $mig$;

DROP TABLE IF EXISTS _pc_before_role_permissions;
