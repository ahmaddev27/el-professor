/*
  # A platform context issues, voids and signs no Gehaltsquittung — in the
    database, not only in the browser (plan 3.13, slice 3.13a)

  ## The rule, and why it is permanent

  Owner decision of 18.09.2026: a platform support session issues, voids and
  signs nothing on the Gehaltsquittung screens. A Gehaltsquittung attests to a
  physical handover of cash — the company counts banknotes into a driver's
  hand, and the driver signs for having received them — and no platform agent
  was in the room. That is a question of attestation, which no audit row
  answers, not of traceability: the actor is recorded either way
  (`confirmed_by`, `voided_by`, `cash_movements.created_by`). So the rule does
  not expire when a write is audited, 3.4c's triggers and this slice's
  included.

  ## What was open

  The refusal was the browser's alone: `receiptScope()` answers
  `other_company` inside a context and both screens refuse. The three RPCs
  resolve the caller with `get_active_company_id()` (20260917130000), which
  since 20260917140000 answers a company-less platform account's open context,
  and their only other gate is `current_role_permits('salaries', true)`, which
  3.4a answers true inside a support session. So a staff member who could open
  a support session could call all three straight through PostgREST with their
  own token and write a gapless GQ receipt, a `salary_payments` row and an
  outgoing `cash_movements` row in a customer's books.

  ## What changes

  One block, inserted into each of the three bodies immediately before the
  existing authorization check, so it runs before any argument is read, any
  lock is taken and any number is drawn:

      IF v_company IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.user_profiles up
                          WHERE up.user_id = v_caller AND up.company_id IS NOT NULL) THEN
        RAISE EXCEPTION '…' USING ERRCODE = '42501', HINT = 'platform_session_not_allowed';
      END IF;

  **Why this condition, and not a new helper.** `v_company` is the function's
  own `get_active_company_id()`. That function answers a company to an account
  with no company of its own from exactly one place: the account's open
  platform context (20260917140000, `platform_context_company(false)`). So "a
  company, and no membership" is "inside a platform context", in either mode —
  derived from the helper the function already calls, with nothing new
  defined and no new grant: the three functions belong to `postgres` on the
  live databases, which reads `user_profiles` as its owner already and would
  need an explicit grant to call a new platform helper. A future second source
  for a company-less account's company would be refused here too, which is the
  side to fail on. A company member — whose company is its membership — never
  reaches the RAISE, and neither does a caller with no company at all (the
  existing check answers it, as before).

  The view mode is refused by the same block, with the same reason, where it
  used to fall to `not_authorized` (its role gate is false). One reason for one
  rule.

  ## How the bodies are changed: from the catalogue, as before

  20260917130000 and 20260919160000 set the precedent for exactly these three
  functions: the live definition is the only authority on what they do, and
  retyping a payroll function by hand is how a clause goes missing — this
  repository has lost a rule twice by restating a function to change one line.
  So each body is read with `pg_get_functiondef()`, the one anchor (the
  authorization `IF`) must match exactly once or the migration fails without
  changing anything, the block is spliced in front of it, and the result is
  executed. `CREATE OR REPLACE` keeps the owner, `SECURITY DEFINER`, the pinned
  search_path and the ACL, so none of them is restated here and none can
  drift. The self-check below then asserts, function by function, that every
  load-bearing fragment of the old body is still there, that the new block is
  there exactly once and ahead of the authorization check, and that each
  function still answers a caller with no subject with `not_authorized`.

  ## Compatibility — this does NOT bump deploy/SCHEMA_EPOCH

  A refusal added to three bodies; nothing dropped, no column or grant
  changed. The previous release's screens never call these RPCs inside a
  context (receiptScope refuses first), so a rollback of the code across this
  file changes nothing they do.
*/

-- ─── 1. The block, spliced in front of each authorization check ─────────────

DO $mig$
DECLARE
  -- The authorization check, as 20260914140000 wrote it in all three bodies.
  c_anchor CONSTANT text :=
    '(IF\s+v_caller\s+IS\s+NULL\s+OR\s+v_company\s+IS\s+NULL\s+OR\s+NOT\s+current_role_permits\s*\(\s*''salaries''\s*,\s*true\s*\)\s+THEN)';
  -- Kept free of the words the self-check below looks for, so it cannot be
  -- mistaken for the code it describes.
  c_block  CONSTANT text :=
      '-- 20260921110010 (plan 3.13a): a platform account inside a context, in either mode,' || chr(10)
   || '  -- issues, voids and signs nothing here (owner decision 18.09.2026). The company' || chr(10)
   || '  -- helper answers a company to an account with none of its own only from an open' || chr(10)
   || '  -- platform context, so a company and no membership is exactly that case.' || chr(10)
   || '  IF v_company IS NOT NULL' || chr(10)
   || '     AND NOT EXISTS (SELECT 1 FROM public.user_profiles up' || chr(10)
   || '                      WHERE up.user_id = v_caller AND up.company_id IS NOT NULL) THEN' || chr(10)
   || '    RAISE EXCEPTION ''Gehaltsquittungen werden nur im eigenen Unternehmen ausgestellt, storniert und unterschrieben — nie aus einer Plattform-Sitzung heraus.''' || chr(10)
   || '      USING ERRCODE = ''42501'', HINT = ''platform_session_not_allowed'';' || chr(10)
   || '  END IF;' || chr(10)
   || chr(10)
   || '  ';

  v_sig     text;
  v_def     text;
  v_new     text;
  v_hits    integer;
  v_changed integer := 0;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.confirm_salary_cash_payment(uuid, uuid, numeric, date, text)',
    'public.void_salary_cash_receipt(uuid, text)',
    'public.attach_salary_cash_receipt_signed_copy(uuid, text)'
  ]
  LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION '3.13a GQ: % does not exist', v_sig;
    END IF;

    v_def := pg_get_functiondef(to_regprocedure(v_sig));

    IF v_def ~ 'platform_session_not_allowed' THEN
      RAISE EXCEPTION '3.13a GQ: % already refuses a platform context — read its body before running this again', v_sig;
    END IF;

    SELECT count(*) INTO v_hits FROM regexp_matches(v_def, c_anchor, 'g');
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '3.13a GQ: % has its authorization check % times in the shape this migration expects, not exactly once — read its body before changing this',
        v_sig, v_hits;
    END IF;

    -- \1 puts the matched check back after the block, character for character.
    v_new := regexp_replace(v_def, c_anchor, c_block || '\1');

    IF v_new = v_def THEN
      RAISE EXCEPTION '3.13a GQ: the splice changed nothing in %', v_sig;
    END IF;

    EXECUTE v_new;
    v_changed := v_changed + 1;
  END LOOP;

  IF v_changed <> 3 THEN
    RAISE EXCEPTION '3.13a GQ: changed % functions, expected 3', v_changed;
  END IF;
  RAISE NOTICE '3.13a GQ: % Gehaltsquittung functions refuse a platform context', v_changed;
END $mig$;

COMMENT ON FUNCTION public.confirm_salary_cash_payment(uuid, uuid, numeric, date, text) IS
  'Confirms a cash salary payment: receipt, salary payment and outgoing cash movement in one transaction. Idempotent on p_request_id; refuses overpayment against the balance read under lock. The receipt number GQ-YYYY-NNNN is gapless per company and per the business year of the salary period (owner decision 17.09.2026), not per payment year. Refused inside a platform context (owner decision 18.09.2026, 20260921110010).';

COMMENT ON FUNCTION public.void_salary_cash_receipt(uuid, text) IS
  'Voids a Gehaltsquittung: removes its payment, books the cash back on the day of the void, keeps the receipt and its number. Refused inside a platform context (owner decision 18.09.2026, 20260921110010).';

COMMENT ON FUNCTION public.attach_salary_cash_receipt_signed_copy(uuid, text) IS
  'Records the storage path of a Gehaltsquittung''s signed copy, inside the caller''s company folder. Refused inside a platform context (owner decision 18.09.2026, 20260921110010).';

-- ─── 2. Self-check ──────────────────────────────────────────────────────────

DO $mig$
DECLARE
  r       record;
  v_src   text;
  v_need  text;
  v_block integer;
  v_auth  integer;
  v_state text;
  v_hint  text;
BEGIN
  FOR r IN
    SELECT *
      FROM (VALUES
        ('public.confirm_salary_cash_payment(uuid, uuid, numeric, date, text)',
         ARRAY[
           'get_active_company_id',                          -- 3.3: the state gate
           'current_role_permits\s*\(\s*''salaries''',       -- the role gate
           'invalid_request', 'invalid_amount', 'invalid_payment_date', 'invalid_place',
           'round\s*\(\s*p_amount\s*,\s*2\s*\)',             -- a third decimal is refused, not rounded
           'Europe/Berlin',                                  -- "today" is Berlin's
           'pg_advisory_xact_lock',                          -- request and driver+period locks
           'FOR NO KEY UPDATE',                              -- never FOR UPDATE on the salary
           'salary_not_found',
           'request_id_conflict',                            -- idempotency, before the balance check
           'overlapping_salary',                             -- two rows for one driver's period
           'weekly_cash_difference',                         -- Bar zurück counted, never moved
           'netto_salary',                                   -- due is COALESCE(netto_salary, amount_due, 0)
           'already_paid', 'overpayment',
           'get_business_month\s*\(\s*v_salary\.period_start\s*\)',
           'v_year\s*:=\s*v_byear\s*;',                      -- 20260919160000: the salary's year
           'next_document_number\s*\(\s*v_company\s*,\s*''gehaltsquittung''\s*,\s*v_year\s*\)',
           'INSERT INTO salary_cash_receipts',
           'INSERT INTO salary_payments',
           'INSERT INTO cash_movements',
           'SET salary_payment_id = v_payment_id'
         ]),
        ('public.void_salary_cash_receipt(uuid, text)',
         ARRAY[
           'get_active_company_id',
           'current_role_permits\s*\(\s*''salaries''',
           'invalid_request', 'invalid_reason', 'receipt_not_found',
           'Europe/Berlin',                                  -- the Storno is booked on Berlin's today
           'pg_advisory_xact_lock',
           'FOR NO KEY UPDATE',
           'FOR UPDATE;',                                    -- the receipt row itself
           'v_receipt\.status\s*=\s*''voided''',             -- voiding twice returns it unchanged
           'voided_by\s*=\s*v_caller',
           'DELETE FROM salary_payments',
           'gehaltsquittung_storno',
           'void_cash_movement_id'
         ]),
        ('public.attach_salary_cash_receipt_signed_copy(uuid, text)',
         ARRAY[
           'get_active_company_id',
           'current_role_permits\s*\(\s*''salaries''',
           'invalid_request', 'invalid_path',
           'length\s*\(\s*p_path\s*\)\s*>\s*512',
           'split_part\s*\(\s*p_path\s*,\s*''/''\s*,\s*1\s*\)\s*<>\s*v_company::text',
           'receipt_not_found', 'receipt_voided',
           'SET signed_copy_path = p_path'
         ])
      ) AS v(sig, needs)
  LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_src IS NULL THEN
      RAISE EXCEPTION '3.13a GQ self-check 1: % does not exist', r.sig;
    END IF;

    -- 2. The block is there exactly once, and it comes before the check that
    --    answers not_authorized — so nothing is read, locked or numbered first.
    IF (SELECT count(*) FROM regexp_matches(v_src, 'platform_session_not_allowed', 'g')) <> 1 THEN
      RAISE EXCEPTION '3.13a GQ self-check 2: % does not refuse a platform context exactly once', r.sig;
    END IF;
    v_block := strpos(v_src, 'platform_session_not_allowed');
    v_auth  := strpos(v_src, 'not_authorized');
    IF v_auth = 0 OR v_block > v_auth THEN
      RAISE EXCEPTION '3.13a GQ self-check 2: % refuses a platform context only after its authorization check', r.sig;
    END IF;
    IF v_src !~ 'NOT EXISTS \(SELECT 1 FROM public\.user_profiles up\s+WHERE up\.user_id = v_caller AND up\.company_id IS NOT NULL\)' THEN
      RAISE EXCEPTION '3.13a GQ self-check 2: % refuses on some condition other than "a company, and no membership"', r.sig;
    END IF;

    -- 3. Nothing else was lost in the splice.
    FOREACH v_need IN ARRAY r.needs LOOP
      IF v_src !~ v_need THEN
        RAISE EXCEPTION '3.13a GQ self-check 3: the splice lost a rule of % (%)', r.sig, v_need;
      END IF;
    END LOOP;
    IF v_src ~ 'get_user_company_id' THEN
      RAISE EXCEPTION '3.13a GQ self-check 3: % reads get_user_company_id() again', r.sig;
    END IF;

    -- 4. The shape 20260914140000 gave it: SECURITY DEFINER, a pinned
    --    search_path, callable by authenticated and not by anon.
    IF NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid = to_regprocedure(r.sig)
            AND p.prosecdef
            AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS cfg(setting)
                         WHERE cfg.setting LIKE 'search\_path=%')) THEN
      RAISE EXCEPTION '3.13a GQ self-check 4: % lost SECURITY DEFINER or its pinned search_path', r.sig;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(r.sig), 'EXECUTE')
       OR NOT has_function_privilege('authenticated', to_regprocedure(r.sig), 'EXECUTE') THEN
      RAISE EXCEPTION '3.13a GQ self-check 4: the EXECUTE grants on % moved', r.sig;
    END IF;
  END LOOP;

  -- 5. Each body still compiles and still fails closed for a caller with no
  --    subject — the migration is one — with the check it had, not the new
  --    one: v_company is NULL there, so the block is not what answers.
  FOR r IN
    SELECT *
      FROM (VALUES
        ('confirm', $q$SELECT public.confirm_salary_cash_payment(gen_random_uuid(), gen_random_uuid(), 1, DATE '2026-06-01', 'x')$q$),
        ('void',    $q$SELECT public.void_salary_cash_receipt(gen_random_uuid(), 'x')$q$),
        ('attach',  $q$SELECT public.attach_salary_cash_receipt_signed_copy(gen_random_uuid(), 'x/y.pdf')$q$)
      ) AS v(what, stmt)
  LOOP
    v_state := NULL;
    v_hint  := NULL;
    BEGIN
      EXECUTE r.stmt;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_state IS DISTINCT FROM '42501' OR v_hint IS DISTINCT FROM 'not_authorized' THEN
      RAISE EXCEPTION '3.13a GQ self-check 5: % answered a caller with no subject with % / % instead of 42501 / not_authorized',
        r.what, coalesce(v_state, 'success'), coalesce(v_hint, '-');
    END IF;
  END LOOP;

  RAISE NOTICE '3.13a GQ self-check: passed — no platform context issues, voids or signs a Gehaltsquittung';
END $mig$;
