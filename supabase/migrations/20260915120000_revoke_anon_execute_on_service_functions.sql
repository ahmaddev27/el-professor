/*
  # No anonymous EXECUTE on the pricing, invoice and planning RPCs

  ## What was wrong

  Supabase's default privileges give `anon`, `authenticated` and `service_role`
  an explicit EXECUTE grant on every function `supabase_admin` creates in
  `public`, and deploy.sh runs every migration as `supabase_admin`. A
  `REVOKE … FROM PUBLIC` does not touch those grants.

  20260915110000 closed the functions an anonymous caller could actually abuse:
  `redeem_discount_code`, `list_users_for_admin`, `create_user_account`, the
  activation-code RPCs and the user-status helpers. This file does not restate
  those grants.

  The permission matrix (tests/rls/matrix.sql) found six more functions that
  only signed-in screens and the service role call, and that anon can still
  execute:

  - `compute_plan_price`: 20260911120000 revoked PUBLIC and granted
    authenticated and service_role, and left anon's default grant.
  - `generate_invoice_number`: the platform's invoice screen calls it signed
    in. No migration ever revoked anything on it.
  - `apply_monthly_planning_run`, `replace_monthly_planning_run`,
    `delete_or_archive_monthly_planning_run` and
    `purge_old_monthly_planning_runs`: only PUBLIC was ever revoked.
    `reassign_fahrtenbuch_trip` lost anon in 20260607124839.

  None of them is an open door today. The planning RPCs are SECURITY DEFINER
  but raise for a caller without a profile, `compute_plan_price` only computes a
  price, and `generate_invoice_number` runs as the caller, whose row-level
  security shows anon no invoice. The grant leaves them one guard short: a later
  body that forgets its caller check would be reachable with the anon key, which
  ships in the browser bundle.

  ## What this does

  For each of the six: PUBLIC and anon revoked, then EXECUTE granted by name to
  authenticated and service_role, the roles that call them. Revoking only anon
  would leave PUBLIC's grant wherever no migration removed it.

  ## What this deliberately leaves alone

  The helpers the policies call (`current_role_permits`, `is_company_admin`,
  `get_user_company_id` and the rest). Phase 3 rewrites those helpers and the
  policies around them, and decides their grants there, with its own tests.

  ## Compatibility

  Backward compatible, no SCHEMA_EPOCH bump. Nothing calls these as anon: the
  screens that call them are signed in, and service_role keeps its grant.
  Revoking a grant that is not there does nothing. The check at the end fails
  the migration, and with it the release, if anon can still execute any of the
  six or authenticated or service_role lost EXECUTE. A grant made by a role
  other than the function's owner is the one case a superuser's REVOKE would
  leave in place, and the check catches it.
*/

REVOKE ALL ON FUNCTION public.compute_plan_price(text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_plan_price(text, integer, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.generate_invoice_number(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_invoice_number(integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.apply_monthly_planning_run(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_monthly_planning_run(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.replace_monthly_planning_run(jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_monthly_planning_run(jsonb, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.delete_or_archive_monthly_planning_run(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_or_archive_monthly_planning_run(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.purge_old_monthly_planning_runs(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_old_monthly_planning_runs(integer, integer) TO authenticated, service_role;

DO $$
DECLARE
  v_wrong text;
BEGIN
  SELECT string_agg(format('%s (%s: %s)', f.fn, g.grantee,
                           CASE WHEN g.want THEN 'missing' ELSE 'still granted' END), ', ')
    INTO v_wrong
    FROM (VALUES
      ('public.compute_plan_price(text, integer, text)'),
      ('public.generate_invoice_number(integer)'),
      ('public.apply_monthly_planning_run(jsonb)'),
      ('public.replace_monthly_planning_run(jsonb, uuid)'),
      ('public.delete_or_archive_monthly_planning_run(uuid)'),
      ('public.purge_old_monthly_planning_runs(integer, integer)')
    ) AS f(fn)
    CROSS JOIN (VALUES
      ('anon',          false),
      ('authenticated', true),
      ('service_role',  true)
    ) AS g(grantee, want)
   WHERE has_function_privilege(g.grantee, f.fn::regprocedure, 'EXECUTE') IS DISTINCT FROM g.want;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260915120000 self-check: function EXECUTE grants are not what this migration states: %', v_wrong;
  END IF;
END $$;
