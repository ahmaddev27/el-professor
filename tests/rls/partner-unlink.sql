-- tests/rls/partner-unlink.sql — a person takes a Reidey driver link apart
-- (20261128120000, the owner's answer of 28.11.2026)
--
--  What this file pins, section by section:
--
--   1. Who may unlink: the gate of partner_driver_link_confirm / _reject, and
--      nothing new. A viewer, anon, another company's administrator, a platform
--      account with no context and one in a VIEW context are refused, each
--      with its own reason; a NULL id, a pending link, a rejected link and an
--      unknown id are refused with theirs. Nothing moves on a refusal.
--   2. What it does: an editor unlinks an AUTOMATIC link. The row is pending
--      with no driver, no method, no linked_by / linked_at, reason 'unlinked',
--      and the editor and the time are recorded. What the link claimed — the
--      Beleg it made, the driver notes, an income row and the submissions
--      themselves — is byte for byte what it was (row text, updated_at
--      included), and the undated Beleg still waiting stays with that driver.
--      A direct PATCH can neither erase nor forge the record; a PATCH of any
--      other column still passes.
--   3. No automatic path links it again: the roster import (which links an
--      ordinary certain match in the same run), the nightly door and the human
--      earnings resolve all report it as skipped with reason 'unlinked'.
--   4. A person links it again by hand, to another driver: manual, with the
--      record kept; a submission that arrived while it was pending goes to the
--      new driver and the old driver's records stay with the old driver. It
--      can be unlinked again (the record names the new person) and rejected.
--   5. A support session unlinks as the company's administrator would.
--   6. The table refuses an unlink record written by a service-role INSERT,
--      and admits the same row without one (so the refusal is the guard and
--      not a missing grant).
--   7. Mutation controls, one per load-bearing line: the page gate, the status
--      check, who is recorded, the import's skip, the placement's skip (both
--      modes), the guard's role test, and each of the three CHECKs. Each
--      mutant runs in a subtransaction the sentinel ZZ042 rolls back, and so
--      does the unmutated run it is compared with.
--
--  Two rules every probe here keeps (partner-certain-link.sql learnt them): a
--  read of a write goes in the statement AFTER the write, and _pu_call clears
--  the claims it set.
--
--  Runs inside BEGIN ... ROLLBACK. Ids start with `4a` so a failure names a row.
--  All names are invented.

BEGIN;

-- The kit's auth schema is a stub: GoTrue's tables exist only when a file
-- creates them, and this transaction rolls them back with everything else.
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

CREATE OR REPLACE FUNCTION _pu_clear() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $$;

CREATE OR REPLACE FUNCTION _pu_as(p_who text, p_session text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- A privilege error is raised at parse time and the plan the owner just
  -- warmed would hide it, so the owner's cached plans go first.
  DISCARD PLANS;
  PERFORM _pu_clear();
  IF p_who = 'anon' THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
  ELSIF p_who = 'service' THEN
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
  ELSE
    PERFORM set_config('request.jwt.claim.sub', p_who, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
    IF p_session IS NOT NULL THEN
      PERFORM set_config('request.jwt.claim.session_id', p_session, true);
    END IF;
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
END $$;

/* p_sql as p_who ('owner', 'anon', 'service' or a user id): the scalar, 'null'
   for NULL, or `ERR <sqlstate> <hint-or-none>`. Clears the claims on both paths. */
CREATE OR REPLACE FUNCTION _pu_call(p_who text, p_sql text, p_session text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text; v_hint text; v_state text;
BEGIN
  IF p_who <> 'owner' THEN PERFORM _pu_as(p_who, p_session); END IF;
  EXECUTE p_sql INTO v_out;
  RESET ROLE;
  PERFORM _pu_clear();
  RETURN coalesce(v_out, 'null');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_state = RETURNED_SQLSTATE;
  RESET ROLE;
  PERFORM _pu_clear();
  RETURN 'ERR ' || v_state || ' ' || coalesce(nullif(v_hint, ''), '(no hint)');
END $$;

CREATE TEMP TABLE _pu_out (
  n integer PRIMARY KEY, label text NOT NULL,
  actual text NOT NULL, expected text NOT NULL, matched boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _pu_rec(p_n integer, p_label text, p_actual text, p_expected text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  v_ok := p_actual IS NOT DISTINCT FROM p_expected;
  INSERT INTO _pu_out VALUES (p_n, p_label, coalesce(p_actual, '<NULL>'), coalesce(p_expected, '<NULL>'), v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 3), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 3), p_label;
    RAISE WARNING '        expected: %', coalesce(p_expected, '<NULL>');
    RAISE WARNING '        actual:   %', coalesce(p_actual, '<NULL>');
  END IF;
END $$;

/* The unlink of one link as SQL text: `ok|driver_id`. */
CREATE OR REPLACE FUNCTION _pu_unlink(p_link uuid) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format($q$SELECT (x->>'ok') || '|' || coalesce(x->>'driver_id', 'null')
                     FROM (SELECT partner_driver_link_unlink(%L::uuid) AS x) s$q$, p_link)
$$;

/* One link of company A by its partner id:
   status|driver|method|reason|linked_by|unlinked_by. STABLE: read a write in
   the statement after it. */
CREATE OR REPLACE FUNCTION _pu_link(p_ext text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT l.status || '|' || coalesce(d.name, 'no driver') || '|' || coalesce(l.link_method, 'null') || '|'
         || coalesce(l.decision_reason, 'null') || '|' || coalesce(l.linked_by::text, 'null') || '|'
         || coalesce(l.unlinked_by::text, 'null')
    FROM partner_driver_links l LEFT JOIN drivers d ON d.id = l.driver_id
   WHERE l.company_id = 'c0000000-0000-4000-8000-00000000000a' AND l.partner = 'reidey'
     AND l.external_driver_id = p_ext
$$;

/* linked_at and unlinked_at of one link of company A, as set/null. */
CREATE OR REPLACE FUNCTION _pu_times(p_ext text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN l.linked_at IS NULL THEN 'linked_at null' ELSE 'linked_at set' END || '/'
         || CASE WHEN l.unlinked_at IS NULL THEN 'unlinked_at null' ELSE 'unlinked_at set' END
    FROM partner_driver_links l
   WHERE l.company_id = 'c0000000-0000-4000-8000-00000000000a' AND l.partner = 'reidey'
     AND l.external_driver_id = p_ext
$$;

/* Everything the first link claimed for its driver, as one fingerprint of the
   rows' text (updated_at included, so a touch shows), with the counts beside
   it so an empty fixture cannot pass: receipts/notes/income/receipt subs/note subs. */
CREATE OR REPLACE FUNCTION _pu_records() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM receipts r WHERE r.company_id = 'c0000000-0000-4000-8000-00000000000a' AND r.driver_name = 'Pu Eins')
         || '/' || (SELECT count(*) FROM driver_notes n WHERE n.driver_id = '4a000000-0000-4000-8000-0000000000d1')
         || '/' || (SELECT count(*) FROM income i WHERE i.company_id = 'c0000000-0000-4000-8000-00000000000a' AND i.driver_name = 'Pu Eins')
         || '/' || (SELECT count(*) FROM partner_receipt_submissions s WHERE s.external_submission_id IN ('pu-rec-1', 'pu-rec-2'))
         || '/' || (SELECT count(*) FROM partner_note_submissions s WHERE s.external_submission_id = 'pu-note-1')
         || ' ' || md5(
              coalesce((SELECT string_agg(r::text, '#' ORDER BY r.id) FROM receipts r
                         WHERE r.company_id = 'c0000000-0000-4000-8000-00000000000a' AND r.driver_name = 'Pu Eins'), '-')
              || '|' || coalesce((SELECT string_agg(n::text, '#' ORDER BY n.id) FROM driver_notes n
                                   WHERE n.driver_id = '4a000000-0000-4000-8000-0000000000d1'), '-')
              || '|' || coalesce((SELECT string_agg(i::text, '#' ORDER BY i.id) FROM income i
                                   WHERE i.company_id = 'c0000000-0000-4000-8000-00000000000a' AND i.driver_name = 'Pu Eins'), '-')
              || '|' || coalesce((SELECT string_agg(s::text, '#' ORDER BY s.id) FROM partner_receipt_submissions s
                                   WHERE s.external_submission_id IN ('pu-rec-1', 'pu-rec-2')), '-')
              || '|' || coalesce((SELECT string_agg(s::text, '#' ORDER BY s.id) FROM partner_note_submissions s
                                   WHERE s.external_submission_id = 'pu-note-1'), '-'))
$$;

CREATE OR REPLACE FUNCTION _pu_earner(p_ext text, p_name text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_object('external_driver_id', p_ext, 'name', p_name) $$;

/* The roster import as the caller _pu_call made, then the reason it gave for
   one link, or 'not skipped'. */
CREATE OR REPLACE FUNCTION _pu_import_reason(p_link uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  v := partner_drivers_import();
  RETURN coalesce((SELECT string_agg(e->>'reason', ',') FROM jsonb_array_elements(v->'skipped') e
                    WHERE e->>'link_id' = p_link::text), 'not skipped');
END $$;

/* The open run of company A that §3 claims, for the job's door. */
CREATE TEMP TABLE _pu_run (id uuid);

/* The job's door for one earner: `ok|refused reasons`. */
CREATE OR REPLACE FUNCTION _pu_door(p_ext text, p_name text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  v := uber_pull_place_unlinked((SELECT id FROM _pu_run), jsonb_build_array(_pu_earner(p_ext, p_name)));
  RETURN coalesce(v->>'ok', 'null') || '|'
         || coalesce((SELECT string_agg(e->>'reason', ',') FROM jsonb_array_elements(v->'refused') e), 'none');
END $$;

/* The human earnings resolve for one earner, as the caller _pu_call made:
   `ok|skipped reasons`. */
CREATE OR REPLACE FUNCTION _pu_resolve(p_ext text, p_name text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  v := partner_earners_resolve('reidey', jsonb_build_array(_pu_earner(p_ext, p_name)));
  RETURN coalesce(v->>'ok', 'null') || '|'
         || coalesce((SELECT string_agg(e->>'reason', ',') FROM jsonb_array_elements(v->'skipped') e
                       WHERE e->>'external_driver_id' = p_ext), 'none');
END $$;

/* Unlink one link, then read who is recorded, in a statement of its own. */
CREATE OR REPLACE FUNCTION _pu_unlink_then_by(p_link uuid) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM partner_driver_link_unlink(p_link);
  RETURN (SELECT coalesce(unlinked_by::text, 'null') FROM partner_driver_links WHERE id = p_link);
END $$;

/* A PATCH of one link as SQL text: the number of rows it reached. */
CREATE OR REPLACE FUNCTION _pu_patch(p_link uuid, p_set text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format($q$WITH u AS (UPDATE partner_driver_links SET %s WHERE id = %L RETURNING 1)
                   SELECT count(*)::text FROM u$q$, p_set, p_link)
$$;

/* Breaks one piece of a function as the owner: refuses a mutation that would
   change nothing, so a control cannot silently measure the unmutated code. */
CREATE OR REPLACE FUNCTION _pu_mutate_fn(p_sig text, p_from text, p_to text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_old text := pg_get_functiondef(to_regprocedure(p_sig));
BEGIN
  IF v_old IS NULL OR position(p_from IN v_old) = 0 THEN
    RAISE EXCEPTION 'mutation control: % does not contain [%], so the mutation would change nothing', p_sig, p_from;
  END IF;
  EXECUTE replace(v_old, p_from, p_to);
END $$;

/* p_sig mutated, then the probe as p_who, then everything rolled back. */
CREATE OR REPLACE FUNCTION _pu_mutant(p_sig text, p_from text, p_to text, p_who text, p_sql text)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text;
BEGIN
  BEGIN
    PERFORM _pu_mutate_fn(p_sig, p_from, p_to);
    v_out := _pu_call(p_who, p_sql);
    RAISE EXCEPTION USING ERRCODE = 'ZZ042', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ042' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      v_out := 'MUTATION FAILED: ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN v_out;
END $$;

/* A statement of DDL (a CHECK dropped), then the probe, then everything rolled
   back. Refuses a DDL that names a constraint the table does not carry. */
CREATE OR REPLACE FUNCTION _pu_mutant_ddl(p_constraint text, p_who text, p_sql text)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text;
BEGIN
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.partner_driver_links'::regclass AND c.conname = p_constraint) THEN
      RAISE EXCEPTION 'mutation control: partner_driver_links carries no constraint %, so dropping it would change nothing', p_constraint;
    END IF;
    EXECUTE format('ALTER TABLE public.partner_driver_links DROP CONSTRAINT %I', p_constraint);
    v_out := _pu_call(p_who, p_sql);
    RAISE EXCEPTION USING ERRCODE = 'ZZ042', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ042' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      v_out := 'MUTATION FAILED: ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN v_out;
END $$;

/* p_sql as p_who, then everything rolled back: the unmutated run a control is
   compared with, leaving the state as it found it for the next control. */
CREATE OR REPLACE FUNCTION _pu_undone(p_who text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text;
BEGIN
  BEGIN
    v_out := _pu_call(p_who, p_sql);
    RAISE EXCEPTION USING ERRCODE = 'ZZ042', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ042' THEN
      v_out := SQLERRM;
  END;
  RESET ROLE;
  RETURN v_out;
END $$;

-- ─── fixtures (as the owner, so RLS does not apply) ─────────────────────────
--  L1 7001 Pu Eins    linked AUTOMATICALLY (no caller), with what it claimed:
--                     a dated Beleg (made into a Beleg), an undated one (claimed,
--                     waiting), a note (made into a driver note); and beside it
--                     an income row and a driver note written by hand.
--  L3 7003 Pu Drei    linked automatically: the support session's.
--  L4 7004 Pu Vier    linked automatically: kept linked for the controls.
--  L5 7005 Pu Fuenf   linked automatically: unlinked at §7's start, for the controls.
--  L6 7006 Pu Sechs   pending, an ordinary certain match: the import's control.
--  L7 7007            pending, no usable name (name_missing): never linked.
--  L8 7008 Pu Acht    rejected.
--  d2 Pu Zwei         a driver with no link: the one L1 is relinked to by hand.

DO $$
DECLARE
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  INSERT INTO drivers (id, company_id, name, status) VALUES
    ('4a000000-0000-4000-8000-0000000000d1', co_a, 'Pu Eins',  'active'),
    ('4a000000-0000-4000-8000-0000000000d2', co_a, 'Pu Zwei',  'active'),
    ('4a000000-0000-4000-8000-0000000000d3', co_a, 'Pu Drei',  'active'),
    ('4a000000-0000-4000-8000-0000000000d4', co_a, 'Pu Vier',  'active'),
    ('4a000000-0000-4000-8000-0000000000d5', co_a, 'Pu Fuenf', 'active'),
    ('4a000000-0000-4000-8000-0000000000d6', co_a, 'Pu Sechs', 'active');

  INSERT INTO partner_driver_links (id, company_id, partner, external_driver_id, proposed_name, status)
  VALUES
    ('4a000000-0000-4000-8000-000000007001', co_a, 'reidey', '7001', 'Pu Eins',  'pending'),
    ('4a000000-0000-4000-8000-000000007003', co_a, 'reidey', '7003', 'Pu Drei',  'pending'),
    ('4a000000-0000-4000-8000-000000007004', co_a, 'reidey', '7004', 'Pu Vier',  'pending'),
    ('4a000000-0000-4000-8000-000000007005', co_a, 'reidey', '7005', 'Pu Fuenf', 'pending'),
    ('4a000000-0000-4000-8000-000000007006', co_a, 'reidey', '7006', 'Pu Sechs', 'pending'),
    ('4a000000-0000-4000-8000-000000007007', co_a, 'reidey', '7007', 'Unbekannter Fahrer', 'pending'),
    ('4a000000-0000-4000-8000-000000007008', co_a, 'reidey', '7008', 'Pu Acht',  'rejected');

  -- What waited for 7001 before its link was made.
  INSERT INTO partner_note_submissions
         (id, company_id, partner, external_submission_id, external_driver_id, note_type, note_text)
  VALUES ('4a000000-0000-4000-8000-0000000c0001', co_a, 'reidey', 'pu-note-1', '7001', 'wait', 'Wartezeit');
  INSERT INTO partner_receipt_submissions
         (id, company_id, partner, external_submission_id, external_driver_id,
          receipt_date, category, amount, payment_method)
  VALUES ('4a000000-0000-4000-8000-0000000d0001', co_a, 'reidey', 'pu-rec-1', '7001',
          DATE '2026-10-01', 'Tanken', 12.50, 'bar');
  INSERT INTO partner_receipt_submissions
         (id, company_id, partner, external_submission_id, external_driver_id, description)
  VALUES ('4a000000-0000-4000-8000-0000000d0002', co_a, 'reidey', 'pu-rec-2', '7001', 'Tanken');

  -- The links as the nightly placement makes them: no caller.
  PERFORM app_private.partner_driver_link_apply('4a000000-0000-4000-8000-000000007001', '4a000000-0000-4000-8000-0000000000d1', NULL, 'automatic_match');
  PERFORM app_private.partner_driver_link_apply('4a000000-0000-4000-8000-000000007003', '4a000000-0000-4000-8000-0000000000d3', NULL, 'automatic_match');
  PERFORM app_private.partner_driver_link_apply('4a000000-0000-4000-8000-000000007004', '4a000000-0000-4000-8000-0000000000d4', NULL, 'automatic_match');
  PERFORM app_private.partner_driver_link_apply('4a000000-0000-4000-8000-000000007005', '4a000000-0000-4000-8000-0000000000d5', NULL, 'automatic_create');

  -- The driver's own records, written by hand beside the link.
  INSERT INTO income (company_id, description, amount, type, driver_name, date)
  VALUES (co_a, 'Pu Woche', 410.00, 'umsatz', 'Pu Eins', DATE '2026-10-05');
  INSERT INTO driver_notes (company_id, driver_id, created_by, note_text)
  VALUES (co_a, '4a000000-0000-4000-8000-0000000000d1', admin_a, 'Pu Notiz');

  -- A platform account with a session, for the context probes.
  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES ('4a000000-0000-4000-8000-0000000000e1', 'pu-staff@test.invalid', now());
  INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
  VALUES ('4a000000-0000-4000-8000-0000000000e1', 'pu-staff@test.invalid', 'PU Staff', 'viewer',
          (SELECT id FROM roles WHERE name = 'viewer' AND company_id IS NULL LIMIT 1), NULL, 'active');
  INSERT INTO app_private.platform_staff (user_id, role, note)
  VALUES ('4a000000-0000-4000-8000-0000000000e1', 'owner', 'pu');
  INSERT INTO auth.sessions (id, user_id)
  VALUES ('4a000000-0000-4000-8000-0000000000e2', '4a000000-0000-4000-8000-0000000000e1');
END $$;

DO $$
BEGIN
  PERFORM _pu_rec(1, 'fixture: the first link is automatic with no caller, and what it claimed is there',
    _pu_link('7001') || ' ' || split_part(_pu_records(), ' ', 1),
    'linked|Pu Eins|automatic_match|null|null|null 1/2/1/2/1');
  PERFORM _pu_rec(2, 'fixture: the dated Beleg became a Beleg and the note a driver note; the undated Beleg waits, claimed',
    (SELECT status || ' ' || (receipt_id IS NOT NULL)::text FROM partner_receipt_submissions WHERE external_submission_id = 'pu-rec-1')
    || ' / ' || (SELECT status || ' ' || (driver_note_id IS NOT NULL)::text FROM partner_note_submissions WHERE external_submission_id = 'pu-note-1')
    || ' / ' || (SELECT status || ' ' || (driver_id = '4a000000-0000-4000-8000-0000000000d1')::text
                   FROM partner_receipt_submissions WHERE external_submission_id = 'pu-rec-2'),
    'accepted true / accepted true / pending true');
END $$;

CREATE TEMP TABLE _pu_before (records text);
INSERT INTO _pu_before SELECT _pu_records();

-- ─── 1. who may unlink, refused before anything moves ───────────────────────

DO $$
DECLARE
  viewer_a constant text := 'a0000000-0000-4000-8000-000000000003';
  admin_a  constant text := 'a0000000-0000-4000-8000-000000000001';
  admin_b  constant text := 'b0000000-0000-4000-8000-000000000001';
  staff    constant text := '4a000000-0000-4000-8000-0000000000e1';
  staff_s  constant text := '4a000000-0000-4000-8000-0000000000e2';
  co_a     constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  l1       constant uuid := '4a000000-0000-4000-8000-000000007001';
BEGIN
  PERFORM _pu_rec(3, 'a viewer is refused by the drivers page gate',
    _pu_call(viewer_a, _pu_unlink(l1)), 'ERR 42501 not_authorized');
  PERFORM _pu_rec(4, 'anon cannot execute it',
    _pu_call('anon', _pu_unlink(l1)), 'ERR 42501 (no hint)');
  PERFORM _pu_rec(5, 'another company''s administrator does not find the link',
    _pu_call(admin_b, _pu_unlink(l1)), 'ERR P0002 link_not_found');
  PERFORM _pu_rec(6, 'a platform account with no context has no company',
    _pu_call(staff, _pu_unlink(l1), staff_s), 'ERR 42501 not_authorized');

  PERFORM _pu_call(staff, format($q$SELECT platform_context_open(%L, 'view')::text$q$, co_a), staff_s);
  PERFORM _pu_rec(7, 'inside a VIEW context the company is the opened one ...',
    _pu_call(staff, 'SELECT get_active_company_id()::text', staff_s), co_a::text);
  PERFORM _pu_rec(8, '... and the page gate refuses the unlink',
    _pu_call(staff, _pu_unlink(l1), staff_s), 'ERR 42501 not_authorized');
  PERFORM _pu_call(staff, 'SELECT platform_context_close(NULL)::text', staff_s);

  PERFORM _pu_rec(9, 'a NULL id is a broken argument',
    _pu_call(admin_a, 'SELECT partner_driver_link_unlink(NULL)::text'), 'ERR 22023 invalid_request');
  PERFORM _pu_rec(10, 'a pending link has nothing to take apart',
    _pu_call(admin_a, _pu_unlink('4a000000-0000-4000-8000-000000007007')), 'ERR P0001 not_linked');
  PERFORM _pu_rec(11, 'nor has a rejected one',
    _pu_call(admin_a, _pu_unlink('4a000000-0000-4000-8000-000000007008')), 'ERR P0001 not_linked');
  PERFORM _pu_rec(12, 'an id nobody holds is not found',
    _pu_call(admin_a, _pu_unlink('4a000000-0000-4000-8000-00000000ffff')), 'ERR P0002 link_not_found');
END $$;

DO $$
BEGIN
  PERFORM _pu_rec(13, 'nothing moved: the link is still linked, and what it claimed is untouched',
    _pu_link('7001') || ' ' || (_pu_records() = (SELECT records FROM _pu_before))::text,
    'linked|Pu Eins|automatic_match|null|null|null true');
END $$;

-- ─── 2. the unlink: the link goes, the driver's records stay ────────────────

DO $$
DECLARE
  editor_a constant text := 'a0000000-0000-4000-8000-000000000002';
  l1       constant uuid := '4a000000-0000-4000-8000-000000007001';
BEGIN
  PERFORM _pu_rec(14, 'an editor (can_edit on drivers) unlinks the automatic link, and is told whose it was',
    _pu_call(editor_a, _pu_unlink(l1)), 'true|4a000000-0000-4000-8000-0000000000d1');
END $$;

DO $$
DECLARE
  editor_a constant text := 'a0000000-0000-4000-8000-000000000002';
  viewer_a constant text := 'a0000000-0000-4000-8000-000000000003';
  l1       constant uuid := '4a000000-0000-4000-8000-000000007001';
BEGIN
  PERFORM _pu_rec(15, 'the row: pending, no driver, no method, no linked_by, reason unlinked, the editor recorded',
    _pu_link('7001'), 'pending|no driver|null|unlinked|null|' || editor_a);
  PERFORM _pu_rec(16, '... with linked_at cleared and the time of the unlink stored',
    _pu_times('7001'), 'linked_at null/unlinked_at set');
  PERFORM _pu_rec(17, 'the Beleg, the notes, the income row and the submissions are exactly what they were',
    (_pu_records() = (SELECT records FROM _pu_before))::text, 'true');
  PERFORM _pu_rec(18, 'the undated Beleg still waits, and still names the driver it was claimed for',
    (SELECT status || ' ' || (driver_id = '4a000000-0000-4000-8000-0000000000d1')::text
       FROM partner_receipt_submissions WHERE external_submission_id = 'pu-rec-2'),
    'pending true');
  PERFORM _pu_rec(19, 'the driver is still there, active',
    (SELECT status FROM drivers WHERE id = '4a000000-0000-4000-8000-0000000000d1'), 'active');
  PERFORM _pu_rec(20, 'a second unlink of the same row: there is nothing left to take apart',
    _pu_call(editor_a, _pu_unlink(l1)), 'ERR P0001 not_linked');

  -- The drivers page may PATCH a link (partner_driver_links_update). It must
  -- not be able to erase the record, which would let the next night link it.
  PERFORM _pu_rec(21, 'a direct PATCH that erases the record is refused',
    _pu_call(editor_a, _pu_patch(l1, 'unlinked_by = NULL, unlinked_at = NULL, decision_reason = NULL')),
    'ERR 42501 unlink_record_protected');
  PERFORM _pu_rec(22, 'so is one that forges another person into it',
    _pu_call(editor_a, _pu_patch(l1, format('unlinked_by = %L', viewer_a))),
    'ERR 42501 unlink_record_protected');
  PERFORM _pu_rec(23, 'a PATCH of any other column still reaches the row',
    _pu_call(editor_a, _pu_patch(l1, 'updated_at = now()')), '1');
END $$;

DO $$
DECLARE
  editor_a constant text := 'a0000000-0000-4000-8000-000000000002';
BEGIN
  PERFORM _pu_rec(24, 'and the record is still the editor''s',
    _pu_link('7001'), 'pending|no driver|null|unlinked|null|' || editor_a);
END $$;

-- ─── 3. no automatic path links it again ────────────────────────────────────

DO $$
DECLARE
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_run   uuid;
BEGIN
  PERFORM _pu_rec(25, 'the roster import skips the unlinked row with reason unlinked',
    _pu_call(admin_a, format('SELECT _pu_import_reason(%L)', '4a000000-0000-4000-8000-000000007001')), 'unlinked');

  v_run := uber_pull_claim(co_a, ((now() AT TIME ZONE 'Europe/Berlin') - interval '4 hours')::date - 1, 'first');
  INSERT INTO _pu_run VALUES (v_run);
  PERFORM _pu_rec(26, 'fixture: an open run for company A', (v_run IS NOT NULL)::text, 'true');
END $$;

DO $$
DECLARE
  admin_a  constant text := 'a0000000-0000-4000-8000-000000000001';
  editor_a constant text := 'a0000000-0000-4000-8000-000000000002';
BEGIN
  PERFORM _pu_rec(27, '... and in the same run it linked an ordinary certain match, so the skip is not a stopped import',
    _pu_link('7006'), 'linked|Pu Sechs|automatic_match|null|' || admin_a || '|null');
  PERFORM _pu_rec(28, 'the nightly door refuses the earner with reason unlinked',
    _pu_call('owner', $q$SELECT _pu_door('7001', 'Pu Eins')$q$), 'true|unlinked');
  PERFORM _pu_rec(29, 'the human earnings resolve skips it with reason unlinked too',
    _pu_call(admin_a, $q$SELECT _pu_resolve('7001', 'Pu Eins')$q$), 'true|unlinked');
END $$;

DO $$
DECLARE
  editor_a constant text := 'a0000000-0000-4000-8000-000000000002';
BEGIN
  PERFORM _pu_rec(30, 'after all three the row is as the editor left it',
    _pu_link('7001'), 'pending|no driver|null|unlinked|null|' || editor_a);
  PERFORM _pu_rec(31, 'and the driver it was taken from still holds no link',
    (SELECT count(*)::text FROM partner_driver_links WHERE driver_id = '4a000000-0000-4000-8000-0000000000d1'), '0');
END $$;

-- ─── 4. a person links it again, by hand ────────────────────────────────────

-- A note that arrives while the link is pending waits with no driver.
INSERT INTO partner_note_submissions
       (id, company_id, partner, external_submission_id, external_driver_id, note_type, note_text)
VALUES ('4a000000-0000-4000-8000-0000000c0002', 'c0000000-0000-4000-8000-00000000000a', 'reidey',
        'pu-note-2', '7001', 'wait', 'Wartezeit');

DO $$
DECLARE
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _pu_rec(32, 'the administrator confirms the unlinked row to another driver',
    _pu_call(admin_a, $q$SELECT partner_driver_link_confirm('4a000000-0000-4000-8000-000000007001',
                                                             '4a000000-0000-4000-8000-0000000000d2') ->> 'ok'$q$),
    'true');
END $$;

DO $$
DECLARE
  admin_a  constant text := 'a0000000-0000-4000-8000-000000000001';
  editor_a constant text := 'a0000000-0000-4000-8000-000000000002';
BEGIN
  PERFORM _pu_rec(33, 'it is a MANUAL link by the administrator, and the unlink record is kept',
    _pu_link('7001'), 'linked|Pu Zwei|manual|null|' || admin_a || '|' || editor_a);
  PERFORM _pu_rec(34, 'the note that arrived while it was pending went to the new driver',
    (SELECT s.status || ' ' || d.name || ' ' || (s.driver_note_id IS NOT NULL)::text
       FROM partner_note_submissions s JOIN drivers d ON d.id = s.driver_id
      WHERE s.external_submission_id = 'pu-note-2'),
    'accepted Pu Zwei true');
  PERFORM _pu_rec(35, 'and everything the first driver had is still the first driver''s',
    (_pu_records() = (SELECT records FROM _pu_before))::text, 'true');
END $$;

DO $$
DECLARE
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
  l1      constant uuid := '4a000000-0000-4000-8000-000000007001';
BEGIN
  PERFORM _pu_rec(36, 'a manual link can be taken apart again',
    _pu_call(admin_a, _pu_unlink(l1)), 'true|4a000000-0000-4000-8000-0000000000d2');
END $$;

DO $$
DECLARE
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _pu_rec(37, '... and the record now names the person who did it this time',
    _pu_link('7001'), 'pending|no driver|null|unlinked|null|' || admin_a);
  PERFORM _pu_rec(38, 'an unlinked row may also be rejected',
    _pu_call(admin_a, $q$SELECT partner_driver_link_reject('4a000000-0000-4000-8000-000000007001') ->> 'ok'$q$),
    'true');
END $$;

DO $$
DECLARE
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _pu_rec(39, 'rejected, with the record kept',
    _pu_link('7001'), 'rejected|no driver|null|null|null|' || admin_a);
END $$;

-- ─── 5. a support session unlinks as the administrator would ────────────────

DO $$
DECLARE
  staff   constant text := '4a000000-0000-4000-8000-0000000000e1';
  staff_s constant text := '4a000000-0000-4000-8000-0000000000e2';
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  PERFORM _pu_call(staff, format($q$SELECT platform_context_open(%L, 'support', 'unlink probe, long enough')::text$q$, co_a), staff_s);
  PERFORM _pu_rec(40, 'inside a SUPPORT session the platform account unlinks',
    _pu_call(staff, _pu_unlink('4a000000-0000-4000-8000-000000007003'), staff_s),
    'true|4a000000-0000-4000-8000-0000000000d3');
  PERFORM _pu_call(staff, 'SELECT platform_context_close(NULL)::text', staff_s);
END $$;

DO $$
DECLARE
  staff constant text := '4a000000-0000-4000-8000-0000000000e1';
BEGIN
  PERFORM _pu_rec(41, 'and the record names the platform account',
    _pu_link('7003'), 'pending|no driver|null|unlinked|null|' || staff);
END $$;

-- ─── 6. the table: an INSERT carrying a record is refused ───────────────────

DO $$
DECLARE
  admin_b constant text := 'b0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _pu_rec(42, 'a service-role INSERT that carries an unlink record is refused by the guard',
    _pu_call('service', format($q$WITH i AS (
        INSERT INTO partner_driver_links (company_id, partner, external_driver_id, proposed_name, unlinked_by, unlinked_at)
        VALUES ('c0000000-0000-4000-8000-00000000000b', 'reidey', '7901', 'Pu Fremd', %L, now()) RETURNING 1)
      SELECT count(*)::text FROM i$q$, admin_b)),
    'ERR 42501 unlink_record_protected');
  PERFORM _pu_rec(43, 'the same INSERT without a record is admitted, so the refusal is the guard and not a grant',
    _pu_undone('service', $q$WITH i AS (
        INSERT INTO partner_driver_links (company_id, partner, external_driver_id, proposed_name)
        VALUES ('c0000000-0000-4000-8000-00000000000b', 'reidey', '7901', 'Pu Fremd') RETURNING 1)
      SELECT count(*)::text FROM i$q$),
    '1');
END $$;

-- ─── 7. mutation controls ───────────────────────────────────────────────────

DO $$
DECLARE
  admin_a constant text := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _pu_rec(44, 'control fixture: the administrator unlinks the fifth link (automatic_create)',
    _pu_call(admin_a, _pu_unlink('4a000000-0000-4000-8000-000000007005')), 'true|4a000000-0000-4000-8000-0000000000d5');
END $$;

DO $$
DECLARE
  admin_a  constant text := 'a0000000-0000-4000-8000-000000000001';
  editor_a constant text := 'a0000000-0000-4000-8000-000000000002';
  viewer_a constant text := 'a0000000-0000-4000-8000-000000000003';
  c_unlink constant text := 'public.partner_driver_link_unlink(uuid)';
  c_import constant text := 'public.partner_drivers_import(text)';
  c_place  constant text := 'app_private.partner_place_earners(uuid,text,jsonb,text,uuid)';
  c_guard  constant text := 'app_private.partner_link_guard_unlink_record()';
  l4       constant uuid := '4a000000-0000-4000-8000-000000007004';
  l5       constant uuid := '4a000000-0000-4000-8000-000000007005';
  l7       constant uuid := '4a000000-0000-4000-8000-000000007007';
  v_erase  text := _pu_patch('4a000000-0000-4000-8000-000000007005', 'unlinked_by = NULL, unlinked_at = NULL, decision_reason = NULL');
  v_auto   text := _pu_patch('4a000000-0000-4000-8000-000000007005',
                     $s$status = 'linked', driver_id = '4a000000-0000-4000-8000-0000000000d5', link_method = 'automatic_match', decision_reason = NULL$s$);
  v_reason text := _pu_patch('4a000000-0000-4000-8000-000000007007', $s$decision_reason = 'unlinked'$s$);
  v_half   text := _pu_patch('4a000000-0000-4000-8000-000000007007', format('unlinked_by = %L', 'a0000000-0000-4000-8000-000000000001'));
BEGIN
  -- The page gate.
  PERFORM _pu_rec(45, 'control: without the page gate a viewer unlinks',
    _pu_mutant(c_unlink, $s$OR NOT public.current_role_permits('drivers', true)$s$, '', viewer_a, _pu_unlink(l4)),
    'true|4a000000-0000-4000-8000-0000000000d4');
  PERFORM _pu_rec(46, '... and with it, refused',
    _pu_undone(viewer_a, _pu_unlink(l4)), 'ERR 42501 not_authorized');

  -- The status check.
  PERFORM _pu_rec(47, 'control: without the status check a pending row is "unlinked"',
    _pu_mutant(c_unlink, $s$IF v_link.status <> 'linked' THEN$s$, 'IF false THEN', admin_a, _pu_unlink(l7)),
    'true|null');
  PERFORM _pu_rec(48, '... and with it, not_linked',
    _pu_undone(admin_a, _pu_unlink(l7)), 'ERR P0001 not_linked');

  -- Who is recorded.
  PERFORM _pu_rec(49, 'control: a function that records someone else is seen',
    _pu_mutant(c_unlink, 'unlinked_by = v_caller', $s$unlinked_by = '00000000-0000-4000-8000-000000000000'$s$,
               admin_a, format('SELECT _pu_unlink_then_by(%L)', l4)),
    '00000000-0000-4000-8000-000000000000');
  PERFORM _pu_rec(50, '... and the real one records the caller',
    _pu_undone(admin_a, format('SELECT _pu_unlink_then_by(%L)', l4)), admin_a);

  -- The import's skip. Without it the rule finds the same driver, and the
  -- table's wall (unlinked_stays_manual) is what refuses the link.
  PERFORM _pu_rec(51, 'control: without the import''s skip the rule re-links it, and the CHECK refuses the whole import',
    _pu_mutant(c_import, 'IF v_link.unlinked_at IS NOT NULL THEN', 'IF false THEN',
               admin_a, format('SELECT _pu_import_reason(%L)', l5)),
    'ERR 23514 (no hint)');
  PERFORM _pu_rec(52, '... and with it, skipped as unlinked',
    _pu_undone(admin_a, format('SELECT _pu_import_reason(%L)', l5)), 'unlinked');

  -- The placement's skip, in both modes.
  PERFORM _pu_rec(53, 'control: without the placement''s skip the nightly door re-links it, and the CHECK refuses',
    _pu_mutant(c_place, 'ELSIF FOUND AND v_link.unlinked_at IS NOT NULL THEN', 'ELSIF false THEN',
               'owner', $q$SELECT _pu_door('7005', 'Pu Fuenf')$q$),
    'ERR 23514 (no hint)');
  PERFORM _pu_rec(54, '... and with it, refused as unlinked',
    _pu_undone('owner', $q$SELECT _pu_door('7005', 'Pu Fuenf')$q$), 'true|unlinked');
  PERFORM _pu_rec(55, 'control: without it the human resolve''s looser match re-links it too',
    _pu_mutant(c_place, 'ELSIF FOUND AND v_link.unlinked_at IS NOT NULL THEN', 'ELSIF false THEN',
               admin_a, $q$SELECT _pu_resolve('7005', 'Pu Fuenf')$q$),
    'ERR 23514 (no hint)');
  PERFORM _pu_rec(56, '... and with it, skipped as unlinked',
    _pu_undone(admin_a, $q$SELECT _pu_resolve('7005', 'Pu Fuenf')$q$), 'true|unlinked');

  -- The guard's role test.
  PERFORM _pu_rec(57, 'control: a guard that lets every role through lets a PATCH erase the record',
    _pu_mutant(c_guard, 'IF NOT (current_user::text = ANY (c_api_roles)) THEN', 'IF true THEN', editor_a, v_erase),
    '1');
  PERFORM _pu_rec(58, '... and the real guard refuses it',
    _pu_undone(editor_a, v_erase), 'ERR 42501 unlink_record_protected');

  -- The three CHECKs, as the owner (whom the guard lets through), so the table
  -- is what refuses.
  PERFORM _pu_rec(59, 'control: without unlinked_stays_manual an automatic link of an unlinked row is stored',
    _pu_mutant_ddl('partner_driver_links_unlinked_stays_manual', 'owner', v_auto), '1');
  PERFORM _pu_rec(60, '... and with it, refused',
    _pu_undone('owner', v_auto), 'ERR 23514 (no hint)');
  PERFORM _pu_rec(61, 'a MANUAL link of the same row is admitted by the same CHECK',
    _pu_undone('owner', replace(v_auto, 'automatic_match', 'manual')), '1');
  PERFORM _pu_rec(62, 'control: without unlinked_reason_recorded the reason is stored with no record',
    _pu_mutant_ddl('partner_driver_links_unlinked_reason_recorded', 'owner', v_reason), '1');
  PERFORM _pu_rec(63, '... and with it, refused',
    _pu_undone('owner', v_reason), 'ERR 23514 (no hint)');
  PERFORM _pu_rec(64, 'control: without unlinked_pair half a record is stored',
    _pu_mutant_ddl('partner_driver_links_unlinked_pair', 'owner', v_half), '1');
  PERFORM _pu_rec(65, '... and with it, refused',
    _pu_undone('owner', v_half), 'ERR 23514 (no hint)');
END $$;

DO $$
BEGIN
  PERFORM _pu_rec(66, 'the controls left everything as they found it',
    _pu_link('7004') || ' ' || _pu_link('7005') || ' ' || _pu_link('7007'),
    'linked|Pu Vier|automatic_match|null|null|null pending|no driver|null|unlinked|null|a0000000-0000-4000-8000-000000000001 pending|no driver|null|name_missing|null|null');
END $$;

-- ─── the verdict ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad int;
  v_all int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT matched), count(*) INTO v_bad, v_all FROM _pu_out;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'partner unlink: % of % probe(s) did not match - read the XX lines above', v_bad, v_all;
  END IF;
  RAISE NOTICE '-- partner unlink: all % probes matched --', v_all;
END $$;

ROLLBACK;
