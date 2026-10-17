/*
  The free trial goes (owner, 15.10.2026): "there is no 14 day try for free
  version." Access comes from an activation code or a period an operator
  recorded, and from nothing else.

  ─── Why this is mostly removal ──────────────────────────────────────────────

  The trial was already a lie on the server. A company that signs up was written
  `status = 'trial'` with a trial end, but `subscription_status = 'inactive'`,
  and `get_active_company_id()` requires `subscription_status = 'active'` and
  never reads `trial_end`. A trial company could open nothing; the browser held
  it on /abo-aktivieren. The panel's "+7 days" moved a date nothing read.

  ─── The one thing that could hurt: the paying companies ─────────────────────

  `get_active_company_id()` admits `companies.status IN ('active','trial')`.
  Measured on staging on 15.10.2026, out of 26 companies, seven sit on
  `status = 'trial'` while their subscription is live: they are paying, and
  their label was never moved off `trial` because `redeem_activation_code`
  writes the subscription columns and never `status`. Narrow the set before
  those rows move and all seven lose every read and write, silently.

  So the order is the design, and three things hold it:

    1. The rows move first. `app_private.companies_retire_trial_status()` sets
       every `status = 'trial'` row to `'active'` and nothing else. A paying
       company's access is unchanged by construction: the gate asks the
       subscription columns, which are not touched, and `active` is in both the
       old and the new set. A company whose trial lapsed with nothing replacing
       it had no access (subscription not active) and has none; only its label
       changed.
    2. The CHECK is narrowed after the rows moved, so a database that still
       holds a `trial` row refuses to apply this file instead of locking anyone.
    3. A snapshot taken before anything changes records every company the OLD
       rule admits; the self-check at the end fails the release if any of them
       is not admitted by the NEW rule. "Zero companies lose access" is a
       statement the migration checks about itself, not a promise in a header.

  ─── What changes ────────────────────────────────────────────────────────────

    - companies.status: `trial` is no longer a value (CHECK). Signup writes
      `active`, with no trial_start and no trial_end. Existing trial_start /
      trial_end values are left on their rows as history; nothing reads them.
    - get_active_company_id(): `status = 'active'`.
    - signup_insert_company(): no trial length. app_private.signup_trial_days()
      is dropped; the `trial` settings key stays stored (its validator is part
      of platform_settings_problem, which this change does not touch) and
      nothing reads it.
    - get_public_config() / get_app_config(): no `trial_days`.
    - platform_company_extend_trial(): dropped. platform_company_create() and
      platform_company_set_status() no longer accept `trial`.
    - Notifications: the types trial_bald_ablaufend and trial_abgelaufen are
      gone from notification_deliveries and notification_recipients (CHECKs),
      from notification_delivery_claim, and notification_candidates() no longer
      returns trial_end or the subscription columns. Existing rows naming a
      removed type are DELETED in this file: a delivery row is dedupe history
      for a mail that can no longer be sent, a recipient row is an address for
      a notice that no longer exists, and a notification_settings row is a
      switch for one. (Staging held one delivery and no recipient row.)

  ─── Deliberately left ───────────────────────────────────────────────────────

    - subscription_coverage.source keeps `trial`: it is history a CHECK on a
      table of past periods should not forget, and no row uses it.
    - The Abrechnung, Uber and income-import jobs still spell `status IN
      ('active','trial')` and a `status = 'trial' AND trial_end > now()`
      branch. With no row able to hold `trial` those terms are dead, they are
      large bodies owned by other features, and rewriting them here would risk
      more than it removes. They now agree with the gate.
    - platform_companies_list() still returns trial_start / trial_end /
      trial_state (a pinned read-model shape): trial_state is `none` for every
      row from now on.
    - signup_create_company / oauth_signup_create_company still put a
      `trial_end` key in their answer; it is null.
    - platform_rpc_response keeps its `no_trial` sentence, unreachable.

  ─── SCHEMA_EPOCH: bumped 2 -> 3 ─────────────────────────────────────────────

  This changes what the gate admits, narrows a CHECK, drops two functions and
  changes the answer shape of three RPCs. A rolled-back release would run
  against this database and could (a) write `status = 'trial'` through the
  panel's status menu or a company create, which the CHECK now refuses, and (b)
  read `trial_days` / `notification_candidates.trial_end`, which no longer
  exist. The way back is the pg_dump snapshot deploy.sh takes before
  migrations.

  Idempotent where it can be: re-running the data step changes nothing.
*/

-- ─── 0. The snapshot: who the OLD rule admits ───────────────────────────────

CREATE TEMP TABLE _ntr_before AS
SELECT c.id, c.status AS old_status
  FROM public.companies c
 WHERE c.approval_status = 'approved'
   AND c.status IN ('active', 'trial')
   AND c.subscription_status = 'active'
   AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now());

-- ─── 1. The rows move first ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.companies_retire_trial_status()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_rows integer;
BEGIN
  -- The label only. The subscription columns decide access and are not touched,
  -- which is why a paying company keeps its access through this statement.
  UPDATE public.companies SET status = 'active' WHERE status = 'trial';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $fn$;

REVOKE ALL ON FUNCTION app_private.companies_retire_trial_status() FROM PUBLIC, anon, authenticated, service_role;

DO $m$
DECLARE
  v_moved integer;
BEGIN
  v_moved := app_private.companies_retire_trial_status();
  RAISE NOTICE 'remove_free_trial: % company row(s) moved from status trial to active', v_moved;
END $m$;

-- ─── 2. The CHECK, after the rows ───────────────────────────────────────────

ALTER TABLE public.companies DROP CONSTRAINT companies_status_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_status_check
  CHECK (status = ANY (ARRAY['active', 'suspended', 'inactive', 'archived', 'deleted']));

-- ─── 3. A catalogue patcher for the bodies we change by a fragment ──────────
--
-- Each patched function is rewritten from its own live definition, so every
-- line this file does not mean to change is carried over byte for byte, and a
-- fragment that does not occur exactly once fails the release.

CREATE FUNCTION pg_temp._ntr_patch(p_function regprocedure, p_from text, p_to text)
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  -- Carriage returns out: a checkout with CRLF endings (a Windows `git archive`
  -- feeding the RLS kit) puts them into every function body, and a fragment
  -- written with LF would then never match. A no-op on a Linux release.
  v_def   text := replace(pg_get_functiondef(p_function), E'', '');
  v_found integer;
BEGIN
  v_found := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_found <> 1 THEN
    RAISE EXCEPTION 'remove_free_trial: fragment % occurs % times in %, expected exactly once',
      p_from, v_found, p_function;
  END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $fn$;

-- The gate.
SELECT pg_temp._ntr_patch('public.get_active_company_id()'::regprocedure,
  $$AND c.status IN ('active', 'trial')$$,
  $$AND c.status = 'active'$$);

-- Signup: no trial length, no trial dates, status active.
SELECT pg_temp._ntr_patch('app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)'::regprocedure,
  E'  -- Plan 3.10: the `trial` setting, through the one function that reads it.\n  -- Evaluated once per signup, so every row this call writes agrees.\n  v_trial_length  interval := make_interval(days => app_private.signup_trial_days());\n\n',
  '');
SELECT pg_temp._ntr_patch('app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)'::regprocedure,
  $$'trial', 'pending', v_plan$$,
  $$'active', 'pending', v_plan$$);
SELECT pg_temp._ntr_patch('app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)'::regprocedure,
  $$v_now, v_now + v_trial_length, 'Deutschland'$$,
  $$NULL, NULL, 'Deutschland'$$);

-- The two configuration answers.
SELECT pg_temp._ntr_patch('public.get_public_config()'::regprocedure,
  E'''price_book'', app_private.platform_setting_value(''price_book''),\n    ''trial_days'', app_private.signup_trial_days()',
  E'''price_book'', app_private.platform_setting_value(''price_book'')');
SELECT pg_temp._ntr_patch('public.get_app_config()'::regprocedure,
  E'    ''trial_days'',    app_private.signup_trial_days(),\n',
  '');

-- The panel's company status: `trial` is not a value any more.
SELECT pg_temp._ntr_patch('public.platform_company_set_status(uuid,text)'::regprocedure,
  $$NOT IN ('active', 'trial', 'suspended', 'inactive')$$,
  $$NOT IN ('active', 'suspended', 'inactive')$$);
SELECT pg_temp._ntr_patch('public.platform_company_create(text,text,text,text,text,text,text,text,text,text)'::regprocedure,
  $$NOT IN ('active', 'trial', 'suspended', 'inactive')$$,
  $$NOT IN ('active', 'suspended', 'inactive')$$);

-- ─── 4. Functions that go ───────────────────────────────────────────────────

DROP FUNCTION public.platform_company_extend_trial(uuid, integer);
DROP FUNCTION app_private.signup_trial_days();

-- ─── 5. The notification types ──────────────────────────────────────────────

DELETE FROM public.notification_deliveries
 WHERE notification_type IN ('trial_bald_ablaufend', 'trial_abgelaufen');
DELETE FROM public.notification_recipients
 WHERE notification_type IN ('trial_bald_ablaufend', 'trial_abgelaufen');
DELETE FROM public.notification_settings
 WHERE notification_type IN ('trial_bald_ablaufend', 'trial_abgelaufen');

ALTER TABLE public.notification_deliveries DROP CONSTRAINT notification_deliveries_type_check;
ALTER TABLE public.notification_deliveries ADD CONSTRAINT notification_deliveries_type_check
  CHECK (notification_type IN ('tuev_bald_ablaufend', 'tuev_abgelaufen'));

ALTER TABLE public.notification_recipients DROP CONSTRAINT notification_recipients_type_check;
ALTER TABLE public.notification_recipients ADD CONSTRAINT notification_recipients_type_check CHECK (notification_type IN (
    'tuev_bald_ablaufend', 'tuev_abgelaufen',
    'manager_summary'));

SELECT pg_temp._ntr_patch('public.notification_delivery_claim(uuid,text,uuid,text)'::regprocedure,
  E'''tuev_bald_ablaufend'', ''tuev_abgelaufen'',\n                                    ''trial_bald_ablaufend'', ''trial_abgelaufen'') THEN',
  '''tuev_bald_ablaufend'', ''tuev_abgelaufen'') THEN');
SELECT pg_temp._ntr_patch('public.notification_delivery_claim(uuid,text,uuid,text)'::regprocedure,
  $$AND c.status IN ('active', 'trial')$$,
  $$AND c.status = 'active'$$);

-- The candidate query changes its answer shape (no trial_end, no subscription
-- columns), which CREATE OR REPLACE cannot do, so it is dropped and rebuilt
-- with the grants of 20260924100000: the job (service_role) and nobody else.
DROP FUNCTION public.notification_candidates(integer, integer, uuid);

CREATE FUNCTION public.notification_candidates(
  p_tuev_soon_days integer,
  p_limit          integer DEFAULT 100,
  p_after          uuid    DEFAULT NULL
)
RETURNS TABLE (
  company_id   uuid,
  company_name text,
  settings     jsonb,
  cars         jsonb,
  sent         jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
-- The pragma has to be the first thing in the body. Two of this function's OUT
-- parameters (`company_id`, `cars`) share a name with a column or a table it
-- reads. Every reference below is qualified, so none is ambiguous today; this
-- keeps a later edit that drops an alias from resolving a column to an empty
-- OUT parameter instead of failing.
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
    SELECT c.id, c.name
      FROM public.companies c
     WHERE c.approval_status = 'approved'
       -- A suspended, archived, inactive or deleted company is administratively
       -- blocked; mailing through that block would undo it.
       AND c.status = 'active'
       AND (p_after IS NULL OR c.id > p_after)
       AND EXISTS (
             SELECT 1 FROM public.cars v
              WHERE v.company_id = c.id
                AND v.tuev_gueltig_bis IS NOT NULL
                AND v.tuev_gueltig_bis <= v_today + p_tuev_soon_days
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
             ORDER BY s.notification_type) AS items
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
             ORDER BY v.tuev_gueltig_bis, v.id) AS items
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
             'period_key',        d.period_key)) AS items
      FROM public.notification_deliveries d
      JOIN page ON page.id = d.company_id
     WHERE EXISTS (SELECT 1 FROM public.cars v
                    WHERE v.id = d.target_id AND v.company_id = d.company_id)
     GROUP BY d.company_id
  )
  SELECT page.id, page.name,
         COALESCE(page_settings.items, '[]'::jsonb),
         COALESCE(page_cars.items,     '[]'::jsonb),
         COALESCE(page_sent.items,     '[]'::jsonb)
    FROM page
    LEFT JOIN page_settings ON page_settings.company_id = page.id
    LEFT JOIN page_cars     ON page_cars.company_id     = page.id
    LEFT JOIN page_sent     ON page_sent.company_id     = page.id
   ORDER BY page.id;
END $fn$;

ALTER FUNCTION public.notification_candidates(integer, integer, uuid) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.notification_candidates(integer, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.notification_candidates(integer, integer, uuid) TO service_role;

-- ─── 6. Self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_lost    integer;
  v_before  integer;
  v_def     text;
  v_check   text;
BEGIN
  -- 1. The property this file exists for: no company the old rule admitted is
  --    refused by the new one.
  SELECT count(*) INTO v_before FROM _ntr_before;
  SELECT count(*) INTO v_lost
    FROM _ntr_before b
    JOIN public.companies c ON c.id = b.id
   WHERE NOT (c.approval_status = 'approved'
              AND c.status = 'active'
              AND c.subscription_status = 'active'
              AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now()));
  IF v_lost <> 0 THEN
    RAISE EXCEPTION 'remove_free_trial self-check 1: % of % admitted companies would lose access', v_lost, v_before;
  END IF;

  -- 2. No row can hold the old word, and the CHECK says so.
  IF EXISTS (SELECT 1 FROM public.companies WHERE status = 'trial') THEN
    RAISE EXCEPTION 'remove_free_trial self-check 2: a company is still on status trial';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_check FROM pg_constraint
   WHERE conrelid = 'public.companies'::regclass AND conname = 'companies_status_check';
  IF v_check IS NULL OR v_check LIKE '%trial%' OR v_check NOT LIKE '%archived%' THEN
    RAISE EXCEPTION 'remove_free_trial self-check 2: companies_status_check is %', v_check;
  END IF;

  -- 3. The gate is exactly status = 'active' and still asks the subscription.
  v_def := pg_get_functiondef('public.get_active_company_id()'::regprocedure);
  IF v_def LIKE '%trial%' OR v_def NOT LIKE '%c.status = ''active''%'
     OR v_def NOT LIKE '%c.subscription_status = ''active''%'
     OR v_def NOT LIKE '%c.approval_status = ''approved''%' THEN
    RAISE EXCEPTION 'remove_free_trial self-check 3: get_active_company_id() has the wrong shape';
  END IF;

  -- 4. Signup grants no trial.
  v_def := pg_get_functiondef('app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)'::regprocedure);
  IF v_def LIKE '%signup_trial_days%' OR v_def LIKE '%v_trial_length%' OR v_def LIKE '%''trial''%'
     OR v_def NOT LIKE '%''active'', ''pending'', v_plan%' THEN
    RAISE EXCEPTION 'remove_free_trial self-check 4: signup_insert_company still grants a trial';
  END IF;

  -- 5. The configuration answers no longer quote one, and the functions are gone.
  IF pg_get_functiondef('public.get_public_config()'::regprocedure) LIKE '%trial%'
     OR pg_get_functiondef('public.get_app_config()'::regprocedure) LIKE '%trial%' THEN
    RAISE EXCEPTION 'remove_free_trial self-check 5: a config answer still mentions the trial';
  END IF;
  IF to_regprocedure('app_private.signup_trial_days()') IS NOT NULL
     OR to_regprocedure('public.platform_company_extend_trial(uuid,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'remove_free_trial self-check 5: a trial function survived';
  END IF;

  -- 6. The panel cannot write the old word.
  IF pg_get_functiondef('public.platform_company_set_status(uuid,text)'::regprocedure) LIKE '%''trial''%'
     OR pg_get_functiondef('public.platform_company_create(text,text,text,text,text,text,text,text,text,text)'::regprocedure) LIKE '%''trial''%' THEN
    RAISE EXCEPTION 'remove_free_trial self-check 6: a panel RPC still accepts trial';
  END IF;

  -- 7. Notifications: no row, no CHECK, no function names a trial type.
  IF EXISTS (SELECT 1 FROM public.notification_deliveries WHERE notification_type LIKE 'trial%')
     OR EXISTS (SELECT 1 FROM public.notification_recipients WHERE notification_type LIKE 'trial%')
     OR EXISTS (SELECT 1 FROM public.notification_settings WHERE notification_type LIKE 'trial%') THEN
    RAISE EXCEPTION 'remove_free_trial self-check 7: a row still names a trial notification';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname IN ('notification_deliveries_type_check', 'notification_recipients_type_check')
                AND pg_get_constraintdef(oid) LIKE '%trial%') THEN
    RAISE EXCEPTION 'remove_free_trial self-check 7: a notification CHECK still names a trial type';
  END IF;
  IF pg_get_functiondef('public.notification_delivery_claim(uuid,text,uuid,text)'::regprocedure) LIKE '%trial%'
     OR pg_get_functiondef('public.notification_candidates(integer,integer,uuid)'::regprocedure) LIKE '%trial%' THEN
    RAISE EXCEPTION 'remove_free_trial self-check 7: a notification function still names the trial';
  END IF;

  -- 8. The rebuilt candidate query is the job's alone.
  IF has_function_privilege('anon', 'public.notification_candidates(integer,integer,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.notification_candidates(integer,integer,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.notification_candidates(integer,integer,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'remove_free_trial self-check 8: notification_candidates must be service_role only';
  END IF;
  IF has_function_privilege('anon', 'app_private.companies_retire_trial_status()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.companies_retire_trial_status()', 'EXECUTE') THEN
    RAISE EXCEPTION 'remove_free_trial self-check 8: the retire helper must be reachable by no API role';
  END IF;

  RAISE NOTICE 'remove_free_trial self-check: passed (% admitted compan(ies) kept their access)', v_before;
END $check$;

DROP TABLE _ntr_before;
