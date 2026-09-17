/*
  Two tenants and five principals, the smallest set that can tell tenant
  isolation apart from role enforcement. Loaded into a throwaway database; it
  writes as `supabase_admin`, so RLS does not apply while seeding.

  Fixed UUIDs so a failure names a row you can look up rather than a random id.
*/

\set ON_ERROR_STOP on

-- GoTrue is not running here, so these rows go in directly. Only `id` is
-- load-bearing: every policy reaches a user through user_profiles.user_id, and
-- auth.uid() returns the `sub` claim. The column list is kept to id + email
-- because the fixture was dumped with --schema=public, so auth.users carries
-- only what the foreign keys needed.
INSERT INTO auth.users (id, email)
VALUES
  ('a0000000-0000-4000-8000-000000000001', 'admin-a@test.invalid'),
  ('a0000000-0000-4000-8000-000000000002', 'editor-a@test.invalid'),
  ('a0000000-0000-4000-8000-000000000003', 'viewer-a@test.invalid'),
  ('b0000000-0000-4000-8000-000000000001', 'admin-b@test.invalid'),
  ('50000000-0000-4000-8000-000000000001', 'super@test.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
VALUES
  ('c0000000-0000-4000-8000-00000000000a', 'Test A', 'test-a', 'approved', 'active', 'basic', 'active'),
  ('c0000000-0000-4000-8000-00000000000b', 'Test B', 'test-b', 'approved', 'active', 'basic', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO company_settings (company_id, company_name)
VALUES
  ('c0000000-0000-4000-8000-00000000000a', 'Test A'),
  ('c0000000-0000-4000-8000-00000000000b', 'Test B')
ON CONFLICT (company_id) DO NOTHING;

-- role_id is what current_role_permits() resolves; the text role is the
-- fallback for legacy rows. Both are set so the test exercises the primary path.
INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id,
                           is_super_admin, status, must_change_password)
SELECT v.user_id, v.email, v.full_name, v.role,
       (SELECT id FROM roles WHERE name = v.role AND company_id IS NULL LIMIT 1),
       v.company_id, v.is_super, 'active', false
FROM (VALUES
  ('a0000000-0000-4000-8000-000000000001'::uuid, 'admin-a@test.invalid',  'Admin A',  'admin',  'c0000000-0000-4000-8000-00000000000a'::uuid, false),
  ('a0000000-0000-4000-8000-000000000002'::uuid, 'editor-a@test.invalid', 'Editor A', 'editor', 'c0000000-0000-4000-8000-00000000000a'::uuid, false),
  ('a0000000-0000-4000-8000-000000000003'::uuid, 'viewer-a@test.invalid', 'Viewer A', 'viewer', 'c0000000-0000-4000-8000-00000000000a'::uuid, false),
  ('b0000000-0000-4000-8000-000000000001'::uuid, 'admin-b@test.invalid',  'Admin B',  'admin',  'c0000000-0000-4000-8000-00000000000b'::uuid, false),
  ('50000000-0000-4000-8000-000000000001'::uuid, 'super@test.invalid',    'Platform', 'admin',  NULL, true)
) AS v(user_id, email, full_name, role, company_id, is_super)
ON CONFLICT (user_id) DO NOTHING;

-- The platform principal is an owner through app_private.platform_staff. Since
-- 20260916110010 the profile flag above grants nothing by itself; it only
-- routes the browser, and the staff row keeps it in step.
INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES ('50000000-0000-4000-8000-000000000001', 'owner', 'rls seed')
ON CONFLICT (user_id) DO NOTHING;

-- one driver per tenant, so a cross-tenant write has a real target to miss
INSERT INTO drivers (id, company_id, name)
VALUES
  ('d0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-00000000000a', 'Driver A'),
  ('d0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-00000000000b', 'Driver B')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE n_missing int;
BEGIN
  SELECT count(*) INTO n_missing FROM user_profiles
   WHERE email LIKE '%@test.invalid' AND role_id IS NULL AND is_super_admin = false;
  IF n_missing > 0 THEN
    RAISE EXCEPTION 'seed: % test profiles have no role_id — the system roles are missing, so current_role_permits() would deny everything and the results would be meaningless', n_missing;
  END IF;
END $$;
