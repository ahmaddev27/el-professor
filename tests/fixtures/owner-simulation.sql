/*
  The ownership the kit's fixture does not carry.

  `tests/fixtures/schema.sql` is a `--schema-only` dump taken without owners, so
  in the kit every function belongs to the role that applied the migrations. On
  the real databases several of them belong to `postgres` instead: a function
  created outside version control keeps its owner, and `CREATE OR REPLACE` never
  changes it.

  That difference is not cosmetic. A SECURITY DEFINER function runs as its
  owner, so one owned by `postgres` can call another function only if `postgres`
  holds EXECUTE on it — and the migrations revoke EXECUTE from PUBLIC. A
  migration that adds a helper and calls it from an existing SECURITY DEFINER
  function therefore works in the kit and fails on production, inside whatever
  the caller was doing. That is what broke trial redemption (PR #25,
  15.09.2026) with `permission denied for function`.

  Applied through the kit's `RLS_BEFORE` / `RLS_BEFORE_SQL` hook, before the
  migration under test, this reproduces that ownership so the failure shows up
  here instead:

      RLS_BEFORE=20260917130000_unified_tenant_policies.sql \
      RLS_BEFORE_SQL=tests/fixtures/owner-simulation.sql \
      node scripts/rls-test.mjs

  ## Why not `postgres`

  This file used to hand the functions to the kit's own `postgres` role, and
  that made the ownership self-checks and grant loops vacuous — but not for the
  reason one would guess. Measured in a **bare** `supabase/postgres:17.6.1.170`,
  untouched by the fixture or any migration:

      postgres rolsuper     = false
      postgres rolbypassrls = true
      postgres member of      pg_read_all_data, pg_monitor, pg_signal_backend,
                              pg_create_subscription, authenticator,
                              authenticated, anon, service_role,
                              supabase_privileged_role

  So `postgres` is **not** the image's superuser, and the superuser
  short-circuit in `has_*_privilege` is not what happened. What happened is
  membership. `public.get_active_company_id()` carries

      supabase_admin=X/supabase_admin
      authenticated=X/supabase_admin
      service_role=X/supabase_admin

  and `postgres` is a member of `authenticated`, so
  `has_function_privilege('postgres', …, 'EXECUTE')` answers **true with no
  grant of its own**, by inheritance. Both shapes the migrations use therefore
  passed for free:

    - the grant loops (20260917130000 line 1048, 20260919120000 line 760) never
      entered their body, because their `NOT has_function_privilege(owner, …)`
      term was already false — not because of the `rolsuper` filter beside it;
    - the self-checks that ask `has_function_privilege(owner, …)` directly
      (20260917130000 self-check 8, 20260919120000 self-check 6) were true for
      the same reason.

  That distinction matters, because it says which hazards a simulation can and
  cannot reproduce. A helper whose EXECUTE is granted to `authenticated` is
  reachable by any owner that is a member of `authenticated` — which the real
  `postgres` is. The helpers that actually bite are the ones **no API role holds
  EXECUTE on**: every function in `app_private`. That is the shape that broke
  trial redemption in PR #25, and it is the shape this fixture reproduces.

  ## What `kit_weak_owner` is, and why it is shaped this way

  Measured on staging (`ya-mobility-staging-db-1`, 16.09.2026), which is a copy
  of production, the real `postgres` is:

      rolsuper     = false
      rolbypassrls = true
      member of    pg_read_all_data, pg_monitor, pg_signal_backend,
                   pg_create_subscription, authenticator, authenticated, anon,
                   service_role, supabase_privileged_role
      USAGE on app_private                     = true   (via pg_read_all_data)
      EXECUTE on app_private.signup_trial_days = false  <- the hazard
      owns public.fahrtenbuch_trips and the other business tables

  — the same role list the bare image ships, which is why the two measurements
  above agree.

  `kit_weak_owner` mirrors that, attribute for attribute — including the
  memberships, which is the part it would be easiest and most tempting to leave
  out. Four of those are deliberate and easy to get wrong in the other
  direction:

    - **Membership in `authenticated`, `anon` and `service_role` is granted.**
      Leaving it out would make the simulated owner weaker than the real one and
      would manufacture failures production cannot have: every helper granted to
      `authenticated` would suddenly be out of reach. It also has an
      uncomfortable consequence, which belongs in the open rather than hidden by
      a convenient omission — see "What this still cannot catch" below.

    - **BYPASSRLS and the table grants.** The real owner owns the business
      tables and bypasses RLS, so a SECURITY DEFINER function running as it
      reads and writes them freely. A simulated owner without that would fail
      inside the planning RPCs for a reason production does not have, and the
      kit would be reporting a defect that is not there.
    - **USAGE on `app_private` is granted, not withheld.** It arrives with
      `pg_read_all_data`, exactly as it does on the real databases. Withholding
      it would be *stricter* than production and would fail the wrong check:
      20260916110010's check 3 says so in as many words — "USAGE is not the
      test: postgres has it through pg_read_all_data, and still cannot call
      them."
    - **EXECUTE on `app_private` is withheld, and that is the weakness that
      matters.** No API role holds EXECUTE on any `app_private` function —
      the migrations revoke it from `PUBLIC, anon, authenticated, service_role`
      by name — and `pg_read_all_data` carries EXECUTE on nothing. So the
      simulated owner, exactly like the real one, holds USAGE on the schema and
      can call nothing in it unless a migration grants it by name. That is
      precisely the failure PR #25 hit, and precisely what 20260919120000's
      grant loop and its self-check 6 exist to repair.

  Keeping the simulated owner as weak as the real one, and no weaker, is what
  makes a failure here mean something.

  ## What this still cannot catch

  A helper whose EXECUTE is granted to `authenticated` is reachable by any owner
  that is a member of `authenticated`, and the real owner is one. So for
  `public.get_active_company_id()` — granted to `authenticated` and
  `service_role` by 20260917130000 itself — a faithful owner answers
  `has_function_privilege` true without any grant of its own, the migration's
  grant loop never enters its body, and **self-check 8 cannot fail**, here or on
  production. Making the owner a non-member would make it fail, but it would be
  testing an owner that does not exist.

  That is a property of the check, not of this fixture: a check written as
  `has_function_privilege(owner, …)` over a function granted to `authenticated`
  is unfalsifiable for this role graph. It is reported with the change that
  introduced this file rather than papered over. The `app_private` half above is
  the half that does bite.

  ## What is handed over, and what is not

  Measured on staging, the functions with a foreign owner are the five planning
  RPCs. They are SECURITY DEFINER, they belong to `postgres`, and every one of
  them reads `get_active_company_id` — the call 20260917130000 adds. That is the
  case the migration's grant loop and its self-check 8 were written for.

  `enforce_user_profile_privilege_guard()` is here for the opposite reason. Its
  body calls three `app_private` helpers, so while it belongs to a weak owner it
  cannot run at all. 20260917130000 hands it back with
  `ALTER FUNCTION … OWNER TO CURRENT_USER`; with the ownership simulated here
  that line is exercised rather than assumed, and a release that dropped it
  would fail here instead of on the first profile write in production.

  **It is therefore only simulated at the 20260917130000 position**, the one
  migration that takes it back. `RLS_BEFORE` decides that: see the guard below,
  which refuses to hand over a function no migration in the run will reclaim.

  The three Gehaltsquittung RPCs that 20260917130000 also rewrites are
  deliberately NOT in the list. They were created in the chain, by
  20260914140000, so on the real databases they belong to the role that ran that
  migration — the same role that runs this one, which is what the kit already
  reproduces. Simulating an owner production does not have would test a fiction,
  and would fail on grants (current_role_permits, next_document_number) that
  production's owner holds anyway.

  `app_private.signup_insert_company` is NOT in the list either, and that is a
  correction: it is owned by `supabase_admin` on staging, not by `postgres`.
  Handing it to a weak owner violates a rule the real databases keep and three
  places assert — `tests/rls/platform-authority.sql`, 20260916110010 check 3 and
  20260916130000 check 2 all require that a SECURITY DEFINER function whose body
  mentions `app_private.` belong to a superuser or to the schema's owner, and
  staging satisfies it with zero exceptions. See the report in the PR: the
  contradiction between that rule and 20260919120000's "leave the owner alone
  and grant it by name" is real, but it is a question about the migration, not
  something this fixture should manufacture.
*/

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_sig text;
  v_n   int := 0;
  -- Where in the chain the hook fired, asked of the catalogue rather than of an
  -- environment variable: `public.get_active_company_id()` is created by
  -- 20260917130000, so its absence means that migration has not run yet.
  v_pre_3_3 boolean := to_regprocedure('public.get_active_company_id()') IS NULL;
BEGIN
  -- A non-superuser, or the simulation proves nothing. See the header: in the
  -- kit image `postgres` is the bootstrap superuser, and every has_*_privilege
  -- question about a superuser answers true whatever the grants say.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kit_weak_owner') THEN
    CREATE ROLE kit_weak_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;

  IF (SELECT rolsuper FROM pg_roles WHERE rolname = 'kit_weak_owner') THEN
    RAISE EXCEPTION 'owner simulation: kit_weak_owner is a superuser, which makes every ownership check pass for free';
  END IF;

  -- Exactly what the real owner has, and nothing more. pg_read_all_data brings
  -- USAGE on app_private and SELECT everywhere; the three API roles bring what
  -- they are granted. None of them carries EXECUTE on anything in app_private,
  -- which is the one reach the simulated owner must lack.
  GRANT pg_read_all_data TO kit_weak_owner;
  GRANT authenticated, anon, service_role TO kit_weak_owner;
  GRANT USAGE ON SCHEMA public TO kit_weak_owner;
  EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA public TO kit_weak_owner';
  EXECUTE 'GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO kit_weak_owner';

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
    EXECUTE format('ALTER FUNCTION %s OWNER TO kit_weak_owner', v_sig);
    v_n := v_n + 1;
  END LOOP;

  -- The profile guard is only simulated where 20260917130000 will reclaim it.
  -- Handed to a weak owner at any later position it stays there, and a function
  -- whose body reads app_private then belongs to a role that can reach none of
  -- it — a state the real databases never have, and one three assertions
  -- correctly refuse.
  IF v_pre_3_3 THEN
    EXECUTE 'ALTER FUNCTION public.enforce_user_profile_privilege_guard() OWNER TO kit_weak_owner';
    v_n := v_n + 1;
    RAISE NOTICE 'owner simulation: the profile guard is handed over; 20260917130000 must take it back';
  ELSE
    -- Fired after 20260917130000. On the real databases its grant loop met the
    -- real owner when it ran and gave it EXECUTE then; reproduce that, or the
    -- simulated owner would be weaker than the real one and the planning RPCs
    -- would fail for a reason production does not have.
    GRANT EXECUTE ON FUNCTION public.get_active_company_id() TO kit_weak_owner;
    RAISE NOTICE 'owner simulation: past 20260917130000 — the profile guard is left alone, and the grant that migration already made is reproduced';
  END IF;

  RAISE NOTICE 'owner simulation: % functions now belong to kit_weak_owner (super=%, bypassrls=%)',
    v_n,
    (SELECT rolsuper     FROM pg_roles WHERE rolname = 'kit_weak_owner'),
    (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'kit_weak_owner');
  -- The hazard, stated as a number: USAGE on the schema, EXECUTE on nothing in
  -- it. Counted from the catalogue rather than named, because
  -- has_function_privilege raises on a function that does not exist yet and the
  -- hook can fire at more than one point in the chain.
  RAISE NOTICE 'owner simulation: USAGE on app_private = %, and it may execute % of the % functions in it',
    has_schema_privilege('kit_weak_owner', 'app_private', 'USAGE'),
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app_private'
        AND has_function_privilege('kit_weak_owner', p.oid, 'EXECUTE')),
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app_private');
END $$;
