/*
  The free trial is gone (20261015170000; owner, 15.10.2026: "there is no 14 day
  try for free version"), and the one way that could have hurt is covered here:
  companies that still sat on `status = 'trial'` while paying.

  The gate (`get_active_company_id()`) now asks `companies.status = 'active'`.
  Before this change it asked `IN ('active','trial')`, and the normal state of a
  paying customer was `trial` for ever, because `redeem_activation_code` writes
  the subscription columns and never `status`. So the order of the migration is
  the whole safety: the rows move first, the rule narrows after.

  Runs after the migrations and the seeds, as supabase_admin, in one
  transaction that is rolled back, so the files after it see the database as
  the seeds left it.

    1. the CHECK      `trial` cannot be stored, on insert or on update
    2. the property   the part of the migration that matters, run on rows
                      shaped like the ones that could have been locked out:
                      a paying company on `trial` has NO access under the
                      narrowed rule (the hazard, proved real) and has exactly
                      the access it had after `companies_retire_trial_status()`
                      — the function the migration calls. A lapsed trial has
                      none before and none after, and the subscription columns
                      are not touched.
    3. the types      the notification CHECKs refuse the removed types

  MUTATION CONTROL, recorded so the next person can repeat it: make
  `app_private.companies_retire_trial_status()` return 0 without updating, and
  section 2 fails on "a paying company keeps its access" — the property that
  companies lose access when the row migration is skipped.
*/

\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION _tr_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _tr_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('tr:' || p_what)::uuid $$;

/** What get_active_company_id() answers for p_user, as the session sees it. */
CREATE OR REPLACE FUNCTION _tr_gate(p_user uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  v := public.get_active_company_id();
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  RETURN v;
END $$;

-- ─── 1. the CHECK ───────────────────────────────────────────────────────────

DO $$
DECLARE
  v_refused_insert boolean := false;
  v_refused_update boolean := false;
BEGIN
  BEGIN
    INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
    VALUES (_tr_id('company:check'), 'TR check', 'tr-check', 'approved', 'trial', 'basic', 'inactive');
  EXCEPTION WHEN check_violation THEN
    v_refused_insert := true;
  END;
  PERFORM _tr_ok('the CHECK refuses to store a company with status trial', v_refused_insert);

  INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
  VALUES (_tr_id('company:check'), 'TR check', 'tr-check', 'approved', 'active', 'basic', 'inactive');
  BEGIN
    UPDATE companies SET status = 'trial' WHERE id = _tr_id('company:check');
  EXCEPTION WHEN check_violation THEN
    v_refused_update := true;
  END;
  PERFORM _tr_ok('…and to move an existing company onto it', v_refused_update);

  PERFORM _tr_ok('the CHECK still admits the other four states',
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid = 'public.companies'::regclass AND conname = 'companies_status_check')
      ~ 'active.*suspended.*inactive.*archived.*deleted');
END $$;

-- ─── 2. the property: no company loses access ───────────────────────────────

/*
  Rows shaped like the ones the migration found on staging: companies on
  `status = 'trial'`. The CHECK now refuses them, so it is dropped inside this
  transaction to build them — and put back at the end of the section, which is
  exactly the order the migration uses (rows first, CHECK after).
*/

ALTER TABLE companies DROP CONSTRAINT companies_status_check;

CREATE TEMP TABLE _tr_company (slug text, label text, approval_status text, subscription_status text,
                               expires_at timestamptz, paying boolean);
INSERT INTO _tr_company VALUES
  ('paidfuture', 'trial label, subscription live and expiring ahead', 'approved', 'active',   now() + interval '60 days', true),
  ('paidopen',   'trial label, open-ended subscription',              'approved', 'active',   NULL,                       true),
  ('lapsed',     'trial label, nothing replaced the trial',           'approved', 'inactive', NULL,                       false),
  ('expired',    'trial label, subscription ran out',                 'approved', 'expired',  now() - interval '3 days',  false),
  ('pending',    'trial label, never approved',                       'pending',  'inactive', NULL,                       false);

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status, subscription_expires_at)
SELECT _tr_id('company:' || c.slug), 'TR ' || c.slug, 'tr-' || c.slug, c.approval_status, 'trial',
       'premium', c.subscription_status, c.expires_at
  FROM _tr_company c;

INSERT INTO auth.users (id, email)
SELECT _tr_id('user:' || c.slug), 'tr-' || c.slug || '@test.invalid' FROM _tr_company c;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, is_super_admin, status, must_change_password)
SELECT _tr_id('user:' || c.slug), 'tr-' || c.slug || '@test.invalid', 'TR ' || c.slug, 'admin',
       (SELECT id FROM roles WHERE name = 'admin' AND company_id IS NULL LIMIT 1),
       _tr_id('company:' || c.slug), false, 'active', false
  FROM _tr_company c;

-- What each company's subscription columns say, to prove they are not touched.
CREATE TEMP TABLE _tr_before AS
SELECT c.id, c.subscription_status, c.subscription_expires_at, c.plan, c.approval_status
  FROM companies c WHERE c.id IN (SELECT _tr_id('company:' || slug) FROM _tr_company);

DO $$
DECLARE
  r      record;
  v_rows integer;
BEGIN
  -- The hazard, proved real: with the rule already narrowed and the rows not
  -- yet moved, the paying companies are locked out. This is the failure the
  -- migration's order exists to prevent.
  FOR r IN SELECT * FROM _tr_company WHERE paying LOOP
    PERFORM _tr_ok(format('before the rows move: %s has NO access under the narrowed rule', r.label),
      _tr_gate(_tr_id('user:' || r.slug)) IS NULL);
  END LOOP;

  v_rows := app_private.companies_retire_trial_status();

  FOR r IN SELECT * FROM _tr_company WHERE paying LOOP
    PERFORM _tr_ok(format('a paying company keeps its access: %s', r.label),
      _tr_gate(_tr_id('user:' || r.slug)) = _tr_id('company:' || r.slug));
  END LOOP;

  FOR r IN SELECT * FROM _tr_company WHERE NOT paying LOOP
    PERFORM _tr_ok(format('a company that had no access still has none: %s', r.label),
      _tr_gate(_tr_id('user:' || r.slug)) IS NULL);
  END LOOP;

  PERFORM _tr_ok('the row migration moves every trial row it was given', v_rows = 5);
  PERFORM _tr_ok('no company is on status trial afterwards',
    NOT EXISTS (SELECT 1 FROM companies WHERE status = 'trial'));

  PERFORM _tr_ok('the migration touched the label only: subscription, plan and approval are unchanged',
    NOT EXISTS (
      SELECT 1 FROM _tr_before b JOIN companies c ON c.id = b.id
       WHERE c.subscription_status IS DISTINCT FROM b.subscription_status
          OR c.subscription_expires_at IS DISTINCT FROM b.subscription_expires_at
          OR c.plan IS DISTINCT FROM b.plan
          OR c.approval_status IS DISTINCT FROM b.approval_status));

  PERFORM _tr_ok('running the row migration again changes nothing (idempotent)',
    app_private.companies_retire_trial_status() = 0);
END $$;

ALTER TABLE companies ADD CONSTRAINT companies_status_check
  CHECK (status = ANY (ARRAY['active', 'suspended', 'inactive', 'archived', 'deleted']));

-- ─── 3. the removed notification types ──────────────────────────────────────

DO $$
DECLARE
  v_deliveries boolean := false;
  v_recipients boolean := false;
BEGIN
  BEGIN
    INSERT INTO notification_deliveries (company_id, notification_type, target_id, period_key)
    VALUES (_tr_id('company:paidfuture'), 'trial_abgelaufen', _tr_id('company:paidfuture'), '2099-01-01');
  EXCEPTION WHEN check_violation THEN
    v_deliveries := true;
  END;
  PERFORM _tr_ok('notification_deliveries refuses a trial type', v_deliveries);

  BEGIN
    INSERT INTO notification_recipients (company_id, notification_type, email)
    VALUES (_tr_id('company:paidfuture'), 'trial_bald_ablaufend', 'x@firma.example');
  EXCEPTION WHEN check_violation THEN
    v_recipients := true;
  END;
  PERFORM _tr_ok('notification_recipients refuses a trial type', v_recipients);

  PERFORM _tr_ok('…and still takes the TÜV types and manager_summary',
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'notification_recipients_type_check')
      ~ 'tuev_bald_ablaufend.*tuev_abgelaufen.*manager_summary');
END $$;

ROLLBACK;
