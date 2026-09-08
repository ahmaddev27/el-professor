-- Lock down SECURITY DEFINER function execution
--
-- Problem:
--   Multiple SECURITY DEFINER functions were callable via PostgREST by the
--   `anon` and `authenticated` roles because PostgreSQL grants EXECUTE to
--   PUBLIC by default. SECURITY DEFINER means those calls run with the
--   function owner's privileges, which is a privilege-escalation risk.
--
-- Changes:
--   - REVOKE EXECUTE from PUBLIC and anon for every flagged function.
--   - Also REVOKE from authenticated for trigger-only / admin-only functions
--     (handle_new_user, create_user_profile, create_user_profile_manual,
--     create_user_account, list_users_for_admin).
--   - RLS / reporting helpers retain EXECUTE for authenticated (existing
--     grant) so the app and RLS policies keep working.
--
-- Security:
--   - anon can no longer call any of these via /rest/v1/rpc/*.
--   - Trigger / admin functions are callable only by the function owner /
--     service role.
--   - Each REVOKE is guarded so missing functions do not abort the migration.

DO $mig$
DECLARE
  anon_revoke text[] := ARRAY[
    'public.create_user_account(text,text,text,text)',
    'public.create_user_profile()',
    'public.create_user_profile_manual(uuid,text,text)',
    'public.get_current_cash_balance(text)',
    'public.get_current_user_role()',
    'public.get_driver_monthly_abrechnung(text,integer,integer)',
    'public.get_driver_weekly_abrechnung(text,integer,integer)',
    'public.get_monthly_abrechnung(integer,integer)',
    'public.get_user_company_id()',
    'public.get_user_status(uuid)',
    'public.get_weekly_abrechnung(integer,integer)',
    'public.handle_new_user()',
    'public.is_role(text)',
    'public.is_support_user()',
    'public.is_user_active(uuid)',
    'public.is_user_super_admin()',
    'public.list_users_for_admin()',
    'public.uid()'
  ];
  auth_revoke text[] := ARRAY[
    'public.create_user_account(text,text,text,text)',
    'public.create_user_profile()',
    'public.create_user_profile_manual(uuid,text,text)',
    'public.handle_new_user()',
    'public.list_users_for_admin()'
  ];
  sig text;
BEGIN
  FOREACH sig IN ARRAY anon_revoke LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', sig);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon',   sig);
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'Skipping missing function: %', sig;
    END;
  END LOOP;

  FOREACH sig IN ARRAY auth_revoke LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', sig);
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'Skipping missing function: %', sig;
    END;
  END LOOP;
END
$mig$;
