/*
  Does the permission boundary actually hold?

  Every assertion impersonates a real principal — a JWT claim plus
  `SET LOCAL ROLE authenticated` — so the policies under test are the ones that
  run in production, not a re-description of them. See `_as()` for which claim
  form works here and why the other one silently does not.

  Each check raises on failure; a silent run is a pass. Two habits keep that
  from being hollow:

  - impersonation is verified before anything else, because a NULL `auth.uid()`
    denies everything and would turn every "cannot" assertion into a false pass;
  - each "cannot" on a table has a matching "can" for a permitted role, so a
    malformed statement cannot masquerade as a refusal.

  Two companies, five principals:

    company A   admin_a     role admin
                editor_a    role editor
                viewer_a    role viewer
    company B   admin_b     role admin
    platform    super       owner in app_private.platform_staff, company_id NULL

  and, for the answers a caller without a profile row gets, anon (no JWT) and
  a signed-in account with no user_profiles row.
*/

\set ON_ERROR_STOP on

-- ─── helpers ────────────────────────────────────────────────────────────────

/*
  Become `p_user`.

  `auth.uid()` in this schema reads, in order:

      coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
               (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))

  Only the first form works from here. The JSON variant is what PostgREST sets
  per request; setting it from inside a DO block does not reach the function the
  same way, and auth.uid() comes back NULL — which would make every assertion
  pass for the wrong reason, because a NULL uid matches no tenant and denies
  everything. The singular claim is checked first and is unambiguous.
*/
/*
  Since 20260919130000 every principal also carries an `amr` naming `password`.
  A platform capability requires a password-backed session, so without it a
  staff principal would hold no role — and a probe that should have failed on a
  policy would pass for the wrong reason. `password` is what these principals
  are: a session GoTrue minted from /token?grant_type=password. The sessions
  that are *not* password-backed are the subject of tests/rls/platform-amr.sql,
  and only that file makes them.
*/
CREATE OR REPLACE FUNCTION _as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/** Runs `sql` as `p_user` and reports whether it was allowed. */
CREATE OR REPLACE FUNCTION _allowed(p_user uuid, p_sql text) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
  PERFORM _as(p_user);
  EXECUTE p_sql;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RESET ROLE;
  -- RLS does not error on a blocked UPDATE/DELETE, it matches no rows.
  RETURN affected > 0;
EXCEPTION WHEN insufficient_privilege OR check_violation THEN
  RESET ROLE;
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION _check(p_desc text, p_got boolean, p_want boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION 'FAIL: % — expected %, got %', p_desc,
      CASE WHEN p_want THEN 'allowed' ELSE 'denied' END,
      CASE WHEN p_got  THEN 'allowed' ELSE 'denied' END;
  END IF;
  RAISE NOTICE 'ok  %  (%)', p_desc, CASE WHEN p_want THEN 'allowed' ELSE 'denied' END;
END $$;

/*
  Become the caller PostgREST sends for a request without a JWT: no subject
  claim, role anon. auth.uid() is then NULL, which here is the point.
*/
CREATE OR REPLACE FUNCTION _as_anon() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
END $$;

/*
  Runs `p_sql` as `p_user`, or as anon when `p_user` is NULL, and reports what
  happened: 'ok', or the SQLSTATE and message it raised. Always rolled back, so
  a call that should have been refused and was not leaves nothing behind.
*/
CREATE OR REPLACE FUNCTION _outcome(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
  v_msg   text;
BEGIN
  IF p_user IS NULL THEN
    PERFORM _as_anon();
  ELSE
    PERFORM _as(p_user);
  END IF;
  EXECUTE p_sql;
  RAISE EXCEPTION USING ERRCODE = 'ZZ001';
EXCEPTION
  WHEN SQLSTATE 'ZZ001' THEN
    RETURN 'ok';
  WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    RETURN v_state || ' ' || v_msg;
END $$;

/*
  ── Reaching a schema the caller cannot use ─────────────────────────────────

  Two catalogue readers behind the last two checks in this file. Both exist
  because of a defect the permission matrix could not see.

  ## What happened

  PR #117 shipped `app_private.enforce_company_role_shape`, a SECURITY INVOKER
  trigger on `public.roles` that called a helper in `app_private`.
  `authenticated` holds no USAGE on that schema, so every company administrator
  creating a role got `42501 permission denied for schema app_private`: the
  feature was dead on arrival. The RLS kit passed, twice, and `matrix.sql`
  reported `roles I` as `Y` for the admin principal — because schema USAGE is
  resolved when a statement is *parsed*, plpgsql caches the parsed form, and the
  owner runs every fixture before any principal is probed. `matrix.sql` now
  discards its plans per principal; these two checks are the shape rule beside
  that behavioural one.

  **Both return nothing on the current head.** PR #117's own fix moved the two
  helpers into `public`, and the owner measured the equivalent query against the
  live staging database with the same result. They are a guard against
  reintroduction, not a report of a live defect.

  ## The rule, and why it is three joins rather than a text walk

  A SECURITY INVOKER function runs as its caller, so its body is parsed with the
  caller's privileges. If an API role can reach such a function and the body
  names a schema that role cannot use, the call is refused — always, for that
  role, whatever the function is for.

  "Can reach" is two branches:

    (a) it is the function of a non-internal trigger on a table the role may
        write (and whose schema it may use), so the trigger fires as that role;
    (b) the role holds EXECUTE on it and may call it directly.

  Nothing else is needed, and that is a proof rather than a hope: every link of
  an invoker chain also runs as the caller, so every link needs the caller's own
  EXECUTE — which puts it under (b) on its own. Only the *first* link can be
  unreachable to the role and still run in its name, and that is (a).

  ## Three things that keep it honest

  - **Reachability is required.** Without it the query reports 36 functions on a
    clean head — `app_private.jwt_amr`, `platform_staff_role_of`,
    `platform_settings_problem`, the `fahrtenbuch_*` import helpers and the rest
    — every one of them invoker, in `app_private`, naming `app_private`, and
    reached only from SECURITY DEFINER functions owned by `supabase_admin`. An
    assertion with 36 false positives on a clean head is deleted within a month.
  - **Comments are stripped**, block first and then line, for the reason written
    out at `app_private.function_code`. That function is not called here: it
    raises on a signature it cannot resolve, and 20260921130000's header records
    the planner handing it an extension's C function. Two `regexp_replace`s on
    `prosrc` cannot raise.
  - **The name must resolve to a real object.** This codebase names its
    transaction-local flags after the schema — `current_setting(
    'app_private.support_write_context')`, `'app_private.support_shell_company'`
    — inside string literals, which comment-stripping does not touch. A bare
    `prosrc LIKE '%app_private.%'` would fire on `app_private.arm_support_shell_write`
    the day it stopped being SECURITY DEFINER. `support_write_context` is not an
    object in that schema; `role_name_is_system_reserved` was.

  ## The failure mode these readers have, twice over

  **An instrument that measures itself rather than the world.** It has now
  happened three times on this branch, and it is the thing to check first when a
  reader here reports something surprising:

  - the EXECUTE probe in `tests/tools/plan-cache-repro.sql` called an inlinable
    callee, so it measured the planner folding a call away rather than a
    privilege;
  - `tests/tools/plan-cache-repro.sql` itself would not parse, because prose in
    its header opened a nested block comment;
  - and the schema reader below failed on `_execute_reach_exemptions()`, whose
    body holds `app_private.enforce_company_role_shape` as an exemption *key* —
    read as a reference to it.

  Hence the `proname !~ '^_'` filter in `_reachable_invoker()` and the `relname`
  one in the policy reader: `^_` is matrix.sql's own convention for the kit's
  plumbing, used by its UNCOVERED sweep. **The positive control's offenders are
  named `probe_*` for exactly that reason**, so the filter cannot hide them —
  and because the control asserts that the readers *find* something, a filter
  that was too broad fails the run rather than silencing it. A control that
  asserted an absence could be silenced; this one cannot.

  The helpers are also revoked from the API roles (below), because the reason all
  three roles reached that exemption list in the first place was Supabase's
  default grant on every new `public` function.

  ## Its limits, so nobody mistakes it for more

  - It reads text. Dynamic SQL built at runtime is invisible to it, as is a
    body in any language but plpgsql and sql.
  - A GUC whose name happens to match an object's would be reported. None does.
  - It says nothing about EXECUTE: a reachable invoker function calling another
    function the role may not execute fails just as completely, and is the
    subject of no check here.
*/
/*
  The three roles PostgREST authenticates as. No catalogue column says "this is
  an API role", which is why they are named here and nowhere else in these two
  readers. `service_role` is among them because the edge functions hold that key
  and write tables that carry triggers.
*/
CREATE OR REPLACE FUNCTION _api_roles()
RETURNS TABLE (api_role text)
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT r FROM unnest(ARRAY['anon', 'authenticated', 'service_role']::text[]) AS r
$fn$;

CREATE OR REPLACE FUNCTION _confined_schemas()
RETURNS TABLE (api_role text, nspoid oid, nspname text)
LANGUAGE sql STABLE AS $fn$
  SELECT r.api_role, n.oid, n.nspname
    FROM _api_roles() r
    CROSS JOIN pg_namespace n
   WHERE n.nspname <> 'information_schema'
     AND n.nspname NOT LIKE 'pg\_%'
     -- a plain identifier, so it can go into a regular expression unescaped
     AND n.nspname ~ '^[a-z_][a-z0-9_]*$'
     AND NOT has_schema_privilege(r.api_role, n.oid, 'USAGE')
$fn$;

/** Does `p_name` name a function, relation or type in `p_nsp`? */
CREATE OR REPLACE FUNCTION _object_exists_in(p_nsp oid, p_name text) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM pg_proc  x WHERE x.pronamespace = p_nsp AND x.proname = lower(p_name)
    UNION ALL
    SELECT 1 FROM pg_class x WHERE x.relnamespace = p_nsp AND x.relname = lower(p_name)
    UNION ALL
    SELECT 1 FROM pg_type  x WHERE x.typnamespace = p_nsp AND x.typname = lower(p_name))
$fn$;

/*
  The reachable SECURITY INVOKER functions, per API role, with their bodies and
  comments stripped. Both readers below start here, so "can reach" is defined
  once. Branches (a) and (b) are the ones argued for above.
*/
CREATE OR REPLACE FUNCTION _reachable_invoker()
RETURNS TABLE (oid oid, api_role text, routine text, body text, reached_by text)
LANGUAGE sql STABLE AS $fn$
  WITH invoker AS (
    SELECT p.oid,
           p.oid::regprocedure::text AS routine,
           regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g') AS body
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
     WHERE NOT p.prosecdef
       AND l.lanname IN ('plpgsql', 'sql')
       AND p.prokind IN ('f', 'p')
       -- The kit's own plumbing is not part of the world these readers measure,
       -- and it has to be excluded or they measure themselves. `_execute_reach_exemptions()`
       -- holds `app_private.enforce_company_role_shape` as a *key*, and the
       -- schema reader read that as a reference and failed on the very list it
       -- is meant to excuse. `^_` is matrix.sql's own convention for this, used
       -- by its UNCOVERED sweep. The positive control's offenders are named
       -- `probe_*` precisely so this filter does not hide them.
       --
       -- It costs no real coverage, and that is checked rather than assumed: no
       -- function created anywhere in supabase/migrations or in the fixture has a
       -- name beginning with an underscore. If one ever does, it is invisible to
       -- these readers and needs a name that is not the kit's convention.
       AND p.proname !~ '^_'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass
                          AND d.objid = p.oid AND d.deptype = 'e')
  )
  -- (a) fired as the role, by a trigger on a table the role may write
  SELECT i.oid, c.api_role, i.routine, i.body,
         format('%s on %s', t.tgname, t.tgrelid::regclass::text)
    FROM invoker i
    JOIN pg_trigger t  ON t.tgfoid = i.oid AND NOT t.tgisinternal
    JOIN pg_class   tc ON tc.oid = t.tgrelid
    CROSS JOIN _api_roles() c
   WHERE has_schema_privilege(c.api_role, tc.relnamespace, 'USAGE')
     AND has_table_privilege(c.api_role, t.tgrelid, 'INSERT, UPDATE, DELETE, TRUNCATE')
  UNION
  -- (b) called by the role directly
  SELECT i.oid, c.api_role, i.routine, i.body, format('EXECUTE granted to %s', c.api_role)
    FROM invoker i
    CROSS JOIN _api_roles() c
   WHERE has_function_privilege(c.api_role, i.oid, 'EXECUTE')
$fn$;

CREATE OR REPLACE FUNCTION _invoker_reaches_confined_schema()
RETURNS TABLE (api_role text, routine text, nspname text, object_name text, reached_by text)
LANGUAGE sql STABLE AS $fn$
  SELECT DISTINCT rr.api_role, rr.routine, s.nspname, m.parts[1], rr.reached_by
    FROM _reachable_invoker() rr
    JOIN _confined_schemas() s ON s.api_role = rr.api_role
    CROSS JOIN LATERAL regexp_matches(rr.body, '\m' || s.nspname || '\.([a-z_][a-z0-9_$]*)', 'gi') AS m(parts)
   WHERE _object_exists_in(s.nspoid, m.parts[1])
$fn$;

/*
  ── The EXECUTE class, reported and not yet asserted ────────────────────────

  Function `EXECUTE` is masked by the plan cache exactly as schema `USAGE` is —
  both are resolved when the statement is planned. That was **measured** on
  PostgreSQL 17.6 (tests/tools/plan-cache-repro.sql, step F1), after a reading of
  the source said the opposite and a first probe written from that reading
  confirmed the wrong answer for a second reason. `matrix.sql`'s `roles I` cell
  is the same finding in this kit: `anon` reads `PP`, not `RR`, because
  `role_name_is_system_reserved` is granted to `authenticated` and not to it.

  So the class is real and the rule is the mirror of the one above: a reachable
  SECURITY INVOKER function must not **call** a function the role may not
  execute. This reader finds those.

  **It fails, with one recorded exemption.** It shipped as a warning for exactly
  one release, while its false-positive count on a clean head was unknown — the
  rule above could ship red immediately because its count was known first (36
  without the reachability branches, 0 with them). That count is now in: **one
  row**, measured 26.09.2026, and neither noise source this reader was built to
  tolerate fired. So it fails like the other two, and the single explained case is
  a keyed exemption below rather than a warning nobody reads twice.

  The two noise sources are still real and are the reason the narrowing below
  matters: a function name can appear inside a string literal that builds dynamic
  SQL, where comment-stripping does not reach it, and `service_role` holds
  Supabase's default EXECUTE on a great many invoker functions while a large
  number of this project's own functions are deliberately `authenticated`-only.

  What it is narrowed by, so the number means something:

  - only names that resolve to a real function in a schema the role **can** use —
    a call into a confined schema is the reader above's finding, not a second
    report of the same line;
  - a bare name is skipped when `pg_catalog` holds one too, because every
    function here runs with `search_path = pg_catalog, public` and `pg_catalog`
    wins. That is what keeps `format(`, `coalesce(`, `count(` and the rest out;
  - a name is flagged only when **no overload** of it is executable by the role,
    so an overloaded function with one granted signature is never reported;
  - a function calling itself is not a finding.
*/
CREATE OR REPLACE FUNCTION _invoker_calls_unexecutable_function()
RETURNS TABLE (api_role text, routine text, called text, reached_by text)
LANGUAGE sql STABLE AS $fn$
  WITH called AS (
    SELECT rr.api_role, rr.oid, rr.routine, rr.reached_by,
           m.parts[1] IS NOT NULL                  AS qualified,
           lower(coalesce(m.parts[1], 'public'))   AS nsp,
           lower(m.parts[2])                       AS name
      FROM _reachable_invoker() rr
      CROSS JOIN LATERAL regexp_matches(
              rr.body, '\m(?:([a-z_][a-z0-9_]*)\.)?([a-z_][a-z0-9_$]*)\s*\(', 'gi') AS m(parts)
  ),
  candidates AS (
    SELECT c.*, n.oid AS nspoid
      FROM called c
      JOIN pg_namespace n ON n.nspname = c.nsp
     WHERE has_schema_privilege(c.api_role, n.oid, 'USAGE')
       AND (c.qualified
            OR NOT EXISTS (SELECT 1 FROM pg_proc pc
                            WHERE pc.pronamespace = 'pg_catalog'::regnamespace
                              AND pc.proname = c.name))
  )
  SELECT DISTINCT cd.api_role, cd.routine, cd.nsp || '.' || cd.name, cd.reached_by
    FROM candidates cd
   WHERE EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.pronamespace = cd.nspoid AND p.proname = cd.name AND p.oid <> cd.oid)
     AND NOT EXISTS (SELECT 1 FROM pg_proc p
                      WHERE p.pronamespace = cd.nspoid AND p.proname = cd.name
                        AND has_function_privilege(cd.api_role, p.oid, 'EXECUTE'))
$fn$;

/*
  The one case on a clean head, recorded with its reason and failed on anything
  else. Measured 26.09.2026: this reader returns exactly one row, and neither of
  the noise sources it was built to tolerate fired — no dynamic-SQL string
  literal, no `service_role` match.

  This repository's idiom for a known, explained case is not a warning that a
  passing run prints and nobody reads. It is a recorded exemption with a reason
  beside it, failing on anything that moves: `matrix.sql` does it per cell,
  `tests/rls/subscriptions.sql` does it as `HOLE[revival]`. So this reader fails,
  and this table is the exemption.

  Keyed on all three of role, invoker function and called function. A wildcard on
  any one of them would let the exemption absorb a different defect — another
  function reaching the same helper, or this function reaching something else.

  **What would make the exemption wrong:** `roles_insert` is `TO authenticated`,
  so `anon` cannot insert a role whatever the grant on the helper says, and the
  trigger is unreachable for it. Granting `anon` EXECUTE would widen what it can
  reach in order to change a refusal's SQLSTATE, which is why 20260923120000
  does not. **If `roles_insert` ever admits `anon`, that premise is gone** and the
  grant has to be reconsidered rather than this line extended. The same fact is
  recorded at `roles I` in matrix.sql; the two move together.
*/
CREATE OR REPLACE FUNCTION _execute_reach_exemptions()
RETURNS TABLE (api_role text, routine text, called text, reason text)
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT * FROM (VALUES
    ('anon'::text,
     'app_private.enforce_company_role_shape()'::text,
     'public.role_name_is_system_reserved'::text,
     'roles_insert is TO authenticated, so anon never reaches this trigger (20260923120000)'::text)
  ) AS t(api_role, routine, called, reason)
$fn$;

/*
  The policy half, and it is a different rule rather than the same one applied
  to policies.

  A policy's USING and WITH CHECK are parsed under the *querying* role, and a
  function named there needs that role's USAGE and EXECUTE **whether or not it
  is SECURITY DEFINER** — `SECURITY DEFINER` changes the role a function runs
  as, never who may name it. So this binds a strictly larger set than the check
  above, and it is why every platform branch in this schema is written as
  `public.platform_can(…)` and never as the `app_private` function behind it.

  It is covered although the matrix would notice: a table owner bypasses RLS, so
  no owner pass ever parses a policy, and such a policy would fail loudly for
  every principal. What the check buys is naming the defect in one line instead
  of a moved column, and the two cases where the loud failure does not happen —
  a table with FORCE ROW LEVEL SECURITY, and a policy reached through an invoker
  function the owner does run. "The matrix would catch it" was also true of
  `roles I`.
*/
CREATE OR REPLACE FUNCTION _policy_reaches_confined_schema()
RETURNS TABLE (api_role text, relation text, policy_name text, nspname text, object_name text)
LANGUAGE sql STABLE AS $fn$
  WITH pol AS (
    SELECT p.polname, p.polrelid, p.polroles, c.relnamespace,
           c.oid::regclass::text AS relation,
           coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS expr
      FROM pg_policy p
      JOIN pg_class  c ON c.oid = p.polrelid
     -- as above, and for the same reason: the kit's own tables are not the world
     WHERE c.relname !~ '^_'
  )
  SELECT s.api_role, pol.relation, pol.polname, s.nspname, m.parts[1]
    FROM pol
    JOIN _confined_schemas() s ON true
    JOIN pg_roles r ON r.rolname = s.api_role
    CROSS JOIN LATERAL regexp_matches(pol.expr, '\m' || s.nspname || '\.([a-z_][a-z0-9_$]*)', 'gi') AS m(parts)
   WHERE has_schema_privilege(s.api_role, pol.relnamespace, 'USAGE')
     AND has_table_privilege(s.api_role, pol.polrelid, 'SELECT, INSERT, UPDATE, DELETE')
     -- a policy applies to PUBLIC (polroles = {0}) or to the roles it names
     AND (pol.polroles = '{0}'::oid[] OR r.oid = ANY (pol.polroles))
     AND _object_exists_in(s.nspoid, m.parts[1])
$fn$;

/*
  Every helper in this file is revoked from the API roles.

  Two reasons, and the first is the one that cost a round trip. Supabase's default
  privileges grant EXECUTE on each new `public` function to PUBLIC, anon,
  authenticated and service_role — the trap CLAUDE.md names for every new
  function — so `_execute_reach_exemptions()` was reachable by all three roles and
  the schema reader flagged it. The filter above is what stops a reader seeing the
  kit's plumbing; this is what stops the plumbing being reachable in the first
  place, which is the same defect closed at its source rather than at the
  instrument.

  Second: these helpers run only as the connecting role, from `DO` blocks in this
  file and the ones after it, and a `SET LOCAL ROLE` inside them does not need the
  target role to hold EXECUTE on the helper itself. So nothing is given up.
*/
REVOKE ALL ON FUNCTION _as(uuid)                                FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION _as_anon()                               FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION _allowed(uuid, text)                     FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION _check(text, boolean, boolean)           FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION _outcome(uuid, text)                     FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION _api_roles()                             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION _confined_schemas()                      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION _object_exists_in(oid, text)             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION _reachable_invoker()                     FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION _invoker_reaches_confined_schema()       FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION _invoker_calls_unexecutable_function()   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION _execute_reach_exemptions()              FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION _policy_reaches_confined_schema()        FROM PUBLIC, anon, authenticated, service_role;

-- ─── the matrix ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  co_a uuid; co_b uuid;
  admin_a uuid; editor_a uuid; viewer_a uuid; admin_b uuid; super_u uuid;
  drv_a uuid; drv_b uuid;
  n integer;
  -- functions only signed-in screens and the service role call, whose anon
  -- grant 20260915120000 revoked
  signed_in_only constant text[] := ARRAY[
    'public.compute_plan_price(text, integer, text, boolean)',
    'public.generate_invoice_number(integer)',
    'public.apply_monthly_planning_run(jsonb)',
    'public.replace_monthly_planning_run(jsonb, uuid)',
    'public.delete_or_archive_monthly_planning_run(uuid)',
    'public.purge_old_monthly_planning_runs(integer, integer)'];
  -- SECURITY DEFINER functions that check their caller themselves and that
  -- only signed-in screens call, whose anon grant 20260915140000 revoked
  guarded_signed_in constant text[] := ARRAY[
    'public.reassign_fahrtenbuch_trip(uuid, uuid, text, text, text, text)',
    'public.revoke_activation_code(uuid)',
    'public.delete_activation_code(uuid)',
    'public.hide_activation_code(uuid, text)',
    'public.update_company_subscription_manual(uuid, text, timestamp with time zone, timestamp with time zone, text, text)'];
  redeem_discount constant text := 'public.redeem_discount_code(text, uuid, text, text, integer)';
BEGIN
  SELECT id INTO co_a FROM companies WHERE slug = 'test-a';
  SELECT id INTO co_b FROM companies WHERE slug = 'test-b';
  SELECT user_id INTO admin_a  FROM user_profiles WHERE email = 'admin-a@test.invalid';
  SELECT user_id INTO editor_a FROM user_profiles WHERE email = 'editor-a@test.invalid';
  SELECT user_id INTO viewer_a FROM user_profiles WHERE email = 'viewer-a@test.invalid';
  SELECT user_id INTO admin_b  FROM user_profiles WHERE email = 'admin-b@test.invalid';
  SELECT user_id INTO super_u  FROM user_profiles WHERE email = 'super@test.invalid';
  SELECT id INTO drv_a FROM drivers WHERE company_id = co_a LIMIT 1;
  SELECT id INTO drv_b FROM drivers WHERE company_id = co_b LIMIT 1;

  -- Guard against the failure mode that would make this whole file worthless:
  -- if impersonation silently does not take, auth.uid() is NULL, every policy
  -- denies, and every "cannot" assertion passes for the wrong reason.
  PERFORM _as(admin_a);
  IF auth.uid() IS DISTINCT FROM admin_a THEN
    RESET ROLE;
    RAISE EXCEPTION 'impersonation is not working: auth.uid() returned % for %, so nothing below would mean anything', auth.uid(), admin_a;
  END IF;
  IF get_user_company_id() IS DISTINCT FROM co_a THEN
    RESET ROLE;
    RAISE EXCEPTION 'get_user_company_id() returned % but admin_a belongs to %', get_user_company_id(), co_a;
  END IF;
  RESET ROLE;
  RAISE NOTICE 'ok  impersonation verified — auth.uid() and get_user_company_id() resolve';

  -- ── tenant isolation ──────────────────────────────────────────────────────
  PERFORM _as(admin_a);
  SELECT count(*) INTO n FROM companies;
  RESET ROLE;
  PERFORM _check('company admin sees exactly one company', n = 1, true);

  PERFORM _as(admin_a);
  SELECT count(*) INTO n FROM drivers WHERE company_id = co_b;
  RESET ROLE;
  PERFORM _check('company A cannot read company B drivers', n = 0, true);

  PERFORM _check('company A cannot UPDATE a company B driver',
    _allowed(admin_a, format('UPDATE drivers SET name = %L WHERE id = %L', 'x-tenant', drv_b)), false);

  PERFORM _check('company A cannot DELETE a company B driver',
    _allowed(admin_a, format('DELETE FROM drivers WHERE id = %L', drv_b)), false);

  PERFORM _check('company A cannot INSERT into company B',
    _allowed(admin_a, format('INSERT INTO drivers (company_id, name) VALUES (%L, %L)', co_b, 'x')), false);

  -- ── viewer: read yes, write no ────────────────────────────────────────────
  PERFORM _as(viewer_a);
  SELECT count(*) INTO n FROM drivers WHERE company_id = co_a;
  RESET ROLE;
  PERFORM _check('viewer can read its own company drivers', n > 0, true);

  PERFORM _check('viewer cannot INSERT drivers',
    _allowed(viewer_a, format('INSERT INTO drivers (company_id, name) VALUES (%L, %L)', co_a, 'v')), false);
  PERFORM _check('viewer cannot UPDATE drivers',
    _allowed(viewer_a, format('UPDATE drivers SET name = %L WHERE id = %L', 'v', drv_a)), false);
  PERFORM _check('viewer cannot DELETE drivers',
    _allowed(viewer_a, format('DELETE FROM drivers WHERE id = %L', drv_a)), false);
  -- Column lists come from information_schema, not from memory: an INSERT that
  -- fails on a missing column would report "denied" and look like a pass.
  PERFORM _check('viewer cannot INSERT receipts',
    _allowed(viewer_a, format(
      'INSERT INTO receipts (company_id, receipt_number, date, description, driver_name) VALUES (%L, %L, current_date, %L, %L)',
      co_a, 'BEL-TEST-1', 'probe', 'Driver A')), false);
  PERFORM _check('viewer cannot INSERT income',
    _allowed(viewer_a, format(
      'INSERT INTO income (company_id, description, amount, type, driver_name) VALUES (%L, %L, 1, %L, %L)',
      co_a, 'probe', 'bar', 'Driver A')), false);
  -- …and the same INSERT must succeed for a role that may edit, or the two
  -- assertions above would pass even if the statement were simply malformed.
  PERFORM _check('admin CAN INSERT receipts (proves the statement itself is valid)',
    _allowed(admin_a, format(
      'INSERT INTO receipts (company_id, receipt_number, date, description, driver_name) VALUES (%L, %L, current_date, %L, %L)',
      co_a, 'BEL-TEST-2', 'probe', 'Driver A')), true);

  -- ── editor: allowed where the matrix says so, refused where it does not ────
  PERFORM _check('editor CAN INSERT drivers (role_permissions drivers.can_edit)',
    _allowed(editor_a, format('INSERT INTO drivers (company_id, name) VALUES (%L, %L)', co_a, 'editor-made')), true);
  PERFORM _check('editor CAN UPDATE drivers',
    _allowed(editor_a, format('UPDATE drivers SET name = %L WHERE id = %L', 'editor-touched', drv_a)), true);
  PERFORM _check('editor cannot UPDATE company_settings (settings.can_edit = false)',
    _allowed(editor_a, format('UPDATE company_settings SET company_name = %L WHERE company_id = %L', 'nope', co_a)), false);

  -- ── admin-only surfaces ───────────────────────────────────────────────────
  PERFORM _check('company admin cannot UPDATE its own companies row',
    _allowed(admin_a, format('UPDATE companies SET plan = %L WHERE id = %L', 'premium', co_a)), false);
  PERFORM _check('company admin CAN UPDATE company_settings',
    _allowed(admin_a, format('UPDATE company_settings SET company_name = %L WHERE company_id = %L', 'renamed', co_a)), true);
  PERFORM _check('viewer cannot UPDATE a colleague profile',
    _allowed(viewer_a, format('UPDATE user_profiles SET full_name = %L WHERE user_id = %L', 'hijack', admin_a)), false);
  PERFORM _check('viewer CAN UPDATE its own profile',
    _allowed(viewer_a, format('UPDATE user_profiles SET full_name = %L WHERE user_id = %L', 'self', viewer_a)), true);

  -- ── the platform account ──────────────────────────────────────────────────
  PERFORM _as(super_u);
  SELECT count(*) INTO n FROM companies;
  RESET ROLE;
  PERFORM _check('super admin sees every company', n >= 2, true);

  -- The row, yes; its subscription columns, no. Until 20260920120000 (plan 3.F
  -- U3) this probe set `plan` and was allowed: companies_update admits every
  -- column to a holder of companies.lifecycle, so a PATCH through PostgREST
  -- went past platform_company_set_plan, its audit row and the coverage rows it
  -- keeps in step. The row stays writable (that policy is 3.13's to narrow);
  -- the five derived columns are refused by refuse_direct_subscription_write.
  -- The probe also no longer leaves company A on premium for every later file.
  PERFORM _check('super admin CAN UPDATE a companies row',
    _allowed(super_u, format('UPDATE companies SET name = name WHERE id = %L', co_a)), true);
  PERFORM _check('super admin cannot set companies.plan directly (plan 3.F U3: platform_company_set_plan is the way)',
    _allowed(super_u, format('UPDATE companies SET plan = %L WHERE id = %L', 'premium', co_a)), false);
  -- Allowed until 20260917130000 (plan 3.3), and the rule it broke is the one
  -- this file exists to state: a staff role does not write a tenant's
  -- operational data because it is staff. It reads through the audited read
  -- models of 3.6b and, from 3.4, writes inside a logged support session.
  PERFORM _check('super admin cannot UPDATE an operational row in another company',
    _allowed(super_u, format('UPDATE drivers SET name = %L WHERE id = %L', 'support-fix', drv_b)), false);

  -- ── functions anon may not execute ────────────────────────────────────────
  -- Supabase's default privileges grant anon EXECUTE on every function created
  -- in public, and REVOKE … FROM PUBLIC leaves that grant alone. A migration
  -- that drops and recreates one of these functions gives anon its grant back
  -- unless it revokes it again. redeem_discount_code lost authenticated in
  -- 20260911120000 and anon in 20260915110000.
  PERFORM _check(format('anon cannot EXECUTE %s', f), has_function_privilege('anon', f, 'EXECUTE'), false)
     FROM unnest(signed_in_only || guarded_signed_in || redeem_discount) AS f;
  PERFORM _check('a signed-in user cannot EXECUTE redeem_discount_code',
    has_function_privilege('authenticated', redeem_discount, 'EXECUTE'), false);
  -- …and each function stays callable by the role it exists for.
  PERFORM _check('the service role CAN EXECUTE redeem_discount_code',
    has_function_privilege('service_role', redeem_discount, 'EXECUTE'), true);
  PERFORM _check(format('a signed-in user CAN EXECUTE %s', f), has_function_privilege('authenticated', f, 'EXECUTE'), true)
     FROM unnest(signed_in_only || guarded_signed_in) AS f;

  -- ── the super-admin check, for a caller without a profile ─────────────────
  -- is_user_super_admin() answered NULL, not false, to anyone without a
  -- user_profiles row. A policy denies on NULL as on false, but
  -- create_user_profile_manual's `IF NOT is_user_super_admin()` let NULL
  -- through while anon held EXECUTE, so the anon key reached its upsert of any
  -- account's role. Closed by hand on 15.09.2026, then by 20260915130000.
  DECLARE
    no_profile     constant uuid := 'f0000000-0000-4000-8000-000000000404';
    manual_profile constant text := 'public.create_user_profile_manual(uuid, text, text)';
    answer   boolean;
    as_uid   uuid;
    as_role  text;
    outcome  text;
  BEGIN
    IF EXISTS (SELECT 1 FROM user_profiles WHERE user_id = no_profile) THEN
      RAISE EXCEPTION 'user % has a profile, so nothing below would test a caller without one', no_profile;
    END IF;

    -- As with the signed-in principals, prove the impersonation took before
    -- trusting an answer: here that means no subject and the anon role.
    PERFORM _as_anon();
    as_uid  := auth.uid();
    as_role := current_user;
    answer  := is_user_super_admin();
    RESET ROLE;
    IF as_uid IS NOT NULL OR as_role IS DISTINCT FROM 'anon' THEN
      RAISE EXCEPTION 'anonymous impersonation is not working: auth.uid() returned %, current_user was %', as_uid, as_role;
    END IF;
    PERFORM _check('is_user_super_admin() is false, not NULL, for anon', answer IS FALSE, true);

    PERFORM _as(no_profile);
    answer := is_user_super_admin();
    RESET ROLE;
    PERFORM _check('is_user_super_admin() is false, not NULL, for a signed-in caller without a profile', answer IS FALSE, true);

    PERFORM _as(super_u);
    answer := is_user_super_admin();
    RESET ROLE;
    PERFORM _check('is_user_super_admin() is true for the platform owner', answer IS TRUE, true);

    PERFORM _check('anon cannot EXECUTE create_user_profile_manual',
      has_function_privilege('anon', manual_profile, 'EXECUTE'), false);
    PERFORM _check('a signed-in user CAN EXECUTE create_user_profile_manual (its guard decides)',
      has_function_privilege('authenticated', manual_profile, 'EXECUTE'), true);
    PERFORM _check('the service role CAN EXECUTE create_user_profile_manual',
      has_function_privilege('service_role', manual_profile, 'EXECUTE'), true);

    outcome := _outcome(NULL, format('SELECT create_user_profile_manual(%L, %L, %L)', viewer_a, 'anon', 'admin'));
    PERFORM _check(format('anon calling create_user_profile_manual is refused for lack of a grant [%s]', outcome),
      outcome LIKE '42501 permission denied%', true);

    -- Every signed-in caller who is not a super admin meets the guard, with a
    -- profile or without one. The company admin is the strongest of them.
    outcome := _outcome(admin_a, format('SELECT create_user_profile_manual(%L, %L, %L)', viewer_a, 'hijack', 'admin'));
    PERFORM _check(format('a company admin calling create_user_profile_manual gets the exception [%s]', outcome),
      outcome LIKE 'P0001 Access denied: only super admins%', true);
    outcome := _outcome(no_profile, format('SELECT create_user_profile_manual(%L, %L, %L)', no_profile, 'self', 'admin'));
    PERFORM _check(format('a signed-in caller without a profile calling create_user_profile_manual gets the exception [%s]', outcome),
      outcome LIKE 'P0001 Access denied: only super admins%', true);

    -- …and the platform owner still gets through both. What happens after
    -- the guard is not this check's business: the upsert never supplies
    -- user_profiles.email, which is NOT NULL, so today it fails with 23502 for
    -- the super admin as for anyone (recorded in matrix.sql).
    outcome := _outcome(super_u, format('SELECT create_user_profile_manual(%L, %L, %L)', viewer_a, 'Viewer A', 'viewer'));
    PERFORM _check(format('the column super admin passes create_user_profile_manual''s grant and guard [%s]', outcome),
      outcome NOT LIKE '42501%' AND outcome NOT LIKE 'P0001%', true);
  END;

  -- ── nothing a caller reaches may name a schema that caller cannot use ─────
  -- The two readers above, and the reason they exist, are documented at
  -- `_confined_schemas()`. Both return nothing on the current head.
  DECLARE
    control  text;
    findings text;
    n_hits   int;
    n_scan   int;
  BEGIN
    /*
      The positive control, first and in a subtransaction that is always
      unwound. Without it "the query returned no rows" and "the query is
      broken" look the same — the failure mode this file's own header warns
      about for impersonation. A deliberate offender of each kind is built, both
      readers must report it, and the answer travels out in the SQLSTATE's
      message so it cannot depend on what a rolled-back block leaves behind.
    */
    BEGIN
      CREATE SCHEMA probe_hidden;
      CREATE FUNCTION probe_hidden.thing() RETURNS boolean
        LANGUAGE sql IMMUTABLE AS 'SELECT true';

      -- SECURITY INVOKER, granted to authenticated: branch (b).
      CREATE FUNCTION public.probe_offender() RETURNS boolean
      LANGUAGE plpgsql
      SET search_path = pg_catalog, public
      AS $probe$ BEGIN RETURN probe_hidden.thing(); END $probe$;
      GRANT EXECUTE ON FUNCTION public.probe_offender() TO authenticated;

      -- not `n`: the enclosing block declares a variable of that name, and a
      -- column that shadows one is the kind of thing that works until it does not
      CREATE TABLE public.probe_pol (probe_n int);
      ALTER TABLE public.probe_pol ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON public.probe_pol TO authenticated;
      CREATE POLICY probe_pol_select ON public.probe_pol
        FOR SELECT TO authenticated USING (probe_hidden.thing());

      -- and the third reader's offender: a public function authenticated may
      -- not execute, called from an invoker function it may
      CREATE FUNCTION public.probe_ungranted() RETURNS boolean
        LANGUAGE plpgsql AS $probe$ BEGIN RETURN true; END $probe$;
      REVOKE ALL ON FUNCTION public.probe_ungranted() FROM PUBLIC, anon, authenticated, service_role;

      CREATE FUNCTION public.probe_caller() RETURNS boolean
      LANGUAGE plpgsql
      SET search_path = pg_catalog, public
      AS $probe$ BEGIN RETURN public.probe_ungranted(); END $probe$;
      GRANT EXECUTE ON FUNCTION public.probe_caller() TO authenticated;

      RAISE EXCEPTION USING ERRCODE = 'ZZ003', MESSAGE =
        (CASE WHEN EXISTS (SELECT 1 FROM _invoker_reaches_confined_schema()
                            WHERE api_role = 'authenticated'
                              AND routine LIKE '%probe_offender%'
                              AND nspname = 'probe_hidden') THEN 'a' ELSE '-' END) ||
        (CASE WHEN EXISTS (SELECT 1 FROM _policy_reaches_confined_schema()
                            WHERE api_role = 'authenticated'
                              AND policy_name = 'probe_pol_select'
                              AND nspname = 'probe_hidden') THEN 'b' ELSE '-' END) ||
        (CASE WHEN EXISTS (SELECT 1 FROM _invoker_calls_unexecutable_function()
                            WHERE api_role = 'authenticated'
                              AND routine LIKE '%probe_caller%'
                              AND called = 'public.probe_ungranted') THEN 'c' ELSE '-' END);
    EXCEPTION WHEN SQLSTATE 'ZZ003' THEN
      control := SQLERRM;
    END;
    PERFORM _check(format('the invoker-reach reader finds a deliberate offender [%s]', control),
      control LIKE 'a%', true);
    PERFORM _check(format('the policy reader finds a deliberate offender [%s]', control),
      control LIKE '_b%', true);
    PERFORM _check(format('the EXECUTE reader finds a deliberate offender [%s]', control),
      control LIKE '%c', true);

    -- A SECURITY INVOKER function an API role can reach, naming a schema that
    -- role cannot use, is refused 42501 for every such caller. PR #117 is the
    -- instance; matrix.sql could not see it because the plan cache had already
    -- answered under the owner.
    SELECT count(*),
           coalesce(string_agg(format('%s reaches %s (%s), whose body names %s.%s',
                                      api_role, routine, reached_by, nspname, object_name), E'\n    '), '')
      INTO n_hits, findings FROM _invoker_reaches_confined_schema();
    SELECT count(*) INTO n_scan FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
     WHERE NOT p.prosecdef AND l.lanname IN ('plpgsql', 'sql') AND p.prokind IN ('f', 'p')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                        AND d.objid = p.oid AND d.deptype = 'e');
    IF n_hits > 0 THEN
      RAISE EXCEPTION E'FAIL: a SECURITY INVOKER function an API role can reach names a schema it cannot use — every such call is refused 42501:\n    %', findings;
    END IF;
    RAISE NOTICE 'ok  no SECURITY INVOKER function an API role can reach names a schema it cannot use (% invoker functions scanned)', n_scan;

    -- The EXECUTE class. Fails like the two above; the one explained case on a
    -- clean head is a keyed exemption, and anything else turns the run red.
    SELECT count(*),
           coalesce(string_agg(format('%s reaches %s (%s) and calls %s',
                                      h.api_role, h.routine, h.reached_by, h.called), E'\n    '), '')
      INTO n_hits, findings
      FROM _invoker_calls_unexecutable_function() h
     WHERE NOT EXISTS (SELECT 1 FROM _execute_reach_exemptions() x
                        WHERE x.api_role = h.api_role
                          AND x.routine = h.routine
                          AND x.called = h.called);
    IF n_hits > 0 THEN
      RAISE EXCEPTION E'FAIL: a SECURITY INVOKER function an API role can reach calls a function that role may not execute — the call is refused 42501 for every such caller, and the plan cache can hide it:\n    %', findings;
    END IF;
    -- The exemptions must still be real, or a row silently kept alive here would
    -- excuse a defect that no longer looks like it.
    SELECT count(*) INTO n_scan
      FROM _execute_reach_exemptions() x
     WHERE NOT EXISTS (SELECT 1 FROM _invoker_calls_unexecutable_function() h
                        WHERE x.api_role = h.api_role
                          AND x.routine = h.routine
                          AND x.called = h.called);
    IF n_scan > 0 THEN
      RAISE EXCEPTION 'FAIL: % EXECUTE-reach exemption(s) match nothing any more — the case they excuse is gone, so the line goes with it', n_scan;
    END IF;
    RAISE NOTICE 'ok  no SECURITY INVOKER function an API role can reach calls a function it may not execute, beyond % recorded exemption(s)',
      (SELECT count(*) FROM _execute_reach_exemptions());

    -- And the same for a policy expression, which is parsed under the querying
    -- role and binds SECURITY DEFINER functions too.
    SELECT count(*),
           coalesce(string_agg(format('%s on %s applies to %s and names %s.%s',
                                      policy_name, relation, api_role, nspname, object_name), E'\n    '), '')
      INTO n_hits, findings FROM _policy_reaches_confined_schema();
    SELECT count(*) INTO n_scan FROM pg_policy;
    IF n_hits > 0 THEN
      RAISE EXCEPTION E'FAIL: a policy expression names a schema its callers cannot use — the policy cannot be parsed by them at all:\n    %', findings;
    END IF;
    RAISE NOTICE 'ok  no policy expression names a schema its callers cannot use (% policies scanned)', n_scan;
  END;

  -- ─── a table in public with RLS off must grant no API role ────────────────
  --
  -- Not our tables: the supabase/realtime image creates `tenants`, `extensions`
  -- and `schema_migrations` in `public` on boot, and Supabase's DEFAULT
  -- PRIVILEGES on that schema hand every new table there to anon and
  -- authenticated. Measured on production and staging on 26.09.2026: all three
  -- had RLS off, no policies, and all seven privileges for anon, and the public
  -- API answered 200 on each — `tenants` returning the 108-character Realtime
  -- signing secret, `extensions.settings` returning db_password. 20260926100000
  -- revokes them.
  --
  -- The revoke fixes three tables; this rule is the half that matters, because
  -- the cause is a default privilege and so the *next* table an image creates in
  -- public arrives the same way. Exactly three tables violated it before that
  -- migration and none after, so it ships as a failure with no exemption list.
  --
  -- It is a privilege rule, not an RLS rule: a table may legitimately have RLS
  -- off when no API role can reach it at all, which is why the test is the
  -- conjunction rather than "every public table has RLS".
  --
  -- **What this rule cannot do here, so nobody reads more into a green run than
  -- it says:** the kit's database is production's --schema=public dump plus the
  -- migration chain, and that dump carries none of the three tables above — they
  -- exist only where the Realtime image has booted. So for image-created tables
  -- this assertion passes vacuously. It earns its place against a table one of
  -- *our* migrations adds, which is the case we control. Catching the next
  -- image-created one means running the same query against the live databases;
  -- HANDOFF.md carries it as a host step with the query.
  DECLARE
    n_open  int;
    open_ls text;
  BEGIN
    SELECT count(*), coalesce(string_agg(format('%s grants %s to %s', relname, privs, grantee), E'
    ' ORDER BY relname), '')
      INTO n_open, open_ls
      FROM (
        SELECT c.relname, g.grantee,
               string_agg(DISTINCT g.privilege_type, ',' ORDER BY g.privilege_type) AS privs
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN information_schema.role_table_grants g
            ON g.table_schema = 'public' AND g.table_name = c.relname
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND NOT c.relrowsecurity
           AND g.grantee IN ('anon', 'authenticated')
         GROUP BY c.relname, g.grantee
      ) x;
    IF n_open > 0 THEN
      RAISE EXCEPTION E'FAIL: a table in public has RLS disabled and still grants an API role, so the publishable anon key reads it over the API:
    %', open_ls;
    END IF;
    RAISE NOTICE 'ok  no table in public has RLS disabled while granting anon or authenticated';
  END;

  RAISE NOTICE '── all assertions passed ──';
END $$;
