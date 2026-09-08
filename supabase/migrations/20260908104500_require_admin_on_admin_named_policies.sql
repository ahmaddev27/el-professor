/*
  # Make the "Company admins can ..." policies actually require an admin

  ## Problem

  Nine policies created in 20260422163649 are named for administrators but carry
  no administrator predicate — only a tenant predicate:

      CREATE POLICY "Company admins can update their company"
        ON companies FOR UPDATE TO authenticated
        USING (id = get_user_company_id() OR is_user_super_admin())
        WITH CHECK (id = get_user_company_id() OR is_user_super_admin());

  `get_user_company_id()` returns the caller's company for every member of that
  company, so a `viewer` satisfies it exactly as an `admin` does. The consequences:

  - **companies** — any member could UPDATE their own company row, self-granting
    `plan`, `subscription_status`, `subscription_expires_at`, `approval_status`,
    `status`, `subscription_car_limit` and `trial_end`.
  - **roles / role_permissions** — any member could create a role, grant it every
    permission, and attach it to themselves, defeating the custom-role system.
  - **company_settings** — any member could rewrite the company's legal data,
    which feeds generated documents, and the `state` field that selects the
    Bundesland holiday calendar used for Feiertagszuschlag.

  ## Fix

  - `companies` UPDATE becomes super-admin only. No tenant-facing code path writes
    this table: company profile data that tenants edit lives in `company_settings`
    (SettingsPage), activation goes through the `redeem_activation_code` RPC, and
    every other writer (CompaniesPage, SuperAdminDashboard, AssignSubscriptionModal)
    is a super-admin surface. SECURITY DEFINER RPCs are unaffected by RLS.
  - The `company_settings`, `roles` and `role_permissions` write policies gain an
    `is_company_admin()` predicate. Both surfaces that use them — SettingsPage and
    RolesPage — are already registered only when `isAdmin` is true in App.tsx, so
    this aligns the database with what the UI already assumes.
  - SELECT policies are deliberately left untouched: every member needs to read
    settings (logo, Bundesland) and roles.

  ## Also fixes: unpinned search_path on the RLS predicate helpers

  `get_user_company_id()` and `is_user_super_admin()` are SECURITY DEFINER but were
  declared without `SET search_path`, and the migration titled
  "harden_security_definer_functions" (20260607124839) skipped them. These two
  functions are the predicate behind most policies in the schema, so they are the
  worst place in the system to leave resolution ambiguous. Bodies are unchanged.
*/

-- =============================================================================
-- HELPERS
-- =============================================================================

CREATE OR REPLACE FUNCTION get_user_company_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT company_id
  FROM user_profiles
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION is_user_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT COALESCE(is_super_admin, false)
  FROM user_profiles
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;

-- True when the caller is an administrator of their own company.
-- Super admins are handled separately by is_user_super_admin() so that each
-- policy states its cross-tenant intent explicitly.
CREATE OR REPLACE FUNCTION is_company_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM user_profiles
    WHERE user_id = auth.uid()
      AND role = 'admin'
      AND company_id IS NOT NULL
  );
$$;

REVOKE ALL ON FUNCTION is_company_admin() FROM public;
GRANT EXECUTE ON FUNCTION is_company_admin() TO authenticated;

-- =============================================================================
-- COMPANIES — subscription, plan and approval state is not tenant-writable
-- =============================================================================

DROP POLICY IF EXISTS "Company admins can update their company" ON companies;

CREATE POLICY "Super admins can update companies"
  ON companies FOR UPDATE TO authenticated
  USING (is_user_super_admin())
  WITH CHECK (is_user_super_admin());

-- =============================================================================
-- COMPANY SETTINGS
-- =============================================================================

DROP POLICY IF EXISTS "Company admins can insert company_settings" ON company_settings;
DROP POLICY IF EXISTS "Company admins can update company_settings" ON company_settings;

CREATE POLICY "Company admins can insert company_settings"
  ON company_settings FOR INSERT TO authenticated
  WITH CHECK (
    company_id = get_user_company_id()
    AND (is_company_admin() OR is_user_super_admin())
  );

CREATE POLICY "Company admins can update company_settings"
  ON company_settings FOR UPDATE TO authenticated
  USING (
    (company_id = get_user_company_id() AND is_company_admin())
    OR is_user_super_admin()
  )
  WITH CHECK (
    (company_id = get_user_company_id() AND is_company_admin())
    OR is_user_super_admin()
  );

-- =============================================================================
-- ROLES
-- =============================================================================

DROP POLICY IF EXISTS "Company admins can insert roles" ON roles;
DROP POLICY IF EXISTS "Company admins can update roles" ON roles;
DROP POLICY IF EXISTS "Company admins can delete roles" ON roles;

CREATE POLICY "Company admins can insert roles"
  ON roles FOR INSERT TO authenticated
  WITH CHECK (
    company_id = get_user_company_id()
    AND (is_company_admin() OR is_user_super_admin())
  );

CREATE POLICY "Company admins can update roles"
  ON roles FOR UPDATE TO authenticated
  USING (
    is_system = false
    AND (
      (company_id = get_user_company_id() AND is_company_admin())
      OR is_user_super_admin()
    )
  )
  WITH CHECK (
    company_id = get_user_company_id()
    AND (is_company_admin() OR is_user_super_admin())
  );

CREATE POLICY "Company admins can delete roles"
  ON roles FOR DELETE TO authenticated
  USING (
    is_system = false
    AND (
      (company_id = get_user_company_id() AND is_company_admin())
      OR is_user_super_admin()
    )
  );

-- =============================================================================
-- ROLE PERMISSIONS
-- =============================================================================

DROP POLICY IF EXISTS "Company admins can insert role_permissions" ON role_permissions;
DROP POLICY IF EXISTS "Company admins can update role_permissions" ON role_permissions;
DROP POLICY IF EXISTS "Company admins can delete role_permissions" ON role_permissions;

CREATE POLICY "Company admins can insert role_permissions"
  ON role_permissions FOR INSERT TO authenticated
  WITH CHECK (
    (is_company_admin() OR is_user_super_admin())
    AND EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND r.company_id = get_user_company_id()
    )
  );

CREATE POLICY "Company admins can update role_permissions"
  ON role_permissions FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND (
          (r.company_id = get_user_company_id() AND is_company_admin())
          OR is_user_super_admin()
        )
    )
  )
  WITH CHECK (
    (is_company_admin() OR is_user_super_admin())
    AND EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND r.company_id = get_user_company_id()
    )
  );

CREATE POLICY "Company admins can delete role_permissions"
  ON role_permissions FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND (
          (r.company_id = get_user_company_id() AND is_company_admin())
          OR is_user_super_admin()
        )
    )
  );
