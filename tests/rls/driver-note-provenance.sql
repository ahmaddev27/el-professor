/*
  A driver note records where it came from, how sure anyone is, and when it
  happened as opposed to when it was typed (20261022150000).

  `driver_notes` gained thirteen columns and a BEFORE trigger: three dates
  (occurred_at, reported_at, received_at), `entry_source`, a document key pinned
  by a CHECK, a verification status with a stamped reviewer, a position, and a
  change log the trigger appends to. This file is the kit's side of that claim.
  The migration's own self-check runs the same rules on throwaway copies of the
  table, as the owner; what only this file can say is what happens through row
  level security, as the principals who really write notes.

  ## How to read a refusal

  Two refusals that share a SQLSTATE measure nothing unless something else tells
  them apart. 23514 is a CHECK and is reported with the constraint's name. 42501
  is two different things here: row-level security ("new row violates ...") and a
  missing privilege ("permission denied for function ..."), and they are reported
  as `rls` and `perm`. The distinction is not decoration: a CHECK that calls into
  app_private is refused 42501 for every note `authenticated` writes, and a probe
  that printed only `ERR 42501` would read that as the page gate doing its job.

  ## What each section says

  0. The catalogue, and the legacy row: a row that predates the migration reads
     `legacy`, with every new column empty, and stays that way when it is edited.

  1. Stamping on INSERT, as the principals who write: the author is the session
     whatever the request claims, the source is `manual`, the arrival time is the
     clock, a row cannot be born reviewed, and a person cannot pass a note off as
     the driver's. And as the writers with no session: the partner-door shape is
     `driver_app`, anything else `system`, a restore keeps what it states.

  2. Pinned on UPDATE. The Notizen screen sends `created_by` on every save; a
     colleague editing a note no longer becomes its author. A writer with no
     session may repair it.

  3. The three dates: an event is not reported before it happened, `occurred_at`
     is never derived from the window, an offset is an instant.

  4. The document key, with the cross-company refusals: the company folder, the
     note's own folder, a generated file name, five extensions. A key into
     another company's folder, into another note's, a traversal, an SVG, a URL.

  5. The position: a pair or nothing, inside the globe, NaN and the infinities
     refused, an accuracy only with a position.

  6. The verification: stamped from the session, a rejection needs its reason,
     a decision needs its reviewer, a viewer and another company's administrator
     reach nothing.

  7. A decision is of what was on the page when it was made: a change to the
     date, the place, the car, the driver, the type, the window, the document or
     the text takes it back; the planning effect and note_date do not; a change
     made together with a decision is the reviewer's own; and the screen's
     no-op save, which recomputes note_date to the minute, takes nothing back.

  8. The change log: what it names, what it keeps (structured values) and what it
     does not (any wording), that a request cannot write it, and two consequences
     recorded and not endorsed: deleting a note deletes its history, and deleting
     a car takes back the verification of the notes that name it.

  9. The partner door, as service_role: the note it writes is `driver_app`.

  10. The support-write audit's redaction, as a fact about the columns.

  11. The mutation control, run as the principals who write. Nine rules are
      broken one at a time in a subtransaction that is rolled back, and the set
      of probes that notice each is compared with the set predicted here. The
      third (M3) is the one that cannot be seen as the owner: a document-key
      CHECK that calls into app_private passes every probe the owner runs and is
      refused for every write `authenticated` makes. M6 is the one whose set is
      larger than the obvious one, and its probe says why.

  12. The premises, and the standing guard against a CHECK that needs a privilege
      the writing role does not have.

  ## What it does not claim

  Tenancy, role gates and the support-write audit as a whole (matrix.sql,
  tenant-state.sql, permission-coverage.sql and support-write-audit.sql own
  those), the type and pairing rules (note-type-constraint.sql), the partner
  door's refusals (partner-note-intake.sql), and the storage policies of the
  `documents` bucket (storage.sql). It does not read the planner: that is
  src/utils/noteProvenanceSafety.test.ts.

  Collect-then-raise: every probe is recorded and the file fails at the end, so
  one run answers everything instead of stopping at the first surprise. Runs
  inside BEGIN ... ROLLBACK, so the files after it see only the migrations and
  the seeds. Probe numbers are never reused.

  `SET dp.skip_partner = 'on'` skips section 9 and nothing else. It exists for a
  throwaway database that does not carry the partner schema and is off by
  default: in the kit its absence is what makes the door mandatory.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _dp_out (
  n        integer PRIMARY KEY,
  label    text    NOT NULL,
  actual   text    NOT NULL,
  expected text    NOT NULL,
  matched  boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _dp_rec(p_n integer, p_label text, p_actual text, p_expected text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ok boolean := p_actual IS NOT DISTINCT FROM p_expected;
BEGIN
  INSERT INTO _dp_out VALUES (p_n, p_label, coalesce(p_actual, '<null>'), p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 3), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 3), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', coalesce(p_actual, '<null>');
  END IF;
END $$;

/* 'none' for an empty list, the list otherwise. */
CREATE OR REPLACE FUNCTION _dp_list(p_items text[], p_sep text DEFAULT E'\n          ') RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN cardinality(p_items) = 0 THEN 'none' ELSE array_to_string(p_items, p_sep) END
$$;

/* The kit's principals (seed.sql), and the ids this file's rows carry. */
CREATE OR REPLACE FUNCTION _dp_id(p_name text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE p_name
    WHEN 'admin'  THEN 'a0000000-0000-4000-8000-000000000001'
    WHEN 'editor' THEN 'a0000000-0000-4000-8000-000000000002'
    WHEN 'viewer' THEN 'a0000000-0000-4000-8000-000000000003'
    WHEN 'adminb' THEN 'b0000000-0000-4000-8000-000000000001'
    WHEN 'co_a'   THEN 'c0000000-0000-4000-8000-00000000000a'
    WHEN 'co_b'   THEN 'c0000000-0000-4000-8000-00000000000b'
    WHEN 'drv_a'  THEN 'd0000000-0000-4000-8000-00000000000a'
    WHEN 'drv_a2' THEN 'd0000000-0000-4000-8000-0000000000a2'
    WHEN 'drv_b'  THEN 'd0000000-0000-4000-8000-00000000000b'
    WHEN 'plain'  THEN 'a8100000-0000-4000-8000-000000000001'  -- admin's, unverified, general
    WHEN 'ver'    THEN 'a8100000-0000-4000-8000-000000000002'  -- a blitzer, verified by the editor
    WHEN 'ver_g'  THEN 'a8100000-0000-4000-8000-000000000003'  -- a general note, verified, names car 1
    WHEN 'rej'    THEN 'a8100000-0000-4000-8000-000000000004'  -- rejected, with a reason
    WHEN 'leg'    THEN 'a8100000-0000-4000-8000-000000000005'  -- predates the migration
    WHEN 'b_note' THEN 'a8100000-0000-4000-8000-0000000000b1'  -- company B's
    WHEN 'fresh'  THEN 'a8100000-0000-4000-8000-0000000000f1'  -- the id a probe's INSERT names
    WHEN 'car_1'  THEN 'a8000000-0000-4000-8000-000000000001'
    WHEN 'car_2'  THEN 'a8000000-0000-4000-8000-000000000002'
    WHEN 'file'   THEN 'f8100000-0000-4000-8000-000000000001'
  END)::uuid
$$;

/*
  Become a principal for the rest of the current subtransaction. The plans go
  first: schema USAGE and function EXECUTE are resolved when a statement is
  planned, the owner runs every fixture, and a plan the owner cached would let
  every principal after it through (the matrix's `_mx_become` has the account).
*/
CREATE OR REPLACE FUNCTION _dp_as(p_who text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  EXECUTE 'DISCARD PLANS';
  IF p_who = 'owner' THEN
    RETURN;
  ELSIF p_who = 'service' THEN
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
  ELSE
    PERFORM set_config('request.jwt.claim.sub', _dp_id(p_who)::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.session_id', _dp_id(p_who)::text, true);
    PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION _dp_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/*
  Runs one statement as one principal in a subtransaction that is always rolled
  back, and says what happened:

      `rows N`                          a write, and how many rows it touched
      the scalar                        a SELECT, or a write with RETURNING
      `ERR <sqlstate> <constraint>`     a refusal, by the constraint's name
      `ERR <sqlstate> <hint>`           ... or by the HINT when there is none
      `ERR 42501 rls`                   row-level security refused the row
      `ERR 42501 perm`                  a privilege is missing (a function, a table)
      `ERR <sqlstate> -`                ... or bare

  A statement that begins SEQ: is several, separated by ';;', run in order in the
  same subtransaction; the last is a SELECT and is what is reported.
  A NOT NULL refusal is reported bare: PostgreSQL 18 names that constraint and 17
  does not, and a probe must not depend on which one is running.
*/
CREATE OR REPLACE FUNCTION _dp_try(p_who text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_con   text;
  v_hint  text;
  v_msg   text;
  v_parts text[];
  v_i     int;
BEGIN
  BEGIN
    PERFORM _dp_as(p_who);
    IF p_sql LIKE 'SEQ:%' THEN
      v_parts := string_to_array(substr(p_sql, 5), ';;');
      FOR v_i IN 1 .. cardinality(v_parts) - 1 LOOP
        EXECUTE v_parts[v_i];
      END LOOP;
      EXECUTE v_parts[cardinality(v_parts)] INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSIF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ009' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE,
                              v_con   = CONSTRAINT_NAME,
                              v_hint  = PG_EXCEPTION_HINT,
                              v_msg   = MESSAGE_TEXT;
      IF v_state = '23502' THEN
        v_con := NULL;
        v_hint := NULL;
      END IF;
      v_out := 'ERR ' || v_state || ' ' || coalesce(
        nullif(v_con, ''),
        nullif(v_hint, ''),
        CASE WHEN v_state = '42501' AND v_msg ~* 'row-level security' THEN 'rls'
             WHEN v_state = '42501' AND v_msg ~* 'permission denied'  THEN 'perm'
        END,
        '-');
  END;
  PERFORM _dp_reset();
  RETURN v_out;
END $$;

/* The key the browser derives: <company>/driver-notes/<note>/<file>.<ext>. */
CREATE OR REPLACE FUNCTION _dp_key(p_company uuid, p_note uuid, p_ext text DEFAULT 'pdf') RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_company::text || '/driver-notes/' || p_note::text || '/' || _dp_id('file')::text || '.' || p_ext
$$;

/* An UPDATE of one note, by id; with an expression it reports it from RETURNING. */
CREATE OR REPLACE FUNCTION _dp_upd(p_note uuid, p_set text, p_expr text DEFAULT NULL) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_expr IS NULL
    THEN format('UPDATE driver_notes SET %s WHERE id = %L', p_set, p_note)
    ELSE format('WITH u AS (UPDATE driver_notes SET %s WHERE id = %L RETURNING *) SELECT %s FROM u', p_set, p_note, p_expr)
  END
$$;

/*
  An INSERT as the Notizen screen sends it, plus extra columns. `p_author` is
  what the request claims, as SQL ('NULL' for none). With an expression it
  reports the row from RETURNING.
*/
CREATE OR REPLACE FUNCTION _dp_ins(p_author text, p_cols text DEFAULT '', p_vals text DEFAULT '',
                                   p_expr text DEFAULT NULL, p_company uuid DEFAULT NULL) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_expr IS NULL
    THEN format('INSERT INTO driver_notes (company_id, driver_id, created_by, note_text, start_date, end_date%s) VALUES (%L, %L, %s, ''dp'', ''2026-11-02'', ''2026-11-02''%s)',
                CASE WHEN p_cols = '' THEN '' ELSE ', ' || p_cols END,
                coalesce(p_company, _dp_id('co_a')), _dp_id('drv_a'), p_author,
                CASE WHEN p_vals = '' THEN '' ELSE ', ' || p_vals END)
    ELSE format('WITH i AS (INSERT INTO driver_notes (company_id, driver_id, created_by, note_text, start_date, end_date%s) VALUES (%L, %L, %s, ''dp'', ''2026-11-02'', ''2026-11-02''%s) RETURNING *) SELECT %s FROM i',
                CASE WHEN p_cols = '' THEN '' ELSE ', ' || p_cols END,
                coalesce(p_company, _dp_id('co_a')), _dp_id('drv_a'), p_author,
                CASE WHEN p_vals = '' THEN '' ELSE ', ' || p_vals END, p_expr)
  END
$$;

/*
  The Notizen screen's save of an existing note (handleSubmit's `noteData`): every
  column echoed back from what is stored, note_date recomputed to the minute, the
  text trimmed, and created_by the editor's, whoever wrote the note. With p_text
  NULL the text is the stored text, so the save changes nothing a person typed.
*/
CREATE OR REPLACE FUNCTION _dp_screen_save(p_note uuid, p_editor uuid, p_text text DEFAULT NULL, p_expr text DEFAULT NULL) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_expr IS NULL
    THEN format('UPDATE driver_notes d SET driver_id = o.driver_id, car_id = o.car_id, note_date = date_trunc(''minute'', o.note_date), note_text = btrim(%s), created_by = %L, company_id = o.company_id, note_type = o.note_type, note_planning_behavior = o.note_planning_behavior, is_full_day = o.is_full_day, start_time = o.start_time, end_time = o.end_time, start_date = o.start_date, end_date = o.end_date FROM driver_notes o WHERE d.id = o.id AND d.id = %L',
                coalesce(quote_literal(p_text), 'o.note_text'), p_editor, p_note)
    ELSE format('WITH u AS (UPDATE driver_notes d SET driver_id = o.driver_id, car_id = o.car_id, note_date = date_trunc(''minute'', o.note_date), note_text = btrim(%s), created_by = %L, company_id = o.company_id, note_type = o.note_type, note_planning_behavior = o.note_planning_behavior, is_full_day = o.is_full_day, start_time = o.start_time, end_time = o.end_time, start_date = o.start_date, end_date = o.end_date FROM driver_notes o WHERE d.id = o.id AND d.id = %L RETURNING d.*) SELECT %s FROM u',
                coalesce(quote_literal(p_text), 'o.note_text'), p_editor, p_note, p_expr)
  END
$$;

-- ─── fixtures ───────────────────────────────────────────────────────────────

INSERT INTO cars (id, company_id, kennzeichen, created_by) VALUES
  (_dp_id('car_1'), _dp_id('co_a'), 'B-DP 1001', _dp_id('admin')),
  (_dp_id('car_2'), _dp_id('co_a'), 'B-DP 2002', _dp_id('admin'));

INSERT INTO drivers (id, company_id, name) VALUES (_dp_id('drv_a2'), _dp_id('co_a'), 'Driver A2');

-- Written as the owner, who has no session: an explicit source and arrival time
-- are kept, and a reviewer may be named. plain / ver / ver_g / rej are company A's.
INSERT INTO driver_notes
  (id, company_id, driver_id, created_by, note_text, note_type, note_planning_behavior,
   start_date, end_date, note_date, entry_source, received_at,
   occurred_at, reported_at, verification_status, reviewed_by, reviewed_at, rejected_reason, car_id)
VALUES
  (_dp_id('plain'), _dp_id('co_a'), _dp_id('drv_a'), _dp_id('admin'), 'dp plain', 'general', 'neutral',
   '2026-11-02', '2026-11-02', '2026-10-20 09:00:00+00', 'manual', '2026-10-20 09:00+00',
   NULL, NULL, 'unverified', NULL, NULL, NULL, NULL),
  (_dp_id('ver'), _dp_id('co_a'), _dp_id('drv_a'), _dp_id('admin'), 'dp blitzer', 'blitzer', 'must_include_in_plan',
   '2026-10-19', '2026-10-19', '2026-10-19 12:03:37+00', 'manual', '2026-10-20 09:30+00',
   '2026-10-19 14:03+02', '2026-10-20 09:00+02', 'verified', _dp_id('editor'), '2026-10-20 10:00+00', NULL, NULL),
  (_dp_id('ver_g'), _dp_id('co_a'), _dp_id('drv_a'), _dp_id('admin'), 'dp general', 'general', 'neutral',
   '2026-10-19', '2026-10-19', '2026-10-19 12:03:37+00', 'manual', '2026-10-20 09:30+00',
   NULL, NULL, 'verified', _dp_id('editor'), '2026-10-20 10:00+00', NULL, _dp_id('car_1')),
  (_dp_id('rej'), _dp_id('co_a'), _dp_id('drv_a'), _dp_id('admin'), 'dp rejected', 'general', 'neutral',
   '2026-10-18', '2026-10-18', '2026-10-18 08:00:00+00', 'manual', '2026-10-20 09:30+00',
   '2026-10-18 08:00+00', NULL, 'rejected', _dp_id('editor'), '2026-10-20 10:00+00', 'Datum stimmt nicht', NULL),
  (_dp_id('b_note'), _dp_id('co_b'), _dp_id('drv_b'), _dp_id('adminb'), 'dp company b', 'general', 'neutral',
   '2026-11-02', '2026-11-02', '2026-10-20 09:00:00+00', 'manual', '2026-10-20 09:00+00',
   NULL, NULL, 'unverified', NULL, NULL, NULL, NULL);

-- A row that predates the migration: `legacy`, nothing else recorded, no arrival
-- time. The trigger would stamp one, so it is switched off for this one INSERT.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE public.driver_notes DISABLE TRIGGER driver_notes_provenance_guard;
INSERT INTO driver_notes (id, company_id, driver_id, created_by, note_text, start_date, end_date, entry_source)
VALUES (_dp_id('leg'), _dp_id('co_a'), _dp_id('drv_a'), _dp_id('admin'), 'dp legacy', '2026-09-01', '2026-09-01', 'legacy');
ALTER TABLE public.driver_notes ENABLE TRIGGER driver_notes_provenance_guard;

-- ─── the probes, as data ────────────────────────────────────────────────────
--
--  One row per probe: the number, the group the mutation control selects by, what
--  it says, who runs it, the statement, and what it must answer. Section 11 runs
--  the same table again under each broken rule, so a probe is written once.

CREATE TEMP TABLE _dp_case (
  n int PRIMARY KEY, grp text NOT NULL, label text NOT NULL,
  who text NOT NULL, sql text NOT NULL, expected text NOT NULL
);

/* Reports a stamped row: author | source | status | reviewer | driver-app name | arrival is the clock's | log length. */
CREATE OR REPLACE FUNCTION _dp_e_stamp() RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT $e$coalesce(created_by::text, '-') || '|' || entry_source || '|' || verification_status
         || '|' || coalesce(reviewed_by::text, '-') || '|' || coalesce(submitted_by_name, '-')
         || '|' || (received_at IS NOT NULL AND received_at > '2020-01-01')::text
         || '|' || jsonb_array_length(change_log)::text$e$
$$;

-- 1. stamping on INSERT ───────────────────────────────────────────────────────

INSERT INTO _dp_case VALUES
 (10, 'stamp', 'an administrator files a note: the author is the session, the source is manual, the clock is the arrival, born unreviewed',
  'admin', _dp_ins(quote_literal(_dp_id('admin')), '', '', _dp_e_stamp()),
  _dp_id('admin')::text || '|manual|unverified|-|-|true|0'),
 (11, 'stamp', 'claiming a colleague as the author changes nothing: the author is still the session',
  'admin', _dp_ins(quote_literal(_dp_id('editor')), '', '', _dp_e_stamp()),
  _dp_id('admin')::text || '|manual|unverified|-|-|true|0'),
 (12, 'stamp', 'an editor claims everything at once (author, source, a 2001 arrival, a review, the driver''s name, a forged log): none of it is kept',
  'editor', _dp_ins(quote_literal(_dp_id('admin')),
    'entry_source, received_at, verification_status, reviewed_by, reviewed_at, submitted_by_name, change_log',
    format('''driver_app'', ''2001-01-01 00:00+00'', ''verified'', %L, now(), ''Fahrer X'', ''[{"forged": true}]''::jsonb', _dp_id('admin')),
    _dp_e_stamp()),
  _dp_id('editor')::text || '|manual|unverified|-|-|true|0'),
 (13, 'stamp', 'a viewer cannot file a note: the page gate speaks, as row-level security, not a CHECK',
  'viewer', _dp_ins(quote_literal(_dp_id('viewer'))), 'ERR 42501 rls'),
 (14, 'stamp', 'no session, the partner door''s shape (no author, the driver''s name): driver_app',
  'owner', _dp_ins('NULL', 'submitted_by_name', '''Omar Khalil''', _dp_e_stamp()),
  '-|driver_app|unverified|-|Omar Khalil|true|0'),
 (15, 'stamp', 'no session, any other writer (a script, with an author): system',
  'owner', _dp_ins(quote_literal(_dp_id('admin')), '', '', _dp_e_stamp()),
  _dp_id('admin')::text || '|system|unverified|-|-|true|0'),
 (16, 'stamp', 'no session, a restore that states its source and its arrival time: both kept',
  'owner', _dp_ins(quote_literal(_dp_id('admin')), 'entry_source, received_at', '''legacy'', ''2026-01-01 10:00+00''',
    'entry_source || ''|'' || (received_at = ''2026-01-01 10:00+00'')::text'),
  'legacy|true'),
 (17, 'stamp', 'the service role, the partner door''s shape: driver_app',
  'service', _dp_ins('NULL', 'submitted_by_name', '''Omar Khalil''', _dp_e_stamp()),
  '-|driver_app|unverified|-|Omar Khalil|true|0');

-- 2. pinned on UPDATE ─────────────────────────────────────────────────────────

INSERT INTO _dp_case VALUES
 (20, 'pin', 'the screen''s save by a colleague, with a text edit: the author stays the administrator, one log entry, by the editor',
  'editor', _dp_screen_save(_dp_id('plain'), _dp_id('editor'), 'dp edited',
    $e$created_by::text || '|' || entry_source || '|' || (received_at = '2026-10-20 09:00+00')::text
       || '|' || jsonb_array_length(change_log)::text || '|' || coalesce(change_log -> 0 ->> 'by', '-')$e$),
  _dp_id('admin')::text || '|manual|true|1|' || _dp_id('editor')::text),
 (21, 'pin', 'the same save with nothing typed changed: the author stays, no log entry (note_date is recomputed and is not tracked)',
  'editor', _dp_screen_save(_dp_id('plain'), _dp_id('editor'), NULL,
    $e$created_by::text || '|' || entry_source || '|' || (received_at = '2026-10-20 09:00+00')::text
       || '|' || jsonb_array_length(change_log)::text$e$),
  _dp_id('admin')::text || '|manual|true|0'),
 (22, 'pin', 'writing source, arrival, the driver''s name and the log directly: all four stay as they were',
  'editor', _dp_upd(_dp_id('plain'),
    $s$entry_source = 'system', received_at = '2001-01-01 00:00+00', submitted_by_name = 'Y', change_log = '[{"forged": true}]'::jsonb$s$,
    $e$entry_source || '|' || (received_at = '2026-10-20 09:00+00')::text || '|' || coalesce(submitted_by_name, '-')
       || '|' || jsonb_array_length(change_log)::text$e$),
  'manual|true|-|0'),
 (23, 'pin', 'a writer with no session may repair created_by',
  'owner', _dp_upd(_dp_id('plain'), format('created_by = %L', _dp_id('editor')), 'created_by::text'),
  _dp_id('editor')::text),
 (24, 'pin', 'the log names whoever saved: an administrator''s edit of the text',
  'admin', _dp_upd(_dp_id('plain'), $s$note_text = 'dp edited by admin'$s$, $e$change_log -> 0 ->> 'by'$e$),
  _dp_id('admin')::text);

-- 3. the three dates ──────────────────────────────────────────────────────────

INSERT INTO _dp_case VALUES
 (30, 'dates', 'an event reported before it happened is refused',
  'admin', _dp_ins(quote_literal(_dp_id('admin')), 'occurred_at, reported_at', '''2026-10-02 09:00+02'', ''2026-09-01 14:03+02'''),
  'ERR 23514 driver_notes_occurred_not_after_reported'),
 (31, 'dates', 'reported at the moment it happened is fine',
  'admin', _dp_ins(quote_literal(_dp_id('admin')), 'occurred_at, reported_at', '''2026-09-01 14:03+02'', ''2026-09-01 14:03+02'''), 'rows 1'),
 (32, 'dates', 'an occurrence with no report is fine (the report has not come)',
  'admin', _dp_ins(quote_literal(_dp_id('admin')), 'occurred_at', '''2026-09-01 14:03+02'''), 'rows 1'),
 (33, 'dates', 'a report with no occurrence is fine (the letter does not say when)',
  'admin', _dp_ins(quote_literal(_dp_id('admin')), 'reported_at', '''2026-10-02 09:00+02'''), 'rows 1'),
 (34, 'dates', 'a note with a window and no occurrence leaves it NULL: it is never derived from the window',
  'admin', _dp_ins(quote_literal(_dp_id('admin')), '', '', 'coalesce(occurred_at::text, ''null'') || ''|'' || coalesce(reported_at::text, ''null'')'),
  'null|null'),
 (35, 'dates', 'a stored occurrence cannot be left behind by a report dated before it',
  'admin', _dp_upd(_dp_id('ver'), $s$reported_at = '2026-10-18 09:00+02'$s$),
  'ERR 23514 driver_notes_occurred_not_after_reported'),
 (36, 'dates', 'an offset is an instant: 14:03 at +02:00 is 12:03 UTC',
  'admin', _dp_ins(quote_literal(_dp_id('admin')), 'occurred_at', '''2026-09-01 14:03+02''',
    $e$(occurred_at AT TIME ZONE 'UTC')::text$e$),
  '2026-09-01 12:03:00');

-- 4. the document key ─────────────────────────────────────────────────────────

INSERT INTO _dp_case
SELECT 40 + t.ord, 'evidence', 'the key ' || t.label || ' is stored',
       'admin', _dp_upd(_dp_id('plain'), format('evidence_path = %L', t.path)), 'rows 1'
  FROM (VALUES
    (0, 'as a pdf',  _dp_key(_dp_id('co_a'), _dp_id('plain'), 'pdf')),
    (1, 'as a jpg',  _dp_key(_dp_id('co_a'), _dp_id('plain'), 'jpg')),
    (2, 'as a jpeg', _dp_key(_dp_id('co_a'), _dp_id('plain'), 'jpeg')),
    (3, 'as a png',  _dp_key(_dp_id('co_a'), _dp_id('plain'), 'png')),
    (4, 'as a webp', _dp_key(_dp_id('co_a'), _dp_id('plain'), 'webp'))
  ) AS t(ord, label, path);

INSERT INTO _dp_case
SELECT 45 + t.ord, 'evidence', 'the key ' || t.label || ' is refused by the shape rule',
       'admin', _dp_upd(_dp_id('plain'), format('evidence_path = %L', t.path)),
       'ERR 23514 driver_notes_evidence_path_shape'
  FROM (VALUES
    (0, 'in another company''s folder',      _dp_key(_dp_id('co_b'), _dp_id('plain'), 'pdf')),
    (1, 'in another note''s folder',         _dp_key(_dp_id('co_a'), _dp_id('ver'), 'pdf')),
    (2, 'with no company folder',            'driver-notes/' || _dp_id('plain')::text || '/' || _dp_id('file')::text || '.pdf'),
    (3, 'in a different folder (partner/)',  _dp_id('co_a')::text || '/partner/' || _dp_id('plain')::text || '/' || _dp_id('file')::text || '.pdf'),
    (4, 'with a traversal',                  _dp_id('co_a')::text || '/driver-notes/' || _dp_id('plain')::text || '/../' || _dp_id('file')::text || '.pdf'),
    (5, 'with a traversal into another company', _dp_id('co_a')::text || '/driver-notes/' || _dp_id('plain')::text || '/../../' || _dp_id('co_b')::text || '/driver-notes/' || _dp_id('plain')::text || '/' || _dp_id('file')::text || '.pdf'),
    (6, 'nested one folder deeper',          _dp_id('co_a')::text || '/driver-notes/' || _dp_id('plain')::text || '/a/' || _dp_id('file')::text || '.pdf'),
    (7, 'named by a person''s file name',    _dp_id('co_a')::text || '/driver-notes/' || _dp_id('plain')::text || '/Bussgeld.pdf'),
    (8, 'ending .svg',                       _dp_key(_dp_id('co_a'), _dp_id('plain'), 'svg')),
    (9, 'ending .html',                      _dp_key(_dp_id('co_a'), _dp_id('plain'), 'html')),
    (10, 'with no extension',                 _dp_id('co_a')::text || '/driver-notes/' || _dp_id('plain')::text || '/' || _dp_id('file')::text),
    (11, 'ending .PDF',                       _dp_key(_dp_id('co_a'), _dp_id('plain'), 'PDF')),
    (12, 'with an upper-case file id',        _dp_id('co_a')::text || '/driver-notes/' || _dp_id('plain')::text || '/' || upper(_dp_id('file')::text) || '.pdf'),
    (13, 'with a trailing space',             _dp_key(_dp_id('co_a'), _dp_id('plain'), 'pdf') || ' '),
    (14, 'with a trailing newline',           _dp_key(_dp_id('co_a'), _dp_id('plain'), 'pdf') || E'\n'),
    (15, 'with a leading slash',              '/' || _dp_key(_dp_id('co_a'), _dp_id('plain'), 'pdf')),
    (16, 'as a URL',                          'https://api.example.invalid/' || _dp_key(_dp_id('co_a'), _dp_id('plain'), 'pdf')),
    (17, 'as a signed URL (a query string)',  _dp_key(_dp_id('co_a'), _dp_id('plain'), 'pdf') || '?token=abc'),
    (18, 'empty',                             '')
  ) AS t(ord, label, path);

INSERT INTO _dp_case VALUES
 (70, 'evidence', 'across companies: an administrator of A writes the evidence of B''s note: nothing is touched (rows 0)',
  'admin', _dp_upd(_dp_id('b_note'), format('evidence_path = %L', _dp_key(_dp_id('co_b'), _dp_id('b_note'), 'pdf'))), 'rows 0'),
 (71, 'evidence', 'across companies: an administrator of A files a note for company B with a perfectly good key for B: row-level security first',
  'admin', _dp_ins(quote_literal(_dp_id('admin')), 'id, evidence_path',
    format('%L, %L', _dp_id('fresh'), _dp_key(_dp_id('co_b'), _dp_id('fresh'), 'pdf')), NULL, _dp_id('co_b')),
  'ERR 42501 rls'),
 (72, 'evidence', 'across companies: A''s own new note naming a key in B''s folder is refused by the shape rule',
  'admin', _dp_ins(quote_literal(_dp_id('admin')), 'id, evidence_path',
    format('%L, %L', _dp_id('fresh'), _dp_key(_dp_id('co_b'), _dp_id('fresh'), 'pdf'))),
  'ERR 23514 driver_notes_evidence_path_shape'),
 (73, 'evidence', 'across companies: moving A''s note to B is refused by row-level security',
  'admin', _dp_upd(_dp_id('plain'), format('company_id = %L', _dp_id('co_b'))), 'ERR 42501 rls'),
 (74, 'evidence', 'across companies: an administrator of B reads nothing of A''s note',
  'adminb', format('SELECT count(*)::text FROM driver_notes WHERE id = %L', _dp_id('plain')), '0'),
 (75, 'evidence', 'a key on a note that has no company is refused (receipts_document_prefix lets it through)',
  'owner', format('INSERT INTO driver_notes (id, company_id, driver_id, created_by, note_text, entry_source, evidence_path) VALUES (%L, NULL, %L, %L, ''dp'', ''manual'', %L)',
    _dp_id('fresh'), _dp_id('drv_a'), _dp_id('admin'), _dp_key(_dp_id('co_a'), _dp_id('fresh'), 'pdf')),
  'ERR 23514 driver_notes_evidence_path_shape'),
 (76, 'evidence', 'a note''s own key, written on another of the company''s notes, is refused: a file belongs to one note',
  'admin', _dp_upd(_dp_id('ver'), format('evidence_path = %L', _dp_key(_dp_id('co_a'), _dp_id('plain'), 'pdf'))),
  'ERR 23514 driver_notes_evidence_path_shape'),
 (77, 'evidence', 'and a note can have its key removed again',
  'admin', _dp_upd(_dp_id('plain'), 'evidence_path = NULL'), 'rows 1');

-- 5. the position ─────────────────────────────────────────────────────────────

INSERT INTO _dp_case VALUES
 (80, 'location', 'a position with its accuracy',
  'admin', _dp_upd(_dp_id('plain'), 'latitude = 51.5, longitude = 7.4, location_accuracy_m = 25'), 'rows 1'),
 (81, 'location', 'a latitude without a longitude',
  'admin', _dp_upd(_dp_id('plain'), 'latitude = 51.5'), 'ERR 23514 driver_notes_location_pair'),
 (82, 'location', 'a longitude without a latitude',
  'admin', _dp_upd(_dp_id('plain'), 'longitude = 7.4'), 'ERR 23514 driver_notes_location_pair'),
 (83, 'location', 'latitude 91',
  'admin', _dp_upd(_dp_id('plain'), 'latitude = 91, longitude = 7.4'), 'ERR 23514 driver_notes_location_range'),
 (84, 'location', 'latitude -91',
  'admin', _dp_upd(_dp_id('plain'), 'latitude = -91, longitude = 7.4'), 'ERR 23514 driver_notes_location_range'),
 (85, 'location', 'longitude 181',
  'admin', _dp_upd(_dp_id('plain'), 'latitude = 51.5, longitude = 181'), 'ERR 23514 driver_notes_location_range'),
 (86, 'location', 'a latitude that is not a number',
  'admin', _dp_upd(_dp_id('plain'), $s$latitude = 'NaN', longitude = 7.4$s$), 'ERR 23514 driver_notes_location_range'),
 (87, 'location', 'a longitude of infinity',
  'admin', _dp_upd(_dp_id('plain'), $s$latitude = 51.5, longitude = 'Infinity'$s$), 'ERR 23514 driver_notes_location_range'),
 (88, 'location', 'the corner of the globe is a position',
  'admin', _dp_upd(_dp_id('plain'), 'latitude = -90, longitude = 180'), 'rows 1'),
 (89, 'location', 'a negative accuracy',
  'admin', _dp_upd(_dp_id('plain'), 'latitude = 51.5, longitude = 7.4, location_accuracy_m = -1'), 'ERR 23514 driver_notes_location_accuracy'),
 (90, 'location', 'an accuracy over 100 km',
  'admin', _dp_upd(_dp_id('plain'), 'latitude = 51.5, longitude = 7.4, location_accuracy_m = 100001'), 'ERR 23514 driver_notes_location_accuracy'),
 (91, 'location', 'an accuracy that is not a number',
  'admin', _dp_upd(_dp_id('plain'), $s$latitude = 51.5, longitude = 7.4, location_accuracy_m = 'NaN'$s$), 'ERR 23514 driver_notes_location_accuracy'),
 (92, 'location', 'an accuracy without a position',
  'admin', _dp_upd(_dp_id('plain'), 'location_accuracy_m = 25'), 'ERR 23514 driver_notes_location_accuracy');

-- 6. the verification ─────────────────────────────────────────────────────────

INSERT INTO _dp_case VALUES
 (100, 'verify', 'an editor verifies an administrator''s note: the reviewer is the editor, the time is the clock',
  'editor', _dp_upd(_dp_id('plain'), $s$verification_status = 'verified'$s$,
    $e$verification_status || '|' || coalesce(reviewed_by::text, '-') || '|' || (reviewed_at > '2020-01-01')::text$e$),
  'verified|' || _dp_id('editor')::text || '|true'),
 (101, 'verify', 'claiming the administrator as the reviewer, and a 2001 time, changes nothing',
  'editor', _dp_upd(_dp_id('plain'),
    format($s$verification_status = 'verified', reviewed_by = %L, reviewed_at = '2001-01-01 00:00+00'$s$, _dp_id('admin')),
    $e$verification_status || '|' || coalesce(reviewed_by::text, '-') || '|' || (reviewed_at > '2020-01-01')::text$e$),
  'verified|' || _dp_id('editor')::text || '|true'),
 (102, 'verify', 'a rejection without a reason is refused',
  'editor', _dp_upd(_dp_id('plain'), $s$verification_status = 'rejected'$s$),
  'ERR 23514 driver_notes_rejection_has_reason'),
 (103, 'verify', 'a rejection with a blank reason is refused',
  'editor', _dp_upd(_dp_id('plain'), $s$verification_status = 'rejected', rejected_reason = '   '$s$),
  'ERR 23514 driver_notes_rejection_has_reason'),
 (104, 'verify', 'a rejection with its reason is stamped, and the reason is not copied into the log',
  'editor', _dp_upd(_dp_id('plain'), $s$verification_status = 'rejected', rejected_reason = 'Datum stimmt nicht'$s$,
    $e$verification_status || '|' || coalesce(reviewed_by::text, '-') || '|' || rejected_reason
       || '|' || (change_log::text LIKE '%Datum stimmt nicht%')::text$e$),
  'rejected|' || _dp_id('editor')::text || '|Datum stimmt nicht|false'),
 (105, 'verify', 'verifying a rejected note clears the reason, even if the request carries the old one',
  'editor', _dp_upd(_dp_id('rej'), $s$verification_status = 'verified', rejected_reason = 'Datum stimmt nicht'$s$,
    $e$verification_status || '|' || coalesce(rejected_reason, '-')$e$),
  'verified|-'),
 (106, 'verify', 'taking a decision back clears the reviewer and the time',
  'editor', _dp_upd(_dp_id('ver'), $s$verification_status = 'unverified'$s$,
    $e$verification_status || '|' || coalesce(reviewed_by::text, '-') || '|' || coalesce(reviewed_at::text, '-')$e$),
  'unverified|-|-'),
 (107, 'verify', 'a viewer verifies nothing: the page gate hides the row (rows 0)',
  'viewer', _dp_upd(_dp_id('plain'), $s$verification_status = 'verified'$s$), 'rows 0'),
 (108, 'verify', 'an administrator of another company verifies nothing of A''s (rows 0)',
  'adminb', _dp_upd(_dp_id('plain'), $s$verification_status = 'verified'$s$), 'rows 0'),
 (109, 'verify', 'a status outside the three is refused by the vocabulary rule, not the review-stamp rule',
  'admin', _dp_upd(_dp_id('plain'), $s$verification_status = 'checked'$s$),
  'ERR 23514 driver_notes_verification_status_known'),
 (110, 'verify', 'no session, so no reviewer to stamp: a decision with none is refused',
  'owner', _dp_upd(_dp_id('plain'), $s$verification_status = 'verified'$s$),
  'ERR 23514 driver_notes_review_stamp'),
 (111, 'verify', 'no session, an unreviewed note that names a reviewer is refused',
  'owner', _dp_upd(_dp_id('plain'), format($s$reviewed_by = %L, reviewed_at = now()$s$, _dp_id('admin'))),
  'ERR 23514 driver_notes_review_stamp'),
 (112, 'verify', 'no session, a reason on a note that is not rejected is refused',
  'owner', _dp_upd(_dp_id('plain'), $s$rejected_reason = 'x'$s$),
  'ERR 23514 driver_notes_reason_only_when_rejected'),
 (113, 'verify', 'a legacy note can be verified, and its arrival time stays unrecorded',
  'admin', _dp_upd(_dp_id('leg'), $s$verification_status = 'verified'$s$,
    $e$entry_source || '|' || verification_status || '|' || coalesce(reviewed_by::text, '-') || '|' || coalesce(received_at::text, 'null')$e$),
  'legacy|verified|' || _dp_id('admin')::text || '|null');

-- 7. a decision is of what was on the page ────────────────────────────────────

INSERT INTO _dp_case VALUES
 (130, 'reset', 'a verified blitzer: its occurrence is corrected, so the verification is taken back, and the log says the trigger did it',
  'admin', _dp_upd(_dp_id('ver'), $s$occurred_at = '2026-10-19 14:05+02'$s$,
    $e$verification_status || '|' || coalesce(reviewed_by::text, '-') || '|' || coalesce(change_log -> -1 ->> 'verification_reset', '-')$e$),
  'unverified|-|true'),
 (131, 'reset', 'the planning effect is not what was reviewed: a verified general note moved from neutral to must_include stays verified',
  'admin', _dp_upd(_dp_id('ver_g'), $s$note_planning_behavior = 'must_include_in_plan'$s$,
    $e$verification_status || '|' || coalesce(reviewed_by::text, '-') || '|' || coalesce(change_log -> -1 ->> 'verification_reset', '-')$e$),
  'verified|' || _dp_id('editor')::text || '|-'),
 (132, 'reset', 'note_date is not what was reviewed either: it changes, the verification stays, and nothing is logged',
  'admin', _dp_upd(_dp_id('ver_g'), $s$note_date = note_date + interval '1 day'$s$,
    $e$verification_status || '|' || jsonb_array_length(change_log)::text$e$),
  'verified|0'),
 (133, 'reset', 'the text is part of the claim: editing it takes the verification back',
  'admin', _dp_upd(_dp_id('ver_g'), $s$note_text = 'dp general, corrected'$s$,
    $e$verification_status || '|' || coalesce(change_log -> -1 ->> 'verification_reset', '-')$e$),
  'unverified|true'),
 (134, 'reset', 'the vehicle is part of the claim',
  'admin', _dp_upd(_dp_id('ver_g'), format('car_id = %L', _dp_id('car_2')), 'verification_status'), 'unverified'),
 (135, 'reset', 'the window is part of the claim (a start time)',
  'admin', _dp_upd(_dp_id('ver_g'), $s$start_time = '08:00', end_time = '09:00'$s$, 'verification_status'), 'unverified'),
 (136, 'reset', 'the driver is part of the claim',
  'admin', _dp_upd(_dp_id('ver_g'), format('driver_id = %L', _dp_id('drv_a2')), 'verification_status'), 'unverified'),
 (137, 'reset', 'the position is part of the claim',
  'admin', _dp_upd(_dp_id('ver_g'), 'latitude = 51.5, longitude = 7.4', 'verification_status'), 'unverified'),
 (138, 'reset', 'the document is part of the claim',
  'admin', _dp_upd(_dp_id('ver_g'), format('evidence_path = %L', _dp_key(_dp_id('co_a'), _dp_id('ver_g'), 'pdf')), 'verification_status'),
  'unverified'),
 (139, 'reset', 'a change made together with a decision is the reviewer''s own: the administrator corrects the date of a rejected note and verifies it in one save',
  'admin', _dp_upd(_dp_id('rej'), $s$occurred_at = '2026-10-18 09:00+00', verification_status = 'verified'$s$,
    $e$verification_status || '|' || coalesce(reviewed_by::text, '-') || '|' || coalesce(change_log -> -1 ->> 'verification_reset', '-')$e$),
  'verified|' || _dp_id('admin')::text || '|-'),
 (140, 'reset', 'the screen''s save of a verified general note with nothing changed (note_date recomputed to the minute) takes nothing back and logs nothing',
  'editor', _dp_screen_save(_dp_id('ver_g'), _dp_id('editor'), NULL,
    $e$verification_status || '|' || coalesce(reviewed_by::text, '-') || '|' || jsonb_array_length(change_log)::text$e$),
  'verified|' || _dp_id('editor')::text || '|0'),
 (141, 'reset', 'and of a verified blitzer, whose note_date carries seconds the screen drops',
  'editor', _dp_screen_save(_dp_id('ver'), _dp_id('editor'), NULL,
    $e$verification_status || '|' || jsonb_array_length(change_log)::text || '|' || created_by::text$e$),
  'verified|0|' || _dp_id('admin')::text),
 (142, 'reset', 'a rejection is of what was on the page too: correcting the date of a rejected note takes the rejection back',
  'admin', _dp_upd(_dp_id('rej'), $s$occurred_at = '2026-10-18 09:00+00'$s$,
    $e$verification_status || '|' || coalesce(rejected_reason, '-') || '|' || coalesce(change_log -> -1 ->> 'verification_reset', '-')$e$),
  'unverified|-|true');

-- 8. the change log ───────────────────────────────────────────────────────────

INSERT INTO _dp_case VALUES
 (150, 'log', 'a type and its effect changed together: both are named, and the previous values are kept',
  'admin', _dp_upd(_dp_id('plain'), $s$note_type = 'sick', note_planning_behavior = 'exclude_from_plan'$s$,
    $e$(change_log -> 0 -> 'changed')::text || '|' || (change_log -> 0 -> 'previous' ->> 'note_type')
       || '|' || (change_log -> 0 -> 'previous' ->> 'note_planning_behavior')$e$),
  '["note_type", "note_planning_behavior"]|general|neutral'),
 (151, 'log', 'a text edit names note_text and keeps neither the old wording nor the new',
  'admin', _dp_upd(_dp_id('plain'), $s$note_text = 'dp rewritten'$s$,
    $e$(change_log -> 0 -> 'changed')::text || '|' || (change_log::text LIKE '%dp plain%')::text
       || '|' || (change_log::text LIKE '%dp rewritten%')::text$e$),
  '["note_text"]|false|false'),
 (152, 'log', 'two edits are two entries in order: the second one''s previous value is the first one''s new value',
  'admin', 'SEQ:' || _dp_upd(_dp_id('plain'), $s$occurred_at = '2026-09-01 14:03+02'$s$) || ';;'
    || _dp_upd(_dp_id('plain'), $s$occurred_at = '2026-09-02 10:00+02'$s$) || ';;'
    || format('SELECT jsonb_array_length(change_log)::text || ''|'' || ((change_log -> 1 -> ''previous'' ->> ''occurred_at'')::timestamptz = ''2026-09-01 14:03+02'')::text FROM driver_notes WHERE id = %L', _dp_id('plain')),
  '2|true'),
 (153, 'log', 'a request cannot write the log: after one real edit and one attempt, one entry',
  'admin', 'SEQ:' || _dp_upd(_dp_id('plain'), $s$note_text = 'dp rewritten'$s$) || ';;'
    || _dp_upd(_dp_id('plain'), $s$change_log = '[]'::jsonb$s$) || ';;'
    || format('SELECT jsonb_array_length(change_log)::text FROM driver_notes WHERE id = %L', _dp_id('plain')),
  '1'),
 (154, 'log', 'RECORDED, NOT ENDORSED: deleting a note deletes its history with it',
  'admin', 'SEQ:' || _dp_upd(_dp_id('plain'), $s$note_text = 'dp rewritten'$s$) || ';;'
    || format('DELETE FROM driver_notes WHERE id = %L', _dp_id('plain')) || ';;'
    || format('SELECT count(*)::text FROM driver_notes WHERE id = %L', _dp_id('plain')),
  '0'),
 (155, 'log', 'RECORDED, NOT ENDORSED: deleting a car takes back the verification of the notes that name it, and logs it as a writer with no session',
  'owner', 'SEQ:' || format('DELETE FROM cars WHERE id = %L', _dp_id('car_1')) || ';;'
    || format($q$SELECT verification_status || '|' || coalesce(car_id::text, '-') || '|' || (change_log -> -1 -> 'changed')::text
                     || '|' || coalesce(change_log -> -1 ->> 'by', '-') FROM driver_notes WHERE id = %L$q$, _dp_id('ver_g')),
  'unverified|-|["car_id", "verification_status", "reviewed_by", "reviewed_at"]|-'),
 (156, 'log', 'a legacy note edited keeps its source and its missing arrival time, and gains its first log entry',
  'admin', _dp_upd(_dp_id('leg'), $s$note_text = 'dp legacy, edited'$s$,
    $e$entry_source || '|' || coalesce(received_at::text, 'null') || '|' || jsonb_array_length(change_log)::text$e$),
  'legacy|null|1'),
 (157, 'log', 'a legacy note reads with every new column empty',
  'admin', format($q$SELECT entry_source || '|' || coalesce(received_at::text, 'null') || '|' || coalesce(occurred_at::text, 'null')
                          || '|' || coalesce(reported_at::text, 'null') || '|' || coalesce(evidence_path, 'null')
                          || '|' || verification_status || '|' || jsonb_array_length(change_log)::text
                     FROM driver_notes WHERE id = %L$q$, _dp_id('leg')),
  'legacy|null|null|null|null|unverified|0');

-- ─── 1-8. the probes, in numbered order ─────────────────────────────────────

-- ─── 0. what the catalogue holds ────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _dp_rec(1, 'the thirteen provenance columns exist, with the types the migration gave them',
    (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                       || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END, '; ' ORDER BY a.attname)
       FROM pg_attribute a
      WHERE a.attrelid = 'public.driver_notes'::regclass AND NOT a.attisdropped
        AND a.attname IN ('occurred_at', 'reported_at', 'received_at', 'entry_source', 'evidence_path',
                          'verification_status', 'reviewed_by', 'reviewed_at', 'rejected_reason',
                          'latitude', 'longitude', 'location_accuracy_m', 'change_log')),
    'change_log jsonb not null; entry_source text not null; evidence_path text; latitude double precision; '
    'location_accuracy_m double precision; longitude double precision; occurred_at timestamp with time zone; '
    'received_at timestamp with time zone; rejected_reason text; reported_at timestamp with time zone; '
    'reviewed_at timestamp with time zone; reviewed_by uuid; verification_status text not null');

  PERFORM _dp_rec(2, 'the twelve CHECKs exist and are validated',
    (SELECT string_agg(conname || '=' || convalidated, ',' ORDER BY conname) FROM pg_constraint
      WHERE conrelid = 'public.driver_notes'::regclass AND contype = 'c'
        AND conname IN ('driver_notes_change_log_is_array', 'driver_notes_entry_source_known',
                        'driver_notes_evidence_path_shape', 'driver_notes_location_accuracy',
                        'driver_notes_location_pair', 'driver_notes_location_range',
                        'driver_notes_occurred_not_after_reported', 'driver_notes_reason_only_when_rejected',
                        'driver_notes_received_at_unless_legacy', 'driver_notes_rejection_has_reason',
                        'driver_notes_review_stamp', 'driver_notes_verification_status_known')),
    'driver_notes_change_log_is_array=true,driver_notes_entry_source_known=true,driver_notes_evidence_path_shape=true,'
    'driver_notes_location_accuracy=true,driver_notes_location_pair=true,driver_notes_location_range=true,'
    'driver_notes_occurred_not_after_reported=true,driver_notes_reason_only_when_rejected=true,'
    'driver_notes_received_at_unless_legacy=true,driver_notes_rejection_has_reason=true,'
    'driver_notes_review_stamp=true,driver_notes_verification_status_known=true');

  PERFORM _dp_rec(3, 'the guard is a row trigger BEFORE INSERT OR UPDATE, SECURITY DEFINER, with a pinned search_path',
    (SELECT (t.tgtype & 1 = 1)::text || '/' || (t.tgtype & 2 = 2)::text || '/' || (t.tgtype & 4 = 4)::text
            || '/' || (t.tgtype & 16 = 16)::text || '/' || (t.tgtype & 8 = 0)::text || '/' || p.prosecdef::text
            || '/' || coalesce((SELECT c.setting FROM unnest(p.proconfig) c(setting) WHERE c.setting LIKE 'search_path=%'), 'none')
       FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'public.driver_notes'::regclass AND t.tgname = 'driver_notes_provenance_guard' AND NOT t.tgisinternal),
    'true/true/true/true/true/true/search_path=pg_catalog, public');

  PERFORM _dp_rec(4, 'no API role can execute the guard (it is fired by a trigger, which does not ask)',
    (SELECT string_agg(r || '=' || has_function_privilege(r, 'app_private.driver_note_provenance_guard()', 'EXECUTE'), ',' ORDER BY r)
       FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r),
    'anon=false,authenticated=false,service_role=false');

  PERFORM _dp_rec(5, 'the guard fires before the car guard and the updated_at trigger (name order), and depends on neither',
    (SELECT string_agg(tgname, ' < ' ORDER BY tgname) FROM pg_trigger
      WHERE tgrelid = 'public.driver_notes'::regclass AND NOT tgisinternal
        AND (tgtype & 2) = 2 AND (tgtype & 1) = 1
        AND tgname IN ('driver_notes_provenance_guard', 'enforce_driver_note_car_company', 'trigger_update_driver_notes_updated_at')),
    'driver_notes_provenance_guard < enforce_driver_note_car_company < trigger_update_driver_notes_updated_at');

  -- The planner's safety property, as a catalogue fact: no policy reads a column
  -- added here, so none of them is a tenancy term.
  PERFORM _dp_rec(6, 'no policy on driver_notes reads a provenance column',
    coalesce((SELECT string_agg(policyname, ', ') FROM pg_policies
               WHERE schemaname = 'public' AND tablename = 'driver_notes'
                 AND (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
                     ~ '\m(occurred_at|reported_at|received_at|entry_source|evidence_path|verification_status|reviewed_by|reviewed_at|rejected_reason|latitude|longitude|location_accuracy_m|change_log)\M'),
             'none'),
    'none');

  PERFORM _dp_rec(7, 'the table still carries its four policies, unchanged in number',
    (SELECT string_agg(cmd, ',' ORDER BY cmd) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'driver_notes'),
    'DELETE,INSERT,SELECT,UPDATE');
END $$;

-- ─── 1-8. run the table ─────────────────────────────────────────────────────

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT * FROM _dp_case ORDER BY n LOOP
    PERFORM _dp_rec(c.n, c.label, _dp_try(c.who, c.sql), c.expected);
  END LOOP;
END $$;

-- ─── 9. the partner door ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _dp_service_call(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_hint  text;
BEGIN
  BEGIN
    PERFORM _dp_as('service');
    EXECUTE p_sql INTO v_out;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
    v_out := 'ERR ' || v_state || ' ' || coalesce(nullif(v_hint, ''), '-');
  END;
  PERFORM _dp_reset();
  RETURN coalesce(v_out, '<null>');
END $$;

DO $$
DECLARE
  v_co   constant uuid := _dp_id('co_a');
  v_door constant text := 'public.partner_note_submission_record(uuid,text,text,text,text,text,date,date,boolean,text,text,jsonb,text)';
  v_resp text;
BEGIN
  IF current_setting('dp.skip_partner', true) = 'on' THEN
    RAISE NOTICE 'driver-note-provenance: section 9 skipped (dp.skip_partner = on)';
    RETURN;
  END IF;

  IF to_regprocedure(v_door) IS NULL THEN
    RAISE EXCEPTION 'driver-note-provenance: % does not exist. Section 9 is the door the partner app writes notes through; a rename must be followed here, not skipped', v_door;
  END IF;

  EXECUTE format(
    'INSERT INTO partner_driver_links (id, company_id, partner, external_driver_id, driver_id, status, linked_at) '
    'VALUES (%L, %L, ''reidey'', ''dp-linked'', %L, ''linked'', now())',
    'a8200000-0000-4000-8000-000000000001', v_co, _dp_id('drv_a'));

  -- Two statements: a subquery in the same SELECT as the call would read the
  -- snapshot from before the call wrote the note.
  v_resp := _dp_service_call(format(
    $q$SELECT public.partner_note_submission_record(%L, 'reidey', 'dp-door-1', 'dp-linked', 'general', 'dp door', NULL, NULL, false, NULL, NULL, NULL, NULL) ->> 'status'$q$, v_co));

  PERFORM _dp_rec(180, 'the door, as service_role, files the note as accepted', v_resp, 'accepted');

  -- The driver's name is compared with the driver row as it is now, not with the
  -- seed's: an earlier file in the kit leaves it changed.
  PERFORM _dp_rec(181, 'the note it wrote is driver_app: no author, the driver''s own name, the clock, and nothing recorded about when it happened',
    (SELECT coalesce(n.created_by::text, '-') || '|' || n.entry_source
            || '|' || (n.submitted_by_name = d.name)::text
            || '|' || (n.received_at IS NOT NULL AND n.received_at > '2020-01-01')::text
            || '|' || coalesce(n.occurred_at::text, 'null') || '|' || coalesce(n.reported_at::text, 'null')
            || '|' || n.verification_status || '|' || jsonb_array_length(n.change_log)::text
       FROM partner_note_submissions s
       JOIN driver_notes n ON n.id = s.driver_note_id
       JOIN drivers d ON d.id = n.driver_id
      WHERE s.company_id = v_co AND s.external_submission_id = 'dp-door-1'),
    '-|driver_app|true|true|null|null|unverified|0');
END $$;

-- ─── 10. the support-write audit does not copy the new text or the position ─

DO $$
BEGIN
  PERFORM _dp_rec(190, 'the columns of driver_notes the support-write audit replaces by a marker are exactly these four',
    (SELECT string_agg(a.attname, ',' ORDER BY a.attname)
       FROM pg_attribute a
      WHERE a.attrelid = 'public.driver_notes'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname ~ app_private.support_write_redaction_pattern('driver_notes')),
    'latitude,longitude,note_text,rejected_reason');

  PERFORM _dp_rec(191, 'the document key, the car, the times and the review are copied in clear (none of them is redacted)',
    coalesce((SELECT string_agg(c, ',' ORDER BY c)
                FROM unnest(ARRAY['evidence_path', 'car_id', 'occurred_at', 'reported_at', 'received_at', 'entry_source',
                                  'verification_status', 'reviewed_by', 'reviewed_at', 'location_accuracy_m']) AS c
               WHERE c ~ app_private.support_write_redaction_pattern('driver_notes')),
             'none'),
    'none');
END $$;

-- ─── 11. the mutation control ───────────────────────────────────────────────
--
--  Nine rules, broken one at a time inside a subtransaction that is rolled back,
--  and the probes that notice each, compared with the set predicted here. The set
--  is what makes a count mean anything: a battery that mismatched everything
--  under every mutation would also "catch" it. Every probe is run as the
--  principal the table names, which is a principal who writes notes.

SET CONSTRAINTS ALL IMMEDIATE;

/*
  The probes in the given groups, run as the principals they name; the numbers
  that did not answer as expected. With p_only the battery is that list of
  probes, and with p_force_who it is run as that principal instead (for the probes
  whose answer does not depend on who asks).
*/
CREATE OR REPLACE FUNCTION _dp_battery(p_groups text[], p_force_who text DEFAULT NULL, p_only int[] DEFAULT NULL) RETURNS int[]
LANGUAGE plpgsql AS $$
DECLARE
  c     record;
  v_bad int[] := '{}';
BEGIN
  FOR c IN SELECT * FROM _dp_case
            WHERE grp = ANY (p_groups) AND (p_only IS NULL OR n = ANY (p_only))
            ORDER BY n LOOP
    IF _dp_try(coalesce(p_force_who, c.who), c.sql) IS DISTINCT FROM c.expected THEN
      v_bad := v_bad || c.n;
    END IF;
  END LOOP;
  RETURN v_bad;
END $$;

/* The edited definition of the guard: one fragment replaced, which must occur exactly once. */
CREATE OR REPLACE FUNCTION _dp_edit_guard(p_find text, p_replace text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := pg_get_functiondef('app_private.driver_note_provenance_guard()'::regprocedure);
BEGIN
  IF (length(v_def) - length(replace(v_def, p_find, ''))) <> length(p_find) THEN
    RAISE EXCEPTION '_dp_edit_guard: the fragment % occurs other than once in the guard', quote_literal(p_find);
  END IF;
  EXECUTE replace(v_def, p_find, p_replace);
END $$;

CREATE OR REPLACE FUNCTION _dp_mutations() RETURNS jsonb
LANGUAGE plpgsql AS $mut$
DECLARE
  v    jsonb := '{}';
  v_all text[] := ARRAY['stamp', 'pin', 'dates', 'evidence', 'location', 'verify', 'reset', 'log'];
  v_ev  text[] := ARRAY['evidence'];
  -- The document-key probes whose answer is the CHECK's and nobody else's: the
  -- five keys stored (40-44), the nineteen refused (45-63), a new note naming a
  -- key in another company's folder (72) and another note's key (76). Not the
  -- ones row-level security answers first (70, 71, 73, 74), and not 75, which is
  -- the owner's whatever the mutation.
  c_check_only CONSTANT int[] := ARRAY[40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 72, 76];
BEGIN
  -- M1. the document-key rule is gone.
  BEGIN
    EXECUTE 'ALTER TABLE public.driver_notes DROP CONSTRAINT driver_notes_evidence_path_shape';
    v := v || jsonb_build_object('m1', _dp_battery(v_ev));
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'back';
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN NULL; END;

  -- M2. the rule written the way receipts_document_prefix is: the company's folder, and nothing more.
  BEGIN
    EXECUTE 'ALTER TABLE public.driver_notes DROP CONSTRAINT driver_notes_evidence_path_shape';
    EXECUTE 'ALTER TABLE public.driver_notes ADD CONSTRAINT driver_notes_evidence_path_shape '
         || 'CHECK (evidence_path IS NULL OR company_id IS NULL OR evidence_path LIKE (company_id::text || ''/%''))';
    v := v || jsonb_build_object('m2', _dp_battery(v_ev));
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'back';
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN NULL; END;

  -- M3. the same rule, written the obvious way: by asking a function in
  --     app_private. It means the same thing, so the owner sees nothing wrong.
  --     `authenticated` cannot execute it, and the CHECK is refused for every
  --     write that gets as far as it, with a privilege error and not a rule.
  BEGIN
    EXECUTE $f$CREATE FUNCTION app_private._dp_key_ok(p_path text, p_company uuid, p_note uuid) RETURNS boolean
               LANGUAGE sql IMMUTABLE AS $b$
                 SELECT p_path IS NULL OR (p_company IS NOT NULL AND p_path ~ ('^' || p_company::text || '/driver-notes/' || p_note::text
                   || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png|webp)$'))
               $b$$f$;
    EXECUTE 'REVOKE ALL ON FUNCTION app_private._dp_key_ok(text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role';
    EXECUTE 'ALTER TABLE public.driver_notes DROP CONSTRAINT driver_notes_evidence_path_shape';
    EXECUTE 'ALTER TABLE public.driver_notes ADD CONSTRAINT driver_notes_evidence_path_shape '
         || 'CHECK (app_private._dp_key_ok(evidence_path, company_id, id))';
    v := v || jsonb_build_object('m3_owner', _dp_battery(v_ev, 'owner', c_check_only));
    v := v || jsonb_build_object('m3_admin', _dp_battery(v_ev, 'admin', c_check_only));
    v := v || jsonb_build_object('m3_msg',
      _dp_try('admin', _dp_upd(_dp_id('plain'), format('evidence_path = %L', _dp_key(_dp_id('co_a'), _dp_id('plain'), 'pdf')))));
    v := v || jsonb_build_object('m3_note',
      _dp_try('admin', _dp_upd(_dp_id('plain'), $s$note_text = 'a note that names no document at all'$s$)));
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'back';
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN NULL; END;

  -- M4. the trigger is gone.
  BEGIN
    EXECUTE 'DROP TRIGGER driver_notes_provenance_guard ON public.driver_notes';
    v := v || jsonb_build_object('m4', _dp_battery(v_all));
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'back';
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN NULL; END;

  -- M5. created_by is not pinned on UPDATE.
  BEGIN
    PERFORM _dp_edit_guard(E'    NEW.created_by        := OLD.created_by;\n', '');
    v := v || jsonb_build_object('m5', _dp_battery(v_all));
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'back';
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN NULL; END;

  -- M6. a request may choose the reviewer.
  BEGIN
    PERFORM _dp_edit_guard('NEW.reviewed_by := v_uid; NEW.reviewed_at := now();',
                           'NEW.reviewed_by := coalesce(NEW.reviewed_by, v_uid); NEW.reviewed_at := now();');
    v := v || jsonb_build_object('m6', _dp_battery(v_all));
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'back';
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN NULL; END;

  -- M7. a decision outlives a change to what it covered.
  BEGIN
    PERFORM _dp_edit_guard('IF v_reset THEN', 'IF false THEN');
    v := v || jsonb_build_object('m7', _dp_battery(v_all));
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'back';
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN NULL; END;

  -- M8. a decision may name no reviewer.
  BEGIN
    EXECUTE 'ALTER TABLE public.driver_notes DROP CONSTRAINT driver_notes_review_stamp';
    v := v || jsonb_build_object('m8', _dp_battery(v_all));
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'back';
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN NULL; END;

  -- M9. note_date counts as part of what was reviewed, so the screen's own
  --     no-op save (which recomputes it to the minute) takes verifications back.
  BEGIN
    PERFORM _dp_edit_guard($f$'location_accuracy_m', 'evidence_path', 'note_text'];$f$,
                           $f$'location_accuracy_m', 'evidence_path', 'note_text', 'note_date'];$f$);
    v := v || jsonb_build_object('m9', _dp_battery(v_all));
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'back';
  EXCEPTION WHEN SQLSTATE 'ZZ009' THEN NULL; END;

  RETURN v;
END $mut$;

/* The numbers of the probes in a group, as a sorted list. */
CREATE OR REPLACE FUNCTION _dp_nums(p_where text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  EXECUTE format('SELECT coalesce(jsonb_agg(n ORDER BY n), ''[]''::jsonb) FROM _dp_case WHERE %s', p_where) INTO v;
  RETURN v;
END $$;

DO $$
DECLARE
  v_before int[] := _dp_battery(ARRAY['stamp', 'pin', 'dates', 'evidence', 'location', 'verify', 'reset', 'log']);
  v        jsonb := _dp_mutations();
  v_after  int[] := _dp_battery(ARRAY['stamp', 'pin', 'dates', 'evidence', 'location', 'verify', 'reset', 'log']);
BEGIN
  PERFORM _dp_rec(200, 'before: the whole table is clean against the real rules, as the principals who write',
    cardinality(v_before)::text, '0');

  -- M1: every probe that expects the shape rule to speak, and no other.
  PERFORM _dp_rec(201, 'M1. document-key rule dropped: exactly the probes that expect it to refuse get through',
    (v -> 'm1')::text,
    _dp_nums($w$expected = 'ERR 23514 driver_notes_evidence_path_shape'$w$)::text);

  -- M2: the company-folder-only rule still refuses what is outside the folder (45, 47,
  -- 60, 61, 63, 72) and lets through a NULL company (75), where LIKE answers NULL.
  PERFORM _dp_rec(202, 'M2. document-key rule reduced to the company''s folder: the stricter refusals get through, the cross-company ones do not',
    (v -> 'm2')::text,
    _dp_nums($w$expected = 'ERR 23514 driver_notes_evidence_path_shape' AND n NOT IN (45, 47, 60, 61, 63, 72)$w$)::text);

  PERFORM _dp_rec(203, 'M3. document-key rule written as a call into app_private, the 26 CHECK-only probes run as the OWNER: nothing caught (the blind spot)',
    (v -> 'm3_owner')::text, '[]');
  PERFORM _dp_rec(204, 'M3. the same 26 probes run as authenticated: every one is refused, because the CHECK is evaluated for every write that reaches it',
    (v -> 'm3_admin')::text,
    '[40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 72, 76]');
  PERFORM _dp_rec(205, 'M3. and what authenticated is told: a missing privilege, not a rule',
    v ->> 'm3_msg', 'ERR 42501 perm');
  PERFORM _dp_rec(206, 'M3. a note that names no document at all is refused too: the CHECK is evaluated for every write',
    v ->> 'm3_note', 'ERR 42501 perm');

  -- With the trigger gone: no INSERT carries a source (NOT NULL answers before any
  -- CHECK does), nothing is stamped, pinned, reset or logged. The probes that do
  -- not notice are the ones whose expected answer is also what happens with no
  -- trigger: the viewer's refusal (13), the restore that states everything (16),
  -- the owner's repair (23), the refusals that are CHECKs and row-level security,
  -- and the "nothing should happen" probes (131, 132, 140, 154, 157).
  PERFORM _dp_rec(207, 'M4. trigger dropped: exactly the stamping, pinning, review, reset and log probes notice',
    (v -> 'm4')::text,
    '[10, 11, 12, 14, 15, 17, 20, 21, 22, 24, 30, 31, 32, 33, 34, 36, 72, 100, 101, 104, 105, 106, 113, 130, 133, 134, 135, 136, 137, 138, 139, 141, 142, 150, 151, 152, 153, 155, 156]');

  PERFORM _dp_rec(208, 'M5. created_by not pinned: the two probes that save as a colleague notice',
    (v -> 'm5')::text, _dp_nums('n IN (20, 21, 141)')::text);

  -- 101 names a reviewer. 139 does not, and still notices: on an UPDATE a column the
  -- request does not mention keeps its stored value, so under this mutation a note
  -- someone else reviewed keeps that reviewer when it is decided again.
  PERFORM _dp_rec(209, 'M6. a request may choose the reviewer: the probe that names one (101) notices, and so does a re-decision, where the old reviewer would survive (139)',
    (v -> 'm6')::text, _dp_nums('n IN (101, 139)')::text);

  PERFORM _dp_rec(210, 'M7. a decision outlives a change: the nine probes that change what was reviewed notice',
    (v -> 'm7')::text, _dp_nums('n IN (130, 133, 134, 135, 136, 137, 138, 142, 155)')::text);

  PERFORM _dp_rec(211, 'M8. a decision may name no reviewer: the probes that expect the review-stamp rule notice',
    (v -> 'm8')::text, _dp_nums($w$expected = 'ERR 23514 driver_notes_review_stamp'$w$)::text);

  PERFORM _dp_rec(212, 'M9. note_date counted as reviewed: a changed note_date takes the verification back (132), and so does the screen''s own no-op save (140, 141)',
    (v -> 'm9')::text, _dp_nums('n IN (132, 140, 141)')::text);

  PERFORM _dp_rec(213, 'after the rolled-back mutations: the whole table is clean again',
    cardinality(v_after)::text, '0');
END $$;

-- ─── 12. the premises, and the standing guard ───────────────────────────────

DO $$
BEGIN
  PERFORM _dp_rec(220, 'no API role can use app_private (the premise of writing every rule here as a literal)',
    (SELECT string_agg(r || '=' || has_schema_privilege(r, 'app_private', 'USAGE'), ',' ORDER BY r)
       FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r),
    'anon=false,authenticated=false,service_role=false');

  -- A CHECK that calls a function needs the writing role to execute it. These
  -- call none outside pg_catalog.
  PERFORM _dp_rec(221, 'no CHECK on driver_notes depends on a function outside pg_catalog',
    coalesce((SELECT string_agg(c.conname || ' -> ' || d.refobjid::regprocedure::text, '; ')
                FROM pg_constraint c
                JOIN pg_depend d ON d.classid = 'pg_constraint'::regclass AND d.objid = c.oid
                                AND d.refclassid = 'pg_proc'::regclass
                JOIN pg_proc p ON p.oid = d.refobjid
               WHERE c.conrelid = 'public.driver_notes'::regclass AND c.contype = 'c'
                 AND p.pronamespace <> 'pg_catalog'::regnamespace),
             'none'),
    'none');

  -- Whoever adds the next CHECK to this table: it runs as the writing role, so
  -- it may call only what that role may execute.
  PERFORM _dp_rec(222, 'no CHECK on driver_notes calls a function the authenticated role cannot execute',
    coalesce((SELECT string_agg(c.conname || ' -> ' || d.refobjid::regprocedure::text, '; ')
                FROM pg_constraint c
                JOIN pg_depend d ON d.classid = 'pg_constraint'::regclass AND d.objid = c.oid
                                AND d.refclassid = 'pg_proc'::regclass
               WHERE c.conrelid = 'public.driver_notes'::regclass AND c.contype = 'c'
                 AND NOT has_function_privilege('authenticated', d.refobjid, 'EXECUTE')),
             'none'),
    'none');
END $$;

-- ─── verdict ────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_failed int;
  v_total  int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT matched), count(*) INTO v_failed, v_total FROM _dp_out;
  IF v_failed > 0 THEN
    RAISE EXCEPTION 'driver-note-provenance: % of % probes did not match (see the XX lines above)', v_failed, v_total;
  END IF;
  RAISE NOTICE 'driver-note-provenance: all % probes matched', v_total;
END $$;

ROLLBACK;
