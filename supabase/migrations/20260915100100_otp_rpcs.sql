/*
  # One-time codes: the functions that issue, verify and expire them

  The edge functions (otp-request, otp-verify, company-signup, manage-users)
  generate the code, compute its HMAC with OTP_PEPPER and mail it. The database
  never sees the pepper or the code, only the hash. Everything that must be
  atomic — limits, supersede, attempt counting, consumption — happens here,
  under a lock, in one transaction.

  ## Limits (declared once, as CONSTANTs in the function that enforces them)

      validity                10 minutes         otp_issue
      cooldown per address    60 seconds         otp_issue
      codes per address       5 per hour         otp_issue
      requests per client IP  20 per hour        otp_issue
      wrong attempts          5 per code         otp_verify (also bounds the CHECK on attempts)
      platform verification   12 hours           otp_verify

  ## Rules every function here follows

  - LANGUAGE plpgsql, so references to auth.users and auth.sessions resolve at
    call time. The RLS test database has no GoTrue tables until the test
    creates stubs; a LANGUAGE sql body would fail to create there.
  - SECURITY DEFINER with search_path pinned to pg_catalog, public;
    app_private.* and auth.* always schema-qualified.
  - EXECUTE revoked from PUBLIC, anon and authenticated, granted to
    service_role only. 20260911120000 revoked from authenticated but not anon;
    this file does not repeat that.
  - Expected outcomes are jsonb return values, never exceptions. otp_verify in
    particular must *return* a wrong-code result, because an exception would
    roll back the attempt counter it just incremented.
  - A caller that breaks the argument contract gets ERRCODE 22023 with a fixed
    message. No SQLERRM is ever returned and there is no EXCEPTION WHEN OTHERS.
*/

-- ─── otp_issue ──────────────────────────────────────────────────────────────

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

  SELECT up.status, up.company_id, up.is_super_admin, up.full_name
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
            coalesce(v_profile.is_super_admin, false)
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

COMMENT ON FUNCTION public.otp_issue(uuid, text, text, uuid, text, uuid, text, inet, uuid) IS
  'Issues a one-time code for a purpose: IP limit, account and eligibility check, cooldown and hourly limit per recipient, supersede, insert. Takes the HMAC, never the code.';

-- ─── otp_mark_send_failed ───────────────────────────────────────────────────

-- A code that never reached the mailbox must not block the next attempt: it
-- is closed, and its event stops counting toward the cooldown and the hourly
-- limit. It still counts toward the IP limit, which reads every outcome.
CREATE OR REPLACE FUNCTION public.otp_mark_send_failed(p_challenge_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_challenge_id IS NULL THEN
    RAISE EXCEPTION 'otp_mark_send_failed: invalid arguments' USING ERRCODE = '22023';
  END IF;

  UPDATE app_private.otp_challenges
     SET superseded_at = now()
   WHERE id = p_challenge_id
     AND consumed_at IS NULL AND superseded_at IS NULL;

  UPDATE app_private.otp_send_events
     SET outcome = 'send_failed'
   WHERE challenge_id = p_challenge_id AND outcome = 'issued';
END;
$$;

-- ─── otp_open_challenge ─────────────────────────────────────────────────────

-- The open challenge (not consumed, not superseded — possibly expired or
-- locked, which otp_verify reports) for an address or an account.
--
-- Public purposes are looked up by the typed address, authenticated purposes
-- by the JWT's user id, and nothing else is accepted: a caller bug can then
-- never let someone reach an email_change or platform_login challenge with
-- just an address and no token.
CREATE OR REPLACE FUNCTION public.otp_open_challenge(p_purpose text, p_email text, p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_public boolean := p_purpose IN ('signup_verify','password_reset','invite_activate');
  v_email  text    := lower(trim(p_email));
  v_id     uuid;
BEGIN
  IF p_purpose IS NULL
     OR p_purpose NOT IN ('signup_verify','password_reset','invite_activate','email_change','platform_login')
     OR (p_email IS NOT NULL) = (p_user_id IS NOT NULL)
     OR (v_public AND coalesce(v_email, '') = '')
     OR (NOT v_public AND p_user_id IS NULL)
  THEN
    RAISE EXCEPTION 'otp_open_challenge: invalid arguments' USING ERRCODE = '22023';
  END IF;

  IF v_public THEN
    SELECT c.id INTO v_id
      FROM app_private.otp_challenges c
     WHERE c.purpose = p_purpose AND c.email = v_email
       AND c.consumed_at IS NULL AND c.superseded_at IS NULL
     ORDER BY c.created_at DESC
     LIMIT 1;
  ELSE
    SELECT c.id INTO v_id
      FROM app_private.otp_challenges c
     WHERE c.purpose = p_purpose AND c.user_id = p_user_id
       AND c.consumed_at IS NULL AND c.superseded_at IS NULL;
  END IF;

  RETURN v_id;
END;
$$;

-- ─── otp_verify ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.otp_verify(
  p_challenge_id uuid,
  p_purpose      text,
  p_code_hash    text,
  p_session_id   uuid     -- platform_login: the caller's JWT session_id. Otherwise NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_max_attempts      CONSTANT integer  := 5;
  c_platform_validity CONSTANT interval := interval '12 hours';

  v_ch             app_private.otp_challenges%ROWTYPE;
  v_attempts       integer;
  v_verified_until timestamptz;
BEGIN
  IF p_challenge_id IS NULL
     OR p_purpose IS NULL
     OR p_purpose NOT IN ('signup_verify','password_reset','invite_activate','email_change','platform_login')
     OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
     OR (p_purpose = 'platform_login') <> (p_session_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'otp_verify: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- The row lock is what makes "five attempts" mean five: without it, parallel
  -- guesses would all read attempts = 0 and all be allowed.
  SELECT * INTO v_ch
    FROM app_private.otp_challenges
   WHERE id = p_challenge_id
   FOR UPDATE;

  -- 1.
  IF NOT FOUND OR v_ch.purpose <> p_purpose
     OR v_ch.consumed_at IS NOT NULL OR v_ch.superseded_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- 2. Checked before counting: an expired code is not a guess.
  IF now() >= v_ch.expires_at THEN
    RETURN jsonb_build_object('status', 'expired');
  END IF;

  -- 3.
  IF v_ch.attempts >= c_max_attempts THEN
    RETURN jsonb_build_object('status', 'locked');
  END IF;

  -- 4. A code for one platform session cannot verify another.
  IF p_purpose = 'platform_login' THEN
    IF p_session_id <> v_ch.session_id THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.sessions s
                    WHERE s.id = v_ch.session_id
                      AND s.user_id = v_ch.user_id
                      AND (s.not_after IS NULL OR s.not_after > now())) THEN
      RETURN jsonb_build_object('status', 'session_invalid');
    END IF;
  END IF;

  -- 5. Counted before the comparison and kept whatever it finds. This is why
  --    a wrong code is a return value: an exception would roll the count back.
  UPDATE app_private.otp_challenges
     SET attempts = attempts + 1
   WHERE id = v_ch.id
  RETURNING attempts INTO v_attempts;

  -- 6.
  IF v_ch.code_hash <> p_code_hash THEN
    IF v_attempts >= c_max_attempts THEN
      RETURN jsonb_build_object('status', 'locked');
    END IF;
    RETURN jsonb_build_object('status', 'wrong', 'attempts_left', c_max_attempts - v_attempts);
  END IF;

  -- 7. The address was free when the code was sent; someone may have taken it
  --    since. Closing the challenge means the same code cannot be retried.
  IF p_purpose = 'email_change'
     AND EXISTS (SELECT 1 FROM auth.users u
                  WHERE lower(u.email) = v_ch.new_email AND u.id <> v_ch.user_id) THEN
    UPDATE app_private.otp_challenges SET superseded_at = now() WHERE id = v_ch.id;
    RETURN jsonb_build_object('status', 'email_taken');
  END IF;

  -- 8.
  UPDATE app_private.otp_challenges SET consumed_at = now() WHERE id = v_ch.id;

  IF p_purpose = 'platform_login' THEN
    v_verified_until := now() + c_platform_validity;

    INSERT INTO app_private.platform_login_verifications
      (session_id, user_id, challenge_id, verified_at, expires_at)
    VALUES
      (v_ch.session_id, v_ch.user_id, v_ch.id, now(), v_verified_until)
    ON CONFLICT (session_id) DO UPDATE
      SET user_id      = EXCLUDED.user_id,
          challenge_id = EXCLUDED.challenge_id,
          verified_at  = EXCLUDED.verified_at,
          expires_at   = EXCLUDED.expires_at;
  END IF;

  -- 9.
  RETURN jsonb_build_object(
    'status',                  'ok',
    'purpose',                 v_ch.purpose,
    'user_id',                 v_ch.user_id,
    'email',                   v_ch.email,
    'new_email',               v_ch.new_email,
    'platform_verified_until', v_verified_until
  );
END;
$$;

COMMENT ON FUNCTION public.otp_verify(uuid, text, text, uuid) IS
  'Checks a code hash against a locked challenge: not_found, expired, locked, session_invalid, wrong (attempt counted), email_taken, or ok (consumed).';

-- ─── platform_login_verified ────────────────────────────────────────────────

-- Only ever called from is_user_super_admin() (PLATFORM, Phase 3.2), whose
-- owner may call it without a grant. Returns false rather than raising on
-- missing arguments, because it will sit inside RLS predicates where an
-- exception would break every query a super admin runs.
CREATE OR REPLACE FUNCTION app_private.platform_login_verified(p_user_id uuid, p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_user_id IS NULL OR p_session_id IS NULL THEN
    RETURN false;
  END IF;

  -- The session must still exist: signing out ends the verification with it.
  RETURN EXISTS (
    SELECT 1
      FROM app_private.platform_login_verifications v
      JOIN auth.sessions s ON s.id = v.session_id AND s.user_id = v.user_id
     WHERE v.session_id = p_session_id
       AND v.user_id    = p_user_id
       AND v.expires_at > now()
       AND (s.not_after IS NULL OR s.not_after > now())
  );
END;
$$;

-- ─── user_profiles.email follows auth.users.email ───────────────────────────

-- AccountPage.tsx:96 wrote the profile's address itself, and manage-users
-- /update changed the auth address without touching the profile, so the two
-- drifted. One trigger now covers every path that changes an address,
-- including otp-verify's email_change.
CREATE OR REPLACE FUNCTION public.sync_user_profile_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- user_profiles.email is NOT NULL; an account losing its address keeps the
  -- last one on the profile rather than failing GoTrue's update.
  IF NEW.email IS NOT NULL THEN
    UPDATE public.user_profiles
       SET email = NEW.email, updated_at = now()
     WHERE user_id = NEW.id
       AND email IS DISTINCT FROM NEW.email;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS sync_user_profile_email ON auth.users;
CREATE TRIGGER sync_user_profile_email
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW
  WHEN (NEW.email IS DISTINCT FROM OLD.email)
  EXECUTE FUNCTION public.sync_user_profile_email();

-- ─── otp_purge ──────────────────────────────────────────────────────────────

-- Run hourly by deploy/otp-housekeeping.sh.
CREATE OR REPLACE FUNCTION public.otp_purge(p_older_than interval DEFAULT interval '24 hours')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- Anything younger may still be read: open codes live 10 minutes and the
  -- send limits look back one hour. Purging inside that window would reset
  -- the limits.
  c_min_age CONSTANT interval := interval '1 hour';

  v_challenges    integer;
  v_events        integer;
  v_verifications integer;
BEGIN
  IF p_older_than IS NULL OR p_older_than < c_min_age THEN
    RAISE EXCEPTION 'otp_purge: invalid arguments' USING ERRCODE = '22023';
  END IF;

  DELETE FROM app_private.otp_challenges WHERE created_at < now() - p_older_than;
  GET DIAGNOSTICS v_challenges = ROW_COUNT;

  DELETE FROM app_private.otp_send_events WHERE created_at < now() - p_older_than;
  GET DIAGNOSTICS v_events = ROW_COUNT;

  DELETE FROM app_private.platform_login_verifications WHERE expires_at < now() - p_older_than;
  GET DIAGNOSTICS v_verifications = ROW_COUNT;

  RETURN jsonb_build_object('challenges', v_challenges, 'events', v_events, 'verifications', v_verifications);
END;
$$;

-- ─── Privileges ─────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.otp_issue(uuid, text, text, uuid, text, uuid, text, inet, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.otp_issue(uuid, text, text, uuid, text, uuid, text, inet, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.otp_mark_send_failed(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.otp_mark_send_failed(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.otp_open_challenge(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.otp_open_challenge(text, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.otp_verify(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.otp_verify(uuid, text, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.otp_purge(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.otp_purge(interval) TO service_role;

-- Fired by GoTrue's updates, never called: triggers do not check EXECUTE.
REVOKE ALL ON FUNCTION public.sync_user_profile_email() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION app_private.platform_login_verified(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ─── Self-check ─────────────────────────────────────────────────────────────

-- Fails the migration, and with it the release, if any function here came out
-- callable by the browser's roles or without a pinned search_path.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT v.sig, to_regprocedure(v.sig) AS fn, v.service_role_may
      FROM (VALUES
        ('public.otp_issue(uuid,text,text,uuid,text,uuid,text,inet,uuid)', true),
        ('public.otp_mark_send_failed(uuid)',                              true),
        ('public.otp_open_challenge(text,text,uuid)',                      true),
        ('public.otp_verify(uuid,text,text,uuid)',                         true),
        ('public.otp_purge(interval)',                                     true),
        ('public.sync_user_profile_email()',                               false),
        ('app_private.platform_login_verified(uuid,uuid)',                 false)
      ) AS v(sig, service_role_may)
  LOOP
    IF r.fn IS NULL THEN
      RAISE EXCEPTION '20260915100100 self-check: % does not exist', r.sig;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = r.fn::oid) THEN
      RAISE EXCEPTION '20260915100100 self-check: % is not SECURITY DEFINER', r.sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) AS c(setting)
                    WHERE p.oid = r.fn::oid AND c.setting LIKE 'search_path=%') THEN
      RAISE EXCEPTION '20260915100100 self-check: % has no pinned search_path', r.sig;
    END IF;
    IF has_function_privilege('anon', r.fn::oid, 'EXECUTE')
       OR has_function_privilege('authenticated', r.fn::oid, 'EXECUTE') THEN
      RAISE EXCEPTION '20260915100100 self-check: % is executable by anon or authenticated', r.sig;
    END IF;
    IF has_function_privilege('service_role', r.fn::oid, 'EXECUTE') IS DISTINCT FROM r.service_role_may THEN
      RAISE EXCEPTION '20260915100100 self-check: service_role EXECUTE on % should be %', r.sig, r.service_role_may;
    END IF;
  END LOOP;
END $$;
