/*
  Does the permission boundary actually hold?

  Every assertion impersonates a real principal — a JWT claim plus
  `SET LOCAL ROLE authenticated` — so the policies under test are the ones that
  run in production, not a re-description of them. See `_as()` for which claim
  form works here and why the other one silently does not.

  Each check raises on failure; a silent run is a pass. Two habits keep that
  from being hollow:

  - impersonation is verified before anything else, because a NULL `auth.uid()`
    denies everything and would turn every "cannot" assertion into a false pass;
  - each "cannot" on a table has a matching "can" for a permitted role, so a
    malformed statement cannot masquerade as a refusal.

  Two companies, five principals:

    company A   admin_a     role admin
                editor_a    role editor
                viewer_a    role viewer
    company B   admin_b     role admin
    platform    super       owner in app_private.platform_staff, company_id NULL

  and, for the answers a caller without a profile row gets, anon (no JWT) and
  a signed-in account with no user_profiles row.
*/

\set ON_ERROR_STOP on

-- ─── helpers ────────────────────────────────────────────────────────────────

/*
  Become `p_user`.

  `auth.uid()` in this schema reads, in order:

      coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
               (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))

  Only the first form works from here. The JSON variant is what PostgREST sets
  per request; setting it from inside a DO block does not reach the function the
  same way, and auth.uid() comes back NULL — which would make every assertion
  pass for the wrong reason, because a NULL uid matches no tenant and denies
  everything. The singular claim is checked first and is unambiguous.
*/
CREATE OR REPLACE FUNCTION _as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/** Runs `sql` as `p_user` and reports whether it was allowed. */
CREATE OR REPLACE FUNCTION _allowed(p_user uuid, p_sql text) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
  PERFORM _as(p_user);
  EXECUTE p_sql;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RESET ROLE;
  -- RLS does not error on a blocked UPDATE/DELETE, it matches no rows.
  RETURN affected > 0;
EXCEPTION WHEN insufficient_privilege OR check_violation THEN
  RESET ROLE;
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION _check(p_desc text, p_got boolean, p_want boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION 'FAIL: % — expected %, got %', p_desc,
      CASE WHEN p_want THEN 'allowed' ELSE 'denied' END,
      CASE WHEN p_got  THEN 'allowed' ELSE 'denied' END;
  END IF;
  RAISE NOTICE 'ok  %  (%)', p_desc, CASE WHEN p_want THEN 'allowed' ELSE 'denied' END;
END $$;

/*
  Become the caller PostgREST sends for a request without a JWT: no subject
  claim, role anon. auth.uid() is then NULL, which here is the point.
*/
CREATE OR REPLACE FUNCTION _as_anon() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  EXECUTE 'SET LOCAL ROLE anon';
END $$;

/*
  Runs `p_sql` as `p_user`, or as anon when `p_user` is NULL, and reports what
  happened: 'ok', or the SQLSTATE and message it raised. Always rolled back, so
  a call that should have been refused and was not leaves nothing behind.
*/
CREATE OR REPLACE FUNCTION _outcome(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
  v_msg   text;
BEGIN
  IF p_user IS NULL THEN
    PERFORM _as_anon();
  ELSE
    PERFORM _as(p_user);
  END IF;
  EXECUTE p_sql;
  RAISE EXCEPTION USING ERRCODE = 'ZZ001';
EXCEPTION
  WHEN SQLSTATE 'ZZ001' THEN
    RETURN 'ok';
  WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    RETURN v_state || ' ' || v_msg;
END $$;

-- ─── the matrix ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  co_a uuid; co_b uuid;
  admin_a uuid; editor_a uuid; viewer_a uuid; admin_b uuid; super_u uuid;
  drv_a uuid; drv_b uuid;
  n integer;
  -- functions only signed-in screens and the service role call, whose anon
  -- grant 20260915120000 revoked
  signed_in_only constant text[] := ARRAY[
    'public.compute_plan_price(text, integer, text)',
    'public.generate_invoice_number(integer)',
    'public.apply_monthly_planning_run(jsonb)',
    'public.replace_monthly_planning_run(jsonb, uuid)',
    'public.delete_or_archive_monthly_planning_run(uuid)',
    'public.purge_old_monthly_planning_runs(integer, integer)'];
  -- SECURITY DEFINER functions that check their caller themselves and that
  -- only signed-in screens call, whose anon grant 20260915140000 revoked
  guarded_signed_in constant text[] := ARRAY[
    'public.reassign_fahrtenbuch_trip(uuid, uuid, text, text, text, text)',
    'public.revoke_activation_code(uuid)',
    'public.delete_activation_code(uuid)',
    'public.hide_activation_code(uuid, text)',
    'public.update_company_subscription_manual(uuid, text, timestamp with time zone, timestamp with time zone, text, text)'];
  redeem_discount constant text := 'public.redeem_discount_code(text, uuid, text, text, integer)';
BEGIN
  SELECT id INTO co_a FROM companies WHERE slug = 'test-a';
  SELECT id INTO co_b FROM companies WHERE slug = 'test-b';
  SELECT user_id INTO admin_a  FROM user_profiles WHERE email = 'admin-a@test.invalid';
  SELECT user_id INTO editor_a FROM user_profiles WHERE email = 'editor-a@test.invalid';
  SELECT user_id INTO viewer_a FROM user_profiles WHERE email = 'viewer-a@test.invalid';
  SELECT user_id INTO admin_b  FROM user_profiles WHERE email = 'admin-b@test.invalid';
  SELECT user_id INTO super_u  FROM user_profiles WHERE email = 'super@test.invalid';
  SELECT id INTO drv_a FROM drivers WHERE company_id = co_a LIMIT 1;
  SELECT id INTO drv_b FROM drivers WHERE company_id = co_b LIMIT 1;

  -- Guard against the failure mode that would make this whole file worthless:
  -- if impersonation silently does not take, auth.uid() is NULL, every policy
  -- denies, and every "cannot" assertion passes for the wrong reason.
  PERFORM _as(admin_a);
  IF auth.uid() IS DISTINCT FROM admin_a THEN
    RESET ROLE;
    RAISE EXCEPTION 'impersonation is not working: auth.uid() returned % for %, so nothing below would mean anything', auth.uid(), admin_a;
  END IF;
  IF get_user_company_id() IS DISTINCT FROM co_a THEN
    RESET ROLE;
    RAISE EXCEPTION 'get_user_company_id() returned % but admin_a belongs to %', get_user_company_id(), co_a;
  END IF;
  RESET ROLE;
  RAISE NOTICE 'ok  impersonation verified — auth.uid() and get_user_company_id() resolve';

  -- ── tenant isolation ──────────────────────────────────────────────────────
  PERFORM _as(admin_a);
  SELECT count(*) INTO n FROM companies;
  RESET ROLE;
  PERFORM _check('company admin sees exactly one company', n = 1, true);

  PERFORM _as(admin_a);
  SELECT count(*) INTO n FROM drivers WHERE company_id = co_b;
  RESET ROLE;
  PERFORM _check('company A cannot read company B drivers', n = 0, true);

  PERFORM _check('company A cannot UPDATE a company B driver',
    _allowed(admin_a, format('UPDATE drivers SET name = %L WHERE id = %L', 'x-tenant', drv_b)), false);

  PERFORM _check('company A cannot DELETE a company B driver',
    _allowed(admin_a, format('DELETE FROM drivers WHERE id = %L', drv_b)), false);

  PERFORM _check('company A cannot INSERT into company B',
    _allowed(admin_a, format('INSERT INTO drivers (company_id, name) VALUES (%L, %L)', co_b, 'x')), false);

  -- ── viewer: read yes, write no ────────────────────────────────────────────
  PERFORM _as(viewer_a);
  SELECT count(*) INTO n FROM drivers WHERE company_id = co_a;
  RESET ROLE;
  PERFORM _check('viewer can read its own company drivers', n > 0, true);

  PERFORM _check('viewer cannot INSERT drivers',
    _allowed(viewer_a, format('INSERT INTO drivers (company_id, name) VALUES (%L, %L)', co_a, 'v')), false);
  PERFORM _check('viewer cannot UPDATE drivers',
    _allowed(viewer_a, format('UPDATE drivers SET name = %L WHERE id = %L', 'v', drv_a)), false);
  PERFORM _check('viewer cannot DELETE drivers',
    _allowed(viewer_a, format('DELETE FROM drivers WHERE id = %L', drv_a)), false);
  -- Column lists come from information_schema, not from memory: an INSERT that
  -- fails on a missing column would report "denied" and look like a pass.
  PERFORM _check('viewer cannot INSERT receipts',
    _allowed(viewer_a, format(
      'INSERT INTO receipts (company_id, receipt_number, date, description, driver_name) VALUES (%L, %L, current_date, %L, %L)',
      co_a, 'BEL-TEST-1', 'probe', 'Driver A')), false);
  PERFORM _check('viewer cannot INSERT income',
    _allowed(viewer_a, format(
      'INSERT INTO income (company_id, description, amount, type, driver_name) VALUES (%L, %L, 1, %L, %L)',
      co_a, 'probe', 'bar', 'Driver A')), false);
  -- …and the same INSERT must succeed for a role that may edit, or the two
  -- assertions above would pass even if the statement were simply malformed.
  PERFORM _check('admin CAN INSERT receipts (proves the statement itself is valid)',
    _allowed(admin_a, format(
      'INSERT INTO receipts (company_id, receipt_number, date, description, driver_name) VALUES (%L, %L, current_date, %L, %L)',
      co_a, 'BEL-TEST-2', 'probe', 'Driver A')), true);

  -- ── editor: allowed where the matrix says so, refused where it does not ────
  PERFORM _check('editor CAN INSERT drivers (role_permissions drivers.can_edit)',
    _allowed(editor_a, format('INSERT INTO drivers (company_id, name) VALUES (%L, %L)', co_a, 'editor-made')), true);
  PERFORM _check('editor CAN UPDATE drivers',
    _allowed(editor_a, format('UPDATE drivers SET name = %L WHERE id = %L', 'editor-touched', drv_a)), true);
  PERFORM _check('editor cannot UPDATE company_settings (settings.can_edit = false)',
    _allowed(editor_a, format('UPDATE company_settings SET company_name = %L WHERE company_id = %L', 'nope', co_a)), false);

  -- ── admin-only surfaces ───────────────────────────────────────────────────
  PERFORM _check('company admin cannot UPDATE its own companies row',
    _allowed(admin_a, format('UPDATE companies SET plan = %L WHERE id = %L', 'premium', co_a)), false);
  PERFORM _check('company admin CAN UPDATE company_settings',
    _allowed(admin_a, format('UPDATE company_settings SET company_name = %L WHERE company_id = %L', 'renamed', co_a)), true);
  PERFORM _check('viewer cannot UPDATE a colleague profile',
    _allowed(viewer_a, format('UPDATE user_profiles SET full_name = %L WHERE user_id = %L', 'hijack', admin_a)), false);
  PERFORM _check('viewer CAN UPDATE its own profile',
    _allowed(viewer_a, format('UPDATE user_profiles SET full_name = %L WHERE user_id = %L', 'self', viewer_a)), true);

  -- ── the platform account ──────────────────────────────────────────────────
  PERFORM _as(super_u);
  SELECT count(*) INTO n FROM companies;
  RESET ROLE;
  PERFORM _check('super admin sees every company', n >= 2, true);

  PERFORM _check('super admin CAN UPDATE a companies row',
    _allowed(super_u, format('UPDATE companies SET plan = %L WHERE id = %L', 'premium', co_a)), true);
  -- Allowed until 20260917100000 (plan 3.3), and the rule it broke is the one
  -- this file exists to state: a staff role does not write a tenant's
  -- operational data because it is staff. It reads through the audited read
  -- models of 3.6b and, from 3.4, writes inside a logged support session.
  PERFORM _check('super admin cannot UPDATE an operational row in another company',
    _allowed(super_u, format('UPDATE drivers SET name = %L WHERE id = %L', 'support-fix', drv_b)), false);

  -- ── functions anon may not execute ────────────────────────────────────────
  -- Supabase's default privileges grant anon EXECUTE on every function created
  -- in public, and REVOKE … FROM PUBLIC leaves that grant alone. A migration
  -- that drops and recreates one of these functions gives anon its grant back
  -- unless it revokes it again. redeem_discount_code lost authenticated in
  -- 20260911120000 and anon in 20260915110000.
  PERFORM _check(format('anon cannot EXECUTE %s', f), has_function_privilege('anon', f, 'EXECUTE'), false)
     FROM unnest(signed_in_only || guarded_signed_in || redeem_discount) AS f;
  PERFORM _check('a signed-in user cannot EXECUTE redeem_discount_code',
    has_function_privilege('authenticated', redeem_discount, 'EXECUTE'), false);
  -- …and each function stays callable by the role it exists for.
  PERFORM _check('the service role CAN EXECUTE redeem_discount_code',
    has_function_privilege('service_role', redeem_discount, 'EXECUTE'), true);
  PERFORM _check(format('a signed-in user CAN EXECUTE %s', f), has_function_privilege('authenticated', f, 'EXECUTE'), true)
     FROM unnest(signed_in_only || guarded_signed_in) AS f;

  -- ── the super-admin check, for a caller without a profile ─────────────────
  -- is_user_super_admin() answered NULL, not false, to anyone without a
  -- user_profiles row. A policy denies on NULL as on false, but
  -- create_user_profile_manual's `IF NOT is_user_super_admin()` let NULL
  -- through while anon held EXECUTE, so the anon key reached its upsert of any
  -- account's role. Closed by hand on 15.09.2026, then by 20260915130000.
  DECLARE
    no_profile     constant uuid := 'f0000000-0000-4000-8000-000000000404';
    manual_profile constant text := 'public.create_user_profile_manual(uuid, text, text)';
    answer   boolean;
    as_uid   uuid;
    as_role  text;
    outcome  text;
  BEGIN
    IF EXISTS (SELECT 1 FROM user_profiles WHERE user_id = no_profile) THEN
      RAISE EXCEPTION 'user % has a profile, so nothing below would test a caller without one', no_profile;
    END IF;

    -- As with the signed-in principals, prove the impersonation took before
    -- trusting an answer: here that means no subject and the anon role.
    PERFORM _as_anon();
    as_uid  := auth.uid();
    as_role := current_user;
    answer  := is_user_super_admin();
    RESET ROLE;
    IF as_uid IS NOT NULL OR as_role IS DISTINCT FROM 'anon' THEN
      RAISE EXCEPTION 'anonymous impersonation is not working: auth.uid() returned %, current_user was %', as_uid, as_role;
    END IF;
    PERFORM _check('is_user_super_admin() is false, not NULL, for anon', answer IS FALSE, true);

    PERFORM _as(no_profile);
    answer := is_user_super_admin();
    RESET ROLE;
    PERFORM _check('is_user_super_admin() is false, not NULL, for a signed-in caller without a profile', answer IS FALSE, true);

    PERFORM _as(super_u);
    answer := is_user_super_admin();
    RESET ROLE;
    PERFORM _check('is_user_super_admin() is true for the platform owner', answer IS TRUE, true);

    PERFORM _check('anon cannot EXECUTE create_user_profile_manual',
      has_function_privilege('anon', manual_profile, 'EXECUTE'), false);
    PERFORM _check('a signed-in user CAN EXECUTE create_user_profile_manual (its guard decides)',
      has_function_privilege('authenticated', manual_profile, 'EXECUTE'), true);
    PERFORM _check('the service role CAN EXECUTE create_user_profile_manual',
      has_function_privilege('service_role', manual_profile, 'EXECUTE'), true);

    outcome := _outcome(NULL, format('SELECT create_user_profile_manual(%L, %L, %L)', viewer_a, 'anon', 'admin'));
    PERFORM _check(format('anon calling create_user_profile_manual is refused for lack of a grant [%s]', outcome),
      outcome LIKE '42501 permission denied%', true);

    -- Every signed-in caller who is not a super admin meets the guard, with a
    -- profile or without one. The company admin is the strongest of them.
    outcome := _outcome(admin_a, format('SELECT create_user_profile_manual(%L, %L, %L)', viewer_a, 'hijack', 'admin'));
    PERFORM _check(format('a company admin calling create_user_profile_manual gets the exception [%s]', outcome),
      outcome LIKE 'P0001 Access denied: only super admins%', true);
    outcome := _outcome(no_profile, format('SELECT create_user_profile_manual(%L, %L, %L)', no_profile, 'self', 'admin'));
    PERFORM _check(format('a signed-in caller without a profile calling create_user_profile_manual gets the exception [%s]', outcome),
      outcome LIKE 'P0001 Access denied: only super admins%', true);

    -- …and the platform owner still gets through both. What happens after
    -- the guard is not this check's business: the upsert never supplies
    -- user_profiles.email, which is NOT NULL, so today it fails with 23502 for
    -- the super admin as for anyone (recorded in matrix.sql).
    outcome := _outcome(super_u, format('SELECT create_user_profile_manual(%L, %L, %L)', viewer_a, 'Viewer A', 'viewer'));
    PERFORM _check(format('the column super admin passes create_user_profile_manual''s grant and guard [%s]', outcome),
      outcome NOT LIKE '42501%' AND outcome NOT LIKE 'P0001%', true);
  END;

  RAISE NOTICE '── all assertions passed ──';
END $$;
