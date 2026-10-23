-- ════════════════════════════════════════════════════════════════════════════
--  An order time the importer cannot read is now flagged on the row
-- ════════════════════════════════════════════════════════════════════════════
--
--  This migration does one thing: it widens
--  `fahrtenbuch_trips_review_check` to admit a ninth `review_reasons` value,
--  `'unreadable_order_transmission'`. The parser starts writing it in the same
--  release.
--
--  ── The gap ───────────────────────────────────────────────────────────────
--
--  `Uhrzeit der Auftragsuebermittlung` is parsed into no column of
--  `fahrtenbuch_trips`. It reaches exactly two places: `source_row_key`, which
--  hashes it **as text**, and `raw_data_json`, which copies it. `time_source`
--  is about the ride's start and end, and none of the eight review reasons
--  `20260922100000` admitted names this column. So a cell holding something
--  that is not a timestamp was stored with `needs_review = false` and nothing
--  anywhere saying its order time could not be read.
--
--  The rule that gap breaks is `20260922100000`'s own, in its header: *"a row
--  the file left incomplete is stored and flagged, not dropped, and no date is
--  invented"*. The flag is the half that was missing. The external audit
--  (`corection/FleetBook_Claude_Correction_Prompt.txt` §5) puts the same thing
--  the other way round: malformed input must not be silently accepted as an
--  authentic valid record.
--
--  PR #297 built the import-time half — `BuildStats.unreadableOrderTransmission`
--  with samples, and a wizard warning naming the column and the values before
--  the operator confirms — and stopped exactly here, because a ninth value
--  written against the old CHECK is refused, and **an import of a file holding
--  one malformed cell would then fail entirely**, which is worse than the
--  defect. So the CHECK is widened first and only then may code write the value.
--
--  ── Measured, read-only on staging, 23.10.2026 ────────────────────────────
--
--  Over 15,951 `fahrtenbuch_trips` rows, 15,899 of which carry the column:
--
--    cells the parser's own rule calls unreadable    369   all `is_simulated`
--    ... of those, keyed                             369   basis `derived_order_transmission`
--    ... distinct `source_row_key` values            369
--    ... with `needs_review` true                      0
--    rows with `needs_review` true, whole table        0
--    distinct values of `review_reasons`, whole table  none (every row is `{}`)
--
--  **The review mechanism of `20260922100000` has never fired on staging at
--  all.** Not one row of 15,951 carries a reason. That is worth knowing before
--  reading the 369 as an outlier: they are not rows the flag missed among many
--  it caught, they are 369 rows in a column nothing has ever flagged.
--
--  Production was not re-measured here; PR #297 measured **zero** malformed
--  values among its 13,959 keyed trips, and this migration adds no value to
--  any stored row either way.
--
--  **One correction to my own first measurement, and it is the reason the new
--  reason is not written for every cell that fails a regular expression.** A
--  SQL probe applying the parser's two timestamp patterns to the raw text
--  counted **372**, not 369. The extra three hold the literal two-character
--  null marker that `isMissingCell` recognises, they are **not** simulated —
--  they are real customer rows — and the parser treats them as an EMPTY cell,
--  not an unreadable one. `classifyTimestampCell` answers `empty` there and
--  the new reason is written only for `other`, so those three are correctly
--  left unflagged: nothing to read is not the same as something unreadable.
--  A regular expression over the stored text is not the parser's rule, and the
--  three-row difference is the whole of what that distinction is worth.
--
--  ── Why the name is not `unreadable_start` ────────────────────────────────
--
--  Because the ride's start is readable. `'unreadable_order_transmission'`
--  matches the existing `unreadable_start` / `unreadable_end` wording and says
--  which cell could not be read. Reusing `unreadable_start` would put a false
--  statement on the row, on a table that feeds the Stundennachweis and the
--  corrected Fahrtenbuch.
--
--  ── Why widening the CHECK before the bundle is safe, read out of deploy.sh ─
--
--  `deploy/deploy.sh` applies migrations at its migration step (its
--  `supabase/migrations/*.sql | sort` loop, each file in one transaction with
--  its ledger row) and swaps the bundle **afterwards**, at `mv dist.new dist`.
--  So the CHECK is widened before any code that could write the new value is
--  being served. And a rollback leaves a WIDENED CHECK with OLDER code: that
--  code never writes the ninth value, and a widened `<@` set refuses nothing
--  the narrow one admitted, so the old release is unaffected. **No
--  `SCHEMA_EPOCH` bump**: this is additive in the one direction a rollback
--  cares about.
--
--  For the same reason the constraint is replaced VALIDATED rather than
--  `NOT VALID`: the new allowed set is a strict superset of the old one, so
--  every row that satisfied the old constraint satisfies the new one by
--  construction, and the scan (15,951 rows on staging, 13,959 on production)
--  costs a brief ACCESS EXCLUSIVE lock and nothing else. There is no violating
--  history to leave alone, which is what `20261023140000` needed `NOT VALID`
--  for.
--
--  ── What this migration deliberately does NOT do ──────────────────────────
--
--  * **It does not backfill the 369 rows.** They are the record of what was
--    imported, and `review_reasons` and `needs_review` are both in
--    `protect_fahrtenbuch_immutable_fields`' protected set, so changing a
--    stored row's flag is not an UPDATE anybody can make by accident — it
--    would be a deliberate, trigger-disabling data change. That is the owner's
--    call. Every one of those rows is `is_simulated`.
--  * **It does not change how a row is keyed or deduped.** `source_row_key`
--    hashes the cell as TEXT, so a malformed value hashes like any other:
--    measured on staging, all 369 are keyed, all with basis
--    `derived_order_transmission`, and all 369 keys are distinct. So the same
--    file is still refused per company and the same ride still cannot be
--    imported twice. The flag is a statement about the row, not about its key.
--  * **It writes no value anywhere.** The parser does that, in `src/`.

-- ─── 1. the ninth reason ────────────────────────────────────────────────────

/*
  Idempotent: the constraint is replaced only when its definition does not
  already name the new value, so a second run is a catalogue read and nothing
  else. DROP and ADD are one statement, so the table is locked once.

  The constraint is found by name — `fahrtenbuch_trips` carries several other
  CHECKs (`..._time_check`, `..._trip_status_check`, `..._currency_check`,
  `..._source_row_key_check`) which all raise 23514 too, so nothing here may
  key on the SQLSTATE or on a pattern that could match one of them.
*/
DO $widen$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.fahrtenbuch_trips'::regclass
     AND conname = 'fahrtenbuch_trips_review_check';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'review reason: fahrtenbuch_trips_review_check is absent, so there is nothing to widen — 20260922100000 did not apply';
  END IF;

  IF v_def LIKE '%unreadable_order_transmission%' THEN
    RAISE NOTICE 'review reason: fahrtenbuch_trips_review_check already admits unreadable_order_transmission';
    RETURN;
  END IF;

  ALTER TABLE public.fahrtenbuch_trips
    DROP CONSTRAINT fahrtenbuch_trips_review_check,
    ADD  CONSTRAINT fahrtenbuch_trips_review_check
      CHECK (needs_review = (cardinality(review_reasons) > 0)
             AND review_reasons <@ ARRAY[
               'missing_trip_date', 'missing_start', 'unreadable_start', 'missing_end',
               'unreadable_end', 'end_before_start', 'missing_driver', 'unknown_status',
               'unreadable_order_transmission'
             ]::text[]);

  RAISE NOTICE 'review reason: fahrtenbuch_trips_review_check widened to admit unreadable_order_transmission';
END
$widen$;

COMMENT ON COLUMN public.fahrtenbuch_trips.review_reasons IS
  'Why the row needs a human look, in the parser''s canonical order. Nine '
  'values since 20261023170000, which added unreadable_order_transmission: '
  '"Uhrzeit der Auftragsuebermittlung" is parsed into no column of this table '
  '(it is hashed as text into source_row_key and copied into raw_data_json), '
  'so a cell that is not a timestamp was stored with needs_review false and '
  'nothing saying its order time could not be read. The ride''s own start is '
  'unaffected and keeps unreadable_start, which must not be reused for this: '
  'saying the start is unreadable when it is not puts a false statement on a '
  'row that feeds the Stundennachweis. Written at import only — this column '
  'and needs_review are both in protect_fahrtenbuch_immutable_fields.';

-- ─── 2. Self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  c_expected CONSTANT text[] := ARRAY[
    'missing_trip_date', 'missing_start', 'unreadable_start', 'missing_end',
    'unreadable_end', 'end_before_start', 'missing_driver', 'unknown_status',
    'unreadable_order_transmission'
  ];
  v_def    text;
  v_found  text[];
  v_n      int;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.fahrtenbuch_trips'::regclass
     AND conname = 'fahrtenbuch_trips_review_check';

  -- 1. the constraint exists under its own name and is a validated CHECK. A
  --    NOT VALID one would admit the value for new rows and report a different
  --    shape to every catalogue reader; there is no violating history here, so
  --    there is no reason for it to be anything but validated.
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'review reason self-check 1: fahrtenbuch_trips_review_check is gone';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.fahrtenbuch_trips'::regclass
       AND conname = 'fahrtenbuch_trips_review_check'
       AND contype = 'c' AND convalidated
  ) THEN
    RAISE EXCEPTION 'review reason self-check 1: fahrtenbuch_trips_review_check is not a validated CHECK';
  END IF;

  -- 2. it admits EXACTLY the nine values, in that order, read out of the
  --    catalogue rather than out of this file's claim. A tenth value nobody
  --    writes is as much a defect as a missing ninth: the set is the contract
  --    src/utils/fahrtenbuchImportParser.ts's REVIEW_REASONS is compared to.
  SELECT array_agg(m[1] ORDER BY ord) INTO v_found
    FROM regexp_matches(v_def, '''([a-z_]+)''::text', 'g') WITH ORDINALITY AS t(m, ord);
  IF v_found IS DISTINCT FROM c_expected THEN
    RAISE EXCEPTION 'review reason self-check 2: the constraint admits % (expected %)',
      coalesce(v_found::text, 'nothing'), c_expected::text;
  END IF;

  -- 3. the needs_review pairing is still there. Without it the flag could be
  --    false on a row that names a reason, which is precisely the state this
  --    whole family of columns exists to make impossible.
  IF v_def NOT LIKE '%needs_review = (cardinality(review_reasons) > 0)%' THEN
    RAISE EXCEPTION 'review reason self-check 3: the needs_review/cardinality pairing is gone from the constraint: %', v_def;
  END IF;

  -- 4. no stored row was changed. This migration widens what is allowed and
  --    writes nothing; a backfill of the 369 staging rows is the owner's call
  --    and would have to disable an immutability trigger to happen at all.
  SELECT count(*) INTO v_n FROM public.fahrtenbuch_trips
   WHERE 'unreadable_order_transmission' = ANY (review_reasons);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'review reason self-check 4: % row(s) already carry the new reason, so something backfilled it', v_n;
  END IF;

  -- 5. both columns are still protected after insert, so the flag can only be
  --    set by the import that wrote the row. If a later migration dropped them
  --    from the trigger, a flag could be cleared by any UPDATE and this whole
  --    change would be a suggestion rather than a record.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.protect_fahrtenbuch_immutable_fields()'::regprocedure
       AND prosrc LIKE '%OLD.review_reasons%IS DISTINCT FROM%NEW.review_reasons%'
       AND prosrc LIKE '%OLD.needs_review%IS DISTINCT FROM%NEW.needs_review%'
  ) THEN
    RAISE EXCEPTION 'review reason self-check 5: protect_fahrtenbuch_immutable_fields no longer refuses a change to needs_review and review_reasons';
  END IF;

  -- 6. and the table still has no UPDATE policy, which is the other half of
  --    the same point: every write to a trip goes through an RPC.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'fahrtenbuch_trips' AND cmd = 'UPDATE';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'review reason self-check 6: % UPDATE policy/ies appeared on fahrtenbuch_trips', v_n;
  END IF;

  RAISE NOTICE 'review reason: self-checks passed — a malformed order time can now be flagged on the row';
END
$check$;
