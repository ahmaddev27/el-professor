-- ════════════════════════════════════════════════════════════════════════════
--  M3 — what the note intake does, measured rather than asserted in a comment
-- ════════════════════════════════════════════════════════════════════════════
--
--  `20261007110000`'s three functions. The matrix says who may call them; this
--  file says what they do, which is the half a principal grid cannot see.
--
--  Since 13.10.2026 there is no review: a note from a linked driver is a
--  driver_notes row the moment it arrives (20261013100000), and one from a
--  driver nobody has linked is recorded and waits for the link. Section 5
--  measures that. The review functions (partner_note_accept and
--  partner_note_reject) were dropped by 20261013110000; section 6 asserts they
--  stay gone, and the probes that exercised them retired with them. Probe
--  numbers are not reused, so a gap is a probe that retired.
--
--  Nine sections, and the ones worth reading first are 1, 4, 5 and 9:
--
--    1. The door admits TEN note types by an allow-list. Since 13.10.2026 that
--       includes `sick`, `vacation` and `off` (the owner reversed his decision
--       of 06.10.2026 after being told what it means; 20261013120000 records
--       it), and probes 1 to 3 assert that they cross AND derive
--       exclude_from_plan, which is why they were turned round rather than
--       deleted: a removal nobody asserts comes back the next time someone
--       copies an old migration. A deny-list would still pass `krank`, a typo,
--       or any type a later release adds -- probe 4 is that case, and it is the
--       one that makes the difference between the two shapes visible.
--    4. A retry returns the DECISION a human already made. This is the property
--       `ON CONFLICT DO NOTHING` buys and `DO UPDATE` would destroy, and it is
--       invisible in any test that submits each id once.
--    5. The arrival DERIVES the planning behaviour from the type. Taking the
--       partner's word for it is how a `sick` note carrying `neutral` reaches
--       the planner and fails to exclude the driver -- the defect the pairing
--       function exists to prevent.
--    9. A note about the road names the vehicle. Required for the five types
--       that derive must_include_in_plan and for no other; an unresolved plate
--       still records the note, with car_id NULL and the plate kept on the
--       submission row, because there is no review step left to repair it.
--
--  Collect-then-raise, like driver-deletion.sql: one run answers everything
--  instead of stopping at the first surprise. The file writes, so it is wrapped
--  in BEGIN/ROLLBACK and the files after it see only the migrations and seeds.

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

/*
  Run one statement and report what came back: the scalar it returned, or
  `ERR <sqlstate> <hint>`. The HINT rather than the message, because the hints
  are the stable codes -- the messages are German prose a release may reword.
*/
CREATE OR REPLACE FUNCTION _pn_call(p_sql text) RETURNS text
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

CREATE TEMP TABLE _pn_out (
  n        integer PRIMARY KEY,
  label    text    NOT NULL,
  actual   text    NOT NULL,
  expected text    NOT NULL,
  matched  boolean NOT NULL
);

-- Sections 5 to 7 record their probes while the session role is `authenticated`
-- -- the accept and the reject have to be called as a principal, or they would
-- measure the owner's RLS bypass instead of the gate. The recorder writes to
-- this table, so that role needs to reach it. Granting here is better than
-- making `_pn_rec` a definer: the statement under test stays SECURITY INVOKER
-- either way, and a definer recorder would be one more thing to reason about.
GRANT SELECT, INSERT ON _pn_out TO authenticated;

CREATE OR REPLACE FUNCTION _pn_rec(p_n integer, p_label text, p_actual text, p_expected text,
                                   p_like boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  v_ok := CASE WHEN p_like THEN p_actual LIKE p_expected ELSE p_actual = p_expected END;
  INSERT INTO _pn_out VALUES (p_n, p_label, p_actual, p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', p_actual;
  END IF;
END;
$$;

-- The claim shape every other file in the kit sends, including the `amr` that
-- 20260919130000 expects. Nothing here is platform staff.
-- ─── fixtures ───────────────────────────────────────────────────────────────

INSERT INTO drivers (id, company_id, name) VALUES
  ('ba000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'Linked Partner Driver'),
  ('ba000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000a', 'Other Driver');

-- One confirmed link, and deliberately no link for the external id `pn-unknown`:
-- section 3 needs both, because "the driver is resolved from our own link" is
-- only a claim until the unlinked case is shown to leave driver_id NULL.
INSERT INTO partner_driver_links
       (id, company_id, partner, external_driver_id, driver_id, status, linked_at)
VALUES ('ba100000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', 'pn-linked', 'ba000000-0000-4000-8000-000000000001', 'linked', now());

-- Cars for section 9. `kennzeichen` is globally UNIQUE, so the two cars that
-- share a KEY (the ambiguity probe) differ in their spelling, and the car of
-- the other company carries a plate no car of company A has.
INSERT INTO cars (id, company_id, kennzeichen, created_by) VALUES
  ('ba200000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'B-PN 1001', 'a0000000-0000-4000-8000-000000000001'),
  ('ba200000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000a', 'B-PN 2002', 'a0000000-0000-4000-8000-000000000001'),
  ('ba200000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-00000000000a', 'B PN-2002', 'a0000000-0000-4000-8000-000000000001'),
  ('ba200000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-00000000000b', 'B-PN 3003', 'b0000000-0000-4000-8000-000000000001');

-- ─── 1. the allow-list: all ten cross, and nothing else does ────────────────
-- The three absence types were refused until 13.10.2026 (health data, Art. 9
-- GDPR, the owner's decision of 06.10.2026) and cross now by his reversal. Each
-- must be admitted AND derive exclude_from_plan -- the behaviour is the
-- owner's reason for wanting them, and it comes from the type, not the request.
-- Probe 4 is the one that distinguishes an allow-list from a deny-list:
-- `krank` is not on either list, and only an allow-list refuses it.

DO $$
DECLARE
  v_co constant text := 'c0000000-0000-4000-8000-00000000000a';
  v_status text;
BEGIN
  -- Two statements: a subquery in the same SELECT as the call would read the
  -- snapshot from before the call wrote the note.
  v_status := _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-s1', 'pn-linked', 'sick') ->> 'status'$q$, v_co));
  PERFORM _pn_rec(1, 'a sick note crosses, arrives accepted and excludes the driver',
    v_status || ' / ' || coalesce((SELECT n.note_planning_behavior FROM partner_note_submissions s
                              JOIN driver_notes n ON n.id = s.driver_note_id
                             WHERE s.company_id = v_co::uuid AND s.external_submission_id = 'pn-s1'), 'no note'),
    'accepted / exclude_from_plan');

  -- Two statements: a subquery in the same SELECT as the call would read the
  -- snapshot from before the call wrote the note.
  v_status := _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-s2', 'pn-linked', 'vacation') ->> 'status'$q$, v_co));
  PERFORM _pn_rec(2, 'and a vacation note',
    v_status || ' / ' || coalesce((SELECT n.note_planning_behavior FROM partner_note_submissions s
                              JOIN driver_notes n ON n.id = s.driver_note_id
                             WHERE s.company_id = v_co::uuid AND s.external_submission_id = 'pn-s2'), 'no note'),
    'accepted / exclude_from_plan');

  -- Two statements: a subquery in the same SELECT as the call would read the
  -- snapshot from before the call wrote the note.
  v_status := _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-s3', 'pn-linked', 'off') ->> 'status'$q$, v_co));
  PERFORM _pn_rec(3, 'and an off note',
    v_status || ' / ' || coalesce((SELECT n.note_planning_behavior FROM partner_note_submissions s
                              JOIN driver_notes n ON n.id = s.driver_note_id
                             WHERE s.company_id = v_co::uuid AND s.external_submission_id = 'pn-s3'), 'no note'),
    'accepted / exclude_from_plan');

  -- The probe that tells the two shapes apart. A deny-list of the three would
  -- store this as an ordinary note.
  PERFORM _pn_rec(4, 'and a type on neither list — the allow-list''s whole point',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-s4', 'pn-linked', 'krank')::text$q$, v_co)),
    'ERR 22023 note_type_not_transferable');

  PERFORM _pn_rec(5, 'a general note from a linked driver is admitted and arrives accepted',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-ok1', 'pn-linked', 'general', 'Hallo') ->> 'status'$q$, v_co)),
    'accepted');

  PERFORM _pn_rec(6, 'and so is each of the other six',
    (SELECT count(*)::text FROM (
       SELECT _pn_call(format(
         $q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-t-%s', 'pn-linked', %L, '', NULL, NULL, false, NULL, NULL, NULL, 'B-PN 1001') ->> 'status'$q$,
         v_co, t, t)) AS r
         FROM unnest(ARRAY['other','blitzer','accident','kontrolle','breakdown','wait']) AS t
     ) x WHERE x.r = 'accepted'),
    '6');
END $$;

-- ─── 2. what the door validates that the table's CHECKs cannot ──────────────
-- The column pattern is `^\d{2}:\d{2}$`, which accepts 25:00. parseTimeMin in
-- the browser has the same gap and turns it into 1500 minutes, walking into the
-- following days. And the browser's NOTE_RANGE_DAY_CAP truncates a long range
-- silently, which is worse than refusing it.

DO $$
DECLARE
  v_co constant text := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  PERFORM _pn_rec(7, '25:00 is refused although the column''s pattern accepts it',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-v1', 'pn-linked', 'general', 'x', NULL, NULL, false, '25:00')::text$q$, v_co)),
    'ERR 22023 invalid_start_time');

  PERFORM _pn_rec(8, 'and so is a minute of 60',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-v2', 'pn-linked', 'general', 'x', NULL, NULL, false, '12:60')::text$q$, v_co)),
    'ERR 22023 invalid_start_time');

  PERFORM _pn_rec(9, 'the last minute of the day is accepted',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-v3', 'pn-linked', 'general', 'x', NULL, NULL, false, '23:59', '23:59') ->> 'status'$q$, v_co)),
    'accepted');

  PERFORM _pn_rec(10, 'an end time out of range is refused on its own',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-v4', 'pn-linked', 'general', 'x', NULL, NULL, false, '08:00', '24:00')::text$q$, v_co)),
    'ERR 22023 invalid_end_time');

  PERFORM _pn_rec(11, 'a range that ends before it starts is refused',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-v5', 'pn-linked', 'general', 'x', '2026-05-10', '2026-05-01')::text$q$, v_co)),
    'ERR 22023 invalid_range');

  PERFORM _pn_rec(12, 'a range longer than a year is REFUSED, not truncated',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-v6', 'pn-linked', 'general', 'x', '2026-01-01', '2027-01-05')::text$q$, v_co)),
    'ERR 22023 range_too_long');

  PERFORM _pn_rec(13, 'exactly 366 days is accepted, so probe 12 measured the bound',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-v7', 'pn-linked', 'general', 'x', '2026-01-01', '2027-01-02') ->> 'status'$q$, v_co)),
    'accepted');
END $$;

-- ─── 3. the driver comes from our link, never from the request ──────────────

DO $$
DECLARE
  v_co constant text := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  PERFORM _pn_rec(14, 'a confirmed link fills the driver in',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-d1', 'pn-linked', 'general', 'x') ->> 'driver_id'$q$, v_co)),
    'ba000000-0000-4000-8000-000000000001');

  PERFORM _pn_rec(15, 'an external driver nobody has linked leaves it NULL',
    _pn_call(format($q$SELECT coalesce(partner_note_submission_record(%L, 'reidey', 'pn-d2', 'pn-unknown', 'general', 'x') ->> 'driver_id', 'null')$q$, v_co)),
    'null');

  -- A link that exists but is NOT confirmed must not resolve either: `pending`
  -- is a proposal, and M2's whole point is that a person confirms it.
  INSERT INTO partner_driver_links (company_id, partner, external_driver_id, status)
  VALUES (v_co::uuid, 'reidey', 'pn-proposed', 'pending');

  PERFORM _pn_rec(16, 'and an unconfirmed proposal does not resolve either',
    _pn_call(format($q$SELECT coalesce(partner_note_submission_record(%L, 'reidey', 'pn-d3', 'pn-proposed', 'general', 'x') ->> 'driver_id', 'null')$q$, v_co)),
    'null');
END $$;

-- ─── 4. a retry returns the decision, it does not reopen it ─────────────────
-- The property ON CONFLICT DO NOTHING buys. A test that submits each id once
-- cannot see it, which is why these four probes exist.

DO $$
DECLARE
  v_co constant text := 'c0000000-0000-4000-8000-00000000000a';
  v_id uuid;
BEGIN
  PERFORM _pn_rec(17, 'the same submission id twice is not a second row',
    (SELECT count(*)::text FROM partner_note_submissions
      WHERE company_id = v_co::uuid AND external_submission_id = 'pn-ok1'),
    '1');

  PERFORM _pn_rec(18, 'and the retry says so',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-ok1', 'pn-linked', 'general', 'anderer Text') ->> 'duplicate'$q$, v_co)),
    'true');

  PERFORM _pn_rec(19, 'the retry did NOT overwrite the stored text',
    (SELECT note_text FROM partner_note_submissions
      WHERE company_id = v_co::uuid AND external_submission_id = 'pn-ok1'),
    'Hallo');

  -- The one that matters: judge it, then retry.
  SELECT id INTO v_id FROM partner_note_submissions
   WHERE company_id = v_co::uuid AND external_submission_id = 'pn-ok1';
  -- It arrived accepted, so it names its note; a rejected row may not
  -- (partner_note_submissions_accepted_has_note).
  UPDATE partner_note_submissions
     SET status = 'rejected', rejected_reason = 'mx', reviewed_at = now(),
         driver_note_id = NULL
   WHERE id = v_id;

  PERFORM _pn_rec(20, 'a retry after a human judged it returns THAT decision',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-ok1', 'pn-linked', 'general', 'x') ->> 'status'$q$, v_co)),
    'rejected');
END $$;

-- ─── 5. the arrival: derived behaviour, our name, and the unlinked driver ───

DO $$
DECLARE
  v_co    constant text := 'c0000000-0000-4000-8000-00000000000a';
  v_linked   uuid;
  v_unlinked uuid;
  v_note     uuid;
BEGIN
  -- A blitzer note, whose behaviour is must_include_in_plan. The partner never
  -- sends a behaviour and could not: the column does not exist on its side of
  -- the contract.
  PERFORM _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-a1', 'pn-linked', 'blitzer', 'Blitzer A100', NULL, NULL, false, NULL, NULL, NULL, 'B-PN 1001')::text$q$, v_co));
  SELECT id INTO v_linked FROM partner_note_submissions
   WHERE company_id = v_co::uuid AND external_submission_id = 'pn-a1';
  SELECT id INTO v_unlinked FROM partner_note_submissions
   WHERE company_id = v_co::uuid AND external_submission_id = 'pn-d2';

  -- The edge: no confirmed link means no driver_id, driver_notes.driver_id is
  -- NOT NULL, and linking is a human act. Recorded, not applied.
  PERFORM _pn_rec(21, 'a note whose driver is not linked is recorded and NOT applied',
    (SELECT status || ' / ' || coalesce(driver_note_id::text, 'no note')
       FROM partner_note_submissions WHERE id = v_unlinked),
    'pending / no note');

  PERFORM _pn_rec(22, 'a linked driver''s note is accepted on arrival, with nobody reviewing',
    (SELECT status || ' / ' || coalesce(reviewed_by::text, 'no reviewer')
       FROM partner_note_submissions WHERE id = v_linked),
    'accepted / no reviewer');

  SELECT driver_note_id INTO v_note FROM partner_note_submissions WHERE id = v_linked;

  PERFORM _pn_rec(23, 'the submission names its note',
    CASE WHEN v_note IS NULL THEN 'null' ELSE 'named' END, 'named');

  PERFORM _pn_rec(24, 'and the note carries the DERIVED behaviour, not a sent one',
    (SELECT note_planning_behavior FROM driver_notes WHERE id = v_note),
    'must_include_in_plan');

  PERFORM _pn_rec(25, 'the note is the company''s and the linked driver''s',
    (SELECT company_id::text || ' ' || driver_id::text FROM driver_notes WHERE id = v_note),
    v_co || ' ba000000-0000-4000-8000-000000000001');

  PERFORM _pn_rec(26, 'and its text is the one the driver wrote',
    (SELECT note_text FROM driver_notes WHERE id = v_note),
    'Blitzer A100');

  -- The owner's ask of 13.10.2026: the author is the driver, and it is OUR
  -- row's name. There is no user, so created_by is NULL and the CHECK that
  -- forbids an authorless note is what makes that legal.
  PERFORM _pn_rec(38, 'the author is our driver row''s name, with no user behind it',
    (SELECT coalesce(created_by::text, 'no user') || ' / ' || coalesce(submitted_by_name, 'null')
       FROM driver_notes WHERE id = v_note),
    'no user / Linked Partner Driver');

  -- A retry of an applied note must not write a second note.
  PERFORM _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-a1', 'pn-linked', 'blitzer', 'Blitzer A100', NULL, NULL, false, NULL, NULL, NULL, 'B-PN 1001')::text$q$, v_co));
  PERFORM _pn_rec(39, 'a retry of an applied note writes no second note',
    (SELECT count(*)::text FROM driver_notes
      WHERE company_id = v_co::uuid AND note_text = 'Blitzer A100'),
    '1');
END $$;

-- ─── 6. the review functions are gone ──────────────────────────────────────

DO $$
BEGIN
  -- Counted in the catalogue: has_function_privilege raises on a function that
  -- does not exist, which would turn this probe into an error.
  PERFORM _pn_rec(27, 'partner_note_accept no longer exists',
    (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'partner_note_accept'),
    '0');
  PERFORM _pn_rec(28, 'nor does partner_note_reject',
    (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'partner_note_reject'),
    '0');
END $$;

-- ─── 8. the shape, read from the catalogue ──────────────────────────────────

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_note_submissions'
     AND cmd IN ('INSERT', 'DELETE');
  PERFORM _pn_rec(35, 'the submission table has no INSERT and no DELETE policy',
    v_n::text, '0');

  PERFORM _pn_rec(36, 'the door is not executable by authenticated',
    has_function_privilege('authenticated',
      'public.partner_note_submission_record(uuid,text,text,text,text,text,date,date,boolean,text,text,jsonb,text)',
      'EXECUTE')::text,
    'false');

  PERFORM _pn_rec(37, 'and it is not executable by anon either',
    has_function_privilege('anon',
      'public.partner_note_submission_record(uuid,text,text,text,text,text,date,date,boolean,text,text,jsonb,text)',
      'EXECUTE')::text,
    'false');
END $$;

-- ─── 9. a note about the road names the vehicle ─────────────────────────────
-- Required for the five types that derive must_include_in_plan, asked of
-- note_behavior_for and not listed again; never for the others. A plate that
-- resolves to no car still records the note.

DO $$
DECLARE
  v_co constant text := 'c0000000-0000-4000-8000-00000000000a';
  v_sub uuid;
  v_note uuid;
BEGIN
  PERFORM _pn_rec(40, 'each of the five incident types is refused without a vehicle',
    (SELECT count(*)::text FROM (
       SELECT _pn_call(format(
         $q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-nv-%s', 'pn-linked', %L, 'x')::text$q$,
         v_co, t, t)) AS r
         FROM unnest(ARRAY['blitzer','accident','kontrolle','breakdown','wait']) AS t
     ) x WHERE x.r = 'ERR 22023 vehicle_required'),
    '5');

  PERFORM _pn_rec(41, 'a blank plate is no vehicle',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-nv-b', 'pn-linked', 'blitzer', 'x', NULL, NULL, false, NULL, NULL, NULL, '   ')::text$q$, v_co)),
    'ERR 22023 vehicle_required');

  PERFORM _pn_rec(42, 'and neither is the word null',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-nv-n', 'pn-linked', 'accident', 'x', NULL, NULL, false, NULL, NULL, NULL, 'null')::text$q$, v_co)),
    'ERR 22023 vehicle_required');

  PERFORM _pn_rec(43, 'a refused incident note left no submission behind',
    (SELECT count(*)::text FROM partner_note_submissions
      WHERE company_id = v_co::uuid AND external_submission_id LIKE 'pn-nv-%'),
    '0');

  -- The other half of "only for those types": a sickness note names no car and
  -- must not be refused for it.
  PERFORM _pn_rec(44, 'general, other, sick, vacation and off are admitted with no vehicle at all',
    (SELECT count(*)::text FROM (
       SELECT _pn_call(format(
         $q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-nov-%s', 'pn-linked', %L) ->> 'status'$q$,
         v_co, t, t)) AS r
         FROM unnest(ARRAY['general','other','sick','vacation','off']) AS t
     ) x WHERE x.r = 'accepted'),
    '5');

  -- Resolution: a different spelling of the car's plate finds the car.
  PERFORM _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-v-ok', 'pn-linked', 'kontrolle', 'Polizeikontrolle', NULL, NULL, false, NULL, NULL, NULL, 'b pn1001')::text$q$, v_co));
  SELECT s.id, s.driver_note_id INTO v_sub, v_note FROM partner_note_submissions s
   WHERE s.company_id = v_co::uuid AND s.external_submission_id = 'pn-v-ok';
  PERFORM _pn_rec(45, 'the plate is resolved to our car whatever its spelling',
    coalesce((SELECT car_id::text FROM driver_notes WHERE id = v_note), 'no note'),
    'ba200000-0000-4000-8000-000000000001');
  PERFORM _pn_rec(46, 'and the submission keeps the plate exactly as it arrived',
    (SELECT vehicle_plate FROM partner_note_submissions WHERE id = v_sub),
    'b pn1001');

  -- Not resolved: the note is still recorded. Four ways to miss.
  PERFORM _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-v-unk', 'pn-linked', 'accident', 'Unfall', NULL, NULL, false, NULL, NULL, NULL, 'B-ZZ 9999')::text$q$, v_co));
  PERFORM _pn_rec(47, 'an unknown plate still records the note, accepted, with car_id NULL',
    (SELECT s.status || ' / ' || coalesce(n.car_id::text, 'no car') || ' / ' || s.vehicle_plate
       FROM partner_note_submissions s LEFT JOIN driver_notes n ON n.id = s.driver_note_id
      WHERE s.company_id = v_co::uuid AND s.external_submission_id = 'pn-v-unk'),
    'accepted / no car / B-ZZ 9999');

  PERFORM _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-v-oth', 'pn-linked', 'blitzer', 'x', NULL, NULL, false, NULL, NULL, NULL, 'B-PN 3003')::text$q$, v_co));
  PERFORM _pn_rec(48, 'another company''s car is never matched, and the note is kept',
    (SELECT s.status || ' / ' || coalesce(n.car_id::text, 'no car')
       FROM partner_note_submissions s LEFT JOIN driver_notes n ON n.id = s.driver_note_id
      WHERE s.company_id = v_co::uuid AND s.external_submission_id = 'pn-v-oth'),
    'accepted / no car');

  PERFORM _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-v-amb', 'pn-linked', 'wait', 'x', NULL, NULL, false, NULL, NULL, NULL, 'bpn2002')::text$q$, v_co));
  PERFORM _pn_rec(49, 'two cars with one key are ambiguous: no guess, note kept',
    (SELECT s.status || ' / ' || coalesce(n.car_id::text, 'no car')
       FROM partner_note_submissions s LEFT JOIN driver_notes n ON n.id = s.driver_note_id
      WHERE s.company_id = v_co::uuid AND s.external_submission_id = 'pn-v-amb'),
    'accepted / no car');

  -- The browser's matcher also accepts a plate that merely CONTAINS another.
  -- Here the keys must be equal.
  PERFORM _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-v-sub', 'pn-linked', 'breakdown', 'x', NULL, NULL, false, NULL, NULL, NULL, 'B-PN 100')::text$q$, v_co));
  PERFORM _pn_rec(50, 'a prefix of a plate is not that plate',
    (SELECT s.status || ' / ' || coalesce(n.car_id::text, 'no car')
       FROM partner_note_submissions s LEFT JOIN driver_notes n ON n.id = s.driver_note_id
      WHERE s.company_id = v_co::uuid AND s.external_submission_id = 'pn-v-sub'),
    'accepted / no car');

  PERFORM _pn_rec(51, 'a plate longer than 32 characters is refused with its own reason',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-v-long', 'pn-linked', 'general', 'x', NULL, NULL, false, NULL, NULL, NULL, %L)::text$q$, v_co, repeat('A', 33))),
    'ERR 22023 invalid_vehicle_plate');

  -- The deferred path: the driver is not linked at arrival, so nothing is
  -- applied and the plate waits on the submission. When the link arrives the
  -- apply resolves it -- the same function partner_submission_claim_driver
  -- calls.
  PERFORM _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-v-wait', 'pn-unknown', 'blitzer', 'Radar', NULL, NULL, false, NULL, NULL, NULL, 'B-PN 1001')::text$q$, v_co));
  SELECT id INTO v_sub FROM partner_note_submissions
   WHERE company_id = v_co::uuid AND external_submission_id = 'pn-v-wait';
  PERFORM _pn_rec(52, 'an unlinked driver''s incident note waits with its plate kept',
    (SELECT status || ' / ' || coalesce(driver_note_id::text, 'no note') || ' / ' || vehicle_plate
       FROM partner_note_submissions WHERE id = v_sub),
    'pending / no note / B-PN 1001');
  UPDATE partner_note_submissions SET driver_id = 'ba000000-0000-4000-8000-000000000002' WHERE id = v_sub;
  PERFORM app_private.partner_note_apply(v_sub);
  PERFORM _pn_rec(53, 'and once linked, the apply resolves it to the car',
    (SELECT coalesce(n.car_id::text, 'no car') FROM partner_note_submissions s
       JOIN driver_notes n ON n.id = s.driver_note_id WHERE s.id = v_sub),
    'ba200000-0000-4000-8000-000000000001');

  -- The safety property of 20260928120000, restated where this path writes it.
  PERFORM _pn_rec(54, 'no driver_notes policy mentions car_id',
    (SELECT count(*)::text FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'driver_notes'
        AND (coalesce(qual, '') LIKE '%car_id%' OR coalesce(with_check, '') LIKE '%car_id%')),
    '0');
END $$;

-- ─── the verdict ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad int;
  v_all int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT matched), count(*) INTO v_bad, v_all FROM _pn_out;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'partner note intake: % of % probe(s) did not match — read the XX lines above', v_bad, v_all;
  END IF;
  RAISE NOTICE '── partner note intake: all % probes matched ──', v_all;
END $$;

ROLLBACK;
