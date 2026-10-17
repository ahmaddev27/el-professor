-- ════════════════════════════════════════════════════════════════════════════
--  M4 — a Beleg from a driver's phone, and the photo it is worth nothing without
-- ════════════════════════════════════════════════════════════════════════════
--
--  The audit called this a blocker and it was right: `document_path` appeared
--  exactly once in the whole repository — its own column definition on
--  `partner_receipt_submissions`. A submission could carry a category and an
--  amount and no photo at all, and the `has_subject` CHECK would admit it. A
--  Beleg without its photo is not a Beleg; it is a claim about a receipt.
--
--  ── `receipts` gains the path, and the owner chose that on purpose ─────────
--
--  The alternative was for the Beleg to point back at its submission and the
--  photo to live only there. The owner chose the column (08.10.2026), and the
--  reason is what the document IS: the Beleg is the record that reaches the
--  Steuerberater, the submission is a review note about it. Hanging the
--  evidence off the review record would mean deleting a submission deletes the
--  proof of an expense that is still on the books.
--
--  **What it opens that was not asked for:** a photo on a hand-entered Beleg.
--  The column exists for every row now, so `ReceiptModal` could upload one. It
--  deliberately does not in this slice — that is a feature, and this is the
--  partner path. The column being there is not permission to grow the screen.
--
--  ── The path is a bucket key, not a URL ───────────────────────────────────
--
--  `${company_id}/partner/${submission_id}.${ext}` in the private `documents`
--  bucket, whose four policies (20260920100000) already read as "the company"
--  and write as "the membership or a support session". **No new storage policy
--  is added**, which matters: that migration's self-check refuses a database
--  where any policy names one of the four company buckets without pinning it,
--  so a fifth policy here would have to restate the lot.
--
--  Storing a URL would have been the mistake. A signed URL expires and a public
--  one would make a driver's receipt readable by anyone who saw the link once.
--  The key is resolved to a short-lived signed URL by the screen that shows it.
--
--  ── The driver's name is OUR row's, character for character ───────────────
--
--  `receipts` has `driver_name text NOT NULL` and **no `driver_id` at all**;
--  every read in this product joins on that text (`AbrechnungPage`, the
--  Abrechnung views, the Tankenquote). So the accept writes the name from
--  `public.drivers`, never the `driver_name_submitted` the partner sent. A
--  Beleg whose name does not match a driver row is money that belongs to
--  nobody — it would vanish from the weekly Abrechnung and still sit in the
--  expense total.
--
--  ── And the number is drawn here, under the same lock as everywhere else ──
--
--  `receipt_number_next` (20261005100000) is the server-side counter. The
--  browser's old `BEL-${Date.now()}` had no uniqueness constraint behind it,
--  which was survivable while one browser wrote them and is not survivable with
--  a second writer.

-- ─── 1. the Beleg carries its photo ─────────────────────────────────────────

ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS document_path text NULL;

COMMENT ON COLUMN public.receipts.document_path IS
  'The key of this Beleg''s photo in the private `documents` bucket, as '
  '<company_id>/partner/<submission_id>.<ext>, or NULL for a Beleg entered by '
  'hand. A bucket key and never a URL: a signed URL expires and a public one '
  'would make a driver''s receipt readable by anyone who saw the link once. '
  'Added by 20261008140000 for the partner path; a photo on a hand-entered '
  'Beleg is a feature nobody has asked for.';

-- ─── 1b. the photo's key is pinned to the company's own folder ─────────────
--
--  The edge function derives the key (`documentKey()`:
--  `<company>/partner/<submission>.<ext>`) and accepts no path from the request,
--  which is the rule `send-document` set: a destination out of a request body is
--  not a destination. But the column is written through a SECURITY DEFINER door,
--  so that property lives in one TypeScript function and a later writer — a
--  backfill, a second partner, a repair script — would lose it silently.
--
--  So it is a constraint. `documents` keys its policies on the first folder of
--  the object name, so a key outside the company's folder is a key the company
--  could not read and another company might; and a signed URL is minted from
--  whatever the column says. Pinned here, the only representable key is one
--  inside the submission's own company.
--
--  Both tables' submissions are covered, and the Beleg that comes out of one
--  too, since `receipts.document_path` is copied from it.

ALTER TABLE public.partner_receipt_submissions
  DROP CONSTRAINT IF EXISTS partner_receipt_submissions_document_prefix;
ALTER TABLE public.partner_receipt_submissions
  ADD CONSTRAINT partner_receipt_submissions_document_prefix
  CHECK (document_path IS NULL
         OR document_path LIKE (company_id::text || '/partner/%'));

ALTER TABLE public.receipts
  DROP CONSTRAINT IF EXISTS receipts_document_prefix;
ALTER TABLE public.receipts
  ADD CONSTRAINT receipts_document_prefix
  CHECK (document_path IS NULL
         OR company_id IS NULL
         OR document_path LIKE (company_id::text || '/%'));

COMMENT ON CONSTRAINT partner_receipt_submissions_document_prefix
  ON public.partner_receipt_submissions IS
  'The photo lives in the submission company''s own folder, which is what the '
  'documents bucket keys its policies on. The edge function derives the key and '
  'takes none from the request; this is what makes that structural rather than '
  'a property of one function.';

-- `receipts.document_path` is the looser of the two on purpose: a Beleg may
-- carry a company_id of NULL (the column is nullable in the baseline and older
-- rows have it), and a future screen may store a photo somewhere other than
-- `partner/` — an upload from the Beleg dialog itself would be the obvious one.
-- What it still refuses is a Beleg pointing into ANOTHER company's folder.

-- ─── 2. the partner's door for a Beleg ──────────────────────────────────────
-- The note's door with one field more, and the same two rules: no INSERT policy
-- exists on the table, and a retry returns the decision rather than reopening
-- it. The amount arrives as a plain decimal STRING and is cast once here — the
-- edge function refuses every other shape, so this cast cannot be the place a
-- comma becomes a thousand.

CREATE OR REPLACE FUNCTION public.partner_receipt_submission_record(
  p_company_id             uuid,
  p_partner                text,
  p_external_submission_id text,
  p_external_driver_id     text,
  p_receipt_date           date,
  p_category               text    DEFAULT NULL,
  p_description            text    DEFAULT NULL,
  p_amount                 text    DEFAULT NULL,
  p_payment_method         text    DEFAULT 'bar',
  p_postal_code            text    DEFAULT NULL,
  p_document_path          text    DEFAULT NULL,
  p_captured_at            text    DEFAULT NULL,
  p_confirmed_by_driver    boolean DEFAULT false,
  p_read_by_agent          boolean DEFAULT false,
  p_raw_payload            jsonb   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_partner text := lower(btrim(coalesce(p_partner, '')));
  v_driver  uuid;
  v_amount  numeric(10,2);
  v_row     public.partner_receipt_submissions;
BEGIN
  IF p_company_id IS NULL OR v_partner = ''
     OR btrim(coalesce(p_external_submission_id, '')) = ''
     OR btrim(coalesce(p_external_driver_id, '')) = '' THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  -- The photo is the point. The accept refuses a row without one, so recording
  -- one would only create a submission nobody can act on.
  IF btrim(coalesce(p_document_path, '')) = '' THEN
    RAISE EXCEPTION 'the Beleg has no document'
      USING ERRCODE = '22023', HINT = 'document_missing';
  END IF;

  IF p_receipt_date IS NULL THEN
    RAISE EXCEPTION 'the Beleg has no date'
      USING ERRCODE = '22023', HINT = 'invalid_date';
  END IF;

  BEGIN
    v_amount := nullif(btrim(coalesce(p_amount, '')), '')::numeric(10,2);
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'the amount is not a number'
      USING ERRCODE = '22023', HINT = 'invalid_amount';
  END;
  IF v_amount IS NOT NULL AND v_amount < 0 THEN
    RAISE EXCEPTION 'the amount is negative'
      USING ERRCODE = '22023', HINT = 'invalid_amount';
  END IF;

  -- Resolved from our own CONFIRMED link, never from the request.
  SELECT l.driver_id INTO v_driver
    FROM public.partner_driver_links l
   WHERE l.company_id = p_company_id AND l.partner = v_partner
     AND l.external_driver_id = btrim(p_external_driver_id)
     AND l.status = 'linked'
   LIMIT 1;

  INSERT INTO public.partner_receipt_submissions
         (company_id, partner, external_submission_id, external_driver_id, driver_id,
          receipt_date, category, description, amount, payment_method, postal_code,
          document_path, read_by_agent, confirmed_by_driver, captured_at, raw_payload)
  VALUES (p_company_id, v_partner, btrim(p_external_submission_id),
          btrim(p_external_driver_id), v_driver,
          p_receipt_date,
          nullif(btrim(coalesce(p_category, '')), ''),
          nullif(btrim(coalesce(p_description, '')), ''),
          v_amount,
          coalesce(nullif(btrim(coalesce(p_payment_method, '')), ''), 'bar'),
          nullif(btrim(coalesce(p_postal_code, '')), ''),
          btrim(p_document_path),
          coalesce(p_read_by_agent, false),
          coalesce(p_confirmed_by_driver, false),
          nullif(btrim(coalesce(p_captured_at, '')), '')::timestamptz,
          p_raw_payload)
  ON CONFLICT (company_id, partner, external_submission_id) DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    -- A retry answers with the decision that exists; it never rewrites one.
    SELECT * INTO v_row FROM public.partner_receipt_submissions s
     WHERE s.company_id = p_company_id AND s.partner = v_partner
       AND s.external_submission_id = btrim(p_external_submission_id);
    RETURN jsonb_build_object('ok', true, 'duplicate', true,
      'submission_id', v_row.id, 'status', v_row.status, 'driver_id', v_row.driver_id);
  END IF;

  RETURN jsonb_build_object('ok', true, 'duplicate', false,
    'submission_id', v_row.id, 'status', v_row.status, 'driver_id', v_row.driver_id);
END;
$$;

COMMENT ON FUNCTION public.partner_receipt_submission_record(uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb) IS
  'Records one Beleg a partner driver submitted, pending review. Service role '
  'only: the table has no INSERT policy. Refuses a Beleg with no document or no '
  'date, because the accept refuses both and a submission nobody can act on is '
  'worse than a refusal the driver sees. Idempotent on the partner''s own '
  'submission id, and a retry returns the existing decision.';

REVOKE ALL ON FUNCTION public.partner_receipt_submission_record(uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_receipt_submission_record(uuid, text, text, text, date, text, text, text, text, text, text, text, boolean, boolean, jsonb)
  TO service_role;

-- ─── 3. accept: one transaction, our name, our number ───────────────────────

CREATE OR REPLACE FUNCTION public.partner_receipt_accept(p_submission_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company uuid := public.get_active_company_id();
  v_caller  uuid := auth.uid();
  v_row     public.partner_receipt_submissions;
  v_driver  text;
  v_number  text;
  v_receipt uuid;
BEGIN
  IF v_caller IS NULL OR v_company IS NULL
     OR NOT public.current_role_permits('receipts', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_submission_id IS NULL THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  SELECT * INTO v_row FROM public.partner_receipt_submissions s
   WHERE s.id = p_submission_id AND s.company_id = v_company
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Eingang nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'submission_not_found';
  END IF;

  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'Der Eingang wurde bereits bearbeitet.'
      USING ERRCODE = 'P0001', HINT = 'already_reviewed';
  END IF;

  -- A Beleg has to belong to a driver, and `receipts.driver_name` is the only
  -- link this schema has. An unlinked submission has no name to write.
  IF v_row.driver_id IS NULL THEN
    RAISE EXCEPTION 'Der Fahrer ist noch nicht verknüpft.'
      USING ERRCODE = 'P0001', HINT = 'driver_not_linked';
  END IF;

  -- Our row's name, character for character. Never the submitted one: every
  -- read in this product joins `receipts.driver_name` against `drivers.name`,
  -- so a mismatch is money that belongs to nobody.
  SELECT d.name INTO v_driver FROM public.drivers d
   WHERE d.id = v_row.driver_id AND d.company_id = v_company;
  IF v_driver IS NULL OR btrim(v_driver) = '' THEN
    RAISE EXCEPTION 'Der Fahrer wurde nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'driver_not_found';
  END IF;

  -- A date is not optional on a Beleg: `receipts.date` is NOT NULL and the
  -- whole weekly Abrechnung is keyed on it.
  IF v_row.receipt_date IS NULL THEN
    RAISE EXCEPTION 'Dem Eingang fehlt das Datum.'
      USING ERRCODE = 'P0001', HINT = 'date_missing';
  END IF;

  -- The photo is the point. A Beleg without it is a claim about a receipt, and
  -- the audit found this exact hole: the submission's CHECK admits a row with a
  -- category and no document at all.
  IF v_row.document_path IS NULL OR btrim(v_row.document_path) = '' THEN
    RAISE EXCEPTION 'Dem Eingang fehlt das Belegfoto.'
      USING ERRCODE = 'P0001', HINT = 'document_missing';
  END IF;

  v_number := public.receipt_number_next(v_company);

  INSERT INTO public.receipts
         (receipt_number, date, description, driver_name, expense,
          user_id, created_by, postal_code, city, payment_method,
          company_id, document_path)
  VALUES (v_number,
          v_row.receipt_date,
          -- `Other` is a sentinel the screen never stores: the free text goes
          -- into `description` instead, and `Tanken` there is what the
          -- Tankenquote counts.
          coalesce(nullif(btrim(coalesce(v_row.category, '')), ''),
                   nullif(btrim(coalesce(v_row.description, '')), '')),
          v_driver,
          coalesce(v_row.amount, 0),
          v_caller, v_caller::text,
          v_row.postal_code, v_row.city,
          coalesce(v_row.payment_method, 'bar'),
          v_company, v_row.document_path)
  RETURNING id INTO v_receipt;

  UPDATE public.partner_receipt_submissions
     SET status = 'accepted', receipt_id = v_receipt,
         reviewed_by = v_caller, reviewed_at = now(), updated_at = now()
   WHERE id = v_row.id;

  RETURN jsonb_build_object('ok', true, 'receipt_id', v_receipt, 'receipt_number', v_number);
END;
$$;

COMMENT ON FUNCTION public.partner_receipt_accept(uuid) IS
  'Accepts one Beleg submission: draws a server-side Belegnummer, writes the '
  'receipts row with OUR driver row''s name and the photo''s bucket key, and '
  'points the submission at it — one transaction, because the '
  'accepted-has-receipt CHECK admits no window. Refuses a submission with no '
  'photo, no date or no linked driver.';

CREATE OR REPLACE FUNCTION public.partner_receipt_reject(p_submission_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company uuid := public.get_active_company_id();
  v_caller  uuid := auth.uid();
  v_row     public.partner_receipt_submissions;
BEGIN
  IF v_caller IS NULL OR v_company IS NULL
     OR NOT public.current_role_permits('receipts', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_submission_id IS NULL OR btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'reason_required';
  END IF;

  SELECT * INTO v_row FROM public.partner_receipt_submissions s
   WHERE s.id = p_submission_id AND s.company_id = v_company
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Eingang nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'submission_not_found';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'Der Eingang wurde bereits bearbeitet.'
      USING ERRCODE = 'P0001', HINT = 'already_reviewed';
  END IF;

  UPDATE public.partner_receipt_submissions
     SET status = 'rejected', rejected_reason = btrim(p_reason),
         reviewed_by = v_caller, reviewed_at = now(), updated_at = now()
   WHERE id = v_row.id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

COMMENT ON FUNCTION public.partner_receipt_reject(uuid, text) IS
  'Rejects one Beleg submission with a reason the driver is told. The photo is '
  'left in the bucket with the submission: a rejected Beleg is still a record '
  'of what was claimed.';

REVOKE ALL ON FUNCTION public.partner_receipt_accept(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_receipt_accept(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.partner_receipt_reject(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_receipt_reject(uuid, text) TO authenticated;

-- ─── 4. Self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_n int;
BEGIN
  -- 1. anon reaches neither.
  IF has_function_privilege('anon', 'public.partner_receipt_accept(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.partner_receipt_reject(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'receipt accept self-check 1: anon can execute one of the two';
  END IF;

  -- 2. SECURITY DEFINER with a pinned search_path, both.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('partner_receipt_accept', 'partner_receipt_reject')
     AND p.prosecdef
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'receipt accept self-check 2: % of 2 are SECURITY DEFINER with a pinned search_path', v_n;
  END IF;

  -- 3. both ask the company and the receipts page themselves.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('partner_receipt_accept', 'partner_receipt_reject')
     AND p.prosrc LIKE '%current_role_permits(''receipts'', true)%'
     AND p.prosrc LIKE '%get_active_company_id()%';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'receipt accept self-check 3: one of the two lost its company or page gate';
  END IF;

  -- 4. the accept refuses a submission with no photo. This is the audit's
  --    blocker, and a release that drops the check puts an expense on the books
  --    with nothing behind it.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_accept'
     AND p.prosrc LIKE '%document_missing%'
     AND p.prosrc LIKE '%v_row.document_path IS NULL%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'receipt accept self-check 4: a Beleg can now be accepted without its photo';
  END IF;

  -- 5. the driver's name comes from `drivers`, not from the submission. Every
  --    read joins on that text, so a submitted name is money nobody owns.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_accept'
     AND p.prosrc LIKE '%SELECT d.name INTO v_driver FROM public.drivers d%'
     AND p.prosrc NOT LIKE '%driver_name_submitted%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'receipt accept self-check 5: the Beleg''s driver name no longer comes from our own row';
  END IF;

  -- 6. the number is drawn by the server counter, never built here.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_receipt_accept'
     AND p.prosrc LIKE '%receipt_number_next(v_company)%'
     AND p.prosrc NOT LIKE '%BEL-%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'receipt accept self-check 6: the Belegnummer is no longer drawn by the server counter';
  END IF;

  -- 7. no new policy on storage.objects. 20260920100000's self-check refuses a
  --    database where a policy names a company bucket without pinning it, so a
  --    fifth policy here would have to restate all fifteen.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE '%partner%';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'receipt accept self-check 7: a partner-specific storage policy was added';
  END IF;

  -- 8. the submission table still has no INSERT or DELETE policy.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_receipt_submissions'
     AND cmd IN ('INSERT', 'DELETE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'receipt accept self-check 8: partner_receipt_submissions gained an INSERT or DELETE policy';
  END IF;

  -- 9. the photo's key is pinned to the company's folder by a constraint, not
  --    by the one TypeScript function that derives it today.
  SELECT count(*) INTO v_n
    FROM pg_constraint c
   WHERE c.conrelid IN ('public.partner_receipt_submissions'::regclass,
                        'public.receipts'::regclass)
     AND c.contype = 'c'
     AND c.conname IN ('partner_receipt_submissions_document_prefix',
                       'receipts_document_prefix');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'receipt accept self-check 9: % of 2 document prefix constraints present', v_n;
  END IF;

  RAISE NOTICE 'partner receipt accept: self-checks passed — no photo, no Beleg; and the name is ours';
END
$check$;
