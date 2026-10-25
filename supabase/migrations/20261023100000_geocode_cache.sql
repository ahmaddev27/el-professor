/*
  # The address cache of the Fahrtenanalyse's locator (address locator, 22.10.2026)

  ## What this is for

  The Fahrtenanalyse checks whether a driver could get from one ride's drop-off to
  the next ride's pickup, and the Uber sheet gives addresses where the routing
  container needs points. The locator (src/lib/addressLocator.ts) turns an address
  into a point by asking the geocode-address function, which asks the Nominatim
  that ridy runs on this host through a gateway of ours. That service is another
  product's, has no limits of its own, and writes every request it receives into
  its log. So each address is asked of it ONCE, ever, per company, and kept here:

      public.geocode_cache   one row per company and address: the point, the
                             OpenStreetMap object it came from, and the data
                             version of the service that placed it

  A month's 3,000 distinct addresses are a one-off; the steady state is the handful
  that are new. Only an address that was placed AT HOUSE LEVEL leaves a row (the
  function never answers a point for a street, a square or a postal area), and an
  address that could not be placed leaves none: the reason is cheap to learn again
  and a data update can turn it into a point.

  ## Why per company, and why the plain address text is the key

  A company's addresses are its customers' addresses. A cache shared by all
  companies would answer "has anybody ever driven to this address?" to any member of
  any company, so it is a company table: the ordinary tenant shape, nothing global.

  The key is the address text, normalized (lower case, tidy spaces, no country at
  the end), and not a hash of it. The Fahrtenbuch already holds the text verbatim in
  fahrtenbuch_trips.raw_data_json, so a hash would add client-side cryptography and
  remove nothing: a hash of an address is as good as the address to anyone who can
  list the addresses of a city. The table holds no name, no phone number, no trip id
  and no driver.

  ## The shape, and who writes

  One shape, the business shape of 20260917130000: SELECT is the tenant term (or the
  read seam), and every write is the same predicate as USING and as WITH CHECK plus
  `is_company_admin()`, exactly like the other two Fahrtenanalyse tables
  (trip_analysis_settings and driver_month_budget, 20260922110000). Both context
  triggers, derived from the policies and not from who writes today: a view context
  writes nothing, and a support session's rows are recorded.

  ## A platform account does not write it, and that is the browser's rule on purpose

  A support session's writes are recorded row by row in the platform audit log WITH
  their values, retained for 36 months. For this table the values are a passenger's
  address and its coordinates, which have no business in that log, and
  support_write_redaction_pattern() is a name rule that matches none of this
  table's columns. Restating it is a data-protection decision of its own, so this
  migration does not. Instead the browser never tries: locatorPlan.ts sets
  canWrite only for an administrator of the account's OWN company, and a platform
  account inside a company's context therefore reads the cache and never writes it
  (a support session that wrote a row by hand would leave the address in the log).
  Do not "simplify" that rule away without widening the redaction first.

  ## Retention

  Nothing purges the table. The rows go with their company (ON DELETE CASCADE), an
  administrator can delete any of them, and a retention period (the Fahrtenbuch
  itself is kept as long as the company keeps it) is the owner's decision, not made
  here.

  ## Compatibility — this does NOT bump deploy/SCHEMA_EPOCH

  A new table. Nothing existing changes, so the previous release runs unchanged
  beside it and simply never reads it.

  tests/rls/geocode-cache.sql is this file's kit; tests/rls/matrix.sql carries the
  table's lines.
*/

-- ─── 1. The table ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.geocode_cache (
  id               uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid             NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Normalized text of the address (addressKey() in geocode-core.ts), at most 300.
  address_key      text             NOT NULL CHECK (char_length(address_key) BETWEEN 1 AND 300),
  -- Germany with a margin: a point outside it is not an answer to the question
  -- this table exists for (the search is restricted to Germany).
  lat              double precision NOT NULL CHECK (lat BETWEEN 47 AND 56),
  lon              double precision NOT NULL CHECK (lon BETWEEN 5 AND 16),
  -- "node/123": the object the point belongs to, when the service said.
  osm_ref          text             NULL CHECK (osm_ref IS NULL OR char_length(osm_ref) <= 40),
  -- "nominatim@2026-08-21": the service and the day its data was last updated.
  geocoder_version text             NOT NULL CHECK (char_length(geocoder_version) BETWEEN 1 AND 60),
  geocoded_at      timestamptz      NOT NULL DEFAULT now(),
  CONSTRAINT geocode_cache_one_row_per_address UNIQUE (company_id, address_key)
);

COMMENT ON TABLE public.geocode_cache IS
  'The points the Fahrtenanalyse has placed for a company''s addresses, at house '
  'level only, so that each address is asked of the geocoder once. A company table '
  'holding passengers'' addresses; written by the company''s administrator, never by '
  'a platform account (20261023100000).';

-- ─── 2. The tenant shape ────────────────────────────────────────────────────

ALTER TABLE public.geocode_cache ENABLE ROW LEVEL SECURITY;

DO $mig$
DECLARE
  p        record;
  v_tbl    constant text := 'geocode_cache';
  v_tenant constant text := 'company_id = (SELECT public.get_active_company_id())';
  v_reads  constant text := '(SELECT public.platform_reads_company_data())';
  v_writes constant text := '(SELECT public.platform_writes_company_data())';
  v_admin  constant text := '(SELECT public.is_company_admin())';
  v_where  text;
BEGIN
  v_where := v_tenant || ' AND ' || v_admin;

  FOR p IN
    SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, v_tbl);
  END LOOP;

  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s OR %s)',
    v_tbl || '_select', v_tbl, v_tenant, v_reads);
  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK ((%s) OR %s)',
    v_tbl || '_insert', v_tbl, v_where, v_writes);
  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated '
    'USING ((%s) OR %s) WITH CHECK ((%s) OR %s)',
    v_tbl || '_update', v_tbl, v_where, v_writes, v_where, v_writes);
  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING ((%s) OR %s)',
    v_tbl || '_delete', v_tbl, v_where, v_writes);

  -- 3.4a: a view context writes nothing. 3.4c: a support session's rows are
  -- recorded. The same two triggers, with the same names and shapes, as the
  -- tables those migrations derived them onto.
  EXECUTE format('DROP TRIGGER IF EXISTS refuse_read_only_context_write ON public.%I', v_tbl);
  EXECUTE format(
    'CREATE TRIGGER refuse_read_only_context_write '
    'BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
    'FOR EACH STATEMENT EXECUTE FUNCTION app_private.refuse_read_only_context_write()', v_tbl);

  EXECUTE format('DROP TRIGGER IF EXISTS record_support_write ON public.%I', v_tbl);
  EXECUTE format(
    'CREATE TRIGGER record_support_write '
    'AFTER INSERT OR UPDATE OR DELETE ON public.%I '
    'FOR EACH ROW '
    'WHEN (current_setting(%L, true) <> %L) '
    'EXECUTE FUNCTION app_private.record_support_write()',
    v_tbl, 'app_private.support_write_context', '');
END $mig$;

-- ─── 3. Privileges ──────────────────────────────────────────────────────────

-- Supabase's default privileges grant every new public table to anon,
-- authenticated and service_role. anon never reads this; the service role has no
-- caller that would (no edge function reads or writes the cache: the browser does,
-- as the company's own session).
REVOKE ALL ON TABLE public.geocode_cache FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.geocode_cache TO authenticated;

-- ─── 4. Self-check ──────────────────────────────────────────────────────────
--
-- The structure only, from the catalogue. What the policies and the triggers DO,
-- for every kind of caller, is tests/rls/geocode-cache.sql and tests/rls/matrix.sql.

DO $mig$
DECLARE
  v_policies text[];
  v_role     text;
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.geocode_cache'::regclass) THEN
    RAISE EXCEPTION 'geocode_cache self-check: row level security is off';
  END IF;

  SELECT array_agg(p.policyname::text ORDER BY p.policyname) INTO v_policies
    FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'geocode_cache';
  IF v_policies IS DISTINCT FROM ARRAY['geocode_cache_delete', 'geocode_cache_insert', 'geocode_cache_select', 'geocode_cache_update'] THEN
    RAISE EXCEPTION 'geocode_cache self-check: expected the four policies of the business shape, found %', v_policies;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = 'geocode_cache'
                AND p.roles <> ARRAY['authenticated']::name[]) THEN
    RAISE EXCEPTION 'geocode_cache self-check: a policy applies to a role other than authenticated';
  END IF;

  -- Both context triggers: the refusal per statement, the audit per row.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = 'public.geocode_cache'::regclass AND g.tgname = 'refuse_read_only_context_write'
                    AND NOT g.tgisinternal AND g.tgtype = 30 AND g.tgenabled = 'O') THEN
    RAISE EXCEPTION 'geocode_cache self-check: the view-context refusal trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = 'public.geocode_cache'::regclass AND g.tgname = 'record_support_write'
                    AND NOT g.tgisinternal AND g.tgtype = 29 AND g.tgenabled = 'O') THEN
    RAISE EXCEPTION 'geocode_cache self-check: the support-write audit trigger is missing';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_table_privilege(v_role, 'public.geocode_cache', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'geocode_cache self-check: % holds a privilege on the table', v_role;
    END IF;
  END LOOP;
  IF NOT (has_table_privilege('authenticated', 'public.geocode_cache', 'SELECT')
          AND has_table_privilege('authenticated', 'public.geocode_cache', 'INSERT')
          AND has_table_privilege('authenticated', 'public.geocode_cache', 'UPDATE')
          AND has_table_privilege('authenticated', 'public.geocode_cache', 'DELETE'))
     OR has_table_privilege('authenticated', 'public.geocode_cache', 'TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION 'geocode_cache self-check: authenticated must hold SELECT, INSERT, UPDATE and DELETE and nothing else';
  END IF;

  RAISE NOTICE 'geocode_cache self-check: passed';
END $mig$;
