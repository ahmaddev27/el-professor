/*
  Deleting a driver: what it destroys, and what refuses to let it happen.

  M0 of the Reidey integration needs an erasure rule, and the rule cannot be
  written on readings. Four of the five facts below were inferences that had
  never been executed, and this file is what executes them.

  WHY IT MATTERS, and it is not the Reidey integration's problem alone. The
  Fahrer screen's trash button is a bare `supabase.from('drivers').delete()`
  with no confirmation step (`src/hooks/useDatabase.ts`), and the foreign keys
  carry that delete into `salaries`, `salary_payments`, `salary_cash_receipts`
  and `saved_stundennachweise` -- the Gehaltsquittungen and the stored
  Stundennachweise, which are the records a German fleet is least able to lose.
  Section 1 records that, so a migration that changes it has to say so.

  AND IT DOES NOT ERASE. Driver names survive in `receipts.driver_name`,
  `income.driver_name`, `fahrtenbuch_trips.assigned_driver_name`, the planning
  JSON and every storage object, because those carry no foreign key. Section 1
  records that too: an erasure rule built on the cascade alone would leave the
  name behind in six places.

  THE FOUR READINGS. Each was a column with `ON DELETE SET NULL` expected to sit
  under a constraint or a trigger that refuses the resulting UPDATE, so the
  delete would fail rather than the row being orphaned. Three were right, one
  was right only once a migration fixed the schema it had assumed:

    2. `fahrtenbuch_trips.original_driver_id` -- SET NULL against
       `protect_fahrtenbuch_immutable_fields`, which lists that column. On
       staging 13,959 of 13,981 trips carry it, so this is the normal case and
       not an edge: a real driver is probably undeletable today.
    3. `partner_driver_links.driver_id` -- SET NULL against
       `partner_driver_links_linked_has_driver`.
    4. `partner_note_submissions.driver_note_id` -- which did NOT refuse when
       this file was written, because the column carried no foreign key at
       all. The reading was right about the mechanism and wrong about the
       schema, and it was wrong in the dangerous direction: the delete
       succeeded and left the accepted submission pointing at a deleted
       note. `20261007100000` added the missing key, so it refuses now like
       its sibling, and probes 9 to 12 and 14 moved with it. Both sides of
       that cell are in section 4, because a cell that moves silently is how
       a gate stops gating.
    5. `partner_receipt_submissions.receipt_id` -- SET NULL against
       `partner_receipt_submissions_accepted_has_receipt`. This one refuses
       deleting the BELEG rather than the driver, and it was not in the list I
       set out to test; the constraint names turned it up while reading.

  HOW IT REPORTS. Every probe writes its outcome to a temp table and the
  assertions run at the end, together, so one run answers all five questions
  even when several are wrong. The kit aborts at the first failing file, so a
  file that asserted five readings one at a time would hide four of them and
  stop every file sorting after it.

  Each probe uses a driver of its own, so no probe needs the previous one's
  state rolled back. Runs inside BEGIN ... ROLLBACK, so the files after it see
  only the migrations and the seeds.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _dd_try(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERR ' || SQLSTATE || ' ' || SQLERRM;
END;
$$;

CREATE TEMP TABLE _dd_out (
  n        integer PRIMARY KEY,
  label    text    NOT NULL,
  actual   text    NOT NULL,
  expected text    NOT NULL,
  matched  boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _dd_rec(p_n integer, p_label text, p_actual text, p_expected text,
                                   p_like boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  v_ok := CASE WHEN p_like THEN p_actual LIKE p_expected ELSE p_actual = p_expected END;
  INSERT INTO _dd_out VALUES (p_n, p_label, p_actual, p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', p_actual;
  END IF;
END;
$$;

-- ─── fixtures: one driver per probe, all in company A ───────────────────────

INSERT INTO drivers (id, company_id, name) VALUES
  ('dd000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'Cascade Driver'),
  ('dd000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000a', 'Trip Driver'),
  ('dd000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-00000000000a', 'Linked Driver'),
  ('dd000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-00000000000a', 'Note Driver');

-- ─── 1. what the cascade destroys, and what it leaves behind ────────────────
-- Recorded, not endorsed: this is today's behaviour and it is the defect M0
-- names. A migration that changes it must change this section in the same
-- commit and say why.

INSERT INTO salaries (id, driver_id, period_start, period_end, created_by, company_id)
VALUES ('dd100000-0000-4000-8000-000000000001', 'dd000000-0000-4000-8000-000000000001',
        '2026-01-01', '2026-01-31', 'a0000000-0000-4000-8000-000000000001',
        'c0000000-0000-4000-8000-00000000000a');

INSERT INTO driver_notes (id, created_by, driver_id, note_text, company_id)
VALUES ('dd200000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
        'dd000000-0000-4000-8000-000000000001', 'dd cascade', 'c0000000-0000-4000-8000-00000000000a');

-- A name with no foreign key behind it: the thing the cascade cannot reach.
INSERT INTO receipts (id, receipt_number, date, description, driver_name, company_id)
VALUES ('dd300000-0000-4000-8000-000000000001', 'BEL-DD-1', current_date, 'dd',
        'Cascade Driver', 'c0000000-0000-4000-8000-00000000000a');

DO $$
DECLARE v_res text;
BEGIN
  v_res := _dd_try($q$DELETE FROM drivers WHERE id = 'dd000000-0000-4000-8000-000000000001'$q$);
  PERFORM _dd_rec(1, 'a driver with only a salary and a note deletes', v_res, 'ok');

  IF v_res = 'ok' THEN
    PERFORM _dd_rec(2, 'and its salary is gone with it (CASCADE)',
      (SELECT count(*)::text FROM salaries WHERE id = 'dd100000-0000-4000-8000-000000000001'), '0');
    PERFORM _dd_rec(3, 'and its note is gone with it (CASCADE)',
      (SELECT count(*)::text FROM driver_notes WHERE id = 'dd200000-0000-4000-8000-000000000001'), '0');
    PERFORM _dd_rec(4, 'but the name on a Beleg stays: no foreign key, so no erasure',
      (SELECT driver_name FROM receipts WHERE id = 'dd300000-0000-4000-8000-000000000001'),
      'Cascade Driver');
  ELSE
    PERFORM _dd_rec(2, 'cascade probe skipped: the delete itself failed', v_res, 'ok');
  END IF;
END
$$;

-- ─── 2. a trip's original_driver_id refuses the delete ──────────────────────
-- The FK is ON DELETE SET NULL, and `protect_fahrtenbuch_immutable_fields`
-- lists `original_driver_id` among the columns it refuses to see change.
-- PostgreSQL performs SET NULL as an UPDATE, which fires that BEFORE UPDATE
-- trigger. The kit's only two existing driver deletions use drivers with no
-- trips, which is why this has never been exercised.

INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by, file_sha256)
VALUES ('dd400000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 1, 2026,
        'dd.xlsx', 'a0000000-0000-4000-8000-000000000001', repeat('d', 64));

INSERT INTO fahrtenbuch_trips (id, company_id, import_id, trip_date,
                               original_driver_id, original_driver_name, assigned_driver_name)
VALUES ('dd500000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
        'dd400000-0000-4000-8000-000000000001', '2026-01-05',
        'dd000000-0000-4000-8000-000000000002', 'Trip Driver', 'Trip Driver');

DO $$
BEGIN
  PERFORM _dd_rec(5, 'a driver who is a trip''s original driver cannot be deleted',
    _dd_try($q$DELETE FROM drivers WHERE id = 'dd000000-0000-4000-8000-000000000002'$q$),
    'ERR P0001 fahrtenbuch_trips: immutable fields cannot be modified after insert.%', true);

  PERFORM _dd_rec(6, 'and the driver is still there',
    (SELECT count(*)::text FROM drivers WHERE id = 'dd000000-0000-4000-8000-000000000002'), '1');
END
$$;

-- ─── 3. a confirmed Reidey link refuses the delete ──────────────────────────

INSERT INTO partner_driver_links (id, company_id, partner, external_driver_id, driver_id, status)
VALUES ('dd600000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', '4711', 'dd000000-0000-4000-8000-000000000003', 'linked');

DO $$
BEGIN
  PERFORM _dd_rec(7, 'a driver behind a confirmed partner link cannot be deleted',
    _dd_try($q$DELETE FROM drivers WHERE id = 'dd000000-0000-4000-8000-000000000003'$q$),
    'ERR 23514 %partner_driver_links_linked_has_driver%', true);

  PERFORM _dd_rec(8, 'and the link still names its driver',
    (SELECT driver_id::text FROM partner_driver_links WHERE id = 'dd600000-0000-4000-8000-000000000001'),
    'dd000000-0000-4000-8000-000000000003');
END
$$;

-- ───────── 4. an accepted note submission refuses the delete, since 20261007100000
-- THE CELL MOVED, and this file records both sides of it.
--
-- MEASURED 06.10.2026, when this file was written: the delete SUCCEEDED. I
-- had expected the refusal and asserted it; the kit refused the expectation.
-- `partner_note_submissions.driver_note_id` carried NO FOREIGN KEY while its
-- sibling `partner_receipt_submissions.receipt_id` carried one, so nothing
-- fired: the note cascaded away and the submission was left `accepted`
-- pointing at a row that no longer existed. The CHECK cannot catch that,
-- because a dangling uuid is still non-null.
--
-- `20261007100000` adds the missing key with the same `ON DELETE SET NULL`,
-- so the behaviour is now what section 5 has always done for receipts, and
-- probe 14 flipped with it. The original reading was right about the
-- mechanism and wrong about the schema.
--
-- The chain is one step longer than the others: `driver_notes.driver_id` is
-- CASCADE, so deleting the driver deletes the note, which SET NULLs the
-- submission's `driver_note_id` while its status is still 'accepted', and
-- the CHECK then refuses the whole delete.

INSERT INTO driver_notes (id, created_by, driver_id, note_text, company_id)
VALUES ('dd200000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
        'dd000000-0000-4000-8000-000000000004', 'dd accepted', 'c0000000-0000-4000-8000-00000000000a');

INSERT INTO partner_note_submissions (id, company_id, partner, external_submission_id,
                                      external_driver_id, driver_id, note_type, note_text,
                                      status, driver_note_id)
VALUES ('dd700000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', 'a1b2c3d4-0000-4000-8000-000000000001', '4712',
        'dd000000-0000-4000-8000-000000000004', 'general', 'dd', 'accepted',
        'dd200000-0000-4000-8000-000000000002');

DO $$
BEGIN
  PERFORM _dd_rec(9, 'a driver whose note backs an accepted submission cannot be deleted',
    _dd_try($q$DELETE FROM drivers WHERE id = 'dd000000-0000-4000-8000-000000000004'$q$),
    'ERR 23514 %partner_note_submissions_accepted_has_note%', true);

  PERFORM _dd_rec(10, 'so the driver is still there',
    (SELECT count(*)::text FROM drivers WHERE id = 'dd000000-0000-4000-8000-000000000004'), '1');

  PERFORM _dd_rec(11, 'and the note it depends on is still there',
    (SELECT count(*)::text FROM driver_notes WHERE id = 'dd200000-0000-4000-8000-000000000002'),
    '1');

  PERFORM _dd_rec(12, 'and the submission still names it',
    (SELECT driver_note_id::text FROM partner_note_submissions
      WHERE id = 'dd700000-0000-4000-8000-000000000001'),
    'dd200000-0000-4000-8000-000000000002');
END
$$;

-- ─── 5. an accepted receipt submission pins the Beleg ──────────────────────
-- Not a driver deletion at all: this one refuses deleting the RECEIPT. It was
-- not on the list of readings to settle; the constraint names turned it up.

INSERT INTO receipts (id, receipt_number, date, description, driver_name, company_id)
VALUES ('dd300000-0000-4000-8000-000000000002', 'BEL-DD-2', current_date, 'dd pinned',
        'Note Driver', 'c0000000-0000-4000-8000-00000000000a');

INSERT INTO partner_receipt_submissions (id, company_id, partner, external_submission_id,
                                         external_driver_id, description, status, receipt_id)
VALUES ('dd800000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', 'a1b2c3d4-0000-4000-8000-000000000002', '4713',
        'dd', 'accepted', 'dd300000-0000-4000-8000-000000000002');

DO $$
BEGIN
  PERFORM _dd_rec(13, 'a Beleg behind an accepted submission cannot be deleted',
    _dd_try($q$DELETE FROM receipts WHERE id = 'dd300000-0000-4000-8000-000000000002'$q$),
    'ERR 23514 %partner_receipt_submissions_accepted_has_receipt%', true);
END
$$;

-- ───────── 6. the two siblings agree, read out of the catalogue
-- Until 20261007100000 probe 14 expected ZERO: `driver_note_id` had no
-- foreign key while `receipt_id` had one, and that asymmetry was the whole
-- cause of section 4's old behaviour. The migration closed it, so both
-- probes expect one now, and a migration that drops either key fails here
-- rather than in a customer's data. A comment claiming the shape is not
-- evidence; these two probes are.

DO $$
DECLARE
  v_fk_count text;
BEGIN
  SELECT count(*)::text INTO v_fk_count
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'public.partner_note_submissions'::regclass
     AND c.contype = 'f' AND a.attname = 'driver_note_id';
  PERFORM _dd_rec(14, 'partner_note_submissions.driver_note_id has its foreign key', v_fk_count, '1');

  SELECT count(*)::text INTO v_fk_count
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'public.partner_receipt_submissions'::regclass
     AND c.contype = 'f' AND a.attname = 'receipt_id';
  PERFORM _dd_rec(15, 'and so does its sibling receipt_id', v_fk_count, '1');
END
$$;

-- ─── the verdict, all at once ──────────────────────────────────────────────

DO $$
DECLARE
  v_bad integer;
  r     record;
  v_msg text := '';
BEGIN
  SELECT count(*) INTO v_bad FROM _dd_out WHERE NOT matched;
  IF v_bad = 0 THEN
    RAISE NOTICE '── driver deletion: all % probes matched ──', (SELECT count(*) FROM _dd_out);
    RETURN;
  END IF;
  FOR r IN SELECT * FROM _dd_out WHERE NOT matched ORDER BY n LOOP
    v_msg := v_msg || format(E'\n  %s. %s\n     expected: %s\n     actual:   %s',
                             r.n, r.label, r.expected, r.actual);
  END LOOP;
  RAISE EXCEPTION 'driver deletion: % of % probes did not match:%',
    v_bad, (SELECT count(*) FROM _dd_out), v_msg;
END
$$;

ROLLBACK;
