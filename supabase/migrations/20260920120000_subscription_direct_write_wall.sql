/*
  # One subscription model, step U3: nothing writes the derived columns directly

  Plan 3.F, the last step. U0 was the read-only report, U1 (20260919150000) the
  coverage table and the recompute, U2 (20260919170000) the invoice rule; both
  are live on production since 19.09.2026.

  ## What was left open

  U1 made companies.subscription_status and .subscription_expires_at derived:
  app_private.recompute_company_subscription writes them from
  public.subscription_coverage and derives .plan, whose one other writer is
  platform_company_set_plan. The start date and the duration word belong to the
  two writers that set them, redeem_activation_code and
  update_company_subscription_manual. U1's self-check 7 fails a migration whose
  writers assign the derived columns, but it reads SQL. Nothing stood between a
  request PostgREST serves and the five columns.

  ## Every direct write, found before anything was changed

  Searched for a write of subscription_status, subscription_expires_at,
  subscription_started_at, subscription_duration_type or plan on companies in
  the browser, the edge functions, every migration and production's schema
  fixture, the RLS kit, the scripts, deploy/ and e2e/.

    the browser        None. Every company write in src is an RPC; the one
                       direct call left is CompaniesPage's hard delete (D13),
                       which writes no column.
    edge functions     None. The only companies call reads the name
                       (_shared/activation-code-delivery.ts:91).
    SQL functions      Exactly the sanctioned writers, in their current bodies:
                         recompute_company_subscription      status, expiry, plan
                         platform_company_set_plan           plan
                         redeem_activation_code              start, duration word
                         update_company_subscription_manual  start, duration word
                         signup_insert_company               plan, and 'inactive',
                                                             on INSERT
                       Every older body that assigned them (the fixture's
                       redeem_activation_code and update_company_subscription_manual,
                       20260621*, 20260916110010, 20260916130000, 20260916130020)
                       had the signature of the U1 restatement that replaced it,
                       so none survives as a second overload.
    the table's door   companies_update and companies_insert
                       (20260917130000:585-592) admit every column to a holder
                       of companies.lifecycle, over PostgREST, past the audit and
                       past the coverage rows; service_role bypasses RLS and
                       holds the table's privileges. Nothing in the product uses
                       either, and both were open.
    a host script      e2e/setup-staging.sh set subscription_status and
                       subscription_expires_at by hand on staging's e2e
                       companies. It now records coverage instead (see there).
    a kit assertion    tests/rls/assertions.sql asserted that the platform owner
                       can set companies.plan directly. It now asserts the
                       opposite, and keeps a control that the row itself is
                       still writable.

  ## The wall, and why a trigger rather than a column privilege

  A BEFORE INSERT OR UPDATE trigger on companies refuses, with SQLSTATE 42501,
  a change to any of the five columns made by a role PostgREST serves requests
  as. Three reasons against REVOKE UPDATE (...) instead:

  1. A column privilege is ignored while the table-level one is held, so the
     REVOKE would really be "revoke UPDATE and INSERT on the table, then grant
     every other column back by name". Any later wholesale grant reopens that
     silently, and this repository has shipped one: 20250930185334 runs
     GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role.
  2. A privilege refuses a column being named, not a column being changed. The
     kit watches the companies policies with `SET plan = plan`
     (platform-authority.sql, section 4). Under a REVOKE those probes would
     stop at the privilege check, before the policy they exist to watch.
  3. "May not change what it already was" is a trigger's rule, because only a
     trigger sees OLD. That is why 20260917130000 pinned the billing tables'
     company with the pin_billing_company_id trigger rather than a policy.

  ## How a sanctioned writer is told apart

  By current_user. A SECURITY DEFINER function runs as its owner, and every
  sanctioned writer is one. A request PostgREST serves runs as anon,
  authenticated or service_role, the only roles the authenticator is a member of
  and so the only ones it can SET ROLE to. That is a catalogue fact, not a
  setting: no GUC and no JWT claim is read, so a client cannot reach it.

  What that does not do, plainly: it does not tell one SECURITY DEFINER function
  from another. Every function owned by the database's owner passes. Telling
  them apart at runtime needs either the call stack as text (GET DIAGNOSTICS
  PG_CONTEXT, whose frames carry each statement's own text, so a statement can
  forge a frame), or a token every sanctioned writer sets before its UPDATE,
  which means restating five writers, among them redeem_activation_code and
  signup_insert_company. A restatement is how this repository has twice dropped
  a rule. So "only these writers" stays where U1 put it, in the catalogue, and is
  widened from two named functions to all of them:
  app_private.subscription_column_writes() reads every function in public and
  app_private, and check 4 below fails a release whose writers differ from the
  list above in either direction. tests/rls/subscriptions.sql section 8
  restates the same list after every migration and every earlier test file has
  run, as platform-authority.sql restates the capability matrix.

  A superuser at a psql prompt is not refused either. supabase_admin can disable
  any trigger, and an operator is not someone a trigger can hold. What an
  operator must do instead is record a period with
  app_private.subscription_coverage_record, as supabase_admin (HANDOFF.md);
  e2e/setup-staging.sh now does exactly that.

  ## What an API role may still do

  - UPDATE a company where RLS lets it, as long as none of the five changes. A
    statement that carries a column's current value is not a write of it: the
    check compares NEW with OLD, not the SET list, so a screen that sends a row
    back whole still saves.
  - INSERT a company whose five columns hold their neutral values:
    subscription_status 'inactive' with no expiry, which is what the recompute
    derives for a company with no coverage (a new row cannot have any), no start,
    no duration word, and plan 'basic', the column default. A tier is set
    afterwards through platform_company_set_plan, which records who set it.

  ## What changes, and for whom

  At deploy, nothing for anybody. This file writes no row: it installs a
  trigger and a catalogue reader, and checks them.

  Afterwards, one door closes that nothing in the product opens: a holder of
  companies.lifecycle can no longer set one of the five columns through
  PostgREST, and neither can an edge function holding the service key.

  The two daily sweeps are unchanged. U3 touches neither the recompute nor the
  invoice rule, so whatever app_private.recompute_all_company_subscriptions()
  and app_private.subscription_invoices_apply_all() would change, they change
  with or without this file. HANDOFF.md carries the dry run that measures it.

  ## SCHEMA_EPOCH stays at 2

  Expansive. A rollback re-activates the previous release against this
  database. That release's code writes none of these columns directly (the
  inventory above holds for it: this slice changes no screen), so the trigger
  has nothing of its to refuse, and its RPCs are SECURITY DEFINER and pass.

  ## Rules followed

  Pinned search_path on both functions, REVOKE ALL FROM PUBLIC, anon,
  authenticated and service_role on both, ALTER FUNCTION … OWNER TO CURRENT_USER
  on the one that reaches app_private, and a self-check that can fail. The
  trigger function is deliberately **not** SECURITY DEFINER; check 2 fails a
  release where it becomes one, because inside it current_user would always be
  its owner and the wall would open for everyone.
*/

-- ─── 1. The wall ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.refuse_direct_subscription_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- The roles PostgREST serves a request as. A SECURITY DEFINER function runs
  -- as its owner, which is never one of them.
  c_api_roles CONSTANT text[] := ARRAY['anon', 'authenticated', 'service_role'];
  v_written   text[];
BEGIN
  IF NOT (current_user::text = ANY (c_api_roles)) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A new row has no coverage, so the recompute's answer for it is
    -- ('inactive', no expiry); nothing has set a start or a duration word; the
    -- tier is the column default until platform_company_set_plan sets another.
    v_written := array_remove(ARRAY[
      CASE WHEN NEW.subscription_status        IS DISTINCT FROM 'inactive' THEN 'subscription_status' END,
      CASE WHEN NEW.subscription_expires_at    IS NOT NULL                 THEN 'subscription_expires_at' END,
      CASE WHEN NEW.subscription_started_at    IS NOT NULL                 THEN 'subscription_started_at' END,
      CASE WHEN NEW.subscription_duration_type IS NOT NULL                 THEN 'subscription_duration_type' END,
      CASE WHEN NEW.plan                       IS DISTINCT FROM 'basic'    THEN 'plan' END
    ]::text[], NULL::text);
  ELSE
    -- A change, not a mention: a statement carrying the current value passes.
    v_written := array_remove(ARRAY[
      CASE WHEN NEW.subscription_status        IS DISTINCT FROM OLD.subscription_status        THEN 'subscription_status' END,
      CASE WHEN NEW.subscription_expires_at    IS DISTINCT FROM OLD.subscription_expires_at    THEN 'subscription_expires_at' END,
      CASE WHEN NEW.subscription_started_at    IS DISTINCT FROM OLD.subscription_started_at    THEN 'subscription_started_at' END,
      CASE WHEN NEW.subscription_duration_type IS DISTINCT FROM OLD.subscription_duration_type THEN 'subscription_duration_type' END,
      CASE WHEN NEW.plan                       IS DISTINCT FROM OLD.plan                       THEN 'plan' END
    ]::text[], NULL::text);
  END IF;

  IF cardinality(v_written) > 0 THEN
    RAISE EXCEPTION 'companies: % may not be written directly; the subscription columns are derived from subscription_coverage',
      array_to_string(v_written, ', ')
      USING ERRCODE = '42501',
            HINT = 'Record a period through redeem_activation_code, update_company_subscription_manual or the invoice RPCs, and set a tier through platform_company_set_plan.';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_private.refuse_direct_subscription_write() IS
  'Plan 3.F U3: refuses a change to companies.subscription_status, '
  '.subscription_expires_at, .subscription_started_at, .subscription_duration_type '
  'or .plan by anon, authenticated or service_role. Not SECURITY DEFINER, on '
  'purpose: current_user is what tells a request from a SECURITY DEFINER writer.';

-- Every row, and not UPDATE OF the five: an earlier BEFORE trigger could change
-- a column the statement never named, and NEW against OLD sees that too.
DROP TRIGGER IF EXISTS refuse_direct_subscription_write ON public.companies;
CREATE TRIGGER refuse_direct_subscription_write
  BEFORE INSERT OR UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION app_private.refuse_direct_subscription_write();

-- A trigger function is not called through its EXECUTE grant: the trigger fires
-- it for whoever writes the row, as companies_clear_approval_note
-- (20260916130020) already does for these same roles. The REVOKE keeps it from
-- being called any other way.
REVOKE ALL ON FUNCTION app_private.refuse_direct_subscription_write()
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 2. The catalogue: who writes the five columns ──────────────────────────

/*
  One row per (function, column, statement) for every function in public and
  app_private whose body writes one of the five columns of companies: an UPDATE
  that assigns it, an INSERT that names it (or names no column list at all, and
  so writes every column), an ON CONFLICT … DO UPDATE that assigns it, or a
  MERGE that mentions it.

  A tripwire, like U1's checks 7 and 8: it reads text, through U1's
  app_private.function_code, which strips comments first. Its limits, so nobody
  mistakes it for more:

  - It cannot see dynamic SQL (EXECUTE of a string built at runtime) or a body
    in any language but plpgsql and sql.
  - It errs towards reporting. An `=` comparison on one of the columns in a
    WHERE clause counts as an assignment, and so does a semicolon cut short by
    one inside a string literal. A false report fails loudly and is read by a
    person; a false silence would not be.
  - Every statement ends at its first semicolon, by a negated class and not by
    a lazy quantifier. In PostgreSQL an RE takes its greediness from its first
    quantifier (9.7.3.5), so a lazy `(.*?);` after a greedy `\s+` still runs to
    the last semicolon of the body. That is the shape of U1's
    companies_set_clauses, which is harmless for the checks that use it but not
    a pattern to copy.
  - Functions whose name starts with an underscore are skipped. No migration
    defines one, and the RLS kit's helpers are all named that way; some of them
    insert companies to seed a test.
*/
CREATE OR REPLACE FUNCTION app_private.subscription_column_writes()
RETURNS TABLE (routine regprocedure, column_name text, via text)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH code AS (
    SELECT p.oid::regprocedure AS routine,
           app_private.function_code(p.oid::regprocedure::text) AS body
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language  l ON l.oid = p.prolang
     WHERE n.nspname IN ('public', 'app_private')
       AND l.lanname IN ('plpgsql', 'sql')
       AND p.prokind IN ('f', 'p')
       AND p.proname NOT LIKE '\_%'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass
                          AND d.objid = p.oid
                          AND d.deptype = 'e')
  ),
  statements AS (
    SELECT c.routine,
           lower(left(m.parts[1], 1)) AS verb,
           m.parts[2]                 AS rest
      FROM code c
     CROSS JOIN LATERAL regexp_matches(
             c.body,
             '\m(update|insert\s+into|merge\s+into)\s+(?:only\s+)?(?:"?public"?\.)?"?companies"?(?![a-z0-9_$])([^;]*)',
             'gi') AS m(parts)
  ),
  guarded(column_name) AS (
    VALUES ('plan'), ('subscription_duration_type'), ('subscription_expires_at'),
           ('subscription_started_at'), ('subscription_status')
  )
  SELECT DISTINCT s.routine,
         g.column_name,
         CASE s.verb WHEN 'u' THEN 'update' WHEN 'i' THEN 'insert' ELSE 'merge' END
    FROM statements s
   CROSS JOIN guarded g
   WHERE CASE s.verb
           WHEN 'u' THEN
                s.rest ~* ('\m' || g.column_name || '\s*=')
             -- SET (a, b) = (…), the row form
             OR s.rest ~* ('^\s*(?:(?:as\s+)?[a-z_][a-z0-9_]*\s+)?set\s*\([^)]*\m' || g.column_name || '\M')
           WHEN 'i' THEN
                s.rest ~* ('^\s*(?:as\s+[a-z_][a-z0-9_]*\s*)?\([^)]*\m' || g.column_name || '\M')
             -- ON CONFLICT … DO UPDATE SET
             OR s.rest ~* ('\m' || g.column_name || '\s*=')
             -- no column list: every column is written
             OR (s.rest !~* '^\s*(?:as\s+[a-z_][a-z0-9_]*\s*)?\('
                 AND s.rest !~* '^\s*default\s+values')
           ELSE
                s.rest ~* ('\m' || g.column_name || '\M')
         END
$$;

COMMENT ON FUNCTION app_private.subscription_column_writes() IS
  'Plan 3.F U3: every function in public and app_private whose body writes one '
  'of the five subscription columns of companies, by text. A tripwire for the '
  'self-check and the RLS kit; see 20260920120000 for what it cannot see.';

REVOKE ALL ON FUNCTION app_private.subscription_column_writes()
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION app_private.subscription_column_writes() OWNER TO CURRENT_USER;

-- ─── 3. Self-check ──────────────────────────────────────────────────────────

-- Tripwires, as U1's and U2's are. What the wall does, row by row and role by
-- role, is asserted in tests/rls/subscriptions.sql section 8.
DO $mig$
DECLARE
  c_guard CONSTANT text := 'app_private.refuse_direct_subscription_write()';
  c_scan  CONSTANT text := 'app_private.subscription_column_writes()';
  v_sig     text;
  v_role    text;
  v_n       bigint;
  v_missing text;
  v_extra   text;
  r         record;
BEGIN
  -- 1. both functions exist and pin their search_path, and no API role may call
  --    either of them
  FOREACH v_sig IN ARRAY ARRAY[c_guard, c_scan] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION '20260920120000 self-check: % is missing', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                    WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=%') THEN
      RAISE EXCEPTION '20260920120000 self-check: % has no pinned search_path', v_sig;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_function_privilege(v_role, v_sig::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION '20260920120000 self-check: % may call %', v_role, v_sig;
      END IF;
    END LOOP;
  END LOOP;

  -- 2. the trigger function is not SECURITY DEFINER. Inside one, current_user
  --    is the owner, never an API role, and the wall would let everyone through.
  IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(c_guard)) THEN
    RAISE EXCEPTION '20260920120000 self-check: % is SECURITY DEFINER, so current_user inside it is its owner and it refuses nobody', c_guard;
  END IF;

  -- 3. the trigger is on companies, enabled, and fires BEFORE INSERT and UPDATE
  --    for each row and every column
  SELECT count(*) INTO v_n
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.companies'::regclass
     AND t.tgname = 'refuse_direct_subscription_write'
     AND NOT t.tgisinternal
     AND t.tgfoid = to_regprocedure(c_guard)
     AND t.tgenabled IN ('O', 'A')
     AND t.tgtype & 1 = 1            -- FOR EACH ROW
     AND t.tgtype & 2 = 2            -- BEFORE
     AND t.tgtype & 4 = 4            -- INSERT
     AND t.tgtype & 16 = 16          -- UPDATE
     AND pg_get_triggerdef(t.oid) !~* '\mupdate\s+of\M';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '20260920120000 self-check: companies carries no enabled BEFORE INSERT OR UPDATE row trigger calling %', c_guard;
  END IF;

  -- 4. the writers of the five columns are exactly the sanctioned ones, in both
  --    directions: a new writer fails here, and so does a sanctioned one that
  --    stopped writing what it owns. A NULL routine is a signature that no
  --    longer resolves, and it counts as missing.
  WITH expected(fn, column_name, via) AS (
    VALUES
      (to_regprocedure('app_private.recompute_company_subscription(uuid)')::oid, 'plan',                    'update'),
      (to_regprocedure('app_private.recompute_company_subscription(uuid)')::oid, 'subscription_expires_at', 'update'),
      (to_regprocedure('app_private.recompute_company_subscription(uuid)')::oid, 'subscription_status',     'update'),
      (to_regprocedure('public.platform_company_set_plan(uuid,text,text,integer)')::oid, 'plan',            'update'),
      (to_regprocedure('public.redeem_activation_code(text)')::oid, 'subscription_duration_type',           'update'),
      (to_regprocedure('public.redeem_activation_code(text)')::oid, 'subscription_started_at',              'update'),
      (to_regprocedure('public.update_company_subscription_manual(uuid,text,timestamptz,timestamptz,text,text)')::oid,
                                                                    'subscription_duration_type',           'update'),
      (to_regprocedure('public.update_company_subscription_manual(uuid,text,timestamptz,timestamptz,text,text)')::oid,
                                                                    'subscription_started_at',              'update'),
      (to_regprocedure('app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)')::oid,
                                                                    'plan',                                 'insert'),
      (to_regprocedure('app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)')::oid,
                                                                    'subscription_status',                  'insert')
  ),
  found AS (
    SELECT w.routine::oid AS fn, w.column_name, w.via FROM app_private.subscription_column_writes() w
  )
  -- `ORDER BY line`, not `ORDER BY 1`: inside an aggregate a number is a
  -- constant to sort by, not a column position.
  SELECT (SELECT string_agg(e.line, '; ' ORDER BY e.line)
            FROM (SELECT format('%s writes %s (%s)', coalesce(d.fn::regprocedure::text, '<unresolved>'),
                                d.column_name, d.via) AS line
                    FROM (SELECT * FROM expected EXCEPT SELECT * FROM found) d) e),
         (SELECT string_agg(e.line, '; ' ORDER BY e.line)
            FROM (SELECT format('%s writes %s (%s)', d.fn::regprocedure::text, d.column_name, d.via) AS line
                    FROM (SELECT * FROM found EXCEPT SELECT * FROM expected) d) e)
    INTO v_missing, v_extra;

  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION '20260920120000 self-check: a function writes a subscription column of companies directly: %. Record a period through app_private.subscription_coverage_record instead, or, if this is a sanctioned writer, add it to this list and to tests/rls/subscriptions.sql section 8 in the same commit', v_extra;
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20260920120000 self-check: a sanctioned writer no longer writes what it owns: %', v_missing;
  END IF;

  FOR r IN SELECT w.routine::text AS fn, string_agg(w.column_name || ' (' || w.via || ')', ', ' ORDER BY w.column_name) AS cols
             FROM app_private.subscription_column_writes() w
            GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '20260920120000: % writes %', r.fn, r.cols;
  END LOOP;

  -- 5. every sanctioned writer is SECURITY DEFINER and owned by a role the wall
  --    lets through. It passes the wall *because* it runs as its owner; a
  --    restatement that dropped SECURITY DEFINER would turn a customer's
  --    redemption into a refusal at runtime, so it fails here instead.
  FOREACH v_sig IN ARRAY ARRAY[
      'app_private.recompute_company_subscription(uuid)',
      'public.platform_company_set_plan(uuid,text,text,integer)',
      'public.redeem_activation_code(text)',
      'public.update_company_subscription_manual(uuid,text,timestamptz,timestamptz,text,text)',
      'app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)']
  LOOP
    IF NOT EXISTS (SELECT 1
                     FROM pg_proc p
                     JOIN pg_roles o ON o.oid = p.proowner
                    WHERE p.oid = to_regprocedure(v_sig)
                      AND p.prosecdef
                      AND o.rolname::text <> ALL (ARRAY['anon', 'authenticated', 'service_role'])) THEN
      RAISE EXCEPTION '20260920120000 self-check: % is not a SECURITY DEFINER function owned outside the API roles, so the wall would refuse it', v_sig;
    END IF;
  END LOOP;

  RAISE NOTICE '20260920120000 self-check: passed';
END $mig$;
