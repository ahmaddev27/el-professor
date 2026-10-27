/*
  The Beleg edit log (migration 20261027160000, table public.receipt_edits).

  Runs after assertions.sql against the same throwaway database, as
  supabase_admin. The whole file is one transaction rolled back at the end, so
  the files sorting after it see the database as the seeds left it. The two
  companies and their people come from tests/rls/seed.sql.

  ── THE RULES, WRITTEN DOWN SO A LATER CHANGE ARGUES WITH THEM ──────────────

  1. **Every manual edit of a Beleg is logged by the database, not by the
     screen.** `app_private.record_receipt_edit()` (AFTER UPDATE on receipts)
     writes one row per changed column — field, old, new, editor, time — in
     the edit's own transaction. The editor is `auth.uid()`; a write with no
     session (a migration, the service role) is deliberately not logged,
     because it is not a person's edit.

  2. **`confirm` is the only client write.** A reviewer vouches for the Beleg
     as it stands: action `confirm`, field `receipt`, no values. The INSERT
     policy refuses a client-shaped `change` row outright — a forged history
     entry — and pins `edited_by` to the caller (the
     fahrtenbuch_imports.imported_by rule).

  3. **Append-only for every API role, by privilege and not only by policy.**
     anon holds nothing; authenticated and the service role hold neither
     UPDATE nor DELETE, so an attempt is a named 42501 and never a 200 with
     zero rows. Rows end only with their Beleg's own ON DELETE CASCADE.

  4. **The shape every company table takes**: SELECT is the tenant term with
     the platform seam, the one write asks the `receipts` page, and both
     context triggers are attached (the pair rule).

  What is covered, in order:

     1. shape      policies, triggers, privileges, the writer's definition
     2. logging    a change writes its rows; a no-op writes none; a session-less
                   write writes none; the editor and both values are the row's
     3. confirm    the editor may, the viewer may not, a forged change may not,
                   another's id may not, another company may not
     4. append     UPDATE and DELETE die on the privilege; the Beleg's own
                   delete takes its history with it
     5. tenancy    company B's admin reads none of A's history
     6. controls   three mutations that must flip a probe, so no probe above
                   can pass for the wrong reason
     7. the count  the number of probes that ran, asserted before the verdict
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in conflict-review-record.sql) ────────────────────────

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS banned_until       timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at         timestamptz,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT now();

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _re_results (
  n        serial PRIMARY KEY,
  label    text    NOT NULL,
  expected text,
  actual   text,
  ok       boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _re_expect(p_label text, p_expected text, p_actual text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean := p_actual IS NOT DISTINCT FROM p_expected;
BEGIN
  INSERT INTO _re_results (label, expected, actual, ok) VALUES (p_label, p_expected, p_actual, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok   % [%]', p_label, p_actual;
  ELSE
    RAISE NOTICE 'DIFF % -- expected [%] got [%]', p_label, p_expected, p_actual;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION _re_ok(p_label text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _re_expect(p_label, 'true', coalesce(p_ok::text, 'NULL'));
END $$;

CREATE OR REPLACE FUNCTION _re_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/* Become a signed-in caller with a password sign-in, or anon when NULL. */
CREATE OR REPLACE FUNCTION _re_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _re_reset();
  IF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/* Run p_sql as that caller in a subtransaction that is always rolled back:
   the refusal probes' tool. `ERR <sqlstate> <detail>` names a refusal; a
   missing privilege is read out of PostgreSQL's message, never the hint. */
CREATE OR REPLACE FUNCTION _re_try(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
  v_hint  text;
BEGIN
  BEGIN
    PERFORM _re_as(p_user);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ042', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ042' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_hint = PG_EXCEPTION_HINT;
      v_out := 'ERR ' || v_state || ' ' || CASE
        WHEN v_state = '42501' AND v_msg ~ '^permission denied for (table|function|schema) '
          THEN 'privilege ' || regexp_replace(v_msg, '^permission denied for ', '')
        WHEN v_hint ~ '^[a-z][a-z0-9_]*$' THEN v_hint
        ELSE v_msg
      END;
  END;
  PERFORM _re_reset();
  RETURN v_out;
END $$;

-- ─── fixtures ────────────────────────────────────────────────────────────────
-- Written as the owner, so nothing here is logged (no session) — probe 2f pins
-- exactly that. `street` exists since 20261027150000, which sorts before the
-- edit log's own migration.

INSERT INTO receipts (id, receipt_number, date, description, driver_name, expense, company_id, street)
VALUES ('e0000000-0000-4000-8000-00000000000a', 'BEL-RE-A', '2026-10-20', 'Tanken', 'Driver A', 41.08,
        'c0000000-0000-4000-8000-00000000000a', 'Eckeseyer Straße 113-115'),
       ('e0000000-0000-4000-8000-00000000000b', 'BEL-RE-B', '2026-10-20', 'Tanken', 'Driver B', 10.00,
        'c0000000-0000-4000-8000-00000000000b', NULL);

-- ─── 1. shape ────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'receipt_edits';
  PERFORM _re_expect('1a exactly two policies', '2', v_n::text);

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'receipt_edits' AND cmd IN ('UPDATE', 'DELETE');
  PERFORM _re_expect('1b no UPDATE or DELETE policy', '0', v_n::text);

  SELECT count(*) INTO v_n FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE c.relname = 'receipt_edits' AND NOT tg.tgisinternal
     AND tg.tgname IN ('refuse_read_only_context_write', 'record_support_write');
  PERFORM _re_expect('1c both context triggers (the pair rule)', '2', v_n::text);

  PERFORM _re_ok('1d the history trigger sits on receipts',
    EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
             WHERE c.relname = 'receipts' AND tg.tgname = 'record_receipt_edit'
               AND NOT tg.tgisinternal));

  PERFORM _re_ok('1e anon holds no privilege at all',
    NOT (has_table_privilege('anon', 'public.receipt_edits', 'SELECT')
         OR has_table_privilege('anon', 'public.receipt_edits', 'INSERT')
         OR has_table_privilege('anon', 'public.receipt_edits', 'UPDATE')
         OR has_table_privilege('anon', 'public.receipt_edits', 'DELETE')));

  PERFORM _re_ok('1f authenticated and service_role hold neither UPDATE nor DELETE',
    NOT (has_table_privilege('authenticated', 'public.receipt_edits', 'UPDATE')
         OR has_table_privilege('authenticated', 'public.receipt_edits', 'DELETE')
         OR has_table_privilege('service_role', 'public.receipt_edits', 'UPDATE')
         OR has_table_privilege('service_role', 'public.receipt_edits', 'DELETE')));

  PERFORM _re_ok('1g the writer is SECURITY DEFINER with a pinned search_path and no API EXECUTE',
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
             WHERE ns.nspname = 'app_private' AND p.proname = 'record_receipt_edit'
               AND p.prosecdef
               AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%'))
    AND NOT has_function_privilege('anon', 'app_private.record_receipt_edit()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'app_private.record_receipt_edit()', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'app_private.record_receipt_edit()', 'EXECUTE'));
END $$;

-- ─── 2. a change is logged; a no-op and a session-less write are not ─────────

DO $$
DECLARE
  v_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_beleg constant uuid := 'e0000000-0000-4000-8000-00000000000a';
  v_n     int;
  v_row   record;
  v_txt   text;
BEGIN
  -- the admin corrects the amount and the street in one save
  PERFORM _re_as(v_admin);
  UPDATE receipts SET expense = 41.80, street = 'Eckeseyer Str. 113' WHERE id = v_beleg;
  PERFORM _re_reset();

  SELECT count(*) INTO v_n FROM receipt_edits WHERE receipt_id = v_beleg AND action = 'change';
  PERFORM _re_expect('2a one row per changed column', '2', v_n::text);

  SELECT old_value, new_value, edited_by INTO v_row
    FROM receipt_edits WHERE receipt_id = v_beleg AND field = 'expense';
  PERFORM _re_expect('2b the amount''s old and new values travel with it',
    '41.08 -> 41.80', v_row.old_value || ' -> ' || v_row.new_value);
  PERFORM _re_expect('2c the editor is the session, never a client claim',
    v_admin::text, v_row.edited_by::text);

  SELECT old_value || ' -> ' || new_value INTO v_txt
    FROM receipt_edits WHERE receipt_id = v_beleg AND field = 'street';
  PERFORM _re_expect('2d the street''s change too',
    'Eckeseyer Straße 113-115 -> Eckeseyer Str. 113', v_txt);

  -- a save that changes nothing writes nothing
  PERFORM _re_as(v_admin);
  UPDATE receipts SET expense = 41.80 WHERE id = v_beleg;
  PERFORM _re_reset();
  SELECT count(*) INTO v_n FROM receipt_edits WHERE receipt_id = v_beleg;
  PERFORM _re_expect('2e a no-op save logs nothing', '2', v_n::text);

  -- the owner (a migration, a backfill) has no session and is not a person
  UPDATE receipts SET expense = 42.00 WHERE id = v_beleg;
  SELECT count(*) INTO v_n FROM receipt_edits WHERE receipt_id = v_beleg;
  PERFORM _re_expect('2f a session-less write logs nothing', '2', v_n::text);
  UPDATE receipts SET expense = 41.80 WHERE id = v_beleg;
END $$;

-- ─── 3. confirm: the one client write, and the shapes it refuses ─────────────

DO $$
DECLARE
  v_editor constant uuid := 'a0000000-0000-4000-8000-000000000002';
  v_viewer constant uuid := 'a0000000-0000-4000-8000-000000000003';
  v_adminB constant uuid := 'b0000000-0000-4000-8000-000000000001';
  v_co_a   constant text := 'c0000000-0000-4000-8000-00000000000a';
  v_co_b   constant text := 'c0000000-0000-4000-8000-00000000000b';
  v_beleg  constant text := 'e0000000-0000-4000-8000-00000000000a';
  v_belegB constant text := 'e0000000-0000-4000-8000-00000000000b';
  v_n      int;
BEGIN
  -- the editor vouches for the Beleg as it stands
  PERFORM _re_as(v_editor);
  INSERT INTO receipt_edits (company_id, receipt_id, action, field, edited_by)
  VALUES (v_co_a::uuid, v_beleg::uuid, 'confirm', 'receipt', v_editor);
  PERFORM _re_reset();
  SELECT count(*) INTO v_n FROM receipt_edits
   WHERE receipt_id = v_beleg::uuid AND action = 'confirm' AND edited_by = v_editor;
  PERFORM _re_expect('3a the editor''s confirm is recorded', '1', v_n::text);

  PERFORM _re_expect('3b the viewer holds no edit right on the receipts page',
    'ERR 42501 new row violates row-level security policy for table "receipt_edits"',
    _re_try(v_viewer, format(
      $q$INSERT INTO receipt_edits (company_id, receipt_id, action, field, edited_by)
         VALUES (%L, %L, 'confirm', 'receipt', %L)$q$, v_co_a, v_beleg, v_viewer)));

  PERFORM _re_expect('3c a client-shaped change row is a forged history entry',
    'ERR 42501 new row violates row-level security policy for table "receipt_edits"',
    _re_try(v_editor, format(
      $q$INSERT INTO receipt_edits (company_id, receipt_id, action, field, old_value, new_value, edited_by)
         VALUES (%L, %L, 'change', 'expense', '41.80', '1.00', %L)$q$, v_co_a, v_beleg, v_editor)));

  PERFORM _re_expect('3d a confirm in a colleague''s name is refused',
    'ERR 42501 new row violates row-level security policy for table "receipt_edits"',
    _re_try(v_editor, format(
      $q$INSERT INTO receipt_edits (company_id, receipt_id, action, field, edited_by)
         VALUES (%L, %L, 'confirm', 'receipt', %L)$q$, v_co_a, v_beleg, v_viewer)));

  PERFORM _re_expect('3e company B''s admin cannot confirm A''s Beleg',
    'ERR 42501 new row violates row-level security policy for table "receipt_edits"',
    _re_try(v_adminB, format(
      $q$INSERT INTO receipt_edits (company_id, receipt_id, action, field, edited_by)
         VALUES (%L, %L, 'confirm', 'receipt', %L)$q$, v_co_a, v_beleg, v_adminB)));

  PERFORM _re_expect('3f nor name A''s Beleg under B''s company id',
    'ERR 42501 new row violates row-level security policy for table "receipt_edits"',
    _re_try(v_adminB, format(
      $q$INSERT INTO receipt_edits (company_id, receipt_id, action, field, edited_by)
         VALUES (%L, %L, 'confirm', 'receipt', %L)$q$, v_co_b, v_beleg, v_adminB)));

  PERFORM _re_expect('3g anon reaches no row at all',
    'ERR 42501 privilege table receipt_edits',
    _re_try(NULL, $q$SELECT count(*)::text FROM receipt_edits$q$));
END $$;

-- ─── 4. append-only, and the one way a row ends ──────────────────────────────

DO $$
DECLARE
  v_admin constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_beleg constant uuid := 'e0000000-0000-4000-8000-00000000000a';
  v_n     int;
BEGIN
  PERFORM _re_expect('4a UPDATE dies on the privilege, not on a silent zero rows',
    'ERR 42501 privilege table receipt_edits',
    _re_try(v_admin, $q$UPDATE receipt_edits SET field = 'x' WHERE action = 'change'$q$));

  PERFORM _re_expect('4b DELETE likewise',
    'ERR 42501 privilege table receipt_edits',
    _re_try(v_admin, $q$DELETE FROM receipt_edits$q$));

  -- the Beleg's own delete takes its history with it (and only that path)
  SELECT count(*) INTO v_n FROM receipt_edits WHERE receipt_id = v_beleg;
  PERFORM _re_ok('4c the Beleg holds history before its delete', v_n > 0);
  DELETE FROM receipts WHERE id = v_beleg;
  SELECT count(*) INTO v_n FROM receipt_edits WHERE receipt_id = v_beleg;
  PERFORM _re_expect('4d deleting the Beleg cascades its history', '0', v_n::text);
END $$;

-- ─── 5. tenancy on the read ──────────────────────────────────────────────────

DO $$
DECLARE
  v_admin  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_adminB constant uuid := 'b0000000-0000-4000-8000-000000000001';
  v_belegB constant uuid := 'e0000000-0000-4000-8000-00000000000b';
BEGIN
  -- a fresh change on B's Beleg, so both sides hold a row
  PERFORM _re_as(v_adminB);
  UPDATE receipts SET expense = 11.00 WHERE id = v_belegB;
  PERFORM _re_reset();

  PERFORM _re_expect('5a company A''s admin reads none of B''s history',
    '0', _re_try(v_admin, format(
      $q$SELECT count(*)::text FROM receipt_edits WHERE receipt_id = %L$q$, v_belegB)));
  PERFORM _re_expect('5b company B''s admin reads its own',
    '1', _re_try(v_adminB, format(
      $q$SELECT count(*)::text FROM receipt_edits WHERE receipt_id = %L$q$, v_belegB)));
END $$;

-- ─── 6. controls: break the rule, watch the probe flip ───────────────────────
--
--  Each mutation runs inside a savepoint and is rolled back, so nothing it
--  changes survives into the verdict. A control that does NOT flip is a probe
--  that was measuring something else — the kit's own lesson.

DO $$
DECLARE
  v_admin  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_editor constant uuid := 'a0000000-0000-4000-8000-000000000002';
  v_co_a   constant text := 'c0000000-0000-4000-8000-00000000000a';
  v_belegC constant uuid := 'e0000000-0000-4000-8000-00000000000c';
  v_n      int;
  v_out    text;
BEGIN
  -- A fresh Beleg for company A: section 4 deleted the first one, and a control
  -- that updates a row that does not exist measures nothing. Owner insert, so
  -- nothing is logged by it.
  INSERT INTO receipts (id, receipt_number, date, description, driver_name, expense, company_id)
  VALUES (v_belegC, 'BEL-RE-C', '2026-10-21', 'Tanken', 'Driver A', 20.00, v_co_a::uuid);

  -- 6a. with the trigger off, an edit logs nothing: probe 2a measured the
  --     trigger. The probe's own result is read into a VARIABLE inside the
  --     savepoint and asserted after the rollback — an _re_expect inside would
  --     roll back with the mutation and the control would assert nothing.
  BEGIN
    ALTER TABLE public.receipts DISABLE TRIGGER record_receipt_edit;
    PERFORM _re_as(v_admin);
    UPDATE receipts SET expense = 99.99 WHERE id = v_belegC;
    PERFORM _re_reset();
    SELECT count(*) INTO v_n FROM receipt_edits WHERE new_value = '99.99';
    RAISE EXCEPTION USING ERRCODE = 'ZZ043';
  EXCEPTION WHEN SQLSTATE 'ZZ043' THEN NULL;
  END;
  PERFORM _re_expect('6a control: trigger off, nothing is logged', '0', v_n::text);
  PERFORM _re_ok('6a'' the mutation did not survive its savepoint',
    EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
             WHERE c.relname = 'receipts' AND tg.tgname = 'record_receipt_edit'
               AND tg.tgenabled <> 'D'));

  -- 6b. with UPDATE granted back, 4a's refusal becomes an RLS zero-rows: the
  --     probe measured the privilege, and the policy set still holds no UPDATE
  BEGIN
    GRANT UPDATE ON public.receipt_edits TO authenticated;
    v_out := _re_try(v_admin, $q$UPDATE receipt_edits SET field = 'x' WHERE action = 'change'$q$);
    RAISE EXCEPTION USING ERRCODE = 'ZZ043';
  EXCEPTION WHEN SQLSTATE 'ZZ043' THEN NULL;
  END;
  PERFORM _re_expect('6b control: privilege back, the refusal moves to the (absent) policy',
    'rows 0', v_out);

  -- 6c. with the action term widened, the forged change passes: 3c measured
  --     exactly that term
  BEGIN
    ALTER POLICY receipt_edits_insert ON public.receipt_edits
      WITH CHECK (
        company_id = (SELECT public.get_active_company_id())
        AND (SELECT public.current_role_permits('receipts', true))
        AND edited_by = (SELECT auth.uid())
        AND EXISTS (SELECT 1 FROM public.receipts r
                     WHERE r.id = receipt_id AND r.company_id = receipt_edits.company_id));
    v_out := _re_try(v_editor, format(
      $q$INSERT INTO receipt_edits (company_id, receipt_id, action, field, old_value, new_value, edited_by)
         VALUES (%L, %L, 'change', 'expense', '1', '2', %L)$q$,
      v_co_a, v_belegC, v_editor));
    RAISE EXCEPTION USING ERRCODE = 'ZZ043';
  EXCEPTION WHEN SQLSTATE 'ZZ043' THEN NULL;
  END;
  PERFORM _re_expect('6c control: without the action term the forged change passes',
    'rows 1', v_out);
  SELECT count(*) INTO v_n FROM receipt_edits WHERE old_value = '1' AND new_value = '2';
  PERFORM _re_expect('6c'' the forged row did not survive its savepoint', '0', v_n::text);
END $$;

-- ─── 7. the verdict ──────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad int;
  v_all int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT ok), count(*) INTO v_bad, v_all FROM _re_results;
  IF v_all < 31 THEN
    RAISE EXCEPTION 'receipt edits: only % probe(s) ran — a section was skipped', v_all;
  END IF;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'receipt edits: % of % probe(s) did not match — read the DIFF lines above', v_bad, v_all;
  END IF;
  RAISE NOTICE '── receipt edits: all % probes matched ──', v_all;
END $$;

ROLLBACK;
