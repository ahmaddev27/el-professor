/*
  # A platform account changes its own address without a code

  The owner's decision of 17.09.2026. A platform account changes its own email
  address with its current password alone; **company users keep the one-time
  code exactly as it is**, and nothing in `otp_issue` / `otp_verify` is touched
  here.

  ## Why the code went, and what is left holding the door

  The code for `email_change` is sent to the **new** address, so it proves that
  whoever asked controls the new mailbox. It never proved anything about the
  account: an attacker at an unattended signed-in browser picks the new address
  themselves and reads their own code. The control that stops that attacker is
  the other half of the flow — `otp-request` refuses `email_change` unless the
  session's `amr` claim names a **password** sign-in no older than
  `PASSWORD_PROOF_MAX_AGE_SECONDS` (600 s,
  `supabase/functions/_shared/otp-core.ts`). GoTrue writes that claim only for
  `/token?grant_type=password`, so it is a server-side proof that the person at
  the keyboard typed the password.

  The new route keeps that requirement unchanged and drops only the mailbox
  proof. The owner hit the wall it created in practice: the code goes to an
  address he cannot yet read.

  What is lost is worth writing down: nothing now verifies that the new address
  exists or belongs to the person. A typo locks the account out of its own
  sign-in address. The notice this route mails to the **old** address (the same
  `sendEmailChangedNotice` the code path sends) is what makes such a mistake
  visible, and a platform account can be moved back by another owner through
  `manage-users`.

  ## What this file adds

  Two SECURITY DEFINER functions in `public`, **granted to `service_role`
  only**, because the caller is the `platform-staff` edge function acting with
  the service role on behalf of a user id it has just verified — the same shape
  as `public.account_is_platform_staff(uuid)` (20260916110010). Neither takes a
  session: `auth.uid()` is NULL for the service role, and both answer about the
  account whose id they are handed.

  - `platform_self_email_change_check(user_id, new_email)` — one round trip for
    every decision the database can make: is this an **active** platform staff
    row, does the account exist, is the address unchanged, does another account
    already hold it. `auth.users` is the authority for the last two;
    `user_profiles.email` is a copy kept by a trigger and an account without a
    profile row has none at all (see "No auto-profile trigger" in CLAUDE.md), so
    reading the profile would answer wrongly. The address test is
    `20260915100100`'s, character for character, so the two flows refuse the
    same addresses.
  - `platform_self_email_change_record(user_id, old, new, session_id)` — the one
    audit row, written through `app_private.audit_write` with category `auth`.

  ## Why the audit row does not go through platform_audit_record

  `public.platform_audit_record` is the edge functions' door and **any** active
  staff role can open it, `read_only` included. It therefore refuses the
  categories the database writes itself and every action in the namespaces
  `platform_staff.`, `legacy.`, `auth.` and `platform_read.`, and accepts only
  the actions listed in `app_private.platform_edge_audit_actions()`. Both rules
  stay exactly as they are. The action here is `auth.platform_email_change`,
  deliberately inside the reserved `auth.` namespace, so the existing refusal
  already covers it and no list anywhere grows. Self-check 5 proves that by
  calling `platform_audit_record` with this action and requiring 22023.

  For the same reason the action is **not** added to
  `platform_edge_audit_actions()`, and `supabase/functions/_shared/platform-email-change.ts`
  is deliberately not part of `PLATFORM_STAFF_ROUTES`: that table is compared
  against the edge-action list by `platform-access-actions.test.ts`, and a route
  whose row the database must refuse does not belong in it.

  ## Which capability this needs: none

  Changing one's own address is not a platform capability; it is a fact about
  the caller's own account, so no entry is added to
  `app_private.platform_capability_matrix()`. A `read_only` platform account may
  change its own address, exactly as a company user may change theirs. What the
  functions do require is an **active** staff row — a disabled one answers
  `not_platform_account`, and the route then refuses. That is on purpose: a
  disabled account is not the platform's any more, and it has no company either,
  so the code path would have nothing to fall back to.

  ## Coordination with the open branches

  Nothing here is redefined by either open pull request. #65
  (`phase3/platform-amr-check`, `20260919130000`) rewrites
  `app_private.platform_staff_role_of`, `platform_staff_role_of_account`,
  `platform_staff_sync_profile`, `jwt_amr`, `session_amr_permits_platform` and
  `public.enforce_user_profile_privilege_guard`; #56
  (`phase3/support-sessions-db`, `20260917140000`) rewrites twenty-two platform
  functions. This file creates two new names and replaces none.

  Both functions go on calling `app_private.platform_staff_role_of(user_id)`,
  the documented helper for SECURITY DEFINER code that holds a user id rather
  than a session, and both keep working under #65: its gate fires only when
  `auth.uid()` equals the id being asked about, and `auth.uid()` is NULL for the
  service role, so the answer stays the account's own fact.

  ## Compatibility

  Backward compatible, no SCHEMA_EPOCH bump: two new functions, no signature
  changed, no policy touched, no existing behaviour altered. The previous
  release simply never calls them.
*/

-- ─── 1. The decisions the database can make ─────────────────────────────────

/*
  Everything the route must know before it asks GoTrue to move the address, in
  one call and one snapshot.

  Answers, in the order the route reports them:

    not_platform_account  no staff row, or a disabled one
    no_account            the id has no auth.users row, or no address
    same_email            already the account's address
    email_taken           another account holds it
    ok

  A broken argument contract raises 22023 with a fixed message, per the rule for
  `app_private` callers: outcomes are return values, never exceptions. The route
  validates and normalises the address itself (otp-core's `parseEmail`), so a
  22023 here means the route and this function have drifted apart, not that a
  user typed something odd.
*/
CREATE OR REPLACE FUNCTION public.platform_self_email_change_check(
  p_user_id   uuid,
  p_new_email text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- RFC 5321's maximum, the same bound otp-core.ts checks before the call.
  c_max_email_length CONSTANT integer := 254;
  c_email_shape      CONSTANT text    := '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';

  v_new     text;
  v_current text;
BEGIN
  IF p_user_id IS NULL OR p_new_email IS NULL THEN
    RAISE EXCEPTION 'platform_self_email_change_check: invalid arguments' USING ERRCODE = '22023';
  END IF;

  v_new := lower(btrim(p_new_email));
  IF length(v_new) = 0 OR length(v_new) > c_max_email_length OR v_new !~ c_email_shape THEN
    RAISE EXCEPTION 'platform_self_email_change_check: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- The account fact, not a session: auth.uid() is NULL for the service role
  -- that calls this, so 20260919130000's amr gate (if merged) never fires here.
  IF app_private.platform_staff_role_of(p_user_id) IS NULL THEN
    RETURN 'not_platform_account';
  END IF;

  SELECT lower(u.email) INTO v_current FROM auth.users u WHERE u.id = p_user_id;
  IF v_current IS NULL THEN
    RETURN 'no_account';
  END IF;

  IF v_current = v_new THEN
    RETURN 'same_email';
  END IF;

  -- 20260915100100's test, unchanged, so the direct route and the code route
  -- call the same addresses taken.
  IF EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = v_new AND u.id <> p_user_id) THEN
    RETURN 'email_taken';
  END IF;

  RETURN 'ok';
END;
$$;

COMMENT ON FUNCTION public.platform_self_email_change_check(uuid, text) IS
  'Everything the platform-staff email-change route must know before GoTrue is '
  'asked to move an address: not_platform_account, no_account, same_email, '
  'email_taken or ok. Service role only; answers about the account it is '
  'handed, never about the caller''s session.';

-- ─── 2. The one audit row ───────────────────────────────────────────────────

/*
  Records a completed self-service address change.

  Category `auth`, action `auth.platform_email_change`, outcome `ok`, actor the
  account itself, and the two addresses as `before` and `after`. The row is
  written after GoTrue has accepted the change, so there is exactly one and it
  never claims a change that did not happen.

  Returns NULL, rather than raising, for an account with no active staff row:
  the route has already refused such a caller, and a second refusal here would
  turn a completed change into a 500. A NULL is the signal that the row was not
  written, and the route logs it.

  `p_session_id` is the session id the route read out of the caller's verified
  token. `audit_write` would otherwise take it from `request.jwt.claims`, which
  for a service-role call carries no session at all.
*/
CREATE OR REPLACE FUNCTION public.platform_self_email_change_record(
  p_user_id    uuid,
  p_old_email  text,
  p_new_email  text,
  p_session_id uuid DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_max_email_length CONSTANT integer := 254;

  v_old text;
  v_new text;
BEGIN
  IF p_user_id IS NULL OR p_old_email IS NULL OR p_new_email IS NULL THEN
    RAISE EXCEPTION 'platform_self_email_change_record: invalid arguments' USING ERRCODE = '22023';
  END IF;

  v_old := lower(btrim(p_old_email));
  v_new := lower(btrim(p_new_email));
  IF length(v_old) = 0 OR length(v_new) = 0
     OR length(v_old) > c_max_email_length OR length(v_new) > c_max_email_length
     OR v_old = v_new
  THEN
    RAISE EXCEPTION 'platform_self_email_change_record: invalid arguments' USING ERRCODE = '22023';
  END IF;

  IF app_private.platform_staff_role_of(p_user_id) IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN app_private.audit_write(
    'auth', 'auth.platform_email_change', 'ok',
    NULL,                                   -- no company: a platform account has none
    'user_account', p_user_id::text,
    jsonb_build_object('email', v_old),
    jsonb_build_object('email', v_new),
    p_user_id, p_session_id);
END;
$$;

COMMENT ON FUNCTION public.platform_self_email_change_record(uuid, text, text, uuid) IS
  'The single audit row for a platform account''s self-service address change: '
  'category auth, action auth.platform_email_change, the account as actor and '
  'the two addresses. Service role only. NULL when the account holds no active '
  'staff row.';

-- ─── 3. Ownership and grants ────────────────────────────────────────────────

-- Both reach app_private, so they must run as a role that can (see "Ownership"
-- in 20260916110010). CREATE OR REPLACE would keep an older owner.
ALTER FUNCTION public.platform_self_email_change_check(uuid, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_self_email_change_record(uuid, text, text, uuid) OWNER TO CURRENT_USER;

-- Supabase grants EXECUTE on every new public function to PUBLIC, anon,
-- authenticated and service_role. Revoke all four, then grant back the one
-- caller: the edge function acting with the service role.
REVOKE ALL ON FUNCTION public.platform_self_email_change_check(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_self_email_change_check(uuid, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.platform_self_email_change_record(uuid, text, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_self_email_change_record(uuid, text, text, uuid)
  TO service_role;

-- ─── 4. Self-check ──────────────────────────────────────────────────────────

DO $$
DECLARE
  c_check  CONSTANT text := 'public.platform_self_email_change_check(uuid,text)';
  c_record CONSTANT text := 'public.platform_self_email_change_record(uuid,text,text,uuid)';
  v_sig text;
BEGIN
  -- 1. both exist, are SECURITY DEFINER, and pin their search_path
  FOREACH v_sig IN ARRAY ARRAY[c_check, c_record] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION '20260919140000 self-check: % is missing', v_sig;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) THEN
      RAISE EXCEPTION '20260919140000 self-check: % is not SECURITY DEFINER', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                    WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=%') THEN
      RAISE EXCEPTION '20260919140000 self-check: % has no pinned search_path', v_sig;
    END IF;

    -- 2. the owner can actually reach the app_private helpers both call
    IF NOT EXISTS (SELECT 1
                     FROM pg_proc p
                     JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = to_regprocedure(v_sig)
                      AND (r.rolsuper
                           OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private'))) THEN
      RAISE EXCEPTION '20260919140000 self-check: the owner of % can call no app_private helper', v_sig;
    END IF;

    -- 3. service role only
    IF has_function_privilege('anon', v_sig::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', v_sig::regprocedure, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '20260919140000 self-check: EXECUTE on % should be service_role only', v_sig;
    END IF;
  END LOOP;

  -- 4. the recording function names the category and the action it must write
  IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure(c_record))
       !~ 'auth\.platform_email_change' THEN
    RAISE EXCEPTION '20260919140000 self-check: the audit action is gone from %', c_record;
  END IF;

  -- 5. the edge functions' own door still refuses that action, so this row can
  --    be written by this function and by nothing a staff role can reach
  BEGIN
    PERFORM public.platform_audit_record('write', 'auth.platform_email_change', 'ok');
    RAISE EXCEPTION '20260919140000 self-check: platform_audit_record accepted the auth namespace';
  EXCEPTION
    WHEN sqlstate '22023' THEN NULL;
  END;

  -- 6. and it is not on the edge functions' action list either
  IF EXISTS (SELECT 1 FROM app_private.platform_edge_audit_actions() a
              WHERE a.action = 'auth.platform_email_change') THEN
    RAISE EXCEPTION '20260919140000 self-check: the action was added to platform_edge_audit_actions()';
  END IF;

  -- 7. category `auth` is one audit_write accepts; a 22023 here would mean the
  --    row could never be written at all
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'app_private' AND t.relname = 'platform_audit_log'
       AND pg_get_constraintdef(c.oid) ~ 'category' AND pg_get_constraintdef(c.oid) ~ '''auth''') THEN
    RAISE EXCEPTION '20260919140000 self-check: platform_audit_log no longer accepts category auth';
  END IF;
END $$;
