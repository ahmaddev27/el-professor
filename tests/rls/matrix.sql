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
    super       super         is_super_admin = true, company NULL — the column alone,
                              no second factor, no support session

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

    3.1  platform rights come from the `is_super_admin` column alone; 15 policies
         and 8 functions read the column directly instead of is_user_super_admin(),
         three of them (otp_issue, signup_create_company, signup_discard) added
         by the one-time-code migrations
    3.1  enforce_user_profile_privilege_guard lets a column super admin move a
         profile — its own included — into any company, and grant the column
    3.2  is_user_super_admin() is true for the column alone: no verified second
         factor, no live session, so the policies built on it (companies,
         subscriptions, invoices, plans, document categories) open to a password
    3.3  company status, approval and subscription, and a user's own status, are
         not enforced by the database: a pending, rejected, suspended or inactive
         company, one whose subscription is inactive, expired or suspended or
         whose expiry date has passed, and a deactivated, suspended, inactive or
         still-invited user all keep reading and writing, through the tables and
         through the planning RPCs; a deactivated company admin can even set its
         own status back to active. A trial company with an active subscription
         is recorded untagged: it is the control that must stay allowed
    3.4  the super admin reads and writes every tenant's operational data with no
         support session, and moves a tenant's rows into another company (M)
    3.5  discount_codes (code text, assigned company) readable by any signed-in user
    3.5  activation_code_attempts INSERT WITH CHECK (true) — anyone can write
         attempts for any company, enough to lock another company out of redeem
    3.5  preview_activation_code has no rate limit and records no attempt
    3.5  redeem_activation_code is open to every member, not only the company admin
    3.5  approval_note and rejection_reason are readable by every company member
    3.5  SECURITY DEFINER functions without a pinned search_path

  ## Recorded without a plan step

  Current behaviour that no step of the plan names. Untagged, so a change to it
  is still a mismatch to explain, not an expected move.

    - the planning RPCs (apply, replace, delete_or_archive, purge, reassign)
      check the caller's company but not its role: a viewer can apply a monthly
      plan, as it can already write the planning tables directly
    - apply_monthly_planning_run accepts another company's import id: it opens a
      run in the caller's own company and changes none of the other company's
      trips
    - get_user_status() and is_user_active() answer for any user id, so any
      member reads the account status of a user in another company
    - get_current_cash_balance() fails for every caller (42703): it reads
      receipts."user", a column receipts no longer has

  ## Uncovered objects

  A public table or view without a line in the matrix, and a public SECURITY
  DEFINER function (triggers aside) without a line in the rpc section, is
  reported as `UNCOVERED`. That is a warning, not a failure: parallel branches
  add tables and functions, and each adds its own lines here.

  ## Not covered

    - storage.objects policies: tests/fixtures/storage-shim.sql lets a migration
      create its bucket and policies, but the fixture is a --schema=public dump
      that carries none of the older ones, so storage is not probed
    - edge functions (manage-users, generate-activation-code, otp-request, …)
      and GoTrue
    - app_private: no client role has USAGE on the schema. The SECURITY DEFINER
      functions in public that reach it each have a line in the rpc section
    - EXECUTE grants revoked before 20260908: the fixture was dumped without
      privileges, so only grants from the migrations applied on top are real
      here. An RPC cell is `-` exactly where 20260427075001, 20260428102656 or
      20260607124839 revoked that caller's EXECUTE and no later migration
      restated it; create_user_profile_manual lost authenticated's too, so it
      is not probed at all. 20260915110000 restates the grants of
      create_user_account, list_users_for_admin, get_user_status and
      is_user_active, so their cells are probed. Every other anon cell relies
      on Supabase's default privileges granting anon EXECUTE explicitly when a
      function is created; confirm with has_function_privilege() on a copy of
      staging. No migration older than the fixture revoked a table privilege,
      so the table cells do not depend on that history.

  ## Running

  The whole file runs inside BEGIN … ROLLBACK, so the tests/rls files after it
  see only the migrations and the seeds. Run it after assertions.sql against the
  kit's database; scripts/rls-test.mjs does.
*/

\set ON_ERROR_STOP on

BEGIN;

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
  IF p_who = 'anon' THEN
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
    RETURN;
  END IF;
  SELECT user_id INTO STRICT v_uid FROM user_profiles WHERE email = p_who || '@test.invalid';
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
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
  SELECT ARRAY['anon', 'viewer', 'editor', 'supervisor', 'admin', 'other', 'super']
$$;

CREATE OR REPLACE FUNCTION _mx_who_logins() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['anon', 'viewer-a', 'editor-a', 'supervisor-a', 'admin-a', 'admin-b', 'super']
$$;

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
-- blocks today (App.tsx, AuthContext.tsx), plus one it does not block: a trial
-- company with an active subscription, the control that must stay allowed when
-- phase 3.3 moves enforcement into the database.

CREATE TEMP TABLE _mx_state_company (slug text, label text, approval_status text, status text,
                                     subscription_status text, subscription_expires_at timestamptz);
INSERT INTO _mx_state_company VALUES
  ('subinactive',     'company whose subscription is inactive',        'approved',  'active',    'inactive',  NULL),
  ('subexpiredstatus','company whose subscription status is expired',  'approved',  'active',    'expired',   NULL),
  ('subsuspended',    'company whose subscription is suspended',       'approved',  'active',    'suspended', NULL),
  ('subexpired',      'company whose subscription expired yesterday',  'approved',  'active',    'active',    now() - interval '1 day'),
  ('pending',         'company still pending approval',                'pending',   'active',    'active',    NULL),
  ('rejected',        'rejected company',                              'rejected',  'active',    'active',    NULL),
  ('suspended',       'suspended company',                             'suspended', 'suspended', 'active',    NULL),
  ('statusinactive',  'approved company whose status is inactive',     'approved',  'inactive',  'active',    NULL),
  ('trial',           'trial company with an active subscription',     'approved',  'trial',     'active',    now() + interval '30 days');

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
(22, 'werkstatt_checks', $q$id = {id}$q$,
  $q$INSERT INTO werkstatt_checks (id, car_id, week_number, year, created_by, company_id) VALUES ({id}, {ref:cars}, 1, 2026, {admin}, {co})$q$, NULL,
  $q$INSERT INTO werkstatt_checks (car_id, week_number, year, created_by, company_id) VALUES ({ref:cars}, 2, 2026, {admin}, {co})$q$,
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
  $q$INSERT INTO notification_settings (company_id, notification_type) VALUES ({co}, 'trial_abgelaufen')$q$,
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
  $q$place = place$q$);

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
('roles',                                $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('role_permissions',                     $q$role_id = {ref_other:roles}$q$,
                                         $q$DELETE FROM role_permissions WHERE id = {ref_other:role_permissions}$q$, 'Y', 'through its role; one row per role and page'),
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
('company_subscriptions',                $q$company_id = {other_co}$q$, NULL, 'Y', NULL),
('subscription_invoices',                $q$company_id = {other_co}$q$,
                                         $q$DELETE FROM subscription_invoices WHERE id = {ref_other:subscription_invoices}$q$, 'Y', 'one per company and month'),
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
                                         $q$DELETE FROM salary_cash_receipts WHERE id = {ref_other:salary_cash_receipts}$q$, 'Y', 'one receipt number per company');

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

CREATE TEMP TABLE _mx_expected (
  tbl text, op text,
  anon text, viewer text, editor text, supervisor text, admin text, other text, super text,
  hole text
);

INSERT INTO _mx_expected VALUES
--                                          anon  viewer editor superv admin other super
('activation_code_attempts',           'S', '..', '..', '..', '..', '..', '..', 'YY', '3.1 super check reads the is_super_admin column directly'),
('activation_code_attempts',           'I', 'RR', 'YY', 'YY', 'YY', 'YY', 'YY', 'YY', '3.5 WITH CHECK (true): any member writes attempts for any company'),
('activation_code_attempts',           'U', '..', '..', '..', '..', '..', '..', '..', NULL),
('activation_code_attempts',           'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('activation_code_attempts',           'M', '..', '..', '..', '..', '..', '..', '..', NULL),
('activation_codes',                   'S', '..', '..', '..', '..', '..', '..', 'YY', '3.1 super check reads the is_super_admin column directly'),
('activation_codes',                   'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', '3.1 super check reads the is_super_admin column directly'),
('activation_codes',                   'U', '..', '..', '..', '..', '..', '..', 'YY', '3.1 super check reads the is_super_admin column directly'),
('activation_codes',                   'D', '..', '..', '..', '..', '..', '..', 'YY', '3.1 super check reads the is_super_admin column directly'),
('activation_codes',                   'M', '..', '..', '..', '..', '..', '..', 'YY', '3.1 super check reads the is_super_admin column directly'),
('car_driver_assignments',             'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('car_driver_assignments',             'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('car_driver_assignments',             'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'RR', NULL),
('car_driver_assignments',             'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('car_driver_assignments',             'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', 'RR', NULL),
('cars',                               'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('cars',                               'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('cars',                               'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('cars',                               'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('cars',                               'M', '..', '..', 'R.', 'R.', 'R.', '.R', 'YY', '3.4 super moves tenant rows into another company with no support session'),
('cash_movements',                     'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('cash_movements',                     'I', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('cash_movements',                     'U', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('cash_movements',                     'D', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('cash_movements',                     'M', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('cash_transactions',                  'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('cash_transactions',                  'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('cash_transactions',                  'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'RR', NULL),
('cash_transactions',                  'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('cash_transactions',                  'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', 'RR', NULL),
('companies',                          'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.5 approval_note and rejection_reason readable by members'),
('companies',                          'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', '3.2 platform right from the column alone, no verified session'),
('companies',                          'U', '..', '..', '..', '..', '..', '..', 'YY', '3.2 platform right from the column alone, no verified session'),
('companies',                          'D', '..', '..', '..', '..', '..', '..', 'YY', '3.2 platform right from the column alone, no verified session'),
('companies',                          'M', '--', '--', '--', '--', '--', '--', '--', NULL),
('company_planning_run_blocks',        'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('company_planning_run_blocks',        'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('company_planning_run_blocks',        'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('company_planning_run_blocks',        'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('company_planning_run_blocks',        'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', '..', NULL),
('company_planning_runs',              'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('company_planning_runs',              'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('company_planning_runs',              'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('company_planning_runs',              'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('company_planning_runs',              'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', '..', NULL),
('company_settings',                   'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('company_settings',                   'I', 'RR', 'RR', 'RR', 'RR', 'YR', 'RY', 'RR', NULL),
('company_settings',                   'U', '..', '..', '..', '..', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('company_settings',                   'D', '..', '..', '..', '..', '..', '..', 'YY', '3.2 platform right from the column alone, no verified session'),
('company_settings',                   'M', '..', '..', '..', '..', 'R.', '.R', 'YY', '3.4 super moves tenant rows into another company with no support session'),
('company_subscriptions',              'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.2 platform right from the column alone, no verified session'),
('company_subscriptions',              'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', '3.2 platform right from the column alone, no verified session'),
('company_subscriptions',              'U', '..', '..', '..', '..', '..', '..', 'YY', '3.2 platform right from the column alone, no verified session'),
('company_subscriptions',              'D', '..', '..', '..', '..', '..', '..', 'YY', '3.2 platform right from the column alone, no verified session'),
('company_subscriptions',              'M', '..', '..', '..', '..', '..', '..', 'YY', '3.2 platform right from the column alone, no verified session'),
('discount_code_redemptions',          'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.1 super check reads the is_super_admin column directly'),
('discount_code_redemptions',          'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', NULL),
('discount_code_redemptions',          'U', '..', '..', '..', '..', '..', '..', '..', NULL),
('discount_code_redemptions',          'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('discount_code_redemptions',          'M', '..', '..', '..', '..', '..', '..', '..', NULL),
('discount_codes',                     'S', '..', 'YY', 'YY', 'YY', 'YY', 'YY', 'YY', '3.5 every signed-in user reads all active discount codes'),
('discount_codes',                     'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', '3.1 super check reads the is_super_admin column directly'),
('discount_codes',                     'U', '..', '..', '..', '..', '..', '..', 'YY', '3.1 super check reads the is_super_admin column directly'),
('discount_codes',                     'D', '..', '..', '..', '..', '..', '..', 'YY', '3.1 super check reads the is_super_admin column directly'),
('discount_codes',                     'M', '..', '..', '..', '..', '..', '..', 'YY', '3.1 super check reads the is_super_admin column directly'),
('document_blocks',                    'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('document_blocks',                    'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('document_blocks',                    'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'RR', NULL),
('document_blocks',                    'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('document_blocks',                    'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', 'RR', NULL),
('document_categories',                'S', '..', 'YY', 'YY', 'YY', 'YY', 'YY', 'YY', NULL),
('document_categories',                'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', '3.2 platform right from the column alone, no verified session'),
('document_categories',                'U', '..', '..', '..', '..', '..', '..', 'YY', '3.2 platform right from the column alone, no verified session'),
('document_categories',                'D', '..', '..', '..', '..', '..', '..', 'YY', '3.2 platform right from the column alone, no verified session'),
('document_categories',                'M', '--', '--', '--', '--', '--', '--', '--', NULL),
('document_counters',                  'S', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('document_counters',                  'I', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('document_counters',                  'U', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('document_counters',                  'D', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('document_counters',                  'M', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('document_templates',                 'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('document_templates',                 'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('document_templates',                 'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'RR', NULL),
('document_templates',                 'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('document_templates',                 'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', 'RR', NULL),
('document_variables',                 'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('document_variables',                 'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('document_variables',                 'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'RR', NULL),
('document_variables',                 'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('document_variables',                 'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', 'RR', NULL),
('documents',                          'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('documents',                          'I', 'RR', 'RR', 'RR', 'YR', 'YR', 'RY', 'RR', NULL),
('documents',                          'U', '..', '..', '..', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('documents',                          'D', '..', '..', '..', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('documents',                          'M', '..', '..', '..', 'R.', 'R.', '.R', 'YY', '3.4 super moves tenant rows into another company with no support session'),
('driver_notes',                       'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('driver_notes',                       'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('driver_notes',                       'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('driver_notes',                       'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('driver_notes',                       'M', '..', '..', 'R.', 'R.', 'R.', '.R', 'YY', '3.4 super moves tenant rows into another company with no support session'),
('drivers',                            'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('drivers',                            'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('drivers',                            'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('drivers',                            'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('drivers',                            'M', '..', '..', 'R.', 'R.', 'R.', '.R', 'YY', '3.4 super moves tenant rows into another company with no support session'),
('fahrtenbuch_assignment_audit',       'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('fahrtenbuch_assignment_audit',       'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('fahrtenbuch_assignment_audit',       'U', '..', '..', '..', '..', '..', '..', '..', NULL),
('fahrtenbuch_assignment_audit',       'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('fahrtenbuch_assignment_audit',       'M', '..', '..', '..', '..', '..', '..', '..', NULL),
('fahrtenbuch_imports',                'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('fahrtenbuch_imports',                'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('fahrtenbuch_imports',                'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('fahrtenbuch_imports',                'D', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('fahrtenbuch_imports',                'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', '..', NULL),
('fahrtenbuch_trips',                  'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('fahrtenbuch_trips',                  'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('fahrtenbuch_trips',                  'U', '..', '..', '..', '..', '..', '..', '..', NULL),
('fahrtenbuch_trips',                  'D', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('fahrtenbuch_trips',                  'M', '..', '..', '..', '..', '..', '..', '..', NULL),
('fixed_costs',                        'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('fixed_costs',                        'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('fixed_costs',                        'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('fixed_costs',                        'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('fixed_costs',                        'M', '..', '..', 'R.', 'R.', 'R.', '.R', 'YY', '3.4 super moves tenant rows into another company with no support session'),
('historical_block_adjustments',       'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_block_adjustments',       'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_block_adjustments',       'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_block_adjustments',       'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_block_adjustments',       'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', '..', NULL),
('historical_driver_hour_targets',     'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_driver_hour_targets',     'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_driver_hour_targets',     'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_driver_hour_targets',     'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_driver_hour_targets',     'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', '..', NULL),
('historical_payroll_targets',         'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_payroll_targets',         'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_payroll_targets',         'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_payroll_targets',         'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_payroll_targets',         'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', '..', NULL),
('historical_reconciliation_drivers',  'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliation_drivers',  'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_reconciliation_drivers',  'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliation_drivers',  'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliation_drivers',  'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', '..', NULL),
('historical_reconciliation_results',  'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliation_results',  'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_reconciliation_results',  'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliation_results',  'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliation_results',  'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', '..', NULL),
('historical_reconciliation_wh_drivers','S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliation_wh_drivers','I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_reconciliation_wh_drivers','U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliation_wh_drivers','D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliation_wh_drivers','M', '..', 'R.', 'R.', 'R.', 'R.', '.R', '..', NULL),
('historical_reconciliations',         'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliations',         'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_reconciliations',         'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliations',         'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_reconciliations',         'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', '..', NULL),
('historical_time_adjustments',        'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_time_adjustments',        'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_time_adjustments',        'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_time_adjustments',        'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_time_adjustments',        'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', '..', NULL),
('historical_wh_saved_plans',          'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_wh_saved_plans',          'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('historical_wh_saved_plans',          'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_wh_saved_plans',          'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('historical_wh_saved_plans',          'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', '..', NULL),
('income',                             'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('income',                             'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('income',                             'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('income',                             'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('income',                             'M', '..', '..', 'R.', 'R.', 'R.', '.R', 'YY', '3.4 super moves tenant rows into another company with no support session'),
('monthly_planning_manual_exceptions', 'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_planning_manual_exceptions', 'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('monthly_planning_manual_exceptions', 'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_planning_manual_exceptions', 'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('monthly_planning_manual_exceptions', 'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', '..', NULL),
('notification_settings',              'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('notification_settings',              'I', 'RR', 'RR', 'RR', 'RR', 'YR', 'RY', 'RR', NULL),
('notification_settings',              'U', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('notification_settings',              'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('notification_settings',              'M', '..', '..', '..', '..', 'R.', '.R', '..', NULL),
('planning_finalizations',             'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('planning_finalizations',             'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('planning_finalizations',             'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'RR', NULL),
('planning_finalizations',             'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('planning_finalizations',             'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', 'RR', NULL),
('planning_run_adjustments',           'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('planning_run_adjustments',           'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'YY', '3.4 super reaches tenant data with no support session'),
('planning_run_adjustments',           'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('planning_run_adjustments',           'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('planning_run_adjustments',           'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', 'YY', '3.4 super moves tenant rows into another company with no support session'),
('receipts',                           'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('receipts',                           'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('receipts',                           'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('receipts',                           'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('receipts',                           'M', '..', '..', 'R.', 'R.', 'R.', '.R', 'YY', '3.4 super moves tenant rows into another company with no support session'),
('referrals',                          'S', '..', '..', '..', '..', '..', '..', 'YY', '3.1 super check reads the is_super_admin column directly'),
('referrals',                          'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', '3.1 super check reads the is_super_admin column directly'),
('referrals',                          'U', '..', '..', '..', '..', '..', '..', 'YY', '3.1 super check reads the is_super_admin column directly'),
('referrals',                          'D', '..', '..', '..', '..', '..', '..', 'YY', '3.1 super check reads the is_super_admin column directly'),
('referrals',                          'M', '--', '--', '--', '--', '--', '--', '--', NULL),
('role_permissions',                   'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('role_permissions',                   'I', 'RR', 'RR', 'RR', 'RR', 'YR', 'RY', 'RR', NULL),
('role_permissions',                   'U', '..', '..', '..', '..', 'Y.', '.Y', 'RR', NULL),
('role_permissions',                   'D', '..', '..', '..', '..', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('role_permissions',                   'M', '..', '..', '..', '..', 'R.', '.R', 'RR', NULL),
('roles',                              'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('roles',                              'I', 'RR', 'RR', 'RR', 'RR', 'YR', 'RY', 'RR', NULL),
('roles',                              'U', '..', '..', '..', '..', 'Y.', '.Y', 'RR', NULL),
('roles',                              'D', '..', '..', '..', '..', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('roles',                              'M', '..', '..', '..', '..', 'R.', '.R', 'RR', NULL),
('salaries',                           'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('salaries',                           'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('salaries',                           'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('salaries',                           'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('salaries',                           'M', '..', '..', 'R.', 'R.', 'R.', '.R', 'YY', '3.4 super moves tenant rows into another company with no support session'),
('salary_cash_receipts',               'S', 'PP', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', '..', NULL),
('salary_cash_receipts',               'I', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('salary_cash_receipts',               'U', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('salary_cash_receipts',               'D', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('salary_cash_receipts',               'M', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', 'PP', NULL),
('salary_payments',                    'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('salary_payments',                    'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('salary_payments',                    'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('salary_payments',                    'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('salary_payments',                    'M', '..', '..', 'R.', 'R.', 'R.', '.R', 'YY', '3.4 super moves tenant rows into another company with no support session'),
('saved_stundennachweise',             'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('saved_stundennachweise',             'I', 'RR', 'YR', 'YR', 'YR', 'YR', 'RY', 'YY', '3.4 super reaches tenant data with no support session'),
('saved_stundennachweise',             'U', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('saved_stundennachweise',             'D', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('saved_stundennachweise',             'M', '..', 'R.', 'R.', 'R.', 'R.', '.R', 'YY', '3.4 super moves tenant rows into another company with no support session'),
('subscription_admin_actions',         'S', '..', '..', '..', '..', '..', '..', 'YY', '3.1 super check reads the is_super_admin column directly'),
('subscription_admin_actions',         'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', '3.1 super check reads the is_super_admin column directly'),
('subscription_admin_actions',         'U', '..', '..', '..', '..', '..', '..', 'YY', '3.1 super check reads the is_super_admin column directly'),
('subscription_admin_actions',         'D', '..', '..', '..', '..', '..', '..', 'YY', '3.1 super check reads the is_super_admin column directly'),
('subscription_admin_actions',         'M', '..', '..', '..', '..', '..', '..', 'YY', '3.1 super check reads the is_super_admin column directly'),
('subscription_invoices',              'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.2 platform right from the column alone, no verified session'),
('subscription_invoices',              'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', '3.2 platform right from the column alone, no verified session'),
('subscription_invoices',              'U', '..', '..', '..', '..', '..', '..', 'YY', '3.2 platform right from the column alone, no verified session'),
('subscription_invoices',              'D', '..', '..', '..', '..', '..', '..', 'YY', '3.2 platform right from the column alone, no verified session'),
('subscription_invoices',              'M', '..', '..', '..', '..', '..', '..', 'YY', '3.2 platform right from the column alone, no verified session'),
('subscription_payment_audit',         'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.2 platform right from the column alone, no verified session'),
('subscription_payment_audit',         'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', '3.2 platform right from the column alone, no verified session'),
('subscription_payment_audit',         'U', '..', '..', '..', '..', '..', '..', '..', NULL),
('subscription_payment_audit',         'D', '..', '..', '..', '..', '..', '..', '..', NULL),
('subscription_payment_audit',         'M', '..', '..', '..', '..', '..', '..', '..', NULL),
('subscription_plans',                 'S', '..', 'YY', 'YY', 'YY', 'YY', 'YY', 'YY', NULL),
('subscription_plans',                 'I', 'RR', 'RR', 'RR', 'RR', 'RR', 'RR', 'YY', '3.2 platform right from the column alone, no verified session'),
('subscription_plans',                 'U', '..', '..', '..', '..', '..', '..', 'YY', '3.2 platform right from the column alone, no verified session'),
('subscription_plans',                 'D', '..', '..', '..', '..', '..', '..', 'YY', '3.2 platform right from the column alone, no verified session'),
('subscription_plans',                 'M', '--', '--', '--', '--', '--', '--', '--', NULL),
('user_profiles',                      'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('user_profiles',                      'I', 'RR', 'TT', 'TT', 'TT', 'TT', 'TT', 'RR', NULL),
('user_profiles',                      'U', '..', '..', '..', '..', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('user_profiles',                      'D', '..', '..', '..', '..', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('user_profiles',                      'M', '..', '..', '..', '..', 'T.', '.T', 'YY', '3.1 guard lets a column super admin change company_id'),
('user_sessions',                      'S', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('user_sessions',                      'I', 'RR', 'RR', 'RR', 'RR', 'YR', 'RY', 'RR', NULL),
('user_sessions',                      'U', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('user_sessions',                      'D', '..', '..', '..', '..', 'Y.', '.Y', '..', NULL),
('user_sessions',                      'M', '..', '..', '..', '..', 'R.', '.R', '..', NULL),
('werkstatt_checks',                   'S', '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('werkstatt_checks',                   'I', 'RR', 'RR', 'YR', 'YR', 'YR', 'RY', 'RR', NULL),
('werkstatt_checks',                   'U', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('werkstatt_checks',                   'D', '..', '..', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session'),
('werkstatt_checks',                   'M', '..', '..', 'R.', 'R.', 'R.', '.R', 'YY', '3.4 super moves tenant rows into another company with no support session');

-- ─── the expected view lines ────────────────────────────────────────────────
-- PostgREST serves a view like a table, so each public view gets a SELECT line
-- in the same cell format. `key` picks the view's company-A and company-B row;
-- the rows themselves are inserted in the view section below.

CREATE TEMP TABLE _mx_view_spec (
  view_name text, key text,
  anon text, viewer text, editor text, supervisor text, admin text, other text, super text,
  hole text
);

INSERT INTO _mx_view_spec VALUES
--                                                         anon  viewer editor superv admin other super
('abrechnung_weekly', $q$driver_name = 'MX view {s}'$q$,  '..', 'Y.', 'Y.', 'Y.', 'Y.', '.Y', 'YY', '3.4 super reaches tenant data with no support session');

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
            IF left(outcome, 1) IS DISTINCT FROM owner_must THEN
              INSERT INTO _mx_failures VALUES ('matrix', format('%s %s', r.tbl, v_op),
                format('probe is invalid — the owner must answer %s (side %s): %s  [%s]', owner_must, side, outcome, stmt));
            END IF;
          ELSE
            outcome := CASE WHEN v_op = 'M'
                            THEN _mx_move_try(who_logins[i], pre, r.tbl, _mx_fill(r.key, r.tbl, side), _mx_fill(r.mov, r.tbl, side))
                            ELSE _mx_try(who_logins[i], pre, stmt) END;
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
                       ELSE ARRAY[e.anon, e.viewer, e.editor, e.supervisor, e.admin, e.other, e.super] END;

      IF expected IS DISTINCT FROM cells THEN
        n_bad := n_bad + 1;
        INSERT INTO _mx_failures VALUES ('matrix', format('%s %s', r.tbl, v_op),
          format(E'expected %s\n    actual   (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L),%s',
                 coalesce(array_to_string(expected, ' '), '<no expectation>'),
                 r.tbl, v_op, cells[1], cells[2], cells[3], cells[4], cells[5], cells[6], cells[7],
                 e.hole, details));
      ELSE
        RAISE NOTICE '%', format('ok  %-38s %s  %s%s%s', r.tbl, v_op, array_to_string(cells, ' '),
          CASE WHEN e.hole IS NOT NULL THEN '   HOLE[' || e.hole || ']' ELSE '' END,
          CASE WHEN v_op = 'M' AND r.mov IS NULL THEN '   (' || r.move_note || ')' ELSE '' END);
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE '── matrix: % lines, % differ from the recorded baseline ──', n_lines, n_bad;

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

    expected := ARRAY[v.anon, v.viewer, v.editor, v.supervisor, v.admin, v.other, v.super];
    IF expected IS DISTINCT FROM cells THEN
      INSERT INTO _mx_failures VALUES ('view', format('%s S', v.view_name),
        format(E'expected %s\n    actual   (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L),%s',
               array_to_string(expected, ' '),
               v.view_name, v.key, cells[1], cells[2], cells[3], cells[4], cells[5], cells[6], cells[7],
               v.hole, details));
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
  PERFORM _mx_expect('guard', 'column super admin moves its own profile into company A',
    _mx_try('super', NULL, format('UPDATE user_profiles SET company_id = %L WHERE user_id = %L', co_a, super_u)),
    'Y', '3.1 guard lets a column super admin change company_id');
  PERFORM _mx_expect('guard', 'column super admin moves a company B member into company A',
    _mx_try('super', NULL, format('UPDATE user_profiles SET company_id = %L WHERE user_id = %L', co_a, member_b)),
    'Y', '3.1 guard lets a column super admin change company_id');
  PERFORM _mx_expect('guard', 'column super admin grants is_super_admin to a company member',
    _mx_try('super', NULL, format('UPDATE user_profiles SET is_super_admin = true WHERE user_id = %L', member_a)),
    'Y', '3.1 platform rights granted through the column');
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
  PERFORM _mx_expect('guard', 'deactivated company admin reactivates itself',
    _mx_try('deactivated-a', NULL, format('UPDATE user_profiles SET status = %L WHERE user_id = %L', 'active', _mx_id('user', 'deactivated-a'))),
    'Y', '3.3 a deactivated admin still passes the guard''s admin branch');
END $$;

-- ── 3.1 / 3.2: where platform rights come from ──────────────────────────────
DO $$
DECLARE v text;
BEGIN
  PERFORM _mx_expect('platform', 'is_user_super_admin() is true for the column alone',
    _mx_call('super', 'SELECT is_user_super_admin()::text'), 'Y', '3.2 no second factor, no session');
  PERFORM _mx_expect('platform', 'is_user_super_admin() is false for a company admin',
    _mx_call('admin-a', 'SELECT is_user_super_admin()::text'), 'N');

  SELECT count(*) || ': ' || coalesce(string_agg(tablename || '.' || policyname, ', ' ORDER BY tablename, policyname), '')
    INTO v
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '(^|[^a-z_])is_super_admin([^a-z_]|$)';
  PERFORM _mx_expect('catalogue', 'policies that read the is_super_admin column directly', v,
    '15: activation_code_attempts.sa_select_attempts, activation_codes.sa_delete_activation_codes, '
    'activation_codes.sa_insert_activation_codes, activation_codes.sa_select_activation_codes, '
    'activation_codes.sa_update_activation_codes, discount_code_redemptions.SuperAdmins can view all redemptions, '
    'discount_codes.SuperAdmins can delete discount codes, discount_codes.SuperAdmins can insert discount codes, '
    'discount_codes.SuperAdmins can manage discount codes, discount_codes.SuperAdmins can update discount codes, '
    'referrals.super_admin_delete_referrals, referrals.super_admin_insert_referrals, '
    'referrals.super_admin_select_referrals, referrals.super_admin_update_referrals, '
    'subscription_admin_actions.super_admin_all_subscription_admin_actions',
    '3.1 route every check through is_user_super_admin()');

  SELECT count(*) || ': ' || coalesce(string_agg(p.proname::text, ', ' ORDER BY p.proname), '')
    INTO v
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname <> 'is_user_super_admin'
     AND p.proname !~ '^_'
     AND p.prosrc ~ '(^|[^a-z_])is_super_admin([^a-z_]|$)';
  -- otp_issue, signup_create_company and signup_discard came with the
  -- one-time-code migrations (20260915100100, 20260915100200); company_approve
  -- and company_resend_trial_code with 20260916160000. Those two check the
  -- actor a service-role call names, for whom is_user_super_admin() (auth.uid())
  -- has nothing to read.
  PERFORM _mx_expect('catalogue', 'functions that read the is_super_admin column directly', v,
    '10: company_approve, company_resend_trial_code, delete_activation_code, '
    'enforce_user_profile_privilege_guard, hide_activation_code, '
    'otp_issue, revoke_activation_code, signup_create_company, signup_discard, '
    'update_company_subscription_manual',
    '3.1 route every check through is_user_super_admin()');

  SELECT count(*) || ': ' || coalesce(string_agg(p.proname::text, ', ' ORDER BY p.proname), '')
    INTO v
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c WHERE c LIKE 'search_path=%');
  PERFORM _mx_expect('catalogue', 'SECURITY DEFINER functions without a pinned search_path', v,
    '5: delete_activation_code, enforce_car_limit, hide_activation_code, revoke_activation_code, '
    'update_company_subscription_manual',
    '3.5 pin search_path');
END $$;

-- ── 3.3: company and user state are not enforced by the database ────────────
-- Each principal reads, inserts, updates and deletes a driver of its own
-- company, and reassigns one of its own trips through the planning RPC. Every
-- line is allowed today. The trial company is untagged on purpose: it is the
-- control that must still read YYYY and Y after phase 3.3, while every tagged
-- line is meant to move.
DO $$
DECLARE
  r   record;
  got text;
BEGIN
  FOR r IN
    SELECT 'admin-' || s.slug AS who, _mx_id('company', s.slug) AS co,
           _mx_id('state-driver', s.slug) AS drv, _mx_id('state-trip', s.slug) AS trip, s.label,
           CASE WHEN s.slug <> 'trial' THEN '3.3 company approval, status and subscription not enforced server-side' END AS hole,
           CASE WHEN s.slug <> 'trial' THEN '3.3 the planning RPCs read user_profiles.company_id, not the active-company helper' END AS rpc_hole,
           0 AS grp
      FROM _mx_state_company s
    UNION ALL
    SELECT v.who, 'c0000000-0000-4000-8000-00000000000a'::uuid, _mx_id('drivers', 'a'), _mx_id('fahrtenbuch_trips', 'a'), v.label,
           '3.3 a user''s own status not enforced server-side',
           '3.3 the planning RPCs read user_profiles.company_id, not the active-company helper',
           1
      FROM (VALUES
        ('deactivated-a',   'deactivated user (admin) of an active company'),
        ('suspended-a',     'suspended user (editor) of an active company'),
        ('inactive-a',      'inactive user (editor) of an active company'),
        ('pendinginvite-a', 'user (editor) with a pending invitation, of an active company')
      ) AS v(who, label)
    ORDER BY grp, label
  LOOP
    got := left(_mx_try(r.who, NULL, format('SELECT count(*) FROM drivers WHERE id = %L', r.drv)), 1)
        || left(_mx_try(r.who, NULL, format('INSERT INTO drivers (company_id, name) VALUES (%L, %L)', r.co, 'MX state probe')), 1)
        || left(_mx_try(r.who, NULL, format('UPDATE drivers SET name = name WHERE id = %L', r.drv)), 1)
        || left(_mx_try(r.who, NULL, format('DELETE FROM drivers WHERE id = %L', r.drv)), 1);
    PERFORM _mx_expect('state', r.label || ': drivers S I U D', got, 'YYYY', r.hole);
    PERFORM _mx_expect('state', r.label || ': reassign_fahrtenbuch_trip on its own trip',
      _mx_call(r.who, format('SELECT reassign_fahrtenbuch_trip(%L, %L, %L)::text', r.trip, r.drv, 'MX state probe')),
      'Y', r.rpc_hole);
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
  PERFORM _mx_expect('codes', 'viewer of company A reads the text of a code assigned to company B',
    _mx_try('viewer-a', NULL, format('SELECT count(*) FROM discount_codes WHERE code = %L AND assigned_company_id = %L', 'MX-CODE-b', co_b)),
    'Y', '3.5 every signed-in user reads all active discount codes');

  PERFORM _mx_expect('codes', 'viewer of company A records a failed attempt in company B''s name',
    _mx_try('viewer-a', NULL, format('INSERT INTO activation_code_attempts (company_id, user_id, success, reason) VALUES (%L, %L, false, %L)', co_b, admin_b, 'forged')),
    'Y', '3.5 WITH CHECK (true): any member writes attempts for any company');

  -- …and ten of those lock company B out of redeeming its own valid code.
  BEGIN
    PERFORM _mx_become('viewer-a');
    INSERT INTO activation_code_attempts (company_id, user_id, success, reason)
      SELECT co_b, admin_b, false, 'forged' FROM generate_series(1, 10);
    PERFORM _mx_become('admin-b');
    v_out := redeem_activation_code('731604')::text;
    RAISE EXCEPTION USING ERRCODE = 'ZZ003', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ003' THEN v_out := SQLERRM;
    WHEN OTHERS THEN v_out := 'error: ' || SQLERRM;
  END;
  PERFORM _mx_expect('codes', 'forged attempts lock company B out of redeeming its own valid code',
    CASE WHEN v_out LIKE '%Zu viele Versuche%' THEN 'locked' ELSE v_out END,
    'locked', '3.5 WITH CHECK (true): any member writes attempts for any company');

  BEGIN
    SELECT count(*) INTO v_before FROM activation_code_attempts;
    PERFORM _mx_become('viewer-a');
    v_refused := 0;
    FOR i IN 1 .. 15 LOOP
      v_out := preview_activation_code(lpad(i::text, 6, '9'))::text;
      IF v_out NOT LIKE '%nicht gefunden%' THEN
        v_refused := v_refused + 1;
      END IF;
    END LOOP;
    PERFORM _mx_become('owner');
    SELECT count(*) INTO v_after FROM activation_code_attempts;
    RAISE EXCEPTION USING ERRCODE = 'ZZ003',
      MESSAGE = format('15 wrong guesses, %s refused, %s recorded', v_refused, v_after - v_before);
  EXCEPTION
    WHEN SQLSTATE 'ZZ003' THEN v_out := SQLERRM;
    WHEN OTHERS THEN v_out := 'error: ' || SQLERRM;
  END;
  PERFORM _mx_expect('codes', 'preview_activation_code answers every guess and records none', v_out,
    '15 wrong guesses, 0 refused, 0 recorded', '3.5 preview_activation_code has no limit');

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

  PERFORM _mx_expect('codes', 'viewer reads its company''s approval_note and rejection_reason',
    _mx_try('viewer-a',
      $q$UPDATE companies SET approval_note = 'mx note', rejection_reason = 'mx reason' WHERE slug = 'test-a'$q$,
      $q$SELECT count(*) FROM companies WHERE slug = 'test-a' AND approval_note = 'mx note' AND rejection_reason = 'mx reason'$q$),
    'Y', '3.5 approval_note and rejection_reason readable by members');
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

-- Checked in the order listed. `stmt` is filled for company A (see _mx_fill).
CREATE TEMP TABLE _mx_rpc (ord serial, label text, stmt text, want text, hole text);

INSERT INTO _mx_rpc (label, stmt, want, hole) VALUES
    -- the platform screens
    ('is_user_super_admin()',
     $q$SELECT is_user_super_admin()::text$q$,
     '-NNNNNY', '3.2 platform right from the column alone, no verified session'),
    ('revoke_activation_code(code of A)',
     $q$SELECT revoke_activation_code({ref:activation_codes})::text$q$,
     'NNNNNNY', '3.1 super check reads the is_super_admin column directly'),
    ('delete_activation_code(code of A)',
     $q$SELECT delete_activation_code({ref:activation_codes})::text$q$,
     'NNNNNNY', '3.1 super check reads the is_super_admin column directly'),
    ('hide_activation_code(code of A)',
     $q$SELECT hide_activation_code({ref:activation_codes}, 'mx')::text$q$,
     'NNNNNNY', '3.1 super check reads the is_super_admin column directly'),
    ('update_company_subscription_manual(company B)',
     $q$SELECT update_company_subscription_manual('c0000000-0000-4000-8000-00000000000b', 'active', now(), now() + interval '30 days', '1_monat', 'mx')::text$q$,
     'NNNNNNY', '3.1 super check reads the is_super_admin column directly'),
    -- anon's EXECUTE revoked by 20260915120000; the platform's invoice screen
    -- calls it signed in
    ('generate_invoice_number(2026)',
     $q$SELECT generate_invoice_number(2026)$q$,
     'PYYYYYY', NULL),
    -- anon's EXECUTE on both activation-code RPCs revoked by 20260915110000.
    -- The super admin, who has no company, is refused since 20260916160000: the
    -- company binding compared with <>, which a caller without a company passed.
    ('preview_activation_code(valid code of A)',
     $q$SELECT preview_activation_code('482915')::text$q$,
     'PYYYYNN', '3.5 preview_activation_code has no limit'),
    ('redeem_activation_code(valid code of A)',
     $q$SELECT redeem_activation_code('482915')::text$q$,
     'PYYYYNN', '3.5 redeem_activation_code open to every member, not only the admin'),
    -- service_role only. 20260911120000 revoked PUBLIC and authenticated and
    -- left the explicit grant Supabase's default privileges give anon, so anyone
    -- holding the anon key could redeem a code against any company, until
    -- 20260915110000 revoked it.
    ('redeem_discount_code(unused code, company A)',
     $q$SELECT redeem_discount_code('MX-OPEN', 'c0000000-0000-4000-8000-00000000000a', 'basic', 'monthly', 1)::text$q$,
     'PPPPPPP', NULL),
    -- anon's EXECUTE revoked by 20260915120000
    ('compute_plan_price(basic, 5, monthly)',
     $q$SELECT compute_plan_price('basic', 5, 'monthly')::text$q$,
     'PYYYYYY', NULL),

    -- the planning RPCs, on company A's import, trip and runs. Company B's
    -- admin makes the same calls with company A's ids. None checks the role,
    -- only the company (see "Recorded without a plan step"). anon's EXECUTE on
    -- the first four was revoked by 20260915120000; each raised for anon before.
    ('apply_monthly_planning_run(import and trip of A)',
     $q$SELECT ((apply_monthly_planning_run(jsonb_build_object(
          'import_id', {ref:fahrtenbuch_imports}, 'month', 3, 'year', 2026,
          'change_rows', jsonb_build_array(jsonb_build_object(
            'trip_id', {ref:fahrtenbuch_trips}, 'driver_id', {ref:drivers}, 'driver_name', 'MX'))))
        ->> 'updated_trips')::int > 0)::text$q$,
     'PYYYYNT', NULL),
    ('replace_monthly_planning_run(applied run of A)',
     $q$SELECT ((replace_monthly_planning_run(jsonb_build_object(
          'import_id', {ref:fahrtenbuch_imports}, 'month', 4, 'year', 2026,
          'change_rows', jsonb_build_array(jsonb_build_object(
            'trip_id', {ref:fahrtenbuch_trips}, 'driver_id', {ref:drivers}, 'driver_name', 'MX'))),
        {ref:rpc_applied_run}) ->> 'updated_trips')::int > 0)::text$q$,
     'PYYYYTT', NULL),
    ('delete_or_archive_monthly_planning_run(run of A)',
     $q$SELECT delete_or_archive_monthly_planning_run({ref:rpc_run})::text$q$,
     'PYYYYTT', NULL),
    ('purge_old_monthly_planning_runs(month of A''s archived run)',
     $q$SELECT ((purge_old_monthly_planning_runs(5, 2026) ->> 'deleted_count') IS NOT NULL)::text$q$,
     'PYYYYNT', NULL),
    -- anon's EXECUTE revoked by 20260607124839
    ('reassign_fahrtenbuch_trip(trip of A)',
     $q$SELECT reassign_fahrtenbuch_trip({ref:fahrtenbuch_trips}, {ref:drivers}, 'MX', 'pending', 'mx', 'mx')::text$q$,
     '-YYYYTT', NULL),

    -- the Abrechnung and cash RPCs: security invoker, so they return what the
    -- income, receipts and cash_transactions policies let the caller read.
    -- anon's EXECUTE revoked by 20260427075001 and 20260428102656.
    ('get_weekly_abrechnung(2026, 3) shows company A''s line',
     $q$SELECT (count(*) > 0)::text FROM get_weekly_abrechnung(2026, 3) WHERE driver_name = 'MX view a'$q$,
     '-YYYYNY', '3.4 super reaches tenant data with no support session'),
    ('get_monthly_abrechnung(2026, 3) shows company A''s line',
     $q$SELECT (count(*) > 0)::text FROM get_monthly_abrechnung(2026, 3) WHERE driver_name = 'MX view a'$q$,
     '-YYYYNY', '3.4 super reaches tenant data with no support session'),
    ('get_driver_weekly_abrechnung(driver of A, 2026, 3) has a line',
     $q$SELECT (count(*) > 0)::text FROM get_driver_weekly_abrechnung('MX view a', 2026, 3)$q$,
     '-YYYYNY', '3.4 super reaches tenant data with no support session'),
    ('get_driver_monthly_abrechnung(driver of A, 2026, 3) has a line',
     $q$SELECT (count(*) > 0)::text FROM get_driver_monthly_abrechnung('MX view a', 2026, 3)$q$,
     '-YYYYNY', '3.4 super reaches tenant data with no support session'),
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
    ('is_company_admin()',
     $q$SELECT is_company_admin()::text$q$,
     'NNNNYYN', NULL),
    -- NULL, not false, for a caller without a profile row
    ('current_role_permits(drivers, edit)',
     $q$SELECT current_role_permits('drivers', true)::text$q$,
     '0NYYYYY', NULL),
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
    -- EXECUTE revoked from anon and authenticated before the fixture, and by no
    -- later migration
    ('create_user_profile_manual(user, name)',
     $q$SELECT create_user_profile_manual({ref:user_profiles}, 'x')::text$q$,
     '-------', NULL),

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
    -- service_role only, called by the company-approval function (20260916160000)
    ('company_approve(…)',
     $q$SELECT company_approve(NULL::uuid, NULL::uuid, NULL::text, NULL::text)::text$q$,
     'PPPPPPP', NULL),
    ('company_resend_trial_code(…)',
     $q$SELECT company_resend_trial_code(NULL::uuid, NULL::uuid, NULL::text, NULL::text)::text$q$,
     'PPPPPPP', NULL);

DO $$
DECLARE
  who_logins constant text[] := _mx_who_logins();
  r       record;
  f       record;
  i       int;
  outcome text;
  got     text;
  details text;
BEGIN
  FOR r IN SELECT * FROM _mx_rpc ORDER BY ord LOOP
    got := '';
    details := '';
    FOR i IN 1 .. array_length(who_logins, 1) LOOP
      IF substr(r.want, i, 1) = '-' THEN
        got := got || '-';
        CONTINUE;
      END IF;
      outcome := _mx_call(who_logins[i], _mx_fill(r.stmt, 'rpc', 'a'));
      got := got || left(outcome, 1);
      details := details || format(E'\n      %s: %s', who_logins[i], substr(outcome, 3, 160));
    END LOOP;
    IF got = r.want THEN
      RAISE NOTICE '%', format('ok  %-10s %-48s %s%s', 'rpc', r.label, got,
        CASE WHEN r.hole IS NOT NULL THEN '   HOLE[' || r.hole || ']' ELSE '' END);
    ELSE
      INSERT INTO _mx_failures VALUES ('rpc', r.label, format('expected %s, got %s%s', r.want, got, details));
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
