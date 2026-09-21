/*
  Plan 3.11: announcements and feature flags (migrations 20260920130000, the
  `feature_flags` key, and 20260920130010, the announcements and
  get_app_config()).

  Runs after assertions.sql against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it
  see the database as the seeds left it — and now() does not move, so "an hour
  ago" means the same instant in every check.

  What is covered, in order:

    1. privileges  the table is unreachable; each function has exactly its
                   stated EXECUTE grants
    2. flags       seeded {}, owner-only writes, the validator, and every
                   signed-in company user reading them through get_app_config
    3. writing     create, list, update and delete an announcement, each pinned
                   to the version the screen read
    4. authority   settings.manage — owner only — to write; settings.read to
                   list, which billing holds for the prices alone; a company
                   user refused without a row
    5. the window  **two timestamps with an explicit offset, never dates**: an
                   announcement appears at its start and disappears at its end,
                   whatever the session's zone, and a time without an offset is
                   refused
    6. audience    every company, the companies on a plan, named companies;
                   nothing for a blocked company or an account without one;
                   never the audience itself in what a tenant receives
    7. audit       one row per call, the refusals included
    8. the budget  the settings budget covers these calls too
    9. forgery     platform_audit_record cannot write an announcement row
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _an_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _an_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

CREATE OR REPLACE FUNCTION _an_become(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _an_reset();
  IF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
  ELSE
    PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    -- A password sign-in: since 20260919130000 a platform capability needs one.
    PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
END $$;

/** One SELECT as the principal; its scalar, or `ERR <sqlstate> <message>`. What it wrote is KEPT. */
CREATE OR REPLACE FUNCTION _an_do(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _an_become(p_user);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _an_reset();
  RETURN v_out;
END $$;

/** An instant as the browser sends it: UTC, with its `Z`. */
CREATE OR REPLACE FUNCTION _an_iso(p_at timestamptz) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;

/** An announcement document, as the panel sends one. */
CREATE OR REPLACE FUNCTION _an_doc(
  p_title    text,
  p_audience text        DEFAULT 'all',
  p_plans    jsonb       DEFAULT '[]',
  p_ids      jsonb       DEFAULT '[]',
  p_starts   timestamptz DEFAULT now() - interval '1 hour',
  p_ends     timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'tone', 'info',
    'title_de', p_title, 'body_de', 'Text für ' || p_title,
    'title_en', '', 'body_en', '',
    'audience', p_audience, 'plans', p_plans, 'company_ids', p_ids,
    'starts_at', _an_iso(p_starts),
    'ends_at', CASE WHEN p_ends IS NULL THEN 'null'::jsonb ELSE to_jsonb(_an_iso(p_ends)) END)
$$;

/** Create one as the owner; its id. */
CREATE OR REPLACE FUNCTION _an_create(p_doc jsonb) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_out text;
BEGIN
  v_out := _an_do('3d000000-0000-4000-8000-000000000001',
                  format('SELECT platform_announcement_save(NULL, %L::jsonb, NULL)::text', p_doc::text));
  IF v_out LIKE 'ERR%' OR (v_out::jsonb ->> 'ok') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'FAIL: could not create an announcement: %', v_out;
  END IF;
  RETURN (v_out::jsonb -> 'item' ->> 'id')::uuid;
END $$;

/** The announcement titles one principal's get_app_config() carries, in order. */
CREATE OR REPLACE FUNCTION _an_titles(p_user uuid) RETURNS text[]
LANGUAGE plpgsql AS $$
DECLARE
  v_out text;
BEGIN
  v_out := _an_do(p_user, $q$SELECT (get_app_config() -> 'announcements')::text$q$);
  IF v_out LIKE 'ERR%' THEN
    RAISE EXCEPTION 'FAIL: get_app_config: %', v_out;
  END IF;
  RETURN coalesce((SELECT array_agg(e ->> 'title_de' ORDER BY n)
                     FROM jsonb_array_elements(v_out::jsonb) WITH ORDINALITY AS a(e, n)),
                  ARRAY[]::text[]);
END $$;

-- ─── principals ─────────────────────────────────────────────────────────────

/*
    3d..01 an-owner      owner
    3d..02 an-support    support
    3d..03 an-billing    billing
    3d..04 an-readonly   read_only
    3d..05 an-capped     read_only, for the budget
  plus admin-a, editor-a and admin-b from seed.sql, and `super`, the seed's
  platform owner, who belongs to no company and holds no support session.
*/
INSERT INTO auth.users (id, email) VALUES
  ('3d000000-0000-4000-8000-000000000001', 'an-owner@test.invalid'),
  ('3d000000-0000-4000-8000-000000000002', 'an-support@test.invalid'),
  ('3d000000-0000-4000-8000-000000000003', 'an-billing@test.invalid'),
  ('3d000000-0000-4000-8000-000000000004', 'an-readonly@test.invalid'),
  ('3d000000-0000-4000-8000-000000000005', 'an-capped@test.invalid');

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, is_super_admin, status) VALUES
  ('3d000000-0000-4000-8000-000000000001', 'an-owner@test.invalid',    'AN Owner',    'admin', NULL, NULL, false, 'active'),
  ('3d000000-0000-4000-8000-000000000002', 'an-support@test.invalid',  'AN Support',  'admin', NULL, NULL, false, 'active'),
  ('3d000000-0000-4000-8000-000000000003', 'an-billing@test.invalid',  'AN Billing',  'admin', NULL, NULL, false, 'active'),
  ('3d000000-0000-4000-8000-000000000004', 'an-readonly@test.invalid', 'AN Readonly', 'admin', NULL, NULL, false, 'active'),
  ('3d000000-0000-4000-8000-000000000005', 'an-capped@test.invalid',   'AN Capped',   'admin', NULL, NULL, false, 'active');

INSERT INTO app_private.platform_staff (user_id, role, note) VALUES
  ('3d000000-0000-4000-8000-000000000001', 'owner',     'an'),
  ('3d000000-0000-4000-8000-000000000002', 'support',   'an'),
  ('3d000000-0000-4000-8000-000000000003', 'billing',   'an'),
  ('3d000000-0000-4000-8000-000000000004', 'read_only', 'an'),
  ('3d000000-0000-4000-8000-000000000005', 'read_only', 'an');

-- ─── 1. privileges ──────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role text;
  r      record;
BEGIN
  PERFORM _an_reset();
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM _an_ok(format('%s holds no privilege on app_private.platform_announcements', v_role),
      NOT has_table_privilege(v_role, 'app_private.platform_announcements',
                              'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'));
  END LOOP;

  FOR r IN
    SELECT * FROM (VALUES
      -- signature                                                                     anon   authn  service
      ('public.platform_announcements_list()',                                         false, true,  false),
      ('public.platform_announcement_save(uuid,jsonb,integer)',                        false, true,  false),
      ('public.platform_announcement_delete(uuid,integer)',                            false, true,  false),
      ('public.get_app_config()',                                                      false, true,  false),
      ('app_private.platform_announcement_problem(jsonb)',                             false, false, false),
      ('app_private.platform_announcement_json(app_private.platform_announcements)',   false, false, false),
      ('app_private.announcements_for_company(uuid)',                                  false, false, false)
    ) AS t(sig, anon, authn, service)
  LOOP
    PERFORM _an_ok(format('EXECUTE on %s: anon %s, authenticated %s, service_role %s',
                          r.sig, r.anon, r.authn, r.service),
      has_function_privilege('anon',          r.sig::regprocedure, 'EXECUTE') = r.anon
      AND has_function_privilege('authenticated', r.sig::regprocedure, 'EXECUTE') = r.authn
      AND has_function_privilege('service_role',  r.sig::regprocedure, 'EXECUTE') = r.service);
  END LOOP;

  PERFORM _an_ok('a signed-in caller cannot read the table directly',
    _an_do('3d000000-0000-4000-8000-000000000001',
           'SELECT count(*)::text FROM app_private.platform_announcements') LIKE 'ERR 42501%');
END $$;

-- ─── 2. feature flags ───────────────────────────────────────────────────────

DO $$
DECLARE
  owner    constant uuid := '3d000000-0000-4000-8000-000000000001';
  support  constant uuid := '3d000000-0000-4000-8000-000000000002';
  billing  constant uuid := '3d000000-0000-4000-8000-000000000003';
  readonly constant uuid := '3d000000-0000-4000-8000-000000000004';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  editor_a constant uuid := 'a0000000-0000-4000-8000-000000000002';
  put      text;
BEGIN
  PERFORM _an_reset();
  PERFORM _an_ok('flags: seeded as the empty map, at version 1',
    app_private.platform_setting_value('feature_flags') = '{}'::jsonb
    AND (SELECT version = 1 FROM app_private.platform_settings WHERE key = 'feature_flags'));

  PERFORM _an_ok('flags: a company user reads the empty map through get_app_config',
    _an_do(admin_a, $q$SELECT (get_app_config() -> 'feature_flags')::text$q$) = '{}');

  put := $q$SELECT platform_settings_put('feature_flags', %L::jsonb, %s) ->> %L$q$;
  PERFORM _an_ok('flags: billing, support, read_only and a company admin may not write them',
    _an_do(billing,  format(put, '{"x": true}', 1, 'reason')) = 'forbidden'
    AND _an_do(support,  format(put, '{"x": true}', 1, 'reason')) = 'forbidden'
    AND _an_do(readonly, format(put, '{"x": true}', 1, 'reason')) = 'forbidden'
    AND _an_do(admin_a,  format(put, '{"x": true}', 1, 'reason')) = 'forbidden');
  PERFORM _an_ok('flags: a value that is not a boolean is refused, and named',
    _an_do(owner, format(put, '{"new_banner": "yes"}', 1, 'problem')) = 'feature_flags.new_banner'
    AND _an_do(owner, format(put, '{"new_banner": 1}', 1, 'problem')) = 'feature_flags.new_banner');
  PERFORM _an_ok('flags: a flag name that is not a plain identifier is refused',
    _an_do(owner, format(put, '{"New Banner": true}', 1, 'problem')) = 'feature_flags.key');
  PERFORM _an_ok('flags: a document that is not a map is refused',
    _an_do(owner, format(put, '["new_banner"]', 1, 'problem')) = 'feature_flags');

  PERFORM _an_ok('flags: an owner switches one on and one off',
    _an_do(owner, format(put, '{"new_banner": true, "old_export": false}', 1, 'ok')) = 'true');
  PERFORM _an_ok('flags: every signed-in company user reads them at once',
    _an_do(admin_a,  $q$SELECT (get_app_config() -> 'feature_flags')::text$q$)::jsonb
      = '{"new_banner": true, "old_export": false}'::jsonb
    AND _an_do(editor_a, $q$SELECT get_app_config() -> 'feature_flags' ->> 'new_banner'$q$) = 'true');
  PERFORM _an_ok('flags: anon reads nothing — get_public_config carries no flags',
    NOT (public.get_public_config() ? 'feature_flags'));
END $$;

-- ─── 3. writing an announcement ─────────────────────────────────────────────

DO $$
DECLARE
  owner    constant uuid := '3d000000-0000-4000-8000-000000000001';
  readonly constant uuid := '3d000000-0000-4000-8000-000000000004';
  v_id     uuid;
  v_doc    jsonb;
  v_out    jsonb;
BEGIN
  PERFORM _an_reset();

  v_doc := _an_doc('Wartung heute Nacht') || '{"tone": "warning", "title_en": "Maintenance tonight",
                                               "body_en": "Short downtime."}'::jsonb;
  v_out := _an_do(owner, format('SELECT platform_announcement_save(NULL, %L::jsonb, NULL)::text', v_doc))::jsonb;
  PERFORM _an_ok('write: an owner creates an announcement at version 1, and gets the row back',
    (v_out ->> 'ok') = 'true'
    AND (v_out -> 'item' ->> 'version')::integer = 1
    AND v_out -> 'item' ->> 'tone' = 'warning'
    AND v_out -> 'item' ->> 'title_en' = 'Maintenance tonight'
    AND v_out -> 'item' ->> 'created_by' = owner::text);
  v_id := (v_out -> 'item' ->> 'id')::uuid;

  v_out := _an_do(readonly, 'SELECT platform_announcements_list()::text')::jsonb;
  PERFORM _an_ok('write: the list carries it, audience and all',
    (v_out ->> 'ok') = 'true'
    AND jsonb_array_length(v_out -> 'items') = 1
    AND v_out -> 'items' -> 0 ->> 'id' = v_id::text
    AND v_out -> 'items' -> 0 ->> 'audience' = 'all'
    AND v_out -> 'items' -> 0 -> 'company_ids' = '[]'::jsonb);

  -- An update is pinned to the version the screen read.
  v_out := _an_do(owner, format('SELECT platform_announcement_save(%L, %L::jsonb, 1)::text',
                                v_id, v_doc || '{"title_de": "Wartung verschoben"}'::jsonb))::jsonb;
  PERFORM _an_ok('write: an update with the version read moves it to version 2',
    (v_out ->> 'ok') = 'true' AND (v_out -> 'item' ->> 'version')::integer = 2
    AND v_out -> 'item' ->> 'title_de' = 'Wartung verschoben');
  v_out := _an_do(owner, format('SELECT platform_announcement_save(%L, %L::jsonb, 1)::text', v_id, v_doc))::jsonb;
  PERFORM _an_ok('write: a stale version writes nothing and names the current one',
    (v_out ->> 'reason') = 'version_conflict' AND (v_out ->> 'current_version')::integer = 2);
  PERFORM _an_reset();
  PERFORM _an_ok('write: …and the row still says what the accepted update wrote',
    (SELECT title_de = 'Wartung verschoben' AND version = 2
       FROM app_private.platform_announcements WHERE id = v_id));

  PERFORM _an_ok('write: an update of an announcement that does not exist is not_found',
    _an_do(owner, format($q$SELECT platform_announcement_save(%L, %L::jsonb, 1) ->> 'reason'$q$,
                         gen_random_uuid(), v_doc)) = 'not_found');
  PERFORM _an_ok('write: create with a version, or update without one, is a broken contract',
    _an_do(owner, format('SELECT platform_announcement_save(NULL, %L::jsonb, 1)::text', v_doc)) LIKE 'ERR 22023%'
    AND _an_do(owner, format('SELECT platform_announcement_save(%L, %L::jsonb, NULL)::text', v_id, v_doc)) LIKE 'ERR 22023%');

  -- The document's shape, through the RPC.
  PERFORM _an_ok('write: a document without the German text is refused, and named',
    _an_do(owner, format($q$SELECT platform_announcement_save(NULL, %L::jsonb, NULL) ->> 'problem'$q$,
                         v_doc || '{"body_de": " "}'::jsonb)) = 'announcement.body_de');
  PERFORM _an_ok('write: half an English translation is refused',
    _an_do(owner, format($q$SELECT platform_announcement_save(NULL, %L::jsonb, NULL) ->> 'problem'$q$,
                         v_doc || '{"body_en": ""}'::jsonb)) = 'announcement.english');
  PERFORM _an_ok('write: a company that does not exist is refused, by index',
    _an_do(owner, format($q$SELECT platform_announcement_save(NULL, %L::jsonb, NULL) ->> 'problem'$q$,
                         _an_doc('x', 'companies', '[]',
                                 jsonb_build_array('c0000000-0000-4000-8000-00000000000a',
                                                   gen_random_uuid()::text)))) = 'announcement.company_ids.1');

  -- Delete, pinned the same way.
  PERFORM _an_ok('write: a delete with a stale version writes nothing',
    _an_do(owner, format($q$SELECT platform_announcement_delete(%L, 1) ->> 'reason'$q$, v_id)) = 'version_conflict');
  PERFORM _an_ok('write: a delete with the version read removes it',
    _an_do(owner, format($q$SELECT platform_announcement_delete(%L, 2) ->> 'ok'$q$, v_id)) = 'true');
  PERFORM _an_reset();
  PERFORM _an_ok('write: …and it is gone',
    NOT EXISTS (SELECT 1 FROM app_private.platform_announcements WHERE id = v_id));
END $$;

-- ─── 4. who may do what ─────────────────────────────────────────────────────

DO $$
DECLARE
  support  constant uuid := '3d000000-0000-4000-8000-000000000002';
  billing  constant uuid := '3d000000-0000-4000-8000-000000000003';
  readonly constant uuid := '3d000000-0000-4000-8000-000000000004';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_id     uuid;
  v_doc    jsonb := _an_doc('Rechte');
BEGIN
  v_id := _an_create(v_doc);

  PERFORM _an_ok('authority: read_only lists announcements (settings.read)',
    _an_do(readonly, $q$SELECT platform_announcements_list() ->> 'ok'$q$) = 'true');
  PERFORM _an_ok('authority: billing (settings.read for the prices alone) and support are refused the list',
    _an_do(billing, $q$SELECT platform_announcements_list() ->> 'reason'$q$) = 'forbidden'
    AND _an_do(support, $q$SELECT platform_announcements_list() ->> 'reason'$q$) = 'forbidden');
  PERFORM _an_ok('authority: only an owner writes — billing, support and read_only are refused a save',
    _an_do(billing,  format($q$SELECT platform_announcement_save(NULL, %L::jsonb, NULL) ->> 'reason'$q$, v_doc)) = 'forbidden'
    AND _an_do(support,  format($q$SELECT platform_announcement_save(NULL, %L::jsonb, NULL) ->> 'reason'$q$, v_doc)) = 'forbidden'
    AND _an_do(readonly, format($q$SELECT platform_announcement_save(NULL, %L::jsonb, NULL) ->> 'reason'$q$, v_doc)) = 'forbidden');
  PERFORM _an_ok('authority: …and a delete',
    _an_do(readonly, format($q$SELECT platform_announcement_delete(%L, 1) ->> 'reason'$q$, v_id)) = 'forbidden'
    AND _an_do(billing, format($q$SELECT platform_announcement_delete(%L, 1) ->> 'reason'$q$, v_id)) = 'forbidden');
  PERFORM _an_ok('authority: a company admin is refused all three',
    _an_do(admin_a, $q$SELECT platform_announcements_list() ->> 'reason'$q$) = 'forbidden'
    AND _an_do(admin_a, format($q$SELECT platform_announcement_save(NULL, %L::jsonb, NULL) ->> 'reason'$q$, v_doc)) = 'forbidden'
    AND _an_do(admin_a, format($q$SELECT platform_announcement_delete(%L, 1) ->> 'reason'$q$, v_id)) = 'forbidden');
  PERFORM _an_ok('authority: anon holds EXECUTE on none of them',
    _an_do(NULL, 'SELECT platform_announcements_list()::text') LIKE 'ERR 42501%'
    AND _an_do(NULL, format('SELECT platform_announcement_delete(%L, 1)::text', v_id)) LIKE 'ERR 42501%');

  PERFORM _an_reset();
  PERFORM _an_ok('authority: the refused delete left the announcement in place',
    EXISTS (SELECT 1 FROM app_private.platform_announcements WHERE id = v_id AND version = 1));
  DELETE FROM app_private.platform_announcements;
END $$;

-- ─── 5. the window ──────────────────────────────────────────────────────────

/*
  An announcement applies while starts_at <= now() < ends_at. Both are
  timestamps with their offset: a date compared with current_date would mean
  midnight in the database's zone — UTC here — where the owner meant midnight
  in Berlin. So a time without an offset is refused, and one with an offset
  means the same instant whatever zone the session is in.
*/
DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_id    uuid;
  v_doc   jsonb;
BEGIN
  PERFORM _an_reset();
  PERFORM _an_create(_an_doc('läuft seit einer Stunde'));
  PERFORM _an_create(_an_doc('läuft bis in einer Stunde', p_starts => now() - interval '2 hours',
                                                          p_ends   => now() + interval '1 hour'));
  PERFORM _an_create(_an_doc('beginnt morgen',  p_starts => now() + interval '1 day'));
  PERFORM _an_create(_an_doc('seit einer Stunde vorbei', p_starts => now() - interval '1 day',
                                                         p_ends   => now() - interval '1 hour'));

  PERFORM _an_ok('window: a company sees what has started and not yet ended, newest start first',
    _an_titles(admin_a) = ARRAY['läuft seit einer Stunde', 'läuft bis in einer Stunde']);

  -- The same instant written with a +02:00 offset, from a session in a zone
  -- fourteen hours ahead of UTC: the stored instant is the one the offset
  -- names, not the session's reading of the wall-clock time.
  v_doc := _an_doc('Kiritimati') || jsonb_build_object(
    'starts_at', to_char((now() - interval '30 minutes') AT TIME ZONE 'UTC' + interval '2 hours',
                         'YYYY-MM-DD"T"HH24:MI:SS') || '+02:00',
    'ends_at',   to_char((now() + interval '30 minutes') AT TIME ZONE 'UTC' + interval '2 hours',
                         'YYYY-MM-DD"T"HH24:MI:SS') || '+02:00');
  PERFORM set_config('TimeZone', 'Pacific/Kiritimati', true);
  v_id := _an_create(v_doc);
  PERFORM set_config('TimeZone', 'UTC', true);
  PERFORM _an_ok('window: an offset is read as written, whatever zone the session is in',
    (SELECT abs(extract(epoch FROM starts_at - (now() - interval '30 minutes'))) < 1
            AND abs(extract(epoch FROM ends_at - (now() + interval '30 minutes'))) < 1
       FROM app_private.platform_announcements WHERE id = v_id));
  PERFORM _an_ok('window: …and it is showing now',
    'Kiritimati' = ANY (_an_titles(admin_a)));

  PERFORM _an_ok('window: a time without an offset is refused — it would mean the session''s zone',
    app_private.platform_announcement_problem(v_doc || '{"starts_at": "2026-09-20T00:00:00"}'::jsonb)
      = 'announcement.starts_at'
    AND app_private.platform_announcement_problem(v_doc || '{"starts_at": "2026-09-20"}'::jsonb)
      = 'announcement.starts_at'
    AND app_private.platform_announcement_problem(v_doc || '{"ends_at": "2026-09-21"}'::jsonb)
      = 'announcement.ends_at');
  PERFORM _an_ok('window: an end at or before the start is refused',
    app_private.platform_announcement_problem(v_doc || jsonb_build_object('ends_at', v_doc ->> 'starts_at'))
      = 'announcement.ends_at');

  DELETE FROM app_private.platform_announcements;
END $$;

-- ─── 6. who sees which ──────────────────────────────────────────────────────

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  admin_b constant uuid := 'b0000000-0000-4000-8000-000000000001';
  super   constant uuid := '50000000-0000-4000-8000-000000000001';
  v_out   jsonb;
  v_i     integer;
BEGIN
  PERFORM _an_reset();
  -- The plans are set here rather than taken from the seed: files before this
  -- one move them (assertions.sql leaves company A on premium). A on basic, B on
  -- advanced, so a plan audience has to tell them apart. Undone by the ROLLBACK.
  UPDATE public.companies SET plan = 'basic'    WHERE id = 'c0000000-0000-4000-8000-00000000000a';
  UPDATE public.companies SET plan = 'advanced' WHERE id = 'c0000000-0000-4000-8000-00000000000b';

  PERFORM _an_create(_an_doc('an alle'));
  PERFORM _an_create(_an_doc('an basic', 'plans', '["basic"]', p_starts => now() - interval '2 hours'));
  PERFORM _an_create(_an_doc('an advanced und premium', 'plans', '["premium", "advanced"]',
                             p_starts => now() - interval '3 hours'));
  PERFORM _an_create(_an_doc('an B', 'companies', '[]', '["c0000000-0000-4000-8000-00000000000b"]',
                             p_starts => now() - interval '4 hours'));

  PERFORM _an_ok('audience: company A (basic) sees every company''s and its plan''s, not B''s nor the other plans''',
    _an_titles(admin_a) = ARRAY['an alle', 'an basic']);
  PERFORM _an_ok('audience: company B (advanced) sees every company''s, its plan''s and its own',
    _an_titles(admin_b) = ARRAY['an alle', 'an advanced und premium', 'an B']);
  PERFORM _an_ok('audience: a platform account outside a support session sees none — they are for customers',
    _an_titles(super) = ARRAY[]::text[]);

  -- What a tenant receives: never the audience, which would say who the
  -- platform's other customers are.
  v_out := _an_do(admin_b, $q$SELECT (get_app_config() -> 'announcements')::text$q$)::jsonb;
  PERFORM _an_ok('audience: a tenant receives the id, version, tone, texts and window — and nothing else',
    (SELECT bool_and(app_private.settings_object_keys(e)
                     = ARRAY['body_de', 'body_en', 'ends_at', 'id', 'starts_at', 'title_de', 'title_en', 'tone', 'version'])
       FROM jsonb_array_elements(v_out) AS a(e))
    AND v_out::text NOT LIKE '%c0000000-0000-4000-8000-00000000000b%');

  -- A company the screens refuse gets nothing either: get_active_company_id()
  -- answers NULL for it.
  UPDATE public.companies SET status = 'suspended' WHERE id = 'c0000000-0000-4000-8000-00000000000b';
  PERFORM _an_ok('audience: a suspended company is shown nothing',
    _an_titles(admin_b) = ARRAY[]::text[]);
  UPDATE public.companies SET status = 'active' WHERE id = 'c0000000-0000-4000-8000-00000000000b';

  -- At most five, newest start first.
  FOR v_i IN 1 .. 6 LOOP
    PERFORM _an_create(_an_doc('neu ' || v_i, p_starts => now() - make_interval(mins => v_i)));
  END LOOP;
  PERFORM _an_ok('audience: at most five, the newest start first',
    _an_titles(admin_a) = ARRAY['neu 1', 'neu 2', 'neu 3', 'neu 4', 'neu 5']);

  DELETE FROM app_private.platform_announcements;
END $$;

-- ─── 7. the audit log ───────────────────────────────────────────────────────

DO $$
DECLARE
  owner    constant uuid := '3d000000-0000-4000-8000-000000000001';
  billing  constant uuid := '3d000000-0000-4000-8000-000000000003';
  readonly constant uuid := '3d000000-0000-4000-8000-000000000004';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _an_reset();

  PERFORM _an_ok('audit: a list names how many it read, never their text',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log
             WHERE action = 'platform_announcements.list' AND outcome = 'ok' AND category = 'read'
               AND actor_user_id = readonly AND after_value ? 'count' AND before_value IS NULL
               AND NOT (after_value ? 'items')));
  PERFORM _an_ok('audit: a create keeps the row after, an update the row before and after',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log
             WHERE action = 'platform_announcements.save' AND outcome = 'ok' AND category = 'settings'
               AND actor_user_id = owner AND before_value IS NULL
               AND after_value ->> 'title_de' = 'Wartung heute Nacht')
    AND EXISTS (SELECT 1 FROM app_private.platform_audit_log
                 WHERE action = 'platform_announcements.save' AND outcome = 'ok'
                   AND before_value ->> 'title_de' = 'Wartung heute Nacht'
                   AND after_value ->> 'title_de' = 'Wartung verschoben'));
  PERFORM _an_ok('audit: a delete keeps what was deleted',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log
             WHERE action = 'platform_announcements.delete' AND outcome = 'ok'
               AND before_value ->> 'title_de' = 'Wartung verschoben' AND after_value IS NULL));
  PERFORM _an_ok('audit: refusals are recorded — denied for a capability, error for a value or a version',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log
             WHERE action = 'platform_announcements.save' AND outcome = 'denied' AND actor_user_id = billing)
    AND EXISTS (SELECT 1 FROM app_private.platform_audit_log
                 WHERE action = 'platform_announcements.list' AND outcome = 'denied' AND actor_user_id = billing)
    AND EXISTS (SELECT 1 FROM app_private.platform_audit_log
                 WHERE action = 'platform_announcements.save' AND outcome = 'error'
                   AND after_value ->> 'problem' = 'announcement.english')
    AND EXISTS (SELECT 1 FROM app_private.platform_audit_log
                 WHERE action = 'platform_announcements.delete' AND outcome = 'error'
                   AND after_value ->> 'reason' = 'version_conflict'));
  PERFORM _an_ok('audit: a company admin''s refused calls left no row at all',
    NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log WHERE actor_user_id = admin_a));
END $$;

-- ─── 8. the settings budget ─────────────────────────────────────────────────

DO $$
DECLARE
  capped constant uuid := '3d000000-0000-4000-8000-000000000005';
  v_i    integer;
  v_rows bigint;
BEGIN
  PERFORM _an_become(capped);
  FOR v_i IN 1 .. 120 LOOP
    PERFORM public.platform_announcements_list();
  END LOOP;
  PERFORM _an_reset();
  SELECT count(*) INTO v_rows FROM app_private.platform_audit_log WHERE actor_user_id = capped;

  PERFORM _an_ok('budget: 120 lists are answered and recorded',
    v_rows = 120);
  PERFORM _an_ok('budget: the 121st settings call of the minute is refused, list or settings read alike',
    _an_do(capped, $q$SELECT platform_announcements_list() ->> 'reason'$q$) = 'rate_limited'
    AND _an_do(capped, $q$SELECT platform_settings_get('feature_flags') ->> 'reason'$q$) = 'rate_limited');
  PERFORM _an_reset();
  PERFORM _an_ok('budget: …and those refusals wrote nothing',
    (SELECT count(*) FROM app_private.platform_audit_log WHERE actor_user_id = capped) = 120);
END $$;

-- ─── 9. forgery ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  readonly constant uuid := '3d000000-0000-4000-8000-000000000004';
  v_action text;
BEGIN
  -- The database writes these rows itself. platform_audit_record's allow-list
  -- names none of them, so no staff role can forge one through that door.
  FOREACH v_action IN ARRAY ARRAY['platform_announcements.list', 'platform_announcements.save',
                                  'platform_announcements.delete', 'platform_settings.invoice_seller'] LOOP
    PERFORM _an_ok(format('forgery: platform_audit_record refuses %s', v_action),
      _an_do(readonly, format('SELECT platform_audit_record(%L, %L, %L)::text', 'read', v_action, 'ok'))
        LIKE 'ERR 22023%');
  END LOOP;
END $$;

DO $$ BEGIN RAISE NOTICE '── announcements: all checks passed ──'; END $$;

ROLLBACK;
