-- ════════════════════════════════════════════════════════════════════════════
--  A driver note that came from a driver's submission could not be deleted
-- ════════════════════════════════════════════════════════════════════════════
--
--  The exact twin of `20261023150000`, one table over, and the half of the
--  owner's question that file deliberately left open.
--
--  `partner_note_submissions.driver_note_id` was given a foreign key by
--  `20261007100000` with `ON DELETE SET NULL`, against the CHECK that
--  `20261005140000` created with the table:
--
--    line 178:  CONSTRAINT partner_note_submissions_accepted_has_note
--                 CHECK ((status = 'accepted') = (driver_note_id IS NOT NULL))
--
--  Deleting the driver note fires the SET NULL. The row's `status` is still
--  `accepted`, so the CHECK sees an accepted submission naming no note and
--  refuses — and because a referential action runs inside the deleting
--  statement, the whole DELETE rolls back. `NotesPage` deletes a note through
--  `deleteChecked` (`src/pages/NotesPage.tsx:553`), a plain PostgREST DELETE,
--  and no RPC clears the reference first: the table has carried no UPDATE
--  policy since `20261008160000`. So **every** driver note produced by an
--  accepted submission is permanently undeletable, and so is its driver —
--  `driver_notes.driver_id` is CASCADE, so deleting the driver deletes the
--  note, which runs the same SET NULL into the same refusal.
--
--  `20261007100000` added the key on purpose and called this shape correct:
--  "deleting the note refuses rather than leaving the submission pointing at
--  nothing". It was closing a real hole — before it, the note cascaded away
--  and left the submission `accepted` naming a row that no longer existed, and
--  a dangling uuid is still non-null so the CHECK could not see it. What it
--  did instead of a lie was a wall, and nobody asked what an operator does
--  with a mistaken note afterwards. The answer was nothing.
--
--  ── Measured, read-only on production, 23.10.2026 ─────────────────────────
--
--    partner_note_submissions_driver_note_id_fkey   confdeltype = 'n'
--    partner_note_submissions rows, all accepted    3   (all Y&A Mobility)
--    accepted submissions naming a driver note      3
--    driver_notes rows                             41
--    dangling driver_note references                0
--    distinct drivers behind those three notes      1
--
--  **Three driver notes on production cannot be deleted. ZERO drivers are
--  undeletable because of this, and saying otherwise would be an overclaim.**
--  All three notes belong to one driver, and that driver is pinned twice over
--  by things this change does not touch: 666 rows of `fahrtenbuch_trips` name
--  it as `original_driver_id` against the immutability trigger, and it holds a
--  `linked` `partner_driver_links` row. So the driver-level refusal below is a
--  real mechanism with no instance in production's data today -- the shape
--  matters because the next such note need not be a pinned driver's, not
--  because three deletions are blocked by it.
--
--  The Beleg sibling read 21 accepted submissions naming a Beleg on the same
--  pass, where `20261023150000` recorded 20 the same day; one more arrived in
--  between. Neither cascade migration is applied to production yet (its newest
--  ledger row is `20261016170000_income_negative_uber_amounts`, 17.10.2026),
--  which is what makes the ordering argument below a live concern and not a
--  hypothetical.
--
--  ── The owner's decision, 23.10.2026 ──────────────────────────────────────
--
--  The same as for the Beleg, asked and answered the same day: **"ينمسح
--  وخلص"**, it gets deleted. So `ON DELETE CASCADE`.
--
--  He was told what it costs and decided anyway: the record of *"this driver
--  reported being ill on these days and someone accepted it"* goes with the
--  note, so a driver asking later has nothing to point at, and an absence a
--  payroll month was planned around leaves no trace on this table. The
--  idempotency key goes too — `partner_note_submissions_idempotency` is
--  `(company_id, partner, external_submission_id)`, so once the row is gone
--  the same `external_submission_id` can be delivered again and is treated as
--  new. On the partner's side that is a re-submission, which is what an
--  operator who deleted the note by mistake wants. No soft delete, no archive
--  table, no `deleted_at`: the decision is the row is gone.
--
--  ── Why a cascade works although the table is unwritable by any client ────
--
--  `20261008160000` dropped the UPDATE policy and the table has never had an
--  INSERT or DELETE policy. Neither blocks the cascade, because a referential
--  action is not the caller's statement: PostgreSQL runs it as the table's
--  owner and bypasses row security. That is the crux and it is measured rather
--  than asserted — `tests/rls/note-submission-delete.sql` section 3 deletes a
--  note as a company administrator, who reaches that row by no other means,
--  and counts the submission rows afterwards.
--
--  **The wall is the POLICY and not a missing grant, and that is a correction
--  to `20261023150000`.** Its header and its kit file both record production
--  as granting `authenticated` only "SELECT, TRIGGER, TRUNCATE and UPDATE" on
--  the receipt submission table, and conclude that a member's own DELETE there
--  answers `42501` in production where the fixture answers `rows 0`. Measured
--  on production today, both tables carry the **full** Supabase default set —
--  `DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE` — for
--  `anon`, `authenticated` and `service_role` alike. So the statement answers
--  `rows 0` in production too, for the same reason it does in the fixture: the
--  table has no DELETE policy, so the row is not in the statement's scope. The
--  conclusion that the caller cannot reach the row is unchanged; the mechanism
--  recorded for it was wrong, and the probe below pins the grant rather than a
--  difference that does not exist.
--
--  Both context triggers stay, untouched, and a cascade fires row triggers, so
--  a support session's delete still leaves its audit row — one for the note
--  and one for the submission, both naming the session's company. Section 6 of
--  that file measures it, and it is one trigger pair further than the receipt
--  side needed: the note's own audit row has `note_text` redacted
--  (`app_private.support_write_redaction_pattern`), while the submission's
--  `note_text` is not on that list, so the two rows do not say the same thing.
--  Widening the pattern is a data-protection decision and is not taken here.
--
--  ── What the CHECK still does ─────────────────────────────────────────────
--
--  It is kept. It never governed the delete path usefully, but it is still the
--  rule for INSERT and UPDATE: the note intake and the judging RPCs cannot
--  file an accepted submission that names no note, nor reject one while it
--  still does.
--
--  ── The constraint's name afterwards ──────────────────────────────────────
--
--  `partner_note_submissions_driver_note_id_fkey` — unchanged, the name
--  `20261007100000` gave it, so every catalogue reader keeps finding it.
--
--  ── The two siblings agree again, and the pin lives HERE ──────────────────
--
--  `20261023150000`'s self-check 7 PRINTS this column's action instead of
--  pinning it, because pinning it would have failed this release. The brief
--  for this change asked for that notice to be turned into a pin of `'c'`.
--  **It is pinned here instead, and that is not a preference:** migrations
--  apply in filename order, so `20261023150000` runs BEFORE this file on every
--  database that has neither — production today, and every fresh run of the
--  RLS kit, which applies the whole chain from `20260908` on. At the moment
--  that file's self-check runs, this column is still `'n'`. A pin of `'c'`
--  there would fail the production release and the kit itself, which is the
--  opposite of what it was asked to achieve. So `20261023150000` is left
--  exactly as it shipped and self-check 7 below pins BOTH columns at `'c'`:
--  from here on a release that loses either cascade, or that reopens the
--  asymmetry in either direction, fails.
--
--  `20261007100000`'s self-check 1 asserts BOTH columns are `'n'`, and it
--  stays green for the same ordering reason: it ran once on every live
--  database, and in a fresh chain it sorts before both cascade migrations, so
--  at the moment it runs both columns really are SET NULL. It is a historical
--  assertion. It is not restated and it must not be "fixed".
--
--  ── What moves in the kit ─────────────────────────────────────────────────
--
--  `tests/rls/driver-deletion.sql` probes 9 to 12 flip in this same commit,
--  from "a driver whose note backs an accepted submission cannot be deleted"
--  to the delete succeeding and taking note and submission with it. Probes 14
--  and 15 count foreign keys rather than actions, so a cascade is still one
--  key and both stay as they are.

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
   WHERE c.conrelid = 'public.partner_note_submissions'::regclass
     AND c.contype = 'f'
     AND a.attname = 'driver_note_id'
     AND array_length(c.conkey, 1) = 1;

  IF v_type = 'c' THEN
    RAISE NOTICE 'note submission delete: % is already ON DELETE CASCADE', v_name;
    RETURN;
  END IF;

  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.partner_note_submissions DROP CONSTRAINT %I', v_name);
  END IF;

  ALTER TABLE public.partner_note_submissions
    ADD CONSTRAINT partner_note_submissions_driver_note_id_fkey
    FOREIGN KEY (driver_note_id) REFERENCES public.driver_notes(id) ON DELETE CASCADE;

  RAISE NOTICE 'note submission delete: % replaced by partner_note_submissions_driver_note_id_fkey ON DELETE CASCADE',
    coalesce(v_name, '(no foreign key)');
END
$fk$;

COMMENT ON COLUMN public.partner_note_submissions.driver_note_id IS
  'The driver_notes row an accepted submission produced. ON DELETE CASCADE '
  'since 20261023160000: deleting the note deletes the submission with it, and '
  'so does deleting the driver, driver_notes.driver_id being CASCADE. It was '
  'ON DELETE SET NULL (20261007100000), which the accepted-has-note CHECK then '
  'refused, so no note that came from a submission could ever be deleted and '
  'neither could its driver (3 notes on production). The owner chose the '
  'cascade on 23.10.2026, the same answer he gave for the Beleg, knowing the '
  'record of the driver''s report goes with the note.';

-- ─── 2. Self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_n     int;
  v_names text;
  v_type  "char";
  v_rec   "char";
BEGIN
  -- 1. the action, read from the catalogue and not from this file's claim.
  --    'c' is CASCADE, 'n' is SET NULL — the value this migration replaces.
  SELECT c.confdeltype INTO v_type
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'public.partner_note_submissions'::regclass
     AND c.contype = 'f' AND a.attname = 'driver_note_id'
     AND c.conname = 'partner_note_submissions_driver_note_id_fkey';
  IF v_type IS DISTINCT FROM 'c' THEN
    RAISE EXCEPTION 'note submission delete self-check 1: partner_note_submissions_driver_note_id_fkey is % (expected c for CASCADE)',
      coalesce(v_type::text, 'absent under that name');
  END IF;

  -- 2. exactly one foreign key on the column. A drop-and-add that left the old
  --    one in place would give the column two actions, and the SET NULL one
  --    would still refuse the delete it was added to allow.
  SELECT count(*), string_agg(c.conname, ', ' ORDER BY c.conname) INTO v_n, v_names
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'public.partner_note_submissions'::regclass
     AND c.contype = 'f' AND a.attname = 'driver_note_id';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'note submission delete self-check 2: % foreign key(s) on driver_note_id: %', v_n, coalesce(v_names, '-');
  END IF;

  -- 3. it still points at driver_notes(id). The whole point is that deleting a
  --    note reaches this row; a key re-added against another table would
  --    satisfy check 1 and reach nothing.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.partner_note_submissions'::regclass
       AND c.conname = 'partner_note_submissions_driver_note_id_fkey'
       AND c.confrelid = 'public.driver_notes'::regclass
  ) THEN
    RAISE EXCEPTION 'note submission delete self-check 3: the foreign key no longer references public.driver_notes';
  END IF;

  -- 4. the CHECK is kept. It no longer has anything to say about a delete, but
  --    it is still what stops an accepted submission naming no note on INSERT
  --    and UPDATE, which is the note intake's and the judging RPCs' only guard.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_note_submissions'::regclass
       AND conname = 'partner_note_submissions_accepted_has_note'
  ) THEN
    RAISE EXCEPTION 'note submission delete self-check 4: the accepted-has-note CHECK was dropped, so an accepted submission may now name no note';
  END IF;

  -- 5. no client write policy appeared. A cascade needs none — it runs as the
  --    table owner — so a release that added one to "make the delete work"
  --    would have misread the mechanism and widened the table at the same time.
  SELECT count(*), string_agg(policyname || ' (' || cmd || ')', ', ') INTO v_n, v_names
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'partner_note_submissions'
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'note submission delete self-check 5: % client write policy/ies on partner_note_submissions: %', v_n, v_names;
  END IF;

  -- 6. the tenant SELECT policy and both context triggers are untouched,
  --    because a cascade fires row triggers and the audit row for the cascaded
  --    delete is what keeps a support session's write recorded. The pair is
  --    required by tests/rls/platform-contexts.sql section 14 and
  --    support-write-audit.sql section 1 on any table whose policies name
  --    get_active_company_id(), whoever writes it today.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'partner_note_submissions'
       AND cmd = 'SELECT' AND qual LIKE '%get_active_company_id%'
  ) THEN
    RAISE EXCEPTION 'note submission delete self-check 6: the tenant SELECT policy is gone';
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname = 'partner_note_submissions'
     AND g.tgname IN ('refuse_read_only_context_write', 'record_support_write')
     AND NOT g.tgisinternal;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'note submission delete self-check 6: % of 2 context triggers on partner_note_submissions', v_n;
  END IF;

  -- 7. BOTH siblings are CASCADE, and this is the pin 20261023150000 could not
  --    carry. That file runs before this one on every database that has
  --    neither, so a pin of 'c' there would fail the release and the kit; here
  --    it is after both changes and holds. From now on losing either cascade,
  --    or reopening the asymmetry in either direction, fails a release.
  SELECT c.confdeltype INTO v_rec
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'public.partner_receipt_submissions'::regclass
     AND c.contype = 'f' AND a.attname = 'receipt_id';
  IF v_rec IS DISTINCT FROM 'c' THEN
    RAISE EXCEPTION 'note submission delete self-check 7: the receipt sibling is % (expected c) — 20261023150000''s cascade is gone, so a Beleg behind an accepted submission is undeletable again',
      coalesce(v_rec::text, 'absent');
  END IF;

  RAISE NOTICE 'note submission delete: self-checks passed — deleting a driver note now deletes its submission, and both siblings are CASCADE';
END
$check$;
