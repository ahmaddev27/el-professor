/*
  Gehaltsquittung issued for a cash payment that already exists
  (issue_salary_cash_receipt, 20261004100000).

  NOT YET RUN. Written on a machine without Docker, so it has not met a
  database: the first run on the VPS is its first test, and a failure in it
  may be the test's own. Read the failing line before blaming the migration.

  The rule it exists for: issuing books NOTHING into the till. Everything else
  here (number, idempotency, refusals, the payment lock, void) is the function
  doing what its header says; the cash_movements count staying put across every
  step is the point.

  Runs inside BEGIN ... ROLLBACK, so the files after it see only the migrations
  and the seeds. Fixtures use a salary period in 2024 that no other file
  touches, and fixed ids so a failure names a row.
*/

\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION _ir_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/* Runs p_sql as p_user: 'ok' when it affected rows, 'no_rows' when it matched
   none, otherwise the HINT reason (snake_case) or the SQLSTATE. */
CREATE OR REPLACE FUNCTION _ir_try(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  affected integer;
  v_hint   text;
  v_state  text;
BEGIN
  PERFORM _ir_as(p_user);
  EXECUTE p_sql;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RESET ROLE;
  RETURN CASE WHEN affected > 0 THEN 'ok' ELSE 'no_rows' END;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_state = RETURNED_SQLSTATE;
  RESET ROLE;
  RETURN CASE WHEN v_hint ~ '^[a-z_]+$' THEN v_hint ELSE v_state END;
END $$;

CREATE OR REPLACE FUNCTION _ir_eq(p_desc text, p_got anyelement, p_want anyelement) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION 'FAIL: % — expected %, got %', p_desc, p_want, p_got;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _ir_issue_sql(p_request uuid, p_payment uuid, p_place text DEFAULT 'Berlin') RETURNS text
LANGUAGE sql AS $$
  SELECT format('SELECT issue_salary_cash_receipt(%L::uuid, %L::uuid, %L::text)', p_request, p_payment, p_place);
$$;

-- ─── fixtures (as the owner, so RLS does not apply) ─────────────────────────
-- One salary due 1000,00: P1 manual cash 300, P2 bank 100, P3 "Bar zurück" 50.

INSERT INTO salaries (id, company_id, driver_id, period_start, period_end, amount_due, netto_salary, created_by)
VALUES ('5a1a0000-0000-4000-8000-0000000000e1', 'c0000000-0000-4000-8000-00000000000a',
        'd0000000-0000-4000-8000-00000000000a', '2024-02-05', '2024-03-03', 1000.00, NULL,
        'a0000000-0000-4000-8000-000000000001');

INSERT INTO salary_payments (id, salary_id, company_id, payment_type, amount, payment_date, description, payment_category, source_type, created_by)
VALUES
  ('9a1a0000-0000-4000-8000-0000000000e1', '5a1a0000-0000-4000-8000-0000000000e1', 'c0000000-0000-4000-8000-00000000000a',
   'cash', 300.00, '2024-03-01', 'Bar', 'Bargehalt', 'manual', 'a0000000-0000-4000-8000-000000000001'),
  ('9a1a0000-0000-4000-8000-0000000000e2', '5a1a0000-0000-4000-8000-0000000000e1', 'c0000000-0000-4000-8000-00000000000a',
   'bank', 100.00, '2024-03-01', 'Bank', 'Überweisung', 'manual', 'a0000000-0000-4000-8000-000000000001'),
  ('9a1a0000-0000-4000-8000-0000000000e3', '5a1a0000-0000-4000-8000-0000000000e1', 'c0000000-0000-4000-8000-00000000000a',
   'cash', 50.00, '2024-03-01', 'Bar zurück', 'Bargehalt', 'weekly_cash_difference', 'a0000000-0000-4000-8000-000000000001');

CREATE TEMP TABLE _ir_state (k text PRIMARY KEY, v text);
INSERT INTO _ir_state VALUES ('movements', (SELECT count(*)::text FROM cash_movements));

-- ─── 1. issuing, and the till ───────────────────────────────────────────────

DO $$
DECLARE
  admin_a uuid := 'a0000000-0000-4000-8000-000000000001';
  admin_b uuid := 'b0000000-0000-4000-8000-000000000001';
  p1 uuid := '9a1a0000-0000-4000-8000-0000000000e1';
  p2 uuid := '9a1a0000-0000-4000-8000-0000000000e2';
  p3 uuid := '9a1a0000-0000-4000-8000-0000000000e3';
  req1 uuid := 'e0000000-0000-4000-8000-000000000001';
  req2 uuid := 'e0000000-0000-4000-8000-000000000002';
  moves integer := (SELECT v::integer FROM _ir_state WHERE k = 'movements');
  r salary_cash_receipts;
  r_again salary_cash_receipts;
  n1 integer;
  payments_before integer := (SELECT count(*) FROM salary_payments);
BEGIN
  PERFORM _ir_as(admin_a);
  r := issue_salary_cash_receipt(req1, p1, ' Berlin ');
  RESET ROLE;

  PERFORM _ir_eq('number is GQ-<business year of the salary>-NNNN', r.receipt_number ~ '^GQ-2024-[0-9]{4,}$', true);
  PERFORM _ir_eq('marked as booking no cash', r.books_cash, false);
  PERFORM _ir_eq('no till movement id on the receipt', r.cash_movement_id IS NULL, true);
  PERFORM _ir_eq('names the payment it documents', r.salary_payment_id, p1);
  PERFORM _ir_eq('amount is the payment''s', r.amount, 300.00::numeric);
  PERFORM _ir_eq('date is the payment''s', r.payment_date, DATE '2024-03-01');
  PERFORM _ir_eq('place is trimmed', r.place, 'Berlin');
  PERFORM _ir_eq('before figures exclude this payment: bank', r.paid_bank_before, 100.00::numeric);
  PERFORM _ir_eq('before figures exclude this payment: weekly', r.paid_cash_weekly_before, 50.00::numeric);
  PERFORM _ir_eq('remaining before = due minus the other payments', r.remaining_before, 850.00::numeric);
  PERFORM _ir_eq('remaining after = due minus everything paid', r.remaining_after, 550.00::numeric);

  -- THE RULE: no till row, no new payment.
  PERFORM _ir_eq('the till ledger gained no row', (SELECT count(*) FROM cash_movements)::integer, moves);
  PERFORM _ir_eq('no payment was created', (SELECT count(*) FROM salary_payments)::integer, payments_before);

  -- A retry of the same request is the same receipt.
  PERFORM _ir_as(admin_a);
  r_again := issue_salary_cash_receipt(req1, p1, 'Berlin');
  RESET ROLE;
  PERFORM _ir_eq('a retry returns the first receipt', r_again.id, r.id);

  -- Refusals, in the function's own vocabulary.
  PERFORM _ir_eq('same request, another place: request_id_conflict',
    _ir_try(admin_a, _ir_issue_sql(req1, p1, 'Hamburg')), 'request_id_conflict');
  PERFORM _ir_eq('a second receipt for the same payment: already_issued',
    _ir_try(admin_a, _ir_issue_sql(req2, p1)), 'already_issued');
  PERFORM _ir_eq('a bank payment: payment_not_issuable',
    _ir_try(admin_a, _ir_issue_sql(gen_random_uuid(), p2)), 'payment_not_issuable');
  PERFORM _ir_eq('"Bar zurück": payment_not_issuable',
    _ir_try(admin_a, _ir_issue_sql(gen_random_uuid(), p3)), 'payment_not_issuable');
  PERFORM _ir_eq('another company''s payment: payment_not_found',
    _ir_try(admin_b, _ir_issue_sql(gen_random_uuid(), p1)), 'payment_not_found');
  PERFORM _ir_eq('a blank place: invalid_place',
    _ir_try(admin_a, _ir_issue_sql(gen_random_uuid(), p1, '  ')), 'invalid_place');
  PERFORM _ir_eq('anon cannot execute it',
    has_function_privilege('anon', 'public.issue_salary_cash_receipt(uuid,uuid,text)', 'EXECUTE'), false);

  PERFORM _ir_eq('refusals left the till alone', (SELECT count(*) FROM cash_movements)::integer, moves);

  -- The payment is locked while its receipt is live.
  PERFORM _ir_eq('editing the payment is refused',
    _ir_try(admin_a, format('UPDATE salary_payments SET amount = 301 WHERE id = %L', p1)) <> 'ok', true);
  PERFORM _ir_eq('deleting the payment is refused',
    _ir_try(admin_a, format('DELETE FROM salary_payments WHERE id = %L', p1)) <> 'ok', true);
  PERFORM _ir_eq('the payment is untouched', (SELECT amount FROM salary_payments WHERE id = p1), 300.00::numeric);

  -- ─── 2. void: the receipt only, never the payment and never the till ───
  PERFORM _ir_as(admin_a);
  r_again := void_salary_cash_receipt(r.id, 'Falscher Ort');
  RESET ROLE;
  PERFORM _ir_eq('voided', r_again.status, 'voided');
  PERFORM _ir_eq('void booked no cash back', r_again.void_cash_movement_id IS NULL, true);
  PERFORM _ir_eq('the payment is still there', (SELECT count(*) FROM salary_payments WHERE id = p1)::integer, 1);
  PERFORM _ir_eq('the till ledger is still untouched', (SELECT count(*) FROM cash_movements)::integer, moves);

  -- ─── 3. a new receipt for the freed payment, and the series stays gapless ───
  n1 := substring(r.receipt_number FROM '[0-9]+$')::integer;
  PERFORM _ir_as(admin_a);
  r_again := issue_salary_cash_receipt(req2, p1, 'Hamburg');
  RESET ROLE;
  PERFORM _ir_eq('the next number follows, the voided one is not reused',
    substring(r_again.receipt_number FROM '[0-9]+$')::integer, n1 + 1);
  PERFORM _ir_eq('still no till row', (SELECT count(*) FROM cash_movements)::integer, moves);
END $$;

ROLLBACK;
