/*
  # The notification job's record of what it has sent, and the two queries it runs

  ## What was missing

  `notification_settings` (20260502121504) let a company switch four types on
  and off — `tuev_bald_ablaufend`, `tuev_abgelaufen`, `trial_bald_ablaufend`,
  `trial_abgelaufen` — and **no other code in the repository read that table**.
  There was no scheduler, no sender and no template: a TÜV expiry produced
  nothing, and `NotificationsPage` was a preference panel for a feature that was
  never built. CLAUDE.md named it under *Known defects*.

  ## What this adds

    public.notification_deliveries          one row per notification the job has
                                            claimed, and the whole dedupe rule
    public.notification_candidates(…)       the companies with something due,
                                            narrowed in SQL, paged
    public.notification_delivery_claim(…)   claim one notification, or answer
                                            NULL because it is already claimed
    public.notification_delivery_settle(…)  record how the send went

  The three functions are `service_role` only. The job is the edge function
  `notify-expiries`, called by a host cron line with the service key; the
  selection rules live in `supabase/functions/_shared/notification-core.ts` so
  they can be unit-tested without a database.

  ## Decision 1 — the dedupe key is the occurrence, never the day of the run

  `UNIQUE (company_id, notification_type, target_id, period_key)`, and
  `period_key` is the **date the notification is about**: the car's
  `tuev_gueltig_bis`, or the company's `trial_end`, as a Europe/Berlin calendar
  day. It is never the date of the run.

  That is the answer to "is a re-notification ever correct":

    - A TÜV that expires and is never renewed keeps its date, so
      `tuev_abgelaufen` has one occurrence and is mailed **once**. Not once a
      night for as long as the car stands there — which is the failure mode that
      is worse than no feature at all.
    - A TÜV that is renewed gets a new `tuev_gueltig_bis`, which is a new
      occurrence: the company is warned again 60 days before the new date and
      told again if that one lapses too. Expire → renew → expire mails three
      times, once per fact.
    - The two TÜV types are separate occurrences of the same date, so a car
      warned at 60 days is still told on the day the date passes.
    - A trial that is extended gets a new `trial_end` and so a new occurrence.

  **The claim is taken before the mail is sent, and a failed send is never
  retried.** A row is inserted with `mail_sent` NULL, the mail goes out, and
  `notification_delivery_settle` records the outcome. If the worker dies in
  between, the row stands and the notification is lost — deliberately, because
  a duplicate is the worse failure and because the same rule makes two runs
  overlapping on one night harmless. A failure is visible: `mail_sent = false`
  with `settled_at` set, or `mail_sent IS NULL` where the job never came back.

  ## Decision 2 — the windows are the product's own numbers

  60 days for the TÜV warning and 7 for the trial. Both are already on screen —
  `getTuevStatus()` in `src/types/car.ts` turns the badge amber at 60 days, and
  `TrialBanner` at `days <= 7` — and both are what 20260502121504's own header
  documents for these very types. The mail and the screen must not disagree
  about the same car on the same day. The numbers are `TUEV_SOON_DAYS` and
  `TRIAL_SOON_DAYS` in `notification-core.ts` and are **passed into**
  `notification_candidates` rather than restated here, so there is one copy.

  ## Decision 3 — which companies are mailed, and the one exception

  `get_active_company_id()` answers a company only when

      approval_status = 'approved'
      AND status IN ('active', 'trial')
      AND subscription_status = 'active'
      AND (subscription_expires_at IS NULL OR … > now())

  The first two lines are a hard boundary here as well and are applied in SQL
  below: a company that was never approved, was rejected, or was suspended,
  archived or deleted is not a customer and receives nothing. Suspension in
  particular is an administrative block, and mailing through it would undo it.

  The last two lines are **not** applied, and that is the exception the task
  names. `trial_abgelaufen` is by definition a notification to a company whose
  access has just lapsed — requiring a live subscription would mean the one
  notification that exists to say "your access ended" could only be sent to
  companies whose access had not ended. `trial_bald_ablaufend` is the same
  problem one step earlier: `app_private.signup_insert_company` writes
  `subscription_status = 'inactive'`, so a company inside its trial has never
  had a live subscription and the mail would never be sent at all.

  So the subscription terms are applied **per type, in
  `notification-core.ts`**, where they belong:

    - both trial types require `NOT subscriptionIsActive(…)` — this is the
      paying-customer test, and it is the reason the whole feature is not a
      one-line query. `companies.status` stays `'trial'` for ever (signup writes
      it, `redeem_activation_code` never changes it), so judging a trial by
      `trial_end` alone mails "your trial is ending" to a customer who is
      paying. This codebase has made that mistake twice already, on the
      customer's overview and on the platform dashboard, and a mail cannot be
      corrected by a reload.
    - the two TÜV types are about a vehicle, not about billing, and are sent to
      any approved, unsuspended company that has the type switched on.

  ## Decision 4 — the table is written by the job and by nobody else

  There is no INSERT, UPDATE or DELETE policy on `notification_deliveries` and
  no grant for `authenticated` beyond SELECT. A client cannot write it at all,
  so it carries **neither** `refuse_read_only_context_write` **nor**
  `record_support_write`: that pair is derived from the set of tables a client
  writes, and `tests/rls/support-write-audit.sql` checks the two together, so a
  table with neither is simply not in that set. The two writers are SECURITY
  DEFINER functions granted to `service_role` alone, and a support session
  writes nothing here because nothing but those functions writes here.

  SELECT is the ordinary business shape, so a company can be shown its own
  notification history later without another migration, and so the tenant
  isolation is testable. `platform_reads_company_data()` is `SELECT false`
  (20260917140000), so platform staff read it only inside an open context, like
  every other business table.

  ## Not in this slice

  The wording is fixed German in `supabase/functions/_shared/notification-mail.ts`.
  Making it editable from the panel means a `mail.template.*` key, and a key
  means restating `app_private.platform_settings_problem` with every existing
  branch carried over character for character. That is a slice of its own.
*/

\set ON_ERROR_STOP on

-- ─── 1. The table ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notification_deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  notification_type text NOT NULL,
  -- The car for a TÜV type, the company itself for a trial one. No foreign key:
  -- it points at two tables, and a car deleted after its warning must not take
  -- the record of that warning with it.
  target_id         uuid NOT NULL,
  -- The Europe/Berlin calendar day the notification is *about*: see decision 1.
  period_key        text NOT NULL,
  claimed_at        timestamptz NOT NULL DEFAULT now(),
  settled_at        timestamptz,
  -- NULL while claimed and not yet settled; false when the send failed.
  mail_sent         boolean,
  recipient_count   integer NOT NULL DEFAULT 0,
  CONSTRAINT notification_deliveries_type_check
    CHECK (notification_type IN ('tuev_bald_ablaufend', 'tuev_abgelaufen',
                                 'trial_bald_ablaufend', 'trial_abgelaufen')),
  CONSTRAINT notification_deliveries_period_check
    CHECK (period_key ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT notification_deliveries_recipients_check
    CHECK (recipient_count >= 0),
  -- The dedupe rule itself. It is a constraint and not a query, so two runs
  -- overlapping on one night cannot both claim the same notification.
  CONSTRAINT notification_deliveries_once
    UNIQUE (company_id, notification_type, target_id, period_key)
);

CREATE INDEX IF NOT EXISTS notification_deliveries_company_idx
  ON public.notification_deliveries (company_id, claimed_at DESC);

-- The candidate query reads the cars of one page of companies by their TÜV
-- date. Without this it is a sequential scan of every car in the installation,
-- once a night.
CREATE INDEX IF NOT EXISTS cars_company_tuev_idx
  ON public.cars (company_id, tuev_gueltig_bis)
  WHERE tuev_gueltig_bis IS NOT NULL;

COMMENT ON TABLE public.notification_deliveries IS
  'One row per notification the nightly job has claimed. The unique constraint is the dedupe rule: one mail per occurrence, where an occurrence is the date the notification is about.';

-- ─── 2. The tenant shape ────────────────────────────────────────────────────
--
-- SELECT only, in the shape of 20260917130000. There is deliberately no write
-- policy (decision 4), so a move between companies is refused for having no
-- UPDATE policy at all rather than by a WITH CHECK clause.

ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;

DO $mig$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'notification_deliveries'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.notification_deliveries', p.policyname);
  END LOOP;

  EXECUTE
    'CREATE POLICY notification_deliveries_select ON public.notification_deliveries '
    'FOR SELECT TO authenticated USING ('
    'company_id = (SELECT public.get_active_company_id()) '
    'OR (SELECT public.platform_reads_company_data()))';
END $mig$;

-- ─── 3. The candidate query ─────────────────────────────────────────────────

/*
  The companies with something that might be due, one row each, paged.

  What is decided here and what is decided in TypeScript is the whole shape of
  this feature:

    here    the hard boundary (approved, not suspended/archived/deleted), the
            narrowing that keeps the query from reading every car in the
            installation, and the paging
    there   the arithmetic (how many days), the subscription question, the
            settings fallback and the dedupe comparison

  `p_tuev_soon_days` is `TUEV_SOON_DAYS` passed in from notification-core.ts,
  so the window has one definition. A car outside it is not returned; the
  caller still re-derives which of the two TÜV types applies, because the
  boundary between them (`daysLeft < 0`) is the screen's own and must not be
  spelled twice.

  `sent` is narrowed to the targets of this company that are actually in play,
  so a company with ten years of history does not carry ten years of rows into
  the worker every night.

  It is a read, and it is STABLE: it writes nothing and records nothing. There
  is no audit row because there is no actor — the caller is a cron line holding
  the service key, and `app_private.audit_write` has no role to record for it.
*/
CREATE OR REPLACE FUNCTION public.notification_candidates(
  p_tuev_soon_days integer,
  p_limit          integer DEFAULT 100,
  p_after          uuid    DEFAULT NULL
)
RETURNS TABLE (
  company_id              uuid,
  company_name            text,
  trial_end               timestamptz,
  subscription_status     text,
  subscription_expires_at timestamptz,
  settings                jsonb,
  cars                    jsonb,
  sent                    jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_limit integer;
  v_today date;
BEGIN
  IF p_tuev_soon_days IS NULL OR p_tuev_soon_days < 0 OR p_tuev_soon_days > 3650 THEN
    RAISE EXCEPTION 'notification_candidates: p_tuev_soon_days must be between 0 and 3650'
      USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NOT NULL AND (p_limit < 1 OR p_limit > 500) THEN
    RAISE EXCEPTION 'notification_candidates: p_limit must be between 1 and 500'
      USING ERRCODE = '22023';
  END IF;

  v_limit := COALESCE(p_limit, 100);
  -- The job's own day, in the product's zone, so the narrowing and the
  -- arithmetic in the worker agree about which day it is.
  v_today := (now() AT TIME ZONE 'Europe/Berlin')::date;

  RETURN QUERY
  WITH page AS (
    SELECT c.id, c.name, c.trial_end, c.subscription_status, c.subscription_expires_at
      FROM public.companies c
     WHERE c.approval_status = 'approved'
       -- A suspended, archived, inactive or deleted company is administratively
       -- blocked; mailing through that block would undo it.
       AND c.status IN ('active', 'trial')
       AND (p_after IS NULL OR c.id > p_after)
       AND (
             c.trial_end IS NOT NULL
             OR EXISTS (
                  SELECT 1 FROM public.cars v
                   WHERE v.company_id = c.id
                     AND v.tuev_gueltig_bis IS NOT NULL
                     AND v.tuev_gueltig_bis <= v_today + p_tuev_soon_days
                )
           )
     ORDER BY c.id
     LIMIT v_limit
  ),
  -- One grouped pass per table over the page, never a subquery per company.
  page_settings AS (
    SELECT s.company_id,
           jsonb_agg(jsonb_build_object(
             'notification_type',    s.notification_type,
             'enabled',              s.enabled,
             'email_global_enabled', s.email_global_enabled)
             ORDER BY s.notification_type) AS rows
      FROM public.notification_settings s
      JOIN page ON page.id = s.company_id
     GROUP BY s.company_id
  ),
  page_cars AS (
    SELECT v.company_id,
           jsonb_agg(jsonb_build_object(
             'id',               v.id,
             'kennzeichen',      v.kennzeichen,
             'tuev_gueltig_bis', to_char(v.tuev_gueltig_bis, 'YYYY-MM-DD'))
             ORDER BY v.tuev_gueltig_bis, v.id) AS rows
      FROM public.cars v
      JOIN page ON page.id = v.company_id
     WHERE v.tuev_gueltig_bis IS NOT NULL
       AND v.tuev_gueltig_bis <= v_today + p_tuev_soon_days
     GROUP BY v.company_id
  ),
  page_sent AS (
    SELECT d.company_id,
           jsonb_agg(jsonb_build_object(
             'notification_type', d.notification_type,
             'target_id',         d.target_id,
             'period_key',        d.period_key)) AS rows
      FROM public.notification_deliveries d
      JOIN page ON page.id = d.company_id
     WHERE d.target_id = d.company_id
        OR EXISTS (SELECT 1 FROM public.cars v
                    WHERE v.id = d.target_id AND v.company_id = d.company_id)
     GROUP BY d.company_id
  )
  SELECT page.id, page.name, page.trial_end, page.subscription_status,
         page.subscription_expires_at,
         COALESCE(page_settings.rows, '[]'::jsonb),
         COALESCE(page_cars.rows,     '[]'::jsonb),
         COALESCE(page_sent.rows,     '[]'::jsonb)
    FROM page
    LEFT JOIN page_settings ON page_settings.company_id = page.id
    LEFT JOIN page_cars     ON page_cars.company_id     = page.id
    LEFT JOIN page_sent     ON page_sent.company_id     = page.id
   ORDER BY page.id;
END $fn$;

-- ─── 4. Claiming and settling ───────────────────────────────────────────────

/*
  Claim one notification, or answer NULL because it is already claimed.

  The company boundary is checked again here, and not only in the candidate
  query: this function's only caller is a cron line holding the service key,
  and a claim is what makes a mail go out. A blocked company must not become
  mailable through a stale plan the worker is still walking.
*/
CREATE OR REPLACE FUNCTION public.notification_delivery_claim(
  p_company_id        uuid,
  p_notification_type text,
  p_target_id         uuid,
  p_period_key        text
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
    RAISE EXCEPTION 'notification_delivery_claim: company and target are required'
      USING ERRCODE = '22023';
  END IF;
  IF p_notification_type IS NULL
     OR p_notification_type NOT IN ('tuev_bald_ablaufend', 'tuev_abgelaufen',
                                    'trial_bald_ablaufend', 'trial_abgelaufen') THEN
    RAISE EXCEPTION 'notification_delivery_claim: unknown notification type'
      USING ERRCODE = '22023';
  END IF;
  IF p_period_key IS NULL OR p_period_key !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'notification_delivery_claim: period key must be YYYY-MM-DD'
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

  -- The target belongs to the company, or there is nothing to notify about.
  IF p_target_id <> p_company_id
     AND NOT EXISTS (SELECT 1 FROM public.cars v
                      WHERE v.id = p_target_id AND v.company_id = p_company_id) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.notification_deliveries
    (company_id, notification_type, target_id, period_key)
  VALUES (p_company_id, p_notification_type, p_target_id, p_period_key)
  ON CONFLICT ON CONSTRAINT notification_deliveries_once DO NOTHING
  RETURNING id INTO v_id;

  -- NULL means somebody already holds this occurrence: the previous run, or a
  -- second run started while this one was walking its plan. Either way it is
  -- not sent twice.
  RETURN v_id;
END $fn$;

/*
  Record how the send went. Settles a row once; a second call changes nothing,
  so a retry of the settle cannot turn a recorded failure into a success.
*/
CREATE OR REPLACE FUNCTION public.notification_delivery_settle(
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
    RAISE EXCEPTION 'notification_delivery_settle: id and outcome are required'
      USING ERRCODE = '22023';
  END IF;
  IF p_recipient_count IS NULL OR p_recipient_count < 0 THEN
    RAISE EXCEPTION 'notification_delivery_settle: recipient count must not be negative'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.notification_deliveries
     SET mail_sent       = p_mail_sent,
         recipient_count = p_recipient_count,
         settled_at      = now()
   WHERE id = p_id
     AND settled_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  -- False means the row was settled already: a second call never turns a
  -- recorded failure into a success.
  RETURN v_rows > 0;
END $fn$;

-- ─── 5. Ownership and privileges ────────────────────────────────────────────

ALTER FUNCTION public.notification_candidates(integer, integer, uuid)          OWNER TO CURRENT_USER;
ALTER FUNCTION public.notification_delivery_claim(uuid, text, uuid, text)      OWNER TO CURRENT_USER;
ALTER FUNCTION public.notification_delivery_settle(uuid, boolean, integer)     OWNER TO CURRENT_USER;

-- Supabase's default privileges grant EXECUTE on every new public function to
-- PUBLIC, anon, authenticated and service_role. Revoking from `authenticated`
-- alone is the mistake 20260911120000 made: anon kept EXECUTE and the
-- function's own guard was the only barrier left. All three go.
REVOKE ALL ON FUNCTION public.notification_candidates(integer, integer, uuid)      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.notification_delivery_claim(uuid, text, uuid, text)  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.notification_delivery_settle(uuid, boolean, integer) FROM PUBLIC, anon, authenticated, service_role;

-- The job, and nothing else. service_role carries no `auth.uid()`, so these
-- three are the only door and the edge function's own bearer check is what
-- stands in front of it.
GRANT EXECUTE ON FUNCTION public.notification_candidates(integer, integer, uuid)      TO service_role;
GRANT EXECUTE ON FUNCTION public.notification_delivery_claim(uuid, text, uuid, text)  TO service_role;
GRANT EXECUTE ON FUNCTION public.notification_delivery_settle(uuid, boolean, integer) TO service_role;

-- The table itself: read by the owning company through RLS, written by nobody.
REVOKE ALL ON TABLE public.notification_deliveries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.notification_deliveries TO authenticated;

-- ─── 6. Self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_wrong text;
  v_n     integer;
BEGIN
  -- 1. RLS on, and exactly one policy: the business SELECT shape.
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.notification_deliveries'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'notification self-check: notification_deliveries has row level security off';
  END IF;

  SELECT string_agg(policyname || ' (' || cmd || ')', ', ')
    INTO v_wrong
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'notification_deliveries'
     AND policyname <> 'notification_deliveries_select';
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'notification self-check: the job writes this table, so SELECT is the only policy it may carry; found %', v_wrong;
  END IF;

  SELECT qual INTO v_wrong FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'notification_deliveries'
     AND policyname = 'notification_deliveries_select';
  IF v_wrong IS NULL
     OR v_wrong NOT LIKE '%get_active_company_id%'
     OR v_wrong NOT LIKE '%platform_reads_company_data%' THEN
    RAISE EXCEPTION 'notification self-check: the SELECT policy is not the tenant shape of 20260917130000: %',
      coalesce(v_wrong, '<missing>');
  END IF;

  -- 2. Table privileges: authenticated reads and nothing more, anon and the
  --    service role hold nothing at all.
  IF has_table_privilege('anon', 'public.notification_deliveries', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('service_role', 'public.notification_deliveries', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('authenticated', 'public.notification_deliveries', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.notification_deliveries', 'SELECT') THEN
    RAISE EXCEPTION 'notification self-check: the table privileges must be authenticated SELECT only, anon none, service_role none';
  END IF;

  -- 3. The three functions: SECURITY DEFINER, a pinned search_path, EXECUTE for
  --    service_role alone. anon in particular: Supabase grants it by default.
  SELECT string_agg(v.sig, ', ')
    INTO v_wrong
    FROM (VALUES
      ('public.notification_candidates(integer, integer, uuid)'),
      ('public.notification_delivery_claim(uuid, text, uuid, text)'),
      ('public.notification_delivery_settle(uuid, boolean, integer)')
    ) AS v(sig)
   WHERE has_function_privilege('anon',          to_regprocedure(v.sig), 'EXECUTE')
      OR has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE')
      OR NOT has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE');
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'notification self-check: EXECUTE must be service_role only on %', v_wrong;
  END IF;

  SELECT string_agg(p.proname, ', ')
    INTO v_wrong
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('notification_candidates', 'notification_delivery_claim',
                       'notification_delivery_settle')
     AND (NOT p.prosecdef
          OR p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
          OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c
                          WHERE c LIKE 'search\_path=%'));
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'notification self-check: % must be LANGUAGE plpgsql, SECURITY DEFINER with a pinned search_path', v_wrong;
  END IF;

  -- 4. The dedupe rule is a constraint, not a convention.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.notification_deliveries'::regclass
       AND conname = 'notification_deliveries_once'
       AND contype = 'u'
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(conkey) AS k(attnum)
              JOIN pg_attribute a ON a.attrelid = conrelid AND a.attnum = k.attnum)
           = ARRAY['company_id', 'notification_type', 'period_key', 'target_id']
  ) THEN
    RAISE EXCEPTION 'notification self-check: the dedupe rule must be a UNIQUE constraint on (company_id, notification_type, target_id, period_key)';
  END IF;

  -- 5. No client-write triggers, because no client writes it. The pair is
  --    derived from the tables a client writes and is checked together by
  --    tests/rls/support-write-audit.sql; carrying one of them here would fail
  --    that file for a table nothing can write anyway.
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.notification_deliveries'::regclass AND NOT tgisinternal;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'notification self-check: notification_deliveries carries % trigger(s); it is written by the job alone', v_n;
  END IF;

  -- 6. The candidate query must not have acquired a subscription term. The two
  --    trial types are precisely notifications to a company whose subscription
  --    is not live, and a term here would silence them for ever.
  SELECT p.prosrc INTO v_wrong FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'notification_candidates';
  IF v_wrong LIKE '%subscription_status =%' OR v_wrong LIKE '%get_active_company_id%' THEN
    RAISE EXCEPTION 'notification self-check: the candidate query must not gate on the subscription — see decision 3 in the header';
  END IF;
  IF v_wrong NOT LIKE '%approval_status%' OR v_wrong NOT LIKE '%active%' THEN
    RAISE EXCEPTION 'notification self-check: the candidate query has lost its approval/status boundary';
  END IF;

  RAISE NOTICE 'notification self-check: passed';
END $check$;
