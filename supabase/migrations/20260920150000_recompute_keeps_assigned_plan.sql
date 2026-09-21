/*
  # The recompute keeps a tier the owner set once every period has ended

  Plan 3.F, a fix to U1 (20260919150000). Live on production since U1 was
  promoted on 19.09.2026.

  ## The defect

  `app_private.recompute_company_subscription` derives `companies.plan` from the
  tier of one coverage row. As U1 wrote it (20260919150000:414-421), that row is
  the live granting row with a tier whose end is furthest away, and the query
  has no condition on whether that end has passed. The UPDATE at :423-431 then
  writes `plan = coalesce(v_plan, plan)`.

  `platform_company_set_plan` assigns `companies.plan` and carries the new tier
  onto every live granting row that has **not ended**
  (20260919150000:1495-1502, `period_end IS NULL OR period_end > now()`), and
  leaves an ended one at the tier it was sold at. While one such row exists,
  the two agree: the recompute's pick is always among them, because an
  open-ended row sorts first and any end ahead of now sorts above any end that
  has passed.

  When **every** granting period of the company has ended, set_plan has no row
  to carry the tier onto, and the recompute's query still finds the ended row
  with the furthest end and reads the old tier off it. That is exactly the
  third branch of the status rule, ('expired', that end) at :402-403: granting
  rows exist and all of them have passed. In the first two branches an unended
  row exists and is the pick; in the last two no granting row exists, the tier
  query finds nothing and the column stands. The tier query at :414-421 runs
  whatever the status half answered, and :426 writes its result. So the next
  recompute — every write that goes through
  `app_private.subscription_coverage_record`, every invoice RPC, and the daily
  sweep once it is wired — writes the old tier back over the owner's change.

  ## The rule chosen

  **The recompute derives a tier only from a granting period that decides
  access now: live, granting, and not ended — `period_end IS NULL OR
  period_end > now()`, the same predicate `platform_company_set_plan` carries
  the tier onto. When no such period carries a tier, `companies.plan` stands,
  exactly as it already stands for a company with no coverage at all.**

  Two properties follow from the ordering argument above, and they are the
  whole of the change:

  - For a company that holds at least one such period, the old body and this
    one pick **the same row**. Nothing changes for it.
  - For a company that holds none, the old body wrote the tier of an ended row
    and this one writes nothing. That population is exactly "every granting
    period with a tier has ended", which is the defect's.

  Put in terms of the recompute's five branches: a tier is derived in the two
  that answer `active` (an open-ended grant, or a granting end ahead of now), and
  never in the three that do not (a grant that has passed, a period that is only
  recorded, nothing live).

  `now()` is the transaction's clock, so inside one transaction set_plan's
  predicate and this one are the same instant. Across transactions the set of
  periods the recompute reads can only shrink with time, and every writer that
  adds a period to it records the company's current tier on it
  (`redeem_activation_code`, `update_company_subscription_manual`,
  `app_private.subscription_invoice_apply` when it creates a row, and the U1
  backfill), so after set_plan every period the recompute can read carries the
  tier set_plan wrote.

  ### Why not the other candidate

  The other shape was to have `platform_company_set_plan` record something the
  recompute respects: a flag or timestamp on `companies`, or the tier stamped
  onto ended periods too. The first is a new column and a second writer to
  restate, for a rule the recompute can state in one predicate. The second
  rewrites history: U1 decided that a period which has ended keeps the tier it
  was sold at, and `tests/rls/subscriptions.sql` section 3c pins it.

  ### The two rules that must still hold

  - **A company with no coverage keeps the plan it already had.** Unchanged:
    with no row the query finds nothing and `coalesce` keeps the column.
  - **An early renewal survives the sweep (U1 self-check 7b, section 3c).** The
    predicate has no term on `period_start`, so a period that starts in the
    future and has not ended is read exactly as set_plan carries onto it. A
    start term here would reopen the downgrade 3c exists for.

  ## What it does not close

  A period can come back into the set the recompute reads **after** set_plan has
  run, still carrying the tier it was recorded at:

  - `app_private.subscription_invoice_apply` (20260919170000:412-421) moves an
    existing invoice row in place and never rewrites its tier, by design (:321-325).
    An open invoice past its grace has a row that has ended; set_plan leaves it
    alone; marking the invoice paid later moves its end to the month's end, and
    the recompute reads the old tier off it.
  - The same function sets `status = 'active'` on a row that
    `update_company_subscription_manual` voided with `p_replace`, because its
    lookup (:358-362) does not filter on status. So a manual edit's
    replacement does not hold against a later apply of that invoice — which is
    an access question, not only a tier question.

  Both need a decision about U2's rule rather than a line in the recompute, so
  they are recorded in HANDOFF.md, and the first is pinned in
  `tests/rls/subscriptions.sql` section 9 as today's behaviour, tagged
  HOLE[revival], so that the fix shows up as a changed expectation.

  ## What this changes, and when

  **At deploy: nothing, for anybody.** This file replaces one function body and
  writes no row. It recomputes no company, so no company's `plan`,
  `subscription_status` or `subscription_expires_at` moves while it applies.

  **Afterwards:** at the next recompute of a company whose every granting
  period with a tier has ended, its `plan` stays what it is instead of going
  back to the ended period's tier. A company whose tier the defect has already
  reverted is **not** restored — its column already holds the old tier, and
  this body leaves it there. The owner sets it again through the screen.
  HANDOFF.md carries the read-only SQL that lists both populations.

  ## The wall (U3, 20260920120000)

  The function stays SECURITY DEFINER and is owned by the role running this
  migration, which is not one of the three API roles, so
  `refuse_direct_subscription_write` lets it through by `current_user` exactly
  as before. It still writes `plan`, `subscription_status` and
  `subscription_expires_at` in one UPDATE of `companies`, so
  `app_private.subscription_column_writes()` finds the same three entries and
  U3's list in `tests/rls/subscriptions.sql` section 8 needs no change. The
  self-check below asks the reader for exactly those three.

  ## SCHEMA_EPOCH stays at 2

  No signature, grant, table or column changes. A rollback re-activates the
  previous release's code against this body, and that code reaches the
  recompute only through the RPCs, whose signatures and answers are unchanged.

  ## Rules followed

  Restated from U1's body (20260919150000:356-433) with one predicate added; the
  PR lists every behaviour of that body and where it is here. Pinned
  `search_path`, SECURITY DEFINER, `REVOKE ALL FROM PUBLIC, anon, authenticated,
  service_role` restated, `ALTER FUNCTION … OWNER TO CURRENT_USER` restated (a
  CREATE OR REPLACE keeps the old owner, see tests/fixtures/owner-simulation.sql),
  and a self-check that can fail. Behaviour is asserted in
  `tests/rls/subscriptions.sql` section 9, not here.
*/

-- ─── 1. The recompute ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.recompute_company_subscription(p_company_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now         timestamptz := now();
  v_grant_open  boolean;
  v_grant_end   timestamptz;
  v_any_end     timestamptz;
  v_plan        text;
  v_status      text;
  v_expires     timestamptz;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'recompute_company_subscription: p_company_id is required' USING ERRCODE = '22023';
  END IF;

  -- NO KEY UPDATE, never FOR UPDATE: rows that reference the company keep
  -- being insertable while this runs, and two writers cannot deadlock on the
  -- key share their own foreign keys hold (the rule salary_cash_receipts
  -- already follows).
  PERFORM 1 FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT bool_or(c.period_end IS NULL), max(c.period_end)
    INTO v_grant_open, v_grant_end
    FROM public.subscription_coverage c
   WHERE c.company_id = p_company_id
     AND c.status = 'active'
     AND c.grants_access;

  SELECT max(c.period_end)
    INTO v_any_end
    FROM public.subscription_coverage c
   WHERE c.company_id = p_company_id
     AND c.status = 'active';

  IF coalesce(v_grant_open, false) THEN
    v_status := 'active'; v_expires := NULL;
  ELSIF v_grant_end IS NOT NULL AND v_grant_end > v_now THEN
    v_status := 'active'; v_expires := v_grant_end;
  ELSIF v_grant_end IS NOT NULL THEN
    v_status := 'expired'; v_expires := v_grant_end;
  ELSIF v_any_end IS NOT NULL THEN
    v_status := CASE WHEN v_any_end > v_now THEN 'inactive' ELSE 'expired' END;
    v_expires := v_any_end;
  ELSE
    v_status := 'inactive'; v_expires := NULL;
  END IF;

  -- The tier of the period that decides access now: the open-ended one, else
  -- the one whose end is the horizon — and only among periods that have not
  -- ended, which is the set platform_company_set_plan carries a tier onto.
  -- With none, v_plan stays NULL and the company's own value stands, as it
  -- does for a company with no coverage. No term on period_start: an early
  -- renewal that starts in the future decides too.
  SELECT c.plan INTO v_plan
    FROM public.subscription_coverage c
   WHERE c.company_id = p_company_id
     AND c.status = 'active'
     AND c.grants_access
     AND c.plan IS NOT NULL
     AND (c.period_end IS NULL OR c.period_end > v_now)
   ORDER BY (c.period_end IS NULL) DESC, c.period_end DESC, c.created_at DESC
   LIMIT 1;

  UPDATE public.companies
     SET subscription_status     = v_status,
         subscription_expires_at = v_expires,
         plan                    = coalesce(v_plan, plan),
         updated_at              = now()
   WHERE id = p_company_id
     AND (subscription_status     IS DISTINCT FROM v_status
          OR subscription_expires_at IS DISTINCT FROM v_expires
          OR plan                 IS DISTINCT FROM coalesce(v_plan, plan));
END;
$$;

COMMENT ON FUNCTION app_private.recompute_company_subscription(uuid) IS
  'Plan 3.F: derives companies.subscription_status, .subscription_expires_at '
  'and .plan from public.subscription_coverage. The only writer of the first '
  'two. .plan is derived only from a live granting period that has not ended, '
  'the set platform_company_set_plan carries a tier onto; with none, the '
  'company keeps its own value (20260920150000).';

-- ─── 2. Grants and ownership, restated ──────────────────────────────────────

-- CREATE OR REPLACE keeps both, so neither changes; they are restated so this
-- file does not lean on an earlier one.
REVOKE ALL ON FUNCTION app_private.recompute_company_subscription(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION app_private.recompute_company_subscription(uuid) OWNER TO CURRENT_USER;

-- ─── 3. Self-check ──────────────────────────────────────────────────────────

-- Tripwires, as U1's, U2's and U3's are. What the rule does is asserted in
-- tests/rls/subscriptions.sql section 9.
DO $mig$
DECLARE
  c_recompute CONSTANT text := 'app_private.recompute_company_subscription(uuid)';
  c_set_plan  CONSTANT text := 'public.platform_company_set_plan(uuid,text,text,integer)';
  c_reader    CONSTANT text := 'app_private.subscription_column_writes()';
  v_role  text;
  v_txt   text;
  v_found text;
BEGIN
  -- 1. it exists, is SECURITY DEFINER, pins its search_path, and no API role
  --    may call it
  IF to_regprocedure(c_recompute) IS NULL THEN
    RAISE EXCEPTION '20260920150000 self-check: % is missing', c_recompute;
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(c_recompute)) THEN
    RAISE EXCEPTION '20260920150000 self-check: % is not SECURITY DEFINER, so the U3 wall would refuse it', c_recompute;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                  WHERE p.oid = to_regprocedure(c_recompute) AND c.setting LIKE 'search_path=%') THEN
    RAISE EXCEPTION '20260920150000 self-check: % has no pinned search_path', c_recompute;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, c_recompute::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '20260920150000 self-check: % may call %', v_role, c_recompute;
    END IF;
  END LOOP;

  -- 2. its owner can reach app_private and is not one of the roles the U3 wall
  --    refuses (see tests/fixtures/owner-simulation.sql, and PR #25)
  IF NOT EXISTS (SELECT 1
                   FROM pg_proc p
                   JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = to_regprocedure(c_recompute)
                    AND (r.rolsuper
                         OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private'))
                    AND r.rolname::text <> ALL (ARRAY['anon', 'authenticated', 'service_role'])) THEN
    RAISE EXCEPTION '20260920150000 self-check: the owner of % can reach no app_private helper, or is an API role', c_recompute;
  END IF;

  -- 3. it still writes exactly the three columns it owns, as U3's catalogue
  --    reader sees them, so U3's list of sanctioned writers still holds
  IF to_regprocedure(c_reader) IS NULL THEN
    RAISE EXCEPTION '20260920150000 self-check: % is missing — this file needs U3 (20260920120000) applied first', c_reader;
  END IF;
  SELECT coalesce(string_agg(w.column_name || ':' || w.via, ',' ORDER BY w.column_name COLLATE "C"), 'nothing')
    INTO v_found
    FROM app_private.subscription_column_writes() w
   WHERE w.routine::oid = to_regprocedure(c_recompute)::oid;
  IF v_found <> 'plan:update,subscription_expires_at:update,subscription_status:update' THEN
    RAISE EXCEPTION '20260920150000 self-check: % no longer writes exactly plan, subscription_expires_at and subscription_status (found %)',
      c_recompute, v_found;
  END IF;

  -- 4. the tier query reads only periods that have not ended: the predicate
  --    sits inside the one statement that selects INTO v_plan
  v_txt := app_private.function_code(c_recompute);
  IF v_txt !~* 'c\.plan\s+INTO\s+v_plan[^;]*\(\s*c\.period_end\s+IS\s+NULL\s+OR\s+c\.period_end\s*>\s*v_now\s*\)[^;]*;' THEN
    RAISE EXCEPTION '20260920150000 self-check: the recompute''s tier query no longer limits itself to periods that have not ended, so an owner''s tier on an expired company would be reverted';
  END IF;
  --    …and names no start date anywhere: a start term in the tier query would
  --    skip an early renewal, the downgrade U1 self-check 7b exists for. The
  --    body has no other reason to mention the column.
  IF v_txt ~* 'period_start' THEN
    RAISE EXCEPTION '20260920150000 self-check: the recompute filters on period_start, so an early renewal would be skipped';
  END IF;

  -- 5. the rule depends on set_plan carrying the tier onto exactly that set, so
  --    the other half is checked again here rather than trusted from U1
  v_txt := app_private.function_code(c_set_plan);
  IF v_txt !~ 'period_end\s+IS\s+NULL\s+OR\s+period_end\s*>\s*now\(\)' OR v_txt ~ 'period_start' THEN
    RAISE EXCEPTION '20260920150000 self-check: platform_company_set_plan no longer carries the tier onto exactly the periods that have not ended, which is the set the recompute reads';
  END IF;

  RAISE NOTICE '20260920150000 self-check: passed';
END $mig$;
