--
-- PostgreSQL database dump
--

\restrict cnziZ4Bj4I41BpHJJwDe5FjyXnu7yPHrr9AaRugsFkbMW8iJ6jJ25AWdYh5boGq

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: apply_monthly_planning_run(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_monthly_planning_run(p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
v_caller        uuid := auth.uid();
v_company       uuid;
v_import_id     uuid := (p_payload->>'import_id')::uuid;
v_month         int  := (p_payload->>'month')::int;
v_year          int  := (p_payload->>'year')::int;
v_run_id        uuid;
v_existing      RECORD;
v_updated_count int := 0;
v_skipped_canceled int := 0;
v_exception_count int := 0;
v_row jsonb;
v_exc jsonb;
v_trip_id uuid;
v_driver_id uuid;
v_now timestamptz := now();
v_verify_assigned int;
v_verify_canceled int;
v_verify_with_run int;
v_verify_exceptions int;
v_block_sep int := COALESCE((p_payload->>'block_separator_minutes')::int, 60);
v_min_block int := COALESCE((p_payload->>'min_block_duration_minutes')::int, 30);
v_max_block int := COALESCE((p_payload->>'max_block_duration_minutes')::int, 270);
BEGIN
IF v_caller IS NULL THEN
RAISE EXCEPTION 'apply_monthly_planning_run: unauthenticated';
END IF;

SELECT company_id INTO v_company
FROM user_profiles
WHERE user_id = v_caller;

IF v_company IS NULL THEN
RAISE EXCEPTION 'apply_monthly_planning_run: caller has no company';
END IF;

IF v_import_id IS NULL THEN
RAISE EXCEPTION 'apply_monthly_planning_run: import_id required';
END IF;

SELECT id, applied_at, applied_by
INTO v_existing
FROM company_planning_runs
WHERE company_id = v_company
AND import_id  = v_import_id
AND month      = v_month
AND year       = v_year
AND applied_at IS NOT NULL
ORDER BY applied_at DESC
LIMIT 1;

IF FOUND THEN
RETURN jsonb_build_object(
'success', false,
'already_applied', true,
'planning_run_id', v_existing.id,
'applied_at', v_existing.applied_at,
'applied_by', v_existing.applied_by,
'message', 'Für diesen Monat wurde bereits eine Planung angewendet.'
);
END IF;

INSERT INTO company_planning_runs (
company_id, month, year, import_id, status,
max_shift_minutes, summary_json, settings_json,
created_by, applied_at, applied_by, apply_summary_json
) VALUES (
v_company, v_month, v_year, v_import_id, 'applied',
v_max_block,
jsonb_build_object(
'source_file_name', p_payload->>'source_file_name',
'block_separator_minutes', v_block_sep,
'min_block_duration_minutes', v_min_block,
'max_block_duration_minutes', v_max_block,
'vehicle_blocks_count', (p_payload->>'vehicle_blocks_count')::int,
'assigned_blocks_count', (p_payload->>'assigned_blocks_count')::int,
'manual_exceptions_count', (p_payload->>'manual_exceptions_count')::int,
'dienstzeit_exceptions_count', (p_payload->>'dienstzeit_exceptions_count')::int,
'tageslimit_exceptions_count', (p_payload->>'tageslimit_exceptions_count')::int,
'monatslimit_exceptions_count', (p_payload->>'monatslimit_exceptions_count')::int
),
jsonb_build_object(
'block_separator_minutes', v_block_sep,
'min_block_duration_minutes', v_min_block,
'max_block_duration_minutes', v_max_block
),
v_caller,
v_now,
v_caller,
NULL
)
RETURNING id INTO v_run_id;

FOR v_row IN SELECT * FROM jsonb_array_elements(p_payload->'change_rows')
LOOP
v_trip_id   := (v_row->>'trip_id')::uuid;
v_driver_id := NULLIF(v_row->>'driver_id','')::uuid;

IF COALESCE((v_row->>'is_canceled')::bool, false) THEN
v_skipped_canceled := v_skipped_canceled + 1;
CONTINUE;
END IF;

UPDATE fahrtenbuch_trips ft
SET
assigned_driver_id        = v_driver_id,
assigned_driver_name      = v_row->>'driver_name',
assignment_source         = v_row->>'assignment_source',
assignment_block_id       = v_row->>'block_id',
assignment_planning_run_id = v_run_id,
assignment_applied_at     = v_now,
assignment_applied_by     = v_caller,
assignment_reason         = COALESCE(v_row->>'exception_reason', ft.assignment_reason),
plausibility_status       = CASE WHEN ft.plausibility_status = 'canceled'
THEN ft.plausibility_status
ELSE 'planned_reassignment' END,
confirmed_by              = v_caller,
confirmed_at              = v_now,
updated_at                = v_now
WHERE id          = v_trip_id
AND company_id  = v_company
AND is_canceled = false;

IF FOUND THEN
v_updated_count := v_updated_count + 1;
END IF;
END LOOP;

FOR v_exc IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'manual_exceptions', '[]'::jsonb)) LOOP
INSERT INTO monthly_planning_manual_exceptions (
planning_run_id, company_id, import_id, month, year,
block_id, vehicle_identifier, service_date,
block_start_datetime, block_end_datetime,
assigned_driver_id, assigned_driver_name,
dienstzeit_exception, tageslimit_exception, monatslimit_exception,
reason, confirmed_by, confirmed_at
) VALUES (
v_run_id, v_company, v_import_id, v_month, v_year,
v_exc->>'block_id', v_exc->>'vehicle_identifier',
(v_exc->>'service_date')::date,
(v_exc->>'block_start_datetime')::timestamptz,
(v_exc->>'block_end_datetime')::timestamptz,
NULLIF(v_exc->>'driver_id','')::uuid,
v_exc->>'driver_name',
COALESCE((v_exc->>'dienstzeit')::bool, false),
COALESCE((v_exc->>'tageslimit')::bool, false),
COALESCE((v_exc->>'monatslimit')::bool, false),
NULLIF(v_exc->>'reason',''), v_caller, v_now
);
v_exception_count := v_exception_count + 1;
END LOOP;

SELECT COUNT(*) INTO v_verify_assigned FROM fahrtenbuch_trips
WHERE company_id = v_company AND import_id = v_import_id AND is_canceled = false;
SELECT COUNT(*) INTO v_verify_canceled FROM fahrtenbuch_trips
WHERE company_id = v_company AND import_id = v_import_id AND is_canceled = true;
SELECT COUNT(*) INTO v_verify_with_run FROM fahrtenbuch_trips
WHERE company_id = v_company AND import_id = v_import_id AND assignment_planning_run_id = v_run_id;
SELECT COUNT(*) INTO v_verify_exceptions FROM monthly_planning_manual_exceptions
WHERE planning_run_id = v_run_id;

UPDATE company_planning_runs
SET apply_summary_json = jsonb_build_object(
'updated_trips', v_updated_count,
'skipped_canceled', v_skipped_canceled,
'manual_exceptions_saved', v_exception_count,
'verify_assigned_in_import', v_verify_assigned,
'verify_canceled_in_import', v_verify_canceled,
'verify_rows_with_run', v_verify_with_run,
'verify_exceptions_in_run', v_verify_exceptions,
'dienstzeit_exceptions_count', (p_payload->>'dienstzeit_exceptions_count')::int,
'tageslimit_exceptions_count', (p_payload->>'tageslimit_exceptions_count')::int,
'monatslimit_exceptions_count', (p_payload->>'monatslimit_exceptions_count')::int,
'block_separator_minutes', v_block_sep,
'min_block_duration_minutes', v_min_block,
'max_block_duration_minutes', v_max_block
),
updated_at = v_now
WHERE id = v_run_id;

RETURN jsonb_build_object(
'success', true,
'already_applied', false,
'planning_run_id', v_run_id,
'updated_trips', v_updated_count,
'skipped_canceled', v_skipped_canceled,
'manual_exceptions_saved', v_exception_count,
'applied_at', v_now,
'applied_by', v_caller,
'verify_assigned_in_import', v_verify_assigned,
'verify_canceled_in_import', v_verify_canceled,
'verify_rows_with_run', v_verify_with_run,
'verify_exceptions_in_run', v_verify_exceptions,
'block_separator_minutes', v_block_sep,
'min_block_duration_minutes', v_min_block,
'max_block_duration_minutes', v_max_block
);
END;
$$;


--
-- Name: check_max_drivers_per_car(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_max_drivers_per_car() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
driver_count INTEGER;
BEGIN
SELECT COUNT(*) INTO driver_count
FROM car_driver_assignments
WHERE car_id = NEW.car_id;

IF driver_count >= 4 THEN
RAISE EXCEPTION 'A vehicle can have a maximum of 4 drivers (2 Hauptfahrer + 2 Deckungsfahrer)';
END IF;

RETURN NEW;
END;
$$;


--
-- Name: create_user_account(text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_user_account(user_email text, user_password text, user_full_name text, user_role text) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  new_user_id UUID;
  result JSON;
BEGIN
  -- Only allow support admin to call this function
  IF auth.email() != 'support@yamobility.de' THEN
    RAISE EXCEPTION 'Access denied: Only support admin can create users';
  END IF;

  -- Note: This function will return instructions for manual user creation
  -- since we cannot create auth users directly from SQL
  result := json_build_object(
    'success', false,
    'message', 'User creation must be done through Supabase Dashboard or Admin API',
    'instructions', 'Please create user manually in Supabase Dashboard with email: ' || user_email
  );

  RETURN result;
END;
$$;


--
-- Name: create_user_profile(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_user_profile() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
INSERT INTO public.user_profiles (
user_id,
email,
full_name,
role,
created_at,
updated_at
) VALUES (
NEW.id,
NEW.email,
COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
CASE 
WHEN NEW.email = 'support@yamobility.de' THEN 'admin'
ELSE 'viewer'
END,
NOW(),
NOW()
)
ON CONFLICT (user_id) DO UPDATE SET
email = EXCLUDED.email,
full_name = COALESCE(EXCLUDED.full_name, user_profiles.full_name),
updated_at = NOW();

RETURN NEW;
EXCEPTION
WHEN OTHERS THEN
RAISE WARNING 'Failed to create user profile for user %: %', NEW.id, SQLERRM;
RETURN NEW;
END;
$$;


--
-- Name: create_user_profile_manual(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_user_profile_manual(p_user_id uuid, p_full_name text, p_role text DEFAULT 'viewer'::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
IF NOT public.is_user_super_admin() THEN
RAISE EXCEPTION 'Access denied: only super admins can call create_user_profile_manual';
END IF;

INSERT INTO public.user_profiles (user_id, full_name, role)
VALUES (p_user_id, p_full_name, p_role)
ON CONFLICT (user_id) DO UPDATE SET
full_name  = EXCLUDED.full_name,
role       = EXCLUDED.role,
updated_at = now();
END;
$$;


--
-- Name: delete_activation_code(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_activation_code(p_code_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
v_caller_id   uuid := auth.uid();
v_is_super    boolean;
v_code        activation_codes%ROWTYPE;
BEGIN
SELECT is_super_admin INTO v_is_super
FROM user_profiles WHERE user_id = v_caller_id;
IF NOT COALESCE(v_is_super, false) THEN
RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert');
END IF;

SELECT * INTO v_code FROM activation_codes WHERE id = p_code_id;
IF NOT FOUND THEN
RETURN jsonb_build_object('success', false, 'error', 'Code nicht gefunden');
END IF;
IF v_code.used_at IS NOT NULL OR v_code.used_company_id IS NOT NULL THEN
RETURN jsonb_build_object('success', false, 'error', 'Verwendete Codes können nicht gelöscht werden');
END IF;
IF v_code.deleted_at IS NOT NULL THEN
RETURN jsonb_build_object('success', false, 'error', 'Code wurde bereits gelöscht');
END IF;

UPDATE activation_codes
SET deleted_at = now(), deleted_by = v_caller_id
WHERE id = p_code_id;

RETURN jsonb_build_object('success', true);
END;
$$;


--
-- Name: delete_or_archive_monthly_planning_run(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_or_archive_monthly_planning_run(p_run_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
v_caller   uuid := auth.uid();
v_company  uuid;
v_run      RECORD;
v_ref_cnt  int;
v_exc_cnt  int;
v_now      timestamptz := now();
BEGIN
IF v_caller IS NULL THEN
RAISE EXCEPTION 'delete_or_archive_monthly_planning_run: unauthenticated';
END IF;
SELECT company_id INTO v_company FROM user_profiles WHERE user_id = v_caller;
IF v_company IS NULL THEN
RAISE EXCEPTION 'delete_or_archive_monthly_planning_run: caller has no company';
END IF;

SELECT id, company_id, status INTO v_run FROM company_planning_runs WHERE id = p_run_id;
IF NOT FOUND THEN
RAISE EXCEPTION 'delete_or_archive_monthly_planning_run: run not found';
END IF;
IF v_run.company_id <> v_company THEN
RAISE EXCEPTION 'delete_or_archive_monthly_planning_run: run does not belong to caller company';
END IF;

SELECT COUNT(*) INTO v_ref_cnt
FROM fahrtenbuch_trips
WHERE company_id = v_company AND assignment_planning_run_id = p_run_id;

IF v_ref_cnt > 0 THEN
UPDATE company_planning_runs
SET status = 'archived', updated_at = v_now
WHERE id = p_run_id;
RETURN jsonb_build_object('action', 'archived', 'referenced_trips', v_ref_cnt);
END IF;

SELECT COUNT(*) INTO v_exc_cnt
FROM monthly_planning_manual_exceptions
WHERE planning_run_id = p_run_id;

DELETE FROM monthly_planning_manual_exceptions WHERE planning_run_id = p_run_id;
DELETE FROM company_planning_runs WHERE id = p_run_id;

RETURN jsonb_build_object(
'action', 'deleted',
'referenced_trips', 0,
'deleted_exceptions', v_exc_cnt
);
END;
$$;


--
-- Name: enforce_car_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_car_limit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
car_limit   integer;
active_cars integer;
BEGIN
-- Only enforce when the car is active (not being deactivated)
IF NEW.status IS NOT DISTINCT FROM 'inactive' THEN
RETURN NEW;
END IF;

-- Get the company's car limit
SELECT subscription_car_limit INTO car_limit
FROM companies
WHERE id = NEW.company_id;

IF car_limit IS NULL THEN
RETURN NEW; -- No limit set, allow
END IF;

-- Count currently active cars for this company (excluding this row on UPDATE)
SELECT COUNT(*) INTO active_cars
FROM cars
WHERE company_id = NEW.company_id
AND status IS DISTINCT FROM 'inactive'
AND id IS DISTINCT FROM NEW.id;

IF active_cars >= car_limit THEN
RAISE EXCEPTION 'Fahrzeuglimit erreicht. Ihr Abonnement erlaubt maximal % aktive Fahrzeuge.', car_limit
USING ERRCODE = 'P0001';
END IF;

RETURN NEW;
END;
$$;


--
-- Name: enforce_driver_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_driver_limit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
car_limit      integer;
dpc_limit      integer;
driver_limit   integer;
active_drivers integer;
BEGIN
IF NEW.status IS NOT DISTINCT FROM 'inactive' THEN
RETURN NEW;
END IF;

SELECT subscription_car_limit INTO car_limit
FROM companies
WHERE id = NEW.company_id;

IF car_limit IS NULL THEN
RETURN NEW;
END IF;

SELECT COALESCE(drivers_per_car_limit, 4) INTO dpc_limit
FROM company_settings
WHERE company_id = NEW.company_id;

IF dpc_limit IS NULL THEN
dpc_limit := 4;
END IF;

driver_limit := car_limit * dpc_limit;

SELECT COUNT(*) INTO active_drivers
FROM drivers
WHERE company_id = NEW.company_id
AND status IS DISTINCT FROM 'inactive'
AND id IS DISTINCT FROM NEW.id;

IF active_drivers >= driver_limit THEN
RAISE EXCEPTION 'Fahrerlimit erreicht. Ihr Abonnement erlaubt maximal % aktive Fahrer (% Fahrzeuge × %).', driver_limit, car_limit, dpc_limit
USING ERRCODE = 'P0001';
END IF;

RETURN NEW;
END;
$$;


--
-- Name: enforce_user_profile_privilege_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_user_profile_privilege_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
caller_uid         uuid := auth.uid();
caller_is_super    boolean;
caller_company     uuid;
caller_role_text   text;
BEGIN
-- Bypass for service role / background (no authenticated user)
IF caller_uid IS NULL THEN
RETURN NEW;
END IF;

SELECT COALESCE(is_super_admin, false), company_id, role
INTO caller_is_super, caller_company, caller_role_text
FROM public.user_profiles
WHERE user_id = caller_uid
LIMIT 1;

IF caller_is_super IS NULL THEN
caller_is_super := false;
END IF;

IF TG_OP = 'INSERT' THEN
-- Non-super users cannot create a profile with is_super_admin=true
IF COALESCE(NEW.is_super_admin, false) = true AND NOT caller_is_super THEN
RAISE EXCEPTION 'Not allowed: cannot self-assign super admin';
END IF;

-- Non-super users can only insert their OWN profile
IF NEW.user_id <> caller_uid AND NOT caller_is_super THEN
RAISE EXCEPTION 'Not allowed: cannot insert profile for another user';
END IF;

-- company_id on insert must be NULL or match caller's company,
-- unless caller is super admin
IF NEW.company_id IS NOT NULL
AND NEW.company_id IS DISTINCT FROM caller_company
AND NOT caller_is_super THEN
RAISE EXCEPTION 'Not allowed: cannot insert profile for another company';
END IF;

RETURN NEW;
END IF;

IF TG_OP = 'UPDATE' THEN
-- is_super_admin can only be changed by an existing super admin
IF COALESCE(NEW.is_super_admin, false) IS DISTINCT FROM COALESCE(OLD.is_super_admin, false)
AND NOT caller_is_super THEN
RAISE EXCEPTION 'Not allowed: cannot modify is_super_admin';
END IF;

-- company_id can only be changed by a super admin
IF NEW.company_id IS DISTINCT FROM OLD.company_id
AND NOT caller_is_super THEN
RAISE EXCEPTION 'Not allowed: cannot change company assignment';
END IF;

-- role / role_id can be changed by:
--   * super admin
--   * a company admin on a target profile in the SAME company
IF (NEW.role_id IS DISTINCT FROM OLD.role_id
OR NEW.role     IS DISTINCT FROM OLD.role)
AND NOT caller_is_super
AND NOT (
caller_role_text = 'admin'
AND OLD.company_id IS NOT NULL
AND OLD.company_id = caller_company
AND NEW.company_id = caller_company
)
THEN
RAISE EXCEPTION 'Not allowed: cannot change role assignment';
END IF;

RETURN NEW;
END IF;

RETURN NEW;
END;
$$;


--
-- Name: generate_invoice_number(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_invoice_number(p_year integer) RETURNS text
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
next_seq integer;
inv_number text;
BEGIN
SELECT COALESCE(MAX(
CAST(SPLIT_PART(invoice_number, '-', 3) AS integer)
), 0) + 1
INTO next_seq
FROM subscription_invoices
WHERE invoice_year = p_year;

inv_number := 'INV-' || p_year::text || '-' || LPAD(next_seq::text, 4, '0');
RETURN inv_number;
END;
$$;


--
-- Name: get_business_month(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_business_month(input_date date) RETURNS TABLE(month integer, year integer)
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
SELECT
EXTRACT(month FROM public.get_week_monday(input_date))::integer,
EXTRACT(year  FROM public.get_week_monday(input_date))::integer;
$$;


--
-- Name: get_business_week_number(date, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_business_week_number(input_date date, p_month integer, p_year integer) RETURNS integer
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
week_monday    date;
month_start    date;
month_end      date;
monday_cursor  date;
week_count     integer := 0;
BEGIN
week_monday  := public.get_week_monday(input_date);
month_start  := make_date(p_year, p_month, 1);
month_end    := (month_start + interval '1 month' - interval '1 day')::date;
monday_cursor := month_start;

WHILE monday_cursor <= month_end LOOP
IF EXTRACT(dow FROM monday_cursor) = 1 THEN
week_count := week_count + 1;
IF monday_cursor = week_monday THEN
RETURN week_count;
END IF;
monday_cursor := monday_cursor + 7;
ELSE
monday_cursor := monday_cursor + 1;
END IF;
END LOOP;

RETURN 1;
END;
$$;


--
-- Name: get_current_cash_balance(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_current_cash_balance(user_email text DEFAULT NULL::text) RETURNS numeric
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
total_deposits  numeric;
total_payments  numeric;
balance         numeric;
BEGIN
SELECT COALESCE(SUM(amount), 0)
INTO total_deposits
FROM public.cash_transactions
WHERE transaction_type = 'deposit'
AND (user_email IS NULL OR created_by = user_email);

SELECT COALESCE(SUM(expense), 0)
INTO total_payments
FROM public.receipts
WHERE payment_method = 'bar'
AND (user_email IS NULL OR "user" = user_email);

SELECT COALESCE(SUM(amount), 0) + total_payments
INTO total_payments
FROM public.cash_transactions
WHERE transaction_type = 'payment'
AND (user_email IS NULL OR created_by = user_email);

balance := total_deposits - total_payments;
RETURN balance;
END;
$$;


--
-- Name: get_current_user_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_current_user_role() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
RETURN (
SELECT role
FROM public.user_profiles
WHERE user_id = auth.uid()
);
END;
$$;


--
-- Name: get_driver_monthly_abrechnung(text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_driver_monthly_abrechnung(p_driver_name text, p_year integer, p_month integer) RETURNS TABLE(year integer, month integer, driver_name text, total_anzahl_belege bigint, total_ausgegebene_bargeld numeric, total_bargeld numeric, total_bar_zuruck numeric, week_count integer, weekly_breakdown jsonb)
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
v_weeks jsonb;
BEGIN
SELECT jsonb_agg(
jsonb_build_object(
'week_number',        aw.week_number,
'anzahl_belege',      aw.anzahl_belege,
'ausgegebene_bargeld',aw.ausgegebene_bargeld,
'bargeld',            aw.bargeld,
'bar_zuruck',         aw.bar_zuruck
) ORDER BY aw.week_number
)
INTO v_weeks
FROM public.abrechnung_weekly aw
WHERE aw.driver_name = p_driver_name
AND aw.year  = p_year
AND aw.month = p_month;

RETURN QUERY
SELECT
p_year,
p_month,
p_driver_name,
SUM(aw.anzahl_belege)::bigint,
SUM(aw.ausgegebene_bargeld),
SUM(aw.bargeld),
SUM(aw.bar_zuruck),
COUNT(DISTINCT aw.week_number)::integer,
v_weeks
FROM public.abrechnung_weekly aw
WHERE aw.driver_name = p_driver_name
AND aw.year  = p_year
AND aw.month = p_month
GROUP BY aw.driver_name;
END;
$$;


--
-- Name: get_driver_weekly_abrechnung(text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_driver_weekly_abrechnung(p_driver_name text, p_year integer, p_month integer) RETURNS TABLE(year integer, month integer, week_number integer, driver_name text, anzahl_belege bigint, ausgegebene_bargeld numeric, bargeld numeric, bar_zuruck numeric)
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
RETURN QUERY
SELECT
aw.year, aw.month, aw.week_number, aw.driver_name,
aw.anzahl_belege, aw.ausgegebene_bargeld, aw.bargeld, aw.bar_zuruck
FROM public.abrechnung_weekly aw
WHERE aw.driver_name = p_driver_name
AND aw.year = p_year
AND aw.month = p_month
ORDER BY aw.week_number DESC;
END;
$$;


--
-- Name: get_monthly_abrechnung(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_monthly_abrechnung(p_year integer, p_month integer) RETURNS TABLE(year integer, month integer, driver_name text, anzahl_belege bigint, ausgegebene_bargeld numeric, bargeld numeric, bar_zuruck numeric, week_count integer)
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
RETURN QUERY
SELECT
p_year,
p_month,
aw.driver_name,
SUM(aw.anzahl_belege)::bigint,
SUM(aw.ausgegebene_bargeld),
SUM(aw.bargeld),
SUM(aw.bar_zuruck),
COUNT(DISTINCT aw.week_number)::integer
FROM public.abrechnung_weekly aw
WHERE aw.year = p_year AND aw.month = p_month
GROUP BY aw.driver_name
ORDER BY aw.driver_name;
END;
$$;


--
-- Name: get_user_company_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_company_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
SELECT company_id
FROM public.user_profiles
WHERE user_id = auth.uid()
LIMIT 1;
$$;


--
-- Name: get_user_status(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_status(user_uuid uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
SELECT COALESCE(
(SELECT status FROM public.user_profiles WHERE user_id = user_uuid),
'inactive'
);
$$;


--
-- Name: get_week_monday(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_week_monday(input_date date) RETURNS date
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
SELECT (input_date - ((EXTRACT(dow FROM input_date)::integer + 6) % 7))::date;
$$;


--
-- Name: get_week_number_from_date(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_week_number_from_date(input_date date) RETURNS integer
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
month_start              date;
first_monday             date;
days_from_first_monday   integer;
week_num                 integer;
BEGIN
month_start := date_trunc('month', input_date)::date;
first_monday := NULL;

FOR i IN 0..6 LOOP
IF EXTRACT(dow FROM month_start + i) = 1 THEN
first_monday := month_start + i;
EXIT;
END IF;
END LOOP;

IF first_monday IS NULL THEN
RETURN 1;
END IF;

IF input_date < first_monday THEN
RETURN 1;
END IF;

days_from_first_monday := input_date - first_monday;
week_num := (days_from_first_monday / 7) + 1;
week_num := LEAST(week_num, 5);

RETURN week_num;
END;
$$;


--
-- Name: get_weekly_abrechnung(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_weekly_abrechnung(p_year integer, p_month integer) RETURNS TABLE(year integer, month integer, week_number integer, driver_name text, anzahl_belege bigint, ausgegebene_bargeld numeric, bargeld numeric, bar_zuruck numeric)
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
RETURN QUERY
SELECT
aw.year, aw.month, aw.week_number, aw.driver_name,
aw.anzahl_belege, aw.ausgegebene_bargeld, aw.bargeld, aw.bar_zuruck
FROM public.abrechnung_weekly aw
WHERE aw.year = p_year AND aw.month = p_month
ORDER BY aw.week_number DESC, aw.driver_name;
END;
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
-- Disable RLS for this trigger's own INSERT only.
-- auth.uid() is NULL in the admin.createUser context so the normal
-- INSERT policy (user_id = auth.uid()) would block this row.
SET LOCAL row_security = off;

INSERT INTO user_profiles (user_id, email, full_name, role, status, invited_at)
VALUES (
NEW.id,
NEW.email,
COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
COALESCE(NEW.raw_user_meta_data->>'role', 'viewer'),
CASE
WHEN NEW.email_confirmed_at IS NULL THEN 'pending_invite'
ELSE 'active'
END,
CASE
WHEN NEW.email_confirmed_at IS NULL THEN NOW()
ELSE NULL
END
)
ON CONFLICT (user_id) DO NOTHING;

RETURN NEW;
END;
$$;


--
-- Name: hide_activation_code(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hide_activation_code(p_code_id uuid, p_reason text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
v_caller_id   uuid := auth.uid();
v_is_super    boolean;
BEGIN
SELECT is_super_admin INTO v_is_super
FROM user_profiles WHERE user_id = v_caller_id;
IF NOT COALESCE(v_is_super, false) THEN
RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert');
END IF;

IF NOT EXISTS (SELECT 1 FROM activation_codes WHERE id = p_code_id) THEN
RETURN jsonb_build_object('success', false, 'error', 'Code nicht gefunden');
END IF;

UPDATE activation_codes
SET hidden_at = now(), hidden_by = v_caller_id, hidden_reason = p_reason
WHERE id = p_code_id;

RETURN jsonb_build_object('success', true);
END;
$$;


--
-- Name: increment_discount_used_count(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_discount_used_count(code_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
IF auth.uid() IS NULL THEN
RAISE EXCEPTION 'Access denied: unauthenticated';
END IF;

UPDATE discount_codes
SET used_count = used_count + 1
WHERE id = code_id;
END;
$$;


--
-- Name: is_role(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_role(role_name text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
SELECT EXISTS (
SELECT 1 FROM public.user_profiles
WHERE user_id = auth.uid()
AND role = role_name
);
$$;


--
-- Name: is_support_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_support_user() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN (
    SELECT email = 'support@yamobility.de'
    FROM auth.users
    WHERE id = auth.uid()
  );
END;
$$;


--
-- Name: is_user_active(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_user_active(user_uuid uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
SELECT COALESCE(
(SELECT status = 'active' FROM public.user_profiles WHERE user_id = user_uuid),
false
);
$$;


--
-- Name: is_user_super_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_user_super_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
SELECT COALESCE(is_super_admin, false)
FROM public.user_profiles
WHERE user_id = auth.uid()
LIMIT 1;
$$;


--
-- Name: list_users_for_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_users_for_admin() RETURNS TABLE(id uuid, email text, full_name text, role text, created_at timestamp with time zone, email_confirmed_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- Only allow support admin to call this function
  IF auth.email() != 'support@yamobility.de' THEN
    RAISE EXCEPTION 'Access denied: Only support admin can list users';
  END IF;

  RETURN QUERY
  SELECT 
    au.id,
    au.email::TEXT,
    COALESCE(up.full_name, au.raw_user_meta_data->>'full_name', '')::TEXT as full_name,
    COALESCE(up.role, 'viewer')::TEXT as role,
    au.created_at,
    au.email_confirmed_at
  FROM auth.users au
  LEFT JOIN user_profiles up ON au.id = up.user_id
  ORDER BY au.created_at DESC;
END;
$$;


--
-- Name: preview_activation_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preview_activation_code(input_code text) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions'
    AS $_$
DECLARE
v_caller_id    uuid;
v_company_id   uuid;
v_caller_email text;
v_code_hash    text;
v_code         activation_codes%ROWTYPE;
v_clean_code   text;
v_seconds_rem  integer;
BEGIN
v_caller_id := auth.uid();
IF v_caller_id IS NULL THEN
RETURN json_build_object('success', false, 'error', 'Nicht authentifiziert.');
END IF;

SELECT company_id, email INTO v_company_id, v_caller_email
FROM user_profiles
WHERE user_id = v_caller_id
LIMIT 1;

v_clean_code := trim(regexp_replace(input_code, '\s', '', 'g'));

IF v_clean_code !~ '^[0-9]{6}$' THEN
RETURN json_build_object('success', false, 'error', 'Ungültiges Format.');
END IF;

v_code_hash := encode(digest(v_clean_code::bytea, 'sha256'), 'hex');

SELECT * INTO v_code
FROM activation_codes
WHERE code_hash = v_code_hash
LIMIT 1;

IF NOT FOUND THEN
RETURN json_build_object('success', false, 'error', 'Aktivierungscode nicht gefunden.');
END IF;

-- Binding check: code locked to a specific company/email must match caller
IF v_code.company_id IS NOT NULL AND v_code.company_id <> v_company_id THEN
RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu diesem Unternehmen.');
END IF;

IF v_code.target_email IS NOT NULL AND lower(v_caller_email) <> lower(v_code.target_email) THEN
RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu dieser E-Mail.');
END IF;

v_seconds_rem := GREATEST(0, EXTRACT(EPOCH FROM (v_code.expires_at - now()))::integer);

RETURN json_build_object(
'success',           true,
'status',            v_code.status,
'expires_at',        v_code.expires_at,
'duration_type',     v_code.duration_type,
'seconds_remaining', v_seconds_rem
);

EXCEPTION WHEN OTHERS THEN
RETURN json_build_object('success', false, 'error', 'Fehler: ' || SQLERRM);
END;
$_$;


--
-- Name: protect_fahrtenbuch_immutable_fields(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_fahrtenbuch_immutable_fields() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
IF (
OLD.trip_date            IS DISTINCT FROM NEW.trip_date            OR
OLD.start_time           IS DISTINCT FROM NEW.start_time           OR
OLD.end_time             IS DISTINCT FROM NEW.end_time             OR
OLD.duration_minutes     IS DISTINCT FROM NEW.duration_minutes     OR
OLD.car_id               IS DISTINCT FROM NEW.car_id               OR
OLD.car_identifier       IS DISTINCT FROM NEW.car_identifier       OR
OLD.route_start          IS DISTINCT FROM NEW.route_start          OR
OLD.route_end            IS DISTINCT FROM NEW.route_end            OR
OLD.description          IS DISTINCT FROM NEW.description          OR
OLD.price_amount         IS DISTINCT FROM NEW.price_amount         OR
OLD.cash_amount          IS DISTINCT FROM NEW.cash_amount          OR
OLD.online_amount        IS DISTINCT FROM NEW.online_amount        OR
OLD.tip_amount           IS DISTINCT FROM NEW.tip_amount           OR
OLD.action_amount        IS DISTINCT FROM NEW.action_amount        OR
OLD.raw_data_json        IS DISTINCT FROM NEW.raw_data_json        OR
OLD.original_driver_id   IS DISTINCT FROM NEW.original_driver_id   OR
OLD.original_driver_name IS DISTINCT FROM NEW.original_driver_name OR
OLD.import_id            IS DISTINCT FROM NEW.import_id            OR
OLD.company_id           IS DISTINCT FROM NEW.company_id           OR
OLD.source_status        IS DISTINCT FROM NEW.source_status        OR
OLD.is_canceled          IS DISTINCT FROM NEW.is_canceled
) THEN
RAISE EXCEPTION
'fahrtenbuch_trips: immutable fields cannot be modified after insert.';
END IF;
NEW.updated_at := now();
RETURN NEW;
END;
$$;


--
-- Name: purge_old_monthly_planning_runs(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_old_monthly_planning_runs(p_month integer DEFAULT NULL::integer, p_year integer DEFAULT NULL::integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
v_caller      uuid := auth.uid();
v_company     uuid;
v_run         RECORD;
v_trip_ref    int;
v_has_active_fin boolean;
v_deleted_ids uuid[] := '{}';
v_skipped     jsonb[] := '{}';
v_exc_deleted int;
v_now         timestamptz := now();
BEGIN
IF v_caller IS NULL THEN
RAISE EXCEPTION 'purge_old_monthly_planning_runs: unauthenticated';
END IF;

SELECT company_id INTO v_company FROM user_profiles WHERE user_id = v_caller;
IF v_company IS NULL THEN
RAISE EXCEPTION 'purge_old_monthly_planning_runs: caller has no company';
END IF;

FOR v_run IN
SELECT id, status, month, year
FROM company_planning_runs
WHERE company_id = v_company
AND status IN ('replaced', 'archived')
AND (p_month IS NULL OR month = p_month)
AND (p_year  IS NULL OR year  = p_year)
ORDER BY applied_at ASC NULLS FIRST
LOOP
-- Safety check 1: no trip references
SELECT COUNT(*) INTO v_trip_ref
FROM fahrtenbuch_trips
WHERE company_id = v_company
AND assignment_planning_run_id = v_run.id;

IF v_trip_ref > 0 THEN
v_skipped := array_append(v_skipped, jsonb_build_object(
'id', v_run.id,
'reason', 'trip_references',
'detail', v_trip_ref || ' Fahrten verweisen noch auf diese Planung'
));
CONTINUE;
END IF;

-- Safety check 2: no non-stale finalization
SELECT EXISTS (
SELECT 1 FROM planning_finalizations
WHERE planning_run_id = v_run.id AND is_stale = false
) INTO v_has_active_fin;

IF v_has_active_fin THEN
v_skipped := array_append(v_skipped, jsonb_build_object(
'id', v_run.id,
'reason', 'active_finalization',
'detail', 'Planung hat eine gültige Finalisierung – als veraltet markieren oder neu finalisieren, bevor sie gelöscht werden kann'
));
CONTINUE;
END IF;

-- Delete manual exceptions (no CASCADE)
DELETE FROM monthly_planning_manual_exceptions
WHERE planning_run_id = v_run.id;
GET DIAGNOSTICS v_exc_deleted = ROW_COUNT;

-- Delete the run (CASCADE: planning_finalizations, planning_run_adjustments)
DELETE FROM company_planning_runs WHERE id = v_run.id;

v_deleted_ids := array_append(v_deleted_ids, v_run.id);
END LOOP;

RETURN jsonb_build_object(
'deleted_count',  array_length(v_deleted_ids, 1)::int,
'skipped_count',  array_length(v_skipped, 1)::int,
'deleted_ids',    to_jsonb(v_deleted_ids),
'skipped',        to_jsonb(v_skipped)
);
END;
$$;


--
-- Name: reassign_fahrtenbuch_trip(uuid, uuid, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reassign_fahrtenbuch_trip(p_trip_id uuid, p_new_driver_id uuid, p_new_driver_name text, p_plausibility_status text DEFAULT 'pending'::text, p_reason text DEFAULT NULL::text, p_note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
v_caller_id       uuid;
v_caller_company  uuid;
v_trip            fahrtenbuch_trips%ROWTYPE;
v_audit_id        uuid;
BEGIN
v_caller_id := auth.uid();
IF v_caller_id IS NULL THEN
RAISE EXCEPTION 'reassign_fahrtenbuch_trip: unauthenticated call';
END IF;

SELECT company_id INTO v_caller_company
FROM user_profiles
WHERE user_id = v_caller_id;

IF v_caller_company IS NULL THEN
RAISE EXCEPTION 'reassign_fahrtenbuch_trip: caller has no company';
END IF;

SELECT * INTO v_trip
FROM fahrtenbuch_trips
WHERE id = p_trip_id;

IF NOT FOUND THEN
RAISE EXCEPTION 'reassign_fahrtenbuch_trip: trip % not found', p_trip_id;
END IF;

IF v_trip.company_id <> v_caller_company THEN
RAISE EXCEPTION 'reassign_fahrtenbuch_trip: cross-company access denied';
END IF;

IF p_plausibility_status NOT IN ('pending','ok','uncovered','overlap','planned_reassignment') THEN
RAISE EXCEPTION 'reassign_fahrtenbuch_trip: invalid plausibility_status "%"',
p_plausibility_status;
END IF;

IF p_new_driver_id IS NOT NULL THEN
IF NOT EXISTS (
SELECT 1 FROM drivers
WHERE id = p_new_driver_id AND company_id = v_caller_company
) THEN
RAISE EXCEPTION
'reassign_fahrtenbuch_trip: driver % does not belong to company %',
p_new_driver_id, v_caller_company;
END IF;
END IF;

UPDATE fahrtenbuch_trips
SET
assigned_driver_id    = p_new_driver_id,
assigned_driver_name  = p_new_driver_name,
plausibility_status   = p_plausibility_status,
assignment_reason     = p_reason,
assignment_note       = p_note,
confirmed_by          = v_caller_id,
confirmed_at          = now()
WHERE id = p_trip_id;

INSERT INTO fahrtenbuch_assignment_audit (
company_id, trip_id, trip_date, start_time, end_time, price_amount,
original_driver_id, original_driver_name,
old_assigned_driver_id, old_assigned_driver_name,
new_assigned_driver_id, new_assigned_driver_name,
reason, changed_by
)
VALUES (
v_caller_company, p_trip_id,
v_trip.trip_date, v_trip.start_time, v_trip.end_time, v_trip.price_amount,
v_trip.original_driver_id, v_trip.original_driver_name,
v_trip.assigned_driver_id, v_trip.assigned_driver_name,
p_new_driver_id, p_new_driver_name,
p_reason, v_caller_id
)
RETURNING id INTO v_audit_id;

RETURN jsonb_build_object(
'success',   true,
'trip_id',   p_trip_id,
'audit_id',  v_audit_id,
'changed_by', v_caller_id
);

EXCEPTION WHEN OTHERS THEN
RAISE;
END;
$$;


--
-- Name: redeem_activation_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.redeem_activation_code(input_code text) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions'
    AS $_$
DECLARE
v_caller_id     uuid;
v_company_id    uuid;
v_code_hash     text;
v_code          activation_codes%ROWTYPE;
v_base_date     timestamptz;
v_new_expiry    timestamptz;
v_attempt_count integer;
v_clean_code    text;
v_sub_status    text;
v_sub_expiry    timestamptz;
v_start_date    timestamptz;
BEGIN
v_caller_id := auth.uid();
IF v_caller_id IS NULL THEN
RETURN json_build_object('success', false, 'error', 'Nicht authentifiziert.');
END IF;

SELECT company_id INTO v_company_id
FROM user_profiles
WHERE user_id = v_caller_id
LIMIT 1;

IF v_company_id IS NULL THEN
RETURN json_build_object('success', false, 'error', 'Kein Unternehmenskonto gefunden.');
END IF;

v_clean_code := trim(regexp_replace(input_code, '\s', '', 'g'));

IF v_clean_code !~ '^[0-9]{6}$' THEN
INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Ungültiges Format');
RETURN json_build_object('success', false, 'error', 'Aktivierungscode muss genau 6 Ziffern haben.');
END IF;

SELECT COUNT(*) INTO v_attempt_count
FROM activation_code_attempts
WHERE company_id = v_company_id
AND success = false
AND created_at > now() - INTERVAL '15 minutes';

IF v_attempt_count >= 10 THEN
INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Rate limit');
RETURN json_build_object('success', false, 'error', 'Zu viele Versuche. Bitte warten Sie 15 Minuten.');
END IF;

v_code_hash := encode(digest(v_clean_code::bytea, 'sha256'), 'hex');

SELECT * INTO v_code
FROM activation_codes
WHERE code_hash = v_code_hash
LIMIT 1;

IF NOT FOUND THEN
INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Nicht gefunden');
RETURN json_build_object('success', false, 'error', 'Aktivierungscode ist ungültig.');
END IF;

IF v_code.status = 'used' THEN
INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Bereits verwendet');
RETURN json_build_object('success', false, 'error', 'Aktivierungscode wurde bereits verwendet.');
END IF;

IF v_code.status = 'revoked' THEN
INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Widerrufen');
RETURN json_build_object('success', false, 'error', 'Aktivierungscode wurde widerrufen.');
END IF;

IF v_code.expires_at < now() OR v_code.status = 'expired' THEN
UPDATE activation_codes SET status = 'expired' WHERE id = v_code.id AND status = 'active';
INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Abgelaufen');
RETURN json_build_object('success', false, 'error', 'Aktivierungscode ist abgelaufen.');
END IF;

IF v_code.company_id IS NOT NULL AND v_code.company_id <> v_company_id THEN
INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Falsches Unternehmen');
RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu diesem Unternehmen.');
END IF;

IF v_code.target_email IS NOT NULL THEN
DECLARE
v_caller_email text;
BEGIN
SELECT email INTO v_caller_email FROM user_profiles WHERE user_id = v_caller_id LIMIT 1;
IF lower(v_caller_email) <> lower(v_code.target_email) THEN
INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Falsche E-Mail');
RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu diesem Unternehmen.');
END IF;
END;
END IF;

-- Atomically mark code as used
UPDATE activation_codes
SET status          = 'used',
used_at         = now(),
used_by         = v_caller_id,
used_company_id = v_company_id
WHERE id = v_code.id
AND status = 'active'
AND expires_at > now();

IF NOT FOUND THEN
INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Race condition');
RETURN json_build_object('success', false, 'error', 'Aktivierungscode konnte nicht eingelöst werden. Bitte erneut versuchen.');
END IF;

-- Calculate new subscription expiry
-- Extend from current active subscription if not yet expired
SELECT subscription_status, subscription_expires_at
INTO v_sub_status, v_sub_expiry
FROM companies WHERE id = v_company_id;

IF v_sub_status = 'active' AND v_sub_expiry IS NOT NULL AND v_sub_expiry > now() THEN
v_base_date := v_sub_expiry;
ELSE
v_base_date := now();
END IF;

v_start_date := v_base_date;

CASE v_code.duration_type
WHEN '1_monat'   THEN v_new_expiry := v_base_date + INTERVAL '1 month';
WHEN '3_monate'  THEN v_new_expiry := v_base_date + INTERVAL '3 months';
WHEN '1_jahr'    THEN v_new_expiry := v_base_date + INTERVAL '1 year';
WHEN 'benutzerdefiniert' THEN
IF v_code.custom_expires_at IS NOT NULL THEN
-- Absolute expiry date: use directly as both start and end
v_new_expiry := v_code.custom_expires_at;
v_start_date := now();
ELSIF v_code.custom_days IS NOT NULL THEN
v_new_expiry := v_base_date + (v_code.custom_days || ' days')::INTERVAL;
ELSE
v_new_expiry := v_base_date + INTERVAL '30 days';
END IF;
ELSE
v_new_expiry := v_base_date + INTERVAL '1 month';
END CASE;

-- Write applied period back onto the activation_codes row
UPDATE activation_codes
SET applied_subscription_started_at = v_start_date,
applied_subscription_expires_at  = v_new_expiry
WHERE id = v_code.id;

-- Update company subscription atomically
UPDATE companies SET
subscription_status        = 'active',
subscription_started_at    = v_start_date,
subscription_expires_at    = v_new_expiry,
subscription_duration_type = v_code.duration_type,
last_activation_code_id    = v_code.id,
updated_at                 = now()
WHERE id = v_company_id;

INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), true, 'OK');

RETURN json_build_object(
'success',                  true,
'subscription_expires_at',  v_new_expiry
);

EXCEPTION WHEN OTHERS THEN
RETURN json_build_object('success', false, 'error', 'Interner Fehler: ' || SQLERRM);
END;
$_$;


--
-- Name: replace_monthly_planning_run(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.replace_monthly_planning_run(p_payload jsonb, p_old_run_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
v_caller        uuid := auth.uid();
v_company       uuid;
v_import_id     uuid := (p_payload->>'import_id')::uuid;
v_month         int  := (p_payload->>'month')::int;
v_year          int  := (p_payload->>'year')::int;
v_run_id        uuid;
v_old           RECORD;
v_now           timestamptz := now();
v_updated_count int := 0;
v_skipped_canceled int := 0;
v_exception_count int := 0;
v_detached_trips int := 0;
v_row jsonb;
v_exc jsonb;
v_trip_id uuid;
v_driver_id uuid;
v_block_sep int := COALESCE((p_payload->>'block_separator_minutes')::int, 60);
v_min_block int := COALESCE((p_payload->>'min_block_duration_minutes')::int, 30);
v_max_block int := COALESCE((p_payload->>'max_block_duration_minutes')::int, 270);
BEGIN
IF v_caller IS NULL THEN
RAISE EXCEPTION 'replace_monthly_planning_run: unauthenticated';
END IF;

SELECT company_id INTO v_company FROM user_profiles WHERE user_id = v_caller;
IF v_company IS NULL THEN
RAISE EXCEPTION 'replace_monthly_planning_run: caller has no company';
END IF;

IF v_import_id IS NULL THEN
RAISE EXCEPTION 'replace_monthly_planning_run: import_id required';
END IF;

SELECT id, company_id, import_id, month, year, status, applied_at
INTO v_old
FROM company_planning_runs
WHERE id = p_old_run_id;

IF NOT FOUND THEN
RAISE EXCEPTION 'replace_monthly_planning_run: old run not found';
END IF;
IF v_old.company_id <> v_company THEN
RAISE EXCEPTION 'replace_monthly_planning_run: old run belongs to another company';
END IF;
IF v_old.import_id <> v_import_id OR v_old.month <> v_month OR v_old.year <> v_year THEN
RAISE EXCEPTION 'replace_monthly_planning_run: old run period mismatch';
END IF;

UPDATE company_planning_runs
SET status = 'replaced', updated_at = v_now
WHERE id = p_old_run_id;

UPDATE fahrtenbuch_trips
SET assignment_planning_run_id = NULL,
updated_at = v_now
WHERE company_id = v_company
AND import_id = v_import_id
AND assignment_planning_run_id = p_old_run_id;
GET DIAGNOSTICS v_detached_trips = ROW_COUNT;

INSERT INTO company_planning_runs (
company_id, month, year, import_id, status,
max_shift_minutes, summary_json, settings_json,
created_by, applied_at, applied_by, apply_summary_json
) VALUES (
v_company, v_month, v_year, v_import_id, 'applied',
v_max_block,
jsonb_build_object(
'source_file_name', p_payload->>'source_file_name',
'block_separator_minutes', v_block_sep,
'min_block_duration_minutes', v_min_block,
'max_block_duration_minutes', v_max_block,
'vehicle_blocks_count', (p_payload->>'vehicle_blocks_count')::int,
'assigned_blocks_count', (p_payload->>'assigned_blocks_count')::int,
'manual_exceptions_count', (p_payload->>'manual_exceptions_count')::int,
'dienstzeit_exceptions_count', (p_payload->>'dienstzeit_exceptions_count')::int,
'tageslimit_exceptions_count', (p_payload->>'tageslimit_exceptions_count')::int,
'monatslimit_exceptions_count', (p_payload->>'monatslimit_exceptions_count')::int,
'replaced_run_id', p_old_run_id
),
jsonb_build_object(
'block_separator_minutes', v_block_sep,
'min_block_duration_minutes', v_min_block,
'max_block_duration_minutes', v_max_block,
'replaced_run_id', p_old_run_id
),
v_caller, v_now, v_caller, NULL
)
RETURNING id INTO v_run_id;

FOR v_row IN SELECT * FROM jsonb_array_elements(p_payload->'change_rows') LOOP
v_trip_id   := (v_row->>'trip_id')::uuid;
v_driver_id := NULLIF(v_row->>'driver_id','')::uuid;
IF COALESCE((v_row->>'is_canceled')::bool, false) THEN
v_skipped_canceled := v_skipped_canceled + 1;
CONTINUE;
END IF;

UPDATE fahrtenbuch_trips ft
SET
assigned_driver_id        = v_driver_id,
assigned_driver_name      = v_row->>'driver_name',
assignment_source         = v_row->>'assignment_source',
assignment_block_id       = v_row->>'block_id',
assignment_planning_run_id = v_run_id,
assignment_applied_at     = v_now,
assignment_applied_by     = v_caller,
assignment_reason         = COALESCE(v_row->>'exception_reason', ft.assignment_reason),
plausibility_status       = CASE WHEN ft.plausibility_status = 'canceled'
THEN ft.plausibility_status
ELSE 'planned_reassignment' END,
confirmed_by              = v_caller,
confirmed_at              = v_now,
updated_at                = v_now
WHERE id          = v_trip_id
AND company_id  = v_company
AND is_canceled = false;

IF FOUND THEN
v_updated_count := v_updated_count + 1;
END IF;
END LOOP;

FOR v_exc IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'manual_exceptions', '[]'::jsonb)) LOOP
INSERT INTO monthly_planning_manual_exceptions (
planning_run_id, company_id, import_id, month, year,
block_id, vehicle_identifier, service_date,
block_start_datetime, block_end_datetime,
assigned_driver_id, assigned_driver_name,
dienstzeit_exception, tageslimit_exception, monatslimit_exception,
reason, confirmed_by, confirmed_at
) VALUES (
v_run_id, v_company, v_import_id, v_month, v_year,
v_exc->>'block_id', v_exc->>'vehicle_identifier',
(v_exc->>'service_date')::date,
(v_exc->>'block_start_datetime')::timestamptz,
(v_exc->>'block_end_datetime')::timestamptz,
NULLIF(v_exc->>'driver_id','')::uuid,
v_exc->>'driver_name',
COALESCE((v_exc->>'dienstzeit')::bool, false),
COALESCE((v_exc->>'tageslimit')::bool, false),
COALESCE((v_exc->>'monatslimit')::bool, false),
NULLIF(v_exc->>'reason',''), v_caller, v_now
);
v_exception_count := v_exception_count + 1;
END LOOP;

UPDATE company_planning_runs
SET apply_summary_json = jsonb_build_object(
'updated_trips', v_updated_count,
'skipped_canceled', v_skipped_canceled,
'manual_exceptions_saved', v_exception_count,
'replaced_run_id', p_old_run_id,
'detached_trips_from_old_run', v_detached_trips,
'dienstzeit_exceptions_count', (p_payload->>'dienstzeit_exceptions_count')::int,
'tageslimit_exceptions_count', (p_payload->>'tageslimit_exceptions_count')::int,
'monatslimit_exceptions_count', (p_payload->>'monatslimit_exceptions_count')::int,
'block_separator_minutes', v_block_sep,
'min_block_duration_minutes', v_min_block,
'max_block_duration_minutes', v_max_block
),
updated_at = v_now
WHERE id = v_run_id;

RETURN jsonb_build_object(
'success', true,
'planning_run_id', v_run_id,
'replaced_run_id', p_old_run_id,
'updated_trips', v_updated_count,
'skipped_canceled', v_skipped_canceled,
'manual_exceptions_saved', v_exception_count,
'detached_trips_from_old_run', v_detached_trips,
'applied_at', v_now,
'block_separator_minutes', v_block_sep,
'min_block_duration_minutes', v_min_block,
'max_block_duration_minutes', v_max_block
);
END;
$$;


--
-- Name: revoke_activation_code(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revoke_activation_code(p_code_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
v_caller_id   uuid := auth.uid();
v_is_super    boolean;
v_code        activation_codes%ROWTYPE;
BEGIN
-- Auth check
SELECT is_super_admin INTO v_is_super
FROM user_profiles WHERE user_id = v_caller_id;
IF NOT COALESCE(v_is_super, false) THEN
RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert');
END IF;

-- Load code
SELECT * INTO v_code FROM activation_codes WHERE id = p_code_id;
IF NOT FOUND THEN
RETURN jsonb_build_object('success', false, 'error', 'Code nicht gefunden');
END IF;
IF v_code.status <> 'active' THEN
RETURN jsonb_build_object('success', false, 'error', 'Nur aktive Codes können widerrufen werden');
END IF;
IF v_code.used_at IS NOT NULL THEN
RETURN jsonb_build_object('success', false, 'error', 'Verwendete Codes können nicht widerrufen werden');
END IF;

UPDATE activation_codes
SET status = 'revoked', revoked_at = now(), revoked_by = v_caller_id
WHERE id = p_code_id;

RETURN jsonb_build_object('success', true);
END;
$$;


--
-- Name: sync_user_profile_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_user_profile_role() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
IF NEW.role_id IS NOT NULL THEN
SELECT name INTO NEW.role
FROM public.roles
WHERE id = NEW.role_id;
END IF;
RETURN NEW;
END;
$$;


--
-- Name: uid(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.uid() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
SELECT auth.uid();
$$;


--
-- Name: update_cars_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_cars_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
NEW.updated_at = now();
RETURN NEW;
END;
$$;


--
-- Name: update_company_settings_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_company_settings_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
NEW.updated_at = now();
RETURN NEW;
END;
$$;


--
-- Name: update_company_subscription_manual(uuid, text, timestamp with time zone, timestamp with time zone, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_company_subscription_manual(p_company_id uuid, p_subscription_status text, p_subscription_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_subscription_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_subscription_duration_type text DEFAULT NULL::text, p_reason text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
v_caller_id   uuid := auth.uid();
v_is_super    boolean;
v_company     companies%ROWTYPE;
v_allowed_statuses text[] := ARRAY['inactive','active','expired','suspended'];
BEGIN
-- Auth check
SELECT is_super_admin INTO v_is_super
FROM user_profiles WHERE user_id = v_caller_id;
IF NOT COALESCE(v_is_super, false) THEN
RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert');
END IF;

-- Validate status
IF p_subscription_status <> ALL(v_allowed_statuses) THEN
RETURN jsonb_build_object('success', false, 'error', 'Ungültiger Abo-Status');
END IF;

-- Load current company
SELECT * INTO v_company FROM companies WHERE id = p_company_id;
IF NOT FOUND THEN
RETURN jsonb_build_object('success', false, 'error', 'Unternehmen nicht gefunden');
END IF;

-- Write audit row
INSERT INTO subscription_admin_actions
(company_id, action_type, old_status, new_status, old_expires_at, new_expires_at, reason, created_by)
VALUES
(p_company_id, 'manual_edit',
v_company.subscription_status, p_subscription_status,
v_company.subscription_expires_at, p_subscription_expires_at,
p_reason, v_caller_id);

-- Apply update
UPDATE companies
SET
subscription_status       = p_subscription_status,
subscription_started_at   = COALESCE(p_subscription_started_at, subscription_started_at),
subscription_expires_at   = p_subscription_expires_at,
subscription_duration_type = COALESCE(p_subscription_duration_type, subscription_duration_type),
updated_at                = now()
WHERE id = p_company_id;

RETURN jsonb_build_object('success', true);
END;
$$;


--
-- Name: update_discount_codes_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_discount_codes_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
NEW.updated_at = now();
RETURN NEW;
END;
$$;


--
-- Name: update_documents_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_documents_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
NEW.updated_at = now();
RETURN NEW;
END;
$$;


--
-- Name: update_driver_notes_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_driver_notes_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
NEW.updated_at = now();
RETURN NEW;
END;
$$;


--
-- Name: update_fixed_costs_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_fixed_costs_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
NEW.updated_at = now();
RETURN NEW;
END;
$$;


--
-- Name: update_income_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_income_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
NEW.updated_at = now();
RETURN NEW;
END;
$$;


--
-- Name: update_notification_settings_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_notification_settings_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
NEW.updated_at = now();
RETURN NEW;
END;
$$;


--
-- Name: update_roles_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_roles_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
NEW.updated_at = now();
RETURN NEW;
END;
$$;


--
-- Name: update_salaries_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_salaries_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
NEW.updated_at = now();
RETURN NEW;
END;
$$;


--
-- Name: update_salary_payment_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_salary_payment_status() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
salary_total    decimal(10,2);
payments_total  decimal(10,2);
new_status      text;
new_remaining   decimal(10,2);
BEGIN
SELECT COALESCE(netto_salary, amount_due, 0)
INTO salary_total
FROM public.salaries
WHERE id = COALESCE(NEW.salary_id, OLD.salary_id);

SELECT COALESCE(SUM(amount), 0)
INTO payments_total
FROM public.salary_payments
WHERE salary_id = COALESCE(NEW.salary_id, OLD.salary_id);

new_remaining := GREATEST(salary_total - payments_total, 0);

IF payments_total = 0 THEN
new_status := 'unpaid';
ELSIF payments_total >= salary_total THEN
new_status    := 'paid';
new_remaining := 0;
ELSE
new_status := 'partially_paid';
END IF;

UPDATE public.salaries
SET total_paid        = payments_total,
remaining_balance = new_remaining,
payment_status    = new_status
WHERE id = COALESCE(NEW.salary_id, OLD.salary_id);

RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: update_salary_payments_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_salary_payments_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
NEW.updated_at = now();
RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
NEW.updated_at = now();
RETURN NEW;
END;
$$;


--
-- Name: update_werkstatt_checks_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_werkstatt_checks_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
NEW.updated_at = now();
RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: income; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.income (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    description text NOT NULL,
    amount numeric NOT NULL,
    type text NOT NULL,
    driver_name text NOT NULL,
    date date DEFAULT CURRENT_DATE NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    created_by bigint,
    week_number integer DEFAULT 1,
    week integer,
    company_id uuid,
    trip_count integer,
    CONSTRAINT income_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT income_trip_count_non_negative CHECK (((trip_count IS NULL) OR (trip_count >= 0))),
    CONSTRAINT income_type_check CHECK ((type = ANY (ARRAY['bargeld'::text, 'umsatz'::text, 'trinkgeld'::text, 'aktionen'::text]))),
    CONSTRAINT income_week_check CHECK (((week >= 1) AND (week <= 5)))
);


--
-- Name: receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    receipt_number text NOT NULL,
    date date NOT NULL,
    description text NOT NULL,
    driver_name text NOT NULL,
    expense numeric(10,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    user_id uuid,
    created_by text,
    postal_code text,
    city text,
    payment_method text DEFAULT 'bar'::text,
    company_id uuid,
    CONSTRAINT receipts_payment_method_check CHECK ((payment_method = ANY (ARRAY['bar'::text, 'uberweisung'::text])))
);


--
-- Name: abrechnung_weekly; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.abrechnung_weekly WITH (security_invoker='true') AS
 WITH weekly_receipts AS (
         SELECT bm.year,
            bm.month,
            public.get_business_week_number(r.date, bm.month, bm.year) AS week_number,
            r.driver_name,
            count(*) AS anzahl_belege,
            COALESCE(sum(r.expense), (0)::numeric) AS ausgegebene_bargeld
           FROM (public.receipts r
             CROSS JOIN LATERAL public.get_business_month(r.date) bm(month, year))
          WHERE (r.payment_method = 'bar'::text)
          GROUP BY bm.year, bm.month, (public.get_business_week_number(r.date, bm.month, bm.year)), r.driver_name
        ), weekly_income AS (
         SELECT bm.year,
            bm.month,
            public.get_business_week_number(i.date, bm.month, bm.year) AS week_number,
            i.driver_name,
            COALESCE(sum(i.amount), (0)::numeric) AS bargeld_income
           FROM (public.income i
             CROSS JOIN LATERAL public.get_business_month(i.date) bm(month, year))
          WHERE (i.type = 'bargeld'::text)
          GROUP BY bm.year, bm.month, (public.get_business_week_number(i.date, bm.month, bm.year)), i.driver_name
        )
 SELECT COALESCE(wr.year, wi.year) AS year,
    COALESCE(wr.month, wi.month) AS month,
    COALESCE(wr.week_number, wi.week_number) AS week_number,
    COALESCE(wr.driver_name, wi.driver_name) AS driver_name,
    COALESCE(wr.anzahl_belege, (0)::bigint) AS anzahl_belege,
    COALESCE(wr.ausgegebene_bargeld, (0)::numeric) AS ausgegebene_bargeld,
    COALESCE(wi.bargeld_income, (0)::numeric) AS bargeld,
    (COALESCE(wi.bargeld_income, (0)::numeric) - COALESCE(wr.ausgegebene_bargeld, (0)::numeric)) AS bar_zuruck
   FROM (weekly_receipts wr
     FULL JOIN weekly_income wi ON (((wr.year = wi.year) AND (wr.month = wi.month) AND (wr.week_number = wi.week_number) AND (wr.driver_name = wi.driver_name))))
  ORDER BY COALESCE(wr.year, wi.year) DESC, COALESCE(wr.month, wi.month) DESC, COALESCE(wr.week_number, wi.week_number) DESC, COALESCE(wr.driver_name, wi.driver_name);


--
-- Name: activation_code_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activation_code_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    user_id uuid,
    input_last4 text,
    success boolean DEFAULT false NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: activation_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activation_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code_hash text NOT NULL,
    code_last4 text,
    company_id uuid,
    target_email text,
    duration_type text NOT NULL,
    duration_months integer,
    custom_days integer,
    custom_expires_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    used_by uuid,
    used_company_id uuid,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    hidden_at timestamp with time zone,
    hidden_by uuid,
    hidden_reason text,
    applied_subscription_started_at timestamp with time zone,
    applied_subscription_expires_at timestamp with time zone,
    CONSTRAINT activation_codes_duration_type_check CHECK ((duration_type = ANY (ARRAY['1_monat'::text, '3_monate'::text, '1_jahr'::text, 'benutzerdefiniert'::text]))),
    CONSTRAINT activation_codes_status_check CHECK ((status = ANY (ARRAY['active'::text, 'used'::text, 'expired'::text, 'revoked'::text])))
);


--
-- Name: car_driver_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.car_driver_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    car_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now(),
    created_by uuid NOT NULL,
    company_id uuid,
    role text DEFAULT 'hauptfahrer_1'::text NOT NULL,
    CONSTRAINT valid_driver_role CHECK ((role = ANY (ARRAY['hauptfahrer_1'::text, 'hauptfahrer_2'::text, 'deckungsfahrer_1'::text, 'deckungsfahrer_2'::text])))
);


--
-- Name: cars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cars (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kennzeichen text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    company_id uuid,
    tuev_gueltig_bis date,
    letzte_hu date,
    status text DEFAULT 'active'::text NOT NULL,
    CONSTRAINT cars_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))
);


--
-- Name: cash_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_type text NOT NULL,
    amount numeric(10,2) NOT NULL,
    description text NOT NULL,
    reference_id uuid,
    reference_type text,
    date date DEFAULT CURRENT_DATE NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    company_id uuid,
    CONSTRAINT cash_transactions_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT cash_transactions_transaction_type_check CHECK ((transaction_type = ANY (ARRAY['deposit'::text, 'payment'::text])))
);


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    legal_name text,
    email text,
    phone text,
    address text,
    city text,
    postal_code text,
    country text DEFAULT 'Deutschland'::text,
    logo_url text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    trial_start timestamp with time zone,
    trial_end timestamp with time zone,
    plan text DEFAULT 'basic'::text NOT NULL,
    archived_at timestamp with time zone,
    deleted_at timestamp with time zone,
    subscription_car_limit integer DEFAULT 5 NOT NULL,
    billing_cycle text DEFAULT 'monthly'::text NOT NULL,
    active_discount_code_id uuid,
    active_discount_usage_mode text,
    active_discount_started_at timestamp with time zone,
    approval_status text DEFAULT 'approved'::text NOT NULL,
    approval_note text,
    rejection_reason text,
    approved_at timestamp with time zone,
    approved_by uuid,
    rejected_at timestamp with time zone,
    rejected_by uuid,
    referral_id uuid,
    referral_code_used text,
    referred_at timestamp with time zone,
    subscription_status text DEFAULT 'inactive'::text NOT NULL,
    subscription_started_at timestamp with time zone,
    subscription_expires_at timestamp with time zone,
    subscription_duration_type text,
    last_activation_code_id uuid,
    CONSTRAINT companies_active_discount_usage_mode_check CHECK ((active_discount_usage_mode = ANY (ARRAY['once'::text, 'monthly'::text]))),
    CONSTRAINT companies_approval_status_check CHECK ((approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'suspended'::text]))),
    CONSTRAINT companies_billing_cycle_check CHECK ((billing_cycle = ANY (ARRAY['monthly'::text, 'yearly'::text]))),
    CONSTRAINT companies_car_limit_positive CHECK ((subscription_car_limit >= 1)),
    CONSTRAINT companies_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'inactive'::text, 'trial'::text]))),
    CONSTRAINT companies_subscription_status_check CHECK ((subscription_status = ANY (ARRAY['inactive'::text, 'active'::text, 'expired'::text, 'suspended'::text])))
);


--
-- Name: company_planning_run_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_planning_run_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    run_id uuid NOT NULL,
    driver_id uuid,
    driver_name text,
    driver_usage_type text,
    block_date date NOT NULL,
    start_time text,
    end_time text,
    duration_minutes integer,
    source text,
    status text,
    reason text,
    trip_ids text[],
    original_driver_id uuid,
    original_driver_name text,
    proposed_driver_id uuid,
    proposed_driver_name text,
    metadata_json jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: company_planning_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_planning_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    month integer NOT NULL,
    year integer NOT NULL,
    import_id uuid,
    status text DEFAULT 'draft'::text NOT NULL,
    max_shift_minutes integer DEFAULT 480 NOT NULL,
    summary_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    settings_json jsonb,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    applied_by uuid,
    apply_summary_json jsonb
);


--
-- Name: company_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_name text DEFAULT 'Y&A Mobility'::text NOT NULL,
    legal_company_name text,
    slogan text,
    email text,
    phone text,
    mobile text,
    website text,
    support_email text,
    street text,
    house_number text,
    postal_code text,
    city text,
    state text,
    country text DEFAULT 'Deutschland'::text,
    manager_name text,
    owner_name text,
    authorized_representative text,
    vat_id text,
    tax_number text,
    commercial_register text,
    court_of_registration text,
    bank_name text,
    iban text,
    bic text,
    account_holder text,
    logo_url text,
    favicon_url text,
    stamp_url text,
    header_logo_url text,
    footer_logo_url text,
    signature_image_url text,
    primary_color text DEFAULT '#2563eb'::text,
    secondary_color text DEFAULT '#64748b'::text,
    default_signature_city text,
    default_footer_text text,
    default_email_signature text,
    default_print_header text,
    default_print_footer text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    company_id uuid,
    drivers_per_car_limit integer DEFAULT 4 NOT NULL,
    CONSTRAINT chk_drivers_per_car_limit CHECK (((drivers_per_car_limit >= 1) AND (drivers_per_car_limit <= 10)))
);


--
-- Name: company_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    starts_at date DEFAULT CURRENT_DATE NOT NULL,
    ends_at date,
    billing_day integer DEFAULT 1 NOT NULL,
    monthly_price numeric NOT NULL,
    payment_method text DEFAULT 'cash'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT company_subscriptions_billing_day_check CHECK (((billing_day >= 1) AND (billing_day <= 28))),
    CONSTRAINT company_subscriptions_monthly_price_check CHECK ((monthly_price >= (0)::numeric)),
    CONSTRAINT company_subscriptions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'canceled'::text, 'overdue'::text])))
);


--
-- Name: discount_code_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discount_code_redemptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    discount_code_id uuid NOT NULL,
    company_id uuid NOT NULL,
    user_id uuid,
    plan text NOT NULL,
    billing_cycle text NOT NULL,
    car_limit integer NOT NULL,
    original_price numeric NOT NULL,
    discount_amount numeric NOT NULL,
    final_price numeric NOT NULL,
    usage_mode text NOT NULL,
    redeemed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: discount_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discount_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    description text,
    discount_type text NOT NULL,
    discount_value numeric NOT NULL,
    usage_mode text NOT NULL,
    audience_type text NOT NULL,
    max_redemptions integer,
    used_count integer DEFAULT 0 NOT NULL,
    valid_from timestamp with time zone,
    valid_until timestamp with time zone,
    active boolean DEFAULT true NOT NULL,
    applies_to_plan text DEFAULT 'all'::text NOT NULL,
    applies_to_billing_cycle text DEFAULT 'all'::text NOT NULL,
    min_cars integer,
    max_cars integer,
    assigned_company_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT discount_codes_applies_to_billing_cycle_check CHECK ((applies_to_billing_cycle = ANY (ARRAY['monthly'::text, 'yearly'::text, 'all'::text]))),
    CONSTRAINT discount_codes_applies_to_plan_check CHECK ((applies_to_plan = ANY (ARRAY['basic'::text, 'advanced'::text, 'premium'::text, 'all'::text]))),
    CONSTRAINT discount_codes_audience_type_check CHECK ((audience_type = ANY (ARRAY['single'::text, 'multiple'::text]))),
    CONSTRAINT discount_codes_discount_type_check CHECK ((discount_type = ANY (ARRAY['percentage'::text, 'fixed'::text]))),
    CONSTRAINT discount_codes_discount_value_check CHECK ((discount_value >= (0)::numeric)),
    CONSTRAINT discount_codes_max_cars_check CHECK (((max_cars IS NULL) OR (max_cars >= 1))),
    CONSTRAINT discount_codes_max_redemptions_check CHECK (((max_redemptions IS NULL) OR (max_redemptions > 0))),
    CONSTRAINT discount_codes_min_cars_check CHECK (((min_cars IS NULL) OR (min_cars >= 1))),
    CONSTRAINT discount_codes_usage_mode_check CHECK ((usage_mode = ANY (ARRAY['once'::text, 'monthly'::text])))
);


--
-- Name: document_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    block_type text NOT NULL,
    content jsonb DEFAULT '{}'::jsonb NOT NULL,
    "order" integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT document_blocks_block_type_check CHECK ((block_type = ANY (ARRAY['title'::text, 'subtitle'::text, 'paragraph'::text, 'richtext'::text, 'table'::text, 'image'::text, 'logo'::text, 'spacer'::text, 'divider'::text, 'date_place'::text, 'signature'::text, 'header'::text, 'footer'::text])))
);


--
-- Name: document_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    icon text,
    color text,
    "order" integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: document_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    file_path text NOT NULL,
    file_url text NOT NULL,
    thumbnail_url text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone DEFAULT now(),
    usage_count integer DEFAULT 0,
    company_id uuid
);


--
-- Name: document_variables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_variables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    label text NOT NULL,
    key text NOT NULL,
    variable_type text DEFAULT 'text'::text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    required boolean DEFAULT false,
    default_value text,
    value text,
    description text,
    "order" integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT document_variables_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'company'::text, 'driver'::text, 'payroll'::text, 'vehicle'::text, 'system'::text]))),
    CONSTRAINT document_variables_variable_type_check CHECK ((variable_type = ANY (ARRAY['text'::text, 'multiline'::text, 'date'::text, 'number'::text, 'currency'::text, 'boolean'::text, 'email'::text, 'phone'::text, 'signature'::text])))
);


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    category text DEFAULT 'Allgemein'::text NOT NULL,
    source_type text DEFAULT 'template'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    file_url text,
    file_type text,
    file_size bigint,
    content jsonb DEFAULT '[]'::jsonb,
    include_header boolean DEFAULT true,
    include_footer boolean DEFAULT true,
    include_signature boolean DEFAULT false,
    include_company_logo boolean DEFAULT true,
    include_company_info boolean DEFAULT true,
    preview_image_url text,
    is_pinned boolean DEFAULT false,
    parent_template_id uuid,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    company_id uuid,
    CONSTRAINT documents_source_type_check CHECK ((source_type = ANY (ARRAY['uploaded'::text, 'template'::text, 'generated'::text]))),
    CONSTRAINT documents_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])))
);


--
-- Name: driver_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_by uuid NOT NULL,
    driver_id uuid NOT NULL,
    note_date timestamp with time zone DEFAULT now() NOT NULL,
    note_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    company_id uuid,
    note_type text DEFAULT 'general'::text NOT NULL,
    note_planning_behavior text DEFAULT 'neutral'::text NOT NULL,
    is_full_day boolean DEFAULT false NOT NULL,
    start_time text,
    end_time text,
    start_date date,
    end_date date,
    CONSTRAINT driver_notes_note_planning_behavior_check CHECK ((note_planning_behavior = ANY (ARRAY['neutral'::text, 'exclude_from_plan'::text, 'must_include_in_plan'::text])))
);


--
-- Name: drivers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.drivers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    user_id uuid,
    created_by text,
    salary_ratio numeric(5,4) DEFAULT 0.5000 NOT NULL,
    status text DEFAULT 'active'::text,
    company_id uuid,
    personalnummer text,
    gender text,
    driver_usage_type text DEFAULT 'regular'::text NOT NULL,
    target_monthly_hours numeric,
    max_monthly_hours numeric,
    planning_target_salary numeric,
    planning_hourly_rate numeric,
    planning_priority integer DEFAULT 100 NOT NULL,
    planning_enabled boolean DEFAULT true NOT NULL,
    allowed_weekdays integer[],
    work_window_start text,
    work_window_end text,
    can_cover_other_drivers boolean DEFAULT true,
    preferred_shift_start_time text,
    preferred_shift_end_time text,
    allow_extra_hours_before_first_ride boolean DEFAULT true NOT NULL,
    allow_extra_hours_after_last_ride boolean DEFAULT true NOT NULL,
    planned_shift_start_time text,
    planned_shift_end_time text,
    planned_working_days text[] DEFAULT ARRAY['mon'::text, 'tue'::text, 'wed'::text, 'thu'::text, 'fri'::text] NOT NULL,
    allow_outside_shift_exceptions boolean DEFAULT false NOT NULL,
    is_full_day_available boolean DEFAULT false NOT NULL,
    employment_type text DEFAULT 'employee'::text NOT NULL,
    planning_min_salary numeric(10,2),
    planning_max_salary numeric(10,2),
    CONSTRAINT drivers_driver_usage_type_check CHECK ((driver_usage_type = ANY (ARRAY['regular'::text, 'coverage_only'::text]))),
    CONSTRAINT drivers_gender_check CHECK (((gender IS NULL) OR (gender = ANY (ARRAY['male'::text, 'female'::text])))),
    CONSTRAINT drivers_salary_ratio_check CHECK (((salary_ratio >= (0)::numeric) AND (salary_ratio <= (1)::numeric))),
    CONSTRAINT drivers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))
);


--
-- Name: COLUMN drivers.planned_shift_start_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.drivers.planned_shift_start_time IS 'Planned shift start (HH:MM). If both start and end are set, planner enforces this window. Supports cross-midnight (start > end).';


--
-- Name: COLUMN drivers.planned_shift_end_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.drivers.planned_shift_end_time IS 'Planned shift end (HH:MM). Cross-midnight when start > end.';


--
-- Name: COLUMN drivers.planned_working_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.drivers.planned_working_days IS 'Weekdays the driver is normally available. Codes: mon,tue,wed,thu,fri,sat,sun.';


--
-- Name: COLUMN drivers.allow_outside_shift_exceptions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.drivers.allow_outside_shift_exceptions IS 'If true, planner may propose work outside the shift window as exceptions requiring user acceptance.';


--
-- Name: COLUMN drivers.is_full_day_available; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.drivers.is_full_day_available IS 'If true, the driver is available 24h on all allowed weekdays. Planner bypasses the work-time-window check while still enforcing weekday, daily/monthly limits, overlap, vehicle-switch buffer and notes.';


--
-- Name: fahrtenbuch_assignment_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fahrtenbuch_assignment_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    trip_id uuid NOT NULL,
    trip_date date NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    price_amount numeric(10,2) NOT NULL,
    original_driver_id uuid,
    original_driver_name text NOT NULL,
    old_assigned_driver_id uuid,
    old_assigned_driver_name text,
    new_assigned_driver_id uuid,
    new_assigned_driver_name text NOT NULL,
    reason text,
    changed_by uuid NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: fahrtenbuch_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fahrtenbuch_imports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    month smallint NOT NULL,
    year smallint NOT NULL,
    file_name text NOT NULL,
    imported_by uuid NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    row_count integer DEFAULT 0 NOT NULL,
    notes text,
    source_columns_json jsonb,
    source_sheet_name text,
    storage_path text,
    CONSTRAINT fahrtenbuch_imports_month_check CHECK (((month >= 1) AND (month <= 12))),
    CONSTRAINT fahrtenbuch_imports_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'archived'::text]))),
    CONSTRAINT fahrtenbuch_imports_year_check CHECK (((year >= 2000) AND (year <= 2100)))
);


--
-- Name: fahrtenbuch_trips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fahrtenbuch_trips (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    import_id uuid NOT NULL,
    trip_date date NOT NULL,
    start_time time without time zone,
    end_time time without time zone,
    duration_minutes integer,
    original_driver_id uuid,
    original_driver_name text NOT NULL,
    assigned_driver_id uuid,
    assigned_driver_name text NOT NULL,
    car_id uuid,
    car_identifier text,
    route_start text,
    route_end text,
    description text,
    price_amount numeric(10,2) DEFAULT 0 NOT NULL,
    cash_amount numeric(10,2) DEFAULT 0 NOT NULL,
    online_amount numeric(10,2) DEFAULT 0 NOT NULL,
    tip_amount numeric(10,2) DEFAULT 0 NOT NULL,
    action_amount numeric(10,2) DEFAULT 0 NOT NULL,
    raw_data_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    plausibility_status text DEFAULT 'pending'::text NOT NULL,
    assignment_reason text,
    assignment_note text,
    confirmed_by uuid,
    confirmed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_status text,
    is_canceled boolean DEFAULT false NOT NULL,
    source_row_index integer,
    assignment_source text,
    assignment_block_id text,
    assignment_planning_run_id uuid,
    assignment_applied_at timestamp with time zone,
    assignment_applied_by uuid,
    CONSTRAINT fahrtenbuch_trips_duration_minutes_check CHECK ((duration_minutes >= 0)),
    CONSTRAINT fahrtenbuch_trips_plausibility_status_check CHECK ((plausibility_status = ANY (ARRAY['pending'::text, 'ok'::text, 'uncovered'::text, 'overlap'::text, 'canceled'::text, 'planned_reassignment'::text])))
);


--
-- Name: fixed_costs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fixed_costs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    description text NOT NULL,
    amount numeric(10,2) DEFAULT 0 NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    company_id uuid
);


--
-- Name: historical_block_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.historical_block_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    reconciliation_id uuid,
    block_id text NOT NULL,
    fahrt_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_row_indices jsonb DEFAULT '[]'::jsonb NOT NULL,
    vehicle text DEFAULT ''::text NOT NULL,
    original_date text DEFAULT ''::text NOT NULL,
    original_block_start text DEFAULT '00:00'::text NOT NULL,
    original_block_end text DEFAULT '00:00'::text NOT NULL,
    adjusted_block_start text,
    adjusted_block_end text,
    adjusted_date text,
    offset_seconds integer,
    proposed_driver_id text,
    proposed_driver_name text,
    original_driver_name text,
    status text DEFAULT 'proposal'::text NOT NULL,
    reason text,
    fail_reason text,
    conflicts jsonb DEFAULT '[]'::jsonb NOT NULL,
    impact text,
    approved_by uuid,
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT historical_block_adjustments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'proposal'::text, 'approved'::text, 'rejected'::text, 'no_slot'::text, 'invalid'::text])))
);


--
-- Name: historical_driver_hour_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.historical_driver_hour_targets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    driver_id uuid,
    driver_name text NOT NULL,
    month text NOT NULL,
    year integer NOT NULL,
    base_hours numeric(8,4) DEFAULT 0 NOT NULL,
    night_25_hours numeric(8,4) DEFAULT 0 NOT NULL,
    night_0_4_40_hours numeric(8,4) DEFAULT 0 NOT NULL,
    sunday_50_hours numeric(8,4) DEFAULT 0 NOT NULL,
    holiday_hours numeric(8,4) DEFAULT 0 NOT NULL,
    source_import_id uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT historical_driver_hour_targets_year_check CHECK (((year >= 2000) AND (year <= 2100)))
);


--
-- Name: historical_payroll_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.historical_payroll_targets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    month integer NOT NULL,
    year integer NOT NULL,
    driver_id uuid NOT NULL,
    wage_type_code text NOT NULL,
    wage_type_label text NOT NULL,
    target_hours_decimal numeric(10,4) DEFAULT 0 NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT historical_payroll_targets_month_check CHECK (((month >= 1) AND (month <= 12))),
    CONSTRAINT historical_payroll_targets_year_check CHECK (((year >= 2000) AND (year <= 2100)))
);


--
-- Name: historical_reconciliation_drivers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.historical_reconciliation_drivers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reconciliation_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    driver_name text NOT NULL,
    personalnummer text,
    hourly_rate_cents integer DEFAULT 0 NOT NULL,
    target_gross_cents integer DEFAULT 0 NOT NULL,
    gross_from_rides_cents integer,
    ausgleich_stunden_milli integer,
    final_gross_cents integer,
    export_blocked boolean DEFAULT false NOT NULL,
    export_block_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    include_in_reconciliation boolean DEFAULT true NOT NULL,
    is_owner_driver boolean DEFAULT false NOT NULL
);


--
-- Name: historical_reconciliation_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.historical_reconciliation_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reconciliation_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    rows_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    totals_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    corrections_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: historical_reconciliation_wh_drivers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.historical_reconciliation_wh_drivers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reconciliation_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    driver_name text NOT NULL,
    personalnummer text,
    hourly_rate_cents integer DEFAULT 0 NOT NULL,
    is_owner boolean DEFAULT false NOT NULL,
    is_included boolean DEFAULT true NOT NULL,
    hinweis text,
    target_base_hours numeric(10,4) DEFAULT 0 NOT NULL,
    target_night_25_hours numeric(10,4) DEFAULT 0 NOT NULL,
    target_night_40_hours numeric(10,4) DEFAULT 0 NOT NULL,
    target_sunday_50_hours numeric(10,4) DEFAULT 0 NOT NULL,
    target_holiday_hours numeric(10,4) DEFAULT 0 NOT NULL,
    actual_base_hours numeric(10,4),
    actual_night_25_hours numeric(10,4),
    actual_night_40_hours numeric(10,4),
    actual_sunday_50_hours numeric(10,4),
    actual_holiday_hours numeric(10,4),
    total_amount_cents integer,
    export_blocked boolean DEFAULT false NOT NULL,
    export_block_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: historical_reconciliations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.historical_reconciliations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    month integer NOT NULL,
    year integer NOT NULL,
    import_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finalized_at timestamp with time zone,
    notes text,
    use_inhaber boolean DEFAULT true NOT NULL,
    inhaber_driver_id uuid,
    inhaber_generate_pdf boolean DEFAULT true NOT NULL,
    reconciliation_mode text DEFAULT 'brutto_salary'::text NOT NULL,
    CONSTRAINT historical_reconciliations_month_check CHECK (((month >= 1) AND (month <= 12))),
    CONSTRAINT historical_reconciliations_reconciliation_mode_check CHECK ((reconciliation_mode = ANY (ARRAY['brutto_salary'::text, 'working_hours'::text]))),
    CONSTRAINT historical_reconciliations_year_check CHECK (((year >= 2000) AND (year <= 2100)))
);


--
-- Name: historical_time_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.historical_time_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    reconciliation_id uuid,
    source_row_index integer,
    fahrt_id uuid,
    original_start_time text NOT NULL,
    original_end_time text NOT NULL,
    adjusted_start_time text NOT NULL,
    adjusted_end_time text NOT NULL,
    duration_minutes integer NOT NULL,
    reason text,
    status text DEFAULT 'approved'::text NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    adjustment_type text,
    CONSTRAINT historical_time_adjustments_status_check CHECK ((status = ANY (ARRAY['proposal'::text, 'approved'::text, 'rejected'::text, 'invalid'::text])))
);


--
-- Name: historical_wh_saved_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.historical_wh_saved_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    month integer NOT NULL,
    year integer NOT NULL,
    import_id uuid,
    original_file_name text,
    storage_path text,
    source_sheet_name text,
    source_columns_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    saved_by uuid,
    saved_at timestamp with time zone DEFAULT now() NOT NULL,
    export_ready boolean DEFAULT true NOT NULL,
    export_block_reason text,
    boundary_rows_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    shift_map_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    note_reassignments_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    driver_configs_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    validation_summary_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    mode text DEFAULT 'historical_working_hours'::text NOT NULL,
    driver_hour_summary_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT historical_wh_saved_plans_month_check CHECK (((month >= 1) AND (month <= 12))),
    CONSTRAINT historical_wh_saved_plans_year_check CHECK (((year >= 2000) AND (year <= 2100)))
);


--
-- Name: monthly_planning_manual_exceptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monthly_planning_manual_exceptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    planning_run_id uuid NOT NULL,
    company_id uuid NOT NULL,
    import_id uuid,
    month integer,
    year integer,
    block_id text NOT NULL,
    vehicle_identifier text,
    service_date date,
    block_start_datetime timestamp with time zone,
    block_end_datetime timestamp with time zone,
    assigned_driver_id uuid,
    assigned_driver_name text,
    dienstzeit_exception boolean DEFAULT false NOT NULL,
    tageslimit_exception boolean DEFAULT false NOT NULL,
    reason text,
    confirmed_by uuid,
    confirmed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    monatslimit_exception boolean DEFAULT false NOT NULL
);


--
-- Name: notification_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    notification_type text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    email_global_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: planning_finalizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planning_finalizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    planning_run_id uuid NOT NULL,
    company_id uuid NOT NULL,
    finalized_at timestamp with time zone DEFAULT now() NOT NULL,
    finalized_by uuid,
    trip_count integer DEFAULT 0 NOT NULL,
    driver_count integer DEFAULT 0 NOT NULL,
    driver_summary_json jsonb,
    is_stale boolean DEFAULT false NOT NULL,
    stale_reason text,
    stale_at timestamp with time zone,
    document_status text DEFAULT 'ready'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: planning_run_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planning_run_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    planning_run_id uuid NOT NULL,
    company_id uuid NOT NULL,
    driver_id text NOT NULL,
    driver_name text NOT NULL,
    adjustment_type text DEFAULT 'gehaltsausgleich'::text NOT NULL,
    hours numeric(10,2) NOT NULL,
    amount numeric(10,2) NOT NULL,
    hourly_rate numeric(10,2) NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT planning_run_adjustments_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT planning_run_adjustments_hourly_rate_check CHECK ((hourly_rate > (0)::numeric)),
    CONSTRAINT planning_run_adjustments_hours_check CHECK ((hours > (0)::numeric))
);


--
-- Name: referrals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referrals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ref_code text NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role_id uuid NOT NULL,
    page_key text NOT NULL,
    can_view boolean DEFAULT false,
    can_edit boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text,
    is_system boolean DEFAULT false,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    company_id uuid
);


--
-- Name: COLUMN roles.company_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.roles.company_id IS 'Company this role belongs to. NULL for system/global roles.';


--
-- Name: salaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salaries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    calc_revenue numeric(14,2) DEFAULT 0 NOT NULL,
    calc_tips numeric(14,2) DEFAULT 0 NOT NULL,
    amount_due numeric(14,2) DEFAULT 0 NOT NULL,
    status text DEFAULT 'unpaid'::text NOT NULL,
    paid_at timestamp with time zone,
    notes text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    netto_salary numeric(10,2),
    total_paid numeric(10,2) DEFAULT 0,
    remaining_balance numeric(10,2),
    payment_status text DEFAULT 'unpaid'::text,
    company_id uuid,
    payroll_gross_amount numeric(10,2),
    additional_net_payment_amount numeric(10,2),
    additional_payment_category text,
    additional_payment_note text,
    show_additional_note_in_pdf boolean DEFAULT false,
    tax_review_confirmed boolean DEFAULT false,
    tax_review_confirmed_at timestamp with time zone,
    tax_review_confirmed_by uuid,
    payroll_net_amount numeric(10,2),
    cash_salary_amount numeric(10,2),
    bank_salary_amount numeric(10,2),
    total_net_payout numeric(10,2),
    CONSTRAINT salaries_payment_status_check CHECK ((payment_status = ANY (ARRAY['unpaid'::text, 'partially_paid'::text, 'paid'::text]))),
    CONSTRAINT salaries_status_check CHECK ((status = ANY (ARRAY['paid'::text, 'unpaid'::text])))
);


--
-- Name: salary_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salary_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salary_id uuid NOT NULL,
    payment_type text NOT NULL,
    amount numeric(10,2) NOT NULL,
    payment_date date DEFAULT CURRENT_DATE NOT NULL,
    description text DEFAULT ''::text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    company_id uuid,
    payment_category text,
    source_type text DEFAULT 'manual'::text,
    source_reference text,
    week_start date,
    week_end date,
    CONSTRAINT salary_payments_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT salary_payments_payment_type_check CHECK ((payment_type = ANY (ARRAY['cash'::text, 'bank'::text])))
);


--
-- Name: saved_stundennachweise; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_stundennachweise (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    driver_name text NOT NULL,
    personalnummer text,
    month integer NOT NULL,
    year integer NOT NULL,
    grundlohn_min integer DEFAULT 0 NOT NULL,
    nachtarbeit_min integer DEFAULT 0 NOT NULL,
    nacht04_min integer DEFAULT 0 NOT NULL,
    samstag_min integer DEFAULT 0 NOT NULL,
    sonntag_min integer DEFAULT 0 NOT NULL,
    feiertag_min integer DEFAULT 0 NOT NULL,
    weihnachten_min integer DEFAULT 0 NOT NULL,
    working_days integer DEFAULT 0 NOT NULL,
    rows_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    saved_by uuid,
    saved_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    target_salary numeric,
    hourly_rate numeric,
    calculated_salary numeric,
    generation_mode text,
    grundlohn_ratio numeric,
    totals_target_json jsonb,
    work_window_json jsonb,
    generation_source text,
    source_import_id uuid,
    source_run_id uuid,
    generated_at timestamp with time zone,
    warnings_json jsonb,
    notes_snapshot_json jsonb DEFAULT '[]'::jsonb,
    coverage_summary_json jsonb,
    generation_settings_json jsonb,
    pdf_storage_path text,
    snapshot_hash text,
    CONSTRAINT saved_stundennachweise_month_check CHECK (((month >= 1) AND (month <= 12))),
    CONSTRAINT saved_stundennachweise_year_check CHECK (((year >= 2000) AND (year <= 2100)))
);


--
-- Name: COLUMN saved_stundennachweise.pdf_storage_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.saved_stundennachweise.pdf_storage_path IS 'Storage path in stundennachweise-pdfs bucket. When set, Documents page serves this file directly instead of regenerating.';


--
-- Name: COLUMN saved_stundennachweise.snapshot_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.saved_stundennachweise.snapshot_hash IS 'Lightweight hash: driver_id|run_id|grundlohn|nachtarbeit|month|year. Used to detect if stored PDF may be stale.';


--
-- Name: subscription_admin_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_admin_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    action_type text DEFAULT 'manual_edit'::text NOT NULL,
    old_status text,
    new_status text,
    old_expires_at timestamp with time zone,
    new_expires_at timestamp with time zone,
    reason text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscription_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    invoice_month integer NOT NULL,
    invoice_year integer NOT NULL,
    invoice_number text NOT NULL,
    amount numeric NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    payment_method text DEFAULT 'cash'::text NOT NULL,
    due_date date NOT NULL,
    paid_at timestamp with time zone,
    paid_by uuid,
    collected_by uuid,
    cash_received_amount numeric,
    receipt_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_invoices_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT subscription_invoices_invoice_month_check CHECK (((invoice_month >= 1) AND (invoice_month <= 12))),
    CONSTRAINT subscription_invoices_invoice_year_check CHECK ((invoice_year >= 2020)),
    CONSTRAINT subscription_invoices_status_check CHECK ((status = ANY (ARRAY['open'::text, 'paid'::text, 'overdue'::text, 'canceled'::text])))
);


--
-- Name: subscription_payment_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_payment_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    invoice_id uuid NOT NULL,
    company_id uuid NOT NULL,
    action text NOT NULL,
    old_status text,
    new_status text,
    amount numeric,
    changed_by uuid NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscription_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    monthly_price numeric NOT NULL,
    included_cars integer NOT NULL,
    drivers_per_car_limit integer DEFAULT 4 NOT NULL,
    features_json jsonb DEFAULT '{}'::jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_plans_drivers_per_car_limit_check CHECK (((drivers_per_car_limit >= 1) AND (drivers_per_car_limit <= 10))),
    CONSTRAINT subscription_plans_included_cars_check CHECK ((included_cars > 0)),
    CONSTRAINT subscription_plans_monthly_price_check CHECK ((monthly_price >= (0)::numeric))
);


--
-- Name: user_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_profiles (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    full_name text,
    role text DEFAULT 'viewer'::text NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    email text NOT NULL,
    role_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    invited_at timestamp with time zone,
    activated_at timestamp with time zone,
    company_id uuid,
    is_super_admin boolean DEFAULT false NOT NULL,
    must_change_password boolean DEFAULT false NOT NULL,
    CONSTRAINT user_profiles_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'pending_invite'::text, 'suspended'::text, 'deactivated'::text])))
);


--
-- Name: COLUMN user_profiles.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_profiles.status IS 'User account status: active, inactive, or pending_invite';


--
-- Name: COLUMN user_profiles.invited_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_profiles.invited_at IS 'Timestamp when user invitation was sent';


--
-- Name: COLUMN user_profiles.activated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_profiles.activated_at IS 'Timestamp when user first activated their account';


--
-- Name: COLUMN user_profiles.company_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_profiles.company_id IS 'Company/tenant this user belongs to. NULL for super admins or during migration.';


--
-- Name: COLUMN user_profiles.is_super_admin; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_profiles.is_super_admin IS 'Platform-level super admin with access to all companies.';


--
-- Name: user_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.user_profiles ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.user_profiles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sessions (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    session_token text NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now(),
    last_active_at timestamp with time zone DEFAULT now(),
    is_active boolean DEFAULT true
);


--
-- Name: user_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.user_sessions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.user_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: werkstatt_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.werkstatt_checks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    car_id uuid NOT NULL,
    week_number integer NOT NULL,
    year integer NOT NULL,
    check_date date DEFAULT CURRENT_DATE NOT NULL,
    status text DEFAULT 'positive'::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    repair_notes text,
    oil_status text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    km_stand integer DEFAULT 0 NOT NULL,
    company_id uuid,
    CONSTRAINT werkstatt_checks_km_stand_check CHECK (((km_stand IS NULL) OR (km_stand >= 0))),
    CONSTRAINT werkstatt_checks_status_check CHECK ((status = ANY (ARRAY['positive'::text, 'negative'::text, 'repaired'::text]))),
    CONSTRAINT werkstatt_checks_week_number_check CHECK (((week_number >= 1) AND (week_number <= 53))),
    CONSTRAINT werkstatt_checks_year_check CHECK (((year >= 2020) AND (year <= 2100)))
);


--
-- Name: activation_code_attempts activation_code_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_code_attempts
    ADD CONSTRAINT activation_code_attempts_pkey PRIMARY KEY (id);


--
-- Name: activation_codes activation_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_codes
    ADD CONSTRAINT activation_codes_pkey PRIMARY KEY (id);


--
-- Name: car_driver_assignments car_driver_assignments_car_id_driver_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.car_driver_assignments
    ADD CONSTRAINT car_driver_assignments_car_id_driver_id_key UNIQUE (car_id, driver_id);


--
-- Name: car_driver_assignments car_driver_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.car_driver_assignments
    ADD CONSTRAINT car_driver_assignments_pkey PRIMARY KEY (id);


--
-- Name: cars cars_kennzeichen_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cars
    ADD CONSTRAINT cars_kennzeichen_key UNIQUE (kennzeichen);


--
-- Name: cars cars_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cars
    ADD CONSTRAINT cars_pkey PRIMARY KEY (id);


--
-- Name: cash_transactions cash_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transactions
    ADD CONSTRAINT cash_transactions_pkey PRIMARY KEY (id);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: companies companies_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_slug_key UNIQUE (slug);


--
-- Name: company_planning_run_blocks company_planning_run_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_planning_run_blocks
    ADD CONSTRAINT company_planning_run_blocks_pkey PRIMARY KEY (id);


--
-- Name: company_planning_runs company_planning_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_planning_runs
    ADD CONSTRAINT company_planning_runs_pkey PRIMARY KEY (id);


--
-- Name: company_settings company_settings_company_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_settings
    ADD CONSTRAINT company_settings_company_id_key UNIQUE (company_id);


--
-- Name: company_settings company_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_settings
    ADD CONSTRAINT company_settings_pkey PRIMARY KEY (id);


--
-- Name: company_subscriptions company_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_subscriptions
    ADD CONSTRAINT company_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: discount_code_redemptions discount_code_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_code_redemptions
    ADD CONSTRAINT discount_code_redemptions_pkey PRIMARY KEY (id);


--
-- Name: discount_codes discount_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_codes
    ADD CONSTRAINT discount_codes_code_key UNIQUE (code);


--
-- Name: discount_codes discount_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_codes
    ADD CONSTRAINT discount_codes_pkey PRIMARY KEY (id);


--
-- Name: document_blocks document_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_blocks
    ADD CONSTRAINT document_blocks_pkey PRIMARY KEY (id);


--
-- Name: document_categories document_categories_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_categories
    ADD CONSTRAINT document_categories_name_key UNIQUE (name);


--
-- Name: document_categories document_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_categories
    ADD CONSTRAINT document_categories_pkey PRIMARY KEY (id);


--
-- Name: document_templates document_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_templates
    ADD CONSTRAINT document_templates_pkey PRIMARY KEY (id);


--
-- Name: document_variables document_variables_document_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_variables
    ADD CONSTRAINT document_variables_document_id_key_key UNIQUE (document_id, key);


--
-- Name: document_variables document_variables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_variables
    ADD CONSTRAINT document_variables_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: driver_notes driver_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_notes
    ADD CONSTRAINT driver_notes_pkey PRIMARY KEY (id);


--
-- Name: drivers drivers_personalnummer_company_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_personalnummer_company_unique UNIQUE (company_id, personalnummer);


--
-- Name: drivers drivers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_pkey PRIMARY KEY (id);


--
-- Name: fahrtenbuch_assignment_audit fahrtenbuch_assignment_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_assignment_audit
    ADD CONSTRAINT fahrtenbuch_assignment_audit_pkey PRIMARY KEY (id);


--
-- Name: fahrtenbuch_imports fahrtenbuch_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_imports
    ADD CONSTRAINT fahrtenbuch_imports_pkey PRIMARY KEY (id);


--
-- Name: fahrtenbuch_trips fahrtenbuch_trips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_trips
    ADD CONSTRAINT fahrtenbuch_trips_pkey PRIMARY KEY (id);


--
-- Name: fixed_costs fixed_costs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fixed_costs
    ADD CONSTRAINT fixed_costs_pkey PRIMARY KEY (id);


--
-- Name: historical_block_adjustments historical_block_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_block_adjustments
    ADD CONSTRAINT historical_block_adjustments_pkey PRIMARY KEY (id);


--
-- Name: historical_driver_hour_targets historical_driver_hour_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_driver_hour_targets
    ADD CONSTRAINT historical_driver_hour_targets_pkey PRIMARY KEY (id);


--
-- Name: historical_payroll_targets historical_payroll_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_payroll_targets
    ADD CONSTRAINT historical_payroll_targets_pkey PRIMARY KEY (id);


--
-- Name: historical_reconciliation_drivers historical_reconciliation_drive_reconciliation_id_driver_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliation_drivers
    ADD CONSTRAINT historical_reconciliation_drive_reconciliation_id_driver_id_key UNIQUE (reconciliation_id, driver_id);


--
-- Name: historical_reconciliation_drivers historical_reconciliation_drivers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliation_drivers
    ADD CONSTRAINT historical_reconciliation_drivers_pkey PRIMARY KEY (id);


--
-- Name: historical_reconciliation_results historical_reconciliation_resul_reconciliation_id_driver_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliation_results
    ADD CONSTRAINT historical_reconciliation_resul_reconciliation_id_driver_id_key UNIQUE (reconciliation_id, driver_id);


--
-- Name: historical_reconciliation_results historical_reconciliation_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliation_results
    ADD CONSTRAINT historical_reconciliation_results_pkey PRIMARY KEY (id);


--
-- Name: historical_reconciliation_wh_drivers historical_reconciliation_wh_dr_reconciliation_id_driver_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliation_wh_drivers
    ADD CONSTRAINT historical_reconciliation_wh_dr_reconciliation_id_driver_id_key UNIQUE (reconciliation_id, driver_id);


--
-- Name: historical_reconciliation_wh_drivers historical_reconciliation_wh_drivers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliation_wh_drivers
    ADD CONSTRAINT historical_reconciliation_wh_drivers_pkey PRIMARY KEY (id);


--
-- Name: historical_reconciliations historical_reconciliations_company_id_month_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliations
    ADD CONSTRAINT historical_reconciliations_company_id_month_year_key UNIQUE (company_id, month, year);


--
-- Name: historical_reconciliations historical_reconciliations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliations
    ADD CONSTRAINT historical_reconciliations_pkey PRIMARY KEY (id);


--
-- Name: historical_time_adjustments historical_time_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_time_adjustments
    ADD CONSTRAINT historical_time_adjustments_pkey PRIMARY KEY (id);


--
-- Name: historical_wh_saved_plans historical_wh_saved_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_wh_saved_plans
    ADD CONSTRAINT historical_wh_saved_plans_pkey PRIMARY KEY (id);


--
-- Name: income income_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.income
    ADD CONSTRAINT income_pkey PRIMARY KEY (id);


--
-- Name: monthly_planning_manual_exceptions monthly_planning_manual_exceptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_planning_manual_exceptions
    ADD CONSTRAINT monthly_planning_manual_exceptions_pkey PRIMARY KEY (id);


--
-- Name: notification_settings notification_settings_company_id_notification_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_settings
    ADD CONSTRAINT notification_settings_company_id_notification_type_key UNIQUE (company_id, notification_type);


--
-- Name: notification_settings notification_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_settings
    ADD CONSTRAINT notification_settings_pkey PRIMARY KEY (id);


--
-- Name: planning_finalizations planning_finalizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_finalizations
    ADD CONSTRAINT planning_finalizations_pkey PRIMARY KEY (id);


--
-- Name: planning_run_adjustments planning_run_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_run_adjustments
    ADD CONSTRAINT planning_run_adjustments_pkey PRIMARY KEY (id);


--
-- Name: receipts receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_pkey PRIMARY KEY (id);


--
-- Name: referrals referrals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_pkey PRIMARY KEY (id);


--
-- Name: referrals referrals_ref_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_ref_code_key UNIQUE (ref_code);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (id);


--
-- Name: role_permissions role_permissions_role_id_page_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_page_key_key UNIQUE (role_id, page_key);


--
-- Name: roles roles_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_name_key UNIQUE (name);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: salaries salaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salaries
    ADD CONSTRAINT salaries_pkey PRIMARY KEY (id);


--
-- Name: salary_payments salary_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_payments
    ADD CONSTRAINT salary_payments_pkey PRIMARY KEY (id);


--
-- Name: saved_stundennachweise saved_stundennachweise_company_id_driver_id_month_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_stundennachweise
    ADD CONSTRAINT saved_stundennachweise_company_id_driver_id_month_year_key UNIQUE (company_id, driver_id, month, year);


--
-- Name: saved_stundennachweise saved_stundennachweise_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_stundennachweise
    ADD CONSTRAINT saved_stundennachweise_pkey PRIMARY KEY (id);


--
-- Name: subscription_admin_actions subscription_admin_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_admin_actions
    ADD CONSTRAINT subscription_admin_actions_pkey PRIMARY KEY (id);


--
-- Name: subscription_invoices subscription_invoices_company_id_invoice_month_invoice_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT subscription_invoices_company_id_invoice_month_invoice_year_key UNIQUE (company_id, invoice_month, invoice_year);


--
-- Name: subscription_invoices subscription_invoices_invoice_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT subscription_invoices_invoice_number_key UNIQUE (invoice_number);


--
-- Name: subscription_invoices subscription_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT subscription_invoices_pkey PRIMARY KEY (id);


--
-- Name: subscription_payment_audit subscription_payment_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_payment_audit
    ADD CONSTRAINT subscription_payment_audit_pkey PRIMARY KEY (id);


--
-- Name: subscription_plans subscription_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT subscription_plans_pkey PRIMARY KEY (id);


--
-- Name: car_driver_assignments unique_car_role; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.car_driver_assignments
    ADD CONSTRAINT unique_car_role UNIQUE (car_id, role);


--
-- Name: salaries unique_driver_period; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salaries
    ADD CONSTRAINT unique_driver_period UNIQUE (driver_id, period_start);


--
-- Name: historical_payroll_targets uq_historical_payroll_target; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_payroll_targets
    ADD CONSTRAINT uq_historical_payroll_target UNIQUE (company_id, month, year, driver_id, wage_type_code);


--
-- Name: user_profiles user_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_pkey PRIMARY KEY (id);


--
-- Name: user_profiles user_profiles_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_user_id_key UNIQUE (user_id);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: werkstatt_checks werkstatt_checks_car_id_week_number_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.werkstatt_checks
    ADD CONSTRAINT werkstatt_checks_car_id_week_number_year_key UNIQUE (car_id, week_number, year);


--
-- Name: werkstatt_checks werkstatt_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.werkstatt_checks
    ADD CONSTRAINT werkstatt_checks_pkey PRIMARY KEY (id);


--
-- Name: hba_company_recon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hba_company_recon ON public.historical_block_adjustments USING btree (company_id, reconciliation_id);


--
-- Name: hdht_company_month_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hdht_company_month_year ON public.historical_driver_hour_targets USING btree (company_id, year, month);


--
-- Name: hdht_unique_driver_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX hdht_unique_driver_id ON public.historical_driver_hour_targets USING btree (company_id, driver_id, month, year) WHERE (driver_id IS NOT NULL);


--
-- Name: hdht_unique_driver_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX hdht_unique_driver_name ON public.historical_driver_hour_targets USING btree (company_id, lower(TRIM(BOTH FROM driver_name)), month, year) WHERE (driver_id IS NULL);


--
-- Name: historical_wh_saved_plans_company_month_year_mode_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX historical_wh_saved_plans_company_month_year_mode_key ON public.historical_wh_saved_plans USING btree (company_id, month, year, mode);


--
-- Name: hta_company_recon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hta_company_recon ON public.historical_time_adjustments USING btree (company_id, reconciliation_id);


--
-- Name: idx_activation_code_attempts_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activation_code_attempts_company ON public.activation_code_attempts USING btree (company_id, created_at);


--
-- Name: idx_activation_codes_code_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activation_codes_code_hash ON public.activation_codes USING btree (code_hash);


--
-- Name: idx_activation_codes_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activation_codes_expires_at ON public.activation_codes USING btree (expires_at);


--
-- Name: idx_activation_codes_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activation_codes_status ON public.activation_codes USING btree (status);


--
-- Name: idx_car_driver_assignments_car_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_car_driver_assignments_car_id ON public.car_driver_assignments USING btree (car_id);


--
-- Name: idx_car_driver_assignments_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_car_driver_assignments_company_id ON public.car_driver_assignments USING btree (company_id);


--
-- Name: idx_car_driver_assignments_driver_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_car_driver_assignments_driver_id ON public.car_driver_assignments USING btree (driver_id);


--
-- Name: idx_cars_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cars_company_id ON public.cars USING btree (company_id);


--
-- Name: idx_cars_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cars_company_status ON public.cars USING btree (company_id, status);


--
-- Name: idx_cars_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cars_created_by ON public.cars USING btree (created_by);


--
-- Name: idx_cars_kennzeichen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cars_kennzeichen ON public.cars USING btree (kennzeichen);


--
-- Name: idx_cash_transactions_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cash_transactions_company_id ON public.cash_transactions USING btree (company_id);


--
-- Name: idx_cash_transactions_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cash_transactions_created_by ON public.cash_transactions USING btree (created_by);


--
-- Name: idx_cash_transactions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cash_transactions_date ON public.cash_transactions USING btree (date DESC);


--
-- Name: idx_companies_approval_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_approval_status ON public.companies USING btree (approval_status);


--
-- Name: idx_companies_referral_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_referral_id ON public.companies USING btree (referral_id);


--
-- Name: idx_companies_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_slug ON public.companies USING btree (slug);


--
-- Name: idx_companies_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_status ON public.companies USING btree (status);


--
-- Name: idx_companies_subscription_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_subscription_expires_at ON public.companies USING btree (subscription_expires_at);


--
-- Name: idx_companies_subscription_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_subscription_status ON public.companies USING btree (subscription_status);


--
-- Name: idx_company_settings_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_settings_company_id ON public.company_settings USING btree (company_id);


--
-- Name: idx_company_subscriptions_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_subscriptions_company_id ON public.company_subscriptions USING btree (company_id);


--
-- Name: idx_company_subscriptions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_subscriptions_status ON public.company_subscriptions USING btree (status);


--
-- Name: idx_document_blocks_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_blocks_document ON public.document_blocks USING btree (document_id);


--
-- Name: idx_document_templates_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_templates_company_id ON public.document_templates USING btree (company_id);


--
-- Name: idx_document_templates_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_templates_created_by ON public.document_templates USING btree (created_by);


--
-- Name: idx_document_templates_last_used; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_templates_last_used ON public.document_templates USING btree (last_used_at DESC);


--
-- Name: idx_document_templates_usage_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_templates_usage_count ON public.document_templates USING btree (usage_count DESC);


--
-- Name: idx_document_variables_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_variables_document ON public.document_variables USING btree (document_id);


--
-- Name: idx_documents_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_category ON public.documents USING btree (category);


--
-- Name: idx_documents_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_company_id ON public.documents USING btree (company_id);


--
-- Name: idx_documents_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_created_by ON public.documents USING btree (created_by);


--
-- Name: idx_documents_parent_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_parent_template ON public.documents USING btree (parent_template_id);


--
-- Name: idx_documents_source_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_source_type ON public.documents USING btree (source_type);


--
-- Name: idx_documents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_status ON public.documents USING btree (status);


--
-- Name: idx_driver_notes_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_notes_company_id ON public.driver_notes USING btree (company_id);


--
-- Name: idx_driver_notes_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_notes_created_by ON public.driver_notes USING btree (created_by);


--
-- Name: idx_driver_notes_driver_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_notes_driver_id ON public.driver_notes USING btree (driver_id);


--
-- Name: idx_driver_notes_note_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_notes_note_date ON public.driver_notes USING btree (note_date DESC);


--
-- Name: idx_drivers_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drivers_company_id ON public.drivers USING btree (company_id);


--
-- Name: idx_drivers_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drivers_company_status ON public.drivers USING btree (company_id, status);


--
-- Name: idx_drivers_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drivers_created_at ON public.drivers USING btree (created_at);


--
-- Name: idx_drivers_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drivers_user_id ON public.drivers USING btree (user_id);


--
-- Name: idx_fahrtenbuch_audit_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fahrtenbuch_audit_company ON public.fahrtenbuch_assignment_audit USING btree (company_id);


--
-- Name: idx_fahrtenbuch_audit_trip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fahrtenbuch_audit_trip ON public.fahrtenbuch_assignment_audit USING btree (trip_id);


--
-- Name: idx_fahrtenbuch_imports_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fahrtenbuch_imports_company ON public.fahrtenbuch_imports USING btree (company_id);


--
-- Name: idx_fahrtenbuch_imports_monthyear; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fahrtenbuch_imports_monthyear ON public.fahrtenbuch_imports USING btree (company_id, year, month);


--
-- Name: idx_fahrtenbuch_trips_asgn_drv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fahrtenbuch_trips_asgn_drv ON public.fahrtenbuch_trips USING btree (company_id, assigned_driver_id);


--
-- Name: idx_fahrtenbuch_trips_canceled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fahrtenbuch_trips_canceled ON public.fahrtenbuch_trips USING btree (company_id, is_canceled);


--
-- Name: idx_fahrtenbuch_trips_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fahrtenbuch_trips_company ON public.fahrtenbuch_trips USING btree (company_id);


--
-- Name: idx_fahrtenbuch_trips_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fahrtenbuch_trips_date ON public.fahrtenbuch_trips USING btree (company_id, trip_date);


--
-- Name: idx_fahrtenbuch_trips_import; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fahrtenbuch_trips_import ON public.fahrtenbuch_trips USING btree (import_id);


--
-- Name: idx_fahrtenbuch_trips_orig_drv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fahrtenbuch_trips_orig_drv ON public.fahrtenbuch_trips USING btree (company_id, original_driver_id);


--
-- Name: idx_fahrtenbuch_trips_planning_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fahrtenbuch_trips_planning_run ON public.fahrtenbuch_trips USING btree (assignment_planning_run_id);


--
-- Name: idx_fahrtenbuch_trips_source_row; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fahrtenbuch_trips_source_row ON public.fahrtenbuch_trips USING btree (import_id, source_row_index);


--
-- Name: idx_fixed_costs_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fixed_costs_company_id ON public.fixed_costs USING btree (company_id);


--
-- Name: idx_hist_payroll_company_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hist_payroll_company_period ON public.historical_payroll_targets USING btree (company_id, year, month);


--
-- Name: idx_hist_recon_wh_drivers_recon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hist_recon_wh_drivers_recon ON public.historical_reconciliation_wh_drivers USING btree (reconciliation_id);


--
-- Name: idx_historical_wh_saved_plans_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_historical_wh_saved_plans_company ON public.historical_wh_saved_plans USING btree (company_id, year DESC, month DESC);


--
-- Name: idx_income_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_income_company_id ON public.income USING btree (company_id);


--
-- Name: idx_income_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_income_date ON public.income USING btree (date);


--
-- Name: idx_income_driver_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_income_driver_name ON public.income USING btree (driver_name);


--
-- Name: idx_notification_settings_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_settings_company_id ON public.notification_settings USING btree (company_id);


--
-- Name: idx_planning_blocks_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planning_blocks_run ON public.company_planning_run_blocks USING btree (run_id);


--
-- Name: idx_planning_finalizations_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planning_finalizations_company_id ON public.planning_finalizations USING btree (company_id);


--
-- Name: idx_planning_finalizations_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planning_finalizations_run_id ON public.planning_finalizations USING btree (planning_run_id);


--
-- Name: idx_planning_run_adjustments_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planning_run_adjustments_company ON public.planning_run_adjustments USING btree (company_id);


--
-- Name: idx_planning_run_adjustments_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planning_run_adjustments_run ON public.planning_run_adjustments USING btree (planning_run_id);


--
-- Name: idx_planning_runs_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_planning_runs_company ON public.company_planning_runs USING btree (company_id);


--
-- Name: idx_receipts_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receipts_company_id ON public.receipts USING btree (company_id);


--
-- Name: idx_receipts_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receipts_created_at ON public.receipts USING btree (created_at);


--
-- Name: idx_receipts_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receipts_created_by ON public.receipts USING btree (created_by);


--
-- Name: idx_receipts_payment_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receipts_payment_method ON public.receipts USING btree (payment_method);


--
-- Name: idx_receipts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receipts_user_id ON public.receipts USING btree (user_id);


--
-- Name: idx_referrals_ref_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referrals_ref_code ON public.referrals USING btree (ref_code);


--
-- Name: idx_roles_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roles_company_id ON public.roles USING btree (company_id);


--
-- Name: idx_roles_company_is_system; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roles_company_is_system ON public.roles USING btree (company_id, is_system);


--
-- Name: idx_salaries_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_salaries_company_id ON public.salaries USING btree (company_id);


--
-- Name: idx_salaries_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_salaries_created_by ON public.salaries USING btree (created_by);


--
-- Name: idx_salaries_driver_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_salaries_driver_id ON public.salaries USING btree (driver_id);


--
-- Name: idx_salaries_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_salaries_period ON public.salaries USING btree (period_start, period_end);


--
-- Name: idx_salaries_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_salaries_status ON public.salaries USING btree (status);


--
-- Name: idx_salary_payments_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_salary_payments_company_id ON public.salary_payments USING btree (company_id);


--
-- Name: idx_salary_payments_payment_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_salary_payments_payment_date ON public.salary_payments USING btree (payment_date);


--
-- Name: idx_salary_payments_salary_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_salary_payments_salary_id ON public.salary_payments USING btree (salary_id);


--
-- Name: idx_saved_stunden_company_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_saved_stunden_company_month ON public.saved_stundennachweise USING btree (company_id, year, month);


--
-- Name: idx_subscription_invoices_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscription_invoices_company_id ON public.subscription_invoices USING btree (company_id);


--
-- Name: idx_subscription_invoices_month_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscription_invoices_month_year ON public.subscription_invoices USING btree (invoice_year, invoice_month);


--
-- Name: idx_subscription_invoices_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscription_invoices_status ON public.subscription_invoices USING btree (status);


--
-- Name: idx_subscription_payment_audit_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscription_payment_audit_company_id ON public.subscription_payment_audit USING btree (company_id);


--
-- Name: idx_subscription_payment_audit_invoice_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscription_payment_audit_invoice_id ON public.subscription_payment_audit USING btree (invoice_id);


--
-- Name: idx_user_profiles_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_profiles_company_id ON public.user_profiles USING btree (company_id);


--
-- Name: idx_user_profiles_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_profiles_email ON public.user_profiles USING btree (email);


--
-- Name: idx_user_profiles_is_super_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_profiles_is_super_admin ON public.user_profiles USING btree (is_super_admin) WHERE (is_super_admin = true);


--
-- Name: idx_user_profiles_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_profiles_role ON public.user_profiles USING btree (role);


--
-- Name: idx_user_profiles_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_profiles_status ON public.user_profiles USING btree (status);


--
-- Name: idx_user_profiles_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_profiles_user_id ON public.user_profiles USING btree (user_id);


--
-- Name: idx_user_profiles_user_id_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_profiles_user_id_status ON public.user_profiles USING btree (user_id, status);


--
-- Name: idx_user_sessions_session_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_session_token ON public.user_sessions USING btree (session_token);


--
-- Name: idx_user_sessions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_user_id ON public.user_sessions USING btree (user_id);


--
-- Name: idx_werkstatt_checks_car_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_werkstatt_checks_car_id ON public.werkstatt_checks USING btree (car_id);


--
-- Name: idx_werkstatt_checks_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_werkstatt_checks_company_id ON public.werkstatt_checks USING btree (company_id);


--
-- Name: idx_werkstatt_checks_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_werkstatt_checks_created_by ON public.werkstatt_checks USING btree (created_by);


--
-- Name: idx_werkstatt_checks_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_werkstatt_checks_status ON public.werkstatt_checks USING btree (status);


--
-- Name: idx_werkstatt_checks_week_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_werkstatt_checks_week_year ON public.werkstatt_checks USING btree (week_number, year);


--
-- Name: uq_salary_payments_weekly_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_salary_payments_weekly_source ON public.salary_payments USING btree (company_id, salary_id, source_type, source_reference) WHERE (source_reference IS NOT NULL);


--
-- Name: car_driver_assignments enforce_max_drivers_per_car; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enforce_max_drivers_per_car BEFORE INSERT ON public.car_driver_assignments FOR EACH ROW EXECUTE FUNCTION public.check_max_drivers_per_car();


--
-- Name: income income_updated_at_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER income_updated_at_trigger BEFORE UPDATE ON public.income FOR EACH ROW EXECUTE FUNCTION public.update_income_updated_at();


--
-- Name: salaries salaries_updated_at_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER salaries_updated_at_trigger BEFORE UPDATE ON public.salaries FOR EACH ROW EXECUTE FUNCTION public.update_salaries_updated_at();


--
-- Name: company_subscriptions set_updated_at_company_subscriptions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_company_subscriptions BEFORE UPDATE ON public.company_subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: subscription_invoices set_updated_at_subscription_invoices; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_subscription_invoices BEFORE UPDATE ON public.subscription_invoices FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: subscription_plans set_updated_at_subscription_plans; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_subscription_plans BEFORE UPDATE ON public.subscription_plans FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: user_profiles sync_role_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sync_role_trigger BEFORE INSERT OR UPDATE ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION public.sync_user_profile_role();


--
-- Name: fahrtenbuch_trips tg_protect_fahrtenbuch_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_protect_fahrtenbuch_immutable BEFORE UPDATE ON public.fahrtenbuch_trips FOR EACH ROW EXECUTE FUNCTION public.protect_fahrtenbuch_immutable_fields();


--
-- Name: discount_codes trg_discount_codes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_discount_codes_updated_at BEFORE UPDATE ON public.discount_codes FOR EACH ROW EXECUTE FUNCTION public.update_discount_codes_updated_at();


--
-- Name: cars trg_enforce_car_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_enforce_car_limit BEFORE INSERT OR UPDATE ON public.cars FOR EACH ROW EXECUTE FUNCTION public.enforce_car_limit();


--
-- Name: drivers trg_enforce_driver_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_enforce_driver_limit BEFORE INSERT OR UPDATE ON public.drivers FOR EACH ROW EXECUTE FUNCTION public.enforce_driver_limit();


--
-- Name: notification_settings trg_notification_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notification_settings_updated_at BEFORE UPDATE ON public.notification_settings FOR EACH ROW EXECUTE FUNCTION public.update_notification_settings_updated_at();


--
-- Name: driver_notes trigger_update_driver_notes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_update_driver_notes_updated_at BEFORE UPDATE ON public.driver_notes FOR EACH ROW EXECUTE FUNCTION public.update_driver_notes_updated_at();


--
-- Name: cars update_cars_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_cars_updated_at BEFORE UPDATE ON public.cars FOR EACH ROW EXECUTE FUNCTION public.update_cars_updated_at();


--
-- Name: company_settings update_company_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_company_settings_updated_at BEFORE UPDATE ON public.company_settings FOR EACH ROW EXECUTE FUNCTION public.update_company_settings_updated_at();


--
-- Name: document_blocks update_document_blocks_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_document_blocks_timestamp BEFORE UPDATE ON public.document_blocks FOR EACH ROW EXECUTE FUNCTION public.update_documents_updated_at();


--
-- Name: documents update_documents_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_documents_timestamp BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.update_documents_updated_at();


--
-- Name: fixed_costs update_fixed_costs_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_fixed_costs_timestamp BEFORE UPDATE ON public.fixed_costs FOR EACH ROW EXECUTE FUNCTION public.update_fixed_costs_updated_at();


--
-- Name: roles update_roles_updated_at_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_roles_updated_at_trigger BEFORE UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION public.update_roles_updated_at();


--
-- Name: salary_payments update_salary_payments_updated_at_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_salary_payments_updated_at_trigger BEFORE UPDATE ON public.salary_payments FOR EACH ROW EXECUTE FUNCTION public.update_salary_payments_updated_at();


--
-- Name: salary_payments update_salary_status_on_payment_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_salary_status_on_payment_delete AFTER DELETE ON public.salary_payments FOR EACH ROW EXECUTE FUNCTION public.update_salary_payment_status();


--
-- Name: salary_payments update_salary_status_on_payment_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_salary_status_on_payment_insert AFTER INSERT ON public.salary_payments FOR EACH ROW EXECUTE FUNCTION public.update_salary_payment_status();


--
-- Name: salary_payments update_salary_status_on_payment_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_salary_status_on_payment_update AFTER UPDATE ON public.salary_payments FOR EACH ROW EXECUTE FUNCTION public.update_salary_payment_status();


--
-- Name: user_profiles user_profiles_privilege_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_profiles_privilege_guard BEFORE INSERT OR UPDATE ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION public.enforce_user_profile_privilege_guard();


--
-- Name: werkstatt_checks werkstatt_checks_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER werkstatt_checks_updated_at BEFORE UPDATE ON public.werkstatt_checks FOR EACH ROW EXECUTE FUNCTION public.update_werkstatt_checks_updated_at();


--
-- Name: activation_code_attempts activation_code_attempts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_code_attempts
    ADD CONSTRAINT activation_code_attempts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: activation_code_attempts activation_code_attempts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_code_attempts
    ADD CONSTRAINT activation_code_attempts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: activation_codes activation_codes_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_codes
    ADD CONSTRAINT activation_codes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: activation_codes activation_codes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_codes
    ADD CONSTRAINT activation_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: activation_codes activation_codes_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_codes
    ADD CONSTRAINT activation_codes_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: activation_codes activation_codes_used_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_codes
    ADD CONSTRAINT activation_codes_used_by_fkey FOREIGN KEY (used_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: activation_codes activation_codes_used_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_codes
    ADD CONSTRAINT activation_codes_used_company_id_fkey FOREIGN KEY (used_company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: car_driver_assignments car_driver_assignments_car_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.car_driver_assignments
    ADD CONSTRAINT car_driver_assignments_car_id_fkey FOREIGN KEY (car_id) REFERENCES public.cars(id) ON DELETE CASCADE;


--
-- Name: car_driver_assignments car_driver_assignments_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.car_driver_assignments
    ADD CONSTRAINT car_driver_assignments_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;


--
-- Name: cars cars_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cars
    ADD CONSTRAINT cars_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: companies companies_active_discount_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_active_discount_code_id_fkey FOREIGN KEY (active_discount_code_id) REFERENCES public.discount_codes(id) ON DELETE SET NULL;


--
-- Name: companies companies_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: companies companies_rejected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_rejected_by_fkey FOREIGN KEY (rejected_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: company_planning_run_blocks company_planning_run_blocks_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_planning_run_blocks
    ADD CONSTRAINT company_planning_run_blocks_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.company_planning_runs(id) ON DELETE CASCADE;


--
-- Name: company_planning_runs company_planning_runs_applied_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_planning_runs
    ADD CONSTRAINT company_planning_runs_applied_by_fkey FOREIGN KEY (applied_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: company_planning_runs company_planning_runs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_planning_runs
    ADD CONSTRAINT company_planning_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: company_planning_runs company_planning_runs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_planning_runs
    ADD CONSTRAINT company_planning_runs_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: company_planning_runs company_planning_runs_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_planning_runs
    ADD CONSTRAINT company_planning_runs_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.fahrtenbuch_imports(id) ON DELETE SET NULL;


--
-- Name: company_settings company_settings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_settings
    ADD CONSTRAINT company_settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: company_settings company_settings_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_settings
    ADD CONSTRAINT company_settings_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: company_subscriptions company_subscriptions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_subscriptions
    ADD CONSTRAINT company_subscriptions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: company_subscriptions company_subscriptions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_subscriptions
    ADD CONSTRAINT company_subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.subscription_plans(id);


--
-- Name: discount_code_redemptions discount_code_redemptions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_code_redemptions
    ADD CONSTRAINT discount_code_redemptions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: discount_code_redemptions discount_code_redemptions_discount_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_code_redemptions
    ADD CONSTRAINT discount_code_redemptions_discount_code_id_fkey FOREIGN KEY (discount_code_id) REFERENCES public.discount_codes(id) ON DELETE CASCADE;


--
-- Name: discount_code_redemptions discount_code_redemptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_code_redemptions
    ADD CONSTRAINT discount_code_redemptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: discount_codes discount_codes_assigned_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_codes
    ADD CONSTRAINT discount_codes_assigned_company_id_fkey FOREIGN KEY (assigned_company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: discount_codes discount_codes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_codes
    ADD CONSTRAINT discount_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: document_blocks document_blocks_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_blocks
    ADD CONSTRAINT document_blocks_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_templates document_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_templates
    ADD CONSTRAINT document_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: document_variables document_variables_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_variables
    ADD CONSTRAINT document_variables_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: documents documents_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: documents documents_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: documents documents_parent_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_parent_template_id_fkey FOREIGN KEY (parent_template_id) REFERENCES public.documents(id) ON DELETE SET NULL;


--
-- Name: driver_notes driver_notes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_notes
    ADD CONSTRAINT driver_notes_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: driver_notes driver_notes_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_notes
    ADD CONSTRAINT driver_notes_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;


--
-- Name: drivers drivers_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: fahrtenbuch_assignment_audit fahrtenbuch_assignment_audit_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_assignment_audit
    ADD CONSTRAINT fahrtenbuch_assignment_audit_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.user_profiles(user_id) ON DELETE RESTRICT;


--
-- Name: fahrtenbuch_assignment_audit fahrtenbuch_assignment_audit_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_assignment_audit
    ADD CONSTRAINT fahrtenbuch_assignment_audit_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: fahrtenbuch_assignment_audit fahrtenbuch_assignment_audit_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_assignment_audit
    ADD CONSTRAINT fahrtenbuch_assignment_audit_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.fahrtenbuch_trips(id) ON DELETE CASCADE;


--
-- Name: fahrtenbuch_imports fahrtenbuch_imports_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_imports
    ADD CONSTRAINT fahrtenbuch_imports_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: fahrtenbuch_imports fahrtenbuch_imports_imported_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_imports
    ADD CONSTRAINT fahrtenbuch_imports_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES public.user_profiles(user_id) ON DELETE RESTRICT;


--
-- Name: fahrtenbuch_trips fahrtenbuch_trips_assigned_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_trips
    ADD CONSTRAINT fahrtenbuch_trips_assigned_driver_id_fkey FOREIGN KEY (assigned_driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;


--
-- Name: fahrtenbuch_trips fahrtenbuch_trips_assignment_applied_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_trips
    ADD CONSTRAINT fahrtenbuch_trips_assignment_applied_by_fkey FOREIGN KEY (assignment_applied_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: fahrtenbuch_trips fahrtenbuch_trips_assignment_planning_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_trips
    ADD CONSTRAINT fahrtenbuch_trips_assignment_planning_run_id_fkey FOREIGN KEY (assignment_planning_run_id) REFERENCES public.company_planning_runs(id) ON DELETE SET NULL;


--
-- Name: fahrtenbuch_trips fahrtenbuch_trips_car_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_trips
    ADD CONSTRAINT fahrtenbuch_trips_car_id_fkey FOREIGN KEY (car_id) REFERENCES public.cars(id) ON DELETE SET NULL;


--
-- Name: fahrtenbuch_trips fahrtenbuch_trips_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_trips
    ADD CONSTRAINT fahrtenbuch_trips_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: fahrtenbuch_trips fahrtenbuch_trips_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_trips
    ADD CONSTRAINT fahrtenbuch_trips_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.user_profiles(user_id) ON DELETE SET NULL;


--
-- Name: fahrtenbuch_trips fahrtenbuch_trips_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_trips
    ADD CONSTRAINT fahrtenbuch_trips_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.fahrtenbuch_imports(id) ON DELETE CASCADE;


--
-- Name: fahrtenbuch_trips fahrtenbuch_trips_original_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fahrtenbuch_trips
    ADD CONSTRAINT fahrtenbuch_trips_original_driver_id_fkey FOREIGN KEY (original_driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;


--
-- Name: fixed_costs fixed_costs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fixed_costs
    ADD CONSTRAINT fixed_costs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: companies fk_companies_referral_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT fk_companies_referral_id FOREIGN KEY (referral_id) REFERENCES public.referrals(id) ON DELETE SET NULL;


--
-- Name: drivers fk_drivers_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT fk_drivers_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: receipts fk_receipts_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT fk_receipts_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: historical_block_adjustments historical_block_adjustments_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_block_adjustments
    ADD CONSTRAINT historical_block_adjustments_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: historical_block_adjustments historical_block_adjustments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_block_adjustments
    ADD CONSTRAINT historical_block_adjustments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: historical_block_adjustments historical_block_adjustments_reconciliation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_block_adjustments
    ADD CONSTRAINT historical_block_adjustments_reconciliation_id_fkey FOREIGN KEY (reconciliation_id) REFERENCES public.historical_reconciliations(id) ON DELETE CASCADE;


--
-- Name: historical_driver_hour_targets historical_driver_hour_targets_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_driver_hour_targets
    ADD CONSTRAINT historical_driver_hour_targets_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: historical_driver_hour_targets historical_driver_hour_targets_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_driver_hour_targets
    ADD CONSTRAINT historical_driver_hour_targets_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;


--
-- Name: historical_driver_hour_targets historical_driver_hour_targets_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_driver_hour_targets
    ADD CONSTRAINT historical_driver_hour_targets_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: historical_reconciliation_drivers historical_reconciliation_drivers_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliation_drivers
    ADD CONSTRAINT historical_reconciliation_drivers_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;


--
-- Name: historical_reconciliation_drivers historical_reconciliation_drivers_reconciliation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliation_drivers
    ADD CONSTRAINT historical_reconciliation_drivers_reconciliation_id_fkey FOREIGN KEY (reconciliation_id) REFERENCES public.historical_reconciliations(id) ON DELETE CASCADE;


--
-- Name: historical_reconciliation_results historical_reconciliation_results_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliation_results
    ADD CONSTRAINT historical_reconciliation_results_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;


--
-- Name: historical_reconciliation_results historical_reconciliation_results_reconciliation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliation_results
    ADD CONSTRAINT historical_reconciliation_results_reconciliation_id_fkey FOREIGN KEY (reconciliation_id) REFERENCES public.historical_reconciliations(id) ON DELETE CASCADE;


--
-- Name: historical_reconciliation_wh_drivers historical_reconciliation_wh_drivers_reconciliation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliation_wh_drivers
    ADD CONSTRAINT historical_reconciliation_wh_drivers_reconciliation_id_fkey FOREIGN KEY (reconciliation_id) REFERENCES public.historical_reconciliations(id) ON DELETE CASCADE;


--
-- Name: historical_reconciliations historical_reconciliations_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliations
    ADD CONSTRAINT historical_reconciliations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: historical_reconciliations historical_reconciliations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliations
    ADD CONSTRAINT historical_reconciliations_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: historical_reconciliations historical_reconciliations_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliations
    ADD CONSTRAINT historical_reconciliations_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.fahrtenbuch_imports(id) ON DELETE SET NULL;


--
-- Name: historical_reconciliations historical_reconciliations_inhaber_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_reconciliations
    ADD CONSTRAINT historical_reconciliations_inhaber_driver_id_fkey FOREIGN KEY (inhaber_driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;


--
-- Name: historical_time_adjustments historical_time_adjustments_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_time_adjustments
    ADD CONSTRAINT historical_time_adjustments_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: historical_time_adjustments historical_time_adjustments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_time_adjustments
    ADD CONSTRAINT historical_time_adjustments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: historical_time_adjustments historical_time_adjustments_reconciliation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_time_adjustments
    ADD CONSTRAINT historical_time_adjustments_reconciliation_id_fkey FOREIGN KEY (reconciliation_id) REFERENCES public.historical_reconciliations(id) ON DELETE CASCADE;


--
-- Name: historical_wh_saved_plans historical_wh_saved_plans_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_wh_saved_plans
    ADD CONSTRAINT historical_wh_saved_plans_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: historical_wh_saved_plans historical_wh_saved_plans_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_wh_saved_plans
    ADD CONSTRAINT historical_wh_saved_plans_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.fahrtenbuch_imports(id) ON DELETE SET NULL;


--
-- Name: historical_wh_saved_plans historical_wh_saved_plans_saved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_wh_saved_plans
    ADD CONSTRAINT historical_wh_saved_plans_saved_by_fkey FOREIGN KEY (saved_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: income income_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.income
    ADD CONSTRAINT income_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: monthly_planning_manual_exceptions monthly_planning_manual_exceptions_assigned_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_planning_manual_exceptions
    ADD CONSTRAINT monthly_planning_manual_exceptions_assigned_driver_id_fkey FOREIGN KEY (assigned_driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;


--
-- Name: monthly_planning_manual_exceptions monthly_planning_manual_exceptions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_planning_manual_exceptions
    ADD CONSTRAINT monthly_planning_manual_exceptions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: monthly_planning_manual_exceptions monthly_planning_manual_exceptions_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_planning_manual_exceptions
    ADD CONSTRAINT monthly_planning_manual_exceptions_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: monthly_planning_manual_exceptions monthly_planning_manual_exceptions_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_planning_manual_exceptions
    ADD CONSTRAINT monthly_planning_manual_exceptions_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.fahrtenbuch_imports(id) ON DELETE SET NULL;


--
-- Name: monthly_planning_manual_exceptions monthly_planning_manual_exceptions_planning_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_planning_manual_exceptions
    ADD CONSTRAINT monthly_planning_manual_exceptions_planning_run_id_fkey FOREIGN KEY (planning_run_id) REFERENCES public.company_planning_runs(id) ON DELETE CASCADE;


--
-- Name: notification_settings notification_settings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_settings
    ADD CONSTRAINT notification_settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: planning_finalizations planning_finalizations_finalized_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_finalizations
    ADD CONSTRAINT planning_finalizations_finalized_by_fkey FOREIGN KEY (finalized_by) REFERENCES auth.users(id);


--
-- Name: planning_finalizations planning_finalizations_planning_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_finalizations
    ADD CONSTRAINT planning_finalizations_planning_run_id_fkey FOREIGN KEY (planning_run_id) REFERENCES public.company_planning_runs(id) ON DELETE CASCADE;


--
-- Name: planning_run_adjustments planning_run_adjustments_planning_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planning_run_adjustments
    ADD CONSTRAINT planning_run_adjustments_planning_run_id_fkey FOREIGN KEY (planning_run_id) REFERENCES public.company_planning_runs(id) ON DELETE CASCADE;


--
-- Name: receipts receipts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: referrals referrals_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: role_permissions role_permissions_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: roles roles_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: roles roles_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: salaries salaries_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salaries
    ADD CONSTRAINT salaries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: salaries salaries_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salaries
    ADD CONSTRAINT salaries_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;


--
-- Name: salaries salaries_tax_review_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salaries
    ADD CONSTRAINT salaries_tax_review_confirmed_by_fkey FOREIGN KEY (tax_review_confirmed_by) REFERENCES auth.users(id);


--
-- Name: salary_payments salary_payments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_payments
    ADD CONSTRAINT salary_payments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: salary_payments salary_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_payments
    ADD CONSTRAINT salary_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: salary_payments salary_payments_salary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_payments
    ADD CONSTRAINT salary_payments_salary_id_fkey FOREIGN KEY (salary_id) REFERENCES public.salaries(id) ON DELETE CASCADE;


--
-- Name: saved_stundennachweise saved_stundennachweise_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_stundennachweise
    ADD CONSTRAINT saved_stundennachweise_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: saved_stundennachweise saved_stundennachweise_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_stundennachweise
    ADD CONSTRAINT saved_stundennachweise_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;


--
-- Name: saved_stundennachweise saved_stundennachweise_saved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_stundennachweise
    ADD CONSTRAINT saved_stundennachweise_saved_by_fkey FOREIGN KEY (saved_by) REFERENCES public.user_profiles(user_id) ON DELETE SET NULL;


--
-- Name: subscription_admin_actions subscription_admin_actions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_admin_actions
    ADD CONSTRAINT subscription_admin_actions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: subscription_admin_actions subscription_admin_actions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_admin_actions
    ADD CONSTRAINT subscription_admin_actions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: subscription_invoices subscription_invoices_collected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT subscription_invoices_collected_by_fkey FOREIGN KEY (collected_by) REFERENCES auth.users(id);


--
-- Name: subscription_invoices subscription_invoices_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT subscription_invoices_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: subscription_invoices subscription_invoices_paid_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT subscription_invoices_paid_by_fkey FOREIGN KEY (paid_by) REFERENCES auth.users(id);


--
-- Name: subscription_invoices subscription_invoices_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT subscription_invoices_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.company_subscriptions(id) ON DELETE CASCADE;


--
-- Name: subscription_payment_audit subscription_payment_audit_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_payment_audit
    ADD CONSTRAINT subscription_payment_audit_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES auth.users(id);


--
-- Name: subscription_payment_audit subscription_payment_audit_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_payment_audit
    ADD CONSTRAINT subscription_payment_audit_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: subscription_payment_audit subscription_payment_audit_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_payment_audit
    ADD CONSTRAINT subscription_payment_audit_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.subscription_invoices(id) ON DELETE CASCADE;


--
-- Name: user_profiles user_profiles_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: user_profiles user_profiles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: werkstatt_checks werkstatt_checks_car_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.werkstatt_checks
    ADD CONSTRAINT werkstatt_checks_car_id_fkey FOREIGN KEY (car_id) REFERENCES public.cars(id) ON DELETE CASCADE;


--
-- Name: werkstatt_checks werkstatt_checks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.werkstatt_checks
    ADD CONSTRAINT werkstatt_checks_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: user_profiles Admins can delete company profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete company profiles" ON public.user_profiles FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: notification_settings Admins can insert notification settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert notification settings" ON public.notification_settings FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.role = ANY (ARRAY['admin'::text, 'support'::text]))))));


--
-- Name: notification_settings Admins can update notification settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update notification settings" ON public.notification_settings FOR UPDATE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.role = ANY (ARRAY['admin'::text, 'support'::text])))))) WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.role = ANY (ARRAY['admin'::text, 'support'::text]))))));


--
-- Name: discount_codes Authenticated users can view active discount codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view active discount codes" ON public.discount_codes FOR SELECT TO authenticated USING ((active = true));


--
-- Name: document_categories Authenticated users can view document_categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view document_categories" ON public.document_categories FOR SELECT TO authenticated USING (true);


--
-- Name: role_permissions Company admins can delete role_permissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company admins can delete role_permissions" ON public.role_permissions FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.roles r
  WHERE ((r.id = role_permissions.role_id) AND ((r.company_id = public.get_user_company_id()) OR public.is_user_super_admin())))));


--
-- Name: roles Company admins can delete roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company admins can delete roles" ON public.roles FOR DELETE TO authenticated USING ((((company_id = public.get_user_company_id()) OR public.is_user_super_admin()) AND (is_system = false)));


--
-- Name: company_settings Company admins can insert company_settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company admins can insert company_settings" ON public.company_settings FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: role_permissions Company admins can insert role_permissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company admins can insert role_permissions" ON public.role_permissions FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.roles r
  WHERE ((r.id = role_permissions.role_id) AND (r.company_id = public.get_user_company_id())))));


--
-- Name: roles Company admins can insert roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company admins can insert roles" ON public.roles FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: company_settings Company admins can update company_settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company admins can update company_settings" ON public.company_settings FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: role_permissions Company admins can update role_permissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company admins can update role_permissions" ON public.role_permissions FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.roles r
  WHERE ((r.id = role_permissions.role_id) AND ((r.company_id = public.get_user_company_id()) OR public.is_user_super_admin()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.roles r
  WHERE ((r.id = role_permissions.role_id) AND (r.company_id = public.get_user_company_id())))));


--
-- Name: roles Company admins can update roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company admins can update roles" ON public.roles FOR UPDATE TO authenticated USING ((((company_id = public.get_user_company_id()) OR public.is_user_super_admin()) AND (is_system = false))) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: companies Company admins can update their company; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company admins can update their company" ON public.companies FOR UPDATE TO authenticated USING (((id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK (((id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: notification_settings Company members can read notification settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company members can read notification settings" ON public.notification_settings FOR SELECT TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: discount_code_redemptions Company members can view own redemptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company members can view own redemptions" ON public.discount_code_redemptions FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id = discount_code_redemptions.company_id)))));


--
-- Name: car_driver_assignments Company users can delete car_driver_assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can delete car_driver_assignments" ON public.car_driver_assignments FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: cars Company users can delete cars; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can delete cars" ON public.cars FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: cash_transactions Company users can delete cash_transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can delete cash_transactions" ON public.cash_transactions FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: document_blocks Company users can delete document_blocks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can delete document_blocks" ON public.document_blocks FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.documents d
  WHERE ((d.id = document_blocks.document_id) AND ((d.company_id = public.get_user_company_id()) OR public.is_user_super_admin())))));


--
-- Name: document_templates Company users can delete document_templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can delete document_templates" ON public.document_templates FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: document_variables Company users can delete document_variables; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can delete document_variables" ON public.document_variables FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.documents d
  WHERE ((d.id = document_variables.document_id) AND ((d.company_id = public.get_user_company_id()) OR public.is_user_super_admin())))));


--
-- Name: documents Company users can delete documents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can delete documents" ON public.documents FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: driver_notes Company users can delete driver_notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can delete driver_notes" ON public.driver_notes FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: drivers Company users can delete drivers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can delete drivers" ON public.drivers FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: fixed_costs Company users can delete fixed_costs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can delete fixed_costs" ON public.fixed_costs FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: income Company users can delete income; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can delete income" ON public.income FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: receipts Company users can delete receipts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can delete receipts" ON public.receipts FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: salaries Company users can delete salaries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can delete salaries" ON public.salaries FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: salary_payments Company users can delete salary_payments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can delete salary_payments" ON public.salary_payments FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: werkstatt_checks Company users can delete werkstatt_checks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can delete werkstatt_checks" ON public.werkstatt_checks FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: car_driver_assignments Company users can insert car_driver_assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can insert car_driver_assignments" ON public.car_driver_assignments FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: cars Company users can insert cars; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can insert cars" ON public.cars FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: cash_transactions Company users can insert cash_transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can insert cash_transactions" ON public.cash_transactions FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: document_blocks Company users can insert document_blocks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can insert document_blocks" ON public.document_blocks FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.documents d
  WHERE ((d.id = document_blocks.document_id) AND (d.company_id = public.get_user_company_id())))));


--
-- Name: document_templates Company users can insert document_templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can insert document_templates" ON public.document_templates FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: document_variables Company users can insert document_variables; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can insert document_variables" ON public.document_variables FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.documents d
  WHERE ((d.id = document_variables.document_id) AND (d.company_id = public.get_user_company_id())))));


--
-- Name: documents Company users can insert documents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can insert documents" ON public.documents FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: driver_notes Company users can insert driver_notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can insert driver_notes" ON public.driver_notes FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: drivers Company users can insert drivers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can insert drivers" ON public.drivers FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: fixed_costs Company users can insert fixed_costs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can insert fixed_costs" ON public.fixed_costs FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: income Company users can insert income; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can insert income" ON public.income FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: receipts Company users can insert receipts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can insert receipts" ON public.receipts FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: salaries Company users can insert salaries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can insert salaries" ON public.salaries FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: salary_payments Company users can insert salary_payments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can insert salary_payments" ON public.salary_payments FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: werkstatt_checks Company users can insert werkstatt_checks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can insert werkstatt_checks" ON public.werkstatt_checks FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: car_driver_assignments Company users can update car_driver_assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can update car_driver_assignments" ON public.car_driver_assignments FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: cars Company users can update cars; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can update cars" ON public.cars FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: cash_transactions Company users can update cash_transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can update cash_transactions" ON public.cash_transactions FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: document_blocks Company users can update document_blocks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can update document_blocks" ON public.document_blocks FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.documents d
  WHERE ((d.id = document_blocks.document_id) AND ((d.company_id = public.get_user_company_id()) OR public.is_user_super_admin()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.documents d
  WHERE ((d.id = document_blocks.document_id) AND (d.company_id = public.get_user_company_id())))));


--
-- Name: document_templates Company users can update document_templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can update document_templates" ON public.document_templates FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: document_variables Company users can update document_variables; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can update document_variables" ON public.document_variables FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.documents d
  WHERE ((d.id = document_variables.document_id) AND ((d.company_id = public.get_user_company_id()) OR public.is_user_super_admin()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.documents d
  WHERE ((d.id = document_variables.document_id) AND (d.company_id = public.get_user_company_id())))));


--
-- Name: documents Company users can update documents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can update documents" ON public.documents FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: driver_notes Company users can update driver_notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can update driver_notes" ON public.driver_notes FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: drivers Company users can update drivers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can update drivers" ON public.drivers FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: fixed_costs Company users can update fixed_costs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can update fixed_costs" ON public.fixed_costs FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: income Company users can update income; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can update income" ON public.income FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: receipts Company users can update receipts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can update receipts" ON public.receipts FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: salaries Company users can update salaries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can update salaries" ON public.salaries FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: salary_payments Company users can update salary_payments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can update salary_payments" ON public.salary_payments FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: werkstatt_checks Company users can update werkstatt_checks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can update werkstatt_checks" ON public.werkstatt_checks FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: car_driver_assignments Company users can view car_driver_assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view car_driver_assignments" ON public.car_driver_assignments FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: cars Company users can view cars; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view cars" ON public.cars FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: cash_transactions Company users can view cash_transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view cash_transactions" ON public.cash_transactions FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: company_settings Company users can view company_settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view company_settings" ON public.company_settings FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: document_blocks Company users can view document_blocks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view document_blocks" ON public.document_blocks FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.documents d
  WHERE ((d.id = document_blocks.document_id) AND ((d.company_id = public.get_user_company_id()) OR public.is_user_super_admin())))));


--
-- Name: document_templates Company users can view document_templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view document_templates" ON public.document_templates FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: document_variables Company users can view document_variables; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view document_variables" ON public.document_variables FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.documents d
  WHERE ((d.id = document_variables.document_id) AND ((d.company_id = public.get_user_company_id()) OR public.is_user_super_admin())))));


--
-- Name: documents Company users can view documents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view documents" ON public.documents FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: driver_notes Company users can view driver_notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view driver_notes" ON public.driver_notes FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: drivers Company users can view drivers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view drivers" ON public.drivers FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: fixed_costs Company users can view fixed_costs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view fixed_costs" ON public.fixed_costs FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: income Company users can view income; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view income" ON public.income FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: receipts Company users can view receipts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view receipts" ON public.receipts FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: salaries Company users can view salaries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view salaries" ON public.salaries FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: salary_payments Company users can view salary_payments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view salary_payments" ON public.salary_payments FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: werkstatt_checks Company users can view werkstatt_checks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company users can view werkstatt_checks" ON public.werkstatt_checks FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: companies Super admins can delete companies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Super admins can delete companies" ON public.companies FOR DELETE TO authenticated USING (public.is_user_super_admin());


--
-- Name: company_settings Super admins can delete company_settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Super admins can delete company_settings" ON public.company_settings FOR DELETE TO authenticated USING (public.is_user_super_admin());


--
-- Name: document_categories Super admins can delete document_categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Super admins can delete document_categories" ON public.document_categories FOR DELETE TO authenticated USING (public.is_user_super_admin());


--
-- Name: companies Super admins can insert companies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Super admins can insert companies" ON public.companies FOR INSERT TO authenticated WITH CHECK (public.is_user_super_admin());


--
-- Name: document_categories Super admins can insert document_categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Super admins can insert document_categories" ON public.document_categories FOR INSERT TO authenticated WITH CHECK (public.is_user_super_admin());


--
-- Name: document_categories Super admins can update document_categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Super admins can update document_categories" ON public.document_categories FOR UPDATE TO authenticated USING (public.is_user_super_admin()) WITH CHECK (public.is_user_super_admin());


--
-- Name: discount_codes SuperAdmins can delete discount codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "SuperAdmins can delete discount codes" ON public.discount_codes FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true)))));


--
-- Name: discount_codes SuperAdmins can insert discount codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "SuperAdmins can insert discount codes" ON public.discount_codes FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true)))));


--
-- Name: discount_codes SuperAdmins can manage discount codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "SuperAdmins can manage discount codes" ON public.discount_codes FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true)))));


--
-- Name: discount_codes SuperAdmins can update discount codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "SuperAdmins can update discount codes" ON public.discount_codes FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true)))));


--
-- Name: discount_code_redemptions SuperAdmins can view all redemptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "SuperAdmins can view all redemptions" ON public.discount_code_redemptions FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true)))));


--
-- Name: user_sessions Users can delete own sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own sessions" ON public.user_sessions FOR DELETE TO authenticated USING ((user_id = auth.uid()));


--
-- Name: user_profiles Users can insert own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own profile" ON public.user_profiles FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));


--
-- Name: user_sessions Users can insert own sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own sessions" ON public.user_sessions FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));


--
-- Name: user_profiles Users can update company profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update company profiles" ON public.user_profiles FOR UPDATE TO authenticated USING (((user_id = auth.uid()) OR (company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK (((user_id = auth.uid()) OR (company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: user_sessions Users can update own sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own sessions" ON public.user_sessions FOR UPDATE TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: user_profiles Users can view company profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view company profiles" ON public.user_profiles FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR (company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: user_sessions Users can view own sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own sessions" ON public.user_sessions FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: role_permissions Users can view role_permissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view role_permissions" ON public.role_permissions FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.roles r
  WHERE ((r.id = role_permissions.role_id) AND ((r.company_id IS NULL) OR (r.company_id = public.get_user_company_id()) OR public.is_user_super_admin())))));


--
-- Name: roles Users can view roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view roles" ON public.roles FOR SELECT TO authenticated USING (((company_id IS NULL) OR (company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: companies Users can view their company; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their company" ON public.companies FOR SELECT TO authenticated USING (((id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: activation_code_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activation_code_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: activation_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activation_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: activation_code_attempts any_insert_attempts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY any_insert_attempts ON public.activation_code_attempts FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: subscription_plans authenticated_read_plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read_plans ON public.subscription_plans FOR SELECT TO authenticated USING (true);


--
-- Name: car_driver_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.car_driver_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: cars; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cars ENABLE ROW LEVEL SECURITY;

--
-- Name: cash_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cash_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: companies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

--
-- Name: planning_finalizations company_delete_finalizations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY company_delete_finalizations ON public.planning_finalizations FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: planning_finalizations company_insert_finalizations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY company_insert_finalizations ON public.planning_finalizations FOR INSERT TO authenticated WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: company_planning_run_blocks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_planning_run_blocks ENABLE ROW LEVEL SECURITY;

--
-- Name: company_planning_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_planning_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: planning_finalizations company_select_finalizations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY company_select_finalizations ON public.planning_finalizations FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: company_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: company_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: planning_finalizations company_update_finalizations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY company_update_finalizations ON public.planning_finalizations FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK ((company_id = public.get_user_company_id()));


--
-- Name: planning_run_adjustments delete_own_adjustments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own_adjustments ON public.planning_run_adjustments FOR DELETE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: monthly_planning_manual_exceptions delete_own_company_exceptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own_company_exceptions ON public.monthly_planning_manual_exceptions FOR DELETE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: historical_payroll_targets delete_own_hist_payroll; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own_hist_payroll ON public.historical_payroll_targets FOR DELETE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: company_planning_run_blocks delete_own_planning_blocks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own_planning_blocks ON public.company_planning_run_blocks FOR DELETE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: company_planning_runs delete_own_planning_runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own_planning_runs ON public.company_planning_runs FOR DELETE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: historical_reconciliation_drivers delete_own_recon_drivers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own_recon_drivers ON public.historical_reconciliation_drivers FOR DELETE TO authenticated USING ((reconciliation_id IN ( SELECT hr.id
   FROM (public.historical_reconciliations hr
     JOIN public.user_profiles up ON ((up.company_id = hr.company_id)))
  WHERE (up.user_id = auth.uid()))));


--
-- Name: historical_reconciliation_results delete_own_recon_results; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own_recon_results ON public.historical_reconciliation_results FOR DELETE TO authenticated USING ((reconciliation_id IN ( SELECT hr.id
   FROM (public.historical_reconciliations hr
     JOIN public.user_profiles up ON ((up.company_id = hr.company_id)))
  WHERE (up.user_id = auth.uid()))));


--
-- Name: historical_reconciliations delete_own_reconciliations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own_reconciliations ON public.historical_reconciliations FOR DELETE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: historical_reconciliation_wh_drivers delete_own_wh_drivers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own_wh_drivers ON public.historical_reconciliation_wh_drivers FOR DELETE TO authenticated USING ((reconciliation_id IN ( SELECT historical_reconciliations.id
   FROM public.historical_reconciliations
  WHERE (historical_reconciliations.company_id = public.get_user_company_id()))));


--
-- Name: historical_wh_saved_plans delete_own_wh_saved_plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own_wh_saved_plans ON public.historical_wh_saved_plans FOR DELETE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: discount_code_redemptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discount_code_redemptions ENABLE ROW LEVEL SECURITY;

--
-- Name: discount_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discount_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: document_blocks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.document_blocks ENABLE ROW LEVEL SECURITY;

--
-- Name: document_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.document_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: document_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.document_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: document_variables; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.document_variables ENABLE ROW LEVEL SECURITY;

--
-- Name: documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: drivers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.drivers ENABLE ROW LEVEL SECURITY;

--
-- Name: fahrtenbuch_assignment_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fahrtenbuch_assignment_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: fahrtenbuch_assignment_audit fahrtenbuch_audit_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fahrtenbuch_audit_insert ON public.fahrtenbuch_assignment_audit FOR INSERT TO authenticated WITH CHECK (((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))) AND (changed_by = auth.uid())));


--
-- Name: fahrtenbuch_assignment_audit fahrtenbuch_audit_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fahrtenbuch_audit_select ON public.fahrtenbuch_assignment_audit FOR SELECT TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: fahrtenbuch_imports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fahrtenbuch_imports ENABLE ROW LEVEL SECURITY;

--
-- Name: fahrtenbuch_imports fahrtenbuch_imports_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fahrtenbuch_imports_delete ON public.fahrtenbuch_imports FOR DELETE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.role = 'admin'::text)))));


--
-- Name: fahrtenbuch_imports fahrtenbuch_imports_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fahrtenbuch_imports_insert ON public.fahrtenbuch_imports FOR INSERT TO authenticated WITH CHECK (((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))) AND (imported_by = auth.uid())));


--
-- Name: fahrtenbuch_imports fahrtenbuch_imports_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fahrtenbuch_imports_select ON public.fahrtenbuch_imports FOR SELECT TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: fahrtenbuch_imports fahrtenbuch_imports_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fahrtenbuch_imports_update ON public.fahrtenbuch_imports FOR UPDATE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid())))) WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: fahrtenbuch_trips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fahrtenbuch_trips ENABLE ROW LEVEL SECURITY;

--
-- Name: fahrtenbuch_trips fahrtenbuch_trips_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fahrtenbuch_trips_delete ON public.fahrtenbuch_trips FOR DELETE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.role = 'admin'::text)))));


--
-- Name: fahrtenbuch_trips fahrtenbuch_trips_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fahrtenbuch_trips_insert ON public.fahrtenbuch_trips FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: fahrtenbuch_trips fahrtenbuch_trips_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fahrtenbuch_trips_select ON public.fahrtenbuch_trips FOR SELECT TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: fahrtenbuch_trips fahrtenbuch_trips_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fahrtenbuch_trips_update ON public.fahrtenbuch_trips FOR UPDATE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid())))) WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: fixed_costs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fixed_costs ENABLE ROW LEVEL SECURITY;

--
-- Name: historical_block_adjustments hba_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hba_delete_own ON public.historical_block_adjustments FOR DELETE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: historical_block_adjustments hba_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hba_insert_own ON public.historical_block_adjustments FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: historical_block_adjustments hba_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hba_select_own ON public.historical_block_adjustments FOR SELECT TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: historical_block_adjustments hba_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hba_update_own ON public.historical_block_adjustments FOR UPDATE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid())))) WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: historical_driver_hour_targets hdht_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hdht_delete ON public.historical_driver_hour_targets FOR DELETE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: historical_driver_hour_targets hdht_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hdht_insert ON public.historical_driver_hour_targets FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: historical_driver_hour_targets hdht_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hdht_select ON public.historical_driver_hour_targets FOR SELECT TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: historical_driver_hour_targets hdht_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hdht_update ON public.historical_driver_hour_targets FOR UPDATE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL))))) WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: historical_block_adjustments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.historical_block_adjustments ENABLE ROW LEVEL SECURITY;

--
-- Name: historical_driver_hour_targets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.historical_driver_hour_targets ENABLE ROW LEVEL SECURITY;

--
-- Name: historical_payroll_targets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.historical_payroll_targets ENABLE ROW LEVEL SECURITY;

--
-- Name: historical_reconciliation_drivers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.historical_reconciliation_drivers ENABLE ROW LEVEL SECURITY;

--
-- Name: historical_reconciliation_results; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.historical_reconciliation_results ENABLE ROW LEVEL SECURITY;

--
-- Name: historical_reconciliation_wh_drivers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.historical_reconciliation_wh_drivers ENABLE ROW LEVEL SECURITY;

--
-- Name: historical_reconciliations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.historical_reconciliations ENABLE ROW LEVEL SECURITY;

--
-- Name: historical_time_adjustments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.historical_time_adjustments ENABLE ROW LEVEL SECURITY;

--
-- Name: historical_wh_saved_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.historical_wh_saved_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: historical_time_adjustments hta_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hta_delete ON public.historical_time_adjustments FOR DELETE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: historical_time_adjustments hta_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hta_insert ON public.historical_time_adjustments FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: historical_time_adjustments hta_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hta_select ON public.historical_time_adjustments FOR SELECT TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: historical_time_adjustments hta_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hta_update ON public.historical_time_adjustments FOR UPDATE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL))))) WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: income; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.income ENABLE ROW LEVEL SECURITY;

--
-- Name: planning_run_adjustments insert_own_adjustments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY insert_own_adjustments ON public.planning_run_adjustments FOR INSERT TO authenticated WITH CHECK (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: monthly_planning_manual_exceptions insert_own_company_exceptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY insert_own_company_exceptions ON public.monthly_planning_manual_exceptions FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: historical_payroll_targets insert_own_hist_payroll; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY insert_own_hist_payroll ON public.historical_payroll_targets FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: company_planning_run_blocks insert_own_planning_blocks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY insert_own_planning_blocks ON public.company_planning_run_blocks FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: company_planning_runs insert_own_planning_runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY insert_own_planning_runs ON public.company_planning_runs FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: historical_reconciliation_drivers insert_own_recon_drivers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY insert_own_recon_drivers ON public.historical_reconciliation_drivers FOR INSERT TO authenticated WITH CHECK ((reconciliation_id IN ( SELECT hr.id
   FROM (public.historical_reconciliations hr
     JOIN public.user_profiles up ON ((up.company_id = hr.company_id)))
  WHERE (up.user_id = auth.uid()))));


--
-- Name: historical_reconciliation_results insert_own_recon_results; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY insert_own_recon_results ON public.historical_reconciliation_results FOR INSERT TO authenticated WITH CHECK ((reconciliation_id IN ( SELECT hr.id
   FROM (public.historical_reconciliations hr
     JOIN public.user_profiles up ON ((up.company_id = hr.company_id)))
  WHERE (up.user_id = auth.uid()))));


--
-- Name: historical_reconciliations insert_own_reconciliations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY insert_own_reconciliations ON public.historical_reconciliations FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: historical_reconciliation_wh_drivers insert_own_wh_drivers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY insert_own_wh_drivers ON public.historical_reconciliation_wh_drivers FOR INSERT TO authenticated WITH CHECK ((reconciliation_id IN ( SELECT historical_reconciliations.id
   FROM public.historical_reconciliations
  WHERE (historical_reconciliations.company_id = public.get_user_company_id()))));


--
-- Name: historical_wh_saved_plans insert_own_wh_saved_plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY insert_own_wh_saved_plans ON public.historical_wh_saved_plans FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: monthly_planning_manual_exceptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.monthly_planning_manual_exceptions ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: planning_finalizations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.planning_finalizations ENABLE ROW LEVEL SECURITY;

--
-- Name: planning_run_adjustments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.planning_run_adjustments ENABLE ROW LEVEL SECURITY;

--
-- Name: receipts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: referrals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

--
-- Name: role_permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: activation_codes sa_delete_activation_codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sa_delete_activation_codes ON public.activation_codes FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true)))));


--
-- Name: activation_codes sa_insert_activation_codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sa_insert_activation_codes ON public.activation_codes FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true)))));


--
-- Name: activation_codes sa_select_activation_codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sa_select_activation_codes ON public.activation_codes FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true)))));


--
-- Name: activation_code_attempts sa_select_attempts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sa_select_attempts ON public.activation_code_attempts FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true)))));


--
-- Name: activation_codes sa_update_activation_codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sa_update_activation_codes ON public.activation_codes FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true)))));


--
-- Name: salaries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.salaries ENABLE ROW LEVEL SECURITY;

--
-- Name: salary_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.salary_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: saved_stundennachweise saved_stunden_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY saved_stunden_delete ON public.saved_stundennachweise FOR DELETE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.role = 'admin'::text)))));


--
-- Name: saved_stundennachweise saved_stunden_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY saved_stunden_insert ON public.saved_stundennachweise FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: saved_stundennachweise saved_stunden_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY saved_stunden_select ON public.saved_stundennachweise FOR SELECT TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: saved_stundennachweise saved_stunden_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY saved_stunden_update ON public.saved_stundennachweise FOR UPDATE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid())))) WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: saved_stundennachweise; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.saved_stundennachweise ENABLE ROW LEVEL SECURITY;

--
-- Name: planning_run_adjustments select_own_adjustments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY select_own_adjustments ON public.planning_run_adjustments FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: monthly_planning_manual_exceptions select_own_company_exceptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY select_own_company_exceptions ON public.monthly_planning_manual_exceptions FOR SELECT TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: historical_payroll_targets select_own_hist_payroll; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY select_own_hist_payroll ON public.historical_payroll_targets FOR SELECT TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: company_planning_run_blocks select_own_planning_blocks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY select_own_planning_blocks ON public.company_planning_run_blocks FOR SELECT TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: company_planning_runs select_own_planning_runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY select_own_planning_runs ON public.company_planning_runs FOR SELECT TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: historical_reconciliation_drivers select_own_recon_drivers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY select_own_recon_drivers ON public.historical_reconciliation_drivers FOR SELECT TO authenticated USING ((reconciliation_id IN ( SELECT hr.id
   FROM (public.historical_reconciliations hr
     JOIN public.user_profiles up ON ((up.company_id = hr.company_id)))
  WHERE (up.user_id = auth.uid()))));


--
-- Name: historical_reconciliation_results select_own_recon_results; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY select_own_recon_results ON public.historical_reconciliation_results FOR SELECT TO authenticated USING ((reconciliation_id IN ( SELECT hr.id
   FROM (public.historical_reconciliations hr
     JOIN public.user_profiles up ON ((up.company_id = hr.company_id)))
  WHERE (up.user_id = auth.uid()))));


--
-- Name: historical_reconciliations select_own_reconciliations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY select_own_reconciliations ON public.historical_reconciliations FOR SELECT TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: historical_reconciliation_wh_drivers select_own_wh_drivers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY select_own_wh_drivers ON public.historical_reconciliation_wh_drivers FOR SELECT TO authenticated USING ((reconciliation_id IN ( SELECT historical_reconciliations.id
   FROM public.historical_reconciliations
  WHERE (historical_reconciliations.company_id = public.get_user_company_id()))));


--
-- Name: historical_wh_saved_plans select_own_wh_saved_plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY select_own_wh_saved_plans ON public.historical_wh_saved_plans FOR SELECT TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: subscription_admin_actions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscription_admin_actions ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscription_invoices ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_payment_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscription_payment_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_admin_actions super_admin_all_subscription_admin_actions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY super_admin_all_subscription_admin_actions ON public.subscription_admin_actions TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true)))));


--
-- Name: referrals super_admin_delete_referrals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY super_admin_delete_referrals ON public.referrals FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true)))));


--
-- Name: referrals super_admin_insert_referrals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY super_admin_insert_referrals ON public.referrals FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true)))));


--
-- Name: referrals super_admin_select_referrals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY super_admin_select_referrals ON public.referrals FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true)))));


--
-- Name: referrals super_admin_update_referrals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY super_admin_update_referrals ON public.referrals FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.is_super_admin = true)))));


--
-- Name: subscription_invoices superadmin_delete_invoices; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY superadmin_delete_invoices ON public.subscription_invoices FOR DELETE TO authenticated USING (public.is_user_super_admin());


--
-- Name: subscription_plans superadmin_delete_plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY superadmin_delete_plans ON public.subscription_plans FOR DELETE TO authenticated USING (public.is_user_super_admin());


--
-- Name: company_subscriptions superadmin_delete_subscription; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY superadmin_delete_subscription ON public.company_subscriptions FOR DELETE TO authenticated USING (public.is_user_super_admin());


--
-- Name: subscription_payment_audit superadmin_insert_audit; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY superadmin_insert_audit ON public.subscription_payment_audit FOR INSERT TO authenticated WITH CHECK (public.is_user_super_admin());


--
-- Name: subscription_invoices superadmin_insert_invoices; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY superadmin_insert_invoices ON public.subscription_invoices FOR INSERT TO authenticated WITH CHECK (public.is_user_super_admin());


--
-- Name: subscription_plans superadmin_insert_plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY superadmin_insert_plans ON public.subscription_plans FOR INSERT TO authenticated WITH CHECK (public.is_user_super_admin());


--
-- Name: company_subscriptions superadmin_insert_subscription; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY superadmin_insert_subscription ON public.company_subscriptions FOR INSERT TO authenticated WITH CHECK (public.is_user_super_admin());


--
-- Name: subscription_invoices superadmin_update_invoices; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY superadmin_update_invoices ON public.subscription_invoices FOR UPDATE TO authenticated USING (public.is_user_super_admin()) WITH CHECK (public.is_user_super_admin());


--
-- Name: subscription_plans superadmin_update_plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY superadmin_update_plans ON public.subscription_plans FOR UPDATE TO authenticated USING (public.is_user_super_admin()) WITH CHECK (public.is_user_super_admin());


--
-- Name: company_subscriptions superadmin_update_subscription; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY superadmin_update_subscription ON public.company_subscriptions FOR UPDATE TO authenticated USING (public.is_user_super_admin()) WITH CHECK (public.is_user_super_admin());


--
-- Name: planning_run_adjustments update_own_adjustments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own_adjustments ON public.planning_run_adjustments FOR UPDATE TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin())) WITH CHECK (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: monthly_planning_manual_exceptions update_own_company_exceptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own_company_exceptions ON public.monthly_planning_manual_exceptions FOR UPDATE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid())))) WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: historical_payroll_targets update_own_hist_payroll; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own_hist_payroll ON public.historical_payroll_targets FOR UPDATE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid())))) WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: company_planning_run_blocks update_own_planning_blocks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own_planning_blocks ON public.company_planning_run_blocks FOR UPDATE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid())))) WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: company_planning_runs update_own_planning_runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own_planning_runs ON public.company_planning_runs FOR UPDATE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid())))) WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE (user_profiles.user_id = auth.uid()))));


--
-- Name: historical_reconciliation_drivers update_own_recon_drivers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own_recon_drivers ON public.historical_reconciliation_drivers FOR UPDATE TO authenticated USING ((reconciliation_id IN ( SELECT hr.id
   FROM (public.historical_reconciliations hr
     JOIN public.user_profiles up ON ((up.company_id = hr.company_id)))
  WHERE (up.user_id = auth.uid())))) WITH CHECK ((reconciliation_id IN ( SELECT hr.id
   FROM (public.historical_reconciliations hr
     JOIN public.user_profiles up ON ((up.company_id = hr.company_id)))
  WHERE (up.user_id = auth.uid()))));


--
-- Name: historical_reconciliation_results update_own_recon_results; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own_recon_results ON public.historical_reconciliation_results FOR UPDATE TO authenticated USING ((reconciliation_id IN ( SELECT hr.id
   FROM (public.historical_reconciliations hr
     JOIN public.user_profiles up ON ((up.company_id = hr.company_id)))
  WHERE (up.user_id = auth.uid())))) WITH CHECK ((reconciliation_id IN ( SELECT hr.id
   FROM (public.historical_reconciliations hr
     JOIN public.user_profiles up ON ((up.company_id = hr.company_id)))
  WHERE (up.user_id = auth.uid()))));


--
-- Name: historical_reconciliations update_own_reconciliations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own_reconciliations ON public.historical_reconciliations FOR UPDATE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL))))) WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: historical_reconciliation_wh_drivers update_own_wh_drivers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own_wh_drivers ON public.historical_reconciliation_wh_drivers FOR UPDATE TO authenticated USING ((reconciliation_id IN ( SELECT historical_reconciliations.id
   FROM public.historical_reconciliations
  WHERE (historical_reconciliations.company_id = public.get_user_company_id())))) WITH CHECK ((reconciliation_id IN ( SELECT historical_reconciliations.id
   FROM public.historical_reconciliations
  WHERE (historical_reconciliations.company_id = public.get_user_company_id()))));


--
-- Name: historical_wh_saved_plans update_own_wh_saved_plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own_wh_saved_plans ON public.historical_wh_saved_plans FOR UPDATE TO authenticated USING ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL))))) WITH CHECK ((company_id IN ( SELECT user_profiles.company_id
   FROM public.user_profiles
  WHERE ((user_profiles.user_id = auth.uid()) AND (user_profiles.company_id IS NOT NULL)))));


--
-- Name: user_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: user_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_payment_audit users_read_own_audit; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_read_own_audit ON public.subscription_payment_audit FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: subscription_invoices users_read_own_invoices; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_read_own_invoices ON public.subscription_invoices FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: company_subscriptions users_read_own_subscription; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_read_own_subscription ON public.company_subscriptions FOR SELECT TO authenticated USING (((company_id = public.get_user_company_id()) OR public.is_user_super_admin()));


--
-- Name: werkstatt_checks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.werkstatt_checks ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict cnziZ4Bj4I41BpHJJwDe5FjyXnu7yPHrr9AaRugsFkbMW8iJ6jJ25AWdYh5boGq

