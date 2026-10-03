/*
  # Fixed costs per month

  Owner's request (03.10.2026): each month has its own fixed costs; a new month
  starts as a copy of the previous one, the user edits that month freely
  without touching history, and the screen lists months, each expandable.

  ## Model

  `fixed_costs.period_month` (date, nullable): the FIRST DAY of the month a row
  belongs to, or NULL for the rows that existed before this migration.

  A month's costs are resolved by the reader (src/utils/fixedCostMonths.ts):
    1. the month's own rows, if it has any;
    2. otherwise the rows of the newest EARLIER month that has some;
    3. otherwise the NULL rows.
  So NULL means "the baseline: applies to every month until a month of its own
  supersedes it".

  ## Inheritance is lazy

  Nothing is written for a month nobody edits. The first edit, addition or
  deletion in an inherited month copies the inherited rows into that month in
  ONE insert (with the edit applied), so a month is never half copied.
  Consequence worth knowing: a month with zero own rows reads as "inherited",
  so the screen refuses to delete the last row of a month that has something to
  inherit; set the amount to 0 instead.

  ## Existing rows

  Chosen: they KEEP period_month NULL. No row is updated, moved or deleted, so
  production's data is untouched and the previous release (which ignores the
  column and sums every row) keeps working, and a rollback needs nothing.
  Backfilling them to their created_at month was rejected: it invents a start
  month for rows the owner entered as "always", and would make January's cost
  list empty of rent that was being paid in January.

  ## Security

  No policy changes. fixed_costs already carries the four tenant policies with
  the 'fixed-costs' page gate (20260917130000, 20260923130000) and both context
  triggers (20260917140000, 20260920110000). A new nullable column needs no
  SCHEMA_EPOCH bump. The self-check below fails the release if any of that is
  lost, and checks the column's shape.

  ## Not covered here

  OverviewPage still sums every fixed_costs row for a month's figures; it must
  read through the resolver once this ships with data in it (see the report).
*/

ALTER TABLE public.fixed_costs
  ADD COLUMN IF NOT EXISTS period_month date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.fixed_costs'::regclass AND conname = 'fixed_costs_period_month_first_day'
  ) THEN
    ALTER TABLE public.fixed_costs
      ADD CONSTRAINT fixed_costs_period_month_first_day
      CHECK (period_month IS NULL OR period_month = date_trunc('month', period_month)::date);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fixed_costs_company_month_idx
  ON public.fixed_costs (company_id, period_month);

COMMENT ON COLUMN public.fixed_costs.period_month IS
  'First day of the month this row belongs to. NULL = baseline from before per-month costs: applies to every month until a month has rows of its own.';

-- Self-check
DO $$
DECLARE
  v_cmd text;
  v_n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'fixed_costs'
       AND column_name = 'period_month' AND data_type = 'date' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'fixed_costs per month self-check: period_month is missing or not a nullable date';
  END IF;

  IF EXISTS (SELECT 1 FROM public.fixed_costs
              WHERE period_month IS NOT NULL
                AND period_month <> date_trunc('month', period_month)::date) THEN
    RAISE EXCEPTION 'fixed_costs per month self-check: a period_month is not a first day';
  END IF;

  FOREACH v_cmd IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    SELECT count(*) INTO v_n FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'fixed_costs' AND cmd = v_cmd
       AND coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ 'current_role_permits\(''fixed-costs''';
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'fixed_costs per month self-check: % has % page-gated policies, expected 1', v_cmd, v_n;
    END IF;
  END LOOP;

  FOR v_cmd IN SELECT unnest(ARRAY['refuse_read_only_context_write', 'record_support_write']) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgrelid = 'public.fixed_costs'::regclass AND NOT tgisinternal AND tgname = v_cmd) THEN
      RAISE EXCEPTION 'fixed_costs per month self-check: trigger % is missing', v_cmd;
    END IF;
  END LOOP;
END $$;
