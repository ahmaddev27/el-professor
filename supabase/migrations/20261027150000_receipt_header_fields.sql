-- ════════════════════════════════════════════════════════════════════════════
--  A Beleg carries its letterhead split, its printed Bon number and the TSE clock
--
--  Reidey's app reads these off the receipt since 27.10.2026 (a real JET Hagen
--  receipt exposed the misreadings; the shared parser was fixed there first and
--  back-ported here in the same release). Five fields, on the submission AND on
--  `receipts`, exactly as 20261011100000 and 20261012100000 did their four and
--  three — the point is that they reach the Belege screen, not stop at the
--  arrival record:
--
--    station_name            the brand half of the letterhead ("JET Tankstelle")
--    operator_name           the franchise operator after it ("Morten Jürgensmeier")
--    street                  street and house number ("Eckeseyer Straße 113-115")
--    printed_receipt_number  the number PRINTED on the paper (beside `Bon`)
--    tse_time                the fiscal TSE clock's time of day, HH:MM:SS
--
--  TWO NUMBERS, TWO NAMES, ON PURPOSE. `receipts.receipt_number` is OUR
--  Belegnummer (`BEL-…`), drawn server-side and collision-checked; the wire
--  field `receipt_number` is the number the till printed. They are different
--  numbers about the same paper, so the column is `printed_receipt_number` and
--  nothing may ever copy one into the other. Likewise `tse_time` is NOT the
--  sale time: `receipt_time` stays the sale time, and the TSE signs the
--  transaction AFTER the sale, so on a real receipt the two differ.
--
--  NOTHING IS REQUIRED, AND NOTHING HERE CAN BE. Older app builds send none of
--  these; a Beleg entered by hand in the browser may carry any subset. All five
--  are nullable with no length CHECK, like `merchant_name` and `city` before
--  them: the wire bound (120/120/200/32, Reidey's own validator) lives on the
--  door, which refuses by name, and the column refuses only the impossible —
--  `tse_time` is a `time`, so a non-time cannot be stored at all.
--
--  THE SUPPORT-WRITE AUDIT COPIES THEM IN CLEAR, and that is a decision, not an
--  omission: 20261023180000 states the rule for `partner_receipt_submissions` —
--  columns of the Beleg, mirrored on `public.receipts`, describe a purchase and
--  not a person's circumstances, and `receipts` has no redaction arm at all.
--  These five are columns of the Beleg in exactly that sense.
--
--  The door also starts storing `raw_payload` for receipts (the note door has
--  since 20261007110000) — that is a change in `partner-intake/index.ts`, not
--  here: the parameter and the column have existed since 20261005140000 with
--  the door passing NULL, because an older app's payload embeds the photo as
--  base64 and nobody stores a multi-MiB copy of a file the bucket already
--  holds. The door now strips `document`/`content_type` and passes the rest.
--
--  HOW THE TWO FUNCTIONS CHANGE. From the catalogue, as in 20261011100000,
--  20261012100000 and 20261013100000: each definition is read with
--  `pg_get_functiondef`, small splices are applied after asserting each anchor
--  occurs EXACTLY ONCE, and the result is executed, so nothing an earlier
--  migration added is restated and lost. `partner_receipt_submission_record`
--  gains five parameters, so its old signature is dropped first — adding a
--  defaulted parameter to the live function would make every existing call
--  ambiguous between the two overloads. Every new parameter goes at the END of
--  the list, so existing positional callers (tests/fixtures/seed-partner-demo.sql
--  among them) keep their meaning.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. the columns ─────────────────────────────────────────────────────────

ALTER TABLE public.partner_receipt_submissions
  ADD COLUMN IF NOT EXISTS station_name           text,
  ADD COLUMN IF NOT EXISTS operator_name          text,
  ADD COLUMN IF NOT EXISTS street                 text,
  ADD COLUMN IF NOT EXISTS printed_receipt_number text,
  ADD COLUMN IF NOT EXISTS tse_time               time;

ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS station_name           text,
  ADD COLUMN IF NOT EXISTS operator_name          text,
  ADD COLUMN IF NOT EXISTS street                 text,
  ADD COLUMN IF NOT EXISTS printed_receipt_number text,
  ADD COLUMN IF NOT EXISTS tse_time               time;

COMMENT ON COLUMN public.receipts.station_name IS
  'The brand half of the Beleg''s letterhead ("JET Tankstelle"), when the header '
  'splits on a station word. merchant_name keeps the whole name.';
COMMENT ON COLUMN public.receipts.operator_name IS
  'The franchise operator printed after the station word, when what follows '
  'reads as a person''s name.';
COMMENT ON COLUMN public.receipts.street IS
  'Street and house number from the Beleg''s letterhead.';
COMMENT ON COLUMN public.receipts.printed_receipt_number IS
  'The number PRINTED on the receipt (beside `Bon` on a JET one). NOT the '
  'Belegnummer: receipt_number stays the server-drawn BEL- id, and neither is '
  'ever copied into the other.';
COMMENT ON COLUMN public.receipts.tse_time IS
  'The fiscal TSE clock''s time of day. NOT the sale time, which stays '
  'receipt_time: the TSE signs after the sale, and an audit wants both unmixed.';

-- ─── 2. the door takes them ─────────────────────────────────────────────────

DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_submission_record';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'partner_receipt_submission_record is not defined';
  END IF;
  -- A body stored with CRLF cannot be matched by a needle built with LF, and
  -- the difference is invisible in every error message (20261011100000).
  v_def := replace(v_def, chr(13), '');

  -- 2a. five parameters, at the end so every existing argument keeps its place.
  v_old := 'p_city text DEFAULT NULL::text)';
  v_new := 'p_city text DEFAULT NULL::text, '
        || 'p_station_name text DEFAULT NULL::text, '
        || 'p_operator_name text DEFAULT NULL::text, '
        || 'p_street text DEFAULT NULL::text, '
        || 'p_printed_receipt_number text DEFAULT NULL::text, '
        || 'p_tse_time text DEFAULT NULL::text)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the parameter anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  -- 2b. the columns.
  v_old := 'odometer_km, range_km, city)';
  v_new := 'odometer_km, range_km, city,'
        || E'\n          station_name, operator_name, street, printed_receipt_number, tse_time)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the insert column anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  -- 2c. the values. Text in, cast here, like the litres before them; the door
  --     has already refused a malformed time by name.
  v_old := '          nullif(btrim(coalesce(p_city, '''')), ''''))';
  v_new := '          nullif(btrim(coalesce(p_city, '''')), ''''),' || E'\n'
        || '          nullif(btrim(coalesce(p_station_name, '''')), ''''),' || E'\n'
        || '          nullif(btrim(coalesce(p_operator_name, '''')), ''''),' || E'\n'
        || '          nullif(btrim(coalesce(p_street, '''')), ''''),' || E'\n'
        || '          nullif(btrim(coalesce(p_printed_receipt_number, '''')), ''''),' || E'\n'
        || '          nullif(btrim(coalesce(p_tse_time, '''')), '''')::time)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the insert values anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  -- The old signature goes first: a defaulted parameter added to a live
  -- function makes every existing call ambiguous between the two overloads.
  DROP FUNCTION IF EXISTS public.partner_receipt_submission_record(
    uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb,
    text, text, text, text, text, text, text);

  EXECUTE v_def;
END;
$do$;

REVOKE ALL ON FUNCTION public.partner_receipt_submission_record(
  uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb,
  text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_receipt_submission_record(
  uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb,
  text, text, text, text, text, text, text, text, text, text, text, text) TO service_role;

-- ─── 3. applying carries them into the Beleg ────────────────────────────────

DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app_private' AND p.proname = 'partner_receipt_apply';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'app_private.partner_receipt_apply is not defined';
  END IF;
  v_def := replace(v_def, chr(13), '');

  v_old := 'odometer_km, range_km)';
  v_new := 'odometer_km, range_km,'
        || E'\n          station_name, operator_name, street, printed_receipt_number, tse_time)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the receipts column anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := 'v_row.odometer_km, v_row.range_km)';
  v_new := 'v_row.odometer_km, v_row.range_km,'
        || E'\n          v_row.station_name, v_row.operator_name, v_row.street,'
        || E'\n          v_row.printed_receipt_number, v_row.tse_time)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the receipts values anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  EXECUTE v_def;
END;
$do$;

-- ─── self-check ─────────────────────────────────────────────────────────────

DO $do$
DECLARE
  v_rec  text;
  v_app  text;
  v_frag text;
  v_miss text[] := '{}';
  v_col  text;
  v_type text;
BEGIN
  -- 1. the columns, on both tables, and the two time columns really are time:
  --    a text column here would store '25:99' and the screen would print it.
  FOREACH v_col IN ARRAY ARRAY['station_name', 'operator_name', 'street',
                               'printed_receipt_number', 'tse_time'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'receipts' AND column_name = v_col) THEN
      RAISE EXCEPTION 'receipts.% is missing', v_col;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'partner_receipt_submissions' AND column_name = v_col) THEN
      RAISE EXCEPTION 'partner_receipt_submissions.% is missing', v_col;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['receipts', 'partner_receipt_submissions'] LOOP
    SELECT data_type INTO v_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = v_col AND column_name = 'tse_time';
    IF v_type <> 'time without time zone' THEN
      RAISE EXCEPTION '%.tse_time is % and not a time', v_col, v_type;
    END IF;
  END LOOP;

  -- 2. one signature, as every splice of this function has required.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_submission_record') <> 1 THEN
    RAISE EXCEPTION 'partner_receipt_submission_record has more than one signature';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_rec
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_submission_record';
  SELECT pg_get_functiondef(p.oid) INTO v_app
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app_private' AND p.proname = 'partner_receipt_apply';

  -- 3. the splice gained the five and lost none of what the earlier splices
  --    added (20261011100000, 20261012100000, 20261013100000).
  FOREACH v_frag IN ARRAY ARRAY[
    'p_station_name', 'p_operator_name', 'p_street', 'p_printed_receipt_number', 'p_tse_time',
    'p_odometer_km', 'p_range_km', 'p_city', 'p_merchant_name', 'p_litres', 'p_price_per_litre',
    'partner_receipt_apply',
    'invalid_request', 'invalid_date', 'invalid_amount',
    'public.partner_driver_links',
    'ON CONFLICT (company_id, partner, external_submission_id) DO NOTHING',
    'SECURITY DEFINER', 'SET search_path'
  ] LOOP
    IF position(v_frag IN v_rec) = 0 THEN
      v_miss := v_miss || ('record:' || v_frag);
    END IF;
  END LOOP;

  FOREACH v_frag IN ARRAY ARRAY[
    'v_row.station_name', 'v_row.operator_name', 'v_row.street',
    'v_row.printed_receipt_number', 'v_row.tse_time',
    'v_row.odometer_km', 'v_row.range_km', 'v_row.city', 'v_row.merchant_name', 'v_row.litres',
    'v_row.price_per_litre', 'v_row.receipt_time',
    'SELECT d.name INTO v_driver FROM public.drivers d',
    'partner_receipt_number(v_row.company_id)',
    'FOR UPDATE', 'driver_not_linked', 'submitted_by_name',
    'SECURITY DEFINER', 'SET search_path'
  ] LOOP
    IF position(v_frag IN v_app) = 0 THEN
      v_miss := v_miss || ('apply:' || v_frag);
    END IF;
  END LOOP;

  -- The printed number must never reach OUR Belegnummer column. The apply's
  -- receipts INSERT starts its VALUES with the server draw, and a splice that
  -- pointed the first column at the printed number would pass every fragment
  -- above while renumbering Belege with till-printed digits.
  IF position('VALUES (v_number,' IN v_app) = 0 THEN
    v_miss := v_miss || 'apply: the Belegnummer is no longer the server draw'::text;
  END IF;

  IF array_length(v_miss, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'the splice lost: %', array_to_string(v_miss, ', ');
  END IF;

  -- 4. the door is still service_role's alone, on the new signature.
  IF has_function_privilege('anon', 'public.partner_receipt_submission_record(uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, text, text, text, text, text, text, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.partner_receipt_submission_record(uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, text, text, text, text, text, text, text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the new signature is executable by an API role';
  END IF;

  RAISE NOTICE 'receipt header fields: self-checks passed';
END;
$do$;
