/*
  A Beleg printed before 04:00 counts on the previous calendar day
  (migration 20261109100000, owner's decision of 09.11.2026).

  Runs after the files before it, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end.

  NOT RUN by the author of the migration: this file is the RLS kit's to run, on
  the VPS (CI job rls-kit). Read it as a specification until then.

  What is covered, in order:

    1. rule      receipt_business_date() at the edges: 03:59:59 moves, 04:00:00
                 stays, 00:00 moves, NULL keeps, the 1st of a month and 01.01
    2. column    business_date is stored, generated and indexed, follows an
                 UPDATE of date or receipt_time, and cannot be written
    3. view      abrechnung_weekly: Monday 03:59:59 lands in the week before,
                 Monday 04:00:00 and a Beleg with no time stay in the new week
    4. mail      abrechnung_week_figures and abrechnung_reminder_facts follow
                 the same cut, for the bar count, the spend and the Tanken sum
    5. edit log  one edit of receipt_time writes one receipt_edits row, not a
                 second one for the derived column
    6. isolation company B's identical Beleg changes nothing of company A's
*/

\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION _rb_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

-- ─── 1. the rule ────────────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _rb_ok('rule: 00:05 on Monday 09.11. counts on Sunday 08.11.',
    public.receipt_business_date(date '2026-11-09', time '00:05') = date '2026-11-08');
  PERFORM _rb_ok('rule: 03:59:59 moves',
    public.receipt_business_date(date '2026-11-09', time '03:59:59') = date '2026-11-08');
  PERFORM _rb_ok('rule: 04:00:00 stays',
    public.receipt_business_date(date '2026-11-09', time '04:00:00') = date '2026-11-09');
  PERFORM _rb_ok('rule: 00:00:00 moves',
    public.receipt_business_date(date '2026-11-09', time '00:00:00') = date '2026-11-08');
  PERFORM _rb_ok('rule: a NULL time keeps the date',
    public.receipt_business_date(date '2026-11-09', NULL) = date '2026-11-09');
  PERFORM _rb_ok('rule: the 1st of a month moves into the month before',
    public.receipt_business_date(date '2026-12-01', time '01:00') = date '2026-11-30');
  PERFORM _rb_ok('rule: 01.01. moves to 31.12.',
    public.receipt_business_date(date '2027-01-01', time '01:00') = date '2026-12-31');
  PERFORM _rb_ok('rule: IMMUTABLE and not a definer',
    EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.receipt_business_date(date,time)'::regprocedure
                AND provolatile = 'i' AND NOT prosecdef));
  PERFORM _rb_ok('rule: EXECUTE is even across anon, authenticated and service_role',
    has_function_privilege('anon', 'public.receipt_business_date(date,time)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.receipt_business_date(date,time)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.receipt_business_date(date,time)', 'EXECUTE'));
END $$;

-- ─── data ───────────────────────────────────────────────────────────────────
--
-- Company A, driver "RB Night": week of Monday 02.11.2026 and week of Monday
-- 09.11.2026. Company B gets the same driver name and the same Beleg, so a
-- leak across companies would show in the counts.

INSERT INTO receipts (company_id, receipt_number, date, receipt_time, description, driver_name, payment_method, expense)
VALUES
  -- Monday 09.11.: 03:59:59 belongs to the week before, 04:00:00 does not.
  ('c0000000-0000-4000-8000-00000000000a', 'RB-1', '2026-11-09', '03:59:59', 'Tanken', 'RB Night', 'bar', 10),
  ('c0000000-0000-4000-8000-00000000000a', 'RB-2', '2026-11-09', '04:00:00', 'Tanken', 'RB Night', 'bar', 20),
  -- A Beleg with no time keeps its date, which is Monday.
  ('c0000000-0000-4000-8000-00000000000a', 'RB-3', '2026-11-09', NULL,       'Maut',   'RB Night', 'bar', 40),
  -- Mid-week, no effect.
  ('c0000000-0000-4000-8000-00000000000a', 'RB-4', '2026-11-04', '12:00:00', 'Maut',   'RB Night', 'bar', 80),
  -- A card Beleg at 00:05 Monday moves too, but is no cash.
  ('c0000000-0000-4000-8000-00000000000a', 'RB-5', '2026-11-09', '00:05:00', 'Tanken', 'RB Night', 'uberweisung', 160),
  -- Company B: identical Beleg at 03:59 Monday.
  ('c0000000-0000-4000-8000-00000000000b', 'RB-B1', '2026-11-09', '03:59:00', 'Tanken', 'RB Night', 'bar', 1000);

INSERT INTO drivers (id, company_id, name, status, email)
VALUES ('d0000000-0000-4000-8000-0000000000c1', 'c0000000-0000-4000-8000-00000000000a', 'RB Night', 'active', 'rb-night@example.com')
ON CONFLICT (id) DO NOTHING;

-- ─── 2. the column ──────────────────────────────────────────────────────────

DO $$
DECLARE
  v_err text;
BEGIN
  PERFORM _rb_ok('column: business_date is a stored generated column',
    EXISTS (SELECT 1 FROM pg_attribute
             WHERE attrelid = 'public.receipts'::regclass AND attname = 'business_date'
               AND attgenerated = 's' AND NOT attisdropped));

  PERFORM _rb_ok('column: indexed with the company first',
    EXISTS (SELECT 1 FROM pg_indexes
             WHERE schemaname = 'public' AND tablename = 'receipts'
               AND indexdef ~ '\(company_id, business_date\)'));

  PERFORM _rb_ok('column: 03:59:59 is stored as Sunday',
    (SELECT business_date FROM receipts WHERE receipt_number = 'RB-1') = date '2026-11-08');
  PERFORM _rb_ok('column: 04:00:00 is stored as Monday',
    (SELECT business_date FROM receipts WHERE receipt_number = 'RB-2') = date '2026-11-09');
  PERFORM _rb_ok('column: no time is stored as the printed date',
    (SELECT business_date FROM receipts WHERE receipt_number = 'RB-3') = date '2026-11-09');
  PERFORM _rb_ok('column: the printed date and time are untouched',
    (SELECT date = date '2026-11-09' AND receipt_time = time '03:59:59'
       FROM receipts WHERE receipt_number = 'RB-1'));

  BEGIN
    UPDATE receipts SET business_date = date '2020-01-01' WHERE receipt_number = 'RB-1';
    v_err := 'written';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLSTATE;
  END;
  PERFORM _rb_ok(format('column: a generated column cannot be written [%s]', v_err),
    v_err = '428C9');
END $$;

-- ─── 3. the view ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_prev_month int; v_prev_year int; v_prev_week int;
  v_next_month int; v_next_year int; v_next_week int;
  n_prev bigint; n_next bigint; s_prev numeric; s_next numeric;
BEGIN
  SELECT m.month, m.year INTO v_prev_month, v_prev_year FROM get_business_month(date '2026-11-02') m;
  v_prev_week := get_business_week_number(date '2026-11-02', v_prev_month, v_prev_year);
  SELECT m.month, m.year INTO v_next_month, v_next_year FROM get_business_month(date '2026-11-09') m;
  v_next_week := get_business_week_number(date '2026-11-09', v_next_month, v_next_year);

  PERFORM _rb_ok('view: the two weeks are different weeks', v_prev_week <> v_next_week);

  SELECT anzahl_belege, ausgegebene_bargeld INTO n_prev, s_prev
    FROM abrechnung_weekly
   WHERE driver_name = 'RB Night' AND year = v_prev_year AND month = v_prev_month
     AND week_number = v_prev_week;
  SELECT anzahl_belege, ausgegebene_bargeld INTO n_next, s_next
    FROM abrechnung_weekly
   WHERE driver_name = 'RB Night' AND year = v_next_year AND month = v_next_month
     AND week_number = v_next_week;

  -- Both companies carry the driver "RB Night" and the view groups by name, so
  -- this runs as the owner (RLS does not apply) and sees company B's Beleg in
  -- the old week too: RB-4 (80, mid-week) + RB-1 (10) + RB-B1 (1000), all cash.
  PERFORM _rb_ok(format('view: week of 02.11. holds 03:59:59, the mid-week Beleg and company B''s 03:59 [%s / %s]', n_prev, s_prev),
    n_prev = 3 AND s_prev = 1090);
  -- RB-2 (04:00:00) and RB-3 (no time); the card Beleg RB-5 is no cash row.
  PERFORM _rb_ok(format('view: week of 09.11. holds 04:00:00 and the Beleg with no time [%s / %s]', n_next, s_next),
    n_next = 2 AND s_next = 60);
END $$;

-- ─── 4. the mail's figures ──────────────────────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  r    record;
BEGIN
  SELECT * INTO r FROM abrechnung_week_figures(co_a, date '2026-11-02') WHERE driver_name = 'RB Night';
  PERFORM _rb_ok(format('figures: week of 02.11. counts RB-1 and RB-4 [%s / %s / tanken %s]',
                        r.anzahl_belege, r.ausgegebene_bargeld, r.tanken_brutto),
    r.anzahl_belege = 2 AND r.ausgegebene_bargeld = 90
    -- Tanken in that week: RB-1 (10) and the card Beleg RB-5 (160), any method.
    AND r.tanken_brutto = 170);

  SELECT * INTO r FROM abrechnung_week_figures(co_a, date '2026-11-09') WHERE driver_name = 'RB Night';
  PERFORM _rb_ok(format('figures: week of 09.11. counts RB-2 and RB-3 [%s / %s / tanken %s]',
                        r.anzahl_belege, r.ausgegebene_bargeld, r.tanken_brutto),
    r.anzahl_belege = 2 AND r.ausgegebene_bargeld = 60 AND r.tanken_brutto = 20);

  PERFORM _rb_ok('reminder: week of 02.11. holds two cash Belege for the driver',
    (SELECT bar_receipt_rows FROM abrechnung_reminder_facts(co_a, date '2026-11-02')
      WHERE driver_name = 'RB Night') = 2);
  PERFORM _rb_ok('reminder: week of 09.11. holds two cash Belege for the driver',
    (SELECT bar_receipt_rows FROM abrechnung_reminder_facts(co_a, date '2026-11-09')
      WHERE driver_name = 'RB Night') = 2);
END $$;

-- ─── 5. the edit log ────────────────────────────────────────────────────────
--
-- record_receipt_edit logs every changed column generically. Moving RB-1 from
-- 03:59:59 to 05:00:00 changes receipt_time and, derived, business_date: the
-- log must hold one row for the edit, not two.

DO $$
DECLARE
  v_fields text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);
  UPDATE receipts SET receipt_time = time '05:00:00' WHERE receipt_number = 'RB-1';
  PERFORM set_config('request.jwt.claim.sub', '', true);

  SELECT string_agg(field, ',' ORDER BY field) INTO v_fields
    FROM receipt_edits WHERE receipt_id = (SELECT id FROM receipts WHERE receipt_number = 'RB-1');
  PERFORM _rb_ok(format('edit log: one edit of the time writes the time and nothing derived [%s]', v_fields),
    v_fields = 'receipt_time');
  PERFORM _rb_ok('edit log: …and the Beleg now counts on its printed date',
    (SELECT business_date FROM receipts WHERE receipt_number = 'RB-1') = date '2026-11-09');
END $$;

-- ─── 6. isolation ───────────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _rb_ok('isolation: company B''s figures for the week of 02.11. hold only its own Beleg',
    (SELECT ausgegebene_bargeld FROM abrechnung_week_figures('c0000000-0000-4000-8000-00000000000b', date '2026-11-02')
      WHERE driver_name = 'RB Night') = 1000);
END $$;

ROLLBACK;
