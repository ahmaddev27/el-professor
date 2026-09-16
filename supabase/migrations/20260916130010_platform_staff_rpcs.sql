/*
  # Platform staff: add, disable and re-enable, and invitations by code

  Plan 3.5. Builds on 20260916110000 (the staff table and its triggers) and
  20260916130000 (the platform RPC helpers).

  ## What this adds

  - `public.platform_staff_add(user_id, role = 'owner', note)`: an existing
    account joins the platform team. `staff.manage`.
  - `public.platform_staff_disable(user_id)` and
    `public.platform_staff_enable(user_id)`. `staff.manage`.
  - Each call writes one audit row in category `staff` (actions
    `platform_staff.add`, `.disable`, `.enable`), next to the row the staff
    table's own trigger writes for the change.

  ## Rules

  - **Only owners, until 3.3.** Every policy built on is_user_super_admin()
    still gives any active staff role an owner's writes on tenant tables, so
    no code path may create a non-owner staff row, or re-enable one, before
    phase 3.3 moves those policies onto capabilities. Both are refused with
    reason `role_requires_3_3` and a `denied` audit row. Disabling a non-owner
    only takes power away and stays allowed.
  - **The last active owner stays.** Disabling it is refused with reason
    `last_owner` before anything changes; platform_staff_keep_owner still
    raises underneath if another path tries. The same advisory lock as that
    trigger serialises the two.
  - **A staff account has no company** (plan 3.A). An account whose profile
    sits in a company is refused with `account_in_company`: making a company
    user a platform owner in place is not a decision this function takes.
    Open question for the owner.
  - An account that does not exist, or that GoTrue has soft-deleted, is
    `account_not_found`; one that already has a staff row, a disabled one
    included, is `already_staff` (re-enable it instead).

  ## Invitations

  `supabase/functions/platform-staff` invites a new staff member the way
  manage-users invites an employee: it creates the account with a random
  password and a `pending_invite` profile without a company, adds the owner row
  through platform_staff_add with the caller's own JWT, and mails an
  `invite_activate` code. The person enters it at /einladung and sets a
  password; staff sign in with that password only.

  `otp_issue` issued `invite_activate` only for a profile in a company. It now
  also issues one for a `pending_invite` profile without a company whose
  account holds an active staff row. Nothing else in it changes.

  ## Compatibility

  Backward compatible, no SCHEMA_EPOCH bump: new functions, and otp_issue with
  its signature and grants unchanged.
*/

-- ─── platform_staff_add ─────────────────────────────────────────────────────

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

  IF p_user_id IS NULL OR p_role IS NULL OR p_role NOT IN ('owner', 'support', 'billing', 'read_only')
     OR length(v_note) > 500 THEN
    RETURN app_private.platform_rpc_finish('staff', c_action, 'invalid', NULL, 'platform_staff', p_user_id::text,
                                           NULL, jsonb_build_object('role', p_role));
  END IF;

  -- Until 3.3 every active staff role holds an owner's writes through the
  -- older policies; see the header.
  IF p_role <> 'owner' THEN
    RETURN app_private.platform_rpc_finish('staff', c_action, 'role_requires_3_3', NULL, 'platform_staff', p_user_id::text,
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
    VALUES (p_user_id, 'owner', auth.uid(), v_note);
  EXCEPTION WHEN unique_violation THEN
    -- Added by a concurrent call a moment ago.
    RETURN app_private.platform_rpc_finish('staff', c_action, 'already_staff', NULL, 'platform_staff', p_user_id::text, NULL, NULL);
  END;

  RETURN app_private.platform_rpc_finish('staff', c_action, NULL, NULL, 'platform_staff', p_user_id::text,
                                         NULL, jsonb_build_object('role', 'owner', 'note', v_note));
END;
$$;

-- ─── platform_staff_disable ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.platform_staff_disable(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'platform_staff.disable';
  v_row app_private.platform_staff%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  IF NOT app_private.platform_rpc_authorize('staff.manage', 'staff', c_action, NULL, 'platform_staff', p_user_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  SELECT * INTO v_row FROM app_private.platform_staff s WHERE s.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('staff', c_action, 'not_found', NULL, 'platform_staff', p_user_id::text, NULL, NULL);
  END IF;
  IF v_row.disabled_at IS NOT NULL THEN
    RETURN app_private.platform_rpc_finish('staff', c_action, 'already_disabled', NULL, 'platform_staff', p_user_id::text, NULL, NULL);
  END IF;

  -- The lock platform_staff_keep_owner takes, in the same order (row, then
  -- lock), so this answer and the trigger's cannot disagree.
  IF v_row.role = 'owner' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('app_private.platform_staff:active_owners', 0));
    IF NOT EXISTS (SELECT 1 FROM app_private.platform_staff s
                    WHERE s.role = 'owner' AND s.disabled_at IS NULL AND s.user_id <> p_user_id) THEN
      RETURN app_private.platform_rpc_finish('staff', c_action, 'last_owner', NULL, 'platform_staff', p_user_id::text,
                                             NULL, jsonb_build_object('role', v_row.role));
    END IF;
  END IF;

  UPDATE app_private.platform_staff SET disabled_at = v_now WHERE user_id = p_user_id;

  RETURN app_private.platform_rpc_finish('staff', c_action, NULL, NULL, 'platform_staff', p_user_id::text,
                                         jsonb_build_object('role', v_row.role, 'disabled_at', NULL),
                                         jsonb_build_object('role', v_row.role, 'disabled_at', v_now));
END;
$$;

-- ─── platform_staff_enable ──────────────────────────────────────────────────

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
  -- An active non-owner row would hold an owner's writes until 3.3.
  IF v_row.role <> 'owner' THEN
    RETURN app_private.platform_rpc_finish('staff', c_action, 'role_requires_3_3', NULL, 'platform_staff', p_user_id::text,
                                           NULL, jsonb_build_object('role', v_row.role));
  END IF;

  UPDATE app_private.platform_staff SET disabled_at = NULL WHERE user_id = p_user_id;

  RETURN app_private.platform_rpc_finish('staff', c_action, NULL, NULL, 'platform_staff', p_user_id::text,
                                         jsonb_build_object('role', v_row.role, 'disabled_at', v_row.disabled_at),
                                         jsonb_build_object('role', v_row.role, 'disabled_at', NULL));
END;
$$;

-- ─── otp_issue: invitations for company-less staff ──────────────────────────

-- Unchanged from 20260916110010 except the invite_activate case of step 5.
CREATE OR REPLACE FUNCTION public.otp_issue(
  p_challenge_id  uuid,
  p_purpose       text,
  p_email         text,   -- public purposes: the typed address. Otherwise NULL
  p_user_id       uuid,   -- email_change / platform_login: JWT sub. Otherwise NULL
  p_new_email     text,   -- email_change only
  p_session_id    uuid,   -- platform_login only
  p_code_hash     text,
  p_client_ip     inet,   -- NULL skips the IP limit (manage-users invites, local dev)
  p_actor_user_id uuid    -- invite_activate from manage-users: the admin. Otherwise NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_validity     CONSTANT interval := interval '10 minutes';
  c_cooldown     CONSTANT interval := interval '60 seconds';
  c_email_hourly CONSTANT integer  := 5;
  c_ip_hourly    CONSTANT integer  := 20;
  c_window       CONSTANT interval := interval '1 hour';

  v_public       boolean := p_purpose IN ('signup_verify','password_reset','invite_activate');
  v_email        text    := lower(trim(p_email));
  v_new_email    text    := lower(trim(p_new_email));
  v_count        integer;
  v_edge         timestamptz;
  v_user         record;
  v_profile      record;
  v_user_email   text;
  v_recipient    text;
  v_eligible     boolean;
  v_company_name text;
  v_expires_at   timestamptz;
BEGIN
  -- 1. The argument contract. A violation is a bug in the caller, not an
  --    outcome, so it raises.
  IF p_challenge_id IS NULL
     OR p_purpose IS NULL
     OR p_purpose NOT IN ('signup_verify','password_reset','invite_activate','email_change','platform_login')
     OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
     OR (v_public AND (coalesce(v_email, '') = '' OR p_user_id IS NOT NULL
                       OR p_new_email IS NOT NULL OR p_session_id IS NOT NULL))
     OR (NOT v_public AND (p_email IS NOT NULL OR p_user_id IS NULL))
     OR (p_purpose = 'email_change'   AND (coalesce(v_new_email, '') = '' OR p_session_id IS NOT NULL))
     OR (p_purpose = 'platform_login' AND (p_session_id IS NULL OR p_new_email IS NOT NULL))
     OR (p_actor_user_id IS NOT NULL AND p_purpose <> 'invite_activate')
  THEN
    RAISE EXCEPTION 'otp_issue: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- 2. Serialize issues for one account, so two concurrent requests cannot
  --    both pass the cooldown or both supersede the same row.
  PERFORM pg_advisory_xact_lock(hashtextextended('otp:' || coalesce(p_user_id::text, v_email), 0));

  -- 3. Per-IP limit. Counts every recorded outcome — including no_user — so
  --    it behaves the same whether or not the address has an account. Hitting
  --    it records nothing, so a flood cannot grow the table.
  IF p_client_ip IS NOT NULL THEN
    SELECT count(*) INTO v_count
      FROM app_private.otp_send_events
     WHERE client_ip = p_client_ip AND created_at > now() - c_window;

    IF v_count >= c_ip_hourly THEN
      -- The row whose ageing out brings the count back under the limit.
      SELECT created_at INTO v_edge
        FROM app_private.otp_send_events
       WHERE client_ip = p_client_ip AND created_at > now() - c_window
       ORDER BY created_at
       OFFSET v_count - c_ip_hourly
       LIMIT 1;
      RETURN jsonb_build_object('status', 'rate_limited', 'reason', 'ip_hourly',
        'retry_after_seconds', greatest(1, ceil(extract(epoch FROM v_edge + c_window - now())))::integer);
    END IF;
  END IF;

  -- 4. Resolve the account.
  IF v_public THEN
    SELECT u.id, u.email, u.email_confirmed_at, u.banned_until, u.deleted_at
      INTO v_user
      FROM auth.users u
     WHERE lower(u.email) = v_email
     ORDER BY (u.deleted_at IS NOT NULL), u.created_at, u.id
     LIMIT 1;

    IF NOT FOUND THEN
      INSERT INTO app_private.otp_send_events (purpose, recipient_email, client_ip, actor_user_id, outcome)
      VALUES (p_purpose, v_email, p_client_ip, p_actor_user_id, 'no_user');
      RETURN jsonb_build_object('status', 'no_user');
    END IF;
  ELSE
    SELECT u.id, u.email, u.email_confirmed_at, u.banned_until, u.deleted_at
      INTO v_user
      FROM auth.users u
     WHERE u.id = p_user_id;

    -- Nothing to record against: there is no address to count.
    IF NOT FOUND OR v_user.email IS NULL THEN
      RETURN jsonb_build_object('status', 'ineligible');
    END IF;
  END IF;

  v_user_email := lower(v_user.email);
  -- 6 (computed early so every outcome below is recorded against it).
  v_recipient  := CASE WHEN p_purpose = 'email_change' THEN v_new_email ELSE v_user_email END;

  SELECT up.status, up.company_id, up.full_name
    INTO v_profile
    FROM public.user_profiles up
   WHERE up.user_id = v_user.id;

  -- 5. Eligibility.
  v_eligible := (v_user.banned_until IS NULL OR v_user.banned_until <= now())
                AND v_user.deleted_at IS NULL;

  IF v_eligible THEN
    v_eligible := CASE p_purpose
      WHEN 'signup_verify' THEN
            v_user.email_confirmed_at IS NULL
        AND EXISTS (SELECT 1 FROM app_private.pending_signups ps WHERE ps.user_id = v_user.id)
      WHEN 'password_reset' THEN
            v_user.email_confirmed_at IS NOT NULL
        AND coalesce(v_profile.status IN ('active','pending_invite'), false)
      WHEN 'invite_activate' THEN
            v_user.email_confirmed_at IS NOT NULL
        AND coalesce(v_profile.status = 'pending_invite', false)
        -- An employee is invited into a company; a platform staff member,
        -- invited by the platform-staff function, has no company but an
        -- active staff row (20260916130010).
        AND (v_profile.company_id IS NOT NULL
             OR app_private.platform_staff_role_of(v_user.id) IS NOT NULL)
      WHEN 'email_change' THEN
            coalesce(v_profile.status = 'active', false)
      WHEN 'platform_login' THEN
            app_private.platform_staff_role_of(v_user.id) IS NOT NULL
        AND EXISTS (SELECT 1 FROM auth.sessions s
                     WHERE s.id = p_session_id
                       AND s.user_id = v_user.id
                       AND (s.not_after IS NULL OR s.not_after > now()))
    END;
  END IF;

  IF NOT v_eligible THEN
    INSERT INTO app_private.otp_send_events (purpose, recipient_email, client_ip, user_id, actor_user_id, outcome)
    VALUES (p_purpose, v_recipient, p_client_ip, v_user.id, p_actor_user_id, 'ineligible');
    RETURN jsonb_build_object('status', 'ineligible');
  END IF;

  IF p_purpose = 'email_change' THEN
    IF v_new_email = v_user_email THEN
      INSERT INTO app_private.otp_send_events (purpose, recipient_email, client_ip, user_id, outcome)
      VALUES (p_purpose, v_recipient, p_client_ip, v_user.id, 'same_email');
      RETURN jsonb_build_object('status', 'same_email');
    END IF;

    IF EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = v_new_email AND u.id <> v_user.id) THEN
      INSERT INTO app_private.otp_send_events (purpose, recipient_email, client_ip, user_id, outcome)
      VALUES (p_purpose, v_recipient, p_client_ip, v_user.id, 'email_taken');
      RETURN jsonb_build_object('status', 'email_taken');
    END IF;
  END IF;

  -- 7. Cooldown per recipient: one issued code per minute.
  SELECT max(e.created_at) INTO v_edge
    FROM app_private.otp_send_events e
   WHERE e.recipient_email = v_recipient AND e.outcome = 'issued'
     AND e.created_at > now() - c_cooldown;

  IF v_edge IS NOT NULL THEN
    INSERT INTO app_private.otp_send_events (purpose, recipient_email, client_ip, user_id, actor_user_id, outcome)
    VALUES (p_purpose, v_recipient, p_client_ip, v_user.id, p_actor_user_id, 'cooldown');
    RETURN jsonb_build_object('status', 'rate_limited', 'reason', 'cooldown',
      'retry_after_seconds', greatest(1, ceil(extract(epoch FROM v_edge + c_cooldown - now())))::integer);
  END IF;

  -- 8. Hourly limit per recipient.
  SELECT count(*) INTO v_count
    FROM app_private.otp_send_events e
   WHERE e.recipient_email = v_recipient AND e.outcome = 'issued'
     AND e.created_at > now() - c_window;

  IF v_count >= c_email_hourly THEN
    SELECT e.created_at INTO v_edge
      FROM app_private.otp_send_events e
     WHERE e.recipient_email = v_recipient AND e.outcome = 'issued'
       AND e.created_at > now() - c_window
     ORDER BY e.created_at
     OFFSET v_count - c_email_hourly
     LIMIT 1;
    INSERT INTO app_private.otp_send_events (purpose, recipient_email, client_ip, user_id, actor_user_id, outcome)
    VALUES (p_purpose, v_recipient, p_client_ip, v_user.id, p_actor_user_id, 'email_hourly');
    RETURN jsonb_build_object('status', 'rate_limited', 'reason', 'email_hourly',
      'retry_after_seconds', greatest(1, ceil(extract(epoch FROM v_edge + c_window - now())))::integer);
  END IF;

  -- 9. The previous code for this purpose stops working the moment a new one
  --    exists.
  UPDATE app_private.otp_challenges
     SET superseded_at = now()
   WHERE purpose = p_purpose AND user_id = v_user.id
     AND consumed_at IS NULL AND superseded_at IS NULL;

  -- 10. The new challenge and its event.
  v_expires_at := now() + c_validity;

  INSERT INTO app_private.otp_challenges
    (id, purpose, user_id, email, new_email, session_id, code_hash, expires_at, client_ip)
  VALUES
    (p_challenge_id, p_purpose, v_user.id, v_user_email,
     CASE WHEN p_purpose = 'email_change' THEN v_new_email END,
     p_session_id, p_code_hash, v_expires_at, p_client_ip);

  INSERT INTO app_private.otp_send_events
    (purpose, recipient_email, client_ip, user_id, actor_user_id, challenge_id, outcome)
  VALUES
    (p_purpose, v_recipient, p_client_ip, v_user.id, p_actor_user_id, p_challenge_id, 'issued');

  IF p_purpose = 'invite_activate' THEN
    SELECT c.name INTO v_company_name FROM public.companies c WHERE c.id = v_profile.company_id;
  END IF;

  -- 11. Never the hash: the caller already has it, and nothing else should.
  RETURN jsonb_build_object(
    'status',          'issued',
    'challenge_id',    p_challenge_id,
    'user_id',         v_user.id,
    'recipient_email', v_recipient,
    'expires_at',      v_expires_at,
    'full_name',       nullif(v_profile.full_name, ''),
    'company_name',    v_company_name
  );
END;
$$;

-- ─── Ownership and privileges ───────────────────────────────────────────────

ALTER FUNCTION public.platform_staff_add(uuid, text, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_staff_disable(uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_staff_enable(uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION public.otp_issue(uuid, text, text, uuid, text, uuid, text, inet, uuid) OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.platform_staff_add(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_staff_add(uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.platform_staff_disable(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_staff_disable(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.platform_staff_enable(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_staff_enable(uuid) TO authenticated;

-- The service role alone, as 20260915100100 left it.
REVOKE ALL ON FUNCTION public.otp_issue(uuid, text, text, uuid, text, uuid, text, inet, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.otp_issue(uuid, text, text, uuid, text, uuid, text, inet, uuid) TO service_role;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_wrong text;
BEGIN
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
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.anon
                 THEN 'anon EXECUTE should be ' || v.anon
               WHEN has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.authn
                 THEN 'authenticated EXECUTE should be ' || v.authn
               WHEN has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.service
                 THEN 'service_role EXECUTE should be ' || v.service
             END AS problem
        FROM (VALUES
          -- signature                                                          anon   authn  service
          ('public.platform_staff_add(uuid,text,text)',                         false, true,  false),
          ('public.platform_staff_disable(uuid)',                               false, true,  false),
          ('public.platform_staff_enable(uuid)',                                false, true,  false),
          ('public.otp_issue(uuid,text,text,uuid,text,uuid,text,inet,uuid)',    false, false, true)
        ) AS v(sig, anon, authn, service)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916130010 self-check: %', v_wrong;
  END IF;

  -- No path in these functions writes a staff role other than owner: the only
  -- INSERT names 'owner', and enable refuses a non-owner row.
  IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.platform_staff_add(uuid,text,text)'::regprocedure)
       !~ 'VALUES \(p_user_id, ''owner'''
     OR (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.platform_staff_enable(uuid)'::regprocedure)
       !~ 'v_row\.role <> ''owner'''
  THEN
    RAISE EXCEPTION '20260916130010 self-check: a staff function could write a non-owner role before 3.3';
  END IF;
END $$;
