/*
  # The monthly plan: one active plan per month, and a snapshot of the driver
    values it was made with (requirement sections 9 and 13)

  The engine this schema stores the output of is src/utils/monthlyPlan/ —
  blocks, hoursRange, availability, assign, validate. Its types are the shape
  persisted here, name for name. Nothing in this file re-implements a planning
  rule; it stores a result and refuses a stored result that contradicts the
  rules it can re-derive from what is stored.

  ── THE RULE THIS PRESERVES, AND IT DECIDES THE WHOLE SHAPE ────────────────

  The monthly plan is a **proposal**, never a record. Its outputs are labelled
  PLANUNG, and it writes nothing to `fahrtenbuch_trips`:

    · requirement section 2 says to build a planning representation and to
      leave the ride's car, plate, times, distance and destination alone;
    · requirement section 10 says the new Fahrtenbuch is *generated from the
      original data* with the driver filled in from the plan — a document, not
      a write back;
    · CLAUDE.md: `fahrtenbuch_trips` is append-only, its mutable columns are
      written by RPC only, and it has no UPDATE policy at all.

  So no table here has a foreign key to `fahrtenbuch_trips`, no function here
  names it, and there is no assignment RPC and no change to
  `protect_fahrtenbuch_immutable_fields`. Self-check 9 reads the catalogue and
  fails a release where either becomes false. A schema that made it possible to
  write a past month's drivers from this plan would be the wrong schema.

  A block does carry the ids of the rides it is made of, because a block *is* a
  set of rides (section 13 asks for that relation by name). That is a read-only
  lineage in the other direction and is the opposite of a write.

  ── SECTION 9: WHAT TODAY'S SCHEMA FAILS TO DO, MEASURED ──────────────────

  Section 9 requires that no more than one saved active plan exist for a month,
  that a replacement be atomic, and that the rule be enforced "in the service or
  the database layer as well, and not in the UI only". Measured against the
  migration chain on 30.09.2026, it is enforced nowhere:

    · `company_planning_runs` (20260606101343) has no unique constraint and no
      unique index at all — not on (company_id, month, year), not partial on
      the applied status. Its only constraint is the primary key.
    · No planning function takes a lock. Neither `apply_monthly_planning_run`
      nor `replace_monthly_planning_run` uses SELECT ... FOR UPDATE or
      pg_advisory_xact_lock, so two concurrent applies both succeed.
    · `apply_monthly_planning_run`'s "already applied" guard keys on
      `import_id` as well as the month, and `fahrtenbuch_imports` has only a
      non-unique (company_id, year, month) index — so two imports of one month
      give two applied runs and neither blocks the other.
    · `replace_monthly_planning_run` sets `status = 'replaced'` and **keeps**
      `applied_at`, while that same guard selects on `applied_at IS NOT NULL`
      — so after one replacement the guard points at the old run for ever.

  None of that is repaired here. The legacy pipeline is live, its bodies are
  ahead of this chain (20260928110000 records that `min_block_duration_minutes`
  exists in the live functions and in no migration), and adding a unique index
  to a production table this file cannot measure would be a release that either
  fails on existing rows or changes the legacy replace flow. This file enforces
  section 9 for the feature it is the schema of, and names the legacy defect so
  the next person does not re-measure it.

  Here the rule is a **partial unique index**:

      CREATE UNIQUE INDEX monthly_plans_one_confirmed_per_month
        ON public.monthly_plans (company_id, year, month)
        WHERE status = 'confirmed';

  `import_id` is deliberately **not** part of it: keying on the import is the
  legacy defect above, and a month may be imported more than once. It is kept
  as nullable lineage only.

  Drafts are not unique: section 1's first screen says a month that already has
  a saved plan may still have a new proposal prepared, with the conflict handled
  at the final save. That conflict is `public.monthly_plan_confirm`, which takes
  `pg_advisory_xact_lock` on the company, year and month before it looks, so two
  concurrent confirmations serialise instead of racing the index.

  ── SECTION 13: THE SNAPSHOT, AND WHO TAKES IT ────────────────────────────

  Section 13: "it is preferable to store a snapshot of the driver values used in
  the plan so that later edits to the driver file do not change the reading of
  an old plan." `company_planning_runs` stores no driver figure at all — not in
  a column, not in `settings_json`, not in `summary_json`.

  `public.monthly_plan_drivers` is that snapshot, and the pattern is
  `driver_month_budget`'s (20260922110000): **the database takes the copy, from
  `public.drivers`, and discards whatever the client sent.** The eight values
  are exactly requirement section 4's list — minimum salary, maximum salary,
  hourly rate, maximum monthly hours, planning priority, planning enabled,
  can-cover-other-drivers, and the owner flag — plus the driver's name, so a
  renamed or deleted driver still reads on an old plan.

  **`drivers.target_monthly_hours` is not among them and must never be.**
  Sections 5 and 17.12 state it twice: the field is ignored entirely in this
  feature — not as a target, not as a constraint, not as a sort key, and not in
  anything shown as part of a planning decision. Self-check 10 fails a release
  where a column of that name appears on this table.

  The snapshot holds only figures the plan could compute with, and
  `range_problems` names why any is absent, in `computeHoursRange`'s own five
  words. The guard derives both: a rate that is NULL, zero, negative, NaN or
  Infinity is stored as NULL with the reason, which is `positiveOrNull` in
  src/utils/monthlyPlan/hoursRange.ts. What is given up: the literal refused
  figure is not kept, only its class. `drivers` still holds it unless somebody
  edits the row, and once they do, "this plan was made with an unusable rate" is
  the true statement — not the new number.

  ── SECTION 14's TWO CHECKS, AND WHY THEY ARE NOT ON `drivers` ────────────

  Section 14 asks for an invalid hourly rate and a minimum above the maximum to
  be handled clearly. `planning_run_adjustments` already has CHECK
  (hourly_rate > 0), so the pattern exists. Measured before choosing where to
  put them:

    · `drivers.planning_hourly_rate` is a bare nullable `numeric` with no CHECK
      (20260606061909, restated in 00000000000000_baseline_schema.sql), and
      `DriverModal.tsx` renders it as `<Input type="number" min="0">` — so
      **zero is a value the product accepts today**, and
      HistoricalWorkingHoursWizard.tsx:10121 turns a missing rate into 0 cents.
      An `ALTER TABLE public.drivers ADD CONSTRAINT ... CHECK
      (planning_hourly_rate > 0)` is validated against every existing row, so a
      single driver with 0 on production fails the release. This file cannot
      read production, and a check whose success depends on data it has not seen
      is not a check to put in a release.
    · `planning_min_salary <= planning_max_salary` is enforced only in the
      browser (DriverModal.tsx:148, and only when both fields are non-empty),
      so an older row can hold either order.

  So both checks live **where the plan reads the value** — on
  `public.monthly_plan_drivers`, the snapshot — and not on the column. A driver
  whose figures are unusable is not refused: the guard stores NULL and the
  reason, the engine gives such a driver no blocks (`no_usable_range`), and
  `monthly_plan_confirm` refuses a plan that nevertheless assigned them work.
  One misconfigured driver therefore cannot block a whole month, which is what a
  CHECK on the snapshot alone would have done.

  Both CHECKs are written `> 0 AND < 'Infinity'`, not `> 0`. **PostgreSQL's
  `numeric` has NaN, and NaN compares greater than every other value**, so
  `NaN > 0` is true and `> 0` alone would admit it; `NaN < 'Infinity'` is false.
  That pair is `positiveOrNull`'s rejection of NaN and Infinity, in SQL.

  ── WHY NOT `company_planning_run_blocks` ─────────────────────────────────

  That table (20260606101343, 19 columns, one index) is dead: nothing in `src/`
  writes or reads it — the only mentions are a comment in
  MonatsplanungAppliedRuns.tsx and its name in backup.ts's table list. It is
  still not reused, and not dropped either, for reasons measured in its DDL:

    1. Its times are `start_time text` and `end_time text` beside a
       `block_date date`. The engine's whole premise is absolute instants:
       "build intervals from date-midnight-ms + secondOfDay, never from a bare
       HH:MM:SS string (which parses to 0)". Storing a block's bounds as clock
       text re-creates exactly the cross-midnight defect CLAUDE.md warns about
       twice.
    2. It has one `duration_minutes`. Section 3 requires **two** figures per
       block — the wall-clock span and the sum of the actual rides — and their
       difference is the idle time a later document must not have to re-derive.
       One column loses that by construction.
    3. It has no vehicle column at all. Blocks are built per vehicle and may
       never mix two; the table cannot express its own subject.
    4. `trip_ids text[]` is neither typed as uuid nor a relation, and section 13
       asks for the relation between a block and its rides.
    5. It is wired to the legacy run through `run_id REFERENCES
       company_planning_runs`, carries that pipeline's tenant policies, its
       matrix lines and its slice-C page gate, and its `status`, `source`,
       `reason` and `driver_usage_type` mean what the legacy apply meant by
       them. Two features writing one table with two vocabularies is how a
       payroll figure goes wrong quietly.
    6. There is no data in it to migrate, so nothing is lost by leaving it.

  Dropping it is not this file's call — it is in backup.ts's list and in
  matrix.sql — so it is left exactly as it is.

  ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────

  · **No document table.** Section 13 also names a plan document (type, driver,
    file reference, created_at) for the three outputs of sections 10 to 12.
    That is the documents slice's, not this one's; when it comes it takes this
    file's shape.
  · **No CHECK on the planned month against the clock.** A CHECK expression
    must be immutable, so it would have to be a trigger, and a trigger that
    refuses a past month would also refuse a legitimate re-plan of the current
    one and would depend on the session's clock at the boundary of a month. The
    guarantee that matters is the one self-check 9 makes instead: this schema
    cannot write a trip.
  · **No `ride_minutes <= span_minutes` CHECK.** It looks obviously true and is
    not: both figures are rounded to whole minutes independently, so two rides
    of 40 seconds inside one block round to 1 + 1 = 2 ride minutes while the
    block's span rounds to 1. The constraint would refuse a legitimate plan.
  · **No per-driver totals, and no stored hours range.** Assigned minutes,
    block counts and the position in the range are derivable from the blocks
    and the snapshot, and CLAUDE.md's rule for this domain is one source of
    truth per figure. The bounds would also have to be rounded to store, and
    `hoursRange.ts` keeps them at full precision on purpose: 1950 / 14 is
    139.285714…, and forcing it into fewer digits makes requirement section
    16's own figure unreachable.

  ── ACCESS: 20260917130000's SHAPE, WITH SLICE C's PAGE ──────────────────

    SELECT   company_id = (SELECT get_active_company_id())
             OR (SELECT platform_reads_company_data())
    INSERT   (company_id = (SELECT get_active_company_id())
              AND (SELECT current_role_permits('documents', true)))
             OR (SELECT platform_writes_company_data())
    UPDATE   the same, as USING and as WITH CHECK
    DELETE   the same

  `documents` is the page every planning table took in slice C
  (20260923130000), and the Monatsplanung's output is the Stundennachweis and
  the corrected Fahrtenbuch, so the same page is the same answer here. SELECT
  carries no role term, as 3.3's shape does not. Both RPCs ask the same page
  themselves, because they are SECURITY DEFINER and run past RLS.

  All four tables carry both context triggers — `refuse_read_only_context_write`
  (3.4a: a view context writes nothing) and `record_support_write` (3.4c: every
  row a support session writes is audited). They are derived from the policies
  and not from who writes them today, which is the rule
  tests/rls/platform-contexts.sql section 14 and
  tests/rls/support-write-audit.sql section 1 state, and the reason
  `notification_deliveries` (20260924100000) carries both although no client
  writes it. The snapshot's pay figures are redacted by
  `app_private.support_write_redaction_pattern`'s existing name rule —
  `planning_min_salary`, `planning_max_salary` and `planning_hourly_rate` all
  match it — which self-check 13 asserts rather than assumes.

  `anon` holds nothing. `authenticated` holds SELECT, INSERT, UPDATE and DELETE
  and nothing else; the service role holds nothing, on the tables and on both
  RPCs, because both read `auth.uid()` and the service key carries no subject.

  **What a support session costs here is unmeasured, and it is one audit row per
  row written.** A month of 5000 rides saved from inside a support session
  writes about 5000 `support_write.monthly_plan_block_trips.insert` rows.
  CLAUDE.md already records that for the planning RPCs ("The planning RPCs write
  one row per trip; the added time is unmeasured"), and the same caveat applies:
  time a support-session save of a real month on staging before relying on it.

  ── COMPATIBILITY: this does NOT bump deploy/SCHEMA_EPOCH ────────────────

  Four new tables, three new trigger functions, two new RPCs. Nothing existing
  is altered — not a column, not a policy, not a function body — so the previous
  release runs unchanged beside them and simply never reads them.

  tests/rls/monthly-plan.sql is this file's kit; tests/rls/matrix.sql carries
  the four tables' and both RPCs' lines.
*/

-- ─── 1. the plan ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.monthly_plans (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  year                integer     NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month               integer     NOT NULL CHECK (month BETWEEN 1 AND 12),
  -- Lineage only. It is NOT part of the one-plan-per-month key: keying on the
  -- import is the legacy defect this file's header measures.
  import_id           uuid        NULL REFERENCES public.fahrtenbuch_imports(id) ON DELETE SET NULL,
  status              text        NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'confirmed', 'superseded')),
  -- Screen 2's field, in minutes. 0 is a value ("a boundary at every gap", the
  -- shortest possible blocking) and never "unset" — buildBlocks says so.
  switch_minutes      integer     NOT NULL CHECK (switch_minutes BETWEEN 0 AND 720),
  -- The "Neu generieren" counter of section 7 rule 9. The engine's seed.
  generation          integer     NOT NULL DEFAULT 0 CHECK (generation >= 0),
  -- validatePlan()'s warnings. Kept because section 3 screen 3 shows them and a
  -- confirmed plan must still be able to say what was incomplete about it.
  warnings            jsonb       NOT NULL DEFAULT '[]'::jsonb
                        CHECK (jsonb_typeof(warnings) = 'array'),
  summary             jsonb       NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(summary) = 'object'),
  confirmed_at        timestamptz NULL,
  confirmed_by        uuid        NULL,
  superseded_at       timestamptz NULL,
  superseded_by       uuid        NULL,
  replaced_by_plan_id uuid        NULL REFERENCES public.monthly_plans(id) ON DELETE SET NULL,
  created_by          uuid        NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid        NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT monthly_plans_confirmed_together
    CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL)),
  CONSTRAINT monthly_plans_status_matches_confirmation
    CHECK ((status = 'draft' AND confirmed_at IS NULL)
        OR (status IN ('confirmed', 'superseded') AND confirmed_at IS NOT NULL)),
  CONSTRAINT monthly_plans_superseded_together
    CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)
       AND (superseded_at IS NULL) = (superseded_by IS NULL))
);

COMMENT ON TABLE public.monthly_plans IS
  'A monthly driver plan: the proposal and, once confirmed, the month''s one '
  'active plan. Section 9''s rule is the partial unique index on '
  '(company_id, year, month) where status = confirmed; import_id is lineage and '
  'deliberately not part of it (20260930100000).';

-- Section 9, in the database and not in the UI. A month has at most one
-- confirmed plan; drafts may coexist, because screen 1 prepares a new proposal
-- beside a saved plan and monthly_plan_confirm resolves the conflict.
CREATE UNIQUE INDEX IF NOT EXISTS monthly_plans_one_confirmed_per_month
  ON public.monthly_plans (company_id, year, month)
  WHERE status = 'confirmed';

-- The screen's read: one company's months, newest first.
CREATE INDEX IF NOT EXISTS monthly_plans_company_period_idx
  ON public.monthly_plans (company_id, year DESC, month DESC, status);

-- ─── 2. the per-driver snapshot (section 13) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.monthly_plan_drivers (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid          NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  plan_id                 uuid          NOT NULL REFERENCES public.monthly_plans(id) ON DELETE CASCADE,
  -- No foreign key to public.drivers, and that is the point of a snapshot: a
  -- plan is the record of a decision and must not change or disappear when the
  -- staff table does. ON DELETE CASCADE would silently drop a driver out of a
  -- confirmed plan (section 23 forbids dropping anything silently) and RESTRICT
  -- would stop a company deleting a driver. The guard checks at write time that
  -- the driver belongs to the row's company, which is when integrity can still
  -- be had; afterwards the row is history.
  driver_id               uuid          NOT NULL,
  -- The database's copy of drivers.name, so a renamed driver does not re-label
  -- an old plan. Whatever the client sends is discarded.
  driver_name             text          NOT NULL,
  -- Screen 2's checkbox. An unselected driver may only be in a plan as the
  -- owner fallback of section 7 rule 8 and section 8.
  selected                boolean       NOT NULL,
  -- drivers.employment_type = 'company_owner'. Derived by the guard.
  is_owner                boolean       NOT NULL,
  -- Requirement section 4's eight driver values, as they stood when the plan
  -- was made. Taken by the guard from public.drivers, never from the client.
  -- drivers.target_monthly_hours is NOT here and must never be (section 5).
  planning_min_salary     numeric(10,2) NULL,
  planning_max_salary     numeric(10,2) NULL,
  planning_hourly_rate    numeric       NULL,
  max_monthly_hours       numeric       NULL,
  planning_priority       integer       NULL,
  planning_enabled        boolean       NULL,
  can_cover_other_drivers boolean       NULL,
  -- computeHoursRange()'s problems, in its own five words, derived by the guard
  -- from the figures above. Empty means the range is usable.
  range_problems          text[]        NOT NULL DEFAULT '{}'::text[],
  created_at              timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT monthly_plan_drivers_one_per_plan UNIQUE (plan_id, driver_id),
  -- Section 14, where the plan reads the value. `> 0` alone would admit NaN,
  -- which PostgreSQL's numeric orders above every other value; NaN is not less
  -- than Infinity, so the pair refuses NaN, Infinity, 0 and negatives — which
  -- is positiveOrNull() in hoursRange.ts.
  CONSTRAINT monthly_plan_drivers_hourly_rate_usable
    CHECK (planning_hourly_rate IS NULL
           OR (planning_hourly_rate > 0 AND planning_hourly_rate < 'Infinity'::numeric)),
  CONSTRAINT monthly_plan_drivers_max_hours_usable
    CHECK (max_monthly_hours IS NULL
           OR (max_monthly_hours > 0 AND max_monthly_hours < 'Infinity'::numeric)),
  -- Finite, and nothing more. The engine asks only Number.isFinite of a salary
  -- and accepts a negative one (an absurd figure, but its behaviour is the
  -- contract here, and a stricter CHECK would refuse a plan the engine made and
  -- do it with a bare constraint error). A numeric(10,2) column cannot hold
  -- Infinity at all, so NaN is the only non-number to exclude — and `< Infinity`
  -- is the test that excludes it, because NaN is not less than Infinity.
  CONSTRAINT monthly_plan_drivers_min_salary_finite
    CHECK (planning_min_salary IS NULL OR planning_min_salary < 'Infinity'::numeric),
  CONSTRAINT monthly_plan_drivers_max_salary_finite
    CHECK (planning_max_salary IS NULL OR planning_max_salary < 'Infinity'::numeric),
  -- Section 14: the minimum salary above the maximum is reported, never
  -- silently swapped. Here it cannot even be stored.
  CONSTRAINT monthly_plan_drivers_salary_range_ordered
    CHECK (planning_min_salary IS NULL OR planning_max_salary IS NULL
           OR planning_min_salary <= planning_max_salary),
  CONSTRAINT monthly_plan_drivers_range_problems_known
    CHECK (range_problems <@ ARRAY['missing_hourly_rate', 'invalid_hourly_rate',
                                   'missing_min_salary', 'missing_max_salary',
                                   'min_salary_above_max']::text[]),
  CONSTRAINT monthly_plan_drivers_unselected_is_owner
    CHECK (selected OR is_owner)
);

COMMENT ON TABLE public.monthly_plan_drivers IS
  'The driver values a monthly plan was made with (requirement section 13), '
  'copied from public.drivers by app_private.monthly_plan_driver_guard and never '
  'by the client. drivers.target_monthly_hours is deliberately absent '
  '(20260930100000).';

CREATE INDEX IF NOT EXISTS monthly_plan_drivers_company_idx
  ON public.monthly_plan_drivers (company_id);

-- ─── 3. the blocks (section 3) ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.monthly_plan_blocks (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  plan_id            uuid        NOT NULL REFERENCES public.monthly_plans(id) ON DELETE CASCADE,
  -- PlanBlock.id: the engine's own key, stable within one build. It is what the
  -- screen and monthly_plan_save join a payload's blocks to their stored rows
  -- by, so a second statement needs no round trip.
  block_key          text        NOT NULL,
  -- The block's vehicle. Blocks are built per vehicle and never mix two, and
  -- the engine's vehicle key is car_id where the car is in the fleet table and
  -- car_identifier (the plate from the import) where it is not. No foreign key,
  -- for the snapshot reason given on monthly_plan_drivers.driver_id.
  car_id             uuid        NULL,
  car_identifier     text        NULL,
  -- Absolute instants, never clock text. This is the whole premise of
  -- blocks.ts, and the reason company_planning_run_blocks is not reused.
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  -- Section 3 asks for both, and they are not the same number: the wall-clock
  -- length of the block, and the sum of the rides inside it. Their difference
  -- is the idle time, which no later document then has to re-derive.
  span_minutes       integer     NOT NULL CHECK (span_minutes >= 0),
  ride_minutes       integer     NOT NULL CHECK (ride_minutes >= 0),
  -- NULL is an unassigned block: section 8 says to leave one unassigned with a
  -- warning rather than break a constraint.
  driver_id          uuid        NULL,
  driver_name        text        NULL,
  assignment_reason  text        NULL
                       CHECK (assignment_reason IN ('mandatory_note', 'only_candidate',
                                                    'best_fit', 'seeded_tie', 'owner_fallback')),
  assignment_note_id uuid        NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT monthly_plan_blocks_key_per_plan UNIQUE (plan_id, block_key),
  CONSTRAINT monthly_plan_blocks_has_a_vehicle
    CHECK (car_id IS NOT NULL OR car_identifier IS NOT NULL),
  CONSTRAINT monthly_plan_blocks_ends_after_start CHECK (ends_at >= starts_at),
  CONSTRAINT monthly_plan_blocks_driver_with_reason
    CHECK ((driver_id IS NULL AND driver_name IS NULL AND assignment_reason IS NULL
            AND assignment_note_id IS NULL)
        OR (driver_id IS NOT NULL AND driver_name IS NOT NULL
            AND assignment_reason IS NOT NULL)),
  CONSTRAINT monthly_plan_blocks_note_only_for_mandatory
    CHECK (assignment_note_id IS NULL OR assignment_reason = 'mandatory_note')
);

COMMENT ON TABLE public.monthly_plan_blocks IS
  'One vehicle block of a monthly plan: its vehicle, its absolute bounds, its '
  'span and ride minutes, and the driver the assigner gave it. NULL driver is an '
  'unassigned block (requirement section 8) (20260930100000).';

CREATE INDEX IF NOT EXISTS monthly_plan_blocks_company_idx
  ON public.monthly_plan_blocks (company_id);
CREATE INDEX IF NOT EXISTS monthly_plan_blocks_plan_driver_idx
  ON public.monthly_plan_blocks (plan_id, driver_id);

-- ─── 4. the block-to-ride relation (section 13) ─────────────────────────────

CREATE TABLE IF NOT EXISTS public.monthly_plan_block_trips (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  plan_id              uuid        NOT NULL REFERENCES public.monthly_plans(id) ON DELETE CASCADE,
  block_id             uuid        NOT NULL REFERENCES public.monthly_plan_blocks(id) ON DELETE CASCADE,
  -- No foreign key to public.fahrtenbuch_trips, and each of the three options
  -- is wrong for a different reason: RESTRICT would refuse an administrator's
  -- deletion of an import, which is behaviour this file may not change; CASCADE
  -- would silently change a confirmed plan's figures when an import is deleted;
  -- SET NULL would lose the ride's identity while keeping its minutes. So the
  -- ride is named, and the three figures the block's arithmetic needs are
  -- copied, so a confirmed plan's totals cannot move under it.
  trip_id              uuid        NOT NULL,
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NOT NULL,
  minutes              integer     NOT NULL CHECK (minutes >= 0),
  -- TripTimeSource, minus 'unusable': a ride whose instants cannot be read is
  -- rejected by buildBlocks and never reaches a block, so 'unusable' is a
  -- rejection and not a stored state. Nothing else of the ride is copied — the
  -- new Fahrtenbuch of section 10 is built from the original data and takes only
  -- the driver from the plan.
  time_source          text        NOT NULL CHECK (time_source IN ('instants', 'date_and_clock')),
  -- Section 2: the original driver is kept internally, for tracking and for the
  -- pre-selection suggestion.
  original_driver_id   uuid        NULL,
  original_driver_name text        NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Section 23: no ride is counted twice, and none is silently in two blocks.
  CONSTRAINT monthly_plan_block_trips_one_block_per_ride UNIQUE (plan_id, trip_id),
  CONSTRAINT monthly_plan_block_trips_ends_after_start CHECK (ends_at >= starts_at)
);

COMMENT ON TABLE public.monthly_plan_block_trips IS
  'Which imported rides make up a monthly plan''s block, with the three figures '
  'the block''s arithmetic needs. No foreign key to fahrtenbuch_trips on purpose: '
  'this feature writes no trip and a confirmed plan''s totals may not move '
  '(20260930100000).';

CREATE INDEX IF NOT EXISTS monthly_plan_block_trips_company_idx
  ON public.monthly_plan_block_trips (company_id);
CREATE INDEX IF NOT EXISTS monthly_plan_block_trips_block_idx
  ON public.monthly_plan_block_trips (block_id);

-- ─── 5. the guards ──────────────────────────────────────────────────────────

/*
  "The plan exists, belongs to this company and is still a draft", in one place,
  because the two child guards ask it on three tables. Returns the plan row so a
  caller that needs more than the refusal can read it.

  A parent that is gone is a cascade — from the plan itself or from the company
  — and is allowed: the plan's own guard already refuses deleting anything but a
  draft, so a cascade can only ever reach a draft's children.
*/
CREATE OR REPLACE FUNCTION app_private.monthly_plan_parent_is_open(p_plan_id uuid, p_company_id uuid)
RETURNS public.monthly_plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_plan public.monthly_plans;
BEGIN
  SELECT * INTO v_plan FROM public.monthly_plans p WHERE p.id = p_plan_id;

  IF NOT FOUND THEN
    RETURN v_plan;
  END IF;

  IF v_plan.company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'Der Monatsplan gehört zu einem anderen Unternehmen.'
      USING ERRCODE = 'P0001', HINT = 'monthly_plan_company_mismatch';
  END IF;

  IF v_plan.status <> 'draft' THEN
    RAISE EXCEPTION 'Ein bestätigter Monatsplan kann nicht geändert werden.'
      USING ERRCODE = 'P0001', HINT = 'monthly_plan_is_final';
  END IF;

  RETURN v_plan;
END;
$fn$;

COMMENT ON FUNCTION app_private.monthly_plan_parent_is_open(uuid, uuid) IS
  'The one place the two child guards ask whether a monthly plan exists, belongs '
  'to the row''s company and is still a draft. A missing plan is a cascade and is '
  'allowed (20260930100000).';

/*
  All three run as their owner (SECURITY DEFINER) so that the driver and parent
  lookups answer the same whoever writes: "this driver belongs to this company"
  and "this plan is a draft" must not depend on what the caller may read.
  Nothing is returned to the caller from those reads — a mismatch raises, and a
  match only stamps a row RLS must still admit.

  Three rules they share:

    · a plan's key is fixed. Its company, year and month may not change, and a
      child may not move to another company or another plan. A snapshot that
      could be re-pointed would put one month's driver figures on another.
    · a confirmed plan is frozen. Section 22 says every document's totals come
      from the same plan, so once the plan is confirmed its blocks, rides and
      driver snapshot may not change — otherwise a Stundennachweis already
      handed to a Steuerberater and the rows it was built from disagree with
      nothing to say which is right.
    · status is not the client's. It moves only inside
      public.monthly_plan_confirm, which sets a transaction-local marker naming
      the plan and the transaction. Without the marker a status change raises.
      The partial unique index would already refuse a second confirmed plan; the
      marker is what makes the stamping of confirmed_by and confirmed_at, and
      the atomic supersede beside it, the database's and not a client's.
*/
CREATE OR REPLACE FUNCTION app_private.monthly_plan_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  c_marker CONSTANT text := 'app_private.monthly_plan_transition';
  v_uid    uuid := auth.uid();
  v_moves  boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A confirmed plan is the month's record and a superseded one is its
    -- history; neither is deleted. A draft is a proposal and may go.
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Ein bestätigter oder ersetzter Monatsplan kann nicht gelöscht werden.'
        USING ERRCODE = 'P0001', HINT = 'monthly_plan_is_final';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A plan is born a draft. Confirmation is monthly_plan_confirm's act.
    NEW.status              := 'draft';
    NEW.confirmed_at        := NULL;
    NEW.confirmed_by        := NULL;
    NEW.superseded_at       := NULL;
    NEW.superseded_by       := NULL;
    NEW.replaced_by_plan_id := NULL;
    NEW.created_by          := v_uid;
    NEW.created_at          := now();
    NEW.updated_by          := v_uid;
    NEW.updated_at          := now();
    RETURN NEW;
  END IF;

  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.year    IS DISTINCT FROM OLD.year
     OR NEW.month   IS DISTINCT FROM OLD.month THEN
    RAISE EXCEPTION 'Ein Monatsplan bleibt bei seinem Unternehmen und seinem Monat.'
      USING ERRCODE = 'P0001', HINT = 'monthly_plan_key_fixed';
  END IF;

  NEW.created_at := OLD.created_at;
  NEW.created_by := OLD.created_by;
  NEW.updated_by := v_uid;
  NEW.updated_at := now();

  v_moves := NEW.status              IS DISTINCT FROM OLD.status
          OR NEW.confirmed_at        IS DISTINCT FROM OLD.confirmed_at
          OR NEW.confirmed_by        IS DISTINCT FROM OLD.confirmed_by
          OR NEW.superseded_at       IS DISTINCT FROM OLD.superseded_at
          OR NEW.superseded_by       IS DISTINCT FROM OLD.superseded_by
          OR NEW.replaced_by_plan_id IS DISTINCT FROM OLD.replaced_by_plan_id;

  IF v_moves THEN
    IF nullif(current_setting(c_marker, true), '')
         IS DISTINCT FROM 'plan:' || OLD.id::text || ':' || pg_current_xact_id()::text THEN
      RAISE EXCEPTION 'Der Status eines Monatsplans wird nur über monthly_plan_confirm geändert.'
        USING ERRCODE = 'P0001', HINT = 'monthly_plan_transition_needs_rpc';
    END IF;

    -- The actor and the time are the database's on both transitions, whatever
    -- the caller sent.
    IF NEW.status = 'confirmed' THEN
      NEW.confirmed_at  := now();
      NEW.confirmed_by  := v_uid;
      NEW.superseded_at := NULL;
      NEW.superseded_by := NULL;
    ELSIF NEW.status = 'superseded' THEN
      NEW.confirmed_at  := OLD.confirmed_at;
      NEW.confirmed_by  := OLD.confirmed_by;
      NEW.superseded_at := now();
      NEW.superseded_by := v_uid;
    ELSE
      RAISE EXCEPTION 'Ein Monatsplan kann nicht auf % zurückgesetzt werden.', NEW.status
        USING ERRCODE = 'P0001', HINT = 'monthly_plan_transition_invalid';
    END IF;
    RETURN NEW;
  END IF;

  -- An ordinary edit. Only a draft has anything to edit.
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Ein bestätigter Monatsplan kann nicht geändert werden.'
      USING ERRCODE = 'P0001', HINT = 'monthly_plan_is_final';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION app_private.monthly_plan_guard() IS
  'Keeps a monthly plan with its company and month, freezes it once confirmed, '
  'and lets only monthly_plan_confirm move its status — stamping the actor and '
  'the time itself (20260930100000).';

/*
  The snapshot. Requirement section 13's "so that later edits to the driver file
  do not change the reading of an old plan" is only true if the client never
  supplies the figures, so every one of them is read here from public.drivers
  and whatever arrived is discarded — driver_month_budget_guard's rule, and the
  same reason.

  range_problems is derived from the copied figures in computeHoursRange's order
  and words, so a screen can print the same sentence from either side.
*/
CREATE OR REPLACE FUNCTION app_private.monthly_plan_driver_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_driver   record;
  v_problems text[] := '{}'::text[];
  v_rate     numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM app_private.monthly_plan_parent_is_open(OLD.plan_id, OLD.company_id);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (NEW.plan_id    IS DISTINCT FROM OLD.plan_id
          OR NEW.company_id IS DISTINCT FROM OLD.company_id
          OR NEW.driver_id  IS DISTINCT FROM OLD.driver_id) THEN
    RAISE EXCEPTION 'Eine Fahrer-Momentaufnahme bleibt bei ihrem Plan und ihrem Fahrer.'
      USING ERRCODE = 'P0001', HINT = 'monthly_plan_child_key_fixed';
  END IF;

  PERFORM app_private.monthly_plan_parent_is_open(NEW.plan_id, NEW.company_id);

  SELECT d.company_id, d.name, d.employment_type, d.planning_min_salary, d.planning_max_salary,
         d.planning_hourly_rate, d.max_monthly_hours, d.planning_priority, d.planning_enabled,
         d.can_cover_other_drivers
    INTO v_driver
    FROM public.drivers d
   WHERE d.id = NEW.driver_id;

  IF NOT FOUND OR v_driver.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'Der Fahrer gehört nicht zu diesem Unternehmen.'
      USING ERRCODE = 'P0001', HINT = 'driver_company_mismatch';
  END IF;

  -- The eight values of requirement section 4, from public.drivers.
  NEW.driver_name             := v_driver.name;
  NEW.is_owner                := (v_driver.employment_type = 'company_owner');
  NEW.max_monthly_hours       := CASE
                                   WHEN v_driver.max_monthly_hours IS NOT NULL
                                    AND v_driver.max_monthly_hours > 0
                                    AND v_driver.max_monthly_hours < 'Infinity'::numeric
                                   THEN v_driver.max_monthly_hours
                                 END;
  NEW.planning_priority       := v_driver.planning_priority;
  NEW.planning_enabled        := v_driver.planning_enabled;
  NEW.can_cover_other_drivers := v_driver.can_cover_other_drivers;

  -- Section 7 rule 8 and section 8: the only driver in a plan without having
  -- been selected is the owner, taking surplus nobody else could take.
  IF NOT coalesce(NEW.selected, false) AND NOT NEW.is_owner THEN
    RAISE EXCEPTION 'Nur der Inhaber kann ohne Auswahl Teil eines Monatsplans sein.'
      USING ERRCODE = 'P0001', HINT = 'monthly_plan_driver_not_selected';
  END IF;

  -- positiveOrNull(): 0, a negative, NaN and Infinity all fold into NULL, and
  -- NaN needs the upper bound because numeric orders it above everything.
  v_rate := CASE
              WHEN v_driver.planning_hourly_rate IS NOT NULL
               AND v_driver.planning_hourly_rate > 0
               AND v_driver.planning_hourly_rate < 'Infinity'::numeric
              THEN v_driver.planning_hourly_rate
            END;

  IF v_driver.planning_hourly_rate IS NULL THEN
    v_problems := v_problems || 'missing_hourly_rate';
  ELSIF v_rate IS NULL THEN
    -- Present but unusable. A different problem from missing: somebody typed
    -- something.
    v_problems := v_problems || 'invalid_hourly_rate';
  END IF;

  IF v_driver.planning_min_salary IS NULL
     OR NOT (v_driver.planning_min_salary < 'Infinity'::numeric) THEN
    v_problems := v_problems || 'missing_min_salary';
  END IF;
  IF v_driver.planning_max_salary IS NULL
     OR NOT (v_driver.planning_max_salary < 'Infinity'::numeric) THEN
    v_problems := v_problems || 'missing_max_salary';
  END IF;
  IF v_driver.planning_min_salary IS NOT NULL AND v_driver.planning_max_salary IS NOT NULL
     AND v_driver.planning_min_salary < 'Infinity'::numeric
     AND v_driver.planning_max_salary < 'Infinity'::numeric
     AND v_driver.planning_min_salary > v_driver.planning_max_salary THEN
    v_problems := v_problems || 'min_salary_above_max';
  END IF;

  NEW.range_problems := v_problems;

  -- Only figures the plan could compute with are stored. The reason any is
  -- absent is in range_problems; the refused figure itself stays on the driver.
  IF cardinality(v_problems) > 0 THEN
    NEW.planning_min_salary  := NULL;
    NEW.planning_max_salary  := NULL;
    NEW.planning_hourly_rate := NULL;
  ELSE
    NEW.planning_min_salary  := v_driver.planning_min_salary;
    NEW.planning_max_salary  := v_driver.planning_max_salary;
    NEW.planning_hourly_rate := v_rate;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION app_private.monthly_plan_driver_guard() IS
  'Takes requirement section 13''s snapshot from public.drivers, derives '
  'computeHoursRange''s problems from it, and discards whatever the client sent '
  '(20260930100000).';

/*
  The blocks and their rides. Two things this guard does that a constraint
  cannot:

    · it resolves a block's driver_name from the plan's own snapshot, so the
      block's label and the snapshot can never disagree — and a block assigned
      to a driver who is not in the plan is refused outright, which makes
      section 7 rule 8 structural rather than checked afterwards. A client
      therefore writes the plan's drivers before its blocks; monthly_plan_save
      does.
    · it keeps a ride's block inside the ride's plan.
*/
CREATE OR REPLACE FUNCTION app_private.monthly_plan_child_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_name text;
  v_plan uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM app_private.monthly_plan_parent_is_open(OLD.plan_id, OLD.company_id);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (NEW.plan_id IS DISTINCT FROM OLD.plan_id
          OR NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
    RAISE EXCEPTION 'Ein Eintrag eines Monatsplans bleibt bei seinem Plan und seinem Unternehmen.'
      USING ERRCODE = 'P0001', HINT = 'monthly_plan_child_key_fixed';
  END IF;

  PERFORM app_private.monthly_plan_parent_is_open(NEW.plan_id, NEW.company_id);

  IF TG_TABLE_NAME = 'monthly_plan_blocks' THEN
    IF NEW.driver_id IS NULL THEN
      -- An unassigned block carries no label and no reason; the table's own
      -- CHECK states the pair, this keeps a stale name from surviving an edit.
      NEW.driver_name := NULL;
    ELSE
      SELECT d.driver_name INTO v_name
        FROM public.monthly_plan_drivers d
       WHERE d.plan_id = NEW.plan_id AND d.driver_id = NEW.driver_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Der Fahrer gehört nicht zu den ausgewählten Fahrern dieses Monatsplans.'
          USING ERRCODE = 'P0001', HINT = 'monthly_plan_driver_not_in_plan';
      END IF;
      NEW.driver_name := v_name;
    END IF;
  ELSE
    SELECT b.plan_id INTO v_plan
      FROM public.monthly_plan_blocks b
     WHERE b.id = NEW.block_id;
    IF NOT FOUND OR v_plan IS DISTINCT FROM NEW.plan_id THEN
      RAISE EXCEPTION 'Die Fahrt gehört zu einem Block eines anderen Monatsplans.'
        USING ERRCODE = 'P0001', HINT = 'monthly_plan_block_other_plan';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION app_private.monthly_plan_child_guard() IS
  'Keeps a monthly plan''s blocks and rides inside their plan and company, '
  'resolves a block''s driver name from the plan''s own snapshot, and refuses a '
  'block assigned to a driver the plan does not list (20260930100000).';

DROP TRIGGER IF EXISTS monthly_plan_guard ON public.monthly_plans;
CREATE TRIGGER monthly_plan_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.monthly_plans
  FOR EACH ROW EXECUTE FUNCTION app_private.monthly_plan_guard();

DROP TRIGGER IF EXISTS monthly_plan_driver_guard ON public.monthly_plan_drivers;
CREATE TRIGGER monthly_plan_driver_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.monthly_plan_drivers
  FOR EACH ROW EXECUTE FUNCTION app_private.monthly_plan_driver_guard();

DROP TRIGGER IF EXISTS monthly_plan_child_guard ON public.monthly_plan_blocks;
CREATE TRIGGER monthly_plan_child_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.monthly_plan_blocks
  FOR EACH ROW EXECUTE FUNCTION app_private.monthly_plan_child_guard();

DROP TRIGGER IF EXISTS monthly_plan_child_guard ON public.monthly_plan_block_trips;
CREATE TRIGGER monthly_plan_child_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.monthly_plan_block_trips
  FOR EACH ROW EXECUTE FUNCTION app_private.monthly_plan_child_guard();

-- ─── 6. the tenant shape ────────────────────────────────────────────────────

ALTER TABLE public.monthly_plans            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_plan_drivers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_plan_blocks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_plan_block_trips ENABLE ROW LEVEL SECURITY;

DO $mig$
DECLARE
  v_tbl    text;
  p        record;
  v_tenant constant text := 'company_id = (SELECT public.get_active_company_id())';
  v_reads  constant text := '(SELECT public.platform_reads_company_data())';
  v_writes constant text := '(SELECT public.platform_writes_company_data())';
  v_gate   constant text := '(SELECT public.current_role_permits(''documents'', true))';
  v_where  text;
BEGIN
  v_where := v_tenant || ' AND ' || v_gate;

  FOREACH v_tbl IN ARRAY ARRAY['monthly_plans', 'monthly_plan_drivers',
                               'monthly_plan_blocks', 'monthly_plan_block_trips'] LOOP
    FOR p IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, v_tbl);
    END LOOP;

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s OR %s)',
      v_tbl || '_select', v_tbl, v_tenant, v_reads);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK ((%s) OR %s)',
      v_tbl || '_insert', v_tbl, v_where, v_writes);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated '
      'USING ((%s) OR %s) WITH CHECK ((%s) OR %s)',
      v_tbl || '_update', v_tbl, v_where, v_writes, v_where, v_writes);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING ((%s) OR %s)',
      v_tbl || '_delete', v_tbl, v_where, v_writes);

    -- 3.4a: a view context writes nothing. 3.4c: a support session's rows are
    -- recorded. Derived from the policies naming get_active_company_id(), which
    -- is the rule tests/rls/platform-contexts.sql section 14 and
    -- tests/rls/support-write-audit.sql section 1 state, and not from who
    -- writes these tables today.
    EXECUTE format('DROP TRIGGER IF EXISTS refuse_read_only_context_write ON public.%I', v_tbl);
    EXECUTE format(
      'CREATE TRIGGER refuse_read_only_context_write '
      'BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app_private.refuse_read_only_context_write()', v_tbl);

    EXECUTE format('DROP TRIGGER IF EXISTS record_support_write ON public.%I', v_tbl);
    EXECUTE format(
      'CREATE TRIGGER record_support_write '
      'AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW '
      'WHEN (current_setting(%L, true) <> %L) '
      'EXECUTE FUNCTION app_private.record_support_write()',
      v_tbl, 'app_private.support_write_context', '');
  END LOOP;
END $mig$;

-- ─── 7. saving a proposal, in one transaction ───────────────────────────────

/*
  Requirement section 9 and acceptance criterion 21: saving and replacing are
  both atomic. PostgREST cannot insert into four tables in one transaction, so
  this is the door the screen uses.

  The payload, and every key of it:

    {
      "year": 2026, "month": 10,
      "import_id": "<uuid or null>",
      "switch_minutes": 30,
      "generation": 0,
      "summary":  { ... },          -- an object, shown on screen 3
      "warnings": [ ... ],          -- validatePlan()'s warnings
      "drivers": [
        { "driver_id": "<uuid>", "selected": true }
      ],
      "blocks": [
        { "block_key": "<PlanBlock.id>",
          "car_id": "<uuid or null>", "car_identifier": "<plate or null>",
          "starts_at": "<timestamptz>", "ends_at": "<timestamptz>",
          "span_minutes": 81, "ride_minutes": 74,
          "driver_id": "<uuid or null>",
          "assignment_reason": "best_fit", "assignment_note_id": null,
          "trips": [
            { "trip_id": "<uuid>", "starts_at": "...", "ends_at": "...",
              "minutes": 81, "time_source": "instants",
              "original_driver_id": null, "original_driver_name": "..." }
          ] }
      ]
    }

  A driver's pay figures, name and owner flag are **not** in the payload: the
  guard reads them from public.drivers. A block's driver_name is not either: the
  guard resolves it from the plan's own snapshot.

  Three things it does that are not bookkeeping:

    · it takes the same advisory lock as monthly_plan_confirm, so a save and a
      confirmation of one month serialise;
    · it discards the company's existing **drafts** for that month, because
      "Neu generieren" replaces the proposal rather than adding a second one.
      The month's confirmed plan is untouched — that conflict belongs to
      monthly_plan_confirm, per screen 1;
    · it counts what it inserted against what the payload held and raises when
      they differ. Acceptance criterion 23 is that no block and no shift is
      silently dropped, and a row lost to a filter or a de-duplicating
      constraint would otherwise be invisible.
*/
CREATE OR REPLACE FUNCTION public.monthly_plan_save(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_caller         uuid := auth.uid();
  v_company        uuid;
  v_year           integer;
  v_month          integer;
  v_switch         integer;
  v_plan_id        uuid;
  v_drivers        jsonb;
  v_blocks         jsonb;
  v_want_drivers   integer;
  v_want_blocks    integer;
  v_want_trips     integer;
  v_got            integer;
  v_discarded      integer := 0;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'monthly_plan_save: unauthenticated'
      USING ERRCODE = '42501', HINT = 'unauthenticated';
  END IF;

  -- The company and account state of 3.3, as every planning RPC asks it.
  v_company := public.get_active_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'monthly_plan_save: caller has no company'
      USING ERRCODE = '42501', HINT = 'no_company';
  END IF;

  -- Slice C: the tables this function writes carry the Dokumente page, so the
  -- function asks the same question. It is SECURITY DEFINER and runs past RLS,
  -- so gating the tables alone would leave the window open.
  IF NOT public.current_role_permits('documents', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung: die Rolle darf die Seite Dokumente nicht bearbeiten.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'monthly_plan_save: p_payload must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  v_year    := (p_payload ->> 'year')::integer;
  v_month   := (p_payload ->> 'month')::integer;
  v_switch  := (p_payload ->> 'switch_minutes')::integer;
  v_drivers := coalesce(p_payload -> 'drivers', '[]'::jsonb);
  v_blocks  := coalesce(p_payload -> 'blocks',  '[]'::jsonb);

  IF v_year IS NULL OR v_month IS NULL OR v_switch IS NULL THEN
    RAISE EXCEPTION 'monthly_plan_save: year, month and switch_minutes are required'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_drivers) <> 'array' OR jsonb_typeof(v_blocks) <> 'array' THEN
    RAISE EXCEPTION 'monthly_plan_save: drivers and blocks must be JSON arrays'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('monthly_plan:%s:%s:%s', v_company, v_year, v_month), 0));

  DELETE FROM public.monthly_plans p
   WHERE p.company_id = v_company AND p.year = v_year AND p.month = v_month
     AND p.status = 'draft';
  GET DIAGNOSTICS v_discarded = ROW_COUNT;

  INSERT INTO public.monthly_plans (company_id, year, month, import_id, switch_minutes,
                                    generation, warnings, summary)
  VALUES (v_company, v_year, v_month,
          nullif(p_payload ->> 'import_id', '')::uuid,
          v_switch,
          coalesce((p_payload ->> 'generation')::integer, 0),
          CASE WHEN jsonb_typeof(p_payload -> 'warnings') = 'array'
               THEN p_payload -> 'warnings' ELSE '[]'::jsonb END,
          CASE WHEN jsonb_typeof(p_payload -> 'summary') = 'object'
               THEN p_payload -> 'summary' ELSE '{}'::jsonb END)
  RETURNING id INTO v_plan_id;

  -- The drivers go in first: the block guard resolves a block's driver against
  -- this list and refuses a driver who is not on it.
  v_want_drivers := jsonb_array_length(v_drivers);
  INSERT INTO public.monthly_plan_drivers (company_id, plan_id, driver_id, driver_name,
                                           selected, is_owner)
  SELECT v_company, v_plan_id, d.driver_id, NULL::text, coalesce(d.selected, true), false
    FROM jsonb_to_recordset(v_drivers) AS d(driver_id uuid, selected boolean);
  GET DIAGNOSTICS v_got = ROW_COUNT;
  IF v_got <> v_want_drivers THEN
    RAISE EXCEPTION 'monthly_plan_save: % of % drivers were stored', v_got, v_want_drivers
      USING ERRCODE = 'P0001', HINT = 'monthly_plan_rows_lost';
  END IF;

  v_want_blocks := jsonb_array_length(v_blocks);
  INSERT INTO public.monthly_plan_blocks (company_id, plan_id, block_key, car_id, car_identifier,
                                          starts_at, ends_at, span_minutes, ride_minutes,
                                          driver_id, driver_name, assignment_reason,
                                          assignment_note_id)
  SELECT v_company, v_plan_id, b.block_key, b.car_id, b.car_identifier,
         b.starts_at, b.ends_at, b.span_minutes, b.ride_minutes,
         b.driver_id, NULL::text, b.assignment_reason, b.assignment_note_id
    FROM jsonb_to_recordset(v_blocks)
         AS b(block_key text, car_id uuid, car_identifier text,
              starts_at timestamptz, ends_at timestamptz,
              span_minutes integer, ride_minutes integer,
              driver_id uuid, assignment_reason text, assignment_note_id uuid);
  GET DIAGNOSTICS v_got = ROW_COUNT;
  IF v_got <> v_want_blocks THEN
    RAISE EXCEPTION 'monthly_plan_save: % of % blocks were stored', v_got, v_want_blocks
      USING ERRCODE = 'P0001', HINT = 'monthly_plan_rows_lost';
  END IF;

  -- The rides, joined to their stored block by the engine's own block key. Two
  -- statements rather than one with a data-modifying CTE, because a CTE's rows
  -- are not visible to a sibling CTE and the block ids are generated here.
  SELECT coalesce(sum(CASE WHEN jsonb_typeof(e.value -> 'trips') = 'array'
                           THEN jsonb_array_length(e.value -> 'trips') ELSE 0 END), 0)
    INTO v_want_trips
    FROM jsonb_array_elements(v_blocks) AS e(value);

  INSERT INTO public.monthly_plan_block_trips (company_id, plan_id, block_id, trip_id,
                                               starts_at, ends_at, minutes, time_source,
                                               original_driver_id, original_driver_name)
  SELECT v_company, v_plan_id, blk.id, t.trip_id, t.starts_at, t.ends_at, t.minutes,
         t.time_source, t.original_driver_id, t.original_driver_name
    FROM jsonb_to_recordset(v_blocks) AS e(block_key text, trips jsonb)
    JOIN public.monthly_plan_blocks blk
      ON blk.plan_id = v_plan_id AND blk.block_key = e.block_key
   CROSS JOIN LATERAL jsonb_to_recordset(
                CASE WHEN jsonb_typeof(e.trips) = 'array' THEN e.trips ELSE '[]'::jsonb END)
         AS t(trip_id uuid, starts_at timestamptz, ends_at timestamptz, minutes integer,
              time_source text, original_driver_id uuid, original_driver_name text);
  GET DIAGNOSTICS v_got = ROW_COUNT;
  IF v_got <> v_want_trips THEN
    RAISE EXCEPTION 'monthly_plan_save: % of % rides were stored', v_got, v_want_trips
      USING ERRCODE = 'P0001', HINT = 'monthly_plan_rows_lost';
  END IF;

  RETURN jsonb_build_object(
    'success',          true,
    'plan_id',          v_plan_id,
    'year',             v_year,
    'month',            v_month,
    'driver_count',     v_want_drivers,
    'block_count',      v_want_blocks,
    'trip_count',       v_want_trips,
    'discarded_drafts', v_discarded);
END;
$fn$;

COMMENT ON FUNCTION public.monthly_plan_save(jsonb) IS
  'Writes one monthly-plan proposal — header, driver snapshot, blocks and rides — '
  'in one transaction, discarding the month''s earlier drafts and refusing a '
  'payload any of whose rows did not reach the tables (20260930100000).';

-- ─── 8. confirming, and replacing, atomically ───────────────────────────────

/*
  Section 9: one active plan per month, the replacement atomic, and the rule in
  the database and not only in the UI. Two walls, and both are needed:

    · `pg_advisory_xact_lock` on the company, year and month, taken **before**
      the function looks for an existing confirmed plan. Without it two
      concurrent confirmations both read "no plan yet" and the second fails on
      the unique index with a constraint error the screen cannot explain.
    · `monthly_plans_one_confirmed_per_month`, the partial unique index, which
      holds even against a statement that never came through this function.

  Between the lock and the write it re-derives the hard rules it can see in the
  stored plan, in the spirit of validate.ts — a second, independent check that
  trusts no flag the assigner wrote. From the blocks and the snapshot alone it
  can re-derive section 7's rules 1, 2, 3 and 8 and the cross-vehicle switch
  gap. Rules 4 and 5 are the notes', whose window arithmetic is the browser's
  (and DST-correct only there), so the screen refuses those first and this
  function does not pretend to.

  Refusals are return values, never exceptions, because the screen has to show
  section 9's two choices and section 14's reasons. A broken argument contract
  and a caller who may not be here raise, as they do everywhere else.
*/
CREATE OR REPLACE FUNCTION public.monthly_plan_confirm(p_plan_id uuid,
                                                       p_replace boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  c_marker  CONSTANT text := 'app_private.monthly_plan_transition';
  v_caller  uuid := auth.uid();
  v_company uuid;
  v_plan    public.monthly_plans;
  v_active  public.monthly_plans;
  v_has_active boolean;
  v_n       integer;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'monthly_plan_confirm: unauthenticated'
      USING ERRCODE = '42501', HINT = 'unauthenticated';
  END IF;

  v_company := public.get_active_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'monthly_plan_confirm: caller has no company'
      USING ERRCODE = '42501', HINT = 'no_company';
  END IF;

  IF NOT public.current_role_permits('documents', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung: die Rolle darf die Seite Dokumente nicht bearbeiten.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'monthly_plan_confirm: p_plan_id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_plan FROM public.monthly_plans p WHERE p.id = p_plan_id;
  IF NOT FOUND OR v_plan.company_id <> v_company THEN
    RETURN jsonb_build_object('success', false, 'reason', 'plan_not_found',
      'error', 'Der Monatsplan wurde nicht gefunden.');
  END IF;

  -- The lock names the month, not the plan: what is being serialised is which
  -- plan of that month is the active one.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('monthly_plan:%s:%s:%s', v_company, v_plan.year, v_plan.month), 0));

  -- Read again under the lock: another transaction may have confirmed or
  -- discarded this very plan between the two reads.
  SELECT * INTO v_plan FROM public.monthly_plans p WHERE p.id = p_plan_id FOR UPDATE;
  IF NOT FOUND OR v_plan.company_id <> v_company THEN
    RETURN jsonb_build_object('success', false, 'reason', 'plan_not_found',
      'error', 'Der Monatsplan wurde nicht gefunden.');
  END IF;
  IF v_plan.status <> 'draft' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_a_draft',
      'error', 'Dieser Monatsplan ist kein Entwurf mehr.');
  END IF;

  -- Acceptance criterion 23: an empty plan is a failed save, not a month with
  -- nothing to do, and confirming it would produce documents with no rows.
  SELECT count(*) INTO v_n FROM public.monthly_plan_blocks b WHERE b.plan_id = p_plan_id;
  IF v_n = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'plan_empty',
      'error', 'Der Monatsplan enthält keine Blöcke.');
  END IF;

  -- Section 7 rule 8. The guard makes this impossible on the way in; it is
  -- re-derived because that is what a second check is for.
  SELECT count(*) INTO v_n
    FROM public.monthly_plan_blocks b
   WHERE b.plan_id = p_plan_id AND b.driver_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.monthly_plan_drivers d
                      WHERE d.plan_id = b.plan_id AND d.driver_id = b.driver_id);
  IF v_n > 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'driver_not_in_plan',
      'error', 'Der Plan weist Blöcke einem Fahrer zu, der nicht zu den ausgewählten Fahrern gehört.');
  END IF;

  -- Section 7 rule 2, on half-open intervals, which is the engine's own
  -- comparison: a zero-length block overlaps nothing, there as here.
  SELECT count(*) INTO v_n
    FROM public.monthly_plan_blocks a
    JOIN public.monthly_plan_blocks b
      ON b.plan_id = a.plan_id AND b.driver_id = a.driver_id AND b.id <> a.id
   WHERE a.plan_id = p_plan_id AND a.driver_id IS NOT NULL
     AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)');
  IF v_n > 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'driver_overlap',
      'error', 'Ein Fahrer hat sich überschneidende Blöcke.');
  END IF;

  -- The derived cross-vehicle check: a driver moving between two vehicles needs
  -- the switch duration. Same-vehicle blocks carry it by construction (section
  -- 3 built them that way), so only the cross-vehicle case is asked.
  SELECT count(*) INTO v_n
    FROM public.monthly_plan_blocks a
    JOIN public.monthly_plan_blocks b
      ON b.plan_id = a.plan_id AND b.driver_id = a.driver_id AND b.id <> a.id
   WHERE a.plan_id = p_plan_id AND a.driver_id IS NOT NULL
     AND coalesce(b.car_id::text, b.car_identifier)
           IS DISTINCT FROM coalesce(a.car_id::text, a.car_identifier)
     AND b.starts_at >= a.ends_at
     AND b.starts_at - a.ends_at < make_interval(mins => v_plan.switch_minutes);
  IF v_n > 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'vehicle_switch_gap',
      'error', 'Ein Fahrzeugwechsel liegt unter der eingestellten Wechseldauer.');
  END IF;

  -- Sections 5 and 14: a regular driver with work and no usable range is a
  -- configuration error the engine refuses with no_usable_range. The owner
  -- needs no range to be assignable (section 8).
  SELECT count(*) INTO v_n
    FROM public.monthly_plan_drivers d
   WHERE d.plan_id = p_plan_id AND NOT d.is_owner
     AND cardinality(d.range_problems) > 0
     AND EXISTS (SELECT 1 FROM public.monthly_plan_blocks b
                  WHERE b.plan_id = d.plan_id AND b.driver_id = d.driver_id);
  IF v_n > 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_usable_range',
      'error', 'Ein Fahrer mit zugewiesenen Blöcken hat keinen gültigen Stundenrahmen (Stundenlohn oder Gehaltsgrenzen fehlen).');
  END IF;

  -- Section 7 rule 3, from the snapshot. LEAST ignores a NULL argument, so a
  -- driver with no explicit ceiling is capped by the salary alone. The bound is
  -- numeric here and a float in the browser; the sum is whole minutes, so the
  -- two can only disagree if an integer lay strictly between them, which it
  -- cannot.
  SELECT count(*) INTO v_n
    FROM (SELECT d.driver_id, d.is_owner, d.planning_max_salary, d.planning_hourly_rate,
                 d.max_monthly_hours, d.range_problems,
                 coalesce(sum(b.span_minutes), 0) AS minutes
            FROM public.monthly_plan_drivers d
            LEFT JOIN public.monthly_plan_blocks b
              ON b.plan_id = d.plan_id AND b.driver_id = d.driver_id
           WHERE d.plan_id = p_plan_id
           GROUP BY d.id, d.driver_id, d.is_owner, d.planning_max_salary,
                    d.planning_hourly_rate, d.max_monthly_hours, d.range_problems) s
   WHERE NOT s.is_owner AND s.minutes > 0 AND cardinality(s.range_problems) = 0
     AND s.minutes > 60 * least(s.planning_max_salary / s.planning_hourly_rate,
                                s.max_monthly_hours);
  IF v_n > 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'exceeds_hours_cap',
      'error', 'Ein Fahrer überschreitet seinen Stundenrahmen.');
  END IF;

  -- The month's active plan, under the lock.
  SELECT * INTO v_active
    FROM public.monthly_plans p
   WHERE p.company_id = v_company AND p.year = v_plan.year AND p.month = v_plan.month
     AND p.status = 'confirmed'
     FOR UPDATE;
  -- Captured, not read twice: FOUND belongs to the last statement, and a reader
  -- two branches down cannot tell which statement that was.
  v_has_active := FOUND;

  IF v_has_active AND NOT coalesce(p_replace, false) THEN
    -- Section 9's two choices: replace, or keep the current plan and do not
    -- make the new one active. The screen shows them; nothing is written.
    RETURN jsonb_build_object('success', false, 'reason', 'plan_exists',
      'existing_plan_id', v_active.id,
      'existing_confirmed_at', v_active.confirmed_at,
      'error', 'Für diesen Monat ist bereits ein Plan aktiv.');
  END IF;

  IF v_has_active THEN
    PERFORM set_config(c_marker,
      'plan:' || v_active.id::text || ':' || pg_current_xact_id()::text, true);
    UPDATE public.monthly_plans p
       SET status = 'superseded', replaced_by_plan_id = p_plan_id
     WHERE p.id = v_active.id;
    PERFORM set_config(c_marker, '', true);
  END IF;

  PERFORM set_config(c_marker,
    'plan:' || p_plan_id::text || ':' || pg_current_xact_id()::text, true);
  UPDATE public.monthly_plans p SET status = 'confirmed' WHERE p.id = p_plan_id;
  PERFORM set_config(c_marker, '', true);

  SELECT * INTO v_plan FROM public.monthly_plans p WHERE p.id = p_plan_id;

  RETURN jsonb_build_object(
    'success',             true,
    'plan_id',             p_plan_id,
    'confirmed_at',        v_plan.confirmed_at,
    'superseded_plan_id',  v_active.id);
END;
$fn$;

COMMENT ON FUNCTION public.monthly_plan_confirm(uuid, boolean) IS
  'Makes one monthly plan the month''s active plan, replacing the current one '
  'atomically when asked. Takes pg_advisory_xact_lock on the company and month '
  'before it looks, re-derives the hard rules it can see in the stored plan, and '
  'refuses by return value so the screen can show section 9''s two choices '
  '(20260930100000).';

-- ─── 9. ownership and privileges ────────────────────────────────────────────

-- The guards and both RPCs are SECURITY DEFINER; CREATE OR REPLACE keeps
-- whatever owner a function had, so the owner is stated.
ALTER FUNCTION app_private.monthly_plan_guard()                     OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.monthly_plan_driver_guard()              OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.monthly_plan_child_guard()               OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.monthly_plan_parent_is_open(uuid, uuid)  OWNER TO CURRENT_USER;
ALTER FUNCTION public.monthly_plan_save(jsonb)                      OWNER TO CURRENT_USER;
ALTER FUNCTION public.monthly_plan_confirm(uuid, boolean)           OWNER TO CURRENT_USER;

-- Fired by triggers, or called by the two RPCs, which run as their owner.
-- Triggers do not check EXECUTE; the REVOKE is the second wall behind the
-- missing USAGE on app_private.
REVOKE ALL ON FUNCTION app_private.monthly_plan_guard()                    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.monthly_plan_driver_guard()             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.monthly_plan_child_guard()             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.monthly_plan_parent_is_open(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Supabase's default privileges grant EXECUTE on every new public function to
-- PUBLIC, anon, authenticated and service_role. Both RPCs read auth.uid(), and
-- the service key carries no subject, so only a signed-in caller gets them.
REVOKE ALL ON FUNCTION public.monthly_plan_save(jsonb)            FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.monthly_plan_confirm(uuid, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.monthly_plan_save(jsonb)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.monthly_plan_confirm(uuid, boolean) TO authenticated;

-- The same default grants every new table to anon, authenticated and
-- service_role. anon never reads these; no edge function does either.
REVOKE ALL ON TABLE public.monthly_plans            FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.monthly_plan_drivers     FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.monthly_plan_blocks      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.monthly_plan_block_trips FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.monthly_plans            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.monthly_plan_drivers     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.monthly_plan_blocks      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.monthly_plan_block_trips TO authenticated;

-- ─── 10. self-check ─────────────────────────────────────────────────────────

DO $mig$
DECLARE
  c_tables CONSTANT text[] := ARRAY['monthly_plans', 'monthly_plan_drivers',
                                    'monthly_plan_blocks', 'monthly_plan_block_trips'];
  c_funcs  CONSTANT text[] := ARRAY['app_private.monthly_plan_guard()',
                                    'app_private.monthly_plan_driver_guard()',
                                    'app_private.monthly_plan_child_guard()',
                                    'app_private.monthly_plan_parent_is_open(uuid,uuid)',
                                    'public.monthly_plan_save(jsonb)',
                                    'public.monthly_plan_confirm(uuid,boolean)'];
  v_tbl    text;
  v_sig    text;
  v_wrong  text;
  v_src    text;
BEGIN
  FOREACH v_tbl IN ARRAY c_tables LOOP
    -- 1. The table exists with row level security on.
    IF to_regclass(format('public.%I', v_tbl)) IS NULL THEN
      RAISE EXCEPTION 'monthly plan self-check 1: public.% is missing', v_tbl;
    END IF;
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', v_tbl)::regclass) THEN
      RAISE EXCEPTION 'monthly plan self-check 1: % has row level security off', v_tbl;
    END IF;

    -- 2. Exactly the four policies of 20260917130000's shape, each asking the
    --    active-company helper, each write asking the Dokumente page of slice
    --    C, and the UPDATE stating one predicate as USING and as WITH CHECK.
    SELECT string_agg(format('%s (%s)', p.policyname, p.cmd), ', ' ORDER BY p.policyname) INTO v_wrong
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = v_tbl
       AND NOT (
             p.policyname = v_tbl || '_' || lower(p.cmd)
         AND p.roles = ARRAY['authenticated']::name[]
         AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'get_active_company_id'
         AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'user_profiles|is_user_super_admin'
         AND (p.cmd = 'SELECT'
              OR (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'current_role_permits')
         AND (p.cmd = 'SELECT'
              OR (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'documents')
         AND (p.cmd <> 'UPDATE' OR p.qual = p.with_check));
    IF v_wrong IS NOT NULL THEN
      RAISE EXCEPTION 'monthly plan self-check 2: % has a policy outside the business shape: %', v_tbl, v_wrong;
    END IF;
    IF (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_tbl) <> 4
       OR (SELECT count(DISTINCT p.cmd) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_tbl) <> 4 THEN
      RAISE EXCEPTION 'monthly plan self-check 2: % must carry exactly one SELECT, INSERT, UPDATE and DELETE policy', v_tbl;
    END IF;

    -- 3. Both context triggers, in 3.4a's and 3.4c's shapes: a statement-level
    --    BEFORE INSERT/UPDATE/DELETE refusal (tgtype 30) and a gated AFTER ROW
    --    audit (tgtype 29). One without the other fails the kit.
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                      AND g.tgname = 'refuse_read_only_context_write'
                      AND NOT g.tgisinternal AND g.tgtype = 30 AND g.tgenabled = 'O'
                      AND g.tgfoid = 'app_private.refuse_read_only_context_write()'::regprocedure) THEN
      RAISE EXCEPTION 'monthly plan self-check 3: % does not carry the view-context refusal trigger', v_tbl;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                      AND g.tgname = 'record_support_write'
                      AND NOT g.tgisinternal AND g.tgtype = 29 AND g.tgenabled = 'O'
                      AND g.tgqual IS NOT NULL
                      AND pg_get_triggerdef(g.oid) ~ 'app_private\.support_write_context'
                      AND g.tgfoid = 'app_private.record_support_write()'::regprocedure) THEN
      RAISE EXCEPTION 'monthly plan self-check 3: % does not carry the gated support-write audit trigger', v_tbl;
    END IF;

    -- 4. Privileges: nothing for anon or the service role, the four DML
    --    commands and nothing else for authenticated.
    IF has_table_privilege('anon', format('public.%I', v_tbl), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('service_role', format('public.%I', v_tbl), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('authenticated', format('public.%I', v_tbl), 'TRUNCATE,REFERENCES,TRIGGER')
       OR NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'SELECT')
       OR NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'INSERT')
       OR NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'UPDATE')
       OR NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'DELETE') THEN
      RAISE EXCEPTION 'monthly plan self-check 4: the table privileges on % are not anon none, authenticated SELECT/INSERT/UPDATE/DELETE, service_role none', v_tbl;
    END IF;

    -- 5. Every table carries its own guard, as an enabled BEFORE INSERT OR
    --    UPDATE OR DELETE row trigger (tgtype 31 = ROW 1 + BEFORE 2 + INSERT 4
    --    + DELETE 8 + UPDATE 16).
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                      AND g.tgname IN ('monthly_plan_guard', 'monthly_plan_driver_guard',
                                       'monthly_plan_child_guard')
                      AND NOT g.tgisinternal AND g.tgtype = 31 AND g.tgenabled = 'O') THEN
      RAISE EXCEPTION 'monthly plan self-check 5: % does not carry its guard as an enabled BEFORE INSERT OR UPDATE OR DELETE row trigger', v_tbl;
    END IF;
  END LOOP;

  -- 6. Section 9, in the database: the partial unique index on the month, and
  --    NOT on the import. Keying on the import is the legacy defect.
  SELECT pg_get_indexdef(i.indexrelid) INTO v_wrong
    FROM pg_index i
   WHERE i.indrelid = 'public.monthly_plans'::regclass
     AND i.indexrelid = to_regclass('public.monthly_plans_one_confirmed_per_month');
  IF v_wrong IS NULL
     OR v_wrong !~ 'CREATE UNIQUE INDEX'
     OR v_wrong !~ 'company_id, year, month'
     OR v_wrong !~ 'WHERE \(status = ''confirmed''::text\)'
     OR v_wrong ~ 'import_id' THEN
    RAISE EXCEPTION 'monthly plan self-check 6: the one-confirmed-plan-per-month index is missing or has changed shape: %', coalesce(v_wrong, 'absent');
  END IF;

  -- 7. Every function: SECURITY DEFINER, a pinned search_path, an owner that
  --    can reach app_private, and no EXECUTE for a role the API authenticates
  --    as (the two public RPCs excepted, which authenticated must be able to
  --    call and anon and the service role must not).
  FOREACH v_sig IN ARRAY c_funcs LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'monthly plan self-check 7: % is missing', v_sig;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) THEN
      RAISE EXCEPTION 'monthly plan self-check 7: % is not SECURITY DEFINER', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                    WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=%') THEN
      RAISE EXCEPTION 'monthly plan self-check 7: % has no pinned search_path', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = to_regprocedure(v_sig)
                      AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private'))) THEN
      RAISE EXCEPTION 'monthly plan self-check 7: the owner of % cannot reach app_private', v_sig;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
       OR has_function_privilege('service_role', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'monthly plan self-check 7: % is executable by anon or the service role', v_sig;
    END IF;
    IF v_sig LIKE 'app\_private.%' AND has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'monthly plan self-check 7: % is executable by authenticated', v_sig;
    END IF;
    IF v_sig LIKE 'public.%' AND NOT has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'monthly plan self-check 7: authenticated cannot call %', v_sig;
    END IF;
  END LOOP;

  -- 8. Both RPCs are VOLATILE (so supabase-js calls them with POST and not in a
  --    read-only transaction), both ask the state helper and the Dokumente page
  --    with the not_authorized hint, and the confirm takes the advisory lock
  --    section 9 asks for. The legacy pipeline takes none, which is the defect
  --    this file's header measures.
  FOREACH v_sig IN ARRAY ARRAY['public.monthly_plan_save(jsonb)',
                               'public.monthly_plan_confirm(uuid,boolean)'] LOOP
    IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) <> 'v' THEN
      RAISE EXCEPTION 'monthly plan self-check 8: % is not VOLATILE', v_sig;
    END IF;
    v_src := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig));
    IF v_src !~ 'get_active_company_id' THEN
      RAISE EXCEPTION 'monthly plan self-check 8: % does not ask get_active_company_id()', v_sig;
    END IF;
    IF v_src !~ 'current_role_permits\(''documents'', true\)' OR v_src !~ 'not_authorized' THEN
      RAISE EXCEPTION 'monthly plan self-check 8: % lost the Dokumente page gate or its not_authorized hint', v_sig;
    END IF;
    IF v_src !~ 'pg_advisory_xact_lock' THEN
      RAISE EXCEPTION 'monthly plan self-check 8: % does not take the advisory lock on the month', v_sig;
    END IF;
  END LOOP;

  -- 9. The rule that decides the whole shape: this feature writes no trip. No
  --    foreign key from any of the four tables points at fahrtenbuch_trips, and
  --    none of the six functions names it.
  SELECT string_agg(format('%s.%s', c.conrelid::regclass, c.conname), ', ') INTO v_wrong
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.conrelid IN (SELECT format('public.%I', u.t)::regclass FROM unnest(c_tables) AS u(t))
     AND c.confrelid = 'public.fahrtenbuch_trips'::regclass;
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'monthly plan self-check 9: a monthly-plan table references fahrtenbuch_trips: %', v_wrong;
  END IF;

  SELECT string_agg(f.sig, ', ') INTO v_wrong
    FROM unnest(c_funcs) AS f(sig)
   WHERE (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure(f.sig)) ~ 'fahrtenbuch_trips';
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'monthly plan self-check 9: a monthly-plan function names fahrtenbuch_trips: %', v_wrong;
  END IF;

  -- 10. Requirement section 5's mandatory rule: target_monthly_hours is ignored
  --     entirely in this feature, so the snapshot has no such column.
  IF EXISTS (SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = 'public.monthly_plan_drivers'::regclass
                AND a.attnum > 0 AND NOT a.attisdropped
                AND a.attname LIKE '%target_monthly_hours%') THEN
    RAISE EXCEPTION 'monthly plan self-check 10: monthly_plan_drivers must not carry target_monthly_hours — requirement section 5 ignores it entirely';
  END IF;

  -- 11. Section 14's two checks, where the plan reads the value, and the
  --     domain of range_problems and time_source.
  FOREACH v_sig IN ARRAY ARRAY['monthly_plan_drivers_hourly_rate_usable',
                               'monthly_plan_drivers_salary_range_ordered',
                               'monthly_plan_drivers_range_problems_known',
                               'monthly_plan_drivers_unselected_is_owner',
                               'monthly_plan_blocks_has_a_vehicle',
                               'monthly_plan_blocks_driver_with_reason',
                               'monthly_plan_block_trips_one_block_per_ride'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = v_sig
                     AND c.connamespace = 'public'::regnamespace) THEN
      RAISE EXCEPTION 'monthly plan self-check 11: the constraint % is missing', v_sig;
    END IF;
  END LOOP;

  -- The rate check must refuse NaN as well as 0 and a negative, which `> 0`
  -- alone does not: numeric orders NaN above every other value.
  SELECT pg_get_constraintdef(c.oid) INTO v_wrong
    FROM pg_constraint c
   WHERE c.conname = 'monthly_plan_drivers_hourly_rate_usable'
     AND c.connamespace = 'public'::regnamespace;
  IF v_wrong !~ 'Infinity' THEN
    RAISE EXCEPTION 'monthly plan self-check 11: the hourly-rate check no longer refuses NaN: %', v_wrong;
  END IF;

  -- A ride whose instants could not be read is rejected by the engine and
  -- never blocked, so 'unusable' must not be storable.
  SELECT pg_get_constraintdef(c.oid) INTO v_wrong
    FROM pg_constraint c
   WHERE c.conrelid = 'public.monthly_plan_block_trips'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ~ 'time_source';
  IF v_wrong IS NULL OR v_wrong ~ 'unusable' OR v_wrong !~ 'instants' THEN
    RAISE EXCEPTION 'monthly plan self-check 11: the time_source check is missing or admits an unusable ride: %', coalesce(v_wrong, 'absent');
  END IF;

  -- 12. The status a plan is born with, and the one index the screen reads by.
  IF (SELECT a.atthasdef FROM pg_attribute a
       WHERE a.attrelid = 'public.monthly_plans'::regclass AND a.attname = 'status') IS NOT TRUE THEN
    RAISE EXCEPTION 'monthly plan self-check 12: monthly_plans.status has no default';
  END IF;

  -- 13. What a support session's audit copies: the snapshot's three pay figures
  --     are redacted by 20260920110000's name rule, the operator's own choices
  --     are not.
  IF NOT ('planning_min_salary'  ~ app_private.support_write_redaction_pattern('monthly_plan_drivers')
          AND 'planning_max_salary'  ~ app_private.support_write_redaction_pattern('monthly_plan_drivers')
          AND 'planning_hourly_rate' ~ app_private.support_write_redaction_pattern('monthly_plan_drivers')
          AND 'selected'             !~ app_private.support_write_redaction_pattern('monthly_plan_drivers')
          AND 'span_minutes'         !~ app_private.support_write_redaction_pattern('monthly_plan_blocks')) THEN
    RAISE EXCEPTION 'monthly plan self-check 13: the support-write redaction rule does not cover the snapshot''s pay figures as expected';
  END IF;

  RAISE NOTICE 'monthly plan self-check: passed';
END $mig$;
