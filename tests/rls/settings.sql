/*
  Plan 3.10: the seller, the trial length and the invoice defaults (first half,
  migration 20260919120000), and the mail sender, the four code-mail templates
  and the invoice screen reading the seller (second half, migration
  20260920130000).

  Runs after assertions.sql, the matrix, platform-authority.sql and pricing.sql,
  against the same throwaway database, as supabase_admin. Every check raises on
  failure; a silent run is a pass. The whole file is one transaction rolled back
  at the end, so the files after it see the database as the seeds left it.

  pricing.sql covers the settings machinery itself — the grants on the table and
  the two RPCs, the version check, the per-actor cap, the audit rows. This file
  covers only what 3.10's first half adds, and the helpers below are named apart
  from that file's so the two can never resolve to each other.

  What is covered, in order:

    1. seeds     the three keys exist, are valid, are at version 1, and the
                 seller is the eleven fields the invoice page reads
    2. reading   settings.read by role: owner and read_only read all three,
                 billing is refused all three (it holds settings.read for the
                 prices alone), support holds none
    3. writing   settings.manage — owner only — for all three; every validator
                 path; the version check
    4. the trial **the rule this slice preserves**: a signup gets a trial
                 ending now() plus the setting's days, and changing the setting
                 moves no trial that already exists
    5. audit     each write recorded under category `settings`, with the value
                 before and after; a refusal recorded as `denied`
    6. scope     a key with no validator is still refused, and neither settings
                 RPC lost its cap or its audit row
    7. mail      the sender and the four templates: seeds that change nothing,
                 who may read and write them, and the rules a template may not
                 break — the code never in a subject above all
    8. invoice   platform_invoice_seller(): every staff role reads the sender
                 printed on the invoices it can read, one audited row per call,
                 inside the settings budget
    9. delivery  mail_delivery_settings(): the service role, and nobody else,
                 reads the sender and a template as stored
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _st_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

/** Back to the connecting superuser with no JWT claims at all. */
CREATE OR REPLACE FUNCTION _st_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

CREATE OR REPLACE FUNCTION _st_become(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _st_reset();
  IF p_user IS NULL THEN
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

/*
  Run one SELECT as the principal and return its scalar, or `ERR <sqlstate>
  <message>`. What the statement did is KEPT: these RPCs are meant to write
  audit rows and section 5 reads them.
*/
CREATE OR REPLACE FUNCTION _st_do(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _st_become(p_user);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _st_reset();
  RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION _st_get(p_user uuid, p_key text, p_field text DEFAULT 'reason') RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN _st_do(p_user, format('SELECT platform_settings_get(%L) ->> %L', p_key, p_field));
END $$;

CREATE OR REPLACE FUNCTION _st_put(p_user uuid, p_key text, p_value jsonb, p_version integer,
                                   p_field text DEFAULT 'reason') RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN _st_do(p_user, format('SELECT platform_settings_put(%L, %L::jsonb, %s) ->> %L',
                               p_key, p_value::text, p_version, p_field));
END $$;

-- ─── principals ─────────────────────────────────────────────────────────────

/*
    3c..01 st-owner      owner
    3c..02 st-support    support
    3c..03 st-billing    billing
    3c..04 st-readonly   read_only
  plus admin-a from seed.sql (a company admin).
*/
INSERT INTO auth.users (id, email) VALUES
  ('3c000000-0000-4000-8000-000000000001', 'st-owner@test.invalid'),
  ('3c000000-0000-4000-8000-000000000002', 'st-support@test.invalid'),
  ('3c000000-0000-4000-8000-000000000003', 'st-billing@test.invalid'),
  ('3c000000-0000-4000-8000-000000000004', 'st-readonly@test.invalid');

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, is_super_admin, status) VALUES
  ('3c000000-0000-4000-8000-000000000001', 'st-owner@test.invalid',    'ST Owner',    'admin', NULL, NULL, false, 'active'),
  ('3c000000-0000-4000-8000-000000000002', 'st-support@test.invalid',  'ST Support',  'admin', NULL, NULL, false, 'active'),
  ('3c000000-0000-4000-8000-000000000003', 'st-billing@test.invalid',  'ST Billing',  'admin', NULL, NULL, false, 'active'),
  ('3c000000-0000-4000-8000-000000000004', 'st-readonly@test.invalid', 'ST Readonly', 'admin', NULL, NULL, false, 'active');

INSERT INTO app_private.platform_staff (user_id, role, note) VALUES
  ('3c000000-0000-4000-8000-000000000001', 'owner',     'st'),
  ('3c000000-0000-4000-8000-000000000002', 'support',   'st'),
  ('3c000000-0000-4000-8000-000000000003', 'billing',   'st'),
  ('3c000000-0000-4000-8000-000000000004', 'read_only', 'st');

-- ─── 1. the seeds ───────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seller  jsonb;
  v_trial   jsonb;
  v_invoice jsonb;
BEGIN
  PERFORM _st_reset();

  -- 3.9's two, 3.10's first three, 20260920130000's six (the mail sender,
  -- four templates, the feature flags) and 20260921120000's legal.impressum
  -- and legal.privacy. Section 7 and announcements.sql cover the six,
  -- legal-pages.sql the last two.
  PERFORM _st_ok('thirteen keys now, the three of 3.10''s first half among them',
    (SELECT count(*) = 13 FROM app_private.platform_settings)
    AND (SELECT count(*) = 3 FROM app_private.platform_settings
          WHERE key IN ('seller', 'trial', 'invoice') AND version = 1 AND updated_by IS NULL));

  PERFORM _st_ok('every stored document passes the validator it is written for',
    NOT EXISTS (SELECT 1 FROM app_private.platform_settings s
                 WHERE app_private.platform_settings_problem(s.key, s.value) IS NOT NULL));

  v_seller  := app_private.platform_setting_value('seller');
  v_trial   := app_private.platform_setting_value('trial');
  v_invoice := app_private.platform_setting_value('invoice');

  -- Exactly the columns SubscriptionBillingPage selects for the invoice PDF,
  -- with company_name as `name`. Adding one is a data protection decision, so
  -- the list is pinned key by key rather than counted.
  PERFORM _st_ok('seller: the eleven fields the invoice page reads, all strings',
    app_private.settings_object_keys(v_seller) = ARRAY[
      'account_holder', 'bank_name', 'bic', 'city', 'house_number', 'iban',
      'name', 'postal_code', 'street', 'tax_number', 'vat_id']
    AND (SELECT bool_and(jsonb_typeof(value) = 'string') FROM jsonb_each(v_seller)));

  /*
    The fixture's platform owner (seed.sql) has no company, so the migration
    found no company_settings row to copy and seeded the fallback the invoice
    page already applies: `s?.company_name || 'El-Professor'` and empty strings.
    On production it copies the real row; the migration's own self-check 3
    compares the seeded document with that row field by field, which is the only
    place the comparison can be made.
  */
  PERFORM _st_ok('seller: with no platform owner in a company, the El-Professor fallback and nothing else',
    v_seller ->> 'name' = 'El-Professor'
    AND (SELECT count(*) = 0 FROM jsonb_each_text(v_seller) e
          WHERE e.key <> 'name' AND e.value <> ''));

  PERFORM _st_ok('trial: exactly {"days": 14}, the length the constant applied',
    app_private.settings_object_keys(v_trial) = ARRAY['days']
    AND (v_trial ->> 'days')::integer = 14);

  PERFORM _st_ok('invoice: the prefix, the digits and the payment method the code uses today',
    app_private.settings_object_keys(v_invoice)
      = ARRAY['default_payment_method', 'number_digits', 'number_prefix']
    AND v_invoice ->> 'number_prefix' = 'INV'
    AND (v_invoice ->> 'number_digits')::integer = 4
    AND v_invoice ->> 'default_payment_method' = 'cash');

  -- generate_invoice_number still builds the number those two describe, so the
  -- seeded values are not a guess about the format.
  PERFORM _st_ok('invoice: the seed describes the number generate_invoice_number actually builds',
    public.generate_invoice_number(2026) =
      (v_invoice ->> 'number_prefix') || '-2026-'
      || lpad('1', (v_invoice ->> 'number_digits')::integer, '0'));
END $$;

-- ─── 2. reading ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  owner    constant uuid := '3c000000-0000-4000-8000-000000000001';
  support  constant uuid := '3c000000-0000-4000-8000-000000000002';
  billing  constant uuid := '3c000000-0000-4000-8000-000000000003';
  readonly constant uuid := '3c000000-0000-4000-8000-000000000004';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_key    text;
BEGIN
  FOREACH v_key IN ARRAY ARRAY['seller', 'trial', 'invoice'] LOOP
    PERFORM _st_ok(format('read: an owner reads %s at version 1', v_key),
      _st_get(owner, v_key, 'ok') = 'true' AND _st_get(owner, v_key, 'version') = '1');
    PERFORM _st_ok(format('read: read_only reads %s too (settings.read)', v_key),
      _st_get(readonly, v_key, 'ok') = 'true');

    -- Plan 3.A gives billing settings.read "(prices)". No capability can say
    -- that, so 3.9 narrowed the key set instead, and these three inherit it:
    -- the seller's bank details are not a price.
    PERFORM _st_ok(format('read: billing is refused %s — it holds settings.read for the prices alone', v_key),
      _st_get(billing, v_key) = 'forbidden');
    PERFORM _st_ok(format('read: support holds no settings.read, so %s is refused', v_key),
      _st_get(support, v_key) = 'forbidden');
    PERFORM _st_ok(format('read: a company admin is refused %s', v_key),
      _st_get(admin_a, v_key) = 'forbidden');
  END LOOP;

  PERFORM _st_ok('read: the seller comes back whole, with the bank details it carries',
    _st_do(owner, $q$SELECT (platform_settings_get('seller') -> 'value' ? 'iban')::text$q$) = 'true');
END $$;

-- ─── 3. writing ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  owner    constant uuid := '3c000000-0000-4000-8000-000000000001';
  support  constant uuid := '3c000000-0000-4000-8000-000000000002';
  billing  constant uuid := '3c000000-0000-4000-8000-000000000003';
  readonly constant uuid := '3c000000-0000-4000-8000-000000000004';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_seller constant jsonb := app_private.platform_setting_value('seller');
  v_inv    constant jsonb := app_private.platform_setting_value('invoice');
  v_key    text;
BEGIN
  -- Who may write. All three are settings.manage, which plan 3.A gives the
  -- owner alone: they decide what every invoice says and how long every new
  -- company gets for free.
  FOREACH v_key IN ARRAY ARRAY['seller', 'trial', 'invoice'] LOOP
    PERFORM _st_ok(format('write: billing holds pricing.manage but not settings.manage, so %s is refused', v_key),
      _st_put(billing, v_key, app_private.platform_setting_value(v_key), 1) = 'forbidden');
    PERFORM _st_ok(format('write: support and read_only may not touch %s either', v_key),
      _st_put(support, v_key, app_private.platform_setting_value(v_key), 1) = 'forbidden'
      AND _st_put(readonly, v_key, app_private.platform_setting_value(v_key), 1) = 'forbidden');
    PERFORM _st_ok(format('write: a company admin may not touch %s', v_key),
      _st_put(admin_a, v_key, app_private.platform_setting_value(v_key), 1) = 'forbidden');
  END LOOP;

  -- The seller's shape.
  PERFORM _st_ok('write: a seller missing a field is refused, and a seller with an extra one too',
    _st_put(owner, 'seller', v_seller - 'bic', 1, 'problem') = 'seller'
    AND _st_put(owner, 'seller', v_seller || '{"country": "Deutschland"}'::jsonb, 1, 'problem') = 'seller');
  PERFORM _st_ok('write: a seller field that is not a string is refused, and named',
    _st_put(owner, 'seller', jsonb_set(v_seller, '{postal_code}', '42651'::jsonb), 1, 'problem')
      = 'seller.postal_code');
  PERFORM _st_ok('write: a nameless seller is refused — the invoice would have no sender',
    _st_put(owner, 'seller', jsonb_set(v_seller, '{name}', '"   "'::jsonb), 1, 'problem') = 'seller.name');
  -- These strings are drawn into a PDF line by line.
  PERFORM _st_ok('write: a control character in a seller field is refused',
    _st_put(owner, 'seller', jsonb_set(v_seller, '{street}', '"Haupt\nstrasse"'::jsonb), 1, 'problem')
      = 'seller.street'
    AND _st_put(owner, 'seller', jsonb_set(v_seller, '{iban}', '"DE00\t1234"'::jsonb), 1, 'problem')
      = 'seller.iban');
  PERFORM _st_ok('write: a seller field longer than 200 characters is refused',
    _st_put(owner, 'seller', jsonb_set(v_seller, '{city}', to_jsonb(repeat('x', 201))), 1, 'problem')
      = 'seller.city');
  PERFORM _st_ok('write: every field but the name may be blank — not every seller has a VAT id',
    _st_put(owner, 'seller',
            jsonb_set(jsonb_set(v_seller, '{vat_id}', '""'::jsonb), '{bic}', '""'::jsonb), 1, 'ok') = 'true');

  -- The trial's shape. Version 1 was spent by the accepted seller write above,
  -- so each key is pinned at its own version from here on.
  PERFORM _st_ok('write: a trial of zero, of a year and a day, or of half a day is refused',
    _st_put(owner, 'trial', '{"days": 0}'::jsonb, 1, 'problem') = 'trial.days'
    AND _st_put(owner, 'trial', '{"days": 366}'::jsonb, 1, 'problem') = 'trial.days'
    AND _st_put(owner, 'trial', '{"days": 0.5}'::jsonb, 1, 'problem') = 'trial.days'
    AND _st_put(owner, 'trial', '{"days": "14"}'::jsonb, 1, 'problem') = 'trial.days');
  PERFORM _st_ok('write: a trial document with any other key is refused',
    _st_put(owner, 'trial', '{"days": 14, "weeks": 2}'::jsonb, 1, 'problem') = 'trial'
    AND _st_put(owner, 'trial', '{}'::jsonb, 1, 'problem') = 'trial');

  -- The invoice's shape.
  PERFORM _st_ok('write: a lower-case or dashed invoice prefix is refused — the dash separates the number',
    _st_put(owner, 'invoice', jsonb_set(v_inv, '{number_prefix}', '"inv"'::jsonb), 1, 'problem')
      = 'invoice.number_prefix'
    AND _st_put(owner, 'invoice', jsonb_set(v_inv, '{number_prefix}', '"IN-V"'::jsonb), 1, 'problem')
      = 'invoice.number_prefix'
    AND _st_put(owner, 'invoice', jsonb_set(v_inv, '{number_prefix}', '""'::jsonb), 1, 'problem')
      = 'invoice.number_prefix');
  PERFORM _st_ok('write: a running number of no digits, or of eleven, is refused',
    _st_put(owner, 'invoice', jsonb_set(v_inv, '{number_digits}', '0'::jsonb), 1, 'problem')
      = 'invoice.number_digits'
    AND _st_put(owner, 'invoice', jsonb_set(v_inv, '{number_digits}', '11'::jsonb), 1, 'problem')
      = 'invoice.number_digits');
  PERFORM _st_ok('write: a payment method that is not a plain identifier is refused',
    _st_put(owner, 'invoice', jsonb_set(v_inv, '{default_payment_method}', '"Bar zahlung"'::jsonb), 1, 'problem')
      = 'invoice.default_payment_method');
  PERFORM _st_ok('write: an owner may change the invoice defaults',
    _st_put(owner, 'invoice', jsonb_set(v_inv, '{number_digits}', '6'::jsonb), 1, 'ok') = 'true');

  -- The version, on a key this slice adds.
  PERFORM _st_ok('write: a stale version writes nothing and names the current one',
    _st_put(owner, 'invoice', v_inv, 1) = 'version_conflict'
    AND _st_put(owner, 'invoice', v_inv, 1, 'current_version') = '2');

  PERFORM _st_reset();
  PERFORM _st_ok('write: only the two accepted writes moved a version, and both recorded who',
    (SELECT version = 2 AND updated_by = '3c000000-0000-4000-8000-000000000001'
       FROM app_private.platform_settings WHERE key = 'seller')
    AND (SELECT version = 2 FROM app_private.platform_settings WHERE key = 'invoice')
    AND (SELECT version = 1 FROM app_private.platform_settings WHERE key = 'trial'));
END $$;

-- ─── 4. the trial: what a signup actually gets ──────────────────────────────

/*
  The rule this slice preserves:

    a company created by a signup gets a trial ending now() plus the trial
    length, and nothing recomputes the trial of a company that already exists.

  So the setting is exercised the only way that proves it — by running a signup
  through app_private.signup_insert_company, the one function that writes
  trial_end, before and after the owner changes the length.

  The whole file is one transaction, so now() does not move between the two
  signups and the two trial_end values can be compared exactly.
*/

INSERT INTO auth.users (id, email) VALUES
  ('3c000000-0000-4000-8000-00000000000a', 'st-signup-1@test.invalid'),
  ('3c000000-0000-4000-8000-00000000000b', 'st-signup-2@test.invalid');

DO $$
DECLARE
  owner   constant uuid := '3c000000-0000-4000-8000-000000000001';
  v_first   public.companies%ROWTYPE;
  v_second  public.companies%ROWTYPE;
  v_reread  timestamptz;
BEGIN
  PERFORM _st_reset();

  PERFORM _st_ok('trial: signup_trial_days() answers what the setting holds',
    app_private.signup_trial_days() = (app_private.platform_setting_value('trial') ->> 'days')::integer
    AND app_private.signup_trial_days() = 14);
  PERFORM _st_ok('trial: get_public_config() quotes the same number to a visitor',
    (public.get_public_config() ->> 'trial_days')::integer = app_private.signup_trial_days());

  SELECT * INTO v_first FROM app_private.signup_insert_company(
    '3c000000-0000-4000-8000-00000000000a', 'st-signup-1@test.invalid', 'ST One',
    'ST Trial One', 'basic', 'monthly', 3, NULL, NULL, 'pending_invite');

  PERFORM _st_ok('trial: a signup gets exactly the 14 days the constant used to give',
    v_first.trial_end = now() + interval '14 days'
    AND v_first.trial_start = now()
    AND v_first.status = 'trial' AND v_first.approval_status = 'pending');

  -- The owner doubles it. version 1 -> 2.
  PERFORM _st_ok('trial: an owner may change the length',
    _st_put(owner, 'trial', '{"days": 30}'::jsonb, 1, 'ok') = 'true');
  PERFORM _st_reset();

  PERFORM _st_ok('trial: signup_trial_days() and get_public_config() both follow at once',
    app_private.signup_trial_days() = 30
    AND (public.get_public_config() ->> 'trial_days')::integer = 30);

  SELECT * INTO v_second FROM app_private.signup_insert_company(
    '3c000000-0000-4000-8000-00000000000b', 'st-signup-2@test.invalid', 'ST Two',
    'ST Trial Two', 'basic', 'monthly', 3, NULL, NULL, 'pending_invite');

  PERFORM _st_ok('trial: the next signup gets the new length',
    v_second.trial_end = now() + interval '30 days');

  -- The point of the rule: a longer trial is not retroactive, and a shorter one
  -- does not cut anybody off.
  SELECT trial_end INTO v_reread FROM public.companies WHERE id = v_first.id;
  PERFORM _st_ok('trial: the company created before the change keeps its own end date',
    v_reread = now() + interval '14 days' AND v_reread <> v_second.trial_end);

  -- Fail closed: with no trial document at all the signup falls back to the 14
  -- days the constant held, never to a NULL trial_end — a company whose trial
  -- never ends.
  DELETE FROM app_private.platform_settings WHERE key = 'trial';
  PERFORM _st_ok('trial: a missing document falls back to 14 days, never to a trial with no end',
    app_private.signup_trial_days() = 14
    AND (public.get_public_config() ->> 'trial_days')::integer = 14);
END $$;

-- Put the document back, so sections 5 and 6 see the database as seeded.
INSERT INTO app_private.platform_settings (key, value, version)
VALUES ('trial', '{"days": 30}'::jsonb, 2)
ON CONFLICT (key) DO NOTHING;

-- ─── 5. the audit log ───────────────────────────────────────────────────────

DO $$
DECLARE
  owner   constant uuid := '3c000000-0000-4000-8000-000000000001';
  billing constant uuid := '3c000000-0000-4000-8000-000000000003';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_row   app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _st_reset();

  SELECT * INTO v_row FROM app_private.platform_audit_log
   WHERE action = 'platform_settings.put' AND outcome = 'ok' AND target_id = 'invoice'
   ORDER BY id DESC LIMIT 1;
  PERFORM _st_ok('audit: an accepted write of a 3.10 key keeps the value before and after, with both versions',
    v_row.category = 'settings'
    AND v_row.actor_user_id = owner
    AND v_row.actor_role = 'owner'
    AND (v_row.before_value ->> 'version')::integer = 1
    AND (v_row.after_value  ->> 'version')::integer = 2
    AND (v_row.after_value -> 'value' ->> 'number_digits')::integer = 6);

  PERFORM _st_ok('audit: a refused capability is recorded as denied, against the role that tried',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log
             WHERE action = 'platform_settings.put' AND outcome = 'denied'
               AND target_id = 'seller' AND actor_user_id = billing));
  PERFORM _st_ok('audit: a refused read of a 3.10 key is recorded too',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log
             WHERE action = 'platform_settings.get' AND outcome = 'denied'
               AND target_id IN ('seller', 'trial', 'invoice')));

  -- As everywhere in this slice: a caller who is not platform staff is refused
  -- without a row, or any signed-in company user could fill the append-only log.
  PERFORM _st_ok('audit: the company admin''s refused calls left no row at all',
    NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log WHERE actor_user_id = admin_a));
END $$;

-- ─── 6. what this slice deliberately did not take ───────────────────────────

DO $$
DECLARE
  owner constant uuid := '3c000000-0000-4000-8000-000000000001';
  v_sig text;
  v_src text;
BEGIN
  PERFORM _st_reset();

  -- A key with no validator is refused before anything is looked up — which is
  -- what keeps a half-built setting out of the database. mail.sender was this
  -- file's example until 20260920130000 gave it a validator; the template of a
  -- mail nobody receives any more (platform_login) and a made-up one are not
  -- keys at all.
  PERFORM _st_ok('scope: a template for platform_login, or for a mail that does not exist, is an unknown key',
    _st_put(owner, 'mail.template.platform_login', '{"subject": "x"}'::jsonb, 1) = 'unknown_key'
    AND _st_put(owner, 'mail.template.otp', '{"subject": "x"}'::jsonb, 1) = 'unknown_key');
  PERFORM _st_ok('scope: and an owner is simply told it is not stored',
    _st_get(owner, 'mail.template.platform_login') = 'not_found');

  /*
    This slice adds validators and keys and redefines neither settings RPC, for
    the reason 20260916140000 demonstrated: a re-creation silently drops the
    rules an earlier file installed. Asserted here as well as in the migration,
    because the property belongs to this slice.
  */
  FOREACH v_sig IN ARRAY ARRAY['public.platform_settings_get(text)',
                               'public.platform_settings_put(text,jsonb,integer)'] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_sig::regprocedure;
    PERFORM _st_ok(format('scope: %s still checks the per-actor cap and still records', v_sig),
      v_src ~ 'platform_settings_rate_limited' AND v_src ~ 'audit_write');
  END LOOP;

  -- Category 'read', not 'settings': platform_audit_record accepts only 'read'
  -- and 'write', so a 'settings' call is refused on the category before the
  -- action allow-list is consulted, and it is the allow-list this pins.
  PERFORM _st_ok('scope: platform_audit_record still refuses to forge a settings row',
    _st_do(owner, $q$SELECT platform_audit_record('read', 'platform_settings.put', 'ok')::text$q$)
      LIKE 'ERR 22023%');

  -- The signup path can reach app_private, whoever owns it. Without this every
  -- signup would fail at the first statement of signup_insert_company.
  PERFORM _st_ok('scope: the owner of signup_insert_company may call signup_trial_days()',
    (SELECT has_schema_privilege(p.proowner, 'app_private', 'USAGE')
            AND has_function_privilege(p.proowner, 'app_private.signup_trial_days()'::regprocedure, 'EXECUTE')
       FROM pg_proc p
      WHERE p.oid = 'app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)'::regprocedure));

  PERFORM _st_ok('scope: and no API role gained that reach',
    NOT has_schema_privilege('anon', 'app_private', 'USAGE')
    AND NOT has_schema_privilege('authenticated', 'app_private', 'USAGE')
    AND NOT has_schema_privilege('service_role', 'app_private', 'USAGE')
    AND NOT has_function_privilege('service_role', 'app_private.signup_trial_days()'::regprocedure, 'EXECUTE'));
END $$;

-- ─── 7. the mail sender and the four templates ──────────────────────────────

/*
  20260920130000. Every template is seeded as the empty override, so every mail
  reads exactly as it did; the sender is the SMTP_SENDER_NAME both hosts set.
  All five keys are settings.manage — owner only — and readable with
  settings.read, which billing holds for the prices alone.
*/
DO $$
DECLARE
  owner    constant uuid := '3c000000-0000-4000-8000-000000000001';
  support  constant uuid := '3c000000-0000-4000-8000-000000000002';
  billing  constant uuid := '3c000000-0000-4000-8000-000000000003';
  readonly constant uuid := '3c000000-0000-4000-8000-000000000004';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_key    text;
  v_ok     jsonb := '{"subject": "Willkommen bei El-Professor", "heading": "Fast geschafft",
                      "paragraphs": ["Hallo {email}, bitte bestätigen Sie Ihre Adresse.", "Danke!"],
                      "button": "Zur Bestätigung"}'::jsonb;
BEGIN
  PERFORM _st_reset();

  PERFORM _st_ok('mail: the sender is seeded as the name both hosts already send under',
    app_private.platform_setting_value('mail.sender') = '{"name": "El-Professor"}'::jsonb);
  PERFORM _st_ok('mail: the four templates are seeded as the empty override, at version 1, by nobody',
    (SELECT count(*) = 4 AND bool_and(value = '{}'::jsonb AND version = 1 AND updated_by IS NULL)
       FROM app_private.platform_settings
      WHERE key IN ('mail.template.signup_verify', 'mail.template.password_reset',
                    'mail.template.invite_activate', 'mail.template.email_change')));

  FOREACH v_key IN ARRAY ARRAY['mail.sender', 'mail.template.signup_verify'] LOOP
    PERFORM _st_ok(format('mail: an owner and read_only read %s', v_key),
      _st_get(owner, v_key, 'ok') = 'true' AND _st_get(readonly, v_key, 'ok') = 'true');
    PERFORM _st_ok(format('mail: billing, support and a company admin are refused %s', v_key),
      _st_get(billing, v_key) = 'forbidden'
      AND _st_get(support, v_key) = 'forbidden'
      AND _st_get(admin_a, v_key) = 'forbidden');
    PERFORM _st_ok(format('mail: only an owner may write %s', v_key),
      _st_put(billing,  v_key, app_private.platform_setting_value(v_key), 1) = 'forbidden'
      AND _st_put(support,  v_key, app_private.platform_setting_value(v_key), 1) = 'forbidden'
      AND _st_put(readonly, v_key, app_private.platform_setting_value(v_key), 1) = 'forbidden'
      AND _st_put(admin_a,  v_key, app_private.platform_setting_value(v_key), 1) = 'forbidden');
  END LOOP;

  -- The code never reaches a subject: providers log subjects and show them on
  -- lock screens.
  PERFORM _st_ok('mail: {code} in a subject is refused, and named as the code rule',
    _st_put(owner, 'mail.template.signup_verify', '{"subject": "Ihr Code {code}"}'::jsonb, 1, 'problem')
      = 'mail.template.signup_verify.subject.code'
    AND _st_put(owner, 'mail.template.password_reset', '{"subject": "Code: { code }"}'::jsonb, 1, 'problem')
      = 'mail.template.password_reset.subject.code');
  PERFORM _st_ok('mail: six digits in a row in a subject are refused the same way',
    _st_put(owner, 'mail.template.signup_verify', '{"subject": "Ihr Code 482915"}'::jsonb, 1, 'problem')
      = 'mail.template.signup_verify.subject.code');
  PERFORM _st_ok('mail: a subject takes no variable at all',
    _st_put(owner, 'mail.template.signup_verify', '{"subject": "Hallo {email}"}'::jsonb, 1, 'problem')
      = 'mail.template.signup_verify.subject');
  PERFORM _st_ok('mail: {code} is not a variable in a paragraph either',
    _st_put(owner, 'mail.template.signup_verify', '{"paragraphs": ["Ihr Code: {code}"]}'::jsonb, 1, 'problem')
      = 'mail.template.signup_verify.paragraphs.0');
  PERFORM _st_ok('mail: a paragraph uses only its own mail''s variables',
    _st_put(owner, 'mail.template.signup_verify', '{"paragraphs": ["Bei {company}"]}'::jsonb, 1, 'problem')
      = 'mail.template.signup_verify.paragraphs.0'
    AND _st_put(owner, 'mail.template.email_change', '{"paragraphs": ["ok", "Bei {company}"]}'::jsonb, 1, 'problem')
      = 'mail.template.email_change.paragraphs.1');
  PERFORM _st_ok('mail: a stray brace is refused, so no placeholder reaches a reader unfilled',
    _st_put(owner, 'mail.template.invite_activate', '{"paragraphs": ["Klammer { offen"]}'::jsonb, 1, 'problem')
      = 'mail.template.invite_activate.paragraphs.0');
  PERFORM _st_ok('mail: the address change takes no button label, having no button',
    _st_put(owner, 'mail.template.email_change', '{"button": "Los"}'::jsonb, 1, 'problem')
      = 'mail.template.email_change');
  PERFORM _st_ok('mail: an unknown field, no paragraph, six paragraphs and a control character are refused',
    _st_put(owner, 'mail.template.signup_verify', '{"preheader": "x"}'::jsonb, 1, 'problem')
      = 'mail.template.signup_verify'
    AND _st_put(owner, 'mail.template.signup_verify', '{"paragraphs": []}'::jsonb, 1, 'problem')
      = 'mail.template.signup_verify.paragraphs'
    AND _st_put(owner, 'mail.template.signup_verify',
                '{"paragraphs": ["1", "2", "3", "4", "5", "6"]}'::jsonb, 1, 'problem')
      = 'mail.template.signup_verify.paragraphs'
    AND _st_put(owner, 'mail.template.signup_verify', '{"heading": "Zeile\neins"}'::jsonb, 1, 'problem')
      = 'mail.template.signup_verify.heading');
  PERFORM _st_ok('mail: the bounds — a 151-character subject is refused',
    _st_put(owner, 'mail.template.signup_verify', jsonb_build_object('subject', repeat('x', 151)), 1, 'problem')
      = 'mail.template.signup_verify.subject');

  PERFORM _st_ok('mail: a display name that could pass for an address is refused',
    _st_put(owner, 'mail.sender', '{"name": "support@bank.de"}'::jsonb, 1, 'problem') = 'mail.sender.name'
    AND _st_put(owner, 'mail.sender', '{"name": "Bank <x@y.de>"}'::jsonb, 1, 'problem') = 'mail.sender.name'
    AND _st_put(owner, 'mail.sender', '{"name": "El-Professor", "address": "x@y.de"}'::jsonb, 1, 'problem')
      = 'mail.sender');

  -- Accepted: the owner customises the signup mail and renames the sender.
  PERFORM _st_ok('mail: an owner may customise a template',
    _st_put(owner, 'mail.template.signup_verify', v_ok, 1, 'ok') = 'true');
  PERFORM _st_ok('mail: an owner may rename the sender',
    _st_put(owner, 'mail.sender', '{"name": "El-Professor Support"}'::jsonb, 1, 'ok') = 'true');
  PERFORM _st_ok('mail: a stale version writes nothing and names the current one',
    _st_put(owner, 'mail.template.signup_verify', '{}'::jsonb, 1) = 'version_conflict'
    AND _st_put(owner, 'mail.template.signup_verify', '{}'::jsonb, 1, 'current_version') = '2');

  PERFORM _st_reset();
  PERFORM _st_ok('mail: the stored template is exactly what the owner saved, and the others did not move',
    app_private.platform_setting_value('mail.template.signup_verify') = v_ok
    AND (SELECT version = 2 FROM app_private.platform_settings WHERE key = 'mail.template.signup_verify')
    AND (SELECT version = 1 FROM app_private.platform_settings WHERE key = 'mail.template.password_reset'));
  PERFORM _st_ok('mail: the accepted template write is audited with the value before and after',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log
             WHERE action = 'platform_settings.put' AND outcome = 'ok'
               AND target_id = 'mail.template.signup_verify'
               AND category = 'settings' AND actor_user_id = owner
               AND before_value -> 'value' = '{}'::jsonb
               AND after_value -> 'value' = v_ok));
  PERFORM _st_ok('mail: a refused template is audited as an error naming the rule it broke',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log
             WHERE action = 'platform_settings.put' AND outcome = 'error'
               AND target_id = 'mail.template.signup_verify'
               AND after_value ->> 'problem' = 'mail.template.signup_verify.subject.code'));
END $$;

-- ─── 8. the invoice screen reads the seller ─────────────────────────────────

/*
  platform_invoice_seller(). The invoice screen needs companies.read — every
  staff role holds it — so every staff role reads the sender printed on the
  invoices it can already read, billing and support included, although neither
  may read the `seller` key through platform_settings_get. It returns the value
  and the version; its audit row names the version, never the value.
*/
DO $$
DECLARE
  owner    constant uuid := '3c000000-0000-4000-8000-000000000001';
  support  constant uuid := '3c000000-0000-4000-8000-000000000002';
  billing  constant uuid := '3c000000-0000-4000-8000-000000000003';
  readonly constant uuid := '3c000000-0000-4000-8000-000000000004';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_who    uuid;
  v_seller jsonb;
  v_answer jsonb;
  v_rows   bigint;
  v_i      integer;
BEGIN
  PERFORM _st_reset();
  v_seller := app_private.platform_setting_value('seller');

  FOREACH v_who IN ARRAY ARRAY[owner, support, billing, readonly] LOOP
    v_answer := _st_do(v_who, 'SELECT platform_invoice_seller()::text')::jsonb;
    PERFORM _st_ok(format('invoice: staff %s reads the stored seller and its version', v_who),
      (v_answer ->> 'ok') = 'true'
      AND v_answer -> 'value' = v_seller
      AND (v_answer ->> 'version')::integer
            = (SELECT version FROM app_private.platform_settings WHERE key = 'seller'));
  END LOOP;

  -- ...while platform_settings_get still refuses two of them the same key.
  PERFORM _st_ok('invoice: platform_settings_get(seller) is still refused to billing and support',
    _st_get(billing, 'seller') = 'forbidden' AND _st_get(support, 'seller') = 'forbidden');

  PERFORM _st_ok('invoice: a company admin is refused, and anon holds no EXECUTE',
    _st_do(admin_a, $q$SELECT platform_invoice_seller() ->> 'reason'$q$) = 'forbidden'
    AND _st_do(NULL, 'SELECT platform_invoice_seller()::text') LIKE 'ERR 42501%');

  PERFORM _st_reset();
  PERFORM _st_ok('invoice: one ok row per staff call, category read, naming the version and never the value',
    (SELECT count(*) = 4
            AND bool_and(category = 'read' AND target_type = 'platform_setting' AND target_id = 'seller'
                         AND after_value ? 'version' AND NOT (after_value ? 'value') AND before_value IS NULL)
       FROM app_private.platform_audit_log
      WHERE action = 'platform_settings.invoice_seller' AND outcome = 'ok'));
  PERFORM _st_ok('invoice: the company admin''s refusal left no row',
    NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log
                 WHERE action = 'platform_settings.invoice_seller' AND actor_user_id = admin_a));

  -- A stored seller the validator would refuse is never printed on an invoice.
  -- Written straight into the table, the only way it could get there; put back
  -- at once.
  UPDATE app_private.platform_settings SET value = '{"name": ""}'::jsonb WHERE key = 'seller';
  v_answer := _st_do(owner, 'SELECT platform_invoice_seller()::text')::jsonb;
  PERFORM _st_reset();
  UPDATE app_private.platform_settings SET value = v_seller WHERE key = 'seller';
  PERFORM _st_ok('invoice: an unreadable seller is not_found, not printed',
    (v_answer ->> 'ok') = 'false' AND (v_answer ->> 'reason') = 'not_found' AND NOT (v_answer ? 'value'));

  -- The settings budget covers this read too: a principal that has spent its
  -- minute on platform_settings_get is refused here, and the refusal writes
  -- nothing. The whole file is one transaction, so every row is in the minute.
  PERFORM _st_become(readonly);
  FOR v_i IN 1 .. 120 LOOP
    PERFORM public.platform_settings_get('trial');
  END LOOP;
  PERFORM _st_reset();
  SELECT count(*) INTO v_rows FROM app_private.platform_audit_log WHERE actor_user_id = readonly;
  PERFORM _st_ok('invoice: past the minute''s budget the seller read is refused as rate_limited',
    _st_do(readonly, $q$SELECT platform_invoice_seller() ->> 'reason'$q$) = 'rate_limited');
  PERFORM _st_reset();
  PERFORM _st_ok('invoice: …and that refusal wrote nothing',
    (SELECT count(*) FROM app_private.platform_audit_log WHERE actor_user_id = readonly) = v_rows);
END $$;

-- ─── 9. what the edge functions read before they send ───────────────────────

/** One SELECT as the service role, like _st_do. */
CREATE OR REPLACE FUNCTION _st_service(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _st_reset();
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _st_reset();
  RETURN v_out;
END $$;

DO $$
DECLARE
  owner   constant uuid := '3c000000-0000-4000-8000-000000000001';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_rows  bigint;
BEGIN
  PERFORM _st_reset();
  SELECT count(*) INTO v_rows FROM app_private.platform_audit_log;

  -- Section 7 customised the signup mail and renamed the sender.
  PERFORM _st_ok('delivery: the service role reads the sender and a mail''s template as stored',
    _st_service($q$SELECT mail_delivery_settings('signup_verify')::text$q$)::jsonb
      = jsonb_build_object('sender', app_private.platform_setting_value('mail.sender'),
                           'template', app_private.platform_setting_value('mail.template.signup_verify')));
  PERFORM _st_ok('delivery: a mail that was never customised comes back as the empty override',
    _st_service($q$SELECT mail_delivery_settings('password_reset') -> 'template'$q$) = '{}');
  PERFORM _st_ok('delivery: no purpose, or one with no template, answers the sender and a null template',
    _st_service($q$SELECT mail_delivery_settings(NULL) -> 'template'$q$) = 'null'
    AND _st_service($q$SELECT mail_delivery_settings('platform_login') -> 'template'$q$) = 'null'
    AND _st_service($q$SELECT mail_delivery_settings(NULL) -> 'sender' ->> 'name'$q$) = 'El-Professor Support');
  PERFORM _st_ok('delivery: a malformed purpose is a broken contract',
    _st_service($q$SELECT mail_delivery_settings('Signup Verify')::text$q$) LIKE 'ERR 22023%');

  PERFORM _st_ok('delivery: no signed-in caller may read it — not the owner, not a company admin, not anon',
    _st_do(owner,   $q$SELECT mail_delivery_settings('signup_verify')::text$q$) LIKE 'ERR 42501%'
    AND _st_do(admin_a, $q$SELECT mail_delivery_settings('signup_verify')::text$q$) LIKE 'ERR 42501%'
    AND _st_do(NULL,    $q$SELECT mail_delivery_settings('signup_verify')::text$q$) LIKE 'ERR 42501%');

  PERFORM _st_reset();
  PERFORM _st_ok('delivery: reading it writes no audit row — the caller is the system sending a mail',
    (SELECT count(*) FROM app_private.platform_audit_log) = v_rows);
END $$;

DO $$ BEGIN RAISE NOTICE '── settings: all checks passed ──'; END $$;

ROLLBACK;
