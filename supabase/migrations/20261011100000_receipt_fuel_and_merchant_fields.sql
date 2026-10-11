-- ════════════════════════════════════════════════════════════════════════════
--  A Beleg carries where it came from, and what a fuel one bought
--
--  Owner's decision, 11.10.2026. A partner receipt arrives with the merchant's
--  name, the clock time printed on it, and - on a refuel - the litres and the
--  price per litre. Four columns, on the submission AND on `receipts`, because
--  the point is that they reach the Steuerberater: a figure that stops at the
--  review screen answers nobody's question about what a litre cost in March.
--
--  WHY A CHECK AND NOT ONLY THE PARSER. The reading rules already bound both
--  figures - a litre count outside 1-500 and a unit price outside 0,50-5,00 EUR
--  are dropped rather than offered, because they are read off a photograph and
--  then shown to a driver as fact. That bound lives in one TypeScript function
--  today. A constraint is what keeps it true for the next writer, who will not
--  have read that function: a rule enforced in one place is lost silently.
--
--  The constraints are deliberately WIDER than the parser's. The parser is
--  choosing what to show a driver and can afford to be strict; the column is
--  refusing the impossible, and must not refuse a tanker a fleet actually runs
--  or a price a future market reaches. Both reject zero and negative, which is
--  the class that corrupts an average.
--
--  Nothing is required. `litres` and `price_per_litre` exist on a fuel receipt
--  and nowhere else, and the app demands them only when the category is
--  `Tanken` - a car wash has neither, and a NOT NULL here would make every
--  non-fuel Beleg unsendable.
--
--  HOW THE TWO FUNCTIONS CHANGE. From the catalogue, as in 20261010100000 and
--  20260921110010: each definition is read with `pg_get_functiondef`, small
--  splices are applied after asserting each occurs EXACTLY ONCE, and the result
--  is executed. `partner_receipt_submission_record` gains four parameters, so
--  its old signature is dropped first - adding a defaulted parameter would make
--  every existing 8-argument call ambiguous between the two overloads rather
--  than resolving to the new one.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. the columns ─────────────────────────────────────────────────────────

ALTER TABLE public.partner_receipt_submissions
  ADD COLUMN IF NOT EXISTS merchant_name   text,
  ADD COLUMN IF NOT EXISTS receipt_time    time,
  ADD COLUMN IF NOT EXISTS litres          numeric(8,2),
  ADD COLUMN IF NOT EXISTS price_per_litre numeric(6,3);

ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS merchant_name   text,
  ADD COLUMN IF NOT EXISTS receipt_time    time,
  ADD COLUMN IF NOT EXISTS litres          numeric(8,2),
  ADD COLUMN IF NOT EXISTS price_per_litre numeric(6,3);

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['partner_receipt_submissions', 'receipts'] LOOP
    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', v_table, v_table || '_litres_plausible');
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (litres IS NULL OR (litres > 0 AND litres <= 2000))',
      v_table, v_table || '_litres_plausible');

    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', v_table, v_table || '_price_per_litre_plausible');
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (price_per_litre IS NULL OR (price_per_litre > 0 AND price_per_litre <= 20))',
      v_table, v_table || '_price_per_litre_plausible');
  END LOOP;
END;
$$;

COMMENT ON COLUMN public.receipts.litres IS
  'Litres filled, on a fuel Beleg only. Bounded by a CHECK at 2000 - the column '
  'refuses the impossible; the reading rules are stricter about what they offer.';
COMMENT ON COLUMN public.receipts.price_per_litre IS
  'Price per litre in euros, on a fuel Beleg only.';
COMMENT ON COLUMN public.receipts.receipt_time IS
  'The clock time printed on the Beleg, not when it was submitted.';
COMMENT ON COLUMN public.receipts.merchant_name IS
  'The place the Beleg is from, as printed on it.';

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
  v_def := replace(v_def, chr(13), '');

  -- 2a. four parameters, at the end so every existing argument keeps its place.
  v_old := 'p_raw_payload jsonb DEFAULT NULL::jsonb)';
  v_new := 'p_raw_payload jsonb DEFAULT NULL::jsonb, '
        || 'p_merchant_name text DEFAULT NULL::text, '
        || 'p_receipt_time text DEFAULT NULL::text, '
        || 'p_litres text DEFAULT NULL::text, '
        || 'p_price_per_litre text DEFAULT NULL::text)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the parameter list anchor is not unique in partner_receipt_submission_record';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  -- 2b. the columns.
  v_old := 'document_path, read_by_agent, confirmed_by_driver, captured_at, raw_payload)';
  v_new := 'document_path, read_by_agent, confirmed_by_driver, captured_at, raw_payload,'
        || E'\n          merchant_name, receipt_time, litres, price_per_litre)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the insert column anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  -- 2c. the values. Every one arrives as text and is cast here, so a figure the
  --     partner cannot read is NULL rather than a parse error on the whole
  --     submission: an unreadable litre count must not lose the receipt.
  v_old := '          p_raw_payload)';
  v_new := '          p_raw_payload,' || E'\n'
        || '          nullif(btrim(coalesce(p_merchant_name, '''')), ''''),' || E'\n'
        || '          nullif(btrim(coalesce(p_receipt_time, '''')), '''')::time,' || E'\n'
        || '          nullif(btrim(coalesce(p_litres, '''')), '''')::numeric(8,2),' || E'\n'
        || '          nullif(btrim(coalesce(p_price_per_litre, '''')), '''')::numeric(6,3))';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the insert values anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  -- The old signature goes first: a defaulted parameter added to a live
  -- function makes every existing call ambiguous between the two overloads.
  DROP FUNCTION IF EXISTS public.partner_receipt_submission_record(
    uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb);

  EXECUTE v_def;
END;
$do$;

REVOKE ALL ON FUNCTION public.partner_receipt_submission_record(
  uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb,
  text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_receipt_submission_record(
  uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb,
  text, text, text, text) TO service_role;

-- ─── 3. accepting carries them into the Beleg ───────────────────────────────

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

  v_old := 'company_id, document_path)';
  v_new := 'company_id, document_path,' || E'\n'
        || '          merchant_name, receipt_time, litres, price_per_litre)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the receipts column anchor is not unique in partner_receipt_accept';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := '          v_company, v_row.document_path)';
  v_new := '          v_company, v_row.document_path,' || E'\n'
        || '          v_row.merchant_name, v_row.receipt_time, v_row.litres, v_row.price_per_litre)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the receipts values anchor is not unique in partner_receipt_accept';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  EXECUTE v_def;
END;
$do$;

-- ─── 4. self-check ──────────────────────────────────────────────────────────

DO $do$
DECLARE
  v_rec  text;
  v_acc  text;
  v_frag text;
  v_miss text[] := '{}';
  v_col  text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['merchant_name', 'receipt_time', 'litres', 'price_per_litre'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'receipts' AND column_name = v_col) THEN
      RAISE EXCEPTION 'receipts.% is missing', v_col;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'partner_receipt_submissions' AND column_name = v_col) THEN
      RAISE EXCEPTION 'partner_receipt_submissions.% is missing', v_col;
    END IF;
  END LOOP;

  -- The bound must be a constraint, not only a comment about one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receipts_litres_plausible') THEN
    RAISE EXCEPTION 'the litres CHECK on receipts is gone';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receipts_price_per_litre_plausible') THEN
    RAISE EXCEPTION 'the price per litre CHECK on receipts is gone';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_rec
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_submission_record';
  SELECT pg_get_functiondef(p.oid) INTO v_acc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_accept';

  -- Exactly one of each: a second overload is the failure this splice risks.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_submission_record') <> 1 THEN
    RAISE EXCEPTION 'partner_receipt_submission_record has more than one signature';
  END IF;

  -- Everything the splice must NOT have lost.
  FOREACH v_frag IN ARRAY ARRAY[
    'p_merchant_name', 'p_litres', 'p_price_per_litre', 'p_receipt_time',
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
    'v_row.merchant_name', 'v_row.litres', 'v_row.price_per_litre', 'v_row.receipt_time',
    'not_authorized', 'current_role_permits', 'get_active_company_id',
    'submission_not_found', 'already_reviewed', 'driver_not_linked', 'driver_not_found',
    'date_missing', 'FOR UPDATE', 'receipt_number_next', 'INSERT INTO public.receipts',
    'SECURITY DEFINER', 'SET search_path'
  ] LOOP
    IF position(v_frag IN v_acc) = 0 THEN
      v_miss := v_miss || ('accept:' || v_frag);
    END IF;
  END LOOP;

  -- Neither may refuse a documentless Beleg again (20261010100000).
  -- A bare literal here would be read as an array literal and fail with
  -- "malformed array literal"; the cast is what makes it an element.
  IF v_rec LIKE '%document_missing%' THEN
    v_miss := v_miss || ('record still refuses a missing document, around: ['
      || substr(v_rec, greatest(1, position('document_missing' IN v_rec) - 200), 260) || ']')::text;
  END IF;
  IF v_acc LIKE '%document_missing%' THEN
    v_miss := v_miss || ('accept still refuses a missing document, around: ['
      || substr(v_acc, greatest(1, position('document_missing' IN v_acc) - 200), 260) || ']')::text;
  END IF;

  IF array_length(v_miss, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'the splice lost: %', array_to_string(v_miss, ', ');
  END IF;

  -- The new signature must be service-role only, like the old one.
  IF has_function_privilege('anon', 'public.partner_receipt_submission_record(uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.partner_receipt_submission_record(uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the new signature is executable by an API role';
  END IF;
END;
$do$;
