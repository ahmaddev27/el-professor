-- ════════════════════════════════════════════════════════════════════════════
--  Undo the Uber import: delete what the one import button created, and
--  nothing else
-- ════════════════════════════════════════════════════════════════════════════
--
--  Owner, 16.10.2026: "on the import page I want something that deletes the
--  data and warns the user how dangerous it is, because I delete and re-import
--  to get the trial right". A testing tool that also exists in production, where
--  an administrator could click it by mistake. Built for the second case.
--
--  ── What goes ───────────────────────────────────────────────────────────────
--
--    * income rows with source = 'uber' (income_import_uber's own constant) of
--      the caller's company. A hand-typed row carries source IS NULL, and
--      `NULL = 'uber'` is not true, so no hand-typed row can match.
--    * drivers and cars the import CREATED (partner_*_links.created_by_import)
--      that carry nothing else, and the links of exactly those.
--
--  ── What stays, and why each is a way to destroy real work ──────────────────
--
--    * A driver or car that anything else refers to. `drivers.name` has no
--      foreign key and income, receipts, trips and the planning tables join on
--      the NAME, while salaries, cash receipts, notes and Stundennachweise
--      reference the id with ON DELETE CASCADE -- so deleting such a driver
--      either orphans rows silently or takes them with it. The references are
--      found in the CATALOGUE on every call (uber_undo_reference_columns), not
--      from a list: a table added next month that points at a driver is counted
--      the day it exists, and a driver it points at stays.
--    * A driver or car that was LINKED to an existing row rather than created.
--      The link says nothing about who made the row, so the import now records
--      it (below).
--    * The partner connection, pending proposals, the links of kept rows, and
--      every other company's rows.
--
--  ── "Created by the import" had no marker, so it gets one ───────────────────
--
--  partner_driver_links.driver_id and partner_vehicle_links.car_id say which row
--  a partner entry IS, whether the import made that row or found it. Deleting
--  by link would delete drivers the operator typed in years ago. The three
--  functions that create rows (partner_drivers_import, partner_vehicles_import,
--  partner_earners_resolve) create the row and write the link in ONE
--  transaction, so the row's created_at equals the link's linked_at; no other
--  path does (the operator links in a later request, to a row that is older).
--  A BEFORE trigger derives `created_by_import` from exactly that fact whenever
--  a link names a row, so those three functions are not restated, and a client
--  that may UPDATE a link (the drivers page can) cannot set the flag by hand:
--  the trigger overwrites whatever it sends. The same fact, applied once to the
--  links that already exist, is the backfill.
--
--  ── One function, a dry-run argument ────────────────────────────────────────
--
--  uber_import_undo(p_dry_run, ...) computes the plan ONCE, in
--  app_private.uber_undo_plan, and either returns it or executes it. A separate
--  preview function would be a second copy of the counting, and a preview that
--  counts differently from what the delete removes is worse than none. The
--  delete additionally takes the counts the operator was shown and refuses
--  (plan_changed) when the database no longer agrees, and takes the company's
--  name typed by the operator and compares it itself (confirmation_mismatch).
--
--  Administrator only and refused in a platform session, exactly like the
--  fleet import. Reidey is the only partner; its name is a constant here as in
--  income_import_uber.

-- ─── 1. the marker ──────────────────────────────────────────────────────────

ALTER TABLE public.partner_driver_links
  ADD COLUMN IF NOT EXISTS created_by_import boolean NOT NULL DEFAULT false;
ALTER TABLE public.partner_vehicle_links
  ADD COLUMN IF NOT EXISTS created_by_import boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.partner_driver_links.created_by_import IS
  'True when the driver row this link names was created in the same transaction '
  'that linked it, which only the fleet import and the earnings resolve do. '
  'Derived by partner_link_mark_created_driver; never set by a client.';
COMMENT ON COLUMN public.partner_vehicle_links.created_by_import IS
  'True when the car row this link names was created in the same transaction '
  'that linked it (the fleet import). Derived by partner_link_mark_created_car; '
  'never set by a client.';

-- Backfill, BEFORE the triggers exist (a BEFORE UPDATE trigger that keeps the
-- old value would otherwise overwrite it). Same fact the trigger derives.
UPDATE public.partner_driver_links l
   SET created_by_import = true
  FROM public.drivers d
 WHERE d.id = l.driver_id AND d.company_id = l.company_id
   AND l.status = 'linked' AND l.linked_at IS NOT NULL
   AND d.created_at = l.linked_at;

UPDATE public.partner_vehicle_links l
   SET created_by_import = true
  FROM public.cars c
 WHERE c.id = l.car_id AND c.company_id = l.company_id
   AND l.status = 'linked' AND l.linked_at IS NOT NULL
   AND c.created_at = l.linked_at;

CREATE OR REPLACE FUNCTION app_private.partner_link_mark_created_driver()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Unchanged target: the flag is whatever it was, whatever the statement says.
  IF TG_OP = 'UPDATE' AND NEW.driver_id IS NOT DISTINCT FROM OLD.driver_id THEN
    NEW.created_by_import := OLD.created_by_import;
    RETURN NEW;
  END IF;
  NEW.created_by_import := NEW.driver_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.drivers d
     WHERE d.id = NEW.driver_id AND d.company_id = NEW.company_id
       AND d.created_at = transaction_timestamp());
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.partner_link_mark_created_car()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.car_id IS NOT DISTINCT FROM OLD.car_id THEN
    NEW.created_by_import := OLD.created_by_import;
    RETURN NEW;
  END IF;
  NEW.created_by_import := NEW.car_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.cars c
     WHERE c.id = NEW.car_id AND c.company_id = NEW.company_id
       AND c.created_at = transaction_timestamp());
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.partner_link_mark_created_driver() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.partner_link_mark_created_car() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS partner_link_mark_created ON public.partner_driver_links;
CREATE TRIGGER partner_link_mark_created
  BEFORE INSERT OR UPDATE ON public.partner_driver_links
  FOR EACH ROW EXECUTE FUNCTION app_private.partner_link_mark_created_driver();

DROP TRIGGER IF EXISTS partner_link_mark_created ON public.partner_vehicle_links;
CREATE TRIGGER partner_link_mark_created
  BEFORE INSERT OR UPDATE ON public.partner_vehicle_links
  FOR EACH ROW EXECUTE FUNCTION app_private.partner_link_mark_created_car();

-- ─── 2. what refers to a driver or a car, from the catalogue ────────────────
--
--  Four kinds, and each exists because the product refers to a row that way:
--    driver_id   an id column that is a foreign key to drivers, or is NAMED like
--                one (planning tables hold the id with no foreign key)
--    driver_name a text column named *driver_name on a company table: the
--                joins that have no foreign key at all
--    car_id      the same for cars
--    car_plate   a text column that holds a plate (trips and the planning
--                tables name the car by plate)
--  partner_driver_links and partner_vehicle_links are excluded: their rows are
--  deleted with the row. `external_*` columns are the partner's own keys.

CREATE OR REPLACE FUNCTION app_private.uber_undo_reference_columns()
RETURNS TABLE (kind text, tbl name, col name, is_uuid boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH cols AS (
    SELECT c.oid AS rel, c.relname, a.attnum, a.attname, a.atttypid,
           EXISTS (SELECT 1 FROM pg_attribute x
                    WHERE x.attrelid = c.oid AND x.attname = 'company_id' AND NOT x.attisdropped) AS has_company
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND c.relname NOT IN ('drivers', 'cars', 'partner_driver_links', 'partner_vehicle_links')
       AND a.atttypid IN ('uuid'::regtype, 'text'::regtype)
  ), fk AS (
    SELECT k.conrelid AS rel, k.conkey[1] AS attnum, k.confrelid
      FROM pg_constraint k
     WHERE k.contype = 'f' AND array_length(k.conkey, 1) = 1
       AND k.confrelid IN ('public.drivers'::regclass, 'public.cars'::regclass)
  )
  SELECT 'driver_id'::text, c.relname, c.attname, c.atttypid = 'uuid'::regtype
    FROM cols c
   WHERE EXISTS (SELECT 1 FROM fk WHERE fk.rel = c.rel AND fk.attnum = c.attnum
                                    AND fk.confrelid = 'public.drivers'::regclass)
      OR (c.attname ~ '(^|_)driver_id$' AND c.attname !~ 'external')
  UNION ALL
  SELECT 'driver_name', c.relname, c.attname, false
    FROM cols c
   WHERE c.has_company AND c.atttypid = 'text'::regtype
     AND c.attname ~ '(^|_)driver_name$' AND c.attname !~ 'external'
  UNION ALL
  SELECT 'car_id', c.relname, c.attname, c.atttypid = 'uuid'::regtype
    FROM cols c
   WHERE EXISTS (SELECT 1 FROM fk WHERE fk.rel = c.rel AND fk.attnum = c.attnum
                                    AND fk.confrelid = 'public.cars'::regclass)
      OR c.attname = 'car_id'
  UNION ALL
  SELECT 'car_plate', c.relname, c.attname, false
    FROM cols c
   WHERE c.has_company AND c.atttypid = 'text'::regtype
     AND c.attname IN ('car_identifier', 'vehicle_identifier', 'vehicle_plate', 'vehicle');
$$;

REVOKE ALL ON FUNCTION app_private.uber_undo_reference_columns() FROM PUBLIC, anon, authenticated;

-- ─── 3. the plan: what is a candidate, and what keeps it ────────────────────
--
--  A candidate is a driver or car the import created. `blockers` maps
--  "table.column" to the number of rows that refer to it; an empty object means
--  it can go. The company's Uber income is not a blocker, because it is deleted
--  by the same call (income's own driver_name is counted only for the rows that
--  stay, i.e. `source IS DISTINCT FROM 'uber'` -- the exact complement of the
--  delete's `source = 'uber'`).

CREATE OR REPLACE FUNCTION app_private.uber_undo_plan(p_company uuid)
RETURNS TABLE (entity text, entity_id uuid, label text, blockers jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_partner CONSTANT text := 'reidey';
  v_driver_ids   uuid[];
  v_driver_texts text[];
  v_driver_names text[];
  v_car_ids      uuid[];
  v_plate_keys   text[];
  v_parts        text[] := '{}';
  v_sql          text;
  v_refs         jsonb := '[]'::jsonb;
  r              record;
BEGIN
  SELECT coalesce(array_agg(d.id), '{}'), coalesce(array_agg(d.id::text), '{}'),
         coalesce(array_agg(DISTINCT lower(btrim(d.name))), '{}')
    INTO v_driver_ids, v_driver_texts, v_driver_names
    FROM public.drivers d
    JOIN public.partner_driver_links l
      ON l.driver_id = d.id AND l.company_id = p_company AND l.partner = c_partner
     AND l.status = 'linked' AND l.created_by_import
   WHERE d.company_id = p_company;

  SELECT coalesce(array_agg(c.id), '{}'),
         coalesce(array_agg(DISTINCT app_private.partner_plate_key(c.kennzeichen)), '{}')
    INTO v_car_ids, v_plate_keys
    FROM public.cars c
    JOIN public.partner_vehicle_links l
      ON l.car_id = c.id AND l.company_id = p_company AND l.partner = c_partner
     AND l.status = 'linked' AND l.created_by_import
   WHERE c.company_id = p_company;

  FOR r IN SELECT * FROM app_private.uber_undo_reference_columns() LOOP
    v_parts := v_parts || CASE r.kind
      WHEN 'driver_id' THEN format(
        'SELECT ''driver''::text, %L::text, t.%I::text, count(*) FROM public.%I t WHERE t.%I = ANY(%s) GROUP BY 3',
        r.tbl || '.' || r.col, r.col, r.tbl, r.col, CASE WHEN r.is_uuid THEN '$1' ELSE '$2' END)
      WHEN 'driver_name' THEN format(
        'SELECT ''driver_name''::text, %L::text, lower(btrim(t.%I)), count(*) FROM public.%I t '
        'WHERE t.company_id = $6 AND lower(btrim(t.%I)) = ANY($3) %s GROUP BY 3',
        r.tbl || '.' || r.col, r.col, r.tbl, r.col,
        CASE WHEN r.tbl = 'income' THEN 'AND t.source IS DISTINCT FROM ''uber''' ELSE '' END)
      WHEN 'car_id' THEN format(
        'SELECT ''car''::text, %L::text, t.%I::text, count(*) FROM public.%I t WHERE t.%I = ANY($4) GROUP BY 3',
        r.tbl || '.' || r.col, r.col, r.tbl, r.col)
      ELSE format(
        'SELECT ''car_plate''::text, %L::text, app_private.partner_plate_key(t.%I), count(*) FROM public.%I t '
        'WHERE t.company_id = $6 AND app_private.partner_plate_key(t.%I) = ANY($5) GROUP BY 3',
        r.tbl || '.' || r.col, r.col, r.tbl, r.col)
    END;
  END LOOP;

  IF (cardinality(v_driver_ids) > 0 OR cardinality(v_car_ids) > 0) AND cardinality(v_parts) > 0 THEN
    v_sql := 'SELECT coalesce(jsonb_agg(jsonb_build_object(''entity'', x.e, ''src'', x.s, ''key'', x.k, ''n'', x.n)), ''[]''::jsonb) '
          || 'FROM (' || array_to_string(v_parts, ' UNION ALL ') || ') x(e, s, k, n)';
    EXECUTE v_sql INTO v_refs
      USING v_driver_ids, v_driver_texts, v_driver_names, v_car_ids, v_plate_keys, p_company;
  END IF;

  RETURN QUERY
  WITH refs AS (
    SELECT j->>'entity' AS e, j->>'src' AS s, j->>'key' AS k, (j->>'n')::bigint AS n
      FROM jsonb_array_elements(v_refs) j
  )
  SELECT 'driver'::text, d.id, d.name,
         coalesce((SELECT jsonb_object_agg(g.s, g.n)
                     FROM (SELECT f.s, sum(f.n) AS n FROM refs f
                            WHERE (f.e = 'driver' AND f.k = d.id::text)
                               OR (f.e = 'driver_name' AND f.k = lower(btrim(d.name)))
                            GROUP BY f.s) g), '{}'::jsonb)
    FROM public.drivers d
   WHERE d.id = ANY(v_driver_ids)
  UNION ALL
  SELECT 'car'::text, c.id, c.kennzeichen,
         coalesce((SELECT jsonb_object_agg(g.s, g.n)
                     FROM (SELECT f.s, sum(f.n) AS n FROM refs f
                            WHERE (f.e = 'car' AND f.k = c.id::text)
                               OR (f.e = 'car_plate' AND f.k = app_private.partner_plate_key(c.kennzeichen))
                            GROUP BY f.s) g), '{}'::jsonb)
    FROM public.cars c
   WHERE c.id = ANY(v_car_ids);
END;
$$;

REVOKE ALL ON FUNCTION app_private.uber_undo_plan(uuid) FROM PUBLIC, anon, authenticated;

-- ─── 4. the action ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.uber_import_undo(
  p_dry_run      boolean DEFAULT true,
  p_confirm_name text    DEFAULT NULL,
  p_expected     jsonb   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_partner CONSTANT text := 'reidey';
  c_source  CONSTANT text := 'uber';
  v_company  uuid := public.get_active_company_id();
  v_caller   uuid := auth.uid();
  v_member   uuid;
  v_name     text;
  v_rows     integer;
  v_from     date;
  v_to       date;
  v_inc_drv  integer;
  v_hand     integer;
  v_salaries integer;
  v_del_d    uuid[];
  v_del_c    uuid[];
  v_n_del_d  integer;
  v_n_del_c  integer;
  v_drivers  jsonb;
  v_cars     jsonb;
  v_untouched_d integer;
  v_untouched_c integer;
  v_count    integer;
BEGIN
  IF v_caller IS NULL OR v_company IS NULL THEN
    RAISE EXCEPTION 'Keine Berechtigung.' USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  -- A company and no membership is an open platform context.
  SELECT up.company_id INTO v_member FROM public.user_profiles up WHERE up.user_id = v_caller;
  IF v_member IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'a platform session imports nothing'
      USING ERRCODE = '42501', HINT = 'platform_session_not_allowed';
  END IF;

  IF NOT public.is_company_admin() THEN
    RAISE EXCEPTION 'Keine Berechtigung.' USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_dry_run IS NULL THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  SELECT co.name INTO v_name FROM public.companies co WHERE co.id = v_company;

  IF NOT p_dry_run THEN
    IF p_confirm_name IS NULL OR v_name IS NULL OR btrim(p_confirm_name) <> btrim(v_name) THEN
      RAISE EXCEPTION 'the typed name is not the company''s name'
        USING ERRCODE = '22023', HINT = 'confirmation_mismatch';
    END IF;
    IF p_expected IS NULL OR jsonb_typeof(p_expected) <> 'object'
       OR jsonb_typeof(p_expected->'income') <> 'number'
       OR jsonb_typeof(p_expected->'drivers') <> 'number'
       OR jsonb_typeof(p_expected->'cars') <> 'number' THEN
      RAISE EXCEPTION 'the expected counts are missing' USING ERRCODE = '22023', HINT = 'invalid_request';
    END IF;
    -- The same two locks the imports take, in the same order, so an import
    -- running now finishes first and one started now waits.
    PERFORM pg_advisory_xact_lock(hashtextextended('partner_fleet_import:' || v_company::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('income_import_uber:' || v_company::text, 0));
  END IF;

  -- ── the plan, computed once for both modes ──
  SELECT count(*), min(i.source_period_start), max(i.source_period_end),
         count(DISTINCT lower(btrim(i.driver_name)))
    INTO v_rows, v_from, v_to, v_inc_drv
    FROM public.income i WHERE i.company_id = v_company AND i.source = c_source;

  SELECT count(*) INTO v_hand FROM public.income i
   WHERE i.company_id = v_company AND i.source IS NULL;

  SELECT coalesce(array_agg(p.entity_id) FILTER (WHERE p.entity = 'driver' AND p.blockers = '{}'::jsonb), '{}'),
         coalesce(array_agg(p.entity_id) FILTER (WHERE p.entity = 'car' AND p.blockers = '{}'::jsonb), '{}'),
         coalesce(jsonb_agg(jsonb_build_object('id', p.entity_id, 'name', p.label, 'blockers', p.blockers)
                  ORDER BY p.label) FILTER (WHERE p.entity = 'driver' AND p.blockers <> '{}'::jsonb), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('id', p.entity_id, 'plate', p.label, 'blockers', p.blockers)
                  ORDER BY p.label) FILTER (WHERE p.entity = 'car' AND p.blockers <> '{}'::jsonb), '[]'::jsonb)
    INTO v_del_d, v_del_c, v_drivers, v_cars
    FROM app_private.uber_undo_plan(v_company) p;
  v_n_del_d := cardinality(v_del_d);
  v_n_del_c := cardinality(v_del_c);

  SELECT count(*) INTO v_untouched_d FROM public.partner_driver_links l
   WHERE l.company_id = v_company AND l.partner = c_partner AND l.status = 'linked'
     AND NOT l.created_by_import;
  SELECT count(*) INTO v_untouched_c FROM public.partner_vehicle_links l
   WHERE l.company_id = v_company AND l.partner = c_partner AND l.status = 'linked'
     AND NOT l.created_by_import;

  -- Salary rows whose period contains a day of Uber income that is about to go:
  -- the figure was computed from it, and it will not be recomputed.
  SELECT count(*) INTO v_salaries
    FROM public.salaries s
    JOIN public.drivers d ON d.id = s.driver_id AND d.company_id = v_company
   WHERE s.company_id = v_company
     AND EXISTS (SELECT 1 FROM public.income i
                  WHERE i.company_id = v_company AND i.source = c_source
                    AND lower(btrim(i.driver_name)) = lower(btrim(d.name))
                    AND i.date BETWEEN s.period_start AND s.period_end);

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'ok', true, 'dry_run', true, 'company_name', v_name,
      'income', jsonb_build_object('rows', v_rows, 'from', v_from, 'to', v_to, 'drivers', v_inc_drv),
      'hand_typed_rows', v_hand,
      'drivers', jsonb_build_object(
        'delete', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) ORDER BY d.name)
                              FROM public.drivers d WHERE d.id = ANY(v_del_d)), '[]'::jsonb),
        'keep', v_drivers, 'untouched', v_untouched_d),
      'cars', jsonb_build_object(
        'delete', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'plate', c.kennzeichen) ORDER BY c.kennzeichen)
                              FROM public.cars c WHERE c.id = ANY(v_del_c)), '[]'::jsonb),
        'keep', v_cars, 'untouched', v_untouched_c),
      'salaries_affected', v_salaries,
      'expect', jsonb_build_object('income', v_rows, 'drivers', v_n_del_d, 'cars', v_n_del_c));
  END IF;

  IF (p_expected->>'income')::integer <> v_rows
     OR (p_expected->>'drivers')::integer <> v_n_del_d
     OR (p_expected->>'cars')::integer <> v_n_del_c THEN
    RAISE EXCEPTION 'the data changed since the preview' USING ERRCODE = '22023', HINT = 'plan_changed';
  END IF;

  -- ── the deletes. One transaction: any count that differs from the plan
  --    raises and everything above stands. ──

  -- The company, the function's own source constant, nothing from the payload.
  -- NULL = 'uber' is not true: a hand-typed row cannot match.
  DELETE FROM public.income i
   WHERE i.company_id = v_company
     AND i.source = c_source;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> v_rows THEN
    RAISE EXCEPTION 'income count differs from the plan' USING ERRCODE = '22023', HINT = 'plan_changed';
  END IF;

  -- Links first: the foreign key would try SET NULL on a linked row, and the
  -- table's own check forbids a linked row without a driver.
  DELETE FROM public.partner_driver_links l
   WHERE l.company_id = v_company AND l.partner = c_partner AND l.driver_id = ANY(v_del_d);
  DELETE FROM public.partner_vehicle_links l
   WHERE l.company_id = v_company AND l.partner = c_partner AND l.car_id = ANY(v_del_c);

  DELETE FROM public.drivers d
   WHERE d.company_id = v_company AND d.id = ANY(v_del_d);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> v_n_del_d THEN
    RAISE EXCEPTION 'driver count differs from the plan' USING ERRCODE = '22023', HINT = 'plan_changed';
  END IF;

  DELETE FROM public.cars c
   WHERE c.company_id = v_company AND c.id = ANY(v_del_c);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> v_n_del_c THEN
    RAISE EXCEPTION 'car count differs from the plan' USING ERRCODE = '22023', HINT = 'plan_changed';
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'dry_run', false,
    'deleted', jsonb_build_object('income', v_rows, 'drivers', v_n_del_d, 'cars', v_n_del_c),
    'kept', jsonb_build_object('drivers', jsonb_array_length(v_drivers), 'cars', jsonb_array_length(v_cars)),
    'hand_typed_rows', v_hand);
END;
$$;

COMMENT ON FUNCTION public.uber_import_undo(boolean, text, jsonb) IS
  'Undoes the Uber import of the caller''s company: deletes its source = uber '
  'income rows and the drivers and cars the import created that nothing else '
  'refers to, with their links. p_dry_run (the default) only reports the plan. '
  'A real run needs the company''s name typed (confirmation_mismatch) and the '
  'counts the preview showed (plan_changed). Hand-typed income, linked-not-'
  'created rows, rows that carry other data, the partner connection and other '
  'companies are never touched. Administrator only; refuses a platform session.';

REVOKE ALL ON FUNCTION public.uber_import_undo(boolean, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.uber_import_undo(boolean, text, jsonb) TO authenticated;

-- ─── 5. self-check: shape and behaviour, no stored data ─────────────────────

DO $check$
DECLARE
  v_fn   oid := 'public.uber_import_undo(boolean,text,jsonb)'::regprocedure;
  v_src  text;
  v_del  text;
  v_n    integer;
  r      record;
BEGIN
  -- 1. definers with a pinned search_path; the helpers are unreachable from an API role.
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.oid IN (v_fn, 'app_private.uber_undo_plan(uuid)'::regprocedure,
                   'app_private.uber_undo_reference_columns()'::regprocedure,
                   'app_private.partner_link_mark_created_driver()'::regprocedure,
                   'app_private.partner_link_mark_created_car()'::regprocedure)
     AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public'];
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'undo self-check 1: % of 5 functions are SECURITY DEFINER with a pinned search_path', v_n;
  END IF;
  FOR r IN SELECT unnest(ARRAY['app_private.uber_undo_plan(uuid)',
                               'app_private.uber_undo_reference_columns()',
                               'app_private.partner_link_mark_created_driver()',
                               'app_private.partner_link_mark_created_car()']) AS f LOOP
    IF has_function_privilege('anon', r.f::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', r.f::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'undo self-check 1: % is executable by an API role', r.f;
    END IF;
  END LOOP;

  -- 2. the action: authenticated only; no PUBLIC, no anon.
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn AND a.grantee = 0)
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'undo self-check 2: the grants are wrong';
  END IF;

  -- 3. the gates: company, membership (platform), administrator.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn;
  IF v_src NOT LIKE '%get_active_company_id()%' OR v_src NOT LIKE '%platform_session_not_allowed%'
     OR v_src NOT LIKE '%is_company_admin()%' OR v_src NOT LIKE '%confirmation_mismatch%'
     OR v_src NOT LIKE '%plan_changed%' OR v_src LIKE '%SQLERRM%' THEN
    RAISE EXCEPTION 'undo self-check 3: the action lost a gate, the typed name, the expected counts, or reads SQLERRM';
  END IF;
  IF position('is_company_admin()' IN v_src) > position('IF NOT p_dry_run THEN' IN v_src)
     OR position('platform_session_not_allowed' IN v_src) > position('is_company_admin()' IN v_src) THEN
    RAISE EXCEPTION 'undo self-check 3: the gates must run before anything is read or deleted';
  END IF;

  -- 4. exactly five deletes, the income one bounded by company and the source
  --    constant alone, and no delete before the plan was compared.
  IF (length(v_src) - length(replace(v_src, 'DELETE FROM', ''))) / length('DELETE FROM') <> 5 THEN
    RAISE EXCEPTION 'undo self-check 4: the action must contain exactly five DELETE statements';
  END IF;
  v_del := substring(v_src FROM 'DELETE FROM public\.income i.*?;');
  IF v_del IS NULL
     OR v_del NOT LIKE '%i.company_id = v_company%'
     OR v_del NOT LIKE '%i.source = c_source%'
     OR v_del ILIKE '%IS NULL%' OR v_del ILIKE '% OR %' OR v_del ILIKE '%coalesce%'
     OR v_del ILIKE '%IS DISTINCT%' OR v_del LIKE '%''source''%' THEN
    RAISE EXCEPTION 'undo self-check 4: the income delete may match a hand-typed row or reads the source from elsewhere: %', v_del;
  END IF;
  IF position('DELETE FROM' IN v_src) < position('plan_changed' IN v_src) THEN
    RAISE EXCEPTION 'undo self-check 4: a delete runs before the expected counts are compared';
  END IF;
  -- The links go before the rows they name (the table's check forbids a
  -- linked row with no driver), and every row delete names the company.
  IF position('DELETE FROM public.partner_driver_links' IN v_src) > position('DELETE FROM public.drivers' IN v_src)
     OR position('DELETE FROM public.partner_vehicle_links' IN v_src) > position('DELETE FROM public.cars' IN v_src)
     OR v_src !~ 'DELETE FROM public\.drivers d\s+WHERE d\.company_id = v_company AND d\.id = ANY\(v_del_d\)'
     OR v_src !~ 'DELETE FROM public\.cars c\s+WHERE c\.company_id = v_company AND c\.id = ANY\(v_del_c\)' THEN
    RAISE EXCEPTION 'undo self-check 4: a row delete lost its company, its id list, or runs before its link';
  END IF;

  -- 5. the plan counts the complement of that delete (hand-typed income blocks
  --    a driver), and starts from the marker, never from a name.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'app_private.uber_undo_plan(uuid)'::regprocedure;
  IF v_src NOT LIKE '%t.source IS DISTINCT FROM %uber%'
     OR v_src NOT LIKE '%l.created_by_import%' OR v_src NOT LIKE '%l.status = ''linked''%'
     OR v_src ~* '(DELETE|UPDATE|INSERT)\s' THEN
    RAISE EXCEPTION 'undo self-check 5: the plan lost the complement of the income delete, the marker, or writes';
  END IF;

  -- 6. the reference scan is driven by the catalogue and misses no foreign key
  --    to a driver or a car (single-column ones; a composite one is refused here).
  IF EXISTS (SELECT 1 FROM pg_constraint k
              WHERE k.contype = 'f' AND array_length(k.conkey, 1) > 1
                AND k.confrelid IN ('public.drivers'::regclass, 'public.cars'::regclass)) THEN
    RAISE EXCEPTION 'undo self-check 6: a composite foreign key to drivers or cars exists; the scan cannot see it';
  END IF;
  FOR r IN
    SELECT k.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint k
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
     WHERE k.contype = 'f' AND array_length(k.conkey, 1) = 1
       AND k.confrelid IN ('public.drivers'::regclass, 'public.cars'::regclass)
       AND k.conrelid::regclass::text NOT IN ('partner_driver_links', 'partner_vehicle_links', 'public.partner_driver_links', 'public.partner_vehicle_links')
  LOOP
    IF NOT EXISTS (SELECT 1 FROM app_private.uber_undo_reference_columns() s
                    WHERE s.tbl::text = regexp_replace(r.tbl, '^.*\.', '') AND s.col = r.col) THEN
      RAISE EXCEPTION 'undo self-check 6: the reference scan misses %.%', r.tbl, r.col;
    END IF;
  END LOOP;

  -- 7. the marker: a NOT NULL default-false column and a BEFORE trigger on both links.
  FOR r IN SELECT unnest(ARRAY['partner_driver_links', 'partner_vehicle_links']) AS t LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = ('public.' || r.t)::regclass AND a.attname = 'created_by_import'
                      AND a.attnotnull AND NOT a.attisdropped) THEN
      RAISE EXCEPTION 'undo self-check 7: % lost created_by_import', r.t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = ('public.' || r.t)::regclass AND g.tgname = 'partner_link_mark_created'
                      AND NOT g.tgisinternal
                      AND pg_get_triggerdef(g.oid) LIKE '%BEFORE INSERT OR UPDATE ON%FOR EACH ROW%') THEN
      RAISE EXCEPTION 'undo self-check 7: % lost its before-insert-or-update marker trigger', r.t;
    END IF;
  END LOOP;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'app_private.partner_link_mark_created_driver()'::regprocedure;
  IF v_src NOT LIKE '%transaction_timestamp()%' OR v_src NOT LIKE '%NEW.created_by_import := OLD.created_by_import%' THEN
    RAISE EXCEPTION 'undo self-check 7: the driver marker no longer derives from the transaction or keeps the old value';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'app_private.partner_link_mark_created_car()'::regprocedure;
  IF v_src NOT LIKE '%transaction_timestamp()%' OR v_src NOT LIKE '%NEW.created_by_import := OLD.created_by_import%' THEN
    RAISE EXCEPTION 'undo self-check 7: the car marker no longer derives from the transaction or keeps the old value';
  END IF;

  RAISE NOTICE 'uber import undo: self-checks passed';
END
$check$;
