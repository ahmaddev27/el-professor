/*
  # Company signup in one transaction, confirmed by a code

  ## What was wrong

  `company-signup` created the account with `email_confirm: true`, so nobody
  ever proved they owned the address. It then wrote the company, the discount
  redemption, the profile and the settings row as separate service-role calls:

  - a failed company insert left an auth user with no company behind;
  - a failed profile upsert was logged and the signup still reported success,
    leaving an owner who could sign in to nothing;
  - the owner's profile never got the system admin `role_id`;
  - the discount code was redeemed immediately, so a limited code could be
    used up by signups that were never confirmed;
  - the slug suffix came from Math.random and was never re-checked.

  ## What this does instead

  `signup_create_company` writes the company, the owner's profile, the settings
  row and a `pending_signups` row in one transaction. The account stays
  unconfirmed and the profile stays `pending_invite` until the owner enters
  the code; `signup_complete` then activates the profile and redeems the
  discount. `signup_discard` undoes a signup that never got that far, and is
  the only thing the purge calls — it refuses any account that is confirmed,
  or that was never a pending signup (with one narrow exception, below).

  Legacy unconfirmed or company-less accounts in production were never written
  to `pending_signups`. Nothing in this file can delete them.

  Rules as in 20260915100100: plpgsql, SECURITY DEFINER, pinned search_path,
  service_role only, 22023 for a broken argument contract, outcomes as
  return values, no SQLERRM.
*/

-- ─── signup_create_company ──────────────────────────────────────────────────

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
  c_trial_length  CONSTANT interval := interval '14 days';
  c_slug_attempts CONSTANT integer  := 10;

  v_email         text := lower(trim(p_email));
  v_full_name     text := trim(p_full_name);
  v_company_name  text := trim(p_company_name);
  v_ref_code      text := upper(trim(coalesce(p_referral_code, '')));
  v_now           timestamptz := now();
  v_plan          text;
  v_cycle         text;
  v_car_limit     integer;
  v_referral_id   uuid;
  v_ref_active    boolean;
  v_user          record;
  v_base_slug     text;
  v_company       public.companies%ROWTYPE;
  v_admin_role_id uuid;
BEGIN
  IF p_user_id IS NULL
     OR coalesce(v_email, '') = ''
     OR coalesce(v_full_name, '') = ''
     OR coalesce(v_company_name, '') = ''
  THEN
    RAISE EXCEPTION 'signup_create_company: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- 1. The same normalization company-signup applied in TypeScript:
  --    Math.max(1, Math.min(100, Math.floor(Number(x) || 3))) — so 0 and a
  --    missing value both mean 3.
  v_plan      := CASE WHEN p_plan IN ('basic','advanced','premium') THEN p_plan ELSE 'basic' END;
  v_cycle     := CASE WHEN p_billing_cycle = 'yearly' THEN 'yearly' ELSE 'monthly' END;
  v_car_limit := CASE WHEN coalesce(p_car_limit, 0) = 0 THEN 3
                      ELSE greatest(1, least(100, p_car_limit)) END;

  -- 2. Referral, before anything is written.
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

  -- 3. The account company-signup has just created: unconfirmed, the address
  --    the caller named, and not already attached to anything.
  SELECT u.id, u.email, u.email_confirmed_at INTO v_user
    FROM auth.users u
   WHERE u.id = p_user_id;

  IF NOT FOUND
     OR v_user.email_confirmed_at IS NOT NULL
     OR lower(v_user.email) IS DISTINCT FROM v_email
     OR EXISTS (SELECT 1 FROM app_private.pending_signups ps WHERE ps.user_id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.user_profiles up
                 WHERE up.user_id = p_user_id AND (up.company_id IS NOT NULL OR up.is_super_admin))
  THEN
    RAISE EXCEPTION 'signup_create_company: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- 4. Slug: the TypeScript transliteration. Upper-case umlauts are mapped
  --    first because lower() only folds non-ASCII letters under a UTF-8
  --    ctype, while JavaScript's toLowerCase always does.
  v_base_slug := replace(replace(replace(replace(v_company_name, 'Ä', 'ä'), 'Ö', 'ö'), 'Ü', 'ü'), 'ẞ', 'ß');
  v_base_slug := lower(v_base_slug);
  v_base_slug := replace(replace(replace(replace(v_base_slug, 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss');
  v_base_slug := regexp_replace(v_base_slug, '[^a-z0-9]+', '-', 'g');
  v_base_slug := regexp_replace(v_base_slug, '^-|-$', '', 'g');
  v_base_slug := left(v_base_slug, 60);

  -- 5. The company. ON CONFLICT on the slug instead of a look-then-insert, so
  --    two signups with the same name cannot both pick the same free slug.
  FOR i IN 1..c_slug_attempts LOOP
    INSERT INTO public.companies
      (name, slug, status, approval_status, plan, billing_cycle, subscription_car_limit,
       trial_start, trial_end, country, subscription_status,
       referral_id, referral_code_used, referred_at)
    VALUES
      (v_company_name,
       CASE WHEN i = 1 THEN v_base_slug
            ELSE v_base_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6) END,
       'trial', 'pending', v_plan, v_cycle, v_car_limit,
       v_now, v_now + c_trial_length, 'Deutschland', 'inactive',
       v_referral_id,
       CASE WHEN v_referral_id IS NOT NULL THEN v_ref_code END,
       CASE WHEN v_referral_id IS NOT NULL THEN v_now END)
    ON CONFLICT (slug) DO NOTHING
    RETURNING * INTO v_company;

    EXIT WHEN v_company.id IS NOT NULL;
  END LOOP;

  IF v_company.id IS NULL THEN
    RAISE EXCEPTION 'signup_create_company: no free slug';
  END IF;

  -- 6. The owner. pending_invite until the code is entered: an unconfirmed
  --    owner must not count as an active member of anything.
  SELECT r.id INTO v_admin_role_id
    FROM public.roles r
   WHERE r.name = 'admin' AND r.company_id IS NULL
   ORDER BY r.is_system DESC NULLS LAST, r.created_at
   LIMIT 1;

  INSERT INTO public.user_profiles
    (user_id, email, full_name, role, role_id, company_id, is_super_admin, status)
  VALUES
    (p_user_id, v_user.email, v_full_name, 'admin', v_admin_role_id, v_company.id, false, 'pending_invite')
  ON CONFLICT (user_id) DO UPDATE
    SET email          = EXCLUDED.email,
        full_name      = EXCLUDED.full_name,
        role           = EXCLUDED.role,
        role_id        = EXCLUDED.role_id,
        company_id     = EXCLUDED.company_id,
        is_super_admin = false,
        status         = 'pending_invite',
        updated_at     = now();

  -- 7.
  INSERT INTO public.company_settings (company_id, company_name)
  VALUES (v_company.id, v_company_name);

  INSERT INTO app_private.pending_signups (user_id, company_id, discount_code)
  VALUES (p_user_id, v_company.id, nullif(upper(trim(p_discount_code)), ''));

  -- 8.
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

-- ─── signup_complete ────────────────────────────────────────────────────────

-- Called by otp-verify after the code matched and GoTrue confirmed the
-- address. Safe to call twice: the pending row is the "not done yet" marker.
CREATE OR REPLACE FUNCTION public.signup_complete(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_confirmed_at timestamptz;
  v_pending      app_private.pending_signups%ROWTYPE;
  v_company      record;
  v_discount     jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'signup_complete: invalid arguments' USING ERRCODE = '22023';
  END IF;

  SELECT u.email_confirmed_at INTO v_confirmed_at FROM auth.users u WHERE u.id = p_user_id;
  IF v_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'signup_complete: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- The lock serializes two verifications racing for the same signup, so the
  -- discount below is redeemed once.
  SELECT * INTO v_pending
    FROM app_private.pending_signups ps
   WHERE ps.user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'already_completed', true, 'discount', NULL);
  END IF;

  UPDATE public.user_profiles
     SET status = 'active', activated_at = now(), updated_at = now()
   WHERE user_id = p_user_id AND status = 'pending_invite';

  -- A code that no longer applies does not undo the signup; its result is
  -- returned so the client can say so.
  IF v_pending.discount_code IS NOT NULL THEN
    SELECT c.plan, c.billing_cycle, c.subscription_car_limit INTO v_company
      FROM public.companies c
     WHERE c.id = v_pending.company_id;

    v_discount := public.redeem_discount_code(
      v_pending.discount_code, v_pending.company_id,
      v_company.plan, v_company.billing_cycle, v_company.subscription_car_limit
    )::jsonb;
  END IF;

  DELETE FROM app_private.pending_signups WHERE user_id = p_user_id;

  RETURN jsonb_build_object('ok', true, 'company_id', v_pending.company_id, 'discount', v_discount);
END;
$$;

-- ─── signup_discard ─────────────────────────────────────────────────────────

-- Removes a signup that was never confirmed: its company (and, by cascade,
-- the owner's profile, settings and pending row), then the auth user (and, by
-- cascade, its codes and sessions). Returns false and deletes nothing when
-- the account does not qualify.
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
                    WHERE up.user_id = p_user_id AND (up.company_id IS NOT NULL OR up.is_super_admin)) THEN
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

-- ─── signup_discard_unverified ──────────────────────────────────────────────

-- company-signup calls this before createUser. An unconfirmed signup must not
-- be able to squat an address for 24 hours: the newer signup replaces it, and
-- the codes sent for the old one die with it.
CREATE OR REPLACE FUNCTION public.signup_discard_unverified(p_email text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_email     text    := lower(trim(p_email));
  v_user_id   uuid;
  v_discarded boolean := false;
BEGIN
  IF coalesce(v_email, '') = '' THEN
    RAISE EXCEPTION 'signup_discard_unverified: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- Only accounts that are pending signups. The fresh-account exception in
  -- signup_discard is not reachable from here.
  FOR v_user_id IN
    SELECT u.id
      FROM auth.users u
      JOIN app_private.pending_signups ps ON ps.user_id = u.id
     WHERE lower(u.email) = v_email
       AND u.email_confirmed_at IS NULL
  LOOP
    IF public.signup_discard(v_user_id) THEN
      v_discarded := true;
    END IF;
  END LOOP;

  RETURN v_discarded;
END;
$$;

-- ─── purge_unverified_signups ───────────────────────────────────────────────

-- Run daily by deploy/otp-housekeeping.sh. The signup mail promises deletion
-- after 24 hours without confirmation.
CREATE OR REPLACE FUNCTION public.purge_unverified_signups(p_older_than interval DEFAULT interval '24 hours')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- A signup younger than this may still be entering its code: codes live
  -- 10 minutes and five may be requested per hour.
  c_min_age CONSTANT interval := interval '1 hour';

  v_user_id uuid;
  v_count   integer := 0;
BEGIN
  IF p_older_than IS NULL OR p_older_than < c_min_age THEN
    RAISE EXCEPTION 'purge_unverified_signups: invalid arguments' USING ERRCODE = '22023';
  END IF;

  FOR v_user_id IN
    SELECT ps.user_id
      FROM app_private.pending_signups ps
      JOIN auth.users u ON u.id = ps.user_id
     WHERE ps.created_at < now() - p_older_than
       AND u.email_confirmed_at IS NULL
  LOOP
    IF public.signup_discard(v_user_id) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ─── Privileges ─────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.signup_create_company(uuid, text, text, text, text, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signup_create_company(uuid, text, text, text, text, text, integer, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.signup_complete(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signup_complete(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.signup_discard(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signup_discard(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.signup_discard_unverified(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signup_discard_unverified(text) TO service_role;

REVOKE ALL ON FUNCTION public.purge_unverified_signups(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_unverified_signups(interval) TO service_role;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT v.sig, to_regprocedure(v.sig) AS fn
      FROM (VALUES
        ('public.signup_create_company(uuid,text,text,text,text,text,integer,text,text)'),
        ('public.signup_complete(uuid)'),
        ('public.signup_discard(uuid)'),
        ('public.signup_discard_unverified(text)'),
        ('public.purge_unverified_signups(interval)')
      ) AS v(sig)
  LOOP
    IF r.fn IS NULL THEN
      RAISE EXCEPTION '20260915100200 self-check: % does not exist', r.sig;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = r.fn::oid) THEN
      RAISE EXCEPTION '20260915100200 self-check: % is not SECURITY DEFINER', r.sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) AS c(setting)
                    WHERE p.oid = r.fn::oid AND c.setting LIKE 'search_path=%') THEN
      RAISE EXCEPTION '20260915100200 self-check: % has no pinned search_path', r.sig;
    END IF;
    IF has_function_privilege('anon', r.fn::oid, 'EXECUTE')
       OR has_function_privilege('authenticated', r.fn::oid, 'EXECUTE') THEN
      RAISE EXCEPTION '20260915100200 self-check: % is executable by anon or authenticated', r.sig;
    END IF;
    IF NOT has_function_privilege('service_role', r.fn::oid, 'EXECUTE') THEN
      RAISE EXCEPTION '20260915100200 self-check: % is not executable by service_role', r.sig;
    END IF;
  END LOOP;
END $$;
