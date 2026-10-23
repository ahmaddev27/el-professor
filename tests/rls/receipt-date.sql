/*
  A Beleg's date must be a date a Beleg can have (20261023140000).

  `public.receipts.date` was a plain `date` column with no constraint, so a typo
  in the year was stored and kept: production holds receipts dated 2072-05-27
  and 2921-04-08. The migration adds one CHECK, `receipts_date_plausible`
  (2015-01-01 inclusive .. 2051-01-01 exclusive), NOT VALID. This file is the
  kit's side of that claim.

  ## What each section says, and why it is not obvious

  0. The catalogue: the constraint is there, is NOT VALID, covers the date
     column alone, calls no function, and reads exactly as the migration wrote
     it. And the tenancy shape of the table is untouched — four policies, both
     context triggers — because this migration was allowed to add a CHECK and
     nothing else, and a restatement that lost a policy would otherwise pass
     every probe below.

  1. The bounds, through real INSERTs shaped the way the Belege screen sends
     them. Twelve dates, each with the reason it is in the list: the two values
     production actually holds, both bounds and the day on each side of them,
     and three year typos. Every refusal is compared by the CONSTRAINT's name,
     never by SQLSTATE alone, because six other CHECKs on this table also raise
     23514 and a probe that read only the SQLSTATE would pass if the refusal came
     from `receipts_payment_method_check`.

  2. The same battery as the principals who write Belege: a company
     administrator and an editor, who both hold can_edit on the `receipts` page
     and are therefore decided by the constraint alone; and a viewer, who is
     refused by the page gate first, with a different SQLSTATE (42501, not
     23514). That contrast is the point — it shows the battery is reaching the
     constraint and not some other wall.

     The viewer is probed with an ORDINARY date on purpose. With an absurd one
     the answer depends on whether PostgreSQL evaluates the RLS WITH CHECK or
     the table's CHECK constraints first, which is an implementation detail this
     file did not measure; pinning it would be measuring PostgreSQL's internals
     rather than this constraint.

  3. NOT VALID, recorded and not endorsed. Built by dropping the constraint,
     filing the row the way a database from before this migration can hold it,
     and adding the constraint back exactly as the catalogue spells it. Measured:
     the row stays readable, a DELETE of it is allowed, an UPDATE that also fixes
     the date is allowed, a new absurd row is still refused — and an UPDATE of
     ANOTHER column of that row is REFUSED. The last line is what most people
     expect NOT VALID to buy and it does not: an UPDATE re-checks the new row
     version, which still breaks the rule whatever column was touched. The same
     was recorded for `driver_notes` in 20261022143000. `VALIDATE CONSTRAINT`
     fails while the row stands, which is why the migration does not attempt it.

  4. One measured property of the engine the migration's header rests on: a
     CHECK containing `CURRENT_DATE` is ACCEPTED by PostgreSQL. The reason the
     upper bound is a fixed date is therefore not "the engine refuses a
     non-immutable CHECK" — it does not — but that a time-dependent bound makes
     a dump unrestorable. This section pins the premise so the header's argument
     cannot quietly become folklore.

  5. The mutation control, which is what makes sections 1 and 2 worth reading.
     The battery is run against the real constraint (no mismatch), against three
     deliberately broken ones with an exact countable number of mismatches each,
     and again against the real one after the rolled-back mutations.

  ## What it does not claim

  Tenancy and the role gate on this table in general (matrix.sql,
  tenant-state.sql and permission-coverage.sql own those), the support-write
  audit (support-write-audit.sql), and anything about `income.date` or
  `cash_transactions.date`, which the migration deliberately left alone because
  neither carries a measured defect.

  Collect-then-raise: every probe is recorded and the file fails at the end, so
  one run answers everything instead of stopping at the first surprise. Runs
  inside BEGIN ... ROLLBACK, so the files after it see only the migrations and
  the seeds. Probe numbers are never reused.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _rd_out (
  n        integer PRIMARY KEY,
  label    text    NOT NULL,
  actual   text    NOT NULL,
  expected text    NOT NULL,
  matched  boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _rd_rec(p_n integer, p_label text, p_actual text, p_expected text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ok boolean := p_actual IS NOT DISTINCT FROM p_expected;
BEGIN
  INSERT INTO _rd_out VALUES (p_n, p_label, coalesce(p_actual, '<null>'), p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', coalesce(p_actual, '<null>');
  END IF;
END $$;

/* The kit's principals (seed.sql). admin and editor both hold can_edit on the
   `receipts` page (roles-seed.sql); viewer holds it nowhere. */
CREATE OR REPLACE FUNCTION _rd_uid(p_who text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_who
    WHEN 'admin'  THEN 'a0000000-0000-4000-8000-000000000001'::uuid
    WHEN 'editor' THEN 'a0000000-0000-4000-8000-000000000002'::uuid
    WHEN 'viewer' THEN 'a0000000-0000-4000-8000-000000000003'::uuid
    WHEN 'owner'  THEN 'a0000000-0000-4000-8000-000000000001'::uuid
  END
$$;

/*
  Become a principal for the rest of the current subtransaction. The plans go
  first: schema USAGE and function EXECUTE are resolved when a statement is
  planned, the owner runs every fixture, and a plan the owner cached would let
  every principal after it through (matrix.sql's `_mx_become` has the account).
*/
CREATE OR REPLACE FUNCTION _rd_as(p_who text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  EXECUTE 'DISCARD PLANS';
  IF p_who = 'owner' THEN
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', _rd_uid(p_who)::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.session_id', _rd_uid(p_who)::text, true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE OR REPLACE FUNCTION _rd_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/*
  Runs one statement as one principal in a subtransaction that is always rolled
  back, and says what happened:

      `rows N`                          a write, and how many rows it touched
      the scalar                        a SELECT
      `ERR <sqlstate> <constraint>`     a refusal, by the constraint's name
      `ERR <sqlstate> -`                ... or bare (a row-level security refusal)

  The constraint's name is what tells `receipts_date_plausible` apart from the
  six other CHECKs on this table, all of which raise 23514.
*/
CREATE OR REPLACE FUNCTION _rd_try(p_who text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_con   text;
BEGIN
  BEGIN
    PERFORM _rd_as(p_who);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ009' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_con = CONSTRAINT_NAME;
      v_out := 'ERR ' || v_state || ' ' || coalesce(nullif(v_con, ''), '-');
  END;
  PERFORM _rd_reset();
  RETURN v_out;
END $$;

/* Every column the Belege screen's save sends that matters here. Company A and
   the principals are the seed's; user_id stays NULL so the fixture's stubbed
   auth.users is never involved. */
CREATE OR REPLACE FUNCTION _rd_insert_sql(p_date text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT format(
    'INSERT INTO receipts (company_id, receipt_number, date, description, driver_name, expense, payment_method) '
    'VALUES (%L, %L, %L, %L, %L, 12.34, %L)',
    'c0000000-0000-4000-8000-00000000000a',
    'BEL-rd-' || replace(p_date, '-', ''), p_date, 'rd probe', 'Driver A', 'bar')
$$;

/* The twelve dates and what the constraint must do with each. Written out as a
   literal here; the migration's self-check carries the same list, so the two
   cannot drift apart without one of them failing by name. */
CREATE OR REPLACE FUNCTION _rd_cases()
RETURNS TABLE (d text, want text, why text) LANGUAGE sql IMMUTABLE AS $$
  VALUES ('2026-10-23', 'admit',  'the day the migration was written; newest genuine row'),
         ('2025-09-04', 'admit',  'the oldest genuine receipt on production'),
         ('2026-12-31', 'admit',  'a receipt dated a little ahead, which is legitimate'),
         ('2027-10-23', 'admit',  'a year ahead; still admitted, by design'),
         ('2015-01-01', 'admit',  'the lower bound itself, inclusive'),
         ('2050-12-31', 'admit',  'the last day the upper bound admits'),
         ('2051-01-01', 'refuse', 'the upper bound itself, exclusive'),
         ('2072-05-27', 'refuse', 'a real absurd row on production'),
         ('2921-04-08', 'refuse', 'the other real absurd row on production'),
         ('2014-12-31', 'refuse', 'one day below the lower bound'),
         ('0226-01-01', 'refuse', 'a year typed with a digit dropped'),
         ('1026-05-27', 'refuse', 'a year typed with the leading digit wrong')
$$;

/* What a principal who passes the page gate should be told for one date. */
CREATE OR REPLACE FUNCTION _rd_expected(p_want text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_want WHEN 'admit' THEN 'rows 1'
                     ELSE 'ERR 23514 receipts_date_plausible' END
$$;

/* Runs the whole battery as one principal and returns the dates that did not
   answer as expected, so a mutation can be counted rather than eyeballed. */
CREATE OR REPLACE FUNCTION _rd_battery(p_who text)
RETURNS TABLE (d text, want text, got text) LANGUAGE plpgsql AS $$
DECLARE r record; v text;
BEGIN
  FOR r IN SELECT * FROM _rd_cases() LOOP
    v := _rd_try(p_who, _rd_insert_sql(r.d));
    IF v IS DISTINCT FROM _rd_expected(r.want) THEN
      RETURN QUERY SELECT r.d, _rd_expected(r.want), v;
    END IF;
  END LOOP;
END $$;

-- ─── 0. the catalogue, and the shape this migration was not allowed to touch ─

DO $$
DECLARE
  v text;
BEGIN
  PERFORM _rd_rec(1, 'receipts_date_plausible exists as a CHECK on public.receipts',
    (SELECT count(*)::text FROM pg_constraint
      WHERE conrelid = 'public.receipts'::regclass
        AND conname = 'receipts_date_plausible' AND contype = 'c'), '1');

  PERFORM _rd_rec(2, 'it is NOT VALID, and a later VALIDATE is a decision and not a tidy-up',
    (SELECT convalidated::text FROM pg_constraint
      WHERE conrelid = 'public.receipts'::regclass AND conname = 'receipts_date_plausible'),
    'false');

  PERFORM _rd_rec(3, 'the expression is the one the migration wrote',
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid = 'public.receipts'::regclass AND conname = 'receipts_date_plausible'),
    'CHECK (((date >= ''2015-01-01''::date) AND (date < ''2051-01-01''::date))) NOT VALID');

  PERFORM _rd_rec(4, 'it covers the date column and nothing else',
    (SELECT string_agg(a.attname, ', ' ORDER BY a.attname)
       FROM pg_constraint c
       CROSS JOIN LATERAL unnest(c.conkey) AS k(attnum)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conrelid = 'public.receipts'::regclass AND c.conname = 'receipts_date_plausible'),
    'date');

  -- A CHECK runs as the role writing the row, and `authenticated` cannot reach
  -- app_private; a function in the expression would refuse every Beleg the
  -- screen saves with 42501 (20261022143000's measured lesson).
  PERFORM _rd_rec(5, 'it depends on no function, so it needs no privilege of anyone',
    (SELECT coalesce(string_agg(d.refobjid::regprocedure::text, ', '), 'none')
       FROM pg_constraint c
       JOIN pg_depend d ON d.classid = 'pg_catalog.pg_constraint'::regclass AND d.objid = c.oid
        AND d.refclassid = 'pg_catalog.pg_proc'::regclass
      WHERE c.conrelid = 'public.receipts'::regclass AND c.conname = 'receipts_date_plausible'),
    'none');

  -- The migration adds a CHECK and nothing else. If it had restated a policy or
  -- dropped a trigger, every probe below would still pass.
  PERFORM _rd_rec(6, 'the four tenancy policies are untouched',
    (SELECT string_agg(polname, ', ' ORDER BY polname) FROM pg_policy
      WHERE polrelid = 'public.receipts'::regclass),
    'receipts_delete, receipts_insert, receipts_select, receipts_update');

  PERFORM _rd_rec(7, 'both platform context triggers are untouched',
    (SELECT string_agg(tgname, ', ' ORDER BY tgname) FROM pg_trigger
      WHERE tgrelid = 'public.receipts'::regclass AND NOT tgisinternal),
    'record_support_write, refuse_read_only_context_write');

  -- The sibling plausibility CHECKs this migration joined. Named so a release
  -- that drops one while adding ours is caught here.
  SELECT string_agg(conname, ', ' ORDER BY conname) INTO v
    FROM pg_constraint
   WHERE conrelid = 'public.receipts'::regclass AND contype = 'c'
     AND conname LIKE '%_plausible';
  PERFORM _rd_rec(8, 'it joins the four existing plausibility CHECKs rather than replacing them',
    v, 'receipts_date_plausible, receipts_litres_plausible, receipts_odometer_plausible, '
       'receipts_price_per_litre_plausible, receipts_range_plausible');
END $$;

-- ─── 1. the bounds, as a company administrator ──────────────────────────────

DO $$
DECLARE r record; n int := 10;
BEGIN
  FOR r IN SELECT * FROM _rd_cases() LOOP
    PERFORM _rd_rec(n, format('admin inserts %s (%s)', r.d, r.why),
      _rd_try('admin', _rd_insert_sql(r.d)), _rd_expected(r.want));
    n := n + 1;
  END LOOP;
END $$;

-- ─── 2. the principals: the gate and the constraint are different walls ─────

-- A good receipt that outlives a probe's subtransaction, so the UPDATE path can
-- be reached at all: `_rd_try` always rolls back, so a row it inserts is gone
-- before the next statement. Filed as the owner, deleted at the end of the
-- section, and the whole file is inside BEGIN ... ROLLBACK anyway.
INSERT INTO receipts (id, company_id, receipt_number, date, description, driver_name)
VALUES ('a7200000-0000-4000-8000-000000000001',
        'c0000000-0000-4000-8000-00000000000a', 'BEL-rd-good', '2026-10-20',
        'rd good', 'Driver A');

DO $$
BEGIN
  -- An editor holds can_edit on `receipts`, so the constraint decides.
  PERFORM _rd_rec(30, 'editor inserts an ordinary date: admitted',
    _rd_try('editor', _rd_insert_sql('2026-10-20')), 'rows 1');
  PERFORM _rd_rec(31, 'editor inserts 2921-04-08: refused by the date CHECK, by name',
    _rd_try('editor', _rd_insert_sql('2921-04-08')), 'ERR 23514 receipts_date_plausible');

  -- A viewer holds it nowhere, so the page gate refuses an ORDINARY receipt
  -- with a different SQLSTATE. This is the control that says the probes above
  -- reached the constraint and not some other wall.
  PERFORM _rd_rec(32, 'viewer inserts an ordinary date: refused by the page gate (42501, not 23514)',
    _rd_try('viewer', _rd_insert_sql('2026-10-20')), 'ERR 42501 -');

  -- An UPDATE is checked too, not only an INSERT. That is the half a constraint
  -- added for "new rows" is most easily assumed to leave open.
  PERFORM _rd_rec(33, 'admin updates a good receipt to an absurd date: refused',
    _rd_try('admin', 'UPDATE receipts SET date = DATE ''2921-04-08'' '
                  || 'WHERE id = ''a7200000-0000-4000-8000-000000000001'''),
    'ERR 23514 receipts_date_plausible');
  PERFORM _rd_rec(34, 'admin updates the same receipt to another ordinary date: accepted',
    _rd_try('admin', 'UPDATE receipts SET date = DATE ''2026-09-30'' '
                  || 'WHERE id = ''a7200000-0000-4000-8000-000000000001'''),
    'rows 1');
END $$;

DELETE FROM receipts WHERE id = 'a7200000-0000-4000-8000-000000000001';

-- ─── 3. NOT VALID: a row that already breaks the rule ───────────────────────
-- Built by dropping the constraint, filing the row the way a database from
-- before this migration can hold it, and adding the constraint back exactly as
-- the catalogue spells it. All in one subtransaction that is rolled back, so the
-- real constraint is untouched afterwards.

-- ALTER TABLE refuses a table with pending trigger events; fire any deferred
-- ones first.
SET CONSTRAINTS ALL IMMEDIATE;

CREATE OR REPLACE FUNCTION _rd_legacy() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  c_bad constant uuid := 'a7200000-0000-4000-8000-000000000009';
  v_def text;
  v     jsonb := '{}';
BEGIN
  BEGIN
    SELECT regexp_replace(pg_get_constraintdef(oid), ' NOT VALID$', '')
      INTO v_def
      FROM pg_constraint
     WHERE conrelid = 'public.receipts'::regclass AND conname = 'receipts_date_plausible';

    EXECUTE 'ALTER TABLE public.receipts DROP CONSTRAINT receipts_date_plausible';
    INSERT INTO receipts (id, company_id, receipt_number, date, description, driver_name)
    VALUES (c_bad, 'c0000000-0000-4000-8000-00000000000a', 'BEL-rd-legacy',
            '2921-04-08', 'rd legacy', 'Driver A');
    EXECUTE 'ALTER TABLE public.receipts ADD CONSTRAINT receipts_date_plausible '
            || v_def || ' NOT VALID';

    v := v || jsonb_build_object('state',
      (SELECT convalidated::text FROM pg_constraint
        WHERE conrelid = 'public.receipts'::regclass AND conname = 'receipts_date_plausible'));
    v := v || jsonb_build_object('read',
      _rd_try('admin', format('SELECT date::text FROM receipts WHERE id = %L', c_bad)));
    v := v || jsonb_build_object('new',
      _rd_try('admin', _rd_insert_sql('2072-05-27')));
    v := v || jsonb_build_object('edit_other',
      _rd_try('admin', format($q$UPDATE receipts SET description = 'edited' WHERE id = %L$q$, c_bad)));
    v := v || jsonb_build_object('fix',
      _rd_try('admin', format($q$UPDATE receipts SET date = DATE '2026-04-08' WHERE id = %L$q$, c_bad)));
    v := v || jsonb_build_object('delete_row',
      _rd_try('admin', format($q$DELETE FROM receipts WHERE id = %L$q$, c_bad)));

    -- VALIDATE is not an INSERT; run it directly and read what it says.
    BEGIN
      EXECUTE 'ALTER TABLE public.receipts VALIDATE CONSTRAINT receipts_date_plausible';
      v := v || jsonb_build_object('validate_dirty', 'validated');
    EXCEPTION WHEN check_violation THEN
      v := v || jsonb_build_object('validate_dirty', 'ERR ' || SQLSTATE);
    END;

    UPDATE receipts SET date = DATE '2026-04-08' WHERE id = c_bad;
    EXECUTE 'ALTER TABLE public.receipts VALIDATE CONSTRAINT receipts_date_plausible';
    v := v || jsonb_build_object('validate_clean',
      (SELECT convalidated::text FROM pg_constraint
        WHERE conrelid = 'public.receipts'::regclass AND conname = 'receipts_date_plausible'));

    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'rolled back';
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN
    NULL;
  END;
  RETURN v;
END $$;

DO $$
DECLARE v jsonb := _rd_legacy();
BEGIN
  PERFORM _rd_rec(40, 'the constraint, re-added over a legacy row, is NOT VALID',
    v ->> 'state', 'false');
  PERFORM _rd_rec(41, 'the legacy absurd row stays readable, which is what NOT VALID buys',
    v ->> 'read', '2921-04-08');
  PERFORM _rd_rec(42, 'a NEW absurd row is still refused while the constraint is NOT VALID',
    v ->> 'new', 'ERR 23514 receipts_date_plausible');
  PERFORM _rd_rec(43, 'RECORDED, NOT ENDORSED: editing only the description of the legacy row is REFUSED '
                   || '(an UPDATE re-checks the new row version, whatever column it touched)',
    v ->> 'edit_other', 'ERR 23514 receipts_date_plausible');
  PERFORM _rd_rec(44, 'correcting its date is accepted', v ->> 'fix', 'rows 1');
  PERFORM _rd_rec(45, 'deleting it is never checked', v ->> 'delete_row', 'rows 1');
  PERFORM _rd_rec(46, 'VALIDATE fails while the absurd row stands, which is why the migration does not try',
    v ->> 'validate_dirty', 'ERR 23514');
  PERFORM _rd_rec(47, 'and succeeds once the date is corrected', v ->> 'validate_clean', 'true');
  PERFORM _rd_rec(48, 'the real constraint is back and still NOT VALID after the rolled-back scenario',
    (SELECT convalidated::text FROM pg_constraint
      WHERE conrelid = 'public.receipts'::regclass AND conname = 'receipts_date_plausible'),
    'false');
END $$;

-- ─── 4. the premise the header rests on: CURRENT_DATE in a CHECK is accepted ─
-- The usual reason given for a fixed bound — "a CHECK expression must be
-- IMMUTABLE" — is not true on this engine, so the migration's argument is the
-- other one: a time-dependent bound makes a dump unrestorable, because pg_dump
-- emits a validated CHECK inline in CREATE TABLE and COPY enforces it. This
-- probe pins the premise, on a throwaway table so nothing on receipts moves.

DO $$
DECLARE v text;
BEGIN
  BEGIN
    CREATE TEMP TABLE _rd_probe (d date NOT NULL);
    EXECUTE 'ALTER TABLE _rd_probe ADD CONSTRAINT _rd_probe_d CHECK (d <= CURRENT_DATE + 365)';
    v := 'accepted';
  EXCEPTION WHEN OTHERS THEN
    v := 'ERR ' || SQLSTATE;
  END;
  PERFORM _rd_rec(50, 'a CHECK containing CURRENT_DATE is ACCEPTED by PostgreSQL, so immutability '
                   || 'is not the reason the upper bound is a fixed date', v, 'accepted');
  DROP TABLE IF EXISTS _rd_probe;
END $$;

-- ─── 5. the mutation control ────────────────────────────────────────────────
-- Break the rule one way at a time, in a subtransaction that is rolled back, and
-- count what the battery catches. A battery that stayed at zero here would be
-- reading nothing. The counts are exact because the battery is: twelve dates, of
-- which six must be admitted and six refused.

SET CONSTRAINTS ALL IMMEDIATE;

CREATE OR REPLACE FUNCTION _rd_mutate(p_def text) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE v_n int;
BEGIN
  BEGIN
    EXECUTE 'ALTER TABLE public.receipts DROP CONSTRAINT receipts_date_plausible';
    IF p_def IS NOT NULL THEN
      EXECUTE 'ALTER TABLE public.receipts ADD CONSTRAINT receipts_date_plausible '
              || p_def || ' NOT VALID';
    END IF;
    SELECT count(*) INTO v_n FROM _rd_battery('admin');
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = v_n::text;
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN
    v_n := SQLERRM::int;
  END;
  RETURN v_n;
END $$;

DO $$
BEGIN
  PERFORM _rd_rec(60, 'the battery finds nothing wrong with the real constraint',
    (SELECT count(*)::text FROM _rd_battery('admin')), '0');

  -- No constraint at all: all six absurd dates are stored.
  PERFORM _rd_rec(61, 'MUTATION no constraint: the six dates that must be refused are all stored',
    _rd_mutate(NULL)::text, '6');

  -- Upper bound pulled in to 2027-01-01: 2027-10-23 and 2050-12-31 are refused.
  PERFORM _rd_rec(62, 'MUTATION upper bound 2027-01-01: the two dates above it are refused',
    _rd_mutate('CHECK (date >= DATE ''2015-01-01'' AND date < DATE ''2027-01-01'')')::text, '2');

  -- Lower bound pushed up to 2026-01-01: 2025-09-04 and 2015-01-01 are refused.
  PERFORM _rd_rec(63, 'MUTATION lower bound 2026-01-01: the two dates below it are refused',
    _rd_mutate('CHECK (date >= DATE ''2026-01-01'' AND date < DATE ''2051-01-01'')')::text, '2');

  -- And the real constraint is back, so the mutations were all rolled back.
  PERFORM _rd_rec(64, 'the battery finds nothing wrong again after the rolled-back mutations',
    (SELECT count(*)::text FROM _rd_battery('admin')), '0');
  PERFORM _rd_rec(65, 'and the real constraint is still the one the migration wrote',
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid = 'public.receipts'::regclass AND conname = 'receipts_date_plausible'),
    'CHECK (((date >= ''2015-01-01''::date) AND (date < ''2051-01-01''::date))) NOT VALID');
END $$;

-- ─── the verdict ────────────────────────────────────────────────────────────

SELECT 'receipt-date: ' || count(*) FILTER (WHERE matched) || '/' || count(*) || ' probes matched'
  FROM _rd_out;

DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(format(E'\n  %s  %s\n      expected: %s\n      actual:   %s',
                           lpad(n::text, 2), label, expected, actual), '' ORDER BY n)
    INTO v_bad
    FROM _rd_out WHERE NOT matched;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'receipt-date: % probe(s) did not match:%',
      (SELECT count(*) FROM _rd_out WHERE NOT matched), v_bad;
  END IF;
END $$;

ROLLBACK;
