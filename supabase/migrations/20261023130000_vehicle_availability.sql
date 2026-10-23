/*
  # Vehicle availability: whether a car may be on the road on an operating day

  Slice 1 (20261022140000) gave the forward plan its record: one plan per company
  and month, shifts per vehicle and operating day, no driver. "Daily, per
  vehicle" with no notion of whether the vehicle is **available** is only half a
  plan, and the gap is measured rather than argued:

    · **no planner anywhere in this codebase reads `werkstatt_checks`.** The
      table is written by WerkstattPage and read by WerkstattPage and the
      Overview, and by nothing that plans;
    · there is no out-of-service flag with a date range on a vehicle at all.

  So a plan can put a car on the road on a day it is in the workshop or its TÜV
  has expired, and nothing says a word. This file is the fact and the read, and
  nothing else: one table, one guard, two readers. It rewires no pipeline.

  ── WHAT IS ADDITIVE, AND WHY THAT IS THE WHOLE DESIGN ───────────────────────

  Nothing here is called by monatsplanungPhase1, phase 3, phase 4, the repair
  pass, the finalization checks, computeLohnartSeconds or any document builder,
  and none of them is edited. That code encodes statutory German payroll rules
  more intricate than its shape suggests, has almost no test coverage, and
  produces documents that go to a Steuerberater; a plausible-looking refactor
  there can silently corrupt someone's payroll. A table and a read beside the
  pipeline are reversible, and a caller is added in a later slice that can be
  judged on its own.

  utils/shiftRecommendation/ is not touched either, and must not be: its
  boundary.test.ts fails the build if that module names a database table or
  imports outside a four-module allow-list, and that line is the owner's
  decision of 08.10.2026. If the recommender should one day read availability,
  that is a later slice and a separate decision.

  No screen calls either reader yet, as slice 1 shipped with no caller.

  ── RULE 1: THE OPERATING DAY'S START HOUR IS AN ARGUMENT, NEVER A CONSTANT ──

  This codebase has four cuts of "operating day", and they disagree about which
  day a Friday 22:00 → 02:00 shift belongs to:

    · a configurable 04:00 in utils/shiftRecommendation/ (ProfileSettings);
    · a hard-coded 04:00 in utils/simulatedRides/time.ts;
    · 04:00 for an Uber day in utils/uberPeriods.ts;
    · 00:00, the calendar date, in monatsplanungPhase1.ts (service_date),
      monatsplanungPhase3.ts (startDayKey) and monthlyPlan/blocks.ts.

  Unifying them is explicitly a later slice: nothing in the code says which cut
  is authoritative, so choosing one here would be choosing an agent's preference
  over the system's. This file therefore never holds an opinion:

    · `public.vehicle_availability_on(car, date, hour)` takes the hour as an
      argument **with no default**. A default of 4, or of 0, would be the
      re-derivation in disguise — the same reason
      `vehicle_day_plans.operating_day_start_hour` is NOT NULL with no default.
      A caller must state which cut it is asking about;
    · `public.vehicle_day_plan_availability(plan)` takes the hour **from the
      plan row** and from nowhere else, because that is where slice 1 stored it.
      Self-check 9 reads the body and fails a release in which it stops naming
      `operating_day_start_hour` or starts naming an hour literal.

  The operating day that starts on date D under hour H is the half-open
  wall-clock window

      [ D + H hours , (D + 1 day) + H hours )

  and `D + 1` is **date arithmetic on the calendar**, never a fixed 86_400_000
  milliseconds. The moments are `timestamp` WITHOUT time zone, as slice 1 stores
  its moments, because a wall time the clocks skip or repeat on the two DST
  nights is not an instant to guess (the importer's own rule: a wall time the
  clocks skip is unreadable, not guessed). 25.10.2026 is a 25-hour local day and
  29.03.2026 a 23-hour one; because every boundary here is built from its own
  day's calendar parts and compared as wall clock, both days are one operating
  day like any other. That exact mistake — advancing a day by a fixed number of
  milliseconds — gave 11 real rides on staging to drivers marked sick, and
  src/utils/noteWindowDst.test.ts pins the corrected helper. Section 4 of
  tests/rls/vehicle-availability.sql walks both nights.

  There is no per-company timezone and none is introduced: Europe/Berlin is a
  hard constant in some fifteen modules and vitest.config.ts pins TZ to it.

  ── WHAT A WINDOW HOLDS, AND WHAT IS DERIVED INSTEAD OF TYPED TWICE ──────────

  `public.vehicle_unavailability` is the **hand-entered** window only: an
  accident, a breakdown, a stretch in the workshop an operator knows about
  before any check records it. Per company, per car, a wall-clock from and an
  optional to (NULL = still off the road, open-ended), a reason from a closed
  list, a free-text note, and who recorded it.

  Two facts the database already holds are **derived** at read time rather than
  asked for again, which is the discipline 20260924100000 established for the
  notification windows (one definition, passed in, so the mail and the screen
  cannot disagree about the same car):

    · **a negative Werkstatt check.** `werkstatt_checks.status` is 'positive',
      'negative' or 'repaired'. The latest check on or before the operating date
      decides: 'negative' means the car was found defective and nothing since
      has cleared it. 'repaired' clears it, which is what the word means on that
      screen. Found in **one pass** over that car's checks (ORDER BY check_date
      DESC LIMIT 1), never by joining the table with itself — 12,400 rows of a
      self-join did not finish inside the API roles' 8 s statement timeout in
      slice 1, and that lesson is carried, not re-learnt;
    · **an expired TÜV.** `cars.tuev_gueltig_bis` is a date, and the car is
      unavailable for every operating day that **starts after** it. A NULL TÜV
      is *unknown*, not expired — `getTuevStatus()` in src/types/car.ts answers
      'unbekannt' for NULL and the notification job does not treat it as
      expired, so neither does this. TUEV_SOON_DAYS (60) is deliberately absent:
      availability is not a warning window. A TÜV that expires in a fortnight
      does not stop a car driving today, and reading the 60-day warning as
      unavailability would take a quarter of a fleet off the road.

  Three limits are stated rather than hidden:

    · the answer names **every** reason that applies, as a sorted `sources`
      array, instead of ranking them. A precedence between "the operator says it
      is in the workshop", "its TÜV has expired" and "its last check was
      negative" would be invented here, and an operator reading one reason when
      three apply is worse served than one reading three;
    · `vehicle_day_plan_availability` resolves a shift's `vehicle` against
      `cars.kennzeichen` **as exact text**, the way slice 1's own overlap check
      takes a vehicle. 'B-AB 123' and 'b-ab 123', or two spellings differing by
      a space, are two vehicles. A plate that matches no car is reported as
      `unverifiable`, never as available;
    · the verdict vocabulary is the Rückkehrpflicht tab's own — 'available',
      'unavailable', 'unverifiable' — because that tab already had to say "the
      data does not establish this" and inventing a second word for it would
      leave two. `verdict` is text and never a NULL boolean: a three-valued
      comparison fails open on one NULL, which is how the anon key once reached
      list_users_for_admin().

  ── WHY NOT `cars.status`, MEASURED RATHER THAN ASSUMED ──────────────────────

  `cars.status` is not reused, and the reason is read off the live schema rather
  than guessed. The migration chain cannot create `public.cars` at all (the
  table has no CREATE TABLE anywhere in it — CLAUDE.md, Known defects), but the
  RLS kit's fixture **is** production's `--schema=public` dump, and it carries:

      status text DEFAULT 'active'::text NOT NULL,
      CONSTRAINT cars_status_check CHECK (status = ANY (ARRAY['active', 'inactive']))

  So the domain is not unknown: it is exactly two values, and **neither of them
  is an out-of-service state**. Three consequences, each on its own sufficient:

    1. adding a third value would be a domain change to a CHECK constraint that
       lives outside version control, on a table the chain cannot rebuild. That
       is the shape that already produced a dead filter: a
       `.neq('status', 'archived')` in HistoricalWorkingHoursWizard.tsx matched
       every row for years, because `drivers_status_check` admits only
       'active'/'inactive' and no row was ever 'archived';
    2. 20260924100000 declined to filter on this column and said so, so writing
       a planner that does would contradict a decision already taken next door;
    3. and it would not work anyway. A status column has no from and no to. "In
       the workshop from Tuesday to Thursday" is a window, and a flag cannot
       express it, so the window is needed whatever `status` admits.

  `cars.status` is therefore not read by either function, and no value is
  invented for it. Self-check 10 fails a release in which either reader starts
  naming the column.

  ── ACCESS, AND WHY THE PAGE IS cars ────────────────────────────────────────

    SELECT   company_id = (SELECT get_active_company_id())
             OR (SELECT platform_reads_company_data())
    INSERT   (company_id = (SELECT get_active_company_id())
              AND (SELECT current_role_permits('cars', true)))
             OR (SELECT platform_writes_company_data())
    UPDATE   the same, as USING and as WITH CHECK
    DELETE   the same

  The page is **`cars`**, not `is_company_admin()`. The object is one vehicle,
  and the screen that owns a vehicle's lifecycle facts — its plate, its TÜV date,
  its existence — is Fahrzeuge, which took page `cars` in 20260910120000 and kept
  it through slice C; `car_driver_assignments` took the same page in
  20260923130000 for the same reason. "This car is off the road until Thursday"
  is an operational fleet fact of exactly that kind, and `werkstatt_checks`, which
  records the nearest thing to it today, is itself page-gated (`werkstatt`) rather
  than admin-gated.

  `trip_analysis_settings` and `driver_month_budget` both took
  `is_company_admin()`, and the difference is the kind of object, not its
  importance: both are **company-wide configuration** — one Betriebssitz, one
  budget policy, one row for the whole company — where this is a per-car
  operational record a fleet manager writes in the course of a week. Deleting a
  car outright is already page `cars`; requiring an administrator to note that it
  is in the workshop, while any editor may delete it, would be the stricter gate
  on the smaller act.

  SELECT is **not** role-gated, and no role term was invented for it: 3.3's shape
  has none there and slice C did not add one.

  No `page_key` was created and no `role_permissions` row written. The Rollen
  screen saves a role by deleting its rows and re-inserting one per key in
  PAGE_DEFINITIONS, so a key that screen does not know is dropped the first time
  anyone edits the role. The rights that move are the ones the seeded roles
  already imply: a viewer holds can_edit on no page, an editor holds it on
  `cars`, so an editor, a supervisor or an administrator records a window.

  Both context triggers are on the table, derived from the policies naming
  `get_active_company_id()` and not from who writes it today:
  `refuse_read_only_context_write` (a view context writes nothing) and
  `record_support_write` (every row a support session writes leaves one audit
  row). tests/rls/platform-contexts.sql section 14 and
  tests/rls/support-write-audit.sql section 1 fail a table carrying one without
  the other, and 20260924100000 shipped with neither on the reasoning "no client
  writes it" and was refused by the kit.

  anon holds nothing. `authenticated` holds SELECT, INSERT, UPDATE and DELETE on
  the table and EXECUTE on both readers. The service role holds nothing: the
  readers are SECURITY INVOKER over tenant tables and the service key answers no
  policy.

  ── THE READERS ARE SECURITY INVOKER, WHICH IS WHAT KEEPS THEM UNGATED ──────

  Both run as the caller, so the caller's own policies on
  `vehicle_unavailability`, `cars`, `werkstatt_checks` and `vehicle_day_plans`
  answer them, exactly as `get_weekly_abrechnung` and its three siblings are
  answered by the caller's policies on `income`, `receipts` and
  `cash_transactions`. That is why neither needs a role gate of its own: it is a
  read, and reads are not role-gated. It is also why **neither may name
  `app_private`**: `authenticated` holds no USAGE there, a SECURITY INVOKER
  function that names it dies 42501, and a caught `insufficient_privilege`
  becomes a silent "Keine Berechtigung" — PR #117's defect, which matrix.sql
  cannot report. Self-check 8 reads both bodies and fails on the schema name.

  For the same reason no CHECK constraint on this table names `app_private`
  either: a CHECK is evaluated as the **writing role**, so one calling into that
  schema would let the owner insert and give `authenticated` 42501 on every row.
  Every rule this table enforces is a CHECK over its own columns or a foreign
  key, which is the point of deriving a property into a constraint rather than
  into a function: a rule enforced in one function is lost silently by the next
  writer.

  Both are `LANGUAGE plpgsql` with a pinned `search_path`, which is also the one
  shape the plan cache cannot mask: an inlinable `LANGUAGE sql` function that is
  IMMUTABLE with no SET clause is folded away by the planner and its EXECUTE
  check disappears with it (measured, F2 in tests/tools/plan-cache-repro.sql),
  while the same helper in plpgsql, or with a SET clause, is re-checked on every
  execution (F1, F3).

  ── THE CAR BELONGS TO THE COMPANY, AS A FOREIGN KEY ────────────────────────

  `(car_id, company_id)` references `public.cars (id, company_id)`, which needs
  a unique constraint on that pair; `cars.id` is already the primary key, so
  `cars_id_company_key` is satisfied by every existing row and costs one index.
  That is additive DDL and nothing reads it but this foreign key.

  It is a foreign key rather than a trigger or a comment because **the policies
  cannot do it**. A policy's WITH CHECK sees `company_id`, so it refuses a row
  moved to another company — but a caller who keeps its own `company_id` and
  points `car_id` at *another company's car* passes every policy on this table.
  The foreign key refuses that, at insert and at any later update of either
  side, and section 3 of the kit builds exactly that row and shows it refused
  for the owner too. `cars.company_id` is nullable in production, so a car with
  no company can hold no window; such a car is invisible to every tenant policy
  on `cars` and no screen can reach it, so nothing is lost.

  The guard pins `company_id` and `car_id` after insert, for the reason
  `pin_billing_company_id` exists on the two billing tables: a WITH CHECK sees
  only the new row and cannot say what it already was, so without the pin an
  UPDATE could re-attribute a window the operator's audit trail already names.
  Correcting the car is a new window, not an edit of this one.

  ── WHAT THE SUPPORT-WRITE AUDIT COPIES, AND WHY IT IS LEFT ALONE ───────────

  `app_private.support_write_redaction_pattern()` has no branch for this table,
  so the global name rule alone applies and none of its columns match it: the
  reason, the note and both moments are copied into the audit row. That was
  considered rather than overlooked. Redaction there covers "pay, identifiers
  beyond the name, gender and the free text about a person's pay or absence",
  which is why `driver_notes.note_text` is redacted — a note about a *person*.
  This note is about a *vehicle*: which car, which days, and why it was off the
  road, which is exactly what a support write here changes and what the audit
  exists to record. Adding a branch would mean restating that function with
  every existing branch carried character for character, and dropping one of
  them would silently stop redacting pay on the salary tables. If a note is ever
  found to carry a person's circumstances in practice, that is the moment to pay
  that cost, and not before.

  ── NO DRIVER, NO RIDE, NO FARE ─────────────────────────────────────────────

  Slice 1's rule 2 holds here for the same reason: a driver belongs to the
  month-end assignment, and this table is about a vehicle. Self-check 7 reads the
  catalogue and fails a release in which a column is named like a driver, a ride,
  an address or a fare. `note` is the one free-text field; it is bounded and the
  database does not pretend to know what is in it.

  ── COMPATIBILITY: this does NOT bump deploy/SCHEMA_EPOCH ───────────────────

  One new table, one unique constraint on `cars` that every row already
  satisfies, one trigger function and two new readers. Nothing existing is
  altered in meaning, nothing is dropped or renamed, and the previous release
  runs unchanged beside all of it and never reads any of it. Company deletion
  needs no edit: `app_private.company_deletion_tables()` reads the catalogue and
  this table cascades from `companies`.

  tests/rls/vehicle-availability.sql is this file's kit. tests/rls/matrix.sql
  carries the table's spec row (ordinal 78), its move row and its five
  expectation rows.
*/

-- ─── 1. the car/company pair, so the foreign key below can exist ────────────
--
-- `cars.id` is the primary key, so this holds for every row that exists and the
-- constraint can always be built. It supports no query in the product; its only
-- reader is vehicle_unavailability_car_of_company.

DO $mig$
BEGIN
  IF to_regclass('public.cars') IS NULL THEN
    RAISE EXCEPTION '20261023130000: public.cars does not exist — the fixture is not production''s public schema';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.cars'::regclass
       AND conname  = 'cars_id_company_key'
  ) THEN
    ALTER TABLE public.cars ADD CONSTRAINT cars_id_company_key UNIQUE (id, company_id);
    RAISE NOTICE '20261023130000: cars_id_company_key built';
  END IF;
END
$mig$;

-- ─── 2. the hand-entered window ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vehicle_unavailability (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- No single-column REFERENCES: the composite key below carries the company
  -- term, which is what refuses another company's car.
  car_id       uuid        NOT NULL,
  -- Wall-clock moments in Europe/Berlin, timestamp WITHOUT time zone (rule 1).
  starts_local timestamp   NOT NULL,
  -- NULL means open-ended: the car is still off the road and nobody has said
  -- until when. The readers treat that as unavailable from starts_local on.
  ends_local   timestamp   NULL,
  -- A closed list. English tokens, as subscription_coverage.source and
  -- vehicle_day_shifts.confidence are: these are identifiers a second consumer
  -- compares on, not labels, so the screen translates them and the database
  -- never stores a sentence.
  reason       text        NOT NULL,
  note         text        NOT NULL DEFAULT '',
  recorded_by  uuid        NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid        NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_unavailability_window_ordered
    CHECK (ends_local IS NULL OR ends_local > starts_local),
  CONSTRAINT vehicle_unavailability_reason_known
    CHECK (reason IN ('workshop', 'accident', 'breakdown', 'inspection', 'other')),
  CONSTRAINT vehicle_unavailability_note_bounded
    CHECK (char_length(note) <= 500),
  -- The car belongs to this company, as a foreign key and not as a comment: the
  -- policies see company_id only, so a caller keeping its own company and
  -- pointing car_id at another company's car passes all four of them.
  CONSTRAINT vehicle_unavailability_car_of_company
    FOREIGN KEY (car_id, company_id) REFERENCES public.cars (id, company_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.vehicle_unavailability IS
  'A hand-entered window in which one car may not be on the road: an accident, a '
  'breakdown, a stretch in the workshop. The other two reasons a car is '
  'unavailable are derived at read time and never typed here — a negative '
  'werkstatt_checks row and an expired cars.tuev_gueltig_bis. It names no driver '
  'and no ride (20261023130000).';

COMMENT ON COLUMN public.vehicle_unavailability.starts_local IS
  'Wall-clock moment in Europe/Berlin, timestamp WITHOUT time zone: a wall time '
  'the clocks skip or repeat is not an instant to guess. (20261023130000)';

COMMENT ON COLUMN public.vehicle_unavailability.ends_local IS
  'NULL means open-ended — the car is off the road and nobody has said until '
  'when. (20261023130000)';

-- The readers ask one car's windows around one day.
CREATE INDEX IF NOT EXISTS vehicle_unavailability_car_window_idx
  ON public.vehicle_unavailability (car_id, starts_local);

CREATE INDEX IF NOT EXISTS vehicle_unavailability_company_idx
  ON public.vehicle_unavailability (company_id);

-- ─── 3. the guard ───────────────────────────────────────────────────────────

/*
  Two rules, and nothing else: the actor and the time are the database's, and
  the window's subject is fixed once it exists.

  Pinning company_id and car_id is the reason pin_billing_company_id exists on
  the two billing tables: a policy's WITH CHECK sees only the new row and cannot
  say what it already was, so without the pin an UPDATE could re-attribute a
  window the audit trail already names to a different car. Correcting the car is
  a new window.
*/
CREATE OR REPLACE FUNCTION app_private.vehicle_unavailability_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.recorded_by := v_uid;
    NEW.created_at  := now();
    NEW.updated_by  := NULL;
    NEW.updated_at  := now();
    RETURN NEW;
  END IF;

  -- UPDATE. The subject of the window is fixed; a window belongs to one car of
  -- one company for its whole life.
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Ein Fahrzeug-Ausfallzeitraum kann nicht einem anderen Unternehmen zugeordnet werden.'
      USING ERRCODE = 'P0001', HINT = 'vehicle_unavailability_company_pinned';
  END IF;

  IF NEW.car_id IS DISTINCT FROM OLD.car_id THEN
    RAISE EXCEPTION 'Ein Fahrzeug-Ausfallzeitraum kann nicht auf ein anderes Fahrzeug übertragen werden.'
      USING ERRCODE = 'P0001', HINT = 'vehicle_unavailability_car_pinned';
  END IF;

  NEW.recorded_by := OLD.recorded_by;
  NEW.created_at  := OLD.created_at;
  NEW.updated_by  := v_uid;
  NEW.updated_at  := now();
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION app_private.vehicle_unavailability_guard() IS
  'Stamps the actor and the time on a vehicle unavailability window, and pins its '
  'company and car once it exists: a WITH CHECK sees only the new row and cannot '
  'refuse a re-attribution (20261023130000).';

DROP TRIGGER IF EXISTS vehicle_unavailability_guard ON public.vehicle_unavailability;
CREATE TRIGGER vehicle_unavailability_guard
  BEFORE INSERT OR UPDATE ON public.vehicle_unavailability
  FOR EACH ROW EXECUTE FUNCTION app_private.vehicle_unavailability_guard();

-- ─── 4. the tenant shape ────────────────────────────────────────────────────

ALTER TABLE public.vehicle_unavailability ENABLE ROW LEVEL SECURITY;

DO $mig$
DECLARE
  v_tbl    constant text := 'vehicle_unavailability';
  p        record;
  v_tenant constant text := 'company_id = (SELECT public.get_active_company_id())';
  v_reads  constant text := '(SELECT public.platform_reads_company_data())';
  v_writes constant text := '(SELECT public.platform_writes_company_data())';
  -- The screen that owns a vehicle (see the header). SELECT asks no role.
  v_gate   constant text := '(SELECT public.current_role_permits(''cars'', true))';
  v_where  text;
BEGIN
  v_where := v_tenant || ' AND ' || v_gate;

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
  -- The same predicate as USING and as WITH CHECK: writing it twice is what
  -- refuses a move between companies.
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
  -- tests/rls/support-write-audit.sql section 1 state, and not from who writes
  -- this table today.
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
END
$mig$;

-- ─── 5. the read: one car, one operating day ────────────────────────────────

/*
  Is this car available on this operating day, and if not, why not.

  `p_operating_day_start_hour` has **no default** (rule 1): the caller states
  which cut of "operating day" it is asking about, because this codebase has
  four and none of them is authoritative. The window is

      [ p_operating_date + hour , (p_operating_date + 1 day) + hour )

  built from the calendar, so the 23- and 25-hour DST days are one operating day
  like any other.

  SECURITY INVOKER: the caller's own policies on vehicle_unavailability, cars and
  werkstatt_checks answer it, which is why it needs no role gate (a read is not
  role-gated) and why it may not name app_private. A car the caller cannot see is
  'unverifiable', never 'available'.

  `sources` names every reason that applies, sorted, rather than ranking them;
  it is empty exactly when the verdict is 'available'.
*/
CREATE OR REPLACE FUNCTION public.vehicle_availability_on(
  p_car_id                   uuid,
  p_operating_date           date,
  p_operating_day_start_hour integer
)
RETURNS TABLE (verdict text, sources text[])
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_from    timestamp;
  v_to      timestamp;
  v_tuev    date;
  v_seen    boolean := false;
  v_status  text;
  v_sources text[] := ARRAY[]::text[];
BEGIN
  -- A broken argument contract raises 22023 with a fixed message, and never
  -- SQLERRM. Everything else is a return value.
  IF p_car_id IS NULL OR p_operating_date IS NULL OR p_operating_day_start_hour IS NULL THEN
    RAISE EXCEPTION 'vehicle_availability_on: car, operating date and operating day start hour are all required'
      USING ERRCODE = '22023';
  END IF;

  IF p_operating_day_start_hour < 0 OR p_operating_day_start_hour > 23 THEN
    RAISE EXCEPTION 'vehicle_availability_on: the operating day start hour must be between 0 and 23'
      USING ERRCODE = '22023';
  END IF;

  -- Calendar arithmetic, never a fixed number of milliseconds.
  v_from := p_operating_date::timestamp      + make_interval(hours => p_operating_day_start_hour);
  v_to   := (p_operating_date + 1)::timestamp + make_interval(hours => p_operating_day_start_hour);

  -- The car, under the caller's own policies. Not found means not established:
  -- a car of another company, or one a blocked account cannot see, is
  -- 'unverifiable' and never 'available'.
  SELECT c.tuev_gueltig_bis INTO v_tuev
    FROM public.cars c
   WHERE c.id = p_car_id;

  v_seen := FOUND;

  IF NOT v_seen THEN
    RETURN QUERY SELECT 'unverifiable'::text, ARRAY['car_not_readable']::text[];
    RETURN;
  END IF;

  -- 1. A hand-entered window overlapping the operating day. Half-open on both
  --    sides, the shape noteExclusionIntervals' own overlap test uses
  --    (startMs < iv.end && endMs > iv.start). An open-ended window has no end.
  IF EXISTS (
    SELECT 1 FROM public.vehicle_unavailability u
     WHERE u.car_id = p_car_id
       AND u.starts_local < v_to
       AND (u.ends_local IS NULL OR u.ends_local > v_from)
  ) THEN
    v_sources := v_sources || 'recorded';
  END IF;

  -- 2. An expired TÜV: the car may not be on the road for an operating day that
  --    starts after the validity date. A NULL TÜV is unknown, not expired —
  --    getTuevStatus() answers 'unbekannt' and the notification job does not
  --    treat it as expired either. The 60-day warning window is deliberately
  --    not read here: availability is not a warning.
  IF v_tuev IS NOT NULL AND p_operating_date > v_tuev THEN
    v_sources := v_sources || 'tuev_expired';
  END IF;

  -- 3. The latest Werkstatt check on or before the operating date, in ONE pass
  --    over that car's checks and never by joining the table with itself.
  --    'negative' means found defective; 'repaired' clears it, which is what the
  --    word means on that screen.
  SELECT w.status INTO v_status
    FROM public.werkstatt_checks w
   WHERE w.car_id = p_car_id
     AND w.check_date <= p_operating_date
   ORDER BY w.check_date DESC, w.created_at DESC
   LIMIT 1;

  IF v_status = 'negative' THEN
    v_sources := v_sources || 'werkstatt_negative';
  END IF;

  IF array_length(v_sources, 1) IS NULL THEN
    RETURN QUERY SELECT 'available'::text, ARRAY[]::text[];
  ELSE
    RETURN QUERY SELECT 'unavailable'::text,
                        (SELECT array_agg(s ORDER BY s) FROM unnest(v_sources) AS s);
  END IF;
END;
$fn$;

COMMENT ON FUNCTION public.vehicle_availability_on(uuid, date, integer) IS
  'Whether one car may be on the road on one operating day, and every reason it '
  'may not. The operating day''s start hour is an argument with no default: this '
  'codebase has four cuts of operating day and none is authoritative '
  '(20261023130000).';

-- ─── 6. the read: a stored plan's conflicts ─────────────────────────────────

/*
  Every shift of a vehicle day plan whose vehicle is not available on its
  operating day, and every shift whose vehicle cannot be resolved at all.
  Available shifts are not returned: this is a conflict report, so a plan with
  nothing wrong answers no rows.

  **The operating day's start hour is read from the plan row** (rule 1) and from
  nowhere else — slice 1 stored `operating_day_start_hour` NOT NULL with no
  default for exactly this read. Self-check 9 fails a release in which this body
  stops naming that column or starts naming an hour literal.

  A shift's `vehicle` is matched against `cars.kennzeichen` as **exact text**, the
  way slice 1's own overlap check takes a vehicle: two spellings differing by a
  space are two vehicles. A plate that matches no car of the company is
  'unverifiable' with source 'vehicle_not_resolved', never available — a plan
  whose plates have drifted from the fleet table must say so rather than report a
  clean month.

  SECURITY INVOKER, like the function it calls: the caller's own policies on
  vehicle_day_plans, vehicle_day_shifts, cars, werkstatt_checks and
  vehicle_unavailability answer it, so a plan of another company returns no rows.
*/
CREATE OR REPLACE FUNCTION public.vehicle_day_plan_availability(p_plan_id uuid)
RETURNS TABLE (
  shift_id       uuid,
  operating_date date,
  vehicle        text,
  car_id         uuid,
  verdict        text,
  sources        text[]
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_hour    integer;
  v_company uuid;
BEGIN
  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'vehicle_day_plan_availability: a plan id is required'
      USING ERRCODE = '22023';
  END IF;

  -- The hour comes from the plan, never from a constant. A plan the caller
  -- cannot read answers no rows at all.
  SELECT p.operating_day_start_hour, p.company_id
    INTO v_hour, v_company
    FROM public.vehicle_day_plans p
   WHERE p.id = p_plan_id;

  IF v_hour IS NULL THEN
    RETURN;
  END IF;

  /*
    Every CTE column is named q_* so that none of the six OUT columns this
    function declares can be read as a variable reference instead — the rule the
    Werkstatt week-collision reader states for its own three. (The schema name of
    that reader is deliberately not written here: self-check 8 greps this body for
    it, and although the grep runs on a comment-stripped copy, prose that quotes
    the pattern a check forbids is the most dangerous text in a file.)

    `q_resolved` is MATERIALIZED, and that is load-bearing rather than tidy. The
    lateral call below must never be made for an unresolved plate: a NULL car is
    a broken argument contract and vehicle_availability_on raises 22023 on it, so
    an inlined CTE whose NOT NULL filter the planner was free to apply *after*
    the lateral would turn a drifted plate into an error for the whole plan. With
    the fence the filter is applied first, by construction.
  */
  RETURN QUERY
  WITH q_shifts AS MATERIALIZED (
    SELECT s.id             AS q_shift,
           s.operating_date AS q_date,
           s.vehicle        AS q_vehicle,
           s.shift_index    AS q_index,
           c.id             AS q_car
      FROM public.vehicle_day_shifts s
      -- Exact text, as the engine plans. kennzeichen is not unique per company
      -- in the schema, so DISTINCT would hide a duplicate plate; the join is
      -- left as it is and a doubled plate yields a row per car, which is the
      -- honest answer.
      LEFT JOIN public.cars c
             ON c.company_id  = v_company
            AND c.kennzeichen = s.vehicle
     WHERE s.plan_id = p_plan_id
  ),
  q_resolved AS MATERIALIZED (
    SELECT t.q_shift, t.q_date, t.q_vehicle, t.q_index, t.q_car
      FROM q_shifts t
     WHERE t.q_car IS NOT NULL
  ),
  q_all AS (
    SELECT t.q_shift, t.q_date, t.q_vehicle, t.q_index, t.q_car,
           'unverifiable'::text                        AS q_verdict,
           ARRAY['vehicle_not_resolved']::text[]        AS q_sources
      FROM q_shifts t
     WHERE t.q_car IS NULL
    UNION ALL
    SELECT r.q_shift, r.q_date, r.q_vehicle, r.q_index, r.q_car,
           a.verdict, a.sources
      FROM q_resolved r
      CROSS JOIN LATERAL public.vehicle_availability_on(r.q_car, r.q_date, v_hour) a
     WHERE a.verdict <> 'available'
  )
  SELECT q.q_shift, q.q_date, q.q_vehicle, q.q_car, q.q_verdict, q.q_sources
    FROM q_all q
   ORDER BY q.q_date, q.q_vehicle, q.q_index, q.q_shift;
END;
$fn$;

COMMENT ON FUNCTION public.vehicle_day_plan_availability(uuid) IS
  'Every shift of a vehicle day plan whose vehicle is unavailable or cannot be '
  'resolved. The operating day''s start hour is read from the plan row, never '
  'from a constant (20261023130000).';

-- ─── 7. ownership and privileges ────────────────────────────────────────────

-- CREATE OR REPLACE keeps whatever owner a function had, so the owner is stated.
ALTER FUNCTION app_private.vehicle_unavailability_guard()                      OWNER TO CURRENT_USER;
ALTER FUNCTION public.vehicle_availability_on(uuid, date, integer)             OWNER TO CURRENT_USER;
ALTER FUNCTION public.vehicle_day_plan_availability(uuid)                      OWNER TO CURRENT_USER;

-- Fired by a trigger, which does not check EXECUTE; the REVOKE is the second
-- wall behind the missing USAGE on app_private. PUBLIC as well as the three API
-- roles: EXECUTE to PUBLIC is a built-in default for every new function and
-- cannot be revoked per schema.
REVOKE ALL ON FUNCTION app_private.vehicle_unavailability_guard() FROM PUBLIC, anon, authenticated, service_role;

-- Both readers run as the caller, so only a signed-in caller gets them. anon has
-- no company and would read nothing; the service role answers no policy.
REVOKE ALL ON FUNCTION public.vehicle_availability_on(uuid, date, integer) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.vehicle_day_plan_availability(uuid)          FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.vehicle_availability_on(uuid, date, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.vehicle_day_plan_availability(uuid)          TO authenticated;

-- The same default grants every new table to anon, authenticated and
-- service_role. anon never reads this; no edge function does either.
REVOKE ALL ON TABLE public.vehicle_unavailability FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vehicle_unavailability TO authenticated;

-- ─── 8. self-check ──────────────────────────────────────────────────────────
--
-- What a release can be told from the catalogue and from the bodies of the
-- functions with their comments removed (app_private.function_code, which raises
-- for a signature that does not resolve, so a renamed function cannot make a
-- `!~` check below pass on NULL). The behaviour itself — every refusal, the
-- derivations, the DST days, the races — is tests/rls/vehicle-availability.sql.

DO $selfcheck$
DECLARE
  c_tbl    CONSTANT text := 'vehicle_unavailability';
  c_funcs  CONSTANT text[] := ARRAY['public.vehicle_availability_on(uuid,date,integer)',
                                    'public.vehicle_day_plan_availability(uuid)'];
  v_sig    text;
  v_src    text;
  v_wrong  text;
  v_count  int;
  v_role   text;
BEGIN
  -- 1. The table exists with row level security on.
  IF to_regclass(format('public.%I', c_tbl)) IS NULL THEN
    RAISE EXCEPTION 'vehicle availability self-check 1: public.% is missing', c_tbl;
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', c_tbl)::regclass) THEN
    RAISE EXCEPTION 'vehicle availability self-check 1: % has row level security off', c_tbl;
  END IF;

  -- 2. Exactly the four policies of 20260917130000's shape: each asking the
  --    active-company helper, each write asking the Fahrzeuge page, SELECT
  --    asking no role at all, and the UPDATE stating one predicate as USING and
  --    as WITH CHECK (which is what refuses a move to another company).
  SELECT string_agg(format('%s (%s)', p.policyname, p.cmd), ', ' ORDER BY p.policyname) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = c_tbl
     AND p.policyname NOT IN (c_tbl || '_select', c_tbl || '_insert',
                              c_tbl || '_update', c_tbl || '_delete');
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle availability self-check 2: % carries policies outside the four-policy shape: %', c_tbl, v_wrong;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = c_tbl;
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'vehicle availability self-check 2: % carries % of its 4 policies', c_tbl, v_count;
  END IF;

  -- Every policy asks the active-company helper, and no policy reads
  -- user_profiles or is_user_super_admin() (3.3's shape rules).
  SELECT string_agg(p.policyname, ', ' ORDER BY p.policyname) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = c_tbl
     AND coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') NOT LIKE '%get_active_company_id%';
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle availability self-check 2: policy/policies do not ask get_active_company_id(): %', v_wrong;
  END IF;

  SELECT string_agg(p.policyname, ', ' ORDER BY p.policyname) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = c_tbl
     AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')
            ~ '(is_user_super_admin|user_profiles)');
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle availability self-check 2: policy/policies read user_profiles or is_user_super_admin(): %', v_wrong;
  END IF;

  -- The three writes ask the Fahrzeuge page; SELECT asks no role.
  SELECT string_agg(format('%s (%s)', p.policyname, p.cmd), ', ' ORDER BY p.policyname) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = c_tbl
     AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE')
     AND coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')
           NOT LIKE '%current_role_permits(''cars''%';
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle availability self-check 2: write policy/policies do not ask the cars page: %', v_wrong;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = c_tbl AND p.cmd = 'SELECT'
       AND coalesce(p.qual, '') LIKE '%current_role_permits%'
  ) THEN
    RAISE EXCEPTION 'vehicle availability self-check 2: the SELECT policy is role-gated; 3.3''s shape has no role term there';
  END IF;

  -- The UPDATE states its predicate twice.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = c_tbl AND p.cmd = 'UPDATE'
       AND p.qual IS NOT NULL AND p.with_check IS NOT NULL
       AND p.with_check LIKE '%get_active_company_id%'
       AND p.with_check LIKE '%current_role_permits(''cars''%'
  ) THEN
    RAISE EXCEPTION 'vehicle availability self-check 2: the UPDATE policy does not repeat its predicate as WITH CHECK — a move between companies would be allowed';
  END IF;

  -- 3. Both context triggers, derived from the policies naming
  --    get_active_company_id() and not from who writes the table today.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger g
     WHERE g.tgrelid = format('public.%I', c_tbl)::regclass
       AND NOT g.tgisinternal
       AND g.tgname = 'refuse_read_only_context_write'
       AND g.tgfoid = 'app_private.refuse_read_only_context_write()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'vehicle availability self-check 3: % has no refuse_read_only_context_write trigger — a view context would write it', c_tbl;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger g
     WHERE g.tgrelid = format('public.%I', c_tbl)::regclass
       AND NOT g.tgisinternal
       AND g.tgname = 'record_support_write'
       AND g.tgfoid = 'app_private.record_support_write()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'vehicle availability self-check 3: % has no record_support_write trigger — a support session''s rows would go unrecorded', c_tbl;
  END IF;

  -- 4. The car belongs to the company, as a foreign key over the pair, and the
  --    unique constraint it needs is on cars. A policy cannot do this: it sees
  --    company_id only.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = format('public.%I', c_tbl)::regclass
       AND conname  = 'vehicle_unavailability_car_of_company'
       AND contype  = 'f'
       AND confrelid = 'public.cars'::regclass
       AND array_length(conkey, 1) = 2
  ) THEN
    RAISE EXCEPTION 'vehicle availability self-check 4: the composite foreign key to cars (id, company_id) is missing — another company''s car would pass every policy';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.cars'::regclass
       AND conname  = 'cars_id_company_key'
       AND contype  = 'u'
  ) THEN
    RAISE EXCEPTION 'vehicle availability self-check 4: cars_id_company_key is missing — the composite foreign key cannot exist without it';
  END IF;

  -- 5. The window cannot end before it starts, and the reason is the closed
  --    list. Constraints, not comments.
  FOREACH v_wrong IN ARRAY ARRAY['vehicle_unavailability_window_ordered',
                                 'vehicle_unavailability_reason_known',
                                 'vehicle_unavailability_note_bounded'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = format('public.%I', c_tbl)::regclass
         AND conname = v_wrong AND contype = 'c'
    ) THEN
      RAISE EXCEPTION 'vehicle availability self-check 5: the % check constraint is missing', v_wrong;
    END IF;
  END LOOP;

  -- The reason list is exactly the five words, so a sixth cannot be added
  -- without this file being read.
  SELECT pg_get_constraintdef(oid) INTO v_src
    FROM pg_constraint
   WHERE conrelid = format('public.%I', c_tbl)::regclass
     AND conname = 'vehicle_unavailability_reason_known';
  FOREACH v_wrong IN ARRAY ARRAY['workshop', 'accident', 'breakdown', 'inspection', 'other'] LOOP
    IF strpos(v_src, v_wrong) = 0 THEN
      RAISE EXCEPTION 'vehicle availability self-check 5: the reason list no longer admits %: %', v_wrong, v_src;
    END IF;
  END LOOP;

  -- 6. No CHECK constraint on this table names app_private: a CHECK is evaluated
  --    as the writing role, and authenticated holds no USAGE there, so one would
  --    let the owner insert and give every client 42501.
  SELECT string_agg(conname, ', ' ORDER BY conname) INTO v_wrong
    FROM pg_constraint
   WHERE conrelid = format('public.%I', c_tbl)::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%app_private.%';
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle availability self-check 6: check constraint(s) name app_private, which every client would be refused on: %', v_wrong;
  END IF;

  -- 7. No driver, no ride, no address, no fare — slice 1's rule 2, for the same
  --    reason: a driver belongs to the month-end assignment.
  SELECT string_agg(attname, ', ' ORDER BY attname) INTO v_wrong
    FROM pg_attribute
   WHERE attrelid = format('public.%I', c_tbl)::regclass
     AND attnum > 0 AND NOT attisdropped
     AND attname ~ '(driver|fahrer|ride|fahrt|trip|address|adresse|fare|amount|revenue|tip|trinkgeld)';
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle availability self-check 7: % carries column(s) named like a driver, a ride, an address or a fare: %', c_tbl, v_wrong;
  END IF;

  -- 8. Both readers are SECURITY INVOKER plpgsql with a pinned search_path, and
  --    NEITHER names app_private: they run as the caller, authenticated holds no
  --    USAGE there, and a caught insufficient_privilege becomes a silent
  --    "Keine Berechtigung" (PR #117). matrix.sql cannot report this.
  FOREACH v_sig IN ARRAY c_funcs LOOP
    IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_sig::regprocedure) THEN
      RAISE EXCEPTION 'vehicle availability self-check 8: % became SECURITY DEFINER; it reads tenant tables under the caller''s own policies and must stay INVOKER', v_sig;
    END IF;

    IF (SELECT l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
         WHERE p.oid = v_sig::regprocedure) <> 'plpgsql' THEN
      RAISE EXCEPTION 'vehicle availability self-check 8: % is not LANGUAGE plpgsql; an inlinable sql function''s EXECUTE check is folded away by the planner', v_sig;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = v_sig::regprocedure
         AND p.proconfig IS NOT NULL
         AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search\_path=%')
    ) THEN
      RAISE EXCEPTION 'vehicle availability self-check 8: % has no pinned search_path', v_sig;
    END IF;

    v_src := app_private.function_code(v_sig);

    IF v_src LIKE '%app_private.%' THEN
      RAISE EXCEPTION 'vehicle availability self-check 8: % names app_private; as a SECURITY INVOKER function it would raise 42501 for every client', v_sig;
    END IF;

    -- 10. and it does not read cars.status, whose domain is exactly
    --     active/inactive and holds no out-of-service value (see the header).
    IF v_src ~ '\mstatus\M' AND v_src LIKE '%cars%' AND v_src ~ 'c\.status|cars\.status' THEN
      RAISE EXCEPTION 'vehicle availability self-check 10: % reads cars.status, which admits only active and inactive and carries no out-of-service state', v_sig;
    END IF;
  END LOOP;

  -- 9. The plan-scoped reader takes the operating day's start hour FROM THE PLAN
  --    ROW and never from a constant. This is rule 1, and it is the one property
  --    of this slice that a plausible edit would silently lose.
  v_src := app_private.function_code('public.vehicle_day_plan_availability(uuid)');

  IF v_src NOT LIKE '%operating_day_start_hour%' THEN
    RAISE EXCEPTION 'vehicle availability self-check 9: vehicle_day_plan_availability no longer reads operating_day_start_hour — it would be assuming one of this codebase''s four cuts of operating day';
  END IF;

  IF v_src NOT LIKE '%vehicle_day_plans%' THEN
    RAISE EXCEPTION 'vehicle availability self-check 9: vehicle_day_plan_availability no longer reads the plan row, so the hour cannot be coming from it';
  END IF;

  -- An hour literal handed to make_interval, or a bare 4 or 0 as the third
  -- argument of the core reader, is the re-derivation this slice refuses.
  IF v_src ~ 'make_interval\s*\(\s*hours\s*=>\s*\d' THEN
    RAISE EXCEPTION 'vehicle_day_plan_availability names an hour literal: the hour must come from the plan row';
  END IF;

  IF v_src ~ 'vehicle_availability_on\s*\([^)]*,\s*\d+\s*\)' THEN
    RAISE EXCEPTION 'vehicle availability self-check 9: vehicle_day_plan_availability passes a literal hour to vehicle_availability_on';
  END IF;

  -- And the core reader states no default for the hour, so a caller cannot omit
  -- it. pg_proc.pronargdefaults is 0 when no argument has a default.
  IF (SELECT p.pronargdefaults FROM pg_proc p
       WHERE p.oid = 'public.vehicle_availability_on(uuid,date,integer)'::regprocedure) <> 0 THEN
    RAISE EXCEPTION 'vehicle availability self-check 9: vehicle_availability_on gained a default argument; a default operating-day hour is the re-derivation in disguise';
  END IF;

  -- 11. Privileges. anon and the service role hold nothing anywhere here, and
  --     PUBLIC holds no default grant on the guard.
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      IF has_table_privilege(v_role::name, format('public.%I', c_tbl),
                             'SELECT, INSERT, UPDATE, DELETE') THEN
        RAISE EXCEPTION 'vehicle availability self-check 11: % holds a privilege on %', v_role, c_tbl;
      END IF;
      FOREACH v_sig IN ARRAY c_funcs LOOP
        IF has_function_privilege(v_role::name, v_sig::regprocedure, 'EXECUTE') THEN
          RAISE EXCEPTION 'vehicle availability self-check 11: % may execute %', v_role, v_sig;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH v_wrong IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('authenticated', format('public.%I', c_tbl), v_wrong) THEN
        RAISE EXCEPTION 'vehicle availability self-check 11: authenticated lacks % on %', v_wrong, c_tbl;
      END IF;
    END LOOP;
    FOREACH v_sig IN ARRAY c_funcs LOOP
      IF NOT has_function_privilege('authenticated', v_sig::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION 'vehicle availability self-check 11: authenticated cannot execute %', v_sig;
      END IF;
    END LOOP;
  END IF;

  -- The guard is reachable by no API role, and PUBLIC holds no default EXECUTE.
  -- A NULL acl is not "nothing granted": it is the built-in default, which
  -- grants EXECUTE to PUBLIC — the state a plain DROP + CREATE would restore.
  IF (SELECT p.proacl IS NULL FROM pg_proc p
       WHERE p.oid = 'app_private.vehicle_unavailability_guard()'::regprocedure)
     OR EXISTS (
       SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
        WHERE p.oid = 'app_private.vehicle_unavailability_guard()'::regprocedure
          AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'vehicle availability self-check 11: PUBLIC may execute the unavailability guard';
  END IF;

  -- 12. The guard pins the company and the car, for the reason
  --     pin_billing_company_id exists: a WITH CHECK sees only the new row.
  v_src := app_private.function_code('app_private.vehicle_unavailability_guard()');
  IF v_src NOT LIKE '%vehicle_unavailability_company_pinned%'
     OR v_src NOT LIKE '%vehicle_unavailability_car_pinned%' THEN
    RAISE EXCEPTION 'vehicle availability self-check 12: the guard no longer pins both the company and the car; an UPDATE could re-attribute a window';
  END IF;

  -- 13. And the pure arithmetic actually holds, run on literals. Hour 4 on
  --     25.10.2026 (a 25-hour local day) and on 29.03.2026 (a 23-hour one) is
  --     one operating day each: the boundaries are wall clock built from the
  --     calendar, so both are exactly 24 wall-clock hours apart.
  IF (DATE '2026-10-26'::timestamp + make_interval(hours => 4))
     - (DATE '2026-10-25'::timestamp + make_interval(hours => 4)) <> interval '24 hours' THEN
    RAISE EXCEPTION 'vehicle availability self-check 13: the 25-hour DST day is not one wall-clock operating day';
  END IF;
  IF (DATE '2026-03-30'::timestamp + make_interval(hours => 4))
     - (DATE '2026-03-29'::timestamp + make_interval(hours => 4)) <> interval '24 hours' THEN
    RAISE EXCEPTION 'vehicle availability self-check 13: the 23-hour DST day is not one wall-clock operating day';
  END IF;

  RAISE NOTICE 'vehicle availability self-check: passed — one window table on the cars page, both context triggers, the car pinned to its company by a foreign key, and the operating day''s hour read from the plan row';
END
$selfcheck$;
