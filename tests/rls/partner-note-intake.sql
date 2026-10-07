-- ════════════════════════════════════════════════════════════════════════════
--  M3 — what the note intake does, measured rather than asserted in a comment
-- ════════════════════════════════════════════════════════════════════════════
--
--  `20261007110000`'s three functions. The matrix says who may call them; this
--  file says what they do, which is the half a principal grid cannot see.
--
--  Eight sections, and the ones worth reading first are 1, 4 and 5:
--
--    1. The door admits SEVEN note types and refuses the other three by an
--       allow-list. A deny-list would pass `krank`, a typo, or any type a later
--       release adds -- probe 4 is that case, and it is the one that makes the
--       difference between the two shapes visible.
--    4. A retry returns the DECISION a human already made. This is the property
--       `ON CONFLICT DO NOTHING` buys and `DO UPDATE` would destroy, and it is
--       invisible in any test that submits each id once.
--    5. The accept DERIVES the planning behaviour from the type. Taking the
--       partner's word for it is how a `sick` note carrying `neutral` reaches
--       the planner and fails to exclude the driver -- the defect the pairing
--       function exists to prevent.
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
CREATE OR REPLACE FUNCTION _pn_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE OR REPLACE FUNCTION _pn_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

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

-- ─── 1. the allow-list: seven cross, three do not, and nothing else does ────
-- The three refused types are health and absence data (Art. 9 GDPR) and leave
-- the transfer by the owner's decision of 06.10.2026. Probe 4 is the one that
-- distinguishes an allow-list from a deny-list: `krank` is not on either list,
-- and only an allow-list refuses it.

DO $$
DECLARE
  v_co constant text := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  PERFORM _pn_rec(1, 'the door refuses a sick note',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-s1', 'pn-linked', 'sick')::text$q$, v_co)),
    'ERR 22023 note_type_not_transferable');

  PERFORM _pn_rec(2, 'and a vacation note',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-s2', 'pn-linked', 'vacation')::text$q$, v_co)),
    'ERR 22023 note_type_not_transferable');

  PERFORM _pn_rec(3, 'and an off note',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-s3', 'pn-linked', 'off')::text$q$, v_co)),
    'ERR 22023 note_type_not_transferable');

  -- The probe that tells the two shapes apart. A deny-list of the three would
  -- store this as an ordinary note.
  PERFORM _pn_rec(4, 'and a type on neither list — the allow-list''s whole point',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-s4', 'pn-linked', 'krank')::text$q$, v_co)),
    'ERR 22023 note_type_not_transferable');

  PERFORM _pn_rec(5, 'a general note is admitted and arrives pending',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-ok1', 'pn-linked', 'general', 'Hallo') ->> 'status'$q$, v_co)),
    'pending');

  PERFORM _pn_rec(6, 'and so is each of the other six',
    (SELECT count(*)::text FROM (
       SELECT _pn_call(format(
         $q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-t-%s', 'pn-linked', %L) ->> 'status'$q$,
         v_co, t, t)) AS r
         FROM unnest(ARRAY['other','blitzer','accident','kontrolle','breakdown','wait']) AS t
     ) x WHERE x.r = 'pending'),
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
    'pending');

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
    'pending');
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
  UPDATE partner_note_submissions
     SET status = 'rejected', rejected_reason = 'mx', reviewed_at = now()
   WHERE id = v_id;

  PERFORM _pn_rec(20, 'a retry after a human judged it returns THAT decision',
    _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-ok1', 'pn-linked', 'general', 'x') ->> 'status'$q$, v_co)),
    'rejected');
END $$;

-- ─── 5. the accept: the derived behaviour, and the unlinked driver ──────────

DO $$
DECLARE
  v_co    constant text := 'c0000000-0000-4000-8000-00000000000a';
  v_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_linked   uuid;
  v_unlinked uuid;
  v_note     uuid;
BEGIN
  -- A blitzer note, whose behaviour is must_include_in_plan. The partner never
  -- sends a behaviour and could not: the column does not exist on its side of
  -- the contract.
  PERFORM _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-a1', 'pn-linked', 'blitzer', 'Blitzer A100')::text$q$, v_co));
  SELECT id INTO v_linked FROM partner_note_submissions
   WHERE company_id = v_co::uuid AND external_submission_id = 'pn-a1';
  SELECT id INTO v_unlinked FROM partner_note_submissions
   WHERE company_id = v_co::uuid AND external_submission_id = 'pn-d2';

  PERFORM _pn_as(v_admin);

  PERFORM _pn_rec(21, 'a submission whose driver is not linked cannot be accepted',
    _pn_call(format($q$SELECT partner_note_accept(%L)::text$q$, v_unlinked)),
    'ERR P0001 driver_not_linked');

  PERFORM _pn_rec(22, 'and the accept of a linked one succeeds',
    _pn_call(format($q$SELECT partner_note_accept(%L) ->> 'ok'$q$, v_linked)),
    'true');

  PERFORM _pn_reset();

  SELECT driver_note_id INTO v_note FROM partner_note_submissions WHERE id = v_linked;

  PERFORM _pn_rec(23, 'the submission now names its note',
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

  PERFORM _pn_as(v_admin);
  PERFORM _pn_rec(27, 'accepting it a second time is refused',
    _pn_call(format($q$SELECT partner_note_accept(%L)::text$q$, v_linked)),
    'ERR P0001 already_reviewed');
  PERFORM _pn_reset();
END $$;

-- ─── 6. the reject ──────────────────────────────────────────────────────────

DO $$
DECLARE
  v_co    constant text := 'c0000000-0000-4000-8000-00000000000a';
  v_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_id uuid;
BEGIN
  PERFORM _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-r1', 'pn-linked', 'wait', 'Wartezeit')::text$q$, v_co));
  SELECT id INTO v_id FROM partner_note_submissions
   WHERE company_id = v_co::uuid AND external_submission_id = 'pn-r1';

  PERFORM _pn_as(v_admin);

  -- Named here rather than left to the table's CHECK, so the screen can say
  -- which field is missing instead of reporting a 23514.
  PERFORM _pn_rec(28, 'a rejection with no reason is refused by name',
    _pn_call(format($q$SELECT partner_note_reject(%L, '   ')::text$q$, v_id)),
    'ERR 22023 reason_required');

  PERFORM _pn_rec(29, 'with a reason it is rejected',
    _pn_call(format($q$SELECT partner_note_reject(%L, 'Beleg fehlt') ->> 'ok'$q$, v_id)),
    'true');

  PERFORM _pn_reset();

  PERFORM _pn_rec(30, 'and the reason is stored for the driver to be told',
    (SELECT status || ' / ' || rejected_reason FROM partner_note_submissions WHERE id = v_id),
    'rejected / Beleg fehlt');

  PERFORM _pn_rec(31, 'a rejection writes no driver_notes row',
    (SELECT coalesce(driver_note_id::text, 'null') FROM partner_note_submissions WHERE id = v_id),
    'null');
END $$;

-- ─── 7. the role gate, which the definer has to ask itself ──────────────────
-- Running past RLS means running past the role gate, so each function asks
-- current_role_permits('notes', true). A viewer holds can_edit nowhere.

DO $$
DECLARE
  v_co     constant text := 'c0000000-0000-4000-8000-00000000000a';
  v_viewer constant uuid := 'a0000000-0000-4000-8000-000000000003';
  v_editor constant uuid := 'a0000000-0000-4000-8000-000000000002';
  v_id uuid;
BEGIN
  PERFORM _pn_call(format($q$SELECT partner_note_submission_record(%L, 'reidey', 'pn-g1', 'pn-linked', 'general', 'x')::text$q$, v_co));
  SELECT id INTO v_id FROM partner_note_submissions
   WHERE company_id = v_co::uuid AND external_submission_id = 'pn-g1';

  PERFORM _pn_as(v_viewer);
  PERFORM _pn_rec(32, 'a viewer may not accept',
    _pn_call(format($q$SELECT partner_note_accept(%L)::text$q$, v_id)),
    'ERR 42501 not_authorized');
  PERFORM _pn_rec(33, 'nor reject',
    _pn_call(format($q$SELECT partner_note_reject(%L, 'x')::text$q$, v_id)),
    'ERR 42501 not_authorized');
  PERFORM _pn_reset();

  -- The control: without it probe 32 would pass for a fixture that is simply
  -- unacceptable to everyone.
  PERFORM _pn_as(v_editor);
  PERFORM _pn_rec(34, 'an editor, who holds the notes page, may',
    _pn_call(format($q$SELECT partner_note_accept(%L) ->> 'ok'$q$, v_id)),
    'true');
  PERFORM _pn_reset();
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
      'public.partner_note_submission_record(uuid,text,text,text,text,text,date,date,boolean,text,text,jsonb)',
      'EXECUTE')::text,
    'false');

  PERFORM _pn_rec(37, 'and none of the three is executable by anon',
    (has_function_privilege('anon', 'public.partner_note_accept(uuid)', 'EXECUTE')::int
     + has_function_privilege('anon', 'public.partner_note_reject(uuid,text)', 'EXECUTE')::int
     + has_function_privilege('anon',
         'public.partner_note_submission_record(uuid,text,text,text,text,text,date,date,boolean,text,text,jsonb)',
         'EXECUTE')::int)::text,
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
