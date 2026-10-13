-- ════════════════════════════════════════════════════════════════════════════
--  Uber earnings: an income import that cannot be run twice
--
--  Owner's decision, 13.10.2026: instead of typing each driver's weekly
--  earnings into the Umsaetze page, pull them from Reidey, preview them and
--  confirm. This migration is the database half: four columns that say where a
--  row came from, the index that refuses a second import of the same period,
--  and the one function that writes the rows.
--
--  ── Why the refusal is an index ─────────────────────────────────────────────
--
--  `income` has no unique key of any kind beyond its primary key and nothing
--  upserts into it, so importing a week twice writes exact duplicates that every
--  aggregate (the Abrechnung, the salary, the Overview) then counts twice. A
--  check in the browser would be one tab and one double click away from losing.
--  So the key is partial - it exists only for rows that name a source, and a
--  hand-entered row is untouched - and a second import fails with 23505 from the
--  database whatever the browser did.
--
--  The index alone does not see an OVERLAP: 06.10. to 12.10. and 08.10. to
--  12.10. are different keys and the same days. So the function also refuses a
--  period that overlaps one already imported for the driver, with the same
--  reason, and takes an advisory lock per company so two imports cannot both
--  pass that check. The index is what remains true if the function is ever
--  bypassed.
--
--  ── Who the driver is is decided here, never by the caller ─────────────────
--
--  `income` has no driver_id; every read joins `driver_name` against
--  `drivers.name` as text. The function therefore takes only Reidey's driver id
--  and resolves it through `partner_driver_links`, the link a person confirmed,
--  and writes OUR drivers row's name character for character. A name the
--  partner sent is a name nobody chose: this product has an incident on record
--  where a substring match attributed a month of salary to a driver no one had
--  picked. If any driver in the call has no confirmed link, the whole call is
--  refused and nothing is written.
--
--  ── Who may call it ─────────────────────────────────────────────────────────
--
--  A SECURITY DEFINER function runs past RLS, so it asks the gate itself:
--  `get_active_company_id()` for the company (a suspended company is refused
--  like everywhere else) and `current_role_permits('income', true)` for the
--  page the table's own write policies carry. A platform account inside a
--  support session is refused too: importing a customer's earnings from the
--  customer's own partner connection is the customer's act, not an agent's, the
--  same line the Gehaltsquittung RPCs draw.
--
--  Refusals are stable HINT codes and never the message text.
--
--  ── Money ───────────────────────────────────────────────────────────────────
--
--  Amounts arrive as plain decimal strings (a dot, at most two places) and are
--  cast once, here. The browser and the edge function refuse every other shape,
--  so this cast is not where a comma becomes a thousand; this function refuses
--  them again because it is the last wall.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. where a row came from ───────────────────────────────────────────────

ALTER TABLE public.income
  ADD COLUMN IF NOT EXISTS source              text NULL,
  ADD COLUMN IF NOT EXISTS source_period_start date NULL,
  ADD COLUMN IF NOT EXISTS source_period_end   date NULL,
  ADD COLUMN IF NOT EXISTS source_driver_key   text NULL;

ALTER TABLE public.income DROP CONSTRAINT IF EXISTS income_source_shape;
ALTER TABLE public.income
  ADD CONSTRAINT income_source_shape
  CHECK (
    (source IS NULL) = (source_driver_key IS NULL)
    AND (source IS NULL) = (source_period_start IS NULL)
    AND (source IS NULL) = (source_period_end IS NULL)
    AND (source IS NULL OR (source = lower(btrim(source)) AND source <> ''
                            AND btrim(source_driver_key) <> ''
                            AND source_period_start <= source_period_end))
  );

COMMENT ON COLUMN public.income.source IS
  'Where an imported row came from (uber), or NULL for a row a person entered.';
COMMENT ON COLUMN public.income.source_driver_key IS
  'The partner''s own id for the driver, as text. Part of the key that refuses '
  'a second import; the row''s driver_name is still OUR drivers row''s name.';
COMMENT ON COLUMN public.income.source_period_start IS
  'First day of the stretch an imported row covers. A stretch lies inside one '
  'business week (Monday to Sunday).';
COMMENT ON COLUMN public.income.source_period_end IS
  'Last day of the stretch an imported row covers.';

-- ─── 2. the index that refuses a second import ──────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS income_source_period_key
  ON public.income (company_id, source, source_driver_key, source_period_start, type)
  WHERE source IS NOT NULL;

COMMENT ON INDEX public.income_source_period_key IS
  'One imported row per company, source, partner driver, period start and type. '
  'A second import of the same period fails with 23505 from the database, not '
  'from a check in the browser. Partial: hand-entered rows are not constrained.';

-- ─── 3. the one function that writes the rows ───────────────────────────────

CREATE OR REPLACE FUNCTION public.income_import_uber(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_partner CONSTANT text := 'reidey';
  c_source  CONSTANT text := 'uber';
  v_company  uuid := public.get_active_company_id();
  v_member   uuid;
  v_unlinked text;
  v_inserted integer;
  v_drivers  integer;
BEGIN
  IF v_company IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  SELECT up.company_id INTO v_member
    FROM public.user_profiles up WHERE up.user_id = auth.uid();
  IF v_member IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'a platform session imports nothing'
      USING ERRCODE = '42501', HINT = 'platform_session_not_allowed';
  END IF;

  IF NOT public.current_role_permits('income', true) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array'
     OR jsonb_array_length(p_rows) = 0 OR jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'invalid rows' USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  -- Every element must have exactly the shape the browser builds. Regexes first,
  -- casts after, so a malformed value is a refusal and not a stray cast error.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) e
     WHERE NOT (
       jsonb_typeof(e) = 'object'
       AND e->>'external_driver_id' ~ '^[0-9]{1,18}$'
       AND e->>'type' IN ('umsatz', 'aktionen', 'trinkgeld', 'bargeld')
       AND jsonb_typeof(e->'amount') = 'string'
       AND e->>'amount' ~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$'
       AND e->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       AND e->>'period_start' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       AND e->>'period_end' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       AND e->>'week' ~ '^[1-5]$'
       AND length(coalesce(e->>'description', '')) BETWEEN 1 AND 200
       AND (e->'trip_count' IS NULL OR jsonb_typeof(e->'trip_count') = 'null'
            OR e->>'trip_count' ~ '^[0-9]{1,9}$')
     )
  ) THEN
    RAISE EXCEPTION 'a row is malformed' USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  -- One import per company at a time, so the overlap check below cannot be
  -- passed by two calls together. The unique index is the backstop.
  PERFORM pg_advisory_xact_lock(hashtextextended('income_import_uber:' || v_company::text, 0));

  -- Resolved from the CONFIRMED link; one unlinked driver stops the whole call.
  SELECT string_agg(k.key, ',' ORDER BY k.key) INTO v_unlinked
    FROM (SELECT DISTINCT e->>'external_driver_id' AS key FROM jsonb_array_elements(p_rows) e) k
   WHERE NOT EXISTS (
     SELECT 1
       FROM public.partner_driver_links l
       JOIN public.drivers d ON d.id = l.driver_id AND d.company_id = v_company
      WHERE l.company_id = v_company AND l.partner = c_partner
        AND l.external_driver_id = k.key AND l.status = 'linked'
   );
  IF v_unlinked IS NOT NULL THEN
    RAISE EXCEPTION 'some drivers have no confirmed link'
      USING ERRCODE = '22023', HINT = 'driver_not_linked', DETAIL = v_unlinked;
  END IF;

  BEGIN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_rows) e
       WHERE (e->>'period_start')::date > (e->>'period_end')::date
          OR (e->>'period_end')::date - (e->>'period_start')::date > 6
          OR (e->>'date')::date NOT BETWEEN (e->>'period_start')::date AND (e->>'period_end')::date
    ) THEN
      RAISE EXCEPTION 'a period is not inside one week' USING ERRCODE = '22023', HINT = 'invalid_period';
    END IF;

    -- A period that overlaps one already imported for the driver is the same
    -- days counted twice, whatever its start day says.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_rows) e
        JOIN public.income i
          ON i.company_id = v_company AND i.source = c_source
         AND i.source_driver_key = e->>'external_driver_id'
         AND i.source_period_start <= (e->>'period_end')::date
         AND i.source_period_end   >= (e->>'period_start')::date
    ) THEN
      RAISE EXCEPTION 'this period was already imported' USING ERRCODE = '23505', HINT = 'already_imported';
    END IF;

    INSERT INTO public.income
           (description, amount, type, driver_name, date, week, trip_count, company_id,
            source, source_period_start, source_period_end, source_driver_key)
    SELECT e->>'description', (e->>'amount')::numeric(12,2), e->>'type',
           d.name,   -- OUR row's name, character for character
           (e->>'date')::date, (e->>'week')::integer,
           CASE WHEN jsonb_typeof(e->'trip_count') = 'number' THEN (e->>'trip_count')::integer END,
           v_company, c_source,
           (e->>'period_start')::date, (e->>'period_end')::date, e->>'external_driver_id'
      FROM jsonb_array_elements(p_rows) e
      JOIN public.partner_driver_links l
        ON l.company_id = v_company AND l.partner = c_partner
       AND l.external_driver_id = e->>'external_driver_id' AND l.status = 'linked'
      JOIN public.drivers d ON d.id = l.driver_id AND d.company_id = v_company;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'this period was already imported' USING ERRCODE = '23505', HINT = 'already_imported';
    WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'a date is not a date' USING ERRCODE = '22023', HINT = 'invalid_request';
  END;

  IF v_inserted <> jsonb_array_length(p_rows) THEN
    -- The join dropped a row: a link that vanished mid-call. Nothing stays.
    RAISE EXCEPTION 'some drivers have no confirmed link'
      USING ERRCODE = '22023', HINT = 'driver_not_linked';
  END IF;

  SELECT count(DISTINCT e->>'external_driver_id') INTO v_drivers FROM jsonb_array_elements(p_rows) e;
  RETURN jsonb_build_object('ok', true, 'inserted', v_inserted, 'drivers', v_drivers);
END;
$$;

COMMENT ON FUNCTION public.income_import_uber(jsonb) IS
  'Writes the income rows of an Uber earnings import in one transaction. Takes '
  'only the partner''s driver id and resolves OUR driver''s name through the '
  'confirmed partner_driver_links row; one unlinked driver refuses the whole '
  'call. Refuses a period already imported (23505, already_imported). Asks '
  'get_active_company_id() and current_role_permits(income, true) itself, and '
  'refuses a platform session. Refusals are HINT codes.';

REVOKE ALL ON FUNCTION public.income_import_uber(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.income_import_uber(jsonb) TO authenticated;

-- ─── 4. self-check: a release that loses any of this fails ─────────────────

DO $$
DECLARE
  v_def  text;
  v_fn   oid := 'public.income_import_uber(jsonb)'::regprocedure;
  v_src  text;
  v_col  text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['source', 'source_period_start', 'source_period_end', 'source_driver_key'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'income' AND column_name = v_col) THEN
      RAISE EXCEPTION 'self-check: income.% is missing', v_col;
    END IF;
  END LOOP;

  SELECT pg_get_indexdef(i.indexrelid) INTO v_def
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'income_source_period_key' AND c.relnamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'self-check: the unique index income_source_period_key is missing';
  END IF;
  IF v_def NOT LIKE 'CREATE UNIQUE INDEX%'
     OR v_def NOT LIKE '%(company_id, source, source_driver_key, source_period_start, type)%'
     OR v_def NOT LIKE '%WHERE (source IS NOT NULL)%' THEN
    RAISE EXCEPTION 'self-check: income_source_period_key lost its shape: %', v_def;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'income_source_shape' AND conrelid = 'public.income'::regclass) THEN
    RAISE EXCEPTION 'self-check: income_source_shape is missing';
  END IF;

  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn) THEN
    RAISE EXCEPTION 'self-check: income_import_uber must be SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn
                  AND p.proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION 'self-check: income_import_uber lost its pinned search_path';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn AND p.proacl IS NOT NULL)
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn AND a.grantee = 0) THEN
    RAISE EXCEPTION 'self-check: income_import_uber is executable by anon or PUBLIC';
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check: income_import_uber is not executable by authenticated';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_fn;
  IF v_src NOT LIKE '%current_role_permits(''income'', true)%'
     OR v_src NOT LIKE '%get_active_company_id()%'
     OR v_src NOT LIKE '%partner_driver_links%'
     OR v_src NOT LIKE '%d.name,%'
     OR v_src LIKE '%SQLERRM%' THEN
    RAISE EXCEPTION 'self-check: income_import_uber lost a gate, the link join, or the name from our drivers row';
  END IF;
END $$;
