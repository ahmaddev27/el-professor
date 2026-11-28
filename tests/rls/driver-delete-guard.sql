-- ════════════════════════════════════════════════════════════════════════════
--  A driver is deleted only when nothing refers to him (20261127130000)
-- ════════════════════════════════════════════════════════════════════════════
--
--  The owner's rule of 27.11.2026, which reverses "Fahrer werden deaktiviert,
--  nicht gelöscht" of 25.10.2026: a driver may be deleted when no row of any
--  kind refers to him, and the database says so on every path, because a
--  screen that asks first is not a wall. This file is the wall's own evidence.
--
--    §1  the catalogue, pinned as an exact set of (table, column, kind), and
--        every json column of the schema either searched or excluded for a
--        stated reason. A column added later fails here until somebody
--        classifies it, which is the point.
--    §2  an unreferenced driver is deleted by a company administrator.
--    §3  one probe per KIND of reference, each refused with the stable hint:
--        a foreign key that cascades, one that sets null, an id column with no
--        foreign key, a name on a Beleg and on an income row (case and padding
--        ignored, another company's same name ignored), a json document, and
--        a linked partner link.
--    §4  who may ask: the editor and the supervisor reach no row and get no
--        error, the viewer and the other company's administrator likewise; the
--        service role and the table owner are refused by the TRIGGER, which is
--        the one thing here no role can switch off.
--    §5  driver_delete_check, per principal, with the blockers it lists.
--    §6  a company's own hard delete still goes through with referenced
--        drivers, and a driver whose company is NULL is judged unscoped.
--    §7  mutation controls: the trigger dropped, the company-gone branch
--        removed, each kind taken out of the reader in turn. Each must make a
--        probe above fail, or the probe measured nothing.
--
--  Runs inside BEGIN ... ROLLBACK. Ids come from md5('dg:' || name), so a
--  failing line names a row. The trigger is never disabled to make a probe
--  pass: the controls in §7 replace or drop it inside a subtransaction that is
--  rolled back, to prove the probes can fail, and that is all.

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _dg_id(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT md5('dg:' || p)::uuid $$;

CREATE OR REPLACE FUNCTION _dg_as(p_who text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- A privilege error is raised at parse time and the plan the owner just
  -- warmed would hide it, so the owner's cached plans go first.
  DISCARD PLANS;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  IF p_who = 'anon' THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
  ELSIF p_who = 'service' THEN
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
  ELSE
    PERFORM set_config('request.jwt.claim.sub', p_who, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
END $$;

/* Back to the owner with no claims at all: set_config(..., true) lasts the whole
   transaction, so a user set by one probe would still be auth.uid() for the
   owner's next fixture insert, and a platform account's would arm the support
   write audit on it. */
CREATE OR REPLACE FUNCTION _dg_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

/* Runs p_sql as p_who ('owner', 'anon', 'service' or a user id) in a
   subtransaction that is NOT rolled back: `rows N`, the scalar, or
   `ERR <sqlstate> <hint-or-none>`. */
CREATE OR REPLACE FUNCTION _dg_call(p_who text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text; v_rows bigint; v_hint text; v_state text;
BEGIN
  IF p_who <> 'owner' THEN PERFORM _dg_as(p_who); END IF;
  IF p_sql ~* '^\s*(select|with)' THEN
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, 'null');
  ELSE
    EXECUTE p_sql;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_out := 'rows ' || v_rows;
  END IF;
  PERFORM _dg_reset();
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_state = RETURNED_SQLSTATE;
  PERFORM _dg_reset();
  RETURN 'ERR ' || v_state || ' ' || coalesce(nullif(v_hint, ''), '(no hint)');
END $$;

CREATE OR REPLACE FUNCTION _dg_del(p_who text, p_driver uuid) RETURNS text
LANGUAGE sql AS $$ SELECT _dg_call(p_who, format('DELETE FROM drivers WHERE id = %L', p_driver)) $$;

/* The DETAIL of the refusal a delete raises, as the owner. */
CREATE OR REPLACE FUNCTION _dg_msg(p_driver uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_detail text;
BEGIN
  DELETE FROM drivers WHERE id = p_driver;
  RETURN 'deleted';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  RETURN v_detail;
END $$;

CREATE OR REPLACE FUNCTION _dg_check(p_who text, p_driver uuid) RETURNS text
LANGUAGE sql AS $$ SELECT _dg_call(p_who, format('SELECT public.driver_delete_check(%L)::text', p_driver)) $$;

CREATE TEMP TABLE _dg_out (n serial PRIMARY KEY, label text NOT NULL, actual text NOT NULL, expected text NOT NULL, matched boolean NOT NULL);

CREATE OR REPLACE FUNCTION _dg_rec(p_label text, p_actual text, p_expected text, p_like boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  v_ok := CASE WHEN p_like THEN p_actual LIKE p_expected ELSE p_actual IS NOT DISTINCT FROM p_expected END;
  INSERT INTO _dg_out (label, actual, expected, matched) VALUES (p_label, coalesce(p_actual, 'NULL'), p_expected, v_ok);
  IF v_ok THEN RAISE NOTICE 'ok  %', p_label;
  ELSE RAISE WARNING 'XX  %', p_label; RAISE WARNING '      expected: %', p_expected; RAISE WARNING '      actual:   %', p_actual;
  END IF;
END $$;

-- ─── principals and fixtures ────────────────────────────────────────────────
-- seed.sql gives company A an administrator, an editor and a viewer, company B
-- an administrator and the platform owner. A supervisor of company A is made
-- here, because the matrix says supervisors write drivers today and the gate
-- has to refuse them.

INSERT INTO auth.users (id, email) VALUES (_dg_id('user:supervisor'), 'dg-supervisor@test.invalid');
INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, is_super_admin, status, must_change_password)
VALUES (_dg_id('user:supervisor'), 'dg-supervisor@test.invalid', 'DG Supervisor', 'supervisor',
        (SELECT id FROM roles WHERE name = 'supervisor' AND company_id IS NULL LIMIT 1),
        'c0000000-0000-4000-8000-00000000000a', false, 'active', false);

CREATE TEMP TABLE _dg_who (who text PRIMARY KEY, uid text NOT NULL);
INSERT INTO _dg_who VALUES
  ('admin A',    'a0000000-0000-4000-8000-000000000001'),
  ('editor A',   'a0000000-0000-4000-8000-000000000002'),
  ('viewer A',   'a0000000-0000-4000-8000-000000000003'),
  ('supervisor A', _dg_id('user:supervisor')::text),
  ('admin B',    'b0000000-0000-4000-8000-000000000001'),
  ('platform',   '50000000-0000-4000-8000-000000000001');

-- a Beleg or an income row in company B carrying a name company A also uses
INSERT INTO receipts (id, receipt_number, date, description, driver_name, company_id)
VALUES (_dg_id('receipt:other-company'), 'BEL-DG-B', current_date, 'dg other company', 'DG Shared Name',
        'c0000000-0000-4000-8000-00000000000b');

-- ─── §1 the catalogue ───────────────────────────────────────────────────────

DO $$
DECLARE
  v_pinned text[] := ARRAY[
      ('abrechnung_handovers.driver_id|fk'),
      ('abrechnung_handovers.driver_name|name'),
      ('car_driver_assignments.driver_id|fk'),
      ('company_planning_run_blocks.driver_id|id'),
      ('company_planning_run_blocks.driver_name|name'),
      ('company_planning_run_blocks.metadata_json|json'),
      ('company_planning_run_blocks.original_driver_id|id'),
      ('company_planning_run_blocks.original_driver_name|name'),
      ('company_planning_run_blocks.proposed_driver_id|id'),
      ('company_planning_run_blocks.proposed_driver_name|name'),
      ('company_planning_runs.apply_summary_json|json'),
      ('company_planning_runs.settings_json|json'),
      ('company_planning_runs.summary_json|json'),
      ('conflict_reviews.decided_values|json'),
      ('conflict_reviews.explanation_vars|json'),
      ('conflict_reviews.measured_values|json'),
      ('conflict_reviews.subject_driver_id|id'),
      ('driver_month_assignments.driver_id|fk'),
      ('driver_month_budget.driver_id|fk'),
      ('driver_month_budget.recompute_log|json'),
      ('driver_notes.change_log|json'),
      ('driver_notes.driver_id|fk'),
      ('fahrtenbuch_assignment_audit.new_assigned_driver_id|id'),
      ('fahrtenbuch_assignment_audit.new_assigned_driver_name|name'),
      ('fahrtenbuch_assignment_audit.old_assigned_driver_id|id'),
      ('fahrtenbuch_assignment_audit.old_assigned_driver_name|name'),
      ('fahrtenbuch_assignment_audit.original_driver_id|id'),
      ('fahrtenbuch_assignment_audit.original_driver_name|name'),
      ('fahrtenbuch_trips.assigned_driver_id|fk'),
      ('fahrtenbuch_trips.assigned_driver_name|name'),
      ('fahrtenbuch_trips.original_driver_id|fk'),
      ('fahrtenbuch_trips.original_driver_name|name'),
      ('historical_block_adjustments.conflicts|json'),
      ('historical_block_adjustments.fahrt_ids|json'),
      ('historical_block_adjustments.original_driver_name|name'),
      ('historical_block_adjustments.proposed_driver_id|id'),
      ('historical_block_adjustments.proposed_driver_name|name'),
      ('historical_block_adjustments.source_row_indices|json'),
      ('historical_driver_hour_targets.driver_id|fk'),
      ('historical_driver_hour_targets.driver_name|name'),
      ('historical_payroll_targets.driver_id|id'),
      ('historical_reconciliation_drivers.driver_id|fk'),
      ('historical_reconciliation_results.driver_id|fk'),
      ('historical_reconciliation_wh_drivers.driver_id|id'),
      ('historical_reconciliations.inhaber_driver_id|fk'),
      ('historical_wh_saved_plans.boundary_rows_json|json'),
      ('historical_wh_saved_plans.driver_configs_json|json'),
      ('historical_wh_saved_plans.driver_hour_summary_json|json'),
      ('historical_wh_saved_plans.note_reassignments_json|json'),
      ('historical_wh_saved_plans.shift_map_json|json'),
      ('historical_wh_saved_plans.source_columns_json|json'),
      ('historical_wh_saved_plans.validation_summary_json|json'),
      ('income.driver_name|name'),
      ('monthly_plan_block_trips.original_driver_id|id'),
      ('monthly_plan_block_trips.original_driver_name|name'),
      ('monthly_plan_blocks.driver_id|id'),
      ('monthly_plan_blocks.driver_name|name'),
      ('monthly_plan_drivers.driver_id|id'),
      ('monthly_plan_drivers.driver_name|name'),
      ('monthly_planning_manual_exceptions.assigned_driver_id|fk'),
      ('monthly_planning_manual_exceptions.assigned_driver_name|name'),
      ('monthly_plans.summary|json'),
      ('monthly_plans.warnings|json'),
      ('partner_driver_links.driver_id|fk'),
      ('partner_note_submissions.driver_id|fk'),
      ('partner_receipt_submissions.driver_id|fk'),
      ('planning_finalizations.driver_summary_json|json'),
      ('planning_run_adjustments.driver_id|id'),
      ('planning_run_adjustments.driver_name|name'),
      ('receipts.driver_name|name'),
      ('salaries.driver_id|fk'),
      ('salary_cash_receipts.driver_id|fk'),
      ('saved_stundennachweise.coverage_summary_json|json'),
      ('saved_stundennachweise.driver_id|fk'),
      ('saved_stundennachweise.driver_name|name'),
      ('saved_stundennachweise.generation_settings_json|json'),
      ('saved_stundennachweise.notes_snapshot_json|json'),
      ('saved_stundennachweise.rows_json|json'),
      ('saved_stundennachweise.totals_target_json|json'),
      ('saved_stundennachweise.warnings_json|json'),
      ('saved_stundennachweise.work_window_json|json'),
      ('uber_pull_runs.skipped|json'),
      ('uber_pull_runs.unmatched|json'),
      ('user_profiles.metadata|json')
    ];
  v_live   text[];
  v_extra  text;
  v_gone   text;
BEGIN
  SELECT array_agg(s.tbl || '.' || s.col || '|' || s.kind ORDER BY s.tbl, s.col) INTO v_live
    FROM app_private.driver_reference_columns() s;
  SELECT string_agg(x, ', ') INTO v_extra FROM unnest(v_live) x WHERE x <> ALL (v_pinned);
  SELECT string_agg(x, ', ') INTO v_gone  FROM unnest(v_pinned) x WHERE x <> ALL (v_live);
  PERFORM _dg_rec('catalogue: the reader finds no column this file does not pin', coalesce(v_extra, 'none'), 'none');
  PERFORM _dg_rec('catalogue: and misses none it does', coalesce(v_gone, 'none'), 'none');
  PERFORM _dg_rec('catalogue: the count', array_length(v_live, 1)::text, array_length(v_pinned, 1)::text);

  PERFORM _dg_rec('catalogue: every kind is one of fk, id, name, json',
    (SELECT count(*)::text FROM app_private.driver_reference_columns() s WHERE s.kind NOT IN ('fk', 'id', 'name', 'json')), '0');
  PERFORM _dg_rec('catalogue: the reader never names drivers itself',
    (SELECT count(*)::text FROM app_private.driver_reference_columns() s WHERE s.tbl = 'drivers'), '0');
END $$;

DO $$
DECLARE v_loose text; v_stale text;
BEGIN
  SELECT string_agg(c.relname || '.' || a.attname, ', ') INTO v_loose
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     AND c.relname <> 'drivers' AND a.atttypid IN ('json'::regtype, 'jsonb'::regtype)
     AND NOT EXISTS (SELECT 1 FROM app_private.driver_reference_columns() s
                      WHERE s.tbl = c.relname AND s.col = a.attname AND s.kind = 'json')
     AND NOT EXISTS (SELECT 1 FROM app_private.driver_reference_json_exclusions() e
                      WHERE e.tbl = c.relname AND e.col = a.attname);
  PERFORM _dg_rec('catalogue: every json column is searched or excluded', coalesce(v_loose, 'none'), 'none');

  SELECT string_agg(e.tbl || '.' || e.col, ', ') INTO v_stale
    FROM app_private.driver_reference_json_exclusions() e
   WHERE btrim(e.reason) = ''
      OR NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = to_regclass('public.' || quote_ident(e.tbl))
                        AND a.attname = e.col AND NOT a.attisdropped
                        AND a.atttypid IN ('json'::regtype, 'jsonb'::regtype));
  PERFORM _dg_rec('catalogue: every exclusion names a real json column and gives its reason', coalesce(v_stale, 'none'), 'none');
  PERFORM _dg_rec('catalogue: a column is never both searched and excluded',
    (SELECT count(*)::text FROM app_private.driver_reference_json_exclusions() e
      WHERE EXISTS (SELECT 1 FROM app_private.driver_reference_columns() s WHERE s.tbl = e.tbl AND s.col = e.col)), '0');

  -- the foreign keys come from pg_constraint, so a new one cannot be missed
  PERFORM _dg_rec('catalogue: every single-column foreign key to drivers is a kind-fk line',
    (SELECT coalesce(string_agg(c.relname || '.' || a.attname, ', '), 'none')
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      WHERE k.contype = 'f' AND k.confrelid = 'public.drivers'::regclass
        AND NOT EXISTS (SELECT 1 FROM app_private.driver_reference_columns() s
                         WHERE s.tbl = c.relname AND s.col = a.attname AND s.kind = 'fk')), 'none');
END $$;

-- ─── §2 an unreferenced driver goes ─────────────────────────────────────────

INSERT INTO drivers (id, company_id, name) VALUES
  (_dg_id('driver:free-1'), 'c0000000-0000-4000-8000-00000000000a', 'DG Free One'),
  (_dg_id('driver:free-2'), 'c0000000-0000-4000-8000-00000000000a', 'DG Free Two'),
  (_dg_id('driver:free-3'), 'c0000000-0000-4000-8000-00000000000a', 'DG Free Three'),
  (_dg_id('driver:free-4'), 'c0000000-0000-4000-8000-00000000000a', 'DG Free Four'),
  (_dg_id('driver:free-5'), 'c0000000-0000-4000-8000-00000000000a', 'DG Free Five'),
  (_dg_id('driver:free-6'), 'c0000000-0000-4000-8000-00000000000a', 'DG Free Six'),
  (_dg_id('driver:free-b'), 'c0000000-0000-4000-8000-00000000000b', 'DG Free B');

DO $$
BEGIN
  PERFORM _dg_rec('§2 a company administrator deletes a driver nothing refers to',
    _dg_del('a0000000-0000-4000-8000-000000000001', _dg_id('driver:free-1')), 'rows 1');
  PERFORM _dg_rec('§2 and the row is gone',
    (SELECT count(*)::text FROM drivers WHERE id = _dg_id('driver:free-1')), '0');
  -- the same name on another company's Beleg is not a reference of ours
  INSERT INTO drivers (id, company_id, name) VALUES (_dg_id('driver:shared-name'), 'c0000000-0000-4000-8000-00000000000a', 'DG Shared Name');
  PERFORM _dg_rec('§2 another company''s Beleg with the same name does not hold a driver back',
    _dg_del('a0000000-0000-4000-8000-000000000001', _dg_id('driver:shared-name')), 'rows 1');
END $$;

-- ─── §3 one probe per kind of reference ─────────────────────────────────────

CREATE TEMP TABLE _dg_kind (kind text, label text, drv uuid, tbl text, setup text);
INSERT INTO _dg_kind VALUES
 ('fk',   'a note (foreign key, CASCADE)',         _dg_id('k:note'),     'driver_notes',
   format($f$INSERT INTO driver_notes (id, created_by, driver_id, note_text, company_id) VALUES (%L, 'a0000000-0000-4000-8000-000000000001', %L, 'dg', 'c0000000-0000-4000-8000-00000000000a')$f$, _dg_id('k:note:row'), _dg_id('k:note'))),
 ('fk',   'a salary (foreign key, CASCADE)',       _dg_id('k:salary'),   'salaries',
   format($f$INSERT INTO salaries (id, driver_id, period_start, period_end, created_by, company_id) VALUES (%L, %L, '2026-01-01', '2026-01-31', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a')$f$, _dg_id('k:salary:row'), _dg_id('k:salary'))),
 ('fk',   'a trip''s assigned driver (foreign key, SET NULL)', _dg_id('k:trip'), 'fahrtenbuch_trips',
   format($f$INSERT INTO fahrtenbuch_trips (id, company_id, import_id, trip_date, original_driver_name, assigned_driver_name, assigned_driver_id) VALUES (%L, 'c0000000-0000-4000-8000-00000000000a', %L, '2026-01-05', 'DG Trip Original', 'DG Trip Label Only', %L)$f$, _dg_id('k:trip:row'), _dg_id('k:import'), _dg_id('k:trip'))),
 ('id',   'an id column with no foreign key',      _dg_id('k:target'),   'historical_payroll_targets',
   format($f$INSERT INTO historical_payroll_targets (company_id, month, year, driver_id, wage_type_code, wage_type_label) VALUES ('c0000000-0000-4000-8000-00000000000a', 1, 2026, %L, '1000', 'Grundlohn')$f$, _dg_id('k:target'))),
 ('name', 'a name on a Beleg',                    _dg_id('k:receipt'),  'receipts',
   $f$INSERT INTO receipts (receipt_number, date, description, driver_name, company_id) VALUES ('BEL-DG-1', current_date, 'dg', 'DG Receipt Driver', 'c0000000-0000-4000-8000-00000000000a')$f$),
 ('name', 'a name on an income row, case and padding ignored', _dg_id('k:income'), 'income',
   $f$INSERT INTO income (company_id, description, amount, type, driver_name) VALUES ('c0000000-0000-4000-8000-00000000000a', 'dg', 1, 'umsatz', '  dg INCOME driver ')$f$),
 ('json', 'a json document naming him',          _dg_id('k:json'),     'historical_wh_saved_plans',
   format($f$INSERT INTO historical_wh_saved_plans (company_id, month, year, shift_map_json) VALUES ('c0000000-0000-4000-8000-00000000000a', 2, 2026, jsonb_build_object('who', %L::text))$f$, _dg_id('k:json'))),
 ('fk',   'a LINKED partner link',                _dg_id('k:link'),     'partner_driver_links',
   format($f$INSERT INTO partner_driver_links (company_id, partner, external_driver_id, driver_id, status) VALUES ('c0000000-0000-4000-8000-00000000000a', 'reidey', 'dg-4711', %L, 'linked')$f$, _dg_id('k:link')));

INSERT INTO drivers (id, company_id, name)
SELECT k.drv, 'c0000000-0000-4000-8000-00000000000a',
       CASE k.tbl WHEN 'receipts' THEN 'DG Receipt Driver' WHEN 'income' THEN 'DG Income Driver'
                  WHEN 'fahrtenbuch_trips' THEN 'DG Trip Driver' ELSE 'DG ' || k.tbl || ' ' || left(k.drv::text, 6) END
  FROM _dg_kind k;
INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by, file_sha256)
VALUES (_dg_id('k:import'), 'c0000000-0000-4000-8000-00000000000a', 1, 2026, 'dg.xlsx',
        'a0000000-0000-4000-8000-000000000001', repeat('9', 64));
DO $$ DECLARE k record; BEGIN FOR k IN SELECT * FROM _dg_kind LOOP EXECUTE k.setup; END LOOP; END $$;

DO $$
DECLARE k record;
BEGIN
  FOR k IN SELECT * FROM _dg_kind ORDER BY tbl, label LOOP
    PERFORM _dg_rec(format('§3 %s: refused with the stable hint', k.label),
      _dg_del('a0000000-0000-4000-8000-000000000001', k.drv), 'ERR 23503 driver_has_references');
    PERFORM _dg_rec(format('§3 %s: and the driver is still there', k.label),
      (SELECT count(*)::text FROM drivers WHERE id = k.drv), '1');
  END LOOP;
  PERFORM _dg_rec('§3 the refusal names the tables in its DETAIL',
    (SELECT CASE WHEN _dg_msg(_dg_id('k:salary')) LIKE '%salaries (1)%' THEN 'named' ELSE 'not named' END), 'named');
END $$;

-- ─── §4 who may ask, and the one wall no role can switch off ───────────────
-- Fresh unreferenced drivers per principal, so the gate is measured on its own;
-- then a referenced driver, so the trigger is.

DO $$
DECLARE w record; v_n int := 0; d uuid;
BEGIN
  FOR w IN SELECT * FROM _dg_who WHERE who <> 'admin A' ORDER BY who LOOP
    v_n := v_n + 1;
    d := _dg_id('gate:' || w.who);
    INSERT INTO drivers (id, company_id, name) VALUES (d, 'c0000000-0000-4000-8000-00000000000a', 'DG Gate ' || v_n);
    PERFORM _dg_rec(format('§4 %s reaches no row, and gets no error', w.who), _dg_del(w.uid, d), 'rows 0');
    PERFORM _dg_rec(format('§4 …so the driver is still there (%s)', w.who),
      (SELECT count(*)::text FROM drivers WHERE id = d), '1');
  END LOOP;

  PERFORM _dg_rec('§4 anon reaches no row',
    _dg_del('anon', _dg_id('driver:free-2')), 'rows 0');

  -- the trigger, as the roles that bypass RLS
  PERFORM _dg_rec('§4 the service role is refused by the trigger on a referenced driver',
    _dg_del('service', _dg_id('k:note')), 'ERR 23503 driver_has_references');
  PERFORM _dg_rec('§4 the table owner is refused by the trigger on a referenced driver',
    _dg_del('owner', _dg_id('k:note')), 'ERR 23503 driver_has_references');
  PERFORM _dg_rec('§4 …and by each other kind too, as the owner',
    (SELECT string_agg(_dg_del('owner', k.drv), ' | ' ORDER BY k.tbl, k.label)
       FROM _dg_kind k),
    (SELECT string_agg('ERR 23503 driver_has_references', ' | ') FROM _dg_kind));
  PERFORM _dg_rec('§4 the service role deletes an unreferenced driver',
    _dg_del('service', _dg_id('driver:free-2')), 'rows 1');
  PERFORM _dg_rec('§4 and the table owner does too',
    _dg_del('owner', _dg_id('driver:free-3')), 'rows 1');

  -- a platform account with no context reaches no company row; one in a
  -- support session is an administrator of that company, which is the same
  -- door is_company_admin() has always been
  PERFORM _dg_rec('§4 the guard is a trigger, ENABLE ALWAYS, on the table',
    (SELECT g.tgenabled::text FROM pg_trigger g WHERE g.tgrelid = 'public.drivers'::regclass AND g.tgname = 'drivers_delete_guard'), 'A');
END $$;

-- ─── §5 driver_delete_check ─────────────────────────────────────────────────

DO $$
DECLARE
  v_free uuid := _dg_id('driver:free-4');
  v_ref  uuid := _dg_id('k:salary');
  v_admin constant text := 'a0000000-0000-4000-8000-000000000001';
  v_json text;
BEGIN
  v_json := _dg_check(v_admin, v_free);
  PERFORM _dg_rec('§5 admin A: an unreferenced driver is deletable, with no blockers',
    (v_json::jsonb ->> 'ok') || '/' || (v_json::jsonb ->> 'deletable') || '/' || jsonb_array_length(v_json::jsonb -> 'blockers'), 'true/true/0');

  v_json := _dg_check(v_admin, v_ref);
  PERFORM _dg_rec('§5 admin A: a driver with a salary is not deletable and the blocker is named',
    (v_json::jsonb ->> 'ok') || '/' || (v_json::jsonb ->> 'deletable') || '/' || (v_json::jsonb -> 'blockers')::text,
    'true/false/[{"rows": 1, "table": "salaries"}]');

  PERFORM _dg_rec('§5 admin A: an invented id is driver_not_found, not an empty list',
    (_dg_check(v_admin, gen_random_uuid())::jsonb ->> 'reason'), 'driver_not_found');
  PERFORM _dg_rec('§5 admin A: NULL is driver_not_found too',
    (_dg_call(v_admin, 'SELECT public.driver_delete_check(NULL)::text')::jsonb ->> 'reason'), 'driver_not_found');
  PERFORM _dg_rec('§5 admin A asking about company B''s driver learns nothing: driver_not_found',
    (_dg_check(v_admin, _dg_id('driver:free-b'))::jsonb ->> 'reason'), 'driver_not_found');
  PERFORM _dg_rec('§5 admin B asking about company A''s driver: driver_not_found',
    (_dg_check('b0000000-0000-4000-8000-000000000001', v_free)::jsonb ->> 'reason'), 'driver_not_found');

  PERFORM _dg_rec('§5 the editor is not_authorized, whatever the driver',
    (_dg_check('a0000000-0000-4000-8000-000000000002', v_free)::jsonb ->> 'reason'), 'not_authorized');
  PERFORM _dg_rec('§5 the supervisor is not_authorized',
    (_dg_check(_dg_id('user:supervisor')::text, v_free)::jsonb ->> 'reason'), 'not_authorized');
  PERFORM _dg_rec('§5 the viewer is not_authorized',
    (_dg_check('a0000000-0000-4000-8000-000000000003', v_free)::jsonb ->> 'reason'), 'not_authorized');
  PERFORM _dg_rec('§5 a platform account with no open context is not_authorized, never driver_not_found',
    (_dg_check('50000000-0000-4000-8000-000000000001', v_free)::jsonb ->> 'reason'), 'not_authorized');
  PERFORM _dg_rec('§5 a refusal never lists blockers',
    (_dg_check('a0000000-0000-4000-8000-000000000002', v_ref)::jsonb ? 'blockers')::text, 'false');

  PERFORM _dg_rec('§5 anon has no EXECUTE', _dg_check('anon', v_free), 'ERR 42501 (no hint)');
  PERFORM _dg_rec('§5 the service role has no EXECUTE', _dg_check('service', v_free), 'ERR 42501 (no hint)');

  -- the answer and the wall agree: what it calls deletable is deleted, and
  -- what it lists is what the trigger names
  PERFORM _dg_rec('§5 a driver the check calls deletable is deleted',
    _dg_del(v_admin, v_free), 'rows 1');
  PERFORM _dg_rec('§5 a driver it lists blockers for is refused, with the same tables in the DETAIL',
    CASE WHEN _dg_msg(_dg_id('k:receipt')) = 'receipts (1)' THEN 'same' ELSE _dg_msg(_dg_id('k:receipt')) END, 'same');
  PERFORM _dg_rec('§5 …and the check lists exactly that table',
    ((_dg_check(v_admin, _dg_id('k:receipt'))::jsonb -> 'blockers') -> 0 ->> 'table'), 'receipts');
  PERFORM _dg_rec('§5 a json document is a blocker the check lists by table',
    ((_dg_check(v_admin, _dg_id('k:json'))::jsonb -> 'blockers') -> 0 ->> 'table'), 'historical_wh_saved_plans');
  PERFORM _dg_rec('§5 a linked partner link is a blocker the check lists',
    ((_dg_check(v_admin, _dg_id('k:link'))::jsonb -> 'blockers') -> 0 ->> 'table'), 'partner_driver_links');
END $$;

-- ─── §6 the company's own delete, and a driver with no company ──────────────

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
VALUES (_dg_id('company:z'), 'DG Z', 'dg-z', 'approved', 'active', 'basic', 'active');
INSERT INTO drivers (id, company_id, name) VALUES (_dg_id('z:driver'), _dg_id('company:z'), 'DG Z Driver');
INSERT INTO salaries (id, driver_id, period_start, period_end, created_by, company_id)
VALUES (_dg_id('z:salary'), _dg_id('z:driver'), '2026-01-01', '2026-01-31', 'a0000000-0000-4000-8000-000000000001', _dg_id('company:z'));
INSERT INTO receipts (receipt_number, date, description, driver_name, company_id)
VALUES ('BEL-DG-Z', current_date, 'dg z', 'DG Z Driver', _dg_id('company:z'));

DO $$
BEGIN
  PERFORM _dg_rec('§6 a referenced driver of company Z cannot be deleted while Z exists',
    _dg_del('owner', _dg_id('z:driver')), 'ERR 23503 driver_has_references');
  PERFORM _dg_rec('§6 deleting the COMPANY removes it with its referenced driver, the guard standing aside',
    _dg_call('owner', format('DELETE FROM companies WHERE id = %L', _dg_id('company:z'))), 'rows 1');
  PERFORM _dg_rec('§6 …and the driver, the salary are gone',
    (SELECT (SELECT count(*) FROM drivers WHERE id = _dg_id('z:driver'))::text || '/' ||
            (SELECT count(*) FROM salaries WHERE id = _dg_id('z:salary'))::text), '0/0');
END $$;

-- NULL company: the guard has no company to scope by, so it counts every
-- reference there is. That is the safe direction: more blockers, never fewer.
INSERT INTO drivers (id, company_id, name) VALUES
  (_dg_id('n:driver-free'), NULL, 'DG Nobody Free'),
  (_dg_id('n:driver-named'), NULL, 'DG Receipt Driver');

DO $$
BEGIN
  PERFORM _dg_rec('§6 a driver with no company and no reference is deleted',
    _dg_del('owner', _dg_id('n:driver-free')), 'rows 1');
  PERFORM _dg_rec('§6 a driver with no company is judged against every company: a Beleg anywhere holds him',
    _dg_del('owner', _dg_id('n:driver-named')), 'ERR 23503 driver_has_references');
  PERFORM _dg_rec('§6 the check never answers for a driver with no company (not found for an administrator)',
    (_dg_check('a0000000-0000-4000-8000-000000000001', _dg_id('n:driver-named'))::jsonb ->> 'reason'), 'driver_not_found');
END $$;

-- ─── §7 mutation controls ───────────────────────────────────────────────────
-- A probe that cannot fail measures nothing. Each control breaks ONE rule inside
-- a subtransaction that is always rolled back, runs the probe that depends on
-- it, and requires the answer to be DIFFERENT from the healthy one. The trigger
-- is dropped or replaced here and nowhere else, and never to make a probe pass.

CREATE OR REPLACE FUNCTION _dg_mutant(p_mutation text, p_probe text, p_who text DEFAULT 'owner') RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_out text;
BEGIN
  BEGIN
    EXECUTE p_mutation;
    v_out := _dg_call(p_who, p_probe);
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = v_out;
  EXCEPTION WHEN SQLSTATE 'ZZ011' THEN
    v_out := SQLERRM;
  END;
  RESET ROLE;
  RETURN v_out;
END $$;

-- a company with a referenced driver, for the company-gone control
INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
VALUES (_dg_id('company:z2'), 'DG Z2', 'dg-z2', 'approved', 'active', 'basic', 'active');
INSERT INTO drivers (id, company_id, name) VALUES (_dg_id('z2:driver'), _dg_id('company:z2'), 'DG Z2 Driver');
INSERT INTO salaries (id, driver_id, period_start, period_end, created_by, company_id)
VALUES (_dg_id('z2:salary'), _dg_id('z2:driver'), '2026-01-01', '2026-01-31', 'a0000000-0000-4000-8000-000000000001', _dg_id('company:z2'));

DO $$
DECLARE
  v_del   constant text := format('DELETE FROM drivers WHERE id = %L', _dg_id('k:note'));
  v_co    constant text := format('DELETE FROM companies WHERE id = %L', _dg_id('company:z2'));
  v_edit  constant text := format('DELETE FROM drivers WHERE id = %L', _dg_id('driver:free-5'));
  v_src   text;
  v_new   text;
  v_kind  text;
  v_bad   int;
  k       record;
  v_res   text;
BEGIN
  -- the healthy answers the controls are compared with
  PERFORM _dg_rec('§7 healthy: a referenced driver is refused', _dg_call('owner', v_del), 'ERR 23503 driver_has_references');

  -- M1. no trigger at all
  PERFORM _dg_rec('§7 M1 the trigger dropped: the referenced driver goes, so probe §3 can fail',
    _dg_mutant('DROP TRIGGER drivers_delete_guard ON public.drivers', v_del), 'rows 1');

  -- M2. the company-gone branch removed
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'app_private.drivers_delete_guard()'::regprocedure;
  v_new := regexp_replace(v_src, 'IF OLD\.company_id IS NOT NULL.*?RETURN OLD;\s*END IF;', '', 's');
  PERFORM _dg_rec('§7 M2 the mutation actually removed the branch', (v_new <> v_src)::text, 'true');
  PERFORM _dg_rec('§7 M2 the company-gone branch removed: the company''s own delete is refused, so probe §6 can fail',
    _dg_mutant(format('CREATE OR REPLACE FUNCTION app_private.drivers_delete_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS %L', v_new),
               v_co),
    'ERR 23503 driver_has_references');
  PERFORM _dg_rec('§7 M2 healthy: the same company delete goes through', _dg_mutant('SELECT 1', v_co), 'rows 1');

  -- M3. each kind taken out of the reader in turn
  FOREACH v_kind IN ARRAY ARRAY['fk', 'id', 'name', 'json'] LOOP
    v_bad := 0;
    FOR k IN SELECT * FROM _dg_kind WHERE kind = v_kind LOOP
      v_res := _dg_mutant(format($m$
          ALTER FUNCTION app_private.driver_reference_columns() RENAME TO driver_reference_columns_orig;
          CREATE FUNCTION app_private.driver_reference_columns()
            RETURNS TABLE (tbl name, col name, kind text, col_type text, has_company boolean)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
            AS $f$ SELECT * FROM app_private.driver_reference_columns_orig() o WHERE o.kind <> %L $f$
        $m$, v_kind), format('DELETE FROM drivers WHERE id = %L', k.drv));
      IF v_res IS DISTINCT FROM 'ERR 23503 driver_has_references' THEN v_bad := v_bad + 1; END IF;
    END LOOP;
    PERFORM _dg_rec(format('§7 M3 kind %s taken out of the reader: every probe of that kind stops being refused', v_kind),
      v_bad::text, (SELECT count(*)::text FROM _dg_kind WHERE kind = v_kind));
  END LOOP;

  -- M4. the old page gate back on the policy
  PERFORM _dg_rec('§7 healthy: the editor reaches no row', _dg_call('a0000000-0000-4000-8000-000000000002', v_edit), 'rows 0');
  PERFORM _dg_rec('§7 M4 the page gate back on the policy: the editor deletes, so probe §4 can fail',
    _dg_mutant($m$DROP POLICY drivers_delete ON public.drivers;
                  CREATE POLICY drivers_delete ON public.drivers FOR DELETE TO authenticated
                    USING (company_id = (SELECT public.get_active_company_id()) AND (SELECT public.current_role_permits('drivers', true)))$m$,
               v_edit, 'a0000000-0000-4000-8000-000000000002'),
    'rows 1');
END $$;

-- ─── the verdict, all at once ───────────────────────────────────────────────

DO $$
DECLARE
  v_bad integer; r record; v_msg text := '';
BEGIN
  SELECT count(*) INTO v_bad FROM _dg_out WHERE NOT matched;
  IF v_bad = 0 THEN
    RAISE NOTICE '── driver delete guard: all % probes matched ──', (SELECT count(*) FROM _dg_out);
    RETURN;
  END IF;
  FOR r IN SELECT * FROM _dg_out WHERE NOT matched ORDER BY n LOOP
    v_msg := v_msg || format(E'\n  %s. %s\n     expected: %s\n     actual:   %s', r.n, r.label, r.expected, r.actual);
  END LOOP;
  RAISE EXCEPTION 'driver delete guard: % of % probes did not match:%', v_bad, (SELECT count(*) FROM _dg_out), v_msg;
END $$;

ROLLBACK;
