/*
  What the support-write audit copies and what it hides, on both of the paths a
  driver's note travels (migration 20261023180000).

  `app_private.support_write_redaction_pattern(table)` is the one place that
  says, per table, which column values `record_support_write` copies into the
  audit row and which it replaces with `{"redacted": true}`. It named
  `driver_notes.note_text` and nothing at all on `partner_note_submissions`, so
  the same sentence -- stored twice, once on the submission the partner sent and
  once on the note a reviewer accepted it into -- was hidden on one path and
  copied in full on the other. `tests/rls/note-submission-delete.sql` probe 37
  measured that; `20261023180000` closed it; this file is the rule.

  Runs after the files before it, against the same throwaway database, as
  supabase_admin. The whole file is one transaction rolled back at the end, so
  the files after it see the database as the seeds left it -- the mutations of
  section 4 included.

  Collect-then-raise: every probe is recorded in a temp table and the file fails
  at the end, so one run answers everything instead of stopping at the first
  surprise. The verdict asserts the probe COUNT before it looks at the
  mismatches, because a probe that never recorded cannot fail and three missing
  rows in a sibling file were exactly its three mutation controls. Probe numbers
  are never reused.

  What is covered, in order:

    1. the pattern, read from the catalogue and from the function's own answers:
       its shape and grants, the two generic alternatives character for
       character, every arm by payload including the ones 20261023180000 did not
       touch, and the exact redacted column set of the two submission tables,
       of `driver_notes` and of `receipts`
    2. the note path, on a real write: a support session's delete of an accepted
       note cascades into the submission, and the submission's audit row hides
       the driver's sentence and the reviewer's reason while keeping every
       identifier, the status, the window and the plate
    3. the Beleg path, the same way, and the one asymmetry that is deliberate:
       the Beleg's description is copied in clear on the submission's row
       because it is copied in clear on the `receipts` row the submission
       becomes
    4. the mutation controls: the two new arms removed, the Beleg arm widened to
       the description, and `note_text` dropped from the `driver_notes` arm,
       each re-measured and rolled back

  Why the live probes write through a cascade rather than directly: measured on
  staging on 23.10.2026, both tables carry exactly one policy each, a SELECT for
  `authenticated` (`20261008160000` dropped the UPDATE policy and neither ever
  had an INSERT or a DELETE one). So no caller reaches either table through
  PostgREST, and a support session's write arrives as the cascade of
  `20261023150000` and `20261023160000` -- deleting the Beleg or the note the
  submission names -- or through one of the SECURITY DEFINER intake and review
  RPCs. The cascade is the path these probes take, and it is also the path on
  which the defect was measured.

  What it does not claim: where the audit trigger sits, who arms the flag, the
  session and company walls, the size cap and the JSON rule
  (support-write-audit.sql); the cascades themselves
  (note-submission-delete.sql, partner-submission-delete.sql); tenancy and the
  role gate on either table (matrix.sql, permission-coverage.sql); and whether
  these are the right columns to hide -- that is a data-protection decision,
  recorded in 20261023180000's header, not a finding of this file.
*/

\set ON_ERROR_STOP on

BEGIN;

-- The fixture was dumped with --schema=public, so these are stubs, exactly as
-- support-write-audit.sql and note-submission-delete.sql build them. Each file
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

CREATE TEMP TABLE _swr_out (
  n        integer PRIMARY KEY,
  label    text    NOT NULL,
  actual   text    NOT NULL,
  expected text    NOT NULL,
  matched  boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _swr_rec(p_n integer, p_label text, p_actual text, p_expected text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ok boolean := p_actual IS NOT DISTINCT FROM p_expected;
BEGIN
  INSERT INTO _swr_out VALUES (p_n, p_label, coalesce(p_actual, '<null>'), p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', coalesce(p_actual, '<null>');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION _swr_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_what
    -- the seed's company A and its administrator (roles-seed.sql, seed.sql)
    WHEN 'user:admin' THEN 'a0000000-0000-4000-8000-000000000001'::uuid
    WHEN 'company:a'  THEN 'c0000000-0000-4000-8000-00000000000a'::uuid
    ELSE md5('swr:' || p_what)::uuid
  END
$$;

CREATE OR REPLACE FUNCTION _swr_reset() RETURNS void
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
  Become a signed-in caller with a password sign-in and the sign-in session a
  context is answered to. The singular claims, as in support-write-audit.sql:
  app_private.jwt_subject_source() reads the amr out of the same form the
  subject came from.
*/
CREATE OR REPLACE FUNCTION _swr_as(p_user uuid, p_session uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _swr_reset();
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  PERFORM set_config('request.jwt.claim.session_id', p_session::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/*
  The pattern for one table, read through EXECUTE rather than a static call.

  Section 4 replaces the function and asks again in the same session. A static
  plpgsql statement calling an IMMUTABLE function with a known argument is a
  cached plan the planner may have constant-folded, and this repository's own
  notes on the plan cache are the reason not to reason about whether that plan
  is invalidated: EXECUTE is planned on every execution, so the answer is the
  current body's by construction. It costs one replan per probe.
*/
CREATE OR REPLACE FUNCTION _swr_pattern(p_table text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_out text;
BEGIN
  EXECUTE format('SELECT app_private.support_write_redaction_pattern(%L)', p_table) INTO v_out;
  RETURN v_out;
END $$;

/** The arm of one table: its pattern with the generic answer stripped off. */
CREATE OR REPLACE FUNCTION _swr_arm(p_table text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_generic text := _swr_pattern('no_such_table');
  v_full    text := _swr_pattern(p_table);
BEGIN
  IF v_full IS NULL OR v_generic IS NULL THEN
    RETURN '<null>';
  END IF;
  IF left(v_full, length(v_generic)) IS DISTINCT FROM v_generic THEN
    RETURN '<not the generic answer plus an arm: ' || v_full || '>';
  END IF;
  RETURN coalesce(nullif(substr(v_full, length(v_generic) + 1), ''), '(no arm)');
END $$;

/** The columns of a table the audit replaces by a marker, as a sorted list. */
CREATE OR REPLACE FUNCTION _swr_redacted(p_table text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_out text;
BEGIN
  SELECT coalesce(string_agg(a.attname, ',' ORDER BY a.attname), '(none)')
    INTO v_out
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = ('public.' || p_table)::regclass
     AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname ~ _swr_pattern(p_table);
  RETURN v_out;
END $$;

/**
  Replace the redaction pattern's body, for the mutation controls. The find
  string must occur exactly once, so a mutation that silently matched nothing
  -- and would then "prove" that every probe is insensitive -- fails loudly
  instead.
*/
CREATE OR REPLACE FUNCTION _swr_mutate(p_find text, p_replace text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_def  text := pg_catalog.pg_get_functiondef(
                   'app_private.support_write_redaction_pattern(text)'::regprocedure);
  v_hits int;
BEGIN
  v_hits := (length(v_def) - length(replace(v_def, p_find, ''))) / length(p_find);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'support write redaction: the mutation target %L occurs % times, not once', p_find, v_hits;
  END IF;
  EXECUTE replace(v_def, p_find, p_replace);
END $$;

/** The newest support-write audit row for one table, after a mark. */
CREATE OR REPLACE FUNCTION _swr_row(p_since bigint, p_action text)
RETURNS app_private.platform_audit_log
LANGUAGE sql AS $$
  SELECT l.* FROM app_private.platform_audit_log l
   WHERE l.id > p_since AND l.action = p_action
   ORDER BY l.id DESC LIMIT 1
$$;

/** Whether a sentence appears anywhere in the two value sides of an audit row. */
CREATE OR REPLACE FUNCTION _swr_absent(p_row app_private.platform_audit_log, p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN strpos(coalesce(($1).before_value::text, '')
                          || coalesce(($1).after_value::text, ''), $2) = 0
              THEN 'absent' ELSE 'PRESENT' END
$$;

-- ─── principals and data ────────────────────────────────────────────────────
--
-- This file's own platform owner, its own driver, and one note and one Beleg
-- per path, each named by an accepted submission. The driver is its own so no
-- cascade reaches a fixture another file owns.

INSERT INTO auth.users (id, email, email_confirmed_at)
VALUES (_swr_id('user:owner'), 'swr-owner@test.invalid', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
VALUES (_swr_id('user:owner'), 'swr-owner@test.invalid', 'SWR Owner', 'viewer',
        (SELECT r.id FROM roles r WHERE r.name = 'viewer' AND r.company_id IS NULL),
        NULL, 'active')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES (_swr_id('user:owner'), 'owner', 'swr')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
VALUES (_swr_id('session:owner'), _swr_id('user:owner'))
ON CONFLICT (id) DO NOTHING;

INSERT INTO drivers (id, company_id, name)
VALUES (_swr_id('driver:own'), _swr_id('company:a'), 'SWR Driver');

-- `entry_source` is left to the provenance trigger of 20261022150000, as every
-- other file that inserts a driver note does.
INSERT INTO driver_notes (id, created_by, driver_id, note_text, company_id)
VALUES (_swr_id('note:supp'), _swr_id('user:admin'), _swr_id('driver:own'),
        'SWR-NOTE-SENTENCE krank bis Freitag', _swr_id('company:a'));

-- An accepted submission may carry a rejected_reason: the CHECK only requires
-- one when the status IS 'rejected'. Both free-text columns are filled, so the
-- probes have something to look for rather than a NULL that a marker would
-- hide either way.
INSERT INTO partner_note_submissions
  (id, company_id, partner, external_submission_id, external_driver_id, driver_id,
   note_type, note_text, status, driver_note_id, rejected_reason, vehicle_plate,
   start_date, end_date, is_full_day, raw_payload)
VALUES
  (_swr_id('sub:note'), _swr_id('company:a'), 'reidey', 'swr-ext-1', '7001',
   _swr_id('driver:own'), 'general', 'SWR-NOTE-SENTENCE krank bis Freitag', 'accepted',
   _swr_id('note:supp'), 'SWR-REASON-SENTENCE unbelegt', 'B-SWR-1',
   '2026-10-05', '2026-10-09', true,
   jsonb_build_object('note', 'SWR-PAYLOAD-SENTENCE im Rohdokument'));

INSERT INTO receipts (id, company_id, receipt_number, date, description, driver_name)
VALUES (_swr_id('receipt:supp'), _swr_id('company:a'), 'BEL-SWR-1', '2026-10-05',
        'SWR-BELEG-DESCRIPTION Diesel', 'SWR Driver');

INSERT INTO partner_receipt_submissions
  (id, company_id, partner, external_submission_id, external_driver_id, driver_id,
   description, merchant_name, category, city, postal_code, payment_method, amount,
   status, receipt_id, rejected_reason)
VALUES
  (_swr_id('sub:receipt'), _swr_id('company:a'), 'reidey', 'swr-ext-2', '7002',
   _swr_id('driver:own'), 'SWR-BELEG-DESCRIPTION Diesel', 'SWR Tankstelle', 'Tanken',
   'Berlin', '10115', 'bar', 42.50,
   'accepted', _swr_id('receipt:supp'), 'SWR-REASON-RECEIPT unleserlich');

-- ─── 1. the pattern, from the catalogue and from its own answers ────────────

DO $$
DECLARE
  c_generic1 CONSTANT text :=
    '^(?!.*_id$).*(salary|gehalt|payroll|gross|brutto|netto|hourly_rate|payout|bank_account|tax_id|steuer|sozialversicherung|social_security|birth|geburt|personalnummer|gender)';
  c_generic2 CONSTANT text := '|^(?!.*_id$)(.*_)?(iban|bic)(_.*)?$';
  v_oid  regprocedure := 'app_private.support_write_redaction_pattern(text)'::regprocedure;
  v_gen  text := _swr_pattern('no_such_table');
BEGIN
  PERFORM _swr_rec(1, 'the pattern is a pure sql expression, SECURITY INVOKER, with search_path pinned',
    (SELECT l.lanname || '/' || p.provolatile || '/' || p.prosecdef::text
              || '/' || array_to_string(p.proconfig, ',') || '/' || pg_get_userbyid(p.proowner)
       FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = v_oid),
    'sql/i/false/search_path=pg_catalog/supabase_admin');

  PERFORM _swr_rec(2, 'no role the API authenticates as may call it',
    (SELECT string_agg(r || '=' || has_function_privilege(r, v_oid::oid, 'EXECUTE')::text, ',' ORDER BY r)
       FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r),
    'anon=false,authenticated=false,service_role=false');

  -- The two alternatives that apply to EVERY table and carry the whole
  -- pay-and-identifier rule. Compared character for character, because this is
  -- what a careless restatement loses in silence.
  PERFORM _swr_rec(3, 'a table with no arm is screened by exactly the two generic alternatives',
    v_gen, c_generic1 || c_generic2);

  PERFORM _swr_rec(4, 'and the generic rule still works in both directions',
    (SELECT string_agg(c || '=' || (c ~ v_gen)::text, ',' ORDER BY c)
       FROM unnest(ARRAY['gross_salary', 'iban', 'personalnummer', 'driver_id', 'status', 'note_type']) AS c),
    'driver_id=false,gross_salary=true,iban=true,note_type=false,personalnummer=true,status=false');

  -- Every arm, by payload. `amount` appears in four of them and
  -- `rejected_reason` in three, so a substring search on a payload proves
  -- nothing about the arm it was meant to prove; the arm is read as the
  -- function's own answer with the generic prefix stripped.
  PERFORM _swr_rec(5, 'the eight arms that existed before 20261023180000 are unchanged, payload by payload',
    (SELECT string_agg(t || ' ' || _swr_arm(t), E'\n' ORDER BY t) FROM unnest(ARRAY[
       'salaries', 'salary_payments', 'salary_cash_receipts', 'cash_movements',
       'planning_run_adjustments', 'historical_reconciliation_wh_drivers',
       'driver_notes', 'document_variables']) AS t),
    'cash_movements |^(amount)$' || E'\n' ||
    'document_variables |^(value|default_value)$' || E'\n' ||
    'driver_notes |^(note_text|rejected_reason|latitude|longitude)$' || E'\n' ||
    'historical_reconciliation_wh_drivers |^(total_amount_cents)$' || E'\n' ||
    'planning_run_adjustments |^(amount)$' || E'\n' ||
    'salaries |^(calc_revenue|calc_tips|amount_due|total_paid|remaining_balance|additional_net_payment_amount|notes|additional_payment_note)$' || E'\n' ||
    'salary_cash_receipts |^(amount|due_amount|paid_cash_manual_before|paid_cash_weekly_before|paid_cash_receipts_before|paid_bank_before|remaining_before|remaining_after)$' || E'\n' ||
    'salary_payments |^(amount|description)$');

  PERFORM _swr_rec(6, 'and the two arms 20261023180000 adds say exactly what its header says',
    _swr_arm('partner_note_submissions') || ' / ' || _swr_arm('partner_receipt_submissions'),
    '|^(note_text|rejected_reason)$ / |^(rejected_reason)$');

  -- Read against the real columns, so neither a missing nor an extra column
  -- passes, and so a column added to either table later lands here.
  PERFORM _swr_rec(7, 'the columns of partner_note_submissions the audit replaces by a marker are exactly these two',
    _swr_redacted('partner_note_submissions'), 'note_text,rejected_reason');

  PERFORM _swr_rec(8, 'the columns of partner_receipt_submissions are exactly this one',
    _swr_redacted('partner_receipt_submissions'), 'rejected_reason');

  PERFORM _swr_rec(9, 'driver_notes is untouched by 20261023180000: still 20261022150000''s four',
    _swr_redacted('driver_notes'), 'latitude,longitude,note_text,rejected_reason');

  -- The row a receipt submission becomes. `receipts` has no arm, so the
  -- description, the merchant and the amount are copied in clear there -- which
  -- is why leaving them in clear on the submission is the consistent answer and
  -- not an omission. If `receipts` ever gains an arm, this probe is where the
  -- submission's arm has to be reconsidered with it.
  PERFORM _swr_rec(10, 'receipts, the row a Beleg submission becomes, has no arm and redacts nothing',
    _swr_arm('receipts') || ' / ' || _swr_redacted('receipts'), '(no arm) / (none)');

  -- And driver_notes is the other direction of the same argument: the note the
  -- note submission becomes DOES hide its text, which is the asymmetry
  -- 20261023180000 removed.
  PERFORM _swr_rec(11, 'the note''s own text and the submission''s are now screened by the same rule',
    (SELECT string_agg(x, ',' ORDER BY x) FROM unnest(ARRAY[
       'driver_notes.note_text=' || ('note_text' ~ _swr_pattern('driver_notes'))::text,
       'partner_note_submissions.note_text=' || ('note_text' ~ _swr_pattern('partner_note_submissions'))::text]) AS x),
    'driver_notes.note_text=true,partner_note_submissions.note_text=true');
END $$;

-- ─── 2. the note path, on a real support write ──────────────────────────────
--
-- A platform owner opens a support session on company A and deletes the
-- accepted note. The cascade of 20261023160000 removes the submission with it,
-- and a cascade fires row triggers, so there are two audit rows. The
-- submission's is the subject.

DO $$
DECLARE
  co_a   constant uuid  := _swr_id('company:a');
  u_o    constant uuid  := _swr_id('user:owner');
  s_o    constant uuid  := _swr_id('session:owner');
  c_red  constant jsonb := '{"redacted": true}';
  v_open jsonb;
  v_ctx  uuid;
  v_mark bigint;
  r_note app_private.platform_audit_log;
  r_sub  app_private.platform_audit_log;
BEGIN
  PERFORM _swr_as(u_o, s_o);
  v_open := public.platform_context_open(co_a, 'support', 'Ticket SWR-redaction');
  PERFORM _swr_reset();

  PERFORM _swr_rec(12, 'the platform owner opens a support session on company A',
    (v_open ->> 'success'), 'true');
  v_ctx := (v_open -> 'context' ->> 'id')::uuid;

  SELECT coalesce(max(l.id), 0) INTO v_mark FROM app_private.platform_audit_log l;

  PERFORM _swr_as(u_o, s_o);
  DELETE FROM driver_notes WHERE id = _swr_id('note:supp');
  PERFORM _swr_reset();

  PERFORM _swr_rec(13, 'the delete leaves one audit row per table and nothing else',
    (SELECT string_agg(l.action, ' + ' ORDER BY l.action)
       FROM app_private.platform_audit_log l WHERE l.id > v_mark),
    'support_write.driver_notes.delete + support_write.partner_note_submissions.delete');

  r_note := _swr_row(v_mark, 'support_write.driver_notes.delete');
  r_sub  := _swr_row(v_mark, 'support_write.partner_note_submissions.delete');

  -- The defect, now the assertion: both free-text columns of the submission are
  -- markers, on the side a delete records.
  PERFORM _swr_rec(14, 'the submission''s audit row replaces the driver''s sentence and the reviewer''s reason by a marker',
    (r_sub.before_value -> 'values' -> 'note_text')::text
      || ' / ' || (r_sub.before_value -> 'values' -> 'rejected_reason')::text,
    c_red::text || ' / ' || c_red::text);

  -- Markers are not enough on their own: a value could be hidden in the
  -- document the row also carries. So the sentences are searched for in the
  -- whole row, both sides.
  PERFORM _swr_rec(15, 'and neither sentence, nor the one in the raw payload, is anywhere in the row',
    _swr_absent(r_sub, 'SWR-NOTE-SENTENCE') || '/' || _swr_absent(r_sub, 'SWR-REASON-SENTENCE')
      || '/' || _swr_absent(r_sub, 'SWR-PAYLOAD-SENTENCE'),
    'absent/absent/absent');

  -- The other half, and the one that stops this from being "redact everything":
  -- the audit row still says who did what to which row.
  PERFORM _swr_rec(16, 'while the identifiers, the status, the type, the window and the plate are in clear',
    (r_sub.before_value -> 'values' ->> 'id')
      || '/' || (r_sub.before_value -> 'values' ->> 'company_id')
      || '/' || (r_sub.before_value -> 'values' ->> 'partner')
      || '/' || (r_sub.before_value -> 'values' ->> 'external_submission_id')
      || '/' || (r_sub.before_value -> 'values' ->> 'external_driver_id')
      || '/' || (r_sub.before_value -> 'values' ->> 'driver_id')
      || '/' || (r_sub.before_value -> 'values' ->> 'status')
      || '/' || (r_sub.before_value -> 'values' ->> 'note_type')
      || '/' || (r_sub.before_value -> 'values' ->> 'start_date')
      || '/' || (r_sub.before_value -> 'values' ->> 'end_date')
      || '/' || (r_sub.before_value -> 'values' ->> 'is_full_day')
      || '/' || (r_sub.before_value -> 'values' ->> 'vehicle_plate'),
    _swr_id('sub:note')::text || '/' || co_a::text || '/reidey/swr-ext-1/7001/'
      || _swr_id('driver:own')::text || '/accepted/general/2026-10-05/2026-10-09/true/B-SWR-1');

  PERFORM _swr_rec(17, 'the JSON document is recorded as its size, by type and not by name',
    (r_sub.before_value -> 'values' -> 'raw_payload' ->> 'omitted')
      || '/' || ((r_sub.before_value -> 'values' -> 'raw_payload' ->> 'bytes')::int > 0)::text,
    'true/true');

  PERFORM _swr_rec(18, 'and the actor, the context and the reason are on the submission''s row, not only the note''s',
    r_sub.actor_user_id::text || '/' || r_sub.actor_role || '/' || r_sub.session_id::text
      || '/' || (r_sub.after_value ->> 'context_id') || '/' || (r_sub.after_value ->> 'reason')
      || '/' || r_sub.company_id::text || '/' || r_sub.target_type || '/' || r_sub.target_id,
    u_o::text || '/owner/' || s_o::text || '/' || v_ctx::text || '/Ticket SWR-redaction/'
      || co_a::text || '/partner_note_submissions/' || _swr_id('sub:note')::text);

  PERFORM _swr_rec(19, 'the note''s own row is unchanged: its text is still a marker',
    (r_note.before_value -> 'values' -> 'note_text')::text || '/' || _swr_absent(r_note, 'SWR-NOTE-SENTENCE'),
    c_red::text || '/absent');
END $$;

-- ─── 3. the Beleg path, and the asymmetry that is deliberate ────────────────

DO $$
DECLARE
  co_a   constant uuid  := _swr_id('company:a');
  u_o    constant uuid  := _swr_id('user:owner');
  s_o    constant uuid  := _swr_id('session:owner');
  c_red  constant jsonb := '{"redacted": true}';
  v_mark bigint;
  r_rec  app_private.platform_audit_log;
  r_sub  app_private.platform_audit_log;
BEGIN
  SELECT coalesce(max(l.id), 0) INTO v_mark FROM app_private.platform_audit_log l;

  PERFORM _swr_as(u_o, s_o);
  DELETE FROM receipts WHERE id = _swr_id('receipt:supp');
  PERFORM _swr_reset();

  PERFORM _swr_rec(20, 'the Beleg''s delete cascades into its submission, one audit row per table',
    (SELECT string_agg(l.action, ' + ' ORDER BY l.action)
       FROM app_private.platform_audit_log l WHERE l.id > v_mark),
    'support_write.partner_receipt_submissions.delete + support_write.receipts.delete');

  r_rec := _swr_row(v_mark, 'support_write.receipts.delete');
  r_sub := _swr_row(v_mark, 'support_write.partner_receipt_submissions.delete');

  PERFORM _swr_rec(21, 'the Beleg submission''s row replaces the reviewer''s reason by a marker, and the sentence is gone',
    (r_sub.before_value -> 'values' -> 'rejected_reason')::text
      || ' / ' || _swr_absent(r_sub, 'SWR-REASON-RECEIPT'),
    c_red::text || ' / absent');

  -- Deliberately in clear, and this is the decision 20261023180000's header
  -- states: these describe a purchase, not a person's pay or absence, and the
  -- `receipts` row the submission becomes copies the same values.
  PERFORM _swr_rec(22, 'while the Beleg''s own subject -- description, merchant, category, place and amount -- is in clear',
    (r_sub.before_value -> 'values' ->> 'description')
      || '/' || (r_sub.before_value -> 'values' ->> 'merchant_name')
      || '/' || (r_sub.before_value -> 'values' ->> 'category')
      || '/' || (r_sub.before_value -> 'values' ->> 'city')
      || '/' || (r_sub.before_value -> 'values' ->> 'postal_code')
      || '/' || (r_sub.before_value -> 'values' ->> 'payment_method')
      || '/' || (r_sub.before_value -> 'values' ->> 'amount'),
    'SWR-BELEG-DESCRIPTION Diesel/SWR Tankstelle/Tanken/Berlin/10115/bar/42.50');

  PERFORM _swr_rec(23, 'and its identifiers and status too',
    (r_sub.before_value -> 'values' ->> 'id')
      || '/' || (r_sub.before_value -> 'values' ->> 'external_submission_id')
      || '/' || (r_sub.before_value -> 'values' ->> 'status')
      || '/' || (r_sub.before_value -> 'values' ->> 'receipt_id'),
    _swr_id('sub:receipt')::text || '/swr-ext-2/accepted/' || _swr_id('receipt:supp')::text);

  -- The symmetry argument, measured rather than asserted in prose: the very
  -- same description is copied in clear on the Beleg's own audit row.
  PERFORM _swr_rec(24, 'the Beleg''s own audit row copies that same description in clear, which is why the submission''s does',
    (r_rec.before_value -> 'values' ->> 'description'), 'SWR-BELEG-DESCRIPTION Diesel');
END $$;

-- ─── 4. the mutation controls ───────────────────────────────────────────────
--
-- Each one changes the pattern, re-runs the battery, counts the checks that
-- move, and is rolled back by raising ZZ012 -- which is also what undoes the
-- replaced function, DDL being transactional here.
--
-- The count is assigned to a variable declared OUT HERE and recorded only after
-- the handler has run: plpgsql variables are memory and survive the rollback,
-- while anything `_swr_rec` inserted inside the block would go with it.
-- `partner-submission-delete.sql` records losing all three mutation rows that
-- way, so its verdict counted 34 probes instead of 37 and the three silently
-- missing were exactly the controls.

CREATE OR REPLACE FUNCTION _swr_battery() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_bad integer := 0;
  v_drv uuid := gen_random_uuid();
  v_nid uuid := gen_random_uuid();
  v_sid uuid := gen_random_uuid();
  v_mark bigint;
  r_sub  app_private.platform_audit_log;
BEGIN
  -- a. the two arms this file is about
  IF _swr_redacted('partner_note_submissions') IS DISTINCT FROM 'note_text,rejected_reason' THEN
    v_bad := v_bad + 1;
    RAISE NOTICE '   battery: a (partner_note_submissions set) moved to %', _swr_redacted('partner_note_submissions');
  END IF;
  IF _swr_redacted('partner_receipt_submissions') IS DISTINCT FROM 'rejected_reason' THEN
    v_bad := v_bad + 1;
    RAISE NOTICE '   battery: b (partner_receipt_submissions set) moved to %', _swr_redacted('partner_receipt_submissions');
  END IF;

  -- c. the arm this file did not touch
  IF _swr_redacted('driver_notes') IS DISTINCT FROM 'latitude,longitude,note_text,rejected_reason' THEN
    v_bad := v_bad + 1;
    RAISE NOTICE '   battery: c (driver_notes set) moved to %', _swr_redacted('driver_notes');
  END IF;

  -- d. every arm, by payload, so a restatement that dropped one is caught here
  --    as well as in the migration's own self-check
  IF (SELECT string_agg(t || ' ' || _swr_arm(t), ' | ' ORDER BY t) FROM unnest(ARRAY[
        'salaries', 'salary_payments', 'salary_cash_receipts', 'cash_movements',
        'planning_run_adjustments', 'historical_reconciliation_wh_drivers',
        'driver_notes', 'document_variables',
        'partner_note_submissions', 'partner_receipt_submissions']) AS t)
     IS DISTINCT FROM
     'cash_movements |^(amount)$ | document_variables |^(value|default_value)$ | '
     || 'driver_notes |^(note_text|rejected_reason|latitude|longitude)$ | '
     || 'historical_reconciliation_wh_drivers |^(total_amount_cents)$ | '
     || 'partner_note_submissions |^(note_text|rejected_reason)$ | '
     || 'partner_receipt_submissions |^(rejected_reason)$ | '
     || 'planning_run_adjustments |^(amount)$ | '
     || 'salaries |^(calc_revenue|calc_tips|amount_due|total_paid|remaining_balance|additional_net_payment_amount|notes|additional_payment_note)$ | '
     || 'salary_cash_receipts |^(amount|due_amount|paid_cash_manual_before|paid_cash_weekly_before|paid_cash_receipts_before|paid_bank_before|remaining_before|remaining_after)$ | '
     || 'salary_payments |^(amount|description)$' THEN
    v_bad := v_bad + 1;
    RAISE NOTICE '   battery: d (the arms by payload) moved';
  END IF;

  -- e. the generic rule, which belongs to no arm
  IF _swr_pattern('no_such_table') IS DISTINCT FROM
     '^(?!.*_id$).*(salary|gehalt|payroll|gross|brutto|netto|hourly_rate|payout|bank_account|tax_id|steuer|sozialversicherung|social_security|birth|geburt|personalnummer|gender)'
     || '|^(?!.*_id$)(.*_)?(iban|bic)(_.*)?$' THEN
    v_bad := v_bad + 1;
    RAISE NOTICE '   battery: e (the generic alternatives) moved';
  END IF;

  -- f. and the live path: a support session's cascaded delete, read out of the
  --    audit row rather than out of the pattern, so the battery is not only
  --    measuring a regular expression.
  INSERT INTO drivers (id, company_id, name)
  VALUES (v_drv, _swr_id('company:a'), 'SWR M ' || left(v_drv::text, 8));
  INSERT INTO driver_notes (id, created_by, driver_id, note_text, company_id)
  VALUES (v_nid, _swr_id('user:admin'), v_drv, 'SWR-MUTATION-SENTENCE', _swr_id('company:a'));
  INSERT INTO partner_note_submissions
    (id, company_id, partner, external_submission_id, external_driver_id, driver_id,
     note_type, note_text, status, driver_note_id, rejected_reason)
  VALUES (v_sid, _swr_id('company:a'), 'reidey', 'swr-mut-' || left(v_sid::text, 8), '7999',
          v_drv, 'general', 'SWR-MUTATION-SENTENCE', 'accepted', v_nid, 'SWR-MUTATION-REASON');

  SELECT coalesce(max(l.id), 0) INTO v_mark FROM app_private.platform_audit_log l;
  PERFORM _swr_as(_swr_id('user:owner'), _swr_id('session:owner'));
  DELETE FROM driver_notes WHERE id = v_nid;
  PERFORM _swr_reset();

  r_sub := _swr_row(v_mark, 'support_write.partner_note_submissions.delete');
  IF (r_sub.before_value -> 'values' -> 'note_text')::text IS DISTINCT FROM '{"redacted": true}'
     OR _swr_absent(r_sub, 'SWR-MUTATION-SENTENCE') IS DISTINCT FROM 'absent'
     OR (r_sub.before_value -> 'values' ->> 'external_submission_id')
          IS DISTINCT FROM 'swr-mut-' || left(v_sid::text, 8) THEN
    v_bad := v_bad + 1;
    RAISE NOTICE '   battery: f (the live cascaded row) moved to %', r_sub.before_value -> 'values' -> 'note_text';
  END IF;

  -- The fixture is deliberately not cleaned up: every call makes its own ids,
  -- so nothing collides, and the whole file is rolled back anyway.
  RETURN v_bad;
END $$;

DO $$
DECLARE
  -- The two arms as the splice wrote them, with the trailing indentation, so
  -- removing them leaves the body exactly as 20260920110000 had it.
  c_arms CONSTANT text :=
    'WHEN ''partner_note_submissions'' THEN
             ''note_text|rejected_reason''
           WHEN ''partner_receipt_submissions'' THEN
             ''rejected_reason''
           ';
  c_prs CONSTANT text :=
    'WHEN ''partner_receipt_submissions'' THEN
             ''rejected_reason''';
  c_dn CONSTANT text :=
    'WHEN ''driver_notes'' THEN
             ''note_text';
  v_m1 integer;
  v_m2 integer;
  v_m3 integer;
BEGIN
  PERFORM _swr_rec(25, 'control: against the real pattern the battery has no mismatch',
    _swr_battery()::text, '0');

  -- M1. the defect restored: both new arms removed, which is the pattern as it
  --     stood before 20261023180000. Four of the six checks move -- the two
  --     sets, the arms-by-payload string and the live cascaded row -- and the
  --     driver_notes set and the generic alternatives do not, which is what
  --     stops M1 from passing by breaking everything.
  BEGIN
    PERFORM _swr_mutate(c_arms, '');
    v_m1 := _swr_battery();
    RAISE EXCEPTION USING ERRCODE = 'ZZ012', MESSAGE = 'rollback M1';
  EXCEPTION WHEN SQLSTATE 'ZZ012' THEN NULL;
  END;
  PERFORM _swr_rec(26, 'mutation M1 (both new arms removed, the defect) moves four of six checks',
    v_m1::text, '4');

  -- M2. the Beleg's description redacted after all -- the widening this file
  --     argues against. Two checks move: the Beleg submission's set and the
  --     arms string. The live check is the note's, so it does not.
  BEGIN
    PERFORM _swr_mutate(c_prs, replace(c_prs, '''rejected_reason''', '''rejected_reason|description'''));
    v_m2 := _swr_battery();
    RAISE EXCEPTION USING ERRCODE = 'ZZ012', MESSAGE = 'rollback M2';
  EXCEPTION WHEN SQLSTATE 'ZZ012' THEN NULL;
  END;
  PERFORM _swr_rec(27, 'mutation M2 (the Beleg description redacted too) moves two of six checks',
    v_m2::text, '2');

  -- M3. `note_text` dropped from the arm this file did not touch. Two move: the
  --     driver_notes set and the arms string. The two submission sets and the
  --     live check do not, so neither is quietly measuring the driver_notes arm.
  BEGIN
    PERFORM _swr_mutate(c_dn, replace(c_dn, '''note_text', '''swr_note_text'));
    v_m3 := _swr_battery();
    RAISE EXCEPTION USING ERRCODE = 'ZZ012', MESSAGE = 'rollback M3';
  EXCEPTION WHEN SQLSTATE 'ZZ012' THEN NULL;
  END;
  PERFORM _swr_rec(28, 'mutation M3 (note_text dropped from the driver_notes arm) moves two of six checks',
    v_m3::text, '2');

  PERFORM _swr_rec(29, 'control: after the three mutations are rolled back the battery is clean again',
    _swr_battery()::text, '0');
END $$;

-- ─── the verdict, all at once ───────────────────────────────────────────────

DO $$
DECLARE
  v_bad integer;
  r     record;
  v_msg text := '';
BEGIN
  -- A probe that never recorded cannot fail, so the count is asserted first.
  IF (SELECT count(*) FROM _swr_out) <> 29 THEN
    RAISE EXCEPTION 'support write redaction: % of 29 probes recorded — missing: %',
      (SELECT count(*) FROM _swr_out),
      (SELECT string_agg(n::text, ', ' ORDER BY n) FROM generate_series(1, 29) AS g(n)
        WHERE NOT EXISTS (SELECT 1 FROM _swr_out o WHERE o.n = g.n));
  END IF;

  SELECT count(*) INTO v_bad FROM _swr_out WHERE NOT matched;
  IF v_bad = 0 THEN
    RAISE NOTICE '── support write redaction: all % probes matched ──',
      (SELECT count(*) FROM _swr_out);
    RETURN;
  END IF;
  FOR r IN SELECT * FROM _swr_out WHERE NOT matched ORDER BY n LOOP
    v_msg := v_msg || format(E'\n  %s. %s\n     expected: %s\n     actual:   %s',
                             r.n, r.label, r.expected, r.actual);
  END LOOP;
  RAISE EXCEPTION 'support write redaction: % of % probes did not match:%',
    v_bad, (SELECT count(*) FROM _swr_out), v_msg;
END $$;

ROLLBACK;
