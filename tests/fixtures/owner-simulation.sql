/*
  The ownership the kit's fixture does not carry.

  `tests/fixtures/schema.sql` is a `--schema-only` dump taken without owners, so
  in the kit every function belongs to the role that applied the migrations. On
  the real databases many of them belong to `postgres` instead: a function
  created outside version control keeps its owner, and `CREATE OR REPLACE` never
  changes it.

  That difference is not cosmetic. A SECURITY DEFINER function runs as its
  owner, so one owned by `postgres` can call another function only if `postgres`
  holds EXECUTE on it — and the migrations revoke EXECUTE from PUBLIC. A
  migration that adds a helper and calls it from an existing SECURITY DEFINER
  function therefore works in the kit and fails on production, inside whatever
  the caller was doing.

  Applied through the kit's `RLS_BEFORE` / `RLS_BEFORE_SQL` hook, before the
  migration under test, this reproduces that ownership so the failure shows up
  here instead:

      RLS_BEFORE=20260917100000_unified_tenant_policies.sql \
      RLS_BEFORE_SQL=tests/fixtures/owner-simulation.sql \
      node scripts/rls-test.mjs

  The five planning RPCs are the ones that matter for 20260917100000: it
  rewrites them to call `public.get_active_company_id()`, and leaves them with
  the owner they have. Hand them to `postgres` here, and the migration's grant
  loop and self-check 8 have something real to prove.
*/

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_sig text;
  v_n   int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    RAISE EXCEPTION 'owner simulation: there is no postgres role to hand the functions to';
  END IF;

  FOREACH v_sig IN ARRAY ARRAY[
    'public.apply_monthly_planning_run(jsonb)',
    'public.replace_monthly_planning_run(jsonb, uuid)',
    'public.delete_or_archive_monthly_planning_run(uuid)',
    'public.purge_old_monthly_planning_runs(integer, integer)',
    'public.reassign_fahrtenbuch_trip(uuid, uuid, text, text, text, text)'
  ]
  LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'owner simulation: % does not exist yet', v_sig;
    END IF;
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', v_sig);
    v_n := v_n + 1;
  END LOOP;

  -- The rights those bodies need that PUBLIC does not carry. On the real
  -- databases postgres holds them already (it is the role that created the
  -- tables); the kit's fixture grants nothing, so say it here rather than let
  -- the simulation fail for a reason production does not have.
  GRANT USAGE ON SCHEMA public TO postgres;
  EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres';
  EXECUTE 'GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres';

  RAISE NOTICE 'owner simulation: % functions now belong to postgres', v_n;
END $$;
