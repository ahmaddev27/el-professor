/*
  # The monthly revenue share (external audit, section 4)

  ## What this is
  One row per company and month holding the rate an operator **configured** for
  that month: the audit asks for `basis_eligible_monthly_revenue x
  selected_monthly_rate`, in exact decimal with uniform cent rounding, showing
  the basis, the rate, the result and the remainder if the share is treated as a
  deduction (10.000 EUR x 31,42 % = 3.142,00 EUR, remainder 6.858,00 EUR).

  There are two sources for the rate and one computation. The simulator draws a
  rate at random from a saved seed (reproducibility for an auditor); the product
  reads the row below. A random rate is not something a real company can be
  told. Both go through one cent-rounding formula.

  ## Per month, not a column on company_settings
  Section 4 wants one rate that does not change across a month's trips. A single
  column would silently rewrite every earlier month when it was edited. One row
  per (company, year, month) keeps each month's figure as it was configured.

  ## The rate is whole basis points
  `rate_basis_points` is an integer, 0..10000 (0,00 % to 100,00 %). Whole basis
  points are what make the cent arithmetic exact: basis_cents x bp / 10000 is an
  integer division with one rounding, never a binary float.

  ## Why 0..10000 and not 30..33
  The 30 to 33 % band is an artefact of the audit scenario. The product's only
  other revenue share, `drivers.salary_ratio`, is numeric(5,4) with CHECK
  (>= 0 AND <= 1), and nothing in the codebase uses a 30..33 band. The stored
  rate mirrors that range; the band stays in the simulator alone.

  ## Access: the business-table shape of 20260917130000, writes ask an administrator
    SELECT   company_id = (SELECT get_active_company_id())
             OR (SELECT platform_reads_company_data())
    writes   (company_id = (SELECT get_active_company_id()) AND (SELECT is_company_admin()))
             OR (SELECT platform_writes_company_data())
             as USING and as WITH CHECK, which is what refuses a move between
             companies.
  It is money configuration, so the gate is `is_company_admin()`, the term
  trip_analysis_settings and driver_month_budget use (20260922110000). No
  page_key is created: the Rollen screen rebuilds a role's rows from
  PAGE_DEFINITIONS and would drop a key it does not know. Nothing is added to
  plan_features, app_private.platform_settings or PAGE_DEFINITIONS.

  Because its policies name get_active_company_id(), the table carries both
  tenant triggers, `refuse_read_only_context_write` (a view context writes
  nothing) and `record_support_write` (a support session's rows are audited).
  The rule is keyed on the policies, not on who writes today
  (tests/rls/platform-contexts.sql, tests/rls/support-write-audit.sql).

  ## Compatibility
  A new table and one trigger function. Nothing existing changes, so this does
  NOT bump deploy/SCHEMA_EPOCH; the previous release never reads the table.
*/

-- ─── 1. The table ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.company_monthly_revenue_share (
  id                           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                   uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  year                         integer     NOT NULL,
  month                        integer     NOT NULL,
  -- Hundredths of a percent: 3142 is 31,42 %.
  rate_basis_points            integer     NOT NULL,
  -- What counts as eligible revenue for this month's basis.
  basis_includes_tips          boolean     NOT NULL DEFAULT false,
  basis_includes_declined_fees boolean     NOT NULL DEFAULT true,
  note                         text        NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  created_by                   uuid        NULL,
  updated_by                   uuid        NULL,
  CONSTRAINT company_monthly_revenue_share_one_per_month UNIQUE (company_id, year, month),
  CONSTRAINT company_monthly_revenue_share_year_range  CHECK (year >= 2020 AND year <= 2100),
  CONSTRAINT company_monthly_revenue_share_month_range CHECK (month >= 1 AND month <= 12),
  CONSTRAINT company_monthly_revenue_share_rate_range  CHECK (rate_basis_points >= 0 AND rate_basis_points <= 10000),
  CONSTRAINT company_monthly_revenue_share_note_length CHECK (note IS NULL OR char_length(note) <= 500)
);

COMMENT ON TABLE public.company_monthly_revenue_share IS
  'The monthly revenue share rate a company configured for one month, in whole '
  'basis points (0..10000). One row per company and month, so editing a month '
  'never rewrites another (20261027150000).';

-- ─── 2. Who wrote it, stamped by the database ───────────────────────────────

CREATE OR REPLACE FUNCTION app_private.company_monthly_revenue_share_stamp()
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

COMMENT ON FUNCTION app_private.company_monthly_revenue_share_stamp() IS
  'Stamps created_by/updated_by from auth.uid() and the timestamps, whatever the '
  'client sent (20261027150000).';

DROP TRIGGER IF EXISTS company_monthly_revenue_share_stamp ON public.company_monthly_revenue_share;
CREATE TRIGGER company_monthly_revenue_share_stamp
  BEFORE INSERT OR UPDATE ON public.company_monthly_revenue_share
  FOR EACH ROW EXECUTE FUNCTION app_private.company_monthly_revenue_share_stamp();

-- ─── 3. The tenant shape ────────────────────────────────────────────────────

ALTER TABLE public.company_monthly_revenue_share ENABLE ROW LEVEL SECURITY;

DO $mig$
DECLARE
  v_tbl    constant text := 'company_monthly_revenue_share';
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

  -- 3.4a: a view context writes nothing. 3.4c: a support session's rows are
  -- recorded. The same two triggers, with the same names and shapes, as every
  -- other tenant table.
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

-- ─── 4. Ownership and privileges ────────────────────────────────────────────

ALTER FUNCTION app_private.company_monthly_revenue_share_stamp() OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION app_private.company_monthly_revenue_share_stamp() FROM PUBLIC, anon, authenticated, service_role;

-- Supabase's default privileges grant every new public table to anon,
-- authenticated and service_role. anon never reads this; no edge function does.
REVOKE ALL ON TABLE public.company_monthly_revenue_share FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_monthly_revenue_share TO authenticated;

-- ─── 5. Self-check ──────────────────────────────────────────────────────────

DO $selfcheck$
DECLARE
  c_tbl   constant text := 'company_monthly_revenue_share';
  v_wrong text;
  v_n     int;
BEGIN
  -- 1. RLS is on.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', c_tbl)::regclass) THEN
    RAISE EXCEPTION 'monthly revenue share self-check 1: % has row level security off', c_tbl;
  END IF;

  -- 2. Exactly the four named policies, for authenticated, each asking the
  --    active-company helper and nothing about profiles.
  SELECT string_agg(f.policyname, ', ') INTO v_wrong
    FROM (SELECT unnest(ARRAY[c_tbl || '_select', c_tbl || '_insert', c_tbl || '_update', c_tbl || '_delete']) AS policyname) f
   WHERE NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname = 'public' AND p.tablename = c_tbl AND p.policyname = f.policyname);
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'monthly revenue share self-check 2: missing policy %', v_wrong;
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c_tbl;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'monthly revenue share self-check 2: % must carry exactly four policies, has %', c_tbl, v_n;
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
    RAISE EXCEPTION 'monthly revenue share self-check 2: policy outside the business shape: %', v_wrong;
  END IF;

  -- 3. Every write states the same predicate as USING and as WITH CHECK, the
  --    thing that refuses a move between companies. UPDATE has both and they
  --    must be equal; INSERT's WITH CHECK and DELETE's USING are that predicate.
  IF NOT EXISTS (SELECT 1 FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = c_tbl AND p.cmd = 'UPDATE'
                    AND p.qual IS NOT NULL AND p.qual = p.with_check) THEN
    RAISE EXCEPTION 'monthly revenue share self-check 3: the UPDATE policy''s WITH CHECK differs from its USING — a row could be moved to another company';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = c_tbl AND p.cmd = 'INSERT'
                    AND p.with_check = (SELECT u.qual FROM pg_policies u
                                         WHERE u.schemaname = 'public' AND u.tablename = c_tbl AND u.cmd = 'UPDATE')) THEN
    RAISE EXCEPTION 'monthly revenue share self-check 3: the INSERT policy''s WITH CHECK differs from the UPDATE predicate';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = c_tbl AND p.cmd = 'DELETE'
                    AND p.qual = (SELECT u.qual FROM pg_policies u
                                   WHERE u.schemaname = 'public' AND u.tablename = c_tbl AND u.cmd = 'UPDATE')) THEN
    RAISE EXCEPTION 'monthly revenue share self-check 3: the DELETE policy''s USING differs from the UPDATE predicate';
  END IF;

  -- 4. The two tenant triggers, in 3.4a's and 3.4c's shapes: a statement-level
  --    BEFORE INSERT/UPDATE/DELETE refusal (tgtype 30) and a gated AFTER ROW
  --    audit (tgtype 29), both enabled; and the stamp (tgtype 23).
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = format('public.%I', c_tbl)::regclass
                    AND g.tgname = 'refuse_read_only_context_write'
                    AND NOT g.tgisinternal AND g.tgtype = 30 AND g.tgenabled = 'O'
                    AND g.tgfoid = 'app_private.refuse_read_only_context_write()'::regprocedure) THEN
    RAISE EXCEPTION 'monthly revenue share self-check 4: % does not carry the view-context refusal trigger', c_tbl;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = format('public.%I', c_tbl)::regclass
                    AND g.tgname = 'record_support_write'
                    AND NOT g.tgisinternal AND g.tgtype = 29 AND g.tgenabled = 'O'
                    AND g.tgqual IS NOT NULL
                    AND pg_get_triggerdef(g.oid) ~ 'app_private\.support_write_context'
                    AND g.tgfoid = 'app_private.record_support_write()'::regprocedure) THEN
    RAISE EXCEPTION 'monthly revenue share self-check 4: % does not carry the gated support-write audit trigger', c_tbl;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = format('public.%I', c_tbl)::regclass
                    AND g.tgname = 'company_monthly_revenue_share_stamp'
                    AND NOT g.tgisinternal AND g.tgtype = 23 AND g.tgenabled = 'O') THEN
    RAISE EXCEPTION 'monthly revenue share self-check 4: the stamp must be an enabled BEFORE INSERT OR UPDATE row trigger';
  END IF;

  -- 5. Privileges: nothing for anon or the service role, the four DML commands
  --    and nothing else for authenticated.
  IF has_table_privilege('anon', format('public.%I', c_tbl), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('service_role', format('public.%I', c_tbl), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('authenticated', format('public.%I', c_tbl), 'TRUNCATE,REFERENCES,TRIGGER')
     OR NOT has_table_privilege('authenticated', format('public.%I', c_tbl), 'SELECT')
     OR NOT has_table_privilege('authenticated', format('public.%I', c_tbl), 'INSERT')
     OR NOT has_table_privilege('authenticated', format('public.%I', c_tbl), 'UPDATE')
     OR NOT has_table_privilege('authenticated', format('public.%I', c_tbl), 'DELETE') THEN
    RAISE EXCEPTION 'monthly revenue share self-check 5: privileges on % are not anon none, authenticated SELECT/INSERT/UPDATE/DELETE, service_role none', c_tbl;
  END IF;

  -- 6. The rate, month, year, note and one-row-per-month constraints are
  --    present and say what the header says, read from their definitions.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = format('public.%I', c_tbl)::regclass AND k.contype = 'c'
                    AND k.conname = 'company_monthly_revenue_share_rate_range'
                    AND pg_get_constraintdef(k.oid) ~ 'rate_basis_points >= 0'
                    AND pg_get_constraintdef(k.oid) ~ 'rate_basis_points <= 10000') THEN
    RAISE EXCEPTION 'monthly revenue share self-check 6: the rate bounds 0..10000 basis points are gone';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = format('public.%I', c_tbl)::regclass AND k.contype = 'c'
                    AND k.conname = 'company_monthly_revenue_share_month_range'
                    AND pg_get_constraintdef(k.oid) ~ 'month >= 1'
                    AND pg_get_constraintdef(k.oid) ~ 'month <= 12')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint k
                     WHERE k.conrelid = format('public.%I', c_tbl)::regclass AND k.contype = 'c'
                       AND k.conname = 'company_monthly_revenue_share_year_range')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint k
                     WHERE k.conrelid = format('public.%I', c_tbl)::regclass AND k.contype = 'c'
                       AND k.conname = 'company_monthly_revenue_share_note_length')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint k
                     WHERE k.conrelid = format('public.%I', c_tbl)::regclass AND k.contype = 'u'
                       AND k.conname = 'company_monthly_revenue_share_one_per_month') THEN
    RAISE EXCEPTION 'monthly revenue share self-check 6: a month, year, note or one-row-per-month constraint is gone';
  END IF;

  -- 7. The stamp function: SECURITY DEFINER, pinned search_path, executable by
  --    no API role.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'app_private.company_monthly_revenue_share_stamp()'::regprocedure
                    AND p.prosecdef
                    AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c(setting) WHERE c.setting LIKE 'search_path=%')) THEN
    RAISE EXCEPTION 'monthly revenue share self-check 7: the stamp is not SECURITY DEFINER with a pinned search_path';
  END IF;
  IF has_function_privilege('anon', 'app_private.company_monthly_revenue_share_stamp()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.company_monthly_revenue_share_stamp()', 'EXECUTE')
     OR has_function_privilege('service_role', 'app_private.company_monthly_revenue_share_stamp()', 'EXECUTE') THEN
    RAISE EXCEPTION 'monthly revenue share self-check 7: the stamp is executable by a role the API authenticates as';
  END IF;

  RAISE NOTICE 'monthly revenue share self-check: passed';
END $selfcheck$;
