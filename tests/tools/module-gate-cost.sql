/*
  What the module write gate (20261027120000) costs on a bulk write.

  A standalone instrument, deliberately outside `tests/rls/` so nothing in the
  kit runs it — `tests/tools/plan-cache-repro.sql`'s precedent. It asserts no
  outcome: it measures, prints, and leaves the judgement to the reader. Run it
  the way the kit is run (CLAUDE.md, under `app_private`), against a throwaway
  database, never a stack's. The kit builds a suitable one with `--keep`.

  ## The claim being measured, and why it is not taken on trust

  Docs/design/per-company-modules.md section 5 argues that wall C is cheap
  because the policies embed the gate as `(SELECT
  public.current_role_permits('<page>', true))` — the wrapped form built by the
  `v_gate_w` / `v_gate_d` `format()` calls in 20260917130000 — and an
  uncorrelated scalar subquery is evaluated **once per statement**, not once per
  row. The design says in so many words that the expectation "must still be
  measured on the import path before the slice ships", because this repository's
  record is that a reading of PostgreSQL's optimiser has been **wrong three
  times, in both directions** (CLAUDE.md's plan-cache table), each time reading
  as confirmed.

  ## What was measured, 27.10.2026, on the VPS, supabase/postgres 17.6, 1 CPU

  **The plan answers it, and the answer is yes — for UPDATE and for INSERT.**
  Section 2 below prints the plan of each. Both carry the gate as an `InitPlan`
  with `loops=1`:

      Insert on public.receipts (actual rows=0 loops=1)
        InitPlan 1
          ->  Result (actual rows=1 loops=1)
                Output: get_active_company_id()
        InitPlan 2
          ->  Result (actual rows=1 loops=1)
                Output: current_role_permits('receipts'::text, true)
        ...
        ->  Function Scan on generate_series g (actual rows=500 loops=1)

  500 rows inserted, the gate evaluated once. The UPDATE is the stronger
  demonstration of the same thing, because its filter names the precomputed
  result and the scan beside it is large:

      Update on public.receipts (actual rows=0 loops=1)
        InitPlan 7
          ->  Result (actual rows=1 loops=1)
        ...
        ->  Bitmap Heap Scan on public.receipts (actual rows=28501 loops=1)
              Filter: ((((company_id = (InitPlan 6).col1) AND (InitPlan 7).col1)
                        OR (InitPlan 8).col1) AND …)

  **28,501 rows scanned, the gate evaluated once.** So on a Fahrtenbuch import
  that writes thousands of trips in one statement, the added work is one
  `get_active_company_id()` and one indexed lookup for the whole statement.

  **The timing cannot see it, which is the expected result and not a failure of
  the measurement.** Six 2000-row inserts per side:

      WITH    the term: 25.1, 24.4, 26.0, 59.0, 27.0, 39.7 ms   -> 24.4 .. 59.0
      WITHOUT the term: 26.4, 28.5, 24.4, 23.4, 24.5, 24.4 ms   -> 23.4 .. 28.5

  The bands overlap, the medians are 26.0 against 24.4 ms, and the WITH side's
  two outliers are scheduler noise on a 1-CPU container rather than anything
  about the term — the same configuration produced 25.8..29.1 ms on an earlier
  run of the identical statement. A once-per-statement lookup is a few
  microseconds against a ~25 ms statement, so this instrument is some three
  orders of magnitude too coarse to resolve it. The honest reading is "below the
  noise floor here", never "exactly zero".

  ## The trap this instrument fell into first, recorded because it would recur

  Its first version timed each side **once**, in the order WITH then WITHOUT,
  and reported `delta per 2000 rows: 11.1 ms / delta per row: 5.563 us`. Both
  figures are artefacts. 5.563 µs/row has exactly the shape of a per-row cost
  and would have been written up as one — the InitPlan reasoning refuted — when
  in fact the WITH side was simply the first 2000-row statement in the session
  and paid for parse, plan and first index touch that the WITHOUT side then
  found warm. **A single run of each side cannot support a delta smaller than
  the within-side spread**, and nothing in the first version measured that
  spread. So section 1 now runs each side `c_runs` times, prints every figure,
  and prints the two bands rather than a difference of two numbers.
*/

\set ON_ERROR_STOP on
\timing off

BEGIN;

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS banned_until       timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at         timestamptz;

CREATE OR REPLACE FUNCTION _mc_as_admin() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
END $$;

/* One N-row INSERT through the receipts write policy, timed. */
CREATE OR REPLACE FUNCTION _mc_bulk(p_n int, p_tag text) RETURNS numeric
LANGUAGE plpgsql AS $$
DECLARE
  v_t0 timestamptz;
  v_ms numeric;
BEGIN
  PERFORM _mc_as_admin();
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_t0 := clock_timestamp();
  EXECUTE format($q$
    INSERT INTO public.receipts (company_id, receipt_number, date, description, driver_name)
    SELECT %L, %L || g, current_date, 'cost probe', 'Fahrer 1'
      FROM generate_series(1, %s) g
  $q$, 'c0000000-0000-4000-8000-00000000000a', p_tag, p_n);
  v_ms := round(extract(epoch FROM (clock_timestamp() - v_t0)) * 1000, 3);
  EXECUTE 'SET LOCAL ROLE NONE';
  RETURN v_ms;
END $$;

/* 20260917140000's body, verbatim, with no module term — the shape the product
   had the day before this release. Restated here rather than read out of the
   migration: the point is to time that shape, not to prove it is still on disk,
   which is 20261027120000's own self-check 5. */
CREATE OR REPLACE FUNCTION _mc_without_module_term() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  CREATE OR REPLACE FUNCTION public.current_role_permits(p_page text, p_need_edit boolean)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_catalog
  AS $fn$
  DECLARE
    v_uid uuid := auth.uid();
  BEGIN
    IF v_uid IS NULL THEN
      RETURN false;
    END IF;

    IF COALESCE((
         SELECT CASE WHEN p_need_edit THEN rp.can_edit ELSE rp.can_view END
           FROM public.user_profiles up
           JOIN public.roles r
             ON r.id = COALESCE(
                  up.role_id,
                  (SELECT r2.id
                     FROM public.roles r2
                    WHERE r2.name = up.role
                      AND (r2.company_id = up.company_id OR r2.company_id IS NULL)
                    ORDER BY (r2.company_id IS NULL)
                    LIMIT 1))
           JOIN public.role_permissions rp
             ON rp.role_id = r.id
            AND rp.page_key = p_page
          WHERE up.user_id = v_uid
          LIMIT 1
       ), false) THEN
      RETURN true;
    END IF;

    IF app_private.platform_staff_role_of(v_uid) IS NOT NULL
       AND NOT app_private.account_has_company(v_uid) THEN
      RETURN app_private.platform_context_company(true) IS NOT NULL;
    END IF;

    RETURN false;
  END;
  $fn$;
END $$;

-- ─── 1. the two bands ───────────────────────────────────────────────────────

DO $$
DECLARE
  c_rows CONSTANT int := 2000;
  c_runs CONSTANT int := 6;
  i        int;
  v_ms     numeric;
  v_with   numeric[] := '{}';
  v_out    numeric[] := '{}';
BEGIN
  -- Company A holds no module decision, so the gate answers "open" and the
  -- statement does the work it does for a real customer.
  DELETE FROM public.company_modules WHERE company_id = 'c0000000-0000-4000-8000-00000000000a';

  -- Discarded: the first statement of a session pays for parse, plan and the
  -- first touch of every index. Timing it as data is the trap in the header.
  v_ms := _mc_bulk(2000, 'BEL-WARM-');
  RAISE NOTICE 'warm-up, discarded: % ms', v_ms;

  FOR i IN 1..c_runs LOOP
    v_ms := _mc_bulk(c_rows, 'BEL-WITH-' || i || '-');
    v_with := v_with || v_ms;
    RAISE NOTICE 'WITH    the module term, run %: % ms', i, v_ms;
  END LOOP;

  PERFORM _mc_without_module_term();
  -- The function changed, so every cached plan naming it is invalidated: this
  -- side needs its own discarded warm-up for the same reason the first one did.
  v_ms := _mc_bulk(2000, 'BEL-WARM2-');
  RAISE NOTICE 'warm-up, discarded: % ms', v_ms;

  FOR i IN 1..c_runs LOOP
    v_ms := _mc_bulk(c_rows, 'BEL-WITHOUT-' || i || '-');
    v_out := v_out || v_ms;
    RAISE NOTICE 'WITHOUT the module term, run %: % ms', i, v_ms;
  END LOOP;

  RAISE NOTICE '----  % rows per statement, % runs per side  ----', c_rows, c_runs;
  RAISE NOTICE 'WITH    the term: % .. % ms',
    (SELECT min(x) FROM unnest(v_with) x), (SELECT max(x) FROM unnest(v_with) x);
  RAISE NOTICE 'WITHOUT the term: % .. % ms',
    (SELECT min(x) FROM unnest(v_out) x), (SELECT max(x) FROM unnest(v_out) x);
  RAISE NOTICE 'Read the BANDS, not a difference of two numbers. If they '
               'overlap, the term costs less than this instrument can see — '
               'which is what section 2''s loops=1 predicts.';
END $$;

-- ─── 2. the shape behind the figure ─────────────────────────────────────────

/*
  The answer the timing cannot give. Look for the gate as an `InitPlan` whose
  `Result` has `loops=1` while the row source has `rows=500`: that is "once per
  statement", directly, for both of the commands the gate sits on.
*/
DO $$ BEGIN PERFORM _mc_as_admin(); END $$;
SET LOCAL ROLE authenticated;

EXPLAIN (ANALYZE, VERBOSE, COSTS OFF, TIMING OFF, SUMMARY OFF)
INSERT INTO public.receipts (company_id, receipt_number, date, description, driver_name)
SELECT 'c0000000-0000-4000-8000-00000000000a', 'BEL-EXP-' || g, current_date, 'x', 'F'
  FROM generate_series(1, 500) g;

EXPLAIN (ANALYZE, VERBOSE, COSTS OFF, TIMING OFF, SUMMARY OFF)
UPDATE public.receipts SET description = 'cost probe 2'
 WHERE company_id = 'c0000000-0000-4000-8000-00000000000a';

SET LOCAL ROLE NONE;

ROLLBACK;
