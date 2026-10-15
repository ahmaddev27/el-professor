/*
  # A company's notification address (owner request 15.10.2026)

  > "In the settings the admin shall be able to insert the email address where
  > the emails from El-Professor will be reached."

  ## Storage: `company_settings.notification_email`, nullable

  `company_settings` already has `email` and `support_email`, and neither is
  this: they are the company's contact details as printed on its documents, and
  reusing one would make an operator who corrects a letterhead redirect the
  company's mail. A column of its own says what it is for.

  ## The CHECK is `drivers_email_shape`'s, deliberately loose

  The same expression 20261002100000 uses for `drivers.email`: no whitespace,
  exactly one `@`, something on both sides and a dot after it. It refuses what
  cannot be an address and nothing more; a strict pattern refuses addresses that
  work. NULL is the one representation of "not set": the pattern does not match
  the empty string either, so an empty string cannot be stored and the browser
  sends NULL.

  ## Nothing a policy or trigger does is changed

  `company_settings` keeps its four policies (20260921110000, 20260923100000) and
  its three support-shell audit triggers. Adding a column alters none of them:
  the policies key on `company_id`, so a company administrator writes the new
  column under `company_settings_update` and nobody else does, and a support
  session's write is recorded by the same trigger as any other column. The audit
  copies the value in `values` like `company_name` and `support_email`:
  `support_write_redaction_pattern()` is a name rule, `notification_email`
  matches none of its fragments, and a company's contact address is not pay or a
  personal identifier. This file does not widen or narrow that function.

  ## The preview is restated, because it restates the recipient rule

  `abrechnung_schedule_preview` counts the administrators the manager summary
  goes to in SQL (its Decision 2: a rule "written twice"). The notification
  address *replaces* those administrators for company-level mail (see
  supabase/functions/_shared/notification-recipients.ts), so a company that has
  set one has exactly one recipient and the card must say so. The function is
  restated whole with that one change and a new key, `manager_via_address`;
  everything else, including its self-check, is carried over.

  No SCHEMA_EPOCH bump: a nullable column the previous release never names, and a
  function whose old answer keeps its shape.
*/

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS notification_email text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.company_settings'::regclass
       AND conname = 'company_settings_notification_email_shape'
  ) THEN
    ALTER TABLE public.company_settings
      ADD CONSTRAINT company_settings_notification_email_shape
      CHECK (
        notification_email IS NULL
        OR notification_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      );
  END IF;
END
$$;

COMMENT ON COLUMN public.company_settings.notification_email IS
  'Where El-Professor''s company-level mail goes (the Abrechnung summary, TUEV and trial notices). When set it REPLACES the administrators; when NULL they receive it. Driver mail is unaffected. NULL means not set; an empty string cannot be stored.';

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

  -- Decision 2 (20261004100000), then 20261015100000's override: a company that
  -- has named a notification address sends its manager summary there and to no
  -- administrator, so the count is one. The rule is written twice, here and in
  -- notification-recipients.ts's chooseCompanyRecipients; change both together.
  SELECT cs.notification_email INTO v_notify
    FROM public.company_settings cs WHERE cs.company_id = v_company;

  IF v_notify IS NOT NULL AND btrim(v_notify) <> '' THEN
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
    'manager_via_address', (v_notify IS NOT NULL AND btrim(v_notify) <> ''));
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

  RAISE NOTICE 'abrechnung preview self-check: passed';
END $check$;
