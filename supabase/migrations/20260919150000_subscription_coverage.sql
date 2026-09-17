/*
  # One subscription model, step U1: expansion and backfill

  Plan 3.F, step U1. Step U0 was the read-only report
  (`scripts/reports/subscription-conflicts.sql`); U2 is the invoice and payment
  functions and U3 removes the direct writes. Neither starts here.

  ## What this is for

  Four models decide today whether a company is subscribed, and they disagree —
  U0 names fifteen classes of disagreement. This slice adds the one place the
  answer will live, fills it from what the database says today, and makes the
  three columns the gate reads a *derived* value rather than something any
  writer can set by hand:

      public.subscription_coverage                 the periods a company is paid
                                                   or granted, with their source
      app_private.recompute_company_subscription   the only thing that writes
                                                   companies.subscription_status,
                                                   .subscription_expires_at and
                                                   .plan

  Every existing writer keeps its signature, its answers and everything else it
  writes. Each one now also records the period it granted and calls the
  recompute in the same transaction, which writes the three columns back. The
  release must look identical to a customer.

  ## The owner's six rules, answered 17.09.2026

  1. **A company that is `active` with no expiry stays open.** It is carried in
     as *open-ended* coverage and gets no expiry. Before a suspension on such a
     company is lifted, a human sets an expiry by hand — an operational note,
     not code (HANDOFF.md).
  2. **A company `active` past its expiry is written `expired`.** A stored-word
     correction only: both gates already refuse it, so no access changes.
  3. **One suspension state: `companies.status = 'suspended'`.** Every suspended
     flag moves onto that column, and `approval_status` and `subscription_status`
     stop carrying `'suspended'` — here, and by CHECK constraint from now on.
     Two live holes close with it, and both are worth naming:
       - `platform_company_lifecycle('reactivate')` resets only `status`, so a
         company suspended through one of the other two columns stayed locked
         with nothing on screen explaining why;
       - a company suspended only through `subscription_status` could be
         un-suspended by its own administrator redeeming any valid activation
         code (20260916130020:430 set it to `'active'` unconditionally).
  4. **A subscription row keeps the price it was assigned.** Money in the new
     structures is **integer cents** (`price_cents`).
  5. **Invoices do not affect access in U1.** Paying extends nothing and being
     overdue locks nothing, so this file writes no coverage row from an
     invoice at all. That is U2's, and U2 needs a grace-days number the owner
     has not given.
  6. **An old activation code with no recorded period gets no reconstructed
     period.** Nothing is guessed from `used_at`.

  ## The backfill, case by case

  `s` = `subscription_status`, `ex` = `subscription_expires_at`,
  `st` = `subscription_started_at`. One coverage row per company at most, source
  `migration`; `grants_access` says whether it extends access.

  | today                             | row written                | recompute answers   | gate |
  |-----------------------------------|----------------------------|---------------------|------|
  | s=active, ex NULL                 | granting, open-ended       | ('active', NULL)    | same |
  | s=active, ex > now                | granting, [st, ex)         | ('active', ex)      | same |
  | s=active, ex ≤ now                | granting, [st, ex)         | ('expired', ex)     | same |
  | s=suspended                       | granting, as the dates say | derived             | same |
  | s∈(inactive,expired), ex NULL     | none                       | ('inactive', NULL)  | same |
  | s∈(inactive,expired), ex NOT NULL | recorded, not granting     | ('inactive'/'expired', ex) | same |

  The gate is `public.get_active_company_id()` (20260917130000:206-223). Read
  its clauses, not the U0 report's framing: the report predates slice 3.3 and
  describes the two *browser* gates, and the server's predicate **never reads
  `trial_end`**. A trial company is admitted by its `status = 'trial'` and by
  its `subscription_status`, so a running trial grants nothing through this gate
  on its own — which is why no `trial` coverage row is written here. The source
  value exists for U2 and plan 3.10, which move the trial length into the
  settings.

  Activation codes are not backfilled either. Their periods were already folded
  into `companies.subscription_*` by `redeem_activation_code` when they were
  redeemed; a second row would count the same grant twice, and U0's class 10
  says several of them no longer agree with the company they were spent on. From
  this release on, every new redemption writes its own row.

  ## The gate that makes this safe

  Section 7 computes, for every profile and every company, whether the server
  admits it — **before** every write below and **after** all of them, inside
  this one transaction — and raises on any difference. The buckets are asserted
  to account for every row, so a NULL cannot slip through unmeasured (the trap
  `scripts/active-company-parity.sql` describes in its header). It also prints
  what it found, per bucket and per U0 conflict class.

  ## SCHEMA_EPOCH stays at 2

  Nothing here is a drop, a rename or a changed meaning for the release before
  it. A rollback re-activates that release's code against *this* database, and
  that code reaches these columns only through the RPCs below, whose signatures
  and answers are unchanged. It reads `approval_status` and `subscription_status`
  and will simply never see `'suspended'` there any more; the value it does see,
  `companies.status = 'suspended'`, is one it already blocks on
  (`AuthContext.checkProfileAccess`) and already renders (`CompaniesPage`,
  `SuperAdminDashboard`). The two narrowed CHECK constraints refuse a value that
  nothing writes after this file applies. So the epoch does not move — and it is
  said here rather than left to be inferred, because there is no way back across
  one.

  ## Rules followed

  Expansive only. Pinned `search_path` on every function, `SECURITY DEFINER`
  where it reaches `app_private`, `REVOKE ALL FROM PUBLIC, anon, authenticated`
  with a grant only to the role meant to call it, `ALTER FUNCTION … OWNER TO
  CURRENT_USER` for everything that reaches `app_private` (a `CREATE OR REPLACE`
  keeps the old owner, and on the real databases several of these belong to
  `postgres`, which holds no USAGE there — see tests/fixtures/owner-simulation.sql),
  and a self-check `DO` block that can fail.
*/

-- ─── 1. The table ───────────────────────────────────────────────────────────

/*
  A period a company is paid or granted, and where that period came from.

  Two independent flags, because they answer different questions:

    status         is this row live at all? `void` is a correction — a period
                   that was replaced or withdrawn. U2 voids the coverage of a
                   cancelled invoice this way.
    grants_access  does this live row extend access? False for a period that is
                   on record but granted nothing, which is what U0's class 06
                   companies have: an expiry in the future while the
                   subscription status blocks them.

  `period_end IS NULL` means open-ended (rule 1). Only a granting row may be
  open-ended: a recorded non-granting period with no end would leave
  `subscription_expires_at` undefined in the recompute's else-branch.

  Money is integer cents (rule 4). `plan` is the tier the period was bought at;
  it is nullable because `companies.plan` carries no CHECK constraint and U0's
  class 01 finds values outside the three tiers — the recompute keeps the
  company's own value where the row has none, so nothing is normalised away.
*/
CREATE TABLE IF NOT EXISTS public.subscription_coverage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  source        text NOT NULL
                  CHECK (source IN ('invoice', 'activation_code', 'manual', 'trial', 'migration')),
  source_id     uuid,
  period_start  timestamptz NOT NULL,
  period_end    timestamptz,
  grants_access boolean NOT NULL DEFAULT true,
  plan          text CHECK (plan IS NULL OR plan IN ('basic', 'advanced', 'premium')),
  price_cents   bigint CHECK (price_cents IS NULL OR price_cents >= 0),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  void_reason   text,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  -- A live period runs forwards. A voided one is kept exactly as it was
  -- recorded, dates and all, so a correction never rewrites history.
  CONSTRAINT subscription_coverage_period_ck
    CHECK (status <> 'active' OR period_end IS NULL OR period_end >= period_start),
  -- Only a granting *live* row may be open-ended; see the header of this
  -- section. A voided one is left exactly as it was recorded — including the
  -- open end a company carried in under rule 1 — because voiding is a
  -- correction and a correction does not rewrite the period it withdraws.
  CONSTRAINT subscription_coverage_open_ended_ck
    CHECK (period_end IS NOT NULL OR status = 'void' OR grants_access),
  CONSTRAINT subscription_coverage_void_reason_ck
    CHECK ((status = 'void') = (void_reason IS NOT NULL))
);

COMMENT ON TABLE public.subscription_coverage IS
  'Plan 3.F: the periods a company is paid or granted. '
  'app_private.recompute_company_subscription() reads it and is the only writer '
  'of companies.subscription_status, .subscription_expires_at and .plan.';

-- The recompute reads the live rows of one company and orders them by period_end.
CREATE INDEX IF NOT EXISTS idx_subscription_coverage_company
  ON public.subscription_coverage (company_id, status, grants_access, period_end);

-- One row per invoice, per redeemed code, per subscription row: the backfill and
-- every writer below are idempotent because of this, not because they check first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_coverage_source
  ON public.subscription_coverage (company_id, source, source_id)
  WHERE source_id IS NOT NULL;

-- …and one migration row per company, so re-running the backfill writes nothing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_coverage_migration
  ON public.subscription_coverage (company_id)
  WHERE source = 'migration';

ALTER TABLE public.subscription_coverage ENABLE ROW LEVEL SECURITY;

/*
  The account shell's predicate, `get_user_company_id()`, and not
  `get_active_company_id()`: a company whose coverage has run out is exactly the
  one whose owner has to read it, on /abo-aktivieren and /billing. That is the
  same choice company_subscriptions, subscription_invoices and
  subscription_payment_audit make, and it is why this table carries no
  `refuse_read_only_context_write` trigger — the derived list in 20260917140000
  is "policies naming get_active_company_id()", and tests/rls/platform-contexts.sql
  section 14 checks that list against every table that exists.

  Writing is nobody's. `authenticated` is granted SELECT and nothing else, so
  every write below happens inside a SECURITY DEFINER function owned by the role
  that owns this table.
*/
DROP POLICY IF EXISTS subscription_coverage_select ON public.subscription_coverage;
CREATE POLICY subscription_coverage_select ON public.subscription_coverage
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_user_company_id())
         OR (SELECT public.platform_can('companies.read')));

REVOKE ALL ON TABLE public.subscription_coverage FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.subscription_coverage TO authenticated;

-- A coverage row belongs to the company it was written for. The policies above
-- give nobody an UPDATE, so this binds only the SECURITY DEFINER writers — the
-- same rule, and the same trigger function, that 20260917130000 put on
-- company_subscriptions and subscription_invoices.
DROP TRIGGER IF EXISTS pin_billing_company_id ON public.subscription_coverage;
CREATE TRIGGER pin_billing_company_id
  BEFORE UPDATE ON public.subscription_coverage
  FOR EACH ROW EXECUTE FUNCTION public.pin_billing_company_id();

-- ─── 2. The recompute ───────────────────────────────────────────────────────

/*
  The one writer of companies.subscription_status, .subscription_expires_at and
  .plan. Called in the same transaction as every write that changes coverage,
  and safe to call again at any time — it is a pure function of the coverage
  rows plus the clock, so a daily sweep only moves a company past its expiry
  from 'active' to 'expired', which the gate already refuses by the expiry
  clause.

  The rule, in order:

    a granting live row with no end            → ('active',  NULL)
    the newest granting live end is ahead      → ('active',  that end)
    a granting live row exists and has passed  → ('expired', that end)
    otherwise, the newest live end at all      → ('expired', it) if it has passed
                                                 ('inactive', it) if it has not
    no live row at all                         → ('inactive', NULL)

  The fourth line is what keeps a recorded-but-never-granting period visible
  where it is today: U0's class 06 company keeps showing its future date and
  keeps being refused, exactly as before.

  `plan` follows the row that decided, and falls back to what the company
  already has — so a company with no coverage, and a tier outside the three the
  CHECK allows, both keep their value.

  It never writes companies.status, .approval_status, .subscription_started_at
  or .subscription_duration_type. Suspension is `companies.status` and belongs
  to the lifecycle RPCs; the start date and the duration word belong to the
  writer that set them.
*/
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

  -- The plan of the row that decided: the open-ended one, else the one whose
  -- end is the horizon. NULL where that row carries none, and then the
  -- company's own value stands.
  SELECT c.plan INTO v_plan
    FROM public.subscription_coverage c
   WHERE c.company_id = p_company_id
     AND c.status = 'active'
     AND c.grants_access
     AND c.plan IS NOT NULL
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
  'and .plan from public.subscription_coverage. The only writer of those three.';

/*
  The daily sweep, for a job runner to call. **Nothing calls it yet**, and that
  is deliberate: U1 changes no behaviour, and a sweep would move companies from
  'active' to 'expired' at their expiry — access-neutral, because the gate
  already refuses them on the expiry clause, but still a change nobody asked
  for in this slice. deploy/otp-housekeeping.sh is installed on the host by
  hand, so wiring it is an operational step (HANDOFF.md), not a release.
*/
CREATE OR REPLACE FUNCTION app_private.recompute_all_company_subscriptions()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id    uuid;
  v_count integer := 0;
BEGIN
  FOR v_id IN SELECT c.id FROM public.companies c ORDER BY c.id LOOP
    PERFORM app_private.recompute_company_subscription(v_id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

/*
  Record a period and derive the company's state from it, in one step.

  `p_replace` voids every live row of the company first: a manual edit replaces
  the picture rather than adding to it, which is what
  update_company_subscription_manual does today when it overwrites the three
  columns outright. Without it a revocation would leave an older period as the
  newest end on record and the displayed date would not be the one the
  administrator typed.
*/
CREATE OR REPLACE FUNCTION app_private.subscription_coverage_record(
  p_company_id    uuid,
  p_source        text,
  p_source_id     uuid,
  p_period_start  timestamptz,
  p_period_end    timestamptz,
  p_grants_access boolean DEFAULT true,
  p_plan          text    DEFAULT NULL,
  p_price_cents   bigint  DEFAULT NULL,
  p_note          text    DEFAULT NULL,
  p_replace       boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_start timestamptz;
  v_id    uuid;
BEGIN
  IF p_company_id IS NULL OR p_source IS NULL OR p_period_start IS NULL THEN
    RAISE EXCEPTION 'subscription_coverage_record: invalid arguments' USING ERRCODE = '22023';
  END IF;
  -- A non-granting period must be bounded (the table's CHECK says so); refusing
  -- here names the caller instead of the constraint.
  IF p_period_end IS NULL AND NOT coalesce(p_grants_access, true) THEN
    RAISE EXCEPTION 'subscription_coverage_record: an open-ended period must grant access'
      USING ERRCODE = '22023';
  END IF;

  -- U0 class 15: a period that starts after it ends. The end is what the gate
  -- reads, so the start is clamped to it and the fact is written down.
  v_start := least(p_period_start, coalesce(p_period_end, p_period_start));

  IF p_replace THEN
    UPDATE public.subscription_coverage
       SET status      = 'void',
           void_reason = 'replaced'
     WHERE company_id = p_company_id
       AND status = 'active';
  END IF;

  INSERT INTO public.subscription_coverage
    (company_id, source, source_id, period_start, period_end, grants_access, plan, price_cents, note, created_by)
  VALUES
    (p_company_id, p_source, p_source_id, v_start, p_period_end, coalesce(p_grants_access, true),
     p_plan, p_price_cents,
     CASE WHEN v_start IS DISTINCT FROM p_period_start
          THEN concat_ws(' ', p_note, '(start clamped to the end: the period was recorded backwards)')
          ELSE p_note END,
     auth.uid())
  RETURNING id INTO v_id;

  PERFORM app_private.recompute_company_subscription(p_company_id);
  RETURN v_id;
END;
$$;

/*
  The backfill rule, for one company — the table in this file's header, written
  once as code instead of once in a migration loop.

  It is a function rather than a `DO` block because the rule is the thing worth
  testing and the RLS kit builds from a `--schema-only` fixture: there are no
  companies at migration time, so a loop inside this file would never be
  exercised by anything. `tests/rls/subscriptions.sql` seeds a company in each
  of U0's conflict classes and calls this, which is the only way "no company's
  access changes" is checked against rows rather than against prose.

  Idempotent: a company that already carries its `migration` row is recomputed
  and otherwise left alone. Answers what it did, for the counters in section 5.
*/
CREATE OR REPLACE FUNCTION app_private.subscription_backfill_company(p_company_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c        public.companies%ROWTYPE;
  v_grants boolean;
  v_note   text;
  v_appr   text;
BEGIN
  SELECT * INTO c FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  -- Rule 3, one suspension state. Whatever carried it, it moves onto
  -- companies.status; the gate refuses `status = 'suspended'` on its own, so
  -- access is unchanged at this moment and the two holes named in the header
  -- close. A company suspended at the approval step was approved first, and
  -- approved_at is the evidence; 'pending' is the honest answer where there is
  -- none. Either value keeps it refused while status says suspended.
  IF 'suspended' IN (c.status, c.approval_status, c.subscription_status) THEN
    v_appr := CASE WHEN c.approval_status = 'suspended'
                   THEN CASE WHEN c.approved_at IS NOT NULL THEN 'approved' ELSE 'pending' END
                   ELSE c.approval_status END;

    UPDATE public.companies
       SET status          = 'suspended',
           approval_status = v_appr,
           updated_at      = now()
     WHERE id = p_company_id;

    PERFORM app_private.audit_write(
      'legacy', 'legacy.subscription_u1_suspension', 'ok', p_company_id, 'company', p_company_id::text,
      jsonb_build_object('status', c.status, 'approval_status', c.approval_status,
                         'subscription_status', c.subscription_status),
      jsonb_build_object('status', 'suspended', 'approval_status', v_appr),
      NULL, NULL, coalesce(c.created_at, now()));
  END IF;

  IF c.subscription_status IN ('active', 'suspended') THEN
    -- Rules 1 and 2: an open end stays open, a passed expiry keeps its date and
    -- the recompute writes the word `expired`.
    v_grants := true;
    v_note   := 'carried over from companies.subscription_* by plan 3.F step U1';
  ELSIF c.subscription_expires_at IS NOT NULL THEN
    -- U0 class 06 and its neighbours: a period is on record and granted nothing
    -- before this file. It must go on granting nothing, and its date must go on
    -- being shown.
    v_grants := false;
    v_note   := 'recorded, not granting: the subscription status blocked it before plan 3.F step U1';
  ELSE
    PERFORM app_private.recompute_company_subscription(p_company_id);
    RETURN 'no_period';
  END IF;

  BEGIN
    PERFORM app_private.subscription_coverage_record(
      p_company_id, 'migration', NULL,
      coalesce(c.subscription_started_at, c.created_at, now()),
      c.subscription_expires_at,
      v_grants,
      CASE WHEN c.plan IN ('basic', 'advanced', 'premium') THEN c.plan END,
      NULL, v_note, false);
  EXCEPTION WHEN unique_violation THEN
    -- The migration row is already there: this has run before.
    PERFORM app_private.recompute_company_subscription(p_company_id);
    RETURN 'already_recorded';
  END;

  RETURN 'recorded';
END;
$$;

-- ─── 3. Grants and ownership ────────────────────────────────────────────────

-- Nobody the API authenticates as reaches app_private, and the REVOKE is the
-- second wall: EXECUTE-to-PUBLIC on a new function is a built-in default that
-- cannot be revoked per schema.
REVOKE ALL ON FUNCTION app_private.recompute_company_subscription(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.recompute_all_company_subscriptions()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.subscription_coverage_record(uuid, text, uuid, timestamptz, timestamptz, boolean, text, bigint, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.subscription_backfill_company(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Their callers are SECURITY DEFINER functions owned by the role running this
-- migration, which already holds USAGE on app_private; they reach these as
-- their own owner and need no grant of their own.
ALTER FUNCTION app_private.recompute_company_subscription(uuid)          OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.recompute_all_company_subscriptions()         OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.subscription_coverage_record(uuid, text, uuid, timestamptz, timestamptz, boolean, text, bigint, text, boolean)
  OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.subscription_backfill_company(uuid)           OWNER TO CURRENT_USER;

-- ─── 4. The access gate, before ─────────────────────────────────────────────

/*
  The server's own predicate, transcribed from get_active_company_id()
  (20260917130000:206-223) rather than called, because it has to be evaluated
  twice in one transaction as a plain expression over rows — the function
  answers for `auth.uid()`, which a migration does not have.

  coalesce(): `NOT IN` over a NULL status yields NULL, and a NULL row would be
  counted by none of the buckets — not even the mismatch bucket. The function
  itself drops such a row, so false is what it means. Section 7 asserts the
  buckets account for every row, which is what makes that impossible to get
  wrong quietly.

  Plain temporary tables, not `ON COMMIT DROP`: deploy.sh runs a migration in
  one transaction, but the RLS kit feeds the file to psql in autocommit, where
  every statement commits on its own and an `ON COMMIT DROP` table would be gone
  before the next statement could read it. They are dropped by name at the end
  of section 9 instead, after the self-check has confirmed the comparison ran.
*/
DROP TABLE IF EXISTS _u1_before;
CREATE TEMP TABLE _u1_before AS
SELECT up.user_id,
       up.company_id,
       coalesce(
         (up.company_id IS NOT NULL
          AND up.status NOT IN ('inactive', 'suspended', 'deactivated')
          AND c.approval_status = 'approved'
          AND c.status IN ('active', 'trial')
          AND c.subscription_status = 'active'
          AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now())
         ), false) AS admitted
  FROM public.user_profiles up
  LEFT JOIN public.companies c ON c.id = up.company_id;

-- The same question asked of the company alone, so a company with no members
-- today — and there are such companies — is still measured.
DROP TABLE IF EXISTS _u1_company_before;
CREATE TEMP TABLE _u1_company_before AS
SELECT c.id AS company_id,
       coalesce(
         (c.approval_status = 'approved'
          AND c.status IN ('active', 'trial')
          AND c.subscription_status = 'active'
          AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now())
         ), false) AS admits,
       c.status, c.approval_status, c.subscription_status, c.subscription_expires_at, c.plan
  FROM public.companies c;

-- ─── 5. The backfill ────────────────────────────────────────────────────────

-- Every company, through the rule in section 2. The loop is only a loop: the
-- decision is in app_private.subscription_backfill_company(), which the RLS kit
-- calls on seeded rows of each conflict class.
DO $mig$
DECLARE
  v_id       uuid;
  v_did      text;
  v_susp     integer := 0;
  v_rows     integer := 0;
  v_none     integer := 0;
  v_skipped  integer := 0;
BEGIN
  SELECT count(*) INTO v_susp
    FROM public.companies
   WHERE 'suspended' IN (status, approval_status, subscription_status);

  FOR v_id IN SELECT c.id FROM public.companies c ORDER BY c.id LOOP
    v_did := app_private.subscription_backfill_company(v_id);
    CASE v_did
      WHEN 'recorded'         THEN v_rows    := v_rows + 1;
      WHEN 'no_period'        THEN v_none    := v_none + 1;
      WHEN 'already_recorded' THEN v_skipped := v_skipped + 1;
      ELSE NULL;
    END CASE;
  END LOOP;

  RAISE NOTICE '3.F U1 backfill: % coverage row(s) written, % company(ies) with nothing to record, % already had one, % suspension(s) moved onto companies.status',
    v_rows, v_none, v_skipped, v_susp;
END $mig$;

-- ─── 6. The vocabulary: suspension lives in one column ──────────────────────

-- After the backfill, nothing carries 'suspended' in either column and no
-- writer below writes it there. The constraints are what keep it that way; a
-- release that reintroduces the value fails here rather than on a screen.
ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_approval_status_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_approval_status_check
  CHECK (approval_status = ANY (ARRAY['pending', 'approved', 'rejected']));

ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_subscription_status_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_subscription_status_check
  CHECK (subscription_status = ANY (ARRAY['inactive', 'active', 'expired']));

-- ─── 7. The access gate, after ──────────────────────────────────────────────

DROP TABLE IF EXISTS _u1_after;
CREATE TEMP TABLE _u1_after AS
SELECT up.user_id,
       up.company_id,
       coalesce(
         (up.company_id IS NOT NULL
          AND up.status NOT IN ('inactive', 'suspended', 'deactivated')
          AND c.approval_status = 'approved'
          AND c.status IN ('active', 'trial')
          AND c.subscription_status = 'active'
          AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now())
         ), false) AS admitted
  FROM public.user_profiles up
  LEFT JOIN public.companies c ON c.id = up.company_id;

DROP TABLE IF EXISTS _u1_company_after;
CREATE TEMP TABLE _u1_company_after AS
SELECT c.id AS company_id,
       coalesce(
         (c.approval_status = 'approved'
          AND c.status IN ('active', 'trial')
          AND c.subscription_status = 'active'
          AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now())
         ), false) AS admits,
       c.status, c.approval_status, c.subscription_status, c.subscription_expires_at, c.plan
  FROM public.companies c;

DO $mig$
DECLARE
  v_profiles  bigint;
  v_p_yes_yes bigint;
  v_p_no_no   bigint;
  v_p_lost    bigint;
  v_p_gained  bigint;
  v_companies bigint;
  v_c_yes_yes bigint;
  v_c_no_no   bigint;
  v_c_lost    bigint;
  v_c_gained  bigint;
  v_expiry    bigint;
  v_rows      bigint;
  r           record;
BEGIN
  -- 7a. The two sides must describe the same population. A profile or a company
  --     that exists on one side only would make every count below meaningless.
  SELECT count(*) INTO v_rows FROM _u1_before;
  SELECT count(*) INTO v_profiles FROM _u1_after;
  IF v_rows <> v_profiles THEN
    RAISE EXCEPTION '3.F U1 gate: % profile(s) before and % after — the population changed under the comparison',
      v_rows, v_profiles;
  END IF;
  SELECT count(*) INTO v_rows FROM _u1_company_before;
  SELECT count(*) INTO v_companies FROM _u1_company_after;
  IF v_rows <> v_companies THEN
    RAISE EXCEPTION '3.F U1 gate: % company(ies) before and % after — the population changed under the comparison',
      v_rows, v_companies;
  END IF;

  -- 7b. Profiles: the four buckets, and they must add up to every profile.
  SELECT count(*) FILTER (WHERE b.admitted AND a.admitted),
         count(*) FILTER (WHERE NOT b.admitted AND NOT a.admitted),
         count(*) FILTER (WHERE b.admitted AND NOT a.admitted),
         count(*) FILTER (WHERE NOT b.admitted AND a.admitted)
    INTO v_p_yes_yes, v_p_no_no, v_p_lost, v_p_gained
    FROM _u1_before b
    JOIN _u1_after  a USING (user_id);

  IF v_p_yes_yes + v_p_no_no + v_p_lost + v_p_gained <> v_profiles THEN
    RAISE EXCEPTION '3.F U1 gate: the four profile buckets hold % of % profiles — a NULL slipped past the comparison',
      v_p_yes_yes + v_p_no_no + v_p_lost + v_p_gained, v_profiles;
  END IF;

  -- 7c. Companies: the same four buckets.
  SELECT count(*) FILTER (WHERE b.admits AND a.admits),
         count(*) FILTER (WHERE NOT b.admits AND NOT a.admits),
         count(*) FILTER (WHERE b.admits AND NOT a.admits),
         count(*) FILTER (WHERE NOT b.admits AND a.admits)
    INTO v_c_yes_yes, v_c_no_no, v_c_lost, v_c_gained
    FROM _u1_company_before b
    JOIN _u1_company_after  a USING (company_id);

  IF v_c_yes_yes + v_c_no_no + v_c_lost + v_c_gained <> v_companies THEN
    RAISE EXCEPTION '3.F U1 gate: the four company buckets hold % of % companies — a NULL slipped past the comparison',
      v_c_yes_yes + v_c_no_no + v_c_lost + v_c_gained, v_companies;
  END IF;

  RAISE NOTICE '3.F U1 gate: % profiles — % admitted before and after, % refused before and after',
    v_profiles, v_p_yes_yes, v_p_no_no;
  RAISE NOTICE '3.F U1 gate: % companies — % admit before and after, % refuse before and after',
    v_companies, v_c_yes_yes, v_c_no_no;

  -- 7d. The gate itself. Both directions are failures: taking access away is
  --     the obvious one, and handing it out is the one a backfill invents.
  IF v_p_lost > 0 OR v_p_gained > 0 OR v_c_lost > 0 OR v_c_gained > 0 THEN
    FOR r IN
      SELECT b.company_id,
             b.status AS status_before, a.status AS status_after,
             b.approval_status AS approval_before, a.approval_status AS approval_after,
             b.subscription_status AS sub_before, a.subscription_status AS sub_after,
             b.subscription_expires_at AS expires_before, a.subscription_expires_at AS expires_after
        FROM _u1_company_before b
        JOIN _u1_company_after  a USING (company_id)
       WHERE b.admits <> a.admits
       ORDER BY b.company_id
       LIMIT 20
    LOOP
      RAISE WARNING '3.F U1 gate: company % changed: status %→%, approval %→%, subscription %→%, expiry %→%',
        r.company_id, r.status_before, r.status_after, r.approval_before, r.approval_after,
        r.sub_before, r.sub_after, r.expires_before, r.expires_after;
    END LOOP;

    RAISE EXCEPTION '3.F U1 gate: access changed for % profile(s) (% lost, % gained) and % company(ies) (% lost, % gained). Read the warnings above: this is the gate refusing, not a warning.',
      v_p_lost + v_p_gained, v_p_lost, v_p_gained,
      v_c_lost + v_c_gained, v_c_lost, v_c_gained;
  END IF;

  -- 7e. Rules 1 and 2, checked rather than assumed: no company gained an
  --     expiry it did not have, and a company that is `active` is never past
  --     its own expiry any more.
  SELECT count(*) INTO v_expiry
    FROM _u1_company_before b
    JOIN _u1_company_after  a USING (company_id)
   WHERE b.subscription_expires_at IS NULL AND a.subscription_expires_at IS NOT NULL;
  IF v_expiry > 0 THEN
    RAISE EXCEPTION '3.F U1 gate: % company(ies) were given an expiry they did not have (rule 1)', v_expiry;
  END IF;

  SELECT count(*) INTO v_expiry
    FROM _u1_company_after a
   WHERE a.subscription_status = 'active'
     AND a.subscription_expires_at IS NOT NULL
     AND a.subscription_expires_at <= now();
  IF v_expiry > 0 THEN
    RAISE EXCEPTION '3.F U1 gate: % company(ies) are still `active` past their expiry (rule 2)', v_expiry;
  END IF;

  -- 7f. The stored-word corrections, printed so the release log shows what moved.
  FOR r IN
    SELECT b.subscription_status AS was, a.subscription_status AS is_now, count(*) AS n
      FROM _u1_company_before b
      JOIN _u1_company_after  a USING (company_id)
     WHERE b.subscription_status IS DISTINCT FROM a.subscription_status
     GROUP BY 1, 2 ORDER BY 3 DESC
  LOOP
    RAISE NOTICE '3.F U1: subscription_status % → % for % company(ies)', r.was, r.is_now, r.n;
  END LOOP;

  FOR r IN
    SELECT b.status AS was, a.status AS is_now, count(*) AS n
      FROM _u1_company_before b
      JOIN _u1_company_after  a USING (company_id)
     WHERE b.status IS DISTINCT FROM a.status
     GROUP BY 1, 2 ORDER BY 3 DESC
  LOOP
    RAISE NOTICE '3.F U1: companies.status % → % for % company(ies)', r.was, r.is_now, r.n;
  END LOOP;

  FOR r IN
    SELECT b.approval_status AS was, a.approval_status AS is_now, count(*) AS n
      FROM _u1_company_before b
      JOIN _u1_company_after  a USING (company_id)
     WHERE b.approval_status IS DISTINCT FROM a.approval_status
     GROUP BY 1, 2 ORDER BY 3 DESC
  LOOP
    RAISE NOTICE '3.F U1: approval_status % → % for % company(ies)', r.was, r.is_now, r.n;
  END LOOP;

  -- 7g. plan is the third column the recompute owns, and nothing here should
  --     have moved it: every backfilled row carries the company's own tier.
  SELECT count(*) INTO v_expiry
    FROM _u1_company_before b
    JOIN _u1_company_after  a USING (company_id)
   WHERE b.plan IS DISTINCT FROM a.plan;
  IF v_expiry > 0 THEN
    RAISE EXCEPTION '3.F U1 gate: the backfill moved companies.plan for % company(ies)', v_expiry;
  END IF;
END $mig$;

-- ─── 8. The writers ─────────────────────────────────────────────────────────

/*
  Three functions change. Each keeps its signature, its answers and every other
  column it writes; what changes is that the period goes into
  subscription_coverage and the three derived columns come back from the
  recompute instead of being assigned.

    redeem_activation_code            records the code's period, stops writing
                                      subscription_status / _expires_at
    update_company_subscription_manual replaces the company's coverage from the
                                      values the administrator typed; a chosen
                                      `suspended` now sets companies.status
    platform_company_set_plan         keeps writing companies.plan and carries
                                      the tier onto the coverage rows that
                                      cover now, so the next recompute agrees
                                      with it instead of reverting it
*/

-- 8a. redeem_activation_code
--
-- The body of 20260916130020, unchanged down to the period arithmetic. Three
-- differences, and no others:
--
--   * the period goes into subscription_coverage (source `activation_code`,
--     source_id the code) and the recompute writes the two derived columns;
--   * companies.subscription_status and .subscription_expires_at are no longer
--     assigned here, which is what stops a redemption un-suspending a company
--     (the hole at 20260916130020:430);
--   * the answer's `subscription_expires_at` is read back from the company
--     after the recompute rather than being the value this function computed —
--     so a company carried in as open-ended (rule 1) keeps its open end and the
--     screen is told the truth instead of a date that was not stored.
--
-- It still resolves the caller's company from user_profiles itself: it is the
-- way out of a blocked state, so get_active_company_id() would refuse precisely
-- the caller that needs it (CLAUDE.md, "Data access").
CREATE OR REPLACE FUNCTION public.redeem_activation_code(input_code text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_caller_id     uuid;
  v_company_id    uuid;
  v_caller_role   text;
  v_code_hash     text;
  v_code          activation_codes%ROWTYPE;
  v_base_date     timestamptz;
  v_new_expiry    timestamptz;
  v_attempt_count integer;
  v_clean_code    text;
  v_sub_status    text;
  v_sub_expiry    timestamptz;
  v_start_date    timestamptz;
  v_plan          text;
  v_final_expiry  timestamptz;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Nicht authentifiziert.');
  END IF;

  SELECT company_id, role INTO v_company_id, v_caller_role
  FROM user_profiles
  WHERE user_id = v_caller_id
  LIMIT 1;

  IF v_company_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Kein Unternehmenskonto gefunden.');
  END IF;

  IF coalesce(v_caller_role, '') <> 'admin' THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, NULL, false, 'Keine Berechtigung', 'redeem');
    RETURN json_build_object('success', false,
      'error', 'Nur Administratoren des Unternehmens können einen Aktivierungscode einlösen.');
  END IF;

  v_clean_code := trim(regexp_replace(input_code, '\s', '', 'g'));

  IF v_clean_code !~ '^[0-9]{6}$' THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Ungültiges Format', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode muss genau 6 Ziffern haben.');
  END IF;

  SELECT COUNT(*) INTO v_attempt_count
  FROM activation_code_attempts
  WHERE company_id = v_company_id
    AND kind = 'redeem'
    AND success = false
    AND created_at > now() - INTERVAL '15 minutes';

  IF v_attempt_count >= 10 THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Rate limit', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Zu viele Versuche. Bitte warten Sie 15 Minuten.');
  END IF;

  v_code_hash := encode(digest(v_clean_code::bytea, 'sha256'), 'hex');

  SELECT * INTO v_code
  FROM activation_codes
  WHERE code_hash = v_code_hash
  LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Nicht gefunden', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode ist ungültig.');
  END IF;

  IF v_code.status = 'used' THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Bereits verwendet', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode wurde bereits verwendet.');
  END IF;

  IF v_code.status = 'revoked' THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Widerrufen', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode wurde widerrufen.');
  END IF;

  IF v_code.expires_at < now() OR v_code.status = 'expired' THEN
    UPDATE activation_codes SET status = 'expired' WHERE id = v_code.id AND status = 'active';
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Abgelaufen', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode ist abgelaufen.');
  END IF;

  IF v_code.company_id IS NOT NULL AND v_code.company_id IS DISTINCT FROM v_company_id THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Falsches Unternehmen', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu diesem Unternehmen.');
  END IF;

  IF v_code.target_email IS NOT NULL THEN
    DECLARE
      v_caller_email text;
    BEGIN
      SELECT email INTO v_caller_email FROM user_profiles WHERE user_id = v_caller_id LIMIT 1;
      -- IS DISTINCT FROM: a profile without an address made this NULL, and the
      -- IF fell through to redeeming a code bound to someone else.
      IF lower(v_caller_email) IS DISTINCT FROM lower(v_code.target_email) THEN
        INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
        VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Falsche E-Mail', 'redeem');
        RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu diesem Unternehmen.');
      END IF;
    END;
  END IF;

  -- Atomically mark code as used
  UPDATE activation_codes
  SET status          = 'used',
      used_at         = now(),
      used_by         = v_caller_id,
      used_company_id = v_company_id
  WHERE id = v_code.id
    AND status = 'active'
    AND expires_at > now();

  IF NOT FOUND THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Race condition', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode konnte nicht eingelöst werden. Bitte erneut versuchen.');
  END IF;

  -- Calculate new subscription expiry
  -- Extend from current active subscription if not yet expired
  SELECT subscription_status, subscription_expires_at, plan
  INTO v_sub_status, v_sub_expiry, v_plan
  FROM companies WHERE id = v_company_id;

  IF v_sub_status = 'active' AND v_sub_expiry IS NOT NULL AND v_sub_expiry > now() THEN
    v_base_date := v_sub_expiry;
  ELSE
    v_base_date := now();
  END IF;

  v_start_date := v_base_date;

  CASE v_code.duration_type
    WHEN '1_monat'   THEN v_new_expiry := v_base_date + INTERVAL '1 month';
    WHEN '3_monate'  THEN v_new_expiry := v_base_date + INTERVAL '3 months';
    WHEN '1_jahr'    THEN v_new_expiry := v_base_date + INTERVAL '1 year';
    WHEN 'benutzerdefiniert' THEN
      IF v_code.custom_expires_at IS NOT NULL THEN
        -- Absolute expiry date: use directly as both start and end
        v_new_expiry := v_code.custom_expires_at;
        v_start_date := now();
      ELSIF v_code.custom_days IS NOT NULL THEN
        v_new_expiry := v_base_date + (v_code.custom_days || ' days')::INTERVAL;
      ELSE
        v_new_expiry := v_base_date + INTERVAL '30 days';
      END IF;
    ELSE
      v_new_expiry := v_base_date + INTERVAL '1 month';
  END CASE;

  -- Write applied period back onto the activation_codes row
  UPDATE activation_codes
  SET applied_subscription_started_at = v_start_date,
      applied_subscription_expires_at  = v_new_expiry
  WHERE id = v_code.id;

  -- The columns this function still owns. subscription_status and
  -- subscription_expires_at are the recompute's; nothing here writes
  -- companies.status, so a suspended company stays suspended.
  UPDATE companies SET
    subscription_started_at    = v_start_date,
    subscription_duration_type = v_code.duration_type,
    last_activation_code_id    = v_code.id,
    updated_at                 = now()
  WHERE id = v_company_id;

  PERFORM app_private.subscription_coverage_record(
    v_company_id, 'activation_code', v_code.id,
    v_start_date, v_new_expiry, true,
    CASE WHEN v_plan IN ('basic', 'advanced', 'premium') THEN v_plan END,
    NULL,
    'Aktivierungscode ' || v_code.duration_type, false);

  SELECT subscription_expires_at INTO v_final_expiry FROM companies WHERE id = v_company_id;

  INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
  VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), true, 'OK', 'redeem');

  RETURN json_build_object(
    'success',                  true,
    'subscription_expires_at',  v_final_expiry
  );

EXCEPTION WHEN OTHERS THEN
  -- Never SQLERRM (see preview_activation_code).
  RETURN json_build_object('success', false, 'error', 'Der Aktivierungscode konnte nicht eingelöst werden.');
END;
$$;

-- Its owner is `postgres` on the real databases — the function predates version
-- control and CREATE OR REPLACE keeps the owner — and `postgres` holds no USAGE
-- on app_private. Without this line the coverage call above fails there and
-- succeeds in the RLS kit, whose fixture carries no owners at all. That is the
-- failure tests/fixtures/owner-simulation.sql exists to reproduce, and the one
-- that broke trial redemption in PR #25.
ALTER FUNCTION public.redeem_activation_code(text) OWNER TO CURRENT_USER;

-- 8b. update_company_subscription_manual
--
-- The body of 20260916130000 with its capability check, its
-- subscription_admin_actions row, its audit row, its answers and its argument
-- contract untouched. What changes:
--
--   * `suspended` is no longer a subscription status. The administrator picking
--     it in ManualSubscriptionModal now suspends the company where suspension
--     lives — companies.status — which is the one place every gate already
--     reads, and the period they typed is still recorded;
--   * the period replaces the company's coverage (p_replace), so a revocation
--     leaves no older period behind as the newest date on record;
--   * subscription_status and subscription_expires_at come back from the
--     recompute. started_at and duration_type are still written here.
CREATE OR REPLACE FUNCTION public.update_company_subscription_manual(
  p_company_id                 uuid,
  p_subscription_status        text,
  p_subscription_started_at    timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_subscription_expires_at    timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_subscription_duration_type text DEFAULT NULL::text,
  p_reason                     text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'subscription.manual_update';
  v_caller_id        uuid := auth.uid();
  v_company          public.companies%ROWTYPE;
  v_allowed_statuses text[] := ARRAY['inactive','active','expired','suspended'];
  v_grants           boolean;
  v_start            timestamptz;
  v_after            public.companies%ROWTYPE;
BEGIN
  IF NOT app_private.platform_rpc_authorize('billing.manage', 'write', c_action,
                                            p_company_id, 'company', p_company_id::text) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert', 'reason', 'denied');
  END IF;

  IF p_subscription_status IS NULL OR NOT (p_subscription_status = ANY (v_allowed_statuses)) THEN
    PERFORM app_private.platform_rpc_record('write', c_action, 'invalid', p_company_id, 'company', p_company_id::text,
                                            NULL, jsonb_build_object('subscription_status', p_subscription_status));
    RETURN jsonb_build_object('success', false, 'error', 'Ungültiger Abo-Status', 'reason', 'invalid');
  END IF;

  SELECT * INTO v_company FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM app_private.platform_rpc_record('write', c_action, 'not_found', NULL, 'company', p_company_id::text, NULL, NULL);
    RETURN jsonb_build_object('success', false, 'error', 'Unternehmen nicht gefunden', 'reason', 'not_found');
  END IF;

  INSERT INTO public.subscription_admin_actions
    (company_id, action_type, old_status, new_status, old_expires_at, new_expires_at, reason, created_by)
  VALUES
    (p_company_id, 'manual_edit',
     v_company.subscription_status, p_subscription_status,
     v_company.subscription_expires_at, p_subscription_expires_at,
     p_reason, v_caller_id);

  -- The columns this function still owns. `suspended` is the one value that no
  -- longer lands in subscription_status: it suspends the company itself, which
  -- is what the administrator meant and what every gate reads.
  UPDATE public.companies
     SET subscription_started_at    = COALESCE(p_subscription_started_at, subscription_started_at),
         subscription_duration_type = COALESCE(p_subscription_duration_type, subscription_duration_type),
         status                     = CASE WHEN p_subscription_status = 'suspended'
                                           THEN 'suspended' ELSE status END,
         updated_at                 = now()
   WHERE id = p_company_id;

  -- `active` and `suspended` describe a period the company holds; `inactive`
  -- and `expired` describe one it does not. Either way the dates are recorded,
  -- and p_replace makes this the only live row so the recompute reads back
  -- exactly what was typed.
  v_grants := p_subscription_status IN ('active', 'suspended');
  v_start  := COALESCE(p_subscription_started_at, v_company.subscription_started_at,
                       p_subscription_expires_at, v_company.created_at, now());

  IF p_subscription_expires_at IS NULL AND NOT v_grants THEN
    -- Nothing to record and nothing granted: every live row is withdrawn and
    -- the company falls back to ('inactive', NULL).
    UPDATE public.subscription_coverage
       SET status = 'void', void_reason = 'replaced'
     WHERE company_id = p_company_id AND status = 'active';
    PERFORM app_private.recompute_company_subscription(p_company_id);
  ELSE
    PERFORM app_private.subscription_coverage_record(
      p_company_id, 'manual', NULL, v_start, p_subscription_expires_at, v_grants,
      CASE WHEN v_company.plan IN ('basic', 'advanced', 'premium') THEN v_company.plan END,
      NULL, nullif(trim(p_reason), ''), true);
  END IF;

  SELECT * INTO v_after FROM public.companies WHERE id = p_company_id;

  PERFORM app_private.platform_rpc_record('write', c_action, NULL, p_company_id, 'company', p_company_id::text,
    jsonb_build_object('subscription_status', v_company.subscription_status,
                       'subscription_started_at', v_company.subscription_started_at,
                       'subscription_expires_at', v_company.subscription_expires_at,
                       'subscription_duration_type', v_company.subscription_duration_type,
                       'status', v_company.status),
    jsonb_build_object('subscription_status', v_after.subscription_status,
                       'subscription_started_at', v_after.subscription_started_at,
                       'subscription_expires_at', v_after.subscription_expires_at,
                       'subscription_duration_type', v_after.subscription_duration_type,
                       'status', v_after.status,
                       'requested_status', p_subscription_status,
                       'reason', p_reason));

  RETURN jsonb_build_object('success', true);
END;
$$;

ALTER FUNCTION public.update_company_subscription_manual(uuid, text, timestamptz, timestamptz, text, text)
  OWNER TO CURRENT_USER;

-- 8c. platform_company_set_plan
--
-- The body of 20260916130000 with one addition: the tier is carried onto the
-- coverage rows that cover now, so the next recompute agrees with the screen
-- instead of reverting it. Nothing else moves — the same capability, the same
-- validation, the same audit row, the same answer.
CREATE OR REPLACE FUNCTION public.platform_company_set_plan(
  p_company_id    uuid,
  p_plan          text    DEFAULT NULL,
  p_billing_cycle text    DEFAULT NULL,
  p_car_limit     integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'billing.set_plan';
  v_before public.companies%ROWTYPE;
  v_after  public.companies%ROWTYPE;
BEGIN
  IF NOT app_private.platform_rpc_authorize('billing.manage', 'write', c_action,
                                            p_company_id, 'company', p_company_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF p_company_id IS NULL
     OR (p_plan IS NULL AND p_billing_cycle IS NULL AND p_car_limit IS NULL)
     OR (p_plan IS NOT NULL AND p_plan NOT IN ('basic', 'advanced', 'premium'))
     OR (p_billing_cycle IS NOT NULL AND p_billing_cycle NOT IN ('monthly', 'yearly'))
     OR (p_car_limit IS NOT NULL AND (p_car_limit < 1 OR p_car_limit > 200))
  THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid', p_company_id, 'company', p_company_id::text, NULL,
      jsonb_build_object('plan', p_plan, 'billing_cycle', p_billing_cycle, 'car_limit', p_car_limit));
  END IF;

  SELECT * INTO v_before FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'company', p_company_id::text, NULL, NULL);
  END IF;

  -- The period the company is on now carries the tier it was bought at (rule 4
  -- is about the price; the tier travels with it). Without this the recompute
  -- would read the old tier off the coverage row and undo the change.
  IF p_plan IS NOT NULL THEN
    UPDATE public.subscription_coverage
       SET plan = p_plan
     WHERE company_id = p_company_id
       AND status = 'active'
       AND grants_access
       AND period_start <= now()
       AND (period_end IS NULL OR period_end > now());
  END IF;

  UPDATE public.companies
     SET plan                   = coalesce(p_plan, plan),
         billing_cycle          = coalesce(p_billing_cycle, billing_cycle),
         subscription_car_limit = coalesce(p_car_limit, subscription_car_limit),
         updated_at             = now()
   WHERE id = p_company_id
  RETURNING * INTO v_after;

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, p_company_id, 'company', p_company_id::text,
    jsonb_build_object('plan', v_before.plan, 'billing_cycle', v_before.billing_cycle,
                       'subscription_car_limit', v_before.subscription_car_limit),
    jsonb_build_object('plan', v_after.plan, 'billing_cycle', v_after.billing_cycle,
                       'subscription_car_limit', v_after.subscription_car_limit));
END;
$$;

ALTER FUNCTION public.platform_company_set_plan(uuid, text, text, integer) OWNER TO CURRENT_USER;

-- 8d. platform_company_set_approval
--
-- The body of 20260916130000 with one decision changed: `suspend` no longer
-- writes approval_status = 'suspended', because that value no longer exists
-- (rule 3). It suspends the company where suspension lives. Approve and reject
-- are untouched, and so are the action names, the audit row and the answer.
--
-- What a platform administrator sees: a company suspended from the Freigaben
-- table stays listed under `approved` and shows `suspended` in the lifecycle
-- column, and the way back is the lifecycle menu's `reactivate` — which now
-- works, where before it reset only one of three flags.
CREATE OR REPLACE FUNCTION public.platform_company_set_approval(
  p_company_id uuid,
  p_decision   text,
  p_reason     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_action text := CASE p_decision
                     WHEN 'approve' THEN 'company.approve'
                     WHEN 'reject'  THEN 'company.reject'
                     WHEN 'suspend' THEN 'company.suspend_approval'
                     ELSE 'company.set_approval'
                   END;
  v_actor  uuid := auth.uid();
  v_before public.companies%ROWTYPE;
  v_after  public.companies%ROWTYPE;
BEGIN
  IF NOT app_private.platform_rpc_authorize('companies.lifecycle', 'write', v_action,
                                            p_company_id, 'company', p_company_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF p_company_id IS NULL OR p_decision IS NULL OR p_decision NOT IN ('approve', 'reject', 'suspend') THEN
    RETURN app_private.platform_rpc_finish('write', v_action, 'invalid', p_company_id, 'company', p_company_id::text,
                                           NULL, jsonb_build_object('decision', p_decision));
  END IF;

  SELECT * INTO v_before FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', v_action, 'not_found', NULL, 'company', p_company_id::text, NULL, NULL);
  END IF;

  IF p_decision = 'approve' THEN
    UPDATE public.companies
       SET approval_status  = 'approved',
           approved_at      = now(),
           approved_by      = v_actor,
           rejection_reason = NULL,
           updated_at       = now()
     WHERE id = p_company_id
    RETURNING * INTO v_after;
  ELSIF p_decision = 'reject' THEN
    UPDATE public.companies
       SET approval_status  = 'rejected',
           rejected_at      = now(),
           rejected_by      = v_actor,
           rejection_reason = nullif(trim(p_reason), ''),
           updated_at       = now()
     WHERE id = p_company_id
    RETURNING * INTO v_after;
  ELSE
    UPDATE public.companies
       SET status     = 'suspended',
           updated_at = now()
     WHERE id = p_company_id
    RETURNING * INTO v_after;
  END IF;

  RETURN app_private.platform_rpc_finish('write', v_action, NULL, p_company_id, 'company', p_company_id::text,
    jsonb_build_object('approval_status', v_before.approval_status, 'rejection_reason', v_before.rejection_reason,
                       'approved_at', v_before.approved_at, 'rejected_at', v_before.rejected_at,
                       'status', v_before.status),
    jsonb_build_object('approval_status', v_after.approval_status, 'rejection_reason', v_after.rejection_reason,
                       'approved_at', v_after.approved_at, 'rejected_at', v_after.rejected_at,
                       'status', v_after.status));
END;
$$;

ALTER FUNCTION public.platform_company_set_approval(uuid, text, text) OWNER TO CURRENT_USER;

-- ─── 9. Self-check ──────────────────────────────────────────────────────────

DO $mig$
DECLARE
  c_recompute CONSTANT text := 'app_private.recompute_company_subscription(uuid)';
  c_record    CONSTANT text := 'app_private.subscription_coverage_record(uuid,text,uuid,timestamptz,timestamptz,boolean,text,bigint,text,boolean)';
  c_sweep     CONSTANT text := 'app_private.recompute_all_company_subscriptions()';
  c_backfill  CONSTANT text := 'app_private.subscription_backfill_company(uuid)';
  v_sig  text;
  v_role text;
  v_n    bigint;
  v_txt  text;
BEGIN
  -- 1. the four helpers exist, are SECURITY DEFINER and pin their search_path
  FOREACH v_sig IN ARRAY ARRAY[c_recompute, c_record, c_sweep, c_backfill] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION '20260919150000 self-check: % is missing', v_sig;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) THEN
      RAISE EXCEPTION '20260919150000 self-check: % is not SECURITY DEFINER', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                    WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=%') THEN
      RAISE EXCEPTION '20260919150000 self-check: % has no pinned search_path', v_sig;
    END IF;
    -- 2. nobody the API authenticates as may call them
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_function_privilege(v_role, v_sig::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION '20260919150000 self-check: % may call %', v_role, v_sig;
      END IF;
    END LOOP;
  END LOOP;

  -- 3. every function that reaches app_private is owned by a role that can
  --    (see tests/fixtures/owner-simulation.sql, and PR #25)
  FOREACH v_sig IN ARRAY ARRAY[
      c_recompute, c_record, c_sweep, c_backfill,
      'public.redeem_activation_code(text)',
      'public.update_company_subscription_manual(uuid,text,timestamptz,timestamptz,text,text)',
      'public.platform_company_set_plan(uuid,text,text,integer)',
      'public.platform_company_set_approval(uuid,text,text)']
  LOOP
    IF NOT EXISTS (SELECT 1
                     FROM pg_proc p
                     JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = to_regprocedure(v_sig)
                      AND (r.rolsuper
                           OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private'))) THEN
      RAISE EXCEPTION '20260919150000 self-check: the owner of % can reach no app_private helper', v_sig;
    END IF;
  END LOOP;

  -- 4. the table: RLS on, SELECT only, and no write policy for anyone
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.subscription_coverage'::regclass) THEN
    RAISE EXCEPTION '20260919150000 self-check: subscription_coverage has no row-level security';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'subscription_coverage' AND cmd <> 'SELECT';
  IF v_n > 0 THEN
    RAISE EXCEPTION '20260919150000 self-check: subscription_coverage carries % write policy(ies) — its only writers are the helpers above', v_n;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH v_txt IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege(v_role, 'public.subscription_coverage', v_txt) THEN
        RAISE EXCEPTION '20260919150000 self-check: % holds % on subscription_coverage', v_role, v_txt;
      END IF;
    END LOOP;
  END LOOP;
  IF has_table_privilege('anon', 'public.subscription_coverage', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.subscription_coverage', 'SELECT') THEN
    RAISE EXCEPTION '20260919150000 self-check: SELECT on subscription_coverage should be authenticated only';
  END IF;

  -- 5. its SELECT predicate is the account shell, not the active helper. A
  --    company whose coverage ran out is exactly the one that has to read it,
  --    and the choice also decides whether 20260917140000's derived trigger
  --    list and platform-contexts.sql section 14 expect a trigger here.
  SELECT coalesce(p.qual, '') INTO v_txt
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'subscription_coverage' AND p.cmd = 'SELECT';
  IF v_txt !~ 'get_user_company_id' OR v_txt ~ 'get_active_company_id' THEN
    RAISE EXCEPTION '20260919150000 self-check: subscription_coverage_select does not read the account shell helper';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger g
              WHERE g.tgrelid = 'public.subscription_coverage'::regclass
                AND g.tgname = 'refuse_read_only_context_write'
                AND NOT g.tgisinternal) THEN
    RAISE EXCEPTION '20260919150000 self-check: subscription_coverage carries the view-context refusal trigger, which its shell predicate does not call for';
  END IF;

  -- 6. rule 3 holds in the stored data and in the vocabulary
  SELECT count(*) INTO v_n FROM public.companies
   WHERE approval_status = 'suspended' OR subscription_status = 'suspended';
  IF v_n > 0 THEN
    RAISE EXCEPTION '20260919150000 self-check: % company(ies) still carry a suspension outside companies.status', v_n;
  END IF;
  FOREACH v_txt IN ARRAY ARRAY['companies_approval_status_check', 'companies_subscription_status_check'] LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint c
                WHERE c.conrelid = 'public.companies'::regclass
                  AND c.conname = v_txt
                  AND pg_get_constraintdef(c.oid) ~ '''suspended''') THEN
      RAISE EXCEPTION '20260919150000 self-check: % still admits ''suspended''', v_txt;
    END IF;
  END LOOP;
  -- …and companies.status still does, or suspension has nowhere to live
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'public.companies'::regclass
                    AND c.conname = 'companies_status_check'
                    AND pg_get_constraintdef(c.oid) ~ '''suspended''') THEN
    RAISE EXCEPTION '20260919150000 self-check: companies.status no longer admits ''suspended''';
  END IF;

  -- 7. the writers no longer assign the two derived columns, and the recompute
  --    does. A rewrite that puts an assignment back is what this catches.
  FOREACH v_sig IN ARRAY ARRAY[
      'public.redeem_activation_code(text)',
      'public.update_company_subscription_manual(uuid,text,timestamptz,timestamptz,text,text)']
  LOOP
    v_txt := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig));
    -- \m is a word boundary: the column, not the p_subscription_status argument
    -- that update_company_subscription_manual still compares against.
    IF v_txt ~ '\msubscription_status\s*=\s*''' OR v_txt ~ '\msubscription_expires_at\s*=\s*p_' THEN
      RAISE EXCEPTION '20260919150000 self-check: % assigns a column the recompute owns', v_sig;
    END IF;
    IF v_txt !~ 'recompute_company_subscription|subscription_coverage_record' THEN
      RAISE EXCEPTION '20260919150000 self-check: % no longer records coverage', v_sig;
    END IF;
  END LOOP;

  -- 8. …and the recompute is the thing that does assign them
  v_txt := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure(c_recompute));
  IF v_txt !~ 'subscription_status' OR v_txt !~ 'subscription_expires_at' OR v_txt !~ '\mplan\M' THEN
    RAISE EXCEPTION '20260919150000 self-check: % no longer writes all three derived columns', c_recompute;
  END IF;

  -- 9. rule 5: no invoice grants access in U1. A coverage row from an invoice
  --    is U2's, and U2 needs a grace-days number the owner has not given.
  SELECT count(*) INTO v_n FROM public.subscription_coverage WHERE source = 'invoice';
  IF v_n > 0 THEN
    RAISE EXCEPTION '20260919150000 self-check: % invoice coverage row(s) exist — invoices do not affect access in U1', v_n;
  END IF;

  -- 10. the gate of section 7 actually ran. A migration that lost it would
  --     apply silently, which is the one failure mode this slice cannot have.
  IF to_regclass('pg_temp._u1_before') IS NULL OR to_regclass('pg_temp._u1_after') IS NULL THEN
    RAISE EXCEPTION '20260919150000 self-check: the before/after access comparison of section 7 did not run';
  END IF;

  RAISE NOTICE '20260919150000 self-check: passed';
END $mig$;

-- The comparison tables have served their purpose and the self-check has
-- confirmed they ran.
DROP TABLE IF EXISTS _u1_before;
DROP TABLE IF EXISTS _u1_after;
DROP TABLE IF EXISTS _u1_company_before;
DROP TABLE IF EXISTS _u1_company_after;
