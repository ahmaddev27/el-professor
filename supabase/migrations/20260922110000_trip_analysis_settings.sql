/*
  # Fahrtenanalyse: the analysis settings and the monthly budget per driver
    (Fahrtenbuch plan, slice C)

  ## What this is for

  The Fahrtenanalyse screen (slice D) explains a month of imported trips: the
  blocks a driver's rides form, the overlaps, the gaps too short to drive from
  one ride to the next, and how the month's activity compares with the hours a
  driver's pay allows. It **only shows and explains**. Nothing here — and
  nothing the screen does — reassigns a trip or changes its time, price or
  driver; `fahrtenbuch_trips` is not touched by this file.

  Two inputs of that explanation are the owner's to decide, and neither existed:

      public.trip_analysis_settings   one row per company: how long a pause
                                      may be before a block ends
                                      (block_gap_minutes), and how much time a
                                      driver needs between two rides
                                      (travel_margin_minutes)

      public.driver_month_budget      one row per company, driver, year and
                                      month: the hours the owner holds back
                                      for the driver (reserved_hours), and the
                                      driver's pay figures as they stood when
                                      the owner confirmed the month

  ## "Not set" is a value

  Every input is nullable, and NULL means *not set*, never a default. The plan
  lists all three as open decisions of the owner (the block threshold, the
  travel margin, the reserve per driver), so the database does not make them:

    - block_gap_minutes / travel_margin_minutes NULL — the screen says so and
      asks. It uses 30 minutes only when the owner chooses the clearly labelled
      test value for one analysis, and it does not store that choice.
    - reserved_hours NULL — "nicht festgelegt"; 0 is a stored answer ("no
      reserve") and is allowed explicitly.

  ## A confirmed month is not recomputed silently

  The budget of a month is derived from the driver's `planning_min_salary`,
  `planning_max_salary` and `planning_hourly_rate` (hours = salary ÷ rate). Those
  live on `drivers` and change whenever somebody edits the driver, which would
  quietly move a month the owner already looked at and accepted. So the owner
  *confirms* a month, and the three figures are copied onto the row at that
  moment, with who confirmed it and when.

  The copy is taken by the database, never by the browser. A trigger
  (`app_private.driver_month_budget_guard`) runs before every INSERT and UPDATE:

    1. the driver must belong to the row's company, and a row stays with the
       driver, company, year and month it was created for (a budget carries a
       snapshot of one driver's pay; re-pointing it would put that snapshot on
       someone else)
    2. writing `confirmed_at` — any new value — is the request to confirm. The
       trigger then copies the three figures from `drivers` as they are now,
       and stamps `confirmed_at = now()` and `confirmed_by = auth.uid()`;
       whatever the client sent for them is discarded
    3. without that request the snapshot and the confirmation stay exactly as
       they were, whatever the client sent
    4. confirming a month that was already confirmed is a **recompute**, and
       it is recorded: the previous snapshot, who confirmed it and when, go
       into `recompute_log` with the time and the account of the recompute. A
       change of `reserved_hours` on a confirmed month is recorded the same
       way. `recompute_log` is written only by the trigger; a client value is
       ignored
    5. a confirmation cannot be taken back by writing NULL; deleting the row
       is the explicit way to start the month over

  So the screen shows "Eingaben geändert" when the driver's current figures
  differ from the snapshot, and the owner decides whether to recompute. There is
  no path, direct or otherwise, on which the snapshot moves without that.

  ## Access — the business-table shape of 20260917130000, exactly

    SELECT   company_id = (SELECT get_active_company_id())
             OR (SELECT platform_reads_company_data())
    INSERT   (company_id = (SELECT get_active_company_id())
              AND (SELECT is_company_admin()))
             OR (SELECT platform_writes_company_data())
    UPDATE   the same, as USING and as WITH CHECK
    DELETE   the same

  Every member of an active company reads both tables — the screen is for
  everybody who may see the Fahrtenbuch — and only an administrator writes
  them, because both decide what the analysis calls a problem. A blocked
  company or account reads and writes nothing, as on every business table. A
  platform account reaches them only through a context (20260917140000): a
  view context reads, a support session reads and writes as the company's
  administrator.

  Both tables carry the two triggers every tenant table carries:
  `refuse_read_only_context_write` (a view context writes nothing, 3.4a) and
  `record_support_write` (every row a support session writes is audited,
  3.4c). tests/rls/support-write-audit.sql fails a table that has one without
  the other. What the audit copies follows 20260920110000's redaction rule
  unchanged: the three pay figures match its name rule (`salary`,
  `hourly_rate`), and `recompute_log` is a JSON document and is recorded by
  size.

  `anon` holds no privilege on either table. `authenticated` holds SELECT,
  INSERT, UPDATE and DELETE and nothing else; the service role holds nothing —
  no edge function reads or writes these tables.

  ## Compatibility — this does NOT bump deploy/SCHEMA_EPOCH

  Two new tables and two new trigger functions. Nothing existing changes, so
  the previous release runs unchanged beside them and simply never reads them.

  tests/rls/trip-analysis-settings.sql is this file's kit; tests/rls/matrix.sql
  carries both tables' lines.
*/

-- ─── 1. trip_analysis_settings ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.trip_analysis_settings (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- NULL: not set. A block ends at a pause longer than this.
  block_gap_minutes     integer     NULL CHECK (block_gap_minutes BETWEEN 1 AND 720),
  -- NULL: not set. A gap between two rides shorter than this is flagged.
  travel_margin_minutes integer     NULL CHECK (travel_margin_minutes BETWEEN 0 AND 240),
  -- Stamped by the trigger, never taken from the client.
  updated_by            uuid        NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_analysis_settings_one_per_company UNIQUE (company_id)
);

COMMENT ON TABLE public.trip_analysis_settings IS
  'The Fahrtenanalyse inputs a company decides: the block threshold and the travel '
  'margin, in minutes. NULL means not set; the screen asks rather than assuming '
  '(20260922110000).';

-- ─── 2. driver_month_budget ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.driver_month_budget (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid          NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  driver_id            uuid          NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  year                 integer       NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month                integer       NOT NULL CHECK (month BETWEEN 1 AND 12),
  -- NULL: not set. 0 is an answer ("no reserve"), not the absence of one.
  reserved_hours       numeric(6,2)  NULL CHECK (reserved_hours >= 0 AND reserved_hours <= 744),
  -- The driver's figures when the owner confirmed the month. Written only by
  -- the trigger, from public.drivers; the same types as the columns copied.
  planning_min_salary  numeric(10,2) NULL,
  planning_max_salary  numeric(10,2) NULL,
  planning_hourly_rate numeric       NULL,
  confirmed_by         uuid          NULL,
  confirmed_at         timestamptz   NULL,
  -- Every recompute and every change of the reserve of a confirmed month, in
  -- order. Written only by the trigger.
  recompute_log        jsonb         NOT NULL DEFAULT '[]'::jsonb,
  updated_by           uuid          NULL,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  -- year and month before the driver, so the screen's read of one company's
  -- month uses the same index as the uniqueness it states.
  CONSTRAINT driver_month_budget_one_per_month UNIQUE (company_id, year, month, driver_id),
  CONSTRAINT driver_month_budget_snapshot_needs_confirmation
    CHECK (confirmed_at IS NOT NULL
           OR (planning_min_salary IS NULL AND planning_max_salary IS NULL AND planning_hourly_rate IS NULL)),
  CONSTRAINT driver_month_budget_log_is_array CHECK (jsonb_typeof(recompute_log) = 'array')
);

-- The ON DELETE CASCADE from drivers looks rows up by driver.
CREATE INDEX IF NOT EXISTS driver_month_budget_driver_idx ON public.driver_month_budget (driver_id);

COMMENT ON TABLE public.driver_month_budget IS
  'The Fahrtenanalyse budget of one driver and month: the reserve the owner holds '
  'back, and the driver''s pay figures as they stood when the owner confirmed the '
  'month. A recompute is explicit and recorded in recompute_log (20260922110000).';

-- ─── 3. The triggers that keep the rows honest ──────────────────────────────

/*
  Both run as their owner (SECURITY DEFINER) so that the driver lookup answers
  the same whoever writes: the check "this driver belongs to this company" must
  not depend on what the caller may read. Nothing is returned to the caller from
  that read — a mismatch raises, and a match only copies figures onto a row that
  RLS must still admit into the caller's own company, as an administrator.
*/
CREATE OR REPLACE FUNCTION app_private.trip_analysis_settings_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.driver_month_budget_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_driver record;
  v_entry  jsonb;
BEGIN
  -- 1. The key is fixed: a budget stays with its driver, company and month.
  IF TG_OP = 'UPDATE'
     AND (NEW.company_id IS DISTINCT FROM OLD.company_id
          OR NEW.driver_id IS DISTINCT FROM OLD.driver_id
          OR NEW.year      IS DISTINCT FROM OLD.year
          OR NEW.month     IS DISTINCT FROM OLD.month) THEN
    RAISE EXCEPTION 'Ein Monatsbudget bleibt bei seinem Fahrer, seinem Unternehmen und seinem Monat.'
      USING ERRCODE = 'P0001', HINT = 'budget_key_fixed';
  END IF;

  --    …and the driver belongs to the row's company.
  SELECT d.company_id, d.planning_min_salary, d.planning_max_salary, d.planning_hourly_rate
    INTO v_driver
    FROM public.drivers d
   WHERE d.id = NEW.driver_id;

  IF NOT FOUND OR v_driver.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'Der Fahrer gehört nicht zu diesem Unternehmen.'
      USING ERRCODE = 'P0001', HINT = 'driver_company_mismatch';
  END IF;

  NEW.updated_by := v_uid;
  NEW.updated_at := now();

  IF TG_OP = 'INSERT' THEN
    NEW.created_at    := now();
    NEW.recompute_log := '[]'::jsonb;

    -- 2. A confirmation on insert takes the snapshot now.
    IF NEW.confirmed_at IS NOT NULL THEN
      NEW.planning_min_salary  := v_driver.planning_min_salary;
      NEW.planning_max_salary  := v_driver.planning_max_salary;
      NEW.planning_hourly_rate := v_driver.planning_hourly_rate;
      NEW.confirmed_at         := now();
      NEW.confirmed_by         := v_uid;
    ELSE
      NEW.planning_min_salary  := NULL;
      NEW.planning_max_salary  := NULL;
      NEW.planning_hourly_rate := NULL;
      NEW.confirmed_by         := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. The log and the creation time are never the client's.
  NEW.created_at    := OLD.created_at;
  NEW.recompute_log := OLD.recompute_log;

  -- 5. A confirmation is not taken back by writing NULL.
  IF OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'Eine Bestätigung kann nicht zurückgenommen werden. Löschen Sie das Monatsbudget, um den Monat neu zu beginnen.'
      USING ERRCODE = 'P0001', HINT = 'budget_unconfirm_refused';
  END IF;

  IF NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    -- 4. Confirming a confirmed month is a recompute, and it is recorded.
    IF OLD.confirmed_at IS NOT NULL THEN
      v_entry := jsonb_build_object(
        'kind',     'recompute',
        'at',       now(),
        'by',       v_uid,
        'previous', jsonb_build_object(
                      'planning_min_salary',  OLD.planning_min_salary,
                      'planning_max_salary',  OLD.planning_max_salary,
                      'planning_hourly_rate', OLD.planning_hourly_rate,
                      'confirmed_at',         OLD.confirmed_at,
                      'confirmed_by',         OLD.confirmed_by));
      NEW.recompute_log := NEW.recompute_log || jsonb_build_array(v_entry);
    END IF;

    -- 2. The snapshot is the driver's figures now, whatever the client sent.
    NEW.planning_min_salary  := v_driver.planning_min_salary;
    NEW.planning_max_salary  := v_driver.planning_max_salary;
    NEW.planning_hourly_rate := v_driver.planning_hourly_rate;
    NEW.confirmed_at         := now();
    NEW.confirmed_by         := v_uid;
  ELSE
    -- 3. No confirmation asked for: nothing about it moves.
    NEW.planning_min_salary  := OLD.planning_min_salary;
    NEW.planning_max_salary  := OLD.planning_max_salary;
    NEW.planning_hourly_rate := OLD.planning_hourly_rate;
    NEW.confirmed_at         := OLD.confirmed_at;
    NEW.confirmed_by         := OLD.confirmed_by;
  END IF;

  -- 4. The reserve of a confirmed month changes on the record too.
  IF OLD.confirmed_at IS NOT NULL AND NEW.reserved_hours IS DISTINCT FROM OLD.reserved_hours THEN
    NEW.recompute_log := NEW.recompute_log || jsonb_build_array(jsonb_build_object(
      'kind',     'reserve',
      'at',       now(),
      'by',       v_uid,
      'previous', jsonb_build_object('reserved_hours', OLD.reserved_hours),
      'reserved_hours', NEW.reserved_hours));
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_private.driver_month_budget_guard() IS
  'Keeps a driver_month_budget row with its driver and month, takes the pay '
  'snapshot from public.drivers only on an explicit confirmation, and records '
  'every recompute and every reserve change of a confirmed month (20260922110000).';

DROP TRIGGER IF EXISTS trip_analysis_settings_stamp ON public.trip_analysis_settings;
CREATE TRIGGER trip_analysis_settings_stamp
  BEFORE INSERT OR UPDATE ON public.trip_analysis_settings
  FOR EACH ROW EXECUTE FUNCTION app_private.trip_analysis_settings_stamp();

DROP TRIGGER IF EXISTS driver_month_budget_guard ON public.driver_month_budget;
CREATE TRIGGER driver_month_budget_guard
  BEFORE INSERT OR UPDATE ON public.driver_month_budget
  FOR EACH ROW EXECUTE FUNCTION app_private.driver_month_budget_guard();

-- ─── 4. The tenant shape ────────────────────────────────────────────────────

ALTER TABLE public.trip_analysis_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_month_budget    ENABLE ROW LEVEL SECURITY;

DO $mig$
DECLARE
  v_tbl    text;
  p        record;
  v_tenant constant text := 'company_id = (SELECT public.get_active_company_id())';
  v_reads  constant text := '(SELECT public.platform_reads_company_data())';
  v_writes constant text := '(SELECT public.platform_writes_company_data())';
  v_admin  constant text := '(SELECT public.is_company_admin())';
  v_where  text;
BEGIN
  v_where := v_tenant || ' AND ' || v_admin;

  FOREACH v_tbl IN ARRAY ARRAY['trip_analysis_settings', 'driver_month_budget'] LOOP
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
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated '
      'USING ((%s) OR %s) WITH CHECK ((%s) OR %s)',
      v_tbl || '_update', v_tbl, v_where, v_writes, v_where, v_writes);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING ((%s) OR %s)',
      v_tbl || '_delete', v_tbl, v_where, v_writes);

    -- 3.4a: a view context writes nothing. 3.4c: a support session's rows are
    -- recorded. The same two triggers, with the same names and shapes, as the
    -- 39 tables those migrations derived them onto.
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
  END LOOP;
END $mig$;

-- ─── 5. Ownership and privileges ────────────────────────────────────────────

-- The SECURITY DEFINER functions read public.drivers; CREATE OR REPLACE keeps
-- whatever owner a function had, so the owner is stated.
ALTER FUNCTION app_private.trip_analysis_settings_stamp() OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.driver_month_budget_guard()    OWNER TO CURRENT_USER;

-- Fired by triggers only. Triggers do not check EXECUTE; the REVOKE is the
-- second wall behind the missing USAGE on app_private.
REVOKE ALL ON FUNCTION app_private.trip_analysis_settings_stamp() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.driver_month_budget_guard()    FROM PUBLIC, anon, authenticated, service_role;

-- Supabase's default privileges grant every new public table to anon,
-- authenticated and service_role. anon never reads these; the service role
-- has no caller that would.
REVOKE ALL ON TABLE public.trip_analysis_settings FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.driver_month_budget    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trip_analysis_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.driver_month_budget    TO authenticated;

-- ─── 6. Self-check ──────────────────────────────────────────────────────────

DO $mig$
DECLARE
  v_wrong text;
  v_tbl   text;
  v_admin constant text := 'is_company_admin';
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['trip_analysis_settings', 'driver_month_budget'] LOOP
    -- 1. RLS is on.
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', v_tbl)::regclass) THEN
      RAISE EXCEPTION 'trip analysis self-check: % has row level security off', v_tbl;
    END IF;

    -- 2. Exactly the four policies of the business shape, each asking the
    --    active-company helper, every write asking for an administrator, and
    --    the UPDATE stating the same predicate as USING and as WITH CHECK.
    SELECT string_agg(format('%s (%s)', p.policyname, p.cmd), ', ' ORDER BY p.policyname) INTO v_wrong
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = v_tbl
       AND NOT (
             p.policyname = v_tbl || '_' || lower(p.cmd)
         AND p.roles = ARRAY['authenticated']::name[]
         AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'get_active_company_id'
         AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'user_profiles|is_user_super_admin'
         AND (p.cmd = 'SELECT' OR (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ v_admin)
         AND (p.cmd <> 'UPDATE' OR p.qual = p.with_check));
    IF v_wrong IS NOT NULL THEN
      RAISE EXCEPTION 'trip analysis self-check: % has a policy outside the business shape: %', v_tbl, v_wrong;
    END IF;
    IF (SELECT count(DISTINCT p.cmd) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_tbl) <> 4
       OR (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_tbl) <> 4 THEN
      RAISE EXCEPTION 'trip analysis self-check: % must carry exactly one SELECT, INSERT, UPDATE and DELETE policy', v_tbl;
    END IF;

    -- 3. The two tenant triggers, in 3.4a's and 3.4c's shapes: a statement-level
    --    BEFORE INSERT/UPDATE/DELETE refusal (tgtype 30) and a gated AFTER ROW
    --    audit (tgtype 29), both enabled.
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                      AND g.tgname = 'refuse_read_only_context_write'
                      AND NOT g.tgisinternal AND g.tgtype = 30 AND g.tgenabled = 'O'
                      AND g.tgfoid = 'app_private.refuse_read_only_context_write()'::regprocedure) THEN
      RAISE EXCEPTION 'trip analysis self-check: % does not carry the view-context refusal trigger', v_tbl;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                      AND g.tgname = 'record_support_write'
                      AND NOT g.tgisinternal AND g.tgtype = 29 AND g.tgenabled = 'O'
                      AND g.tgqual IS NOT NULL
                      AND pg_get_triggerdef(g.oid) ~ 'app_private\.support_write_context'
                      AND g.tgfoid = 'app_private.record_support_write()'::regprocedure) THEN
      RAISE EXCEPTION 'trip analysis self-check: % does not carry the gated support-write audit trigger', v_tbl;
    END IF;

    -- 4. Privileges: nothing for anon or the service role, the four DML
    --    commands and nothing else for authenticated.
    IF has_table_privilege('anon', format('public.%I', v_tbl), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('service_role', format('public.%I', v_tbl), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('authenticated', format('public.%I', v_tbl), 'TRUNCATE,REFERENCES,TRIGGER')
       OR NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'SELECT')
       OR NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'INSERT')
       OR NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'UPDATE')
       OR NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'DELETE') THEN
      RAISE EXCEPTION 'trip analysis self-check: the table privileges on % are not anon none, authenticated SELECT/INSERT/UPDATE/DELETE, service_role none', v_tbl;
    END IF;
  END LOOP;

  -- 5. The two trigger functions: SECURITY DEFINER, a pinned search_path, an
  --    owner that can reach app_private, executable by no API role.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ' ORDER BY f.sig) INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig))
                 THEN 'not SECURITY DEFINER'
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               WHEN NOT EXISTS (
                      SELECT 1 FROM pg_proc p
                        JOIN pg_roles r ON r.oid = p.proowner
                       WHERE p.oid = to_regprocedure(v.sig)
                         AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private')))
                 THEN 'owner cannot reach app_private'
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE')
                 OR has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE')
                 OR has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE')
                 THEN 'executable by a role the API authenticates as'
             END AS problem
        FROM (VALUES ('app_private.trip_analysis_settings_stamp()'),
                     ('app_private.driver_month_budget_guard()')) AS v(sig)
    ) f
   WHERE f.problem IS NOT NULL;
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'trip analysis self-check: %', v_wrong;
  END IF;

  -- 6. The guard is a BEFORE INSERT OR UPDATE row trigger (tgtype 23 = ROW 1 +
  --    BEFORE 2 + INSERT 4 + UPDATE 16), and so is the stamp.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = 'public.driver_month_budget'::regclass
                    AND g.tgname = 'driver_month_budget_guard'
                    AND NOT g.tgisinternal AND g.tgtype = 23 AND g.tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g
                     WHERE g.tgrelid = 'public.trip_analysis_settings'::regclass
                       AND g.tgname = 'trip_analysis_settings_stamp'
                       AND NOT g.tgisinternal AND g.tgtype = 23 AND g.tgenabled = 'O') THEN
    RAISE EXCEPTION 'trip analysis self-check: the guard and the stamp must be enabled BEFORE INSERT OR UPDATE row triggers';
  END IF;

  -- 7. What a support session's audit copies: the three pay figures are
  --    redacted by 20260920110000's rule, the reserve is not.
  IF NOT ('planning_min_salary'  ~ app_private.support_write_redaction_pattern('driver_month_budget')
          AND 'planning_max_salary'  ~ app_private.support_write_redaction_pattern('driver_month_budget')
          AND 'planning_hourly_rate' ~ app_private.support_write_redaction_pattern('driver_month_budget')
          AND 'reserved_hours'      !~ app_private.support_write_redaction_pattern('driver_month_budget')
          AND 'block_gap_minutes'   !~ app_private.support_write_redaction_pattern('trip_analysis_settings')) THEN
    RAISE EXCEPTION 'trip analysis self-check: the support-write redaction rule does not cover the budget''s pay figures as expected';
  END IF;

  RAISE NOTICE 'trip analysis self-check: passed';
END $mig$;
