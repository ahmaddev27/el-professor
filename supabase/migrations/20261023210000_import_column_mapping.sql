/*
  # The Fahrtenbuch import remembers its column mapping, per company and per shape

  Step 1 of the import wizard (`src/components/FahrtenbuchImportModal.tsx`) has a
  <select> per system field over the uploaded file's headers, pre-filled by
  `AUTO_MATCH` and overridable by the operator. The automatic match is good for
  the Uber export and nothing else, and the operator's override lived in React
  state alone: `reset()` cleared it, so a company whose export spells its columns
  differently redid the same eleven choices every month. This file is the memory
  of that choice. One table, one guard, four policies; no RPC, no screen, and
  nothing in the parsing, the duplicate refusal or the import's write path moves.

  ── WHAT KEYS A MAPPING, AND WHY NOT THE COMPANY ALONE ──────────────────────

  `(company_id, source_shape_key)`, where the shape key is the SHA-256 of the
  file's headers put through the importer's own `normalise()` (lowercase,
  [a-z0-9] only), sorted and newline-joined. Three properties follow, and each
  one is the reason for a part of the design:

    · **a company may receive more than one export format, and one already
      does.** Measured read-only on staging, 23.10.2026, over the twelve imports
      of `fahrtenbuch_imports.source_columns_json`:

        bc7e0e4d…  8 imports   1 shape    18 columns every month
        ef01545b…  2 imports   2 shapes   11 columns and 18 columns
        7ecf378f…  1 import    1 shape    18 columns

      The 11-column file's headers are a strict SUBSET of the 18-column one's,
      with every shared name identical. Keyed on the company alone, those two
      would have overwritten each other's mapping on every import — which is
      the cost this feature removes, reintroduced one fortnight later.

    · **re-importing the same shape is idempotent**, because the key is derived
      from the file and from nothing else: the unique index below holds one row
      per company and shape, and the wizard upserts onto it. Eight imports of
      one shape leave one row, re-stamped.

    · **the key survives the drift that is not a format change.** A reordered
      sheet, a changed case, a stray leading space or a hyphen that became an en
      dash all normalise to the same key. A column GAINED or LOST is a different
      shape, with a memory of its own — which is exactly how the DEMO company's
      two files stay apart.

  What the shape key deliberately is NOT is a safety mechanism. It says "this
  looks like the same format"; whether every remembered column is really still
  there is asked of the file itself, every time, below.

  ── WHAT IS STORED ──────────────────────────────────────────────────────────

  `field_map`  — `{ system field: the header that carries it }`, the eleven
                 fields of `ColMap` and no others (a CHECK, not a comment).
  `source_headers` — the file's headers as they were read, in order. This is
                 what makes the memory auditable: "the mapping was built from
                 these columns" is a statement a later import can be compared
                 against, and the guard refuses a `field_map` naming a header
                 this list does not hold.
  `created_at`/`created_by`, `updated_at`/`updated_by` — when, and by whom. The
                 guard stamps all four; nothing a client sends is kept.

  The status column and the order-transmission column are NOT stored. They are
  auto-detected (`STATUS_COL_CANDIDATES`, `findOrderTransmissionColumn`) and the
  wizard offers no control for either, so there is no operator override to
  remember. A mapping is the eleven fields a person can actually choose.

  ── WHAT IS NEVER STORED ────────────────────────────────────────────────────

  No ride, no address, no fare, no personal data — header names and system field
  names only. There is no column here that could hold a cell value, and
  self-check 7 asserts the column list is EXACTLY the nine below, so a later
  migration adding `sample_value`, `driver_name` or `first_row` fails the
  release rather than quietly turning an operator convenience into a second copy
  of the ride log. A header is a column's name, not its contents; it is still
  text from a customer's file, so its length is bounded (CHECK) and every
  element of it is bounded and non-blank (guard).

  ── THE ONE PROPERTY THE FEATURE EXISTS FOR ─────────────────────────────────

  A stored mapping that silently no longer matches the file is worse than none.
  The database's half of that is the guard's rule that **every value of
  `field_map` is an element of `source_headers`**, so a row can never claim a
  column it does not also list. The browser's half is
  `applyRememberedMapping()` (`src/utils/importColumnMapping.ts`), which checks
  every remembered header against the headers of the file actually in front of
  the operator and leaves a field EMPTY — never silently on the automatic match
  — when it is gone, naming it in the wizard. For the four required fields the
  wizard's own `canGoNext` then blocks until a person chooses.
  `tests/rls/import-column-mapping.sql` section 6 is the database half and
  `src/utils/importColumnMapping.test.ts` the browser half; the measured DEMO
  case above (18 columns remembered, an 11-column file imported) is the test.

  ── WHY THE CROSS-COLUMN RULE IS IN THE GUARD AND NOT IN A CHECK ────────────

  "Every value of `field_map` is in `source_headers`" needs to walk a jsonb
  object, which no scalar CHECK expression can do. The two ways to put it in a
  CHECK are both worse:

    · a function in `app_private` — a CHECK is evaluated as the WRITING role,
      `authenticated` holds no USAGE there, so the owner would insert and every
      client would get 42501 (PR #117's defect, one layer down);
    · a function in `public` — restorable only if pg_dump happens to emit the
      function before the table, which it does not guarantee for a CHECK, and
      this project restores production's `pg_dump` to rehearse a release.

  So the rule lives in the one SECURITY DEFINER trigger every writer passes, and
  self-check 6 reads that trigger's body out of the catalogue
  (`app_private.function_code`) and fails a release where the rule is gone. What
  a CHECK can say scalar-ly it does say: the key's hex shape, the header list's
  size, that `field_map` is an object, that it holds no key outside the eleven
  (`- ARRAY[…] = '{}'`), and that it holds all four required ones (`?&`).

  ── TENANCY AND THE PAGE ────────────────────────────────────────────────────

  20260917130000's shape, unchanged: four policies, SELECT the active-company
  helper or the read seam, every write the same predicate as USING and as WITH
  CHECK plus the table's page gate, and both context triggers derived from the
  policies naming `get_active_company_id()` rather than from who writes the
  table today.

  The page is **`documents`**, and it is the Fahrtenbuch's own: slice C
  (20260923130000) gave `fahrtenbuch_imports`, `fahrtenbuch_trips` and
  `fahrtenbuch_assignment_audit` that key, with the reason "the Fahrtenbuch is a
  statutory document". This row is written from the same wizard, in the same
  step, by the same person; any other page would let someone who may not file an
  import decide which column an import's dates come out of, which is a strictly
  larger right than the one slice C granted. A viewer therefore remembers
  nothing and an editor does not either, because neither holds `can_edit` on
  Dokumente in the seeded roles — and a company that wants its editor to run
  imports ticks *Bearbeiten* on that page, exactly as it already must to file
  the import itself.

  `imported_by = auth.uid()` has no counterpart here on purpose: that clause
  exists because an import is the artefact the whole payroll chain hangs off and
  the record of who filed it must be the caller. A column mapping is a
  convenience with no downstream consumer, the actor is recorded in
  `created_by`/`updated_by` by the guard, and a wrong actor on it changes no
  figure anywhere.

  SCHEMA_EPOCH is not bumped: this file only adds, so the previous release runs
  against this schema unchanged — it simply remembers nothing.
*/

-- ─── 1. the table ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.import_column_mappings (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- SHA-256, lowercase hex, of the file's headers normalised, sorted and
  -- newline-joined (src/utils/importColumnMapping.ts: sourceShapeMaterial).
  source_shape_key text        NOT NULL,
  -- The headers the mapping was built from, as they were read, in order.
  source_headers   text[]      NOT NULL,
  -- { system field: the header that carries it }. The eleven fields of ColMap.
  field_map        jsonb       NOT NULL,
  created_by       uuid        NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- One mapping per company and shape. This is the key, and it is what makes a
  -- second import of the same shape an upsert rather than a second row.
  CONSTRAINT import_column_mappings_company_shape_key
    UNIQUE (company_id, source_shape_key),

  -- A SHA-256 in lowercase hex and nothing else, so a client cannot invent a
  -- key out of a column name and make the lookup depend on text it chose.
  CONSTRAINT import_column_mappings_shape_key_sha256
    CHECK (source_shape_key ~ '^[0-9a-f]{64}$'),

  -- A column name is text from a customer's file. One dimension, between one
  -- and 200 of them, 8000 characters joined — which also bounds each of them,
  -- while the guard bounds them one by one at 200.
  CONSTRAINT import_column_mappings_headers_bounded
    CHECK (array_ndims(source_headers) = 1
           AND array_length(source_headers, 1) BETWEEN 1 AND 200
           AND char_length(array_to_string(source_headers, E'\n')) <= 8000),

  CONSTRAINT import_column_mappings_field_map_object
    CHECK (jsonb_typeof(field_map) = 'object'),

  -- No key outside the eleven fields of ColMap. `jsonb - text[]` deletes those
  -- keys, so an empty result means there were no others; a scalar expression,
  -- which is the only kind a CHECK may hold. src/utils/importColumnMapping.test.ts
  -- reads this list out of the newest migration that defines it and fails when
  -- MAPPING_FIELDS and it differ.
  CONSTRAINT import_column_mappings_field_map_known_keys
    CHECK ((field_map - ARRAY[
              'trip_date', 'start_time', 'end_time', 'driver_name',
              'car_identifier', 'price_amount', 'tip_amount',
              'payment_method', 'route_start', 'route_end', 'description'
            ]::text[]) = '{}'::jsonb),

  -- And all four the wizard requires: a mapping that could never carry an
  -- import is not a mapping worth proposing next month.
  CONSTRAINT import_column_mappings_field_map_required_keys
    CHECK (field_map ?& ARRAY['trip_date', 'start_time', 'end_time', 'driver_name'])
);

COMMENT ON TABLE public.import_column_mappings IS
  'One remembered Fahrtenbuch import column mapping per company and per header '
  'shape. Header names and system field names only: no ride, no address, no '
  'fare, no personal data (20261023210000).';

COMMENT ON COLUMN public.import_column_mappings.source_shape_key IS
  'SHA-256 of the file''s headers normalised ([a-z0-9] only), sorted and '
  'newline-joined: order- and spelling-insensitive, so a reordered or '
  'respelled sheet keeps the memory and a gained or lost column is a new shape.';

COMMENT ON COLUMN public.import_column_mappings.source_headers IS
  'The headers the mapping was built from, as read, in order. Every value of '
  'field_map must be one of these (the guard), and the wizard checks each one '
  'against the file in front of the operator before proposing it.';

CREATE INDEX IF NOT EXISTS import_column_mappings_company_recent_idx
  ON public.import_column_mappings (company_id, updated_at DESC);

-- ─── 2. the guard ───────────────────────────────────────────────────────────

/*
  The actor and the time are the database's; the subject of the row is fixed
  once it exists; and the per-value rules a CHECK cannot express live here.

  Pinning company_id and source_shape_key is the reason pin_billing_company_id
  exists on the two billing tables: a policy's WITH CHECK sees only the new row
  and cannot say what it already was, so without the pin an UPDATE could point
  a mapping at another shape and the next import of THAT shape would open with
  columns nobody chose for it. Correcting a shape is a new row.
*/
CREATE OR REPLACE FUNCTION app_private.import_column_mapping_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_uid    uuid := auth.uid();
  v_header text;
  v_field  text;
  v_value  jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'Eine gespeicherte Spaltenzuordnung kann nicht einem anderen Unternehmen zugeordnet werden.'
        USING ERRCODE = 'P0001', HINT = 'import_mapping_company_pinned';
    END IF;
    IF NEW.source_shape_key IS DISTINCT FROM OLD.source_shape_key THEN
      RAISE EXCEPTION 'Eine gespeicherte Spaltenzuordnung kann nicht auf eine andere Spaltenstruktur übertragen werden.'
        USING ERRCODE = 'P0001', HINT = 'import_mapping_shape_pinned';
    END IF;
  END IF;

  -- Every header is a usable column name. char_length and not octet_length: the
  -- bound is on characters, and a German header is not ASCII.
  FOREACH v_header IN ARRAY NEW.source_headers LOOP
    IF v_header IS NULL OR btrim(v_header, E' \t\r\n') = '' THEN
      RAISE EXCEPTION 'Eine Spaltenbezeichnung der Datei ist leer.'
        USING ERRCODE = 'P0001', HINT = 'import_mapping_header_blank';
    END IF;
    IF char_length(v_header) > 200 THEN
      RAISE EXCEPTION 'Eine Spaltenbezeichnung der Datei ist länger als 200 Zeichen.'
        USING ERRCODE = 'P0001', HINT = 'import_mapping_header_too_long';
    END IF;
  END LOOP;

  -- A sheet's headers are distinct (XLSX.utils.sheet_to_json builds them from
  -- object keys, which cannot repeat). A duplicate here means the row did not
  -- come from a sheet, and a mapping whose header appears twice cannot be
  -- resolved against the file.
  IF array_length(NEW.source_headers, 1)
       <> (SELECT count(DISTINCT h) FROM unnest(NEW.source_headers) h) THEN
    RAISE EXCEPTION 'Die Spaltenbezeichnungen der Datei sind nicht eindeutig.'
      USING ERRCODE = 'P0001', HINT = 'import_mapping_headers_duplicated';
  END IF;

  -- The rule the whole feature rests on: a stored mapping can never name a
  -- column the row itself does not list. Without it a mapping could claim any
  -- text at all, and the wizard's check against the file would be comparing
  -- against a list that never described a real sheet.
  FOR v_field, v_value IN SELECT * FROM jsonb_each(NEW.field_map) LOOP
    IF jsonb_typeof(v_value) <> 'string' THEN
      RAISE EXCEPTION 'Die Spaltenzuordnung für % ist keine Spaltenbezeichnung.', v_field
        USING ERRCODE = 'P0001', HINT = 'import_mapping_value_invalid';
    END IF;
    v_header := v_value #>> '{}';
    IF btrim(v_header, E' \t\r\n') = '' OR char_length(v_header) > 200 THEN
      RAISE EXCEPTION 'Die Spaltenzuordnung für % ist leer oder zu lang.', v_field
        USING ERRCODE = 'P0001', HINT = 'import_mapping_value_invalid';
    END IF;
    IF NOT (v_header = ANY (NEW.source_headers)) THEN
      RAISE EXCEPTION 'Die Spaltenzuordnung für % nennt die Spalte „%“, die die Datei nicht enthält.', v_field, v_header
        USING ERRCODE = 'P0001', HINT = 'import_mapping_value_not_a_header';
    END IF;
  END LOOP;

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := v_uid;
    NEW.created_at := now();
    NEW.updated_by := v_uid;
    NEW.updated_at := now();
  ELSE
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.updated_by := v_uid;
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION app_private.import_column_mapping_guard() IS
  'Stamps the actor and the time on a remembered import column mapping, pins '
  'its company and shape once it exists, bounds every column name, and refuses '
  'a field_map value that is not one of the row''s own source_headers — the '
  'rule a CHECK cannot express, because a CHECK runs as the writing role '
  '(20261023210000).';

DROP TRIGGER IF EXISTS import_column_mapping_guard ON public.import_column_mappings;
CREATE TRIGGER import_column_mapping_guard
  BEFORE INSERT OR UPDATE ON public.import_column_mappings
  FOR EACH ROW EXECUTE FUNCTION app_private.import_column_mapping_guard();

-- ─── 3. the tenant shape ────────────────────────────────────────────────────

ALTER TABLE public.import_column_mappings ENABLE ROW LEVEL SECURITY;

DO $mig$
DECLARE
  v_tbl    constant text := 'import_column_mappings';
  p        record;
  v_tenant constant text := 'company_id = (SELECT public.get_active_company_id())';
  v_reads  constant text := '(SELECT public.platform_reads_company_data())';
  v_writes constant text := '(SELECT public.platform_writes_company_data())';
  -- The Fahrtenbuch's own page (20260923130000, slice C). SELECT asks no role.
  v_gate   constant text := '(SELECT public.current_role_permits(''documents'', true))';
  v_where  text;
BEGIN
  v_where := v_tenant || ' AND ' || v_gate;

  FOR p IN
    SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, v_tbl);
  END LOOP;

  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s OR %s)',
    v_tbl || '_select', v_tbl, v_tenant, v_reads);
  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK ((%s) OR %s)',
    v_tbl || '_insert', v_tbl, v_where, v_writes);
  -- The same predicate as USING and as WITH CHECK: writing it twice is what
  -- refuses a move between companies.
  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated '
    'USING ((%s) OR %s) WITH CHECK ((%s) OR %s)',
    v_tbl || '_update', v_tbl, v_where, v_writes, v_where, v_writes);
  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING ((%s) OR %s)',
    v_tbl || '_delete', v_tbl, v_where, v_writes);

  -- 3.4a: a view context writes nothing. 3.4c: a support session's rows are
  -- recorded. Derived from the policies naming get_active_company_id(), which
  -- is the rule tests/rls/platform-contexts.sql section 14 and
  -- tests/rls/support-write-audit.sql section 1 state, and not from who writes
  -- this table today.
  EXECUTE format('DROP TRIGGER IF EXISTS refuse_read_only_context_write ON public.%I', v_tbl);
  EXECUTE format(
    'CREATE TRIGGER refuse_read_only_context_write '
    'BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
    'FOR EACH STATEMENT EXECUTE FUNCTION app_private.refuse_read_only_context_write()', v_tbl);

  EXECUTE format('DROP TRIGGER IF EXISTS record_support_write ON public.%I', v_tbl);
  EXECUTE format(
    'CREATE TRIGGER record_support_write '
    'AFTER INSERT OR UPDATE OR DELETE ON public.%I '
    'FOR EACH ROW '
    'WHEN (current_setting(%L, true) <> %L) '
    'EXECUTE FUNCTION app_private.record_support_write()',
    v_tbl, 'app_private.support_write_context', '');
END
$mig$;

-- ─── 4. ownership and privileges ────────────────────────────────────────────

-- CREATE OR REPLACE keeps whatever owner a function had, so the owner is stated.
ALTER FUNCTION app_private.import_column_mapping_guard() OWNER TO CURRENT_USER;

-- Fired by a trigger, which does not check EXECUTE; the REVOKE is the second
-- wall behind the missing USAGE on app_private. PUBLIC as well as the three API
-- roles: EXECUTE to PUBLIC is a built-in default for every new function and
-- cannot be revoked per schema.
REVOKE ALL ON FUNCTION app_private.import_column_mapping_guard()
  FROM PUBLIC, anon, authenticated, service_role;

-- The same default grants every new table to anon, authenticated and
-- service_role. anon never reads this, and no edge function does either.
REVOKE ALL ON TABLE public.import_column_mappings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.import_column_mappings TO authenticated;

-- ─── 5. self-check ──────────────────────────────────────────────────────────
--
-- What a release can be told from the catalogue and from the guard's body with
-- its comments removed (app_private.function_code, which raises for a signature
-- that does not resolve, so a renamed function cannot make a `NOT LIKE` below
-- pass on NULL). The behaviour itself — every refusal, the upsert, the contexts,
-- the audit rows — is tests/rls/import-column-mapping.sql.

DO $selfcheck$
DECLARE
  c_tbl   CONSTANT text := 'import_column_mappings';
  c_guard CONSTANT text := 'app_private.import_column_mapping_guard()';
  -- The eleven fields of ColMap, and the ten columns of the table. Both lists
  -- are asserted to be EXACT, not merely present.
  c_fields  CONSTANT text[] := ARRAY['trip_date', 'start_time', 'end_time', 'driver_name',
                                     'car_identifier', 'price_amount', 'tip_amount',
                                     'payment_method', 'route_start', 'route_end', 'description'];
  c_columns CONSTANT text[] := ARRAY['id', 'company_id', 'source_shape_key', 'source_headers',
                                     'field_map', 'created_by', 'created_at',
                                     'updated_by', 'updated_at'];
  v_src   text;
  v_def   text;
  v_list  text;
  v_names text[];
  v_wrong text;
  v_count int;
  v_one   text;
BEGIN
  -- 1. The table exists with row level security on.
  IF to_regclass(format('public.%I', c_tbl)) IS NULL THEN
    RAISE EXCEPTION 'import column mapping self-check 1: public.% is missing', c_tbl;
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', c_tbl)::regclass) THEN
    RAISE EXCEPTION 'import column mapping self-check 1: % has row level security off', c_tbl;
  END IF;

  -- 2. Exactly the four policies of 20260917130000's shape: each asking the
  --    active-company helper, each write asking the Dokumente page, SELECT
  --    asking no role at all, and the UPDATE stating one predicate as USING and
  --    as WITH CHECK (which is what refuses a move to another company).
  SELECT string_agg(format('%s (%s)', p.policyname, p.cmd), ', ' ORDER BY p.policyname) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = c_tbl
     AND p.policyname NOT IN (c_tbl || '_select', c_tbl || '_insert',
                              c_tbl || '_update', c_tbl || '_delete');
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'import column mapping self-check 2: % carries policies outside the four-policy shape: %', c_tbl, v_wrong;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c_tbl;
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'import column mapping self-check 2: % carries % of its 4 policies', c_tbl, v_count;
  END IF;

  SELECT string_agg(p.policyname, ', ' ORDER BY p.policyname) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = c_tbl
     AND coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') NOT LIKE '%get_active_company_id%';
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'import column mapping self-check 2: policy/policies do not ask get_active_company_id(): %', v_wrong;
  END IF;

  SELECT string_agg(p.policyname, ', ' ORDER BY p.policyname) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = c_tbl
     AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')
            ~ '(is_user_super_admin|user_profiles)');
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'import column mapping self-check 2: policy/policies read user_profiles or is_user_super_admin(): %', v_wrong;
  END IF;

  SELECT string_agg(format('%s (%s)', p.policyname, p.cmd), ', ' ORDER BY p.policyname) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = c_tbl
     AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE')
     AND coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')
           NOT LIKE '%current_role_permits(''documents''%';
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'import column mapping self-check 2: write policy/policies do not ask the documents page: %', v_wrong;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = c_tbl AND p.cmd = 'SELECT'
       AND coalesce(p.qual, '') LIKE '%current_role_permits%'
  ) THEN
    RAISE EXCEPTION 'import column mapping self-check 2: the SELECT policy is role-gated; 3.3''s shape has no role term there';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = c_tbl AND p.cmd = 'UPDATE'
       AND p.qual IS NOT NULL AND p.with_check IS NOT NULL
       AND p.with_check LIKE '%get_active_company_id%'
       AND p.with_check LIKE '%current_role_permits(''documents''%'
  ) THEN
    RAISE EXCEPTION 'import column mapping self-check 2: the UPDATE policy does not repeat its predicate as WITH CHECK — a move between companies would be allowed';
  END IF;

  -- 3. Both context triggers, derived from the policies naming
  --    get_active_company_id() and not from who writes the table today.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger g
     WHERE g.tgrelid = format('public.%I', c_tbl)::regclass
       AND NOT g.tgisinternal
       AND g.tgname = 'refuse_read_only_context_write'
       AND g.tgfoid = 'app_private.refuse_read_only_context_write()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'import column mapping self-check 3: % has no refuse_read_only_context_write trigger — a view context would write it', c_tbl;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger g
     WHERE g.tgrelid = format('public.%I', c_tbl)::regclass
       AND NOT g.tgisinternal
       AND g.tgname = 'record_support_write'
       AND g.tgfoid = 'app_private.record_support_write()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'import column mapping self-check 3: % has no record_support_write trigger — a support session''s rows would go unrecorded', c_tbl;
  END IF;

  -- 4. The key: one mapping per company and shape. Without it the second import
  --    of a shape writes a second row and the lookup becomes "whichever".
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = format('public.%I', c_tbl)::regclass
       AND conname  = 'import_column_mappings_company_shape_key'
       AND contype  = 'u'
       AND array_length(conkey, 1) = 2
  ) THEN
    RAISE EXCEPTION 'import column mapping self-check 4: the unique key on (company_id, source_shape_key) is missing — a shape would hold more than one mapping';
  END IF;

  -- 5. The five CHECK constraints, and the field list inside two of them read
  --    exactly rather than merely searched for.
  FOREACH v_one IN ARRAY ARRAY['import_column_mappings_shape_key_sha256',
                               'import_column_mappings_headers_bounded',
                               'import_column_mappings_field_map_object',
                               'import_column_mappings_field_map_known_keys',
                               'import_column_mappings_field_map_required_keys'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = format('public.%I', c_tbl)::regclass
         AND conname = v_one AND contype = 'c'
    ) THEN
      RAISE EXCEPTION 'import column mapping self-check 5: the % check constraint is missing', v_one;
    END IF;
  END LOOP;

  /*
    The two key lists are read out EXACTLY and compared as sorted sets, not
    searched for name by name: a `strpos` per name passes on a TWELFTH name
    nobody listed, which is the half of this check that matters.

    Both forms PostgreSQL may have stored are read, and that is measured rather
    than reasoned about. The first version of this check assumed 17.6 folds
    `ARRAY['a','b']::text[]` into the array literal `'{a,b}'::text[]`; it does
    not — `pg_get_constraintdef` on this very table returns
    `ARRAY['trip_date'::text, 'start_time'::text, …]`, element by element. The
    assumption cost one VPS kit round trip, and it was only visible because the
    check raises on a list it cannot read instead of comparing against NULL,
    which every `IS DISTINCT FROM` would have reported as a pass.
  */
  FOREACH v_one IN ARRAY ARRAY['import_column_mappings_field_map_known_keys',
                               'import_column_mappings_field_map_required_keys'] LOOP
    SELECT pg_get_constraintdef(oid) INTO v_def
      FROM pg_constraint
     WHERE conrelid = format('public.%I', c_tbl)::regclass AND conname = v_one;

    -- A folded array literal, if a later PostgreSQL ever folds one.
    v_list := substring(v_def FROM '''\{([a-z_,]*)\}''::text\[\]');
    IF v_list IS NOT NULL THEN
      v_names := string_to_array(v_list, ',');
    ELSE
      -- 17.6's form: one quoted, cast element per name. `'{}'::jsonb` in the
      -- same expression does not match, because `::text` is required.
      v_names := ARRAY(SELECT m[1] FROM regexp_matches(v_def, '''([a-z_]+)''::text', 'g') m);
    END IF;
    IF v_names IS NULL OR array_length(v_names, 1) IS NULL THEN
      RAISE EXCEPTION 'import column mapping self-check 5: the key list of % cannot be read out of %', v_one, v_def;
    END IF;

    IF v_one = 'import_column_mappings_field_map_known_keys' THEN
      IF ARRAY(SELECT unnest(v_names) ORDER BY 1)
           IS DISTINCT FROM ARRAY(SELECT unnest(c_fields) ORDER BY 1) THEN
        RAISE EXCEPTION 'import column mapping self-check 5: the known-key list is not the eleven fields of ColMap: %', v_names;
      END IF;
    ELSE
      IF ARRAY(SELECT unnest(v_names) ORDER BY 1)
           IS DISTINCT FROM ARRAY['driver_name', 'end_time', 'start_time', 'trip_date']::text[] THEN
        RAISE EXCEPTION 'import column mapping self-check 5: the required-key list is not the four the wizard requires: %', v_names;
      END IF;
    END IF;
  END LOOP;

  -- No CHECK constraint on this table names app_private or public: a CHECK is
  -- evaluated as the writing role, so one naming app_private would let the owner
  -- insert and give every client 42501, and one naming a public function is a
  -- pg_dump restore-ordering hazard (see the header).
  SELECT string_agg(conname, ', ' ORDER BY conname) INTO v_wrong
    FROM pg_constraint
   WHERE conrelid = format('public.%I', c_tbl)::regclass
     AND contype = 'c'
     AND (pg_get_constraintdef(oid) LIKE '%app_private.%' OR pg_get_constraintdef(oid) LIKE '%public.%');
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'import column mapping self-check 5: check constraint(s) call out of pg_catalog, which a CHECK evaluated as the writing role cannot rely on: %', v_wrong;
  END IF;

  -- 6. The guard is SECURITY DEFINER plpgsql with a pinned search_path, and its
  --    body still carries the rule the whole feature rests on.
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = c_guard::regprocedure) THEN
    RAISE EXCEPTION 'import column mapping self-check 6: % is not SECURITY DEFINER; as an invoker it could not read app_private and every client would be refused', c_guard;
  END IF;
  IF (SELECT l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.oid = c_guard::regprocedure) <> 'plpgsql' THEN
    RAISE EXCEPTION 'import column mapping self-check 6: % is not LANGUAGE plpgsql', c_guard;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = c_guard::regprocedure
       AND p.proconfig IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search\_path=%')
  ) THEN
    RAISE EXCEPTION 'import column mapping self-check 6: % has no pinned search_path', c_guard;
  END IF;

  v_src := app_private.function_code(c_guard);

  -- The derived property: every field_map value is one of the row's own
  -- source_headers. A CHECK cannot walk a jsonb object, so this is the only
  -- place it can live, and losing it would let a row claim a column that never
  -- existed — making the wizard's comparison against the file meaningless.
  IF v_src NOT LIKE '%import_mapping_value_not_a_header%' THEN
    RAISE EXCEPTION 'import column mapping self-check 6: the guard no longer refuses a field_map value that is not one of source_headers — a stored mapping could name a column the file never had';
  END IF;
  IF v_src NOT LIKE '%= ANY (NEW.source_headers)%' THEN
    RAISE EXCEPTION 'import column mapping self-check 6: the guard no longer compares a field_map value against NEW.source_headers';
  END IF;
  FOREACH v_one IN ARRAY ARRAY['import_mapping_company_pinned', 'import_mapping_shape_pinned',
                               'import_mapping_header_blank', 'import_mapping_header_too_long',
                               'import_mapping_headers_duplicated', 'import_mapping_value_invalid'] LOOP
    IF v_src NOT LIKE '%' || v_one || '%' THEN
      RAISE EXCEPTION 'import column mapping self-check 6: the guard no longer raises %', v_one;
    END IF;
  END LOOP;
  -- The actor is the database's, never the client's.
  IF v_src NOT LIKE '%NEW.created_by := %' OR v_src NOT LIKE '%NEW.updated_by := v_uid%' THEN
    RAISE EXCEPTION 'import column mapping self-check 6: the guard no longer stamps the actor — a client could claim another account wrote the mapping';
  END IF;

  -- 7. THE COLUMN LIST IS EXACTLY THESE NINE. Header names and system field
  --    names only: no ride, no address, no fare, no personal data. An added
  --    column fails the release, because "a convenience that quietly became a
  --    second copy of the ride log" is not something a reviewer would notice.
  SELECT string_agg(a.attname, ', ' ORDER BY a.attname) INTO v_wrong
    FROM pg_attribute a
   WHERE a.attrelid = format('public.%I', c_tbl)::regclass
     AND a.attnum > 0 AND NOT a.attisdropped
     AND NOT (a.attname = ANY (c_columns));
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'import column mapping self-check 7: % carries column(s) outside the stated set: %', c_tbl, v_wrong;
  END IF;

  SELECT string_agg(c, ', ' ORDER BY c) INTO v_wrong
    FROM unnest(c_columns) c
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = format('public.%I', c_tbl)::regclass
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = c);
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'import column mapping self-check 7: % is missing column(s): %', c_tbl, v_wrong;
  END IF;

  -- 8. anon and the service role hold nothing; authenticated holds the four
  --    commands and nothing more.
  FOREACH v_one IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_table_privilege(v_one, format('public.%I', c_tbl),
                           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'import column mapping self-check 8: % holds a privilege on %', v_one, c_tbl;
    END IF;
  END LOOP;
  IF NOT (has_table_privilege('authenticated', format('public.%I', c_tbl), 'SELECT')
          AND has_table_privilege('authenticated', format('public.%I', c_tbl), 'INSERT')
          AND has_table_privilege('authenticated', format('public.%I', c_tbl), 'UPDATE')
          AND has_table_privilege('authenticated', format('public.%I', c_tbl), 'DELETE')) THEN
    RAISE EXCEPTION 'import column mapping self-check 8: authenticated cannot read and write %', c_tbl;
  END IF;
  IF has_table_privilege('authenticated', format('public.%I', c_tbl), 'TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION 'import column mapping self-check 8: authenticated holds more than the four commands on %', c_tbl;
  END IF;
  FOREACH v_one IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_one, c_guard, 'EXECUTE') THEN
      RAISE EXCEPTION 'import column mapping self-check 8: % may execute %', v_one, c_guard;
    END IF;
  END LOOP;

  RAISE NOTICE 'import column mapping self-check: all 8 groups passed';
END
$selfcheck$;
