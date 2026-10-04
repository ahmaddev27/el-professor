/*
  # The three platform staff roles that were built but refused

  Owner's decision, 23.09.2026. `support`, `billing` and `read_only` exist in
  `app_private.platform_capability_matrix()` and in the table's CHECK constraint
  since 20260916110000, and every policy and RPC has asked for a *capability*
  rather than for staff status since 20260917130000 — but no account could ever
  hold one of them: `platform_staff_add` and `platform_staff_enable` refused any
  role but `owner` with reason `role_requires_3_3`.

  This migration is the one change those two functions need.

  ## What the guard was, and why it goes now

  It was written for plan step 3.5 (20260916130010) against a real defect: every
  policy then built on `is_user_super_admin()` gave *any* active staff row an
  owner's writes on the tenant tables, so a row labelled `support` or
  `read_only` would have held far more than its name said.

  Both technical reasons are gone:

  - `20260917130000` (plan 3.3) rewrote every tenant policy onto named
    capabilities and took the `is_user_super_admin() OR …` term out of
    `current_role_permits()`. A role now holds exactly the capabilities the
    matrix gives it.
  - `20260920100000` (plan 3.C) stopped a read-only support context writing the
    `documents` bucket, the last write a non-owner role could have reached
    outside the capability system.

  What kept the refusal after that was a product decision, not a defect:
  enabling these roles decides which accounts read every customer's data. The
  owner has now taken it, so it ships as this change of its own.

  ## What this migration does **not** change

  - **Not the capability matrix.** `app_private.platform_capability_matrix()`
    is untouched, and self-check 5 below re-asserts the two open decisions it
    encodes: `support` still has no `companies.lifecycle` (D2) and `read_only`
    still no `audit.read` (D3).
  - **Not the last-active-owner guard.** `platform_staff_disable` is not
    restated at all; self-check 3 re-asserts its `last_owner` branch and its
    advisory lock from the catalogue, and self-check 6 that the table's trigger
    `platform_staff_keep_owner` is still attached. That trigger already refuses
    a *demotion* (`NEW.role <> 'owner'`), so no path — and there is none — can
    turn the last owner into a support account either.
  - **Not `app_private.platform_staff_role_of` or `app_private.jwt_amr`.** A
    platform capability still requires a password-backed session
    (20260919130000), and the three new roles inherit that rule because they
    reach it through the same helper.
  - **Not `platform_rpc_response` or `platform_rpc_record`.** Both still carry a
    `role_requires_3_3` branch (its live definition is 20260917140000's). No
    function returns that reason any more, so the branch is unreachable;
    restating those two shared helpers to delete one dead line would risk
    dropping one of the other twenty that are not dead. It stays, and
    `tests/rls/platform-rpcs.sql` section 5 asserts that nothing produces it.
  - **Not the invitation path.** `supabase/functions/platform-staff` still
    creates the account, writes a company-less `pending_invite` profile with
    profile role `viewer`, adds the staff row through `platform_staff_add` with
    the caller's own token, and only then mails the code. It now passes the role
    the operator picked instead of the literal `'owner'`.

  ## The two restated functions

  Every other rule of 20260916130010 is carried over character for character —
  one transaction, `platform_rpc_authorize('staff.manage', …)` first with its
  `denied` cap, exactly one `app_private.audit_write` row per call through
  `platform_rpc_finish`, the stable reason codes and their German sentences, the
  argument contract, and the `unique_violation` race. The diff against that file
  is exactly:

  - `platform_staff_add`: the `IF p_role <> 'owner'` block is gone, the INSERT
    names `p_role` instead of the literal `'owner'`, and the audit row's
    `after_value` records the role that was written.
  - `platform_staff_enable`: the `IF v_row.role <> 'owner'` block is gone.

  The role whitelist in the argument contract is unchanged and still the only
  gate on the value: a role outside the four is `invalid`, as it always was.

  ## Compatibility

  Backward compatible, no SCHEMA_EPOCH bump. No column, table or meaning
  changes; two function bodies accept more than they did. The previous release's
  bundle only ever sends `'owner'`, so it keeps working against this database —
  its Team page would show a `support` row it cannot re-enable and say so, which
  is a stale sentence, not a break.
*/

-- ─── platform_staff_add ─────────────────────────────────────────────────────

-- 20260916130010's body, with the `p_role <> 'owner'` block removed and the
-- role inserted instead of the literal. Everything else is unchanged.
CREATE OR REPLACE FUNCTION public.platform_staff_add(
  p_user_id uuid,
  p_role    text DEFAULT 'owner',
  p_note    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'platform_staff.add';
  v_user   jsonb;
  v_note   text := nullif(trim(p_note), '');
BEGIN
  IF NOT app_private.platform_rpc_authorize('staff.manage', 'staff', c_action, NULL, 'platform_staff', p_user_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  -- The four roles the table's CHECK constraint and the capability matrix
  -- know. Anything else is a broken request, not a policy refusal.
  IF p_user_id IS NULL OR p_role IS NULL OR p_role NOT IN ('owner', 'support', 'billing', 'read_only')
     OR length(v_note) > 500 THEN
    RETURN app_private.platform_rpc_finish('staff', c_action, 'invalid', NULL, 'platform_staff', p_user_id::text,
                                           NULL, jsonb_build_object('role', p_role));
  END IF;

  -- to_jsonb: deleted_at and banned_until are GoTrue's columns, read without
  -- naming them so the function also runs where a test stubs auth.users.
  SELECT to_jsonb(u) INTO v_user FROM auth.users u WHERE u.id = p_user_id;
  IF v_user IS NULL OR (v_user ->> 'deleted_at') IS NOT NULL THEN
    RETURN app_private.platform_rpc_finish('staff', c_action, 'account_not_found', NULL, 'platform_staff', p_user_id::text, NULL, NULL);
  END IF;

  IF EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.user_id = p_user_id AND up.company_id IS NOT NULL) THEN
    RETURN app_private.platform_rpc_finish('staff', c_action, 'account_in_company', NULL, 'platform_staff', p_user_id::text, NULL, NULL);
  END IF;

  IF EXISTS (SELECT 1 FROM app_private.platform_staff s WHERE s.user_id = p_user_id) THEN
    RETURN app_private.platform_rpc_finish('staff', c_action, 'already_staff', NULL, 'platform_staff', p_user_id::text, NULL, NULL);
  END IF;

  BEGIN
    INSERT INTO app_private.platform_staff (user_id, role, created_by, note)
    VALUES (p_user_id, p_role, auth.uid(), v_note);
  EXCEPTION WHEN unique_violation THEN
    -- Added by a concurrent call a moment ago.
    RETURN app_private.platform_rpc_finish('staff', c_action, 'already_staff', NULL, 'platform_staff', p_user_id::text, NULL, NULL);
  END;

  RETURN app_private.platform_rpc_finish('staff', c_action, NULL, NULL, 'platform_staff', p_user_id::text,
                                         NULL, jsonb_build_object('role', p_role, 'note', v_note));
END;
$$;

-- ─── platform_staff_enable ──────────────────────────────────────────────────

-- 20260916130010's body, with the `v_row.role <> 'owner'` block removed.
-- Re-enabling only restores the role the row already carries: nothing here
-- chooses one, and nothing here can remove an owner.
CREATE OR REPLACE FUNCTION public.platform_staff_enable(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'platform_staff.enable';
  v_row app_private.platform_staff%ROWTYPE;
BEGIN
  IF NOT app_private.platform_rpc_authorize('staff.manage', 'staff', c_action, NULL, 'platform_staff', p_user_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  SELECT * INTO v_row FROM app_private.platform_staff s WHERE s.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('staff', c_action, 'not_found', NULL, 'platform_staff', p_user_id::text, NULL, NULL);
  END IF;
  IF v_row.disabled_at IS NULL THEN
    RETURN app_private.platform_rpc_finish('staff', c_action, 'already_enabled', NULL, 'platform_staff', p_user_id::text, NULL, NULL);
  END IF;

  UPDATE app_private.platform_staff SET disabled_at = NULL WHERE user_id = p_user_id;

  RETURN app_private.platform_rpc_finish('staff', c_action, NULL, NULL, 'platform_staff', p_user_id::text,
                                         jsonb_build_object('role', v_row.role, 'disabled_at', v_row.disabled_at),
                                         jsonb_build_object('role', v_row.role, 'disabled_at', NULL));
END;
$$;

-- ─── Ownership and privileges ───────────────────────────────────────────────

-- CREATE OR REPLACE keeps both, so these only restate what 20260916130010 set;
-- the self-check below is what proves it.
ALTER FUNCTION public.platform_staff_add(uuid, text, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_staff_enable(uuid) OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.platform_staff_add(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_staff_add(uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.platform_staff_enable(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_staff_enable(uuid) TO authenticated;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_wrong  text;
  v_add    text := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.platform_staff_add(uuid,text,text)'::regprocedure);
  v_enable text := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.platform_staff_enable(uuid)'::regprocedure);
  v_disable text := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.platform_staff_disable(uuid)'::regprocedure);
  v_missing text;
BEGIN
  -- 1. Shape and privileges, as 20260916130010 asserted them. platform_staff_disable
  --    is listed although this migration does not restate it: it shares the rule.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ') INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig))
                 THEN 'not SECURITY DEFINER'
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               WHEN NOT EXISTS (SELECT 1
                                  FROM pg_proc p
                                  JOIN pg_roles r ON r.oid = p.proowner
                                 WHERE p.oid = to_regprocedure(v.sig)
                                   AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private')))
                 THEN 'owner can call no app_private helper'
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM false
                 THEN 'anon EXECUTE should be false'
               WHEN has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM true
                 THEN 'authenticated EXECUTE should be true'
               WHEN has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM false
                 THEN 'service_role EXECUTE should be false'
             END AS problem
        FROM (VALUES
          ('public.platform_staff_add(uuid,text,text)'),
          ('public.platform_staff_disable(uuid)'),
          ('public.platform_staff_enable(uuid)')
        ) AS v(sig)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260923110000 self-check 1: %', v_wrong;
  END IF;

  -- 2. The lift itself: the guard is gone from both bodies, and the role the
  --    caller asked for is what is written.
  IF v_add ~ 'p_role <> ''owner''' OR v_enable ~ 'v_row\.role <> ''owner''' THEN
    RAISE EXCEPTION '20260923110000 self-check 2: the role_requires_3_3 guard is still in a staff function';
  END IF;
  IF v_add !~ 'VALUES \(p_user_id, p_role, auth\.uid\(\), v_note\)' THEN
    RAISE EXCEPTION '20260923110000 self-check 2: platform_staff_add does not insert the role it was asked for';
  END IF;
  IF v_add ~ 'role_requires_3_3' OR v_enable ~ 'role_requires_3_3' THEN
    RAISE EXCEPTION '20260923110000 self-check 2: a staff function still answers role_requires_3_3';
  END IF;

  -- 3. Every other rule of 20260916130010, asserted fragment by fragment, so a
  --    later restatement of one of these bodies cannot lose one silently.
  SELECT string_agg(f.fragment, '; ') INTO v_missing
    FROM (VALUES
      -- platform_staff_add
      ('add: staff.manage',        v_add,     'platform_rpc_authorize\(''staff\.manage'', ''staff'', c_action'),
      ('add: denied answer',       v_add,     'platform_rpc_response\(''denied''\)'),
      ('add: the four roles',      v_add,     'p_role NOT IN \(''owner'', ''support'', ''billing'', ''read_only''\)'),
      ('add: note length',         v_add,     'length\(v_note\) > 500'),
      ('add: invalid',             v_add,     '''invalid'''),
      ('add: account_not_found',   v_add,     '''account_not_found'''),
      ('add: deleted account',     v_add,     'v_user ->> ''deleted_at'''),
      ('add: account_in_company',  v_add,     '''account_in_company'''),
      ('add: already_staff',       v_add,     '''already_staff'''),
      ('add: the insert race',     v_add,     'EXCEPTION WHEN unique_violation'),
      ('add: records the role',    v_add,     'jsonb_build_object\(''role'', p_role, ''note'', v_note\)'),
      -- platform_staff_enable
      ('enable: staff.manage',     v_enable,  'platform_rpc_authorize\(''staff\.manage'', ''staff'', c_action'),
      ('enable: denied answer',    v_enable,  'platform_rpc_response\(''denied''\)'),
      ('enable: row lock',         v_enable,  'WHERE s\.user_id = p_user_id FOR UPDATE'),
      ('enable: not_found',        v_enable,  '''not_found'''),
      ('enable: already_enabled',  v_enable,  '''already_enabled'''),
      ('enable: clears disabled',  v_enable,  'SET disabled_at = NULL WHERE user_id = p_user_id'),
      -- platform_staff_disable, which this migration deliberately leaves alone
      ('disable: staff.manage',    v_disable, 'platform_rpc_authorize\(''staff\.manage'', ''staff'', c_action'),
      ('disable: last_owner',      v_disable, '''last_owner'''),
      ('disable: owner lock',      v_disable, 'pg_advisory_xact_lock\(hashtextextended\(''app_private\.platform_staff:active_owners'''),
      ('disable: counts owners',   v_disable, 's\.role = ''owner'' AND s\.disabled_at IS NULL AND s\.user_id <> p_user_id')
    ) AS f(fragment, body, pattern)
   WHERE f.body IS NULL OR f.body !~ f.pattern;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20260923110000 self-check 3: a rule of 20260916130010 was lost: %', v_missing;
  END IF;

  -- 4. The password-backed-session rule of 20260919130000 still stands between
  --    a staff role and every capability: platform_rpc_authorize asks the
  --    session-gated helper, not the account fact.
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'app_private.platform_rpc_authorize(text,text,text,uuid,text,text)'::regprocedure)
     !~ 'app_private\.platform_staff_role_of\(v_actor\)'
  THEN
    RAISE EXCEPTION '20260923110000 self-check 4: platform_rpc_authorize no longer asks platform_staff_role_of';
  END IF;

  -- 5. The capability matrix is not this slice's to change. All four roles
  --    exist, and the two open decisions it encodes still read as they did.
  IF (SELECT count(DISTINCT m.role) FROM app_private.platform_capability_matrix() m) <> 4 THEN
    RAISE EXCEPTION '20260923110000 self-check 5: the capability matrix no longer names exactly four roles';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.platform_capability_matrix() m
              WHERE (m.role, m.capability) IN (('support', 'companies.lifecycle'),
                                               ('read_only', 'audit.read'),
                                               ('support', 'staff.manage'),
                                               ('billing', 'staff.manage'),
                                               ('read_only', 'staff.manage'),
                                               ('support', 'billing.manage'),
                                               ('read_only', 'billing.manage'),
                                               ('billing', 'business.read')))
  THEN
    RAISE EXCEPTION '20260923110000 self-check 5: a capability moved; open decisions D2/D3 are not this slice''s to answer';
  END IF;
  IF NOT (app_private.platform_role_can('support', 'business.read')
          AND app_private.platform_role_can('read_only', 'business.read')
          AND NOT app_private.platform_role_can('billing', 'business.read')
          AND app_private.platform_role_can('owner', 'staff.manage'))
  THEN
    RAISE EXCEPTION '20260923110000 self-check 5: the roles no longer hold the capabilities this slice hands out';
  END IF;

  -- 6. The last active owner is still protected underneath every path.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'app_private.platform_staff'::regclass
                    AND t.tgname = 'platform_staff_keep_owner'
                    AND NOT t.tgisinternal)
  THEN
    RAISE EXCEPTION '20260923110000 self-check 6: platform_staff_keep_owner is no longer on the staff table';
  END IF;
END $$;
