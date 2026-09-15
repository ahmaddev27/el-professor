/*
  # No anonymous EXECUTE on five RPCs that check their caller themselves

  ## What was wrong

  Supabase's default privileges give `anon`, `authenticated` and
  `service_role` an explicit EXECUTE grant on every function created in
  `public`. A read-only scan of staging on 15.09.2026 found five SECURITY
  DEFINER functions that anon can still execute. All five are owned by
  `postgres` and carry the same ACL:

      {=X/postgres,postgres=X/postgres,anon=X/postgres,
       authenticated=X/postgres,service_role=X/postgres}

  PUBLIC holds EXECUTE as well, so the older revokes did not survive into
  that database:

  - `reassign_fahrtenbuch_trip(uuid, uuid, text, text, text, text)`:
    20260605082427 revoked PUBLIC and 20260607124839 revoked anon. Its only
    caller is the transfer in MonatsplanungStundennachweisPreview, inside the
    company planner, signed in.
  - `revoke_activation_code(uuid)`, `delete_activation_code(uuid)`,
    `hide_activation_code(uuid, text)` (20260621114853) and
    `update_company_subscription_manual(uuid, text, timestamptz, timestamptz,
    text, text)` (20260621114909): only ever granted to authenticated,
    nothing revoked. Their only callers are ActivationCodesManagement and
    ManualSubscriptionModal on the super admin's dashboard, a route App.tsx
    registers for super admins alone.

  Nothing in supabase/functions, e2e/, scripts/, deploy/ or .github calls any
  of them.

  None of them is an open door today. reassign_fahrtenbuch_trip raises when
  auth.uid() IS NULL. The other four read is_super_admin for auth.uid() into a
  variable with SELECT … INTO and return success=false unless
  COALESCE(v_is_super, false) is true: for a caller without a profile row the
  variable stays NULL and the COALESCE makes it false. The grant leaves them
  one guard short: a later body that loses its caller check would be
  reachable with the anon key, which ships in the browser bundle.

  ## What this does

  For each of the five, looked up by exact signature with to_regprocedure:
  PUBLIC and anon revoked, then EXECUTE granted by name to authenticated and
  service_role. Revoking only anon would leave PUBLIC's grant. A function
  missing from a database is skipped with a notice.

  No function is redefined. REVOKE and GRANT change the ACL and nothing else,
  so every owner stays `postgres`. deploy.sh runs migrations as
  supabase_admin, a superuser, whose REVOKE acts as the owner and so removes
  the grants the owner made, which is every grant in the ACL above.

  ## What this deliberately leaves alone

  The helpers the row-level security policies call: get_user_company_id,
  get_current_user_role, is_role, is_support_user, uid, current_role_permits,
  is_company_admin and is_user_super_admin. A policy evaluated for an
  anonymous read runs them as anon, and without EXECUTE that read would fail
  with a permission error instead of returning what the policy allows.

  PLATFORM-AUTHORITY (plan 3.1) and PLATFORM-WRITES (plan 3.5) will redefine
  the activation-code and subscription functions with CREATE OR REPLACE,
  which keeps a function's ACL, so these revokes survive them. A DROP and
  CREATE would not: it gives anon its default grant back, and
  tests/rls/assertions.sql fails.

  ## Compatibility

  Backward compatible, no SCHEMA_EPOCH bump: every caller is signed in, and
  authenticated and service_role keep EXECUTE. Idempotent: a REVOKE of a
  privilege that is not held and a GRANT of one that is both do nothing.
  deploy.sh applies the file in one transaction with its ledger row, so it
  carries no BEGIN or COMMIT of its own. The check at the end fails the
  migration, and with it the release, if anon can still execute any of the
  five, or authenticated or service_role cannot.
*/

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.reassign_fahrtenbuch_trip(uuid, uuid, text, text, text, text)',
    'public.revoke_activation_code(uuid)',
    'public.delete_activation_code(uuid)',
    'public.hide_activation_code(uuid, text)',
    'public.update_company_subscription_manual(uuid, text, timestamp with time zone, timestamp with time zone, text, text)'
  ] LOOP
    IF to_regprocedure(fn) IS NULL THEN
      RAISE NOTICE '20260915140000: % is not in this database, skipped', fn;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
  END LOOP;
END $$;

-- ─── Self-check ─────────────────────────────────────────────────────────────

-- Fails the migration, and with it the release, if anon can still execute any
-- of the five, or a role they exist for lost EXECUTE. A grant made by a role
-- other than the owner is the one case the REVOKE above would leave in place,
-- and this catches it.
DO $$
DECLARE
  v_wrong text;
BEGIN
  SELECT string_agg(format('%s (%s: %s)', f.fn, g.grantee,
                           CASE WHEN g.want THEN 'missing' ELSE 'still granted' END), ', ')
    INTO v_wrong
    FROM (VALUES
      ('public.reassign_fahrtenbuch_trip(uuid, uuid, text, text, text, text)'),
      ('public.revoke_activation_code(uuid)'),
      ('public.delete_activation_code(uuid)'),
      ('public.hide_activation_code(uuid, text)'),
      ('public.update_company_subscription_manual(uuid, text, timestamp with time zone, timestamp with time zone, text, text)')
    ) AS f(fn)
    CROSS JOIN (VALUES
      ('anon',          false),
      ('authenticated', true),
      ('service_role',  true)
    ) AS g(grantee, want)
   WHERE to_regprocedure(f.fn) IS NOT NULL
     AND has_function_privilege(g.grantee, to_regprocedure(f.fn), 'EXECUTE') IS DISTINCT FROM g.want;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260915140000 self-check: function EXECUTE grants are not what this migration states: %', v_wrong;
  END IF;
END $$;
