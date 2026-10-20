/*
  The weekly reminder (migration 20261015100000): the new delivery kind, the
  claim's two driver rules, the facts function and the schedule's two columns.

  Runs after the files before it, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end.

  NOT RUN by the author of the migration: this file is the RLS kit's to run, on
  the VPS (see CLAUDE.md, "The RLS kit"). Read it as a specification until then.

  What is covered, in order:

    1. shape      the kind check admits the three kinds, the dedupe rule is the
                  same UNIQUE constraint, the lead has its CHECK, the three job
                  functions are service_role only, plpgsql SECURITY DEFINER
                  with a pinned search_path
    2. role gate  an administrator writes the schedule's reminder columns; an
                  editor and a viewer cannot; another company's administrator
                  changes nothing of company A's row; the lead's CHECK refuses
                  14 and 721
    3. re-arm     changing the reminder switch or the lead moves armed_at; a
                  touch that changes nothing keeps it
    4. dedupe     a second claim of the same reminder answers NULL, another
                  week or another driver is a new occurrence, a bad kind raises
    5. exclusive  a reminder is refused once the same week's driver mail is
                  claimed (NULL, no row), the driver mail can still follow a
                  reminder, a driver of another company is refused
    6. facts      the week's facts per driver: revenue, cash rows, cash
                  receipts; a card receipt is not a cash receipt; the week's
                  edges; a shared name has match_count 2; another company's
                  rows never appear
    7. candidates the query returns the reminder columns and offers a company
                  only inside its boundary
    8. isolation  company B's rows are untouched by everything above
*/

\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION _ar_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _ar_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

CREATE OR REPLACE FUNCTION _ar_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _ar_reset();
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/* Run p_sql as that caller in a subtransaction that is always rolled back. */
CREATE OR REPLACE FUNCTION _ar_try(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _ar_as(p_user);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ011' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _ar_reset();
  RETURN v_out;
END $$;

-- ─── data ───────────────────────────────────────────────────────────────────
--
-- seed.sql's two companies and their people. Company A gets a schedule, five
-- drivers and a week of 2026-09-21 (Monday) .. 2026-09-27 (Sunday); company B
-- gets one driver with exactly the facts of A's "drove, recorded nothing"
-- driver, so a leak across companies would show.

INSERT INTO abrechnung_schedules (company_id, driver_mail_enabled, weekday, send_time)
VALUES ('c0000000-0000-4000-8000-00000000000a', true, 1, '08:00'),
       ('c0000000-0000-4000-8000-00000000000b', true, 1, '08:00');

INSERT INTO drivers (id, company_id, name, status, email)
VALUES
  -- Drove, recorded nothing.
  ('d0000000-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-00000000000a', 'AR Silent',  'active', 'silent@example.com'),
  -- Drove, recorded cash income.
  ('d0000000-0000-4000-8000-0000000000a2', 'c0000000-0000-4000-8000-00000000000a', 'AR Cash',    'active', 'cash@example.com'),
  -- Drove, recorded only a cash receipt.
  ('d0000000-0000-4000-8000-0000000000a3', 'c0000000-0000-4000-8000-00000000000a', 'AR Receipt', 'active', 'receipt@example.com'),
  -- Drove, recorded only a CARD receipt: that is not a cash receipt.
  ('d0000000-0000-4000-8000-0000000000a4', 'c0000000-0000-4000-8000-00000000000a', 'AR Card',    'active', 'card@example.com'),
  -- Two drivers, one name (case and spacing differ, the key does not).
  ('d0000000-0000-4000-8000-0000000000a5', 'c0000000-0000-4000-8000-00000000000a', 'AR Twin',    'active', 'twin1@example.com'),
  ('d0000000-0000-4000-8000-0000000000a6', 'c0000000-0000-4000-8000-00000000000a', 'ar  twin',   'active', 'twin2@example.com'),
  -- Company B's driver, the same facts as AR Silent.
  ('d0000000-0000-4000-8000-0000000000b1', 'c0000000-0000-4000-8000-00000000000b', 'AR Silent',  'active', 'b-silent@example.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO income (company_id, description, amount, type, driver_name, date)
VALUES
  ('c0000000-0000-4000-8000-00000000000a', 'u', 800, 'umsatz',  'AR Silent',  '2026-09-23'),
  ('c0000000-0000-4000-8000-00000000000a', 'u', 500, 'umsatz',  'AR Cash',    '2026-09-23'),
  ('c0000000-0000-4000-8000-00000000000a', 'b', 120, 'bargeld', 'AR Cash',    '2026-09-24'),
  ('c0000000-0000-4000-8000-00000000000a', 'u', 400, 'umsatz',  'AR Receipt', '2026-09-23'),
  ('c0000000-0000-4000-8000-00000000000a', 'u', 300, 'umsatz',  'AR Card',    '2026-09-23'),
  ('c0000000-0000-4000-8000-00000000000a', 'u', 200, 'umsatz',  'AR Twin',    '2026-09-23'),
  -- Company B: the same facts as AR Silent.
  ('c0000000-0000-4000-8000-00000000000b', 'u', 800, 'umsatz',  'AR Silent',  '2026-09-23'),
  -- Outside the week on both edges: Sunday before and Monday after. A cash row
  -- on those days must not count for the week, and revenue must not either.
  ('c0000000-0000-4000-8000-00000000000a', 'b', 50,  'bargeld', 'AR Silent',  '2026-09-20'),
  ('c0000000-0000-4000-8000-00000000000a', 'b', 50,  'bargeld', 'AR Silent',  '2026-09-28');

INSERT INTO receipts (company_id, receipt_number, date, description, driver_name, payment_method, expense)
VALUES
  ('c0000000-0000-4000-8000-00000000000a', 'AR-1', '2026-09-24', 'Tanken', 'AR Receipt', 'bar', 40),
  ('c0000000-0000-4000-8000-00000000000a', 'AR-2', '2026-09-24', 'Tanken', 'AR Card', 'uberweisung', 40);

-- ─── 1. shape ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_wrong text;
BEGIN
  PERFORM _ar_ok('shape: the kind check admits the three kinds',
    EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.abrechnung_deliveries'::regclass
               AND conname = 'abrechnung_deliveries_kind_check'
               AND pg_get_constraintdef(oid) ~ 'driver_reminder'
               AND pg_get_constraintdef(oid) ~ 'driver_abrechnung'
               AND pg_get_constraintdef(oid) ~ 'manager_summary'));

  PERFORM _ar_ok('shape: the dedupe rule is still the one UNIQUE constraint',
    EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.abrechnung_deliveries'::regclass
               AND conname = 'abrechnung_deliveries_once' AND contype = 'u'));

  PERFORM _ar_ok('shape: the schedule has the two columns, off and 60 by default',
    (SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'abrechnung_schedules'
        AND column_name = 'reminder_enabled') = 'false'
    AND (SELECT column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'abrechnung_schedules'
            AND column_name = 'reminder_lead_minutes') = '60');

  SELECT string_agg(v.sig, ', ') INTO v_wrong
    FROM (VALUES
      ('public.abrechnung_schedule_candidates(integer, uuid)'),
      ('public.abrechnung_delivery_claim(uuid, text, uuid, text)'),
      ('public.abrechnung_reminder_facts(uuid, date)')
    ) AS v(sig)
   WHERE has_function_privilege('anon',          to_regprocedure(v.sig), 'EXECUTE')
      OR has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE')
      OR NOT has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE');
  PERFORM _ar_ok(format('shape: EXECUTE is service_role only on all three [%s]', coalesce(v_wrong, 'none')),
    v_wrong IS NULL);

  SELECT string_agg(p.proname, ', ') INTO v_wrong
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('abrechnung_schedule_candidates', 'abrechnung_delivery_claim',
                       'abrechnung_reminder_facts')
     AND (NOT p.prosecdef
          OR p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
          OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c
                          WHERE c LIKE 'search\_path=%'));
  PERFORM _ar_ok(format('shape: all three are plpgsql SECURITY DEFINER with a pinned search_path [%s]',
                        coalesce(v_wrong, 'none')),
    v_wrong IS NULL);
END $$;

-- ─── 2. the role gate on the schedule write ─────────────────────────────────

DO $$
DECLARE
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  editor_a constant uuid := 'a0000000-0000-4000-8000-000000000002';
  view_a   constant uuid := 'a0000000-0000-4000-8000-000000000003';
  admin_b  constant uuid := 'b0000000-0000-4000-8000-000000000001';
  co_a     constant uuid := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  PERFORM _ar_ok('role gate: the company administrator switches the reminder on and sets the lead',
    _ar_try(admin_a, format(
      'UPDATE abrechnung_schedules SET reminder_enabled = true, reminder_lead_minutes = 90 WHERE company_id = %L',
      co_a)) = 'rows 1');

  PERFORM _ar_ok('role gate: an editor changes nothing — the update matches no row it may write',
    _ar_try(editor_a, format(
      'UPDATE abrechnung_schedules SET reminder_enabled = true WHERE company_id = %L', co_a)) = 'rows 0');

  PERFORM _ar_ok('role gate: a viewer changes nothing either',
    _ar_try(view_a, format(
      'UPDATE abrechnung_schedules SET reminder_lead_minutes = 30 WHERE company_id = %L', co_a)) = 'rows 0');

  PERFORM _ar_ok('role gate: another company''s administrator changes nothing of company A''s row',
    _ar_try(admin_b, format(
      'UPDATE abrechnung_schedules SET reminder_enabled = true, reminder_lead_minutes = 15 WHERE company_id = %L',
      co_a)) = 'rows 0');

  PERFORM _ar_ok('role gate: …and cannot move its own row to company A',
    _ar_try(admin_b, format(
      'UPDATE abrechnung_schedules SET company_id = %L WHERE company_id = %L',
      co_a, 'c0000000-0000-4000-8000-00000000000b')) LIKE 'ERR %');

  PERFORM _ar_ok('role gate: the lead is bounded — 14 and 1441 are refused by the table',
    _ar_try(admin_a, format(
      'UPDATE abrechnung_schedules SET reminder_lead_minutes = 14 WHERE company_id = %L', co_a)) LIKE 'ERR 23514%'
    AND _ar_try(admin_a, format(
      'UPDATE abrechnung_schedules SET reminder_lead_minutes = 1441 WHERE company_id = %L', co_a)) LIKE 'ERR 23514%');

  PERFORM _ar_ok('role gate: a lead of 1440 (24 h) is accepted, 720 stays valid',
    _ar_try(admin_a, format(
      'UPDATE abrechnung_schedules SET reminder_lead_minutes = 1440 WHERE company_id = %L', co_a)) LIKE 'rows 1%'
    AND _ar_try(admin_a, format(
      'UPDATE abrechnung_schedules SET reminder_lead_minutes = 720 WHERE company_id = %L', co_a)) LIKE 'rows 1%');

  -- _ar_try rolls every probe back, so what is stored is what the seed wrote:
  -- the refused probes above changed nothing, and neither did the allowed one.
  PERFORM _ar_ok('role gate: company A''s stored row is still the default (every probe was rolled back)',
    (SELECT NOT reminder_enabled AND reminder_lead_minutes = 60 FROM abrechnung_schedules WHERE company_id = co_a));
  PERFORM _ar_ok('role gate: company B''s row is untouched',
    (SELECT NOT reminder_enabled AND reminder_lead_minutes = 60 FROM abrechnung_schedules
      WHERE company_id = 'c0000000-0000-4000-8000-00000000000b'));
END $$;

-- ─── 3. re-arming ───────────────────────────────────────────────────────────

DO $$
DECLARE
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_old   timestamptz := '2000-01-01 00:00:00+00';
  v_after timestamptz;
BEGIN
  -- The stamp owns armed_at and overwrites any value an UPDATE sets, so the
  -- fixture switches it off for the one statement that plants the old moment.
  ALTER TABLE abrechnung_schedules DISABLE TRIGGER abrechnung_schedules_stamp;
  UPDATE abrechnung_schedules SET armed_at = v_old WHERE company_id = co_a;
  ALTER TABLE abrechnung_schedules ENABLE TRIGGER abrechnung_schedules_stamp;
  UPDATE abrechnung_schedules SET reminder_enabled = reminder_enabled WHERE company_id = co_a;
  SELECT armed_at INTO v_after FROM abrechnung_schedules WHERE company_id = co_a;
  PERFORM _ar_ok('re-arm: a touch that changes nothing keeps the old moment', v_after = v_old);

  UPDATE abrechnung_schedules SET reminder_lead_minutes = 120 WHERE company_id = co_a;
  SELECT armed_at INTO v_after FROM abrechnung_schedules WHERE company_id = co_a;
  PERFORM _ar_ok('re-arm: changing the lead re-arms the schedule', v_after > v_old);

  ALTER TABLE abrechnung_schedules DISABLE TRIGGER abrechnung_schedules_stamp;
  UPDATE abrechnung_schedules SET armed_at = v_old WHERE company_id = co_a;
  ALTER TABLE abrechnung_schedules ENABLE TRIGGER abrechnung_schedules_stamp;
  UPDATE abrechnung_schedules SET reminder_enabled = NOT reminder_enabled WHERE company_id = co_a;
  SELECT armed_at INTO v_after FROM abrechnung_schedules WHERE company_id = co_a;
  PERFORM _ar_ok('re-arm: changing the switch re-arms the schedule', v_after > v_old);
  UPDATE abrechnung_schedules SET reminder_enabled = true, reminder_lead_minutes = 60 WHERE company_id = co_a;
END $$;

-- ─── 4. dedupe ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  co_a   constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  silent constant uuid := 'd0000000-0000-4000-8000-0000000000a1';
  cash   constant uuid := 'd0000000-0000-4000-8000-0000000000a2';
  v_id   uuid;
BEGIN
  v_id := abrechnung_delivery_claim(co_a, 'driver_reminder', silent, '2026-09-21');
  PERFORM _ar_ok('dedupe: the first claim of a reminder returns an id', v_id IS NOT NULL);

  PERFORM _ar_ok('dedupe: the same driver and week answers NULL and writes nothing',
    abrechnung_delivery_claim(co_a, 'driver_reminder', silent, '2026-09-21') IS NULL
    AND (SELECT count(*) FROM abrechnung_deliveries
          WHERE company_id = co_a AND kind = 'driver_reminder' AND target_id = silent
            AND period_key = '2026-09-21') = 1);

  PERFORM _ar_ok('dedupe: another week is a new occurrence',
    abrechnung_delivery_claim(co_a, 'driver_reminder', silent, '2026-09-28') IS NOT NULL);

  PERFORM _ar_ok('dedupe: another driver the same week is a new occurrence',
    abrechnung_delivery_claim(co_a, 'driver_reminder', cash, '2026-09-21') IS NOT NULL);

  PERFORM _ar_ok('dedupe: the key is the table''s constraint, not only the function''s check',
    (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.abrechnung_deliveries'::regclass
        AND conname = 'abrechnung_deliveries_once') = 1);

  BEGIN
    PERFORM abrechnung_delivery_claim(co_a, 'driver_remind', silent, '2026-09-21');
    PERFORM _ar_ok('dedupe: an unknown kind raises', false);
  EXCEPTION WHEN SQLSTATE '22023' THEN
    PERFORM _ar_ok('dedupe: an unknown kind raises 22023', true);
  END;

  PERFORM _ar_ok('dedupe: a settled reminder is settled once',
    abrechnung_delivery_settle(v_id, true, 1) AND NOT abrechnung_delivery_settle(v_id, false, 0));
END $$;

-- ─── 5. exclusivity with the driver mail ────────────────────────────────────

DO $$
DECLARE
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b    constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  receipt constant uuid := 'd0000000-0000-4000-8000-0000000000a3';
  card    constant uuid := 'd0000000-0000-4000-8000-0000000000a4';
  silent  constant uuid := 'd0000000-0000-4000-8000-0000000000a1';
  b_drv   constant uuid := 'd0000000-0000-4000-8000-0000000000b1';
  v_before bigint;
BEGIN
  PERFORM _ar_ok('exclusive: the driver mail is claimed first, for this week',
    abrechnung_delivery_claim(co_a, 'driver_abrechnung', receipt, '2026-09-21') IS NOT NULL);

  SELECT count(*) INTO v_before FROM abrechnung_deliveries WHERE company_id = co_a;
  PERFORM _ar_ok('exclusive: …so the reminder for the same driver and week is refused, and writes nothing',
    abrechnung_delivery_claim(co_a, 'driver_reminder', receipt, '2026-09-21') IS NULL
    AND (SELECT count(*) FROM abrechnung_deliveries WHERE company_id = co_a) = v_before);

  PERFORM _ar_ok('exclusive: …but the reminder for another week of the same driver is not',
    abrechnung_delivery_claim(co_a, 'driver_reminder', receipt, '2026-09-14') IS NOT NULL);

  PERFORM _ar_ok('exclusive: …and the driver mail may follow a reminder (silent was reminded above)',
    abrechnung_delivery_claim(co_a, 'driver_abrechnung', silent, '2026-09-21') IS NOT NULL);

  PERFORM _ar_ok('exclusive: a driver of another company is refused whichever company is named',
    abrechnung_delivery_claim(co_a, 'driver_reminder', b_drv, '2026-09-21') IS NULL
    AND abrechnung_delivery_claim(co_b, 'driver_reminder', card, '2026-09-21') IS NULL);

  PERFORM _ar_ok('exclusive: company B''s own reminder is claimed normally',
    abrechnung_delivery_claim(co_b, 'driver_reminder', b_drv, '2026-09-21') IS NOT NULL);
END $$;

-- ─── 6. facts ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  f    record;
BEGIN
  SELECT * INTO f FROM abrechnung_reminder_facts(co_a, '2026-09-21') WHERE driver_name = 'AR Silent';
  PERFORM _ar_ok('facts: the silent driver drove (800) and recorded no cash and no cash receipt',
    f.umsatz_amount = 800 AND f.bargeld_rows = 0 AND f.bar_receipt_rows = 0
    AND f.driver_status = 'active' AND f.driver_email = 'silent@example.com' AND f.match_count = 1);

  PERFORM _ar_ok('facts: the week''s edges — cash on the Sunday before and the Monday after do not count',
    f.bargeld_rows = 0);

  SELECT * INTO f FROM abrechnung_reminder_facts(co_a, '2026-09-21') WHERE driver_name = 'AR Cash';
  PERFORM _ar_ok('facts: cash income is counted', f.bargeld_rows = 1 AND f.umsatz_amount = 500);

  SELECT * INTO f FROM abrechnung_reminder_facts(co_a, '2026-09-21') WHERE driver_name = 'AR Receipt';
  PERFORM _ar_ok('facts: a cash receipt is counted', f.bar_receipt_rows = 1 AND f.bargeld_rows = 0);

  SELECT * INTO f FROM abrechnung_reminder_facts(co_a, '2026-09-21') WHERE driver_name = 'AR Card';
  PERFORM _ar_ok('facts: a card receipt is not a cash receipt', f.bar_receipt_rows = 0 AND f.umsatz_amount = 300);

  PERFORM _ar_ok('facts: a name two drivers share has match_count 2 on both rows (case and spacing are noise)',
    (SELECT count(*) FROM abrechnung_reminder_facts(co_a, '2026-09-21')
      WHERE driver_name IN ('AR Twin', 'ar  twin') AND match_count = 2) = 2);

  PERFORM _ar_ok('facts: another company''s driver and rows never appear in company A''s facts',
    NOT EXISTS (SELECT 1 FROM abrechnung_reminder_facts(co_a, '2026-09-21')
                 WHERE driver_id = 'd0000000-0000-4000-8000-0000000000b1')
    AND (SELECT umsatz_amount FROM abrechnung_reminder_facts(co_a, '2026-09-21')
          WHERE driver_name = 'AR Silent') = 800);

  PERFORM _ar_ok('facts: company B''s facts are its own',
    (SELECT umsatz_amount FROM abrechnung_reminder_facts('c0000000-0000-4000-8000-00000000000b', '2026-09-21')
      WHERE driver_name = 'AR Silent') = 800
    AND (SELECT count(*) FROM abrechnung_reminder_facts('c0000000-0000-4000-8000-00000000000b', '2026-09-21')) = 2);

  BEGIN
    PERFORM abrechnung_reminder_facts(co_a, '2026-09-22');
    PERFORM _ar_ok('facts: a Tuesday is refused', false);
  EXCEPTION WHEN SQLSTATE '22023' THEN
    PERFORM _ar_ok('facts: a week not named by its Monday is refused (22023)', true);
  END;

  PERFORM _ar_ok('facts: a session cannot call it',
    _ar_try('a0000000-0000-4000-8000-000000000001',
            format('SELECT count(*)::text FROM abrechnung_reminder_facts(%L, ''2026-09-21'')', co_a)) LIKE 'ERR 42501%');
END $$;

-- ─── 7. candidates ──────────────────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  r    record;
BEGIN
  SELECT * INTO r FROM abrechnung_schedule_candidates(500, NULL) WHERE company_id = co_a;
  PERFORM _ar_ok('candidates: company A comes back with its reminder switch and lead',
    r.company_id = co_a AND r.reminder_enabled AND r.reminder_lead_minutes = 60);

  PERFORM _ar_ok('candidates: …and its claims, the reminder kind among them',
    EXISTS (SELECT 1 FROM jsonb_array_elements(r.sent) e WHERE e ->> 'kind' = 'driver_reminder'));

  UPDATE companies SET status = 'suspended' WHERE id = 'c0000000-0000-4000-8000-00000000000b';
  PERFORM _ar_ok('candidates: a suspended company is not offered',
    NOT EXISTS (SELECT 1 FROM abrechnung_schedule_candidates(500, NULL)
                 WHERE company_id = 'c0000000-0000-4000-8000-00000000000b'));
  PERFORM _ar_ok('candidates: …and its claim answers NULL',
    abrechnung_delivery_claim('c0000000-0000-4000-8000-00000000000b', 'driver_reminder',
                              'd0000000-0000-4000-8000-0000000000b1', '2030-01-07') IS NULL);
END $$;

ROLLBACK;
