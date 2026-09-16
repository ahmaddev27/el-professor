/*
  Gehaltsquittung: confirm, void, signed copies, and the ledger underneath.

  Runs after seed.sql, against 20260914140000_salary_cash_receipts.sql. Every
  call goes through the real RPCs and policies as a real principal — the JWT
  claim plus SET LOCAL ROLE authenticated, as in assertions.sql — so what is
  tested is what PostgREST runs. Each check raises on failure; a silent run is
  a pass.

  The amounts are the scenario src/utils/salaryCashReceipt.test.ts walks in the
  browser mirror: salary S1 is due 1000,00 and is paid 400 and 250 in cash on
  receipts, then 100 by bank, 50 as weekly "Bar zurück" and 20 in cash by hand,
  leaving 180 for a third, final receipt.

  The last three blocks open two real sessions through dblink, because a lock
  can only be shown to work by something waiting on it.
*/

\set ON_ERROR_STOP on

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _sc_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/*
  Runs p_sql as p_user. Returns 'ok' when it affected rows, 'no_rows' when it
  ran and matched nothing (how RLS refuses an UPDATE or DELETE), and otherwise
  the refusal: the machine reason the RPCs and the payment guard put in HINT
  (a snake_case word), or else the SQLSTATE. Postgres 17 gives a plain
  permission error a prose HINT ("Grant the required privileges…"), which is
  not a reason and must not stand in for 42501.
*/
CREATE OR REPLACE FUNCTION _sc_try(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  affected integer;
  v_hint   text;
  v_state  text;
BEGIN
  PERFORM _sc_as(p_user);
  EXECUTE p_sql;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RESET ROLE;
  RETURN CASE WHEN affected > 0 THEN 'ok' ELSE 'no_rows' END;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_state = RETURNED_SQLSTATE;
  RESET ROLE;
  RETURN CASE WHEN v_hint ~ '^[a-z_]+$' THEN v_hint ELSE v_state END;
END $$;

CREATE OR REPLACE FUNCTION _sc_eq(p_desc text, p_got anyelement, p_want anyelement) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION 'FAIL: % — expected %, got %', p_desc, p_want, p_got;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _sc_confirm_sql(p_request uuid, p_salary uuid, p_amount numeric,
                                           p_date date DEFAULT DATE '2026-06-01',
                                           p_place text DEFAULT 'Berlin') RETURNS text
LANGUAGE sql AS $$
  SELECT format('SELECT confirm_salary_cash_payment(%L::uuid, %L::uuid, %L::numeric, %L::date, %L::text)',
                p_request, p_salary, p_amount, p_date, p_place);
$$;

/* A confirmation that must succeed. An unexpected refusal fails the run with its own message. */
CREATE OR REPLACE FUNCTION _sc_confirm(p_user uuid, p_request uuid, p_salary uuid, p_amount numeric,
                                       p_date date DEFAULT DATE '2026-06-01',
                                       p_place text DEFAULT 'Berlin') RETURNS salary_cash_receipts
LANGUAGE plpgsql AS $$
DECLARE r salary_cash_receipts;
BEGIN
  PERFORM _sc_as(p_user);
  r := confirm_salary_cash_payment(p_request, p_salary, p_amount, p_date, p_place);
  RESET ROLE;
  RETURN r;
END $$;

-- ─── fixtures ───────────────────────────────────────────────────────────────
-- Written as supabase_admin, so RLS does not apply. Fixed ids, so a failure
-- names a row you can look up.

INSERT INTO drivers (id, company_id, name)
VALUES ('d0000000-0000-4000-8000-0000000000a2', 'c0000000-0000-4000-8000-00000000000a', 'Driver A2')
ON CONFLICT (id) DO NOTHING;

INSERT INTO salaries (id, company_id, driver_id, period_start, period_end, amount_due, netto_salary, created_by)
VALUES
  -- S1: due 1000 from amount_due
  ('5a1a0000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-00000000000a', '2026-05-04', '2026-05-31', 1000.00, NULL,   'a0000000-0000-4000-8000-000000000001'),
  -- S2: netto 800 wins over amount_due 1200
  ('5a1a0000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-00000000000a', '2026-06-01', '2026-07-05', 1200.00, 800.00, 'a0000000-0000-4000-8000-000000000001'),
  -- S3: the driver who gets deleted
  ('5a1a0000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-0000000000a2', '2026-05-04', '2026-05-31', 500.00,  NULL,   'a0000000-0000-4000-8000-000000000001'),
  -- S4: company B
  ('5a1b0000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-00000000000b', 'd0000000-0000-4000-8000-00000000000b', '2026-05-04', '2026-05-31', 300.00,  NULL,   'b0000000-0000-4000-8000-000000000001'),
  -- S5 and S6: one driver, a calendar month beside a business month
  ('5a1a0000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-00000000000a', '2026-08-01', '2026-08-31', 100.00,  NULL,   'a0000000-0000-4000-8000-000000000001'),
  ('5a1a0000-0000-4000-8000-000000000006', 'c0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-00000000000a', '2026-08-03', '2026-08-30', 100.00,  NULL,   'a0000000-0000-4000-8000-000000000001'),
  -- S10: the foreign-key lock block
  ('5a1a0000-0000-4000-8000-000000000010', 'c0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-00000000000a', '2026-01-05', '2026-02-01', 500.00,  NULL,   'a0000000-0000-4000-8000-000000000001'),
  -- S7: a period starting on Wednesday 2026-04-01, whose week began in March
  ('5a1a0000-0000-4000-8000-000000000007', 'c0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-00000000000a', '2026-04-01', '2026-04-30', 100.00,  NULL,   'a0000000-0000-4000-8000-000000000001'),
  -- S8, S9 and S11: the concurrency blocks
  ('5a1a0000-0000-4000-8000-000000000008', 'c0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-00000000000a', '2026-03-02', '2026-03-29', 500.00,  NULL,   'a0000000-0000-4000-8000-000000000001'),
  ('5a1a0000-0000-4000-8000-000000000009', 'c0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-00000000000a', '2026-02-02', '2026-03-01', 999.00,  NULL,   'a0000000-0000-4000-8000-000000000001'),
  ('5a1a0000-0000-4000-8000-000000000011', 'c0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-00000000000a', '2025-10-06', '2025-11-02', 300.00,  NULL,   'a0000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- ─── confirm, void, attach ──────────────────────────────────────────────────

DO $$
DECLARE
  co_a     uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b     uuid := 'c0000000-0000-4000-8000-00000000000b';
  admin_a  uuid := 'a0000000-0000-4000-8000-000000000001';
  editor_a uuid := 'a0000000-0000-4000-8000-000000000002';
  viewer_a uuid := 'a0000000-0000-4000-8000-000000000003';
  admin_b  uuid := 'b0000000-0000-4000-8000-000000000001';
  super_u  uuid := '50000000-0000-4000-8000-000000000001';
  drv_a    uuid := 'd0000000-0000-4000-8000-00000000000a';
  drv_a2   uuid := 'd0000000-0000-4000-8000-0000000000a2';
  s1 uuid := '5a1a0000-0000-4000-8000-000000000001';
  s2 uuid := '5a1a0000-0000-4000-8000-000000000002';
  s3 uuid := '5a1a0000-0000-4000-8000-000000000003';
  s4 uuid := '5a1b0000-0000-4000-8000-000000000004';
  s5 uuid := '5a1a0000-0000-4000-8000-000000000005';
  s6 uuid := '5a1a0000-0000-4000-8000-000000000006';
  s7 uuid := '5a1a0000-0000-4000-8000-000000000007';
  req1 uuid := gen_random_uuid();
  r1 salary_cash_receipts;
  r2 salary_cash_receipts;
  r3 salary_cash_receipts;
  r_s2 salary_cash_receipts;
  r_s3 salary_cash_receipts;
  r_s4 salary_cash_receipts;
  r_s7 salary_cash_receipts;
  v salary_cash_receipts;
  sal salaries;
  n bigint;
  cash_out numeric;
  receipted numeric;
BEGIN
  PERFORM _sc_as(admin_a);
  IF auth.uid() IS DISTINCT FROM admin_a OR get_user_company_id() IS DISTINCT FROM co_a THEN
    RESET ROLE;
    RAISE EXCEPTION 'impersonation is not working: auth.uid()=%, company=%', auth.uid(), get_user_company_id();
  END IF;
  RESET ROLE;
  RAISE NOTICE 'ok  impersonation verified';

  -- ── refused before anything is paid ─────────────────────────────────────
  PERFORM _sc_eq('anon cannot execute confirm, void or attach',
    has_function_privilege('anon', 'confirm_salary_cash_payment(uuid,uuid,numeric,date,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'void_salary_cash_receipt(uuid,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'attach_salary_cash_receipt_signed_copy(uuid,text)', 'EXECUTE'), false);
  PERFORM _sc_eq('a viewer cannot confirm',
    _sc_try(viewer_a, _sc_confirm_sql(gen_random_uuid(), s2, 10)), 'not_authorized'::text);
  PERFORM _sc_eq('the platform account, which has no company, cannot confirm',
    _sc_try(super_u, _sc_confirm_sql(gen_random_uuid(), s1, 10)), 'not_authorized'::text);
  PERFORM _sc_eq('company B cannot pay a company A salary',
    _sc_try(admin_b, _sc_confirm_sql(gen_random_uuid(), s1, 10)), 'salary_not_found'::text);
  PERFORM _sc_eq('company A cannot pay a company B salary',
    _sc_try(admin_a, _sc_confirm_sql(gen_random_uuid(), s4, 10)), 'salary_not_found'::text);
  PERFORM _sc_eq('an unknown salary is not found',
    _sc_try(admin_a, _sc_confirm_sql(gen_random_uuid(), gen_random_uuid(), 10)), 'salary_not_found'::text);
  PERFORM _sc_eq('zero is refused',
    _sc_try(admin_a, _sc_confirm_sql(gen_random_uuid(), s1, 0)), 'invalid_amount'::text);
  PERFORM _sc_eq('a negative amount is refused',
    _sc_try(admin_a, _sc_confirm_sql(gen_random_uuid(), s1, -5)), 'invalid_amount'::text);
  PERFORM _sc_eq('a third decimal is refused, not rounded',
    _sc_try(admin_a, _sc_confirm_sql(gen_random_uuid(), s1, 10.005)), 'invalid_amount'::text);
  PERFORM _sc_eq('a missing amount is refused',
    _sc_try(admin_a, _sc_confirm_sql(gen_random_uuid(), s1, NULL)), 'invalid_amount'::text);
  PERFORM _sc_eq('a payment date in the future is refused',
    _sc_try(admin_a, _sc_confirm_sql(gen_random_uuid(), s1, 10, current_date + 2)), 'invalid_payment_date'::text);
  PERFORM _sc_eq('a blank place is refused',
    _sc_try(admin_a, _sc_confirm_sql(gen_random_uuid(), s1, 10, DATE '2026-06-01', '   ')), 'invalid_place'::text);
  PERFORM _sc_eq('a missing request id is refused',
    _sc_try(admin_a, _sc_confirm_sql(NULL, s1, 10)), 'invalid_request'::text);
  -- Periods that only touch (S9 ends 2026-03-01, S8 starts 2026-03-02) are not
  -- an overlap: S8 and S7 are confirmed further down.
  PERFORM _sc_eq('a salary whose period overlaps another row of the same driver is refused',
    _sc_try(admin_a, _sc_confirm_sql(gen_random_uuid(), s5, 10)), 'overlapping_salary'::text);
  PERFORM _sc_eq('... from either side',
    _sc_try(admin_a, _sc_confirm_sql(gen_random_uuid(), s6, 10)), 'overlapping_salary'::text);

  SELECT count(*) INTO n FROM salary_cash_receipts;
  PERFORM _sc_eq('no refusal left a receipt behind', n, 0::bigint);
  SELECT count(*) INTO n FROM cash_movements;
  PERFORM _sc_eq('no refusal moved cash', n, 0::bigint);
  SELECT count(*) INTO n FROM salary_payments WHERE salary_id IN (s1, s2, s4, s5, s6);
  PERFORM _sc_eq('no refusal wrote a payment', n, 0::bigint);
  SELECT count(*) INTO n FROM document_counters;
  PERFORM _sc_eq('no refusal consumed a receipt number', n, 0::bigint);

  -- ── R1: partial ─────────────────────────────────────────────────────────
  r1 := _sc_confirm(admin_a, req1, s1, 400.00);
  PERFORM _sc_eq('R1 gets the first number', r1.receipt_number, 'GQ-2026-0001'::text);
  PERFORM _sc_eq('R1 is partial', r1.is_partial, true);
  PERFORM _sc_eq('R1 due is amount_due when there is no netto', r1.due_amount, 1000.00::numeric);
  PERFORM _sc_eq('R1 remaining before', r1.remaining_before, 1000.00::numeric);
  PERFORM _sc_eq('R1 remaining after', r1.remaining_after, 600.00::numeric);
  PERFORM _sc_eq('R1 month of a period starting Monday 2026-05-04', r1.business_month, 5);
  PERFORM _sc_eq('R1 business year', r1.business_year, 2026);
  SELECT * INTO sal FROM salaries WHERE id = s1;
  PERFORM _sc_eq('S1 is partially_paid after R1 (status from the trigger)', sal.payment_status, 'partially_paid'::text);
  PERFORM _sc_eq('S1 total_paid after R1', sal.total_paid, 400.00::numeric);
  SELECT count(*) INTO n FROM salary_payments
   WHERE id = r1.salary_payment_id AND salary_id = s1 AND payment_type = 'cash' AND amount = 400.00
     AND source_type = 'gehaltsquittung' AND source_reference = r1.id::text;
  PERFORM _sc_eq('R1 wrote its salary payment', n, 1::bigint);
  SELECT count(*) INTO n FROM cash_movements
   WHERE id = r1.cash_movement_id AND company_id = co_a AND direction = 'out' AND amount = 400.00
     AND source_type = 'gehaltsquittung' AND source_id = r1.id AND movement_date = DATE '2026-06-01';
  PERFORM _sc_eq('R1 took 400 out of the till on the payment date', n, 1::bigint);

  -- ── R2: a second partial payment, by an editor ───────────────────────────
  r2 := _sc_confirm(editor_a, gen_random_uuid(), s1, 250.00);
  PERFORM _sc_eq('an editor may confirm; R2 is numbered next', r2.receipt_number, 'GQ-2026-0002'::text);
  PERFORM _sc_eq('R2 sees R1 as cash paid on a receipt', r2.paid_cash_receipts_before, 400.00::numeric);
  PERFORM _sc_eq('R2 remaining before', r2.remaining_before, 600.00::numeric);
  PERFORM _sc_eq('R2 remaining after', r2.remaining_after, 350.00::numeric);
  PERFORM _sc_eq('R2 is partial', r2.is_partial, true);

  -- ── bank, Bar zurück and cash by hand, recorded directly as the UI does ──
  PERFORM _sc_eq('a bank payment is recorded directly',
    _sc_try(admin_a, format($f$INSERT INTO salary_payments (salary_id, company_id, payment_type, amount, payment_date, description, source_type, created_by)
                              VALUES (%L, %L, 'bank', 100.00, '2026-06-01', 'Überweisung', 'manual', %L)$f$, s1, co_a, admin_a)), 'ok'::text);
  PERFORM _sc_eq('a weekly Bar zurück is recorded directly',
    _sc_try(admin_a, format($f$INSERT INTO salary_payments (salary_id, company_id, payment_type, amount, payment_date, description, payment_category, source_type, source_reference, week_start, week_end, created_by)
                              VALUES (%L, %L, 'cash', 50.00, '2026-05-31', 'Automatisch aus letzter Wochenabrechnung übernommen', 'Bargehalt', 'weekly_cash_difference', %L, '2026-05-04', '2026-05-31', %L)$f$,
                     s1, co_a, drv_a::text || '_2026_5_4', admin_a)), 'ok'::text);
  PERFORM _sc_eq('cash handed over by hand is recorded directly',
    _sc_try(admin_a, format($f$INSERT INTO salary_payments (salary_id, company_id, payment_type, amount, payment_date, description, source_type, created_by)
                              VALUES (%L, %L, 'cash', 20.00, '2026-06-01', 'bar', 'manual', %L)$f$, s1, co_a, admin_a)), 'ok'::text);
  SELECT count(*) INTO n FROM cash_movements WHERE company_id = co_a;
  PERFORM _sc_eq('bank, Bar zurück and hand-recorded payments move nothing in the ledger', n, 2::bigint);

  -- ── R3: settles the salary ──────────────────────────────────────────────
  r3 := _sc_confirm(admin_a, gen_random_uuid(), s1, 180.00);
  PERFORM _sc_eq('R3 number', r3.receipt_number, 'GQ-2026-0003'::text);
  PERFORM _sc_eq('R3 is not partial', r3.is_partial, false);
  PERFORM _sc_eq('R3 snapshot: cash by hand', r3.paid_cash_manual_before, 20.00::numeric);
  PERFORM _sc_eq('R3 snapshot: Bar zurück, kept apart', r3.paid_cash_weekly_before, 50.00::numeric);
  PERFORM _sc_eq('R3 snapshot: cash on earlier receipts', r3.paid_cash_receipts_before, 650.00::numeric);
  PERFORM _sc_eq('R3 snapshot: bank', r3.paid_bank_before, 100.00::numeric);
  PERFORM _sc_eq('R3 snapshot: remaining before', r3.remaining_before, 180.00::numeric);
  PERFORM _sc_eq('R3 snapshot: remaining after', r3.remaining_after, 0.00::numeric);
  SELECT * INTO sal FROM salaries WHERE id = s1;
  PERFORM _sc_eq('S1 is paid', sal.payment_status, 'paid'::text);
  PERFORM _sc_eq('S1 total_paid', sal.total_paid, 1000.00::numeric);
  PERFORM _sc_eq('S1 remaining_balance', sal.remaining_balance, 0.00::numeric);

  -- ── overpayment ─────────────────────────────────────────────────────────
  PERFORM _sc_eq('a paid salary refuses even one cent',
    _sc_try(admin_a, _sc_confirm_sql(gen_random_uuid(), s1, 0.01)), 'already_paid'::text);
  PERFORM _sc_eq('S2 is due its netto of 800, so 800.01 is an overpayment',
    _sc_try(admin_a, _sc_confirm_sql(gen_random_uuid(), s2, 800.01)), 'overpayment'::text);

  -- ── idempotency ─────────────────────────────────────────────────────────
  v := _sc_confirm(admin_a, req1, s1, 400.00);
  PERFORM _sc_eq('the same request again returns the same receipt, even though S1 is now paid', v.id, r1.id);
  PERFORM _sc_eq('... with the same number', v.receipt_number, 'GQ-2026-0001'::text);
  SELECT count(*) INTO n FROM salary_payments WHERE salary_id = s1 AND source_type = 'gehaltsquittung';
  PERFORM _sc_eq('... and no second payment', n, 3::bigint);
  SELECT count(*) INTO n FROM cash_movements WHERE company_id = co_a;
  PERFORM _sc_eq('... and no second cash movement', n, 3::bigint);
  PERFORM _sc_eq('the same request with another amount is a conflict',
    _sc_try(admin_a, _sc_confirm_sql(req1, s1, 399.00)), 'request_id_conflict'::text);
  PERFORM _sc_eq('the same request for another salary is a conflict',
    _sc_try(admin_a, _sc_confirm_sql(req1, s2, 400.00)), 'request_id_conflict'::text);
  PERFORM _sc_eq('the same request with another payment date is a conflict',
    _sc_try(admin_a, _sc_confirm_sql(req1, s1, 400.00, DATE '2026-06-02')), 'request_id_conflict'::text);
  PERFORM _sc_eq('the same request with another place is a conflict',
    _sc_try(admin_a, _sc_confirm_sql(req1, s1, 400.00, DATE '2026-06-01', 'Hamburg')), 'request_id_conflict'::text);
  v := _sc_confirm(admin_a, req1, s1, 400, DATE '2026-06-01', '  Berlin ');
  PERFORM _sc_eq('... but 400 for 400.00 and a padded place are the same request', v.id, r1.id);

  -- ── full payment, numbering per company and per year ────────────────────
  r_s2 := _sc_confirm(admin_a, gen_random_uuid(), s2, 800.00);
  PERFORM _sc_eq('retries and refusals consumed no number: S2 is 0004', r_s2.receipt_number, 'GQ-2026-0004'::text);
  PERFORM _sc_eq('S2 paid in full in one receipt', r_s2.is_partial, false);
  PERFORM _sc_eq('S2 due is its netto', r_s2.due_amount, 800.00::numeric);
  SELECT * INTO sal FROM salaries WHERE id = s2;
  PERFORM _sc_eq('S2 is paid', sal.payment_status, 'paid'::text);

  r_s4 := _sc_confirm(admin_b, gen_random_uuid(), s4, 300.00);
  PERFORM _sc_eq('numbers are per company: company B starts at 0001', r_s4.receipt_number, 'GQ-2026-0001'::text);

  -- The RPC does not judge whether a payment date suits the period; it only
  -- refuses one in the future. Here it exercises numbering by payment year.
  r_s7 := _sc_confirm(admin_a, gen_random_uuid(), s7, 40.00, DATE '2025-12-31');
  PERFORM _sc_eq('numbers follow the year of the payment date', r_s7.receipt_number, 'GQ-2025-0001'::text);
  PERFORM _sc_eq('a period starting Wednesday 2026-04-01 belongs to business month 3', r_s7.business_month, 3);
  PERFORM _sc_eq('... of 2026', r_s7.business_year, 2026);

  -- ── reads ───────────────────────────────────────────────────────────────
  PERFORM _sc_as(admin_b);
  SELECT count(*) INTO n FROM salary_cash_receipts;
  RESET ROLE;
  PERFORM _sc_eq('company B reads only its own receipts', n, 1::bigint);
  PERFORM _sc_as(admin_b);
  SELECT count(*) INTO n FROM cash_movements;
  RESET ROLE;
  PERFORM _sc_eq('company B reads only its own cash movements', n, 1::bigint);
  PERFORM _sc_as(viewer_a);
  SELECT count(*) INTO n FROM salary_cash_receipts;
  RESET ROLE;
  PERFORM _sc_eq('a viewer reads its company''s receipts', n, 5::bigint);
  -- Since 20260917130000 (plan 3.3) the Gehaltsquittung tables carry the same
  -- SELECT shape as every other business table, and since 20260917140000 (plan
  -- 3.4) that shape is confined to the company a staff account has open. This
  -- one has opened nothing — _sc_as carries no session claim — so it reads no
  -- receipts at all. Writing them stays nobody's: authenticated holds SELECT
  -- and nothing else, which is what the checks below prove.
  PERFORM _sc_as(super_u);
  SELECT count(DISTINCT company_id) INTO n FROM salary_cash_receipts;
  RESET ROLE;
  PERFORM _sc_eq('a platform account with no open context reads no receipts', n, 0::bigint);

  -- ── nothing is written around the RPCs ──────────────────────────────────
  PERFORM _sc_eq('no one inserts a receipt directly',
    _sc_try(admin_a, format($f$INSERT INTO salary_cash_receipts (company_id, request_id, receipt_number, salary_id, driver_id, period_start, period_end, business_month, business_year, amount, payment_date, place, is_partial, due_amount, paid_cash_manual_before, paid_cash_weekly_before, paid_cash_receipts_before, paid_bank_before, remaining_before, remaining_after)
                              VALUES (%L, gen_random_uuid(), 'GQ-2026-9999', %L, %L, '2026-06-01', '2026-07-05', 6, 2026, 1, '2026-06-01', 'x', false, 1, 0, 0, 0, 0, 1, 0)$f$, co_a, s2, drv_a)), '42501'::text);
  PERFORM _sc_eq('no one edits a receipt directly',
    _sc_try(admin_a, format('UPDATE salary_cash_receipts SET place = %L WHERE id = %L', 'x', r1.id)), '42501'::text);
  PERFORM _sc_eq('no one deletes a receipt directly',
    _sc_try(admin_a, format('DELETE FROM salary_cash_receipts WHERE id = %L', r1.id)), '42501'::text);
  PERFORM _sc_eq('no one writes a cash movement directly',
    _sc_try(admin_a, format($f$INSERT INTO cash_movements (company_id, direction, amount, movement_date, source_type, source_id) VALUES (%L, 'in', 1, current_date, 'gehaltsquittung', gen_random_uuid())$f$, co_a)), '42501'::text);
  PERFORM _sc_eq('no one deletes a cash movement directly',
    _sc_try(admin_a, format('DELETE FROM cash_movements WHERE id = %L', r1.cash_movement_id)), '42501'::text);
  PERFORM _sc_eq('no one reads the document counters',
    _sc_try(admin_a, 'SELECT * FROM document_counters'), '42501'::text);
  PERFORM _sc_eq('no one draws a number outside a confirmation',
    _sc_try(admin_a, format('SELECT next_document_number(%L, %L, 2026)', co_a, 'gehaltsquittung')), '42501'::text);

  PERFORM _sc_eq('the payment behind a receipt cannot be edited',
    _sc_try(admin_a, format('UPDATE salary_payments SET amount = 1 WHERE id = %L', r1.salary_payment_id)), 'receipt_payment_locked'::text);
  PERFORM _sc_eq('the payment behind a receipt cannot be deleted',
    _sc_try(admin_a, format('DELETE FROM salary_payments WHERE id = %L', r1.salary_payment_id)), 'receipt_payment_locked'::text);
  PERFORM _sc_eq('a hand-recorded payment cannot be relabelled as a receipt payment',
    _sc_try(admin_a, format($f$UPDATE salary_payments SET source_type = 'gehaltsquittung' WHERE salary_id = %L AND source_type = 'manual' AND payment_type = 'cash'$f$, s1)), 'receipt_payment_locked'::text);
  PERFORM _sc_eq('a receipt payment cannot be forged',
    _sc_try(admin_a, format($f$INSERT INTO salary_payments (salary_id, company_id, payment_type, amount, payment_date, source_type, source_reference, created_by)
                              VALUES (%L, %L, 'cash', 400.00, '2026-06-01', 'gehaltsquittung', %L, %L)$f$, s1, co_a, r1.id, admin_a)), 'receipt_payment_locked'::text);
  PERFORM _sc_eq('a hand-recorded payment can still be edited: the lock is narrow',
    _sc_try(admin_a, format($f$UPDATE salary_payments SET description = 'korrigiert' WHERE salary_id = %L AND source_type = 'manual' AND payment_type = 'cash'$f$, s1)), 'ok'::text);
  PERFORM _sc_eq('a salary with a receipt cannot be deleted on its own',
    _sc_try(admin_a, format('DELETE FROM salaries WHERE id = %L', s1)), '23503'::text);

  SELECT coalesce(sum(CASE direction WHEN 'out' THEN amount ELSE -amount END), 0) INTO cash_out
    FROM cash_movements WHERE company_id = co_a;
  SELECT coalesce(sum(amount), 0) INTO receipted
    FROM salary_cash_receipts WHERE company_id = co_a AND status = 'confirmed';
  PERFORM _sc_eq('cash out of the till equals the confirmed receipts', cash_out, receipted);

  -- ── void ────────────────────────────────────────────────────────────────
  PERFORM _sc_eq('a viewer cannot void',
    _sc_try(viewer_a, format('SELECT void_salary_cash_receipt(%L, %L)', r2.id, 'x')), 'not_authorized'::text);
  PERFORM _sc_eq('company B cannot void a company A receipt',
    _sc_try(admin_b, format('SELECT void_salary_cash_receipt(%L, %L)', r2.id, 'x')), 'receipt_not_found'::text);
  PERFORM _sc_eq('a void needs a reason',
    _sc_try(admin_a, format('SELECT void_salary_cash_receipt(%L, %L)', r2.id, '  ')), 'invalid_reason'::text);

  PERFORM _sc_as(admin_a);
  v := void_salary_cash_receipt(r2.id, 'Falscher Betrag');
  RESET ROLE;
  PERFORM _sc_eq('R2 is voided', v.status, 'voided'::text);
  PERFORM _sc_eq('R2 keeps its number', v.receipt_number, 'GQ-2026-0002'::text);
  SELECT count(*) INTO n FROM salary_payments WHERE id = r2.salary_payment_id;
  PERFORM _sc_eq('R2''s payment is gone', n, 0::bigint);
  SELECT * INTO sal FROM salaries WHERE id = s1;
  PERFORM _sc_eq('S1 is back to partially_paid', sal.payment_status, 'partially_paid'::text);
  PERFORM _sc_eq('S1 total_paid without R2', sal.total_paid, 750.00::numeric);
  PERFORM _sc_eq('S1 remaining_balance is R2''s amount', sal.remaining_balance, 250.00::numeric);
  SELECT count(*) INTO n FROM cash_movements
   WHERE id = v.void_cash_movement_id AND direction = 'in' AND amount = 250.00
     AND source_type = 'gehaltsquittung_storno' AND source_id = r2.id
     AND movement_date = (now() AT TIME ZONE 'Europe/Berlin')::date;
  PERFORM _sc_eq('the till gets 250 back, booked on the day of the void', n, 1::bigint);

  PERFORM _sc_as(admin_a);
  v := void_salary_cash_receipt(r2.id, 'noch einmal');
  RESET ROLE;
  SELECT count(*) INTO n FROM cash_movements WHERE source_type = 'gehaltsquittung_storno' AND source_id = r2.id;
  PERFORM _sc_eq('voiding twice books one reversal', n, 1::bigint);
  PERFORM _sc_eq('... and keeps the first reason', v.void_reason, 'Falscher Betrag'::text);

  SELECT coalesce(sum(CASE direction WHEN 'out' THEN amount ELSE -amount END), 0) INTO cash_out
    FROM cash_movements WHERE company_id = co_a;
  SELECT coalesce(sum(amount), 0) INTO receipted
    FROM salary_cash_receipts WHERE company_id = co_a AND status = 'confirmed';
  PERFORM _sc_eq('after the void, cash out still equals the confirmed receipts', cash_out, receipted);

  v := _sc_confirm(admin_a, gen_random_uuid(), s1, 250.00);
  PERFORM _sc_eq('the voided amount can be paid again, under a new number', v.receipt_number, 'GQ-2026-0005'::text);
  PERFORM _sc_eq('... which settles S1 again', v.is_partial, false);

  -- ── signed copy ─────────────────────────────────────────────────────────
  PERFORM _sc_as(admin_a);
  v := attach_salary_cash_receipt_signed_copy(r1.id, co_a::text || '/2026/GQ-2026-0001-unterschrieben.pdf');
  RESET ROLE;
  PERFORM _sc_eq('the signed copy path is stored', v.signed_copy_path, co_a::text || '/2026/GQ-2026-0001-unterschrieben.pdf');
  PERFORM _sc_eq('a signed copy outside the company folder is refused',
    _sc_try(admin_a, format('SELECT attach_salary_cash_receipt_signed_copy(%L, %L)', r1.id, co_b::text || '/2026/x.pdf')), 'invalid_path'::text);
  PERFORM _sc_eq('a path that climbs out is refused',
    _sc_try(admin_a, format('SELECT attach_salary_cash_receipt_signed_copy(%L, %L)', r1.id, co_a::text || '/../x.pdf')), 'invalid_path'::text);
  PERFORM _sc_eq('the company folder itself is not a file',
    _sc_try(admin_a, format('SELECT attach_salary_cash_receipt_signed_copy(%L, %L)', r1.id, co_a::text)), 'invalid_path'::text);
  PERFORM _sc_eq('a viewer cannot attach',
    _sc_try(viewer_a, format('SELECT attach_salary_cash_receipt_signed_copy(%L, %L)', r1.id, co_a::text || '/v.pdf')), 'not_authorized'::text);
  PERFORM _sc_eq('company B cannot attach to a company A receipt',
    _sc_try(admin_b, format('SELECT attach_salary_cash_receipt_signed_copy(%L, %L)', r1.id, co_b::text || '/b.pdf')), 'receipt_not_found'::text);
  PERFORM _sc_eq('a voided receipt takes no signed copy',
    _sc_try(admin_a, format('SELECT attach_salary_cash_receipt_signed_copy(%L, %L)', r2.id, co_a::text || '/r2.pdf')), 'receipt_voided'::text);

  -- ── storage bucket ──────────────────────────────────────────────────────
  SELECT count(*) INTO n FROM storage.buckets
   WHERE id = 'salary-receipts' AND public = false AND file_size_limit = 10485760
     AND allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png'];
  PERFORM _sc_eq('the salary-receipts bucket is private, 10 MB, PDF/JPEG/PNG', n, 1::bigint);
  PERFORM _sc_eq('an admin uploads into its company folder',
    _sc_try(admin_a, format($f$INSERT INTO storage.objects (bucket_id, name) VALUES ('salary-receipts', %L)$f$, co_a::text || '/2026/GQ-2026-0001.pdf')), 'ok'::text);
  PERFORM _sc_eq('an editor uploads into its company folder',
    _sc_try(editor_a, format($f$INSERT INTO storage.objects (bucket_id, name) VALUES ('salary-receipts', %L)$f$, co_a::text || '/2026/GQ-2026-0003.pdf')), 'ok'::text);
  PERFORM _sc_eq('an admin cannot upload into another company''s folder',
    _sc_try(admin_a, format($f$INSERT INTO storage.objects (bucket_id, name) VALUES ('salary-receipts', %L)$f$, co_b::text || '/2026/x.pdf')), '42501'::text);
  PERFORM _sc_eq('a viewer cannot upload',
    _sc_try(viewer_a, format($f$INSERT INTO storage.objects (bucket_id, name) VALUES ('salary-receipts', %L)$f$, co_a::text || '/2026/v.pdf')), '42501'::text);
  PERFORM _sc_eq('a file outside any company folder is refused',
    _sc_try(admin_a, $f$INSERT INTO storage.objects (bucket_id, name) VALUES ('salary-receipts', 'loose.pdf')$f$), '42501'::text);
  PERFORM _sc_as(admin_b);
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'salary-receipts';
  RESET ROLE;
  PERFORM _sc_eq('company B sees none of company A''s files', n, 0::bigint);
  PERFORM _sc_as(viewer_a);
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'salary-receipts';
  RESET ROLE;
  PERFORM _sc_eq('a viewer reads its company''s files', n, 2::bigint);
  PERFORM _sc_eq('an editor may replace a file in its company folder',
    _sc_try(editor_a, format($f$UPDATE storage.objects SET version = 'v2' WHERE bucket_id = 'salary-receipts' AND name = %L$f$, co_a::text || '/2026/GQ-2026-0003.pdf')), 'ok'::text);
  PERFORM _sc_eq('no one deletes a signed copy',
    _sc_try(admin_a, $f$DELETE FROM storage.objects WHERE bucket_id = 'salary-receipts'$f$), 'no_rows'::text);

  -- ── deleting a driver still works ───────────────────────────────────────
  r_s3 := _sc_confirm(admin_a, gen_random_uuid(), s3, 200.00);
  PERFORM _sc_eq('a driver with a receipt can still be deleted',
    _sc_try(admin_a, format('DELETE FROM drivers WHERE id = %L', drv_a2)), 'ok'::text);
  SELECT count(*) INTO n FROM salaries WHERE id = s3;
  PERFORM _sc_eq('... taking the salary with it', n, 0::bigint);
  SELECT count(*) INTO n FROM salary_cash_receipts WHERE id = r_s3.id;
  PERFORM _sc_eq('... and the receipt', n, 0::bigint);
  SELECT count(*) INTO n FROM salary_payments WHERE id = r_s3.salary_payment_id;
  PERFORM _sc_eq('... and the receipt''s payment', n, 0::bigint);
  SELECT count(*) INTO n FROM cash_movements WHERE id = r_s3.cash_movement_id;
  PERFORM _sc_eq('... while the cash it paid out stays in the ledger', n, 1::bigint);

  RAISE NOTICE '── salary cash assertions passed ──';
END $$;

-- ─── the state gate reaches inside the RPCs ─────────────────────────────────
--
-- These three are SECURITY DEFINER, so they run past RLS: without a gate of
-- their own, a company whose subscription has lapsed or that has been suspended
-- could still write a GQ receipt, its salary_payments row and an outgoing
-- cash_movements row — real money in the ledger — while the SELECT policies of
-- 20260917130000 returned it nothing. The write would succeed and be invisible
-- to the screen that made it. Since 20260917130000 they resolve the company
-- with get_active_company_id(), so a refused company takes their existing
-- not_authorized branch.
--
-- Company A is suspended for the length of this block and restored at the end;
-- nothing here writes a receipt, so the numbering the blocks above assert is
-- untouched.

DO $$
DECLARE
  co_a     uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a  uuid := 'a0000000-0000-4000-8000-000000000001';
  s2       uuid := '5a1a0000-0000-4000-8000-000000000002';
  was      text;
  receipt  uuid;
  n        bigint;
BEGIN
  SELECT id INTO receipt
    FROM salary_cash_receipts
   WHERE company_id = co_a AND status = 'confirmed'
   ORDER BY receipt_number
   LIMIT 1;
  IF receipt IS NULL THEN
    RAISE EXCEPTION 'FAIL: the state-gate block needs a confirmed company A receipt to aim at';
  END IF;

  SELECT status INTO was FROM companies WHERE id = co_a;
  UPDATE companies SET status = 'suspended' WHERE id = co_a;

  PERFORM _sc_eq('a suspended company cannot confirm a cash salary payment',
    _sc_try(admin_a, _sc_confirm_sql(gen_random_uuid(), s2, 10)), 'not_authorized'::text);
  PERFORM _sc_eq('a suspended company cannot void a receipt',
    _sc_try(admin_a, format('SELECT void_salary_cash_receipt(%L, %L)', receipt, 'x')), 'not_authorized'::text);
  PERFORM _sc_eq('a suspended company cannot attach a signed copy',
    _sc_try(admin_a, format('SELECT attach_salary_cash_receipt_signed_copy(%L, %L)',
                            receipt, co_a::text || '/2026/suspended.pdf')), 'not_authorized'::text);

  -- The other half of the finding: the reads are already gone, which is what
  -- made an ungated write invisible rather than merely wrong.
  PERFORM _sc_as(admin_a);
  SELECT count(*) INTO n FROM salary_cash_receipts;
  RESET ROLE;
  PERFORM _sc_eq('... and reads none of its own receipts while suspended', n, 0::bigint);
  PERFORM _sc_as(admin_a);
  SELECT count(*) INTO n FROM cash_movements;
  RESET ROLE;
  PERFORM _sc_eq('... nor its own cash movements', n, 0::bigint);

  UPDATE companies SET status = was WHERE id = co_a;

  -- The control, and it writes nothing: with the company restored the gate is
  -- open again, so the next refusal comes from the amount, not from authority.
  PERFORM _sc_eq('the gate reopens with the company: the refusal is the amount again',
    _sc_try(admin_a, _sc_confirm_sql(gen_random_uuid(), s2, 0)), 'invalid_amount'::text);

  RAISE NOTICE '── state gate assertions passed ──';
END $$;

-- ─── two sessions, one balance ──────────────────────────────────────────────
-- Session 1 confirms the whole of S8 and holds its transaction open. Session 2
-- asks for the same 500 and must wait; once session 1 commits, session 2 finds
-- nothing left. Without the lock both would read 500 remaining and both commit.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'dblink') THEN
    CREATE SCHEMA IF NOT EXISTS _sc_dblink;
    CREATE EXTENSION dblink WITH SCHEMA _sc_dblink;
  END IF;
END $$;

SELECT set_config('search_path',
  current_setting('search_path') || ', ' ||
  (SELECT quote_ident(n.nspname) FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'dblink'),
  false) AS search_path_with_dblink \gset

DO $$
DECLARE
  admin_a uuid := 'a0000000-0000-4000-8000-000000000001';
  s8      uuid := '5a1a0000-0000-4000-8000-000000000008';
  c       text;
  first_number text;
  err     text;
  n       bigint;
  waited  integer := 0;
  sal     salaries;
BEGIN
  FOREACH c IN ARRAY ARRAY['sc_c1', 'sc_c2'] LOOP
    PERFORM dblink_connect(c, 'dbname=postgres user=supabase_admin');
    PERFORM dblink_exec(c, 'BEGIN');
    PERFORM * FROM dblink(c, format('SELECT set_config(%L, %L, true)', 'request.jwt.claim.sub', admin_a)) AS t(v text);
    PERFORM dblink_exec(c, 'SET LOCAL ROLE authenticated');
  END LOOP;

  SELECT t.receipt_number INTO first_number
    FROM dblink('sc_c1', format('SELECT receipt_number FROM confirm_salary_cash_payment(%L, %L, 500.00, %L, %L)',
                                gen_random_uuid(), s8, DATE '2026-04-01', 'Berlin')) AS t(receipt_number text);
  PERFORM _sc_eq('session 1 confirms S8 and keeps its transaction open', first_number IS NOT NULL, true);

  PERFORM dblink_send_query('sc_c2', format('SELECT receipt_number FROM confirm_salary_cash_payment(%L, %L, 500.00, %L, %L)',
                                            gen_random_uuid(), s8, DATE '2026-04-01', 'Berlin'));
  PERFORM pg_sleep(1);
  PERFORM _sc_eq('session 2, paying the same balance, waits for session 1', dblink_is_busy('sc_c2'), 1);

  PERFORM dblink_exec('sc_c1', 'COMMIT');
  WHILE dblink_is_busy('sc_c2') = 1 AND waited < 100 LOOP
    PERFORM pg_sleep(0.1);
    waited := waited + 1;
  END LOOP;

  SELECT count(*) INTO n FROM dblink_get_result('sc_c2', false) AS t(receipt_number text);
  err := dblink_error_message('sc_c2');
  PERFORM * FROM dblink_get_result('sc_c2', false) AS t(receipt_number text);
  PERFORM dblink_exec('sc_c2', 'ROLLBACK');
  PERFORM dblink_disconnect('sc_c1');
  PERFORM dblink_disconnect('sc_c2');

  PERFORM _sc_eq('session 2 gets no receipt once session 1 commits', n, 0::bigint);
  PERFORM _sc_eq('... because nothing is left to pay', err LIKE '%bereits vollständig bezahlt%', true);
  SELECT count(*) INTO n FROM salary_cash_receipts WHERE salary_id = s8;
  PERFORM _sc_eq('S8 has exactly one receipt', n, 1::bigint);
  SELECT count(*) INTO n FROM cash_movements m JOIN salary_cash_receipts r ON r.id = m.source_id WHERE r.salary_id = s8;
  PERFORM _sc_eq('... and exactly one cash movement', n, 1::bigint);
  SELECT * INTO sal FROM salaries WHERE id = s8;
  PERFORM _sc_eq('... and S8 is paid exactly once', sal.total_paid, 500.00::numeric);
END $$;

-- ─── two sessions, one request ──────────────────────────────────────────────
-- A client that retries while its first attempt is still in flight. Session 2
-- sends the same request id and must wait, then get session 1's receipt back —
-- not a second payment, and not a refusal.

DO $$
DECLARE
  admin_a uuid := 'a0000000-0000-4000-8000-000000000001';
  s11     uuid := '5a1a0000-0000-4000-8000-000000000011';
  req     uuid := gen_random_uuid();
  c       text;
  first_number  text;
  second_number text;
  waited  integer := 0;
  n       bigint;
  sal     salaries;
BEGIN
  FOREACH c IN ARRAY ARRAY['sc_c1', 'sc_c2'] LOOP
    PERFORM dblink_connect(c, 'dbname=postgres user=supabase_admin');
    PERFORM dblink_exec(c, 'BEGIN');
    PERFORM * FROM dblink(c, format('SELECT set_config(%L, %L, true)', 'request.jwt.claim.sub', admin_a)) AS t(v text);
    PERFORM dblink_exec(c, 'SET LOCAL ROLE authenticated');
  END LOOP;

  SELECT t.receipt_number INTO first_number
    FROM dblink('sc_c1', format('SELECT receipt_number FROM confirm_salary_cash_payment(%L, %L, 100.00, %L, %L)',
                                req, s11, DATE '2025-11-03', 'Berlin')) AS t(receipt_number text);

  PERFORM dblink_send_query('sc_c2', format('SELECT receipt_number FROM confirm_salary_cash_payment(%L, %L, 100.00, %L, %L)',
                                            req, s11, DATE '2025-11-03', 'Berlin'));
  PERFORM pg_sleep(1);
  PERFORM _sc_eq('a retry of an in-flight request waits for it', dblink_is_busy('sc_c2'), 1);

  PERFORM dblink_exec('sc_c1', 'COMMIT');
  WHILE dblink_is_busy('sc_c2') = 1 AND waited < 100 LOOP
    PERFORM pg_sleep(0.1);
    waited := waited + 1;
  END LOOP;
  SELECT t.receipt_number INTO second_number FROM dblink_get_result('sc_c2') AS t(receipt_number text);
  PERFORM * FROM dblink_get_result('sc_c2') AS t(receipt_number text);
  PERFORM dblink_exec('sc_c2', 'COMMIT');
  PERFORM dblink_disconnect('sc_c1');
  PERFORM dblink_disconnect('sc_c2');

  PERFORM _sc_eq('... and then gets the same receipt back', second_number, first_number);
  SELECT count(*) INTO n FROM salary_cash_receipts WHERE salary_id = s11;
  PERFORM _sc_eq('S11 has one receipt', n, 1::bigint);
  SELECT count(*) INTO n FROM salary_payments WHERE salary_id = s11;
  PERFORM _sc_eq('... one payment', n, 1::bigint);
  SELECT count(*) INTO n FROM cash_movements m JOIN salary_cash_receipts r ON r.id = m.source_id WHERE r.salary_id = s11;
  PERFORM _sc_eq('... and one cash movement', n, 1::bigint);
  SELECT * INTO sal FROM salaries WHERE id = s11;
  PERFORM _sc_eq('... and S11 is paid 100, once', sal.total_paid, 100.00::numeric);
END $$;

-- ─── two sessions, direct payments, one status ──────────────────────────────
-- The path SalaryDetailsModal uses: two plain inserts into salary_payments for
-- S9 at the same time. Before the lock at the top of update_salary_payment_status
-- the second trigger summed only its own 200 and wrote that over the first.

DO $$
DECLARE
  co_a    uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a uuid := 'a0000000-0000-4000-8000-000000000001';
  s9      uuid := '5a1a0000-0000-4000-8000-000000000009';
  c       text;
  waited  integer := 0;
  sal     salaries;
BEGIN
  FOREACH c IN ARRAY ARRAY['sc_c1', 'sc_c2'] LOOP
    PERFORM dblink_connect(c, 'dbname=postgres user=supabase_admin');
    PERFORM dblink_exec(c, 'BEGIN');
    PERFORM * FROM dblink(c, format('SELECT set_config(%L, %L, true)', 'request.jwt.claim.sub', admin_a)) AS t(v text);
    PERFORM dblink_exec(c, 'SET LOCAL ROLE authenticated');
  END LOOP;

  PERFORM dblink_exec('sc_c1', format(
    $f$INSERT INTO salary_payments (salary_id, company_id, payment_type, amount, payment_date, source_type, created_by)
       VALUES (%L, %L, 'cash', 100.00, '2026-03-01', 'manual', %L)$f$, s9, co_a, admin_a));

  PERFORM dblink_send_query('sc_c2', format(
    $f$INSERT INTO salary_payments (salary_id, company_id, payment_type, amount, payment_date, source_type, created_by)
       VALUES (%L, %L, 'cash', 200.00, '2026-03-01', 'manual', %L)$f$, s9, co_a, admin_a));
  PERFORM pg_sleep(1);
  PERFORM _sc_eq('a second direct payment waits for the first', dblink_is_busy('sc_c2'), 1);

  PERFORM dblink_exec('sc_c1', 'COMMIT');
  WHILE dblink_is_busy('sc_c2') = 1 AND waited < 100 LOOP
    PERFORM pg_sleep(0.1);
    waited := waited + 1;
  END LOOP;
  PERFORM * FROM dblink_get_result('sc_c2') AS t(status text);
  PERFORM * FROM dblink_get_result('sc_c2') AS t(status text);
  PERFORM dblink_exec('sc_c2', 'COMMIT');
  PERFORM dblink_disconnect('sc_c1');
  PERFORM dblink_disconnect('sc_c2');

  SELECT * INTO sal FROM salaries WHERE id = s9;
  PERFORM _sc_eq('total_paid counts both concurrent payments', sal.total_paid, 300.00::numeric);
  PERFORM _sc_eq('... and payment_status follows it', sal.payment_status, 'partially_paid'::text);

  RAISE NOTICE '── concurrency assertions passed ──';
END $$;

-- ─── a payment does not wait on a foreign-key check ─────────────────────────
-- Inserting a payment checks its foreign key first, which takes FOR KEY SHARE
-- on the salary, and fires the status trigger after. Session 1 holds that key
-- share, as an insert between those two steps would. Session 2's whole insert
-- must go through: were the trigger's lock FOR UPDATE it would wait on session
-- 1, and the moment session 1's own trigger asked for the lock the two would
-- deadlock. Session 1's payment then waits for session 2, and both count.

DO $$
DECLARE
  co_a    uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a uuid := 'a0000000-0000-4000-8000-000000000001';
  s10     uuid := '5a1a0000-0000-4000-8000-000000000010';
  c       text;
  waited  integer := 0;
  sal     salaries;
BEGIN
  FOREACH c IN ARRAY ARRAY['sc_c1', 'sc_c2'] LOOP
    PERFORM dblink_connect(c, 'dbname=postgres user=supabase_admin');
    PERFORM dblink_exec(c, 'BEGIN');
    PERFORM * FROM dblink(c, format('SELECT set_config(%L, %L, true)', 'request.jwt.claim.sub', admin_a)) AS t(v text);
    PERFORM dblink_exec(c, 'SET LOCAL ROLE authenticated');
  END LOOP;

  PERFORM * FROM dblink('sc_c1', format('SELECT 1 FROM salaries WHERE id = %L FOR KEY SHARE', s10)) AS t(x integer);

  PERFORM dblink_send_query('sc_c2', format(
    $f$INSERT INTO salary_payments (salary_id, company_id, payment_type, amount, payment_date, source_type, created_by)
       VALUES (%L, %L, 'cash', 100.00, '2026-02-01', 'manual', %L)$f$, s10, co_a, admin_a));
  WHILE dblink_is_busy('sc_c2') = 1 AND waited < 30 LOOP
    PERFORM pg_sleep(0.1);
    waited := waited + 1;
  END LOOP;
  PERFORM _sc_eq('a payment goes through while another session holds a key share on its salary', dblink_is_busy('sc_c2'), 0);
  PERFORM * FROM dblink_get_result('sc_c2') AS t(status text);
  PERFORM * FROM dblink_get_result('sc_c2') AS t(status text);

  PERFORM dblink_send_query('sc_c1', format(
    $f$INSERT INTO salary_payments (salary_id, company_id, payment_type, amount, payment_date, source_type, created_by)
       VALUES (%L, %L, 'cash', 150.00, '2026-02-01', 'manual', %L)$f$, s10, co_a, admin_a));
  PERFORM pg_sleep(1);
  PERFORM _sc_eq('... and the key-share holder''s own payment then waits for it', dblink_is_busy('sc_c1'), 1);

  PERFORM dblink_exec('sc_c2', 'COMMIT');
  waited := 0;
  WHILE dblink_is_busy('sc_c1') = 1 AND waited < 100 LOOP
    PERFORM pg_sleep(0.1);
    waited := waited + 1;
  END LOOP;
  PERFORM * FROM dblink_get_result('sc_c1') AS t(status text);
  PERFORM * FROM dblink_get_result('sc_c1') AS t(status text);
  PERFORM dblink_exec('sc_c1', 'COMMIT');
  PERFORM dblink_disconnect('sc_c1');
  PERFORM dblink_disconnect('sc_c2');

  SELECT * INTO sal FROM salaries WHERE id = s10;
  PERFORM _sc_eq('no deadlock: both payments count', sal.total_paid, 250.00::numeric);
  PERFORM _sc_eq('... and payment_status follows them', sal.payment_status, 'partially_paid'::text);

  RAISE NOTICE '── foreign-key lock assertions passed ──';
END $$;

DROP FUNCTION _sc_confirm(uuid, uuid, uuid, numeric, date, text);
DROP FUNCTION _sc_confirm_sql(uuid, uuid, numeric, date, text);
DROP FUNCTION _sc_eq(text, anyelement, anyelement);
DROP FUNCTION _sc_try(uuid, text);
DROP FUNCTION _sc_as(uuid);
