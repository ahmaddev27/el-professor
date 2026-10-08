/*
  The Betriebssitz for the Rückkehrpflicht tab, stored with the other
  Fahrtenanalyse inputs a company decides.

  ## Why

  The tab places every ride's order at the Betriebssitz or away from it. Until
  now the base was typed into the tab and lived in the browser's memory, so it
  was asked for again on every visit, and a proposal computed from the data
  stood in for it. On staging that proposal is weak — 126 of 1,008 block starts
  of the largest company fall within one kilometre — so the base must be the
  operator's own entry, and an entry that is asked for every time is one that
  stops being made.

  ## What

  Three nullable columns on `public.trip_analysis_settings`, the table that
  already holds the analysis inputs:

    base_latitude, base_longitude   numeric(9,6), inside Germany's bounding box
                                    (47.2–55.1 N, 5.8–15.1 E), the same box the
                                    engine uses to refuse a position
                                    (src/utils/returnCheck/geo.ts); both or neither
    base_radius_km                  numeric(4,1), above 0 and at most 50

  NULL means "not set", as for the two minute columns beside them: the screen
  then proposes a base and says it is a proposal.

  ## What does not change

  No policy, no trigger, no grant. The table keeps 20260922110000's four
  policies (reads by the tenant, writes by a company administrator or a
  support session), its stamp trigger, and the context and support-write
  audit pair. The self-check below re-asserts each of those, so a later edit
  that loses one fails here rather than in production.

  ## Rollback

  Additive only. The previous release names its columns explicitly
  (`SETTINGS_COLUMNS` in src/lib/tripAnalysisClient.ts) and upserts only the
  two minute columns, so it reads and writes this table exactly as before.
  No schema epoch.
*/

ALTER TABLE public.trip_analysis_settings
  ADD COLUMN IF NOT EXISTS base_latitude  numeric(9,6) NULL,
  ADD COLUMN IF NOT EXISTS base_longitude numeric(9,6) NULL,
  ADD COLUMN IF NOT EXISTS base_radius_km numeric(4,1) NULL;

ALTER TABLE public.trip_analysis_settings
  DROP CONSTRAINT IF EXISTS trip_analysis_settings_base_in_germany,
  DROP CONSTRAINT IF EXISTS trip_analysis_settings_base_pair,
  DROP CONSTRAINT IF EXISTS trip_analysis_settings_base_radius;

ALTER TABLE public.trip_analysis_settings
  ADD CONSTRAINT trip_analysis_settings_base_in_germany CHECK (
    (base_latitude IS NULL OR base_latitude BETWEEN 47.2 AND 55.1)
    AND (base_longitude IS NULL OR base_longitude BETWEEN 5.8 AND 15.1)
  ),
  ADD CONSTRAINT trip_analysis_settings_base_pair CHECK ((base_latitude IS NULL) = (base_longitude IS NULL)),
  ADD CONSTRAINT trip_analysis_settings_base_radius CHECK (base_radius_km IS NULL OR (base_radius_km > 0 AND base_radius_km <= 50));

COMMENT ON COLUMN public.trip_analysis_settings.base_latitude IS
  'Betriebssitz, latitude. NULL: not set; the Rückkehrpflicht tab then proposes one and says so (20261008200000).';
COMMENT ON COLUMN public.trip_analysis_settings.base_longitude IS
  'Betriebssitz, longitude. Set together with base_latitude or not at all (20261008200000).';
COMMENT ON COLUMN public.trip_analysis_settings.base_radius_km IS
  'A position this close to the Betriebssitz, in a straight line, counts as at the base. NULL: the screen default (20261008200000).';

DO $check$
DECLARE
  v_n integer;
BEGIN
  -- 1. The three columns, with their types.
  SELECT count(*) INTO v_n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'trip_analysis_settings'
     AND ((column_name IN ('base_latitude', 'base_longitude') AND numeric_precision = 9 AND numeric_scale = 6)
       OR (column_name = 'base_radius_km' AND numeric_precision = 4 AND numeric_scale = 1))
     AND is_nullable = 'YES';
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'base location self-check 1: expected 3 nullable base columns, found %', v_n;
  END IF;

  -- 2. The three constraints.
  SELECT count(*) INTO v_n
    FROM pg_constraint
   WHERE conrelid = 'public.trip_analysis_settings'::regclass
     AND conname IN ('trip_analysis_settings_base_in_germany', 'trip_analysis_settings_base_pair', 'trip_analysis_settings_base_radius')
     AND contype = 'c';
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'base location self-check 2: expected 3 base constraints, found %', v_n;
  END IF;

  -- 3. Nothing about who may read or write moved: four policies, RLS on.
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'trip_analysis_settings';
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'base location self-check 3: trip_analysis_settings has % policies, expected 4', v_n;
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trip_analysis_settings'::regclass) THEN
    RAISE EXCEPTION 'base location self-check 3: row level security is off on trip_analysis_settings';
  END IF;

  -- 4. The stamp trigger and the context/audit pair are still in place.
  SELECT count(*) INTO v_n
    FROM pg_trigger
   WHERE tgrelid = 'public.trip_analysis_settings'::regclass AND NOT tgisinternal
     AND tgname IN ('trip_analysis_settings_stamp', 'refuse_read_only_context_write', 'record_support_write');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'base location self-check 4: expected the stamp, refusal and audit triggers, found %', v_n;
  END IF;

  -- 5. No client role gained a privilege the table did not grant before.
  IF has_table_privilege('anon', 'public.trip_analysis_settings', 'INSERT')
     OR has_table_privilege('anon', 'public.trip_analysis_settings', 'UPDATE') THEN
    RAISE EXCEPTION 'base location self-check 5: anon can write trip_analysis_settings';
  END IF;

  SELECT count(*) INTO v_n FROM public.trip_analysis_settings WHERE base_latitude IS NOT NULL;
  RAISE NOTICE 'base location: self-checks passed — % company setting(s) carry a base', v_n;
END
$check$;
