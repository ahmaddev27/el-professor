/*
  The plan catalogue (20261026120000): the rows are the price and the gate.

  Runs after seed.sql and roles-seed.sql, against the live policies, the live
  grants and the live function bodies, as real principals — the JWT claims plus
  SET LOCAL ROLE authenticated, as assertions.sql, company-roles.sql and
  permission-coverage.sql do — so what is tested is what PostgREST runs. Every
  check raises on failure; a silent run is a pass. Inside BEGIN … ROLLBACK, so
  the files after it see only the migrations and the seeds.

  ## Why this file has to exist

  `matrix.sql` speaks for the table's four commands and for the two RPCs as
  cells. It cannot speak for any of the following, and each is the reason the
  migration was written the way it was:

  1. **The cross-row invariants.** I1 (a higher plan's features are a superset
     of a lower plan's) and I2 (the union over active plans names every feature
     the build knows) are properties of a SET of rows. A matrix cell probes one
     statement. Sections 4 and 5 build a deliberate violation of each and
     require it to be caught — I2's especially, because its violation is the
     one that would silently lock every gated screen for every customer below
     premium.

  2. **That the move is arithmetically neutral.** Section 6 prices every
     combination from the stored book and from the projection and compares them
     as value AND as text. That is the whole claim of this release, and nothing
     in the matrix measures a number.

  3. **The rollback shadow.** Section 8 saves through the real RPC and then
     asserts that the two settings rows the PREVIOUS release reads were
     rewritten from the catalogue. Without that property this migration would
     need a SCHEMA_EPOCH bump, and the matrix has no concept of either.

  4. **Fail-closed on an empty catalogue.** Section 7: no plans must RAISE, not
     price at zero. `tests/rls/pricing.sql:811-820` asserts the same of a
     missing price_book row and that assertion must not be weakened by the
     catalogue taking over — a price of 0,00 EUR is a claim.

  ## What is deliberately NOT claimed here

  The table has no write policy, so there is no WITH CHECK to probe and no
  tenant to cross. Section 2 asserts the ABSENCE as a shape, which is the
  thing a later migration could restate away without any cell moving.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _pl_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.session_id', p_user::text, true);
  -- A password sign-in. Since 20260919130000 a platform capability is NULL
  -- without it, so every staff principal below would hold no role at all and
  -- each probe would pass for the wrong reason.
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE OR REPLACE FUNCTION _pl_as_anon() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
END $$;

CREATE OR REPLACE FUNCTION _pl_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/*
  Runs one statement as one principal — or as anon for the all-zero uuid, which
  no account holds — and returns what happened. A refusal is rolled back by the
  exception handler; a SUCCESS is not, so a probe that writes leaves its write
  behind. Section 3 re-reads the catalogue version before every save attempt
  for exactly that reason: a successful save advances it, and a loop that
  captured the version once would hand the next principal a stale one and read
  its `version_conflict` as a missing capability.

  Returns: */
/*

      `rows N`                        a write, and how many rows it touched
      the scalar                      a SELECT
      `ERR <sqlstate> <message>`      a refusal

  The SQLSTATE and not the message text is what the assertions compare, except
  where the message is the product's own stable reason. The outcome is read out
  of PostgreSQL's own fields and never out of a hint, because the
  supabase/postgres 17.6 image adds prose a bare PostgreSQL 16 does not.
*/
CREATE OR REPLACE FUNCTION _pl_try(p_user uuid, p_sql text, p_select boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text;
  v_n   integer;
BEGIN
  BEGIN
    IF p_user = '00000000-0000-0000-0000-000000000000'::uuid THEN
      PERFORM _pl_as_anon();
    ELSE
      PERFORM _pl_as(p_user);
    END IF;

    IF p_select THEN
      EXECUTE p_sql INTO v_out;
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_out := 'rows ' || v_n;
    END IF;

    PERFORM _pl_reset();
    RETURN coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    PERFORM _pl_reset();
    RETURN 'ERR ' || SQLSTATE || ' ' || SQLERRM;
  END;
END $$;

-- Two more platform principals, so the capability split is probed and not
-- assumed: pricing.manage is the owner's and billing's, never support's or
-- read_only's.
INSERT INTO auth.users (id, email) VALUES
  ('50000000-0000-4000-8000-000000000002', 'pl-billing@test.invalid'),
  ('50000000-0000-4000-8000-000000000003', 'pl-support@test.invalid'),
  ('50000000-0000-4000-8000-000000000004', 'pl-readonly@test.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, company_id, is_super_admin, status, must_change_password)
VALUES
  ('50000000-0000-4000-8000-000000000002', 'pl-billing@test.invalid',  'Billing',  'admin', NULL, true, 'active', false),
  ('50000000-0000-4000-8000-000000000003', 'pl-support@test.invalid',  'Support',  'admin', NULL, true, 'active', false),
  ('50000000-0000-4000-8000-000000000004', 'pl-readonly@test.invalid', 'ReadOnly', 'admin', NULL, true, 'active', false)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note) VALUES
  ('50000000-0000-4000-8000-000000000002', 'billing',   'plans.sql'),
  ('50000000-0000-4000-8000-000000000003', 'support',   'plans.sql'),
  ('50000000-0000-4000-8000-000000000004', 'read_only', 'plans.sql')
ON CONFLICT (user_id) DO NOTHING;

-- The premise of every capability assertion below. Asserted rather than
-- assumed: if the matrix in app_private.platform_capability_matrix() ever
-- widens pricing.manage, these probes would pass for the wrong reason.
DO $$
BEGIN
  IF NOT app_private.platform_role_can('owner', 'pricing.manage')
     OR NOT app_private.platform_role_can('billing', 'pricing.manage')
     OR app_private.platform_role_can('support', 'pricing.manage')
     OR app_private.platform_role_can('read_only', 'pricing.manage') THEN
    RAISE EXCEPTION 'plans.sql premise: pricing.manage is no longer the owner''s and billing''s alone, so every probe in sections 3 and 8 would measure something else';
  END IF;
END $$;

-- ─── 1. The seed is there, and it is the three plans at the right ranks ─────

DO $$
DECLARE v_got text;
BEGIN
  SELECT string_agg(format('%s:%s:%s:%s', p.slug, p.rank, p.price_per_car_cents, p.is_active), ' ' ORDER BY p.rank)
    INTO v_got FROM public.plans p;
  -- PLAN_RANK in src/utils/planFeatures.ts is the browser's copy of these
  -- ranks and src/lib/appConfigSeed.ts of these prices.
  -- `t` and not `true`: %s uses boolean's own output function.
  IF v_got IS DISTINCT FROM 'basic:0:2000:t advanced:1:4000:t premium:2:7000:t' THEN
    RAISE EXCEPTION 'plans 1: the seeded catalogue is %, expected basic:0:2000:t advanced:1:4000:t premium:2:7000:t', v_got;
  END IF;

  -- The feature sets, inverted from the map the migration read. Monotone by
  -- construction, and this pins the actual inversion rather than its property.
  SELECT string_agg(format('%s=%s', p.slug, array_length(p.features, 1)), ' ' ORDER BY p.rank)
    INTO v_got FROM public.plans p;
  IF v_got IS DISTINCT FROM 'basic=7 advanced=12 premium=16' THEN
    RAISE EXCEPTION 'plans 1: the inverted feature sets are %, expected basic=7 advanced=12 premium=16', v_got;
  END IF;

  IF NOT (SELECT features @> ARRAY['overview','belege','fahrer','fahrzeuge','umsaetze','fixkosten','bargeldbestand']
            FROM public.plans WHERE slug = 'basic') THEN
    RAISE EXCEPTION 'plans 1: basic does not grant the seven basic features';
  END IF;
  IF (SELECT features @> ARRAY['gehaelter'] FROM public.plans WHERE slug = 'advanced') THEN
    RAISE EXCEPTION 'plans 1: advanced grants gehaelter, which the stored map puts on premium';
  END IF;
  IF NOT (SELECT features @> app_private.plan_feature_keys() FROM public.plans WHERE slug = 'premium') THEN
    RAISE EXCEPTION 'plans 1: premium does not grant every feature the build knows, so I2 holds only by accident';
  END IF;
END $$;

-- ─── 2. The shape: SELECT only, and the absence of a write path ─────────────

DO $$
DECLARE v_cmd text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.plans'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'plans 2: RLS is not enabled on public.plans';
  END IF;
  SELECT string_agg(cmd || ':' || policyname, ' ' ORDER BY policyname)
    INTO v_cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'plans';
  IF v_cmd IS DISTINCT FROM 'SELECT:plans_select' THEN
    RAISE EXCEPTION 'plans 2: the policies on public.plans are "%", expected SELECT:plans_select alone — a write policy cannot hold a cross-row invariant', v_cmd;
  END IF;

  -- The grants, which are the wall in front of the missing policies: a role
  -- without the table privilege is refused before RLS is consulted at all.
  IF NOT has_table_privilege('authenticated', 'public.plans', 'SELECT') THEN
    RAISE EXCEPTION 'plans 2: authenticated cannot read public.plans, so the panel and the plan cards would be empty';
  END IF;
  FOREACH v_cmd IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF has_table_privilege('authenticated', 'public.plans', v_cmd)
       OR has_table_privilege('anon', 'public.plans', v_cmd)
       OR has_table_privilege('service_role', 'public.plans', v_cmd) THEN
      RAISE EXCEPTION 'plans 2: an API role holds % on public.plans; platform_plans_save is the only writer', v_cmd;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.plans', 'SELECT') THEN
    RAISE EXCEPTION 'plans 2: anon reads public.plans directly; the signed-out plan cards are served by get_public_config()';
  END IF;

  -- The deferred unique constraint. Section 8c depends on it, and without it a
  -- save that swaps two ranks is refused for a conflict the committed state
  -- does not contain.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.plans'::regclass AND conname = 'plans_rank_key'
                    AND condeferrable AND condeferred) THEN
    RAISE EXCEPTION 'plans 2: plans_rank_key is not DEFERRABLE INITIALLY DEFERRED';
  END IF;
END $$;

-- Per principal, on the real table through the real grants and policies.
DO $$
DECLARE
  v_row  record;
  v_got  text;
  v_bad  text := '';
BEGIN
  FOR v_row IN
    SELECT * FROM (VALUES
      ('anon',       '00000000-0000-0000-0000-000000000000'::uuid, false),
      ('viewer A',   'a0000000-0000-4000-8000-000000000003'::uuid, true),
      ('admin A',    'a0000000-0000-4000-8000-000000000001'::uuid, true),
      ('admin B',    'b0000000-0000-4000-8000-000000000001'::uuid, true),
      ('owner',      '50000000-0000-4000-8000-000000000001'::uuid, true),
      ('billing',    '50000000-0000-4000-8000-000000000002'::uuid, true),
      ('read_only',  '50000000-0000-4000-8000-000000000004'::uuid, true)
    ) AS t(label, uid, may_read)
  LOOP
    -- Reading: a price list, open to every signed-in principal.
    v_got := _pl_try(v_row.uid, 'SELECT count(*)::text FROM public.plans', true);
    IF v_row.may_read THEN
      IF v_got IS DISTINCT FROM '3' THEN
        v_bad := v_bad || format('%s reads "%s" not 3; ', v_row.label, v_got);
      END IF;
    ELSE
      IF v_got NOT LIKE 'ERR 42501%' THEN
        v_bad := v_bad || format('%s is not refused a read, it got "%s"; ', v_row.label, v_got);
      END IF;
    END IF;

    -- Writing: refused for everyone, including the platform owner, because
    -- there is no policy AND no grant. 42501 both ways.
    FOR v_got IN SELECT unnest(ARRAY[
      _pl_try(v_row.uid, $q$INSERT INTO public.plans (slug, name, rank, price_per_car_cents) VALUES ('mx', 'MX', 9, 100)$q$),
      _pl_try(v_row.uid, $q$UPDATE public.plans SET price_per_car_cents = 1 WHERE slug = 'basic'$q$),
      _pl_try(v_row.uid, $q$DELETE FROM public.plans WHERE slug = 'basic'$q$)
    ]) LOOP
      IF v_got NOT LIKE 'ERR 42501%' THEN
        v_bad := v_bad || format('%s was not refused a direct write: "%s"; ', v_row.label, v_got);
      END IF;
    END LOOP;
  END LOOP;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'plans 2 per principal: %', v_bad;
  END IF;
END $$;

-- ─── 3. platform_plans_list and platform_plans_save, per principal ──────────

DO $$
DECLARE
  v_row record;
  v_got text;
  v_bad text := '';
  v_cat jsonb;
  v_ver integer;
BEGIN
  SELECT version INTO v_ver FROM app_private.plan_catalogue_meta WHERE id;
  v_cat := app_private.plan_catalogue();

  FOR v_row IN
    SELECT * FROM (VALUES
      ('anon',      '00000000-0000-0000-0000-000000000000'::uuid, false, false),
      ('viewer A',  'a0000000-0000-4000-8000-000000000003'::uuid, true,  false),
      ('admin A',   'a0000000-0000-4000-8000-000000000001'::uuid, true,  false),
      ('owner',     '50000000-0000-4000-8000-000000000001'::uuid, true,  true),
      ('billing',   '50000000-0000-4000-8000-000000000002'::uuid, true,  true),
      ('support',   '50000000-0000-4000-8000-000000000003'::uuid, true,  false),
      ('read_only', '50000000-0000-4000-8000-000000000004'::uuid, true,  false)
    ) AS t(label, uid, may_list, may_save)
  LOOP
    -- The list: no capability, because the rows are already SELECT-able and a
    -- version is not a secret. anon holds no EXECUTE.
    v_got := _pl_try(v_row.uid, 'SELECT (public.platform_plans_list() ->> ''ok'')', true);
    IF v_row.may_list THEN
      IF v_got IS DISTINCT FROM 'true' THEN
        v_bad := v_bad || format('%s cannot list: "%s"; ', v_row.label, v_got);
      END IF;
    ELSE
      IF v_got NOT LIKE 'ERR 42501%' THEN
        v_bad := v_bad || format('%s is not refused the list: "%s"; ', v_row.label, v_got);
      END IF;
    END IF;

    -- The save: pricing.manage, so the owner and billing and nobody else. A
    -- refusal is a RETURN VALUE and never an exception, so the audit row that
    -- records it survives.
    --
    -- The version is re-read here, not captured before the loop: a successful
    -- save advances it, so the owner's pass would make billing's attempt a
    -- version_conflict and the probe would read that as a missing capability.
    SELECT version INTO v_ver FROM app_private.plan_catalogue_meta WHERE id;
    v_got := _pl_try(v_row.uid,
      format('SELECT (public.platform_plans_save(%L::jsonb, %s) ->> ''reason'')', v_cat, v_ver), true);
    IF v_row.may_save THEN
      IF v_got IS DISTINCT FROM '<null>' THEN
        v_bad := v_bad || format('%s cannot save: "%s"; ', v_row.label, v_got);
      END IF;
    ELSIF v_row.label = 'anon' THEN
      IF v_got NOT LIKE 'ERR 42501%' THEN
        v_bad := v_bad || format('anon is not refused the save: "%s"; ', v_got);
      END IF;
    ELSE
      IF v_got IS DISTINCT FROM 'denied' THEN
        v_bad := v_bad || format('%s is not denied the save, it got "%s"; ', v_row.label, v_got);
      END IF;
    END IF;
  END LOOP;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'plans 3: %', v_bad;
  END IF;
END $$;

-- The argument contract raises rather than answering, as every other platform
-- RPC's does.
DO $$
DECLARE v_got text;
BEGIN
  v_got := _pl_try('50000000-0000-4000-8000-000000000001',
                   'SELECT public.platform_plans_save(NULL, 1)::text', true);
  IF v_got NOT LIKE 'ERR 22023%' THEN
    RAISE EXCEPTION 'plans 3: a NULL payload must raise 22023, it got "%"', v_got;
  END IF;
  v_got := _pl_try('50000000-0000-4000-8000-000000000001',
                   'SELECT public.platform_plans_save(''[]''::jsonb, NULL)::text', true);
  IF v_got NOT LIKE 'ERR 22023%' THEN
    RAISE EXCEPTION 'plans 3: a NULL version must raise 22023, it got "%"', v_got;
  END IF;
END $$;

-- ─── 4. I1, monotonicity — with a positive control ──────────────────────────

/*
  The violation this exists to catch is NOT representable in the map being
  replaced: a map saying "gehaelter": "basic" grants it at every rank at or
  above basic automatically. With explicit per-plan sets, basic can grant a
  feature premium does not, and the union stays complete — so I2 alone is
  happy. Section 4 builds exactly that and requires the refusal.
*/
DO $$
DECLARE
  v_bad      jsonb;
  v_problem  text;
BEGIN
  -- basic gains gehaelter; advanced and premium are untouched.
  SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'basic'
                        THEN jsonb_set(e.value, '{features}', (e.value -> 'features') || '["gehaelter"]'::jsonb)
                        ELSE e.value END)
    INTO v_bad FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value);

  -- The union is still complete, so I2 would pass. That premise is asserted,
  -- or this section would not be testing I1 at all.
  IF (SELECT count(*) FROM unnest(app_private.plan_feature_keys()) AS k(key)
       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_bad) AS e(value)
                          WHERE (e.value ->> 'is_active')::boolean
                            AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.value -> 'features') AS f(value)
                                         WHERE f.value = k.key))) <> 0 THEN
    RAISE EXCEPTION 'plans 4 premise: the I1 fixture is also incomplete, so a refusal would not prove I1 fires';
  END IF;

  v_problem := app_private.plan_catalogue_problem(v_bad);
  IF v_problem IS DISTINCT FROM 'plans.monotonicity.basic.advanced.gehaelter' THEN
    RAISE EXCEPTION 'plans 4: a catalogue where basic grants a feature advanced does not is reported as "%", expected plans.monotonicity.basic.advanced.gehaelter', v_problem;
  END IF;

  -- And the RPC refuses it, with the problem code travelling out as a value.
  IF _pl_try('50000000-0000-4000-8000-000000000001',
             format('SELECT (public.platform_plans_save(%L::jsonb, %s) ->> ''problem'')',
                    v_bad, (SELECT version FROM app_private.plan_catalogue_meta WHERE id)), true)
     IS DISTINCT FROM 'plans.monotonicity.basic.advanced.gehaelter' THEN
    RAISE EXCEPTION 'plans 4: platform_plans_save does not report the monotonicity problem to its caller';
  END IF;

  -- The catalogue is unchanged by the refusal.
  IF (SELECT features @> ARRAY['gehaelter'] FROM public.plans WHERE slug = 'basic') THEN
    RAISE EXCEPTION 'plans 4: a refused save changed the catalogue anyway';
  END IF;
END $$;

-- ─── 5. I2, completeness — with a positive control ──────────────────────────

/*
  The violation that would silently lock every gated screen: a feature no
  active plan grants reads as premium in the browser, so a customer on basic or
  advanced meets LockedFeaturePage with no error anywhere.
*/
DO $$
DECLARE
  v_bad     jsonb;
  v_problem text;
  v_broken  integer;
BEGIN
  -- premium loses gehaelter, which no lower plan grants.
  SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'premium'
                        THEN jsonb_set(e.value, '{features}',
                             (SELECT coalesce(jsonb_agg(f.value), '[]'::jsonb)
                                FROM jsonb_array_elements(e.value -> 'features') AS f(value)
                               WHERE f.value <> '"gehaelter"'::jsonb))
                        ELSE e.value END)
    INTO v_bad FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value);

  /*
    I1 still holds for this fixture, so what fires below is I2 and not
    monotonicity. Counted as "adjacent pairs where the higher plan is NOT a
    superset of the lower", which must be zero.
  */
  SELECT count(*) INTO v_broken
    FROM jsonb_array_elements(v_bad) AS lo(value)
    JOIN jsonb_array_elements(v_bad) AS hi(value)
      ON (hi.value ->> 'rank')::integer = (lo.value ->> 'rank')::integer + 1
   WHERE NOT (
     (SELECT coalesce(array_agg(f.value), ARRAY[]::text[])
        FROM jsonb_array_elements_text(hi.value -> 'features') AS f(value))
     @>
     (SELECT coalesce(array_agg(g.value), ARRAY[]::text[])
        FROM jsonb_array_elements_text(lo.value -> 'features') AS g(value)));
  IF v_broken <> 0 THEN
    RAISE EXCEPTION 'plans 5 premise: the I2 fixture breaks I1 in % adjacent pair(s), so a refusal would not prove I2 fires', v_broken;
  END IF;

  v_problem := app_private.plan_catalogue_problem(v_bad);
  IF v_problem IS DISTINCT FROM 'plans.missing.gehaelter' THEN
    RAISE EXCEPTION 'plans 5: a catalogue granting gehaelter on no plan is reported as "%", expected plans.missing.gehaelter', v_problem;
  END IF;

  -- An UNKNOWN feature key is still valid: seeding a feature before the
  -- release that gates it is load-bearing for every future gated screen, and
  -- 20260917120000 states the same rule for the map being replaced.
  SELECT jsonb_agg(jsonb_set(e.value, '{features}',
                             (e.value -> 'features') || '["a_feature_from_the_future"]'::jsonb))
    INTO v_bad FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value);
  IF app_private.plan_catalogue_problem(v_bad) IS NOT NULL THEN
    RAISE EXCEPTION 'plans 5: a feature key the build does not know is refused (%); that is how a key is seeded before the release that reads it',
      app_private.plan_catalogue_problem(v_bad);
  END IF;
END $$;

-- Every other problem code, each a deliberate violation built from the seed.
DO $$
DECLARE
  v_row record;
  v_bad text := '';
BEGIN
  FOR v_row IN
    SELECT * FROM (VALUES
      ('not an array',    app_private.plan_catalogue_problem('{}'::jsonb),            'plans'),
      ('a string',        app_private.plan_catalogue_problem('"x"'::jsonb),           'plans'),
      ('empty',           app_private.plan_catalogue_problem('[]'::jsonb),            'plans'),
      ('a bad key set',   app_private.plan_catalogue_problem('[{"slug":"basic"}]'::jsonb), 'plans.entry.0'),
      ('a required slug deactivated', app_private.plan_catalogue_problem(
        (SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'advanced'
                               THEN jsonb_set(e.value, '{is_active}', 'false'::jsonb) ELSE e.value END)
           FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))), 'plans.required.advanced'),
      ('a fourth plan',   app_private.plan_catalogue_problem(
        app_private.plan_catalogue() || jsonb_build_array(jsonb_build_object(
          'slug','gold','name','Gold','rank',3,'price_per_car_cents',9000,
          'features', to_jsonb(app_private.plan_feature_keys()), 'is_active', true))), 'plans.extra.gold'),
      ('a duplicate rank', app_private.plan_catalogue_problem(
        (SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'advanced'
                               THEN jsonb_set(e.value, '{rank}', '0'::jsonb) ELSE e.value END)
           FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))), 'plans.rank.duplicate.0'),
      ('a blank name',     app_private.plan_catalogue_problem(
        (SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'basic'
                               THEN jsonb_set(e.value, '{name}', '"  "'::jsonb) ELSE e.value END)
           FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))), 'plans.name.basic'),
      ('a price above the ceiling', app_private.plan_catalogue_problem(
        (SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'basic'
                               THEN jsonb_set(e.value, '{price_per_car_cents}', '1000001'::jsonb) ELSE e.value END)
           FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))), 'plans.price.basic'),
      ('a fractional price', app_private.plan_catalogue_problem(
        (SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'basic'
                               THEN jsonb_set(e.value, '{price_per_car_cents}', '19.5'::jsonb) ELSE e.value END)
           FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))), 'plans.price.basic'),
      ('a negative price', app_private.plan_catalogue_problem(
        (SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'basic'
                               THEN jsonb_set(e.value, '{price_per_car_cents}', '-1'::jsonb) ELSE e.value END)
           FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))), 'plans.price.basic'),
      ('a feature that is not a string', app_private.plan_catalogue_problem(
        (SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'premium'
                               THEN jsonb_set(e.value, '{features}', (e.value -> 'features') || '[7]'::jsonb) ELSE e.value END)
           FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))), 'plans.features.premium'),
      ('a malformed feature key', app_private.plan_catalogue_problem(
        (SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'premium'
                               THEN jsonb_set(e.value, '{features}', (e.value -> 'features') || '["Not A Key"]'::jsonb) ELSE e.value END)
           FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))), 'plans.features.premium.key'),
      -- The seed itself passes. A release whose seed violates its own
      -- validator would refuse the operator's very first save.
      ('the seed',        app_private.plan_catalogue_problem(app_private.plan_catalogue()), NULL)
    ) AS t(label, got, want)
  LOOP
    IF v_row.got IS DISTINCT FROM v_row.want THEN
      v_bad := v_bad || format('%s -> %s (expected %s); ', v_row.label,
                               coalesce(v_row.got, 'NULL'), coalesce(v_row.want, 'NULL'));
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'plans 5 codes: %', v_bad;
  END IF;
END $$;

-- ─── 6. THE PRICE PROOF: the projection prices exactly as the stored book ───

/*
  This is the claim of the whole release. Every combination the four parity
  gates pin, plus a zero, a negative and a NULL car count, an unknown plan and
  an unknown cycle, priced from the stored price_book row and from
  app_private.plan_price_book(), compared as value AND as text — so a change of
  numeric SCALE cannot pass unnoticed. That text comparison is the assertion
  20260916150000's DO block makes and the one easiest to lose in a rewrite.
*/
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(format('%s/%s/%s/%s: stored %s vs catalogue %s',
                           coalesce(g.plan, 'NULL'), coalesce(g.cars::text, 'NULL'),
                           coalesce(g.cycle, 'NULL'), coalesce(g.first::text, 'NULL'),
                           coalesce(g.old_price::text, 'NULL'), coalesce(g.new_price::text, 'NULL')), '; ')
    INTO v_bad
    FROM (
      SELECT p.plan, c.cars, y.cycle, f.first,
             app_private.price_book_price(app_private.platform_setting_value('price_book'),
                                          p.plan, c.cars, y.cycle, f.first) AS old_price,
             app_private.price_book_price(app_private.plan_price_book(),
                                          p.plan, c.cars, y.cycle, f.first) AS new_price
        FROM unnest(ARRAY['basic','advanced','premium','gold',NULL]) AS p(plan)
        CROSS JOIN unnest(ARRAY[0,1,3,5,6,10,11,25,-3,NULL]) AS c(cars)
        CROSS JOIN unnest(ARRAY['monthly','yearly','weekly',NULL]) AS y(cycle)
        CROSS JOIN unnest(ARRAY[false,true,NULL]) AS f(first)
    ) g
   WHERE g.old_price IS DISTINCT FROM g.new_price
      OR g.old_price::text IS DISTINCT FROM g.new_price::text;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'plans 6: the catalogue prices differently from the stored book: %', v_bad;
  END IF;

  SELECT string_agg(format('%s/%s/%s/%s: stored %s vs catalogue %s',
                           coalesce(g.plan,'NULL'), coalesce(g.cars::text,'NULL'),
                           coalesce(g.cycle,'NULL'), coalesce(g.first::text,'NULL'),
                           coalesce(g.old_cents::text,'NULL'), coalesce(g.new_cents::text,'NULL')), '; ')
    INTO v_bad
    FROM (
      SELECT p.plan, c.cars, y.cycle, f.first,
             app_private.invoice_amount_cents(app_private.platform_setting_value('price_book'),
                                              p.plan, c.cars, y.cycle, f.first) AS old_cents,
             app_private.invoice_amount_cents(app_private.plan_price_book(),
                                              p.plan, c.cars, y.cycle, f.first) AS new_cents
        FROM unnest(ARRAY['basic','advanced','premium','gold',NULL]) AS p(plan)
        CROSS JOIN unnest(ARRAY[0,1,3,5,6,10,11,25,-3,NULL]) AS c(cars)
        CROSS JOIN unnest(ARRAY['monthly','yearly','weekly',NULL]) AS y(cycle)
        CROSS JOIN unnest(ARRAY[false,true,NULL]) AS f(first)
    ) g
   WHERE g.old_cents IS DISTINCT FROM g.new_cents
      OR g.old_cents::text IS DISTINCT FROM g.new_cents::text;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'plans 6: the catalogue decides a different invoice amount: %', v_bad;
  END IF;

  -- Byte-identical, which is stronger than equal-per-combination and is what
  -- makes the rollback shadow correct on day one.
  IF app_private.plan_price_book() IS DISTINCT FROM app_private.platform_setting_value('price_book') THEN
    RAISE EXCEPTION 'plans 6: the projected book is not byte-identical to the stored one. stored %, projected %',
      app_private.platform_setting_value('price_book'), app_private.plan_price_book();
  END IF;
  IF app_private.plan_feature_map() IS DISTINCT FROM app_private.platform_setting_value('plan_features') THEN
    RAISE EXCEPTION 'plans 6: the projected feature map is not byte-identical to the stored one. stored %, projected %',
      app_private.platform_setting_value('plan_features'), app_private.plan_feature_map();
  END IF;

  -- Both projections are documents the existing validator accepts, so the
  -- rollback shadow the RPC writes can never be a value platform_settings_put
  -- would have refused.
  IF app_private.platform_settings_problem('price_book', app_private.plan_price_book()) IS NOT NULL
     OR app_private.platform_settings_problem('plan_features', app_private.plan_feature_map()) IS NOT NULL THEN
    RAISE EXCEPTION 'plans 6: a projection is a document the settings validator would refuse';
  END IF;
END $$;

-- The two config RPCs and compute_plan_price now answer from the catalogue.
DO $$
DECLARE v_got text;
BEGIN
  v_got := _pl_try('a0000000-0000-4000-8000-000000000001',
                   'SELECT (public.get_app_config() -> ''price_book'')::text', true);
  IF v_got IS DISTINCT FROM app_private.plan_price_book()::text THEN
    RAISE EXCEPTION 'plans 6: get_app_config does not serve the catalogue''s book';
  END IF;
  v_got := _pl_try('a0000000-0000-4000-8000-000000000001',
                   'SELECT (public.get_app_config() -> ''plan_features'')::text', true);
  IF v_got IS DISTINCT FROM app_private.plan_feature_map()::text THEN
    RAISE EXCEPTION 'plans 6: get_app_config does not serve the catalogue''s feature map';
  END IF;
  v_got := _pl_try('00000000-0000-0000-0000-000000000000',
                   'SELECT (public.get_public_config() -> ''price_book'')::text', true);
  IF v_got IS DISTINCT FROM app_private.plan_price_book()::text THEN
    RAISE EXCEPTION 'plans 6: get_public_config does not serve the catalogue''s book to anon, which is what prices the signed-out plan cards';
  END IF;
  -- The per-car figure the product charges, through the public entry point.
  v_got := _pl_try('a0000000-0000-4000-8000-000000000001',
                   'SELECT public.compute_plan_price(''premium'', 5, ''monthly'')::text', true);
  IF v_got IS DISTINCT FROM '350' THEN
    RAISE EXCEPTION 'plans 6: compute_plan_price(premium, 5, monthly) is "%", expected 350', v_got;
  END IF;
END $$;

-- ─── 7. Fail closed: an empty catalogue raises, it does not price at zero ───

DO $$
DECLARE
  v_got text;
BEGIN
  -- A savepoint, because emptying the catalogue breaks the FK from companies.
  BEGIN
    ALTER TABLE public.companies DROP CONSTRAINT companies_plan_fkey;
    DELETE FROM public.plans;

    IF app_private.plan_price_book() IS NOT NULL THEN
      RAISE EXCEPTION 'plans 7: an empty catalogue still yields a price book, so a company would be quoted a price no plan names';
    END IF;

    BEGIN
      PERFORM public.compute_plan_price('basic', 5, 'monthly');
      RAISE EXCEPTION 'plans 7: compute_plan_price answered with no plans at all; a price of 0,00 EUR is a claim';
    EXCEPTION WHEN SQLSTATE 'P0002' THEN
      NULL;  -- the documented fail-closed branch, as a missing book row raises
    END;

    -- The invoice quote refuses rather than quoting zero.
    v_got := _pl_try('50000000-0000-4000-8000-000000000002',
                     'SELECT (public.platform_invoice_quotes(1, 2026) ->> ''reason'')', true);
    IF v_got IS DISTINCT FROM 'price_book_unreadable' THEN
      RAISE EXCEPTION 'plans 7: with no plans the quote answered "%", expected price_book_unreadable', v_got;
    END IF;

    -- One required plan missing is enough: a partial book is no book.
    RAISE EXCEPTION 'plans 7 rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'plans 7 rollback' THEN
      RAISE;
    END IF;
  END;
END $$;

-- Dropping just ONE of the three required plans must also fail closed, because
-- parsePriceBook in the browser answers null for a book missing a plan.
DO $$
BEGIN
  BEGIN
    ALTER TABLE public.companies DROP CONSTRAINT companies_plan_fkey;
    UPDATE public.plans SET is_active = false WHERE slug = 'advanced';
    IF app_private.plan_price_book() IS NOT NULL THEN
      RAISE EXCEPTION 'plans 7: a catalogue missing one required plan still yields a book; the browser would read it as malformed and keep whatever it already showed';
    END IF;
    RAISE EXCEPTION 'plans 7b rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'plans 7b rollback' THEN RAISE; END IF;
  END;
END $$;

-- ─── 8. A real save: the write, the shadow, the version and the audit row ───

DO $$
DECLARE
  v_ver    integer;
  v_answer jsonb;
  v_audit  integer;
  v_cat    jsonb;
BEGIN
  SELECT version INTO v_ver FROM app_private.plan_catalogue_meta WHERE id;
  -- `ok` rows only: section 3's loop already wrote several of each outcome, so
  -- a baseline over every outcome would not be comparable with the ok count.
  SELECT count(*) INTO v_audit FROM app_private.platform_audit_log
   WHERE action = 'platform_plans.save' AND outcome = 'ok';

  -- Raise basic from 20,00 to 25,00 EUR per car, as the panel would.
  SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'basic'
                        THEN jsonb_set(e.value, '{price_per_car_cents}', '2500'::jsonb)
                        ELSE e.value END)
    INTO v_cat FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value);

  PERFORM _pl_as('50000000-0000-4000-8000-000000000001');
  v_answer := public.platform_plans_save(v_cat, v_ver);
  PERFORM _pl_reset();

  IF (v_answer ->> 'success') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'plans 8: the owner''s save was refused: %', v_answer;
  END IF;

  -- a. The row moved.
  IF (SELECT price_per_car_cents FROM public.plans WHERE slug = 'basic') <> 2500 THEN
    RAISE EXCEPTION 'plans 8a: the catalogue did not take the new price';
  END IF;

  -- b. The version moved by one, and the stale version is now refused.
  IF (SELECT version FROM app_private.plan_catalogue_meta WHERE id) <> v_ver + 1 THEN
    RAISE EXCEPTION 'plans 8b: the catalogue version did not advance';
  END IF;
  PERFORM _pl_as('50000000-0000-4000-8000-000000000001');
  v_answer := public.platform_plans_save(v_cat, v_ver);
  PERFORM _pl_reset();
  IF (v_answer ->> 'reason') IS DISTINCT FROM 'version_conflict'
     OR (v_answer ->> 'current_version')::integer <> v_ver + 1 THEN
    RAISE EXCEPTION 'plans 8b: a stale version was not refused with the current one named: %', v_answer;
  END IF;

  -- c. THE ROLLBACK SHADOW. The two settings rows the PREVIOUS release reads
  --    were rewritten from the catalogue, so a rollback across this migration
  --    lands on a release that prices and gates correctly. Without this
  --    property the migration would need a SCHEMA_EPOCH bump.
  IF (app_private.platform_setting_value('price_book') -> 'price_per_car_cents' ->> 'basic')::integer <> 2500 THEN
    RAISE EXCEPTION 'plans 8c: the price_book shadow still names the old price; a rollback would price from a stale book';
  END IF;
  IF app_private.platform_setting_value('price_book') IS DISTINCT FROM app_private.plan_price_book() THEN
    RAISE EXCEPTION 'plans 8c: the price_book shadow and the projection disagree after a save';
  END IF;
  IF app_private.platform_setting_value('plan_features') IS DISTINCT FROM app_private.plan_feature_map() THEN
    RAISE EXCEPTION 'plans 8c: the plan_features shadow and the projection disagree after a save';
  END IF;
  -- The book-level keys the catalogue does NOT own are untouched by a save.
  IF (app_private.platform_setting_value('price_book') ->> 'yearly_discount_percent')::integer <> 10
     OR (app_private.platform_setting_value('price_book') ->> 'first_month_cents')::integer <> 20000
     OR jsonb_array_length(app_private.platform_setting_value('price_book') -> 'fleet_discount_tiers') <> 2 THEN
    RAISE EXCEPTION 'plans 8c: a plan save changed the fleet tiers, the yearly discount or the first month, which are the book''s own and not per-plan';
  END IF;

  -- d. The new price reaches the product's own entry point.
  PERFORM _pl_as('a0000000-0000-4000-8000-000000000001');
  IF public.compute_plan_price('basic', 1, 'monthly') <> 25 THEN
    RAISE EXCEPTION 'plans 8d: compute_plan_price does not answer the catalogue''s new price';
  END IF;
  PERFORM _pl_reset();

  -- e. Exactly one audit row, with the actor and the before/after values.
  IF (SELECT count(*) FROM app_private.platform_audit_log
       WHERE action = 'platform_plans.save' AND outcome = 'ok') <> v_audit + 1 THEN
    RAISE EXCEPTION 'plans 8e: a successful save did not write exactly one ok audit row';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log
                  WHERE action = 'platform_plans.save' AND outcome = 'ok'
                    AND category = 'settings'
                    AND actor_user_id = '50000000-0000-4000-8000-000000000001'
                    AND actor_role = 'owner'
                    AND target_type = 'plan_catalogue'
                    AND (before_value -> 'plans') IS NOT NULL
                    AND (after_value  -> 'plans') IS NOT NULL) THEN
    RAISE EXCEPTION 'plans 8e: the audit row does not name the actor, the role and both values';
  END IF;
  -- A refused caller leaves a denied row, so the refusal is on the record.
  IF NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log
                  WHERE action = 'platform_plans.save' AND outcome = 'denied') THEN
    RAISE EXCEPTION 'plans 8e: section 3''s refusals wrote no denied row';
  END IF;
END $$;

-- A rank swap in one payload: the whole reason plans_rank_key is deferred.
DO $$
DECLARE
  v_answer jsonb;
  v_swap   jsonb;
  v_ver    integer;
BEGIN
  /*
    The payload and the version are read BEFORE the principal is assumed.
    `authenticated` holds no USAGE on app_private, so naming
    app_private.plan_catalogue() after SET LOCAL ROLE raises
    "42501 permission denied for schema app_private" — the exact failure
    CLAUDE.md records for PR #117, met here in the probe rather than in the
    product.
  */
  SELECT jsonb_agg(CASE e.value ->> 'slug'
                     WHEN 'basic'    THEN jsonb_set(e.value, '{rank}', '1'::jsonb)
                     WHEN 'advanced' THEN jsonb_set(e.value, '{rank}', '0'::jsonb)
                     ELSE e.value END)
    INTO v_swap FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value);
  SELECT version INTO v_ver FROM app_private.plan_catalogue_meta WHERE id;

  PERFORM _pl_as('50000000-0000-4000-8000-000000000002');  -- billing holds pricing.manage
  v_answer := public.platform_plans_save(v_swap, v_ver);
  PERFORM _pl_reset();

  -- It is refused — but for the RIGHT reason: swapping the ranks of basic and
  -- advanced makes advanced the lower plan while it still grants more, which
  -- is a monotonicity violation and not a unique-constraint error. A 23505
  -- here would mean the deferred constraint had been lost.
  IF (v_answer ->> 'reason') IS DISTINCT FROM 'invalid_value'
     OR (v_answer ->> 'problem') NOT LIKE 'plans.monotonicity.%' THEN
    RAISE EXCEPTION 'plans 8f: a rank swap answered %, expected invalid_value with a monotonicity problem (a 23505 would mean plans_rank_key is no longer deferred)', v_answer;
  END IF;
END $$;

-- ─── 9. companies.plan is now a foreign key ─────────────────────────────────

DO $$
DECLARE v_got text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.companies'::regclass AND conname = 'companies_plan_fkey'
                    AND confrelid = 'public.plans'::regclass
                    AND confupdtype = 'a' AND confdeltype = 'a') THEN
    RAISE EXCEPTION 'plans 9: companies.plan does not reference plans(slug) with NO ACTION both ways';
  END IF;

  -- A typo is refused at write time, which companies.plan has never had: it
  -- carries no CHECK constraint, measured on production 26.10.2026.
  BEGIN
    UPDATE public.companies SET plan = 'premiumm'
     WHERE id = 'c0000000-0000-4000-8000-00000000000a';
    RAISE EXCEPTION 'plans 9: a company took a plan slug the catalogue does not hold';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  -- And a plan a company names cannot be deleted out from under it. Reported
  -- by the RPC as plan_in_use rather than as a raw 23503 the panel would
  -- print as "Keine Berechtigung".
  BEGIN
    DELETE FROM public.plans WHERE slug = 'basic';
    RAISE EXCEPTION 'plans 9: a plan a company names was deleted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END $$;

-- ─── 10. The formulas were not touched, and the shadow is not a reader ──────

DO $$
DECLARE v_missing text;
BEGIN
  -- The one thing a later restatement of any of the four readers would
  -- silently undo: reading the stored row again instead of the catalogue.
  SELECT string_agg(f.sig, '; ') INTO v_missing
    FROM (VALUES
      ('public.compute_plan_price(text,integer,text,boolean)'),
      ('public.platform_invoice_quotes(integer,integer)'),
      ('public.get_public_config()'),
      ('public.get_app_config()')
    ) AS f(sig)
   WHERE (SELECT p.prosrc FROM pg_proc p WHERE p.oid = f.sig::regprocedure) !~ 'plan_price_book\(\)'
      OR (SELECT p.prosrc FROM pg_proc p WHERE p.oid = f.sig::regprocedure) ~ 'platform_setting_value\(''price_book''\)';
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'plans 10: a reader prices from the stored price_book row again instead of the catalogue: %', v_missing;
  END IF;

  -- The formula itself, including the floor and the unfloored tier lookup,
  -- which 20261026110000 pins and 20261026120000 must not have touched.
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'app_private.price_book_price(jsonb,text,integer,text,boolean)'::regprocedure)
     !~ 'v_billed_cars integer := greatest\(coalesce\(p_car_limit, 1\), 1\)' THEN
    RAISE EXCEPTION 'plans 10: the billed-car floor moved inside price_book_price, which the catalogue migration must not touch';
  END IF;

  -- The edge functions' door still refuses this file's action; the allow-list
  -- is stricter than a reserved namespace, which is why platform_audit_record
  -- is not redefined by the migration.
  IF EXISTS (SELECT 1 FROM app_private.platform_edge_audit_actions()
              WHERE action = 'platform_plans.save') THEN
    RAISE EXCEPTION 'plans 10: platform_plans.save is reachable through the edge audit door; the database writes it alone';
  END IF;
END $$;

DO $$
BEGIN
  RAISE NOTICE '── plans: all checks passed (the catalogue is the price, and it prices identically) ──';
END $$;

DROP FUNCTION _pl_try(uuid, text, boolean);
DROP FUNCTION _pl_as(uuid);
DROP FUNCTION _pl_as_anon();
DROP FUNCTION _pl_reset();

ROLLBACK;
