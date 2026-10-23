/*
  The permission matrix as it stands before phase 3 — a characterization, not a
  specification.

  `assertions.sql` states rules the boundary must keep. This file records what
  the database does *today* for every role on every table and on the RPCs the
  platform screens call, including the parts that are wrong. Phase 3 rewrites
  the policies behind all of it; the point of this file is that every cell it
  changes shows up here as a mismatch, is changed on purpose in the same commit,
  and is named in the pull request. Do not "fix" a mismatch by pasting the
  actual line over the expected one without reading why it moved.

  ## Principals (columns, in this order)

    anon        no JWT, role anon
    viewer      viewer-a      role viewer      company A
    editor      editor-a      role editor      company A
    supervisor  supervisor-a  role supervisor  company A
    admin       admin-a       role admin       company A
    other       admin-b       role admin       company B — a member of another company
    super       super         an owner in app_private.platform_staff (seed.sql),
                              company NULL, no context open at all
    staff_view  staff-view    the same owner rights, with a *view* context open
                              on company A (20260917140000)
    staff_support
                staff-support the same, with a *support* context open on company A

  The last two differ from `super` by the context and by nothing else — same
  role, same capabilities, same absent company — so every cell where they differ
  from it is the support session doing something, and nothing else. Their two
  columns are filled by rule rather than written out row by row (see "the
  expected matrix" below), because the rule is the claim worth testing:

    a support session makes a staff account the administrator of the company it
    opened, and a view context reads what that administrator reads and writes
    nothing at all.

  ## Rows

  Every table gets one probe row belonging to company A and one belonging to
  company B, both with fixed ids (`_mx_id(table, side)`). Tables without a
  company column get two rows tied to A and B through their parent (a document,
  a role, a reconciliation) or, for the platform catalogues (plans, referrals,
  categories), simply two rows. Every probe runs in a subtransaction that is
  rolled back, so one probe never sees another's effect. The companies, users,
  drivers and trips of the state section are created with the extra principals
  below; the view, scenario and RPC sections insert the few rows they need next
  to the section itself.

  ## Operations

    S  select   count the row through its key
    I  insert   a new row in the side's company
    U  update   a SET clause that changes nothing, so the answer depends only on
                who asks. It exercises a policy's USING clause and never its
                WITH CHECK
    D  delete
    M  move     an UPDATE that points the row at the other side's tenant:
                company A's row into company B, company B's row into company A.
                This is the write a WITH CHECK clause exists to refuse. A table
                that reaches its company through a parent (a document, a role, a
                reconciliation, a user) is moved by repointing that foreign key.
                The row is taken with SELECT … FOR UPDATE and moved with
                UPDATE … WHERE CURRENT OF (`_mx_move_try`). An UPDATE whose WHERE
                reads a column needs SELECT rights, and PostgreSQL then checks
                the new row against the SELECT policies as well, so a
                tenant-scoped SELECT policy would hide a WITH CHECK that lets the
                row go anywhere

  ## Cells

  Each cell is two characters: the outcome on the company-A row, then on the
  company-B row. For `other` that means cross-tenant first, own company second.
  On an M line the first character is company A's row moved into company B, the
  second company B's row moved into company A.

    Y  allowed — the row was visible, inserted, updated, deleted or moved
    .  silently nothing — RLS filtered the row out (SELECT/UPDATE/DELETE)
    R  refused by a row-level security WITH CHECK
    P  refused for lack of a GRANT (permission denied)
    T  refused by a trigger or function: a RAISE with SQLSTATE P0001 or P0002,
       or a 42501 it raises itself (a missing GRANT is P)
    C  refused by a constraint (SQLSTATE class 23)
    E  any other error — the mismatch report prints the SQLSTATE and message
    -  not probed: an M line on a table with no tenant to move a row into

  After the principals, every probe statement is executed once more as the
  table owner, which bypasses RLS, and must succeed. That is what keeps a
  refusal in this file from being a malformed statement in disguise. There is
  one exception: nobody may move a trip, the owner included, because
  protect_fahrtenbuch_immutable_fields raises. That owner pass must answer T
  (`_mx_move.owner_must`).

  ## Known holes recorded here as current behaviour

  Each is tagged `HOLE[3.x]` with the plan step that is meant to change it.

  3.1 (20260916110010) closed two: platform rights came from the is_super_admin
  column alone, and the profile guard let a column super admin move any profile
  into any company and grant the column. Platform sign-in stays an address and a
  password, with no second step (the owner's decision of 16.09.2026), so no step
  of the plan adds one and nothing here is tagged for it.

  3.5 (20260916130000, 20260916130010, 20260916130020) closed six more: every
  platform write is now an RPC that checks a capability and audits itself, and
  with them went the discount codes any signed-in user could read, the attempts
  anyone could forge in another company's name, a preview that neither counted
  nor recorded a guess, a redeem open to every member, the approval note every
  member could read, and the last SECURITY DEFINER function without a pinned
  search_path. The cells and scenarios they moved are marked below.

  3.3 (20260917130000) closed the write side and the state rules. Every tenant
  table now carries one shape; the tenant predicate is get_active_company_id(),
  which answers NULL for a company or an account App.tsx refuses, so a pending,
  rejected or suspended company, one whose subscription is inactive, expired or
  past its expiry, and a deactivated, suspended or inactive user read and write
  nothing — through the tables or through the planning RPCs, which ask the same
  helper. The platform branch of every write policy is gone, and the platform
  tables ask the capability that names the act instead of "is this account
  staff". A company with a live subscription and an invited employee are the two
  controls that stay allowed, because App.tsx admits both.

  3.4 (20260917140000) closed the last of them, and no line is tagged for it any
  more. `platform_reads_company_data()` is false; the company a platform account
  may touch is the one its open context names, answered by
  get_active_company_id() — so `super`, which opens none, now reads a tenant's
  rows exactly as anon does. What a view context may write is refused by a
  statement trigger on all 36 tenant tables and by the role gates; what a
  support session may write is what that company's own administrator may write.

  Two cells moved with it that are not about staff at all: `roles` M and
  `role_permissions` M, which were refused by a WITH CHECK and are now refused by
  a trigger for every writer (see _mx_move).

  3.13a (20260921110000, 20260921110010) closed the account-shell residue 3.4
  left tagged for 3.4c/3.13: `company_settings` and `user_profiles` are written
  by a platform account only inside a support session on the row's company —
  the platform branch of their write policies is
  `company_id = platform_support_company_id()` instead of a capability with no
  company term. `super` no longer edits, deletes or re-points any company's
  settings, and a view context no longer changes the profiles or inserts the
  settings of the company it reads. And the three Gehaltsquittung RPCs refuse a
  caller inside a platform context in either mode, so a support session no
  longer issues, voids or signs one (the rpc overrides below).

  3.13b (20260923100000) closed the last of the shell that is the *company's*
  own data rather than the platform's record of it: `company_settings` SELECT
  dropped its `companies.read` branch, so `super` reads neither row and the two
  context principals read the company they opened.

  D14, answered on 24.09.2026 (20260924110000), split what was left. The owner
  took the middle path. `companies` **stays** on `companies.read`: that list is
  how a company is chosen to open a context on, so requiring a context to read
  it is circular, and it carries no money — its S cell is still YY and that is a
  decision, not a hole. The four that carry a customer's billing address and
  what they paid — `company_subscriptions`, `subscription_invoices`,
  `subscription_payment_audit` and `subscription_coverage` — moved behind two
  audited read models on `billing.manage`, so their S cells read '..' for
  `super` and 'Y.' for the two context principals, and four more cells moved
  with them for a mechanical reason written out at the lines themselves. The
  `codes.manage` reads are untouched: an activation code is not a customer's
  money. What the four tables cost a `support` or `read_only` account, and what
  it keeps, is section 12 of tests/rls/platform-readmodels.sql.

  Slice C (20260923130000) closed the last thing 3.3 wrote down and left alone:
  its own table list says "no role gate today, and none added: a viewer writes
  these exactly as it does now. Narrowing them is a decision about roles, not
  about tenancy." Twenty-three tables now carry the `page_key` of the screen
  that writes them — `documents` for the Fahrtenbuch, the planning tables, the
  historical tables, the saved Stundennachweise, the templates and the document
  blocks and variables; `cash-balance` for cash_transactions; `cars` for
  car_driver_assignments — and the five planning RPCs, which are SECURITY
  DEFINER and ran past RLS, ask the same page. No page key was created and no
  `role_permissions` row was written, so the cells that move are exactly the
  ones the seeded roles already implied: `viewer` holds can_edit nowhere and
  `editor` holds none on `documents`. Three tables on the same list are
  deliberately unchanged and their cells stay: notification_settings (its
  writes ask for an administrator, which is stricter), cash_movements and
  salary_cash_receipts (SELECT is the only privilege a client role holds), and
  document_counters (PP in every cell — no grant at all).

  ## Recorded without a plan step

  Current behaviour that no step of the plan names. Untagged, so a change to it
  is still a mismatch to explain, not an expected move.

    - **closed by 20260923130000 (slice C).** The planning RPCs (apply, replace,
      delete_or_archive, purge, reassign) checked the caller's company but not
      its role: a viewer could apply a monthly plan, as it could already write
      the planning tables directly. All five now ask
      current_role_permits('documents', true), and the tables ask it too
    - apply_monthly_planning_run accepts another company's import id: it opens a
      run in the caller's own company and changes none of the other company's
      trips
    - get_user_status() and is_user_active() answer for any user id, so any
      member reads the account status of a user in another company
    - get_current_cash_balance() fails for every caller (42703): it reads
      receipts."user", a column receipts no longer has
    - create_user_profile_manual() completes for nobody: it inserts
      user_profiles without email, which is NOT NULL, and PostgreSQL checks
      that before ON CONFLICT, so everyone its guard lets through, the super
      admin included, gets 23502

  ## Uncovered objects

  A public table or view without a line in the matrix, and a public SECURITY
  DEFINER function (triggers aside) without a line in the rpc section, is
  reported as `UNCOVERED`. That is a warning, not a failure: parallel branches
  add tables and functions, and each adds its own lines here.

  **The sweep says nothing about a SECURITY INVOKER function**, because it
  filters on `p.prosecdef`. Such a function runs under the caller's RLS, so the
  table lines already describe what it can reach — but its own refusals, and
  whether it folds a policy's 42501 into an answer of its own, are visible
  nowhere else. `company_role_save` and `company_role_delete` (20260923120000)
  are the first of that kind and are written out by hand below; a silent run is
  not evidence that the next one is covered.

  ## Not covered

    - storage.objects policies: tests/fixtures/storage-shim.sql lets a migration
      create its bucket and policies, but the fixture is a --schema=public dump
      that carries none of the older ones, so storage is not probed here.
      20260920100000 restates the four company buckets' policies in full and
      tests/rls/storage.sql probes them with salary-receipts, per principal
      and per kind of session
    - edge functions (manage-users, generate-activation-code, otp-request, …)
      and GoTrue
    - app_private: no client role has USAGE on the schema. The SECURITY DEFINER
      functions in public that reach it each have a line in the rpc section
    - EXECUTE grants revoked before 20260908: the fixture was dumped without
      privileges, so only grants from the migrations applied on top are real
      here. An RPC cell is `-` exactly where 20260427075001, 20260428102656 or
      20260607124839 revoked that caller's EXECUTE and no later migration
      restated it. 20260915110000 restates the grants of create_user_account,
      list_users_for_admin, get_user_status and is_user_active,
      20260915130000 those of is_user_super_admin and
      create_user_profile_manual, and 20260915140000 that of
      reassign_fahrtenbuch_trip, so their cells are probed. A `-` follows the
      migration history, not the live grant: on staging on 15.09.2026 anon
      still held EXECUTE on get_user_company_id, get_current_user_role,
      is_role, is_support_user and uid, all of them `-` here, and on
      reassign_fahrtenbuch_trip until 20260915140000. Every other anon cell relies
      on Supabase's default privileges granting anon EXECUTE explicitly when a
      function is created; confirm with has_function_privilege() on a copy of
      staging. No migration older than the fixture revoked a table privilege,
      so the table cells do not depend on that history.

  ## What a cell does not prove

  A cell records what the probe got, and a probe can be lied to. Schema USAGE is
  resolved when a statement is *parsed*, and plpgsql caches the parsed form, so
  a privilege error inside a SECURITY INVOKER trigger or function is raised only
  for the first role that cannot parse it — and the owner, who runs every
  fixture and every validity pass in this same session, always can. Until the
  guard in `_mx_become`, every principal probed after the owner reused the
  owner's plan and read as allowed. PR #117 is the instance: a trigger calling
  into `app_private` made the Rollen screen unusable for every company
  administrator, and this file printed `roles I` as `Y` twice.

  The guard is one `DISCARD PLANS` per principal; the plan-cache section below
  proves the probe is no longer fooled, and fails if the guard is reverted.
  `SET matrix.uncache = 'off'` at the top of this file is the negative control.

  ## Running

  The whole file runs inside BEGIN … ROLLBACK, so the tests/rls files after it
  see only the migrations and the seeds. Run it after assertions.sql against the
  kit's database; scripts/rls-test.mjs does.
*/

\set ON_ERROR_STOP on

BEGIN;

-- The plan-cache guard in `_mx_become`, on. Its whole reason is written there.
-- Change this to 'off' to run the negative control: the plan-cache section
-- below must then fail, and the difference in wall-clock time between the two
-- runs is what the guard costs.
SET matrix.uncache = 'on';

-- ─── helpers ────────────────────────────────────────────────────────────────

/** Fixed, readable-by-construction id for a probe row. */
CREATE OR REPLACE FUNCTION _mx_id(p_tbl text, p_side text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('mx:' || p_tbl || ':' || p_side)::uuid $$;

/*
  Become a principal for the rest of the current (sub)transaction. 'owner' stays
  the connecting superuser, which bypasses RLS. Uses the singular claim for the
  reason given at `_as()` in assertions.sql.
*/
CREATE OR REPLACE FUNCTION _mx_become(p_who text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_uid uuid;
BEGIN
  -- Back to the connecting role first: a scenario may switch principals inside
  -- one subtransaction, and the lookup below must not run under the previous
  -- principal's RLS.
  EXECUTE 'SET LOCAL ROLE NONE';
  IF p_who = 'owner' THEN
    RETURN;
  END IF;

  /*
    Why a principal's probe begins by throwing the session's cached plans away.

    Schema USAGE is checked when a statement is *parsed* — the parser resolves
    `app_private.f()` and asks for USAGE there — and plpgsql caches the parsed
    form of every static statement in a function body. So the first role that
    can parse such a call inside a SECURITY INVOKER trigger caches it for the
    whole session, and the owner, who runs every fixture, every `p_pre` and the
    validity pass, always can. Every principal probed afterwards then reuses
    that plan and is never refused.

    That is not hypothetical. PR #117 shipped `enforce_company_role_shape`, a
    SECURITY INVOKER trigger on `roles` calling a helper in `app_private`, and
    the feature was dead for every company administrator with
    `42501 permission denied for schema app_private`. This file reported
    `roles I` as `Y` for the admin principal, on two runs.

    It is two privilege classes, measured on PostgreSQL 17.6 and not deduced —
    an earlier version of this comment said one, from a reading of the source
    that was wrong. Schema USAGE is masked, and so is **function EXECUTE**: both
    are resolved when the statement is planned. A table privilege is not, being
    re-checked by the executor on every execution, and RLS re-plans when the role
    changes. tests/tools/plan-cache-repro.sql measures all three; the `roles I`
    expectation below is the same finding seen a second time, in this file, on a
    real migration.

    `DISCARD PLANS` is legal inside a transaction block and inside SPI — only
    `DISCARD ALL` is refused there. It goes here, before either `SET LOCAL ROLE`
    below, rather than after the fixture loop, because the owner also runs
    `p_pre` inside `_mx_try` and `_mx_move_try`, the validity pass at the end of
    every line, and `_mx_become('owner')` in the scenario section. One line
    here is complete by construction; anything narrower is a list of the owner's
    execution sites, and the next person to add a section breaks it silently.

    `matrix.uncache = 'off'` is the negative control: set it at the top of this
    file and the plan-cache section below must fail. It is also how the cost of
    this line is measured — run the kit once each way.
  */
  IF coalesce(current_setting('matrix.uncache', true), 'on') <> 'off' THEN
    EXECUTE 'DISCARD PLANS';
  END IF;

  IF p_who = 'anon' THEN
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    PERFORM set_config('request.jwt.claim.session_id', '', true);
    PERFORM set_config('request.jwt.claim.amr', '', true);
    EXECUTE 'SET LOCAL ROLE anon';
    RETURN;
  END IF;
  SELECT user_id INTO STRICT v_uid FROM user_profiles WHERE email = p_who || '@test.invalid';
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  -- GoTrue puts the sign-in session in the token, and 20260917140000 answers a
  -- support context only to the session that opened it. One fixed session per
  -- principal, the same one the rows below are seeded with.
  PERFORM set_config('request.jwt.claim.session_id', _mx_id('session', p_who)::text, true);
  -- Every principal here is a password sign-in; since 20260919130000 the
  -- platform ones hold no capability without it. See _as() in assertions.sql.
  -- The singular claims are one session: app_private.jwt_subject_source()
  -- prefers them, and reads the amr out of the same form the subject came from.
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/*
  Run `p_sql` as `p_who` inside a subtransaction that is always rolled back, and
  classify the outcome. Returns the one-character token, then `|sqlstate|message`
  when the statement raised. `p_pre` runs first as the owner, inside the same
  subtransaction, for probes that need a slot cleared (a unique row) to be valid.

  The rollback is forced by raising a private SQLSTATE after a success; role and
  claim settings made with SET LOCAL / set_config(…, true) unwind with it.
*/
/** One character for a refused statement, then `|sqlstate|message`. */
CREATE OR REPLACE FUNCTION _mx_classify(p_state text, p_msg text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN p_state = '42501' AND p_msg LIKE '%row-level security%' THEN 'R'
           WHEN p_state = '42501' AND p_msg LIKE 'permission denied%' THEN 'P'
           -- a trigger or function refusing on its own, with 42501 too
           WHEN p_state IN ('42501', 'P0001', 'P0002') THEN 'T'
           WHEN p_state LIKE '23%' THEN 'C'
           ELSE 'E'
         END || '|' || p_state || '|' || p_msg
$$;

CREATE OR REPLACE FUNCTION _mx_try(p_who text, p_pre text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_n     bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    IF p_pre IS NOT NULL THEN
      EXECUTE p_pre;
    END IF;
    PERFORM _mx_become(p_who);
    IF p_sql ~* '^\s*select' THEN
      EXECUTE p_sql INTO v_n;
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_n = ROW_COUNT;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ001', MESSAGE = coalesce(v_n, 0)::text;
  EXCEPTION
    WHEN SQLSTATE 'ZZ001' THEN
      RETURN CASE WHEN SQLERRM::bigint > 0 THEN 'Y' ELSE '.' END;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      RETURN _mx_classify(v_state, v_msg);
  END;
END $$;

/*
  The move probe. SELECT … FOR UPDATE takes the row as `p_who`, which applies
  the SELECT and UPDATE policies' USING to the existing row; `.` when that
  leaves nothing to take. UPDATE … WHERE CURRENT OF then sets `p_set`. It reads
  no column, so the new row meets the UPDATE policies' WITH CHECK and nothing
  else. Rolled back and classified like `_mx_try`.
*/
CREATE OR REPLACE FUNCTION _mx_move_try(p_who text, p_pre text, p_tbl text, p_key text, p_set text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_cur   refcursor := 'mx_move';
  v_row   int;
  v_n     bigint := 0;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    IF p_pre IS NOT NULL THEN
      EXECUTE p_pre;
    END IF;
    PERFORM _mx_become(p_who);
    OPEN v_cur FOR EXECUTE format('SELECT 1 FROM %I WHERE %s FOR UPDATE', p_tbl, p_key);
    FETCH v_cur INTO v_row;
    IF FOUND THEN
      EXECUTE format('UPDATE %I SET %s WHERE CURRENT OF mx_move', p_tbl, p_set);
      GET DIAGNOSTICS v_n = ROW_COUNT;
    END IF;
    CLOSE v_cur;
    RAISE EXCEPTION USING ERRCODE = 'ZZ001', MESSAGE = v_n::text;
  EXCEPTION
    WHEN SQLSTATE 'ZZ001' THEN
      RETURN CASE WHEN SQLERRM::bigint > 0 THEN 'Y' ELSE '.' END;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      RETURN _mx_classify(v_state, v_msg);
  END;
END $$;

/*
  Call an RPC as `p_who` (rolled back like `_mx_try`) and classify the answer:
  Y success (json success=true, json without a success key, `true`, or any other
  value), N refused by the function itself (json success=false, `false`), 0 no
  value, or P/T/E as above. A probe that asks a yes/no question is written to
  return `true` or `false`. The raw answer follows after `|` so a mismatch can
  show it.
*/
CREATE OR REPLACE FUNCTION _mx_call(p_who text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _mx_become(p_who);
    EXECUTE p_sql INTO v_out;
    RAISE EXCEPTION USING ERRCODE = 'ZZ002', MESSAGE = coalesce(v_out, '<null>');
  EXCEPTION
    WHEN SQLSTATE 'ZZ002' THEN
      v_out := SQLERRM;
      RETURN CASE
               WHEN v_out = '<null>' THEN '0'
               WHEN v_out LIKE '{%' THEN
                 CASE WHEN NOT (v_out::jsonb ? 'success')         THEN 'Y'
                      WHEN (v_out::jsonb ->> 'success') = 'true' THEN 'Y'
                      ELSE 'N' END
               WHEN v_out = 'false' THEN 'N'
               ELSE 'Y'
             END || '|' || v_out;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      RETURN CASE
               WHEN v_state = '42501' AND v_msg LIKE 'permission denied%' THEN 'P'
               WHEN v_state IN ('42501', 'P0001', 'P0002') THEN 'T'
               ELSE 'E'
             END || '|' || v_state || '|' || v_msg;
  END;
END $$;

/** Company A or B's id, its admin's user id (seed.sql), and the other side. */
CREATE OR REPLACE FUNCTION _mx_co(p_side text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_side WHEN 'a' THEN 'c0000000-0000-4000-8000-00000000000a'::uuid
                     ELSE          'c0000000-0000-4000-8000-00000000000b'::uuid END
$$;

CREATE OR REPLACE FUNCTION _mx_admin(p_side text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_side WHEN 'a' THEN 'a0000000-0000-4000-8000-000000000001'::uuid
                     ELSE          'b0000000-0000-4000-8000-000000000001'::uuid END
$$;

CREATE OR REPLACE FUNCTION _mx_other(p_side text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE p_side WHEN 'a' THEN 'b' ELSE 'a' END $$;

/*
  Fill a probe template for one side. Placeholders:
    {s}        a | b
    {co}       that side's company id          {admin}  that side's admin user id
    {id}       this table's probe row id       {new}    a fresh id for an INSERT
    {ref:tbl}  the probe row id of `tbl` on the same side
    {other_co}, {other_admin}, {ref_other:tbl}
               the same for the other side: where a move points the row
*/
CREATE OR REPLACE FUNCTION _mx_fill(p_tpl text, p_tbl text, p_side text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text := p_tpl;
  v_other constant text := _mx_other(p_side);
  v_ref   text;
BEGIN
  IF v_out IS NULL THEN
    RETURN NULL;
  END IF;
  v_out := replace(v_out, '{s}', p_side);
  v_out := replace(v_out, '{co}', quote_literal(_mx_co(p_side)::text));
  v_out := replace(v_out, '{admin}', quote_literal(_mx_admin(p_side)::text));
  v_out := replace(v_out, '{other_co}', quote_literal(_mx_co(v_other)::text));
  v_out := replace(v_out, '{other_admin}', quote_literal(_mx_admin(v_other)::text));
  v_out := replace(v_out, '{id}', quote_literal(_mx_id(p_tbl, p_side)::text));
  v_out := replace(v_out, '{new}', quote_literal(_mx_id(p_tbl, 'new-' || p_side)::text));
  LOOP
    v_ref := substring(v_out FROM '\{ref:([a-z_0-9]+)\}');
    EXIT WHEN v_ref IS NULL;
    v_out := replace(v_out, '{ref:' || v_ref || '}', quote_literal(_mx_id(v_ref, p_side)::text));
  END LOOP;
  LOOP
    v_ref := substring(v_out FROM '\{ref_other:([a-z_0-9]+)\}');
    EXIT WHEN v_ref IS NULL;
    v_out := replace(v_out, '{ref_other:' || v_ref || '}', quote_literal(_mx_id(v_ref, v_other)::text));
  END LOOP;
  RETURN v_out;
END $$;

/** The principals in column order: the names the report prints, and their logins. */
CREATE OR REPLACE FUNCTION _mx_who_names() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['anon', 'viewer', 'editor', 'supervisor', 'admin', 'other', 'super',
               'staff_view', 'staff_support']
$$;

CREATE OR REPLACE FUNCTION _mx_who_logins() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['anon', 'viewer-a', 'editor-a', 'supervisor-a', 'admin-a', 'admin-b', 'super',
               'staff-view', 'staff-support']
$$;

-- ─── the probe itself, before anything relies on it ─────────────────────────
/*
  `_mx_try` must not be maskable by the owner pass that runs beside it.

  This section builds PR #117's shape out of nothing — a schema nobody may use,
  a SECURITY INVOKER trigger on a `public` table that calls into it — and walks
  the sequence this file walks: the owner writes the row, then a principal
  writes it. If the plan cache is still deciding the answer, the principal is
  allowed and every table line below is worth less than it looks.

  Three steps, and the middle one is the control:

    1  the owner's write succeeds, and the trigger's call is now cached
    2  a principal writes *without* the guard, by hand. It must be ALLOWED —
       that is the mask, and it is what makes step 3 mean something. If it is
       refused, the artefact no longer reproduces on this PostgreSQL; that is a
       WARNING and not a failure, because the guard is then merely unnecessary
    3  the same write through `_mx_try`, which discards the plans first, must be
       refused `42501 permission denied for schema _mx_unreachable`

  Step 3 is what fails when the guard in `_mx_become` is reverted or when
  `matrix.uncache` is 'off'. It runs before the fixtures so the instrument is
  checked before the measurements are taken, and it drops everything it made so
  the UNCOVERED scan at the end of the table matrix has nothing extra to report.

  A standalone version of the same experiment, with controls for function
  EXECUTE and table privileges, is tests/tools/plan-cache-repro.sql. It is not
  part of the kit.
*/
CREATE SCHEMA _mx_unreachable;
CREATE FUNCTION _mx_unreachable.answer() RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;

CREATE TABLE public._mx_plan_cache_rows (note text);
GRANT INSERT ON public._mx_plan_cache_rows TO authenticated;

-- SECURITY INVOKER, which is the default: the body is parsed as whoever writes
-- the table, and `authenticated` holds no USAGE on _mx_unreachable.
CREATE FUNCTION public._mx_plan_cache_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM _mx_unreachable.answer();
  RETURN NEW;
END $$;

CREATE TRIGGER _mx_plan_cache_guard BEFORE INSERT ON public._mx_plan_cache_rows
  FOR EACH ROW EXECUTE FUNCTION public._mx_plan_cache_guard();

DO $plancache$
DECLARE
  c_write CONSTANT text := $q$INSERT INTO public._mx_plan_cache_rows (note) VALUES ('probe')$q$;
  v_owner   text;
  v_masked  text;
  v_guarded text;
  v_state   text;
  v_msg     text;
BEGIN
  -- 0. The premise. If `authenticated` could use the schema after all, every
  --    step below would be ALLOWED and step 3 would report a missing guard
  --    that is in fact present.
  IF has_schema_privilege('authenticated', '_mx_unreachable', 'USAGE') THEN
    RAISE EXCEPTION 'plan-cache section: authenticated holds USAGE on _mx_unreachable, so this probe tests nothing';
  END IF;

  -- 1. The owner's pass, twice, for two different reasons.
  --
  --    Through `_mx_try` first, because that is this file's own test that a
  --    probe statement is valid — a refusal below must not be a malformed
  --    INSERT in disguise. That pass is rolled back with its subtransaction.
  --
  --    Then as a plain statement, which is the fixture loop's shape and the
  --    warming that actually happens in this file: it is not inside anything
  --    that will unwind, so the trigger's cached call cannot depend on how
  --    plpgsql treats a plan prepared inside an aborted subtransaction.
  v_owner := _mx_try('owner', NULL, c_write);
  IF v_owner <> 'Y' THEN
    RAISE EXCEPTION 'plan-cache section: the owner could not write the probe row (%), so nothing below it means anything', v_owner;
  END IF;
  EXECUTE c_write;

  -- 2. The control: a principal, by hand, with the cache left warm.
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    EXECUTE c_write;
    EXECUTE 'SET LOCAL ROLE NONE';
    v_masked := 'ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    EXECUTE 'SET LOCAL ROLE NONE';
    v_masked := v_state || ' ' || v_msg;
  END;

  IF v_masked = 'ALLOWED' THEN
    RAISE NOTICE 'ok  plan-cache control: the owner''s pass does mask a schema refusal from a principal';
  ELSIF v_masked LIKE '42501 permission denied for schema%' THEN
    RAISE WARNING 'the plan-cache mask did not reproduce (%). Either this PostgreSQL re-checks schema USAGE on a cached plan, or this probe no longer reproduces it. The guard below is then unnecessary rather than wrong — read tests/tools/plan-cache-repro.sql before removing it', v_masked;
  ELSE
    RAISE EXCEPTION 'plan-cache section: the control failed for an unrelated reason (%) — the probe is built wrong', v_masked;
  END IF;

  -- 3. The guard. `_mx_try` discards the plans, so the trigger's call is parsed
  --    again, this time as the principal.
  v_guarded := _mx_try('admin-a', NULL, c_write);
  IF left(v_guarded, 1) <> 'P' OR v_guarded NOT LIKE '%permission denied for schema _mx_unreachable%' THEN
    RAISE EXCEPTION
      'plan-cache guard is gone: a principal writing through a SECURITY INVOKER trigger that reaches a schema it cannot use was answered % — expected P|42501|permission denied for schema _mx_unreachable. Restore the DISCARD PLANS in _mx_become, or set matrix.uncache back to ''on''',
      v_guarded;
  END IF;
  RAISE NOTICE 'ok  plan-cache guard: _mx_try refuses it — %', substr(v_guarded, 3, 80);
END $plancache$;

DROP TRIGGER _mx_plan_cache_guard ON public._mx_plan_cache_rows;
DROP FUNCTION public._mx_plan_cache_guard();
DROP TABLE public._mx_plan_cache_rows;
DROP SCHEMA _mx_unreachable CASCADE;

-- Failures from every section are collected and reported together at the end,
-- so one run shows the whole diff rather than the first cell that moved.
SET client_min_messages = warning;   -- no "does not exist, skipping" on a first run
DROP TABLE IF EXISTS _mx_failures;
DROP TABLE IF EXISTS _mx_spec;
DROP TABLE IF EXISTS _mx_move;
DROP TABLE IF EXISTS _mx_expected;
DROP TABLE IF EXISTS _mx_view_spec;
DROP TABLE IF EXISTS _mx_rpc;
DROP TABLE IF EXISTS _mx_state_company;
RESET client_min_messages;
CREATE TEMP TABLE _mx_failures (section text, item text, detail text);

-- ─── extra principals ───────────────────────────────────────────────────────
-- seed.sql's five principals plus a supervisor, and the principals the
-- server-side enforcement section needs: one admin per company state, each
-- company with a driver and a trip of its own, and one user per inactive
-- account status inside company A.
--
-- The company states are every value the CHECK constraints allow that the UI
-- blocks today (App.tsx, AuthContext.tsx), plus one it does not block: a company
-- with a live subscription (it was a trial company until 20261015170000, which
-- removed the status), the control that must stay allowed when
-- phase 3.3 moves enforcement into the database.
--
-- Two states this list used to carry are gone with 20260919150000 (plan 3.F
-- step U1), and their absence is the point: approval_status and
-- subscription_status no longer admit 'suspended', so a suspension lives in
-- companies.status and nowhere else. The CHECK constraints refuse the other two
-- values outright, which is asserted in tests/rls/subscriptions.sql rather than
-- here — a row this file cannot insert is not a matrix cell.
--
--   was ('subsuspended', …, 'approved', 'active', 'suspended', NULL)
--   was ('suspended',    …, 'suspended', 'suspended', 'active', NULL)

CREATE TEMP TABLE _mx_state_company (slug text, label text, approval_status text, status text,
                                     subscription_status text, subscription_expires_at timestamptz);
INSERT INTO _mx_state_company VALUES
  ('subinactive',     'company whose subscription is inactive',        'approved',  'active',    'inactive',  NULL),
  ('subexpiredstatus','company whose subscription status is expired',  'approved',  'active',    'expired',   NULL),
  ('subexpired',      'company whose subscription expired yesterday',  'approved',  'active',    'active',    now() - interval '1 day'),
  ('pending',         'company still pending approval',                'pending',   'active',    'active',    NULL),
  ('rejected',        'rejected company',                              'rejected',  'active',    'active',    NULL),
  ('suspended',       'suspended company (companies.status, the one suspension state)',
                                                                       'approved',  'suspended', 'active',    NULL),
  ('statusinactive',  'approved company whose status is inactive',     'approved',  'inactive',  'active',    NULL),
  ('livesub',         'company with a live subscription',              'approved',  'active',    'active',    now() + interval '30 days');

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status, subscription_expires_at)
SELECT _mx_id('company', s.slug), 'MX ' || s.slug, 'mx-' || s.slug, s.approval_status, s.status, 'basic',
       s.subscription_status, s.subscription_expires_at
FROM _mx_state_company s
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (id, email)
SELECT _mx_id('user', v.who), v.who || '@test.invalid'
FROM (SELECT 'admin-' || slug FROM _mx_state_company
      UNION ALL VALUES ('supervisor-a'), ('deactivated-a'), ('suspended-a'), ('inactive-a'), ('pendinginvite-a')) AS v(who)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, is_super_admin, status, must_change_password)
SELECT _mx_id('user', v.who), v.who || '@test.invalid', v.who, v.role,
       (SELECT id FROM roles WHERE name = v.role AND company_id IS NULL LIMIT 1),
       v.company_id, false, v.status, false
FROM (
  SELECT 'admin-' || slug, 'admin', _mx_id('company', slug), 'active' FROM _mx_state_company
  UNION ALL VALUES
  ('supervisor-a',    'supervisor', 'c0000000-0000-4000-8000-00000000000a'::uuid, 'active'),
  ('deactivated-a',   'admin',      'c0000000-0000-4000-8000-00000000000a'::uuid, 'deactivated'),
  ('suspended-a',     'editor',     'c0000000-0000-4000-8000-00000000000a'::uuid, 'suspended'),
  ('inactive-a',      'editor',     'c0000000-0000-4000-8000-00000000000a'::uuid, 'inactive'),
  ('pendinginvite-a', 'editor',     'c0000000-0000-4000-8000-00000000000a'::uuid, 'pending_invite')
) AS v(who, role, company_id, status)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO drivers (id, company_id, name)
SELECT _mx_id('state-driver', s.slug), _mx_id('company', s.slug), 'MX state driver'
FROM _mx_state_company s
ON CONFLICT (id) DO NOTHING;

INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by)
SELECT _mx_id('state-import', s.slug), _mx_id('company', s.slug), 1, 2026, 'mx-state.xlsx', _mx_id('user', 'admin-' || s.slug)
FROM _mx_state_company s
ON CONFLICT (id) DO NOTHING;

-- start and end time because reassign_fahrtenbuch_trip copies them into
-- fahrtenbuch_assignment_audit, where both are NOT NULL
INSERT INTO fahrtenbuch_trips (id, company_id, import_id, trip_date, start_time, end_time, original_driver_name, assigned_driver_name)
SELECT _mx_id('state-trip', s.slug), _mx_id('company', s.slug), _mx_id('state-import', s.slug), '2026-01-05', '08:00', '09:00', 'MX', 'MX'
FROM _mx_state_company s
ON CONFLICT (id) DO NOTHING;

-- ─── the two staff principals, and the contexts they hold ───────────────────
--
-- Both are owners in app_private.platform_staff with no company of their own,
-- exactly like `super`; the only difference is the open context. `super` gets a
-- sign-in session too, so the context RPCs can be probed as an owner that has
-- opened nothing (every RPC probe is rolled back, so nothing it opens survives).
--
-- auth.sessions is GoTrue's and the fixture (--schema=public) does not carry
-- it. 20260917140000 reads it only where a context row exists, so this stub is
-- what those reads resolve against; it goes with the file's ROLLBACK.

CREATE TABLE IF NOT EXISTS auth.sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  not_after  timestamptz
);

INSERT INTO auth.users (id, email)
SELECT _mx_id('user', v.who), v.who || '@test.invalid'
FROM (VALUES ('staff-view'), ('staff-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

-- role 'viewer' and no company: platform rights come from the staff row, and a
-- viewer's can_edit is false everywhere, so a write these two are allowed to
-- make is the support session's doing and not the profile's.
INSERT INTO user_profiles (user_id, email, full_name, role, company_id, status)
SELECT _mx_id('user', v.who), v.who || '@test.invalid', 'MX ' || v.who, 'viewer', NULL, 'active'
FROM (VALUES ('staff-view'), ('staff-support')) AS v(who)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
SELECT _mx_id('user', v.who), 'owner', 'mx context principal'
FROM (VALUES ('staff-view'), ('staff-support')) AS v(who)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
SELECT _mx_id('session', v.who), v.uid
FROM (VALUES ('staff-view',    _mx_id('user', 'staff-view')),
             ('staff-support', _mx_id('user', 'staff-support')),
             ('super',         '50000000-0000-4000-8000-000000000001'::uuid)) AS v(who, uid)
ON CONFLICT (id) DO NOTHING;

INSERT INTO app_private.platform_company_contexts
  (staff_user_id, company_id, mode, reason, session_id, expires_at)
VALUES
  (_mx_id('user', 'staff-view'),    _mx_co('a'), 'view',    NULL,
   _mx_id('session', 'staff-view'),    now() + interval '60 minutes'),
  (_mx_id('user', 'staff-support'), _mx_co('a'), 'support', 'MX support session',
   _mx_id('session', 'staff-support'), now() + interval '60 minutes')
ON CONFLICT DO NOTHING;

-- ─── the probe rows, and how each table is probed ───────────────────────────
-- One line per table, in dependency order so a row's parents exist before it.
-- `fixture` creates the probe row, `ins` is the INSERT probe (with `ins_pre`
-- run first as the owner when the slot must be free), `upd` is a SET clause
-- that changes nothing, so a refusal is about who asks and never about what
-- was written. SELECT, UPDATE, DELETE and the move address the row through
-- `key`; what a move writes is in `_mx_move` below.

CREATE TEMP TABLE _mx_spec (ord int, tbl text, key text, fixture text, ins_pre text, ins text, upd text);

INSERT INTO _mx_spec VALUES
( 1, 'companies', $q$id = {co}$q$, NULL, NULL,
  $q$INSERT INTO companies (id, name, slug) VALUES ({new}, 'MX new {s}', 'mx-new-{s}')$q$,
  $q$name = name$q$),
( 2, 'company_settings', $q$company_id = {co}$q$, NULL,
  $q$DELETE FROM company_settings WHERE company_id = {co}$q$,
  $q$INSERT INTO company_settings (company_id, company_name) VALUES ({co}, 'MX {s}')$q$,
  $q$company_name = company_name$q$),
( 3, 'roles', $q$id = {id}$q$,
  $q$INSERT INTO roles (id, name, company_id, is_system) VALUES ({id}, 'mx-role-{s}', {co}, false)$q$, NULL,
  $q$INSERT INTO roles (name, company_id, is_system) VALUES ('mx-role-new-{s}', {co}, false)$q$,
  $q$description = description$q$),
( 4, 'role_permissions', $q$id = {id}$q$,
  $q$INSERT INTO role_permissions (id, role_id, page_key, can_view, can_edit) VALUES ({id}, {ref:roles}, 'drivers', true, false)$q$, NULL,
  $q$INSERT INTO role_permissions (role_id, page_key, can_view, can_edit) VALUES ({ref:roles}, 'cars', true, false)$q$,
  $q$can_view = can_view$q$),
( 5, 'user_profiles', $q$user_id = {id}$q$,
  $q$INSERT INTO auth.users (id, email) VALUES ({id}, 'member-{s}@test.invalid');
     INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
     VALUES ({id}, 'member-{s}@test.invalid', 'Member {s}', 'viewer',
             (SELECT id FROM roles WHERE name = 'viewer' AND company_id IS NULL), {co}, 'active')$q$,
  $q$INSERT INTO auth.users (id, email) VALUES ({new}, 'new-{s}@test.invalid')$q$,
  $q$INSERT INTO user_profiles (user_id, email, role, company_id) VALUES ({new}, 'new-{s}@test.invalid', 'viewer', {co})$q$,
  $q$full_name = full_name$q$),
( 6, 'user_sessions', $q$session_token = 'mx-session-{s}'$q$,
  $q$INSERT INTO user_sessions (user_id, session_token) VALUES ({admin}, 'mx-session-{s}')$q$, NULL,
  $q$INSERT INTO user_sessions (user_id, session_token) VALUES ({admin}, 'mx-session-new-{s}')$q$,
  $q$last_active_at = last_active_at$q$),
( 7, 'drivers', $q$id = {id}$q$,
  $q$INSERT INTO drivers (id, company_id, name) VALUES ({id}, {co}, 'MX driver {s}');
     INSERT INTO drivers (id, company_id, name) VALUES ({ref:drivers2}, {co}, 'MX second driver {s}')$q$, NULL,
  $q$INSERT INTO drivers (company_id, name) VALUES ({co}, 'MX new driver {s}')$q$,
  $q$name = name$q$),
( 8, 'cars', $q$id = {id}$q$,
  $q$INSERT INTO cars (id, company_id, kennzeichen, created_by) VALUES ({id}, {co}, 'MX-{s}-1', {admin})$q$, NULL,
  $q$INSERT INTO cars (company_id, kennzeichen, created_by) VALUES ({co}, 'MX-{s}-NEW', {admin})$q$,
  $q$kennzeichen = kennzeichen$q$),
( 9, 'car_driver_assignments', $q$id = {id}$q$,
  $q$INSERT INTO car_driver_assignments (id, car_id, driver_id, created_by, company_id) VALUES ({id}, {ref:cars}, {ref:drivers}, {admin}, {co})$q$, NULL,
  $q$INSERT INTO car_driver_assignments (car_id, driver_id, created_by, company_id, role) VALUES ({ref:cars}, {ref:drivers2}, {admin}, {co}, 'hauptfahrer_2')$q$,
  $q$role = role$q$),
(10, 'cash_transactions', $q$id = {id}$q$,
  $q$INSERT INTO cash_transactions (id, transaction_type, amount, description, created_by, company_id) VALUES ({id}, 'deposit', 1, 'mx', 'mx', {co})$q$, NULL,
  $q$INSERT INTO cash_transactions (transaction_type, amount, description, created_by, company_id) VALUES ('deposit', 1, 'mx new', 'mx', {co})$q$,
  $q$description = description$q$),
(11, 'income', $q$id = {id}$q$,
  $q$INSERT INTO income (id, description, amount, type, driver_name, company_id) VALUES ({id}, 'mx', 1, 'bargeld', 'MX', {co})$q$, NULL,
  $q$INSERT INTO income (description, amount, type, driver_name, company_id) VALUES ('mx new', 1, 'bargeld', 'MX', {co})$q$,
  $q$description = description$q$),
(12, 'receipts', $q$id = {id}$q$,
  $q$INSERT INTO receipts (id, receipt_number, date, description, driver_name, company_id) VALUES ({id}, 'BEL-MX-{s}', current_date, 'mx', 'MX', {co})$q$, NULL,
  $q$INSERT INTO receipts (receipt_number, date, description, driver_name, company_id) VALUES ('BEL-MX-NEW-{s}', current_date, 'mx', 'MX', {co})$q$,
  $q$description = description$q$),
(13, 'fixed_costs', $q$id = {id}$q$,
  $q$INSERT INTO fixed_costs (id, description, company_id) VALUES ({id}, 'mx', {co})$q$, NULL,
  $q$INSERT INTO fixed_costs (description, company_id) VALUES ('mx new', {co})$q$,
  $q$description = description$q$),
(14, 'documents', $q$id = {id}$q$,
  $q$INSERT INTO documents (id, title, created_by, company_id) VALUES ({id}, 'mx', {admin}, {co})$q$, NULL,
  $q$INSERT INTO documents (title, created_by, company_id) VALUES ('mx new', {admin}, {co})$q$,
  $q$title = title$q$),
(15, 'document_blocks', $q$id = {id}$q$,
  $q$INSERT INTO document_blocks (id, document_id, block_type) VALUES ({id}, {ref:documents}, 'title')$q$, NULL,
  $q$INSERT INTO document_blocks (document_id, block_type) VALUES ({ref:documents}, 'paragraph')$q$,
  $q$"order" = "order"$q$),
(16, 'document_variables', $q$id = {id}$q$,
  $q$INSERT INTO document_variables (id, document_id, label, key) VALUES ({id}, {ref:documents}, 'mx', 'mx_key')$q$, NULL,
  $q$INSERT INTO document_variables (document_id, label, key) VALUES ({ref:documents}, 'mx new', 'mx_new_key')$q$,
  $q$label = label$q$),
(17, 'document_templates', $q$id = {id}$q$,
  $q$INSERT INTO document_templates (id, name, file_path, file_url, company_id) VALUES ({id}, 'mx', 'mx/path', 'mx-url', {co})$q$, NULL,
  $q$INSERT INTO document_templates (name, file_path, file_url, company_id) VALUES ('mx new', 'mx/new', 'mx-new-url', {co})$q$,
  $q$name = name$q$),
(18, 'document_categories', $q$id = {id}$q$,
  $q$INSERT INTO document_categories (id, name) VALUES ({id}, 'MX category {s}')$q$, NULL,
  $q$INSERT INTO document_categories (name) VALUES ('MX category new {s}')$q$,
  $q$name = name$q$),
(19, 'driver_notes', $q$id = {id}$q$,
  $q$INSERT INTO driver_notes (id, created_by, driver_id, note_text, company_id) VALUES ({id}, {admin}, {ref:drivers}, 'mx', {co})$q$, NULL,
  $q$INSERT INTO driver_notes (created_by, driver_id, note_text, company_id) VALUES ({admin}, {ref:drivers}, 'mx new', {co})$q$,
  $q$note_text = note_text$q$),
(20, 'salaries', $q$id = {id}$q$,
  $q$INSERT INTO salaries (id, driver_id, period_start, period_end, created_by, company_id) VALUES ({id}, {ref:drivers}, '2026-01-01', '2026-01-31', {admin}, {co})$q$, NULL,
  $q$INSERT INTO salaries (driver_id, period_start, period_end, created_by, company_id) VALUES ({ref:drivers}, '2026-02-01', '2026-02-28', {admin}, {co})$q$,
  $q$notes = notes$q$),
(21, 'salary_payments', $q$id = {id}$q$,
  $q$INSERT INTO salary_payments (id, salary_id, payment_type, amount, company_id) VALUES ({id}, {ref:salaries}, 'cash', 1, {co})$q$, NULL,
  $q$INSERT INTO salary_payments (salary_id, payment_type, amount, company_id) VALUES ({ref:salaries}, 'bank', 1, {co})$q$,
  $q$description = description$q$),
-- The two statements below name `check_date`, and they must keep naming it.
-- The column defaults to CURRENT_DATE, so before 20260928121500 both rows landed
-- on today and the old key `(car_id, week_number, year)` still told them apart by
-- their week_number. The new key is `(car_id, date_trunc('week', check_date))`,
-- which does not read week_number at all — so with the default both rows fall in
-- one calendar week and the probe's INSERT dies 23505 for every principal that
-- RLS would have admitted. That would report a uniqueness collision as an
-- authorization result, which is not what this row measures.
-- Fixed dates a fortnight apart, so the probe keeps measuring the policy.
(22, 'werkstatt_checks', $q$id = {id}$q$,
  $q$INSERT INTO werkstatt_checks (id, car_id, week_number, year, check_date, created_by, company_id) VALUES ({id}, {ref:cars}, 1, 2026, DATE '2026-01-05', {admin}, {co})$q$, NULL,
  $q$INSERT INTO werkstatt_checks (car_id, week_number, year, check_date, created_by, company_id) VALUES ({ref:cars}, 2, 2026, DATE '2026-01-19', {admin}, {co})$q$,
  $q$notes = notes$q$),
(23, 'fahrtenbuch_imports', $q$id = {id}$q$,
  $q$INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by) VALUES ({id}, {co}, 1, 2026, 'mx.xlsx', {admin})$q$, NULL,
  $q$INSERT INTO fahrtenbuch_imports (company_id, month, year, file_name, imported_by) VALUES ({co}, 2, 2026, 'mx-new.xlsx', coalesce(auth.uid(), {admin}))$q$,
  $q$notes = notes$q$),
(24, 'fahrtenbuch_trips', $q$id = {id}$q$,
  -- start and end time: reassign_fahrtenbuch_trip copies both into the audit, where they are NOT NULL
  $q$INSERT INTO fahrtenbuch_trips (id, company_id, import_id, trip_date, start_time, end_time, original_driver_name, assigned_driver_name) VALUES ({id}, {co}, {ref:fahrtenbuch_imports}, '2026-01-05', '08:00', '09:00', 'MX', 'MX')$q$, NULL,
  $q$INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name, assigned_driver_name) VALUES ({co}, {ref:fahrtenbuch_imports}, '2026-01-06', 'MX', 'MX')$q$,
  $q$assignment_note = assignment_note$q$),
(25, 'fahrtenbuch_assignment_audit', $q$id = {id}$q$,
  $q$INSERT INTO fahrtenbuch_assignment_audit (id, company_id, trip_id, trip_date, start_time, end_time, price_amount, original_driver_name, new_assigned_driver_name, changed_by)
     VALUES ({id}, {co}, {ref:fahrtenbuch_trips}, '2026-01-05', '08:00', '09:00', 0, 'MX', 'MX', {admin})$q$, NULL,
  $q$INSERT INTO fahrtenbuch_assignment_audit (company_id, trip_id, trip_date, start_time, end_time, price_amount, original_driver_name, new_assigned_driver_name, changed_by)
     VALUES ({co}, {ref:fahrtenbuch_trips}, '2026-01-05', '08:00', '09:00', 0, 'MX', 'MX', coalesce(auth.uid(), {admin}))$q$,
  $q$reason = reason$q$),
(26, 'company_planning_runs', $q$id = {id}$q$,
  $q$INSERT INTO company_planning_runs (id, company_id, month, year) VALUES ({id}, {co}, 1, 2026)$q$, NULL,
  $q$INSERT INTO company_planning_runs (company_id, month, year) VALUES ({co}, 2, 2026)$q$,
  $q$status = status$q$),
(27, 'company_planning_run_blocks', $q$id = {id}$q$,
  $q$INSERT INTO company_planning_run_blocks (id, company_id, run_id, block_date) VALUES ({id}, {co}, {ref:company_planning_runs}, '2026-01-05')$q$, NULL,
  $q$INSERT INTO company_planning_run_blocks (company_id, run_id, block_date) VALUES ({co}, {ref:company_planning_runs}, '2026-01-06')$q$,
  $q$reason = reason$q$),
(28, 'monthly_planning_manual_exceptions', $q$id = {id}$q$,
  $q$INSERT INTO monthly_planning_manual_exceptions (id, planning_run_id, company_id, block_id) VALUES ({id}, {ref:company_planning_runs}, {co}, 'mx-block')$q$, NULL,
  $q$INSERT INTO monthly_planning_manual_exceptions (planning_run_id, company_id, block_id) VALUES ({ref:company_planning_runs}, {co}, 'mx-block-new')$q$,
  $q$reason = reason$q$),
(29, 'planning_finalizations', $q$id = {id}$q$,
  $q$INSERT INTO planning_finalizations (id, planning_run_id, company_id) VALUES ({id}, {ref:company_planning_runs}, {co})$q$, NULL,
  $q$INSERT INTO planning_finalizations (planning_run_id, company_id) VALUES ({ref:company_planning_runs}, {co})$q$,
  $q$stale_reason = stale_reason$q$),
(30, 'planning_run_adjustments', $q$id = {id}$q$,
  $q$INSERT INTO planning_run_adjustments (id, planning_run_id, company_id, driver_id, driver_name, hours, amount, hourly_rate) VALUES ({id}, {ref:company_planning_runs}, {co}, 'mx', 'MX', 1, 1, 1)$q$, NULL,
  $q$INSERT INTO planning_run_adjustments (planning_run_id, company_id, driver_id, driver_name, hours, amount, hourly_rate) VALUES ({ref:company_planning_runs}, {co}, 'mx', 'MX', 2, 2, 1)$q$,
  $q$note = note$q$),
(31, 'historical_reconciliations', $q$id = {id}$q$,
  $q$INSERT INTO historical_reconciliations (id, company_id, month, year) VALUES ({id}, {co}, 1, 2026)$q$, NULL,
  $q$INSERT INTO historical_reconciliations (company_id, month, year) VALUES ({co}, 2, 2026)$q$,
  $q$notes = notes$q$),
(32, 'historical_reconciliation_drivers', $q$id = {id}$q$,
  $q$INSERT INTO historical_reconciliation_drivers (id, reconciliation_id, driver_id, driver_name) VALUES ({id}, {ref:historical_reconciliations}, {ref:drivers}, 'MX')$q$, NULL,
  $q$INSERT INTO historical_reconciliation_drivers (reconciliation_id, driver_id, driver_name) VALUES ({ref:historical_reconciliations}, {ref:drivers2}, 'MX')$q$,
  $q$driver_name = driver_name$q$),
(33, 'historical_reconciliation_results', $q$id = {id}$q$,
  $q$INSERT INTO historical_reconciliation_results (id, reconciliation_id, driver_id) VALUES ({id}, {ref:historical_reconciliations}, {ref:drivers})$q$, NULL,
  $q$INSERT INTO historical_reconciliation_results (reconciliation_id, driver_id) VALUES ({ref:historical_reconciliations}, {ref:drivers2})$q$,
  $q$rows_json = rows_json$q$),
(34, 'historical_reconciliation_wh_drivers', $q$id = {id}$q$,
  $q$INSERT INTO historical_reconciliation_wh_drivers (id, reconciliation_id, driver_id, driver_name) VALUES ({id}, {ref:historical_reconciliations}, {ref:drivers}, 'MX')$q$, NULL,
  $q$INSERT INTO historical_reconciliation_wh_drivers (reconciliation_id, driver_id, driver_name) VALUES ({ref:historical_reconciliations}, {ref:drivers2}, 'MX')$q$,
  $q$hinweis = hinweis$q$),
(35, 'historical_block_adjustments', $q$id = {id}$q$,
  $q$INSERT INTO historical_block_adjustments (id, company_id, block_id) VALUES ({id}, {co}, 'mx')$q$, NULL,
  $q$INSERT INTO historical_block_adjustments (company_id, block_id) VALUES ({co}, 'mx-new')$q$,
  $q$reason = reason$q$),
(36, 'historical_driver_hour_targets', $q$id = {id}$q$,
  $q$INSERT INTO historical_driver_hour_targets (id, company_id, driver_id, driver_name, month, year) VALUES ({id}, {co}, {ref:drivers}, 'MX', '01', 2026)$q$, NULL,
  $q$INSERT INTO historical_driver_hour_targets (company_id, driver_id, driver_name, month, year) VALUES ({co}, {ref:drivers2}, 'MX 2', '01', 2026)$q$,
  $q$driver_name = driver_name$q$),
(37, 'historical_payroll_targets', $q$id = {id}$q$,
  $q$INSERT INTO historical_payroll_targets (id, company_id, month, year, driver_id, wage_type_code, wage_type_label) VALUES ({id}, {co}, 1, 2026, {ref:drivers}, '1000', 'Grundlohn')$q$, NULL,
  $q$INSERT INTO historical_payroll_targets (company_id, month, year, driver_id, wage_type_code, wage_type_label) VALUES ({co}, 1, 2026, {ref:drivers}, '1500', 'Nacht')$q$,
  $q$wage_type_label = wage_type_label$q$),
(38, 'historical_time_adjustments', $q$id = {id}$q$,
  $q$INSERT INTO historical_time_adjustments (id, company_id, original_start_time, original_end_time, adjusted_start_time, adjusted_end_time, duration_minutes) VALUES ({id}, {co}, '08:00', '09:00', '08:00', '09:00', 60)$q$, NULL,
  $q$INSERT INTO historical_time_adjustments (company_id, original_start_time, original_end_time, adjusted_start_time, adjusted_end_time, duration_minutes) VALUES ({co}, '10:00', '11:00', '10:00', '11:00', 60)$q$,
  $q$reason = reason$q$),
(39, 'historical_wh_saved_plans', $q$id = {id}$q$,
  $q$INSERT INTO historical_wh_saved_plans (id, company_id, month, year) VALUES ({id}, {co}, 1, 2026)$q$, NULL,
  $q$INSERT INTO historical_wh_saved_plans (company_id, month, year) VALUES ({co}, 2, 2026)$q$,
  $q$export_block_reason = export_block_reason$q$),
(40, 'saved_stundennachweise', $q$id = {id}$q$,
  $q$INSERT INTO saved_stundennachweise (id, company_id, driver_id, driver_name, month, year) VALUES ({id}, {co}, {ref:drivers}, 'MX', 1, 2026)$q$, NULL,
  $q$INSERT INTO saved_stundennachweise (company_id, driver_id, driver_name, month, year) VALUES ({co}, {ref:drivers}, 'MX', 2, 2026)$q$,
  $q$driver_name = driver_name$q$),
(41, 'notification_settings', $q$id = {id}$q$,
  $q$INSERT INTO notification_settings (id, company_id, notification_type) VALUES ({id}, {co}, 'tuev_abgelaufen')$q$, NULL,
  $q$INSERT INTO notification_settings (company_id, notification_type) VALUES ({co}, 'tuev_bald_ablaufend')$q$,
  $q$enabled = enabled$q$),
(42, 'subscription_plans', $q$id = {id}$q$,
  $q$INSERT INTO subscription_plans (id, name, monthly_price, included_cars) VALUES ({id}, 'MX plan {s}', 20, 1)$q$, NULL,
  $q$INSERT INTO subscription_plans (name, monthly_price, included_cars) VALUES ('MX plan new {s}', 20, 1)$q$,
  $q$name = name$q$),
(43, 'company_subscriptions', $q$id = {id}$q$,
  -- its own plan, so the subscription_plans DELETE probe targets a plan nothing references
  $q$INSERT INTO subscription_plans (id, name, monthly_price, included_cars) VALUES ({ref:plan_in_use}, 'MX plan in use {s}', 20, 1);
     INSERT INTO company_subscriptions (id, company_id, plan_id, monthly_price) VALUES ({id}, {co}, {ref:plan_in_use}, 20)$q$, NULL,
  $q$INSERT INTO company_subscriptions (company_id, plan_id, monthly_price) VALUES ({co}, {ref:plan_in_use}, 30)$q$,
  $q$notes = notes$q$),
(44, 'subscription_invoices', $q$id = {id}$q$,
  $q$INSERT INTO subscription_invoices (id, company_id, subscription_id, invoice_month, invoice_year, invoice_number, amount, due_date)
     VALUES ({id}, {co}, {ref:company_subscriptions}, 1, 2026, CASE '{s}' WHEN 'a' THEN 'INV-2026-0901' ELSE 'INV-2026-0902' END, 20, '2026-01-31')$q$, NULL,
  $q$INSERT INTO subscription_invoices (company_id, subscription_id, invoice_month, invoice_year, invoice_number, amount, due_date)
     VALUES ({co}, {ref:company_subscriptions}, 2, 2026, CASE '{s}' WHEN 'a' THEN 'INV-2026-0903' ELSE 'INV-2026-0904' END, 20, '2026-02-28')$q$,
  $q$receipt_note = receipt_note$q$),
(45, 'subscription_payment_audit', $q$id = {id}$q$,
  $q$INSERT INTO subscription_payment_audit (id, invoice_id, company_id, action, changed_by) VALUES ({id}, {ref:subscription_invoices}, {co}, 'mx', {admin})$q$, NULL,
  $q$INSERT INTO subscription_payment_audit (invoice_id, company_id, action, changed_by) VALUES ({ref:subscription_invoices}, {co}, 'mx new', {admin})$q$,
  $q$note = note$q$),
(46, 'subscription_admin_actions', $q$id = {id}$q$,
  $q$INSERT INTO subscription_admin_actions (id, company_id) VALUES ({id}, {co})$q$, NULL,
  $q$INSERT INTO subscription_admin_actions (company_id) VALUES ({co})$q$,
  $q$reason = reason$q$),
(47, 'discount_codes', $q$id = {id}$q$,
  $q$INSERT INTO discount_codes (id, code, discount_type, discount_value, usage_mode, audience_type, active, assigned_company_id)
     VALUES ({id}, 'MX-CODE-{s}', 'percentage', 10, 'once', 'single', true, {co})$q$, NULL,
  $q$INSERT INTO discount_codes (code, discount_type, discount_value, usage_mode, audience_type, active, assigned_company_id)
     VALUES ('MX-CODE-NEW-{s}', 'percentage', 10, 'once', 'single', true, {co})$q$,
  $q$description = description$q$),
(48, 'discount_code_redemptions', $q$id = {id}$q$,
  $q$INSERT INTO discount_code_redemptions (id, discount_code_id, company_id, plan, billing_cycle, car_limit, original_price, discount_amount, final_price, usage_mode)
     VALUES ({id}, {ref:discount_codes}, {co}, 'basic', 'monthly', 1, 20, 2, 18, 'once')$q$, NULL,
  $q$INSERT INTO discount_code_redemptions (discount_code_id, company_id, plan, billing_cycle, car_limit, original_price, discount_amount, final_price, usage_mode)
     VALUES ({ref:discount_codes}, {co}, 'basic', 'monthly', 1, 20, 2, 18, 'once')$q$,
  $q$plan = plan$q$),
(49, 'referrals', $q$id = {id}$q$,
  $q$INSERT INTO referrals (id, ref_code, name) VALUES ({id}, 'MX-REF-{s}', 'MX')$q$, NULL,
  $q$INSERT INTO referrals (ref_code, name) VALUES ('MX-REF-NEW-{s}', 'MX')$q$,
  $q$name = name$q$),
(50, 'activation_codes', $q$id = {id}$q$,
  $q$INSERT INTO activation_codes (id, code_hash, duration_type, expires_at, created_by, company_id) VALUES ({id}, md5('mx-{s}'), '1_monat', now() + interval '1 day', {admin}, {co})$q$, NULL,
  $q$INSERT INTO activation_codes (code_hash, duration_type, expires_at, created_by, company_id) VALUES (md5('mx-new-{s}'), '1_monat', now() + interval '1 day', {admin}, {co})$q$,
  $q$hidden_reason = hidden_reason$q$),
(51, 'activation_code_attempts', $q$id = {id}$q$,
  $q$INSERT INTO activation_code_attempts (id, company_id, user_id, success, reason) VALUES ({id}, {co}, {admin}, false, 'mx')$q$, NULL,
  $q$INSERT INTO activation_code_attempts (company_id, user_id, success, reason) VALUES ({co}, {admin}, false, 'mx new')$q$,
  $q$reason = reason$q$),
-- the Gehaltsquittung ledger (20260914140000). Only its SECURITY DEFINER
-- functions write it, so no client role holds more than SELECT on these tables
(52, 'document_counters', $q$company_id = {co} AND doc_type = 'mx'$q$,
  $q$INSERT INTO document_counters (company_id, doc_type, year, n) VALUES ({co}, 'mx', 2026, 1)$q$, NULL,
  $q$INSERT INTO document_counters (company_id, doc_type, year, n) VALUES ({co}, 'mx_new', 2026, 1)$q$,
  $q$n = n$q$),
(53, 'cash_movements', $q$id = {id}$q$,
  $q$INSERT INTO cash_movements (id, company_id, direction, amount, movement_date, source_type, source_id) VALUES ({id}, {co}, 'out', 1, '2026-01-05', 'gehaltsquittung', {ref:cash_movement_source})$q$, NULL,
  $q$INSERT INTO cash_movements (company_id, direction, amount, movement_date, source_type, source_id) VALUES ({co}, 'out', 1, '2026-01-06', 'gehaltsquittung', {ref:cash_movement_source_new})$q$,
  $q$description = description$q$),
(54, 'salary_cash_receipts', $q$id = {id}$q$,
  -- A salary of its own, on the second driver, so no salaries or drivers probe
  -- meets the receipt's ON DELETE RESTRICT. Numbered in 2000, a year the
  -- confirm probe in the rpc section never numbers in.
  $q$INSERT INTO salaries (id, driver_id, period_start, period_end, created_by, company_id, netto_salary) VALUES ({ref:receipt_salary}, {ref:drivers2}, '2026-03-01', '2026-03-31', {admin}, {co}, 1);
     INSERT INTO salary_cash_receipts (id, company_id, request_id, receipt_number, salary_id, driver_id, period_start, period_end,
                                       business_month, business_year, amount, payment_date, place, is_partial, due_amount,
                                       paid_cash_manual_before, paid_cash_weekly_before, paid_cash_receipts_before, paid_bank_before,
                                       remaining_before, remaining_after)
     VALUES ({id}, {co}, {ref:receipt_request}, 'GQ-2000-0001', {ref:receipt_salary}, {ref:drivers2}, '2026-03-01', '2026-03-31',
             3, 2026, 1, '2026-03-31', 'MX', false, 1, 0, 0, 0, 0, 1, 0)$q$, NULL,
  $q$INSERT INTO salary_cash_receipts (company_id, request_id, receipt_number, salary_id, driver_id, period_start, period_end,
                                       business_month, business_year, amount, payment_date, place, is_partial, due_amount,
                                       paid_cash_manual_before, paid_cash_weekly_before, paid_cash_receipts_before, paid_bank_before,
                                       remaining_before, remaining_after)
     VALUES ({co}, {ref:receipt_request_new}, 'GQ-2000-0002', {ref:receipt_salary}, {ref:drivers2}, '2026-03-01', '2026-03-31',
             3, 2026, 1, '2026-03-31', 'MX', false, 1, 0, 0, 0, 0, 1, 0)$q$,
  $q$place = place$q$),
-- The one subscription model (20260919150000, plan 3.F step U1). Like the
-- Gehaltsquittung ledger above, only its SECURITY DEFINER helpers write it, so
-- no client role holds more than SELECT; unlike the tenant tables, its SELECT
-- predicate is the account shell, because a company whose coverage ran out is
-- exactly the one whose owner has to read it.
(55, 'subscription_coverage', $q$id = {id}$q$,
  $q$INSERT INTO subscription_coverage (id, company_id, source, period_start, period_end) VALUES ({id}, {co}, 'manual', '2026-01-01', '2026-02-01')$q$, NULL,
  $q$INSERT INTO subscription_coverage (company_id, source, period_start, period_end) VALUES ({co}, 'manual', '2026-02-01', '2026-03-01')$q$,
  $q$note = note$q$),
-- The Fahrtenanalyse inputs (20260922110000): the business shape with an
-- administrator gate on every write, and no privilege at all for anon. One
-- settings row per company, so the INSERT probe clears the side's own first.
(56, 'trip_analysis_settings', $q$id = {id}$q$,
  $q$INSERT INTO trip_analysis_settings (id, company_id, block_gap_minutes) VALUES ({id}, {co}, 30)$q$,
  $q$DELETE FROM trip_analysis_settings WHERE company_id = {co}$q$,
  $q$INSERT INTO trip_analysis_settings (company_id, block_gap_minutes) VALUES ({co}, 45)$q$,
  $q$block_gap_minutes = block_gap_minutes$q$),
(57, 'driver_month_budget', $q$id = {id}$q$,
  $q$INSERT INTO driver_month_budget (id, company_id, driver_id, year, month) VALUES ({id}, {co}, {ref:drivers}, 2026, 1)$q$, NULL,
  $q$INSERT INTO driver_month_budget (company_id, driver_id, year, month) VALUES ({co}, {ref:drivers}, 2026, 2)$q$,
  $q$reserved_hours = reserved_hours$q$),
-- The notification job's record of what it has sent (20260924100000). It is the
-- first business table a client cannot write at all: the two writers are
-- SECURITY DEFINER functions granted to service_role, so `authenticated` holds
-- SELECT and nothing else and every I, U, D and M cell is a missing GRANT.
(58, 'notification_deliveries', $q$id = {id}$q$,
  $q$INSERT INTO notification_deliveries (id, company_id, notification_type, target_id, period_key)
     VALUES ({id}, {co}, 'tuev_abgelaufen', {co}, '2099-01-01')$q$, NULL,
  $q$INSERT INTO notification_deliveries (company_id, notification_type, target_id, period_key)
     VALUES ({co}, 'tuev_abgelaufen', {co}, '2098-01-01')$q$,
  $q$recipient_count = recipient_count$q$),
-- The monthly plan (20260930100000): the proposal, its per-driver snapshot, its
-- blocks and the rides they are made of. 20260917130000's business shape with
-- slice C's Dokumente page on every write, so a viewer and an editor read it and
-- write none of it. Each child names the parent above it, and each probe row is
-- a *draft*: a confirmed plan is frozen, so its U and D cells would be T for
-- everybody, the owner included, and would measure the freeze instead of the
-- policies.
(59, 'monthly_plans', $q$id = {id}$q$,
  $q$INSERT INTO monthly_plans (id, company_id, year, month, switch_minutes) VALUES ({id}, {co}, 2026, 10, 30)$q$, NULL,
  $q$INSERT INTO monthly_plans (company_id, year, month, switch_minutes) VALUES ({co}, 2026, 11, 30)$q$,
  $q$switch_minutes = switch_minutes$q$),
-- driver_name and is_owner are the guard's, whatever goes in here.
(60, 'monthly_plan_drivers', $q$id = {id}$q$,
  $q$INSERT INTO monthly_plan_drivers (id, company_id, plan_id, driver_id, driver_name, selected, is_owner)
     VALUES ({id}, {co}, {ref:monthly_plans}, {ref:drivers}, NULL, true, false)$q$, NULL,
  $q$INSERT INTO monthly_plan_drivers (company_id, plan_id, driver_id, driver_name, selected, is_owner)
     VALUES ({co}, {ref:monthly_plans}, {ref:drivers2}, NULL, true, false)$q$,
  $q$selected = selected$q$),
-- An unassigned block, which section 8 asks for anyway and which needs no
-- snapshot row for the guard to resolve a driver name against.
(61, 'monthly_plan_blocks', $q$id = {id}$q$,
  $q$INSERT INTO monthly_plan_blocks (id, company_id, plan_id, block_key, car_identifier, starts_at, ends_at, span_minutes, ride_minutes)
     VALUES ({id}, {co}, {ref:monthly_plans}, 'mx-{s}', 'MX-CAR', '2026-10-01 08:23+02', '2026-10-01 09:44+02', 81, 81)$q$, NULL,
  $q$INSERT INTO monthly_plan_blocks (company_id, plan_id, block_key, car_identifier, starts_at, ends_at, span_minutes, ride_minutes)
     VALUES ({co}, {ref:monthly_plans}, 'mx-new-{s}', 'MX-CAR', '2026-10-02 08:00+02', '2026-10-02 09:00+02', 60, 60)$q$,
  $q$block_key = block_key$q$),
(62, 'monthly_plan_block_trips', $q$id = {id}$q$,
  $q$INSERT INTO monthly_plan_block_trips (id, company_id, plan_id, block_id, trip_id, starts_at, ends_at, minutes, time_source)
     VALUES ({id}, {co}, {ref:monthly_plans}, {ref:monthly_plan_blocks}, {ref:mx_plan_trip}, '2026-10-01 08:23+02', '2026-10-01 09:44+02', 81, 'instants')$q$, NULL,
  $q$INSERT INTO monthly_plan_block_trips (company_id, plan_id, block_id, trip_id, starts_at, ends_at, minutes, time_source)
     VALUES ({co}, {ref:monthly_plans}, {ref:monthly_plan_blocks}, {ref:mx_plan_trip_new}, '2026-10-01 09:50+02', '2026-10-01 10:20+02', 30, 'instants')$q$,
  $q$minutes = minutes$q$),
-- The Reidey partner tables (20261005120000, 20261005130000, 20261005140000,
-- 20261007100000). They are DORMANT -- no edge function writes them and no
-- screen reads them -- and they are the first family in this file whose
-- policies cover only SELECT and UPDATE: there is no INSERT policy and no
-- DELETE policy on any of the four, deliberately, because the writer is to be
-- a SECURITY DEFINER RPC called by an edge function. So every I cell is R for
-- everybody -- the API roles hold the privilege from the image's default
-- privileges, and RLS has no policy to admit the row -- and every D cell is a
-- DELETE that matches nothing and reports success.
--
-- Each row's company is its own column, not a parent's, so the move probe is a
-- plain re-pointing. Both unique keys per table name `partner` or an external
-- id, so the I probe uses a second value rather than colliding with the row
-- the S, U, D and M probes read.
(63, 'partner_connections', $q$id = {id}$q$,
  $q$INSERT INTO partner_connections (id, company_id, partner) VALUES ({id}, {co}, 'mx')$q$, NULL,
  $q$INSERT INTO partner_connections (company_id, partner) VALUES ({co}, 'mx2')$q$,
  $q$last_error = last_error$q$),
(64, 'partner_driver_links', $q$id = {id}$q$,
  $q$INSERT INTO partner_driver_links (id, company_id, partner, external_driver_id)
     VALUES ({id}, {co}, 'mx', 'mx-4711')$q$, NULL,
  $q$INSERT INTO partner_driver_links (company_id, partner, external_driver_id)
     VALUES ({co}, 'mx', 'mx-4712')$q$,
  $q$proposed_name = proposed_name$q$),
(65, 'partner_receipt_submissions', $q$id = {id}$q$,
  $q$INSERT INTO partner_receipt_submissions (id, company_id, partner, external_submission_id, external_driver_id, description)
     VALUES ({id}, {co}, 'mx', 'mx-sub-1', 'mx-4711', 'mx')$q$, NULL,
  $q$INSERT INTO partner_receipt_submissions (company_id, partner, external_submission_id, external_driver_id, description)
     VALUES ({co}, 'mx', 'mx-sub-2', 'mx-4711', 'mx')$q$,
  $q$city = city$q$),
(66, 'partner_note_submissions', $q$id = {id}$q$,
  $q$INSERT INTO partner_note_submissions (id, company_id, partner, external_submission_id, external_driver_id, note_type)
     VALUES ({id}, {co}, 'mx', 'mx-sub-1', 'mx-4711', 'general')$q$, NULL,
  $q$INSERT INTO partner_note_submissions (company_id, partner, external_submission_id, external_driver_id, note_type)
     VALUES ({co}, 'mx', 'mx-sub-2', 'mx-4711', 'general')$q$,
  $q$note_text = note_text$q$),
-- The weekly Abrechnung's schedule and its record of what was mailed
-- (20261003120000), uncovered since the day they were written. The schedule is
-- one row per company and its writes ask for an ADMINISTRATOR, so it is
-- company_settings' shape with a DELETE policy added; `ins_pre` drops the row
-- the unique constraint would collide with, and the whole probe is rolled back
-- so the fixture survives for the next principal. The deliveries are
-- notification_deliveries' shape: SELECT for the company, and the two SECURITY
-- DEFINER job functions as the only writers, so every other cell is a missing
-- GRANT -- including anon's SELECT, which this migration revoked.
(67, 'abrechnung_schedules', $q$company_id = {co}$q$,
  $q$INSERT INTO abrechnung_schedules (company_id, weekday, send_time) VALUES ({co}, 1, '08:00')$q$,
  $q$DELETE FROM abrechnung_schedules WHERE company_id = {co}$q$,
  $q$INSERT INTO abrechnung_schedules (company_id, weekday, send_time) VALUES ({co}, 1, '08:00')$q$,
  $q$weekday = weekday$q$),
(68, 'abrechnung_deliveries', $q$id = {id}$q$,
  $q$INSERT INTO abrechnung_deliveries (id, company_id, kind, target_id, period_key)
     VALUES ({id}, {co}, 'manager_summary', {co}, '2099-01-04')$q$, NULL,
  $q$INSERT INTO abrechnung_deliveries (company_id, kind, target_id, period_key)
     VALUES ({co}, 'manager_summary', {co}, '2098-01-06')$q$,
  $q$recipient_count = recipient_count$q$),
-- The fleet import's links (20261015100000): partner_receipt_submissions' shape,
-- SELECT for the company and the SECURITY DEFINER functions as the only writers.
(69, 'partner_vehicle_links', $q$id = {id}$q$,
  $q$INSERT INTO partner_vehicle_links (id, company_id, partner, external_vehicle_id)
     VALUES ({id}, {co}, 'mx', 'mx-v1')$q$, NULL,
  $q$INSERT INTO partner_vehicle_links (company_id, partner, external_vehicle_id)
     VALUES ({co}, 'mx', 'mx-v2')$q$,
  $q$proposed_plate = proposed_plate$q$),
-- The daily Uber pull's schedule and its record (20261015130000): the
-- abrechnung_schedules / abrechnung_deliveries shapes exactly, one table for
-- each, so the cells below are theirs. The runs have SELECT for the company and
-- the job's SECURITY DEFINER functions as their only writer.
(70, 'uber_pull_schedules', $q$company_id = {co}$q$,
  $q$INSERT INTO uber_pull_schedules (company_id, run_time) VALUES ({co}, '06:00')$q$,
  $q$DELETE FROM uber_pull_schedules WHERE company_id = {co}$q$,
  $q$INSERT INTO uber_pull_schedules (company_id, run_time) VALUES ({co}, '06:00')$q$,
  $q$run_time = run_time$q$),
-- The day differs per side on purpose. uber_pull_runs_once is UNIQUE on
-- (company_id, day_key, pass), so with one day for both companies the MOVE
-- probe collided with the row already standing in the other company -- and it
-- collided for the OWNER too, which makes it a malformed statement rather than
-- a refusal. A probe the owner cannot make measures nothing. {s} is the letter
-- a or b, not a digit, so the side is carried in a CASE over it rather than
-- pasted into the date -- '2099-01-0a' is not a date.
(71, 'uber_pull_runs', $q$id = {id}$q$,
  $q$INSERT INTO uber_pull_runs (id, company_id, day_key, pass)
     VALUES ({id}, {co}, CASE '{s}' WHEN 'a' THEN DATE '2099-01-04' ELSE DATE '2099-01-05' END, 'first')$q$, NULL,
  $q$INSERT INTO uber_pull_runs (company_id, day_key, pass)
     VALUES ({co}, DATE '2098-01-06', 'first')$q$,
  $q$detail = detail$q$),
-- Who receives which company notice (20261015140000): the abrechnung_schedules
-- shape, an administrator writes and everyone in the company reads. The probe
-- address carries the side because the row is unique on the company, the kind
-- and the lower-cased address; the insert probe uses a different address so it
-- never collides with the fixture.
(72, 'notification_recipients', $q$id = {id}$q$,
  $q$INSERT INTO notification_recipients (id, company_id, notification_type, email)
     VALUES ({id}, {co}, 'manager_summary', 'mx-{s}@firma.example')$q$, NULL,
  $q$INSERT INTO notification_recipients (company_id, notification_type, email)
     VALUES ({co}, 'manager_summary', 'mx-new@firma.example')$q$,
  $q$email = email$q$),
-- Who handed the cash back (20261019110000): the business shape with the income
-- page on every write -- cash_transactions' cells, with anon holding no
-- privilege at all. The key is (company, year, month, week, driver name), so
-- the fixture's name carries the side and the insert probe uses another week;
-- moving A's row into B then collides with nothing of B's.
(73, 'abrechnung_handovers', $q$id = {id}$q$,
  $q$INSERT INTO abrechnung_handovers (id, company_id, year, month, week_number, driver_name, amount)
     VALUES ({id}, {co}, 2099, 1, 1, 'MX Fahrer {s}', 10.00)$q$, NULL,
  $q$INSERT INTO abrechnung_handovers (company_id, year, month, week_number, driver_name, amount)
     VALUES ({co}, 2099, 1, 2, 'MX Fahrer neu', 5.00)$q$,
  $q$amount = amount$q$),
-- The forward plan per vehicle and operating day (20261022140000): the monthly
-- plan's shape with the same Dokumente page on every write, so a viewer and an
-- editor read it and write none of it. Each probe row is a *draft*, because a
-- confirmed plan is frozen and its U and D cells would be T for everybody, the
-- owner included. The shift's moments follow from the plan's stored hour: hour 4
-- and positions 24 to 36 are 10:00 to 13:00, and 5 and 6 October 2026 are a
-- Monday and a Tuesday, which is what day_type 0 and 1 say.
(74, 'vehicle_day_plans', $q$id = {id}$q$,
  $q$INSERT INTO vehicle_day_plans (id, company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version)
     VALUES ({id}, {co}, 2026, 10, 4, 15, 'mx')$q$, NULL,
  $q$INSERT INTO vehicle_day_plans (company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version)
     VALUES ({co}, 2026, 11, 4, 15, 'mx')$q$,
  $q$summary = summary$q$),
(75, 'vehicle_day_shifts', $q$id = {id}$q$,
  $q$INSERT INTO vehicle_day_shifts (id, company_id, plan_id, operating_date, vehicle, shift_index, start_position, end_position,
                                     starts_local, ends_local, minutes, day_type, is_holiday, expected_revenue_cents,
                                     expected_revenue_per_hour_cents, confidence, evidence_days)
     VALUES ({id}, {co}, {ref:vehicle_day_plans}, '2026-10-05', 'MX-CAR', 0, 24, 36,
             '2026-10-05 10:00', '2026-10-05 13:00', 180, 0, false, 100, 33, 'low', 1)$q$, NULL,
  $q$INSERT INTO vehicle_day_shifts (company_id, plan_id, operating_date, vehicle, shift_index, start_position, end_position,
                                     starts_local, ends_local, minutes, day_type, is_holiday, expected_revenue_cents,
                                     expected_revenue_per_hour_cents, confidence, evidence_days)
     VALUES ({co}, {ref:vehicle_day_plans}, '2026-10-06', 'MX-CAR', 0, 24, 36,
             '2026-10-06 10:00', '2026-10-06 13:00', 180, 1, false, 100, 33, 'low', 1)$q$,
  $q$minutes = minutes$q$);

-- ─── how each row is moved to the other tenant ──────────────────────────────
-- The M probe takes the row through `key` and sets `mov` on it (`_mx_move_try`),
-- filled for the row's own side, so `mov` names the other side's company, admin
-- or parent row.
-- `mov_pre` runs first as the owner and deletes the one row in the target
-- tenant a unique constraint would collide with, as `ins_pre` does for INSERT;
-- the rollback restores it. `owner_must` is what the owner pass must answer.
-- `mov` NULL: the table has no tenant, so a row has nowhere to move to.

CREATE TEMP TABLE _mx_move (tbl text PRIMARY KEY, mov text, mov_pre text, owner_must text NOT NULL, note text);

INSERT INTO _mx_move VALUES
('companies',                            NULL, NULL, 'Y', 'no tenant: the row is the tenant'),
('company_settings',                     $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM company_settings WHERE company_id = {other_co}$q$, 'Y', 'one settings row per company'),
-- Since 20260917140000 neither row may be re-pointed at all: the shell term now
-- answers a platform account's open context, which would have let
-- company_users.manage pull another company's role into the company being
-- supported. pin_roles_company_id and pin_role_permissions_role_id refuse it
-- for every writer, the owner included.
('roles',                                $q$company_id = {other_co}$q$, NULL, 'T', 'pin_roles_company_id refuses it even for the owner'),
('role_permissions',                     $q$role_id = {ref_other:roles}$q$,
                                         $q$DELETE FROM role_permissions WHERE id = {ref_other:role_permissions}$q$, 'T', 'pin_role_permissions_role_id refuses it even for the owner'),
('user_profiles',                        $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('user_sessions',                        $q$user_id = {other_admin}$q$, NULL, 'Y', 'through its user'),
('drivers',                              $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('cars',                                 $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('car_driver_assignments',               $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('cash_transactions',                    $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('income',                               $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('receipts',                             $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('fixed_costs',                          $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('documents',                            $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('document_blocks',                      $q$document_id = {ref_other:documents}$q$, NULL, 'Y', 'through its document'),
('document_variables',                   $q$document_id = {ref_other:documents}$q$,
                                         $q$DELETE FROM document_variables WHERE id = {ref_other:document_variables}$q$, 'Y', 'through its document; one row per document and key'),
('document_templates',                   $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('document_categories',                  NULL, NULL, 'Y', 'no tenant: a platform catalogue'),
('driver_notes',                         $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('salaries',                             $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('salary_payments',                      $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('werkstatt_checks',                     $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
-- One live connection per company and partner, and since 20261007100000 one per
-- partner fleet as well, so the other side's own row is cleared before the move
-- rather than colliding with it -- the trip_analysis_settings shape.
('partner_connections',                  $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM partner_connections WHERE company_id = {other_co} AND partner = 'mx'$q$, 'Y', 'one live connection per company and partner'),
('partner_driver_links',                 $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM partner_driver_links WHERE company_id = {other_co} AND partner = 'mx' AND external_driver_id = 'mx-4711'$q$, 'Y', 'one link per company, partner and external driver'),
('partner_receipt_submissions',          $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM partner_receipt_submissions WHERE company_id = {other_co} AND partner = 'mx' AND external_submission_id = 'mx-sub-1'$q$, 'Y', 'the idempotency key names the company'),
-- One schedule per company, so B's own row is dropped first, as
-- company_settings' is. The deliveries' dedupe key names the company and the
-- probe rows carry their own company as the target, so A's row collides with
-- nothing of B's.
('abrechnung_schedules',                 $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM abrechnung_schedules WHERE company_id = {other_co}$q$, 'Y', 'one schedule per company'),
('abrechnung_deliveries',                $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
-- One schedule per company, so B's own row is dropped first; the runs' key
-- names the company, so A's probe row collides with nothing of B's.
('uber_pull_schedules',                  $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM uber_pull_schedules WHERE company_id = {other_co}$q$, 'Y', 'one schedule per company'),
('uber_pull_runs',                       $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
-- The side's own address differs, so A's row moved into B collides with nothing.
('notification_recipients',              $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
-- The side's own driver name differs, so A's row moved into B collides with nothing.
('abrechnung_handovers',                 $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('partner_note_submissions',             $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM partner_note_submissions WHERE company_id = {other_co} AND partner = 'mx' AND external_submission_id = 'mx-sub-1'$q$, 'Y', 'the idempotency key names the company'),
('partner_vehicle_links',                $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM partner_vehicle_links WHERE company_id = {other_co} AND partner = 'mx' AND external_vehicle_id = 'mx-v1'$q$, 'Y', 'the external id names the company'),
('fahrtenbuch_imports',                  $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('fahrtenbuch_trips',                    $q$company_id = {other_co}$q$, NULL, 'T', 'protect_fahrtenbuch_immutable_fields refuses it even for the owner'),
('fahrtenbuch_assignment_audit',         $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('company_planning_runs',                $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('company_planning_run_blocks',          $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('monthly_planning_manual_exceptions',   $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('planning_finalizations',               $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('planning_run_adjustments',             $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('historical_reconciliations',           $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM historical_reconciliations WHERE id = {ref_other:historical_reconciliations}$q$, 'Y', 'one per company and month'),
('historical_reconciliation_drivers',    $q$reconciliation_id = {ref_other:historical_reconciliations}$q$, NULL, 'Y', 'through its reconciliation'),
('historical_reconciliation_results',    $q$reconciliation_id = {ref_other:historical_reconciliations}$q$, NULL, 'Y', 'through its reconciliation'),
('historical_reconciliation_wh_drivers', $q$reconciliation_id = {ref_other:historical_reconciliations}$q$, NULL, 'Y', 'through its reconciliation'),
('historical_block_adjustments',         $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('historical_driver_hour_targets',       $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('historical_payroll_targets',           $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('historical_time_adjustments',          $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('historical_wh_saved_plans',            $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM historical_wh_saved_plans WHERE id = {ref_other:historical_wh_saved_plans}$q$, 'Y', 'one per company, month and mode'),
('saved_stundennachweise',               $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('notification_settings',                $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM notification_settings WHERE id = {ref_other:notification_settings}$q$, 'Y', 'one per company and type'),
('subscription_plans',                   NULL, NULL, 'Y', 'no tenant: a platform catalogue'),
('company_subscriptions',                $q$company_id = {other_co}$q$, NULL, 'T', 'pin_billing_company_id refuses it even for the owner'),
('subscription_invoices',                $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM subscription_invoices WHERE id = {ref_other:subscription_invoices}$q$, 'T', 'pin_billing_company_id refuses it even for the owner'),
('subscription_payment_audit',           $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('subscription_admin_actions',           $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('discount_codes',                       $q$assigned_company_id = {other_co}$q$, NULL, 'Y', 'reassigns the code to the other company'),
('discount_code_redemptions',            $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('referrals',                            NULL, NULL, 'Y', 'no tenant: a platform catalogue'),
('activation_codes',                     $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('activation_code_attempts',             $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('document_counters',                    $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM document_counters WHERE company_id = {other_co} AND doc_type = 'mx' AND year = 2026$q$, 'Y', 'one counter per company, type and year'),
('cash_movements',                       $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('salary_cash_receipts',                 $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM salary_cash_receipts WHERE id = {ref_other:salary_cash_receipts}$q$, 'Y', 'one receipt number per company'),
('subscription_coverage',                $q$company_id = {other_co}$q$, NULL, 'T', 'pin_billing_company_id refuses it even for the owner'),
('trip_analysis_settings',               $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM trip_analysis_settings WHERE company_id = {other_co}$q$, 'Y', 'one settings row per company'),
-- A budget carries one driver's pay snapshot, so it never leaves its driver,
-- company or month: driver_month_budget_guard refuses the move for every
-- writer, before the WITH CHECK is asked.
('driver_month_budget',                  $q$company_id = {other_co}$q$, NULL, 'T', 'driver_month_budget_guard refuses it even for the owner'),
-- The dedupe key names the target as well as the company, and the probe rows
-- carry their own company as the target, so A's row moved into B collides with
-- nothing of B's: no mov_pre, and the owner pass moves it.
('notification_deliveries',              $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
-- 20260930100000: a plan stays with its company and month, and a child stays
-- with its plan, so all four guards refuse the move before any WITH CHECK is
-- reached, for the owner too, as driver_month_budget's guard does.
('monthly_plans',                        $q$company_id = {other_co}$q$, NULL, 'T', 'monthly_plan_guard refuses it even for the owner'),
('monthly_plan_drivers',                 $q$company_id = {other_co}$q$, NULL, 'T', 'monthly_plan_driver_guard refuses it even for the owner'),
('monthly_plan_blocks',                  $q$company_id = {other_co}$q$, NULL, 'T', 'monthly_plan_child_guard refuses it even for the owner'),
('monthly_plan_block_trips',             $q$company_id = {other_co}$q$, NULL, 'T', 'monthly_plan_child_guard refuses it even for the owner'),
-- 20261022140000: a plan stays with its company, month and the hour that built
-- it, and a shift stays with its plan, so both guards refuse the move before
-- any WITH CHECK is reached, for the owner too.
('vehicle_day_plans',                    $q$company_id = {other_co}$q$, NULL, 'T', 'vehicle_day_plan_guard refuses it even for the owner'),
('vehicle_day_shifts',                   $q$company_id = {other_co}$q$, NULL, 'T', 'vehicle_day_shift_guard refuses it even for the owner');

-- Fixtures go in once; the file can be re-run against a kept container.
DO $$
DECLARE r record; s text;
BEGIN
  IF EXISTS (SELECT 1 FROM drivers WHERE id = _mx_id('drivers', 'a')) THEN
    RETURN;
  END IF;
  FOR r IN SELECT * FROM _mx_spec WHERE fixture IS NOT NULL ORDER BY ord LOOP
    FOREACH s IN ARRAY ARRAY['a', 'b'] LOOP
      BEGIN
        EXECUTE _mx_fill(r.fixture, r.tbl, s);
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'matrix fixture for % (side %) failed: %', r.tbl, s, SQLERRM;
      END;
    END LOOP;
  END LOOP;
END $$;

-- ─── the expected matrix ────────────────────────────────────────────────────
-- S select · I insert · U update · D delete · M move. Cells as described in the header.

-- staff_view and staff_support are not written out per line: they are filled by
-- rule below the table, and only the lines the rule cannot state are listed
-- there one by one.
CREATE TEMP TABLE _mx_expected (
  tbl text, op text,
  anon text, viewer text, editor text, supervisor text, admin text, other text, super text,
  staff_view text, staff_support text,
  hole text
);

INSERT INTO _mx_expected (tbl, op, anon, viewer, editor, supervisor, admin, other, super, hole) VALUES
--                                          anon  viewer editor superv admin other super
('activation_code_attempts',           'S', '..', '..', '..', '..', '..', '..', 'YY', NULL),
-- 20260916130020: own_company_insert_attempts replaced WITH CHECK (true), so a
-- member writes an attempt only for its own company (the second character is
-- the other company's row) and the platform account, which has none, writes
-- none. The two activation-code RPCs keep their own auth.uid() as SECURITY
-- DEFINER, so this policy admits their inserts as before.
('activation_code_attempts',           'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('activation_code_attempts',           'U', '..', '..', '..', '..', '..', '..', '..', NULL),
('activation_code_attempts',           'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('activation_code_attempts',           'M', '..', '..', '..', '..', '..', '..', '..', NULL),
('activation_codes',                   'S', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('activation_codes',                   'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', NULL),
('activation_codes',                   'U', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('activation_codes',                   'D', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('activation_codes',                   'M', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('car_driver_assignments',             'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- 20260923130000 (slice C): page 'cars', the screen that writes it. Only the viewer loses; the editor holds can_edit on that page.
('car_driver_assignments',             'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('car_driver_assignments',            'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('car_driver_assignments',            'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('car_driver_assignments',            'M', '..', '..', 'R.', 'R.', 'R.', '.R', '..', NULL),
('cars',                               'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('cars',                               'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('cars',                              'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('cars',                              'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('cars',                              'M', '..', '..', 'R.', 'R.', 'R.', '.R', '..', NULL),
('cash_movements',                    'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('cash_movements',                     'I', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('cash_movements',                     'U', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('cash_movements',                     'D', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('cash_movements',                     'M', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('cash_transactions',                  'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- 20260923130000 (slice C): page 'cash-balance', the Bargeldbestand screen. Only the viewer loses.
('cash_transactions',                  'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('cash_transactions',                 'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('cash_transactions',                 'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('cash_transactions',                 'M', '..', '..', 'R.', 'R.', 'R.', '.R', '..', NULL),
-- A member still reads its own company row. What it can no longer read there is
-- an approval note: 20260916130020 retired the column, and the platform's record
-- of a decision is the audit row platform_company_set_approval writes. The
-- rejection reason stays — a rejected company's owner is shown it.
('companies',                          'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', NULL),
('companies',                          'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', NULL),
-- Both stay YY, and both are tagged: `companies.lifecycle` and
-- `companies.hard_delete` name no company at all, so a staff account edits or
-- deletes either tenant with no context, no reason and no audit row. That is
-- 20260917130000's design and 20260917140000 does not touch it — the concession
-- it closes is the *operational* data. Narrowing the shell is 3.4c's and
-- 3.13's. The same shape, untagged only to keep this file readable, holds for
-- company_subscriptions, subscription_invoices and subscription_payment_audit.
('companies',                          'U', '..', '..', '..', '..', '..', '..', 'YY', 'the shell still takes a capability-only cross-tenant write: no context, no reason, no audit row (3.4c/3.13)'),
('companies',                          'D', '..', '..', '..', '..', '..', '..', 'YY', 'the shell still takes a capability-only cross-tenant write: no context, no reason, no audit row (3.4c/3.13)'),
('companies',                          'M', '--', '--', '--', '--', '--', '--', '--', NULL),
('company_planning_run_blocks',       'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('company_planning_run_blocks',        'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('company_planning_run_blocks',        'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('company_planning_run_blocks',        'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('company_planning_run_blocks',        'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('company_planning_runs',             'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('company_planning_runs',              'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('company_planning_runs',              'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('company_planning_runs',              'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('company_planning_runs',              'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
-- company_settings is the account shell, and since 20260923100000 (3.13b) it
-- is the one shell table with no platform branch at all. Its writes lost theirs
-- with 20260921110000 (3.13a): the platform branch is the support session's
-- company, and `super` has none open — U, D and M were YY, tagged "the shell
-- still takes a capability-only cross-tenant write" (3.4c/3.13), and are '..'
-- now: the row is visible and no write policy admits it.
--
-- S moved here. It was YY on companies.read, which all four staff roles hold,
-- so a read_only platform account read every customer's legal name, managing
-- director, VAT and tax number, commercial register, bank name, IBAN, BIC and
-- account holder with no context and no audit row — wider than
-- platform_drivers_list allows for a driver's name. The predicate is now the
-- tenant term alone, which for a company-less staff account is the open
-- context's company, so `super` reads neither row and the two context
-- principals read company A's (the override below). The panel's one
-- cross-company use of this table, drivers_per_car_limit, is a key of
-- platform_companies_list now.
('company_settings',                   'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('company_settings',                   'I', 'RR', 'RR', 'RR', 'RR', 'YR', 'RY', 'RR', NULL),
('company_settings',                   'U', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('company_settings',                   'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('company_settings',                   'M', '..', '..', '..', '..', 'R.', '.R', '..', NULL),
-- The money moved with decision D14 (24.09.2026, migration 20260924110000).
-- Until then this read was `companies.read`'s, which every staff role holds by
-- design (plan 3.A), so a `read_only` account read every customer's invoices,
-- amounts and payment trail with no context and no audit row — wider than
-- platform_drivers_list allows for a driver's name, and the asymmetry the
-- decision closed. The predicate is the tenant term alone now, which for a
-- company-less staff account is the open context's company, so `super` reads
-- neither row and the two context principals read company A's (the override
-- below). Across companies a platform account reads these tables through
-- platform_invoices_list and platform_subscriptions_list, which ask
-- billing.manage and write one audit row per call.
--
-- U, D and M move with S and not on their own: their own policies still name
-- billing.manage with no company term, but `UPDATE … SET notes = notes WHERE
-- id = …` and `DELETE … WHERE id = …` read a column, so PostgreSQL applies the
-- SELECT policies to the existing row as well (the rule this file's header
-- already states for M), and a row the SELECT policy hides cannot be written.
-- Nothing in the product notices: every billing write is one of the SECURITY
-- DEFINER RPCs of 20260916130000, which run as their owner and never through
-- these policies.
('company_subscriptions',              'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('company_subscriptions',              'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', NULL),
('company_subscriptions',              'U', '..', '..', '..', '..', '..', '..', '..', NULL),
('company_subscriptions',              'D', '..', '..', '..', '..', '..', '..', '..', NULL),
-- M was YY before 20260917130000: billing.manage could re-point an existing
-- subscription at another company, because these policies carry no company term
-- at all. That migration pins company_id with a trigger, so the row could be
-- edited and not moved (TT). Since D14 the row cannot even be taken with
-- SELECT … FOR UPDATE, so no UPDATE is issued and the pin trigger never speaks:
-- '..' is the row never having been reachable, where TT was the policy admitting
-- it and a trigger catching it.
('company_subscriptions',              'M', '..', '..', '..', '..', '..', '..', '..', NULL),
('discount_code_redemptions',          'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', NULL),
('discount_code_redemptions',          'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', NULL),
('discount_code_redemptions',          'U', '..', '..', '..', '..', '..', '..', '..', NULL),
('discount_code_redemptions',          'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('discount_code_redemptions',          'M', '..', '..', '..', '..', '..', '..', '..', NULL),
-- 20260916130020 dropped the member-facing SELECT policy: only codes.manage
-- reads them now. The signup form validates a code through the
-- validate-discount-code function, which runs with the service role.
('discount_codes',                     'S', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('discount_codes',                     'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', NULL),
('discount_codes',                     'U', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('discount_codes',                     'D', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('discount_codes',                     'M', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('document_blocks',                    'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('document_blocks',                    'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('document_blocks',                   'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('document_blocks',                   'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('document_blocks',                   'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('document_categories',                'S', '..', 'YY', 'YY', 'YY', 'YY', 'YY', 'YY', NULL),
('document_categories',                'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', NULL),
('document_categories',                'U', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('document_categories',                'D', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('document_categories',                'M', '--', '--', '--', '--', '--', '--', '--', NULL),
('document_counters',                  'S', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('document_counters',                  'I', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('document_counters',                  'U', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('document_counters',                  'D', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('document_counters',                  'M', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('document_templates',                 'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('document_templates',                 'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('document_templates',                'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('document_templates',                'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('document_templates',                'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('document_variables',                 'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('document_variables',                 'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('document_variables',                'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('document_variables',                'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('document_variables',                'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('documents',                          'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('documents',                          'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('documents',                         'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('documents',                         'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('documents',                         'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('driver_notes',                       'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('driver_notes',                       'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('driver_notes',                      'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('driver_notes',                      'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('driver_notes',                      'M', '..', '..', 'R.', 'R.', 'R.', '.R', '..', NULL),
-- 20260922110000. anon holds no privilege (PP); every member reads, only the
-- administrator writes, and the move is the guard's (T), not the WITH CHECK's.
('driver_month_budget',                'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('driver_month_budget',                'I', 'PP', 'RR', 'RR', 'RR', 'YR', 'RY', 'RR', NULL),
('driver_month_budget',                'U', 'PP', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('driver_month_budget',                'D', 'PP', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('driver_month_budget',                'M', 'PP', '..', '..', '..', 'T.', '.T', '..', NULL),
('drivers',                            'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('drivers',                            'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('drivers',                           'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('drivers',                           'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('drivers',                           'M', '..', '..', 'R.', 'R.', 'R.', '.R', '..', NULL),
('fahrtenbuch_assignment_audit',      'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('fahrtenbuch_assignment_audit',       'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('fahrtenbuch_assignment_audit',       'U', '..', '..', '..', '..', '..', '..', '..', NULL),
('fahrtenbuch_assignment_audit',       'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('fahrtenbuch_assignment_audit',       'M', '..', '..', '..', '..', '..', '..', '..', NULL),
('fahrtenbuch_imports',               'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the
-- writes are refused. DELETE is untouched: it stays the administrator's alone,
-- because deleting an import takes a finalized month's trips with it, and the
-- page gate would have widened it to the supervisor.
('fahrtenbuch_imports',                'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('fahrtenbuch_imports',                'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('fahrtenbuch_imports',                'D', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('fahrtenbuch_imports',                'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('fahrtenbuch_trips',                 'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there. There is
-- still no UPDATE policy at all, and DELETE stays the administrator's.
('fahrtenbuch_trips',                  'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('fahrtenbuch_trips',                  'U', '..', '..', '..', '..', '..', '..', '..', NULL),
('fahrtenbuch_trips',                  'D', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('fahrtenbuch_trips',                  'M', '..', '..', '..', '..', '..', '..', '..', NULL),
('fixed_costs',                        'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('fixed_costs',                        'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('fixed_costs',                       'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('fixed_costs',                       'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('fixed_costs',                       'M', '..', '..', 'R.', 'R.', 'R.', '.R', '..', NULL),
('historical_block_adjustments',      'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('historical_block_adjustments',       'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_block_adjustments',       'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_block_adjustments',       'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_block_adjustments',       'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('historical_driver_hour_targets',    'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('historical_driver_hour_targets',     'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_driver_hour_targets',     'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_driver_hour_targets',     'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_driver_hour_targets',     'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('historical_payroll_targets',        'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('historical_payroll_targets',         'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_payroll_targets',         'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_payroll_targets',         'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_payroll_targets',         'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('historical_reconciliation_drivers', 'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('historical_reconciliation_drivers',  'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_reconciliation_drivers',  'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliation_drivers',  'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliation_drivers',  'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('historical_reconciliation_results', 'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('historical_reconciliation_results',  'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_reconciliation_results',  'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliation_results',  'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliation_results',  'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('historical_reconciliation_wh_drivers','S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('historical_reconciliation_wh_drivers','I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_reconciliation_wh_drivers','U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliation_wh_drivers','D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliation_wh_drivers','M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('historical_reconciliations',        'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('historical_reconciliations',         'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_reconciliations',         'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliations',         'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliations',         'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('historical_time_adjustments',       'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('historical_time_adjustments',        'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_time_adjustments',        'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_time_adjustments',        'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_time_adjustments',        'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('historical_wh_saved_plans',         'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('historical_wh_saved_plans',          'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_wh_saved_plans',          'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_wh_saved_plans',          'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_wh_saved_plans',          'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('income',                             'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('income',                             'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('income',                            'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('income',                            'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('income',                            'M', '..', '..', 'R.', 'R.', 'R.', '.R', '..', NULL),
-- 20260930100000, the monthly plan. The same cells as company_planning_runs, the
-- Dokumente page of slice C on every write, with two differences: anon holds no
-- privilege at all here (PP, as on 20260922110000's two tables), and a move is T
-- rather than R, because the guards raise before the WITH CHECK is reached.
('monthly_plan_block_trips',           'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_plan_block_trips',           'I', 'PP', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('monthly_plan_block_trips',           'U', 'PP', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_plan_block_trips',           'D', 'PP', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_plan_block_trips',           'M', 'PP', '..', '..', 'T.', 'T.', '.T', '..', NULL),
('monthly_plan_blocks',                'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_plan_blocks',                'I', 'PP', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('monthly_plan_blocks',                'U', 'PP', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_plan_blocks',                'D', 'PP', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_plan_blocks',                'M', 'PP', '..', '..', 'T.', 'T.', '.T', '..', NULL),
('monthly_plan_drivers',               'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_plan_drivers',               'I', 'PP', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('monthly_plan_drivers',               'U', 'PP', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_plan_drivers',               'D', 'PP', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_plan_drivers',               'M', 'PP', '..', '..', 'T.', 'T.', '.T', '..', NULL),
('monthly_plans',                      'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_plans',                      'I', 'PP', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('monthly_plans',                      'U', 'PP', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_plans',                      'D', 'PP', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_plans',                      'M', 'PP', '..', '..', 'T.', 'T.', '.T', '..', NULL),
-- 20261022140000: the monthly plan's cells, because the shape is the monthly
-- plan's. Insert is YR for the supervisor and the administrator (the other
-- company's row is the policy's), RR for the viewer and the editor (no
-- can_edit on the Dokumente page), and the guard answers every move with T.
('vehicle_day_plans',                  'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('vehicle_day_plans',                  'I', 'PP', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('vehicle_day_plans',                  'U', 'PP', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('vehicle_day_plans',                  'D', 'PP', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('vehicle_day_plans',                  'M', 'PP', '..', '..', 'T.', 'T.', '.T', '..', NULL),
('vehicle_day_shifts',                 'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('vehicle_day_shifts',                 'I', 'PP', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('vehicle_day_shifts',                 'U', 'PP', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('vehicle_day_shifts',                 'D', 'PP', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('vehicle_day_shifts',                 'M', 'PP', '..', '..', 'T.', 'T.', '.T', '..', NULL),
('monthly_planning_manual_exceptions','S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('monthly_planning_manual_exceptions', 'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('monthly_planning_manual_exceptions', 'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_planning_manual_exceptions', 'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_planning_manual_exceptions', 'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
-- 20260924100000. The one business table a client cannot write: the nightly
-- notification job writes it through two SECURITY DEFINER functions granted to
-- service_role, so `authenticated` holds SELECT alone and I, U, D and M are a
-- missing GRANT for everybody, the administrator included. anon holds nothing
-- at all. The read is the ordinary tenant shape, so it is not role-gated.
('notification_deliveries',           'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('notification_deliveries',            'I', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('notification_deliveries',            'U', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('notification_deliveries',            'D', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('notification_deliveries',            'M', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('notification_settings',             'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('notification_settings',              'I', 'RR', 'RR', 'RR', 'RR', 'YR', 'RY', 'RR', NULL),
('notification_settings',              'U', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('notification_settings',              'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('notification_settings',              'M', '..', '..', '..', '..', 'R.', '.R', '..', NULL),
('planning_finalizations',             'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('planning_finalizations',             'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('planning_finalizations',            'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('planning_finalizations',            'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('planning_finalizations',            'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('planning_run_adjustments',           'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('planning_run_adjustments',          'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('planning_run_adjustments',          'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('planning_run_adjustments',          'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('planning_run_adjustments',          'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
('receipts',                           'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('receipts',                           'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('receipts',                          'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('receipts',                          'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('receipts',                          'M', '..', '..', 'R.', 'R.', 'R.', '.R', '..', NULL),
('referrals',                          'S', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('referrals',                          'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', NULL),
('referrals',                          'U', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('referrals',                          'D', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('referrals',                          'M', '--', '--', '--', '--', '--', '--', '--', NULL),
('role_permissions',                   'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('role_permissions',                   'I', 'RR', 'RR', 'RR', 'RR', 'YR', 'RY', 'RR', NULL),
-- The platform column on these three was RR / YY / TT until 20260917140000,
-- and every one of them moved to '..' for the same reason: `company_users.manage`
-- still says yes, but the row is no longer *visible*. role_permissions reaches
-- its company through an EXISTS on roles, whose SELECT policy is
-- `company_id IS NULL OR company_id = get_user_company_id() OR <the read seam>`
-- — and with the seam false and no context open, a platform account sees the
-- system roles and nothing else. A U, D or M probe whose WHERE reads a column
-- needs SELECT rights too, so PostgreSQL applies that policy before the write
-- policy is ever consulted. With a context open the same three answer for the
-- context's company alone; see the staff columns below.
('role_permissions',                   'U', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('role_permissions',                   'D', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('role_permissions',                   'M', '..', '..', '..', '..', 'T.', '.T', '..', NULL),
('roles',                              'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- anon was RR until the plan-cache guard went into `_mx_become`, and the move to
-- PP is the guard working. **anon is refused either way — the reason moved, not
-- the access.** Say that first, because it is the part a reader needs.
--
-- The observation, which is all this comment asserts: 20260923120000 puts an
-- INSERT trigger on this table whose function calls
-- `public.role_name_is_system_reserved`, granted to `authenticated` and
-- `service_role` and not to `anon`. With the owner's plans still cached, anon's
-- INSERT was refused by `roles_insert`'s WITH CHECK and read R. With the plans
-- discarded it is refused by the missing grant on that function and reads P.
--
-- **Why it moved is NOT established, and this comment is where that is recorded
-- rather than guessed.** Two accounts were offered and tests/tools/
-- plan-cache-repro.sql killed both:
--
--   F1 (plpgsql callee)            REFUSED with the cache warm
--   F3 (sql STABLE + SET clause,   REFUSED with the cache warm
--       this helper's exact shape)
--   F2 (sql IMMUTABLE, no SET)     ALLOWED — only a callee the planner may fold
--                                  away is masked, and this one is not
--
-- So it is neither "the cached EXECUTE check was skipped" (F1 and F3 refuse warm)
-- nor "the planner inlined the call away" (F3 is that shape and still refuses).
-- Something about the real path differs from every probe in that file and nobody
-- has found it. Leads, **not explanations**: this trigger is BEFORE INSERT OR
-- UPDATE and the probes' fire on INSERT only; this callee's body reads
-- `public.roles`, an RLS table, where the probes' select a constant; this table
-- has RLS with policies and a WITH CHECK that can refuse, and the probe tables
-- have neither; and this trigger function lives in `app_private`.
--
-- Do not replace this with a fourth confident paragraph. Three readings of
-- PostgreSQL's source have been wrong here, in both directions, each reading as
-- confirmed at the time. The guard is unaffected either way: DISCARD PLANS forces
-- a re-plan, and a re-plan under the principal can neither reuse the owner's name
-- resolution nor fold away a function the principal may not execute.
--
-- anon is deliberately left without that EXECUTE. `roles_insert` is
-- `TO authenticated`, so anon cannot insert a role whatever the grant says;
-- granting it would widen what anon can reach in order to change a refusal's
-- SQLSTATE. That is the reasoning 20260923120000's own grant block gives, and it
-- is the same fact as the one named exemption in assertions.sql's EXECUTE-reach
-- rule — if `roles_insert` ever admits anon, both need revisiting together.
('roles',                              'I', 'PP', 'RR', 'RR', 'RR', 'YR', 'RY', 'RR', NULL),
-- …and the same for the roles themselves: visible only through a context.
('roles',                              'U', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('roles',                              'D', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
-- Was R. / .R / RR: the WITH CHECK refused the move. 20260917140000 pins the
-- column instead, because the shell term now answers the open context and the
-- WITH CHECK alone would have admitted a pull-in from the other company.
('roles',                              'M', '..', '..', '..', '..', 'T.', '.T', '..', NULL),
('salaries',                           'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('salaries',                           'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('salaries',                          'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('salaries',                          'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('salaries',                          'M', '..', '..', 'R.', 'R.', 'R.', '.R', '..', NULL),
('salary_cash_receipts',              'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('salary_cash_receipts',               'I', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('salary_cash_receipts',               'U', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('salary_cash_receipts',               'D', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('salary_cash_receipts',               'M', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('salary_payments',                    'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('salary_payments',                    'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('salary_payments',                   'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('salary_payments',                   'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('salary_payments',                   'M', '..', '..', 'R.', 'R.', 'R.', '.R', '..', NULL),
('saved_stundennachweise',             'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- slice C: page 'documents' — viewer and editor hold no can_edit there, so the writes are refused.
('saved_stundennachweise',            'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('saved_stundennachweise',            'U', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('saved_stundennachweise',            'D', '..', '..', '..', 'Y.', 'Y.', '.Y', '..', NULL),
('saved_stundennachweise',            'M', '..', '..', '..', 'R.', 'R.', '.R', '..', NULL),
-- 20260919150000 (plan 3.F step U1). Its SELECT predicate is the account shell
-- plus companies.read, exactly like company_subscriptions above, so a member
-- reads its own company's periods whatever state that company is in — which is
-- the point, since the page explaining the block is the one that shows them.
-- Every other cell is PP: `authenticated` is granted SELECT and nothing else,
-- and the only writers are the SECURITY DEFINER helpers in app_private.
--
-- S moved with decision D14: the capability branch is gone, so `super` reads
-- neither period. No read model carries this table — nothing in the product
-- reads a coverage period across companies, and one that no screen shows would
-- be code with no caller — so inside a context is the only way to see one.
('subscription_coverage',              'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('subscription_coverage',              'I', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('subscription_coverage',              'U', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('subscription_coverage',              'D', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('subscription_coverage',              'M', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('subscription_admin_actions',         'S', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('subscription_admin_actions',         'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', NULL),
('subscription_admin_actions',         'U', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('subscription_admin_actions',         'D', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('subscription_admin_actions',         'M', '..', '..', '..', '..', '..', '..', 'YY', NULL),
-- Decision D14, with company_subscriptions above: S, U, D and M move together,
-- for the reason written out there. The invoice list a platform account reads
-- across companies is platform_invoices_list, on billing.manage, one audit row
-- per call. `generate_invoice_number` had to become SECURITY DEFINER in the same
-- migration or invoice generation would have reported every company as skipped
-- (its rpc line below moved with it).
('subscription_invoices',              'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('subscription_invoices',              'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', NULL),
('subscription_invoices',              'U', '..', '..', '..', '..', '..', '..', '..', NULL),
('subscription_invoices',              'D', '..', '..', '..', '..', '..', '..', '..', NULL),
-- M was YY before 20260917130000, and an invoice re-attributed to another
-- company re-attributes money; that migration pinned it with a trigger (TT).
-- Since D14 the row cannot be taken at all, so the trigger never speaks.
('subscription_invoices',              'M', '..', '..', '..', '..', '..', '..', '..', NULL),
-- The payment trail: S moves with the two tables above, and nothing else can.
-- I stays YY — an INSERT with no RETURNING reads no column, so no SELECT policy
-- applies to it — and there is no UPDATE or DELETE policy at all. No read model
-- carries the trail: nothing in the product reads it, across companies or
-- otherwise.
('subscription_payment_audit',         'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('subscription_payment_audit',         'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', NULL),
('subscription_payment_audit',         'U', '..', '..', '..', '..', '..', '..', '..', NULL),
('subscription_payment_audit',         'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('subscription_payment_audit',         'M', '..', '..', '..', '..', '..', '..', '..', NULL),
('subscription_plans',                 'S', '..', 'YY', 'YY', 'YY', 'YY', 'YY', 'YY', NULL),
('subscription_plans',                 'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', NULL),
('subscription_plans',                 'U', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('subscription_plans',                 'D', '..', '..', '..', '..', '..', '..', 'YY', NULL),
('subscription_plans',                 'M', '--', '--', '--', '--', '--', '--', '--', NULL),
-- 20260922110000, the same shape as driver_month_budget; a move is refused by
-- the WITH CHECK here, since nothing pins the settings row to its company.
('trip_analysis_settings',             'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('trip_analysis_settings',             'I', 'PP', 'RR', 'RR', 'RR', 'YR', 'RY', 'RR', NULL),
('trip_analysis_settings',             'U', 'PP', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('trip_analysis_settings',             'D', 'PP', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('trip_analysis_settings',             'M', 'PP', '..', '..', '..', 'R.', '.R', '..', NULL),
('user_profiles',                      'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
-- anon and super: since 20260916110010 the profile guard refuses a JWT putting a
-- profile into a company before RLS is asked; both were RR
('user_profiles',                      'I', 'TT', 'TT', 'TT', 'TT', 'TT', 'TT', 'TT', NULL),
-- `super` sees no company's profiles (the SELECT policy, which a probe with a
-- WHERE clause also has to satisfy, shows a platform account only the company
-- it has opened), and since 20260921110000 (3.13a) no write policy admits it
-- either: the platform branch is the support session's company, not
-- company_users.manage with no company term.
('user_profiles',                      'U', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('user_profiles',                      'D', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
-- super: since 20260916110010 no JWT moves a profile between companies; was YY
('user_profiles',                      'M', '..', '..', '..', '..', 'T.', '.T', '..', NULL),
('user_sessions',                      'S', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('user_sessions',                      'I', 'RR', 'RR', 'RR', 'RR', 'YR', 'RY', 'RR', NULL),
('user_sessions',                      'U', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('user_sessions',                      'D', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('user_sessions',                      'M', '..', '..', '..', '..', 'R.', '.R', '..', NULL),
('werkstatt_checks',                   'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('werkstatt_checks',                   'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('werkstatt_checks',                  'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('werkstatt_checks',                  'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('werkstatt_checks',                  'M', '..', '..', 'R.', 'R.', 'R.', '.R', '..', NULL),
-- The partner tables: the tenant SELECT shape, an UPDATE gated by the page
-- that owns the subject, and no INSERT or DELETE policy at all -- so I is R
-- for every principal and D is a DELETE that matches nothing. The gate is
-- is_company_admin() on partner_connections, because connecting a fleet is
-- the company's own decision, and the owning page on the other three. A
-- viewer holds can_edit nowhere and is refused on all four.
('partner_connections',            'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('partner_connections',            'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', NULL),
('partner_connections',            'U', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('partner_connections',            'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('partner_connections',            'M', '..', '..', '..', '..', 'R.', '.R', '..', NULL),
('partner_driver_links',           'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('partner_driver_links',           'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', NULL),
('partner_driver_links',           'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('partner_driver_links',           'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('partner_driver_links',           'M', '..', '..', 'R.', 'R.', 'R.', '.R', '..', NULL),
-- 20261008160000 dropped both submission tables' UPDATE policy: it admitted no
-- caller (every judging path is a SECURITY DEFINER RPC) and it let a reviewer
-- mark a submission accepted with no Beleg written, rewrite the words the driver
-- was already told, and -- once 20261008150000 added the column -- stamp a
-- delivery that never happened. So U and M read '.' for everyone: with no
-- policy the statement matches no row and reports success, fahrtenbuch_trips'
-- own shape. The view context still reads T on U, because
-- refuse_read_only_context_write is a BEFORE STATEMENT trigger and fires before
-- a policy is consulted.
('partner_receipt_submissions',    'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('partner_receipt_submissions',    'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', NULL),
('partner_receipt_submissions',    'U', '..', '..', '..', '..', '..', '..', '..', NULL),
('partner_receipt_submissions',    'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('partner_receipt_submissions',    'M', '..', '..', '..', '..', '..', '..', '..', NULL),
('partner_note_submissions',       'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('partner_note_submissions',       'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', NULL),
('partner_note_submissions',       'U', '..', '..', '..', '..', '..', '..', '..', NULL),
('partner_note_submissions',       'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('partner_note_submissions',       'M', '..', '..', '..', '..', '..', '..', '..', NULL),
('partner_vehicle_links',          'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('partner_vehicle_links',          'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', NULL),
('partner_vehicle_links',          'U', '..', '..', '..', '..', '..', '..', '..', NULL),
('partner_vehicle_links',          'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('partner_vehicle_links',          'M', '..', '..', '..', '..', '..', '..', '..', NULL),
-- 20261003120000. The schedule: read by the company, written only by its
-- administrator -- company_settings' cells plus a DELETE the administrator
-- holds. anon reads nothing at all, this migration having revoked it, so its
-- column is a missing GRANT and not a filtered read.
('abrechnung_schedules',           'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('abrechnung_schedules',           'I', 'PP', 'RR', 'RR', 'RR', 'YR', 'RY', 'RR', NULL),
('abrechnung_schedules',           'U', 'PP', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('abrechnung_schedules',           'D', 'PP', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('abrechnung_schedules',           'M', 'PP', '..', '..', '..', 'R.', '.R', '..', NULL),
-- The deliveries: the job's own record. `authenticated` holds SELECT and
-- nothing else and anon holds nothing, so every write cell is a missing GRANT
-- for everyone -- notification_deliveries' shape, and the second table in this
-- product a client cannot write at all.
('abrechnung_deliveries',          'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('abrechnung_deliveries',          'I', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('abrechnung_deliveries',          'U', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('abrechnung_deliveries',          'D', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('abrechnung_deliveries',          'M', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
-- 20261015100000. The schedule is abrechnung_schedules' cells and the runs are
-- abrechnung_deliveries': an administrator writes the first, the job's
-- functions alone write the second, and anon's column is a missing GRANT.
('uber_pull_schedules',            'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('uber_pull_schedules',            'I', 'PP', 'RR', 'RR', 'RR', 'YR', 'RY', 'RR', NULL),
('uber_pull_schedules',            'U', 'PP', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('uber_pull_schedules',            'D', 'PP', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('uber_pull_schedules',            'M', 'PP', '..', '..', '..', 'R.', '.R', '..', NULL),
('uber_pull_runs',                 'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('uber_pull_runs',                 'I', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('uber_pull_runs',                 'U', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('uber_pull_runs',                 'D', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('uber_pull_runs',                 'M', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
-- 20261015140000. abrechnung_schedules' cells exactly: an administrator writes,
-- every member reads, anon's column is a missing GRANT.
('notification_recipients',        'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('notification_recipients',        'I', 'PP', 'RR', 'RR', 'RR', 'YR', 'RY', 'RR', NULL),
('notification_recipients',        'U', 'PP', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('notification_recipients',        'D', 'PP', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('notification_recipients',        'M', 'PP', '..', '..', '..', 'R.', '.R', '..', NULL),
-- 20261019110000: cash_transactions' cells (the income page gates every write),
-- anon holding no privilege at all.
('abrechnung_handovers',           'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('abrechnung_handovers',           'I', 'PP', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('abrechnung_handovers',           'U', 'PP', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('abrechnung_handovers',           'D', 'PP', '..', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('abrechnung_handovers',           'M', 'PP', '..', 'R.', 'R.', 'R.', '.R', '..', NULL);

-- ─── what a context changes, as a rule ──────────────────────────────────────
--
-- The two staff principals hold `super`'s role and `super`'s capabilities, so
-- everything a capability decides they answer exactly as it does. That is the
-- default: copy the column.
--
-- On the 36 tables 20260917130000 gave the tenant shape, the context decides
-- instead, and the rule is the claim this slice makes:
--
--   staff_support  the same as `admin` — a support session makes a staff
--                  account the administrator of the company it opened, with
--                  the same reads, the same writes and the same refusal to
--                  reach company B
--   staff_view     reads what that administrator reads, and writes nothing:
--                  every INSERT, UPDATE and DELETE statement is refused by
--                  app_private.refuse_read_only_context_write (T), on both
--                  sides, because the trigger asks about the caller and not
--                  about the row — a statement that would have matched nothing
--                  is refused just the same.
--
--                  A move is the exception, and the reason is mechanical: the
--                  probe has to take the row with SELECT … FOR UPDATE before it
--                  issues any UPDATE, and that applies the UPDATE policy's
--                  USING. In a view context the role gate inside that USING is
--                  false, so on a role-gated table there is nothing to lock, no
--                  UPDATE is ever issued, and the trigger never speaks: the
--                  answer is the silent one, not T. The caller whose gates
--                  answer the same way inside its own company is the viewer, so
--                  the viewer's own move cell is what says which it is —
--                  '..' where the row cannot be held, 'T.' where it can.
--                  Since 20260923130000 (slice C) it is '..' on every one of
--                  the 36: the tables that had no role gate now have one, and
--                  the rest either gate the viewer already, ask for an
--                  administrator, or carry no UPDATE policy at all. So no 'T.'
--                  move cell is left here, and a table that grows one again is
--                  a table that lost its gate.
--
-- Tables whose cell is PP are skipped: no GRANT means the statement never
-- reaches a policy or a trigger.

UPDATE _mx_expected SET staff_view = super, staff_support = super;

UPDATE _mx_expected x
   SET staff_support = x.admin,
       staff_view    = CASE x.op
                         WHEN 'S' THEN x.admin
                         WHEN 'M' THEN CASE WHEN x.viewer = '..' THEN '..' ELSE 'T.' END
                         ELSE 'TT'
                       END
 WHERE x.admin <> 'PP'
   AND x.tbl IN (
     'receipts', 'income', 'drivers', 'cars', 'fixed_costs', 'salaries', 'salary_payments',
     'werkstatt_checks', 'driver_notes', 'documents', 'car_driver_assignments', 'cash_transactions',
     'document_templates', 'company_planning_runs', 'company_planning_run_blocks',
     'monthly_planning_manual_exceptions', 'planning_finalizations', 'planning_run_adjustments',
     'historical_reconciliations', 'historical_block_adjustments', 'historical_driver_hour_targets',
     'historical_payroll_targets', 'historical_time_adjustments', 'historical_wh_saved_plans',
     'saved_stundennachweise', 'fahrtenbuch_imports', 'fahrtenbuch_trips',
     'fahrtenbuch_assignment_audit', 'notification_settings', 'cash_movements',
     'salary_cash_receipts', 'document_blocks', 'document_variables',
     'historical_reconciliation_drivers', 'historical_reconciliation_results',
     'historical_reconciliation_wh_drivers',
     -- 20260922110000: the same shape and the same two triggers
     'trip_analysis_settings', 'driver_month_budget',
     -- 20260930100000: the same shape and the same two triggers
     'monthly_plans', 'monthly_plan_drivers', 'monthly_plan_blocks',
     'monthly_plan_block_trips',
     -- 20261003120000: the same shape and the same two triggers. The
     -- deliveries' write cells are PP and are skipped by the WHERE above, so
     -- what this adds for them is the SELECT line -- which cannot be left as
     -- copied from `super`, because a context is exactly what makes the
     -- company's rows readable.
     'abrechnung_schedules', 'abrechnung_deliveries',
     -- 20261015100000: the same shape and the same two triggers
     'uber_pull_schedules', 'uber_pull_runs',
     -- 20261015140000: the same shape and the same two triggers
     'notification_recipients',
     -- 20261019110000: the same shape and the same two triggers
     'abrechnung_handovers',
     -- 20261022140000: the same shape and the same two triggers
     'vehicle_day_plans', 'vehicle_day_shifts');

-- The account shell, where the rule above does not apply and the column
-- copied from `super` is wrong: these predicates read get_user_company_id(),
-- which for a company-less staff account is now the open context's company,
-- and the write predicates of company_settings and user_profiles ask the
-- support session's company (20260921110000). So the two modes differ here
-- too, each table for its own reason, listed line by line below.
-- Three of them carry the refusal trigger too, and for a reason this slice
-- created: their write predicate is
--   company_id = get_user_company_id() AND (is_company_admin() OR platform_can(…))
-- which was refused for a company-less platform account only because the first
-- conjunct was NULL. Answering the open context there completes it and the
-- capability supplies the rest, so a *view* context could otherwise have
-- created a role, given it can_edit on every page, and pointed a company's
-- profile at it — three writes with no reason recorded. So on roles,
-- role_permissions and activation_code_attempts the view column reads like the
-- tenant tables: T for every statement it issues, and for a move only where the
-- row could be locked first.
--
-- Since 20260923110010 roles and role_permissions no longer let a view context
-- lock the row at all — their write policies ask the support session's company
-- instead of a capability with no company term — so their two move cells are
-- '..'. activation_code_attempts is untouched by that migration and keeps 'T.'.
--
-- company_settings and user_profiles are the shell tables deliberately *not*
-- behind it: a trigger there would refuse platform_subscription_assign and
-- platform_company_lifecycle — audited RPCs that name their own company — and
-- a platform account's update of its own profile row. Since 20260921110000
-- (3.13a) they need no trigger: the platform branch of their write policies is
-- the support session's company, so a view context meets no branch at all and
-- is filtered or refused by RLS, while a support session writes the company it
-- opened exactly as that company's administrator would — and its writes there
-- are recorded (tests/rls/support-write-audit.sql section 6b).
UPDATE _mx_expected x SET staff_view = o.sv, staff_support = o.ss
  FROM (VALUES
    -- roles and their permissions: visible for the context's company, written
    -- only inside the support session. A move is refused by the pin trigger
    -- once the support session lets the statement through at all.
    --
    -- The two move cells moved from 'T.' to '..' for the *view* column with
    -- 20260923110010, and the reason is the mechanical one this file already
    -- states for the tenant tables above: the probe must take the row with
    -- SELECT … FOR UPDATE first, and that applies the UPDATE policy's USING.
    -- Until that migration the USING carried `OR platform_can('company_users.manage')`
    -- with no company term, which is true for a staff account in any context or
    -- none — so the row could be locked, the UPDATE was issued, and the pin
    -- trigger spoke (T). The platform branch is now the *support* session's
    -- company, which is NULL in a view context, so there is nothing to lock, no
    -- UPDATE is ever issued, and neither trigger runs: the silent answer, not T.
    -- That is the tightening and not a lost refusal — '..' is the row never
    -- having been reachable, where 'T.' was the policy admitting it and a
    -- trigger catching it. staff_support is unchanged: there the first disjunct
    -- grants, the statement is issued, and the pin trigger refuses the move.
    -- The notification job's record (20260924100000). Only its SELECT line is
    -- listed: the write cells are a missing GRANT for every principal, so the
    -- copy of `super` is already right, while `super` reads nothing without a
    -- context and a context makes the company's rows readable — the tenant
    -- shape's whole claim, and the reason the line cannot be left as copied.
    ('notification_deliveries',  'S', 'Y.', 'Y.'),

    -- The partner tables. A context makes the company's rows readable, which is
    -- the tenant shape's whole claim; a view context is refused by the statement
    -- trigger before any policy is asked, and a support session writes as the
    -- company's own administrator would -- except that I has no policy to admit
    -- a row and D has none to find one with, so those two do not become Y.
    ('partner_connections',          'S', 'Y.', 'Y.'),
    ('partner_connections',          'I', 'TT', 'RR'),
    ('partner_connections',          'U', 'TT', 'Y.'),
    ('partner_connections',          'D', 'TT', '..'),
    ('partner_connections',          'M', '..', 'R.'),
    ('partner_driver_links',         'S', 'Y.', 'Y.'),
    ('partner_driver_links',         'I', 'TT', 'RR'),
    ('partner_driver_links',         'U', 'TT', 'Y.'),
    ('partner_driver_links',         'D', 'TT', '..'),
    ('partner_driver_links',         'M', '..', 'R.'),
    ('partner_receipt_submissions',  'S', 'Y.', 'Y.'),
    ('partner_receipt_submissions',  'I', 'TT', 'RR'),
    ('partner_receipt_submissions',  'U', 'TT', '..'),
    ('partner_receipt_submissions',  'D', 'TT', '..'),
    ('partner_receipt_submissions',  'M', '..', '..'),
    ('partner_note_submissions',     'S', 'Y.', 'Y.'),
    ('partner_note_submissions',     'I', 'TT', 'RR'),
    ('partner_note_submissions',     'U', 'TT', '..'),
    ('partner_note_submissions',     'D', 'TT', '..'),
    ('partner_note_submissions',     'M', '..', '..'),
    ('partner_vehicle_links',        'S', 'Y.', 'Y.'),
    ('partner_vehicle_links',        'I', 'TT', 'RR'),
    ('partner_vehicle_links',        'U', 'TT', '..'),
    ('partner_vehicle_links',        'D', 'TT', '..'),
    ('partner_vehicle_links',        'M', '..', '..'),
    ('roles',                    'S', 'Y.', 'Y.'),
    ('roles',                    'I', 'TT', 'YR'),
    ('roles',                    'U', 'TT', 'Y.'),
    ('roles',                    'D', 'TT', 'Y.'),
    -- view: the row can no longer be locked (20260923110010) — see above.
    ('roles',                    'M', '..', 'T.'),
    ('role_permissions',         'S', 'Y.', 'Y.'),
    ('role_permissions',         'I', 'TT', 'YR'),
    ('role_permissions',         'U', 'TT', 'Y.'),
    ('role_permissions',         'D', 'TT', 'Y.'),
    -- view: the row can no longer be locked (20260923110010) — see above.
    ('role_permissions',         'M', '..', 'T.'),
    -- The company's legal details (20260921110000, 3.13a; 20260923100000,
    -- 3.13b). Before 3.13a the view column inserted company A's row (YR) — the
    -- context completed the company term and companies.lifecycle the rest —
    -- and both columns copied super's YY for U, D and M. The view context
    -- writes nothing now, and the support session writes company A's row as
    -- that company's administrator does, plus D, which it holds as
    -- companies.hard_delete inside the session and an administrator does not
    -- hold at all. Its move is refused by the WITH CHECK.
    --
    -- S is listed since 3.13b. Both columns used to copy super's YY, so both
    -- read company B as well — through companies.read, which the context had
    -- nothing to do with. The capability is gone, so the context is the whole
    -- answer: company A's row, and not company B's, in either mode. This is
    -- the one line that says a *view* context reads the legal details at all;
    -- reading them is what a view context is for.
    ('company_settings',         'S', 'Y.', 'Y.'),
    ('company_settings',         'I', 'RR', 'YR'),
    ('company_settings',         'U', '..', 'Y.'),
    ('company_settings',         'D', '..', 'Y.'),
    ('company_settings',         'M', '..', 'R.'),
    -- an attempt is recorded against the caller's own company, which is now
    -- the opened one; there is no UPDATE or DELETE policy, so a support
    -- session finds nothing to change and a view context is refused before
    -- that can matter
    ('activation_code_attempts', 'I', 'TT', 'YR'),
    ('activation_code_attempts', 'U', 'TT', '..'),
    ('activation_code_attempts', 'D', 'TT', '..'),
    ('activation_code_attempts', 'M', '..', '..'),
    -- user_profiles carries no refusal trigger, and since 20260921110000
    -- (3.13a) needs none: its platform write branch is the support session's
    -- company. The view column was Y. for U — the context made company A's
    -- profiles visible and company_users.manage made them writable — and T.
    -- for D and M, refused only by a cascade into a tenant table's trigger or
    -- by the profile guard. All three are '..' now: no write policy admits a
    -- view context, so the row is never taken. The support column is
    -- unchanged, and its writes are now recorded.
    --
    -- companies carries no refusal trigger either: its platform branch is still
    -- a capability with no company term (the U and D residue above). The T
    -- cells are the guard below.
    --
    -- companies D for staff_support moved from YY to TT with 20260920110000
    -- (3.4c), deliberately: a platform account holding a context, in either
    -- mode, hard-deletes no company. app_private.guard_company_hard_delete, a
    -- BEFORE DELETE trigger on companies, refuses it before any cascade runs
    -- ("Solange ein Unternehmenszugriff offen ist, kann kein Unternehmen
    -- gelöscht werden"), so the answer is the same for both companies and does
    -- not depend on the order of the delete's foreign-key cascades — which it
    -- did while the refusal came from the cascades themselves: the company A
    -- delete removes the session, and a cascade that ran after that found
    -- nothing to arm the audit with. staff_view's TT now comes from the same
    -- guard. `super`, with no context, still deletes both — the residual on the
    -- line above — and the audit lets exactly that cascade through unrecorded.
    ('user_profiles',            'S', 'Y.', 'Y.'),
    ('user_profiles',            'U', '..', 'Y.'),
    ('user_profiles',            'D', '..', 'Y.'),
    ('user_profiles',            'M', '..', 'T.'),
    ('companies',                'D', 'TT', 'TT'),
    -- The four billing tables, decision D14 (20260924110000). Both columns used
    -- to copy super's YY, which is what the capability answered: the context had
    -- nothing to do with it. The capability is gone from their SELECT, so the
    -- context is now the whole answer — company A's rows, not company B's, in
    -- either mode. This is the line that says a *view* context reads a
    -- customer's invoices and subscriptions at all, and reading them is what a
    -- view context is for.
    --
    -- U and D follow S rather than their own policies, which still name
    -- billing.manage with no company term: the probe's UPDATE and DELETE read a
    -- column in their WHERE, so the SELECT policy decides which row they can
    -- reach. M is 'T.' for the same reason — company A's row can be taken with
    -- SELECT … FOR UPDATE, the UPDATE is issued, and pin_billing_company_id
    -- refuses the move; company B's row is never visible.
    --
    -- **Deliberately recorded, not closed here:** a *view* context therefore
    -- still edits and deletes the supported company's subscription and invoice
    -- rows. These two tables carry no refuse_read_only_context_write — they are
    -- the account shell, not one of 3.4a's 36 tenant tables — and D14 is a
    -- decision about who may *read* the money. Narrowing their writes to the
    -- support session, the way 3.13a narrowed company_settings and
    -- user_profiles, is its own slice. It is strictly tighter than before, where
    -- both context modes wrote *either* company's rows.
    ('company_subscriptions',      'S', 'Y.', 'Y.'),
    ('company_subscriptions',      'U', 'Y.', 'Y.'),
    ('company_subscriptions',      'D', 'Y.', 'Y.'),
    ('company_subscriptions',      'M', 'T.', 'T.'),
    ('subscription_invoices',      'S', 'Y.', 'Y.'),
    ('subscription_invoices',      'U', 'Y.', 'Y.'),
    ('subscription_invoices',      'D', 'Y.', 'Y.'),
    ('subscription_invoices',      'M', 'T.', 'T.'),
    -- no UPDATE or DELETE policy, so only S can move
    ('subscription_payment_audit', 'S', 'Y.', 'Y.'),
    -- SELECT is the only privilege a client role holds
    ('subscription_coverage',      'S', 'Y.', 'Y.')
  ) AS o(tbl, op, sv, ss)
 WHERE x.tbl = o.tbl AND x.op = o.op;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM _mx_expected WHERE staff_view IS NULL OR staff_support IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'matrix: % expected line(s) have no staff column — the fill above missed them', n;
  END IF;
END $$;

-- ─── the expected view lines ────────────────────────────────────────────────
-- PostgREST serves a view like a table, so each public view gets a SELECT line
-- in the same cell format. `key` picks the view's company-A and company-B row;
-- the rows themselves are inserted in the view section below.

CREATE TEMP TABLE _mx_view_spec (
  view_name text, key text,
  anon text, viewer text, editor text, supervisor text, admin text, other text, super text,
  staff_view text, staff_support text,
  hole text
);

INSERT INTO _mx_view_spec (view_name, key, anon, viewer, editor, supervisor, admin, other, super,
                           staff_view, staff_support, hole) VALUES
--                                                         anon  viewer editor superv admin other super staff_view staff_support
-- security_invoker, so it shows what the income and receipts policies let the
-- caller read: company A for a context on company A, in either mode, and
-- nothing at all for a staff account that has opened nothing.
('abrechnung_weekly', $q$driver_name = 'MX view {s}'$q$,  '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', 'Y.', 'Y.', NULL);

-- ─── run the matrix ─────────────────────────────────────────────────────────

DO $$
DECLARE
  who_names  constant text[] := _mx_who_names();
  who_logins constant text[] := _mx_who_logins();
  r        record;
  e        record;
  v_op     text;
  side     text;
  i        int;
  pre      text;
  stmt     text;
  outcome  text;
  owner_must text;
  cell     text;
  cells    text[];
  details  text;
  expected text[];
  n_lines  int := 0;
  n_bad    int := 0;
  n_probes int := 0;
  -- The table matrix is the bulk of this file's work and the only part whose
  -- cost the plan-cache guard changes, so it times itself: run the kit once
  -- with matrix.uncache 'on' and once 'off' and the difference is the guard.
  t_start  constant timestamptz := clock_timestamp();
BEGIN
  FOR r IN SELECT s.*, m.tbl AS move_tbl, m.mov, m.mov_pre, m.owner_must AS move_owner_must, m.note AS move_note
             FROM _mx_spec s LEFT JOIN _mx_move m ON m.tbl = s.tbl
            ORDER BY s.ord LOOP
    IF r.move_tbl IS NULL THEN
      INSERT INTO _mx_failures VALUES ('matrix', format('%s M', r.tbl),
        'no line in _mx_move: say how a row of this table moves to the other tenant, or that it has none');
    END IF;

    FOREACH v_op IN ARRAY ARRAY['S', 'I', 'U', 'D', 'M'] LOOP
      cells   := ARRAY[]::text[];
      details := '';

      FOR i IN 1 .. array_length(who_logins, 1) + 1 LOOP
        cell := '';
        FOREACH side IN ARRAY ARRAY['a', 'b'] LOOP
          pre  := CASE v_op WHEN 'I' THEN _mx_fill(r.ins_pre, r.tbl, side)
                            WHEN 'M' THEN _mx_fill(r.mov_pre, r.tbl, side) END;
          stmt := CASE v_op
                    WHEN 'S' THEN format('SELECT count(*) FROM %I WHERE %s', r.tbl, _mx_fill(r.key, r.tbl, side))
                    WHEN 'I' THEN _mx_fill(r.ins, r.tbl, side)
                    WHEN 'U' THEN format('UPDATE %I SET %s WHERE %s', r.tbl, r.upd, _mx_fill(r.key, r.tbl, side))
                    WHEN 'D' THEN format('DELETE FROM %I WHERE %s', r.tbl, _mx_fill(r.key, r.tbl, side))
                    -- guarded, because format() turns a NULL clause into an empty one
                    WHEN 'M' THEN CASE WHEN r.mov IS NOT NULL THEN
                                    format('UPDATE %I SET %s WHERE CURRENT OF (SELECT … WHERE %s FOR UPDATE)',
                                           r.tbl, _mx_fill(r.mov, r.tbl, side), _mx_fill(r.key, r.tbl, side))
                                  END
                  END;
          owner_must := CASE v_op WHEN 'M' THEN r.move_owner_must ELSE 'Y' END;

          IF stmt IS NULL THEN
            -- a move on a table with no tenant: nothing to probe, for anyone
            IF i <= array_length(who_logins, 1) THEN
              cell := cell || '-';
            END IF;

          -- The last pass is the owner: the statement itself must be valid,
          -- or every refusal on this line means nothing.
          ELSIF i > array_length(who_logins, 1) THEN
            outcome := CASE WHEN v_op = 'M'
                            THEN _mx_move_try('owner', pre, r.tbl, _mx_fill(r.key, r.tbl, side), _mx_fill(r.mov, r.tbl, side))
                            ELSE _mx_try('owner', pre, stmt) END;
            n_probes := n_probes + 1;
            IF left(outcome, 1) IS DISTINCT FROM owner_must THEN
              INSERT INTO _mx_failures VALUES ('matrix', format('%s %s', r.tbl, v_op),
                format('probe is invalid — the owner must answer %s (side %s): %s  [%s]', owner_must, side, outcome, stmt));
            END IF;
          ELSE
            outcome := CASE WHEN v_op = 'M'
                            THEN _mx_move_try(who_logins[i], pre, r.tbl, _mx_fill(r.key, r.tbl, side), _mx_fill(r.mov, r.tbl, side))
                            ELSE _mx_try(who_logins[i], pre, stmt) END;
            n_probes := n_probes + 1;
            cell := cell || left(outcome, 1);
            IF length(outcome) > 1 THEN
              details := details || format(E'\n      %s/%s: %s', who_names[i], side, substr(outcome, 3, 160));
            END IF;
          END IF;
        END LOOP;
        IF i <= array_length(who_logins, 1) THEN
          cells := cells || cell;
        END IF;
      END LOOP;

      n_lines := n_lines + 1;
      SELECT * INTO e FROM _mx_expected x WHERE x.tbl = r.tbl AND x.op = v_op;
      expected := CASE WHEN e.tbl IS NULL THEN NULL
                       ELSE ARRAY[e.anon, e.viewer, e.editor, e.supervisor, e.admin, e.other, e.super,
                                  e.staff_view, e.staff_support] END;

      IF expected IS DISTINCT FROM cells THEN
        n_bad := n_bad + 1;
        -- The two staff columns are filled by rule, so a mismatch there is
        -- read as "the rule below the table does not hold here", not as a line
        -- to retype.
        INSERT INTO _mx_failures VALUES ('matrix', format('%s %s', r.tbl, v_op),
          format(E'expected %s\n    actual   (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L),%s',
                 coalesce(array_to_string(expected, ' '), '<no expectation>'),
                 r.tbl, v_op, cells[1], cells[2], cells[3], cells[4], cells[5], cells[6], cells[7],
                 cells[8], cells[9], e.hole, details));
      ELSE
        RAISE NOTICE '%', format('ok  %-38s %s  %s%s%s', r.tbl, v_op, array_to_string(cells, ' '),
          CASE WHEN e.hole IS NOT NULL THEN '   HOLE[' || e.hole || ']' ELSE '' END,
          CASE WHEN v_op = 'M' AND r.mov IS NULL THEN '   (' || r.move_note || ')' ELSE '' END);
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE '── matrix: % lines, % differ from the recorded baseline, % probes in % (matrix.uncache=%) ──',
    n_lines, n_bad, n_probes,
    justify_interval(clock_timestamp() - t_start),
    coalesce(current_setting('matrix.uncache', true), 'on');

  -- A table or view nobody characterized is one whose access nobody has looked
  -- at. Reported, not failed: streams running in parallel add tables, and each
  -- should add its own lines here rather than break the others' runs.
  FOR r IN
    SELECT c.relname,
           CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS kind
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')
       AND c.relname NOT IN (SELECT tbl FROM _mx_spec)
       AND c.relname NOT IN (SELECT view_name FROM _mx_view_spec)
     ORDER BY 1
  LOOP
    RAISE WARNING 'UNCOVERED % public.% has no line in the matrix', r.kind, r.relname;
  END LOOP;
END $$;

-- ─── views ──────────────────────────────────────────────────────────────────
-- abrechnung_weekly is security_invoker, so it shows whatever the income and
-- receipts policies let the caller read. One cash income line per company,
-- dated in business month 3/2026, gives it a row to show or hide.

INSERT INTO income (id, description, amount, type, driver_name, date, company_id)
VALUES
  (_mx_id('view_income', 'a'), 'mx view', 1, 'bargeld', 'MX view a', '2026-03-10', 'c0000000-0000-4000-8000-00000000000a'),
  (_mx_id('view_income', 'b'), 'mx view', 1, 'bargeld', 'MX view b', '2026-03-10', 'c0000000-0000-4000-8000-00000000000b')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  who_names  constant text[] := _mx_who_names();
  who_logins constant text[] := _mx_who_logins();
  v        record;
  side     text;
  i        int;
  stmt     text;
  outcome  text;
  cell     text;
  cells    text[];
  details  text;
  expected text[];
BEGIN
  FOR v IN SELECT * FROM _mx_view_spec ORDER BY view_name LOOP
    cells   := ARRAY[]::text[];
    details := '';

    FOR i IN 1 .. array_length(who_logins, 1) + 1 LOOP
      cell := '';
      FOREACH side IN ARRAY ARRAY['a', 'b'] LOOP
        stmt := format('SELECT count(*) FROM %I WHERE %s', v.view_name, _mx_fill(v.key, v.view_name, side));

        -- The last pass is the owner, as in the matrix: the row must be there
        -- to see, or a principal seeing nothing proves nothing.
        IF i > array_length(who_logins, 1) THEN
          outcome := _mx_try('owner', NULL, stmt);
          IF left(outcome, 1) <> 'Y' THEN
            INSERT INTO _mx_failures VALUES ('view', format('%s S', v.view_name),
              format('probe is invalid — even the owner sees no row (side %s): %s  [%s]', side, outcome, stmt));
          END IF;
        ELSE
          outcome := _mx_try(who_logins[i], NULL, stmt);
          cell := cell || left(outcome, 1);
          IF length(outcome) > 1 THEN
            details := details || format(E'\n      %s/%s: %s', who_names[i], side, substr(outcome, 3, 160));
          END IF;
        END IF;
      END LOOP;
      IF i <= array_length(who_logins, 1) THEN
        cells := cells || cell;
      END IF;
    END LOOP;

    expected := ARRAY[v.anon, v.viewer, v.editor, v.supervisor, v.admin, v.other, v.super,
                      v.staff_view, v.staff_support];
    IF expected IS DISTINCT FROM cells THEN
      INSERT INTO _mx_failures VALUES ('view', format('%s S', v.view_name),
        format(E'expected %s\n    actual   (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L),%s',
               array_to_string(expected, ' '),
               v.view_name, v.key, cells[1], cells[2], cells[3], cells[4], cells[5], cells[6], cells[7],
               cells[8], cells[9], v.hole, details));
    ELSE
      RAISE NOTICE '%', format('ok  %-38s %s  %s%s', v.view_name || ' (view)', 'S', array_to_string(cells, ' '),
        CASE WHEN v.hole IS NOT NULL THEN '   HOLE[' || v.hole || ']' ELSE '' END);
    END IF;
  END LOOP;
END $$;

-- ─── named scenarios ────────────────────────────────────────────────────────
-- The holes the matrix can only hint at, spelled out one behaviour at a time.

CREATE OR REPLACE FUNCTION _mx_expect(p_section text, p_item text, p_got text, p_want text, p_hole text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF split_part(p_got, '|', 1) IS DISTINCT FROM p_want THEN
    INSERT INTO _mx_failures VALUES (p_section, p_item, format('expected %s, got %s', p_want, p_got));
  ELSE
    RAISE NOTICE '%', format('ok  %-10s %s  (%s)%s', p_section, p_item, p_want,
      CASE WHEN p_hole IS NOT NULL THEN '   HOLE[' || p_hole || ']' ELSE '' END);
  END IF;
END $$;

-- Two activation codes whose plain text is known, one per company.
INSERT INTO activation_codes (id, code_hash, duration_type, expires_at, created_by, company_id)
VALUES
  (_mx_id('known-code', 'a'), encode(sha256(convert_to('482915', 'UTF8')), 'hex'), '1_monat', now() + interval '7 days',
   'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a'),
  (_mx_id('known-code', 'b'), encode(sha256(convert_to('731604', 'UTF8')), 'hex'), '1_monat', now() + interval '7 days',
   'b0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000b')
ON CONFLICT (id) DO NOTHING;

-- A discount code nobody has redeemed, so a redeem probe reaches the point of
-- recording a redemption instead of stopping at "already used".
INSERT INTO discount_codes (id, code, discount_type, discount_value, usage_mode, audience_type, active)
VALUES (_mx_id('open-discount-code', 'x'), 'MX-OPEN', 'percentage', 10, 'once', 'multiple', true)
ON CONFLICT (id) DO NOTHING;

-- ── 3.1: the profile privilege guard ────────────────────────────────────────
DO $$
DECLARE
  co_a     constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b     constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  viewer_a constant uuid := 'a0000000-0000-4000-8000-000000000003';
  super_u  constant uuid := '50000000-0000-4000-8000-000000000001';
  member_a constant uuid := _mx_id('user_profiles', 'a');
  member_b constant uuid := _mx_id('user_profiles', 'b');
  r_admin  uuid := (SELECT id FROM roles WHERE name = 'admin'  AND company_id IS NULL);
  r_editor uuid := (SELECT id FROM roles WHERE name = 'editor' AND company_id IS NULL);
BEGIN
  -- Since 20260916110010 no JWT moves a profile between companies or grants the
  -- column, a platform owner's included. The three lines below were Y.
  PERFORM _mx_expect('guard', 'platform owner cannot move its own profile into company A',
    _mx_try('super', NULL, format('UPDATE user_profiles SET company_id = %L WHERE user_id = %L', co_a, super_u)),
    'T');
  -- These three were T until 20260917140000, and what moved them is the read
  -- seam, not the guard: platform_reads_company_data() is now a constant false,
  -- so a staff account with no context open sees no company's profiles, the
  -- UPDATE matches nothing and the guard is never reached. `.` is the same
  -- character the company-admin line below already uses for a row RLS hides.
  --
  -- On its own that is a weaker claim than these lines were written to make —
  -- at `.` they would pass with the guard dropped altogether — so each is
  -- followed by the same probe run from inside a support context, where the row
  -- is visible and the guard is what answers.
  PERFORM _mx_expect('guard', 'platform owner with no context cannot even see a company B member to move',
    _mx_try('super', NULL, format('UPDATE user_profiles SET company_id = %L WHERE user_id = %L', co_a, member_b)),
    '.');
  PERFORM _mx_expect('guard', 'platform owner with no context cannot see a company member to flag',
    _mx_try('super', NULL, format('UPDATE user_profiles SET is_super_admin = true WHERE user_id = %L', member_a)),
    '.');
  -- New with 20260916110010: no JWT hands a profile to another account. Both
  -- were Y before it, with no line here.
  PERFORM _mx_expect('guard', 'platform owner with no context cannot see a member whose user_id to change',
    _mx_try('super', NULL, format('UPDATE user_profiles SET user_id = %L WHERE user_id = %L', gen_random_uuid(), member_a)),
    '.');

  -- …and from inside a support session on company A, where every one of these
  -- rows is visible and the write policy admits the statement through the
  -- support session's company (20260921110000; company_users.manage before
  -- it). The guard is the only thing left to refuse them, and
  -- it does: a profile may not change company, may not be flagged, and may not
  -- be handed to another account, whoever asks and from wherever.
  PERFORM _mx_expect('guard', 'a support session cannot move the company''s member into another company',
    _mx_try('staff-support', NULL, format('UPDATE user_profiles SET company_id = %L WHERE user_id = %L', co_b, member_a)),
    'T');
  PERFORM _mx_expect('guard', 'a support session cannot grant is_super_admin to the company''s member',
    _mx_try('staff-support', NULL, format('UPDATE user_profiles SET is_super_admin = true WHERE user_id = %L', member_a)),
    'T');
  PERFORM _mx_expect('guard', 'a support session cannot change the company''s member''s user_id',
    _mx_try('staff-support', NULL, format('UPDATE user_profiles SET user_id = %L WHERE user_id = %L', gen_random_uuid(), member_a)),
    'T');
  PERFORM _mx_expect('guard', 'company admin cannot change a member''s user_id',
    _mx_try('admin-a', NULL, format('UPDATE user_profiles SET user_id = %L WHERE user_id = %L', gen_random_uuid(), member_a)),
    'T');
  PERFORM _mx_expect('guard', 'company admin cannot move its own profile to company B',
    _mx_try('admin-a', NULL, format('UPDATE user_profiles SET company_id = %L WHERE user_id = %L', co_b, admin_a)), 'T');
  PERFORM _mx_expect('guard', 'company admin cannot grant itself is_super_admin',
    _mx_try('admin-a', NULL, format('UPDATE user_profiles SET is_super_admin = true WHERE user_id = %L', admin_a)), 'T');
  PERFORM _mx_expect('guard', 'company admin cannot pull a company B member into company A',
    _mx_try('admin-a', NULL, format('UPDATE user_profiles SET company_id = %L WHERE user_id = %L', co_a, member_b)), '.');
  PERFORM _mx_expect('guard', 'company admin changes a member''s role',
    _mx_try('admin-a', NULL, format('UPDATE user_profiles SET role_id = %L WHERE user_id = %L', r_editor, member_a)), 'Y');
  PERFORM _mx_expect('guard', 'viewer cannot give itself the admin role',
    _mx_try('viewer-a', NULL, format('UPDATE user_profiles SET role_id = %L WHERE user_id = %L', r_admin, viewer_a)), 'T');
  PERFORM _mx_expect('guard', 'company admin deactivates a member',
    _mx_try('admin-a', NULL, format('UPDATE user_profiles SET status = %L WHERE user_id = %L', 'deactivated', member_a)), 'Y');
  PERFORM _mx_expect('guard', 'suspended editor cannot reactivate itself',
    _mx_try('suspended-a', NULL, format('UPDATE user_profiles SET status = %L WHERE user_id = %L', 'active', _mx_id('user', 'suspended-a'))), 'T');
  -- 20260917130000: the guard's company-admin exceptions now require the
  -- caller's own account to be usable, so a deactivated administrator changes
  -- nobody's status, its own included. This line was Y, tagged HOLE[3.3].
  PERFORM _mx_expect('guard', 'deactivated company admin cannot reactivate itself',
    _mx_try('deactivated-a', NULL, format('UPDATE user_profiles SET status = %L WHERE user_id = %L', 'active', _mx_id('user', 'deactivated-a'))),
    'T');
END $$;

-- ── 3.1: where platform rights come from ───────────────────────────────────
DO $$
DECLARE v text;
BEGIN
  PERFORM _mx_expect('platform', 'is_user_super_admin() is true for an active staff row alone',
    _mx_call('super', 'SELECT is_user_super_admin()::text'), 'Y');
  PERFORM _mx_expect('platform', 'is_user_super_admin() is false for a company admin',
    _mx_call('admin-a', 'SELECT is_user_super_admin()::text'), 'N');

  SELECT count(*) || ': ' || coalesce(string_agg(tablename || '.' || policyname, ', ' ORDER BY tablename, policyname), '')
    INTO v
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '(^|[^a-z_])is_super_admin([^a-z_]|$)';
  -- 20260916110010 moved all fifteen onto platform_can(); was 15
  PERFORM _mx_expect('catalogue', 'policies that read the is_super_admin column directly', v,
    '0: ');

  SELECT count(*) || ': ' || coalesce(string_agg(p.proname::text, ', ' ORDER BY p.proname), '')
    INTO v
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname <> 'is_user_super_admin'
     AND p.proname !~ '^_'
     AND p.prosrc ~ '(^|[^a-z_])is_super_admin([^a-z_]|$)';
  -- 20260916110010 moved the other seven onto platform_staff; was 8. The guard
  -- still names the column because it compares the old and the new value.
  PERFORM _mx_expect('catalogue', 'functions that read the is_super_admin column directly', v,
    '1: enforce_user_profile_privilege_guard');

  SELECT count(*) || ': ' || coalesce(string_agg(p.proname::text, ', ' ORDER BY p.proname), '')
    INTO v
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c WHERE c LIKE 'search_path=%');
  PERFORM _mx_expect('catalogue', 'SECURITY DEFINER functions without a pinned search_path', v,
    -- was 1 (enforce_car_limit): 20260916130020 pins every one of them with
    -- ALTER FUNCTION … SET, so no body created outside version control is
    -- rewritten. A new one without a pinned path fails here.
    '0: ');
END $$;

-- ── 3.3: company and user state, decided by the database ───────────────────
-- Each principal reads, inserts, updates and deletes a driver of its own
-- company, and reassigns one of its own trips through the planning RPC. Since
-- 20260917130000 a company that may not be used, and an account that may not
-- use it, get nothing: the tenant helper answers NULL, so SELECT, UPDATE and
-- DELETE match no row (.) and INSERT fails its WITH CHECK (R), and the planning
-- RPCs, which read the same helper, refuse with their own "caller has no
-- company" (T).
--
-- Two lines are controls that must stay allowed, because App.tsx admits both:
-- the company with a live subscription, and the invited employee —
-- an invitation that could not be completed would lock out every new employee.
DO $$
DECLARE
  r   record;
  got text;
BEGIN
  FOR r IN
    SELECT 'admin-' || s.slug AS who, _mx_id('company', s.slug) AS co,
           _mx_id('state-driver', s.slug) AS drv, _mx_id('state-trip', s.slug) AS trip, s.label,
           s.slug = 'livesub' AS allowed,
           0 AS grp
      FROM _mx_state_company s
    UNION ALL
    SELECT v.who, 'c0000000-0000-4000-8000-00000000000a'::uuid, _mx_id('drivers', 'a'), _mx_id('fahrtenbuch_trips', 'a'), v.label,
           v.allowed,
           1
      FROM (VALUES
        ('deactivated-a',   'deactivated user (admin) of an active company',                  false),
        ('suspended-a',     'suspended user (editor) of an active company',                   false),
        ('inactive-a',      'inactive user (editor) of an active company',                    false),
        ('pendinginvite-a', 'user (editor) with a pending invitation, of an active company',  true)
      ) AS v(who, label, allowed)
    ORDER BY grp, label
  LOOP
    got := left(_mx_try(r.who, NULL, format('SELECT count(*) FROM drivers WHERE id = %L', r.drv)), 1)
        || left(_mx_try(r.who, NULL, format('INSERT INTO drivers (company_id, name) VALUES (%L, %L)', r.co, 'MX state probe')), 1)
        || left(_mx_try(r.who, NULL, format('UPDATE drivers SET name = name WHERE id = %L', r.drv)), 1)
        || left(_mx_try(r.who, NULL, format('DELETE FROM drivers WHERE id = %L', r.drv)), 1);
    PERFORM _mx_expect('state', r.label || ': drivers S I U D', got,
      CASE WHEN r.allowed THEN 'YYYY' ELSE '.R..' END);

    -- 20260923130000 (slice C): the RPC asks current_role_permits('documents',
    -- true) after its own company branch. The two allowed principals are the
    -- live-subscription company's **administrator** (every `admin-…` row) and the invited
    -- **editor**, and the editor has held can_edit = false on the Dokumente
    -- page since 20260302065621 — so its cell moves Y → T. The claim this line
    -- makes does not weaken: `Y` used to say "the state gate admitted a
    -- pending_invite account", and the 42501 below says the same thing more
    -- strongly, because only a caller the state gate let past ever reaches the
    -- page check.
    got := _mx_call(r.who, format('SELECT reassign_fahrtenbuch_trip(%L, %L, %L)::text', r.trip, r.drv, 'MX state probe'));
    PERFORM _mx_expect('state', r.label || ': reassign_fahrtenbuch_trip on its own trip', got,
      CASE WHEN NOT r.allowed THEN 'T'
           WHEN r.who LIKE 'admin-%' THEN 'Y'
           ELSE 'T' END);

    -- T is the letter for both refusals, so it can no longer tell them apart.
    -- These two lines are what keeps the scenario's meaning: the invited editor
    -- is refused by the page and not for state, and every blocked principal is
    -- still refused for state and never reaches the page.
    IF r.allowed AND r.who NOT LIKE 'admin-%' THEN
      PERFORM _mx_expect('state', r.label || ': …and the refusal is the Dokumente page, not the state',
        CASE WHEN got LIKE 'T|42501|%' AND got NOT LIKE '%caller has no company%' THEN 'page' ELSE got END,
        'page');
    ELSIF NOT r.allowed THEN
      PERFORM _mx_expect('state', r.label || ': …and the refusal is the state, ahead of the page',
        CASE WHEN got LIKE '%caller has no company%' THEN 'state' ELSE got END,
        'state');
    END IF;
  END LOOP;
END $$;

-- ── 3.5: discount codes, activation codes, approval notes ───────────────────
DO $$
DECLARE
  co_b     constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  admin_b  constant uuid := 'b0000000-0000-4000-8000-000000000001';
  v_out    text;
  v_before bigint;
  v_after  bigint;
  v_refused int;
  i        int;
BEGIN
  -- Each check below is the hole's own probe turned around by 20260916130020:
  -- what used to be allowed is refused, and what the fix must not break is
  -- checked next to it.
  PERFORM _mx_expect('codes', 'viewer of company A cannot read a code assigned to company B',
    _mx_try('viewer-a', NULL, format('SELECT count(*) FROM discount_codes WHERE code = %L AND assigned_company_id = %L', 'MX-CODE-b', co_b)),
    '.');
  PERFORM _mx_expect('codes', 'the platform still reads every discount code',
    _mx_try('super', NULL, format('SELECT count(*) FROM discount_codes WHERE code = %L', 'MX-CODE-b')),
    'Y');

  PERFORM _mx_expect('codes', 'viewer of company A cannot record an attempt in company B''s name',
    _mx_try('viewer-a', NULL, format('INSERT INTO activation_code_attempts (company_id, user_id, success, reason) VALUES (%L, %L, false, %L)', co_b, admin_b, 'forged')),
    'R');
  PERFORM _mx_expect('codes', '…and still records one for its own company, which is what the RPCs write',
    _mx_try('viewer-a', NULL, format('INSERT INTO activation_code_attempts (company_id, user_id, success, reason) VALUES (%L, %L, false, %L)',
      'c0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000003', 'own')),
    'Y');

  -- Ten forged attempts used to lock company B out of its own valid code.
  BEGIN
    PERFORM _mx_become('viewer-a');
    BEGIN
      INSERT INTO activation_code_attempts (company_id, user_id, success, reason)
        SELECT co_b, admin_b, false, 'forged' FROM generate_series(1, 10);
      v_out := 'forged';
    EXCEPTION WHEN insufficient_privilege THEN
      v_out := 'refused';
    END;
    PERFORM _mx_become('admin-b');
    v_out := v_out || ', ' || CASE WHEN (redeem_activation_code('731604')::jsonb ->> 'success') = 'true'
                                   THEN 'redeemed' ELSE 'not redeemed' END;
    RAISE EXCEPTION USING ERRCODE = 'ZZ003', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ003' THEN v_out := SQLERRM;
    WHEN OTHERS THEN v_out := 'error: ' || SQLERRM;
  END;
  PERFORM _mx_expect('codes', 'the forging is refused and company B''s admin still redeems its own code',
    v_out, 'refused, redeemed');

  -- preview now records every guess and has a budget of its own: twenty in
  -- fifteen minutes, so the twenty-first through twenty-fifth are refused.
  BEGIN
    SELECT count(*) INTO v_before FROM activation_code_attempts;
    PERFORM _mx_become('viewer-a');
    v_refused := 0;
    FOR i IN 1 .. 25 LOOP
      v_out := preview_activation_code(lpad(i::text, 6, '9'))::text;
      IF v_out NOT LIKE '%nicht gefunden%' THEN
        v_refused := v_refused + 1;
      END IF;
    END LOOP;
    PERFORM _mx_become('owner');
    SELECT count(*) INTO v_after FROM activation_code_attempts;
    RAISE EXCEPTION USING ERRCODE = 'ZZ003',
      MESSAGE = format('25 wrong guesses, %s refused, %s recorded', v_refused, v_after - v_before);
  EXCEPTION
    WHEN SQLSTATE 'ZZ003' THEN v_out := SQLERRM;
    WHEN OTHERS THEN v_out := 'error: ' || SQLERRM;
  END;
  PERFORM _mx_expect('codes', 'preview_activation_code records every guess and refuses after twenty', v_out,
    '25 wrong guesses, 5 refused, 25 recorded');

  -- The two budgets are separate, which is what keeps previews from locking a
  -- company out of redeeming — the shape of the forging hole, from the inside.
  BEGIN
    PERFORM _mx_become('viewer-a');
    FOR i IN 1 .. 25 LOOP
      PERFORM preview_activation_code(lpad(i::text, 6, '9'));
    END LOOP;
    PERFORM _mx_become('admin-a');
    v_out := redeem_activation_code('999999')::text;
    RAISE EXCEPTION USING ERRCODE = 'ZZ003', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ003' THEN v_out := SQLERRM;
    WHEN OTHERS THEN v_out := 'error: ' || SQLERRM;
  END;
  PERFORM _mx_expect('codes', 'twenty-five failed previews do not spend the redeem budget',
    CASE WHEN v_out LIKE '%ungültig%' THEN 'answered' ELSE v_out END, 'answered');

  -- Redeeming spends the company's money, so it is the administrator's.
  BEGIN
    PERFORM _mx_become('viewer-a');
    v_out := redeem_activation_code('482915')::text;
    RAISE EXCEPTION USING ERRCODE = 'ZZ003', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ003' THEN v_out := SQLERRM;
    WHEN OTHERS THEN v_out := 'error: ' || SQLERRM;
  END;
  PERFORM _mx_expect('codes', 'a viewer cannot redeem its company''s activation code',
    CASE WHEN v_out LIKE '%Nur Administratoren%' THEN 'refused' ELSE v_out END, 'refused');

  BEGIN
    PERFORM _mx_become('admin-a');
    FOR i IN 1 .. 11 LOOP
      v_out := redeem_activation_code(lpad(i::text, 6, '9'))::text;
    END LOOP;
    RAISE EXCEPTION USING ERRCODE = 'ZZ003', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ003' THEN v_out := SQLERRM;
    WHEN OTHERS THEN v_out := 'error: ' || SQLERRM;
  END;
  PERFORM _mx_expect('codes', 'redeem_activation_code refuses after ten failed guesses',
    CASE WHEN v_out LIKE '%Zu viele Versuche%' THEN 'limited' ELSE v_out END, 'limited');

  -- The approval note is retired: the column is cleared on the way in, so there
  -- is nothing for a member to read. The rejection reason stays — a rejected
  -- company's owner is shown it on the rejected page.
  PERFORM _mx_expect('codes', 'no approval note is stored on a company row any more',
    _mx_try('viewer-a',
      $q$UPDATE companies SET approval_note = 'mx note' WHERE slug = 'test-a'$q$,
      $q$SELECT count(*) FROM companies WHERE slug = 'test-a' AND approval_note IS NOT NULL$q$),
    '.');
  PERFORM _mx_expect('codes', 'a member still reads its company''s rejection reason',
    _mx_try('viewer-a',
      $q$UPDATE companies SET rejection_reason = 'mx reason' WHERE slug = 'test-a'$q$,
      $q$SELECT count(*) FROM companies WHERE slug = 'test-a' AND rejection_reason = 'mx reason'$q$),
    'Y');
END $$;

-- ── RPCs ────────────────────────────────────────────────────────────────────
-- The RPCs the platform screens call, the planning RPCs phase 3.3 moves onto
-- the active-company helper, the Abrechnung RPCs of the company screens, and
-- every other SECURITY DEFINER function a client can call. One character per
-- principal, in the column order above: Y answered with success (or `true`, for
-- a probe written as a question), N refused by the function (or `false`), 0 no
-- value, P no EXECUTE grant, T/E raised, - not probed.
--
-- `-` marks exactly the callers whose EXECUTE a migration older than the
-- fixture revoked (20260427075001, 20260428102656, 20260607124839) and no later
-- migration restated. The fixture carries no privileges, so the container would
-- answer for a grant production no longer has. Every other anon cell is probed:
-- a function whose history only revoked PUBLIC keeps the explicit grant
-- Supabase's default privileges give anon at creation, here and — to be
-- confirmed on a copy of staging — there.

-- The fixture was dumped with --schema=public, so auth.users carries only what
-- the foreign keys needed. platform_users_list reads two of GoTrue's own
-- columns, and without them its probe would raise 42703 and record a hole that
-- only this database has. otp.sql and platform-authority.sql stub the same
-- columns for their own transactions; this one is rolled back with the file.
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sign_in_at    timestamptz;

-- Two planning runs of company A for the planning RPCs to act on: an archived
-- one that nothing references, and an applied one in a month no other probe uses.
INSERT INTO company_planning_runs (id, company_id, month, year, import_id, status, applied_at)
VALUES
  (_mx_id('rpc_run', 'a'),         'c0000000-0000-4000-8000-00000000000a', 5, 2026, _mx_id('fahrtenbuch_imports', 'a'), 'archived', NULL),
  (_mx_id('rpc_applied_run', 'a'), 'c0000000-0000-4000-8000-00000000000a', 4, 2026, _mx_id('fahrtenbuch_imports', 'a'), 'applied',  now())
ON CONFLICT (id) DO NOTHING;

-- A salary of company A that is still owed, for the Gehaltsquittung RPCs to
-- pay: on the second driver, in a month no other salary of that driver
-- overlaps. The receipt they void and sign is salary_cash_receipts' probe row.
INSERT INTO salaries (id, driver_id, period_start, period_end, created_by, company_id, netto_salary)
VALUES (_mx_id('rpc_salary', 'a'), _mx_id('drivers2', 'a'), '2026-04-01', '2026-04-30',
        'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 100)
ON CONFLICT (id) DO NOTHING;

-- A CONFIRMED partner link of company A, for partner_submission_claim_driver.
-- It cannot be the table section's row: that one is `pending` with no driver,
-- which is the state the claim refuses, and the two unique keys name the
-- external id and the driver. Measured, and the reason this fixture exists at
-- all: probed on a link that does not exist, the gate (42501) and the lookup
-- (P0002) both raise, so every principal read T and the cell said nothing
-- about the gate it was written for.
INSERT INTO partner_driver_links (id, company_id, partner, external_driver_id, driver_id, status, linked_at)
VALUES (_mx_id('rpc_partner_link', 'a'), 'c0000000-0000-4000-8000-00000000000a',
        'mx', 'mx-rpc', _mx_id('drivers2', 'a'), 'linked', now())
ON CONFLICT (id) DO NOTHING;

-- A CONFIRMED Reidey link of company A with a digits-only external id, for
-- income_import_uber: the function takes the partner's driver id as digits and
-- resolves OUR driver through this table. A probe on an id nobody linked would
-- raise driver_not_linked for every authorised caller and read T for all of
-- them, saying nothing about the gate it was written for.
INSERT INTO partner_driver_links (id, company_id, partner, external_driver_id, driver_id, status, linked_at)
VALUES (_mx_id('rpc_uber_link', 'a'), 'c0000000-0000-4000-8000-00000000000a',
        'reidey', '4711', _mx_id('drivers2', 'a'), 'linked', now())
ON CONFLICT (id) DO NOTHING;


-- Plan 3.5's write RPCs need a target each: an active plan
-- to assign, an invoice that is already paid (so "mark unpaid" has something to
-- undo), and three company-less accounts for the staff functions — one free,
-- one on the team, one disabled.
INSERT INTO subscription_plans (id, name, monthly_price, included_cars, drivers_per_car_limit, is_active)
VALUES (_mx_id('rpc_plan', 'a'), 'MX rpc plan', 20, 1, 4, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO subscription_invoices (id, company_id, subscription_id, invoice_month, invoice_year,
                                   invoice_number, amount, due_date, status, paid_at, cash_received_amount)
VALUES (_mx_id('rpc_paid_invoice', 'a'), 'c0000000-0000-4000-8000-00000000000a',
        _mx_id('company_subscriptions', 'a'), 9, 2026, 'INV-2026-3901', 20, '2026-09-30', 'paid', now(), 20)
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (id, email) VALUES
  (_mx_id('rpc_staff_free', 'a'),     'mx-staff-free@test.invalid'),
  (_mx_id('rpc_staff_active', 'a'),   'mx-staff-active@test.invalid'),
  (_mx_id('rpc_staff_disabled', 'a'), 'mx-staff-disabled@test.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, company_id, status) VALUES
  (_mx_id('rpc_staff_free', 'a'),     'mx-staff-free@test.invalid',     'MX Staff Free',     'viewer', NULL, 'active'),
  (_mx_id('rpc_staff_active', 'a'),   'mx-staff-active@test.invalid',   'MX Staff Active',   'viewer', NULL, 'active'),
  (_mx_id('rpc_staff_disabled', 'a'), 'mx-staff-disabled@test.invalid', 'MX Staff Disabled', 'viewer', NULL, 'active')
ON CONFLICT (user_id) DO NOTHING;

-- Owner rows: disabling one leaves the seeded platform principal active, so the
-- last-owner trigger is not what the probe measures.
INSERT INTO app_private.platform_staff (user_id, role, disabled_at, note) VALUES
  (_mx_id('rpc_staff_active', 'a'),   'owner', NULL,  'mx rpc'),
  (_mx_id('rpc_staff_disabled', 'a'), 'owner', now(), 'mx rpc')
ON CONFLICT (user_id) DO NOTHING;

-- One announcement (20260920130010) for the delete probe to find, at version 1.
-- Every probe is rolled back, so each principal finds it as it was.
INSERT INTO app_private.platform_announcements
  (id, tone, title_de, body_de, audience, starts_at)
VALUES (_mx_id('rpc_announcement', 'a'), 'info', 'MX', 'MX probe', 'all', now() - interval '1 hour')
ON CONFLICT (id) DO NOTHING;

-- A company role of A for the two company-roles RPCs (20260923120000) to edit
-- and delete: its own row rather than the table section's, so no account holds
-- it and `company_role_delete` answers about the policies and not about the
-- foreign key. A name no other probe uses, because the per-company unique index
-- is case-insensitive.
INSERT INTO roles (id, name, description, company_id, is_system)
VALUES (_mx_id('rpc_role', 'a'), 'mx-rpc-role-a', 'MX rpc role', _mx_co('a'), false)
ON CONFLICT (id) DO NOTHING;

-- A draft monthly plan of company A for monthly_plan_confirm to make active
-- (20260930100000). Its one block is unassigned, so the plan is not empty and
-- no driver's hours cap is in play — this line probes who may confirm, not what
-- the confirm gate re-derives, which tests/rls/monthly-plan.sql does. Every
-- probe is rolled back, so each principal finds it as a draft.
INSERT INTO monthly_plans (id, company_id, year, month, switch_minutes)
VALUES (_mx_id('rpc_monthly_plan', 'a'), _mx_co('a'), 2027, 3, 30)
ON CONFLICT (id) DO NOTHING;

INSERT INTO monthly_plan_blocks (id, company_id, plan_id, block_key, car_identifier,
                                 starts_at, ends_at, span_minutes, ride_minutes)
VALUES (_mx_id('rpc_monthly_block', 'a'), _mx_co('a'), _mx_id('rpc_monthly_plan', 'a'),
        'mx-rpc', 'MX-CAR', '2027-03-02 08:23+01', '2027-03-02 09:44+01', 81, 81)
ON CONFLICT (id) DO NOTHING;

-- The company platform_company_delete is probed against (20261016140000): it
-- has to be marked deleted, or the function refuses before it reaches anything
-- interesting. Every probe is rolled back, so each principal finds it again.
INSERT INTO companies (id, name, slug, status)
VALUES ('c0000000-0000-4000-8000-0000000000dd', 'MX Deleted', 'mx-deleted', 'deleted')
ON CONFLICT (id) DO NOTHING;

-- Checked in the order listed. `stmt` is filled for company A (see _mx_fill).
--
-- `want` carries the seven principals of the columns above. `staff` carries the
-- two context principals and is filled after the list: unless it is named there,
-- an open context changes nothing about an RPC's answer, so both take the
-- `super` character. The exceptions are exactly the functions that read the
-- company through get_active_company_id() or write a tenant's rows — and they
-- are the point of this slice.
CREATE TEMP TABLE _mx_rpc (ord serial, label text, stmt text, want text, staff text, hole text);

INSERT INTO _mx_rpc (label, stmt, want, hole) VALUES
    -- the platform screens. is_user_super_admin() answers false, not NULL, to
    -- anon since 20260915130000, which restates anon's grant (staging held it
    -- too), so that cell is probed. Since 20260916110010 it asks platform_staff
    -- and still answers false there
    ('is_user_super_admin()',
     $q$SELECT is_user_super_admin()::text$q$,
     'NNNNNNY', NULL),
    -- anon's EXECUTE on the next four revoked by 20260915140000. Only the super
    -- admin's dashboard calls them, signed in. Their anon cell moved from N
    -- (the guard answered success=false) to P: NNNNNNY became PNNNNNY.
    -- 20260916110010 rewrote them onto platform_can() with CREATE OR REPLACE
    -- and restates those grants, so no cell moves with it
    ('revoke_activation_code(code of A)',
     $q$SELECT revoke_activation_code({ref:activation_codes})::text$q$,
     'PNNNNNY', NULL),
    ('delete_activation_code(code of A)',
     $q$SELECT delete_activation_code({ref:activation_codes})::text$q$,
     'PNNNNNY', NULL),
    ('hide_activation_code(code of A)',
     $q$SELECT hide_activation_code({ref:activation_codes}, 'mx')::text$q$,
     'PNNNNNY', NULL),
    ('update_company_subscription_manual(company B)',
     $q$SELECT update_company_subscription_manual('c0000000-0000-4000-8000-00000000000b', 'active', now(), now() + interval '30 days', '1_monat', 'mx')::text$q$,
     'PNNNNNY', NULL),
    -- the platform helpers of 20260916110000, for signed-in callers only: anon
    -- holds EXECUTE on none of them, and each answers nothing without a staff row
    ('platform_staff_role() is set',
     $q$SELECT (platform_staff_role() IS NOT NULL)::text$q$,
     'PNNNNNY', NULL),
    ('platform_can(codes.manage)',
     $q$SELECT platform_can('codes.manage')::text$q$,
     'PNNNNNY', NULL),
    ('platform_whoami() names a role',
     $q$SELECT (platform_whoami() ->> 'role' IS NOT NULL)::text$q$,
     'PNNNNNY', NULL),
    -- writes a row for staff only; NULL, so N, for everyone else. 20260916130000
    -- narrowed it to the actions the edge functions actually send, so the probe
    -- names one of them; `matrix.probe` is now refused, which the next line
    -- records. The platform principal is an owner and holds business.read, the
    -- capability manage_users.list needs to be recorded as anything but denied.
    ('platform_audit_record(read manage_users.list)',
     $q$SELECT (platform_audit_record('read', 'manage_users.list', 'ok') IS NOT NULL)::text$q$,
     'PNNNNNY', NULL),
    -- An action no function sends is an argument error (22023) for every caller
    -- that may open the door at all, so nothing can write a row that passes for
    -- one the database itself wrote.
    ('platform_audit_record(an action nothing sends)',
     $q$SELECT platform_audit_record('read', 'matrix.probe', 'ok')::text$q$,
     'PEEEEEE', NULL),
    ('platform_can_manage_account(member of A)',
     $q$SELECT platform_can_manage_account({ref:user_profiles})::text$q$,
     'PNNNNNY', NULL),
    -- service role only (20260916110010): manage-users asks it for a company admin
    ('account_is_platform_staff(member of A)',
     $q$SELECT account_is_platform_staff({ref:user_profiles})::text$q$,
     'PPPPPPP', NULL),
    -- 20260919140000, the codeless email change for a platform account. Both are
    -- service role only, like account_is_platform_staff above: the caller is the
    -- platform-staff edge function acting for a user id it has just verified, so
    -- every principal a client can be — the platform owner included — is refused
    -- by privilege before either function's own guard is reached.
    ('platform_self_email_change_check(member of A)',
     $q$SELECT platform_self_email_change_check({ref:user_profiles}, 'mx-probe@test.invalid')$q$,
     'PPPPPPP', NULL),
    ('platform_self_email_change_record(member of A)',
     $q$SELECT platform_self_email_change_record({ref:user_profiles}, 'mx-old@test.invalid', 'mx-new@test.invalid')::text$q$,
     'PPPPPPP', NULL),
    -- the read models of 20260916140000 (plan 3.6b). Each is authenticated
    -- only, and answers {"ok": false, "reason": "not_authorized"} without the
    -- capability rather than raising, so the probe asks for `ok` and a refusal
    -- reads N. `super` is an owner, which holds companies.read, business.read
    -- and audit.read; no company principal holds any of them. Each call also
    -- writes its audit row, which this file's ROLLBACK takes back
    ('platform_companies_list() is allowed',
     $q$SELECT platform_companies_list() ->> 'ok'$q$,
     'PNNNNNY', NULL),
    ('platform_vehicles_list(company A) is allowed',
     $q$SELECT platform_vehicles_list({co}) ->> 'ok'$q$,
     'PNNNNNY', NULL),
    ('platform_drivers_list(company A) is allowed',
     $q$SELECT platform_drivers_list({co}) ->> 'ok'$q$,
     'PNNNNNY', NULL),
    ('platform_users_list(company A) is allowed',
     $q$SELECT platform_users_list({co}) ->> 'ok'$q$,
     'PNNNNNY', NULL),
    ('platform_audit_list() is allowed',
     $q$SELECT platform_audit_list() ->> 'ok'$q$,
     'PNNNNNY', NULL),
    -- the sixth read model, 20260920140000 (plan 3.12): the platform team with
    -- each member's address, for staff.manage, which `super` holds as an owner
    -- and no company principal does. tests/rls/platform-readmodels.sql section
    -- 11 takes the other three staff roles through it
    ('platform_staff_list() is allowed',
     $q$SELECT platform_staff_list() ->> 'ok'$q$,
     'PNNNNNY', NULL),
    -- the seventh and eighth read models, 20260924110000 (decision D14): the
    -- money. Both ask billing.manage, which `super` holds as an owner and no
    -- company principal does. tests/rls/platform-readmodels.sql section 12 takes
    -- the other three staff roles through them — `support` and `read_only` are
    -- refused, which is the behaviour change the decision makes
    ('platform_invoices_list() is allowed',
     $q$SELECT platform_invoices_list() ->> 'ok'$q$,
     'PNNNNNY', NULL),
    ('platform_subscriptions_list() is allowed',
     $q$SELECT platform_subscriptions_list() ->> 'ok'$q$,
     'PNNNNNY', NULL),
    -- the ninth read model, 20261015160000: what each active subscription's
    -- invoice for a period costs, and whether it is the company's first. Same
    -- capability and the same shape as the two above.
    ('platform_invoice_quotes(10, 2026) is allowed',
     $q$SELECT platform_invoice_quotes(10, 2026) ->> 'ok'$q$,
     'PNNNNNY', NULL),
    -- anon's EXECUTE revoked by 20260915120000; the platform's invoice screen
    -- calls it signed in. It was SECURITY INVOKER and read subscription_invoices
    -- under the caller's own RLS, so every principal got a number — a company
    -- user's computed from its own invoices, which was never a number it could
    -- use. D14 narrowed that policy, which would have left it answering
    -- 'INV-<year>-0001' for every call and made invoice generation report every
    -- company as skipped and create nothing, with no error anywhere. It is a
    -- definer behind billing.manage now and answers NULL ('0' here) to anyone
    -- else, which GenerateInvoicesModal already reports per company.
    ('generate_invoice_number(2026)',
     $q$SELECT generate_invoice_number(2026)$q$,
     'P00000Y', NULL),
    -- anon's EXECUTE on both activation-code RPCs revoked by 20260915110000
    -- 20260916130020: a member of the code's own company still previews it, and
    -- the super admin no longer does — it belongs to no company, and the
    -- binding comparison that used to read NULL and fall through now refuses.
    ('preview_activation_code(valid code of A)',
     $q$SELECT preview_activation_code('482915')::text$q$,
     'PYYYYNN', NULL),
    -- …and redeeming is the company administrator's alone.
    ('redeem_activation_code(valid code of A)',
     $q$SELECT redeem_activation_code('482915')::text$q$,
     'PNNNYNN', NULL),
    -- service_role only. 20260911120000 revoked PUBLIC and authenticated and
    -- left the explicit grant Supabase's default privileges give anon, so anyone
    -- holding the anon key could redeem a code against any company, until
    -- 20260915110000 revoked it.
    ('redeem_discount_code(unused code, company A)',
     $q$SELECT redeem_discount_code('MX-OPEN', 'c0000000-0000-4000-8000-00000000000a', 'basic', 'monthly', 1)::text$q$,
     'PPPPPPP', NULL),
    -- anon's EXECUTE revoked by 20260915120000. 20260916150000 made it
    -- SECURITY DEFINER so it can read the price book out of app_private, and
    -- restates the same grants, so no cell moves with it
    ('compute_plan_price(basic, 5, monthly)',
     $q$SELECT compute_plan_price('basic', 5, 'monthly')::text$q$,
     'PYYYYYY', NULL),
    -- 20261015160000 gave it a fourth argument, the first invoice, and dropped
    -- the three-argument form. The grants are restated, so no cell moves.
    ('compute_plan_price(basic, 5, monthly, first invoice)',
     $q$SELECT compute_plan_price('basic', 5, 'monthly', true)::text$q$,
     'PYYYYYY', NULL),

    -- Plan 3.5's platform write RPCs (20260916130000, 20260916130010). Each
    -- asks platform_can for its capability and writes its own audit row, the
    -- refusal included, so a member's N here is a recorded `denied`. anon holds
    -- EXECUTE on none of them, and neither does the service role, which has no
    -- auth.uid() to be an actor. The platform principal is an owner and so holds
    -- every capability; tests/rls/platform-rpcs.sql takes the other three roles
    -- through the same list.
    ('platform_company_create(new company)',
     $q$SELECT platform_company_create('MX RPC', 'mx-rpc-company')::text$q$,
     'PNNNNNY', NULL),
    ('platform_company_update(company A)',
     $q$SELECT platform_company_update('c0000000-0000-4000-8000-00000000000a', 'Test A', 'test-a')::text$q$,
     'PNNNNNY', NULL),
    ('platform_company_set_approval(company A, approve)',
     $q$SELECT platform_company_set_approval('c0000000-0000-4000-8000-00000000000a', 'approve')::text$q$,
     'PNNNNNY', NULL),
    ('platform_company_set_status(company A, suspended)',
     $q$SELECT platform_company_set_status('c0000000-0000-4000-8000-00000000000a', 'suspended')::text$q$,
     'PNNNNNY', NULL),
    ('platform_company_lifecycle(company A, archive)',
     $q$SELECT platform_company_lifecycle('c0000000-0000-4000-8000-00000000000a', 'archive')::text$q$,
     'PNNNNNY', NULL),
    ('platform_company_set_plan(company A, premium)',
     $q$SELECT platform_company_set_plan('c0000000-0000-4000-8000-00000000000a', 'premium')::text$q$,
     'PNNNNNY', NULL),
    ('platform_subscription_assign(company A)',
     $q$SELECT platform_subscription_assign('c0000000-0000-4000-8000-00000000000a', {ref:rpc_plan})::text$q$,
     'PNNNNNY', NULL),
    ('platform_invoice_mark_paid(invoice of A, 2000 cents)',
     $q$SELECT platform_invoice_mark_paid({ref:subscription_invoices}, 2000)::text$q$,
     'PNNNNNY', NULL),
    ('platform_invoice_mark_unpaid(paid invoice of A)',
     $q$SELECT platform_invoice_mark_unpaid({ref:rpc_paid_invoice})::text$q$,
     'PNNNNNY', NULL),
    ('platform_invoice_cancel(invoice of A)',
     $q$SELECT platform_invoice_cancel({ref:subscription_invoices})::text$q$,
     'PNNNNNY', NULL),
    ('platform_invoice_delete(unpaid invoice of A)',
     $q$SELECT platform_invoice_delete({ref:subscription_invoices})::text$q$,
     'PNNNNNY', NULL),
    ('platform_discount_code_save(create)',
     $q$SELECT platform_discount_code_save(NULL, '{"code":"MX-RPC","discount_type":"percentage","discount_value":5,"usage_mode":"once","audience_type":"multiple"}'::jsonb)::text$q$,
     'PNNNNNY', NULL),
    ('platform_discount_code_save(update code of A)',
     $q$SELECT platform_discount_code_save({ref:discount_codes}, '{"discount_value":7}'::jsonb)::text$q$,
     'PNNNNNY', NULL),
    ('platform_discount_code_set_active(code of A, false)',
     $q$SELECT platform_discount_code_set_active({ref:discount_codes}, false)::text$q$,
     'PNNNNNY', NULL),
    ('platform_discount_code_delete(code of A)',
     $q$SELECT platform_discount_code_delete({ref:discount_codes})::text$q$,
     'PNNNNNY', NULL),
    ('platform_staff_add(a company-less account, owner)',
     $q$SELECT platform_staff_add({ref:rpc_staff_free}, 'owner', 'mx')::text$q$,
     'PNNNNNY', NULL),
    ('platform_staff_disable(another owner)',
     $q$SELECT platform_staff_disable({ref:rpc_staff_active})::text$q$,
     'PNNNNNY', NULL),
    ('platform_staff_enable(a disabled owner)',
     $q$SELECT platform_staff_enable({ref:rpc_staff_disabled})::text$q$,
     'PNNNNNY', NULL),
    -- 20260923140000: an existing member's role. Demoting an active owner needs
    -- another active owner to remain, and the platform principal is one, so
    -- this is a change the RPC allows rather than a last_owner refusal.
    -- tests/rls/platform-rpcs.sql section 5b takes it through every refusal.
    ('platform_staff_set_role(an active owner → support)',
     $q$SELECT platform_staff_set_role({ref:rpc_staff_active}, 'support')::text$q$,
     'PNNNNNY', NULL),
    -- the settings RPCs of 20260916150000. Both answer ok=false without an
    -- active staff role, so only the platform principal gets Y; anon holds
    -- EXECUTE on neither. tests/rls/pricing.sql probes them by role
    ('platform_settings_get(price_book) is ok',
     $q$SELECT (platform_settings_get('price_book') ->> 'ok')::text$q$,
     'PNNNNNY', NULL),
    -- version 2 and the first month since 20261015160000, which added the
    -- figure to the stored book and raised its version
    ('platform_settings_put(price_book, the seeded book, version 2) is ok',
     $q$SELECT (platform_settings_put('price_book', '{"first_month_cents":20000,"price_per_car_cents":{"basic":2000,"advanced":4000,"premium":7000},"fleet_discount_tiers":[{"min_cars":6,"percent":5},{"min_cars":11,"percent":10}],"yearly_discount_percent":10}'::jsonb, 2) ->> 'ok')::text$q$,
     'PNNNNNY', NULL),
    -- the product configuration: the price book is public (the landing page
    -- prices plans before anyone signs in), the feature map is not
    ('get_public_config() carries a price book',
     $q$SELECT (get_public_config() -> 'price_book' IS NOT NULL)::text$q$,
     'YYYYYYY', NULL),
    ('get_app_config() carries the feature map',
     $q$SELECT (get_app_config() -> 'plan_features' IS NOT NULL)::text$q$,
     'PYYYYYY', NULL),
    -- 20260921120000: the Impressum and the privacy text are public pages, so
    -- anon and every signed-in principal read them. tests/rls/legal-pages.sql
    -- pins which fields that answer carries
    ('get_legal_pages() carries an Impressum',
     $q$SELECT (get_legal_pages() -> 'impressum' IS NOT NULL)::text$q$,
     'YYYYYYY', NULL),
    -- 20260920130000 (plan 3.10): the invoice screen's sender. companies.read,
    -- which every staff role holds, so only the platform principal gets Y; a
    -- company user is refused as a return value and anon holds no EXECUTE
    ('platform_invoice_seller() is ok',
     $q$SELECT (platform_invoice_seller() ->> 'ok')::text$q$,
     'PNNNNNY', NULL),
    -- …and what the edge functions read before they mail a code: service role
    -- only, so every principal a client can be is refused by privilege
    ('mail_delivery_settings(signup_verify)',
     $q$SELECT mail_delivery_settings('signup_verify')::text$q$,
     'PPPPPPP', NULL),
    -- 20260920130010 (plan 3.11): the panel's announcement RPCs. List is
    -- settings.read, save and delete settings.manage; the platform principal
    -- (an owner) holds both, nobody else holds either. tests/rls/announcements.sql
    -- takes the other staff roles through them
    ('platform_announcements_list() is ok',
     $q$SELECT (platform_announcements_list() ->> 'ok')::text$q$,
     'PNNNNNY', NULL),
    ('platform_announcement_save(create) is ok',
     $q$SELECT (platform_announcement_save(NULL, '{"tone":"info","title_de":"MX","body_de":"MX","title_en":"","body_en":"","audience":"all","plans":[],"company_ids":[],"starts_at":"2026-09-20T00:00:00Z","ends_at":null}'::jsonb, NULL) ->> 'ok')::text$q$,
     'PNNNNNY', NULL),
    ('platform_announcement_delete(announcement, version 1) is ok',
     $q$SELECT (platform_announcement_delete({ref:rpc_announcement}, 1) ->> 'ok')::text$q$,
     'PNNNNNY', NULL),

    -- the planning RPCs, on company A's import, trip and runs. Company B's
    -- admin makes the same calls with company A's ids. anon's EXECUTE on
    -- the first four was revoked by 20260915120000; each raised for anon before.
    --
    -- 20260923130000 (slice C): all five now ask
    -- current_role_permits('documents', true) — the page their tables carry —
    -- right after their own "caller has no company" branch, and raise 42501
    -- with HINT not_authorized. So the viewer and editor cells move Y → T on
    -- every one of them: these functions are SECURITY DEFINER and ran past RLS,
    -- which is why gating the tables alone would have left the window open.
    -- The supervisor and admin cells do not move, and neither does `other`
    -- (company B's admin, which still opens a run in its own company and
    -- changes none of A's trips) or `super` (no context: refused for state).
    ('apply_monthly_planning_run(import and trip of A)',
     $q$SELECT ((apply_monthly_planning_run(jsonb_build_object(
          'import_id', {ref:fahrtenbuch_imports}, 'month', 3, 'year', 2026,
          'change_rows', jsonb_build_array(jsonb_build_object(
            'trip_id', {ref:fahrtenbuch_trips}, 'driver_id', {ref:drivers}, 'driver_name', 'MX'))))
        ->> 'updated_trips')::int > 0)::text$q$,
     'PTTYYNT', NULL),
    ('replace_monthly_planning_run(applied run of A)',
     $q$SELECT ((replace_monthly_planning_run(jsonb_build_object(
          'import_id', {ref:fahrtenbuch_imports}, 'month', 4, 'year', 2026,
          'change_rows', jsonb_build_array(jsonb_build_object(
            'trip_id', {ref:fahrtenbuch_trips}, 'driver_id', {ref:drivers}, 'driver_name', 'MX'))),
        {ref:rpc_applied_run}) ->> 'updated_trips')::int > 0)::text$q$,
     'PTTYYTT', NULL),
    ('delete_or_archive_monthly_planning_run(run of A)',
     $q$SELECT delete_or_archive_monthly_planning_run({ref:rpc_run})::text$q$,
     'PTTYYTT', NULL),
    ('purge_old_monthly_planning_runs(month of A''s archived run)',
     $q$SELECT ((purge_old_monthly_planning_runs(5, 2026) ->> 'deleted_count') IS NOT NULL)::text$q$,
     'PTTYYNT', NULL),
    -- anon's EXECUTE revoked by 20260607124839, before the fixture, yet still
    -- held on staging on 15.09.2026, and revoked again by 20260915140000,
    -- which the kit applies, so the anon cell is probed. It moved from - (not
    -- probed) to P: -YYYYTT became PYYYYTT
    ('reassign_fahrtenbuch_trip(trip of A)',
     $q$SELECT reassign_fahrtenbuch_trip({ref:fahrtenbuch_trips}, {ref:drivers}, 'MX', 'pending', 'mx', 'mx')::text$q$,
     'PTTYYTT', NULL),

    -- The monthly plan's two RPCs (20260930100000). Both ask
    -- get_active_company_id() and then current_role_permits('documents', true),
    -- like slice C's five above, so the viewer and the editor are T and `super`
    -- is T on the state branch, having neither a company nor a context.
    --
    -- `other` differs between them, and each answer is the point of its
    -- function: company B's admin saving A's driver is refused by the snapshot
    -- guard (T, driver_company_mismatch), while confirming A's plan is a
    -- *return value* (N, plan_not_found) — section 9's screen has to show two
    -- choices, so a refusal there may not be an exception.
    -- Both monthly-plan RPCs CHANGE STATE, and this harness runs one probe per
    -- principal against one fixture. `monthly_plan_save` writes a plan for a
    -- fixed month, so the second principal hits the partial unique index and
    -- then blocks on the advisory lock the first principal's transaction still
    -- holds — which is what killed the backend, twice, right after
    -- `platform_context_open`. Their authorization is covered per principal in
    -- `tests/rls/monthly-plan.sql`, which drives each call in its own
    -- transaction; here only the EXECUTE grant is probed, which is what a
    -- matrix line can honestly ask of a state-changing function.
    ('monthly_plan_save(execute grant only)',
     $q$SELECT has_function_privilege(current_user, 'public.monthly_plan_save(jsonb)', 'EXECUTE')::text$q$,
     'NYYYYYY', NULL),
    ('monthly_plan_confirm(execute grant only)',
     $q$SELECT has_function_privilege(current_user, 'public.monthly_plan_confirm(uuid,boolean)', 'EXECUTE')::text$q$,
     'NYYYYYY', NULL),

    -- The vehicle day plan's two RPCs (20261022140000), probed the same way and for
    -- the same reason: both CHANGE STATE (a save takes the month's advisory lock and
    -- discards the month's draft), and this harness runs one probe per principal
    -- against one fixture. Their authorization is probed per principal, each call
    -- in its own transaction, in tests/rls/vehicle-day-plans.sql: the viewer and
    -- the editor print not_authorized, a suspended company and a platform owner
    -- with no context print no_company, anon prints a missing GRANT, a view context
    -- prints not_authorized and a support session saves.
    ('vehicle_day_plan_save(execute grant only)',
     $q$SELECT has_function_privilege(current_user, 'public.vehicle_day_plan_save(jsonb)', 'EXECUTE')::text$q$,
     'NYYYYYY', NULL),
    ('vehicle_day_plan_confirm(execute grant only)',
     $q$SELECT has_function_privilege(current_user, 'public.vehicle_day_plan_confirm(uuid,boolean)', 'EXECUTE')::text$q$,
     'NYYYYYY', NULL),

    -- the Abrechnung and cash RPCs: security invoker, so they return what the
    -- income, receipts and cash_transactions policies let the caller read.
    -- anon's EXECUTE revoked by 20260427075001 and 20260428102656.
    ('get_weekly_abrechnung(2026, 3) shows company A''s line',
     $q$SELECT (count(*) > 0)::text FROM get_weekly_abrechnung(2026, 3) WHERE driver_name = 'MX view a'$q$,
     '-YYYYNN', NULL),
    ('get_monthly_abrechnung(2026, 3) shows company A''s line',
     $q$SELECT (count(*) > 0)::text FROM get_monthly_abrechnung(2026, 3) WHERE driver_name = 'MX view a'$q$,
     '-YYYYNN', NULL),
    ('get_driver_weekly_abrechnung(driver of A, 2026, 3) has a line',
     $q$SELECT (count(*) > 0)::text FROM get_driver_weekly_abrechnung('MX view a', 2026, 3)$q$,
     '-YYYYNN', NULL),
    ('get_driver_monthly_abrechnung(driver of A, 2026, 3) has a line',
     $q$SELECT (count(*) > 0)::text FROM get_driver_monthly_abrechnung('MX view a', 2026, 3)$q$,
     '-YYYYNN', NULL),
    -- broken for every caller: it reads receipts."user", a column receipts no
    -- longer has (42703). Nothing in src/ calls it.
    ('get_current_cash_balance()',
     $q$SELECT get_current_cash_balance()::text$q$,
     '-EEEEEE', NULL),

    -- the tenant helpers behind the policies. anon's EXECUTE on the first one
    -- was revoked by 20260427075001; is_company_admin and current_role_permits
    -- only ever lost PUBLIC.
    ('get_user_company_id() is company A',
     $q$SELECT (get_user_company_id() = 'c0000000-0000-4000-8000-00000000000a')::text$q$,
     '-YYYYN0', NULL),
    -- 20260917130000: the business tables' predicate. The same answer as the
    -- membership helper above for a healthy company, NULL for a platform
    -- account, and no EXECUTE for anon — every policy that calls it is TO
    -- authenticated. tests/rls/tenant-state.sql takes it through every state
    ('get_active_company_id() is company A',
     $q$SELECT (get_active_company_id() = 'c0000000-0000-4000-8000-00000000000a')::text$q$,
     'PYYYYN0', NULL),
    -- Both seams answer false to everyone since 20260917140000. Neither takes a
    -- company, so a true in either would open every company at once through the
    -- OR beside the tenant term; the company a staff account may touch is the
    -- one its context names, and get_active_company_id() answers that
    ('platform_reads_company_data()',
     $q$SELECT platform_reads_company_data()::text$q$,
     'PNNNNNN', NULL),
    ('platform_writes_company_data()',
     $q$SELECT platform_writes_company_data()::text$q$,
     'PNNNNNN', NULL),
    ('is_company_admin()',
     $q$SELECT is_company_admin()::text$q$,
     'NNNNYYN', NULL),
    -- false for a caller without a profile row. It answered NULL there until
    -- 20260915130000 made is_user_super_admin() answer false to that caller;
    -- the platform_staff body of 20260916110010 keeps answering false.
    -- 20260917130000 removed the `is_user_super_admin() OR …` term from the
    -- body altogether, so the platform column reads Y for the reason every
    -- other column does: seed.sql gives that account the text role `admin` and
    -- the system admin role_id, and roles-seed.sql gives that role can_edit on
    -- all sixteen pages. 20260917140000 asks the profile first and returns
    -- there, exactly as 3.3 did, so this cell does not move — the support
    -- session is the *fallback* for an account whose profile grants nothing,
    -- which is what the two context principals are (role `viewer`, can_edit
    -- false everywhere) and what a platform account looks like after 3.7b
    ('current_role_permits(drivers, edit)',
     $q$SELECT current_role_permits('drivers', true)::text$q$,
     'NNYYYYY', NULL),
    ('get_current_user_role()',
     $q$SELECT get_current_user_role()$q$,
     '-YYYYYY', NULL),
    ('is_role(admin)',
     $q$SELECT is_role('admin')::text$q$,
     '-NNNYYY', NULL),
    ('is_support_user()',
     $q$SELECT is_support_user()::text$q$,
     '-NNNNNN', NULL),
    -- anon's EXECUTE revoked by 20260427075001, and again by 20260915110000,
    -- which the kit applies, so the cell is probed
    ('get_user_status(admin of B)',
     $q$SELECT get_user_status('b0000000-0000-4000-8000-000000000001')$q$,
     'PYYYYYY', NULL),
    ('is_user_active(admin of B)',
     $q$SELECT is_user_active('b0000000-0000-4000-8000-000000000001')::text$q$,
     'PYYYYYY', NULL),
    ('uid() is auth.uid()',
     $q$SELECT (uid() = auth.uid())::text$q$,
     '-YYYYYY', NULL),

    -- EXECUTE revoked from anon and authenticated before the fixture, and from
    -- PUBLIC, anon and authenticated again by 20260915110000, which the kit
    -- applies, so the cells are probed
    ('create_user_account(email, password, name, role)',
     $q$SELECT create_user_account('x@test.invalid', 'x', 'x', 'viewer')::text$q$,
     'PPPPPPP', NULL),
    ('list_users_for_admin()',
     $q$SELECT count(*)::text FROM list_users_for_admin()$q$,
     'PPPPPPP', NULL),
    -- 20260915130000 revokes PUBLIC and anon and grants authenticated and
    -- service_role, as production and staging were left by hand on 15.09.2026,
    -- so the cells are probed. Every signed-in caller but the super admin
    -- meets the guard. The super admin passes it and reaches the upsert, which
    -- fails on user_profiles.email (see "Recorded without a plan step")
    ('create_user_profile_manual(user, name)',
     $q$SELECT create_user_profile_manual({ref:user_profiles}, 'x')::text$q$,
     'PTTTTTE', NULL),

    -- the Gehaltsquittung RPCs (20260914140000), on company A's owed salary and
    -- on its receipt. Each wants the caller's own company and edit rights on
    -- salaries: the viewer, and the super admin with no company, are refused as
    -- not_authorized, and company B's admin finds no such salary or receipt.
    ('confirm_salary_cash_payment(owed salary of A)',
     $q$SELECT (confirm_salary_cash_payment({ref:rpc_request}, {ref:rpc_salary}, 1, '2026-04-30', 'MX')).receipt_number$q$,
     'PTYYYTT', NULL),
    ('void_salary_cash_receipt(receipt of A)',
     $q$SELECT (void_salary_cash_receipt({ref:salary_cash_receipts}, 'mx')).status$q$,
     'PTYYYTT', NULL),
    -- the path names the caller's own company folder, so company B's admin gets
    -- past the path check and is refused on the receipt
    ('attach_salary_cash_receipt_signed_copy(receipt of A)',
     $q$SELECT ((attach_salary_cash_receipt_signed_copy({ref:salary_cash_receipts},
          coalesce(get_user_company_id()::text, 'none') || '/mx-signed.pdf')).signed_copy_path IS NOT NULL)::text$q$,
     'PTYYYTT', NULL),

    -- one-time codes and code-confirmed signup (20260915100100, 20260915100200):
    -- service_role only, so no client role's call reaches a body
    ('otp_issue(…)',
     $q$SELECT otp_issue(NULL::uuid, NULL::text, NULL::text, NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::inet, NULL::uuid)::text$q$,
     'PPPPPPP', NULL),
    ('otp_mark_send_failed(…)',
     $q$SELECT otp_mark_send_failed(NULL::uuid)::text$q$,
     'PPPPPPP', NULL),
    ('otp_open_challenge(…)',
     $q$SELECT otp_open_challenge(NULL::text, NULL::text, NULL::uuid)::text$q$,
     'PPPPPPP', NULL),
    ('otp_verify(…)',
     $q$SELECT otp_verify(NULL::uuid, NULL::text, NULL::text, NULL::uuid)::text$q$,
     'PPPPPPP', NULL),
    ('otp_purge(…)',
     $q$SELECT otp_purge(interval '24 hours')::text$q$,
     'PPPPPPP', NULL),
    ('signup_create_company(…)',
     $q$SELECT signup_create_company(NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::text, NULL::text)::text$q$,
     'PPPPPPP', NULL),
    ('signup_complete(…)',
     $q$SELECT signup_complete(NULL::uuid)::text$q$,
     'PPPPPPP', NULL),
    ('signup_discard(…)',
     $q$SELECT signup_discard(NULL::uuid)::text$q$,
     'PPPPPPP', NULL),
    ('signup_discard_unverified(…)',
     $q$SELECT signup_discard_unverified(NULL::text)::text$q$,
     'PPPPPPP', NULL),
    ('purge_unverified_signups(…)',
     $q$SELECT purge_unverified_signups(interval '24 hours')::text$q$,
     'PPPPPPP', NULL),

    -- Google signup (20260916100000, 20260916100020, plan step 1.6): the four
    -- public oauth_* functions, service_role only by design. 20260916100020
    -- revokes PUBLIC, anon and authenticated on each and grants service_role
    -- alone, and its own self-check fails the release if anon or authenticated
    -- can execute one. That migration is newer than the fixture, so those
    -- grants are real here and every cell is probed rather than `-`. No
    -- principal in _mx_who_logins() is service_role — anon logs in as anon and
    -- the six others as authenticated — so EXECUTE is refused before any body
    -- runs and the NULL arguments below are never evaluated. `oauth-account`
    -- calls the first three with the service role, never the browser, and the
    -- purge is deploy/otp-housekeeping.sh's daily job.
    ('oauth_signup_create_company(…)',
     $q$SELECT oauth_signup_create_company(NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::text, NULL::text)::text$q$,
     'PPPPPPP', NULL),
    ('oauth_session_reconcile(…)',
     $q$SELECT oauth_session_reconcile(NULL::uuid)::text$q$,
     'PPPPPPP', NULL),
    ('oauth_signup_discard(…)',
     $q$SELECT oauth_signup_discard(NULL::uuid)::text$q$,
     'PPPPPPP', NULL),
    ('purge_abandoned_oauth_signups(…)',
     $q$SELECT purge_abandoned_oauth_signups(interval '24 hours')::text$q$,
     'PPPPPPP', NULL),

    -- the support sessions of 20260917140000. The two mode helpers answer NULL
    -- (0) for everyone who holds no context, a company user included: they are
    -- granted to every signed-in caller and say nothing to one that is not
    -- staff. The three RPCs are authenticated-only and refuse a caller without
    -- the capability as a return value, so a company user reads N
    ('platform_view_company_id() is company A',
     $q$SELECT (platform_view_company_id() = {co})::text$q$,
     'P000000', NULL),
    ('platform_support_company_id() is company A',
     $q$SELECT (platform_support_company_id() = {co})::text$q$,
     'P000000', NULL),
    -- `super` opens one here and the probe's rollback takes it back; for the
    -- two context principals this is the idempotent re-open (staff_view) and
    -- the support → view step (staff_support)
    ('platform_context_open(company A, view)',
     $q$SELECT platform_context_open({co}, 'view')::text$q$,
     'PNNNNNY', NULL),
    -- …and there is nothing to close for an owner that has opened nothing
    ('platform_context_close()',
     $q$SELECT platform_context_close()::text$q$,
     'PNNNNNN', NULL),
    -- answers success with a null context rather than refusing, so every staff
    -- role reads Y
    ('platform_context_current()',
     $q$SELECT platform_context_current()::text$q$,
     'PNNNNNY', NULL),
    -- The notification job (20260924100000). These three are the only SECURITY
    -- DEFINER functions in `public` granted to `service_role` and to nobody
    -- else, so every cell here is P — the revoke proved rather than trusted,
    -- and `staff` falls to PP by the default rule below, because a context
    -- grants no EXECUTE.
    --
    -- The assertion worth having is on notification_candidates: it runs past
    -- RLS and reads **across companies** by design, so an `authenticated` cell
    -- that ever moved off P would be a cross-tenant read of every company's
    -- cars, settings and delivery history in one call. The other two write the
    -- delivery record the whole dedupe rule rests on; a client that could call
    -- notification_delivery_claim could silence its own next TÜV warning, and
    -- one that could call _settle could mark a notification sent that was not.
    --
    -- The arguments never run — the call is refused before that — but they
    -- must still resolve to these signatures, or the probe would answer 42883
    -- and read as E rather than P.
    ('notification_candidates(the 60-day window, one page)',
     $q$SELECT count(*)::text FROM notification_candidates(60, 1)$q$,
     'PPPPPPP', NULL),
    ('notification_delivery_claim(company A, a TÜV notice)',
     $q$SELECT notification_delivery_claim({co}, 'tuev_abgelaufen', {co}, '2097-01-01')::text$q$,
     'PPPPPPP', NULL),
    ('notification_delivery_settle(company A''s probe row)',
     $q$SELECT notification_delivery_settle({ref:notification_deliveries}, true, 1)::text$q$,
     'PPPPPPP', NULL),
    /*
      The company-roles RPCs of 20260923120000, and the reason they are written
      out by hand: both are **SECURITY INVOKER**, so the uncovered-function
      sweep at the end of this file — which filters on `p.prosecdef` — will
      never report them. It is silent about them by construction, not because
      they are covered.

      They answer `{"ok": …}` rather than `{"success": …}`, so the probe reads
      `->> 'ok'` and lets `_mx_call` classify the plain word, the way the read
      models' lines do.

      Every cell is RLS speaking, since neither function runs past it:
        anon        no EXECUTE (P)
        viewer,     roles_insert's WITH CHECK refuses and raises 42501, which
        editor,     the function catches as insufficient_privilege; the UPDATE
        supervisor  and DELETE are refused by the USING clauses and match no
                    row. Two mechanisms, one `not_authorized` (N)
        admin       its own company's administrator (Y)
        other       creates in *its own* company (Y), and company A's role is
                    invisible to it, so the edit and the delete answer
                    `not_found` (N)
        super       no context, so get_user_company_id() is NULL and both
                    answer `no_company` before touching anything (N)
      tests/rls/company-roles.sql takes the same principals through the
      refusals by name.
    */
    ('company_role_save(a new role of A)',
     $q$SELECT company_role_save('mx-rpc-neu', 'MX', '[{"page_key":"drivers","can_view":true,"can_edit":false}]'::jsonb) ->> 'ok'$q$,
     'PNNNYYN', NULL),
    ('company_role_delete(company role of A)',
     $q$SELECT company_role_delete({ref:rpc_role}) ->> 'ok'$q$,
     'PNNNYNN', NULL),

    -- The partner functions (20261005120000, 20261005130000, 20261005140000)
    -- and the two receipt prerequisites. The first three are the edge
    -- function's door and are service_role only -- every revoke names anon
    -- explicitly, so no client role reaches a body and the argument contract
    -- behind them is never read. Their probes pass a NULL company on purpose:
    -- were a grant ever widened, the cell would move from P to the 22023 that
    -- contract raises, which is a mismatch rather than a write.
    ('partner_credential_company(unknown key)',
     $q$SELECT coalesce(partner_credential_company('mx', repeat('0', 64))::text, 'none')$q$,
     'PPPPPPP', NULL),
    ('partner_driver_resolve(no company)',
     $q$SELECT partner_driver_resolve(NULL, 'mx', 'mx-4711')::text$q$,
     'PPPPPPP', NULL),
    -- 20261008110000 made the seal a mandatory fourth argument, and this probe
    -- called the five-argument form: every principal read 42883 `function does
    -- not exist` instead of the permission denial, and the matrix is what
    -- caught it. Nothing else in the project would have — a signature change
    -- is invisible to a typechecker on the other side of PostgREST.
    ('partner_connection_record(no company)',
     $q$SELECT partner_connection_record(NULL, 'mx', 'not-a-hash', NULL)::text$q$,
     'PPPPPPP', NULL),
    -- Granted to authenticated, and it asks get_active_company_id() and
    -- current_role_permits('drivers', true) itself. It is probed on company A's
    -- confirmed link, so an authorised caller succeeds and the cell measures
    -- the gate. The first version named a link that does not exist, on the
    -- reading that the lookup's refusal would be distinguishable from the
    -- gate's: it is not -- both raise, the kit read T for all nine principals,
    -- and the cell measured nothing. Read that as the rule rather than the
    -- instance: a probe whose refusals share a class cannot separate the
    -- branches that produce them.
    ('partner_submission_claim_driver(confirmed link of A)',
     $q$SELECT partner_submission_claim_driver({ref:rpc_partner_link}) ->> 'ok'$q$,
     'PTYYYTT', NULL),
    -- The server-side Belegnummer. A NULL argument means the caller's own
    -- company, so it is read-only; only the shape of the answer is asserted,
    -- because the number carries a clock and four random digits.
    ('receipt_number_next(my own company)',
     $q$SELECT (receipt_number_next(NULL) LIKE 'BEL-%')::text$q$,
     'PTYYYYT', NULL),
    -- The OCR gate never raises: it returns ok=false and records why. It writes
    -- an event row on every path, refusals included, so it is probed only
    -- inside this file's rollback.
    ('receipt_ocr_allow()',
     $q$SELECT receipt_ocr_allow() ->> 'ok'$q$,
     'PNYYYYN', NULL),

    -- M3's three (20261007110000). The door is service_role's alone, like the
    -- other partner write functions, and its probe passes a NULL company so a
    -- widened grant would move the cell from P to the 22023 its argument
    -- contract raises rather than recording a note.
    ('partner_note_submission_record(no company)',
     $q$SELECT partner_note_submission_record(NULL, 'mx', 'mx-probe', 'mx-rpc', 'general')::text$q$,
     'PPPPPPP', NULL),
    -- M2's two (20261008100000): the human decision about a partner driver.
    -- Both ask get_active_company_id() and the `drivers` page themselves. The
    -- confirm is probed on the table section's PENDING link and names a driver
    -- no other fixture has linked, so an authorised caller succeeds and the
    -- cell measures the gate rather than a collision; company B's admin finds
    -- no such proposal. The confirm also claims the waiting submissions inside
    -- the same call, which this probe exercises and `partner-link-review.sql`
    -- asserts.
    ('partner_driver_link_confirm(pending link of A)',
     $q$SELECT partner_driver_link_confirm({ref:partner_driver_links}, {ref:drivers}) ->> 'ok'$q$,
     'PTYYYTT', NULL),
    ('partner_driver_link_reject(pending link of A)',
     $q$SELECT partner_driver_link_reject({ref:partner_driver_links}) ->> 'ok'$q$,
     'PTYYYTT', NULL),

    -- M1.2's reader (20261008110000). The one function in this schema that
    -- hands back a REPLAYABLE secret, so it is service_role's alone and every
    -- client principal must read P. A cell that ever moves off P here is the
    -- whole exposure, not a detail.
    ('partner_sealed_token(company A)',
     $q$SELECT coalesce(partner_sealed_token('c0000000-0000-4000-8000-00000000000a', 'mx'), 'none')$q$,
     'PPPPPPP', NULL),

    -- M1.5's two (20261008120000). The pull writes through them, so they are
    -- service_role's alone: a client that could call the roster apply would
    -- invent a partner driver and then confirm it as one of its own.
    ('partner_roster_apply(empty page)',
     $q$SELECT partner_roster_apply('c0000000-0000-4000-8000-00000000000a', 'mx', '[]'::jsonb) ->> 'seen'$q$,
     'PPPPPPP', NULL),
    ('partner_pull_record(company A)',
     $q$SELECT partner_pull_record('c0000000-0000-4000-8000-00000000000a', 'mx') ->> 'ok'$q$,
     'PPPPPPP', NULL),
    ('partner_vehicle_roster_apply(empty page)',
     $q$SELECT partner_vehicle_roster_apply('c0000000-0000-4000-8000-00000000000a', 'mx', '[]'::jsonb) ->> 'seen'$q$,
     'PPPPPPP', NULL),
    -- The fleet import (20261015100000). Administrator only, unlike the Uber
    -- earnings import: an editor is refused by the gate (T). Company B's
    -- administrator is a legitimate caller with nothing pending, so it reads Y
    -- and the cell measures the gate and not the lookup. A platform account is
    -- refused with no context (no company, T) and with one
    -- (platform_session_not_allowed, T).
    ('partner_drivers_import(administrator)',
     $q$SELECT partner_drivers_import() ->> 'ok'$q$,
     'PTTTYYT', NULL),
    ('partner_vehicles_import(administrator)',
     $q$SELECT partner_vehicles_import() ->> 'ok'$q$,
     'PTTTYYT', NULL),
    -- The earnings import's driver resolve (20261016110000). The same gate as
    -- the fleet import above, so the same row; an empty list is a legitimate
    -- call for company B's administrator, so that cell measures the gate.
    ('partner_earners_resolve(administrator)',
     $q$SELECT partner_earners_resolve('reidey', '[]'::jsonb) ->> 'ok'$q$,
     'PTTTYYT', NULL),
    -- Undo the Uber import (20261016120000). Administrator only and refused in a
    -- platform session, like the fleet import; a dry run is the call that can
    -- be probed here without deleting the fixtures. Company B's administrator
    -- is a legitimate caller with nothing to undo, so that cell reads Y and
    -- measures the gate and not the lookup. The deleting run has its own file.
    ('uber_import_undo(administrator, dry run)',
     $q$SELECT uber_import_undo(true) ->> 'ok'$q$,
     'PTTTYYT', NULL),

    -- M4's door (20261008140000). It is service_role's. The two reviewer
    -- decisions that used to sit beside it were dropped by 20261013110000: a
    -- submission is accepted on arrival, so there is nothing left to decide.
    -- tests/rls/partner-receipt-accept.sql asserts they stay gone.
    ('partner_receipt_submission_record(no company)',
     $q$SELECT partner_receipt_submission_record(NULL, 'mx', 'x', 'y', '2026-10-07')::text$q$,
     'PPPPPPP', NULL),

    -- The doorbell's resolver (20261008170000). A ring carries NO credential
    -- by the owner's decision of 08.10.2026, so this function and its rate
    -- limits are the whole boundary: a client cell moving off P would hand
    -- anyone with the anon key the company behind a fleet id, and a counter
    -- they could reset. tests/rls/partner-doorbell.sql probes the limits.
    ('partner_doorbell_resolve(unknown fleet)',
     $q$SELECT partner_doorbell_resolve('mx', 'mx-fleet') ->> 'reason'$q$,
     'PPPPPPP', NULL),

    -- The weekly Abrechnung mail (20261003120000, 20261004100000), uncovered
    -- since it was written. Four of the five are the job's own and are
    -- service_role's alone: a client that could call the claim would mark a
    -- company's mail as sent without sending it, and one that could call
    -- `week_figures` would read any company's settlement figures by id.
    ('abrechnung_schedule_candidates(any company)',
     $q$SELECT abrechnung_schedule_candidates(1, NULL)::text$q$,
     'PPPPPPP', NULL),
    ('abrechnung_week_figures(company A)',
     $q$SELECT abrechnung_week_figures({co}, '2026-09-28')::text$q$,
     'PPPPPPP', NULL),
    ('abrechnung_delivery_claim(company A)',
     $q$SELECT abrechnung_delivery_claim({co}, 'manager_summary', {co}, '2097-01-07')::text$q$,
     'PPPPPPP', NULL),
    -- The reminder's facts (20261015100000): the same boundary as week_figures,
    -- for the same reason.
    ('abrechnung_reminder_facts(company A)',
     $q$SELECT abrechnung_reminder_facts({co}, '2026-09-28')::text$q$,
     'PPPPPPP', NULL),
    ('abrechnung_delivery_settle(a delivery of A)',
     $q$SELECT abrechnung_delivery_settle({ref:abrechnung_deliveries}, true, 1)::text$q$,
     'PPPPPPP', NULL),
    -- The daily Uber pull (20261015100000): all four are service_role's alone.
    -- A client that could call the writer would put income rows into a company
    -- with no person, no role gate and no preview; one that could call the claim
    -- would mark a day as pulled. Behaviour: tests/rls/uber-daily-pull.sql.
    ('uber_pull_candidates(any company)',
     $q$SELECT uber_pull_candidates(1, NULL)::text$q$,
     'PPPPPPP', NULL),
    ('uber_pull_claim(company A)',
     $q$SELECT uber_pull_claim({co}, current_date - 1, 'first')::text$q$,
     'PPPPPPP', NULL),
    ('uber_pull_settle(a run of A)',
     $q$SELECT uber_pull_settle({ref:uber_pull_runs}, 'failed', NULL, 0)::text$q$,
     'PPPPPPP', NULL),
    ('income_import_uber_system(no run)',
     $q$SELECT income_import_uber_system(gen_random_uuid(), '[]'::jsonb)::text$q$,
     'PPPPPPP', NULL),
    -- The fifth is the screen's, so `authenticated` holds EXECUTE: it is
    -- STABLE and reads only through get_active_company_id(), so a caller with
    -- no company reads nothing rather than being refused. The platform account
    -- with no context is that caller, which is why its cell is not P.
    ('abrechnung_schedule_preview(a week)',
     $q$SELECT coalesce(abrechnung_schedule_preview('2026-09-28') ->> 'ok', 'none')$q$,
     'PNNNYYN', NULL),

    -- The two cash writers that were uncovered with them. Both are the
    -- screen's, both resolve the caller's company themselves, and both refuse
    -- a caller without one -- so every client principal reaches the function
    -- and is refused by its own gate rather than by a privilege.
    -- Measured, and it corrected a guess: the till is NOT an administrator's
    -- alone. `record_cash_movement` asks current_role_permits('cash-balance',
    -- true), which an editor and a supervisor hold, so three roles book it and
    -- only the viewer is refused. A platform session is refused in either mode
    -- with its own sentence -- the Gehaltsquittung rule of 3.13a, applied to
    -- the till: a cash movement is witnessed by somebody in the company.
    ('record_cash_movement(company A)',
     $q$SELECT (record_cash_movement(gen_random_uuid(), 'in', 10.00, '2026-09-28', 'mx')).id::text$q$,
     'PTYYYYT', NULL),
    ('issue_salary_cash_receipt(no payment)',
     $q$SELECT issue_salary_cash_receipt(gen_random_uuid(), gen_random_uuid(), 'mx')::text$q$,
     'PTTTTTT', NULL),
    -- The Uber earnings import (20261013120000). Probed on the confirmed link
    -- above, so an authorised caller of company A succeeds and the cell measures
    -- the gate. The viewer is refused by the gate (42501, T) and company B's
    -- administrator by the lookup (driver_not_linked, 22023, E): B holds no such
    -- link. They are different classes on purpose, which is what lets this row
    -- tell the gate from the lookup; the HINTs are read apart in
    -- tests/rls/income-import-uber.sql. A platform account is refused with no
    -- context (no company, T) and with one (platform_session_not_allowed, T).
    ('income_import_uber(confirmed link of A)',
     $q$SELECT income_import_uber(jsonb_build_array(jsonb_build_object(
        'external_driver_id', '4711', 'type', 'umsatz', 'amount', '1.00',
        'date', '2026-01-05', 'week', 1, 'description', 'Woche 1 - Uber',
        'trip_count', NULL, 'period_start', '2026-01-05', 'period_end', '2026-01-11')))->>'inserted'$q$,
     'PTYYYET', NULL),

    -- 20261016140000, deleting a company completely. Both ask companies.hard_delete,
    -- the owner's alone, and write their own audit row. The preview is a read of
    -- any company; the deletion needs one marked deleted, so the line points at
    -- a throwaway company of its own (inserted above this list) and the probe is
    -- rolled back with the rest. tests/rls/company-deletion.sql takes both
    -- through every refusal, every kept account and the counts.
    ('platform_company_delete_preview(company A)',
     $q$SELECT platform_company_delete_preview('c0000000-0000-4000-8000-00000000000a')::text$q$,
     'PNNNNNY', NULL),
    ('platform_company_delete(company marked deleted, its name)',
     $q$SELECT platform_company_delete('c0000000-0000-4000-8000-0000000000dd', 'MX Deleted')::text$q$,
     'PNNNNNY', NULL);

-- What an open context changes, RPC by RPC. Everything not named here answers
-- the same with a context as without one, so it takes `super`'s character
-- twice (see the table's comment). Two groups make up almost all of it: the
-- functions that resolve the caller's company through get_active_company_id(),
-- which now answers the context, and the ones that then write a tenant's rows
-- — refused in a view context by the statement trigger (T), carried out in a
-- support session exactly as the company's own administrator would (Y).
UPDATE _mx_rpc r SET staff = o.staff
  FROM (VALUES
    ('get_user_company_id() is company A',                          'YY'),
    ('get_active_company_id() is company A',                        'YY'),
    ('platform_view_company_id() is company A',                     'YY'),
    ('platform_support_company_id() is company A',                  '0Y'),
    ('is_company_admin()',                                          'NY'),
    ('current_role_permits(drivers, edit)',                          'NY'),
    -- both principals carry the text role `viewer`, not `admin`
    ('is_role(admin)',                                              'NN'),
    ('platform_context_open(company A, view)',                      'YY'),
    ('platform_context_close()',                                    'YY'),
    -- security invoker over income and receipts: the context's company shows
    ('get_weekly_abrechnung(2026, 3) shows company A''s line',       'YY'),
    ('get_monthly_abrechnung(2026, 3) shows company A''s line',      'YY'),
    ('get_driver_weekly_abrechnung(driver of A, 2026, 3) has a line',  'YY'),
    ('get_driver_monthly_abrechnung(driver of A, 2026, 3) has a line', 'YY'),
    -- the money: a platform context issues, voids and signs no Gehaltsquittung,
    -- in either mode (owner decision 18.09.2026). Since 20260921110010 (3.13a)
    -- each RPC refuses it itself with 42501 platform_session_not_allowed,
    -- before its role gate; the support column was Y, because
    -- current_role_permits('salaries', true) is true inside a support session
    -- and that gate was the only one
    ('confirm_salary_cash_payment(owed salary of A)',               'TT'),
    ('void_salary_cash_receipt(receipt of A)',                      'TT'),
    ('attach_salary_cash_receipt_signed_copy(receipt of A)',        'TT'),
    -- the planning RPCs check the company and not the role, so a view context
    -- gets all the way to the write and is stopped there by the trigger
    ('apply_monthly_planning_run(import and trip of A)',            'TY'),
    ('replace_monthly_planning_run(applied run of A)',              'TY'),
    ('delete_or_archive_monthly_planning_run(run of A)',            'TY'),
    ('purge_old_monthly_planning_runs(month of A''s archived run)',  'TY'),
    ('reassign_fahrtenbuch_trip(trip of A)',                        'TY'),
    -- the company-roles RPCs: `roles` and `role_permissions` both carry
    -- refuse_read_only_context_write, which is a BEFORE STATEMENT trigger and
    -- so speaks before any policy is consulted — a view context is refused
    -- (T), and the refusal travels out of the function unchanged, because only
    -- unique_violation and insufficient_privilege are caught. In a support
    -- session the policies' own platform branch is
    -- `company_id = platform_support_company_id()` (20260923110010), which is
    -- the opened company, so both succeed exactly as its administrator's do (Y)
    ('company_role_save(a new role of A)',                          'TY'),
    ('company_role_delete(company role of A)',                      'TY'),
    -- 20260930100000: a view context is refused by the Dokumente page gate,
    -- whose platform branch asks for a *support* session; inside one, both write
    -- the opened company's rows as its administrator would, and every row they
    -- write leaves an audit row (3.4c).
    -- `has_function_privilege` answers a boolean, so these two read N/Y and not
    -- P/T like the probes that call their function: anon holds no EXECUTE and
    -- every signed-in role does. What the grant does NOT say is whether a caller
    -- may confirm a particular plan — that is the function's own gate, and it is
    -- probed per principal in tests/rls/monthly-plan.sql.
    ('monthly_plan_save(execute grant only)',                        'YY'),
    ('monthly_plan_confirm(execute grant only)',                     'YY'),
    -- 20261022140000: the same two grants, read as boolean answers like the monthly plan's.
    ('vehicle_day_plan_save(execute grant only)',                    'YY'),
    ('vehicle_day_plan_confirm(execute grant only)',                 'YY'),
    -- The partner and receipt prerequisites. Measured, and two of the three
    -- corrected a guess of mine: a support session DRAWS a Belegnummer and
    -- PASSES the OCR gate, because current_role_permits() has a platform branch
    -- that grants edit inside one -- 3.4a's "as the company's own administrator
    -- would", reaching two functions written long before it. A view context is
    -- refused by the same branch, so the pair reads T then Y, and N then Y
    -- where the function answers by return value instead of raising.
    ('partner_submission_claim_driver(confirmed link of A)',         'TY'),
    ('receipt_number_next(my own company)',                          'TY'),
    ('receipt_ocr_allow()',                                          'NY'),
    -- The same platform branch of current_role_permits() that lets a support
    -- session draw a Belegnummer lets it decide a link; a view context is refused by
    -- the gate before the tenant tables' statement trigger is reached.
    ('partner_driver_link_confirm(pending link of A)',               'TY'),
    ('partner_driver_link_reject(pending link of A)',                'TY'),
    -- The till and the Gehaltsquittung: refused in BOTH context modes, by the
    -- functions themselves and with their own sentence. A cash movement and a
    -- receipt attest to a physical handover that no platform agent witnessed,
    -- which is a question of attestation and not of traceability -- so 3.4c's
    -- write-audit triggers do not reopen it.
    ('record_cash_movement(company A)',                              'TT'),
    ('issue_salary_cash_receipt(no payment)',                        'TT'),
    -- The preview is the screen's and STABLE: a view context reads the opened
    -- company through get_active_company_id() like any other read, and a
    -- support session is that company's administrator.
    ('abrechnung_schedule_preview(a week)',                          'NY'),
    -- Refused in both modes, with its own reason: importing a customer's
    -- earnings from the customer's own partner connection is not an agent's act.
    ('income_import_uber(confirmed link of A)',                       'TT'),
    -- Refused in both modes with the same reason as the earnings import.
    ('partner_drivers_import(administrator)',                         'TT'),
    ('partner_vehicles_import(administrator)',                        'TT'),
    ('partner_earners_resolve(administrator)',                        'TT'),
    ('uber_import_undo(administrator, dry run)',                       'TT'),
    -- An open context of either mode makes the guard on companies refuse the
    -- delete (company_delete_context_open), and the function answers it as a
    -- sentence: success false, so N, not an exception.
    ('platform_company_delete(company marked deleted, its name)',     'NN')
  ) AS o(label, staff)
 WHERE r.label = o.label;

DO $$
DECLARE v_missing text;
BEGIN
  -- A renamed label would drop its override silently and the line would then
  -- be judged by `super`'s answer, which is the one thing it is not.
  SELECT string_agg(o.label, ', ') INTO v_missing
    FROM (VALUES
      ('get_user_company_id() is company A'), ('get_active_company_id() is company A'),
      ('platform_view_company_id() is company A'), ('platform_support_company_id() is company A'),
      ('is_company_admin()'), ('current_role_permits(drivers, edit)'), ('is_role(admin)'),
      ('platform_context_open(company A, view)'), ('platform_context_close()'),
      ('get_weekly_abrechnung(2026, 3) shows company A''s line'),
      ('get_monthly_abrechnung(2026, 3) shows company A''s line'),
      ('get_driver_weekly_abrechnung(driver of A, 2026, 3) has a line'),
      ('get_driver_monthly_abrechnung(driver of A, 2026, 3) has a line'),
      ('confirm_salary_cash_payment(owed salary of A)'), ('void_salary_cash_receipt(receipt of A)'),
      ('attach_salary_cash_receipt_signed_copy(receipt of A)'),
      ('apply_monthly_planning_run(import and trip of A)'),
      ('replace_monthly_planning_run(applied run of A)'),
      ('delete_or_archive_monthly_planning_run(run of A)'),
      ('purge_old_monthly_planning_runs(month of A''s archived run)'),
      ('reassign_fahrtenbuch_trip(trip of A)'),
      ('company_role_save(a new role of A)'),
      ('company_role_delete(company role of A)'),
      ('monthly_plan_save(execute grant only)'),
      ('monthly_plan_confirm(execute grant only)'),
      ('vehicle_day_plan_save(execute grant only)'),
      ('vehicle_day_plan_confirm(execute grant only)'),
      ('partner_submission_claim_driver(confirmed link of A)'),
      ('receipt_number_next(my own company)'), ('receipt_ocr_allow()'),
      ('partner_driver_link_confirm(pending link of A)'),
      ('partner_driver_link_reject(pending link of A)'),
      ('record_cash_movement(company A)'),
      ('issue_salary_cash_receipt(no payment)'),
      ('abrechnung_schedule_preview(a week)'),
      ('income_import_uber(confirmed link of A)'),
      ('partner_drivers_import(administrator)'),
      ('partner_vehicles_import(administrator)'),
      ('partner_earners_resolve(administrator)'),
      ('uber_import_undo(administrator, dry run)'),
      ('platform_company_delete(company marked deleted, its name)')
    ) AS o(label)
   WHERE NOT EXISTS (SELECT 1 FROM _mx_rpc r WHERE r.label = o.label AND r.staff IS NOT NULL);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'matrix: rpc staff override matched no line: %', v_missing;
  END IF;
END $$;

DO $$
DECLARE
  who_logins constant text[] := _mx_who_logins();
  r       record;
  f       record;
  i       int;
  outcome text;
  got     text;
  want    text;
  details text;
BEGIN
  FOR r IN SELECT * FROM _mx_rpc ORDER BY ord LOOP
    got  := '';
    want := r.want || coalesce(r.staff, repeat(substr(r.want, 7, 1), 2));
    details := '';
    FOR i IN 1 .. array_length(who_logins, 1) LOOP
      IF substr(want, i, 1) = '-' THEN
        got := got || '-';
        CONTINUE;
      END IF;
      outcome := _mx_call(who_logins[i], _mx_fill(r.stmt, 'rpc', 'a'));
      got := got || left(outcome, 1);
      details := details || format(E'\n      %s: %s', who_logins[i], substr(outcome, 3, 160));
    END LOOP;
    IF got = want THEN
      RAISE NOTICE '%', format('ok  %-10s %-48s %s%s', 'rpc', r.label, got,
        CASE WHEN r.hole IS NOT NULL THEN '   HOLE[' || r.hole || ']' ELSE '' END);
    ELSE
      INSERT INTO _mx_failures VALUES ('rpc', r.label, format('expected %s, got %s%s', want, got, details));
    END IF;
  END LOOP;

  -- A SECURITY DEFINER function runs past RLS, so one without a line is a hole
  -- nobody has looked at. Trigger functions are left out: PostgREST cannot call
  -- them. Reported, not failed, for the same reason as an uncovered table.
  FOR f IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.prosecdef
       AND p.prorettype <> 'trigger'::regtype
       AND p.proname !~ '^_'
       AND p.proname NOT IN (SELECT substring(x.label FROM '^([a-z_0-9]+)\(') FROM _mx_rpc x)
     ORDER BY 1, 2
  LOOP
    RAISE WARNING 'UNCOVERED SECURITY DEFINER function public.%(%) has no line in the rpc section', f.proname, f.args;
  END LOOP;
END $$;

-- ─── report ─────────────────────────────────────────────────────────────────

DO $$
DECLARE
  f record;
  n int;
BEGIN
  SELECT count(*) INTO n FROM _mx_failures;
  IF n = 0 THEN
    RAISE NOTICE '── the matrix matches the recorded baseline ──';
    RETURN;
  END IF;
  FOR f IN SELECT * FROM _mx_failures ORDER BY section, item LOOP
    RAISE NOTICE E'MISMATCH [%] %\n    %', f.section, f.item, f.detail;
  END LOOP;
  RAISE EXCEPTION '% matrix cell(s) differ from the recorded baseline — read each one above before changing its expectation', n;
END $$;

ROLLBACK;
