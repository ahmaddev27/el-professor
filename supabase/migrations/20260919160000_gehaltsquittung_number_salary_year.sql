/*
  # A Gehaltsquittung's number carries the year of the salary, not of the payment

  Owner decision, 17.09.2026. It answers the open question HANDOFF.md recorded
  under *Receipt*: "Receipt numbers are GQ-YYYY-NNNN, using the year of the
  payment date, gapless per company. Keep that, or use the salary's business
  year?"

  ## Which year is "the salary's year"

  `get_business_month(v_salary.period_start)` — the value the receipt already
  stores as `business_month` / `business_year`, and nothing new.

  The product has two month conventions, and the business month is the one it
  uses everywhere: a week belongs to the month containing its Monday
  (`get_business_month()` here, `utils/weekCalculations.ts` in the browser, the
  `abrechnung_weekly` view, the Stundennachweis, the Monatsplanung). A salary
  period of 29.12.2025–25.01.2026 is ambiguous on its face; it is not ambiguous
  to this product, which reads it as the business month of its start.

  Rule 7 of 20260914140000 already says so — "The receipt's month is
  get_business_month(period_start)" — and section 6 of that file computes
  `v_month, v_byear` from it two statements before the number is built, stamps
  them onto the receipt, and indexes the archive on
  `(company_id, driver_id, business_year, business_month)`. So the salary's year
  was already on the row under that name; the number simply did not use it.

  Taking `period_start`'s **calendar** year instead would have introduced a
  second month convention for one field, and it would disagree with the
  `business_year` printed beside it on the same row whenever a period starts in
  a week that began in the previous year — a January period whose Monday fell in
  December. One value, one name, one rule: the number's year and
  `business_year` are now the same integer by construction, and the self-check
  below and `tests/rls/salary-cash.sql` both assert it.

  ## What changes

  One assignment in `confirm_salary_cash_payment`:

      v_year := EXTRACT(year FROM p_payment_date)::integer;
   -> v_year := v_byear;

  `v_byear` is assigned from `get_business_month(v_salary.period_start)` two
  statements above, so nothing moves and no new value is computed. `v_year` then
  keys the counter (`next_document_number(v_company, 'gehaltsquittung', v_year)`)
  and is printed into `GQ-%s-%s` exactly as before.

  **The body is rewritten from the catalogue, not retyped.** 20260917130000 set
  that precedent for these three functions for a reason: the live definition is
  the only authority on what they do, and transcribing a payroll function by
  hand is how a clause goes missing. The regexp must match exactly once or the
  migration fails without changing anything. `CREATE OR REPLACE` keeps the
  owner, the pinned `search_path`, `SECURITY DEFINER` and the ACL
  (`REVOKE … FROM PUBLIC, anon; GRANT EXECUTE … TO authenticated`), so none of
  those is restated here and none of them can drift. The owner is deliberately
  **not** moved to `CURRENT_USER`: on the live databases these functions belong
  to `postgres`, 20260917130000 chose a grant over an ownership change for
  exactly these three, and this migration adds no call to anything `postgres`
  cannot already reach.

  ## What the counter's uniqueness means now

  - `document_counters` is unchanged: `PRIMARY KEY (company_id, doc_type, year)`,
    one row per company, document type and year, incremented under its own row
    lock inside the confirming transaction. Only the integer handed to `year`
    changes meaning, from the payment year to the salary's business year.
  - Numbers stay **gapless per company and per the year that keys them**. A
    refused or rolled-back confirmation still gives its number back, because the
    increment lives in the same transaction.
  - `salary_cash_receipts_number_unique UNIQUE (company_id, receipt_number)` and
    the `^GQ-[0-9]{4}-[0-9]{4,}$` CHECK need no change: the year is inside the
    number, so `(company, GQ-YYYY-NNNN)` is as unique as it was.
  - Two receipts issued on the same day for salaries of different years now draw
    from different counters. That is the point of the decision.
  - Two consequences the owner accepted, named here so they are not discovered
    later: within a company the numbers are **no longer issued in the
    chronological order of the payments** (a December-2025 salary paid in March
    2026 takes a `GQ-2025-…` after `GQ-2026-…` were already issued), and **a
    closed year can be reopened** — a late payment for an old salary appends to
    that old year's sequence, still gaplessly.

  ## Receipts already issued

  **Nothing is renumbered.** No UPDATE, no backfill, no counter is touched.
  Every receipt confirmed before this migration keeps the number it printed and
  the customer holds on paper; a Gehaltsquittung is a ledger document, and
  rewriting one that has been handed over and signed is not a correction.

  The two conventions therefore coexist in the history: a receipt from before
  this release carries the year of its payment, one from after it the business
  year of its salary. They differ only where the two years differ — a salary
  paid in a year other than the one it belongs to — and are indistinguishable
  otherwise. `business_year` on the row is the value that is right either way,
  and is what a report should group by.

  Nothing reads `GQ-YYYY` back and expects the payment year: the browser never
  predicts a number (`salaryCashReceiptDocument.ts` prints
  "Nr. wird bei der Bestätigung vergeben" until the database answers), and no
  export, list or filter parses the year out of it. `signedCopyPath()` files an
  uploaded signed copy under `{company}/{payment year}/{number}_…`, which is a
  storage folder and not a number; after this change a `GQ-2025-…` copy may sit
  in a `2026/` folder. That is left alone on purpose — moving it would change
  where uploads land for a cosmetic gain, and existing `signed_copy_path` values
  are absolute.

  ## Compatibility

  Backward compatible; **no SCHEMA_EPOCH bump**. Rollback leaves this function
  in place, and the previous release copes: it reads `receipt_number` as an
  opaque string, predicts no number, and reads no year out of one.
*/

-- ─── 1. The one assignment ──────────────────────────────────────────────────

DO $mig$
DECLARE
  v_sig     constant text := 'public.confirm_salary_cash_payment(uuid, uuid, numeric, date, text)';
  -- The assignment as section 6 of 20260914140000 wrote it, and nowhere else in
  -- the body does v_year get a value.
  v_pattern constant text :=
    'v_year\s*:=\s*EXTRACT\s*\(\s*year\s+FROM\s+p_payment_date\s*\)\s*::\s*integer\s*;';
  v_def     text;
  v_new     text;
  v_hits    integer;
BEGIN
  IF to_regprocedure(v_sig) IS NULL THEN
    RAISE EXCEPTION 'GQ year: % does not exist', v_sig;
  END IF;

  v_def := pg_get_functiondef(to_regprocedure(v_sig));

  SELECT count(*) INTO v_hits FROM regexp_matches(v_def, v_pattern, 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'GQ year: % takes its receipt year % times in a way this migration recognises, expected exactly 1 — read its body before changing this',
      v_sig, v_hits;
  END IF;

  v_new := regexp_replace(v_def, v_pattern,
    'v_year   := v_byear;  -- 20260919160000: the business year of the salary, not of the payment');

  -- Belt and braces: after the rewrite nothing in the body may still derive a
  -- year from the payment date.
  IF v_new ~ 'v_year\s*:=[^;]*p_payment_date' THEN
    RAISE EXCEPTION 'GQ year: % still reads the payment date for its number — read its body before changing this', v_sig;
  END IF;

  EXECUTE v_new;
  RAISE NOTICE 'GQ year: % now numbers by the business year of the salary', v_sig;
END $mig$;

COMMENT ON FUNCTION public.confirm_salary_cash_payment(uuid, uuid, numeric, date, text) IS
  'Confirms a cash salary payment: receipt, salary payment and outgoing cash movement in one transaction. Idempotent on p_request_id; refuses overpayment against the balance read under lock. The receipt number GQ-YYYY-NNNN is gapless per company and per the business year of the salary period (owner decision 17.09.2026), not per payment year.';

COMMENT ON COLUMN public.salary_cash_receipts.receipt_number IS
  'GQ-YYYY-NNNN. YYYY is business_year, the business year of period_start, and the sequence is gapless per company and that year. Receipts issued before 20260919160000 carry the year of their payment date instead and are never renumbered.';

COMMENT ON TABLE public.document_counters IS
  'Gapless document numbers per company, type and year. Written only by next_document_number(), inside the transaction that issues the document. For doc_type gehaltsquittung the year is the business year of the salary, not the payment year.';

-- ─── 2. Self-check: fail the release if the year stops coming from the salary ─

DO $mig$
DECLARE
  v_src  text;
  v_need text;
  v_at   integer;
  v_to   integer;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'confirm_salary_cash_payment';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'GQ year self-check 1: confirm_salary_cash_payment does not exist';
  END IF;

  -- 2. The number's year is the business year the receipt stores.
  IF v_src !~ 'v_year\s*:=\s*v_byear\s*;' THEN
    RAISE EXCEPTION 'GQ year self-check 2: the receipt number no longer takes its year from the salary';
  END IF;

  -- 3. And nothing derives it from the payment date any more.
  IF v_src ~ 'v_year\s*:=[^;]*p_payment_date' THEN
    RAISE EXCEPTION 'GQ year self-check 3: the receipt number still reads the payment date';
  END IF;

  -- 4. v_byear is still the business year of the salary period's start, and it
  --    is read before the number is built. A rewrite that moved the assignment
  --    below the format() would number every receipt GQ--0001.
  IF v_src !~ 'INTO\s+v_month\s*,\s*v_byear'
     OR v_src !~ 'get_business_month\s*\(\s*v_salary\.period_start\s*\)' THEN
    RAISE EXCEPTION 'GQ year self-check 4: v_byear is no longer get_business_month(v_salary.period_start)';
  END IF;

  v_at := regexp_instr(v_src, 'INTO\s+v_month\s*,\s*v_byear');
  v_to := regexp_instr(v_src, 'v_year\s*:=\s*v_byear\s*;');
  IF v_at = 0 OR v_to = 0 OR v_to < v_at THEN
    RAISE EXCEPTION 'GQ year self-check 5: the number is built before the business year is read';
  END IF;

  -- 6. The year still keys the counter and is still what is printed, so
  --    "gapless per company and that year" keeps meaning what it says.
  IF v_src !~ 'next_document_number\s*\(\s*v_company\s*,\s*''gehaltsquittung''\s*,\s*v_year\s*\)' THEN
    RAISE EXCEPTION 'GQ year self-check 6: the counter is no longer keyed on v_year';
  END IF;
  IF v_src !~ 'v_number\s*:=\s*format\s*\(\s*''GQ-%s-%s''\s*,\s*v_year\s*,' THEN
    RAISE EXCEPTION 'GQ year self-check 7: the number is no longer printed from v_year';
  END IF;

  -- 8. And the same rewrite did not quietly drop anything else. Restating a
  --    function in this repository has already lost a rule twice; these are the
  --    load-bearing fragments of 20260914140000 section 6 and of
  --    20260917130000's tenancy rewrite.
  FOREACH v_need IN ARRAY ARRAY[
    'get_active_company_id',                        -- 3.3: the state gate
    'current_role_permits\s*\(\s*''salaries''',     -- the role gate
    'pg_advisory_xact_lock',                        -- request and driver+period locks
    'FOR NO KEY UPDATE',                            -- never FOR UPDATE: see section 4
    'request_id_conflict',                          -- idempotency, before the balance check
    'overlapping_salary',                           -- two rows for one driver's period
    'already_paid',
    'overpayment',
    'invalid_payment_date',                         -- a payment date in the future
    'round\s*\(\s*p_amount\s*,\s*2\s*\)',           -- a third decimal is refused, not rounded
    'netto_salary',                                 -- due is COALESCE(netto_salary, amount_due, 0)
    'weekly_cash_difference',                       -- Bar zurück counted, never moved
    'INSERT INTO cash_movements'                    -- the outgoing movement
  ]
  LOOP
    IF v_src !~ v_need THEN
      RAISE EXCEPTION 'GQ year self-check 8: the rewrite lost a rule of confirm_salary_cash_payment (%)', v_need;
    END IF;
  END LOOP;
  IF v_src ~ 'get_user_company_id' THEN
    RAISE EXCEPTION 'GQ year self-check 8: the rewrite put confirm_salary_cash_payment back on get_user_company_id()';
  END IF;

  -- 9. The shape 20260914140000 gave it: SECURITY DEFINER with a pinned
  --    search_path, callable by authenticated and by nobody else.
  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'confirm_salary_cash_payment'
          AND p.prosecdef
          AND p.proconfig IS NOT NULL
          AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS cfg(setting)
                       WHERE cfg.setting LIKE 'search\_path=%')) THEN
    RAISE EXCEPTION 'GQ year self-check 9: confirm_salary_cash_payment lost SECURITY DEFINER or its pinned search_path';
  END IF;
  IF has_function_privilege('anon', 'public.confirm_salary_cash_payment(uuid,uuid,numeric,date,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.confirm_salary_cash_payment(uuid,uuid,numeric,date,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'GQ year self-check 9: the EXECUTE grants on confirm_salary_cash_payment moved';
  END IF;

  -- 10. The counter itself is untouched: same key, same uniqueness, still
  --     unreachable from the API roles.
  --
  --     `pg_attribute.attname` is `name`, not `text`, so array_agg over it
  --     yields `name[]` while a bare ARRAY[...] of literals is `text[]` — and
  --     there is no `name[] = text[]` operator, which is a *plan*-time error
  --     rather than a wrong answer. The first version of this check had exactly
  --     that and the kit caught it. Both sides are cast explicitly, including
  --     the ORDER BY, so neither the element type nor the sort collation is
  --     inferred. (`conkey` is `int2[]`; `pg_index.indkey` would be `int2vector`
  --     and unnest would need a cast.)
  IF NOT EXISTS (
       SELECT 1
         FROM pg_constraint c
        WHERE c.conrelid = 'public.document_counters'::regclass
          AND c.contype = 'p'
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
                 FROM unnest(c.conkey) AS k(attnum)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
              = ARRAY['company_id', 'doc_type', 'year']::text[]) THEN
    RAISE EXCEPTION 'GQ year self-check 10: document_counters is no longer keyed on (company_id, doc_type, year)';
  END IF;
  IF has_table_privilege('anon', 'public.document_counters', 'SELECT')
     OR has_table_privilege('authenticated', 'public.document_counters', 'SELECT') THEN
    RAISE EXCEPTION 'GQ year self-check 10: document_counters became readable from the API';
  END IF;

  RAISE NOTICE 'GQ year: self-check passed — the receipt number is the business year of the salary';
END $mig$;
