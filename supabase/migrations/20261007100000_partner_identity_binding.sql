-- ════════════════════════════════════════════════════════════════════════════
--  Two defects of my own, both found by measurement rather than by review
-- ════════════════════════════════════════════════════════════════════════════
--
--  Both belong to `20261005120000` and `20261005140000`, committed on 05.10, and
--  neither was found by reading the files. The first came out of a kit file
--  written to settle unverified readings; the second out of a five-lens audit of
--  the milestone plan. Recording that is the point: a migration whose author
--  reviewed it twice still shipped a sibling pair that disagree.
--
--  ── 1. `partner_note_submissions.driver_note_id` has no foreign key ─────────
--
--  Its sibling `partner_receipt_submissions.receipt_id` has one, with
--  `ON DELETE SET NULL`, and both tables carry the same shape of guard:
--
--    CHECK ((status = 'accepted') = (<the reference> IS NOT NULL))
--
--  On the receipt side that works as intended: deleting the Beleg fires the FK's
--  SET NULL, the CHECK sees `accepted` with a NULL reference and refuses the
--  delete. Measured in `tests/rls/driver-deletion.sql` probe 13.
--
--  On the note side there is no FK, so nothing fires. Probes 9 to 12 measured
--  what happens instead: the driver deletes, `driver_notes` cascades away, and
--  the submission is left `status = 'accepted'` pointing at a row that no longer
--  exists. **The CHECK does not catch it, because a dangling uuid is still
--  non-null.** An accepted note submission therefore stops being a record of
--  anything the moment its driver is deleted -- which is exactly the case a
--  submission table exists for.
--
--  I expected the refusal and asserted it. The kit refused the expectation and
--  the measurement was the other way round. This migration makes the two tables
--  agree, and probe 14 flips from "has no foreign key" to "has one" in the same
--  commit.
--
--  Note what it does NOT do: it does not make a driver deletable. The driver was
--  already pinned by `fahrtenbuch_trips.original_driver_id` against the
--  immutability trigger (probe 5) and by a confirmed `partner_driver_links` row
--  (probe 7). This closes a hole that let a *subset* of deletions through in a
--  state that lies; the erasure rule of M0 is still owed, and is still a function
--  that has to handle each pinned reference on purpose.
--
--  ── 2. Two companies can claim the same partner fleet ──────────────────────
--
--  `partner_connections` has one live row per `(company_id, partner)`, so one
--  company cannot connect the same fleet twice. It has nothing the other way:
--  **two different El-Professor companies can each connect the SAME Reidey
--  fleet**, and the second one silently becomes the live connection for a fleet
--  the first is also reading.
--
--  That matters because of the defect this same day's work is fixing on the
--  other side: the roster read returned no fleet identity, so nothing could tell
--  that the token pasted into company B names the fleet already connected to
--  company A. Reidey now answers with `tenant_id`, which is what makes this
--  index enforceable -- an index on a column nothing fills is decoration.
--
--  The index is partial on `status <> 'revoked'`, matching the existing live
--  index, so a revoked connection frees the fleet for another company. And
--  `external_company_id` stays nullable, so the rows that predate the identity
--  read do not collide: NULLs never conflict in a unique index. That is
--  deliberate and it is the one soft edge here -- a connection with no recorded
--  identity is not covered, which is why `20261005130000`'s own comment says the
--  id is "never taken from a form".

-- ─── 1. the missing foreign key ─────────────────────────────────────────────

-- A dangling reference already in the data would make the constraint
-- unaddable, and silently dropping such a row is not this migration's call. So
-- clear the reference and say so on the row instead: the submission keeps its
-- payload and its decision, and loses only a pointer that resolved to nothing.
UPDATE public.partner_note_submissions s
   SET driver_note_id = NULL,
       status = CASE WHEN s.status = 'accepted' THEN 'rejected' ELSE s.status END,
       rejected_reason = CASE
         WHEN s.status = 'accepted'
           THEN 'note_deleted_before_fk (20261007100000)'
         ELSE s.rejected_reason END,
       updated_at = now()
 WHERE s.driver_note_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.driver_notes n WHERE n.id = s.driver_note_id);

ALTER TABLE public.partner_note_submissions
  ADD CONSTRAINT partner_note_submissions_driver_note_id_fkey
  FOREIGN KEY (driver_note_id) REFERENCES public.driver_notes(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.partner_note_submissions.driver_note_id IS
  'The driver_notes row an accepted submission produced. ON DELETE SET NULL, '
  'against the accepted-has-note CHECK, so deleting the note refuses rather '
  'than leaving the submission pointing at nothing -- the shape its sibling '
  'partner_receipt_submissions.receipt_id always had. Added by 20261007100000 '
  'after tests/rls/driver-deletion.sql measured the omission.';

-- ─── 2. one live connection per partner fleet ───────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS partner_connections_live_per_external
  ON public.partner_connections (partner, external_company_id)
  WHERE status <> 'revoked' AND external_company_id IS NOT NULL;

COMMENT ON INDEX public.partner_connections_live_per_external IS
  'A partner fleet is connected to at most one company at a time. Partial on '
  'status, so a revoked connection frees the fleet; NULL external ids are '
  'excluded, so connections recorded before the partner answered with an '
  'identity do not collide.';

-- ─── 3. Self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_n int;
BEGIN
  -- 1. the two sibling columns now have the same shape, read from the catalogue
  --    rather than from this file's own claim about them.
  FOR v_n IN 1..1 LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conrelid = 'public.partner_note_submissions'::regclass
         AND c.contype = 'f' AND a.attname = 'driver_note_id'
         AND c.confdeltype = 'n'   -- SET NULL
    ) THEN
      RAISE EXCEPTION 'partner identity self-check 1: driver_note_id has no ON DELETE SET NULL foreign key';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conrelid = 'public.partner_receipt_submissions'::regclass
         AND c.contype = 'f' AND a.attname = 'receipt_id'
         AND c.confdeltype = 'n'
    ) THEN
      RAISE EXCEPTION 'partner identity self-check 1: receipt_id lost the shape driver_note_id was matched to';
    END IF;
  END LOOP;

  -- 2. the CHECK that the foreign key now makes effective is still there. Without
  --    it the FK would merely null the column and the row would still lie.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.partner_note_submissions'::regclass
       AND conname = 'partner_note_submissions_accepted_has_note'
  ) THEN
    RAISE EXCEPTION 'partner identity self-check 2: the accepted-has-note CHECK is gone, so the new foreign key guards nothing';
  END IF;

  -- 3. no accepted submission points at a note that does not exist. This is the
  --    state the migration was added to make impossible; assert it held.
  SELECT count(*) INTO v_n
    FROM public.partner_note_submissions s
   WHERE s.driver_note_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.driver_notes n WHERE n.id = s.driver_note_id);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'partner identity self-check 3: % dangling note reference(s) survived the cleanup', v_n;
  END IF;

  -- 4. the fleet index exists, is unique, and is partial on both terms. A
  --    non-partial version would refuse a revoked connection's fleet for ever.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'partner_connections_live_per_external'
       AND indexdef LIKE 'CREATE UNIQUE INDEX%'
       AND indexdef LIKE '%status <> %revoked%'
       AND indexdef LIKE '%external_company_id IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION 'partner identity self-check 4: the one-fleet-one-company index is missing or no longer partial';
  END IF;

  -- 5. the older live index is untouched: one company still cannot connect the
  --    same partner twice. The new index is the other direction, not a rename.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'partner_connections_live_per_company'
  ) THEN
    RAISE EXCEPTION 'partner identity self-check 5: partner_connections_live_per_company was dropped';
  END IF;

  -- 6. neither submission table gained an INSERT or DELETE policy while this
  --    file was in the area. The writer is an edge function through a definer
  --    RPC, and a client-insertable submission would claim a driver said
  --    something they did not.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('partner_note_submissions', 'partner_receipt_submissions')
     AND cmd IN ('INSERT', 'DELETE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'partner identity self-check 6: a submission table gained an INSERT or DELETE policy';
  END IF;

  RAISE NOTICE 'partner identity: self-checks passed — the sibling columns agree, and a fleet belongs to one company';
END
$check$;
