-- ════════════════════════════════════════════════════════════════════════════
--  A receipt for "Bar zurück": the driver kept the cash, and the paper says so
-- ════════════════════════════════════════════════════════════════════════════
--
--  Owner's decision, 06.10.2026. `issue_salary_cash_receipt` refused a
--  `weekly_cash_difference` payment with `payment_not_issuable`, and the
--  comment beside the refusal gave the reason: "Only a manual cash payment is
--  a handover a receipt can describe." That reason is sound and this migration
--  does not deny it -- it adds the second thing a receipt can describe.
--
--  WHAT "BAR ZURÜCK" ACTUALLY IS, read out of the code rather than assumed.
--  `SalaryDetailsModal` writes the row from the weekly Abrechnung: the driver
--  collected fares in cash during the week and KEPT part of it as wages,
--  instead of handing it over and being paid back. So there is no
--  `cash_movements` row -- not because the money never left the till, but
--  because it never entered it. `cashLedger.ts` states the same rule and reads
--  the ledger only, so the balance cannot double-count it.
--
--  WHY THE OLD REFUSAL WAS RIGHT, AND STILL IS. The document's sentence reads
--  "den Betrag ... vom Arbeitgeber erhalten zu haben" and "bestätigt ... den
--  Erhalt des oben genannten Betrages". On a Bar-zurück row that is false
--  twice: not from the employer, and no handover. Issuing the unchanged
--  document would have produced a signed statement about an event that did not
--  happen, which is worse than having no document at all.
--
--  WHY A RECEIPT IS NEVERTHELESS WORTH MORE HERE THAN ANYWHERE ELSE. On an
--  ordinary cash payment the till movement is corroboration: a ledger row says
--  the money went out. Bar zurück has none -- no movement, no receipt, only a
--  `salary_payments` row asserting "paid". The employee's signature is the only
--  evidence obtainable that they received those wages at all.
--
--  SO: the same series, and a document that tells the truth. One numbered
--  `GQ-YYYY-NNNN` series, one counter, the business-year rule of 20260919160000
--  unchanged, `books_cash = false` so the till is untouched by construction,
--  and a stored column saying which of the two the paper attests.
--
--  WHY THE KIND IS STORED AND NOT DERIVED WHEN THE SHEET IS PRINTED. The same
--  reason `business_month` is stored, written down when that decision was
--  taken: a confirmed receipt must reprint exactly what was signed. Derived at
--  print time, a later change to a payment's `source_type` -- or to the mapping
--  -- would reprint an issued, signed sheet under a different attestation.
--
--  AND THE REFUSAL BECOMES AN ALLOW-LIST, which is a real tightening rather
--  than a side effect. It was a deny-list: refuse `weekly_cash_difference`,
--  refuse `gehaltsquittung`, admit everything else. A `source_type` added later
--  would have been admitted and printed as a handover. Now exactly two values
--  are admitted and each maps to a sentence, so a third has to be classified on
--  purpose.
--
--  WHAT THIS COSTS, stated rather than discovered later: the weekly settlement
--  writes one row per week, so a month can yield up to five numbered receipts
--  for one driver where a manual payment yields one. The GQ series grows
--  faster. A single receipt covering a month's retentions would need a receipt
--  over several payments, and the live guard is one receipt per payment row;
--  that is a separate slice.
--
--  Unchanged, and each re-asserted in the self-check below: the platform
--  refusal first (owner decision 18.09.2026), `get_active_company_id()`,
--  `current_role_permits('salaries', true)`, idempotency on `request_id`, the
--  lock order request then payment then salary, `FOR NO KEY UPDATE` throughout,
--  `overlapping_salary`, the overpayment bound, and that the function names the
--  till ledger nowhere.
--
--  The body is rewritten FROM THE CATALOGUE, not retyped, as 20260919160000,
--  20260921110010 and 20261004110000 did for these same functions: the live
--  body is the only authority on what it does. Each of the five edits must
--  match exactly once or the migration fails having changed nothing.

-- ─── 1. What the paper attests ──────────────────────────────────────────────

ALTER TABLE public.salary_cash_receipts
  ADD COLUMN attests text NOT NULL DEFAULT 'cash_handover';

ALTER TABLE public.salary_cash_receipts
  ADD CONSTRAINT salary_cash_receipts_attests_known
  CHECK (attests IN ('cash_handover', 'cash_retained'));

COMMENT ON COLUMN public.salary_cash_receipts.attests IS
  'What the signed sheet states. cash_handover: the employee received the amount in cash from the employer (confirm_salary_cash_payment, and issue for a manual cash payment). cash_retained: the employee kept the amount out of the week''s own cash takings and no payout from the till took place (issue for a weekly_cash_difference payment). Stored, never derived at print time: a confirmed receipt must reprint exactly what was signed.';

-- A retained-cash receipt can only ever come from `issue_salary_cash_receipt`:
-- it books nothing and it names the payment it documents. `confirm` creates the
-- payment and moves the till, so a retention is not something it can describe --
-- and it never names this column, so it takes the default. Self-check 10 holds
-- it to that.
ALTER TABLE public.salary_cash_receipts
  ADD CONSTRAINT salary_cash_receipts_retained_books_nothing
  CHECK (attests <> 'cash_retained'
         OR (books_cash = false AND salary_payment_id IS NOT NULL));

-- ─── 2. Issue: admit a retention, and record which one it was ───────────────

DO $mig$
DECLARE
  v_sig constant text := 'public.issue_salary_cash_receipt(uuid, uuid, text)';

  -- (a) the variable the kind is held in.
  v_p_decl constant text := 'v_number\s+text;';
  v_r_decl constant text := 'v_number      text;' || chr(10) || '  v_attests     text;';

  -- (b) the deny-list becomes an allow-list. Anchored on both IS NOT DISTINCT
  --     lines together, because 'weekly_cash_difference' also appears in the
  --     FILTER clauses that add up what is already paid. `\s+` spans the
  --     newline between them, so no literal line break is needed here.
  v_p_gate constant text :=
       'OR\s+v_payment\.source_type\s+IS\s+NOT\s+DISTINCT\s+FROM\s+''weekly_cash_difference'''
    || '\s+OR\s+v_payment\.source_type\s+IS\s+NOT\s+DISTINCT\s+FROM\s+''gehaltsquittung''';
  v_r_gate constant text :=
    'OR COALESCE(v_payment.source_type, ''manual'') NOT IN (''manual'', ''weekly_cash_difference'')';

  -- (c) the classification, immediately after the check that admitted the row.
  v_p_kind constant text := '(HINT\s*=\s*''payment_not_issuable''\s*;\s*END IF;)';
  v_r_kind constant text :=
       '\1' || chr(10)
    || chr(10)
    || '  -- 20261006100000: which of the two sentences the sheet will carry. Derived' || chr(10)
    || '  -- here from the payment, never passed in, and stored on the receipt so a'   || chr(10)
    || '  -- signed sheet reprints exactly what was signed.'                           || chr(10)
    || '  v_attests := CASE WHEN v_payment.source_type IS NOT DISTINCT FROM ''weekly_cash_difference''' || chr(10)
    || '                    THEN ''cash_retained'' ELSE ''cash_handover'' END;';

  -- (d) the INSERT carries it.
  v_p_cols constant text := 'status,\s*confirmed_by,\s*salary_payment_id,\s*books_cash';
  v_r_cols constant text := 'status, confirmed_by, salary_payment_id, books_cash, attests';
  v_p_vals constant text := '''confirmed'',\s*v_caller,\s*v_payment\.id,\s*false';
  v_r_vals constant text := '''confirmed'', v_caller, v_payment.id, false, v_attests';

  v_def  text;
  v_new  text;
  v_hits integer;
  r      record;
BEGIN
  IF to_regprocedure(v_sig) IS NULL THEN
    RAISE EXCEPTION 'retained receipt: % does not exist', v_sig;
  END IF;

  v_def := pg_get_functiondef(to_regprocedure(v_sig));

  IF v_def ~ 'v_attests' THEN
    RAISE EXCEPTION 'retained receipt: % already knows v_attests — read its body before running this again', v_sig;
  END IF;

  -- One pass per edit, each required to match exactly once. A VALUES list
  -- rather than FOREACH ... SLICE: the subscripts of a slice of a 2-D array are
  -- easy to read wrongly, and a silent mis-index here would rewrite a money
  -- function with the wrong text.
  FOR r IN
    SELECT * FROM (VALUES
      (1, 'the v_number declaration',        v_p_decl, v_r_decl),
      (2, 'the issuability deny-list',        v_p_gate, v_r_gate),
      (3, 'the payment_not_issuable branch',  v_p_kind, v_r_kind),
      (4, 'the INSERT column list',           v_p_cols, v_r_cols),
      (5, 'the INSERT values',                v_p_vals, v_r_vals)
    ) AS t(ord, label, pat, rep)
    ORDER BY ord
  LOOP
    SELECT count(*) INTO v_hits FROM regexp_matches(v_def, r.pat, 'g');
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'retained receipt: % matches % % times, expected exactly 1',
        v_sig, r.label, v_hits;
    END IF;
    v_new := regexp_replace(v_def, r.pat, r.rep);
    IF v_new = v_def THEN
      RAISE EXCEPTION 'retained receipt: rewriting % changed nothing', r.label;
    END IF;
    v_def := v_new;
  END LOOP;

  EXECUTE v_def;
END $mig$;

COMMENT ON FUNCTION public.issue_salary_cash_receipt(uuid, uuid, text) IS
  'Issues a numbered Gehaltsquittung (GQ-YYYY-NNNN, same series as confirm) for a cash salary payment that already exists: a manual one, which the sheet states as a handover, or the weekly "Bar zurück", which it states as the employee having kept the amount out of the week''s own takings. Writes the receipt only: no payment, and nothing in the till ledger. Idempotent on p_request_id.';

-- ─── 3. Self-check: fail the release if any rule above is lost ──────────────

DO $check$
DECLARE
  v_issue constant text := 'public.issue_salary_cash_receipt(uuid, uuid, text)';
  v_src   text;
  v_need  text;
  v_n     integer;
  r       record;
BEGIN
  -- 1. The column: NOT NULL, defaults to a handover, and only the two values.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'salary_cash_receipts'
                    AND column_name = 'attests' AND is_nullable = 'NO'
                    AND column_default LIKE '%cash_handover%') THEN
    RAISE EXCEPTION 'retained receipt self-check 1: attests is missing, nullable, or does not default to cash_handover';
  END IF;
  FOREACH v_need IN ARRAY ARRAY['salary_cash_receipts_attests_known',
                                'salary_cash_receipts_retained_books_nothing'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.salary_cash_receipts'::regclass AND conname = v_need) THEN
      RAISE EXCEPTION 'retained receipt self-check 1: the CHECK % is missing', v_need;
    END IF;
  END LOOP;

  -- 2. Nothing already issued was relabelled. Every receipt that existed before
  --    this migration attested a handover, because a retention was refused.
  IF EXISTS (SELECT 1 FROM public.salary_cash_receipts
              WHERE attests = 'cash_retained' AND books_cash) THEN
    RAISE EXCEPTION 'retained receipt self-check 2: a receipt that booked cash claims to attest a retention';
  END IF;

  v_src := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(v_issue));

  -- 3. The allow-list replaced the deny-list, and names exactly two values.
  IF v_src !~ 'COALESCE\s*\(\s*v_payment\.source_type\s*,\s*''manual''\s*\)\s*NOT IN\s*\(\s*''manual''\s*,\s*''weekly_cash_difference''\s*\)' THEN
    RAISE EXCEPTION 'retained receipt self-check 3: the issuability allow-list is gone — a source_type added later would print as a handover';
  END IF;
  IF v_src ~ 'source_type\s+IS\s+NOT\s+DISTINCT\s+FROM\s+''gehaltsquittung''' THEN
    RAISE EXCEPTION 'retained receipt self-check 3: the old deny-list branch came back beside the allow-list';
  END IF;

  -- 4. The kind is derived from the payment and written onto the receipt, and
  --    the signature is unchanged, so it cannot have become an argument.
  IF v_src !~ 'v_attests\s*:=\s*CASE WHEN v_payment\.source_type IS NOT DISTINCT FROM ''weekly_cash_difference''' THEN
    RAISE EXCEPTION 'retained receipt self-check 4: the kind is no longer derived from the payment';
  END IF;
  -- Stated as the intent rather than as a rendered signature: the first attempt
  -- compared `pg_get_function_identity_arguments` against a string I had assumed
  -- the shape of, and it failed on a function that was perfectly correct.
  IF (SELECT p.pronargs FROM pg_proc p WHERE p.oid = to_regprocedure(v_issue)) <> 3
     OR EXISTS (SELECT 1 FROM pg_proc p,
                     unnest(COALESCE(p.proargnames, ARRAY[]::text[])) AS a(name)
                 WHERE p.oid = to_regprocedure(v_issue) AND a.name ~* 'attest') THEN
    RAISE EXCEPTION 'retained receipt self-check 4: the kind looks like an argument — it must be derived from the payment, never passed in';
  END IF;
  IF v_src !~ 'books_cash\s*,\s*attests' OR v_src !~ 'false\s*,\s*v_attests' THEN
    RAISE EXCEPTION 'retained receipt self-check 4: the receipt is not written with its attests value';
  END IF;

  -- 5. THE RULE of 20261004110000, re-asserted: it writes nothing but the
  --    receipt. No till ledger, no payment, books_cash false.
  IF v_src ~* 'cash_movements' THEN
    RAISE EXCEPTION 'retained receipt self-check 5: issue_salary_cash_receipt names the till ledger';
  END IF;
  IF v_src ~* '(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.)?salary_payments' THEN
    RAISE EXCEPTION 'retained receipt self-check 5: issue_salary_cash_receipt writes a salary payment';
  END IF;
  IF v_src !~ 'v_payment\.id\s*,\s*false' THEN
    RAISE EXCEPTION 'retained receipt self-check 5: the receipt is no longer written with books_cash = false';
  END IF;

  -- 6. The gates and their order, unchanged.
  IF (SELECT count(*) FROM regexp_matches(v_src, 'platform_session_not_allowed', 'g')) <> 1
     OR strpos(v_src, 'platform_session_not_allowed') > strpos(v_src, 'not_authorized')
     OR strpos(v_src, 'platform_session_not_allowed') > strpos(v_src, 'pg_advisory_xact_lock')
     OR strpos(v_src, 'platform_session_not_allowed') > strpos(v_src, 'next_document_number') THEN
    RAISE EXCEPTION 'retained receipt self-check 6: the platform refusal moved, repeated, or something is locked or numbered before it';
  END IF;
  IF v_src !~ 'get_active_company_id' OR v_src ~ 'get_user_company_id'
     OR v_src !~ 'current_role_permits\s*\(\s*''salaries''\s*,\s*true\s*\)' THEN
    RAISE EXCEPTION 'retained receipt self-check 6: the company helper or the salaries role gate changed';
  END IF;

  -- 7. Locks: NO KEY UPDATE, the payment before the salary.
  IF v_src ~ 'FOR\s+UPDATE' OR v_src !~ 'FOR NO KEY UPDATE' THEN
    RAISE EXCEPTION 'retained receipt self-check 7: a row lock is not FOR NO KEY UPDATE';
  END IF;
  IF strpos(v_src, 'FROM salary_payments WHERE id = p_payment_id FOR NO KEY UPDATE') = 0
     OR strpos(v_src, 'FROM salary_payments WHERE id = p_payment_id FOR NO KEY UPDATE')
        > strpos(v_src, 'FROM salaries WHERE id = v_payment.salary_id FOR NO KEY UPDATE') THEN
    RAISE EXCEPTION 'retained receipt self-check 7: the payment row is no longer locked before the salary row';
  END IF;

  -- 8. Every refusal, and the number from the same counter and business year.
  FOREACH v_need IN ARRAY ARRAY[
    'request_id_conflict', 'overlapping_salary', 'payment_not_issuable', 'already_issued',
    'overpayment', 'payment_not_found', 'invalid_place', 'invalid_request'
  ] LOOP
    IF v_src !~ v_need THEN
      RAISE EXCEPTION 'retained receipt self-check 8: a refusal is missing (%)', v_need;
    END IF;
  END LOOP;
  IF v_src !~ 'v_year\s*:=\s*v_byear\s*;'
     OR v_src !~ 'next_document_number\s*\(\s*v_company\s*,\s*''gehaltsquittung''\s*,\s*v_year\s*\)'
     OR v_src !~ 'v_number\s*:=\s*format\s*\(\s*''GQ-%s-%s''\s*,\s*v_year\s*,'
     OR v_src ~ 'v_year\s*:=[^;]*payment_date' THEN
    RAISE EXCEPTION 'retained receipt self-check 8: the number no longer comes from the same counter and the business year of the salary';
  END IF;

  -- 9. Still DEFINER, still pinned, still authenticated only.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(v_issue)
                    AND p.prosecdef AND p.proconfig IS NOT NULL
                    AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c(s) WHERE c.s LIKE 'search\_path=%')) THEN
    RAISE EXCEPTION 'retained receipt self-check 9: issue_salary_cash_receipt lost SECURITY DEFINER or its pinned search_path';
  END IF;
  IF has_function_privilege('anon', v_issue, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_issue, 'EXECUTE') THEN
    RAISE EXCEPTION 'retained receipt self-check 9: the EXECUTE grants moved';
  END IF;

  -- 10. `confirm` attests only a handover. It creates the payment and books the
  --     cash out of the till, so a retention is not something it can describe --
  --     and it must reach the column only through the default. Every overload is
  --     checked and the signature is looked up rather than assumed.
  v_n := 0;
  FOR r IN SELECT p.oid, p.prosrc FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'confirm_salary_cash_payment'
  LOOP
    v_n := v_n + 1;
    IF r.prosrc ~ 'attests' THEN
      RAISE EXCEPTION 'retained receipt self-check 10: confirm_salary_cash_payment(%) names attests — it must take the default',
        pg_get_function_identity_arguments(r.oid);
    END IF;
  END LOOP;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'retained receipt self-check 10: confirm_salary_cash_payment was not found at all';
  END IF;

  -- 11. The client roles still cannot write the receipt table.
  IF has_table_privilege('authenticated', 'public.salary_cash_receipts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.salary_cash_receipts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.salary_cash_receipts', 'DELETE') THEN
    RAISE EXCEPTION 'retained receipt self-check 11: a client role can write salary_cash_receipts directly';
  END IF;

  SELECT count(*) INTO v_n FROM public.salary_cash_receipts;
  RAISE NOTICE 'retained receipt: self-checks passed — % existing receipt(s), all attesting a handover; the till is named nowhere', v_n;
END
$check$;
