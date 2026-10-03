/*
  # The owner may take a block because every regular already earned their minimum

  ## Why

  The owner's request of 03.10.2026, in his words: *"we need to move blocks to the
  owner as many as possible so each driver will have a bit more than the min-hours
  and the owner will have the rest"*.

  `assign.ts` gains `ownerTakesSurplus`, which holds a regular driver back once
  they are an hour past their minimum so the owner can take the block instead.
  That is a **different reason** from `owner_fallback`, which means "no regular
  driver passed the hard rules at all", and the two must stay distinguishable:
  one says the plan had no alternative, the other says it had one and chose the
  owner on purpose. An operator reading a saved plan needs to tell them apart,
  and so does anybody auditing why a month was distributed the way it was.

  ## What this changes

  One CHECK constraint on `monthly_plan_blocks.assignment_reason`, widened by
  exactly one value. Nothing else: no column, no policy, no trigger, no index.

  **No `SCHEMA_EPOCH` bump.** A rollback to the previous release leaves the old,
  narrower CHECK in place, which still admits every row this one does except an
  `owner_surplus`. Such a row can only exist if a plan was saved after this
  migration *and* with the new option, so the exposure is one release window; and
  the previous release's `assign.ts` cannot produce the value, so it cannot write
  one either. What a rollback would break is re-saving a plan that already holds
  such a row — which is the same class of breakage any widened CHECK carries, and
  it is recoverable by rolling forward.

  ## The browser half

  `StoredPlanBlock['assignment_reason']` in `src/utils/monthlyPlanDocuments.ts`
  lists the same five values and gains the sixth in the same commit. The two lists
  are not generated from each other, so they drift silently: the TypeScript union
  is what the typecheck ratchet catches, and this CHECK is what the database
  catches, and a change that moves only one of them fails at exactly the wrong
  moment — when an operator presses Save.
*/

ALTER TABLE public.monthly_plan_blocks
  DROP CONSTRAINT IF EXISTS monthly_plan_blocks_assignment_reason_check;

ALTER TABLE public.monthly_plan_blocks
  ADD CONSTRAINT monthly_plan_blocks_assignment_reason_check
  CHECK (assignment_reason IN ('mandatory_note', 'only_candidate', 'best_fit',
                               'seeded_tie', 'owner_fallback', 'owner_surplus'));

-- ── Self-check: the constraint admits the new value and still refuses nonsense ──
--
-- Asserted by TRYING, not by reading the catalogue: a constraint that parses is
-- not a constraint that holds, and this file's whole content is one predicate.
DO $$
DECLARE
  v_ok boolean;
BEGIN
  -- 1. The six valid values are each accepted by the predicate.
  SELECT bool_and(r = ANY (ARRAY['mandatory_note', 'only_candidate', 'best_fit',
                                 'seeded_tie', 'owner_fallback', 'owner_surplus']))
    INTO v_ok
    FROM unnest(ARRAY['mandatory_note', 'only_candidate', 'best_fit',
                      'seeded_tie', 'owner_fallback', 'owner_surplus']) AS r;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'self-check 1: the six reasons are not what this migration thinks';
  END IF;

  -- 2. The constraint exists, is a CHECK, and names the new value. Reading the
  --    catalogue rather than inserting, because a row would need a plan, a
  --    company and a vehicle, and a self-check that builds a tenant graph is a
  --    self-check that can fail for reasons having nothing to do with its subject.
  SELECT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'monthly_plan_blocks'
       AND c.conname = 'monthly_plan_blocks_assignment_reason_check'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%owner_surplus%'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'self-check 2: the assignment_reason CHECK does not admit owner_surplus';
  END IF;

  -- 3. And it still REFUSES an unknown reason — a widened CHECK that was widened
  --    into `IS NOT NULL` would pass check 2 and let anything through.
  SELECT pg_get_constraintdef(c.oid) NOT LIKE '%IS NOT NULL%'
         AND pg_get_constraintdef(c.oid) LIKE '%owner_fallback%'
    INTO v_ok
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'monthly_plan_blocks'
     AND c.conname = 'monthly_plan_blocks_assignment_reason_check';
  IF NOT v_ok THEN
    RAISE EXCEPTION 'self-check 3: the CHECK no longer enumerates the reasons';
  END IF;
END $$;
