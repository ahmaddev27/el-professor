/*
  # Every platform check asks platform_staff, never the profile flag

  Plan 3.1. Builds on 20260916110000, which created the staff table, the
  capability matrix and the helpers used here.

  ## What was wrong

  Platform rights were decided by reading `user_profiles.is_super_admin`:

  - fifteen policies, on activation_codes, activation_code_attempts,
    discount_codes, discount_code_redemptions, referrals and
    subscription_admin_actions;
  - is_user_super_admin(), which every other platform policy calls;
  - delete_activation_code, hide_activation_code, revoke_activation_code and
    update_company_subscription_manual;
  - otp_issue (platform_login eligibility), signup_create_company and
    signup_discard;
  - enforce_user_profile_privilege_guard, which also let a platform account
    move any profile into any company and grant the flag to anyone.

  ## What this does

  - is_user_super_admin() keeps its signature and grants. It is true when the
    caller holds an active staff row, and false, never NULL, for anyone else
    (20260915130000's rule). Platform sign-in stays an address and a password
    (the owner's decision of 16.09.2026), so nothing more is asked here.
  - The fifteen policies keep their names, commands and roles, and ask
    platform_can(): codes.manage on the code and referral tables, billing.manage
    on subscription_admin_actions. Owners hold both, so nothing changes for any
    account that exists today. Direct table reads are deliberately not opened
    to read_only: plan 3.D gives staff audited read functions instead.
  - The four platform RPCs ask codes.manage or billing.manage. Their bodies are
    otherwise unchanged; they gain a pinned search_path, and anon loses
    EXECUTE, since only signed-in screens call them.
  - otp_issue: platform_login is eligible for an account with an active staff
    row.
  - app_private.oauth_account_is_platform_staff, which 20260916100020 created so
    that 3.1 changes one body, reads platform_staff: any staff row, a disabled
    one included. That is the conservative reading: nobody has decided whether
    a former staff member may sign a company up. The Google signup functions
    ask it already; signup_create_company (with 20260916100010's body, which
    writes through app_private.signup_insert_company) and signup_discard now ask
    it instead of reading the flag.
  - public.account_is_platform_staff(user_id), service role only, asks the same
    for manage-users, which refuses a company admin on any account with a staff
    row, even one whose profile sits in the admin's company.
  - enforce_user_profile_privilege_guard: a JWT without a subject (the anon
    key) writes no profile at all, and no JWT changes a profile's user_id. An
    authenticated JWT can no longer change company_id at all, and can set
    is_super_admin only to what platform_staff already says, which is exactly
    what the sync trigger writes. A company admin's exceptions for role and
    status no longer reach a profile with a staff row. The platform exceptions to the other rules now need a capability:
    company_users.manage to insert another user's profile or change a role,
    company_users.manage or companies.lifecycle to change a status (a company
    suspension does). The service role, GoTrue and migrations stay unguarded.
    The company-admin exceptions are now NULL-safe: for a caller without a
    company their comparison was NULL, the IF fell through, and a company-less
    profile with the admin role could change its own role and status. Platform
    accounts are exactly such profiles, so this had to close with them.

  ## Ownership

  The functions dumped from production belong to `postgres`. That role is not a
  superuser, and the app_private helpers grant EXECUTE to nobody, so it cannot
  call them. A SECURITY DEFINER function runs as its owner: left with that
  owner, a rewritten is_user_super_admin() would fail inside every policy that
  calls it. Each function rewritten here is therefore handed to the role running
  the migrations, which owns app_private. The self-check fails the release if a
  SECURITY DEFINER function that references app_private belongs to anyone but a
  superuser or the schema's owner.

  ## Compatibility

  Backward compatible, no SCHEMA_EPOCH bump. No signature changes. The previous
  release reads the column, which 20260916110000 keeps in step, and every check
  here answers the same for an owner as the column did.
*/

-- ─── is_user_super_admin ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_user_super_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN app_private.platform_staff_role_of(auth.uid()) IS NOT NULL;
END;
$$;

ALTER FUNCTION public.is_user_super_admin() OWNER TO CURRENT_USER;

-- ─── The profile privilege guard ────────────────────────────────────────────

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
  caller_platform  text;
  staff_flag       boolean;
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

  SELECT company_id, role
    INTO caller_company, caller_role_text
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
    --   * a company admin on a target profile in the SAME company that is not a
    --     platform account (no staff row, a disabled one included)
    -- coalesce(): for a caller without a company the comparison is NULL, and
    -- NOT NULL let the whole condition fall through without raising.
    IF (NEW.role_id IS DISTINCT FROM OLD.role_id
        OR NEW.role     IS DISTINCT FROM OLD.role)
       AND NOT app_private.platform_role_can(caller_platform, 'company_users.manage')
       AND NOT coalesce(
            caller_role_text = 'admin'
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
    --   * a company admin on a target profile in the SAME company that is not a
    --     platform account (no staff row, a disabled one included)
    --   * the user themselves, but ONLY to complete the invite flow
    --     ('pending_invite' -> 'active', SetPasswordPage.tsx)
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT app_private.platform_role_can(caller_platform, 'company_users.manage')
       AND NOT app_private.platform_role_can(caller_platform, 'companies.lifecycle')
       AND NOT coalesce(
            caller_role_text = 'admin'
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

-- ─── The platform RPCs of the code and subscription screens ─────────────────

CREATE OR REPLACE FUNCTION public.delete_activation_code(p_code_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_code      public.activation_codes%ROWTYPE;
BEGIN
  IF NOT public.platform_can('codes.manage') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert');
  END IF;

  SELECT * INTO v_code FROM public.activation_codes WHERE id = p_code_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Code nicht gefunden');
  END IF;
  IF v_code.used_at IS NOT NULL OR v_code.used_company_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Verwendete Codes können nicht gelöscht werden');
  END IF;
  IF v_code.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Code wurde bereits gelöscht');
  END IF;

  UPDATE public.activation_codes
     SET deleted_at = now(), deleted_by = v_caller_id
   WHERE id = p_code_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.hide_activation_code(p_code_id uuid, p_reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
BEGIN
  IF NOT public.platform_can('codes.manage') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.activation_codes WHERE id = p_code_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Code nicht gefunden');
  END IF;

  UPDATE public.activation_codes
     SET hidden_at = now(), hidden_by = v_caller_id, hidden_reason = p_reason
   WHERE id = p_code_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_activation_code(p_code_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_code      public.activation_codes%ROWTYPE;
BEGIN
  IF NOT public.platform_can('codes.manage') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert');
  END IF;

  SELECT * INTO v_code FROM public.activation_codes WHERE id = p_code_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Code nicht gefunden');
  END IF;
  IF v_code.status <> 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nur aktive Codes können widerrufen werden');
  END IF;
  IF v_code.used_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Verwendete Codes können nicht widerrufen werden');
  END IF;

  UPDATE public.activation_codes
     SET status = 'revoked', revoked_at = now(), revoked_by = v_caller_id
   WHERE id = p_code_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_company_subscription_manual(
  p_company_id                 uuid,
  p_subscription_status        text,
  p_subscription_started_at    timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_subscription_expires_at    timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_subscription_duration_type text DEFAULT NULL::text,
  p_reason                     text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller_id        uuid := auth.uid();
  v_company          public.companies%ROWTYPE;
  v_allowed_statuses text[] := ARRAY['inactive','active','expired','suspended'];
BEGIN
  IF NOT public.platform_can('billing.manage') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert');
  END IF;

  IF p_subscription_status <> ALL(v_allowed_statuses) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Ungültiger Abo-Status');
  END IF;

  SELECT * INTO v_company FROM public.companies WHERE id = p_company_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unternehmen nicht gefunden');
  END IF;

  INSERT INTO public.subscription_admin_actions
    (company_id, action_type, old_status, new_status, old_expires_at, new_expires_at, reason, created_by)
  VALUES
    (p_company_id, 'manual_edit',
     v_company.subscription_status, p_subscription_status,
     v_company.subscription_expires_at, p_subscription_expires_at,
     p_reason, v_caller_id);

  UPDATE public.companies
     SET subscription_status        = p_subscription_status,
         subscription_started_at    = COALESCE(p_subscription_started_at, subscription_started_at),
         subscription_expires_at    = p_subscription_expires_at,
         subscription_duration_type = COALESCE(p_subscription_duration_type, subscription_duration_type),
         updated_at                 = now()
   WHERE id = p_company_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

ALTER FUNCTION public.delete_activation_code(uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION public.hide_activation_code(uuid, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.revoke_activation_code(uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION public.update_company_subscription_manual(uuid, text, timestamptz, timestamptz, text, text) OWNER TO CURRENT_USER;

-- ─── otp_issue: platform_login eligibility ──────────────────────────────────

-- Unchanged from 20260915100100 except the profile SELECT and the
-- platform_login case.
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
        AND v_profile.company_id IS NOT NULL
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

ALTER FUNCTION public.otp_issue(uuid, text, text, uuid, text, uuid, text, inet, uuid) OWNER TO CURRENT_USER;

-- ─── Signup refuses platform accounts by their staff row ────────────────────

-- Whether an account is platform staff, for every signup path: the Google
-- signup functions of 20260916100020 and, below, signup_create_company and
-- signup_discard. 20260916100020 kept this question in one app_private body so
-- that this file changes only that body. Any staff row counts, a disabled one
-- included: nobody has decided whether a former staff member may sign a company
-- up, so the conservative reading holds until then.
CREATE OR REPLACE FUNCTION app_private.oauth_account_is_platform_staff(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- A NULL id matches no row: false.
  RETURN EXISTS (SELECT 1 FROM app_private.platform_staff s WHERE s.user_id = p_user_id);
END;
$$;

-- The same question for manage-users, which acts for a company admin with the
-- service role. An account with a staff row, a disabled one included, belongs
-- to the platform: a company admin must not set its address or password, even
-- when its profile sits in the admin's company, or the admin could sign in as a
-- platform owner. Service role only: it answers about any account.
CREATE OR REPLACE FUNCTION public.account_is_platform_staff(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN coalesce(app_private.oauth_account_is_platform_staff(p_user_id), false);
END;
$$;

-- The body of 20260916100010, which writes the company, the owner and the
-- settings through the shared app_private.signup_insert_company, with one
-- change: the account check asks oauth_account_is_platform_staff instead of
-- reading the profile flag.
CREATE OR REPLACE FUNCTION public.signup_create_company(
  p_user_id       uuid,
  p_email         text,
  p_full_name     text,
  p_company_name  text,
  p_plan          text,
  p_billing_cycle text,
  p_car_limit     integer,
  p_referral_code text,
  p_discount_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_email         text := lower(trim(p_email));
  v_full_name     text := trim(p_full_name);
  v_company_name  text := trim(p_company_name);
  v_ref_code      text := upper(trim(coalesce(p_referral_code, '')));
  v_referral_id   uuid;
  v_ref_active    boolean;
  v_user          record;
  v_company       public.companies%ROWTYPE;
BEGIN
  IF p_user_id IS NULL
     OR coalesce(v_email, '') = ''
     OR coalesce(v_full_name, '') = ''
     OR coalesce(v_company_name, '') = ''
  THEN
    RAISE EXCEPTION 'signup_create_company: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- 1. Referral, before anything is written. (Plan, cycle and car limit are
  --    normalized by signup_insert_company.)
  IF v_ref_code <> '' THEN
    SELECT r.id, r.is_active INTO v_referral_id, v_ref_active
      FROM public.referrals r
     WHERE r.ref_code = v_ref_code;

    IF v_referral_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'referral_invalid');
    END IF;
    IF NOT v_ref_active THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'referral_inactive');
    END IF;
  END IF;

  -- 2. The account company-signup has just created: unconfirmed, the address
  --    the caller named, and not already attached to anything.
  SELECT u.id, u.email, u.email_confirmed_at INTO v_user
    FROM auth.users u
   WHERE u.id = p_user_id;

  IF NOT FOUND
     OR v_user.email_confirmed_at IS NOT NULL
     OR lower(v_user.email) IS DISTINCT FROM v_email
     OR EXISTS (SELECT 1 FROM app_private.pending_signups ps WHERE ps.user_id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.user_profiles up
                 WHERE up.user_id = p_user_id AND up.company_id IS NOT NULL)
     -- Platform staff, asked where the Google signup asks it.
     OR app_private.oauth_account_is_platform_staff(p_user_id)
  THEN
    RAISE EXCEPTION 'signup_create_company: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- 3. The company, the owner and the settings, shared with the Google signup.
  --    The owner stays pending_invite until the code is entered: an
  --    unconfirmed owner must not count as an active member of anything.
  SELECT * INTO v_company
    FROM app_private.signup_insert_company(
      p_user_id, v_user.email, v_full_name, v_company_name,
      p_plan, p_billing_cycle, p_car_limit,
      v_referral_id, v_ref_code, 'pending_invite');

  -- 4.
  INSERT INTO app_private.pending_signups (user_id, company_id, discount_code)
  VALUES (p_user_id, v_company.id, nullif(upper(trim(p_discount_code)), ''));

  -- 5.
  RETURN jsonb_build_object(
    'ok', true,
    'company', jsonb_build_object(
      'id',              v_company.id,
      'name',            v_company.name,
      'slug',            v_company.slug,
      'trial_end',       v_company.trial_end,
      'approval_status', v_company.approval_status
    )
  );
END;
$$;


-- Unchanged from 20260915100200 except the platform check in the
-- fresh-account branch.
CREATE OR REPLACE FUNCTION public.signup_discard(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- company-signup calls this to compensate when signup_create_company fails
  -- right after createUser. Such an account has no pending row yet; its age
  -- is what separates it from a legacy account.
  c_fresh_account CONSTANT interval := interval '1 hour';

  v_user        record;
  v_pending     app_private.pending_signups%ROWTYPE;
  v_has_pending boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'signup_discard: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- Locking the auth row serializes this against a concurrent confirmation:
  -- a user confirmed a moment ago must not be deleted.
  SELECT u.id, u.email_confirmed_at, u.created_at INTO v_user
    FROM auth.users u
   WHERE u.id = p_user_id
   FOR UPDATE;

  IF NOT FOUND OR v_user.email_confirmed_at IS NOT NULL THEN
    RETURN false;
  END IF;

  SELECT * INTO v_pending
    FROM app_private.pending_signups ps
   WHERE ps.user_id = p_user_id
   FOR UPDATE;
  v_has_pending := FOUND;

  IF v_has_pending THEN
    -- A pending company holds only its owner. Anyone else in it means this is
    -- not the signup it looks like; delete nothing.
    IF EXISTS (SELECT 1 FROM public.user_profiles up
                WHERE up.company_id = v_pending.company_id AND up.user_id <> p_user_id) THEN
      RETURN false;
    END IF;
  ELSIF v_user.created_at IS NULL
        OR v_user.created_at <= now() - c_fresh_account
        OR EXISTS (SELECT 1 FROM public.user_profiles up
                    WHERE up.user_id = p_user_id AND up.company_id IS NOT NULL)
        -- Platform staff, asked where every signup path asks it.
        OR app_private.oauth_account_is_platform_staff(p_user_id) THEN
    RETURN false;
  END IF;

  IF v_has_pending THEN
    DELETE FROM public.companies WHERE id = v_pending.company_id;
  END IF;

  -- user_profiles.user_id has no foreign key to auth.users, so the profile
  -- does not follow the user by itself.
  DELETE FROM public.user_profiles WHERE user_id = p_user_id;
  DELETE FROM auth.users WHERE id = p_user_id;

  RETURN true;
END;
$$;

ALTER FUNCTION public.signup_create_company(uuid, text, text, text, text, text, integer, text, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.signup_discard(uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.oauth_account_is_platform_staff(uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION public.account_is_platform_staff(uuid) OWNER TO CURRENT_USER;

-- ─── The fifteen policies ───────────────────────────────────────────────────

-- Names, commands and roles as before. (SELECT …) lets the planner evaluate
-- the helper once per statement instead of once per row, as 20260912110000
-- does for the other helpers.

DROP POLICY IF EXISTS sa_select_activation_codes ON public.activation_codes;
CREATE POLICY sa_select_activation_codes ON public.activation_codes
  FOR SELECT TO authenticated
  USING ((SELECT public.platform_can('codes.manage')));

DROP POLICY IF EXISTS sa_insert_activation_codes ON public.activation_codes;
CREATE POLICY sa_insert_activation_codes ON public.activation_codes
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.platform_can('codes.manage')));

DROP POLICY IF EXISTS sa_update_activation_codes ON public.activation_codes;
CREATE POLICY sa_update_activation_codes ON public.activation_codes
  FOR UPDATE TO authenticated
  USING ((SELECT public.platform_can('codes.manage')))
  WITH CHECK ((SELECT public.platform_can('codes.manage')));

DROP POLICY IF EXISTS sa_delete_activation_codes ON public.activation_codes;
CREATE POLICY sa_delete_activation_codes ON public.activation_codes
  FOR DELETE TO authenticated
  USING ((SELECT public.platform_can('codes.manage')));

DROP POLICY IF EXISTS sa_select_attempts ON public.activation_code_attempts;
CREATE POLICY sa_select_attempts ON public.activation_code_attempts
  FOR SELECT TO authenticated
  USING ((SELECT public.platform_can('codes.manage')));

DROP POLICY IF EXISTS "SuperAdmins can manage discount codes" ON public.discount_codes;
CREATE POLICY "SuperAdmins can manage discount codes" ON public.discount_codes
  FOR SELECT TO authenticated
  USING ((SELECT public.platform_can('codes.manage')));

DROP POLICY IF EXISTS "SuperAdmins can insert discount codes" ON public.discount_codes;
CREATE POLICY "SuperAdmins can insert discount codes" ON public.discount_codes
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.platform_can('codes.manage')));

DROP POLICY IF EXISTS "SuperAdmins can update discount codes" ON public.discount_codes;
CREATE POLICY "SuperAdmins can update discount codes" ON public.discount_codes
  FOR UPDATE TO authenticated
  USING ((SELECT public.platform_can('codes.manage')))
  WITH CHECK ((SELECT public.platform_can('codes.manage')));

DROP POLICY IF EXISTS "SuperAdmins can delete discount codes" ON public.discount_codes;
CREATE POLICY "SuperAdmins can delete discount codes" ON public.discount_codes
  FOR DELETE TO authenticated
  USING ((SELECT public.platform_can('codes.manage')));

DROP POLICY IF EXISTS "SuperAdmins can view all redemptions" ON public.discount_code_redemptions;
CREATE POLICY "SuperAdmins can view all redemptions" ON public.discount_code_redemptions
  FOR SELECT TO authenticated
  USING ((SELECT public.platform_can('codes.manage')));

DROP POLICY IF EXISTS super_admin_select_referrals ON public.referrals;
CREATE POLICY super_admin_select_referrals ON public.referrals
  FOR SELECT TO authenticated
  USING ((SELECT public.platform_can('codes.manage')));

DROP POLICY IF EXISTS super_admin_insert_referrals ON public.referrals;
CREATE POLICY super_admin_insert_referrals ON public.referrals
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.platform_can('codes.manage')));

DROP POLICY IF EXISTS super_admin_update_referrals ON public.referrals;
CREATE POLICY super_admin_update_referrals ON public.referrals
  FOR UPDATE TO authenticated
  USING ((SELECT public.platform_can('codes.manage')))
  WITH CHECK ((SELECT public.platform_can('codes.manage')));

DROP POLICY IF EXISTS super_admin_delete_referrals ON public.referrals;
CREATE POLICY super_admin_delete_referrals ON public.referrals
  FOR DELETE TO authenticated
  USING ((SELECT public.platform_can('codes.manage')));

DROP POLICY IF EXISTS super_admin_all_subscription_admin_actions ON public.subscription_admin_actions;
CREATE POLICY super_admin_all_subscription_admin_actions ON public.subscription_admin_actions
  FOR ALL TO authenticated
  USING ((SELECT public.platform_can('billing.manage')))
  WITH CHECK ((SELECT public.platform_can('billing.manage')));

-- ─── Privileges ─────────────────────────────────────────────────────────────

-- Signed-in platform screens call these four; nobody calls them anonymously.
REVOKE ALL ON FUNCTION public.delete_activation_code(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_activation_code(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.hide_activation_code(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hide_activation_code(uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.revoke_activation_code(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_activation_code(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.update_company_subscription_manual(uuid, text, timestamptz, timestamptz, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_company_subscription_manual(uuid, text, timestamptz, timestamptz, text, text) TO authenticated, service_role;

-- Fired by a trigger, never called: triggers do not check EXECUTE.
REVOKE ALL ON FUNCTION public.enforce_user_profile_privilege_guard() FROM PUBLIC, anon, authenticated, service_role;

-- CREATE OR REPLACE keeps the grants 20260916100020 gave (none); restated so
-- this file's self-check does not depend on an earlier one. Its SECURITY
-- DEFINER callers reach it as its owner.
REVOKE ALL ON FUNCTION app_private.oauth_account_is_platform_staff(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- manage-users calls it with the service role; nobody else.
REVOKE ALL ON FUNCTION public.account_is_platform_staff(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.account_is_platform_staff(uuid) TO service_role;

-- is_user_super_admin() keeps the grants it had: RLS policies call it, so
-- anon's EXECUTE stays, and it answers false without a session.

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_wrong text;
BEGIN
  -- 1. The functions rewritten here: SECURITY DEFINER, a pinned search_path,
  --    an owner that can reach app_private, and the stated EXECUTE grants.
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
          -- signature                                                                              anon   authn  service
          ('public.is_user_super_admin()',                                                          true,  true,  true),
          ('public.enforce_user_profile_privilege_guard()',                                         false, false, false),
          ('public.delete_activation_code(uuid)',                                                   false, true,  true),
          ('public.hide_activation_code(uuid,text)',                                                false, true,  true),
          ('public.revoke_activation_code(uuid)',                                                   false, true,  true),
          ('public.update_company_subscription_manual(uuid,text,timestamptz,timestamptz,text,text)', false, true, true),
          ('public.otp_issue(uuid,text,text,uuid,text,uuid,text,inet,uuid)',                        false, false, true),
          ('public.signup_create_company(uuid,text,text,text,text,text,integer,text,text)',         false, false, true),
          ('public.signup_discard(uuid)',                                                           false, false, true),
          ('app_private.oauth_account_is_platform_staff(uuid)',                                     false, false, false),
          ('public.account_is_platform_staff(uuid)',                                                false, false, true)
        ) AS v(sig, anon, authn, service)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916110010 self-check: %', v_wrong;
  END IF;

  -- 2. Nothing reads the flag any more, except the guard (which compares its
  --    old and new value), the trigger that keeps it in step, and
  --    signup_insert_company, which writes false for the owner it creates (its
  --    callers refuse platform staff first) and reads nothing.
  SELECT string_agg(s.what, ', ' ORDER BY s.what) INTO v_wrong
    FROM (
      SELECT format('policy %s.%s "%s"', p.schemaname, p.tablename, p.policyname) AS what
        FROM pg_policies p
       WHERE (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ '(^|[^a-z_])is_super_admin([^a-z_]|$)'
      UNION ALL
      SELECT format('function %s', p.oid::regprocedure)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND p.prosrc ~ '(^|[^a-z_])is_super_admin([^a-z_]|$)'
         AND p.oid NOT IN ('public.enforce_user_profile_privilege_guard()'::regprocedure,
                           'app_private.platform_staff_sync_profile()'::regprocedure,
                           'app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)'::regprocedure)
      UNION ALL
      SELECT format('view %s.%s', v.schemaname, v.viewname)
        FROM pg_views v
       WHERE v.schemaname NOT IN ('pg_catalog', 'information_schema')
         AND v.definition ~ '(^|[^a-z_])is_super_admin([^a-z_]|$)'
    ) s;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916110010 self-check: still reads user_profiles.is_super_admin: %', v_wrong;
  END IF;

  -- 3. A SECURITY DEFINER function runs as its owner. The app_private helpers
  --    grant EXECUTE to nobody, so one that references app_private works only
  --    for the schema's owner or a superuser. Any other owner fails at call
  --    time, inside every policy that calls it. (USAGE is not the test:
  --    postgres has it through pg_read_all_data, and still cannot call them.)
  SELECT string_agg(p.oid::regprocedure::text || ' owned by ' || r.rolname, ', ') INTO v_wrong
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND p.prosecdef
     AND p.prosrc ~ 'app_private\.'
     AND NOT r.rolsuper
     AND r.oid <> (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916110010 self-check: owner cannot reach app_private: %', v_wrong;
  END IF;

  -- 4. Every capability a policy or function names exists in the matrix; a
  --    typo would otherwise deny silently, for everyone.
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
    RAISE EXCEPTION '20260916110010 self-check: unknown capability named: %', v_wrong;
  END IF;

  -- 5. The fifteen policies exist and each asks platform_can().
  IF (SELECT count(*)
        FROM pg_policies p
       WHERE p.schemaname = 'public'
         AND (p.tablename, p.policyname) IN (
               ('activation_codes', 'sa_select_activation_codes'),
               ('activation_codes', 'sa_insert_activation_codes'),
               ('activation_codes', 'sa_update_activation_codes'),
               ('activation_codes', 'sa_delete_activation_codes'),
               ('activation_code_attempts', 'sa_select_attempts'),
               ('discount_codes', 'SuperAdmins can manage discount codes'),
               ('discount_codes', 'SuperAdmins can insert discount codes'),
               ('discount_codes', 'SuperAdmins can update discount codes'),
               ('discount_codes', 'SuperAdmins can delete discount codes'),
               ('discount_code_redemptions', 'SuperAdmins can view all redemptions'),
               ('referrals', 'super_admin_select_referrals'),
               ('referrals', 'super_admin_insert_referrals'),
               ('referrals', 'super_admin_update_referrals'),
               ('referrals', 'super_admin_delete_referrals'),
               ('subscription_admin_actions', 'super_admin_all_subscription_admin_actions'))
         AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'platform_can\(') <> 15 THEN
    RAISE EXCEPTION '20260916110010 self-check: the fifteen platform policies are not all in place';
  END IF;
END $$;
