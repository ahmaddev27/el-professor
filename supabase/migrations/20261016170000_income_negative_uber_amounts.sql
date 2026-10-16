/*
  Negative Uber figures are stored, so the totals are true

  ## Why

  Reidey sends a figure below zero for a refunded fare, a clawed-back promotion
  or a reversed tip. `income.amount` was `CHECK (amount >= 0)`, so such a figure
  was refused and the row never existed. That is not neutral: the weekly total,
  the salary base ((Umsatz + Aktionen) x salary_ratio + Trinkgeld) and the
  Overview all read the money as if Uber had not taken it back, and they
  overstated it by exactly that amount. The owner's instruction (16.10.2026):
  no misleading data, no lost data. The figure is stored as it arrives.

  ## Scope: source = 'uber' and the three payroll types, nothing else

      amount >= 0
      OR (COALESCE(source = 'uber', false) AND type IN ('umsatz', 'aktionen', 'trinkgeld'))

  The COALESCE is load-bearing: a hand-typed row has source NULL, `NULL = 'uber'`
  is NULL, and a CHECK treats NULL as a pass, so without it a negative typed row
  would be admitted. The self-check below inserts one and requires the refusal.

  * Hand-typed rows (source IS NULL) keep the old rule: a person typing a
    negative is a mistake, and the Einnahmen screen has never offered one.
  * `bargeld` stays non-negative on purpose. It is the only type that moves the
    till (Abrechnung bar_zuruck, cash ledger, Bargeldbestand, Overview cash
    panel). Whether an Uber cash adjustment is cash that left the till is not
    known, and a wrong till is worse than a refused figure; it is reported on
    the run and the screens instead (the pull's `skipped` list stays, for cash
    only).
  * What else can now write a negative that could not before: any member who
    may INSERT or UPDATE `income` (the policies are unchanged) and who sets
    `source = 'uber'` with a valid source shape by hand. That could already
    forge a positive Uber row, so this adds no new class of write, only a sign;
    income_source_shape still demands the driver key and the period, and the
    writers below remain the only code that sets `source`.

  ## The two import writers

  `income_import_uber` (the browser import) and `income_import_uber_system`
  (the scheduled pull) validate every element with a regex that refused a minus
  sign. Each is spliced from the catalogue, once, at that one clause: a negative
  amount is accepted for the three types only, never `-0`, never `-0.00`.
  Everything else in both functions (grants, ownership, locks, replace, the gap
  condition 20261016150000 spliced) is carried unchanged by the splice.

  ## What this does not do

  The salary is floored at zero in the application (utils/salaryDue.ts), not
  here: a stored `salaries` row, and every receipt issued against one, is not
  touched by this migration.
*/

ALTER TABLE public.income DROP CONSTRAINT IF EXISTS income_amount_check;
ALTER TABLE public.income
  ADD CONSTRAINT income_amount_check
  CHECK (amount >= 0 OR (COALESCE(source = 'uber', false) AND type IN ('umsatz', 'aktionen', 'trinkgeld')));

COMMENT ON CONSTRAINT income_amount_check ON public.income IS
  'An amount is not negative, except a source = uber row of type umsatz, aktionen or trinkgeld (a refund, a clawback, a reversed tip). bargeld never goes below zero: it moves the till.';

DO $splice$
DECLARE
  v_old constant text := $f$AND e->>'amount' ~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$'$f$;
  v_new constant text := $f$AND (e->>'amount' ~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$'
         OR (e->>'type' IN ('umsatz', 'aktionen', 'trinkgeld')
             AND e->>'amount' ~ '^-(0\.(0[1-9]|[1-9][0-9]?)|[1-9][0-9]{0,8}(\.[0-9]{1,2})?)$'))$f$;
  v_sig text;
  v_def text;
  v_hits integer;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.income_import_uber(jsonb, boolean)',
    'public.income_import_uber_system(uuid, jsonb)'
  ] LOOP
    v_def := pg_get_functiondef(v_sig::regprocedure);
    v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'negative uber amounts: % must carry the amount clause exactly once, found %', v_sig, v_hits;
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END LOOP;
END
$splice$;

-- Self-check: the shape and the behaviour of the rule, never stored data.
DO $check$
DECLARE
  v_sig    text;
  v_src    text;
  v_def    text;
  v_pos    constant text := '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$';
  v_neg    constant text := '^-(0\.(0[1-9]|[1-9][0-9]?)|[1-9][0-9]{0,8}(\.[0-9]{1,2})?)$';
  v_sample text;
BEGIN
  -- 1. The constraint has exactly the scope written above.
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.income'::regclass AND c.conname = 'income_amount_check';
  IF v_def IS NULL
     OR v_def NOT LIKE '%source = ''uber''::text%'
     OR v_def NOT LIKE '%''umsatz''::text%'
     OR v_def NOT LIKE '%''aktionen''::text%'
     OR v_def NOT LIKE '%''trinkgeld''::text%'
     OR v_def LIKE '%bargeld%' THEN
    RAISE EXCEPTION 'negative uber amounts self-check 1: income_amount_check has the wrong shape: %', v_def;
  END IF;

  -- 2. Behaviour of the constraint, on a scratch table carrying the same
  --    expression (income itself needs a company, a driver and a link).
  CREATE TEMP TABLE _neg_probe (amount numeric, source text, type text) ON COMMIT DROP;
  ALTER TABLE _neg_probe ADD CONSTRAINT p
    CHECK (amount >= 0 OR (COALESCE(source = 'uber', false) AND type IN ('umsatz', 'aktionen', 'trinkgeld')));
  INSERT INTO _neg_probe VALUES (-1, 'uber', 'umsatz'), (-1, 'uber', 'aktionen'),
                                (-1, 'uber', 'trinkgeld'), (0, NULL, 'bargeld');
  BEGIN
    INSERT INTO _neg_probe VALUES (-1, 'uber', 'bargeld');
    RAISE EXCEPTION 'negative uber amounts self-check 2: a negative bargeld was admitted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO _neg_probe VALUES (-1, NULL, 'umsatz');
    RAISE EXCEPTION 'negative uber amounts self-check 2: a negative hand-typed row was admitted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 3. The regexes the writers carry accept and refuse the right strings.
  FOREACH v_sample IN ARRAY ARRAY['-0.01', '-0.1', '-12', '-12.50', '-999999999.99'] LOOP
    IF v_sample !~ v_neg THEN
      RAISE EXCEPTION 'negative uber amounts self-check 3: % must be accepted', v_sample;
    END IF;
  END LOOP;
  FOREACH v_sample IN ARRAY ARRAY['-0', '-0.00', '-0.0', '--1', '-01', '-1.234', '-.5', '-', '-1e3', '1.-1'] LOOP
    IF v_sample ~ v_neg THEN
      RAISE EXCEPTION 'negative uber amounts self-check 3: % must be refused', v_sample;
    END IF;
  END LOOP;
  IF '-1' ~ v_pos OR NOT ('12.50' ~ v_pos) THEN
    RAISE EXCEPTION 'negative uber amounts self-check 3: the positive regex changed';
  END IF;

  -- 4. Both writers carry the clause once and kept their guards and grants.
  FOREACH v_sig IN ARRAY ARRAY[
    'public.income_import_uber(jsonb, boolean)',
    'public.income_import_uber_system(uuid, jsonb)'
  ] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_sig::regprocedure;
    IF strpos(v_src, v_neg) = 0
       OR strpos(v_src, v_pos) = 0
       OR (length(v_src) - length(replace(v_src, v_neg, ''))) / length(v_neg) <> 1 THEN
      RAISE EXCEPTION 'negative uber amounts self-check 4: % lost or duplicated the amount clause', v_sig;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_sig::regprocedure)
       OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_sig::regprocedure
                       AND p.proconfig @> ARRAY['search_path=pg_catalog, public'])
       OR has_function_privilege('anon', v_sig::regprocedure, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                   WHERE p.oid = v_sig::regprocedure AND a.grantee = 0) THEN
      RAISE EXCEPTION 'negative uber amounts self-check 4: % lost SECURITY DEFINER, its search_path or a grant', v_sig;
    END IF;
  END LOOP;

  IF NOT has_function_privilege('authenticated', 'public.income_import_uber(jsonb, boolean)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.income_import_uber_system(uuid, jsonb)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.income_import_uber_system(uuid, jsonb)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'negative uber amounts self-check 4: the writers'' grants changed';
  END IF;

  RAISE NOTICE 'negative uber amounts self-check: passed';
END
$check$;
