-- ════════════════════════════════════════════════════════════════════════════
--  M3 — a note crosses from the driver's app, is reviewed, and its status goes
--  back. No image anywhere in this slice, which is the point: it proves the
--  transport, the idempotency, the review and the round trip without a line of
--  storage work, and the whole photo chain stays isolated in M4.
-- ════════════════════════════════════════════════════════════════════════════
--
--  Three functions. `partner_note_submission_record` is the partner's door and
--  is service_role only, because `partner_note_submissions` has no INSERT
--  policy and deliberately never will: a client-insertable submission would
--  claim a driver said something they did not. `partner_note_accept` and
--  `partner_note_reject` are the reviewer's, behind the company's own `notes`
--  page, and the accept exists as a function rather than two client statements
--  because it must write `driver_notes` and set `driver_note_id` in one
--  transaction -- the accepted-has-note CHECK admits no window between them.
--
--  ── 1. Only seven of the ten types may cross, and that is a decision ────────
--
--  `sick`, `vacation` and `off` are refused outright (`note_type_not_
--  transferable`). The owner took that decision on 06.10.2026: those three are
--  health and absence data, Art. 9 GDPR, and they leave the transfer entirely —
--  the operator enters them, as they already do. Nothing is lost by it, because
--  excluding a driver from a month's plan was always the operator's act.
--
--  It is written as an ALLOW-list of the seven that may cross, not a deny-list
--  of the three that may not, for `issue_salary_cash_receipt`'s reason: a type
--  this build has not heard of must be refused, never waved through. A deny-list
--  would admit `krank`, `krankheit` or a typo as an ordinary note.
--
--  ── 2. The free text crosses, and the column was already shaped for it ──────
--
--  `note_text text NOT NULL DEFAULT ''` -- so the column accommodates either
--  answer and this is a one-line decision in the door, not a contract. For the
--  seven types that may cross, the text IS the content: a `breakdown` note with
--  no text reaches the reviewer as a single word, who then accepts or rejects
--  without knowing what happened. The three types where a bare type would have
--  been enough are exactly the three that no longer cross at all.
--
--  ── 3. What the door validates that the table cannot ────────────────────────
--
--  The CHECKs on the table accept `25:00`: the pattern is `^\d{2}:\d{2}$` and
--  says nothing about the hour. `parseTimeMin` in the browser has the same gap
--  and turns it into 1500 minutes, which walks into the following days instead
--  of being refused. So the door checks the RANGE, not just the shape.
--
--  The 366-day cap is refused explicitly here too. `NOTE_RANGE_DAY_CAP` in the
--  browser silently truncates a longer range; a partner's submission that is
--  refused is recoverable, one that is quietly shortened is not.
--
--  ── 4. A retry returns the decision, it does not reopen it ──────────────────
--
--  The idempotency key is `(company_id, partner, external_submission_id)` and
--  the insert is `ON CONFLICT DO NOTHING`, never `DO UPDATE`. A partner that
--  retries after a lost response gets the row that exists and its current
--  status -- including `accepted` or `rejected`. `DO UPDATE` would let a retry
--  rewrite a submission a human has already judged, and the reviewer's decision
--  is the one thing in this chain the partner does not own.
--
--  ── 5. An unlinked driver cannot be accepted, and that is not a defect ──────
--
--  `driver_notes.driver_id` is NOT NULL. A submission whose `driver_id` is NULL
--  is one whose partner driver nobody has confirmed a link for yet (M2), so the
--  accept refuses it with `driver_not_linked` rather than inventing a driver.
--  The submission is stored and waits; `partner_submission_claim_driver` fills
--  it in the moment the link is confirmed.
--
--  ── 6. No platform-session refusal, and the omission is deliberate ──────────
--
--  The three Gehaltsquittung RPCs refuse a caller inside a platform context
--  (`platform_session_not_allowed`), because a receipt attests to a physical
--  handover of cash no platform agent witnessed. Reviewing a driver's note is
--  not an attestation: it is ordinary company work, and 3.4a's answer applies
--  unchanged -- `driver_notes` carries `refuse_read_only_context_write`, so a
--  view context is refused by the trigger, and `record_support_write`, so a
--  support session's insert is audited row by row. Copying the refusal here
--  would import a rule whose reason does not hold.

-- ─── 1. the partner's door ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.partner_note_submission_record(
  p_company_id            uuid,
  p_partner               text,
  p_external_submission_id text,
  p_external_driver_id    text,
  p_note_type             text,
  p_note_text             text    DEFAULT '',
  p_start_date            date    DEFAULT NULL,
  p_end_date              date    DEFAULT NULL,
  p_is_full_day           boolean DEFAULT false,
  p_start_time            text    DEFAULT NULL,
  p_end_time              text    DEFAULT NULL,
  p_raw_payload           jsonb   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- The seven that may cross. An allow-list: a type this build has not heard
  -- of is refused, never stored and treated as neutral.
  c_transferable constant text[] :=
    ARRAY['general', 'other', 'blitzer', 'accident', 'kontrolle', 'breakdown', 'wait'];
  v_type     text := lower(btrim(coalesce(p_note_type, '')));
  v_behavior text;
  v_driver   uuid;
  v_row      public.partner_note_submissions;
BEGIN
  IF p_company_id IS NULL
     OR btrim(coalesce(p_partner, '')) = ''
     OR btrim(coalesce(p_external_submission_id, '')) = ''
     OR btrim(coalesce(p_external_driver_id, '')) = '' THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  IF NOT (v_type = ANY (c_transferable)) THEN
    RAISE EXCEPTION 'note type may not be transferred'
      USING ERRCODE = '22023', HINT = 'note_type_not_transferable';
  END IF;

  -- The pairing still comes from the one place that holds it, so a type on the
  -- allow-list that the behaviour table does not know is a contradiction and
  -- is refused rather than stored.
  v_behavior := app_private.note_behavior_for(v_type);
  IF v_behavior IS NULL THEN
    RAISE EXCEPTION 'note type carries no planning behaviour'
      USING ERRCODE = '22023', HINT = 'unknown_note_type';
  END IF;

  -- The table's pattern accepts 25:00. The hour and the minute are checked
  -- here, where a refusal is still possible. Written out twice rather than put
  -- in a helper: a new app_private object carries its own REVOKE and its own
  -- self-check, and nothing else needs this -- M4's receipts carry a date and
  -- no time of day.
  IF p_start_time IS NOT NULL AND (
       btrim(p_start_time) !~ '^\d{2}:\d{2}$'
       OR substring(btrim(p_start_time), 1, 2)::int > 23
       OR substring(btrim(p_start_time), 4, 2)::int > 59) THEN
    RAISE EXCEPTION 'start time is not a time of day'
      USING ERRCODE = '22023', HINT = 'invalid_start_time';
  END IF;
  IF p_end_time IS NOT NULL AND (
       btrim(p_end_time) !~ '^\d{2}:\d{2}$'
       OR substring(btrim(p_end_time), 1, 2)::int > 23
       OR substring(btrim(p_end_time), 4, 2)::int > 59) THEN
    RAISE EXCEPTION 'end time is not a time of day'
      USING ERRCODE = '22023', HINT = 'invalid_end_time';
  END IF;

  IF p_start_date IS NOT NULL AND p_end_date IS NOT NULL THEN
    IF p_end_date < p_start_date THEN
      RAISE EXCEPTION 'the range ends before it starts'
        USING ERRCODE = '22023', HINT = 'invalid_range';
    END IF;
    -- Refused, not truncated: a shortened range is a wrong note nobody sees.
    IF (p_end_date - p_start_date) > 366 THEN
      RAISE EXCEPTION 'the range is longer than a year'
        USING ERRCODE = '22023', HINT = 'range_too_long';
    END IF;
  END IF;

  -- The driver comes from our own confirmed link, never from the request. An
  -- unconfirmed partner driver leaves driver_id NULL and the submission waits.
  SELECT l.driver_id INTO v_driver
    FROM public.partner_driver_links l
   WHERE l.company_id = p_company_id
     AND l.partner = lower(btrim(p_partner))
     AND l.external_driver_id = btrim(p_external_driver_id)
     AND l.status = 'linked'
   LIMIT 1;

  INSERT INTO public.partner_note_submissions
         (company_id, partner, external_submission_id, external_driver_id, driver_id,
          note_type, note_text, start_date, end_date, is_full_day,
          start_time, end_time, raw_payload)
  VALUES (p_company_id, lower(btrim(p_partner)), btrim(p_external_submission_id),
          btrim(p_external_driver_id), v_driver,
          v_type, coalesce(p_note_text, ''), p_start_date, p_end_date,
          coalesce(p_is_full_day, false),
          nullif(btrim(coalesce(p_start_time, '')), ''),
          nullif(btrim(coalesce(p_end_time, '')), ''),
          p_raw_payload)
  ON CONFLICT (company_id, partner, external_submission_id) DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    -- A retry. Answer with the row that exists and its current decision; never
    -- rewrite it (see the header).
    SELECT * INTO v_row
      FROM public.partner_note_submissions s
     WHERE s.company_id = p_company_id
       AND s.partner = lower(btrim(p_partner))
       AND s.external_submission_id = btrim(p_external_submission_id);

    RETURN jsonb_build_object(
      'ok', true, 'duplicate', true,
      'submission_id', v_row.id, 'status', v_row.status, 'driver_id', v_row.driver_id);
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'duplicate', false,
    'submission_id', v_row.id, 'status', v_row.status, 'driver_id', v_row.driver_id);
END;
$$;

COMMENT ON FUNCTION public.partner_note_submission_record(uuid, text, text, text, text, text, date, date, boolean, text, text, jsonb) IS
  'Records one note a partner''s driver submitted, pending review. Service role '
  'only: the table has no INSERT policy, deliberately. Seven note types may '
  'cross (an allow-list); sick, vacation and off are refused as Art. 9 data. '
  'Idempotent on (company, partner, external_submission_id) and a retry returns '
  'the existing decision rather than reopening it. The driver is resolved from '
  'our own confirmed link, never from the request.';

REVOKE ALL ON FUNCTION public.partner_note_submission_record(uuid, text, text, text, text, text, date, date, boolean, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_note_submission_record(uuid, text, text, text, text, text, date, date, boolean, text, text, jsonb)
  TO service_role;

-- ─── 2. the reviewer's two ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.partner_note_accept(p_submission_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company  uuid := public.get_active_company_id();
  v_caller   uuid := auth.uid();
  v_row      public.partner_note_submissions;
  v_behavior text;
  v_note     uuid;
  v_note_date timestamptz;
BEGIN
  IF v_caller IS NULL OR v_company IS NULL
     OR NOT public.current_role_permits('notes', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_submission_id IS NULL THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  SELECT * INTO v_row
    FROM public.partner_note_submissions s
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

  -- driver_notes.driver_id is NOT NULL, so there is nothing to write until the
  -- partner driver is linked to one of ours. M2's confirmation fills it in.
  IF v_row.driver_id IS NULL THEN
    RAISE EXCEPTION 'Der Fahrer ist noch nicht verknüpft.'
      USING ERRCODE = 'P0001', HINT = 'driver_not_linked';
  END IF;

  v_behavior := app_private.note_behavior_for(v_row.note_type);
  IF v_behavior IS NULL THEN
    RAISE EXCEPTION 'Die Notizart ist unbekannt.'
      USING ERRCODE = 'P0001', HINT = 'unknown_note_type';
  END IF;

  -- The screen writes local midnight of the range's first day, and otherwise
  -- the chosen day. The zone is named rather than inherited: a session on UTC
  -- would file a note on the previous day.
  v_note_date := ((coalesce(v_row.start_date, current_date)::text || ' 00:00')::timestamp)
                   AT TIME ZONE 'Europe/Berlin';

  INSERT INTO public.driver_notes
         (created_by, driver_id, company_id, note_date, note_text,
          note_type, note_planning_behavior, is_full_day,
          start_time, end_time, start_date, end_date)
  VALUES (v_caller, v_row.driver_id, v_company, v_note_date, v_row.note_text,
          v_row.note_type, v_behavior, v_row.is_full_day,
          v_row.start_time, v_row.end_time, v_row.start_date, v_row.end_date)
  RETURNING id INTO v_note;

  UPDATE public.partner_note_submissions
     SET status = 'accepted', driver_note_id = v_note,
         reviewed_by = v_caller, reviewed_at = now(), updated_at = now()
   WHERE id = v_row.id;

  RETURN jsonb_build_object('ok', true, 'note_id', v_note);
END;
$$;

COMMENT ON FUNCTION public.partner_note_accept(uuid) IS
  'Accepts one note submission: writes the driver_notes row and points the '
  'submission at it, in one transaction, because the accepted-has-note CHECK '
  'admits no window between them. Asks get_active_company_id() and the notes '
  'page itself, being SECURITY DEFINER. The planning behaviour is derived from '
  'the type, never taken from the partner. Refuses a submission whose driver is '
  'not yet linked: driver_notes.driver_id is NOT NULL.';

CREATE OR REPLACE FUNCTION public.partner_note_reject(p_submission_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company uuid := public.get_active_company_id();
  v_caller  uuid := auth.uid();
  v_row     public.partner_note_submissions;
BEGIN
  IF v_caller IS NULL OR v_company IS NULL
     OR NOT public.current_role_permits('notes', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  -- The table's CHECK demands a reason on a rejected row, so an empty one is
  -- refused here with a code the screen can name rather than as a 23514.
  IF p_submission_id IS NULL OR btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'reason_required';
  END IF;

  SELECT * INTO v_row
    FROM public.partner_note_submissions s
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

  UPDATE public.partner_note_submissions
     SET status = 'rejected', rejected_reason = btrim(p_reason),
         reviewed_by = v_caller, reviewed_at = now(), updated_at = now()
   WHERE id = v_row.id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

COMMENT ON FUNCTION public.partner_note_reject(uuid, text) IS
  'Rejects one note submission with a reason the driver is told. The reason is '
  'required here rather than left to the table''s CHECK, so the screen gets a '
  'named refusal instead of a constraint violation.';

REVOKE ALL ON FUNCTION public.partner_note_accept(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_note_accept(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.partner_note_reject(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_note_reject(uuid, text) TO authenticated;

-- ─── 3. Self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_n int;
BEGIN
  -- 1. anon reaches none of the three, and the door is service_role's alone.
  --    Supabase grants EXECUTE on every new public function to anon, so this is
  --    the check that the REVOKEs above actually ran.
  IF has_function_privilege('anon',
       'public.partner_note_submission_record(uuid,text,text,text,text,text,date,date,boolean,text,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.partner_note_accept(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.partner_note_reject(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'note intake self-check 1: anon can execute one of the three functions';
  END IF;
  IF has_function_privilege('authenticated',
       'public.partner_note_submission_record(uuid,text,text,text,text,text,date,date,boolean,text,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'note intake self-check 1: authenticated can execute the partner door';
  END IF;

  -- 2. all three are SECURITY DEFINER with a pinned search_path. As invokers
  --    they would die 42501 on app_private.note_behavior_for() -- the defect
  --    PR #117 shipped, and the reason that rule is written down.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('partner_note_submission_record', 'partner_note_accept', 'partner_note_reject')
     AND p.prosecdef
     AND p.proconfig IS NOT NULL
     AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'note intake self-check 2: % of 3 functions are SECURITY DEFINER with a pinned search_path', v_n;
  END IF;

  -- 3. the three Art. 9 types are refused by the door. Read out of the body, so
  --    a later edit that turns the allow-list into a deny-list fails here.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_note_submission_record'
     AND p.prosrc LIKE '%note_type_not_transferable%'
     AND p.prosrc LIKE '%= ANY (c_transferable)%'
     AND p.prosrc NOT LIKE '%''sick''%'
     AND p.prosrc NOT LIKE '%''vacation''%'
     AND p.prosrc NOT LIKE '%''off''%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'note intake self-check 3: the door no longer refuses the Art. 9 types through an allow-list';
  END IF;

  -- 4. the submission table still has no INSERT and no DELETE policy. The door
  --    being service_role only is worth nothing if a client can insert.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_note_submissions'
     AND cmd IN ('INSERT', 'DELETE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'note intake self-check 4: partner_note_submissions gained an INSERT or DELETE policy';
  END IF;

  -- 5. the accept asks the page itself. Running past RLS means running past the
  --    role gate, so a definer that forgot it would let a viewer accept.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('partner_note_accept', 'partner_note_reject')
     AND p.prosrc LIKE '%current_role_permits(''notes'', true)%'
     AND p.prosrc LIKE '%get_active_company_id()%';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'note intake self-check 5: an accept/reject function lost its company or page gate';
  END IF;

  -- 6. the accept derives the behaviour and never reads it off the submission.
  --    Taking the partner's word for it is how `sick` + `neutral` reaches the
  --    planner and fails to exclude the driver.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_note_accept'
     AND p.prosrc LIKE '%note_behavior_for(v_row.note_type)%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'note intake self-check 6: partner_note_accept no longer derives the planning behaviour';
  END IF;

  -- 7. the retry path does not rewrite a judged row.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_note_submission_record'
     AND p.prosrc LIKE '%ON CONFLICT (company_id, partner, external_submission_id) DO NOTHING%'
     AND p.prosrc NOT LIKE '%DO UPDATE%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'note intake self-check 7: the door can now rewrite a submission a human has judged';
  END IF;

  RAISE NOTICE 'partner note intake: self-checks passed — seven types cross, the door is service_role''s, and the reviewer''s two ask the page';
END
$check$;
