-- ════════════════════════════════════════════════════════════════════════════
--  A partner Beleg no longer has to carry its photo
--
--  The owner decided on 10.10.2026 that a driver sends the FIGURES and not the
--  document: Reidey's app photographs the receipt, reads it with the phone's
--  own OCR engine, fills the form, and keeps the image on the device. So the
--  photo stops arriving, and two refusals written on the opposite assumption
--  would refuse every submission a current app makes.
--
--  WHAT IS GIVEN UP, PLAINLY. The photo was the evidence. An amount and a
--  category are a driver's CLAIM; the document was the only thing a reviewer
--  here could check that claim against, and the only thing the Steuerberater
--  receives as a Beleg. After this migration an accepted partner receipt can
--  reach the books with nothing behind it but what somebody typed on a phone.
--  That is the decision, taken knowing it; it is not an oversight to be tidied
--  away later, and it is not a technical limitation that a future change
--  "fixes".
--
--  WHAT REPLACED IT, AND WHERE. Not here. The driver's app flags any field its
--  rules scored below their confidence threshold and refuses to send until the
--  driver confirms it by hand. That guard lives on the phone, which means this
--  side now TRUSTS a client it cannot inspect — worth knowing before anyone
--  relies on a figure that arrived this way.
--
--  HOW THE TWO FUNCTIONS ARE CHANGED. From the catalogue, not by retyping:
--  each body is read with `pg_get_functiondef`, one refusal block is removed
--  after asserting it occurs EXACTLY ONCE, and the result is executed. That is
--  this repository's idiom for editing a long body (20260921110010 and the GQ
--  year rewrite do the same), and the reason is that a 200-line body restated
--  by hand loses a rule nobody notices was there.
--
--  The `*_document_prefix` CHECK constraints are untouched and already admit
--  NULL: they constrain the SHAPE of a path, never its presence.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. recording: a submission with no document is a normal submission ─────

DO $do$
DECLARE
  v_def  text;
  v_cut  text;
  v_hits int;
  v_crs  int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_submission_record';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'partner_receipt_submission_record is not defined';
  END IF;

  -- A body stored with CRLF cannot be matched by a needle built with LF, and
  -- the difference is invisible in every error message. Normalise once, and
  -- report the count if the match still fails, so the next person is not left
  -- comparing two strings that look identical.
  v_crs := length(v_def) - length(replace(v_def, chr(13), ''));
  v_def := replace(v_def, chr(13), '');

  v_cut := concat(
    '  -- The photo is the point. The accept refuses a row without one, so recording', E'\n',
    '  -- one would only create a submission nobody can act on.', E'\n',
    '  IF btrim(coalesce(p_document_path, ', chr(39), chr(39), ')) = ', chr(39), chr(39), ' THEN', E'\n',
    '    RAISE EXCEPTION ', chr(39), 'the Beleg has no document', chr(39), E'\n',
    '      USING ERRCODE = ', chr(39), '22023', chr(39), ', HINT = ', chr(39), 'document_missing', chr(39), ';', E'\n',
    '  END IF;', E'\n',
    E'\n'
  );

  v_hits := (length(v_def) - length(replace(v_def, v_cut, ''))) / length(v_cut);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'the document refusal block occurs % times in partner_receipt_submission_record (carriage returns removed: %). around it: [%]',
      v_hits, v_crs, substr(v_def, greatest(1, position('document_missing' IN v_def) - 260), 340);
  END IF;

  EXECUTE replace(v_def, v_cut, '');
END;
$do$;

-- ─── 2. accepting: a Beleg with no document is accepted ─────────────────────

DO $do$
DECLARE
  v_def  text;
  v_cut  text;
  v_hits int;
  v_crs  int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_accept';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'partner_receipt_accept is not defined';
  END IF;

  -- A body stored with CRLF cannot be matched by a needle built with LF, and
  -- the difference is invisible in every error message. Normalise once, and
  -- report the count if the match still fails, so the next person is not left
  -- comparing two strings that look identical.
  v_crs := length(v_def) - length(replace(v_def, chr(13), ''));
  v_def := replace(v_def, chr(13), '');

  v_cut := concat(
    '  -- The photo is the point. A Beleg without it is a claim about a receipt, and', E'\n',
    '  -- the audit found this exact hole: the submission', chr(39), 's CHECK admits a row with a', E'\n',
    '  -- category and no document at all.', E'\n',
    '  IF v_row.document_path IS NULL OR btrim(v_row.document_path) = ', chr(39), chr(39), ' THEN', E'\n',
    '    RAISE EXCEPTION ', chr(39), 'Dem Eingang fehlt das Belegfoto.', chr(39), E'\n',
    '      USING ERRCODE = ', chr(39), 'P0001', chr(39), ', HINT = ', chr(39), 'document_missing', chr(39), ';', E'\n',
    '  END IF;', E'\n',
    E'\n'
  );

  v_hits := (length(v_def) - length(replace(v_def, v_cut, ''))) / length(v_cut);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'the document refusal block occurs % times in partner_receipt_accept (carriage returns removed: %). around it: [%]',
      v_hits, v_crs, substr(v_def, greatest(1, position('document_missing' IN v_def) - 300), 380);
  END IF;

  EXECUTE replace(v_def, v_cut, '');
END;
$do$;

-- ─── 3. the comment stops promising a refusal that is gone ──────────────────

COMMENT ON FUNCTION public.partner_receipt_submission_record(uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb) IS
  'Records one Beleg a partner driver submitted, pending review. Service role '
  'only: the table has no INSERT policy. The document is OPTIONAL since '
  '10.10.2026 - the driver''s app reads the receipt on the phone and keeps the '
  'image - so what is recorded may be figures alone. Still refuses a Beleg with '
  'no date, because receipts.date is NOT NULL and the weekly Abrechnung is '
  'keyed on it. Idempotent on the partner''s own submission id, and a retry '
  'returns the existing decision.';

-- ─── 4. self-check ──────────────────────────────────────────────────────────
--  Both halves matter. The first says the refusal is gone; the second says
--  nothing ELSE went with it, which is the risk a body edit actually carries.

DO $do$
DECLARE
  v_rec   text;
  v_acc   text;
  v_frag  text;
  v_miss  text[] := '{}';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_rec
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_submission_record';
  SELECT pg_get_functiondef(p.oid) INTO v_acc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_accept';

  IF v_rec LIKE '%document_missing%' THEN
    RAISE EXCEPTION 'partner_receipt_submission_record still refuses a missing document';
  END IF;
  IF v_acc LIKE '%document_missing%' THEN
    RAISE EXCEPTION 'partner_receipt_accept still refuses a missing document';
  END IF;

  -- Everything the record function must still do.
  FOREACH v_frag IN ARRAY ARRAY[
    'invalid_request',
    'invalid_date',
    'invalid_amount',
    'public.partner_driver_links',
    'ON CONFLICT (company_id, partner, external_submission_id) DO NOTHING',
    'SECURITY DEFINER',
    'SET search_path'
  ] LOOP
    IF position(v_frag IN v_rec) = 0 THEN
      v_miss := v_miss || ('record:' || v_frag);
    END IF;
  END LOOP;

  -- Everything the accept must still do. `not_authorized` and the role gate are
  -- the boundary; the rest are the refusals that keep a receipt answerable.
  FOREACH v_frag IN ARRAY ARRAY[
    'not_authorized',
    'current_role_permits',
    'get_active_company_id',
    'submission_not_found',
    'already_reviewed',
    'driver_not_linked',
    'driver_not_found',
    'date_missing',
    'FOR UPDATE',
    'receipt_number_next',
    'INSERT INTO public.receipts',
    'SECURITY DEFINER',
    'SET search_path'
  ] LOOP
    IF position(v_frag IN v_acc) = 0 THEN
      v_miss := v_miss || ('accept:' || v_frag);
    END IF;
  END LOOP;

  IF array_length(v_miss, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'the body edit lost: %', array_to_string(v_miss, ', ');
  END IF;

  -- The privileges are not part of a body edit and must not have moved.
  IF has_function_privilege('anon', 'public.partner_receipt_submission_record(uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.partner_receipt_submission_record(uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'partner_receipt_submission_record became executable by an API role';
  END IF;

  -- The prefix CHECKs constrain the shape of a path, never its presence, and
  -- this migration must not have touched them.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'partner_receipt_submissions_document_prefix'
  ) THEN
    RAISE EXCEPTION 'the submission document prefix CHECK is gone';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'receipts_document_prefix'
  ) THEN
    RAISE EXCEPTION 'the receipts document prefix CHECK is gone';
  END IF;
END;
$do$;
