-- ════════════════════════════════════════════════════════════════════════════
--  M4's last half — a rejected Beleg reaches the driver too
-- ════════════════════════════════════════════════════════════════════════════
--
--  `20261008130000` built the sender for notes and named the note table in its
--  two functions. So a reviewer who rejected a **Beleg** made a decision the
--  driver never heard: they keep a photo of a receipt nobody will pay, and the
--  screen cannot even report the silence, because the columns that make a lost
--  delivery visible exist on one of the two tables.
--
--  That is the exact failure M3 exists to prevent, so it is closed here rather
--  than recorded. Reidey's receiving endpoint already anticipated it: its
--  validator takes `kind` in `note,receipt` and its notification stores the
--  kind in `params`, defaulting to `note` when none is sent — which means
--  sending nothing is not neutral, it tells the driver's app the wrong word.
--
--  ── Why the two functions learn a second table instead of gaining a kind ───
--
--  A `p_kind` argument would create a second overload of each (the old
--  signature would still exist unless dropped), change the edge function's
--  call, and move the question "which table is this id in?" to the caller,
--  which has no way to know. The id itself answers it: both tables' primary
--  key is a uuid defaulted from `gen_random_uuid()`, so an id names at most one
--  row in each and in practice one row in the pair. The lookup order is notes
--  then receipts, stated so the behaviour is defined rather than incidental.
--
--  Everything else about M3's shape carries over unchanged, and its
--  self-checks are restated below so this release cannot lose one of them: only
--  a rejection travels, the target carries the reviewer's words and never the
--  submission's payload, and a failed delivery leaves `status_pushed_at` NULL.
--
--  ── The page a caller must hold is the submission's own ────────────────────
--
--  The target now returns `kind`, and `partner-notify` asks
--  `current_role_permits()` for `notes` or `receipts` accordingly. Telling a
--  driver about a decision belongs to whoever may make that decision, and until
--  now the function asked for `notes` whatever it was about.

-- ─── 1. the two columns, on the other table ─────────────────────────────────

ALTER TABLE public.partner_receipt_submissions
  ADD COLUMN IF NOT EXISTS status_pushed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS status_push_error text NULL;

COMMENT ON COLUMN public.partner_receipt_submissions.status_pushed_at IS
  'When the rejection was delivered to the partner for the driver, or NULL. '
  'NULL on a rejected Beleg means the driver has not been told — there is no '
  'scheduler here, so a loss is made visible rather than retried silently.';

COMMENT ON COLUMN public.partner_receipt_submissions.status_push_error IS
  'The last reason a delivery did not go, so "unreachable yesterday" is '
  'distinguishable from "never attempted".';

-- ─── 2. what a push needs, from whichever table holds the id ───────────────

CREATE OR REPLACE FUNCTION public.partner_submission_push_target(p_submission_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_kind     text;
  v_company  uuid;
  v_partner  text;
  v_external text;
  v_driver   text;
  v_status   text;
  v_pushed   timestamptz;
  v_reason   text;
BEGIN
  IF p_submission_id IS NULL THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  -- Notes first, then Belege. A uuid primary key names at most one row in
  -- each, so the order defines the answer rather than deciding it.
  SELECT 'note', n.company_id, n.partner, n.external_submission_id,
         n.external_driver_id, n.status, n.status_pushed_at, n.rejected_reason
    INTO v_kind, v_company, v_partner, v_external, v_driver, v_status, v_pushed, v_reason
    FROM public.partner_note_submissions n
   WHERE n.id = p_submission_id;

  IF v_kind IS NULL THEN
    SELECT 'receipt', r.company_id, r.partner, r.external_submission_id,
           r.external_driver_id, r.status, r.status_pushed_at, r.rejected_reason
      INTO v_kind, v_company, v_partner, v_external, v_driver, v_status, v_pushed, v_reason
      FROM public.partner_receipt_submissions r
     WHERE r.id = p_submission_id;
  END IF;

  IF v_kind IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'submission_not_found');
  END IF;

  -- The owner's decision: only a rejection is pushed. An acceptance answers
  -- `not_pushable` rather than an error, because asking is not a fault.
  IF v_status <> 'rejected' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_pushable');
  END IF;

  IF v_pushed IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_pushed');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    -- The partner defaults an absent kind to `note`, so this is not a nicety:
    -- without it a rejected Beleg is announced to the driver as a note.
    'kind', v_kind,
    'company_id', v_company,
    'partner', v_partner,
    'external_submission_id', v_external,
    'external_driver_id', v_driver,
    -- The reviewer's own words. The partner renders a translated heading above
    -- them, which is why a reason code travels beside the text rather than
    -- instead of it.
    'reason_text', v_reason
  );
END;
$$;

COMMENT ON FUNCTION public.partner_submission_push_target(uuid) IS
  'What the outbound function needs to tell a driver their submission was '
  'rejected, and nothing else: no payload, no decision maker, no timestamps. '
  'Looks in the note submissions and then the Belege, and names which it '
  'found, because the partner renders a different sentence for each. Answers '
  'only for a rejected submission that has not been delivered. Service role '
  'only, and a refusal is a return value so the caller can report it.';

REVOKE ALL ON FUNCTION public.partner_submission_push_target(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_submission_push_target(uuid) TO service_role;

-- ─── 3. what happened, to whichever table holds the id ─────────────────────

CREATE OR REPLACE FUNCTION public.partner_submission_push_record(
  p_submission_id uuid,
  p_error         text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_error text := nullif(btrim(coalesce(p_error, '')), '');
  v_hit   boolean := false;
BEGIN
  IF p_submission_id IS NULL THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  -- On success the timestamp is set and the error cleared; on failure the
  -- error is kept and the timestamp stays NULL, which is the state a screen
  -- reads as "the driver has not been told".
  UPDATE public.partner_note_submissions
     SET status_pushed_at  = CASE WHEN v_error IS NULL THEN now() ELSE status_pushed_at END,
         status_push_error = v_error,
         updated_at        = now()
   WHERE id = p_submission_id;
  v_hit := FOUND;

  IF NOT v_hit THEN
    UPDATE public.partner_receipt_submissions
       SET status_pushed_at  = CASE WHEN v_error IS NULL THEN now() ELSE status_pushed_at END,
           status_push_error = v_error,
           updated_at        = now()
     WHERE id = p_submission_id;
    v_hit := FOUND;
  END IF;

  IF NOT v_hit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'submission_not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'delivered', v_error IS NULL);
END;
$$;

COMMENT ON FUNCTION public.partner_submission_push_record(uuid, text) IS
  'Records the outcome of one delivery, on whichever of the two submission '
  'tables holds the id. A success stamps the time and clears the error; a '
  'failure keeps the reason and leaves the time NULL, which is what makes an '
  'undelivered rejection visible. Service role only.';

REVOKE ALL ON FUNCTION public.partner_submission_push_record(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_submission_push_record(uuid, text) TO service_role;

-- ─── 4. Self-check ──────────────────────────────────────────────────────────
--
--  Every rule of 20260108130000's self-check is restated, because a release
--  that replaces a function body is exactly where one of them is lost.

DO $check$
DECLARE
  v_n       int;
  v_n_names text;
  r         record;
BEGIN
  -- 1. both are service_role's alone. The target function hands out a driver's
  --    identifier at the partner and the reviewer's own words.
  FOR r IN SELECT unnest(ARRAY['anon', 'authenticated']) AS role LOOP
    IF has_function_privilege(r.role, 'public.partner_submission_push_target(uuid)', 'EXECUTE')
       OR has_function_privilege(r.role, 'public.partner_submission_push_record(uuid,text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'receipt push self-check 1: % may execute a push function', r.role;
    END IF;
  END LOOP;

  -- 2. SECURITY DEFINER with a pinned search_path, both.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('partner_submission_push_target', 'partner_submission_push_record')
     AND p.prosecdef
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'receipt push self-check 2: % of 2 are SECURITY DEFINER with a pinned search_path', v_n;
  END IF;

  -- 3. the owner's decision: only a rejection is pushed.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_submission_push_target'
     AND p.prosrc LIKE '%v_status <> ''rejected''%'
     AND p.prosrc LIKE '%not_pushable%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'receipt push self-check 3: the target function no longer restricts itself to a rejection';
  END IF;

  -- 4. the target carries the reviewer's words and NOT either submission's
  --    payload. A driver is told why their Beleg was refused, not sent the
  --    amount, the photo's key or the Beleg the company wrote from it.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_submission_push_target'
     AND (p.prosrc LIKE '%raw_payload%' OR p.prosrc LIKE '%note_text%'
          OR p.prosrc LIKE '%reviewed_by%' OR p.prosrc LIKE '%driver_note_id%'
          OR p.prosrc LIKE '%document_path%' OR p.prosrc LIKE '%receipt_id%'
          OR p.prosrc LIKE '%amount%');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'receipt push self-check 4: the push target now carries a submission''s payload or its reviewer';
  END IF;

  -- 5. a failure leaves the timestamp NULL, on BOTH tables. If it stamped the
  --    time anyway, an undelivered rejection would read as delivered.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
         LATERAL regexp_matches(p.prosrc,
           'CASE WHEN v_error IS NULL THEN now\(\) ELSE status_pushed_at END', 'g') m
   WHERE n.nspname = 'public' AND p.proname = 'partner_submission_push_record';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'receipt push self-check 5: % of 2 updates guard the timestamp', v_n;
  END IF;

  -- 6. the target names both tables, or the half this migration exists for is
  --    gone and a rejected Beleg is silently `submission_not_found` again.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('partner_submission_push_target',
                                                'partner_submission_push_record')
     AND p.prosrc LIKE '%partner_note_submissions%'
     AND p.prosrc LIKE '%partner_receipt_submissions%';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'receipt push self-check 6: % of 2 push functions reach both submission tables', v_n;
  END IF;

  -- 7. and it names the kind, because the partner defaults an absent one to
  --    `note` and would announce a Beleg as a note.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_submission_push_target'
     AND p.prosrc LIKE '%''kind'', v_kind%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'receipt push self-check 7: the push target no longer names the submission kind';
  END IF;

  -- 8. neither submission table gained an INSERT or DELETE policy.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('partner_note_submissions', 'partner_receipt_submissions')
     AND cmd IN ('INSERT', 'DELETE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'receipt push self-check 8: a submission table gained an INSERT or DELETE policy';
  END IF;

  -- 9. only these two functions assign the delivery columns. A catalogue
  --    read, in the spirit of app_private.subscription_column_writes(): the
  --    stamp is the record of what a privileged sender did, and a third writer
  --    could mark an undelivered rejection as delivered, which ends the search
  --    for it. (The client cannot reach the columns either -- the submission
  --    tables lose their UPDATE policy in 20261008160000 -- but that is a
  --    policy and this is the shape.)
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'app_private')
     AND p.prokind = 'f'
     AND p.prosrc LIKE '%status_pushed_at%'
     AND p.proname NOT IN ('partner_submission_push_target',
                           'partner_submission_push_record');
  IF v_n > 0 THEN
    SELECT string_agg(p.proname, ', ') INTO v_n_names
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'app_private')
       AND p.prokind = 'f'
       AND p.prosrc LIKE '%status_pushed_at%'
       AND p.proname NOT IN ('partner_submission_push_target',
                             'partner_submission_push_record');
    RAISE EXCEPTION 'receipt push self-check 9: % also name the delivery stamp', v_n_names;
  END IF;

  RAISE NOTICE 'partner receipt push: self-checks passed — a rejected Beleg travels, and as a Beleg';
END
$check$;
