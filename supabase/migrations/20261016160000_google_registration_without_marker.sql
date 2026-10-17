/*
  A Google sign-in by an account that has no company may register one
  (owner's report, 16.10.2026: "there is a problem with sign-in after I deleted
  a company ... especially if I registered with Google").

  ## What was measured

  oauth_signup_create_company refused with OA007 no_pending_signup unless
  app_private.pending_oauth_signups held a row for the account. That row is
  written by one trigger, AFTER INSERT on auth.users, for an account GoTrue
  creates with provider google. When the address already exists as an e-mail
  account GoTrue links the Google identity to that row and inserts nothing, so
  the trigger never fires and the account can never register: staging held 0
  marker rows, and two accounts in exactly that shape (an e-mail account, no
  profile, left behind by a company deletion that predates 20261016140000).

  ## The two shapes weighed, and the one taken

  (a) Widen the marker: also mark an existing account when it gains a Google
      identity. Rejected, for two reasons.
      1. The marker has a second meaning that matters more than the first: it
         is what purge_abandoned_oauth_signups and oauth_signup_discard are
         allowed to DELETE. Marking an established e-mail account on linking
         would make it deletable 24 hours later if its owner closed the tab on
         the registration form. The marker's own header says why it is narrow:
         the ones nobody finished, and nothing else.
      2. A trigger on auth.identities, or a wider one on auth.users, runs
         inside GoTrue's transaction. The present one is a single INSERT ... ON
         CONFLICT DO NOTHING with no lookup precisely because anything that can
         raise there fails every Google sign-in. "Does this account already
         belong to a company" is a lookup.
  (b) Stop asking for the marker where it carries no weight. Taken.
      Everything the marker was standing in for is checked by the function
      itself, under the account's row lock, before anything is written: the
      account exists with an address (OA001), is not banned, deleted or in a
      profile status other than pending_invite or active (OA002), has a
      confirmed address (OA003) and a google identity (OA004), is not platform
      staff (OA005) and has no company (OA006). "No company" is the real
      condition for "may register one"; the marker only ever restated it for
      accounts GoTrue had just created. The registration screen is reached by
      needsCompanyRegistration (no profile, or a company-less one), which never
      consulted the marker either.

  ## What changes, and what deliberately does not

  Only oauth_signup_create_company, restated from 20260916100020 with the
  marker lookup (and so the OA007 branch) removed; every other line is carried
  over. Its end still deletes the marker, which is a no-op for an account that
  never had one. The auth.users lock taken at the top is what serialises two
  submissions of the form, not the marker row's.

  - The trigger, the marker table, oauth_session_reconcile, oauth_signup_discard
    and the purge are untouched: an unmarked account is never purged, so this
    adds no way to lose an account. Closing the form leaves it as it was.
  - OA007 is no longer raised. oauth-account-core.ts and the browser still map
    it, harmlessly; removing a code from a contract two layers read is a
    separate change.
  - Additive: no SCHEMA_EPOCH bump. The previous release calls the function
    with the same arguments and gets the same answers, except that the one
    refusal it could not otherwise justify for this case is gone.
*/

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

-- Same grants as 20260916100020: service_role only.
REVOKE ALL ON FUNCTION public.oauth_signup_create_company(uuid, text, text, text, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.oauth_signup_create_company(uuid, text, text, text, text, integer, text, text) TO service_role;

-- ─── Self-check ─────────────────────────────────────────────────────────────

-- Reads the catalogue, never stored data. The kit (tests/rls/oauth-signup.sql)
-- runs the behaviour; this fails a release that restates the function again
-- and loses a refusal, or brings the marker back.
DO $$
DECLARE
  v_fn   oid := to_regprocedure('public.oauth_signup_create_company(uuid,text,text,text,text,integer,text,text)');
  v_src  text;
  v_frag text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION '20261016160000 self-check: oauth_signup_create_company does not exist';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_fn;

  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn)
     OR NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) AS c(setting)
                     WHERE p.oid = v_fn AND c.setting LIKE 'search_path=%') THEN
    RAISE EXCEPTION '20261016160000 self-check: oauth_signup_create_company is not SECURITY DEFINER with a pinned search_path';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '20261016160000 self-check: oauth_signup_create_company must be executable by service_role alone';
  END IF;

  -- The marker is not a precondition any more ...
  IF position('no_pending_signup' IN v_src) > 0
     OR position('FROM app_private.pending_oauth_signups p' IN v_src) > 0 THEN
    RAISE EXCEPTION '20261016160000 self-check: oauth_signup_create_company asks for the marker again';
  END IF;

  -- ... and every refusal that stood in for it is still there, each with its own code.
  FOREACH v_frag IN ARRAY ARRAY[
    'ERRCODE = ''OA001''', 'ERRCODE = ''OA002''', 'ERRCODE = ''OA003''', 'ERRCODE = ''OA004''',
    'ERRCODE = ''OA005''', 'ERRCODE = ''OA006''', 'ERRCODE = ''OA008''', 'ERRCODE = ''OA009''',
    'banned_until > now()', 'v_user.deleted_at IS NOT NULL',
    'NOT IN (''pending_invite'', ''active'')',
    'i.provider = ''google''',
    'app_private.oauth_account_is_platform_staff(p_user_id)',
    'v_profile.company_id IS NOT NULL',
    'FOR NO KEY UPDATE',
    'DELETE FROM app_private.pending_oauth_signups WHERE user_id = p_user_id'
  ] LOOP
    IF position(v_frag IN v_src) = 0 THEN
      RAISE EXCEPTION '20261016160000 self-check: oauth_signup_create_company lost %', v_frag;
    END IF;
  END LOOP;
END $$;
