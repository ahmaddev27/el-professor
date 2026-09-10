/*
  # Make the role a user is given actually mean something

  ## Problem

  `role_permissions` holds a 16-page × 4-role matrix — `viewer` is `can_edit=false`
  on every page, `editor` is read-only on accounting/documents/settings/statistics —
  and **nothing reads it**. Not the client (`AuthContext` never queries it), and not
  the database.

  Every write policy on every operational table carries the tenant predicate alone:

      CREATE POLICY "Company users can insert receipts"
        ON receipts FOR INSERT TO authenticated
        WITH CHECK (company_id = get_user_company_id());

  So a `viewer` inserts, updates and deletes receipts, income, drivers, cars, fixed
  costs, salaries, Werkstatt checks, notes and documents exactly as an `admin` does.
  Assigning someone the viewer role changes nothing about what they can do. This is
  FINDINGS.md **#5**; the 2026-09-08 migrations closed the same hole on `companies`,
  `company_settings`, `roles`, `role_permissions` and `user_profiles`, but did not
  touch the operational tables.

  ## Two data defects that would have made a naive fix lock people out

  **1. `viewer` was not a system role.** `admin`, `editor` and `supervisor` have
  `company_id IS NULL, is_system = true`; `viewer` was created against one company
  with `is_system = false`. Every other tenant therefore has no viewer role to
  resolve — `manage-users` /create would have written `role_id = NULL`, and a
  role-aware policy would then deny that user everything. Normalised here.

  **2. Twelve profiles have `role_id IS NULL`, eight of them with a live login — and
  all eight are their company's `admin`.** They predate the roles system and carry
  only the legacy text `role` column. Backfilled from that column, and
  `current_role_permits()` resolves by name anyway so the two paths agree.

  ## Also fixed: the super admin could not UPDATE anything

  Every UPDATE policy reads

      USING      (company_id = get_user_company_id() OR is_user_super_admin())
      WITH CHECK (company_id = get_user_company_id())

  The super admin passes USING and then fails WITH CHECK, because
  `get_user_company_id()` is NULL for a platform account and no row's `company_id`
  equals NULL. Support could open a row and never save it. The CHECK now carries the
  same `is_user_super_admin()` escape its USING already had.

  ## Design

  One predicate, added to the write policies of the ten operational tables:

      current_role_permits('<page-key>', true)

  It is SECURITY DEFINER with a pinned `search_path` — it must read `user_profiles`
  and `role_permissions`, which the caller's own RLS would otherwise filter — and it
  fails closed: a role that resolves to no permission row is denied, not allowed.

  SELECT policies are deliberately untouched. `can_view` is true for every role on
  every page in the shipped matrix, so gating reads here would change nothing today
  while risking a lockout; page-level read gating belongs in the client, where the
  matrix is page-shaped.
*/

-- ─── 1. Normalise `viewer` into a system role ───────────────────────────────

UPDATE public.roles
   SET company_id = NULL,
       is_system  = true
 WHERE name = 'viewer'
   AND is_system IS DISTINCT FROM true;

-- ─── 2. Backfill role_id from the legacy text role ──────────────────────────

UPDATE public.user_profiles up
   SET role_id = r.id
  FROM public.roles r
 WHERE up.role_id IS NULL
   AND r.name = up.role
   AND (r.company_id = up.company_id OR r.company_id IS NULL);

-- ─── 3. The predicate ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.current_role_permits(p_page text, p_need_edit boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT is_user_super_admin()
      OR COALESCE((
           SELECT CASE WHEN p_need_edit THEN rp.can_edit ELSE rp.can_view END
             FROM public.user_profiles up
             JOIN public.roles r
               ON r.id = COALESCE(
                    up.role_id,
                    -- Legacy profiles carry only the text `role`. Prefer a
                    -- company-scoped role of that name over the system one.
                    (SELECT r2.id
                       FROM public.roles r2
                      WHERE r2.name = up.role
                        AND (r2.company_id = up.company_id OR r2.company_id IS NULL)
                      ORDER BY (r2.company_id IS NULL)
                      LIMIT 1))
             JOIN public.role_permissions rp
               ON rp.role_id = r.id
              AND rp.page_key = p_page
            WHERE up.user_id = auth.uid()
            LIMIT 1
         ), false);
$$;

COMMENT ON FUNCTION public.current_role_permits(text, boolean) IS
  'Does the calling user''s role permit view/edit on this page_key? Fails closed. Super admins always pass.';

REVOKE ALL ON FUNCTION public.current_role_permits(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_role_permits(text, boolean) TO authenticated;

-- ─── 4. Role-aware write policies ───────────────────────────────────────────
--
-- Rebuilt from the shape every one of these already had, with two changes:
-- the new role predicate, and `is_user_super_admin()` added to each UPDATE's
-- WITH CHECK so support can actually save.

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('receipts',         'receipts'),
      ('income',           'income'),
      ('drivers',          'drivers'),
      ('cars',             'cars'),
      ('fixed_costs',      'fixed-costs'),
      ('salaries',         'salaries'),
      ('salary_payments',  'salaries'),
      ('werkstatt_checks', 'werkstatt'),
      ('driver_notes',     'notes'),
      ('documents',        'documents')
    ) AS v(tbl, page)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t.tbl
    ) THEN
      RAISE NOTICE 'skipping %, table not present', t.tbl;
      CONTINUE;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Company users can insert ' || t.tbl, t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Company users can update ' || t.tbl, t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Company users can delete ' || t.tbl, t.tbl);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated
         WITH CHECK (company_id = get_user_company_id() AND current_role_permits(%L, true))',
      'Company users can insert ' || t.tbl, t.tbl, t.page);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated
         USING ((company_id = get_user_company_id() AND current_role_permits(%L, true)) OR is_user_super_admin())
         WITH CHECK ((company_id = get_user_company_id() AND current_role_permits(%L, true)) OR is_user_super_admin())',
      'Company users can update ' || t.tbl, t.tbl, t.page, t.page);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated
         USING ((company_id = get_user_company_id() AND current_role_permits(%L, true)) OR is_user_super_admin())',
      'Company users can delete ' || t.tbl, t.tbl, t.page);
  END LOOP;
END $$;
