/*
  Deleting a driver: what refuses it, and what is no longer destroyed by it.

  REWRITTEN 27.11.2026 for `20261127130000_driver_delete_guard.sql`. Until then
  this file RECORDED TODAY'S CASCADE, and said in its first paragraph that the
  recording was the defect: the Fahrer screen's trash button was a bare delete,
  the foreign keys carried it into `salaries`, `salary_payments`,
  `salary_cash_receipts` and `saved_stundennachweise` (the Gehaltsquittungen and
  the stored Stundennachweise, the records a German fleet is least able to
  lose), and the names on Belege, income rows and trips survived it, so nothing
  was erased and a great deal was destroyed. Probes 1 to 4 asserted exactly
  that, as characterisation, so that whoever changed it had to say so.

  The owner changed it on 27.11.2026, reversing "Fahrer werden deaktiviert,
  nicht gelöscht" of 25.10.2026: a driver is deleted only when no row of any
  kind refers to him, and a BEFORE DELETE trigger on `drivers` enforces that on
  every path (the screen, the API, the service role, the table owner), standing
  aside only once the company's own row is gone. So every probe that read
  "the delete succeeded and took the rows with it" now reads "the delete is
  refused with SQLSTATE 23503, hint `driver_has_references`, and every row is
  still there", and every probe that read "refused by a constraint two hops
  away" now reads the same guard's refusal, because the guard is the first
  thing to speak.

  WHERE THE REST WENT. `tests/rls/driver-delete-guard.sql` is the guard's own
  file: the catalogue pinned as an exact set, one probe per kind of reference,
  the gate, the check RPC, the company's own delete and the mutation controls.
  This file keeps what it was always for, the three readings that were
  inferences until executed, and records that each of them now ends in the guard
  rather than in the constraint it was written to find:

    2. `fahrtenbuch_trips.original_driver_id` -- SET NULL against
       `protect_fahrtenbuch_immutable_fields`. It refused with P0001 until the
       guard; it is refused by the guard with 23503 now and the immutability
       trigger never runs.
    3. `partner_driver_links.driver_id` -- SET NULL against
       `partner_driver_links_linked_has_driver` (23514 until the guard). A
       LINKED partner link counts as a reference by the owner's decision of
       27.11.2026.
    4. `partner_note_submissions.driver_note_id` -- the cell moved twice before
       (no key, SET NULL, then CASCADE on 23.10.2026), and the notes' own
       history is in `note-submission-delete.sql`. The driver chain it used to
       delete through (driver, note, submission) is refused at the first step.
    5. `partner_receipt_submissions.receipt_id` -- about deleting the BELEG, not
       the driver, so the guard does not touch it: probes 13 and 16 and the
       two foreign-key counts are unchanged.

  HOW IT REPORTS. Every probe writes its outcome to a temp table and the
  assertions run at the end, together, so one run answers every question even
  when several are wrong. The kit aborts at the first failing file, so a file
  that asserted readings one at a time would hide the rest and stop every file
  sorting after it.

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

-- ─── 1. what used to be destroyed is kept ───────────────────────────────────
-- WAS: "a driver with only a salary and a note deletes", and the salary and the
-- note went with him while the name on a Beleg stayed. Now the salary, the note
-- and the Beleg's name each refer to him, and the delete is refused whole.

INSERT INTO salaries (id, driver_id, period_start, period_end, created_by, company_id)
VALUES ('dd100000-0000-4000-8000-000000000001', 'dd000000-0000-4000-8000-000000000001',
        '2026-01-01', '2026-01-31', 'a0000000-0000-4000-8000-000000000001',
        'c0000000-0000-4000-8000-00000000000a');

INSERT INTO driver_notes (id, created_by, driver_id, note_text, company_id)
VALUES ('dd200000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
        'dd000000-0000-4000-8000-000000000001', 'dd cascade', 'c0000000-0000-4000-8000-00000000000a');

INSERT INTO receipts (id, receipt_number, date, description, driver_name, company_id)
VALUES ('dd300000-0000-4000-8000-000000000001', 'BEL-DD-1', current_date, 'dd',
        'Cascade Driver', 'c0000000-0000-4000-8000-00000000000a');

DO $$
DECLARE v_res text;
BEGIN
  v_res := _dd_try($q$DELETE FROM drivers WHERE id = 'dd000000-0000-4000-8000-000000000001'$q$);
  PERFORM _dd_rec(1, 'a driver with a salary, a note and his name on a Beleg is refused by the guard', v_res,
    'ERR 23503 Der Fahrer wird noch verwendet%', true);
  PERFORM _dd_rec(2, 'and his salary is still there (it used to cascade)',
    (SELECT count(*)::text FROM salaries WHERE id = 'dd100000-0000-4000-8000-000000000001'), '1');
  PERFORM _dd_rec(3, 'and his note is still there (it used to cascade)',
    (SELECT count(*)::text FROM driver_notes WHERE id = 'dd200000-0000-4000-8000-000000000001'), '1');
  PERFORM _dd_rec(4, 'and the name on the Beleg is now a reason in itself, not the thing the cascade left behind',
    (SELECT count(*)::text FROM drivers WHERE id = 'dd000000-0000-4000-8000-000000000001'), '1');
END
$$;

-- ─── 2. a trip's original_driver_id is refused by the guard, first ──────────
-- The FK is ON DELETE SET NULL, and `protect_fahrtenbuch_immutable_fields`
-- lists `original_driver_id` among the columns it refuses to see change, so
-- the delete used to fail with P0001 from the UPDATE the cascade performed.
-- The guard is a BEFORE DELETE trigger on drivers and speaks before any
-- cascade runs, so that UPDATE is never attempted: 23503 now.

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
  PERFORM _dd_rec(5, 'a driver who is a trip''s original driver cannot be deleted (23503 from the guard, was P0001)',
    _dd_try($q$DELETE FROM drivers WHERE id = 'dd000000-0000-4000-8000-000000000002'$q$),
    'ERR 23503 Der Fahrer wird noch verwendet%', true);

  PERFORM _dd_rec(6, 'and the driver is still there',
    (SELECT count(*)::text FROM drivers WHERE id = 'dd000000-0000-4000-8000-000000000002'), '1');
END
$$;

-- ─── 3. a confirmed Reidey link refuses the delete ──────────────────────────
-- WAS 23514 `partner_driver_links_linked_has_driver`, from the SET NULL the
-- delete would have performed. A linked partner link counts as a reference
-- (owner, 27.11.2026), so the guard now says so before the constraint is asked.

INSERT INTO partner_driver_links (id, company_id, partner, external_driver_id, driver_id, status)
VALUES ('dd600000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', '4711', 'dd000000-0000-4000-8000-000000000003', 'linked');

DO $$
BEGIN
  PERFORM _dd_rec(7, 'a driver behind a confirmed partner link cannot be deleted (23503 from the guard, was 23514)',
    _dd_try($q$DELETE FROM drivers WHERE id = 'dd000000-0000-4000-8000-000000000003'$q$),
    'ERR 23503 Der Fahrer wird noch verwendet%', true);

  PERFORM _dd_rec(8, 'and the link still names its driver',
    (SELECT driver_id::text FROM partner_driver_links WHERE id = 'dd600000-0000-4000-8000-000000000001'),
    'dd000000-0000-4000-8000-000000000003');
END
$$;

-- ─── 4. an accepted note submission: the chain is refused at its first step ─
-- The cell moved three times (no key; SET NULL, refusing; CASCADE since
-- 20261023160000, deleting driver, note and submission together). The cascade
-- is still how a NOTE deletes its submission (note-submission-delete.sql), but
-- a driver with a note and a submission is a driver rows refer to, so the
-- delete never starts and all three rows stay.

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
  PERFORM _dd_rec(9, 'a driver whose note backs an accepted submission is refused by the guard',
    _dd_try($q$DELETE FROM drivers WHERE id = 'dd000000-0000-4000-8000-000000000004'$q$),
    'ERR 23503 Der Fahrer wird noch verwendet%', true);

  PERFORM _dd_rec(10, 'so the driver is still there',
    (SELECT count(*)::text FROM drivers WHERE id = 'dd000000-0000-4000-8000-000000000004'), '1');

  PERFORM _dd_rec(11, 'and so is his note',
    (SELECT count(*)::text FROM driver_notes WHERE id = 'dd200000-0000-4000-8000-000000000002'), '1');

  PERFORM _dd_rec(12, 'and the submission, accepted and naming its note',
    (SELECT count(*)::text FROM partner_note_submissions
      WHERE id = 'dd700000-0000-4000-8000-000000000001' AND driver_note_id IS NOT NULL), '1');
END
$$;

-- ─── 5. an accepted receipt submission no longer pins the Beleg ────────────
-- Not a driver deletion at all: this one is about deleting the RECEIPT. It was
-- not on the list of readings to settle; the constraint names turned it up.
--
-- MOVED 23.10.2026 by `20261023150000`. This probe read `ERR 23514
-- %partner_receipt_submissions_accepted_has_receipt%` and the comment above it
-- called the refusal correct behaviour — "the submission keeps its record" —
-- which nobody had checked against what an operator is then supposed to do
-- with a mistyped Beleg. The answer was nothing: `ON DELETE SET NULL` against
-- the accepted-has-receipt CHECK made EVERY Beleg produced by an accepted
-- submission permanently undeletable, 20 of them on production. The owner
-- chose `ON DELETE CASCADE`, so the delete succeeds and the submission goes
-- with it, and he accepted that the record of the driver's submission is lost
-- with the Beleg. `tests/rls/partner-submission-delete.sql` is that change's
-- own file and reproduces the old refusal in its section 1.
--
-- The note sibling in section 4 moved the same way in `20261023160000`, the
-- other half of the same question the owner answered the same day, so probes
-- 9 to 12 flipped with it. Probes 14 and 15 below count foreign KEYS rather
-- than their actions, so both still read 1.

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
  PERFORM _dd_rec(13, 'a Beleg behind an accepted submission deletes, and the submission cascades with it',
    _dd_try($q$DELETE FROM receipts WHERE id = 'dd300000-0000-4000-8000-000000000002'$q$),
    'ok');

  PERFORM _dd_rec(16, 'so the submission row is gone rather than left accepted naming nothing',
    (SELECT count(*)::text FROM partner_receipt_submissions
      WHERE id = 'dd800000-0000-4000-8000-000000000001'),
    '0');
END
$$;

-- ───────── 6. both siblings have a foreign key, read out of the catalogue
-- Until 20261007100000 probe 14 expected ZERO: `driver_note_id` had no
-- foreign key while `receipt_id` had one, and that asymmetry was the whole
-- cause of section 4's old behaviour. The migration closed it, so both
-- probes expect one now, and a migration that drops either key fails here
-- rather than in a customer's data. A comment claiming the shape is not
-- evidence; these two probes are.
--
-- What these two probes still do NOT say is that the two keys carry the same
-- ACTION. Both are CASCADE as of `20261023150000` and `20261023160000`, and
-- the actions are deliberately not asserted HERE: they are pinned together by
-- `20261023160000`'s self-check 7, which is the one place that sorts after
-- both changes, and measured by section 0 of
-- `tests/rls/note-submission-delete.sql`. Pinning them in this file as well
-- would be a third copy of the same rule with no third reader.

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
