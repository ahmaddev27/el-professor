/*
  # Driver month assignments: the month-end record of who drove, and the gate
  # that keeps it from being written too early

  The owner's governing constraint (22.10.2026), in his own words: planning is
  daily and per vehicle, and assigning DRIVERS happens at the end of the month,
  because a driver may pick up a fine, have an accident, meet something on the
  road or take leave in the course of it, so his hours cannot be committed in
  advance.

  20261022140000 built the first half: vehicle_day_plans and vehicle_day_shifts
  are the forward plan per vehicle and operating day, and rule 2 of that file
  says there is no driver column anywhere in them, not nullable and not "for
  later" -- absent, because the driver belongs to the month-end assignment,
  "which is a different slice and a different table". This file is that table.

  ── WHAT WAS INVERTED, AND WHAT THIS FIXES ───────────────────────────────────

  Everything downstream of the import treats ONE TRIP as the unit of assignment.
  monatsplanungPhase4.ts emits one ChangeRow per trip; phase 5 batch-updates the
  trips one RPC call at a time; fahrtenbuch_trips carries assigned_driver_id and
  assigned_driver_name per row, and 32 of its 48 columns are immutable by
  trigger, so a driver's month exists only as a few dozen scattered column
  values. A single mid-month accident therefore has to move dozens of rows, and
  nothing anywhere says "these are the hours this driver is committed to" or
  "this driver was released from this month". There is no month-end step, no
  gate, no flag and no column that defers or closes driver assignment.

  So the unit is wrong, and this file introduces the right one BESIDE the
  pipeline rather than inside it:

      one row per driver per month, which an incident moves in one statement.

  WHAT THIS FILE DELIBERATELY DOES NOT TOUCH, and the reason is a standing rule
  of this codebase rather than caution: phase 1, phase 3, phase 4, the repair
  pass, the finalization checks, computeLohnartSeconds and every document
  builder are unchanged, not read and not referenced. That code encodes
  statutory German payroll rules more intricate than its shape suggests, has
  almost no test coverage, and produces documents that go to a Steuerberater; a
  plausible-looking refactor can silently corrupt someone's payroll. A new table
  beside the pipeline is reversible. Rewiring the pipeline onto this record is a
  later slice, and it needs a before/after comparison on a real month on
  staging. Self-check 9 reads the catalogue and fails a release in which a column
  or a function of this file names a trip, a ride, an address or a fare, so the
  boundary is a gate and not a promise.

  ── 1. WHAT THE RECORD HOLDS, AND WHY EACH PART IS THERE ─────────────────────

  public.driver_month_assignments, one row per driver per month:

    company_id, year, month, driver_id   the key the brief names, and the unit
                                         an incident moves.
    plan_id                              WHICH vehicle day plan the assignment
                                         was made against. Not derivable after a
                                         release, because a release deletes the
                                         child rows (below), and a record that
                                         cannot say what it stood for is not a
                                         record. NOT NULL.
    status                               draft / assigned / released. The
                                         lifecycle is 20261022140000's and
                                         20260930100000's, one word per state
                                         and the transitions through RPCs alone.
    assigned_shift_count                 THE HOURS, as four figures the database
    assigned_minutes                     computes from the rows it was given and
    assigned_vehicle_count               writes over anything a client sent:
    assigned_day_count                   how many windows, how many wall-clock
                                         minutes, over how many vehicles and how
                                         many operating days. These are the
                                         "ساعات" the owner says cannot be
                                         committed in advance, and they are what
                                         survives a release.
    opened_early, early_reason,          the gate's record (section 2).
    early_days_remaining
    release_reason, release_note,        why the hours were withdrawn, and when
    released_at, released_by             and by whom.
    assigned_at, assigned_by             who committed the hours and when.
    created_by / created_at,             the ordinary provenance of a row.
    updated_by / updated_at

  public.driver_month_assignment_shifts, the child: one row per vehicle_day_shifts
  window the driver holds, with the window's minutes copied so the parent's total
  is auditable against its own parts. The child exists for two reasons that a
  number alone cannot serve:

    · a month that says only "97 hours" cannot be read back into anything, and
      cannot be compared with what the vehicle plan said;
    · "a vehicle window has at most one driver" is a physical rule, and with the
      child it is a UNIQUE constraint rather than a sentence in a comment
      (driver_month_assignment_shifts_one_claim_per_shift). A release DELETES the
      children, so that one constraint means "one LIVE claim per window" with no
      status column to drift, and the window is free for the next driver the
      moment the first is released. The parent keeps the figures, so what he held
      is still on the record after the rows are gone.

  WHAT IS NOT IN EITHER TABLE. No ride, no address, no fare, no tip, no
  coordinate and no foreign key to fahrtenbuch_trips -- the assignment records
  hours against PLANNED windows and never touches recorded trips. And no
  free-form JSON at all: the figures are typed integer columns with CHECK
  constraints, so 20261022140000's rule 2 (a closed object of numbers, enforced
  by a validator function) is satisfied here by construction and needs no
  validator. The only free text is early_reason and release_note, both trimmed,
  both bounded to 500 characters, and both audit prose in the sense
  COMPANY_WRITE_SESSION_REASONS and monthly_planning_manual_exceptions.reason
  already are: deliberately untranslated, because a second consumer reads them.

  ── 2. THE MONTH-END GATE, AND WHICH CLOCK IT READS ──────────────────────────

  Assignment does not open until the month's last day has passed. The clock is
  Europe/Berlin and nothing else:

      app_private.driver_month_assignment_days_remaining(year, month)
        = greatest((first day of the following month) - (today in Europe/Berlin), 0)

  so 0 means the month is over and assignment is open, and any positive number is
  how many days are still to come before it opens. Europe/Berlin is a hard
  constant in some fifteen modules of this codebase and vitest.config.ts pins
  TZ=Europe/Berlin for the payroll golden masters; there is no per-company
  timezone and this file does not introduce one. The function is STABLE and not
  IMMUTABLE, because it reads now(), which is also why the gate CANNOT be a CHECK
  constraint and has to be the guard.

  ONE FUNCTION, ONE CLOCK, AND THE GUARD DECIDES. The helper is the only place
  the rule is computed. The guard asks it on every INSERT and refuses; the save
  RPC asks the same helper beforehand only so it can REFUSE BY RETURN VALUE with
  the number of days still to run, which is what lets a screen offer "open it
  anyway, and say why" instead of showing a raw error. The guard is the wall: a
  second caller writing the table directly meets exactly the same question,
  which is the whole reason the rule is here and not in TypeScript.

  WHAT THE GATE DOES WHEN IT IS OPENED EARLY. It is allowed, and it is never
  silent:

    · a row inserted while days_remaining > 0 must carry early_reason, or it is
      refused with the hint driver_month_assignment_month_not_ended;
    · when it carries one, the database -- not the caller -- sets
      opened_early = true and stamps early_days_remaining with the number IT
      measured, so the record says how early it was, not how early the caller
      claimed it was;
    · a row inserted once the month is over gets opened_early = false and all
      three early columns cleared, whatever was sent, because there was nothing
      early about it;
    · opened_early, early_reason and early_days_remaining are part of the row's
      fixed key afterwards: the guard refuses an UPDATE that touches any of them,
      so the warning cannot be erased after the fact.

  AND THE PAIRING IS A CONSTRAINT, not a convention:

      CHECK (opened_early = (early_reason IS NOT NULL)
         AND opened_early = (early_days_remaining IS NOT NULL))

  "Opened early" is true if and only if a reason and a measured shortfall stand
  beside it. That is the half of the rule a CHECK can carry, and it is carried
  there rather than in a function, because a rule enforced in one function is
  lost silently by the next writer (20261008140000's receipts_document_prefix is
  the shape; 20261022140000 made the operating-day hour, the slot length and the
  algorithm version NOT NULL with no default for the same reason).

  THE GATE IS ON OPENING, AND ON NOTHING ELSE. Committing, releasing and
  deleting are never gated by the clock: the incident the owner describes --
  a fine, an accident, something on the road, leave -- happens INSIDE the month,
  and a gate on the release would be a gate on the one act the whole design
  exists to make cheap. The child rows are not gated either: a child needs a
  parent that exists and is still a draft, and that parent already passed the
  gate.

  ── 3. WHAT THE DATABASE RE-DERIVES, AND WHAT IT LEAVES TO THE SCREEN ────────

  The guards check what follows from the stored rows alone: the plan belongs to
  the same company and names the same year and month; the driver belongs to the
  same company; a child's window belongs to the parent's plan and company and
  its copied minutes equal the window's own. driver_month_assignment_commit
  re-derives the one physical rule a stored assignment can break by itself:
  A DRIVER IS NEVER IN TWO PLACES AT ONCE. His windows are compared in one pass
  over his own rows in start order, never by joining a table with itself -- the
  cost 20261022140000 measured is the reason (a self-join over 12,400 shifts did
  not finish inside the API roles' 8 s statement timeout, while the single pass
  gives the same answer).

  What is NOT re-derived, and is the screen's or the engine's: whether a driver
  may legally work those hours (§3b EStG, §4 ArbZG, the Lohnart buckets), what a
  break between two windows must be, and whether the driver's status in the
  fleet table admits him. Copying any of that here would leave two places to
  change and one to forget, and the payroll half of it is exactly the code this
  slice is forbidden to touch.

  THE PLAN'S STATUS IS THE RPC'S QUESTION, NOT THE GUARD'S, and this is the one
  place the two walls differ on purpose. The guard requires the plan to match the
  company and the month; it does not require it to be CONFIRMED. The save RPC
  does (reason no_confirmed_plan), and the commit RPC re-asks it under the lock
  (reason plan_not_active), so the product never builds an assignment on a
  proposal. Putting "confirmed" in the guard would have frozen the link to a
  plan's transient state and made the tenancy probe in tests/rls/matrix.sql need
  a confirmed plan, whose own U and D cells are T for everybody -- it would have
  made the tenancy measurement harder without making the record safer, because
  20261022140000 already freezes a confirmed plan's shifts, so a committed
  assignment's windows are immutable by that file's guard and not by this one's.

  ── 4. LOCKS, MARKERS AND CASCADES ───────────────────────────────────────────

  The child guard reads its parent FOR KEY SHARE, which conflicts with the
  FOR UPDATE the commit takes, so a child written while a commit is under way and
  the commit itself take turns in either order; read without a lock the answer
  "draft" was stale the moment it was given. A parent about to be written is read
  FOR UPDATE by the RPC that writes it. Never FOR UPDATE in the child guard: a
  child's foreign key check already holds a key share on the parent, and
  FOR UPDATE there deadlocks two concurrent writes -- the cost
  confirm_salary_cash_payment paid for real.

  Two transaction-local markers, each naming its row and its transaction:

    app_private.driver_month_assignment_transition   status, the stamps, the
                                                     figures and the release
                                                     fields move only while it is
                                                     held, which is to say only
                                                     inside commit or release.
    app_private.driver_month_assignment_withdrawal   the child rows of exactly
                                                     one assignment may be
                                                     deleted although its parent
                                                     has left the draft state --
                                                     which is what a release is.

  They are separate on purpose: one marker for both would let a commit, which
  deletes nothing, also open the child table.

  CASCADES ARE SOMEBODY ELSE'S BUSINESS AND THE FREEZE STANDS ASIDE FOR THEM.
  20261016140000 found, by deleting a company that had done real work, that the
  monthly plan's guards refused the company's own cascade; 20261022140000 carried
  the correction from the start and so does this file, widened to the three rows
  an assignment hangs from. A delete of a non-draft assignment is refused while
  its company, its driver AND its plan all still exist, and allowed when any of
  them is gone, because by the time a cascade reaches a child the parent row is
  already deleted. The child's own guard stands aside the same way for the parent
  and for the vehicle_day_shifts row. tests/rls/driver-month-assignments.sql
  deletes a company and a driver that hold a committed assignment to prove it.

  Driver deletion is worth stating plainly, because it is a cascade and not a
  refusal: deleting a driver destroys his assignments, as it already destroys his
  salaries, salary_payments, salary_cash_receipts and saved_stundennachweise
  (tests/rls/driver-deletion.sql section 1, which also records that the Fahrer
  screen's trash button is a bare delete with no confirmation step). This file
  adds no new reason for a driver delete to fail; it would have, with
  ON DELETE RESTRICT, and that is a change to an existing screen's behaviour and
  not this slice's to make.

  ── 5. ACCESS, AND WHY THE PAGE IS documents ─────────────────────────────────

    SELECT   company_id = (SELECT get_active_company_id())
             OR (SELECT platform_reads_company_data())
    INSERT   (company_id = (SELECT get_active_company_id())
              AND (SELECT current_role_permits('documents', true)))
             OR (SELECT platform_writes_company_data())
    UPDATE   the same, as USING and as WITH CHECK
    DELETE   the same

  documents is the page the standard monthly plan, /monatsplan and
  20261022140000's two tables already ask for, and the month-end assignment is
  the second half of that same route's work. A role that may confirm a month's
  vehicle plan may assign its drivers; is_company_admin() would have made the two
  halves of one workflow answer differently for the same person. No page_key was
  created and no role_permissions row written: the Rollen screen saves a role by
  deleting its rows and re-inserting one per key in PAGE_DEFINITIONS, so a key
  that screen does not know is dropped the first time anyone edits the role. The
  seeded roles keep their meaning -- a viewer holds can_edit on no page and an
  editor holds none on documents, so an administrator or a supervisor assigns.

  Both tables carry both context triggers, derived from the policies naming
  get_active_company_id() and not from who writes them today:
  refuse_read_only_context_write (a view context writes nothing) and
  record_support_write (every row a support session writes leaves one audit row).
  tests/rls/platform-contexts.sql section 14 and
  tests/rls/support-write-audit.sql section 1 fail a table carrying one without
  the other. The first version of 20260924100000 reasoned "no client writes it,
  so neither is needed" and the kit refused it.

  anon holds nothing. authenticated holds SELECT, INSERT, UPDATE and DELETE and
  nothing else. The service role holds nothing, on the tables and on all three
  RPCs: every one of them reads auth.uid() and the service key carries no
  subject.

  ── 6. COMPATIBILITY: this does NOT bump deploy/SCHEMA_EPOCH ─────────────────

  Two new tables, two trigger functions, two helpers, three new RPCs. Nothing
  existing is altered -- no column, no policy, no function and no trigger of any
  other table -- so the previous release runs unchanged beside them and never
  reads them. Company deletion needs no edit: app_private.company_deletion_tables()
  reads the catalogue for a company_id column, and both tables cascade from
  companies.

  tests/rls/driver-month-assignments.sql is this file's kit, and
  tests/rls/matrix.sql carries both tables' lines plus the EXECUTE grant of the
  three RPCs -- only the grant, because all three change state and the matrix
  runs one probe per principal against one fixture. Their authorization is probed
  per principal in the kit file, each call in its own transaction.
*/

-- ─── 1. the assignment ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.driver_month_assignments (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  year                   integer     NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month                  integer     NOT NULL CHECK (month BETWEEN 1 AND 12),
  -- The driver whose hours this row commits. The point of the table, and the
  -- reason 20261022140000 has no such column.
  driver_id              uuid        NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  -- Which vehicle day plan the assignment was made against. NOT NULL: a release
  -- deletes the child rows, so without this column a released row could not say
  -- what it stood for.
  plan_id                uuid        NOT NULL REFERENCES public.vehicle_day_plans(id) ON DELETE CASCADE,
  status                 text        NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'assigned', 'released')),
  -- THE HOURS. Written by the save RPC from the rows it was given and re-derived
  -- by the commit from the children, over anything a client sent.
  assigned_shift_count   integer     NOT NULL DEFAULT 0,
  assigned_minutes       integer     NOT NULL DEFAULT 0,
  assigned_vehicle_count integer     NOT NULL DEFAULT 0,
  assigned_day_count     integer     NOT NULL DEFAULT 0,
  -- The gate's record (section 2 of the header). All three are the database's,
  -- never the caller's, and all three are fixed once the row exists.
  opened_early           boolean     NOT NULL DEFAULT false,
  early_reason           text        NULL,
  early_days_remaining   integer     NULL,
  assigned_at            timestamptz NULL,
  assigned_by            uuid        NULL,
  release_reason         text        NULL,
  release_note           text        NULL,
  released_at            timestamptz NULL,
  released_by            uuid        NULL,
  created_by             uuid        NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid        NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- The gate, as the half of it a CHECK can carry: "opened early" is true if and
  -- only if a reason and the shortfall the database measured stand beside it, so
  -- a row cannot be opened early silently. The clock half is the guard's, because
  -- a CHECK may not read now().
  CONSTRAINT driver_month_assignments_early_recorded
    CHECK (opened_early = (early_reason IS NOT NULL)
       AND opened_early = (early_days_remaining IS NOT NULL)),
  CONSTRAINT driver_month_assignments_early_reason_bounded
    CHECK (early_reason IS NULL
       OR (early_reason = btrim(early_reason) AND char_length(early_reason) BETWEEN 3 AND 500)),
  CONSTRAINT driver_month_assignments_early_days_positive
    CHECK (early_days_remaining IS NULL OR early_days_remaining > 0),
  -- The stamps follow the status. No pairing of an actor with its timestamp:
  -- created_by is nullable for the reason every table here has one -- a
  -- migration, psql or a host script carries no session and leaves no actor --
  -- and pairing would refuse such a path instead of recording it honestly.
  CONSTRAINT driver_month_assignments_status_matches_stamps
    CHECK ((status = 'draft'    AND assigned_at IS NULL     AND released_at IS NULL)
        OR (status = 'assigned' AND assigned_at IS NOT NULL AND released_at IS NULL)
        OR (status = 'released' AND released_at IS NOT NULL)),
  -- Why the hours were withdrawn: the owner's own four reasons plus 'other',
  -- and THIS CONSTRAINT IS THE ONLY PLACE THE LIST LIVES. The release RPC does
  -- not restate it, so the two cannot drift; an unknown code is reported as this
  -- constraint's name.
  CONSTRAINT driver_month_assignments_release_recorded
    CHECK ((status = 'released') = (release_reason IS NOT NULL)),
  CONSTRAINT driver_month_assignments_release_reason_known
    CHECK (release_reason IS NULL
       OR release_reason IN ('fine', 'accident', 'roadside_incident', 'leave', 'other')),
  CONSTRAINT driver_month_assignments_release_note_bounded
    CHECK (release_note IS NULL
       OR (release_note = btrim(release_note) AND char_length(release_note) BETWEEN 3 AND 500)),
  -- 'other' says nothing on its own, so it has to be written out.
  CONSTRAINT driver_month_assignments_release_note_required_for_other
    CHECK (release_reason IS DISTINCT FROM 'other' OR release_note IS NOT NULL),
  CONSTRAINT driver_month_assignments_figures_not_negative
    CHECK (assigned_shift_count >= 0 AND assigned_minutes >= 0
       AND assigned_vehicle_count >= 0 AND assigned_day_count >= 0),
  -- A window always has minutes, and a window has one vehicle on one operating
  -- day, so the three counts cannot exceed the number of windows and no windows
  -- means no minutes.
  CONSTRAINT driver_month_assignments_figures_agree
    CHECK ((assigned_shift_count = 0) = (assigned_minutes = 0)
       AND assigned_vehicle_count <= assigned_shift_count
       AND assigned_day_count     <= assigned_shift_count)
);

COMMENT ON TABLE public.driver_month_assignments IS
  'One driver''s committed hours for one month of a company, assigned at the end '
  'of that month against a confirmed vehicle day plan. The unit an incident '
  'moves: a fine, an accident, something on the road or leave releases this one '
  'row instead of dozens of trip rows. It holds no ride, address or fare '
  '(20261023120000).';

COMMENT ON COLUMN public.driver_month_assignments.opened_early IS
  'True when the row was written before the month''s last day had passed in '
  'Europe/Berlin. Set by app_private.driver_month_assignment_guard from the '
  'clock, never by a caller, and fixed afterwards: the warning cannot be erased. '
  '(20261023120000)';

COMMENT ON COLUMN public.driver_month_assignments.early_days_remaining IS
  'How many Europe/Berlin days were still to run before assignment would have '
  'opened, as the database measured it at the moment the row was written. NULL '
  'when the month had already ended. (20261023120000)';

COMMENT ON COLUMN public.driver_month_assignments.assigned_minutes IS
  'The wall-clock minutes of the vehicle windows this row commits, summed by the '
  'database from the rows it was given. Kept when a release deletes the child '
  'rows, so what the driver held is still on the record. (20261023120000)';

COMMENT ON COLUMN public.driver_month_assignments.release_reason IS
  'Why the hours were withdrawn: fine, accident, roadside_incident, leave or '
  'other. Audit data, deliberately untranslated, and the closed list lives in '
  'driver_month_assignments_release_reason_known and nowhere else. '
  '(20261023120000)';

-- One LIVE assignment per driver per month, in the database and not only in the
-- screen. A release is history and does not block the next one: a driver who had
-- an accident in the first week and came back in the third gets a second row,
-- and the first one keeps its figures and its reason. That is the one refinement
-- of the (company, year, month, driver) key, and it is here rather than in a
-- function for the reason the header gives.
CREATE UNIQUE INDEX IF NOT EXISTS driver_month_assignments_one_live_per_driver
  ON public.driver_month_assignments (company_id, year, month, driver_id)
  WHERE status <> 'released';

-- The screen's read: one company's months, newest first.
CREATE INDEX IF NOT EXISTS driver_month_assignments_company_period_idx
  ON public.driver_month_assignments (company_id, year DESC, month DESC, status);

-- The guards and the RPCs reach a plan's and a driver's assignments.
CREATE INDEX IF NOT EXISTS driver_month_assignments_plan_idx
  ON public.driver_month_assignments (plan_id);
CREATE INDEX IF NOT EXISTS driver_month_assignments_driver_idx
  ON public.driver_month_assignments (driver_id, year DESC, month DESC);

-- ─── 2. the windows it stands for ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.driver_month_assignment_shifts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  assignment_id uuid        NOT NULL REFERENCES public.driver_month_assignments(id) ON DELETE CASCADE,
  -- The planned window the driver holds. A window of the vehicle day plan, never
  -- a recorded trip: there is no foreign key to fahrtenbuch_trips here and
  -- self-check 9 fails a release that adds one.
  shift_id      uuid        NOT NULL REFERENCES public.vehicle_day_shifts(id) ON DELETE CASCADE,
  -- The window's own wall-clock length, copied so the parent's total is
  -- auditable against its parts. The guard refuses a value the window does not
  -- have.
  minutes       integer     NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- A vehicle window has at most one driver. A release deletes these rows, so
  -- this one constraint means "one LIVE claim per window" and there is no status
  -- column here to drift from the parent's.
  CONSTRAINT driver_month_assignment_shifts_one_claim_per_shift UNIQUE (shift_id),
  CONSTRAINT driver_month_assignment_shifts_minutes_positive CHECK (minutes > 0)
);

COMMENT ON TABLE public.driver_month_assignment_shifts IS
  'One planned vehicle window a driver holds for a month. Frozen once its '
  'assignment is committed, and deleted when the assignment is released, which '
  'is what frees the window for another driver (20261023120000).';

COMMENT ON COLUMN public.driver_month_assignment_shifts.minutes IS
  'The window''s own wall-clock length, copied from vehicle_day_shifts so the '
  'parent''s total can be audited against its parts. The guard refuses any other '
  'value. (20261023120000)';

CREATE INDEX IF NOT EXISTS driver_month_assignment_shifts_company_idx
  ON public.driver_month_assignment_shifts (company_id);

-- The commit's single pass over one driver's windows, and the parent's own read.
CREATE INDEX IF NOT EXISTS driver_month_assignment_shifts_assignment_idx
  ON public.driver_month_assignment_shifts (assignment_id, shift_id);

-- ─── 3. the clock ───────────────────────────────────────────────────────────

/*
  The month-end gate's one and only clock. 0 means the month's last day has
  passed and assignment is open; a positive number is how many Europe/Berlin days
  are still to run before it opens.

  Europe/Berlin is written here and in no second place. The codebase has it as a
  hard constant in some fifteen modules and vitest.config.ts pins
  TZ=Europe/Berlin so the payroll golden masters mean anything; there is no
  per-company timezone and this file does not invent one. `date - date` is a
  count of days, so the answer never depends on the hour of the day or on which
  side of a DST change the two dates fall -- what is compared is two calendar
  dates in one zone.

  STABLE, not IMMUTABLE, because it reads now(). That is exactly why the gate
  cannot be a CHECK constraint: PostgreSQL evaluates a CHECK with no promise
  about when, and a rule that may be re-evaluated is not allowed to move. The
  CHECK carries the half that does not read the clock (the pairing of
  opened_early with its reason and its measured shortfall) and the guard carries
  this half.

  SECURITY DEFINER and in app_private like every helper here, so no caller can
  reach it: the guard and the save RPC, both SECURITY DEFINER themselves, are its
  only callers. Nothing on a caller's own path names app_private -- authenticated
  holds no USAGE there, and a SECURITY INVOKER function or trigger that named it
  would die 42501 (PR #117).
*/
CREATE OR REPLACE FUNCTION app_private.driver_month_assignment_days_remaining(p_year integer,
                                                                             p_month integer)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_today      date;
  v_month_over date;
BEGIN
  IF p_year IS NULL OR p_month IS NULL OR p_month < 1 OR p_month > 12 THEN
    RAISE EXCEPTION 'driver_month_assignment_days_remaining: p_year and p_month are required, with a month from 1 to 12'
      USING ERRCODE = '22023';
  END IF;

  v_today      := (now() AT TIME ZONE 'Europe/Berlin')::date;
  v_month_over := (make_date(p_year, p_month, 1) + interval '1 month')::date;

  RETURN greatest(v_month_over - v_today, 0);
END;
$fn$;

COMMENT ON FUNCTION app_private.driver_month_assignment_days_remaining(integer, integer) IS
  'How many Europe/Berlin days are still to run before driver assignment opens '
  'for that month: 0 once the month''s last day has passed. The one place the '
  'month-end gate''s clock is read (20261023120000).';

/*
  "The assignment exists, belongs to this company and is still a draft", in one
  place, because the child guard asks it on every write. Returns the row so a
  caller that needs more than the refusal can read it.

  An assignment that is gone is a cascade -- from the assignment itself, from the
  company, from the driver or from the plan -- and is allowed. So is any write
  while the company row is gone: that is the company's own cascade, the condition
  20261016140000 added to the monthly plan's copy of this function after a
  company with a confirmed plan could not be deleted. By the time a cascade
  reaches a child the parent row is deleted, so the refusal stays in force for
  every ordinary write and stands aside for exactly the cascade.

  The row is read FOR KEY SHARE, held to the end of the transaction, and that
  conflicts with the FOR UPDATE driver_month_assignment_commit takes on it. Read
  without a lock the answer "draft" was stale the moment it was given: a window
  added while a commit was under way would land in a committed assignment the
  commit had just checked for overlaps, and a window DELETED then -- which has no
  foreign key check to wait on -- would leave a committed assignment whose
  figures count rows that are no longer there. Never FOR UPDATE: the child's own
  foreign key check already holds a key share on this row, and FOR UPDATE here
  deadlocks two concurrent child writes.
*/
CREATE OR REPLACE FUNCTION app_private.driver_month_assignment_parent_is_open(p_assignment_id uuid,
                                                                             p_company_id uuid)
RETURNS public.driver_month_assignments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_row public.driver_month_assignments;
BEGIN
  SELECT * INTO v_row
    FROM public.driver_month_assignments a
   WHERE a.id = p_assignment_id
     FOR KEY SHARE;

  IF NOT FOUND THEN
    RETURN v_row;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id) THEN
    RETURN v_row;
  END IF;

  IF v_row.company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'Die Fahrerzuordnung gehört zu einem anderen Unternehmen.'
      USING ERRCODE = 'P0001', HINT = 'driver_month_assignment_company_mismatch';
  END IF;

  IF v_row.status <> 'draft' THEN
    RAISE EXCEPTION 'Eine zugewiesene oder freigegebene Fahrerzuordnung kann nicht geändert werden.'
      USING ERRCODE = 'P0001', HINT = 'driver_month_assignment_is_final';
  END IF;

  RETURN v_row;
END;
$fn$;

COMMENT ON FUNCTION app_private.driver_month_assignment_parent_is_open(uuid, uuid) IS
  'The one place the child guard asks whether a driver month assignment exists, '
  'belongs to the row''s company and is still a draft. A missing assignment, or '
  'a company that no longer exists, is a cascade and is allowed '
  '(20261023120000).';

-- ─── 4. the guards ──────────────────────────────────────────────────────────

/*
  The assignment's own guard. Six rules:

    · THE MONTH-END GATE (header section 2). On INSERT the guard asks
      app_private.driver_month_assignment_days_remaining and refuses a row for a
      month that has not ended unless an early_reason stands in it; when one
      does, the DATABASE sets opened_early and stamps the number of days it
      measured. Once the month is over all three early columns are cleared,
      whatever arrived. This is the wall: a second caller writing the table
      directly meets the same question;
    · the row's key and its provenance are fixed: company, year, month, driver,
      plan, and the whole early record. A warning that could be edited away
      afterwards is not a warning;
    · the plan belongs to the same company and names the same month, and the
      driver belongs to the same company. Each has its own hint, so a refusal
      says which one it was;
    · a committed assignment is frozen and a released one is history. Neither is
      edited or deleted while the three rows it hangs from still exist;
    · status, the stamps, the figures and the release fields are not the
      client's. They move only while the transition marker names this row and
      this transaction, which is to say only inside
      driver_month_assignment_commit or _release, and the actor and the time are
      the database's on every transition;
    · a draft may be edited; nothing else may.
*/
CREATE OR REPLACE FUNCTION app_private.driver_month_assignment_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  c_marker    CONSTANT text := 'app_private.driver_month_assignment_transition';
  v_uid       uuid := auth.uid();
  v_plan      public.vehicle_day_plans;
  v_remaining integer;
  v_moves     boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A committed assignment is the month's record for that driver and a
    -- released one is its history; neither is deleted while the company, the
    -- driver and the plan it hangs from all still exist. A delete that reaches
    -- this row because one of those three is gone is somebody else's cascade.
    IF OLD.status <> 'draft'
       AND EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id)
       AND EXISTS (SELECT 1 FROM public.drivers d WHERE d.id = OLD.driver_id)
       AND EXISTS (SELECT 1 FROM public.vehicle_day_plans p WHERE p.id = OLD.plan_id) THEN
      RAISE EXCEPTION 'Eine zugewiesene oder freigegebene Fahrerzuordnung kann nicht gelöscht werden.'
        USING ERRCODE = 'P0001', HINT = 'driver_month_assignment_is_final';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The driver is the company's. Its own hint, so this refusal and the plan's
    -- below and the gate's never share one reason.
    IF NOT EXISTS (SELECT 1 FROM public.drivers d
                    WHERE d.id = NEW.driver_id AND d.company_id = NEW.company_id) THEN
      RAISE EXCEPTION 'Der Fahrer gehört nicht zu diesem Unternehmen.'
        USING ERRCODE = 'P0001', HINT = 'driver_month_assignment_driver_mismatch';
    END IF;

    SELECT * INTO v_plan FROM public.vehicle_day_plans p WHERE p.id = NEW.plan_id;
    -- No such plan: the foreign key refuses the row, with its own message.
    IF FOUND THEN
      IF v_plan.company_id IS DISTINCT FROM NEW.company_id
         OR v_plan.year    IS DISTINCT FROM NEW.year
         OR v_plan.month   IS DISTINCT FROM NEW.month THEN
        RAISE EXCEPTION 'Der Fahrzeug-Tagesplan gehört zu einem anderen Unternehmen oder zu einem anderen Monat.'
          USING ERRCODE = 'P0001', HINT = 'driver_month_assignment_plan_mismatch';
      END IF;
    END IF;

    -- A row is born a draft. Committing and releasing are the RPCs' acts.
    NEW.status         := 'draft';
    NEW.assigned_at    := NULL;
    NEW.assigned_by    := NULL;
    NEW.released_at    := NULL;
    NEW.released_by    := NULL;
    NEW.release_reason := NULL;
    NEW.release_note   := NULL;
    NEW.created_by     := v_uid;
    NEW.created_at     := now();
    NEW.updated_by     := v_uid;
    NEW.updated_at     := now();

    -- THE GATE. One helper, one clock, and the answer is the database's.
    v_remaining := app_private.driver_month_assignment_days_remaining(NEW.year, NEW.month);
    IF v_remaining > 0 THEN
      IF NEW.early_reason IS NULL OR btrim(NEW.early_reason) = '' THEN
        RAISE EXCEPTION 'Die Fahrerzuordnung für %/% kann erst nach dem Monatsende erfolgen; es fehlen noch % Tag(e). Mit einer Begründung ist sie trotzdem möglich.',
          NEW.month, NEW.year, v_remaining
          USING ERRCODE = 'P0001', HINT = 'driver_month_assignment_month_not_ended';
      END IF;
      NEW.opened_early         := true;
      NEW.early_reason         := btrim(NEW.early_reason);
      NEW.early_days_remaining := v_remaining;
    ELSE
      -- Nothing was early about it, so no warning is recorded, whatever arrived.
      NEW.opened_early         := false;
      NEW.early_reason         := NULL;
      NEW.early_days_remaining := NULL;
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.company_id           IS DISTINCT FROM OLD.company_id
     OR NEW.year              IS DISTINCT FROM OLD.year
     OR NEW.month             IS DISTINCT FROM OLD.month
     OR NEW.driver_id         IS DISTINCT FROM OLD.driver_id
     OR NEW.plan_id           IS DISTINCT FROM OLD.plan_id
     OR NEW.opened_early      IS DISTINCT FROM OLD.opened_early
     OR NEW.early_reason      IS DISTINCT FROM OLD.early_reason
     OR NEW.early_days_remaining IS DISTINCT FROM OLD.early_days_remaining THEN
    RAISE EXCEPTION 'Eine Fahrerzuordnung bleibt bei ihrem Unternehmen, ihrem Monat, ihrem Fahrer, ihrem Plan und der Begründung, mit der sie geöffnet wurde.'
      USING ERRCODE = 'P0001', HINT = 'driver_month_assignment_key_fixed';
  END IF;

  NEW.created_at := OLD.created_at;
  NEW.created_by := OLD.created_by;
  NEW.updated_by := v_uid;
  NEW.updated_at := now();

  v_moves := NEW.status                 IS DISTINCT FROM OLD.status
          OR NEW.assigned_at            IS DISTINCT FROM OLD.assigned_at
          OR NEW.assigned_by            IS DISTINCT FROM OLD.assigned_by
          OR NEW.released_at            IS DISTINCT FROM OLD.released_at
          OR NEW.released_by            IS DISTINCT FROM OLD.released_by
          OR NEW.release_reason         IS DISTINCT FROM OLD.release_reason
          OR NEW.release_note           IS DISTINCT FROM OLD.release_note;

  IF v_moves THEN
    IF nullif(current_setting(c_marker, true), '')
         IS DISTINCT FROM 'assignment:' || OLD.id::text || ':' || pg_current_xact_id()::text THEN
      RAISE EXCEPTION 'Der Status einer Fahrerzuordnung wird nur über driver_month_assignment_commit oder _release geändert.'
        USING ERRCODE = 'P0001', HINT = 'driver_month_assignment_transition_needs_rpc';
    END IF;

    -- The actor and the time are the database's on both transitions, whatever
    -- the caller sent. The figures may move in the same statement, because the
    -- commit re-derives them from the child rows -- which is what makes a
    -- committed row's hours provably the sum of its own windows.
    IF NEW.status = 'assigned' THEN
      NEW.assigned_at    := now();
      NEW.assigned_by    := v_uid;
      NEW.released_at    := NULL;
      NEW.released_by    := NULL;
      NEW.release_reason := NULL;
      NEW.release_note   := NULL;
    ELSIF NEW.status = 'released' THEN
      NEW.assigned_at    := OLD.assigned_at;
      NEW.assigned_by    := OLD.assigned_by;
      NEW.released_at    := now();
      NEW.released_by    := v_uid;
    ELSE
      RAISE EXCEPTION 'Eine Fahrerzuordnung kann nicht auf % zurückgesetzt werden.', NEW.status
        USING ERRCODE = 'P0001', HINT = 'driver_month_assignment_transition_invalid';
    END IF;
    RETURN NEW;
  END IF;

  -- An ordinary edit. Only a draft has anything to edit; the figures of a
  -- committed row move only in the transition above.
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Eine zugewiesene oder freigegebene Fahrerzuordnung kann nicht geändert werden.'
      USING ERRCODE = 'P0001', HINT = 'driver_month_assignment_is_final';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION app_private.driver_month_assignment_guard() IS
  'Applies the month-end gate from the Europe/Berlin clock and records an early '
  'opening the database measured itself, keeps an assignment with its company, '
  'month, driver, plan and early record, freezes it once committed, and lets only '
  'driver_month_assignment_commit and _release move its status (20261023120000).';

/*
  The child guard. Beyond keeping a window inside its assignment and company, it
  is the place the copied length is held to the window's own:

    · the assignment exists, is this company's and is still a draft
      (app_private.driver_month_assignment_parent_is_open, FOR KEY SHARE);
    · the window is this company's, and it belongs to the assignment's plan --
      which is how an October window cannot be assigned under a November
      assignment, and how a window of another company's plan cannot be claimed;
    · minutes equals the window's own minutes;
    · a child's assignment, company and window are fixed for its life;
    · a DELETE needs either a draft parent or the withdrawal marker, which only
      driver_month_assignment_release sets and only for the rows of the one
      assignment it is withdrawing. Without that marker a release could not
      delete the windows of a committed assignment, which is the one act the
      whole design exists to make cheap.

  Each refusal has its own hint, so a caller (and the kit) can tell them apart.
  Three cascades stand aside: the assignment is gone, the window is gone, or the
  company is gone (the last inside parent_is_open).
*/
CREATE OR REPLACE FUNCTION app_private.driver_month_assignment_shift_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  c_withdraw CONSTANT text := 'app_private.driver_month_assignment_withdrawal';
  v_parent   public.driver_month_assignments;
  v_shift    public.vehicle_day_shifts;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The assignment is gone: its own cascade, or the company's, the driver's or
    -- the plan's reaching it first.
    IF NOT EXISTS (SELECT 1 FROM public.driver_month_assignments a WHERE a.id = OLD.assignment_id) THEN
      RETURN OLD;
    END IF;
    -- The window is gone: vehicle_day_shifts' cascade.
    IF NOT EXISTS (SELECT 1 FROM public.vehicle_day_shifts f WHERE f.id = OLD.shift_id) THEN
      RETURN OLD;
    END IF;
    -- A release withdrawing exactly this assignment's windows.
    IF nullif(current_setting(c_withdraw, true), '')
         IS NOT DISTINCT FROM 'assignment:' || OLD.assignment_id::text || ':' || pg_current_xact_id()::text THEN
      RETURN OLD;
    END IF;
    PERFORM app_private.driver_month_assignment_parent_is_open(OLD.assignment_id, OLD.company_id);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
          OR NEW.company_id IS DISTINCT FROM OLD.company_id
          OR NEW.shift_id   IS DISTINCT FROM OLD.shift_id) THEN
    RAISE EXCEPTION 'Eine zugeordnete Schicht bleibt bei ihrer Fahrerzuordnung, ihrem Unternehmen und ihrer Schicht.'
      USING ERRCODE = 'P0001', HINT = 'driver_month_assignment_child_key_fixed';
  END IF;

  v_parent := app_private.driver_month_assignment_parent_is_open(NEW.assignment_id, NEW.company_id);

  -- No such assignment: the foreign key refuses the row, with its own message.
  IF v_parent.id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_shift FROM public.vehicle_day_shifts f WHERE f.id = NEW.shift_id;
  -- No such window: the foreign key refuses the row.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_shift.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'Die Schicht gehört zu einem anderen Unternehmen.'
      USING ERRCODE = 'P0001', HINT = 'driver_month_assignment_shift_company_mismatch';
  END IF;

  IF v_shift.plan_id IS DISTINCT FROM v_parent.plan_id THEN
    RAISE EXCEPTION 'Die Schicht gehört nicht zum Fahrzeug-Tagesplan dieser Fahrerzuordnung.'
      USING ERRCODE = 'P0001', HINT = 'driver_month_assignment_shift_plan_mismatch';
  END IF;

  IF NEW.minutes IS DISTINCT FROM v_shift.minutes THEN
    RAISE EXCEPTION 'Die Dauer der zugeordneten Schicht passt nicht zur Schicht selbst.'
      USING ERRCODE = 'P0001', HINT = 'driver_month_assignment_shift_minutes_mismatch';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION app_private.driver_month_assignment_shift_guard() IS
  'Keeps an assigned window inside its assignment, company and the assignment''s '
  'own vehicle day plan, holds its copied length to the window''s own, and lets '
  'a committed assignment''s windows be deleted only by '
  'driver_month_assignment_release (20261023120000).';

DROP TRIGGER IF EXISTS driver_month_assignment_guard ON public.driver_month_assignments;
CREATE TRIGGER driver_month_assignment_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.driver_month_assignments
  FOR EACH ROW EXECUTE FUNCTION app_private.driver_month_assignment_guard();

DROP TRIGGER IF EXISTS driver_month_assignment_shift_guard ON public.driver_month_assignment_shifts;
CREATE TRIGGER driver_month_assignment_shift_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.driver_month_assignment_shifts
  FOR EACH ROW EXECUTE FUNCTION app_private.driver_month_assignment_shift_guard();

-- ─── 5. the tenant shape ────────────────────────────────────────────────────

ALTER TABLE public.driver_month_assignments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_month_assignment_shifts ENABLE ROW LEVEL SECURITY;

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

  FOREACH v_tbl IN ARRAY ARRAY['driver_month_assignments', 'driver_month_assignment_shifts'] LOOP
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
    -- tests/rls/support-write-audit.sql section 1 state, and not from who writes
    -- these tables today.
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

-- ─── 6. preparing one driver's month, in one transaction ────────────────────

/*
  PostgREST cannot insert into two tables in one transaction, and the driver's
  earlier draft for the month has to go in the same transaction as the new one
  arrives, so this is the door the screen uses.

  The payload, and every key of it:

    {
      "year": 2026, "month": 10,
      "driver_id": "…",
      "shift_ids": ["…", "…"],      -- windows of the month's CONFIRMED plan
      "early_reason": "…"           -- only when the month has not ended yet
    }

  The list of keys is CLOSED, and a key outside it is refused with 22023 and
  NAMED, for 20261022140000's reason: a client that sends something that was not
  stored must be told so rather than left believing it was. Note what is NOT a
  key: plan_id. The plan is looked up as the month's confirmed plan, so a caller
  cannot point an assignment at a proposal or at a plan that was replaced.

  Six things it does that are not bookkeeping:

    · it takes its own advisory lock on the company, year and month, which is
      NOT 20261022140000's -- the two features serialise separately, so saving a
      vehicle plan and assigning a driver never wait on each other;
    · it applies THE GATE before anything else it could refuse for, and refuses
      BY RETURN VALUE with the number of days still to run, so a screen can offer
      "open it anyway, and say why". The guard is still the wall;
    · it finds the month's confirmed plan itself, and refuses when there is none;
    · it refuses a window that is not in that plan, a window another live
      assignment already claims, and a driver that is not this company's, each
      with its own reason code;
    · it refuses A DRIVER IN TWO PLACES AT ONCE in one pass over the windows in
      start order -- never a join of a table with itself;
    · it discards the driver's existing DRAFT for the month, because a new
      preparation replaces the old one rather than adding a second, counts what
      it stored against what the payload held, and computes the four figures from
      the windows it was given.

  Every other refusal is a table check or a guard, and each has its own state or
  hint: 23514 names the check, 23505 the unique constraint, P0001 the guard's
  hint.
*/
CREATE OR REPLACE FUNCTION public.driver_month_assignment_save(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  c_top_keys  CONSTANT text[] := ARRAY['year', 'month', 'driver_id', 'shift_ids', 'early_reason'];
  c_uuid      CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_caller    uuid := auth.uid();
  v_company   uuid;
  v_unknown   text;
  v_year      integer;
  v_month     integer;
  v_driver    uuid;
  v_ids       uuid[];
  v_early     text;
  v_remaining integer;
  v_plan      uuid;
  v_want      integer;
  v_got       integer;
  v_count     integer;
  v_minutes   bigint;
  v_vehicles  integer;
  v_days      integer;
  v_taken     integer;
  v_overlaps  integer;
  v_id        uuid;
  v_discarded integer := 0;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'driver_month_assignment_save: unauthenticated'
      USING ERRCODE = '42501', HINT = 'unauthenticated';
  END IF;

  -- The company and account state of 3.3, as every planning RPC asks it.
  v_company := public.get_active_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'driver_month_assignment_save: caller has no company'
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
    RAISE EXCEPTION 'driver_month_assignment_save: p_payload must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  SELECT string_agg(k.key, ', ' ORDER BY k.key) INTO v_unknown
    FROM jsonb_object_keys(p_payload) AS k(key)
   WHERE k.key <> ALL (c_top_keys);
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'driver_month_assignment_save: unknown payload key(s): %', v_unknown
      USING ERRCODE = '22023';
  END IF;

  IF coalesce(p_payload ->> 'year', '') !~ '^[0-9]{4}$'
     OR coalesce(p_payload ->> 'month', '') !~ '^[0-9]{1,2}$'
     OR coalesce(p_payload ->> 'driver_id', '') !~ c_uuid THEN
    RAISE EXCEPTION 'driver_month_assignment_save: year, month and driver_id are required'
      USING ERRCODE = '22023';
  END IF;

  v_year   := (p_payload ->> 'year')::integer;
  v_month  := (p_payload ->> 'month')::integer;
  v_driver := (p_payload ->> 'driver_id')::uuid;

  IF v_month < 1 OR v_month > 12 THEN
    RAISE EXCEPTION 'driver_month_assignment_save: month must be from 1 to 12'
      USING ERRCODE = '22023';
  END IF;

  IF p_payload ? 'early_reason' AND jsonb_typeof(p_payload -> 'early_reason') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'driver_month_assignment_save: early_reason must be a JSON string'
      USING ERRCODE = '22023';
  END IF;
  v_early := nullif(btrim(coalesce(p_payload ->> 'early_reason', '')), '');

  IF p_payload ? 'shift_ids' AND jsonb_typeof(p_payload -> 'shift_ids') <> 'array' THEN
    RAISE EXCEPTION 'driver_month_assignment_save: shift_ids must be a JSON array'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1
               FROM jsonb_array_elements(coalesce(p_payload -> 'shift_ids', '[]'::jsonb)) AS e(value)
              WHERE jsonb_typeof(e.value) <> 'string' OR (e.value #>> '{}') !~ c_uuid) THEN
    RAISE EXCEPTION 'driver_month_assignment_save: shift_ids must be a JSON array of uuid strings'
      USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg((e.value #>> '{}')::uuid), ARRAY[]::uuid[]) INTO v_ids
    FROM jsonb_array_elements(coalesce(p_payload -> 'shift_ids', '[]'::jsonb)) AS e(value);
  v_want := cardinality(v_ids);
  IF v_want <> (SELECT count(DISTINCT x) FROM unnest(v_ids) AS x) THEN
    RAISE EXCEPTION 'driver_month_assignment_save: shift_ids holds the same id twice'
      USING ERRCODE = '22023';
  END IF;

  -- THE GATE, first among the refusals a caller can act on, and by return value
  -- so a screen can offer the early opening with a reason. The guard below asks
  -- the same helper and is the wall.
  v_remaining := app_private.driver_month_assignment_days_remaining(v_year, v_month);
  IF v_remaining > 0 AND v_early IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'month_not_ended',
      'days_remaining', v_remaining,
      'error', format('Die Fahrerzuordnung für %s/%s kann erst nach dem Monatsende erfolgen; es fehlen noch %s Tag(e).',
                      v_month, v_year, v_remaining));
  END IF;

  -- The lock names the month, in this feature's own namespace.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('driver_month_assignment:%s:%s:%s', v_company, v_year, v_month), 0));

  IF NOT EXISTS (SELECT 1 FROM public.drivers d
                  WHERE d.id = v_driver AND d.company_id = v_company) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'driver_not_found',
      'error', 'Der Fahrer wurde in diesem Unternehmen nicht gefunden.');
  END IF;

  -- The month's active plan. Looked up, never sent, so an assignment cannot be
  -- built on a proposal or on a plan that was replaced.
  SELECT p.id INTO v_plan
    FROM public.vehicle_day_plans p
   WHERE p.company_id = v_company AND p.year = v_year AND p.month = v_month
     AND p.status = 'confirmed';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_confirmed_plan',
      'error', 'Für diesen Monat ist kein Fahrzeug-Tagesplan bestätigt.');
  END IF;

  SELECT count(*), coalesce(sum(f.minutes), 0),
         count(DISTINCT f.vehicle), count(DISTINCT f.operating_date)
    INTO v_count, v_minutes, v_vehicles, v_days
    FROM public.vehicle_day_shifts f
   WHERE f.id = ANY (v_ids) AND f.plan_id = v_plan AND f.company_id = v_company;
  IF v_count <> v_want THEN
    RETURN jsonb_build_object('success', false, 'reason', 'shift_not_in_plan',
      'missing_count', v_want - v_count,
      'error', 'Mindestens eine Schicht gehört nicht zum bestätigten Fahrzeug-Tagesplan dieses Monats.');
  END IF;

  -- A window another LIVE assignment holds. The unique constraint is still the
  -- wall; this is the refusal a screen can explain.
  SELECT count(*) INTO v_taken
    FROM public.driver_month_assignment_shifts c
    JOIN public.driver_month_assignments a ON a.id = c.assignment_id
   WHERE c.shift_id = ANY (v_ids) AND a.driver_id <> v_driver;
  IF v_taken > 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'shift_already_assigned',
      'taken_count', v_taken,
      'error', 'Mindestens eine Schicht ist bereits einem anderen Fahrer zugeordnet.');
  END IF;

  -- A DRIVER IS NEVER IN TWO PLACES AT ONCE. Half-open intervals, the engine's
  -- own comparison: a window that ends when the next begins overlaps nothing. In
  -- start order a window overlaps an earlier one exactly when the latest end
  -- among the windows before it lies after its own start. One pass over the
  -- windows, never a join of a table with itself.
  SELECT count(*) INTO v_overlaps
    FROM (SELECT f.starts_local,
                 max(f.ends_local) OVER (ORDER BY f.starts_local, f.ends_local, f.id
                                         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS earlier_end
            FROM public.vehicle_day_shifts f
           WHERE f.id = ANY (v_ids)) w
   WHERE w.earlier_end > w.starts_local;
  IF v_overlaps > 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'driver_overlap',
      'error', 'Der Fahrer wäre in zwei Schichten gleichzeitig eingeplant.');
  END IF;

  DELETE FROM public.driver_month_assignments a
   WHERE a.company_id = v_company AND a.year = v_year AND a.month = v_month
     AND a.driver_id = v_driver AND a.status = 'draft';
  GET DIAGNOSTICS v_discarded = ROW_COUNT;

  INSERT INTO public.driver_month_assignments
    (company_id, year, month, driver_id, plan_id, early_reason,
     assigned_shift_count, assigned_minutes, assigned_vehicle_count, assigned_day_count)
  VALUES (v_company, v_year, v_month, v_driver, v_plan, v_early,
          v_want, greatest(v_minutes, 0), v_vehicles, v_days)
  RETURNING id INTO v_id;

  INSERT INTO public.driver_month_assignment_shifts (company_id, assignment_id, shift_id, minutes)
  SELECT v_company, v_id, f.id, f.minutes
    FROM public.vehicle_day_shifts f
   WHERE f.id = ANY (v_ids);
  GET DIAGNOSTICS v_got = ROW_COUNT;
  IF v_got <> v_want THEN
    RAISE EXCEPTION 'driver_month_assignment_save: % of % shifts were stored', v_got, v_want
      USING ERRCODE = 'P0001', HINT = 'driver_month_assignment_rows_lost';
  END IF;

  RETURN jsonb_build_object(
    'success',                true,
    'assignment_id',          v_id,
    'year',                   v_year,
    'month',                  v_month,
    'driver_id',              v_driver,
    'plan_id',                v_plan,
    'assigned_shift_count',   v_want,
    'assigned_minutes',       greatest(v_minutes, 0),
    'assigned_vehicle_count', v_vehicles,
    'assigned_day_count',     v_days,
    'opened_early',           v_remaining > 0,
    'days_remaining',         v_remaining,
    'discarded_drafts',       v_discarded);
END;
$fn$;

COMMENT ON FUNCTION public.driver_month_assignment_save(jsonb) IS
  'Prepares one driver''s month -- the assignment and the windows it stands for -- '
  'in one transaction, against the month''s confirmed vehicle day plan. Applies '
  'the month-end gate and refuses by return value with the days still to run, so '
  'the screen can offer an early opening with a reason (20261023120000).';

-- ─── 7. committing the hours ────────────────────────────────────────────────

/*
  Moving a prepared month to 'assigned' is the act the owner defers to month end,
  so it is the act that has to be atomic and re-checked. Two walls, and both are
  needed:

    · pg_advisory_xact_lock on the company, year and month, taken before the
      function looks at anything, so two concurrent commits of one month take
      turns;
    · driver_month_assignments_one_live_per_driver, the partial unique index,
      which holds even against a statement that never came through this function.

  Between the lock and the write it re-derives two rules a stored assignment can
  break by itself, each in one pass and neither by a join of a table with itself:

    · the plan the assignment names is still the month's ACTIVE plan. A vehicle
      plan replaced between the preparation and the commit means the windows no
      longer exist in what the month is actually running (reason
      plan_not_active);
    · a driver is never in two places at once (reason driver_overlap).

  And it re-derives THE FIGURES from the child rows and writes them, so a
  committed row's hours are provably the sum of its own windows and not whatever
  a direct write to a draft left behind. That is the one thing this function
  changes besides the status, and the guard admits it only while the transition
  marker is held.

  Refusals are return values, never exceptions, because the screen has to be able
  to say which of them it was and offer the next step. A broken argument contract
  and a caller who may not be here raise, as they do everywhere else.
*/
CREATE OR REPLACE FUNCTION public.driver_month_assignment_commit(p_assignment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  c_marker   CONSTANT text := 'app_private.driver_month_assignment_transition';
  v_caller   uuid := auth.uid();
  v_company  uuid;
  v_row      public.driver_month_assignments;
  v_active   uuid;
  v_count    integer;
  v_minutes  bigint;
  v_vehicles integer;
  v_days     integer;
  v_overlaps integer;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'driver_month_assignment_commit: unauthenticated'
      USING ERRCODE = '42501', HINT = 'unauthenticated';
  END IF;

  v_company := public.get_active_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'driver_month_assignment_commit: caller has no company'
      USING ERRCODE = '42501', HINT = 'no_company';
  END IF;

  IF NOT public.current_role_permits('documents', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung: die Rolle darf die Seite Dokumente nicht bearbeiten.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_assignment_id IS NULL THEN
    RAISE EXCEPTION 'driver_month_assignment_commit: p_assignment_id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.driver_month_assignments a WHERE a.id = p_assignment_id;
  IF NOT FOUND OR v_row.company_id <> v_company THEN
    RETURN jsonb_build_object('success', false, 'reason', 'assignment_not_found',
      'error', 'Die Fahrerzuordnung wurde nicht gefunden.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('driver_month_assignment:%s:%s:%s', v_company, v_row.year, v_row.month), 0));

  -- Read again under the lock: another transaction may have committed, released
  -- or discarded this very row between the two reads.
  SELECT * INTO v_row
    FROM public.driver_month_assignments a WHERE a.id = p_assignment_id FOR UPDATE;
  IF NOT FOUND OR v_row.company_id <> v_company THEN
    RETURN jsonb_build_object('success', false, 'reason', 'assignment_not_found',
      'error', 'Die Fahrerzuordnung wurde nicht gefunden.');
  END IF;
  IF v_row.status <> 'draft' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_a_draft',
      'error', 'Diese Fahrerzuordnung ist kein Entwurf mehr.');
  END IF;

  -- An assignment with no windows is a failed preparation, not a driver with
  -- nothing to do, and committing it would make an empty month his record.
  SELECT count(*), coalesce(sum(c.minutes), 0)
    INTO v_count, v_minutes
    FROM public.driver_month_assignment_shifts c
   WHERE c.assignment_id = p_assignment_id;
  IF v_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'assignment_empty',
      'error', 'Die Fahrerzuordnung enthält keine Schichten.');
  END IF;

  -- The month's active plan has to be the one this assignment was prepared
  -- against.
  SELECT p.id INTO v_active
    FROM public.vehicle_day_plans p
   WHERE p.company_id = v_company AND p.year = v_row.year AND p.month = v_row.month
     AND p.status = 'confirmed';
  IF NOT FOUND OR v_active <> v_row.plan_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'plan_not_active',
      'error', 'Der Fahrzeug-Tagesplan dieser Fahrerzuordnung ist nicht mehr der aktive Plan des Monats.');
  END IF;

  -- A driver is never in two places at once, re-derived under the lock in one
  -- pass over his own windows. The join is to vehicle_day_shifts for the
  -- moments, never of a table with itself.
  SELECT count(*) INTO v_overlaps
    FROM (SELECT f.starts_local,
                 max(f.ends_local) OVER (ORDER BY f.starts_local, f.ends_local, f.id
                                         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS earlier_end
            FROM public.driver_month_assignment_shifts c
            JOIN public.vehicle_day_shifts f ON f.id = c.shift_id
           WHERE c.assignment_id = p_assignment_id) w
   WHERE w.earlier_end > w.starts_local;
  IF v_overlaps > 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'driver_overlap',
      'error', 'Der Fahrer ist in zwei Schichten gleichzeitig eingeplant.');
  END IF;

  -- The figures a committed row carries are the database's, from its own windows.
  SELECT count(DISTINCT f.vehicle), count(DISTINCT f.operating_date)
    INTO v_vehicles, v_days
    FROM public.driver_month_assignment_shifts c
    JOIN public.vehicle_day_shifts f ON f.id = c.shift_id
   WHERE c.assignment_id = p_assignment_id;

  PERFORM set_config(c_marker,
    'assignment:' || p_assignment_id::text || ':' || pg_current_xact_id()::text, true);
  UPDATE public.driver_month_assignments a
     SET status                 = 'assigned',
         assigned_shift_count   = v_count,
         assigned_minutes       = v_minutes,
         assigned_vehicle_count = v_vehicles,
         assigned_day_count     = v_days
   WHERE a.id = p_assignment_id;
  PERFORM set_config(c_marker, '', true);

  SELECT * INTO v_row FROM public.driver_month_assignments a WHERE a.id = p_assignment_id;

  RETURN jsonb_build_object(
    'success',                true,
    'assignment_id',          p_assignment_id,
    'assigned_at',            v_row.assigned_at,
    'assigned_shift_count',   v_count,
    'assigned_minutes',       v_minutes,
    'assigned_vehicle_count', v_vehicles,
    'assigned_day_count',     v_days,
    'opened_early',           v_row.opened_early);
END;
$fn$;

COMMENT ON FUNCTION public.driver_month_assignment_commit(uuid) IS
  'Commits one driver''s prepared month: takes the month''s advisory lock, '
  're-derives that the vehicle plan is still active and that the driver is not in '
  'two places at once, writes the four figures from the windows themselves, and '
  'refuses by return value so the screen can say which rule it was '
  '(20261023120000).';

-- ─── 8. releasing the hours, which is what an incident does ─────────────────

/*
  The act the owner's constraint is about. A fine, an accident, something on the
  road or leave means the hours cannot stand, and this is ONE CALL ON ONE ROW
  instead of the dozens of trip updates the pipeline would need. It is never
  gated by the clock: the incident happens inside the month, and a gate here
  would be a gate on the one act the design exists to make cheap.

  What it does, in one transaction:

    · deletes the assignment's windows, which is what frees them for another
      driver, under the withdrawal marker so the child guard admits a delete
      although the parent has left the draft state;
    · moves the row to 'released' with the reason and, when the reason is
      'other', the note. THE CLOSED LIST OF REASONS IS NOT RESTATED HERE: it
      lives in driver_month_assignments_release_reason_known and nowhere else, so
      the two cannot drift, and an unknown code is reported as that constraint's
      name (23514). The same goes for the note 'other' requires;
    · KEEPS THE FIGURES. assigned_shift_count, assigned_minutes,
      assigned_vehicle_count and assigned_day_count are the record of what the
      driver held, and they are what survives the windows being gone.

  A draft may be released too -- a month prepared and then dropped because the
  driver had an accident before anyone committed it -- in which case assigned_at
  stays NULL and the status CHECK admits it.
*/
CREATE OR REPLACE FUNCTION public.driver_month_assignment_release(p_assignment_id uuid,
                                                                  p_reason text,
                                                                  p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  c_marker   CONSTANT text := 'app_private.driver_month_assignment_transition';
  c_withdraw CONSTANT text := 'app_private.driver_month_assignment_withdrawal';
  v_caller   uuid := auth.uid();
  v_company  uuid;
  v_row      public.driver_month_assignments;
  v_reason   text;
  v_note     text;
  v_freed    integer := 0;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'driver_month_assignment_release: unauthenticated'
      USING ERRCODE = '42501', HINT = 'unauthenticated';
  END IF;

  v_company := public.get_active_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'driver_month_assignment_release: caller has no company'
      USING ERRCODE = '42501', HINT = 'no_company';
  END IF;

  IF NOT public.current_role_permits('documents', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung: die Rolle darf die Seite Dokumente nicht bearbeiten.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_assignment_id IS NULL THEN
    RAISE EXCEPTION 'driver_month_assignment_release: p_assignment_id is required'
      USING ERRCODE = '22023';
  END IF;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  v_note   := nullif(btrim(coalesce(p_note, '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'driver_month_assignment_release: p_reason is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.driver_month_assignments a WHERE a.id = p_assignment_id;
  IF NOT FOUND OR v_row.company_id <> v_company THEN
    RETURN jsonb_build_object('success', false, 'reason', 'assignment_not_found',
      'error', 'Die Fahrerzuordnung wurde nicht gefunden.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('driver_month_assignment:%s:%s:%s', v_company, v_row.year, v_row.month), 0));

  SELECT * INTO v_row
    FROM public.driver_month_assignments a WHERE a.id = p_assignment_id FOR UPDATE;
  IF NOT FOUND OR v_row.company_id <> v_company THEN
    RETURN jsonb_build_object('success', false, 'reason', 'assignment_not_found',
      'error', 'Die Fahrerzuordnung wurde nicht gefunden.');
  END IF;
  IF v_row.status = 'released' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_released',
      'error', 'Diese Fahrerzuordnung ist bereits freigegeben.');
  END IF;

  -- The windows go, which is what frees them for another driver. The marker is
  -- what lets the child guard admit a delete although the parent has left the
  -- draft state, and it names this assignment and this transaction alone.
  PERFORM set_config(c_withdraw,
    'assignment:' || p_assignment_id::text || ':' || pg_current_xact_id()::text, true);
  DELETE FROM public.driver_month_assignment_shifts c WHERE c.assignment_id = p_assignment_id;
  GET DIAGNOSTICS v_freed = ROW_COUNT;
  PERFORM set_config(c_withdraw, '', true);

  -- The figures stay: they are the record of what the driver held.
  PERFORM set_config(c_marker,
    'assignment:' || p_assignment_id::text || ':' || pg_current_xact_id()::text, true);
  UPDATE public.driver_month_assignments a
     SET status = 'released', release_reason = v_reason, release_note = v_note
   WHERE a.id = p_assignment_id;
  PERFORM set_config(c_marker, '', true);

  SELECT * INTO v_row FROM public.driver_month_assignments a WHERE a.id = p_assignment_id;

  RETURN jsonb_build_object(
    'success',              true,
    'assignment_id',        p_assignment_id,
    'released_at',          v_row.released_at,
    'release_reason',       v_row.release_reason,
    'freed_shift_count',    v_freed,
    'assigned_shift_count', v_row.assigned_shift_count,
    'assigned_minutes',     v_row.assigned_minutes);
END;
$fn$;

COMMENT ON FUNCTION public.driver_month_assignment_release(uuid, text, text) IS
  'Withdraws one driver''s month after a fine, an accident, something on the road '
  'or leave: deletes the windows so another driver can take them, records the '
  'reason, and keeps the figures as the record of what he held. One call on one '
  'row, which is the unit this feature exists to create (20261023120000).';

-- ─── 9. ownership and privileges ────────────────────────────────────────────

-- The guards, the helpers and all three RPCs are SECURITY DEFINER; CREATE OR
-- REPLACE keeps whatever owner a function had, so the owner is stated.
ALTER FUNCTION app_private.driver_month_assignment_guard()                        OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.driver_month_assignment_shift_guard()                  OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.driver_month_assignment_parent_is_open(uuid, uuid)     OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.driver_month_assignment_days_remaining(integer, integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.driver_month_assignment_save(jsonb)                         OWNER TO CURRENT_USER;
ALTER FUNCTION public.driver_month_assignment_commit(uuid)                        OWNER TO CURRENT_USER;
ALTER FUNCTION public.driver_month_assignment_release(uuid, text, text)           OWNER TO CURRENT_USER;

-- Fired by triggers, or called by the RPCs, which run as their owner. Triggers
-- do not check EXECUTE; the REVOKE is the second wall behind the missing USAGE
-- on app_private. Supabase's default privileges grant EXECUTE on every new
-- function to PUBLIC *and* anon, so revoking only from authenticated is the
-- recorded defect of 20260911120000 and not an option here.
REVOKE ALL ON FUNCTION app_private.driver_month_assignment_guard()                        FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.driver_month_assignment_shift_guard()                  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.driver_month_assignment_parent_is_open(uuid, uuid)     FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.driver_month_assignment_days_remaining(integer, integer) FROM PUBLIC, anon, authenticated, service_role;

-- All three RPCs read auth.uid(), and the service key carries no subject, so
-- only a signed-in caller gets them.
REVOKE ALL ON FUNCTION public.driver_month_assignment_save(jsonb)               FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.driver_month_assignment_commit(uuid)              FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.driver_month_assignment_release(uuid, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.driver_month_assignment_save(jsonb)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_month_assignment_commit(uuid)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_month_assignment_release(uuid, text, text) TO authenticated;

-- The same default grants every new table to anon, authenticated and
-- service_role. anon never reads these; no edge function does either.
REVOKE ALL ON TABLE public.driver_month_assignments       FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.driver_month_assignment_shifts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.driver_month_assignments       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.driver_month_assignment_shifts TO authenticated;

-- ─── 10. self-check ─────────────────────────────────────────────────────────
--
-- What a release can be told without a second session and without data: the
-- catalogue, the bodies of the functions with their comments removed
-- (app_private.function_code, which raises for a signature that does not
-- resolve, so a renamed function cannot make a `!~` check below pass on NULL),
-- and the clock helper, run on a month that ended long ago and one that will not
-- end this century -- two literals, so the assertion means the same thing in
-- every year this code runs. The behaviour itself -- every refusal, the
-- lifecycle, the gate's two paths, the races -- is
-- tests/rls/driver-month-assignments.sql.

DO $mig$
DECLARE
  c_tables CONSTANT text[] := ARRAY['driver_month_assignments', 'driver_month_assignment_shifts'];
  c_funcs  CONSTANT text[] := ARRAY['app_private.driver_month_assignment_guard()',
                                    'app_private.driver_month_assignment_shift_guard()',
                                    'app_private.driver_month_assignment_parent_is_open(uuid,uuid)',
                                    'app_private.driver_month_assignment_days_remaining(integer,integer)',
                                    'public.driver_month_assignment_save(jsonb)',
                                    'public.driver_month_assignment_commit(uuid)',
                                    'public.driver_month_assignment_release(uuid,text,text)'];
  c_rpcs   CONSTANT text[] := ARRAY['public.driver_month_assignment_save(jsonb)',
                                    'public.driver_month_assignment_commit(uuid)',
                                    'public.driver_month_assignment_release(uuid,text,text)'];
  v_tbl    text;
  v_sig    text;
  v_wrong  text;
  v_src    text;
  v_guard  text;
BEGIN
  FOREACH v_tbl IN ARRAY c_tables LOOP
    -- 1. The table exists with row level security on.
    IF to_regclass(format('public.%I', v_tbl)) IS NULL THEN
      RAISE EXCEPTION 'driver month assignments self-check 1: public.% is missing', v_tbl;
    END IF;
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', v_tbl)::regclass) THEN
      RAISE EXCEPTION 'driver month assignments self-check 1: % has row level security off', v_tbl;
    END IF;

    -- 2. Exactly the four policies of 20260917130000's shape, each asking the
    --    active-company helper, each write asking the Dokumente page of slice C,
    --    SELECT asking no role at all, and the UPDATE stating one predicate as
    --    USING and as WITH CHECK (which is what refuses a move to another
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
      RAISE EXCEPTION 'driver month assignments self-check 2: % has a policy outside the business shape: %', v_tbl, v_wrong;
    END IF;
    IF (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_tbl) <> 4
       OR (SELECT count(DISTINCT p.cmd) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_tbl) <> 4 THEN
      RAISE EXCEPTION 'driver month assignments self-check 2: % must carry exactly one SELECT, INSERT, UPDATE and DELETE policy', v_tbl;
    END IF;

    -- 3. Both context triggers, in 3.4a's and 3.4c's shapes: a statement-level
    --    BEFORE INSERT/UPDATE/DELETE refusal (tgtype 30) and a gated AFTER ROW
    --    audit (tgtype 29). One without the other fails the kit.
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                      AND g.tgname = 'refuse_read_only_context_write'
                      AND NOT g.tgisinternal AND g.tgtype = 30 AND g.tgenabled = 'O'
                      AND g.tgfoid = 'app_private.refuse_read_only_context_write()'::regprocedure) THEN
      RAISE EXCEPTION 'driver month assignments self-check 3: % does not carry the view-context refusal trigger', v_tbl;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                      AND g.tgname = 'record_support_write'
                      AND NOT g.tgisinternal AND g.tgtype = 29 AND g.tgenabled = 'O'
                      AND g.tgqual IS NOT NULL
                      AND pg_get_triggerdef(g.oid) ~ 'app_private\.support_write_context'
                      AND g.tgfoid = 'app_private.record_support_write()'::regprocedure) THEN
      RAISE EXCEPTION 'driver month assignments self-check 3: % does not carry the gated support-write audit trigger', v_tbl;
    END IF;

    -- 4. Privileges: nothing for anon or the service role, the four DML commands
    --    and nothing else for authenticated.
    IF has_table_privilege('anon', format('public.%I', v_tbl), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('service_role', format('public.%I', v_tbl), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('authenticated', format('public.%I', v_tbl), 'TRUNCATE,REFERENCES,TRIGGER')
       OR NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'SELECT')
       OR NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'INSERT')
       OR NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'UPDATE')
       OR NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'DELETE') THEN
      RAISE EXCEPTION 'driver month assignments self-check 4: the table privileges on % are not anon none, authenticated SELECT/INSERT/UPDATE/DELETE, service_role none', v_tbl;
    END IF;

    -- 5. Every table carries its OWN guard, not the other table's, as an enabled
    --    BEFORE INSERT OR UPDATE OR DELETE row trigger (tgtype 31 = ROW 1 +
    --    BEFORE 2 + INSERT 4 + DELETE 8 + UPDATE 16).
    v_guard := CASE v_tbl WHEN 'driver_month_assignments' THEN 'driver_month_assignment_guard'
                                                          ELSE 'driver_month_assignment_shift_guard' END;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
                      AND g.tgname = v_guard
                      AND NOT g.tgisinternal AND g.tgtype = 31 AND g.tgenabled = 'O'
                      AND g.tgfoid = format('app_private.%I()', v_guard)::regprocedure) THEN
      RAISE EXCEPTION 'driver month assignments self-check 5: % does not carry %() as an enabled BEFORE INSERT OR UPDATE OR DELETE row trigger', v_tbl, v_guard;
    END IF;
  END LOOP;

  -- 6. One LIVE assignment per company, month and driver: the partial unique
  --    index, on that key and on nothing else, excluding exactly the released
  --    rows. And one live claim per window on the child.
  SELECT pg_get_indexdef(i.indexrelid) INTO v_wrong
    FROM pg_index i
   WHERE i.indrelid = 'public.driver_month_assignments'::regclass
     AND i.indexrelid = to_regclass('public.driver_month_assignments_one_live_per_driver');
  IF v_wrong IS NULL
     OR v_wrong !~ 'CREATE UNIQUE INDEX'
     OR v_wrong !~ 'company_id, year, month, driver_id'
     OR v_wrong !~ 'WHERE \(status <> ''released''::text\)' THEN
    RAISE EXCEPTION 'driver month assignments self-check 6: the one-live-assignment-per-driver index is missing or has changed shape: %', coalesce(v_wrong, 'absent');
  END IF;
  SELECT pg_get_constraintdef(c.oid) INTO v_wrong
    FROM pg_constraint c
   WHERE c.conrelid = 'public.driver_month_assignment_shifts'::regclass
     AND c.conname = 'driver_month_assignment_shifts_one_claim_per_shift';
  IF v_wrong IS NULL OR v_wrong !~ '^UNIQUE \(shift_id\)' THEN
    RAISE EXCEPTION 'driver month assignments self-check 6: one driver per vehicle window is not a UNIQUE (shift_id) constraint: %', coalesce(v_wrong, 'absent');
  END IF;

  -- 7. Every function: SECURITY DEFINER, a search_path pinned with pg_catalog
  --    first, an owner that can reach app_private, and no EXECUTE for a role the
  --    API authenticates as (the three public RPCs excepted, which authenticated
  --    must be able to call and anon and the service role must not).
  FOREACH v_sig IN ARRAY c_funcs LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'driver month assignments self-check 7: % is missing', v_sig;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) THEN
      RAISE EXCEPTION 'driver month assignments self-check 7: % is not SECURITY DEFINER', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                    WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=pg_catalog,%') THEN
      RAISE EXCEPTION 'driver month assignments self-check 7: % does not pin its search_path with pg_catalog first', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = to_regprocedure(v_sig)
                      AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private'))) THEN
      RAISE EXCEPTION 'driver month assignments self-check 7: the owner of % cannot reach app_private', v_sig;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
       OR has_function_privilege('service_role', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'driver month assignments self-check 7: % is executable by anon or the service role', v_sig;
    END IF;
    IF v_sig LIKE 'app\_private.%' AND has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'driver month assignments self-check 7: % is executable by authenticated', v_sig;
    END IF;
    IF v_sig LIKE 'public.%' AND NOT has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'driver month assignments self-check 7: authenticated cannot call %', v_sig;
    END IF;
  END LOOP;

  -- 8. All three RPCs are VOLATILE (so supabase-js calls them with POST and not
  --    in a read-only transaction), all three ask the state helper and the
  --    Dokumente page with the not_authorized hint, and all three take the
  --    advisory lock on the month in THIS feature's namespace. The bodies are
  --    read with their comments removed, so a gate that survives only as a
  --    comment is not a gate.
  FOREACH v_sig IN ARRAY c_rpcs LOOP
    IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) <> 'v' THEN
      RAISE EXCEPTION 'driver month assignments self-check 8: % is not VOLATILE', v_sig;
    END IF;
    v_src := app_private.function_code(v_sig);
    IF v_src !~ 'get_active_company_id' THEN
      RAISE EXCEPTION 'driver month assignments self-check 8: % does not ask get_active_company_id()', v_sig;
    END IF;
    IF v_src !~ 'IF\s+NOT\s+public\.current_role_permits\(''documents'',\s*true\)\s+THEN\s+RAISE\s+EXCEPTION[^;]*not_authorized' THEN
      RAISE EXCEPTION 'driver month assignments self-check 8: % lost the Dokumente page gate or its not_authorized hint', v_sig;
    END IF;
    IF v_src !~ 'pg_advisory_xact_lock\(hashtextextended\(\s*format\(''driver_month_assignment:' THEN
      RAISE EXCEPTION 'driver month assignments self-check 8: % does not take the advisory lock on the month in this feature''s namespace', v_sig;
    END IF;
  END LOOP;

  -- The save RPC keeps its closed key list, looks the plan up instead of taking
  -- one, and writes the figures itself.
  v_src := app_private.function_code('public.driver_month_assignment_save(jsonb)');
  IF v_src !~ 'unknown payload key'
     OR v_src !~ 'k\.key\s*<>\s*ALL\s*\(c_top_keys\)'
     -- The closed list itself, element by element: plan_id is NOT among the keys
     -- a caller may send, which is what stops an assignment being pointed at a
     -- proposal or at a plan that was replaced.
     OR v_src !~ 'c_top_keys[^;]*ARRAY\[''year'',\s*''month'',\s*''driver_id'',\s*''shift_ids'',\s*''early_reason''\]'
     -- …and the plan is looked up instead, as the month's confirmed one.
     OR v_src !~ 'p\.status\s*=\s*''confirmed'''
     OR v_src !~ 'assigned_day_count'
     OR v_src !~ 'driver_month_assignment_rows_lost' THEN
    RAISE EXCEPTION 'driver month assignments self-check 8: driver_month_assignment_save lost its closed key list, started taking a plan_id instead of looking the confirmed plan up, or lost the figures it writes or its row count';
  END IF;

  -- 9. THE BOUNDARY THIS SLICE IS BUILT ON. No column of either table is named
  --    like a ride, an address or a fare; no foreign key points at the trips; and
  --    none of the seven functions names the trips table or any part of the
  --    planning pipeline this slice must not touch. A driver column is the point
  --    of this table and is NOT on the list -- that is the difference from
  --    20261022140000's rule 2, whose tables must name no driver at all.
  SELECT string_agg(format('%s.%s', c.relname, a.attname), ', ' ORDER BY c.relname, a.attname) INTO v_wrong
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.oid IN ('public.driver_month_assignments'::regclass,
                   'public.driver_month_assignment_shifts'::regclass)
     AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname ~ '(^|_)(ride|trip|fahrt|address|adresse|fare|tip|trinkgeld|passenger|customer|pickup|destination|route|gps|lat|lng|latitude|longitude|lohnart|brutto|netto)(_|$)';
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'driver month assignments self-check 9: a column is named like a ride, an address, a fare or a payroll figure: %', v_wrong;
  END IF;

  SELECT string_agg(format('%s.%s', c.conrelid::regclass, c.conname), ', ') INTO v_wrong
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.conrelid IN ('public.driver_month_assignments'::regclass,
                        'public.driver_month_assignment_shifts'::regclass)
     AND c.confrelid IN (to_regclass('public.fahrtenbuch_trips'),
                         to_regclass('public.fahrtenbuch_imports'),
                         to_regclass('public.company_planning_runs'),
                         to_regclass('public.saved_stundennachweise'));
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'driver month assignments self-check 9: a driver-month table references the trips, the imports, a planning run or a saved Stundennachweis: %', v_wrong;
  END IF;

  SELECT string_agg(f.sig, ', ') INTO v_wrong
    FROM unnest(c_funcs) AS f(sig)
   WHERE app_private.function_code(f.sig) ~* 'fahrtenbuch_trips|fahrtenbuch_imports|company_planning_runs|saved_stundennachweise|planning_finalizations';
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'driver month assignments self-check 9: a driver-month function names the trips or the planning pipeline: %', v_wrong;
  END IF;

  -- 10. THE GATE. Three halves, each in the place it belongs.
  --     (a) the clock is Europe/Berlin, read in ONE function, which is STABLE
  --         (so it may not be a CHECK) and names no other zone;
  --     (b) the guard asks that function on INSERT and refuses a month that has
  --         not ended with its own hint, and sets opened_early,
  --         early_days_remaining and the trimmed reason itself;
  --     (c) the pairing is a CHECK, so "opened early" cannot stand without a
  --         reason and a measured shortfall, and all three columns are part of
  --         the row's fixed key afterwards.
  v_src := app_private.function_code('app_private.driver_month_assignment_days_remaining(integer,integer)');
  IF v_src !~ 'now\(\)\s+AT\s+TIME\s+ZONE\s+''Europe/Berlin'''
     OR v_src !~ 'make_date\(p_year,\s*p_month,\s*1\)\s*\+\s*interval\s+''1 month'''
     OR v_src !~ 'greatest\(v_month_over\s*-\s*v_today,\s*0\)'
     -- Exactly ONE timezone conversion in the whole function, which the clause
     -- above has already required to be Europe/Berlin. A second one would be a
     -- second clock, which is the thing this file must not have.
     OR (SELECT count(*) FROM regexp_matches(v_src, 'AT\s+TIME\s+ZONE', 'gi')) <> 1 THEN
    RAISE EXCEPTION 'driver month assignments self-check 10a: the gate''s clock is no longer "the first of the following month minus today in Europe/Berlin", or reads a second zone';
  END IF;
  IF (SELECT p.provolatile FROM pg_proc p
       WHERE p.oid = to_regprocedure('app_private.driver_month_assignment_days_remaining(integer,integer)')) <> 's' THEN
    RAISE EXCEPTION 'driver month assignments self-check 10a: the gate''s clock helper must be STABLE -- IMMUTABLE would invite it into a CHECK, where a rule that may be re-evaluated must not live';
  END IF;
  -- Run on two literals, so this assertion means the same in every year.
  IF app_private.driver_month_assignment_days_remaining(2020, 1) <> 0 THEN
    RAISE EXCEPTION 'driver month assignments self-check 10a: the gate reports days remaining for January 2020, which ended long ago';
  END IF;
  IF app_private.driver_month_assignment_days_remaining(2099, 12) <= 0 THEN
    RAISE EXCEPTION 'driver month assignments self-check 10a: the gate reports December 2099 as already over';
  END IF;

  v_src := app_private.function_code('app_private.driver_month_assignment_guard()');
  IF v_src !~ 'v_remaining\s*:=\s*app_private\.driver_month_assignment_days_remaining\(NEW\.year,\s*NEW\.month\)'
     OR v_src !~ 'IF\s+v_remaining\s*>\s*0\s+THEN'
     OR v_src !~ 'IF\s+NEW\.early_reason\s+IS\s+NULL\s+OR\s+btrim\(NEW\.early_reason\)\s*=\s*''''\s+THEN\s+RAISE\s+EXCEPTION[^;]*driver_month_assignment_month_not_ended'
     OR v_src !~ 'NEW\.opened_early\s*:=\s*true'
     OR v_src !~ 'NEW\.early_days_remaining\s*:=\s*v_remaining'
     OR v_src !~ 'NEW\.opened_early\s*:=\s*false' THEN
    RAISE EXCEPTION 'driver month assignments self-check 10b: the guard no longer applies the month-end gate, no longer refuses a month that has not ended, or no longer records the early opening itself';
  END IF;
  IF v_src !~ 'OR\s+NEW\.opened_early\s+IS\s+DISTINCT\s+FROM\s+OLD\.opened_early'
     OR v_src !~ 'OR\s+NEW\.early_reason\s+IS\s+DISTINCT\s+FROM\s+OLD\.early_reason'
     OR v_src !~ 'OR\s+NEW\.early_days_remaining\s+IS\s+DISTINCT\s+FROM\s+OLD\.early_days_remaining'
     OR v_src !~ 'THEN\s+RAISE\s+EXCEPTION[^;]*driver_month_assignment_key_fixed' THEN
    RAISE EXCEPTION 'driver month assignments self-check 10b: the early-opening record can be edited after the fact, so the warning is no longer a warning';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO v_wrong
    FROM pg_constraint c
   WHERE c.conrelid = 'public.driver_month_assignments'::regclass
     AND c.conname = 'driver_month_assignments_early_recorded';
  IF v_wrong IS NULL
     OR v_wrong !~ 'opened_early = \(early_reason IS NOT NULL\)'
     OR v_wrong !~ 'opened_early = \(early_days_remaining IS NOT NULL\)' THEN
    RAISE EXCEPTION 'driver month assignments self-check 10c: the pairing of opened_early with its reason and its measured shortfall is not a CHECK any more: %', coalesce(v_wrong, 'absent');
  END IF;

  -- 11. The named constraints the kit and the client lean on, and the closed
  --     list of release reasons, which lives in its CHECK and nowhere else.
  FOREACH v_sig IN ARRAY ARRAY['driver_month_assignments_early_recorded',
                               'driver_month_assignments_early_reason_bounded',
                               'driver_month_assignments_early_days_positive',
                               'driver_month_assignments_status_matches_stamps',
                               'driver_month_assignments_release_recorded',
                               'driver_month_assignments_release_reason_known',
                               'driver_month_assignments_release_note_bounded',
                               'driver_month_assignments_release_note_required_for_other',
                               'driver_month_assignments_figures_not_negative',
                               'driver_month_assignments_figures_agree',
                               'driver_month_assignment_shifts_one_claim_per_shift',
                               'driver_month_assignment_shifts_minutes_positive'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = v_sig
                     AND c.connamespace = 'public'::regnamespace) THEN
      RAISE EXCEPTION 'driver month assignments self-check 11: the constraint % is missing', v_sig;
    END IF;
  END LOOP;
  SELECT pg_get_constraintdef(c.oid) INTO v_wrong
    FROM pg_constraint c
   WHERE c.conrelid = 'public.driver_month_assignments'::regclass
     AND c.conname = 'driver_month_assignments_release_reason_known';
  IF v_wrong !~ '''fine''' OR v_wrong !~ '''accident''' OR v_wrong !~ '''roadside_incident'''
     OR v_wrong !~ '''leave''' OR v_wrong !~ '''other''' THEN
    RAISE EXCEPTION 'driver month assignments self-check 11: the closed list of release reasons is not the owner''s four plus other: %', v_wrong;
  END IF;
  -- And the release RPC does NOT restate that list, which is what keeps the two
  -- from drifting.
  v_src := app_private.function_code('public.driver_month_assignment_release(uuid,text,text)');
  IF v_src ~ '''roadside_incident''' THEN
    RAISE EXCEPTION 'driver month assignments self-check 11: driver_month_assignment_release restates the closed list of reasons, which is the CHECK constraint''s and nowhere else''s';
  END IF;

  -- 12. The status a row is born with, the figures it starts from, and the
  --     warning it starts without.
  -- Counted, never asked column by column with a scalar subquery: a column that
  -- does not exist answers NO ROW, `NOT NULL` is NULL, and a per-column check
  -- written that way passes for a column that is gone.
  IF (SELECT count(*) FROM pg_attribute a
       WHERE a.attrelid = 'public.driver_month_assignments'::regclass
         AND a.attname IN ('status', 'assigned_shift_count', 'assigned_minutes',
                           'assigned_vehicle_count', 'assigned_day_count', 'opened_early')
         AND a.attnum > 0 AND NOT a.attisdropped AND a.atthasdef) <> 6 THEN
    RAISE EXCEPTION 'driver month assignments self-check 12: status, the four figures or opened_early is missing or has no default';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = 'public.driver_month_assignments'::regclass
                    AND a.attname IN ('driver_id', 'plan_id', 'year', 'month')
                  GROUP BY a.attrelid
                 HAVING count(*) = 4 AND bool_and(a.attnotnull) AND NOT bool_or(a.atthasdef)) THEN
    RAISE EXCEPTION 'driver month assignments self-check 12: driver_id, plan_id, year and month must be NOT NULL with no default';
  END IF;

  -- 13. A cascade must never be stopped by the freeze. The assignment's guard
  --     stands aside once the company, the driver OR the plan is gone, the child
  --     guard once the assignment or the window is gone, parent_is_open once the
  --     company is gone; and every foreign key from companies cascades.
  v_src := app_private.function_code('app_private.driver_month_assignment_guard()');
  IF v_src !~ 'FROM\s+public\.companies\s+c\s+WHERE\s+c\.id\s*=\s*OLD\.company_id'
     OR v_src !~ 'FROM\s+public\.drivers\s+d\s+WHERE\s+d\.id\s*=\s*OLD\.driver_id'
     OR v_src !~ 'FROM\s+public\.vehicle_day_plans\s+p\s+WHERE\s+p\.id\s*=\s*OLD\.plan_id' THEN
    RAISE EXCEPTION 'driver month assignments self-check 13: the guard refuses a delete that is somebody else''s cascade';
  END IF;
  v_src := app_private.function_code('app_private.driver_month_assignment_parent_is_open(uuid,uuid)');
  IF v_src !~ 'FROM\s+public\.companies\s+c\s+WHERE\s+c\.id\s*=\s*p_company_id' THEN
    RAISE EXCEPTION 'driver month assignments self-check 13: parent_is_open refuses a write even when the company is gone';
  END IF;
  v_src := app_private.function_code('app_private.driver_month_assignment_shift_guard()');
  IF v_src !~ 'FROM\s+public\.driver_month_assignments\s+a\s+WHERE\s+a\.id\s*=\s*OLD\.assignment_id'
     OR v_src !~ 'FROM\s+public\.vehicle_day_shifts\s+f\s+WHERE\s+f\.id\s*=\s*OLD\.shift_id' THEN
    RAISE EXCEPTION 'driver month assignments self-check 13: the child guard refuses a delete that is the assignment''s or the window''s cascade';
  END IF;
  IF (SELECT count(*) FROM pg_constraint k
       WHERE k.contype = 'f' AND k.confrelid = 'public.companies'::regclass
         AND k.conrelid IN ('public.driver_month_assignments'::regclass,
                            'public.driver_month_assignment_shifts'::regclass)
         AND k.confdeltype = 'c') <> 2 THEN
    RAISE EXCEPTION 'driver month assignments self-check 13: both tables must cascade from companies';
  END IF;
  IF (SELECT count(*) FROM pg_constraint k
       WHERE k.contype = 'f' AND k.confdeltype = 'c'
         AND k.conrelid = 'public.driver_month_assignments'::regclass
         AND k.confrelid IN ('public.drivers'::regclass, 'public.vehicle_day_plans'::regclass)) <> 2 THEN
    RAISE EXCEPTION 'driver month assignments self-check 13: the assignment must cascade from the driver and from the vehicle day plan';
  END IF;

  -- 14. The two markers, and the one thing each of them opens. The transition
  --     marker is the only way status, the stamps, the figures and the release
  --     fields move; the withdrawal marker is the only way a committed
  --     assignment's windows are deleted. Matched as `IF <condition> THEN
  --     RAISE ... <its hint>` or as the whole guard clause, because a pattern
  --     that asks only whether a name occurs is satisfied by `IF false AND <the
  --     condition>`, and the condition is the rule.
  v_src := app_private.function_code('app_private.driver_month_assignment_guard()');
  IF v_src !~ 'IF\s+nullif\(current_setting\(c_marker,\s*true\),\s*''''\)\s+IS\s+DISTINCT\s+FROM\s+''assignment:''\s*\|\|\s*OLD\.id::text\s*\|\|\s*'':''\s*\|\|\s*pg_current_xact_id\(\)::text\s+THEN\s+RAISE\s+EXCEPTION[^;]*driver_month_assignment_transition_needs_rpc'
     OR v_src !~ 'c_marker\s+CONSTANT\s+text\s*:=\s*''app_private\.driver_month_assignment_transition''' THEN
    RAISE EXCEPTION 'driver month assignments self-check 14: the status, the stamps and the figures no longer move only under the transition marker';
  END IF;
  v_src := app_private.function_code('app_private.driver_month_assignment_shift_guard()');
  IF v_src !~ 'c_withdraw\s+CONSTANT\s+text\s*:=\s*''app_private\.driver_month_assignment_withdrawal'''
     OR v_src !~ 'IF\s+nullif\(current_setting\(c_withdraw,\s*true\),\s*''''\)\s+IS\s+NOT\s+DISTINCT\s+FROM\s+''assignment:''\s*\|\|\s*OLD\.assignment_id::text\s*\|\|\s*'':''\s*\|\|\s*pg_current_xact_id\(\)::text\s+THEN\s+RETURN\s+OLD'
     OR v_src !~ 'PERFORM\s+app_private\.driver_month_assignment_parent_is_open\(OLD\.assignment_id,\s*OLD\.company_id\)' THEN
    RAISE EXCEPTION 'driver month assignments self-check 14: a committed assignment''s windows can be deleted without the withdrawal marker, or the marker no longer names one assignment and one transaction';
  END IF;
  -- Only the release RPC sets the withdrawal marker, and it clears it again.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_wrong
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname IN ('public', 'app_private')
     AND p.prokind = 'f'
     AND l.lanname IN ('plpgsql', 'sql')
     AND p.prosrc ~ 'app_private\.driver_month_assignment_withdrawal'
     AND p.oid <> to_regprocedure('public.driver_month_assignment_release(uuid,text,text)')
     AND p.oid <> to_regprocedure('app_private.driver_month_assignment_shift_guard()');
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'driver month assignments self-check 14: something other than driver_month_assignment_release and the child guard names the withdrawal marker: %', v_wrong;
  END IF;
  v_src := app_private.function_code('public.driver_month_assignment_release(uuid,text,text)');
  IF v_src !~ 'PERFORM\s+set_config\(c_withdraw,\s*''assignment:''\s*\|\|\s*p_assignment_id::text\s*\|\|\s*'':''\s*\|\|\s*pg_current_xact_id\(\)::text,\s*true\)'
     OR v_src !~ 'PERFORM\s+set_config\(c_withdraw,\s*'''',\s*true\)' THEN
    RAISE EXCEPTION 'driver month assignments self-check 14: the release no longer sets the withdrawal marker for its own transaction, or no longer clears it';
  END IF;

  -- 15. Two properties a one-session self-check cannot see, kept in the source
  --     because the behaviour needs a second session or a table the planner has
  --     stale figures for.
  --     (a) a child write reads its parent FOR KEY SHARE -- never FOR UPDATE,
  --         which deadlocks against the key share a child's own foreign key
  --         check holds -- and that conflicts with the FOR UPDATE the commit
  --         takes on the parent;
  --     (b) "a driver is never in two places at once" is one pass over his
  --         windows in both RPCs that ask it, and never a join of
  --         driver_month_assignment_shifts with itself.
  v_src := app_private.function_code('app_private.driver_month_assignment_parent_is_open(uuid,uuid)');
  IF v_src !~ 'WHERE\s+a\.id\s*=\s*p_assignment_id\s+FOR\s+KEY\s+SHARE\s*;'
     OR v_src ~* 'FOR\s+UPDATE' THEN
    RAISE EXCEPTION 'driver month assignments self-check 15: parent_is_open no longer reads the assignment FOR KEY SHARE, or took a FOR UPDATE that deadlocks two child writes';
  END IF;
  FOREACH v_sig IN ARRAY ARRAY['public.driver_month_assignment_save(jsonb)',
                               'public.driver_month_assignment_commit(uuid)'] LOOP
    v_src := app_private.function_code(v_sig);
    IF v_src !~ 'ROWS\s+BETWEEN\s+UNBOUNDED\s+PRECEDING\s+AND\s+1\s+PRECEDING'
       OR v_src !~ 'w\.earlier_end\s*>\s*w\.starts_local'
       -- 20261022140000's own negative, carried over: the child table is only
       -- ever the FROM of the pass, never the right side of a join, so it is
       -- never compared with itself. (A join to vehicle_day_shifts for the
       -- moments is a different table and is what the pass reads.)
       OR v_src ~* 'JOIN\s+public\.driver_month_assignment_shifts' THEN
      RAISE EXCEPTION 'driver month assignments self-check 15: % lost its single-pass overlap check, or compares the windows by joining the child table with itself', v_sig;
    END IF;
  END LOOP;
  v_src := app_private.function_code('public.driver_month_assignment_commit(uuid)');
  IF v_src !~ 'WHERE\s+a\.id\s*=\s*p_assignment_id\s+FOR\s+UPDATE\s*;' THEN
    RAISE EXCEPTION 'driver month assignments self-check 15: driver_month_assignment_commit no longer reads the assignment FOR UPDATE under the lock';
  END IF;
  v_src := app_private.function_code('public.driver_month_assignment_release(uuid,text,text)');
  IF v_src !~ 'WHERE\s+a\.id\s*=\s*p_assignment_id\s+FOR\s+UPDATE\s*;' THEN
    RAISE EXCEPTION 'driver month assignments self-check 15: driver_month_assignment_release no longer reads the assignment FOR UPDATE under the lock';
  END IF;

  RAISE NOTICE 'driver month assignments self-check: passed';
END $mig$;
