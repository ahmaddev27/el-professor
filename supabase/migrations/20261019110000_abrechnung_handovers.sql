/*
  # Who handed the cash back (owner request 19.10.2026)

  > On the Abrechnung each driver row gets an action: confirm that the driver
  > paid the money back to the company. A popup with one amount, defaulting to
  > the row's Difference, which the user can change. The row then shows the cash
  > given and a status (given / still with the driver).

  ## Two decisions the owner already took

  1. **A record only.** "Only to know who gives the money and who not." The
     Bargeldbestand does not move. `cashLedger.ts` already counts a driver's
     cash as IN the till from the day its `income.type = 'bargeld'` row is
     dated, so booking a movement on hand-over would count the same cash twice.
     This migration therefore touches NO existing table, trigger or function:
     no `cash_movements`, no `salary_payments`, no Gehaltsquittung RPC. The
     opposite flow, `salary_payments.source_type = 'weekly_cash_difference'`
     (the driver who KEPT the cash as wages), uses the same number and is left
     alone.
  2. **The amount is editable**, because a partial hand-over is the normal case:
     the driver owes 50 and has 30, so 30 is recorded.

  ## Store the amount, derive the status

  The row holds one number, what was handed over. "Given / partial / still with
  the driver" is computed in the browser by comparing it with the week's
  `bar_zuruck`, so no stored word can drift from the figures when a week is
  corrected later (src/utils/abrechnungHandover.ts). An amount of 0 is a real
  answer ("he handed nothing over") and a row exists for it; no row at all means
  nobody confirmed anything. The CHECK allows 0 and refuses a negative.

  ## The key is the key the screen uses, and its limit

  `(company_id, year, month, week_number, driver_name)`, UNIQUE. The Abrechnung
  identifies a row by exactly that: `income` and `receipts` carry a free-text
  driver name and no driver id, and `get_weekly_abrechnung` groups by it.
  `driver_id` is stored for reporting, resolved by the BEFORE trigger when the
  name matches exactly one ACTIVE driver of the company (case and repeated
  spaces ignored, as `abrechnung_reminder_facts` does) and NULL otherwise. It is
  not part of the key, or a driver with an ambiguous or unmatched name could not
  be recorded at all.

  **LIMITATION, not invented here: renaming a driver orphans the record.** The
  Abrechnung's own rows follow the name on `income` and `receipts`, so after a
  rename the old name's weeks stop appearing and the new name's weeks start with
  no hand-over record. The record stays in this table under the old name.

  ## Policies: the business shape, with the income page

  Four policies. SELECT is the tenant term or the read seam; every write repeats
  one predicate as USING and WITH CHECK, plus `current_role_permits('income',
  true)`. The page is `income` because the Abrechnung is built on `income`; the
  till's `cash-balance` would imply a till write this deliberately does not make.
  No page key is created, so `role_page_keys()` and PAGE_DEFINITIONS stay in
  step. There is no RPC: the screen upserts, and the guard trigger below stamps
  who and resolves the driver. Both context triggers are on, derived from the
  policies rather than from who writes today.

  ## The audit decision: the amount IS copied in the clear

  `support_write_redaction_pattern()` does not match `amount` for this table (it
  is a cash hand-over, not pay), and this file does not restate it. A support
  session's write is therefore recorded with the amount and the driver's name,
  which is what lets the log say what the operator changed.

  ## Privileges

  anon: nothing. authenticated: the four commands, through the policies.
  service_role: SELECT, for reporting.
*/

CREATE TABLE IF NOT EXISTS public.abrechnung_handovers (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid          NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  year         integer       NOT NULL,
  month        integer       NOT NULL,
  week_number  integer       NOT NULL,
  driver_name  text          NOT NULL,
  driver_id    uuid          NULL REFERENCES public.drivers(id) ON DELETE SET NULL,
  amount       numeric(12,2) NOT NULL,
  confirmed_by uuid          NULL,
  updated_by   uuid          NULL,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT abrechnung_handovers_year_check   CHECK (year BETWEEN 2000 AND 2100),
  CONSTRAINT abrechnung_handovers_month_check  CHECK (month BETWEEN 1 AND 12),
  CONSTRAINT abrechnung_handovers_week_check   CHECK (week_number BETWEEN 1 AND 53),
  CONSTRAINT abrechnung_handovers_name_check   CHECK (btrim(driver_name) <> ''),
  CONSTRAINT abrechnung_handovers_amount_check CHECK (amount >= 0),
  CONSTRAINT abrechnung_handovers_once
    UNIQUE (company_id, year, month, week_number, driver_name)
);

CREATE INDEX IF NOT EXISTS abrechnung_handovers_driver_idx
  ON public.abrechnung_handovers (driver_id) WHERE driver_id IS NOT NULL;

COMMENT ON TABLE public.abrechnung_handovers IS
  'What a driver handed back to the company for one Abrechnung week. A record only: it moves no cash and no Bargeldbestand figure. The status (given / partial / open) is derived in the browser from amount and bar_zuruck. Keyed by the Abrechnung''s own identity, driver_name; a driver rename orphans the record.';

-- SECURITY INVOKER on purpose: the driver lookup runs under the caller's own
-- policies. It names only public, pg_catalog and auth.uid(), because
-- authenticated has no USAGE on app_private (the function lives there, which is
-- fine; nothing it calls does).
CREATE OR REPLACE FUNCTION app_private.abrechnung_handovers_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  SELECT array_agg(d.id) INTO v_ids
    FROM public.drivers d
   WHERE d.company_id = NEW.company_id
     AND d.status = 'active'
     AND lower(regexp_replace(btrim(d.name), '\s+', ' ', 'g'))
       = lower(regexp_replace(btrim(NEW.driver_name), '\s+', ' ', 'g'));
  NEW.driver_id := CASE WHEN cardinality(v_ids) = 1 THEN v_ids[1] ELSE NULL END;

  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  IF TG_OP = 'INSERT' THEN
    NEW.confirmed_by := auth.uid();
    NEW.created_at   := now();
  ELSE
    NEW.confirmed_by := OLD.confirmed_by;
    NEW.created_at   := OLD.created_at;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS abrechnung_handovers_guard ON public.abrechnung_handovers;
CREATE TRIGGER abrechnung_handovers_guard
  BEFORE INSERT OR UPDATE ON public.abrechnung_handovers
  FOR EACH ROW EXECUTE FUNCTION app_private.abrechnung_handovers_guard();

ALTER TABLE public.abrechnung_handovers ENABLE ROW LEVEL SECURITY;

DO $mig$
DECLARE
  p        record;
  v_tenant constant text := 'company_id = (SELECT public.get_active_company_id())';
  v_reads  constant text := '(SELECT public.platform_reads_company_data())';
  v_writes constant text := '(SELECT public.platform_writes_company_data())';
  v_gate   constant text := '(SELECT public.current_role_permits(''income'', true))';
  v_where  text := v_tenant || ' AND ' || v_gate;
BEGIN
  FOR p IN
    SELECT policyname FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'abrechnung_handovers'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.abrechnung_handovers', p.policyname);
  END LOOP;

  EXECUTE format(
    'CREATE POLICY abrechnung_handovers_select ON public.abrechnung_handovers '
    'FOR SELECT TO authenticated USING (%s OR %s)', v_tenant, v_reads);
  EXECUTE format(
    'CREATE POLICY abrechnung_handovers_insert ON public.abrechnung_handovers '
    'FOR INSERT TO authenticated WITH CHECK ((%s) OR %s)', v_where, v_writes);
  EXECUTE format(
    'CREATE POLICY abrechnung_handovers_update ON public.abrechnung_handovers '
    'FOR UPDATE TO authenticated USING ((%s) OR %s) WITH CHECK ((%s) OR %s)',
    v_where, v_writes, v_where, v_writes);
  EXECUTE format(
    'CREATE POLICY abrechnung_handovers_delete ON public.abrechnung_handovers '
    'FOR DELETE TO authenticated USING ((%s) OR %s)', v_where, v_writes);

  DROP TRIGGER IF EXISTS refuse_read_only_context_write ON public.abrechnung_handovers;
  CREATE TRIGGER refuse_read_only_context_write
    BEFORE INSERT OR UPDATE OR DELETE ON public.abrechnung_handovers
    FOR EACH STATEMENT EXECUTE FUNCTION app_private.refuse_read_only_context_write();

  DROP TRIGGER IF EXISTS record_support_write ON public.abrechnung_handovers;
  EXECUTE format(
    'CREATE TRIGGER record_support_write '
    'AFTER INSERT OR UPDATE OR DELETE ON public.abrechnung_handovers '
    'FOR EACH ROW WHEN (current_setting(%L, true) <> %L) '
    'EXECUTE FUNCTION app_private.record_support_write()',
    'app_private.support_write_context', '');
END $mig$;

REVOKE ALL ON FUNCTION app_private.abrechnung_handovers_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.abrechnung_handovers FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.abrechnung_handovers TO authenticated;
GRANT SELECT ON TABLE public.abrechnung_handovers TO service_role;

DO $check$
DECLARE
  v_pol  text;
  v_cmd  text;
  v_src  text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.abrechnung_handovers'::regclass) THEN
    RAISE EXCEPTION 'abrechnung_handovers self-check: RLS is off';
  END IF;
  SELECT string_agg(policyname, ',' ORDER BY policyname) INTO v_pol
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'abrechnung_handovers';
  IF v_pol IS DISTINCT FROM
     'abrechnung_handovers_delete,abrechnung_handovers_insert,abrechnung_handovers_select,abrechnung_handovers_update' THEN
    RAISE EXCEPTION 'abrechnung_handovers self-check: policies are %', v_pol;
  END IF;
  -- every write asks the income page and the tenant term
  FOR v_cmd IN SELECT unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) LOOP
    SELECT coalesce(qual, '') || ' ' || coalesce(with_check, '') INTO v_src
      FROM pg_policies WHERE schemaname = 'public' AND tablename = 'abrechnung_handovers' AND cmd = v_cmd;
    IF v_src !~ 'current_role_permits\(''income''' OR v_src !~ 'get_active_company_id' THEN
      RAISE EXCEPTION 'abrechnung_handovers self-check: the % policy lost the income page or the tenant term', v_cmd;
    END IF;
  END LOOP;
  IF (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'abrechnung_handovers' AND cmd = 'UPDATE')
     IS DISTINCT FROM
     (SELECT with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'abrechnung_handovers' AND cmd = 'UPDATE') THEN
    RAISE EXCEPTION 'abrechnung_handovers self-check: UPDATE USING and WITH CHECK differ';
  END IF;
  IF has_table_privilege('anon', 'public.abrechnung_handovers', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'abrechnung_handovers self-check: anon holds a privilege';
  END IF;
  IF has_table_privilege('service_role', 'public.abrechnung_handovers', 'INSERT,UPDATE,DELETE')
     OR NOT has_table_privilege('service_role', 'public.abrechnung_handovers', 'SELECT') THEN
    RAISE EXCEPTION 'abrechnung_handovers self-check: service_role must only read';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.abrechnung_handovers'::regclass
         AND tgname IN ('refuse_read_only_context_write', 'record_support_write')) <> 2 THEN
    RAISE EXCEPTION 'abrechnung_handovers self-check: a context trigger is missing';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'app_private.abrechnung_handovers_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'abrechnung_handovers self-check: the guard must be SECURITY INVOKER';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'app_private.abrechnung_handovers_guard()'::regprocedure;
  -- authenticated holds no USAGE on app_private, so the guard may not name it
  IF v_src ~* 'app_private\.' THEN
    RAISE EXCEPTION 'abrechnung_handovers self-check: the guard names app_private';
  END IF;
  -- the till is untouched: nothing here references the ledger tables
  IF v_src ~* 'cash_movements|salary_payments|salary_cash_receipts' THEN
    RAISE EXCEPTION 'abrechnung_handovers self-check: the guard reaches the till';
  END IF;
  RAISE NOTICE 'abrechnung_handovers self-check: passed';
END $check$;
