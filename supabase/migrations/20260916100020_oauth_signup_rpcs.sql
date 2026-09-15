/*
  # Google sign-in (plan step 1.6, PR A): the account RPCs

  Four functions for PR B's oauth-account edge function. They are service_role
  only, and nothing in the running app calls them before PR B and PR C:

  - oauth_signup_create_company    registers the company of a new Google account
  - oauth_session_reconcile        settles an existing account after a Google sign-in
  - oauth_signup_discard           deletes a Google account that never registered
  - purge_abandoned_oauth_signups  deletes those left longer than a day

  ## What GoTrue v2.170.0 has done by the time these run

  A new address: GoTrue inserted the account (marked by the trigger in
  20260916100000), then its google identity, then confirmed the address because
  Google reports it verified. handle_new_user gave it a company-less viewer
  profile in status pending_invite.

  A known address: GoTrue linked a google identity to that same account and
  inserted nothing (DetermineAccountLinking: outside SSO there is one account
  per address). If the account was still unconfirmed, GoTrue also deleted its
  password and its other identities, and confirmed it. An unconfirmed account
  here is a password signup that never entered its code, so after a Google
  sign-in the same user id carries a pending_signups row and a google identity;
  that is what oauth_session_reconcile cancels. "The same address" is always the
  same user id.

  ## What the functions trust

  PR B passes the user id from a verified JWT. Nothing else from the request
  decides anything: the address comes from auth.users, Google's word for it
  from auth.identities, company membership from user_profiles. Whether an
  account is platform staff is asked in one place,
  app_private.oauth_account_is_platform_staff, which plan 3.1 points at
  app_private.platform_staff.

  ## Refusals of oauth_signup_create_company

  A refusal must write nothing, so it raises, with one SQLSTATE per reason in
  class OA, which PostgreSQL does not use and PostgREST passes through as the
  error's code. PR B maps the code, never the message. Checked in this order:

      22023  invalid arguments      no user id, blank owner name or company name
      OA001  account_not_found      no auth user with that id, or it has no address
      OA002  account_blocked        banned, soft-deleted, or a suspended, inactive
                                    or deactivated profile
      OA003  email_not_confirmed
      OA004  not_google_account     no google identity in auth.identities
      OA005  platform_staff
      OA006  company_exists         the account already belongs to a company
      OA007  no_pending_signup      not a Google signup still waiting for its company
      OA008  referral_invalid
      OA009  referral_inactive

  The other three report outcomes as return values. Every function raises 22023
  with a fixed message for a broken argument contract and never returns SQLERRM.

  ## Locks

  Every function that changes an account's signup state locks its auth.users
  row first: NO KEY UPDATE where the account stays, UPDATE where it is deleted.
  Two submissions of the registration form, or a registration racing the purge,
  therefore run one after the other, and the second sees what the first did.
*/

-- ─── app_private.oauth_account_is_platform_staff ────────────────────────────

-- Today staff are marked on user_profiles. Kept in app_private, and out of the
-- public functions, so plan 3.1 changes this body alone and the permission
-- matrix's count of public functions reading that column does not move.
CREATE OR REPLACE FUNCTION app_private.oauth_account_is_platform_staff(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- A NULL id matches no row: false.
  RETURN EXISTS (SELECT 1 FROM public.user_profiles up
                  WHERE up.user_id = p_user_id AND up.is_super_admin);
END;
$$;

-- ─── oauth_signup_create_company ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.oauth_signup_create_company(
  p_user_id       uuid,
  p_full_name     text,
  p_company_name  text,
  p_plan          text,
  p_billing_cycle text,
  p_car_limit     integer,
  p_referral_code text,
  p_discount_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_full_name     text := trim(p_full_name);
  v_company_name  text := trim(p_company_name);
  v_ref_code      text := upper(trim(coalesce(p_referral_code, '')));
  v_discount_code text := nullif(upper(trim(p_discount_code)), '');
  v_user          record;
  v_profile       record;
  v_referral_id   uuid;
  v_ref_active    boolean;
  v_company       public.companies%ROWTYPE;
  v_redemption    jsonb;
BEGIN
  IF p_user_id IS NULL
     OR coalesce(v_full_name, '') = ''
     OR coalesce(v_company_name, '') = ''
  THEN
    RAISE EXCEPTION 'oauth_signup_create_company: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- 1. The account, locked, so the purge cannot delete it halfway and a second
  --    submission waits for this one.
  SELECT u.id, u.email, u.email_confirmed_at, u.banned_until, u.deleted_at INTO v_user
    FROM auth.users u
   WHERE u.id = p_user_id
   FOR NO KEY UPDATE;

  IF NOT FOUND OR coalesce(v_user.email, '') = '' THEN
    RAISE EXCEPTION 'oauth_signup_create_company: account_not_found' USING ERRCODE = 'OA001';
  END IF;

  SELECT up.status, up.company_id INTO v_profile
    FROM public.user_profiles up
   WHERE up.user_id = p_user_id;

  IF (v_user.banned_until IS NOT NULL AND v_user.banned_until > now())
     OR v_user.deleted_at IS NOT NULL
     OR coalesce(v_profile.status NOT IN ('pending_invite', 'active'), false)
  THEN
    RAISE EXCEPTION 'oauth_signup_create_company: account_blocked' USING ERRCODE = 'OA002';
  END IF;

  IF v_user.email_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'oauth_signup_create_company: email_not_confirmed' USING ERRCODE = 'OA003';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.identities i
                  WHERE i.user_id = p_user_id AND i.provider = 'google') THEN
    RAISE EXCEPTION 'oauth_signup_create_company: not_google_account' USING ERRCODE = 'OA004';
  END IF;

  IF app_private.oauth_account_is_platform_staff(p_user_id) THEN
    RAISE EXCEPTION 'oauth_signup_create_company: platform_staff' USING ERRCODE = 'OA005';
  END IF;

  IF v_profile.company_id IS NOT NULL THEN
    RAISE EXCEPTION 'oauth_signup_create_company: company_exists' USING ERRCODE = 'OA006';
  END IF;

  PERFORM 1 FROM app_private.pending_oauth_signups p WHERE p.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'oauth_signup_create_company: no_pending_signup' USING ERRCODE = 'OA007';
  END IF;

  -- 2. Referral, before anything is written.
  IF v_ref_code <> '' THEN
    SELECT r.id, r.is_active INTO v_referral_id, v_ref_active
      FROM public.referrals r
     WHERE r.ref_code = v_ref_code;

    IF v_referral_id IS NULL THEN
      RAISE EXCEPTION 'oauth_signup_create_company: referral_invalid' USING ERRCODE = 'OA008';
    END IF;
    IF NOT v_ref_active THEN
      RAISE EXCEPTION 'oauth_signup_create_company: referral_inactive' USING ERRCODE = 'OA009';
    END IF;
  END IF;

  -- 3. The same rows the password signup writes: the company pending approval,
  --    its settings, and the owner, active at once because Google has proven
  --    the address.
  SELECT * INTO v_company
    FROM app_private.signup_insert_company(
      p_user_id, v_user.email, v_full_name, v_company_name,
      p_plan, p_billing_cycle, p_car_limit,
      v_referral_id, v_ref_code, 'active');

  -- 4. The discount code is redeemed now: there is no code step left to wait
  --    for. A code that no longer applies does not undo the company; its result
  --    is returned, as signup_complete returns it for the password signup.
  --    (Recorded as an open question for the owner in PR A.)
  IF v_discount_code IS NOT NULL THEN
    v_redemption := public.redeem_discount_code(
      v_discount_code, v_company.id,
      v_company.plan, v_company.billing_cycle, v_company.subscription_car_limit
    )::jsonb;
  END IF;

  DELETE FROM app_private.pending_oauth_signups WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'company', jsonb_build_object(
      'id',              v_company.id,
      'name',            v_company.name,
      'slug',            v_company.slug,
      'trial_end',       v_company.trial_end,
      'approval_status', v_company.approval_status
    ),
    'discount', v_redemption
  );
END;
$$;

-- ─── oauth_session_reconcile ────────────────────────────────────────────────

-- Called by PR B after every Google sign-in. Returns
--   {"action": "pending_signup_cancelled", "company_id": ...}
--   {"action": "invite_accepted",          "company_id": ...}
--   {"action": "none", "reason": account_not_found | account_blocked |
--      not_google_account | platform_staff | pending_signup_kept | nothing_pending}
-- pending_signup_kept also names the company it left alone.
CREATE OR REPLACE FUNCTION public.oauth_session_reconcile(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user    record;
  v_profile record;
  v_pending app_private.pending_signups%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'oauth_session_reconcile: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- The account first, then its pending signup: the order signup_discard locks in.
  SELECT u.id, u.email, u.email_confirmed_at, u.banned_until, u.deleted_at INTO v_user
    FROM auth.users u
   WHERE u.id = p_user_id
   FOR NO KEY UPDATE;

  IF NOT FOUND OR coalesce(v_user.email, '') = '' THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'account_not_found');
  END IF;

  IF (v_user.banned_until IS NOT NULL AND v_user.banned_until > now()) OR v_user.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'account_blocked');
  END IF;

  -- Google's verified address is what allows cancelling a signup or accepting
  -- an invitation without the mailed code. Without it, nothing is touched.
  IF v_user.email_confirmed_at IS NULL
     OR NOT EXISTS (SELECT 1 FROM auth.identities i
                     WHERE i.user_id = p_user_id AND i.provider = 'google')
  THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'not_google_account');
  END IF;

  IF app_private.oauth_account_is_platform_staff(p_user_id) THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'platform_staff');
  END IF;

  -- 1. A password signup that never entered its code.
  SELECT * INTO v_pending
    FROM app_private.pending_signups ps
   WHERE ps.user_id = p_user_id
   FOR UPDATE;

  IF FOUND THEN
    -- Approved in the meantime, or holding anyone besides its owner: not a
    -- half-made signup any more, and not ours to delete.
    IF NOT EXISTS (SELECT 1 FROM public.companies c
                    WHERE c.id = v_pending.company_id
                      AND c.approval_status = 'pending'
                      AND c.approved_at IS NULL)
       OR EXISTS (SELECT 1 FROM public.user_profiles up
                   WHERE up.company_id = v_pending.company_id AND up.user_id <> p_user_id)
    THEN
      RETURN jsonb_build_object('action', 'none', 'reason', 'pending_signup_kept',
                                'company_id', v_pending.company_id);
    END IF;

    -- Detach the owner before the company goes: user_profiles.company_id
    -- cascades on delete. The profile is left as handle_new_user leaves a new
    -- Google account's: a viewer in no company.
    UPDATE public.user_profiles
       SET company_id = NULL, role = 'viewer', role_id = NULL,
           status = 'pending_invite', updated_at = now()
     WHERE user_id = p_user_id;

    -- company_settings and the pending_signups row follow by cascade.
    DELETE FROM public.companies WHERE id = v_pending.company_id;

    -- The code mailed for that signup must not complete it later.
    UPDATE app_private.otp_challenges
       SET superseded_at = now()
     WHERE purpose = 'signup_verify' AND user_id = p_user_id
       AND consumed_at IS NULL AND superseded_at IS NULL;

    -- The account may register again, through oauth_signup_create_company,
    -- and is purged like any Google signup if it does not.
    INSERT INTO app_private.pending_oauth_signups (user_id, email)
    VALUES (p_user_id, lower(v_user.email))
    ON CONFLICT (user_id) DO NOTHING;

    RETURN jsonb_build_object('action', 'pending_signup_cancelled', 'company_id', v_pending.company_id);
  END IF;

  -- 2. An employee a company admin invited, who has not accepted yet. The
  --    same columns SetPasswordPage writes when an invitation is accepted.
  SELECT up.status, up.company_id INTO v_profile
    FROM public.user_profiles up
   WHERE up.user_id = p_user_id
   FOR NO KEY UPDATE;

  IF v_profile.status = 'pending_invite' AND v_profile.company_id IS NOT NULL THEN
    UPDATE public.user_profiles
       SET status = 'active', activated_at = now(), must_change_password = false, updated_at = now()
     WHERE user_id = p_user_id;

    -- The invitation code is no longer needed.
    UPDATE app_private.otp_challenges
       SET superseded_at = now()
     WHERE purpose = 'invite_activate' AND user_id = p_user_id
       AND consumed_at IS NULL AND superseded_at IS NULL;

    RETURN jsonb_build_object('action', 'invite_accepted', 'company_id', v_profile.company_id);
  END IF;

  RETURN jsonb_build_object('action', 'none', 'reason', 'nothing_pending');
END;
$$;

-- ─── oauth_signup_discard ───────────────────────────────────────────────────

-- Deletes a Google signup that never registered a company: the account (and,
-- by cascade, its identities, sessions, codes and pending row) and its
-- company-less profile. Returns false and deletes nothing for any other
-- account: no pending row, a company, or platform staff.
CREATE OR REPLACE FUNCTION public.oauth_signup_discard(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'oauth_signup_discard: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- Waits for a registration of the same account that is under way, and then
  -- sees its company.
  PERFORM 1 FROM auth.users u WHERE u.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app_private.pending_oauth_signups p WHERE p.user_id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.user_profiles up
                 WHERE up.user_id = p_user_id AND up.company_id IS NOT NULL)
     OR app_private.oauth_account_is_platform_staff(p_user_id)
  THEN
    RETURN false;
  END IF;

  -- user_profiles.user_id has no foreign key to auth.users, so the profile
  -- does not follow the account by itself.
  DELETE FROM public.user_profiles WHERE user_id = p_user_id;
  DELETE FROM auth.users WHERE id = p_user_id;

  RETURN true;
END;
$$;

-- ─── purge_abandoned_oauth_signups ──────────────────────────────────────────

-- Run daily by deploy/otp-housekeeping.sh.
CREATE OR REPLACE FUNCTION public.purge_abandoned_oauth_signups(p_older_than interval DEFAULT interval '24 hours')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- Younger than this, the owner may still be filling in the registration form.
  c_min_age CONSTANT interval := interval '1 hour';

  v_user_id uuid;
  v_count   integer := 0;
BEGIN
  -- The daily job passes no argument, so the default is the retention: 24
  -- hours, the plan's proposal for the owner's open decision G1.
  IF p_older_than IS NULL OR p_older_than < c_min_age THEN
    RAISE EXCEPTION 'purge_abandoned_oauth_signups: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- oauth_signup_discard re-checks each account under its lock and refuses
  -- anything with a company or on the platform staff.
  FOR v_user_id IN
    SELECT p.user_id
      FROM app_private.pending_oauth_signups p
     WHERE p.created_at < now() - p_older_than
     ORDER BY p.created_at
  LOOP
    IF public.oauth_signup_discard(v_user_id) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ─── Privileges ─────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION app_private.oauth_account_is_platform_staff(uuid) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.oauth_signup_create_company(uuid, text, text, text, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.oauth_signup_create_company(uuid, text, text, text, text, integer, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.oauth_session_reconcile(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.oauth_session_reconcile(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.oauth_signup_discard(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.oauth_signup_discard(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.purge_abandoned_oauth_signups(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_abandoned_oauth_signups(interval) TO service_role;

-- ─── Self-check ─────────────────────────────────────────────────────────────

-- Fails the migration, and with it the release, if any function here came out
-- callable by the browser's roles, callable by the wrong server role, or
-- without a pinned search_path.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT v.sig, to_regprocedure(v.sig) AS fn, v.service_role_may
      FROM (VALUES
        ('app_private.oauth_account_is_platform_staff(uuid)',                                 false),
        ('public.oauth_signup_create_company(uuid,text,text,text,text,integer,text,text)',    true),
        ('public.oauth_session_reconcile(uuid)',                                              true),
        ('public.oauth_signup_discard(uuid)',                                                 true),
        ('public.purge_abandoned_oauth_signups(interval)',                                    true)
      ) AS v(sig, service_role_may)
  LOOP
    IF r.fn IS NULL THEN
      RAISE EXCEPTION '20260916100020 self-check: % does not exist', r.sig;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = r.fn::oid) THEN
      RAISE EXCEPTION '20260916100020 self-check: % is not SECURITY DEFINER', r.sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) AS c(setting)
                    WHERE p.oid = r.fn::oid AND c.setting LIKE 'search_path=%') THEN
      RAISE EXCEPTION '20260916100020 self-check: % has no pinned search_path', r.sig;
    END IF;
    IF has_function_privilege('anon', r.fn::oid, 'EXECUTE')
       OR has_function_privilege('authenticated', r.fn::oid, 'EXECUTE') THEN
      RAISE EXCEPTION '20260916100020 self-check: % is executable by anon or authenticated', r.sig;
    END IF;
    IF has_function_privilege('service_role', r.fn::oid, 'EXECUTE') IS DISTINCT FROM r.service_role_may THEN
      RAISE EXCEPTION '20260916100020 self-check: service_role EXECUTE on % should be %', r.sig, r.service_role_may;
    END IF;
  END LOOP;
END $$;
