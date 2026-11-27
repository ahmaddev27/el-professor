-- ════════════════════════════════════════════════════════════════════════════
--  A new driver's defaults, and the daily pull placing a few new drivers
--  (20261126100000, 20261126110000)
-- ════════════════════════════════════════════════════════════════════════════
--
--  Written by the author of the migrations, NOT RUN by him: the RLS kit is the
--  coordinator's to run. Every expectation is derived from the migrations' text
--  and from the neighbouring files (uber-daily-pull.sql, partner-earner-resolve.sql);
--  if a line fails, read the actual value before touching the expectation.
--
--    §1  the next staff number: owner left out, inactive counted, non-numeric
--        ignored, '23' and '00023' the same number, width kept, never cut.
--    §2  the trigger: an active non-owner driver without a number gets one; an
--        explicit number is kept; inactive and owner get none; two inserts in
--        one transaction are consecutive; German is the default language.
--    §3  driver_next_personalnummer: administrator yes, viewer NULL, anon refused.
--    §4  uber_pull_place_unlinked: service role only, creates an ACTIVE numbered
--        German driver, links by normalised name without renaming, and refuses
--        a blocked company, a settled run, more than five and the name rules.
--    §5  partner_earners_resolve still creates INACTIVE drivers with NO number.
--
--  Runs inside BEGIN ... ROLLBACK. Ids start with `2d` so a failure names a row.

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _dd_as(p_who text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- A privilege error is raised at parse time and the plan the owner just
  -- warmed would hide it, so the owner's cached plans go first.
  DISCARD PLANS;
  -- set_config(..., true) lasts the whole transaction, so a user set by an
  -- earlier probe would still be auth.uid() here: anon and the service key
  -- carry no subject in production, and must not here either.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  IF p_who = 'anon' THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
  ELSIF p_who = 'service' THEN
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
  ELSE
    PERFORM set_config('request.jwt.claim.sub', p_who, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
END $$;

/* Runs p_sql as p_who ('owner', 'anon', 'service' or a user id) and returns the
   scalar, 'null' for NULL, or `ERR <sqlstate> <hint-or-none>`. */
CREATE OR REPLACE FUNCTION _dd_call(p_who text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text; v_hint text; v_state text;
BEGIN
  IF p_who <> 'owner' THEN PERFORM _dd_as(p_who); END IF;
  EXECUTE p_sql INTO v_out;
  RESET ROLE;
  RETURN coalesce(v_out, 'null');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_state = RETURNED_SQLSTATE;
  RESET ROLE;
  RETURN 'ERR ' || v_state || ' ' || coalesce(nullif(v_hint, ''), '(no hint)');
END $$;

CREATE TEMP TABLE _dd_out (
  n integer PRIMARY KEY, label text NOT NULL,
  actual text NOT NULL, expected text NOT NULL, matched boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _dd_rec(p_n integer, p_label text, p_actual text, p_expected text,
                                   p_like boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  v_ok := CASE WHEN p_like THEN p_actual LIKE p_expected ELSE p_actual IS NOT DISTINCT FROM p_expected END;
  INSERT INTO _dd_out VALUES (p_n, p_label, coalesce(p_actual, '<NULL>'), coalesce(p_expected, '<NULL>'), v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 3), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 3), p_label;
    RAISE WARNING '        expected: %', coalesce(p_expected, '<NULL>');
    RAISE WARNING '        actual:   %', coalesce(p_actual, '<NULL>');
  END IF;
END $$;

/* The next number for a company, as the owner. */
CREATE OR REPLACE FUNCTION _dd_next(p_company uuid) RETURNS text
LANGUAGE sql AS $$ SELECT _dd_call('owner', format('SELECT app_private.next_driver_personalnummer(%L)', p_company)) $$;

/* Removes every driver this file made in a company; the seed's driver stays. */
CREATE OR REPLACE FUNCTION _dd_clear(p_company uuid) RETURNS void
LANGUAGE sql AS $$
  DELETE FROM partner_driver_links WHERE company_id = p_company AND partner = 'reidey';
  DELETE FROM drivers WHERE company_id = p_company AND id::text LIKE '2d%';
$$;

/* A driver with every column that matters named; the trigger leaves a number it is given. */
CREATE OR REPLACE FUNCTION _dd_driver(p_company uuid, p_name text, p_number text,
                                      p_status text DEFAULT 'active',
                                      p_employment text DEFAULT 'employee') RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid := ('2d' || substr(md5(p_company::text || p_name), 1, 6) || '-0000-4000-8000-000000000000')::uuid;
BEGIN
  INSERT INTO drivers (id, company_id, name, status, employment_type, personalnummer)
  VALUES (v_id, p_company, p_name, p_status, p_employment, p_number);
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION _dd_day(p_back integer DEFAULT 0) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (((now() AT TIME ZONE 'Europe/Berlin') - interval '4 hours')::date - 1 - p_back)
$$;

CREATE OR REPLACE FUNCTION _dd_claim(p_company uuid, p_day date) RETURNS text
LANGUAGE sql AS $$
  SELECT _dd_call('service', format('SELECT uber_pull_claim(%L, %L, ''first'')::text', p_company, p_day))
$$;

CREATE OR REPLACE FUNCTION _dd_place(p_run text, p_earners jsonb) RETURNS text
LANGUAGE sql AS $$
  SELECT _dd_call('service', format('SELECT uber_pull_place_unlinked(%L::uuid, %L::jsonb)::text', p_run, p_earners::text))
$$;

CREATE OR REPLACE FUNCTION _dd_earner(p_ext text, p_name text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_object('external_driver_id', p_ext, 'name', p_name) $$;

-- ─── fixtures (as the owner, so RLS does not apply) ─────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
BEGIN
  UPDATE companies SET approval_status = 'approved', status = 'active',
                       subscription_status = 'active', subscription_expires_at = NULL,
                       subscription_car_limit = 1000
   WHERE id IN (co_a, co_b);
  -- The seed's drivers were numbered by the new trigger; the scenarios below
  -- start from a company with no number at all.
  UPDATE drivers SET personalnummer = NULL WHERE company_id IN (co_a, co_b);
END $$;

-- ─── 1. the next staff number ───────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  PERFORM _dd_rec(1, 'a company with no number gives 00001',
    _dd_next(co_a), '00001');

  PERFORM _dd_driver(co_a, 'Dd Owner', '00099', 'active', 'company_owner');
  PERFORM _dd_driver(co_a, 'Dd Eins', '00021');
  PERFORM _dd_driver(co_a, 'Dd Weg', '00022', 'inactive');
  PERFORM _dd_driver(co_a, 'Dd Text', 'abc');
  PERFORM _dd_driver(co_a, 'Dd Gemischt', '12x');
  PERFORM _dd_rec(2, 'the owner is left out, an inactive driver counts, text is ignored: 00023',
    _dd_next(co_a), '00023');

  PERFORM _dd_clear(co_a);
  PERFORM _dd_driver(co_a, 'Dd Owner', '23', 'active', 'company_owner');
  PERFORM _dd_driver(co_a, 'Dd Eins', '00022');
  PERFORM _dd_rec(3, 'the owner holds 23, which is 00023: skipped, never given twice',
    _dd_next(co_a), '00024');

  PERFORM _dd_clear(co_a);
  PERFORM _dd_driver(co_a, 'Dd Eins', '0099');
  PERFORM _dd_rec(4, 'the width of the last number is kept: 0100',
    _dd_next(co_a), '0100');

  PERFORM _dd_clear(co_a);
  PERFORM _dd_driver(co_a, 'Dd Eins', '999');
  PERFORM _dd_rec(5, 'a number longer than the width is never cut: 1000',
    _dd_next(co_a), '1000');

  PERFORM _dd_clear(co_a);
  PERFORM _dd_driver(co_a, 'Dd Eins', '7');
  PERFORM _dd_driver(co_a, 'Dd Zwei', '007');
  PERFORM _dd_rec(6, 'two spellings of the highest number: the longest decides the width',
    _dd_next(co_a), '008');

  PERFORM _dd_clear(co_a);
  PERFORM _dd_driver(co_a, 'Dd Eins', '  00004  ');
  PERFORM _dd_rec(7, 'surrounding blanks are not part of a number',
    _dd_next(co_a), '00005');

  PERFORM _dd_clear(co_a);
  PERFORM _dd_driver(co_a, 'Dd Eins', '00003');
  PERFORM _dd_driver(co_a, 'Dd Zwei', '5', 'inactive', 'company_owner');
  PERFORM _dd_rec(8, 'the owner''s low number is not "the last" either',
    _dd_next(co_a), '00004');
  PERFORM _dd_clear(co_a);
END $$;

-- ─── 2. the trigger and the default language ────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  v_id uuid;
BEGIN
  PERFORM _dd_driver(co_a, 'Dd Eins', '00010');

  INSERT INTO drivers (id, company_id, name) VALUES ('2d000000-0000-4000-8000-0000000000a1', co_a, 'Dd Neu A')
    RETURNING id INTO v_id;
  PERFORM _dd_rec(20, 'an active driver written without a number gets the next one',
    (SELECT personalnummer FROM drivers WHERE id = v_id), '00011');
  PERFORM _dd_rec(21, 'and German as the e-mail language',
    (SELECT preferred_language FROM drivers WHERE id = v_id), 'de');

  INSERT INTO drivers (id, company_id, name) VALUES ('2d000000-0000-4000-8000-0000000000a2', co_a, 'Dd Neu B');
  PERFORM _dd_rec(22, 'two inserts in one transaction are consecutive',
    (SELECT personalnummer FROM drivers WHERE id = '2d000000-0000-4000-8000-0000000000a2'), '00012');

  INSERT INTO drivers (id, company_id, name, personalnummer)
  VALUES ('2d000000-0000-4000-8000-0000000000a3', co_a, 'Dd Eigen', 'X-5');
  PERFORM _dd_rec(23, 'a number the caller wrote is never touched',
    (SELECT personalnummer FROM drivers WHERE id = '2d000000-0000-4000-8000-0000000000a3'), 'X-5');

  INSERT INTO drivers (id, company_id, name, status) VALUES ('2d000000-0000-4000-8000-0000000000a4', co_a, 'Dd Weg', 'inactive');
  PERFORM _dd_rec(24, 'an inactive driver gets none: departed people do not burn payroll numbers',
    (SELECT personalnummer FROM drivers WHERE id = '2d000000-0000-4000-8000-0000000000a4'), NULL);

  INSERT INTO drivers (id, company_id, name, employment_type)
  VALUES ('2d000000-0000-4000-8000-0000000000a5', co_a, 'Dd Inhaber', 'company_owner');
  PERFORM _dd_rec(25, 'the company owner gets none: his number comes from another range',
    (SELECT personalnummer FROM drivers WHERE id = '2d000000-0000-4000-8000-0000000000a5'), NULL);

  INSERT INTO drivers (id, company_id, name, personalnummer) VALUES ('2d000000-0000-4000-8000-0000000000a6', co_a, 'Dd Leer', '   ');
  PERFORM _dd_rec(26, 'a blank number counts as none',
    (SELECT personalnummer FROM drivers WHERE id = '2d000000-0000-4000-8000-0000000000a6'), '00013');

  INSERT INTO drivers (id, company_id, name) VALUES ('2d000000-0000-4000-8000-0000000000b1', co_b, 'Dd Fremd');
  PERFORM _dd_rec(27, 'another company counts on its own: its first is 00001',
    (SELECT personalnummer FROM drivers WHERE id = '2d000000-0000-4000-8000-0000000000b1'), '00001');

  UPDATE drivers SET name = 'Dd Neu A2' WHERE id = '2d000000-0000-4000-8000-0000000000a1';
  PERFORM _dd_rec(28, 'an UPDATE never renumbers',
    (SELECT personalnummer FROM drivers WHERE id = '2d000000-0000-4000-8000-0000000000a1'), '00011');

  INSERT INTO drivers (id, company_id, name, preferred_language)
  VALUES ('2d000000-0000-4000-8000-0000000000a7', co_a, 'Dd Englisch', 'en');
  PERFORM _dd_rec(29, 'a language written is kept; only the default moved',
    (SELECT preferred_language FROM drivers WHERE id = '2d000000-0000-4000-8000-0000000000a7'), 'en');

  PERFORM _dd_rec(30, 'the column default is de',
    (SELECT pg_get_expr(a.adbin, a.adrelid) FROM pg_attrdef a
      WHERE a.adrelid = 'public.drivers'::regclass
        AND a.adnum = (SELECT attnum FROM pg_attribute
                        WHERE attrelid = 'public.drivers'::regclass AND attname = 'preferred_language')),
    '''de''::text');
  PERFORM _dd_clear(co_a);
  PERFORM _dd_clear(co_b);
END $$;

-- ─── 3. driver_next_personalnummer ──────────────────────────────────────────

DO $$
DECLARE
  co_a     constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a  constant text := 'a0000000-0000-4000-8000-000000000001';
  viewer_a constant text := 'a0000000-0000-4000-8000-000000000003';
  admin_b  constant text := 'b0000000-0000-4000-8000-000000000001';
  v_call   constant text := 'SELECT driver_next_personalnummer()';
BEGIN
  PERFORM _dd_driver(co_a, 'Dd Eins', '00041');
  PERFORM _dd_rec(40, 'an administrator is shown the next number',
    _dd_call(admin_a, v_call), '00042');
  PERFORM _dd_rec(41, 'a viewer may not edit drivers: NULL, not a number',
    _dd_call(viewer_a, v_call), 'null');
  PERFORM _dd_rec(42, 'anon cannot execute it',
    _dd_call('anon', v_call), 'ERR 42501 (no hint)');
  PERFORM _dd_rec(43, 'another company''s administrator reads its own company''s number',
    _dd_call(admin_b, v_call), (SELECT _dd_next('c0000000-0000-4000-8000-00000000000b')));
  PERFORM _dd_rec(44, 'asking is not taking: the number is still free afterwards',
    _dd_next(co_a), '00042');
  PERFORM _dd_clear(co_a);
END $$;

-- ─── 4. uber_pull_place_unlinked ────────────────────────────────────────────

DO $$
DECLARE
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
  v_run   text;
  v_late  text;
  v_other uuid;
  v_gone  uuid;
  v_n     integer;
  v_call  text;
BEGIN
  PERFORM _dd_driver(co_a, 'Dd Alt', '00007');
  -- Active with a number below the highest, so the probe can see that placing a
  -- driver changes neither name nor number and that 00009 is still the next one.
  v_other := _dd_driver(co_a, 'Omar Khalil', '00005');
  -- Departed, with no link: the nightly call must refuse it, never link to it.
  v_gone := _dd_driver(co_a, 'Lena Weg', NULL, 'inactive');
  PERFORM _dd_driver(co_a, 'Held Name', '00008');
  INSERT INTO partner_driver_links (company_id, partner, external_driver_id, driver_id, status, linked_at)
  VALUES (co_a, 'reidey', '6010', (SELECT id FROM drivers WHERE company_id = co_a AND name = 'Held Name'), 'linked', now());
  INSERT INTO partner_driver_links (company_id, partner, external_driver_id, proposed_name, status)
  VALUES (co_a, 'reidey', '6005', 'Rita Rejected', 'rejected');

  v_run := _dd_claim(co_a, _dd_day(0));
  v_call := format('SELECT uber_pull_place_unlinked(%L::uuid, ''[]''::jsonb)::text', v_run);

  PERFORM _dd_rec(60, 'anon cannot execute it', _dd_call('anon', v_call), 'ERR 42501%', true);
  PERFORM _dd_rec(61, 'an administrator cannot execute it', _dd_call(admin_a, v_call), 'ERR 42501%', true);

  v_n := (SELECT count(*) FROM drivers WHERE company_id = co_a);
  PERFORM _dd_rec(62, 'an unknown run is a returned refusal',
    _dd_place(gen_random_uuid()::text, '[]'::jsonb), '{"ok": false, "reason": "run_not_open"}');
  PERFORM _dd_rec(63, 'more than five earners are refused, and nothing is created',
    _dd_place(v_run, jsonb_build_array(_dd_earner('6101', 'Dd Eins Neu'), _dd_earner('6102', 'Dd Zwei Neu'),
      _dd_earner('6103', 'Dd Drei Neu'), _dd_earner('6104', 'Dd Vier Neu'), _dd_earner('6105', 'Dd Fuenf Neu'),
      _dd_earner('6106', 'Dd Sechs Neu')))
    || ' / ' || ((SELECT count(*) FROM drivers WHERE company_id = co_a) - v_n)::text,
    '{"ok": false, "reason": "too_many"} / 0');

  -- The happy path: one new name, one name that matches an unlinked active
  -- driver (case and padding differ), one name held by a driver linked
  -- elsewhere, one that only a departed driver holds, one earner whose link a
  -- person rejected.
  v_n := (SELECT count(*) FROM drivers WHERE company_id = co_a);
  PERFORM _dd_rec(64, 'the answer names what was created, linked and refused',
    _dd_place(v_run, jsonb_build_array(
      _dd_earner('6001', '  Neu Fahrer '), _dd_earner('6002', ' omar khalil'),
      _dd_earner('6003', 'HELD name'), _dd_earner('6004', 'lena weg'),
      _dd_earner('6005', 'Rita Rejected'))),
    '{"ok": true, "linked": [{"name": "Omar Khalil"}], "created": [{"name": "Neu Fahrer"}], '
    || '"refused": [{"name": "HELD name", "reason": "name_taken"}, {"name": "lena weg", "reason": "name_inactive"}, '
    || '{"name": "Rita Rejected", "reason": "rejected"}]}');

  PERFORM _dd_rec(65, 'exactly one driver was created',
    ((SELECT count(*) FROM drivers WHERE company_id = co_a) - v_n)::text, '1');
  PERFORM _dd_rec(66, 'the created driver is ACTIVE, numbered after the last and German',
    (SELECT status || ' ' || personalnummer || ' ' || preferred_language
       FROM drivers WHERE company_id = co_a AND name = 'Neu Fahrer'), 'active 00009 de');
  PERFORM _dd_rec(67, 'and linked to the earner',
    (SELECT l.status FROM partner_driver_links l JOIN drivers d ON d.id = l.driver_id
      WHERE l.company_id = co_a AND l.external_driver_id = '6001' AND d.name = 'Neu Fahrer'), 'linked');
  PERFORM _dd_rec(68, 'the matched driver was linked and never renamed or renumbered',
    (SELECT d.name || ' ' || coalesce(d.personalnummer, 'null') || ' ' || l.status
       FROM drivers d JOIN partner_driver_links l ON l.driver_id = d.id AND l.external_driver_id = '6002'
      WHERE d.id = v_other), 'Omar Khalil 00005 linked');
  PERFORM _dd_rec(69, 'the refused ones got no link and no driver',
    (SELECT count(*)::text FROM partner_driver_links WHERE company_id = co_a AND external_driver_id = '6003')
    || '/' || (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND lower(name) IN ('held name'))
    , '0/1');
  PERFORM _dd_rec(75, 'the departed driver was neither linked nor touched, and no namesake was created',
    (SELECT count(*)::text FROM partner_driver_links WHERE company_id = co_a AND external_driver_id = '6004')
    || '/' || (SELECT status || ' ' || coalesce(personalnummer, 'null') FROM drivers WHERE id = v_gone)
    || '/' || (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND lower(name) = 'lena weg'),
    '0/inactive null/1');
  PERFORM _dd_rec(70, 'the run records what was placed, for the screen',
    (SELECT placed_drivers::text FROM uber_pull_runs WHERE id = v_run::uuid),
    '[{"name": "Neu Fahrer", "action": "created"}, {"name": "Omar Khalil", "action": "linked"}]');

  -- A second call for the same earners places nobody again.
  v_n := (SELECT count(*) FROM drivers WHERE company_id = co_a);
  PERFORM _dd_place(v_run, jsonb_build_array(_dd_earner('6001', 'Neu Fahrer')));
  PERFORM _dd_rec(71, 'an earner already linked is not created again',
    ((SELECT count(*) FROM drivers WHERE company_id = co_a) - v_n)::text, '0');

  -- A settled run takes no placement.
  PERFORM _dd_call('service', format('SELECT uber_pull_settle(%L::uuid, ''failed'', NULL, 0)::text', v_run));
  PERFORM _dd_rec(72, 'a settled run is refused',
    _dd_place(v_run, jsonb_build_array(_dd_earner('6201', 'Dd Spaet'))),
    '{"ok": false, "reason": "run_not_open"}');
  PERFORM _dd_rec(73, 'and nothing was created for it',
    (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND name = 'Dd Spaet'), '0');

  -- A company that may not be written to.
  UPDATE companies SET subscription_status = 'inactive' WHERE id = co_a;
  v_late := _dd_claim(co_a, _dd_day(1));
  PERFORM _dd_rec(74, 'a company that is blocked is refused, with nothing created',
    _dd_place(v_late, jsonb_build_array(_dd_earner('6301', 'Dd Gesperrt')))
    || ' / ' || (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND name = 'Dd Gesperrt'),
    '{"ok": false, "reason": "company_blocked"} / 0');
  UPDATE companies SET subscription_status = 'active' WHERE id = co_a;

  PERFORM _dd_clear(co_a);
END $$;

-- ─── 5. the human resolve is unchanged ──────────────────────────────────────

DO $$
DECLARE
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
  viewer_a constant text := 'a0000000-0000-4000-8000-000000000003';
  v_call  text;
BEGIN
  PERFORM _dd_driver(co_a, 'Dd Alt', '00020');
  v_call := format($q$SELECT partner_earners_resolve('reidey', %L::jsonb)::text$q$,
                   jsonb_build_array(_dd_earner('7001', 'Ehemalige Fahrerin'))::text);

  PERFORM _dd_rec(80, 'a viewer is still refused by the administrator gate',
    _dd_call(viewer_a, v_call), 'ERR 42501 not_authorized');
  PERFORM _dd_rec(81, 'an administrator creates the departed driver INACTIVE',
    _dd_call(admin_a, v_call),
    '{"ok": true, "linked": [], "already": 0, "created": [{"name": "Ehemalige Fahrerin", "external_driver_id": "7001"}], "skipped": []}');
  PERFORM _dd_rec(82, 'with NO staff number, so a departed person burns none',
    (SELECT status || ' ' || coalesce(personalnummer, 'null')
       FROM drivers WHERE company_id = co_a AND name = 'Ehemalige Fahrerin'), 'inactive null');
  PERFORM _dd_rec(83, 'and the next number is still the next one',
    _dd_next(co_a), '00021');
  -- The nightly call refuses a departed namesake (probe 75); the human call,
  -- whose result an administrator reads, links it exactly as before.
  PERFORM _dd_driver(co_a, 'Dd Gegangen', NULL, 'inactive');
  PERFORM _dd_rec(84, 'the human call still links a departed driver of the same name',
    _dd_call(admin_a, format($q$SELECT partner_earners_resolve('reidey', %L::jsonb)::text$q$,
                             jsonb_build_array(_dd_earner('7002', 'dd gegangen'))::text)),
    '{"ok": true, "linked": [{"name": "Dd Gegangen", "external_driver_id": "7002"}], "already": 0, "created": [], "skipped": []}');
  PERFORM _dd_clear(co_a);
END $$;

-- ─── result ────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad integer := (SELECT count(*) FROM _dd_out WHERE NOT matched);
  v_all integer := (SELECT count(*) FROM _dd_out);
BEGIN
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'driver defaults: % of % probes did not match', v_bad, v_all;
  END IF;
  RAISE NOTICE 'driver defaults: all % probes matched', v_all;
END $$;

ROLLBACK;
