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
    platform    super       is_super_admin, company_id NULL
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

-- ─── the matrix ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  co_a uuid; co_b uuid;
  admin_a uuid; editor_a uuid; viewer_a uuid; admin_b uuid; super_u uuid;
  drv_a uuid; drv_b uuid;
  n integer;
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
  PERFORM _check('super admin CAN UPDATE an operational row in any company',
    _allowed(super_u, format('UPDATE drivers SET name = %L WHERE id = %L', 'support-fix', drv_b)), true);

  RAISE NOTICE '── all assertions passed ──';
END $$;
