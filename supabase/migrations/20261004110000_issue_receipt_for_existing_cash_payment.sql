/*
  # A cash salary payment that already exists can be issued a Gehaltsquittung

  Owner decision, 04.10.2026. The cash-payment sheet (`SalaryPaymentCashView`)
  now prints and downloads, so it is handed to drivers; a printed copy was
  indistinguishable from a confirmed Gehaltsquittung except for having no
  number. If it is to be the receipt a company issues it needs a number of its
  own, from the same series. This is that: `issue_salary_cash_receipt`.

  ## The rule that matters, stated before anything else

  **Issuing a receipt for a payment that already exists books nothing into the
  till.** `confirm_salary_cash_payment` writes a till movement because it is
  creating the payment. This function documents a payment that is already there:
  the money left whenever it left, and booking it now would move the till
  retroactively. Measured on staging on 04.10.2026: 34 manual cash payments
  totalling 19.665,68 EUR, 33 of them 19.573,32 EUR in one company, and no till
  movement behind any of them. The cash ledger is
  `Bargeld - Belege - (Gehaltsquittungen - Stornos)` and it reads only the till
  ledger rows, so a receipt that writes none cannot lower the Bargeldbestand.
  Whether the till is in fact overstated by those payments is the owner's
  question and not something this slice answers.

  Three things hold that rule in place, so it is not one line of a function:

  1. **A marker on the receipt**: `salary_cash_receipts.books_cash`, NOT NULL,
     default true. Every receipt that exists today moved cash and keeps true;
     the new function writes false. A column and not "no movement id", because
     the absence of a link is also what a half-written row looks like, and the
     CHECK below ties the two together instead of inferring one from the other.
  2. **The function writes no till row, no payment and no counter but the
     receipt's own**; the self-check reads its body from the catalogue and fails
     the release if it names the till ledger table or writes a salary payment.
  3. **Void knows the difference.** `void_salary_cash_receipt` deleted the
     payment and booked the amount back into the till. For a receipt with
     `books_cash = false` that would delete a real payment and ADD cash that never
     left; it now marks the receipt voided and stops. The payment stays, the till
     is untouched, and the number is never reused.

  ## What it does, in the order it refuses

  `issue_salary_cash_receipt(p_request_id, p_payment_id, p_place)`:

      42501 platform_session_not_allowed  a platform context, in either mode:
                                          before any argument is read, any lock
                                          taken or any number drawn
      42501 not_authorized                no session, no active company, or no
                                          edit right on `salaries`
      22023 invalid_request               a missing argument
      22023 invalid_place                 a blank place
      P0002 payment_not_found             no such payment in the caller's company
      P0001 request_id_conflict           the request id was used for another
                                          payment or place (a retry returns the
                                          first receipt unchanged)
      P0001 overlapping_salary            another salary of the driver overlaps
      P0001 payment_not_issuable          not a manual cash payment (a bank
                                          payment, "Bar zurueck", or one written
                                          by a Gehaltsquittung already)
      P0001 already_issued                a confirmed receipt already exists for
                                          this payment
      P0001 overpayment                   the salary's payments exceed what is due

  The number is `GQ-YYYY-NNNN` from the same counter as confirm
  (`next_document_number(company, 'gehaltsquittung', year)`), `YYYY` the business
  year of the salary (20260919160000). It is drawn after every refusal above and
  inside the transaction that inserts the receipt, so a refused or rolled-back
  issue gives its number back and the series stays gapless.

  The company is `get_active_company_id()`, never the profile's company. The role
  gate is `current_role_permits('salaries', true)`, as for the other three.

  ## Lock order

  request id, then the payment row (FOR NO KEY UPDATE), then the driver and
  period key, then the salary row (FOR NO KEY UPDATE), then the counter row. The
  payment comes before the salary because every other writer of a payment row
  (edit, delete) holds the payment row and then reaches the salary through the
  status trigger; taking them the other way round is a deadlock. The salary lock
  is FOR NO KEY UPDATE and never FOR UPDATE, for the reason in 20260914140000
  section 4. Locking the payment also means a concurrent delete either finishes
  first (the payment is then not found) or waits for this transaction.

  ## What the receipt's figures mean when the payment is old

  The "before" figures are everything paid on the salary EXCEPT this payment,
  bucketed as in confirm; the remaining balance after is `due - total paid`.
  So two payments of one salary, each issued a receipt, each read as "the rest
  was paid elsewhere", and both say the same remaining balance. The existing
  CHECK constraints on the table hold unchanged.

  ## A payment with a live receipt is locked

  A second trigger on `salary_payments` refuses an UPDATE or DELETE of a payment
  that a confirmed `books_cash = false` receipt points at (`receipt_payment_locked`),
  the same refusal and reason the Gehaltsquittung guard gives. It is a trigger of
  its own and the existing guard is not restated: restating a payroll function
  by hand is how clauses go missing here. Voiding the receipt frees the payment.

  ## Backward compatibility

  Additive: one column with a default, one function, one trigger, one index, and
  an early return in void for rows the previous release cannot produce.
  No SCHEMA_EPOCH bump. Nothing is renumbered and no existing row changes.
*/

-- ─── 1. The marker ──────────────────────────────────────────────────────────

ALTER TABLE public.salary_cash_receipts
  ADD COLUMN books_cash boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.salary_cash_receipts.books_cash IS
  'true: the receipt created its payment and booked the cash out of the till (confirm_salary_cash_payment). false: it documents a payment that already existed (issue_salary_cash_receipt) and booked nothing; voiding it deletes no payment and books no cash back.';

-- A receipt that books nothing carries no till movement, and it names the
-- payment it documents.
ALTER TABLE public.salary_cash_receipts
  ADD CONSTRAINT salary_cash_receipts_books_cash_consistent
  CHECK (books_cash
         OR (cash_movement_id IS NULL
             AND void_cash_movement_id IS NULL
             AND salary_payment_id IS NOT NULL));

-- One live receipt per payment. A voided one frees the payment for a new receipt.
CREATE UNIQUE INDEX salary_cash_receipts_live_payment_uidx
  ON public.salary_cash_receipts (salary_payment_id)
  WHERE status = 'confirmed' AND salary_payment_id IS NOT NULL;

-- ─── 2. Issue ───────────────────────────────────────────────────────────────

CREATE FUNCTION public.issue_salary_cash_receipt(
  p_request_id uuid,
  p_payment_id uuid,
  p_place      text
)
RETURNS public.salary_cash_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  v_caller      uuid := auth.uid();
  v_company     uuid := get_active_company_id();
  v_payment     public.salary_payments%ROWTYPE;
  v_salary      public.salaries%ROWTYPE;
  v_receipt     public.salary_cash_receipts%ROWTYPE;
  v_due         numeric;
  v_bank        numeric;
  v_cash_weekly numeric;
  v_cash_rcpt   numeric;
  v_cash_manual numeric;
  v_remaining   numeric;
  v_month       integer;
  v_byear       integer;
  v_year        integer;
  v_seq         integer;
  v_number      text;
BEGIN
  -- A platform account inside a context: a company and no membership. Refused
  -- before anything is read, locked or numbered (owner decision 18.09.2026).
  IF v_company IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.user_profiles up
                      WHERE up.user_id = v_caller AND up.company_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Gehaltsquittungen werden nur im eigenen Unternehmen ausgestellt, storniert und unterschrieben — nie aus einer Plattform-Sitzung heraus.'
      USING ERRCODE = '42501', HINT = 'platform_session_not_allowed';
  END IF;

  IF v_caller IS NULL OR v_company IS NULL OR NOT current_role_permits('salaries', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung, Gehaltsquittungen auszustellen.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_request_id IS NULL OR p_payment_id IS NULL THEN
    RAISE EXCEPTION 'Die Anfrage ist unvollständig.'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;
  IF p_place IS NULL OR btrim(p_place) = '' THEN
    RAISE EXCEPTION 'Bitte den Ort der Zahlung angeben.'
      USING ERRCODE = '22023', HINT = 'invalid_place';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(format('gehaltsquittung-request:%s:%s', v_company, p_request_id), 0));

  -- The payment first, then the salary: see the lock order in the header.
  SELECT * INTO v_payment FROM salary_payments WHERE id = p_payment_id FOR NO KEY UPDATE;
  IF NOT FOUND OR v_payment.company_id IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'Zahlung nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'payment_not_found';
  END IF;

  SELECT * INTO v_salary FROM salaries WHERE id = v_payment.salary_id;
  IF NOT FOUND OR v_salary.company_id IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'Zahlung nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'payment_not_found';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(format('salary-payment:%s:%s:%s', v_salary.driver_id, v_salary.period_start, v_salary.period_end), 0));

  SELECT * INTO v_salary FROM salaries WHERE id = v_payment.salary_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zahlung nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'payment_not_found';
  END IF;

  -- Idempotency before the other checks: a retry after success would otherwise
  -- be refused as already issued and never learn its number.
  SELECT * INTO v_receipt
    FROM salary_cash_receipts
   WHERE company_id = v_company AND request_id = p_request_id;
  IF FOUND THEN
    IF v_receipt.salary_payment_id IS DISTINCT FROM p_payment_id
       OR v_receipt.books_cash
       OR v_receipt.place IS DISTINCT FROM btrim(p_place) THEN
      RAISE EXCEPTION 'Diese Anfrage wurde bereits für eine andere Zahlung verwendet.'
        USING ERRCODE = 'P0001', HINT = 'request_id_conflict';
    END IF;
    RETURN v_receipt;
  END IF;

  IF EXISTS (
       SELECT 1 FROM salaries s
        WHERE s.driver_id    =  v_salary.driver_id
          AND s.id           <> v_salary.id
          AND s.period_start <= v_salary.period_end
          AND s.period_end   >= v_salary.period_start) THEN
    RAISE EXCEPTION 'Für diesen Fahrer gibt es einen weiteren Gehaltsdatensatz, dessen Zeitraum sich mit diesem überschneidet. Bitte zuerst bereinigen.'
      USING ERRCODE = 'P0001', HINT = 'overlapping_salary';
  END IF;

  -- Only a manual cash payment is a handover a receipt can describe.
  IF v_payment.payment_type IS DISTINCT FROM 'cash'
     OR v_payment.source_type IS NOT DISTINCT FROM 'weekly_cash_difference'
     OR v_payment.source_type IS NOT DISTINCT FROM 'gehaltsquittung'
     OR v_payment.amount IS NULL
     OR v_payment.amount <= 0
     OR v_payment.amount <> round(v_payment.amount, 2) THEN
    RAISE EXCEPTION 'Für diese Zahlung kann keine Gehaltsquittung ausgestellt werden.'
      USING ERRCODE = 'P0001', HINT = 'payment_not_issuable';
  END IF;

  IF EXISTS (SELECT 1 FROM salary_cash_receipts r
              WHERE r.salary_payment_id = v_payment.id AND r.status = 'confirmed') THEN
    RAISE EXCEPTION 'Für diese Zahlung wurde bereits eine Gehaltsquittung ausgestellt.'
      USING ERRCODE = 'P0001', HINT = 'already_issued';
  END IF;

  -- Everything paid on the salary except this payment, in confirm's buckets.
  SELECT
    COALESCE(SUM(p.amount) FILTER (WHERE p.payment_type = 'bank'), 0),
    COALESCE(SUM(p.amount) FILTER (WHERE p.payment_type = 'cash' AND p.source_type = 'weekly_cash_difference'), 0),
    COALESCE(SUM(p.amount) FILTER (WHERE p.payment_type = 'cash' AND p.source_type = 'gehaltsquittung'), 0),
    COALESCE(SUM(p.amount) FILTER (WHERE p.payment_type = 'cash'
                                     AND p.source_type IS DISTINCT FROM 'weekly_cash_difference'
                                     AND p.source_type IS DISTINCT FROM 'gehaltsquittung'), 0)
  INTO v_bank, v_cash_weekly, v_cash_rcpt, v_cash_manual
  FROM salary_payments p
  WHERE p.salary_id = v_salary.id
    AND p.id <> v_payment.id;

  v_due       := COALESCE(v_salary.netto_salary, v_salary.amount_due, 0);
  v_remaining := v_due - (v_bank + v_cash_weekly + v_cash_rcpt + v_cash_manual);

  -- The table's own CHECKs would refuse this with a constraint name; say why.
  IF v_payment.amount > v_remaining THEN
    RAISE EXCEPTION 'Die Zahlungen zu diesem Gehalt übersteigen den fälligen Betrag.'
      USING ERRCODE = 'P0001', HINT = 'overpayment';
  END IF;

  SELECT bm.month, bm.year INTO v_month, v_byear
    FROM get_business_month(v_salary.period_start) AS bm;

  v_year   := v_byear;
  v_seq    := next_document_number(v_company, 'gehaltsquittung', v_year);
  v_number := format('GQ-%s-%s', v_year, lpad(v_seq::text, GREATEST(4, length(v_seq::text)), '0'));

  INSERT INTO salary_cash_receipts (
    company_id, request_id, receipt_number, salary_id, driver_id,
    period_start, period_end, business_month, business_year,
    amount, payment_date, place, is_partial,
    due_amount, paid_cash_manual_before, paid_cash_weekly_before, paid_cash_receipts_before,
    paid_bank_before, remaining_before, remaining_after,
    status, confirmed_by, salary_payment_id, books_cash
  ) VALUES (
    v_company, p_request_id, v_number, v_salary.id, v_salary.driver_id,
    v_salary.period_start, v_salary.period_end, v_month, v_byear,
    v_payment.amount, v_payment.payment_date, btrim(p_place), (v_remaining - v_payment.amount) > 0,
    v_due, v_cash_manual, v_cash_weekly, v_cash_rcpt,
    v_bank, v_remaining, v_remaining - v_payment.amount,
    'confirmed', v_caller, v_payment.id, false
  )
  RETURNING * INTO v_receipt;

  RETURN v_receipt;
END;
$$;

COMMENT ON FUNCTION public.issue_salary_cash_receipt(uuid, uuid, text) IS
  'Issues a numbered Gehaltsquittung (GQ-YYYY-NNNN, same series as confirm) for a manual cash salary payment that already exists. Writes the receipt only: no payment, and nothing in the till ledger. Idempotent on p_request_id.';

REVOKE ALL ON FUNCTION public.issue_salary_cash_receipt(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_salary_cash_receipt(uuid, uuid, text) TO authenticated;

-- ─── 3. A payment with a live issued receipt is locked ──────────────────────

CREATE FUNCTION public.guard_issued_receipt_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  -- A cascade from deleting the driver takes the receipt with it (depth 2).
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM salary_cash_receipts r
              WHERE r.salary_payment_id = OLD.id
                AND r.status = 'confirmed'
                AND NOT r.books_cash) THEN
    RAISE EXCEPTION 'Zu dieser Zahlung gibt es eine Gehaltsquittung: zuerst die Quittung stornieren.'
      USING ERRCODE = '42501', HINT = 'receipt_payment_locked';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_issued_receipt_payment() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER salary_payments_issued_receipt_guard
  BEFORE UPDATE OR DELETE ON public.salary_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_issued_receipt_payment();

-- ─── 4. Void knows a receipt that booked nothing ────────────────────────────
-- Rewritten from the catalogue, not retyped, as 20260919160000 and 20260921110010
-- did for the same functions: the live body is the only authority on what it
-- does. The statement that deletes the payment must match exactly once or the
-- migration fails without changing anything. CREATE OR REPLACE through EXECUTE
-- keeps the owner, the pinned search_path and the ACL.

DO $mig$
DECLARE
  v_sig     constant text := 'public.void_salary_cash_receipt(uuid, text)';
  v_pattern constant text :=
    'DELETE\s+FROM\s+salary_payments\s+WHERE\s+id\s*=\s*v_receipt\.salary_payment_id\s*;';
  v_block   constant text :=
       '-- 20261004100000: a receipt issued for an existing payment booked nothing, so' || chr(10)
    || '  -- voiding it deletes no payment and books no cash back; only the receipt is voided.' || chr(10)
    || '  IF NOT v_receipt.books_cash THEN' || chr(10)
    || '    SELECT * INTO v_receipt FROM salary_cash_receipts WHERE id = p_receipt_id;' || chr(10)
    || '    RETURN v_receipt;' || chr(10)
    || '  END IF;' || chr(10)
    || chr(10)
    || '  ';
  v_def     text;
  v_new     text;
  v_hits    integer;
BEGIN
  IF to_regprocedure(v_sig) IS NULL THEN
    RAISE EXCEPTION 'issue receipt: % does not exist', v_sig;
  END IF;
  v_def := pg_get_functiondef(to_regprocedure(v_sig));
  IF v_def ~ 'books_cash' THEN
    RAISE EXCEPTION 'issue receipt: % already knows books_cash — read its body before running this again', v_sig;
  END IF;

  SELECT count(*) INTO v_hits FROM regexp_matches(v_def, v_pattern, 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'issue receipt: % deletes the payment % times in a way this migration recognises, expected exactly 1', v_sig, v_hits;
  END IF;

  v_new := regexp_replace(v_def, '(' || v_pattern || ')', v_block || '\1');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'issue receipt: the rewrite of % changed nothing', v_sig;
  END IF;
  EXECUTE v_new;
END $mig$;

-- ─── 5. Self-check: fail the release if its own rules are lost ──────────────

DO $check$
DECLARE
  v_issue constant text := 'public.issue_salary_cash_receipt(uuid, uuid, text)';
  v_src   text;
  v_void  text;
  v_need  text;
BEGIN
  -- 1. The marker: every existing receipt booked cash, the column cannot be NULL.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'salary_cash_receipts'
                    AND column_name = 'books_cash' AND is_nullable = 'NO'
                    AND column_default = 'true') THEN
    RAISE EXCEPTION 'issue receipt self-check 1: books_cash is missing, nullable, or does not default to true';
  END IF;
  IF EXISTS (SELECT 1 FROM public.salary_cash_receipts WHERE NOT books_cash AND cash_movement_id IS NOT NULL) THEN
    RAISE EXCEPTION 'issue receipt self-check 1: a receipt that books nothing points at a till movement';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.salary_cash_receipts'::regclass
                    AND conname = 'salary_cash_receipts_books_cash_consistent') THEN
    RAISE EXCEPTION 'issue receipt self-check 1: the books_cash CHECK is missing';
  END IF;

  -- 2. The function: DEFINER, pinned, authenticated only.
  IF to_regprocedure(v_issue) IS NULL THEN
    RAISE EXCEPTION 'issue receipt self-check 2: issue_salary_cash_receipt does not exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(v_issue)
                    AND p.prosecdef AND p.proconfig IS NOT NULL
                    AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c(s) WHERE c.s LIKE 'search\_path=%')) THEN
    RAISE EXCEPTION 'issue receipt self-check 2: issue_salary_cash_receipt lost SECURITY DEFINER or its pinned search_path';
  END IF;
  IF has_function_privilege('anon', v_issue, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_issue, 'EXECUTE') THEN
    RAISE EXCEPTION 'issue receipt self-check 2: the EXECUTE grants moved';
  END IF;

  v_src := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(v_issue));

  -- 3. THE RULE: it writes nothing but the receipt. No till ledger, no payment.
  IF v_src ~* 'cash_movements' THEN
    RAISE EXCEPTION 'issue receipt self-check 3: issue_salary_cash_receipt names the till ledger — issuing for an existing payment must book no cash';
  END IF;
  IF v_src ~* '(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.)?salary_payments' THEN
    RAISE EXCEPTION 'issue receipt self-check 3: issue_salary_cash_receipt writes a salary payment';
  END IF;
  IF v_src !~ 'v_payment\.id\s*,\s*false' THEN
    RAISE EXCEPTION 'issue receipt self-check 3: the receipt is no longer written with books_cash = false';
  END IF;

  -- 4. The gates and the refusal order: platform refusal first, then the role.
  IF (SELECT count(*) FROM regexp_matches(v_src, 'platform_session_not_allowed', 'g')) <> 1
     OR strpos(v_src, 'platform_session_not_allowed') > strpos(v_src, 'not_authorized') THEN
    RAISE EXCEPTION 'issue receipt self-check 4: the platform refusal is missing, repeated, or comes after the authorization check';
  END IF;
  IF strpos(v_src, 'platform_session_not_allowed') > strpos(v_src, 'pg_advisory_xact_lock')
     OR strpos(v_src, 'platform_session_not_allowed') > strpos(v_src, 'next_document_number') THEN
    RAISE EXCEPTION 'issue receipt self-check 4: something is locked or numbered before the platform refusal';
  END IF;
  IF v_src !~ 'get_active_company_id' OR v_src ~ 'get_user_company_id' THEN
    RAISE EXCEPTION 'issue receipt self-check 4: the company must come from get_active_company_id()';
  END IF;
  IF v_src !~ 'current_role_permits\s*\(\s*''salaries''\s*,\s*true\s*\)' THEN
    RAISE EXCEPTION 'issue receipt self-check 4: the salaries role gate is missing';
  END IF;

  -- 5. Locks: NO KEY UPDATE, never FOR UPDATE; the payment before the salary.
  IF v_src ~ 'FOR\s+UPDATE' OR v_src !~ 'FOR NO KEY UPDATE' THEN
    RAISE EXCEPTION 'issue receipt self-check 5: a row lock is not FOR NO KEY UPDATE';
  END IF;
  IF strpos(v_src, 'FROM salary_payments WHERE id = p_payment_id FOR NO KEY UPDATE') = 0
     OR strpos(v_src, 'FROM salary_payments WHERE id = p_payment_id FOR NO KEY UPDATE')
        > strpos(v_src, 'FROM salaries WHERE id = v_payment.salary_id FOR NO KEY UPDATE') THEN
    RAISE EXCEPTION 'issue receipt self-check 5: the payment row is no longer locked before the salary row';
  END IF;

  -- 6. The refusals and the number.
  FOREACH v_need IN ARRAY ARRAY[
    'request_id_conflict', 'overlapping_salary', 'payment_not_issuable', 'already_issued',
    'overpayment', 'payment_not_found', 'invalid_place', 'invalid_request'
  ] LOOP
    IF v_src !~ v_need THEN
      RAISE EXCEPTION 'issue receipt self-check 6: a refusal is missing (%)', v_need;
    END IF;
  END LOOP;
  IF v_src !~ 'v_year\s*:=\s*v_byear\s*;'
     OR v_src !~ 'next_document_number\s*\(\s*v_company\s*,\s*''gehaltsquittung''\s*,\s*v_year\s*\)'
     OR v_src !~ 'v_number\s*:=\s*format\s*\(\s*''GQ-%s-%s''\s*,\s*v_year\s*,'
     OR v_src ~ 'v_year\s*:=[^;]*payment_date' THEN
    RAISE EXCEPTION 'issue receipt self-check 6: the number no longer comes from the same counter and the business year of the salary';
  END IF;

  -- 7. Void: a receipt that booked nothing deletes no payment and books no cash.
  v_void := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.void_salary_cash_receipt(uuid, text)'));
  IF v_void !~ 'books_cash'
     OR strpos(v_void, 'books_cash') > strpos(v_void, 'DELETE FROM salary_payments')
     OR v_void !~ 'gehaltsquittung_storno'
     OR v_void !~ 'platform_session_not_allowed'
     OR v_void !~ 'get_active_company_id' THEN
    RAISE EXCEPTION 'issue receipt self-check 7: void_salary_cash_receipt lost the books_cash branch or one of its earlier rules';
  END IF;

  -- 8. The payment lock exists, and the original guard is still there beside it.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.salary_payments'::regclass
                    AND tgname = 'salary_payments_issued_receipt_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'issue receipt self-check 8: the payment guard trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.salary_payments'::regclass
                    AND tgname = 'salary_payments_receipt_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'issue receipt self-check 8: the original Gehaltsquittung payment guard is gone';
  END IF;

  -- 9. The client roles still cannot write the receipt table.
  IF has_table_privilege('authenticated', 'public.salary_cash_receipts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.salary_cash_receipts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.salary_cash_receipts', 'DELETE') THEN
    RAISE EXCEPTION 'issue receipt self-check 9: a client role can write salary_cash_receipts directly';
  END IF;

  RAISE NOTICE 'issue receipt: self-check passed — issuing writes a numbered receipt and nothing in the till';
END
$check$;
