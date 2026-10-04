/*
  # The Abrechnung on a schedule: when it is mailed, to whom, and the record of what was

  ## What the owner asked for (03.10.2026)

    "the admin shall be able to select a time when the Abrechnung will be sent
     for each driver. example: company x in the settings selects Monday 8:00 am
     so the emails will be sent to the drivers automatically every Monday at
     8:00 am"

    "we need to add one more thing here which is to send the summary to the
     manager so he can see each driver and his Abrechnung"

  ## What this adds

    public.abrechnung_schedules         one row per company: two switches, a
                                        weekday and a time of day (Europe/Berlin)
    public.abrechnung_deliveries        one row per mail the job has claimed, and
                                        the whole dedupe rule
    public.abrechnung_schedule_candidates(...)   the companies with a schedule on, paged
    public.abrechnung_week_figures(...)          one week's figures, one row per driver
    public.abrechnung_delivery_claim(...)        claim one mail, or NULL
    public.abrechnung_delivery_settle(...)       record how the send went

  The four functions are `service_role` only. The caller is the edge function
  `notify-expiries` with `{"job":"abrechnung"}`, called by a host cron line with
  the service key; the decision of what is due lives in
  supabase/functions/_shared/abrechnung-schedule-core.ts so it can be
  unit-tested without a database. NOTHING CALLS IT until the owner installs the
  cron line by hand (HANDOFF.md).

  ## Decision 1 - the schedule is per company, and it is a time, not a cron string

  A weekday (0 = Sunday ... 6 = Saturday, the numbering PostgreSQL's
  EXTRACT(dow) and JavaScript's getDay() share), a time of day and Europe/Berlin.
  Two independent switches: the drivers' mails, and the manager's summary. Both
  default to off, so applying this migration changes nothing for anybody.

  ## Decision 2 - what is sent is the most recently COMPLETED week

  Business weeks run Monday to Sunday. A send on any weekday covers the week
  before the one that contains the send day, so a Sunday-evening schedule does
  not mail a week that has not finished. The week is named by its Monday.

  ## Decision 3 - the dedupe key is the week the mail is ABOUT, never the day of the run

  `UNIQUE (company_id, kind, target_id, period_key)`, where `period_key` is the
  Monday of the week the figures are about, `target_id` the driver for a driver
  mail and the company for the manager's summary. So two cron runs overlapping,
  a cron line installed twice and a run repeated an hour later all find the
  occurrence already claimed. The job claims BEFORE it sends and never retries:
  a crash between the two loses a mail (visible as `mail_sent IS NULL`) rather
  than repeating it.

  ## Decision 4 - a schedule that was just changed does not fire for the past

  `armed_at` is stamped whenever a switch, the weekday or the time changes, and
  the job only sends an occurrence that falls AFTER it. Without it, an
  administrator who switches the schedule on at Tuesday noon for "Monday 08:00"
  would have last Monday's mail go out within minutes.

  ## Decision 5 - the figures are the Abrechnung screen's, computed once more here

  The screen reads `abrechnung_weekly` under the caller's own RLS, and a cron
  line has no caller. `abrechnung_week_figures` reproduces that view's rule for
  one company and one week and the screen's Tankenquote reads: Belege and Bargeld
  as the view groups them (`payment_method = 'bar'` receipts, `bargeld` income),
  Tankenquote over receipts whose description is `Tanken` and income of type
  `umsatz` and `aktionen`. A second implementation is the cost of there being no
  caller; the parity with the screen is stated here, not proved by a kit file.

  ## Decision 6 - a driver's address is read here, never taken from a request

  The function returns it from `public.drivers`, matched to the Abrechnung row's
  name the way `src/utils/driverRecipients.ts` does (case and inner spacing are
  noise, nothing else is): a name two drivers share is never resolved by
  picking one, and the row says how many matched so the job can skip it. A driver
  who is not `active` is not mailed.

  ## Why the schedule's writes ask `is_company_admin()`

  Same precedent as `notification_settings`, `trip_analysis_settings` and
  `driver_month_budget`: the schedule decides that a company's drivers receive
  their money figures by mail, which is more than any page's edit right.

  ## No SCHEMA_EPOCH bump

  New tables and functions only. The previous release never reads them.
*/

-- ─── 1. The schedule ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.abrechnung_schedules (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  driver_mail_enabled     boolean     NOT NULL DEFAULT false,
  manager_summary_enabled boolean     NOT NULL DEFAULT false,
  -- 0 = Sunday ... 6 = Saturday.
  weekday                 smallint    NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6),
  -- A Europe/Berlin wall-clock time, whole minutes: the job runs every few.
  send_time               time(0)     NOT NULL DEFAULT '08:00',
  -- Decision 4. Stamped by the trigger, never taken from the client.
  armed_at                timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid        NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT abrechnung_schedules_one_per_company UNIQUE (company_id)
);

COMMENT ON TABLE public.abrechnung_schedules IS
  'When a company''s weekly Abrechnung is mailed to its drivers and summarised to its administrators: weekday 0-6 (0 = Sunday), a Europe/Berlin time of day, two switches. Always the most recently completed week (20261003120000).';

CREATE OR REPLACE FUNCTION app_private.abrechnung_schedules_stamp()
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
    NEW.armed_at   := now();
  ELSE
    NEW.created_at := OLD.created_at;
    -- Decision 4: any change to what the schedule does re-arms it, and
    -- nothing else does (a touch that changes nothing keeps the old moment).
    IF NEW.driver_mail_enabled        IS DISTINCT FROM OLD.driver_mail_enabled
       OR NEW.manager_summary_enabled IS DISTINCT FROM OLD.manager_summary_enabled
       OR NEW.weekday                 IS DISTINCT FROM OLD.weekday
       OR NEW.send_time               IS DISTINCT FROM OLD.send_time THEN
      NEW.armed_at := now();
    ELSE
      NEW.armed_at := OLD.armed_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS abrechnung_schedules_stamp ON public.abrechnung_schedules;
CREATE TRIGGER abrechnung_schedules_stamp
  BEFORE INSERT OR UPDATE ON public.abrechnung_schedules
  FOR EACH ROW EXECUTE FUNCTION app_private.abrechnung_schedules_stamp();

-- ─── 2. The record of what was claimed ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.abrechnung_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  -- The driver for a driver mail, the company itself for the summary. No
  -- foreign key: a driver deleted after the mail must not take its record along.
  target_id       uuid NOT NULL,
  -- The Monday of the week the mail is about: decision 3.
  period_key      text NOT NULL,
  claimed_at      timestamptz NOT NULL DEFAULT now(),
  settled_at      timestamptz,
  -- NULL while claimed and not yet settled; false when the send failed.
  mail_sent       boolean,
  recipient_count integer NOT NULL DEFAULT 0,
  CONSTRAINT abrechnung_deliveries_kind_check
    CHECK (kind IN ('driver_abrechnung', 'manager_summary')),
  CONSTRAINT abrechnung_deliveries_period_check
    CHECK (period_key ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT abrechnung_deliveries_recipients_check
    CHECK (recipient_count >= 0),
  CONSTRAINT abrechnung_deliveries_once
    UNIQUE (company_id, kind, target_id, period_key)
);

CREATE INDEX IF NOT EXISTS abrechnung_deliveries_company_idx
  ON public.abrechnung_deliveries (company_id, claimed_at DESC);

COMMENT ON TABLE public.abrechnung_deliveries IS
  'One row per scheduled Abrechnung mail the job has claimed. The unique constraint is the dedupe rule: one mail per driver (or per company summary) per week it is about.';

-- ─── 3. The tenant shape ────────────────────────────────────────────────────

ALTER TABLE public.abrechnung_schedules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.abrechnung_deliveries ENABLE ROW LEVEL SECURITY;

DO $mig$
DECLARE
  v_tbl    text;
  p        record;
  v_tenant constant text := 'company_id = (SELECT public.get_active_company_id())';
  v_reads  constant text := '(SELECT public.platform_reads_company_data())';
  v_writes constant text := '(SELECT public.platform_writes_company_data())';
  v_admin  constant text := '(SELECT public.is_company_admin())';
  v_where  text := v_tenant || ' AND ' || v_admin;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['abrechnung_schedules', 'abrechnung_deliveries'] LOOP
    FOR p IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, v_tbl);
    END LOOP;

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s OR %s)',
      v_tbl || '_select', v_tbl, v_tenant, v_reads);
  END LOOP;

  -- The schedule: the administrator writes it, all four commands. The UPDATE
  -- states one predicate as USING and as WITH CHECK, which is what refuses a
  -- move between companies.
  EXECUTE format(
    'CREATE POLICY abrechnung_schedules_insert ON public.abrechnung_schedules '
    'FOR INSERT TO authenticated WITH CHECK ((%s) OR %s)', v_where, v_writes);
  EXECUTE format(
    'CREATE POLICY abrechnung_schedules_update ON public.abrechnung_schedules '
    'FOR UPDATE TO authenticated USING ((%s) OR %s) WITH CHECK ((%s) OR %s)',
    v_where, v_writes, v_where, v_writes);
  EXECUTE format(
    'CREATE POLICY abrechnung_schedules_delete ON public.abrechnung_schedules '
    'FOR DELETE TO authenticated USING ((%s) OR %s)', v_where, v_writes);

  -- The deliveries have SELECT and nothing else: the job writes them through
  -- two SECURITY DEFINER functions. Like notification_deliveries, they still
  -- carry both context triggers, because the rule is keyed on the policies
  -- naming get_active_company_id(), not on who writes today.
  FOREACH v_tbl IN ARRAY ARRAY['abrechnung_schedules', 'abrechnung_deliveries'] LOOP
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

-- ─── 4. The candidate query ─────────────────────────────────────────────────

/*
  The companies with a schedule switched on, one row each, paged.

  What is decided here is the hard boundary and the paging; what is due NOW is
  decided in TypeScript (abrechnung-schedule-core.ts), which is also where the
  Europe/Berlin arithmetic lives. The boundary is the notification job's -
  approved, and `status` active or trial - plus a live subscription or a running
  trial, because a company the app itself locks out must not mail its drivers
  through the lock: `subscriptionIsActive()` in src/utils/planState.ts, spelled
  once more.

  `sent` is what this company has claimed in the last 21 days, so the worker
  can tell a due occurrence from one already held without a call per driver.
*/
CREATE OR REPLACE FUNCTION public.abrechnung_schedule_candidates(
  p_limit integer DEFAULT 100,
  p_after uuid    DEFAULT NULL
)
RETURNS TABLE (
  company_id              uuid,
  company_name            text,
  driver_mail_enabled     boolean,
  manager_summary_enabled boolean,
  weekday                 smallint,
  send_time               text,
  armed_at                timestamptz,
  sent                    jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
DECLARE
  v_limit integer;
BEGIN
  IF p_limit IS NOT NULL AND (p_limit < 1 OR p_limit > 500) THEN
    RAISE EXCEPTION 'abrechnung_schedule_candidates: p_limit must be between 1 and 500'
      USING ERRCODE = '22023';
  END IF;
  v_limit := COALESCE(p_limit, 100);

  RETURN QUERY
  WITH page AS (
    SELECT c.id, c.name, s.driver_mail_enabled, s.manager_summary_enabled,
           s.weekday, s.send_time, s.armed_at
      FROM public.abrechnung_schedules s
      JOIN public.companies c ON c.id = s.company_id
     WHERE (s.driver_mail_enabled OR s.manager_summary_enabled)
       AND c.approval_status = 'approved'
       AND c.status IN ('active', 'trial')
       AND (
             (c.subscription_status = 'active'
              AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now()))
             OR (c.status = 'trial' AND c.trial_end IS NOT NULL AND c.trial_end > now())
           )
       AND (p_after IS NULL OR c.id > p_after)
     ORDER BY c.id
     LIMIT v_limit
  ),
  page_sent AS (
    SELECT d.company_id,
           jsonb_agg(jsonb_build_object(
             'kind',       d.kind,
             'target_id',  d.target_id,
             'period_key', d.period_key)) AS items
      FROM public.abrechnung_deliveries d
      JOIN page ON page.id = d.company_id
     WHERE d.claimed_at > now() - interval '21 days'
     GROUP BY d.company_id
  )
  SELECT page.id, page.name, page.driver_mail_enabled, page.manager_summary_enabled,
         page.weekday, to_char(page.send_time, 'HH24:MI'), page.armed_at,
         COALESCE(page_sent.items, '[]'::jsonb)
    FROM page
    LEFT JOIN page_sent ON page_sent.company_id = page.id
   ORDER BY page.id;
END $fn$;

-- ─── 5. One week's figures ──────────────────────────────────────────────────

/*
  The Abrechnung screen's rows for one company and one business week, with each
  driver's address read from `drivers` (decision 6).

  Rows exist for a driver name that has a `bar` receipt or `bargeld` income in
  the week - the rows `abrechnung_weekly` has, no more. `tanken_brutto` and
  `umsatz_netto` are the Tankenquote's two terms exactly as the screen reads
  them: receipts of any payment method whose trimmed description is `Tanken`
  (case-insensitive), and income of type `umsatz` or `aktionen`.

  The name match is `nameKey()` of driverRecipients.ts: trimmed, inner runs of
  whitespace collapsed, lower-cased. `match_count` is how many drivers of the
  company carry that key; the id and address are returned only for exactly one,
  and the address only for a driver who is `active` and has one.

  `p_week_monday` must be a Monday: anything else is a broken contract.
*/
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
       AND r.date BETWEEN p_week_monday AND p_week_monday + 6
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
       AND r.date BETWEEN p_week_monday AND p_week_monday + 6
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

-- ─── 6. Claiming and settling ───────────────────────────────────────────────

/*
  Claim one mail, or answer NULL because it is already claimed.

  The company boundary is checked again here, and not only in the candidate
  query: a claim is what makes a mail go out, and a company blocked since the
  plan was made must not become mailable through it. A driver target must
  belong to the company.
*/
CREATE OR REPLACE FUNCTION public.abrechnung_delivery_claim(
  p_company_id uuid,
  p_kind       text,
  p_target_id  uuid,
  p_period_key text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF p_company_id IS NULL OR p_target_id IS NULL THEN
    RAISE EXCEPTION 'abrechnung_delivery_claim: company and target are required'
      USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('driver_abrechnung', 'manager_summary') THEN
    RAISE EXCEPTION 'abrechnung_delivery_claim: unknown kind' USING ERRCODE = '22023';
  END IF;
  IF p_period_key IS NULL OR p_period_key !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'abrechnung_delivery_claim: period key must be YYYY-MM-DD'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.companies c
     WHERE c.id = p_company_id
       AND c.approval_status = 'approved'
       AND c.status IN ('active', 'trial')
  ) THEN
    RETURN NULL;
  END IF;

  IF p_kind = 'manager_summary' THEN
    IF p_target_id <> p_company_id THEN RETURN NULL; END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.drivers d
                     WHERE d.id = p_target_id AND d.company_id = p_company_id) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.abrechnung_deliveries (company_id, kind, target_id, period_key)
  VALUES (p_company_id, p_kind, p_target_id, p_period_key)
  ON CONFLICT ON CONSTRAINT abrechnung_deliveries_once DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END $fn$;

CREATE OR REPLACE FUNCTION public.abrechnung_delivery_settle(
  p_id              uuid,
  p_mail_sent       boolean,
  p_recipient_count integer
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_rows integer;
BEGIN
  IF p_id IS NULL OR p_mail_sent IS NULL THEN
    RAISE EXCEPTION 'abrechnung_delivery_settle: id and outcome are required'
      USING ERRCODE = '22023';
  END IF;
  IF p_recipient_count IS NULL OR p_recipient_count < 0 THEN
    RAISE EXCEPTION 'abrechnung_delivery_settle: recipient count must not be negative'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.abrechnung_deliveries
     SET mail_sent = p_mail_sent, recipient_count = p_recipient_count, settled_at = now()
   WHERE id = p_id AND settled_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $fn$;

-- ─── 7. Ownership and privileges ────────────────────────────────────────────

ALTER FUNCTION app_private.abrechnung_schedules_stamp()                  OWNER TO CURRENT_USER;
ALTER FUNCTION public.abrechnung_schedule_candidates(integer, uuid)      OWNER TO CURRENT_USER;
ALTER FUNCTION public.abrechnung_week_figures(uuid, date)                OWNER TO CURRENT_USER;
ALTER FUNCTION public.abrechnung_delivery_claim(uuid, text, uuid, text)  OWNER TO CURRENT_USER;
ALTER FUNCTION public.abrechnung_delivery_settle(uuid, boolean, integer) OWNER TO CURRENT_USER;

-- All of anon, authenticated and PUBLIC: Supabase's default privileges grant
-- EXECUTE on every new public function to anon too.
REVOKE ALL ON FUNCTION app_private.abrechnung_schedules_stamp()                  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.abrechnung_schedule_candidates(integer, uuid)      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.abrechnung_week_figures(uuid, date)                FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.abrechnung_delivery_claim(uuid, text, uuid, text)  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.abrechnung_delivery_settle(uuid, boolean, integer) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.abrechnung_schedule_candidates(integer, uuid)      TO service_role;
GRANT EXECUTE ON FUNCTION public.abrechnung_week_figures(uuid, date)                TO service_role;
GRANT EXECUTE ON FUNCTION public.abrechnung_delivery_claim(uuid, text, uuid, text)  TO service_role;
GRANT EXECUTE ON FUNCTION public.abrechnung_delivery_settle(uuid, boolean, integer) TO service_role;

REVOKE ALL ON TABLE public.abrechnung_schedules  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.abrechnung_deliveries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.abrechnung_schedules TO authenticated;
GRANT SELECT ON TABLE public.abrechnung_deliveries TO authenticated;

-- ─── 8. Self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_tbl   text;
  v_wrong text;
  v_n     integer;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['abrechnung_schedules', 'abrechnung_deliveries'] LOOP
    -- 1. RLS on.
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', v_tbl)::regclass) THEN
      RAISE EXCEPTION 'abrechnung self-check: % has row level security off', v_tbl;
    END IF;

    -- 2. Every policy is in the business shape: the active-company helper, no
    --    user_profiles and no is_user_super_admin, an administrator on every
    --    write, UPDATE with one predicate as USING and WITH CHECK.
    SELECT string_agg(format('%s (%s)', p.policyname, p.cmd), ', ') INTO v_wrong
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = v_tbl
       AND NOT (
             p.policyname = v_tbl || '_' || lower(p.cmd)
         AND p.roles = ARRAY['authenticated']::name[]
         AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'get_active_company_id'
         AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'user_profiles|is_user_super_admin'
         AND (p.cmd = 'SELECT' OR (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'is_company_admin')
         AND (p.cmd <> 'UPDATE' OR p.qual = p.with_check));
    IF v_wrong IS NOT NULL THEN
      RAISE EXCEPTION 'abrechnung self-check: % has a policy outside the business shape: %', v_tbl, v_wrong;
    END IF;
  END LOOP;

  -- The schedule carries four policies; the deliveries only SELECT.
  IF (SELECT count(DISTINCT p.cmd) FROM pg_policies p
       WHERE p.schemaname = 'public' AND p.tablename = 'abrechnung_schedules') <> 4
     OR (SELECT count(*) FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = 'abrechnung_schedules') <> 4 THEN
    RAISE EXCEPTION 'abrechnung self-check: abrechnung_schedules must carry exactly one SELECT, INSERT, UPDATE and DELETE policy';
  END IF;
  IF (SELECT count(*) FROM pg_policies p
       WHERE p.schemaname = 'public' AND p.tablename = 'abrechnung_deliveries') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies p
                     WHERE p.schemaname = 'public' AND p.tablename = 'abrechnung_deliveries'
                       AND p.cmd = 'SELECT') THEN
    RAISE EXCEPTION 'abrechnung self-check: abrechnung_deliveries is written by the job only, so SELECT is the one policy it may carry';
  END IF;

  -- 3. Both context triggers on both tables, in the shape the 39 carry.
  FOREACH v_tbl IN ARRAY ARRAY['abrechnung_schedules', 'abrechnung_deliveries'] LOOP
    SELECT count(*) INTO v_n FROM pg_trigger g
     WHERE g.tgrelid = format('public.%I', v_tbl)::regclass AND NOT g.tgisinternal
       AND ((g.tgname = 'refuse_read_only_context_write' AND g.tgtype = 30 AND g.tgenabled = 'O')
            OR (g.tgname = 'record_support_write' AND g.tgtype = 29 AND g.tgenabled = 'O'
                AND g.tgqual IS NOT NULL
                AND pg_get_triggerdef(g.oid) ~ 'app_private\.support_write_context'));
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'abrechnung self-check: % must carry both context triggers in the shape the 39 tables carry', v_tbl;
    END IF;
  END LOOP;

  -- 4. The stamp: a BEFORE INSERT OR UPDATE row trigger (tgtype 23).
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = 'public.abrechnung_schedules'::regclass
                    AND g.tgname = 'abrechnung_schedules_stamp'
                    AND NOT g.tgisinternal AND g.tgtype = 23 AND g.tgenabled = 'O') THEN
    RAISE EXCEPTION 'abrechnung self-check: the stamp must be an enabled BEFORE INSERT OR UPDATE row trigger';
  END IF;

  -- 5. Table privileges.
  IF has_table_privilege('anon', 'public.abrechnung_schedules', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('service_role', 'public.abrechnung_schedules', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('authenticated', 'public.abrechnung_schedules', 'TRUNCATE,REFERENCES,TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.abrechnung_schedules', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.abrechnung_schedules', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.abrechnung_schedules', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.abrechnung_schedules', 'DELETE') THEN
    RAISE EXCEPTION 'abrechnung self-check: abrechnung_schedules must be anon none, authenticated SELECT/INSERT/UPDATE/DELETE, service_role none';
  END IF;
  IF has_table_privilege('anon', 'public.abrechnung_deliveries', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('service_role', 'public.abrechnung_deliveries', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('authenticated', 'public.abrechnung_deliveries', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.abrechnung_deliveries', 'SELECT') THEN
    RAISE EXCEPTION 'abrechnung self-check: abrechnung_deliveries must be authenticated SELECT only, anon none, service_role none';
  END IF;

  -- 6. The four job functions: service_role alone, SECURITY DEFINER, plpgsql,
  --    pinned search_path.
  SELECT string_agg(v.sig, ', ') INTO v_wrong
    FROM (VALUES
      ('public.abrechnung_schedule_candidates(integer, uuid)'),
      ('public.abrechnung_week_figures(uuid, date)'),
      ('public.abrechnung_delivery_claim(uuid, text, uuid, text)'),
      ('public.abrechnung_delivery_settle(uuid, boolean, integer)')
    ) AS v(sig)
   WHERE has_function_privilege('anon',          to_regprocedure(v.sig), 'EXECUTE')
      OR has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE')
      OR NOT has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE');
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'abrechnung self-check: EXECUTE must be service_role only on %', v_wrong;
  END IF;

  SELECT string_agg(p.proname, ', ') INTO v_wrong
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('abrechnung_schedule_candidates', 'abrechnung_week_figures',
                       'abrechnung_delivery_claim', 'abrechnung_delivery_settle')
     AND (NOT p.prosecdef
          OR p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
          OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c
                          WHERE c LIKE 'search\_path=%'));
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'abrechnung self-check: % must be LANGUAGE plpgsql, SECURITY DEFINER with a pinned search_path', v_wrong;
  END IF;

  -- The stamp is a trigger function: definer, executable by no API role.
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'app_private.abrechnung_schedules_stamp()'::regprocedure)
     OR has_function_privilege('anon', 'app_private.abrechnung_schedules_stamp()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.abrechnung_schedules_stamp()', 'EXECUTE')
     OR has_function_privilege('service_role', 'app_private.abrechnung_schedules_stamp()', 'EXECUTE') THEN
    RAISE EXCEPTION 'abrechnung self-check: the stamp must be SECURITY DEFINER and executable by no API role';
  END IF;

  -- 7. The dedupe rule is a constraint, not a convention.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.abrechnung_deliveries'::regclass
       AND conname = 'abrechnung_deliveries_once' AND contype = 'u'
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(conkey) AS k(attnum)
              JOIN pg_attribute a ON a.attrelid = conrelid AND a.attnum = k.attnum)
           = ARRAY['company_id', 'kind', 'period_key', 'target_id']
  ) THEN
    RAISE EXCEPTION 'abrechnung self-check: the dedupe rule must be a UNIQUE constraint on (company_id, kind, target_id, period_key)';
  END IF;

  RAISE NOTICE 'abrechnung self-check: passed';
END $check$;
