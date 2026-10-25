-- ════════════════════════════════════════════════════════════════════════════
--  A Beleg that came from a driver's submission could not be deleted at all
-- ════════════════════════════════════════════════════════════════════════════
--
--  Two rules written four lines apart in `20261005140000_partner_submissions.sql`
--  contradict each other:
--
--    line 121:  receipt_id uuid NULL REFERENCES public.receipts(id)
--                 ON DELETE SET NULL
--    line 131:  CONSTRAINT partner_receipt_submissions_accepted_has_receipt
--                 CHECK ((status = 'accepted') = (receipt_id IS NOT NULL))
--
--  Deleting the Beleg fires the foreign key's SET NULL. The row's `status` is
--  still `accepted`, so the CHECK sees an accepted submission naming no Beleg
--  and refuses — and because a referential action runs inside the deleting
--  statement, the whole DELETE rolls back. The Belege screen reports
--
--    new row for relation "partner_receipt_submissions" violates check
--    constraint "partner_receipt_submissions_accepted_has_receipt"
--
--  and there is no path around it: the delete is a plain PostgREST DELETE
--  (`useDatabase.deleteReceipt` through `deleteChecked`), and no RPC clears the
--  reference first. So **every** Beleg produced by an accepted submission is
--  permanently undeletable.
--
--  `20261007100000`'s header read the same mechanism and called it intended —
--  "deleting the Beleg refuses rather than leaving the submission pointing at
--  nothing" — and `tests/rls/driver-deletion.sql` probe 13 asserted the refusal
--  as correct behaviour. Nobody had asked what an operator is supposed to do
--  with a mistyped Beleg afterwards. The answer was nothing.
--
--  ── Measured, read-only on production, 23.10.2026 ─────────────────────────
--
--    partner_receipt_submissions_receipt_id_fkey   confdeltype = 'n'
--    accepted submissions naming a Beleg           20   (of 1126 receipts)
--      Y&A Mobility   18
--      Dinari Transport 2
--    dangling receipt references                    0
--
--  ── The owner's decision, 23.10.2026 ──────────────────────────────────────
--
--  Asked what should happen to the submission record when its Beleg is deleted
--  — keep it accepted and stamp that the Beleg was deleted, send it back to
--  `pending`, or refuse the delete — he answered: **"ينمسح وخلص"**, it gets
--  deleted, that's it. So `ON DELETE CASCADE`.
--
--  He was told in one line what that costs and decided anyway: the record of
--  *"this driver sent this receipt and someone accepted it"* goes with the
--  Beleg, so a driver asking later has nothing to point at. The intake's
--  idempotency key goes too, which means the same `external_submission_id` can
--  be delivered again and will be treated as new — on the partner side that is
--  a re-submission, which is the behaviour an operator who deleted the Beleg by
--  mistake would want. No soft delete, no archive table, no `deleted_at`: the
--  decision is the row is gone.
--
--  ── Why a cascade works although the table is unwritable by any client ────
--
--  `20261008160000` dropped the UPDATE policy and the table has never had an
--  INSERT or DELETE policy.
--
--  [CORRECTED 23.10.2026 by `20261023160000`, which re-measured this read-only
--  on production. This paragraph claimed `authenticated` holds no DELETE
--  *grant* on the table either, "measured on production: SELECT, TRIGGER,
--  TRUNCATE, UPDATE only". That is WRONG: both partner submission tables carry
--  the full Supabase default set there — DELETE, INSERT, REFERENCES, SELECT,
--  TRIGGER, TRUNCATE, UPDATE — for `anon`, `authenticated` and `service_role`
--  alike. So a member's own DELETE answers `rows 0` in production as it does
--  in the kit, and the wall is the MISSING DELETE POLICY alone, not a missing
--  privilege. Nothing about the cascade or this migration changes; the reason
--  recorded for the caller's statement failing did.]
--
--  Neither blocks the cascade, because a referential action is not the caller's
--  statement: PostgreSQL runs it as the table's owner and bypasses row
--  security. That is the crux of this change and it is measured rather than
--  asserted — `tests/rls/partner-submission-delete.sql` section 3 deletes a
--  Beleg as a company administrator and counts the submission rows afterwards.
--
--  Both context triggers stay, untouched, and a cascade fires row triggers, so
--  a support session's delete still leaves its audit row — one for the Beleg
--  and one for the submission, both naming the session's company. Section 5 of
--  that file measures it.
--
--  ── What the CHECK still does ─────────────────────────────────────────────
--
--  It is kept. It never governed the delete path usefully, but it is still the
--  rule for INSERT and UPDATE: the intake and the judging RPCs cannot file an
--  accepted submission that names no Beleg, nor reject one while it still does.
--  `20261008160000`'s header records measuring exactly that. Dropping it here
--  would trade a defect for a worse one.
--
--  ── The constraint's name afterwards ──────────────────────────────────────
--
--  `partner_receipt_submissions_receipt_id_fkey` — unchanged. It was PostgreSQL's
--  own name for the inline REFERENCES clause, and it is re-added under exactly
--  that name so every catalogue reader, the self-check below and the kit's
--  probes 14 and 15 keep finding it.
--
--  ── The note side: NOT changed here, and the asymmetry is deliberate ──────
--
--  `partner_note_submissions.driver_note_id` has **the same defect**, which the
--  brief for this change did not expect: reading `20261005140000` alone says the
--  column has no foreign key at all, and that was true for two days.
--  `20261007100000` added `partner_note_submissions_driver_note_id_fkey` with
--  `ON DELETE SET NULL` against the identically shaped
--  `partner_note_submissions_accepted_has_note`, to make the two siblings agree.
--  Measured on production today: `confdeltype = 'n'`, and **3 accepted note
--  submissions** (all Y&A Mobility) name a driver note. `NotesPage` deletes a
--  driver note through `deleteChecked`, so those three notes are undeletable in
--  exactly the same way.
--
--  It is left alone because the owner was asked about a Beleg and answered
--  about a Beleg. Whether the record of *"this driver reported being ill on
--  these days and someone accepted it"* should vanish with the note is a
--  separate question for him, not an inference from this one. So the two
--  siblings now disagree on purpose, and the self-check below prints the note
--  side's action on every run rather than pinning it — pinning it would fail
--  the release that fixes it.
--
--  `20261007100000`'s self-check 1 still asserts `receipt_id`'s action is
--  `'n'`. That is a historical assertion: it ran once on every live database
--  and, in the kit, it sorts before this file. It no longer describes head, and
--  it is not restated here.
--
--  ── What moves in the kit ─────────────────────────────────────────────────
--
--  `tests/rls/driver-deletion.sql` probe 13 flips from "a Beleg behind an
--  accepted submission cannot be deleted" to the delete succeeding, in this
--  same commit. Probes 14 and 15 count foreign keys rather than actions, so a
--  cascade is still one key and both stay as they are.

-- ─── 1. the action ──────────────────────────────────────────────────────────

/*
  Idempotent and cheap: the foreign key is replaced only when its action is not
  already CASCADE, so a second run is a catalogue read and nothing else. The
  existing key is found and dropped by the name the catalogue gives it rather
  than by the one this file expects, so a database whose key was created under
  another name is still corrected; it is re-added under the canonical name.
*/
DO $fk$
DECLARE
  v_name text;
  v_type "char";
BEGIN
  SELECT c.conname, c.confdeltype INTO v_name, v_type
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'public.partner_receipt_submissions'::regclass
     AND c.contype = 'f'
     AND a.attname = 'receipt_id'
     AND array_length(c.conkey, 1) = 1;

  IF v_type = 'c' THEN
    RAISE NOTICE 'partner submission delete: % is already ON DELETE CASCADE', v_name;
    RETURN;
  END IF;

  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.partner_receipt_submissions DROP CONSTRAINT %I', v_name);
  END IF;

  ALTER TABLE public.partner_receipt_submissions
    ADD CONSTRAINT partner_receipt_submissions_receipt_id_fkey
    FOREIGN KEY (receipt_id) REFERENCES public.receipts(id) ON DELETE CASCADE;

  RAISE NOTICE 'partner submission delete: % replaced by partner_receipt_submissions_receipt_id_fkey ON DELETE CASCADE',
    coalesce(v_name, '(no foreign key)');
END
$fk$;

COMMENT ON COLUMN public.partner_receipt_submissions.receipt_id IS
  'The receipts row an accepted submission produced. ON DELETE CASCADE since '
  '20261023150000: deleting the Beleg deletes the submission with it. It was '
  'ON DELETE SET NULL, which the accepted-has-receipt CHECK then refused, so '
  'no Beleg that came from a submission could ever be deleted (20 on '
  'production). The owner chose the cascade on 23.10.2026 knowing the record '
  'of the driver''s submission goes with the Beleg.';

-- ─── 2. Self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_n      int;
  v_names  text;
  v_type   "char";
  v_note   "char";
BEGIN
  -- 1. the action, read from the catalogue and not from this file's claim.
  --    'c' is CASCADE, 'n' is SET NULL — the value this migration replaces.
  SELECT c.confdeltype INTO v_type
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'public.partner_receipt_submissions'::regclass
     AND c.contype = 'f' AND a.attname = 'receipt_id'
     AND c.conname = 'partner_receipt_submissions_receipt_id_fkey';
  IF v_type IS DISTINCT FROM 'c' THEN
    RAISE EXCEPTION 'partner submission delete self-check 1: partner_receipt_submissions_receipt_id_fkey is % (expected c for CASCADE)',
      coalesce(v_type::text, 'absent under that name');
  END IF;

  -- 2. exactly one foreign key on the column. A drop-and-add that left the old
  --    one in place would give the column two actions, and the SET NULL one
  --    would still refuse the delete it was added to allow.
  SELECT count(*), string_agg(c.conname, ', ' ORDER BY c.conname) INTO v_n, v_names
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'public.partner_receipt_submissions'::regclass
     AND c.contype = 'f' AND a.attname = 'receipt_id';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'partner submission delete self-check 2: % foreign key(s) on receipt_id: %', v_n, coalesce(v_names, '-');
  END IF;

  -- 3. it still points at receipts(id). The whole point is that deleting a
  --    Beleg reaches this row; a key re-added against another table would
  --    satisfy check 1 and reach nothing.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.partner_receipt_submissions'::regclass
       AND c.conname = 'partner_receipt_submissions_receipt_id_fkey'
       AND c.confrelid = 'public.receipts'::regclass
  ) THEN
    RAISE EXCEPTION 'partner submission delete self-check 3: the foreign key no longer references public.receipts';
  END IF;

  -- 4. the CHECK is kept. It no longer has anything to say about a delete, but
  --    it is still what stops an accepted submission naming no Beleg on INSERT
  --    and UPDATE, which is the intake's and the judging RPCs' only guard.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_receipt_submissions'::regclass
       AND conname = 'partner_receipt_submissions_accepted_has_receipt'
  ) THEN
    RAISE EXCEPTION 'partner submission delete self-check 4: the accepted-has-receipt CHECK was dropped, so an accepted submission may now name no Beleg';
  END IF;

  -- 5. no client write policy appeared. A cascade needs none — it runs as the
  --    table owner — so a release that added one to "make the delete work"
  --    would have misread the mechanism and widened the table at the same time.
  SELECT count(*), string_agg(policyname || ' (' || cmd || ')', ', ') INTO v_n, v_names
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'partner_receipt_submissions'
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'partner submission delete self-check 5: % client write policy/ies on partner_receipt_submissions: %', v_n, v_names;
  END IF;

  -- 6. and the SELECT policy and both context triggers are untouched, because a
  --    cascade fires row triggers and the audit row for the cascaded delete is
  --    what keeps a support session's write recorded.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'partner_receipt_submissions'
       AND cmd = 'SELECT' AND qual LIKE '%get_active_company_id%'
  ) THEN
    RAISE EXCEPTION 'partner submission delete self-check 6: the tenant SELECT policy is gone';
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname = 'partner_receipt_submissions'
     AND g.tgname IN ('refuse_read_only_context_write', 'record_support_write')
     AND NOT g.tgisinternal;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'partner submission delete self-check 6: % of 2 context triggers on partner_receipt_submissions', v_n;
  END IF;

  -- 7. The note side, REPORTED and not asserted. Its action is deliberately
  --    still SET NULL (the owner was asked about a Beleg), so pinning it would
  --    fail the release that answers the other half. Printing it keeps the
  --    asymmetry in front of the next reader instead of in this header alone.
  SELECT c.confdeltype INTO v_note
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'public.partner_note_submissions'::regclass
     AND c.contype = 'f' AND a.attname = 'driver_note_id';
  IF v_note = 'n' THEN
    RAISE NOTICE 'partner submission delete: the note sibling is still ON DELETE SET NULL, so a driver note behind an accepted submission is still undeletable (3 on production, 23.10.2026) — the owner''s call, not an oversight';
  ELSE
    RAISE NOTICE 'partner submission delete: the note sibling''s delete action is now %, no longer the SET NULL this migration recorded',
      coalesce(v_note::text, 'absent');
  END IF;

  RAISE NOTICE 'partner submission delete: self-checks passed — deleting a Beleg now deletes its submission';
END
$check$;
