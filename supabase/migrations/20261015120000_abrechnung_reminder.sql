/*
  # The weekly reminder: an hour before the Abrechnung goes out, ask the driver
  # who has recorded nothing to do so

  ## What the owner asked for (15.10.2026)

    "an hour before the weekly Abrechnung mail goes out, remind any driver who
     has not recorded his receipts or notes, so he can still enter them before
     the figures are sent"

  On the risk of reminding someone who did not need it, his answer was: "if the
  driver forgets to submit the data on Reidey it is his fault not ours, so let it
  work as we need." So the rule below is deliberately plain and there is no
  machinery to avoid a false reminder.

  ## Who is reminded - the rule, and the one place it is written

  `abrechnung_week_figures` has a row only for a driver with a `bar` receipt or a
  `bargeld` income in the week, so the driver who recorded NOTHING gets no mail at
  all today. That is the gap. The rule is

      an ACTIVE driver with an address, whose name matches no other driver, who
      has income of type `umsatz` in the week but no `bargeld` income row and no
      `bar` receipt - he drove, and handed nothing in.

  It is `nothingRecorded()` in supabase/functions/_shared/abrechnung-reminder-core.ts
  and nowhere else. This migration's `abrechnung_reminder_facts` returns the
  FACTS per driver of the company, unfiltered, and decides nothing, so the rule
  can be read and changed in that one file. "Notes" are not part of it: a
  `driver_notes` row is a planning constraint of a month (sick, vacation, ...)
  and carries no week of the Abrechnung, so no honest proxy for them exists.

  ## Decision 1 - a new kind, and the dedupe key is the week the figures are ABOUT

  `abrechnung_deliveries.kind` admits `driver_reminder`. The key is the existing
  `UNIQUE (company_id, kind, target_id, period_key)`: `target_id` the driver,
  `period_key` the MONDAY of the week the figures are about - the same value the
  driver's own Abrechnung of that week carries, never the day of the run. So a
  repeated or overlapping run, or a cron line installed twice, finds the reminder
  claimed: one reminder per driver per week.

  ## Decision 2 - never once the main mail is claimed, enforced in the claim

  The window (abrechnung-schedule-core.ts, `dueReminder`) ends at the main
  moment, but the guarantee is not the clock. `abrechnung_delivery_claim` answers
  NULL for a `driver_reminder` when a `driver_abrechnung` row exists for the same
  company, driver and week, and takes a transaction-scoped advisory lock on that
  (company, driver, week) for BOTH driver kinds first, so a reminder and a main
  claim racing each other cannot both pass: whichever takes the lock second sees
  the other's committed row. A reminder can follow nothing; a main mail can
  follow a reminder.

  ## Decision 3 - it rides the tick that exists

  There is no new function and no new cron line. `{"job":"abrechnung"}` already
  runs every ten minutes; the reminder is a second pass of the same job, on the
  same service-role door. Two columns on `abrechnung_schedules`:
  `reminder_enabled` (default false) and `reminder_lead_minutes` (default 60,
  15 to 720). A reminder needs the drivers' mail to be on: it is the warning
  before that mail. Both default to off, so applying this migration changes
  nothing for anybody.

  A change to either re-arms the schedule (`armed_at`, decision 4 of
  20261003120000): a reminder moment that lies before the change never fires.

  ## What this restates, and what it carries over unchanged

  * `app_private.abrechnung_schedules_stamp` - the two new columns join the list
    of fields that re-arm; every other line is the old body.
  * `public.abrechnung_schedule_candidates` - it returns the two columns too. A
    function's result type cannot change in place, so it is dropped and created;
    EXECUTE is re-granted to service_role alone. The previous release's job reads
    the columns it knows and ignores these.
  * `public.abrechnung_delivery_claim` - the kind list gains `driver_reminder`
    and the two driver rules above are added. Every other branch (the company
    boundary, the driver belongs to the company, the manager target, the
    ON CONFLICT insert) is the old body, and the self-check re-asserts them.

  ## No SCHEMA_EPOCH bump

  Additive: two defaulted columns, one more kind, one new function. The
  previous release never reads them.
*/

-- ─── 1. The schedule's two columns ──────────────────────────────────────────

ALTER TABLE public.abrechnung_schedules
  ADD COLUMN IF NOT EXISTS reminder_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_lead_minutes smallint NOT NULL DEFAULT 60;

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.abrechnung_schedules'::regclass
                    AND conname = 'abrechnung_schedules_reminder_lead_check') THEN
    ALTER TABLE public.abrechnung_schedules
      ADD CONSTRAINT abrechnung_schedules_reminder_lead_check
      CHECK (reminder_lead_minutes BETWEEN 15 AND 720);
  END IF;
END $mig$;

COMMENT ON COLUMN public.abrechnung_schedules.reminder_enabled IS
  'Remind a driver who drove but recorded no cash and no cash receipt, reminder_lead_minutes before the driver mail goes out. Needs driver_mail_enabled (20261015100000).';

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
       OR NEW.send_time               IS DISTINCT FROM OLD.send_time
       OR NEW.reminder_enabled        IS DISTINCT FROM OLD.reminder_enabled
       OR NEW.reminder_lead_minutes   IS DISTINCT FROM OLD.reminder_lead_minutes THEN
      NEW.armed_at := now();
    ELSE
      NEW.armed_at := OLD.armed_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ─── 2. The new kind ────────────────────────────────────────────────────────

ALTER TABLE public.abrechnung_deliveries DROP CONSTRAINT IF EXISTS abrechnung_deliveries_kind_check;
ALTER TABLE public.abrechnung_deliveries
  ADD CONSTRAINT abrechnung_deliveries_kind_check
  CHECK (kind IN ('driver_abrechnung', 'manager_summary', 'driver_reminder'));

-- ─── 3. The candidates carry the reminder's two columns ─────────────────────

DROP FUNCTION IF EXISTS public.abrechnung_schedule_candidates(integer, uuid);

CREATE FUNCTION public.abrechnung_schedule_candidates(
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
  sent                    jsonb,
  reminder_enabled        boolean,
  reminder_lead_minutes   smallint
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
           s.weekday, s.send_time, s.armed_at, s.reminder_enabled, s.reminder_lead_minutes
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
         COALESCE(page_sent.items, '[]'::jsonb),
         page.reminder_enabled, page.reminder_lead_minutes
    FROM page
    LEFT JOIN page_sent ON page_sent.company_id = page.id
   ORDER BY page.id;
END $fn$;

-- ─── 4. The claim: the new kind, and the two driver rules ───────────────────

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
  IF p_kind IS NULL OR p_kind NOT IN ('driver_abrechnung', 'manager_summary', 'driver_reminder') THEN
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
  ELSE
    -- Decision 2. One lock per (company, driver, week) for both driver kinds,
    -- held to the end of this call's transaction: a reminder and a main claim
    -- racing each other are serialised, and the second sees the first's row.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'abrechnung_driver_claim:' || p_company_id::text || ':' || p_target_id::text
      || ':' || p_period_key, 0));

    -- A reminder is a warning BEFORE the driver's mail. Once that mail is
    -- claimed for this week it is pointless and would be confusing.
    IF p_kind = 'driver_reminder' AND EXISTS (
         SELECT 1 FROM public.abrechnung_deliveries x
          WHERE x.company_id = p_company_id AND x.kind = 'driver_abrechnung'
            AND x.target_id = p_target_id AND x.period_key = p_period_key) THEN
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO public.abrechnung_deliveries (company_id, kind, target_id, period_key)
  VALUES (p_company_id, p_kind, p_target_id, p_period_key)
  ON CONFLICT ON CONSTRAINT abrechnung_deliveries_once DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END $fn$;

-- ─── 5. The facts the rule is applied to ────────────────────────────────────

/*
  One row per driver of the company, with what the week holds for the name.
  It decides NOTHING: which of these drivers is reminded is
  `nothingRecorded()` in abrechnung-reminder-core.ts.

  The name match is the week figures' (and driverRecipients.ts'): trimmed, inner
  whitespace collapsed, lower-cased. `income` and `receipts` carry a driver name
  and no driver id, so a name two drivers share has `match_count` > 1 and the
  rule never reminds either. `driver_email` is the trimmed address, NULL when
  there is none. `p_week_monday` must be a Monday.
*/
CREATE FUNCTION public.abrechnung_reminder_facts(
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
       AND r.date BETWEEN p_week_monday AND p_week_monday + 6
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

-- ─── 6. Ownership and privileges ────────────────────────────────────────────

ALTER FUNCTION app_private.abrechnung_schedules_stamp()                  OWNER TO CURRENT_USER;
ALTER FUNCTION public.abrechnung_schedule_candidates(integer, uuid)      OWNER TO CURRENT_USER;
ALTER FUNCTION public.abrechnung_delivery_claim(uuid, text, uuid, text)  OWNER TO CURRENT_USER;
ALTER FUNCTION public.abrechnung_reminder_facts(uuid, date)              OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION app_private.abrechnung_schedules_stamp()                  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.abrechnung_schedule_candidates(integer, uuid)      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.abrechnung_delivery_claim(uuid, text, uuid, text)  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.abrechnung_reminder_facts(uuid, date)              FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.abrechnung_schedule_candidates(integer, uuid)      TO service_role;
GRANT EXECUTE ON FUNCTION public.abrechnung_delivery_claim(uuid, text, uuid, text)  TO service_role;
GRANT EXECUTE ON FUNCTION public.abrechnung_reminder_facts(uuid, date)              TO service_role;

-- ─── 7. Self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_wrong text;
  v_src   text;
BEGIN
  -- 1. The kind list, and the dedupe rule untouched.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.abrechnung_deliveries'::regclass
                    AND conname = 'abrechnung_deliveries_kind_check'
                    AND pg_get_constraintdef(oid) ~ 'driver_reminder'
                    AND pg_get_constraintdef(oid) ~ 'driver_abrechnung'
                    AND pg_get_constraintdef(oid) ~ 'manager_summary') THEN
    RAISE EXCEPTION 'abrechnung reminder self-check: the kind check must admit all three kinds';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.abrechnung_deliveries'::regclass
       AND conname = 'abrechnung_deliveries_once' AND contype = 'u'
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(conkey) AS k(attnum)
              JOIN pg_attribute a ON a.attrelid = conrelid AND a.attnum = k.attnum)
           = ARRAY['company_id', 'kind', 'period_key', 'target_id']
  ) THEN
    RAISE EXCEPTION 'abrechnung reminder self-check: the dedupe rule must stay UNIQUE (company_id, kind, target_id, period_key)';
  END IF;

  -- 2. The stamp re-arms on the reminder's fields and keeps the old ones.
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = 'app_private.abrechnung_schedules_stamp()'::regprocedure;
  IF v_src !~ 'reminder_enabled' OR v_src !~ 'reminder_lead_minutes'
     OR v_src !~ 'driver_mail_enabled' OR v_src !~ 'manager_summary_enabled'
     OR v_src !~ 'NEW\.weekday' OR v_src !~ 'NEW\.send_time' THEN
    RAISE EXCEPTION 'abrechnung reminder self-check: the stamp must re-arm on all six fields';
  END IF;

  -- 3. The claim keeps every old branch and carries the two new rules.
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = 'public.abrechnung_delivery_claim(uuid, text, uuid, text)'::regprocedure;
  IF v_src !~ 'approval_status = ''approved''' OR v_src !~ 'status IN \(''active'', ''trial''\)'
     OR v_src !~ 'd\.company_id = p_company_id' OR v_src !~ 'p_target_id <> p_company_id'
     OR v_src !~ 'ON CONFLICT ON CONSTRAINT abrechnung_deliveries_once DO NOTHING'
     OR v_src !~ 'driver_reminder' OR v_src !~ 'pg_advisory_xact_lock'
     OR v_src !~ 'x\.kind = ''driver_abrechnung''' THEN
    RAISE EXCEPTION 'abrechnung reminder self-check: the claim lost a branch it must carry';
  END IF;

  -- 4. The candidates return the two columns and keep the boundary.
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = 'public.abrechnung_schedule_candidates(integer, uuid)'::regprocedure;
  IF v_src !~ 'reminder_lead_minutes' OR v_src !~ 'approval_status = ''approved'''
     OR v_src !~ 'subscription_expires_at' OR v_src !~ 'trial_end' THEN
    RAISE EXCEPTION 'abrechnung reminder self-check: the candidate query lost its boundary or the reminder columns';
  END IF;

  -- 5. EXECUTE: service_role alone, on all three, plpgsql definer, pinned path.
  SELECT string_agg(v.sig, ', ') INTO v_wrong
    FROM (VALUES
      ('public.abrechnung_schedule_candidates(integer, uuid)'),
      ('public.abrechnung_delivery_claim(uuid, text, uuid, text)'),
      ('public.abrechnung_reminder_facts(uuid, date)')
    ) AS v(sig)
   WHERE has_function_privilege('anon',          to_regprocedure(v.sig), 'EXECUTE')
      OR has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE')
      OR NOT has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE');
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'abrechnung reminder self-check: EXECUTE must be service_role only on %', v_wrong;
  END IF;

  SELECT string_agg(p.proname, ', ') INTO v_wrong
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('abrechnung_schedule_candidates', 'abrechnung_delivery_claim',
                       'abrechnung_reminder_facts')
     AND (NOT p.prosecdef
          OR p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
          OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c
                          WHERE c LIKE 'search\_path=%'));
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'abrechnung reminder self-check: % must be plpgsql SECURITY DEFINER with a pinned search_path', v_wrong;
  END IF;

  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'app_private.abrechnung_schedules_stamp()'::regprocedure)
     OR has_function_privilege('anon', 'app_private.abrechnung_schedules_stamp()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.abrechnung_schedules_stamp()', 'EXECUTE')
     OR has_function_privilege('service_role', 'app_private.abrechnung_schedules_stamp()', 'EXECUTE') THEN
    RAISE EXCEPTION 'abrechnung reminder self-check: the stamp must stay SECURITY DEFINER and executable by no API role';
  END IF;

  -- 6. The schedule's policies are untouched: still the four, an administrator
  --    on every write.
  IF (SELECT count(*) FROM pg_policies p
       WHERE p.schemaname = 'public' AND p.tablename = 'abrechnung_schedules') <> 4
     OR EXISTS (SELECT 1 FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = 'abrechnung_schedules'
                   AND p.cmd <> 'SELECT'
                   AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'is_company_admin') THEN
    RAISE EXCEPTION 'abrechnung reminder self-check: abrechnung_schedules must keep its four policies, an administrator on every write';
  END IF;

  RAISE NOTICE 'abrechnung reminder self-check: passed';
END $check$;
