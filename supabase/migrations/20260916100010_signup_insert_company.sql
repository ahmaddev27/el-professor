/*
  # Company signup: one insert path for the password and the Google signup

  ## Why

  signup_create_company (20260915100200) writes a company, its owner's profile
  and its settings row, then the pending_signups row. The Google signup
  (oauth_signup_create_company, 20260916100020) must write the same three rows
  and differs in one value only, the owner's status: the password owner stays
  pending_invite until the mailed code is entered, while Google has already
  confirmed the address, so the Google owner is active at once.

  Two copies of the slug transliteration, the plan normalization, the trial
  length and the admin role lookup would drift apart. They now live once, in
  app_private.signup_insert_company, and both public functions call it. A later
  change to any of them (plan 3.9 reads the trial length from the settings)
  belongs there.

  ## What signup_create_company keeps

  Its signature, its grants, its checks in the same order, its return values
  and every row it writes:

  - arguments are trimmed and lower-cased as before; a broken contract (no id,
    a blank address, name or company, a confirmed, mismatching or already
    attached account, a second call) raises 22023 before anything is written;
  - an unknown or inactive referral code returns ok:false with the same reason
    and writes nothing;
  - the company is a pending, inactive 14-day trial in Deutschland; the slug is
    the same transliteration, with the same six-hex suffix on a collision;
  - plan, billing cycle and car limit are normalized as company-signup's
    TypeScript does: Math.max(1, Math.min(100, Math.floor(Number(x) || 3)));
  - the owner is admin with the system admin role_id, attached to the company,
    not super admin and pending_invite; an existing profile is updated in place
    and its activated_at is left as it was;
  - company_settings gets the company name, and pending_signups the upper-cased
    discount code, which signup_complete still redeems.

  tests/rls/oauth-signup.sql runs the same signups through a verbatim copy of
  the 20260915100200 function and through this one, and compares the rows.

  One message changes: "no free slug" now names the helper that raises it. It
  takes ten random six-hex collisions in a row, and company-signup handles any
  error from this RPC the same way.

  Rules as in 20260915100100: plpgsql, SECURITY DEFINER, pinned search_path,
  22023 for a broken argument contract, no SQLERRM. The helper lives in
  app_private and nobody holds EXECUTE on it; its SECURITY DEFINER callers reach
  it as its owner.
*/

-- ─── app_private.signup_insert_company ──────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.signup_insert_company(
  p_user_id       uuid,
  p_owner_email   text,     -- the address as auth.users holds it
  p_full_name     text,     -- trimmed by the caller
  p_company_name  text,     -- trimmed by the caller
  p_plan          text,
  p_billing_cycle text,
  p_car_limit     integer,
  p_referral_id   uuid,     -- looked up and checked by the caller, or NULL
  p_referral_code text,     -- the upper-cased code, recorded only with a referral
  p_owner_status  text      -- 'pending_invite': a code is still to come; 'active': the address is proven
)
RETURNS public.companies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_trial_length  CONSTANT interval := interval '14 days';
  c_slug_attempts CONSTANT integer  := 10;

  v_now           timestamptz := now();
  v_plan          text;
  v_cycle         text;
  v_car_limit     integer;
  v_base_slug     text;
  v_company       public.companies%ROWTYPE;
  v_admin_role_id uuid;
BEGIN
  IF p_user_id IS NULL
     OR coalesce(p_owner_email, '') = ''
     OR coalesce(p_full_name, '') = ''
     OR coalesce(p_company_name, '') = ''
     OR p_owner_status IS NULL
     OR p_owner_status NOT IN ('pending_invite', 'active')
  THEN
    RAISE EXCEPTION 'signup_insert_company: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- 1. The same normalization company-signup applies in TypeScript:
  --    Math.max(1, Math.min(100, Math.floor(Number(x) || 3))) — so 0 and a
  --    missing value both mean 3.
  v_plan      := CASE WHEN p_plan IN ('basic','advanced','premium') THEN p_plan ELSE 'basic' END;
  v_cycle     := CASE WHEN p_billing_cycle = 'yearly' THEN 'yearly' ELSE 'monthly' END;
  v_car_limit := CASE WHEN coalesce(p_car_limit, 0) = 0 THEN 3
                      ELSE greatest(1, least(100, p_car_limit)) END;

  -- 2. Slug: the TypeScript transliteration. Upper-case umlauts are mapped
  --    first because lower() only folds non-ASCII letters under a UTF-8
  --    ctype, while JavaScript's toLowerCase always does.
  v_base_slug := replace(replace(replace(replace(p_company_name, 'Ä', 'ä'), 'Ö', 'ö'), 'Ü', 'ü'), 'ẞ', 'ß');
  v_base_slug := lower(v_base_slug);
  v_base_slug := replace(replace(replace(replace(v_base_slug, 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss');
  v_base_slug := regexp_replace(v_base_slug, '[^a-z0-9]+', '-', 'g');
  v_base_slug := regexp_replace(v_base_slug, '^-|-$', '', 'g');
  v_base_slug := left(v_base_slug, 60);

  -- 3. The company. ON CONFLICT on the slug instead of a look-then-insert, so
  --    two signups with the same name cannot both pick the same free slug.
  FOR i IN 1..c_slug_attempts LOOP
    INSERT INTO public.companies
      (name, slug, status, approval_status, plan, billing_cycle, subscription_car_limit,
       trial_start, trial_end, country, subscription_status,
       referral_id, referral_code_used, referred_at)
    VALUES
      (p_company_name,
       CASE WHEN i = 1 THEN v_base_slug
            ELSE v_base_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6) END,
       'trial', 'pending', v_plan, v_cycle, v_car_limit,
       v_now, v_now + c_trial_length, 'Deutschland', 'inactive',
       p_referral_id,
       CASE WHEN p_referral_id IS NOT NULL THEN p_referral_code END,
       CASE WHEN p_referral_id IS NOT NULL THEN v_now END)
    ON CONFLICT (slug) DO NOTHING
    RETURNING * INTO v_company;

    EXIT WHEN v_company.id IS NOT NULL;
  END LOOP;

  IF v_company.id IS NULL THEN
    RAISE EXCEPTION 'signup_insert_company: no free slug';
  END IF;

  -- 4. The owner, as the company's admin. An active owner is activated now; a
  --    pending one keeps whatever activated_at an existing profile had.
  SELECT r.id INTO v_admin_role_id
    FROM public.roles r
   WHERE r.name = 'admin' AND r.company_id IS NULL
   ORDER BY r.is_system DESC NULLS LAST, r.created_at
   LIMIT 1;

  INSERT INTO public.user_profiles AS up
    (user_id, email, full_name, role, role_id, company_id, is_super_admin, status, activated_at)
  VALUES
    (p_user_id, p_owner_email, p_full_name, 'admin', v_admin_role_id, v_company.id, false, p_owner_status,
     CASE WHEN p_owner_status = 'active' THEN v_now END)
  ON CONFLICT (user_id) DO UPDATE
    SET email          = EXCLUDED.email,
        full_name      = EXCLUDED.full_name,
        role           = EXCLUDED.role,
        role_id        = EXCLUDED.role_id,
        company_id     = EXCLUDED.company_id,
        is_super_admin = false,
        status         = p_owner_status,
        activated_at   = CASE WHEN p_owner_status = 'active' THEN v_now ELSE up.activated_at END,
        updated_at     = now();

  -- 5.
  INSERT INTO public.company_settings (company_id, company_name)
  VALUES (v_company.id, p_company_name);

  RETURN v_company;
END;
$$;

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
                 WHERE up.user_id = p_user_id AND (up.company_id IS NOT NULL OR up.is_super_admin))
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

-- ─── Privileges ─────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION app_private.signup_insert_company(uuid, text, text, text, text, text, integer, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- CREATE OR REPLACE keeps the grants 20260915100200 gave; restated so this
-- file's self-check does not depend on an earlier one.
REVOKE ALL ON FUNCTION public.signup_create_company(uuid, text, text, text, text, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signup_create_company(uuid, text, text, text, text, text, integer, text, text) TO service_role;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT v.sig, to_regprocedure(v.sig) AS fn, v.service_role_may
      FROM (VALUES
        ('app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)', false),
        ('public.signup_create_company(uuid,text,text,text,text,text,integer,text,text)',           true)
      ) AS v(sig, service_role_may)
  LOOP
    IF r.fn IS NULL THEN
      RAISE EXCEPTION '20260916100010 self-check: % does not exist', r.sig;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = r.fn::oid) THEN
      RAISE EXCEPTION '20260916100010 self-check: % is not SECURITY DEFINER', r.sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) AS c(setting)
                    WHERE p.oid = r.fn::oid AND c.setting LIKE 'search_path=%') THEN
      RAISE EXCEPTION '20260916100010 self-check: % has no pinned search_path', r.sig;
    END IF;
    IF has_function_privilege('anon', r.fn::oid, 'EXECUTE')
       OR has_function_privilege('authenticated', r.fn::oid, 'EXECUTE') THEN
      RAISE EXCEPTION '20260916100010 self-check: % is executable by anon or authenticated', r.sig;
    END IF;
    IF has_function_privilege('service_role', r.fn::oid, 'EXECUTE') IS DISTINCT FROM r.service_role_may THEN
      RAISE EXCEPTION '20260916100010 self-check: service_role EXECUTE on % should be %', r.sig, r.service_role_may;
    END IF;
  END LOOP;
END $$;
