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
--    §7  replace mode (20261014100000, owner 14.10.2026): the previous Uber rows
--        for exactly the payload's (driver, week, type) are replaced, the figure
--        is the NEW one only, and nothing else goes. The probes that matter:
--          49  a hand-typed row (source NULL) for the SAME driver, week and type
--              survives. It fires if the delete is keyed on the TEXT columns
--              (driver_name, date, type) instead of the index's own, or widened
--              with an OR: the typed 7,00 EUR row disappears, probe 49 reads
--              `none` and the deleted count in probe 46 reads 4, not 3. Be exact
--              about its limit: dropping `source = c_source` ALONE is not seen
--              here, because `source_driver_key = k.driver_key` is also never
--              true for a NULL key (income_source_shape ties the four columns
--              together). That term is held by the migration's self-check and
--              by src/utils/incomeImportReplace.test.ts, which read the text.
--          51  company B's row with the SAME driver key and week survives (the
--              `company_id = v_company` term).
--          53  a pending link's rows survive and the call is refused before
--              anything is deleted (the confirmed-link term).
--    The order in the file is not the order of the numbers: §7 sits between §3
--    and §4 because §4 opens platform contexts, after which a plain owner INSERT
--    into income is refused by the write flag the context leaves behind.
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

/* The same call with the replace flag, named (true) or spelled out (false). */
CREATE OR REPLACE FUNCTION _ui_replace(p_rows jsonb, p_flag boolean DEFAULT true) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format('SELECT income_import_uber(%L::jsonb, %L::boolean)::text', p_rows::text, p_flag::text)
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

  -- A row somebody typed, for section 6. It goes in HERE, before any support
  -- context is opened below: once one has been, the transaction-local write
  -- flag is still set and a plain owner INSERT into income is refused.
  INSERT INTO income (description, amount, type, driver_name, date, company_id)
  VALUES ('Woche 1 - von Hand', 100, 'umsatz', 'Omar Khalil', '2026-11-03', co_a);

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

-- ─── 7. replace: the previous Uber rows go, the new ones stand ─────────────
--
-- Placed before section 4 on purpose (see the header). Everything the replace
-- must NOT touch is seeded first, as the owner, then one replace is run and
-- every bystander is read back.

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
BEGIN
  -- A typed row for the SAME driver, week and type as the imported week: it has
  -- source NULL and the index does not see it.
  INSERT INTO income (description, amount, type, driver_name, date, company_id)
  VALUES ('hand typed', 7.00, 'umsatz', E'Zoë  Müller', '2026-10-06', co_a);

  -- Company B holds an Uber row with the SAME driver key and week as A's.
  INSERT INTO income (description, amount, type, driver_name, date, company_id,
                      source, source_period_start, source_period_end, source_driver_key)
  VALUES ('Woche 1 - Uber', 9.00, 'umsatz', E'Zoë  Müller', '2026-10-05', co_b,
          'uber', '2026-10-05', '2026-10-11', '1001');

  -- Company B's row under its OWN key 2001, in a week of its own.
  INSERT INTO income (description, amount, type, driver_name, date, company_id,
                      source, source_period_start, source_period_end, source_driver_key)
  VALUES ('Woche 5 - Uber', 5.50, 'umsatz', E'Zoë  Müller', '2026-09-28', co_b,
          'uber', '2026-09-28', '2026-10-04', '2001');

  -- A's own row under a key whose link is only PENDING.
  INSERT INTO income (description, amount, type, driver_name, date, company_id,
                      source, source_period_start, source_period_end, source_driver_key)
  VALUES ('Woche 1 - Uber', 3.00, 'umsatz', 'Pending Person', '2026-10-05', co_a,
          'uber', '2026-10-05', '2026-10-11', '1003');
END $$;

DO $$
DECLARE
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  viewer_a constant uuid := 'a0000000-0000-4000-8000-000000000003';
  v_week   jsonb := jsonb_build_array(
      _ui_row('1001', 'umsatz',    '500.00', '2026-10-05', '2026-10-11', 1, 60),
      _ui_row('1001', 'trinkgeld', '30.00',  '2026-10-05', '2026-10-11', 1),
      _ui_row('1001', 'bargeld',   '200.00', '2026-10-05', '2026-10-11', 1));
  v_all    integer := (SELECT count(*) FROM income);
  v_answer text;
BEGIN
  PERFORM _ui_rec(42, 'WITHOUT the flag the corrected week is still refused, and nothing moved',
    _ui_call(admin_a, _ui_import(v_week)) || ' / ' ||
    (SELECT string_agg(type || ':' || amount::text, ' ' ORDER BY type) FROM income
      WHERE source = 'uber' AND source_driver_key = '1001'
        AND source_period_start = '2026-10-05' AND company_id = 'c0000000-0000-4000-8000-00000000000a'),
    'ERR 23505 already_imported / bargeld:226.26 trinkgeld:28.00 umsatz:664.19');

  PERFORM _ui_rec(43, 'an explicit false is the same refusal as no flag at all',
    _ui_call(admin_a, _ui_replace(v_week, false)), 'ERR 23505 already_imported');

  PERFORM _ui_rec(44, 'a NULL flag is refused, not read as true',
    _ui_call(admin_a, format('SELECT income_import_uber(%L::jsonb, NULL)::text', v_week::text)),
    'ERR 22023 invalid_request');

  PERFORM _ui_rec(45, 'nothing was written or deleted by those three refusals',
    (SELECT count(*)::text FROM income), v_all::text);

  PERFORM _ui_rec(46, 'REPLACE: the three old rows go, the three new ones are written, and the count says 3',
    _ui_call(admin_a, _ui_replace(v_week)) :: text,
    '{"ok": true, "deleted": 3, "drivers": 1, "inserted": 3}');

  PERFORM _ui_rec(47, 'the figure is the NEW one only (500, not 400 + 500), one row per type',
    (SELECT string_agg(type || ':' || amount::text || ':' || coalesce(trip_count::text, '-'), ' ' ORDER BY type)
       FROM income WHERE source = 'uber' AND source_driver_key = '1001'
        AND source_period_start = '2026-10-05' AND company_id = 'c0000000-0000-4000-8000-00000000000a'),
    'bargeld:200.00:- trinkgeld:30.00:- umsatz:500.00:60');

  PERFORM _ui_rec(48, 'the replaced rows still carry OUR drivers row''s name, character for character',
    (SELECT string_agg(DISTINCT driver_name, '|') FROM income
      WHERE source = 'uber' AND source_driver_key = '1001' AND source_period_start = '2026-10-05'
        AND company_id = 'c0000000-0000-4000-8000-00000000000a'),
    E'Zoë  Müller');

  PERFORM _ui_rec(49, 'a HAND-TYPED row of the same driver, week and type survives untouched',
    coalesce((SELECT description || ':' || amount::text || ':' || coalesce(source, 'manual') FROM income
               WHERE source IS NULL AND driver_name = E'Zoë  Müller' AND date = '2026-10-06'
                 AND company_id = 'c0000000-0000-4000-8000-00000000000a'), 'none'),
    'hand typed:7.00:manual');

  PERFORM _ui_rec(50, 'the same driver''s OTHER week (10-12, imported earlier) was not touched',
    (SELECT amount::text FROM income WHERE source = 'uber' AND source_driver_key = '1001'
        AND source_period_start = '2026-10-12' AND company_id = 'c0000000-0000-4000-8000-00000000000a'),
    '10.00');

  PERFORM _ui_rec(51, 'company B''s row with the SAME driver key and week was not touched',
    (SELECT amount::text FROM income WHERE source = 'uber' AND source_driver_key = '1001'
        AND company_id = 'c0000000-0000-4000-8000-00000000000b'),
    '9.00');

  PERFORM _ui_rec(52, 'a week with nothing to replace reports deleted 0 and still inserts',
    _ui_call(admin_a, _ui_replace(jsonb_build_array(
      _ui_row('1002', 'umsatz', '20.00', '2026-11-09', '2026-11-15', 2)))) :: text,
    '{"ok": true, "deleted": 0, "drivers": 1, "inserted": 1}');

  -- A pending link is not a link: the call is refused BEFORE anything is deleted.
  PERFORM _ui_rec(53, 'an unconfirmed key cannot delete through replace: refused, its row stands',
    _ui_call(admin_a, _ui_replace(jsonb_build_array(
      _ui_row('1003', 'umsatz', '1.00', '2026-10-05', '2026-10-11', 1)))) || ' / ' ||
    (SELECT amount::text FROM income WHERE source_driver_key = '1003' AND company_id = 'c0000000-0000-4000-8000-00000000000a'),
    'ERR 22023 driver_not_linked 1003 / 3.00');

  PERFORM _ui_rec(54, 'another company''s key cannot delete through replace either',
    _ui_call(admin_a, _ui_replace(jsonb_build_array(
      _ui_row('2001', 'umsatz', '1.00', '2026-09-28', '2026-10-04', 5)))) || ' / ' ||
    (SELECT amount::text FROM income WHERE source_driver_key = '2001' AND source_period_start = '2026-09-28'
        AND company_id = 'c0000000-0000-4000-8000-00000000000b'),
    'ERR 22023 driver_not_linked 2001 / 5.50');

  PERFORM _ui_rec(55, 'a viewer is refused before anything is deleted',
    _ui_call(viewer_a, _ui_replace(v_week)) || ' / ' || (SELECT count(*)::text FROM income),
    'ERR 42501 not_authorized / ' || (SELECT count(*)::text FROM income));

  PERFORM _ui_rec(56, 'a platform account with no context is refused before anything is deleted',
    _ui_call('50000000-0000-4000-8000-000000000001', _ui_replace(v_week)) || ' / ' || (SELECT count(*)::text FROM income),
    'ERR 42501 not_authorized / ' || (SELECT count(*)::text FROM income));

  -- THE CASE THE WHOLE MODE EXISTS FOR, and the reason the delete is keyed on
  -- (driver, week) and NOT on the type although the unique index is.
  --
  -- A week is imported with two types. Uber then corrects it and the tip falls
  -- to zero, so the new payload carries only `umsatz`. Keyed on the type, the
  -- old `trinkgeld` row would survive a correction that says it should not
  -- exist, the overlap check below would then refuse the whole call, and the
  -- operator would be stranded exactly where this mode was supposed to let him
  -- through. One pull writes one row per type per week, so a week's rows are
  -- one artefact and are replaced as one.
  PERFORM _ui_call(admin_a, _ui_import(jsonb_build_array(
      _ui_row('1002', 'umsatz',    '80.00', '2026-12-07', '2026-12-13', 2),
      _ui_row('1002', 'trinkgeld', '8.00',  '2026-12-07', '2026-12-13', 2))));
  -- The call and the state it leaves are recorded SEPARATELY, and that is not
  -- cosmetic: the two operands of `||` have no guaranteed order of evaluation,
  -- so an aggregate written beside `_ui_call(...)` can be planned against the
  -- snapshot BEFORE the call. The earlier version of this probe did exactly
  -- that and passed only while the call still failed and changed nothing.
  v_answer := _ui_call(admin_a, _ui_replace(jsonb_build_array(
    _ui_row('1002', 'umsatz', '90.00', '2026-12-07', '2026-12-13', 2))));
  PERFORM _ui_rec(57, 'a correction that DROPS a type goes through: two rows out, one in',
    v_answer, '{"ok": true, "deleted": 2, "drivers": 1, "inserted": 1}');
  PERFORM _ui_rec(60, '...and that week now holds only the corrected figure',
    coalesce((SELECT string_agg(type || ':' || amount::text, ' ' ORDER BY type) FROM income
      WHERE source = 'uber' AND source_driver_key = '1002' AND source_period_start = '2026-12-07'), 'none'),
    'umsatz:90.00');

  PERFORM _ui_rec(58, 'so the tip Uber no longer reports is gone, not left standing beside corrected figures',
    (SELECT count(*)::text FROM income WHERE source = 'uber' AND source_driver_key = '1002'
        AND source_period_start = '2026-12-07' AND type = 'trinkgeld'),
    '0');
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
    (has_function_privilege('authenticated', 'public.income_import_uber(jsonb, boolean)', 'EXECUTE')::text || '/' ||
     has_function_privilege('anon', 'public.income_import_uber(jsonb, boolean)', 'EXECUTE')::text || '/' ||
     EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = 'public.income_import_uber(jsonb, boolean)'::regprocedure AND a.grantee = 0)::text),
    'true/false/false');

  -- Company B has its own driver 2001; A's 1001 is nobody's in B.
  PERFORM _ui_rec(22, 'another company''s administrator cannot use this company''s link',
    _ui_call(admin_b, _ui_import(jsonb_build_array(_ui_row('1001', 'umsatz', '5.00', '2026-10-05', '2026-10-11', 1)))),
    'ERR 22023 driver_not_linked 1001');
  PERFORM _ui_rec(23, 'and imports its own, under its own driver row''s name',
    _ui_call(admin_b, _ui_import(jsonb_build_array(_ui_row('2001', 'umsatz', '5.00', '2026-10-05', '2026-10-11', 1)))) :: text,
    '{"ok": true, "drivers": 1, "inserted": 1}');
  -- Named by its own period: the replace section seeds another company-B row
  -- for this same driver key in a different week, so an unscoped read of the
  -- key matches more than one row and the subquery raises.
  PERFORM _ui_rec(24, 'the row landed in company B',
    (SELECT company_id::text || ' ' || driver_name FROM income
      WHERE source = 'uber' AND source_driver_key = '2001' AND source_period_start = '2026-10-05'),
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
  PERFORM _ui_rec(59, 'and a REPLACE inside a support session is refused and deletes nothing',
    _ui_call(staff, _ui_replace(jsonb_build_array(_ui_row('1001', 'umsatz', '1.00', '2026-10-05', '2026-10-11', 1))), staff_s)
      || ' / ' || (SELECT count(*)::text FROM income WHERE source = 'uber'),
    'ERR 42501 platform_session_not_allowed / ' || (SELECT count(*)::text FROM income WHERE source = 'uber'));
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

-- ─── 6. typed rows are not refused: both sets stand ────────────────────────
--
-- The screen WARNS about hand-entered rows for the same driver and week and does
-- not block (the owner may have typed only part of it). That only holds if the
-- database does not refuse them either, and that both sets then really exist.

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _ui_rec(40, 'an import over a week that already holds a typed row is NOT refused',
    _ui_call(admin_a, _ui_import(jsonb_build_array(
      _ui_row('1002', 'umsatz', '50.00', '2026-11-02', '2026-11-08', 1)))) :: text,
    '{"ok": true, "drivers": 1, "inserted": 1}');

  PERFORM _ui_rec(41, 'and both stand: the typed row untouched, the imported one beside it',
    (SELECT string_agg(coalesce(source, 'manual') || ':' || amount::text, ' ' ORDER BY amount DESC)
       FROM income WHERE driver_name = 'Omar Khalil' AND date BETWEEN '2026-11-02' AND '2026-11-08'),
    'manual:100 uber:50.00');
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
