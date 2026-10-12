-- ════════════════════════════════════════════════════════════════════════════
--  A refuel carries the odometer, and the range left
--
--  Owner's decision, 11.10.2026: a photo of the cluster is required with every
--  `Tanken` Beleg. The figures are read on the phone and the image stays
--  there, exactly as with the Beleg itself.
--
--  WHY THE RANGE AND NOT THE GAUGE. The fuel gauge on these clusters is a bar
--  of lit blocks. Measured on 59 photos (12.10.2026), a vision model answered
--  `three_quarters` on 41 of them - including one whose bar was visibly a
--  quarter - and no model found on Hugging Face reads a segmented bar at all.
--  The range beside it IS text, it reads reliably, and it answers the question
--  better: `199 km left` is something a fleet manager can act on, where "about
--  half" is not.
--
--  WHY THE BOUNDS ARE CHECKS. The app's rule refuses anything under five
--  digits as an odometer, because the same panel shows a three-digit range and
--  a vision model really did return `691` where the total read `25041`. That
--  rule lives in one TypeScript function; a constraint is what keeps it true
--  for the next writer, who will not have read it. As with litres, the column
--  is wider than the rule: it refuses the impossible, the rule chooses what to
--  show a driver.
--
--  Nothing is required. A Beleg that is not a refuel has neither, and an older
--  app build sends neither - a NOT NULL here would refuse both.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.partner_receipt_submissions
  ADD COLUMN IF NOT EXISTS odometer_km integer,
  ADD COLUMN IF NOT EXISTS range_km    integer;

ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS odometer_km integer,
  ADD COLUMN IF NOT EXISTS range_km    integer;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['partner_receipt_submissions', 'receipts'] LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
                   v_table, v_table || '_odometer_plausible');
    -- A car that has driven under 100 km has not been refuelled by a fleet
    -- driver, and 10 million km is several lifetimes of a taxi.
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (odometer_km IS NULL OR (odometer_km >= 100 AND odometer_km <= 10000000))',
      v_table, v_table || '_odometer_plausible');

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
                   v_table, v_table || '_range_plausible');
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (range_km IS NULL OR (range_km >= 0 AND range_km <= 2000))',
      v_table, v_table || '_range_plausible');
  END LOOP;
END;
$$;

COMMENT ON COLUMN public.receipts.odometer_km IS
  'The car total distance at the refuel, read on the phone from a photo of the '
  'cluster that stays there. NULL on anything that is not a refuel.';
COMMENT ON COLUMN public.receipts.range_km IS
  'Kilometres of range left. This is the fuel reading: the gauge is a bar of '
  'lit blocks that no reader interprets, and a range is actionable.';

-- ─── the door takes them ────────────────────────────────────────────────────

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

  v_old := 'p_price_per_litre text DEFAULT NULL::text)';
  v_new := 'p_price_per_litre text DEFAULT NULL::text, '
        || 'p_odometer_km text DEFAULT NULL::text, '
        || 'p_range_km text DEFAULT NULL::text)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the parameter anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := 'merchant_name, receipt_time, litres, price_per_litre)';
  v_new := 'merchant_name, receipt_time, litres, price_per_litre,'
        || E'\n          odometer_km, range_km)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the insert column anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := '          nullif(btrim(coalesce(p_price_per_litre, '''')), '''')::numeric(6,3))';
  v_new := '          nullif(btrim(coalesce(p_price_per_litre, '''')), '''')::numeric(6,3),' || E'\n'
        || '          nullif(btrim(coalesce(p_odometer_km, '''')), '''')::integer,' || E'\n'
        || '          nullif(btrim(coalesce(p_range_km, '''')), '''')::integer)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the insert values anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  DROP FUNCTION IF EXISTS public.partner_receipt_submission_record(
    uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb,
    text, text, text, text);

  EXECUTE v_def;
END;
$do$;

REVOKE ALL ON FUNCTION public.partner_receipt_submission_record(
  uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb,
  text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_receipt_submission_record(
  uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb,
  text, text, text, text, text, text) TO service_role;

-- ─── accepting carries them into the Beleg ──────────────────────────────────

DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_accept';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'partner_receipt_accept is not defined';
  END IF;
  v_def := replace(v_def, chr(13), '');

  v_old := 'merchant_name, receipt_time, litres, price_per_litre)';
  v_new := 'merchant_name, receipt_time, litres, price_per_litre,'
        || E'\n          odometer_km, range_km)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the receipts column anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := 'v_row.merchant_name, v_row.receipt_time, v_row.litres, v_row.price_per_litre)';
  v_new := 'v_row.merchant_name, v_row.receipt_time, v_row.litres, v_row.price_per_litre,'
        || E'\n          v_row.odometer_km, v_row.range_km)';
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
  v_acc  text;
  v_frag text;
  v_miss text[] := '{}';
  v_col  text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['odometer_km', 'range_km'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'receipts' AND column_name = v_col) THEN
      RAISE EXCEPTION 'receipts.% is missing', v_col;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'partner_receipt_submissions' AND column_name = v_col) THEN
      RAISE EXCEPTION 'partner_receipt_submissions.% is missing', v_col;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receipts_odometer_plausible') THEN
    RAISE EXCEPTION 'the odometer CHECK on receipts is gone';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receipts_range_plausible') THEN
    RAISE EXCEPTION 'the range CHECK on receipts is gone';
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_submission_record') <> 1 THEN
    RAISE EXCEPTION 'partner_receipt_submission_record has more than one signature';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_rec
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_submission_record';
  SELECT pg_get_functiondef(p.oid) INTO v_acc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_accept';

  FOREACH v_frag IN ARRAY ARRAY[
    'p_odometer_km', 'p_range_km', 'p_merchant_name', 'p_litres', 'p_price_per_litre',
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
    'v_row.odometer_km', 'v_row.range_km', 'v_row.merchant_name', 'v_row.litres',
    'not_authorized', 'current_role_permits', 'get_active_company_id',
    'submission_not_found', 'already_reviewed', 'driver_not_linked', 'driver_not_found',
    'date_missing', 'FOR UPDATE', 'receipt_number_next', 'INSERT INTO public.receipts',
    'SECURITY DEFINER', 'SET search_path'
  ] LOOP
    IF position(v_frag IN v_acc) = 0 THEN
      v_miss := v_miss || ('accept:' || v_frag);
    END IF;
  END LOOP;

  IF v_rec LIKE '%document_missing%' OR v_acc LIKE '%document_missing%' THEN
    v_miss := v_miss || 'a document refusal came back'::text;
  END IF;

  IF array_length(v_miss, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'the splice lost: %', array_to_string(v_miss, ', ');
  END IF;

  IF has_function_privilege('anon', 'public.partner_receipt_submission_record(uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.partner_receipt_submission_record(uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the new signature is executable by an API role';
  END IF;
END;
$do$;
