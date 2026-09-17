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

  Both variables are required, so a plain `npm run test:rls` never loads this
  file and never creates the role — measured 16.09.2026: the default run prints
  no `running tests/fixtures…` step, no `owner simulation` line and no mention
  of `kit_weak_owner`, and is green.

  Read the two "does not" sections at the end before relying on this file. A
  simulation is worth what its coverage claim is worth, and the coverage claim
  is the part that is easiest to get wrong in the flattering direction.

  ## Why not `postgres`

  This file used to hand the functions to the kit's own `postgres` role. That
  made the ownership self-checks vacuous — but not for the reason one would
  guess, and not for both of the migrations it is aimed at. Measured in a
  **bare** `supabase/postgres:17.6.1.170`, after the image's own init scripts
  finished and untouched by the fixture or any migration (16.09.2026):

      postgres rolsuper     = false
      postgres rolbypassrls = true
      postgres rolinherit   = true
      postgres member of      anon, authenticated, authenticator,
                              pg_create_subscription, pg_monitor,
                              pg_read_all_data, pg_signal_backend,
                              service_role, supabase_privileged_role

  So `postgres` is **not** the image's superuser — `supabase_admin` is — and the
  superuser short-circuit in `has_*_privilege` is not what happened. What
  happened is inheritance, and `rolinherit = true` is what carries it.
  `public.get_active_company_id()` carries

      supabase_admin=X/supabase_admin
      authenticated=X/supabase_admin
      service_role=X/supabase_admin

  and `postgres` is a member of `authenticated`, so
  `has_function_privilege('postgres', …, 'EXECUTE')` answers **true with no
  grant of its own**.

  **The two grant loops the migrations use are not in the same position, and the
  earlier draft of this header said they were.** They differ by what their
  target is granted to:

    - `20260917130000:1042-1053` targets `public.get_active_company_id()`, which
      that same migration grants to `authenticated` and `service_role` at
      `:292`. Its `NOT has_function_privilege(owner, …)` term was therefore
      already false for a `postgres` owner, and the loop never entered its body.
      Self-check 8 at `:1446-1457` was true for the same reason.

    - `20260919120000:751-761` targets `app_private.signup_trial_days()`, whose
      EXECUTE is revoked from `PUBLIC, anon, authenticated, service_role` by
      name (`20260916150000:671`, restated at `20260919120000:726`) and granted
      to no API role at all. A `postgres` owner inherits nothing there —
      measured on staging, `postgres` may execute **0** of the functions in
      `app_private` while holding USAGE on the schema. That loop **did** enter
      its body under the old fixture.

  Which says exactly which hazard a simulation can reproduce. A helper granted
  to `authenticated` is reachable by any owner that is a member of
  `authenticated` — which every real owner is. The helpers that bite are the
  ones **no API role holds EXECUTE on**: every function in `app_private`. That
  is the shape that broke trial redemption in PR #25, and it is the shape this
  fixture reproduces.

  ## What `kit_weak_owner` is, and why it is shaped this way

  Measured on staging (`ya-mobility-staging-db-1`, 16.09.2026), which is a copy
  of production, the real `postgres` is:

      rolsuper     = false
      rolbypassrls = true
      rolinherit   = true
      member of    the same nine roles the bare image lists above
      USAGE on app_private                     = true   (via pg_read_all_data)
      EXECUTE on app_private.signup_trial_days = false  <- the hazard
      EXECUTE on app_private functions         = 0 of them
      owns public.fahrtenbuch_trips and the other business tables

  `kit_weak_owner` mirrors that, attribute for attribute — including the
  memberships and `INHERIT`, the two parts it would be easiest and most tempting
  to leave out. Four of them are deliberate and easy to get wrong in the other
  direction:

    - **`INHERIT`, spelled out rather than left to the default.** The whole
      diagnosis above is "true by inheritance"; a role with `NOINHERIT` would
      reach none of it, and the simulation would fail checks production passes.
      It is asserted below as well as declared, because a role left behind by a
      `--keep` run is reused rather than recreated.

    - **Membership in `authenticated`, `anon` and `service_role` is granted.**
      Leaving it out would make the simulated owner weaker than the real one and
      would manufacture failures production cannot have: every helper granted to
      `authenticated` would suddenly be out of reach. It also has an
      uncomfortable consequence, which belongs in the open rather than hidden by
      a convenient omission — see "What this cannot catch" below.

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

  What it lacks is what the real owner lacks: **EXECUTE on anything in
  `app_private`**. No API role holds it, `pg_read_all_data` carries EXECUTE on
  nothing, and the block below refuses to continue if that ever stops being
  true — a later migration granting EXECUTE on the schema's functions to a role
  this one inherits would empty the simulation in silence, which is the exact
  defect this file exists to end.

  Keeping the simulated owner as weak as the real one, and no weaker, is what
  makes a failure here mean something.

  ## What is handed over, and what is not

  Measured on staging, the functions with a foreign owner are the five planning
  RPCs. They are SECURITY DEFINER, they belong to `postgres`, and every one of
  them reads `get_active_company_id` — the call 20260917130000 adds. That is the
  case the migration's grant loop and its self-check 8 were written for.

  `enforce_user_profile_privilege_guard()` is here for the opposite reason, and
  it is the one deliberate fiction in the file: staging owns it with
  `supabase_admin`, not `postgres`. Its body calls three `app_private` helpers,
  so while it belongs to a weak owner it cannot run at all. 20260917130000 hands
  it back with `ALTER FUNCTION … OWNER TO CURRENT_USER` at `:1208`; with the
  ownership forced here that line is exercised rather than assumed, and a
  release that dropped it fails here instead of on the first profile write in
  production. Measured 16.09.2026 — delete `:1208` and run this fixture at the
  20260917130000 position, and the kit stops in its first assertion file, exit 1:

      ERROR:  FAIL: viewer CAN UPDATE its own profile — expected allowed, got denied

  which is PR #25's `permission denied for function`, reaching the surface as a
  refused UPDATE because the trigger's owner can call none of what it calls. The
  same tree with `:1208` in place is green. **It is therefore only handed over
  at the 20260917130000
  position**, the one migration that takes it back — `RLS_BEFORE` decides that,
  see the guard below. Handed over anywhere later it would stay with a role that
  can reach none of what it calls, which is a state the real databases never
  have and three assertions correctly refuse.

  The three Gehaltsquittung RPCs that 20260917130000 also rewrites are
  deliberately NOT in the list. They were created in the chain, by
  20260914140000, so on the real databases they belong to the role that ran that
  migration — the same role that runs this one, which is what the kit already
  reproduces. Simulating an owner production does not have would test a fiction,
  and would fail on grants (current_role_permits, next_document_number) that
  production's owner holds anyway.

  ## What this cannot catch — 20260917130000 self-check 8

  A helper whose EXECUTE is granted to `authenticated` is reachable by any owner
  that is a member of `authenticated`, and the real owner is one. So for
  `public.get_active_company_id()` — granted to `authenticated` and
  `service_role` by 20260917130000 itself at `:292` — a faithful owner answers
  `has_function_privilege` true without any grant of its own, that migration's
  grant loop at `:1042-1053` never enters its body, and **self-check 8 at
  `:1446-1457` cannot fail**, here or on production. Making the owner a
  non-member would make it fail, but it would be testing an owner that does not
  exist.

  That is a property of the check, not of this fixture: a check written as
  `has_function_privilege(owner, …)` over a function granted to `authenticated`
  is unfalsifiable for this role graph. The same reasoning covers
  `20260916150000:699-717` and `:788-802` (`compute_plan_price`, granted to
  `authenticated` and `service_role`). It is reported rather than papered over.

  ## What this does not exercise — 20260919120000

  It would be natural to read this file as the thing that repairs
  20260919120000's grant loop (`:746-773`) and its self-check 6 (`:981-989`),
  since those are written for exactly the hazard described above: a foreign
  owner of a caller of `app_private.signup_trial_days()`, the one target no API
  role can reach. **It does not exercise either of them, and it cannot.**

  There are exactly three SECURITY DEFINER callers of that function:

      public.get_public_config()                20260916150000:603, 613
      public.get_app_config()                   20260916150000:621, 632
      app_private.signup_insert_company(…)      20260919120000:612

  None is handed to `kit_weak_owner`, so all three keep the migration role,
  which owns `app_private`. The loop's
  `NOT has_function_privilege(owner, …) OR NOT has_schema_privilege(owner, …)`
  term is false for the schema's owner, so its body never runs; self-check 6
  reads the same owner, which holds EXECUTE through the `ALTER … OWNER TO
  CURRENT_USER` at `:716` and USAGE through owning the schema, so it cannot
  fail. Delete the whole grant block from 20260919120000 and a run with this
  fixture at that position still passes — measured 16.09.2026, `sed -i 746,773d`
  on the migration, exit 0, `RLS assertions passed.` with all eleven test files
  reached. That is a gap in coverage, stated here rather than claimed away.

  **The reason it cannot be closed from this file** is that
  `tests/rls/platform-authority.sql:330-339` asserts, over every SECURITY
  DEFINER function in the database, that one whose `prosrc` matches
  `app_private\.` belongs to a superuser or to the owner of `app_private` —
  **identity**, not privilege. For a plpgsql function `prosrc` includes the
  DECLARE section, and that is where the call sits:

      -- 20260919120000:612, inside DECLARE
      v_trial_length interval := make_interval(days => app_private.signup_trial_days());

  So handing `signup_insert_company` to a weak owner satisfies 20260919120000's
  own self-check — which exempts that one function from the identity test at
  `:839-849` while applying it to the rest of the file at `:812-818` — and
  **trips `platform-authority.sql` in the same run**. Measured, not reasoned: a
  run of this fixture at the 20260919120000 position with that function added to
  the list below reaches `platform-authority.sql` and fails there (16.09.2026,
  exit 1):

      ERROR:  FAIL: every SECURITY DEFINER function that references app_private
              belongs to its owner or a superuser

  with every migration, `assertions.sql`, `matrix.sql`, `oauth-signup.sql` and
  `otp.sql` green ahead of it — so 20260919120000 itself passed, its grant loop
  did enter its body, and what refuses the owner is the test that runs last.
  The other two callers are walled twice over:
  `tests/rls/pricing.sql:204-214` repeats the identity rule over exactly the
  five functions of 20260916150000, `get_public_config` and `get_app_config`
  among them.

  So `app_private.signup_insert_company` is **not** in the list below, and its
  removal from the old version of this file was required rather than merely
  defensible. The old header's premise was wrong twice: it said the function
  "may still belong to `postgres`", where staging owns it with `supabase_admin`
  (measured 16.09.2026, zero exceptions across the database), and a run that
  handed it over could not be green.

  **The contradiction underneath is real, and it is a question about the
  migration, not about this fixture.** 20260919120000:119-128 deliberately
  leaves that owner alone and grants it USAGE and EXECUTE by name — a
  **privilege** rule — where three other places assert an **identity** rule:
  `platform-authority.sql:330-339`, `20260916110010:1022-1034` check 3 and
  `20260916130000:1489-1500` check 2. The two migration checks sort before
  20260919120000 and never see the new body, so only the test catches it. They
  collide today only because the function is `supabase_admin`-owned; the day
  anyone hands it to `postgres`, the migration passes and the kit fails.
  Converting the test to a privilege rule would make the loop exercisable, and
  would also leave that test disagreeing with two migrations that are already
  applied on production under schema epoch 2. Nothing here weakens either side.
*/

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_sig     text;
  v_n       int := 0;
  v_rows    bigint;
  v_reach   int;
  v_total   int;
  v_super   boolean;
  v_bypass  boolean;
  v_inherit boolean;
  -- Where in the chain the hook fired, asked of the catalogue rather than of an
  -- environment variable: `public.get_active_company_id()` is created by
  -- 20260917130000, so its absence means that migration has not run yet.
  v_pre_3_3 boolean := to_regprocedure('public.get_active_company_id()') IS NULL;
BEGIN
  /*
    This file is plain SQL, so anything that can reach a database can run it,
    and what it builds is a `BYPASSRLS` role holding `pg_read_all_data`, the
    three API-role memberships and ALL on every table in `public`. Nothing in
    the repository removes it again. Run against a real database by hand — the
    obvious mistake, since the command in the header looks like something to
    paste at a psql prompt — that is a standing privilege escalation.

    The kit's database is built from a `--schema-only` dump and the migrations,
    and the seeds are loaded after every migration has run, so at either hook
    position `public.companies` is empty. Staging holds 25 rows there
    (16.09.2026) and production more. That is the discriminator. It is not
    proof — a brand-new empty database would pass — but a database with nothing
    in it is also one with nothing to take.
  */
  IF to_regclass('public.companies') IS NULL THEN
    RAISE EXCEPTION 'owner simulation: public.companies does not exist, so this is not the kit''s database';
  END IF;

  SELECT count(*) INTO v_rows FROM public.companies;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'owner simulation: refusing to run against a database that holds % companies. This builds a permanent BYPASSRLS role and is only for the throwaway database scripts/rls-test.mjs creates', v_rows;
  END IF;

  -- INHERIT is spelled out because the whole diagnosis in the header rests on
  -- it, and a default is not a statement. NOSUPERUSER likewise: a superuser
  -- short-circuits every has_*_privilege question, which is the one way to make
  -- this simulation prove nothing at all.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kit_weak_owner') THEN
    CREATE ROLE kit_weak_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT BYPASSRLS;
  END IF;

  -- A role left behind by a `--keep` run is reused, not recreated, so all three
  -- attributes are checked rather than assumed. Checking only rolsuper accepted
  -- a leftover NOBYPASSRLS or NOINHERIT role in silence.
  SELECT rolsuper, rolbypassrls, rolinherit
    INTO v_super, v_bypass, v_inherit
    FROM pg_roles WHERE rolname = 'kit_weak_owner';

  IF v_super OR NOT v_bypass OR NOT v_inherit THEN
    RAISE EXCEPTION 'owner simulation: kit_weak_owner is (super=%, bypassrls=%, inherit=%) and must be (false, true, true) to mirror the real owner',
      v_super, v_bypass, v_inherit;
  END IF;

  -- Exactly what the real owner has, and nothing more. pg_read_all_data brings
  -- USAGE on app_private and SELECT everywhere; the three API roles bring what
  -- they are granted. None of them carries EXECUTE on anything in app_private,
  -- which is the one reach the simulated owner must lack.
  --
  -- WITH INHERIT TRUE is explicit for the same reason the role attribute is:
  -- since PG16 a membership carries its own INHERIT flag, defaulted from the
  -- member's rolinherit. The image is PG17, so the default would do — and would
  -- leave the file silent about the property it depends on.
  GRANT pg_read_all_data              TO kit_weak_owner WITH INHERIT TRUE;
  GRANT authenticated, anon, service_role TO kit_weak_owner WITH INHERIT TRUE;
  GRANT USAGE ON SCHEMA public TO kit_weak_owner;
  -- Point in time, and deliberately so: this grants what exists when the hook
  -- fires. A table a later migration adds is not covered, and a planning RPC
  -- that touched it would fail here for a reason production does not have —
  -- the real owner owns the business tables outright. Re-run the grant from a
  -- later hook position if that day comes.
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

  -- The profile guard is only handed over where 20260917130000 will reclaim it.
  IF v_pre_3_3 THEN
    EXECUTE 'ALTER FUNCTION public.enforce_user_profile_privilege_guard() OWNER TO kit_weak_owner';
    v_n := v_n + 1;
    RAISE NOTICE 'owner simulation: the profile guard is handed over; 20260917130000 must take it back';
  ELSE
    -- Past 20260917130000 the guard is left alone. Nothing else is needed here
    -- either: that migration granted EXECUTE on get_active_company_id() to
    -- `authenticated` (:292), and kit_weak_owner is a member, so it already
    -- holds it by inheritance exactly as the real owner does. An earlier draft
    -- granted it again and explained the grant by saying the migration's loop
    -- "gave it EXECUTE when it ran" — which the header refutes: for that target
    -- the loop never enters its body.
    RAISE NOTICE 'owner simulation: past 20260917130000 — the profile guard is left alone';
  END IF;

  SELECT count(*) FILTER (WHERE has_function_privilege('kit_weak_owner', p.oid, 'EXECUTE')),
         count(*)
    INTO v_reach, v_total
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app_private';

  /*
    The hazard, asserted rather than printed. This used to be a NOTICE, which
    made the file capable of the very failure it exists to end: a migration
    granting EXECUTE on app_private's functions to any role kit_weak_owner
    inherits — `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_private TO
    authenticated` would do it — empties the simulation, every ownership check
    then passes for free, and a printed number nobody reads says so in a corner
    of a green run.
  */
  IF v_reach <> 0 THEN
    RAISE EXCEPTION 'owner simulation: kit_weak_owner may execute % of the % functions in app_private, so it is not the weak owner this file claims and every ownership check passes for free',
      v_reach, v_total;
  END IF;

  -- The other half of the mirror: USAGE is held, as the real owner holds it
  -- through pg_read_all_data. Without it the simulated owner would be stricter
  -- than production and would fail the wrong check (20260916110010, check 3).
  IF NOT has_schema_privilege('kit_weak_owner', 'app_private', 'USAGE') THEN
    RAISE EXCEPTION 'owner simulation: kit_weak_owner holds no USAGE on app_private, which makes it stricter than the real owner rather than weaker';
  END IF;

  RAISE NOTICE 'owner simulation: % functions now belong to kit_weak_owner (super=%, bypassrls=%, inherit=%); USAGE on app_private, EXECUTE on 0 of its % functions',
    v_n, v_super, v_bypass, v_inherit, v_total;
END $$;
