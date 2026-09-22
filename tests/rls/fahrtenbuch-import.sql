/*
  Fahrtenbuch import reliability (migration 20260922100000, Fahrtenanalyse
  slice A).

  Runs after assertions.sql against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it
  see the database as the seeds left it — including section 7, which swaps the
  trigger function for its previous body and back.

  What is covered, in order:

    1. shape        the new columns, their defaults, the checks, the two
                    uniqueness rules, the triggers; the helpers are invoker,
                    pinned and executable by no API role; no UPDATE policy
    2. immutable    every column protect_fahrtenbuch_immutable_fields held
                    before is still refused, every new one is refused too, the
                    assignment columns still move, reassign_fahrtenbuch_trip
                    still works; an import's file_sha256 does not change
    3. same file    refused for the same company, allowed for another, and an
                    import without a hash (the older ones) never collides
    4. same ride    a second row with the same key is refused in the company,
                    allowed in another; rows without a key never collide
    5. checks       status against is_canceled, the review flags, the time
                    columns, the currency; a row the previous release would
                    insert still goes in
    6. derivation   app_private.fahrtenbuch_trip_times on the cases the browser
                    test (src/utils/fahrtenbuchImportParser.test.ts) pins: the
                    Uber ride, midnight, the 22 rides dated a day early, \N,
                    both DST changes, the fallback, what is left NULL, the
                    column resolution, and the session's TimeZone not mattering
    7. backfill     the function the migration runs, on rows shaped as the
                    previous release stored them, under the trigger as it stood:
                    what each row gets, what stays NULL, no old column moves,
                    and after the restated trigger it can change nothing
    8. tenants      the new columns are read and written under the same rules
                    as the rest of the row
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _fi_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _fi_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

/** A password session of that user. */
CREATE OR REPLACE FUNCTION _fi_become(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _fi_reset();
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/*
  Run one statement and return its scalar, '<null>' when it returns none, or
  `ERR <sqlstate> <message>`. As the connecting superuser when p_user is NULL,
  otherwise as that user. What a statement that succeeds wrote is KEPT.
*/
CREATE OR REPLACE FUNCTION _fi_do(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    IF p_user IS NULL THEN
      PERFORM _fi_reset();
    ELSE
      PERFORM _fi_become(p_user);
    END IF;
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _fi_reset();
  RETURN v_out;
END $$;

/** A value for `SET <column> = …` that differs from whatever the column holds. */
CREATE OR REPLACE FUNCTION _fi_changed_value(p_table regclass, p_col text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
    FROM pg_attribute a
   WHERE a.attrelid = p_table AND a.attname = p_col AND NOT a.attisdropped;
  RETURN CASE
    WHEN v_type = 'text'                     THEN format('coalesce(%I, '''') || ''x''', p_col)
    WHEN v_type = 'text[]'                   THEN format('array_append(%I, ''x'')', p_col)
    WHEN v_type IN ('integer', 'bigint', 'smallint') OR v_type LIKE 'numeric%'
                                             THEN format('coalesce(%I, 0) + 1', p_col)
    WHEN v_type = 'date'                     THEN format('coalesce(%I, DATE ''2000-01-01'') + 1', p_col)
    WHEN v_type = 'time without time zone'   THEN format('coalesce(%I, TIME ''00:00'') + interval ''1 minute''', p_col)
    WHEN v_type = 'timestamp with time zone' THEN format('coalesce(%I, now()) + interval ''1 minute''', p_col)
    WHEN v_type = 'boolean'                  THEN format('NOT coalesce(%I, false)', p_col)
    WHEN v_type = 'jsonb'                    THEN format('coalesce(%I, ''{}''::jsonb) || ''{"probe": 1}''::jsonb', p_col)
    WHEN v_type = 'uuid'                     THEN 'gen_random_uuid()'
  END;
END $$;

/** The derivation, as one text: 'source|start_at|end_at|zone' in UTC. */
CREATE OR REPLACE FUNCTION _fi_times(p_raw jsonb, p_date date, p_start time, p_end time) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v record;
BEGIN
  SELECT * INTO v FROM app_private.fahrtenbuch_trip_times(p_raw, p_date, p_start, p_end);
  RETURN concat_ws('|', v.time_source,
                   coalesce(to_char(v.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '-'),
                   coalesce(to_char(v.end_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '-'),
                   coalesce(v.time_zone, '-'));
END $$;

/** An Uber-shaped raw_data_json with a start and an end. */
CREATE OR REPLACE FUNCTION _fi_raw(p_start text, p_end text) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'Datum/Uhrzeit Auftragseingang',     '2026-08-01 09:58:00.000',
    'Uhrzeit der Auftragsuebermittlung', '2026-08-01 09:58:00.000',
    'Geplante Abholzeit',                '\N',
    'Fahrtstatus',                       'abgeschlossen',
    'Uhrzeit des Fahrtbeginns',          p_start,
    'Uhrzeit des Fahrtendes',            p_end)
$$;

-- ─── fixtures ───────────────────────────────────────────────────────────────

/*
    admin-a  a..01  company A's administrator (seed.sql)
    admin-b  b..01  company B's administrator (seed.sql)
    f1..01          an import of A, hashed
    f1..a1          a trip of A with every new column set
*/
INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by, file_sha256)
VALUES ('f1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 8, 2026,
        'fi-a.xlsx', 'a0000000-0000-4000-8000-000000000001', repeat('1', 64));

INSERT INTO fahrtenbuch_trips (id, company_id, import_id, trip_date, start_time, end_time, duration_minutes,
                               original_driver_name, assigned_driver_name, raw_data_json, source_status,
                               start_at, end_at, time_zone, time_source, trip_status, needs_review,
                               review_reasons, source_row_key, source_row_key_basis)
VALUES ('f1000000-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-00000000000a',
        'f1000000-0000-4000-8000-000000000001', '2026-08-01', '10:05', '10:19', 14,
        'Fahrer Eins', 'Fahrer Eins', _fi_raw('2026-08-01 10:05:31.000', '2026-08-01 10:19:02.000'),
        'abgeschlossen', '2026-08-01 08:05:31+00', '2026-08-01 08:19:02+00', 'Europe/Berlin',
        'source_start_end', 'completed', false, '{}', repeat('a', 64), 'derived_order_transmission');

-- ─── 1. shape ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_fn record;
BEGIN
  PERFORM _fi_ok('shape: the eleven trip columns exist with their types',
    (SELECT count(*) = 11 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'fahrtenbuch_trips'
        AND (c.column_name, c.data_type) IN (
          ('start_at', 'timestamp with time zone'), ('end_at', 'timestamp with time zone'),
          ('time_zone', 'text'), ('time_source', 'text'), ('trip_status', 'text'),
          ('needs_review', 'boolean'), ('review_reasons', 'ARRAY'), ('currency', 'text'),
          ('currency_source', 'text'), ('source_row_key', 'text'), ('source_row_key_basis', 'text'))));

  PERFORM _fi_ok('shape: an import carries file_sha256',
    EXISTS (SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = 'fahrtenbuch_imports'
               AND c.column_name = 'file_sha256' AND c.data_type = 'text'));

  PERFORM _fi_ok('shape: a trip written without the new columns defaults to EUR, assumed, no review',
    (SELECT string_agg(a.attname || '=' || pg_get_expr(d.adbin, d.adrelid), ',' ORDER BY a.attname)
       FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE d.adrelid = 'public.fahrtenbuch_trips'::regclass
        AND a.attname IN ('currency', 'currency_source', 'needs_review', 'review_reasons'))
    = 'currency=''EUR''::text,currency_source=''assumed''::text,needs_review=false,review_reasons=''{}''::text[]');
  PERFORM _fi_ok('shape: …and the others have no default: NULL says the row was written without them',
    NOT EXISTS (SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
                 WHERE d.adrelid = 'public.fahrtenbuch_trips'::regclass
                   AND a.attname IN ('start_at', 'end_at', 'time_zone', 'time_source', 'trip_status',
                                     'source_row_key', 'source_row_key_basis')));

  PERFORM _fi_ok('shape: the six trip checks exist',
    (SELECT count(*) = 6 FROM pg_constraint
      WHERE conrelid = 'public.fahrtenbuch_trips'::regclass AND contype = 'c'
        AND conname IN ('fahrtenbuch_trips_time_source_check', 'fahrtenbuch_trips_times_consistent',
                        'fahrtenbuch_trips_trip_status_check', 'fahrtenbuch_trips_review_check',
                        'fahrtenbuch_trips_currency_check', 'fahrtenbuch_trips_source_row_key_check')));

  PERFORM _fi_ok('shape: one file per company — a unique constraint on (company_id, file_sha256)',
    (SELECT pg_get_constraintdef(oid) = 'UNIQUE (company_id, file_sha256)'
       FROM pg_constraint
      WHERE conrelid = 'public.fahrtenbuch_imports'::regclass
        AND conname = 'fahrtenbuch_imports_company_file_sha256_key'));

  PERFORM _fi_ok('shape: one ride per company — a partial unique index on (company_id, source_row_key)',
    (SELECT i.indisunique
            AND pg_get_indexdef(i.indexrelid) ~ '\(company_id, source_row_key\) WHERE \(source_row_key IS NOT NULL\)'
       FROM pg_index i
      WHERE i.indexrelid = 'public.fahrtenbuch_trips_company_source_row_key'::regclass));

  PERFORM _fi_ok('shape: the immutability trigger is still attached, BEFORE UPDATE, per row',
    EXISTS (SELECT 1 FROM pg_trigger g
             WHERE g.tgrelid = 'public.fahrtenbuch_trips'::regclass
               AND g.tgname = 'tg_protect_fahrtenbuch_immutable'
               AND g.tgfoid = 'public.protect_fahrtenbuch_immutable_fields()'::regprocedure
               AND NOT g.tgisinternal AND g.tgenabled <> 'D'));

  PERFORM _fi_ok('shape: the fingerprint trigger fires on every update of an import',
    EXISTS (SELECT 1 FROM pg_trigger g
             WHERE g.tgrelid = 'public.fahrtenbuch_imports'::regclass
               AND g.tgname = 'fahrtenbuch_imports_keep_file_sha256'
               AND g.tgfoid = 'app_private.fahrtenbuch_imports_keep_file_sha256()'::regprocedure
               AND cardinality(g.tgattr::int2[]) = 0 AND NOT g.tgisinternal));

  PERFORM _fi_ok('shape: the restated trigger function is still SECURITY INVOKER',
    NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.protect_fahrtenbuch_immutable_fields()'::regprocedure));

  PERFORM _fi_ok('shape: fahrtenbuch_trips still has no UPDATE policy',
    NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'fahrtenbuch_trips' AND cmd = 'UPDATE'));

  PERFORM _fi_ok('shape: twelve fahrtenbuch helpers in app_private',
    (SELECT count(*) = 12 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app_private' AND p.proname LIKE 'fahrtenbuch\_%'));

  FOR v_fn IN
    SELECT p.oid, p.oid::regprocedure::text AS sig, p.prosecdef, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app_private' AND p.proname LIKE 'fahrtenbuch\_%'
  LOOP
    PERFORM _fi_ok(format('shape: %s is SECURITY INVOKER with a pinned search_path', v_fn.sig),
      NOT v_fn.prosecdef
      AND EXISTS (SELECT 1 FROM unnest(v_fn.proconfig) AS c(setting) WHERE c.setting LIKE 'search_path=%'));
    PERFORM _fi_ok(format('shape: no API role may execute %s', v_fn.sig),
      NOT has_function_privilege('anon', v_fn.oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', v_fn.oid, 'EXECUTE')
      AND NOT has_function_privilege('service_role', v_fn.oid, 'EXECUTE'));
  END LOOP;

  PERFORM _fi_ok('shape: a company administrator is refused calling the derivation',
    _fi_do('a0000000-0000-4000-8000-000000000001',
           $q$SELECT (app_private.fahrtenbuch_trip_times('{}'::jsonb, NULL, NULL, NULL)).time_source$q$)
      LIKE 'ERR 42501%');
END $$;

-- ─── 2. immutable ───────────────────────────────────────────────────────────

DO $$
DECLARE
  c_message CONSTANT text := 'ERR P0001 fahrtenbuch_trips: immutable fields cannot be modified after insert.';
  -- 20260606035519's 21, then the eleven 20260922100000 adds.
  c_old CONSTANT text[] := ARRAY[
    'trip_date', 'start_time', 'end_time', 'duration_minutes', 'car_id', 'car_identifier',
    'route_start', 'route_end', 'description', 'price_amount', 'cash_amount', 'online_amount',
    'tip_amount', 'action_amount', 'raw_data_json', 'original_driver_id', 'original_driver_name',
    'import_id', 'company_id', 'source_status', 'is_canceled'];
  c_new CONSTANT text[] := ARRAY[
    'start_at', 'end_at', 'time_zone', 'time_source', 'trip_status', 'needs_review',
    'review_reasons', 'currency', 'currency_source', 'source_row_key', 'source_row_key_basis'];
  c_trip CONSTANT uuid := 'f1000000-0000-4000-8000-0000000000a1';
  v_col text;
  v_out text;
BEGIN
  FOREACH v_col IN ARRAY c_old || c_new LOOP
    v_out := _fi_do(NULL, format('UPDATE fahrtenbuch_trips SET %I = %s WHERE id = %L RETURNING ''changed''',
                                 v_col, _fi_changed_value('public.fahrtenbuch_trips', v_col), c_trip));
    PERFORM _fi_ok(format('immutable: %s %s is refused, even for the table''s owner',
                          CASE WHEN v_col = ANY (c_new) THEN 'new' ELSE 'carried' END, v_col),
      v_out = c_message);
  END LOOP;

  PERFORM _fi_ok('immutable: an assignment column still changes, and updated_at follows',
    _fi_do(NULL, format($q$UPDATE fahrtenbuch_trips SET assignment_note = 'fi', updated_at = '2000-01-01'
                           WHERE id = %L RETURNING (updated_at = now())::text$q$, c_trip)) = 'true');

  -- No policy: the row is invisible to the UPDATE (or the privilege is
  -- missing); either way nothing changes.
  v_out := _fi_do('a0000000-0000-4000-8000-000000000001',
                  format($q$UPDATE fahrtenbuch_trips SET start_at = now() WHERE id = %L RETURNING 'changed'$q$, c_trip));
  PERFORM _fi_ok(format('immutable: a company administrator has no UPDATE path at all (%s)', v_out),
    v_out = '<null>' OR v_out LIKE 'ERR 42501%');

  PERFORM _fi_ok('immutable: reassign_fahrtenbuch_trip still writes the assignment of a trip with the new columns',
    _fi_do('a0000000-0000-4000-8000-000000000001',
           format($q$SELECT (reassign_fahrtenbuch_trip(%L, 'd0000000-0000-4000-8000-00000000000a', 'Driver A', 'pending', 'fi', 'fi') ->> 'success')$q$, c_trip))
      = 'true');
  PERFORM _fi_ok('immutable: …and changed none of them',
    (SELECT start_at = '2026-08-01 08:05:31+00' AND time_source = 'source_start_end' AND trip_status = 'completed'
            AND source_row_key = repeat('a', 64) AND currency = 'EUR' AND assigned_driver_name = 'Driver A'
       FROM fahrtenbuch_trips WHERE id = c_trip));

  PERFORM _fi_ok('immutable: an import''s file_sha256 is refused, even for the table''s owner',
    _fi_do(NULL, $q$UPDATE fahrtenbuch_imports SET file_sha256 = repeat('2', 64)
                    WHERE id = 'f1000000-0000-4000-8000-000000000001' RETURNING 'changed'$q$)
      = 'ERR P0001 fahrtenbuch_imports: file_sha256 cannot be modified after insert.');
  PERFORM _fi_ok('immutable: …and for the company''s administrator, who may update the import otherwise',
    _fi_do('a0000000-0000-4000-8000-000000000001',
           $q$UPDATE fahrtenbuch_imports SET file_sha256 = NULL
               WHERE id = 'f1000000-0000-4000-8000-000000000001' RETURNING 'changed'$q$)
      = 'ERR P0001 fahrtenbuch_imports: file_sha256 cannot be modified after insert.');
  PERFORM _fi_ok('immutable: the administrator still edits the import''s notes',
    _fi_do('a0000000-0000-4000-8000-000000000001',
           $q$UPDATE fahrtenbuch_imports SET notes = 'fi'
               WHERE id = 'f1000000-0000-4000-8000-000000000001' RETURNING 'changed'$q$)
      = 'changed');
END $$;

-- ─── 3. the same file ───────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _fi_ok('same file: a second import of the same file into the same company is refused',
    _fi_do('a0000000-0000-4000-8000-000000000001',
           $q$INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by, file_sha256)
              VALUES ('c0000000-0000-4000-8000-00000000000a', 8, 2026, 'renamed.xlsx',
                      'a0000000-0000-4000-8000-000000000001', repeat('1', 64)) RETURNING 'ok'$q$)
      LIKE 'ERR 23505 %fahrtenbuch_imports_company_file_sha256_key%');

  PERFORM _fi_ok('same file: another company imports the same bytes',
    _fi_do('b0000000-0000-4000-8000-000000000001',
           $q$INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by, file_sha256)
              VALUES ('f1000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000b', 8, 2026,
                      'fi-b.xlsx', 'b0000000-0000-4000-8000-000000000001', repeat('1', 64)) RETURNING 'ok'$q$)
      = 'ok');

  PERFORM _fi_ok('same file: imports without a hash — every one before this migration — never collide',
    _fi_do('a0000000-0000-4000-8000-000000000001',
           $q$INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by)
              SELECT 'c0000000-0000-4000-8000-00000000000a', 8, 2026, 'old-' || g, 'a0000000-0000-4000-8000-000000000001'
                FROM generate_series(1, 2) g RETURNING 'ok'$q$)
      = 'ok');

  PERFORM _fi_ok('same file: a hash that is not 64 lowercase hex digits is refused',
    _fi_do('a0000000-0000-4000-8000-000000000001',
           $q$INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by, file_sha256)
              VALUES ('c0000000-0000-4000-8000-00000000000a', 8, 2026, 'x', 'a0000000-0000-4000-8000-000000000001',
                      repeat('A', 64)) RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_imports_file_sha256_check%');

  -- The importer asks this before uploading; it must answer for the caller's
  -- company only.
  PERFORM _fi_ok('same file: company B''s lookup by hash finds its own import and nothing of A''s',
    _fi_do('b0000000-0000-4000-8000-000000000001',
           $q$SELECT string_agg(file_name, ',') FROM fahrtenbuch_imports WHERE file_sha256 = repeat('1', 64)$q$)
      = 'fi-b.xlsx');
END $$;

-- ─── 4. the same ride ───────────────────────────────────────────────────────

INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by, file_sha256)
VALUES ('f1000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-00000000000a', 8, 2026,
        'fi-a-second.xlsx', 'a0000000-0000-4000-8000-000000000001', repeat('3', 64));

DO $$
BEGIN
  PERFORM _fi_ok('same ride: a second file of the company carrying the same ride is refused',
    _fi_do('a0000000-0000-4000-8000-000000000001',
           $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name,
                                             source_row_key, source_row_key_basis)
              VALUES ('c0000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000003', '2026-08-01',
                      'Fahrer Eins', 'Fahrer Eins', repeat('a', 64), 'derived_order_transmission') RETURNING 'ok'$q$)
      LIKE 'ERR 23505 %fahrtenbuch_trips_company_source_row_key%');

  PERFORM _fi_ok('same ride: another company stores a ride with the same key',
    _fi_do('b0000000-0000-4000-8000-000000000001',
           $q$INSERT INTO fahrtenbuch_trips (id, company_id, import_id, trip_date, original_driver_name, assigned_driver_name,
                                             source_row_key, source_row_key_basis)
              VALUES ('f1000000-0000-4000-8000-0000000000b1', 'c0000000-0000-4000-8000-00000000000b',
                      'f1000000-0000-4000-8000-000000000002', '2026-08-01', 'Fahrer B', 'Fahrer B',
                      repeat('a', 64), 'derived_order_transmission') RETURNING 'ok'$q$)
      = 'ok');

  PERFORM _fi_ok('same ride: rows without a key never collide',
    _fi_do('a0000000-0000-4000-8000-000000000001',
           $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name)
              SELECT 'c0000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000003', '2026-08-01', 'K', 'K'
                FROM generate_series(1, 2) RETURNING 'ok'$q$)
      = 'ok');

  PERFORM _fi_ok('same ride: a key needs its basis, and a basis needs its key',
    _fi_do('a0000000-0000-4000-8000-000000000001',
           $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name, source_row_key)
              VALUES ('c0000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000003', '2026-08-01', 'K', 'K',
                      repeat('c', 64)) RETURNING 'ok'$q$) LIKE 'ERR 23514 %fahrtenbuch_trips_source_row_key_check%'
    AND _fi_do('a0000000-0000-4000-8000-000000000001',
           $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name, source_row_key_basis)
              VALUES ('c0000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000003', '2026-08-01', 'K', 'K',
                      'derived_driver_start_plate') RETURNING 'ok'$q$) LIKE 'ERR 23514 %fahrtenbuch_trips_source_row_key_check%');

  PERFORM _fi_ok('same ride: a key that is not a SHA-256 in hex is refused',
    _fi_do('a0000000-0000-4000-8000-000000000001',
           $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name,
                                             source_row_key, source_row_key_basis)
              VALUES ('c0000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000003', '2026-08-01', 'K', 'K',
                      'fahrer-eins-2026-08-01', 'derived_driver_start_plate') RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_trips_source_row_key_check%');

  -- The importer asks which of its keys are stored; the answer is the caller's company's.
  PERFORM _fi_ok('same ride: company B''s lookup by key finds its own ride and nothing of A''s',
    _fi_do('b0000000-0000-4000-8000-000000000001',
           $q$SELECT string_agg(company_id::text, ',') FROM fahrtenbuch_trips WHERE source_row_key = repeat('a', 64)$q$)
      = 'c0000000-0000-4000-8000-00000000000b');

  PERFORM _fi_ok('same ride: company B deletes its import…',
    _fi_do('b0000000-0000-4000-8000-000000000001',
           $q$DELETE FROM fahrtenbuch_imports WHERE id = 'f1000000-0000-4000-8000-000000000002' RETURNING 'ok'$q$) = 'ok');
  -- A separate statement: one that also called the DELETE would read the
  -- table as it was when that statement began.
  PERFORM _fi_ok('same ride: …which takes its rides and frees their keys for a corrected file',
    NOT EXISTS (SELECT 1 FROM fahrtenbuch_trips WHERE source_row_key = repeat('a', 64)
                                                  AND company_id = 'c0000000-0000-4000-8000-00000000000b'));
END $$;

-- ─── 5. checks ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_head CONSTANT text := $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name, $q$;
  c_vals CONSTANT text := $q$'c0000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000003', '2026-08-01', 'K', 'K', $q$;
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _fi_ok('checks: a cancelled status on a ride that is not cancelled is refused',
    _fi_do(c_admin, c_head || 'trip_status, is_canceled) VALUES (' || c_vals || $q$'cancelled', false) RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_trips_trip_status_check%');
  PERFORM _fi_ok('checks: an unknown status on a cancelled ride is refused — unknown is neither',
    _fi_do(c_admin, c_head || 'trip_status, is_canceled) VALUES (' || c_vals || $q$'unknown', true) RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_trips_trip_status_check%');
  PERFORM _fi_ok('checks: a status outside the three is refused',
    _fi_do(c_admin, c_head || 'trip_status) VALUES (' || c_vals || $q$'abgeschlossen') RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_trips_trip_status_check%');

  PERFORM _fi_ok('checks: needs_review without a reason is refused',
    _fi_do(c_admin, c_head || 'needs_review) VALUES (' || c_vals || $q$true) RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_trips_review_check%');
  PERFORM _fi_ok('checks: a reason without needs_review is refused',
    _fi_do(c_admin, c_head || 'review_reasons) VALUES (' || c_vals || $q$'{missing_end}') RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_trips_review_check%');
  PERFORM _fi_ok('checks: a reason the parser does not write is refused',
    _fi_do(c_admin, c_head || 'needs_review, review_reasons) VALUES (' || c_vals || $q$true, '{looks_odd}') RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_trips_review_check%');

  PERFORM _fi_ok('checks: an instant with a source that says it was not read is refused',
    _fi_do(c_admin, c_head || 'start_at, end_at, time_zone, time_source) VALUES (' || c_vals
                    || $q$now(), now(), 'Europe/Berlin', 'missing') RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_trips_times_consistent%');
  -- A NULL term would let a CHECK pass; the first draft of both checks had one.
  PERFORM _fi_ok('checks: instants with no time_source at all are refused',
    _fi_do(c_admin, c_head || 'start_at, end_at, time_zone) VALUES (' || c_vals
                    || $q$now(), now(), 'Europe/Berlin') RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_trips_times_consistent%');
  PERFORM _fi_ok('checks: a start without an end is refused',
    _fi_do(c_admin, c_head || 'start_at, time_zone, time_source) VALUES (' || c_vals
                    || $q$now(), 'Europe/Berlin', 'source_start_end') RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_trips_times_consistent%');
  PERFORM _fi_ok('checks: instants without their zone are refused',
    _fi_do(c_admin, c_head || 'start_at, end_at, time_source) VALUES (' || c_vals
                    || $q$now(), now(), 'source_start_end') RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_trips_times_consistent%');
  PERFORM _fi_ok('checks: a read source with no instants is refused',
    _fi_do(c_admin, c_head || 'time_source) VALUES (' || c_vals || $q$'source_start_end') RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_trips_times_consistent%');
  PERFORM _fi_ok('checks: a time source outside the five is refused',
    _fi_do(c_admin, c_head || 'time_source) VALUES (' || c_vals || $q$'guessed') RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_trips_time_source_check%');

  PERFORM _fi_ok('checks: a currency that is not three capitals is refused',
    _fi_do(c_admin, c_head || 'currency) VALUES (' || c_vals || $q$'eur') RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_trips_currency_check%');
  PERFORM _fi_ok('checks: a currency source outside assumed/source is refused',
    _fi_do(c_admin, c_head || 'currency_source) VALUES (' || c_vals || $q$'guessed') RETURNING 'ok'$q$)
      LIKE 'ERR 23514 %fahrtenbuch_trips_currency_check%');

  PERFORM _fi_ok('checks: a row the previous release would write (none of the new columns) still goes in',
    _fi_do(c_admin, $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, start_time, end_time, duration_minutes,
                                                      original_driver_name, assigned_driver_name, is_canceled, source_status)
                       VALUES ('c0000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000003', '2026-08-01',
                               '10:00', '10:30', 30, 'Alt', 'Alt', false, 'abgeschlossen')
                       RETURNING concat_ws(',', currency, currency_source, needs_review, coalesce(time_source, 'null'),
                                           coalesce(trip_status, 'null'), coalesce(source_row_key, 'null'))$q$)
      = 'EUR,assumed,f,null,null,null');
  PERFORM _fi_ok('checks: a row as this release writes it goes in',
    _fi_do(c_admin, c_head || $q$start_at, end_at, time_zone, time_source, trip_status, is_canceled, needs_review,
                                  review_reasons, source_row_key, source_row_key_basis) VALUES ($q$ || c_vals
                    || $q$'2026-08-01 22:05:31+00', '2026-08-01 22:19:10+00', 'Europe/Berlin', 'source_start_end', 'unknown',
                          false, true, '{missing_driver,unknown_status}', repeat('d', 64), 'derived_driver_start_plate')
                          RETURNING 'ok'$q$)
      = 'ok');
END $$;

-- ─── 6. derivation ──────────────────────────────────────────────────────────

DO $$
DECLARE
  v_zone text := current_setting('TimeZone');
  v      record;
BEGIN
  PERFORM _fi_ok('derive: an Uber ride — Europe/Berlin summer time, seconds kept',
    _fi_times(_fi_raw('2026-08-01 10:05:31.000', '2026-08-01 10:19:02.000'), '2026-08-01', '10:05', '10:19')
      = 'source_start_end|2026-08-01T08:05:31Z|2026-08-01T08:19:02Z|Europe/Berlin');
  PERFORM _fi_ok('derive: a ride across midnight ends on the next day',
    _fi_times(_fi_raw('2026-08-14 23:50:10.000', '2026-08-15 00:09:45.000'), '2026-08-14', '23:50', '00:09')
      = 'source_start_end|2026-08-14T21:50:10Z|2026-08-14T22:09:45Z|Europe/Berlin');
  -- The 22 rides of August 2026: "Datum der Fahrt" one day before the start.
  PERFORM _fi_ok('derive: a ride dated the day before its start begins on the start''s day',
    _fi_times(_fi_raw('2026-08-02 00:05:31.000', '2026-08-02 00:19:10.000'), '2026-08-01', '00:05', '00:19')
      = 'source_start_end|2026-08-01T22:05:31Z|2026-08-01T22:19:10Z|Europe/Berlin'
    AND ((SELECT start_at FROM app_private.fahrtenbuch_trip_times(
            _fi_raw('2026-08-02 00:05:31.000', '2026-08-02 00:19:10.000'), '2026-08-01', '00:05', '00:19'))
         AT TIME ZONE 'Europe/Berlin')::date = DATE '2026-08-02');

  PERFORM _fi_ok('derive: \N in both cells is missing, and nothing is set',
    _fi_times(_fi_raw('\N', '\N'), '2026-08-01', NULL, NULL) = 'missing|-|-|-');
  PERFORM _fi_ok('derive: a start with no end is missing — an interval needs both',
    _fi_times(_fi_raw('2026-08-01 10:05:31.000', '\N'), '2026-08-01', '10:05', NULL) = 'missing|-|-|-');

  PERFORM _fi_ok('derive: 29.03.2026 02:30 never happened in Berlin — ambiguous, left NULL',
    _fi_times(_fi_raw('2026-03-29 02:30:00.000', '2026-03-29 03:10:00.000'), '2026-03-29', '02:30', '03:10')
      = 'ambiguous|-|-|-');
  SELECT * INTO v FROM app_private.fahrtenbuch_trip_times(
    _fi_raw('2026-03-29 01:50:00.000', '2026-03-29 03:10:00.000'), '2026-03-29', '01:50', '03:10');
  PERFORM _fi_ok('derive: a ride across the March gap lasts the 20 minutes the clock skipped over',
    v.time_source = 'source_start_end' AND v.end_at - v.start_at = interval '20 minutes'
    AND v.start_at = '2026-03-29 00:50:00+00');

  PERFORM _fi_ok('derive: 25.10.2026 02:30 happened twice in Berlin — ambiguous, left NULL',
    _fi_times(_fi_raw('2026-10-25 02:30:00.000', '2026-10-25 02:45:00.000'), '2026-10-25', '02:30', '02:45')
      = 'ambiguous|-|-|-');
  PERFORM _fi_ok('derive: the hours either side of the October repeat are read without doubt',
    _fi_times(_fi_raw('2026-10-25 01:59:59.000', '2026-10-25 03:00:00.000'), '2026-10-25', '01:59', '03:00')
      = 'source_start_end|2026-10-24T23:59:59Z|2026-10-25T02:00:00Z|Europe/Berlin');
  PERFORM _fi_ok('derive: the instant helper counts two candidates in October, none in March, one otherwise',
    (SELECT candidates FROM app_private.fahrtenbuch_wall_to_instant('2026-10-25 02:30', 'Europe/Berlin')) = 2
    AND (SELECT candidates FROM app_private.fahrtenbuch_wall_to_instant('2026-03-29 02:30', 'Europe/Berlin')) = 0
    AND (SELECT candidates FROM app_private.fahrtenbuch_wall_to_instant('2026-08-01 10:00', 'Europe/Berlin')) = 1);

  PERFORM _fi_ok('derive: time-of-day cells fall back to trip_date + HH:MM',
    _fi_times('{"Uhrzeit des Fahrtbeginns": "10:05", "Uhrzeit des Fahrtendes": "10:30"}', '2026-08-03', '10:05', '10:30')
      = 'fallback_trip_date|2026-08-03T08:05:00Z|2026-08-03T08:30:00Z|Europe/Berlin');
  PERFORM _fi_ok('derive: …with the end on the next day when it is earlier',
    _fi_times('{"Uhrzeit des Fahrtbeginns": "23:50", "Uhrzeit des Fahrtendes": "00:10"}', '2026-08-03', '23:50', '00:10')
      = 'fallback_trip_date|2026-08-03T21:50:00Z|2026-08-03T22:10:00Z|Europe/Berlin');
  -- The end moves a day on the wall clock and is read in that day's offset;
  -- no fixed 24 hours is added to an instant, which is wrong on the DST nights.
  PERFORM _fi_ok('derive: …across midnight into the October change, 23:50 CEST to 03:10 CET is 4 h 20 min',
    _fi_times('{"Uhrzeit des Fahrtbeginns": "23:50", "Uhrzeit des Fahrtendes": "03:10"}', '2026-10-24', '23:50', '03:10')
      = 'fallback_trip_date|2026-10-24T21:50:00Z|2026-10-25T02:10:00Z|Europe/Berlin');
  PERFORM _fi_ok('derive: …an end equal to the start is not 24 hours later',
    _fi_times('{"Uhrzeit des Fahrtbeginns": "10:05", "Uhrzeit des Fahrtendes": "10:05"}', '2026-08-03', '10:05', '10:05')
      = 'fallback_trip_date|2026-08-03T08:05:00Z|2026-08-03T08:05:00Z|Europe/Berlin');
  PERFORM _fi_ok('derive: …and a fallback in the repeated hour is ambiguous too',
    _fi_times('{"Uhrzeit des Fahrtbeginns": "02:30", "Uhrzeit des Fahrtendes": "02:50"}', '2026-10-25', '02:30', '02:50')
      = 'ambiguous|-|-|-');
  PERFORM _fi_ok('derive: no start or end column at all falls back to the stored columns',
    _fi_times('{"Kennzeichen": "X-TS 101"}', '2026-08-03', '10:05', '10:30')
      = 'fallback_trip_date|2026-08-03T08:05:00Z|2026-08-03T08:30:00Z|Europe/Berlin');

  PERFORM _fi_ok('derive: one dated cell and one without are not combined — unparsed',
    _fi_times(_fi_raw('2026-08-03 10:05:00', '10:30'), '2026-08-03', '10:05', '10:30') = 'unparsed|-|-|-');
  PERFORM _fi_ok('derive: text that is not a timestamp is unparsed, never guessed from trip_date',
    _fi_times(_fi_raw('kaputt', '2026-08-01 10:19:02.000'), '2026-08-01', '10:05', '10:19') = 'unparsed|-|-|-');
  PERFORM _fi_ok('derive: a day the calendar does not have is unparsed',
    _fi_times(_fi_raw('2026-02-30 10:00:00.000', '2026-02-30 10:20:00.000'), '2026-02-28', '10:00', '10:20') = 'unparsed|-|-|-');
  PERFORM _fi_ok('derive: a timestamp with a zone is not what the files hold — unparsed',
    _fi_times(_fi_raw('2026-08-01T10:05:31Z', '2026-08-01T10:19:02Z'), '2026-08-01', '10:05', '10:19') = 'unparsed|-|-|-');
  PERFORM _fi_ok('derive: 24:00 as a clock time is not a timestamp',
    _fi_times(_fi_raw('2026-08-01 24:00:00', '2026-08-02 00:10:00'), '2026-08-01', '24:00', '00:10') = 'unparsed|-|-|-');

  PERFORM _fi_ok('derive: an Excel date-and-time serial is read to the second',
    _fi_times('{"Uhrzeit des Fahrtbeginns": 46235.5, "Uhrzeit des Fahrtendes": 46235.51041666667}', '2026-08-01', '12:00', '12:15')
      = 'source_start_end|2026-08-01T10:00:00Z|2026-08-01T10:15:00Z|Europe/Berlin');
  PERFORM _fi_ok('derive: a whole-number serial is a date without a time — unparsed',
    _fi_times('{"Uhrzeit des Fahrtbeginns": 46235, "Uhrzeit des Fahrtendes": 46235}', '2026-08-01', '00:00', '00:00') = 'unparsed|-|-|-');
  PERFORM _fi_ok('derive: an Excel time fraction carries no date and falls back',
    _fi_times('{"Uhrzeit des Fahrtbeginns": 0.5, "Uhrzeit des Fahrtendes": 0.5104166666666666}', '2026-08-01', '12:00', '12:15')
      = 'fallback_trip_date|2026-08-01T10:00:00Z|2026-08-01T10:15:00Z|Europe/Berlin');

  PERFORM _fi_ok('derive: the order-transmission column is never read as the start',
    _fi_times('{"Uhrzeit der Auftragsuebermittlung": "2026-08-01 09:58:00.000", "Datum/Uhrzeit Auftragseingang": "2026-08-01 09:57:00.000"}',
              '2026-08-01', NULL, NULL) = 'missing|-|-|-');
  PERFORM _fi_ok('derive: a start column whose name holds Auftrag is skipped for the next match',
    _fi_times('{"Fahrtbeginn laut Auftrag": "2026-08-01 09:00:00.000", "Fahrtbeginn": "2026-08-01 10:05:31.000", "Fahrtende": "2026-08-01 10:19:02.000"}',
              '2026-08-01', '10:05', '10:19')
      = 'source_start_end|2026-08-01T08:05:31Z|2026-08-01T08:19:02Z|Europe/Berlin');
  -- "…(Plan)" contains the first token, "Fahrtbeginn" equals the fourth: every
  -- token is tried exactly before any is tried as a substring.
  PERFORM _fi_ok('derive: an exact header match wins over one that merely contains an earlier token',
    _fi_times('{"Uhrzeit des Fahrtbeginns (Plan)": "2026-08-01 09:00:00.000", "Fahrtbeginn": "2026-08-01 10:05:31.000", "Fahrtende": "2026-08-01 10:19:02.000"}',
              '2026-08-01', '10:05', '10:19')
      = 'source_start_end|2026-08-01T08:05:31Z|2026-08-01T08:19:02Z|Europe/Berlin');
  PERFORM _fi_ok('derive: the German spelling D.M.YYYY H:MM is read, day first',
    _fi_times(_fi_raw('01.08.2026 10:05', '1.8.2026 10:19:02'), '2026-08-01', '10:05', '10:19')
      = 'source_start_end|2026-08-01T08:05:00Z|2026-08-01T08:19:02Z|Europe/Berlin');
  PERFORM _fi_ok('derive: a start column that is there but null stops the search — missing, not the next column',
    _fi_times('{"Uhrzeit des Fahrtbeginns": null, "Fahrtbeginn": "2026-08-01 10:05:31.000", "Uhrzeit des Fahrtendes": "2026-08-01 10:19:02.000"}',
              '2026-08-01', NULL, '10:19') = 'missing|-|-|-');

  PERFORM _fi_ok('derive: the cell reader classifies each shape',
    (SELECT kind FROM app_private.fahrtenbuch_cell_wall(NULL)) = 'empty'
    AND (SELECT kind FROM app_private.fahrtenbuch_cell_wall('null')) = 'empty'
    AND (SELECT kind FROM app_private.fahrtenbuch_cell_wall('" \\N "')) = 'empty'
    AND (SELECT kind FROM app_private.fahrtenbuch_cell_wall('""')) = 'empty'
    AND (SELECT kind FROM app_private.fahrtenbuch_cell_wall('"10:05"')) = 'time'
    AND (SELECT kind FROM app_private.fahrtenbuch_cell_wall('"2026-08-01 10:05"')) = 'datetime'
    AND (SELECT kind FROM app_private.fahrtenbuch_cell_wall('true')) = 'other'
    AND (SELECT kind FROM app_private.fahrtenbuch_cell_wall('-1')) = 'other'
    AND (SELECT kind FROM app_private.fahrtenbuch_cell_wall('"١٠:٠٥"')) = 'other');

  -- The session's zone does not move an instant.
  PERFORM set_config('TimeZone', 'America/New_York', true);
  PERFORM _fi_ok('derive: the answer does not depend on the session''s TimeZone',
    _fi_times(_fi_raw('2026-08-01 10:05:31.000', '2026-08-01 10:19:02.000'), '2026-08-01', '10:05', '10:19')
      = 'source_start_end|2026-08-01T08:05:31Z|2026-08-01T08:19:02Z|Europe/Berlin'
    AND _fi_times(_fi_raw('2026-10-25 02:30:00.000', '2026-10-25 02:45:00.000'), '2026-10-25', '02:30', '02:45')
      = 'ambiguous|-|-|-');
  PERFORM set_config('TimeZone', v_zone, true);

  PERFORM _fi_ok('derive: status — is_canceled wins, then only abgeschlossen is completed',
    app_private.fahrtenbuch_trip_status_of(true, 'Storno') = 'cancelled'
    AND app_private.fahrtenbuch_trip_status_of(false, ' Abgeschlossen ') = 'completed'
    AND app_private.fahrtenbuch_trip_status_of(false, 'unterwegs') = 'unknown'
    AND app_private.fahrtenbuch_trip_status_of(false, NULL) = 'unknown');

  PERFORM _fi_ok('derive: review reasons for a stored row, in the parser''s order',
    app_private.fahrtenbuch_backfill_review_reasons(false, NULL, NULL, '', 'unknown', 'missing', NULL, NULL)
      = ARRAY['missing_start', 'missing_end', 'missing_driver', 'unknown_status']
    AND app_private.fahrtenbuch_backfill_review_reasons(true, NULL, NULL, 'Unbekannt', 'cancelled', 'missing', NULL, NULL)
      = ARRAY['missing_driver']
    AND app_private.fahrtenbuch_backfill_review_reasons(false, '10:00', '10:05', 'Unbekannt', 'completed', 'source_start_end',
                                                        '2026-08-01 10:00+00', '2026-08-01 09:00+00')
      = ARRAY['end_before_start']
    AND app_private.fahrtenbuch_backfill_review_reasons(false, '10:00', '10:05', 'Fahrer', 'completed', 'source_start_end',
                                                        '2026-08-01 10:00+00', '2026-08-01 10:05+00')
      = '{}'::text[]);
END $$;

-- ─── 7. the backfill ────────────────────────────────────────────────────────

/*
  Rows shaped as the previous release stored them: every new column at its
  default or NULL. The backfill runs under the trigger as it stood before this
  migration (20260606035519's body, which tests/fixtures/schema.sql carries) —
  the state the migration runs it in — and the restated body is put back after.
*/
CREATE TEMP TABLE _fi_saved ON COMMIT DROP AS
SELECT pg_get_functiondef('public.protect_fahrtenbuch_immutable_fields()'::regprocedure) AS def;

INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by)
VALUES ('f1000000-0000-4000-8000-000000000007', 'c0000000-0000-4000-8000-00000000000a', 3, 2026,
        'fi-old.xlsx', 'a0000000-0000-4000-8000-000000000001');

-- updated_at is set in the past, so the check below can see the trigger move it.
INSERT INTO fahrtenbuch_trips (id, company_id, import_id, trip_date, start_time, end_time, duration_minutes,
                               original_driver_name, assigned_driver_name, raw_data_json, source_status,
                               is_canceled, plausibility_status, updated_at)
SELECT v.id::uuid, 'c0000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000007',
       v.trip_date::date, v.st::time, v.et::time, v.dur, v.driver, v.driver, v.raw::jsonb, v.status,
       v.cancelled, CASE WHEN v.cancelled THEN 'canceled' ELSE 'pending' END, '2000-01-01 00:00:00+00'
  FROM (VALUES
    -- 71: an Uber ride
    ('f1000000-0000-4000-8000-000000000071', '2026-08-01', '10:05', '10:19', 14, 'Fahrer Eins',
     '{"Uhrzeit der Auftragsuebermittlung": "2026-08-01 09:58:00.000", "Uhrzeit des Fahrtbeginns": "2026-08-01 10:05:31.000", "Uhrzeit des Fahrtendes": "2026-08-01 10:19:02.000"}',
     'abgeschlossen', false),
    -- 72: one of the 22 — dated the day before its start
    ('f1000000-0000-4000-8000-000000000072', '2026-08-01', '00:05', '00:19', 14, 'Fahrer Eins',
     '{"Uhrzeit des Fahrtbeginns": "2026-08-02 00:05:31.000", "Uhrzeit des Fahrtendes": "2026-08-02 00:19:10.000"}',
     'abgeschlossen', false),
    -- 73: a cancelled ride, \N clock, the old importer's "Unbekannt"
    ('f1000000-0000-4000-8000-000000000073', '2026-08-01', NULL, NULL, NULL, 'Unbekannt',
     '{"Uhrzeit des Fahrtbeginns": "\\N", "Uhrzeit des Fahrtendes": "\\N"}',
     'storniert', true),
    -- 74: a start that is no timestamp — resolveActualRideWindow would fall
    --     back to trip_date + HH:MM here; the backfill does not guess
    ('f1000000-0000-4000-8000-000000000074', '2026-08-01', '10:05', '10:19', 14, 'Fahrer Eins',
     '{"Uhrzeit des Fahrtbeginns": "gegen 10 Uhr", "Uhrzeit des Fahrtendes": "2026-08-01 10:19:02.000"}',
     'abgeschlossen', false),
    -- 75: the October repeat
    ('f1000000-0000-4000-8000-000000000075', '2026-10-25', '02:30', '02:45', 15, 'Fahrer Eins',
     '{"Uhrzeit des Fahrtbeginns": "2026-10-25 02:30:00.000", "Uhrzeit des Fahrtendes": "2026-10-25 02:45:00.000"}',
     'abgeschlossen', false),
    -- 76: a file with time-of-day columns and no status column
    ('f1000000-0000-4000-8000-000000000076', '2026-08-03', '23:50', '00:10', 20, 'Fahrer Zwei',
     '{"Startzeit": "23:50", "Endzeit": "00:10"}',
     NULL, false),
    -- 77: a synonym the old importer read as cancelled
    ('f1000000-0000-4000-8000-000000000077', '2026-08-01', NULL, NULL, NULL, 'Fahrer Zwei',
     '{}',
     'Storno', true),
    -- 78: an end before the start
    ('f1000000-0000-4000-8000-000000000078', '2026-08-01', '10:19', '10:05', 1426, 'Fahrer Zwei',
     '{"Uhrzeit des Fahrtbeginns": "2026-08-01 10:19:02.000", "Uhrzeit des Fahrtendes": "2026-08-01 10:05:31.000"}',
     'abgeschlossen', false)
  ) AS v(id, trip_date, st, et, dur, driver, raw, status, cancelled);

CREATE TEMP TABLE _fi_before ON COMMIT DROP AS
SELECT id, md5(row(trip_date, start_time, end_time, duration_minutes, car_id, car_identifier, route_start,
                   route_end, description, price_amount, cash_amount, online_amount, tip_amount, action_amount,
                   raw_data_json, original_driver_id, original_driver_name, import_id, company_id,
                   source_status, is_canceled, assigned_driver_id, assigned_driver_name,
                   plausibility_status)::text) AS fingerprint
  FROM fahrtenbuch_trips;

-- The trigger as it stood: 20260606035519, from tests/fixtures/schema.sql.
CREATE OR REPLACE FUNCTION public.protect_fahrtenbuch_immutable_fields() RETURNS trigger
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

CREATE TEMP TABLE _fi_backfill ON COMMIT DROP AS
SELECT (SELECT count(*) FROM fahrtenbuch_trips WHERE time_source IS NULL AND trip_status IS NULL) AS waiting,
       app_private.fahrtenbuch_trips_backfill_import_facts() AS counts;

DO $$ BEGIN EXECUTE (SELECT def FROM _fi_saved); END $$;

DO $$
DECLARE
  v_counts  jsonb := (SELECT counts FROM _fi_backfill);
  v_waiting bigint := (SELECT waiting FROM _fi_backfill);
  -- id suffix → expected 'time_source|start_at|end_at|zone', trip_status, review_reasons
  r record;
BEGIN
  RAISE NOTICE 'backfill counts: %', v_counts;

  PERFORM _fi_ok('backfill: every row without a time_source and a trip_status was filled, and only those',
    (v_counts ->> 'rows')::bigint = v_waiting AND v_waiting >= 8
    AND NOT EXISTS (SELECT 1 FROM fahrtenbuch_trips WHERE time_source IS NULL OR trip_status IS NULL));

  FOR r IN
    SELECT * FROM (VALUES
      ('71', 'source_start_end|2026-08-01T08:05:31Z|2026-08-01T08:19:02Z|Europe/Berlin', 'completed', '{}'::text[]),
      ('72', 'source_start_end|2026-08-01T22:05:31Z|2026-08-01T22:19:10Z|Europe/Berlin', 'completed', '{}'::text[]),
      ('73', 'missing|-|-|-',                                                            'cancelled', '{missing_driver}'::text[]),
      ('74', 'unparsed|-|-|-',                                                           'completed', '{}'::text[]),
      ('75', 'ambiguous|-|-|-',                                                          'completed', '{}'::text[]),
      ('76', 'fallback_trip_date|2026-08-03T21:50:00Z|2026-08-03T22:10:00Z|Europe/Berlin', 'unknown', '{unknown_status}'::text[]),
      ('77', 'missing|-|-|-',                                                            'cancelled', '{}'::text[]),
      ('78', 'source_start_end|2026-08-01T08:19:02Z|2026-08-01T08:05:31Z|Europe/Berlin', 'completed', '{end_before_start}'::text[])
    ) AS e(suffix, times, status, reasons)
  LOOP
    PERFORM _fi_ok(format('backfill: row %s — %s, %s, %s', r.suffix, r.times, r.status, r.reasons),
      (SELECT concat_ws('|', t.time_source,
                        coalesce(to_char(t.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '-'),
                        coalesce(to_char(t.end_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '-'),
                        coalesce(t.time_zone, '-')) = r.times
              AND t.trip_status = r.status
              AND t.review_reasons = r.reasons
              AND t.needs_review = (cardinality(r.reasons) > 0)
              AND t.source_row_key IS NULL AND t.source_row_key_basis IS NULL
              AND t.currency = 'EUR' AND t.currency_source = 'assumed'
         FROM fahrtenbuch_trips t
        WHERE t.id = ('f1000000-0000-4000-8000-0000000000' || r.suffix)::uuid));
  END LOOP;

  PERFORM _fi_ok('backfill: row 72 keeps trip_date 01.08 and starts on 02.08 in Berlin',
    (SELECT trip_date = DATE '2026-08-01' AND (start_at AT TIME ZONE 'Europe/Berlin')::date = DATE '2026-08-02'
       FROM fahrtenbuch_trips WHERE id = 'f1000000-0000-4000-8000-000000000072'));

  PERFORM _fi_ok('backfill: the counts it reports are the rows it wrote',
    (v_counts ->> 'source_start_end')::int >= 3 AND (v_counts ->> 'ambiguous')::int >= 1
    AND (v_counts ->> 'unparsed')::int >= 1 AND (v_counts ->> 'fallback_trip_date')::int >= 1
    AND (v_counts ->> 'missing')::int >= 2
    AND (v_counts ->> 'rows')::int = (v_counts ->> 'source_start_end')::int + (v_counts ->> 'fallback_trip_date')::int
                                   + (v_counts ->> 'missing')::int + (v_counts ->> 'unparsed')::int
                                   + (v_counts ->> 'ambiguous')::int
    AND (v_counts ->> 'rows')::int = (v_counts ->> 'completed')::int + (v_counts ->> 'cancelled')::int
                                   + (v_counts ->> 'unknown')::int);

  PERFORM _fi_ok('backfill: no column the planning, the Stundennachweis or the export reads moved',
    NOT EXISTS (
      SELECT 1 FROM fahrtenbuch_trips t JOIN _fi_before b ON b.id = t.id
       WHERE b.fingerprint <> md5(row(t.trip_date, t.start_time, t.end_time, t.duration_minutes, t.car_id,
                                      t.car_identifier, t.route_start, t.route_end, t.description, t.price_amount,
                                      t.cash_amount, t.online_amount, t.tip_amount, t.action_amount,
                                      t.raw_data_json, t.original_driver_id, t.original_driver_name, t.import_id,
                                      t.company_id, t.source_status, t.is_canceled, t.assigned_driver_id,
                                      t.assigned_driver_name, t.plausibility_status)::text)));

  PERFORM _fi_ok('backfill: updated_at is the backfill''s time, as the trigger sets it on every update',
    (SELECT bool_and(updated_at = now()) FROM fahrtenbuch_trips
      WHERE import_id = 'f1000000-0000-4000-8000-000000000007'));

  PERFORM _fi_ok('backfill: a second run finds nothing left to fill',
    (app_private.fahrtenbuch_trips_backfill_import_facts() ->> 'rows') = '0');

  PERFORM _fi_ok('backfill: the restated trigger is back in place',
    (SELECT pg_get_functiondef('public.protect_fahrtenbuch_immutable_fields()'::regprocedure)) = (SELECT def FROM _fi_saved));
END $$;

-- After the migration, the backfill can change nothing: filling a protected
-- column from NULL is a change. A row the previous release inserts after a
-- rollback keeps its NULLs.
DO $$
BEGIN
  INSERT INTO fahrtenbuch_trips (id, company_id, import_id, trip_date, original_driver_name, assigned_driver_name, raw_data_json)
  VALUES ('f1000000-0000-4000-8000-000000000079', 'c0000000-0000-4000-8000-00000000000a',
          'f1000000-0000-4000-8000-000000000007', '2026-08-01', 'Nach', 'Nach',
          '{"Uhrzeit des Fahrtbeginns": "2026-08-01 10:05:31.000", "Uhrzeit des Fahrtendes": "2026-08-01 10:19:02.000"}');

  PERFORM _fi_ok('backfill: after the restated trigger it is refused rather than filling a row',
    _fi_do(NULL, 'SELECT app_private.fahrtenbuch_trips_backfill_import_facts()::text')
      = 'ERR P0001 fahrtenbuch_trips: immutable fields cannot be modified after insert.'
    AND (SELECT time_source IS NULL AND trip_status IS NULL
           FROM fahrtenbuch_trips WHERE id = 'f1000000-0000-4000-8000-000000000079'));
END $$;

-- ─── 8. tenants ─────────────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _fi_ok('tenants: company B reads none of A''s trips, new columns included',
    _fi_do('b0000000-0000-4000-8000-000000000001',
           $q$SELECT count(*)::text FROM fahrtenbuch_trips
               WHERE company_id = 'c0000000-0000-4000-8000-00000000000a' OR start_at = '2026-08-01 08:05:31+00'$q$) = '0');

  PERFORM _fi_ok('tenants: A''s viewer reads A''s new columns',
    _fi_do('a0000000-0000-4000-8000-000000000003',
           $q$SELECT concat_ws(',', time_source, trip_status, currency)
                FROM fahrtenbuch_trips WHERE id = 'f1000000-0000-4000-8000-0000000000a1'$q$)
      = 'source_start_end,completed,EUR');

  PERFORM _fi_ok('tenants: A''s administrator cannot file a keyed ride into B',
    _fi_do('a0000000-0000-4000-8000-000000000001',
           $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name,
                                             source_row_key, source_row_key_basis)
              VALUES ('c0000000-0000-4000-8000-00000000000b', 'f1000000-0000-4000-8000-000000000003', '2026-08-01',
                      'X', 'X', repeat('e', 64), 'derived_driver_start_plate') RETURNING 'ok'$q$)
      LIKE 'ERR 42501%');

  PERFORM _fi_ok('tenants: A''s administrator cannot file a hashed import into B',
    _fi_do('a0000000-0000-4000-8000-000000000001',
           $q$INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by, file_sha256)
              VALUES ('c0000000-0000-4000-8000-00000000000b', 8, 2026, 'x', 'a0000000-0000-4000-8000-000000000001',
                      repeat('9', 64)) RETURNING 'ok'$q$)
      LIKE 'ERR 42501%');
END $$;

DO $$ BEGIN RAISE NOTICE '── fahrtenbuch import: all checks passed ──'; END $$;

ROLLBACK;
