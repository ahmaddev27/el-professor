/*
  The address cache of the Fahrtenanalyse's locator (migration 20261023100000).

  Runs after the files before it, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The whole
  file is one transaction rolled back at the end, so the files after it see the
  database as the seeds left it.

  Every check is a BEHAVIOUR: a caller does something and the database answers.
  Nothing here reads the text of a policy, a trigger or a function, so a rewrite
  that keeps the behaviour keeps the file green (a catalogue regex that an
  innocent reformatting broke has refused a kit run before).

  What is covered, in order:

    1. access        row level security is on; anon is refused outright; the
                     service role holds nothing; authenticated may select,
                     insert, update and delete and do nothing else
    2. tenants       a member reads its own company's rows and never another
                     company's; nobody writes into another company or moves a
                     row there
    3. admin gate    a viewer and an editor read and write nothing; the
                     administrator inserts, upserts, updates and deletes; the
                     upsert the browser sends (company and address) works
    4. state         a suspended company's administrator reads and writes nothing
    5. constraints   a point outside Germany, a swapped pair, a blank or a long
                     key, a second row for one address and an over-long reference
                     are refused
    6. view          a view context reads the company it opened and writes
                     nothing, and nothing is recorded for the refusal
    7. support       a support session writes as the company's administrator and
                     each row leaves exactly one audit row; a write into another
                     company is refused and not recorded
    8. no context    a platform owner with no context open reads and writes none
    9. company       the rows go with their company

  The matrix lines for the table are in tests/rls/matrix.sql.
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

CREATE OR REPLACE FUNCTION _gc_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _gc_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('gc:' || p_what)::uuid $$;

CREATE OR REPLACE FUNCTION _gc_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/* Become a signed-in caller with a password sign-in and, when given, the session a context is answered to; anon when p_user is NULL. */
CREATE OR REPLACE FUNCTION _gc_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _gc_reset();
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
  `ERR <sqlstate> <message>`. Nothing it writes survives, audit rows included.
*/
CREATE OR REPLACE FUNCTION _gc_try(p_user uuid, p_session uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _gc_as(p_user, p_session);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ011' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _gc_reset();
  RETURN v_out;
END $$;

/** The audit log's high-water mark, so each check counts only its own rows. */
CREATE OR REPLACE FUNCTION _gc_mark() RETURNS bigint
LANGUAGE sql AS $$ SELECT coalesce(max(l.id), 0) FROM app_private.platform_audit_log l $$;

/** Support-write rows after a mark, for one action or for all of them. */
CREATE OR REPLACE FUNCTION _gc_rows(p_since bigint, p_action text DEFAULT NULL) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*)
    FROM app_private.platform_audit_log l
   WHERE l.id > p_since
     AND l.action ~ '^support_write\.'
     AND (p_action IS NULL OR l.action = p_action)
$$;

-- ─── principals and data ────────────────────────────────────────────────────
--
-- seed.sql's two companies and their people (admin-a, editor-a, viewer-a,
-- admin-b, and `super`, a platform owner with no sign-in session and so no
-- context), plus a suspended company with an administrator of its own, and two
-- company-less platform owners with a sign-in session each: one opens a view
-- context on company A, the other a support session.

CREATE TEMP TABLE _gc_who (who text PRIMARY KEY, uid uuid NOT NULL);
INSERT INTO _gc_who VALUES
  ('admin-a',  'a0000000-0000-4000-8000-000000000001'),
  ('editor-a', 'a0000000-0000-4000-8000-000000000002'),
  ('viewer-a', 'a0000000-0000-4000-8000-000000000003'),
  ('admin-b',  'b0000000-0000-4000-8000-000000000001'),
  ('super',    '50000000-0000-4000-8000-000000000001');

CREATE OR REPLACE FUNCTION _gc_u(p_who text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT coalesce((SELECT w.uid FROM _gc_who w WHERE w.who = p_who), _gc_id('user:' || p_who)) $$;

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
VALUES (_gc_id('company:suspended'), 'GC suspended', 'gc-suspended', 'approved', 'suspended', 'basic', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT _gc_id('user:' || v.who), 'gc-' || v.who || '@test.invalid', now()
FROM (VALUES ('admin-suspended'), ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
SELECT _gc_id('user:' || v.who), 'gc-' || v.who || '@test.invalid', 'GC ' || v.who, v.role,
       (SELECT r.id FROM roles r WHERE r.name = v.role AND r.company_id IS NULL),
       v.company_id, 'active'
FROM (VALUES
  ('admin-suspended', 'admin',  _gc_id('company:suspended')),
  ('owner-view',      'viewer', NULL::uuid),
  ('owner-support',   'viewer', NULL::uuid)
) AS v(who, role, company_id)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES (_gc_id('user:owner-view'),    'owner', 'gc'),
       (_gc_id('user:owner-support'), 'owner', 'gc')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
SELECT _gc_id('session:' || v.who), _gc_id('user:' || v.who)
FROM (VALUES ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

-- One cached address per company, written as the owner of the table (RLS does not
-- apply; the triggers do, and for the owner they are silent).
INSERT INTO geocode_cache (id, company_id, address_key, lat, lon, osm_ref, geocoder_version) VALUES
  (_gc_id('row:a'),         'c0000000-0000-4000-8000-00000000000a', 'hauptstraße 12, 42651 solingen', 51.1722, 7.0833, 'node/4711', 'nominatim@2026-08-21'),
  (_gc_id('row:b'),         'c0000000-0000-4000-8000-00000000000b', 'kölner straße 5, 40211 düsseldorf', 51.2277, 6.7735, 'node/4712', 'nominatim@2026-08-21'),
  (_gc_id('row:suspended'), _gc_id('company:suspended'),            'marktplatz 3, 42103 wuppertal', 51.2562, 7.1508, NULL, 'nominatim@2026-08-21');

-- ─── 1. access ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role text;
BEGIN
  PERFORM _gc_ok('access: geocode_cache has row level security on',
    (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.geocode_cache'::regclass));

  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    PERFORM _gc_ok(format('access: %s holds nothing on geocode_cache', v_role),
      NOT has_table_privilege(v_role, 'public.geocode_cache', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
  END LOOP;
  PERFORM _gc_ok('access: authenticated may select, insert, update and delete, and nothing more',
    has_table_privilege('authenticated', 'public.geocode_cache', 'SELECT')
    AND has_table_privilege('authenticated', 'public.geocode_cache', 'INSERT')
    AND has_table_privilege('authenticated', 'public.geocode_cache', 'UPDATE')
    AND has_table_privilege('authenticated', 'public.geocode_cache', 'DELETE')
    AND NOT has_table_privilege('authenticated', 'public.geocode_cache', 'TRUNCATE,REFERENCES,TRIGGER'));
  PERFORM _gc_ok('access: anon is refused outright, not filtered',
    _gc_try(NULL, NULL, 'SELECT count(*)::text FROM geocode_cache') LIKE 'ERR 42501 permission denied%');
END $$;

-- ─── 2. tenants ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  who  text;
BEGIN
  -- Impersonation proven first: a NULL uid would make every refusal below pass.
  PERFORM _gc_ok('impersonation: admin-a''s active company is company A',
    _gc_try(_gc_u('admin-a'), NULL, 'SELECT get_active_company_id()::text') = co_a::text);

  FOREACH who IN ARRAY ARRAY['viewer-a', 'editor-a', 'admin-a'] LOOP
    PERFORM _gc_ok(format('tenants: %s reads its company''s cached address', who),
      _gc_try(_gc_u(who), NULL, format('SELECT count(*)::text FROM geocode_cache WHERE id = %L', _gc_id('row:a'))) = '1');
    PERFORM _gc_ok(format('tenants: %s reads none of company B''s', who),
      _gc_try(_gc_u(who), NULL, format('SELECT count(*)::text FROM geocode_cache WHERE company_id = %L', co_b)) = '0');
  END LOOP;

  PERFORM _gc_ok('tenants: admin-b reads its own and not company A''s',
    _gc_try(_gc_u('admin-b'), NULL, 'SELECT count(*)::text FROM geocode_cache') = '1'
    AND _gc_try(_gc_u('admin-b'), NULL, format('SELECT count(*)::text FROM geocode_cache WHERE company_id = %L', co_a)) = '0');

  PERFORM _gc_ok('tenants: admin-a changes and deletes nothing of company B''s — the row is not even visible',
    _gc_try(_gc_u('admin-a'), NULL, format('UPDATE geocode_cache SET lat = 51 WHERE id = %L', _gc_id('row:b'))) = 'rows 0'
    AND _gc_try(_gc_u('admin-a'), NULL, format('DELETE FROM geocode_cache WHERE id = %L', _gc_id('row:b'))) = 'rows 0');

  PERFORM _gc_ok('tenants: admin-a inserts nothing into company B',
    _gc_try(_gc_u('admin-a'), NULL,
      format('INSERT INTO geocode_cache (company_id, address_key, lat, lon, geocoder_version) VALUES (%L, ''x 1, 42651 solingen'', 51.1, 7.1, ''nominatim'')', co_b))
      LIKE 'ERR 42501%row-level security%');

  PERFORM _gc_ok('tenants: admin-a''s row cannot be moved to company B — RLS refuses the new row',
    _gc_try(_gc_u('admin-a'), NULL, format('UPDATE geocode_cache SET company_id = %L WHERE id = %L', co_b, _gc_id('row:a')))
      LIKE 'ERR 42501%row-level security%');
END $$;

-- ─── 3. the administrator gate ──────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  who  text;
  v_insert constant text := format(
    'INSERT INTO geocode_cache (company_id, address_key, lat, lon, geocoder_version) VALUES (%L, ''neu 1, 42651 solingen'', 51.1, 7.1, ''nominatim'')', co_a);
  v_upsert constant text := format(
    'INSERT INTO geocode_cache (company_id, address_key, lat, lon, geocoder_version) VALUES (%L, ''hauptstraße 12, 42651 solingen'', 51.2, 7.2, ''nominatim@2026-10-01'') '
    'ON CONFLICT (company_id, address_key) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, geocoder_version = EXCLUDED.geocoder_version, geocoded_at = now()', co_a);
BEGIN
  FOREACH who IN ARRAY ARRAY['viewer-a', 'editor-a'] LOOP
    PERFORM _gc_ok(format('admin gate: %s updates and deletes nothing', who),
      _gc_try(_gc_u(who), NULL, format('UPDATE geocode_cache SET lat = 51 WHERE id = %L', _gc_id('row:a'))) = 'rows 0'
      AND _gc_try(_gc_u(who), NULL, format('DELETE FROM geocode_cache WHERE id = %L', _gc_id('row:a'))) = 'rows 0');
    PERFORM _gc_ok(format('admin gate: %s inserts and upserts nothing', who),
      _gc_try(_gc_u(who), NULL, v_insert) LIKE 'ERR 42501%row-level security%'
      AND _gc_try(_gc_u(who), NULL, v_upsert) LIKE 'ERR 42501%row-level security%');
  END LOOP;

  PERFORM _gc_ok('admin gate: the administrator inserts a new address',
    _gc_try(_gc_u('admin-a'), NULL, v_insert) = 'rows 1');
  PERFORM _gc_ok('admin gate: …updates and deletes one',
    _gc_try(_gc_u('admin-a'), NULL, format('UPDATE geocode_cache SET lat = 51.3 WHERE id = %L', _gc_id('row:a'))) = 'rows 1'
    AND _gc_try(_gc_u('admin-a'), NULL, format('DELETE FROM geocode_cache WHERE id = %L', _gc_id('row:a'))) = 'rows 1');
  PERFORM _gc_ok('admin gate: …and the upsert the browser sends replaces the point of a known address',
    _gc_try(_gc_u('admin-a'), NULL, v_upsert) = 'rows 1');
END $$;

DO $$
BEGIN
  -- The upsert above ran in a subtransaction that was rolled back; this one runs
  -- outside _gc_try so that what it leaves behind can be looked at.
  PERFORM _gc_as(_gc_u('admin-a'));
  INSERT INTO geocode_cache (company_id, address_key, lat, lon, geocoder_version)
  VALUES ('c0000000-0000-4000-8000-00000000000a', 'hauptstraße 12, 42651 solingen', 51.2, 7.2, 'nominatim@2026-10-01')
  ON CONFLICT (company_id, address_key) DO UPDATE
    SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, geocoder_version = EXCLUDED.geocoder_version, geocoded_at = now();
  PERFORM _gc_reset();
  PERFORM _gc_ok('admin gate: an upsert keeps one row per address and carries the new point and version',
    (SELECT count(*) FROM geocode_cache WHERE company_id = 'c0000000-0000-4000-8000-00000000000a'
        AND address_key = 'hauptstraße 12, 42651 solingen') = 1
    AND (SELECT g.lat FROM geocode_cache g WHERE g.id = _gc_id('row:a')) = 51.2
    AND (SELECT g.geocoder_version FROM geocode_cache g WHERE g.id = _gc_id('row:a')) = 'nominatim@2026-10-01');
END $$;

-- ─── 4. company state ───────────────────────────────────────────────────────

DO $$
DECLARE
  u constant uuid := _gc_id('user:admin-suspended');
BEGIN
  PERFORM _gc_ok('state: impersonation — the suspended company''s admin is a member of it',
    _gc_try(u, NULL, 'SELECT get_user_company_id()::text') = _gc_id('company:suspended')::text);
  PERFORM _gc_ok('state: a suspended company''s administrator reads none of its own rows',
    _gc_try(u, NULL, 'SELECT count(*)::text FROM geocode_cache') = '0');
  PERFORM _gc_ok('state: …and writes none',
    _gc_try(u, NULL, format('UPDATE geocode_cache SET lat = 51 WHERE id = %L', _gc_id('row:suspended'))) = 'rows 0'
    AND _gc_try(u, NULL,
      format('INSERT INTO geocode_cache (company_id, address_key, lat, lon, geocoder_version) VALUES (%L, ''x 1, 42103 wuppertal'', 51.2, 7.1, ''nominatim'')',
             _gc_id('company:suspended'))) LIKE 'ERR 42501%row-level security%');
END $$;

-- ─── 5. constraints ─────────────────────────────────────────────────────────
--
-- The administrator writes; what the table refuses is the table's own doing.

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u    constant uuid := _gc_u('admin-a');
  v_ins constant text := 'INSERT INTO geocode_cache (company_id, address_key, lat, lon, osm_ref, geocoder_version) VALUES (%L, %L, %s, %s, %L, %L)';
BEGIN
  PERFORM _gc_ok('constraints: a point inside Germany is accepted',
    _gc_try(u, NULL, format(v_ins, co_a, 'ok 1, 42651 solingen', 51.17, 7.08, 'node/1', 'nominatim')) = 'rows 1');
  PERFORM _gc_ok('constraints: a point outside Germany is refused, and so is a latitude and longitude swapped',
    _gc_try(u, NULL, format(v_ins, co_a, 'far 1, 42651 solingen', 48.85, 2.35, NULL, 'nominatim')) LIKE 'ERR 23514%'
    AND _gc_try(u, NULL, format(v_ins, co_a, 'swapped 1, 42651 solingen', 7.08, 51.17, NULL, 'nominatim')) LIKE 'ERR 23514%');
  PERFORM _gc_ok('constraints: a blank key and a key longer than 300 characters are refused',
    _gc_try(u, NULL, format(v_ins, co_a, '', 51.17, 7.08, NULL, 'nominatim')) LIKE 'ERR 23514%'
    AND _gc_try(u, NULL, format(v_ins, co_a, repeat('x', 301), 51.17, 7.08, NULL, 'nominatim')) LIKE 'ERR 23514%');
  PERFORM _gc_ok('constraints: a key of exactly 300 characters is accepted',
    _gc_try(u, NULL, format(v_ins, co_a, repeat('x', 300), 51.17, 7.08, NULL, 'nominatim')) = 'rows 1');
  PERFORM _gc_ok('constraints: a blank data version and an over-long reference are refused',
    _gc_try(u, NULL, format(v_ins, co_a, 'v 1, 42651 solingen', 51.17, 7.08, NULL, '')) LIKE 'ERR 23514%'
    AND _gc_try(u, NULL, format(v_ins, co_a, 'w 1, 42651 solingen', 51.17, 7.08, repeat('n', 41), 'nominatim')) LIKE 'ERR 23514%');
  PERFORM _gc_ok('constraints: a point has to be given',
    _gc_try(u, NULL, format('INSERT INTO geocode_cache (company_id, address_key, geocoder_version) VALUES (%L, ''p 1, 42651 solingen'', ''nominatim'')', co_a)) LIKE 'ERR 23502%');
  PERFORM _gc_ok('constraints: an address is cached once per company: a second row for it is refused',
    _gc_try(u, NULL, format(v_ins, co_a, 'hauptstraße 12, 42651 solingen', 51.17, 7.08, NULL, 'nominatim')) LIKE 'ERR 23505%');
  PERFORM _gc_ok('constraints: the same address is cached once per company, not once: company B may hold it too',
    _gc_try(_gc_u('admin-b'), NULL, format(v_ins, 'c0000000-0000-4000-8000-00000000000b', 'hauptstraße 12, 42651 solingen', 51.17, 7.08, NULL, 'nominatim')) = 'rows 1');
END $$;

-- ─── 6. a view context reads and writes nothing ─────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  u    constant uuid := _gc_id('user:owner-view');
  s    constant uuid := _gc_id('session:owner-view');
  v_open jsonb;
  v_mark bigint;
BEGIN
  PERFORM _gc_as(u, s);
  v_open := public.platform_context_open(co_a, 'view');
  PERFORM _gc_reset();
  PERFORM _gc_ok('view: the owner opens a view context on company A', (v_open ->> 'success') = 'true');

  PERFORM _gc_ok('view: it reads company A''s cached address and none of company B''s',
    _gc_try(u, s, format('SELECT count(*)::text FROM geocode_cache WHERE id = %L', _gc_id('row:a'))) = '1'
    AND _gc_try(u, s, format('SELECT count(*)::text FROM geocode_cache WHERE id = %L', _gc_id('row:b'))) = '0');

  v_mark := _gc_mark();
  PERFORM _gc_ok('view: every write is refused by the statement trigger, with 3.4a''s sentence',
    _gc_try(u, s, format('UPDATE geocode_cache SET lat = 51 WHERE id = %L', _gc_id('row:a'))) LIKE 'ERR P0001 Nur-Lese-Ansicht:%'
    AND _gc_try(u, s, format('DELETE FROM geocode_cache WHERE id = %L', _gc_id('row:a'))) LIKE 'ERR P0001 Nur-Lese-Ansicht:%'
    AND _gc_try(u, s, format('INSERT INTO geocode_cache (company_id, address_key, lat, lon, geocoder_version) VALUES (%L, ''v 1, 42651 solingen'', 51.1, 7.1, ''nominatim'')', co_a))
      LIKE 'ERR P0001 Nur-Lese-Ansicht:%');
  PERFORM _gc_ok('view: …and nothing is recorded for the refusals', _gc_rows(v_mark) = 0);
END $$;

-- ─── 7. a support session writes, and every row is recorded ─────────────────
--
-- The standard shape. (The browser never writes as a platform account, see the
-- header of the migration; the database does not need to forbid it, and this
-- section says what happens if it is done by hand: the write succeeds as the
-- company's administrator and is recorded, once per row.)

DO $$
DECLARE
  co_a  constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b  constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  u     constant uuid := _gc_id('user:owner-support');
  s     constant uuid := _gc_id('session:owner-support');
  v_open jsonb;
  v_ctx  uuid;
  v_mark bigint;
  v_rows bigint;
  r      app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _gc_as(u, s);
  v_open := public.platform_context_open(co_a, 'support', 'Ticket Adresszwischenspeicher');
  PERFORM _gc_reset();
  PERFORM _gc_ok('support: the owner opens a support session on company A with a reason', (v_open ->> 'success') = 'true');
  v_ctx := (v_open -> 'context' ->> 'id')::uuid;

  v_mark := _gc_mark();
  PERFORM _gc_as(u, s);
  INSERT INTO geocode_cache (id, company_id, address_key, lat, lon, geocoder_version)
  VALUES (_gc_id('row:support'), co_a, 'support 1, 42651 solingen', 51.1, 7.1, 'nominatim');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM _gc_reset();

  PERFORM _gc_ok('support: the session writes as the company''s administrator', v_rows = 1);
  PERFORM _gc_ok('support: exactly one audit row for the row', _gc_rows(v_mark) = 1
    AND _gc_rows(v_mark, 'support_write.geocode_cache.insert') = 1);
  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _gc_ok('support: category support, the table, the company and the row',
    r.category = 'support' AND r.outcome = 'ok' AND r.company_id = co_a
    AND r.target_type = 'geocode_cache' AND r.target_id = _gc_id('row:support')::text);
  PERFORM _gc_ok('support: the actor, its role, its session and the context with its reason',
    r.actor_user_id = u AND r.actor_role = 'owner' AND r.session_id = s
    AND (r.after_value ->> 'context_id') = v_ctx::text AND (r.after_value ->> 'reason') = 'Ticket Adresszwischenspeicher');

  v_mark := _gc_mark();
  PERFORM _gc_ok('support: another company''s rows are not visible and not written',
    _gc_try(u, s, format('UPDATE geocode_cache SET lat = 51 WHERE id = %L', _gc_id('row:b'))) = 'rows 0'
    AND _gc_try(u, s, format('DELETE FROM geocode_cache WHERE id = %L', _gc_id('row:b'))) = 'rows 0');
  PERFORM _gc_ok('support: an insert into another company is refused by RLS',
    _gc_try(u, s, format('INSERT INTO geocode_cache (company_id, address_key, lat, lon, geocoder_version) VALUES (%L, ''b 1, 40211 duesseldorf'', 51.2, 6.8, ''nominatim'')', co_b))
      LIKE 'ERR 42501%row-level security%');
  PERFORM _gc_ok('support: …and nothing is recorded for any of them', _gc_rows(v_mark) = 0);
END $$;

-- ─── 8. a platform owner with no context ────────────────────────────────────

DO $$
DECLARE
  u constant uuid := '50000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _gc_ok('no context: super reads nothing of either company',
    _gc_try(u, NULL, 'SELECT count(*)::text FROM geocode_cache') = '0');
  PERFORM _gc_ok('no context: …and writes nothing',
    _gc_try(u, NULL, format('UPDATE geocode_cache SET lat = 51 WHERE id = %L', _gc_id('row:a'))) = 'rows 0'
    AND _gc_try(u, NULL,
      format('INSERT INTO geocode_cache (company_id, address_key, lat, lon, geocoder_version) VALUES (%L, ''n 1, 42651 solingen'', 51.1, 7.1, ''nominatim'')',
             'c0000000-0000-4000-8000-00000000000a')) LIKE 'ERR 42501%row-level security%');
END $$;

-- ─── 9. the rows go with their company ──────────────────────────────────────

DO $$
DECLARE
  v_company constant uuid := _gc_id('company:short-lived');
BEGIN
  INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
  VALUES (v_company, 'GC short-lived', 'gc-short-lived', 'approved', 'active', 'basic', 'active');
  INSERT INTO geocode_cache (company_id, address_key, lat, lon, geocoder_version)
  VALUES (v_company, 'bye 1, 42651 solingen', 51.1, 7.1, 'nominatim');
  PERFORM _gc_ok('company: the address is cached for it',
    (SELECT count(*) FROM geocode_cache WHERE company_id = v_company) = 1);

  DELETE FROM companies WHERE id = v_company;
  PERFORM _gc_ok('company: deleting the company deletes its cached addresses',
    (SELECT count(*) FROM geocode_cache WHERE company_id = v_company) = 0);
END $$;

DO $$ BEGIN RAISE NOTICE '── geocode cache: all checks passed ──'; END $$;

ROLLBACK;
