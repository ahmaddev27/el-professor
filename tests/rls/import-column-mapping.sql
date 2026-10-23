/*
  The Fahrtenbuch import's remembered column mapping (migration 20261023210000).

  Runs after the files before it, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it see
  the database as the seeds left it.

  Every check is a BEHAVIOUR: a caller does something and the database answers.
  Nothing here reads the text of a policy, a trigger or a function — that is the
  migration's own self-check — so a rewrite that keeps the behaviour keeps this
  file green.

  What is covered, in order:

    1. access       row level security is on; anon is refused outright; the
                    service role holds nothing; authenticated may select,
                    insert, update and delete and nothing else
    2. tenants      a member reads its own company's mappings and never another
                    company's; nobody writes into another company or moves a row
                    there
    3. page gate    a viewer and an editor read a mapping and store none; the
                    supervisor and the administrator store one; the upsert the
                    wizard sends re-stamps the row of a shape rather than adding
                    a second
    4. state        a suspended company's administrator reads and writes nothing
    5. key          one mapping per company and shape; the same shape in two
                    companies is two mappings
    6. the rule     A STORED MAPPING CANNOT NAME A COLUMN THE FILE HAS NOT GOT.
                    The guard refuses a field_map value that is not one of the
                    row's own source_headers, on insert and on update, and the
                    measured staging case is the test: the 18-column DEMO
                    mapping stored against the 11-column DEMO header list
    7. bounds       a blank, over-long, repeated or over-long-joined header, an
                    unknown or missing field, a key that is not a SHA-256
    8. pins         company and shape are fixed once the row exists, and the
                    actor and the times are the database's, not the client's
    9. contexts     a view context reads the company it opened and writes
                    nothing with nothing recorded; a support session writes as
                    the company's administrator and each row leaves exactly one
                    audit row; a platform owner with no context reads and writes
                    nothing
   10. company      the mappings go with their company

  The matrix lines for the table are in tests/rls/matrix.sql (ord 80).

  EVERY CHECK HERE WAS MUTATION-CONTROLLED against the migration: the rule was
  broken, the kit was run, the printed failure was recorded in the PR body, and
  the rule was restored. The section ledger at the end exists because of the one
  way that discipline silently fails: a counter declared inside a block a raise
  rolls back reports "all N passed" while the rows that would have proved it are
  gone. `_icm_log` is a TEMP TABLE written at the top level of each DO block, and
  the last check asserts every one of the ten sections above actually wrote to
  it.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in support-write-audit.sql) ───────────────────────────

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS banned_until       timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at         timestamptz,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS auth.sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  not_after  timestamptz
);

-- ─── helpers ────────────────────────────────────────────────────────────────

/*
  The section ledger. A TEMP TABLE and not a plpgsql counter: a variable
  declared inside a DO block a raise rolls back loses its rows and the summary
  then reports a pass for checks that never ran.
*/
CREATE TEMP TABLE _icm_log (n bigserial PRIMARY KEY, section text NOT NULL, descr text NOT NULL);

CREATE OR REPLACE FUNCTION _icm_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_section text := split_part(p_desc, ':', 1);
BEGIN
  IF v_section = p_desc OR btrim(v_section) = '' THEN
    RAISE EXCEPTION 'FAIL (malformed check description, it must begin "<section>: "): %', p_desc;
  END IF;
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  INSERT INTO _icm_log (section, descr) VALUES (v_section, p_desc);
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _icm_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('icm:' || p_what)::uuid $$;

/** A lowercase 64-character hex string, which is the shape the key's CHECK wants. */
CREATE OR REPLACE FUNCTION _icm_key(p_what text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('icm:' || p_what) || md5('key:' || p_what) $$;

CREATE OR REPLACE FUNCTION _icm_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/* Become a signed-in caller with a password sign-in and, when given, the session a context is answered to; anon when p_user is NULL. */
CREATE OR REPLACE FUNCTION _icm_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _icm_reset();
  IF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  IF p_session IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.session_id', p_session::text, true);
  END IF;
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/*
  Run p_sql as that caller in a subtransaction that is always rolled back, and
  return the scalar it answered, `rows N` for a statement without a result, or
  `ERR <sqlstate> <hint, or the message when there is none>`.

  The HINT and not the message: every refusal this file is about carries a
  stable token (`import_mapping_value_not_a_header`, `support_session_required`)
  while its sentence is German prose that a reword would break. PostgreSQL's own
  refusals — row level security, a CHECK, a unique key — carry no hint, so those
  fall through to the message, which names the constraint.

  Nothing it writes survives, audit rows included.
*/
CREATE OR REPLACE FUNCTION _icm_try(p_user uuid, p_session uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
  v_hint  text;
BEGIN
  BEGIN
    PERFORM _icm_as(p_user, p_session);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ012', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ012' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_hint = PG_EXCEPTION_HINT;
      v_out := 'ERR ' || v_state || ' ' || coalesce(nullif(btrim(coalesce(v_hint, '')), ''), v_msg);
  END;
  PERFORM _icm_reset();
  RETURN v_out;
END $$;

/** The audit log's high-water mark, so each check counts only its own rows. */
CREATE OR REPLACE FUNCTION _icm_mark() RETURNS bigint
LANGUAGE sql AS $$ SELECT coalesce(max(l.id), 0) FROM app_private.platform_audit_log l $$;

/** Support-write rows after a mark, for one action or for all of them. */
CREATE OR REPLACE FUNCTION _icm_rows(p_since bigint, p_action text DEFAULT NULL) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*)
    FROM app_private.platform_audit_log l
   WHERE l.id > p_since
     AND l.action ~ '^support_write\.'
     AND (p_action IS NULL OR l.action = p_action)
$$;

-- ─── the two header shapes one staging company really holds ─────────────────
--
-- Measured read-only on staging on 23.10.2026 out of
-- fahrtenbuch_imports.source_columns_json. The narrow list is a STRICT SUBSET of
-- the wide one, every shared name identical, which is what makes section 6 a
-- real case rather than an invented one.

CREATE OR REPLACE FUNCTION _icm_wide() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[
  'Datum/Uhrzeit Auftragseingang', 'Uhrzeit der Auftragsuebermittlung',
  'Geplante Abholzeit', 'Datum der Fahrt', 'Fahrtstatus',
  'Standort des Fahrzeugs bei Auftragsuebermittlung',
  'Uhrzeit des Fahrtbeginns', 'Uhrzeit des Fahrtendes', 'Kennzeichen',
  'Fahrzeugtyp', 'Fahrername', 'Fahrpreis', 'Trinkgeld', 'Kilometer',
  'Zahlungsart', 'Abholort', 'Zielort', 'Vorreservierte Fahrt'] $$;

CREATE OR REPLACE FUNCTION _icm_narrow() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[
  'Datum der Fahrt', 'Uhrzeit des Fahrtbeginns', 'Uhrzeit des Fahrtendes',
  'Kennzeichen', 'Fahrername', 'Fahrpreis', 'Trinkgeld', 'Kilometer',
  'Fahrtstatus', 'Abholort', 'Zielort'] $$;

/** The eleven-field mapping an operator confirms on the wide file. */
CREATE OR REPLACE FUNCTION _icm_wide_map() RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_object(
  'trip_date', 'Datum der Fahrt',
  'start_time', 'Uhrzeit des Fahrtbeginns',
  'end_time', 'Uhrzeit des Fahrtendes',
  'driver_name', 'Fahrername',
  'car_identifier', 'Kennzeichen',
  'price_amount', 'Fahrpreis',
  'tip_amount', 'Trinkgeld',
  'payment_method', 'Zahlungsart',
  'route_start', 'Abholort',
  'route_end', 'Zielort',
  'description', 'Fahrzeugtyp') $$;

/** The four required fields alone, all present in both shapes. */
CREATE OR REPLACE FUNCTION _icm_min_map() RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_object(
  'trip_date', 'Datum der Fahrt',
  'start_time', 'Uhrzeit des Fahrtbeginns',
  'end_time', 'Uhrzeit des Fahrtendes',
  'driver_name', 'Fahrername') $$;

-- ─── principals and data ────────────────────────────────────────────────────
--
-- seed.sql's two companies and their people (admin-a, editor-a, viewer-a,
-- admin-b, and `super`, a platform owner with no sign-in session and so no
-- context), plus: a supervisor in company A, because the Dokumente page is the
-- one role split this table turns on and seed.sql has no supervisor; a suspended
-- company with an administrator of its own; and two company-less platform owners
-- with a sign-in session each.

CREATE TEMP TABLE _icm_who (who text PRIMARY KEY, uid uuid NOT NULL);
INSERT INTO _icm_who VALUES
  ('admin-a',  'a0000000-0000-4000-8000-000000000001'),
  ('editor-a', 'a0000000-0000-4000-8000-000000000002'),
  ('viewer-a', 'a0000000-0000-4000-8000-000000000003'),
  ('admin-b',  'b0000000-0000-4000-8000-000000000001'),
  ('super',    '50000000-0000-4000-8000-000000000001');

CREATE OR REPLACE FUNCTION _icm_u(p_who text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT coalesce((SELECT w.uid FROM _icm_who w WHERE w.who = p_who), _icm_id('user:' || p_who)) $$;

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
VALUES (_icm_id('company:suspended'), 'ICM suspended', 'icm-suspended', 'approved', 'suspended', 'basic', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT _icm_id('user:' || v.who), 'icm-' || v.who || '@test.invalid', now()
FROM (VALUES ('supervisor-a'), ('admin-suspended'), ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
SELECT _icm_id('user:' || v.who), 'icm-' || v.who || '@test.invalid', 'ICM ' || v.who, v.role,
       (SELECT r.id FROM roles r WHERE r.name = v.role AND r.company_id IS NULL),
       v.company_id, 'active'
FROM (VALUES
  ('supervisor-a',    'supervisor', 'c0000000-0000-4000-8000-00000000000a'::uuid),
  ('admin-suspended', 'admin',      _icm_id('company:suspended')),
  ('owner-view',      'viewer',     NULL::uuid),
  ('owner-support',   'viewer',     NULL::uuid)
) AS v(who, role, company_id)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES (_icm_id('user:owner-view'),    'owner', 'icm'),
       (_icm_id('user:owner-support'), 'owner', 'icm')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
SELECT _icm_id('session:' || v.who), _icm_id('user:' || v.who)
FROM (VALUES ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

-- One remembered mapping per company, written as the owner of the table (RLS
-- does not apply; the guard does, and for the owner it only stamps).
INSERT INTO import_column_mappings (id, company_id, source_shape_key, source_headers, field_map) VALUES
  (_icm_id('row:a'),         'c0000000-0000-4000-8000-00000000000a', _icm_key('wide'),   _icm_wide(),   _icm_wide_map()),
  (_icm_id('row:b'),         'c0000000-0000-4000-8000-00000000000b', _icm_key('wide'),   _icm_wide(),   _icm_wide_map()),
  (_icm_id('row:suspended'), _icm_id('company:suspended'),           _icm_key('narrow'), _icm_narrow(), _icm_min_map());

-- ─── 1. access ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role text;
BEGIN
  PERFORM _icm_ok('access: import_column_mappings has row level security on',
    (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.import_column_mappings'::regclass));

  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    PERFORM _icm_ok(format('access: %s holds nothing on import_column_mappings', v_role),
      NOT has_table_privilege(v_role, 'public.import_column_mappings',
                              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
  END LOOP;

  PERFORM _icm_ok('access: authenticated may select, insert, update and delete, and nothing more',
    has_table_privilege('authenticated', 'public.import_column_mappings', 'SELECT')
    AND has_table_privilege('authenticated', 'public.import_column_mappings', 'INSERT')
    AND has_table_privilege('authenticated', 'public.import_column_mappings', 'UPDATE')
    AND has_table_privilege('authenticated', 'public.import_column_mappings', 'DELETE')
    AND NOT has_table_privilege('authenticated', 'public.import_column_mappings', 'TRUNCATE,REFERENCES,TRIGGER'));

  PERFORM _icm_ok('access: anon is refused outright, not filtered',
    _icm_try(NULL, NULL, 'SELECT count(*)::text FROM import_column_mappings') LIKE 'ERR 42501 permission denied%');

  PERFORM _icm_ok('access: no API role may execute the guard',
    NOT has_function_privilege('anon',          'app_private.import_column_mapping_guard()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'app_private.import_column_mapping_guard()', 'EXECUTE')
    AND NOT has_function_privilege('service_role',  'app_private.import_column_mapping_guard()', 'EXECUTE'));
END $$;

-- ─── 2. tenants ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  who  text;
  v_ins constant text := format(
    'INSERT INTO import_column_mappings (company_id, source_shape_key, source_headers, field_map) '
    'VALUES (%L, %L, %L::text[], %L::jsonb)', co_b, _icm_key('b-new'), _icm_narrow()::text, _icm_min_map()::text);
BEGIN
  -- Impersonation proven first: a NULL uid would make every refusal below pass.
  PERFORM _icm_ok('tenants: impersonation — admin-a''s active company is company A',
    _icm_try(_icm_u('admin-a'), NULL, 'SELECT get_active_company_id()::text') = co_a::text);

  FOREACH who IN ARRAY ARRAY['viewer-a', 'editor-a', 'supervisor-a', 'admin-a'] LOOP
    PERFORM _icm_ok(format('tenants: %s reads its company''s remembered mapping', who),
      _icm_try(_icm_u(who), NULL, format('SELECT count(*)::text FROM import_column_mappings WHERE id = %L', _icm_id('row:a'))) = '1');
    PERFORM _icm_ok(format('tenants: %s reads none of company B''s', who),
      _icm_try(_icm_u(who), NULL, format('SELECT count(*)::text FROM import_column_mappings WHERE company_id = %L', co_b)) = '0');
  END LOOP;

  PERFORM _icm_ok('tenants: admin-b reads its own and not company A''s',
    _icm_try(_icm_u('admin-b'), NULL, 'SELECT count(*)::text FROM import_column_mappings') = '1'
    AND _icm_try(_icm_u('admin-b'), NULL, format('SELECT count(*)::text FROM import_column_mappings WHERE company_id = %L', co_a)) = '0');

  PERFORM _icm_ok('tenants: admin-a changes and deletes nothing of company B''s — the row is not even visible',
    _icm_try(_icm_u('admin-a'), NULL, format('UPDATE import_column_mappings SET field_map = field_map WHERE id = %L', _icm_id('row:b'))) = 'rows 0'
    AND _icm_try(_icm_u('admin-a'), NULL, format('DELETE FROM import_column_mappings WHERE id = %L', _icm_id('row:b'))) = 'rows 0');

  PERFORM _icm_ok('tenants: admin-a stores nothing into company B',
    _icm_try(_icm_u('admin-a'), NULL, v_ins) LIKE 'ERR 42501%row-level security%');

  -- The guard pins the company before any WITH CHECK is reached, so this is the
  -- guard's refusal and not the policy's. Both are a refusal; which one answers
  -- is what matrix.sql's M cell records as T rather than R.
  PERFORM _icm_ok('tenants: admin-a''s mapping cannot be moved to company B',
    _icm_try(_icm_u('admin-a'), NULL, format('UPDATE import_column_mappings SET company_id = %L WHERE id = %L', co_b, _icm_id('row:a')))
      = 'ERR P0001 import_mapping_company_pinned');
END $$;

-- ─── 3. the Dokumente page gate ─────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  who  text;
  v_ins constant text := format(
    'INSERT INTO import_column_mappings (company_id, source_shape_key, source_headers, field_map) '
    'VALUES (%L, %L, %L::text[], %L::jsonb)', co_a, _icm_key('narrow'), _icm_narrow()::text, _icm_min_map()::text);
  -- What useFahrtenbuch.rememberColumnMapping actually sends.
  v_upsert constant text := format(
    'INSERT INTO import_column_mappings (company_id, source_shape_key, source_headers, field_map) '
    'VALUES (%L, %L, %L::text[], %L::jsonb) '
    'ON CONFLICT (company_id, source_shape_key) DO UPDATE '
    'SET source_headers = EXCLUDED.source_headers, field_map = EXCLUDED.field_map',
    co_a, _icm_key('wide'), _icm_wide()::text, _icm_min_map()::text);
BEGIN
  FOREACH who IN ARRAY ARRAY['viewer-a', 'editor-a'] LOOP
    PERFORM _icm_ok(format('page gate: %s updates and deletes nothing', who),
      _icm_try(_icm_u(who), NULL, format('UPDATE import_column_mappings SET field_map = field_map WHERE id = %L', _icm_id('row:a'))) = 'rows 0'
      AND _icm_try(_icm_u(who), NULL, format('DELETE FROM import_column_mappings WHERE id = %L', _icm_id('row:a'))) = 'rows 0');
    PERFORM _icm_ok(format('page gate: %s stores and upserts nothing', who),
      _icm_try(_icm_u(who), NULL, v_ins) LIKE 'ERR 42501%row-level security%'
      AND _icm_try(_icm_u(who), NULL, v_upsert) LIKE 'ERR 42501%row-level security%');
  END LOOP;

  FOREACH who IN ARRAY ARRAY['supervisor-a', 'admin-a'] LOOP
    PERFORM _icm_ok(format('page gate: %s stores a mapping for a new shape', who),
      _icm_try(_icm_u(who), NULL, v_ins) = 'rows 1');
    PERFORM _icm_ok(format('page gate: %s updates and deletes one', who),
      _icm_try(_icm_u(who), NULL, format('UPDATE import_column_mappings SET field_map = field_map WHERE id = %L', _icm_id('row:a'))) = 'rows 1'
      AND _icm_try(_icm_u(who), NULL, format('DELETE FROM import_column_mappings WHERE id = %L', _icm_id('row:a'))) = 'rows 1');
    PERFORM _icm_ok(format('page gate: the upsert %s sends re-stamps the shape the company already holds', who),
      _icm_try(_icm_u(who), NULL, v_upsert) = 'rows 1');
  END LOOP;
END $$;

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  -- The upsert above ran in a subtransaction that was rolled back; this one runs
  -- outside _icm_try so that what it leaves behind can be looked at. This is the
  -- whole point of keying on the shape: eight imports of one shape leave ONE row.
  PERFORM _icm_as(_icm_u('admin-a'));
  INSERT INTO import_column_mappings (company_id, source_shape_key, source_headers, field_map)
  VALUES (co_a, _icm_key('wide'), _icm_wide(), _icm_wide_map() - 'description')
  ON CONFLICT (company_id, source_shape_key) DO UPDATE
    SET source_headers = EXCLUDED.source_headers, field_map = EXCLUDED.field_map;
  PERFORM _icm_reset();

  -- Ten fields rather than the minimum four: the row must keep naming a column
  -- the NARROW list has not got (`Zahlungsart`), because section 6 narrows this
  -- very row and has to be refused. A four-field mapping here would have made
  -- that probe pass for the wrong reason.
  PERFORM _icm_ok('page gate: the upsert keeps one row per shape and carries the new mapping',
    (SELECT count(*) FROM import_column_mappings WHERE company_id = co_a) = 1
    AND (SELECT m.field_map FROM import_column_mappings m WHERE m.id = _icm_id('row:a'))
          = _icm_wide_map() - 'description');
END $$;

-- ─── 4. company state ───────────────────────────────────────────────────────

DO $$
DECLARE
  u constant uuid := _icm_id('user:admin-suspended');
BEGIN
  PERFORM _icm_ok('state: impersonation — the suspended company''s admin is a member of it',
    _icm_try(u, NULL, 'SELECT get_user_company_id()::text') = _icm_id('company:suspended')::text);
  PERFORM _icm_ok('state: a suspended company''s administrator reads none of its own mappings',
    _icm_try(u, NULL, 'SELECT count(*)::text FROM import_column_mappings') = '0');
  PERFORM _icm_ok('state: …and stores none',
    _icm_try(u, NULL, format('UPDATE import_column_mappings SET field_map = field_map WHERE id = %L', _icm_id('row:suspended'))) = 'rows 0'
    AND _icm_try(u, NULL, format(
      'INSERT INTO import_column_mappings (company_id, source_shape_key, source_headers, field_map) '
      'VALUES (%L, %L, %L::text[], %L::jsonb)',
      _icm_id('company:suspended'), _icm_key('s-new'), _icm_narrow()::text, _icm_min_map()::text))
      LIKE 'ERR 42501%row-level security%');
END $$;

-- ─── 5. the key: one mapping per company and shape ──────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  u    constant uuid := _icm_u('admin-a');
  v_ins constant text :=
    'INSERT INTO import_column_mappings (company_id, source_shape_key, source_headers, field_map) '
    'VALUES (%L, %L, %L::text[], %L::jsonb)';
BEGIN
  PERFORM _icm_ok('key: a second mapping for a shape the company already holds is refused',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('wide'), _icm_narrow()::text, _icm_min_map()::text))
      LIKE 'ERR 23505%import_column_mappings_company_shape_key%');

  PERFORM _icm_ok('key: a mapping for a shape the company has not got yet is stored',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('narrow'), _icm_narrow()::text, _icm_min_map()::text)) = 'rows 1');

  PERFORM _icm_ok('key: the key is per company, not global — company B holds the same shape',
    (SELECT count(*) FROM import_column_mappings
      WHERE source_shape_key = _icm_key('wide') AND company_id IN (co_a, co_b)) = 2);
END $$;

-- ─── 6. A STORED MAPPING CANNOT NAME A COLUMN THE FILE HAS NOT GOT ──────────
--
-- The property the whole feature rests on. The case is the measured one: the
-- operator's 18-column mapping, stored against the 11-column header list.
-- `Zahlungsart` and `Fahrzeugtyp` are not in that list, so the row is refused —
-- which is what makes `source_headers` a list the browser can trust when it
-- decides, field by field, which remembered columns this file still has.
--
-- A CHECK could not do this: it cannot walk a jsonb object, and the two ways to
-- give it a function are both broken (a CHECK runs as the WRITING role, so one
-- in app_private refuses every client; one in public is a pg_dump restore
-- ordering hazard). So the rule is the guard's, and losing it is losing the
-- feature.

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u    constant uuid := _icm_u('admin-a');
  v_ins constant text :=
    'INSERT INTO import_column_mappings (company_id, source_shape_key, source_headers, field_map) '
    'VALUES (%L, %L, %L::text[], %L::jsonb)';
BEGIN
  PERFORM _icm_ok('the rule: the 18-column mapping stored against the 11-column header list is refused',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('mismatch'), _icm_narrow()::text, _icm_wide_map()::text))
      = 'ERR P0001 import_mapping_value_not_a_header');

  PERFORM _icm_ok('the rule: …and the same mapping against the 18-column list it was built from is stored',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('mismatch'), _icm_wide()::text, _icm_wide_map()::text)) = 'rows 1');

  PERFORM _icm_ok('the rule: one wrong value out of eleven is enough',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('one-off'), _icm_wide()::text,
      (_icm_wide_map() || jsonb_build_object('tip_amount', 'Trinkgelder'))::text))
      = 'ERR P0001 import_mapping_value_not_a_header');

  PERFORM _icm_ok('the rule: a value differing from a real header only in case is refused',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('case'), _icm_narrow()::text,
      (_icm_min_map() || jsonb_build_object('trip_date', 'DATUM DER FAHRT'))::text))
      = 'ERR P0001 import_mapping_value_not_a_header');

  PERFORM _icm_ok('the rule: a value differing only in trailing space is refused',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('space'), _icm_narrow()::text,
      (_icm_min_map() || jsonb_build_object('driver_name', 'Fahrername '))::text))
      = 'ERR P0001 import_mapping_value_not_a_header');

  -- And on UPDATE, not only on INSERT: shrinking source_headers under a mapping
  -- that still names the removed column would be the same defect by another
  -- route.
  PERFORM _icm_ok('the rule: narrowing source_headers under a mapping that names a removed column is refused',
    _icm_try(u, NULL, format('UPDATE import_column_mappings SET source_headers = %L::text[] WHERE id = %L',
      _icm_narrow()::text, _icm_id('row:a'))) = 'ERR P0001 import_mapping_value_not_a_header');

  PERFORM _icm_ok('the rule: …and replacing the mapping with one the headers do not carry is refused',
    _icm_try(u, NULL, format('UPDATE import_column_mappings SET field_map = %L::jsonb WHERE id = %L',
      (_icm_min_map() || jsonb_build_object('payment_method', 'Bezahlart'))::text, _icm_id('row:a')))
      = 'ERR P0001 import_mapping_value_not_a_header');

  PERFORM _icm_ok('the rule: a value that is not a string at all is refused',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('nonstring'), _icm_narrow()::text,
      (_icm_min_map() || jsonb_build_object('tip_amount', 7))::text))
      = 'ERR P0001 import_mapping_value_invalid');

  -- Clean headers on purpose: appending a blank one would be caught by the
  -- header loop first and this probe would stop measuring the value rule.
  PERFORM _icm_ok('the rule: a blank value is refused',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('blankval'), _icm_narrow()::text,
      (_icm_min_map() || jsonb_build_object('tip_amount', '   '))::text))
      = 'ERR P0001 import_mapping_value_invalid');
END $$;

-- ─── 7. bounds, and the field list ──────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u    constant uuid := _icm_u('admin-a');
  v_ins constant text :=
    'INSERT INTO import_column_mappings (company_id, source_shape_key, source_headers, field_map) '
    'VALUES (%L, %L, %L::text[], %L::jsonb)';
  v_fat text[];
BEGIN
  PERFORM _icm_ok('bounds: a shape key that is not a lowercase SHA-256 is refused',
    _icm_try(u, NULL, format(v_ins, co_a, 'not-a-hash', _icm_narrow()::text, _icm_min_map()::text))
      LIKE 'ERR 23514%import_column_mappings_shape_key_sha256%'
    AND _icm_try(u, NULL, format(v_ins, co_a, upper(_icm_key('wide')), _icm_narrow()::text, _icm_min_map()::text))
      LIKE 'ERR 23514%import_column_mappings_shape_key_sha256%'
    AND _icm_try(u, NULL, format(v_ins, co_a, repeat('a', 63), _icm_narrow()::text, _icm_min_map()::text))
      LIKE 'ERR 23514%import_column_mappings_shape_key_sha256%');

  -- A BEFORE ROW trigger runs BEFORE the CHECK constraints, so wherever both
  -- would refuse, the guard answers. With no headers at all every field_map
  -- value is a column the row does not list, which is the guard's own rule; the
  -- headers_bounded CHECK is the wall behind it and the migration's self-check
  -- is what proves it is still there. The two probes below reach it because the
  -- guard passes them: 60 headers of 200 characters, and 212 short ones.
  PERFORM _icm_ok('bounds: an empty header list is refused',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('empty'), '{}', _icm_min_map()::text))
      = 'ERR P0001 import_mapping_value_not_a_header');

  PERFORM _icm_ok('bounds: a blank header is refused',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('blank'), (_icm_narrow() || ' ')::text, _icm_min_map()::text))
      = 'ERR P0001 import_mapping_header_blank');

  PERFORM _icm_ok('bounds: a header longer than 200 characters is refused',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('long'), (_icm_narrow() || repeat('x', 201))::text, _icm_min_map()::text))
      = 'ERR P0001 import_mapping_header_too_long');

  PERFORM _icm_ok('bounds: a header of exactly 200 characters is accepted',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('long200'), (_icm_narrow() || repeat('x', 200))::text, _icm_min_map()::text))
      = 'rows 1');

  PERFORM _icm_ok('bounds: a repeated header is refused — a sheet cannot produce one',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('dup'), (_icm_narrow() || 'Zielort')::text, _icm_min_map()::text))
      = 'ERR P0001 import_mapping_headers_duplicated');

  -- 60 headers of 200 characters: inside the 200-element limit, far past the
  -- 8000-character joined one.
  SELECT array_agg(rpad(i::text, 200, 'x')) INTO v_fat FROM generate_series(1, 60) i;
  PERFORM _icm_ok('bounds: a joined header list over 8000 characters is refused',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('fat'), (v_fat || _icm_narrow())::text, _icm_min_map()::text))
      LIKE 'ERR 23514%import_column_mappings_headers_bounded%');

  PERFORM _icm_ok('bounds: more than 200 headers is refused',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('many'),
      (ARRAY(SELECT 'h' || i FROM generate_series(1, 201) i) || _icm_narrow())::text, _icm_min_map()::text))
      LIKE 'ERR 23514%import_column_mappings_headers_bounded%');

  PERFORM _icm_ok('bounds: a field ColMap has not got is refused',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('unknown'), _icm_narrow()::text,
      (_icm_min_map() || jsonb_build_object('kilometer', 'Kilometer'))::text))
      LIKE 'ERR 23514%import_column_mappings_field_map_known_keys%');

  PERFORM _icm_ok('bounds: a mapping missing one of the four required fields is refused',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('short'), _icm_narrow()::text,
      (_icm_min_map() - 'trip_date')::text))
      LIKE 'ERR 23514%import_column_mappings_field_map_required_keys%'
    AND _icm_try(u, NULL, format(v_ins, co_a, _icm_key('short2'), _icm_narrow()::text,
      (_icm_min_map() - 'driver_name')::text))
      LIKE 'ERR 23514%import_column_mappings_field_map_required_keys%');

  -- Either the guard's jsonb_each refuses a non-object (22023) or, if the guard
  -- is ever reordered, one of the three field_map CHECKs does (23514). Both are
  -- a refusal and which one answers is not this file's business; what matters is
  -- that an array never becomes a mapping.
  PERFORM _icm_ok('bounds: a field_map that is not an object is refused',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('array'), _icm_narrow()::text, '["Datum der Fahrt"]'))
      ~ '^ERR (22023|23514)');

  PERFORM _icm_ok('bounds: the eleven fields of ColMap are all accepted together',
    _icm_try(u, NULL, format(v_ins, co_a, _icm_key('all11'), _icm_wide()::text, _icm_wide_map()::text)) = 'rows 1');
END $$;

-- ─── 8. the pins, and the actor ─────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u    constant uuid := _icm_u('admin-a');
  v_row import_column_mappings%ROWTYPE;
BEGIN
  PERFORM _icm_ok('pins: the shape a mapping belongs to is fixed once it exists',
    _icm_try(u, NULL, format('UPDATE import_column_mappings SET source_shape_key = %L WHERE id = %L',
      _icm_key('other'), _icm_id('row:a'))) = 'ERR P0001 import_mapping_shape_pinned');

  PERFORM _icm_ok('pins: assigning the same shape key back is not a change and is allowed',
    _icm_try(u, NULL, format('UPDATE import_column_mappings SET source_shape_key = source_shape_key WHERE id = %L',
      _icm_id('row:a'))) = 'rows 1');

  -- The actor and the times are the database's. A client naming someone else is
  -- not refused, it is overwritten: the guard assigns after every check, so
  -- there is no payload that can claim another account wrote a mapping.
  PERFORM _icm_as(u);
  INSERT INTO import_column_mappings (company_id, source_shape_key, source_headers, field_map,
                                      created_by, created_at, updated_by, updated_at)
  VALUES (co_a, _icm_key('actor'), _icm_narrow(), _icm_min_map(),
          _icm_u('admin-b'), '2001-01-01', _icm_u('admin-b'), '2001-01-01');
  PERFORM _icm_reset();

  SELECT * INTO v_row FROM import_column_mappings WHERE company_id = co_a AND source_shape_key = _icm_key('actor');
  PERFORM _icm_ok('pins: a client-supplied actor and timestamp are replaced by the caller and now()',
    v_row.created_by = u AND v_row.updated_by = u
    AND v_row.created_at > '2020-01-01'::timestamptz AND v_row.updated_at > '2020-01-01'::timestamptz);

  PERFORM _icm_as(u);
  UPDATE import_column_mappings SET field_map = _icm_min_map(), created_by = _icm_u('admin-b')
   WHERE id = v_row.id;
  PERFORM _icm_reset();

  PERFORM _icm_ok('pins: an update keeps who created the mapping and re-stamps who confirmed it',
    (SELECT m.created_by FROM import_column_mappings m WHERE m.id = v_row.id) = u
    AND (SELECT m.created_at FROM import_column_mappings m WHERE m.id = v_row.id) = v_row.created_at
    AND (SELECT m.updated_at FROM import_column_mappings m WHERE m.id = v_row.id) >= v_row.updated_at);
END $$;

-- ─── 9. the two platform contexts, and none ─────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u    constant uuid := _icm_id('user:owner-view');
  s    constant uuid := _icm_id('session:owner-view');
  v_open jsonb;
  v_mark bigint;
BEGIN
  PERFORM _icm_as(u, s);
  v_open := public.platform_context_open(co_a, 'view');
  PERFORM _icm_reset();
  PERFORM _icm_ok('contexts: the owner opens a view context on company A', (v_open ->> 'success') = 'true');

  PERFORM _icm_ok('contexts: a view context reads company A''s mapping and none of company B''s',
    _icm_try(u, s, format('SELECT count(*)::text FROM import_column_mappings WHERE id = %L', _icm_id('row:a'))) = '1'
    AND _icm_try(u, s, format('SELECT count(*)::text FROM import_column_mappings WHERE id = %L', _icm_id('row:b'))) = '0');

  v_mark := _icm_mark();
  PERFORM _icm_ok('contexts: a view context writes nothing — the statement trigger refuses every command',
    _icm_try(u, s, format('UPDATE import_column_mappings SET field_map = field_map WHERE id = %L', _icm_id('row:a'))) = 'ERR P0001 support_session_required'
    AND _icm_try(u, s, format('DELETE FROM import_column_mappings WHERE id = %L', _icm_id('row:a'))) = 'ERR P0001 support_session_required'
    AND _icm_try(u, s, format(
      'INSERT INTO import_column_mappings (company_id, source_shape_key, source_headers, field_map) '
      'VALUES (%L, %L, %L::text[], %L::jsonb)', co_a, _icm_key('view'), _icm_narrow()::text, _icm_min_map()::text))
      = 'ERR P0001 support_session_required');
  PERFORM _icm_ok('contexts: …and nothing is recorded for the refusals', _icm_rows(v_mark) = 0);
END $$;

DO $$
DECLARE
  co_a  constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b  constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  u     constant uuid := _icm_id('user:owner-support');
  s     constant uuid := _icm_id('session:owner-support');
  v_open jsonb;
  v_ctx  uuid;
  v_mark bigint;
  v_rows bigint;
  r      app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _icm_as(u, s);
  v_open := public.platform_context_open(co_a, 'support', 'Ticket Spaltenzuordnung');
  PERFORM _icm_reset();
  PERFORM _icm_ok('contexts: the owner opens a support session on company A with a reason', (v_open ->> 'success') = 'true');
  v_ctx := (v_open -> 'context' ->> 'id')::uuid;

  v_mark := _icm_mark();
  PERFORM _icm_as(u, s);
  INSERT INTO import_column_mappings (id, company_id, source_shape_key, source_headers, field_map)
  VALUES (_icm_id('row:support'), co_a, _icm_key('support'), _icm_narrow(), _icm_min_map());
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM _icm_reset();

  PERFORM _icm_ok('contexts: a support session writes as the company''s administrator', v_rows = 1);
  PERFORM _icm_ok('contexts: exactly one audit row for the row',
    _icm_rows(v_mark) = 1
    AND _icm_rows(v_mark, 'support_write.import_column_mappings.insert') = 1);

  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _icm_ok('contexts: category support, the table, the company and the row',
    r.category = 'support' AND r.outcome = 'ok' AND r.company_id = co_a
    AND r.target_type = 'import_column_mappings' AND r.target_id = _icm_id('row:support')::text);
  PERFORM _icm_ok('contexts: the actor, its role, its session and the context with its reason',
    r.actor_user_id = u AND r.actor_role = 'owner' AND r.session_id = s
    AND (r.after_value ->> 'context_id') = v_ctx::text
    AND (r.after_value ->> 'reason') = 'Ticket Spaltenzuordnung');

  v_mark := _icm_mark();
  PERFORM _icm_ok('contexts: another company''s mappings are not visible and not written',
    _icm_try(u, s, format('UPDATE import_column_mappings SET field_map = field_map WHERE id = %L', _icm_id('row:b'))) = 'rows 0'
    AND _icm_try(u, s, format('DELETE FROM import_column_mappings WHERE id = %L', _icm_id('row:b'))) = 'rows 0');
  PERFORM _icm_ok('contexts: a store into another company is refused by RLS',
    _icm_try(u, s, format(
      'INSERT INTO import_column_mappings (company_id, source_shape_key, source_headers, field_map) '
      'VALUES (%L, %L, %L::text[], %L::jsonb)', co_b, _icm_key('sup-b'), _icm_narrow()::text, _icm_min_map()::text))
      LIKE 'ERR 42501%row-level security%');
  -- The row written above is deliberately NOT cleaned up: the support context is
  -- still open, so a delete would arm the audit trigger again and record a row
  -- nothing asked for. The file rolls back at the end.
  PERFORM _icm_ok('contexts: …and nothing is recorded for any of them', _icm_rows(v_mark) = 0);
END $$;

DO $$
DECLARE
  u constant uuid := '50000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _icm_ok('contexts: a platform owner with no context reads nothing of either company',
    _icm_try(u, NULL, 'SELECT count(*)::text FROM import_column_mappings') = '0');
  PERFORM _icm_ok('contexts: …and writes nothing',
    _icm_try(u, NULL, format('UPDATE import_column_mappings SET field_map = field_map WHERE id = %L', _icm_id('row:a'))) = 'rows 0'
    AND _icm_try(u, NULL, format(
      'INSERT INTO import_column_mappings (company_id, source_shape_key, source_headers, field_map) '
      'VALUES (%L, %L, %L::text[], %L::jsonb)',
      'c0000000-0000-4000-8000-00000000000a', _icm_key('nocontext'), _icm_narrow()::text, _icm_min_map()::text))
      LIKE 'ERR 42501%row-level security%');
END $$;

-- ─── 10. the mappings go with their company ─────────────────────────────────

DO $$
DECLARE
  v_company constant uuid := _icm_id('company:short-lived');
BEGIN
  INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
  VALUES (v_company, 'ICM short-lived', 'icm-short-lived', 'approved', 'active', 'basic', 'active');
  INSERT INTO import_column_mappings (company_id, source_shape_key, source_headers, field_map)
  VALUES (v_company, _icm_key('bye'), _icm_narrow(), _icm_min_map());
  PERFORM _icm_ok('company: the mapping is remembered for it',
    (SELECT count(*) FROM import_column_mappings WHERE company_id = v_company) = 1);

  DELETE FROM companies WHERE id = v_company;
  PERFORM _icm_ok('company: deleting the company deletes its remembered mappings',
    (SELECT count(*) FROM import_column_mappings WHERE company_id = v_company) = 0);
END $$;

-- ─── the section ledger ─────────────────────────────────────────────────────
--
-- Every section above must have written to `_icm_log`. This is the check that
-- catches the failure mode a plpgsql counter cannot: a section that raised
-- nothing because it never ran reports nothing, and "all checks passed" is then
-- a claim about an empty set. The ledger is a TEMP TABLE, so no subtransaction a
-- probe rolls back can take its rows away.

DO $$
DECLARE
  c_sections CONSTANT text[] := ARRAY['access', 'tenants', 'page gate', 'state', 'key',
                                      'the rule', 'bounds', 'pins', 'contexts', 'company'];
  v_missing text;
  v_extra   text;
  v_total   bigint;
BEGIN
  SELECT string_agg(s, ', ' ORDER BY s) INTO v_missing
    FROM unnest(c_sections) s
   WHERE NOT EXISTS (SELECT 1 FROM _icm_log l WHERE l.section = s);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL (ledger): section(s) ran no check at all: %', v_missing;
  END IF;

  SELECT string_agg(DISTINCT l.section, ', ') INTO v_extra
    FROM _icm_log l WHERE NOT (l.section = ANY (c_sections));
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL (ledger): check(s) filed under unknown section(s): % — add them to c_sections', v_extra;
  END IF;

  SELECT count(*) INTO v_total FROM _icm_log;
  -- A floor and not an equality: a check added to a section must not have to be
  -- counted here too. It still fails when a whole section is lost, and when the
  -- file is cut down to a handful of probes.
  IF v_total < 45 THEN
    RAISE EXCEPTION 'FAIL (ledger): only % checks ran; the file had 54 when it was written', v_total;
  END IF;
  RAISE NOTICE '── import column mapping: % checks across % sections passed ──',
    v_total, array_length(c_sections, 1);
END $$;

ROLLBACK;
