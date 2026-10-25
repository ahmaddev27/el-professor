/*
  Deleting a Beleg deletes its partner submission (20261023150000).

  `partner_receipt_submissions.receipt_id` carried `ON DELETE SET NULL` against
  `CHECK ((status = 'accepted') = (receipt_id IS NOT NULL))`, so deleting the
  Beleg nulled the reference, the CHECK saw an accepted submission naming no
  Beleg, and the whole DELETE rolled back. Every Beleg produced by an accepted
  submission was permanently undeletable — 20 of them on production, measured
  read-only on 23.10.2026. The owner chose `ON DELETE CASCADE` the same day.

  ## What each section says, and why it is not obvious

  0. The catalogue. The action is CASCADE, there is exactly one foreign key on
     the column, it still points at `public.receipts`, the accepted-has-receipt
     CHECK is still there, the table still has no client write policy, and both
     context triggers and the tenant SELECT policy are untouched. Without that
     last part a migration that "fixed" the delete by granting the table away
     would pass every behavioural probe below.

  1. The defect itself, reproduced. The cascade is swapped back to SET NULL and
     the delete is run: refused, `23514`, by the constraint's NAME. That name is
     the whole point — `partner_receipt_submissions` carries three other CHECKs
     (`..._rejected_has_reason`, `..._has_subject`, the inline `status` and
     `category` ones) and `receipts` carries several more, all raising 23514, so
     a probe that read only the SQLSTATE would pass on the wrong refusal. The
     original action is then restored and the delete is run again.

     This is also the before-and-after in one file: section 1 is the old
     behaviour and section 2 the new one, measured in the same run against the
     same fixture, so neither is a claim about the other.

  2. The delete, and the row afterwards. A Beleg with an accepted submission is
     deleted and the submission row is GONE — not nulled, not left `accepted`
     pointing at nothing. Both halves are asserted, because a cascade that
     silently became SET NULL would still let the delete through while leaving a
     row that lies, which is the state `20261007100000` was written to prevent.

  3. The crux: a cascade is not the caller's statement. The delete is run as a
     company ADMINISTRATOR holding the `receipts` page — a caller who has no
     DELETE policy on `partner_receipt_submissions`, and on production no DELETE
     *grant* there either (measured read-only: `authenticated` holds SELECT,
     TRIGGER, TRUNCATE and UPDATE and nothing else). The cascade still removes
     the row, because PostgreSQL runs a referential action as the table's owner
     and bypasses row security. The control beside it is the same principal's
     own DELETE on that table, which removes nothing and leaves the row — so
     the section shows the cascade reaching a row the caller cannot touch
     directly, rather than merely that something happened.

     CORRECTED 23.10.2026 (`20261023160000`): this paragraph read that the
     fixture and production differ on the DELETE grant, so that the caller's
     own statement answers `rows 0` here and `42501` there. Re-measured
     read-only on production, both partner submission tables carry the FULL
     Supabase default set, DELETE and INSERT included, for all three API
     roles. So the two agree and the wall is the MISSING DELETE POLICY alone,
     which is why probe 15 asserts the row's survival as well as the answer.

  4. The neighbours. A Beleg with no submission at all still deletes; a
     `pending` submission belonging to a DIFFERENT Beleg is untouched by the
     delete of the first; and a `rejected` submission, whose `receipt_id` is
     NULL by the same CHECK, is likewise untouched. A cascade that keyed on the
     company rather than the row would fail here and nowhere else.

  5. Tenancy and the role gate on `receipts` DELETE, unchanged. Both the tenant
     term and `current_role_permits('receipts', true)` are in `USING`, so a
     viewer and an administrator of the other company are both answered `rows
     0` rather than a refusal — the row is not in the statement's scope, which
     is the shape `writeOutcome.ts` exists for. An editor, who holds the page,
     deletes. Measured here rather than reasoned: this section's first draft
     expected `42501` for the viewer, copied from `receipt-date.sql`, where the
     probe is an INSERT and a refused `WITH CHECK` does raise. A DELETE has no
     `WITH CHECK` to fail. What makes the section evidence is that no role
     reaches the Beleg, so the cascade never runs and both rows survive.

  6. The support-write audit. A cascade fires row triggers, so a platform
     owner inside a support session on the company deletes the Beleg and gets
     TWO audit rows, `support_write.receipts.delete` and
     `support_write.partner_receipt_submissions.delete`, both naming the
     session's company, its context and its reason. That is measured rather
     than assumed: if statement-level triggers did not fire on the internal
     cascade the flag would be unarmed for that row and `record_support_write`'s
     WHEN gate would skip it, giving one row instead of two; and if the
     audit function's section-5 company wall saw the submission as another
     company's row it would refuse and roll the operator's delete back.

  7. The mutation controls, which are what make sections 0 to 6 worth reading.

  ## What it does not claim

  Tenancy and the role gate on `receipts` in general (matrix.sql,
  tenant-state.sql, permission-coverage.sql), the submission tables' own
  shape (partner-receipt-accept.sql, driver-deletion.sql section 6), the
  redaction rules of the audit row (support-write-audit.sql), and nothing at
  all about `partner_note_submissions.driver_note_id`, which deliberately keeps
  `ON DELETE SET NULL` and therefore keeps the same defect — three accepted
  note submissions on production, the owner's call. `driver-deletion.sql`
  probes 9 to 12 own that cell and will flip when it is answered.

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

CREATE TEMP TABLE _ps_out (
  n        integer PRIMARY KEY,
  label    text    NOT NULL,
  actual   text    NOT NULL,
  expected text    NOT NULL,
  matched  boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _ps_rec(p_n integer, p_label text, p_actual text, p_expected text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ok boolean := p_actual IS NOT DISTINCT FROM p_expected;
BEGIN
  INSERT INTO _ps_out VALUES (p_n, p_label, coalesce(p_actual, '<null>'), p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', coalesce(p_actual, '<null>');
  END IF;
END $$;

/* Stable ids, so a probe's subject can be named in a label. */
CREATE OR REPLACE FUNCTION _ps_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_what
    -- the seed's principals of company A (roles-seed.sql: admin and editor hold
    -- can_edit on `receipts`, viewer holds it nowhere)
    WHEN 'user:admin'    THEN 'a0000000-0000-4000-8000-000000000001'::uuid
    WHEN 'user:editor'   THEN 'a0000000-0000-4000-8000-000000000002'::uuid
    WHEN 'user:viewer'   THEN 'a0000000-0000-4000-8000-000000000003'::uuid
    WHEN 'user:admin-b'  THEN 'b0000000-0000-4000-8000-000000000001'::uuid
    WHEN 'company:a'     THEN 'c0000000-0000-4000-8000-00000000000a'::uuid
    WHEN 'company:b'     THEN 'c0000000-0000-4000-8000-00000000000b'::uuid
    -- this file's own platform owner and its sign-in session (section 6)
    WHEN 'user:owner'    THEN 'fa000000-0000-4000-8000-0000000000f1'::uuid
    WHEN 'session:owner' THEN 'fa000000-0000-4000-8000-0000000000f2'::uuid
    -- the Belege and the submissions
    WHEN 'receipt:acc'   THEN 'fa000000-0000-4000-8000-000000000001'::uuid
    WHEN 'receipt:bare'  THEN 'fa000000-0000-4000-8000-000000000002'::uuid
    WHEN 'receipt:pend'  THEN 'fa000000-0000-4000-8000-000000000003'::uuid
    WHEN 'receipt:tenant' THEN 'fa000000-0000-4000-8000-000000000004'::uuid
    WHEN 'receipt:supp'  THEN 'fa000000-0000-4000-8000-000000000005'::uuid
    WHEN 'sub:acc'       THEN 'fa000000-0000-4000-8000-00000000000a'::uuid
    WHEN 'sub:pend'      THEN 'fa000000-0000-4000-8000-00000000000b'::uuid
    WHEN 'sub:rej'       THEN 'fa000000-0000-4000-8000-00000000000c'::uuid
    WHEN 'sub:tenant'    THEN 'fa000000-0000-4000-8000-00000000000d'::uuid
    WHEN 'sub:supp'      THEN 'fa000000-0000-4000-8000-00000000000e'::uuid
  END
$$;

/*
  Become a principal for the rest of the current subtransaction. The plans go
  first: schema USAGE and function EXECUTE are resolved when a statement is
  planned, the owner runs every fixture, and a plan the owner cached would let
  every principal after it through (matrix.sql's `_mx_become` has the account).
*/
CREATE OR REPLACE FUNCTION _ps_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
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

CREATE OR REPLACE FUNCTION _ps_reset() RETURNS void
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
/*
  A DELETE and a count of what it reached, as TWO statements in one
  subtransaction that is always rolled back, and both answers in one string:
  `rows N / <scalar>`, or the refusal.

  Two statements and not one, because **a data-modifying CTE's effect is not
  visible to the rest of its own statement**: `WITH d AS (DELETE … RETURNING 1)
  SELECT count(*) FROM …` reads the snapshot from before the statement and so
  counts the row the cascade has just removed. The first draft of this file used
  that form and the kit answered 1 where 0 was expected, which is the engine
  being right and the probe being wrong.
*/
CREATE OR REPLACE FUNCTION _ps_delete_then(p_user uuid, p_delete_sql text, p_count_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_n     text;
  v_state text;
  v_con   text;
BEGIN
  BEGIN
    PERFORM _ps_as(p_user);
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
  PERFORM _ps_reset();
  RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION _ps_try(p_user uuid, p_sql text, p_session uuid DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_con   text;
BEGIN
  BEGIN
    PERFORM _ps_as(p_user, p_session);
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
  PERFORM _ps_reset();
  RETURN v_out;
END $$;

/** The delete action of one column's single foreign key: c = CASCADE, n = SET NULL. */
CREATE OR REPLACE FUNCTION _ps_action(p_table text, p_column text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT c.confdeltype::text
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = ('public.' || p_table)::regclass
     AND c.contype = 'f' AND a.attname = p_column
     AND array_length(c.conkey, 1) = 1
$$;

/** Replace that foreign key's action, for the mutations. */
CREATE OR REPLACE FUNCTION _ps_set_action(p_action text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_name text;
BEGIN
  SELECT c.conname INTO v_name
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'public.partner_receipt_submissions'::regclass
     AND c.contype = 'f' AND a.attname = 'receipt_id';
  EXECUTE format('ALTER TABLE public.partner_receipt_submissions DROP CONSTRAINT %I', v_name);
  EXECUTE format(
    'ALTER TABLE public.partner_receipt_submissions '
    'ADD CONSTRAINT partner_receipt_submissions_receipt_id_fkey '
    'FOREIGN KEY (receipt_id) REFERENCES public.receipts(id) ON DELETE %s',
    CASE p_action WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' ELSE 'NO ACTION' END);
END $$;

-- ─── fixtures ───────────────────────────────────────────────────────────────
--
-- Five Belege in company A, one in company B, and one submission each where a
-- submission is the point. `date` is inside `receipts_date_plausible`
-- (20261023140000); `driver_name` is free text with no key behind it, as that
-- column has always been.

INSERT INTO receipts (id, company_id, receipt_number, date, description, driver_name) VALUES
  (_ps_id('receipt:acc'),    _ps_id('company:a'), 'BEL-PS-1', '2026-10-01', 'ps accepted',  'Driver A'),
  (_ps_id('receipt:bare'),   _ps_id('company:a'), 'BEL-PS-2', '2026-10-02', 'ps no sub',    'Driver A'),
  (_ps_id('receipt:pend'),   _ps_id('company:a'), 'BEL-PS-3', '2026-10-03', 'ps pending',   'Driver A'),
  (_ps_id('receipt:tenant'), _ps_id('company:a'), 'BEL-PS-4', '2026-10-04', 'ps tenant',    'Driver A'),
  (_ps_id('receipt:supp'),   _ps_id('company:a'), 'BEL-PS-5', '2026-10-05', 'ps support',   'Driver A');

INSERT INTO partner_receipt_submissions
  (id, company_id, partner, external_submission_id, external_driver_id,
   description, status, receipt_id, rejected_reason)
VALUES
  -- accepted, naming the Beleg section 2 deletes
  (_ps_id('sub:acc'),    _ps_id('company:a'), 'reidey', 'ps-ext-1', '9001',
   'ps accepted', 'accepted', _ps_id('receipt:acc'),    NULL),
  -- pending, naming no Beleg: section 4's bystander
  (_ps_id('sub:pend'),   _ps_id('company:a'), 'reidey', 'ps-ext-2', '9002',
   'ps pending',  'pending',  NULL,                     NULL),
  -- rejected, naming no Beleg by the same CHECK: section 4's second bystander
  (_ps_id('sub:rej'),    _ps_id('company:a'), 'reidey', 'ps-ext-3', '9003',
   'ps rejected', 'rejected', NULL,                     'ps: not a business expense'),
  -- accepted, for the tenancy and role probes of section 5
  (_ps_id('sub:tenant'), _ps_id('company:a'), 'reidey', 'ps-ext-4', '9004',
   'ps tenant',   'accepted', _ps_id('receipt:tenant'), NULL),
  -- accepted, for the support session of section 6
  (_ps_id('sub:supp'),   _ps_id('company:a'), 'reidey', 'ps-ext-5', '9005',
   'ps support',  'accepted', _ps_id('receipt:supp'),   NULL);

-- ─── 0. the catalogue ───────────────────────────────────────────────────────

DO $$
DECLARE v_n bigint;
BEGIN
  PERFORM _ps_rec(1, 'receipt_id''s foreign key is ON DELETE CASCADE',
    _ps_action('partner_receipt_submissions', 'receipt_id'), 'c');

  PERFORM _ps_rec(2, 'and it is the only foreign key on the column, under its own name',
    (SELECT string_agg(c.conname, ', ' ORDER BY c.conname)
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conrelid = 'public.partner_receipt_submissions'::regclass
        AND c.contype = 'f' AND a.attname = 'receipt_id'),
    'partner_receipt_submissions_receipt_id_fkey');

  PERFORM _ps_rec(3, 'and it still references public.receipts',
    (SELECT c.confrelid::regclass::text FROM pg_constraint c
      WHERE c.conrelid = 'public.partner_receipt_submissions'::regclass
        AND c.conname = 'partner_receipt_submissions_receipt_id_fkey'),
    'receipts');

  -- The CHECK is kept deliberately: it no longer has anything to say about a
  -- delete, but it is still the only thing stopping the intake or a judging RPC
  -- from filing an accepted submission that names no Beleg.
  PERFORM _ps_rec(4, 'the accepted-has-receipt CHECK is still there',
    (SELECT count(*)::text FROM pg_constraint
      WHERE conrelid = 'public.partner_receipt_submissions'::regclass
        AND conname = 'partner_receipt_submissions_accepted_has_receipt'), '1');

  PERFORM _ps_rec(5, 'no client write policy on the submission table',
    (SELECT coalesce(string_agg(policyname || ' (' || cmd || ')', ', '), 'none')
       FROM pg_policies WHERE schemaname = 'public'
        AND tablename = 'partner_receipt_submissions'
        AND cmd IN ('INSERT', 'UPDATE', 'DELETE')), 'none');

  -- CORRECTED 23.10.2026, re-measured read-only on production while the note
  -- sibling was being fixed (`20261023160000`). This comment used to say
  -- `authenticated` holds SELECT, TRIGGER, TRUNCATE and UPDATE here and no
  -- DELETE, so that a member's own DELETE is 42501 in production where the
  -- fixture answers `rows 0`. **That is wrong.** Both partner submission
  -- tables carry the full Supabase default set on production -- DELETE,
  -- INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE -- for `anon`,
  -- `authenticated` and `service_role` alike. The fixture and production
  -- agree, and the only thing keeping a member out of this table is the
  -- MISSING DELETE POLICY (probe 5), which puts the row outside the
  -- statement's scope and answers `rows 0`. The probe's assertion is unchanged
  -- and still passes; only the reason recorded beside it was false, and probe
  -- 15 asserting the row's survival is what carries the point either way.
  PERFORM _ps_rec(6, 'production and the fixture both grant `authenticated` DELETE here, so the missing policy is the only wall',
    (SELECT coalesce(string_agg(privilege_type, ',' ORDER BY privilege_type), 'none')
       FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'partner_receipt_submissions'
        AND grantee = 'authenticated' AND privilege_type = 'DELETE'), 'DELETE');

  PERFORM _ps_rec(7, 'the tenant SELECT policy and both context triggers are untouched',
    (SELECT (SELECT count(*) FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'partner_receipt_submissions'
                AND cmd = 'SELECT' AND qual LIKE '%get_active_company_id%')::text
            || '/' ||
            (SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
              WHERE c.relnamespace = 'public'::regnamespace
                AND c.relname = 'partner_receipt_submissions'
                AND g.tgname IN ('refuse_read_only_context_write', 'record_support_write')
                AND NOT g.tgisinternal)::text),
    '1/2');
END $$;

-- ─── 1. the defect, reproduced ──────────────────────────────────────────────
-- The action is swapped back to SET NULL and the same delete is run. This is
-- the measurement the migration's header rests on, taken here rather than
-- quoted. Compared by the constraint's name: `receipts` and
-- `partner_receipt_submissions` carry several other CHECKs that raise 23514.

DO $$
DECLARE v_was text;
BEGIN
  v_was := _ps_action('partner_receipt_submissions', 'receipt_id');
  PERFORM _ps_set_action('n');

  PERFORM _ps_rec(8, 'with ON DELETE SET NULL the Beleg cannot be deleted at all',
    _ps_try(_ps_id('user:admin'),
      format('DELETE FROM receipts WHERE id = %L', _ps_id('receipt:acc'))),
    'ERR 23514 partner_receipt_submissions_accepted_has_receipt');

  PERFORM _ps_rec(9, 'not even as the table owner, because it is a constraint and not a policy',
    _ps_try(NULL,
      format('DELETE FROM receipts WHERE id = %L', _ps_id('receipt:acc'))),
    'ERR 23514 partner_receipt_submissions_accepted_has_receipt');

  PERFORM _ps_set_action(v_was);
  PERFORM _ps_rec(10, 'and the action is back to CASCADE for the sections below',
    _ps_action('partner_receipt_submissions', 'receipt_id'), 'c');
END $$;

-- ─── 2. the delete, and the row afterwards ──────────────────────────────────

DO $$
BEGIN
  PERFORM _ps_rec(11, 'a Beleg behind an accepted submission is deleted',
    _ps_try(_ps_id('user:admin'),
      format('DELETE FROM receipts WHERE id = %L', _ps_id('receipt:acc'))),
    'rows 1');

  -- `_ps_try` rolls its subtransaction back, so the row is still here to be
  -- deleted for real below. Doing it twice is deliberate: the probe above
  -- measures the statement's answer, the one below the state it leaves.
  DELETE FROM receipts WHERE id = _ps_id('receipt:acc');

  PERFORM _ps_rec(12, 'the Beleg is gone',
    (SELECT count(*)::text FROM receipts WHERE id = _ps_id('receipt:acc')), '0');

  PERFORM _ps_rec(13, 'and its submission is GONE — not nulled, not left accepted naming nothing',
    (SELECT count(*)::text FROM partner_receipt_submissions WHERE id = _ps_id('sub:acc')), '0');

  PERFORM _ps_rec(14, 'so no accepted submission anywhere names a Beleg that does not exist',
    (SELECT count(*)::text FROM partner_receipt_submissions s
      WHERE s.receipt_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.id = s.receipt_id)), '0');
END $$;

-- ─── 3. a cascade is not the caller's statement ─────────────────────────────
-- Probe 11 above was already a company administrator, who holds neither a
-- DELETE policy nor a DELETE grant on the submission table (probes 5 and 6).
-- The two probes here are the control that makes that meaningful: the same
-- principal cannot reach the row directly, in either direction.

DO $$
BEGIN
  -- `rows 0` and not a refusal: with no DELETE policy the statement matches no
  -- row and reports success having changed nothing — `fahrtenbuch_trips`' shape
  -- and the class recorded as "a DELETE the SELECT policy hides removes zero
  -- rows and reports success". Production answers the same, the grant being
  -- present there too (probe 6, corrected 23.10.2026), so this is the
  -- product's behaviour and not a fixture artefact; the second half of the
  -- probe is what makes it evidence -- the row is still there.
  PERFORM _ps_rec(15, 'the same administrator''s own DELETE on the submission table removes nothing, and the row survives it',
    _ps_delete_then(_ps_id('user:admin'),
      format('DELETE FROM partner_receipt_submissions WHERE id = %L', _ps_id('sub:tenant')),
      format('SELECT count(*)::text FROM partner_receipt_submissions WHERE id = %L', _ps_id('sub:tenant'))),
    'rows 0 / 1');

  PERFORM _ps_rec(16, 'nor can that principal clear the reference by hand (no UPDATE policy since 20261008160000)',
    _ps_try(_ps_id('user:admin'),
      format('UPDATE partner_receipt_submissions SET status = %L, receipt_id = NULL, rejected_reason = %L WHERE id = %L',
             'rejected', 'by hand', _ps_id('sub:tenant'))),
    'rows 0');

  -- …yet the cascade reaches exactly that row through its Beleg.
  PERFORM _ps_rec(17, 'but deleting its Beleg does remove it, as the table''s owner',
    _ps_delete_then(_ps_id('user:admin'),
      format('DELETE FROM receipts WHERE id = %L', _ps_id('receipt:tenant')),
      format('SELECT count(*)::text FROM partner_receipt_submissions WHERE id = %L', _ps_id('sub:tenant'))),
    'rows 1 / 0');
END $$;

-- ─── 4. the neighbours ──────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _ps_rec(18, 'a Beleg with no submission at all still deletes',
    _ps_try(_ps_id('user:admin'),
      format('DELETE FROM receipts WHERE id = %L', _ps_id('receipt:bare'))),
    'rows 1');

  PERFORM _ps_rec(19, 'the pending submission is untouched by section 2''s delete',
    (SELECT status || '/' || coalesce(receipt_id::text, 'null')
       FROM partner_receipt_submissions WHERE id = _ps_id('sub:pend')),
    'pending/null');

  PERFORM _ps_rec(20, 'and so is the rejected one',
    (SELECT status || '/' || coalesce(receipt_id::text, 'null')
       FROM partner_receipt_submissions WHERE id = _ps_id('sub:rej')),
    'rejected/null');

  -- Deleting a Beleg that no submission names must not reach the company's
  -- other submissions. A cascade keyed on company_id rather than on the row
  -- would fail here and pass everything above.
  PERFORM _ps_rec(21, 'deleting an unrelated Beleg leaves every remaining submission of the company',
    _ps_delete_then(_ps_id('user:admin'),
      format('DELETE FROM receipts WHERE id = %L', _ps_id('receipt:pend')),
      format('SELECT count(*)::text FROM partner_receipt_submissions WHERE company_id = %L',
             _ps_id('company:a'))),
    'rows 1 / 4');
END $$;

-- ─── 5. tenancy and the role gate on receipts DELETE, unchanged ─────────────
--
-- `receipts_delete` is the tenant term AND `current_role_permits('receipts',
-- true)`, both in `USING`. So a viewer is answered `rows 0`, NOT a refusal:
-- the row is simply not in the statement's scope, which is the shape CLAUDE.md
-- states and `writeOutcome.ts` exists for. The first draft of this file
-- expected `42501` here, copied from `receipt-date.sql`, where the probe is an
-- INSERT and a refused `WITH CHECK` does raise — a DELETE has no `WITH CHECK`
-- to fail. The kit answered `rows 0` and it was right.
--
-- What makes the section meaningful is therefore the second half of each
-- probe: no role reaches the Beleg, so the cascade never runs, so both rows
-- are still there (probe 25). Mutation M3 moves exactly this probe.

DO $$
BEGIN
  PERFORM _ps_rec(22, 'a viewer reaches no Beleg: the page gate is in USING, so the statement matches nothing',
    _ps_try(_ps_id('user:viewer'),
      format('DELETE FROM receipts WHERE id = %L', _ps_id('receipt:supp'))),
    'rows 0');

  PERFORM _ps_rec(23, 'an editor, who holds the receipts page, may',
    _ps_try(_ps_id('user:editor'),
      format('DELETE FROM receipts WHERE id = %L', _ps_id('receipt:supp'))),
    'rows 1');

  PERFORM _ps_rec(24, 'an administrator of the other company reaches no row of this one',
    _ps_try(_ps_id('user:admin-b'),
      format('DELETE FROM receipts WHERE id = %L', _ps_id('receipt:supp'))),
    'rows 0');

  PERFORM _ps_rec(25, 'and after all three the Beleg and its submission are both still there',
    (SELECT (SELECT count(*) FROM receipts WHERE id = _ps_id('receipt:supp'))::text || '/' ||
            (SELECT count(*) FROM partner_receipt_submissions WHERE id = _ps_id('sub:supp'))::text),
    '1/1');
END $$;

-- ─── 6. the support-write audit on a cascaded row ───────────────────────────
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
-- The writes here are made outside `_ps_try`, because the audit row is the
-- subject and a rolled-back subtransaction would take it with it.

INSERT INTO auth.users (id, email, email_confirmed_at)
VALUES (_ps_id('user:owner'), 'ps-owner@test.invalid', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
VALUES (_ps_id('user:owner'), 'ps-owner@test.invalid', 'PS Owner', 'viewer',
        (SELECT r.id FROM roles r WHERE r.name = 'viewer' AND r.company_id IS NULL),
        NULL, 'active')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES (_ps_id('user:owner'), 'owner', 'ps')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
VALUES (_ps_id('session:owner'), _ps_id('user:owner'))
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  co_a   constant uuid := _ps_id('company:a');
  u_o    constant uuid := _ps_id('user:owner');
  s_o    constant uuid := _ps_id('session:owner');
  v_open jsonb;
  v_ctx  uuid;
  v_mark bigint;
  r_rec  app_private.platform_audit_log%ROWTYPE;
  r_sub  app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _ps_as(u_o, s_o);
  v_open := public.platform_context_open(co_a, 'support', 'Ticket PS-cascade');
  PERFORM _ps_reset();

  PERFORM _ps_rec(26, 'the platform owner opens a support session on company A',
    (v_open ->> 'success'), 'true');
  v_ctx := (v_open -> 'context' ->> 'id')::uuid;

  SELECT coalesce(max(l.id), 0) INTO v_mark FROM app_private.platform_audit_log l;

  PERFORM _ps_as(u_o, s_o);
  DELETE FROM receipts WHERE id = _ps_id('receipt:supp');
  PERFORM _ps_reset();

  PERFORM _ps_rec(27, 'the support session deletes the Beleg, and the cascade removes the submission',
    (SELECT (SELECT count(*) FROM receipts WHERE id = _ps_id('receipt:supp'))::text || '/' ||
            (SELECT count(*) FROM partner_receipt_submissions WHERE id = _ps_id('sub:supp'))::text),
    '0/0');

  PERFORM _ps_rec(28, 'and it leaves TWO support_write rows, the Beleg''s and the cascaded submission''s',
    (SELECT string_agg(l.action, ' + ' ORDER BY l.action)
       FROM app_private.platform_audit_log l
      WHERE l.id > v_mark AND l.action ~ '^support_write\.'),
    'support_write.partner_receipt_submissions.delete + support_write.receipts.delete');

  PERFORM _ps_rec(29, 'exactly two audit rows in all, so the cascade added one and nothing else did',
    (SELECT count(*)::text FROM app_private.platform_audit_log l WHERE l.id > v_mark), '2');

  SELECT * INTO r_rec FROM app_private.platform_audit_log l
   WHERE l.id > v_mark AND l.action = 'support_write.receipts.delete';
  SELECT * INTO r_sub FROM app_private.platform_audit_log l
   WHERE l.id > v_mark AND l.action = 'support_write.partner_receipt_submissions.delete';

  PERFORM _ps_rec(30, 'the cascaded row''s audit row names the company, the table and the row',
    r_sub.company_id::text || '/' || r_sub.target_type || '/' || r_sub.target_id,
    co_a::text || '/partner_receipt_submissions/' || _ps_id('sub:supp')::text);

  PERFORM _ps_rec(31, 'and the same actor, platform role, sign-in session, context and reason as the Beleg''s',
    r_sub.actor_user_id::text || '/' || r_sub.actor_role || '/' || r_sub.session_id::text
      || '/' || (r_sub.after_value ->> 'context_id') || '/' || (r_sub.after_value ->> 'reason'),
    r_rec.actor_user_id::text || '/' || r_rec.actor_role || '/' || r_rec.session_id::text
      || '/' || v_ctx::text || '/Ticket PS-cascade');

  -- `after_value -> 'values'` is JSON null rather than absent or SQL NULL on a
  -- delete: `record_support_write` builds both sides from one statement and the
  -- after side aggregates over no rows. Measured, so `jsonb_typeof` says it
  -- instead of a `::text` that would read as the word "null" by accident.
  PERFORM _ps_rec(32, 'a delete records the row it removed and nothing after it',
    (r_sub.before_value -> 'values' ->> 'external_submission_id')
      || '/' || coalesce(jsonb_typeof(r_sub.after_value -> 'values'), 'absent')
      || '/' || r_sub.category || '/' || r_sub.outcome,
    'ps-ext-5/null/support/ok');
END $$;

-- ─── 7. the mutation controls ───────────────────────────────────────────────
--
-- Each one breaks a rule, re-runs the probes that depend on it, counts the
-- mismatches, and rolls the mutation back. Counting rather than eyeballing is
-- what makes sections 0 to 6 evidence: a probe that cannot fail proves nothing.
--
-- Re-run against a fresh Beleg each time, since sections 2 to 6 consumed
-- theirs.

CREATE OR REPLACE FUNCTION _ps_battery() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_bad integer := 0;
  v_rid uuid := gen_random_uuid();
  v_sid uuid := gen_random_uuid();
  v_res text;
BEGIN
  INSERT INTO receipts (id, company_id, receipt_number, date, description, driver_name)
  VALUES (v_rid, _ps_id('company:a'), 'BEL-PS-M-' || left(v_rid::text, 8),
          '2026-10-06', 'ps mutation', 'Driver A');
  INSERT INTO partner_receipt_submissions
    (id, company_id, partner, external_submission_id, external_driver_id,
     description, status, receipt_id)
  VALUES (v_sid, _ps_id('company:a'), 'reidey', 'ps-mut-' || left(v_sid::text, 8), '9999',
          'ps mutation', 'accepted', v_rid);

  -- the catalogue claim
  IF _ps_action('partner_receipt_submissions', 'receipt_id') IS DISTINCT FROM 'c' THEN
    v_bad := v_bad + 1;
  END IF;

  -- the delete, and the row afterwards, as two statements in one rolled-back
  -- subtransaction as the principal
  v_res := _ps_delete_then(_ps_id('user:admin'),
    format('DELETE FROM receipts WHERE id = %L', v_rid),
    format('SELECT count(*)::text FROM partner_receipt_submissions WHERE id = %L', v_sid));
  IF v_res IS DISTINCT FROM 'rows 1 / 0' THEN
    v_bad := v_bad + 1;
  END IF;

  -- the plain delete answers `rows 1` rather than a refusal
  IF _ps_try(_ps_id('user:admin'), format('DELETE FROM receipts WHERE id = %L', v_rid))
       IS DISTINCT FROM 'rows 1' THEN
    v_bad := v_bad + 1;
  END IF;

  -- and the viewer still reaches no row, the page gate being in USING
  IF _ps_try(_ps_id('user:viewer'), format('DELETE FROM receipts WHERE id = %L', v_rid))
       IS DISTINCT FROM 'rows 0' THEN
    v_bad := v_bad + 1;
  END IF;

  -- The fixture is deliberately NOT cleaned up. Every call makes its own ids,
  -- so nothing collides, and an unguarded `DELETE FROM receipts` here aborts
  -- the whole caller under mutation M1, where the constraint refuses it — which
  -- is exactly how the first version of this file ended, with the battery's
  -- cleanup killing the DO block instead of returning a count.
  RETURN v_bad;
END $$;

/*
  Each mutation runs inside a subtransaction that is rolled back by raising
  `ZZ011`, which is also what undoes the schema change. The COUNT is therefore
  assigned to a variable declared OUT HERE and recorded only after the handler
  has run: plpgsql variables are memory and survive the rollback, while
  anything `_ps_rec` inserted inside the block would go with it.

  The first version of this file called `_ps_rec` inside each block, so all
  three mutation rows were rolled back and the verdict counted 34 probes
  instead of 37 — the three that were silently missing were exactly the
  controls, so a wrong count would never have failed the run. That is the
  "a probe that cannot fail proves nothing" trap, and the kit printing its
  probe count is what exposed it.
*/
DO $$
DECLARE
  v_m1  integer;
  v_m2  integer;
  v_m3  integer;
BEGIN
  PERFORM _ps_rec(33, 'control: against the real schema the battery has no mismatch',
    _ps_battery()::text, '0');

  -- M1. the action back to SET NULL — the defect. Three of the four probes
  --     move: the catalogue, the cascaded row, and the delete itself, which is
  --     refused by the CHECK. The viewer's statement reaches no row at all, so
  --     the cascade never runs and it does not move — which is the point of
  --     having it in the battery.
  BEGIN
    PERFORM _ps_set_action('n');
    v_m1 := _ps_battery();
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = 'rollback M1';
  EXCEPTION WHEN SQLSTATE 'ZZ011' THEN NULL;
  END;
  PERFORM _ps_rec(34, 'mutation M1 (ON DELETE SET NULL, the original defect) moves three of four probes',
    v_m1::text, '3');

  -- M2. NO ACTION: deleting the Beleg is refused by the foreign key itself,
  --     23503 and not 23514, which is why the probes compare by name. Two move
  --     (the catalogue and the delete); the cascaded-row probe moves with it
  --     because its statement is the one that is refused.
  BEGIN
    PERFORM _ps_set_action('a');
    v_m2 := _ps_battery();
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = 'rollback M2';
  EXCEPTION WHEN SQLSTATE 'ZZ011' THEN NULL;
  END;
  PERFORM _ps_rec(35, 'mutation M2 (NO ACTION) moves three of four probes',
    v_m2::text, '3');

  -- M3. the page gate removed from receipts_delete. Only the viewer moves — to
  --     `rows 1` — so the cascade probes are not quietly measuring the role
  --     gate, and the viewer probe is not vacuous.
  BEGIN
    EXECUTE 'DROP POLICY receipts_delete ON public.receipts';
    EXECUTE $p$CREATE POLICY receipts_delete ON public.receipts FOR DELETE TO authenticated
                 USING (company_id = (SELECT get_active_company_id()))$p$;
    v_m3 := _ps_battery();
    RAISE EXCEPTION USING ERRCODE = 'ZZ011', MESSAGE = 'rollback M3';
  EXCEPTION WHEN SQLSTATE 'ZZ011' THEN NULL;
  END;
  PERFORM _ps_rec(36, 'mutation M3 (the receipts page gate dropped) moves one of four probes',
    v_m3::text, '1');

  PERFORM _ps_rec(37, 'control: after the three mutations are rolled back the battery is clean again',
    _ps_battery()::text, '0');
END $$;

-- ─── the verdict, all at once ───────────────────────────────────────────────

DO $$
DECLARE
  v_bad integer;
  r     record;
  v_msg text := '';
BEGIN
  -- A probe that never recorded cannot fail, so the count is asserted first.
  -- This file's mutation controls were rolled back with their own
  -- subtransactions once and the run was green with 34 of 37 rows present.
  IF (SELECT count(*) FROM _ps_out) <> 37 THEN
    RAISE EXCEPTION 'partner submission delete: % of 37 probes recorded — missing: %',
      (SELECT count(*) FROM _ps_out),
      (SELECT string_agg(n::text, ', ' ORDER BY n) FROM generate_series(1, 37) AS g(n)
        WHERE NOT EXISTS (SELECT 1 FROM _ps_out o WHERE o.n = g.n));
  END IF;

  SELECT count(*) INTO v_bad FROM _ps_out WHERE NOT matched;
  IF v_bad = 0 THEN
    RAISE NOTICE '── partner submission delete: all % probes matched ──',
      (SELECT count(*) FROM _ps_out);
    RETURN;
  END IF;
  FOR r IN SELECT * FROM _ps_out WHERE NOT matched ORDER BY n LOOP
    v_msg := v_msg || format(E'\n  %s. %s\n     expected: %s\n     actual:   %s',
                             r.n, r.label, r.expected, r.actual);
  END LOOP;
  RAISE EXCEPTION 'partner submission delete: % of % probes did not match:%',
    v_bad, (SELECT count(*) FROM _ps_out), v_msg;
END $$;

ROLLBACK;
