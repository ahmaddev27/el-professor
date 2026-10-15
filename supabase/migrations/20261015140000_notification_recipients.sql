/*
  # Who receives which company notice (owner request 15.10.2026)

  > In company settings the administrator chooses which e-mail addresses
  > receive which kind of notification, and may enter more than one address
  > per kind.

  ## The rule, already decided

  For each kind the administrator lists zero or more addresses. A kind with at
  least one address sends to exactly those. A kind with none falls back to what
  shipped before this: the company's single `company_settings.notification_email`
  when set (20261015100000), otherwise the active administrators. Nothing is
  migrated: every company starts with empty lists, so every mail goes where it
  went yesterday.

  ## The kinds, read from the code and not from the request

  Five. The four expiry notices `notification-core.ts` plans
  (tuev_bald_ablaufend, tuev_abgelaufen, trial_bald_ablaufend, trial_abgelaufen)
  and `manager_summary`, the weekly Abrechnung summary
  `abrechnung-delivery.ts` sends to the company. Those are the only two
  callers of `loadRecipients()`. Not here, because they address a person: the
  per-driver Abrechnung mail and its reminder (`drivers.email`), every
  one-time-code mail, the "your address changed" notice, `send-document` and the
  activation-code mail (the code's own `target_email`).

  The CHECK names the five. A sixth kind is a migration that widens it, the
  same release that teaches the job to ask for it.

  ## Storage: one row per address

  `public.notification_recipients (company_id, notification_type, email)`,
  unique on the company, the kind and `lower(email)`: Max@x.de and max@x.de are
  one mailbox, and a duplicate would mail it twice. The address shape is
  `company_settings_notification_email_shape`'s expression. A trigger trims the
  address before the CHECK looks at it and refuses an eleventh address for one
  kind: an administrator can already point company mail at any mailbox, and an
  unbounded list would let one account turn the product's sending reputation
  into a mail cannon. The count is not locked, so two concurrent inserts can
  reach eleven; the bound is a brake and not an invariant.

  ## Policies: the business shape, with the administrator gate

  Four policies, SELECT on the tenant term (or the read seam) with no role
  gate, every write the same predicate as USING and WITH CHECK plus
  `is_company_admin()`: this is company configuration like
  `notification_settings`, and deciding who receives the company's mail is more
  than any page's edit right. Both context triggers, derived from the policies
  rather than from who writes today.

  ## The audit decision: the address IS copied in the clear

  `support_write_redaction_pattern()` is a name rule, `email` matches none of its
  fragments, and this file does not restate it. So a support session's write is
  recorded with the address, as it is for `notification_email`. Reasons: the
  audit exists to say which recipient the operator added or removed, and
  "email: redacted" would make it unreadable; the operator saw the address on
  the screen in the same session; it is a mailbox the company chose to receive
  El-Professor's mail and not pay or an identifier; and the log's own
  retention (12 and 36 months) bounds it. Widening the pattern would be a
  data-protection decision of its own. The self-check pins the choice, so a
  later change to the pattern fails a release instead of silently dropping the
  address from the audit.

  ## The preview is restated again

  `abrechnung_schedule_preview` counts the manager-summary recipients in SQL
  (the rule written twice: here and in notification-recipients.ts). It now
  answers the list first, then the single address, then the administrators, and
  adds `manager_via_list`. Everything else, and its self-check, is carried over
  from 20261015100000.

  No SCHEMA_EPOCH bump: a new table and a function whose old answer keeps its
  shape; the previous release never reads either.
*/

CREATE TABLE IF NOT EXISTS public.notification_recipients (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  notification_type text        NOT NULL,
  email             text        NOT NULL,
  created_by        uuid        NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_recipients_type_check CHECK (notification_type IN (
    'tuev_bald_ablaufend', 'tuev_abgelaufen',
    'trial_bald_ablaufend', 'trial_abgelaufen',
    'manager_summary')),
  CONSTRAINT notification_recipients_email_shape
    CHECK (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_recipients_once
  ON public.notification_recipients (company_id, notification_type, lower(email));

COMMENT ON TABLE public.notification_recipients IS
  'Addresses that receive one kind of company notice (5 kinds: the four expiry notices and manager_summary). A kind with at least one row sends to exactly those; a kind with none falls back to company_settings.notification_email, then the active administrators.';

-- SECURITY INVOKER on purpose: the count runs under the caller's own policies,
-- so it cannot be used to count another company's rows. It names only public
-- and pg_catalog, because authenticated has no USAGE on app_private.
CREATE OR REPLACE FUNCTION app_private.notification_recipients_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.email := btrim(NEW.email);
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.uid();
    NEW.created_at := now();
    IF (SELECT count(*) FROM public.notification_recipients r
         WHERE r.company_id = NEW.company_id
           AND r.notification_type = NEW.notification_type) >= 10 THEN
      RAISE EXCEPTION 'notification_recipients: at most 10 addresses per kind'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS notification_recipients_guard ON public.notification_recipients;
CREATE TRIGGER notification_recipients_guard
  BEFORE INSERT OR UPDATE ON public.notification_recipients
  FOR EACH ROW EXECUTE FUNCTION app_private.notification_recipients_guard();

ALTER TABLE public.notification_recipients ENABLE ROW LEVEL SECURITY;

DO $mig$
DECLARE
  p        record;
  v_tenant constant text := 'company_id = (SELECT public.get_active_company_id())';
  v_reads  constant text := '(SELECT public.platform_reads_company_data())';
  v_writes constant text := '(SELECT public.platform_writes_company_data())';
  v_admin  constant text := '(SELECT public.is_company_admin())';
  v_where  text := v_tenant || ' AND ' || v_admin;
BEGIN
  FOR p IN
    SELECT policyname FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'notification_recipients'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.notification_recipients', p.policyname);
  END LOOP;

  EXECUTE format(
    'CREATE POLICY notification_recipients_select ON public.notification_recipients '
    'FOR SELECT TO authenticated USING (%s OR %s)', v_tenant, v_reads);
  EXECUTE format(
    'CREATE POLICY notification_recipients_insert ON public.notification_recipients '
    'FOR INSERT TO authenticated WITH CHECK ((%s) OR %s)', v_where, v_writes);
  EXECUTE format(
    'CREATE POLICY notification_recipients_update ON public.notification_recipients '
    'FOR UPDATE TO authenticated USING ((%s) OR %s) WITH CHECK ((%s) OR %s)',
    v_where, v_writes, v_where, v_writes);
  EXECUTE format(
    'CREATE POLICY notification_recipients_delete ON public.notification_recipients '
    'FOR DELETE TO authenticated USING ((%s) OR %s)', v_where, v_writes);

  DROP TRIGGER IF EXISTS refuse_read_only_context_write ON public.notification_recipients;
  CREATE TRIGGER refuse_read_only_context_write
    BEFORE INSERT OR UPDATE OR DELETE ON public.notification_recipients
    FOR EACH STATEMENT EXECUTE FUNCTION app_private.refuse_read_only_context_write();

  DROP TRIGGER IF EXISTS record_support_write ON public.notification_recipients;
  EXECUTE format(
    'CREATE TRIGGER record_support_write '
    'AFTER INSERT OR UPDATE OR DELETE ON public.notification_recipients '
    'FOR EACH ROW WHEN (current_setting(%L, true) <> %L) '
    'EXECUTE FUNCTION app_private.record_support_write()',
    'app_private.support_write_context', '');
END $mig$;

REVOKE ALL ON FUNCTION app_private.notification_recipients_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.notification_recipients FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notification_recipients TO authenticated;
-- The job reads it with the service key.
GRANT SELECT ON TABLE public.notification_recipients TO service_role;

DO $check$
DECLARE
  v_pol text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.notification_recipients'::regclass) THEN
    RAISE EXCEPTION 'notification_recipients self-check: RLS is off';
  END IF;
  SELECT string_agg(policyname, ',' ORDER BY policyname) INTO v_pol
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notification_recipients';
  IF v_pol IS DISTINCT FROM
     'notification_recipients_delete,notification_recipients_insert,notification_recipients_select,notification_recipients_update' THEN
    RAISE EXCEPTION 'notification_recipients self-check: policies are %', v_pol;
  END IF;
  IF has_table_privilege('anon', 'public.notification_recipients', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'notification_recipients self-check: anon holds a privilege';
  END IF;
  IF has_table_privilege('service_role', 'public.notification_recipients', 'INSERT,UPDATE,DELETE')
     OR NOT has_table_privilege('service_role', 'public.notification_recipients', 'SELECT') THEN
    RAISE EXCEPTION 'notification_recipients self-check: service_role must only read';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.notification_recipients'::regclass
         AND tgname IN ('refuse_read_only_context_write', 'record_support_write')) <> 2 THEN
    RAISE EXCEPTION 'notification_recipients self-check: a context trigger is missing';
  END IF;
  -- The guard must stay SECURITY INVOKER (its count runs under the caller's RLS).
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'app_private.notification_recipients_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'notification_recipients self-check: the guard must be SECURITY INVOKER';
  END IF;
  -- The audit decision of the header: the address is copied, not redacted.
  IF 'email' ~ app_private.support_write_redaction_pattern('notification_recipients') THEN
    RAISE EXCEPTION 'notification_recipients self-check: the redaction pattern now hides email; the header records the opposite decision';
  END IF;
  RAISE NOTICE 'notification_recipients self-check: passed';
END $check$;

CREATE OR REPLACE FUNCTION public.abrechnung_schedule_preview(p_week_monday date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
DECLARE
  v_company  uuid;
  v_schedule jsonb;
  v_key      text;
  v_rows     integer;
  v_drivers  jsonb;
  v_admins   integer;
  v_manager_claimed boolean;
  v_notify   text;
  v_listed   integer;
BEGIN
  IF p_week_monday IS NULL OR EXTRACT(dow FROM p_week_monday) <> 1 THEN
    RAISE EXCEPTION 'abrechnung_schedule_preview: the week must be named by its Monday'
      USING ERRCODE = '22023';
  END IF;

  v_company := public.get_active_company_id();
  IF v_company IS NULL OR NOT COALESCE(public.is_company_admin(), false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  v_key := to_char(p_week_monday, 'YYYY-MM-DD');

  SELECT jsonb_build_object(
           'driver_mail_enabled',     s.driver_mail_enabled,
           'manager_summary_enabled', s.manager_summary_enabled,
           'weekday',                 s.weekday,
           'send_time',               to_char(s.send_time, 'HH24:MI'))
    INTO v_schedule
    FROM public.abrechnung_schedules s
   WHERE s.company_id = v_company;

  -- The job's own rows for that week, classified by why a driver is not mailed.
  WITH f AS (
    SELECT * FROM public.abrechnung_week_figures(v_company, p_week_monday)
  ),
  classified AS (
    SELECT CASE
             WHEN f.match_count > 1 THEN 'ambiguous'
             WHEN f.match_count = 0 THEN 'no_driver'
             WHEN d.status IS DISTINCT FROM 'active' THEN 'inactive'
             WHEN btrim(COALESCE(d.email, '')) = '' THEN 'no_email'
             WHEN EXISTS (SELECT 1 FROM public.abrechnung_deliveries x
                           WHERE x.company_id = v_company AND x.kind = 'driver_abrechnung'
                             AND x.target_id = f.driver_id AND x.period_key = v_key)
                  THEN 'already_claimed'
             ELSE 'sendable'
           END AS bucket
      FROM f
      LEFT JOIN public.drivers d ON d.id = f.driver_id AND d.company_id = v_company
  )
  SELECT (SELECT count(*) FROM classified),
         jsonb_build_object(
           'sendable',        count(*) FILTER (WHERE bucket = 'sendable'),
           'ambiguous',       count(*) FILTER (WHERE bucket = 'ambiguous'),
           'no_driver',       count(*) FILTER (WHERE bucket = 'no_driver'),
           'inactive',        count(*) FILTER (WHERE bucket = 'inactive'),
           'no_email',        count(*) FILTER (WHERE bucket = 'no_email'),
           'already_claimed', count(*) FILTER (WHERE bucket = 'already_claimed'))
    INTO v_rows, v_drivers
    FROM classified;

  -- Decision 2 (20261004100000), then 20261015100000's override, then this
  -- file's: addresses listed for the manager summary win, then the single
  -- notification address, then the administrators. The rule is written twice,
  -- here and in notification-recipients.ts's chooseCompanyRecipients; change
  -- both together.
  SELECT count(DISTINCT lower(btrim(nr.email))) INTO v_listed
    FROM public.notification_recipients nr
   WHERE nr.company_id = v_company AND nr.notification_type = 'manager_summary';

  SELECT cs.notification_email INTO v_notify
    FROM public.company_settings cs WHERE cs.company_id = v_company;

  IF v_listed > 0 THEN
    v_admins := v_listed;
  ELSIF v_notify IS NOT NULL AND btrim(v_notify) <> '' THEN
    v_admins := 1;
  ELSE
    SELECT count(DISTINCT lower(btrim(u.email)))
      INTO v_admins
      FROM public.user_profiles up
      JOIN auth.users u ON u.id = up.user_id
     WHERE up.company_id = v_company
       AND up.role = 'admin'
       AND up.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM app_private.platform_staff ps WHERE ps.user_id = up.user_id)
       AND btrim(COALESCE(u.email, '')) <> ''
       AND u.email_confirmed_at IS NOT NULL
       AND u.deleted_at IS NULL
       AND (u.banned_until IS NULL OR u.banned_until <= now());
  END IF;

  v_manager_claimed := EXISTS (
    SELECT 1 FROM public.abrechnung_deliveries x
     WHERE x.company_id = v_company AND x.kind = 'manager_summary'
       AND x.target_id = v_company AND x.period_key = v_key);

  RETURN jsonb_build_object(
    'ok',                 true,
    'week_monday',        v_key,
    'schedule',           v_schedule,
    'rows',               v_rows,
    'drivers',            v_drivers,
    'manager_recipients', v_admins,
    'manager_claimed',    v_manager_claimed,
    'manager_via_list',    (v_listed > 0),
    'manager_via_address', (v_listed = 0 AND v_notify IS NOT NULL AND btrim(v_notify) <> ''));
END $fn$;

ALTER FUNCTION public.abrechnung_schedule_preview(date) OWNER TO CURRENT_USER;

-- anon too: Supabase's default privileges grant EXECUTE on every new public function to it.
REVOKE ALL ON FUNCTION public.abrechnung_schedule_preview(date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.abrechnung_schedule_preview(date) TO authenticated;

DO $check$
DECLARE
  v_sig  constant regprocedure := 'public.abrechnung_schedule_preview(date)'::regprocedure;
  v_proc pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO v_proc FROM pg_proc WHERE oid = v_sig;

  -- 1. It writes nothing: STABLE makes PostgreSQL refuse a write in its body.
  IF v_proc.provolatile <> 's' THEN
    RAISE EXCEPTION 'abrechnung preview self-check: must be STABLE so it cannot write';
  END IF;
  -- ... and its body names no write statement against any table.
  IF v_proc.prosrc ~* '(insert\s+into|update\s+public|delete\s+from|truncate)' THEN
    RAISE EXCEPTION 'abrechnung preview self-check: the body names a write statement';
  END IF;

  -- 2. SECURITY DEFINER, plpgsql, pinned search_path.
  IF NOT v_proc.prosecdef
     OR v_proc.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
     OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(v_proc.proconfig, ARRAY[]::text[])) c
                     WHERE c LIKE 'search\_path=%') THEN
    RAISE EXCEPTION 'abrechnung preview self-check: must be plpgsql SECURITY DEFINER with a pinned search_path';
  END IF;

  -- 3. Signed-in callers only.
  IF has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('service_role', v_sig, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'abrechnung preview self-check: EXECUTE must be authenticated only';
  END IF;

  -- 4. The gates: the active company helper and the administrator check, and
  --    never the staff flag.
  IF v_proc.prosrc !~ 'get_active_company_id'
     OR v_proc.prosrc !~ 'is_company_admin'
     OR v_proc.prosrc ~ 'is_user_super_admin|is_super_admin' THEN
    RAISE EXCEPTION 'abrechnung preview self-check: the company must come from get_active_company_id() behind is_company_admin()';
  END IF;

  -- 5. It asks the job's own function for the figures.
  IF v_proc.prosrc !~ 'abrechnung_week_figures' THEN
    RAISE EXCEPTION 'abrechnung preview self-check: the figures must come from abrechnung_week_figures';
  END IF;

  -- 6. The override this restatement exists for, and the column it reads.
  IF v_proc.prosrc !~ 'notification_email' OR v_proc.prosrc !~ 'manager_via_address' THEN
    RAISE EXCEPTION 'abrechnung preview self-check: the body must read company_settings.notification_email';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.company_settings'::regclass
                    AND conname = 'company_settings_notification_email_shape') THEN
    RAISE EXCEPTION 'abrechnung preview self-check: company_settings_notification_email_shape is missing';
  END IF;

  -- 7. This file's override: the listed addresses come first.
  IF v_proc.prosrc !~ 'notification_recipients' OR v_proc.prosrc !~ 'manager_via_list' THEN
    RAISE EXCEPTION 'abrechnung preview self-check: the body must read notification_recipients';
  END IF;

  RAISE NOTICE 'abrechnung preview self-check: passed';
END $check$;
