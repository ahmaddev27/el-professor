/*
  A declined ride is a third trip status, and its fee is a column of its own.

  External audit, round 3, section 3. The owner asked for it in the product on
  27.10.2026, not as a simulation device.

  ## What a decline is, and why it cannot be a cancellation

  A **cancellation** is an accepted ride that did not happen. A **decline** is
  an order the driver turned down: there was never a ride to cancel. The audit
  is explicit that the two must not be conflated, and that a cancellation earns
  no decline fee unless company policy says so.

  Before this migration the importer had no word for it. `fahrtenbuch_map_status`
  knew `abgeschlossen` and eight spellings of cancelled, and answered `unknown`
  for everything else — so a file carrying `abgelehnt` was stored, flagged for
  review, and counted as neither. That is a safe answer and a useless one: every
  declined order in a month would sit in the review queue for ever, because
  nothing could ever resolve it.

  ## What this migration does NOT do, and that is the load-bearing part

  `fahrtenbuch_trips` is the legal Fahrtenbuch. It is append-only: 32 columns are
  refused after insert by `protect_fahrtenbuch_immutable_fields`, there is no
  UPDATE policy at all, and the corrected book goes to a Steuerberater. So:

  - **No stored row changes.** This migration adds a column and widens a CHECK.
    It runs no UPDATE over `fahrtenbuch_trips`, and `fahrtenbuch_trip_status_of`
    — the backfill rule for rows stored before 20260922100000 — is **not**
    restated, so no historical row is reclassified. A row that is `unknown`
    today is `unknown` tomorrow.
  - **`is_canceled` keeps its meaning exactly.** The existing check already says
    `(trip_status = 'cancelled') = is_canceled`, so a declined row must carry
    `is_canceled = false` and the clause needs no change. Every reader that
    counts cancellations by that boolean is unaffected, and every reader that
    counts completed rides by `trip_status = 'completed'` is too.
  - **No figure on any existing screen or document moves.** A declined row is
    new data. It is not completed, so it enters no fare, no Umsatz, no salary, no
    Abrechnung balance, no till and no Stundennachweis. It is not cancelled, so
    it enters no cancellation count. The only way it could have moved a figure
    was by being folded into one of those two, which is what the fee column
    exists to prevent.

  ## The fee is its own column, and the CHECK is the reason it stays that way

  `declined_fee_cents` is **integer cents**, never a fare. The audit's figure is
  6.00 EUR and the tenant configures it, so the value is written once at import
  from the tenant's setting; it is immutable afterwards, like every other fact
  the file carried.

  `fahrtenbuch_trips_declined_fee_check` refuses a fee on a **completed** trip.
  That is the one rule that keeps the two quantities apart for good: a later
  writer cannot quietly put a fee on a ride that also has a fare and have it
  counted twice. The fee is permitted on a cancelled trip, because the audit
  allows a tenant to charge one there by policy — and `price_amount` on a
  cancelled row is a different, older quantity (the export's own cancellation
  charge) that no total reads.

  ## Why `abgelehnt` is added to the map and `storniert` is not touched

  Widening a word list is a decision about what a word in a customer's file
  means — the header of `CANCELLED_STATUS_WORDS` says so. This widening only
  moves words **out of `unknown`**: `abgelehnt` and `declined` were `unknown`
  before and are `declined` now. No word that read as completed or cancelled
  reads differently, so no existing import changes meaning. The parser's
  `DECLINED_STATUS_WORDS` is the same list, and
  `fahrtenbuchImportParser.test.ts` fails the build when the two part.
*/

-- ─── 1. The fee column ──────────────────────────────────────────────────────

ALTER TABLE public.fahrtenbuch_trips
  ADD COLUMN IF NOT EXISTS declined_fee_cents integer;

COMMENT ON COLUMN public.fahrtenbuch_trips.declined_fee_cents IS
  'The fee a declined order earned, in integer cents, written once at import '
  'from the tenant setting. Never a fare: the check refuses it on a completed '
  'trip, which is what stops the two being counted as one.';

-- ─── 2. The checks ──────────────────────────────────────────────────────────

ALTER TABLE public.fahrtenbuch_trips
  DROP CONSTRAINT IF EXISTS fahrtenbuch_trips_trip_status_check;

ALTER TABLE public.fahrtenbuch_trips
  -- 20260922100000's clause, with 'declined' admitted. The second term is
  -- unchanged and is what forces a declined row to carry is_canceled = false.
  ADD CONSTRAINT fahrtenbuch_trips_trip_status_check
    CHECK (trip_status IS NULL
           OR (trip_status IN ('completed', 'cancelled', 'unknown', 'declined')
               AND (trip_status = 'cancelled') = is_canceled));

ALTER TABLE public.fahrtenbuch_trips
  DROP CONSTRAINT IF EXISTS fahrtenbuch_trips_declined_fee_check;

ALTER TABLE public.fahrtenbuch_trips
  -- Every term is written so it cannot be NULL: a CHECK that evaluates to NULL
  -- passes, which is how a guard comes to refuse nothing.
  ADD CONSTRAINT fahrtenbuch_trips_declined_fee_check
    CHECK (declined_fee_cents IS NULL
           OR (declined_fee_cents >= 0
               AND coalesce(trip_status, '') <> 'completed'));

-- ─── 3. The status map learns one word ──────────────────────────────────────

/*
  Restated from 20260922100000 with one list added. Both existing lists are
  carried over character for character: this function is the database's copy of
  the parser's three lists, and a restatement that loses one would silently
  reclassify every future import.
*/
CREATE OR REPLACE FUNCTION app_private.fahrtenbuch_map_status(p_text text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- COMPLETED_STATUS_WORDS
  c_completed_words CONSTANT text[] := ARRAY['abgeschlossen'];
  -- CANCELLED_STATUS_WORDS: all nine of the old importer's CANCELED_STATUSES
  -- but one — 'nichtdurchgeführt' could never match, because the
  -- normalisation drops the ü from every input, so no cell could equal it.
  c_cancelled_words CONSTANT text[] := ARRAY[
    'storno', 'storniert', 'storniertfahrt', 'stornierung',
    'cancelled', 'canceled', 'abgebrochen', 'nichtdurchgefuhrt'];
  -- DECLINED_STATUS_WORDS: an order the driver turned down. Both spellings
  -- read as 'unknown' before 20261027140000, so nothing is reclassified.
  c_declined_words CONSTANT text[] := ARRAY['abgelehnt', 'declined'];
  v_norm text := app_private.fahrtenbuch_norm(p_text);
BEGIN
  IF v_norm = '' THEN
    RETURN 'unknown';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(c_completed_words) w WHERE app_private.fahrtenbuch_norm(w) = v_norm) THEN
    RETURN 'completed';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(c_cancelled_words) w WHERE app_private.fahrtenbuch_norm(w) = v_norm) THEN
    RETURN 'cancelled';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(c_declined_words) w WHERE app_private.fahrtenbuch_norm(w) = v_norm) THEN
    RETURN 'declined';
  END IF;
  RETURN 'unknown';
END;
$$;

-- ─── 4. The fee is immutable after insert ───────────────────────────────────

/*
  Restated from 20260922100000 with `declined_fee_cents` added, and every other
  column carried over in the same order. The fee is a fact the import decided;
  letting it change afterwards would let a figure in the legal book be rewritten
  with no audit row anywhere.
*/
CREATE OR REPLACE FUNCTION public.protect_fahrtenbuch_immutable_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD.trip_date            IS DISTINCT FROM NEW.trip_date            OR
    OLD.start_time           IS DISTINCT FROM NEW.start_time           OR
    OLD.end_time             IS DISTINCT FROM NEW.end_time             OR
    OLD.duration_minutes     IS DISTINCT FROM NEW.duration_minutes     OR
    OLD.car_id               IS DISTINCT FROM NEW.car_id               OR
    OLD.car_identifier       IS DISTINCT FROM NEW.car_identifier       OR
    OLD.route_start          IS DISTINCT FROM NEW.route_start          OR
    OLD.route_end            IS DISTINCT FROM NEW.route_end            OR
    OLD.description          IS DISTINCT FROM NEW.description          OR
    OLD.price_amount         IS DISTINCT FROM NEW.price_amount         OR
    OLD.cash_amount          IS DISTINCT FROM NEW.cash_amount          OR
    OLD.online_amount        IS DISTINCT FROM NEW.online_amount        OR
    OLD.tip_amount           IS DISTINCT FROM NEW.tip_amount           OR
    OLD.action_amount        IS DISTINCT FROM NEW.action_amount        OR
    OLD.raw_data_json        IS DISTINCT FROM NEW.raw_data_json        OR
    OLD.original_driver_id   IS DISTINCT FROM NEW.original_driver_id   OR
    OLD.original_driver_name IS DISTINCT FROM NEW.original_driver_name OR
    OLD.import_id            IS DISTINCT FROM NEW.import_id            OR
    OLD.company_id           IS DISTINCT FROM NEW.company_id           OR
    OLD.source_status        IS DISTINCT FROM NEW.source_status        OR
    OLD.is_canceled          IS DISTINCT FROM NEW.is_canceled          OR
    OLD.start_at             IS DISTINCT FROM NEW.start_at             OR
    OLD.end_at               IS DISTINCT FROM NEW.end_at               OR
    OLD.time_zone            IS DISTINCT FROM NEW.time_zone            OR
    OLD.time_source          IS DISTINCT FROM NEW.time_source          OR
    OLD.trip_status          IS DISTINCT FROM NEW.trip_status          OR
    OLD.needs_review         IS DISTINCT FROM NEW.needs_review         OR
    OLD.review_reasons       IS DISTINCT FROM NEW.review_reasons       OR
    OLD.currency             IS DISTINCT FROM NEW.currency             OR
    OLD.currency_source      IS DISTINCT FROM NEW.currency_source      OR
    OLD.source_row_key       IS DISTINCT FROM NEW.source_row_key       OR
    OLD.source_row_key_basis IS DISTINCT FROM NEW.source_row_key_basis OR
    OLD.declined_fee_cents   IS DISTINCT FROM NEW.declined_fee_cents
  ) THEN
    RAISE EXCEPTION
      'fahrtenbuch_trips: immutable fields cannot be modified after insert.';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ─── 5. Self-checks ─────────────────────────────────────────────────────────

DO $selfcheck$
DECLARE
  c_message CONSTANT text := 'fahrtenbuch_trips: immutable fields cannot be modified after insert.';
  -- 20260922100000's 32, plus declined_fee_cents.
  c_protected CONSTANT text[] := ARRAY[
    'trip_date', 'start_time', 'end_time', 'duration_minutes', 'car_id', 'car_identifier',
    'route_start', 'route_end', 'description', 'price_amount', 'cash_amount', 'online_amount',
    'tip_amount', 'action_amount', 'raw_data_json', 'original_driver_id', 'original_driver_name',
    'import_id', 'company_id', 'source_status', 'is_canceled',
    'start_at', 'end_at', 'time_zone', 'time_source', 'trip_status', 'needs_review',
    'review_reasons', 'currency', 'currency_source', 'source_row_key', 'source_row_key_basis',
    'declined_fee_cents'
  ];
  c_mutable CONSTANT text[] := ARRAY[
    'id', 'assigned_driver_id', 'assigned_driver_name', 'plausibility_status',
    'assignment_reason', 'assignment_note', 'confirmed_by', 'confirmed_at',
    'created_at', 'updated_at', 'source_row_index', 'assignment_source',
    'assignment_block_id', 'assignment_planning_run_id', 'assignment_applied_at',
    'assignment_applied_by'
  ];
  v_wrong      text;
  v_refused    boolean;
  v_col        text;
  v_constraint text;
BEGIN
  -- 1. The column exists and is an integer. A numeric column here would make
  --    every later sum a float, which is the defect integer cents exist to stop.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
     WHERE a.attrelid = 'public.fahrtenbuch_trips'::regclass
       AND a.attname = 'declined_fee_cents' AND NOT a.attisdropped
       AND format_type(a.atttypid, a.atttypmod) = 'integer'
  ) THEN
    RAISE EXCEPTION 'declined status self-check 1: declined_fee_cents is missing or is not an integer';
  END IF;

  -- 2. Every column is protected or known to be mutable, and none is both.
  --    20260922100000's own rule, restated because a new column has to join a
  --    list rather than quietly belong to neither.
  SELECT string_agg(a.attname, ', ' ORDER BY a.attnum) INTO v_wrong
    FROM pg_attribute a
   WHERE a.attrelid = 'public.fahrtenbuch_trips'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped
     AND NOT (a.attname = ANY (c_protected)) AND NOT (a.attname = ANY (c_mutable));
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'declined status self-check 2: columns neither protected nor known to be mutable: %', v_wrong;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(c_protected) p WHERE p = ANY (c_mutable)) THEN
    RAISE EXCEPTION 'declined status self-check 2: a column is listed as both protected and mutable';
  END IF;

  -- 3. The restated trigger refuses the new column, and still refuses an old
  --    one. Fired on a scratch copy, so the answer is measured, not read.
  CREATE TEMP TABLE _fb_declined_probe (LIKE public.fahrtenbuch_trips INCLUDING DEFAULTS) ON COMMIT DROP;
  CREATE TRIGGER _fb_declined_probe BEFORE UPDATE ON _fb_declined_probe
    FOR EACH ROW EXECUTE FUNCTION public.protect_fahrtenbuch_immutable_fields();
  INSERT INTO _fb_declined_probe (company_id, import_id, trip_date, original_driver_name,
                                  assigned_driver_name, trip_status, declined_fee_cents)
  VALUES (gen_random_uuid(), gen_random_uuid(), DATE '2026-10-01', 'probe', 'probe', 'declined', 600);

  FOR v_col IN SELECT unnest(ARRAY['declined_fee_cents', 'trip_status']) LOOP
    v_refused := false;
    BEGIN
      IF v_col = 'declined_fee_cents' THEN
        UPDATE _fb_declined_probe SET declined_fee_cents = 700;
      ELSE
        UPDATE _fb_declined_probe SET trip_status = 'unknown';
      END IF;
    EXCEPTION WHEN raise_exception THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'declined status self-check 3: the trigger let % change', v_col;
    END IF;
  END LOOP;

  -- 4. An assignment column still changes: the trigger must not have become a
  --    blanket refusal, or applying a plan would stop working.
  UPDATE _fb_declined_probe SET assignment_note = 'probe';
  DROP TABLE _fb_declined_probe;

  /*
    5. The two CHECKs, probed.

    On a copy that carries the constraints: `LIKE ... INCLUDING DEFAULTS` alone
    copies defaults and **not** CHECKs, so the first version of this block
    probed a table with no constraints on it and would have reported a refusal
    that never happened. `INCLUDING CONSTRAINTS` copies the CHECKs; `LIKE`
    never copies foreign keys, which is why an invented company id is fine.

    Each refusal is matched on its **constraint name**, read from the
    diagnostics. Without that, a row refused by some unrelated CHECK —
    `times_consistent`, `review_check`, `currency_check` — would be counted as
    the refusal this block is looking for, and the probe would pass while
    measuring nothing. 5a is the positive control for the same reason: if any
    other constraint blocks the shape, it fails here and names itself, instead
    of making 5b and 5c vacuous.
  */
  CREATE TEMP TABLE _fb_check_probe
    (LIKE public.fahrtenbuch_trips INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP;

  -- 5a. A declined row with a fee is accepted.
  INSERT INTO _fb_check_probe (company_id, import_id, trip_date, original_driver_name,
                               assigned_driver_name, trip_status, declined_fee_cents)
  VALUES (gen_random_uuid(), gen_random_uuid(), DATE '2026-10-02', 'probe', 'probe', 'declined', 600);

  -- 5b. A completed row with a fee is refused, by the fee check.
  v_constraint := NULL;
  BEGIN
    INSERT INTO _fb_check_probe (company_id, import_id, trip_date, original_driver_name,
                                 assigned_driver_name, trip_status, declined_fee_cents)
    VALUES (gen_random_uuid(), gen_random_uuid(), DATE '2026-10-03', 'probe', 'probe', 'completed', 600);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
  END;
  IF v_constraint IS DISTINCT FROM 'fahrtenbuch_trips_declined_fee_check' THEN
    RAISE EXCEPTION 'declined status self-check 5b: a completed trip with a fee was refused by % instead of the fee check',
      coalesce(v_constraint, 'nothing');
  END IF;

  -- 5c. A declined row carrying is_canceled is refused, by the status check.
  v_constraint := NULL;
  BEGIN
    INSERT INTO _fb_check_probe (company_id, import_id, trip_date, original_driver_name,
                                 assigned_driver_name, trip_status, is_canceled, declined_fee_cents)
    VALUES (gen_random_uuid(), gen_random_uuid(), DATE '2026-10-04', 'probe', 'probe', 'declined', true, 600);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
  END;
  IF v_constraint IS DISTINCT FROM 'fahrtenbuch_trips_trip_status_check' THEN
    RAISE EXCEPTION 'declined status self-check 5c: a declined, cancelled trip was refused by % instead of the status check',
      coalesce(v_constraint, 'nothing');
  END IF;

  -- 5d. A negative fee is refused, by the fee check.
  v_constraint := NULL;
  BEGIN
    INSERT INTO _fb_check_probe (company_id, import_id, trip_date, original_driver_name,
                                 assigned_driver_name, trip_status, declined_fee_cents)
    VALUES (gen_random_uuid(), gen_random_uuid(), DATE '2026-10-05', 'probe', 'probe', 'declined', -1);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
  END;
  IF v_constraint IS DISTINCT FROM 'fahrtenbuch_trips_declined_fee_check' THEN
    RAISE EXCEPTION 'declined status self-check 5d: a negative fee was refused by % instead of the fee check',
      coalesce(v_constraint, 'nothing');
  END IF;
  DROP TABLE _fb_check_probe;

  -- 6. The map reads the new words, and reads the old ones exactly as before.
  IF app_private.fahrtenbuch_map_status('abgelehnt') <> 'declined'
     OR app_private.fahrtenbuch_map_status('Declined') <> 'declined'
     OR app_private.fahrtenbuch_map_status('abgeschlossen') <> 'completed'
     OR app_private.fahrtenbuch_map_status('storniert') <> 'cancelled'
     OR app_private.fahrtenbuch_map_status('nichtdurchgefuhrt') <> 'cancelled'
     OR app_private.fahrtenbuch_map_status('etwas anderes') <> 'unknown'
     OR app_private.fahrtenbuch_map_status('') <> 'unknown'
     OR app_private.fahrtenbuch_map_status(NULL) <> 'unknown' THEN
    RAISE EXCEPTION 'declined status self-check 6: fahrtenbuch_map_status does not read the expected words';
  END IF;

  -- 7. The backfill rule is NOT restated, so no stored row is reclassified. A
  --    word the map now reads as declined must still backfill to 'unknown' for
  --    a row the old importer stored as a ride.
  IF app_private.fahrtenbuch_trip_status_of(false, 'abgelehnt') <> 'unknown' THEN
    RAISE EXCEPTION 'declined status self-check 7: the backfill rule now reclassifies a historical row';
  END IF;

  -- 8. Still no UPDATE policy on the trips (20260908113000, 20260917130000).
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'fahrtenbuch_trips' AND cmd = 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'declined status self-check 8: an UPDATE policy appeared on fahrtenbuch_trips';
  END IF;

  RAISE NOTICE 'declined status: self-checks passed';
END;
$selfcheck$;
