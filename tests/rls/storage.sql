/*
  Storage (migration 20260920100000): who reads and who writes a company's
  files, and in which kind of session.

  Runs after assertions.sql and the matrix, against the same throwaway database,
  as supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it
  see the database as the seeds left it.

  The fixture is a --schema=public dump and carries no storage policy at all;
  what is tested here is exactly what the migration chain creates on top of
  tests/fixtures/storage-shim.sql — the four buckets 20260920100000 restates in
  full, and salary-receipts as 20260917130000 left it. The shim has no bucket
  rows but salary-receipts', so the other four are created below.

  ## Cells

  Each bucket and principal is one line of four pairs, read / insert / update /
  delete, each pair the outcome on company X's object then on company Y's:

    Y  allowed — the object was visible, inserted, updated or deleted
    .  silently nothing — RLS filtered the object out
    R  refused by a WITH CHECK (42501)
    E  anything else — the raw answer is printed beside the cells

  An UPDATE rewrites the object's metadata in place, so it reaches the UPDATE
  policy's USING. The move probes take the object with SELECT … FOR UPDATE and
  rename it into the other company's folder with UPDATE … WHERE CURRENT OF,
  which reads no column, so the new row meets the UPDATE policy's WITH CHECK
  and nothing else (matrix.sql explains why a plain UPDATE would hide it).

  ## Claim shapes

    kit      the singular request.jwt.claim.* GUCs every other file uses
    storage  what storage-api v1.19.3 sets: the singular subject and role, and
             the whole payload as request.jwt.claims — no singular amr and no
             singular session_id. 20260920100000 teaches jwt_amr() to read
             this shape; without that, every platform account holds no role on
             every storage-api request.

  PostgREST's shape (the document alone) cannot be probed here: the image's
  auth.uid() reads only the singular subject, which is why every file in this
  directory uses the singular form.

  What is covered, in order:

    0. catalogue    the fifteen policies by production's names; every storage
                    policy pins a bucket
    1. anon         nothing
    2. members      each bucket's member rule, unchanged — no role gate on three,
                    the administrator gate on company-logos, no UPDATE on
                    fahrtenbuch-files, no DELETE on salary-receipts; and a
                    member of a suspended company still reaches its own files
    3. no context   a platform account that has opened nothing reaches nothing,
                    even with `admin` written on its profile
    4. view         reads the opened company, writes nothing in any bucket
    5. support      reads and writes the opened company only, and cannot move
                    a file out of it
    6. storage-api  the same answers in storage-api's claim shape, and none for
                    a Google session or a document that names someone else
    7. closed       a closed context reaches nothing
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in platform-contexts.sql) ─────────────────────────────

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

CREATE OR REPLACE FUNCTION _st_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _st_is(p_desc text, p_got text, p_want text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION 'FAIL: % — expected [%], got [%]', p_desc, p_want, p_got;
  END IF;
  RAISE NOTICE 'ok  % [%]', p_desc, p_got;
END $$;

CREATE OR REPLACE FUNCTION _st_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('st:' || p_what)::uuid $$;

CREATE OR REPLACE FUNCTION _st_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

/*
  Become a caller. NULL user: anon. p_shape is one of
    kit            singular claims, amr password
    storage        storage-api's shape, amr password
    storage-oauth  storage-api's shape, a Google session
    storage-other  storage-api's shape, a document naming another subject
*/
CREATE OR REPLACE FUNCTION _st_as(p_user uuid, p_session uuid, p_shape text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  c_password CONSTANT jsonb := '[{"method": "password", "timestamp": 1789416052}]';
  c_oauth    CONSTANT jsonb := '[{"method": "oauth", "timestamp": 1789416052}]';
BEGIN
  PERFORM _st_reset();
  IF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  IF p_shape = 'kit' THEN
    PERFORM set_config('request.jwt.claim.amr', c_password::text, true);
    IF p_session IS NOT NULL THEN
      PERFORM set_config('request.jwt.claim.session_id', p_session::text, true);
    END IF;
  ELSIF p_shape IN ('storage', 'storage-oauth', 'storage-other') THEN
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object(
        'sub',        CASE WHEN p_shape = 'storage-other' THEN _st_id('user:nobody') ELSE p_user END,
        'role',       'authenticated',
        'session_id', p_session,
        'amr',        CASE WHEN p_shape = 'storage-oauth' THEN c_oauth ELSE c_password END)::text,
      true);
  ELSE
    RAISE EXCEPTION '_st_as: unknown claim shape %', p_shape;
  END IF;

  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/*
  Run p_sql as that caller in a subtransaction that is always rolled back, and
  return the scalar it answered, `rows N` for a statement without a result, or
  `ERR <sqlstate> <message>`. Nothing it writes survives.
*/
CREATE OR REPLACE FUNCTION _st_try(p_user uuid, p_session uuid, p_sql text, p_shape text DEFAULT 'kit')
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _st_as(p_user, p_session, p_shape);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ021', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ021' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _st_reset();
  RETURN v_out;
END $$;

/** The seeded object of one company in one bucket. */
CREATE OR REPLACE FUNCTION _st_obj(p_company uuid) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT p_company::text || '/seed.bin' $$;

/*
  One line of cells for one caller on one bucket: read, insert, update and
  delete, each on company A's object then company B's (X and Y unless given).
*/
CREATE OR REPLACE FUNCTION _st_cells(p_user uuid, p_session uuid, p_bucket text,
                                     p_shape text DEFAULT 'kit',
                                     p_a uuid DEFAULT NULL, p_b uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_a     uuid := coalesce(p_a, _st_id('company:x'));
  v_b     uuid := coalesce(p_b, _st_id('company:y'));
  v_co    uuid;
  v_raw   text;
  v_cells text := '';
  v_odd   text := '';
  v_op    text;
BEGIN
  FOREACH v_op IN ARRAY ARRAY['read', 'insert', 'update', 'delete'] LOOP
    IF v_op <> 'read' THEN
      v_cells := v_cells || ' ';
    END IF;
    FOREACH v_co IN ARRAY ARRAY[v_a, v_b] LOOP
      v_raw := _st_try(p_user, p_session,
        CASE v_op
          WHEN 'read' THEN
            format('SELECT count(*)::text FROM storage.objects WHERE bucket_id = %L AND name = %L',
                   p_bucket, _st_obj(v_co))
          WHEN 'insert' THEN
            format('INSERT INTO storage.objects (bucket_id, name) VALUES (%L, %L)',
                   p_bucket, v_co::text || '/probe.bin')
          WHEN 'update' THEN
            format('UPDATE storage.objects SET metadata = %L::jsonb WHERE bucket_id = %L AND name = %L',
                   '{"st": 1}', p_bucket, _st_obj(v_co))
          ELSE
            format('DELETE FROM storage.objects WHERE bucket_id = %L AND name = %L',
                   p_bucket, _st_obj(v_co))
        END,
        p_shape);
      v_cells := v_cells || CASE
        WHEN v_op = 'read' AND v_raw = '1' THEN 'Y'
        WHEN v_op = 'read' AND v_raw = '0' THEN '.'
        WHEN v_op <> 'read' AND v_raw = 'rows 1' THEN 'Y'
        WHEN v_op <> 'read' AND v_raw = 'rows 0' THEN '.'
        WHEN v_raw LIKE 'ERR 42501%' THEN 'R'
        ELSE 'E'
      END;
      IF v_raw NOT IN ('1', '0', 'rows 1', 'rows 0') AND v_raw NOT LIKE 'ERR 42501%' THEN
        v_odd := v_odd || format(' {%s %s: %s}', v_op, v_co, v_raw);
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_cells || v_odd;
END $$;

/*
  The move probe: take company A's object as the caller with SELECT … FOR
  UPDATE, then rename it into company B's folder WHERE CURRENT OF. `.` when the
  caller cannot take it, `Y` when it moved, `R` when the WITH CHECK refused.
*/
CREATE OR REPLACE FUNCTION _st_move(p_user uuid, p_session uuid, p_bucket text,
                                    p_shape text DEFAULT 'kit')
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_cur   refcursor := 'st_move';
  v_row   int;
  v_n     bigint := 0;
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _st_as(p_user, p_session, p_shape);
    OPEN v_cur FOR EXECUTE format(
      'SELECT 1 FROM storage.objects WHERE bucket_id = %L AND name = %L FOR UPDATE',
      p_bucket, _st_obj(_st_id('company:x')));
    FETCH v_cur INTO v_row;
    IF FOUND THEN
      EXECUTE format('UPDATE storage.objects SET name = %L WHERE CURRENT OF st_move',
                     _st_id('company:y')::text || '/moved.bin');
      GET DIAGNOSTICS v_n = ROW_COUNT;
    END IF;
    CLOSE v_cur;
    RAISE EXCEPTION USING ERRCODE = 'ZZ022', MESSAGE = v_n::text;
  EXCEPTION
    WHEN SQLSTATE 'ZZ022' THEN
      v_out := CASE WHEN SQLERRM::bigint > 0 THEN 'Y' ELSE '.' END;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := CASE WHEN v_state = '42501' THEN 'R' ELSE 'E ' || v_state || ' ' || v_msg END;
  END;
  PERFORM _st_reset();
  RETURN v_out;
END $$;

-- ─── buckets, principals, objects, contexts ─────────────────────────────────
--
-- Production's bucket flags (19.09.2026). salary-receipts comes from
-- 20260914140000 and is left as it is.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
  ('documents',             'documents',             false, NULL, NULL),
  ('fahrtenbuch-files',     'fahrtenbuch-files',     false, 52428800,
     ARRAY['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream']),
  ('company-logos',         'company-logos',         true,  NULL, NULL),
  ('stundennachweise-pdfs', 'stundennachweise-pdfs', false, 10485760, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- X and Y are healthy. Z is suspended and unsubscribed: its member still
-- reaches its own files, because storage reads the account shell's term.
INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
VALUES
  (_st_id('company:x'), 'ST X', 'st-x', 'approved', 'active',    'basic', 'active'),
  (_st_id('company:y'), 'ST Y', 'st-y', 'approved', 'active',    'basic', 'active'),
  (_st_id('company:z'), 'ST Z', 'st-z', 'approved', 'suspended', 'basic', 'inactive')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT _st_id('user:' || v.who), 'st-' || v.who || '@test.invalid', now()
FROM (VALUES ('admin-x'), ('viewer-x'), ('admin-y'), ('admin-z'),
             ('view-owner'), ('view-ro'), ('support'), ('idle')) AS v(who)
ON CONFLICT (id) DO NOTHING;

-- Platform accounts carry no company and the text role `viewer`, as
-- platform-staff writes them, so nothing a platform account writes below is
-- its profile's doing.
INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
SELECT _st_id('user:' || v.who), 'st-' || v.who || '@test.invalid', 'ST ' || v.who, v.role,
       (SELECT id FROM roles WHERE name = v.role AND company_id IS NULL LIMIT 1),
       v.company_id, 'active'
FROM (VALUES
  ('admin-x',    'admin',  _st_id('company:x')),
  ('viewer-x',   'viewer', _st_id('company:x')),
  ('admin-y',    'admin',  _st_id('company:y')),
  ('admin-z',    'admin',  _st_id('company:z')),
  ('view-owner', 'viewer', NULL::uuid),
  ('view-ro',    'viewer', NULL::uuid),
  ('support',    'viewer', NULL::uuid),
  ('idle',       'viewer', NULL::uuid)
) AS v(who, role, company_id)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
SELECT _st_id('user:' || v.who), v.role, 'st'
FROM (VALUES ('view-owner', 'owner'), ('view-ro', 'read_only'),
             ('support', 'support'), ('idle', 'owner')) AS v(who, role)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
SELECT _st_id('session:' || v.who), _st_id('user:' || v.who)
FROM (VALUES ('view-owner'), ('view-ro'), ('support'), ('idle')) AS v(who)
ON CONFLICT (id) DO NOTHING;

-- One object per company in every bucket, written as the superuser.
INSERT INTO storage.objects (bucket_id, name)
SELECT b.id, _st_obj(c.id)
FROM (VALUES ('documents'), ('fahrtenbuch-files'), ('company-logos'),
             ('stundennachweise-pdfs'), ('salary-receipts')) AS b(id)
CROSS JOIN (VALUES (_st_id('company:x')), (_st_id('company:y')), (_st_id('company:z'))) AS c(id);

-- The contexts are written directly: opening one is platform-contexts.sql's
-- subject, and a context row is exactly what platform_context_open() leaves.
INSERT INTO app_private.platform_company_contexts
  (staff_user_id, company_id, mode, reason, session_id, expires_at)
VALUES
  (_st_id('user:view-owner'), _st_id('company:x'), 'view',    NULL,
   _st_id('session:view-owner'), now() + interval '60 minutes'),
  (_st_id('user:view-ro'),    _st_id('company:x'), 'view',    NULL,
   _st_id('session:view-ro'),    now() + interval '60 minutes'),
  (_st_id('user:support'),    _st_id('company:x'), 'support', 'ST storage ticket',
   _st_id('session:support'),    now() + interval '60 minutes');

-- ─── 0. the catalogue ───────────────────────────────────────────────────────
--
-- Asked after the whole chain has applied, so a later migration that brings a
-- policy back by another name, or one that names no bucket, fails here.

DO $$
DECLARE
  v_wrong text;
BEGIN
  SELECT string_agg(coalesce(e.policyname, a.policyname) || ' ('
                    || CASE WHEN e.policyname IS NULL THEN 'unexpected' ELSE 'missing' END || ')',
                    '; ' ORDER BY coalesce(e.policyname, a.policyname))
    INTO v_wrong
    FROM (VALUES
      ('Company users can read own documents',       'SELECT'),
      ('Company users can upload documents',         'INSERT'),
      ('Company users can update own documents',     'UPDATE'),
      ('Company users can delete own documents',     'DELETE'),
      ('fahrtenbuch_files_select',                   'SELECT'),
      ('fahrtenbuch_files_insert',                   'INSERT'),
      ('fahrtenbuch_files_delete',                   'DELETE'),
      ('Company members can read own company logo',  'SELECT'),
      ('Company admins can upload own company logo', 'INSERT'),
      ('Company admins can update own company logo', 'UPDATE'),
      ('Company admins can delete own company logo', 'DELETE'),
      ('stundennachweise_pdf_select',                'SELECT'),
      ('stundennachweise_pdf_insert',                'INSERT'),
      ('stundennachweise_pdf_update',                'UPDATE'),
      ('stundennachweise_pdf_delete',                'DELETE')
    ) AS e(policyname, cmd)
    FULL JOIN (
      SELECT p.policyname::text AS policyname, p.cmd::text AS cmd
        FROM pg_policies p
       WHERE p.schemaname::text = 'storage' AND p.tablename::text = 'objects'
         AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''))
             ~ '''(documents|fahrtenbuch-files|company-logos|stundennachweise-pdfs)'''
    ) AS a
      ON a.policyname = e.policyname AND a.cmd = e.cmd
   WHERE e.policyname IS NULL OR a.policyname IS NULL;
  PERFORM _st_ok(format('catalogue: the four buckets carry exactly production''s fifteen policies [%s]',
                        coalesce(v_wrong, 'as expected')),
    v_wrong IS NULL);

  SELECT string_agg(p.policyname::text, ', ' ORDER BY p.policyname::text) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname::text = 'storage' AND p.tablename::text = 'objects'
     AND p.permissive::text = 'PERMISSIVE'
     AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'bucket_id = ''';
  PERFORM _st_ok(format('catalogue: every permissive storage policy pins a bucket [%s]',
                        coalesce(v_wrong, 'all do')),
    v_wrong IS NULL);

  PERFORM _st_ok('catalogue: no storage policy names the bucket "Y & A Mobility" — nothing here changes it',
    NOT EXISTS (SELECT 1 FROM pg_policies p
                 WHERE p.schemaname::text = 'storage'
                   AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'Y & A Mobility'));
END $$;

-- ─── sanity: the contexts are what the sections below assume ────────────────

DO $$
DECLARE
  co_x constant text := _st_id('company:x')::text;
BEGIN
  PERFORM _st_ok('sanity: the view contexts are open on X, in view mode',
    _st_try(_st_id('user:view-owner'), _st_id('session:view-owner'), 'SELECT platform_view_company_id()::text') = co_x
    AND _st_try(_st_id('user:view-owner'), _st_id('session:view-owner'), 'SELECT platform_support_company_id()::text') = '<null>'
    AND _st_try(_st_id('user:view-ro'), _st_id('session:view-ro'), 'SELECT platform_view_company_id()::text') = co_x
    AND _st_try(_st_id('user:view-ro'), _st_id('session:view-ro'), 'SELECT platform_support_company_id()::text') = '<null>');
  PERFORM _st_ok('sanity: the support session is open on X, in support mode',
    _st_try(_st_id('user:support'), _st_id('session:support'), 'SELECT platform_support_company_id()::text') = co_x);
  PERFORM _st_ok('sanity: the idle platform account has nothing open',
    _st_try(_st_id('user:idle'), _st_id('session:idle'), 'SELECT platform_view_company_id()::text') = '<null>');
  PERFORM _st_ok('sanity: every seeded object is there, five buckets by three companies',
    (SELECT count(*) FROM storage.objects
      WHERE name IN (_st_obj(_st_id('company:x')), _st_obj(_st_id('company:y')),
                     _st_obj(_st_id('company:z')))) = 15);
END $$;

-- ─── 1. anon ────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bucket text;
BEGIN
  FOREACH v_bucket IN ARRAY ARRAY['documents', 'fahrtenbuch-files', 'company-logos',
                                  'stundennachweise-pdfs', 'salary-receipts'] LOOP
    PERFORM _st_is(format('anon: %s — nothing', v_bucket),
      _st_cells(NULL, NULL, v_bucket), '.. RR .. ..');
  END LOOP;
END $$;

-- ─── 2. members: each bucket's rule, unchanged ──────────────────────────────

DO $$
DECLARE
  admin_x  constant uuid := _st_id('user:admin-x');
  viewer_x constant uuid := _st_id('user:viewer-x');
  admin_y  constant uuid := _st_id('user:admin-y');
  admin_z  constant uuid := _st_id('user:admin-z');
BEGIN
  -- documents and stundennachweise-pdfs: any member of the company, no role
  -- gate, all four commands.
  PERFORM _st_is('member: documents — an admin of X reads and writes X, never Y',
    _st_cells(admin_x, NULL, 'documents'), 'Y. YR Y. Y.');
  PERFORM _st_is('member: documents — a viewer of X too: this bucket never had a role gate',
    _st_cells(viewer_x, NULL, 'documents'), 'Y. YR Y. Y.');
  PERFORM _st_is('member: documents — an admin of Y reaches only Y',
    _st_cells(admin_y, NULL, 'documents'), '.Y RY .Y .Y');
  PERFORM _st_is('member: stundennachweise-pdfs — an admin of X',
    _st_cells(admin_x, NULL, 'stundennachweise-pdfs'), 'Y. YR Y. Y.');
  PERFORM _st_is('member: stundennachweise-pdfs — a viewer of X, no role gate',
    _st_cells(viewer_x, NULL, 'stundennachweise-pdfs'), 'Y. YR Y. Y.');
  PERFORM _st_is('member: stundennachweise-pdfs — an admin of Y',
    _st_cells(admin_y, NULL, 'stundennachweise-pdfs'), '.Y RY .Y .Y');

  -- fahrtenbuch-files: no role gate, and no UPDATE policy for anybody.
  PERFORM _st_is('member: fahrtenbuch-files — an admin of X reads, uploads and deletes X; nobody updates',
    _st_cells(admin_x, NULL, 'fahrtenbuch-files'), 'Y. YR .. Y.');
  PERFORM _st_is('member: fahrtenbuch-files — a viewer of X the same',
    _st_cells(viewer_x, NULL, 'fahrtenbuch-files'), 'Y. YR .. Y.');
  PERFORM _st_is('member: fahrtenbuch-files — an admin of Y',
    _st_cells(admin_y, NULL, 'fahrtenbuch-files'), '.Y RY .. .Y');

  -- company-logos: every member reads, only an administrator writes.
  PERFORM _st_is('member: company-logos — an admin of X reads and writes X',
    _st_cells(admin_x, NULL, 'company-logos'), 'Y. YR Y. Y.');
  PERFORM _st_is('member: company-logos — a viewer of X reads and writes nothing',
    _st_cells(viewer_x, NULL, 'company-logos'), 'Y. RR .. ..');
  PERFORM _st_is('member: company-logos — an admin of Y',
    _st_cells(admin_y, NULL, 'company-logos'), '.Y RY .Y .Y');

  -- salary-receipts, as 20260917130000 left it: salaries edit to write, no
  -- DELETE at all.
  PERFORM _st_is('member: salary-receipts — an admin of X uploads and replaces, deletes nothing',
    _st_cells(admin_x, NULL, 'salary-receipts'), 'Y. YR Y. ..');
  PERFORM _st_is('member: salary-receipts — a viewer of X only reads',
    _st_cells(viewer_x, NULL, 'salary-receipts'), 'Y. RR .. ..');

  -- A member moves nothing out of its own company either.
  PERFORM _st_is('member: an admin of X cannot move a document into Y',
    _st_move(admin_x, NULL, 'documents'), 'R');
  PERFORM _st_is('member: …nor a logo',
    _st_move(admin_x, NULL, 'company-logos'), 'R');
  PERFORM _st_is('member: …nor a Stundennachweis',
    _st_move(admin_x, NULL, 'stundennachweise-pdfs'), 'R');

  -- The read stays on the account shell's term: a suspended, unsubscribed
  -- company's member still reaches its own files, exactly as before.
  PERFORM _st_is('member: a suspended company''s admin still reads and writes its own documents',
    _st_cells(admin_z, NULL, 'documents', 'kit', _st_id('company:z'), _st_id('company:x')), 'Y. YR Y. Y.');
  PERFORM _st_is('member: …and its own Fahrtenbuch originals',
    _st_cells(admin_z, NULL, 'fahrtenbuch-files', 'kit', _st_id('company:z'), _st_id('company:x')), 'Y. YR .. Y.');
END $$;

-- ─── 3. a platform account with nothing open ────────────────────────────────

DO $$
DECLARE
  v_bucket text;
BEGIN
  FOREACH v_bucket IN ARRAY ARRAY['documents', 'fahrtenbuch-files', 'company-logos',
                                  'stundennachweise-pdfs', 'salary-receipts'] LOOP
    PERFORM _st_is(format('no context: %s — an owner that has opened nothing reaches nothing', v_bucket),
      _st_cells(_st_id('user:idle'), _st_id('session:idle'), v_bucket), '.. RR .. ..');
    -- seed.sql's platform owner carries the text role `admin` and no company.
    -- The logo gate's member half reads that role; the company term is what
    -- still refuses it.
    PERFORM _st_is(format('no context: %s — nor does one whose profile says admin', v_bucket),
      _st_cells('50000000-0000-4000-8000-000000000001', NULL, v_bucket), '.. RR .. ..');
  END LOOP;
END $$;

-- ─── 4. a view context reads and writes nothing ─────────────────────────────

DO $$
DECLARE
  v_bucket text;
  v_who    text;
BEGIN
  FOREACH v_who IN ARRAY ARRAY['view-owner', 'view-ro'] LOOP
    FOREACH v_bucket IN ARRAY ARRAY['documents', 'fahrtenbuch-files', 'company-logos',
                                    'stundennachweise-pdfs', 'salary-receipts'] LOOP
      PERFORM _st_is(format('view (%s): %s — reads X, writes nothing anywhere', v_who, v_bucket),
        _st_cells(_st_id('user:' || v_who), _st_id('session:' || v_who), v_bucket), 'Y. RR .. ..');
    END LOOP;
    FOREACH v_bucket IN ARRAY ARRAY['documents', 'company-logos', 'stundennachweise-pdfs'] LOOP
      PERFORM _st_is(format('view (%s): %s — cannot even take X''s file to move it', v_who, v_bucket),
        _st_move(_st_id('user:' || v_who), _st_id('session:' || v_who), v_bucket), '.');
    END LOOP;
  END LOOP;
END $$;

-- ─── 5. a support session reads and writes the opened company only ──────────

DO $$
DECLARE
  u constant uuid := _st_id('user:support');
  s constant uuid := _st_id('session:support');
BEGIN
  PERFORM _st_is('support: documents — reads and writes X, never Y',
    _st_cells(u, s, 'documents'), 'Y. YR Y. Y.');
  PERFORM _st_is('support: fahrtenbuch-files — imports and deletes X''s originals; nobody updates one',
    _st_cells(u, s, 'fahrtenbuch-files'), 'Y. YR .. Y.');
  -- The support account's profile says `viewer`: it passes the logo gate
  -- through is_company_admin(), which 3.4a answers true only inside a support
  -- session.
  PERFORM _st_is('support: company-logos — writes X''s logo although its profile is a viewer''s',
    _st_cells(u, s, 'company-logos'), 'Y. YR Y. Y.');
  PERFORM _st_is('support: stundennachweise-pdfs — reads and writes X',
    _st_cells(u, s, 'stundennachweise-pdfs'), 'Y. YR Y. Y.');
  PERFORM _st_is('support: salary-receipts — as 20260917130000 left it',
    _st_cells(u, s, 'salary-receipts'), 'Y. YR Y. ..');

  PERFORM _st_is('support: cannot move a document out of X',
    _st_move(u, s, 'documents'), 'R');
  PERFORM _st_is('support: …nor a logo',
    _st_move(u, s, 'company-logos'), 'R');
  PERFORM _st_is('support: …nor a Stundennachweis',
    _st_move(u, s, 'stundennachweise-pdfs'), 'R');
  PERFORM _st_is('support: …nor a signed receipt copy',
    _st_move(u, s, 'salary-receipts'), 'R');
  PERFORM _st_is('support: a Fahrtenbuch original cannot even be taken for update',
    _st_move(u, s, 'fahrtenbuch-files'), '.');

  -- The same account without its session claim is not in a session at all.
  PERFORM _st_is('support: the same account without its session claim reaches nothing',
    _st_cells(u, NULL, 'documents'), '.. RR .. ..');
END $$;

-- ─── 6. storage-api's claim shape ───────────────────────────────────────────

DO $$
DECLARE
  u_sup constant uuid := _st_id('user:support');
  s_sup constant uuid := _st_id('session:support');
  u_vw  constant uuid := _st_id('user:view-owner');
  s_vw  constant uuid := _st_id('session:view-owner');
  v_bucket text;
BEGIN
  -- jwt_amr() itself, read the way a SECURITY DEFINER caller reads it.
  PERFORM _st_as(u_sup, s_sup, 'storage');
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM _st_ok('storage-api: jwt_amr() reads the document''s amr when the singular subject has none',
    app_private.jwt_amr() -> 0 ->> 'method' = 'password'
    AND app_private.jwt_session_id() = s_sup);
  PERFORM _st_reset();

  PERFORM _st_as(u_sup, s_sup, 'storage-other');
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM _st_ok('storage-api: …and not when the document names another subject',
    app_private.jwt_amr() IS NULL);
  PERFORM _st_reset();

  FOREACH v_bucket IN ARRAY ARRAY['documents', 'company-logos', 'stundennachweise-pdfs'] LOOP
    PERFORM _st_is(format('storage-api: support — %s, reads and writes X', v_bucket),
      _st_cells(u_sup, s_sup, v_bucket, 'storage'), 'Y. YR Y. Y.');
    PERFORM _st_is(format('storage-api: view — %s, reads X, writes nothing', v_bucket),
      _st_cells(u_vw, s_vw, v_bucket, 'storage'), 'Y. RR .. ..');
  END LOOP;
  PERFORM _st_is('storage-api: support — fahrtenbuch-files, the XLSX import',
    _st_cells(u_sup, s_sup, 'fahrtenbuch-files', 'storage'), 'Y. YR .. Y.');
  PERFORM _st_is('storage-api: view — fahrtenbuch-files',
    _st_cells(u_vw, s_vw, 'fahrtenbuch-files', 'storage'), 'Y. RR .. ..');
  PERFORM _st_is('storage-api: support — salary-receipts',
    _st_cells(u_sup, s_sup, 'salary-receipts', 'storage'), 'Y. YR Y. ..');

  -- A Google session holds no platform role, so no context, so nothing.
  PERFORM _st_is('storage-api: a Google session in the same support context reaches nothing',
    _st_cells(u_sup, s_sup, 'documents', 'storage-oauth'), '.. RR .. ..');
  PERFORM _st_is('storage-api: a document naming someone else reaches nothing',
    _st_cells(u_sup, s_sup, 'documents', 'storage-other'), '.. RR .. ..');

  -- Members are untouched by the shape.
  PERFORM _st_is('storage-api: a member of X reads and writes X as before',
    _st_cells(_st_id('user:admin-x'), NULL, 'documents', 'storage'), 'Y. YR Y. Y.');
  PERFORM _st_is('storage-api: a viewer of X still writes no logo',
    _st_cells(_st_id('user:viewer-x'), NULL, 'company-logos', 'storage'), 'Y. RR .. ..');
END $$;

-- ─── 7. a closed context reaches nothing ────────────────────────────────────

UPDATE app_private.platform_company_contexts
   SET closed_at = now(), closed_reason = 'manual'
 WHERE staff_user_id IN (_st_id('user:support'), _st_id('user:view-owner'))
   AND closed_at IS NULL;

DO $$
DECLARE
  v_bucket text;
BEGIN
  FOREACH v_bucket IN ARRAY ARRAY['documents', 'fahrtenbuch-files', 'company-logos',
                                  'stundennachweise-pdfs', 'salary-receipts'] LOOP
    PERFORM _st_is(format('closed: %s — a closed support session reaches nothing', v_bucket),
      _st_cells(_st_id('user:support'), _st_id('session:support'), v_bucket), '.. RR .. ..');
    PERFORM _st_is(format('closed: %s — nor does a closed view context', v_bucket),
      _st_cells(_st_id('user:view-owner'), _st_id('session:view-owner'), v_bucket), '.. RR .. ..');
  END LOOP;
END $$;

ROLLBACK;
