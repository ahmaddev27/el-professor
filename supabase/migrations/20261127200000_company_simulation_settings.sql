-- # The company's simulation settings (FleetBook round 8, section 5 and section 3)
--
-- ## What this is
--
-- One row per company with two answers the simulator used to take from a form
-- that forgot them on every reload:
--
--   * the share rate of section 5 ("make the allowed percentage selectable
--     through company settings"): `fixed` names one of 30, 31, 32 or 33 per
--     cent; `random` names the scope of the draw (`month` or `day`) and the
--     seed, so the same setting always gives the same rates. No mode at all is
--     a valid row: "not configured", which the report prints as such.
--   * whether a shift ends with the drive back to the Betriebssitz (section 3,
--     decision D8): off unless the company turns it on. The spec forbids a
--     universal return requirement, so the default is false.
--
-- ## What is deliberately NOT here
--
-- No column for what the share MEANS, who receives it, or its base. That is
-- open decision D1, and the report says CONFIGURATION_REQUIRED until the owner
-- answers it. The share is computed on the imported Uber umsatz and shown;
-- nothing books it. No driver column either (D2 to D4).
--
-- ## The values
--
-- `share_percent` is a whole percent restricted to the four the audit allows,
-- the same list as SHARE_PERCENT_CHOICES in src/utils/simulatedRides/monthlyRate.ts.
-- `seed` is a non-negative integer: the browser's draw XORs it as a 32-bit
-- value, so a wider type would only store seeds that read back as others.
-- The shape constraint ties the columns to the mode, so a row can never say
-- `fixed` and also carry a seed that a reader might take for the rate's source.
--
-- ## Access: the business-table shape of 20260917130000, writes ask an administrator
--
--   SELECT   company_id = (SELECT get_active_company_id())
--            OR (SELECT platform_reads_company_data())
--   writes   (company_id = (SELECT get_active_company_id()) AND (SELECT is_company_admin()))
--            OR (SELECT platform_writes_company_data())
--            as USING and as WITH CHECK, which is what refuses a move between
--            companies.
--
-- It is configuration of how money is presented, so the gate is
-- `is_company_admin()`, the term trip_analysis_settings and
-- company_monthly_revenue_share use. No page_key is created (the Rollen screen
-- would drop a key it does not know), and nothing is added to plan_features,
-- app_private.platform_settings or PAGE_DEFINITIONS.
--
-- Because its policies name get_active_company_id(), the table carries both
-- tenant triggers, `refuse_read_only_context_write` (a view context writes
-- nothing) and `record_support_write` (a support session's rows are audited).
-- The rule is keyed on the policies, not on who writes today
-- (tests/rls/platform-contexts.sql, tests/rls/support-write-audit.sql).
--
-- ## Compatibility
--
-- A new table and one trigger function. Nothing existing changes, so this does
-- NOT bump deploy/SCHEMA_EPOCH; the previous release never reads the table.
-- Tests: tests/rls/simulation-settings.sql, and the table's lines in
-- tests/rls/matrix.sql.

CREATE TABLE IF NOT EXISTS public.company_simulation_settings (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  share_mode     text        NULL,
  share_percent  integer     NULL,
  share_scope    text        NULL,
  seed           integer     NULL,
  return_to_base boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NULL,
  updated_by     uuid        NULL,
  CONSTRAINT company_simulation_settings_one_per_company UNIQUE (company_id),
  CONSTRAINT company_simulation_settings_mode_known
    CHECK (share_mode IS NULL OR share_mode IN ('fixed', 'random')),
  CONSTRAINT company_simulation_settings_percent_allowed
    CHECK (share_percent IS NULL OR share_percent IN (30, 31, 32, 33)),
  CONSTRAINT company_simulation_settings_scope_known
    CHECK (share_scope IS NULL OR share_scope IN ('month', 'day')),
  CONSTRAINT company_simulation_settings_seed_range
    CHECK (seed IS NULL OR seed >= 0),
  CONSTRAINT company_simulation_settings_share_shape CHECK (
       (share_mode IS NULL     AND share_percent IS NULL     AND share_scope IS NULL     AND seed IS NULL)
    OR (share_mode IS NOT DISTINCT FROM 'fixed'  AND share_percent IS NOT NULL AND share_scope IS NULL     AND seed IS NULL)
    OR (share_mode IS NOT DISTINCT FROM 'random' AND share_percent IS NULL     AND share_scope IS NOT NULL AND seed IS NOT NULL)
  )
);

COMMENT ON TABLE public.company_simulation_settings IS
  'The simulator''s company settings (FleetBook round 8): the share rate of '
  'section 5 (fixed 30..33 %, or a seeded draw per month or per day; NULL mode = '
  'not configured) and whether a shift ends at the Betriebssitz (off by default). '
  'The share''s meaning is not stored: it stays CONFIGURATION_REQUIRED (20261127200000).';

CREATE OR REPLACE FUNCTION app_private.company_simulation_settings_stamp()
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
    NEW.created_by := auth.uid();
  ELSE
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_private.company_simulation_settings_stamp() IS
  'Stamps created_by/updated_by from auth.uid() and the timestamps, whatever the '
  'client sent (20261127200000).';

DROP TRIGGER IF EXISTS company_simulation_settings_stamp ON public.company_simulation_settings;
CREATE TRIGGER company_simulation_settings_stamp
  BEFORE INSERT OR UPDATE ON public.company_simulation_settings
  FOR EACH ROW EXECUTE FUNCTION app_private.company_simulation_settings_stamp();

ALTER TABLE public.company_simulation_settings ENABLE ROW LEVEL SECURITY;

DO $mig$
DECLARE
  v_tbl    constant text := 'company_simulation_settings';
  p        record;
  v_tenant constant text := 'company_id = (SELECT public.get_active_company_id())';
  v_reads  constant text := '(SELECT public.platform_reads_company_data())';
  v_writes constant text := '(SELECT public.platform_writes_company_data())';
  v_admin  constant text := '(SELECT public.is_company_admin())';
  v_where  text;
BEGIN
  v_where := v_tenant || ' AND ' || v_admin;

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
END $mig$;

ALTER FUNCTION app_private.company_simulation_settings_stamp() OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION app_private.company_simulation_settings_stamp() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON TABLE public.company_simulation_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_simulation_settings TO authenticated;

-- Self-check: fails the release when any rule above did not take.
DO $selfcheck$
DECLARE
  c_tbl   constant text := 'company_simulation_settings';
  v_wrong text;
  v_n     int;
  v_name  text;
BEGIN
  -- 1. Row level security is on.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', c_tbl)::regclass) THEN
    RAISE EXCEPTION 'simulation settings self-check 1: % has row level security off', c_tbl;
  END IF;

  -- 2. Exactly the four policies, in the business shape, every write asking an administrator.
  SELECT count(*) INTO v_n FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c_tbl;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'simulation settings self-check 2: % must carry exactly four policies, has %', c_tbl, v_n;
  END IF;
  SELECT string_agg(p.policyname::text, ', ') INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = c_tbl
     AND NOT (
           p.policyname = c_tbl || '_' || lower(p.cmd)
       AND p.roles = ARRAY['authenticated']::name[]
       AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'get_active_company_id'
       AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'user_profiles|is_user_super_admin'
       AND (p.cmd = 'SELECT' OR (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'is_company_admin'));
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'simulation settings self-check 2: policy outside the business shape: %', v_wrong;
  END IF;

  -- 3. One predicate as USING and WITH CHECK on every write, which is what refuses a move.
  IF NOT EXISTS (SELECT 1 FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = c_tbl AND p.cmd = 'UPDATE'
                    AND p.qual IS NOT NULL AND p.qual = p.with_check) THEN
    RAISE EXCEPTION 'simulation settings self-check 3: the UPDATE policy''s WITH CHECK differs from its USING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = c_tbl AND p.cmd = 'INSERT'
                    AND p.with_check = (SELECT u.qual FROM pg_policies u
                                         WHERE u.schemaname = 'public' AND u.tablename = c_tbl AND u.cmd = 'UPDATE')) THEN
    RAISE EXCEPTION 'simulation settings self-check 3: the INSERT policy''s WITH CHECK differs from the UPDATE predicate';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = c_tbl AND p.cmd = 'DELETE'
                    AND p.qual = (SELECT u.qual FROM pg_policies u
                                   WHERE u.schemaname = 'public' AND u.tablename = c_tbl AND u.cmd = 'UPDATE')) THEN
    RAISE EXCEPTION 'simulation settings self-check 3: the DELETE policy''s USING differs from the UPDATE predicate';
  END IF;

  -- 4. Both tenant triggers and the stamp.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = format('public.%I', c_tbl)::regclass
                    AND g.tgname = 'refuse_read_only_context_write'
                    AND NOT g.tgisinternal AND g.tgtype = 30 AND g.tgenabled = 'O'
                    AND g.tgfoid = 'app_private.refuse_read_only_context_write()'::regprocedure) THEN
    RAISE EXCEPTION 'simulation settings self-check 4: % does not carry the view-context refusal trigger', c_tbl;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = format('public.%I', c_tbl)::regclass
                    AND g.tgname = 'record_support_write'
                    AND NOT g.tgisinternal AND g.tgtype = 29 AND g.tgenabled = 'O'
                    AND g.tgqual IS NOT NULL
                    AND pg_get_triggerdef(g.oid) ~ 'app_private\.support_write_context'
                    AND g.tgfoid = 'app_private.record_support_write()'::regprocedure) THEN
    RAISE EXCEPTION 'simulation settings self-check 4: % does not carry the gated support-write audit trigger', c_tbl;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = format('public.%I', c_tbl)::regclass
                    AND g.tgname = 'company_simulation_settings_stamp'
                    AND NOT g.tgisinternal AND g.tgtype = 23 AND g.tgenabled = 'O') THEN
    RAISE EXCEPTION 'simulation settings self-check 4: the stamp must be an enabled BEFORE INSERT OR UPDATE row trigger';
  END IF;

  -- 5. Privileges: authenticated reads and writes through the policies; anon and service_role hold nothing.
  IF has_table_privilege('anon', format('public.%I', c_tbl), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('service_role', format('public.%I', c_tbl), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('authenticated', format('public.%I', c_tbl), 'TRUNCATE,REFERENCES,TRIGGER')
     OR NOT has_table_privilege('authenticated', format('public.%I', c_tbl), 'SELECT')
     OR NOT has_table_privilege('authenticated', format('public.%I', c_tbl), 'INSERT')
     OR NOT has_table_privilege('authenticated', format('public.%I', c_tbl), 'UPDATE')
     OR NOT has_table_privilege('authenticated', format('public.%I', c_tbl), 'DELETE') THEN
    RAISE EXCEPTION 'simulation settings self-check 5: privileges on % are not anon none, authenticated SELECT/INSERT/UPDATE/DELETE, service_role none', c_tbl;
  END IF;

  -- 6. Every value constraint, and the one row per company.
  FOREACH v_name IN ARRAY ARRAY[
    'company_simulation_settings_mode_known', 'company_simulation_settings_percent_allowed',
    'company_simulation_settings_scope_known', 'company_simulation_settings_seed_range',
    'company_simulation_settings_share_shape'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                    WHERE k.conrelid = format('public.%I', c_tbl)::regclass AND k.contype = 'c' AND k.conname = v_name) THEN
      RAISE EXCEPTION 'simulation settings self-check 6: constraint % is gone', v_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = format('public.%I', c_tbl)::regclass AND k.contype = 'c'
                    AND k.conname = 'company_simulation_settings_percent_allowed'
                    AND pg_get_constraintdef(k.oid) ~ '30' AND pg_get_constraintdef(k.oid) ~ '33'
                    AND pg_get_constraintdef(k.oid) !~ '34') THEN
    RAISE EXCEPTION 'simulation settings self-check 6: the share percent is no longer restricted to 30..33';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = format('public.%I', c_tbl)::regclass AND k.contype = 'u'
                    AND k.conname = 'company_simulation_settings_one_per_company') THEN
    RAISE EXCEPTION 'simulation settings self-check 6: the one-row-per-company constraint is gone';
  END IF;
  -- 6b. The shape refuses a percent, a scope or a seed with no mode. A CHECK passes on NULL, and
  --     `share_mode = 'fixed'` is NULL when the mode is, so the first version of this constraint let
  --     such a row in (the RLS kit caught it). Asked of the real constraint, not of its text: the
  --     company id names no company, and a CHECK is evaluated before the foreign key, so 23514 means
  --     refused by the shape and 23503 means the shape let the row through.
  FOREACH v_name IN ARRAY ARRAY['share_percent = 31', 'share_scope = ''month''', 'seed = 7'] LOOP
    BEGIN
      EXECUTE format('INSERT INTO public.%I (company_id, %s) VALUES (gen_random_uuid(), %s)',
                     c_tbl, split_part(v_name, ' = ', 1), split_part(v_name, ' = ', 2));
      RAISE EXCEPTION 'simulation settings self-check 6b: a row with % and no mode was stored', v_name;
    EXCEPTION
      WHEN check_violation THEN NULL;
      WHEN foreign_key_violation THEN
        RAISE EXCEPTION 'simulation settings self-check 6b: the shape lets % through with no mode', v_name;
    END;
  END LOOP;
  IF (SELECT a.attnotnull IS NOT TRUE OR pg_get_expr(d.adbin, d.adrelid) IS DISTINCT FROM 'false'
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = format('public.%I', c_tbl)::regclass AND a.attname = 'return_to_base') THEN
    RAISE EXCEPTION 'simulation settings self-check 6: return_to_base must be NOT NULL DEFAULT false (D8: no universal return)';
  END IF;

  -- 7. The stamp is a definer with a pinned search_path that no API role can call.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'app_private.company_simulation_settings_stamp()'::regprocedure
                    AND p.prosecdef
                    AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c(setting) WHERE c.setting LIKE 'search_path=%')) THEN
    RAISE EXCEPTION 'simulation settings self-check 7: the stamp is not SECURITY DEFINER with a pinned search_path';
  END IF;
  IF has_function_privilege('anon', 'app_private.company_simulation_settings_stamp()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.company_simulation_settings_stamp()', 'EXECUTE')
     OR has_function_privilege('service_role', 'app_private.company_simulation_settings_stamp()', 'EXECUTE') THEN
    RAISE EXCEPTION 'simulation settings self-check 7: the stamp is executable by a role the API authenticates as';
  END IF;

  -- 8. No column names what the share means, who receives it, or a driver (D1 to D4).
  SELECT string_agg(a.attname::text, ', ') INTO v_wrong
    FROM pg_attribute a
   WHERE a.attrelid = format('public.%I', c_tbl)::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname NOT IN ('id', 'company_id', 'share_mode', 'share_percent', 'share_scope', 'seed',
                           'return_to_base', 'created_at', 'updated_at', 'created_by', 'updated_by');
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'simulation settings self-check 8: unexpected column(s) %; the share''s meaning is decision D1, not a column', v_wrong;
  END IF;

  RAISE NOTICE 'simulation settings self-check: passed';
END $selfcheck$;
