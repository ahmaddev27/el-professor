/*
  # What the next scheduled Abrechnung will actually do, asked by the settings screen

  ## Why

  The owner saved a Sunday 11:56 schedule and no mail arrived. The job was not
  broken: the week it covers held no bookings, so there was nothing to send, and
  the screen said nothing about that. A control that reports nothing reads as
  broken. The card now shows what the next send will do, and this function is
  where the figures come from.

  ## Decision 1 - the same statement the job runs, not a second computation

  `abrechnung_week_figures` is service_role only and is what the job reads. This
  function CALLS it (as a SECURITY DEFINER with the same owner), so which drivers
  have a row, how a name is matched to a driver and what counts as a booking are
  the job's own rules by construction. What it adds on top is classification
  only: for each row, why a driver would not be mailed. The week itself is named
  by the caller, because the Europe/Berlin arithmetic lives once, in
  supabase/functions/_shared/abrechnung-schedule-core.ts, and the browser reuses
  it from there (src/utils/abrechnungSchedulePreview.ts) rather than a third copy
  being written here.

  ## Decision 2 - the one rule that IS written twice: who the manager summary goes to

  The job asks GoTrue for each administrator through `loadRecipients()` and
  `selectActivationCodeRecipients()` (an active admin profile, not platform
  staff, a confirmed, undeleted, unbanned account, one address once). A SQL
  function cannot call that, so the count here restates it from `auth.users`.
  "Not platform staff" reads `app_private.platform_staff` (any row), not
  `user_profiles.is_super_admin`, which no function may name. If the TypeScript
  rule changes, change this one with it.

  ## Decision 3 - it writes nothing, and the database enforces that

  STABLE: PostgreSQL refuses any write inside it. No claim, no delivery row, no
  mail. The company is `get_active_company_id()` (never the membership), the gate
  is `is_company_admin()`, matching the schedule table's own write policies, and
  a refusal is a return value `{"ok": false, "reason": "not_authorized"}`.

  ## No SCHEMA_EPOCH bump: one new function, nothing existing is touched.
*/

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

  -- Decision 2: the administrators the summary would go to.
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
    'manager_claimed',    v_manager_claimed);
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

  RAISE NOTICE 'abrechnung preview self-check: passed';
END $check$;
