-- ════════════════════════════════════════════════════════════════════════════
--  20261109100000_receipt_business_date.sql
--
--  A Beleg whose printed time is before 04:00 counts on the PREVIOUS calendar
--  day, everywhere a receipt is counted (owner's decision, 09.11.2026; it
--  applies to every receipt that has a time, old ones included).
--
--  Why: a fuel receipt dated Monday 00:05, sent from the driver app, counted in
--  the new week. Uber income is already dated by a 04:00 operating day, so the
--  receipts were the half of "Abzugeben = Bargeld - Belege" that used midnight.
--
--  The rule, exactly. business date = date - 1 when receipt_time is NOT NULL
--  and strictly before 04:00:00 (03:59:59 moves, 04:00:00 stays); otherwise
--  date. receipt_time is the wall-clock time printed on the Beleg, so there is
--  no time-zone conversion. What a screen shows as the Beleg's date and time
--  does not change; only the day, week, month and till it counts in.
--
--  1. public.receipt_business_date(date, time): the rule, once. IMMUTABLE
--     because a generated column needs it. EXECUTE is even across anon,
--     authenticated and service_role: it reads nothing, and an unevenly
--     granted sql function is a plan-cache hazard (CLAUDE.md).
--  2. receipts.business_date: GENERATED ALWAYS ... STORED, so no writer can
--     forget it and none can set it. Adding it rewrites the table once.
--  3. Every SQL reader that filters or groups receipts by date, restated from
--     its NEWEST definition with the receipt date references swapped, and
--     nothing else changed (owner, SECURITY mode, search_path and grants are
--     kept by CREATE OR REPLACE):
--       abrechnung_weekly (view; 20260402065740, security_invoker kept)
--       abrechnung_week_figures (20261003120000)
--       abrechnung_reminder_facts (20261015120000)
--     get_weekly_abrechnung and its three siblings read the view and need no
--     change. get_current_cash_balance and recalculate_all_balances sum or
--     order receipts without a date window and stay as they are.
--  4. app_private.record_receipt_edit (20261027160000) logs every changed
--     column generically. business_date is derived, so one edit of date or
--     time would have written a second, spurious row for it; it is skipped.
--
--  Only abrechnung_deliveries is frozen: a mail already sent stays as sent.
--  abrechnung_handovers stores an amount per week, but the browser derives its
--  status (given, partial, open) from that amount against the live
--  bar_zuruck. A Beleg printed between 00:00 and 03:59 on a Monday moves into
--  the week before, which lowers that week's bar_zuruck, so a week already
--  settled can re-derive as overpaid or partial on deploy. The same goes for a
--  weekly_cash_difference salary payment entered against the old figure. That
--  follows from the owner's rule (old receipts included) and is not undone.
--
--  Backward compatible (a new column and a swapped reference), so no
--  SCHEMA_EPOCH bump. A restore that writes every column of a dumped receipt
--  must leave business_date out: a generated column cannot be written.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. the rule ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.receipt_business_date(p_date date, p_time time)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $fn$
  SELECT CASE WHEN p_time IS NOT NULL AND p_time < time '04:00'
              THEN p_date - 1 ELSE p_date END
$fn$;

COMMENT ON FUNCTION public.receipt_business_date(date, time) IS
  'The day a Beleg counts on: the day before when the printed time is before '
  '04:00:00, else the printed date. NULL time keeps the date. Twin of '
  'receiptBusinessDate() in src/utils/receiptBusinessDate.ts.';

REVOKE ALL ON FUNCTION public.receipt_business_date(date, time) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receipt_business_date(date, time)
  TO anon, authenticated, service_role;

-- ─── 2. the column ──────────────────────────────────────────────────────────

ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS business_date date
  GENERATED ALWAYS AS (public.receipt_business_date(date, receipt_time)) STORED;

COMMENT ON COLUMN public.receipts.business_date IS
  'Derived: the day this Beleg counts on (receipt_business_date(date, '
  'receipt_time)). Not writable. Every week, month and till figure groups by '
  'this column; the screens still show date.';

CREATE INDEX IF NOT EXISTS idx_receipts_company_business_date
  ON public.receipts (company_id, business_date);

-- ─── 3. the readers ─────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.abrechnung_weekly
WITH (security_invoker = true) AS
WITH weekly_receipts AS (
  SELECT
    bm.year,
    bm.month,
    get_business_week_number(r.business_date, bm.month, bm.year) AS week_number,
    r.driver_name,
    COUNT(*)::bigint AS anzahl_belege,
    COALESCE(SUM(r.expense), 0)::numeric AS ausgegebene_bargeld
  FROM receipts r
  CROSS JOIN LATERAL get_business_month(r.business_date) AS bm
  WHERE r.payment_method = 'bar'
  GROUP BY
    bm.year,
    bm.month,
    get_business_week_number(r.business_date, bm.month, bm.year),
    r.driver_name
),
weekly_income AS (
  SELECT
    bm.year,
    bm.month,
    get_business_week_number(i.date, bm.month, bm.year) AS week_number,
    i.driver_name,
    COALESCE(SUM(i.amount), 0)::numeric AS bargeld_income
  FROM income i
  CROSS JOIN LATERAL get_business_month(i.date) AS bm
  WHERE i.type = 'bargeld'
  GROUP BY
    bm.year,
    bm.month,
    get_business_week_number(i.date, bm.month, bm.year),
    i.driver_name
)
SELECT
  COALESCE(wr.year, wi.year) AS year,
  COALESCE(wr.month, wi.month) AS month,
  COALESCE(wr.week_number, wi.week_number) AS week_number,
  COALESCE(wr.driver_name, wi.driver_name) AS driver_name,
  COALESCE(wr.anzahl_belege, 0) AS anzahl_belege,
  COALESCE(wr.ausgegebene_bargeld, 0) AS ausgegebene_bargeld,
  COALESCE(wi.bargeld_income, 0) AS bargeld,
  (COALESCE(wi.bargeld_income, 0) - COALESCE(wr.ausgegebene_bargeld, 0)) AS bar_zuruck
FROM weekly_receipts wr
FULL JOIN weekly_income wi
  ON wr.year = wi.year
  AND wr.month = wi.month
  AND wr.week_number = wi.week_number
  AND wr.driver_name = wi.driver_name
ORDER BY
  COALESCE(wr.year, wi.year) DESC,
  COALESCE(wr.month, wi.month) DESC,
  COALESCE(wr.week_number, wi.week_number) DESC,
  COALESCE(wr.driver_name, wi.driver_name);

CREATE OR REPLACE FUNCTION public.abrechnung_week_figures(
  p_company_id  uuid,
  p_week_monday date
)
RETURNS TABLE (
  driver_name         text,
  anzahl_belege       bigint,
  ausgegebene_bargeld numeric,
  bargeld             numeric,
  bar_zuruck          numeric,
  tanken_brutto       numeric,
  umsatz_netto        numeric,
  match_count         bigint,
  driver_id           uuid,
  driver_email        text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_company_id IS NULL OR p_week_monday IS NULL THEN
    RAISE EXCEPTION 'abrechnung_week_figures: company and week are required'
      USING ERRCODE = '22023';
  END IF;
  IF EXTRACT(dow FROM p_week_monday) <> 1 THEN
    RAISE EXCEPTION 'abrechnung_week_figures: the week must be named by its Monday'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH rec AS (
    SELECT r.driver_name AS dn, count(*)::bigint AS n,
           COALESCE(sum(r.expense), 0)::numeric AS spent
      FROM public.receipts r
     WHERE r.company_id = p_company_id
       AND r.payment_method = 'bar'
       AND r.business_date BETWEEN p_week_monday AND p_week_monday + 6
     GROUP BY r.driver_name
  ),
  cash AS (
    SELECT i.driver_name AS dn, COALESCE(sum(i.amount), 0)::numeric AS taken
      FROM public.income i
     WHERE i.company_id = p_company_id
       AND i.type = 'bargeld'
       AND i.date BETWEEN p_week_monday AND p_week_monday + 6
     GROUP BY i.driver_name
  ),
  rows_ AS (
    SELECT COALESCE(rec.dn, cash.dn) AS dn,
           COALESCE(rec.n, 0)::bigint AS n,
           COALESCE(rec.spent, 0)::numeric AS spent,
           COALESCE(cash.taken, 0)::numeric AS taken
      FROM rec FULL JOIN cash ON rec.dn = cash.dn
  ),
  tank AS (
    SELECT r.driver_name AS dn, COALESCE(sum(r.expense), 0)::numeric AS t
      FROM public.receipts r
     WHERE r.company_id = p_company_id
       AND lower(btrim(r.description)) = 'tanken'
       AND r.business_date BETWEEN p_week_monday AND p_week_monday + 6
     GROUP BY r.driver_name
  ),
  umsatz AS (
    SELECT i.driver_name AS dn, COALESCE(sum(i.amount), 0)::numeric AS u
      FROM public.income i
     WHERE i.company_id = p_company_id
       AND i.type IN ('umsatz', 'aktionen')
       AND i.date BETWEEN p_week_monday AND p_week_monday + 6
     GROUP BY i.driver_name
  ),
  keyed AS (
    SELECT d.id AS did, d.email AS demail, d.status AS dstatus,
           lower(regexp_replace(btrim(d.name), '\s+', ' ', 'g')) AS k
      FROM public.drivers d
     WHERE d.company_id = p_company_id
  ),
  counted AS (
    SELECT keyed.k, count(*)::bigint AS c FROM keyed GROUP BY keyed.k
  )
  SELECT rows_.dn, rows_.n, rows_.spent, rows_.taken, (rows_.taken - rows_.spent),
         COALESCE(tank.t, 0), COALESCE(umsatz.u, 0),
         COALESCE(counted.c, 0),
         CASE WHEN counted.c = 1 THEN keyed.did END,
         CASE WHEN counted.c = 1 AND keyed.dstatus = 'active'
                   AND btrim(COALESCE(keyed.demail, '')) <> ''
              THEN btrim(keyed.demail) END
    FROM rows_
    LEFT JOIN tank    ON tank.dn   = rows_.dn
    LEFT JOIN umsatz  ON umsatz.dn = rows_.dn
    LEFT JOIN counted ON counted.k = lower(regexp_replace(btrim(rows_.dn), '\s+', ' ', 'g'))
    LEFT JOIN keyed   ON keyed.k   = counted.k AND counted.c = 1
   ORDER BY rows_.dn;
END $fn$;

CREATE OR REPLACE FUNCTION public.abrechnung_reminder_facts(
  p_company_id  uuid,
  p_week_monday date
)
RETURNS TABLE (
  driver_id        uuid,
  driver_name      text,
  driver_status    text,
  driver_email     text,
  match_count      bigint,
  umsatz_amount    numeric,
  bargeld_rows     bigint,
  bar_receipt_rows bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_company_id IS NULL OR p_week_monday IS NULL THEN
    RAISE EXCEPTION 'abrechnung_reminder_facts: company and week are required'
      USING ERRCODE = '22023';
  END IF;
  IF EXTRACT(dow FROM p_week_monday) <> 1 THEN
    RAISE EXCEPTION 'abrechnung_reminder_facts: the week must be named by its Monday'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH keyed AS (
    SELECT d.id AS did, d.name AS dname, d.status AS dstatus, d.email AS demail,
           lower(regexp_replace(btrim(d.name), '\s+', ' ', 'g')) AS k
      FROM public.drivers d
     WHERE d.company_id = p_company_id
  ),
  counted AS (
    SELECT keyed.k, count(*)::bigint AS c FROM keyed GROUP BY keyed.k
  ),
  inc AS (
    SELECT lower(regexp_replace(btrim(i.driver_name), '\s+', ' ', 'g')) AS k,
           COALESCE(sum(i.amount) FILTER (WHERE i.type = 'umsatz'), 0)::numeric AS u,
           (count(*) FILTER (WHERE i.type = 'bargeld'))::bigint AS b
      FROM public.income i
     WHERE i.company_id = p_company_id
       AND i.date BETWEEN p_week_monday AND p_week_monday + 6
     GROUP BY 1
  ),
  rec AS (
    SELECT lower(regexp_replace(btrim(r.driver_name), '\s+', ' ', 'g')) AS k,
           (count(*) FILTER (WHERE r.payment_method = 'bar'))::bigint AS n
      FROM public.receipts r
     WHERE r.company_id = p_company_id
       AND r.business_date BETWEEN p_week_monday AND p_week_monday + 6
     GROUP BY 1
  )
  SELECT keyed.did, keyed.dname, keyed.dstatus,
         NULLIF(btrim(COALESCE(keyed.demail, '')), ''),
         counted.c,
         COALESCE(inc.u, 0), COALESCE(inc.b, 0), COALESCE(rec.n, 0)
    FROM keyed
    JOIN counted ON counted.k = keyed.k
    LEFT JOIN inc ON inc.k = keyed.k
    LEFT JOIN rec ON rec.k = keyed.k
   ORDER BY keyed.dname, keyed.did;
END $fn$;

-- ─── 4. the edit log skips the derived column ───────────────────────────────

CREATE OR REPLACE FUNCTION app_private.record_receipt_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_editor uuid;
  v_old    jsonb;
  v_new    jsonb;
  v_key    text;
BEGIN
  -- auth.uid(), exactly as the policies resolve the caller. NULL — a
  -- migration, a psql backfill, the service role — is not a person's edit.
  v_editor := auth.uid();
  IF v_editor IS NULL THEN
    RETURN NULL;
  END IF;

  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);

  -- Generic on purpose: a receipts column added later is logged without this
  -- function being restated. id and company_id cannot change (the policies
  -- pin the tenant on both sides); the two clock columns are bookkeeping.
  -- business_date is derived from date and receipt_time (20261109100000): a
  -- change to either logs itself, and logging the derived value too would
  -- write a second, spurious row for one edit.
  FOR v_key IN
    SELECT k FROM jsonb_object_keys(v_new) AS t(k)
     WHERE k NOT IN ('id', 'company_id', 'created_at', 'updated_at')
       AND k <> 'business_date'
  LOOP
    IF (v_old -> v_key) IS DISTINCT FROM (v_new -> v_key) THEN
      INSERT INTO public.receipt_edits
             (company_id, receipt_id, action, field, old_value, new_value, edited_by)
      VALUES (OLD.company_id, OLD.id, 'change', v_key,
              v_old ->> v_key, v_new ->> v_key, v_editor);
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

-- ─── 5. self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_def  text;
  v_cols text;
BEGIN
  -- 1. the rule, at the edges the owner named.
  IF public.receipt_business_date(date '2026-11-09', time '00:05') <> date '2026-11-08'
     OR public.receipt_business_date(date '2026-11-09', time '03:59:59') <> date '2026-11-08'
     OR public.receipt_business_date(date '2026-11-09', time '04:00') <> date '2026-11-09'
     OR public.receipt_business_date(date '2026-11-09', time '00:00') <> date '2026-11-08'
     OR public.receipt_business_date(date '2026-11-09', NULL) <> date '2026-11-09'
     OR public.receipt_business_date(date '2026-12-01', time '01:00') <> date '2026-11-30'
     OR public.receipt_business_date(date '2027-01-01', time '01:00') <> date '2026-12-31' THEN
    RAISE EXCEPTION 'receipt-business-date self-check 1: the rule is wrong';
  END IF;

  -- 2. the function: immutable, not a definer, executable by all three API
  --    roles (uneven grants on a sql function are the plan-cache hazard).
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.receipt_business_date(date,time)'::regprocedure
                    AND provolatile = 'i' AND NOT prosecdef) THEN
    RAISE EXCEPTION 'receipt-business-date self-check 2: not IMMUTABLE or a definer';
  END IF;
  IF NOT (has_function_privilege('anon', 'public.receipt_business_date(date,time)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.receipt_business_date(date,time)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.receipt_business_date(date,time)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'receipt-business-date self-check 2: EXECUTE is not even across the API roles';
  END IF;

  -- 3. the column is generated and stored.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.receipts'::regclass AND attname = 'business_date'
                    AND attgenerated = 's' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'receipt-business-date self-check 3: receipts.business_date is not a stored generated column';
  END IF;
  -- 3b. ...and it is generated by the rule, not by some other expression.
  IF NOT EXISTS (SELECT 1 FROM pg_attrdef d
                   JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
                  WHERE d.adrelid = 'public.receipts'::regclass AND a.attname = 'business_date'
                    AND pg_get_expr(d.adbin, d.adrelid) LIKE '%receipt_business_date(%') THEN
    RAISE EXCEPTION 'receipt-business-date self-check 3b: business_date is not generated by receipt_business_date';
  END IF;
  -- 3c. ...and the readers have their index.
  IF to_regclass('public.idx_receipts_company_business_date') IS NULL THEN
    RAISE EXCEPTION 'receipt-business-date self-check 3c: idx_receipts_company_business_date is missing';
  END IF;

  -- 4. no restated body still compares the printed receipt date.
  v_def := pg_get_viewdef('public.abrechnung_weekly'::regclass);
  IF position('r.date' IN v_def) > 0 OR position('r.business_date' IN v_def) = 0 THEN
    RAISE EXCEPTION 'receipt-business-date self-check 4: abrechnung_weekly does not read business_date';
  END IF;
  FOR v_def IN
    SELECT pg_get_functiondef(p.oid) FROM pg_proc p
     WHERE p.oid IN ('public.abrechnung_week_figures(uuid,date)'::regprocedure,
                     'public.abrechnung_reminder_facts(uuid,date)'::regprocedure)
  LOOP
    IF position('r.date' IN v_def) > 0 OR position('r.business_date' IN v_def) = 0 THEN
      RAISE EXCEPTION 'receipt-business-date self-check 4: a figures function still reads r.date';
    END IF;
  END LOOP;

  -- 5. the view's column list and option are unchanged.
  SELECT string_agg(attname::text, ',' ORDER BY attnum) INTO v_cols
    FROM pg_attribute
   WHERE attrelid = 'public.abrechnung_weekly'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM 'year,month,week_number,driver_name,anzahl_belege,ausgegebene_bargeld,bargeld,bar_zuruck' THEN
    RAISE EXCEPTION 'receipt-business-date self-check 5: abrechnung_weekly columns changed: %', v_cols;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.abrechnung_weekly'::regclass
                    AND 'security_invoker=true' = ANY (coalesce(reloptions, '{}'))) THEN
    RAISE EXCEPTION 'receipt-business-date self-check 5: abrechnung_weekly lost security_invoker';
  END IF;

  -- 6. the figures functions keep their definer mode, pinned path and grants.
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid IN ('public.abrechnung_week_figures(uuid,date)'::regprocedure,
                     'public.abrechnung_reminder_facts(uuid,date)'::regprocedure)
       AND (NOT p.prosecdef
            OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')
            OR has_function_privilege('anon', p.oid, 'EXECUTE')
            OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
            OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'receipt-business-date self-check 6: a figures function lost its mode or grants';
  END IF;

  -- 7. the edit log skips the derived column and kept everything else.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'app_private' AND p.proname = 'record_receipt_edit';
  IF position('business_date' IN v_def) = 0
     OR position('auth.uid()' IN v_def) = 0
     OR position('IS DISTINCT FROM' IN v_def) = 0
     OR position('''id'', ''company_id'', ''created_at'', ''updated_at''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'receipt-business-date self-check 7: record_receipt_edit is wrong';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'app_private' AND p.proname = 'record_receipt_edit' AND p.prosecdef)
     OR has_function_privilege('authenticated', 'app_private.record_receipt_edit()', 'EXECUTE') THEN
    RAISE EXCEPTION 'receipt-business-date self-check 7: record_receipt_edit lost its mode or grants';
  END IF;

  RAISE NOTICE 'receipt business date: self-checks passed';
END;
$check$;
