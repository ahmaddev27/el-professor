-- ════════════════════════════════════════════════════════════════════════════
--  A new driver: German e-mail language and the next staff number by default
-- ════════════════════════════════════════════════════════════════════════════
--
--  Owner decision of 26.11.2026.
--
--  1. The language a driver's e-mails are written in defaults to German. On
--     19.10.2026 the owner chose English; he has reversed that. Existing rows
--     are NOT changed: a driver who was given English keeps it.
--
--  2. A new driver's staff number (drivers.personalnummer) is the last
--     driver's number + 1, in the same width ('00022' -> '00023').
--
--     "Last" is the highest all-digit number among the company's drivers,
--     with two exceptions that came from production's data:
--       * the company owner (employment_type = 'company_owner') is left out of
--         the maximum: he carries a number from another range, far above the
--         employees' 00001..00022, and counting him would jump every new
--         employee into that range;
--       * the number is skipped, never reused, when any driver at all (owner
--         and inactive ones included) holds it: '23' and '00023' are the same
--         number, and a payroll number is never given twice.
--     Inactive drivers COUNT toward the maximum: a departed driver's number
--     stays in the payroll history.
--
--  Where the number is given: a BEFORE INSERT trigger, so every way a driver
--  comes into being (the form, the fleet import, the earnings resolve, the
--  daily pull's placement) gets one without its body naming the column. That
--  matters: partner_drivers_import must not mention personnel numbers (owner
--  decision 15.10.2026: nothing about them crosses from the partner), and
--  src/utils/partnerFleetImportMigration.test.ts reads its body to hold it to
--  that. Only an ACTIVE, non-owner driver is numbered: partner_earners_resolve
--  creates INACTIVE drivers for people long gone, and those must not burn
--  payroll numbers. A number written by the caller is never touched, and an
--  UPDATE never renumbers anyone.
--
--  The helper takes a per-company advisory lock until the transaction ends, so
--  two drivers created at once cannot both read the same maximum.
--
--  SECURITY DEFINER on the trigger function and on the form's RPC, on purpose:
--  `authenticated` holds no USAGE on app_private, so an INVOKER function that
--  names it is refused with 42501 (PR #117, the Rollen screen).

ALTER TABLE public.drivers ALTER COLUMN preferred_language SET DEFAULT 'de';

COMMENT ON COLUMN public.drivers.preferred_language IS
  'The language this driver''s e-mails (the Abrechnung and its reminder) are written '
  'in: ar, en, de, tr or ru. Default de since 26.11.2026 (was en). Figures and dates '
  'stay German in every language.';

-- ─── the one definition of "the next staff number" ──────────────────────────

CREATE OR REPLACE FUNCTION app_private.next_driver_personalnummer(p_company uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_max   bigint;
  v_width integer;
  v_next  bigint;
BEGIN
  IF p_company IS NULL THEN
    RAISE EXCEPTION 'a company is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('drivers.personalnummer:' || p_company::text, 0));

  SELECT max(btrim(d.personalnummer)::bigint) INTO v_max
    FROM public.drivers d
   WHERE d.company_id = p_company
     AND d.employment_type IS DISTINCT FROM 'company_owner'
     AND btrim(d.personalnummer) ~ '^[0-9]{1,9}$';

  IF v_max IS NULL THEN
    v_next  := 1;
    v_width := 5;
  ELSE
    SELECT max(length(btrim(d.personalnummer))) INTO v_width
      FROM public.drivers d
     WHERE d.company_id = p_company
       AND d.employment_type IS DISTINCT FROM 'company_owner'
       AND btrim(d.personalnummer) ~ '^[0-9]{1,9}$'
       AND btrim(d.personalnummer)::bigint = v_max;
    v_next := v_max + 1;
  END IF;

  -- Any holder blocks the number, the owner and the inactive included.
  WHILE EXISTS (
    SELECT 1 FROM public.drivers d
     WHERE d.company_id = p_company
       AND btrim(d.personalnummer) ~ '^[0-9]{1,9}$'
       AND btrim(d.personalnummer)::bigint = v_next
  ) LOOP
    v_next := v_next + 1;
  END LOOP;

  -- lpad would cut a number longer than the width; never shorten a number.
  IF length(v_next::text) >= v_width THEN
    RETURN v_next::text;
  END IF;
  RETURN lpad(v_next::text, v_width, '0');
END;
$$;

COMMENT ON FUNCTION app_private.next_driver_personalnummer(uuid) IS
  'The next staff number of a company: the highest all-digit number of its non-owner drivers (inactive included) plus one, in that number''s width, skipping any number a driver of the company already holds. Takes a per-company advisory lock. 20261126100000.';

REVOKE ALL ON FUNCTION app_private.next_driver_personalnummer(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ─── the trigger ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.drivers_assign_personalnummer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.company_id IS NOT NULL
     AND (NEW.personalnummer IS NULL OR btrim(NEW.personalnummer) = '')
     AND NEW.status IS NOT DISTINCT FROM 'active'
     AND NEW.employment_type IS DISTINCT FROM 'company_owner' THEN
    NEW.personalnummer := app_private.next_driver_personalnummer(NEW.company_id);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.drivers_assign_personalnummer() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS drivers_assign_personalnummer ON public.drivers;
CREATE TRIGGER drivers_assign_personalnummer
  BEFORE INSERT ON public.drivers
  FOR EACH ROW EXECUTE FUNCTION app_private.drivers_assign_personalnummer();

-- ─── what the "new driver" form pre-fills ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.driver_next_personalnummer()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company uuid := public.get_active_company_id();
BEGIN
  IF v_company IS NULL OR NOT public.current_role_permits('drivers', true) THEN
    RETURN NULL;
  END IF;
  RETURN app_private.next_driver_personalnummer(v_company);
END;
$$;

COMMENT ON FUNCTION public.driver_next_personalnummer() IS
  'The staff number a new driver of the caller''s company would be given, for the form to pre-fill; NULL for a caller with no company or no right to edit drivers. The trigger decides the number actually stored. 20261126100000.';

REVOKE ALL ON FUNCTION public.driver_next_personalnummer() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_next_personalnummer() TO authenticated;

-- ─── self-check ──────────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_fn regprocedure;
BEGIN
  IF (SELECT pg_get_expr(a.adbin, a.adrelid) FROM pg_attrdef a
       WHERE a.adrelid = 'public.drivers'::regclass
         AND a.adnum = (SELECT attnum FROM pg_attribute
                         WHERE attrelid = 'public.drivers'::regclass AND attname = 'preferred_language'))
     NOT LIKE '''de''%' THEN
    RAISE EXCEPTION 'driver defaults self-check 1: the language default is not de';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.drivers'::regclass
                    AND t.tgname = 'drivers_assign_personalnummer' AND NOT t.tgisinternal
                    AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 1) = 1) THEN
    RAISE EXCEPTION 'driver defaults self-check 2: the BEFORE INSERT row trigger is missing';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'app_private.drivers_assign_personalnummer()'::regprocedure,
    'app_private.next_driver_personalnummer(uuid)'::regprocedure,
    'public.driver_next_personalnummer()'::regprocedure] LOOP
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn)
       OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn
                       AND p.proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
      RAISE EXCEPTION 'driver defaults self-check 3: % lost SECURITY DEFINER or its pinned search_path', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'driver defaults self-check 4: anon can execute %', v_fn;
    END IF;
  END LOOP;

  IF has_function_privilege('authenticated', 'app_private.next_driver_personalnummer(uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', 'app_private.next_driver_personalnummer(uuid)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.driver_next_personalnummer()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'driver defaults self-check 5: the grants are wrong';
  END IF;

  RAISE NOTICE 'driver defaults: self-checks passed';
END
$check$;
