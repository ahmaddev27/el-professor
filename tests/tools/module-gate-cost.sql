/*
  What the module write gate (20261027120000) costs on a bulk write.

  A standalone instrument, deliberately outside `tests/rls/` so nothing in the
  kit runs it — `tests/tools/plan-cache-repro.sql`'s precedent. It asserts no
  outcome: it measures, prints, and leaves the judgement to the reader. Run it
  the way the kit is run (CLAUDE.md, under `app_private`), against a throwaway
  database, never a stack's.

  ## The claim being measured, and why it is not taken on trust

  The design document (Docs/design/per-company-modules.md section 5) argues that
  wall C is cheap because the policies embed the gate as
  `(SELECT public.current_role_permits('<page>', true))` — the wrapped form built
  by the `v_gate_w` / `v_gate_d` `format()` calls in 20260917130000 — and an
  uncorrelated scalar subquery is evaluated **once per statement**, not once per
  row. If that is right, the added work on a Fahrtenbuch import that writes
  thousands of trips in one statement is a single extra `get_active_company_id()`
  and a single indexed lookup.

  It is measured rather than reasoned because this repository's own record is
  that a reading of PostgreSQL's optimiser has been **wrong three times, in both
  directions** (CLAUDE.md's plan-cache table), each time reading as confirmed.

  ## The method, and its one real weakness

  A true before/after inside one session, one database and one set of rows: time
  a single N-row `INSERT … SELECT` through the gated policy, then restate
  `current_role_permits` WITHOUT the module term (20260917140000's body verbatim),
  time the identical statement again, and restate the current body back.

  The weakness to state plainly: this is wall-clock on a throwaway container,
  from one run of each side, so it bounds the cost rather than resolving a small
  difference. If the two sides come out within noise of each other, the honest
  reading is "too small to measure here", not "exactly zero". What would settle a
  small difference is many runs, and that is not worth the VPS time for a figure
  this size.
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
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/* One N-row INSERT through the receipts write policy, timed. */
CREATE OR REPLACE FUNCTION _mc_bulk(p_n int, p_tag text) RETURNS interval
LANGUAGE plpgsql AS $$
DECLARE
  v_t0 timestamptz;
  v_dt interval;
BEGIN
  PERFORM _mc_as_admin();
  v_t0 := clock_timestamp();
  EXECUTE format($q$
    INSERT INTO public.receipts (company_id, receipt_number, date, description, driver_name)
    SELECT %L, %L || g, current_date, 'cost probe', 'Fahrer 1'
      FROM generate_series(1, %s) g
  $q$, 'c0000000-0000-4000-8000-00000000000a', p_tag, p_n);
  v_dt := clock_timestamp() - v_t0;
  EXECUTE 'SET LOCAL ROLE NONE';
  RETURN v_dt;
END $$;

DO $$
DECLARE
  c_n    CONSTANT int := 2000;
  v_with    interval;
  v_without interval;
  v_warm    interval;
BEGIN
  -- Company A holds no module decision, so the gate answers "open" and the
  -- statement does the same work it does for a real customer.
  DELETE FROM public.company_modules WHERE company_id = 'c0000000-0000-4000-8000-00000000000a';

  -- A warm-up, discarded: the first statement in a session pays for parsing,
  -- the plan and the first touch of every index.
  v_warm := _mc_bulk(200, 'BEL-WARM-');
  RAISE NOTICE 'warm-up (200 rows, discarded): %', v_warm;

  v_with := _mc_bulk(c_n, 'BEL-WITH-');
  RAISE NOTICE 'WITH the module term:    % rows in %', c_n, v_with;

  -- 20260917140000's body, verbatim, with no module term. Restated here and not
  -- read from the migration, because the point is to time the shape the product
  -- had the day before this release.
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

  -- The function changed, so every cached plan naming it is invalidated; this
  -- side gets its own warm-up for the same reason the first one did.
  v_warm := _mc_bulk(200, 'BEL-WARM2-');

  v_without := _mc_bulk(c_n, 'BEL-WITHOUT-');
  RAISE NOTICE 'WITHOUT the module term: % rows in %', c_n, v_without;

  RAISE NOTICE '----';
  RAISE NOTICE 'delta per % rows: %', c_n, v_with - v_without;
  RAISE NOTICE 'delta per row:    % us',
    round(extract(epoch FROM (v_with - v_without)) * 1000000 / c_n, 3);
END $$;

/*
  And the shape behind the figure: the gate as the policy asks it, on an UPDATE,
  where the wrapped subquery appears in the plan. Read the output for `InitPlan`
  — a gate evaluated once per statement appears there once, with no `loops`
  proportional to the row count.
*/
DO $$ BEGIN PERFORM _mc_as_admin(); END $$;

EXPLAIN (ANALYZE, VERBOSE, COSTS OFF, TIMING OFF, SUMMARY OFF)
UPDATE public.receipts SET description = 'cost probe 2'
 WHERE company_id = 'c0000000-0000-4000-8000-00000000000a';

SET LOCAL ROLE NONE;

ROLLBACK;
