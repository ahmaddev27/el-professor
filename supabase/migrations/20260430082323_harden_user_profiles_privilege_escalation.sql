/*
  # Harden user_profiles against privilege escalation

  ## Summary
  Existing table RLS across the app is already company-scoped through the
  `get_user_company_id()` / `is_user_super_admin()` helpers. The only real
  hole remaining is `user_profiles`:

  1. The INSERT policy `(user_id = auth.uid())` lets any authenticated user
     self-insert a profile and set `is_super_admin=true`, `role_id=<any>`,
     or `company_id=<any>` — full privilege escalation at signup.
  2. The UPDATE policy lets any user in the same company update ANY other
     user's profile, including `is_super_admin`, `role_id`, `company_id`.
     A regular company user could promote themselves or a colleague to
     super admin or move rows across tenants.

  Postgres RLS can't restrict columns inside a policy, so this migration
  adds a BEFORE INSERT/UPDATE trigger that enforces:
     - `is_super_admin` can only be set/changed by an existing super admin.
     - `company_id` can only be changed by a super admin. A normal user may
       self-insert with their own `get_user_company_id()` or NULL (signup
       flow where the profile is written before company assignment).
     - `role_id` can only be changed by a super admin or by a company admin
       (user_profiles.role = 'admin') of the SAME company.
     - `role` text column follows the same rule as `role_id`.

  The existing RLS policies are kept untouched — they already scope rows
  to the company. This trigger adds column-level defense on top.

  ## Changes
  1. Creates `public.enforce_user_profile_privilege_guard()` trigger fn.
  2. Attaches it as BEFORE INSERT OR UPDATE trigger on `user_profiles`.
  3. Bypasses when the caller is a service role / SECURITY DEFINER context
     (`auth.uid() IS NULL`) so existing `handle_new_user` and
     `manage-users` edge function keep working.

  ## Safety
  - Does not drop or alter any existing policy.
  - Does not modify any table data.
  - Service-role / unauthenticated callers (migrations, edge functions
     using service key, auth trigger) are unaffected.
  - Normal user profile edits (name, email, etc.) still work.
*/

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

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS user_profiles_privilege_guard ON public.user_profiles;

CREATE TRIGGER user_profiles_privilege_guard
BEFORE INSERT OR UPDATE ON public.user_profiles
FOR EACH ROW
EXECUTE FUNCTION public.enforce_user_profile_privilege_guard();
