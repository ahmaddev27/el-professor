-- ════════════════════════════════════════════════════════════════════════════
--  M3's last half — the rejection reaches the driver, and a failure stays seen
-- ════════════════════════════════════════════════════════════════════════════
--
--  A reviewer rejects a note and the driver has to be told, because the whole
--  point of a rejection is that the person who submitted it does something
--  about it. Reidey's `POST /elprofessor/submissions/status` exists and is
--  tested (20 tests on its branch); this is our side of it.
--
--  It was blocked until `20261008110000`: pushing needs the partner's token
--  REPLAYED, and `partner_credentials` held only an HMAC. The seal unblocked it.
--
--  ── Two columns on the submission, not a delivery table ────────────────────
--
--  `notification_deliveries` has a table of its own because one subject can owe
--  many notifications over time — a TÜV date, a trial end, next year's TÜV. A
--  submission owes **exactly one** push, for the one decision a human made
--  about it, so the delivery state is an attribute of that row and not an
--  entity beside it. A table here would need a foreign key, a unique index, its
--  own policies and both context triggers to say what two columns say.
--
--  ── Why a failed push must be visible rather than retried ──────────────────
--
--  There is no scheduler in this stack, so nothing can retry on its own. The
--  honest shape is therefore the one `notification_deliveries` chose for the
--  same reason: **claim before sending, never retry blindly, and make a loss
--  visible.** `status_pushed_at IS NULL` on a decided submission is exactly
--  "the driver has not been told", which a screen can show and a person can
--  act on. Silence would have been the alternative, and silence is what makes
--  a driver wait for an answer that was given days ago.
--
--  `status_push_error` keeps the last reason, so "unreachable yesterday" is
--  distinguishable from "never attempted".
--
--  ── The push is only ever owed for a REJECTION ─────────────────────────────
--
--  The owner's decision of 06.10.2026: a rejection is news the driver must act
--  on, an acceptance is not worth a push. So `partner_submission_push_target`
--  answers only for `status = 'rejected'`, and an accepted submission is never
--  a row the screen reports as undelivered. Widening this later means changing
--  one function and the badge, not the columns.

-- ─── 1. the two columns ─────────────────────────────────────────────────────

ALTER TABLE public.partner_note_submissions
  ADD COLUMN IF NOT EXISTS status_pushed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS status_push_error text NULL;

COMMENT ON COLUMN public.partner_note_submissions.status_pushed_at IS
  'When the rejection was delivered to the partner for the driver, or NULL. '
  'NULL on a rejected submission means the driver has not been told — there is '
  'no scheduler here, so a loss is made visible rather than retried silently.';

COMMENT ON COLUMN public.partner_note_submissions.status_push_error IS
  'The last reason a delivery did not go, so "unreachable yesterday" is '
  'distinguishable from "never attempted".';

-- ─── 2. what a push needs, and only for a rejection ────────────────────────

CREATE OR REPLACE FUNCTION public.partner_submission_push_target(p_submission_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.partner_note_submissions;
BEGIN
  IF p_submission_id IS NULL THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  SELECT * INTO v_row FROM public.partner_note_submissions
   WHERE id = p_submission_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'submission_not_found');
  END IF;

  -- The owner's decision: only a rejection is pushed. An acceptance answers
  -- `not_pushable` rather than an error, because asking is not a fault.
  IF v_row.status <> 'rejected' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_pushable');
  END IF;

  IF v_row.status_pushed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_pushed');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'company_id', v_row.company_id,
    'partner', v_row.partner,
    'external_submission_id', v_row.external_submission_id,
    'external_driver_id', v_row.external_driver_id,
    -- The reviewer's own words. The partner renders a translated heading above
    -- them, which is why a reason code travels beside the text rather than
    -- instead of it.
    'reason_text', v_row.rejected_reason
  );
END;
$$;

COMMENT ON FUNCTION public.partner_submission_push_target(uuid) IS
  'What the outbound function needs to tell a driver their submission was '
  'rejected, and nothing else: no payload, no decision maker, no timestamps. '
  'Answers only for a rejected submission that has not been delivered. Service '
  'role only, and a refusal is a return value so the caller can report it.';

REVOKE ALL ON FUNCTION public.partner_submission_push_target(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_submission_push_target(uuid) TO service_role;

-- ─── 3. what happened ───────────────────────────────────────────────────────

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

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'submission_not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'delivered', v_error IS NULL);
END;
$$;

COMMENT ON FUNCTION public.partner_submission_push_record(uuid, text) IS
  'Records the outcome of one delivery. A success stamps the time and clears '
  'the error; a failure keeps the reason and leaves the time NULL, which is '
  'what makes an undelivered rejection visible. Service role only.';

REVOKE ALL ON FUNCTION public.partner_submission_push_record(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_submission_push_record(uuid, text) TO service_role;

-- ─── 4. Self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_n int;
  r   record;
BEGIN
  -- 1. both are service_role's alone. The target function hands out a driver's
  --    identifier at the partner and the reviewer's own words.
  FOR r IN SELECT unnest(ARRAY['anon', 'authenticated']) AS role LOOP
    IF has_function_privilege(r.role, 'public.partner_submission_push_target(uuid)', 'EXECUTE')
       OR has_function_privilege(r.role, 'public.partner_submission_push_record(uuid,text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'status push self-check 1: % may execute a push function', r.role;
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
    RAISE EXCEPTION 'status push self-check 2: % of 2 are SECURITY DEFINER with a pinned search_path', v_n;
  END IF;

  -- 3. the owner's decision: only a rejection is pushed. Read from the body,
  --    because widening it is a product decision and not a refactor.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_submission_push_target'
     AND p.prosrc LIKE '%status <> ''rejected''%'
     AND p.prosrc LIKE '%not_pushable%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'status push self-check 3: the target function no longer restricts itself to a rejection';
  END IF;

  -- 4. the target carries the reviewer's words and NOT the submission's
  --    payload. A driver is told why their note was refused, not sent their own
  --    note back, and certainly not another company's data.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_submission_push_target'
     AND (p.prosrc LIKE '%raw_payload%' OR p.prosrc LIKE '%note_text%'
          OR p.prosrc LIKE '%reviewed_by%' OR p.prosrc LIKE '%driver_note_id%');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'status push self-check 4: the push target now carries the submission''s payload or its reviewer';
  END IF;

  -- 5. a failure leaves the timestamp NULL. If it stamped the time anyway, an
  --    undelivered rejection would read as delivered and nobody would look.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_submission_push_record'
     AND p.prosrc LIKE '%CASE WHEN v_error IS NULL THEN now() ELSE status_pushed_at END%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'status push self-check 5: a failed delivery can now stamp itself as delivered';
  END IF;

  -- 6. the submission table still has no INSERT or DELETE policy.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_note_submissions'
     AND cmd IN ('INSERT', 'DELETE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'status push self-check 6: partner_note_submissions gained an INSERT or DELETE policy';
  END IF;

  RAISE NOTICE 'partner status push: self-checks passed — only a rejection travels, and a failure stays visible';
END
$check$;
