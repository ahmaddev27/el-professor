/*
  Deleting a company completely (20261016140000): who may, what is refused,
  what goes, what is kept, and that the preview and the deletion agree.

  Runs after assertions.sql and the matrix, as supabase_admin, in one
  transaction rolled back at the end, so the files after it see the seeds only.

  What the kit CANNOT test, said once: auth.users here is a stub the fixture
  carries only so foreign keys resolve, and GoTrue and the storage API are not
  running. The function removes login accounts and stored files after the
  database part, with the service role; that half is covered by
  supabase/functions/_shared/company-delete-core.test.ts (which accounts, in
  which order, what is kept) and by the read-only measurement on staging, never
  by a deletion. What this file proves is the database half: the company and
  every table it owns go, nothing of another company moves, platform staff
  accounts are listed as kept and never as removed, and the plan the function
  hands back is the plan the preview showed.

    1. grants          anon and the service role hold no EXECUTE
    2. role x RPC      only an owner; every other role and a company admin is
                       refused, and the refusal is recorded
    3. refusals        wrong name, active company, unknown company, nulls: each
                       with its reason, and nothing changed
    4. open context    a view and a support context both make the guard refuse,
                       answered as a sentence, nothing changed
    5. preview == run  the preview, then the deletion: the same counts, the
                       same accounts, the same files
    6. what went       every table the catalogue lists is empty for the company,
                       the tables with no foreign key included; a table added
                       today is picked up without being named anywhere
    7. what stayed     another company, its accounts, platform staff, the
                       records that are kept on purpose
    8. audit           one row for the deletion, ids and counts, no address
    9. a leftover      a row the deletion cannot remove rolls everything back
   10. finalized data  a company that finalized a month, confirmed a monthly
                       plan and paid a salary can still be deleted
*/

\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS banned_until       timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at         timestamptz,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS auth.sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  not_after  timestamptz
);

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _cd_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _cd_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

CREATE OR REPLACE FUNCTION _cd_become(p_user uuid, p_service boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _cd_reset();
  IF p_service THEN
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
  ELSIF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
  ELSE
    PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
    -- the owner's sign-in session, which a platform context is tied to
    PERFORM set_config('request.jwt.claim.session_id', '3d000000-0000-4000-8000-0000000000aa', true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
END $$;

/** Runs p_sql as the principal in a subtransaction that is always rolled back. */
CREATE OR REPLACE FUNCTION _cd_try(p_user uuid, p_sql text, p_service boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text; v_state text; v_msg text;
BEGIN
  BEGIN
    PERFORM _cd_become(p_user, p_service);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
    RAISE EXCEPTION USING ERRCODE = 'ZZ005', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ005' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _cd_reset();
  RETURN v_out;
END $$;

/** Like _cd_try, but keeps what the statement did when it succeeds. */
CREATE OR REPLACE FUNCTION _cd_do(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text; v_state text; v_msg text;
BEGIN
  BEGIN
    PERFORM _cd_become(p_user);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _cd_reset();
  RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION _cd_yn(p_answer text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  IF p_answer LIKE 'ERR 42501 permission denied%' THEN RETURN 'P'; END IF;
  IF p_answer LIKE 'ERR%' THEN RETURN p_answer; END IF;
  RETURN CASE WHEN (p_answer::jsonb ->> 'success') = 'true' THEN 'Y' ELSE 'N' END;
EXCEPTION WHEN OTHERS THEN
  RETURN p_answer;
END $$;

CREATE OR REPLACE FUNCTION _cd_reason(p_answer text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN p_answer::jsonb ->> 'reason';
EXCEPTION WHEN OTHERS THEN
  RETURN p_answer;
END $$;

-- ─── principals ─────────────────────────────────────────────────────────────

/*
    3d..01 owner      platform owner, no company
    3d..03 support    platform support
    3d..04 billing    platform billing
    3d..05 readonly   platform read_only
    3d..06 staff-in   platform SUPPORT account whose profile sits inside the
                      company being deleted: must be kept
    3d..11 admin-t    company admin of the company being deleted
    3d..12 viewer-t   ordinary member
    3d..13 invitee-t  member who never activated
    b000..01 admin-b  admin of the other seeded company (Test B): must not move
*/
INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('3d000000-0000-4000-8000-000000000001', 'cd-owner@test.invalid',    now()),
  ('3d000000-0000-4000-8000-000000000003', 'cd-support@test.invalid',  now()),
  ('3d000000-0000-4000-8000-000000000004', 'cd-billing@test.invalid',  now()),
  ('3d000000-0000-4000-8000-000000000005', 'cd-readonly@test.invalid', now()),
  ('3d000000-0000-4000-8000-000000000006', 'cd-staff-in@test.invalid', now()),
  ('3d000000-0000-4000-8000-000000000011', 'cd-admin-t@test.invalid',  now()),
  ('3d000000-0000-4000-8000-000000000012', 'cd-viewer-t@test.invalid', now()),
  ('3d000000-0000-4000-8000-000000000013', 'cd-invitee-t@test.invalid', now());

INSERT INTO auth.sessions (id, user_id) VALUES ('3d000000-0000-4000-8000-0000000000aa', '3d000000-0000-4000-8000-000000000001');

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status) VALUES
  ('c0000000-0000-4000-8000-0000000000e1', 'CD Ziel GmbH',  'cd-ziel',  'approved', 'deleted', 'basic', 'inactive'),
  ('c0000000-0000-4000-8000-0000000000e2', 'CD Aktiv GmbH', 'cd-aktiv', 'approved', 'active',  'basic', 'active'),
  ('c0000000-0000-4000-8000-0000000000e3', 'CD Rest GmbH',  'cd-rest',  'approved', 'deleted', 'basic', 'inactive');

INSERT INTO user_profiles (user_id, email, full_name, role, company_id, is_super_admin, status) VALUES
  ('3d000000-0000-4000-8000-000000000001', 'cd-owner@test.invalid',    'CD Owner',    'viewer', NULL, false, 'active'),
  ('3d000000-0000-4000-8000-000000000003', 'cd-support@test.invalid',  'CD Support',  'viewer', NULL, false, 'active'),
  ('3d000000-0000-4000-8000-000000000004', 'cd-billing@test.invalid',  'CD Billing',  'viewer', NULL, false, 'active'),
  ('3d000000-0000-4000-8000-000000000005', 'cd-readonly@test.invalid', 'CD Read',     'viewer', NULL, false, 'active'),
  ('3d000000-0000-4000-8000-000000000006', 'cd-staff-in@test.invalid', 'CD Staff In', 'viewer',
     'c0000000-0000-4000-8000-0000000000e1', false, 'active'),
  ('3d000000-0000-4000-8000-000000000011', 'cd-admin-t@test.invalid',  'CD Admin T',  'admin',
     'c0000000-0000-4000-8000-0000000000e1', false, 'active'),
  ('3d000000-0000-4000-8000-000000000012', 'cd-viewer-t@test.invalid', 'CD Viewer T', 'viewer',
     'c0000000-0000-4000-8000-0000000000e1', false, 'active'),
  ('3d000000-0000-4000-8000-000000000013', 'cd-invitee-t@test.invalid', 'CD Invitee T', 'viewer',
     'c0000000-0000-4000-8000-0000000000e1', false, 'pending_invite');

INSERT INTO app_private.platform_staff (user_id, role, note) VALUES
  ('3d000000-0000-4000-8000-000000000001', 'owner',     'cd'),
  ('3d000000-0000-4000-8000-000000000003', 'support',   'cd'),
  ('3d000000-0000-4000-8000-000000000004', 'billing',   'cd'),
  ('3d000000-0000-4000-8000-000000000005', 'read_only', 'cd'),
  ('3d000000-0000-4000-8000-000000000006', 'support',   'cd');

-- ─── the company being deleted, with something in most places ───────────────

-- Rows in tables that cascade from the company ...
INSERT INTO drivers (id, company_id, name) VALUES
  ('3d100000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000e1', 'CD Fahrer 1'),
  ('3d100000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-0000000000e1', 'CD Fahrer 2'),
  ('3d100000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-0000000000e1', 'CD Fahrer 3');
INSERT INTO cars (id, company_id, kennzeichen, created_by) VALUES
  ('3d200000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000e1', 'CD-1', '3d000000-0000-4000-8000-000000000011'),
  ('3d200000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-0000000000e1', 'CD-2', '3d000000-0000-4000-8000-000000000011');
INSERT INTO income (company_id, description, amount, type, driver_name, source, source_driver_key, source_period_start, source_period_end) VALUES
  ('c0000000-0000-4000-8000-0000000000e1', 'Woche 1 - Uber', 10, 'umsatz', 'CD Fahrer 1', 'uber', 'k1', '2026-01-05', '2026-01-11'),
  ('c0000000-0000-4000-8000-0000000000e1', 'Woche 2 - Uber', 20, 'umsatz', 'CD Fahrer 1', 'uber', 'k1', '2026-01-12', '2026-01-18'),
  ('c0000000-0000-4000-8000-0000000000e1', 'von Hand',       30, 'umsatz', 'CD Fahrer 2', NULL, NULL, NULL, NULL);
INSERT INTO partner_connections (id, company_id, partner, status)
VALUES ('3d300000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000e1', 'reidey', 'active');
INSERT INTO app_private.partner_credentials (company_id, partner, key_hash)
VALUES ('c0000000-0000-4000-8000-0000000000e1', 'reidey', repeat('a', 64));

-- ... and in tables that carry a company_id with NO foreign key, which the
-- direct delete in CompaniesPage left behind.
INSERT INTO cash_transactions (company_id, transaction_type, amount, description, created_by)
VALUES ('c0000000-0000-4000-8000-0000000000e1', 'deposit', 5, 'CD Kasse', 'cd');
INSERT INTO historical_payroll_targets (company_id, month, year, driver_id, wage_type_code, wage_type_label)
VALUES ('c0000000-0000-4000-8000-0000000000e1', 1, 2026, '3d100000-0000-4000-8000-000000000001', '1000', 'Grundlohn'),
       ('c0000000-0000-4000-8000-0000000000e1', 2, 2026, '3d100000-0000-4000-8000-000000000001', '1000', 'Grundlohn');
INSERT INTO document_templates (company_id, name, file_path, file_url, created_by)
VALUES ('c0000000-0000-4000-8000-0000000000e1', 'CD Vorlage', 'cd/x', 'cd/x', '3d000000-0000-4000-8000-000000000011');

-- A table nobody has heard of yet. It must be counted, deleted and verified
-- without being named in the migration.
CREATE TABLE public.cd_new_table (id serial PRIMARY KEY, company_id uuid NOT NULL, note text);
INSERT INTO cd_new_table (company_id, note) VALUES
  ('c0000000-0000-4000-8000-0000000000e1', 'cd new'),
  ('c0000000-0000-4000-8000-00000000000b', 'cd new, another company');

-- Kept on purpose.
INSERT INTO activation_codes (id, code_hash, duration_type, expires_at, created_by, company_id, used_company_id, target_email)
VALUES ('3d400000-0000-4000-8000-000000000001', encode(sha256('cd-code'::bytea), 'hex'), '1_monat',
        now() + interval '1 day', '3d000000-0000-4000-8000-000000000001',
        'c0000000-0000-4000-8000-0000000000e1', 'c0000000-0000-4000-8000-0000000000e1', 'cd-code@test.invalid');
INSERT INTO discount_codes (id, code, discount_type, discount_value, usage_mode, audience_type, active, assigned_company_id)
VALUES ('3d500000-0000-4000-8000-000000000001', 'CD-DISC', 'percentage', 5, 'once', 'multiple', true,
        'c0000000-0000-4000-8000-0000000000e1');
INSERT INTO app_private.receipt_ocr_events (user_id, company_id, outcome)
VALUES ('3d000000-0000-4000-8000-000000000011', 'c0000000-0000-4000-8000-0000000000e1', 'allowed');
SELECT app_private.audit_write('write', 'cd.seed', 'ok', 'c0000000-0000-4000-8000-0000000000e1');

-- Files: first folder is the company id.
INSERT INTO storage.buckets (id, name) VALUES ('company-logos', 'company-logos'), ('documents', 'documents')
ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('company-logos', 'c0000000-0000-4000-8000-0000000000e1/logo.png'),
  ('documents',     'c0000000-0000-4000-8000-0000000000e1/2026/a.pdf'),
  ('company-logos', 'c0000000-0000-4000-8000-00000000000b/logo.png');

-- Something in the other seeded company, which must not move.
INSERT INTO cash_transactions (company_id, transaction_type, amount, description, created_by)
VALUES ('c0000000-0000-4000-8000-00000000000b', 'deposit', 7, 'B Kasse', 'cd');
INSERT INTO historical_payroll_targets (company_id, month, year, driver_id, wage_type_code, wage_type_label)
VALUES ('c0000000-0000-4000-8000-00000000000b', 1, 2026, 'd0000000-0000-4000-8000-00000000000b', '1000', 'Grundlohn');
INSERT INTO income (company_id, description, amount, type, driver_name)
VALUES ('c0000000-0000-4000-8000-00000000000b', 'B Umsatz', 99, 'umsatz', 'Driver B');

-- Finalized data, the shapes that protect themselves against deletion:
--   a finalized month (fahrtenbuch_imports refuses to go while one exists),
--   a confirmed monthly plan with blocks (the plan guards refuse to go),
--   a salary with a payment.
INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by, file_sha256)
VALUES ('3d600000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000e1', 1, 2026,
        'cd.xlsx', '3d000000-0000-4000-8000-000000000011', repeat('c', 64));
INSERT INTO company_planning_runs (id, company_id, month, year, import_id)
VALUES ('3d700000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000e1', 1, 2026,
        '3d600000-0000-4000-8000-000000000001');
INSERT INTO planning_finalizations (planning_run_id, company_id)
VALUES ('3d700000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000e1');

INSERT INTO monthly_plans (id, company_id, year, month, switch_minutes)
VALUES ('3d800000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000e1', 2027, 3, 30);
INSERT INTO monthly_plan_blocks (id, company_id, plan_id, block_key, car_identifier,
                                 starts_at, ends_at, span_minutes, ride_minutes)
VALUES ('3d800000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-0000000000e1',
        '3d800000-0000-4000-8000-000000000001', 'cd', 'CD-1',
        '2027-03-02 08:23+01', '2027-03-02 09:44+01', 81, 81);
ALTER TABLE monthly_plans DISABLE TRIGGER monthly_plan_guard;
UPDATE monthly_plans SET status = 'confirmed', confirmed_at = now(), confirmed_by = '3d000000-0000-4000-8000-000000000011' WHERE id = '3d800000-0000-4000-8000-000000000001';
ALTER TABLE monthly_plans ENABLE TRIGGER monthly_plan_guard;

INSERT INTO salaries (id, driver_id, period_start, period_end, created_by, company_id)
VALUES ('3d900000-0000-4000-8000-000000000001', '3d100000-0000-4000-8000-000000000001',
        '2026-01-01', '2026-01-31', '3d000000-0000-4000-8000-000000000011',
        'c0000000-0000-4000-8000-0000000000e1');
INSERT INTO salary_payments (salary_id, company_id, payment_type, amount, payment_date, created_by)
VALUES ('3d900000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000e1',
        'cash', 10, '2026-02-01', '3d000000-0000-4000-8000-000000000011');

-- A snapshot of everything that is not the company being deleted.
CREATE TEMP TABLE _cd_before AS
SELECT app_private.company_deletion_counts('c0000000-0000-4000-8000-00000000000b') AS b,
       app_private.company_deletion_counts('c0000000-0000-4000-8000-0000000000e2') AS aktiv,
       (SELECT count(*) FROM user_profiles WHERE company_id IS DISTINCT FROM 'c0000000-0000-4000-8000-0000000000e1') AS other_profiles,
       (SELECT count(*) FROM app_private.platform_staff) AS staff_rows;

-- ─── 1. grants ──────────────────────────────────────────────────────────────

DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['public.platform_company_delete_preview(uuid)', 'public.platform_company_delete(uuid,text)'] LOOP
    PERFORM _cd_ok(format('EXECUTE on %s: anon no, service_role no, authenticated yes', s),
      NOT has_function_privilege('anon', s::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('service_role', s::regprocedure, 'EXECUTE')
      AND has_function_privilege('authenticated', s::regprocedure, 'EXECUTE'));
  END LOOP;
  PERFORM _cd_ok('anon is refused for lack of EXECUTE',
    _cd_try(NULL, $q$SELECT platform_company_delete('c0000000-0000-4000-8000-0000000000e1', 'CD Ziel GmbH')::text$q$) LIKE 'ERR 42501%');
  PERFORM _cd_ok('the service role is refused too',
    _cd_try(NULL, $q$SELECT platform_company_delete_preview('c0000000-0000-4000-8000-0000000000e1')::text$q$, true) LIKE 'ERR 42501%');
END $$;

-- ─── 2. role x RPC ──────────────────────────────────────────────────────────

DO $$
DECLARE
  owner_ constant uuid := '3d000000-0000-4000-8000-000000000001';
  who    uuid[] := ARRAY['3d000000-0000-4000-8000-000000000001', '3d000000-0000-4000-8000-000000000003',
                         '3d000000-0000-4000-8000-000000000004', '3d000000-0000-4000-8000-000000000005',
                         '3d000000-0000-4000-8000-000000000011']::uuid[];
  label  text[] := ARRAY['owner', 'support', 'billing', 'read_only', 'company admin'];
  want   text[] := ARRAY['Y', 'N', 'N', 'N', 'N'];
  i      int;
  a      text;
BEGIN
  FOR i IN 1 .. 5 LOOP
    a := _cd_try(who[i], $q$SELECT platform_company_delete_preview('c0000000-0000-4000-8000-0000000000e1')::text$q$);
    PERFORM _cd_ok(format('preview: %s -> %s (got %s)', label[i], want[i], _cd_yn(a)), _cd_yn(a) = want[i]);
    a := _cd_try(who[i], $q$SELECT platform_company_delete('c0000000-0000-4000-8000-0000000000e1', 'CD Ziel GmbH')::text$q$);
    PERFORM _cd_ok(format('delete: %s -> %s (got %s)', label[i], want[i], _cd_yn(a)), _cd_yn(a) = want[i]);
    IF want[i] = 'N' THEN
      PERFORM _cd_ok(format('delete: %s is refused as denied, not as something else', label[i]), _cd_reason(a) = 'denied');
    END IF;
  END LOOP;

  PERFORM _cd_ok('the company still exists after all of those (each ran in a rolled-back subtransaction)',
    EXISTS (SELECT 1 FROM companies WHERE id = 'c0000000-0000-4000-8000-0000000000e1'));
END $$;

-- ─── 3. refusals: each with its reason, nothing changed ─────────────────────

DO $$
DECLARE
  owner_ constant uuid := '3d000000-0000-4000-8000-000000000001';
  v_before jsonb := app_private.company_deletion_counts('c0000000-0000-4000-8000-0000000000e1');
  a text;
BEGIN
  a := _cd_do(owner_, $q$SELECT platform_company_delete('c0000000-0000-4000-8000-0000000000e1', 'cd ziel gmbh')::text$q$);
  PERFORM _cd_ok('a name that differs in case is name_mismatch', _cd_reason(a) = 'name_mismatch');
  PERFORM _cd_ok('and says so in German', (a::jsonb ->> 'error') LIKE 'Der eingegebene Name stimmt nicht%');

  a := _cd_do(owner_, $q$SELECT platform_company_delete('c0000000-0000-4000-8000-0000000000e1', 'Anderes Unternehmen')::text$q$);
  PERFORM _cd_ok('another company''s name is name_mismatch', _cd_reason(a) = 'name_mismatch');

  a := _cd_do(owner_, $q$SELECT platform_company_delete('c0000000-0000-4000-8000-0000000000e2', 'CD Aktiv GmbH')::text$q$);
  PERFORM _cd_ok('a company not marked deleted is invalid_status, even with the right name', _cd_reason(a) = 'invalid_status');
  PERFORM _cd_ok('and that company still exists',
    EXISTS (SELECT 1 FROM companies WHERE id = 'c0000000-0000-4000-8000-0000000000e2'));

  a := _cd_do(owner_, $q$SELECT platform_company_delete('c0000000-0000-4000-8000-0000000000ff', 'x')::text$q$);
  PERFORM _cd_ok('an unknown company is not_found', _cd_reason(a) = 'not_found');
  a := _cd_do(owner_, $q$SELECT platform_company_delete(NULL, 'x')::text$q$);
  PERFORM _cd_ok('a NULL company is invalid', _cd_reason(a) = 'invalid');
  a := _cd_do(owner_, $q$SELECT platform_company_delete('c0000000-0000-4000-8000-0000000000e1', NULL)::text$q$);
  PERFORM _cd_ok('a NULL name is invalid', _cd_reason(a) = 'invalid');
  a := _cd_do(owner_, $q$SELECT platform_company_delete_preview('c0000000-0000-4000-8000-0000000000ff')::text$q$);
  PERFORM _cd_ok('the preview of an unknown company is not_found', _cd_reason(a) = 'not_found');

  PERFORM _cd_ok('nothing of the target moved in any of those',
    app_private.company_deletion_counts('c0000000-0000-4000-8000-0000000000e1') = v_before);
  PERFORM _cd_ok('a name mismatch left an error row, kept (the call returned a value)',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log l
             WHERE l.action = 'company.hard_delete' AND l.outcome = 'error'
               AND l.after_value ->> 'reason' = 'name_mismatch'
               AND l.actor_user_id = owner_));

  -- a refused role leaves a denied row when the call is kept
  a := _cd_do('3d000000-0000-4000-8000-000000000003', $q$SELECT platform_company_delete('c0000000-0000-4000-8000-0000000000e1', 'CD Ziel GmbH')::text$q$);
  PERFORM _cd_ok('support: denied', _cd_reason(a) = 'denied');
  PERFORM _cd_ok('and recorded as denied against that account',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log l
             WHERE l.action = 'company.hard_delete' AND l.outcome = 'denied'
               AND l.actor_user_id = '3d000000-0000-4000-8000-000000000003'));
END $$;

-- ─── 4. an open context ─────────────────────────────────────────────────────

DO $$
DECLARE
  owner_ constant uuid := '3d000000-0000-4000-8000-000000000001';
  v_before jsonb := app_private.company_deletion_counts('c0000000-0000-4000-8000-0000000000e1');
  a text;
  mode_ text;
BEGIN
  FOREACH mode_ IN ARRAY ARRAY['view', 'support'] LOOP
    a := _cd_do(owner_, format($q$SELECT platform_context_open('c0000000-0000-4000-8000-0000000000e3', %L, %L)::text$q$,
                               mode_, CASE mode_ WHEN 'support' THEN 'Test der endgültigen Löschung, kein echter Grund' END));
    PERFORM _cd_ok(format('a %s context opens (got %s)', mode_, a), _cd_yn(a) = 'Y');

    a := _cd_do(owner_, $q$SELECT platform_company_delete('c0000000-0000-4000-8000-0000000000e1', 'CD Ziel GmbH')::text$q$);
    PERFORM _cd_ok(format('with a %s context open the deletion is refused with its own reason', mode_),
      _cd_reason(a) = 'company_delete_context_open');
    PERFORM _cd_ok(format('%s: as a sentence, not an exception', mode_), (a::jsonb ->> 'error') LIKE 'Solange ein Unternehmenszugriff offen ist%');
    PERFORM _cd_ok(format('%s: and nothing was deleted, the no-FK tables included', mode_),
      app_private.company_deletion_counts('c0000000-0000-4000-8000-0000000000e1') = v_before
      AND EXISTS (SELECT 1 FROM companies WHERE id = 'c0000000-0000-4000-8000-0000000000e1'));

    a := _cd_do(owner_, $q$SELECT platform_context_close()::text$q$);
    PERFORM _cd_ok(format('the %s context closes', mode_), _cd_yn(a) = 'Y');
  END LOOP;
  PERFORM _cd_ok('the refusal is recorded as an error with the guard''s reason',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log l
             WHERE l.action = 'company.hard_delete' AND l.outcome = 'error'
               AND l.after_value ->> 'reason' = 'company_delete_context_open'));
END $$;

-- ─── 5. the preview and the deletion agree ──────────────────────────────────

CREATE TEMP TABLE _cd_run (preview jsonb, deleted jsonb);

DO $$
DECLARE
  owner_ constant uuid := '3d000000-0000-4000-8000-000000000001';
  v_prev jsonb;
  v_del  jsonb;
BEGIN
  v_prev := _cd_do(owner_, $q$SELECT platform_company_delete_preview('c0000000-0000-4000-8000-0000000000e1')::text$q$)::jsonb;
  PERFORM _cd_ok('the preview answers success', (v_prev ->> 'success') = 'true');

  v_del := _cd_do(owner_, $q$SELECT platform_company_delete('c0000000-0000-4000-8000-0000000000e1', '  CD Ziel GmbH ')::text$q$)::jsonb;
  PERFORM _cd_ok('the deletion succeeds (a typed name is trimmed like the screen trims it)', (v_del ->> 'success') = 'true');

  INSERT INTO _cd_run VALUES (v_prev, v_del);

  PERFORM _cd_ok('preview == deletion: the rows per table',   (v_prev #> '{plan,tables}')   = (v_del #> '{plan,tables}'));
  PERFORM _cd_ok('preview == deletion: the total',           (v_prev #> '{plan,rows_total}') = (v_del #> '{plan,rows_total}'));
  PERFORM _cd_ok('preview == deletion: the accounts',        (v_prev #> '{plan,accounts}') = (v_del #> '{plan,accounts}'));
  PERFORM _cd_ok('preview == deletion: the files',           (v_prev #> '{plan,files}')    = (v_del #> '{plan,files}'));
  -- The one figure that may differ is the audit history of the company: the
  -- preview wrote its own row between the two readings.
  PERFORM _cd_ok('preview == deletion: what is kept (the audit history grew by the preview''s own row)',
    (v_prev #> '{plan,kept}') - 'audit_rows' = (v_del #> '{plan,kept}') - 'audit_rows'
    AND (v_del #>> '{plan,kept,audit_rows}')::int = (v_prev #>> '{plan,kept,audit_rows}')::int + 1);
  PERFORM _cd_ok('preview == deletion: the income split',    (v_prev #> '{plan,income}')   = (v_del #> '{plan,income}'));

  PERFORM _cd_ok('the total is the sum of the tables',
    (v_del #>> '{plan,rows_total}')::bigint = (SELECT sum(value::bigint) FROM jsonb_each_text(v_del #> '{plan,tables}')));
END $$;

-- ─── 6. what went ───────────────────────────────────────────────────────────

DO $$
DECLARE
  r record; n bigint; v_t jsonb := (SELECT deleted FROM _cd_run) #> '{plan,tables}';
BEGIN
  PERFORM _cd_ok('the company is gone', NOT EXISTS (SELECT 1 FROM companies WHERE id = 'c0000000-0000-4000-8000-0000000000e1'));
  FOR r IN SELECT * FROM app_private.company_deletion_tables() LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE company_id = $1', r.schema_name, r.table_name)
      INTO n USING 'c0000000-0000-4000-8000-0000000000e1'::uuid;
    IF n <> 0 THEN RAISE EXCEPTION 'FAIL: % rows of % remain', n, r.table_name; END IF;
  END LOOP;
  PERFORM _cd_ok('every table the catalogue lists is empty for the company', true);

  PERFORM _cd_ok('the tables with no foreign key were counted ...',
    (v_t ->> 'cash_transactions') = '1' AND (v_t ->> 'historical_payroll_targets') = '2' AND (v_t ->> 'document_templates') = '1');
  PERFORM _cd_ok('... and deleted',
    NOT EXISTS (SELECT 1 FROM cash_transactions WHERE company_id = 'c0000000-0000-4000-8000-0000000000e1')
    AND NOT EXISTS (SELECT 1 FROM historical_payroll_targets WHERE company_id = 'c0000000-0000-4000-8000-0000000000e1')
    AND NOT EXISTS (SELECT 1 FROM document_templates WHERE company_id = 'c0000000-0000-4000-8000-0000000000e1'));
  PERFORM _cd_ok('a table added today was counted and deleted without being named anywhere',
    (v_t ->> 'cd_new_table') = '1'
    AND NOT EXISTS (SELECT 1 FROM cd_new_table WHERE company_id = 'c0000000-0000-4000-8000-0000000000e1'));
  PERFORM _cd_ok('the partner connection and its credential went',
    NOT EXISTS (SELECT 1 FROM partner_connections WHERE company_id = 'c0000000-0000-4000-8000-0000000000e1')
    AND NOT EXISTS (SELECT 1 FROM app_private.partner_credentials WHERE company_id = 'c0000000-0000-4000-8000-0000000000e1')
    AND (v_t ->> 'partner_connections') = '1' AND (v_t ->> 'app_private.partner_credentials') = '1');
  PERFORM _cd_ok('a finalized month, a confirmed monthly plan and a paid salary did not stop it',
    NOT EXISTS (SELECT 1 FROM planning_finalizations WHERE company_id = 'c0000000-0000-4000-8000-0000000000e1')
    AND NOT EXISTS (SELECT 1 FROM monthly_plans WHERE company_id = 'c0000000-0000-4000-8000-0000000000e1')
    AND NOT EXISTS (SELECT 1 FROM salary_payments WHERE company_id = 'c0000000-0000-4000-8000-0000000000e1'));
  PERFORM _cd_ok('income is split into imported and typed',
    ((SELECT deleted FROM _cd_run) #>> '{plan,income,uber}') = '2'
    AND ((SELECT deleted FROM _cd_run) #>> '{plan,income,other}') = '1');
  PERFORM _cd_ok('no profile of the company remains', NOT EXISTS (SELECT 1 FROM user_profiles WHERE company_id = 'c0000000-0000-4000-8000-0000000000e1'));
END $$;

-- ─── 7. what stayed ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_del jsonb := (SELECT deleted FROM _cd_run);
  v_acc jsonb := v_del #> '{plan,accounts}';
  v_ids text[];
BEGIN
  SELECT array_agg(a ->> 'user_id' ORDER BY a ->> 'user_id') INTO v_ids
    FROM jsonb_array_elements(v_acc) a WHERE a ->> 'action' = 'delete';
  PERFORM _cd_ok('the three ordinary accounts of the company are listed for removal',
    v_ids @> ARRAY['3d000000-0000-4000-8000-000000000011', '3d000000-0000-4000-8000-000000000012', '3d000000-0000-4000-8000-000000000013']);
  PERFORM _cd_ok('the platform account inside the company is listed as kept, with its reason',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_acc) a
             WHERE a ->> 'user_id' = '3d000000-0000-4000-8000-000000000006'
               AND a ->> 'action' = 'keep' AND a ->> 'reason' = 'platform_staff'));
  PERFORM _cd_ok('no staff account appears among those to remove',
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_acc) a
                 WHERE a ->> 'action' = 'delete'
                   AND EXISTS (SELECT 1 FROM app_private.platform_staff s WHERE s.user_id = (a ->> 'user_id')::uuid)));
  PERFORM _cd_ok('no account of another company appears in the list at all',
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_acc) a
                 WHERE a ->> 'user_id' IN ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
                                           '3d000000-0000-4000-8000-000000000001')));
  PERFORM _cd_ok('the staff row of the account inside the company is intact',
    EXISTS (SELECT 1 FROM app_private.platform_staff WHERE user_id = '3d000000-0000-4000-8000-000000000006'));
  PERFORM _cd_ok('no staff row was lost or added',
    (SELECT count(*) FROM app_private.platform_staff) = (SELECT staff_rows FROM _cd_before));

  PERFORM _cd_ok('the other seeded company is untouched, table by table',
    app_private.company_deletion_counts('c0000000-0000-4000-8000-00000000000b') = (SELECT b FROM _cd_before));
  PERFORM _cd_ok('the other deleted-looking company is untouched',
    app_private.company_deletion_counts('c0000000-0000-4000-8000-0000000000e2') = (SELECT aktiv FROM _cd_before)
    AND EXISTS (SELECT 1 FROM companies WHERE id IN ('c0000000-0000-4000-8000-0000000000e2', 'c0000000-0000-4000-8000-0000000000e3', 'c0000000-0000-4000-8000-00000000000b')));
  PERFORM _cd_ok('no profile of any other company went',
    (SELECT count(*) FROM user_profiles WHERE company_id IS DISTINCT FROM 'c0000000-0000-4000-8000-0000000000e1') = (SELECT other_profiles FROM _cd_before));
  PERFORM _cd_ok('its administrator''s profile is still there',
    EXISTS (SELECT 1 FROM user_profiles WHERE user_id = 'b0000000-0000-4000-8000-000000000001'));

  PERFORM _cd_ok('the activation code stays, with a null company, and its address is reported not rewritten',
    EXISTS (SELECT 1 FROM activation_codes WHERE id = '3d400000-0000-4000-8000-000000000001'
             AND company_id IS NULL AND used_company_id IS NULL AND target_email = 'cd-code@test.invalid')
    AND (v_del #>> '{plan,kept,activation_codes}') = '1' AND (v_del #>> '{plan,kept,activation_codes_with_address}') = '1');
  PERFORM _cd_ok('the discount code stays, unassigned',
    EXISTS (SELECT 1 FROM discount_codes WHERE id = '3d500000-0000-4000-8000-000000000001' AND assigned_company_id IS NULL));
  PERFORM _cd_ok('the OCR abuse-control event stays',
    EXISTS (SELECT 1 FROM app_private.receipt_ocr_events WHERE company_id = 'c0000000-0000-4000-8000-0000000000e1'));
  PERFORM _cd_ok('the audit history of the company stays',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log WHERE company_id = 'c0000000-0000-4000-8000-0000000000e1' AND action = 'cd.seed'));

  PERFORM _cd_ok('the answer lists the company''s two files and none of the other company''s',
    jsonb_array_length(v_del -> 'objects') = 2
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_del -> 'objects') o WHERE o ->> 'name' LIKE 'c0000000-0000-4000-8000-00000000000b/%')
    AND (v_del #>> '{plan,files,count}') = '2');
END $$;

-- ─── 8. the audit rows ──────────────────────────────────────────────────────

DO $$
DECLARE
  v_del jsonb := (SELECT deleted FROM _cd_run);
  v_row app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _cd_ok('exactly one ok row for the deletion, written by the owner',
    (SELECT count(*) FROM app_private.platform_audit_log l
      WHERE l.action = 'company.hard_delete' AND l.outcome = 'ok') = 1);
  SELECT * INTO v_row FROM app_private.platform_audit_log WHERE action = 'company.hard_delete' AND outcome = 'ok';
  PERFORM _cd_ok('it names the actor, his role, the company and the target',
    v_row.actor_user_id = '3d000000-0000-4000-8000-000000000001' AND v_row.actor_role = 'owner'
    AND v_row.company_id = 'c0000000-0000-4000-8000-0000000000e1' AND v_row.target_id = 'c0000000-0000-4000-8000-0000000000e1'
    AND v_row.category = 'write');
  PERFORM _cd_ok('it still means something after the company is gone: the name, in the before value',
    v_row.before_value ->> 'name' = 'CD Ziel GmbH' AND v_row.before_value ->> 'slug' = 'cd-ziel');
  PERFORM _cd_ok('it carries the counts that were deleted',
    v_row.after_value -> 'tables' = v_del #> '{plan,tables}' AND (v_row.after_value ->> 'rows_total')::bigint = (v_del #>> '{plan,rows_total}')::bigint);
  PERFORM _cd_ok('it carries account ids, removed and kept',
    jsonb_array_length(v_row.after_value -> 'accounts_delete') = 3 AND jsonb_array_length(v_row.after_value -> 'accounts_kept') = 1);
  PERFORM _cd_ok('and no e-mail address anywhere in the row',
    position('@' in (coalesce(v_row.before_value::text, '') || coalesce(v_row.after_value::text, ''))) = 0);
  PERFORM _cd_ok('the preview left one read row, with counts and no addresses',
    (SELECT count(*) FROM app_private.platform_audit_log l
      WHERE l.action = 'platform_read.company_delete_preview' AND l.outcome = 'ok'
        AND l.category = 'read' AND position('@' in l.after_value::text) = 0
        AND (l.after_value ->> 'accounts')::int = 4) = 1);
END $$;

-- ─── 9. a leftover rolls everything back ────────────────────────────────────

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
VALUES ('c0000000-0000-4000-8000-0000000000e4', 'CD Stur GmbH', 'cd-stur', 'approved', 'deleted', 'basic', 'inactive');
INSERT INTO drivers (id, company_id, name) VALUES ('3d100000-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-0000000000e4', 'CD Stur Fahrer');

CREATE TABLE public.cd_stubborn (id serial PRIMARY KEY, company_id uuid NOT NULL);
CREATE FUNCTION public.cd_stubborn_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
CREATE TRIGGER cd_stubborn_refuse BEFORE DELETE ON public.cd_stubborn FOR EACH ROW EXECUTE FUNCTION public.cd_stubborn_refuse();
INSERT INTO cd_stubborn (company_id) VALUES ('c0000000-0000-4000-8000-0000000000e4');

DO $$
DECLARE a text;
BEGIN
  a := _cd_do('3d000000-0000-4000-8000-000000000001', $q$SELECT platform_company_delete('c0000000-0000-4000-8000-0000000000e4', 'CD Stur GmbH')::text$q$);
  PERFORM _cd_ok('a row the deletion cannot remove fails the whole call', a LIKE 'ERR % company delete left rows behind%');
  PERFORM _cd_ok('the company and its other rows are still there',
    EXISTS (SELECT 1 FROM companies WHERE id = 'c0000000-0000-4000-8000-0000000000e4')
    AND EXISTS (SELECT 1 FROM drivers WHERE id = '3d100000-0000-4000-8000-0000000000a1'));
  PERFORM _cd_ok('no ok row was written for it',
    NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log WHERE action = 'company.hard_delete' AND outcome = 'ok'
                 AND company_id = 'c0000000-0000-4000-8000-0000000000e4'));
END $$;

-- ─── 10. the catalogue itself ───────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _cd_ok('the records kept on purpose are not in the catalogue',
    NOT EXISTS (SELECT 1 FROM app_private.company_deletion_tables() d
                 WHERE d.table_name IN ('platform_audit_log', 'receipt_ocr_events', 'activation_codes', 'activation_code_attempts')));
  PERFORM _cd_ok('the catalogue lists the tables that have no foreign key, marked as not cascading',
    (SELECT count(*) FROM app_private.company_deletion_tables() d
      WHERE NOT d.cascades AND d.table_name IN ('cash_transactions', 'historical_payroll_targets', 'cd_new_table')) = 3);
END $$;

ROLLBACK;
