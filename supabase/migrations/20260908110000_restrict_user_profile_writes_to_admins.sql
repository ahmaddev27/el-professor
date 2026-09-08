/*
  # Stop ordinary members from rewriting and deleting colleagues' profiles

  ## Problem

  Two policies from 20260422163649 scope by company but not by role:

      CREATE POLICY "Users can update company profiles"
        ON user_profiles FOR UPDATE TO authenticated
        USING  (user_id = auth.uid() OR company_id = get_user_company_id() OR is_user_super_admin())
        WITH CHECK (same);

      CREATE POLICY "Admins can delete company profiles"
        ON user_profiles FOR DELETE TO authenticated
        USING (company_id = get_user_company_id() OR is_user_super_admin());

  Any member of a company could therefore UPDATE or DELETE any colleague's
  profile — the DELETE policy says "Admins" but never checks for one.

  `enforce_user_profile_privilege_guard` (20260430082323) blocks changes to
  `is_super_admin`, `company_id`, `role` and `role_id`, so this is not a direct
  route to higher privilege. It leaves `status`, `must_change_password`, `email`
  and `full_name` unguarded, which is enough to:

  - set a colleague's — including the company admin's — `status` to 'deactivated'
    or 'suspended', which `checkProfileAccess` treats as a login block, locking
    them out of the tenant;
  - reactivate one's own revoked account by setting `status` back to 'active';
  - delete the company admin's profile row outright.

  ## Fix

  Writes to another member's profile now require a company administrator, and
  DELETE requires one as it always claimed to. Self-service updates are still
  permitted because legitimate flows depend on them.

  The `status` column additionally gets a guard clause, because the policy alone
  cannot express it: a user must not reactivate their own revoked account. The one
  self-service transition that is legitimate is the invite flow in
  SetPasswordPage.tsx:78 — 'pending_invite' -> 'active' on one's own row, after the
  password has been set. That exact transition is allowed and nothing else.

  `must_change_password` is deliberately left self-clearable (SetPasswordPage.tsx:87).
  It is a hygiene prompt, not an authorization boundary: a user who clears it still
  holds the credentials they already signed in with, and can change their password
  through Supabase Auth regardless.

  Service-role callers keep the existing `auth.uid() IS NULL` bypass, so the
  manage-users edge function and CompaniesPage's super-admin bulk status changes
  are unaffected.
*/

-- =============================================================================
-- POLICIES
-- =============================================================================

DROP POLICY IF EXISTS "Users can update company profiles" ON user_profiles;
DROP POLICY IF EXISTS "Admins can delete company profiles" ON user_profiles;

CREATE POLICY "Users update own profile, admins update company profiles"
  ON user_profiles FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    OR (company_id = get_user_company_id() AND is_company_admin())
    OR is_user_super_admin()
  )
  WITH CHECK (
    user_id = auth.uid()
    OR (company_id = get_user_company_id() AND is_company_admin())
    OR is_user_super_admin()
  );

CREATE POLICY "Admins can delete company profiles"
  ON user_profiles FOR DELETE TO authenticated
  USING (
    (company_id = get_user_company_id() AND is_company_admin())
    OR is_user_super_admin()
  );

-- =============================================================================
-- PRIVILEGE GUARD — extended with a status rule
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_user_profile_privilege_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  caller_uid         uuid := auth.uid();
  caller_is_super    boolean;
  caller_company     uuid;
  caller_role_text   text;
BEGIN
  -- Bypass for service role / background (no authenticated user)
  IF caller_uid IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(is_super_admin, false), company_id, role
    INTO caller_is_super, caller_company, caller_role_text
  FROM public.user_profiles
  WHERE user_id = caller_uid
  LIMIT 1;

  IF caller_is_super IS NULL THEN
    caller_is_super := false;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Non-super users cannot create a profile with is_super_admin=true
    IF COALESCE(NEW.is_super_admin, false) = true AND NOT caller_is_super THEN
      RAISE EXCEPTION 'Not allowed: cannot self-assign super admin';
    END IF;

    -- Non-super users can only insert their OWN profile
    IF NEW.user_id <> caller_uid AND NOT caller_is_super THEN
      RAISE EXCEPTION 'Not allowed: cannot insert profile for another user';
    END IF;

    -- company_id on insert must be NULL or match caller's company,
    -- unless caller is super admin
    IF NEW.company_id IS NOT NULL
       AND NEW.company_id IS DISTINCT FROM caller_company
       AND NOT caller_is_super THEN
      RAISE EXCEPTION 'Not allowed: cannot insert profile for another company';
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- is_super_admin can only be changed by an existing super admin
    IF COALESCE(NEW.is_super_admin, false) IS DISTINCT FROM COALESCE(OLD.is_super_admin, false)
       AND NOT caller_is_super THEN
      RAISE EXCEPTION 'Not allowed: cannot modify is_super_admin';
    END IF;

    -- company_id can only be changed by a super admin
    IF NEW.company_id IS DISTINCT FROM OLD.company_id
       AND NOT caller_is_super THEN
      RAISE EXCEPTION 'Not allowed: cannot change company assignment';
    END IF;

    -- role / role_id can be changed by:
    --   * super admin
    --   * a company admin on a target profile in the SAME company
    IF (NEW.role_id IS DISTINCT FROM OLD.role_id
        OR NEW.role     IS DISTINCT FROM OLD.role)
       AND NOT caller_is_super
       AND NOT (
            caller_role_text = 'admin'
            AND OLD.company_id IS NOT NULL
            AND OLD.company_id = caller_company
            AND NEW.company_id = caller_company
         )
    THEN
      RAISE EXCEPTION 'Not allowed: cannot change role assignment';
    END IF;

    -- status can be changed by:
    --   * super admin
    --   * a company admin on a target profile in the SAME company
    --   * the user themselves, but ONLY to complete the invite flow
    --     ('pending_invite' -> 'active', SetPasswordPage.tsx:78)
    -- Without the last restriction a user could clear their own 'suspended' or
    -- 'deactivated' status and walk back into a tenant they were removed from.
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT caller_is_super
       AND NOT (
            caller_role_text = 'admin'
            AND OLD.company_id IS NOT NULL
            AND OLD.company_id = caller_company
         )
       AND NOT (
            OLD.user_id = caller_uid
            AND OLD.status = 'pending_invite'
            AND NEW.status = 'active'
         )
    THEN
      RAISE EXCEPTION 'Not allowed: cannot change account status';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$fn$;
