/*
  The legal pages: the Impressum and the privacy policy (migration
  20260921120000).

  Runs after assertions.sql against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it
  see the database as the seeds left it.

  settings.sql and pricing.sql cover the settings machinery itself — the grants
  on the table, the two RPCs, the version check, the per-actor cap. This file
  covers what 20260921120000 adds, and its helpers are named apart from theirs.

  What is covered, in order:

    1. seeds      legal.privacy exists, empty, at version 1; the seller is left
                  the eleven fields it was
    2. grants     get_legal_pages(): anon and authenticated may call it, PUBLIC
                  and the service role may not; SECURITY DEFINER, STABLE, pinned
    3. the list   **the data protection decision, key by key**: exactly two
                  parts, exactly fourteen Impressum fields, and the privacy
                  text's two
    4. empty      with nothing entered the page publishes nothing — not the
                  seeded 'El-Professor' placeholder either
    5. writing    who may write and read legal.privacy; every refusal path of
                  its validator; the version check; the audit row with the text
                  before and after, a text at the 32000-byte bound included
    6. the seller the nine optional fields: accepted, refused, still read by
                  the invoice screen
    7. published  once entered, anybody — anon, a company user, staff — reads
                  exactly the public fields; the bank details, the tax number,
                  the invoice's sender name and the invoice numbering never
                  appear, not as a key and not as a value
    8. unaudited  reading the pages writes no audit row
    9. fail closed a stored document its validator refuses publishes nothing
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _lp_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

/** Back to the connecting superuser with no JWT claims at all. */
CREATE OR REPLACE FUNCTION _lp_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

/** NULL is anon; anything else a password session of that user. */
CREATE OR REPLACE FUNCTION _lp_become(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _lp_reset();
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

/** One SELECT as the service role. */
CREATE OR REPLACE FUNCTION _lp_service(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _lp_reset();
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _lp_reset();
  RETURN v_out;
END $$;

/*
  Run one SELECT as the principal and return its scalar, or `ERR <sqlstate>
  <message>`. What the statement did is KEPT: the settings RPCs write audit
  rows and section 5 reads them.
*/
CREATE OR REPLACE FUNCTION _lp_do(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _lp_become(p_user);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _lp_reset();
  RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION _lp_get(p_user uuid, p_key text, p_field text DEFAULT 'reason') RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN _lp_do(p_user, format('SELECT platform_settings_get(%L) ->> %L', p_key, p_field));
END $$;

CREATE OR REPLACE FUNCTION _lp_put(p_user uuid, p_key text, p_value jsonb, p_version integer,
                                   p_field text DEFAULT 'reason') RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN _lp_do(p_user, format('SELECT platform_settings_put(%L, %L::jsonb, %s) ->> %L',
                               p_key, p_value::text, p_version, p_field));
END $$;

/** The public answer, as the principal sees it. */
CREATE OR REPLACE FUNCTION _lp_pages(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
  RETURN _lp_do(p_user, 'SELECT get_legal_pages()::text')::jsonb;
END $$;

-- ─── principals ─────────────────────────────────────────────────────────────

/*
    3d..01 lp-owner      owner
    3d..02 lp-support    support
    3d..03 lp-billing    billing
    3d..04 lp-readonly   read_only
    3d..05 lp-owner-2    owner (the validator paths, so neither owner comes
                         near the settings budget of 120 rows a minute)
  plus admin-a from seed.sql (a company admin) and anon.
*/
INSERT INTO auth.users (id, email) VALUES
  ('3d000000-0000-4000-8000-000000000001', 'lp-owner@test.invalid'),
  ('3d000000-0000-4000-8000-000000000002', 'lp-support@test.invalid'),
  ('3d000000-0000-4000-8000-000000000003', 'lp-billing@test.invalid'),
  ('3d000000-0000-4000-8000-000000000004', 'lp-readonly@test.invalid'),
  ('3d000000-0000-4000-8000-000000000005', 'lp-owner-2@test.invalid');

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, is_super_admin, status) VALUES
  ('3d000000-0000-4000-8000-000000000001', 'lp-owner@test.invalid',    'LP Owner',    'admin', NULL, NULL, false, 'active'),
  ('3d000000-0000-4000-8000-000000000002', 'lp-support@test.invalid',  'LP Support',  'admin', NULL, NULL, false, 'active'),
  ('3d000000-0000-4000-8000-000000000003', 'lp-billing@test.invalid',  'LP Billing',  'admin', NULL, NULL, false, 'active'),
  ('3d000000-0000-4000-8000-000000000004', 'lp-readonly@test.invalid', 'LP Readonly', 'admin', NULL, NULL, false, 'active'),
  ('3d000000-0000-4000-8000-000000000005', 'lp-owner-2@test.invalid',  'LP Owner 2',  'admin', NULL, NULL, false, 'active');

INSERT INTO app_private.platform_staff (user_id, role, note) VALUES
  ('3d000000-0000-4000-8000-000000000001', 'owner',     'lp'),
  ('3d000000-0000-4000-8000-000000000002', 'support',   'lp'),
  ('3d000000-0000-4000-8000-000000000003', 'billing',   'lp'),
  ('3d000000-0000-4000-8000-000000000004', 'read_only', 'lp'),
  ('3d000000-0000-4000-8000-000000000005', 'owner',     'lp');

-- ─── 1. the seeds ───────────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _lp_reset();

  PERFORM _lp_ok('seed: legal.privacy is the empty document, at version 1, written by nobody',
    (SELECT value = '{}'::jsonb AND version = 1 AND updated_by IS NULL
       FROM app_private.platform_settings WHERE key = 'legal.privacy'));

  -- The two of 3.9, the three of 3.10's first half, the six of 20260920130000,
  -- and this one.
  PERFORM _lp_ok('seed: twelve keys now, legal.privacy the one this slice added',
    (SELECT count(*) = 12 FROM app_private.platform_settings));

  PERFORM _lp_ok('seed: every stored document passes the validator it is written for',
    NOT EXISTS (SELECT 1 FROM app_private.platform_settings s
                 WHERE app_private.platform_settings_problem(s.key, s.value) IS NOT NULL));

  -- The nine new seller fields are optional: nothing was added to the stored
  -- document, so the previous release still reads it.
  PERFORM _lp_ok('seed: the seller is still exactly the eleven fields the invoice reads',
    app_private.settings_object_keys(app_private.platform_setting_value('seller')) = ARRAY[
      'account_holder', 'bank_name', 'bic', 'city', 'house_number', 'iban',
      'name', 'postal_code', 'street', 'tax_number', 'vat_id']);
END $$;

-- ─── 2. who may call it ─────────────────────────────────────────────────────

DO $$
DECLARE
  c_fn constant regprocedure := 'public.get_legal_pages()'::regprocedure;
BEGIN
  PERFORM _lp_reset();

  PERFORM _lp_ok('grants: anon and authenticated may call get_legal_pages(), the service role may not',
    has_function_privilege('anon', c_fn, 'EXECUTE')
    AND has_function_privilege('authenticated', c_fn, 'EXECUTE')
    AND NOT has_function_privilege('service_role', c_fn, 'EXECUTE'));

  PERFORM _lp_ok('grants: PUBLIC holds no EXECUTE — the two grants are the whole list',
    NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = c_fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'));

  PERFORM _lp_ok('grants: SECURITY DEFINER, STABLE, with a pinned search_path',
    (SELECT p.prosecdef AND p.provolatile = 's'
            AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c(setting) WHERE c.setting LIKE 'search_path=%')
       FROM pg_proc p WHERE p.oid = c_fn));

  PERFORM _lp_ok('grants: the service role is refused by privilege',
    _lp_service('SELECT get_legal_pages()::text') LIKE 'ERR 42501%');

  PERFORM _lp_ok('grants: the new validator is reachable by nobody the API authenticates as',
    NOT has_function_privilege('anon', 'app_private.platform_settings_problem_legal(text,jsonb)'::regprocedure, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'app_private.platform_settings_problem_legal(text,jsonb)'::regprocedure, 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'app_private.platform_settings_problem_legal(text,jsonb)'::regprocedure, 'EXECUTE'));
END $$;

-- ─── 3. the published list, key by key ──────────────────────────────────────

/*
  Which fields go public is a data protection decision, and the migration header
  gives the reason for each. Pinned as a list, not counted, so adding a field is
  a change to this file that someone has to read.
*/
DO $$
DECLARE
  v_answer jsonb;
BEGIN
  v_answer := _lp_pages(NULL);

  PERFORM _lp_ok('list: the answer has exactly two parts, the Impressum and the privacy text',
    app_private.settings_object_keys(v_answer) = ARRAY['impressum', 'privacy']);

  PERFORM _lp_ok('list: the Impressum is exactly the fourteen fields § 5 DDG and § 18 MStV ask for',
    app_private.settings_object_keys(v_answer -> 'impressum') = ARRAY[
      'city', 'contact_email', 'contact_phone', 'content_responsible_address',
      'content_responsible_name', 'house_number', 'legal_form', 'legal_name',
      'postal_code', 'register_court', 'register_number', 'represented_by',
      'street', 'vat_id']);

  PERFORM _lp_ok('list: every Impressum field is a string, filled or not',
    (SELECT bool_and(jsonb_typeof(value) = 'string') FROM jsonb_each(v_answer -> 'impressum')));

  PERFORM _lp_ok('list: the privacy text is exactly its date and its paragraphs',
    app_private.settings_object_keys(v_answer -> 'privacy') = ARRAY['as_of', 'paragraphs']);

  PERFORM _lp_ok('list: the bank details, the tax number and the invoice''s sender name are no key of it',
    NOT ((v_answer -> 'impressum') ?| ARRAY['name', 'tax_number', 'bank_name', 'iban', 'bic', 'account_holder'])
    AND NOT (v_answer ?| ARRAY['seller', 'invoice', 'number_prefix', 'number_digits', 'default_payment_method']));
END $$;

-- ─── 4. nothing entered, nothing published ──────────────────────────────────

DO $$
DECLARE
  v_answer jsonb;
BEGIN
  v_answer := _lp_pages(NULL);

  /*
    The fixture's seller is the fallback the migration seeds where it finds no
    row: name 'El-Professor', every other field ''. The name is a product name,
    not a fact about who runs the site, so it is not published — the page says
    the Impressum is not provided yet instead of naming a placeholder.
  */
  PERFORM _lp_ok('empty: with nothing entered every Impressum field is empty',
    (SELECT bool_and(value = '""'::jsonb) FROM jsonb_each(v_answer -> 'impressum')));
  PERFORM _lp_ok('empty: the seeded placeholder name is never published',
    app_private.platform_setting_value('seller') ->> 'name' = 'El-Professor'
    AND position('El-Professor' IN v_answer::text) = 0);
  PERFORM _lp_ok('empty: no privacy text — no date and no paragraphs',
    v_answer -> 'privacy' = '{"as_of": null, "paragraphs": []}'::jsonb);
END $$;

-- ─── 5. writing the privacy text ────────────────────────────────────────────

DO $$
DECLARE
  owner    constant uuid := '3d000000-0000-4000-8000-000000000001';
  support  constant uuid := '3d000000-0000-4000-8000-000000000002';
  billing  constant uuid := '3d000000-0000-4000-8000-000000000003';
  readonly constant uuid := '3d000000-0000-4000-8000-000000000004';
  owner2   constant uuid := '3d000000-0000-4000-8000-000000000005';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_text   constant jsonb := '{"as_of": "2026-09-21",
                               "paragraphs": ["Verantwortlich:\nLP Muster GmbH\nHauptstraße 1", "Zweiter Absatz."]}'::jsonb;
  v_big    jsonb;
  v_row    app_private.platform_audit_log%ROWTYPE;
BEGIN
  -- Who may read. settings.read: owner and read_only; billing holds it for the
  -- prices alone; support holds none; a company user is not staff.
  PERFORM _lp_ok('write: an owner and read_only read legal.privacy at version 1',
    _lp_get(owner, 'legal.privacy', 'version') = '1' AND _lp_get(readonly, 'legal.privacy', 'ok') = 'true');
  PERFORM _lp_ok('write: billing, support and a company admin are refused the read',
    _lp_get(billing, 'legal.privacy') = 'forbidden'
    AND _lp_get(support, 'legal.privacy') = 'forbidden'
    AND _lp_get(admin_a, 'legal.privacy') = 'forbidden');

  -- Who may write. settings.manage: the owner alone.
  PERFORM _lp_ok('write: billing (pricing.manage), support, read_only and a company admin may not write it',
    _lp_put(billing, 'legal.privacy', v_text, 1) = 'forbidden'
    AND _lp_put(support, 'legal.privacy', v_text, 1) = 'forbidden'
    AND _lp_put(readonly, 'legal.privacy', v_text, 1) = 'forbidden'
    AND _lp_put(admin_a, 'legal.privacy', v_text, 1) = 'forbidden');
  PERFORM _lp_ok('write: anon cannot even call the settings RPC',
    _lp_put(NULL, 'legal.privacy', v_text, 1) LIKE 'ERR 42501%');

  -- Every refusal of the validator, named by its path. owner2 spends these, so
  -- neither owner gets near the budget of 120 settings rows a minute.
  PERFORM _lp_ok('write: not an object, or a document with a key missing or one too many, is refused as a whole',
    _lp_put(owner2, 'legal.privacy', '[]'::jsonb, 1, 'problem') = 'legal.privacy'
    AND _lp_put(owner2, 'legal.privacy', v_text - 'as_of', 1, 'problem') = 'legal.privacy'
    AND _lp_put(owner2, 'legal.privacy', v_text || '{"title": "Datenschutz"}'::jsonb, 1, 'problem') = 'legal.privacy');
  PERFORM _lp_ok('write: a "Stand" that is not a real YYYY-MM-DD date is refused',
    _lp_put(owner2, 'legal.privacy', jsonb_set(v_text, '{as_of}', '"21.09.2026"'::jsonb), 1, 'problem') = 'legal.privacy.as_of'
    AND _lp_put(owner2, 'legal.privacy', jsonb_set(v_text, '{as_of}', '"2026-02-30"'::jsonb), 1, 'problem') = 'legal.privacy.as_of'
    AND _lp_put(owner2, 'legal.privacy', jsonb_set(v_text, '{as_of}', '"1999-12-31"'::jsonb), 1, 'problem') = 'legal.privacy.as_of'
    AND _lp_put(owner2, 'legal.privacy', jsonb_set(v_text, '{as_of}', 'null'::jsonb), 1, 'problem') = 'legal.privacy.as_of');
  PERFORM _lp_ok('write: no paragraph at all, or paragraphs that are not a list, are refused',
    _lp_put(owner2, 'legal.privacy', jsonb_set(v_text, '{paragraphs}', '[]'::jsonb), 1, 'problem') = 'legal.privacy.paragraphs'
    AND _lp_put(owner2, 'legal.privacy', jsonb_set(v_text, '{paragraphs}', '"Text"'::jsonb), 1, 'problem') = 'legal.privacy.paragraphs');
  PERFORM _lp_ok('write: plain text only — markup is refused, and the paragraph named',
    _lp_put(owner2, 'legal.privacy', jsonb_set(v_text, '{paragraphs,1}', '"<p>Absatz</p>"'::jsonb), 1, 'problem')
      = 'legal.privacy.paragraphs.1'
    AND _lp_put(owner2, 'legal.privacy', jsonb_set(v_text, '{paragraphs,1}', '"<script>alert(1)</script>"'::jsonb), 1, 'problem')
      = 'legal.privacy.paragraphs.1'
    AND _lp_put(owner2, 'legal.privacy', jsonb_set(v_text, '{paragraphs,1}', '"a > b"'::jsonb), 1, 'problem')
      = 'legal.privacy.paragraphs.1');
  PERFORM _lp_ok('write: a control character other than a line break, a blank line inside a paragraph, or a blank paragraph is refused',
    _lp_put(owner2, 'legal.privacy', jsonb_set(v_text, '{paragraphs,1}', '"Tab\there"'::jsonb), 1, 'problem')
      = 'legal.privacy.paragraphs.1'
    AND _lp_put(owner2, 'legal.privacy', jsonb_set(v_text, '{paragraphs,1}', '"Eins\n\nZwei"'::jsonb), 1, 'problem')
      = 'legal.privacy.paragraphs.1'
    AND _lp_put(owner2, 'legal.privacy', jsonb_set(v_text, '{paragraphs,0}', '"   "'::jsonb), 1, 'problem')
      = 'legal.privacy.paragraphs.0');
  PERFORM _lp_ok('write: a paragraph over 4000 characters, or over 300 paragraphs, is refused',
    _lp_put(owner2, 'legal.privacy', jsonb_set(v_text, '{paragraphs,0}', to_jsonb(repeat('x', 4001))), 1, 'problem')
      = 'legal.privacy.paragraphs.0'
    AND _lp_put(owner2, 'legal.privacy',
          jsonb_build_object('as_of', '2026-09-21', 'paragraphs', to_jsonb(array_fill('x'::text, ARRAY[301]))), 1, 'problem')
      = 'legal.privacy.paragraphs');
  PERFORM _lp_ok('write: a text over 32000 bytes is refused as value_size',
    _lp_put(owner2, 'legal.privacy',
      jsonb_build_object('as_of', '2026-09-21', 'paragraphs', to_jsonb(array_fill(repeat('ä', 1000), ARRAY[17]))), 1)
      = 'invalid_value'
    AND _lp_put(owner2, 'legal.privacy',
      jsonb_build_object('as_of', '2026-09-21', 'paragraphs', to_jsonb(array_fill(repeat('ä', 1000), ARRAY[17]))), 1, 'problem')
      = 'value_size');
  PERFORM _lp_ok('write: none of those refusals stored anything',
    (SELECT version = 1 AND value = '{}'::jsonb FROM app_private.platform_settings WHERE key = 'legal.privacy'));

  -- The owner publishes it. Version 1 -> 2; a stale version is refused.
  PERFORM _lp_ok('write: the owner stores a valid text, with a line break inside a paragraph',
    _lp_put(owner, 'legal.privacy', v_text, 1, 'version') = '2');
  PERFORM _lp_ok('write: a save against the version it read before is refused, and changes nothing',
    _lp_put(owner, 'legal.privacy', '{}'::jsonb, 1) = 'version_conflict'
    AND app_private.platform_setting_value('legal.privacy') = v_text);

  PERFORM _lp_reset();
  SELECT * INTO v_row FROM app_private.platform_audit_log
   WHERE action = 'platform_settings.put' AND outcome = 'ok' AND target_id = 'legal.privacy'
   ORDER BY id DESC LIMIT 1;
  PERFORM _lp_ok('write: the accepted save is audited under settings, with the text before and after',
    v_row.category = 'settings'
    AND v_row.actor_user_id = owner
    AND v_row.actor_role = 'owner'
    AND v_row.before_value = jsonb_build_object('version', 1, 'value', '{}'::jsonb)
    AND v_row.after_value  = jsonb_build_object('version', 2, 'value', v_text));
  PERFORM _lp_ok('write: a refused capability is recorded as denied against the role that tried',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log
             WHERE action = 'platform_settings.put' AND outcome = 'denied'
               AND target_id = 'legal.privacy' AND actor_user_id = billing));
  PERFORM _lp_ok('write: the company admin''s refused calls left no row',
    NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log
                 WHERE target_id = 'legal.privacy' AND actor_user_id = admin_a));

  /*
    The bound is the text's own, above the 16384 bytes every other key shares,
    and a text at it still fits the audit row the put writes: audit_write
    refuses a before or after document over 32768 bytes, and raising there would
    fail the save. Stored, then stored over, so the big text is once the "after"
    and once the "before".
  */
  v_big := jsonb_build_object('as_of', '2026-09-22', 'paragraphs', to_jsonb(array_fill(repeat('ä', 1000), ARRAY[15])));
  PERFORM _lp_ok('write: a text of more than 16384 bytes, within 32000, is accepted and audited',
    octet_length(v_big::text) > 16384 AND octet_length(v_big::text) <= 32000
    AND _lp_put(owner, 'legal.privacy', v_big, 2, 'version') = '3');
  PERFORM _lp_ok('write: …and replacing it records it whole as the value before',
    _lp_put(owner, 'legal.privacy', v_text, 3, 'version') = '4');
  PERFORM _lp_reset();
  PERFORM _lp_ok('write: both audit rows carry the big text',
    (SELECT count(*) = 2 FROM app_private.platform_audit_log
      WHERE action = 'platform_settings.put' AND outcome = 'ok' AND target_id = 'legal.privacy'
        AND (after_value -> 'value' = v_big OR before_value -> 'value' = v_big)));
END $$;

-- ─── 6. the seller's Impressum fields ───────────────────────────────────────

DO $$
DECLARE
  owner    constant uuid := '3d000000-0000-4000-8000-000000000001';
  support  constant uuid := '3d000000-0000-4000-8000-000000000002';
  billing  constant uuid := '3d000000-0000-4000-8000-000000000003';
  owner2   constant uuid := '3d000000-0000-4000-8000-000000000005';
  v_seller constant jsonb := app_private.platform_setting_value('seller');
  v_full   jsonb;
  v_answer jsonb;
BEGIN
  -- Every field carries a marker of its own, so section 7 can tell each value
  -- from every other in the public answer.
  v_full := jsonb_build_object(
    'name',                        'LPX-NAME Rechnungsname',
    'street',                      'LPX-STREET Hauptstraße',
    'house_number',                'LPX-HOUSE 12',
    'postal_code',                 'LPX-POSTAL 42651',
    'city',                        'LPX-CITY Solingen',
    'vat_id',                      'LPX-VAT DE123456789',
    'tax_number',                  'LPX-TAX 123/456/78901',
    'bank_name',                   'LPX-BANK Sparkasse',
    'iban',                        'LPX-IBAN DE02120300000000202051',
    'bic',                         'LPX-BIC BYLADEM1001',
    'account_holder',              'LPX-HOLDER Kontoinhaber',
    'legal_name',                  'LPX-LEGALNAME Muster GmbH',
    'legal_form',                  'LPX-FORM GmbH',
    'represented_by',              'LPX-REPR Erika Muster',
    'contact_email',               'lpx-mail@example.com',
    'contact_phone',               '+49 212 555-0101',
    'register_court',              'LPX-COURT Amtsgericht Wuppertal',
    'register_number',             'LPX-REGNO HRB 12345',
    'content_responsible_name',    'LPX-RESP Erika Muster',
    'content_responsible_address', 'LPX-RESPADDR Hauptstraße 12, 42651 Solingen');

  -- The shape: the nine are optional, the eleven are not.
  PERFORM _lp_ok('seller: the eleven alone still pass — the nine are optional',
    app_private.platform_settings_problem('seller', v_seller) IS NULL);
  PERFORM _lp_ok('seller: an Impressum field that is not a string, has a control character or is too long is named',
    _lp_put(owner2, 'seller', jsonb_set(v_full, '{legal_name}', '42'::jsonb), 1, 'problem') = 'seller.legal_name'
    AND _lp_put(owner2, 'seller', jsonb_set(v_full, '{represented_by}', '"Erika\nMuster"'::jsonb), 1, 'problem') = 'seller.represented_by'
    AND _lp_put(owner2, 'seller', jsonb_set(v_full, '{register_number}', to_jsonb(repeat('x', 201))), 1, 'problem') = 'seller.register_number');
  PERFORM _lp_ok('seller: the page links the address and the number, so each must be one',
    _lp_put(owner2, 'seller', jsonb_set(v_full, '{contact_email}', '"info at example.com"'::jsonb), 1, 'problem') = 'seller.contact_email'
    AND _lp_put(owner2, 'seller', jsonb_set(v_full, '{contact_phone}', '"auf Anfrage"'::jsonb), 1, 'problem') = 'seller.contact_phone'
    AND _lp_put(owner2, 'seller', jsonb_set(v_full, '{contact_phone}', '"12"'::jsonb), 1, 'problem') = 'seller.contact_phone');
  PERFORM _lp_ok('seller: a field nobody knows, or one of the eleven missing, is still refused as a whole',
    _lp_put(owner2, 'seller', v_full || '{"country": "Deutschland"}'::jsonb, 1, 'problem') = 'seller'
    AND _lp_put(owner2, 'seller', v_full - 'iban', 1, 'problem') = 'seller'
    AND _lp_put(owner2, 'seller', jsonb_set(v_full, '{name}', '""'::jsonb), 1, 'problem') = 'seller.name');
  PERFORM _lp_ok('seller: who may write it is unchanged — billing and support are refused',
    _lp_put(billing, 'seller', v_full, 1) = 'forbidden' AND _lp_put(support, 'seller', v_full, 1) = 'forbidden');

  PERFORM _lp_ok('seller: the owner stores the whole Impressum',
    _lp_put(owner, 'seller', v_full, 1, 'version') = '2');

  -- The invoice screen reads the seller through its own RPC; a document with
  -- the new fields must still pass there, or the invoice PDF would not build.
  v_answer := _lp_do(billing, 'SELECT platform_invoice_seller()::text')::jsonb;
  PERFORM _lp_ok('seller: platform_invoice_seller() still returns the extended seller to billing',
    (v_answer ->> 'ok') = 'true' AND v_answer -> 'value' = v_full);
END $$;

-- ─── 7. published: exactly the public fields, for anybody ───────────────────

DO $$
DECLARE
  owner    constant uuid := '3d000000-0000-4000-8000-000000000001';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_full   constant jsonb := app_private.platform_setting_value('seller');
  v_text   constant jsonb := app_private.platform_setting_value('legal.privacy');
  v_anon   jsonb;
  v_answer text;
  v_field  text;
BEGIN
  -- The invoice numbering carries a marker too; section 5 of settings.sql owns
  -- that key's rules, this only needs a value nobody could mistake.
  PERFORM _lp_ok('published: the invoice prefix is set to a marker',
    _lp_put(owner, 'invoice',
            jsonb_set(app_private.platform_setting_value('invoice'), '{number_prefix}', '"LPXINV"'::jsonb),
            1, 'ok') = 'true');

  v_anon := _lp_pages(NULL);
  v_answer := v_anon::text;

  PERFORM _lp_ok('published: anon reads each of the fourteen fields exactly as stored',
    (SELECT bool_and(v_anon -> 'impressum' ->> f = v_full ->> f)
       FROM unnest(ARRAY['legal_name', 'legal_form', 'street', 'house_number', 'postal_code', 'city',
                         'represented_by', 'contact_email', 'contact_phone', 'register_court',
                         'register_number', 'vat_id', 'content_responsible_name',
                         'content_responsible_address']) AS f));

  -- Not as a key (section 3) and not as a value either.
  FOREACH v_field IN ARRAY ARRAY['LPX-NAME', 'LPX-TAX', 'LPX-BANK', 'LPX-IBAN', 'LPX-BIC', 'LPX-HOLDER', 'LPXINV'] LOOP
    PERFORM _lp_ok(format('published: %s appears nowhere in the public answer', v_field),
      position(v_field IN v_answer) = 0);
  END LOOP;

  PERFORM _lp_ok('published: the privacy text comes back as stored — its date and its paragraphs',
    v_anon -> 'privacy' = v_text);

  PERFORM _lp_ok('published: a company user and platform staff read the very same answer as anon',
    _lp_pages(admin_a) = v_anon AND _lp_pages(owner) = v_anon);

  -- Whitespace around a value is not published.
  PERFORM _lp_ok('published: a value is trimmed on the way out',
    _lp_put(owner, 'seller', jsonb_set(v_full, '{legal_form}', '"  GmbH  "'::jsonb), 2, 'ok') = 'true'
    AND _lp_pages(NULL) -> 'impressum' ->> 'legal_form' = 'GmbH');
END $$;

-- ─── 8. unaudited ───────────────────────────────────────────────────────────

DO $$
DECLARE
  owner   constant uuid := '3d000000-0000-4000-8000-000000000001';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_rows  bigint;
  v_i     integer;
BEGIN
  PERFORM _lp_reset();
  SELECT count(*) INTO v_rows FROM app_private.platform_audit_log;

  -- A public page is read by every visitor. Were it audited, anybody could fill
  -- the append-only log by reloading it.
  FOR v_i IN 1 .. 5 LOOP
    PERFORM _lp_pages(NULL);
  END LOOP;
  PERFORM _lp_pages(admin_a);
  PERFORM _lp_pages(owner);

  PERFORM _lp_reset();
  PERFORM _lp_ok('unaudited: reading the pages, as anybody, writes no audit row',
    (SELECT count(*) FROM app_private.platform_audit_log) = v_rows);
END $$;

-- ─── 9. a document its validator refuses publishes nothing ──────────────────

DO $$
DECLARE
  v_seller  constant jsonb := app_private.platform_setting_value('seller');
  v_privacy constant jsonb := app_private.platform_setting_value('legal.privacy');
  v_answer  jsonb;
BEGIN
  PERFORM _lp_reset();

  -- Written straight into the table, the only way either could get there.
  UPDATE app_private.platform_settings
     SET value = '{"as_of": "2026-09-21", "paragraphs": ["<b>kaputt</b>"]}'::jsonb
   WHERE key = 'legal.privacy';
  UPDATE app_private.platform_settings
     SET value = v_seller - 'iban'
   WHERE key = 'seller';

  v_answer := _lp_pages(NULL);
  PERFORM _lp_ok('fail closed: an unreadable privacy text is not published, not even in part',
    v_answer -> 'privacy' = '{"as_of": null, "paragraphs": []}'::jsonb);
  PERFORM _lp_ok('fail closed: an unreadable seller publishes an empty Impressum, never a partial one',
    (SELECT bool_and(value = '""'::jsonb) FROM jsonb_each(v_answer -> 'impressum')));

  -- And with no row at all: still the empty answer, never an error.
  DELETE FROM app_private.platform_settings WHERE key IN ('seller', 'legal.privacy');
  v_answer := _lp_pages(NULL);
  PERFORM _lp_ok('fail closed: with neither key stored the answer is still whole, and empty',
    app_private.settings_object_keys(v_answer -> 'impressum') IS NOT NULL
    AND (SELECT bool_and(value = '""'::jsonb) FROM jsonb_each(v_answer -> 'impressum'))
    AND v_answer -> 'privacy' = '{"as_of": null, "paragraphs": []}'::jsonb);

  PERFORM _lp_reset();
  INSERT INTO app_private.platform_settings (key, value) VALUES ('seller', v_seller), ('legal.privacy', v_privacy);
END $$;

DO $$ BEGIN RAISE NOTICE '── legal-pages: all checks passed ──'; END $$;

ROLLBACK;
