/*
  The record of a detected conflict and of who reviewed it
  (migration 20261023200000, table public.conflict_reviews).

  Runs after assertions.sql against the same throwaway database, as
  supabase_admin. The whole file is one transaction rolled back at the end, so
  the files sorting after it see the database as the seeds left it.

  The kit's fixture is production's --schema=public dump, so it carries no
  findings; the two companies and their people come from tests/rls/seed.sql,
  and 2031 is this file's year, so nothing it writes can be mistaken for
  another file's.

  ── THE RULES, WRITTEN DOWN SO A LATER CHANGE ARGUES WITH THEM ──────────────

  1. **A finding is a list to review, never a verdict.** The schema is what
     keeps it: `detector_status` carries the engines' own three-valued honesty
     and REFUSES 'passed', so a clean check cannot be filed as a finding; the
     reviewer's two words are `acknowledged` and `dismissed`, not `confirmed`
     and `rejected`, because a detector's finding is not a fact a review can
     confirm; and the German is the engine's own, carried with its dictionary
     key, so the storage layer invents no vocabulary. Section 9 reads the
     catalogue for all three.

  2. **A decision that closes the matter says why.** The partner submissions'
     rule — "'Rejected, no reason' is what the driver cannot act on" — applies
     to the decision that makes a finding go away, which here is `dismissed`.
     An acknowledged finding stays visible and needs no justification.

  3. **A reviewed finding is a record.** There is no DELETE policy, and no
     DELETE GRANT either, so a client DELETE is a missing privilege rather than
     a statement that removes nothing while PostgREST answers 200. A decision
     never returns to 'open', and a finding's identity cannot be re-pointed at
     another finding once a decision has been recorded against it.

  4. **Re-running a detector writes no second row.** The key is the detector's
     own identifier plus the analysis month, and it names the SUBJECT of the
     finding, never its measurement or its evidence set.

  5. **A review's author and time are derived, never accepted.** A record whose
     author the client names is not a record. `decided_values` freezes the
     measurement the decision was taken on, while `measured_values` moves with
     every re-detection.

  6. **Writes ask the Dokumente page, reads ask no role**, and both context
     triggers are on the table.

  Every refusal in this file is compared by its **constraint name** or its
  **HINT**, never by its SQLSTATE: every CHECK on this table raises 23514, so a
  probe compared by class would pass on the wrong constraint. `_cr_reason`
  keeps the four classes apart (a missing GRANT, an integrity constraint by
  name, a guard's own snake_case hint, and a policy's message).

  What is covered, in order:

     1. shape        the table, row level security, exactly THREE policies (no
                     DELETE), the tenant term and the page in both halves of
                     every write, the three triggers, the grants with no
                     DELETE, the three indexes, and the guard invoker/definer,
                     pinned and unreachable by an API role
     2. constraints  eight refusals, each by constraint name, and the rows that
                     must be accepted beside them
     3. open only    an administrator cannot FILE a decided finding — the check
                     the migration deliberately left to a principal, because
                     the catalogue version would be a guess at how PostgreSQL
                     deparses the policy
     4. idempotency  the same finding filed twice is one row; a re-run moves the
                     measurement and keeps the id, the first sighting and the
                     decision; another month, another detector and another
                     company are each a second row
     5. the guard    the author and the time are stamped and not accepted; a
                     decision freezes what it was decided on; a decision does
                     not return to open; the identity is immutable; the first
                     sighting is pinned
     6. tenancy      company B's administrator reads none of A's findings,
                     writes none, and cannot move one; the owner can, which is
                     what makes the refusal a policy's and not a trigger's
     7. the gate     a viewer and an editor are refused all three writes and
                     still read; the administrator writes; nobody deletes
     8. contexts     a view context writes nothing; a support session writes the
                     company it opened and leaves one audit row per row
     9. the words    'passed' is refused, the three status words are exactly
                     three, and no column, constraint or guard of this table
                     names a verdict
    10. controls     twelve mutation controls: every assertion above that could
                     pass for the wrong reason is re-run with the rule broken,
                     and must fail
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in vehicle-availability.sql) ──────────────────────────

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

CREATE TEMP TABLE _cr_results (
  n        serial PRIMARY KEY,
  label    text    NOT NULL,
  expected text,
  actual   text,
  ok       boolean NOT NULL
);

/* Record one outcome and print it. A NULL actual never equals anything. */
CREATE OR REPLACE FUNCTION _cr_expect(p_label text, p_expected text, p_actual text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean := p_actual IS NOT DISTINCT FROM p_expected;
BEGIN
  INSERT INTO _cr_results (label, expected, actual, ok) VALUES (p_label, p_expected, p_actual, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok   % [%]', p_label, p_actual;
  ELSE
    RAISE NOTICE 'DIFF % -- expected [%] got [%]', p_label, p_expected, p_actual;
  END IF;
END $$;

/* A boolean check. NULL is a failure: a check that could not be evaluated proved nothing. */
CREATE OR REPLACE FUNCTION _cr_ok(p_label text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _cr_expect(p_label, 'true', coalesce(p_ok::text, 'NULL'));
END $$;

CREATE OR REPLACE FUNCTION _cr_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('cr:' || p_what)::uuid $$;

CREATE OR REPLACE FUNCTION _cr_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

CREATE OR REPLACE FUNCTION _cr_owner() RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid $$;

/* Become a signed-in caller with a password sign-in (every principal in the kit
   carries one since 20260919130000), or anon when p_user is NULL. _cr_owner()
   keeps the table owner, to probe what no policy is asked about. */
CREATE OR REPLACE FUNCTION _cr_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _cr_reset();
  IF p_user = _cr_owner() THEN
    RETURN;
  END IF;
  IF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  IF p_session IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.session_id', p_session::text, true);
  END IF;
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/* What a refusal is reported as, after its SQLSTATE. Four classes, kept apart
   because every CHECK on this table raises 23514 and a probe compared by class
   would pass on the wrong constraint:

     - a missing GRANT, read out of PostgreSQL's message and never from the
       HINT (the supabase/postgres 17.6 image writes a prose hint that
       PostgreSQL 16 does not)
     - an integrity constraint, BY NAME: a CHECK (23514), a unique index
       (23505) or a foreign key (23503)
     - a guard's own gate, which prints its snake_case HINT
     - anything else prints its message, which for a policy names the table */
CREATE OR REPLACE FUNCTION _cr_reason(p_state text, p_message text, p_hint text, p_constraint text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_state = '42501' AND p_message ~ '^permission denied for (table|function|schema) '
      THEN 'privilege ' || regexp_replace(p_message, '^permission denied for (table|function|schema) .*$', '\1')
           || ' ' || regexp_replace(p_message, '^permission denied for (table|function|schema) ', '')
    WHEN p_state LIKE '23%' AND coalesce(p_constraint, '') <> ''
      THEN 'constraint ' || p_constraint
    WHEN p_hint ~ '^[a-z][a-z0-9_]*$' THEN p_hint
    ELSE p_message
  END
$$;

/* Run p_sql as that caller in a subtransaction that is always rolled back and
   return the scalar it answered, `rows N` for a statement without a result, or
   `ERR <sqlstate> <reason>`. Nothing it writes survives, which is what makes
   the refusal probes safe to run inside one transaction. */
CREATE OR REPLACE FUNCTION _cr_try(p_user uuid, p_session uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
  v_hint  text;
  v_con   text;
BEGIN
  BEGIN
    PERFORM _cr_as(p_user, p_session);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ041', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ041' THEN
      v_out := SQLERRM;
    WHEN query_canceled THEN
      v_out := 'ERR 57014 ' || SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_hint = PG_EXCEPTION_HINT, v_con = CONSTRAINT_NAME;
      v_out := 'ERR ' || v_state || ' ' || _cr_reason(v_state, v_msg, v_hint, v_con);
  END;
  PERFORM _cr_reset();
  RETURN v_out;
END $$;

/* p_mutation as the owner, then the probe, then everything rolled back.
   _cr_mutate_fn refuses a mutation that would change nothing, so a control
   cannot silently measure the unmutated code. */
CREATE OR REPLACE FUNCTION _cr_mutant(p_mutation text, p_user uuid, p_session uuid, p_sql text)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text;
BEGIN
  BEGIN
    PERFORM _cr_reset();
    EXECUTE p_mutation;
    v_out := _cr_try(p_user, p_session, p_sql);
    RAISE EXCEPTION USING ERRCODE = 'ZZ042', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ042' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      v_out := 'MUTATION FAILED: ' || SQLERRM;
  END;
  PERFORM _cr_reset();
  RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION _cr_mutate_fn(p_sig text, p_from text, p_to text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_old text := pg_get_functiondef(to_regprocedure(p_sig));
BEGIN
  IF v_old IS NULL OR position(p_from IN v_old) = 0 THEN
    RAISE EXCEPTION 'mutation control: % does not contain [%], so the mutation would change nothing', p_sig, p_from;
  END IF;
  EXECUTE replace(v_old, p_from, p_to);
END $$;

/* The audit log's high-water mark, and the support-write rows since it. */
CREATE OR REPLACE FUNCTION _cr_mark() RETURNS bigint
LANGUAGE sql AS $$ SELECT coalesce(max(l.id), 0) FROM app_private.platform_audit_log l $$;

CREATE OR REPLACE FUNCTION _cr_rows(p_since bigint, p_action text DEFAULT NULL) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*)
    FROM app_private.platform_audit_log l
   WHERE l.id > p_since
     AND l.action ~ '^support_write\.'
     AND (p_action IS NULL OR l.action = p_action)
$$;

/* File one finding as the owner and return its id. The month is this file's
   2031 unless a probe needs another. */
CREATE OR REPLACE FUNCTION _cr_put(
  p_company    uuid,
  p_type       text,
  p_evidence   text,
  p_detector   text DEFAULT 'trip_analysis',
  p_status     text DEFAULT 'conflict',
  p_month      int  DEFAULT 4,
  p_values     jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.conflict_reviews
         (company_id, detector, finding_type, finding_key, period_year, period_month,
          detector_status, severity, confidence, explanation, explanation_key,
          measured_values, first_detected_version, last_detected_version)
  VALUES (p_company, p_detector, p_type, p_type || ':' || p_evidence, 2031, p_month,
          p_status, 'warning', 'high', 'Zu pruefen.', 'engine.analysis.' || p_type,
          p_values, 'cr/1.0.0', 'cr/1.0.0')
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ─── the principals ────────────────────────────────────────────────────────
--   admin A / editor A / viewer A / admin B / the platform owner come from
--   tests/rls/seed.sql. The two context owners below are this file's own.

-- ─── 1. the shape ───────────────────────────────────────────────────────────

DO $$
DECLARE
  c_tbl CONSTANT regclass := to_regclass('public.conflict_reviews');
  v_txt text;
BEGIN
  PERFORM _cr_ok('1a the table exists', c_tbl IS NOT NULL);
  PERFORM _cr_ok('1b row level security is enabled',
    (SELECT relrowsecurity FROM pg_class WHERE oid = c_tbl));

  -- THREE policies, not four: a reviewed finding is a record.
  PERFORM _cr_expect('1c exactly three policies, and no DELETE policy',
    'conflict_reviews_insert/INSERT, conflict_reviews_select/SELECT, conflict_reviews_update/UPDATE',
    (SELECT string_agg(policyname || '/' || cmd, ', ' ORDER BY policyname)
       FROM pg_policies WHERE schemaname = 'public' AND tablename = 'conflict_reviews'));

  -- SELECT is the tenant term and the read seam, with NO role term: 3.3's
  -- shape has none there and this slice did not invent one.
  SELECT qual INTO v_txt FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'conflict_reviews'
     AND policyname = 'conflict_reviews_select';
  PERFORM _cr_ok('1d SELECT names the tenant term and the read seam and no role',
    v_txt LIKE '%get_active_company_id%' AND v_txt LIKE '%platform_reads_company_data%'
    AND v_txt NOT LIKE '%current_role_permits%');

  -- Both halves of UPDATE: writing the predicate twice is what refuses a move.
  PERFORM _cr_ok('1e UPDATE carries the tenant term and the page in USING and in WITH CHECK',
    (SELECT qual       LIKE '%get_active_company_id%' AND qual       LIKE '%documents%'
        AND with_check LIKE '%get_active_company_id%' AND with_check LIKE '%documents%'
       FROM pg_policies WHERE schemaname = 'public' AND tablename = 'conflict_reviews'
        AND policyname = 'conflict_reviews_update'));

  PERFORM _cr_ok('1f INSERT carries the tenant term, the page and a clause about status',
    (SELECT with_check LIKE '%get_active_company_id%' AND with_check LIKE '%documents%'
        AND with_check LIKE '%status%'
       FROM pg_policies WHERE schemaname = 'public' AND tablename = 'conflict_reviews'
        AND policyname = 'conflict_reviews_insert'));

  -- The three triggers. The two context ones are keyed on the policies naming
  -- get_active_company_id(), not on who writes the table today.
  PERFORM _cr_expect('1g the three triggers',
    'conflict_review_guard, record_support_write, refuse_read_only_context_write',
    (SELECT string_agg(tgname, ', ' ORDER BY tgname) FROM pg_trigger
      WHERE tgrelid = c_tbl AND NOT tgisinternal));

  -- The grants: a client reads, files and reviews. Nobody deletes, and a
  -- DELETE privilege with no DELETE policy would remove nothing while
  -- PostgREST answered 200.
  PERFORM _cr_ok('1h authenticated may read, file and review',
    has_table_privilege('authenticated', c_tbl, 'SELECT')
    AND has_table_privilege('authenticated', c_tbl, 'INSERT')
    AND has_table_privilege('authenticated', c_tbl, 'UPDATE'));
  PERFORM _cr_ok('1i nobody holds DELETE, and anon and service_role hold nothing',
    NOT has_table_privilege('authenticated', c_tbl, 'DELETE')
    AND NOT has_table_privilege('anon',         c_tbl, 'SELECT')
    AND NOT has_table_privilege('service_role', c_tbl, 'SELECT'));

  -- The idempotency key, and the two reading indexes.
  PERFORM _cr_ok('1j the unique key is the detector, the month and the finding key',
    EXISTS (SELECT 1 FROM pg_indexes
             WHERE schemaname = 'public' AND tablename = 'conflict_reviews'
               AND indexname = 'conflict_reviews_idempotency'
               AND indexdef LIKE 'CREATE UNIQUE INDEX%(company_id, detector, period_year, period_month, finding_key)'));
  PERFORM _cr_expect('1k and the queue and the month are indexed', '2',
    (SELECT count(*)::text FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'conflict_reviews'
        AND indexname IN ('conflict_reviews_queue', 'conflict_reviews_period')));

  -- The guard: SECURITY DEFINER, pinned search_path, and unreachable.
  PERFORM _cr_ok('1l the guard is SECURITY DEFINER with a pinned search_path',
    (SELECT p.prosecdef
         AND array_to_string(coalesce(p.proconfig, ARRAY[]::text[]), ',') LIKE '%search_path=%'
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app_private' AND p.proname = 'conflict_review_guard'));
  PERFORM _cr_ok('1m no API role may execute the guard',
    NOT has_function_privilege('anon',          'app_private.conflict_review_guard()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'app_private.conflict_review_guard()', 'EXECUTE')
    AND NOT has_function_privilege('service_role',  'app_private.conflict_review_guard()', 'EXECUTE'));

  -- Nothing on a caller's own path may name app_private, and the guard is the
  -- only thing between a caller and this table: it is a definer, so its body
  -- may, but it must not reach a helper the caller would have to parse.
  SELECT p.prosrc INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app_private' AND p.proname = 'conflict_review_guard';
  PERFORM _cr_ok('1n the guard names no other app_private object',
    v_txt NOT LIKE '%app_private.%');

  -- A reviewed finding is a record: nothing in the database removes one.
  PERFORM _cr_expect('1o no function deletes or truncates the table', '<null>',
    (SELECT string_agg(p.oid::regprocedure::text, ', ')
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public', 'app_private')
        AND p.prosrc ~* '(delete\s+from|truncate)\s+(public\.)?conflict_reviews'));
END $$;

-- ─── 2. the constraints, each by its own name ───────────────────────────────

DO $$
DECLARE
  c_co_a CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_cols CONSTANT text :=
    '(company_id, detector, finding_type, finding_key, period_year, period_month, '
    || 'detector_status, severity, confidence, explanation, first_detected_version, last_detected_version';
BEGIN
  -- 2a a dismissal with no reason. The one constraint that carries the partner
  --    submissions' rule across.
  PERFORM _cr_expect('2a a dismissal with no reason is refused',
    'ERR 23514 constraint conflict_reviews_dismissal_has_reason',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s, status) VALUES (%L, ''trip_analysis'', ''driver_overlap'', '
      || '''driver_overlap:x+y'', 2031, 4, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'', '
      || '''dismissed'')', c_cols, c_co_a)));

  -- 2b …and a blank one is not a reason either.
  PERFORM _cr_expect('2b a dismissal whose reason is whitespace is refused too',
    'ERR 23514 constraint conflict_reviews_dismissal_has_reason',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s, status, review_note) VALUES (%L, ''trip_analysis'', '
      || '''driver_overlap'', ''driver_overlap:x+y'', 2031, 4, ''conflict'', ''error'', ''high'', '
      || '''Zu pruefen.'', ''v'', ''v'', ''dismissed'', ''   '')', c_cols, c_co_a)));

  -- 2c an acknowledgement needs none: it stays visible and remains actionable.
  PERFORM _cr_expect('2c an acknowledgement with no note is accepted', 'rows 1',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s, status) VALUES (%L, ''trip_analysis'', ''driver_overlap'', '
      || '''driver_overlap:x+y'', 2031, 4, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'', '
      || '''acknowledged'')', c_cols, c_co_a)));

  -- 2d a clean check is not a finding.
  PERFORM _cr_expect('2d detector_status ''passed'' is refused',
    'ERR 23514 constraint conflict_reviews_detector_status',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s) VALUES (%L, ''trip_analysis'', ''driver_overlap'', '
      || '''driver_overlap:x+y'', 2031, 4, ''passed'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_cols, c_co_a)));

  -- 2e 'unverifiable' is accepted: the panel's "nicht belegt" is a finding.
  PERFORM _cr_expect('2e detector_status ''unverifiable'' is accepted', 'rows 1',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s) VALUES (%L, ''trip_analysis'', ''no_shift_records'', '
      || '''no_shift_records:d1'', 2031, 4, ''unverifiable'', ''info'', ''high'', ''Nicht belegt.'', ''v'', ''v'')',
      c_cols, c_co_a)));

  -- 2f one detector cannot claim another's kind, or one key would mean two
  --    different findings.
  PERFORM _cr_expect('2f return_check claiming a tripAnalysis kind is refused',
    'ERR 23514 constraint conflict_reviews_detector_type',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s) VALUES (%L, ''return_check'', ''driver_overlap'', '
      || '''driver_overlap:x+y'', 2031, 4, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_cols, c_co_a)));

  -- 2g a kind neither detector produces is refused, so an identifier that
  --    changed between releases cannot be stored under its new spelling.
  PERFORM _cr_expect('2g a kind no detector produces is refused',
    'ERR 23514 constraint conflict_reviews_detector_type',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s) VALUES (%L, ''trip_analysis'', ''away_from_base'', '
      || '''away_from_base:r1'', 2031, 4, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_cols, c_co_a)));

  -- 2h the key names its own kind, so the two can never disagree about what
  --    the row is -- which is also why the unique index needs no type column.
  PERFORM _cr_expect('2h a key naming another kind is refused',
    'ERR 23514 constraint conflict_reviews_finding_key_names_type',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s) VALUES (%L, ''trip_analysis'', ''driver_overlap'', '
      || '''vehicle_overlap:x+y'', 2031, 4, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_cols, c_co_a)));

  -- 2i …and it names evidence after the colon: a bare kind is not a finding.
  PERFORM _cr_expect('2i a key with no evidence after its kind is refused',
    'ERR 23514 constraint conflict_reviews_finding_key_names_type',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s) VALUES (%L, ''trip_analysis'', ''driver_overlap'', '
      || '''driver_overlap:'', 2031, 4, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_cols, c_co_a)));

  -- 2j an absent evidence list is NULL and never an empty array, so two rows
  --    cannot say the same thing in two ways. coalesce in the CHECK, because
  --    array_length of an empty array is NULL and a CHECK passes on NULL.
  PERFORM _cr_expect('2j an empty trip_ids array is refused',
    'ERR 23514 constraint conflict_reviews_trip_ids_shape',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s, trip_ids) VALUES (%L, ''trip_analysis'', ''missing_end'', '
      || '''missing_end:t1'', 2031, 4, ''conflict'', ''warning'', ''high'', ''Zu pruefen.'', ''v'', ''v'', '
      || 'ARRAY[]::uuid[])', c_cols, c_co_a)));

  -- 2k …and so is one holding a NULL element.
  PERFORM _cr_expect('2k a trip_ids array holding NULL is refused',
    'ERR 23514 constraint conflict_reviews_trip_ids_shape',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s, trip_ids) VALUES (%L, ''trip_analysis'', ''missing_end'', '
      || '''missing_end:t1'', 2031, 4, ''conflict'', ''warning'', ''high'', ''Zu pruefen.'', ''v'', ''v'', '
      || 'ARRAY[NULL]::uuid[])', c_cols, c_co_a)));

  -- 2l the month is 1-indexed, as fahrtenbuch_imports.month is. 0 is
  --    weekCalculations' January, and that is the trap this codebase sets.
  PERFORM _cr_expect('2l a 0-indexed month is refused',
    'ERR 23514 constraint conflict_reviews_period',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s) VALUES (%L, ''trip_analysis'', ''driver_overlap'', '
      || '''driver_overlap:x+y'', 2031, 0, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_cols, c_co_a)));

  -- 2m a measurement that is not an object. The support-write audit copies a
  --    changed column, and audit_write refuses a value over 32768 bytes.
  PERFORM _cr_expect('2m a measurement that is not a JSON object is refused',
    'ERR 23514 constraint conflict_reviews_measured_values_shape',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s, measured_values) VALUES (%L, ''trip_analysis'', '
      || '''driver_overlap'', ''driver_overlap:x+y'', 2031, 4, ''conflict'', ''error'', ''high'', '
      || '''Zu pruefen.'', ''v'', ''v'', ''[1,2]''::jsonb)', c_cols, c_co_a)));
END $$;

-- ─── 3. a detector files an OPEN finding and nothing else ───────────────────
-- The check the migration deliberately left to a principal: reading it out of
-- the catalogue would be a guess at how PostgreSQL deparses the policy, and
-- what matters is whether the clause is a conjunct of the WHOLE predicate
-- rather than one branch of the platform write seam.
--
-- Both probes satisfy every CHECK on the row (the dismissal carries a reason,
-- and the guard fills reviewed_at and decided_values), so the only refusal
-- available to them is the policy's -- whatever order PostgreSQL applies the
-- two in.

DO $$
DECLARE
  c_co_a  CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_cols  CONSTANT text :=
    '(company_id, detector, finding_type, finding_key, period_year, period_month, '
    || 'detector_status, severity, confidence, explanation, first_detected_version, last_detected_version';
  c_rls   CONSTANT text :=
    'ERR 42501 new row violates row-level security policy for table "conflict_reviews"';
BEGIN
  PERFORM _cr_expect('3a an administrator files an open finding', 'rows 1',
    _cr_try(c_admin, NULL, format(
      'INSERT INTO conflict_reviews %s) VALUES (%L, ''trip_analysis'', ''driver_overlap'', '
      || '''driver_overlap:open1+open2'', 2031, 4, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_cols, c_co_a)));

  PERFORM _cr_expect('3b …and cannot file one already dismissed, reason and all', c_rls,
    _cr_try(c_admin, NULL, format(
      'INSERT INTO conflict_reviews %s, status, review_note) VALUES (%L, ''trip_analysis'', '
      || '''driver_overlap'', ''driver_overlap:open1+open2'', 2031, 4, ''conflict'', ''error'', ''high'', '
      || '''Zu pruefen.'', ''v'', ''v'', ''dismissed'', ''Schon geprueft'')', c_cols, c_co_a)));

  PERFORM _cr_expect('3c …nor one already acknowledged', c_rls,
    _cr_try(c_admin, NULL, format(
      'INSERT INTO conflict_reviews %s, status) VALUES (%L, ''trip_analysis'', ''driver_overlap'', '
      || '''driver_overlap:open1+open2'', 2031, 4, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'', '
      || '''acknowledged'')', c_cols, c_co_a)));

  -- The review itself is an UPDATE, and that one is allowed.
  PERFORM _cr_as(_cr_owner());
  PERFORM _cr_put(c_co_a, 'driver_overlap', 'rev1+rev2');
  PERFORM _cr_reset();
  PERFORM _cr_expect('3d …but it may review one that exists', 'rows 1',
    _cr_try(c_admin, NULL,
      'UPDATE conflict_reviews SET status = ''dismissed'', review_note = ''Mit dem Fahrer geklaert.'' '
      || 'WHERE finding_key = ''driver_overlap:rev1+rev2'''));
END $$;

-- ─── 4. re-running a detector writes no second row ──────────────────────────

DO $$
DECLARE
  c_co_a  CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_co_b  CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000b';
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  v_id    uuid;
  v_first timestamptz;
BEGIN
  v_id := _cr_put(c_co_a, 'driver_overlap', 'i1+i2', 'trip_analysis', 'conflict', 4,
                  '{"overlapMinutes": 41}'::jsonb);
  SELECT first_detected_at INTO v_first FROM public.conflict_reviews WHERE id = v_id;

  -- 4a the same finding again is refused by the unique index, BY NAME, so the
  --    refusal cannot be mistaken for a CHECK or a policy.
  PERFORM _cr_expect('4a the same finding filed twice is refused by the idempotency key',
    'ERR 23505 constraint conflict_reviews_idempotency',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews (company_id, detector, finding_type, finding_key, period_year, '
      || 'period_month, detector_status, severity, confidence, explanation, first_detected_version, '
      || 'last_detected_version) VALUES (%L, ''trip_analysis'', ''driver_overlap'', '
      || '''driver_overlap:i1+i2'', 2031, 4, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_co_a)));

  -- 4b the client's own shape: an upsert on the key, with no review column in
  --    its payload. It lands on the row already on file.
  PERFORM _cr_as(c_admin);
  INSERT INTO public.conflict_reviews
         (company_id, detector, finding_type, finding_key, period_year, period_month,
          detector_status, severity, confidence, explanation, measured_values,
          first_detected_version, last_detected_version)
  VALUES (c_co_a, 'trip_analysis', 'driver_overlap', 'driver_overlap:i1+i2', 2031, 4,
          'conflict', 'error', 'high', 'Zu pruefen.', '{"overlapMinutes": 42}'::jsonb,
          'cr/2.0.0', 'cr/2.0.0')
      ON CONFLICT (company_id, detector, period_year, period_month, finding_key)
      DO UPDATE SET measured_values       = EXCLUDED.measured_values,
                    last_detected_version = EXCLUDED.last_detected_version,
                    last_detected_at      = now(),
                    first_detected_version = EXCLUDED.first_detected_version;
  PERFORM _cr_reset();

  PERFORM _cr_expect('4b a re-run is one row, with the id it already had', '1|' || v_id::text,
    (SELECT count(*)::text || '|' || min(id)::text FROM public.conflict_reviews
      WHERE company_id = c_co_a AND finding_key = 'driver_overlap:i1+i2'));

  PERFORM _cr_expect('4c …the measurement moved and the first sighting did not',
    '42|cr/2.0.0|cr/1.0.0|true',
    (SELECT (measured_values ->> 'overlapMinutes') || '|' || last_detected_version || '|'
            || first_detected_version || '|' || (first_detected_at = v_first)::text
       FROM public.conflict_reviews WHERE id = v_id));

  -- 4d another month is another fact. no_shift_records:<driver> is the same
  --    string in two months while being two different things, which is why the
  --    period is in the key at all.
  PERFORM _cr_put(c_co_a, 'no_shift_records', 'dX', 'trip_analysis', 'unverifiable', 4);
  PERFORM _cr_expect('4d the same key in another month is a second row', 'rows 1',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews (company_id, detector, finding_type, finding_key, period_year, '
      || 'period_month, detector_status, severity, confidence, explanation, first_detected_version, '
      || 'last_detected_version) VALUES (%L, ''trip_analysis'', ''no_shift_records'', '
      || '''no_shift_records:dX'', 2031, 5, ''unverifiable'', ''info'', ''high'', ''Nicht belegt.'', ''v'', ''v'')',
      c_co_a)));

  -- 4e and another company's identical finding is its own row.
  PERFORM _cr_expect('4e the same key in another company is a second row', 'rows 1',
    _cr_try(_cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews (company_id, detector, finding_type, finding_key, period_year, '
      || 'period_month, detector_status, severity, confidence, explanation, first_detected_version, '
      || 'last_detected_version) VALUES (%L, ''trip_analysis'', ''driver_overlap'', '
      || '''driver_overlap:i1+i2'', 2031, 4, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_co_b)));

  -- 4f the version is NOT in the key: a release that bumps it must not discard
  --    the decisions taken under the old one. 4b already proved a re-run under
  --    cr/2.0.0 found the row filed under cr/1.0.0.
  PERFORM _cr_ok('4f the idempotency key names no version',
    (SELECT indexdef NOT LIKE '%version%' FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'conflict_reviews'
        AND indexname = 'conflict_reviews_idempotency'));
END $$;

-- ─── 5. the guard: the author, the freeze, the one-way decision, the identity ─

DO $$
DECLARE
  c_co_a  CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_admin CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_other CONSTANT uuid := 'a0000000-0000-4000-8000-000000000003';
  v_id    uuid;
BEGIN
  v_id := _cr_put(c_co_a, 'travel_gap', 'g1>g2', 'trip_analysis', 'conflict', 4,
                  '{"shortByMinutes": 7}'::jsonb);

  -- 5a an open finding names no reviewer and no time.
  PERFORM _cr_expect('5a an open finding carries no reviewer, no time and no frozen values',
    'open|true|true|true',
    (SELECT status || '|' || (reviewed_by IS NULL)::text || '|' || (reviewed_at IS NULL)::text
            || '|' || (decided_values IS NULL)::text
       FROM public.conflict_reviews WHERE id = v_id));

  -- 5b a client naming someone else as the reviewer is overwritten, not
  --    trusted: a record whose author the client names is not a record.
  PERFORM _cr_as(c_admin);
  UPDATE public.conflict_reviews
     SET status = 'acknowledged', reviewed_by = c_other, reviewed_at = '2001-01-01T00:00:00Z'
   WHERE id = v_id;
  PERFORM _cr_reset();
  PERFORM _cr_expect('5b the reviewer and the time are the database''s, not the caller''s',
    'acknowledged|' || c_admin::text || '|true',
    (SELECT status || '|' || reviewed_by::text || '|' || (reviewed_at > '2020-01-01Z')::text
       FROM public.conflict_reviews WHERE id = v_id));

  -- 5c the decision froze the measurement it was taken on, and a re-detection
  --    moves the measurement without moving the decision.
  PERFORM _cr_expect('5c the decision froze what it was decided on', '7|7',
    (SELECT (decided_values ->> 'shortByMinutes') || '|' || (measured_values ->> 'shortByMinutes')
       FROM public.conflict_reviews WHERE id = v_id));

  PERFORM _cr_as(c_admin);
  UPDATE public.conflict_reviews SET measured_values = '{"shortByMinutes": 19}'::jsonb
   WHERE id = v_id;
  PERFORM _cr_reset();
  PERFORM _cr_expect('5d …and a re-detection moves the measurement and not the decision',
    '7|19|acknowledged|' || c_admin::text,
    (SELECT (decided_values ->> 'shortByMinutes') || '|' || (measured_values ->> 'shortByMinutes')
            || '|' || status || '|' || reviewed_by::text
       FROM public.conflict_reviews WHERE id = v_id));

  -- 5e changing one's mind re-stamps and re-freezes on the current figures.
  PERFORM _cr_as(c_admin);
  UPDATE public.conflict_reviews
     SET status = 'dismissed', review_note = 'Mit dem Fahrer geklaert.' WHERE id = v_id;
  PERFORM _cr_reset();
  PERFORM _cr_expect('5e a changed decision is re-stamped on the current figures',
    'dismissed|19', (SELECT status || '|' || (decided_values ->> 'shortByMinutes')
       FROM public.conflict_reviews WHERE id = v_id));

  -- 5f a decision does not go back to open. This is also what makes a careless
  --    re-detection upsert fail loudly instead of erasing a month's decisions.
  PERFORM _cr_expect('5f a decision does not return to open',
    'ERR P0001 decision_is_a_record',
    _cr_try(c_admin, NULL, format(
      'UPDATE conflict_reviews SET status = ''open'', review_note = NULL WHERE id = %L', v_id)));

  -- 5g the identity cannot be re-pointed: a dismissal of a trivial finding
  --    must not become a dismissal of a serious one. Five columns, one probe
  --    each, because a guard that pins four of them reads as pinning all five.
  PERFORM _cr_expect('5g the finding key is immutable',
    'ERR P0001 finding_identity_immutable',
    _cr_try(c_admin, NULL, format(
      'UPDATE conflict_reviews SET finding_key = ''travel_gap:other'' WHERE id = %L', v_id)));
  PERFORM _cr_expect('5h the finding type is immutable',
    'ERR P0001 finding_identity_immutable',
    _cr_try(c_admin, NULL, format(
      'UPDATE conflict_reviews SET finding_type = ''driver_overlap'', '
      || 'finding_key = ''driver_overlap:g1+g2'' WHERE id = %L', v_id)));
  PERFORM _cr_expect('5i the detector is immutable',
    'ERR P0001 finding_identity_immutable',
    _cr_try(c_admin, NULL, format(
      'UPDATE conflict_reviews SET detector = ''return_check'' WHERE id = %L', v_id)));
  PERFORM _cr_expect('5j the period is immutable',
    'ERR P0001 finding_identity_immutable',
    _cr_try(c_admin, NULL, format(
      'UPDATE conflict_reviews SET period_month = 5 WHERE id = %L', v_id)));
  PERFORM _cr_expect('5k …and so is the year',
    'ERR P0001 finding_identity_immutable',
    _cr_try(c_admin, NULL, format(
      'UPDATE conflict_reviews SET period_year = 2030 WHERE id = %L', v_id)));

  -- 5l the first sighting is pinned rather than refused, because an upsert
  --    carries it in its payload and refusing would break the normal path.
  PERFORM _cr_as(c_admin);
  UPDATE public.conflict_reviews
     SET first_detected_at = '2001-01-01T00:00:00Z', first_detected_version = 'forged'
   WHERE id = v_id;
  PERFORM _cr_reset();
  PERFORM _cr_expect('5l the first sighting is pinned, not accepted', 'true|cr/1.0.0',
    (SELECT (first_detected_at > '2020-01-01Z')::text || '|' || first_detected_version
       FROM public.conflict_reviews WHERE id = v_id));

  -- 5m a decided finding cannot be left without a time by going round the
  --    guard: the constraint is what the next writer meets.
  PERFORM _cr_expect('5m with the guard off, a decided row with no time is still refused',
    'ERR 23514 constraint conflict_reviews_decided_has_time',
    _cr_mutant(
      'ALTER TABLE public.conflict_reviews DISABLE TRIGGER conflict_review_guard',
      _cr_owner(), NULL, format(
      'UPDATE conflict_reviews SET status = ''acknowledged'', reviewed_at = NULL, '
      || 'decided_values = ''{}''::jsonb WHERE id = %L', v_id)));
END $$;

-- ─── 6. tenancy ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_co_a   CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_co_b   CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000b';
  c_admin  CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_admin_b CONSTANT uuid := 'b0000000-0000-4000-8000-000000000001';
  v_a      uuid;
BEGIN
  v_a := _cr_put(c_co_a, 'vehicle_overlap', 'v1+v2');
  PERFORM _cr_put(c_co_b, 'vehicle_overlap', 'w1+w2');

  PERFORM _cr_expect('6a company A''s administrator reads its own findings', 'true',
    _cr_try(c_admin, NULL, format(
      'SELECT (count(*) > 0)::text FROM conflict_reviews WHERE company_id = %L', c_co_a)));
  PERFORM _cr_expect('6b …and none of company B''s', '0',
    _cr_try(c_admin, NULL, format(
      'SELECT count(*)::text FROM conflict_reviews WHERE company_id = %L', c_co_b)));
  PERFORM _cr_expect('6c company B''s administrator reads none of A''s', '0',
    _cr_try(c_admin_b, NULL, format(
      'SELECT count(*)::text FROM conflict_reviews WHERE company_id = %L', c_co_a)));

  PERFORM _cr_expect('6d …files none in A''s name',
    'ERR 42501 new row violates row-level security policy for table "conflict_reviews"',
    _cr_try(c_admin_b, NULL, format(
      'INSERT INTO conflict_reviews (company_id, detector, finding_type, finding_key, period_year, '
      || 'period_month, detector_status, severity, confidence, explanation, first_detected_version, '
      || 'last_detected_version) VALUES (%L, ''trip_analysis'', ''driver_overlap'', '
      || '''driver_overlap:cross1+cross2'', 2031, 4, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', '
      || '''v'', ''v'')', c_co_a)));

  PERFORM _cr_expect('6e …and reviews none of A''s, silently, because the row is not in scope',
    'rows 0',
    _cr_try(c_admin_b, NULL, format(
      'UPDATE conflict_reviews SET status = ''dismissed'', review_note = ''x'' WHERE id = %L', v_a)));

  -- 6f the move: refused by the policy's WITH CHECK, which is why company_id is
  --    deliberately NOT pinned by the guard -- a pin would refuse the owner too
  --    and tests/rls/matrix.sql's M probe would stop measuring the clause.
  PERFORM _cr_expect('6f A''s administrator cannot move a finding into company B',
    'ERR 42501 new row violates row-level security policy for table "conflict_reviews"',
    _cr_try(c_admin, NULL, format(
      'UPDATE conflict_reviews SET company_id = %L WHERE id = %L', c_co_b, v_a)));

  PERFORM _cr_expect('6g …and the owner can, so 6f is the policy''s refusal and not a trigger''s',
    'rows 1',
    _cr_try(_cr_owner(), NULL, format(
      'UPDATE conflict_reviews SET company_id = %L WHERE id = %L', c_co_b, v_a)));
END $$;

-- ─── 7. the gate: writes ask the Dokumente page, reads ask no role ──────────

DO $$
DECLARE
  c_co_a   CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_admin  CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_editor CONSTANT uuid := 'a0000000-0000-4000-8000-000000000002';
  c_viewer CONSTANT uuid := 'a0000000-0000-4000-8000-000000000003';
  c_rls    CONSTANT text :=
    'ERR 42501 new row violates row-level security policy for table "conflict_reviews"';
  c_ins    CONSTANT text :=
    'INSERT INTO conflict_reviews (company_id, detector, finding_type, finding_key, period_year, '
    || 'period_month, detector_status, severity, confidence, explanation, first_detected_version, '
    || 'last_detected_version) VALUES (%L, ''trip_analysis'', ''shift_overlap'', '
    || '''shift_overlap:%s'', 2031, 4, ''conflict'', ''warning'', ''high'', ''Zu pruefen.'', ''v'', ''v'')';
  v_id     uuid;
BEGIN
  v_id := _cr_put(c_co_a, 'shift_invalid', 's1');

  -- The seeded roles: admin and supervisor hold can_edit everywhere; the editor
  -- holds can_view and NOT can_edit on documents; the viewer writes nowhere.
  PERFORM _cr_ok('7a the seed really gives the editor no can_edit on documents',
    (SELECT NOT rp.can_edit AND rp.can_view FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
      WHERE r.name = 'editor' AND r.company_id IS NULL AND rp.page_key = 'documents'));

  PERFORM _cr_expect('7b a viewer reads the findings', 'true',
    _cr_try(c_viewer, NULL, format(
      'SELECT (count(*) > 0)::text FROM conflict_reviews WHERE company_id = %L', c_co_a)));
  PERFORM _cr_expect('7c an editor reads them too', 'true',
    _cr_try(c_editor, NULL, format(
      'SELECT (count(*) > 0)::text FROM conflict_reviews WHERE company_id = %L', c_co_a)));

  PERFORM _cr_expect('7d a viewer files none', c_rls,
    _cr_try(c_viewer, NULL, format(c_ins, c_co_a, 'viewer')));
  PERFORM _cr_expect('7e an editor files none either: it holds no can_edit on documents', c_rls,
    _cr_try(c_editor, NULL, format(c_ins, c_co_a, 'editor')));
  PERFORM _cr_expect('7f an administrator files one', 'rows 1',
    _cr_try(c_admin, NULL, format(c_ins, c_co_a, 'admin')));

  -- A review the gate hides changes nothing and answers success, which is why
  -- the client reads the touched rows and not `error`.
  PERFORM _cr_expect('7g a viewer''s review touches no row, silently', 'rows 0',
    _cr_try(c_viewer, NULL, format(
      'UPDATE conflict_reviews SET status = ''dismissed'', review_note = ''x'' WHERE id = %L', v_id)));
  PERFORM _cr_expect('7h an editor''s review touches no row either', 'rows 0',
    _cr_try(c_editor, NULL, format(
      'UPDATE conflict_reviews SET status = ''dismissed'', review_note = ''x'' WHERE id = %L', v_id)));
  PERFORM _cr_expect('7i an administrator''s review touches the row', 'rows 1',
    _cr_try(c_admin, NULL, format(
      'UPDATE conflict_reviews SET status = ''dismissed'', review_note = ''Geklaert.'' WHERE id = %L', v_id)));

  -- Nobody deletes, and the refusal is a missing privilege rather than a
  -- statement that removes nothing: that is rule 3.
  PERFORM _cr_expect('7j an administrator cannot delete a reviewed finding',
    'ERR 42501 privilege table conflict_reviews',
    _cr_try(c_admin, NULL, format('DELETE FROM conflict_reviews WHERE id = %L', v_id)));
  PERFORM _cr_expect('7k …and neither can a viewer',
    'ERR 42501 privilege table conflict_reviews',
    _cr_try(c_viewer, NULL, format('DELETE FROM conflict_reviews WHERE id = %L', v_id)));

  -- anon holds nothing at all.
  PERFORM _cr_expect('7l anon reads nothing',
    'ERR 42501 privilege table conflict_reviews',
    _cr_try(NULL, NULL, 'SELECT count(*)::text FROM conflict_reviews'));
END $$;

-- ─── 8. platform contexts ───────────────────────────────────────────────────

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT _cr_id('user:' || v.who), 'cr-' || v.who || '@test.invalid', now()
FROM (VALUES ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
SELECT _cr_id('user:' || v.who), 'cr-' || v.who || '@test.invalid', 'CR ' || v.who, 'viewer',
       (SELECT r.id FROM roles r WHERE r.name = 'viewer' AND r.company_id IS NULL),
       NULL, 'active'
FROM (VALUES ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES (_cr_id('user:owner-view'), 'owner', 'cr'), (_cr_id('user:owner-support'), 'owner', 'cr')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
SELECT _cr_id('session:' || v.who), _cr_id('user:' || v.who)
FROM (VALUES ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  c_view    CONSTANT uuid := _cr_id('user:owner-view');
  c_support CONSTANT uuid := _cr_id('user:owner-support');
  c_s_view  CONSTANT uuid := _cr_id('session:owner-view');
  c_s_supp  CONSTANT uuid := _cr_id('session:owner-support');
  c_co_a    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_co_b    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000b';
  v_open    jsonb;
  v_mark    bigint;
  v_after   jsonb;
  v_id      uuid;
BEGIN
  v_id := _cr_put(c_co_a, 'status_unknown', 'u1');

  -- The read seam platform_reads_company_data() has been `SELECT false` since
  -- 20260917140000, so a platform account with no context open reads nothing.
  PERFORM _cr_expect('8a a platform owner with no context open reads no finding', '0',
    _cr_try(c_support, c_s_supp, format(
      'SELECT count(*)::text FROM conflict_reviews WHERE company_id = %L', c_co_a)));

  PERFORM _cr_as(c_view, c_s_view);
  v_open := public.platform_context_open(c_co_a, 'view');
  PERFORM _cr_reset();
  PERFORM _cr_expect('8b the view context opened', 'true', v_open ->> 'success');

  PERFORM _cr_expect('8c a view context reads the company it opened', 'true',
    _cr_try(c_view, c_s_view, format(
      'SELECT (count(*) > 0)::text FROM conflict_reviews WHERE company_id = %L', c_co_a)));
  PERFORM _cr_expect('8d …and no other company''s', '0',
    _cr_try(c_view, c_s_view, format(
      'SELECT count(*)::text FROM conflict_reviews WHERE company_id = %L', c_co_b)));
  PERFORM _cr_expect('8e a view context files nothing, and says why (3.4a)',
    'ERR P0001 support_session_required',
    _cr_try(c_view, c_s_view, format(
      'INSERT INTO conflict_reviews (company_id, detector, finding_type, finding_key, period_year, '
      || 'period_month, detector_status, severity, confidence, explanation, first_detected_version, '
      || 'last_detected_version) VALUES (%L, ''trip_analysis'', ''missing_driver'', '
      || '''missing_driver:view'', 2031, 4, ''conflict'', ''warning'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_co_a)));
  PERFORM _cr_expect('8f …and reviews nothing, not even in a statement that would touch no row',
    'ERR P0001 support_session_required',
    _cr_try(c_view, c_s_view, format(
      'UPDATE conflict_reviews SET severity = severity WHERE id = %L', v_id)));

  -- The support session writes the company it opened, as its administrator
  -- would, and every row leaves exactly one audit row (3.4c).
  PERFORM _cr_as(c_support, c_s_supp);
  v_open := public.platform_context_open(c_co_a, 'support', 'Ticket Fahrtenanalyse');
  PERFORM _cr_reset();
  PERFORM _cr_expect('8g the support session opened', 'true', v_open ->> 'success');

  v_mark := _cr_mark();
  PERFORM _cr_as(c_support, c_s_supp);
  INSERT INTO public.conflict_reviews
         (company_id, detector, finding_type, finding_key, period_year, period_month,
          detector_status, severity, confidence, explanation, first_detected_version,
          last_detected_version)
  VALUES (c_co_a, 'return_check', 'same_street', 'same_street:r42', 2031, 4,
          'conflict', 'warning', 'high', 'Gleiche Strasse, andere Hausnummer', 'v', 'v');
  PERFORM _cr_reset();

  PERFORM _cr_expect('8h a support session''s insert leaves exactly one audit row', '1',
    _cr_rows(v_mark, 'support_write.conflict_reviews.insert')::text);

  SELECT l.after_value INTO v_after
    FROM app_private.platform_audit_log l
   WHERE l.id > v_mark AND l.action = 'support_write.conflict_reviews.insert'
   ORDER BY l.id LIMIT 1;
  PERFORM _cr_expect('8i …naming the session''s reason and the finding it filed',
    'Ticket Fahrtenanalyse|same_street:r42|open',
    (v_after ->> 'reason') || '|' || (v_after -> 'values' ->> 'finding_key')
    || '|' || (v_after -> 'values' ->> 'status'));

  -- A review inside a support session is recorded too, which is what makes a
  -- platform agent's decision traceable rather than anonymous.
  v_mark := _cr_mark();
  PERFORM _cr_as(c_support, c_s_supp);
  UPDATE public.conflict_reviews
     SET status = 'dismissed', review_note = 'Vom Support geprueft.'
   WHERE company_id = c_co_a AND finding_key = 'same_street:r42';
  PERFORM _cr_reset();
  PERFORM _cr_expect('8j …and a review of its own leaves one too', '1',
    _cr_rows(v_mark, 'support_write.conflict_reviews.update')::text);

  PERFORM _cr_expect('8k the reviewer recorded is the platform account',
    'dismissed|' || c_support::text,
    (SELECT status || '|' || reviewed_by::text FROM public.conflict_reviews
      WHERE company_id = c_co_a AND finding_key = 'same_street:r42'));

  PERFORM _cr_expect('8l a support session files nothing in another company''s name',
    'ERR 42501 new row violates row-level security policy for table "conflict_reviews"',
    _cr_try(c_support, c_s_supp, format(
      'INSERT INTO conflict_reviews (company_id, detector, finding_type, finding_key, period_year, '
      || 'period_month, detector_status, severity, confidence, explanation, first_detected_version, '
      || 'last_detected_version) VALUES (%L, ''trip_analysis'', ''missing_driver'', '
      || '''missing_driver:cross'', 2031, 4, ''conflict'', ''warning'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_co_b)));

  PERFORM _cr_as(c_support, c_s_supp);
  PERFORM public.platform_context_close();
  PERFORM _cr_as(c_view, c_s_view);
  PERFORM public.platform_context_close();
  PERFORM _cr_reset();
END $$;

-- ─── 9. a finding is a list to review, never a verdict ──────────────────────
-- ReturnCheckPanel.render.test.ts fails the build on the word "Verstoß". This
-- is the same rule applied to the record: the schema must not promote a finding
-- to an accusation, and the three places it could are the detector's status,
-- the reviewer's vocabulary, and the German the storage layer invents.

DO $$
DECLARE
  v_words text[] := ARRAY['verstoss', 'verstoß', 'violation', 'illegal', 'unlawful',
                          'schuld', 'strafe', 'betrug', 'fraud'];
  v_hit   text;
BEGIN
  -- 9a 'passed' is absent from detector_status: a clean check is not a finding
  --    and this table is not a log of everything.
  PERFORM _cr_ok('9a detector_status names conflict and unverifiable',
    (SELECT pg_get_constraintdef(c.oid) LIKE '%conflict%'
        AND pg_get_constraintdef(c.oid) LIKE '%unverifiable%'
       FROM pg_constraint c
      WHERE c.conrelid = to_regclass('public.conflict_reviews')
        AND c.conname = 'conflict_reviews_detector_status'));
  PERFORM _cr_ok('9b …and it does not admit ''passed''',
    (SELECT pg_get_constraintdef(c.oid) NOT LIKE '%passed%'
       FROM pg_constraint c
      WHERE c.conrelid = to_regclass('public.conflict_reviews')
        AND c.conname = 'conflict_reviews_detector_status'));

  -- 9c the reviewer's words are the reviewer's: acknowledged and dismissed, and
  --    never 'confirmed' or 'rejected'. A detector's finding is not a fact a
  --    review can confirm.
  PERFORM _cr_ok('9c the status words are open, acknowledged and dismissed',
    (SELECT pg_get_constraintdef(c.oid) LIKE '%open%'
        AND pg_get_constraintdef(c.oid) LIKE '%acknowledged%'
        AND pg_get_constraintdef(c.oid) LIKE '%dismissed%'
        AND pg_get_constraintdef(c.oid) NOT LIKE '%confirmed%'
        AND pg_get_constraintdef(c.oid) NOT LIKE '%rejected%'
       FROM pg_constraint c
      WHERE c.conrelid = to_regclass('public.conflict_reviews')
        AND c.conname = 'conflict_reviews_status'));

  -- 9d no column name, no constraint name and no word of the guard calls
  --    anything a violation.
  SELECT string_agg(found, ', ') INTO v_hit FROM (
    SELECT a.attname::text AS found FROM pg_attribute a
     WHERE a.attrelid = to_regclass('public.conflict_reviews') AND a.attnum > 0
       AND lower(a.attname) ~ ('(' || array_to_string(v_words, '|') || ')')
    UNION ALL
    SELECT c.conname::text FROM pg_constraint c
     WHERE c.conrelid = to_regclass('public.conflict_reviews')
       AND lower(c.conname) ~ ('(' || array_to_string(v_words, '|') || ')')
    UNION ALL
    SELECT 'app_private.conflict_review_guard' FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app_private' AND p.proname = 'conflict_review_guard'
       AND lower(p.prosrc) ~ ('(' || array_to_string(v_words, '|') || ')')
  ) AS t(found);
  PERFORM _cr_expect('9d nothing in the table or its guard names a verdict', '<null>',
    coalesce(v_hit, '<null>'));

  -- 9e the explanation is carried with a key, so a screen renders the engine's
  --    own words through engineText and the record invents none.
  PERFORM _cr_ok('9e the record carries both the engine''s sentence and its dictionary key',
    (SELECT count(*) = 2 FROM pg_attribute a
      WHERE a.attrelid = to_regclass('public.conflict_reviews')
        AND a.attname IN ('explanation', 'explanation_key')));
END $$;

-- ─── 10. mutation controls ──────────────────────────────────────────────────
-- Every assertion above that could pass for the wrong reason, re-run with the
-- rule broken. A control that does not fail is an assertion that measures
-- nothing, and this file has been wrong about that before anywhere it was not
-- checked. Each mutation runs as the owner inside a subtransaction that is
-- rolled back with it; _cr_mutate_fn refuses a replacement that would change
-- nothing, so a control cannot silently probe the unmutated code.

DO $$
DECLARE
  c_co_a   CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_co_b   CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000b';
  c_admin  CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_viewer CONSTANT uuid := 'a0000000-0000-4000-8000-000000000003';
  c_cols   CONSTANT text :=
    '(company_id, detector, finding_type, finding_key, period_year, period_month, '
    || 'detector_status, severity, confidence, explanation, first_detected_version, last_detected_version';
  v_id     uuid;
BEGIN
  v_id := _cr_put(c_co_a, 'end_before_start', 'm1');

  -- 10a with the dismissal constraint dropped, 2a's row is accepted. This is
  --     the control for rule 2, the one rule carried over from the partner
  --     submissions.
  PERFORM _cr_expect('10a control: with the dismissal constraint dropped, a reasonless dismissal lands',
    'rows 1',
    _cr_mutant(
      'ALTER TABLE public.conflict_reviews DROP CONSTRAINT conflict_reviews_dismissal_has_reason',
      _cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s, status) VALUES (%L, ''trip_analysis'', ''driver_overlap'', '
      || '''driver_overlap:ctl1+ctl2'', 2031, 4, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'', '
      || '''dismissed'')', c_cols, c_co_a)));

  -- 10b with the status constraint dropped, 'passed' lands -- so 2d measures
  --     the constraint and not some other refusal on the way.
  PERFORM _cr_expect('10b control: with the status constraint dropped, a passed check lands', 'rows 1',
    _cr_mutant(
      'ALTER TABLE public.conflict_reviews DROP CONSTRAINT conflict_reviews_detector_status',
      _cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s) VALUES (%L, ''trip_analysis'', ''driver_overlap'', '
      || '''driver_overlap:ctl3+ctl4'', 2031, 4, ''passed'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_cols, c_co_a)));

  -- 10c with the detector/type tie dropped, one detector takes the other's
  --     kind -- so 2f and 2g measure that constraint.
  PERFORM _cr_expect('10c control: with the detector/kind tie dropped, return_check takes a tripAnalysis kind',
    'rows 1',
    _cr_mutant(
      'ALTER TABLE public.conflict_reviews DROP CONSTRAINT conflict_reviews_detector_type',
      _cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s) VALUES (%L, ''return_check'', ''driver_overlap'', '
      || '''driver_overlap:ctl5+ctl6'', 2031, 4, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_cols, c_co_a)));

  -- 10d with the prefix tie dropped, a key names another kind -- which is how a
  --     decision could be made to describe a finding it was not taken on.
  PERFORM _cr_expect('10d control: with the prefix tie dropped, a key naming another kind lands',
    'rows 1',
    _cr_mutant(
      'ALTER TABLE public.conflict_reviews DROP CONSTRAINT conflict_reviews_finding_key_names_type',
      _cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s) VALUES (%L, ''trip_analysis'', ''driver_overlap'', '
      || '''vehicle_overlap:ctl7+ctl8'', 2031, 4, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_cols, c_co_a)));

  -- 10e the empty-array CHECK really needs its coalesce: with it written the
  --     obvious way, array_length of an empty array is NULL, the CHECK passes
  --     on NULL, and an empty array lands. This is the control for the trap,
  --     not merely for the constraint.
  PERFORM _cr_expect('10e control: without the coalesce, an empty trip_ids array lands', 'rows 1',
    _cr_mutant(
      'ALTER TABLE public.conflict_reviews DROP CONSTRAINT conflict_reviews_trip_ids_shape; '
      || 'ALTER TABLE public.conflict_reviews ADD CONSTRAINT conflict_reviews_trip_ids_shape '
      || 'CHECK (trip_ids IS NULL OR (array_length(trip_ids, 1) >= 1 '
      || 'AND array_position(trip_ids, NULL) IS NULL))',
      _cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s, trip_ids) VALUES (%L, ''trip_analysis'', ''missing_end'', '
      || '''missing_end:ctl9'', 2031, 4, ''conflict'', ''warning'', ''high'', ''Zu pruefen.'', ''v'', ''v'', '
      || 'ARRAY[]::uuid[])', c_cols, c_co_a)));

  -- 10f with the idempotency index dropped, the same finding is filed twice --
  --     so 4a measures the index and 4b's upsert has something to land on.
  PERFORM _cr_expect('10f control: with the idempotency index dropped, the same finding is filed twice',
    'rows 1',
    _cr_mutant(
      'DROP INDEX public.conflict_reviews_idempotency',
      _cr_owner(), NULL, format(
      'INSERT INTO conflict_reviews %s) VALUES (%L, ''trip_analysis'', ''end_before_start'', '
      || '''end_before_start:m1'', 2031, 4, ''conflict'', ''error'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_cols, c_co_a)));

  -- 10g with the one-way rule removed from the guard, a decision returns to
  --     open -- which is what a careless re-detection upsert would do to every
  --     decided finding in the month.
  PERFORM _cr_as(c_admin);
  UPDATE public.conflict_reviews SET status = 'acknowledged' WHERE id = v_id;
  PERFORM _cr_reset();
  PERFORM _cr_expect('10g control: with the one-way rule removed, a decision returns to open', 'rows 1',
    _cr_mutant(
      format('SELECT _cr_mutate_fn(%L, %L, %L)',
             'app_private.conflict_review_guard()',
             'IF OLD.status <> ''open'' AND NEW.status = ''open'' THEN',
             'IF false THEN'),
      c_admin, NULL, format('UPDATE conflict_reviews SET status = ''open'' WHERE id = %L', v_id)));

  -- 10h with the identity pin removed, a decided finding is re-pointed at
  --     another one. This is the control for 5g to 5k.
  PERFORM _cr_expect('10h control: with the identity pin removed, a finding is re-pointed', 'rows 1',
    _cr_mutant(
      format('SELECT _cr_mutate_fn(%L, %L, %L)',
             'app_private.conflict_review_guard()',
             'IF v_identity_moved THEN',
             'IF false THEN'),
      c_admin, NULL, format(
      'UPDATE conflict_reviews SET finding_key = ''end_before_start:other'' WHERE id = %L', v_id)));

  -- 10i with the stamp removed from the guard, the caller's own reviewer is
  --     stored -- so 5b measures the derivation and not a default.
  PERFORM _cr_expect('10i control: with the stamp removed, the caller names the reviewer',
    c_viewer::text,
    _cr_mutant(
      format('SELECT _cr_mutate_fn(%L, %L, %L)',
             'app_private.conflict_review_guard()',
             'NEW.reviewed_by    := auth.uid();',
             'NEW.reviewed_by    := coalesce(NEW.reviewed_by, auth.uid());'),
      c_admin, NULL, format(
      'WITH w AS (UPDATE conflict_reviews SET status = ''dismissed'', '
      || 'review_note = ''ctl'', reviewed_by = %L WHERE id = %L RETURNING reviewed_by) '
      || 'SELECT reviewed_by::text FROM w', c_viewer, v_id)));

  -- 10j with the freeze removed, a re-detection moves what the decision was
  --     taken on -- the whole point of decided_values.
  PERFORM _cr_as(c_admin);
  UPDATE public.conflict_reviews
     SET measured_values = '{"gap": 1}'::jsonb WHERE id = v_id;
  UPDATE public.conflict_reviews
     SET status = 'dismissed', review_note = 'ctl' WHERE id = v_id;
  PERFORM _cr_reset();
  PERFORM _cr_expect('10j baseline: a re-detection leaves the frozen figure alone', '1|9',
    _cr_try(c_admin, NULL, format(
      'WITH w AS (UPDATE conflict_reviews SET measured_values = ''{"gap": 9}''::jsonb '
      || 'WHERE id = %L RETURNING decided_values, measured_values) '
      || 'SELECT (decided_values ->> ''gap'') || ''|'' || (measured_values ->> ''gap'') FROM w', v_id)));
  PERFORM _cr_expect('10j control: with the freeze removed, the frozen figure follows the measurement',
    '9|9',
    _cr_mutant(
      format('SELECT _cr_mutate_fn(%L, %L, %L)',
             'app_private.conflict_review_guard()',
             'NEW.decided_values := OLD.decided_values;',
             'NEW.decided_values := NEW.measured_values;'),
      c_admin, NULL, format(
      'WITH w AS (UPDATE conflict_reviews SET measured_values = ''{"gap": 9}''::jsonb '
      || 'WHERE id = %L RETURNING decided_values, measured_values) '
      || 'SELECT (decided_values ->> ''gap'') || ''|'' || (measured_values ->> ''gap'') FROM w', v_id)));

  -- 10k with the page gate taken out of the INSERT policy, a viewer files a
  --     finding -- so 7d and 7e measure the gate and not the tenant term.
  PERFORM _cr_expect('10k control: with the page gate dropped, a viewer files a finding', 'rows 1',
    _cr_mutant(
      'DROP POLICY conflict_reviews_insert ON public.conflict_reviews; '
      || 'CREATE POLICY conflict_reviews_insert ON public.conflict_reviews FOR INSERT '
      || 'TO authenticated WITH CHECK (company_id = (SELECT public.get_active_company_id()) '
      || 'AND status = ''open'')',
      c_viewer, NULL, format(
      'INSERT INTO conflict_reviews %s) VALUES (%L, ''trip_analysis'', ''shift_overlap'', '
      || '''shift_overlap:ctl10'', 2031, 4, ''conflict'', ''warning'', ''high'', ''Zu pruefen.'', ''v'', ''v'')',
      c_cols, c_co_a)));

  -- 10l with the open-only clause taken out, an administrator files a finding
  --     already dismissed -- so section 3 measures that clause, which is the
  --     one the migration could not read out of the catalogue.
  PERFORM _cr_expect('10l control: without the open-only clause, a decided finding can be filed',
    'rows 1',
    _cr_mutant(
      'DROP POLICY conflict_reviews_insert ON public.conflict_reviews; '
      || 'CREATE POLICY conflict_reviews_insert ON public.conflict_reviews FOR INSERT '
      || 'TO authenticated WITH CHECK (company_id = (SELECT public.get_active_company_id()) '
      || 'AND (SELECT public.current_role_permits(''documents'', true)))',
      c_admin, NULL, format(
      'INSERT INTO conflict_reviews %s, status, review_note) VALUES (%L, ''trip_analysis'', '
      || '''shift_overlap'', ''shift_overlap:ctl11'', 2031, 4, ''conflict'', ''warning'', ''high'', '
      || '''Zu pruefen.'', ''v'', ''v'', ''dismissed'', ''Schon geprueft'')', c_cols, c_co_a)));

  -- 10m with the tenant term taken out of the UPDATE policy's WITH CHECK, the
  --     move of 6f is allowed -- which is why the predicate is written twice.
  PERFORM _cr_expect('10m control: with the second copy of the predicate dropped, the move lands',
    'rows 1',
    _cr_mutant(
      'DROP POLICY conflict_reviews_update ON public.conflict_reviews; '
      || 'CREATE POLICY conflict_reviews_update ON public.conflict_reviews FOR UPDATE '
      || 'TO authenticated USING (company_id = (SELECT public.get_active_company_id()) '
      || 'AND (SELECT public.current_role_permits(''documents'', true))) WITH CHECK (true)',
      c_admin, NULL, format(
      'UPDATE conflict_reviews SET company_id = %L WHERE id = %L', c_co_b, v_id)));
END $$;

-- ─── 11. the verdict ────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad  int;
  v_all  int;
  v_list text;
BEGIN
  SELECT count(*) FILTER (WHERE NOT ok), count(*) INTO v_bad, v_all FROM _cr_results;

  IF v_bad > 0 THEN
    SELECT string_agg(format('%s: expected [%s] got [%s]', label, expected, actual), E'\n  ' ORDER BY n)
      INTO v_list FROM _cr_results WHERE NOT ok;
    RAISE EXCEPTION E'conflict-review-record: % of % checks failed:\n  %', v_bad, v_all, v_list;
  END IF;

  RAISE NOTICE 'conflict-review-record: all % checks passed', v_all;
END $$;

ROLLBACK;
