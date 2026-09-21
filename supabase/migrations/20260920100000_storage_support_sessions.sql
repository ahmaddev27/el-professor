/*
  # Storage: a support session reads and writes the opened company's files, and
    a read-only context writes none (plan 3.C, the file half)

  3.4a (20260917140000) confined every tenant *table* to the company a platform
  account has opened, and left storage alone because the RLS kit could not see
  the bucket policies ("No storage", its header). This file is that half.

  ## Ground truth: production's storage, not the migration chain

  The chain does not describe production's storage. Production was captured
  read-only on 19.09.2026: 7 buckets, 22 policies on storage.objects, objects
  in two buckets only (company-logos 7, document-templates 2). One of the
  policies this file replaces — "Company members can read own company logo" —
  appears in no migration at all, and the logo policies of 20260507192151 by
  other names are gone. So every DROP below names a policy **production
  carries**, by the exact name it carries, and the self-check at the end fails
  the release if any other policy still names one of the four buckets: a
  permissive policy this file did not know about would OR itself onto the new
  ones and keep whatever it grants.

  ## The two defects, which are one defect in two directions

  1. `documents` let a read-only context write. Its four policies asked only
     `(storage.foldername(name))[1] = get_user_company_id()`, with no role gate
     and no mode. Since 3.4a that helper answers the open context's company for
     a company-less platform account **in either mode**, so a `view` context
     could insert, overwrite and delete that company's documents. PostgREST
     serves the `storage` schema (PGRST_DB_SCHEMAS = public,storage), so this
     was reachable directly, not only through storage-api.
  2. `fahrtenbuch-files`, `company-logos` (writes) and `stundennachweise-pdfs`
     read the company from `user_profiles` directly, which is NULL for a
     company-less platform account, so inside a support session an XLSX import,
     an original's download, a logo upload and a Stundennachweis PDF all failed.
     PR #80 papered over the first two with `support.storage.membershipOnly`.

  Moving the three onto `get_user_company_id()` alone would have spread defect
  1 to all four. So reads and writes are now separate terms.

  ## The rule

    read    the caller's company as the account shell sees it:
                (storage.foldername(name))[1] = get_user_company_id()
            — a member's own company, whatever state it is in, exactly as
            before; for a company-less platform account the company it has
            opened, in either mode.

    write   the caller's **membership**, or — only for an account that has
            none — the company of its open **support** session:
                (storage.foldername(name))[1] = COALESCE(
                  (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()),
                  platform_support_company_id())
            plus, where a bucket already gated its members, the same gate.

  Both halves reuse 3.4a's own vocabulary and define nothing new.
  `platform_support_company_id()` is 3.4a's public name for "the company this
  account has open in support mode" (`app_private.platform_context_company(true)`,
  20260917140000:368) and is exactly what its comment says it is for: callers
  that ask directly rather than through the tenant term. The COALESCE is the
  order `get_user_company_id()` itself uses — membership first, the context only
  for an account without one — so a staff account that still sits in a company
  (the state plan 3.7b removes) is judged by its own profile here too, and a
  context it somehow holds is ineffective, as it is on every tenant table.

  For members nothing changes. `user_profiles.user_id` is unique
  (user_profiles_user_id_key) and `user_profiles_select` always shows a caller
  its own row, so the membership subquery answers what production's
  `fahrtenbuch-files`, `company-logos` and `stundennachweise-pdfs` policies
  already read, and what `get_user_company_id()` answers a member for
  `documents`. No member rule gains or loses a term:

    documents              no role gate, as before
    fahrtenbuch-files      no role gate, and still no UPDATE policy
    stundennachweise-pdfs  no role gate, as before
    company-logos          profile role 'admin' or 'super_admin', carried over
                           verbatim (production's user_profiles has no CHECK on
                           role, so 'super_admin' is kept rather than folded
                           into is_company_admin()'s 'admin'); a platform
                           account passes through `is_company_admin()`, which
                           answers true for a company-less staff account only
                           inside a support session (3.4a's administrator
                           gate) and adds nothing for a member, whose true
                           answer implies role 'admin'

  ## Why the reads stay on get_user_company_id()

  `documents` and `company-logos` already read through it on production; the
  other two now do too. It is the account shell's term, not the business one,
  deliberately: `get_active_company_id()` would refuse a member of a suspended or
  unsubscribed company its own files, which production does not do today and
  which this file is not the place to decide.

  ## The storage-api claim shape, and why jwt_amr() changes here

  Defect 2 cannot be fixed by policies alone. storage-api v1.19.3
  (src/internal/database/connection.ts, setScope) sets, per request:

      role, request.jwt.claim.role, request.jwt,
      request.jwt.claim.sub   = payload.sub
      request.jwt.claims      = the whole verified payload as JSON

  and **no** `request.jwt.claim.amr`. Since 20260919130000,
  `app_private.jwt_subject_source()` answers `claim` for that request (the
  singular subject is set) and `jwt_amr()` then reads only the singular amr —
  absent — so `session_amr_permits_platform()` is false and
  `platform_staff_role_of()` is NULL for **every platform account on every
  storage-api request**. No context is ever found there, and a support session
  could not reach a file whatever the policies said. (The same is why defect 1
  was reachable through PostgREST, which sets only the document, and not through
  storage-api.)

  `jwt_amr()` therefore gains one fallback: when the singular subject is the
  source and **no singular amr is set at all**, it reads the amr of the claims
  document — **only if that document names the same subject**. That is the
  storage-api shape exactly: both GUCs come from one verified payload. Every
  rule of 20260919130000 is kept, and its self-check's cases all answer as
  before:

    - a singular amr, when present, still wins — well-formed or not; a
      malformed one is still NULL and does not fall back
    - a document that names another subject is never read (the symmetry
      20260919130000 exists for: one session, one sign-in method)
    - no subject at all is still no amr
    - an amr that is not an array is still NULL; nothing raises

  The only request whose answer changes is singular sub + no singular amr +
  a document with the same sub, which before this file was judged to have no
  sign-in method at all and is now judged by the one its own token carries —
  exactly as PostgREST's document-only request is.

  ## What is deliberately not changed

  - `salary-receipts`: its reads ask `get_active_company_id()` and its two
    writes `current_role_permits('salaries', true)`
    (20260917130000:1227-1257), which 3.4a answers true for a company-less
    staff account only inside a support session. So a view context already
    wrote nothing there, and it has no DELETE policy at all. Consistent with
    this file's rule as it stands; the self-check asserts it rather than
    restating it. Whether a support session may upload a Gehaltsquittung's
    signed copy is the permanent owner rule of 18.09.2026 (it may not) and its
    enforcement belongs with the three Gehaltsquittung RPCs, which is the
    open follow-up in HANDOFF.md — the file alone attaches nothing.
  - `document-templates`: public, keyed on `owner = auth.uid()`, not on a
    company folder. Nothing in src/ uses it today. Left as it is.
  - `Y & A Mobility`: a private bucket that **no policy names** — no role the
    API authenticates as reaches it except the service role. It carries a
    customer's name and the owner decides what happens to it; nothing here
    touches it.

  ## Mapping: production's policy → what replaces it

    documents
      "Company users can read own documents"         SELECT  same text, restated
      "Company users can upload documents"           INSERT  write term
      "Company users can update own documents"       UPDATE  write term, both clauses
      "Company users can delete own documents"       DELETE  write term
    fahrtenbuch-files
      fahrtenbuch_files_select                       SELECT  read term
      fahrtenbuch_files_insert                       INSERT  write term
      fahrtenbuch_files_delete                       DELETE  write term
      (no UPDATE policy, as on production)
    company-logos
      "Company members can read own company logo"    SELECT  same text, restated
      "Company admins can upload own company logo"   INSERT  write term + gate
      "Company admins can update own company logo"   UPDATE  write term + gate, both clauses
      "Company admins can delete own company logo"   DELETE  write term + gate
    stundennachweise-pdfs
      stundennachweise_pdf_select                    SELECT  read term
      stundennachweise_pdf_insert                    INSERT  write term
      stundennachweise_pdf_update                    UPDATE  write term, both clauses
      stundennachweise_pdf_delete                    DELETE  write term

  Every policy keeps its production name and `TO authenticated`. The UPDATE of
  `stundennachweise-pdfs` had no WITH CHECK, which PostgreSQL reads as "the
  USING clause again"; it is now written out, with the same meaning. The two
  SELECTs restated unchanged are restated so that the RLS kit — whose fixture
  carries no storage policy — tests the whole bucket, and so the chain finally
  records what production holds.

  Also dropped if present, by the names older migrations gave them: the four
  "Authenticated … documents bucket" policies of 20260429115353 (bucket-wide,
  no company term) and the logo policies of 20260402070500 and
  20260507192151's read policy. Production carries none of them; a database
  that still did would keep their grants through the OR, and the self-check
  would refuse it anyway.

  ## Compatibility — this does NOT bump deploy/SCHEMA_EPOCH

  Nothing is dropped that the previous release needs and no column, table or
  signature changes. A member sees exactly what it saw. After a rollback the
  previous browser still shows `support.storage.membershipOnly` when an upload
  fails in a platform session, which is now only the view case — a sentence
  that is out of date, not a failure. `jwt_amr()` only answers where it used to
  answer nothing.

  Coordination: 20260920110000–140000 belong to other branches. If one of them
  restates `app_private.jwt_amr()`, it must carry the fallback in section 1, or
  support sessions lose storage again with no error anywhere.
*/

-- ─── 1. jwt_amr(): read the amr storage-api carries ─────────────────────────

/*
  20260919130000's body with one branch added. Carried over unchanged:
  LANGUAGE plpgsql, STABLE, SECURITY INVOKER, `SET search_path = pg_catalog,
  public`, NULL when there is no subject, the singular amr first when the
  singular subject is the source, the document's amr when the document is the
  source, NULL unless the result is a JSON array, and the function's own
  exception handler (a broken claim loses the amr, never the session and never
  with an error). Owner and privileges are restated in section 3.
*/
CREATE OR REPLACE FUNCTION app_private.jwt_amr()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_source   text := app_private.jwt_subject_source();
  v_singular text;
  v_doc      jsonb;
  v_amr      jsonb;
BEGIN
  IF v_source IS NULL THEN
    RETURN NULL;
  ELSIF v_source = 'claim' THEN
    v_singular := nullif(current_setting('request.jwt.claim.amr', true), '');
    IF v_singular IS NOT NULL THEN
      v_amr := v_singular::jsonb;
    ELSE
      -- storage-api: the singular subject and the whole payload as a document,
      -- both from one verified token, and no singular amr. Read the document's
      -- amr only when it describes the same subject; otherwise there is no amr.
      v_doc := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
      IF jsonb_typeof(v_doc) = 'object'
         AND (v_doc ->> 'sub') = current_setting('request.jwt.claim.sub', true) THEN
        v_amr := v_doc -> 'amr';
      END IF;
    END IF;
  ELSE
    v_amr := (nullif(current_setting('request.jwt.claims', true), '')::jsonb) -> 'amr';
  END IF;

  IF v_amr IS NULL OR jsonb_typeof(v_amr) <> 'array' THEN
    RETURN NULL;
  END IF;
  RETURN v_amr;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app_private.jwt_amr() IS
  'The amr array of the caller''s session, taken from the same document its '
  'subject came from (app_private.jwt_subject_source()) — or, when the singular '
  'subject carries no singular amr, from the claims document if that names the '
  'same subject (storage-api''s shape, 20260920100000). NULL for a request with '
  'no session, no amr or a malformed one. Never raises.';

-- ─── 2. The four buckets ────────────────────────────────────────────────────

-- Production's names (captured 19.09.2026).
DROP POLICY IF EXISTS "Company users can read own documents"        ON storage.objects;
DROP POLICY IF EXISTS "Company users can upload documents"          ON storage.objects;
DROP POLICY IF EXISTS "Company users can update own documents"      ON storage.objects;
DROP POLICY IF EXISTS "Company users can delete own documents"      ON storage.objects;
DROP POLICY IF EXISTS "fahrtenbuch_files_select"                    ON storage.objects;
DROP POLICY IF EXISTS "fahrtenbuch_files_insert"                    ON storage.objects;
DROP POLICY IF EXISTS "fahrtenbuch_files_delete"                    ON storage.objects;
DROP POLICY IF EXISTS "Company members can read own company logo"   ON storage.objects;
DROP POLICY IF EXISTS "Company admins can upload own company logo"  ON storage.objects;
DROP POLICY IF EXISTS "Company admins can update own company logo"  ON storage.objects;
DROP POLICY IF EXISTS "Company admins can delete own company logo"  ON storage.objects;
DROP POLICY IF EXISTS "stundennachweise_pdf_select"                 ON storage.objects;
DROP POLICY IF EXISTS "stundennachweise_pdf_insert"                 ON storage.objects;
DROP POLICY IF EXISTS "stundennachweise_pdf_update"                 ON storage.objects;
DROP POLICY IF EXISTS "stundennachweise_pdf_delete"                 ON storage.objects;

-- Names older migrations gave the same buckets. Production carries none of
-- them; a database that did would OR their grants onto the policies below.
DROP POLICY IF EXISTS "Authenticated can read documents bucket"        ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can upload to documents bucket"   ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can update documents bucket"      ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can delete from documents bucket" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can read company logos"     ON storage.objects;
DROP POLICY IF EXISTS "Admin users can upload company logos"           ON storage.objects;
DROP POLICY IF EXISTS "Admin users can update company logos"           ON storage.objects;
DROP POLICY IF EXISTS "Admin users can delete company logos"           ON storage.objects;
DROP POLICY IF EXISTS "Company users can read own company logos"       ON storage.objects;

-- documents ──────────────────────────────────────────────────────────────────

CREATE POLICY "Company users can read own documents"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = (SELECT public.get_user_company_id())::text
  );

CREATE POLICY "Company users can upload documents"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = COALESCE(
          (SELECT up.company_id FROM public.user_profiles up WHERE up.user_id = (SELECT auth.uid())),
          (SELECT public.platform_support_company_id()))::text
  );

CREATE POLICY "Company users can update own documents"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = COALESCE(
          (SELECT up.company_id FROM public.user_profiles up WHERE up.user_id = (SELECT auth.uid())),
          (SELECT public.platform_support_company_id()))::text
  )
  WITH CHECK (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = COALESCE(
          (SELECT up.company_id FROM public.user_profiles up WHERE up.user_id = (SELECT auth.uid())),
          (SELECT public.platform_support_company_id()))::text
  );

CREATE POLICY "Company users can delete own documents"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = COALESCE(
          (SELECT up.company_id FROM public.user_profiles up WHERE up.user_id = (SELECT auth.uid())),
          (SELECT public.platform_support_company_id()))::text
  );

-- fahrtenbuch-files — no UPDATE policy, as on production: an import's original
-- is uploaded once (upsert: false) and never overwritten. ──────────────────

CREATE POLICY "fahrtenbuch_files_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'fahrtenbuch-files'
    AND (storage.foldername(name))[1] = (SELECT public.get_user_company_id())::text
  );

CREATE POLICY "fahrtenbuch_files_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'fahrtenbuch-files'
    AND (storage.foldername(name))[1] = COALESCE(
          (SELECT up.company_id FROM public.user_profiles up WHERE up.user_id = (SELECT auth.uid())),
          (SELECT public.platform_support_company_id()))::text
  );

CREATE POLICY "fahrtenbuch_files_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'fahrtenbuch-files'
    AND (storage.foldername(name))[1] = COALESCE(
          (SELECT up.company_id FROM public.user_profiles up WHERE up.user_id = (SELECT auth.uid())),
          (SELECT public.platform_support_company_id()))::text
  );

-- company-logos — public bucket, so a logo's public URL is served without any
-- policy; the SELECT policy still decides list, authenticated download and the
-- existing-row check of an upsert. ─────────────────────────────────────────

CREATE POLICY "Company members can read own company logo"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'company-logos'
    AND (storage.foldername(name))[1] = (SELECT public.get_user_company_id())::text
  );

CREATE POLICY "Company admins can upload own company logo"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'company-logos'
    AND (storage.foldername(name))[1] = COALESCE(
          (SELECT up.company_id FROM public.user_profiles up WHERE up.user_id = (SELECT auth.uid())),
          (SELECT public.platform_support_company_id()))::text
    AND (EXISTS (SELECT 1 FROM public.user_profiles up
                  WHERE up.user_id = (SELECT auth.uid())
                    AND up.role IN ('admin', 'super_admin'))
         OR (SELECT public.is_company_admin()))
  );

CREATE POLICY "Company admins can update own company logo"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'company-logos'
    AND (storage.foldername(name))[1] = COALESCE(
          (SELECT up.company_id FROM public.user_profiles up WHERE up.user_id = (SELECT auth.uid())),
          (SELECT public.platform_support_company_id()))::text
    AND (EXISTS (SELECT 1 FROM public.user_profiles up
                  WHERE up.user_id = (SELECT auth.uid())
                    AND up.role IN ('admin', 'super_admin'))
         OR (SELECT public.is_company_admin()))
  )
  WITH CHECK (
    bucket_id = 'company-logos'
    AND (storage.foldername(name))[1] = COALESCE(
          (SELECT up.company_id FROM public.user_profiles up WHERE up.user_id = (SELECT auth.uid())),
          (SELECT public.platform_support_company_id()))::text
    AND (EXISTS (SELECT 1 FROM public.user_profiles up
                  WHERE up.user_id = (SELECT auth.uid())
                    AND up.role IN ('admin', 'super_admin'))
         OR (SELECT public.is_company_admin()))
  );

CREATE POLICY "Company admins can delete own company logo"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'company-logos'
    AND (storage.foldername(name))[1] = COALESCE(
          (SELECT up.company_id FROM public.user_profiles up WHERE up.user_id = (SELECT auth.uid())),
          (SELECT public.platform_support_company_id()))::text
    AND (EXISTS (SELECT 1 FROM public.user_profiles up
                  WHERE up.user_id = (SELECT auth.uid())
                    AND up.role IN ('admin', 'super_admin'))
         OR (SELECT public.is_company_admin()))
  );

-- stundennachweise-pdfs ──────────────────────────────────────────────────────

CREATE POLICY "stundennachweise_pdf_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'stundennachweise-pdfs'
    AND (storage.foldername(name))[1] = (SELECT public.get_user_company_id())::text
  );

CREATE POLICY "stundennachweise_pdf_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'stundennachweise-pdfs'
    AND (storage.foldername(name))[1] = COALESCE(
          (SELECT up.company_id FROM public.user_profiles up WHERE up.user_id = (SELECT auth.uid())),
          (SELECT public.platform_support_company_id()))::text
  );

CREATE POLICY "stundennachweise_pdf_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'stundennachweise-pdfs'
    AND (storage.foldername(name))[1] = COALESCE(
          (SELECT up.company_id FROM public.user_profiles up WHERE up.user_id = (SELECT auth.uid())),
          (SELECT public.platform_support_company_id()))::text
  )
  WITH CHECK (
    bucket_id = 'stundennachweise-pdfs'
    AND (storage.foldername(name))[1] = COALESCE(
          (SELECT up.company_id FROM public.user_profiles up WHERE up.user_id = (SELECT auth.uid())),
          (SELECT public.platform_support_company_id()))::text
  );

CREATE POLICY "stundennachweise_pdf_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'stundennachweise-pdfs'
    AND (storage.foldername(name))[1] = COALESCE(
          (SELECT up.company_id FROM public.user_profiles up WHERE up.user_id = (SELECT auth.uid())),
          (SELECT public.platform_support_company_id()))::text
  );

-- ─── 3. Ownership and privileges ────────────────────────────────────────────

/*
  CREATE OR REPLACE keeps a function's owner; 20260919130000 handed jwt_amr()
  to the migration role, and this restates it rather than rely on that. The
  REVOKE is the second wall behind the missing USAGE on app_private.
*/
ALTER FUNCTION app_private.jwt_amr() OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION app_private.jwt_amr() FROM PUBLIC, anon, authenticated, service_role;

-- ─── 4. Self-check ──────────────────────────────────────────────────────────

DO $selfcheck$
DECLARE
  c_password CONSTANT text := '[{"method": "password", "timestamp": 1789416052}]';
  c_oauth    CONSTANT text := '[{"method": "oauth", "timestamp": 1789416052}]';
  c_sub      CONSTANT text := '00000000-0000-4000-8000-0000000000f1';
  c_other    CONSTANT text := '00000000-0000-4000-8000-0000000000f2';
  v_wrong    text;
BEGIN
  -- 1. Exactly these fifteen policies name one of the four buckets, with these
  --    commands. Anything else naming them would be ORed onto the rule.
  SELECT string_agg(coalesce(e.policyname, a.policyname) || ' ('
                    || coalesce(e.cmd, a.cmd) || ', '
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

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260920100000 self-check: the policies naming the four buckets are not the expected fifteen: %', v_wrong;
  END IF;

  -- 2. Every permissive policy on storage.objects pins a bucket. One that did
  --    not would apply to all four buckets at once, whatever this file says.
  SELECT string_agg(p.policyname::text, ', ' ORDER BY p.policyname::text) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname::text = 'storage' AND p.tablename::text = 'objects'
     AND p.permissive::text = 'PERMISSIVE'
     AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'bucket_id = ''';

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260920100000 self-check: storage policies that name no bucket: %', v_wrong;
  END IF;

  -- 3. The shape of each of the fifteen: authenticated only; reads ask the
  --    shell term and nothing about support; every write clause asks the
  --    support term and never the either-mode ones; the UPDATEs carry both
  --    clauses.
  SELECT string_agg(f.policyname || ': ' || f.problem, '; ' ORDER BY f.policyname) INTO v_wrong
    FROM (
      SELECT p.policyname::text AS policyname,
             CASE
               WHEN p.roles::text[] IS DISTINCT FROM ARRAY['authenticated'] THEN 'not TO authenticated'
               WHEN p.cmd = 'SELECT' AND coalesce(p.qual, '') !~ 'get_user_company_id\('
                 THEN 'read does not ask get_user_company_id()'
               WHEN p.cmd = 'SELECT' AND coalesce(p.qual, '') ~ 'platform_support_company_id|user_profiles'
                 THEN 'read carries a write term'
               WHEN p.cmd IN ('UPDATE', 'DELETE') AND coalesce(p.qual, '') !~ 'platform_support_company_id\('
                 THEN 'USING does not ask platform_support_company_id()'
               WHEN p.cmd IN ('INSERT', 'UPDATE') AND coalesce(p.with_check, '') !~ 'platform_support_company_id\('
                 THEN 'WITH CHECK does not ask platform_support_company_id()'
               WHEN p.cmd <> 'SELECT'
                    AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''))
                        ~ 'get_user_company_id|get_active_company_id|platform_view_company_id'
                 THEN 'a write accepts a read-only context''s company'
               WHEN (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''))
                    ~ 'is_user_super_admin|platform_reads_company_data|platform_writes_company_data'
                 THEN 'names a retired platform term'
             END AS problem
        FROM pg_policies p
       WHERE p.schemaname::text = 'storage' AND p.tablename::text = 'objects'
         AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''))
             ~ '''(documents|fahrtenbuch-files|company-logos|stundennachweise-pdfs)'''
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260920100000 self-check: %', v_wrong;
  END IF;

  -- 4. company-logos keeps its members' admin gate, verbatim, beside 3.4a's.
  SELECT string_agg(p.policyname::text, ', ' ORDER BY p.policyname::text) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname::text = 'storage' AND p.tablename::text = 'objects'
     AND p.cmd <> 'SELECT'
     AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ '''company-logos'''
     AND NOT ((coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ '''super_admin'''
              AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'is_company_admin\(');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260920100000 self-check: a logo write lost its administrator gate: %', v_wrong;
  END IF;

  -- 5. salary-receipts is left alone because it already answers this file's
  --    rule: its two writes ask current_role_permits(), which a view context
  --    answers false. Pinned, so a later rewrite that drops the gate is loud.
  SELECT string_agg(e.policyname, ', ') INTO v_wrong
    FROM (VALUES ('salary_receipts_insert'), ('salary_receipts_update')) AS e(policyname)
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_policies p
            WHERE p.schemaname::text = 'storage' AND p.tablename::text = 'objects'
              AND p.policyname::text = e.policyname
              AND coalesce(p.with_check, '') ~ 'current_role_permits\('
              AND coalesce(p.with_check, '') ~ 'get_active_company_id\(');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260920100000 self-check: salary-receipts writes no longer gated as 3.3 left them: %', v_wrong;
  END IF;

  -- 6. jwt_amr(): the storage-api shape reads the document's amr, and nothing
  --    else 20260919130000 decided moves. GUCs only, no data.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- 6a. storage-api: singular subject, whole payload as the document.
  PERFORM set_config('request.jwt.claim.sub', c_sub, true);
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","amr":%s}', c_sub, c_password), true);
  IF app_private.session_amr_permits_platform() IS NOT TRUE THEN
    RAISE EXCEPTION '20260920100000 self-check: a password session is refused in storage-api''s claim shape';
  END IF;

  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","amr":%s}', c_sub, c_oauth), true);
  IF app_private.session_amr_permits_platform() IS NOT FALSE THEN
    RAISE EXCEPTION '20260920100000 self-check: a Google session is admitted in storage-api''s claim shape';
  END IF;

  -- 6b. A document that names another subject is never read.
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","amr":%s}', c_other, c_password), true);
  IF app_private.jwt_amr() IS NOT NULL THEN
    RAISE EXCEPTION '20260920100000 self-check: the amr of another subject''s document is read';
  END IF;

  -- 6c. A singular amr still wins when it is there, and a malformed one is not
  --     "absent": neither falls back to the document.
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","amr":%s}', c_sub, c_password), true);
  PERFORM set_config('request.jwt.claim.amr', c_oauth, true);
  IF app_private.session_amr_permits_platform() IS NOT FALSE THEN
    RAISE EXCEPTION '20260920100000 self-check: the document outranks a singular amr';
  END IF;
  PERFORM set_config('request.jwt.claim.amr', 'not json at all', true);
  IF app_private.jwt_amr() IS NOT NULL THEN
    RAISE EXCEPTION '20260920100000 self-check: a malformed singular amr falls back to the document';
  END IF;

  -- 6d. PostgREST's shape, the document alone, is unchanged.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","amr":%s}', c_sub, c_password), true);
  IF app_private.session_amr_permits_platform() IS NOT TRUE THEN
    RAISE EXCEPTION '20260920100000 self-check: PostgREST''s password session is refused';
  END IF;

  -- 6e. No subject: no amr, however the document is dressed.
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","amr":%s}', c_password), true);
  IF app_private.jwt_amr() IS NOT NULL THEN
    RAISE EXCEPTION '20260920100000 self-check: an amr without a subject is read';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- 7. The function itself: invoker, pinned search_path, reachable by nobody
  --    the API authenticates as, owned by the role that owns app_private's
  --    other helpers.
  IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'app_private.jwt_amr()'::regprocedure) THEN
    RAISE EXCEPTION '20260920100000 self-check: jwt_amr() became SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                  WHERE p.oid = 'app_private.jwt_amr()'::regprocedure
                    AND c.setting LIKE 'search_path=%') THEN
    RAISE EXCEPTION '20260920100000 self-check: jwt_amr() has no pinned search_path';
  END IF;
  IF has_function_privilege('anon', 'app_private.jwt_amr()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.jwt_amr()', 'EXECUTE')
     OR has_function_privilege('service_role', 'app_private.jwt_amr()', 'EXECUTE') THEN
    RAISE EXCEPTION '20260920100000 self-check: an API role holds EXECUTE on jwt_amr()';
  END IF;
  IF (SELECT p.proowner FROM pg_proc p WHERE p.oid = 'app_private.jwt_amr()'::regprocedure)
     IS DISTINCT FROM (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION '20260920100000 self-check: jwt_amr() is not owned by the migration role';
  END IF;
END $selfcheck$;
