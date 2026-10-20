/*
  # Simulated rides carry their marker for good (owner, 20.10.2026)

  ## What this is for

  The company can generate a month of rides in the shape of an Uber export, for
  teaching, demos and testing the chain end to end: import, planning, Lohnart,
  the finalization checks, the Fahrtenbuch XLSX. The rides go in through the
  ordinary import. This migration is the part that keeps them recognisable.

  ## Decision: the marker is not friction, and nothing removes it

  The owner accepted the generator on one condition: **every simulated ride is
  marked as simulated, and the data says so wherever it surfaces.** A Fahrtenbuch
  is a statutory record; a generated ride that could pass for an imported one is
  a forged entry. So the marker is a column on both tables and the database, not
  the browser, keeps it true:

      fahrtenbuch_imports.is_simulated   set once, by the import insert
      fahrtenbuch_trips.is_simulated     never written by a client: the trigger
                                         copies the import's value on INSERT

  Three rules, each one a trigger, each pinned in tests/rls/simulated-rides.sql
  with a mutation control:

    1. A trip takes `is_simulated` from its import. Whatever the client sent is
       overwritten, in both directions: a simulated import cannot hold a ride
       that says it is real, and a real import cannot hold one that says it is
       simulated. (A rule enforced only in the function that happens to write
       the rows is lost by the next writer; this one is on the table.)
    2. `is_simulated` of an import never changes after insert. An UPDATE that
       tries is refused, not ignored.
    3. `is_simulated` of a trip never changes after insert either. This is a
       trigger of its own instead of a new line in
       protect_fahrtenbuch_immutable_fields: restating that 30-line function to
       add one comparison would risk dropping one of the others.

  There is no setting, argument or role that bypasses these. **Do not add one.**
  A migration that needs to change a marker is a decision for the owner.

  ## Decision: simulated rides explain recorded figures, and never share a
  ## driver-week with real trips

  The generator is derived from the books: for each driver and business week
  that has `income` rows it makes rides whose fares add up, to the cent, to the
  recorded umsatz, bargeld and trinkgeld. It writes no income row and invents no
  total, so no salary figure moves. What would move one is the same income being
  explained twice, by real trips and by simulated ones, so:

    3. `fahrtenbuch_trips_refuse_double_count` (BEFORE INSERT) refuses a
       simulated trip into a driver-week (company, driver name compared
       `lower(btrim(...))`, Monday-to-Sunday week of `trip_date`) that already
       holds a real trip, and a real trip into one that holds a simulated trip
       (P0001, HINT `simulated_double_count_refused`). The week is the business
       week the salary is computed over. Deleting the simulated import lifts it.

  This replaces a company-wide refusal that an earlier draft of this file
  carried. It was stricter than the hazard needs once totals are tied to the
  books, and it would have made the feature unusable in exactly the companies
  that have figures to explain. What it guarded and this does not: the hours.
  A Stundennachweis, the Lohnart premiums and the planning read the TIMES of a
  trip, and those are invented. The documents that print them do not carry the
  marker yet (src/utils/simulatedRides/readers.test.ts lists them), so
  generating into a company whose drivers are really paid by hours is not safe
  until they do. That is recorded, not solved here.

  ## What this does not do

  It cannot stop someone from typing invented rides into a spreadsheet and
  importing that as a real file; nothing at the database can tell. It makes the
  generator's own output impossible to launder, which is the part that is
  ours to guarantee.

  ## Access and privileges

  Two columns on tables whose policies, triggers and grants are unchanged. The
  new trigger functions are SECURITY INVOKER in `public` (authenticated holds
  no USAGE on app_private, and a trigger on a table the caller writes runs as
  the caller). The inherit function reads fahrtenbuch_imports under the
  caller's own policies: a caller who can insert a trip into an import can see
  that import.

  ## Compatibility — this does NOT bump deploy/SCHEMA_EPOCH

  Additive columns with a default, and triggers the previous release never
  trips over: it does not write the column, gets the default `false` on an
  import, and the trigger fills the trip's value from the import.
*/

ALTER TABLE public.fahrtenbuch_imports
  ADD COLUMN IF NOT EXISTS is_simulated boolean NOT NULL DEFAULT false;
ALTER TABLE public.fahrtenbuch_trips
  ADD COLUMN IF NOT EXISTS is_simulated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.fahrtenbuch_imports.is_simulated IS
  'True for an import made by the simulated-ride generator. Set at insert, never changed, '
  'never removed (20261020110000). Not friction: the owner''s condition for the generator.';
COMMENT ON COLUMN public.fahrtenbuch_trips.is_simulated IS
  'Copied from the trip''s import by trigger; a client value is overwritten. Never changed '
  'after insert (20261020110000).';

-- Partial index: the screens that must show or exclude simulated rides filter on it,
-- and nearly every row is false.
CREATE INDEX IF NOT EXISTS fahrtenbuch_trips_simulated_idx
  ON public.fahrtenbuch_trips (company_id, import_id) WHERE is_simulated;

CREATE OR REPLACE FUNCTION public.fahrtenbuch_trips_keep_simulated()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_simulated boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT i.is_simulated INTO v_simulated
      FROM public.fahrtenbuch_imports i
     WHERE i.id = NEW.import_id;
    -- No visible import: leave the column alone, the foreign key or the policy refuses the row.
    IF FOUND THEN
      NEW.is_simulated := v_simulated;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.is_simulated IS DISTINCT FROM OLD.is_simulated THEN
    RAISE EXCEPTION 'fahrtenbuch_trips: is_simulated cannot be changed after insert.'
      USING ERRCODE = 'P0001', HINT = 'simulated_marker_fixed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fahrtenbuch_imports_keep_simulated()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.is_simulated IS DISTINCT FROM OLD.is_simulated THEN
    RAISE EXCEPTION 'fahrtenbuch_imports: is_simulated cannot be changed after insert.'
      USING ERRCODE = 'P0001', HINT = 'simulated_marker_fixed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fahrtenbuch_trips_keep_simulated ON public.fahrtenbuch_trips;
CREATE TRIGGER fahrtenbuch_trips_keep_simulated
  BEFORE INSERT OR UPDATE ON public.fahrtenbuch_trips
  FOR EACH ROW EXECUTE FUNCTION public.fahrtenbuch_trips_keep_simulated();

DROP TRIGGER IF EXISTS fahrtenbuch_imports_keep_simulated ON public.fahrtenbuch_imports;
CREATE TRIGGER fahrtenbuch_imports_keep_simulated
  BEFORE UPDATE ON public.fahrtenbuch_imports
  FOR EACH ROW EXECUTE FUNCTION public.fahrtenbuch_imports_keep_simulated();

-- Trigger functions are never called by a client.
REVOKE ALL ON FUNCTION public.fahrtenbuch_trips_keep_simulated()   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fahrtenbuch_imports_keep_simulated() FROM PUBLIC, anon, authenticated, service_role;

CREATE INDEX IF NOT EXISTS fahrtenbuch_trips_driver_week_idx
  ON public.fahrtenbuch_trips (company_id, (lower(btrim(original_driver_name))), trip_date);

CREATE OR REPLACE FUNCTION public.fahrtenbuch_trips_refuse_double_count()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_simulated boolean;
  v_week      date;
BEGIN
  IF btrim(coalesce(NEW.original_driver_name, '')) = '' THEN
    RETURN NEW;
  END IF;
  -- Read the import's marker here rather than trusting the order two triggers fire in.
  SELECT i.is_simulated INTO v_simulated FROM public.fahrtenbuch_imports i WHERE i.id = NEW.import_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  v_week := date_trunc('week', NEW.trip_date::timestamp)::date;
  IF EXISTS (
    SELECT 1 FROM public.fahrtenbuch_trips t
     WHERE t.company_id = NEW.company_id
       AND lower(btrim(t.original_driver_name)) = lower(btrim(NEW.original_driver_name))
       AND t.trip_date >= v_week AND t.trip_date < v_week + 7
       AND t.is_simulated IS DISTINCT FROM v_simulated
  ) THEN
    RAISE EXCEPTION
      'Diese Fahrerwoche enthält bereits % Fahrten. Echte und simulierte Fahrten dürfen dieselbe Woche eines Fahrers nicht zweimal erklären.',
      CASE WHEN v_simulated THEN 'echte' ELSE 'simulierte' END
      USING ERRCODE = 'P0001', HINT = 'simulated_double_count_refused';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fahrtenbuch_trips_refuse_double_count ON public.fahrtenbuch_trips;
CREATE TRIGGER fahrtenbuch_trips_refuse_double_count
  BEFORE INSERT ON public.fahrtenbuch_trips
  FOR EACH ROW EXECUTE FUNCTION public.fahrtenbuch_trips_refuse_double_count();

REVOKE ALL ON FUNCTION public.fahrtenbuch_trips_refuse_double_count() FROM PUBLIC, anon, authenticated, service_role;

DO $selfcheck$
DECLARE
  v_col record;
  v_fn  text;
BEGIN
  FOR v_col IN
    SELECT c.relname, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS dflt, a.atttypid::regtype::text AS typ
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'is_simulated' AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE c.oid IN ('public.fahrtenbuch_imports'::regclass, 'public.fahrtenbuch_trips'::regclass)
  LOOP
    IF NOT v_col.attnotnull OR v_col.dflt IS DISTINCT FROM 'false' OR v_col.typ <> 'boolean' THEN
      RAISE EXCEPTION 'simulated rides self-check 1: %.is_simulated must be boolean NOT NULL DEFAULT false', v_col.relname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_attribute
       WHERE attname = 'is_simulated' AND NOT attisdropped
         AND attrelid IN ('public.fahrtenbuch_imports'::regclass, 'public.fahrtenbuch_trips'::regclass)) <> 2 THEN
    RAISE EXCEPTION 'simulated rides self-check 1: both tables must carry is_simulated';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY['fahrtenbuch_trips_keep_simulated', 'fahrtenbuch_imports_keep_simulated', 'fahrtenbuch_trips_refuse_double_count'] LOOP
    IF (SELECT p.prosecdef FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_fn) THEN
      RAISE EXCEPTION 'simulated rides self-check 2: % must stay SECURITY INVOKER', v_fn;
    END IF;
    IF has_function_privilege('anon', ('public.' || v_fn || '()')::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', ('public.' || v_fn || '()')::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'simulated rides self-check 2: % must not be executable by an API role', v_fn;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.fahrtenbuch_trips'::regclass
                  AND tgname = 'fahrtenbuch_trips_keep_simulated' AND NOT tgisinternal AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.fahrtenbuch_imports'::regclass
                  AND tgname = 'fahrtenbuch_imports_keep_simulated' AND NOT tgisinternal AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'simulated rides self-check 3: a marker trigger is missing or disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.fahrtenbuch_trips'::regclass
                  AND tgname = 'fahrtenbuch_trips_refuse_double_count' AND NOT tgisinternal AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'simulated rides self-check 4: the double-count refusal is missing or disabled';
  END IF;
END
$selfcheck$;
