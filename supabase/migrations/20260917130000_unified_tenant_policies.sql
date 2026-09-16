/*
  # One policy shape for every tenant table, and company and user state decided
    by the database (plan 3.3)

  ## What was wrong

  Three things, all of them invisible from any single policy:

  **1. Five different shapes meant five different answers.** The same question —
  "does this row belong to the caller's company?" — was written as

      company_id = get_user_company_id()                        (most tables)
      company_id IN (SELECT company_id FROM user_profiles …)     (fahrtenbuch_*,
                                                                  planning, historical,
                                                                  notification_settings)
      EXISTS (SELECT 1 FROM user_profiles WHERE …)               (discount_code_redemptions)
      … AND user_profiles.company_id IS NOT NULL                 (historical_*)
      … AND user_profiles.role = 'admin'                         (imports, trips)

  and the tables written in the second and third shapes carry no platform branch
  at all, so the same staff account reads a company's receipts and not its
  Fahrtenbuch. A reviewer cannot tell which of the five a new table should copy.

  **2. `OR is_user_super_admin()` on write policies.** Since 20260916110010 that
  function is true for *any* active `app_private.platform_staff` row, whatever
  its role. So `read_only` — a role that exists to look — held an owner's
  UPDATE and DELETE on companies, subscriptions, invoices, plans and on every
  tenant's operational data, and could move a tenant's rows into another
  company. `tests/rls/platform-authority.sql` recorded that as HOLE[3.3].

  **3. The database did not know what App.tsx knows.** A suspended or rejected
  company, one still waiting for approval, one whose subscription is inactive,
  expired or past its expiry date, and a deactivated, suspended or inactive user
  were refused by the screens and by `signIn()` alone. Any token that already
  existed — a restored session, a session installed from a one-time code, a
  direct PostgREST call with the same JWT — kept reading and writing.

  ## What this does

  **One helper decides the company, and it is the only thing that changes when
  a state rule changes.**

  - `get_user_company_id()` — unchanged. The caller's membership, whatever state
    that membership is in. It stays the predicate of the *account shell*: the
    company row, its settings, profiles, roles and the subscription tables. A
    suspended company's owner has to keep reading those, or the page that
    explains the suspension, the activation screen and the invoice screen would
    all come up empty.
  - `get_active_company_id()` — new. The company whose *business data* the caller
    may touch, or NULL. NULL for anon, for an account without a profile, for a
    platform account (no company), and for every state App.tsx refuses. Every
    business table reads this one and nothing else, so a company that may not be
    used disappears from the database's point of view rather than from the
    router's.

  The state rules are App.tsx's, one for one (the sources are named in the
  function's comment): `user_profiles.status`, `companies.approval_status`,
  `companies.status`, `companies.subscription_status` and
  `companies.subscription_expires_at`.

  **Two named seams for 3.4**, so the support-session slice changes two function
  bodies instead of rewriting 150 policies again:

  - `platform_reads_company_data()` — today "an active staff role holding
    `business.read`", which is what the platform screens already do (the matrix
    tags it HOLE[3.4]). 3.4 narrows it to "…and has an open read or support
    context on this company".
  - `platform_writes_company_data()` — today **false**, and the self-check
    proves it. 3.4 makes it "…has an open *support* session on this company".
    Until then a staff role reaches company data through the audited read models
    of 3.6b and nowhere else.

  **The planning RPCs ask the same helper.** `apply_monthly_planning_run`,
  `replace_monthly_planning_run`, `delete_or_archive_monthly_planning_run`,
  `purge_old_monthly_planning_runs` and `reassign_fahrtenbuch_trip` are SECURITY
  DEFINER and ran past RLS on `SELECT company_id FROM user_profiles`, so a
  suspended company could still reassign trips. They now read
  `get_active_company_id()`. Their bodies are rewritten from the catalogue, not
  retyped: the live definition is the only authority on what they do, and
  transcribing 500 lines by hand is how a payroll function silently loses a
  clause. Each keeps its own "caller has no company" message; the sentence is
  now also what a caller whose company may not be used is told.

  **And so do the three Gehaltsquittung RPCs.** `confirm_salary_cash_payment`,
  `void_salary_cash_receipt` and `attach_salary_cash_receipt_signed_copy`
  (20260914140000) are SECURITY DEFINER too, and read `get_user_company_id()`.
  Their only other guard is `current_role_permits('salaries', true)`, which
  reads the role matrix and never the state of the account or of the company —
  so a deactivated employee, or any user of a suspended, rejected, unapproved or
  unsubscribed company, could still POST a Gehaltsquittung with the token it
  already held and write a gapless GQ receipt, a `salary_payments` row and an
  outgoing `cash_movements` row, and void receipts the same way. GoTrue keeps
  refreshing that token from its own tables and never consults `user_profiles`,
  so the window is not the 20-minute inactivity logout. The same one-fragment
  rewrite puts all three on `get_active_company_id()`, and each function's
  existing `IF v_caller IS NULL OR v_company IS NULL … RAISE 42501` then refuses
  the blocked caller. Nothing else in them changes — the path prefix check in
  the third still compares against `v_company`, so a signed copy still has to
  land in the caller's own folder.

  **`current_role_permits()` loses its `is_user_super_admin()` term.** It gates
  ten business tables and three storage policies, and that term is the same
  "platform right because the caller is staff" this slice removes from the
  policies — one indirection below where a reader of a policy can see it.
  Unreachable today, because the tenant half of each predicate already answers
  NULL for a platform account; reachable the moment 3.4 widens that half with an
  OR. Section 1 has the full reasoning.

  **`company_id` is pinned on `company_subscriptions` and
  `subscription_invoices`.** Their policies name a capability and no company at
  all, which left `billing.manage` able to re-point an existing invoice at
  another company and re-attribute money. A policy cannot express "the value it
  already had" — WITH CHECK never sees the old row — so it is a trigger.

  **Storage.** The `salary-receipts` policies (20260914140000) move to the same
  helper. The older buckets' policies (`company_logos`, `document_templates`,
  `stundennachweise_pdfs`) predate the schema fixture, so the RLS kit cannot see
  them and this migration cannot prove a change to them; they are left for 3.4,
  which routes every file through `platform-file-url` anyway.

  ## What this deliberately does not do

  - It does not narrow what staff may *read*. That is 3.4's business, and taking
    reads away before the support session exists would blind the platform
    screens that exist today.
  - It does not change `user_sessions`, the code and referral tables
    (20260916110010 already put those on capabilities), or
    `activation_code_attempts` (20260916130020).
  - It does not move `redeem_activation_code` onto the active helper. That RPC
    is the way *out* of a blocked state — a company whose subscription lapsed
    redeems a code to get it back — so the helper would answer NULL for exactly
    the caller who needs it. It keeps reading the caller's membership from
    `user_profiles` directly, the way 20260916130020 wrote it.

  ## Compatibility — this bumps deploy/SCHEMA_EPOCH

  Not backward compatible, on purpose. Rolling back to the previous release
  would restore code that assumes a staff account may write any tenant's rows
  and that the screens are the only thing keeping a suspended company out — but
  the policies here would already be gone with the migration only if the
  database were restored too, which a rollback does not do. Either way the pair
  is inconsistent, so `deploy/SCHEMA_EPOCH` goes from 1 to 2 in this commit and
  `ci-release.sh` refuses to roll back across it. The way back is the database
  snapshot `deploy.sh` takes before the migration runs.
*/

-- ─── 1. The helpers ─────────────────────────────────────────────────────────

COMMENT ON FUNCTION public.get_user_company_id() IS
  'The caller''s company, whatever state the account or the company is in. '
  'The predicate of the account shell only — companies, company_settings, '
  'user_profiles, roles, role_permissions and the subscription tables — so a '
  'suspended company still reads the pages that explain its state. Business '
  'tables use get_active_company_id().';

/*
  The company whose business data the caller may read and write, or NULL.

  Every condition below is one of App.tsx's gates, and nothing else is added:

    up.status            AuthContext.userStatusBlockReason(): inactive,
                         suspended and deactivated are blocked. pending_invite
                         is NOT blocked — an invited employee signs in from the
                         invitation link and only then sets status to active
                         (SetPasswordPage), and blocking it here would break
                         that flow.
    c.approval_status    App.tsx gate 3: pending, rejected and suspended each
                         take over the whole screen, so only approved passes.
    c.status             AuthContext.checkProfileAccess(): suspended, inactive,
                         deleted and archived are blocked. The CHECK constraint
                         allows active, suspended, inactive and trial, so the
                         rule is "active or trial".
    c.subscription_*     App.tsx gate 5 (SubscriptionGuard) with
                         AuthContext.isSubscriptionActive: status must be
                         active, and the expiry must be absent or in the future.

  On the status vocabulary, because the migration chain and the live database
  disagree and only one of them is true: `user_profiles.status` accepts five
  values on the real databases — active, inactive, pending_invite, suspended and
  deactivated. That is what `tests/fixtures/schema.sql` carries (a --schema-only
  dump of production, which is also what the RLS kit builds from), and it is
  what 20260916130000 depends on when archiving a company sets its users to
  'deactivated'. The chain says otherwise: 20260402100619 adds
  user_profiles_status_check with three values and wraps it in IF NOT EXISTS, so
  it never widened it and no later migration restates it — the widening happened
  outside version control, like the CREATE TABLEs CLAUDE.md warns about. The
  three values this function blocks are the deployed vocabulary, not the
  chain's, and 'suspended' and 'deactivated' are reachable rows rather than
  defensive ones.

  must_change_password is deliberately absent: App.tsx routes such a user to
  /set-new-password, but the flag is a hygiene prompt, not an authorization
  boundary (20260908110000 says why), and a user can clear it themselves.

  NULL-safe by construction: auth.uid() is NULL for anon, a platform account has
  no company, and a caller without a profile row matches nothing — in each case
  the join yields no row and the function returns NULL, which no company_id
  equals.

  SECURITY DEFINER because it reads user_profiles and companies, which the
  caller's own policies would otherwise filter. STABLE and argument-free, so
  every policy can call it as (SELECT …) and the planner evaluates it once per
  statement instead of once per row (20260912110000 measured 65x on
  fahrtenbuch_trips).
*/
CREATE OR REPLACE FUNCTION public.get_active_company_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT up.company_id
    FROM public.user_profiles up
    JOIN public.companies c ON c.id = up.company_id
   WHERE up.user_id = auth.uid()
     AND up.status NOT IN ('inactive', 'suspended', 'deactivated')
     AND c.approval_status = 'approved'
     AND c.status IN ('active', 'trial')
     AND c.subscription_status = 'active'
     AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now())
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_active_company_id() IS
  'The company whose business data the caller may act on, or NULL. Mirrors the '
  'gates in App.tsx and AuthContext: account status, company approval, company '
  'status and subscription. The predicate of every business table.';

ALTER FUNCTION public.get_active_company_id() OWNER TO CURRENT_USER;

/*
  Seam for 3.4, read side. Today: an active staff role holding business.read
  reads every company's data, which is what the platform screens do now and what
  the matrix records as HOLE[3.4]. 3.4 replaces this body with "holds
  business.read AND has an open read or support context", and scopes the
  policies to platform_view_company_id().

  SECURITY INVOKER: platform_can() is the SECURITY DEFINER that reaches
  app_private, and the caller already holds EXECUTE on it.
*/
CREATE OR REPLACE FUNCTION public.platform_reads_company_data()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT coalesce(public.platform_can('business.read'), false);
$$;

COMMENT ON FUNCTION public.platform_reads_company_data() IS
  'Seam for plan 3.4: may platform staff read company data at all? Today: an '
  'active role holding business.read. 3.4 adds the open read/support context.';

/*
  Seam for 3.4, write side. False, for everyone, always — which is the whole
  point of this slice: a staff role no longer writes a tenant's rows because it
  is staff. 3.4 replaces this body with "has an open support session on this
  company"; until then the only paths to a tenant's data are the audited read
  models (3.6b) and the audited platform write RPCs (3.5).

  It is a constant rather than a missing clause so that 3.4 changes one body
  instead of rewriting every policy in this file, and so that the self-check
  below can prove the write side is closed.
*/
CREATE OR REPLACE FUNCTION public.platform_writes_company_data()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT false;
$$;

COMMENT ON FUNCTION public.platform_writes_company_data() IS
  'Seam for plan 3.4: may platform staff write company data? False until the '
  'support session exists. Writing as staff happens inside a logged, '
  'time-limited session and nowhere else.';

-- Policies call all three as the querying role, so `authenticated` needs
-- EXECUTE. anon does not: every policy in public applies TO authenticated.
--
-- The service role gets the company helper, which it can answer (its own
-- auth.uid() is NULL, so the answer is NULL), and neither seam. Both seams are
-- SECURITY INVOKER wrappers around platform_can(), on which the service role
-- holds no EXECUTE — a grant here would advertise a path that raises 42501
-- rather than returning false, which is worse than no path at all.
REVOKE ALL ON FUNCTION public.get_active_company_id()          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_reads_company_data()    FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.platform_writes_company_data()   FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.get_active_company_id()        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_reads_company_data()  TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_writes_company_data() TO authenticated;

/*
  current_role_permits() loses its super-admin term.

  It opened with `SELECT is_user_super_admin() OR COALESCE(…)`, and it is the
  write gate of ten business tables and of all three salary-receipts storage
  policies. Since 20260916110010 `is_user_super_admin()` is true for *any*
  active staff row whatever its role — so that first line is the same "a
  platform right because the caller is staff" this slice removes everywhere
  else, one indirection below where a reader of the policy can see it.

  It is not reachable today. Every one of those predicates reads
  `company_id = (SELECT get_active_company_id()) AND (SELECT current_role_permits(…))`,
  and a platform account's get_active_company_id() is NULL, so the AND is false
  whatever the role term answers. It becomes reachable the moment 3.4 widens the
  tenant term with an OR — which is precisely what 3.4 does, on ten payroll
  tables at once. Removing it here means 3.4 changes a seam and inherits no
  latent branch, and it makes the invariant the self-check states actually true
  rather than true only of the policy text.

  What moves: nothing for a company user, whose answer never came from this
  term, and nothing for a platform account reaching a business table, which the
  tenant predicate already refuses. The one real narrowing is the three
  Gehaltsquittung RPCs of 20260914140000, which ask this function directly: a
  platform account that also holds a profile inside a company used to pass this
  gate whatever role that profile carried, and is now judged by the role, like
  everyone else.

  The body is otherwise 20260910120000's, unchanged — the legacy text-role
  fallback and the COALESCE that makes it fail closed included. CREATE OR
  REPLACE keeps the owner and the existing grants, so anon keeps the EXECUTE it
  has always had here and keeps getting `false` from it: it has no profile row.
*/
CREATE OR REPLACE FUNCTION public.current_role_permits(p_page text, p_need_edit boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT COALESCE((
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
            WHERE up.user_id = auth.uid()
            LIMIT 1
         ), false);
$$;

COMMENT ON FUNCTION public.current_role_permits(text, boolean) IS
  'Does the calling user''s role permit view/edit on this page_key? Fails closed. '
  'Since 20260917130000 being platform staff grants nothing here: the role on the '
  'caller''s own profile decides, as it does for every other caller.';

-- ─── 2. The business tables ─────────────────────────────────────────────────
--
-- One shape, four policies, canonical names:
--
--   SELECT  company_id = active            OR  platform reads
--   INSERT  company_id = active AND gate   OR  platform writes (false today)
--   UPDATE  the same, as USING and as WITH CHECK
--   DELETE  the same USING, with the delete gate
--
-- `gate` is what each table already required and nothing more: the page of
-- role_permissions for the ten tables 20260910120000 put on
-- current_role_permits(), a company administrator for the four that already
-- asked for one, and nothing for the rest. Writing the same USING and WITH
-- CHECK is what refuses a move: a row may not leave the company it is in, and
-- may not arrive from another one.

DO $mig$
DECLARE
  t        record;
  p        record;
  v_tbl    text;
  v_gate_w text;
  v_gate_d text;
  v_where  text;
  v_admin  constant text := '(SELECT public.is_company_admin())';
  v_tenant constant text := 'company_id = (SELECT public.get_active_company_id())';
  v_reads  constant text := '(SELECT public.platform_reads_company_data())';
  v_writes constant text := '(SELECT public.platform_writes_company_data())';
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      -- table                                 ops     page           admin_w  admin_d  extra INSERT predicate
      ('receipts',                             'SIUD', 'receipts',    false,   false,   NULL),
      ('income',                               'SIUD', 'income',      false,   false,   NULL),
      ('drivers',                              'SIUD', 'drivers',     false,   false,   NULL),
      ('cars',                                 'SIUD', 'cars',        false,   false,   NULL),
      ('fixed_costs',                          'SIUD', 'fixed-costs', false,   false,   NULL),
      ('salaries',                             'SIUD', 'salaries',    false,   false,   NULL),
      ('salary_payments',                      'SIUD', 'salaries',    false,   false,   NULL),
      ('werkstatt_checks',                     'SIUD', 'werkstatt',   false,   false,   NULL),
      ('driver_notes',                         'SIUD', 'notes',       false,   false,   NULL),
      ('documents',                            'SIUD', 'documents',   false,   false,   NULL),
      -- no role gate today, and none added: a viewer writes these exactly as it
      -- does now. Narrowing them is a decision about roles, not about tenancy.
      ('car_driver_assignments',               'SIUD', NULL,          false,   false,   NULL),
      ('cash_transactions',                    'SIUD', NULL,          false,   false,   NULL),
      ('document_templates',                   'SIUD', NULL,          false,   false,   NULL),
      ('company_planning_runs',                'SIUD', NULL,          false,   false,   NULL),
      ('company_planning_run_blocks',          'SIUD', NULL,          false,   false,   NULL),
      ('monthly_planning_manual_exceptions',   'SIUD', NULL,          false,   false,   NULL),
      ('planning_finalizations',               'SIUD', NULL,          false,   false,   NULL),
      ('planning_run_adjustments',             'SIUD', NULL,          false,   false,   NULL),
      ('historical_reconciliations',           'SIUD', NULL,          false,   false,   NULL),
      ('historical_block_adjustments',         'SIUD', NULL,          false,   false,   NULL),
      ('historical_driver_hour_targets',       'SIUD', NULL,          false,   false,   NULL),
      ('historical_payroll_targets',           'SIUD', NULL,          false,   false,   NULL),
      ('historical_time_adjustments',          'SIUD', NULL,          false,   false,   NULL),
      ('historical_wh_saved_plans',            'SIUD', NULL,          false,   false,   NULL),
      ('saved_stundennachweise',               'SIUD', NULL,          false,   false,   NULL),
      -- deleting an import takes a finalized month's trips with it, so it stays
      -- the administrator's, as it is today. The INSERT clause is the second
      -- half of the live policy and is not decoration: the whole payroll chain
      -- hangs off the import, so it records who filed it, and a member may not
      -- file one in another member's name. Same rule, same shape, as
      -- fahrtenbuch_assignment_audit's changed_by below
      ('fahrtenbuch_imports',                  'SIUD', NULL,          false,   true,    'imported_by = auth.uid()'),
      -- no UPDATE policy, deliberately: every mutable field of a trip is written
      -- by an RPC (CLAUDE.md, "fahrtenbuch_trips is append-only by design").
      -- 20260908113000 dropped the one that existed; this must not bring it back
      ('fahrtenbuch_trips',                    'SID',  NULL,          false,   true,    NULL),
      -- the record of who reassigned what: written once, never changed
      ('fahrtenbuch_assignment_audit',         'SI',   NULL,          false,   false,   'changed_by = auth.uid()'),
      -- notification_settings' write policies named role IN ('admin','support').
      -- 'support' is not one of the four system roles and current_role_permits()
      -- resolves nothing for it, so such a profile is already refused everywhere
      -- else; the gate here is the company administrator
      ('notification_settings',                'SIU',  NULL,          true,    false,   NULL),
      -- the Gehaltsquittung ledger: SELECT only for every client role, because
      -- 20260914140000 granted nothing else. Its SECURITY DEFINER functions write it
      ('cash_movements',                       'S',    NULL,          false,   false,   NULL),
      ('salary_cash_receipts',                 'S',    NULL,          false,   false,   NULL)
    ) AS v(tbl, ops, page, admin_w, admin_d, ins_extra)
  LOOP
    v_tbl := t.tbl;

    IF to_regclass('public.' || v_tbl) IS NULL THEN
      RAISE NOTICE '3.3: % is not present — skipping', v_tbl;
      CONTINUE;
    END IF;

    v_gate_w := CASE
                  WHEN t.page IS NOT NULL THEN format('(SELECT public.current_role_permits(%L, true))', t.page)
                  WHEN t.admin_w THEN v_admin
                END;
    v_gate_d := CASE
                  WHEN t.page IS NOT NULL THEN format('(SELECT public.current_role_permits(%L, true))', t.page)
                  WHEN t.admin_d THEN v_admin
                END;

    -- This migration is the single definition of access to these tables, so
    -- whatever is there goes first — including policies created outside version
    -- control, which the schema history shows this database has had.
    FOR p IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, v_tbl);
    END LOOP;

    IF position('S' in t.ops) > 0 THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s OR %s)',
        v_tbl || '_select', v_tbl, v_tenant, v_reads);
    END IF;

    IF position('I' in t.ops) > 0 THEN
      v_where := v_tenant
                 || coalesce(' AND ' || v_gate_w, '')
                 || coalesce(' AND ' || t.ins_extra, '');
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK ((%s) OR %s)',
        v_tbl || '_insert', v_tbl, v_where, v_writes);
    END IF;

    IF position('U' in t.ops) > 0 THEN
      v_where := v_tenant || coalesce(' AND ' || v_gate_w, '');
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated '
        'USING ((%s) OR %s) WITH CHECK ((%s) OR %s)',
        v_tbl || '_update', v_tbl, v_where, v_writes, v_where, v_writes);
    END IF;

    IF position('D' in t.ops) > 0 THEN
      v_where := v_tenant || coalesce(' AND ' || v_gate_d, '');
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING ((%s) OR %s)',
        v_tbl || '_delete', v_tbl, v_where, v_writes);
    END IF;
  END LOOP;
END $mig$;

-- ─── 3. Business tables that reach their company through a parent ───────────
--
-- The same shape, with the parent's company_id in place of the row's own. The
-- platform read term sits inside the EXISTS, as it does today: without a parent
-- row there is nothing to read either way.

DO $mig$
DECLARE
  t       record;
  p       record;
  v_read  text;
  v_write text;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('document_blocks',                      'documents',                 'document_id',      'd'),
      ('document_variables',                   'documents',                 'document_id',      'd'),
      ('historical_reconciliation_drivers',    'historical_reconciliations', 'reconciliation_id', 'hr'),
      ('historical_reconciliation_results',    'historical_reconciliations', 'reconciliation_id', 'hr'),
      ('historical_reconciliation_wh_drivers', 'historical_reconciliations', 'reconciliation_id', 'hr')
    ) AS v(tbl, parent, fk, alias)
  LOOP
    IF to_regclass('public.' || t.tbl) IS NULL THEN
      RAISE NOTICE '3.3: % is not present — skipping', t.tbl;
      CONTINUE;
    END IF;

    v_read := format(
      'EXISTS (SELECT 1 FROM public.%I %I WHERE %I.id = %I.%I '
      'AND (%I.company_id = (SELECT public.get_active_company_id()) '
      'OR (SELECT public.platform_reads_company_data())))',
      t.parent, t.alias, t.alias, t.tbl, t.fk, t.alias);

    v_write := format(
      'EXISTS (SELECT 1 FROM public.%I %I WHERE %I.id = %I.%I '
      'AND %I.company_id = (SELECT public.get_active_company_id())) '
      'OR (SELECT public.platform_writes_company_data())',
      t.parent, t.alias, t.alias, t.tbl, t.fk, t.alias);

    FOR p IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t.tbl
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t.tbl);
    END LOOP;

    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)',
                   t.tbl || '_select', t.tbl, v_read);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)',
                   t.tbl || '_insert', t.tbl, v_write);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',
                   t.tbl || '_update', t.tbl, v_write, v_write);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (%s)',
                   t.tbl || '_delete', t.tbl, v_write);
  END LOOP;
END $mig$;

-- ─── 4. The account shell ───────────────────────────────────────────────────
--
-- Not state-gated: these are the tables the blocked screens themselves read.
-- The waiting page, the rejection page, the suspension page, /abo-aktivieren
-- and /billing all render for a company that may not be used, and they read the
-- company row, its settings, the caller's profile, the role matrix and the
-- subscription tables.
--
-- What changes here is only who the platform branch is: each
-- `is_user_super_admin()` becomes the capability that names the act, so a
-- read_only or support role stops holding an owner's writes. Every predicate
-- keeps the structure it has today, so no cell moves for an owner.

-- companies: no tenant-facing code path writes this table. Members read their
-- own row; the platform screens create, approve and suspend through the audited
-- RPCs of 20260916130000, whose capability these policies now match.
DROP POLICY IF EXISTS "Users can view their company"        ON public.companies;
DROP POLICY IF EXISTS "Super admins can insert companies"   ON public.companies;
DROP POLICY IF EXISTS "Super admins can update companies"   ON public.companies;
DROP POLICY IF EXISTS "Super admins can delete companies"   ON public.companies;
DROP POLICY IF EXISTS "Company admins can update their company" ON public.companies;

CREATE POLICY companies_select ON public.companies
  FOR SELECT TO authenticated
  USING (id = (SELECT public.get_user_company_id())
         OR (SELECT public.platform_can('companies.read')));

CREATE POLICY companies_insert ON public.companies
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.platform_can('companies.lifecycle')));

CREATE POLICY companies_update ON public.companies
  FOR UPDATE TO authenticated
  USING ((SELECT public.platform_can('companies.lifecycle')))
  WITH CHECK ((SELECT public.platform_can('companies.lifecycle')));

CREATE POLICY companies_delete ON public.companies
  FOR DELETE TO authenticated
  USING ((SELECT public.platform_can('companies.hard_delete')));

-- company_settings: the company's legal data and its Bundesland, which select
-- the holiday calendar. Its administrator writes it; the platform does not,
-- outside a lifecycle act.
DROP POLICY IF EXISTS "Company users can view company_settings"    ON public.company_settings;
DROP POLICY IF EXISTS "Company admins can insert company_settings" ON public.company_settings;
DROP POLICY IF EXISTS "Company admins can update company_settings" ON public.company_settings;
DROP POLICY IF EXISTS "Super admins can delete company_settings"   ON public.company_settings;

CREATE POLICY company_settings_select ON public.company_settings
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_user_company_id())
         OR (SELECT public.platform_can('companies.read')));

CREATE POLICY company_settings_insert ON public.company_settings
  FOR INSERT TO authenticated
  WITH CHECK (company_id = (SELECT public.get_user_company_id())
              AND ((SELECT public.is_company_admin())
                   OR (SELECT public.platform_can('companies.lifecycle'))));

CREATE POLICY company_settings_update ON public.company_settings
  FOR UPDATE TO authenticated
  USING ((company_id = (SELECT public.get_user_company_id()) AND (SELECT public.is_company_admin()))
         OR (SELECT public.platform_can('companies.lifecycle')))
  WITH CHECK ((company_id = (SELECT public.get_user_company_id()) AND (SELECT public.is_company_admin()))
              OR (SELECT public.platform_can('companies.lifecycle')));

CREATE POLICY company_settings_delete ON public.company_settings
  FOR DELETE TO authenticated
  USING ((SELECT public.platform_can('companies.hard_delete')));

-- user_profiles: the caller's own row is always readable and writable — that is
-- how the invitation flow completes. Everything that could raise a privilege is
-- refused by enforce_user_profile_privilege_guard before RLS is reached.
DROP POLICY IF EXISTS "Users can view company profiles"   ON public.user_profiles;
DROP POLICY IF EXISTS "Users can insert own profile"      ON public.user_profiles;
DROP POLICY IF EXISTS "Users update own profile, admins update company profiles" ON public.user_profiles;
DROP POLICY IF EXISTS "Admins can delete company profiles" ON public.user_profiles;

CREATE POLICY user_profiles_select ON public.user_profiles
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid())
         OR company_id = (SELECT public.get_user_company_id())
         OR (SELECT public.platform_reads_company_data()));

CREATE POLICY user_profiles_insert ON public.user_profiles
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY user_profiles_update ON public.user_profiles
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())
         OR (company_id = (SELECT public.get_user_company_id()) AND (SELECT public.is_company_admin()))
         OR (SELECT public.platform_can('company_users.manage')))
  WITH CHECK (user_id = (SELECT auth.uid())
              OR (company_id = (SELECT public.get_user_company_id()) AND (SELECT public.is_company_admin()))
              OR (SELECT public.platform_can('company_users.manage')));

CREATE POLICY user_profiles_delete ON public.user_profiles
  FOR DELETE TO authenticated
  USING ((company_id = (SELECT public.get_user_company_id()) AND (SELECT public.is_company_admin()))
         OR (SELECT public.platform_can('company_users.manage')));

-- roles and role_permissions: the company's own custom roles. System roles
-- (company_id IS NULL) stay readable by everyone and writable by nobody.
DROP POLICY IF EXISTS "Users can view roles"              ON public.roles;
DROP POLICY IF EXISTS "Company admins can insert roles"   ON public.roles;
DROP POLICY IF EXISTS "Company admins can update roles"   ON public.roles;
DROP POLICY IF EXISTS "Company admins can delete roles"   ON public.roles;

CREATE POLICY roles_select ON public.roles
  FOR SELECT TO authenticated
  USING (company_id IS NULL
         OR company_id = (SELECT public.get_user_company_id())
         OR (SELECT public.platform_reads_company_data()));

CREATE POLICY roles_insert ON public.roles
  FOR INSERT TO authenticated
  WITH CHECK (company_id = (SELECT public.get_user_company_id())
              AND ((SELECT public.is_company_admin())
                   OR (SELECT public.platform_can('company_users.manage'))));

CREATE POLICY roles_update ON public.roles
  FOR UPDATE TO authenticated
  USING (is_system = false
         AND ((company_id = (SELECT public.get_user_company_id()) AND (SELECT public.is_company_admin()))
              OR (SELECT public.platform_can('company_users.manage'))))
  WITH CHECK (company_id = (SELECT public.get_user_company_id())
              AND ((SELECT public.is_company_admin())
                   OR (SELECT public.platform_can('company_users.manage'))));

CREATE POLICY roles_delete ON public.roles
  FOR DELETE TO authenticated
  USING (is_system = false
         AND ((company_id = (SELECT public.get_user_company_id()) AND (SELECT public.is_company_admin()))
              OR (SELECT public.platform_can('company_users.manage'))));

DROP POLICY IF EXISTS "Users can view role_permissions"              ON public.role_permissions;
DROP POLICY IF EXISTS "Company admins can insert role_permissions"   ON public.role_permissions;
DROP POLICY IF EXISTS "Company admins can update role_permissions"   ON public.role_permissions;
DROP POLICY IF EXISTS "Company admins can delete role_permissions"   ON public.role_permissions;

CREATE POLICY role_permissions_select ON public.role_permissions
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.roles r
                  WHERE r.id = role_permissions.role_id
                    AND (r.company_id IS NULL
                         OR r.company_id = (SELECT public.get_user_company_id())
                         OR (SELECT public.platform_reads_company_data()))));

CREATE POLICY role_permissions_insert ON public.role_permissions
  FOR INSERT TO authenticated
  WITH CHECK (((SELECT public.is_company_admin())
               OR (SELECT public.platform_can('company_users.manage')))
              AND EXISTS (SELECT 1 FROM public.roles r
                           WHERE r.id = role_permissions.role_id
                             AND r.company_id = (SELECT public.get_user_company_id())));

CREATE POLICY role_permissions_update ON public.role_permissions
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.roles r
                  WHERE r.id = role_permissions.role_id
                    AND ((r.company_id = (SELECT public.get_user_company_id())
                          AND (SELECT public.is_company_admin()))
                         OR (SELECT public.platform_can('company_users.manage')))))
  WITH CHECK (((SELECT public.is_company_admin())
               OR (SELECT public.platform_can('company_users.manage')))
              AND EXISTS (SELECT 1 FROM public.roles r
                           WHERE r.id = role_permissions.role_id
                             AND r.company_id = (SELECT public.get_user_company_id())));

CREATE POLICY role_permissions_delete ON public.role_permissions
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.roles r
                  WHERE r.id = role_permissions.role_id
                    AND ((r.company_id = (SELECT public.get_user_company_id())
                          AND (SELECT public.is_company_admin()))
                         OR (SELECT public.platform_can('company_users.manage')))));

-- The subscription tables: a company reads its own money, the platform's
-- billing roles write it. 20260916130000's invoice and subscription RPCs ask
-- for the same capability.
DROP POLICY IF EXISTS users_read_own_subscription     ON public.company_subscriptions;
DROP POLICY IF EXISTS superadmin_insert_subscription  ON public.company_subscriptions;
DROP POLICY IF EXISTS superadmin_update_subscription  ON public.company_subscriptions;
DROP POLICY IF EXISTS superadmin_delete_subscription  ON public.company_subscriptions;

CREATE POLICY company_subscriptions_select ON public.company_subscriptions
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_user_company_id())
         OR (SELECT public.platform_can('companies.read')));

CREATE POLICY company_subscriptions_insert ON public.company_subscriptions
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.platform_can('billing.manage')));

CREATE POLICY company_subscriptions_update ON public.company_subscriptions
  FOR UPDATE TO authenticated
  USING ((SELECT public.platform_can('billing.manage')))
  WITH CHECK ((SELECT public.platform_can('billing.manage')));

CREATE POLICY company_subscriptions_delete ON public.company_subscriptions
  FOR DELETE TO authenticated
  USING ((SELECT public.platform_can('billing.manage')));

DROP POLICY IF EXISTS users_read_own_invoices    ON public.subscription_invoices;
DROP POLICY IF EXISTS superadmin_insert_invoices ON public.subscription_invoices;
DROP POLICY IF EXISTS superadmin_update_invoices ON public.subscription_invoices;
DROP POLICY IF EXISTS superadmin_delete_invoices ON public.subscription_invoices;

CREATE POLICY subscription_invoices_select ON public.subscription_invoices
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_user_company_id())
         OR (SELECT public.platform_can('companies.read')));

CREATE POLICY subscription_invoices_insert ON public.subscription_invoices
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.platform_can('billing.manage')));

CREATE POLICY subscription_invoices_update ON public.subscription_invoices
  FOR UPDATE TO authenticated
  USING ((SELECT public.platform_can('billing.manage')))
  WITH CHECK ((SELECT public.platform_can('billing.manage')));

CREATE POLICY subscription_invoices_delete ON public.subscription_invoices
  FOR DELETE TO authenticated
  USING ((SELECT public.platform_can('billing.manage')));

DROP POLICY IF EXISTS users_read_own_audit    ON public.subscription_payment_audit;
DROP POLICY IF EXISTS superadmin_insert_audit ON public.subscription_payment_audit;

CREATE POLICY subscription_payment_audit_select ON public.subscription_payment_audit
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_user_company_id())
         OR (SELECT public.platform_can('companies.read')));

CREATE POLICY subscription_payment_audit_insert ON public.subscription_payment_audit
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.platform_can('billing.manage')));

-- A billing row may be edited, not re-attributed.
--
-- The three policies above carry no company term at all: `billing.manage`
-- decides, and the row's own company_id is not part of the predicate. That is
-- right for reading and for the acts the audited RPCs perform, but it left an
-- UPDATE free to point an existing subscription or invoice at a different
-- company — re-attributing money raised for one customer to another, with
-- nothing in the row to show it happened. matrix.sql recorded it as M = YY.
--
-- A policy cannot express this rule: WITH CHECK sees the new row and never the
-- old one, so "company_id is what it already was" is not statable there. It is
-- a trigger, the instrument fahrtenbuch_trips already uses for its immutable
-- columns, and like that one it binds every writer — the service role and the
-- billing RPCs included. None of them changes company_id: 20260916130000 keys
-- mark-paid, mark-unpaid and cancel by the invoice's own company, and nothing
-- in the repository updates company_subscriptions at all.
--
-- subscription_payment_audit needs no trigger: it has no UPDATE policy, so
-- there is no path to move one of its rows, and the matrix records its U, D and
-- M cells as refused for every principal, the platform account included.

CREATE OR REPLACE FUNCTION public.pin_billing_company_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION
      '%: company_id is fixed when the row is written. A billing record belongs to the company it was raised for — issue a new one rather than re-pointing this one.',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$fn$;

-- Fired by a trigger, never called: triggers do not check EXECUTE.
REVOKE ALL ON FUNCTION public.pin_billing_company_id()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS pin_billing_company_id ON public.company_subscriptions;
CREATE TRIGGER pin_billing_company_id
  BEFORE UPDATE ON public.company_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.pin_billing_company_id();

DROP TRIGGER IF EXISTS pin_billing_company_id ON public.subscription_invoices;
CREATE TRIGGER pin_billing_company_id
  BEFORE UPDATE ON public.subscription_invoices
  FOR EACH ROW EXECUTE FUNCTION public.pin_billing_company_id();

-- The price list every signed-in screen reads and only pricing.manage writes.
DROP POLICY IF EXISTS authenticated_read_plans ON public.subscription_plans;
DROP POLICY IF EXISTS superadmin_insert_plans  ON public.subscription_plans;
DROP POLICY IF EXISTS superadmin_update_plans  ON public.subscription_plans;
DROP POLICY IF EXISTS superadmin_delete_plans  ON public.subscription_plans;

CREATE POLICY subscription_plans_select ON public.subscription_plans
  FOR SELECT TO authenticated USING (true);

CREATE POLICY subscription_plans_insert ON public.subscription_plans
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.platform_can('pricing.manage')));

CREATE POLICY subscription_plans_update ON public.subscription_plans
  FOR UPDATE TO authenticated
  USING ((SELECT public.platform_can('pricing.manage')))
  WITH CHECK ((SELECT public.platform_can('pricing.manage')));

CREATE POLICY subscription_plans_delete ON public.subscription_plans
  FOR DELETE TO authenticated
  USING ((SELECT public.platform_can('pricing.manage')));

-- The document category catalogue: one list for every company, part of the
-- product's configuration.
DROP POLICY IF EXISTS "Authenticated users can view document_categories" ON public.document_categories;
DROP POLICY IF EXISTS "Super admins can insert document_categories"      ON public.document_categories;
DROP POLICY IF EXISTS "Super admins can update document_categories"      ON public.document_categories;
DROP POLICY IF EXISTS "Super admins can delete document_categories"      ON public.document_categories;

CREATE POLICY document_categories_select ON public.document_categories
  FOR SELECT TO authenticated USING (true);

CREATE POLICY document_categories_insert ON public.document_categories
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.platform_can('settings.manage')));

CREATE POLICY document_categories_update ON public.document_categories
  FOR UPDATE TO authenticated
  USING ((SELECT public.platform_can('settings.manage')))
  WITH CHECK ((SELECT public.platform_can('settings.manage')));

CREATE POLICY document_categories_delete ON public.document_categories
  FOR DELETE TO authenticated
  USING ((SELECT public.platform_can('settings.manage')));

-- The member-facing half of discount_code_redemptions, onto the shell helper.
-- Its platform policy ("SuperAdmins can view all redemptions") already asks
-- codes.manage since 20260916110010 and is left alone.
DROP POLICY IF EXISTS "Company members can view own redemptions" ON public.discount_code_redemptions;

CREATE POLICY discount_code_redemptions_select ON public.discount_code_redemptions
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_user_company_id()));

-- ─── 5. The planning RPCs ask the active-company helper ─────────────────────
--
-- Rewritten from the catalogue rather than retyped: these five functions carry
-- the planning and Fahrtenbuch rules, and a hand-copied body is how one of them
-- silently loses a clause. Exactly one fragment changes in each —
--
--     SELECT company_id INTO v_company FROM user_profiles WHERE user_id = …;
--  -> SELECT public.get_active_company_id() INTO v_company;
--
-- — and each function's own "caller has no company" branch then refuses a
-- suspended, rejected, unapproved or unsubscribed company, and a deactivated,
-- suspended or inactive user, exactly as the policies do.

DO $mig$
DECLARE
  v_sig     text;
  v_def     text;
  v_new     text;
  v_changed int := 0;
  -- The fragment as every one of the five writes it, in one or several lines.
  v_pattern constant text :=
    'SELECT\s+company_id\s+INTO\s+(v_company|v_caller_company)\s+FROM\s+(public\.)?user_profiles\s+WHERE\s+user_id\s*=\s*(v_caller|v_caller_id)\s*;';
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.apply_monthly_planning_run(jsonb)',
    'public.replace_monthly_planning_run(jsonb, uuid)',
    'public.delete_or_archive_monthly_planning_run(uuid)',
    'public.purge_old_monthly_planning_runs(integer, integer)',
    'public.reassign_fahrtenbuch_trip(uuid, uuid, text, text, text, text)'
  ]
  LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION '3.3: % does not exist', v_sig;
    END IF;

    v_def := pg_get_functiondef(to_regprocedure(v_sig));
    v_new := regexp_replace(v_def, v_pattern,
                            'SELECT public.get_active_company_id() INTO \1;', 'g');

    IF v_new = v_def THEN
      RAISE EXCEPTION '3.3: % does not read the company the way this migration expects — read its body before changing this', v_sig;
    END IF;

    EXECUTE v_new;
    v_changed := v_changed + 1;
  END LOOP;

  IF v_changed <> 5 THEN
    RAISE EXCEPTION '3.3: rewrote % planning functions, expected 5', v_changed;
  END IF;
  RAISE NOTICE '3.3: % planning functions now read get_active_company_id()', v_changed;
END $mig$;

-- ─── 5b. …and so do the three Gehaltsquittung RPCs ──────────────────────────
--
-- The same rewrite at the one other door a SECURITY DEFINER function opens for
-- a write, and the door money goes through: a confirmation writes a gapless GQ
-- receipt, a salary_payments row and an outgoing cash_movements row. One
-- fragment each —
--
--     v_company uuid := get_user_company_id();
--  -> v_company uuid := public.get_active_company_id();
--
-- — and their existing `IF v_caller IS NULL OR v_company IS NULL OR NOT
-- current_role_permits('salaries', true)` branch then refuses a blocked account
-- or company with 42501 'Keine Berechtigung' (HINT not_authorized), which is
-- what the screens already show. current_role_permits() reads the role matrix
-- and nothing about state, so before this the state boundary stopped short of
-- exactly the path that moves cash. Nothing else in these bodies is touched:
-- the integer-cent arithmetic, the lock order and every `FOR NO KEY UPDATE`
-- come back byte for byte from the catalogue.
--
-- It also puts the RPC and the bucket back in step: section 7 moves the
-- salary-receipts storage policies to the same helper, and
-- attach_salary_cash_receipt_signed_copy validates the path against v_company.
--
-- redeem_activation_code is deliberately NOT in this list: it is the way *out*
-- of a blocked state — a company whose subscription lapsed redeems a code to
-- get it back — and the active helper would answer NULL for precisely the
-- caller who needs it. It keeps reading the caller's membership from
-- user_profiles, as 20260916130020 wrote it, and tests/rls/tenant-state.sql
-- section 4 pins that it still answers a suspended company's administrator.

DO $mig$
DECLARE
  v_sig     text;
  v_def     text;
  v_new     text;
  v_changed int := 0;
  -- The fragment as all three write it, in the DECLARE block and nowhere else.
  v_pattern constant text :=
    'v_company\s+uuid\s*:=\s*(?:public\.)?get_user_company_id\(\)\s*;';
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.confirm_salary_cash_payment(uuid, uuid, numeric, date, text)',
    'public.void_salary_cash_receipt(uuid, text)',
    'public.attach_salary_cash_receipt_signed_copy(uuid, text)'
  ]
  LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION '3.3: % does not exist', v_sig;
    END IF;

    v_def := pg_get_functiondef(to_regprocedure(v_sig));
    v_new := regexp_replace(v_def, v_pattern,
                            'v_company uuid := public.get_active_company_id();', 'g');

    IF v_new = v_def THEN
      RAISE EXCEPTION '3.3: % does not read the company the way this migration expects — read its body before changing this', v_sig;
    END IF;
    -- A second reader of the membership would leave half the function on the
    -- old rule, which is worse than leaving all of it there.
    IF v_new ~ 'get_user_company_id' THEN
      RAISE EXCEPTION '3.3: % reads get_user_company_id() somewhere else too — read its body before changing this', v_sig;
    END IF;

    EXECUTE v_new;
    v_changed := v_changed + 1;
  END LOOP;

  IF v_changed <> 3 THEN
    RAISE EXCEPTION '3.3: rewrote % Gehaltsquittung functions, expected 3', v_changed;
  END IF;
  RAISE NOTICE '3.3: % Gehaltsquittung functions now read get_active_company_id()', v_changed;
END $mig$;

/*
  A SECURITY DEFINER function runs as its owner, and on the live databases the
  five planning functions belong to `postgres` rather than to the role running
  the migrations (CREATE OR REPLACE keeps the owner). `postgres` holds no
  EXECUTE on get_active_company_id() through PUBLIC, because the grant block
  above revoked it — so without this the rewritten functions would fail at call
  time, inside the planning apply step. Granted to whoever owns them, whatever
  that is here. The loop asks the catalogue rather than a list, so the three
  Gehaltsquittung functions are covered by the same grant, and so is anything a
  later migration rewrites onto the helper.
*/
DO $mig$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT ro.rolname
      FROM pg_proc p
      JOIN pg_roles ro ON ro.oid = p.proowner
     WHERE p.prosecdef
       AND p.prosrc ~ 'get_active_company_id'
       AND NOT ro.rolsuper
       AND NOT has_function_privilege(ro.oid, 'public.get_active_company_id()', 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.get_active_company_id() TO %I', r.rolname);
    RAISE NOTICE '3.3: granted EXECUTE on get_active_company_id() to %', r.rolname;
  END LOOP;
END $mig$;

-- ─── 6. The profile guard: a blocked account changes nobody's status ────────
--
-- The last state rule the policies cannot reach. `user_profiles` is part of the
-- account shell, so its policies are not state-gated — a suspended company's
-- owner still reads its own row, and an invited employee still completes the
-- invitation. That left one hole, which `tests/rls/matrix.sql` recorded as
-- HOLE[3.3]: the guard's company-admin exceptions asked only for the role, so a
-- deactivated administrator could set its own status back to `active` and walk
-- straight back in.
--
-- The body below is 20260916110010's, with one clause added to each of the two
-- company-admin exceptions: the caller's own account must be usable, by the
-- same list get_active_company_id() applies. Everything else is unchanged —
-- the platform exceptions, the invitation transition (`pending_invite` ->
-- `active` on one's own row, where the caller is by definition not active
-- yet), and the service role, GoTrue and migrations, which carry no end user's
-- JWT and stay unguarded.

CREATE OR REPLACE FUNCTION public.enforce_user_profile_privilege_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  caller_uid       uuid := auth.uid();
  caller_jwt_role  text := auth.role();
  caller_company   uuid;
  caller_role_text text;
  caller_status    text;
  caller_platform  text;
  staff_flag       boolean;
  -- The statuses AuthContext.userStatusBlockReason() blocks. `pending_invite`
  -- is not one of them, here as in get_active_company_id().
  c_blocked        CONSTANT text[] := ARRAY['inactive', 'suspended', 'deactivated'];
BEGIN
  -- Unguarded: the service role, GoTrue and migrations, none of which carries
  -- an end user's JWT.
  IF caller_uid IS NULL AND coalesce(caller_jwt_role, '') NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- A JWT without a subject (the anon key) writes no profile at all. RLS
  -- already refuses its direct writes; this also holds inside a SECURITY
  -- DEFINER function anon can reach, where RLS does not apply and every rule
  -- below would otherwise compare against a NULL caller.
  IF caller_uid IS NULL THEN
    RAISE EXCEPTION 'Not allowed: a request without a signed-in user cannot write profiles';
  END IF;

  -- A profile belongs to one account for good. Checked first, so the rules
  -- below cannot be judged against an account the row is being moved to.
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Not allowed: cannot change user_id';
  END IF;

  -- The platform flag follows platform_staff. A JWT may set it only to what
  -- that table already says, which is what the sync trigger's own update does.
  staff_flag := app_private.platform_staff_role_of(NEW.user_id) IS NOT NULL;
  IF TG_OP = 'INSERT' THEN
    IF coalesce(NEW.is_super_admin, false) AND NOT staff_flag THEN
      RAISE EXCEPTION 'Not allowed: cannot self-assign super admin';
    END IF;
  ELSIF coalesce(NEW.is_super_admin, false) IS DISTINCT FROM coalesce(OLD.is_super_admin, false)
        AND coalesce(NEW.is_super_admin, false) IS DISTINCT FROM staff_flag THEN
    RAISE EXCEPTION 'Not allowed: cannot modify is_super_admin';
  END IF;

  -- No JWT moves a profile between companies, a platform account's included.
  IF TG_OP = 'UPDATE' AND NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Not allowed: cannot change company assignment';
  END IF;

  SELECT company_id, role, status
    INTO caller_company, caller_role_text, caller_status
    FROM public.user_profiles
   WHERE user_id = caller_uid
   LIMIT 1;

  caller_platform := app_private.platform_staff_role_of(caller_uid);

  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id <> caller_uid
       AND NOT app_private.platform_role_can(caller_platform, 'company_users.manage') THEN
      RAISE EXCEPTION 'Not allowed: cannot insert profile for another user';
    END IF;

    -- NULL or the caller's own company; no platform exception any more.
    IF NEW.company_id IS NOT NULL
       AND NEW.company_id IS DISTINCT FROM caller_company THEN
      RAISE EXCEPTION 'Not allowed: cannot insert profile for another company';
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- role / role_id can be changed by:
    --   * a platform account holding company_users.manage
    --   * a company admin, whose own account is usable, on a target profile in
    --     the SAME company that is not a platform account (no staff row, a
    --     disabled one included)
    -- coalesce(): for a caller without a company the comparison is NULL, and
    -- NOT NULL let the whole condition fall through without raising.
    IF (NEW.role_id IS DISTINCT FROM OLD.role_id
        OR NEW.role     IS DISTINCT FROM OLD.role)
       AND NOT app_private.platform_role_can(caller_platform, 'company_users.manage')
       AND NOT coalesce(
            caller_role_text = 'admin'
            AND NOT (caller_status = ANY (c_blocked))
            AND OLD.company_id IS NOT NULL
            AND OLD.company_id = caller_company
            AND NEW.company_id = caller_company
            AND NOT app_private.oauth_account_is_platform_staff(OLD.user_id),
            false)
    THEN
      RAISE EXCEPTION 'Not allowed: cannot change role assignment';
    END IF;

    -- status can be changed by:
    --   * a platform account holding company_users.manage or companies.lifecycle
    --   * a company admin, whose own account is usable, on a target profile in
    --     the SAME company that is not a platform account (no staff row, a
    --     disabled one included)
    --   * the user themselves, but ONLY to complete the invite flow
    --     ('pending_invite' -> 'active', SetPasswordPage.tsx)
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT app_private.platform_role_can(caller_platform, 'company_users.manage')
       AND NOT app_private.platform_role_can(caller_platform, 'companies.lifecycle')
       AND NOT coalesce(
            caller_role_text = 'admin'
            AND NOT (caller_status = ANY (c_blocked))
            AND OLD.company_id IS NOT NULL
            AND OLD.company_id = caller_company
            AND NOT app_private.oauth_account_is_platform_staff(OLD.user_id),
            false)
       AND NOT coalesce(
            OLD.user_id = caller_uid
            AND OLD.status = 'pending_invite'
            AND NEW.status = 'active',
            false)
    THEN
      RAISE EXCEPTION 'Not allowed: cannot change account status';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$fn$;

ALTER FUNCTION public.enforce_user_profile_privilege_guard() OWNER TO CURRENT_USER;

-- Fired by a trigger, never called: triggers do not check EXECUTE. Restated so
-- this migration's self-check does not depend on an earlier one.
REVOKE ALL ON FUNCTION public.enforce_user_profile_privilege_guard()
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 7. Storage: the signed Gehaltsquittung copies ──────────────────────────
-- Same rule as the receipts themselves. The older buckets' policies predate the
-- schema fixture, so a change to them could not be proved by the RLS kit; they
-- are 3.4's, which routes file access through platform-file-url.

DO $mig$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE '3.3: storage.objects is not present — skipping the bucket policies';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS "salary_receipts_select" ON storage.objects;
  DROP POLICY IF EXISTS "salary_receipts_insert" ON storage.objects;
  DROP POLICY IF EXISTS "salary_receipts_update" ON storage.objects;

  CREATE POLICY "salary_receipts_select"
    ON storage.objects FOR SELECT TO authenticated
    USING (
      bucket_id = 'salary-receipts'
      AND (storage.foldername(name))[1] = (SELECT public.get_active_company_id())::text
    );

  CREATE POLICY "salary_receipts_insert"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (
      bucket_id = 'salary-receipts'
      AND (storage.foldername(name))[1] = (SELECT public.get_active_company_id())::text
      AND (SELECT public.current_role_permits('salaries', true))
    );

  CREATE POLICY "salary_receipts_update"
    ON storage.objects FOR UPDATE TO authenticated
    USING (
      bucket_id = 'salary-receipts'
      AND (storage.foldername(name))[1] = (SELECT public.get_active_company_id())::text
      AND (SELECT public.current_role_permits('salaries', true))
    )
    WITH CHECK (
      bucket_id = 'salary-receipts'
      AND (storage.foldername(name))[1] = (SELECT public.get_active_company_id())::text
      AND (SELECT public.current_role_permits('salaries', true))
    );
END $mig$;

-- ─── 8. Self-check ──────────────────────────────────────────────────────────

DO $mig$
DECLARE
  v_wrong text;
  v_n     int;
BEGIN
  -- 1. The three helpers: SECURITY DEFINER where it matters, a pinned
  --    search_path everywhere, and exactly the stated grants.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ') INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig))
                    IS DISTINCT FROM v.secdef
                 THEN 'SECURITY DEFINER should be ' || v.secdef
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE')
                 THEN 'anon still holds EXECUTE'
               WHEN NOT has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE')
                 THEN 'authenticated needs EXECUTE — every policy calls it'
             END AS problem
        FROM (VALUES
          ('public.get_active_company_id()',        true),
          ('public.platform_reads_company_data()',  false),
          ('public.platform_writes_company_data()', false)
        ) AS v(sig, secdef)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.3 self-check: %', v_wrong;
  END IF;

  -- 2. The write seam is closed. 3.4 is the release that opens it, and it will
  --    have to change this line with the body.
  IF public.platform_writes_company_data() IS NOT FALSE THEN
    RAISE EXCEPTION '3.3 self-check: platform_writes_company_data() is not false — a staff role would write tenant data without a support session';
  END IF;

  -- 3. No policy decides anything by "is this account platform staff" any more.
  --    The column itself was closed by 20260916110010; this closes the function
  --    built on it, which answers true for every role alike.
  SELECT string_agg(format('%s.%s "%s"', p.schemaname, p.tablename, p.policyname), ', '
                    ORDER BY p.tablename, p.policyname) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname IN ('public', 'storage')
     AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'is_user_super_admin';

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.3 self-check: policies still read is_user_super_admin(): %', v_wrong;
  END IF;

  -- 3b. …and neither does any function a policy calls. The check above is one
  --     indirection short, and that is where the term actually lived:
  --     current_role_permits() opened with `is_user_super_admin() OR …` and
  --     gates ten business tables and three storage policies, so "no policy
  --     reads it" was true of the policy text and false of what the policy
  --     evaluates. Section 1 rewrote that body; this makes the claim checkable.
  --
  --     One level, deliberately: it is exactly the vocabulary the policies
  --     themselves name, and a deeper walk would need a recursive CTE over a
  --     call graph nothing else in this schema models. A function that is not
  --     named in any policy is out of scope here — create_user_profile_manual
  --     still guards itself with the function, and should.
  SELECT string_agg(DISTINCT f.proname::text, ', ') INTO v_wrong
    FROM (
      SELECT (regexp_matches(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''),
                             '([a-z_][a-z0-9_]*)\s*\(', 'g'))[1] AS name
        FROM pg_policies p
       WHERE p.schemaname IN ('public', 'storage')
    ) c
    JOIN pg_proc f      ON f.proname = c.name
    JOIN pg_namespace n ON n.oid = f.pronamespace
   WHERE n.nspname = 'public'
     AND f.prosrc ~ 'is_user_super_admin';

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.3 self-check: a function called from a policy still reads is_user_super_admin(): %', v_wrong;
  END IF;

  -- 4. Every capability a policy names exists in the matrix. A typo would deny
  --    silently, for everyone, which is the one failure nobody reports.
  SELECT string_agg(DISTINCT c.name, ', ') INTO v_wrong
    FROM (
      SELECT (regexp_matches(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''),
                             'platform_(?:role_)?can\((?:[a-z_]+, *)?''([a-z_.]+)''', 'g'))[1] AS name
        FROM pg_policies p
      UNION ALL
      SELECT (regexp_matches(p.prosrc, 'platform_(?:role_)?can\((?:[a-z_]+, *)?''([a-z_.]+)''', 'g'))[1]
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    ) c
   WHERE c.name NOT IN (SELECT m.capability FROM app_private.platform_capability_matrix() m);

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.3 self-check: unknown capability named: %', v_wrong;
  END IF;

  -- 5. Every business table carries the canonical set and nothing else: one
  --    policy per command it admits, all of them reading get_active_company_id.
  SELECT string_agg(format('%s (%s)', s.tbl, s.problem), '; ') INTO v_wrong
    FROM (
      SELECT v.tbl,
             CASE
               WHEN to_regclass('public.' || v.tbl) IS NULL THEN NULL   -- absent: section 2 skipped it
               WHEN (SELECT count(*) FROM pg_policies p
                      WHERE p.schemaname = 'public' AND p.tablename = v.tbl)
                    <> length(v.ops)
                 THEN 'should have exactly ' || length(v.ops) || ' policies'
               WHEN EXISTS (SELECT 1 FROM pg_policies p
                             WHERE p.schemaname = 'public' AND p.tablename = v.tbl
                               AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''))
                                   !~ 'get_active_company_id')
                 THEN 'a policy does not read get_active_company_id()'
             END AS problem
        FROM (VALUES
          ('receipts', 'SIUD'), ('income', 'SIUD'), ('drivers', 'SIUD'), ('cars', 'SIUD'),
          ('fixed_costs', 'SIUD'), ('salaries', 'SIUD'), ('salary_payments', 'SIUD'),
          ('werkstatt_checks', 'SIUD'), ('driver_notes', 'SIUD'), ('documents', 'SIUD'),
          ('car_driver_assignments', 'SIUD'), ('cash_transactions', 'SIUD'),
          ('document_templates', 'SIUD'), ('company_planning_runs', 'SIUD'),
          ('company_planning_run_blocks', 'SIUD'), ('monthly_planning_manual_exceptions', 'SIUD'),
          ('planning_finalizations', 'SIUD'), ('planning_run_adjustments', 'SIUD'),
          ('historical_reconciliations', 'SIUD'), ('historical_block_adjustments', 'SIUD'),
          ('historical_driver_hour_targets', 'SIUD'), ('historical_payroll_targets', 'SIUD'),
          ('historical_time_adjustments', 'SIUD'), ('historical_wh_saved_plans', 'SIUD'),
          ('saved_stundennachweise', 'SIUD'), ('fahrtenbuch_imports', 'SIUD'),
          ('fahrtenbuch_trips', 'SID'), ('fahrtenbuch_assignment_audit', 'SI'),
          ('notification_settings', 'SIU'), ('cash_movements', 'S'), ('salary_cash_receipts', 'S'),
          ('document_blocks', 'SIUD'), ('document_variables', 'SIUD'),
          ('historical_reconciliation_drivers', 'SIUD'),
          ('historical_reconciliation_results', 'SIUD'),
          ('historical_reconciliation_wh_drivers', 'SIUD')
        ) AS v(tbl, ops)
    ) s
   WHERE s.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.3 self-check: %', v_wrong;
  END IF;

  -- 6. fahrtenbuch_trips has no UPDATE policy. The trigger refuses the columns
  --    that matter, but the assignment columns are mutable, and every write to
  --    them must go through an audited RPC. 20260908113000 closed this once.
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'fahrtenbuch_trips' AND cmd = 'UPDATE') THEN
    RAISE EXCEPTION '3.3 self-check: fahrtenbuch_trips has an UPDATE policy again — trips are append-only and are written by RPC';
  END IF;

  -- 7. The five planning RPCs read the helper and no longer read the profile
  --    row for the company.
  SELECT count(*) INTO v_n
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('apply_monthly_planning_run', 'replace_monthly_planning_run',
                       'delete_or_archive_monthly_planning_run', 'purge_old_monthly_planning_runs',
                       'reassign_fahrtenbuch_trip')
     AND p.prosrc ~ 'get_active_company_id'
     AND p.prosrc !~ 'SELECT\s+company_id\s+INTO';

  IF v_n <> 5 THEN
    RAISE EXCEPTION '3.3 self-check: % of 5 planning functions read get_active_company_id()', v_n;
  END IF;

  --    And the three Gehaltsquittung RPCs, the one other place where a SECURITY
  --    DEFINER function decides a company for a write — and the place that
  --    writes money. None of the three may still read the membership helper:
  --    half a function on each rule is worse than all of it on the old one.
  SELECT count(*) INTO v_n
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('confirm_salary_cash_payment', 'void_salary_cash_receipt',
                       'attach_salary_cash_receipt_signed_copy')
     AND p.prosrc ~ 'get_active_company_id'
     AND p.prosrc !~ 'get_user_company_id';

  IF v_n <> 3 THEN
    RAISE EXCEPTION '3.3 self-check: % of 3 Gehaltsquittung functions read get_active_company_id()', v_n;
  END IF;

  -- 8. The owner of every SECURITY DEFINER function that calls the helper can
  --    actually call it. This is the failure that only shows up at run time.
  SELECT string_agg(p.oid::regprocedure::text || ' owned by ' || ro.rolname, ', ') INTO v_wrong
    FROM pg_proc p
    JOIN pg_roles ro ON ro.oid = p.proowner
   WHERE p.prosecdef
     AND p.prosrc ~ 'get_active_company_id'
     AND NOT has_function_privilege(ro.oid, 'public.get_active_company_id()', 'EXECUTE');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.3 self-check: cannot call get_active_company_id(): %', v_wrong;
  END IF;

  -- 9. The guard's company-admin exceptions ask whether the caller's own
  --    account is usable, so a deactivated administrator cannot set its own
  --    status back to active.
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'public.enforce_user_profile_privilege_guard()'::regprocedure) !~ 'c_blocked' THEN
    RAISE EXCEPTION '3.3 self-check: the profile guard does not ask whether the caller''s own account is usable';
  END IF;

  -- 10. The two attribution clauses survived the rebuild. Neither table has a
  --     role gate on INSERT, so the clause pinning the new row to auth.uid() is
  --     the only thing that stops one member of a company filing an import — or
  --     the record of who reassigned a trip — in a colleague's name. This is a
  --     structural check because the behaviour is invisible to matrix.sql,
  --     whose INSERT probes supply the caller's own id either way;
  --     tests/rls/tenant-state.sql section 2b probes it from both sides.
  SELECT string_agg(v.tbl || '.' || v.col, ', ') INTO v_wrong
    FROM (VALUES
      ('fahrtenbuch_imports',          'imported_by'),
      ('fahrtenbuch_assignment_audit', 'changed_by')
    ) AS v(tbl, col)
   WHERE to_regclass('public.' || v.tbl) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname = 'public' AND p.tablename = v.tbl
                        AND p.cmd = 'INSERT'
                        AND coalesce(p.with_check, '') ~ ('\m' || v.col || '\M\s*=\s*auth\.uid\(\)'));

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.3 self-check: the INSERT policy no longer pins the row to its author: %', v_wrong;
  END IF;

  -- 11. A billing row cannot be re-attributed. These two policies carry no
  --     company term, so the trigger is the only thing holding an invoice to
  --     the company it was raised for.
  SELECT string_agg(v.tbl, ', ') INTO v_wrong
    FROM (VALUES ('company_subscriptions'), ('subscription_invoices')) AS v(tbl)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t
                      WHERE t.tgrelid = ('public.' || v.tbl)::regclass
                        AND t.tgname = 'pin_billing_company_id'
                        AND NOT t.tgisinternal);

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.3 self-check: company_id is not pinned on %', v_wrong;
  END IF;

  -- 12. The service role holds neither seam. Both are SECURITY INVOKER wrappers
  --     around platform_can(), which it may not execute, so a grant here would
  --     advertise a path that raises 42501 instead of answering false.
  IF has_function_privilege('service_role', 'public.platform_reads_company_data()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.platform_writes_company_data()', 'EXECUTE') THEN
    RAISE EXCEPTION '3.3 self-check: the service role holds EXECUTE on a seam it cannot answer';
  END IF;

  RAISE NOTICE '3.3 self-check: passed';
END $mig$;
