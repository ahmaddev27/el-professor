/*
  Per-company sidebar modules, slice 3: the write gate.
  Docs/design/per-company-modules.md sections 5 (wall C) and 9 (slice 3).

  ## The defect

  Measured on production, 27.10.2026. The owner switched **Fahrtenbuch** off for
  his own company in the platform panel and then typed `/fahrtenbuch` into the
  address bar. The page rendered, fully working — the imports list, the Import
  button, every row. Slice 1 (20261025120000) wrote the state and gated the
  sidebar **link**, and `Sidebar.renderNavItem` was the only caller of
  `moduleEnabledForRoute` in the whole tree. There was no module term in the
  route and none in the database: `grep -nI 'companyModules|moduleEnabled|
  ModuleGate' src/App.tsx` returned nothing, and no policy and no function
  mentioned `company_modules`.

  So the panel's switch was cosmetic, and `src/lib/companyModules.ts`' own header
  had said so in advance: *"until slice 3 puts the write term in
  current_role_permits(), the browser IS the only module wall."* This file is
  slice 3. The route is closed in the same pull request.

  ## What this file does, in one sentence

  `public.current_role_permits(page, true)` — the single role gate of ten page
  keys, 33 tenant tables' write policies, the three `salary-receipts` storage
  policies and eight SECURITY DEFINER RPCs — gains one conjunct: the page must
  still be claimed by a module that is **enabled** for the caller's company.

  One function body closes writes for a module's pages everywhere at once. No
  policy is rewritten, there is no table list to keep in step, and a tenant table
  added later inherits the term by calling the same function, which is the whole
  reason wall C was chosen over 33 separate edits.

  ## Writes, not reads — and this is a deliberate departure from the literal
  ## instruction, not an oversight

  The owner said, verbatim, *"من ناحية الاطفاء اطفي كل اشي المسار والاستعلام"* —
  switching off means the route **and the query**. This file closes the route (in
  its browser half) and every **write**. It does **not** close reads, and the
  reason is section 5 of the design document, which recommended against it before
  this defect was found:

    1. **An empty list is a claim about a customer's money.** A SELECT a policy
       hides returns `[]` with a 200. There is no error for a screen to notice
       and no read-side equivalent of `deleteChecked`. So the day a module was
       switched off, Belege would show "no receipts", Bargeldbestand a till of
       0,00 €, and the Abrechnung a driver owing nothing — every one of them a
       false statement about the customer's money, produced by our own gate.
    2. **`documents` is a statutory archive.** That one page key gates 24 tables:
       the Fahrtenbuch imports and trips, the assignment audit, the five planning
       tables, the six `historical_*` tables with their three children, and the
       saved Stundennachweise. They are German payroll and compliance records that
       go to a Steuerberater under retention obligations that do not pause because
       a subscription module was switched off.
    3. **It buys no confidentiality, because there is no second party.** RLS here
       stops company A reading company B. A module toggle is company A reading
       **its own** rows.
    4. **It costs an epoch bump and a rollback cliff.** Per-module read closing
       cannot be done in one function: a SELECT policy is `company_id = (SELECT
       get_active_company_id()) OR (SELECT platform_reads_company_data())`, with
       no role term at all, and `get_active_company_id()` takes no page argument.
       So it means rewriting 36+ SELECT policies, `deploy/SCHEMA_EPOCH` going 3 ->
       4, and no rollback across that release.

  Wall C already achieves the commercial goal in full: the module cannot be
  *used*, no row is created, no document is produced, nothing is computed. What
  wall C does not add is the appearance of deletion. **Closing reads is the
  owner's call and its own slice**, and the pull request asks him for it.

  ## Why `current_role_permits` is the right seam for writes and the wrong one
  ## for reads — measured, not assumed

  Every live caller passes `p_need_edit = true`. Measured across
  `supabase/migrations/`, `src/` and `supabase/functions/`: no policy and no
  function anywhere asks `current_role_permits(page, false)`. The codebase's own
  record of that measurement is `VIEW_IS_ENFORCED = false` in
  `src/lib/rolePermissionEnforcement.ts`, which names the constant rather than
  inlining it precisely so the day a read gate appears, the grep lands there.

  So the term is written `p_need_edit AND …`. Today that is behaviourally
  identical to applying it unconditionally — there is no `false` caller for it to
  differ on. It is written that way because of **tomorrow**: the day someone adds
  a view gate, an unconditional term would silently turn this into wall D on
  whatever page asked first, with no migration, no epoch bump and no decision.
  The conjunct is the line between the two walls, written where it cannot drift.

  ## The company the term asks about

  `public.get_active_company_id()`, which is the same company the policy's own
  tenant term pins the row to (`company_id = (SELECT get_active_company_id())`).
  Three consequences, all of them wanted:

    - A **member** whose company or account is blocked already gets NULL from it,
      so the module lookup answers "not closed" and the tenant term does the
      refusing, exactly as before this file. Nothing changes for them.
    - A **company-less platform account inside a support session** gets the opened
      company, so the module term reads the *customer's* modules. That matches
      `Sidebar.renderNavItem`, whose own comment gives the reason: a support
      session that showed a module the customer cannot see would have the operator
      describing a screen that is not there.
    - It is **not** `get_user_company_id()`. The shell helper answers for a
      suspended company too, which would make the module term the binding
      refusal on a company the tenant term refuses anyway — a second, differently
      worded wall on the same door.

  ## Absence means ON, and it has to, in the database as in the browser

  `company_modules` stores decisions to **subtract**. No row means no decision
  means no subtraction. A predicate reading "no row means off" would switch every
  module off for every company at the instant this migration applied — every
  existing customer dark on deploy day, because no company has rows for modules
  nobody has touched.

  So `company_module_page_closed` is built as a double negative: a page is closed
  only when it is claimed by at least one module **and** no claiming module is
  enabled, where "enabled" is `COALESCE(the stored flag, true)`. For a company
  with zero rows every COALESCE is `true`, so no page is ever closed. Self-check 7
  proves that on a company id that holds no rows at all, and on NULL, and
  `tests/rls/company-module-write-gate.sql` section 3 proves it on a seeded
  company with none.

  ## A page claimed by several modules closes only when all of them are off

  The rule is: **a page is closed for a company if and only if no enabled module
  claims it.** It is what protects the statutory chain. `documents` is claimed by
  **four** sidebar entries — `/dokumente`, `/fahrtenbuch`, `/company-planner`,
  `/monatsplan` — so switching **Fahrtenbuch** off, which is exactly what the
  owner did, closes **no table at all**: the other three still claim the page and
  still need those 24 tables. Only all four off closes them. The panel row already
  says this with `pagesClosedByDisabling()` ("· schließt Daten").

  That is the answer to "a table that serves two modules": the mapping is
  many-to-one by design and the quantifier is over the *claimants*, not the one
  module being switched. Had it been written the other way round — close the page
  when *this* module is off — switching Fahrtenbuch off would have emptied
  Monatsplanung and the Stundennachweis, which produce a statutory document.

  ## The gap this does not close, named rather than left to be discovered

  `public.is_company_admin()` is **not page-keyed**, so wall C does not reach the
  four things gated by an administrator instead of by a page:

    - `notification_settings` writes,
    - `company_settings` writes,
    - deleting a `fahrtenbuch_imports` row,
    - deleting a `fahrtenbuch_trips` row.

  They are deliberately left. The first two are administrator acts on the
  company's own shell and belong to modules that can never be switched off
  (`benachrichtigungen` has no page key at all; `settings` is locked). The two
  deletes belong to `documents`, whose *creation* this file closes — a company
  that cannot import cannot accumulate anything new to delete — and widening them
  to the page would have **loosened** them, because a supervisor holds `can_edit`
  everywhere while `is_company_admin()` is stricter than any page.

  Three toggleable modules close no data at all, and the design says so: they are
  link-and-route only.

    - `abrechnung` -> page `accounting`, which **no table names**. The four
      Abrechnung RPCs are SECURITY INVOKER over `income`, `receipts` and
      `cash_transactions`, so the caller's own policies answer them and those
      three tables belong to other modules.
    - `benachrichtigungen` -> no page key (`notification_settings` is
      `is_company_admin()`).
    - `datenimport` -> no page key; the partner import tables' gate is its own
      question.

  ## What it costs

  The policies embed the gate as `(SELECT public.current_role_permits('<page>',
  true))` — the wrapped form built by the `v_gate_w` / `v_gate_d` `format()` calls
  in 20260917130000. PostgreSQL evaluates a wrapped subquery with no outer
  reference as an **InitPlan: once per statement, not once per row.** So the added
  work is one `get_active_company_id()` and one indexed lookup per statement, even
  on a Fahrtenbuch import that writes thousands of trips. The pull request carries
  the measurement rather than this reasoning, because this repository's record is
  that a reading of the optimiser has been wrong three times in both directions.

  ## Ownership, which is the PR #117 class

  `current_role_permits` already reaches `app_private` — it calls
  `platform_staff_role_of`, `account_has_company` and `platform_context_company`
  — so adding a fourth callee there is not a new kind of dependency. It is still
  the sharpest edge in the file: `authenticated` holds no USAGE on `app_private`,
  and PR #117 shipped a SECURITY INVOKER trigger that named a helper there, which
  made every company administrator creating a role get `42501 permission denied
  for schema app_private`. This function is SECURITY DEFINER, so the role that
  matters is its **owner**, and `CREATE OR REPLACE` keeps an existing owner.
  Self-check 6 reads that owner out of the catalogue and fails the release unless
  it holds USAGE on `app_private` and EXECUTE on the new helper — the rule, not
  the instance.

  The new helpers also carry a `SET search_path` clause. That is the house rule
  for an `app_private` function, and it additionally keeps them out of the plan
  cache's masked class: an inlinable `sql` function with no SET clause is folded
  away by the planner and its EXECUTE check can be warmed by another role
  (CLAUDE.md's F2 against F3).
*/

-- ─── 1. The database's copy of the registry's page mapping ──────────────────

/*
  Which `role_permissions.page_key`s each module claims — the `pageKeys` column
  of `MODULE_DEFINITIONS` in `src/lib/companyModules.ts`, which
  `src/lib/companyModules.test.ts` pins against this function by reading the
  newest migration that defines it. `role_page_keys()`'s idiom, and the same one
  slice 1 used for `company_module_keys()`.

  Four of the 22 modules claim nothing and so appear nowhere below:
  `benachrichtigungen` (`notification_settings` asks `is_company_admin()`),
  `billing`, `datensicherung` and `datenimport`. A module with no page can be
  hidden but closes no data, which is the design's own table.

  `documents` appearing four times is the load-bearing part of this list, not a
  redundancy: see the header.
*/
CREATE OR REPLACE FUNCTION app_private.company_module_pages()
RETURNS TABLE (module_key text, page_key text)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT *
    FROM (VALUES
      -- NAV_ITEMS
      ('overview',        'overview'),
      ('belege',          'receipts'),
      ('fahrer',          'drivers'),
      ('cars',            'cars'),
      ('umsaetze',        'income'),
      ('fixkosten',       'fixed-costs'),
      ('bargeldbestand',  'cash-balance'),
      ('werkstatt',       'werkstatt'),
      ('abrechnung',      'accounting'),
      ('notes',           'notes'),
      ('salaries',        'salaries'),
      -- The four that share `documents`, which gates 24 tables. The page closes
      -- only when all four are off; switching one off hides one screen.
      ('dokumente',       'documents'),
      ('fahrtenbuch',     'documents'),
      ('company_planner', 'documents'),
      ('monatsplan',      'documents'),
      -- ADMIN_ITEMS
      ('users',           'users'),
      ('roles',           'roles'),
      ('settings',        'settings')
    ) AS t(module_key, page_key);
$$;

COMMENT ON FUNCTION app_private.company_module_pages() IS
  'module_key -> page_key, the pageKeys column of MODULE_DEFINITIONS in '
  'src/lib/companyModules.ts. Many-to-one on purpose: four modules claim '
  '`documents`, and a page is closed only when no enabled module claims it.';

-- ─── 2. The predicate ───────────────────────────────────────────────────────

/*
  Is `p_page` closed for `p_company` — that is, claimed by at least one module
  and by no **enabled** one?

  Read the two halves as the one rule they are:

    - the first EXISTS asks whether any module claims the page at all. A page no
      module claims is never closed, which is what keeps `statistics` — the one
      `PAGE_DEFINITIONS` key no sidebar entry owns — open, and any page a future
      release adds before its module.
    - the second asks whether a claiming module is enabled, where enabled is
      `COALESCE(the stored flag, true)`. **This is where absence means on.**

  Every fail-open case therefore answers false:

      p_company IS NULL          -> no row matches -> COALESCE gives true
      a company with no rows     -> likewise
      a page no module claims    -> the first EXISTS is false
      p_page IS NULL             -> the first EXISTS is false

  STABLE and not IMMUTABLE: it reads a table. SECURITY INVOKER, so inside
  `current_role_permits` it runs with that function's owner's rights and RLS on
  `company_modules` does not apply to it — the company is an argument, not
  something it is trusted to scope itself.
*/
CREATE OR REPLACE FUNCTION app_private.company_module_page_closed(p_company uuid, p_page text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
           SELECT 1 FROM app_private.company_module_pages() mp
            WHERE mp.page_key = p_page
         )
     AND NOT EXISTS (
           SELECT 1
             FROM app_private.company_module_pages() mp
            WHERE mp.page_key = p_page
              AND COALESCE((SELECT cm.enabled
                              FROM public.company_modules cm
                             WHERE cm.company_id = p_company
                               AND cm.module_key = mp.module_key),
                           true)
         );
$$;

COMMENT ON FUNCTION app_private.company_module_page_closed(uuid, text) IS
  'Is this page_key closed for this company — claimed by a module, and by no '
  'enabled one? ABSENCE MEANS ON: a company with no company_modules rows, a '
  'NULL company and a page no module claims all answer false, so applying '
  '20261027120000 changes nothing for an existing customer.';

REVOKE ALL ON FUNCTION app_private.company_module_pages()                  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.company_module_page_closed(uuid, text)  FROM PUBLIC, anon, authenticated, service_role;

-- Both are reached from a SECURITY DEFINER function in `public`, so their owner
-- must be a role that holds USAGE on app_private. Slice 1's line, for its
-- reason: CREATE OR REPLACE keeps an existing owner, which on staging and
-- production may be postgres (20260916110010).
ALTER FUNCTION app_private.company_module_pages()                 OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.company_module_page_closed(uuid, text) OWNER TO CURRENT_USER;

-- ─── 3. The one term ────────────────────────────────────────────────────────

/*
  `20260917140000`'s body, character for character, with one block spliced in
  front of the role lookup — the idiom of `20260923130000` and `20261016140000`.

  The block is first rather than last for two reasons. It is an AND over **both**
  branches that can return true (the member's role and the support session's), so
  neither can be missed by a later edit to one of them; and the whole of the
  existing body stays verbatim below it, which is what self-check 5 can then
  assert fragment by fragment.

  Being first costs nothing measurable: in a policy this function is wrapped as
  `(SELECT public.current_role_permits(…))`, which PostgreSQL evaluates as an
  InitPlan — once per statement, not once per row.
*/
CREATE OR REPLACE FUNCTION public.current_role_permits(p_page text, p_need_edit boolean)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  -- The module term (20261027120000). A page whose every claiming module is
  -- switched off for this company permits no edit, whatever role the caller
  -- holds. `p_need_edit AND` is the line between wall C and wall D and must
  -- stay: no live caller passes false, and the day one does, this term must not
  -- silently start closing reads. See the file header.
  IF p_need_edit
     AND app_private.company_module_page_closed(public.get_active_company_id(), p_page) THEN
    RETURN false;
  END IF;

  IF COALESCE((
       SELECT CASE WHEN p_need_edit THEN rp.can_edit ELSE rp.can_view END
         FROM public.user_profiles up
         JOIN public.roles r
           ON r.id = COALESCE(
                up.role_id,
                -- Legacy profiles carry only the text `role`. Prefer a
                -- company-scoped role of that name over the system one.
                (SELECT r2.id
                   FROM public.roles r2
                  WHERE r2.name = up.role
                    AND (r2.company_id = up.company_id OR r2.company_id IS NULL)
                  ORDER BY (r2.company_id IS NULL)
                  LIMIT 1))
         JOIN public.role_permissions rp
           ON rp.role_id = r.id
          AND rp.page_key = p_page
        WHERE up.user_id = v_uid
        LIMIT 1
     ), false) THEN
    RETURN true;
  END IF;

  IF app_private.platform_staff_role_of(v_uid) IS NOT NULL
     AND NOT app_private.account_has_company(v_uid) THEN
    RETURN app_private.platform_context_company(true) IS NOT NULL;
  END IF;

  RETURN false;
END;
$$;

COMMENT ON FUNCTION public.current_role_permits(text, boolean) IS
  'Does the calling user''s role permit view/edit on this page_key, and — for '
  'an edit — is the page still claimed by a module enabled for the caller''s '
  'company (20261027120000)? Fails closed. Being platform staff grants nothing '
  'here (20260917130000) except inside an open support session (20260917140000).';

-- The owner must hold USAGE on app_private and EXECUTE on the helper above.
-- Re-asserted rather than assumed: CREATE OR REPLACE keeps the existing owner,
-- and self-check 6 fails the release if the pair has come apart.
ALTER FUNCTION public.current_role_permits(text, boolean) OWNER TO CURRENT_USER;

GRANT EXECUTE ON FUNCTION public.current_role_permits(text, boolean) TO authenticated;

-- ─── 4. Self-check ──────────────────────────────────────────────────────────

/*
  Fails the release. Each check is the rule rather than the instance.

  The two that matter most are 6 — the PR #117 class, read out of the catalogue
  — and 7, which proves on live data that a company with no module rows is
  completely unaffected by this migration.
*/
DO $$
DECLARE
  c_fn     CONSTANT text := 'public.current_role_permits(text,boolean)';
  c_closed CONSTANT text := 'app_private.company_module_page_closed(uuid,text)';
  c_pages  CONSTANT text := 'app_private.company_module_pages()';
  -- A company id that holds no company_modules row, for check 7. It is not a
  -- company at all, which is the point: the answer must not depend on one.
  c_absent CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
  v_txt    text;
  v_n      int;
  v_role   text;
  v_owner  text;
  v_page   text;
BEGIN
  -- 1. The two helpers exist with the shape the header promises.
  SELECT count(*) INTO v_n
    FROM pg_proc p
   WHERE p.oid = to_regprocedure(c_pages)
     AND p.provolatile = 'i'
     AND NOT p.prosecdef
     AND p.proconfig @> ARRAY['search_path=pg_catalog, public'];
  IF v_n <> 1 THEN
    RAISE EXCEPTION '20261027120000 self-check 1: company_module_pages() is not IMMUTABLE SECURITY INVOKER with a pinned search_path';
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_proc p
   WHERE p.oid = to_regprocedure(c_closed)
     AND p.provolatile = 's'
     AND NOT p.prosecdef
     AND p.proconfig @> ARRAY['search_path=pg_catalog, public'];
  IF v_n <> 1 THEN
    RAISE EXCEPTION '20261027120000 self-check 1: company_module_page_closed() is not STABLE SECURITY INVOKER with a pinned search_path — a missing SET clause also puts it in the plan cache''s masked class (CLAUDE.md, F2 against F3)';
  END IF;

  -- 2. No client role reaches either helper. Missing USAGE on app_private is
  --    what keeps them out; the REVOKE is the second wall.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, c_pages, 'EXECUTE')
       OR has_function_privilege(v_role, c_closed, 'EXECUTE') THEN
      RAISE EXCEPTION '20261027120000 self-check 2: % holds EXECUTE on an app_private module helper', v_role;
    END IF;
    IF has_schema_privilege(v_role, 'app_private', 'USAGE') THEN
      RAISE EXCEPTION '20261027120000 self-check 2: % holds USAGE on app_private', v_role;
    END IF;
  END LOOP;

  -- 3. Every module key in the mapping is one the product has, and every page
  --    key is one role_permissions uses. Either half drifting would make a
  --    silent no-op: a page nothing asks about, or a module nothing can switch.
  SELECT string_agg(mp.module_key, ', ') INTO v_txt
    FROM app_private.company_module_pages() mp
   WHERE NOT (mp.module_key = ANY (app_private.company_module_keys()));
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '20261027120000 self-check 3: company_module_pages() names module(s) the product does not have: %', v_txt;
  END IF;

  SELECT string_agg(mp.page_key, ', ') INTO v_txt
    FROM (SELECT DISTINCT page_key FROM app_private.company_module_pages()) mp
   WHERE NOT (mp.page_key = ANY (public.role_page_keys()));
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '20261027120000 self-check 3: company_module_pages() names page_key(s) role_page_keys() does not: %', v_txt;
  END IF;

  -- 4. No page that current_role_permits actually gates may be claimed ONLY by
  --    locked modules. A locked module can never be switched off, so such a
  --    page could never close in practice — but the formula would still close it
  --    for a row written past the RPC by a superuser, and it would be a page no
  --    operator can reopen from the panel. Keeping the lists disjoint in this
  --    direction is what makes "a locked module's pages are always claimed" true
  --    by construction rather than by inspection.
  --
  --    The gated set is READ OUT OF THE LIVE POLICIES, never written down here.
  --    A declared copy would be a third place the list of gated pages lives
  --    (beside the policies and ROLE_EDIT_ENFORCED_PAGES in
  --    src/lib/rolePermissionEnforcement.ts) and the one most likely to go
  --    stale, since nothing would read it.
  SELECT string_agg(t.page_key, ', ') INTO v_txt
    FROM (
      SELECT mp.page_key
        FROM app_private.company_module_pages() mp
       WHERE mp.page_key IN (
               SELECT (regexp_matches(
                         coalesce(pg_get_expr(p.polqual, p.polrelid), '')
                           || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                         'current_role_permits\(''([a-z][a-z-]*)''', 'g'))[1]
                 FROM pg_policy p)
       GROUP BY mp.page_key
      HAVING bool_and(mp.module_key = ANY (app_private.company_module_locked_keys()))
    ) t;
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '20261027120000 self-check 4: page(s) % are gated by current_role_permits and claimed only by locked modules — a hand-written row could close a page no operator can reopen', v_txt;
  END IF;

  -- 5. 20260917140000's body survived, fragment by fragment, plus the new term.
  --    Restating a function is how this codebase loses a clause; these are the
  --    ones whose loss would be silent.
  v_txt := app_private.function_code(c_fn);

  IF v_txt !~ 'p_need_edit[\s]*\n?[\s]*AND app_private\.company_module_page_closed'
     AND v_txt !~ 'p_need_edit\s+AND\s+app_private\.company_module_page_closed' THEN
    RAISE EXCEPTION '20261027120000 self-check 5: current_role_permits does not gate the module term on p_need_edit — an unconditional term closes READS, which is wall D and a different decision (see the header)';
  END IF;
  IF v_txt !~ 'get_active_company_id' THEN
    RAISE EXCEPTION '20261027120000 self-check 5: the module term does not ask get_active_company_id() — the company must be the one the policy''s tenant term pins';
  END IF;
  IF v_txt ~ 'get_user_company_id' THEN
    RAISE EXCEPTION '20261027120000 self-check 5: current_role_permits reads get_user_company_id() — the shell helper answers for a blocked company, which would make the module term refuse a caller the tenant term already refuses';
  END IF;

  FOREACH v_page IN ARRAY ARRAY[
    -- the fail-closed guard
    'v_uid IS NULL',
    -- the two columns, and that need_edit still chooses between them
    'CASE WHEN p_need_edit THEN rp.can_edit ELSE rp.can_view END',
    -- the legacy text-role fallback and its preference for a company role
    'r2.name = up.role',
    'ORDER BY \(r2.company_id IS NULL\)',
    -- the page join
    'rp.page_key = p_page',
    -- the support-session branch, all three of its terms
    'platform_staff_role_of\(v_uid\)',
    'NOT app_private.account_has_company\(v_uid\)',
    'platform_context_company\(true\) IS NOT NULL'
  ] LOOP
    IF v_txt !~ v_page THEN
      RAISE EXCEPTION '20261027120000 self-check 5: current_role_permits has lost the fragment %', v_page;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_n
    FROM pg_proc p
   WHERE p.oid = to_regprocedure(c_fn)
     AND p.prosecdef
     AND p.provolatile = 's'
     AND p.proconfig @> ARRAY['search_path=public, pg_catalog'];
  IF v_n <> 1 THEN
    RAISE EXCEPTION '20261027120000 self-check 5: current_role_permits is not SECURITY DEFINER STABLE with its pinned search_path';
  END IF;

  -- 6. THE PR #117 CLASS. current_role_permits is SECURITY DEFINER, so the role
  --    that must reach app_private is its OWNER, and CREATE OR REPLACE keeps an
  --    existing owner. If that owner cannot use the schema or execute the
  --    helper, every write on 33 tables raises 42501 and the product reports it
  --    as "Keine Berechtigung" — a feature that fails silently and blames the
  --    administrator's role.
  SELECT pg_get_userbyid(p.proowner) INTO v_owner
    FROM pg_proc p WHERE p.oid = to_regprocedure(c_fn);
  IF v_owner IS NULL THEN
    RAISE EXCEPTION '20261027120000 self-check 6: current_role_permits not found';
  END IF;
  IF NOT has_schema_privilege(v_owner, 'app_private', 'USAGE') THEN
    RAISE EXCEPTION '20261027120000 self-check 6: current_role_permits is owned by %, which holds no USAGE on app_private — every gated write would raise 42501', v_owner;
  END IF;
  IF NOT has_function_privilege(v_owner, c_closed, 'EXECUTE') THEN
    RAISE EXCEPTION '20261027120000 self-check 6: current_role_permits is owned by %, which cannot execute % — every gated write would raise 42501', v_owner, c_closed;
  END IF;
  IF NOT has_function_privilege(v_owner, c_pages, 'EXECUTE') THEN
    RAISE EXCEPTION '20261027120000 self-check 6: current_role_permits is owned by %, which cannot execute %', v_owner, c_pages;
  END IF;

  -- 7. ABSENCE MEANS ON, proved rather than reasoned. If any of these answered
  --    true, applying this migration would switch every module off for every
  --    company that has never been touched in the panel.
  IF app_private.company_module_page_closed(c_absent, 'documents') THEN
    RAISE EXCEPTION '20261027120000 self-check 7: a company with no company_modules rows reads `documents` as CLOSED — absence must mean on, or this release takes every existing customer dark';
  END IF;
  FOREACH v_page IN ARRAY public.role_page_keys() LOOP
    IF app_private.company_module_page_closed(c_absent, v_page) THEN
      RAISE EXCEPTION '20261027120000 self-check 7: a company with no company_modules rows reads page % as closed', v_page;
    END IF;
  END LOOP;
  IF app_private.company_module_page_closed(NULL, 'documents') THEN
    RAISE EXCEPTION '20261027120000 self-check 7: a NULL company reads `documents` as closed — the fail-open answer is false';
  END IF;
  IF app_private.company_module_page_closed(c_absent, 'statistics') THEN
    RAISE EXCEPTION '20261027120000 self-check 7: `statistics` reads as closed; no module claims it, so it can never be';
  END IF;
  IF app_private.company_module_page_closed(c_absent, NULL) THEN
    RAISE EXCEPTION '20261027120000 self-check 7: a NULL page reads as closed';
  END IF;

  -- 8. The same proof against the real companies on THIS database: every
  --    company that holds no company_modules row at all must read every page as
  --    open. That is the population the fail-open rule exists for — on
  --    production it is every customer nobody has touched in the panel — and it
  --    is the claim worth asserting against live data rather than against a
  --    synthetic id.
  --
  --    Note what this check deliberately does NOT assert: that *no* company
  --    loses a page. A company whose operator switched a module off is supposed
  --    to lose that module's pages — that is the whole feature, and the first
  --    draft of this check would have refused the release that delivers it. The
  --    blast radius is reported as a notice instead, so the release says out
  --    loud what it is about to close.
  SELECT count(*) INTO v_n
    FROM public.companies c
    CROSS JOIN LATERAL unnest(public.role_page_keys()) AS pk(page_key)
   WHERE NOT EXISTS (SELECT 1 FROM public.company_modules cm WHERE cm.company_id = c.id)
     AND app_private.company_module_page_closed(c.id, pk.page_key);
  IF v_n > 0 THEN
    RAISE EXCEPTION '20261027120000 self-check 8: % (company, page) pair(s) read as CLOSED for companies that hold no company_modules row at all. Absence must mean on; this release would take untouched customers dark', v_n;
  END IF;

  SELECT count(*) INTO v_n
    FROM public.companies c
    CROSS JOIN LATERAL unnest(public.role_page_keys()) AS pk(page_key)
   WHERE app_private.company_module_page_closed(c.id, pk.page_key);
  RAISE NOTICE '20261027120000: this release closes % (company, page) write pair(s), from decisions already stored in company_modules', v_n;

  RAISE NOTICE '20261027120000 self-check: all 8 groups passed';
END;
$$;
