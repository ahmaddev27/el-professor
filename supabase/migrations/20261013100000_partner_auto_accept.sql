-- ════════════════════════════════════════════════════════════════════════════
--  A submission from the driver app is accepted the moment it arrives
-- ════════════════════════════════════════════════════════════════════════════
--
--  Owner's decision, 13.10.2026: no status, no review, always accepted, Belege
--  and notes alike, in one list, with the driver's name as the author. This
--  REVERSES his decision of 06.10.2026 ("every submission is reviewed by a
--  human"). He was told, in so many words, that a cash Beleg changes
--  `bar_zuruck` (what the driver owes the company) and that `Tanken` changes
--  the Tankenquote, and he chose auto-acceptance anyway. That is settled and
--  this migration implements it; it does not argue with it.
--
--  ── What the arrival now does ───────────────────────────────────────────────
--
--  `partner_receipt_submission_record` and `partner_note_submission_record`
--  still write the arrival record, and then - when the driver is linked - call
--  `app_private.partner_receipt_apply` / `partner_note_apply`, which write the
--  `receipts` / `driver_notes` row and mark the submission `accepted` in the
--  same transaction. The submission tables stay: they are the record of what
--  arrived, and the idempotency key a retry is answered from.
--
--  ── The one real edge: a driver nobody has linked yet ───────────────────────
--
--  A Beleg belongs to a driver by NAME (`receipts.driver_name`, the text every
--  read in this product joins on) and a note by `driver_id NOT NULL`. A
--  submission whose partner driver has no confirmed row in
--  `partner_driver_links` has neither. Linking is a human act (the owner's rule
--  of 06.10.2026: never matched by name, because fuzzy matching once paid a
--  month's salary to a driver nobody chose) and it stays one. So such a
--  submission is RECORDED AND NOT APPLIED, stays `pending`, and is applied by
--  `partner_submission_claim_driver` - which `partner_driver_link_confirm`
--  already calls in its own transaction - at the moment the link is confirmed.
--  `pending` therefore now means exactly one thing: waiting for a driver link.
--
--  ── Why the number is drawn by a copy ───────────────────────────────────────
--
--  `partner_receipt_accept` drew its number from `public.receipt_number_next`,
--  and that function asks `get_active_company_id()` and the caller's page for
--  itself. The door runs as the service role, which has no session and so no
--  company, so calling it from here raises `not_authorized` for every arrival.
--  `app_private.partner_receipt_number` is the same draw - same shape, same
--  loop, same partial unique index behind it - without the caller question,
--  which has no one to ask. It is reachable only from the apply function.
--
--  ── The author ──────────────────────────────────────────────────────────────
--
--  `receipts.created_by` and `driver_notes.created_by` hold a USER id, and the
--  Belege screen resolves it to a name through `user_profiles`. A driver has no
--  user. Writing the driver's name into `created_by` would put a name where
--  every other writer and the screen's lookup expect an id; writing the
--  accepting administrator's id (as `partner_receipt_accept` did) is the
--  defect the owner named: the column said "Y&A Mobility Verwaltung" for a
--  receipt a driver photographed. So both tables gain `submitted_by_name`, a
--  snapshot of OUR driver row's name at arrival (never the submitted one), and
--  the screen prints it ahead of the user lookup. A separate column also
--  survives an edit: `useDatabase.updateReceipt` writes a fixed list of
--  columns and would not touch it, whereas a name parked in `created_by` is one
--  careless `created_by: user.id` away from being overwritten.
--
--  `driver_notes.created_by` was NOT NULL REFERENCES auth.users, and a driver's
--  note has no auth user. It becomes nullable, and a CHECK keeps that from
--  meaning "a note with no author at all": one of the two must be set.
--
--  ── What is deliberately NOT removed ────────────────────────────────────────
--
--  `partner_receipt_accept`, `partner_receipt_reject`, `partner_note_accept`,
--  `partner_note_reject`, `partner_submission_push_target`,
--  `partner_submission_push_record` and the edge function `partner-notify`
--  become unused. Nothing is dropped here: a function other code might call is
--  for the owner to retire, not for a migration to decide. Note that the two
--  accepts can no longer succeed on any row - a pending submission now never
--  has a driver, and both refuse that with `driver_not_linked` - while the two
--  rejects still work on a pending one.
--
--  ── The backlog ─────────────────────────────────────────────────────────────
--
--  Submissions that are `pending` WITH a linked driver when this runs (they
--  were waiting for a human) are applied at the end of this migration, because
--  with no inbox left to find them in they would otherwise sit invisible for
--  ever. Already-accepted ones get `submitted_by_name` backfilled from the
--  name the Beleg itself carries.

-- ─── 1. the author columns ──────────────────────────────────────────────────

ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS submitted_by_name text NULL;
ALTER TABLE public.driver_notes
  ADD COLUMN IF NOT EXISTS submitted_by_name text NULL;

ALTER TABLE public.receipts
  DROP CONSTRAINT IF EXISTS receipts_submitted_by_name_nonblank;
ALTER TABLE public.receipts
  ADD CONSTRAINT receipts_submitted_by_name_nonblank
  CHECK (submitted_by_name IS NULL OR btrim(submitted_by_name) <> '');

ALTER TABLE public.driver_notes
  DROP CONSTRAINT IF EXISTS driver_notes_submitted_by_name_nonblank;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_submitted_by_name_nonblank
  CHECK (submitted_by_name IS NULL OR btrim(submitted_by_name) <> '');

ALTER TABLE public.driver_notes ALTER COLUMN created_by DROP NOT NULL;

-- Loosening a NOT NULL must not make "no author" representable.
ALTER TABLE public.driver_notes
  DROP CONSTRAINT IF EXISTS driver_notes_has_author;
ALTER TABLE public.driver_notes
  ADD CONSTRAINT driver_notes_has_author
  CHECK (created_by IS NOT NULL OR submitted_by_name IS NOT NULL);

COMMENT ON COLUMN public.receipts.submitted_by_name IS
  'The name of OUR driver row at the moment a Beleg arrived from the driver '
  'app, or NULL for a Beleg entered by a person. When set, it is who uploaded '
  'the Beleg and the screen prints it instead of resolving created_by.';
COMMENT ON COLUMN public.driver_notes.submitted_by_name IS
  'The name of OUR driver row at the moment a note arrived from the driver '
  'app, or NULL for a note written by a person. created_by is NULL then: a '
  'driver has no user account.';

-- ─── 2. the Belegnummer, drawn without a session ────────────────────────────

CREATE OR REPLACE FUNCTION app_private.partner_receipt_number(p_company_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_number text;
  v_taken  boolean;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  -- The shape public.receipt_number_next draws, for the same index.
  FOR i IN 1..20 LOOP
    v_number := 'BEL-'
      || (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text
      || '-'
      || lpad((floor(random() * 10000))::int::text, 4, '0');

    SELECT EXISTS (
      SELECT 1 FROM public.receipts
       WHERE company_id = p_company_id AND receipt_number = v_number
    ) INTO v_taken;

    IF NOT v_taken THEN
      RETURN v_number;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'could not draw a free Belegnummer'
    USING ERRCODE = 'P0001', HINT = 'number_exhausted';
END;
$$;

REVOKE ALL ON FUNCTION app_private.partner_receipt_number(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 3. apply a Beleg ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.partner_receipt_apply(p_submission_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row     public.partner_receipt_submissions;
  v_driver  text;
  v_number  text;
  v_receipt uuid;
BEGIN
  IF p_submission_id IS NULL THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  -- The lock is what makes two concurrent callers (a retry at the door and a
  -- link confirmation) write one Beleg, not two.
  SELECT * INTO v_row FROM public.partner_receipt_submissions s
   WHERE s.id = p_submission_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'submission_not_found');
  END IF;
  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'not_pending');
  END IF;

  -- Waiting for a person to link the driver; see the header.
  IF v_row.driver_id IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'driver_not_linked');
  END IF;

  -- Our row's name, character for character. Never the submitted one: every
  -- read in this product joins `receipts.driver_name` against `drivers.name`,
  -- so a mismatch is money that belongs to nobody.
  SELECT d.name INTO v_driver FROM public.drivers d
   WHERE d.id = v_row.driver_id AND d.company_id = v_row.company_id;
  IF v_driver IS NULL OR btrim(v_driver) = '' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'driver_not_found');
  END IF;

  -- receipts.date is NOT NULL and the weekly Abrechnung is keyed on it. The
  -- door refuses a Beleg without one; this is for rows older than that rule.
  IF v_row.receipt_date IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'date_missing');
  END IF;

  v_number := app_private.partner_receipt_number(v_row.company_id);

  INSERT INTO public.receipts
         (receipt_number, date, description, driver_name, expense,
          user_id, created_by, submitted_by_name, postal_code, city, payment_method,
          company_id, document_path,
          merchant_name, receipt_time, litres, price_per_litre,
          odometer_km, range_km)
  VALUES (v_number,
          v_row.receipt_date,
          coalesce(nullif(btrim(coalesce(v_row.category, '')), ''),
                   nullif(btrim(coalesce(v_row.description, '')), '')),
          v_driver,
          coalesce(v_row.amount, 0),
          NULL, NULL, v_driver,
          v_row.postal_code, v_row.city,
          coalesce(v_row.payment_method, 'bar'),
          v_row.company_id, v_row.document_path,
          v_row.merchant_name, v_row.receipt_time, v_row.litres, v_row.price_per_litre,
          v_row.odometer_km, v_row.range_km)
  RETURNING id INTO v_receipt;

  UPDATE public.partner_receipt_submissions
     SET status = 'accepted', receipt_id = v_receipt,
         reviewed_by = NULL, reviewed_at = now(), updated_at = now()
   WHERE id = v_row.id;

  RETURN jsonb_build_object('applied', true, 'receipt_id', v_receipt,
                            'receipt_number', v_number);
END;
$$;

COMMENT ON FUNCTION app_private.partner_receipt_apply(uuid) IS
  'Turns one pending Beleg submission into a company Beleg, with OUR driver '
  'row''s name and the next server-side Belegnummer, and marks the submission '
  'accepted - one transaction. Answers applied=false (never an error) for a '
  'submission that is not pending or whose driver is not linked, so a retry '
  'and a link confirmation can both call it safely. No reviewer: the owner '
  'decided on 13.10.2026 that nothing is reviewed.';

REVOKE ALL ON FUNCTION app_private.partner_receipt_apply(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 4. apply a note ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.partner_note_apply(p_submission_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row       public.partner_note_submissions;
  v_driver    text;
  v_behavior  text;
  v_note      uuid;
  v_note_date timestamptz;
BEGIN
  IF p_submission_id IS NULL THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  SELECT * INTO v_row FROM public.partner_note_submissions s
   WHERE s.id = p_submission_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'submission_not_found');
  END IF;
  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'not_pending');
  END IF;

  -- driver_notes.driver_id is NOT NULL: nothing to write until the link exists.
  IF v_row.driver_id IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'driver_not_linked');
  END IF;

  SELECT d.name INTO v_driver FROM public.drivers d
   WHERE d.id = v_row.driver_id AND d.company_id = v_row.company_id;
  IF v_driver IS NULL OR btrim(v_driver) = '' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'driver_not_found');
  END IF;

  -- Derived from the type, never taken from the partner: taking its word is
  -- how `sick` + `neutral` reaches the planner and fails to exclude the driver.
  v_behavior := app_private.note_behavior_for(v_row.note_type);
  IF v_behavior IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'unknown_note_type');
  END IF;

  -- Local midnight of the range's first day, otherwise today in Berlin. The
  -- zone is named rather than inherited: a session on UTC files a note that
  -- arrived after 22:00 or 23:00 local time on the previous day.
  v_note_date := ((coalesce(v_row.start_date,
                            (now() AT TIME ZONE 'Europe/Berlin')::date)::text
                   || ' 00:00')::timestamp)
                   AT TIME ZONE 'Europe/Berlin';

  INSERT INTO public.driver_notes
         (created_by, submitted_by_name, driver_id, company_id, note_date, note_text,
          note_type, note_planning_behavior, is_full_day,
          start_time, end_time, start_date, end_date)
  VALUES (NULL, v_driver, v_row.driver_id, v_row.company_id, v_note_date, v_row.note_text,
          v_row.note_type, v_behavior, v_row.is_full_day,
          v_row.start_time, v_row.end_time, v_row.start_date, v_row.end_date)
  RETURNING id INTO v_note;

  UPDATE public.partner_note_submissions
     SET status = 'accepted', driver_note_id = v_note,
         reviewed_by = NULL, reviewed_at = now(), updated_at = now()
   WHERE id = v_row.id;

  RETURN jsonb_build_object('applied', true, 'note_id', v_note);
END;
$$;

COMMENT ON FUNCTION app_private.partner_note_apply(uuid) IS
  'Turns one pending note submission into a driver_notes row and marks the '
  'submission accepted - one transaction. Answers applied=false (never an '
  'error) for a submission that is not pending or whose driver is not linked. '
  'The planning behaviour is derived from the type.';

REVOKE ALL ON FUNCTION app_private.partner_note_apply(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 5. the door applies on arrival ─────────────────────────────────────────
--
--  Spliced from the catalogue, as 20261011100000 and 20261012100000 did, so
--  that nothing either of them added is restated and lost. Each anchor must
--  occur exactly once.

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

  v_old := '  RETURN jsonb_build_object(''ok'', true, ''duplicate'', false,';
  v_new := '  -- No review (13.10.2026): a linked driver''s Beleg is a Beleg now. An' || E'\n'
        || '  -- unlinked one waits for partner_submission_claim_driver.' || E'\n'
        || '  IF v_row.driver_id IS NOT NULL THEN' || E'\n'
        || '    PERFORM app_private.partner_receipt_apply(v_row.id);' || E'\n'
        || '    SELECT * INTO v_row FROM public.partner_receipt_submissions s' || E'\n'
        || '     WHERE s.id = v_row.id;' || E'\n'
        || '  END IF;' || E'\n'
        || E'\n' || v_old;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the receipt door return anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  EXECUTE v_def;
END;
$do$;

DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_note_submission_record';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'partner_note_submission_record is not defined';
  END IF;
  v_def := replace(v_def, chr(13), '');

  v_old := '  RETURN jsonb_build_object(' || E'\n'
        || '    ''ok'', true, ''duplicate'', false,';
  v_new := '  IF v_row.driver_id IS NOT NULL THEN' || E'\n'
        || '    PERFORM app_private.partner_note_apply(v_row.id);' || E'\n'
        || '    SELECT * INTO v_row FROM public.partner_note_submissions s' || E'\n'
        || '     WHERE s.id = v_row.id;' || E'\n'
        || '  END IF;' || E'\n'
        || E'\n' || v_old;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the note door return anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  EXECUTE v_def;
END;
$do$;

-- ─── 6. a confirmed link applies what was waiting for it ────────────────────

DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_submission_claim_driver';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'partner_submission_claim_driver is not defined';
  END IF;
  v_def := replace(v_def, chr(13), '');

  v_old := '  RETURN jsonb_build_object(''ok'', true, ''receipts'', v_r, ''notes'', v_n);';
  -- Oldest first, so the Belegnummern of a backlog run in arrival order. The
  -- apply functions lock each row and answer applied=false for one that is
  -- not pending, so a second run of this is harmless.
  v_new := '  PERFORM app_private.partner_receipt_apply(s.id)' || E'\n'
        || '     FROM public.partner_receipt_submissions s' || E'\n'
        || '    WHERE s.company_id = v_company AND s.partner = v_link.partner' || E'\n'
        || '      AND s.external_driver_id = v_link.external_driver_id' || E'\n'
        || '      AND s.driver_id = v_link.driver_id AND s.status = ''pending''' || E'\n'
        || '    ORDER BY s.submitted_at;' || E'\n'
        || '  PERFORM app_private.partner_note_apply(s.id)' || E'\n'
        || '     FROM public.partner_note_submissions s' || E'\n'
        || '    WHERE s.company_id = v_company AND s.partner = v_link.partner' || E'\n'
        || '      AND s.external_driver_id = v_link.external_driver_id' || E'\n'
        || '      AND s.driver_id = v_link.driver_id AND s.status = ''pending''' || E'\n'
        || '    ORDER BY s.submitted_at;' || E'\n'
        || E'\n' || v_old;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the claim return anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  EXECUTE v_def;
END;
$do$;

-- ─── 7. the backlog ─────────────────────────────────────────────────────────

DO $do$
DECLARE
  v_r int;
  v_n int;
BEGIN
  -- Pending with a linked driver: they were waiting for a human, and there is
  -- no screen left to find them in.
  SELECT count(*) INTO v_r FROM (
    SELECT app_private.partner_receipt_apply(s.id) AS r
      FROM public.partner_receipt_submissions s
     WHERE s.status = 'pending' AND s.driver_id IS NOT NULL
     ORDER BY s.submitted_at
  ) a WHERE (a.r ->> 'applied')::boolean;
  SELECT count(*) INTO v_n FROM (
    SELECT app_private.partner_note_apply(s.id) AS r
      FROM public.partner_note_submissions s
     WHERE s.status = 'pending' AND s.driver_id IS NOT NULL
     ORDER BY s.submitted_at
  ) a WHERE (a.r ->> 'applied')::boolean;
  RAISE NOTICE 'partner auto-accept: applied % waiting Belege and % waiting notes', v_r, v_n;

  -- Already accepted by a person: the Beleg and the note did come from the
  -- app, so they get the author the owner asked for. The name is the one the
  -- Beleg itself carries, not the driver's current name.
  UPDATE public.receipts r
     SET submitted_by_name = r.driver_name
    FROM public.partner_receipt_submissions s
   WHERE s.receipt_id = r.id AND r.submitted_by_name IS NULL
     AND btrim(coalesce(r.driver_name, '')) <> '';

  UPDATE public.driver_notes n
     SET submitted_by_name = d.name
    FROM public.partner_note_submissions s, public.drivers d
   WHERE s.driver_note_id = n.id AND d.id = n.driver_id
     AND n.submitted_by_name IS NULL AND btrim(coalesce(d.name, '')) <> '';
END;
$do$;

-- ─── 8. self-check ──────────────────────────────────────────────────────────

DO $do$
DECLARE
  v_n     int;
  v_def   text;
  v_miss  text[] := '{}';
  v_frag  text;
  v_fn    text;
BEGIN
  -- 1. the author columns and the constraints that make them mean something.
  FOREACH v_fn IN ARRAY ARRAY['receipts', 'driver_notes'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = v_fn
                      AND column_name = 'submitted_by_name') THEN
      RAISE EXCEPTION 'auto-accept self-check 1: %.submitted_by_name is missing', v_fn;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'driver_notes_has_author'
                    AND conrelid = 'public.driver_notes'::regclass) THEN
    RAISE EXCEPTION 'auto-accept self-check 1: driver_notes may have no author again';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receipts_submitted_by_name_nonblank')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'driver_notes_submitted_by_name_nonblank') THEN
    RAISE EXCEPTION 'auto-accept self-check 1: a blank-author CHECK is gone';
  END IF;

  -- 2. the three app_private objects are reachable by nobody the API
  --    authenticates as. Supabase grants EXECUTE on a new function to anon, so
  --    this is the check that the REVOKEs above ran.
  FOREACH v_fn IN ARRAY ARRAY[
    'app_private.partner_receipt_number(uuid)',
    'app_private.partner_receipt_apply(uuid)',
    'app_private.partner_note_apply(uuid)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'auto-accept self-check 2: % is executable by an API role', v_fn;
    END IF;
  END LOOP;

  -- 3. SECURITY DEFINER with a pinned search_path, all three.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app_private'
     AND p.proname IN ('partner_receipt_number', 'partner_receipt_apply', 'partner_note_apply')
     AND p.prosecdef
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'auto-accept self-check 3: % of 3 are SECURITY DEFINER with a pinned search_path', v_n;
  END IF;

  -- 4. the Beleg's driver name is OUR row's, the number is the server draw,
  --    and the apply is idempotent under a row lock. These are the properties
  --    partner_receipt_accept had, now held by the one function that writes.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app_private' AND p.proname = 'partner_receipt_apply';
  FOREACH v_frag IN ARRAY ARRAY[
    'SELECT d.name INTO v_driver FROM public.drivers d',
    'partner_receipt_number(v_row.company_id)',
    'FOR UPDATE',
    'v_row.status <> ''pending''',
    'driver_not_linked',
    'v_row.odometer_km', 'v_row.range_km', 'v_row.merchant_name', 'v_row.litres',
    'v_row.price_per_litre', 'v_row.receipt_time', 'v_row.city',
    'submitted_by_name'
  ] LOOP
    IF position(v_frag IN v_def) = 0 THEN v_miss := v_miss || ('receipt_apply:' || v_frag); END IF;
  END LOOP;
  IF v_def LIKE '%driver_name_submitted%' OR v_def LIKE '%receipt_number_next%' THEN
    v_miss := v_miss || 'receipt_apply reads a submitted name or the session-bound counter'::text;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app_private' AND p.proname = 'partner_note_apply';
  FOREACH v_frag IN ARRAY ARRAY[
    'note_behavior_for(v_row.note_type)', 'FOR UPDATE', 'v_row.status <> ''pending''',
    'driver_not_linked', 'submitted_by_name', 'Europe/Berlin'
  ] LOOP
    IF position(v_frag IN v_def) = 0 THEN v_miss := v_miss || ('note_apply:' || v_frag); END IF;
  END LOOP;

  -- 5. the three callers still do their own work AND call the apply. One
  --    signature each: a second overload is the failure a splice risks.
  FOREACH v_fn IN ARRAY ARRAY[
    'partner_receipt_submission_record', 'partner_note_submission_record',
    'partner_submission_claim_driver'
  ] LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_fn) <> 1 THEN
      RAISE EXCEPTION 'auto-accept self-check 5: % has more than one signature', v_fn;
    END IF;
  END LOOP;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_submission_record';
  FOREACH v_frag IN ARRAY ARRAY[
    'partner_receipt_apply', 'p_odometer_km', 'p_range_km', 'p_city', 'p_merchant_name',
    'p_price_per_litre', 'invalid_date', 'invalid_amount', 'public.partner_driver_links',
    'ON CONFLICT (company_id, partner, external_submission_id) DO NOTHING',
    'SECURITY DEFINER', 'SET search_path'
  ] LOOP
    IF position(v_frag IN v_def) = 0 THEN v_miss := v_miss || ('receipt_door:' || v_frag); END IF;
  END LOOP;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_note_submission_record';
  FOREACH v_frag IN ARRAY ARRAY[
    'partner_note_apply', 'note_type_not_transferable', '= ANY (c_transferable)',
    'public.partner_driver_links',
    'ON CONFLICT (company_id, partner, external_submission_id) DO NOTHING',
    'SECURITY DEFINER', 'SET search_path'
  ] LOOP
    IF position(v_frag IN v_def) = 0 THEN v_miss := v_miss || ('note_door:' || v_frag); END IF;
  END LOOP;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_submission_claim_driver';
  FOREACH v_frag IN ARRAY ARRAY[
    'partner_receipt_apply', 'partner_note_apply', 'link_not_confirmed',
    'get_active_company_id', 'current_role_permits', 'SECURITY DEFINER'
  ] LOOP
    IF position(v_frag IN v_def) = 0 THEN v_miss := v_miss || ('claim:' || v_frag); END IF;
  END LOOP;

  IF array_length(v_miss, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'auto-accept self-check 5: the splice lost: %', array_to_string(v_miss, ', ');
  END IF;

  -- 6. the door is still service_role's alone.
  IF has_function_privilege('anon', 'public.partner_receipt_submission_record(uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, text, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.partner_receipt_submission_record(uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, text, text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'auto-accept self-check 6: the receipt door is executable by an API role';
  END IF;

  -- 7. the property this migration exists for, as a catalogue fact: nothing
  --    that could be applied is left waiting. A pending row WITH a driver, a
  --    date and a name is one the owner's decision says must be a Beleg.
  SELECT count(*) INTO v_n
    FROM public.partner_receipt_submissions s
    JOIN public.drivers d ON d.id = s.driver_id AND d.company_id = s.company_id
   WHERE s.status = 'pending' AND s.receipt_date IS NOT NULL
     AND btrim(coalesce(d.name, '')) <> '';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'auto-accept self-check 7: % linked Beleg submission(s) are still pending', v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM public.partner_note_submissions s
    JOIN public.drivers d ON d.id = s.driver_id AND d.company_id = s.company_id
   WHERE s.status = 'pending' AND btrim(coalesce(d.name, '')) <> ''
     AND app_private.note_behavior_for(s.note_type) IS NOT NULL;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'auto-accept self-check 7: % linked note submission(s) are still pending', v_n;
  END IF;

  -- 8. the arrival record is still not client-writable, and the old review
  --    functions were not dropped by this migration (the owner retires them).
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('partner_receipt_submissions', 'partner_note_submissions')
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'auto-accept self-check 8: a submission table gained a client write policy';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('partner_receipt_accept', 'partner_receipt_reject',
                       'partner_note_accept', 'partner_note_reject');
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'auto-accept self-check 8: % of 4 review functions remain; this migration drops none', v_n;
  END IF;

  RAISE NOTICE 'partner auto-accept: self-checks passed - a linked driver''s submission is a Beleg or a note on arrival, an unlinked one waits for its link, and the author is the driver';
END;
$do$;
