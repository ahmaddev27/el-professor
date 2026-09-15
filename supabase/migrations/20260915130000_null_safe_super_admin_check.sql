/*
  # A NULL-safe super-admin check, and no anonymous create_user_profile_manual

  ## What was wrong

  `is_user_super_admin()` read

      SELECT COALESCE(is_super_admin, false)
        FROM user_profiles
       WHERE user_id = auth.uid()
       LIMIT 1;

  The COALESCE applies to a row. A caller without a user_profiles row (anon,
  the service role, a signed-in account whose profile is gone) matches no row,
  and a scalar SQL function whose query returns no row returns NULL. So the
  helper answered NULL, not false, to exactly the callers who hold the least.

  `create_user_profile_manual(p_user_id, p_full_name, p_role)` is SECURITY
  DEFINER, and its only guard is `IF NOT public.is_user_super_admin() THEN
  RAISE`. `NOT NULL` is NULL, IF does not take a NULL branch, and the RAISE
  never ran for such a caller. Behind the guard the function upserts
  user_profiles (user_id, full_name, role), and
  enforce_user_profile_privilege_guard returns NEW at once when auth.uid() IS
  NULL, its bypass for the service role. anon held EXECUTE through Supabase's
  default privileges, so a request carrying only the public anon key reached
  the write of any account's role and name. Nothing in src/,
  supabase/functions, e2e/ or scripts/ calls the function.

  On today's schema that write then stops at user_profiles.email, which is NOT
  NULL, has no default, and is never supplied by the function. PostgreSQL
  checks NOT NULL on the proposed row before it looks for a conflict, so the
  upsert fails with 23502 for everyone who gets past the guard; the RLS kit
  records it for the super admin. That constraint was the only thing left
  between the anon key and a changed role.

  With the owner's approval, EXECUTE on create_user_profile_manual was revoked
  by hand from PUBLIC and anon on production and on staging on 15.09.2026.
  This migration makes that permanent and removes the NULL behind it.

  ## What this does

  1. `is_user_super_admin()` answers false, never NULL:

         SELECT COALESCE((SELECT is_super_admin
                            FROM public.user_profiles
                           WHERE user_id = auth.uid()
                           LIMIT 1), false);

     Same signature, LANGUAGE sql, STABLE, SECURITY DEFINER and search_path.
     CREATE OR REPLACE keeps its owner and ACL. The EXECUTE grants to anon,
     authenticated and service_role are restated anyway, because the policies
     call it under the caller's role and the check at the end calls it as
     anon. All three held it on staging on 15.09.2026, so there the GRANT
     changes nothing.

  2. `create_user_profile_manual`'s guard becomes
     `IF NOT COALESCE(public.is_user_super_admin(), false) THEN RAISE`, so it
     holds whatever the helper answers. The rest of the body is unchanged,
     byte for byte.

  3. EXECUTE on it: PUBLIC and anon revoked, authenticated and service_role
     granted, which is how the hand fix left production and staging.

  ## Why every policy decides exactly as before

  USING and WITH CHECK admit a row only when they are true; NULL and false
  both deny. Under AND and OR an expression that is true while one operand is
  NULL is true whatever that operand is, so `x OR NULL` and `x OR false`
  decide the same, and so do `x AND NULL` and `x AND false`. Only NOT, CASE,
  COALESCE or an IS test can tell NULL from false. On staging on 15.09.2026
  all 103 policies that call `is_user_super_admin()` or
  `current_role_permits()` apply TO authenticated and use them only under AND
  and OR. For a caller with a profile row nothing changes at all:
  is_super_admin is NOT NULL.

  `current_role_permits()` is `is_user_super_admin() OR COALESCE(…, false)`,
  so for a caller without a profile it now answers false where it answered
  NULL. Besides those policies only confirm_salary_cash_payment,
  void_salary_cash_receipt and attach_salary_cash_receipt_signed_copy call it,
  as `v_caller IS NULL OR v_company IS NULL OR NOT current_role_permits(…)`,
  and a caller without a profile is refused by the first two terms before the
  NOT is reached. No view and no other function calls either helper.

  The one outcome that changes is create_user_profile_manual for a caller
  without a profile: the service role, or a signed-in account whose profile is
  gone, is now refused by the guard instead of failing at the upsert. Neither
  calls it, and the service role writes user_profiles directly.

  ## Compatibility

  Backward compatible, no SCHEMA_EPOCH bump: the release before this one never
  calls create_user_profile_manual, and every policy decides as it did.
  Idempotent: CREATE OR REPLACE, REVOKE and GRANT repeat cleanly. deploy.sh
  applies the file in one transaction with its ledger row, so it carries no
  BEGIN or COMMIT of its own.

  Phase 3.1 replaces is_user_super_admin()'s body in a later migration. That
  body has to keep answering false, never NULL, to a caller without a profile:
  the check below states it for this release, tests/rls/assertions.sql for
  every later one.
*/

CREATE OR REPLACE FUNCTION public.is_user_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT COALESCE((SELECT is_super_admin
                     FROM public.user_profiles
                    WHERE user_id = auth.uid()
                    LIMIT 1), false);
$$;

GRANT EXECUTE ON FUNCTION public.is_user_super_admin() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_user_profile_manual(p_user_id uuid, p_full_name text, p_role text DEFAULT 'viewer'::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
IF NOT COALESCE(public.is_user_super_admin(), false) THEN
RAISE EXCEPTION 'Access denied: only super admins can call create_user_profile_manual';
END IF;

INSERT INTO public.user_profiles (user_id, full_name, role)
VALUES (p_user_id, p_full_name, p_role)
ON CONFLICT (user_id) DO UPDATE SET
full_name  = EXCLUDED.full_name,
role       = EXCLUDED.role,
updated_at = now();
END;
$function$;

REVOKE ALL ON FUNCTION public.create_user_profile_manual(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_user_profile_manual(uuid, text, text) TO authenticated, service_role;

-- ─── Self-check ─────────────────────────────────────────────────────────────

-- Fails the migration, and with it the release, if an anonymous caller does
-- not get false from is_user_super_admin(), if anon can run
-- create_user_profile_manual, or if a role either function exists for lost
-- EXECUTE.
DO $$
DECLARE
  v_answer text;
  v_wrong  text;
BEGIN
  -- Ask the way PostgREST asks for a request without a JWT: no subject, role
  -- anon. The raise at the end rolls this inner block back, and the claims and
  -- the role unwind with it, so nothing after it runs as anon.
  BEGIN
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    IF auth.uid() IS NOT NULL THEN
      RAISE EXCEPTION '20260915130000 self-check: impersonating anon failed, auth.uid() is %', auth.uid();
    END IF;
    EXECUTE 'SET LOCAL ROLE anon';
    RAISE EXCEPTION USING ERRCODE = 'ZZ913',
                          MESSAGE = coalesce(public.is_user_super_admin()::text, 'NULL');
  EXCEPTION WHEN SQLSTATE 'ZZ913' THEN
    v_answer := SQLERRM;
  END;

  IF v_answer IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION '20260915130000 self-check: is_user_super_admin() answers % to an anonymous caller, not false', v_answer;
  END IF;

  SELECT string_agg(format('%s (%s: %s)', g.fn, g.grantee,
                           CASE WHEN g.want THEN 'missing' ELSE 'still granted' END), ', ')
    INTO v_wrong
    FROM (VALUES
      ('public.create_user_profile_manual(uuid, text, text)', 'anon',          false),
      ('public.create_user_profile_manual(uuid, text, text)', 'authenticated', true),
      ('public.create_user_profile_manual(uuid, text, text)', 'service_role',  true),
      ('public.is_user_super_admin()',                        'anon',          true),
      ('public.is_user_super_admin()',                        'authenticated', true),
      ('public.is_user_super_admin()',                        'service_role',  true)
    ) AS g(fn, grantee, want)
   WHERE has_function_privilege(g.grantee, g.fn::regprocedure, 'EXECUTE') IS DISTINCT FROM g.want;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260915130000 self-check: function EXECUTE grants are not what this migration states: %', v_wrong;
  END IF;
END $$;
