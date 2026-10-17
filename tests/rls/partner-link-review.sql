-- ════════════════════════════════════════════════════════════════════════════
--  M2 — what confirming and rejecting a partner driver actually do
-- ════════════════════════════════════════════════════════════════════════════
--
--  `20261008100000`'s two functions. The matrix says who may call them; this
--  file says what happens, and three of these probes are the reason the file
--  exists rather than a comment:
--
--    §3  confirming CLAIMS the submissions that arrived before the link, in the
--        same call. Split into two client calls, a lost response strands them
--        beside a link that says it is confirmed, and nothing retries.
--    §3  a submission already accepted or rejected is NOT re-pointed. Its
--        decision is a record; re-pointing it would rewrite one.
--    §4  rejecting a link leaves those submissions alone and only COUNTS them.
--        The tidier database would reject them, and `rejected_reason` is shown
--        to the driver, so the tidy version sends a person a sentence no person
--        wrote.
--
--  §5 is the end of the chain: once the link is confirmed, the note that had
--  been unacceptable can be accepted. That is M2 and M3 meeting, and it is the
--  only probe here that proves the two slices compose.

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _lr_call(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out  text;
  v_hint text;
BEGIN
  EXECUTE p_sql INTO v_out;
  RETURN coalesce(v_out, 'null');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
  RETURN 'ERR ' || SQLSTATE || ' ' || coalesce(nullif(v_hint, ''), '(no hint)');
END;
$$;

CREATE TEMP TABLE _lr_out (
  n        integer PRIMARY KEY,
  label    text    NOT NULL,
  actual   text    NOT NULL,
  expected text    NOT NULL,
  matched  boolean NOT NULL
);

-- §2 and §6 record their probes as `authenticated`, which the decisions have to
-- run as or they would measure the owner's RLS bypass instead of the gate.
GRANT SELECT, INSERT ON _lr_out TO authenticated;

CREATE OR REPLACE FUNCTION _lr_rec(p_n integer, p_label text, p_actual text, p_expected text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  v_ok := p_actual = p_expected;
  INSERT INTO _lr_out VALUES (p_n, p_label, p_actual, p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', p_actual;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION _lr_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE OR REPLACE FUNCTION _lr_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

-- ─── fixtures ───────────────────────────────────────────────────────────────

INSERT INTO drivers (id, company_id, name) VALUES
  ('1a000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'Ours'),
  ('1a000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000a', 'Also Ours'),
  ('1a000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-00000000000b', 'Theirs');

-- Three proposals of company A: one to confirm, one to reject, one to collide
-- with the first by naming the same driver.
INSERT INTO partner_driver_links (id, company_id, partner, external_driver_id, proposed_name) VALUES
  ('1b000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'reidey', 'lr-1', 'Omar K.'),
  ('1b000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000a', 'reidey', 'lr-2', 'Sami M.'),
  ('1b000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-00000000000a', 'reidey', 'lr-3', 'Omar K.');

-- Submissions that arrived BEFORE any link: two waiting on lr-1 (one note, one
-- Beleg), one already decided, and one waiting on lr-2.
INSERT INTO partner_note_submissions
       (id, company_id, partner, external_submission_id, external_driver_id, note_type, note_text)
VALUES ('1c000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', 'lr-note-1', 'lr-1', 'breakdown', 'Panne'),
       ('1c000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', 'lr-note-2', 'lr-2', 'wait', 'Wartezeit');

-- A rejected one on lr-1: it carries a decision, so the claim must leave it.
INSERT INTO partner_note_submissions
       (id, company_id, partner, external_submission_id, external_driver_id,
        note_type, note_text, status, rejected_reason)
VALUES ('1c000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', 'lr-note-3', 'lr-1', 'general', 'x', 'rejected', 'zu alt');

INSERT INTO partner_receipt_submissions
       (id, company_id, partner, external_submission_id, external_driver_id, description)
VALUES ('1d000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', 'lr-rec-1', 'lr-1', 'Tanken');

-- A dated, complete Beleg on lr-1: this one CAN become a Beleg on the confirm.
INSERT INTO partner_receipt_submissions
       (id, company_id, partner, external_submission_id, external_driver_id,
        receipt_date, category, amount, payment_method)
VALUES ('1d000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', 'lr-rec-2', 'lr-1', DATE '2026-10-01', 'Tanken', 12.50, 'bar');

-- ─── 1. the argument contract and the lookups ───────────────────────────────

DO $$
DECLARE
  v_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _lr_as(v_admin);

  PERFORM _lr_rec(1, 'a confirm with no driver is refused by the contract',
    _lr_call($q$SELECT partner_driver_link_confirm('1b000000-0000-4000-8000-000000000001', NULL)::text$q$),
    'ERR 22023 invalid_request');

  PERFORM _lr_rec(2, 'a proposal that does not exist is not found',
    _lr_call($q$SELECT partner_driver_link_confirm('1b000000-0000-4000-8000-0000000000ff',
                 '1a000000-0000-4000-8000-000000000001')::text$q$),
    'ERR P0002 link_not_found');

  -- The same refusal as a driver that does not exist: a caller learns nothing
  -- about another company's drivers.
  PERFORM _lr_rec(3, 'a driver of another company is not found',
    _lr_call($q$SELECT partner_driver_link_confirm('1b000000-0000-4000-8000-000000000001',
                 '1a000000-0000-4000-8000-000000000003')::text$q$),
    'ERR P0002 driver_not_found');

  PERFORM _lr_rec(4, 'and so is a driver that does not exist at all',
    _lr_call($q$SELECT partner_driver_link_confirm('1b000000-0000-4000-8000-000000000001',
                 '1a000000-0000-4000-8000-0000000000ff')::text$q$),
    'ERR P0002 driver_not_found');

  PERFORM _lr_reset();
END $$;

-- ─── 2. the role gate, which a definer has to ask itself ────────────────────

DO $$
DECLARE
  v_viewer constant uuid := 'a0000000-0000-4000-8000-000000000003';
BEGIN
  PERFORM _lr_as(v_viewer);
  PERFORM _lr_rec(5, 'a viewer may not confirm',
    _lr_call($q$SELECT partner_driver_link_confirm('1b000000-0000-4000-8000-000000000001',
                 '1a000000-0000-4000-8000-000000000001')::text$q$),
    'ERR 42501 not_authorized');
  PERFORM _lr_rec(6, 'nor reject',
    _lr_call($q$SELECT partner_driver_link_reject('1b000000-0000-4000-8000-000000000002')::text$q$),
    'ERR 42501 not_authorized');
  PERFORM _lr_reset();
END $$;

-- ─── 3. the confirm, and the claim that rides with it ───────────────────────

DO $$
DECLARE
  v_editor constant uuid := 'a0000000-0000-4000-8000-000000000002';
BEGIN
  PERFORM _lr_as(v_editor);

  -- An editor holds the drivers page, which is the control for probe 5: without
  -- it, 5 would pass for a fixture nobody can confirm.
  PERFORM _lr_rec(7, 'an editor, who holds the drivers page, confirms it',
    _lr_call($q$SELECT partner_driver_link_confirm('1b000000-0000-4000-8000-000000000001',
                 '1a000000-0000-4000-8000-000000000001') ->> 'ok'$q$),
    'true');
  PERFORM _lr_reset();

  PERFORM _lr_rec(8, 'the proposal is linked and records who did it',
    (SELECT status || ' / ' || coalesce(driver_id::text, 'null') || ' / '
            || CASE WHEN linked_by = v_editor THEN 'by the editor' ELSE 'by someone else' END
       FROM partner_driver_links WHERE id = '1b000000-0000-4000-8000-000000000001'),
    'linked / 1a000000-0000-4000-8000-000000000001 / by the editor');

  -- The property the single transaction buys.
  PERFORM _lr_rec(9, 'the note that arrived BEFORE the link now names the driver',
    (SELECT coalesce(driver_id::text, 'null') FROM partner_note_submissions
      WHERE id = '1c000000-0000-4000-8000-000000000001'),
    '1a000000-0000-4000-8000-000000000001');

  PERFORM _lr_rec(10, 'and so does the Beleg that arrived before it',
    (SELECT coalesce(driver_id::text, 'null') FROM partner_receipt_submissions
      WHERE id = '1d000000-0000-4000-8000-000000000001'),
    '1a000000-0000-4000-8000-000000000001');

  -- A decided submission is a record. Re-pointing it would rewrite one.
  PERFORM _lr_rec(11, 'the already-rejected one is left exactly as it was',
    (SELECT status || ' / ' || coalesce(driver_id::text, 'null') FROM partner_note_submissions
      WHERE id = '1c000000-0000-4000-8000-000000000003'),
    'rejected / null');

  -- Another external driver's submission is nobody else's business.
  PERFORM _lr_rec(12, 'the submission waiting on a DIFFERENT proposal is untouched',
    (SELECT coalesce(driver_id::text, 'null') FROM partner_note_submissions
      WHERE id = '1c000000-0000-4000-8000-000000000002'),
    'null');

  -- 13.10.2026: confirming the link applies what was waiting, Belege included.
  PERFORM _lr_rec(26, 'the dated Beleg that was waiting became a Beleg, with OUR driver name',
    (SELECT r.driver_name || ' / ' || r.expense::text || ' / '
            || coalesce(r.created_by, 'no user') || ' / ' || coalesce(r.submitted_by_name, 'null')
       FROM partner_receipt_submissions s JOIN receipts r ON r.id = s.receipt_id
      WHERE s.id = '1d000000-0000-4000-8000-000000000002' AND s.status = 'accepted'),
    'Ours / 12.50 / no user / Ours');

  -- The same link reaches a submission that cannot be a Beleg yet: no date, and
  -- receipts.date is NOT NULL. It waits, it is not invented a date.
  PERFORM _lr_rec(27, 'a Beleg with no date stays pending rather than being given one',
    (SELECT status || ' / ' || (receipt_id IS NULL)::text FROM partner_receipt_submissions
      WHERE id = '1d000000-0000-4000-8000-000000000001'),
    'pending / true');
END $$;

-- ─── 4. one driver, one link per partner ────────────────────────────────────

DO $$
DECLARE v_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _lr_as(v_admin);

  -- The unique index would raise 23505 with its own name. Named instead,
  -- because a constraint name on a screen is what an operator ends up reading.
  PERFORM _lr_rec(13, 'a second proposal cannot name a driver already linked',
    _lr_call($q$SELECT partner_driver_link_confirm('1b000000-0000-4000-8000-000000000003',
                 '1a000000-0000-4000-8000-000000000001')::text$q$),
    'ERR P0001 driver_already_linked');

  PERFORM _lr_rec(14, 'so that proposal is still pending',
    (SELECT status FROM partner_driver_links WHERE id = '1b000000-0000-4000-8000-000000000003'),
    'pending');

  PERFORM _lr_rec(15, 'and a decided proposal cannot be decided again',
    _lr_call($q$SELECT partner_driver_link_confirm('1b000000-0000-4000-8000-000000000001',
                 '1a000000-0000-4000-8000-000000000002')::text$q$),
    'ERR P0001 already_decided');

  -- A different driver is admitted, so probe 13 measured the collision rather
  -- than "a second confirm never works".
  PERFORM _lr_rec(16, 'a different driver IS admitted for that proposal',
    _lr_call($q$SELECT partner_driver_link_confirm('1b000000-0000-4000-8000-000000000003',
                 '1a000000-0000-4000-8000-000000000002') ->> 'ok'$q$),
    'true');
  PERFORM _lr_reset();
END $$;

-- ─── 5. M2 and M3 meet: the link applies what was waiting ──────────────────
--
--  Until 13.10.2026 a person pressed "Übernehmen" on the note once its driver
--  was linked. There is no review now: confirming the link IS the moment the
--  waiting note becomes a driver_notes row, in the same call, with no accept.

DO $$
DECLARE
  v_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_note  uuid;
BEGIN
  SELECT driver_note_id INTO v_note FROM partner_note_submissions
   WHERE id = '1c000000-0000-4000-8000-000000000001';

  PERFORM _lr_rec(17, 'the note was applied by the confirm itself, with no accept',
    (SELECT status || ' / ' || (driver_note_id IS NOT NULL)::text FROM partner_note_submissions
      WHERE id = '1c000000-0000-4000-8000-000000000001'),
    'accepted / true');

  PERFORM _lr_rec(18, 'and the driver_notes row names the driver a PERSON chose',
    (SELECT driver_id::text || ' / ' || note_planning_behavior FROM driver_notes WHERE id = v_note),
    '1a000000-0000-4000-8000-000000000001 / must_include_in_plan');
END $$;

-- ─── 6. the reject counts and writes no submission ─────────────────────────

DO $$
DECLARE v_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _lr_as(v_admin);

  -- lr-2 has exactly one note waiting and no Beleg.
  PERFORM _lr_rec(19, 'rejecting a proposal reports what it strands',
    _lr_call($q$SELECT partner_driver_link_reject('1b000000-0000-4000-8000-000000000002') ->> 'stranded'$q$),
    '1');

  PERFORM _lr_rec(20, 'and cannot be rejected twice',
    _lr_call($q$SELECT partner_driver_link_reject('1b000000-0000-4000-8000-000000000002')::text$q$),
    'ERR P0001 already_decided');
  PERFORM _lr_reset();

  PERFORM _lr_rec(21, 'the proposal is rejected',
    (SELECT status FROM partner_driver_links WHERE id = '1b000000-0000-4000-8000-000000000002'),
    'rejected');

  -- The decision the header argues for: the submission is untouched, so no
  -- sentence nobody wrote reaches the driver.
  PERFORM _lr_rec(22, 'its stranded submission is still pending and still has no driver',
    (SELECT status || ' / ' || coalesce(driver_id::text, 'null') || ' / '
            || coalesce(rejected_reason, 'no reason')
       FROM partner_note_submissions WHERE id = '1c000000-0000-4000-8000-000000000002'),
    'pending / null / no reason');
END $$;

-- ─── 7. the shape, read from the catalogue ─────────────────────────────────

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_driver_links'
     AND cmd IN ('INSERT', 'DELETE');
  PERFORM _lr_rec(23, 'the links table has no INSERT and no DELETE policy',
    v_n::text, '0');

  PERFORM _lr_rec(24, 'neither decision is executable by anon',
    (has_function_privilege('anon', 'public.partner_driver_link_confirm(uuid,uuid)', 'EXECUTE')::int
     + has_function_privilege('anon', 'public.partner_driver_link_reject(uuid)', 'EXECUTE')::int)::text,
    '0');

  -- The rule the owner's decision rests on, read from the body rather than
  -- trusted: no name is compared anywhere in a link decision.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('partner_driver_link_confirm', 'partner_driver_link_reject')
     AND (p.prosrc LIKE '%proposed_name%' OR p.prosrc LIKE '%similarity(%'
          OR p.prosrc LIKE '%levenshtein(%' OR p.prosrc LIKE '%ILIKE%');
  PERFORM _lr_rec(25, 'and no link decision reads or compares a name',
    v_n::text, '0');
END $$;

-- ─── the verdict ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad int;
  v_all int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT matched), count(*) INTO v_bad, v_all FROM _lr_out;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'partner link review: % of % probe(s) did not match — read the XX lines above', v_bad, v_all;
  END IF;
  RAISE NOTICE '── partner link review: all % probes matched ──', v_all;
END $$;

ROLLBACK;
