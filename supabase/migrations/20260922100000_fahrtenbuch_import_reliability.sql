/*
  # Fahrtenbuch import reliability (Fahrtenanalyse, slice A)

  The monthly Fahrtenbuch import is the artefact the whole payroll chain hangs
  off, and reading the August 2026 Uber export against today's importer showed
  five ways it loses or bends the ride it is given:

    1. `trip_date` is the file's "Datum der Fahrt", the time is its "Uhrzeit des
       Fahrtbeginns". For a ride that starts between 00:00 and 00:30 the export
       dates it on the day before (the order's day), so 22 rides of that month
       sit a day early once date and time are combined.
    2. seconds are dropped;
    3. uploading the same file twice stores every ride twice: there is no file
       fingerprint and no ride key;
    4. any status the importer does not recognise counts as a completed ride;
    5. a row missing its date, start, end or driver is dropped, and a
       cancelled row without a date is given today's date and the driver
       "Unbekannt".

  ## The boundary

  A ride that happened is never reassigned, re-timed or re-priced here. This
  file only **adds**: columns, checks, flags and an index. `trip_date`,
  `start_time`, `end_time`, `duration_minutes` and every amount keep the
  meaning and the values they have, because planning, the Stundennachweis and
  the Fahrtenbuch export read them. The new columns sit beside them, and
  `protect_fahrtenbuch_immutable_fields` refuses to change them after the
  insert, exactly as it refuses the old ones.

  ## What a trip gains

    start_at, end_at    timestamptz: the instants the ride began and ended,
                        from the source's own start and end timestamps read as
                        wall-clock time in Europe/Berlin (the files carry no
                        zone). Both or neither: an interval with one end is not
                        an interval.
    time_zone           the zone they were read in; NULL when they are NULL
    time_source         how they were obtained:
                          source_start_end    both source cells hold a date and
                                              a time
                          fallback_trip_date  neither holds a date, so trip_date
                                              + start_time / end_time, the end
                                              moved to the next day when earlier
                          missing             a source cell is empty (a
                                              cancelled ride has neither)
                          unparsed            a cell holds something that is not
                                              a zone-less timestamp (ISO
                                              'YYYY-MM-DD HH:MM[:SS]', German
                                              'D.M.YYYY H:MM[:SS]', or an Excel
                                              date-and-time number)
                          ambiguous           the wall time falls in a DST
                                              change — twice (October) or never
                                              (March) — so no single instant
    trip_status         completed | cancelled | unknown, from an explicit map:
                        'abgeschlossen' completed; the eight words the old
                        importer read as cancelled ('storno', 'storniert',
                        'storniertfahrt', 'stornierung', 'cancelled',
                        'canceled', 'abgebrochen', 'nichtdurchgefuhrt')
                        cancelled; anything else unknown.
                        `source_status` keeps the text. A check ties it to
                        `is_canceled`, so unknown is never a completed ride and
                        never a cancelled one.
    needs_review,       a row the file left incomplete, kept and flagged
    review_reasons      instead of dropped
    currency,           'EUR', 'assumed': the files carry no currency.
    currency_source     `price_amount` is not touched.
    source_row_key,     SHA-256 naming the ride across files, computed in the
    source_row_key_basis browser; the basis says it is derived and from what.
                        A unique index per company refuses a second copy.

  And an import gains `file_sha256`, the SHA-256 of the uploaded file,
  computed in the browser before upload; a unique constraint per company
  refuses the same file twice.

  ## The backfill

  Every existing trip gets start_at / end_at / time_zone / time_source,
  trip_status and its review flags, from what it already holds:

  - The start and end cells are found in `raw_data_json` by the same rule as
    `resolveActualRideWindow` in src/utils/planningQualityChecks.ts:
    `findActualRideCol` with ACTUAL_START_TOKENS / ACTUAL_END_TOKENS, an exact
    normalised match before a substring match, in the order jsonb returns the
    keys (which is the order the browser sees them in after a load), and never
    a column whose name holds an order or dispatch fragment (Auftrag…,
    …übermittlung, Disposition, Vermittlung, Eingang).
  - Where that function would fall back to trip_date + HH:MM whatever the cells
    hold, this one does so only when neither cell carries a date of its own.
    A cell that carries a date but cannot be read is 'unparsed' and left NULL:
    combining trip_date with a time is exactly how the 22 rides above end up a
    day early. Nor does it copy that function's midnight rule, which adds a
    fixed 24 hours to an instant and is wrong on both DST nights: an end
    earlier than the start moves one day on the wall clock and is then read in
    Europe/Berlin like any other wall time, so 23:50 CEST to 03:10 CET on
    24./25.10. is 4 h 20 min. An end equal to the start stays equal (the
    browser function adds 24 hours).
  - trip_status is 'cancelled' where `is_canceled`, 'completed' where the
    stored status reads 'abgeschlossen', and 'unknown' otherwise — a file
    without a status column included, and a cancel word on a row the old
    importer stored as a ride (which it never did: its list held all five).
  - review_reasons: missing_start / missing_end for a ride that is not
    cancelled and has no time; end_before_start; missing_driver for an empty
    name, `\N`, or the placeholder "Unbekannt" the old importer wrote on a
    cancelled row; unknown_status.
  - source_row_key stays NULL: the existing rows may already hold the
    duplicates this index is meant to refuse, and the key is computed where
    the file is read. The unique index therefore only compares keyed rows.

  It runs as `app_private.fahrtenbuch_trips_backfill_import_facts()`, a
  function rather than a DO block so the RLS kit can call it
  (tests/rls/fahrtenbuch-import.sql), and it runs **before** the trigger is
  restated: the version in force still refuses any change to the old columns,
  so the backfill's own UPDATE proves it touches none of them. That UPDATE
  also sets `updated_at`, as the trigger does for every update. It reports its
  counts with RAISE NOTICE — the numbers a production-sized copy is measured
  by (HANDOFF.md has the procedure: restore the newest pg_dump snapshot into a
  throwaway supabase/postgres container, apply this file inside BEGIN …
  ROLLBACK, read the NOTICE).

  ## Cost

  ADD COLUMN takes an ACCESS EXCLUSIVE lock on fahrtenbuch_trips, and the
  transaction holds it through the backfill, so the Fahrtenbuch screens and
  the planning RPCs wait until the release commits. Measured in a throwaway
  supabase/postgres:17.6.1.170 limited to one CPU under Docker Desktop:
  100 000 synthetic Uber-shaped trips backfilled in 1 min 55 s, and the checks
  and indexes after it in seconds. The column rule runs once per set of keys,
  the rest once per trip.

  ## The trigger

  `protect_fahrtenbuch_immutable_fields` is restated from its last definition
  (20260606035519, which is what production runs — tests/fixtures/schema.sql
  carries the same body): the same 21 comparisons in the same order, the same
  message, the same `NEW.updated_at := now()`, the same absence of a pinned
  search_path, and eleven comparisons appended. Self-check 1 fires it on a
  scratch copy of the table and fails the release if any column changes
  hands between "refused" and "allowed".

  ## Rollback

  Backward compatible, so no SCHEMA_EPOCH bump: every new column is nullable or
  has a default, and the release before this one writes none of them. A trip
  it inserts after a rollback carries NULL time_source and trip_status (the
  checks allow it) and no key, so the index does not see it.

  ## Grants

  The helpers live in `app_private`, are SECURITY INVOKER, pin their
  search_path and grant EXECUTE to nobody: only the migration and the kit call
  them. The trigger function on fahrtenbuch_imports is fired by the table, not
  called through a grant (as `refuse_direct_subscription_write` is).
*/

-- ─── 1. Columns ─────────────────────────────────────────────────────────────

ALTER TABLE public.fahrtenbuch_trips
  ADD COLUMN start_at             timestamptz,
  ADD COLUMN end_at               timestamptz,
  ADD COLUMN time_zone            text,
  ADD COLUMN time_source          text,
  ADD COLUMN trip_status          text,
  ADD COLUMN needs_review         boolean NOT NULL DEFAULT false,
  ADD COLUMN review_reasons       text[]  NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN currency             text    NOT NULL DEFAULT 'EUR',
  ADD COLUMN currency_source      text    NOT NULL DEFAULT 'assumed',
  ADD COLUMN source_row_key       text,
  ADD COLUMN source_row_key_basis text;

ALTER TABLE public.fahrtenbuch_imports
  ADD COLUMN file_sha256 text;

COMMENT ON COLUMN public.fahrtenbuch_trips.start_at IS
  'When the ride began: the source start timestamp read as wall time in time_zone. NULL unless time_source is source_start_end or fallback_trip_date. trip_date and start_time keep their older meaning beside it.';
COMMENT ON COLUMN public.fahrtenbuch_trips.end_at IS
  'When the ride ended; set exactly when start_at is.';
COMMENT ON COLUMN public.fahrtenbuch_trips.time_zone IS
  'The zone start_at and end_at were read in (Europe/Berlin); NULL when they are NULL.';
COMMENT ON COLUMN public.fahrtenbuch_trips.time_source IS
  'source_start_end | fallback_trip_date | missing | unparsed | ambiguous — how start_at/end_at were obtained, or why they are NULL.';
COMMENT ON COLUMN public.fahrtenbuch_trips.trip_status IS
  'completed | cancelled | unknown, from source_status by an explicit map. cancelled exactly when is_canceled.';
COMMENT ON COLUMN public.fahrtenbuch_trips.needs_review IS
  'The source row was incomplete or unclear; review_reasons says how. Written at import, never changed.';
COMMENT ON COLUMN public.fahrtenbuch_trips.currency_source IS
  'assumed: the file carried no currency and EUR was recorded. price_amount is as read.';
COMMENT ON COLUMN public.fahrtenbuch_trips.source_row_key IS
  'Derived, not a source id: SHA-256 of the order-transmission time + driver + plate, or of the start + driver + plate (source_row_key_basis says which). Unique per company.';
COMMENT ON COLUMN public.fahrtenbuch_imports.file_sha256 IS
  'SHA-256 of the uploaded file, computed in the browser. Unique per company: the same file is not imported twice.';

-- ─── 2. The derivation, as functions the kit can call ───────────────────────

/*
  The normalisation of planningQualityChecks.ts `norm()`: lowercase, then keep
  [a-z0-9] only. An umlaut is dropped, not transliterated, exactly as there.
*/
CREATE FUNCTION app_private.fahrtenbuch_norm(p_text text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]', '', 'g');
END;
$$;

/*
  The token lists of src/utils/planningQualityChecks.ts, written as they are
  there (src/utils/fahrtenbuchImportParser.test.ts fails when they part), and
  returned normalised. The backfill asks once, not once per trip: normalising
  them per trip was most of a first version's 3 ms a trip.
*/
CREATE FUNCTION app_private.fahrtenbuch_ride_tokens(
  OUT start_norms text[], OUT end_norms text[], OUT reject_norms text[])
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- ACTUAL_START_TOKENS
  c_start_tokens CONSTANT text[] := ARRAY[
    'uhrzeit des fahrtbeginns',
    'uhrzeites fahrtbeginns',
    'uhrzeit fahrtbeginn',
    'fahrtbeginn',
    'beginn der fahrt',
    'startzeit der fahrt',
    'start time',
    'startzeit'
  ];
  -- ACTUAL_END_TOKENS
  c_end_tokens CONSTANT text[] := ARRAY[
    'uhrzeit des fahrtendes',
    'uhrzeit fahrtende',
    'fahrtende',
    'ende der fahrt',
    'endzeit der fahrt',
    'end time',
    'endzeit'
  ];
  -- REJECT_COL_FRAGMENTS
  c_reject_fragments CONSTANT text[] := ARRAY[
    'auftrag',
    'auftragseingang',
    'auftragsuebermittlung',
    'auftragsübermittlung',
    'übermittlung',
    'uebermittlung',
    'disposition',
    'vermittlung',
    'eingang'
  ];
BEGIN
  start_norms  := ARRAY(SELECT app_private.fahrtenbuch_norm(t.v) FROM unnest(c_start_tokens)     WITH ORDINALITY AS t(v, n) ORDER BY t.n);
  end_norms    := ARRAY(SELECT app_private.fahrtenbuch_norm(t.v) FROM unnest(c_end_tokens)       WITH ORDINALITY AS t(v, n) ORDER BY t.n);
  reject_norms := ARRAY(SELECT app_private.fahrtenbuch_norm(t.v) FROM unnest(c_reject_fragments) WITH ORDINALITY AS t(v, n) ORDER BY t.n);
END;
$$;

/*
  findActualRideCol, for the start and the end: which key holds each. The
  first key matching a token exactly (normalised), else the first containing
  one — every token exactly before any as a substring, then token order, then
  key order (jsonb's, which is the order the browser sees after a load) —
  never a key holding an order or dispatch fragment. NULL when none matches.

  It reads key names only, never values, so it is asked once per set of keys
  (every row of one import has the same keys) instead of once per trip.
*/
CREATE FUNCTION app_private.fahrtenbuch_ride_keys(
  p_keys text[], p_start_norms text[], p_end_norms text[], p_reject_norms text[],
  OUT start_key text, OUT end_key text)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- The OFFSET 0 keeps the normalisation from being pulled into the anti-join,
  -- where it would run once per key and fragment.
  WITH cells AS MATERIALIZED (
    SELECT k.key, k.norm, k.n
      FROM (SELECT u.key, regexp_replace(lower(u.key), '[^a-z0-9]', '', 'g') AS norm, u.n
              FROM unnest(p_keys) WITH ORDINALITY AS u(key, n)
            OFFSET 0) k
     WHERE NOT EXISTS (SELECT 1 FROM unnest(p_reject_norms) AS r(fragment) WHERE strpos(k.norm, r.fragment) > 0)
  )
  SELECT (SELECT c.key
            FROM cells c
            JOIN unnest(p_start_norms) WITH ORDINALITY AS tk(norm, n) ON strpos(c.norm, tk.norm) > 0
           ORDER BY (c.norm = tk.norm) DESC, tk.n, c.n
           LIMIT 1),
         (SELECT c.key
            FROM cells c
            JOIN unnest(p_end_norms) WITH ORDINALITY AS tk(norm, n) ON strpos(c.norm, tk.norm) > 0
           ORDER BY (c.norm = tk.norm) DESC, tk.n, c.n
           LIMIT 1)
    INTO start_key, end_key;
END;
$$;

/* A raw_data_json's keys in jsonb's order; none for anything but an object. */
CREATE FUNCTION app_private.fahrtenbuch_raw_keys(p_raw jsonb)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_raw IS NULL OR jsonb_typeof(p_raw) <> 'object' THEN
    RETURN '{}'::text[];
  END IF;
  RETURN ARRAY(SELECT k FROM jsonb_object_keys(p_raw) WITH ORDINALITY AS o(k, n) ORDER BY o.n);
END;
$$;

/*
  What a start or end cell holds — classifyTimestampCell in
  src/utils/fahrtenbuchImportParser.ts, rule for rule:

    empty     SQL NULL, JSON null, or text that is empty or \N after trimming
              space, tab, CR and LF
    datetime  text 'YYYY-MM-DD HH:MM[:SS[.fraction]]' (or with a T), or the
              German 'D.M.YYYY H:MM[:SS]', naming a real calendar day and
              clock time, year 1900-2999; the fraction is dropped. Or a number
              with a whole part of at least 61 and a fraction: an Excel date
              and time, rounded to the second.
    time      text 'H:MM[:SS[.fraction]]', or a number from 0 up to 1
    other     anything else: a date with a zone, an impossible day, a whole
              number (a date with no time), a boolean
*/
CREATE FUNCTION app_private.fahrtenbuch_cell_wall(p_cell jsonb, OUT kind text, OUT wall timestamp)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_text   text;
  v_number numeric;
  v_m      text[];
  v_year   integer;
  v_month  integer;
  v_day    integer;
  v_hour   integer;
  v_minute integer;
  v_second integer;
BEGIN
  wall := NULL;

  IF p_cell IS NULL OR jsonb_typeof(p_cell) = 'null' THEN
    kind := 'empty';
    RETURN;
  END IF;

  IF jsonb_typeof(p_cell) = 'number' THEN
    v_number := (p_cell #>> '{}')::numeric;
    IF v_number < 0 THEN
      kind := 'other';
    ELSIF v_number < 1 THEN
      kind := 'time';
    ELSIF v_number < 61 OR v_number >= 1000000 OR v_number = trunc(v_number) THEN
      kind := 'other';
    ELSE
      wall := timestamp '1899-12-30 00:00:00'
              + make_interval(secs => round(v_number * 86400)::double precision);
      IF extract(year FROM wall) BETWEEN 1900 AND 2999 THEN
        kind := 'datetime';
      ELSE
        wall := NULL;
        kind := 'other';
      END IF;
    END IF;
    RETURN;
  END IF;

  IF jsonb_typeof(p_cell) <> 'string' THEN
    kind := 'other';
    RETURN;
  END IF;

  v_text := btrim(p_cell #>> '{}', E' \t\r\n');
  IF v_text = '' OR v_text = E'\\N' THEN
    kind := 'empty';
    RETURN;
  END IF;

  -- [0-9], not \d: in a UTF-8 database \d also matches other scripts' digits,
  -- which the integer casts below would refuse.
  v_m := regexp_match(v_text, '^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]{1,9})?)?$');
  IF v_m IS NOT NULL THEN
    kind := 'other';
    v_year   := v_m[1]::integer;
    v_month  := v_m[2]::integer;
    v_day    := v_m[3]::integer;
    v_hour   := v_m[4]::integer;
    v_minute := v_m[5]::integer;
    v_second := coalesce(v_m[6]::integer, 0);
  ELSE
    -- The German spelling, day first: '01.08.2026 10:05[:31]'.
    v_m := regexp_match(v_text, '^([0-9]{1,2})\.([0-9]{1,2})\.([0-9]{4}) ([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?$');
    IF v_m IS NOT NULL THEN
      kind := 'other';
      v_year   := v_m[3]::integer;
      v_month  := v_m[2]::integer;
      v_day    := v_m[1]::integer;
      v_hour   := v_m[4]::integer;
      v_minute := v_m[5]::integer;
      v_second := coalesce(v_m[6]::integer, 0);
    END IF;
  END IF;

  IF v_m IS NOT NULL THEN
    -- Nested, not one AND: make_date must never see month 13.
    IF v_year BETWEEN 1900 AND 2999 AND v_month BETWEEN 1 AND 12 THEN
      IF v_day BETWEEN 1 AND extract(day FROM make_date(v_year, v_month, 1) + interval '1 month' - interval '1 day')
         AND v_hour <= 23 AND v_minute <= 59 AND v_second <= 59 THEN
        wall := make_timestamp(v_year, v_month, v_day, v_hour, v_minute, v_second);
        kind := 'datetime';
      END IF;
    END IF;
    RETURN;
  END IF;

  IF v_text ~ '^[0-9]{1,2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,9})?)?$' THEN
    kind := 'time';
  ELSE
    kind := 'other';
  END IF;
END;
$$;

/*
  The instant a wall-clock time names in a zone — wallTimeToInstant in the
  parser. Every offset the zone uses within 24 hours either side is tried, and
  the candidates that read back as the same wall time are counted: one is the
  answer, two means the hour repeats, none means it was skipped. `instant` is
  set only for exactly one. Written against the zone rules, not against
  Berlin's +01/+02, and independent of the session's TimeZone.
*/
CREATE FUNCTION app_private.fahrtenbuch_wall_to_instant(
  p_wall timestamp, p_zone text, OUT instant timestamptz, OUT candidates integer)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_as_utc    timestamptz := p_wall AT TIME ZONE 'UTC';
  v_probe     timestamptz;
  v_candidate timestamptz;
  v_found     timestamptz[] := '{}';
BEGIN
  -- Plain expressions, no query: the backfill calls this twice per trip.
  FOREACH v_probe IN ARRAY ARRAY[v_as_utc - interval '24 hours', v_as_utc, v_as_utc + interval '24 hours'] LOOP
    v_candidate := v_as_utc - ((v_probe AT TIME ZONE p_zone) - (v_probe AT TIME ZONE 'UTC'));
    IF (v_candidate AT TIME ZONE p_zone) = p_wall AND NOT (v_candidate = ANY (v_found)) THEN
      v_found := v_found || v_candidate;
    END IF;
  END LOOP;

  candidates := cardinality(v_found);
  instant := CASE WHEN candidates = 1 THEN v_found[1] END;
END;
$$;

/*
  start_at, end_at, time_zone and time_source from a trip's start and end
  cells — deriveTripTimes in the parser. p_start_time / p_end_time are the
  stored columns, which is what the fallback combines with trip_date, as
  resolveActualRideWindow does.
*/
CREATE FUNCTION app_private.fahrtenbuch_times_from_cells(
  p_start_cell jsonb, p_end_cell jsonb, p_trip_date date, p_start_time time, p_end_time time,
  OUT start_at timestamptz, OUT end_at timestamptz, OUT time_zone text, OUT time_source text)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_zone CONSTANT text := 'Europe/Berlin';
  v_start      record;
  v_end        record;
  v_start_wall timestamp;
  v_end_wall   timestamp;
  v_s          record;
  v_e          record;
BEGIN
  start_at := NULL;
  end_at := NULL;
  time_zone := NULL;
  time_source := NULL;

  -- Assignments, not SELECT … INTO: no query per call (the backfill runs this
  -- once per trip).
  v_start := app_private.fahrtenbuch_cell_wall(p_start_cell);
  v_end   := app_private.fahrtenbuch_cell_wall(p_end_cell);

  IF v_start.kind = 'datetime' AND v_end.kind = 'datetime' THEN
    v_start_wall := v_start.wall;
    v_end_wall := v_end.wall;
    time_source := 'source_start_end';
  ELSIF v_start.kind IN ('time', 'empty') AND v_end.kind IN ('time', 'empty')
        AND p_trip_date IS NOT NULL AND p_start_time IS NOT NULL AND p_end_time IS NOT NULL THEN
    v_start_wall := p_trip_date + p_start_time;
    v_end_wall := p_trip_date + p_end_time;
    IF p_end_time < p_start_time THEN
      v_end_wall := v_end_wall + interval '1 day';
    END IF;
    -- The parser's validWall bound, on both ends.
    IF extract(year FROM v_start_wall) BETWEEN 1900 AND 2999
       AND extract(year FROM v_end_wall) BETWEEN 1900 AND 2999 THEN
      time_source := 'fallback_trip_date';
    END IF;
  END IF;

  IF time_source IS NULL THEN
    time_source := CASE WHEN v_start.kind = 'empty' OR v_end.kind = 'empty' THEN 'missing' ELSE 'unparsed' END;
    RETURN;
  END IF;

  v_s := app_private.fahrtenbuch_wall_to_instant(v_start_wall, c_zone);
  v_e := app_private.fahrtenbuch_wall_to_instant(v_end_wall, c_zone);

  IF v_s.candidates = 1 AND v_e.candidates = 1 THEN
    start_at := v_s.instant;
    end_at := v_e.instant;
    time_zone := c_zone;
  ELSE
    time_source := 'ambiguous';
  END IF;
END;
$$;

/*
  The whole derivation for one trip, from its raw_data_json: what the kit and
  the self-check call. The backfill runs the same three steps with the tokens
  asked for once.
*/
CREATE FUNCTION app_private.fahrtenbuch_trip_times(
  p_raw jsonb, p_trip_date date, p_start_time time, p_end_time time,
  OUT start_at timestamptz, OUT end_at timestamptz, OUT time_zone text, OUT time_source text)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tokens record;
  v_keys   record;
  v_times  record;
BEGIN
  SELECT * INTO v_tokens FROM app_private.fahrtenbuch_ride_tokens();
  SELECT * INTO v_keys FROM app_private.fahrtenbuch_ride_keys(
    app_private.fahrtenbuch_raw_keys(p_raw), v_tokens.start_norms, v_tokens.end_norms, v_tokens.reject_norms);
  SELECT * INTO v_times FROM app_private.fahrtenbuch_times_from_cells(
    p_raw -> v_keys.start_key, p_raw -> v_keys.end_key, p_trip_date, p_start_time, p_end_time);
  start_at := v_times.start_at;
  end_at := v_times.end_at;
  time_zone := v_times.time_zone;
  time_source := v_times.time_source;
END;
$$;

/*
  What a status word means — mapTripStatus in the parser, with the same two
  lists (src/utils/fahrtenbuchImportParser.test.ts fails when they part),
  compared after the same normalisation. The cancelled list keeps the words
  the importer before this migration read as cancelled (owner's decision,
  22.09.2026). An empty cell, `\N` and every other word are 'unknown'.
*/
CREATE FUNCTION app_private.fahrtenbuch_map_status(p_text text)
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
  RETURN 'unknown';
END;
$$;

/*
  trip_status for a row that was stored before this migration. is_canceled is
  what the old importer decided and cannot change, so it wins — it also read a
  few words beyond the map, and a status-less file whose time cell said
  "storniert". Otherwise the map decides, and a word it reads as cancelled on a
  row the old importer stored as a ride is 'unknown': the check ties
  'cancelled' to is_canceled, and the contradiction is exactly what review is
  for.
*/
CREATE FUNCTION app_private.fahrtenbuch_trip_status_of(p_is_canceled boolean, p_source_status text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_is_canceled THEN
    RETURN 'cancelled';
  END IF;
  IF app_private.fahrtenbuch_map_status(p_source_status) = 'completed' THEN
    RETURN 'completed';
  END IF;
  RETURN 'unknown';
END;
$$;

/*
  review_reasons for a row that was stored before this migration, in the
  canonical order of REVIEW_REASONS in the parser. The reasons only the file
  can tell (missing_trip_date, unreadable_*) cannot be recovered and are not
  guessed.
*/
CREATE FUNCTION app_private.fahrtenbuch_backfill_review_reasons(
  p_is_canceled boolean, p_start_time time, p_end_time time, p_driver text,
  p_trip_status text, p_time_source text, p_start_at timestamptz, p_end_at timestamptz)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN array_remove(ARRAY[
    CASE WHEN NOT p_is_canceled AND p_start_time IS NULL THEN 'missing_start' END,
    CASE WHEN NOT p_is_canceled AND p_end_time IS NULL THEN 'missing_end' END,
    CASE WHEN p_time_source = 'source_start_end' AND p_end_at < p_start_at THEN 'end_before_start' END,
    CASE WHEN btrim(coalesce(p_driver, '')) IN ('', E'\\N')
           OR (p_is_canceled AND p_driver = 'Unbekannt') THEN 'missing_driver' END,
    CASE WHEN p_trip_status = 'unknown' THEN 'unknown_status' END
  ]::text[], NULL::text);
END;
$$;

/*
  The backfill: every trip not yet given a time_source and a trip_status.
  Returns and the migration prints the counts. After the trigger below is
  restated it can change nothing — setting a protected column from NULL is a
  change — so it runs once, here, or in the kit under the previous trigger body.

  Two statements, not one. The derivation is written to a keyed scratch table
  first, and the UPDATE joins it by id: a single statement left the join order
  to the planner's row estimates, and with a stale estimate for the trips it
  chose to rescan the derivation once per trip — 16 minutes for 100 000 trips
  on one CPU where the two statements take about one.
*/
CREATE FUNCTION app_private.fahrtenbuch_trips_backfill_import_facts()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_counts  jsonb;
  v_updated bigint;
BEGIN
  IF to_regclass('pg_temp.fahrtenbuch_backfill') IS NOT NULL THEN
    DROP TABLE pg_temp.fahrtenbuch_backfill;
  END IF;

  CREATE TEMP TABLE fahrtenbuch_backfill ON COMMIT DROP AS
  WITH tokens AS MATERIALIZED (
    SELECT * FROM app_private.fahrtenbuch_ride_tokens()
  ), pending AS MATERIALIZED (
    SELECT t.id, t.raw_data_json, t.trip_date, t.start_time, t.end_time, t.is_canceled,
           t.source_status, t.original_driver_name,
           app_private.fahrtenbuch_raw_keys(t.raw_data_json) AS raw_keys
      FROM public.fahrtenbuch_trips t
     WHERE t.time_source IS NULL
       AND t.trip_status IS NULL
  ), keysets AS MATERIALIZED (
    -- One import is one set of keys, so the column rule runs a handful of
    -- times, not once per trip.
    SELECT k.raw_keys, rk.start_key, rk.end_key
      FROM (SELECT DISTINCT p.raw_keys FROM pending p) k
     CROSS JOIN tokens tk
     CROSS JOIN LATERAL app_private.fahrtenbuch_ride_keys(
                  k.raw_keys, tk.start_norms, tk.end_norms, tk.reject_norms) AS rk
  ), derived AS MATERIALIZED (
    SELECT p.id,
           tt.start_at, tt.end_at, tt.time_zone, tt.time_source,
           app_private.fahrtenbuch_trip_status_of(p.is_canceled, p.source_status) AS trip_status,
           p.is_canceled, p.start_time, p.end_time, p.original_driver_name
      FROM pending p
      JOIN keysets ks ON ks.raw_keys = p.raw_keys
     CROSS JOIN LATERAL app_private.fahrtenbuch_times_from_cells(
                  p.raw_data_json -> ks.start_key, p.raw_data_json -> ks.end_key,
                  p.trip_date, p.start_time, p.end_time) AS tt
  )
  SELECT d.id, d.start_at, d.end_at, d.time_zone, d.time_source, d.trip_status,
         app_private.fahrtenbuch_backfill_review_reasons(
           d.is_canceled, d.start_time, d.end_time, d.original_driver_name,
           d.trip_status, d.time_source, d.start_at, d.end_at) AS review_reasons
    FROM derived d;

  -- Keyed and analysed, so the join below is a hash join or a lookup by id
  -- whatever the planner believes about fahrtenbuch_trips.
  ALTER TABLE pg_temp.fahrtenbuch_backfill ADD PRIMARY KEY (id);
  ANALYZE pg_temp.fahrtenbuch_backfill;

  UPDATE public.fahrtenbuch_trips t
     SET start_at       = b.start_at,
         end_at         = b.end_at,
         time_zone      = b.time_zone,
         time_source    = b.time_source,
         trip_status    = b.trip_status,
         review_reasons = b.review_reasons,
         needs_review   = cardinality(b.review_reasons) > 0
    FROM pg_temp.fahrtenbuch_backfill b
   WHERE t.id = b.id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  SELECT jsonb_build_object(
           'rows',               v_updated,
           'source_start_end',   count(*) FILTER (WHERE b.time_source = 'source_start_end'),
           'fallback_trip_date', count(*) FILTER (WHERE b.time_source = 'fallback_trip_date'),
           'missing',            count(*) FILTER (WHERE b.time_source = 'missing'),
           'unparsed',           count(*) FILTER (WHERE b.time_source = 'unparsed'),
           'ambiguous',          count(*) FILTER (WHERE b.time_source = 'ambiguous'),
           'completed',          count(*) FILTER (WHERE b.trip_status = 'completed'),
           'cancelled',          count(*) FILTER (WHERE b.trip_status = 'cancelled'),
           'unknown',            count(*) FILTER (WHERE b.trip_status = 'unknown'),
           'needs_review',       count(*) FILTER (WHERE cardinality(b.review_reasons) > 0))
    INTO v_counts
    FROM pg_temp.fahrtenbuch_backfill b;

  IF v_updated <> (SELECT count(*) FROM pg_temp.fahrtenbuch_backfill) THEN
    RAISE EXCEPTION 'fahrtenbuch backfill: derived % trips but updated %',
      (SELECT count(*) FROM pg_temp.fahrtenbuch_backfill), v_updated;
  END IF;

  DROP TABLE pg_temp.fahrtenbuch_backfill;
  RETURN v_counts;
END;
$$;

REVOKE ALL ON FUNCTION app_private.fahrtenbuch_norm(text)                                FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.fahrtenbuch_ride_tokens()                             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.fahrtenbuch_ride_keys(text[], text[], text[], text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.fahrtenbuch_raw_keys(jsonb)                           FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.fahrtenbuch_cell_wall(jsonb)                          FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.fahrtenbuch_wall_to_instant(timestamp, text)          FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.fahrtenbuch_times_from_cells(jsonb, jsonb, date, time, time)
                                                                                         FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.fahrtenbuch_trip_times(jsonb, date, time, time)       FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.fahrtenbuch_map_status(text)                          FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.fahrtenbuch_trip_status_of(boolean, text)             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.fahrtenbuch_backfill_review_reasons(boolean, time, time, text, text, text, timestamptz, timestamptz)
                                                                                         FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.fahrtenbuch_trips_backfill_import_facts()             FROM PUBLIC, anon, authenticated, service_role;

-- ─── 3. The backfill, under the trigger as it stands ────────────────────────

DO $backfill$
DECLARE
  v_counts jsonb;
BEGIN
  v_counts := app_private.fahrtenbuch_trips_backfill_import_facts();
  RAISE NOTICE 'fahrtenbuch import facts backfilled: %', v_counts;
END
$backfill$;

-- ─── 4. The checks, validated against the backfilled rows ───────────────────

ALTER TABLE public.fahrtenbuch_trips
  ADD CONSTRAINT fahrtenbuch_trips_time_source_check
    CHECK (time_source IN ('source_start_end', 'fallback_trip_date', 'missing', 'unparsed', 'ambiguous')),
  -- Both instants and their zone, or none of them; and set exactly when the
  -- source says they were read. Which sources exist is the check above's.
  -- Every term is written so it cannot be NULL: a CHECK that evaluates to NULL
  -- passes.
  ADD CONSTRAINT fahrtenbuch_trips_times_consistent
    CHECK (
      (start_at IS NULL AND end_at IS NULL AND time_zone IS NULL
        AND time_source IS DISTINCT FROM 'source_start_end'
        AND time_source IS DISTINCT FROM 'fallback_trip_date')
      OR
      (start_at IS NOT NULL AND end_at IS NOT NULL AND time_zone IS NOT NULL
        AND coalesce(time_source IN ('source_start_end', 'fallback_trip_date'), false))
    ),
  ADD CONSTRAINT fahrtenbuch_trips_trip_status_check
    CHECK (trip_status IS NULL
           OR (trip_status IN ('completed', 'cancelled', 'unknown')
               AND (trip_status = 'cancelled') = is_canceled)),
  ADD CONSTRAINT fahrtenbuch_trips_review_check
    CHECK (needs_review = (cardinality(review_reasons) > 0)
           AND review_reasons <@ ARRAY[
             'missing_trip_date', 'missing_start', 'unreadable_start', 'missing_end',
             'unreadable_end', 'end_before_start', 'missing_driver', 'unknown_status'
           ]::text[]),
  ADD CONSTRAINT fahrtenbuch_trips_currency_check
    CHECK (currency ~ '^[A-Z]{3}$' AND currency_source IN ('assumed', 'source')),
  ADD CONSTRAINT fahrtenbuch_trips_source_row_key_check
    CHECK ((source_row_key IS NULL AND source_row_key_basis IS NULL)
           OR coalesce(source_row_key ~ '^[0-9a-f]{64}$'
                       AND source_row_key_basis IN ('derived_order_transmission', 'derived_driver_start_plate'), false));

-- A second copy of a ride, from any file, is refused. Only keyed rows compete:
-- the rows stored before this migration carry no key.
CREATE UNIQUE INDEX fahrtenbuch_trips_company_source_row_key
  ON public.fahrtenbuch_trips (company_id, source_row_key)
  WHERE source_row_key IS NOT NULL;

ALTER TABLE public.fahrtenbuch_imports
  ADD CONSTRAINT fahrtenbuch_imports_file_sha256_check
    CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  -- NULLs are distinct, so the imports older than this migration never collide.
  ADD CONSTRAINT fahrtenbuch_imports_company_file_sha256_key
    UNIQUE (company_id, file_sha256);

-- ─── 5. The fingerprint of an import does not change ────────────────────────

CREATE FUNCTION app_private.fahrtenbuch_imports_keep_file_sha256()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.file_sha256 IS DISTINCT FROM OLD.file_sha256 THEN
    RAISE EXCEPTION 'fahrtenbuch_imports: file_sha256 cannot be modified after insert.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- Every row, not UPDATE OF file_sha256: NEW against OLD also sees a change an
-- earlier BEFORE trigger made to a column the statement never named.
CREATE TRIGGER fahrtenbuch_imports_keep_file_sha256
  BEFORE UPDATE ON public.fahrtenbuch_imports
  FOR EACH ROW EXECUTE FUNCTION app_private.fahrtenbuch_imports_keep_file_sha256();

REVOKE ALL ON FUNCTION app_private.fahrtenbuch_imports_keep_file_sha256() FROM PUBLIC, anon, authenticated, service_role;

-- ─── 6. The immutability trigger, restated with the new columns ─────────────

-- 20260606035519's body, the 21 comparisons and everything after them carried
-- character for character; the eleven lines after is_canceled are new. The
-- name is schema-qualified here, which the original left to the search_path.
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
    OLD.source_row_key_basis IS DISTINCT FROM NEW.source_row_key_basis
  ) THEN
    RAISE EXCEPTION
      'fahrtenbuch_trips: immutable fields cannot be modified after insert.';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ─── 7. Self-checks ─────────────────────────────────────────────────────────

DO $selfcheck$
DECLARE
  c_message CONSTANT text := 'fahrtenbuch_trips: immutable fields cannot be modified after insert.';
  -- Refused after insert. The first 21 in 20260606035519's order, then ours.
  c_protected CONSTANT text[] := ARRAY[
    'trip_date', 'start_time', 'end_time', 'duration_minutes', 'car_id', 'car_identifier',
    'route_start', 'route_end', 'description', 'price_amount', 'cash_amount', 'online_amount',
    'tip_amount', 'action_amount', 'raw_data_json', 'original_driver_id', 'original_driver_name',
    'import_id', 'company_id', 'source_status', 'is_canceled',
    'start_at', 'end_at', 'time_zone', 'time_source', 'trip_status', 'needs_review',
    'review_reasons', 'currency', 'currency_source', 'source_row_key', 'source_row_key_basis'
  ];
  -- Written after insert by the planning RPCs and reassign_fahrtenbuch_trip,
  -- or never protected (id, created_at, source_row_index). Unchanged here.
  c_mutable CONSTANT text[] := ARRAY[
    'id', 'assigned_driver_id', 'assigned_driver_name', 'plausibility_status',
    'assignment_reason', 'assignment_note', 'confirmed_by', 'confirmed_at',
    'created_at', 'updated_at', 'source_row_index', 'assignment_source',
    'assignment_block_id', 'assignment_planning_run_id', 'assignment_applied_at',
    'assignment_applied_by'
  ];
  v_wrong    text;
  v_col      text;
  v_type     text;
  v_expr     text;
  v_msg      text;
  v_refused  boolean;
  v_updated  timestamptz;
  v_times    record;
  v_fn       record;
BEGIN
  -- 1a. Every column is one or the other, and no column is both.
  SELECT string_agg(a.attname, ', ' ORDER BY a.attnum) INTO v_wrong
    FROM pg_attribute a
   WHERE a.attrelid = 'public.fahrtenbuch_trips'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped
     AND NOT (a.attname = ANY (c_protected)) AND NOT (a.attname = ANY (c_mutable));
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'fahrtenbuch import self-check 1a: columns neither protected nor known to be mutable: %', v_wrong;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(c_protected) p WHERE p = ANY (c_mutable)) THEN
    RAISE EXCEPTION 'fahrtenbuch import self-check 1a: a column is listed as both protected and mutable';
  END IF;

  -- 1b. Fire the restated function on a scratch copy of the table: every
  --     protected column is refused with the old message, every other column
  --     may change, and updated_at is set by the trigger.
  CREATE TEMP TABLE _fb_protect_probe (LIKE public.fahrtenbuch_trips INCLUDING DEFAULTS) ON COMMIT DROP;
  CREATE TRIGGER _fb_protect_probe BEFORE UPDATE ON _fb_protect_probe
    FOR EACH ROW EXECUTE FUNCTION public.protect_fahrtenbuch_immutable_fields();
  INSERT INTO _fb_protect_probe (company_id, import_id, trip_date, start_time, end_time, duration_minutes,
                                 original_driver_name, assigned_driver_name, start_at, end_at, time_zone,
                                 time_source, trip_status, source_row_key, source_row_key_basis)
  VALUES (gen_random_uuid(), gen_random_uuid(), DATE '2026-08-01', TIME '10:00', TIME '10:30', 30,
          'probe', 'probe', TIMESTAMPTZ '2026-08-01 08:00:00+00', TIMESTAMPTZ '2026-08-01 08:30:00+00',
          'Europe/Berlin', 'source_start_end', 'completed', repeat('a', 64), 'derived_order_transmission');

  FOR v_col IN SELECT unnest(c_protected || c_mutable) LOOP
    SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
      FROM pg_attribute a
     WHERE a.attrelid = '_fb_protect_probe'::regclass AND a.attname = v_col;
    v_expr := CASE
      WHEN v_type = 'text'                        THEN format('coalesce(%I, '''') || ''x''', v_col)
      WHEN v_type = 'text[]'                      THEN format('array_append(%I, ''x'')', v_col)
      WHEN v_type IN ('integer', 'bigint', 'smallint') OR v_type LIKE 'numeric%'
                                                  THEN format('coalesce(%I, 0) + 1', v_col)
      WHEN v_type = 'date'                        THEN format('coalesce(%I, DATE ''2000-01-01'') + 1', v_col)
      WHEN v_type = 'time without time zone'      THEN format('coalesce(%I, TIME ''00:00'') + interval ''1 minute''', v_col)
      WHEN v_type = 'timestamp with time zone'    THEN format('coalesce(%I, now()) + interval ''1 minute''', v_col)
      WHEN v_type = 'boolean'                     THEN format('NOT coalesce(%I, false)', v_col)
      WHEN v_type = 'jsonb'                       THEN format('coalesce(%I, ''{}''::jsonb) || ''{"probe": 1}''::jsonb', v_col)
      WHEN v_type = 'uuid'                        THEN 'gen_random_uuid()'
    END;
    IF v_expr IS NULL THEN
      RAISE EXCEPTION 'fahrtenbuch import self-check 1b: no probe value for % of type %', v_col, v_type;
    END IF;

    v_refused := false;
    BEGIN
      EXECUTE format('UPDATE _fb_protect_probe SET %I = %s', v_col, v_expr);
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg IS DISTINCT FROM c_message THEN
        RAISE EXCEPTION 'fahrtenbuch import self-check 1b: % refused with an unexpected message: %', v_col, v_msg;
      END IF;
      v_refused := true;
    END;

    IF v_col = ANY (c_protected) AND NOT v_refused THEN
      RAISE EXCEPTION 'fahrtenbuch import self-check 1b: protect_fahrtenbuch_immutable_fields let % change', v_col;
    END IF;
    IF v_col = ANY (c_mutable) AND v_refused THEN
      RAISE EXCEPTION 'fahrtenbuch import self-check 1b: protect_fahrtenbuch_immutable_fields now refuses %, which it allowed', v_col;
    END IF;
  END LOOP;

  UPDATE _fb_protect_probe SET assignment_note = 'probe', updated_at = TIMESTAMPTZ '2000-01-01 00:00:00+00'
  RETURNING updated_at INTO v_updated;
  IF v_updated IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'fahrtenbuch import self-check 1b: the trigger no longer sets updated_at';
  END IF;
  DROP TABLE _fb_protect_probe;

  -- 2. Still no UPDATE policy on the trips (20260908113000, 20260917130000).
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'fahrtenbuch_trips' AND cmd = 'UPDATE') THEN
    RAISE EXCEPTION 'fahrtenbuch import self-check 2: fahrtenbuch_trips has an UPDATE policy';
  END IF;

  -- 3. The helpers: in app_private, invoker, pinned, executable by no API role.
  FOR v_fn IN
    SELECT p.oid, p.oid::regprocedure::text AS sig, p.prosecdef, p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app_private' AND p.proname LIKE 'fahrtenbuch\_%'
  LOOP
    IF v_fn.prosecdef THEN
      RAISE EXCEPTION 'fahrtenbuch import self-check 3: % is SECURITY DEFINER', v_fn.sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(v_fn.proconfig) AS c(setting) WHERE c.setting LIKE 'search_path=%') THEN
      RAISE EXCEPTION 'fahrtenbuch import self-check 3: % has no pinned search_path', v_fn.sig;
    END IF;
    IF has_function_privilege('anon', v_fn.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'fahrtenbuch import self-check 3: an API role may execute %', v_fn.sig;
    END IF;
  END LOOP;

  -- 4. The derivation on the shapes that matter (the kit has the full set).
  --    An Uber ride: CEST, seconds kept.
  SELECT * INTO v_times FROM app_private.fahrtenbuch_trip_times(
    '{"Uhrzeit der Auftragsuebermittlung": "2026-08-01 09:58:00.000",
      "Uhrzeit des Fahrtbeginns": "2026-08-01 10:05:31.000",
      "Uhrzeit des Fahrtendes": "2026-08-01 10:19:02.000"}'::jsonb,
    DATE '2026-08-01', TIME '10:05', TIME '10:19');
  IF v_times.time_source IS DISTINCT FROM 'source_start_end'
     OR v_times.start_at IS DISTINCT FROM TIMESTAMPTZ '2026-08-01 08:05:31+00'
     OR v_times.end_at IS DISTINCT FROM TIMESTAMPTZ '2026-08-01 08:19:02+00'
     OR v_times.time_zone IS DISTINCT FROM 'Europe/Berlin' THEN
    RAISE EXCEPTION 'fahrtenbuch import self-check 4: an Uber ride derives as %', row_to_json(v_times);
  END IF;
  --    After midnight: the day of the start, not trip_date's.
  SELECT * INTO v_times FROM app_private.fahrtenbuch_trip_times(
    '{"Uhrzeit des Fahrtbeginns": "2026-08-02 00:05:31.000", "Uhrzeit des Fahrtendes": "2026-08-02 00:19:10.000"}'::jsonb,
    DATE '2026-08-01', TIME '00:05', TIME '00:19');
  IF v_times.start_at IS DISTINCT FROM TIMESTAMPTZ '2026-08-01 22:05:31+00' THEN
    RAISE EXCEPTION 'fahrtenbuch import self-check 4: a ride after midnight derives as %', row_to_json(v_times);
  END IF;
  --    \N, a DST gap, a DST repeat, and a cell that is not a timestamp.
  IF (SELECT t.time_source FROM app_private.fahrtenbuch_trip_times(
        '{"Uhrzeit des Fahrtbeginns": "\\N", "Uhrzeit des Fahrtendes": "\\N"}'::jsonb,
        DATE '2026-08-01', NULL, NULL) t) IS DISTINCT FROM 'missing'
     OR (SELECT t.time_source FROM app_private.fahrtenbuch_trip_times(
        '{"Uhrzeit des Fahrtbeginns": "2026-03-29 02:30:00.000", "Uhrzeit des Fahrtendes": "2026-03-29 03:10:00.000"}'::jsonb,
        DATE '2026-03-29', TIME '02:30', TIME '03:10') t) IS DISTINCT FROM 'ambiguous'
     OR (SELECT t.time_source FROM app_private.fahrtenbuch_trip_times(
        '{"Uhrzeit des Fahrtbeginns": "2026-10-25 02:30:00.000", "Uhrzeit des Fahrtendes": "2026-10-25 02:45:00.000"}'::jsonb,
        DATE '2026-10-25', TIME '02:30', TIME '02:45') t) IS DISTINCT FROM 'ambiguous'
     OR (SELECT t.time_source FROM app_private.fahrtenbuch_trip_times(
        '{"Uhrzeit des Fahrtbeginns": "kaputt", "Uhrzeit des Fahrtendes": "2026-08-01 10:19:02.000"}'::jsonb,
        DATE '2026-08-01', NULL, TIME '10:19') t) IS DISTINCT FROM 'unparsed' THEN
    RAISE EXCEPTION 'fahrtenbuch import self-check 4: \N, a DST change or an unreadable cell is not left NULL';
  END IF;
  --    The order-transmission column is never read as the start.
  SELECT * INTO v_times FROM app_private.fahrtenbuch_trip_times(
    '{"Uhrzeit der Auftragsuebermittlung": "2026-08-01 09:58:00.000"}'::jsonb,
    DATE '2026-08-01', TIME '10:05', TIME '10:19');
  IF v_times.time_source IS DISTINCT FROM 'fallback_trip_date'
     OR v_times.start_at IS DISTINCT FROM TIMESTAMPTZ '2026-08-01 08:05:00+00' THEN
    RAISE EXCEPTION 'fahrtenbuch import self-check 4: the order column was read as the ride: %', row_to_json(v_times);
  END IF;

  -- 5. Every stored trip was backfilled.
  IF EXISTS (SELECT 1 FROM public.fahrtenbuch_trips WHERE time_source IS NULL OR trip_status IS NULL) THEN
    RAISE EXCEPTION 'fahrtenbuch import self-check 5: a trip was left without time_source or trip_status';
  END IF;

  -- 6. The two uniqueness rules exist in the shape the importer relies on.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.fahrtenbuch_imports'::regclass
                    AND conname = 'fahrtenbuch_imports_company_file_sha256_key' AND contype = 'u') THEN
    RAISE EXCEPTION 'fahrtenbuch import self-check 6: the per-company file hash constraint is missing';
  END IF;
  IF NOT coalesce((SELECT pg_get_indexdef(i.indexrelid)
                     FROM pg_index i
                    WHERE i.indexrelid = to_regclass('public.fahrtenbuch_trips_company_source_row_key')
                      AND i.indisunique)
                  ~ '\(company_id, source_row_key\) WHERE \(source_row_key IS NOT NULL\)', false) THEN
    RAISE EXCEPTION 'fahrtenbuch import self-check 6: the per-company row key index is missing or changed';
  END IF;

  -- 7. The fingerprint trigger is an invoker trigger on every update.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = 'public.fahrtenbuch_imports'::regclass
                    AND g.tgname = 'fahrtenbuch_imports_keep_file_sha256' AND NOT g.tgisinternal) THEN
    RAISE EXCEPTION 'fahrtenbuch import self-check 7: fahrtenbuch_imports_keep_file_sha256 is missing';
  END IF;
END
$selfcheck$;
