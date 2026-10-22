/*
  # Vehicle day plans: the forward plan, per vehicle and operating day, kept as a record

  The owner's governing constraint (22.10.2026): planning is daily, per vehicle.
  Assigning drivers happens at the end of the month, because a driver may pick
  up a fine, an accident, a roadside incident or take leave in the course of it,
  so his hours cannot be committed in advance.

  Half of that was already the architecture. src/utils/shiftRecommendation/
  plans forward, its unit is a vehicle on an operating day, and it names no
  driver: types.ts says that who drives is the standard monthly plan's job, and
  boundary.test.ts fails the module if it names a table, reads the clock or
  imports outside a four-module allow-list. What it never did is keep anything.
  ShiftRecommendationPage writes nothing and RecommendedShift.id is a display
  key, so "daily planning for vehicles" was a screen and not a record: nothing
  could be referenced later, compared with what happened, or carried into the
  month-end assignment. This file is that record and nothing more. The save path
  lives outside the pure module, in src/utils/vehicleDayPlanPersistence.ts, as
  monthlyPlanPersistence.ts lives outside monthlyPlan/.

  The shape is monthly_plans' and monthly_plan_blocks' (20260930100000): one
  plan per company, year and month with the draft / confirmed / superseded
  lifecycle, a partial unique index that admits one confirmed plan per month, a
  guard that stamps the actor and the time itself and lets only the RPC move the
  status, and shifts that are frozen once their plan is. Where that migration
  was corrected afterwards, this copies the corrected body and not the first
  one: 20261016140000 found, by deleting a company that had done real work, that
  the plan guards refused the company's own cascade, and made them stand aside
  once the company row is gone. The same condition is here from the start, and
  tests/rls/vehicle-day-plans.sql deletes a company that holds a confirmed and a
  superseded plan to prove it.

  ── RULE 1: THE OPERATING DAY'S START HOUR IS STORED, NEVER RE-DERIVED ───────

  This codebase has four cuts of "operating day", and a stored plan that does
  not record which one built it cannot be read back correctly:

    · a configurable 04:00 in the shift recommendation (ProfileSettings in
      types.ts, its default in settings.ts) -- the cut that builds these rows;
    · a hard-coded 04:00 in simulatedRides/time.ts;
    · 04:00 for an Uber day in utils/uberPeriods.ts;
    · 00:00, the calendar date, in monatsplanungPhase1.ts (service_date),
      monatsplanungPhase3.ts (startDayKey) and monthlyPlan/blocks.ts.

  So operating_day_start_hour is a column of the plan: NOT NULL, with no default
  (a default of 4 would be the re-derivation in disguise), fixed for the plan's
  life by the guard. A shift stores its operating date and its wall-clock start
  and end, and the shift guard recomputes both moments from the plan's stored
  hour, slot length and the shift's positions and refuses a shift whose stored
  moments contradict them. A reader therefore takes the hour from the row, and a
  writer that claims one hour while sending moments cut by another is refused
  instead of stored. slot_minutes and algorithm_version are stored for the same
  reason: start_position and end_position are slot indices that mean nothing
  without the slot length, and the version names the rules that made the rows.

  The moments are timestamp WITHOUT time zone, on purpose. They are the
  engine's wall-clock moments (LocalMoment in types.ts), and a wall time the
  clocks skip or repeat on the two DST nights is not an instant that can be
  guessed -- the importer's own rule (wallTimeToInstant: a wall time the clocks
  skip is unreadable, not guessed). minutes stays the engine's wall-clock
  length. Whoever needs an instant converts, and owns the decision.

  ── RULE 2: NO DRIVER COLUMN, ANYWHERE ───────────────────────────────────────

  Not nullable and not "for later": absent. The driver belongs to the month-end
  assignment, which is a different slice and a different table. Self-check 9
  reads the catalogue and fails a release in which a column of either table is
  named like a driver, a ride, an address or a fare. A column is not the only
  place a driver can be put, so the other doors are closed as well:

    · the save RPC refuses a key it does not know, at the top of the payload and
      in a shift, and names it, so a client that sends a driver is told so and
      not silently ignored;
    · every field of a shift must arrive as the JSON type it is stored as. A
      vehicle that is an object would otherwise be flattened into text by
      jsonb_to_recordset and stored as the first hundred characters of a driver
      record;
    · summary is a closed object: fourteen named keys, every value a number, and
      history_months a list of YYYYMM numbers. One function,
      app_private.vehicle_day_plan_summary_problem, is the whole definition. The
      plan guard applies it to every INSERT and to every edit of a draft, so a
      direct write meets it as well, and the save RPC applies it before it
      touches anything;
    · algorithm_version is a token (letters, digits and . _ / + : -), by a CHECK.

  What stays free text is vehicle: the engine's identifier for a car, the plate
  from the import, trimmed, 1 to 100 characters. The database cannot tell a
  plate from any other short string and does not pretend to.

  ── RULE 3: NO RIDE, NO ADDRESS, NO FARE ─────────────────────────────────────

  A shift is a window on a vehicle. The owner declined ride generation towards a
  revenue target on 08.10.2026 (boundary.test.ts records it), and these tables do
  not widen the line the engine keeps: no foreign key to fahrtenbuch_trips or to
  drivers, no function here names either, and expected_revenue_cents is the
  engine's estimate for a window, never a fare. Planning a future month is not
  the Fahrtenbuch boundary of Docs/operating-rules.md (that rule is about
  recorded, past trips); this feature writes no trip and re-times none.

  ── WHAT THE DATABASE RE-DERIVES, AND WHAT IT LEAVES TO THE ENGINE ───────────

  The guard checks what follows from the stored columns alone: the operating
  date lies in the plan's month, the positions fit a day of slot_minutes, the
  minutes are (end - start) slots, the moments follow from the hour. The table
  checks that the weekday class matches the date (a holiday reads as a Sunday)
  and that the key is trimmed. vehicle_day_plan_confirm re-derives the one
  physical rule a stored plan can break by itself: a vehicle is never on the
  road twice at once. It does NOT re-derive the engine's policy (the length
  limit of a shift, the break between two, the evidence thresholds): those are
  the algorithm_version's business, and copying them here would leave two places
  to change and one to forget.

  Three limits are stated rather than hidden. The overlap check takes a vehicle
  as its exact text, as the engine does: 'B-AB 123' and 'b-ab 123', or two
  spellings that differ by a space, are two vehicles. It is made per plan, so
  shifts of two plans across a month boundary are not compared. And shift_index,
  the engine's rank of a shift among the vehicle's shifts of the day by start, is
  held to 0-3 and to the unique key, not to that order.

  generation is the database's. When a plan is saved it is one more than the
  highest generation among the month's plans that have left the draft state, and
  0 when none has. Through vehicle_day_plan_save, which keeps at most one draft
  per month, that numbers the revisions of the month's plan 0, 1, 2 ... in the
  order they were confirmed. It is not a counter anything depends on: a draft
  written directly beside another draft gets the same number, and two plans
  confirmed in turn from such drafts can share one. The shift engine is
  deterministic and has no seed, so it is not monthly_plans' counter of "Neu
  generieren"; a draft saved twice carries the same number twice.

  summary keeps five totals the database computes from the rows the save was
  given (shift_count, vehicle_count, operating_day_count, total_minutes,
  expected_revenue_cents), written over whatever the client sent under those
  names, and nine settings the plan was made with (min_shift_minutes,
  max_shift_minutes, min_break_minutes, max_shifts_per_vehicle_per_day,
  min_revenue_per_hour_cents, block_gap_minutes, min_evidence_days,
  target_revenue_cents when the month was planned towards one, and
  history_months as a list of YYYYMM numbers). Both are conveniences for a list
  screen and never a source. The totals are the save RPC's: a direct write to a
  draft's shifts leaves them as they were.

  ── ACCESS, AND WHY THE PAGE IS documents ────────────────────────────────────

    SELECT   company_id = (SELECT get_active_company_id())
             OR (SELECT platform_reads_company_data())
    INSERT   (company_id = (SELECT get_active_company_id())
              AND (SELECT current_role_permits('documents', true)))
             OR (SELECT platform_writes_company_data())
    UPDATE   the same, as USING and as WITH CHECK
    DELETE   the same

  The screen that writes these tables is /monatsplan?art=schichten. It is one
  route with the standard monthly plan (MonthlyPlanEntryPage), whose own save
  and confirm are gated on the same page (MonthlyPlanPage asks can('documents',
  'edit')), whose four tables took it in 20260930100000, and the route itself is
  gated on the dokumente feature. A role that may confirm a month's plan may
  confirm its vehicles; is_company_admin() would have made the two plan types of
  one route answer differently for the same person. No page_key was created and
  no role_permissions row written: the Rollen screen saves a role by deleting its
  rows and re-inserting one per key in PAGE_DEFINITIONS, so a key that screen
  does not know is dropped the first time anyone edits the role. The seeded
  roles keep their meaning: a viewer holds can_edit on no page and an editor
  holds none on documents, so an administrator or a supervisor saves a plan.

  Both tables carry both context triggers, derived from the policies and not
  from who writes them today: refuse_read_only_context_write (a view context
  writes nothing) and record_support_write (every row a support session writes
  leaves one audit row). tests/rls/platform-contexts.sql section 14 and
  tests/rls/support-write-audit.sql section 1 fail a table that carries one
  without the other. What a support session costs here is one audit row per row
  written. Measured on the local replica of the kit (PostgreSQL 16.6 on one
  developer machine, not the VPS, so a ratio and not a promise): a month of 3100
  shifts (100 vehicles, 31 days, a payload of 1 MB) saves in 0.3 s for a company
  member and in 2.0 to 2.5 s inside a support session, which writes 3101 audit
  rows (3100 support_write.vehicle_day_shifts.insert and one for the plan). The
  largest month the engine plans for 100 vehicles, 12,400 shifts, saves in 1.2 to
  2.4 s for a member; the API roles stop a statement at 8 s, which bounds one save.
  Confirming either takes a few hundredths of a second, right after the save too,
  when the planner's figures do not yet know the plan (section 6 says what the
  join this replaced cost there).

  anon holds nothing. authenticated holds SELECT, INSERT, UPDATE and DELETE and
  nothing else. The service role holds nothing, on the tables and on both RPCs:
  both read auth.uid() and the service key carries no subject.

  ── COMPATIBILITY: this does NOT bump deploy/SCHEMA_EPOCH ────────────────────

  Two new tables, two trigger functions and two helpers, two new RPCs. Nothing
  existing is altered, so the previous release runs unchanged beside them and
  never reads them. Company deletion needs no edit either: app_private.company_deletion_tables()
  reads the catalogue, and both tables cascade from companies.

  tests/rls/vehicle-day-plans.sql is this file's kit. tests/rls/matrix.sql
  carries both tables' lines and, as for the monthly plan, only the EXECUTE grant
  of the two RPCs: they change state, and the matrix runs one probe per principal
  against one fixture. Their authorization is probed per principal in the kit
  file, each call in its own transaction.
*/

-- ─── 1. the plan ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vehicle_day_plans (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  year                     integer     NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month                    integer     NOT NULL CHECK (month BETWEEN 1 AND 12),
  status                   text        NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'confirmed', 'superseded')),
  -- Rule 1. No DEFAULT, on purpose: a writer must state which cut built the
  -- plan, and the database never supplies one.
  operating_day_start_hour integer     NOT NULL,
  -- The slot length start_position and end_position are counted in.
  slot_minutes             integer     NOT NULL,
  -- SHIFT_RECOMMENDATION_ALGORITHM_VERSION at the time: the rules that made the rows.
  -- A token, by algorithm_version_token below: it names the rules, it is not a
  -- place to write in.
  algorithm_version        text        NOT NULL,
  -- Assigned by the guard on insert: one more than the highest generation among
  -- the month's plans that have left the draft state, 0 when none has. Not a
  -- seed (the engine has none); see the header.
  generation               integer     NOT NULL DEFAULT 0 CHECK (generation >= 0),
  -- A closed object of numbers (rule 2): app_private.vehicle_day_plan_summary_problem,
  -- which the guard applies to every insert and to every edit of a draft.
  summary                  jsonb       NOT NULL DEFAULT '{}'::jsonb
                             CHECK (jsonb_typeof(summary) = 'object'),
  confirmed_at             timestamptz NULL,
  confirmed_by             uuid        NULL,
  superseded_at            timestamptz NULL,
  superseded_by            uuid        NULL,
  replaced_by_plan_id      uuid        NULL REFERENCES public.vehicle_day_plans(id) ON DELETE SET NULL,
  created_by               uuid        NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid        NULL,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_day_plans_start_hour_valid
    CHECK (operating_day_start_hour BETWEEN 0 AND 23),
  CONSTRAINT vehicle_day_plans_slot_minutes_supported
    CHECK (slot_minutes IN (15, 30, 60)),
  CONSTRAINT vehicle_day_plans_algorithm_version_token
    CHECK (algorithm_version ~ '^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,99}$'),
  -- Behind the guard, which holds the summary to fourteen numbers and a list of
  -- at most 240 months, far below this: kept so that the size stays bounded if
  -- the guard is ever off.
  CONSTRAINT vehicle_day_plans_summary_small
    CHECK (octet_length(summary::text) <= 16384),
  CONSTRAINT vehicle_day_plans_confirmed_together
    CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL)),
  CONSTRAINT vehicle_day_plans_status_matches_confirmation
    CHECK ((status = 'draft' AND confirmed_at IS NULL)
        OR (status IN ('confirmed', 'superseded') AND confirmed_at IS NOT NULL)),
  CONSTRAINT vehicle_day_plans_superseded_together
    CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)
       AND (superseded_at IS NULL) = (superseded_by IS NULL))
);

COMMENT ON TABLE public.vehicle_day_plans IS
  'A company''s forward plan for one month, per vehicle and operating day: the '
  'proposal and, once confirmed, the month''s one active plan. It names no '
  'driver; who drives is assigned at the end of the month. The operating day''s '
  'start hour, the slot length and the algorithm version that built the shifts '
  'are stored here and never re-derived at read time (20261022140000).';

COMMENT ON COLUMN public.vehicle_day_plans.operating_day_start_hour IS
  'The hour (0-23) at which each operating day of this plan begins, as the cut '
  'that built its shifts. Stored, never looked up: the codebase has four cuts of '
  'operating day. Fixed for the plan''s life. (20261022140000)';

COMMENT ON COLUMN public.vehicle_day_plans.generation IS
  'One more than the highest generation among the month''s plans that have left '
  'the draft state, 0 when none has. Assigned by the guard when the plan is '
  'saved. Not a seed: the shift engine is deterministic. (20261022140000)';

COMMENT ON COLUMN public.vehicle_day_plans.summary IS
  'A closed object of numbers: five totals the save RPC computes and nine '
  'settings the plan was made with. Never a source, and never free text '
  '(app_private.vehicle_day_plan_summary_problem, 20261022140000).';

-- One confirmed plan per company and month, in the database and not only in the
-- screen. Drafts are not unique: a month that has a saved plan may still have a
-- new proposal prepared, and vehicle_day_plan_confirm resolves the conflict.
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_day_plans_one_confirmed_per_month
  ON public.vehicle_day_plans (company_id, year, month)
  WHERE status = 'confirmed';

-- The screen's read: one company's months, newest first.
CREATE INDEX IF NOT EXISTS vehicle_day_plans_company_period_idx
  ON public.vehicle_day_plans (company_id, year DESC, month DESC, status);

-- ─── 2. the shifts ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vehicle_day_shifts (
  id                              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                      uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  plan_id                         uuid        NOT NULL REFERENCES public.vehicle_day_plans(id) ON DELETE CASCADE,
  -- The operating day the shift belongs to. Whether that day starts at 04:00 or
  -- at midnight is the plan's operating_day_start_hour, not this column's.
  operating_date                  date        NOT NULL,
  -- The identifier the engine plans with (the plate from the import, trimmed).
  -- No foreign key to the fleet table: a plan is a record of a decision and must
  -- not change or disappear when the fleet table does. The one free-text field of
  -- a shift: the database cannot tell a plate from any other short string.
  vehicle                         text        NOT NULL,
  -- Which of the vehicle's shifts on that operating day, 0 to 3. The engine
  -- plans at most four a day and numbers them by start; the database holds the
  -- number to its range and to the unique key, not to that order.
  shift_index                     integer     NOT NULL,
  -- Half-open slot range within the operating day, counted in the plan's
  -- slot_minutes from its operating_day_start_hour.
  start_position                  integer     NOT NULL,
  end_position                    integer     NOT NULL,
  -- Wall-clock moments (see the header): timestamp WITHOUT time zone.
  starts_local                    timestamp   NOT NULL,
  ends_local                      timestamp   NOT NULL,
  -- Wall-clock length, (end_position - start_position) * slot_minutes.
  minutes                         integer     NOT NULL,
  -- Monday 0 to Sunday 6; a public holiday is read as a Sunday.
  day_type                        integer     NOT NULL,
  is_holiday                      boolean     NOT NULL,
  -- The engine's ESTIMATE for the window, integer cents. Never a fare.
  expected_revenue_cents          bigint      NOT NULL,
  expected_revenue_per_hour_cents bigint      NOT NULL,
  confidence                      text        NOT NULL,
  -- The fewest distinct historical operating days any rated slot was seen on.
  evidence_days                   integer     NOT NULL,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_day_shifts_one_per_slot
    UNIQUE (plan_id, operating_date, vehicle, shift_index),
  CONSTRAINT vehicle_day_shifts_vehicle_named
    CHECK (vehicle = btrim(vehicle) AND char_length(vehicle) BETWEEN 1 AND 100),
  CONSTRAINT vehicle_day_shifts_index_valid
    CHECK (shift_index BETWEEN 0 AND 3),
  CONSTRAINT vehicle_day_shifts_positions_ordered
    CHECK (start_position >= 0 AND end_position > start_position AND end_position <= 96),
  CONSTRAINT vehicle_day_shifts_moments_ordered
    CHECK (ends_local > starts_local),
  CONSTRAINT vehicle_day_shifts_minutes_positive
    CHECK (minutes > 0),
  CONSTRAINT vehicle_day_shifts_day_type_matches_date
    CHECK ((is_holiday AND day_type = 6)
        OR (NOT is_holiday AND day_type = EXTRACT(ISODOW FROM operating_date)::integer - 1)),
  CONSTRAINT vehicle_day_shifts_revenue_not_negative
    CHECK (expected_revenue_cents >= 0 AND expected_revenue_per_hour_cents >= 0),
  CONSTRAINT vehicle_day_shifts_confidence_known
    CHECK (confidence IN ('high', 'medium', 'low')),
  CONSTRAINT vehicle_day_shifts_evidence_not_negative
    CHECK (evidence_days >= 0)
);

COMMENT ON TABLE public.vehicle_day_shifts IS
  'One window on one vehicle on one operating day of a vehicle day plan. It names '
  'no driver, no ride, no address and no fare; expected_revenue_cents is the '
  'engine''s estimate for the window. Frozen once its plan is confirmed '
  '(20261022140000).';

COMMENT ON COLUMN public.vehicle_day_shifts.expected_revenue_cents IS
  'An estimate learnt from history, integer cents, for the window. Not a fare and '
  'not a record of anything that happened. (20261022140000)';

CREATE INDEX IF NOT EXISTS vehicle_day_shifts_company_idx
  ON public.vehicle_day_shifts (company_id);

-- The overlap check of vehicle_day_plan_confirm reads one plan's shifts vehicle by
-- vehicle, start by start.
CREATE INDEX IF NOT EXISTS vehicle_day_shifts_vehicle_idx
  ON public.vehicle_day_shifts (plan_id, vehicle, starts_local);

-- ─── 3. the guards ──────────────────────────────────────────────────────────

/*
  "The plan exists, belongs to this company and is still a draft", in one place,
  because the shift guard asks it on every write. Returns the plan row so a
  caller that needs more than the refusal can read it.

  A plan that is gone is a cascade -- from the plan itself or from the company --
  and is allowed. So is any write while the company row is gone: that is the
  company's own cascade, the condition 20261016140000 added to the monthly
  plan's copy of this function after a company with a confirmed plan could not
  be deleted. By the time a cascade reaches a child the parent row is deleted,
  so the refusal stays in force for every ordinary write (a shift of a plan of a
  company that exists) and stands aside for exactly the cascade.

  The row is read FOR KEY SHARE, held to the end of the transaction, and that
  conflicts with the FOR UPDATE vehicle_day_plan_confirm takes on it. Read without
  a lock the answer "draft" was stale the moment it was given: a shift written
  while a confirmation was under way saw a plan that was not confirmed yet,
  waited on the foreign key check for the confirmation to commit, and then landed
  in a confirmed plan -- two overlapping shifts the confirmation had just checked
  for, or, for a DELETE, which has no foreign key check to wait on, a confirmed
  plan with no shift at all. With the lock the write and the confirmation take
  turns, in either order, and whichever comes second sees what the first did.
  tests/rls/vehicle-day-plans-concurrency.sql runs the two orders with two
  sessions.
*/
CREATE OR REPLACE FUNCTION app_private.vehicle_day_plan_parent_is_open(p_plan_id uuid, p_company_id uuid)
RETURNS public.vehicle_day_plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_plan public.vehicle_day_plans;
BEGIN
  SELECT * INTO v_plan FROM public.vehicle_day_plans p WHERE p.id = p_plan_id FOR KEY SHARE;

  IF NOT FOUND THEN
    RETURN v_plan;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id) THEN
    RETURN v_plan;
  END IF;

  IF v_plan.company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'Der Fahrzeug-Tagesplan gehört zu einem anderen Unternehmen.'
      USING ERRCODE = 'P0001', HINT = 'vehicle_day_plan_company_mismatch';
  END IF;

  IF v_plan.status <> 'draft' THEN
    RAISE EXCEPTION 'Ein bestätigter Fahrzeug-Tagesplan kann nicht geändert werden.'
      USING ERRCODE = 'P0001', HINT = 'vehicle_day_plan_is_final';
  END IF;

  RETURN v_plan;
END;
$fn$;

COMMENT ON FUNCTION app_private.vehicle_day_plan_parent_is_open(uuid, uuid) IS
  'The one place the shift guard asks whether a vehicle day plan exists, belongs '
  'to the row''s company and is still a draft. A missing plan, or a company that '
  'no longer exists, is a cascade and is allowed (20261022140000).';

/*
  What may stand in a plan's summary, in one place. NULL means it may; any other
  answer names the first thing that may not, in words a caller can show.

  The summary is a closed object (rule 2): fourteen keys and no other, every
  value a number from 0 to 10^15, and history_months a list of at most 240
  YYYYMM numbers (month 01 to 12). The five totals are the save RPC's own and the
  other nine are the settings the plan was made with; both are conveniences for a
  list screen, never a source. A string, a nested object, a boolean or a null is
  refused, so the field cannot carry a driver, a ride, an address or a fare, in a
  key or in a value. Decimals are allowed: the engine's block gap is any
  non-negative number of minutes.

  Pure. The plan guard and the save RPC, both SECURITY DEFINER, are its only
  callers, and no CHECK constraint names it: authenticated holds no USAGE on
  app_private, and a CHECK is evaluated as the writer.
*/
CREATE OR REPLACE FUNCTION app_private.vehicle_day_plan_summary_problem(p_summary jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  c_keys    CONSTANT text[] := ARRAY['shift_count', 'vehicle_count', 'operating_day_count',
                                     'total_minutes', 'expected_revenue_cents',
                                     'min_shift_minutes', 'max_shift_minutes', 'min_break_minutes',
                                     'max_shifts_per_vehicle_per_day', 'min_revenue_per_hour_cents',
                                     'block_gap_minutes', 'min_evidence_days',
                                     'target_revenue_cents', 'history_months'];
  c_ceiling CONSTANT numeric := 1000000000000000;
  v_bad     text;
BEGIN
  IF p_summary IS NULL OR jsonb_typeof(p_summary) <> 'object' THEN
    RETURN 'the summary is not an object';
  END IF;

  SELECT string_agg(k.key, ', ' ORDER BY k.key) INTO v_bad
    FROM jsonb_object_keys(p_summary) AS k(key)
   WHERE k.key <> ALL (c_keys);
  IF v_bad IS NOT NULL THEN
    RETURN 'unknown key(s): ' || left(v_bad, 200);
  END IF;

  SELECT string_agg(e.key, ', ' ORDER BY e.key) INTO v_bad
    FROM jsonb_each(p_summary) AS e(key, value)
   WHERE e.key <> 'history_months'
     AND NOT CASE WHEN jsonb_typeof(e.value) = 'number'
                  THEN (e.value #>> '{}')::numeric BETWEEN 0 AND c_ceiling
                  ELSE false END;
  IF v_bad IS NOT NULL THEN
    RETURN 'not a number from 0 to 10^15: ' || v_bad;
  END IF;

  IF p_summary ? 'history_months' THEN
    IF jsonb_typeof(p_summary -> 'history_months') <> 'array'
       OR jsonb_array_length(p_summary -> 'history_months') > 240 THEN
      RETURN 'history_months is not a list of at most 240 months';
    END IF;
    IF EXISTS (SELECT 1
                 FROM jsonb_array_elements(p_summary -> 'history_months') AS m(value)
                WHERE NOT CASE WHEN jsonb_typeof(m.value) = 'number'
                               THEN (m.value #>> '{}')::numeric = trunc((m.value #>> '{}')::numeric)
                                AND (m.value #>> '{}')::numeric BETWEEN 200001 AND 210012
                                AND mod((m.value #>> '{}')::numeric, 100) BETWEEN 1 AND 12
                               ELSE false END) THEN
      RETURN 'history_months holds something that is not a YYYYMM month';
    END IF;
  END IF;

  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION app_private.vehicle_day_plan_summary_problem(jsonb) IS
  'NULL when a vehicle day plan''s summary is the closed object of numbers rule 2 '
  'allows, else the first thing that is not (20261022140000).';

/*
  The plan's own guard. Four rules:

    · a plan's key and its provenance are fixed: its company, year and month, and
      the operating-day start hour, slot length and algorithm version that built
      its shifts. A stored plan whose hour could be edited would put the shifts
      of one cut under the reading of another;
    · a confirmed plan is frozen, and a superseded one is history. Neither is
      edited or deleted while its company exists;
    · status is not the client's. It moves only inside vehicle_day_plan_confirm,
      which sets a transaction-local marker naming the plan and the transaction.
      The actor and the time are the database's on both transitions;
    · the summary of a draft is the closed object of numbers that
      app_private.vehicle_day_plan_summary_problem describes, on insert and on
      every edit that changes it (rule 2: the one free-form column of the plan
      cannot carry a driver).

  generation is assigned here on insert: one more than the highest generation
  among the month's plans that have left the draft state, so every writer gets
  the same answer.
*/
CREATE OR REPLACE FUNCTION app_private.vehicle_day_plan_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  c_marker  CONSTANT text := 'app_private.vehicle_day_plan_transition';
  v_uid     uuid := auth.uid();
  v_moves   boolean;
  v_problem text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A confirmed plan is the month's record and a superseded one is its
    -- history; neither is deleted while its company exists. A draft is a
    -- proposal and may go.
    IF OLD.status <> 'draft'
       AND EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id) THEN
      RAISE EXCEPTION 'Ein bestätigter oder ersetzter Fahrzeug-Tagesplan kann nicht gelöscht werden.'
        USING ERRCODE = 'P0001', HINT = 'vehicle_day_plan_is_final';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A plan is born a draft. Confirmation is vehicle_day_plan_confirm's act.
    NEW.status              := 'draft';
    NEW.confirmed_at        := NULL;
    NEW.confirmed_by        := NULL;
    NEW.superseded_at       := NULL;
    NEW.superseded_by       := NULL;
    NEW.replaced_by_plan_id := NULL;
    NEW.generation          := coalesce(
      (SELECT max(p.generation) + 1
         FROM public.vehicle_day_plans p
        WHERE p.company_id = NEW.company_id
          AND p.year = NEW.year
          AND p.month = NEW.month
          AND p.status <> 'draft'), 0);
    NEW.created_by          := v_uid;
    NEW.created_at          := now();
    NEW.updated_by          := v_uid;
    NEW.updated_at          := now();

    v_problem := app_private.vehicle_day_plan_summary_problem(NEW.summary);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION 'Die Zusammenfassung des Fahrzeug-Tagesplans enthält etwas, das dort nicht stehen darf: %', v_problem
        USING ERRCODE = 'P0001', HINT = 'vehicle_day_plan_summary_invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.company_id                  IS DISTINCT FROM OLD.company_id
     OR NEW.year                     IS DISTINCT FROM OLD.year
     OR NEW.month                    IS DISTINCT FROM OLD.month
     OR NEW.operating_day_start_hour IS DISTINCT FROM OLD.operating_day_start_hour
     OR NEW.slot_minutes             IS DISTINCT FROM OLD.slot_minutes
     OR NEW.algorithm_version        IS DISTINCT FROM OLD.algorithm_version THEN
    RAISE EXCEPTION 'Ein Fahrzeug-Tagesplan bleibt bei seinem Unternehmen, seinem Monat und der Konfiguration, mit der er erstellt wurde.'
      USING ERRCODE = 'P0001', HINT = 'vehicle_day_plan_key_fixed';
  END IF;

  NEW.created_at := OLD.created_at;
  NEW.created_by := OLD.created_by;
  NEW.generation := OLD.generation;
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
      RAISE EXCEPTION 'Der Status eines Fahrzeug-Tagesplans wird nur über vehicle_day_plan_confirm geändert.'
        USING ERRCODE = 'P0001', HINT = 'vehicle_day_plan_transition_needs_rpc';
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
      RAISE EXCEPTION 'Ein Fahrzeug-Tagesplan kann nicht auf % zurückgesetzt werden.', NEW.status
        USING ERRCODE = 'P0001', HINT = 'vehicle_day_plan_transition_invalid';
    END IF;
    RETURN NEW;
  END IF;

  -- An ordinary edit. Only a draft has anything to edit.
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Ein bestätigter Fahrzeug-Tagesplan kann nicht geändert werden.'
      USING ERRCODE = 'P0001', HINT = 'vehicle_day_plan_is_final';
  END IF;

  IF NEW.summary IS DISTINCT FROM OLD.summary THEN
    v_problem := app_private.vehicle_day_plan_summary_problem(NEW.summary);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION 'Die Zusammenfassung des Fahrzeug-Tagesplans enthält etwas, das dort nicht stehen darf: %', v_problem
        USING ERRCODE = 'P0001', HINT = 'vehicle_day_plan_summary_invalid';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION app_private.vehicle_day_plan_guard() IS
  'Keeps a vehicle day plan with its company, month and provenance, freezes it '
  'once confirmed, lets only vehicle_day_plan_confirm move its status, holds a '
  'draft''s summary to the closed object of numbers, and assigns generation '
  '(20261022140000).';

/*
  The shift guard. Beyond keeping a shift inside its plan and company, it is the
  place rule 1 is enforced: it recomputes the shift's wall-clock start and end
  from the plan's STORED operating_day_start_hour and slot_minutes and the
  shift's positions, and refuses a shift whose moments say otherwise.

      starts_local = operating_date + (hour * 60 + start_position * slot) minutes
      ends_local   = operating_date + (hour * 60 + end_position   * slot) minutes

  On a timestamp without time zone that is plain arithmetic: a shift that begins
  at 22:00 and ends at 02:00 the next calendar day crosses midnight by adding
  minutes, and the two DST nights, where a wall time is skipped or repeated, play
  no part because no instant is involved. Each refusal has its own hint, so a
  caller (and the kit) can tell them apart.
*/
CREATE OR REPLACE FUNCTION app_private.vehicle_day_shift_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_plan     public.vehicle_day_plans;
  v_from_min integer;
  v_to_min   integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM app_private.vehicle_day_plan_parent_is_open(OLD.plan_id, OLD.company_id);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (NEW.plan_id IS DISTINCT FROM OLD.plan_id
          OR NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
    RAISE EXCEPTION 'Eine Schicht bleibt bei ihrem Plan und ihrem Unternehmen.'
      USING ERRCODE = 'P0001', HINT = 'vehicle_day_plan_child_key_fixed';
  END IF;

  v_plan := app_private.vehicle_day_plan_parent_is_open(NEW.plan_id, NEW.company_id);

  -- No such plan: the foreign key refuses the row, with its own message.
  IF v_plan.id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXTRACT(YEAR FROM NEW.operating_date)::integer IS DISTINCT FROM v_plan.year
     OR EXTRACT(MONTH FROM NEW.operating_date)::integer IS DISTINCT FROM v_plan.month THEN
    RAISE EXCEPTION 'Der Betriebstag liegt nicht im Monat des Plans.'
      USING ERRCODE = 'P0001', HINT = 'vehicle_day_shift_outside_month';
  END IF;

  IF NEW.end_position > 1440 / v_plan.slot_minutes THEN
    RAISE EXCEPTION 'Die Schicht reicht über das Ende des Betriebstags hinaus.'
      USING ERRCODE = 'P0001', HINT = 'vehicle_day_shift_positions_invalid';
  END IF;

  IF NEW.minutes IS DISTINCT FROM (NEW.end_position - NEW.start_position) * v_plan.slot_minutes THEN
    RAISE EXCEPTION 'Die Dauer der Schicht passt nicht zu ihren Zeitfenstern.'
      USING ERRCODE = 'P0001', HINT = 'vehicle_day_shift_minutes_mismatch';
  END IF;

  v_from_min := v_plan.operating_day_start_hour * 60 + NEW.start_position * v_plan.slot_minutes;
  v_to_min   := v_plan.operating_day_start_hour * 60 + NEW.end_position   * v_plan.slot_minutes;

  IF NEW.starts_local IS DISTINCT FROM NEW.operating_date::timestamp + make_interval(mins => v_from_min)
     OR NEW.ends_local IS DISTINCT FROM NEW.operating_date::timestamp + make_interval(mins => v_to_min) THEN
    RAISE EXCEPTION 'Beginn und Ende der Schicht passen nicht zum Betriebstag und seiner Startstunde.'
      USING ERRCODE = 'P0001', HINT = 'vehicle_day_shift_moments_mismatch';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION app_private.vehicle_day_shift_guard() IS
  'Keeps a shift inside its plan and company, refuses a write to a plan that is no '
  'longer a draft, and recomputes the shift''s wall-clock moments from the '
  'plan''s stored operating-day start hour and slot length (20261022140000).';

DROP TRIGGER IF EXISTS vehicle_day_plan_guard ON public.vehicle_day_plans;
CREATE TRIGGER vehicle_day_plan_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.vehicle_day_plans
  FOR EACH ROW EXECUTE FUNCTION app_private.vehicle_day_plan_guard();

DROP TRIGGER IF EXISTS vehicle_day_shift_guard ON public.vehicle_day_shifts;
CREATE TRIGGER vehicle_day_shift_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.vehicle_day_shifts
  FOR EACH ROW EXECUTE FUNCTION app_private.vehicle_day_shift_guard();

-- ─── 4. the tenant shape ────────────────────────────────────────────────────

ALTER TABLE public.vehicle_day_plans  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_day_shifts ENABLE ROW LEVEL SECURITY;

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

  FOREACH v_tbl IN ARRAY ARRAY['vehicle_day_plans', 'vehicle_day_shifts'] LOOP
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

-- ─── 5. saving a proposal, in one transaction ───────────────────────────────

/*
  PostgREST cannot insert into two tables in one transaction, and the month's
  earlier draft has to go in the same transaction as the new one arrives, so
  this is the door the screen uses.

  The payload, and every key of it:

    {
      "year": 2026, "month": 11,
      "operating_day_start_hour": 4,
      "slot_minutes": 15,
      "algorithm_version": "shift-recommendation/1.0.0",
      "summary": { ... },              -- optional, a closed object of numbers (see below)
      "shifts": [
        { "operating_date": "2026-11-03", "vehicle": "B-AB 123", "shift_index": 0,
          "start_position": 24, "end_position": 36,
          "starts_local": "2026-11-03T10:00", "ends_local": "2026-11-03T13:00",
          "minutes": 180, "day_type": 1, "is_holiday": false,
          "expected_revenue_cents": 12345, "expected_revenue_per_hour_cents": 4115,
          "confidence": "high", "evidence_days": 9 }
      ]
    }

  Both lists of keys are CLOSED. A key outside them is refused with 22023 and
  named, because rule 2 is not only about columns: a client that sends a driver,
  a ride or an address must be told it was not stored, not left believing it was.
  Every field of a shift must also arrive as the JSON type it is stored as
  (c_shift_shape names them), and algorithm_version must be a string: the coercion
  of jsonb_to_recordset would otherwise turn an object into the text of an object
  and store it as a vehicle. summary is closed too, to the fourteen numeric keys
  app_private.vehicle_day_plan_summary_problem allows.

  Four things it does that are not bookkeeping:

    · it takes its own advisory lock on the company, year and month, which is not
      the monthly plan's, so a save and a confirmation of one month serialise
      with each other and with nothing else;
    · it discards the company's existing DRAFTS for that month, because a new
      proposal replaces the old one rather than adding a second. The month's
      confirmed plan is untouched: that conflict is vehicle_day_plan_confirm's;
    · it counts what it stored against what the payload held and raises when they
      differ, so no shift is silently dropped;
    · it computes the five totals of summary from the shifts it was given and
      writes them over whatever the client sent under those names.

  Every other refusal is a table check or a guard, and each has its own state or
  hint: 23514 names the check, P0001 the guard's hint.
*/
CREATE OR REPLACE FUNCTION public.vehicle_day_plan_save(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  c_top_keys   CONSTANT text[] := ARRAY['year', 'month', 'operating_day_start_hour',
                                        'slot_minutes', 'algorithm_version', 'summary', 'shifts'];
  -- Every key a shift may carry, with the JSON type it must arrive as.
  c_shift_shape CONSTANT jsonb := '{"operating_date": "string", "vehicle": "string",
      "shift_index": "number", "start_position": "number", "end_position": "number",
      "starts_local": "string", "ends_local": "string", "minutes": "number",
      "day_type": "number", "is_holiday": "boolean", "expected_revenue_cents": "number",
      "expected_revenue_per_hour_cents": "number", "confidence": "string",
      "evidence_days": "number"}';
  v_caller     uuid := auth.uid();
  v_company    uuid;
  v_unknown    text;
  v_problem    text;
  v_year       integer;
  v_month      integer;
  v_hour       integer;
  v_slot       integer;
  v_summary    jsonb;
  v_shifts     jsonb;
  v_want       integer;
  v_got        integer;
  v_vehicles   integer;
  v_days       integer;
  v_minutes    bigint;
  v_revenue    bigint;
  v_plan_id    uuid;
  v_generation integer;
  v_discarded  integer := 0;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'vehicle_day_plan_save: unauthenticated'
      USING ERRCODE = '42501', HINT = 'unauthenticated';
  END IF;

  -- The company and account state of 3.3, as every planning RPC asks it.
  v_company := public.get_active_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'vehicle_day_plan_save: caller has no company'
      USING ERRCODE = '42501', HINT = 'no_company';
  END IF;

  -- The tables this function writes carry the Dokumente page, so the function
  -- asks the same question. It is SECURITY DEFINER and runs past RLS, so gating
  -- the tables alone would leave the window open.
  IF NOT public.current_role_permits('documents', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung: die Rolle darf die Seite Dokumente nicht bearbeiten.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'vehicle_day_plan_save: p_payload must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  SELECT string_agg(k.key, ', ' ORDER BY k.key) INTO v_unknown
    FROM jsonb_object_keys(p_payload) AS k(key)
   WHERE k.key <> ALL (c_top_keys);
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle_day_plan_save: unknown payload key(s): %', v_unknown
      USING ERRCODE = '22023';
  END IF;

  IF coalesce(p_payload ->> 'year', '') !~ '^[0-9]{4}$'
     OR coalesce(p_payload ->> 'month', '') !~ '^[0-9]{1,2}$'
     OR coalesce(p_payload ->> 'operating_day_start_hour', '') !~ '^[0-9]{1,2}$'
     OR coalesce(p_payload ->> 'slot_minutes', '') !~ '^[0-9]{2}$'
     OR coalesce(p_payload ->> 'algorithm_version', '') = '' THEN
    RAISE EXCEPTION 'vehicle_day_plan_save: year, month, operating_day_start_hour, slot_minutes and algorithm_version are required'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_payload -> 'algorithm_version') <> 'string' THEN
    RAISE EXCEPTION 'vehicle_day_plan_save: algorithm_version must be a JSON string'
      USING ERRCODE = '22023';
  END IF;

  v_year  := (p_payload ->> 'year')::integer;
  v_month := (p_payload ->> 'month')::integer;
  v_hour  := (p_payload ->> 'operating_day_start_hour')::integer;
  v_slot  := (p_payload ->> 'slot_minutes')::integer;

  IF p_payload ? 'summary' AND jsonb_typeof(p_payload -> 'summary') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'vehicle_day_plan_save: summary must be a JSON object'
      USING ERRCODE = '22023';
  END IF;
  v_summary := coalesce(p_payload -> 'summary', '{}'::jsonb);
  v_problem := app_private.vehicle_day_plan_summary_problem(v_summary);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle_day_plan_save: summary: %', v_problem
      USING ERRCODE = '22023';
  END IF;

  v_shifts := coalesce(p_payload -> 'shifts', '[]'::jsonb);
  IF jsonb_typeof(v_shifts) <> 'array' THEN
    RAISE EXCEPTION 'vehicle_day_plan_save: shifts must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  SELECT string_agg(DISTINCT k.key, ', ' ORDER BY k.key) INTO v_unknown
    FROM jsonb_array_elements(v_shifts) AS e(value)
   CROSS JOIN LATERAL jsonb_object_keys(e.value) AS k(key)
   WHERE NOT (c_shift_shape ? k.key);
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle_day_plan_save: unknown shift key(s): %', v_unknown
      USING ERRCODE = '22023';
  END IF;

  -- A field of the wrong JSON type is refused and named, not coerced.
  SELECT string_agg(w.bad, ', ' ORDER BY w.bad) INTO v_unknown
    FROM (SELECT DISTINCT format('%s (expected %s, got %s)', kv.key, c_shift_shape ->> kv.key, jsonb_typeof(kv.value)) AS bad
            FROM jsonb_array_elements(v_shifts) AS e(value)
           CROSS JOIN LATERAL jsonb_each(e.value) AS kv(key, value)
           WHERE jsonb_typeof(kv.value) <> c_shift_shape ->> kv.key) w;
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle_day_plan_save: shift field(s) of the wrong JSON type: %', v_unknown
      USING ERRCODE = '22023';
  END IF;

  v_want := jsonb_array_length(v_shifts);
  SELECT count(DISTINCT s.vehicle), count(DISTINCT s.operating_date),
         coalesce(sum(s.minutes), 0), coalesce(sum(s.expected_revenue_cents), 0)
    INTO v_vehicles, v_days, v_minutes, v_revenue
    FROM jsonb_to_recordset(v_shifts)
         AS s(vehicle text, operating_date date, minutes integer, expected_revenue_cents bigint);

  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('vehicle_day_plan:%s:%s:%s', v_company, v_year, v_month), 0));

  DELETE FROM public.vehicle_day_plans p
   WHERE p.company_id = v_company AND p.year = v_year AND p.month = v_month
     AND p.status = 'draft';
  GET DIAGNOSTICS v_discarded = ROW_COUNT;

  -- The totals are written clamped at zero. A negative total can only come from a
  -- shift the table refuses a moment later (minutes_positive, revenue_not_negative),
  -- and that is the refusal a caller should read: without the clamp the summary
  -- rule would speak first and name a total instead of the shift's own field. The
  -- clamp keeps nothing wrong: the whole save is rolled back in that case.
  INSERT INTO public.vehicle_day_plans (company_id, year, month, operating_day_start_hour,
                                        slot_minutes, algorithm_version, summary)
  VALUES (v_company, v_year, v_month, v_hour, v_slot,
          p_payload ->> 'algorithm_version',
          v_summary || jsonb_build_object(
            'shift_count',            v_want,
            'vehicle_count',          v_vehicles,
            'operating_day_count',    v_days,
            'total_minutes',          greatest(v_minutes, 0),
            'expected_revenue_cents', greatest(v_revenue, 0)))
  RETURNING id, generation INTO v_plan_id, v_generation;

  INSERT INTO public.vehicle_day_shifts (company_id, plan_id, operating_date, vehicle, shift_index,
                                         start_position, end_position, starts_local, ends_local,
                                         minutes, day_type, is_holiday, expected_revenue_cents,
                                         expected_revenue_per_hour_cents, confidence, evidence_days)
  SELECT v_company, v_plan_id, s.operating_date, s.vehicle, s.shift_index,
         s.start_position, s.end_position, s.starts_local, s.ends_local,
         s.minutes, s.day_type, s.is_holiday, s.expected_revenue_cents,
         s.expected_revenue_per_hour_cents, s.confidence, s.evidence_days
    FROM jsonb_to_recordset(v_shifts)
         AS s(operating_date date, vehicle text, shift_index integer,
              start_position integer, end_position integer,
              starts_local timestamp, ends_local timestamp,
              minutes integer, day_type integer, is_holiday boolean,
              expected_revenue_cents bigint, expected_revenue_per_hour_cents bigint,
              confidence text, evidence_days integer);
  GET DIAGNOSTICS v_got = ROW_COUNT;
  IF v_got <> v_want THEN
    RAISE EXCEPTION 'vehicle_day_plan_save: % of % shifts were stored', v_got, v_want
      USING ERRCODE = 'P0001', HINT = 'vehicle_day_plan_rows_lost';
  END IF;

  RETURN jsonb_build_object(
    'success',          true,
    'plan_id',          v_plan_id,
    'year',             v_year,
    'month',            v_month,
    'generation',       v_generation,
    'shift_count',      v_want,
    'vehicle_count',    v_vehicles,
    'discarded_drafts', v_discarded);
END;
$fn$;

COMMENT ON FUNCTION public.vehicle_day_plan_save(jsonb) IS
  'Writes one vehicle day plan proposal -- header and shifts -- in one transaction, '
  'discarding the month''s earlier drafts, refusing a payload with a key it does '
  'not know and any payload whose shifts did not all reach the table '
  '(20261022140000).';

-- ─── 6. confirming, and replacing, atomically ───────────────────────────────

/*
  One active plan per month, the replacement atomic, and the rule in the
  database and not only in the screen. Two walls, and both are needed:

    · pg_advisory_xact_lock on the company, year and month, taken BEFORE the
      function looks for an existing confirmed plan. Without it two concurrent
      confirmations both read "no plan yet" and the second fails on the unique
      index with a constraint error the screen cannot explain.
    · vehicle_day_plans_one_confirmed_per_month, the partial unique index, which
      holds even against a statement that never came through this function.

  Between the lock and the write it re-derives the one physical rule a stored
  plan can break by itself: a vehicle is never on the road twice at once. Two
  shifts of one vehicle that overlap in wall-clock time, on one operating day or
  across the boundary of two, are refused. Whether a break between them is long
  enough is a setting of the engine (and of its algorithm_version), not a rule
  of the schema.

  The check is one pass over the plan's shifts, vehicle by vehicle in start
  order, and not a join of the table with itself. The join was correct and
  unsafe: right after a bulk save the planner's figures do not know the new plan
  yet, it expects one row, takes a nested loop with the plan as the only index
  condition and compares every shift with every other. Against the API roles'
  statement timeout of 8 s that took 2 to 3.5 s for 3100 shifts on a quiet
  machine and 5 to 11 s on a busy one, and never finished for 12,400. The pass is
  the same answer without a join to choose badly.

  Refusals are return values, never exceptions, because the screen has to offer
  the choice between replacing the active plan and keeping it. A broken argument
  contract and a caller who may not be here raise, as they do everywhere else.
*/
CREATE OR REPLACE FUNCTION public.vehicle_day_plan_confirm(p_plan_id uuid,
                                                           p_replace boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  c_marker     CONSTANT text := 'app_private.vehicle_day_plan_transition';
  v_caller     uuid := auth.uid();
  v_company    uuid;
  v_plan       public.vehicle_day_plans;
  v_active     public.vehicle_day_plans;
  v_has_active boolean;
  v_n          integer;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'vehicle_day_plan_confirm: unauthenticated'
      USING ERRCODE = '42501', HINT = 'unauthenticated';
  END IF;

  v_company := public.get_active_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'vehicle_day_plan_confirm: caller has no company'
      USING ERRCODE = '42501', HINT = 'no_company';
  END IF;

  IF NOT public.current_role_permits('documents', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung: die Rolle darf die Seite Dokumente nicht bearbeiten.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'vehicle_day_plan_confirm: p_plan_id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_plan FROM public.vehicle_day_plans p WHERE p.id = p_plan_id;
  IF NOT FOUND OR v_plan.company_id <> v_company THEN
    RETURN jsonb_build_object('success', false, 'reason', 'plan_not_found',
      'error', 'Der Fahrzeug-Tagesplan wurde nicht gefunden.');
  END IF;

  -- The lock names the month, not the plan: what is being serialised is which
  -- plan of that month is the active one.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('vehicle_day_plan:%s:%s:%s', v_company, v_plan.year, v_plan.month), 0));

  -- Read again under the lock: another transaction may have confirmed or
  -- discarded this very plan between the two reads.
  SELECT * INTO v_plan FROM public.vehicle_day_plans p WHERE p.id = p_plan_id FOR UPDATE;
  IF NOT FOUND OR v_plan.company_id <> v_company THEN
    RETURN jsonb_build_object('success', false, 'reason', 'plan_not_found',
      'error', 'Der Fahrzeug-Tagesplan wurde nicht gefunden.');
  END IF;
  IF v_plan.status <> 'draft' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_a_draft',
      'error', 'Dieser Fahrzeug-Tagesplan ist kein Entwurf mehr.');
  END IF;

  -- An empty plan is a failed save, not a month with nothing to do, and
  -- confirming it would make an empty plan the month's record.
  SELECT count(*) INTO v_n FROM public.vehicle_day_shifts s WHERE s.plan_id = p_plan_id;
  IF v_n = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'plan_empty',
      'error', 'Der Fahrzeug-Tagesplan enthält keine Schichten.');
  END IF;

  -- A vehicle is never on the road twice at once. Half-open intervals, the
  -- engine's own comparison: a shift that ends when the next begins overlaps
  -- nothing. In start order a shift overlaps an earlier one of its vehicle exactly
  -- when the latest end among the shifts before it lies after its own start.
  SELECT count(*) INTO v_n
    FROM (SELECT s.starts_local,
                 max(s.ends_local) OVER (PARTITION BY s.vehicle
                                         ORDER BY s.starts_local, s.ends_local, s.id
                                         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS earlier_end
            FROM public.vehicle_day_shifts s
           WHERE s.plan_id = p_plan_id) w
   WHERE w.earlier_end > w.starts_local;
  IF v_n > 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'vehicle_overlap',
      'error', 'Ein Fahrzeug ist in zwei Schichten gleichzeitig eingeplant.');
  END IF;

  -- The month's active plan, under the lock.
  SELECT * INTO v_active
    FROM public.vehicle_day_plans p
   WHERE p.company_id = v_company AND p.year = v_plan.year AND p.month = v_plan.month
     AND p.status = 'confirmed'
     FOR UPDATE;
  -- Captured, not read twice: FOUND belongs to the last statement, and a reader
  -- two branches down cannot tell which statement that was.
  v_has_active := FOUND;

  IF v_has_active AND NOT coalesce(p_replace, false) THEN
    -- The two choices: replace, or keep the current plan and do not make the new
    -- one active. The screen shows them; nothing is written.
    RETURN jsonb_build_object('success', false, 'reason', 'plan_exists',
      'existing_plan_id', v_active.id,
      'existing_confirmed_at', v_active.confirmed_at,
      'error', 'Für diesen Monat ist bereits ein Fahrzeug-Tagesplan aktiv.');
  END IF;

  IF v_has_active THEN
    PERFORM set_config(c_marker,
      'plan:' || v_active.id::text || ':' || pg_current_xact_id()::text, true);
    UPDATE public.vehicle_day_plans p
       SET status = 'superseded', replaced_by_plan_id = p_plan_id
     WHERE p.id = v_active.id;
    PERFORM set_config(c_marker, '', true);
  END IF;

  PERFORM set_config(c_marker,
    'plan:' || p_plan_id::text || ':' || pg_current_xact_id()::text, true);
  UPDATE public.vehicle_day_plans p SET status = 'confirmed' WHERE p.id = p_plan_id;
  PERFORM set_config(c_marker, '', true);

  SELECT * INTO v_plan FROM public.vehicle_day_plans p WHERE p.id = p_plan_id;

  RETURN jsonb_build_object(
    'success',            true,
    'plan_id',            p_plan_id,
    'confirmed_at',       v_plan.confirmed_at,
    'superseded_plan_id', v_active.id);
END;
$fn$;

COMMENT ON FUNCTION public.vehicle_day_plan_confirm(uuid, boolean) IS
  'Makes one vehicle day plan the month''s active plan, replacing the current one '
  'atomically when asked. Takes pg_advisory_xact_lock on the company and month '
  'before it looks, refuses a vehicle in two shifts at once, and refuses by '
  'return value so the screen can offer the replacement (20261022140000).';

-- ─── 7. ownership and privileges ────────────────────────────────────────────

-- The guards, the helpers and both RPCs are SECURITY DEFINER; CREATE OR REPLACE
-- keeps whatever owner a function had, so the owner is stated.
ALTER FUNCTION app_private.vehicle_day_plan_guard()                    OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.vehicle_day_shift_guard()                   OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.vehicle_day_plan_parent_is_open(uuid, uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.vehicle_day_plan_summary_problem(jsonb)     OWNER TO CURRENT_USER;
ALTER FUNCTION public.vehicle_day_plan_save(jsonb)                     OWNER TO CURRENT_USER;
ALTER FUNCTION public.vehicle_day_plan_confirm(uuid, boolean)          OWNER TO CURRENT_USER;

-- Fired by triggers, or called by the two RPCs, which run as their owner.
-- Triggers do not check EXECUTE; the REVOKE is the second wall behind the
-- missing USAGE on app_private.
REVOKE ALL ON FUNCTION app_private.vehicle_day_plan_guard()                    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.vehicle_day_shift_guard()                   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.vehicle_day_plan_parent_is_open(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.vehicle_day_plan_summary_problem(jsonb)     FROM PUBLIC, anon, authenticated, service_role;

-- Supabase's default privileges grant EXECUTE on every new public function to
-- PUBLIC, anon, authenticated and service_role. Both RPCs read auth.uid(), and
-- the service key carries no subject, so only a signed-in caller gets them.
REVOKE ALL ON FUNCTION public.vehicle_day_plan_save(jsonb)             FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.vehicle_day_plan_confirm(uuid, boolean)  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.vehicle_day_plan_save(jsonb)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.vehicle_day_plan_confirm(uuid, boolean) TO authenticated;

-- The same default grants every new table to anon, authenticated and
-- service_role. anon never reads these; no edge function does either.
REVOKE ALL ON TABLE public.vehicle_day_plans  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.vehicle_day_shifts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vehicle_day_plans  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vehicle_day_shifts TO authenticated;

-- ─── 8. self-check ──────────────────────────────────────────────────────────
--
-- What a release can be told without a second session and without data: the
-- catalogue, the bodies of the functions with their comments removed
-- (app_private.function_code, which raises for a signature that does not
-- resolve, so a renamed function cannot make a `!~` check below pass on NULL),
-- and the one pure helper, run on literals. The behaviour itself -- every
-- refusal, the lifecycle, the races -- is tests/rls/vehicle-day-plans.sql and
-- tests/rls/vehicle-day-plans-concurrency.sql.

DO $mig$
DECLARE
  c_tables CONSTANT text[] := ARRAY['vehicle_day_plans', 'vehicle_day_shifts'];
  c_funcs  CONSTANT text[] := ARRAY['app_private.vehicle_day_plan_guard()',
                                    'app_private.vehicle_day_shift_guard()',
                                    'app_private.vehicle_day_plan_parent_is_open(uuid,uuid)',
                                    'app_private.vehicle_day_plan_summary_problem(jsonb)',
                                    'public.vehicle_day_plan_save(jsonb)',
                                    'public.vehicle_day_plan_confirm(uuid,boolean)'];
  v_tbl    text;
  v_sig    text;
  v_wrong  text;
  v_src    text;
  v_guard  text;
BEGIN
  FOREACH v_tbl IN ARRAY c_tables LOOP
    -- 1. The table exists with row level security on.
    IF to_regclass(format('public.%I', v_tbl)) IS NULL THEN
      RAISE EXCEPTION 'vehicle day plans self-check 1: public.% is missing', v_tbl;
    END IF;
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', v_tbl)::regclass) THEN
      RAISE EXCEPTION 'vehicle day plans self-check 1: % has row level security off', v_tbl;
    END IF;

    -- 2. Exactly the four policies of 20260917130000's shape, each asking the
    --    active-company helper, each write asking the Dokumente page of slice
    --    C, SELECT asking no role at all, and the UPDATE stating one predicate
    --    as USING and as WITH CHECK (which is what refuses a move to another
    --    company).
    SELECT string_agg(format('%s (%s)', p.policyname, p.cmd), ', ' ORDER BY p.policyname) INTO v_wrong
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = v_tbl
       AND NOT (
             p.policyname = v_tbl || '_' || lower(p.cmd)
         AND p.roles = ARRAY['authenticated']::name[]
         AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'get_active_company_id'
         AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'user_profiles|is_user_super_admin'
         AND (p.cmd = 'SELECT'
              OR (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'current_role_permits\(''documents''')
         AND (p.cmd <> 'SELECT'
              OR coalesce(p.qual, '') !~ 'current_role_permits')
         AND (p.cmd <> 'UPDATE' OR p.qual = p.with_check));
    IF v_wrong IS NOT NULL THEN
      RAISE EXCEPTION 'vehicle day plans self-check 2: % has a policy outside the business shape: %', v_tbl, v_wrong;
    END IF;
    IF (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_tbl) <> 4
       OR (SELECT count(DISTINCT p.cmd) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_tbl) <> 4 THEN
      RAISE EXCEPTION 'vehicle day plans self-check 2: % must carry exactly one SELECT, INSERT, UPDATE and DELETE policy', v_tbl;
    END IF;

    -- 3. Both context triggers, in 3.4a's and 3.4c's shapes: a statement-level
    --    BEFORE INSERT/UPDATE/DELETE refusal (tgtype 30) and a gated AFTER ROW
    --    audit (tgtype 29). One without the other fails the kit.
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                      AND g.tgname = 'refuse_read_only_context_write'
                      AND NOT g.tgisinternal AND g.tgtype = 30 AND g.tgenabled = 'O'
                      AND g.tgfoid = 'app_private.refuse_read_only_context_write()'::regprocedure) THEN
      RAISE EXCEPTION 'vehicle day plans self-check 3: % does not carry the view-context refusal trigger', v_tbl;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                      AND g.tgname = 'record_support_write'
                      AND NOT g.tgisinternal AND g.tgtype = 29 AND g.tgenabled = 'O'
                      AND g.tgqual IS NOT NULL
                      AND pg_get_triggerdef(g.oid) ~ 'app_private\.support_write_context'
                      AND g.tgfoid = 'app_private.record_support_write()'::regprocedure) THEN
      RAISE EXCEPTION 'vehicle day plans self-check 3: % does not carry the gated support-write audit trigger', v_tbl;
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
      RAISE EXCEPTION 'vehicle day plans self-check 4: the table privileges on % are not anon none, authenticated SELECT/INSERT/UPDATE/DELETE, service_role none', v_tbl;
    END IF;

    -- 5. Every table carries its OWN guard, not the other table's, as an enabled
    --    BEFORE INSERT OR UPDATE OR DELETE row trigger (tgtype 31 = ROW 1 +
    --    BEFORE 2 + INSERT 4 + DELETE 8 + UPDATE 16), wired to that function.
    v_guard := CASE v_tbl WHEN 'vehicle_day_plans' THEN 'vehicle_day_plan_guard'
                                                   ELSE 'vehicle_day_shift_guard' END;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                      AND g.tgname = v_guard
                      AND NOT g.tgisinternal AND g.tgtype = 31 AND g.tgenabled = 'O'
                      AND g.tgfoid = format('app_private.%I()', v_guard)::regprocedure) THEN
      RAISE EXCEPTION 'vehicle day plans self-check 5: % does not carry %() as an enabled BEFORE INSERT OR UPDATE OR DELETE row trigger', v_tbl, v_guard;
    END IF;
  END LOOP;

  -- 6. One confirmed plan per company and month, in the database: the partial
  --    unique index on the month, and on nothing else.
  SELECT pg_get_indexdef(i.indexrelid) INTO v_wrong
    FROM pg_index i
   WHERE i.indrelid = 'public.vehicle_day_plans'::regclass
     AND i.indexrelid = to_regclass('public.vehicle_day_plans_one_confirmed_per_month');
  IF v_wrong IS NULL
     OR v_wrong !~ 'CREATE UNIQUE INDEX'
     OR v_wrong !~ 'company_id, year, month'
     OR v_wrong !~ 'WHERE \(status = ''confirmed''::text\)' THEN
    RAISE EXCEPTION 'vehicle day plans self-check 6: the one-confirmed-plan-per-month index is missing or has changed shape: %', coalesce(v_wrong, 'absent');
  END IF;

  -- 7. Every function: SECURITY DEFINER, a search_path pinned with pg_catalog
  --    first, an owner that can reach app_private, and no EXECUTE for a role the
  --    API authenticates as (the two public RPCs excepted, which authenticated
  --    must be able to call and anon and the service role must not).
  FOREACH v_sig IN ARRAY c_funcs LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'vehicle day plans self-check 7: % is missing', v_sig;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) THEN
      RAISE EXCEPTION 'vehicle day plans self-check 7: % is not SECURITY DEFINER', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                    WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=pg_catalog,%') THEN
      RAISE EXCEPTION 'vehicle day plans self-check 7: % does not pin its search_path with pg_catalog first', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = to_regprocedure(v_sig)
                      AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private'))) THEN
      RAISE EXCEPTION 'vehicle day plans self-check 7: the owner of % cannot reach app_private', v_sig;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
       OR has_function_privilege('service_role', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'vehicle day plans self-check 7: % is executable by anon or the service role', v_sig;
    END IF;
    IF v_sig LIKE 'app\_private.%' AND has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'vehicle day plans self-check 7: % is executable by authenticated', v_sig;
    END IF;
    IF v_sig LIKE 'public.%' AND NOT has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'vehicle day plans self-check 7: authenticated cannot call %', v_sig;
    END IF;
  END LOOP;

  -- 8. Both RPCs are VOLATILE (so supabase-js calls them with POST and not in a
  --    read-only transaction), both ask the state helper and the Dokumente page
  --    with the not_authorized hint, and both take the advisory lock on the
  --    month. The bodies are read with their comments removed, so a gate that
  --    survives only as a comment is not a gate.
  FOREACH v_sig IN ARRAY ARRAY['public.vehicle_day_plan_save(jsonb)',
                               'public.vehicle_day_plan_confirm(uuid,boolean)'] LOOP
    IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) <> 'v' THEN
      RAISE EXCEPTION 'vehicle day plans self-check 8: % is not VOLATILE', v_sig;
    END IF;
    v_src := app_private.function_code(v_sig);
    IF v_src !~ 'get_active_company_id' THEN
      RAISE EXCEPTION 'vehicle day plans self-check 8: % does not ask get_active_company_id()', v_sig;
    END IF;
    IF v_src !~ 'IF\s+NOT\s+public\.current_role_permits\(''documents'',\s*true\)\s+THEN\s+RAISE\s+EXCEPTION[^;]*not_authorized' THEN
      RAISE EXCEPTION 'vehicle day plans self-check 8: % lost the Dokumente page gate or its not_authorized hint', v_sig;
    END IF;
    IF v_src !~ 'pg_advisory_xact_lock' THEN
      RAISE EXCEPTION 'vehicle day plans self-check 8: % does not take the advisory lock on the month', v_sig;
    END IF;
  END LOOP;

  -- The save RPC keeps its two closed key lists and writes the totals itself.
  v_src := app_private.function_code('public.vehicle_day_plan_save(jsonb)');
  IF v_src !~ 'unknown payload key' OR v_src !~ 'unknown shift key'
     OR v_src !~ 'k\.key\s*<>\s*ALL\s*\(c_top_keys\)' OR v_src !~ 'NOT\s*\(c_shift_shape\s*\?\s*k\.key\)'
     OR v_src !~ 'operating_day_count' OR v_src !~ 'vehicle_day_plan_rows_lost' THEN
    RAISE EXCEPTION 'vehicle day plans self-check 8: vehicle_day_plan_save lost a closed key list, the totals it writes or its row count';
  END IF;

  -- 9. Rules 2 and 3. No column of either table is named like a driver, a ride,
  --    an address or a fare; no foreign key points at the trips or the drivers;
  --    and none of the six functions names either table.
  SELECT string_agg(format('%s.%s', c.relname, a.attname), ', ' ORDER BY c.relname, a.attname) INTO v_wrong
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.oid IN ('public.vehicle_day_plans'::regclass, 'public.vehicle_day_shifts'::regclass)
     AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname ~ '(^|_)(driver|fahrer|ride|trip|address|adresse|fare|tip|trinkgeld|passenger|customer|pickup|destination|route|gps|lat|lng|latitude|longitude)(_|$)';
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle day plans self-check 9: a column is named like a driver, a ride, an address or a fare: %', v_wrong;
  END IF;

  SELECT string_agg(format('%s.%s', c.conrelid::regclass, c.conname), ', ') INTO v_wrong
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.conrelid IN ('public.vehicle_day_plans'::regclass, 'public.vehicle_day_shifts'::regclass)
     AND c.confrelid IN (to_regclass('public.fahrtenbuch_trips'), to_regclass('public.drivers'));
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle day plans self-check 9: a vehicle-day table references the trips or the drivers: %', v_wrong;
  END IF;

  SELECT string_agg(f.sig, ', ') INTO v_wrong
    FROM unnest(c_funcs) AS f(sig)
   WHERE app_private.function_code(f.sig) ~* 'fahrtenbuch_trips|\mdrivers\M';
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle day plans self-check 9: a vehicle-day function names the trips or the drivers: %', v_wrong;
  END IF;

  -- 10. Rule 1. The operating day's start hour is a NOT NULL column with no
  --     default and a 0-23 check; the plan guard fixes it for the plan's life;
  --     the shift guard recomputes the moments from the stored value and refuses
  --     a contradiction; and the slot length and the algorithm version are
  --     stored beside it. The shift guard's conditions are matched whole, each
  --     as `IF <condition> THEN RAISE ... <its hint>`, because a pattern that
  --     asks only whether a name occurs is satisfied by `IF false AND <the
  --     condition>`, and the condition is the rule.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = 'public.vehicle_day_plans'::regclass
                    AND a.attname IN ('operating_day_start_hour', 'slot_minutes', 'algorithm_version')
                  GROUP BY a.attrelid
                 HAVING count(*) = 3 AND bool_and(a.attnotnull) AND NOT bool_or(a.atthasdef)) THEN
    RAISE EXCEPTION 'vehicle day plans self-check 10: operating_day_start_hour, slot_minutes and algorithm_version must be NOT NULL with no default';
  END IF;
  SELECT pg_get_constraintdef(c.oid) INTO v_wrong
    FROM pg_constraint c
   WHERE c.conrelid = 'public.vehicle_day_plans'::regclass
     AND c.conname = 'vehicle_day_plans_start_hour_valid';
  IF v_wrong IS NULL OR v_wrong !~ 'operating_day_start_hour' OR v_wrong !~ '0' OR v_wrong !~ '23' THEN
    RAISE EXCEPTION 'vehicle day plans self-check 10: the 0-23 check on operating_day_start_hour is missing: %', coalesce(v_wrong, 'absent');
  END IF;
  v_src := app_private.function_code('app_private.vehicle_day_plan_guard()');
  IF v_src !~ 'NEW\.operating_day_start_hour\s+IS\s+DISTINCT\s+FROM\s+OLD\.operating_day_start_hour'
     OR v_src !~ 'NEW\.slot_minutes\s+IS\s+DISTINCT\s+FROM\s+OLD\.slot_minutes'
     OR v_src !~ 'NEW\.algorithm_version\s+IS\s+DISTINCT\s+FROM\s+OLD\.algorithm_version'
     OR v_src !~ 'THEN\s+RAISE\s+EXCEPTION[^;]*vehicle_day_plan_key_fixed' THEN
    RAISE EXCEPTION 'vehicle day plans self-check 10: the plan guard no longer fixes the hour, the slot length and the algorithm version';
  END IF;
  v_src := app_private.function_code('app_private.vehicle_day_shift_guard()');
  IF v_src !~ 'v_from_min\s*:=\s*v_plan\.operating_day_start_hour\s*\*\s*60\s*\+\s*NEW\.start_position\s*\*\s*v_plan\.slot_minutes'
     OR v_src !~ 'v_to_min\s*:=\s*v_plan\.operating_day_start_hour\s*\*\s*60\s*\+\s*NEW\.end_position\s*\*\s*v_plan\.slot_minutes'
     OR v_src !~ 'IF\s+NEW\.starts_local\s+IS\s+DISTINCT\s+FROM\s+NEW\.operating_date::timestamp\s*\+\s*make_interval\(mins\s*=>\s*v_from_min\)\s+OR\s+NEW\.ends_local\s+IS\s+DISTINCT\s+FROM\s+NEW\.operating_date::timestamp\s*\+\s*make_interval\(mins\s*=>\s*v_to_min\)\s+THEN\s+RAISE\s+EXCEPTION[^;]*vehicle_day_shift_moments_mismatch'
     OR v_src !~ 'IF\s+NEW\.minutes\s+IS\s+DISTINCT\s+FROM\s+\(NEW\.end_position\s*-\s*NEW\.start_position\)\s*\*\s*v_plan\.slot_minutes\s+THEN\s+RAISE\s+EXCEPTION[^;]*vehicle_day_shift_minutes_mismatch'
     OR v_src !~ 'IF\s+NEW\.end_position\s*>\s*1440\s*/\s*v_plan\.slot_minutes\s+THEN\s+RAISE\s+EXCEPTION[^;]*vehicle_day_shift_positions_invalid'
     OR v_src !~ 'IF\s+EXTRACT\(YEAR\s+FROM\s+NEW\.operating_date\)::integer\s+IS\s+DISTINCT\s+FROM\s+v_plan\.year\s+OR\s+EXTRACT\(MONTH\s+FROM\s+NEW\.operating_date\)::integer\s+IS\s+DISTINCT\s+FROM\s+v_plan\.month\s+THEN\s+RAISE\s+EXCEPTION[^;]*vehicle_day_shift_outside_month' THEN
    RAISE EXCEPTION 'vehicle day plans self-check 10: the shift guard no longer recomputes the shift from the stored hour and slot length, or no longer refuses a contradiction';
  END IF;

  -- 11. The named constraints the kit and the client lean on.
  FOREACH v_sig IN ARRAY ARRAY['vehicle_day_plans_slot_minutes_supported',
                               'vehicle_day_plans_algorithm_version_token',
                               'vehicle_day_plans_status_matches_confirmation',
                               'vehicle_day_plans_confirmed_together',
                               'vehicle_day_plans_superseded_together',
                               'vehicle_day_shifts_one_per_slot',
                               'vehicle_day_shifts_vehicle_named',
                               'vehicle_day_shifts_index_valid',
                               'vehicle_day_shifts_positions_ordered',
                               'vehicle_day_shifts_moments_ordered',
                               'vehicle_day_shifts_day_type_matches_date',
                               'vehicle_day_shifts_revenue_not_negative',
                               'vehicle_day_shifts_confidence_known'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = v_sig
                     AND c.connamespace = 'public'::regnamespace) THEN
      RAISE EXCEPTION 'vehicle day plans self-check 11: the constraint % is missing', v_sig;
    END IF;
  END LOOP;
  SELECT pg_get_constraintdef(c.oid) INTO v_wrong
    FROM pg_constraint c
   WHERE c.conrelid = 'public.vehicle_day_plans'::regclass
     AND c.conname = 'vehicle_day_plans_slot_minutes_supported';
  IF v_wrong !~ '15' OR v_wrong !~ '30' OR v_wrong !~ '60' THEN
    RAISE EXCEPTION 'vehicle day plans self-check 11: the supported slot lengths are not 15, 30 and 60: %', v_wrong;
  END IF;
  SELECT pg_get_constraintdef(c.oid) INTO v_wrong
    FROM pg_constraint c
   WHERE c.conrelid = 'public.vehicle_day_plans'::regclass
     AND c.conname = 'vehicle_day_plans_algorithm_version_token';
  IF v_wrong !~ 'algorithm_version' OR v_wrong !~ '\{0,99\}' OR v_wrong !~ '\^\[A-Za-z0-9\]' THEN
    RAISE EXCEPTION 'vehicle day plans self-check 11: algorithm_version is not held to a token of at most 100 characters: %', v_wrong;
  END IF;

  -- 12. The status a plan is born with, and the generation it starts from.
  IF (SELECT a.atthasdef FROM pg_attribute a
       WHERE a.attrelid = 'public.vehicle_day_plans'::regclass AND a.attname = 'status') IS NOT TRUE
     OR (SELECT a.atthasdef FROM pg_attribute a
          WHERE a.attrelid = 'public.vehicle_day_plans'::regclass AND a.attname = 'generation') IS NOT TRUE THEN
    RAISE EXCEPTION 'vehicle day plans self-check 12: vehicle_day_plans.status or .generation has no default';
  END IF;

  -- 13. A company's own cascade must never be stopped by the freeze. The two
  --     bodies that refuse a change to a confirmed plan carry the condition
  --     20261016140000 added to the monthly plan's copies, and the foreign keys
  --     from companies cascade.
  v_src := app_private.function_code('app_private.vehicle_day_plan_guard()');
  IF v_src !~ 'FROM\s+public\.companies\s+c\s+WHERE\s+c\.id\s*=\s*OLD\.company_id' THEN
    RAISE EXCEPTION 'vehicle day plans self-check 13: the plan guard refuses a delete even when the company is gone';
  END IF;
  v_src := app_private.function_code('app_private.vehicle_day_plan_parent_is_open(uuid,uuid)');
  IF v_src !~ 'FROM\s+public\.companies\s+c\s+WHERE\s+c\.id\s*=\s*p_company_id' THEN
    RAISE EXCEPTION 'vehicle day plans self-check 13: parent_is_open refuses a write even when the company is gone';
  END IF;
  IF (SELECT count(*) FROM pg_constraint k
       WHERE k.contype = 'f' AND k.confrelid = 'public.companies'::regclass
         AND k.conrelid IN ('public.vehicle_day_plans'::regclass, 'public.vehicle_day_shifts'::regclass)
         AND k.confdeltype = 'c') <> 2 THEN
    RAISE EXCEPTION 'vehicle day plans self-check 13: both tables must cascade from companies';
  END IF;

  -- 14. Rule 2, the summary. The helper is pure, so it is run here on literals:
  --     NULL for a summary of the allowed shape, and a named problem for
  --     anything else. The plan guard asks it on every insert and on every edit
  --     of a draft that changes the summary, and the save RPC asks it before it
  --     writes anything.
  IF app_private.vehicle_day_plan_summary_problem('{}'::jsonb) IS NOT NULL
     OR app_private.vehicle_day_plan_summary_problem(
          '{"shift_count": 3, "vehicle_count": 1, "operating_day_count": 2, "total_minutes": 540, "expected_revenue_cents": 12345, "min_shift_minutes": 180, "max_shift_minutes": 285, "min_break_minutes": 30, "max_shifts_per_vehicle_per_day": 2, "min_revenue_per_hour_cents": 2000, "block_gap_minutes": 30.5, "min_evidence_days": 2, "target_revenue_cents": 500000, "history_months": [202608, 202609]}'::jsonb
        ) IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle day plans self-check 14: the summary helper refuses a summary of the allowed shape';
  END IF;
  FOR v_wrong IN
    SELECT unnest(ARRAY['{"driver_id": "d1"}', '{"rides": []}', '{"note": "free text"}',
                        '{"shift_count": "3"}', '{"shift_count": null}', '{"shift_count": true}',
                        '{"shift_count": -1}', '{"shift_count": [3]}', '{"min_shift_minutes": {"a": 1}}',
                        '{"total_minutes": 1000000000000001}',
                        '{"history_months": [{"year": 2026, "month": 8}]}', '{"history_months": ["202608"]}',
                        '{"history_months": [202613]}', '{"history_months": [202600]}',
                        '{"history_months": [202608.5]}', '{"history_months": 202608}',
                        '{"history_months": null}', '[]', '"x"', 'null'])
  LOOP
    IF app_private.vehicle_day_plan_summary_problem(v_wrong::jsonb) IS NULL THEN
      RAISE EXCEPTION 'vehicle day plans self-check 14: the summary helper admits %', v_wrong;
    END IF;
  END LOOP;
  IF app_private.vehicle_day_plan_summary_problem(NULL) IS NULL
     OR app_private.vehicle_day_plan_summary_problem(
          (SELECT jsonb_build_object('history_months', jsonb_agg(202608)) FROM generate_series(1, 241))) IS NULL THEN
    RAISE EXCEPTION 'vehicle day plans self-check 14: the summary helper admits a NULL summary or a history of 241 months';
  END IF;
  -- The guard asks the helper in both places, each as `ask, then refuse by the
  -- hint`: once at the end of the INSERT branch, once for an edit that changes
  -- the summary.
  v_src := app_private.function_code('app_private.vehicle_day_plan_guard()');
  IF v_src !~ 'NEW\.updated_at\s*:=\s*now\(\);\s*v_problem\s*:=\s*app_private\.vehicle_day_plan_summary_problem\(NEW\.summary\);\s*IF\s+v_problem\s+IS\s+NOT\s+NULL\s+THEN\s+RAISE\s+EXCEPTION[^;]*vehicle_day_plan_summary_invalid'
     OR v_src !~ 'IF\s+NEW\.summary\s+IS\s+DISTINCT\s+FROM\s+OLD\.summary\s+THEN\s+v_problem\s*:=\s*app_private\.vehicle_day_plan_summary_problem\(NEW\.summary\);\s*IF\s+v_problem\s+IS\s+NOT\s+NULL\s+THEN\s+RAISE\s+EXCEPTION[^;]*vehicle_day_plan_summary_invalid' THEN
    RAISE EXCEPTION 'vehicle day plans self-check 14: the plan guard no longer applies the summary rule to inserts and edits';
  END IF;
  v_src := app_private.function_code('public.vehicle_day_plan_save(jsonb)');
  IF v_src !~ 'app_private\.vehicle_day_plan_summary_problem\(v_summary\)'
     OR v_src !~ 'jsonb_typeof\(p_payload\s*->\s*''algorithm_version''\)\s*<>\s*''string'''
     OR v_src !~ 'jsonb_typeof\(kv\.value\)\s*<>\s*c_shift_shape\s*->>\s*kv\.key' THEN
    RAISE EXCEPTION 'vehicle day plans self-check 14: the save RPC no longer applies the summary rule or the JSON type checks';
  END IF;

  -- 15. Two properties a one-session kit cannot see, kept in the source because
  --     the behaviour needs a second session (tests/rls/vehicle-day-plans-
  --     concurrency.sql) or a table the planner has stale figures for.
  --     (a) A shift write reads its plan FOR KEY SHARE, which conflicts with the
  --         FOR UPDATE confirm takes on that row.
  --     (b) The overlap check is one pass over the plan's shifts, not a join of
  --         the table with itself.
  v_src := app_private.function_code('app_private.vehicle_day_plan_parent_is_open(uuid,uuid)');
  IF v_src !~ 'FROM\s+public\.vehicle_day_plans\s+p\s+WHERE\s+p\.id\s*=\s*p_plan_id\s+FOR\s+KEY\s+SHARE\s*;' THEN
    RAISE EXCEPTION 'vehicle day plans self-check 15: parent_is_open no longer reads the plan FOR KEY SHARE';
  END IF;
  v_src := app_private.function_code('public.vehicle_day_plan_confirm(uuid,boolean)');
  IF v_src !~ 'WHERE\s+p\.id\s*=\s*p_plan_id\s+FOR\s+UPDATE\s*;'
     OR v_src !~ 'PARTITION\s+BY\s+s\.vehicle'
     OR v_src !~ 'ROWS\s+BETWEEN\s+UNBOUNDED\s+PRECEDING\s+AND\s+1\s+PRECEDING'
     OR v_src ~* 'JOIN\s+public\.vehicle_day_shifts' THEN
    RAISE EXCEPTION 'vehicle day plans self-check 15: vehicle_day_plan_confirm lost its FOR UPDATE on the plan or its single-pass overlap check';
  END IF;

  RAISE NOTICE 'vehicle day plans self-check: passed';
END $mig$;
