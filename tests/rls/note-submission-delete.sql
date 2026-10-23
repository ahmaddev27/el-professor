/*
  Deleting a driver note deletes its partner submission (20261023160000).

  `partner_note_submissions.driver_note_id` carried `ON DELETE SET NULL`
  (20261007100000) against `CHECK ((status = 'accepted') = (driver_note_id IS
  NOT NULL))`, so deleting the note nulled the reference, the CHECK saw an
  accepted submission naming no note, and the whole DELETE rolled back. Every
  driver note produced by an accepted submission was permanently undeletable —
  and so was its driver, `driver_notes.driver_id` being CASCADE, which turns
  the same delete into the same refusal one step further away. Three such notes
  on production, measured read-only on 23.10.2026. The owner chose `ON DELETE
  CASCADE` the same day, the same answer he had just given for the Beleg.

  This is the twin of `partner-submission-delete.sql` and is built on it. What
  is NOT a copy is section 4, the driver chain: on the receipt side the only
  way in is deleting the Beleg, while here the Fahrer screen's delete reaches
  the same submission through two cascades, and that is the shape production's
  three rows actually sit in.

  ## What each section says, and why it is not obvious

  0. The catalogue. The action is CASCADE, there is exactly one foreign key on
     the column, it still points at `public.driver_notes`, the accepted-has-note
     CHECK is still there, the table still has no client write policy, the
     receipt sibling is CASCADE too — the pin `20261023150000` could not carry,
     because it sorts before the migration that earns it — and both context
     triggers and the tenant SELECT policy are untouched. Without that last
     part a migration that "fixed" the delete by granting the table away would
     pass every behavioural probe below.

  1. The defect itself, reproduced. The cascade is swapped back to SET NULL and
     the delete is run: refused, `23514`, by the constraint's NAME. That name
     is the whole point — `partner_note_submissions` carries four other CHECKs
     (`..._rejected_has_reason`, `..._range_ordered`, `..._range_capped`, the
     inline `status`, `partner`, `start_time` and `end_time` ones) and
     `driver_notes` carries several more from `20261022143000` and
     `20261022150000`, all raising 23514, so a probe that read only the SQLSTATE
     would pass on the wrong refusal. The driver delete is refused by the same
     named constraint two steps away, which is the production consequence and
     not a restatement. The original action is then restored.

     This is also the before-and-after in one file: section 1 is the old
     behaviour and section 2 the new one, measured in the same run against the
     same fixture, so neither is a claim about the other.

  2. The delete, and the row afterwards. A note with an accepted submission is
     deleted and the submission row is GONE — not nulled, not left `accepted`
     pointing at nothing. Both halves are asserted, because a cascade that
     silently became SET NULL would still let the delete through while leaving a
     row that lies, which is the state `20261007100000` was written to prevent.

  3. The crux: a cascade is not the caller's statement. The delete is run as a
     company ADMINISTRATOR holding the `notes` page — a caller who has no
     DELETE policy on `partner_note_submissions` and no UPDATE policy either
     since `20261008160000`. The cascade still removes the row, because
     PostgreSQL runs a referential action as the table's owner and bypasses row
     security. The control beside it is the same principal's own DELETE on that
     table, which removes nothing and leaves the row — so the section shows the
     cascade reaching a row the caller cannot touch directly, rather than
     merely that something happened.

     The fixture and production differ on the DELETE grant and probe 5 pins the
     difference rather than hiding it: the fixture is a `--schema=public` dump
     carrying no privileges, so the table gets Supabase's default grants,
     DELETE included, and the caller's own statement answers `rows 0` here
     where production answers `42501`. Both mean the row is out of reach, which
     is why probe 16 asserts the row's survival as well as the answer.

  4. The driver chain, which is what production's three rows look like. The
     Fahrer screen deletes a driver; `driver_notes.driver_id` is CASCADE, so
     the note goes, and the submission now goes with it. Before this change
     that delete was refused — by a constraint on a table two hops away, which
     is why nobody reading `drivers` could see why. `driver-deletion.sql`
     probes 9 to 12 own that cell and flip in this same commit; this section is
     the same fact measured as a PRINCIPAL rather than as the owner, because
     the trash button is a user's statement and not a fixture's.

  5. The neighbours. A note with no submission at all still deletes; a
     `pending` submission is untouched by the delete of another note; and a
     `rejected` submission, whose `driver_note_id` is NULL by the same CHECK, is
     likewise untouched. A cascade that keyed on the company rather than the
     row would fail here and nowhere else.

  6. Tenancy and the role gate on `driver_notes` DELETE, unchanged. Both the
     tenant term and `current_role_permits('notes', true)` are in `USING`, so a
     viewer and an administrator of the other company are both answered `rows
     0` rather than a refusal — the row is not in the statement's scope, which
     is the shape `writeOutcome.ts` exists for. An editor, who holds the page,
     deletes. What makes the section evidence is that no role reaches the note,
     so the cascade never runs and both rows survive.

  7. The support-write audit. A cascade fires row triggers, so a platform owner
     inside a support session on the company deletes the note and gets TWO
     audit rows, `support_write.driver_notes.delete` and
     `support_write.partner_note_submissions.delete`, both naming the session's
     company, its context and its reason. That is measured rather than assumed:
     if statement-level triggers did not fire on the internal cascade the flag
     would be unarmed for that row and `record_support_write`'s WHEN gate would
     skip it, giving one row instead of two; and if the audit function's
     section-5 company wall saw the submission as another company's row it
     would refuse and roll the operator's delete back.

     Probe 36 records an asymmetry this change does not resolve:
     `app_private.support_write_redaction_pattern` names `driver_notes.note_text`
     and names nothing on `partner_note_submissions`, so the note's audit row
     redacts the free text about a person's absence while the cascaded
     submission's row copies the same text in full. That is measured here so
     the next reader sees it; widening the pattern is a data-protection
     decision and was not taken as a side effect of a delete fix.

  8. The mutation controls, which are what make sections 0 to 7 worth reading.

  ## What it does not claim

  Tenancy and the role gate on `driver_notes` in general (matrix.sql,
  tenant-state.sql, permission-coverage.sql), the note's own type and
  provenance rules (note-type-constraint.sql, driver-note-provenance.sql), the
  submission table's shape (partner-note-intake.sql, driver-deletion.sql
  section 6), the redaction rules of the audit row (support-write-audit.sql),
  and nothing about what SHOULD have happened to the submission record — that
  was the owner's decision, not this file's finding.

  Collect-then-raise: every probe is recorded and the file fails at the end, so
  one run answers everything instead of stopping at the first surprise. Runs
  inside BEGIN ... ROLLBACK, so the files after it see only the migrations and
  the seeds. Probe numbers are never reused.
*/

\set ON_ERROR_STOP on

BEGIN;

-- The fixture was dumped with --schema=public, so these are stubs, exactly as
-- platform-contexts.sql and support-write-audit.sql build them. Each file
-- creates them itself because every file is rolled back.
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS banned_until       timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at         timestamptz,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS auth.sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  not_after  timestamptz
);

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _ns_out (
  n        integer PRIMARY KEY,
  label    text    NOT NULL,
  actual   text    NOT NULL,
  expected text    NOT NULL,
  matched  boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _ns_rec(p_n integer, p_label text, p_actual text, p_expected text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ok boolean := p_actual IS NOT DISTINCT FROM p_expected;
BEGIN
  INSERT INTO _ns_out VALUES (p_n, p_label, coalesce(p_actual, '<null>'), p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', coalesce(p_actual, '<null>');
  END IF;
END $$;

/* Stable ids, so a probe's subject can be named in a label. */
CREATE OR REPLACE FUNCTION _ns_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_what
    -- the seed's principals of company A (roles-seed.sql: admin, supervisor and
    -- editor hold can_edit on `notes`, viewer holds it nowhere)
    WHEN 'user:admin'    THEN 'a0000000-0000-4000-8000-000000000001'::uuid
    WHEN 'user:editor'   THEN 'a0000000-0000-4000-8000-000000000002'::uuid
    WHEN 'user:viewer'   THEN 'a0000000-0000-4000-8000-000000000003'::uuid
    WHEN 'user:admin-b'  THEN 'b0000000-0000-4000-8000-000000000001'::uuid
    WHEN 'company:a'     THEN 'c0000000-0000-4000-8000-00000000000a'::uuid
    WHEN 'company:b'     THEN 'c0000000-0000-4000-8000-00000000000b'::uuid
    WHEN 'driver:a'      THEN 'd0000000-0000-4000-8000-00000000000a'::uuid
    -- this file's own platform owner and its sign-in session (section 7)
    WHEN 'user:owner'    THEN 'fb000000-0000-4000-8000-0000000000f1'::uuid
    WHEN 'session:owner' THEN 'fb000000-0000-4000-8000-0000000000f2'::uuid
    -- a driver of this file's own, so section 4 can delete one without
    -- cascading the seed's Driver A out from under every other file's fixtures
    WHEN 'driver:own'    THEN 'fb000000-0000-4000-8000-0000000000d1'::uuid
    -- the notes and the submissions
    WHEN 'note:acc'      THEN 'fb000000-0000-4000-8000-000000000001'::uuid
    WHEN 'note:bare'     THEN 'fb000000-0000-4000-8000-000000000002'::uuid
    WHEN 'note:pend'     THEN 'fb000000-0000-4000-8000-000000000003'::uuid
    WHEN 'note:tenant'   THEN 'fb000000-0000-4000-8000-000000000004'::uuid
    WHEN 'note:supp'     THEN 'fb000000-0000-4000-8000-000000000005'::uuid
    WHEN 'note:driver'   THEN 'fb000000-0000-4000-8000-000000000006'::uuid
    WHEN 'sub:acc'       THEN 'fb000000-0000-4000-8000-00000000000a'::uuid
    WHEN 'sub:pend'      THEN 'fb000000-0000-4000-8000-00000000000b'::uuid
    WHEN 'sub:rej'       THEN 'fb000000-0000-4000-8000-00000000000c'::uuid
    WHEN 'sub:tenant'    THEN 'fb000000-0000-4000-8000-00000000000d'::uuid
    WHEN 'sub:supp'      THEN 'fb000000-0000-4000-8000-00000000000e'::uuid
    WHEN 'sub:driver'    THEN 'fb000000-0000-4000-8000-00000000000f'::uuid
  END
$$;

/*
  Become a principal for the rest of the current subtransaction. The plans go
  first: schema USAGE and function EXECUTE are resolved when a statement is
  planned, the owner runs every fixture, and a plan the owner cached would let
  every principal after it through (matrix.sql's `_mx_become` has the account).
*/
CREATE OR REPLACE FUNCTION _ns_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  EXECUTE 'DISCARD PLANS';
  IF p_user IS NULL THEN
    RETURN;                              -- the owner, for fixtures
  END IF;
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr',
                     '[{"method": "password", "timestamp": 1789416052}]', true);
  PERFORM set_config('request.jwt.claim.session_id',
                     coalesce(p_session, p_user)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE OR REPLACE FUNCTION _ns_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('app_private.support_write_context', '', true);
END $$;

/*
  Runs one statement as one principal in a subtransaction that is always rolled
  back, and says what happened:

      `rows N`                          a write, and how many rows it touched
      the scalar                        a SELECT
      `ERR <sqlstate> <constraint>`     a refusal, by the constraint's name
      `ERR <sqlstate> -`                ... or bare (row-level security, a
                                        missing privilege, a trigger's RAISE)

  Comparing by the constraint's NAME is the rule this file is built on: the old
  failure and several unrelated CHECKs on both tables all raise 23514, and a
  permission refusal raises 42501. A probe that read the SQLSTATE alone would
  pass on the wrong wall.
*/
CREATE OR REPLACE FUNCTION _ns_try(p_user uuid, p_sql text, p_session uuid DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_con   text;
BEGIN
  BEGIN
    PERFORM _ns_as(p_user, p_session);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ010', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ010' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_con = CONSTRAINT_NAME;
      v_out := 'ERR ' || v_state || ' ' || coalesce(nullif(v_con, ''), '-');
  END;
  PERFORM _ns_reset();
  RETURN v_out;
END $$;

/*
  A DELETE and a count of what it reached, as TWO statements in one
  subtransaction that is always rolled back, and both answers in one string:
  `rows N / <scalar>`, or the refusal.

  Two statements and not one, because **a data-modifying CTE's effect is not
  visible to the rest of its own statement**: `WITH d AS (DELETE … RETURNING 1)
  SELECT count(*) FROM …` reads the snapshot from before the statement and so
  counts the row the cascade has just removed. `partner-submission-delete.sql`
  records hitting exactly that.
*/
CREATE OR REPLACE FUNCTION _ns_delete_then(p_user uuid, p_delete_sql text, p_count_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_n     text;
  v_state text;
  v_con   text;
BEGIN
  BEGIN
    PERFORM _ns_as(p_user);
    EXECUTE p_delete_sql;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    EXECUTE p_count_sql INTO v_n;
    v_out := 'rows ' || v_rows || ' / ' || coalesce(v_n, '<null>');
    RAISE EXCEPTION USING ERRCODE = 'ZZ010', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ010' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_con = CONSTRAINT_NAME;
      v_out := 'ERR ' || v_state || ' ' || coalesce(nullif(v_con, ''), '-');
  END;
  PERFORM _ns_reset();
  RETURN v_out;
END $$;

/** The delete action of one column's single foreign key: c = CASCADE, n = SET NULL. */
CREATE OR REPLACE FUNCTION _ns_action(p_table text, p_column text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT c.confdeltype::text
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = ('public.' || p_table)::regclass
     AND c.contype = 'f' AND a.attname = p_column
     AND array_length(c.conkey, 1) = 1
$$;

/** Replace that foreign key's action, for the mutations. */
CREATE OR REPLACE FUNCTION _ns_set_action(p_action text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_name text;
BEGIN
  SELECT c.conname INTO v_name
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'public.partner_note_submissions'::regclass
     AND c.contype = 'f' AND a.attname = 'driver_note_id';
  EXECUTE format('ALTER TABLE public.partner_note_submissions DROP CONSTRAINT %I', v_name);
  EXECUTE format(
    'ALTER TABLE public.partner_note_submissions '
    'ADD CONSTRAINT partner_note_submissions_driver_note_id_fkey '
    'FOREIGN KEY (driver_note_id) REFERENCES public.driver_notes(id) ON DELETE %s',
    CASE p_action WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' ELSE 'NO ACTION' END);
END $$;

-- ─── fixtures ───────────────────────────────────────────────────────────────
--
-- Six notes in company A and one submission each where a submission is the
-- point. `created_by` is the seed's admin account; `entry_source` is left to
-- the provenance trigger of `20261022150000`, exactly as driver-deletion.sql
-- and matrix.sql insert driver notes.

INSERT INTO drivers (id, company_id, name)
VALUES (_ns_id('driver:own'), _ns_id('company:a'), 'NS Note Driver');

INSERT INTO driver_notes (id, created_by, driver_id, note_text, company_id) VALUES
  (_ns_id('note:acc'),    _ns_id('user:admin'), _ns_id('driver:a'),   'ns accepted', _ns_id('company:a')),
  (_ns_id('note:bare'),   _ns_id('user:admin'), _ns_id('driver:a'),   'ns no sub',   _ns_id('company:a')),
  (_ns_id('note:pend'),   _ns_id('user:admin'), _ns_id('driver:a'),   'ns pending',  _ns_id('company:a')),
  (_ns_id('note:tenant'), _ns_id('user:admin'), _ns_id('driver:a'),   'ns tenant',   _ns_id('company:a')),
  (_ns_id('note:supp'),   _ns_id('user:admin'), _ns_id('driver:a'),   'ns support',  _ns_id('company:a')),
  -- section 4's note hangs off this file's own driver, so deleting that driver
  -- cascades into this note and nothing the seed owns.
  (_ns_id('note:driver'), _ns_id('user:admin'), _ns_id('driver:own'), 'ns driver',   _ns_id('company:a'));

INSERT INTO partner_note_submissions
  (id, company_id, partner, external_submission_id, external_driver_id,
   driver_id, note_type, note_text, status, driver_note_id, rejected_reason)
VALUES
  -- accepted, naming the note section 2 deletes
  (_ns_id('sub:acc'),    _ns_id('company:a'), 'reidey', 'ns-ext-1', '8001',
   _ns_id('driver:a'), 'general', 'ns accepted', 'accepted', _ns_id('note:acc'),    NULL),
  -- pending, naming no note: section 5's bystander
  (_ns_id('sub:pend'),   _ns_id('company:a'), 'reidey', 'ns-ext-2', '8002',
   _ns_id('driver:a'), 'general', 'ns pending',  'pending',  NULL,                  NULL),
  -- rejected, naming no note by the same CHECK: section 5's second bystander
  (_ns_id('sub:rej'),    _ns_id('company:a'), 'reidey', 'ns-ext-3', '8003',
   _ns_id('driver:a'), 'general', 'ns rejected', 'rejected', NULL,                  'ns: no evidence'),
  -- accepted, for the role and tenancy probes of sections 3 and 6
  (_ns_id('sub:tenant'), _ns_id('company:a'), 'reidey', 'ns-ext-4', '8004',
   _ns_id('driver:a'), 'general', 'ns tenant',   'accepted', _ns_id('note:tenant'), NULL),
  -- accepted, for the support session of section 7
  (_ns_id('sub:supp'),   _ns_id('company:a'), 'reidey', 'ns-ext-5', '8005',
   _ns_id('driver:a'), 'general', 'ns support',  'accepted', _ns_id('note:supp'),   NULL),
  -- accepted, for the driver chain of section 4
  (_ns_id('sub:driver'), _ns_id('company:a'), 'reidey', 'ns-ext-6', '8006',
   _ns_id('driver:own'), 'general', 'ns driver', 'accepted', _ns_id('note:driver'), NULL);

-- ─── 0. the catalogue ───────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _ns_rec(1, 'driver_note_id''s foreign key is ON DELETE CASCADE',
    _ns_action('partner_note_submissions', 'driver_note_id'), 'c');

  PERFORM _ns_rec(2, 'and it is the only foreign key on the column, under its own name',
    (SELECT string_agg(c.conname, ', ' ORDER BY c.conname)
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conrelid = 'public.partner_note_submissions'::regclass
        AND c.contype = 'f' AND a.attname = 'driver_note_id'),
    'partner_note_submissions_driver_note_id_fkey');

  PERFORM _ns_rec(3, 'and it still references public.driver_notes',
    (SELECT c.confrelid::regclass::text FROM pg_constraint c
      WHERE c.conrelid = 'public.partner_note_submissions'::regclass
        AND c.conname = 'partner_note_submissions_driver_note_id_fkey'),
    'driver_notes');

  -- The CHECK is kept deliberately: it no longer has anything to say about a
  -- delete, but it is still the only thing stopping the note intake or a
  -- judging RPC from filing an accepted submission that names no note.
  PERFORM _ns_rec(4, 'the accepted-has-note CHECK is still there',
    (SELECT count(*)::text FROM pg_constraint
      WHERE conrelid = 'public.partner_note_submissions'::regclass
        AND conname = 'partner_note_submissions_accepted_has_note'), '1');

  PERFORM _ns_rec(5, 'no client write policy on the submission table',
    (SELECT coalesce(string_agg(policyname || ' (' || cmd || ')', ', '), 'none')
       FROM pg_policies WHERE schemaname = 'public'
        AND tablename = 'partner_note_submissions'
        AND cmd IN ('INSERT', 'UPDATE', 'DELETE')), 'none');

  -- The pin 20261023150000 could not carry. It sorts BEFORE the migration that
  -- makes the note side CASCADE, so a pin of 'c' in its self-check would fail
  -- the release and this very kit run; 20261023160000's self-check 7 and this
  -- probe hold it instead. Both siblings CASCADE, measured together.
  PERFORM _ns_rec(6, 'and the receipt sibling is CASCADE too, so the two tables agree again',
    _ns_action('partner_receipt_submissions', 'receipt_id'), 'c');

  PERFORM _ns_rec(7, 'the tenant SELECT policy and both context triggers are untouched',
    (SELECT (SELECT count(*) FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'partner_note_submissions'
                AND cmd = 'SELECT' AND qual LIKE '%get_active_company_id%')::text
            || '/' ||
            (SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
              WHERE c.relnamespace = 'public'::regnamespace
                AND c.relname = 'partner_note_submissions'
                AND g.tgname IN ('refuse_read_only_context_write', 'record_support_write')
                AND NOT g.tgisinternal)::text),
    '1/2');

  -- MEASURED, and NOT the product's privileges. On production `authenticated`
  -- holds no DELETE on this table, so a member's own DELETE there is refused
  -- 42501. The kit's fixture is a `--schema=public` dump and carries no
  -- privileges, so the table is created by the migration under Supabase's
  -- default grants, which include DELETE — and the same statement answers
  -- `rows 0` here instead, the policy having no row to offer it. This probe
  -- pins the FIXTURE's grant so probe 16's shape is never read as production's.
  PERFORM _ns_rec(8, 'the fixture grants `authenticated` DELETE here where production does not',
    (SELECT coalesce(string_agg(privilege_type, ',' ORDER BY privilege_type), 'none')
       FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'partner_note_submissions'
        AND grantee = 'authenticated' AND privilege_type = 'DELETE'), 'DELETE');
END $$;

-- ─── 1. the defect, reproduced ──────────────────────────────────────────────
-- The action is swapped back to SET NULL and the same deletes are run. This is
-- the measurement the migration's header rests on, taken here rather than
-- quoted. Compared by the constraint's name: `driver_notes` and
-- `partner_note_submissions` carry several other CHECKs that raise 23514.

DO $$
DECLARE v_was text;
BEGIN
  v_was := _ns_action('partner_note_submissions', 'driver_note_id');
  PERFORM _ns_set_action('n');

  PERFORM _ns_rec(9, 'with ON DELETE SET NULL the note cannot be deleted at all',
    _ns_try(_ns_id('user:admin'),
      format('DELETE FROM driver_notes WHERE id = %L', _ns_id('note:acc'))),
    'ERR 23514 partner_note_submissions_accepted_has_note');

  PERFORM _ns_rec(10, 'not even as the table owner, because it is a constraint and not a policy',
    _ns_try(NULL,
      format('DELETE FROM driver_notes WHERE id = %L', _ns_id('note:acc'))),
    'ERR 23514 partner_note_submissions_accepted_has_note');

  -- The production consequence, and the reason this is worse than the receipt
  -- side: the refusal is raised by a constraint on a table two hops from the
  -- statement, so the Fahrer screen's trash button failed with a message
  -- naming a table the operator has never heard of.
  PERFORM _ns_rec(11, 'and neither can the DRIVER, the note cascading into the same refusal',
    _ns_try(_ns_id('user:admin'),
      format('DELETE FROM drivers WHERE id = %L', _ns_id('driver:own'))),
    'ERR 23514 partner_note_submissions_accepted_has_note');

  PERFORM _ns_set_action(v_was);
  PERFORM _ns_rec(12, 'and the action is back to CASCADE for the sections below',
    _ns_action('partner_note_submissions', 'driver_note_id'), 'c');
END $$;

-- ─── 2. the delete, and the row afterwards ──────────────────────────────────

DO $$
BEGIN
  PERFORM _ns_rec(13, 'a note behind an accepted submission is deleted',
    _ns_try(_ns_id('user:admin'),
      format('DELETE FROM driver_notes WHERE id = %L', _ns_id('note:acc'))),
    'rows 1');

  -- `_ns_try` rolls its subtransaction back, so the row is still here to be
  -- deleted for real below. Doing it twice is deliberate: the probe above
  -- measures the statement's answer, the one below the state it leaves.
  DELETE FROM driver_notes WHERE id = _ns_id('note:acc');

  PERFORM _ns_rec(14, 'the note is gone',
    (SELECT count(*)::text FROM driver_notes WHERE id = _ns_id('note:acc')), '0');

  PERFORM _ns_rec(15, 'and its submission is GONE — not nulled, not left accepted naming nothing',
    (SELECT count(*)::text FROM partner_note_submissions WHERE id = _ns_id('sub:acc')), '0');

  PERFORM _ns_rec(16, 'so no accepted submission anywhere names a note that does not exist',
    (SELECT count(*)::text FROM partner_note_submissions s
      WHERE s.driver_note_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM driver_notes n WHERE n.id = s.driver_note_id)), '0');
END $$;

-- ─── 3. a cascade is not the caller's statement ─────────────────────────────
-- Probe 13 above was already a company administrator, who holds neither a
-- DELETE policy nor an UPDATE policy on the submission table (probe 5). The
-- two probes here are the control that makes that meaningful: the same
-- principal cannot reach the row directly, in either direction.

DO $$
BEGIN
  -- `rows 0` and not a refusal: with no DELETE policy the statement matches no
  -- row and reports success having changed nothing — the class recorded as "a
  -- DELETE the SELECT policy hides removes zero rows and reports success". On
  -- production the same statement is `42501`, the DELETE grant being absent
  -- there (probe 8); the row is out of reach either way, which is what the
  -- second half of this probe asserts.
  PERFORM _ns_rec(17, 'the same administrator''s own DELETE on the submission table removes nothing, and the row survives it',
    _ns_delete_then(_ns_id('user:admin'),
      format('DELETE FROM partner_note_submissions WHERE id = %L', _ns_id('sub:tenant')),
      format('SELECT count(*)::text FROM partner_note_submissions WHERE id = %L', _ns_id('sub:tenant'))),
    'rows 0 / 1');

  PERFORM _ns_rec(18, 'nor can that principal clear the reference by hand (no UPDATE policy since 20261008160000)',
    _ns_try(_ns_id('user:admin'),
      format('UPDATE partner_note_submissions SET status = %L, driver_note_id = NULL, rejected_reason = %L WHERE id = %L',
             'rejected', 'by hand', _ns_id('sub:tenant'))),
    'rows 0');

  -- …yet the cascade reaches exactly that row through its note.
  PERFORM _ns_rec(19, 'but deleting its note does remove it, as the table''s owner',
    _ns_delete_then(_ns_id('user:admin'),
      format('DELETE FROM driver_notes WHERE id = %L', _ns_id('note:tenant')),
      format('SELECT count(*)::text FROM partner_note_submissions WHERE id = %L', _ns_id('sub:tenant'))),
    'rows 1 / 0');
END $$;

-- ─── 4. the driver chain, which is what production's three rows look like ───
--
-- `driver_notes.driver_id` is CASCADE, so the Fahrer screen's delete reaches
-- the note, and since 20261023160000 it reaches the submission too. Measured
-- as a PRINCIPAL rather than as the owner, because the trash button is a
-- user's statement: `driver-deletion.sql` probes 9 to 12 cover the same cell
-- from the owner's side and flip in this same commit.

DO $$
BEGIN
  PERFORM _ns_rec(20, 'deleting the driver removes its note''s submission two cascades away',
    _ns_delete_then(_ns_id('user:admin'),
      format('DELETE FROM drivers WHERE id = %L', _ns_id('driver:own')),
      format('SELECT count(*)::text FROM partner_note_submissions WHERE id = %L', _ns_id('sub:driver'))),
    'rows 1 / 0');

  DELETE FROM drivers WHERE id = _ns_id('driver:own');

  PERFORM _ns_rec(21, 'and afterwards the driver, its note and the submission are all gone',
    (SELECT (SELECT count(*) FROM drivers WHERE id = _ns_id('driver:own'))::text || '/' ||
            (SELECT count(*) FROM driver_notes WHERE id = _ns_id('note:driver'))::text || '/' ||
            (SELECT count(*) FROM partner_note_submissions WHERE id = _ns_id('sub:driver'))::text),
    '0/0/0');
END $$;

-- ─── 5. the neighbours ──────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _ns_rec(22, 'a note with no submission at all still deletes',
    _ns_try(_ns_id('user:admin'),
      format('DELETE FROM driver_notes WHERE id = %L', _ns_id('note:bare'))),
    'rows 1');

  PERFORM _ns_rec(23, 'the pending submission is untouched by section 2''s delete',
    (SELECT status || '/' || coalesce(driver_note_id::text, 'null')
       FROM partner_note_submissions WHERE id = _ns_id('sub:pend')),
    'pending/null');

  PERFORM _ns_rec(24, 'and so is the rejected one',
    (SELECT status || '/' || coalesce(driver_note_id::text, 'null')
       FROM partner_note_submissions WHERE id = _ns_id('sub:rej')),
    'rejected/null');

  -- Deleting a note that no submission names must not reach the company's
  -- other submissions. A cascade keyed on company_id rather than on the row
  -- would fail here and pass everything above.
  --
  -- FOUR remain, counted rather than assumed: this file inserts six, section 2
  -- consumed sub:acc for real and section 4 consumed sub:driver with its
  -- driver, while section 3's probe 19 rolled its subtransaction back so
  -- sub:tenant is still here. `seed.sql` inserts none of either submission
  -- table (measured: zero occurrences), and the mutation battery's own rows
  -- are not written until section 8, so nothing outside this file's six is in
  -- the count. It is restricted to them anyway, by the prefix this file gives
  -- every `external_submission_id`: a company-keyed cascade would take those
  -- rows too, so the probe still catches the shape it is here for.
  PERFORM _ns_rec(25, 'deleting an unrelated note leaves every remaining submission of the company',
    _ns_delete_then(_ns_id('user:admin'),
      format('DELETE FROM driver_notes WHERE id = %L', _ns_id('note:pend')),
      format('SELECT count(*)::text FROM partner_note_submissions '
             'WHERE company_id = %L AND external_submission_id LIKE %L',
             _ns_id('company:a'), 'ns-ext-%')),
    'rows 1 / 4');
END $$;

-- ─── 6. tenancy and the role gate on driver_notes DELETE, unchanged ─────────
--
-- `driver_notes_delete` is the tenant term AND `current_role_permits('notes',
-- true)`, both in `USING`. So a viewer is answered `rows 0`, NOT a refusal:
-- the row is simply not in the statement's scope, which is the shape CLAUDE.md
-- states and `writeOutcome.ts` exists for.
--
-- What makes the section meaningful is therefore the second half: no role
-- reaches the note, so the cascade never runs, so both rows are still there
-- (probe 29). Mutation M3 moves exactly the viewer's probe.

DO $$
BEGIN
  PERFORM _ns_rec(26, 'a viewer reaches no note: the page gate is in USING, so the statement matches nothing',
    _ns_try(_ns_id('user:viewer'),
      format('DELETE FROM driver_notes WHERE id = %L', _ns_id('note:supp'))),
    'rows 0');

  PERFORM _ns_rec(27, 'an editor, who holds the notes page, may',
    _ns_try(_ns_id('user:editor'),
      format('DELETE FROM driver_notes WHERE id = %L', _ns_id('note:supp'))),
    'rows 1');

  PERFORM _ns_rec(28, 'an administrator of the other company reaches no row of this one',
    _ns_try(_ns_id('user:admin-b'),
      format('DELETE FROM driver_notes WHERE id = %L', _ns_id('note:supp'))),
    'rows 0');

  PERFORM _ns_rec(29, 'and after all three the note and its submission are both still there',
    (SELECT (SELECT count(*) FROM driver_notes WHERE id = _ns_id('note:supp'))::text || '/' ||
            (SELECT count(*) FROM partner_note_submissions WHERE id = _ns_id('sub:supp'))::text),
    '1/1');
END $$;

-- ─── 7. the support-write audit on a cascaded row ───────────────────────────
--
-- A platform account with no company of its own, an active staff row and an
-- open SUPPORT context on company A. Its writes are recorded by
-- `record_support_write`, an AFTER … FOR EACH ROW trigger gated on a flag that
-- the BEFORE STATEMENT `refuse_read_only_context_write` arms. Both questions
-- here are about the internal statement the foreign key runs:
--
--   * does it fire the statement trigger, so the flag is armed for the
--     submission row too? If not, the WHEN gate skips it and there is one
--     audit row instead of two — the delete would succeed unrecorded.
--   * does the audit function's company wall (its section 5) see the cascaded
--     row as the session's? If not it raises `support_session_other_company`
--     and the operator's delete rolls back.
--
-- The writes here are made outside `_ns_try`, because the audit row is the
-- subject and a rolled-back subtransaction would take it with it.

INSERT INTO auth.users (id, email, email_confirmed_at)
VALUES (_ns_id('user:owner'), 'ns-owner@test.invalid', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
VALUES (_ns_id('user:owner'), 'ns-owner@test.invalid', 'NS Owner', 'viewer',
        (SELECT r.id FROM roles r WHERE r.name = 'viewer' AND r.company_id IS NULL),
        NULL, 'active')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES (_ns_id('user:owner'), 'owner', 'ns')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
VALUES (_ns_id('session:owner'), _ns_id('user:owner'))
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  co_a   constant uuid := _ns_id('company:a');
  u_o    constant uuid := _ns_id('user:owner');
  s_o    constant uuid := _ns_id('session:owner');
  v_open jsonb;
  v_ctx  uuid;
  v_mark bigint;
  r_note app_private.platform_audit_log%ROWTYPE;
  r_sub  app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _ns_as(u_o, s_o);
  v_open := public.platform_context_open(co_a, 'support', 'Ticket NS-cascade');
  PERFORM _ns_reset();

  PERFORM _ns_rec(30, 'the platform owner opens a support session on company A',
    (v_open ->> 'success'), 'true');
  v_ctx := (v_open -> 'context' ->> 'id')::uuid;

  SELECT coalesce(max(l.id), 0) INTO v_mark FROM app_private.platform_audit_log l;

  PERFORM _ns_as(u_o, s_o);
  DELETE FROM driver_notes WHERE id = _ns_id('note:supp');
  PERFORM _ns_reset();

  PERFORM _ns_rec(31, 'the support session deletes the note, and the cascade removes the submission',
    (SELECT (SELECT count(*) FROM driver_notes WHERE id = _ns_id('note:supp'))::text || '/' ||
            (SELECT count(*) FROM partner_note_submissions WHERE id = _ns_id('sub:supp'))::text),
    '0/0');

  PERFORM _ns_rec(32, 'and it leaves TWO support_write rows, the note''s and the cascaded submission''s',
    (SELECT string_agg(l.action, ' + ' ORDER BY l.action)
       FROM app_private.platform_audit_log l
      WHERE l.id > v_mark AND l.action ~ '^support_write\.'),
    'support_write.driver_notes.delete + support_write.partner_note_submissions.delete');

  PERFORM _ns_rec(33, 'exactly two audit rows in all, so the cascade added one and nothing else did',
    (SELECT count(*)::text FROM app_private.platform_audit_log l WHERE l.id > v_mark), '2');

  SELECT * INTO r_note FROM app_private.platform_audit_log l
   WHERE l.id > v_mark AND l.action = 'support_write.driver_notes.delete';
  SELECT * INTO r_sub FROM app_private.platform_audit_log l
   WHERE l.id > v_mark AND l.action = 'support_write.partner_note_submissions.delete';

  PERFORM _ns_rec(34, 'the cascaded row''s audit row names the company, the table and the row',
    r_sub.company_id::text || '/' || r_sub.target_type || '/' || r_sub.target_id,
    co_a::text || '/partner_note_submissions/' || _ns_id('sub:supp')::text);

  PERFORM _ns_rec(35, 'and the same actor, platform role, sign-in session, context and reason as the note''s',
    r_sub.actor_user_id::text || '/' || r_sub.actor_role || '/' || r_sub.session_id::text
      || '/' || (r_sub.after_value ->> 'context_id') || '/' || (r_sub.after_value ->> 'reason'),
    r_note.actor_user_id::text || '/' || r_note.actor_role || '/' || r_note.session_id::text
      || '/' || v_ctx::text || '/Ticket NS-cascade');

  -- `after_value -> 'values'` is JSON null rather than absent or SQL NULL on a
  -- delete: `record_support_write` builds both sides from one statement and the
  -- after side aggregates over no rows. Measured, so `jsonb_typeof` says it
  -- instead of a `::text` that would read as the word "null" by accident.
  PERFORM _ns_rec(36, 'a delete records the row it removed and nothing after it',
    (r_sub.before_value -> 'values' ->> 'external_submission_id')
      || '/' || coalesce(jsonb_typeof(r_sub.after_value -> 'values'), 'absent')
      || '/' || r_sub.category || '/' || r_sub.outcome,
    'ns-ext-5/null/support/ok');

  -- RECORDED, not endorsed, and not changed here.
  -- `app_private.support_write_redaction_pattern` names `driver_notes.note_text`
  -- and names nothing at all on `partner_note_submissions`, so the note's own
  -- audit row hides the free text about a person's absence while the cascaded
  -- submission's row copies the same sentence in full. Widening the pattern is
  -- a data-protection decision; making one as a side effect of a delete fix is
  -- not. This probe is here so the asymmetry is measured rather than inferred.
  PERFORM _ns_rec(37, 'the note''s audit row redacts note_text; the cascaded submission''s does not',
    (r_note.before_value -> 'values' -> 'note_text')::text
      || ' / ' || (r_sub.before_value -> 'values' ->> 'note_text'),
    '{"redacted": true} / ns support');
END $$;

-- ─── 8. the mutation controls ───────────────────────────────────────────────
--
-- Each one breaks a rule, re-runs the probes that depend on it, counts the
-- mismatches, and rolls the mutation back. Counting rather than eyeballing is
-- what makes sections 0 to 7 evidence: a probe that cannot fail proves nothing.
--
-- Re-run against a fresh driver, note and submission each time, since sections
-- 2 to 7 consumed theirs.

CREATE OR REPLACE FUNCTION _ns_battery() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_bad integer := 0;
  v_drv uuid := gen_random_uuid();
  v_nid uuid := gen_random_uuid();
  v_sid uuid := gen_random_uuid();
  v_res text;
BEGIN
  INSERT INTO drivers (id, company_id, name)
  VALUES (v_drv, _ns_id('company:a'), 'NS M ' || left(v_drv::text, 8));
  INSERT INTO driver_notes (id, created_by, driver_id, note_text, company_id)
  VALUES (v_nid, _ns_id('user:admin'), v_drv, 'ns mutation', _ns_id('company:a'));
  INSERT INTO partner_note_submissions
    (id, company_id, partner, external_submission_id, external_driver_id,
     driver_id, note_type, note_text, status, driver_note_id)
  VALUES (v_sid, _ns_id('company:a'), 'reidey', 'ns-mut-' || left(v_sid::text, 8), '9999',
          v_drv, 'general', 'ns mutation', 'accepted', v_nid);

  -- the catalogue claim
  IF _ns_action('partner_note_submissions', 'driver_note_id') IS DISTINCT FROM 'c' THEN
    v_bad := v_bad + 1;
  END IF;

  -- the delete, and the row afterwards, as two statements in one rolled-back
  -- subtransaction as the principal
  v_res := _ns_delete_then(_ns_id('user:admin'),
    format('DELETE FROM driver_notes WHERE id = %L', v_nid),
    format('SELECT count(*)::text FROM partner_note_submissions WHERE id = %L', v_sid));
  IF v_res IS DISTINCT FROM 'rows 1 / 0' THEN
    v_bad := v_bad + 1;
  END IF;

  -- the plain delete answers `rows 1` rather than a refusal
  IF _ns_try(_ns_id('user:admin'), format('DELETE FROM driver_notes WHERE id = %L', v_nid))
       IS DISTINCT FROM 'rows 1' THEN
    v_bad := v_bad + 1;
  END IF;

  -- the driver chain: two cascades, and the submission goes with it
  v_res := _ns_delete_then(_ns_id('user:admin'),
    format('DELETE FROM drivers WHERE id = %L', v_drv),
    format('SELECT count(*)::text FROM partner_note_submissions WHERE id = %L', v_sid));
  IF v_res IS DISTINCT FROM 'rows 1 / 0' THEN
    v_bad := v_bad + 1;
  END IF;

  -- and the viewer still reaches no note, the page gate being in USING
  IF _ns_try(_ns_id('user:viewer'), format('DELETE FROM driver_notes WHERE id = %L', v_nid))
       IS DISTINCT FROM 'rows 0' THEN
    v_bad := v_bad + 1;
  END IF;

  -- The fixture is deliberately NOT cleaned up. Every call makes its own ids,
  -- so nothing collides, and an unguarded delete here would abort the whole
  -- caller under mutation M1, where the constraint refuses it.
  RETURN v_bad;
END $$;

/*
  Each mutation runs inside a subtransaction that is rolled back by raising
  `ZZ011`, which is also what undoes the schema change. The COUNT is therefore
  assigned to a variable declared OUT HERE and recorded only after the handler
  has run: plpgsql variables are memory and survive the rollback, while
  anything `_ns_rec` inserted inside the block would go with it.

  `partner-submission-delete.sql` records calling `_ps_rec` inside each block
  and losing all three mutation rows to the rollback, so its verdict counted 34
  probes instead of 37 and the three silently missing were exactly the
  controls. That is why the verdict below asserts the probe COUNT first.
*/
DO $$
DECLARE
  v_m1 integer;
  v_m2 integer;
  v_m3 integer;
BEGIN
  PERFORM _ns_rec(38, 'control: against the real schema the battery has no mismatch',
    _ns_battery()::text, '0');

  -- M1. the action back to SET NULL — the defect. Four of the five probes
  --     move: the catalogue, the cascaded row, the note delete and the driver
  --     delete, all three statements refused by the CHECK. The viewer's
  --     statement reaches no row at all, so the cascade never runs and it does
  --     not move — which is the point of having it in the battery.
  BEGIN
    PERFORM _ns_set_action('n');
    v_m1 := _ns_battery();
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = 'rollback M1';
  EXCEPTION WHEN SQLSTATE 'ZZ011' THEN NULL;
  END;
  PERFORM _ns_rec(39, 'mutation M1 (ON DELETE SET NULL, the original defect) moves four of five probes',
    v_m1::text, '4');

  -- M2. NO ACTION: deleting the note is refused by the foreign key itself,
  --     23503 and not 23514, which is why the probes compare by name. The same
  --     four move, by a different wall.
  BEGIN
    PERFORM _ns_set_action('a');
    v_m2 := _ns_battery();
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = 'rollback M2';
  EXCEPTION WHEN SQLSTATE 'ZZ011' THEN NULL;
  END;
  PERFORM _ns_rec(40, 'mutation M2 (NO ACTION) moves four of five probes',
    v_m2::text, '4');

  -- M3. the page gate removed from driver_notes_delete. Only the viewer moves
  --     — to `rows 1` — so the cascade probes are not quietly measuring the
  --     role gate, and the viewer probe is not vacuous. The driver probe does
  --     not move: it is gated on the `drivers` page, not on `notes`.
  BEGIN
    EXECUTE 'DROP POLICY driver_notes_delete ON public.driver_notes';
    EXECUTE $p$CREATE POLICY driver_notes_delete ON public.driver_notes FOR DELETE TO authenticated
                 USING (company_id = (SELECT get_active_company_id()))$p$;
    v_m3 := _ns_battery();
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = 'rollback M3';
  EXCEPTION WHEN SQLSTATE 'ZZ011' THEN NULL;
  END;
  PERFORM _ns_rec(41, 'mutation M3 (the notes page gate dropped) moves one of five probes',
    v_m3::text, '1');

  PERFORM _ns_rec(42, 'control: after the three mutations are rolled back the battery is clean again',
    _ns_battery()::text, '0');
END $$;

-- ─── the verdict, all at once ───────────────────────────────────────────────

DO $$
DECLARE
  v_bad integer;
  r     record;
  v_msg text := '';
BEGIN
  -- A probe that never recorded cannot fail, so the count is asserted first.
  IF (SELECT count(*) FROM _ns_out) <> 42 THEN
    RAISE EXCEPTION 'note submission delete: % of 42 probes recorded — missing: %',
      (SELECT count(*) FROM _ns_out),
      (SELECT string_agg(n::text, ', ' ORDER BY n) FROM generate_series(1, 42) AS g(n)
        WHERE NOT EXISTS (SELECT 1 FROM _ns_out o WHERE o.n = g.n));
  END IF;

  SELECT count(*) INTO v_bad FROM _ns_out WHERE NOT matched;
  IF v_bad = 0 THEN
    RAISE NOTICE '── note submission delete: all % probes matched ──',
      (SELECT count(*) FROM _ns_out);
    RETURN;
  END IF;
  FOR r IN SELECT * FROM _ns_out WHERE NOT matched ORDER BY n LOOP
    v_msg := v_msg || format(E'\n  %s. %s\n     expected: %s\n     actual:   %s',
                             r.n, r.label, r.expected, r.actual);
  END LOOP;
  RAISE EXCEPTION 'note submission delete: % of % probes did not match:%',
    v_bad, (SELECT count(*) FROM _ns_out), v_msg;
END $$;

ROLLBACK;
