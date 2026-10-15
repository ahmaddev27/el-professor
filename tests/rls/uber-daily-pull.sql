-- ════════════════════════════════════════════════════════════════════════════
--  The scheduled Uber pull: the system writer, the claim, and the schedule
--  (20261015100000)
-- ════════════════════════════════════════════════════════════════════════════
--
--  Written by the author of the migration, NOT RUN by him: the RLS kit is the
--  coordinator's to run on the VPS. Every expectation below is derived from the
--  migration's text and the human path's own kit file (income-import-uber.sql);
--  if a line fails, read the actual value before touching the expectation.
--
--  What this file separates:
--
--    §1  who may call what. The four functions answer service_role and nobody
--        else: anon and authenticated (an administrator included) are refused
--        by a missing privilege, not by a gate inside. The runs table cannot be
--        written by a client at all, and the schedule only by an administrator.
--    §2  the claim: a completed day, once. The running day, today and a day
--        beyond the window are refused; a second claim of the same (day, pass)
--        answers NULL.
--    §3  the writer's happy path writes OUR drivers row's name (the seed's
--        double space is the probe), source = 'uber', one day, and settles the
--        claim IN THE SAME CALL. A settled claim cannot be written to again.
--    §4  a day already imported is not written twice. A period that overlaps
--        an earlier import is refused with a stable reason, as a returned
--        value, nothing is written and the claim stays open for the job to
--        settle.
--    §5  an unlinked driver stops the whole day, the linked one beside it
--        included. Rows dated another day than the claim's are refused.
--    §6  the recheck: the replace is the CLAIM'S, never an argument. The new
--        figure replaces the old for the payload's drivers; a hand-typed row of
--        the same driver and day, and another company's row of the same key,
--        survive; a recheck refused halfway leaves the old rows standing.
--    §7  the human path is unchanged: an editor still imports, a viewer is
--        still refused, anon still cannot execute.
--    §8  the candidates: only a company with the switch on, with its runs.
--
--  A refusal of the writer is a returned value ({ok:false, reason}); a refusal
--  of a privilege is an error. They are read apart on purpose.
--
--  Runs inside BEGIN ... ROLLBACK. Ids start with `2f` so a failure names a row.

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _ud_as(p_who text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- A privilege error is raised at parse time and the plan the owner just
  -- warmed would hide it, so the owner's cached plans go first.
  DISCARD PLANS;
  IF p_who = 'anon' THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
  ELSIF p_who = 'service' THEN
    -- The service key carries a role and nothing else: no sub, no amr.
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
  ELSE
    PERFORM set_config('request.jwt.claim.sub', p_who, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
END $$;

/* Runs p_sql as p_who ('owner', 'anon', 'service' or a user id), returns the
   scalar or `ERR <sqlstate> <hint-or-constraint>[ <detail>]`. */
CREATE OR REPLACE FUNCTION _ud_call(p_who text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text; v_hint text; v_detail text; v_state text; v_constraint text;
BEGIN
  IF p_who <> 'owner' THEN PERFORM _ud_as(p_who); END IF;
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

CREATE TEMP TABLE _ud_out (
  n integer PRIMARY KEY, label text NOT NULL,
  actual text NOT NULL, expected text NOT NULL, matched boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _ud_rec(p_n integer, p_label text, p_actual text, p_expected text,
                                   p_like boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  v_ok := CASE WHEN p_like THEN p_actual LIKE p_expected ELSE p_actual = p_expected END;
  INSERT INTO _ud_out VALUES (p_n, p_label, p_actual, p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', p_actual;
  END IF;
END $$;

/* The completed operating day `p_back` days before the latest completed one. */
CREATE OR REPLACE FUNCTION _ud_day(p_back integer DEFAULT 0) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (((now() AT TIME ZONE 'Europe/Berlin') - interval '4 hours')::date - 1 - p_back)
$$;

CREATE OR REPLACE FUNCTION _ud_row(p_ext text, p_type text, p_amount text, p_day date,
                                   p_trips int DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('external_driver_id', p_ext, 'type', p_type, 'amount', p_amount,
                            'date', p_day::text, 'week', 1, 'description', 'Woche 1 - Uber',
                            'trip_count', p_trips, 'period_start', p_day::text, 'period_end', p_day::text)
$$;

CREATE OR REPLACE FUNCTION _ud_claim(p_company uuid, p_day date, p_pass text DEFAULT 'first') RETURNS text
LANGUAGE sql AS $$
  SELECT _ud_call('service', format('SELECT uber_pull_claim(%L, %L, %L)::text', p_company, p_day, p_pass))
$$;

CREATE OR REPLACE FUNCTION _ud_sys(p_run text, p_rows jsonb) RETURNS text
LANGUAGE sql AS $$
  SELECT _ud_call('service', format('SELECT income_import_uber_system(%L::uuid, %L::jsonb)::text', p_run, p_rows::text))
$$;

-- ─── fixtures (as the owner, so RLS does not apply) ─────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
BEGIN
  -- The writer and the candidate query judge the company's state themselves.
  UPDATE companies SET approval_status = 'approved', status = 'active',
                       subscription_status = 'active', subscription_expires_at = NULL
   WHERE id IN (co_a, co_b);

  -- A name with a double space inside: written back unchanged, or the probe sees.
  INSERT INTO drivers (id, company_id, name) VALUES
    ('2f000000-0000-4000-8000-000000000001', co_a, 'Zoë  Müller'),
    ('2f000000-0000-4000-8000-000000000002', co_a, 'Omar Khalil'),
    ('2f000000-0000-4000-8000-0000000000b1', co_b, 'Zoë  Müller');

  INSERT INTO partner_driver_links (company_id, partner, external_driver_id, driver_id, status, linked_at)
  VALUES (co_a, 'reidey', '1001', '2f000000-0000-4000-8000-000000000001', 'linked', now()),
         (co_a, 'reidey', '1002', '2f000000-0000-4000-8000-000000000002', 'linked', now()),
         (co_b, 'reidey', '1001', '2f000000-0000-4000-8000-0000000000b1', 'linked', now());
  -- Proposed by the partner and not confirmed by a person: not a link.
  INSERT INTO partner_driver_links (company_id, partner, external_driver_id, status, proposed_name)
  VALUES (co_a, 'reidey', '1003', 'pending', 'Pending Person');
END $$;

-- ─── 1. who may call what ───────────────────────────────────────────────────

DO $$
DECLARE
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
  admin_b constant text := 'b0000000-0000-4000-8000-000000000001';
  v_fn    text;
  v_n     integer := 0;
BEGIN
  -- Each of the four, as anon and as an administrator. A missing privilege is
  -- 42501 with no hint: it is the GRANT that refuses, not a gate inside.
  FOREACH v_fn IN ARRAY ARRAY[
    $q$SELECT uber_pull_candidates(1, NULL)::text$q$,
    $q$SELECT uber_pull_claim('c0000000-0000-4000-8000-00000000000a', current_date - 1, 'first')::text$q$,
    $q$SELECT uber_pull_settle(gen_random_uuid(), 'failed', NULL, 0)::text$q$,
    $q$SELECT income_import_uber_system(gen_random_uuid(), '[]'::jsonb)::text$q$
  ] LOOP
    v_n := v_n + 1;
    PERFORM _ud_rec(100 + v_n, 'anon cannot execute function ' || v_n,
      _ud_call('anon', v_fn), 'ERR 42501%', true);
    PERFORM _ud_rec(110 + v_n, 'an administrator cannot execute function ' || v_n,
      _ud_call(admin_a, v_fn), 'ERR 42501%', true);
  END LOOP;

  PERFORM _ud_rec(120, 'service_role can execute the writer (an unknown run is a returned refusal)',
    _ud_sys(gen_random_uuid()::text, '[]'::jsonb), '%"reason": "run_not_open"%', true);

  -- The runs are the job's: a client cannot write them, whoever it is.
  PERFORM _ud_rec(121, 'an administrator cannot insert a run',
    _ud_call(admin_a, format($q$INSERT INTO uber_pull_runs (company_id, day_key, pass) VALUES (%L, %L, 'first') RETURNING 'x'$q$, co_a, _ud_day())),
    'ERR 42501%', true);
  PERFORM _ud_rec(122, 'nor can the service role write the table directly (functions only)',
    _ud_call('service', format($q$INSERT INTO uber_pull_runs (company_id, day_key, pass) VALUES (%L, %L, 'first') RETURNING 'x'$q$, co_a, _ud_day())),
    'ERR 42501%', true);

  -- The schedule: an administrator of the company writes it, nobody else.
  PERFORM _ud_rec(123, 'an administrator of A writes A''s schedule',
    _ud_call(admin_a, format($q$INSERT INTO uber_pull_schedules (company_id, enabled, run_time) VALUES (%L, true, '06:00') RETURNING 'ok'$q$, co_a)),
    'ok');
  PERFORM _ud_rec(124, 'an administrator of B cannot write A''s schedule',
    _ud_call(admin_b, format($q$UPDATE uber_pull_schedules SET enabled = false WHERE company_id = %L RETURNING 'changed'$q$, co_a)),
    'null');
  PERFORM _ud_rec(125, 'and A''s schedule is unchanged',
    (SELECT enabled::text FROM uber_pull_schedules WHERE company_id = co_a), 'true');
END $$;

-- ─── 2. the claim ───────────────────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  PERFORM _ud_rec(201, 'the running operating day cannot be claimed',
    _ud_claim(co_a, _ud_day(-1)), 'ERR 22023 (no hint)', false);
  PERFORM _ud_rec(202, 'nor a day in the future',
    _ud_claim(co_a, _ud_day(-5)), 'ERR 22023 (no hint)', false);
  PERFORM _ud_rec(203, 'nor one beyond the ten-day window',
    _ud_claim(co_a, _ud_day(11)), 'ERR 22023 (no hint)', false);
  PERFORM _ud_rec(204, 'an unknown pass is refused',
    _ud_call('service', format($q$SELECT uber_pull_claim(%L, %L, 'again')::text$q$, co_a, _ud_day())),
    'ERR 22023 (no hint)', false);

  PERFORM _ud_rec(205, 'the latest completed day is claimed: a uuid comes back',
    _ud_claim(co_a, _ud_day(0)), '________-____-____-____-____________', true);
  PERFORM _ud_rec(206, 'the same (day, pass) again answers NULL, whatever became of it',
    _ud_claim(co_a, _ud_day(0)), 'null', false);
  PERFORM _ud_rec(207, 'the same day under the other pass is its own claim',
    _ud_claim(co_a, _ud_day(0), 'recheck'), '________-____-____-____-____________', true);
  PERFORM _ud_rec(208, 'exactly one first-pass row exists for the day',
    (SELECT count(*)::text FROM uber_pull_runs WHERE company_id = co_a AND day_key = _ud_day(0) AND pass = 'first'), '1');
END $$;

-- ─── 3. the writer: the happy path ──────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_run text;
BEGIN
  v_run := _ud_claim(co_a, _ud_day(1));
  PERFORM _ud_rec(301, 'a first pass writes one driver''s day: three rows, one driver, nothing replaced',
    _ud_sys(v_run, jsonb_build_array(
      _ud_row('1001', 'umsatz',    '664.19', _ud_day(1), 67),
      _ud_row('1001', 'trinkgeld', '28.00',  _ud_day(1)),
      _ud_row('1001', 'bargeld',   '226.26', _ud_day(1)))),
    '%"ok": true%"deleted": 0%"drivers": 1%"inserted": 3%"replaced": false%', true);

  PERFORM _ud_rec(302, 'driver_name is OUR drivers row''s name, double space included',
    (SELECT string_agg(DISTINCT driver_name, '|') FROM income WHERE company_id = co_a AND source = 'uber' AND date = _ud_day(1)),
    E'Zoë  Müller');
  PERFORM _ud_rec(303, 'the rows say where they came from and which day they cover',
    (SELECT DISTINCT source || ' ' || source_driver_key || ' ' || (source_period_start = _ud_day(1))::text
                   || ' ' || (source_period_end = _ud_day(1))::text
       FROM income WHERE company_id = co_a AND source = 'uber' AND date = _ud_day(1)),
    'uber 1001 true true');
  PERFORM _ud_rec(304, 'the amounts are exact and the trips ride on the umsatz row only',
    (SELECT string_agg(type || ':' || amount::text || ':' || coalesce(trip_count::text, '-'), ' ' ORDER BY type)
       FROM income WHERE company_id = co_a AND source = 'uber' AND date = _ud_day(1)),
    'bargeld:226.26:- trinkgeld:28.00:- umsatz:664.19:67');

  PERFORM _ud_rec(305, 'the claim was settled by the writer, in the same call',
    (SELECT outcome || ' ' || rows_written || ' ' || driver_count || ' ' || (settled_at IS NOT NULL)::text
       FROM uber_pull_runs WHERE id = v_run::uuid),
    'imported 3 1 true');
  PERFORM _ud_rec(306, 'a settled claim cannot be written to again',
    _ud_sys(v_run, jsonb_build_array(_ud_row('1001', 'umsatz', '1.00', _ud_day(1)))),
    '%"reason": "run_not_open"%', true);
  PERFORM _ud_rec(307, 'and settling it with a made-up outcome does nothing (already settled)',
    _ud_call('service', format($q$SELECT uber_pull_settle(%L::uuid, 'failed', 'x', 0)::text$q$, v_run)), 'false');
  PERFORM _ud_rec(308, 'imported cannot be settled by the job: only the writer says it',
    _ud_call('service', format($q$SELECT uber_pull_settle(%L::uuid, 'imported', NULL, 0)::text$q$, v_run)),
    'ERR 22023 (no hint)');
END $$;

-- ─── 4. a day already imported is not written twice ─────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_run text;
  v_settled text;
  v_before integer;
BEGIN
  -- An earlier import for driver 1002 whose period COVERS the day: a weekly
  -- pull by the button, as a person would have made it.
  INSERT INTO income (description, amount, type, driver_name, date, company_id,
                      source, source_period_start, source_period_end, source_driver_key)
  VALUES ('Woche 1 - Uber', 300, 'umsatz', 'Omar Khalil', _ud_day(2) - 3, co_a,
          'uber', _ud_day(2) - 3, _ud_day(2) + 3, '1002');
  v_before := (SELECT count(*) FROM income WHERE company_id = co_a AND source = 'uber');

  v_run := _ud_claim(co_a, _ud_day(2));
  PERFORM _ud_rec(401, 'a day inside a period already imported is refused as a returned value',
    _ud_sys(v_run, jsonb_build_array(_ud_row('1002', 'umsatz', '50.00', _ud_day(2)))),
    '{"ok": false, "reason": "already_imported"}');
  PERFORM _ud_rec(402, 'nothing was written',
    (SELECT count(*)::text FROM income WHERE company_id = co_a AND source = 'uber'), v_before::text);
  PERFORM _ud_rec(403, 'the claim stays open for the job to settle with the reason',
    (SELECT (settled_at IS NULL)::text FROM uber_pull_runs WHERE id = v_run::uuid), 'true');
  -- The call and the state it leaves are recorded SEPARATELY. The two operands
  -- of `||` have no guaranteed order of evaluation, so an aggregate written
  -- beside _ud_call can be planned against the snapshot BEFORE the call --
  -- here the outcome was still NULL, and one NULL swallowed the whole string,
  -- so the probe reported no value at all rather than a wrong one. The same
  -- shape was found and fixed in tests/rls/income-import-uber.sql.
  v_settled := _ud_call('service',
    format($q$SELECT uber_pull_settle(%L::uuid, 'already_imported', 'already_imported', 0)::text$q$, v_run));
  PERFORM _ud_rec(404, 'the job settles it as already_imported',
    v_settled, 'true');
  PERFORM _ud_rec(406, '...and the screen can read that outcome',
    coalesce((SELECT outcome FROM uber_pull_runs WHERE id = v_run::uuid), '<null>'),
    'already_imported');

  -- Past the function, the INDEX still refuses the exact key (the human path's backstop).
  PERFORM _ud_rec(405, 'the unique index refuses the duplicate key even with the writer bypassed',
    _ud_call('owner', format($q$INSERT INTO income (description, amount, type, driver_name, date, company_id,
        source, source_period_start, source_period_end, source_driver_key)
      VALUES ('x', 1, 'umsatz', 'x', %L, %L, 'uber', %L, %L, '1001') RETURNING 'inserted'$q$,
      _ud_day(1), co_a, _ud_day(1), _ud_day(1))),
    'ERR 23505 income_source_period_key');
END $$;

-- ─── 5. an unlinked driver, and a row of another day ────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_run text;
  v_before integer := (SELECT count(*) FROM income WHERE source = 'uber');
BEGIN
  v_run := _ud_claim(co_a, _ud_day(3));
  PERFORM _ud_rec(501, 'a pending link is not a link: the whole day is refused',
    _ud_sys(v_run, jsonb_build_array(
      _ud_row('1002', 'umsatz', '50.00', _ud_day(3)),
      _ud_row('1003', 'umsatz', '60.00', _ud_day(3)))),
    '{"ok": false, "reason": "driver_not_linked"}');
  PERFORM _ud_rec(502, 'the linked driver beside it was NOT written',
    (SELECT count(*)::text FROM income WHERE source = 'uber'), v_before::text);
  PERFORM _ud_rec(503, 'an id no link of A names is refused',
    _ud_sys(v_run, jsonb_build_array(_ud_row('4040', 'umsatz', '1.00', _ud_day(3)))),
    '{"ok": false, "reason": "driver_not_linked"}');

  PERFORM _ud_rec(504, 'a row dated another day than the claim''s is refused',
    _ud_sys(v_run, jsonb_build_array(_ud_row('1002', 'umsatz', '50.00', _ud_day(4)))),
    '{"ok": false, "reason": "wrong_day"}');
  PERFORM _ud_rec(505, 'a period of more than the claimed day is refused',
    _ud_sys(v_run, jsonb_build_array(
      _ud_row('1002', 'umsatz', '50.00', _ud_day(3)) || jsonb_build_object('period_end', (_ud_day(3) + 1)::text))),
    '{"ok": false, "reason": "wrong_day"}');
  PERFORM _ud_rec(506, 'a malformed amount is refused as invalid_request',
    _ud_sys(v_run, jsonb_build_array(_ud_row('1002', 'umsatz', '50,00', _ud_day(3)))),
    '{"ok": false, "reason": "invalid_request"}');
  PERFORM _ud_rec(507, 'an empty payload is refused as invalid_request',
    _ud_sys(v_run, '[]'::jsonb), '{"ok": false, "reason": "invalid_request"}');
END $$;

-- ─── 6. the recheck: replace belongs to the claim ───────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  v_first text;
  v_recheck text;
  v_bystanders integer;
BEGIN
  -- The first pass of day 5 writes 400 EUR for driver 1001.
  v_first := _ud_claim(co_a, _ud_day(5));
  PERFORM _ud_rec(601, 'the first pass of the day writes 400,00',
    _ud_sys(v_first, jsonb_build_array(_ud_row('1001', 'umsatz', '400.00', _ud_day(5), 20))),
    '%"inserted": 1%"replaced": false%', true);

  -- Bystanders the replace must not reach: a typed row of the SAME driver and
  -- day (source NULL), and company B's row under the SAME key and day.
  INSERT INTO income (description, amount, type, driver_name, date, company_id)
  VALUES ('hand typed', 7.00, 'umsatz', E'Zoë  Müller', _ud_day(5), co_a);
  INSERT INTO income (description, amount, type, driver_name, date, company_id,
                      source, source_period_start, source_period_end, source_driver_key)
  VALUES ('Woche 1 - Uber', 9.00, 'umsatz', E'Zoë  Müller', _ud_day(5), co_b,
          'uber', _ud_day(5), _ud_day(5), '1001');
  v_bystanders := (SELECT count(*) FROM income WHERE date = _ud_day(5) AND (source IS NULL OR company_id = co_b));

  -- A replace can never be asked for by an argument: there is none.
  v_recheck := _ud_claim(co_a, _ud_day(5), 'recheck');
  PERFORM _ud_rec(602, 'the writer has no replace argument: naming one does not resolve',
    _ud_call('service', format($q$SELECT income_import_uber_system(%L::uuid, '[]'::jsonb, true)::text$q$, v_recheck)),
    'ERR 42883%', true);
  PERFORM _ud_rec(603, 'a FIRST pass is refused when the day is held (it never deletes to make room)',
    _ud_call('service', format($q$SELECT uber_pull_claim(%L, %L, 'first')::text$q$, co_a, _ud_day(5))), 'null');

  PERFORM _ud_rec(604, 'the recheck replaces: one old row went, one new one stands',
    _ud_sys(v_recheck, jsonb_build_array(_ud_row('1001', 'umsatz', '500.00', _ud_day(5), 21))),
    '%"deleted": 1%"inserted": 1%"replaced": true%', true);
  PERFORM _ud_rec(605, 'the figure is the NEW one only',
    (SELECT string_agg(amount::text, ' ') FROM income
      WHERE company_id = co_a AND source = 'uber' AND source_driver_key = '1001' AND date = _ud_day(5)),
    '500.00');
  PERFORM _ud_rec(606, 'the hand-typed row and company B''s row of the same key both survived',
    (SELECT count(*)::text FROM income WHERE date = _ud_day(5) AND (source IS NULL OR company_id = co_b)),
    v_bystanders::text);
  PERFORM _ud_rec(607, 'the recheck claim was settled as imported with the deleted count',
    (SELECT outcome || ' ' || rows_deleted FROM uber_pull_runs WHERE id = v_recheck::uuid), 'imported 1');
END $$;

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_first text;
  v_recheck text;
  v_other text;
BEGIN
  v_first := _ud_claim(co_a, _ud_day(6));
  PERFORM _ud_sys(v_first, jsonb_build_array(_ud_row('1001', 'umsatz', '400.00', _ud_day(6), 20)));

  -- An earlier import of the same driver whose period COVERS the day but starts
  -- earlier: the replace does not key on it, so it survives the delete and the
  -- overlap check then refuses the call AFTER the delete has run.
  INSERT INTO income (description, amount, type, driver_name, date, company_id,
                      source, source_period_start, source_period_end, source_driver_key)
  VALUES ('Woche 1 - Uber', 12, 'umsatz', E'Zoë  Müller', _ud_day(6) - 2, co_a,
          'uber', _ud_day(6) - 2, _ud_day(6) + 1, '1001');

  v_recheck := _ud_claim(co_a, _ud_day(6), 'recheck');
  PERFORM _ud_rec(608, 'a recheck refused AFTER its delete is a returned refusal',
    _ud_sys(v_recheck, jsonb_build_array(_ud_row('1001', 'umsatz', '999.00', _ud_day(6)))),
    '{"ok": false, "reason": "already_imported"}');
  PERFORM _ud_rec(609, 'the delete was rolled back: the old figure is still there, untouched',
    (SELECT string_agg(amount::text, ' ') FROM income
      WHERE company_id = co_a AND source = 'uber' AND source_driver_key = '1001' AND date = _ud_day(6)),
    '400.00');
  PERFORM _ud_rec(610, 'and the recheck claim is still open',
    (SELECT (settled_at IS NULL)::text FROM uber_pull_runs WHERE id = v_recheck::uuid), 'true');

  -- Refused before any delete: one unlinked driver stops the whole recheck.
  v_other := _ud_claim(co_a, _ud_day(8), 'recheck');
  PERFORM _ud_rec(611, 'a recheck with one unlinked driver is refused and deletes nothing',
    _ud_sys(v_other, jsonb_build_array(
      _ud_row('1001', 'umsatz', '1.00', _ud_day(8)),
      _ud_row('1003', 'umsatz', '1.00', _ud_day(8)))),
    '{"ok": false, "reason": "driver_not_linked"}');
END $$;

-- ─── 7. the human path is unchanged ─────────────────────────────────────────

DO $$
DECLARE
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
  v_rows  constant text := $q$jsonb_build_array(jsonb_build_object(
      'external_driver_id', '1002', 'type', 'umsatz', 'amount', '10.00',
      'date', '2020-01-06', 'week', 1, 'description', 'Woche 1 - Uber',
      'trip_count', NULL, 'period_start', '2020-01-06', 'period_end', '2020-01-12'))$q$;
BEGIN
  PERFORM _ud_rec(701, 'an administrator still imports a week by the button',
    _ud_call(admin_a, 'SELECT income_import_uber(' || v_rows || ')::text'),
    '{"ok": true, "drivers": 1, "inserted": 1}');
  PERFORM _ud_rec(702, 'the same week again is still refused with 23505 already_imported',
    _ud_call(admin_a, 'SELECT income_import_uber(' || v_rows || ')::text'),
    'ERR 23505 already_imported');
  PERFORM _ud_rec(703, 'anon still cannot execute the human function',
    _ud_call('anon', 'SELECT income_import_uber(' || v_rows || ')::text'), 'ERR 42501%', true);
  PERFORM _ud_rec(704, 'and a session with no company is still not authorized',
    _ud_call('2f000000-0000-4000-8000-0000000000ff', 'SELECT income_import_uber(' || v_rows || ')::text'),
    'ERR 42501 not_authorized');
END $$;

-- ─── 8. the candidates ──────────────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_open text;
BEGIN
  PERFORM _ud_rec(801, 'only the company with the switch on is a candidate',
    _ud_call('service', $q$SELECT string_agg(company_id::text, ',' ORDER BY company_id) FROM uber_pull_candidates(100, NULL)$q$),
    co_a::text);

  PERFORM _ud_rec(802, 'its runs of the last days come with their outcomes',
    _ud_call('service', $q$SELECT (SELECT count(*) FROM jsonb_array_elements(runs) r
                                    WHERE r->>'outcome' = 'imported')::text
                             FROM uber_pull_candidates(100, NULL)$q$),
    '4');

  UPDATE uber_pull_schedules SET enabled = false WHERE company_id = co_a;
  PERFORM _ud_rec(803, 'switched off, it is no candidate',
    _ud_call('service', $q$SELECT count(*)::text FROM uber_pull_candidates(100, NULL)$q$), '0');
  UPDATE uber_pull_schedules SET enabled = true WHERE company_id = co_a;
  v_open := _ud_claim(co_a, _ud_day(7));
  UPDATE companies SET approval_status = 'pending' WHERE id = co_a;
  PERFORM _ud_rec(804, 'a company that is not approved is no candidate, switch or not',
    _ud_call('service', $q$SELECT count(*)::text FROM uber_pull_candidates(100, NULL)$q$), '0');
  PERFORM _ud_rec(805, 'and the writer refuses it too, as a returned reason',
    _ud_sys(v_open, jsonb_build_array(_ud_row('1002', 'umsatz', '1.00', _ud_day(7)))),
    '{"ok": false, "reason": "company_blocked"}');
  UPDATE companies SET approval_status = 'approved' WHERE id = co_a;

  PERFORM _ud_rec(806, 'a limit of 0 is a broken contract',
    _ud_call('service', $q$SELECT count(*)::text FROM uber_pull_candidates(0, NULL)$q$), 'ERR 22023 (no hint)');

  PERFORM _ud_rec(807, 'company B sees none of company A''s runs',
    _ud_call('b0000000-0000-4000-8000-000000000001',
      'SELECT count(*)::text FROM uber_pull_runs WHERE company_id = ' || quote_literal(co_a)), '0');
  PERFORM _ud_rec(808, 'company A''s administrator sees its own',
    _ud_call('a0000000-0000-4000-8000-000000000001',
      'SELECT (count(*) > 0)::text FROM uber_pull_runs WHERE company_id = ' || quote_literal(co_a)), 'true');
END $$;

-- ─── result ────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad integer := (SELECT count(*) FROM _ud_out WHERE NOT matched);
  v_all integer := (SELECT count(*) FROM _ud_out);
BEGIN
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'uber daily pull: % of % probes did not match', v_bad, v_all;
  END IF;
  RAISE NOTICE 'uber daily pull: all % probes matched', v_all;
END $$;

ROLLBACK;
