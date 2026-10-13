-- ════════════════════════════════════════════════════════════════════════════
--  Uber earnings import: income_import_uber and the index behind it
--  (20261013120000)
-- ════════════════════════════════════════════════════════════════════════════
--
--  What this file separates, and why a grid cell could not:
--
--    §1  the happy path writes OUR drivers row's name, character for
--        character. The seed's driver carries a DOUBLE space inside the name, so
--        a function that trimmed, collapsed or re-spelled the name - or wrote
--        the partner's id into the column - reads differently here.
--    §2  a second import is refused, and refused BY THE INDEX: probe 8 inserts
--        the duplicate key as the table owner, past every function and every
--        policy, and names the constraint that refused it. A check that lived
--        only in the function would pass probes 6 and 7 and fail 8.
--    §3  one unlinked driver stops the WHOLE call and leaves no row behind -
--        a pending link, another company's link and an unknown id all count.
--    §4  who may call it: editor yes, viewer no, anon cannot execute, a
--        platform account with no context or with a support or view context no.
--    §5  the shape of a row is checked again by the database, and a failure
--        halfway through the INSERT leaves nothing (atomicity).
--
--  Every refusal is read as `ERR <sqlstate> <hint>`. The gate (not_authorized)
--  and the lookup (driver_not_linked) raise DIFFERENT hints on purpose, so a
--  cell cannot read green because two refusals look alike.
--
--  Runs inside BEGIN ... ROLLBACK, so the files after it see only the
--  migrations and the seeds. Ids start with `1f` so a failure names a row.

BEGIN;

-- GoTrue's session table is a stub in the kit (platform-contexts.sql makes the
-- same one); a support context is tied to a session id, and this file needs one.
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

CREATE OR REPLACE FUNCTION _ui_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- Discard the owner's cached plans first: a privilege error is raised at
  -- parse time and the plan the owner just warmed would hide it.
  DISCARD PLANS;
  IF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  IF p_session IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.session_id', p_session::text, true);
  END IF;
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/* Runs p_sql as p_user (the owner when NULL and p_owner), returns the scalar or
   `ERR <sqlstate> <hint>[ <detail>]` / `ERR <sqlstate> <constraint>` for a
   unique violation. Writes persist unless the statement raised. */
CREATE OR REPLACE FUNCTION _ui_call(p_user uuid, p_sql text, p_session uuid DEFAULT NULL,
                                    p_owner boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text; v_hint text; v_detail text; v_state text; v_constraint text;
BEGIN
  IF NOT p_owner THEN PERFORM _ui_as(p_user, p_session); END IF;
  EXECUTE p_sql INTO v_out;
  RESET ROLE;
  RETURN coalesce(v_out, 'null');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_detail = PG_EXCEPTION_DETAIL,
                          v_state = RETURNED_SQLSTATE, v_constraint = CONSTRAINT_NAME;
  RESET ROLE;
  RETURN 'ERR ' || v_state || ' ' || coalesce(nullif(v_constraint, ''), nullif(v_hint, ''), '(no hint)')
         || CASE WHEN nullif(v_constraint, '') IS NULL THEN coalesce(' ' || nullif(v_detail, ''), '') ELSE '' END;
END $$;

CREATE TEMP TABLE _ui_out (
  n integer PRIMARY KEY, label text NOT NULL,
  actual text NOT NULL, expected text NOT NULL, matched boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _ui_rec(p_n integer, p_label text, p_actual text, p_expected text,
                                   p_like boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  v_ok := CASE WHEN p_like THEN p_actual LIKE p_expected ELSE p_actual = p_expected END;
  INSERT INTO _ui_out VALUES (p_n, p_label, p_actual, p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', p_actual;
  END IF;
END $$;

/* One row of the p_rows array, as the browser builds it. */
CREATE OR REPLACE FUNCTION _ui_row(p_ext text, p_type text, p_amount text,
                                   p_from text, p_to text, p_week int DEFAULT 1,
                                   p_trips int DEFAULT NULL) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('external_driver_id', p_ext, 'type', p_type, 'amount', p_amount,
                            'date', p_from, 'week', p_week, 'description', 'Woche ' || p_week || ' - Uber',
                            'trip_count', p_trips, 'period_start', p_from, 'period_end', p_to)
$$;

CREATE OR REPLACE FUNCTION _ui_import(p_rows jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format('SELECT income_import_uber(%L::jsonb)::text', p_rows::text)
$$;

-- ─── fixtures (as the owner, so RLS does not apply) ─────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
BEGIN
  -- A name with a double space inside: written back unchanged, or the probe sees.
  INSERT INTO drivers (id, company_id, name) VALUES
    ('1f000000-0000-4000-8000-000000000001', co_a, 'Zoë  Müller'),
    ('1f000000-0000-4000-8000-000000000002', co_a, 'Omar Khalil'),
    ('1f000000-0000-4000-8000-000000000003', co_a, 'Pending Person'),
    ('1f000000-0000-4000-8000-0000000000b1', co_b, 'Zoë  Müller');

  INSERT INTO partner_driver_links (company_id, partner, external_driver_id, driver_id, status, linked_at)
  VALUES (co_a, 'reidey', '1001', '1f000000-0000-4000-8000-000000000001', 'linked', now()),
         (co_a, 'reidey', '1002', '1f000000-0000-4000-8000-000000000002', 'linked', now()),
         (co_b, 'reidey', '2001', '1f000000-0000-4000-8000-0000000000b1', 'linked', now());
  -- Proposed by the partner and not confirmed by a person: not a link.
  INSERT INTO partner_driver_links (company_id, partner, external_driver_id, status, proposed_name)
  VALUES (co_a, 'reidey', '1003', 'pending', 'Pending Person');

  -- A platform account with a sign-in session of its own, for the context probes.
  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES ('1f000000-0000-4000-8000-0000000000e1', 'ui-staff@test.invalid', now());
  INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
  VALUES ('1f000000-0000-4000-8000-0000000000e1', 'ui-staff@test.invalid', 'UI Staff', 'viewer',
          (SELECT id FROM roles WHERE name = 'viewer' AND company_id IS NULL LIMIT 1), NULL, 'active');
  INSERT INTO app_private.platform_staff (user_id, role, note)
  VALUES ('1f000000-0000-4000-8000-0000000000e1', 'owner', 'ui');
  INSERT INTO auth.sessions (id, user_id)
  VALUES ('1f000000-0000-4000-8000-0000000000e2', '1f000000-0000-4000-8000-0000000000e1');
END $$;

-- ─── 1. the happy path, and whose name is written ──────────────────────────

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _ui_rec(1, 'an administrator imports one driver''s week: three rows, one driver',
    _ui_call(admin_a, _ui_import(jsonb_build_array(
      _ui_row('1001', 'umsatz',    '664.19', '2026-10-05', '2026-10-11', 1, 67),
      _ui_row('1001', 'trinkgeld', '28.00',  '2026-10-05', '2026-10-11', 1),
      _ui_row('1001', 'bargeld',   '226.26', '2026-10-05', '2026-10-11', 1)))) :: text,
    '{"ok": true, "drivers": 1, "inserted": 3}');

  PERFORM _ui_rec(2, 'driver_name is OUR drivers row''s name, character for character',
    (SELECT string_agg(DISTINCT driver_name, '|') FROM income WHERE source = 'uber' AND company_id = 'c0000000-0000-4000-8000-00000000000a'),
    (SELECT name FROM drivers WHERE id = '1f000000-0000-4000-8000-000000000001'));

  PERFORM _ui_rec(3, 'the double space survived (no trim, no collapse)',
    (SELECT (driver_name = E'Zoë  Müller')::text FROM income WHERE source = 'uber' LIMIT 1), 'true');

  PERFORM _ui_rec(4, 'the amount is exact and the trip count sits on the net-fare row only',
    (SELECT string_agg(type || ':' || amount::text || ':' || coalesce(trip_count::text, '-'), ' ' ORDER BY type)
       FROM income WHERE source = 'uber'),
    'bargeld:226.26:- trinkgeld:28.00:- umsatz:664.19:67');

  PERFORM _ui_rec(5, 'the row says where it came from and which days it covers',
    (SELECT DISTINCT source || ' ' || source_driver_key || ' ' || source_period_start || ' ' || source_period_end || ' ' || week
       FROM income WHERE source = 'uber'),
    'uber 1001 2026-10-05 2026-10-11 1');
END $$;

-- ─── 2. a second import is refused - by the index ──────────────────────────

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_before integer := (SELECT count(*) FROM income WHERE source = 'uber');
BEGIN
  PERFORM _ui_rec(6, 'the same period again is refused with 23505 and a stable reason',
    _ui_call(admin_a, _ui_import(jsonb_build_array(
      _ui_row('1001', 'umsatz', '664.19', '2026-10-05', '2026-10-11', 1, 67)))),
    'ERR 23505 already_imported');

  PERFORM _ui_rec(7, 'a period that only OVERLAPS an imported one is refused too',
    _ui_call(admin_a, _ui_import(jsonb_build_array(
      _ui_row('1001', 'aktionen', '5.00', '2026-10-08', '2026-10-11', 1)))),
    'ERR 23505 already_imported');

  -- Past the function, past every policy: the table owner inserts the key again.
  PERFORM _ui_rec(8, 'the INDEX refuses the duplicate key even with the function bypassed',
    _ui_call(NULL, $q$INSERT INTO income (description, amount, type, driver_name, date, company_id,
        source, source_period_start, source_period_end, source_driver_key)
      VALUES ('x', 1, 'umsatz', 'x', '2026-10-05', 'c0000000-0000-4000-8000-00000000000a',
        'uber', '2026-10-05', '2026-10-11', '1001') RETURNING 'inserted'$q$, NULL, true),
    'ERR 23505 income_source_period_key');

  PERFORM _ui_rec(9, 'nothing was written by the refusals',
    (SELECT count(*)::text FROM income WHERE source = 'uber'), v_before::text);

  PERFORM _ui_rec(10, 'the next week for the same driver is a different period and succeeds',
    _ui_call(admin_a, _ui_import(jsonb_build_array(
      _ui_row('1001', 'umsatz', '10.00', '2026-10-12', '2026-10-13', 2, 3)))) :: text,
    '{"ok": true, "drivers": 1, "inserted": 1}');

  -- The key is partial: it constrains imported rows only.
  PERFORM _ui_rec(11, 'two identical hand-entered rows are still allowed (the index is partial)',
    _ui_call(NULL, $q$WITH a AS (INSERT INTO income (description, amount, type, driver_name, date, company_id)
        VALUES ('hand', 1, 'umsatz', 'Hand', '2026-10-05', 'c0000000-0000-4000-8000-00000000000a') RETURNING 1),
      b AS (INSERT INTO income (description, amount, type, driver_name, date, company_id)
        VALUES ('hand', 1, 'umsatz', 'Hand', '2026-10-05', 'c0000000-0000-4000-8000-00000000000a') RETURNING 1)
      SELECT 'both' FROM a, b$q$, NULL, true),
    'both');

  PERFORM _ui_rec(12, 'a source with no driver key is not representable (income_source_shape)',
    _ui_call(NULL, $q$INSERT INTO income (description, amount, type, driver_name, date, company_id, source)
      VALUES ('x', 1, 'umsatz', 'x', '2026-10-05', 'c0000000-0000-4000-8000-00000000000a', 'uber') RETURNING 'inserted'$q$, NULL, true),
    'ERR 23514 income_source_shape');
END $$;

-- ─── 3. an unlinked driver stops the whole call ────────────────────────────

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_before integer := (SELECT count(*) FROM income WHERE source = 'uber');
BEGIN
  PERFORM _ui_rec(13, 'a pending (unconfirmed) link is not a link: the call is refused and names it',
    _ui_call(admin_a, _ui_import(jsonb_build_array(
      _ui_row('1002', 'umsatz', '50.00', '2026-10-05', '2026-10-11', 1),
      _ui_row('1003', 'umsatz', '60.00', '2026-10-05', '2026-10-11', 1)))),
    'ERR 22023 driver_not_linked 1003');

  PERFORM _ui_rec(14, 'the linked driver beside it was NOT written (whole import or nothing)',
    (SELECT count(*)::text FROM income WHERE source = 'uber'), v_before::text);

  PERFORM _ui_rec(15, 'another company''s link does not count',
    _ui_call(admin_a, _ui_import(jsonb_build_array(
      _ui_row('2001', 'umsatz', '50.00', '2026-10-05', '2026-10-11', 1)))),
    'ERR 22023 driver_not_linked 2001');

  PERFORM _ui_rec(16, 'an id nobody linked is named, and every unlinked id is listed',
    _ui_call(admin_a, _ui_import(jsonb_build_array(
      _ui_row('9999', 'umsatz', '1.00', '2026-10-05', '2026-10-11', 1),
      _ui_row('1003', 'umsatz', '1.00', '2026-10-05', '2026-10-11', 1)))),
    'ERR 22023 driver_not_linked 1003,9999');
END $$;

-- ─── 4. who may call it ─────────────────────────────────────────────────────

DO $$
DECLARE
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  editor_a constant uuid := 'a0000000-0000-4000-8000-000000000002';
  viewer_a constant uuid := 'a0000000-0000-4000-8000-000000000003';
  admin_b  constant uuid := 'b0000000-0000-4000-8000-000000000001';
  staff    constant uuid := '1f000000-0000-4000-8000-0000000000e1';
  staff_s  constant uuid := '1f000000-0000-4000-8000-0000000000e2';
  co_a     constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_before integer := (SELECT count(*) FROM income WHERE source = 'uber');
  v_one    text := _ui_import(jsonb_build_array(_ui_row('1002', 'umsatz', '50.00', '2026-10-19', '2026-10-25', 3)));
BEGIN
  PERFORM _ui_rec(17, 'a viewer may not import (the page gate, not the link lookup)',
    _ui_call(viewer_a, v_one), 'ERR 42501 not_authorized');
  PERFORM _ui_rec(18, 'a viewer wrote nothing',
    (SELECT count(*)::text FROM income WHERE source = 'uber'), v_before::text);

  PERFORM _ui_rec(19, 'an editor may - the same page gate the table''s own policies ask',
    _ui_call(editor_a, v_one) :: text, '{"ok": true, "drivers": 1, "inserted": 1}');

  PERFORM _ui_rec(20, 'anon cannot execute it',
    _ui_call(NULL, v_one), 'ERR 42501 (no hint)');
  PERFORM _ui_rec(21, 'the grants: authenticated yes, anon no, PUBLIC no',
    (has_function_privilege('authenticated', 'public.income_import_uber(jsonb)', 'EXECUTE')::text || '/' ||
     has_function_privilege('anon', 'public.income_import_uber(jsonb)', 'EXECUTE')::text || '/' ||
     EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = 'public.income_import_uber(jsonb)'::regprocedure AND a.grantee = 0)::text),
    'true/false/false');

  -- Company B has its own driver 2001; A's 1001 is nobody's in B.
  PERFORM _ui_rec(22, 'another company''s administrator cannot use this company''s link',
    _ui_call(admin_b, _ui_import(jsonb_build_array(_ui_row('1001', 'umsatz', '5.00', '2026-10-05', '2026-10-11', 1)))),
    'ERR 22023 driver_not_linked 1001');
  PERFORM _ui_rec(23, 'and imports its own, under its own driver row''s name',
    _ui_call(admin_b, _ui_import(jsonb_build_array(_ui_row('2001', 'umsatz', '5.00', '2026-10-05', '2026-10-11', 1)))) :: text,
    '{"ok": true, "drivers": 1, "inserted": 1}');
  PERFORM _ui_rec(24, 'the row landed in company B',
    (SELECT company_id::text || ' ' || driver_name FROM income WHERE source = 'uber' AND source_driver_key = '2001'),
    'c0000000-0000-4000-8000-00000000000b ' || E'Zoë  Müller');

  PERFORM _ui_rec(25, 'a platform account with no context has no company: refused',
    _ui_call('50000000-0000-4000-8000-000000000001', v_one), 'ERR 42501 not_authorized');

  -- A support session and a view session both make get_active_company_id()
  -- answer the opened company, so ONLY the membership comparison refuses them.
  PERFORM _ui_call(staff, format($q$SELECT platform_context_open(%L, 'support', 'income import probe, long enough')::text$q$, co_a), staff_s);
  PERFORM _ui_rec(26, 'the context is open: get_active_company_id() answers the company',
    _ui_call(staff, 'SELECT get_active_company_id()::text', staff_s), co_a::text);
  PERFORM _ui_rec(27, 'a platform account inside a SUPPORT session is refused with its own reason',
    _ui_call(staff, v_one, staff_s), 'ERR 42501 platform_session_not_allowed');
  PERFORM _ui_call(staff, 'SELECT platform_context_close(NULL)::text', staff_s);
  PERFORM _ui_call(staff, format($q$SELECT platform_context_open(%L, 'view')::text$q$, co_a), staff_s);
  PERFORM _ui_rec(28, 'and inside a VIEW session',
    _ui_call(staff, v_one, staff_s), 'ERR 42501 platform_session_not_allowed');
  PERFORM _ui_call(staff, 'SELECT platform_context_close(NULL)::text', staff_s);
END $$;

-- ─── 5. the database reads every row again ─────────────────────────────────

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_before integer := (SELECT count(*) FROM income WHERE source = 'uber');
BEGIN
  PERFORM _ui_rec(29, 'a comma amount is refused, never read as a thousand',
    _ui_call(admin_a, _ui_import(jsonb_build_array(_ui_row('1002', 'umsatz', '12,50', '2026-10-26', '2026-11-01', 4)))),
    'ERR 22023 invalid_request');
  PERFORM _ui_rec(30, 'a JSON number amount is refused',
    _ui_call(admin_a, format($q$SELECT income_import_uber(%L::jsonb)::text$q$,
      jsonb_build_array(jsonb_set(_ui_row('1002', 'umsatz', '1.00', '2026-10-26', '2026-11-01', 4), '{amount}', '12.5'::jsonb))::text)),
    'ERR 22023 invalid_request');
  PERFORM _ui_rec(31, 'a negative amount is refused',
    _ui_call(admin_a, _ui_import(jsonb_build_array(_ui_row('1002', 'umsatz', '-1.00', '2026-10-26', '2026-11-01', 4)))),
    'ERR 22023 invalid_request');
  PERFORM _ui_rec(32, 'a type outside the four is refused',
    _ui_call(admin_a, _ui_import(jsonb_build_array(_ui_row('1002', 'nettofahrt', '1.00', '2026-10-26', '2026-11-01', 4)))),
    'ERR 22023 invalid_request');
  PERFORM _ui_rec(33, 'week 6 is refused',
    _ui_call(admin_a, _ui_import(jsonb_build_array(_ui_row('1002', 'umsatz', '1.00', '2026-10-26', '2026-11-01', 6)))),
    'ERR 22023 invalid_request');
  PERFORM _ui_rec(34, 'a date that does not exist is a refusal, not a cast error',
    _ui_call(admin_a, _ui_import(jsonb_build_array(_ui_row('1002', 'umsatz', '1.00', '2026-02-30', '2026-02-30', 1)))),
    'ERR 22023 invalid_request');
  PERFORM _ui_rec(35, 'a period longer than a week is refused',
    _ui_call(admin_a, _ui_import(jsonb_build_array(_ui_row('1002', 'umsatz', '1.00', '2026-10-26', '2026-11-09', 4)))),
    'ERR 22023 invalid_period');
  PERFORM _ui_rec(36, 'a row dated outside its own period is refused',
    _ui_call(admin_a, _ui_import(jsonb_build_array(
      jsonb_set(_ui_row('1002', 'umsatz', '1.00', '2026-10-26', '2026-10-28', 4), '{date}', '"2026-11-30"')))),
    'ERR 22023 invalid_period');
  PERFORM _ui_rec(37, 'an empty array, NULL and a non-array are refused',
    _ui_call(admin_a, _ui_import('[]'::jsonb)) || ' / ' ||
    _ui_call(admin_a, 'SELECT income_import_uber(NULL)::text') || ' / ' ||
    _ui_call(admin_a, $q$SELECT income_import_uber('{"a":1}'::jsonb)::text$q$),
    'ERR 22023 invalid_request / ERR 22023 invalid_request / ERR 22023 invalid_request');

  -- Halfway through the INSERT: both rows pass every check above and the second
  -- collides with the first inside the same statement.
  PERFORM _ui_rec(38, 'a collision INSIDE the call is refused...',
    _ui_call(admin_a, _ui_import(jsonb_build_array(
      _ui_row('1002', 'umsatz', '1.00', '2026-10-26', '2026-11-01', 4),
      _ui_row('1002', 'umsatz', '2.00', '2026-10-26', '2026-11-01', 4)))),
    'ERR 23505 already_imported');
  PERFORM _ui_rec(39, '...and the first row of that call did not survive it',
    (SELECT count(*)::text FROM income WHERE source = 'uber'), v_before::text);
END $$;

-- ─── the verdict ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad int;
  v_all int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT matched), count(*) INTO v_bad, v_all FROM _ui_out;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'income import uber: % of % probe(s) did not match — read the XX lines above', v_bad, v_all;
  END IF;
  RAISE NOTICE '── income import uber: all % probes matched ──', v_all;
END $$;

ROLLBACK;
