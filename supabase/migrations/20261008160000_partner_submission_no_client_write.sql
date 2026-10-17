-- ════════════════════════════════════════════════════════════════════════════
--  A submission is a record, and a client may no longer edit one
-- ════════════════════════════════════════════════════════════════════════════
--
--  `20261005140000` gave both submission tables an UPDATE policy for
--  `authenticated`, gated on the page that owns the subject, with the comment
--  "Reviewing is the only client write". That sentence stopped being true
--  within the same slice: every reviewing path was built as a SECURITY DEFINER
--  RPC — `partner_note_accept`, `partner_note_reject`,
--  `partner_receipt_accept`, `partner_receipt_reject`,
--  `partner_submission_claim_driver` — so the policy admits **no caller**.
--  Measured on this branch: nothing under `src/` and nothing in
--  `supabase/functions/` writes either table through PostgREST.
--
--  ── What it let a reviewer do ──────────────────────────────────────────────
--
--  A policy with no caller is not idle; it is reachable by anyone holding the
--  page, with the anon key and a token, through PostgREST. With it, a reviewer
--  could:
--
--    - rewrite `rejected_reason` after the driver was told, so the stored words
--      and the words the driver received differ with no record of either;
--    - point `receipt_id` at any existing Beleg of the company and mark the
--      submission accepted, attributing a driver's photographed receipt to a
--      document somebody else entered;
--    - mark a submission `rejected` without going through the RPC, so
--      `reviewed_by` and `reviewed_at` hold whatever the client sent;
--    - and, since `20261008150000`, stamp `status_pushed_at` by hand, which
--      makes an undelivered rejection read as delivered and ends the search for
--      it. That column exists precisely to make that loss visible, so leaving
--      it client-writable in the release that adds it would ship a signal that
--      can be faked.
--
--  What it did **not** allow, measured while writing the probe for it: marking a
--  submission accepted with no Beleg at all. `20261005140000`'s own CHECK
--  `(status = 'accepted') = (receipt_id IS NOT NULL)` refuses that whoever
--  writes the row, and `..._rejected_has_reason` likewise refuses a rejection
--  with no words in it. The first draft of this header claimed otherwise; the
--  constraint is what caught it, in the kit, on a fixture that would not insert.
--
--  ── What stays ────────────────────────────────────────────────────────────
--
--  The SELECT policy, unchanged: the tenant term plus the read seam. So the
--  review screens read exactly as before, and this changes no screen.
--
--  Both context triggers, unchanged. The kit keys that rule on the POLICIES and
--  not on who writes today (`platform-contexts.sql` section 14,
--  `support-write-audit.sql` section 1), and the SELECT policy still names
--  `get_active_company_id()` — which is also why deriving the triggers from
--  "no client writes it any more" would be the wrong reasoning, the one
--  `notification_deliveries` shipped with once and the kit refused.
--
--  ── What moves in the matrix ──────────────────────────────────────────────
--
--  `U` and `M` for both tables, from a reviewer's `Y` to `.`: with no UPDATE
--  policy the statement matches no row and reports success having changed
--  nothing, which is `fahrtenbuch_trips`' own shape and the class recorded in
--  memory as "a DELETE the SELECT policy hides removes zero rows and reports
--  success". The view context still reads `T` on `U`, because
--  `refuse_read_only_context_write` is a BEFORE STATEMENT trigger and fires
--  before any policy is consulted.

DO $drop$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_note_submissions', 'partner_receipt_submissions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
  END LOOP;
END
$drop$;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_n     int;
  v_names text;
BEGIN
  -- 1. no write policy of any kind on either table. A submission is written by
  --    the intake, judged by an RPC and never edited.
  SELECT count(*), string_agg(policyname || ' (' || cmd || ')', ', ') INTO v_n, v_names
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('partner_note_submissions', 'partner_receipt_submissions')
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'submission write self-check 1: % client write policy/ies remain: %', v_n, v_names;
  END IF;

  -- 2. and both still have their SELECT policy, or the review screens go blank
  --    and this migration would have broken the feature instead of narrowing it.
  SELECT count(*) INTO v_n
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('partner_note_submissions', 'partner_receipt_submissions')
     AND cmd = 'SELECT'
     AND qual LIKE '%get_active_company_id%';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'submission write self-check 2: % of 2 tables still read on the tenant term', v_n;
  END IF;

  -- 3. both context triggers, on both tables — derived from the policies, not
  --    from who writes.
  SELECT count(*) INTO v_n
    FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('partner_note_submissions', 'partner_receipt_submissions')
     AND g.tgname IN ('refuse_read_only_context_write', 'record_support_write')
     AND NOT g.tgisinternal;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'submission write self-check 3: % of 4 context triggers present', v_n;
  END IF;

  -- 4. the judging RPCs are all still SECURITY DEFINER. They are the only way
  --    a submission changes now, so one of them turning INVOKER would not
  --    merely lose a privilege — it would make the feature unusable, since the
  --    caller can no longer write the table at all.
  SELECT count(*), string_agg(p.proname, ', ') INTO v_n, v_names
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('partner_note_accept', 'partner_note_reject',
                       'partner_receipt_accept', 'partner_receipt_reject',
                       'partner_submission_claim_driver',
                       'partner_note_submission_record',
                       'partner_receipt_submission_record',
                       'partner_submission_push_record')
     AND NOT p.prosecdef;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'submission write self-check 4: % judging function(s) are SECURITY INVOKER: %', v_n, v_names;
  END IF;

  RAISE NOTICE 'partner submissions: self-checks passed — a submission is read and judged, never edited';
END
$check$;
