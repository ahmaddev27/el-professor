/*
  Settings, the price book and the plan feature map (plan 3.9, migration
  20260916150000).

  Runs after assertions.sql, the matrix and platform-authority.sql, against the
  same throwaway database, as supabase_admin. Every check raises on failure; a
  silent run is a pass. The whole file is one transaction rolled back at the
  end, so the files after it see the database as the seeds left it.

  What is covered, in order:

    1. privileges   app_private.platform_settings stays unreachable; each
                    function has exactly its stated EXECUTE grants
    2. seeds        the two documents the migration writes, valid and at
                    version 1, with today's prices and today's feature map
    3. reading      settings.read by role, and the one rule no capability can
                    express: billing reads the price book and nothing else
    4. config       get_public_config for anyone, get_app_config signed in
    5. writing      pricing.manage for the price book, settings.manage — owner
                    only — for the rest, the feature map included; the shape
                    validator; the rule that a feature map must name every
                    feature the application knows (20260917120000); the version
                    check
    6. alien book   an alien price book, shared with
                    src/utils/pricing.parity.test.ts, priced by
                    price_book_price and by compute_plan_price. Both engines
                    read the same 42 numbers out of this file, so a formula
                    that ignores the book fails here and nowhere else
    6b. first month  the flat price of a company's first invoice
                    (20261015160000): the alien book's own figure, the flag's
                    default, the invoice amount in cents, and
                    platform_invoice_quotes on real companies and invoices
    7. audit        a row per call, refusals included, with the version read and
                    the value before and after a write — and no row at all for
                    a caller who is not platform staff
    8. forgery      platform_audit_record cannot be used to forge a
                    platform_settings row: 3.5's action allow-list names none,
                    and the reserved namespaces still hold
    9. the cap      one actor writes at most 120 settings audit rows a minute
                    (20260917120000), and the refusal past that writes no row at
                    all

  The money rule this file pins is the one the migration preserves:

      monthly = cars x price per car x (1 - fleet %)
      yearly  = monthly x 12 x (1 - yearly %)

  with the price per car in integer cents and both discounts whole percents.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _pr_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

/** Back to the connecting superuser with no JWT claims at all. */
CREATE OR REPLACE FUNCTION _pr_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

/** Become a principal: a user id (authenticated), NULL (anon), or service role. */
CREATE OR REPLACE FUNCTION _pr_become(p_user uuid, p_service boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _pr_reset();
  IF p_service THEN
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
  ELSIF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
  ELSE
    PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    -- A password sign-in: since 20260919130000 a platform capability needs one.
    PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
END $$;

/**
  Run one SELECT as the principal and return its scalar, or `ERR <sqlstate>
  <message>`. Unlike the probes in matrix.sql this one KEEPS what the statement
  did: these functions are meant to write audit rows, and section 7 reads them.
  A statement that raises is undone by the implicit subtransaction of the
  EXCEPTION block, which is the point — a refusal that raises must leave
  nothing.
*/
CREATE OR REPLACE FUNCTION _pr_do(p_user uuid, p_sql text, p_service boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _pr_become(p_user, p_service);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _pr_reset();
  RETURN v_out;
END $$;

/** `platform_settings_get(key)` as p_user, reduced to one field of the answer. */
CREATE OR REPLACE FUNCTION _pr_get(p_user uuid, p_key text, p_field text DEFAULT 'reason') RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN _pr_do(p_user, format('SELECT platform_settings_get(%L) ->> %L', p_key, p_field));
END $$;

/** `platform_settings_put(key, value, expected_version)`, likewise. */
CREATE OR REPLACE FUNCTION _pr_put(p_user uuid, p_key text, p_value jsonb, p_version integer,
                                   p_field text DEFAULT 'reason') RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN _pr_do(p_user, format('SELECT platform_settings_put(%L, %L::jsonb, %s) ->> %L',
                               p_key, p_value::text, p_version, p_field));
END $$;

-- ─── principals ─────────────────────────────────────────────────────────────

/*
    3b..01 pr-owner      owner
    3b..02 pr-support    support
    3b..03 pr-billing    billing
    3b..04 pr-readonly   read_only
  plus admin-a from seed.sql (a company admin) and anon.
*/
INSERT INTO auth.users (id, email) VALUES
  ('3b000000-0000-4000-8000-000000000001', 'pr-owner@test.invalid'),
  ('3b000000-0000-4000-8000-000000000002', 'pr-support@test.invalid'),
  ('3b000000-0000-4000-8000-000000000003', 'pr-billing@test.invalid'),
  ('3b000000-0000-4000-8000-000000000004', 'pr-readonly@test.invalid');

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, is_super_admin, status) VALUES
  ('3b000000-0000-4000-8000-000000000001', 'pr-owner@test.invalid',    'PR Owner',    'admin', NULL, NULL, false, 'active'),
  ('3b000000-0000-4000-8000-000000000002', 'pr-support@test.invalid',  'PR Support',  'admin', NULL, NULL, false, 'active'),
  ('3b000000-0000-4000-8000-000000000003', 'pr-billing@test.invalid',  'PR Billing',  'admin', NULL, NULL, false, 'active'),
  ('3b000000-0000-4000-8000-000000000004', 'pr-readonly@test.invalid', 'PR Readonly', 'admin', NULL, NULL, false, 'active');

INSERT INTO app_private.platform_staff (user_id, role, note) VALUES
  ('3b000000-0000-4000-8000-000000000001', 'owner',     'pr'),
  ('3b000000-0000-4000-8000-000000000002', 'support',   'pr'),
  ('3b000000-0000-4000-8000-000000000003', 'billing',   'pr'),
  ('3b000000-0000-4000-8000-000000000004', 'read_only', 'pr');

-- ─── 1. privileges ──────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role text;
  r      record;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM _pr_ok(format('%s has no USAGE on schema app_private', v_role),
                   NOT has_schema_privilege(v_role, 'app_private', 'USAGE'));
    PERFORM _pr_ok(format('%s holds no privilege on app_private.platform_settings', v_role),
                   NOT has_table_privilege(v_role, 'app_private.platform_settings',
                                           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'));
  END LOOP;

  FOR r IN
    SELECT * FROM (VALUES
      -- signature                                                       anon   authn  service
      ('public.platform_settings_get(text)',                             false, true,  false),
      ('public.platform_settings_put(text,jsonb,integer)',               false, true,  false),
      ('public.get_public_config()',                                     true,  true,  false),
      ('public.get_app_config()',                                        false, true,  false),
      ('public.compute_plan_price(text,integer,text,boolean)',           false, true,  true),
      ('public.platform_invoice_quotes(integer,integer)',                false, true,  false),
      ('app_private.platform_setting_value(text)',                       false, false, false),
      ('app_private.platform_setting_is_pricing(text)',                  false, false, false),
      ('app_private.platform_settings_readable(text,text)',              false, false, false),
      ('app_private.platform_setting_write_capability(text)',            false, false, false),
      ('app_private.settings_object_keys(jsonb)',                        false, false, false),
      ('app_private.settings_integer_between(jsonb,integer,integer)',    false, false, false),
      ('app_private.platform_settings_problem(text,jsonb)',              false, false, false),
      ('app_private.price_book_price(jsonb,text,integer,text,boolean)',  false, false, false),
      ('app_private.invoice_amount_cents(jsonb,text,integer,text,boolean)', false, false, false),
      ('app_private.signup_trial_days()',                                false, false, false)
    ) AS t(sig, anon, authn, service)
  LOOP
    PERFORM _pr_ok(format('EXECUTE on %s: anon %s, authenticated %s, service_role %s',
                          r.sig, r.anon, r.authn, r.service),
      has_function_privilege('anon',          r.sig::regprocedure, 'EXECUTE') = r.anon
      AND has_function_privilege('authenticated', r.sig::regprocedure, 'EXECUTE') = r.authn
      AND has_function_privilege('service_role',  r.sig::regprocedure, 'EXECUTE') = r.service);
  END LOOP;

  -- Reaching app_private means running as an owner that can, whatever the
  -- databases' history of function ownership (20260916110010, "Ownership").
  PERFORM _pr_ok('every function of 20260916150000 that reads app_private belongs to a role that reaches it',
    NOT EXISTS (SELECT 1
                  FROM pg_proc p
                  JOIN pg_roles owner_role ON owner_role.oid = p.proowner
                 WHERE p.oid IN ('public.compute_plan_price(text,integer,text,boolean)'::regprocedure,
                                 'public.platform_invoice_quotes(integer,integer)'::regprocedure,
                                 'public.platform_settings_get(text)'::regprocedure,
                                 'public.platform_settings_put(text,jsonb,integer)'::regprocedure,
                                 'public.get_public_config()'::regprocedure,
                                 'public.get_app_config()'::regprocedure)
                   AND NOT owner_role.rolsuper
                   AND owner_role.oid <> (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private')));

  PERFORM _pr_ok('authenticated cannot read the settings table directly',
    _pr_do('3b000000-0000-4000-8000-000000000001',
           'SELECT count(*)::text FROM app_private.platform_settings') LIKE 'ERR 42501%');
  PERFORM _pr_ok('anon may not call platform_settings_get, platform_settings_put or get_app_config',
    _pr_get(NULL, 'price_book') LIKE 'ERR 42501%'
    AND _pr_put(NULL, 'price_book', '{}'::jsonb, 1) LIKE 'ERR 42501%'
    AND _pr_do(NULL, 'SELECT get_app_config()::text') LIKE 'ERR 42501%');
  PERFORM _pr_ok('the service role may not call the settings RPCs either',
    _pr_do(NULL, $q$SELECT platform_settings_get('price_book')::text$q$, true) LIKE 'ERR 42501%'
    AND _pr_do(NULL, 'SELECT get_app_config()::text', true) LIKE 'ERR 42501%');
END $$;

-- ─── 2. the seeds ───────────────────────────────────────────────────────────

DO $$
DECLARE
  v_book jsonb;
BEGIN
  PERFORM _pr_reset();
  -- 20260919120000 (plan 3.10, first half) seeds seller, trial and invoice,
  -- 20260920130000 the mail sender, the four mail templates and the feature
  -- flags, and 20260921120000 legal.impressum and legal.privacy;
  -- tests/rls/settings.sql, announcements.sql and legal-pages.sql cover those.
  -- This file still owns the two keys 3.9 seeded.
  -- price_book is at version 2 since 20261015160000, which added the first
  -- month to it by migration (so nobody saved it); plan_features is untouched.
  PERFORM _pr_ok('the two keys of 3.9 are seeded by nobody, price_book at version 2 and plan_features at 1, among the thirteen that now exist',
    (SELECT count(*) = 2 AND bool_and(updated_by IS NULL
                                      AND version = CASE key WHEN 'price_book' THEN 2 ELSE 1 END)
       FROM app_private.platform_settings
      WHERE key IN ('price_book', 'plan_features'))
    AND (SELECT count(*) = 13 FROM app_private.platform_settings));

  PERFORM _pr_ok('both seeds pass the validator they are written for',
    NOT EXISTS (SELECT 1 FROM app_private.platform_settings s
                 WHERE app_private.platform_settings_problem(s.key, s.value) IS NOT NULL));

  v_book := app_private.platform_setting_value('price_book');
  PERFORM _pr_ok('the seeded price book is today''s: 20/40/70 EUR per car, 5% from 6 cars, 10% from 11, 10% yearly',
    v_book -> 'price_per_car_cents' = '{"basic": 2000, "advanced": 4000, "premium": 7000}'::jsonb
    AND v_book -> 'fleet_discount_tiers' = '[{"min_cars": 6, "percent": 5}, {"min_cars": 11, "percent": 10}]'::jsonb
    AND (v_book ->> 'yearly_discount_percent')::integer = 10);
  PERFORM _pr_ok('the seeded price book carries the owner''s first month: 20000 cents, whatever the plan or the car count',
    (v_book ->> 'first_month_cents')::integer = 20000
    AND app_private.settings_object_keys(v_book)
      = ARRAY['first_month_cents', 'fleet_discount_tiers', 'price_per_car_cents', 'yearly_discount_percent']);

  PERFORM _pr_ok('the seeded feature map names all sixteen gated screens and only the three plans',
    (SELECT count(*) = 16 AND bool_and(value #>> '{}' IN ('basic', 'advanced', 'premium'))
       FROM jsonb_each(app_private.platform_setting_value('plan_features'))));

  -- Since 20260917120000 a written map must name every key the application
  -- knows, so the stored map and that list cannot drift apart unnoticed.
  PERFORM _pr_ok('the seeded feature map names exactly the keys plan_feature_keys() requires',
    app_private.settings_object_keys(app_private.platform_setting_value('plan_features'))
      = app_private.plan_feature_keys()
    AND array_length(app_private.plan_feature_keys(), 1) = 16);

  -- The rule the browser applies to a key the map does not carry.
  PERFORM _pr_ok('the feature map says gehaelter needs premium and belege needs basic',
    app_private.platform_setting_value('plan_features') ->> 'gehaelter' = 'premium'
    AND app_private.platform_setting_value('plan_features') ->> 'belege' = 'basic');
END $$;

-- ─── 3. reading: settings.read, and billing only for the prices ─────────────

DO $$
DECLARE
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  support  constant uuid := '3b000000-0000-4000-8000-000000000002';
  billing  constant uuid := '3b000000-0000-4000-8000-000000000003';
  readonly constant uuid := '3b000000-0000-4000-8000-000000000004';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _pr_ok('read: an owner reads both pricing keys, the price book at version 2',
    _pr_get(owner, 'price_book', 'ok') = 'true'
    AND _pr_get(owner, 'price_book', 'version') = '2'
    AND _pr_get(owner, 'plan_features', 'ok') = 'true');
  PERFORM _pr_ok('read: read_only reads them too (settings.read)',
    _pr_get(readonly, 'price_book', 'ok') = 'true'
    AND _pr_get(readonly, 'plan_features', 'ok') = 'true');
  -- The feature map is not a price: it decides what every customer may open,
  -- and plan 3.A lists "features" under the owner-only settings.manage.
  PERFORM _pr_ok('read: billing reads the price book, and only the price book',
    _pr_get(billing, 'price_book', 'ok') = 'true'
    AND _pr_get(billing, 'plan_features') = 'forbidden');

  -- Plan 3.A gives billing settings.read "(prices)". No capability can say
  -- that, so 3.9 narrows the key set instead: for billing a non-pricing key is
  -- refused, where a role with plain settings.read is only told it is missing.
  -- `seller` is stored since 20260919120000; `a_key_nobody_seeds` never is.
  -- Billing is refused both alike, so it cannot tell a stored key from an
  -- absent one. (This used `mail.sender` until 20260920130000 seeded it.)
  PERFORM _pr_ok('read: billing is refused a non-pricing key, and cannot tell whether it exists',
    _pr_get(billing, 'seller') = 'forbidden' AND _pr_get(billing, 'a_key_nobody_seeds') = 'forbidden');
  PERFORM _pr_ok('read: an owner and read_only are told an unseeded key is simply missing',
    _pr_get(owner, 'a_key_nobody_seeds') = 'not_found' AND _pr_get(readonly, 'a_key_nobody_seeds') = 'not_found');

  PERFORM _pr_ok('read: support holds no settings.read at all',
    _pr_get(support, 'price_book') = 'forbidden' AND _pr_get(support, 'plan_features') = 'forbidden');
  PERFORM _pr_ok('read: a company admin is refused',
    _pr_get(admin_a, 'price_book') = 'forbidden');

  PERFORM _pr_ok('read: a malformed or missing key is a broken contract, not an answer',
    _pr_get(owner, 'Price Book') LIKE 'ERR 22023%'
    AND _pr_do(owner, 'SELECT platform_settings_get(NULL) ->> ''reason''') LIKE 'ERR 22023%');
END $$;

-- ─── 4. the configuration the app reads ─────────────────────────────────────

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_public jsonb;
  v_app    jsonb;
BEGIN
  v_public := _pr_do(NULL, 'SELECT get_public_config()::text')::jsonb;
  PERFORM _pr_ok('get_public_config: anyone gets the price book and the trial length, and nothing else',
    app_private.settings_object_keys(v_public) = ARRAY['price_book', 'trial_days']
    AND v_public -> 'price_book' = app_private.platform_setting_value('price_book')
    AND (v_public ->> 'trial_days')::integer = app_private.signup_trial_days());

  -- Since 20260920130010 feature_flags is the stored setting (seeded {}) and
  -- announcements are the ones that apply to the caller's company now; no
  -- announcement exists in this file, so both are still empty here.
  -- tests/rls/announcements.sql fills them.
  v_app := _pr_do(admin_a, 'SELECT get_app_config()::text')::jsonb;
  PERFORM _pr_ok('get_app_config: a signed-in company user gets prices, features, the trial, the flags and the announcements',
    app_private.settings_object_keys(v_app)
      = ARRAY['announcements', 'feature_flags', 'plan_features', 'price_book', 'trial_days']
    AND v_app -> 'price_book' = app_private.platform_setting_value('price_book')
    AND v_app -> 'plan_features' = app_private.platform_setting_value('plan_features')
    AND v_app -> 'feature_flags' = '{}'::jsonb
    AND v_app -> 'announcements' = '[]'::jsonb);

  PERFORM _pr_ok('neither config function records a platform read: they are public data, not a platform action',
    NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log WHERE action LIKE 'get_%config%'));
END $$;

-- ─── 5. writing ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  support  constant uuid := '3b000000-0000-4000-8000-000000000002';
  billing  constant uuid := '3b000000-0000-4000-8000-000000000003';
  readonly constant uuid := '3b000000-0000-4000-8000-000000000004';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_book   constant jsonb := app_private.platform_setting_value('price_book');
  v_feat   constant jsonb := app_private.platform_setting_value('plan_features');
BEGIN
  -- who may write what
  PERFORM _pr_ok('write: support and read_only may not touch the price book',
    _pr_put(support, 'price_book', v_book, 1) = 'forbidden'
    AND _pr_put(readonly, 'price_book', v_book, 1) = 'forbidden');
  PERFORM _pr_ok('write: a company admin may not either',
    _pr_put(admin_a, 'price_book', v_book, 1) = 'forbidden');
  PERFORM _pr_ok('write: billing holds pricing.manage but not settings.manage',
    _pr_put(billing, 'seller', '{"name": "x"}'::jsonb, 1) = 'forbidden');
  -- A key with no validator. It was `mail.sender` until 20260920130000 gave
  -- that key one.
  PERFORM _pr_ok('write: an owner passes the capability check for any key, and then meets the validator',
    _pr_put(owner, 'a_key_nobody_seeds', '{"from": "x@example.com"}'::jsonb, 1) = 'unknown_key');

  -- the shape of a price book
  PERFORM _pr_ok('write: a price book missing the yearly discount is refused',
    _pr_put(billing, 'price_book',
            '{"price_per_car_cents": {"basic": 1, "advanced": 2, "premium": 3}, "fleet_discount_tiers": []}'::jsonb,
            2, 'problem') = 'price_book');
  PERFORM _pr_ok('write: a fourth plan is refused (open decision D11: the three plans are fixed)',
    _pr_put(billing, 'price_book',
            jsonb_set(v_book, '{price_per_car_cents,gold}', '5000'::jsonb), 2, 'problem')
      = 'price_book.price_per_car_cents');
  PERFORM _pr_ok('write: a price that is not whole cents is refused',
    _pr_put(billing, 'price_book',
            jsonb_set(v_book, '{price_per_car_cents,basic}', '2000.5'::jsonb), 2, 'problem')
      = 'price_book.price_per_car_cents.basic');
  PERFORM _pr_ok('write: a negative price is refused',
    _pr_put(billing, 'price_book',
            jsonb_set(v_book, '{price_per_car_cents,premium}', '-1'::jsonb), 2, 'problem')
      = 'price_book.price_per_car_cents.premium');
  PERFORM _pr_ok('write: tiers that do not increase are refused — a car count must reach one tier only',
    _pr_put(billing, 'price_book',
            jsonb_set(v_book, '{fleet_discount_tiers}',
                      '[{"min_cars": 11, "percent": 10}, {"min_cars": 6, "percent": 5}]'::jsonb), 2, 'problem')
      = 'price_book.fleet_discount_tiers.1');
  PERFORM _pr_ok('write: a discount above 100% is refused',
    _pr_put(billing, 'price_book',
            jsonb_set(v_book, '{yearly_discount_percent}', '101'::jsonb), 2, 'problem')
      = 'price_book.yearly_discount_percent');

  -- 20261015160000: the optional first-month figure
  PERFORM _pr_ok('write: the first month must be whole cents between 0 and the per-car ceiling, as a number',
    _pr_put(billing, 'price_book', jsonb_set(v_book, '{first_month_cents}', '-1'::jsonb), 2, 'problem')
      = 'price_book.first_month_cents'
    AND _pr_put(billing, 'price_book', jsonb_set(v_book, '{first_month_cents}', '200.5'::jsonb), 2, 'problem')
      = 'price_book.first_month_cents'
    AND _pr_put(billing, 'price_book', jsonb_set(v_book, '{first_month_cents}', '1000001'::jsonb), 2, 'problem')
      = 'price_book.first_month_cents'
    AND _pr_put(billing, 'price_book', jsonb_set(v_book, '{first_month_cents}', '"20000"'::jsonb), 2, 'problem')
      = 'price_book.first_month_cents');
  PERFORM _pr_ok('write: a book may name no first month (the three-key book of every earlier release), or a free one',
    app_private.platform_settings_problem('price_book', v_book - 'first_month_cents') IS NULL
    AND app_private.platform_settings_problem('price_book', jsonb_set(v_book, '{first_month_cents}', '0'::jsonb)) IS NULL);
  PERFORM _pr_ok('write: a fifth key that is not the first month is refused',
    _pr_put(billing, 'price_book', v_book || '{"first_month": 20000}'::jsonb, 2, 'problem') = 'price_book');

  -- The feature map is settings.manage, not pricing.manage. Billing may price
  -- the plans; it may not decide what they unlock. pricing.manage is held by
  -- owner AND billing, a partial map is valid on purpose, and the browser reads
  -- a feature the map does not name as premium — so one billing write of `{}`
  -- would lock every gated screen for every non-trial company on basic or
  -- advanced. Plan 3.A lists "features" under the owner-only settings.manage.
  PERFORM _pr_ok('write: billing may not touch the feature map, empty or not',
    _pr_put(billing, 'plan_features', '{"belege": "basic"}'::jsonb, 1) = 'forbidden'
    AND _pr_put(billing, 'plan_features', '{}'::jsonb, 1) = 'forbidden');
  PERFORM _pr_ok('write: support and read_only may not either',
    _pr_put(support, 'plan_features', '{"belege": "basic"}'::jsonb, 1) = 'forbidden'
    AND _pr_put(readonly, 'plan_features', '{"belege": "basic"}'::jsonb, 1) = 'forbidden');

  -- the shape of a feature map, written by an owner (settings.manage)
  PERFORM _pr_ok('write: a feature map naming a plan that does not exist is refused',
    _pr_put(owner, 'plan_features', jsonb_set(v_feat, '{belege}', '"gold"'::jsonb), 1, 'problem')
      = 'plan_features.belege');

  /*
    20260917120000: a written map must name every feature the application
    knows. The browser reads a feature the map does not name as premium
    (src/utils/planFeatures.ts) — fail closed, and that rule stays — so a short
    map would put those screens behind LockedFeaturePage for every non-trial
    company on basic or advanced, silently. Before this, `{}` was a valid map.
  */
  PERFORM _pr_ok('write: an empty feature map is refused, naming the first key it lacks',
    _pr_put(owner, 'plan_features', '{}'::jsonb, 1, 'problem') = 'plan_features.missing.abrechnung'
    AND _pr_put(owner, 'plan_features', '{}'::jsonb, 1) = 'invalid_value');
  PERFORM _pr_ok('write: a map one key short is refused, and the answer lists every key missing',
    _pr_put(owner, 'plan_features', v_feat - 'gehaelter', 1, 'problem') = 'plan_features.missing.gehaelter'
    AND _pr_do(owner, format($f$SELECT (platform_settings_put('plan_features', %L::jsonb, 1)
                                        -> 'missing_features' = '["gehaelter","notizen"]'::jsonb)::text$f$,
                             (v_feat - 'gehaelter' - 'notizen')::text)) = 'true');
  PERFORM _pr_ok('write: a key this build does not know does not make an incomplete map complete',
    _pr_put(owner, 'plan_features',
            (v_feat - 'werkstatt') || '{"a_feature_of_a_later_release": "basic"}'::jsonb, 1, 'problem')
      = 'plan_features.missing.werkstatt');
  PERFORM _pr_ok('write: a complete map is accepted, extra keys and all',
    _pr_put(owner, 'plan_features',
            jsonb_set(v_feat, '{belege}', '"advanced"'::jsonb)
              || '{"a_feature_of_a_later_release": "basic"}'::jsonb, 1, 'ok') = 'true');

  -- the version
  PERFORM _pr_ok('write: a stale version writes nothing and names the current one',
    _pr_put(owner, 'plan_features', v_feat, 1) = 'version_conflict'
    AND _pr_put(owner, 'plan_features', v_feat, 1, 'current_version') = '2');

  PERFORM _pr_ok('write: a NULL value or version is a broken contract',
    _pr_do(owner, 'SELECT platform_settings_put(''price_book'', NULL, 1) ->> ''reason''') LIKE 'ERR 22023%'
    AND _pr_do(owner, format('SELECT platform_settings_put(''price_book'', %L::jsonb, NULL) ->> ''reason''', v_book::text))
          LIKE 'ERR 22023%');

  PERFORM _pr_reset();
  PERFORM _pr_ok('write: only the accepted write changed a row, and it recorded who',
    (SELECT version = 2 AND updated_by = '3b000000-0000-4000-8000-000000000001'
       FROM app_private.platform_settings WHERE key = 'plan_features')
    AND (SELECT version = 2 FROM app_private.platform_settings WHERE key = 'price_book'));
END $$;

-- ─── 6. an alien price book, shared with pricing.parity.test.ts ─────────────

/*
  Nothing here resembles what we ship: other prices, three tiers at other car
  counts, another yearly discount. src/utils/pricing.parity.test.ts reads both
  blocks below out of this file and checks calcPricing() against the same
  numbers, so the browser's formula and the database's are compared against one
  document. A formula that ignored the book and kept a constant would still
  price today's book correctly and fail here.

  The car counts sit either side of each tier: 1 (none), 2 and 3 (3%), 4 and 8
  (25%), 9 and 25 (50%).
*/
CREATE TEMP TABLE _pr_alien (book jsonb, expected jsonb) ON COMMIT DROP;

INSERT INTO _pr_alien (book, expected) VALUES ($alien_book$
{
  "price_per_car_cents": { "basic": 1250, "advanced": 3300, "premium": 9900 },
  "fleet_discount_tiers": [
    { "min_cars": 2, "percent": 3 },
    { "min_cars": 4, "percent": 25 },
    { "min_cars": 9, "percent": 50 }
  ],
  "yearly_discount_percent": 20,
  "first_month_cents": 31700
}
$alien_book$::jsonb, $alien_expected$
{
  "basic|1|monthly": 12.5,      "basic|1|yearly": 120,
  "basic|2|monthly": 24.25,     "basic|2|yearly": 232.8,
  "basic|3|monthly": 36.375,    "basic|3|yearly": 349.2,
  "basic|4|monthly": 37.5,      "basic|4|yearly": 360,
  "basic|8|monthly": 75,        "basic|8|yearly": 720,
  "basic|9|monthly": 56.25,     "basic|9|yearly": 540,
  "basic|25|monthly": 156.25,   "basic|25|yearly": 1500,

  "advanced|1|monthly": 33,     "advanced|1|yearly": 316.8,
  "advanced|2|monthly": 64.02,  "advanced|2|yearly": 614.592,
  "advanced|3|monthly": 96.03,  "advanced|3|yearly": 921.888,
  "advanced|4|monthly": 99,     "advanced|4|yearly": 950.4,
  "advanced|8|monthly": 198,    "advanced|8|yearly": 1900.8,
  "advanced|9|monthly": 148.5,  "advanced|9|yearly": 1425.6,
  "advanced|25|monthly": 412.5, "advanced|25|yearly": 3960,

  "premium|1|monthly": 99,      "premium|1|yearly": 950.4,
  "premium|2|monthly": 192.06,  "premium|2|yearly": 1843.776,
  "premium|3|monthly": 288.09,  "premium|3|yearly": 2765.664,
  "premium|4|monthly": 297,     "premium|4|yearly": 2851.2,
  "premium|8|monthly": 594,     "premium|8|yearly": 5702.4,
  "premium|9|monthly": 445.5,   "premium|9|yearly": 4276.8,
  "premium|25|monthly": 1237.5, "premium|25|yearly": 11880
}
$alien_expected$::jsonb);

DO $$
DECLARE
  billing constant uuid := '3b000000-0000-4000-8000-000000000003';
  v_alien    jsonb;
  v_expected jsonb;
  v_parts    text[];
  v_want     numeric;
  v_got      numeric;
  v_count    integer := 0;
  r          record;
BEGIN
  PERFORM _pr_reset();
  SELECT book, expected INTO v_alien, v_expected FROM _pr_alien;

  PERFORM _pr_ok('alien book: it is a valid price book, and not the one we ship',
    app_private.platform_settings_problem('price_book', v_alien) IS NULL
    AND v_alien IS DISTINCT FROM app_private.platform_setting_value('price_book'));

  -- the formula, on the book as a value
  FOR r IN SELECT key, value::numeric AS want FROM jsonb_each_text(v_expected) LOOP
    v_parts := string_to_array(r.key, '|');
    v_want  := r.want;
    v_got   := app_private.price_book_price(v_alien, v_parts[1], v_parts[2]::integer, v_parts[3]);
    IF v_got IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION 'FAIL: price_book_price(alien, %) = %, expected %', r.key, v_got, v_want;
    END IF;
    v_count := v_count + 1;
  END LOOP;
  PERFORM _pr_ok(format('alien book: price_book_price answers all %s listed combinations', v_count), v_count = 42);

  -- and through the real entry point, once the book is the one in the table
  PERFORM _pr_ok('alien book: billing installs it (pricing.manage), version 2 -> 3',
    _pr_put(billing, 'price_book', v_alien, 2, 'ok') = 'true'
    AND _pr_put(billing, 'price_book', v_alien, 3, 'version') = '4');

  PERFORM _pr_reset();
  FOR r IN SELECT key, value::numeric AS want FROM jsonb_each_text(v_expected) LOOP
    v_parts := string_to_array(r.key, '|');
    v_got   := public.compute_plan_price(v_parts[1], v_parts[2]::integer, v_parts[3]);
    IF v_got IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'FAIL: compute_plan_price(%) = %, expected % — it is not reading the price book',
        r.key, v_got, r.want;
    END IF;
  END LOOP;
  PERFORM _pr_ok('alien book: compute_plan_price prices from the table, not from a constant', true);

  -- the edge cases 20260911120000 had, under the alien book
  PERFORM _pr_ok('alien book: a NULL car count bills one car, a count below one bills one at its own tier',
    public.compute_plan_price('basic', NULL, 'monthly') = 12.5
    AND public.compute_plan_price('basic', 0, 'monthly') = 12.5
    AND public.compute_plan_price('basic', -3, 'monthly') = 12.5);
  PERFORM _pr_ok('alien book: an unknown or NULL plan pays the basic price, and any cycle but yearly is monthly',
    public.compute_plan_price('gold', 1, 'monthly') = 12.5
    AND public.compute_plan_price(NULL, 1, 'monthly') = 12.5
    AND public.compute_plan_price('basic', 1, 'weekly') = 12.5
    AND public.compute_plan_price('basic', 1, NULL) = 12.5);
END $$;

-- ─── 6b. the first month, under the alien book ──────────────────────────────

/*
  The alien book names a first month of 317,00 EUR (31700 cents). Nothing we
  ship resembles it, so a formula that hard-codes the owner's 200,00, or that
  reads the figure from anywhere but the book, fails here. The book is the one
  section 6 installed: the table holds the alien book now.

  Premium, 5 cars under it: 5 x 99,00 x (1 - 25%) = 371,25 a month; yearly
  371,25 x 12 x (1 - 20%) = 3564,00, which is 297,00 in twelve parts.
*/
DO $$
DECLARE
  v_alien  jsonb;
  v_plan   text;
  v_cars   integer;
  v_cycle  text;
  v_count  integer := 0;
BEGIN
  PERFORM _pr_reset();
  SELECT book INTO v_alien FROM _pr_alien;

  FOREACH v_plan IN ARRAY ARRAY['basic', 'advanced', 'premium', 'gold'] LOOP
    FOREACH v_cars IN ARRAY ARRAY[1, 2, 5, 9, 25] LOOP
      FOREACH v_cycle IN ARRAY ARRAY['monthly', 'yearly'] LOOP
        IF public.compute_plan_price(v_plan, v_cars, v_cycle, true) IS DISTINCT FROM 317
           OR app_private.price_book_price(v_alien, v_plan, v_cars, v_cycle, true) IS DISTINCT FROM 317 THEN
          RAISE EXCEPTION 'FAIL: the first invoice of (%, %, %) is not the alien book''s 317,00', v_plan, v_cars, v_cycle;
        END IF;
        -- the flag false is the per-car price, unchanged
        IF public.compute_plan_price(v_plan, v_cars, v_cycle, false)
             IS DISTINCT FROM app_private.price_book_price(v_alien, v_plan, v_cars, v_cycle) THEN
          RAISE EXCEPTION 'FAIL: the flag false changed the per-car price of (%, %, %)', v_plan, v_cars, v_cycle;
        END IF;
        v_count := v_count + 1;
      END LOOP;
    END LOOP;
  END LOOP;
  PERFORM _pr_ok(format('alien book: the first invoice is its 317,00 for all %s plan, car and cycle combinations', v_count), v_count = 40);

  -- A book that names no first month has none: the flag changes nothing. The
  -- 42 numbers of section 6 are the witness.
  PERFORM _pr_ok('alien book without a first month: the flag true prices per car, all 42 listed combinations',
    (SELECT bool_and(app_private.price_book_price(v_alien - 'first_month_cents', split_part(e.key, '|', 1),
                                                  split_part(e.key, '|', 2)::integer, split_part(e.key, '|', 3), true)
                       = e.value::numeric)
       FROM _pr_alien a, jsonb_each_text(a.expected) e));

  PERFORM _pr_ok('alien book: compute_plan_price defaults the flag to false (the three-argument call is the per-car price)',
    public.compute_plan_price('premium', 5, 'monthly') = 371.25
    AND public.compute_plan_price('premium', 5, 'monthly', true) = 317);

  PERFORM _pr_ok('alien book: an invoice amount is whole cents — flat first, then per car, a yearly company in twelve parts',
    app_private.invoice_amount_cents(v_alien, 'premium', 5, 'monthly', true)  = 31700
    AND app_private.invoice_amount_cents(v_alien, 'premium', 5, 'yearly',  true)  = 31700
    AND app_private.invoice_amount_cents(v_alien, 'premium', 5, 'monthly', false) = 37125
    AND app_private.invoice_amount_cents(v_alien, 'premium', 5, 'yearly',  false) = 29700
    AND app_private.invoice_amount_cents(v_alien - 'first_month_cents', 'premium', 5, 'monthly', true) = 37125);
END $$;

/** One quote of platform_invoice_quotes(month, year) as p_user: a field of one company's item. */
CREATE OR REPLACE FUNCTION _pr_quote(p_user uuid, p_month integer, p_year integer, p_company uuid,
                                     p_field text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_answer text;
BEGIN
  v_answer := _pr_do(p_user, format('SELECT platform_invoice_quotes(%s, %s)::text', p_month, p_year));
  IF v_answer LIKE 'ERR %' THEN
    RETURN v_answer;
  END IF;
  RETURN coalesce((SELECT i ->> p_field
                     FROM jsonb_array_elements(v_answer::jsonb -> 'items') AS t(i)
                    WHERE i ->> 'company_id' = p_company::text), '<absent>');
END $$;

/*
  Real companies, subscriptions and invoices. Each case below is its own
  assertion, so a mutation that breaks one direction does not hide behind the
  other:

    f1  premium, 5 cars, monthly, no invoice yet
    f2  premium, 5 cars, yearly, an invoice for 10/2026
    f3  premium, 5 cars, monthly, only a CANCELED invoice for 9/2026
    f4  premium, 5 cars, monthly, an invoice for 12/2025 (a year boundary)
    f5  premium, 5 cars, monthly, subscription paused
*/
INSERT INTO subscription_plans (id, name, monthly_price, included_cars)
VALUES ('f1000000-0000-4000-8000-0000000000aa', 'FM plan', 200, 5);

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status) VALUES
  ('f1000000-0000-4000-8000-000000000001', 'FM f1', 'fm-f1', 'approved', 'active', 'basic', 'inactive'),
  ('f1000000-0000-4000-8000-000000000002', 'FM f2', 'fm-f2', 'approved', 'active', 'basic', 'inactive'),
  ('f1000000-0000-4000-8000-000000000003', 'FM f3', 'fm-f3', 'approved', 'active', 'basic', 'inactive'),
  ('f1000000-0000-4000-8000-000000000004', 'FM f4', 'fm-f4', 'approved', 'active', 'basic', 'inactive'),
  ('f1000000-0000-4000-8000-000000000005', 'FM f5', 'fm-f5', 'approved', 'active', 'basic', 'inactive');

UPDATE companies
   SET plan = 'premium', subscription_car_limit = 5,
       billing_cycle = CASE id WHEN 'f1000000-0000-4000-8000-000000000002' THEN 'yearly' ELSE 'monthly' END
 WHERE id::text LIKE 'f1000000-0000-4000-8000-00000000000%';

INSERT INTO company_subscriptions (id, company_id, plan_id, status, billing_day, monthly_price)
SELECT ('f2000000-0000-4000-8000-00000000000' || right(c.id::text, 1))::uuid, c.id,
       'f1000000-0000-4000-8000-0000000000aa',
       CASE WHEN c.id = 'f1000000-0000-4000-8000-000000000005' THEN 'paused' ELSE 'active' END,
       1, 200
  FROM companies c
 WHERE c.id::text LIKE 'f1000000-0000-4000-8000-00000000000%';

INSERT INTO subscription_invoices (company_id, subscription_id, invoice_month, invoice_year, invoice_number, amount, status, due_date) VALUES
  ('f1000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000002', 10, 2026, 'FM-2026-0002', 200, 'open',     '2026-10-05'),
  ('f1000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000003',  9, 2026, 'FM-2026-0003', 200, 'canceled', '2026-09-05'),
  ('f1000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-000000000004', 12, 2025, 'FM-2025-0004', 200, 'paid',     '2025-12-05');

DO $$
DECLARE
  billing  constant uuid := '3b000000-0000-4000-8000-000000000003';
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  support  constant uuid := '3b000000-0000-4000-8000-000000000002';
  readonly constant uuid := '3b000000-0000-4000-8000-000000000004';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  f1 constant uuid := 'f1000000-0000-4000-8000-000000000001';
  f2 constant uuid := 'f1000000-0000-4000-8000-000000000002';
  f3 constant uuid := 'f1000000-0000-4000-8000-000000000003';
  f4 constant uuid := 'f1000000-0000-4000-8000-000000000004';
  f5 constant uuid := 'f1000000-0000-4000-8000-000000000005';
  v_before bigint;
BEGIN
  -- THE FIRST INVOICE is the flat price: 317,00, whatever the car count is.
  PERFORM _pr_ok('quote: a company with no invoice at all is quoted its FIRST invoice at the flat price',
    _pr_quote(billing, 10, 2026, f1, 'first_invoice') = 'true'
    AND _pr_quote(billing, 10, 2026, f1, 'amount_cents') = '31700');

  -- THE SECOND INVOICE is the book per car. f2 is a yearly company: 3564,00 a
  -- year in twelve parts is 297,00.
  PERFORM _pr_ok('quote: the month after its first invoice, a yearly company is quoted per car in twelve parts, not the flat price',
    _pr_quote(billing, 11, 2026, f2, 'first_invoice') = 'false'
    AND _pr_quote(billing, 11, 2026, f2, 'amount_cents') = '29700');

  -- Its own period is not "earlier": the invoice that already exists is
  -- still the first, so a re-run of generation quotes the same figure.
  PERFORM _pr_ok('quote: the period that already holds the first invoice is still quoted as the first',
    _pr_quote(billing, 10, 2026, f2, 'first_invoice') = 'true'
    AND _pr_quote(billing, 10, 2026, f2, 'amount_cents') = '31700');

  -- Per car for a monthly company in a later month: 5 x 99,00 less 25% = 371,25.
  PERFORM _pr_ok('quote: a monthly company''s later invoice is its price per car, 5 x 99,00 less 25%',
    _pr_quote(billing, 12, 2026, f4, 'first_invoice') = 'false'
    AND _pr_quote(billing, 12, 2026, f4, 'amount_cents') = '37125');

  -- Earlier means earlier in time, across a year boundary.
  PERFORM _pr_ok('quote: an invoice of December 2025 is earlier than January 2026',
    _pr_quote(billing, 1, 2026, f4, 'first_invoice') = 'false'
    AND _pr_quote(billing, 1, 2026, f4, 'amount_cents') = '37125');
  PERFORM _pr_ok('quote: an invoice of December 2025 is not earlier than November 2025 — that one would be the first',
    _pr_quote(billing, 11, 2025, f4, 'first_invoice') = 'true'
    AND _pr_quote(billing, 11, 2025, f4, 'amount_cents') = '31700');

  -- A cancelled invoice never happened.
  PERFORM _pr_ok('quote: a company whose only earlier invoice is cancelled is still quoted its first',
    _pr_quote(billing, 10, 2026, f3, 'first_invoice') = 'true'
    AND _pr_quote(billing, 10, 2026, f3, 'amount_cents') = '31700');

  PERFORM _pr_ok('quote: only active subscriptions are quoted',
    _pr_quote(billing, 10, 2026, f5, 'amount_cents') = '<absent>');

  -- The item carries the company's own plan, car limit and cycle.
  PERFORM _pr_ok('quote: the item names the company''s plan, car limit and billing cycle',
    _pr_quote(billing, 10, 2026, f1, 'plan') = 'premium'
    AND _pr_quote(billing, 10, 2026, f1, 'car_limit') = '5'
    AND _pr_quote(billing, 10, 2026, f2, 'billing_cycle') = 'yearly');

  -- Authority: billing.manage, which owner and billing hold.
  PERFORM _pr_ok('quote: owner and billing are answered',
    _pr_quote(owner, 10, 2026, f1, 'amount_cents') = '31700'
    AND _pr_quote(billing, 10, 2026, f1, 'amount_cents') = '31700');
  PERFORM _pr_ok('quote: support and read_only are refused with a return value, not an exception',
    _pr_do(support,  'SELECT platform_invoice_quotes(10, 2026) ->> ''reason''') = 'not_authorized'
    AND _pr_do(readonly, 'SELECT platform_invoice_quotes(10, 2026) ->> ''reason''') = 'not_authorized');
  PERFORM _pr_ok('quote: a company admin is refused and writes no audit row',
    _pr_do(admin_a, 'SELECT platform_invoice_quotes(10, 2026) ->> ''reason''') = 'not_authorized'
    AND NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log WHERE actor_user_id = admin_a));
  PERFORM _pr_ok('quote: anon and the service role hold no EXECUTE',
    _pr_do(NULL, 'SELECT platform_invoice_quotes(10, 2026)::text') LIKE 'ERR 42501%'
    AND _pr_do(NULL, 'SELECT platform_invoice_quotes(10, 2026)::text', true) LIKE 'ERR 42501%');
  PERFORM _pr_ok('quote: a month or year out of range is a broken contract',
    _pr_do(billing, 'SELECT platform_invoice_quotes(13, 2026)::text') LIKE 'ERR 22023%'
    AND _pr_do(billing, 'SELECT platform_invoice_quotes(0, 2026)::text') LIKE 'ERR 22023%'
    AND _pr_do(billing, 'SELECT platform_invoice_quotes(5, 2019)::text') LIKE 'ERR 22023%'
    AND _pr_do(billing, 'SELECT platform_invoice_quotes(NULL, 2026)::text') LIKE 'ERR 22023%');

  -- The audit: one read row per call, a refusal included.
  PERFORM _pr_reset();
  SELECT count(*) INTO v_before FROM app_private.platform_audit_log WHERE action = 'platform_read.invoice_quotes';
  PERFORM _pr_do(billing, 'SELECT platform_invoice_quotes(10, 2026)::text');
  PERFORM _pr_do(support, 'SELECT platform_invoice_quotes(10, 2026)::text');
  PERFORM _pr_reset();
  PERFORM _pr_ok('quote: one read row per call — ok for billing, denied for support',
    (SELECT count(*) FROM app_private.platform_audit_log WHERE action = 'platform_read.invoice_quotes') = v_before + 2
    AND EXISTS (SELECT 1 FROM app_private.platform_audit_log
                 WHERE action = 'platform_read.invoice_quotes' AND category = 'read'
                   AND outcome = 'denied' AND actor_user_id = support)
    AND (SELECT after_value ->> 'returned' FROM app_private.platform_audit_log
          WHERE action = 'platform_read.invoice_quotes' AND outcome = 'ok' AND actor_user_id = billing
          ORDER BY id DESC LIMIT 1) IS NOT NULL);
END $$;

-- Fail closed: no price book, no price. Undone immediately.
SAVEPOINT before_deleting_the_book;
DELETE FROM app_private.platform_settings WHERE key = 'price_book';
DO $$
BEGIN
  PERFORM _pr_ok('compute_plan_price raises rather than pricing a plan with no price book',
    _pr_do('3b000000-0000-4000-8000-000000000001',
           $q$SELECT compute_plan_price('basic', 1, 'monthly')::text$q$) LIKE 'ERR P0002%');
END $$;
ROLLBACK TO SAVEPOINT before_deleting_the_book;

-- ─── 7. the audit log ───────────────────────────────────────────────────────

DO $$
DECLARE
  billing constant uuid := '3b000000-0000-4000-8000-000000000003';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_row   app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _pr_reset();

  PERFORM _pr_ok('audit: every read is recorded, as category read',
    (SELECT count(*) > 0 AND bool_and(category = 'read')
       FROM app_private.platform_audit_log WHERE action = 'platform_settings.get'));
  PERFORM _pr_ok('audit: every write attempt is recorded, as category settings',
    (SELECT count(*) > 0 AND bool_and(category = 'settings')
       FROM app_private.platform_audit_log WHERE action = 'platform_settings.put'));

  PERFORM _pr_ok('audit: refusals are recorded too — denied for a capability, error for a bad value or version',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log
             WHERE action = 'platform_settings.get' AND outcome = 'denied')
    AND EXISTS (SELECT 1 FROM app_private.platform_audit_log
                 WHERE action = 'platform_settings.put' AND outcome = 'denied')
    AND EXISTS (SELECT 1 FROM app_private.platform_audit_log
                 WHERE action = 'platform_settings.put' AND outcome = 'error'
                   AND after_value ->> 'reason' = 'invalid_value')
    AND EXISTS (SELECT 1 FROM app_private.platform_audit_log
                 WHERE action = 'platform_settings.put' AND outcome = 'error'
                   AND after_value ->> 'reason' = 'version_conflict'));

  SELECT * INTO v_row FROM app_private.platform_audit_log
   WHERE action = 'platform_settings.get' AND outcome = 'ok' ORDER BY id LIMIT 1;
  PERFORM _pr_ok('audit: a read names the key and the version, and never the value itself',
    v_row.target_type = 'platform_setting'
    AND v_row.target_id IN ('price_book', 'plan_features')
    AND v_row.after_value ? 'version'
    AND NOT (v_row.after_value ? 'value')
    AND v_row.before_value IS NULL
    AND v_row.actor_role IN ('owner', 'billing', 'read_only'));

  SELECT * INTO v_row FROM app_private.platform_audit_log
   WHERE action = 'platform_settings.put' AND outcome = 'ok' AND target_id = 'price_book'
   ORDER BY id DESC LIMIT 1;
  PERFORM _pr_ok('audit: an accepted write keeps the value before and the value after, with both versions',
    v_row.actor_user_id = billing
    AND v_row.actor_role = 'billing'
    AND (v_row.before_value ->> 'version')::integer = 3
    AND (v_row.after_value  ->> 'version')::integer = 4
    AND v_row.before_value -> 'value' IS NOT NULL
    AND v_row.after_value  -> 'value' = (SELECT book FROM _pr_alien));

  -- As in platform_audit_record: a caller who is not platform staff is refused
  -- without a row, or any signed-in company user could fill the append-only log.
  PERFORM _pr_ok('audit: a company admin''s refused calls leave no row at all',
    NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log WHERE actor_user_id = admin_a));

  PERFORM _pr_ok('audit: the log is still append-only',
    (SELECT count(*) FROM app_private.platform_audit_log) > 0);
END $$;

-- ─── 8. the settings namespace belongs to the database ──────────────────────

/*
  This slice deliberately does NOT redefine platform_audit_record. Since
  20260916150000_platform_audit_record_allowlist.sql (plan 3.5) that door takes
  only the actions listed in app_private.platform_edge_audit_actions(), and no
  platform_settings action is on that list — a stricter guard than a reserved
  namespace, and the one this slice relies on: a settings row is written by
  platform_settings_get/put inside the database, so nothing an edge function can
  send may forge one.

  Asserted here as well as in platform-readmodels.sql section 9, because the
  property belongs to this slice even though the function belongs to 3.5. If a
  later migration redefines that function and drops either rule, this fails too.
*/
DO $$
DECLARE
  owner    constant uuid := '3b000000-0000-4000-8000-000000000001';
  readonly constant uuid := '3b000000-0000-4000-8000-000000000004';
  v_action text;
BEGIN
  PERFORM _pr_ok('platform_audit_record refuses to forge a platform_settings row: the database writes those',
    _pr_do(owner, $q$SELECT platform_audit_record('read', 'platform_settings.get', 'ok')::text$q$)
      LIKE 'ERR 22023%'
    AND _pr_do(owner, $q$SELECT platform_audit_record('write', 'platform_settings.put', 'ok')::text$q$)
      LIKE 'ERR 22023%'
    AND _pr_do(readonly, $q$SELECT platform_audit_record('write', 'platform_settings', 'ok')::text$q$)
      LIKE 'ERR 22023%');

  -- The namespaces the database writes itself, whichever migration reserved
  -- them. read_only is the weakest active role, and the door admits every
  -- active role, so it is the one that would forge a row.
  FOREACH v_action IN ARRAY ARRAY['platform_staff.delete', 'legacy.subscription_admin_actions',
                                  'auth.sign_in', 'platform_read.companies_list'] LOOP
    PERFORM _pr_ok(format('platform_audit_record refuses the reserved action %s', v_action),
      _pr_do(readonly, format('SELECT platform_audit_record(%L, %L, %L)::text', 'read', v_action, 'ok'))
        LIKE 'ERR 22023%');
  END LOOP;

  -- The allow-list, in both directions: an action nothing sends is refused, one
  -- the edge functions do send still records.
  PERFORM _pr_ok('platform_audit_record refuses an action no edge function sends',
    _pr_do(owner, $q$SELECT platform_audit_record('read', 'pricing.probe', 'ok')::text$q$)
      LIKE 'ERR 22023%');
  PERFORM _pr_ok('platform_audit_record still records a listed action',
    _pr_do(readonly, $q$SELECT (platform_audit_record('read', 'manage_users.list', 'ok') IS NOT NULL)::text$q$)
      = 'true');
END $$;

-- ─── 9. the per-actor cap on settings rows ──────────────────────────────────

/*
  20260917120000. Every settings call by an active staff role appends to the
  append-only log — which nothing may delete from — and read_only holds
  settings.read, so before this a loop over platform_settings_get grew the log
  as fast as the network allowed.

  One actor now gets 120 settings rows a minute: platform_audit_record's number,
  counted the same way, over one budget for reads and writes together. The
  refusal past that writes no row at all, because recording "you have written
  too many rows" is the very row the cap exists to stop. It is a return value,
  not an exception: these RPCs raise only on a broken argument contract.

  A principal of its own, so the arithmetic is exactly 120 rather than "120
  minus whatever the sections above spent". The whole file is one transaction,
  so now() does not move and every row is inside the same minute.
*/

INSERT INTO auth.users (id, email) VALUES
  ('3b000000-0000-4000-8000-000000000005', 'pr-capped@test.invalid');

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, is_super_admin, status) VALUES
  ('3b000000-0000-4000-8000-000000000005', 'pr-capped@test.invalid', 'PR Capped', 'admin', NULL, NULL, false, 'active');

INSERT INTO app_private.platform_staff (user_id, role, note) VALUES
  ('3b000000-0000-4000-8000-000000000005', 'read_only', 'pr');

DO $$
DECLARE
  capped  constant uuid := '3b000000-0000-4000-8000-000000000005';
  owner   constant uuid := '3b000000-0000-4000-8000-000000000001';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_index integer;
  v_last  jsonb;
BEGIN
  PERFORM _pr_become(capped);
  FOR v_index IN 1 .. 120 LOOP
    v_last := public.platform_settings_get('price_book');
  END LOOP;
  PERFORM _pr_reset();

  PERFORM _pr_ok('cap: the first 120 reads are answered, and each one recorded',
    (v_last ->> 'ok') = 'true'
    AND (SELECT count(*) FROM app_private.platform_audit_log
          WHERE actor_user_id = capped AND action = 'platform_settings.get') = 120);

  PERFORM _pr_ok('cap: the 121st read is refused as rate_limited',
    _pr_get(capped, 'price_book') = 'rate_limited');
  -- Reads and writes share one budget. The version below is never looked at:
  -- the cap is checked before the capability and before the row.
  PERFORM _pr_ok('cap: a write by the same actor is refused on the same budget',
    _pr_put(capped, 'price_book', v_last -> 'value', 1) = 'rate_limited');

  PERFORM _pr_reset();
  PERFORM _pr_ok('cap: and those refusals wrote nothing — recording them is what the cap prevents',
    (SELECT count(*) FROM app_private.platform_audit_log WHERE actor_user_id = capped) = 120);

  -- The budget belongs to the actor, not to the platform.
  PERFORM _pr_ok('cap: another staff account is unaffected',
    _pr_get(owner, 'price_book', 'ok') = 'true');

  -- Order matters: a caller who is not platform staff is still refused before
  -- the cap is consulted, and still leaves no row.
  PERFORM _pr_ok('cap: a company admin is forbidden, not rate limited, and writes nothing',
    _pr_get(admin_a, 'price_book') = 'forbidden');
  PERFORM _pr_reset();
  PERFORM _pr_ok('cap: …and still has no row of its own',
    NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log WHERE actor_user_id = admin_a));
END $$;

DO $$ BEGIN RAISE NOTICE '── pricing: all checks passed ──'; END $$;

ROLLBACK;
