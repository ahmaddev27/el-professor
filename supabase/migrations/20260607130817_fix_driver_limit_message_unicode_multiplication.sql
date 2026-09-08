/*
# Fix enforce_driver_limit error message formatting

## Changes
- Updates the error message in `enforce_driver_limit()` to use the Unicode multiplication
  sign (×) instead of lowercase 'x' for consistency with the frontend UI.
- Adds SET search_path for security best practice.

## Notes
- The function logic is unchanged — it already correctly uses `drivers_per_car_limit`
  from `company_settings` instead of the old hardcoded ×2.
*/

CREATE OR REPLACE FUNCTION public.enforce_driver_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
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
    RAISE EXCEPTION 'Fahrerlimit erreicht. Ihr Abonnement erlaubt maximal % aktive Fahrer (% Fahrzeuge × %).', driver_limit, car_limit, dpc_limit
    USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;
