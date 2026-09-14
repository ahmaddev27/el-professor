/*
  # Gehaltsquittung: the ledger underneath a cash salary receipt

  ## What was missing

  `salary_payments` records cash and bank payments against a salary, and
  `update_salary_payment_status` derives `payment_status` from them. Around
  that, nothing holds:

  - **Nothing refuses an overpayment.** SalaryDetailsModal inserts whatever
    amount it is handed.
  - **Two payments at the same moment both land, and the status is computed
    from a stale sum.** The trigger sums the payments it can see and then
    updates the salary row. A second insert in flight sums without seeing the
    first, waits on the row lock, and then overwrites `total_paid` with its own
    partial sum.
  - **Cash paid out never leaves the till.** Bargeldbestand does not learn of a
    salary paid in cash.

  ## Rules this migration encodes

  1. **payment_status comes from update_salary_payment_status alone.** Nothing
     here writes it; every payment insert and delete runs the trigger.
  2. **Confirming a cash payment is one transaction**: the receipt, its
     salary_payments row (`source_type = 'gehaltsquittung'`) and an outgoing
     cash_movements row. All three commit, or none do.
  3. **The weekly "Bar zurück" counts as paid but moves no cash.** A
     `weekly_cash_difference` payment is part of the paid total and of the
     receipt's snapshot, and never gets a cash_movements row.
  4. **Previewing and re-exporting write nothing.** Only confirm, void and
     attaching the signed copy write.
  5. **Money is exact.** numeric is decimal, not float, and an amount with more
     than two decimals is refused rather than rounded. The browser mirror,
     src/utils/salaryCashReceipt.ts, works in integer cents.
  6. **Due is COALESCE(netto_salary, amount_due, 0)**, the base the status
     trigger already uses, and the remaining balance is read here under lock —
     never taken from the client.
  7. **The receipt's month is get_business_month(period_start)**, which counts
     months from 1; JavaScript's getMonth() counts from 0.
  8. **A receipt is never edited or deleted, only voided.** Voiding removes its
     payment and books a compensating cash movement on the day of the void, as
     a cash book corrects an entry, rather than rewriting the day it was paid.
     The receipt stays, marked voided, and its number is never reused.
  9. **Receipt numbers are gapless per company and per year of the payment
     date**: GQ-2026-0001. The counter row is taken inside the confirming
     transaction, so a refused or rolled-back confirmation gives its number
     back.

  ## Not here, on purpose

  - **No new unique or exclusion constraint on salary periods.** salaries
    already has `unique_driver_period UNIQUE (driver_id, period_start)` (from
    20251012100000), but one driver can still hold rows whose periods overlap:
    a calendar month beside a business month, which staging's copy of
    production data contains. How to merge those is the owner's decision. Until
    then confirm refuses a salary whose period overlaps another row of the same
    driver rather than guess which one is the salary of record.
  - **Salaries are not created here.** The amount due is still computed in the
    browser (SalariesManagement), so an RPC that created the row would have to
    trust a client figure. The caller names an existing salary.
  - **The company is the caller's own** (get_user_company_id()). A platform
    account has none and is refused; reaching a company for support is the
    support-session work, which will swap the predicate.
  - The UI.
*/

-- ─── 1. Document numbers ────────────────────────────────────────────────────

CREATE TABLE public.document_counters (
  company_id uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  doc_type   text        NOT NULL CHECK (doc_type ~ '^[a-z_]+$'),
  year       integer     NOT NULL CHECK (year BETWEEN 2000 AND 2999),
  n          integer     NOT NULL CHECK (n > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, doc_type, year)
);

COMMENT ON TABLE public.document_counters IS
  'Gapless document numbers per company, type and year. Written only by next_document_number(), inside the transaction that issues the document.';

ALTER TABLE public.document_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_counters FROM anon, authenticated;

-- The row lock the upsert takes is what serialises numbering within a company
-- and year; the rollback of a failed confirmation takes the increment with it.
CREATE FUNCTION public.next_document_number(p_company_id uuid, p_doc_type text, p_year integer)
RETURNS integer
LANGUAGE sql
SET search_path = public, pg_catalog, pg_temp
AS $$
  INSERT INTO public.document_counters AS c (company_id, doc_type, year, n)
  VALUES (p_company_id, p_doc_type, p_year, 1)
  ON CONFLICT (company_id, doc_type, year)
  DO UPDATE SET n = c.n + 1, updated_at = now()
  RETURNING c.n;
$$;

REVOKE ALL ON FUNCTION public.next_document_number(uuid, text, integer) FROM PUBLIC, anon, authenticated;

-- ─── 2. Cash movements ──────────────────────────────────────────────────────
-- A ledger of cash entering and leaving the till, appended to by SECURITY
-- DEFINER functions only. The older cash_transactions table is left alone.
--
-- source_id carries no foreign key on purpose: the row is a record that cash
-- moved, and it must outlive its source. Deleting a driver cascades their
-- receipts away, but the cash those receipts paid out stays paid out.

CREATE TABLE public.cash_movements (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid          NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  direction     text          NOT NULL CHECK (direction IN ('in', 'out')),
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  movement_date date          NOT NULL,
  source_type   text          NOT NULL CHECK (source_type IN ('gehaltsquittung', 'gehaltsquittung_storno')),
  source_id     uuid          NOT NULL,
  description   text          NOT NULL DEFAULT '',
  created_by    uuid,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT cash_movements_source_unique UNIQUE (source_type, source_id)
);

COMMENT ON TABLE public.cash_movements IS
  'Append-only cash ledger. One row per source event; UNIQUE (source_type, source_id) makes a retried event a no-op rather than a second movement.';
COMMENT ON COLUMN public.cash_movements.created_by IS
  'auth.users id, kept without a foreign key so the ledger outlives a deleted account.';

CREATE INDEX cash_movements_company_date_idx ON public.cash_movements (company_id, movement_date);

ALTER TABLE public.cash_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_movements FROM anon, authenticated;
GRANT SELECT ON public.cash_movements TO authenticated;

CREATE POLICY "Company users can view cash_movements"
  ON public.cash_movements FOR SELECT TO authenticated
  USING (company_id = (SELECT get_user_company_id()));

-- ─── 3. Receipts ────────────────────────────────────────────────────────────

CREATE TABLE public.salary_cash_receipts (
  id                        uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid          NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  request_id                uuid          NOT NULL,
  receipt_number            text          NOT NULL CHECK (receipt_number ~ '^GQ-[0-9]{4}-[0-9]{4,}$'),
  -- RESTRICT: a salary with a receipt cannot be deleted on its own. Deleting
  -- the driver still works, because driver_id cascades the receipt away in the
  -- same statement before the restriction is checked.
  salary_id                 uuid          NOT NULL REFERENCES public.salaries(id) ON DELETE RESTRICT,
  driver_id                 uuid          NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  period_start              date          NOT NULL,
  period_end                date          NOT NULL,
  business_month            integer       NOT NULL CHECK (business_month BETWEEN 1 AND 12),
  business_year             integer       NOT NULL,
  amount                    numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_date              date          NOT NULL,
  place                     text          NOT NULL CHECK (btrim(place) <> ''),
  is_partial                boolean       NOT NULL,

  -- What the receipt printed, as the database saw it at confirmation.
  due_amount                numeric(14,2) NOT NULL CHECK (due_amount >= 0),
  paid_cash_manual_before   numeric(14,2) NOT NULL CHECK (paid_cash_manual_before >= 0),
  paid_cash_weekly_before   numeric(14,2) NOT NULL CHECK (paid_cash_weekly_before >= 0),
  paid_cash_receipts_before numeric(14,2) NOT NULL CHECK (paid_cash_receipts_before >= 0),
  paid_bank_before          numeric(14,2) NOT NULL CHECK (paid_bank_before >= 0),
  remaining_before          numeric(14,2) NOT NULL,
  remaining_after           numeric(14,2) NOT NULL CHECK (remaining_after >= 0),

  status                    text          NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'voided')),
  -- Plain ids, not foreign keys: a voided receipt keeps the id of the payment
  -- that was removed, as the record of what was reversed.
  salary_payment_id         uuid,
  cash_movement_id          uuid,
  void_cash_movement_id     uuid,
  signed_copy_path          text,
  confirmed_by              uuid,
  confirmed_at              timestamptz   NOT NULL DEFAULT now(),
  voided_by                 uuid,
  voided_at                 timestamptz,
  void_reason               text,

  CONSTRAINT salary_cash_receipts_request_unique UNIQUE (company_id, request_id),
  CONSTRAINT salary_cash_receipts_number_unique  UNIQUE (company_id, receipt_number),
  CONSTRAINT salary_cash_receipts_within_remaining CHECK (amount <= remaining_before),
  CONSTRAINT salary_cash_receipts_remaining_adds_up CHECK (remaining_after = remaining_before - amount),
  CONSTRAINT salary_cash_receipts_partial_matches  CHECK (is_partial = (remaining_after > 0)),
  CONSTRAINT salary_cash_receipts_void_consistent  CHECK ((status = 'voided') = (voided_at IS NOT NULL))
);

COMMENT ON TABLE public.salary_cash_receipts IS
  'Gehaltsquittung: one confirmed cash salary payment, with the figures it printed. Written only by confirm_salary_cash_payment, void_salary_cash_receipt and attach_salary_cash_receipt_signed_copy.';
COMMENT ON COLUMN public.salary_cash_receipts.business_month IS
  '1-12, from get_business_month(period_start). JavaScript getMonth() is 0-based.';
COMMENT ON COLUMN public.salary_cash_receipts.paid_cash_weekly_before IS
  'Weekly "Bar zurück" (salary_payments.source_type = weekly_cash_difference): paid, but never taken from the till.';

CREATE INDEX salary_cash_receipts_salary_idx       ON public.salary_cash_receipts (salary_id);
CREATE INDEX salary_cash_receipts_driver_idx       ON public.salary_cash_receipts (driver_id);
CREATE INDEX salary_cash_receipts_archive_idx      ON public.salary_cash_receipts (company_id, driver_id, business_year, business_month);
CREATE INDEX salary_cash_receipts_payment_idx      ON public.salary_cash_receipts (salary_payment_id) WHERE salary_payment_id IS NOT NULL;

ALTER TABLE public.salary_cash_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.salary_cash_receipts FROM anon, authenticated;
GRANT SELECT ON public.salary_cash_receipts TO authenticated;

CREATE POLICY "Company users can view salary_cash_receipts"
  ON public.salary_cash_receipts FOR SELECT TO authenticated
  USING (company_id = (SELECT get_user_company_id()));

-- ─── 4. The status trigger takes the salary row lock first ──────────────────
-- Unchanged except for the PERFORM at the top and pg_temp named last on the
-- search_path. Without the lock a concurrent insert sums the payments before
-- the first one commits and writes that stale total over the correct one. With
-- it, the second trigger waits here, and its SUM, a new statement and so a new
-- snapshot under READ COMMITTED, sees the first transaction's payment.
--
-- FOR NO KEY UPDATE, not FOR UPDATE. Inserting a payment first checks its
-- foreign key, which takes FOR KEY SHARE on the salary, and only then fires
-- this trigger. FOR UPDATE conflicts with a key share, so two inserts whose
-- checks both ran before either trigger would each wait for the other: a
-- deadlock, and one payment refused. FOR NO KEY UPDATE serialises the triggers
-- without conflicting with the checks. Every writer in this file takes the same
-- lock on the salary row.
--
-- Rule preserved: due is COALESCE(netto_salary, amount_due, 0); unpaid when
-- nothing is paid, paid when the payments reach due, partially_paid in between;
-- remaining never negative.

CREATE OR REPLACE FUNCTION public.update_salary_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  salary_total    decimal(10,2);
  payments_total  decimal(10,2);
  new_status      text;
  new_remaining   decimal(10,2);
BEGIN
  PERFORM 1
  FROM public.salaries
  WHERE id = COALESCE(NEW.salary_id, OLD.salary_id)
  FOR NO KEY UPDATE;

  SELECT COALESCE(netto_salary, amount_due, 0)
  INTO salary_total
  FROM public.salaries
  WHERE id = COALESCE(NEW.salary_id, OLD.salary_id);

  SELECT COALESCE(SUM(amount), 0)
  INTO payments_total
  FROM public.salary_payments
  WHERE salary_id = COALESCE(NEW.salary_id, OLD.salary_id);

  new_remaining := GREATEST(salary_total - payments_total, 0);

  IF payments_total = 0 THEN
    new_status := 'unpaid';
  ELSIF payments_total >= salary_total THEN
    new_status    := 'paid';
    new_remaining := 0;
  ELSE
    new_status := 'partially_paid';
  END IF;

  UPDATE public.salaries
  SET total_paid        = payments_total,
      remaining_balance = new_remaining,
      payment_status    = new_status
  WHERE id = COALESCE(NEW.salary_id, OLD.salary_id);

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ─── 5. A receipt's payment changes only through the receipt ────────────────
-- Without this, SalaryDetailsModal (or any client) could edit or delete the
-- payment behind a confirmed receipt, or insert one with no receipt at all, and
-- the receipt, the payment and the cash movement would disagree.
--
-- INSERT  of a gehaltsquittung payment must match a confirmed receipt that has
--         no payment yet. Only confirm_salary_cash_payment creates such a
--         receipt, inside its own uncommitted transaction.
-- UPDATE  touching a gehaltsquittung payment is refused.
-- DELETE  is refused while a confirmed receipt points at the payment. Void
--         marks the receipt voided first. A cascade from deleting the salary or
--         its driver fires this at trigger depth 2 and is let through: it takes
--         the receipt with it, and the salary's RESTRICT still guards a salary
--         deleted on its own.
--
-- SECURITY DEFINER so the check sees every receipt; a platform account passes
-- the payment policies but would see no receipts through RLS.

CREATE FUNCTION public.guard_salary_receipt_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_type IS DISTINCT FROM 'gehaltsquittung' THEN
      RETURN NEW;
    END IF;
    -- source_reference is text. Only a uuid-shaped one can name a receipt, and
    -- it is cast rather than the receipt id, so the lookup uses the primary key.
    IF NEW.payment_type = 'cash'
       AND NEW.source_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      IF EXISTS (
           SELECT 1
             FROM salary_cash_receipts r
            WHERE r.id = NEW.source_reference::uuid
              AND r.company_id = NEW.company_id
              AND r.salary_id = NEW.salary_id
              AND r.amount = NEW.amount
              AND r.status = 'confirmed'
              AND r.salary_payment_id IS NULL) THEN
        RETURN NEW;
      END IF;
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.source_type IS DISTINCT FROM 'gehaltsquittung'
       AND NEW.source_type IS DISTINCT FROM 'gehaltsquittung' THEN
      RETURN NEW;
    END IF;

  ELSE
    IF OLD.source_type IS DISTINCT FROM 'gehaltsquittung' OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    IF NOT EXISTS (
         SELECT 1 FROM salary_cash_receipts r
          WHERE r.salary_payment_id = OLD.id AND r.status = 'confirmed') THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'Zahlungen aus einer Gehaltsquittung werden nur über die Quittung geändert: stornieren und neu ausstellen.'
    USING ERRCODE = '42501', HINT = 'receipt_payment_locked';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_salary_receipt_payment() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER salary_payments_receipt_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.salary_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_salary_receipt_payment();

-- ─── 6. Confirm ─────────────────────────────────────────────────────────────
-- Errors carry a stable machine-readable reason in HINT, for the UI to map to
-- its own text; the German MESSAGE is a fallback.
--
--   42501 not_authorized        22023 invalid_request | invalid_amount
--   P0002 salary_not_found            invalid_payment_date | invalid_place
--   P0001 request_id_conflict | overlapping_salary | already_paid | overpayment
--
-- Lock order, the same in every writer: request id, then driver+period, then
-- the salary row (FOR NO KEY UPDATE, see section 4), then the company's counter
-- row. The row lock is what makes
-- paying an existing salary correct; the driver+period lock is the key a future
-- find-or-create path must share, since a row that does not exist yet cannot be
-- locked.

CREATE FUNCTION public.confirm_salary_cash_payment(
  p_request_id   uuid,
  p_salary_id    uuid,
  p_amount       numeric,
  p_payment_date date,
  p_place        text
)
RETURNS public.salary_cash_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  v_caller      uuid := auth.uid();
  v_company     uuid := get_user_company_id();
  v_today       date := (now() AT TIME ZONE 'Europe/Berlin')::date;
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
  v_payment_id  uuid;
  v_movement_id uuid;
BEGIN
  IF v_caller IS NULL OR v_company IS NULL OR NOT current_role_permits('salaries', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung, Gehaltszahlungen zu bestätigen.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_request_id IS NULL OR p_salary_id IS NULL THEN
    RAISE EXCEPTION 'Die Anfrage ist unvollständig.'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'Der Betrag muss größer als 0 sein und darf höchstens zwei Nachkommastellen haben.'
      USING ERRCODE = '22023', HINT = 'invalid_amount';
  END IF;
  IF p_payment_date IS NULL OR p_payment_date > v_today THEN
    RAISE EXCEPTION 'Das Zahlungsdatum fehlt oder liegt in der Zukunft.'
      USING ERRCODE = '22023', HINT = 'invalid_payment_date';
  END IF;
  IF p_place IS NULL OR btrim(p_place) = '' THEN
    RAISE EXCEPTION 'Bitte den Ort der Zahlung angeben.'
      USING ERRCODE = '22023', HINT = 'invalid_place';
  END IF;

  -- A retry of the same request waits for the first attempt to finish, even
  -- if it names a different salary, so it finds that attempt's receipt.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(format('gehaltsquittung-request:%s:%s', v_company, p_request_id), 0));

  SELECT * INTO v_salary FROM salaries WHERE id = p_salary_id;
  IF NOT FOUND OR v_salary.company_id IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'Gehalt nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'salary_not_found';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(format('salary-payment:%s:%s:%s', v_salary.driver_id, v_salary.period_start, v_salary.period_end), 0));

  SELECT * INTO v_salary FROM salaries WHERE id = p_salary_id FOR NO KEY UPDATE;
  IF NOT FOUND OR v_salary.company_id IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'Gehalt nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'salary_not_found';
  END IF;

  -- Idempotency comes before the balance check: a retry after success would
  -- otherwise be refused as already paid, and the client would never learn
  -- its receipt number. A retry must be the same payment in every printed
  -- field; anything else would hand back a receipt that says something else.
  SELECT * INTO v_receipt
    FROM salary_cash_receipts
   WHERE company_id = v_company AND request_id = p_request_id;
  IF FOUND THEN
    IF v_receipt.salary_id       IS DISTINCT FROM p_salary_id
       OR v_receipt.amount       IS DISTINCT FROM p_amount
       OR v_receipt.payment_date IS DISTINCT FROM p_payment_date
       OR v_receipt.place        IS DISTINCT FROM btrim(p_place) THEN
      RAISE EXCEPTION 'Diese Anfrage wurde bereits für eine andere Zahlung verwendet.'
        USING ERRCODE = 'P0001', HINT = 'request_id_conflict';
    END IF;
    RETURN v_receipt;
  END IF;

  -- unique_driver_period stops two rows starting on the same day, not a
  -- calendar month beside a business month. Which of those is the salary of
  -- record is the owner's call, so both are refused until it is made. Plain
  -- comparisons rather than daterange, which raises on a period that ends
  -- before it starts.
  IF EXISTS (
       SELECT 1 FROM salaries s
        WHERE s.driver_id    =  v_salary.driver_id
          AND s.id           <> v_salary.id
          AND s.period_start <= v_salary.period_end
          AND s.period_end   >= v_salary.period_start) THEN
    RAISE EXCEPTION 'Für diesen Fahrer gibt es einen weiteren Gehaltsdatensatz, dessen Zeitraum sich mit diesem überschneidet. Bitte zuerst bereinigen.'
      USING ERRCODE = 'P0001', HINT = 'overlapping_salary';
  END IF;

  -- payment_type is CHECKed to cash or bank, so every payment lands in exactly
  -- one bucket. src/utils/salaryCashReceipt.ts sums the same way.
  SELECT
    COALESCE(SUM(p.amount) FILTER (WHERE p.payment_type = 'bank'), 0),
    COALESCE(SUM(p.amount) FILTER (WHERE p.payment_type = 'cash' AND p.source_type = 'weekly_cash_difference'), 0),
    COALESCE(SUM(p.amount) FILTER (WHERE p.payment_type = 'cash' AND p.source_type = 'gehaltsquittung'), 0),
    COALESCE(SUM(p.amount) FILTER (WHERE p.payment_type = 'cash'
                                     AND p.source_type IS DISTINCT FROM 'weekly_cash_difference'
                                     AND p.source_type IS DISTINCT FROM 'gehaltsquittung'), 0)
  INTO v_bank, v_cash_weekly, v_cash_rcpt, v_cash_manual
  FROM salary_payments p
  WHERE p.salary_id = v_salary.id;

  v_due       := COALESCE(v_salary.netto_salary, v_salary.amount_due, 0);
  v_remaining := GREATEST(v_due - (v_bank + v_cash_weekly + v_cash_rcpt + v_cash_manual), 0);

  IF v_remaining = 0 THEN
    RAISE EXCEPTION 'Dieses Gehalt ist bereits vollständig bezahlt.'
      USING ERRCODE = 'P0001', HINT = 'already_paid';
  END IF;
  IF p_amount > v_remaining THEN
    RAISE EXCEPTION 'Der Betrag von % EUR übersteigt den offenen Restbetrag von % EUR.',
      replace(to_char(p_amount, 'FM9999999990.00'), '.', ','),
      replace(to_char(v_remaining, 'FM9999999990.00'), '.', ',')
      USING ERRCODE = 'P0001', HINT = 'overpayment';
  END IF;

  SELECT bm.month, bm.year INTO v_month, v_byear
    FROM get_business_month(v_salary.period_start) AS bm;

  v_year   := EXTRACT(year FROM p_payment_date)::integer;
  v_seq    := next_document_number(v_company, 'gehaltsquittung', v_year);
  v_number := format('GQ-%s-%s', v_year, lpad(v_seq::text, GREATEST(4, length(v_seq::text)), '0'));

  INSERT INTO salary_cash_receipts (
    company_id, request_id, receipt_number, salary_id, driver_id,
    period_start, period_end, business_month, business_year,
    amount, payment_date, place, is_partial,
    due_amount, paid_cash_manual_before, paid_cash_weekly_before, paid_cash_receipts_before,
    paid_bank_before, remaining_before, remaining_after,
    status, confirmed_by
  ) VALUES (
    v_company, p_request_id, v_number, v_salary.id, v_salary.driver_id,
    v_salary.period_start, v_salary.period_end, v_month, v_byear,
    p_amount, p_payment_date, btrim(p_place), (v_remaining - p_amount) > 0,
    v_due, v_cash_manual, v_cash_weekly, v_cash_rcpt,
    v_bank, v_remaining, v_remaining - p_amount,
    'confirmed', v_caller
  )
  RETURNING * INTO v_receipt;

  -- The status trigger runs on this insert and recomputes payment_status.
  INSERT INTO salary_payments (
    salary_id, company_id, payment_type, amount, payment_date,
    description, payment_category, source_type, source_reference, created_by
  ) VALUES (
    v_salary.id, v_company, 'cash', p_amount, p_payment_date,
    format('Gehaltsquittung %s', v_number), 'Bargehalt', 'gehaltsquittung', v_receipt.id::text, v_caller
  )
  RETURNING id INTO v_payment_id;

  INSERT INTO cash_movements (
    company_id, direction, amount, movement_date, source_type, source_id, description, created_by
  ) VALUES (
    v_company, 'out', p_amount, p_payment_date, 'gehaltsquittung', v_receipt.id,
    format('Gehaltsquittung %s', v_number), v_caller
  )
  RETURNING id INTO v_movement_id;

  UPDATE salary_cash_receipts
     SET salary_payment_id = v_payment_id,
         cash_movement_id  = v_movement_id
   WHERE id = v_receipt.id
  RETURNING * INTO v_receipt;

  RETURN v_receipt;
END;
$$;

COMMENT ON FUNCTION public.confirm_salary_cash_payment(uuid, uuid, numeric, date, text) IS
  'Confirms a cash salary payment: receipt, salary payment and outgoing cash movement in one transaction. Idempotent on p_request_id; refuses overpayment against the balance read under lock.';

REVOKE ALL ON FUNCTION public.confirm_salary_cash_payment(uuid, uuid, numeric, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_salary_cash_payment(uuid, uuid, numeric, date, text) TO authenticated;

-- ─── 7. Void ────────────────────────────────────────────────────────────────
--   42501 not_authorized   22023 invalid_request | invalid_reason
--   P0002 receipt_not_found
-- Voiding a voided receipt returns it unchanged: one reversal, the first reason.

CREATE FUNCTION public.void_salary_cash_receipt(p_receipt_id uuid, p_reason text)
RETURNS public.salary_cash_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  v_caller      uuid := auth.uid();
  v_company     uuid := get_user_company_id();
  v_today       date := (now() AT TIME ZONE 'Europe/Berlin')::date;
  v_receipt     public.salary_cash_receipts%ROWTYPE;
  v_salary      public.salaries%ROWTYPE;
  v_movement_id uuid;
BEGIN
  IF v_caller IS NULL OR v_company IS NULL OR NOT current_role_permits('salaries', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung, Gehaltsquittungen zu stornieren.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;
  IF p_receipt_id IS NULL THEN
    RAISE EXCEPTION 'Die Anfrage ist unvollständig.'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Bitte einen Grund für die Stornierung angeben.'
      USING ERRCODE = '22023', HINT = 'invalid_reason';
  END IF;

  SELECT * INTO v_receipt FROM salary_cash_receipts WHERE id = p_receipt_id;
  IF NOT FOUND OR v_receipt.company_id IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'Quittung nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'receipt_not_found';
  END IF;

  -- salary_id is ON DELETE RESTRICT, so while the receipt exists its salary
  -- does. Both are read again under lock: deleting the driver in the meantime
  -- takes them away together.
  SELECT * INTO v_salary FROM salaries WHERE id = v_receipt.salary_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quittung nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'receipt_not_found';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(format('salary-payment:%s:%s:%s', v_salary.driver_id, v_salary.period_start, v_salary.period_end), 0));
  PERFORM 1 FROM salaries WHERE id = v_receipt.salary_id FOR NO KEY UPDATE;

  SELECT * INTO v_receipt FROM salary_cash_receipts WHERE id = p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quittung nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'receipt_not_found';
  END IF;
  IF v_receipt.status = 'voided' THEN
    RETURN v_receipt;
  END IF;

  -- Voided first, so the payment guard lets the delete through.
  UPDATE salary_cash_receipts
     SET status      = 'voided',
         voided_at   = now(),
         voided_by   = v_caller,
         void_reason = btrim(p_reason)
   WHERE id = p_receipt_id;

  -- The status trigger runs on this delete and recomputes payment_status.
  DELETE FROM salary_payments WHERE id = v_receipt.salary_payment_id;

  INSERT INTO cash_movements (
    company_id, direction, amount, movement_date, source_type, source_id, description, created_by
  ) VALUES (
    v_company, 'in', v_receipt.amount, v_today, 'gehaltsquittung_storno', v_receipt.id,
    format('Storno Gehaltsquittung %s', v_receipt.receipt_number), v_caller
  )
  RETURNING id INTO v_movement_id;

  UPDATE salary_cash_receipts
     SET void_cash_movement_id = v_movement_id
   WHERE id = p_receipt_id
  RETURNING * INTO v_receipt;

  RETURN v_receipt;
END;
$$;

COMMENT ON FUNCTION public.void_salary_cash_receipt(uuid, text) IS
  'Voids a Gehaltsquittung: removes its payment, books the cash back on the day of the void, keeps the receipt and its number.';

REVOKE ALL ON FUNCTION public.void_salary_cash_receipt(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_salary_cash_receipt(uuid, text) TO authenticated;

-- ─── 8. Attach the signed copy ──────────────────────────────────────────────
--   42501 not_authorized   22023 invalid_request | invalid_path
--   P0002 receipt_not_found   P0001 receipt_voided
-- The path is the object name in the salary-receipts bucket and must sit
-- inside the caller's company folder, the same rule the bucket policies apply.

CREATE FUNCTION public.attach_salary_cash_receipt_signed_copy(p_receipt_id uuid, p_path text)
RETURNS public.salary_cash_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_company uuid := get_user_company_id();
  v_receipt public.salary_cash_receipts%ROWTYPE;
BEGIN
  IF v_caller IS NULL OR v_company IS NULL OR NOT current_role_permits('salaries', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung, Gehaltsquittungen zu ändern.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;
  IF p_receipt_id IS NULL THEN
    RAISE EXCEPTION 'Die Anfrage ist unvollständig.'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;
  IF p_path IS NULL
     OR length(p_path) > 512
     OR split_part(p_path, '/', 1) <> v_company::text
     OR p_path !~ '^[^/]+(/[A-Za-z0-9._-]+)+$'
     OR p_path ~ '(^|/)\.{1,2}(/|$)' THEN
    RAISE EXCEPTION 'Ungültiger Ablageort für die unterschriebene Quittung.'
      USING ERRCODE = '22023', HINT = 'invalid_path';
  END IF;

  SELECT * INTO v_receipt FROM salary_cash_receipts WHERE id = p_receipt_id FOR UPDATE;
  IF NOT FOUND OR v_receipt.company_id IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'Quittung nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'receipt_not_found';
  END IF;
  IF v_receipt.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Eine stornierte Quittung erhält keine unterschriebene Kopie.'
      USING ERRCODE = 'P0001', HINT = 'receipt_voided';
  END IF;

  UPDATE salary_cash_receipts
     SET signed_copy_path = p_path
   WHERE id = p_receipt_id
  RETURNING * INTO v_receipt;

  RETURN v_receipt;
END;
$$;

REVOKE ALL ON FUNCTION public.attach_salary_cash_receipt_signed_copy(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_salary_cash_receipt_signed_copy(uuid, text) TO authenticated;

-- ─── 9. Storage for signed copies ───────────────────────────────────────────
-- Private, PDF/JPEG/PNG up to 10 MB, path {company_id}/…, after
-- 20260621014603. Reading needs company membership; writing also needs edit
-- rights on salaries. There is no DELETE policy: a signed receipt is a record,
-- and a wrong upload is replaced, not removed.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('salary-receipts', 'salary-receipts', false, 10485760,
        ARRAY['application/pdf', 'image/jpeg', 'image/png'])
ON CONFLICT (id) DO UPDATE
  SET public             = false,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "salary_receipts_select" ON storage.objects;
DROP POLICY IF EXISTS "salary_receipts_insert" ON storage.objects;
DROP POLICY IF EXISTS "salary_receipts_update" ON storage.objects;

CREATE POLICY "salary_receipts_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'salary-receipts'
    AND (storage.foldername(name))[1] = (SELECT public.get_user_company_id())::text
  );

CREATE POLICY "salary_receipts_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'salary-receipts'
    AND (storage.foldername(name))[1] = (SELECT public.get_user_company_id())::text
    AND (SELECT public.current_role_permits('salaries', true))
  );

CREATE POLICY "salary_receipts_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'salary-receipts'
    AND (storage.foldername(name))[1] = (SELECT public.get_user_company_id())::text
    AND (SELECT public.current_role_permits('salaries', true))
  )
  WITH CHECK (
    bucket_id = 'salary-receipts'
    AND (storage.foldername(name))[1] = (SELECT public.get_user_company_id())::text
    AND (SELECT public.current_role_permits('salaries', true))
  );
