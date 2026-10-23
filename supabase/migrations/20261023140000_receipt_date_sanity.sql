-- ════════════════════════════════════════════════════════════════════════════
--  A Beleg's date must be a date a Beleg can have
-- ════════════════════════════════════════════════════════════════════════════
--
--  `public.receipts.date` is a plain `date` column with no constraint of any
--  kind, so a typo in the year is stored and kept. A receipt dated 2072 or 2921
--  is outside every month filter for ever, is counted by every read that pages
--  the table, and sits in the company's history where no report will show it.
--  The read that surfaced this was a receipts query silently truncated at
--  PostgREST's 1000-row cap; the reason that company had crossed the cap at all
--  was one row dated 2072.
--
--  The table already carries six plausibility CHECKs in exactly this spirit —
--  `receipts_litres_plausible`, `receipts_odometer_plausible`,
--  `receipts_range_plausible`, `receipts_price_per_litre_plausible` — written for
--  the fields an OCR pass or a person can get wrong by an order of magnitude.
--  The date was the one typed field with no such bound. This adds it.
--
--  ── What the data said, and what that decided ───────────────────────────────
--
--  Measured read-only on production, 23.10.2026: 1124 receipts in 18 companies.
--
--    year    rows
--    2025     188
--    2026     934
--    2072       1   <- absurd
--    2921       1   <- absurd
--
--    oldest receipt            2025-09-04
--    newest genuine receipt    2026-10-23  (the day of the measurement)
--    rows dated ahead of today 0, once the two absurd rows are set aside
--    NULL dates                0  (the column is NOT NULL)
--
--  The two absurd rows, named here because they are the owner's to decide:
--
--    e9fdb28c-77d4-4845-ad7d-36d0cc269416  company bc7e0e4d-...  2072-05-27
--                                          filed 2026-06-01
--    0a40aa42-7955-46b2-802a-7ecdf6350a00  company 20d21fcb-...  2921-04-08
--                                          filed 2026-05-11
--
--  Both read as a year typed wrong: filed in 2026, dated 46 and 895 years out.
--  Which date was meant is the operator's knowledge and not ours.
--
--  ── The bounds, and why these two numbers ───────────────────────────────────
--
--      date >= 2015-01-01  AND  date < 2051-01-01
--
--  Lower, 2015-01-01: ten years before the oldest genuine receipt (2025-09-04)
--  and eleven before the product's own first company row. A company joining now
--  could legitimately back-enter old bookkeeping, and §147 AO keeps
--  Buchungsbelege for eight years (ten before 2025), so a full pre-2025
--  retention window sits inside the bound with room to spare. It refuses the
--  year typos that land in the thousands and the far 2000s: 1026, 0226, 1926,
--  2006.
--
--  Upper, 2051-01-01: it must be BELOW 2072, or the constraint would admit the
--  very value that caused this work. That is the whole argument for not simply
--  writing a comfortable 2100: 2072-05-27 is a real stored row, so the class of
--  typo that produces a date forty-odd years out is a measured class and not a
--  hypothetical. 2051 keeps 24 years and 2 months of headroom from the day this
--  was written, and refuses 2056, 2062, 2072, 2092, 2126, 2921.
--
--  What it costs: a typo of plus or minus ten to twenty years (2016, 2036, 2046)
--  is admitted. A CHECK cannot do better, because it cannot know today's date
--  (below), and a bound tight enough to catch 2036 would have to be revisited
--  within ten years. The alternative considered and rejected was 2041-01-01,
--  which catches 2046 as well at the price of halving the headroom; the trade is
--  recorded rather than presented as the only reading.
--
--  ── WHEN THIS NEEDS REVISITING, and what it will look like ──────────────────
--
--  Revisit before 2050-01-01. The symptom will be that an ordinary receipt save
--  starts failing: PostgREST answers 23514 naming `receipts_date_plausible`, and
--  the Belege screen shows its generic save failure with no hint that a date
--  bound is the reason. The fix is one migration widening the upper bound, in
--  this same shape. Nothing degrades gradually and nothing warns first, so the
--  date is written here and in the constraint's own COMMENT, which is what a
--  person meeting the error will read.
--
--  ── Why the upper bound is a fixed date and not `CURRENT_DATE + n` ──────────
--
--  "A CHECK expression must be IMMUTABLE, so CURRENT_DATE cannot appear in one"
--  is the usual reason given and it is NOT TRUE on this engine. Measured on
--  PostgreSQL 17.6, the kit's own image: an ALTER TABLE adding a CHECK of
--  `d <= CURRENT_DATE + 365` is ACCEPTED. The reason to refuse it is the one
--  below, and it is also measured, because the usual reason would not have held.
--
--  A CHECK is evaluated when a row is written and never again, so a
--  time-dependent bound silently reclassifies rows that are already stored: a
--  row written inside the window is outside it a year later, with nothing
--  raised. That is not merely untidy — it makes the dump unrestorable, which is
--  the one thing this product cannot afford, since `deploy.sh` takes a `pg_dump`
--  before every migration and that snapshot is the way back across a schema
--  epoch. Measured, same image:
--
--    - `pg_dump` emits a VALIDATED CHECK inline inside `CREATE TABLE`, i.e.
--      before the `COPY` that loads the rows.
--    - `COPY` enforces CHECK constraints: a row the constraint refuses fails the
--      COPY ("new row for relation ... violates check constraint").
--
--  So a validated `CURRENT_DATE`-based bound would refuse, at restore time,
--  rows that were legitimate when they were written, and the restore would
--  abort. A fixed bound restores identically whenever it is run. This is the
--  reason, and it is why no trigger was written either: a trigger could read the
--  clock, but then the rule would live outside the catalogue where neither
--  `pg_dump` nor a reader of the table definition can see it, and it would still
--  be a rule whose answer changes for a row nobody touched.
--
--  ── Why NOT VALID, and what that leaves untouched ───────────────────────────
--
--  The constraint is added NOT VALID and there is deliberately NO
--  `VALIDATE CONSTRAINT` step. The two rows above are a customer's own business
--  records. Rewriting them would be guessing at an intent a row cannot carry,
--  and deleting them would destroy a Beleg; a migration that silently changed a
--  stored business record would be worse than the record. So the rule binds
--  every new and updated row from now on, and history stays exactly as it is.
--
--  NOT VALID is not "ignore the old rows", and the cost is worth stating rather
--  than discovering. Measured on PostgreSQL 17.6 against this exact constraint:
--
--    the violating row stays readable                              yes
--    DELETE of the violating row                                   allowed
--    UPDATE of the violating row that also fixes the date          allowed
--    UPDATE of ANOTHER column of the violating row                 REFUSED 23514
--
--  The last line is the one that surprises people, and it is a property of
--  PostgreSQL and not of this constraint: an UPDATE re-checks the new row
--  version, which still breaks the rule, whatever column was touched. So the
--  two rows above are readable and deletable but frozen until their date is
--  corrected. 20261022143000 recorded the same behaviour for `driver_notes`.
--  tests/rls/receipt-date.sql holds all four lines, so a change to any of them
--  has to say so.
--
--  The NOT VALID state also survives a dump, which is what keeps the snapshot
--  restorable while those rows exist. Measured: `pg_dump` emits a NOT VALID
--  CHECK as an ALTER TABLE ADD CONSTRAINT ... NOT VALID AFTER the `COPY`, so
--  the restore adds it without scanning, and a database carrying 2921-04-08
--  dumped and restored clean (exit 0, the row back, the constraint still NOT
--  VALID). A later `VALIDATE CONSTRAINT` would fail while either row stands;
--  that is a decision for the owner once the dates are corrected, not a
--  tidy-up, and the self-check below fails a release that has quietly made it.
--
--  ── Where the hazard is the same and nothing was added ──────────────────────
--
--  `income.date` and `cash_transactions.date` are the other two typed date
--  columns, and both have the identical shape: plain `date`, NOT NULL, no CHECK.
--  Measured read-only on production the same day:
--
--    income              1563 rows, 2025-09-08 ... 2026-10-12, 0 outliers
--    cash_transactions      0 rows
--
--  Neither carries a defect, and `cash_transactions` carries no data at all, so
--  neither gets a constraint here: the measurement does not justify one, and
--  `income` is also written by the Uber import, where a bound refusing an
--  imported row is a failure mode nobody has looked at yet. The exposure is
--  real and is named in the PR; closing it is its own change with its own
--  measurement.
--
--  ── Rolling back ────────────────────────────────────────────────────────────
--
--  The release before this one writes every date this constraint admits, and
--  reads are untouched, so no SCHEMA_EPOCH bump. What the previous release could
--  do and this one cannot is store a new absurd date, which is the defect
--  surfacing and not a regression.

-- ─── 1. the constraint ──────────────────────────────────────────────────────
--
--  DROP IF EXISTS then ADD, so the file is idempotent for the RLS kit, which
--  applies every migration from 20260908 on to a fixture built from production's
--  --schema-only dump. The table itself is only ever ALTERed in this chain (it
--  has no CREATE TABLE anywhere), so this assumes it exists and creates nothing.
--
--  No `date IS NULL OR ...` arm, unlike the sibling plausibility CHECKs: those
--  guard nullable columns, and this one is NOT NULL. Adding the arm would claim
--  otherwise.

ALTER TABLE public.receipts
  DROP CONSTRAINT IF EXISTS receipts_date_plausible;

ALTER TABLE public.receipts
  ADD CONSTRAINT receipts_date_plausible
  CHECK (date >= DATE '2015-01-01' AND date < DATE '2051-01-01')
  NOT VALID;

-- ─── 2. what it says, for whoever meets it in an error ──────────────────────

COMMENT ON CONSTRAINT receipts_date_plausible ON public.receipts IS
  'A Beleg''s date is on or after 2015-01-01 and before 2051-01-01. The lower '
  'bound is ten years before the oldest genuine receipt (2025-09-04 on '
  'production) and covers a pre-2025 §147 AO retention window; the upper bound '
  'is below 2072 on purpose, because 2072-05-27 is a real stored row and a '
  'comfortable 2100 would have admitted exactly the typo this constraint exists '
  'to refuse. REVISIT BEFORE 2050: past that the bound starts refusing ordinary '
  'receipts, and the only symptom is a failed save reported as 23514 naming this '
  'constraint. Added NOT VALID and deliberately never validated, so the two '
  'absurd rows production already holds stay as they are; note that PostgreSQL '
  'still refuses an UPDATE of any other column of such a row (20261023140000).';

-- ─── 3. self-check ──────────────────────────────────────────────────────────
--
--  Reads the catalogue for the shape, then probes the behaviour through the
--  table without leaving a row behind. The trick is the one 20261022143000 uses:
--  the CHECK is evaluated while the row is built and the foreign keys only when
--  the statement ends, so an INSERT naming a company that does not exist dies on
--  `receipts_company_id_fkey` (23503) when the CHECK admitted the date, and on
--  `receipts_date_plausible` (23514) when it did not. Two different SQLSTATEs,
--  neither of which can be reached by a row actually being stored — and an
--  INSERT that succeeded falls through to a RAISE and fails the release.
--
--  Other CHECKs on this table also raise 23514, so every refusal is compared by
--  CONSTRAINT_NAME and never by SQLSTATE alone.

DO $check$
DECLARE
  -- (date, must the constraint admit it, why this value is in the list)
  c_cases CONSTANT text[][] := ARRAY[
    ['2026-10-23', 'admit',  'the day this was written; the newest genuine row'],
    ['2025-09-04', 'admit',  'the oldest genuine receipt on production'],
    ['2026-12-31', 'admit',  'a receipt dated a little ahead, which is legitimate'],
    ['2027-10-23', 'admit',  'a year ahead; still admitted, by design'],
    ['2015-01-01', 'admit',  'the lower bound itself, inclusive'],
    ['2050-12-31', 'admit',  'the last day the upper bound admits'],
    ['2051-01-01', 'refuse', 'the upper bound itself, exclusive'],
    ['2072-05-27', 'refuse', 'a real absurd row on production'],
    ['2921-04-08', 'refuse', 'the other real absurd row on production'],
    ['2014-12-31', 'refuse', 'one day below the lower bound'],
    ['0226-01-01', 'refuse', 'a year typed with a digit dropped'],
    ['1026-05-27', 'refuse', 'a year typed with the leading digit wrong']
  ];
  c_name  CONSTANT text := 'receipts_date_plausible';
  c_def   CONSTANT text :=
    'CHECK (((date >= ''2015-01-01''::date) AND (date < ''2051-01-01''::date))) NOT VALID';

  v_n      int;
  v_def    text;
  v_cols   text;
  v_funcs  text;
  v_valid  boolean;
  v_want   text;
  v_got    text;
  v_con    text;
  i        int;
BEGIN
  -- 1. it exists, as a CHECK, on public.receipts.
  SELECT count(*) INTO v_n
    FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'public.receipts'::regclass
     AND c.conname  = c_name
     AND c.contype  = 'c';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'self-check 1: public.receipts has no CHECK named %', c_name;
  END IF;

  -- 2. it is NOT VALID, and must stay so. A later VALIDATE would fail on the
  --    rows production already holds, so reaching this state means somebody
  --    either validated it or rewrote those rows; both are decisions that have
  --    to be made on purpose, and neither may ride along in a release.
  SELECT c.convalidated INTO v_valid
    FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'public.receipts'::regclass AND c.conname = c_name;
  IF v_valid THEN
    RAISE EXCEPTION
      'self-check 2: % is validated. This migration adds it NOT VALID on purpose: production holds receipts dated 2072-05-27 and 2921-04-08, which are the owner''s to correct, and VALIDATE cannot succeed while they stand.',
      c_name;
  END IF;

  -- 3. it covers the date column and nothing else.
  --
  --    Checks 3 and 4 are deliberately ahead of the exact-text check in 5.
  --    Check 5 catches almost any change to the expression, so whichever of the
  --    three runs first is the one that reports; putting the specific ones in
  --    front means a reader is told WHY their change matters — which column got
  --    swept in, or which function will be refused at 42501 — instead of being
  --    handed a string diff to interpret. Measured: without this order, a CHECK
  --    widened to cover `expense` and a CHECK rewritten to call a function were
  --    both reported by check 5 alone.
  SELECT string_agg(a.attname, ', ' ORDER BY a.attname) INTO v_cols
    FROM pg_catalog.pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey) AS k(attnum)
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.conrelid = 'public.receipts'::regclass AND c.conname = c_name;
  IF v_cols IS DISTINCT FROM 'date' THEN
    RAISE EXCEPTION
      'self-check 3: % covers (%) and not the date column alone. This constraint is about one typed field; a column swept into it is refused on every write of that column too.',
      c_name, v_cols;
  END IF;

  -- 4. it calls no function. A CHECK is evaluated as the role writing the row,
  --    and that role is `authenticated`, which holds no USAGE on app_private and
  --    no EXECUTE on anything in it: a function in the expression would refuse
  --    every Beleg the screen saves with 42501. Two date constants need nothing
  --    of anyone, and this asserts it stays that way (20261022143000's rule).
  SELECT string_agg(d.refobjid::regprocedure::text, ', ') INTO v_funcs
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_depend d
      ON d.classid = 'pg_catalog.pg_constraint'::regclass AND d.objid = c.oid
     AND d.refclassid = 'pg_catalog.pg_proc'::regclass
   WHERE c.conrelid = 'public.receipts'::regclass AND c.conname = c_name;
  IF v_funcs IS NOT NULL THEN
    RAISE EXCEPTION
      'self-check 4: % now depends on a function (%). A CHECK runs as the writing role, which cannot execute app_private.*; every Belege write would die 42501.',
      c_name, v_funcs;
  END IF;

  -- 5. the expression is the one intended, character for character. A widened
  --    bound is a decision and must come with its own migration and its own
  --    revisit date, not as an edit nobody reads.
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'public.receipts'::regclass AND c.conname = c_name;
  IF v_def IS DISTINCT FROM c_def THEN
    RAISE EXCEPTION 'self-check 5: % is not the expression this migration wrote; it is now: %',
      c_name, v_def;
  END IF;

  -- 6. the behaviour, through the table, for all twelve dates.
  FOR i IN 1 .. array_length(c_cases, 1) LOOP
    v_want := c_cases[i][2];
    BEGIN
      INSERT INTO public.receipts
             (company_id, receipt_number, date, description, driver_name)
      VALUES (gen_random_uuid(), 'BEL-selfcheck-20261023140000',
              c_cases[i][1]::date, 'self-check', 'self-check');
      RAISE EXCEPTION
        'self-check 6: the probe row for % was STORED. It names a company that does not exist, so it should have died on receipts_company_id_fkey; this migration must not leave a receipt behind.',
        c_cases[i][1];
    EXCEPTION
      WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
        IF v_con IS DISTINCT FROM c_name THEN
          RAISE EXCEPTION 'self-check 6: % was refused by % and not by %; the probe is measuring another constraint',
            c_cases[i][1], coalesce(nullif(v_con, ''), '<unnamed>'), c_name;
        END IF;
        v_got := 'refuse';
      WHEN foreign_key_violation THEN
        v_got := 'admit';
    END;

    IF v_got IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION 'self-check 6: the constraint should % % (%), but it did %',
        v_want, c_cases[i][1], c_cases[i][3], v_got;
    END IF;
  END LOOP;

  RAISE NOTICE
    'ok  receipts_date_plausible: NOT VALID, covers date alone, calls nothing, and % dates (2015-01-01 .. 2050-12-31 admitted, 2072-05-27 and 2921-04-08 refused) agree. REVISIT BEFORE 2050.',
    array_length(c_cases, 1);
END
$check$;
