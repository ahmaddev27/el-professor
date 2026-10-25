/*
  Per-company sidebar modules, slice 1 — the state and its one writer.
  Docs/design/per-company-modules.md, sections 2, 3 and 6.

  A platform operator turns one sidebar module off for one company. Two of the
  owner's decisions are the premises of this file and not options:

    Decision A — the toggle may only ever NARROW. The plan stays the commercial
      boundary: plan forbids + toggle on is still OFF. Nothing here reads the
      plan, which is exactly how that holds — the four gates compose as a plain
      AND, with no precedence to encode and no override to store.

    Decision B — "off" means off at the link, the route and the writes. This
      file is none of those three walls. It is only the state they will read:
      the link term is slice 1's browser half, the route is slice 2 and the
      write gate is slice 3 (one term in current_role_permits). Reads are NOT
      closed, by the design's recommendation and the owner's acceptance.

  THE ONE PROHIBITION, and it is what makes `on -> off -> on` the identity:
  nothing in this feature may ever delete, archive, anonymise or clean up
  tenant data when a module is switched off. The toggle writes one row here and
  nothing else; every wall is a predicate read at the point of use. Self-check 6
  carries that literally — the RPC may name no table but company_modules and
  companies — so a later "tidy up on disable" step fails the release rather
  than turning a commercial switch into a destructive one.

  Three shape decisions, each with the file that would fail if it were changed:

  1. ABSENCE OF A ROW MEANS THE MODULE IS ON. The table stores decisions to
     SUBTRACT, so no decision means no subtraction, and the gate reads
     `enabled IS NOT FALSE`. This is deliberately NOT plan_features' rule: a
     feature that map does not name reads as premium (fail-closed), and copying
     that here would put every existing customer in the dark on deploy day,
     because no company has a row. A row with enabled = true is kept on purpose
     — it is the record of "switched off and switched back on", and it is what
     lets an operator arm a module ahead of a plan upgrade.

  2. THE SELECT POLICY READS get_user_company_id(), THE ACCOUNT SHELL HELPER,
     not get_active_company_id(). A suspended or unsubscribed company must keep
     reading its own module rows, or the page that explains the suspension,
     /abo-aktivieren and /billing would render against an unreadable table.
     That is subscription_coverage's choice (20260919150000) and it is also why
     this table carries NO refuse_read_only_context_write trigger: section 14 of
     tests/rls/platform-contexts.sql requires that trigger on every table whose
     policies name get_active_company_id(), and a table on the shell helper must
     not carry it. Self-check 4 asserts its absence, and self-check 3 asserts
     which helper the policy reads, because swapping them is a one-word edit
     that would make the kit demand a trigger this table must not have.

  3. THERE IS NO INSERT, UPDATE OR DELETE POLICY AT ALL, and no write grant.
     A move between companies is refused for having no UPDATE policy rather than
     by a WITH CHECK clause a later migration could restate away. The only
     writer is the SECURITY DEFINER RPC below. This is the
     subscription_coverage / notification_deliveries shape.

  WHY NO NEW CAPABILITY. The RPC asks `companies.lifecycle`, owner and support
  since 20261015150000. It is already the capability that decides what a company
  may do at all (suspend, archive, restore), and switching off one module is a
  smaller act of exactly that kind on exactly that object. A `modules.manage`
  capability would take app_private.platform_capability_matrix() from 32 pairs
  to 36, and 20261015150000's self-checks 1 and 3 fail on any count change or
  cell movement, so tests/rls/platform-authority.sql would have to be re-derived
  as well — a slice of its own for behaviour nobody has asked for. If modules
  are ever sold a la carte, that is one matrix cell and its own decision.

  WHY ONE MODULE PER CALL and not a wholesale set_modules(company, jsonb):
  company_role_save replaces a role's permission rows wholesale from a payload
  built out of PAGE_DEFINITIONS, and the documented consequence is that a stored
  page_key this build does not know is dropped the first time anyone edits that
  role, with a success toast. A wholesale module save has the identical failure
  — an older build, or a rolled-back release, would silently delete the rows for
  modules it does not know and so re-enable them. One module per call makes each
  audit row one decision and cannot drop what it did not send.

  LOCKED MODULES ARE REFUSED BY THE DATABASE, not only by the screen
  (app_private.company_module_locked_keys(), reason `module_locked`). Two of the
  six are deadlocks rather than policy preferences, both verified in App.tsx on
  this branch:

    /billing   SUBSCRIPTION_ALLOWED_PATHS = ['/abo-aktivieren', '/aktivierung',
               '/billing'] (App.tsx:141) FORCES a company whose subscription is
               inactive onto exactly those paths. Close /billing and the forced
               destination is itself closed: the company cannot pay, so it can
               never leave the state. Unrecoverable from the customer's side.
    /overview  `path="*" -> Navigate to="/overview"` (App.tsx:696) is where every
               unknown or closed path lands, and `overview` is the one feature
               planAllows() exempts from the inactive-subscription check. Close
               it and every fallback redirect points at a closed page.

  The other four — /users, /roles, /settings, /datensicherung — are the
  company's own levers over access, its statutory master data (the Bundesland
  selects the holiday table the premium computation depends on) and its way to
  get its own data out. A warning does not fix a deadlock, which is why the
  refusal is here and not in the panel.

  Note what the six have in common and that it is not a coincidence: four of
  them carry `feature: 'overview'` in Sidebar.tsx, which is that file's spelling
  for "on every plan" rather than a feature at all. The product has already
  decided, with the reason written at the call site, that these are not things to
  be sold; the module toggle must not be what reverses that by accident.
*/

-- ─── 1. public.company_modules ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.company_modules (
  company_id uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The registry key of one sidebar entry. MODULE_DEFINITIONS in
  -- src/lib/companyModules.ts, mirrored by company_module_keys() below; the
  -- pattern allows no hyphen, so a path like /company-planner is the key
  -- `company_planner`.
  module_key text        NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{0,59}$'),
  -- false subtracts the module. true is a deliberate record of "switched off and
  -- switched back on", kept for the trail and so a module can be armed ahead of
  -- a plan upgrade. No row at all means on.
  enabled    boolean     NOT NULL,
  -- Why, for the next operator. Bounded, because the audit row carries it.
  note       text        NULL CHECK (note IS NULL OR length(note) <= 500),
  -- The operator. NULL for a row written with no session — a migration, psql,
  -- a host script — which the panel reports rather than guessing at.
  set_by     uuid        NULL,
  set_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, module_key)
);

COMMENT ON TABLE public.company_modules IS
  'One row per module a platform operator has decided about for one company. '
  'ABSENCE MEANS ON: the table stores decisions to subtract, so the gates read '
  'enabled IS NOT FALSE. Written only by public.platform_company_set_module '
  '(20261025120000).';

ALTER TABLE public.company_modules ENABLE ROW LEVEL SECURITY;

/*
  The account shell's predicate, get_user_company_id(), for the reason in point 2
  of the header. The platform branch is companies.read — the capability that
  already reads the companies table itself, which is how the panel's company
  list is reached at all.

  Writing is nobody's: `authenticated` holds SELECT and nothing else, and there
  is no INSERT, UPDATE or DELETE policy for a write to be measured against.
*/
DROP POLICY IF EXISTS company_modules_select ON public.company_modules;
CREATE POLICY company_modules_select ON public.company_modules
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_user_company_id())
         OR (SELECT public.platform_can('companies.read')));

COMMENT ON POLICY company_modules_select ON public.company_modules IS
  'A company reads its own module rows in whatever state it is in (the account '
  'shell helper, not get_active_company_id(): a suspended company has to render '
  'the page explaining the suspension), and platform staff holding '
  'companies.read read every company''s.';

REVOKE ALL ON TABLE public.company_modules FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.company_modules TO authenticated;

-- ─── 2. The database's copy of the registry ─────────────────────────────────

/*
  The module keys the product has — one per sidebar entry of NAV_ITEMS and
  ADMIN_ITEMS in src/components/Sidebar.tsx. role_page_keys()'s idiom, so a key
  the product does not have cannot be stored; src/lib/companyModules.test.ts
  reads the newest migration defining this list and fails when it and
  MODULE_DEFINITIONS differ.

  In app_private and not in public, unlike role_page_keys(): the only caller is
  the SECURITY DEFINER RPC below, which runs as its owner, so no API role needs
  USAGE or EXECUTE. The pinned SET clause is the house rule for an app_private
  function and it also keeps this out of the plan cache's masked class — an
  inlinable `sql` function with no SET clause is folded away by the planner and
  its EXECUTE check can be warmed by another role (CLAUDE.md, F2 against F3).
*/
CREATE OR REPLACE FUNCTION app_private.company_module_keys()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT ARRAY[
    -- NAV_ITEMS
    'overview', 'belege', 'fahrer', 'cars', 'umsaetze', 'fixkosten',
    'bargeldbestand', 'werkstatt', 'abrechnung', 'notes', 'benachrichtigungen',
    'salaries', 'dokumente', 'fahrtenbuch', 'company_planner', 'monatsplan',
    -- ADMIN_ITEMS
    'users', 'roles', 'datenimport', 'datensicherung', 'billing', 'settings'
  ]::text[];
$$;

COMMENT ON FUNCTION app_private.company_module_keys() IS
  'The module_keys company_modules may name — MODULE_DEFINITIONS in '
  'src/lib/companyModules.ts. Pinned against it by src/lib/companyModules.test.ts.';

/*
  The six that may never be switched off. Docs/design/per-company-modules.md
  section 6; the header above gives each one's reason and names the two
  deadlocks' call sites.

  The refusal has to live here and not only in the panel: a deadlock the screen
  could create by accident must be impossible, and a hand-written INSERT is not
  possible at all (no write policy), so this list plus the RPC's check IS the
  wall.
*/
CREATE OR REPLACE FUNCTION app_private.company_module_locked_keys()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT ARRAY[
    'overview',        -- deadlock: the target of every fallback redirect
    'billing',         -- deadlock: the company could not pay, so could not recover
    'users',           -- a company could not revoke a departing employee's access
    'roles',           -- a company could not narrow its own staff's rights
    'settings',        -- Bundesland, legal name: statutory master data
    'datensicherung'   -- the customer's way to get their own data out
  ]::text[];
$$;

COMMENT ON FUNCTION app_private.company_module_locked_keys() IS
  'The modules platform_company_set_module refuses with reason module_locked. '
  'Two are deadlocks (overview, billing); the other four are the company''s own '
  'levers over access, its statutory master data and its export.';

REVOKE ALL ON FUNCTION app_private.company_module_keys()        FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.company_module_locked_keys() FROM PUBLIC, anon, authenticated, service_role;

-- ─── 3. The one writer ──────────────────────────────────────────────────────

/*
  Switch one module on or off for one company. platform_company_set_plan's
  order, step for step:

    1. platform_rpc_authorize(capability, …) -> platform_rpc_response('denied'),
       which writes its own denied row, capped per actor.
    2. the argument contract -> 'invalid'
    3. the locked list       -> 'module_locked'
    4. the company, FOR NO KEY UPDATE -> 'not_found'
    5. INSERT … ON CONFLICT DO UPDATE
    6. platform_rpc_finish with the values before and after

  Every outcome is a RETURN VALUE and never an exception, so the audit row that
  records a refusal survives the transaction.

  The company lock is what makes the read of the old row, the write of the new
  one and the audit row a single decision. There is deliberately no
  expected_version: the row is one boolean for one module of one company, two
  operators cannot meaningfully conflict on it, the last writer's intent is the
  one to keep, and the log keeps both decisions.

  `module_locked`'s German sentence is built here rather than by restating
  app_private.platform_rpc_response, which is 20261016140000's idiom for exactly
  this (`invalid_status`, `name_mismatch`): a shared helper is not restated for
  one sentence, and its audit row still goes through platform_rpc_record.
*/
CREATE OR REPLACE FUNCTION public.platform_company_set_module(
  p_company_id uuid,
  p_module_key text,
  p_enabled    boolean,
  p_note       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action   CONSTANT text    := 'company.set_module';
  c_note_max CONSTANT integer := 500;
  v_target   text := coalesce(p_company_id::text, '-') || ':' || coalesce(p_module_key, '-');
  v_note     text := nullif(btrim(p_note), '');
  v_before   public.company_modules%ROWTYPE;
  v_after    public.company_modules%ROWTYPE;
  v_existed  boolean;
BEGIN
  IF NOT app_private.platform_rpc_authorize('companies.lifecycle', 'write', c_action,
                                            p_company_id, 'company_module', v_target) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  -- A key the product does not have cannot be stored: the browser reads a row
  -- it does not know as nothing, so such a row would be invisible state.
  IF p_company_id IS NULL
     OR p_module_key IS NULL
     OR p_enabled IS NULL
     OR NOT (p_module_key = ANY (app_private.company_module_keys()))
     OR coalesce(length(v_note), 0) > c_note_max
  THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid', p_company_id,
      'company_module', v_target, NULL,
      jsonb_build_object('module_key', p_module_key, 'enabled', p_enabled));
  END IF;

  IF p_module_key = ANY (app_private.company_module_locked_keys()) THEN
    PERFORM app_private.platform_rpc_record('write', c_action, 'module_locked', p_company_id,
      'company_module', v_target, NULL,
      jsonb_build_object('module_key', p_module_key, 'enabled', p_enabled));
    RETURN app_private.platform_rpc_response('module_locked')
           || jsonb_build_object('error',
                'Dieses Modul kann nicht abgeschaltet werden. Ohne es könnte das '
                'Unternehmen sein eigenes Konto nicht mehr erreichen.');
  END IF;

  -- NO KEY UPDATE, never FOR UPDATE: rows referencing the company stay
  -- insertable while this runs, and two writers cannot deadlock on the key
  -- share their own foreign keys hold.
  PERFORM 1 FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL,
      'company_module', v_target, NULL, NULL);
  END IF;

  SELECT * INTO v_before
    FROM public.company_modules
   WHERE company_id = p_company_id AND module_key = p_module_key;
  v_existed := FOUND;

  INSERT INTO public.company_modules (company_id, module_key, enabled, note, set_by, set_at)
  VALUES (p_company_id, p_module_key, p_enabled, v_note, auth.uid(), now())
      ON CONFLICT (company_id, module_key) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             note    = EXCLUDED.note,
             set_by  = EXCLUDED.set_by,
             set_at  = EXCLUDED.set_at
  RETURNING * INTO v_after;

  -- before_value is NULL where no row existed, so the log says "there was no
  -- decision" rather than inventing a default that the gate reads as on anyway.
  RETURN app_private.platform_rpc_finish('write', c_action, NULL, p_company_id,
    'company_module', v_target,
    CASE WHEN v_existed THEN jsonb_build_object('module_key', v_before.module_key,
                                                'enabled',    v_before.enabled,
                                                'note',       v_before.note) END,
    jsonb_build_object('module_key', v_after.module_key,
                       'enabled',    v_after.enabled,
                       'note',       v_after.note));
END;
$$;

COMMENT ON FUNCTION public.platform_company_set_module(uuid, text, boolean, text) IS
  'Switches one sidebar module on or off for one company, on '
  'companies.lifecycle, with one audit row per call. Refuses a locked module '
  'with reason module_locked. Writes company_modules and reads companies; it '
  'touches no tenant data, which is what makes on -> off -> on the identity.';

-- Each of these reaches app_private, so the owner must be the role that holds
-- USAGE there. CREATE OR REPLACE keeps an existing owner, which on staging and
-- production may be postgres (20260916110010).
ALTER FUNCTION app_private.company_module_keys()                              OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.company_module_locked_keys()                       OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_company_set_module(uuid, text, boolean, text)  OWNER TO CURRENT_USER;

-- The panel calls it signed in, and nothing else does: no anon, and no service
-- role, which has no auth.uid() to be an actor.
REVOKE ALL ON FUNCTION public.platform_company_set_module(uuid, text, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_company_set_module(uuid, text, boolean, text)
  TO authenticated;

-- ─── 4. Self-check ──────────────────────────────────────────────────────────

/*
  Fails the release. Each check is the rule rather than the instance, and the
  one that matters most is 6: the prohibition of section 5 of the design, read
  out of the catalogue instead of trusted to a reviewer.
*/
DO $$
DECLARE
  c_rpc    CONSTANT text := 'public.platform_company_set_module(uuid,text,boolean,text)';
  v_txt    text;
  v_n      int;
  v_role   text;
  v_key    text;
  r        record;
BEGIN
  -- 1. SELECT is the only policy, and the only privilege a client role holds.
  SELECT count(*) INTO v_n
    FROM pg_policy p
   WHERE p.polrelid = 'public.company_modules'::regclass AND p.polcmd <> 'r';
  IF v_n > 0 THEN
    RAISE EXCEPTION '20261025120000 self-check 1: company_modules has % policy(ies) other than SELECT — its only writer must be the RPC', v_n;
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_policy p
   WHERE p.polrelid = 'public.company_modules'::regclass AND p.polcmd = 'r';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '20261025120000 self-check 1: company_modules has % SELECT policies, expected exactly 1', v_n;
  END IF;

  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.company_modules'::regclass) THEN
    RAISE EXCEPTION '20261025120000 self-check 1: row level security is off on company_modules';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_table_privilege(v_role, 'public.company_modules', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
      RAISE EXCEPTION '20261025120000 self-check 2: % holds a write privilege on company_modules', v_role;
    END IF;
  END LOOP;

  -- 2. anon reads nothing and calls nothing; the service role, which has no
  --    auth.uid() to be an actor, calls nothing either.
  IF has_table_privilege('anon', 'public.company_modules', 'SELECT') THEN
    RAISE EXCEPTION '20261025120000 self-check 2: anon holds SELECT on company_modules';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.company_modules', 'SELECT') THEN
    RAISE EXCEPTION '20261025120000 self-check 2: authenticated cannot read company_modules — every screen would see no modules';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_function_privilege(v_role, c_rpc, 'EXECUTE') THEN
      RAISE EXCEPTION '20261025120000 self-check 2: % holds EXECUTE on platform_company_set_module', v_role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', c_rpc, 'EXECUTE') THEN
    RAISE EXCEPTION '20261025120000 self-check 2: authenticated holds no EXECUTE on platform_company_set_module — the panel could not call it';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, 'app_private.company_module_keys()', 'EXECUTE')
       OR has_function_privilege(v_role, 'app_private.company_module_locked_keys()', 'EXECUTE') THEN
      RAISE EXCEPTION '20261025120000 self-check 2: % holds EXECUTE on an app_private module helper', v_role;
    END IF;
  END LOOP;

  -- 3. The policy reads the account shell helper and not the active one.
  --    Swapping them is a one-word edit that would make section 14 of
  --    tests/rls/platform-contexts.sql demand a trigger this table must not
  --    have, and would hide a suspended company's own rows from it.
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO v_txt
    FROM pg_policy p
   WHERE p.polrelid = 'public.company_modules'::regclass AND p.polcmd = 'r';
  IF v_txt IS NULL OR v_txt !~ 'get_user_company_id' THEN
    RAISE EXCEPTION '20261025120000 self-check 3: company_modules_select does not read get_user_company_id()';
  END IF;
  IF v_txt ~ 'get_active_company_id' THEN
    RAISE EXCEPTION '20261025120000 self-check 3: company_modules_select reads get_active_company_id() — the account shell helper is the choice here, see the header';
  END IF;
  IF v_txt !~ 'companies\.read' THEN
    RAISE EXCEPTION '20261025120000 self-check 3: company_modules_select has lost its companies.read branch — the panel could not read a customer''s modules';
  END IF;

  -- 4. No support-session trigger. The pair of 20260917140000 / 20260920110000
  --    belongs on a table whose policies name get_active_company_id(); on a
  --    shell table it would refuse the RPC's own writes.
  SELECT count(*) INTO v_n
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.company_modules'::regclass
     AND NOT t.tgisinternal;
  IF v_n > 0 THEN
    RAISE EXCEPTION '20261025120000 self-check 4: company_modules carries % trigger(s); it must carry none — in particular not refuse_read_only_context_write, which the RLS kit requires only on tables reading get_active_company_id()', v_n;
  END IF;

  -- 5. The RPC's shape: SECURITY DEFINER with a pinned search_path, VOLATILE so
  --    PostgREST calls it with POST (a GET would run in a read-only transaction
  --    where the audit row could not be written).
  SELECT count(*) INTO v_n
    FROM pg_proc p
   WHERE p.oid = to_regprocedure(c_rpc)
     AND p.prosecdef
     AND p.provolatile = 'v'
     AND p.proconfig @> ARRAY['search_path=pg_catalog, public'];
  IF v_n <> 1 THEN
    RAISE EXCEPTION '20261025120000 self-check 5: platform_company_set_module is not SECURITY DEFINER VOLATILE with a pinned search_path';
  END IF;

  -- 6. THE PROHIBITION. The RPC may name no table but company_modules and
  --    companies. Catalogue-driven and word-bounded, so a column or a variable
  --    whose name contains a table name is not a false positive, and a table
  --    added later is covered without this list being maintained.
  v_txt := app_private.function_code(c_rpc);
  FOR r IN
    SELECT c.relname
      FROM pg_class c
     WHERE c.relnamespace IN ('public'::regnamespace, 'app_private'::regnamespace)
       AND c.relkind IN ('r', 'p', 'v', 'm')
       AND c.relname NOT IN ('company_modules', 'companies')
     ORDER BY 1
  LOOP
    IF v_txt ~ ('\m' || r.relname || '\M') THEN
      RAISE EXCEPTION '20261025120000 self-check 6: platform_company_set_module names the table %. It may name only company_modules and companies: switching a module off must never touch tenant data, or on -> off -> on stops being the identity (Docs/design/per-company-modules.md section 5)', r.relname;
    END IF;
  END LOOP;

  -- …and it writes no tenant data in the other direction either: no DELETE and
  -- no TRUNCATE anywhere in the body, whatever it names.
  IF v_txt ~* '\mdelete\M' OR v_txt ~* '\mtruncate\M' THEN
    RAISE EXCEPTION '20261025120000 self-check 6: platform_company_set_module contains a DELETE or TRUNCATE — nothing in this feature may remove a row';
  END IF;

  -- 7. The capability is the existing one. A new capability would move
  --    platform_capability_matrix()'s counts and fail 20261015150000.
  IF v_txt !~ 'companies\.lifecycle' THEN
    RAISE EXCEPTION '20261025120000 self-check 7: platform_company_set_module no longer asks companies.lifecycle';
  END IF;
  IF NOT (app_private.platform_role_can('owner', 'companies.lifecycle')
          AND app_private.platform_role_can('support', 'companies.lifecycle')) THEN
    RAISE EXCEPTION '20261025120000 self-check 7: owner and support must hold companies.lifecycle for the module toggle to be reachable';
  END IF;
  IF app_private.platform_role_can('billing', 'companies.lifecycle')
     OR app_private.platform_role_can('read_only', 'companies.lifecycle') THEN
    RAISE EXCEPTION '20261025120000 self-check 7: billing or read_only now holds companies.lifecycle — decision D2 moved and the module toggle moved with it';
  END IF;

  -- 8. The registry: 22 keys, no repeat, and the six locked ones are all real
  --    modules. A locked key that is not a module would be a wall around
  --    nothing; a missing one would be a deadlock the panel could create.
  SELECT cardinality(app_private.company_module_keys()) INTO v_n;
  IF v_n <> 22 THEN
    RAISE EXCEPTION '20261025120000 self-check 8: company_module_keys() holds % keys, expected 22 (one per sidebar entry)', v_n;
  END IF;
  SELECT count(DISTINCT k) INTO v_n FROM unnest(app_private.company_module_keys()) AS k;
  IF v_n <> 22 THEN
    RAISE EXCEPTION '20261025120000 self-check 8: company_module_keys() repeats a key';
  END IF;

  SELECT cardinality(app_private.company_module_locked_keys()) INTO v_n;
  IF v_n <> 6 THEN
    RAISE EXCEPTION '20261025120000 self-check 8: company_module_locked_keys() holds % keys, expected the 6 of the design''s section 6', v_n;
  END IF;
  FOREACH v_key IN ARRAY ARRAY['overview', 'billing', 'users', 'roles', 'settings', 'datensicherung'] LOOP
    IF NOT (v_key = ANY (app_private.company_module_locked_keys())) THEN
      RAISE EXCEPTION '20261025120000 self-check 8: % is missing from company_module_locked_keys(); the two deadlocks (overview, billing) and the four company levers must all be there', v_key;
    END IF;
    IF NOT (v_key = ANY (app_private.company_module_keys())) THEN
      RAISE EXCEPTION '20261025120000 self-check 8: locked key % is not a module key — a wall around nothing', v_key;
    END IF;
  END LOOP;

  -- 9. The key pattern allows no hyphen, so a sidebar path cannot be used as a
  --    key unchanged. Every listed key must satisfy the column's own CHECK, or
  --    a valid registry entry would be unstorable.
  FOREACH v_key IN ARRAY app_private.company_module_keys() LOOP
    IF v_key !~ '^[a-z][a-z0-9_]{0,59}$' THEN
      RAISE EXCEPTION '20261025120000 self-check 9: module key % does not satisfy company_modules.module_key''s CHECK', v_key;
    END IF;
  END LOOP;

  RAISE NOTICE '20261025120000 self-check: company_modules, its two helpers and platform_company_set_module are as designed';
END $$;
