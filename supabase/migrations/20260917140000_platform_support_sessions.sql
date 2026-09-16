/*
  # Support sessions: a platform account reaches one company, for an hour, and
    writes only inside a support session (plan 3.C, slice 3.4a)

  ## What this closes

  3.3 (20260917130000) put every tenant table on one shape and closed the write
  side, but left the read side exactly as it was, with the owner's explicit
  approval: `platform_reads_company_data()` answered
  `platform_can('business.read')`, so any staff role holding that capability
  read **every** company's Fahrtenbuch, planning, historical, cash-ledger and
  receipt data, with no audit row and no session. matrix.sql recorded it as
  HOLE[3.4]. This file is what closes it.

  After this migration a platform account reaches a company's **operational**
  data — the tables a tenant works in — only while it holds an open **context**
  on that company:

    view      60 minutes, no reason, reads only
    support   60 minutes, a mandatory reason, reads and writes

  That is the concession's scope and no more. The account shell is a capability
  and not a session, exactly as 20260917130000 left it: `companies`,
  `company_settings`, the subscription tables and the profile and role writes
  that `company_users.manage` grants still act across companies with no context
  and no audit row. Those are residual, they are recorded as such in
  tests/rls/matrix.sql, and narrowing them is 3.4c's and 3.13's, not this
  file's.

  ## The design decision, and why it is this one

  The two seams 3.3 left are booleans with no company argument, so on their own
  they cannot confine anything: `… OR (SELECT platform_reads_company_data())`
  opens every row the moment it is true. Confinement has to come from a term
  that names a company, and there is exactly one in every tenant policy:

      company_id = (SELECT public.get_active_company_id())

  So the context is answered **there**. `get_active_company_id()` — and
  `get_user_company_id()`, which is the same term for the account shell —
  returns the open context's company for a company-less platform account, and
  every one of the ~150 policies 3.3 wrote confines itself, unchanged. That is
  plan 3.C's own answer ("get_user_company_id() و get_active_company_id()
  بيرجّعوا شركة جلسة الدعم للموظف"), and it is why 3.3 was worth writing: no
  policy is rewritten here, and tenant isolation is not re-derived.

  The alternative — giving the policies a new company-aware function and
  rewriting them — was rejected: rewriting 150 tenant policies twice in two
  days is how isolation breaks, and the seam would still have to be neutralised
  anyway.

  **What the seams become, and why they are now constants.** Both answer
  `false`. `platform_reads_company_data()` must, or the confinement above is
  undone by the OR next to it; `platform_writes_company_data()` must, because
  it too sits in an OR and a `true` there would let a support session write
  *any* company's rows, which is the opposite of what it is for. The seam that
  actually carries 3.4's rule is the tenant term. Both are left in place, as
  named constants with self-checks, rather than removed from the policies: the
  policies are 3.3's text, and this slice does not touch them.

  **The read/write split cannot live in that term**, because the same term is
  the USING of a SELECT and the WITH CHECK of an INSERT. Three instruments
  carry it instead:

  1. `current_role_permits()` and `is_company_admin()` answer true for a
     company-less staff account **only inside a support session**. That is the
     gate of the ten role-gated tables, of the four administrator-gated ones,
     of the salary-receipts storage policies and of the three Gehaltsquittung
     RPCs.
  2. A **statement-level** BEFORE INSERT/UPDATE/DELETE trigger on each of 39
     tables — the 36 tenant tables, plus `roles`, `role_permissions` and
     `activation_code_attempts` — refuses a write by a staff account that holds
     a *view* context. On the 36 it closes the ~20 tables 3.3 left with no role
     gate at all (the planning, historical and Fahrtenbuch tables among them);
     on the three shell tables it closes a hole this slice would otherwise have
     opened, because their predicate is
     `company_id = get_user_company_id() AND (…)` and making that term answer
     the opened company completes it.

     What it guards is therefore narrower than "a staff account must not
     write": it is **a write whose company came from the context**. A write
     that names its own company and records itself — the audited platform RPCs
     of 3.5 — is none of its business, which is why `company_settings` is not
     on the list (see the trigger loop). It is
     statement-level, not row-level, because the question is about the caller
     and not about the row: one lookup per statement, not per row, so a
     Fahrtenbuch import of several thousand trips pays it once per batch.
     It stays out of the way of everyone else — it returns immediately for a
     caller with no `auth.uid()` (the service role, GoTrue, migrations), for
     one with no staff row, for a staff account that is also a member of a
     company, and for a staff account with no context at all, whose writes RLS
     already refuses exactly as it did before this file.
  3. `roles.company_id` and `role_permissions.role_id` are pinned after insert.
     `company_users.manage` names no company (3.3's deliberate design), so with
     the shell term now answering the context company, an UPDATE could have
     pulled another company's role row *into* the context company. A policy
     cannot state "the value it already had", so it is a trigger, as
     `pin_billing_company_id` already is for the billing tables.

  ## What ends a context, and what enforces it

    an explicit close      platform_context_close(), closed_reason 'manual'
    expiry                 every read of the context requires
                           expires_at > now(); the row is closed lazily with
                           reason 'expired' by the next open/close and by
                           app_private.platform_contexts_expire()
    the sign-in session     the context carries the JWT's session_id and is
                           answered only to that session, so a new sign-in
                           never inherits it; and the row must still be in
                           auth.sessions and not past not_after, so a sign-out
                           ends it within the same access token's lifetime
    the staff row           every read re-asks platform_staff_role_of() and the
                           capability the mode needs, so disabling or demoting
                           an account ends its context at once; the trigger
                           platform_staff_close_contexts also closes the row,
                           with reason 'staff_disabled', so the table says so

  One context per staff member at a time, held by a partial unique index.

  ## What is deliberately not here

  - **No UI.** The workspace bar and the "enter company" screens are 3.4b.
    Until they land, `SuperAdminContext` opens no context, so the platform
    screens that read tenant tables directly show nothing — which is the
    concession being withdrawn, not a regression.
  - **No storage.** `platform-file-url` and the older buckets' policies are the
    file half of plan 3.C; the RLS kit cannot see those policies (the fixture
    is a --schema=public dump), so they are not changed blind here.
  - **No write-audit triggers.** Auditing each write a support session makes is
    slice 3.4c, and the refusal trigger this file installs is where they will
    go.
  - **No grant is widened or narrowed.** Every function redefined here keeps the
    EXECUTE list its own migration left it, restated next to the definition so a
    CREATE OR REPLACE cannot drop one. Two of them, `is_company_admin()` and
    `current_role_permits()`, have held an explicit anon grant since they were
    created — `REVOKE … FROM PUBLIC` never removed the one Supabase's default
    privileges give anon by name — and that is left alone: they answer false to
    a caller without a subject (the self-check proves it), no policy applies TO
    anon, and taking it away here would move a matrix cell that has nothing to
    do with support sessions.

  - **`platform_audit_record` is not redefined.** Its allow-list
    (`app_private.platform_edge_audit_actions()`, 20260916150000) already
    refuses every action outside the list the edge functions send, which is
    stricter than a reserved namespace — so `platform_context.*` is refused
    there already. Redefining that function to add a namespace would risk
    dropping one of its two rules, which is exactly how 20260916140000 reopened
    it. The self-check below asserts the refusal instead.

  ## Compatibility — this does NOT bump deploy/SCHEMA_EPOCH

  Every object here is additive or a body replacement, nothing is dropped, no
  column changes meaning and no data is rewritten. A company user, the service
  role and every edge function see exactly what they saw before: the helpers'
  extra branch and the refusal trigger are both reached only by a company-less
  platform account with an open context row.

  Be clear about what a rollback does and does not do, because the tempting
  argument here is wrong: `deploy.sh --activate` puts back code, not function
  bodies, so after a rollback `platform_reads_company_data()` is still false and
  the previous release's platform screens read a tenant's tables and find
  nothing. The concession does not come back with the code that assumed it.

  No bump all the same, for two reasons that hold. 20260917130000 already moved
  the epoch from 1 to 2, and 3.3 and 3.4 ship to production as one release, so
  no rollback can land between them. And on staging, where they can be released
  apart, the state after a rollback across this file is no worse than the state
  the branch is deployed in: staff screens that read tenant data directly show
  nothing either way until 3.4b gives them a context to open.
*/

-- ─── 1. The contexts table ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_private.platform_company_contexts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE CASCADE: a deleted account takes its contexts with it, the way
  -- platform_staff does.
  staff_user_id uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id    uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  mode          text        NOT NULL CHECK (mode IN ('view', 'support')),
  -- A support session says why, in the words of the person who opened it. A
  -- read-only view carries no reason: there is nothing to justify.
  reason        text        NULL CHECK (length(reason) <= 500),
  -- auth.sessions.id from the JWT that opened it. NOT NULL, and the only key
  -- the context is answered to, so a second sign-in never inherits it.
  session_id    uuid        NOT NULL,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  closed_at     timestamptz NULL,
  closed_reason text        NULL CHECK (closed_reason IN ('manual','expired','superseded','staff_disabled')),
  CONSTRAINT platform_context_reason_iff_support CHECK ((mode = 'support') = (reason IS NOT NULL)),
  CONSTRAINT platform_context_closed_pair        CHECK ((closed_at IS NULL) = (closed_reason IS NULL)),
  CONSTRAINT platform_context_expires_after_open CHECK (expires_at > opened_at)
);

-- One open context per staff member, whatever the company. An expired row that
-- nothing has closed still counts as open here; platform_context_open() closes
-- those first, so the index states the rule and the RPC keeps it satisfiable.
CREATE UNIQUE INDEX IF NOT EXISTS platform_company_contexts_one_open
  ON app_private.platform_company_contexts (staff_user_id)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS platform_company_contexts_company
  ON app_private.platform_company_contexts (company_id, opened_at);

COMMENT ON TABLE app_private.platform_company_contexts IS
  'Plan 3.C: the company one platform account has open, in mode view (read) or '
  'support (read and write, with a reason), for 60 minutes, tied to the JWT '
  'session that opened it. get_active_company_id() answers from here.';

-- ─── 2. Reading the current context ─────────────────────────────────────────

/*
  The JWT's session_id, or NULL. PostgREST puts the verified claims in
  request.jwt.claims; the RLS kit and assertions.sql use the singular form, as
  auth.uid() does. Anything malformed is NULL rather than an error: a context
  that cannot be identified is simply not open.
*/
CREATE OR REPLACE FUNCTION app_private.jwt_session_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_uuid_pattern CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_claim text;
BEGIN
  v_claim := nullif(current_setting('request.jwt.claim.session_id', true), '');
  IF v_claim IS NULL THEN
    v_claim := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id';
  END IF;
  IF v_claim ~ c_uuid_pattern THEN
    RETURN v_claim::uuid;
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  -- request.jwt.claims that is not valid JSON: no session, not an error.
  RETURN NULL;
END;
$$;

/*
  The caller's open context row, or NULL — every rule that ends a context is
  one of the conditions below, in the order that costs least.

  Written so the statements that could fail on a database without GoTrue's own
  tables are never reached for a caller who has no context row: plpgsql
  prepares a statement the first time it executes it, so `auth.sessions` is
  resolved only where a context actually exists. The RLS kit's files that need
  it stub it (tests/rls/platform-contexts.sql, matrix.sql).
*/
CREATE OR REPLACE FUNCTION app_private.platform_context_row()
RETURNS app_private.platform_company_contexts
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_sid  uuid;
  v_role text;
  v_row  app_private.platform_company_contexts%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  -- Disabling or deleting the staff row ends the context here, before the
  -- trigger that closes it has to have run.
  v_role := app_private.platform_staff_role_of(v_uid);
  IF v_role IS NULL THEN
    RETURN NULL;
  END IF;

  v_sid := app_private.jwt_session_id();
  IF v_sid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_row
    FROM app_private.platform_company_contexts c
   WHERE c.staff_user_id = v_uid
     AND c.session_id = v_sid
     AND c.closed_at IS NULL
     AND c.expires_at > now();

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- The capability the mode needs, re-asked on every read: demoting an account
  -- ends its session as surely as disabling it.
  IF NOT app_private.platform_role_can(
           v_role,
           CASE v_row.mode WHEN 'support' THEN 'support.session' ELSE 'business.read' END) THEN
    RETURN NULL;
  END IF;

  -- …and the sign-in session itself must still be there. A sign-out revokes
  -- the refresh token but leaves the access token valid for its remaining
  -- lifetime, so without this the context would outlive the sign-out.
  IF NOT EXISTS (SELECT 1 FROM auth.sessions s
                  WHERE s.id = v_sid
                    AND s.user_id = v_uid
                    AND (s.not_after IS NULL OR s.not_after > now())) THEN
    RETURN NULL;
  END IF;

  RETURN v_row;
END;
$$;

/*
  The company of the caller's open context, or NULL. `p_require_support` asks
  for the write mode; false accepts either mode, which is what a read needs.
*/
CREATE OR REPLACE FUNCTION app_private.platform_context_company(p_require_support boolean)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row app_private.platform_company_contexts%ROWTYPE;
BEGIN
  v_row := app_private.platform_context_row();
  IF v_row.company_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_require_support AND v_row.mode <> 'support' THEN
    RETURN NULL;
  END IF;
  RETURN v_row.company_id;
END;
$$;

/** Does this account belong to a company? A staff account should not (3.7b). */
CREATE OR REPLACE FUNCTION app_private.account_has_company(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_profiles up
                  WHERE up.user_id = p_user_id AND up.company_id IS NOT NULL);
$$;

-- The two names plan 3.C gives the read and the write mode, for callers that
-- want to ask directly rather than through the tenant term.
CREATE OR REPLACE FUNCTION public.platform_view_company_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT app_private.platform_context_company(false);
$$;

COMMENT ON FUNCTION public.platform_view_company_id() IS
  'The company this platform account has open, in either mode, or NULL. '
  'get_active_company_id() answers from the same place for a company-less '
  'staff account, which is what confines every tenant policy.';

CREATE OR REPLACE FUNCTION public.platform_support_company_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT app_private.platform_context_company(true);
$$;

COMMENT ON FUNCTION public.platform_support_company_id() IS
  'The company this platform account has open in support mode, or NULL. The '
  'one state in which a staff account writes a tenant''s rows.';

-- ─── 3. The tenant term answers the context ─────────────────────────────────

/*
  get_user_company_id(): the account shell's term. Unchanged for every caller
  who has a company; for a company-less account it is now the open context.

  The staff branch is reached only when the profile names no company, so a
  platform account that still sits inside a company (the state plan 3.7b
  removes, and 20260916110000's backfill counts) keeps behaving exactly as it
  does today and its context is simply ineffective. That is deliberate: two
  companies for one caller is not a state any policy here could answer for.
*/
CREATE OR REPLACE FUNCTION public.get_user_company_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_company uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT up.company_id INTO v_company
    FROM public.user_profiles up
   WHERE up.user_id = v_uid
   LIMIT 1;

  IF v_company IS NOT NULL THEN
    RETURN v_company;
  END IF;

  RETURN app_private.platform_context_company(false);
END;
$$;

COMMENT ON FUNCTION public.get_user_company_id() IS
  'The caller''s company, whatever state the account or the company is in, or '
  'for a company-less platform account the company it has opened. The '
  'predicate of the account shell only — companies, company_settings, '
  'user_profiles, roles, role_permissions and the subscription tables. '
  'Business tables use get_active_company_id().';

/*
  get_active_company_id(): the business tables' term. The member half is
  20260917130000's, condition for condition — see that file's header for why
  each one is there. What is added is the same staff branch as above, and it is
  deliberately *not* state-gated: a support session exists to reach a company
  whose subscription lapsed or whose approval was withdrawn, so judging the
  context by the company's own state would refuse exactly the case support is
  for. What the context is judged by instead is the capability, the session and
  the clock, in platform_context_row().
*/
CREATE OR REPLACE FUNCTION public.get_active_company_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_company uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT up.company_id INTO v_company
    FROM public.user_profiles up
    JOIN public.companies c ON c.id = up.company_id
   WHERE up.user_id = v_uid
     AND up.status NOT IN ('inactive', 'suspended', 'deactivated')
     AND c.approval_status = 'approved'
     AND c.status IN ('active', 'trial')
     AND c.subscription_status = 'active'
     AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now())
   LIMIT 1;

  IF v_company IS NOT NULL THEN
    RETURN v_company;
  END IF;

  -- A member whose company or account is blocked keeps answering NULL: the
  -- context is a platform account's door, not a way past the state rules.
  IF app_private.account_has_company(v_uid) THEN
    RETURN NULL;
  END IF;

  RETURN app_private.platform_context_company(false);
END;
$$;

COMMENT ON FUNCTION public.get_active_company_id() IS
  'The company whose business data the caller may act on, or NULL. For a '
  'member: the gates in App.tsx and AuthContext — account status, company '
  'approval, company status and subscription. For a company-less platform '
  'account: the company it has open (plan 3.4). The predicate of every '
  'business table.';

/*
  current_role_permits(): the role gate of ten business tables, of the three
  salary-receipts storage policies and of the three Gehaltsquittung RPCs.

  The member answer is 20260917130000's, byte for byte, and it is computed
  first: a company user never reaches the staff branch, and neither does a
  staff account that is also a member of a company (it is judged by the role on
  its own profile, like everyone else). Only for a company-less platform
  account does the answer become "am I inside a support session" — true for
  every page while one is open, false the moment it is not, which is what makes
  a view context read-only on these ten tables.
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
  'Does the calling user''s role permit view/edit on this page_key? Fails '
  'closed. Being platform staff grants nothing here (20260917130000) — except '
  'inside an open support session, which is the one state in which a '
  'company-less staff account acts on a tenant''s data (20260917140000).';

/*
  is_company_admin(): the administrator gate of notification_settings, of the
  company_settings and roles writes, and of deleting an import or a trip. Same
  shape as above — the member answer first, the support session second.
*/
CREATE OR REPLACE FUNCTION public.is_company_admin()
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

  IF EXISTS (SELECT 1 FROM public.user_profiles up
              WHERE up.user_id = v_uid
                AND up.role = 'admin'
                AND up.company_id IS NOT NULL) THEN
    RETURN true;
  END IF;

  IF app_private.platform_staff_role_of(v_uid) IS NOT NULL
     AND NOT app_private.account_has_company(v_uid) THEN
    RETURN app_private.platform_context_company(true) IS NOT NULL;
  END IF;

  RETURN false;
END;
$$;

COMMENT ON FUNCTION public.is_company_admin() IS
  'An administrator of the caller''s own company — or a platform account '
  'inside an open support session, which acts as one on the company it opened '
  '(20260917140000).';

-- ─── 4. The two seams, now constants ────────────────────────────────────────

/*
  Both seams answer false, and both have to.

  Each sits in an OR next to the tenant term, so a `true` here would widen the
  policy to every company at once — the read seam to every company's rows, the
  write seam to writing them. A boolean with no company argument cannot say
  "…on this company", which is the whole content of 3.4's rule. That rule is
  answered by get_active_company_id() instead, one term to the left.

  They are kept rather than removed because the policies that name them are
  20260917130000's text and this slice rewrites none of it, and because a seam
  pinned to a constant by a self-check is a statement a reader can check.
*/
CREATE OR REPLACE FUNCTION public.platform_reads_company_data()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT false;
$$;

COMMENT ON FUNCTION public.platform_reads_company_data() IS
  'False since 20260917140000. Platform staff read a company''s data through '
  'the tenant term — get_active_company_id() answers the open context''s '
  'company — and through the audited read models, and nowhere else.';

CREATE OR REPLACE FUNCTION public.platform_writes_company_data()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT false;
$$;

COMMENT ON FUNCTION public.platform_writes_company_data() IS
  'False, always. A support session writes through the tenant term and the '
  'role gates, never through this branch, which names no company.';

-- ─── 5. A view context writes nothing ───────────────────────────────────────

/*
  The tenant term cannot tell a read from a write: it is the USING of the
  SELECT policy and the WITH CHECK of the INSERT policy at once. The role gates
  close the fourteen tenant tables that have one; this closes the other
  twenty-two, which 20260917130000 left with no gate at all because a company's
  own viewer writes them.

  And it closes four tables of the account shell, where the gate exists but does
  not help: `roles`, `role_permissions`, `company_settings` and
  `activation_code_attempts` read
  `company_id = get_user_company_id() AND (is_company_admin() OR platform_can(…))`,
  and a capability satisfies the second half for a platform account whatever the
  mode. Only the first half refused it before this file, and only because it was
  NULL — which is precisely what this file changes. See the trigger loop.

  Statement-level, and it returns before doing any work for everyone who is not
  the case it exists for:

    auth.uid() IS NULL      the service role, GoTrue, migrations, psql
    no staff row            every company user, at the cost of one primary-key
                            lookup per statement (not per row)
    a staff account with
    a company               judged by its own profile, as today
    an open support session  the write is what the session is for
    no context at all       the statement goes through and RLS answers it, as
                            it did before this trigger existed

  That last line is about the trigger only, and the file as a whole is not so
  quiet: turning `platform_reads_company_data()` into a constant `false`
  (section 4) took away the rows a staff account with no context could see, so
  a statement that used to match a row and be refused by something downstream
  now matches nothing and is refused by no one. Three of matrix.sql's `guard`
  scenarios moved from T to `.` for exactly that reason — the row is invisible,
  so enforce_user_profile_privilege_guard is never reached. It still refuses
  when it is reached, which the same file now probes from inside a context.

  which leaves precisely one case: a company-less platform account writing
  while it holds a *view* context.

  TRUNCATE is deliberately not among the events: `authenticated` holds no
  TRUNCATE on any of these tables, so there is no path to refuse.
*/
CREATE OR REPLACE FUNCTION app_private.refuse_read_only_context_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;
  IF app_private.platform_staff_role_of(v_uid) IS NULL THEN
    RETURN NULL;
  END IF;
  IF app_private.account_has_company(v_uid) THEN
    RETURN NULL;
  END IF;
  IF app_private.platform_context_company(true) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF app_private.platform_context_company(false) IS NULL THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION
    'Nur-Lese-Ansicht: % auf % ist ohne offene Support-Sitzung nicht möglich.', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001', HINT = 'support_session_required';
END;
$$;

DO $mig$
DECLARE
  v_tbl   text;
  v_count int := 0;
BEGIN
  /*
    The tenant half is **derived, not copied**. Every table 20260917130000 gave
    the tenant shape names get_active_company_id() in its policies — that is
    what the shape *is* — so asking the catalogue for those tables is asking the
    authoritative source directly. A hand-written list here would be a second
    copy of 3.3's, and a table missing from both copies is a table nothing
    notices: the self-check below restated the same literal, so it could only
    ever confirm that the list matched itself.

    It picks up the 31 tables of 3.3 section 2 and the 5 of section 3 (whose
    policies name the helper inside their EXISTS on the parent), and it will
    pick up any tenant table a later migration writes in the same shape, which
    is the property worth having.

    The three shell tables stay literal, because no derivation separates them
    from their neighbours: their predicate is
      company_id = get_user_company_id() AND (is_company_admin() OR platform_can(…))
    and before this file the first conjunct was NULL for a company-less platform
    account, so the write was refused whatever the capability said. Making that
    term answer the opened company completes the predicate and the capability
    supplies the rest — so without a trigger here a *view* context could create
    a role, give it can_edit on every page through role_permissions, and point a
    company's profile at it: three writes, no reason recorded, in the mode that
    is supposed to write nothing. The plan is explicit that a staff member
    writes inside a support session and nowhere else.

    Four other tables carry a company term in 3.3 and deliberately get no
    trigger — discount_code_redemptions, company_subscriptions,
    subscription_invoices and subscription_payment_audit. In each the company
    term is on the SELECT policy only; their writes ask billing.manage with no
    company term at all, or have no write policy. So an open context widens what
    a staff account may *read* there and never what it may write, which is the
    read the workspace exists for. Nothing for this trigger to do.
  */
  FOR v_tbl IN
    -- ::text on both branches: pg_policies.tablename is `name`, the literals
    -- below are text, and a UNION has to agree on a type.
    SELECT DISTINCT p.tablename::text
      FROM pg_policies p
     WHERE p.schemaname = 'public'
       AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'get_active_company_id'
     UNION
    SELECT v.tbl::text
      FROM (VALUES ('roles'), ('role_permissions'), ('activation_code_attempts')) AS v(tbl)
    --
    -- `company_settings` was the fourth and has been taken back out, because
    -- the rule this trigger enforces is narrower than "a staff account must not
    -- write": it is *a write whose company came from the context*. That table
    -- is the one place where the two came apart.
    --
    --   Its UPDATE was never completed by the context. The platform branch of
    --   company_settings_update is `platform_can('companies.lifecycle')` with
    --   no company term at all, so an owner could already edit any tenant's
    --   settings with no context open — matrix.sql records that as YY and tags
    --   it residual for 3.4c/3.13. Only the INSERT is completed by the context,
    --   and only for a role that already holds lifecycle over every company, so
    --   refusing the INSERT while the UPDATE stays open is incoherent.
    --
    --   And the trigger cost more there than it bought. platform_subscription_assign
    --   (20260916130000) ends by setting drivers_per_car_limit on the company
    --   named in its argument. That write is capability-checked (billing.manage),
    --   takes its company from a parameter rather than from any context, and
    --   records itself — it is the audited path CLAUDE.md requires platform
    --   writes to take. The trigger refused it whenever any view context
    --   happened to be open, on any company, because a statement trigger sees
    --   the caller and not the row; and it refused by RAISE, which rolled back
    --   the RPC's own audit row, so the log kept nothing at all. The RLS kit
    --   caught exactly that.
    --
    -- Nothing else collides: no audited platform RPC writes any of the 39
    -- tables left, and every one of them is a table a staff account can reach
    -- only through the context in the first place. The planning and
    -- Gehaltsquittung RPCs do write them and are refused in a view context on
    -- purpose — they resolve their company with get_active_company_id(), which
    -- is to say from the context, and they write no audit row for a RAISE to
    -- undo.
  LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      RAISE NOTICE '3.4: % is not present — skipping', v_tbl;
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS refuse_read_only_context_write ON public.%I', v_tbl);
    EXECUTE format(
      'CREATE TRIGGER refuse_read_only_context_write '
      'BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app_private.refuse_read_only_context_write()', v_tbl);
    v_count := v_count + 1;
  END LOOP;

  /*
    A floor, because the list is derived. If the catalogue query ever matches
    nothing — a changed helper name, a schema filter that stops being true — the
    loop would install no triggers at all, and self-check 5 would agree with it,
    since it derives from the same query. Then a view context would write every
    tenant table and both checks would pass. The count is the one thing that
    cannot be fooled by an empty derivation.

    36 tenant tables (31 in 20260917130000 section 2, 5 in section 3) plus the
    three shell tables above. A later migration that adds a tenant table in the
    same shape raises this number; it must never fall.
  */
  IF v_count < 39 THEN
    RAISE EXCEPTION '3.4: the refusal trigger went onto % tables, expected at least 39 — the derived list matched too little', v_count;
  END IF;

  RAISE NOTICE '3.4: a view context writes nothing on % tables', v_count;
END $mig$;

-- ─── 6. A role row cannot be pulled into the context company ────────────────

/*
  `company_users.manage` names no company — 20260917130000 made that choice on
  purpose, so support manages a company's users wherever they are. With the
  shell term now answering the open context, the WITH CHECK of roles_update
  ("company_id = get_user_company_id()") is satisfied by the *context*
  company, which would let an UPDATE pull another company's role — or one of
  its permission rows, through role_id — into the company being supported.

  WITH CHECK never sees the old row, so a policy cannot say "the value it
  already had". A trigger can, and this is the instrument the billing tables
  already use (pin_billing_company_id, 20260917130000). Nothing in the
  repository moves either column: a role belongs to the company it was created
  for, and a permission row to its role.
*/
CREATE OR REPLACE FUNCTION app_private.refuse_column_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_col text := TG_ARGV[0];
BEGIN
  IF to_jsonb(NEW) ->> v_col IS DISTINCT FROM to_jsonb(OLD) ->> v_col THEN
    RAISE EXCEPTION
      '%.%: is fixed when the row is written — create a new row rather than re-pointing this one.',
      TG_TABLE_NAME, v_col
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pin_roles_company_id ON public.roles;
CREATE TRIGGER pin_roles_company_id
  BEFORE UPDATE ON public.roles
  FOR EACH ROW EXECUTE FUNCTION app_private.refuse_column_change('company_id');

DROP TRIGGER IF EXISTS pin_role_permissions_role_id ON public.role_permissions;
CREATE TRIGGER pin_role_permissions_role_id
  BEFORE UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION app_private.refuse_column_change('role_id');

-- ─── 7. Housekeeping and the staff trigger ──────────────────────────────────

/*
  Closes every context that is past its expiry. The context is already
  ineffective by then — platform_context_row() requires expires_at > now() — so
  this is bookkeeping: it makes the table say what happened, and keeps the
  one-open-context index satisfiable.

  Not wired into deploy/otp-housekeeping.sh here (this branch touches no
  deploy/); platform_context_open() and platform_context_close() call it for
  the caller's own rows, which is enough for the product. Adding it to the
  hourly job is a host change.
*/
CREATE OR REPLACE FUNCTION app_private.platform_contexts_expire(p_user_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE app_private.platform_company_contexts c
     SET closed_at = c.expires_at, closed_reason = 'expired'
   WHERE c.closed_at IS NULL
     AND c.expires_at <= now()
     AND (p_user_id IS NULL OR c.staff_user_id = p_user_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

/*
  Disabling, demoting or deleting a staff row ends that account's context.
  platform_context_row() already refuses it — this writes the fact down, so the
  table and the audit log agree with what the helpers answer.
*/
CREATE OR REPLACE FUNCTION app_private.platform_staff_close_contexts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := CASE TG_OP WHEN 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  v_gone boolean := TG_OP = 'DELETE'
                    OR NEW.disabled_at IS NOT NULL
                    OR NEW.role IS DISTINCT FROM OLD.role;
  v_row  record;
BEGIN
  IF NOT v_gone THEN
    RETURN NULL;
  END IF;

  FOR v_row IN
    UPDATE app_private.platform_company_contexts c
       SET closed_at = now(), closed_reason = 'staff_disabled'
     WHERE c.staff_user_id = v_user
       AND c.closed_at IS NULL
    RETURNING c.id, c.company_id, c.mode
  LOOP
    PERFORM app_private.audit_write('support', 'platform_context.close', 'ok', v_row.company_id,
      'platform_company_context', v_row.id::text,
      jsonb_build_object('mode', v_row.mode),
      jsonb_build_object('closed_reason', 'staff_disabled'),
      -- The actor is whoever changed the staff row, not the account losing it.
      auth.uid());
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS platform_staff_close_contexts ON app_private.platform_staff;
CREATE TRIGGER platform_staff_close_contexts
  AFTER UPDATE OR DELETE ON app_private.platform_staff
  FOR EACH ROW EXECUTE FUNCTION app_private.platform_staff_close_contexts();

-- ─── 8. The answer shape, and the German sentences ──────────────────────────

/** One context as the browser reads it. NULL row in, SQL NULL out. */
CREATE OR REPLACE FUNCTION app_private.platform_context_json(p_row app_private.platform_company_contexts)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN p_row.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id',                p_row.id,
    'company_id',        p_row.company_id,
    'company_name',      (SELECT c.name FROM public.companies c WHERE c.id = p_row.company_id),
    'mode',              p_row.mode,
    'reason',            p_row.reason,
    'opened_at',         p_row.opened_at,
    'expires_at',        p_row.expires_at,
    'seconds_remaining', greatest(0, floor(extract(epoch FROM p_row.expires_at - now())))::integer
  ) END;
$$;

/*
  20260916130000's response builder, with the reasons this slice can answer.
  Every existing branch is restated unchanged; the self-check spot-checks two
  of them so a future edit cannot quietly reword one.
*/
CREATE OR REPLACE FUNCTION app_private.platform_rpc_response(p_reason text, p_extra jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_reason IS NULL THEN jsonb_build_object('success', true) || coalesce(p_extra, '{}'::jsonb)
    ELSE jsonb_build_object(
      'success', false,
      'reason',  p_reason,
      'error',   CASE p_reason
        WHEN 'denied'             THEN 'Keine Berechtigung für diese Aktion.'
        WHEN 'invalid'            THEN 'Ungültige Eingabe.'
        WHEN 'not_found'          THEN 'Nicht gefunden.'
        WHEN 'invalid_status'     THEN 'Diese Aktion ist im aktuellen Zustand nicht möglich.'
        WHEN 'slug_taken'         THEN 'Dieser Slug ist bereits vergeben.'
        WHEN 'code_taken'         THEN 'Dieser Code existiert bereits.'
        WHEN 'no_trial'           THEN 'Für dieses Unternehmen ist keine Testphase eingetragen.'
        WHEN 'plan_inactive'      THEN 'Dieser Plan ist nicht aktiv.'
        WHEN 'account_not_found'  THEN 'Konto nicht gefunden.'
        WHEN 'account_in_company' THEN 'Dieses Konto gehört zu einem Unternehmen und kann nicht zum Plattform-Team hinzugefügt werden.'
        WHEN 'already_staff'      THEN 'Dieses Konto gehört bereits zum Plattform-Team.'
        WHEN 'already_disabled'   THEN 'Dieses Konto ist bereits deaktiviert.'
        WHEN 'already_enabled'    THEN 'Dieses Konto ist bereits aktiv.'
        WHEN 'last_owner'         THEN 'Der letzte aktive Inhaber der Plattform kann nicht deaktiviert werden.'
        WHEN 'role_requires_3_3'  THEN 'Andere Rollen als "owner" sind erst ab Plan-Schritt 3.3 möglich.'
        -- 20260917140000, the support sessions
        WHEN 'context_open'       THEN 'Es ist bereits ein Zugriff auf ein anderes Unternehmen offen. Bitte zuerst beenden.'
        WHEN 'reason_required'    THEN 'Für eine Support-Sitzung ist ein Grund erforderlich.'
        WHEN 'no_session'         THEN 'Diese Anmeldung ist nicht mehr gültig. Bitte erneut anmelden.'
        WHEN 'no_context'         THEN 'Es ist kein Unternehmenszugriff offen.'
        ELSE 'Die Aktion konnte nicht ausgeführt werden.'
      END)
  END;
$$;

-- ─── 9. Opening, closing and reading a context ──────────────────────────────

/*
  Opens a context on one company. `view` reads; `support` reads and writes and
  says why.

  A broken argument contract raises 22023, as everywhere in app_private's
  callers; every other outcome is a return value, so the audit row that records
  the refusal survives the transaction.

  Idempotent on the same company and the same mode: the open context comes
  back, with the expiry it already had. It is never extended by re-asking —
  otherwise a screen that polls would hold a session open all day.
*/
CREATE OR REPLACE FUNCTION public.platform_context_open(
  p_company_id uuid,
  p_mode       text DEFAULT 'view',
  p_reason     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action   CONSTANT text     := 'platform_context.open';
  c_lifetime CONSTANT interval := interval '60 minutes';

  v_capability text;
  v_uid        uuid := auth.uid();
  v_sid        uuid;
  v_reason     text := nullif(trim(p_reason), '');
  v_open       app_private.platform_company_contexts%ROWTYPE;
  v_row        app_private.platform_company_contexts%ROWTYPE;
BEGIN
  -- 1. The argument contract.
  IF p_company_id IS NULL OR p_mode IS NULL OR p_mode NOT IN ('view', 'support') THEN
    RAISE EXCEPTION 'platform_context_open: invalid arguments' USING ERRCODE = '22023';
  END IF;

  v_capability := CASE p_mode WHEN 'support' THEN 'support.session' ELSE 'business.read' END;

  IF NOT app_private.platform_rpc_authorize(v_capability, 'support', c_action,
                                            p_company_id, 'company', p_company_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  -- 2. What the mode itself requires.
  IF p_mode = 'support' AND v_reason IS NULL THEN
    RETURN app_private.platform_rpc_finish('support', c_action, 'reason_required', p_company_id,
                                           'company', p_company_id::text, NULL, NULL);
  END IF;
  IF p_mode = 'view' AND v_reason IS NOT NULL THEN
    RETURN app_private.platform_rpc_finish('support', c_action, 'invalid', p_company_id,
                                           'company', p_company_id::text, NULL,
                                           jsonb_build_object('mode', p_mode));
  END IF;
  IF length(v_reason) > 500 THEN
    RETURN app_private.platform_rpc_finish('support', c_action, 'invalid', p_company_id,
                                           'company', p_company_id::text, NULL,
                                           jsonb_build_object('mode', p_mode));
  END IF;

  -- 3. The caller must be a company-less staff account tied to a live session:
  --    a context is answered only to the sign-in session that opened it, and
  --    for an account that has a company of its own it would never be read.
  IF app_private.account_has_company(v_uid) THEN
    RETURN app_private.platform_rpc_finish('support', c_action, 'account_in_company', p_company_id,
                                           'company', p_company_id::text, NULL, NULL);
  END IF;

  v_sid := app_private.jwt_session_id();
  IF v_sid IS NULL
     OR NOT EXISTS (SELECT 1 FROM auth.sessions s
                     WHERE s.id = v_sid AND s.user_id = v_uid
                       AND (s.not_after IS NULL OR s.not_after > now())) THEN
    RETURN app_private.platform_rpc_finish('support', c_action, 'no_session', p_company_id,
                                           'company', p_company_id::text, NULL, NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id) THEN
    RETURN app_private.platform_rpc_finish('support', c_action, 'not_found', p_company_id,
                                           'company', p_company_id::text, NULL, NULL);
  END IF;

  -- 4. One context at a time. Expired rows are closed first, so the partial
  --    unique index below has room; what is left is a live one.
  PERFORM app_private.platform_contexts_expire(v_uid);

  SELECT * INTO v_open
    FROM app_private.platform_company_contexts c
   WHERE c.staff_user_id = v_uid AND c.closed_at IS NULL
   FOR UPDATE;

  IF FOUND THEN
    IF v_open.company_id <> p_company_id THEN
      RETURN app_private.platform_rpc_finish('support', c_action, 'context_open', p_company_id,
                                             'platform_company_context', v_open.id::text, NULL,
                                             jsonb_build_object('open_company_id', v_open.company_id));
    END IF;
    IF v_open.mode = p_mode AND v_open.session_id = v_sid THEN
      -- Already open, same company, same mode: hand it back with the expiry it
      -- already has, because re-asking must not extend a session.
      --
      -- The row keeps the reason it was opened with — a justification is of the
      -- moment it was given, and rewriting it would lose the first one. A
      -- *different* reason given now would then vanish entirely, so it goes
      -- into this call's audit row: the log records every reach into the
      -- company with the reason given for it, timestamped, whether or not the
      -- row changed.
      RETURN app_private.platform_rpc_finish('support', c_action, NULL, p_company_id,
                                             'platform_company_context', v_open.id::text,
                                             jsonb_build_object('reason', v_open.reason),
                                             jsonb_build_object('mode', v_open.mode, 'reopened', true,
                                                                'reason', coalesce(v_reason, v_open.reason)),
                                             jsonb_build_object('context', app_private.platform_context_json(v_open)));
    END IF;
    -- Same company, other mode (the view → support step the bar offers), or a
    -- context left behind by an earlier sign-in session.
    UPDATE app_private.platform_company_contexts
       SET closed_at = now(), closed_reason = 'superseded'
     WHERE id = v_open.id;
  END IF;

  INSERT INTO app_private.platform_company_contexts
    (staff_user_id, company_id, mode, reason, session_id, expires_at)
  VALUES
    (v_uid, p_company_id, p_mode, v_reason, v_sid, now() + c_lifetime)
  RETURNING * INTO v_row;

  RETURN app_private.platform_rpc_finish('support', c_action, NULL, p_company_id,
                                         'platform_company_context', v_row.id::text, NULL,
                                         jsonb_build_object('mode', v_row.mode, 'reason', v_row.reason,
                                                            'expires_at', v_row.expires_at),
                                         jsonb_build_object('context', app_private.platform_context_json(v_row)));
EXCEPTION WHEN unique_violation THEN
  -- A concurrent call opened one a moment ago.
  RETURN app_private.platform_rpc_finish('support', c_action, 'context_open', p_company_id,
                                         'company', p_company_id::text, NULL, NULL);
END;
$$;

/*
  Closes the caller's own open context, whatever its mode. Any role that can
  hold one holds business.read, so that is what the door asks; a role that
  cannot open one cannot have one to close.
*/
CREATE OR REPLACE FUNCTION public.platform_context_close(p_context_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'platform_context.close';
  v_uid uuid := auth.uid();
  v_row app_private.platform_company_contexts%ROWTYPE;
BEGIN
  IF NOT app_private.platform_rpc_authorize('business.read', 'support', c_action,
                                            NULL, 'platform_company_context', p_context_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  PERFORM app_private.platform_contexts_expire(v_uid);

  SELECT * INTO v_row
    FROM app_private.platform_company_contexts c
   WHERE c.staff_user_id = v_uid
     AND c.closed_at IS NULL
     AND (p_context_id IS NULL OR c.id = p_context_id)
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('support', c_action, 'no_context', NULL,
                                           'platform_company_context', p_context_id::text, NULL, NULL);
  END IF;

  UPDATE app_private.platform_company_contexts
     SET closed_at = now(), closed_reason = 'manual'
   WHERE id = v_row.id;

  RETURN app_private.platform_rpc_finish('support', c_action, NULL, v_row.company_id,
                                         'platform_company_context', v_row.id::text,
                                         jsonb_build_object('mode', v_row.mode, 'closed_at', NULL),
                                         jsonb_build_object('mode', v_row.mode, 'closed_reason', 'manual'));
END;
$$;

/*
  The caller's context as the platform screens read it — and one audit row per
  call, which is why a screen that polls should read platform_whoami() instead:
  that one is STABLE and writes nothing.
*/
CREATE OR REPLACE FUNCTION public.platform_context_current()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'platform_context.read';
  v_row  app_private.platform_company_contexts%ROWTYPE;
  v_json jsonb;
BEGIN
  IF NOT app_private.platform_rpc_authorize('business.read', 'support', c_action, NULL, NULL, NULL) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  v_row  := app_private.platform_context_row();
  v_json := app_private.platform_context_json(v_row);

  RETURN app_private.platform_rpc_finish('support', c_action, NULL, v_row.company_id,
                                         'platform_company_context', v_row.id::text,
                                         NULL, jsonb_build_object('mode', v_row.mode),
                                         jsonb_build_object('context', v_json));
END;
$$;

-- ─── 10. platform_whoami() fills company_context ────────────────────────────

-- 20260916110000's body, with the context it left NULL for this slice to fill.
-- STABLE: the browser polls it, and it writes nothing. The audited read is
-- platform_context_current().
CREATE OR REPLACE FUNCTION public.platform_whoami()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text := app_private.platform_staff_role_of(auth.uid());
BEGIN
  RETURN jsonb_build_object(
    'role',            v_role,
    'capabilities',    coalesce((SELECT jsonb_agg(m.capability ORDER BY m.capability)
                                   FROM app_private.platform_capability_matrix() m
                                  WHERE m.role = v_role), '[]'::jsonb),
    'company_context', CASE WHEN v_role IS NULL THEN NULL
                            ELSE app_private.platform_context_json(app_private.platform_context_row()) END
  );
END;
$$;

-- ─── 11. Ownership and privileges ───────────────────────────────────────────

/*
  Every SECURITY DEFINER function that reaches app_private must be owned by a
  role that holds USAGE on the schema and EXECUTE on the helper. On the live
  databases several of these belong to a non-superuser `postgres` — CREATE OR
  REPLACE keeps the owner — and `postgres` can read app_private's tables through
  pg_read_all_data but holds EXECUTE on none of its functions. The four helpers
  below gain an app_private call in this file, so each is moved to the role
  applying the migrations, which owns the schema. The self-check proves it.
*/
ALTER FUNCTION public.get_user_company_id()                  OWNER TO CURRENT_USER;
ALTER FUNCTION public.get_active_company_id()                OWNER TO CURRENT_USER;
ALTER FUNCTION public.current_role_permits(text, boolean)    OWNER TO CURRENT_USER;
ALTER FUNCTION public.is_company_admin()                     OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_view_company_id()             OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_support_company_id()          OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_context_open(uuid, text, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_context_close(uuid)           OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_context_current()             OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_whoami()                      OWNER TO CURRENT_USER;

-- app_private: nobody the API authenticates as holds anything here. The REVOKE
-- is the second wall behind the missing USAGE on the schema; EXECUTE to PUBLIC
-- on a new function is a built-in global default and cannot be revoked per
-- schema.
REVOKE ALL ON TABLE app_private.platform_company_contexts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.jwt_session_id()                                 FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_context_row()                           FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_context_company(boolean)                FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.account_has_company(uuid)                        FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_context_json(app_private.platform_company_contexts)
                                                                                    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_contexts_expire(uuid)                   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.refuse_read_only_context_write()                 FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.refuse_column_change()                           FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_staff_close_contexts()                  FROM PUBLIC, anon, authenticated, service_role;
-- Redefined above to add this slice's reasons. 20260916130000 already revoked
-- it; restated because a CREATE OR REPLACE is exactly where such a revoke gets
-- lost, and because the self-check below can then assert it rather than inherit
-- it from a file three releases back.
REVOKE ALL ON FUNCTION app_private.platform_rpc_response(text, jsonb)               FROM PUBLIC, anon, authenticated, service_role;

-- The two named modes: for signed-in callers, like every other platform
-- helper. The service role has no auth.uid() to answer for.
REVOKE ALL ON FUNCTION public.platform_view_company_id()    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_view_company_id() TO authenticated;
REVOKE ALL ON FUNCTION public.platform_support_company_id() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_support_company_id() TO authenticated;

REVOKE ALL ON FUNCTION public.platform_context_open(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_context_open(uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.platform_context_close(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_context_close(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.platform_context_current() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_context_current() TO authenticated;

-- The helpers keep exactly the grants 20260917130000 and the fixture left them:
-- restated here because CREATE OR REPLACE keeps them and a reader should not
-- have to prove that from three files.
REVOKE ALL ON FUNCTION public.get_active_company_id()        FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_active_company_id()     TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_user_company_id()          FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_company_id()       TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_company_admin()             FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_company_admin()          TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_role_permits(text, boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.platform_reads_company_data()  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.platform_reads_company_data() TO authenticated;
REVOKE ALL ON FUNCTION public.platform_writes_company_data() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.platform_writes_company_data() TO authenticated;
REVOKE ALL ON FUNCTION public.platform_whoami() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_whoami() TO authenticated;

-- ─── 12. Self-check ─────────────────────────────────────────────────────────

DO $mig$
DECLARE
  v_wrong text;
  v_n     int;
BEGIN
  -- 1. app_private stays shut, table and functions alike.
  FOREACH v_wrong IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_schema_privilege(v_wrong, 'app_private', 'USAGE')
       OR has_table_privilege(v_wrong, 'app_private.platform_company_contexts',
                              'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
      RAISE EXCEPTION '3.4 self-check: % reaches app_private.platform_company_contexts', v_wrong;
    END IF;
  END LOOP;

  -- 2. Every function this file creates or replaces: SECURITY DEFINER where it
  --    matters, a pinned search_path, an owner that can reach app_private, and
  --    exactly the grants stated above.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ') INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig))
                    IS DISTINCT FROM v.definer
                 THEN 'SECURITY DEFINER should be ' || v.definer
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               WHEN v.definer AND NOT EXISTS (
                      SELECT 1 FROM pg_proc p
                        JOIN pg_roles r ON r.oid = p.proowner
                       WHERE p.oid = to_regprocedure(v.sig)
                         AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private')))
                 THEN 'owner can call no app_private helper'
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.anon
                 THEN 'anon EXECUTE should be ' || v.anon
               WHEN has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.authn
                 THEN 'authenticated EXECUTE should be ' || v.authn
               WHEN has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.service
                 THEN 'service_role EXECUTE should be ' || v.service
             END AS problem
        FROM (VALUES
          -- signature                                             definer anon   authn  service
          ('public.platform_context_open(uuid,text,text)',          true,  false, true,  false),
          ('public.platform_context_close(uuid)',                   true,  false, true,  false),
          ('public.platform_context_current()',                     true,  false, true,  false),
          ('public.platform_view_company_id()',                     true,  false, true,  false),
          ('public.platform_support_company_id()',                  true,  false, true,  false),
          ('public.platform_whoami()',                              true,  false, true,  false),
          ('public.get_active_company_id()',                        true,  false, true,  true),
          ('public.get_user_company_id()',                          true,  false, true,  true),
          ('public.platform_reads_company_data()',                  false, false, true,  false),
          ('public.platform_writes_company_data()',                 false, false, true,  false),
          ('app_private.jwt_session_id()',                          false, false, false, false),
          ('app_private.platform_context_row()',                    true,  false, false, false),
          ('app_private.platform_context_company(boolean)',         true,  false, false, false),
          ('app_private.account_has_company(uuid)',                 false, false, false, false),
          ('app_private.platform_context_json(app_private.platform_company_contexts)',
                                                                    false, false, false, false),
          ('app_private.platform_contexts_expire(uuid)',            true,  false, false, false),
          ('app_private.refuse_read_only_context_write()',          true,  false, false, false),
          ('app_private.refuse_column_change()',                    false, false, false, false),
          ('app_private.platform_staff_close_contexts()',           true,  false, false, false),
          ('app_private.platform_rpc_response(text,jsonb)',         false, false, false, false)
        ) AS v(sig, definer, anon, authn, service)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.4 self-check: %', v_wrong;
  END IF;

  --    is_company_admin() and current_role_permits() are checked apart, because
  --    the grant list above is not theirs to state. Both predate this file, and
  --    both were left by their own migrations (20260908104500, 20260910120000)
  --    as `REVOKE … FROM PUBLIC` plus `GRANT … TO authenticated` — which does
  --    not touch the explicit grants Supabase's default privileges gave anon
  --    and the service role when each was created. So anon has always held
  --    EXECUTE on these two, and matrix.sql records that cell as N (asked and
  --    answered false), not P. This slice neither widens that nor narrows it:
  --    narrowing would move a matrix cell that has nothing to do with support
  --    sessions, and a self-check that demanded the narrower list would also
  --    forbid a later migration from tightening it.
  --
  --    What is asserted instead is what actually matters: authenticated can
  --    call them, because every write policy does, and they are SECURITY
  --    DEFINER with a pinned search_path and an owner that can reach the
  --    app_private helper they now ask for the open context.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ') INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig))
                 THEN 'not SECURITY DEFINER'
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               WHEN NOT EXISTS (
                      SELECT 1 FROM pg_proc p
                        JOIN pg_roles r ON r.oid = p.proowner
                       WHERE p.oid = to_regprocedure(v.sig)
                         AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private')))
                 THEN 'owner can call no app_private helper'
               WHEN NOT has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE')
                 THEN 'authenticated needs EXECUTE — every write policy calls it'
             END AS problem
        FROM (VALUES ('public.is_company_admin()'),
                     ('public.current_role_permits(text,boolean)')) AS v(sig)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.4 self-check: %', v_wrong;
  END IF;

  --    …and that they fail closed, which is what makes anon's historical
  --    EXECUTE harmless: a caller without a subject is neither an administrator
  --    of a company nor inside a support session. The migration itself carries
  --    no JWT, so auth.uid() is NULL right here — that caller is exactly this
  --    one. (It is also the state 20260915130000 found a hole in, one helper
  --    over: a single-row SELECT answering NULL rather than false.)
  IF public.is_company_admin() IS NOT FALSE
     OR public.current_role_permits('drivers', true) IS NOT FALSE THEN
    RAISE EXCEPTION '3.4 self-check: a role gate answers something other than false to a caller with no subject';
  END IF;

  -- 3. Both seams are constants. A `true` in either would undo the confinement
  --    the tenant term now carries; see section 4.
  IF public.platform_reads_company_data() IS NOT FALSE
     OR public.platform_writes_company_data() IS NOT FALSE THEN
    RAISE EXCEPTION '3.4 self-check: a seam is not false — the OR next to the tenant term would open every company at once';
  END IF;

  -- 4. The tenant term is where the context is answered. Both helpers must
  --    name the context helper, or nothing confines a staff account.
  SELECT string_agg(v.sig, ', ') INTO v_wrong
    FROM (VALUES ('public.get_active_company_id()'), ('public.get_user_company_id()'),
                 ('public.current_role_permits(text,boolean)'), ('public.is_company_admin()')) AS v(sig)
   WHERE (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) !~ 'platform_context_company';

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.4 self-check: does not read the open context: %', v_wrong;
  END IF;

  -- 5. Every table a view context could reach carries the refusal trigger.
  --
  --    Asked of the catalogue, the same way the loop installs them, and not of
  --    a literal list: a list here would restate the loop's own list, so it
  --    could only ever confirm that the two copies agree — a table missing from
  --    both would pass. What this proves is therefore narrower than it looks,
  --    and worth stating exactly: every table whose policies name
  --    get_active_company_id() (the tenant shape of 20260917130000), plus the
  --    three shell tables this file adds, ended up with a trigger on it. It
  --    catches a table the loop skipped; it cannot catch a table 3.3 should
  --    have given the tenant shape and did not, because nothing here knows
  --    3.3's intent apart from its policies.
  SELECT string_agg(t.tbl, ', ') INTO v_wrong
    FROM (
      SELECT DISTINCT p.tablename::text AS tbl
        FROM pg_policies p
       WHERE p.schemaname = 'public'
         AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'get_active_company_id'
       UNION
      SELECT v.tbl::text
        FROM (VALUES ('roles'), ('role_permissions'), ('activation_code_attempts')) AS v(tbl)
    ) t
   WHERE to_regclass('public.' || t.tbl) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_trigger g
                      WHERE g.tgrelid = ('public.' || t.tbl)::regclass
                        AND g.tgname = 'refuse_read_only_context_write'
                        AND NOT g.tgisinternal);

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.4 self-check: a view context could write %', v_wrong;
  END IF;

  -- 5b. …and company_settings does not carry it, which is as deliberate as the
  --     list above. Its writes do not take their company from the context —
  --     company_settings_update names no company at all — and
  --     platform_subscription_assign (20260916130000) ends by setting
  --     drivers_per_car_limit on the company in its argument, with
  --     billing.manage checked and an audit row of its own. A trigger here
  --     refuses that RPC whenever any view context is open, on any company,
  --     because a statement trigger sees the caller and not the row; and the
  --     RAISE rolls back the RPC's audit row, so the log keeps nothing. The RLS
  --     kit caught exactly that. Putting it back means teaching the trigger the
  --     difference first.
  IF to_regclass('public.company_settings') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = 'public.company_settings'::regclass
                    AND g.tgname = 'refuse_read_only_context_write'
                    AND NOT g.tgisinternal) THEN
    RAISE EXCEPTION '3.4 self-check: company_settings carries the view-context refusal again — that refuses platform_subscription_assign and rolls back its audit row';
  END IF;

  -- 6. …and it is a statement trigger. Per row it would run once per imported
  --    trip, on the hottest write path in the product.
  IF EXISTS (SELECT 1 FROM pg_trigger g
              WHERE g.tgname = 'refuse_read_only_context_write'
                AND NOT g.tgisinternal
                AND (g.tgtype & 1) = 1) THEN
    RAISE EXCEPTION '3.4 self-check: refuse_read_only_context_write is a row-level trigger somewhere';
  END IF;

  -- 7. A role row cannot be re-pointed (section 6).
  SELECT string_agg(v.tbl || '.' || v.trg, ', ') INTO v_wrong
    FROM (VALUES ('roles', 'pin_roles_company_id'),
                 ('role_permissions', 'pin_role_permissions_role_id')) AS v(tbl, trg)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g
                      WHERE g.tgrelid = ('public.' || v.tbl)::regclass
                        AND g.tgname = v.trg AND NOT g.tgisinternal);

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.4 self-check: missing %', v_wrong;
  END IF;

  -- 8. One open context per staff member, and a support session says why.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'app_private'
                    AND indexname = 'platform_company_contexts_one_open') THEN
    RAISE EXCEPTION '3.4 self-check: nothing holds one open context per staff member';
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_constraint
   WHERE conrelid = 'app_private.platform_company_contexts'::regclass
     AND conname IN ('platform_context_reason_iff_support', 'platform_context_closed_pair',
                     'platform_context_expires_after_open');
  IF v_n <> 3 THEN
    RAISE EXCEPTION '3.4 self-check: % of 3 context constraints present', v_n;
  END IF;

  -- 9. The context is bound to one sign-in session.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'app_private' AND table_name = 'platform_company_contexts'
                AND column_name = 'session_id' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION '3.4 self-check: a context without a session would outlive the sign-in that opened it';
  END IF;

  -- 10. The edge functions' door is still shut to the actions this file writes.
  --     platform_audit_record is deliberately not redefined here (see the
  --     header): its allow-list already refuses them, and this proves it.
  BEGIN
    PERFORM public.platform_audit_record('write', 'platform_context.open', 'ok');
    RAISE EXCEPTION '3.4 self-check: platform_audit_record accepted platform_context.open — an edge function could forge a support-session row';
  EXCEPTION
    WHEN sqlstate '22023' THEN NULL;
  END;

  -- 11. The German sentences that were there before are still there.
  IF (app_private.platform_rpc_response('last_owner') ->> 'error')
       <> 'Der letzte aktive Inhaber der Plattform kann nicht deaktiviert werden.'
     OR (app_private.platform_rpc_response('denied') ->> 'error')
       <> 'Keine Berechtigung für diese Aktion.'
     OR (app_private.platform_rpc_response('reason_required') ->> 'error')
       <> 'Für eine Support-Sitzung ist ein Grund erforderlich.'
     OR (app_private.platform_rpc_response(NULL) ->> 'success') <> 'true' THEN
    RAISE EXCEPTION '3.4 self-check: platform_rpc_response lost or changed a sentence';
  END IF;

  RAISE NOTICE '3.4 self-check: passed';
END $mig$;
