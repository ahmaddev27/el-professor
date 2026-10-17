-- ════════════════════════════════════════════════════════════════════════════
--  Uber earnings: a replace mode for income_import_uber
--
--  Owner's decision, 14.10.2026. A week pulled twice (400 EUR, then Uber
--  corrects it to 500 EUR) was refused for good by `income_source_period_key`.
--  He chose: the figure is 500 EUR, the NEW one only. Not both rows (900 EUR
--  would inflate the salary basis, umsatz + aktionen) and not a "cancelled"
--  flag on income (every reader would have to honour it, and the first one that
--  forgot would silently restore the doubled figure).
--
--  ── What replace deletes, and the one predicate that bounds it ──────────────
--
--  A hand-typed row carries `source IS NULL`, and the partial unique index does
--  not see it. The delete is keyed on the index's own columns and on
--  `source = c_source` (the function's own constant, never the payload):
--
--      company_id = get_active_company_id()      -- the function's, not the payload's
--      source = 'uber'                           -- NULL never equals it
--      source_driver_key / source_period_start / type
--                                                -- of the rows being written
--
--  `NULL = 'uber'` is not true, so no hand-typed row can match. That property is
--  what makes replace safe; do not add an OR branch, a COALESCE or a second
--  delete. The self-check below fails a release whose delete loses a term or
--  reads the source from the payload.
--
--  The driver key counts only if it resolves through a CONFIRMED
--  partner_driver_links row of this company, exactly as the insert does, and
--  one unlinked key refuses the whole call before anything is deleted.
--
--  ── Order, atomicity, and what still refuses ────────────────────────────────
--
--  Delete first, insert second, one function call, so one transaction: any
--  refusal after the delete rolls it back and the old rows stand. The overlap
--  check runs AFTER the delete. It therefore still refuses a payload that
--  overlaps an earlier import it did not replace by exact key (another start
--  day, or a type the payload does not carry): that is refused, not half-done.
--
--  ── The signature ───────────────────────────────────────────────────────────
--
--  `p_replace boolean DEFAULT false` is appended LAST so a positional caller
--  keeps its meaning. A new parameter is a new overload, so the one-argument
--  function is dropped; calls with one argument bind to the new one. With
--  p_replace false the behaviour, the answer and every refusal are identical.
--  With it true the answer gains `deleted`.
-- ════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.income_import_uber(jsonb);

CREATE FUNCTION public.income_import_uber(p_rows jsonb, p_replace boolean DEFAULT false)
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
  v_deleted  integer := 0;
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

  IF p_replace IS NULL THEN
    RAISE EXCEPTION 'invalid replace flag' USING ERRCODE = '22023', HINT = 'invalid_request';
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

    -- Replace mode: the previous Uber rows for the (driver, week start) pairs
    -- this payload is about go first.
    --
    -- DELIBERATELY NOT KEYED ON `type`, although the unique index is. One pull
    -- writes one row per driver per type per week, so a week's rows are one
    -- artefact; a correction that drops a type -- tips fall to zero, so the new
    -- payload carries no `trinkgeld` row -- would otherwise leave the old tip
    -- standing beside corrected figures, and then the overlap check below would
    -- refuse the whole call and the operator would have no way through. That is
    -- the exact wall this mode exists to remove (owner, 14.10.2026: pulled
    -- twice, 400 EUR then a corrected 500 EUR, "the new one only").
    --
    -- The company is the function's own, the source is its own constant, and a
    -- driver key counts only through the confirmed link below. Nothing here can
    -- match a row whose source is absent.
    IF p_replace THEN
      DELETE FROM public.income i
       USING (SELECT DISTINCT e->>'external_driver_id' AS driver_key,
                              (e->>'period_start')::date AS period_start
                FROM jsonb_array_elements(p_rows) e
                JOIN public.partner_driver_links l
                  ON l.company_id = v_company AND l.partner = c_partner
                 AND l.external_driver_id = e->>'external_driver_id' AND l.status = 'linked'
                JOIN public.drivers d ON d.id = l.driver_id AND d.company_id = v_company) k
       WHERE i.company_id = v_company
         AND i.source = c_source
         AND i.source_driver_key = k.driver_key
         AND i.source_period_start = k.period_start;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
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
  IF p_replace THEN
    RETURN jsonb_build_object('ok', true, 'inserted', v_inserted, 'drivers', v_drivers, 'deleted', v_deleted);
  END IF;
  RETURN jsonb_build_object('ok', true, 'inserted', v_inserted, 'drivers', v_drivers);
END;
$$;

COMMENT ON FUNCTION public.income_import_uber(jsonb, boolean) IS
  'Writes the income rows of an Uber earnings import in one transaction. Takes '
  'only the partner''s driver id and resolves OUR driver''s name through the '
  'confirmed partner_driver_links row; one unlinked driver refuses the whole '
  'call. Refuses a period already imported (23505, already_imported). With '
  'p_replace it first deletes this company''s source = uber rows for exactly the '
  '(driver, week start, type) keys of the payload (never a hand-typed row) and '
  'answers with the count. Asks get_active_company_id() and '
  'current_role_permits(income, true) itself, and refuses a platform session. '
  'Refusals are HINT codes.';

REVOKE ALL ON FUNCTION public.income_import_uber(jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.income_import_uber(jsonb, boolean) TO authenticated;

-- ─── self-check: a release that loses any of this fails ────────────────────

DO $$
DECLARE
  v_fn   oid := 'public.income_import_uber(jsonb, boolean)'::regprocedure;
  v_src  text;
  v_del  text;
  v_def  text;
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'income_import_uber'
        AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'self-check: income_import_uber must exist exactly once (the one-argument overload must be gone)';
  END IF;
  IF pg_get_function_arguments(v_fn) NOT LIKE '%p_replace boolean DEFAULT false' THEN
    RAISE EXCEPTION 'self-check: p_replace must be the last parameter and default to false: %', pg_get_function_arguments(v_fn);
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn)
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn
                     AND p.proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION 'self-check: income_import_uber lost SECURITY DEFINER or its pinned search_path';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn AND a.grantee = 0)
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check: income_import_uber grants are wrong';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_fn;
  IF v_src NOT LIKE '%current_role_permits(''income'', true)%'
     OR v_src NOT LIKE '%get_active_company_id()%'
     OR v_src NOT LIKE '%platform_session_not_allowed%'
     OR v_src NOT LIKE '%driver_not_linked%'
     OR v_src NOT LIKE '%already_imported%'
     OR v_src NOT LIKE '%d.name,%'
     OR v_src LIKE '%SQLERRM%' THEN
    RAISE EXCEPTION 'self-check: income_import_uber lost a gate, the link join, or the name from our drivers row';
  END IF;

  -- The delete: exactly one statement, bounded by every term, on the constant.
  IF (length(v_src) - length(replace(v_src, 'DELETE FROM', ''))) / length('DELETE FROM') <> 1 THEN
    RAISE EXCEPTION 'self-check: income_import_uber must contain exactly one DELETE';
  END IF;
  v_del := substring(v_src FROM 'DELETE FROM public\.income.*?;');
  IF v_del IS NULL
     OR v_del NOT LIKE '%i.company_id = v_company%'
     OR v_del NOT LIKE '%i.source = c_source%'
     OR v_del NOT LIKE '%i.source_driver_key = k.driver_key%'
     OR v_del NOT LIKE '%i.source_period_start = k.period_start%'
     OR v_del NOT LIKE '%l.status = ''linked''%'
     OR v_del NOT LIKE '%partner_driver_links%' THEN
    RAISE EXCEPTION 'self-check: the replace delete lost the company, the source constant, a key column or the confirmed link: %', v_del;
  END IF;
  -- And it must NOT come back keyed on the row type: that is what strands an
  -- operator whose correction drops a type. See the delete's own comment.
  IF v_del LIKE '%i.type%' THEN
    RAISE EXCEPTION 'self-check: the replace delete is keyed on the row type again, which strands a correction that drops one: %', v_del;
  END IF;
  IF v_del ILIKE '%IS NULL%' OR v_del ILIKE '% OR %' OR v_del ILIKE '%coalesce%'
     OR v_del LIKE '%''source''%' THEN
    RAISE EXCEPTION 'self-check: the replace delete may match a hand-typed row or read the source from the payload: %', v_del;
  END IF;
  IF position('IF p_replace THEN' IN v_src) = 0
     OR position('DELETE FROM' IN v_src) > position('INSERT INTO public.income' IN v_src) THEN
    RAISE EXCEPTION 'self-check: the delete must be gated by p_replace and run before the insert';
  END IF;

  SELECT pg_get_indexdef(i.indexrelid) INTO v_def
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'income_source_period_key' AND c.relnamespace = 'public'::regnamespace;
  IF v_def IS NULL OR v_def NOT LIKE 'CREATE UNIQUE INDEX%'
     OR v_def NOT LIKE '%(company_id, source, source_driver_key, source_period_start, type)%'
     OR v_def NOT LIKE '%WHERE (source IS NOT NULL)%' THEN
    RAISE EXCEPTION 'self-check: income_source_period_key must stay unique and partial: %', v_def;
  END IF;
END $$;
