/*
  # Enable RLS on saved_stundennachweise

  ## Problem

  `saved_stundennachweise` stores generated statutory time records — the documents
  that go to the Steuerberater. Across all 144 migrations the table appears only in
  `ALTER TABLE ... ADD COLUMN` statements. It is never created, **row level security
  is never enabled, and no policy is ever defined.**

  With RLS off, the anon/authenticated role reaches every row in the table
  regardless of tenant. The client is the only thing scoping reads:

      // DocumentsPage.tsx:156
      .from('saved_stundennachweise').select('*').eq('company_id', companyId)

  — a filter any caller can simply omit. The deletes do not even do that much:

      // DocumentsPage.tsx:247
      .from('saved_stundennachweise').delete().eq('id', deleteConfirmId)
      // DocumentsPage.tsx:267
      .from('saved_stundennachweise').delete().in('id', ids)

  Both address rows by primary key with no tenant predicate, so any authenticated
  user of any tenant can destroy another company's payroll documents.

  ## Fix

  Enable RLS and scope every verb by `company_id`, matching the pattern used by the
  other operational tables in 20260422163649.

  Deliberately NOT requiring an admin role for DELETE. That may well be the right
  policy for statutory records, but the generate and archive surfaces
  (GenerateStundennachweisModal, DocumentsPage) are gated on the `dokumente` plan
  feature rather than on `isAdmin`, so imposing it here would change product
  behaviour rather than close the hole. The hole is the missing tenant boundary.

  ## Notes

  Guarded with `to_regclass` because this table is one of the four that the
  migration chain never creates (see CLAUDE.md). On a database where it is absent
  the migration is a no-op instead of a hard failure.
*/

DO $$
BEGIN
  IF to_regclass('public.saved_stundennachweise') IS NULL THEN
    RAISE NOTICE 'saved_stundennachweise does not exist — skipping RLS setup';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE public.saved_stundennachweise ENABLE ROW LEVEL SECURITY';

  -- Drop any policy that may exist from out-of-band changes, so this migration
  -- is the single definition of access to this table.
  DECLARE r record;
  BEGIN
    FOR r IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'saved_stundennachweise'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.saved_stundennachweise', r.policyname);
    END LOOP;
  END;

  EXECUTE $p$
    CREATE POLICY "Company users can view saved_stundennachweise"
      ON public.saved_stundennachweise FOR SELECT TO authenticated
      USING (company_id = get_user_company_id() OR is_user_super_admin())
  $p$;

  EXECUTE $p$
    CREATE POLICY "Company users can insert saved_stundennachweise"
      ON public.saved_stundennachweise FOR INSERT TO authenticated
      WITH CHECK (company_id = get_user_company_id() OR is_user_super_admin())
  $p$;

  EXECUTE $p$
    CREATE POLICY "Company users can update saved_stundennachweise"
      ON public.saved_stundennachweise FOR UPDATE TO authenticated
      USING (company_id = get_user_company_id() OR is_user_super_admin())
      WITH CHECK (company_id = get_user_company_id() OR is_user_super_admin())
  $p$;

  EXECUTE $p$
    CREATE POLICY "Company users can delete saved_stundennachweise"
      ON public.saved_stundennachweise FOR DELETE TO authenticated
      USING (company_id = get_user_company_id() OR is_user_super_admin())
  $p$;
END $$;
