/*
  # The Uber earnings pull on a schedule: one operating day, once, recorded

  ## The owner's request (15.10.2026) and what it reverses

    Pull Uber's earnings DAILY, on Uber's operating day (04:00 -> 04:00
    Europe/Berlin), automatically, in addition to the button.

  This REVERSES the owner's decision of 13.10.2026 ("no automation"), which the
  header of uber-earnings-pull and HANDOFF.md recorded. He is entitled to
  reverse it, and both places now say so. The button is unchanged and stays.

  ## What this adds

    public.uber_pull_schedules      one row per company: a switch, the time of day
                                    (Europe/Berlin) and a second switch for
                                    corrections
    public.uber_pull_runs           one row per (company, operating day, pass)
                                    the job has claimed: the whole dedupe rule
                                    AND the record a human reads
    public.uber_pull_candidates     the companies with the switch on, paged
    public.uber_pull_claim          claim one (day, pass), or NULL
    public.uber_pull_settle         record a pull that wrote nothing, and why
    public.income_import_uber_system  the system writer (decision 5)

  All four functions are service_role's alone. The caller is `notify-expiries`
  with {"job":"uber_pull"}, on the host cron line that ALREADY EXISTS (a run every ten minutes,
  one cron line per environment): no host change and no new edge function.

  ## Decision 1 - the schedule is its own table, not abrechnung_schedules

  abrechnung_schedules means "when the weekly Abrechnung is MAILED": a weekday,
  two mail switches, a candidate function that filters on those switches and a
  self-check that pins the table to that meaning. A daily income pull has no
  weekday and sends no mail. Adding columns would give one row two unrelated
  meanings and make the Abrechnung job read a table whose switches are not
  its own. The cost is one more table of the same tenant shape, which is
  cheaper than the coupling.

  ## Decision 2 - which day is pulled: the COMPLETED operating day

  Uber's operating day D runs from D 04:00 to D+1 04:00 (Europe/Berlin). A run
  pulls the most recent operating day that has COMPLETED, never the one still
  running: a half day would be imported as a whole one and then refused as an
  overlap when the full day is pulled. At wall time T the running day is T's
  date, or the day before when T is earlier than 04:00; the day to pull is the
  one before that. uber_pull_claim refuses a day that is not completed, as a
  second wall behind the job's own arithmetic.

  ## Decision 3 - claim before acting, never retry, key = the day it is ABOUT

  UNIQUE (company_id, day_key, pass), day_key being the operating day pulled and
  never the day of the run. Two overlapping runs, a cron line installed twice
  and a run an hour later all find it claimed. The job claims BEFORE it calls
  Reidey and never retries: a crash between the claim and the write loses one
  pull (visible as a row with no outcome) and never repeats one. A day whose
  pull FAILED (Reidey down, token rejected, a driver unlinked) is not retried
  by the schedule either: the row says what happened and the button pulls that
  day by hand. That is the cost of the no-retry rule and it is deliberate.

  ## Decision 4 - REFUSE by default; replace only as an explicit second pass

  Choice: a first pass of a day NEVER deletes anything. If rows for that driver
  and day already exist (a weekly pull by hand covers the days, or a re-run)
  the overlap check refuses, the run is recorded `already_imported` and nothing
  changes. Reason: a refusal is loud and safe, a silent replace could rewrite
  figures a person has already looked at, and hand-typed rows and the weekly
  button imports are not the schedule's to touch.

  Uber does correct figures after the fact, which is why replace exists in the
  human path. For the schedule it is an explicit switch,
  `replace_corrections`, and it works as a SECOND PASS ('recheck'): when it is
  on, the run that pulls day D also re-pulls day D-1 once, and ONLY when D-1's
  first pass was imported, and writes it with replace semantics (the new figure
  replaces the old, keyed exactly as the button's replace mode). The pass is
  part of the claim, so a correction happens once, not on every tick, and the
  system writer takes its replace flag from the CLAIM (pass = 'recheck'), never
  from the caller: a first pass cannot be made to delete by any argument. The
  job's report says which happened (imported, replaced).

  ## Decision 5 - the system writer restates the human body, authorization replaced

  income_import_uber needs auth.uid(), get_active_company_id() and the caller's
  role gate; a scheduled run has none of them. income_import_uber_system takes
  the company from the CLAIM (p_run_id), not from an argument a caller could
  vary, and replaces the authorization block with: an open claim, still
  unsettled, of a company that passes the boundary the candidate query uses
  (approved, active or trial, a live subscription or a running trial).
  EVERYTHING ELSE is the body of 20261014100000: the per-row shape regexes, the
  advisory lock on the same key (so a button import and a scheduled one
  serialise), the confirmed-link resolution, the unlinked stop, the period
  checks, the overlap refusal, the replace delete bounded by every term, and
  the insert that writes OUR drivers row's name with source = 'uber'. Two
  additions that only tighten: every row must be the claim's own day
  (period_start = period_end = date = day_key), and a successful import settles
  the claim in the SAME transaction, so "rows written" and "recorded as
  imported" cannot disagree.

  A refusal is a RETURN VALUE here ({ok:false, reason}) where the human path
  raises: the body runs in a block whose handler maps the raised refusal's HINT
  to the value. Leaving the block by the handler rolls its writes back, so a
  refusal after the replace delete leaves the old rows standing; the job then
  settles the claim with the reason. Anything that is not one of the three known
  refusal classes is re-raised, never turned into text.

  ## Decision 6 - the schedule is written by an administrator

  is_company_admin() on every write, as abrechnung_schedules: it decides that a
  company's income rows are written without a person looking. The runs have
  SELECT and nothing else; the job writes them through the functions above.

  ## A schedule that was just changed does not fire for the past

  armed_at is stamped when the switch or the time changes (not the corrections
  switch), and the job only acts on an occurrence AFTER it, as the Abrechnung
  schedule does.

  ## No SCHEMA_EPOCH bump

  New tables and functions only; the previous release never reads them. The
  human income_import_uber is not touched.
*/

-- --- 1. The schedule ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.uber_pull_schedules (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  enabled              boolean     NOT NULL DEFAULT false,
  -- A Europe/Berlin wall-clock time, whole minutes: the job runs every ten.
  run_time             time(0)     NOT NULL DEFAULT '06:00',
  replace_corrections  boolean     NOT NULL DEFAULT false,
  armed_at             timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid        NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uber_pull_schedules_one_per_company UNIQUE (company_id)
);

COMMENT ON TABLE public.uber_pull_schedules IS
  'When a company''s Uber earnings are pulled each day: a switch, a Europe/Berlin time of day, and whether the day before is re-pulled once to pick up corrections. Always the most recently completed operating day (04:00 to 04:00). 20261015100000.';

CREATE OR REPLACE FUNCTION app_private.uber_pull_schedules_stamp()
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
    IF NEW.enabled IS DISTINCT FROM OLD.enabled
       OR NEW.run_time IS DISTINCT FROM OLD.run_time THEN
      NEW.armed_at := now();
    ELSE
      NEW.armed_at := OLD.armed_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS uber_pull_schedules_stamp ON public.uber_pull_schedules;
CREATE TRIGGER uber_pull_schedules_stamp
  BEFORE INSERT OR UPDATE ON public.uber_pull_schedules
  FOR EACH ROW EXECUTE FUNCTION app_private.uber_pull_schedules_stamp();

-- --- 2. The record of what was claimed ---------------------------------------

CREATE TABLE IF NOT EXISTS public.uber_pull_runs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The operating day the pull is ABOUT (04:00 on this day to 04:00 on the next).
  day_key       date        NOT NULL,
  pass          text        NOT NULL,
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  outcome       text,
  -- A stable reason or Reidey's own capped sentence. Never a name or an amount.
  detail        text,
  rows_written  integer     NOT NULL DEFAULT 0,
  rows_deleted  integer     NOT NULL DEFAULT 0,
  driver_count  integer     NOT NULL DEFAULT 0,
  CONSTRAINT uber_pull_runs_pass_check CHECK (pass IN ('first', 'recheck')),
  CONSTRAINT uber_pull_runs_outcome_check CHECK (outcome IS NULL OR outcome IN (
    'imported', 'nothing_to_import', 'blocked_unlinked', 'blocked_unmatched',
    'already_imported', 'not_connected', 'seal_unreadable', 'token_rejected',
    'partner_refused', 'partner_unavailable', 'partner_malformed',
    'company_blocked', 'refused', 'failed')),
  CONSTRAINT uber_pull_runs_settled_check CHECK ((settled_at IS NULL) = (outcome IS NULL)),
  CONSTRAINT uber_pull_runs_counts_check
    CHECK (rows_written >= 0 AND rows_deleted >= 0 AND driver_count >= 0),
  CONSTRAINT uber_pull_runs_detail_check CHECK (detail IS NULL OR length(detail) <= 200),
  CONSTRAINT uber_pull_runs_once UNIQUE (company_id, day_key, pass)
);

CREATE INDEX IF NOT EXISTS uber_pull_runs_company_idx
  ON public.uber_pull_runs (company_id, day_key DESC);

COMMENT ON TABLE public.uber_pull_runs IS
  'One row per scheduled Uber pull the job has claimed. The unique constraint is the dedupe rule: one pull per company, operating day and pass. outcome IS NULL means claimed and never settled (a crash); the screen shows every outcome except imported and nothing_to_import as a failure.';

-- --- 3. The tenant shape -----------------------------------------------------

ALTER TABLE public.uber_pull_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uber_pull_runs      ENABLE ROW LEVEL SECURITY;

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
  FOREACH v_tbl IN ARRAY ARRAY['uber_pull_schedules', 'uber_pull_runs'] LOOP
    FOR p IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, v_tbl);
    END LOOP;

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s OR %s)',
      v_tbl || '_select', v_tbl, v_tenant, v_reads);
  END LOOP;

  EXECUTE format(
    'CREATE POLICY uber_pull_schedules_insert ON public.uber_pull_schedules '
    'FOR INSERT TO authenticated WITH CHECK ((%s) OR %s)', v_where, v_writes);
  EXECUTE format(
    'CREATE POLICY uber_pull_schedules_update ON public.uber_pull_schedules '
    'FOR UPDATE TO authenticated USING ((%s) OR %s) WITH CHECK ((%s) OR %s)',
    v_where, v_writes, v_where, v_writes);
  EXECUTE format(
    'CREATE POLICY uber_pull_schedules_delete ON public.uber_pull_schedules '
    'FOR DELETE TO authenticated USING ((%s) OR %s)', v_where, v_writes);

  -- The runs are written by the job only; they still carry both context
  -- triggers, because the rule is keyed on the policies naming
  -- get_active_company_id(), not on who writes today.
  FOREACH v_tbl IN ARRAY ARRAY['uber_pull_schedules', 'uber_pull_runs'] LOOP
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

-- --- 4. The candidate query --------------------------------------------------

/*
  The companies with the switch on, one row each, paged. What is DUE now is
  decided in TypeScript (uber-pull-core.ts), which is also where the
  Europe/Berlin arithmetic lives. The boundary is the Abrechnung job's: approved,
  status active or trial, and a live subscription or a running trial.

  `runs` is what this company has claimed in the last 12 days, with each
  outcome, so the worker can tell a due pull from one already held, and a first
  pass that was imported (the precondition of a recheck), without a call per day.
*/
CREATE OR REPLACE FUNCTION public.uber_pull_candidates(
  p_limit integer DEFAULT 100,
  p_after uuid    DEFAULT NULL
)
RETURNS TABLE (
  company_id          uuid,
  run_time            text,
  replace_corrections boolean,
  armed_at            timestamptz,
  runs                jsonb
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
    RAISE EXCEPTION 'uber_pull_candidates: p_limit must be between 1 and 500'
      USING ERRCODE = '22023';
  END IF;
  v_limit := COALESCE(p_limit, 100);

  RETURN QUERY
  WITH page AS (
    SELECT c.id, s.run_time, s.replace_corrections, s.armed_at
      FROM public.uber_pull_schedules s
      JOIN public.companies c ON c.id = s.company_id
     WHERE s.enabled
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
  page_runs AS (
    SELECT r.company_id,
           jsonb_agg(jsonb_build_object(
             'day_key', r.day_key,
             'pass',    r.pass,
             'outcome', r.outcome)) AS items
      FROM public.uber_pull_runs r
      JOIN page ON page.id = r.company_id
     WHERE r.day_key > (now() AT TIME ZONE 'Europe/Berlin')::date - 12
     GROUP BY r.company_id
  )
  SELECT page.id, to_char(page.run_time, 'HH24:MI'), page.replace_corrections, page.armed_at,
         COALESCE(page_runs.items, '[]'::jsonb)
    FROM page
    LEFT JOIN page_runs ON page_runs.company_id = page.id
   ORDER BY page.id;
END $fn$;

-- --- 5. Claiming and settling ------------------------------------------------

CREATE OR REPLACE FUNCTION public.uber_pull_claim(
  p_company_id uuid,
  p_day        date,
  p_pass       text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_id      uuid;
  v_running date;
BEGIN
  IF p_company_id IS NULL OR p_day IS NULL THEN
    RAISE EXCEPTION 'uber_pull_claim: company and day are required' USING ERRCODE = '22023';
  END IF;
  IF p_pass IS NULL OR p_pass NOT IN ('first', 'recheck') THEN
    RAISE EXCEPTION 'uber_pull_claim: unknown pass' USING ERRCODE = '22023';
  END IF;

  -- The operating day that is still running: Berlin wall time minus the four
  -- hours before 04:00. A day is claimable only once it has COMPLETED, and only
  -- inside the window the candidates report, so this cannot be pointed at the
  -- running day or at the distant past.
  v_running := ((now() AT TIME ZONE 'Europe/Berlin') - interval '4 hours')::date;
  IF p_day >= v_running OR p_day < v_running - 10 THEN
    RAISE EXCEPTION 'uber_pull_claim: the day must be a completed operating day of the last 10'
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

  INSERT INTO public.uber_pull_runs (company_id, day_key, pass)
  VALUES (p_company_id, p_day, p_pass)
  ON CONFLICT ON CONSTRAINT uber_pull_runs_once DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END $fn$;

/*
  Record a pull that wrote nothing, and why. `imported` cannot be recorded here:
  only income_import_uber_system settles that, in the transaction that wrote the
  rows, so a claim can never say "imported" with no rows behind it.
*/
CREATE OR REPLACE FUNCTION public.uber_pull_settle(
  p_id           uuid,
  p_outcome      text,
  p_detail       text,
  p_driver_count integer DEFAULT 0
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
  IF p_id IS NULL OR p_outcome IS NULL THEN
    RAISE EXCEPTION 'uber_pull_settle: id and outcome are required' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'imported' THEN
    RAISE EXCEPTION 'uber_pull_settle: imported is settled by the writer only' USING ERRCODE = '22023';
  END IF;
  IF p_driver_count IS NULL OR p_driver_count < 0 THEN
    RAISE EXCEPTION 'uber_pull_settle: driver count must not be negative' USING ERRCODE = '22023';
  END IF;

  UPDATE public.uber_pull_runs
     SET outcome = p_outcome,
         detail = left(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]', ' ', 'g'), 200),
         driver_count = p_driver_count,
         settled_at = now()
   WHERE id = p_id AND settled_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $fn$;

-- --- 6. The system writer ----------------------------------------------------

CREATE OR REPLACE FUNCTION public.income_import_uber_system(p_run_id uuid, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_partner CONSTANT text := 'reidey';
  c_source  CONSTANT text := 'uber';
  v_run      public.uber_pull_runs%ROWTYPE;
  v_company  uuid;
  v_replace  boolean;
  v_unlinked text;
  v_inserted integer;
  v_drivers  integer;
  v_deleted  integer := 0;
  v_state    text;
  v_hint     text;
BEGIN
  -- Everything below runs in this block, so a refusal raised ANYWHERE in it,
  -- after the replace delete included, is turned into a return value by the
  -- handler at the end and the block's writes are rolled back with it.
  BEGIN
    IF p_run_id IS NULL THEN
      RAISE EXCEPTION 'a run is required' USING ERRCODE = '22023', HINT = 'invalid_request';
    END IF;

    -- The authorization of the human path (a session, the caller's company and
    -- role, the platform refusal) is replaced by the claim: an open run of a
    -- company that is still allowed to be written for.
    SELECT * INTO v_run FROM public.uber_pull_runs r WHERE r.id = p_run_id FOR UPDATE;
    IF NOT FOUND OR v_run.settled_at IS NOT NULL THEN
      RAISE EXCEPTION 'the run is not open' USING ERRCODE = '22023', HINT = 'run_not_open';
    END IF;
    v_company := v_run.company_id;

    IF NOT EXISTS (
      SELECT 1 FROM public.companies c
       WHERE c.id = v_company
         AND c.approval_status = 'approved'
         AND c.status IN ('active', 'trial')
         AND (
               (c.subscription_status = 'active'
                AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now()))
               OR (c.status = 'trial' AND c.trial_end IS NOT NULL AND c.trial_end > now())
             )
    ) THEN
      RAISE EXCEPTION 'the company is not active' USING ERRCODE = '42501', HINT = 'company_blocked';
    END IF;

    -- Replace is the CLAIM'S property, never an argument.
    v_replace := v_run.pass = 'recheck';

    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array'
       OR jsonb_array_length(p_rows) = 0 OR jsonb_array_length(p_rows) > 2000 THEN
      RAISE EXCEPTION 'invalid rows' USING ERRCODE = '22023', HINT = 'invalid_request';
    END IF;

    -- Every element must have exactly the shape the browser builds. Regexes first,
    -- casts after, so a malformed value is a refusal and not a stray cast error.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_rows) e
       WHERE NOT (
         jsonb_typeof(e) = 'object'
         AND e->>'external_driver_id' ~ '^[0-9]{1,18}$'
         AND e->>'type' IN ('umsatz', 'aktionen', 'trinkgeld', 'bargeld')
         AND jsonb_typeof(e->'amount') = 'string'
         AND e->>'amount' ~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$'
         AND e->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         AND e->>'period_start' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         AND e->>'period_end' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         AND e->>'week' ~ '^[1-5]$'
         AND length(coalesce(e->>'description', '')) BETWEEN 1 AND 200
         AND (e->'trip_count' IS NULL OR jsonb_typeof(e->'trip_count') = 'null'
              OR e->>'trip_count' ~ '^[0-9]{1,9}$')
       )
    ) THEN
      RAISE EXCEPTION 'a row is malformed' USING ERRCODE = '22023', HINT = 'invalid_request';
    END IF;

    -- One import per company at a time, the human path's own key, so a button
    -- import and a scheduled one cannot both pass the overlap check together.
    PERFORM pg_advisory_xact_lock(hashtextextended('income_import_uber:' || v_company::text, 0));

    -- Resolved from the CONFIRMED link; one unlinked driver stops the whole call.
    SELECT string_agg(k.key, ',' ORDER BY k.key) INTO v_unlinked
      FROM (SELECT DISTINCT e->>'external_driver_id' AS key FROM jsonb_array_elements(p_rows) e) k
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.partner_driver_links l
         JOIN public.drivers d ON d.id = l.driver_id AND d.company_id = v_company
        WHERE l.company_id = v_company AND l.partner = c_partner
          AND l.external_driver_id = k.key AND l.status = 'linked'
     );
    IF v_unlinked IS NOT NULL THEN
      RAISE EXCEPTION 'some drivers have no confirmed link'
        USING ERRCODE = '22023', HINT = 'driver_not_linked';
    END IF;

    BEGIN
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_rows) e
         WHERE (e->>'period_start')::date > (e->>'period_end')::date
            OR (e->>'period_end')::date - (e->>'period_start')::date > 6
            OR (e->>'date')::date NOT BETWEEN (e->>'period_start')::date AND (e->>'period_end')::date
      ) THEN
        RAISE EXCEPTION 'a period is not inside one week' USING ERRCODE = '22023', HINT = 'invalid_period';
      END IF;

      -- A scheduled pull is one operating day: the claim's day and no other.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_rows) e
         WHERE (e->>'period_start')::date <> v_run.day_key
            OR (e->>'period_end')::date   <> v_run.day_key
            OR (e->>'date')::date         <> v_run.day_key
      ) THEN
        RAISE EXCEPTION 'a row is not the claimed day' USING ERRCODE = '22023', HINT = 'wrong_day';
      END IF;

      -- Replace mode, the recheck pass only: the previous Uber rows for the
      -- (driver, day) pairs this payload is about go first. Keyed on the unique
      -- index's own columns and NOT on type, exactly as the button's replace
      -- mode, for the same reason. The company is the claim's, the source is
      -- the constant, and a driver key counts only through the confirmed link.
      IF v_replace THEN
        DELETE FROM public.income i
         USING (SELECT DISTINCT e->>'external_driver_id' AS driver_key,
                                (e->>'period_start')::date AS period_start
                  FROM jsonb_array_elements(p_rows) e
                  JOIN public.partner_driver_links l
                    ON l.company_id = v_company AND l.partner = c_partner
                   AND l.external_driver_id = e->>'external_driver_id' AND l.status = 'linked'
                  JOIN public.drivers d ON d.id = l.driver_id AND d.company_id = v_company) k
         WHERE i.company_id = v_company
           AND i.source = c_source
           AND i.source_driver_key = k.driver_key
           AND i.source_period_start = k.period_start;
        GET DIAGNOSTICS v_deleted = ROW_COUNT;
      END IF;

      -- A period that overlaps one already imported for the driver is the same
      -- days counted twice, whatever its start day says.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_rows) e
          JOIN public.income i
            ON i.company_id = v_company AND i.source = c_source
           AND i.source_driver_key = e->>'external_driver_id'
           AND i.source_period_start <= (e->>'period_end')::date
           AND i.source_period_end   >= (e->>'period_start')::date
      ) THEN
        RAISE EXCEPTION 'this period was already imported' USING ERRCODE = '23505', HINT = 'already_imported';
      END IF;

      INSERT INTO public.income
             (description, amount, type, driver_name, date, week, trip_count, company_id,
              source, source_period_start, source_period_end, source_driver_key)
      SELECT e->>'description', (e->>'amount')::numeric(12,2), e->>'type',
             d.name,   -- OUR row's name, character for character
             (e->>'date')::date, (e->>'week')::integer,
             CASE WHEN jsonb_typeof(e->'trip_count') = 'number' THEN (e->>'trip_count')::integer END,
             v_company, c_source,
             (e->>'period_start')::date, (e->>'period_end')::date, e->>'external_driver_id'
        FROM jsonb_array_elements(p_rows) e
        JOIN public.partner_driver_links l
          ON l.company_id = v_company AND l.partner = c_partner
         AND l.external_driver_id = e->>'external_driver_id' AND l.status = 'linked'
        JOIN public.drivers d ON d.id = l.driver_id AND d.company_id = v_company;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;
    EXCEPTION
      WHEN unique_violation THEN
        RAISE EXCEPTION 'this period was already imported' USING ERRCODE = '23505', HINT = 'already_imported';
      WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'a date is not a date' USING ERRCODE = '22023', HINT = 'invalid_request';
    END;

    IF v_inserted <> jsonb_array_length(p_rows) THEN
      -- The join dropped a row: a link that vanished mid-call. Nothing stays.
      RAISE EXCEPTION 'some drivers have no confirmed link'
        USING ERRCODE = '22023', HINT = 'driver_not_linked';
    END IF;

    SELECT count(DISTINCT e->>'external_driver_id') INTO v_drivers FROM jsonb_array_elements(p_rows) e;

    -- Settled in the transaction that wrote the rows.
    UPDATE public.uber_pull_runs
       SET outcome = 'imported', settled_at = now(),
           rows_written = v_inserted, rows_deleted = v_deleted, driver_count = v_drivers
     WHERE id = v_run.id;

    RETURN jsonb_build_object('ok', true, 'inserted', v_inserted, 'drivers', v_drivers,
                              'deleted', v_deleted, 'replaced', v_replace);
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
      -- Only the refusals raised above become values. Anything else is a
      -- defect and propagates; the message text is never returned.
      IF v_state NOT IN ('22023', '23505', '42501') OR coalesce(v_hint, '') = '' THEN
        RAISE;
      END IF;
      RETURN jsonb_build_object('ok', false, 'reason', v_hint);
  END;
END;
$$;

COMMENT ON FUNCTION public.income_import_uber_system(uuid, jsonb) IS
  'The system writer of the scheduled Uber pull: income_import_uber with the session and role gate replaced by an open uber_pull_runs claim. Same row shape, advisory lock, confirmed-link resolution, overlap refusal and name-from-our-drivers-row as the human path; every row must be the claim''s day; replace is the claim''s pass (recheck) and never an argument; a refusal is a return value {ok:false, reason} with the block rolled back; success settles the claim in the same transaction. service_role only.';

-- --- 7. Ownership and privileges ---------------------------------------------

ALTER FUNCTION app_private.uber_pull_schedules_stamp()                   OWNER TO CURRENT_USER;
ALTER FUNCTION public.uber_pull_candidates(integer, uuid)                OWNER TO CURRENT_USER;
ALTER FUNCTION public.uber_pull_claim(uuid, date, text)                  OWNER TO CURRENT_USER;
ALTER FUNCTION public.uber_pull_settle(uuid, text, text, integer)        OWNER TO CURRENT_USER;
ALTER FUNCTION public.income_import_uber_system(uuid, jsonb)             OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION app_private.uber_pull_schedules_stamp()                  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.uber_pull_candidates(integer, uuid)               FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.uber_pull_claim(uuid, date, text)                 FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.uber_pull_settle(uuid, text, text, integer)       FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.income_import_uber_system(uuid, jsonb)            FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.uber_pull_candidates(integer, uuid)            TO service_role;
GRANT EXECUTE ON FUNCTION public.uber_pull_claim(uuid, date, text)              TO service_role;
GRANT EXECUTE ON FUNCTION public.uber_pull_settle(uuid, text, text, integer)    TO service_role;
GRANT EXECUTE ON FUNCTION public.income_import_uber_system(uuid, jsonb)         TO service_role;

REVOKE ALL ON TABLE public.uber_pull_schedules FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.uber_pull_runs      FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.uber_pull_schedules TO authenticated;
GRANT SELECT ON TABLE public.uber_pull_runs TO authenticated;

-- --- 8. Self-check -----------------------------------------------------------

DO $check$
DECLARE
  v_tbl   text;
  v_wrong text;
  v_n     integer;
  v_fn    oid := 'public.income_import_uber_system(uuid, jsonb)'::regprocedure;
  v_src   text;
  v_del   text;
  v_human oid := 'public.income_import_uber(jsonb, boolean)'::regprocedure;
  v_hsrc  text;
  v_frag  text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['uber_pull_schedules', 'uber_pull_runs'] LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', v_tbl)::regclass) THEN
      RAISE EXCEPTION 'uber pull self-check: % has row level security off', v_tbl;
    END IF;

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
      RAISE EXCEPTION 'uber pull self-check: % has a policy outside the business shape: %', v_tbl, v_wrong;
    END IF;

    SELECT count(*) INTO v_n FROM pg_trigger g
     WHERE g.tgrelid = format('public.%I', v_tbl)::regclass AND NOT g.tgisinternal
       AND ((g.tgname = 'refuse_read_only_context_write' AND g.tgtype = 30 AND g.tgenabled = 'O')
            OR (g.tgname = 'record_support_write' AND g.tgtype = 29 AND g.tgenabled = 'O'
                AND g.tgqual IS NOT NULL
                AND pg_get_triggerdef(g.oid) ~ 'app_private\.support_write_context'));
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'uber pull self-check: % must carry both context triggers', v_tbl;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_policies p
       WHERE p.schemaname = 'public' AND p.tablename = 'uber_pull_schedules') <> 4
     OR (SELECT count(DISTINCT p.cmd) FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = 'uber_pull_schedules') <> 4 THEN
    RAISE EXCEPTION 'uber pull self-check: uber_pull_schedules must carry exactly one SELECT, INSERT, UPDATE and DELETE policy';
  END IF;
  IF (SELECT count(*) FROM pg_policies p
       WHERE p.schemaname = 'public' AND p.tablename = 'uber_pull_runs') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies p
                     WHERE p.schemaname = 'public' AND p.tablename = 'uber_pull_runs' AND p.cmd = 'SELECT') THEN
    RAISE EXCEPTION 'uber pull self-check: uber_pull_runs is written by the job only, so SELECT is its one policy';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = 'public.uber_pull_schedules'::regclass
                    AND g.tgname = 'uber_pull_schedules_stamp'
                    AND NOT g.tgisinternal AND g.tgtype = 23 AND g.tgenabled = 'O') THEN
    RAISE EXCEPTION 'uber pull self-check: the stamp must be an enabled BEFORE INSERT OR UPDATE row trigger';
  END IF;

  IF has_table_privilege('anon', 'public.uber_pull_schedules', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('service_role', 'public.uber_pull_schedules', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('authenticated', 'public.uber_pull_schedules', 'TRUNCATE,REFERENCES,TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.uber_pull_schedules', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.uber_pull_schedules', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.uber_pull_schedules', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.uber_pull_schedules', 'DELETE') THEN
    RAISE EXCEPTION 'uber pull self-check: uber_pull_schedules grants are wrong';
  END IF;
  IF has_table_privilege('anon', 'public.uber_pull_runs', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('service_role', 'public.uber_pull_runs', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('authenticated', 'public.uber_pull_runs', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.uber_pull_runs', 'SELECT') THEN
    RAISE EXCEPTION 'uber pull self-check: uber_pull_runs must be authenticated SELECT only';
  END IF;

  -- The four functions: service_role alone, SECURITY DEFINER, pinned search_path.
  SELECT string_agg(v.sig, ', ') INTO v_wrong
    FROM (VALUES
      ('public.uber_pull_candidates(integer, uuid)'),
      ('public.uber_pull_claim(uuid, date, text)'),
      ('public.uber_pull_settle(uuid, text, text, integer)'),
      ('public.income_import_uber_system(uuid, jsonb)')
    ) AS v(sig)
   WHERE has_function_privilege('anon',          to_regprocedure(v.sig), 'EXECUTE')
      OR has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE')
      OR NOT has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                  WHERE p.oid = to_regprocedure(v.sig) AND a.grantee = 0)
      OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig))
      OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)
                      AND p.proconfig @> ARRAY['search_path=pg_catalog, public']);
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'uber pull self-check: % must be SECURITY DEFINER, pinned, and EXECUTE for service_role only', v_wrong;
  END IF;

  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'app_private.uber_pull_schedules_stamp()'::regprocedure)
     OR has_function_privilege('anon', 'app_private.uber_pull_schedules_stamp()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.uber_pull_schedules_stamp()', 'EXECUTE')
     OR has_function_privilege('service_role', 'app_private.uber_pull_schedules_stamp()', 'EXECUTE') THEN
    RAISE EXCEPTION 'uber pull self-check: the stamp must be SECURITY DEFINER and executable by no API role';
  END IF;

  -- The dedupe rule is a constraint, not a convention.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.uber_pull_runs'::regclass
       AND conname = 'uber_pull_runs_once' AND contype = 'u'
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(conkey) AS k(attnum)
              JOIN pg_attribute a ON a.attrelid = conrelid AND a.attnum = k.attnum)
           = ARRAY['company_id', 'day_key', 'pass']
  ) THEN
    RAISE EXCEPTION 'uber pull self-check: the dedupe rule must be a UNIQUE constraint on (company_id, day_key, pass)';
  END IF;

  -- The system writer must carry every load-bearing fragment of the human body
  -- (20261014100000), the replace delete bounded by every term, and nothing of
  -- the session it replaces. strpos, not LIKE: these fragments hold backslashes.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_fn;
  FOREACH v_frag IN ARRAY ARRAY[
    'partner_driver_links',
    'l.status = ''linked''',
    'd.company_id = v_company',
    'd.name,',
    'driver_not_linked',
    'already_imported',
    'invalid_period',
    'wrong_day',
    'run_not_open',
    'company_blocked',
    'FOR UPDATE',
    'pg_advisory_xact_lock(hashtextextended(''income_import_uber:'' || v_company::text, 0))',
    '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$',
    '^[0-9]{1,18}$',
    '^[1-5]$',
    '(e->>''period_end'')::date - (e->>''period_start'')::date > 6',
    'i.source_period_start <= (e->>''period_end'')::date',
    'i.source_period_end   >= (e->>''period_start'')::date',
    'v_replace := v_run.pass = ''recheck''',
    'outcome = ''imported'''
  ] LOOP
    IF strpos(v_src, v_frag) = 0 THEN
      RAISE EXCEPTION 'uber pull self-check: income_import_uber_system lost a fragment of the human path: %', v_frag;
    END IF;
  END LOOP;
  IF strpos(v_src, 'SQLERRM') > 0 OR strpos(v_src, 'auth.uid()') > 0
     OR strpos(v_src, 'current_role_permits') > 0 OR strpos(v_src, 'p_replace') > 0 THEN
    RAISE EXCEPTION 'uber pull self-check: income_import_uber_system returns message text, names the session it replaced, or takes replace from a caller';
  END IF;

  IF (length(v_src) - length(replace(v_src, 'DELETE FROM', ''))) / length('DELETE FROM') <> 1 THEN
    RAISE EXCEPTION 'uber pull self-check: income_import_uber_system must contain exactly one DELETE';
  END IF;
  v_del := substring(v_src FROM 'DELETE FROM public\.income.*?;');
  IF v_del IS NULL
     OR strpos(v_del, 'i.company_id = v_company') = 0
     OR strpos(v_del, 'i.source = c_source') = 0
     OR strpos(v_del, 'i.source_driver_key = k.driver_key') = 0
     OR strpos(v_del, 'i.source_period_start = k.period_start') = 0
     OR strpos(v_del, 'l.status = ''linked''') = 0
     OR strpos(v_del, 'partner_driver_links') = 0
     OR strpos(v_del, 'i.type') > 0
     OR v_del ILIKE '%IS NULL%' OR v_del ILIKE '% OR %' OR v_del ILIKE '%coalesce%'
     OR strpos(v_del, '''source''') > 0 THEN
    RAISE EXCEPTION 'uber pull self-check: the replace delete lost a term or widened: %', v_del;
  END IF;
  IF strpos(v_src, 'IF v_replace THEN') = 0
     OR strpos(v_src, 'IF v_replace THEN') > strpos(v_src, 'DELETE FROM')
     OR strpos(v_src, 'DELETE FROM') > strpos(v_src, 'INSERT INTO public.income') THEN
    RAISE EXCEPTION 'uber pull self-check: the delete must be gated by v_replace and run before the insert';
  END IF;

  -- The human path is untouched by this migration.
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'income_import_uber'
        AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'uber pull self-check: income_import_uber must still exist exactly once';
  END IF;
  SELECT p.prosrc INTO v_hsrc FROM pg_proc p WHERE p.oid = v_human;
  IF strpos(v_hsrc, 'current_role_permits(''income'', true)') = 0
     OR strpos(v_hsrc, 'get_active_company_id()') = 0
     OR strpos(v_hsrc, 'platform_session_not_allowed') = 0
     OR NOT has_function_privilege('authenticated', v_human, 'EXECUTE')
     OR has_function_privilege('anon', v_human, 'EXECUTE') THEN
    RAISE EXCEPTION 'uber pull self-check: the human income_import_uber changed';
  END IF;

  RAISE NOTICE 'uber pull self-check: passed';
END $check$;
