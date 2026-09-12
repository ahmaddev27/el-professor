/*
  # Evaluate the RLS predicates once per query instead of once per row

  ## The measurement

  `user_profiles` took 46,493 sequential scans in 40 hours against 25 rows. The
  table is 160 kB and never leaves shared buffers, so the scans themselves are
  nearly free — the count is a symptom, not the cost. The cost is that the four
  predicate functions all read `user_profiles`, and most policies call them in a
  position the planner evaluates **per row**.

  On `fahrtenbuch_trips` (13,959 rows), counting the rows one company may see:

      (company_id = get_user_company_id()) OR is_user_super_admin()
        -> Filter on each row            75.2 ms   (69.8 / 76.0 / 77.2 repeated)

      (company_id = (SELECT get_user_company_id())) OR (SELECT is_user_super_admin())
        -> InitPlan, evaluated once       1.1 ms   ( 1.8 /  1.2 /  1.1 repeated)

  Same plan, same index-only scan, same 11,720 rows returned. The only
  difference is how many times the function runs. 65x, and it grows with the
  table — which matters because trips are the table that grows.

  Not every policy had the problem: where a predicate happened to be written as
  an IN-subquery the planner already hoisted it into a hashed SubPlan. This
  migration makes the hoisting explicit everywhere rather than depending on
  which shape a policy happened to be written in.

  ## Why wrapping is safe here

  `(SELECT f())` and `f()` return the same value when `f` is STABLE and its
  arguments do not reference the row. Both conditions were checked against the
  live catalogue before writing this:

  - all four functions are STABLE and SECURITY DEFINER;
  - every `current_role_permits` call site passes two literals — nine distinct
    forms, `('cars'::text, true)` and so on, no column references anywhere;
  - no policy was already wrapped, so nothing is double-wrapped.

  If a future policy passes a column into one of these functions, wrapping it
  would produce a correlated subquery: still correct, just not hoisted. It does
  not become wrong, it becomes slow again.

  ## What this does not change

  Not one predicate's meaning. The 24 assertions in `tests/rls/assertions.sql`
  are the check on that claim and pass unchanged — they are what makes a
  mechanical rewrite of 105 policies something other than an act of faith.
*/

-- ─── The rewrite ────────────────────────────────────────────────────────────
-- Applied from the catalogue rather than as 105 hand-written statements: the
-- live definition is the only authority on what each policy currently says, and
-- transcribing them by hand is how a predicate silently loses a clause.

DO $$
DECLARE
  r            record;
  new_qual     text;
  new_check    text;
  clauses      text;
  n_changed    int := 0;
  -- Matches a bare call to one of the four, not preceded by a character that
  -- would make it part of a longer identifier or a qualified name.
  pattern      constant text :=
    '(^|[^[:alnum:]_.])((?:public\.)?(?:get_user_company_id|is_user_super_admin|is_company_admin)\(\)'
    || '|(?:public\.)?current_role_permits\([^()]*\))';
BEGIN
  FOR r IN
    SELECT tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  LOOP
    -- Already done. Worth guarding because the wrap is not idempotent: Postgres
    -- renders the result as `( SELECT f() AS f)`, and the inner `f()` is
    -- preceded by a space, so a second pass would happily wrap it again.
    -- A policy here is either wholly wrapped or wholly not, so testing for one
    -- occurrence settles it.
    CONTINUE WHEN (coalesce(r.qual, '') || ' ' || coalesce(r.with_check, ''))
      ~ '\(\s*SELECT\s+(?:public\.)?(?:get_user_company_id|is_user_super_admin|is_company_admin|current_role_permits)\(';

    new_qual  := regexp_replace(r.qual,       pattern, '\1(SELECT \2)', 'g');
    new_check := regexp_replace(r.with_check, pattern, '\1(SELECT \2)', 'g');

    CONTINUE WHEN new_qual  IS NOT DISTINCT FROM r.qual
              AND new_check IS NOT DISTINCT FROM r.with_check;

    clauses := concat(
      CASE WHEN new_qual  IS NOT NULL THEN ' USING ('      || new_qual  || ')' END,
      CASE WHEN new_check IS NOT NULL THEN ' WITH CHECK (' || new_check || ')' END
    );

    EXECUTE format('ALTER POLICY %I ON public.%I%s', r.policyname, r.tablename, clauses);
    n_changed := n_changed + 1;
  END LOOP;

  RAISE NOTICE 'hoisted % policies', n_changed;
END $$;

-- ─── The check ──────────────────────────────────────────────────────────────
-- Textual comparison against the old definitions would be the obvious check and
-- the wrong one: Postgres re-renders a predicate after ALTER, so whitespace and
-- redundant parentheses move for reasons that mean nothing. What is asserted
-- instead is the property the migration exists to establish — that no call to
-- these functions is left in a per-row position. Meaning is covered by the RLS
-- assertions, which is where it belongs.

-- Postgres regexes have lookahead but no lookbehind, so "a call not preceded by
-- SELECT" cannot be written directly. Delete every correctly wrapped call
-- instead; whatever still names one of the four is a call in a per-row position.
--
-- The ` AS <name>` is not optional decoration to skip over — Postgres adds it
-- when it re-renders the subquery, so `( SELECT is_user_super_admin() AS
-- is_user_super_admin)` is what the catalogue actually holds afterwards.

DO $$
DECLARE
  unhoisted int;
BEGIN
  SELECT count(*) INTO unhoisted
  FROM pg_policies
  WHERE schemaname = 'public'
    AND regexp_replace(
          coalesce(qual, '') || ' ' || coalesce(with_check, ''),
          '\(\s*SELECT\s+(?:public\.)?(?:get_user_company_id\(\)|is_user_super_admin\(\)'
          || '|is_company_admin\(\)|current_role_permits\([^()]*\))'
          || '(?:\s+AS\s+[[:alnum:]_"]+)?\s*\)',
          '', 'g')
        ~ '(get_user_company_id|is_user_super_admin|is_company_admin|current_role_permits)\(';

  IF unhoisted > 0 THEN
    RAISE EXCEPTION '% policies still call an RLS predicate per row', unhoisted;
  END IF;
END $$;
