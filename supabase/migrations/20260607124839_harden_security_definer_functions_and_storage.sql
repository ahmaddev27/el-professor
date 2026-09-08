-- =============================================================================
-- SECURITY HARDENING MIGRATION
-- Fixes cross-company data leaks in SECURITY DEFINER functions and storage
-- =============================================================================

-- ─── 1. Fix abrechnung functions: DEFINER → INVOKER ─────────────────────────
-- These functions query abrechnung_weekly view which joins receipts + income.
-- As DEFINER they bypass RLS, exposing ALL companies' financial data.
-- Changing to INVOKER makes them respect RLS on receipts/income tables.

CREATE OR REPLACE FUNCTION public.get_weekly_abrechnung(p_year integer, p_month integer)
RETURNS TABLE(year integer, month integer, week_number integer, driver_name text, anzahl_belege bigint, ausgegebene_bargeld numeric, bargeld numeric, bar_zuruck numeric)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
RETURN QUERY
SELECT
aw.year, aw.month, aw.week_number, aw.driver_name,
aw.anzahl_belege, aw.ausgegebene_bargeld, aw.bargeld, aw.bar_zuruck
FROM public.abrechnung_weekly aw
WHERE aw.year = p_year AND aw.month = p_month
ORDER BY aw.week_number DESC, aw.driver_name;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_monthly_abrechnung(p_year integer, p_month integer)
RETURNS TABLE(year integer, month integer, driver_name text, anzahl_belege bigint, ausgegebene_bargeld numeric, bargeld numeric, bar_zuruck numeric, week_count integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.get_driver_weekly_abrechnung(p_driver_name text, p_year integer, p_month integer)
RETURNS TABLE(year integer, month integer, week_number integer, driver_name text, anzahl_belege bigint, ausgegebene_bargeld numeric, bargeld numeric, bar_zuruck numeric)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.get_driver_monthly_abrechnung(p_driver_name text, p_year integer, p_month integer)
RETURNS TABLE(year integer, month integer, driver_name text, total_anzahl_belege bigint, total_ausgegebene_bargeld numeric, total_bargeld numeric, total_bar_zuruck numeric, week_count integer, weekly_breakdown jsonb)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $function$
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
$function$;


-- ─── 2. Fix get_current_cash_balance: scope to caller's company ─────────────
-- Was DEFINER querying ALL companies' transactions without company filter.

CREATE OR REPLACE FUNCTION public.get_current_cash_balance(user_email text DEFAULT NULL::text)
RETURNS numeric
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $function$
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
$function$;


-- ─── 3. Fix create_user_profile_manual: restrict to super admin ─────────────
-- Was callable by ANY authenticated user to create profiles for ANY user.

CREATE OR REPLACE FUNCTION public.create_user_profile_manual(p_user_id uuid, p_full_name text, p_role text DEFAULT 'viewer'::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
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
$function$;


-- ─── 4. Fix enforce_driver_limit: use drivers_per_car_limit ─────────────────

CREATE OR REPLACE FUNCTION public.enforce_driver_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
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
RAISE EXCEPTION 'Fahrerlimit erreicht. Ihr Abonnement erlaubt maximal % aktive Fahrer (% Fahrzeuge x %).', driver_limit, car_limit, dpc_limit
USING ERRCODE = 'P0001';
END IF;

RETURN NEW;
END;
$function$;


-- ─── 5. Add missing fahrtenbuch_trips UPDATE policy ─────────────────────────
-- Needed for plan apply operations that update mutable fields directly.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='public' AND tablename='fahrtenbuch_trips' AND cmd='UPDATE'
  ) THEN
    CREATE POLICY "fahrtenbuch_trips_update" ON fahrtenbuch_trips
      FOR UPDATE TO authenticated
      USING (company_id IN (
        SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
      ))
      WITH CHECK (company_id IN (
        SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
      ));
  END IF;
END $$;


-- ─── 6. Fix increment_discount_used_count: add basic validation ─────────────
-- Was callable by any user on any discount code without validation.

CREATE OR REPLACE FUNCTION public.increment_discount_used_count(code_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
IF auth.uid() IS NULL THEN
  RAISE EXCEPTION 'Access denied: unauthenticated';
END IF;

UPDATE discount_codes
SET used_count = used_count + 1
WHERE id = code_id;
END;
$function$;


-- ─── 7. Secure storage buckets ──────────────────────────────────────────────
-- Make 'documents' bucket private (was public with no policies).
-- Add company-scoped policies for documents bucket.

UPDATE storage.buckets SET public = false WHERE id = 'documents';
UPDATE storage.buckets SET public = false WHERE name = 'Y & A Mobility';

-- Add policies for 'documents' bucket: company-scoped via path prefix
DO $$ BEGIN
  -- SELECT
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='storage' AND policyname='Company users can read own documents'
  ) THEN
    CREATE POLICY "Company users can read own documents" ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'documents'
        AND (storage.foldername(name))[1] = (get_user_company_id())::text
      );
  END IF;

  -- INSERT
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='storage' AND policyname='Company users can upload documents'
  ) THEN
    CREATE POLICY "Company users can upload documents" ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'documents'
        AND (storage.foldername(name))[1] = (get_user_company_id())::text
      );
  END IF;

  -- UPDATE
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='storage' AND policyname='Company users can update own documents'
  ) THEN
    CREATE POLICY "Company users can update own documents" ON storage.objects
      FOR UPDATE TO authenticated
      USING (
        bucket_id = 'documents'
        AND (storage.foldername(name))[1] = (get_user_company_id())::text
      )
      WITH CHECK (
        bucket_id = 'documents'
        AND (storage.foldername(name))[1] = (get_user_company_id())::text
      );
  END IF;

  -- DELETE
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='storage' AND policyname='Company users can delete own documents'
  ) THEN
    CREATE POLICY "Company users can delete own documents" ON storage.objects
      FOR DELETE TO authenticated
      USING (
        bucket_id = 'documents'
        AND (storage.foldername(name))[1] = (get_user_company_id())::text
      );
  END IF;
END $$;


-- ─── 8. Revoke direct EXECUTE on sensitive functions from public/anon ────────
-- Ensure only authenticated users can call these functions.

REVOKE EXECUTE ON FUNCTION public.get_current_cash_balance FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_user_profile_manual FROM anon;
REVOKE EXECUTE ON FUNCTION public.list_users_for_admin FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_user_account FROM anon;
REVOKE EXECUTE ON FUNCTION public.reassign_fahrtenbuch_trip FROM anon;