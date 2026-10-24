/*
  # A detected conflict, and the record of who reviewed it

  The product detects a great deal and remembers almost none of it. A survey of
  the detectors found five shapes of "something is wrong here" and exactly one
  of them is a record anybody can act on — `partner_receipt_submissions` and
  `partner_note_submissions` (20261005140000). This table is that shape applied
  to the detectors, so a finding stops being a string recomputed on every
  render and becomes a row with a reviewer's name against it.

  ## What this table can hold

  Two detectors, named in `detector`, because these two are the only ones whose
  output already carries a **stable identifier**, and an identifier that moves
  between releases cannot be the key of a stored decision:

  - **`trip_analysis`** — the twenty `IssueType`s of `src/utils/tripAnalysis/`.
    Every one builds its `Issue.id` as the kind plus the ids of what it is
    about, and `findings.ts` is careful about which: a pair of trips
    (`driver_overlap:tA+tB`, sorted so the input order cannot change it), one
    trip, one shift, or one driver.
  - **`return_check`** — the six `AnomalyType`s of `src/utils/returnCheck/`.
    `RideAnomaly` has no `id` field, but it has `(type, rideId)`, which is the
    same identity in two fields; the client composes it into the same
    `kind:evidence` shape in one tested place.

  ## What it deliberately cannot hold, and why for each

  - **The ten pre-finalisation checks** of `FinalizePlanningModal.tsx`. Those
    are a **gate**: "there is no override", and documents are downloadable only
    once every one of them passes. A reviewable record of a blocking check is a
    way past it, and that is a product decision, not a storage question. They
    stay `{id, ok, detail}` in React state.
  - **`warningCategories.classify()`**. It sorts warnings by matching German
    fragments, so its "identifier" is a sentence that any wording change
    renames. A decision keyed on that is lost the first time somebody improves
    a message.
  - **`fahrtenbuch_trips.needs_review` / `review_reasons`**. Already stored, and
    immutable after insert: an import-time fact about a row, not a finding
    somebody has to come back to. The engine's own row-quality kinds
    (`missing_start`, `end_before_start`, `ambiguous_local_time`, …) cover the
    same ground and do have a reviewable identity, so those are what land here.
  - **`planning_finalizations.is_stale`**. Already stored, and its only outcome
    is re-finalisation; there is nothing for a reviewer to decide.
  - **`OrderCheck` / `OrderPlacement`** from the Rückkehrpflicht tab. One row
    per completed ride is a record of every ride, not of a conflict, and the
    two placements that read as reviewable (`away_from_base`,
    `block_start_away`) are precisely the ones the module says the file cannot
    decide. Storing a decision against them is the one thing rule 1 below
    forbids. The six *anomalies* beside them are findings and are held.

  ## The idempotency key, and why a re-run writes no second row

  `UNIQUE (company_id, detector, period_year, period_month, finding_key)`.

  `finding_key` is the detector's own identifier for the finding, verbatim. The
  property that makes it usable is one the engine already guarantees and that
  `driver_name_mismatch` demonstrates: its id is
  `driver_name_mismatch:<driverId>` and **not** the list of misspelled rows, so
  a new row joining the evidence updates that finding rather than creating a
  second one. The same holds throughout — the key names the *subject*, never
  the measurement. So re-running a detector over the same month re-finds the
  same keys and the upsert lands on the rows that are already there.

  Three things are deliberately **not** in the key:

  - **The algorithm version.** A stored decision is about a fact in the data —
    these two rides of this driver overlap — not about the code that noticed
    it. Putting the version in the key would discard every decision on the
    release that bumped it, which is exactly the release where the review
    history is worth most. It is recorded instead, twice:
    `first_detected_version` and `last_detected_version`, so a reader can see
    that the engine moved under a decision.
  - **The measured values.** An overlap of 41 minutes and the same overlap
    re-measured at 42 are one conflict about one pair of rides.
  - **The evidence set**, for the reason above.

  One thing **is** in the key that the detectors do not supply: the **period**.
  The engines analyse "the trips of a period" and carry no period field, so
  `no_shift_records:<driverId>` is the same string in September and October
  while being two different facts. `period_year` and `period_month` are the
  month the analysis ran for, 1-indexed as `fahrtenbuch_imports.month` and
  `monthParts()` in `TripAnalysisPage.tsx` are — and *not* 0-indexed like
  `weekCalculations.ts`, which is the trap this codebase sets for a reader.
  The cost is stated rather than hidden: a finding whose evidence straddles a
  month boundary is reported in both months and carries a decision in each.
  The alternative silently applies September's decision to October's facts.

  ## Rule 1: a finding is a list to review, never a verdict

  `src/utils/returnCheck/types.ts` says it in as many words, and
  `ReturnCheckPanel.render.test.ts` fails the build on the word "Verstoß".
  Storing a finding must not promote it to an accusation, and three parts of
  this schema are what keep that true:

  - **`detector_status` holds the engine's own three-valued honesty and refuses
    `'passed'`.** `'conflict'` is "checked and not fine", `'unverifiable'` is
    "could not be checked" — the "nicht belegt" of the panel. A `'passed'` row
    would make this a log of everything rather than a review queue, and it
    would let a clean check be recorded as a finding.
  - **The reviewer's own words are `acknowledged` and `dismissed`, not
    `confirmed` and `rejected`.** A detector's finding is not a fact a review
    can confirm; what a review can do is take it on and act on the operation
    (`acknowledged`, "zur Kenntnis genommen") or look and find nothing to act on
    (`dismissed`). The distinction worth keeping: the *reviewer's* decision may
    be definite, because that is the human judgement this table exists to hold;
    the *detector's* description must stay "zu prüfen".
  - **The German wording is the engine's, carried with its key.** `explanation`
    is the sentence the engine produced and `explanation_key` is the dictionary
    key beside it, so a screen renders `engineText(...)` exactly as the panel
    does and no new vocabulary is invented at the storage layer.

  ## Rule 2: a decision that closes the matter says why

  The partner tables' rule — "'Rejected, no reason' is what the driver cannot
  act on" — generalises to the decision that makes a finding go away. Here that
  is `dismissed`: an acknowledged finding stays visible and remains actionable
  without justification, while a dismissed one is indistinguishable from one
  nobody examined. So `conflict_reviews_dismissal_has_reason` requires a
  non-blank `review_note` on a dismissal, by CHECK, for every writer.

  ## Rule 3: no DELETE policy, and no DELETE grant either

  A reviewed finding is a record. The partner tables have no DELETE policy, and
  `authenticated` still holds the privilege there, so a client DELETE removes
  nothing and PostgREST answers 200 — the silent shape CLAUDE.md warns about.
  Here the grant is withheld as well, so a DELETE is `permission denied`: loud.
  A company's rows still go with the company, through the cascade.

  ## What is derived rather than trusted

  `app_private.conflict_review_guard` is a BEFORE row trigger, and everything
  it does is a rule the next writer would otherwise have to remember:

  - **`reviewed_by`, `reviewed_at` and `decided_values` are never accepted from
    a caller.** A review record whose author the client names is not a review
    record. The actor is `auth.uid()`, the time is `now()`, and
    `decided_values` is a copy of the measurement **as it stood when the
    decision was made** — which is what tells a later reader whether the
    figures moved since. Without that copy the row would carry only the current
    measurement and the decision would appear to have been made on it.
  - **`reviewed_by` may be NULL on a decided row, and `reviewed_at` may not.**
    A path with no session — a migration, psql, a host script — records a
    decision with no actor, as every NULL actor on `platform_staff` was
    written. The biconditional constraint is therefore on the timestamp, and
    the screen says "Nicht erfasst" for the other, rather than this refusing a
    legitimate repair.
  - **The identity is immutable.** `detector`, `finding_type`, `finding_key`,
    `period_year` and `period_month` cannot change once the row exists, so a
    dismissal of a trivial finding cannot be re-pointed at a serious one. A
    WITH CHECK sees only the new row and cannot say what it already was — the
    reason `pin_billing_company_id` exists.
  - **A decision is not reversed by a re-detection.** Once `status` has left
    `'open'` it never returns. That is rule 3 one step further, and it is also
    what makes the client's upsert safe: a re-run that carelessly sent
    `status: 'open'` in its payload fails loudly instead of quietly erasing
    every decision in the month.
  - **`first_detected_at` and `first_detected_version` are pinned to their
    original values on every UPDATE**, so an upsert cannot move them.

  `company_id` is deliberately **not** pinned. The four tenant policies already
  refuse a move for every principal, and pinning it would make
  `tests/rls/matrix.sql`'s M probe answer T for the owner too — which is the
  one probe that reaches a WITH CHECK clause at all. The pin would buy nothing
  and cost the measurement.

  ## Why the evidence carries no foreign keys

  `subject_driver_id`, `trip_ids` and `shift_ids` are recorded identifiers, not
  references. A finding is a record of what was found and must outlive the rows
  it cites: `ON DELETE SET NULL` would erase the one field saying who the
  finding was about, and `ON DELETE CASCADE` would delete the record itself.
  `company_id` is the single exception, because a row with no company has no
  tenant and no policy can place it.

  ## The page, and why `documents`

  Every write asks `current_role_permits('documents', true)`. `/fahrtenanalyse`
  is registered under `PlanGate feature="dokumente"`, the rides it reads are
  `fahrtenbuch_trips`, whose page has been `documents` since 20260923130000,
  and `/monatsplan`'s own tables (`vehicle_day_plans`,
  `driver_month_assignments`) ask the same page. So the right to review a
  finding about the Fahrtenbuch is the right to work on the Fahrtenbuch, and no
  new `page_key` is invented — a key `PAGE_DEFINITIONS` does not know is
  dropped the first time anyone edits that role. SELECT asks no role, as
  3.3's shape has no role term there.

  ## What this table does not answer

  Nothing reads it yet, and no screen is added: slice 1 shipped
  `vehicle_day_plans` with "no screen calls the client yet" on purpose. There
  is no GIN index on `trip_ids` for the same reason — no reader, no index.
  And the row carries the *current* measurement beside a *frozen* decision; it
  is not a history of every re-detection, which would be an audit table and a
  different slice.
*/

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The record
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.conflict_reviews (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- ── the identity: immutable after insert, and the idempotency key ────────
  detector               text        NOT NULL,
  finding_type           text        NOT NULL,
  -- The detector's own identifier, verbatim: `<finding_type>:<evidence>`.
  finding_key            text        NOT NULL,
  -- The analysis period, 1-indexed like fahrtenbuch_imports.month.
  period_year            smallint    NOT NULL,
  period_month           smallint    NOT NULL,

  -- ── what the detector says now ───────────────────────────────────────────
  -- The engine's IssueStatus, minus 'passed': a clean check is not a finding.
  detector_status        text        NOT NULL,
  severity               text        NOT NULL,
  -- Lower for a finding built on trip_date + HH:MM than on a timestamptz.
  confidence             text        NOT NULL,

  -- Recorded identifiers, not references (see the header).
  subject_driver_id      uuid        NULL,
  subject_vehicle        text        NULL,
  trip_ids               uuid[]      NULL,
  shift_ids              text[]      NULL,

  -- The values the finding was computed from, keyed as IssueType documents.
  measured_values        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- The engine's German sentence and the dictionary key beside it, so a screen
  -- renders engineText(t, explanation, explanation_key, explanation_vars).
  explanation            text        NOT NULL,
  explanation_key        text        NULL,
  explanation_vars       jsonb       NULL,

  first_detected_at      timestamptz NOT NULL DEFAULT now(),
  first_detected_version text        NOT NULL,
  last_detected_at       timestamptz NOT NULL DEFAULT now(),
  last_detected_version  text        NOT NULL,

  -- ── the review ───────────────────────────────────────────────────────────
  status                 text        NOT NULL DEFAULT 'open',
  review_note            text        NULL,
  -- All three are stamped by the guard and never accepted from a caller.
  reviewed_by            uuid        NULL,
  reviewed_at            timestamptz NULL,
  decided_values         jsonb       NULL,

  -- A detector is one of two, and each one's kinds are its own: a return_check
  -- row claiming 'driver_overlap' is refused here. The twenty IssueTypes of
  -- src/utils/tripAnalysis/types.ts and the six AnomalyTypes of
  -- src/utils/returnCheck/types.ts, and src/utils/conflictReviewTypes.test.ts
  -- reads this constraint and fails the build when either list moves.
  CONSTRAINT conflict_reviews_detector_type CHECK (
    (detector = 'trip_analysis' AND finding_type IN (
       'driver_overlap', 'vehicle_overlap', 'travel_gap', 'activity_outside_shift',
       'shift_without_activity', 'shift_overlap', 'shift_invalid', 'no_shift_records',
       'missing_driver', 'missing_vehicle', 'missing_start', 'missing_end',
       'end_before_start', 'status_unknown', 'ambiguous_local_time',
       'driver_name_mismatch', 'activity_over_budget', 'shifts_over_budget',
       'budget_not_computable', 'cap_below_hours_min'))
    OR
    (detector = 'return_check' AND finding_type IN (
       'same_address', 'same_street', 'implausible_speed', 'zero_distance',
       'position_invalid', 'order_after_start'))
  ),

  -- The key names its own kind, so the two can never disagree about what the
  -- row is, and so the unique index needs no finding_type column.
  CONSTRAINT conflict_reviews_finding_key_names_type CHECK (
    length(finding_key) > length(finding_type) + 1
    AND left(finding_key, length(finding_type) + 1) = finding_type || ':'
  ),

  CONSTRAINT conflict_reviews_period CHECK (
    period_month BETWEEN 1 AND 12 AND period_year BETWEEN 2000 AND 2100
  ),

  -- 'passed' is absent on purpose; see the header.
  CONSTRAINT conflict_reviews_detector_status
    CHECK (detector_status IN ('conflict', 'unverifiable')),
  CONSTRAINT conflict_reviews_severity
    CHECK (severity IN ('error', 'warning', 'info')),
  CONSTRAINT conflict_reviews_confidence
    CHECK (confidence IN ('high', 'medium', 'low')),
  CONSTRAINT conflict_reviews_status
    CHECK (status IN ('open', 'acknowledged', 'dismissed')),

  -- A dismissal says why. An acknowledged finding stays visible and needs no
  -- justification to remain actionable; a dismissed one with no reason cannot
  -- be told apart from one nobody examined.
  CONSTRAINT conflict_reviews_dismissal_has_reason
    CHECK (status <> 'dismissed' OR btrim(coalesce(review_note, '')) <> ''),

  -- A decided finding says when, and an open one says nothing: the guard
  -- derives both, and these say so for the writer that comes after it.
  CONSTRAINT conflict_reviews_decided_has_time
    CHECK ((status = 'open') = (reviewed_at IS NULL)),
  CONSTRAINT conflict_reviews_decided_has_values
    CHECK ((status = 'open') = (decided_values IS NULL)),
  CONSTRAINT conflict_reviews_open_names_no_reviewer
    CHECK (status <> 'open' OR reviewed_by IS NULL),

  -- An absent evidence list is NULL, never an empty array, so the two cannot
  -- mean the same thing in two rows. coalesce, because array_length('{}', 1)
  -- is NULL and a CHECK passes on NULL.
  CONSTRAINT conflict_reviews_trip_ids_shape CHECK (
    trip_ids IS NULL
    OR (coalesce(array_length(trip_ids, 1), 0) >= 1 AND array_position(trip_ids, NULL) IS NULL)
  ),
  CONSTRAINT conflict_reviews_shift_ids_shape CHECK (
    shift_ids IS NULL
    OR (coalesce(array_length(shift_ids, 1), 0) >= 1 AND array_position(shift_ids, NULL) IS NULL)
  ),

  -- Three jsonb documents, each an object and bounded. record_support_write()
  -- copies a changed column into the audit log and omits anything over 1 KiB,
  -- and app_private.audit_write refuses a value over 32768 bytes, so 4096
  -- leaves room without reaching either.
  --
  -- Most findings' values ARE a dozen numbers, but two are not and they are
  -- what the bound has to be judged against: `driver_name_mismatch` carries
  -- `names`, every distinct spelling of one driver's name joined with ' | ',
  -- and `budget_not_computable` carries `problems`, a joined list of codes.
  -- Both are per driver rather than per row, so a real one is tens of bytes
  -- and a pathological one is still hundreds -- but note what the bound IS:
  -- a REFUSAL (23514), not a truncation. A client that can produce a longer
  -- document has to shorten it rather than discover this at the insert.
  CONSTRAINT conflict_reviews_measured_values_shape CHECK (
    jsonb_typeof(measured_values) = 'object' AND length(measured_values::text) <= 4096
  ),
  CONSTRAINT conflict_reviews_explanation_vars_shape CHECK (
    explanation_vars IS NULL
    OR (jsonb_typeof(explanation_vars) = 'object' AND length(explanation_vars::text) <= 4096)
  ),
  CONSTRAINT conflict_reviews_decided_values_shape CHECK (
    decided_values IS NULL
    OR (jsonb_typeof(decided_values) = 'object' AND length(decided_values::text) <= 4096)
  ),

  CONSTRAINT conflict_reviews_text_fields CHECK (
    btrim(explanation) <> '' AND length(explanation) <= 2000
    AND (explanation_key IS NULL OR (btrim(explanation_key) <> '' AND length(explanation_key) <= 200))
    AND btrim(first_detected_version) <> '' AND length(first_detected_version) <= 64
    AND btrim(last_detected_version)  <> '' AND length(last_detected_version)  <= 64
    AND (subject_vehicle IS NULL OR (btrim(subject_vehicle) <> '' AND length(subject_vehicle) <= 120))
    AND (review_note IS NULL OR length(review_note) <= 2000)
  )
);

COMMENT ON TABLE public.conflict_reviews IS
  'A detected conflict and the record of who reviewed it. Holds the twenty '
  'tripAnalysis IssueTypes and the six returnCheck AnomalyTypes, keyed on the '
  'detector''s own identifier plus the analysis month, so re-running a detector '
  'updates the finding instead of filing a second one. A finding is a list to '
  'review, never a verdict: detector_status refuses ''passed'' and the '
  'reviewer''s words are acknowledged / dismissed (20261023200000).';

COMMENT ON COLUMN public.conflict_reviews.finding_key IS
  'The detector''s own identifier, verbatim. It names the SUBJECT of the '
  'finding and never its measurement or evidence set, which is what lets a '
  're-run land on the row a reviewer already decided.';

COMMENT ON COLUMN public.conflict_reviews.decided_values IS
  'measured_values as it stood when the decision was made, copied by the '
  'guard. measured_values moves with every re-detection; this does not, so a '
  'reader can see whether the figures changed under a decision.';

-- The idempotency key. finding_type is absent because
-- conflict_reviews_finding_key_names_type ties it to finding_key's prefix.
CREATE UNIQUE INDEX IF NOT EXISTS conflict_reviews_idempotency
  ON public.conflict_reviews (company_id, detector, period_year, period_month, finding_key);

-- The queue: what is still open, newest first.
CREATE INDEX IF NOT EXISTS conflict_reviews_queue
  ON public.conflict_reviews (company_id, status, first_detected_at DESC);

-- One month's findings, which is how the screen will read them.
CREATE INDEX IF NOT EXISTS conflict_reviews_period
  ON public.conflict_reviews (company_id, period_year, period_month, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The guard: the identity, the one-way decision, and the stamped reviewer
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.conflict_review_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_decided  boolean;
  -- One variable rather than the condition inline, so a mutation control can
  -- disable exactly this rule and nothing else: `IF v_identity_moved THEN`
  -- becomes `IF false THEN`, where turning one disjunct off would leave the
  -- other four refusing and the control would measure nothing.
  v_identity_moved boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_identity_moved := NEW.detector     IS DISTINCT FROM OLD.detector
                     OR NEW.finding_type IS DISTINCT FROM OLD.finding_type
                     OR NEW.finding_key  IS DISTINCT FROM OLD.finding_key
                     OR NEW.period_year  IS DISTINCT FROM OLD.period_year
                     OR NEW.period_month IS DISTINCT FROM OLD.period_month;
    IF v_identity_moved THEN
      RAISE EXCEPTION
        'Ein erfasster Befund kann nicht auf einen anderen Befund gezeigt werden.'
        USING ERRCODE = 'P0001', HINT = 'finding_identity_immutable';
    END IF;

    -- A decision is a record. Reopening is not supported: a reviewer who
    -- changes their mind moves between acknowledged and dismissed, and both
    -- keep a reviewer and a time. This is also what makes a re-detection
    -- upsert safe whatever its payload carries.
    IF OLD.status <> 'open' AND NEW.status = 'open' THEN
      RAISE EXCEPTION
        'Eine getroffene Entscheidung bleibt im Protokoll und wird nicht zurückgenommen.'
        USING ERRCODE = 'P0001', HINT = 'decision_is_a_record';
    END IF;

    -- An upsert carries these in its payload; they belong to the first sighting.
    NEW.first_detected_at      := OLD.first_detected_at;
    NEW.first_detected_version := OLD.first_detected_version;
  END IF;

  IF NEW.status = 'open' THEN
    NEW.reviewed_by    := NULL;
    NEW.reviewed_at    := NULL;
    NEW.decided_values := NULL;
    RETURN NEW;
  END IF;

  -- A decision is stamped when it is taken or changed, and otherwise left
  -- exactly as it was -- so a re-detection of a decided finding moves the
  -- measurement and never the decision or what it was decided on.
  v_decided := TG_OP = 'INSERT'
            OR OLD.status      IS DISTINCT FROM NEW.status
            OR OLD.review_note IS DISTINCT FROM NEW.review_note;

  IF v_decided THEN
    NEW.reviewed_by    := auth.uid();
    NEW.reviewed_at    := now();
    NEW.decided_values := NEW.measured_values;
  ELSE
    NEW.reviewed_by    := OLD.reviewed_by;
    NEW.reviewed_at    := OLD.reviewed_at;
    NEW.decided_values := OLD.decided_values;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION app_private.conflict_review_guard() IS
  'Pins a finding''s identity and its first sighting, refuses a decision that '
  'returns to open, and derives reviewed_by, reviewed_at and decided_values '
  'rather than accepting them from a caller: a review record whose author the '
  'client names is not a review record (20261023200000).';

-- Fired by a trigger, which does not check EXECUTE; the REVOKE is the second
-- wall, and no caller has any business calling it directly.
REVOKE ALL ON FUNCTION app_private.conflict_review_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS conflict_review_guard ON public.conflict_reviews;
CREATE TRIGGER conflict_review_guard
  BEFORE INSERT OR UPDATE ON public.conflict_reviews
  FOR EACH ROW EXECUTE FUNCTION app_private.conflict_review_guard();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Row level security -- 3.3's shape, the Dokumente page on every write
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.conflict_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conflict_reviews_select ON public.conflict_reviews;
CREATE POLICY conflict_reviews_select ON public.conflict_reviews
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_active_company_id())
         OR (SELECT public.platform_reads_company_data()));

-- A detector may file an OPEN finding and nothing else: a row arriving already
-- dismissed, with a reason and a reviewer, is a review nobody did. It is
-- refused here rather than rewritten by the guard, because a caller who
-- believes it stored a decision is worse off than one who was told no.
--
-- The clause sits OUTSIDE the platform write seam on purpose. The seam is
-- `SELECT false` since 20260917140000, so it changes nothing today; inside the
-- OR it would mean that turning the seam on let a platform account file a
-- decided finding, which is the one thing this clause exists to stop.
DROP POLICY IF EXISTS conflict_reviews_insert ON public.conflict_reviews;
CREATE POLICY conflict_reviews_insert ON public.conflict_reviews
  FOR INSERT TO authenticated
  WITH CHECK (((company_id = (SELECT public.get_active_company_id())
                AND (SELECT public.current_role_permits('documents', true)))
               OR (SELECT public.platform_writes_company_data()))
              AND status = 'open');

-- The same predicate as USING and as WITH CHECK: writing it twice is what
-- refuses a move between companies.
DROP POLICY IF EXISTS conflict_reviews_update ON public.conflict_reviews;
CREATE POLICY conflict_reviews_update ON public.conflict_reviews
  FOR UPDATE TO authenticated
  USING (((company_id = (SELECT public.get_active_company_id())
           AND (SELECT public.current_role_permits('documents', true)))
          OR (SELECT public.platform_writes_company_data())))
  WITH CHECK (((company_id = (SELECT public.get_active_company_id())
                AND (SELECT public.current_role_permits('documents', true)))
               OR (SELECT public.platform_writes_company_data())));

-- No DELETE policy and no DELETE grant: a reviewed finding is a record, and a
-- refusal that removes nothing while answering 200 is the shape to avoid.
REVOKE ALL ON TABLE public.conflict_reviews FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.conflict_reviews TO authenticated;

-- Both context triggers, because the policies name get_active_company_id().
-- Keyed on the policies and not on who writes today: tests/rls's two shape
-- rules (platform-contexts.sql section 14, support-write-audit.sql section 1)
-- fail a table carrying one without the other, and 20260924100000 shipped with
-- neither on the reasoning "no client writes it".
DROP TRIGGER IF EXISTS refuse_read_only_context_write ON public.conflict_reviews;
CREATE TRIGGER refuse_read_only_context_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.conflict_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.refuse_read_only_context_write();

DROP TRIGGER IF EXISTS record_support_write ON public.conflict_reviews;
CREATE TRIGGER record_support_write
  AFTER INSERT OR UPDATE OR DELETE ON public.conflict_reviews
  FOR EACH ROW
  WHEN (current_setting('app_private.support_write_context', true) <> '')
  EXECUTE FUNCTION app_private.record_support_write();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Self-check
-- ─────────────────────────────────────────────────────────────────────────────

DO $check$
DECLARE
  c_co     CONSTANT uuid := '00000000-cf17-4e71-9ea0-5e1fc4ec8000';
  c_tbl    CONSTANT regclass := to_regclass('public.conflict_reviews');

  v_fail   text;
  v_got    text;
  v_state  text;
  v_names  text;
  v_n      int;
  r        record;
BEGIN
  -- 1. exactly three policies, with the names 3.3's shape gives them, and no
  --    DELETE policy.
  SELECT string_agg(policyname || '/' || cmd, ', ' ORDER BY policyname) INTO v_names
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'conflict_reviews';
  IF v_names IS DISTINCT FROM
     'conflict_reviews_insert/INSERT, conflict_reviews_select/SELECT, conflict_reviews_update/UPDATE' THEN
    RAISE EXCEPTION 'self-check 1: the policy set is [%]', coalesce(v_names, 'none');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = c_tbl AND relrowsecurity) THEN
    RAISE EXCEPTION 'self-check 1: row level security is not enabled';
  END IF;

  -- 2. the tenant term is in SELECT, and the page gate plus the tenant term
  --    are in BOTH halves of UPDATE and in INSERT's WITH CHECK. A write
  --    rebuilt from the tenancy predicate alone loses the role gate, and one
  --    rebuilt without the second copy stops refusing a move.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'conflict_reviews'
       AND policyname = 'conflict_reviews_select'
       AND qual LIKE '%get_active_company_id%' AND qual LIKE '%platform_reads_company_data%'
       AND qual NOT LIKE '%current_role_permits%') THEN
    RAISE EXCEPTION 'self-check 2: the SELECT policy is not the tenant shape, or it gained a role term';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'conflict_reviews'
       AND policyname = 'conflict_reviews_update'
       AND qual       LIKE '%get_active_company_id%' AND qual       LIKE '%documents%'
       AND qual       LIKE '%platform_writes_company_data%'
       AND with_check LIKE '%get_active_company_id%' AND with_check LIKE '%documents%'
       AND with_check LIKE '%platform_writes_company_data%') THEN
    RAISE EXCEPTION 'self-check 2: the UPDATE policy does not carry the tenant term, the page and the write seam in both halves';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'conflict_reviews'
       AND policyname = 'conflict_reviews_insert'
       AND with_check LIKE '%get_active_company_id%' AND with_check LIKE '%documents%'
       AND with_check LIKE '%platform_writes_company_data%'
       AND with_check LIKE '%status%') THEN
    RAISE EXCEPTION 'self-check 2: the INSERT policy does not carry the tenant term, the page, the write seam and the open-only clause';
  END IF;
  -- That the open-only clause is a conjunct of the WHOLE predicate rather than
  -- one branch of the platform OR is not asserted here: it would mean guessing
  -- how PostgreSQL deparses the expression. Section 3 of
  -- tests/rls/conflict-review-record.sql measures it instead, as a principal,
  -- which is the only reading that cannot be wrong about the rendering.

  -- 3. the three triggers
  FOR r IN SELECT unnest(ARRAY['refuse_read_only_context_write',
                               'record_support_write',
                               'conflict_review_guard']) AS g LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = c_tbl AND t.tgname = r.g AND NOT t.tgisinternal) THEN
      RAISE EXCEPTION 'self-check 3: the trigger % is missing', r.g;
    END IF;
  END LOOP;

  -- 4. the guard is SECURITY DEFINER with a pinned search_path, and no API
  --    role may call it. As an invoker its stamp would still work, but the
  --    REVOKE is the rule and a definer is the house shape for a guard.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app_private' AND p.proname = 'conflict_review_guard'
       AND p.prosecdef
       AND array_to_string(coalesce(p.proconfig, ARRAY[]::text[]), ',') LIKE '%search_path=%') THEN
    RAISE EXCEPTION 'self-check 4: conflict_review_guard is not SECURITY DEFINER with a pinned search_path';
  END IF;
  IF has_function_privilege('anon',          'app_private.conflict_review_guard()', 'EXECUTE')
  OR has_function_privilege('authenticated', 'app_private.conflict_review_guard()', 'EXECUTE')
  OR has_function_privilege('service_role',  'app_private.conflict_review_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check 4: an API role may execute conflict_review_guard';
  END IF;

  -- 5. the grants: a client reads, files and reviews; nobody deletes. A DELETE
  --    privilege with no DELETE policy removes nothing and answers 200.
  IF NOT has_table_privilege('authenticated', c_tbl, 'SELECT')
  OR NOT has_table_privilege('authenticated', c_tbl, 'INSERT')
  OR NOT has_table_privilege('authenticated', c_tbl, 'UPDATE') THEN
    RAISE EXCEPTION 'self-check 5: authenticated cannot read, file or review a finding';
  END IF;
  IF has_table_privilege('authenticated', c_tbl, 'DELETE')
  OR has_table_privilege('anon',          c_tbl, 'SELECT')
  OR has_table_privilege('service_role',  c_tbl, 'SELECT') THEN
    RAISE EXCEPTION 'self-check 5: a role holds a privilege it must not (DELETE, or anon/service_role at all)';
  END IF;

  -- 6. the idempotency key is enforced, and on exactly these five columns
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'conflict_reviews'
       AND indexname = 'conflict_reviews_idempotency'
       AND indexdef LIKE 'CREATE UNIQUE INDEX%(company_id, detector, period_year, period_month, finding_key)') THEN
    RAISE EXCEPTION 'self-check 6: the idempotency index is missing or no longer names the five key columns';
  END IF;

  -- 7. nothing may remove a reviewed finding. The table is young, so this is
  --    the rule rather than the instance -- the audit log's own shape.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_names
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'app_private')
     AND p.prosrc ~* '(delete\s+from|truncate)\s+(public\.)?conflict_reviews';
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'self-check 7: % deletes or truncates conflict_reviews', v_names;
  END IF;

  -- ── behaviour, in a subtransaction that is always rolled back ────────────
  -- Each refusal is identified by its CONSTRAINT NAME and never by its
  -- SQLSTATE: every CHECK on this table raises 23514, so a probe compared by
  -- class would pass on the wrong constraint.
  BEGIN
    INSERT INTO public.companies (id, name, slug)
    VALUES (c_co, 'conflict_reviews self-check', 'cr-self-check-20261023200000');

    FOR r IN
      SELECT *
        FROM (VALUES
          -- a dismissal with no reason
          ('a dismissal with no reason',
           $q$INSERT INTO public.conflict_reviews
                (company_id, detector, finding_type, finding_key, period_year, period_month,
                 detector_status, severity, confidence, explanation,
                 first_detected_version, last_detected_version, status)
              VALUES ('%1$s', 'trip_analysis', 'driver_overlap', 'driver_overlap:a+b', 2026, 10,
                      'conflict', 'error', 'high', 'Zu prüfen.', 'v', 'v', 'dismissed')$q$,
           'conflict_reviews_dismissal_has_reason'),
          -- a clean check stored as a finding
          ('detector_status passed',
           $q$INSERT INTO public.conflict_reviews
                (company_id, detector, finding_type, finding_key, period_year, period_month,
                 detector_status, severity, confidence, explanation,
                 first_detected_version, last_detected_version)
              VALUES ('%1$s', 'trip_analysis', 'driver_overlap', 'driver_overlap:a+b', 2026, 10,
                      'passed', 'error', 'high', 'Zu prüfen.', 'v', 'v')$q$,
           'conflict_reviews_detector_status'),
          -- one detector claiming another's kind
          ('return_check claiming driver_overlap',
           $q$INSERT INTO public.conflict_reviews
                (company_id, detector, finding_type, finding_key, period_year, period_month,
                 detector_status, severity, confidence, explanation,
                 first_detected_version, last_detected_version)
              VALUES ('%1$s', 'return_check', 'driver_overlap', 'driver_overlap:a+b', 2026, 10,
                      'conflict', 'error', 'high', 'Zu prüfen.', 'v', 'v')$q$,
           'conflict_reviews_detector_type'),
          -- a key that does not name its own kind
          ('a key naming another kind',
           $q$INSERT INTO public.conflict_reviews
                (company_id, detector, finding_type, finding_key, period_year, period_month,
                 detector_status, severity, confidence, explanation,
                 first_detected_version, last_detected_version)
              VALUES ('%1$s', 'trip_analysis', 'driver_overlap', 'vehicle_overlap:a+b', 2026, 10,
                      'conflict', 'error', 'high', 'Zu prüfen.', 'v', 'v')$q$,
           'conflict_reviews_finding_key_names_type'),
          -- an empty evidence array, which must be NULL instead
          ('an empty trip_ids array',
           $q$INSERT INTO public.conflict_reviews
                (company_id, detector, finding_type, finding_key, period_year, period_month,
                 detector_status, severity, confidence, explanation,
                 first_detected_version, last_detected_version, trip_ids)
              VALUES ('%1$s', 'trip_analysis', 'no_shift_records', 'no_shift_records:d1', 2026, 10,
                      'unverifiable', 'info', 'high', 'Nicht belegt.', 'v', 'v', ARRAY[]::uuid[])$q$,
           'conflict_reviews_trip_ids_shape'),
          -- a month the screen cannot mean (0 is weekCalculations' January)
          ('a 0-indexed month',
           $q$INSERT INTO public.conflict_reviews
                (company_id, detector, finding_type, finding_key, period_year, period_month,
                 detector_status, severity, confidence, explanation,
                 first_detected_version, last_detected_version)
              VALUES ('%1$s', 'trip_analysis', 'driver_overlap', 'driver_overlap:a+b', 2026, 0,
                      'conflict', 'error', 'high', 'Zu prüfen.', 'v', 'v')$q$,
           'conflict_reviews_period')
        ) AS t(label, sql, want)
    LOOP
      BEGIN
        EXECUTE format(r.sql, c_co::text);
        v_got := 'accepted';
      EXCEPTION
        WHEN check_violation THEN
          GET STACKED DIAGNOSTICS v_got = CONSTRAINT_NAME;
        WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
          v_got := 'sqlstate ' || v_state;
      END;
      IF v_got IS DISTINCT FROM r.want THEN
        v_fail := coalesce(v_fail || '; ', '')
               || format('%s: expected [%s] got [%s]', r.label, r.want, v_got);
      END IF;
    END LOOP;

    -- Every one of the twenty-six pairs is accepted, so the closed list above
    -- cannot be a typed subset that silently refuses a real finding.
    v_n := 0;
    FOR r IN
      SELECT 'trip_analysis' AS det, unnest(ARRAY[
               'driver_overlap', 'vehicle_overlap', 'travel_gap', 'activity_outside_shift',
               'shift_without_activity', 'shift_overlap', 'shift_invalid', 'no_shift_records',
               'missing_driver', 'missing_vehicle', 'missing_start', 'missing_end',
               'end_before_start', 'status_unknown', 'ambiguous_local_time',
               'driver_name_mismatch', 'activity_over_budget', 'shifts_over_budget',
               'budget_not_computable', 'cap_below_hours_min']) AS ty
      UNION ALL
      SELECT 'return_check', unnest(ARRAY[
               'same_address', 'same_street', 'implausible_speed', 'zero_distance',
               'position_invalid', 'order_after_start'])
    LOOP
      INSERT INTO public.conflict_reviews
             (company_id, detector, finding_type, finding_key, period_year, period_month,
              detector_status, severity, confidence, explanation,
              first_detected_version, last_detected_version)
      VALUES (c_co, r.det, r.ty, r.ty || ':selfcheck', 2026, 10,
              'conflict', 'warning', 'high', 'Zu prüfen.', 'v', 'v');
      v_n := v_n + 1;
    END LOOP;
    IF v_n <> 26 THEN
      v_fail := coalesce(v_fail || '; ', '') || format('the closed list accepted %s pairs, not 26', v_n);
    END IF;

    -- The guard stamps a decision and freezes what it was decided on, and a
    -- re-detection afterwards moves the measurement and not the decision.
    UPDATE public.conflict_reviews
       SET measured_values = '{"overlapMinutes": 41}'::jsonb
     WHERE company_id = c_co AND finding_key = 'driver_overlap:selfcheck';
    UPDATE public.conflict_reviews
       SET status = 'dismissed', review_note = 'Mit dem Fahrer geklärt.'
     WHERE company_id = c_co AND finding_key = 'driver_overlap:selfcheck';
    UPDATE public.conflict_reviews
       SET measured_values = '{"overlapMinutes": 42}'::jsonb, last_detected_version = 'v2'
     WHERE company_id = c_co AND finding_key = 'driver_overlap:selfcheck';

    SELECT format('%s/%s/%s/%s',
                  status, decided_values->>'overlapMinutes',
                  measured_values->>'overlapMinutes', (reviewed_at IS NOT NULL)::text)
      INTO v_got
      FROM public.conflict_reviews
     WHERE company_id = c_co AND finding_key = 'driver_overlap:selfcheck';
    IF v_got IS DISTINCT FROM 'dismissed/41/42/true' THEN
      v_fail := coalesce(v_fail || '; ', '')
             || format('the guard did not freeze the decision: [%s]', coalesce(v_got, 'no row'));
    END IF;

    -- And a decision does not go back to open.
    BEGIN
      UPDATE public.conflict_reviews SET status = 'open', review_note = NULL
       WHERE company_id = c_co AND finding_key = 'driver_overlap:selfcheck';
      v_got := 'accepted';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_got = PG_EXCEPTION_HINT;
    END;
    IF v_got IS DISTINCT FROM 'decision_is_a_record' THEN
      v_fail := coalesce(v_fail || '; ', '') || format('reopening a decision answered [%s]', v_got);
    END IF;

    -- And a finding cannot be re-pointed at another one.
    BEGIN
      UPDATE public.conflict_reviews SET finding_key = 'driver_overlap:other'
       WHERE company_id = c_co AND finding_key = 'driver_overlap:selfcheck';
      v_got := 'accepted';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_got = PG_EXCEPTION_HINT;
    END;
    IF v_got IS DISTINCT FROM 'finding_identity_immutable' THEN
      v_fail := coalesce(v_fail || '; ', '') || format('re-pointing a finding answered [%s]', v_got);
    END IF;

    -- Always raise, so everything above is rolled back whatever it found. The
    -- findings travel in the message rather than in a variable, so nothing
    -- depends on what plpgsql keeps across an aborted subtransaction.
    RAISE EXCEPTION USING ERRCODE = 'ZZ900', MESSAGE = coalesce(v_fail, 'all probes matched');
  EXCEPTION WHEN SQLSTATE 'ZZ900' THEN
    v_fail := nullif(SQLERRM, 'all probes matched');
  END;

  IF v_fail IS NOT NULL THEN
    RAISE EXCEPTION 'conflict_reviews self-check 8: %', v_fail;
  END IF;

  RAISE NOTICE 'conflict_reviews: self-checks passed';
END
$check$;
