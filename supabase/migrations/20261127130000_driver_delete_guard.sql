/*
  A driver is deleted only when nothing refers to them (owner, 27.11.2026).

  WHAT THIS REVERSES. On 25.10.2026 the owner decided "Fahrer werden deaktiviert,
  nicht gelöscht", and the Fahrer screen stopped offering a delete at all. The
  reason was sound and has not gone away: eight foreign keys CASCADE off
  `drivers` (car_driver_assignments, driver_notes, driver_month_assignments,
  driver_month_budget, historical_reconciliation_drivers,
  historical_reconciliation_results, salaries and saved_stundennachweise, and
  salary_cash_receipts with them), and `salary_cash_receipts` carries the
  GQ-YYYY-NNNN numbers, which are gapless per company and year and go to the
  Steuerberater. A delete that took a receipt with it would leave a hole in a
  sequence nobody may have a hole in. Nine more columns are SET NULL, and a
  dozen more hold the driver's id or name with no foreign key at all.

  THE NEW RULE, and why it is safe where the old one was not. A driver may be
  deleted when NO row of any kind refers to them, and the database refuses
  otherwise, on every path: PostgREST, an RPC, the service role and the table
  owner. The cascade can then only ever remove nothing, because the delete is
  refused whenever there is something for it to remove. "Refers to" is read out
  of the catalogue, not written down (section 1):

    fk    a single-column foreign key to drivers, whatever its ON DELETE action
    id    a uuid or text column named like `*driver_id` with no such key (the
          planning snapshots hold the id and deliberately have no key)
    name  a text column named `*driver_name` on a table with a company_id:
          receipts and income name the driver and nothing else, and are
          compared as lower(btrim(...)) inside the company
    json  every json and jsonb column in public, searched for the driver's id,
          minus an explicit list of columns that cannot hold one

  A new column of any of those four kinds is covered the day it is created, and
  one the reader cannot classify fails tests/rls/driver-delete-guard.sql until
  somebody classifies it. A LIVE PARTNER LINK COUNTS (owner, 27.11.2026,
  question 2): a driver Reidey's roster knows by id is not deleted from under
  the next import, which would create a second one.

  THE EXCEPTION IS THE COMPANY'S OWN DELETE. The trigger stands aside once the
  company row is gone, the pattern of 20261016140000's freeze guards:
  platform_company_delete removes the company row first, so its cascades reach
  `drivers` with no company left to protect, and a driver carrying references
  must not make the company undeletable. A driver with a NULL company_id has no
  company that can ever go away, so it never stands aside; its scan is not
  confined to a company either (a NULL scope reads every company's rows, the
  conservative answer).

  THE GATE (owner, question 4). `drivers_delete` moves from the role page
  (`current_role_permits('drivers', true)`) to `is_company_admin()`: editor and
  supervisor lose a DELETE no screen has offered since 25.10.2026. The rest of
  the policy is 20260917130000's, unchanged: the tenant term
  `get_active_company_id()` and the platform write seam. One consequence is
  deliberate and recorded here: the module write gate of 20261027120000 lives
  inside `current_role_permits`, so an administrator whose company switched the
  Fahrer module off can still delete an UNREFERENCED driver. That is the same
  position every other administrator-gated table is in, and the only thing the
  delete can reach is a row nothing refers to.

  WHAT THE SCREEN ASKS. `public.driver_delete_check(driver)` answers whether the
  delete would be refused and by which tables, so the dialog can say why and
  offer Deaktivieren instead. It answers `{ok, deletable, blockers}`, or
  `{ok: false, reason}` with `not_authorized` (no session, or not an
  administrator, or no active company) ahead of `driver_not_found` (not a driver
  of the caller's active company). The trigger is the wall; this is the
  courtesy, and the two read one function, so they cannot disagree.

  THE UBER IMPORT UNDO. It deletes the drivers an import created after it has
  deleted their Uber income and their partner links, so the trigger sees exactly
  what the undo's own plan sees, with one exception: the plan's scan knew the
  foreign keys, the id columns and the names, and not the json documents. A
  driver named in a saved Stundennachweis would have turned a blocked driver
  (listed in the preview, kept) into a raised exception half way through the
  undo. `uber_undo_plan` is restated below with one block added, which asks the
  same reader for the json kind, so such a driver is a blocker again.

  COST. The trigger runs once per deleted row, and the API roles have an 8 s
  statement timeout. Every probe is filtered by company_id where the table has
  one (the foreign-key probes are not: a row of another company pointing at the
  driver must stop the delete too, and they cost what the cascade's own
  referential lookups cost). The json search is one pass per column over the
  company's rows.
*/

-- ─── 1. what refers to a driver, from the catalogue ─────────────────────────

-- Columns that cannot hold one of our driver ids, or are covered by their own
-- row, with the reason beside each. A json column NOT in this list is searched,
-- so a column added later is covered until somebody says otherwise here.
CREATE OR REPLACE FUNCTION app_private.driver_reference_json_exclusions()
RETURNS TABLE (tbl name, col name, reason text)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY SELECT * FROM (VALUES
    ('fahrtenbuch_trips'::name, 'raw_data_json'::name,
     'the imported file''s own content; the trip names its drivers in columns, which are searched'),
    ('fahrtenbuch_imports', 'source_columns_json',
     'the file''s header names'),
    ('import_column_mappings', 'field_map',
     'a mapping of header names to fields'),
    ('documents', 'content',
     'authored document text; holds no driver id'),
    ('document_blocks', 'content',
     'authored document text; holds no driver id'),
    ('subscription_plans', 'features_json',
     'the platform''s plan catalogue; no company, no driver'),
    ('partner_note_submissions', 'raw_payload',
     'the partner''s own payload; the submission names our driver in its driver_id column'),
    ('partner_receipt_submissions', 'raw_payload',
     'the partner''s own payload; the submission names our driver in its driver_id column'),
    ('uber_pull_runs', 'placed_drivers',
     'the names and the action taken, never an id (20261126110000)'),
    ('vehicle_day_plans', 'summary',
     'a closed object of fourteen numeric keys (20261022140000); it cannot name a driver'),
    ('historical_reconciliation_results', 'rows_json',
     'no company column and large; the row owns its driver in driver_id, which is a foreign key'),
    ('historical_reconciliation_results', 'corrections_json',
     'as rows_json'),
    ('historical_reconciliation_results', 'totals_json',
     'as rows_json')
  ) AS v(tbl, col, reason);
END;
$$;

-- (table, column, kind) for everything that can refer to a driver. `col_type`
-- is 'uuid', 'text' or 'json' and `has_company` says whether the probe may be
-- confined to one company.
CREATE OR REPLACE FUNCTION app_private.driver_reference_columns()
RETURNS TABLE (tbl name, col name, kind text, col_type text, has_company boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH cols AS (
    SELECT c.oid AS rel, c.relname, a.attnum, a.attname, a.atttypid,
           EXISTS (SELECT 1 FROM pg_attribute x
                    WHERE x.attrelid = c.oid AND x.attname = 'company_id'
                      AND x.attnum > 0 AND NOT x.attisdropped) AS has_co
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND c.relname <> 'drivers'
  ), fk AS (
    SELECT k.conrelid AS rel, k.conkey[1] AS attnum
      FROM pg_constraint k
     WHERE k.contype = 'f' AND array_length(k.conkey, 1) = 1
       AND k.confrelid = 'public.drivers'::regclass
  )
  SELECT c.relname, c.attname, 'fk'::text,
         CASE WHEN c.atttypid = 'uuid'::regtype THEN 'uuid' ELSE 'text' END, c.has_co
    FROM cols c
   WHERE EXISTS (SELECT 1 FROM fk WHERE fk.rel = c.rel AND fk.attnum = c.attnum)
  UNION ALL
  SELECT c.relname, c.attname, 'id'::text,
         CASE WHEN c.atttypid = 'uuid'::regtype THEN 'uuid' ELSE 'text' END, c.has_co
    FROM cols c
   WHERE c.atttypid IN ('uuid'::regtype, 'text'::regtype)
     AND c.attname ~ '(^|_)driver_id$' AND c.attname !~ 'external'
     AND NOT EXISTS (SELECT 1 FROM fk WHERE fk.rel = c.rel AND fk.attnum = c.attnum)
  UNION ALL
  SELECT c.relname, c.attname, 'name'::text, 'text', c.has_co
    FROM cols c
   WHERE c.has_co AND c.atttypid = 'text'::regtype
     AND c.attname ~ '(^|_)driver_name$' AND c.attname !~ 'external'
  UNION ALL
  SELECT c.relname, c.attname, 'json'::text, 'json', c.has_co
    FROM cols c
   WHERE c.atttypid IN ('json'::regtype, 'jsonb'::regtype)
     AND NOT EXISTS (SELECT 1 FROM app_private.driver_reference_json_exclusions() e
                      WHERE e.tbl = c.relname AND e.col = c.attname)
   ORDER BY 1, 2, 3;
END;
$$;

-- How many rows refer to each of the given drivers, per column. One statement
-- per column, built with format('%I') from the catalogue; the ids and the
-- company travel as parameters, so nothing a caller supplies is ever text in a
-- statement. `p_kinds` narrows the kinds (NULL is all of them). Names are
-- matched inside the company only, the way the product joins them, and an empty
-- name matches nothing.
CREATE OR REPLACE FUNCTION app_private.driver_reference_counts(
  p_driver_ids uuid[], p_company uuid, p_kinds text[] DEFAULT NULL)
RETURNS TABLE (driver_id uuid, tbl name, col name, kind text, n bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  r       record;
  v_scope text;
  v_sql   text;
BEGIN
  IF p_driver_ids IS NULL OR cardinality(p_driver_ids) = 0 THEN
    RETURN;
  END IF;

  FOR r IN SELECT * FROM app_private.driver_reference_columns() k
            WHERE p_kinds IS NULL OR k.kind = ANY (p_kinds)
            ORDER BY k.tbl, k.col, k.kind
  LOOP
    -- A foreign key is never confined to a company: a row anywhere that points
    -- at the driver must stop the delete.
    v_scope := CASE WHEN r.has_company AND r.kind <> 'fk'
                    THEN ' AND ($2 IS NULL OR t.company_id = $2)' ELSE '' END;

    v_sql := CASE
      WHEN r.kind IN ('fk', 'id') THEN format(
        'SELECT u.id, count(*) FROM public.%I t JOIN unnest($1) AS u(id) ON t.%I = %s WHERE true%s GROUP BY u.id',
        r.tbl, r.col, CASE WHEN r.col_type = 'uuid' THEN 'u.id' ELSE 'u.id::text' END, v_scope)
      WHEN r.kind = 'name' THEN format(
        'SELECT d.id, count(*) FROM public.%I t JOIN public.drivers d '
        'ON d.id = ANY($1) AND btrim(d.name) <> '''' AND lower(btrim(t.%I)) = lower(btrim(d.name)) '
        'WHERE true%s GROUP BY d.id',
        r.tbl, r.col, v_scope)
      ELSE format(
        'SELECT u.id, count(*) FROM public.%I t JOIN unnest($1) AS u(id) ON t.%I::text LIKE ''%%'' || u.id::text || ''%%'' '
        'WHERE true%s GROUP BY u.id',
        r.tbl, r.col, v_scope)
    END;

    RETURN QUERY EXECUTE
      format('SELECT x.id, %L::name, %L::name, %L::text, x.cnt FROM (%s) x(id, cnt)',
             r.tbl, r.col, r.kind, v_sql)
      USING p_driver_ids, p_company;
  END LOOP;
END;
$$;

-- Per table, rows summed over the table's columns: what the trigger names and
-- what driver_delete_check reports.
CREATE OR REPLACE FUNCTION app_private.driver_references(p_driver_id uuid, p_company uuid)
RETURNS TABLE (tbl name, n bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT c.tbl, sum(c.n)::bigint
    FROM app_private.driver_reference_counts(ARRAY[p_driver_id], p_company) c
   GROUP BY c.tbl
   ORDER BY c.tbl;
END;
$$;

REVOKE ALL ON FUNCTION app_private.driver_reference_json_exclusions() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.driver_reference_columns() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.driver_reference_counts(uuid[], uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.driver_references(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ─── 2. the wall: a BEFORE DELETE trigger on drivers ────────────────────────
--
--  SECURITY DEFINER because it must see every table whatever the caller's row
--  security, and it names app_private, which no API role may use. ENABLE ALWAYS
--  because session_replication_role = replica must not skip it. It refuses for
--  every role: the owner and the service role included, which is what makes it
--  the wall and the policy only the gate.

CREATE OR REPLACE FUNCTION app_private.drivers_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tables text;
BEGIN
  -- The company's own delete: its row is gone before its cascades reach here.
  IF OLD.company_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id) THEN
    RETURN OLD;
  END IF;

  SELECT string_agg(r.tbl || ' (' || r.n || ')', ', ' ORDER BY r.tbl)
    INTO v_tables
    FROM app_private.driver_references(OLD.id, OLD.company_id) r;

  IF v_tables IS NOT NULL THEN
    RAISE EXCEPTION 'Der Fahrer wird noch verwendet und kann nicht gelöscht werden.'
      USING ERRCODE = '23503', HINT = 'driver_has_references', DETAIL = v_tables;
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION app_private.drivers_delete_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS drivers_delete_guard ON public.drivers;
CREATE TRIGGER drivers_delete_guard
  BEFORE DELETE ON public.drivers
  FOR EACH ROW EXECUTE FUNCTION app_private.drivers_delete_guard();
ALTER TABLE public.drivers ENABLE ALWAYS TRIGGER drivers_delete_guard;

-- ─── 3. the question the screen asks ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.driver_delete_check(p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company  uuid;
  v_blockers jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_company_admin() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  v_company := public.get_active_company_id();
  IF v_company IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  IF p_driver_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.drivers d WHERE d.id = p_driver_id AND d.company_id = v_company) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'driver_not_found');
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('table', r.tbl, 'rows', r.n) ORDER BY r.tbl), '[]'::jsonb)
    INTO v_blockers
    FROM app_private.driver_references(p_driver_id, v_company) r;

  RETURN jsonb_build_object('ok', true, 'deletable', jsonb_array_length(v_blockers) = 0,
                            'blockers', v_blockers);
END;
$$;

REVOKE ALL ON FUNCTION public.driver_delete_check(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.driver_delete_check(uuid) TO authenticated;

COMMENT ON FUNCTION public.driver_delete_check(uuid) IS
  'Would deleting this driver be refused, and by which tables? {ok, deletable, blockers:[{table, rows}]}, or {ok:false, reason: not_authorized | driver_not_found}. Company administrators of the active company only. The refusal itself is the trigger drivers_delete_guard. 20261127130000.';

-- ─── 4. the gate: the administrator, no longer the role page ────────────────

DROP POLICY IF EXISTS drivers_delete ON public.drivers;
CREATE POLICY drivers_delete ON public.drivers
  FOR DELETE TO authenticated
  USING (((company_id = (SELECT public.get_active_company_id()))
          AND (SELECT public.is_company_admin()))
         OR (SELECT public.platform_writes_company_data()));

-- ─── 5. the Uber import undo asks the same reader ───────────────────────────
--
--  uber_undo_plan of 20261016120000, restated with ONE block added after the
--  scan: the json documents. Everything else is that function's body.

CREATE OR REPLACE FUNCTION app_private.uber_undo_plan(p_company uuid)
RETURNS TABLE (entity text, entity_id uuid, label text, blockers jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_partner CONSTANT text := 'reidey';
  v_driver_ids   uuid[];
  v_driver_texts text[];
  v_driver_names text[];
  v_car_ids      uuid[];
  v_plate_keys   text[];
  v_parts        text[] := '{}';
  v_sql          text;
  v_refs         jsonb := '[]'::jsonb;
  r              record;
BEGIN
  SELECT coalesce(array_agg(d.id), '{}'), coalesce(array_agg(d.id::text), '{}'),
         coalesce(array_agg(DISTINCT lower(btrim(d.name))), '{}')
    INTO v_driver_ids, v_driver_texts, v_driver_names
    FROM public.drivers d
    JOIN public.partner_driver_links l
      ON l.driver_id = d.id AND l.company_id = p_company AND l.partner = c_partner
     AND l.status = 'linked' AND l.created_by_import
   WHERE d.company_id = p_company;

  SELECT coalesce(array_agg(c.id), '{}'),
         coalesce(array_agg(DISTINCT app_private.partner_plate_key(c.kennzeichen)), '{}')
    INTO v_car_ids, v_plate_keys
    FROM public.cars c
    JOIN public.partner_vehicle_links l
      ON l.car_id = c.id AND l.company_id = p_company AND l.partner = c_partner
     AND l.status = 'linked' AND l.created_by_import
   WHERE c.company_id = p_company;

  FOR r IN SELECT * FROM app_private.uber_undo_reference_columns() LOOP
    v_parts := v_parts || CASE r.kind
      WHEN 'driver_id' THEN format(
        'SELECT ''driver''::text, %L::text, t.%I::text, count(*) FROM public.%I t WHERE t.%I = ANY(%s) GROUP BY 3',
        r.tbl || '.' || r.col, r.col, r.tbl, r.col, CASE WHEN r.is_uuid THEN '$1' ELSE '$2' END)
      WHEN 'driver_name' THEN format(
        'SELECT ''driver_name''::text, %L::text, lower(btrim(t.%I)), count(*) FROM public.%I t '
        'WHERE t.company_id = $6 AND lower(btrim(t.%I)) = ANY($3) %s GROUP BY 3',
        r.tbl || '.' || r.col, r.col, r.tbl, r.col,
        CASE WHEN r.tbl = 'income' THEN 'AND t.source IS DISTINCT FROM ''uber''' ELSE '' END)
      WHEN 'car_id' THEN format(
        'SELECT ''car''::text, %L::text, t.%I::text, count(*) FROM public.%I t WHERE t.%I = ANY($4) GROUP BY 3',
        r.tbl || '.' || r.col, r.col, r.tbl, r.col)
      ELSE format(
        'SELECT ''car_plate''::text, %L::text, app_private.partner_plate_key(t.%I), count(*) FROM public.%I t '
        'WHERE t.company_id = $6 AND app_private.partner_plate_key(t.%I) = ANY($5) GROUP BY 3',
        r.tbl || '.' || r.col, r.col, r.tbl, r.col)
    END;
  END LOOP;

  IF (cardinality(v_driver_ids) > 0 OR cardinality(v_car_ids) > 0) AND cardinality(v_parts) > 0 THEN
    v_sql := 'SELECT coalesce(jsonb_agg(jsonb_build_object(''entity'', x.e, ''src'', x.s, ''key'', x.k, ''n'', x.n)), ''[]''::jsonb) '
          || 'FROM (' || array_to_string(v_parts, ' UNION ALL ') || ') x(e, s, k, n)';
    EXECUTE v_sql INTO v_refs
      USING v_driver_ids, v_driver_texts, v_driver_names, v_car_ids, v_plate_keys, p_company;
  END IF;

  -- 27.11.2026: what the scan above cannot see. The drivers guard also counts
  -- every json document that names the driver (a saved Stundennachweis, a
  -- planning snapshot), so a driver in one is a blocker here too, listed in the
  -- preview and kept, instead of an exception raised half way through the undo.
  -- Same keys as the rows above: entity, source "table.column", the driver's id.
  IF cardinality(v_driver_ids) > 0 THEN
    v_refs := v_refs || coalesce((
      SELECT jsonb_agg(jsonb_build_object('entity', 'driver', 'src', x.tbl || '.' || x.col,
                                          'key', x.driver_id::text, 'n', x.n))
        FROM app_private.driver_reference_counts(v_driver_ids, p_company, ARRAY['json']) x
    ), '[]'::jsonb);
  END IF;

  RETURN QUERY
  WITH refs AS (
    SELECT j->>'entity' AS e, j->>'src' AS s, j->>'key' AS k, (j->>'n')::bigint AS n
      FROM jsonb_array_elements(v_refs) j
  )
  SELECT 'driver'::text, d.id, d.name,
         coalesce((SELECT jsonb_object_agg(g.s, g.n)
                     FROM (SELECT f.s, sum(f.n) AS n FROM refs f
                            WHERE (f.e = 'driver' AND f.k = d.id::text)
                               OR (f.e = 'driver_name' AND f.k = lower(btrim(d.name)))
                            GROUP BY f.s) g), '{}'::jsonb)
    FROM public.drivers d
   WHERE d.id = ANY(v_driver_ids)
  UNION ALL
  SELECT 'car'::text, c.id, c.kennzeichen,
         coalesce((SELECT jsonb_object_agg(g.s, g.n)
                     FROM (SELECT f.s, sum(f.n) AS n FROM refs f
                            WHERE (f.e = 'car' AND f.k = c.id::text)
                               OR (f.e = 'car_plate' AND f.k = app_private.partner_plate_key(c.kennzeichen))
                            GROUP BY f.s) g), '{}'::jsonb)
    FROM public.cars c
   WHERE c.id = ANY(v_car_ids);
END;
$$;


REVOKE ALL ON FUNCTION app_private.uber_undo_plan(uuid) FROM PUBLIC, anon, authenticated;

-- ─── 6. self-check ──────────────────────────────────────────────────────────
--
--  Fails the release. Each check is the rule rather than the instance.

DO $check$
DECLARE
  v_src   text;
  v_def   text;
  v_n     integer;
  v_role  text;
  v_fn    text;
  v_owner oid;
  r       record;
BEGIN
  -- 1. the trigger: BEFORE, row level, DELETE, enabled ALWAYS, on drivers.
  SELECT count(*) INTO v_n
    FROM pg_trigger g
   WHERE g.tgrelid = 'public.drivers'::regclass AND g.tgname = 'drivers_delete_guard'
     AND NOT g.tgisinternal
     AND (g.tgtype & 1) = 1 AND (g.tgtype & 2) = 2 AND (g.tgtype & 8) = 8
     AND (g.tgtype & 4) = 0 AND (g.tgtype & 16) = 0
     AND g.tgenabled = 'A';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'driver guard self-check 1: drivers_delete_guard is not a BEFORE DELETE row trigger enabled ALWAYS';
  END IF;

  -- 2. its function: SECURITY DEFINER, pinned search_path, the company branch
  --    and the stable refusal. SECURITY INVOKER would see only what the caller
  --    may read and would refuse nobody for the rows RLS hides.
  SELECT p.prosrc INTO v_src
    FROM pg_proc p WHERE p.oid = 'app_private.drivers_delete_guard()'::regprocedure AND p.prosecdef
     AND p.proconfig @> ARRAY['search_path=pg_catalog, public'];
  IF v_src IS NULL
     OR v_src NOT LIKE '%OLD.company_id IS NOT NULL%'
     OR v_src NOT LIKE '%NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id)%'
     OR v_src NOT LIKE '%driver_has_references%' OR v_src NOT LIKE '%23503%'
     OR v_src LIKE '%SQLERRM%' THEN
    RAISE EXCEPTION 'driver guard self-check 2: the trigger function lost SECURITY DEFINER, its search_path, the company-gone branch or the stable refusal';
  END IF;

  -- 3. the reader misses no foreign key to drivers, and none is composite.
  IF EXISTS (SELECT 1 FROM pg_constraint k
              WHERE k.contype = 'f' AND array_length(k.conkey, 1) > 1
                AND k.confrelid = 'public.drivers'::regclass) THEN
    RAISE EXCEPTION 'driver guard self-check 3: a composite foreign key to drivers exists; the reader cannot see it';
  END IF;
  FOR r IN
    SELECT c.relname AS t, a.attname AS col
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
     WHERE k.contype = 'f' AND array_length(k.conkey, 1) = 1
       AND k.confrelid = 'public.drivers'::regclass
  LOOP
    IF NOT EXISTS (SELECT 1 FROM app_private.driver_reference_columns() s
                    WHERE s.tbl = r.t AND s.col = r.col AND s.kind = 'fk') THEN
      RAISE EXCEPTION 'driver guard self-check 3: the reader misses the foreign key %.%', r.t, r.col;
    END IF;
  END LOOP;

  -- 4. every json column is searched or excluded with a reason, and no
  --    exclusion names a column that is gone (a stale line would excuse a
  --    different one later).
  FOR r IN
    SELECT c.relname AS t, a.attname AS col
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND c.relname <> 'drivers' AND a.atttypid IN ('json'::regtype, 'jsonb'::regtype)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM app_private.driver_reference_columns() s
                    WHERE s.tbl = r.t AND s.col = r.col AND s.kind = 'json')
       AND NOT EXISTS (SELECT 1 FROM app_private.driver_reference_json_exclusions() e
                        WHERE e.tbl = r.t AND e.col = r.col AND btrim(e.reason) <> '') THEN
      RAISE EXCEPTION 'driver guard self-check 4: the json column %.% is neither searched nor excluded', r.t, r.col;
    END IF;
  END LOOP;
  FOR r IN SELECT e.tbl, e.col FROM app_private.driver_reference_json_exclusions() e LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = to_regclass('public.' || quote_ident(r.tbl))
                      AND a.attname = r.col AND NOT a.attisdropped
                      AND a.atttypid IN ('json'::regtype, 'jsonb'::regtype)) THEN
      RAISE EXCEPTION 'driver guard self-check 4: the exclusion %.% names no json column', r.tbl, r.col;
    END IF;
  END LOOP;

  -- 5. nothing named like a driver id is missed: a uuid or text column named
  --    *driver_id (not external) is a key or an id column, and a company text
  --    column named *driver_name is a name column.
  FOR r IN
    SELECT c.relname AS t, a.attname AS col, a.atttypid
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND c.relname <> 'drivers'
       AND ((a.atttypid IN ('uuid'::regtype, 'text'::regtype)
             AND a.attname ~ '(^|_)driver_id$' AND a.attname !~ 'external')
         OR (a.atttypid = 'text'::regtype AND a.attname ~ '(^|_)driver_name$' AND a.attname !~ 'external'
             AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.oid
                          AND x.attname = 'company_id' AND NOT x.attisdropped)))
  LOOP
    IF NOT EXISTS (SELECT 1 FROM app_private.driver_reference_columns() s
                    WHERE s.tbl = r.t AND s.col = r.col) THEN
      RAISE EXCEPTION 'driver guard self-check 5: the reader misses %.%', r.t, r.col;
    END IF;
  END LOOP;

  -- 6. no API role reaches the helpers, and their owner can run them. The
  --    owner matters because they are SECURITY DEFINER: CREATE OR REPLACE keeps
  --    an existing owner, and one without USAGE on app_private fails at run time.
  FOREACH v_fn IN ARRAY ARRAY[
      'app_private.driver_reference_json_exclusions()', 'app_private.driver_reference_columns()',
      'app_private.driver_reference_counts(uuid[],uuid,text[])', 'app_private.driver_references(uuid,uuid)',
      'app_private.drivers_delete_guard()'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_function_privilege(v_role, v_fn::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION 'driver guard self-check 6: % can execute %', v_role, v_fn;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                WHERE p.oid = v_fn::regprocedure AND a.grantee = 0) THEN
      RAISE EXCEPTION 'driver guard self-check 6: PUBLIC can execute %', v_fn;
    END IF;
    SELECT p.proowner INTO v_owner FROM pg_proc p WHERE p.oid = v_fn::regprocedure;
    IF NOT has_schema_privilege(v_owner, 'app_private', 'USAGE') THEN
      RAISE EXCEPTION 'driver guard self-check 6: the owner of % has no USAGE on app_private', v_fn;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_schema_privilege(v_role, 'app_private', 'USAGE') THEN
      RAISE EXCEPTION 'driver guard self-check 6: % holds USAGE on app_private', v_role;
    END IF;
  END LOOP;

  -- 7. the check RPC: authenticated only, SECURITY DEFINER with a pinned
  --    search_path, the gate before the lookup, and the answers the screen reads.
  v_fn := 'public.driver_delete_check(uuid)';
  IF has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn::regprocedure, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn::regprocedure AND a.grantee = 0)
     OR NOT has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'driver guard self-check 7: driver_delete_check must be executable by authenticated only';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = v_fn::regprocedure AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public'];
  IF v_src IS NULL
     OR v_src NOT LIKE '%is_company_admin()%' OR v_src NOT LIKE '%get_active_company_id()%'
     OR position('not_authorized' IN v_src) > position('driver_not_found' IN v_src)
     OR position('is_company_admin()' IN v_src) > position('get_active_company_id()' IN v_src)
     OR v_src LIKE '%SQLERRM%' THEN
    RAISE EXCEPTION 'driver guard self-check 7: driver_delete_check lost SECURITY DEFINER, its search_path, or its gate order';
  END IF;

  -- 8. the policy: the administrator, in the shape 20260917130000 gave it.
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO v_def
    FROM pg_policy p WHERE p.polrelid = 'public.drivers'::regclass AND p.polname = 'drivers_delete' AND p.polcmd = 'd';
  IF v_def IS NULL OR v_def NOT LIKE '%is_company_admin()%' OR v_def LIKE '%current_role_permits%'
     OR v_def NOT LIKE '%get_active_company_id()%' OR v_def NOT LIKE '%platform_writes_company_data()%' THEN
    RAISE EXCEPTION 'driver guard self-check 8: drivers_delete is not the administrator gate (%)', v_def;
  END IF;
  IF (SELECT count(*) FROM pg_policy p WHERE p.polrelid = 'public.drivers'::regclass AND p.polcmd = 'd') <> 1 THEN
    RAISE EXCEPTION 'driver guard self-check 8: drivers carries more than one DELETE policy';
  END IF;

  -- 9. the undo's plan still has every rule it had, and asks the reader.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'app_private.uber_undo_plan(uuid)'::regprocedure;
  IF v_src NOT LIKE '%t.source IS DISTINCT FROM %uber%'
     OR v_src NOT LIKE '%l.created_by_import%' OR v_src NOT LIKE '%l.status = ''linked''%'
     OR v_src NOT LIKE '%app_private.uber_undo_reference_columns()%'
     OR v_src NOT LIKE '%driver_reference_counts(v_driver_ids, p_company, ARRAY[''json''])%'
     OR v_src ~* '(DELETE|UPDATE|INSERT)\s' THEN
    RAISE EXCEPTION 'driver guard self-check 9: the undo plan lost one of its rules, or does not ask the json reader, or writes';
  END IF;

  -- 10. every generated statement runs against the live schema: a statement
  --     the reader builds wrongly would otherwise first fail on somebody's delete.
  IF EXISTS (SELECT 1 FROM app_private.driver_reference_counts(
               ARRAY['00000000-0000-4000-8000-0000000000d1'::uuid], '00000000-0000-4000-8000-0000000000c1'::uuid)) THEN
    RAISE EXCEPTION 'driver guard self-check 10: an invented driver has references';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.driver_reference_counts(
               ARRAY['00000000-0000-4000-8000-0000000000d1'::uuid], NULL)) THEN
    RAISE EXCEPTION 'driver guard self-check 10: an invented driver has references with no company scope';
  END IF;

  RAISE NOTICE 'driver delete guard: self-checks passed';
END
$check$;
