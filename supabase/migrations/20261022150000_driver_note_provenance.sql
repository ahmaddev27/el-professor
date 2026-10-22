-- ════════════════════════════════════════════════════════════════════════════
--  A driver note says where it came from, how sure anyone is, and when it
--  happened as opposed to when it was typed
-- ════════════════════════════════════════════════════════════════════════════
--
--  `driver_notes` is already the driver-events table: a type from a closed list
--  of ten, a planning effect tied to it (20261022143000), a window, a driver, a
--  car, an author. What it never said is what a reader needs in order to weigh
--  one of its rows:
--
--    when did it happen?          one date axis, `note_date`, plus `created_at`
--    who says so, and how?        `created_by` is whatever the client sent
--    is there a document?         no column for one
--    where was it?                no position
--    has anyone checked it?       no status
--    who changed it, and what?    `updated_at`, and nothing about the change
--
--  A Blitzer is the case that decides the design. The fine arrives weeks after
--  the event, and a `must_include_in_plan` note is read as evidence that the
--  driver was at the wheel at that moment. A note whose only date is the day
--  somebody typed it, or whose "verified" cannot be told from "typed", is the
--  claim a wrong date corrupts. This migration adds the columns that tell them
--  apart. It does not add an events engine: the table, its ten types, its four
--  policies and its screen stay what they are.
--
--  ── The three dates ─────────────────────────────────────────────────────────
--
--    occurred_at   when the event happened, as the person recording it states
--                  it. NULL means "not recorded", and it is NULL for every row
--                  that exists today: copying `note_date` or `start_date` into
--                  it would present a date somebody typed for another purpose as
--                  a measurement. The window (`start_date` .. `end_date`, the
--                  times, `is_full_day`) is the planning window and stays the
--                  only date a legacy row has.
--    reported_at   when the source reported it: the date of the authority's
--                  letter, the moment the driver told the office. NULL when
--                  unknown. The driver app does not send one for a note, so a
--                  note that arrives through the partner door leaves it NULL.
--    received_at   when this system received the row. Stamped here, in a BEFORE
--                  trigger, and never the client's: `created_at` has the same
--                  default but a client can write it, this one it cannot. NULL
--                  only on a `legacy` row (below).
--
--  An event is not reported before it happened, so `occurred_at <= reported_at`
--  when both are set (`driver_notes_occurred_not_after_reported`). Nothing orders
--  either against `received_at`: a phone's clock is not the server's, and a
--  planned inspection ("Kontrollfahrt eingeplant") is a note about a future time.
--
--  ── Where a row came from: `entry_source` ───────────────────────────────────
--
--    manual      a signed-in person wrote it (the Notizen screen)
--    driver_app  it arrived through the partner door (created_by NULL, a
--                submitted_by_name, and no session)
--    system      anything else with no session: a migration, a repair script
--    legacy      the row predates this migration; its channel was not recorded
--
--  The trigger decides it; a client's value is overwritten. `legacy` is an
--  explicit word and not a NULL so that "we did not record it" cannot be
--  mistaken for "we forgot to stamp it". Existing rows get it from the column
--  default at ADD COLUMN, which writes no row: this migration contains no UPDATE
--  of `driver_notes`, so no `updated_at` moves and no row is rewritten. That
--  matters twice: it is what "never silently rewrite a stored row" means, and an
--  UPDATE would be refused on a database where `driver_notes_behavior_follows_type`
--  stayed NOT VALID, because PostgreSQL checks a NOT VALID constraint on every
--  UPDATE of a row that breaks it (measured in tests/rls/note-type-constraint.sql).
--
--  ── What the trigger also stops being the client's ──────────────────────────
--
--  The Notizen screen sends `created_by` on every save, edits included, so
--  editing a colleague's note made the editor its author. The policies do not
--  look at `created_by`, so a member could also file a note in someone else's
--  name, or set `submitted_by_name` to pass it off as the driver's own. For a
--  caller with a session the trigger now writes `created_by` from `auth.uid()`
--  on INSERT, pins it on UPDATE, and forces `submitted_by_name` to NULL on
--  INSERT (it belongs to the partner door) and pins it afterwards. A writer with
--  no session (the service role, a migration, psql) is trusted infrastructure
--  and may still repair these. This is the one place the migration changes
--  behaviour a user could see; no screen shows `created_by` (the Notizen export
--  prints it as an id).
--
--  ── A document: `evidence_path` ─────────────────────────────────────────────
--
--  A bucket key and never a URL (a signed URL expires and a public one lets
--  anyone who saw it once read a driver's document: 20261008140000 has the
--  account). One file per note, in the private `documents` bucket, whose four
--  policies already read as "the company" and write as "the membership or a
--  support session", so no storage policy is added or restated here.
--
--  It is a CHECK and not a function, for the reason 20261008140000 gives and a
--  second one. The key is derived in one place in the browser, but the column is
--  written by anyone who holds the page right, and a rule that lives in one
--  function is lost silently by the next writer. And a CHECK is evaluated as the
--  role that writes the row; `authenticated` has no USAGE on `app_private`
--  (20261022143000 measured what a CHECK that calls into it does: the owner's
--  insert passes and every note `authenticated` writes dies 42501). So the
--  constraint is a literal expression that calls nothing outside pg_catalog, and
--  the self-check asserts that for every CHECK on the table.
--
--  The shape is stricter than `receipts_document_prefix`, which asks only for the
--  company's folder and so admits `<company>/../<other>/x` and any extension.
--  Here the key is `<company_id>/driver-notes/<note_id>/<uuid>.<ext>` with
--  `<ext>` one of pdf, jpg, jpeg, png, webp:
--    - the company folder is what the storage policies key on, so a key into
--      another company's folder is a key the company could not read;
--    - the note's own id in the path ties a file to one note;
--    - a generated file name carries nothing about the person (an uploaded
--      "Bussgeld_Mueller.pdf" would), and cannot collide;
--    - no SVG or HTML: a document served inline from the API origin executes
--      its script (20260928100000 has the account), and this list is what stands
--      between a stored key and that.
--  A NULL company_id with a path is refused, which `receipts_document_prefix`
--  lets through ("older rows"): there are no older rows here.
--
--  ── Has anyone checked it: `verification_status` ────────────────────────────
--
--  The reviewable shape the partner submissions use (20261005140000):
--  `unverified` (the default, and what every row is), `verified`, `rejected`;
--  who and when; a reason that is mandatory for a rejection, because "rejected,
--  no reason" is what nobody can act on. Three differences from a submission,
--  each deliberate:
--    - A note is edited, a submission is settled. So the reviewer and the time
--      are stamped by the trigger from the session, and the client's values for
--      them are ignored.
--    - A review is of what was on the page when it was made. If the facts of the
--      note change afterwards (the date, the place, the car, the driver, the
--      type, the window, the document, the text) a decision goes back to
--      `unverified`, and the log says it did. A status that stays on altered
--      data is the thing this column exists to prevent. A change made together
--      with a new decision is not reset: the reviewer decided after seeing it.
--    - Nothing here stops the author from verifying their own note, or limits
--      review to administrators: it asks the same page right as writing the note.
--      `reviewed_by` and `created_by` are both on the row, so a screen or a
--      later CHECK can say it. That is the owner's call, written up in HANDOFF.
--
--  Nothing reads `verification_status` but the Notizen screen, and the planner
--  does not look at it (below): a rejected `must_include_in_plan` note still
--  pins the driver. Whether it should is also written up, not decided.
--
--  ── Where: `latitude`, `longitude`, `location_accuracy_m` ───────────────────
--
--  A pair or nothing, inside the globe, an accuracy (a radius in metres) only
--  with a position and within 0..100000. Not the Germany bounding box that
--  `trip_analysis_settings` uses for the Betriebssitz: a breakdown on a trip to
--  Salzburg is a real note. Both coordinates are redacted from the support-write
--  audit (below). Nothing in the product writes them yet; the driver app is the
--  natural source, and that is another repository.
--
--  ── Who changed it: `change_log` ────────────────────────────────────────────
--
--  An array the trigger appends to, in the shape of `driver_month_budget`'s
--  `recompute_log` (20260922110000): one entry per UPDATE that changed a tracked
--  field, `{at, by, changed: [...], previous: {...}}`, plus `verification_reset`
--  when the trigger itself took a decision back. `previous` holds the old value
--  of the structured fields only. A free-text field is named in `changed` and
--  its old text is not kept: `note_text` is the one column the support-write
--  audit already treats as too sensitive to copy ("krank" may say why), and a
--  log that preserved every earlier wording would keep a diagnosis somebody typed
--  and then corrected. `note_date` is not tracked: the Notizen screen recomputes
--  it, to the minute, on every save.
--
--  The log lives in the row, not in a table of its own. A second table would
--  need its policies, both context triggers, a line in the backup list and in the
--  matrix, and would outlive the note it describes. What that costs is stated:
--  deleting a note deletes its history, and so does deleting its author's account
--  (`created_by` cascades from auth.users, which predates this migration).
--
--  ── What the planner reads, and why nothing here moves it ───────────────────
--
--  Read from the code on 22.10.2026, not measured on data. Three families read
--  `driver_notes`, and none of them reads `created_at`, `updated_at`, or any
--  column added here:
--
--    exclusions       MonatsplanungAssignmentPreview, HistoricalWorkingHours-
--                     Wizard, the Gehaltsabweichung section of Monatsplanung-
--                     StundennachweisPreview: `exclude_from_plan` only; the
--                     WINDOW, via `noteExclusionIntervals` (start_date, or the
--                     date part of note_date when it is NULL; end_date; the
--                     times; is_full_day).
--    monthly plan     MonthlyPlanPage / availability.ts: both effects; the same
--                     window, plus `car_id` for a must_include pin.
--    Stundennachweis  StundennachweisPage `applyMustIncludeNotesToRows`: a
--                     `must_include_in_plan` note is placed by `note_date`
--                     ALONE. Its date picks the row and its time of day, +-30
--                     minutes, becomes a shift; the window is ignored there. And
--                     the Notizen form has no input for that time of day: for a
--                     new note it is the clock time at which the dialog was
--                     opened. So on the sheet that goes to the Steuerberater a
--                     Pflichtnotiz is placed around the moment it was TYPED,
--                     which is the conflation this migration exists to make
--                     visible. It is left exactly as it is: moving it moves a
--                     statutory document, and that is the owner's call.
--
--  Every one of those reads names its columns, none uses `*` (the Notizen screen
--  does, and feeds no engine), and no policy mentions a column added here. The
--  self-check asserts the last; `src/utils/noteProvenanceSafety.test.ts` asserts
--  the others. So this migration cannot change a plan or a Stundennachweis.
--
--  ── The support-write audit ─────────────────────────────────────────────────
--
--  `record_support_write` copies the changed columns of a row written inside a
--  support session, and `support_write_redaction_pattern` says which are replaced
--  by a marker. `rejected_reason` is free text about a person's report and
--  `latitude` / `longitude` are where a driver was: both are added to the
--  `driver_notes` arm beside `note_text`. The function is changed by a splice
--  from the catalogue, anchored on the one `'note_text'` it contains, and the
--  migration proves that every other table's pattern is character for character
--  what it was. `change_log` is an array of objects, which the audit already
--  records as its size only.
--
--  ── Considered and not done ─────────────────────────────────────────────────
--
--    - A table of events or of revisions. See "Who changed it".
--    - Several documents per note. One column; a child table is the next step if
--      a Blitzer needs the letter and the photo, and it would be this table's
--      first child.
--    - Copying `note_date` into `occurred_at` for existing rows, or defaulting
--      `occurred_at` to the window in the form. Both present a typed date as a
--      measured one.
--    - Letting the planner use `occurred_at`. A separate slice, and a decision.
--    - A NOT VALID start. Every new rule is true of every existing row by
--      construction (they are all `legacy` and `unverified`, with nothing else
--      set), so there is nothing to defer.
--
--  ── Rolling back ────────────────────────────────────────────────────────────
--
--  The release before this one writes notes without these columns, and the
--  trigger stamps them; it edits notes, and `created_by` is pinned. Nothing it
--  reads is gone. No SCHEMA_EPOCH bump.

-- ─── 1. the columns ─────────────────────────────────────────────────────────

ALTER TABLE public.driver_notes
  ADD COLUMN IF NOT EXISTS occurred_at         timestamptz,
  ADD COLUMN IF NOT EXISTS reported_at         timestamptz,
  ADD COLUMN IF NOT EXISTS received_at         timestamptz,
  ADD COLUMN IF NOT EXISTS entry_source        text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS evidence_path       text,
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS reviewed_by         uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_reason     text,
  ADD COLUMN IF NOT EXISTS latitude            double precision,
  ADD COLUMN IF NOT EXISTS longitude           double precision,
  ADD COLUMN IF NOT EXISTS location_accuracy_m double precision,
  ADD COLUMN IF NOT EXISTS change_log          jsonb NOT NULL DEFAULT '[]'::jsonb;

-- The 'legacy' default existed to label the rows that were already there, and a
-- stored row keeps it after the default is gone. From here on a row's source is
-- whatever the trigger stamps, never a default somebody forgot to override.
ALTER TABLE public.driver_notes ALTER COLUMN entry_source DROP DEFAULT;

-- ─── 2. the rules, as CHECKs that call nothing ──────────────────────────────
--
--  Each has a name of its own so that a refusal says which rule spoke. PostgreSQL
--  checks them in name order, which is why a stranger status is reported by
--  `driver_notes_verification_status_known` and not by the review-stamp rule: that
--  one has an ELSE true, the way 20261022143000's pairing rule does.

ALTER TABLE public.driver_notes DROP CONSTRAINT IF EXISTS driver_notes_entry_source_known;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_entry_source_known
  CHECK (entry_source IN ('manual', 'driver_app', 'system', 'legacy'));

ALTER TABLE public.driver_notes DROP CONSTRAINT IF EXISTS driver_notes_received_at_unless_legacy;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_received_at_unless_legacy
  CHECK (entry_source = 'legacy' OR received_at IS NOT NULL);

ALTER TABLE public.driver_notes DROP CONSTRAINT IF EXISTS driver_notes_occurred_not_after_reported;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_occurred_not_after_reported
  CHECK (occurred_at IS NULL OR reported_at IS NULL OR occurred_at <= reported_at);

-- The key, exactly. `$` ends the string here (PostgreSQL's regular expressions
-- are not newline-sensitive by default; the self-check probes a trailing newline).
ALTER TABLE public.driver_notes DROP CONSTRAINT IF EXISTS driver_notes_evidence_path_shape;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_evidence_path_shape
  CHECK (
    evidence_path IS NULL
    OR (company_id IS NOT NULL
        AND evidence_path ~ ('^' || company_id::text || '/driver-notes/' || id::text
                             || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png|webp)$'))
  );

ALTER TABLE public.driver_notes DROP CONSTRAINT IF EXISTS driver_notes_location_pair;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_location_pair
  CHECK ((latitude IS NULL) = (longitude IS NULL));

-- BETWEEN is false for NaN, which PostgreSQL orders above every number, and for
-- the infinities, so none of the three can be stored.
ALTER TABLE public.driver_notes DROP CONSTRAINT IF EXISTS driver_notes_location_range;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_location_range
  CHECK ((latitude  IS NULL OR latitude  BETWEEN -90  AND 90)
     AND (longitude IS NULL OR longitude BETWEEN -180 AND 180));

ALTER TABLE public.driver_notes DROP CONSTRAINT IF EXISTS driver_notes_location_accuracy;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_location_accuracy
  CHECK (location_accuracy_m IS NULL
         OR (latitude IS NOT NULL AND location_accuracy_m BETWEEN 0 AND 100000));

ALTER TABLE public.driver_notes DROP CONSTRAINT IF EXISTS driver_notes_verification_status_known;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_verification_status_known
  CHECK (verification_status IN ('unverified', 'verified', 'rejected'));

ALTER TABLE public.driver_notes DROP CONSTRAINT IF EXISTS driver_notes_review_stamp;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_review_stamp
  CHECK (
    CASE verification_status
      WHEN 'unverified' THEN reviewed_by IS NULL     AND reviewed_at IS NULL
      WHEN 'verified'   THEN reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      WHEN 'rejected'   THEN reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      ELSE true
    END
  );

ALTER TABLE public.driver_notes DROP CONSTRAINT IF EXISTS driver_notes_rejection_has_reason;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_rejection_has_reason
  CHECK (verification_status <> 'rejected' OR btrim(coalesce(rejected_reason, '')) <> '');

ALTER TABLE public.driver_notes DROP CONSTRAINT IF EXISTS driver_notes_reason_only_when_rejected;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_reason_only_when_rejected
  CHECK (rejected_reason IS NULL OR verification_status = 'rejected');

ALTER TABLE public.driver_notes DROP CONSTRAINT IF EXISTS driver_notes_change_log_is_array;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_change_log_is_array
  CHECK (jsonb_typeof(change_log) = 'array');

-- ─── 3. the guard: what is stamped, what is pinned, what is logged ──────────
--
--  SECURITY DEFINER and in app_private, like `enforce_driver_note_car_company`,
--  for the same reason a trigger of ours always is: it must not depend on what
--  the caller may reach. It reads nothing but NEW, OLD, the clock and the session
--  (`auth.uid()` is a GUC read, independent of the executing role), so the one
--  privilege it needs is the owner's.
--
--  A session is "a signed-in person": auth.uid() is not NULL. The service role,
--  GoTrue, a migration and psql carry none, and are trusted to repair a row.

CREATE OR REPLACE FUNCTION app_private.driver_note_provenance_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- The structured fields whose previous value the log keeps.
  c_kept CONSTANT text[] := ARRAY[
    'company_id', 'driver_id', 'car_id', 'note_type', 'note_planning_behavior',
    'is_full_day', 'start_date', 'end_date', 'start_time', 'end_time',
    'occurred_at', 'reported_at', 'latitude', 'longitude', 'location_accuracy_m',
    'evidence_path', 'verification_status', 'reviewed_by', 'reviewed_at'];
  -- Free text: the log says it changed, never what it said.
  c_text CONSTANT text[] := ARRAY['note_text', 'rejected_reason'];
  -- What a review looked at. A change to any of these after a decision takes the
  -- decision back. Not the planning effect (it follows the type, or is the
  -- operator's own filing), and not note_date (see the header).
  c_reviewed CONSTANT text[] := ARRAY[
    'driver_id', 'car_id', 'note_type', 'is_full_day', 'start_date', 'end_date',
    'start_time', 'end_time', 'occurred_at', 'reported_at', 'latitude', 'longitude',
    'location_accuracy_m', 'evidence_path', 'note_text'];

  v_uid      uuid := auth.uid();
  v_old      jsonb;
  v_new      jsonb;
  v_key      text;
  v_changed  text[]  := '{}';
  v_previous jsonb   := '{}'::jsonb;
  v_decided  boolean;
  v_reset    boolean := false;
BEGIN
  -- ── INSERT: stamp ──────────────────────────────────────────────────────────
  IF TG_OP = 'INSERT' THEN
    IF v_uid IS NOT NULL THEN
      -- A person's note is the person's, whatever the request claims, and it is
      -- born unreviewed and with an empty history.
      NEW.created_by          := v_uid;
      NEW.submitted_by_name   := NULL;
      NEW.entry_source        := 'manual';
      NEW.received_at         := now();
      NEW.verification_status := 'unverified';
      NEW.reviewed_by         := NULL;
      NEW.reviewed_at         := NULL;
      NEW.rejected_reason     := NULL;
      NEW.change_log          := '[]'::jsonb;
    ELSE
      -- No session: the partner door writes created_by NULL and a name, and
      -- nothing else in the product does. An explicit value (a restore) is kept.
      NEW.entry_source := coalesce(NEW.entry_source,
        CASE WHEN NEW.created_by IS NULL AND NEW.submitted_by_name IS NOT NULL
             THEN 'driver_app' ELSE 'system' END);
      NEW.received_at  := coalesce(NEW.received_at, now());
    END IF;
    RETURN NEW;
  END IF;

  -- ── UPDATE ─────────────────────────────────────────────────────────────────
  v_old := to_jsonb(OLD);

  -- Did this statement itself decide? Judged on what the caller sent, before the
  -- stamping below. For a session the reviewer columns are never the caller's,
  -- so only the status and the reason can be a decision; a writer with no
  -- session may also set the reviewer, and that is one too.
  v_decided := NEW.verification_status IS DISTINCT FROM OLD.verification_status
            OR NEW.rejected_reason     IS DISTINCT FROM OLD.rejected_reason
            OR (v_uid IS NULL
                AND (NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
                     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at));

  -- Only this function appends to the log, for everyone.
  NEW.change_log := OLD.change_log;

  IF v_uid IS NOT NULL THEN
    -- Pinned: the screen sends created_by on every save.
    NEW.created_by        := OLD.created_by;
    NEW.submitted_by_name := OLD.submitted_by_name;
    NEW.entry_source      := OLD.entry_source;
    NEW.received_at       := OLD.received_at;

    IF v_decided THEN
      IF NEW.verification_status = 'unverified' THEN
        NEW.reviewed_by := NULL;  NEW.reviewed_at := NULL;  NEW.rejected_reason := NULL;
      ELSE
        NEW.reviewed_by := v_uid; NEW.reviewed_at := now();
        IF NEW.verification_status = 'verified' THEN
          NEW.rejected_reason := NULL;
        END IF;
      END IF;
    ELSE
      NEW.reviewed_by := OLD.reviewed_by;
      NEW.reviewed_at := OLD.reviewed_at;
    END IF;
  END IF;

  -- A decision is of what was on the page when it was made.
  IF OLD.verification_status <> 'unverified' AND NOT v_decided THEN
    v_new := to_jsonb(NEW);
    FOREACH v_key IN ARRAY c_reviewed LOOP
      IF v_old -> v_key IS DISTINCT FROM v_new -> v_key THEN
        v_reset := true;
        EXIT;
      END IF;
    END LOOP;
    IF v_reset THEN
      NEW.verification_status := 'unverified';
      NEW.reviewed_by         := NULL;
      NEW.reviewed_at         := NULL;
      NEW.rejected_reason     := NULL;
    END IF;
  END IF;

  -- The log: what changed, who changed it, and what it was.
  v_new := to_jsonb(NEW);
  FOREACH v_key IN ARRAY c_kept LOOP
    IF v_old -> v_key IS DISTINCT FROM v_new -> v_key THEN
      v_changed  := v_changed || v_key;
      v_previous := v_previous || jsonb_build_object(v_key, v_old -> v_key);
    END IF;
  END LOOP;
  FOREACH v_key IN ARRAY c_text LOOP
    IF v_old -> v_key IS DISTINCT FROM v_new -> v_key THEN
      v_changed := v_changed || v_key;
    END IF;
  END LOOP;

  IF cardinality(v_changed) > 0 THEN
    NEW.change_log := NEW.change_log || jsonb_build_array(
      jsonb_build_object('at', now(), 'by', v_uid,
                         'changed', to_jsonb(v_changed), 'previous', v_previous)
      || CASE WHEN v_reset THEN jsonb_build_object('verification_reset', true)
              ELSE '{}'::jsonb END);
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_private.driver_note_provenance_guard() IS
  'Stamps a driver note''s provenance from the session and the clock and never '
  'from the request (created_by, entry_source, received_at, the reviewer), pins '
  'those columns on UPDATE, takes a verification back when the facts it covered '
  'change, and appends to change_log. A writer with no session may repair them '
  '(20261022150000).';

-- BEFORE triggers fire in name order; this one's name sorts ahead of
-- enforce_driver_note_car_company and the updated_at trigger, and depends on
-- neither of them.
DROP TRIGGER IF EXISTS driver_notes_provenance_guard ON public.driver_notes;
CREATE TRIGGER driver_notes_provenance_guard
  BEFORE INSERT OR UPDATE ON public.driver_notes
  FOR EACH ROW
  EXECUTE FUNCTION app_private.driver_note_provenance_guard();

-- The definer must belong to a role that can reach app_private; CREATE OR REPLACE
-- keeps whatever owner a function already had. Fired by a trigger, never called
-- by a client: triggers do not check EXECUTE, so the REVOKE is the second wall
-- behind the missing USAGE on app_private.
ALTER FUNCTION app_private.driver_note_provenance_guard() OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION app_private.driver_note_provenance_guard()
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 4. the support-write audit does not copy the new free text or position ─
--
--  Spliced from the catalogue, not restated: whatever the function says now is
--  kept, and the one anchor must occur exactly once. Re-running is a no-op.

DO $splice$
DECLARE
  c_tables CONSTANT text[] := ARRAY[
    'salaries', 'salary_payments', 'salary_cash_receipts', 'cash_movements',
    'planning_run_adjustments', 'historical_reconciliation_wh_drivers',
    'driver_notes', 'document_variables', 'drivers', 'cars', 'no_such_table'];
  v_def    text;
  v_hits   int;
  v_before jsonb;
  v_after  jsonb;
  v_t      text;
BEGIN
  v_def := pg_catalog.pg_get_functiondef(
             'app_private.support_write_redaction_pattern(text)'::regprocedure);

  IF position('rejected_reason' IN v_def) > 0 THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_hits FROM regexp_matches(v_def, '''note_text''', 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      '20261022150000: expected the literal ''note_text'' exactly once in app_private.support_write_redaction_pattern, found %. The function was changed since 20260920110000; extend it by hand rather than guess.', v_hits;
  END IF;

  SELECT jsonb_object_agg(t, app_private.support_write_redaction_pattern(t))
    INTO v_before FROM unnest(c_tables) AS t;

  EXECUTE replace(v_def, '''note_text''', '''note_text|rejected_reason|latitude|longitude''');

  SELECT jsonb_object_agg(t, app_private.support_write_redaction_pattern(t))
    INTO v_after FROM unnest(c_tables) AS t;

  FOREACH v_t IN ARRAY c_tables LOOP
    IF v_t = 'driver_notes' THEN
      IF v_after ->> v_t IS DISTINCT FROM
         replace(v_before ->> v_t, 'note_text', 'note_text|rejected_reason|latitude|longitude') THEN
        RAISE EXCEPTION '20261022150000: the driver_notes redaction pattern is not the old one plus the three new alternatives';
      END IF;
    ELSIF v_after ->> v_t IS DISTINCT FROM v_before ->> v_t THEN
      RAISE EXCEPTION '20261022150000: the redaction pattern for % changed, and it must not have', v_t;
    END IF;
  END LOOP;
END
$splice$;

-- ─── 5. what the columns say, for whoever meets them ────────────────────────

COMMENT ON COLUMN public.driver_notes.occurred_at IS
  'When the event happened, as the person recording it states it. NULL = not '
  'recorded, for every row that predates 20261022150000 and for every note that '
  'is a window rather than an event (sick, vacation). Never derived from note_date '
  'or the window. The planner does not read it.';
COMMENT ON COLUMN public.driver_notes.reported_at IS
  'When the source reported the event: the date of the authority''s letter, the '
  'moment the driver told the office. NULL = unknown. occurred_at <= reported_at.';
COMMENT ON COLUMN public.driver_notes.received_at IS
  'When this system received the row. Stamped by the provenance trigger for a '
  'caller with a session, immutable for one, NULL only when entry_source = legacy.';
COMMENT ON COLUMN public.driver_notes.entry_source IS
  'How the row got in, stamped by the trigger: manual (a signed-in person), '
  'driver_app (the partner door), system (another writer with no session), legacy '
  '(predates the column; the channel was not recorded).';
COMMENT ON COLUMN public.driver_notes.evidence_path IS
  'The key of one document in the private documents bucket, as '
  '<company_id>/driver-notes/<note_id>/<uuid>.<pdf|jpg|jpeg|png|webp>. A bucket '
  'key and never a URL. Pinned by driver_notes_evidence_path_shape.';
COMMENT ON COLUMN public.driver_notes.verification_status IS
  'unverified (every row starts here), verified or rejected. The reviewer and the '
  'time are stamped by the trigger; a change to what the review covered takes a '
  'decision back to unverified. The planner does not read it.';
COMMENT ON COLUMN public.driver_notes.reviewed_by IS
  'The account that verified or rejected the note, from the session. No foreign '
  'key: a review outlives the account that made it.';
COMMENT ON COLUMN public.driver_notes.reviewed_at IS
  'When it was verified or rejected. NULL while unverified.';
COMMENT ON COLUMN public.driver_notes.rejected_reason IS
  'Why a rejected note was rejected. Mandatory for a rejection, NULL otherwise. '
  'Free text about a person''s report, so the support-write audit does not copy it.';
COMMENT ON COLUMN public.driver_notes.latitude IS
  'Where the event was, with longitude and optionally location_accuracy_m. Both or '
  'neither. Not copied into the support-write audit.';
COMMENT ON COLUMN public.driver_notes.longitude IS
  'See latitude.';
COMMENT ON COLUMN public.driver_notes.location_accuracy_m IS
  'The radius of uncertainty of the position, in metres, 0..100000. Only with a position.';
COMMENT ON COLUMN public.driver_notes.change_log IS
  'Appended to by the trigger only: one entry per UPDATE that changed a tracked '
  'field, {at, by, changed, previous} (+ verification_reset). previous keeps old '
  'values of structured fields, never old free text. Leaves with the note.';

-- ─── 6. self-check ──────────────────────────────────────────────────────────
--
--  Block 1 reads the catalogue. Block 2 runs the rules on two throwaway copies of
--  the table (same columns, defaults and CHECKs, no foreign keys, no policies),
--  one without the trigger, so that every constraint can be reached by itself,
--  and one with it. Copies, because the real table's foreign keys would turn
--  every admitted row into an error and make the refusals the only thing visible;
--  copies of the real constraints, so what is tested is what the table has. A
--  session is simulated by setting the claims, which is all `auth.uid()` reads.

DO $check$
DECLARE
  r        record;
  v_n      int;
  v_txt    text;
  v_fn     regprocedure := 'app_private.driver_note_provenance_guard()'::regprocedure;
  v_bad    text;
BEGIN
  -- 1. The thirteen columns: type, nullability, default.
  FOR r IN
    SELECT * FROM (VALUES
      ('occurred_at',         'timestamp with time zone', false, false),
      ('reported_at',         'timestamp with time zone', false, false),
      ('received_at',         'timestamp with time zone', false, false),
      ('entry_source',        'text',                     true,  false),
      ('evidence_path',       'text',                     false, false),
      ('verification_status', 'text',                     true,  true),
      ('reviewed_by',         'uuid',                     false, false),
      ('reviewed_at',         'timestamp with time zone', false, false),
      ('rejected_reason',     'text',                     false, false),
      ('latitude',            'double precision',         false, false),
      ('longitude',           'double precision',         false, false),
      ('location_accuracy_m', 'double precision',         false, false),
      ('change_log',          'jsonb',                    true,  true)
    ) AS v(col, typ, not_null, hasdef)
  LOOP
    SELECT count(*) INTO v_n
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.driver_notes'::regclass
       AND a.attname = r.col AND NOT a.attisdropped
       AND pg_catalog.format_type(a.atttypid, a.atttypmod) = r.typ
       AND a.attnotnull = r.not_null
       AND a.atthasdef  = r.hasdef;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'self-check 1: driver_notes.% is missing or is not % (not null: %, default: %)',
        r.col, r.typ, r.not_null, r.hasdef;
    END IF;
  END LOOP;

  -- 2. The twelve CHECKs exist, as CHECKs, validated.
  FOR r IN
    SELECT unnest(ARRAY[
      'driver_notes_entry_source_known', 'driver_notes_received_at_unless_legacy',
      'driver_notes_occurred_not_after_reported', 'driver_notes_evidence_path_shape',
      'driver_notes_location_pair', 'driver_notes_location_range',
      'driver_notes_location_accuracy', 'driver_notes_verification_status_known',
      'driver_notes_review_stamp', 'driver_notes_rejection_has_reason',
      'driver_notes_reason_only_when_rejected', 'driver_notes_change_log_is_array']) AS name
  LOOP
    SELECT count(*) INTO v_n
      FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.driver_notes'::regclass
       AND c.conname = r.name AND c.contype = 'c' AND c.convalidated;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'self-check 2: driver_notes has no validated CHECK named %', r.name;
    END IF;
  END LOOP;

  -- 3. No CHECK on the table calls a function outside pg_catalog. A CHECK runs as
  --    the writing role, which cannot execute anything in app_private, and the
  --    call is refused for every row, not only the ones that reach it. The
  --    assertion covers the CHECKs this migration did not write too.
  SELECT string_agg(c.conname || ' -> ' || d.refobjid::regprocedure::text, ', ')
    INTO v_txt
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_depend d
      ON d.classid = 'pg_catalog.pg_constraint'::regclass AND d.objid = c.oid
     AND d.refclassid = 'pg_catalog.pg_proc'::regclass
    JOIN pg_catalog.pg_proc p ON p.oid = d.refobjid
   WHERE c.conrelid = 'public.driver_notes'::regclass
     AND c.contype = 'c'
     AND p.pronamespace <> 'pg_catalog'::regnamespace;
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION
      'self-check 3: a CHECK on driver_notes depends on a function outside pg_catalog (%). It runs as the writing role, which cannot execute app_private.*; every note authenticated writes would die 42501.', v_txt;
  END IF;

  -- 4. The trigger: BEFORE, per row, INSERT and UPDATE, our function.
  SELECT count(*) INTO v_n
    FROM pg_catalog.pg_trigger t
   WHERE t.tgrelid = 'public.driver_notes'::regclass
     AND t.tgname = 'driver_notes_provenance_guard' AND NOT t.tgisinternal
     AND t.tgfoid = v_fn
     AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2
     AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16
     AND (t.tgtype & 8) = 0 AND (t.tgtype & 32) = 0;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'self-check 4: driver_notes_provenance_guard is missing, or is not BEFORE INSERT OR UPDATE FOR EACH ROW on app_private.driver_note_provenance_guard()';
  END IF;

  -- 5. The function: definer, pinned search_path, an owner that reaches
  --    app_private, and no EXECUTE for an API role.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = v_fn AND p.prosecdef) THEN
    RAISE EXCEPTION 'self-check 5: the provenance guard is SECURITY INVOKER; as the caller it could not reach what it needs and would not stamp what the caller must not choose';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, unnest(p.proconfig) AS c(setting)
                  WHERE p.oid = v_fn AND c.setting = 'search_path=pg_catalog, public') THEN
    RAISE EXCEPTION 'self-check 5: the provenance guard must pin SET search_path = pg_catalog, public';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
                  WHERE p.oid = v_fn
                    AND (o.rolsuper OR o.oid = (SELECT nspowner FROM pg_catalog.pg_namespace
                                                 WHERE nspname = 'app_private'))) THEN
    RAISE EXCEPTION 'self-check 5: the provenance guard''s owner cannot reach app_private';
  END IF;
  IF pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check 5: the provenance guard is executable by an API role; it is only ever fired by a trigger';
  END IF;

  -- 6. No policy on the table reads a column added here: none of them is a
  --    tenancy term, and none may steer who reads or writes a note.
  SELECT string_agg(pol.policyname, ', ' ORDER BY pol.policyname)
    INTO v_bad
    FROM pg_catalog.pg_policies pol
   WHERE pol.schemaname = 'public' AND pol.tablename = 'driver_notes'
     AND (coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, ''))
         ~ '\m(occurred_at|reported_at|received_at|entry_source|evidence_path|verification_status|reviewed_by|reviewed_at|rejected_reason|latitude|longitude|location_accuracy_m|change_log)\M';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'self-check 6: a policy on driver_notes reads a provenance column (%): provenance records a note and must never decide who may read or write it', v_bad;
  END IF;

  -- 7. The table's own guards are still wired: this migration adds a trigger and
  --    removes none. Asserted where the shape exists.
  IF pg_catalog.to_regprocedure('app_private.refuse_read_only_context_write()') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                      WHERE t.tgrelid = 'public.driver_notes'::regclass AND NOT t.tgisinternal
                        AND t.tgfoid = 'app_private.refuse_read_only_context_write()'::regprocedure) THEN
    RAISE EXCEPTION 'self-check 7: driver_notes has lost refuse_read_only_context_write';
  END IF;
  IF pg_catalog.to_regprocedure('app_private.record_support_write()') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                      WHERE t.tgrelid = 'public.driver_notes'::regclass AND NOT t.tgisinternal
                        AND t.tgfoid = 'app_private.record_support_write()'::regprocedure) THEN
    RAISE EXCEPTION 'self-check 7: driver_notes has lost record_support_write';
  END IF;
  IF pg_catalog.to_regprocedure('app_private.enforce_driver_note_car_company()') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                      WHERE t.tgrelid = 'public.driver_notes'::regclass AND NOT t.tgisinternal
                        AND t.tgfoid = 'app_private.enforce_driver_note_car_company()'::regprocedure) THEN
    RAISE EXCEPTION 'self-check 7: driver_notes has lost enforce_driver_note_car_company';
  END IF;

  -- 8. The audit redacts the new free text and the position, and still redacts
  --    the old, and still copies the vehicle, the document key and the times.
  SELECT app_private.support_write_redaction_pattern('driver_notes') INTO v_txt;
  IF NOT ('note_text' ~ v_txt AND 'rejected_reason' ~ v_txt
          AND 'latitude' ~ v_txt AND 'longitude' ~ v_txt) THEN
    RAISE EXCEPTION 'self-check 8: the support-write audit would copy note_text, rejected_reason or a coordinate';
  END IF;
  IF 'car_id' ~ v_txt OR 'evidence_path' ~ v_txt OR 'occurred_at' ~ v_txt
     OR 'reported_at' ~ v_txt OR 'received_at' ~ v_txt OR 'entry_source' ~ v_txt
     OR 'verification_status' ~ v_txt OR 'location_accuracy_m' ~ v_txt THEN
    RAISE EXCEPTION 'self-check 8: the support-write audit now redacts a column this migration meant it to keep (%): widening it is a data-protection decision', v_txt;
  END IF;
END
$check$;

DO $check$
DECLARE
  c_co    CONSTANT uuid := '00000000-0000-4000-8000-0000000000c0';
  c_other CONSTANT uuid := '00000000-0000-4000-8000-0000000000c1';
  c_u1    CONSTANT uuid := '00000000-0000-4000-8000-0000000000a1';
  c_u2    CONSTANT uuid := '00000000-0000-4000-8000-0000000000a2';
  c_drv   CONSTANT uuid := '00000000-0000-4000-8000-0000000000d0';
  c_note  CONSTANT uuid := '00000000-0000-4000-8000-0000000000e0';
  c_file  CONSTANT uuid := '00000000-0000-4000-8000-0000000000f0';

  v_got   text;
  v_txt   text;
  v_row   record;
  v_log   jsonb;
  v_n     int;
  v_case  record;
BEGIN
  -- ── the two copies ───────────────────────────────────────────────────────
  CREATE TEMP TABLE _dn_rules (LIKE public.driver_notes INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
    ON COMMIT DROP;
  CREATE TEMP TABLE _dn_guard (LIKE public.driver_notes INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
    ON COMMIT DROP;
  CREATE TRIGGER _dn_guard_trg BEFORE INSERT OR UPDATE ON _dn_guard
    FOR EACH ROW EXECUTE FUNCTION app_private.driver_note_provenance_guard();

  -- The statement helper: what a statement did, by the rule that spoke.
  CREATE FUNCTION pg_temp.dn_try(p_sql text) RETURNS text
  LANGUAGE plpgsql AS $f$
  DECLARE v_con text;
  BEGIN
    EXECUTE p_sql;
    RETURN 'ok';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
      RETURN 'refused:' || v_con;
    WHEN OTHERS THEN
      RETURN 'error:' || SQLSTATE;
  END $f$;

  -- ── 3. the CHECKs by themselves (copy without the trigger) ───────────────
  --  Every case is a row of (what is inserted, what must be said). `ok` is the
  --  baseline row that carries nothing; a case changes one rule at a time.
  FOR v_case IN
    SELECT * FROM (VALUES
      -- entry_source and received_at
      ('src ok',              'entry_source, received_at', $q$'manual', now()$q$,        'ok'),
      ('legacy no stamp',     'entry_source',              $q$'legacy'$q$,               'ok'),
      ('stranger source',     'entry_source, received_at', $q$'import', now()$q$,        'refused:driver_notes_entry_source_known'),
      ('manual w/o received', 'entry_source',              $q$'manual'$q$,               'refused:driver_notes_received_at_unless_legacy'),
      ('system w/o received', 'entry_source',              $q$'system'$q$,               'refused:driver_notes_received_at_unless_legacy'),
      -- the three dates
      ('occurred only',       'entry_source, occurred_at', $q$'legacy', '2026-09-01 14:03+02'$q$, 'ok'),
      ('reported only',       'entry_source, reported_at', $q$'legacy', '2026-10-02 09:00+02'$q$, 'ok'),
      ('occurred = reported', 'entry_source, occurred_at, reported_at', $q$'legacy', '2026-09-01 14:03+02', '2026-09-01 14:03+02'$q$, 'ok'),
      ('occurred < reported', 'entry_source, occurred_at, reported_at', $q$'legacy', '2026-09-01 14:03+02', '2026-10-02 09:00+02'$q$, 'ok'),
      ('occurred > reported', 'entry_source, occurred_at, reported_at', $q$'legacy', '2026-10-02 09:00+02', '2026-09-01 14:03+02'$q$, 'refused:driver_notes_occurred_not_after_reported'),
      -- location
      ('no position',         'entry_source',                         $q$'legacy'$q$,                       'ok'),
      ('a position',          'entry_source, latitude, longitude',    $q$'legacy', 51.5, 7.4$q$,            'ok'),
      ('latitude only',       'entry_source, latitude',               $q$'legacy', 51.5$q$,                 'refused:driver_notes_location_pair'),
      ('longitude only',      'entry_source, longitude',              $q$'legacy', 7.4$q$,                  'refused:driver_notes_location_pair'),
      ('latitude 91',         'entry_source, latitude, longitude',    $q$'legacy', 91, 7.4$q$,              'refused:driver_notes_location_range'),
      ('latitude -90.5',      'entry_source, latitude, longitude',    $q$'legacy', -90.5, 7.4$q$,           'refused:driver_notes_location_range'),
      ('longitude 181',       'entry_source, latitude, longitude',    $q$'legacy', 51.5, 181$q$,            'refused:driver_notes_location_range'),
      ('latitude NaN',        'entry_source, latitude, longitude',    $q$'legacy', 'NaN', 7.4$q$,           'refused:driver_notes_location_range'),
      ('longitude Infinity',  'entry_source, latitude, longitude',    $q$'legacy', 51.5, 'Infinity'$q$,     'refused:driver_notes_location_range'),
      ('the poles',           'entry_source, latitude, longitude',    $q$'legacy', -90, 180$q$,             'ok'),
      ('accuracy 25 m',       'entry_source, latitude, longitude, location_accuracy_m', $q$'legacy', 51.5, 7.4, 25$q$,      'ok'),
      ('accuracy -1',         'entry_source, latitude, longitude, location_accuracy_m', $q$'legacy', 51.5, 7.4, -1$q$,      'refused:driver_notes_location_accuracy'),
      ('accuracy 100001',     'entry_source, latitude, longitude, location_accuracy_m', $q$'legacy', 51.5, 7.4, 100001$q$,  'refused:driver_notes_location_accuracy'),
      ('accuracy NaN',        'entry_source, latitude, longitude, location_accuracy_m', $q$'legacy', 51.5, 7.4, 'NaN'$q$,   'refused:driver_notes_location_accuracy'),
      ('accuracy no position','entry_source, location_accuracy_m',   $q$'legacy', 25$q$,                   'refused:driver_notes_location_accuracy'),
      -- verification
      ('unverified',          'entry_source',                         $q$'legacy'$q$,                       'ok'),
      ('stranger status',     'entry_source, verification_status',    $q$'legacy', 'checked'$q$,            'refused:driver_notes_verification_status_known'),
      ('verified + reviewer', 'entry_source, verification_status, reviewed_by, reviewed_at',
                              $q$'legacy', 'verified', '00000000-0000-4000-8000-0000000000a1', now()$q$,   'ok'),
      ('verified, no reviewer','entry_source, verification_status',   $q$'legacy', 'verified'$q$,           'refused:driver_notes_review_stamp'),
      ('verified, no time',   'entry_source, verification_status, reviewed_by',
                              $q$'legacy', 'verified', '00000000-0000-4000-8000-0000000000a1'$q$,          'refused:driver_notes_review_stamp'),
      ('unverified + reviewer','entry_source, reviewed_by, reviewed_at',
                              $q$'legacy', '00000000-0000-4000-8000-0000000000a1', now()$q$,               'refused:driver_notes_review_stamp'),
      ('rejected + reason',   'entry_source, verification_status, reviewed_by, reviewed_at, rejected_reason',
                              $q$'legacy', 'rejected', '00000000-0000-4000-8000-0000000000a1', now(), 'Datum stimmt nicht'$q$, 'ok'),
      ('rejected, no reason', 'entry_source, verification_status, reviewed_by, reviewed_at',
                              $q$'legacy', 'rejected', '00000000-0000-4000-8000-0000000000a1', now()$q$,   'refused:driver_notes_rejection_has_reason'),
      ('rejected, blank reason','entry_source, verification_status, reviewed_by, reviewed_at, rejected_reason',
                              $q$'legacy', 'rejected', '00000000-0000-4000-8000-0000000000a1', now(), '   '$q$, 'refused:driver_notes_rejection_has_reason'),
      ('verified + reason',   'entry_source, verification_status, reviewed_by, reviewed_at, rejected_reason',
                              $q$'legacy', 'verified', '00000000-0000-4000-8000-0000000000a1', now(), 'x'$q$, 'refused:driver_notes_reason_only_when_rejected'),
      ('unverified + reason', 'entry_source, rejected_reason',        $q$'legacy', 'x'$q$,                  'refused:driver_notes_reason_only_when_rejected'),
      -- the log
      ('log is an array',     'entry_source, change_log',             $q$'legacy', '[]'::jsonb$q$,          'ok'),
      ('log is an object',    'entry_source, change_log',             $q$'legacy', '{}'::jsonb$q$,          'refused:driver_notes_change_log_is_array'),
      ('log is a string',     'entry_source, change_log',             $q$'legacy', '"x"'::jsonb$q$,         'refused:driver_notes_change_log_is_array')
    ) AS t(label, cols, vals, expected)
  LOOP
    v_got := pg_temp.dn_try(format(
      'INSERT INTO _dn_rules (company_id, created_by, driver_id, note_text, %s) VALUES (%L, %L, %L, %L, %s)',
      v_case.cols, c_co, c_u1, c_drv, 'x', v_case.vals));
    IF v_got IS DISTINCT FROM v_case.expected THEN
      RAISE EXCEPTION 'self-check 9: "%" should be %, but is %', v_case.label, v_case.expected, v_got;
    END IF;
    DELETE FROM _dn_rules;
  END LOOP;

  -- The evidence key. The id is chosen so the key can name it.
  FOR v_case IN
    SELECT * FROM (VALUES
      ('pdf',                  c_co::text    || '/driver-notes/' || c_note::text || '/' || c_file::text || '.pdf',  'ok'),
      ('jpg',                  c_co::text    || '/driver-notes/' || c_note::text || '/' || c_file::text || '.jpg',  'ok'),
      ('jpeg',                 c_co::text    || '/driver-notes/' || c_note::text || '/' || c_file::text || '.jpeg', 'ok'),
      ('png',                  c_co::text    || '/driver-notes/' || c_note::text || '/' || c_file::text || '.png',  'ok'),
      ('webp',                 c_co::text    || '/driver-notes/' || c_note::text || '/' || c_file::text || '.webp', 'ok'),
      ('another company',      c_other::text || '/driver-notes/' || c_note::text || '/' || c_file::text || '.pdf',  'refused:driver_notes_evidence_path_shape'),
      ('another note',         c_co::text    || '/driver-notes/' || c_other::text || '/' || c_file::text || '.pdf', 'refused:driver_notes_evidence_path_shape'),
      ('no company folder',    'driver-notes/' || c_note::text || '/' || c_file::text || '.pdf',                    'refused:driver_notes_evidence_path_shape'),
      ('a different folder',   c_co::text    || '/partner/'      || c_note::text || '/' || c_file::text || '.pdf',  'refused:driver_notes_evidence_path_shape'),
      ('traversal',            c_co::text    || '/driver-notes/' || c_note::text || '/../' || c_file::text || '.pdf', 'refused:driver_notes_evidence_path_shape'),
      ('traversal up',         c_co::text    || '/driver-notes/' || c_note::text || '/../../' || c_other::text || '/driver-notes/' || c_note::text || '/' || c_file::text || '.pdf', 'refused:driver_notes_evidence_path_shape'),
      ('nested',               c_co::text    || '/driver-notes/' || c_note::text || '/a/' || c_file::text || '.pdf', 'refused:driver_notes_evidence_path_shape'),
      ('a file name',          c_co::text    || '/driver-notes/' || c_note::text || '/Bussgeld.pdf',                'refused:driver_notes_evidence_path_shape'),
      ('svg',                  c_co::text    || '/driver-notes/' || c_note::text || '/' || c_file::text || '.svg',  'refused:driver_notes_evidence_path_shape'),
      ('html',                 c_co::text    || '/driver-notes/' || c_note::text || '/' || c_file::text || '.html', 'refused:driver_notes_evidence_path_shape'),
      ('no extension',         c_co::text    || '/driver-notes/' || c_note::text || '/' || c_file::text,            'refused:driver_notes_evidence_path_shape'),
      ('upper-case extension', c_co::text    || '/driver-notes/' || c_note::text || '/' || c_file::text || '.PDF',  'refused:driver_notes_evidence_path_shape'),
      ('upper-case file id',   c_co::text    || '/driver-notes/' || c_note::text || '/' || upper(c_file::text) || '.pdf', 'refused:driver_notes_evidence_path_shape'),
      ('trailing space',       c_co::text    || '/driver-notes/' || c_note::text || '/' || c_file::text || '.pdf ', 'refused:driver_notes_evidence_path_shape'),
      ('trailing newline',     c_co::text    || '/driver-notes/' || c_note::text || '/' || c_file::text || E'.pdf\n', 'refused:driver_notes_evidence_path_shape'),
      ('leading slash',        '/' || c_co::text || '/driver-notes/' || c_note::text || '/' || c_file::text || '.pdf', 'refused:driver_notes_evidence_path_shape'),
      ('a URL',                'https://api.example.invalid/' || c_co::text || '/driver-notes/' || c_note::text || '/' || c_file::text || '.pdf', 'refused:driver_notes_evidence_path_shape'),
      ('a signed URL',         c_co::text    || '/driver-notes/' || c_note::text || '/' || c_file::text || '.pdf?token=abc', 'refused:driver_notes_evidence_path_shape'),
      ('empty',                '',                                                                                  'refused:driver_notes_evidence_path_shape')
    ) AS t(label, path, expected)
  LOOP
    v_got := pg_temp.dn_try(format(
      'INSERT INTO _dn_rules (id, company_id, created_by, driver_id, note_text, entry_source, evidence_path) VALUES (%L, %L, %L, %L, %L, %L, %L)',
      c_note, c_co, c_u1, c_drv, 'x', 'legacy', v_case.path));
    IF v_got IS DISTINCT FROM v_case.expected THEN
      RAISE EXCEPTION 'self-check 10: the evidence key "%" should be %, but is %', v_case.label, v_case.expected, v_got;
    END IF;
    DELETE FROM _dn_rules;
  END LOOP;

  -- A path on a row that has no company is refused too (the key names a company).
  v_got := pg_temp.dn_try(format(
    'INSERT INTO _dn_rules (id, company_id, created_by, driver_id, note_text, entry_source, evidence_path) VALUES (%L, NULL, %L, %L, %L, %L, %L)',
    c_note, c_u1, c_drv, 'x', 'legacy',
    c_co::text || '/driver-notes/' || c_note::text || '/' || c_file::text || '.pdf'));
  IF v_got IS DISTINCT FROM 'refused:driver_notes_evidence_path_shape' THEN
    RAISE EXCEPTION 'self-check 10: a key on a note with no company should be refused by the shape rule, but is %', v_got;
  END IF;
  DELETE FROM _dn_rules;

  -- ── 4. the trigger (copy with it) ────────────────────────────────────────
  --  A session is whatever auth.uid() reads. Both spellings are set, because the
  --  function differs between images and live databases (CLAUDE.md, "Platform
  --  staff"). They are reset at the end.

  -- 4a. A signed-in person inserts, claiming everything they should not be able to.
  PERFORM set_config('request.jwt.claim.sub', c_u1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', c_u1, 'role', 'authenticated')::text, true);

  INSERT INTO _dn_guard (id, company_id, driver_id, note_text, created_by, submitted_by_name,
                         entry_source, received_at, verification_status, reviewed_by, reviewed_at,
                         change_log)
  VALUES (c_note, c_co, c_drv, 'x', c_u2, 'Fahrer X', 'driver_app', '2001-01-01 00:00+00',
          'verified', c_u2, now(), '[{"forged": true}]'::jsonb);
  SELECT * INTO v_row FROM _dn_guard WHERE id = c_note;
  IF v_row.created_by IS DISTINCT FROM c_u1 OR v_row.submitted_by_name IS NOT NULL
     OR v_row.entry_source IS DISTINCT FROM 'manual'
     OR v_row.received_at IS NULL OR abs(extract(epoch FROM (now() - v_row.received_at))) > 60
     OR v_row.verification_status IS DISTINCT FROM 'unverified'
     OR v_row.reviewed_by IS NOT NULL OR v_row.reviewed_at IS NOT NULL
     OR v_row.change_log IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'self-check 11: a signed-in person''s INSERT kept something the request claimed: %', to_jsonb(v_row);
  END IF;

  -- 4b. Their next save, as the Notizen screen sends it: created_by of someone
  --     else, the provenance columns echoed back changed, and an edited text.
  UPDATE _dn_guard
     SET created_by = c_u2, submitted_by_name = 'Y', entry_source = 'system',
         received_at = '2001-01-01 00:00+00', change_log = '[]'::jsonb,
         note_text = 'edited'
   WHERE id = c_note;
  SELECT * INTO v_row FROM _dn_guard WHERE id = c_note;
  IF v_row.created_by IS DISTINCT FROM c_u1 OR v_row.submitted_by_name IS NOT NULL
     OR v_row.entry_source IS DISTINCT FROM 'manual'
     OR abs(extract(epoch FROM (now() - v_row.received_at))) > 60 THEN
    RAISE EXCEPTION 'self-check 12: an UPDATE by a signed-in person moved a pinned column: %', to_jsonb(v_row);
  END IF;
  IF jsonb_array_length(v_row.change_log) <> 1
     OR v_row.change_log -> 0 -> 'changed' IS DISTINCT FROM '["note_text"]'::jsonb
     OR v_row.change_log -> 0 -> 'previous' IS DISTINCT FROM '{}'::jsonb
     OR v_row.change_log -> 0 ->> 'by' IS DISTINCT FROM c_u1::text
     OR position('edited' IN v_row.change_log::text) > 0
     OR position('"x"' IN v_row.change_log::text) > 0 THEN
    RAISE EXCEPTION 'self-check 12: the log of a text edit should name note_text, hold no text and name the editor: %', v_row.change_log;
  END IF;

  -- 4c. A second person verifies, claiming another reviewer.
  PERFORM set_config('request.jwt.claim.sub', c_u2::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', c_u2, 'role', 'authenticated')::text, true);
  UPDATE _dn_guard SET verification_status = 'verified', reviewed_by = c_u1,
                       reviewed_at = '2001-01-01 00:00+00'
   WHERE id = c_note;
  SELECT * INTO v_row FROM _dn_guard WHERE id = c_note;
  IF v_row.verification_status IS DISTINCT FROM 'verified'
     OR v_row.reviewed_by IS DISTINCT FROM c_u2
     OR abs(extract(epoch FROM (now() - v_row.reviewed_at))) > 60 THEN
    RAISE EXCEPTION 'self-check 13: a verification must name the session''s account and the clock, not the request: %', to_jsonb(v_row);
  END IF;

  -- 4d. Saving the same note again changes nothing and logs nothing.
  v_n := jsonb_array_length(v_row.change_log);
  UPDATE _dn_guard SET note_text = note_text, created_by = c_u1, reviewed_by = c_u1 WHERE id = c_note;
  SELECT * INTO v_row FROM _dn_guard WHERE id = c_note;
  IF v_row.verification_status IS DISTINCT FROM 'verified' OR v_row.reviewed_by IS DISTINCT FROM c_u2
     OR jsonb_array_length(v_row.change_log) <> v_n THEN
    RAISE EXCEPTION 'self-check 14: a save that changes nothing changed the note or its log: %', to_jsonb(v_row);
  END IF;

  -- 4e. What is not part of the review does not take it back: the planning
  --     effect and note_date. What is, does.
  UPDATE _dn_guard SET note_planning_behavior = 'must_include_in_plan',
                       note_date = note_date + interval '1 minute'
   WHERE id = c_note;
  SELECT * INTO v_row FROM _dn_guard WHERE id = c_note;
  IF v_row.verification_status IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'self-check 15: changing the planning effect or note_date took a verification back';
  END IF;

  UPDATE _dn_guard SET occurred_at = '2026-09-01 14:03+02' WHERE id = c_note;
  SELECT * INTO v_row FROM _dn_guard WHERE id = c_note;
  v_log := v_row.change_log -> (jsonb_array_length(v_row.change_log) - 1);
  IF v_row.verification_status IS DISTINCT FROM 'unverified'
     OR v_row.reviewed_by IS NOT NULL OR v_row.reviewed_at IS NOT NULL
     OR (v_log ->> 'verification_reset') IS DISTINCT FROM 'true'
     OR v_log -> 'previous' ->> 'verification_status' IS DISTINCT FROM 'verified'
     OR v_log -> 'previous' ->> 'reviewed_by' IS DISTINCT FROM c_u2::text
     -- `changed` names the reset too: the verification columns changed with the date.
     OR (v_log -> 'changed') IS DISTINCT FROM
        '["occurred_at", "verification_status", "reviewed_by", "reviewed_at"]'::jsonb THEN
    RAISE EXCEPTION 'self-check 16: changing the date of a verified note should return it to unverified and say so in the log: %', v_log;
  END IF;

  -- 4f. A change made together with a decision is the reviewer's own.
  UPDATE _dn_guard SET occurred_at = '2026-09-01 14:05+02', verification_status = 'verified'
   WHERE id = c_note;
  SELECT * INTO v_row FROM _dn_guard WHERE id = c_note;
  v_log := v_row.change_log -> (jsonb_array_length(v_row.change_log) - 1);
  IF v_row.verification_status IS DISTINCT FROM 'verified' OR v_row.reviewed_by IS DISTINCT FROM c_u2
     OR (v_log ->> 'verification_reset') IS NOT NULL THEN
    RAISE EXCEPTION 'self-check 17: a date changed together with a verification should stay verified, without a reset flag: %', v_log;
  END IF;

  -- 4g. A rejection needs its reason, and is stamped; verifying clears the reason.
  v_got := pg_temp.dn_try(format($q$UPDATE _dn_guard SET verification_status = 'rejected' WHERE id = %L$q$, c_note));
  IF v_got IS DISTINCT FROM 'refused:driver_notes_rejection_has_reason' THEN
    RAISE EXCEPTION 'self-check 18: a rejection without a reason should be refused by driver_notes_rejection_has_reason, but is %', v_got;
  END IF;
  UPDATE _dn_guard SET verification_status = 'rejected', rejected_reason = 'Datum stimmt nicht' WHERE id = c_note;
  SELECT * INTO v_row FROM _dn_guard WHERE id = c_note;
  IF v_row.verification_status IS DISTINCT FROM 'rejected' OR v_row.reviewed_by IS DISTINCT FROM c_u2
     OR v_row.rejected_reason IS DISTINCT FROM 'Datum stimmt nicht'
     OR position('Datum stimmt nicht' IN v_row.change_log::text) > 0 THEN
    RAISE EXCEPTION 'self-check 18: a rejection should be stamped and its reason kept out of the log: %', to_jsonb(v_row);
  END IF;
  UPDATE _dn_guard SET verification_status = 'verified', rejected_reason = 'left over' WHERE id = c_note;
  SELECT * INTO v_row FROM _dn_guard WHERE id = c_note;
  IF v_row.verification_status IS DISTINCT FROM 'verified' OR v_row.rejected_reason IS NOT NULL THEN
    RAISE EXCEPTION 'self-check 18: verifying a rejected note should clear the reason: %', to_jsonb(v_row);
  END IF;
  UPDATE _dn_guard SET verification_status = 'unverified' WHERE id = c_note;
  SELECT * INTO v_row FROM _dn_guard WHERE id = c_note;
  IF v_row.verification_status IS DISTINCT FROM 'unverified'
     OR v_row.reviewed_by IS NOT NULL OR v_row.reviewed_at IS NOT NULL THEN
    RAISE EXCEPTION 'self-check 18: taking a decision back should clear the reviewer: %', to_jsonb(v_row);
  END IF;

  -- 4h. No session: the partner door's shape, a generic writer, a restore, and
  --     the reviewer that only a person can be.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  INSERT INTO _dn_guard (company_id, driver_id, note_text, created_by, submitted_by_name)
  VALUES (c_co, c_drv, 'door', NULL, 'Omar Khalil');
  INSERT INTO _dn_guard (company_id, driver_id, note_text, created_by)
  VALUES (c_co, c_drv, 'script', c_u1);
  INSERT INTO _dn_guard (company_id, driver_id, note_text, created_by, entry_source, received_at)
  VALUES (c_co, c_drv, 'restore', c_u1, 'legacy', '2026-01-01 10:00+00');
  INSERT INTO _dn_guard (company_id, driver_id, note_text, created_by, submitted_by_name, received_at)
  VALUES (c_co, c_drv, 'late link', NULL, 'Omar Khalil', '2026-10-01 08:00+00');

  SELECT string_agg(note_text || '=' || entry_source, ',' ORDER BY note_text)
    INTO v_txt FROM _dn_guard WHERE note_text IN ('door', 'script', 'restore', 'late link');
  IF v_txt IS DISTINCT FROM 'door=driver_app,late link=driver_app,restore=legacy,script=system' THEN
    RAISE EXCEPTION 'self-check 19: sources stamped without a session were %', v_txt;
  END IF;
  IF (SELECT received_at FROM _dn_guard WHERE note_text = 'late link') IS DISTINCT FROM '2026-10-01 08:00+00'::timestamptz
     OR (SELECT received_at FROM _dn_guard WHERE note_text = 'restore') IS DISTINCT FROM '2026-01-01 10:00+00'::timestamptz
     OR abs(extract(epoch FROM (now() - (SELECT received_at FROM _dn_guard WHERE note_text = 'door')))) > 60 THEN
    RAISE EXCEPTION 'self-check 19: a writer with no session should keep the arrival time it states, and get the clock when it states none';
  END IF;

  v_got := pg_temp.dn_try(format($q$UPDATE _dn_guard SET verification_status = 'verified' WHERE id = %L$q$, c_note));
  IF v_got IS DISTINCT FROM 'refused:driver_notes_review_stamp' THEN
    RAISE EXCEPTION 'self-check 20: a decision with no reviewer (no session to stamp one) should be refused by driver_notes_review_stamp, but is %', v_got;
  END IF;

  UPDATE _dn_guard SET created_by = c_u2 WHERE note_text = 'script';
  IF (SELECT created_by FROM _dn_guard WHERE note_text = 'script') IS DISTINCT FROM c_u2 THEN
    RAISE EXCEPTION 'self-check 21: a writer with no session should be able to repair created_by';
  END IF;

  -- 4i. Nothing a request writes reaches the log, whoever it is.
  UPDATE _dn_guard SET change_log = '[{"forged": true}]'::jsonb WHERE id = c_note;
  IF (SELECT position('forged' IN change_log::text) FROM _dn_guard WHERE id = c_note) > 0 THEN
    RAISE EXCEPTION 'self-check 22: a request wrote to change_log';
  END IF;

  DROP FUNCTION pg_temp.dn_try(text);
  DROP TABLE _dn_guard;
  DROP TABLE _dn_rules;

  RAISE NOTICE 'ok  driver_notes provenance: 13 columns, 12 CHECKs (no function outside pg_catalog), the guard stamps, pins, resets and logs, no policy reads a provenance column, the audit redacts the text and the position';
END
$check$;
